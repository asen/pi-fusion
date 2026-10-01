import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DIAGNOSTIC_EVENT as PROTOCOL_DIAGNOSTIC_EVENT, STARTUP_EXIT_CODE as PROTOCOL_STARTUP_EXIT_CODE } from "../extensions/backends/pi-bootstrap-protocol.mjs";
import {
	type BootstrapSdk,
	checkInput,
	checkSdk,
	createRuntime,
	DIAGNOSTIC_EVENT,
	diagnostic,
	inDirectory,
	openSessionManager,
	preflightSession,
	MODELS_REFUSED,
	resourceOptions,
	SDK_PACKAGE,
	STARTUP_EXIT_CODE,
	THINKING_LEVELS,
	withinDirectory,
} from "../extensions/backends/pi-bootstrap.mjs";
import {
	CONTROL_CANCELLED,
	CONTROL_COMMANDS,
	CONTROL_EXTENSION_NAME,
	CONTROL_EXTENSION_PATH,
	CONTROL_INVALID_ARGUMENT,
	CONTROL_UNANSWERED,
	type ControlCommand,
	type ControlCommandContext,
	controlExtension,
	FORK_COMMAND,
	NAVIGATE_COMMAND,
} from "../extensions/backends/pi-control-extension.mjs";
import { HELPER_RETRY_NOTICE, HELPER_UNAVAILABLE } from "../extensions/backends/pi-helper-retry.mjs";
import { QUESTION_TOOL_DESCRIPTION, QUESTION_TOOL_NAME, QUESTION_UNANSWERED, questionTool } from "../extensions/backends/pi-question-tool.mjs";
import {
	bootstrapInput,
	type BootstrapInput,
	BOOTSTRAP_INPUT_VERSION,
	childEnvironment,
	hostBinPlacement,
	JITI_CACHE_VARIABLE,
	NODE_COMPILE_CACHE_VARIABLE,
	openSession,
	PATH_VARIABLE,
	PI_AGENT_DIR_VARIABLE,
	PI_BOOTSTRAP_PATH,
	PI_CHILD_MARKER,
	PI_CHILD_VARIABLE,
	piLaunch,
} from "../extensions/backends/pi-launch.ts";
import { PI_ROLE_NAMES, type PiRole, piRole } from "../extensions/backends/pi-binding.ts";
import { type CallStorage, JITI_CACHE_DIR, NODE_CACHE_DIR, prepareCallStorage, writeCallInput } from "../extensions/backends/pi-storage.ts";
import { PI_EFFORTS } from "../extensions/backends/types.ts";

/*
 * What the bootstrap composes and what it refuses, driven against a recording double of the public Pi SDK. No case
 * here starts a real Pi child, opens a real session or loads the installed package: the session cases read literal
 * JSONL fixtures, and the process cases run the bootstrap as a plain node program that fails before it would import
 * anything. Nothing here is evidence about Pi's own behavior, which only a real child can give.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapUrl = pathToFileURL(PI_BOOTSTRAP_PATH).href;

const STORAGE: CallStorage = {
	root: "/host/pi-fusion",
	agentDir: "/host/pi-fusion/children",
	catalogDir: "/host/pi-fusion/children/catalog",
	modelsStorePath: "/host/pi-fusion/children/catalog/models-store.json",
	sessionDir: "/host/pi-fusion/children/sessions/project-0123456789abcdef",
	callsDir: "/host/pi-fusion/calls",
	userModelsPath: "/host/models.json",
	userAuthPath: "/host/auth.json",
	hostBinDir: "/host/bin",
	handle: "run-1",
	cwd: "/work",
	callDir: "/host/pi-fusion/calls/run-1-abcd",
	inputPath: "/host/pi-fusion/calls/run-1-abcd/bootstrap.json",
	cacheDir: "/host/pi-fusion/calls/run-1-abcd/cache",
	modelsPath: "/host/models.json",
	privateModelsPath: "/host/pi-fusion/calls/run-1-abcd/models.json",
	authPath: "/host/auth.json",
	sharedAuth: true,
};

/** The role the production binding resolves, so what the composer reads is what a call would really hand it. */
const role: PiRole = piRole({ role: "implement", model: "deepseek/deepseek-chat", effort: "high" }, undefined, {});

const input = (over: Partial<BootstrapInput> = {}): BootstrapInput =>
	checkInput({ ...bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "# implement\nDo the task." }), ...over });

interface Recorded {
	settings: Array<{ settings: unknown; options: unknown }>;
	modelRuntime: unknown[];
	sessionCreate: Array<{ cwd: string; sessionDir?: string }>;
	sessionOpen: Array<{ file: string; sessionDir?: string; cwdOverride?: string }>;
	/** What the session constructor appended to the branch it opened, in the order it happened. */
	appended: string[];
	services: Array<Record<string, any>>;
	session: Array<Record<string, any>>;
	runtime: Array<Record<string, any>>;
	getModel: string[];
	/** What each search-tool factory was asked for: which tool, the one argument it got, and how many it got. */
	helperFactories: Array<{ tool: string; cwd: unknown; args: number }>;
	/** The definition each factory answered with, by tool, so a test can tell a wrapper from the thing it wrapped. */
	helperAnswers: Record<string, Record<string, any>>;
	/** Every attempt a composed search tool's own execute made, in order, with the arguments and receiver it got. */
	helperAttempts: Array<{ tool: string; id: unknown; params: unknown; signal: unknown; onUpdate: unknown; context: unknown; receiver: unknown }>;
	/** What each factory this composition handed the loader registered, in order, as the loader would report it. */
	registrations: Array<{ name: string; description: unknown; handler: unknown; sourceInfo: { path: string } }>;
}

/** What a double should get wrong: how its model runtime fails, what its loader reports, or a parser that throws. */
interface Fault {
	/** A text the model runtime reports, `"missing"` for a runtime with no `getError` at all, absent for a clean one. */
	getError?: string;
	/** An error `getError()` throws instead of answering. */
	getErrorThrows?: Error;
	/** Something other than a string or undefined for `getError()` to answer with. */
	getErrorReturns?: unknown;
	/** An error `ModelRuntime.create` rejects with. */
	createRejects?: Error;
	parse?: boolean;
	/** An error one of the three construction calls throws: the SDK's own, never a refusal this bootstrap composed. */
	servicesThrows?: Error;
	sessionThrows?: Error;
	runtimeThrows?: Error;
	/** What `getError()` answers once the services have registered an extension's providers and refreshed the catalog. */
	getErrorAfterServices?: string;
	/**
	 * What the resource loader reports about what it loaded, which of its methods the services hand over at all, and the
	 * list it hands the `agentsFilesOverride` this bootstrap composed while it reloads. `extensions` and `skills` are the
	 * failures it reports; `loaded` replaces what it says it actually loaded, which otherwise mirrors the paths the call
	 * named, the way a loader that loaded exactly what it was given would.
	 */
	loader?: {
		extensions?: unknown;
		skills?: unknown;
		agentsFiles?: unknown;
		/** One accessor that throws instead of answering, named the way the loader names it. */
		throws?: { getter: "getExtensions" | "getSkills" | "getPrompts" | "getThemes"; error: Error };
		/**
		 * What the loader reports for the factories it was handed, which is otherwise one record per factory, spelled
		 * and resolved the way 0.85.1 spells a named one. A list replaces those records outright, which is how a case
		 * reports none, two of them, or one whose two paths disagree.
		 */
		control?: unknown[];
		loaded?: { extensions?: unknown; skills?: unknown; prompts?: unknown; themes?: unknown };
		without?: "resourceLoader" | "getExtensions" | "getSkills" | "getPrompts" | "getThemes";
	};
	/**
	 * The working directory this double's runtime constructor hands the session factory, for a case that wants it told
	 * apart from the one the call was composed with. Absent, it is the call's own, which is what the installed
	 * constructor does and what every other case here reads.
	 */
	sessionCwd?: string;
	/** An error `SettingsManager.inMemory`, `SessionManager.create` or `SessionManager.open` throws. */
	settingsThrows?: Error;
	sessionCreateThrows?: Error;
	sessionOpenThrows?: Error;
	/** Whether the session constructor appends an entry to the branch it opened, the way 0.85.1's own does. */
	appendsOnConstruct?: string;
	/** What the services report about themselves. */
	serviceDiagnostics?: unknown;
	/**
	 * The tool registry the session is built against, and how it answers for its active names. `registry` is what an
	 * extension registered in its factory body, `late` what one registers afterwards, in a hook that runs inside
	 * `runRpcMode`; `active` replaces the answer outright and `without` takes the method away.
	 */
	tools?: { registry?: string[]; late?: string[]; active?: unknown; without?: boolean; throws?: Error };
	/**
	 * What the session's own extension runner answers for the commands that are registered. Absent, it answers with
	 * what the factories this composition handed the loader actually registered, each under its bare name, which is
	 * what this Pi resolves when no two extensions registered the same name. `list` replaces that answer outright,
	 * `without` takes the runner or its accessor away, and `throws` is an accessor that fails instead of answering.
	 */
	commands?: { list?: unknown; without?: "runner" | "accessor"; throws?: Error };
	/**
	 * What one of the two search-tool factories does instead of answering with a definition this bootstrap can read, and
	 * how a composed definition's own execute behaves. `tool` is the one that misbehaves and the other answers normally;
	 * `failure` decides how a definition fails its first attempt, which is what makes the composed retry exercisable —
	 * `own` fails with the helper-unavailable message that tool reports, `swapped` with the other tool's, which is not
	 * this tool's helper failure at all.
	 */
	helpers?: {
		tool?: "grep" | "find";
		/** An error the factory itself throws. */
		throws?: Error;
		/** A value the factory answers with instead of a definition of the shape this bootstrap reads. */
		definition?: unknown;
		/** One of the definition's own fields, as a getter that throws when this bootstrap reads it. */
		getter?: { property: "name" | "execute"; throws: Error };
		failure?: "own" | "swapped";
	};
}

/** The tools Pi 0.85.1 builds into a session's registry, so a role's list is met from the registry and not invented. */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];

/** The schema object a fake search-tool factory hands over by reference, so a test can prove the wrapper kept it. */
const HELPER_SCHEMA = { type: "object", properties: { pattern: { type: "string" } } };

/** The label a fake search-tool definition carries, which is metadata the wrapper has to bring through unchanged. */
const HELPER_LABEL: Record<string, string> = { grep: "Search file contents", find: "Find files" };

/** A double of the public SDK that records what it was handed and builds nothing. `models` decides which model exists. */
function fakeSdk(models: string[] = ["deepseek/deepseek-chat"], fault: Fault = {}): { sdk: BootstrapSdk; calls: Recorded } {
	const calls: Recorded = {
		settings: [],
		modelRuntime: [],
		sessionCreate: [],
		sessionOpen: [],
		appended: [],
		services: [],
		session: [],
		runtime: [],
		getModel: [],
		helperFactories: [],
		helperAnswers: {},
		helperAttempts: [],
		registrations: [],
	};
	const available = new Set(models);
	// The catalog work `createAgentSessionServices` does is what makes a provider error appear after it, and not before.
	let servicesBuilt = false;
	// How many attempts each composed search tool has made, so a scripted first failure is that tool's first attempt.
	const attempts: Record<string, number> = { grep: 0, find: 0 };
	/**
	 * A builtin search-tool definition as far as this bootstrap reads one: a name, an `execute`, and the ordinary
	 * metadata beside them that a wrapper has to carry through. `execute` is a function expression rather than an arrow
	 * so the receiver it was called on is recorded, which is what says the wrapper kept calling the original definition.
	 */
	const helperDefinition = (tool: "grep" | "find"): Record<string, any> => ({
		name: tool,
		label: HELPER_LABEL[tool],
		description: `the installed ${tool}`,
		parameters: HELPER_SCHEMA,
		execute: async function (this: unknown, id: unknown, params: unknown, signal: unknown, onUpdate: unknown, context: unknown) {
			calls.helperAttempts.push({ tool, id, params, signal, onUpdate, context, receiver: this });
			attempts[tool] += 1;
			if (attempts[tool] === 1 && fault.helpers?.failure) {
				const other = tool === "grep" ? "find" : "grep";
				throw new Error(HELPER_UNAVAILABLE[fault.helpers.failure === "swapped" ? other : tool]);
			}
			return { content: [{ type: "text", text: `${tool} ran on attempt ${attempts[tool]}` }], details: undefined };
		},
	});
	/** One of the two public factories, recording what it was asked for and what it answered with. */
	const helperFactory =
		(tool: "grep" | "find") =>
		(...args: unknown[]) => {
			calls.helperFactories.push({ tool, cwd: args[0], args: args.length });
			const helpers = fault.helpers;
			if (helpers && (helpers.tool ?? tool) === tool) {
				if (helpers.throws) throw helpers.throws;
				if ("definition" in helpers) return helpers.definition;
				if (helpers.getter) {
					const { property, throws } = helpers.getter;
					const definition = helperDefinition(tool);
					Object.defineProperty(definition, property, {
						get: () => {
							throw throws;
						},
					});
					calls.helperAnswers[tool] = definition;
					return definition;
				}
			}
			const answer = helperDefinition(tool);
			calls.helperAnswers[tool] = answer;
			return answer;
		};
	const sdk = {
		VERSION: "0.85.1",
		CURRENT_SESSION_VERSION: 3,
		SettingsManager: {
			inMemory: (settings: unknown, options: unknown) => {
				calls.settings.push({ settings, options });
				if (fault.settingsThrows) throw fault.settingsThrows;
				return { kind: "settings" };
			},
		},
		ModelRuntime: {
			create: async (options: unknown) => {
				calls.modelRuntime.push(options);
				if (fault.createRejects) throw fault.createRejects;
				return {
					kind: "model-runtime",
					// The aggregate the installed runtime answers with: undefined when nothing is wrong, and one text
					// when something is, with no way to tell a configuration error from a provider or a refresh one.
					...(fault.getError === "missing"
						? {}
						: {
								getError: () => {
									if (fault.getErrorThrows) throw fault.getErrorThrows;
									if (servicesBuilt && fault.getErrorAfterServices !== undefined) return fault.getErrorAfterServices;
									return "getErrorReturns" in fault ? (fault.getErrorReturns as string | undefined) : fault.getError;
								},
							}),
					getModel: (provider: string, model: string) => {
						calls.getModel.push(`${provider}/${model}`);
						return available.has(`${provider}/${model}`) ? { id: model, provider } : undefined;
					},
				};
			},
		},
		SessionManager: {
			create: (cwd: string, sessionDir?: string) => {
				calls.sessionCreate.push({ cwd, sessionDir });
				if (fault.sessionCreateThrows) throw fault.sessionCreateThrows;
				return { kind: "session-manager", cwd, sessionDir };
			},
			open: (file: string, sessionDir?: string, cwdOverride?: string) => {
				calls.sessionOpen.push({ file, sessionDir, cwdOverride });
				if (fault.sessionOpenThrows) throw fault.sessionOpenThrows;
				return { kind: "session-manager", file };
			},
		},
		createGrepToolDefinition: helperFactory("grep"),
		createFindToolDefinition: helperFactory("find"),
		createAgentSessionServices: async (options: Record<string, any>) => {
			calls.services.push(options);
			if (fault.servicesThrows) throw fault.servicesThrows;
			// The loader calls the override this bootstrap composed while it reloads, which is inside this call, so a
			// double standing in for the loader calls it here: what it raises has to reach the host as its own refusal.
			if (fault.loader && "agentsFiles" in fault.loader) options.resourceLoaderOptions.agentsFilesOverride(fault.loader.agentsFiles);
			servicesBuilt = true;
			// What a loader that loaded exactly the paths it was given would report: one extension per named path, and
			// one skill per named path — the file itself where the entry is a markdown file, and a `SKILL.md` beneath it
			// where the entry is a directory, which is the shape 0.85.1's own loader reports for a directory.
			const namedExtensions: string[] = options.resourceLoaderOptions?.additionalExtensionPaths ?? [];
			const namedSkills: string[] = options.resourceLoaderOptions?.additionalSkillPaths ?? [];
			const loaded = fault.loader?.loaded ?? {};
			// And what it does with a factory it was handed: it runs the factory here, while it loads resources, and
			// reports the extension under `<inline:name>` as both its path and its resolved path, with everything the
			// factory registered carrying that same string as its source path. Running it is what makes the commands
			// below the ones this composition's own factory registered rather than a list this double made up.
			const handed: any[] = Array.isArray(options.resourceLoaderOptions?.extensionFactories) ? options.resourceLoaderOptions.extensionFactories : [];
			const controlLoaded = handed.map((named: any) => {
				const at = `<inline:${named?.name}>`;
				named?.factory?.({
					registerCommand: (name: string, command: { description?: unknown; handler?: unknown }) => {
						calls.registrations.push({ name, description: command?.description, handler: command?.handler, sourceInfo: { path: at } });
					},
				});
				return { path: at, resolvedPath: at, sourceInfo: { path: at, source: named?.name, scope: "temporary", origin: "top-level" } };
			});
			const fromFactories = fault.loader?.control ?? controlLoaded;
			const fromFiles = "extensions" in loaded ? loaded.extensions : namedExtensions.map((at) => ({ path: at, resolvedPath: at }));
			const loader: Record<string, unknown> = {
				kind: "loader",
				getExtensions: () => ({
					// A replacement that is not a list is reported exactly as it is, so a malformed answer stays one.
					extensions: Array.isArray(fromFiles) ? [...fromFactories, ...fromFiles] : fromFiles,
					errors: fault.loader?.extensions ?? [],
					runtime: {},
				}),
				getSkills: () => ({
					skills: loaded.skills ?? namedSkills.map((at) => ({ name: path.basename(at), filePath: at.endsWith(".md") ? at : path.join(at, "SKILL.md") })),
					diagnostics: fault.loader?.skills ?? [],
				}),
				getPrompts: () => ({ prompts: loaded.prompts ?? [], diagnostics: [] }),
				getThemes: () => ({ themes: loaded.themes ?? [], diagnostics: [] }),
			};
			for (const name of ["getExtensions", "getSkills", "getPrompts", "getThemes"]) if (fault.loader?.without === name) delete loader[name];
			if (fault.loader?.throws) {
				const { getter, error } = fault.loader.throws;
				loader[getter] = () => {
					throw error;
				};
			}
			return {
				...options,
				...(fault.loader?.without === "resourceLoader" ? {} : { resourceLoader: loader }),
				diagnostics: fault.serviceDiagnostics ?? [],
			};
		},
		createAgentSessionFromServices: async (options: Record<string, any>) => {
			calls.session.push(options);
			if (fault.sessionThrows) throw fault.sessionThrows;
			// The public constructor appends a `thinking_level_change` to an opened branch that carries messages and has
			// none. Scripted here, in the order it happens, so a later refusal can be shown to come after it.
			if (fault.appendsOnConstruct) calls.appended.push(fault.appendsOnConstruct);
			// What Pi 0.85.1 does with the `tools` option: it is the allow list, so a registered name inside it is
			// active and a name outside it never becomes active, whichever extension registered it. `registry` stands
			// for what an extension's factory body registered, which is in the registry before the session exists.
			const registered = new Set([...BUILTIN_TOOLS, ...(fault.tools?.registry ?? [])]);
			// A definition passed in `customTools` is in the registry under its own name, which is what the installed
			// refresh does with one: it replaces a builtin of that name and adds one the registry did not have.
			for (const definition of Array.isArray(options.customTools) ? options.customTools : []) {
				if (typeof definition?.name === "string") registered.add(definition.name);
			}
			const allowed: string[] = Array.isArray(options.tools) ? options.tools : [];
			const session: Record<string, unknown> = {
				kind: "agent-session",
				/** The later lifecycle, as this double stands in for it: a tool registered after construction. */
				registerLate: () => {
					for (const name of fault.tools?.late ?? []) registered.add(name);
				},
				getActiveToolNames: () => {
					if (fault.tools?.throws) throw fault.tools.throws;
					if (fault.tools && "active" in fault.tools) return fault.tools.active;
					return [...registered].filter((name) => allowed.includes(name));
				},
				// The runner the session exposes, answering for the commands the loader's factories registered. The
				// bare name is what this Pi resolves when no two extensions registered one name; a case that wants a
				// collision, another source or an answer this bootstrap cannot read replaces the list outright.
				extensionRunner: {
					getRegisteredCommands: () => {
						if (fault.commands?.throws) throw fault.commands.throws;
						if (fault.commands && "list" in fault.commands) return fault.commands.list;
						return calls.registrations.map((each) => ({ name: each.name, description: each.description, sourceInfo: each.sourceInfo, invocationName: each.name }));
					},
				},
			};
			if (fault.tools?.without) delete session.getActiveToolNames;
			if (fault.commands?.without === "runner") delete session.extensionRunner;
			if (fault.commands?.without === "accessor") session.extensionRunner = {};
			return { session, extensionsResult: { extensions: [] } };
		},
		createAgentSessionRuntime: async (factory: any, options: Record<string, any>) => {
			calls.runtime.push(options);
			if (fault.runtimeThrows) throw fault.runtimeThrows;
			const created = await factory({ cwd: fault.sessionCwd ?? options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager });
			return { kind: "runtime", created };
		},
		runRpcMode: async () => undefined as never,
		// The installed parser skips a line it cannot parse rather than throwing, so this double does the same: a
		// malformed file comes back as the entries it could read, which is what the preflight has to cope with.
		parseSessionEntries: (content: string) => {
			if (fault.parse) throw new Error("the parser itself failed");
			const entries: unknown[] = [];
			for (const line of content.trim().split("\n")) {
				if (!line.trim()) continue;
				try {
					entries.push(JSON.parse(line));
				} catch {
					// skipped, exactly as the installed parser skips it
				}
			}
			return entries;
		},
	};
	return { sdk: sdk as unknown as BootstrapSdk, calls };
}

function withDir(body: (root: string) => void): void {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-bootstrap-"));
	try {
		body(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** The same, for a case that runs a process: the directory has to outlive the await, not the call that started it. */
async function withDirAsync(body: (root: string) => Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-bootstrap-"));
	try {
		await body(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** A session file as Pi writes one: a header line, then entries. Literal, so no Pi code is needed to make a fixture. */
const sessionFile = (dir: string, header: Record<string, unknown>, entries: Array<Record<string, unknown>> = []): string => {
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return file;
};

const header = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "session", version: 3, id: "abc123", timestamp: "2026-09-27T10:00:00.000Z", cwd: "/work", ...over });

/** The fence every subprocess of this file is started with, except the two named below. */
const FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");

interface Ran {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * The directories a subprocess of this file owns: its working directory, and the known defaults a program reads to
 * decide where to put a home, a temporary file or a cache. They are made under one unique root per process and removed
 * with it, so a child that follows those defaults writes inside a directory this test made and deletes, and nothing
 * outside that root is created or removed here. It retargets the variables named below and not literally every path a
 * process could write to: an absolute path compiled into a program is still that path, which is why what runs in these
 * children is this repository's own code and a double, and never a real backend child.
 */
const sandbox = (): { root: string; env: NodeJS.ProcessEnv; cwd: string; dispose: () => void } => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-child-"));
	const own = (name: string): string => {
		const at = path.join(root, name);
		fs.mkdirSync(at, { recursive: true });
		return at;
	};
	const cwd = own("cwd");
	// Built up rather than copied down: only what a node process needs to run at all, and then the directories this
	// root owns. Nothing of the host's configuration reaches a child — no NODE_OPTIONS, no NODE_PATH, no compile cache
	// or coverage or preload variable, no provider key, no auth path and no PI variable — because every one of those
	// changes what a child does, and a case that wants one says so by passing it.
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: own("home"),
		TMPDIR: own("tmp"),
		XDG_CONFIG_HOME: own("xdg/config"),
		XDG_DATA_HOME: own("xdg/data"),
		XDG_CACHE_HOME: own("xdg/cache"),
		XDG_STATE_HOME: own("xdg/state"),
	};
	if (process.platform === "win32") {
		// What Windows needs to start a process at all, copied as it is; everything a program writes to is this root's.
		for (const name of ["SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
			if (process.env[name] !== undefined) env[name] = process.env[name];
		}
		Object.assign(env, { APPDATA: own("appdata"), LOCALAPPDATA: own("localappdata"), USERPROFILE: env.HOME, TEMP: env.TMPDIR, TMP: env.TMPDIR });
	}
	return { root, env, cwd, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
};

const run = (args: string[], fixture: NodeJS.ProcessEnv, options: { fenced: boolean }): Promise<Ran> => {
	const owned = sandbox();
	return new Promise<Ran>((resolve) => {
		const argv = options.fenced ? ["--import", pathToFileURL(FENCE).href, ...args] : [...args];
		const proc = execFile(process.execPath, argv, { cwd: owned.cwd, env: { ...owned.env, ...fixture }, encoding: "utf8" }, (_error, stdout, stderr) => {
			resolve({ code: proc.exitCode, stdout, stderr });
		});
	}).finally(() => owned.dispose());
};

/**
 * A subprocess of this file: fenced, so node's own module resolution in it refuses a backend SDK by name, by subpath or
 * by a path that resolves into one of those installed packages, and given a sanitized environment and a working
 * directory of its own. Every process case in this file goes through this except the two named below. It is a
 * resolution rule rather than a sandbox: what it rules out is the ordinary import these children make.
 */
const child = (args: string[], env: NodeJS.ProcessEnv): Promise<Ran> => run(args, env, { fenced: true });

/**
 * The two exceptions, and they are narrow ones. Reading the installed package's exports, and calling its public
 * accessor for the host agent directory, are the only things in this file that have to touch the real installation —
 * the first is the floor the bootstrap's own compatibility check stands on, and the second is a one-call accessor. A
 * fence would refuse the very import each one exists to make, so they run without it and keep everything else: the same
 * sanitized environment and the same owned working directory. What they may not do is build anything — no session, no
 * settings manager, no model runtime, no backend and no child of their own — and the assertions that follow each call
 * are what hold them to it. Resolution comes from the installation itself, because the module doing the importing
 * lives in this repository: no override names the package and no temporary directory is asked to resolve it.
 */
const installedPackageChild = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> => run(args, env, { fenced: false });

/**
 * The half of a subprocess double that answers for the one factory the production composition hands the loader. Both
 * scripts below share it, because both of them run the whole runtime and the bootstrap requires that factory's own
 * extension and its two commands: a double that ignored `extensionFactories` would report a child nobody could move
 * and refuse every one of those runs. It does what the installed loader does and no more — it runs each named factory
 * it was handed, reports one loaded extension per factory under `<inline:name>` as both paths, and answers the
 * session's registry with what those factories actually registered, each under its bare name. Nothing here is
 * hardcoded to succeed: an empty `extensionFactories` still loads nothing and still refuses the call.
 */
const factoryDouble = `
const registrations = [];
let loadedFromFactories = [];
const loadFactories = (options) => {
	const handed = Array.isArray(options?.resourceLoaderOptions?.extensionFactories) ? options.resourceLoaderOptions.extensionFactories : [];
	loadedFromFactories = handed.map((named) => {
		const at = "<inline:" + named.name + ">";
		const sourceInfo = { path: at, source: named.name, scope: "temporary", origin: "top-level" };
		named.factory({
			registerCommand: (name, command) => {
				registrations.push({ name, invocationName: name, description: command.description, handler: command.handler, sourceInfo });
			},
		});
		return { path: at, resolvedPath: at, sourceInfo };
	});
};
const extensionRunner = { getRegisteredCommands: () => registrations.map((each) => ({ ...each })) };
`;

/**
 * The bootstrap's own `main`, run in a node process with a double for the SDK, because `main` exits the process on a
 * startup failure and `runRpcMode` owns stdout. The double lives in the script rather than in a file of its own, and
 * the guard never fires here: node ran `-e`, not this file.
 */
const mainScript = `${factoryDouble}
const { main } = await import(${JSON.stringify(bootstrapUrl)});
const manager = { kind: "session-manager" };
const sdk = {
	VERSION: "0.85.1",
	CURRENT_SESSION_VERSION: 3,
	SettingsManager: { inMemory: () => ({ kind: "settings" }) },
	ModelRuntime: {
		create: async () => {
			if (process.env.SCENARIO === "create-throws") throw new Error(process.env.MARKER);
			return {
				getError: () => {
					if (process.env.SCENARIO === "geterror-throws") throw new Error(process.env.MARKER);
					return process.env.SCENARIO === "reports" ? process.env.MARKER : undefined;
				},
				getModel: () => ({ id: "deepseek-chat" }),
			};
		},
	},
	SessionManager: { create: () => manager, open: () => manager },
	createGrepToolDefinition: (cwd) => ({ name: "grep", label: "Search file contents", execute: async () => ({ content: [], details: undefined }) }),
	createFindToolDefinition: (cwd) => ({ name: "find", label: "Find files", execute: async () => ({ content: [], details: undefined }) }),
	createAgentSessionServices: async (options) => {
		if (process.env.SCENARIO === "services-throw") throw new Error(process.env.MARKER ?? "the services could not be created");
		loadFactories(options);
		return {
			...options,
			resourceLoader: {
				getExtensions: () => ({ extensions: loadedFromFactories, errors: [] }),
				getSkills: () => ({ skills: [], diagnostics: [] }),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
			},
			diagnostics: [],
		};
	},
	createAgentSessionFromServices: async (options) => ({ session: { getActiveToolNames: () => [...(options.tools ?? [])], extensionRunner }, extensionsResult: {} }),
	createAgentSessionRuntime: async (factory, options) => {
		await factory({ cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager });
		return { dispose: async () => {} };
	},
	runRpcMode: async () => undefined,
	parseSessionEntries: () => [],
};
if (process.env.SCENARIO === "missing-api") delete sdk.createAgentSessionRuntime;
await main([process.env.CALL_INPUT], { sdk });
`;

/**
 * The bootstrap's own diagnostic lines out of a child's stderr. Read line by line and guarded, because stderr is not
 * this bootstrap's alone: node itself writes a warning there, and so does the SDK for a file it could not read, and a
 * line of that kind is not a diagnostic to parse. What is kept is a line that parses as json and carries this event.
 * It is a reader for these tests and nothing more — the raw `stderr` is what every secret-marker assertion reads, and
 * nothing production does is changed by it.
 */
const lines = (stderr: string): Array<Record<string, unknown>> => {
	const found: Array<Record<string, unknown>> = [];
	for (const line of stderr.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const record = parsed as Record<string, unknown>;
		if (record && typeof record === "object" && !Array.isArray(record) && record.event === DIAGNOSTIC_EVENT) found.push(record);
	}
	return found;
};

/** The marker the test fence refuses with. Pinned against the fence's own source below, so the two cannot drift. */
const FENCE_MARKER = "pi-fusion test fence:";

/** The name the fence refuses by a rule of its own, which is installed nowhere. Pinned against its source the same way. */
const FENCE_SENTINEL = "pi-fusion-fence-sentinel";

/** What a double handed to `main` was asked for, in the order it was asked, as the Proxy in `touchScript` reports it. */
const TOUCH_EVENT = "pi-fusion-test-sdk-touch";
const touches = (stderr: string): string[] =>
	stderr
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((line) => line.event === TOUCH_EVENT)
		.map((line) => String(line.property));

/**
 * `main` with a double behind a Proxy that reports every property read of it. That is what makes an ordering claim
 * about what runs before the SDK is reached a claim about the bootstrap rather than about a double nobody passed.
 */
const touchScript = `${factoryDouble}
const { main } = await import(${JSON.stringify(bootstrapUrl)});
const manager = { kind: "session-manager" };
const loader = {
	getExtensions: () => ({ extensions: loadedFromFactories, errors: [] }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
};
const held = {
	VERSION: "0.85.1",
	CURRENT_SESSION_VERSION: 3,
	SettingsManager: { inMemory: () => ({ kind: "settings" }) },
	ModelRuntime: { create: async () => ({ getError: () => undefined, getModel: () => ({ id: "deepseek-chat" }) }) },
	SessionManager: { create: () => manager, open: () => manager },
	createGrepToolDefinition: (cwd) => ({ name: "grep", execute: async () => ({ content: [], details: undefined }) }),
	createFindToolDefinition: (cwd) => ({ name: "find", execute: async () => ({ content: [], details: undefined }) }),
	createAgentSessionServices: async (options) => {
		loadFactories(options);
		return { ...options, resourceLoader: loader, diagnostics: [] };
	},
	createAgentSessionFromServices: async (options) => ({ session: { getActiveToolNames: () => [...(options.tools ?? [])], extensionRunner }, extensionsResult: {} }),
	createAgentSessionRuntime: async (factory, options) => {
		await factory({ cwd: options.cwd, agentDir: options.agentDir, sessionManager: options.sessionManager });
		return { dispose: async () => {} };
	},
	runRpcMode: async () => undefined,
	parseSessionEntries: () => [],
};
const sdk = new Proxy(held, {
	get(target, property) {
		process.stderr.write(JSON.stringify({ event: ${JSON.stringify(TOUCH_EVENT)}, property: String(property) }) + "\\n");
		return target[property];
	},
});
await main([process.env.CALL_INPUT], { sdk });
`;

test("the bootstrap is handed its own model runtime, settings and session manager, and no file-backed default", async () => {
	const { sdk, calls } = fakeSdk();
	await createRuntime(input(), sdk);
	assert.deepEqual(calls.modelRuntime, [
		{
			authPath: STORAGE.authPath,
			modelsPath: STORAGE.modelsPath,
			modelsStorePath: STORAGE.modelsStorePath,
			allowModelNetwork: true,
		},
	]);
	assert.deepEqual(calls.sessionCreate, [{ cwd: "/work", sessionDir: STORAGE.sessionDir }]);
	assert.deepEqual(calls.sessionOpen, []);
	assert.equal(calls.runtime.length, 1);
	assert.deepEqual([calls.runtime[0].cwd, calls.runtime[0].agentDir], ["/work", STORAGE.agentDir]);
	assert.deepEqual(calls.runtime[0].sessionManager, { kind: "session-manager", cwd: "/work", sessionDir: STORAGE.sessionDir });
	assert.equal(calls.session[0].sessionManager, calls.runtime[0].sessionManager, "the session is built on the manager the runtime was given, not on a second one");
	const services = calls.services[0];
	assert.equal(services.cwd, "/work");
	assert.equal(services.agentDir, STORAGE.agentDir);
	assert.equal(calls.settings.length, 1, "one settings manager, made here and handed over");
	assert.deepEqual(services.settingsManager, { kind: "settings" }, "the settings manager is the one this bootstrap made, never the file-backed default");
	assert.equal(services.modelRuntime.kind, "model-runtime", "the model runtime is the one this bootstrap made");
	assert.deepEqual(calls.getModel, ["deepseek/deepseek-chat"], "one exact pair is asked for, and nothing else is looked up");
	const session = calls.session[0];
	assert.deepEqual(session.model, { id: "deepseek-chat", provider: "deepseek" });
	assert.equal(session.thinkingLevel, "high");
	assert.deepEqual(session.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	assert.equal(session.sessionManager.kind, "session-manager");
});

test("a call that names no thinking level leaves the child the one its model comes with", async () => {
	const { sdk, calls } = fakeSdk();
	await createRuntime(input({ thinkingLevel: undefined }), sdk);
	assert.equal("thinkingLevel" in calls.session[0], false, "an absent level is absent, not a level this host chose");
});

test("the child's settings are in memory, trust nothing and leave the loader nowhere to install from", async () => {
	const { sdk, calls } = fakeSdk();
	await createRuntime(input(), sdk);
	// Every key, exactly: the empty lists are what leaves the loader nowhere to install from, and the four behavior
	// settings are the values installed Pi already defaults to, said out loud because the stock CLI writes each of them
	// into a user's settings file from an RPC setter and a child should not inherit a later default silently.
	assert.deepEqual(calls.settings, [
		{
			settings: {
				defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
				packages: [],
				extensions: [],
				skills: [],
				prompts: [],
				themes: [],
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				compaction: { enabled: true },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
				enableSkillCommands: true,
			},
			options: { projectTrusted: false },
		},
	]);
});

test("resource discovery is off and the prompt is Pi's own plus exactly the role contract", () => {
	const composed = input();
	const options = resourceOptions(composed);
	assert.deepEqual(Object.keys(options).sort(), [
		"additionalExtensionPaths",
		"additionalPromptTemplatePaths",
		"additionalSkillPaths",
		"additionalThemePaths",
		"agentsFilesOverride",
		"appendSystemPromptOverride",
		"extensionFactories",
		"noContextFiles",
		"noExtensions",
		"noPromptTemplates",
		"noSkills",
		"noThemes",
		"systemPromptOverride",
	]);
	assert.deepEqual([options.noExtensions, options.noSkills, options.noPromptTemplates, options.noThemes], [true, true, true, true]);
	assert.deepEqual([options.additionalExtensionPaths, options.additionalSkillPaths, options.additionalPromptTemplatePaths, options.additionalThemePaths], [[], [], [], []]);
	// The one factory this composition passes is Fusion's own control extension, named so the loader reports it under
	// a path this build knows. Nothing else is hidden here, and nothing about the call decides whether it goes in.
	assert.equal(options.extensionFactories.length, 1);
	const factory = options.extensionFactories[0] as { name: string; factory: unknown };
	assert.deepEqual(Object.keys(factory).sort(), ["factory", "name"]);
	assert.equal(factory.name, CONTROL_EXTENSION_NAME);
	assert.equal(typeof factory.factory, "function");
	assert.equal(CONTROL_EXTENSION_PATH, `<inline:${CONTROL_EXTENSION_NAME}>`, "which is how this Pi spells a named factory's path");
	assert.equal(options.noContextFiles, false, "the project's own instruction files are the one thing a child picks up from the working directory");
	assert.equal(options.systemPromptOverride("# SYSTEM.md the loader found"), undefined, "a SYSTEM.md cannot replace Pi's base prompt");
	assert.equal(options.systemPromptOverride(undefined), undefined);
	assert.deepEqual(options.appendSystemPromptOverride(["# APPEND_SYSTEM.md the loader found"]), [composed.contract], "exactly the role contract, and nothing the loader found beside it");
	assert.deepEqual(options.appendSystemPromptOverride([]), [composed.contract]);
});

test("the services are built with the resource options this bootstrap composed", async () => {
	const { sdk, calls } = fakeSdk();
	const composed = input();
	await createRuntime(composed, sdk);
	const options = calls.services[0].resourceLoaderOptions;
	assert.deepEqual([options.noExtensions, options.noSkills, options.noPromptTemplates, options.noThemes], [true, true, true, true]);
	assert.equal(options.noContextFiles, false);
	assert.deepEqual(
		(options.extensionFactories as Array<{ name: string }>).map((each) => each.name),
		[CONTROL_EXTENSION_NAME],
		"the services get the one factory this composition passes, and no second one",
	);
	assert.equal(typeof options.agentsFilesOverride, "function", "the child agent directory's own instruction file is left out by an override the services get");
	assert.deepEqual(options.appendSystemPromptOverride([]), [composed.contract]);
	assert.equal(options.systemPromptOverride("anything"), undefined);
});

/*
 * What a resource entry may be, checked against a filesystem of the test's own: one fixture root per case, made by
 * `withDir`, with every path under it. Nothing here loads a resource — the double builds nothing — so what these cases
 * are about is which entries reach the loader at all and which fail the call before the SDK is even imported.
 */

test("the resources a call names are the only ones the loader is given, and each one is an existing local path", async () => {
	await withDirAsync(async (root) => {
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(file, "export default () => {};\n");
		const dir = path.join(root, "skill");
		fs.mkdirSync(dir);
		const composed = checkInput({ ...input(), extensions: [file], skills: [dir] });
		assert.deepEqual([composed.extensions, composed.skills], [[file], [dir]], "a checked entry is kept exactly as it was composed");
		const options = resourceOptions(composed);
		assert.deepEqual([options.additionalExtensionPaths, options.additionalSkillPaths], [[file], [dir]]);
		assert.deepEqual([options.additionalPromptTemplatePaths, options.additionalThemePaths], [[], []], "a prompt template and a theme are not resources a call adds");
		const { sdk, calls } = fakeSdk();
		await createRuntime(composed, sdk);
		const handed = calls.services[0].resourceLoaderOptions;
		assert.deepEqual([handed.additionalExtensionPaths, handed.additionalSkillPaths], [[file], [dir]], "the paths the loader is given are the paths the call named");
		// The lists handed over are copies, so nothing done to one of them reaches the input this call was read from.
		handed.additionalExtensionPaths.push(path.join(root, "not-named.ts"));
		assert.deepEqual(composed.extensions, [file]);
		// Existence is this literal path's own: there is no glob language here, so a filename holding `*`, `?` or `[` is
		// the file of that name and is found by being that name rather than by matching anything.
		if (process.platform !== "win32") {
			const punctuated = path.join(root, "a[1]-*.ts");
			fs.writeFileSync(punctuated, "export default () => {};\n");
			assert.deepEqual(checkInput({ ...input(), extensions: [punctuated] }).extensions, [punctuated]);
			// A symlink to a file this child may read is that file: the kind is the target's, and nothing resolves the
			// link — the path handed over is the one the call named. Both cases are this platform's alone.
			const link = path.join(root, "linked-ext.ts");
			fs.symlinkSync(file, link);
			assert.deepEqual(checkInput({ ...input(), extensions: [link] }).extensions, [link]);
		}
	});
});

test("a resource entry that is not an existing local path is refused by its field, its index and the rule it broke", async () => {
	await withDirAsync(async (root) => {
		const there = path.join(root, "marker-resource-secret-ext.ts");
		fs.writeFileSync(there, "export default () => {};\n");
		const cases: Array<{ what: string; field: "extensions" | "skills"; entries: unknown[]; expect: RegExp }> = [
			{ what: "a url", field: "extensions", entries: ["https://example.com/marker-resource-secret-ext.ts"], expect: /^the call input's extensions\[0\] is a url, and a child loads local paths only/ },
			{ what: "a url anywhere in the entry", field: "skills", entries: ["/work/marker-resource-secret://x"], expect: /^the call input's skills\[0\] is a url/ },
			{ what: "an npm specifier", field: "extensions", entries: ["npm:marker-resource-secret-package"], expect: /^the call input's extensions\[0\] starts with a uri scheme/ },
			{ what: "a git specifier", field: "skills", entries: ["git\u002bssh:marker-resource-secret/repo"], expect: /^the call input's skills\[0\] starts with a uri scheme/ },
			{ what: "a file url", field: "extensions", entries: ["file:/work/marker-resource-secret-ext.ts"], expect: /^the call input's extensions\[0\] starts with a uri scheme/ },
			{ what: "a data url", field: "extensions", entries: ["data:,marker-resource-secret"], expect: /^the call input's extensions\[0\] starts with a uri scheme/ },
			{ what: "blank", field: "skills", entries: [""], expect: /^the call input's skills\[0\] is blank/ },
			{ what: "whitespace", field: "skills", entries: ["   "], expect: /^the call input's skills\[0\] is blank/ },
			{ what: "not a string", field: "extensions", entries: [7], expect: /^the call input's extensions\[0\] is blank/ },
			{ what: "absent", field: "extensions", entries: [undefined], expect: /^the call input's extensions\[0\] is blank/ },
			{ what: "a path that is not there", field: "extensions", entries: [path.join(root, "marker-resource-secret-missing.ts")], expect: /^the call input's extensions\[0\] is not on this machine/ },
			{ what: "a path under a file", field: "skills", entries: [path.join(there, "marker-resource-secret-under-a-file")], expect: /^the call input's skills\[0\] is not on this machine/ },
			// The index is the entry's own place in the list, and the field says which list it was in. An entry that is
			// fine is no reason to load the one beside it: the first failure refuses the whole call.
			{ what: "the second of two", field: "extensions", entries: [there, "npm:marker-resource-secret-package"], expect: /^the call input's extensions\[1\] starts with a uri scheme/ },
			{ what: "a leading space before a scheme", field: "extensions", entries: [" npm:marker-resource-secret-package"], expect: /^the call input's extensions\[0\] is not an absolute path/ },
			// A Windows drive is a path rather than a scheme, which is the syntax rule; on this platform it is not an
			// absolute path, so it is refused for that instead. Neither says anything about a Windows filesystem.
			{ what: "a windows drive on this platform", field: "skills", entries: ["C:/marker-resource-secret/skill"], expect: process.platform === "win32" ? /^the call input's skills\[0\] is not on this machine/ : /^the call input's skills\[0\] is not an absolute path/ },
		];
		for (const one of cases) {
			assert.throws(
				() => checkInput({ ...input(), [one.field]: one.entries }),
				(error: Error & { stage?: string }) => {
					assert.equal(error.stage, "input", one.what);
					assert.match(error.message, one.expect, one.what);
					assert.ok(!error.message.includes("marker-resource-secret"), `${one.what} repeated the entry it refused: ${error.message}`);
					return true;
				},
				one.what,
			);
		}
		// A relative entry is refused even when it is there: the host resolves a resource before it composes the call,
		// so a child resolving one of its own would resolve it against a working directory nobody checked.
		const cwd = process.cwd();
		try {
			process.chdir(root);
			assert.equal(fs.existsSync(path.resolve("marker-resource-secret-ext.ts")), true, "the relative path is there, and is refused anyway");
			assert.throws(() => checkInput({ ...input(), extensions: ["marker-resource-secret-ext.ts"] }), /^StartupError: the call input's extensions\[0\] is not an absolute path/);
			assert.throws(() => checkInput({ ...input(), skills: ["./marker-resource-secret-ext.ts"] }), /skills\[0\] is not an absolute path/);
		} finally {
			process.chdir(cwd);
		}
		assert.throws(() => checkInput({ ...input(), extensions: "ext.ts" }), /extensions is not a list/);
		assert.throws(() => checkInput({ ...input(), skills: undefined }), /skills is not a list/);
	});
});

test("a resource that is neither a file nor a directory, and one this child may not read, are each refused", async () => {
	await withDirAsync(async (root) => {
		// The kind rule and the access rules against a filesystem of this test's own making. `resourceProbe` is the
		// seam: as root a mode of 000 is still readable, so the rules are exercised deterministically through a probe
		// that reports what a filesystem would, and the real-filesystem cases below are qualified rather than assumed.
		// Nothing production reads a probe: `readInput` calls `checkInput` with the default.
		const entry = path.join(root, "marker-resource-secret-thing");
		fs.writeFileSync(entry, "x");
		const neither = { stat: () => ({ isFile: () => false, isDirectory: () => false }), readable: () => undefined };
		assert.throws(
			() => checkInput({ ...input(), extensions: [entry] }, neither),
			(error: Error & { stage?: string }) => {
				assert.equal(error.stage, "input");
				assert.match(error.message, /^the call input's extensions\[0\] is neither a regular file nor a directory/);
				assert.ok(!error.message.includes("marker-resource-secret"));
				return true;
			},
		);
		const denied = (code: string, kind: "file" | "directory" = "file") => ({
			stat: () => ({ isFile: () => kind === "file", isDirectory: () => kind === "directory" }),
			readable: () => {
				const error = new Error(`EACCES: permission denied, access '${entry}'`) as Error & { code?: string };
				error.code = code;
				throw error;
			},
		});
		const markdown = path.join(root, "marker-resource-secret-skill.md");
		fs.writeFileSync(markdown, "# skill\n");
		assert.throws(
			() => checkInput({ ...input(), skills: [markdown] }, denied("EACCES")),
			(error: Error) => {
				assert.match(error.message, /^the call input's skills\[0\] cannot be read by this child \(EACCES\)/);
				assert.ok(!error.message.includes("marker-resource-secret"), "the errno text names the path, and the refusal does not repeat it");
				return true;
			},
		);
		// A directory the loader may list and may not search is refused too, and says so as its own rule: on POSIX the
		// two are separate permissions, and a directory it cannot walk into is a directory it reads half of.
		assert.throws(
			() => checkInput({ ...input(), skills: [entry] }, denied("EACCES", "directory")),
			(error: Error) => {
				assert.match(error.message, /^the call input's skills\[0\] cannot be read and searched by this child \(EACCES\)/);
				assert.match(error.message, /a directory the loader has to list and walk into is refused rather than half read/);
				assert.ok(!error.message.includes("marker-resource-secret"));
				return true;
			},
		);
		// A stat that fails for something other than a missing path names the code and nothing else.
		const looped = {
			stat: () => {
				const error = new Error(`ELOOP: too many symbolic links, stat '${entry}'`) as Error & { code?: string };
				error.code = "ELOOP";
				throw error;
			},
			readable: () => undefined,
		};
		assert.throws(() => checkInput({ ...input(), extensions: [entry] }, looped), /^StartupError: the call input's extensions\[0\] could not be looked at \(ELOOP\)/);
		const codeless = { stat: () => { throw new Error("marker-resource-secret plain failure"); }, readable: () => undefined };
		assert.throws(
			() => checkInput({ ...input(), extensions: [entry] }, codeless),
			(error: Error) => {
				assert.match(error.message, /^the call input's extensions\[0\] could not be looked at \(no code\)/);
				assert.ok(!error.message.includes("marker-resource-secret"));
				return true;
			},
		);
		// The same two rules against the real filesystem, qualified: a character device is neither a file nor a
		// directory on a POSIX system, and a mode of 000 is unreadable to everybody but root.
		if (process.platform !== "win32") {
			assert.throws(() => checkInput({ ...input(), extensions: ["/dev/null"] }), /extensions\[0\] is neither a regular file nor a directory/, "a character device is not a resource");
		}
		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			const locked = path.join(root, "marker-resource-secret-locked.ts");
			fs.writeFileSync(locked, "x");
			fs.chmodSync(locked, 0o000);
			try {
				assert.throws(() => checkInput({ ...input(), extensions: [locked] }), /extensions\[0\] cannot be read by this child \(EACCES\)/);
			} finally {
				fs.chmodSync(locked, 0o600);
			}
			// A directory of mode 0400 is the case the composed mode exists for: its names can be listed and none of
			// them can be resolved, so `R_OK` alone would pass it and the production probe, which asks for `X_OK` too,
			// does not. Qualified: POSIX and a non-root process, which is the only place this mode means anything.
			const unsearchable = path.join(root, "marker-resource-secret-unsearchable");
			fs.mkdirSync(unsearchable);
			fs.chmodSync(unsearchable, 0o400);
			try {
				assert.doesNotThrow(() => fs.accessSync(unsearchable, fs.constants.R_OK), "the control: this directory is readable, and it is refused for the search permission it lacks");
				assert.throws(() => checkInput({ ...input(), skills: [unsearchable] }), /skills\[0\] cannot be read and searched by this child \(EACCES\)/);
				assert.throws(() => checkInput({ ...input(), extensions: [unsearchable] }), /extensions\[0\] cannot be read and searched by this child \(EACCES\)/);
			} finally {
				fs.chmodSync(unsearchable, 0o700);
			}
		}
	});
});

test("a probe is told which kind it is being asked about, and a directory is asked for the search permission too", async () => {
	await withDirAsync(async (root) => {
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(file, "export default () => {};\n");
		const dir = path.join(root, "skill-directory");
		fs.mkdirSync(dir);
		const markdown = path.join(root, "one-skill.md");
		fs.writeFileSync(markdown, "# skill\n");
		const seen: Array<{ file: string; kind: string; mode: number }> = [];
		const probe = {
			stat: (at: string) => fs.statSync(at),
			// What production's own probe composes, recorded here rather than assumed: a file is asked for R_OK, and a
			// directory for R_OK together with X_OK, which on POSIX is the permission to resolve a name inside it.
			readable: (at: string, kind: "file" | "directory") => {
				const mode = kind === "directory" ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK;
				seen.push({ file: at, kind, mode });
				fs.accessSync(at, mode);
			},
		};
		const composed = checkInput({ ...input(), extensions: [file, dir], skills: [markdown, dir] }, probe);
		assert.deepEqual(
			seen,
			[
				{ file, kind: "file", mode: fs.constants.R_OK },
				{ file: dir, kind: "directory", mode: fs.constants.R_OK | fs.constants.X_OK },
				{ file: markdown, kind: "file", mode: fs.constants.R_OK },
				{ file: dir, kind: "directory", mode: fs.constants.R_OK | fs.constants.X_OK },
			],
			"each entry is probed once, in the order of its list, with the kind its own stat reported",
		);
		assert.deepEqual([composed.extensions, composed.skills], [[file, dir], [markdown, dir]], "and every one of them is kept");
		// The default probe reaches the same filesystem for the same entries, which is the production path.
		assert.deepEqual(checkInput({ ...input(), extensions: [file, dir], skills: [markdown, dir] }).skills, [markdown, dir]);
	});
});

test("an explicit skill file is a markdown file, because this Pi loads no skill from any other and only warns", async () => {
	await withDirAsync(async (root) => {
		const refused = ["marker-resource-secret-skill.txt", "marker-resource-secret-SKILL.MD", "marker-resource-secret-skill.Md", "marker-resource-secret-skill.md.bak", "marker-resource-secret-skill"];
		for (const name of refused) {
			const at = path.join(root, name);
			fs.writeFileSync(at, "# a skill this loader would not load\n");
			assert.throws(
				() => checkInput({ ...input(), skills: [at] }),
				(error: Error & { stage?: string }) => {
					assert.equal(error.stage, "input", name);
					assert.match(error.message, /^the call input's skills\[0\] is a regular file whose name does not end in \.md/, name);
					assert.match(error.message, /compared exactly and so in lower case/, name);
					assert.match(error.message, /answered with a warning and no skill at all/, name);
					assert.ok(!error.message.includes("marker-resource-secret"), `${name}: the refusal repeated the entry it refused`);
					assert.ok(!error.message.includes(root), `${name}: the refusal named the path`);
					return true;
				},
				name,
			);
			// The same file is an extension entry's business and not this rule's: the suffix rule is the skill
			// loader's own, so it is applied to the field that loader reads and to no other.
			assert.deepEqual(checkInput({ ...input(), extensions: [at] }).extensions, [at]);
		}
		// The positives: a lower-case `.md` file, a dotfile named `.md`, and a directory, which has no name rule here.
		const accepted = [path.join(root, "one-skill.md"), path.join(root, ".md")];
		for (const at of accepted) {
			fs.writeFileSync(at, "# skill\n");
			assert.deepEqual(checkInput({ ...input(), skills: [at] }).skills, [at], at);
		}
		const directory = path.join(root, "skill-directory");
		fs.mkdirSync(directory);
		fs.writeFileSync(path.join(directory, "SKILL.md"), "# skill\n");
		assert.deepEqual(checkInput({ ...input(), skills: [directory] }).skills, [directory], "a directory is the other eligible kind, and what is inside it is not checked here");
		// The index and the field are the entry's own, and a good entry beside a bad one does not excuse it.
		const good = path.join(root, "good-skill.md");
		fs.writeFileSync(good, "# skill\n");
		assert.throws(() => checkInput({ ...input(), skills: [good, path.join(root, "marker-resource-secret-skill.txt")] }), /^StartupError: the call input's skills\[1\] is a regular file whose name does not end in \.md/);
	});
});

test("a refused resource fails the call while nothing has been loaded: no package, no configuration, no session", async () => {
	await withDirAsync(async (root) => {
		const file = path.join(root, "bootstrap.json");
		fs.writeFileSync(file, JSON.stringify({ ...input(), extensions: [path.join(root, "marker-resource-secret-missing.ts")] }));
		// The production path, with no double at all: a failure here is a failure before `loadSdk`, which is why the
		// line carries no `sdk` version and why no later stage was ever reported. Nothing imported the package, built a
		// model runtime or read a models file, because the only thing that ran was reading and checking one input file.
		const refused = await child([PI_BOOTSTRAP_PATH, file], {});
		assert.equal(refused.code, STARTUP_EXIT_CODE);
		assert.equal(refused.stdout, "", "stdout belongs to runRpcMode, and nothing served");
		const reported = lines(refused.stderr);
		assert.equal(reported.length, 1, `one diagnostic and no stage report: ${refused.stderr}`);
		assert.deepEqual([reported[0].stage, "sdk" in reported[0]], ["input", false]);
		assert.match(String(reported[0].error), /extensions\[0\] is not on this machine/);
		assert.ok(!refused.stderr.includes("marker-resource-secret"));
		// The skill suffix rule through the same production path: a readable `.txt` the loader would answer with a
		// warning and no skill fails the call in the input stage, before the package is imported or a model read.
		const textual = path.join(root, "marker-resource-secret-skill.txt");
		fs.writeFileSync(textual, "# not a markdown skill\n");
		const suffix = path.join(root, "suffix.json");
		fs.writeFileSync(suffix, JSON.stringify({ ...input(), skills: [textual] }));
		const byName = await child([PI_BOOTSTRAP_PATH, suffix], {});
		assert.equal(byName.code, STARTUP_EXIT_CODE);
		assert.equal(byName.stdout, "");
		const named = lines(byName.stderr);
		assert.equal(named.length, 1, `one diagnostic and no stage report: ${byName.stderr}`);
		assert.deepEqual([named[0].stage, "sdk" in named[0]], ["input", false]);
		assert.match(String(named[0].error), /skills\[0\] is a regular file whose name does not end in \.md/);
		assert.ok(!byName.stderr.includes("marker-resource-secret"));
		// And the same ordering with a double actually handed to `main`, so what is asserted is what the bootstrap did
		// rather than what a double nobody passed did not record. The double is a Proxy that reports every property
		// read of it, so the claim is that the SDK was not touched at all — not that one recorded call is missing.
		const untouched = await child(["--input-type=module", "-e", touchScript], { CALL_INPUT: file });
		assert.equal(untouched.code, STARTUP_EXIT_CODE);
		assert.deepEqual(touches(untouched.stderr), [], "an input refusal happens before anything reads the SDK at all");
		const onlyFailure = lines(untouched.stderr);
		assert.equal(onlyFailure.length, 1);
		assert.deepEqual([onlyFailure[0].stage, "sdk" in onlyFailure[0]], ["input", false]);
		// The control that makes that claim worth something: the same double, the same Proxy, a valid input, and the
		// touches are there to be seen.
		const valid = path.join(root, "valid.json");
		fs.writeFileSync(valid, JSON.stringify(input()));
		const touched = await child(["--input-type=module", "-e", touchScript], { CALL_INPUT: valid });
		assert.equal(touched.code, 0, touched.stderr);
		assert.ok(touches(touched.stderr).includes("VERSION"), `a double that is used is seen being used: ${touches(touched.stderr).join(", ")}`);
		assert.ok(touches(touched.stderr).includes("createAgentSessionRuntime"), "including the constructors the runtime is composed from");
	});
});

test("the child agent directory's own instruction file is left out, and every other one the loader found stays", () => {
	const composed = input();
	const agentDir = composed.agentDir;
	const override = resourceOptions(composed).agentsFilesOverride;
	const file = (at: string) => ({ path: at, content: `# ${at}` });
	const base = {
		agentsFiles: [
			file(`${agentDir}/AGENTS.md`),
			file("/AGENTS.md"),
			file("/work/AGENTS.md"),
			file("/work/nested/AGENTS.md"),
			file(`${agentDir}/sessions/AGENTS.md`),
			file("/host/pi-fusion/children-extra/AGENTS.md"),
			file(`${agentDir}/./AGENTS.MD`),
			file(`${agentDir}//CLAUDE.md`),
		],
	};
	assert.deepEqual(
		override(base).agentsFiles.map((one) => one.path),
		["/AGENTS.md", "/work/AGENTS.md", "/work/nested/AGENTS.md", `${agentDir}/sessions/AGENTS.md`, "/host/pi-fusion/children-extra/AGENTS.md"],
		"an ordinary ancestor, the project's own, a nested project's own and a file below the agent directory all stay; only the agent directory's own goes",
	);
	assert.equal(base.agentsFiles.length, 8, "the override reads the list it was given and changes nothing in it");
	assert.deepEqual(override({ agentsFiles: [file("/work/AGENTS.md")] }).agentsFiles, [file("/work/AGENTS.md")], "a file that stays keeps its content exactly");
	assert.deepEqual(override({ agentsFiles: [] }).agentsFiles, []);
	// A shape this override cannot read is a compatibility refusal rather than a prompt nobody accounted for.
	for (const bad of [undefined, {}, { agentsFiles: "AGENTS.md" }, { agentsFiles: [{ content: "no path" }] }, { agentsFiles: [null] }, { agentsFiles: [{ path: 7, content: "x" }] }]) {
		assert.throws(
			() => override(bad as never),
			(error: Error & { stage?: string }) => {
				assert.equal(error.stage, "sdk", JSON.stringify(bad));
				assert.match(error.message, /called agentsFilesOverride with something other than a list of files that name their own paths/);
				return true;
			},
			JSON.stringify(bad),
		);
	}
});

test("an instruction file that is both the agent directory's and the project's own is left out, which is the collision public metadata cannot resolve", () => {
	// With a working directory inside the child agent directory, the loader finds that directory's own context file as
	// the global one and would also find it as an ancestor of the project; it appears once, and a path and a content
	// hold nothing that says which of the two it is. It is suppressed, which is the safe side of the collision, and the
	// limitation is documented rather than worked around with a context loader of Fusion's own.
	const composed = checkInput({ ...input(), cwd: "/host/pi-fusion/children/work", agentDir: "/host/pi-fusion/children" });
	const override = resourceOptions(composed).agentsFilesOverride;
	const kept = override({ agentsFiles: [{ path: "/host/pi-fusion/children/AGENTS.md", content: "# both" }, { path: "/host/pi-fusion/children/work/AGENTS.md", content: "# the project's own" }] });
	assert.deepEqual(
		kept.agentsFiles.map((one) => one.path),
		["/host/pi-fusion/children/work/AGENTS.md"],
		"the working directory's own file stays; the file that is also the agent directory's does not",
	);
});

test("the agent directory a context file is left out for is compared lexically, and Windows names a file its own way", () => {
	assert.equal(inDirectory("/host/children/AGENTS.md", "/host/children"), true);
	assert.equal(inDirectory("/host/children/AGENTS.md", "/host/children/"), true, "a trailing separator is the same directory");
	assert.equal(inDirectory("/host/children//AGENTS.md", "/host/children"), true);
	assert.equal(inDirectory("/host/children/./AGENTS.md", "/host/children"), true);
	assert.equal(inDirectory("/host/children/sub/AGENTS.md", "/host/children"), false, "a file below the directory is not the directory's own, and nothing here excludes a prefix");
	assert.equal(inDirectory("/host/children-extra/AGENTS.md", "/host/children"), false, "a look-alike name is another directory");
	assert.equal(inDirectory("/host/CHILDREN/AGENTS.md", "/host/children", "linux"), false, "on posix a case difference is a different path");
	assert.equal(inDirectory("C:\\Host\\Children\\AGENTS.md", "c:/host/children", "win32"), true, "on windows the separator and the case are both how a file is named");
	assert.equal(inDirectory("/host/CHILDREN/AGENTS.md", "/host/children", "win32"), true);
	// `platform` is a parameter so the other platform's rule can be exercised at all. These are pure cases over the
	// comparison: they say nothing about how either filesystem behaves, which only a run on that platform could.
	const windows = resourceOptions({ ...input(), agentDir: "C:\\host\\children" }, "win32");
	assert.deepEqual(
		windows
			.agentsFilesOverride({ agentsFiles: [{ path: "c:/HOST/children/AGENTS.md", content: "x" }, { path: "c:/host/other/AGENTS.md", content: "y" }] })
			.agentsFiles.map((one) => one.path),
		["c:/host/other/AGENTS.md"],
	);
	const composed = input();
	assert.equal(
		resourceOptions(composed, "linux").agentsFilesOverride({ agentsFiles: [{ path: `${composed.agentDir.toUpperCase()}/AGENTS.md`, content: "x" }] }).agentsFiles.length,
		1,
		"the same case difference on posix is a different file, and it stays",
	);
});

test("a model the child does not have fails the call, and nothing is selected in its place", async () => {
	const { sdk, calls } = fakeSdk([]);
	await assert.rejects(createRuntime(input(), sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "runtime");
		assert.match(error.message, /the model deepseek\/deepseek-chat is not in this child's model configuration/);
		assert.match(error.message, /no other model is selected in its place/);
		return true;
	});
	assert.deepEqual(calls.session, [], "no session is created for a model the child does not have");
});

test("an opened session is checked before it is opened, and nothing about the file changes", () => {
	withDir((dir) => {
		const file = sessionFile(dir, header(), [
			{ type: "message", id: "e1", parentId: null, timestamp: "2026-09-27T10:00:01.000Z", message: { role: "user", content: "do the thing" } },
			{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-09-27T10:00:02.000Z", message: { role: "assistant", content: "done" } },
		]);
		const before = fs.readFileSync(file);
		const { sdk, calls } = fakeSdk();
		const composed = input({ session: { kind: "open", file, sessionId: "abc123", checkpoint: "e2" } });
		assert.deepEqual(preflightSession({ kind: "open", file, sessionId: "abc123", checkpoint: "e2" }, sdk), { entries: 2 });
		openSessionManager(composed, sdk);
		assert.deepEqual(calls.sessionOpen, [{ file, sessionDir: STORAGE.sessionDir, cwdOverride: "/work" }], "the session directory and the working directory are passed as the call named them");
		assert.deepEqual(fs.readFileSync(file), before, "a preflight reads and parses, and writes nothing");
	});
});

test("a session file that is not the one the call expects is refused, and is never opened", () => {
	withDir((dir) => {
		const cases: Array<{ what: string; file: string; sessionId?: string; checkpoint?: string; expect: RegExp }> = [
			{ what: "missing", file: path.join(dir, "gone.jsonl"), expect: /could not be read \(ENOENT\)/ },
			{ what: "empty", file: (() => { const file = path.join(dir, "empty.jsonl"); fs.writeFileSync(file, ""); return file; })(), expect: /is empty/ },
			{ what: "whitespace", file: (() => { const file = path.join(dir, "blank.jsonl"); fs.writeFileSync(file, "\n\n"); return file; })(), expect: /is empty/ },
			// A file of nothing but malformed lines is refused by the framing rule: the parser would skip every line
			// and answer with no entries at all, which is the silent loss the preflight exists to refuse.
			{ what: "malformed only", file: (() => { const file = path.join(dir, "broken.jsonl"); fs.writeFileSync(file, "{not json\nalso not json\n"); return file; })(), expect: /has a line that is not json: line 1/ },
			{ what: "valid jsonl, no header", file: sessionFile(fs.mkdtempSync(path.join(dir, "a-")), { type: "message", id: "e1", parentId: null }), expect: /does not begin with a session header/ },
			{ what: "no version", file: sessionFile(fs.mkdtempSync(path.join(dir, "b-")), header({ version: undefined })), expect: /is version undefined and this Pi writes version 3/ },
			{ what: "older version", file: sessionFile(fs.mkdtempSync(path.join(dir, "c-")), header({ version: 2 })), expect: /is version 2 and this Pi writes version 3/ },
			{ what: "newer version", file: sessionFile(fs.mkdtempSync(path.join(dir, "d-")), header({ version: 4 })), expect: /is version 4 and this Pi writes version 3/ },
			{ what: "another session", file: sessionFile(fs.mkdtempSync(path.join(dir, "e-")), header({ id: "other" })), expect: /holds a different session id than the call expects/ },
			{
				what: "missing checkpoint",
				file: sessionFile(fs.mkdtempSync(path.join(dir, "f-")), header(), [{ type: "message", id: "e1", parentId: null }]),
				checkpoint: "e9",
				expect: /checkpoint this run restores is not an entry/,
			},
		];
		for (const one of cases) {
			const { sdk, calls } = fakeSdk();
			const before = fs.existsSync(one.file) ? fs.readFileSync(one.file) : undefined;
			const session = { kind: "open" as const, file: one.file, sessionId: one.sessionId ?? "abc123", ...(one.checkpoint === undefined ? {} : { checkpoint: one.checkpoint }) };
			assert.throws(() => preflightSession(session, sdk), one.expect, one.what);
			assert.throws(() => openSessionManager(input({ session }), sdk), one.expect, one.what);
			assert.deepEqual(calls.sessionOpen, [], `${one.what}: SessionManager.open would migrate an older file in place, so it is never reached`);
			if (before) assert.deepEqual(fs.readFileSync(one.file), before, `${one.what}: the file is left exactly as it was`);
		}
	});
});

test("a parser that fails outright is a refusal of its own, and the file is left alone", () => {
	withDir((dir) => {
		const file = sessionFile(dir, header());
		const before = fs.readFileSync(file);
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { parse: true });
		assert.throws(() => preflightSession({ kind: "open", file, sessionId: "abc123" }, sdk), /could not be parsed \(the parser itself failed\)/);
		assert.deepEqual(calls.sessionOpen, []);
		assert.deepEqual(fs.readFileSync(file), before);
	});
});

/*
 * The framing preflight. Pi tolerates both of the things refused here: its loader writes the missing final newline
 * into the file itself, and it skips a line it cannot read and opens the session without it. The first is a mutation
 * of a file a fork may still read from, the second is silent loss, and Fusion opens only a transcript it will do
 * neither to. The markers below are content: a refusal names the line and the rule and never what the line held.
 */
test("a transcript Pi would repair or read only part of is refused before it is opened", async () => {
	await withDirAsync(async (dir) => {
		const line = JSON.stringify(header());
		const entry = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-27T10:00:01.000Z" });
		const cases: Array<{ what: string; bytes: string; marker?: string; expect: RegExp }> = [
			{
				what: "a complete last line with no final newline",
				bytes: `${line}\n${entry}`,
				expect: /does not end with a newline: line 2 is unterminated\. Pi would write that newline into the file as it opened it/,
			},
			{
				what: "a partial malformed tail",
				bytes: `${line}\n{"type":"message","id":"e1","text":"marker-tail-secret\n`,
				marker: "marker-tail-secret",
				expect: /has a line that is not json: line 2\. Pi would skip that line and open the session without it/,
			},
			{
				what: "malformed data before a valid header",
				bytes: `{marker-lead-secret\n${line}\n${entry}\n`,
				marker: "marker-lead-secret",
				expect: /has a line that is not json: line 1/,
			},
			{
				what: "a malformed middle line",
				bytes: `${line}\n{marker-middle-secret\n${entry}\n`,
				marker: "marker-middle-secret",
				expect: /has a line that is not json: line 2/,
			},
			{
				what: "a blank line is not the problem, the malformed one after it is",
				bytes: `${line}\n\n{marker-after-blank-secret\n`,
				marker: "marker-after-blank-secret",
				expect: /has a line that is not json: line 3/,
			},
		];
		for (const one of cases) {
			const file = path.join(fs.mkdtempSync(path.join(dir, "frame-")), "session.jsonl");
			fs.writeFileSync(file, one.bytes);
			const before = fs.readFileSync(file);
			const session = { kind: "open" as const, file, sessionId: "abc123" };
			const { sdk, calls } = fakeSdk();
			assert.throws(() => preflightSession(session, sdk), one.expect, one.what);
			await assert.rejects(createRuntime(input({ session }), sdk), (error: Error & { stage?: string }) => {
				assert.equal(error.stage, "session", one.what);
				assert.match(error.message, one.expect, one.what);
				if (one.marker) assert.ok(!error.message.includes(one.marker), `${one.what}: a refusal never repeats the line it refused`);
				assert.ok(!error.message.includes("JSON"), `${one.what}: nor JSON.parse's own words`);
				return true;
			});
			assert.deepEqual(calls.sessionOpen, [], `${one.what}: SessionManager.open is never reached`);
			assert.deepEqual(calls.modelRuntime, [], `${one.what}: and no configuration is loaded`);
			assert.deepEqual(fs.readFileSync(file), before, `${one.what}: the bytes are exactly what they were`);
		}
	});
});

test("a well framed transcript is opened, blank lines and all", async () => {
	await withDirAsync(async (dir) => {
		const file = path.join(dir, "session.jsonl");
		const entry = JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-09-27T10:00:01.000Z" });
		fs.writeFileSync(file, `${JSON.stringify(header())}\n\n${entry}\n\n`);
		const before = fs.readFileSync(file);
		const session = { kind: "open" as const, file, sessionId: "abc123", checkpoint: "e1" };
		const { sdk, calls } = fakeSdk();
		assert.deepEqual(preflightSession(session, sdk), { entries: 1 }, "a blank line is allowed, and is not an entry");
		await createRuntime(input({ session }), sdk);
		assert.deepEqual(calls.sessionOpen, [{ file, sessionDir: STORAGE.sessionDir, cwdOverride: "/work" }]);
		assert.equal(calls.modelRuntime.length, 1, "the session checked out, so the call goes on");
		assert.deepEqual(fs.readFileSync(file), before, "opening a transcript this preflight accepted still rewrites nothing here");
	});
});

test("a session the call may not continue stops the startup before a model runtime is built", async () => {
	await withDirAsync(async (dir) => {
		const old = sessionFile(dir, header({ version: 2 }));
		const before = fs.readFileSync(old);
		for (const session of [
			{ kind: "open" as const, file: old, sessionId: "abc123" },
			{ kind: "open" as const, file: path.join(dir, "gone.jsonl"), sessionId: "abc123" },
			{ kind: "open" as const, file: sessionFile(fs.mkdtempSync(path.join(dir, "other-")), header({ id: "somebody-else" })), sessionId: "abc123" },
		]) {
			const { sdk, calls } = fakeSdk();
			await assert.rejects(createRuntime(input({ session }), sdk), /the recorded session file/);
			assert.deepEqual(calls.sessionOpen, [], "the file is never opened");
			assert.deepEqual(calls.modelRuntime, [], "and no configuration is loaded, no catalog refreshed and no provider reached for a run that cannot start");
		}
		assert.deepEqual(fs.readFileSync(old), before);
	});
});

test("the models file is the user's own where there is one, and this call's absent private path where there is not", () => {
	const shared = input();
	assert.equal(shared.modelsPath, STORAGE.modelsPath);
	const alone = checkInput(bootstrapInput({ role, storage: { ...STORAGE, modelsPath: null }, session: { kind: "new" }, contract: "x" }));
	assert.equal(alone.modelsPath, STORAGE.privateModelsPath, "a user with no models file still gives the child a models path, because a child with none loses the shared catalog store");
	assert.equal(alone.modelsStorePath, STORAGE.modelsStorePath, "and the store stays the shared one either way");
	assert.throws(() => checkInput({ ...shared, modelsPath: null }), /modelsPath must be an absolute path/, "null is not a models path a child may be launched with");
});

test("the model runtime is built with the intended models path, and neither path is created by composing one", async () => {
	await withDirAsync(async (dir) => {
		const host = path.join(dir, "agent");
		const work = path.join(dir, "project");
		fs.mkdirSync(host, { recursive: true });
		fs.mkdirSync(work, { recursive: true });
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		try {
			const composed = checkInput(bootstrapInput({ role, storage, session: { kind: "new" }, contract: "# implement" }));
			assert.equal(composed.modelsPath, storage.privateModelsPath);
			assert.equal(composed.cwd, storage.cwd, "the storage's working directory is the child's");
			const written = JSON.parse(fs.readFileSync(writeCallInput(storage, composed), "utf8")) as BootstrapInput;
			const { sdk, calls } = fakeSdk();
			// The double builds nothing; the point is which paths it was handed, and that nothing made either file.
			await createRuntime(written, sdk);
			assert.deepEqual(calls.modelRuntime, [
				{
					authPath: storage.authPath,
					modelsPath: storage.privateModelsPath,
					modelsStorePath: storage.modelsStorePath,
					allowModelNetwork: true,
				},
			]);
			assert.equal(fs.existsSync(storage.privateModelsPath), false, "a private models path stays absent, which is what keeps the shared catalog store in use");
			assert.equal(fs.existsSync(storage.authPath), false, "and the private auth file is Pi's to create, not this layout's");
		} finally {
			storage.dispose();
		}
	});
});

/*
 * The markers below stand in for what a real SDK text can carry. Pi's configuration error quotes `models.json`, and a
 * `JSON.parse` failure quotes the fragment it choked on, so the file's own contents — an api key among them — can end
 * up inside the error the SDK hands back. Every case here proves that none of it reaches a diagnostic.
 */
const MARKERS = {
	create: 'marker-create-secret "apiKey": "sk-marker-create-0123456789"',
	getError: 'marker-geterror-secret "apiKey": "sk-marker-geterror-0123456789"',
	aggregate: 'Failed to parse models.json: Unexpected token in { "apiKey": "sk-marker-aggregate-0123456789" }\n\nFile: /host/models.json',
	// The other half of the same aggregate: a text about a credential rather than a models file, which carries a
	// token family and the auth file it was read from, and which the refusal has to answer for without repeating any of it.
	credential: 'marker-credential-secret Provider "deepseek": stored credential rejected {"refresh_token": "rt-marker-credential-0123456789"} from /host/auth.json',
	name: "MarkerNamedError",
	code: "EMARKERCODE",
};

const marked = (text: string): Error => {
	const error = new Error(text);
	error.name = MARKERS.name;
	(error as Error & { code?: string }).code = MARKERS.code;
	(error as Error & { cause?: unknown }).cause = new Error(`marker-cause-secret ${text}`);
	return error;
};

/** Every marker that must never appear in a diagnostic, whichever way the model runtime failed. */
const allMarkers = [MARKERS.create, MARKERS.getError, MARKERS.aggregate, MARKERS.credential, MARKERS.name, MARKERS.code, "marker-cause-secret", "sk-marker", "rt-marker"];

/**
 * What the one model refusal says and what it may not, wherever a model error reaches it. `getError()` is a single
 * unstructured text that can be about the models a call was configured with or about the credentials those models are
 * reached through, so the refusal names both and picks neither: the guidance it gives is a list a reader may check
 * rather than a fault it has attributed, and it says a configuration with no models file of its own is supported, so
 * nobody goes looking for a file this composition never required. What stays out is everything the SDK said — its
 * message, its name, its code and its cause — and every path of the call's but the models file the host passed in, the
 * auth file first of all, because that is where a credential lives. Nothing here is a claim about which of them broke.
 */
function pinsModelsRefusal(error: Error & { stage?: string; cause?: unknown }, composed: BootstrapInput, what: string): void {
	assert.equal(error.stage, "models", what);
	assert.equal(error.message, `${MODELS_REFUSED}. Models file in use: ${composed.modelsPath}`, `${what}: the wording is fixed and names the configured models path`);
	assert.match(error.message, /^the child's model or credential configuration could not be used, so the call is refused before any work starts\./, what);
	assert.match(error.message, /A model-configuration error, a credential error, a provider-composition error and a catalog availability error each refuse startup/, what);
	assert.match(error.message, /including one that concerns a provider this call does not use/, what);
	assert.match(error.message, /Check whichever of these this configuration has/, `${what}: the guidance is conditional`);
	assert.match(error.message, /that each model it names is spelled the way its provider names it/, what);
	assert.match(error.message, /that a credential for every provider it composes is configured/, what);
	assert.match(error.message, /that a provider extension a named model comes from loads/, what);
	assert.match(error.message, /that the model catalog is reachable/, what);
	assert.match(error.message, /A configuration with no models file of its own is supported and is not by itself the fault/, what);
	assert.match(error.message, /Correct the model or credential configuration and start the call again/, what);
	assert.match(error.message, /Nothing here says which of those it was, which provider or which line was at fault/, `${what}: and it attributes nothing`);
	assert.equal(error.cause, undefined, `${what}: the SDK's own error is not carried along as a cause`);
	for (const marker of allMarkers) assert.ok(!error.message.includes(marker), `${what} must not repeat ${marker}`);
	for (const at of [composed.authPath, composed.modelsStorePath, composed.sessionDir, composed.agentDir, composed.cwd]) {
		assert.ok(!error.message.includes(at), `${what}: the models file is the one path a model refusal may name, and ${at} is not it`);
	}
	assert.doesNotMatch(error.message, /auth\.json|models-store|credential store|token store/i, `${what}: no auth file and no credential store is named`);
	// Nothing that sends a reader at persistent state with a delete, or at a token family with a copy.
	assert.doesNotMatch(error.message, /\bdelete\b|\bremove\b|\bunlink\b|\brm -|\bre-?create\b|\bcopy\b|\bmove\b/i, `${what}: no destructive or copying advice`);
	assert.doesNotMatch(error.message, /refresh[_ ]?token|access[_ ]?token|api[_ ]?key|bearer/i, `${what}: no credential family is named at all`);
}

test("every way the model runtime can fail is the same refusal, and none of them repeats what the SDK said", async () => {
	const composed = input();
	const expected = `${MODELS_REFUSED}. Models file in use: ${composed.modelsPath}`;
	const ways: Array<{ what: string; fault: Fault }> = [
		{ what: "create rejected", fault: { createRejects: marked(MARKERS.create) } },
		{ what: "getError threw", fault: { getErrorThrows: marked(MARKERS.getError) } },
		{ what: "a configuration error", fault: { getError: MARKERS.aggregate } },
		{ what: "a credential error", fault: { getError: MARKERS.credential } },
		{ what: "a provider composition error", fault: { getError: 'Provider "openrouter": base url is not a url' } },
		{ what: "an availability refresh error", fault: { getError: "Availability refresh: request to the catalog failed" } },
	];
	for (const one of ways) {
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], one.fault);
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string; cause?: unknown }) => {
			assert.equal(error.message, expected, `${one.what}: one refusal, whichever half of the aggregate it was`);
			pinsModelsRefusal(error, composed, one.what);
			return true;
		});
		assert.deepEqual(calls.getModel, [], `${one.what}: no model is looked up once the configuration is in doubt`);
		assert.deepEqual(calls.session, [], `${one.what}: and no session is created`);
	}
});

test("the model refusal is actionable about a models file and a credential alike, and says the same for a models path that is there and one that is not", async () => {
	const composed = input();
	// Two calls whose models path is really there and whose is not: the same sentence both times, naming the path the
	// call was configured with, so an absent models file is never read back as the fault — which is what the wording
	// promises, and what a host with no models file of its own actually gets. What this shows is that wording, not that
	// no stat was made: the bootstrap simply has no such probe in it, which is a source fact rather than one a test here
	// can observe.
	await withDirAsync(async (dir) => {
		const present = path.join(dir, "models.json");
		fs.writeFileSync(present, "{}\n");
		const absent = path.join(dir, "never-written", "models.json");
		const cases = [
			{ what: "a models file that is there", modelsPath: present, there: true },
			{ what: "a models path nothing wrote", modelsPath: absent, there: false },
		];
		for (const one of cases) {
			assert.equal(fs.existsSync(one.modelsPath), one.there, one.what);
			const configured = input({ modelsPath: one.modelsPath });
			for (const text of [MARKERS.aggregate, MARKERS.credential]) {
				const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { getError: text });
				await assert.rejects(createRuntime(configured, sdk), (error: Error & { stage?: string; cause?: unknown }) => {
					pinsModelsRefusal(error, configured, one.what);
					assert.ok(error.message.endsWith(`. Models file in use: ${one.modelsPath}`), `${one.what}: the configured path is the one it names`);
					return true;
				});
				assert.deepEqual(calls.getModel, [], `${one.what}: a configuration in doubt is never looked a model up in`);
			}
		}
	});
});

test("an error is refused even when the exact model asked for is there, because the aggregate says nothing about which", async () => {
	const composed = input();
	const { sdk } = fakeSdk(["deepseek/deepseek-chat"], { getError: 'Provider "anthropic": no credential for marker-unused-provider' });
	await assert.rejects(createRuntime(composed, sdk), (error: Error) => {
		assert.equal(error.message, `${MODELS_REFUSED}. Models file in use: ${composed.modelsPath}`);
		assert.ok(!error.message.includes("marker-unused-provider"), "not even the name of the provider that failed");
		return true;
	});
	const clean = fakeSdk(["deepseek/deepseek-chat"]);
	await createRuntime(composed, clean.sdk);
	assert.deepEqual(clean.calls.getModel, ["deepseek/deepseek-chat"], "the positive control: a runtime that reports nothing goes on to select the model");
});

test("a model runtime that cannot report its errors is an sdk compatibility failure that names the api", async () => {
	const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { getError: "missing" });
	await assert.rejects(createRuntime(input(), sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "sdk");
		assert.match(error.message, /built a model runtime with no getError\(\)/);
		assert.match(error.message, /a call is not started on a configuration that cannot be checked/);
		return true;
	});
	assert.deepEqual(calls.getModel, []);

	for (const answer of [7, {}, null, ["a"]]) {
		const shaped = fakeSdk(["deepseek/deepseek-chat"], { getErrorReturns: answer });
		await assert.rejects(createRuntime(input(), shaped.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "sdk", JSON.stringify(answer));
			assert.equal(
				error.message,
				`${SDK_PACKAGE} answered ModelRuntime.getError() with a value of type ${typeof answer}, and this bootstrap reads a string or undefined; install a version whose getError() reports that shape, because a call is not started on a configuration that cannot be checked`,
				JSON.stringify(answer),
			);
			return true;
		});
		assert.deepEqual(shaped.calls.getModel, [], "a shape this bootstrap cannot read is not a configuration it may run on");
	}
	// undefined is the shape that says nothing is wrong, so it is not a compatibility finding.
	const fine = fakeSdk(["deepseek/deepseek-chat"], { getErrorReturns: undefined });
	await createRuntime(input(), fine.sdk);
	assert.deepEqual(fine.calls.getModel, ["deepseek/deepseek-chat"]);
});

/*
 * What a construction stage's own failure says. Each of the three public constructors reads files — a resource, a
 * context file, a prompt, a settings blob — so a failure one of them throws can quote what it read, markers included.
 * The refusal Fusion reports is its own fixed sentence for that stage, and a refusal this bootstrap composed inside the
 * factory keeps its own stage and its own wording, because the wrapper is for a foreign throw and that is not one.
 */

/** The markers a construction failure carries here, standing in for the file contents such a failure can quote. */
const CONSTRUCTION_MARKERS = {
	settings: 'marker-settings-secret settings document rejected: {"apiKey": "sk-marker-settings-0123456789"}',
	store: 'marker-store-secret transcript /host/sessions/s-1.jsonl line 4: "apiKey": "sk-marker-store-0123456789"',
	services: 'marker-services-secret Extension "/work/.pi/ext.ts": "apiKey": "sk-marker-services-0123456789"',
	session: 'marker-session-secret could not read /work/AGENTS.md: "apiKey": "sk-marker-session-0123456789"',
	runtime: 'marker-runtime-secret cwd /work/gone does not exist: "apiKey": "sk-marker-runtime-0123456789"',
};

/** The resources summary, as the bootstrap composes it for a call configured with these counts. */
const RESOURCES_SUMMARY = (extensions: number, skills: number): string =>
	`the child's resources could not be prepared, so the call is refused before any work starts. The call was configured with ${extensions} extensions and ${skills} skills, each an existing local path this bootstrap checked before it loaded the SDK. Nothing here repeats what the failure said, because loading a resource reads files whose text the failure can quote`;

/** Every marker a construction failure carries here, which no refusal may repeat. */
const constructionMarkers = [...Object.values(CONSTRUCTION_MARKERS), MARKERS.name, MARKERS.code, "marker-cause-secret", "sk-marker"];

test("the settings and the session manager a call is built on are guarded too, and a preflight refusal stays its own", async () => {
	const composed = input();
	const refuses = (error: Error & { stage?: string; cause?: unknown }, stage: string, expect: RegExp, what: string): true => {
		assert.equal(error.stage, stage, what);
		assert.match(error.message, expect, what);
		assert.equal(error.cause, undefined, `${what}: the thrown error is not carried along as a cause`);
		for (const marker of constructionMarkers) assert.ok(!error.message.includes(marker), `${what} must not repeat ${marker}`);
		for (const at of [composed.authPath, composed.modelsStorePath, composed.sessionDir]) assert.ok(!error.message.includes(at), `${what}: no path of the call's in this refusal`);
		return true;
	};

	const settings = fakeSdk(["deepseek/deepseek-chat"], { settingsThrows: marked(CONSTRUCTION_MARKERS.settings) });
	await assert.rejects(createRuntime(composed, settings.sdk), (error: Error & { stage?: string }) => refuses(error, "settings", /^the child's settings could not be built/, "the settings threw"));
	assert.deepEqual(
		[settings.calls.sessionCreate, settings.calls.sessionOpen, settings.calls.modelRuntime],
		[[], [], []],
		"a settings failure refuses before a session is opened and before any configuration is loaded",
	);

	const fresh = fakeSdk(["deepseek/deepseek-chat"], { sessionCreateThrows: marked(CONSTRUCTION_MARKERS.store) });
	await assert.rejects(createRuntime(composed, fresh.sdk), (error: Error & { stage?: string }) => refuses(error, "session", /^the recorded session could not be opened/, "SessionManager.create threw"));
	assert.equal(fresh.calls.settings.length, 1, "the settings were built first, which is the order the runtime composes them in");
	assert.deepEqual(fresh.calls.modelRuntime, [], "and a session that could not be made refuses before a configuration is loaded");

	await withDirAsync(async (dir) => {
		// A transcript that really checks out, so the preflight passes and `SessionManager.open` is what fails.
		const file = sessionFile(dir, header(), [{ type: "message", id: "e1", parentId: null, timestamp: "2026-09-27T10:00:01.000Z" }]);
		const before = fs.readFileSync(file);
		const session = { kind: "open" as const, file, sessionId: "abc123", checkpoint: "e1" };
		const opened = fakeSdk(["deepseek/deepseek-chat"], { sessionOpenThrows: marked(CONSTRUCTION_MARKERS.store) });
		// The refusal itself is what the claim about it is checked against: caught here rather than only matched, so
		// the transcript path this call really passed can be looked for in the message it produced.
		let refusal: Error | undefined;
		await assert.rejects(createRuntime(input({ session }), opened.sdk), (error: Error & { stage?: string }) => {
			refusal = error;
			return refuses(error, "session", /^the recorded session could not be opened/, "SessionManager.open threw");
		});
		assert.equal(opened.calls.sessionOpen.length, 1, "the preflight accepted the file, so the constructor was reached and it is what failed");
		assert.deepEqual(opened.calls.modelRuntime, []);
		assert.ok(refusal, "the open failure produced a refusal to read");
		assert.equal(String(refusal?.message).includes(file), false, `the transcript this call named is not in the refusal: ${refusal?.message}`);
		assert.equal(String(refusal?.message).includes(path.basename(file)), false, "not by its full path and not by its name either");
		assert.equal(String(refusal?.message).includes(dir), false, "and not by the directory it lives in");
		// The same guard, with the preflight refusing first: its own stage and its own wording reach the host unchanged,
		// and the constructor that would have migrated the file is never called.
		const checkpoint = fakeSdk(["deepseek/deepseek-chat"], { sessionOpenThrows: marked(CONSTRUCTION_MARKERS.store) });
		await assert.rejects(createRuntime(input({ session: { ...session, checkpoint: "e9" } }), checkpoint.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "session");
			assert.match(error.message, /^the checkpoint this run restores is not an entry of the recorded session file/, "a refusal this bootstrap composed is not replaced by the stage summary");
			return true;
		});
		assert.deepEqual(checkpoint.calls.sessionOpen, [], "and the preflight's refusal never reaches the constructor");
		assert.deepEqual(fs.readFileSync(file), before, "the file is left exactly as it was either way");
	});
});

test("each construction failure is its stage's own fixed refusal, and nothing the SDK threw reaches it", async () => {
	const composed = input();
	const ways: Array<{ what: string; fault: Fault; stage: string; expect: RegExp }> = [
		{ what: "the services threw", fault: { servicesThrows: marked(CONSTRUCTION_MARKERS.services) }, stage: "resources", expect: /^the child's resources could not be prepared/ },
		{ what: "the session threw", fault: { sessionThrows: marked(CONSTRUCTION_MARKERS.session) }, stage: "runtime", expect: /^the child's session could not be constructed/ },
		{ what: "the runtime threw", fault: { runtimeThrows: marked(CONSTRUCTION_MARKERS.runtime) }, stage: "runtime", expect: /^the child's runtime could not be constructed/ },
	];
	for (const one of ways) {
		const { sdk } = fakeSdk(["deepseek/deepseek-chat"], one.fault);
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string; cause?: unknown }) => {
			assert.equal(error.stage, one.stage, one.what);
			assert.match(error.message, one.expect, one.what);
			assert.equal(error.cause, undefined, `${one.what}: the thrown error is not carried along as a cause`);
			for (const marker of constructionMarkers) assert.ok(!error.message.includes(marker), `${one.what} must not repeat ${marker}`);
			for (const at of [composed.cwd, composed.agentDir, composed.authPath, composed.modelsStorePath]) assert.ok(!error.message.includes(at), `${one.what}: no path of the call's in a construction refusal`);
			return true;
		});
	}
	// The resources summary names the counts the host composed, which the host already knows, and no path at all.
	await withDirAsync(async (root) => {
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(file, "export default () => {};\n");
		const dir = path.join(root, "skill");
		fs.mkdirSync(dir);
		const resourced = checkInput({ ...input(), extensions: [file], skills: [dir] });
		const { sdk } = fakeSdk(["deepseek/deepseek-chat"], { servicesThrows: marked(CONSTRUCTION_MARKERS.services) });
		await assert.rejects(createRuntime(resourced, sdk), (error: Error) => {
			assert.equal(error.message, RESOURCES_SUMMARY(1, 1));
			for (const at of [file, dir, root]) assert.ok(!error.message.includes(at), "a count, and never a path");
			return true;
		});
	});
	// A refusal composed inside the factory is the answer the host reads, stage and wording intact.
	const missingModel = fakeSdk([]);
	await assert.rejects(createRuntime(composed, missingModel.sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "runtime");
		assert.match(error.message, /^the model deepseek\/deepseek-chat is not in this child's model configuration/, "a refusal from inside the factory is not replaced by the runtime summary");
		return true;
	});
	// The same for a refusal raised from inside the prompt override, which the loader calls while it reloads: it runs
	// inside the call the resources summary wraps, and it is still its own compatibility refusal rather than that summary.
	const fromOverride = fakeSdk(["deepseek/deepseek-chat"], { loader: { agentsFiles: { agentsFiles: [{ content: "no path" }] } } });
	await assert.rejects(createRuntime(composed, fromOverride.sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "sdk");
		assert.match(error.message, /called agentsFilesOverride with something other than a list of files that name their own paths/);
		return true;
	});
	const throughOverride = fakeSdk(["deepseek/deepseek-chat"], { loader: { agentsFiles: { agentsFiles: [{ path: "/work/AGENTS.md", content: "# the project's own" }] } } });
	await createRuntime(composed, throughOverride.sdk);
	assert.deepEqual(throughOverride.calls.getModel, ["deepseek/deepseek-chat"], "a list the override reads leaves the call exactly as it was");
	const reportedError = fakeSdk(["deepseek/deepseek-chat"], { serviceDiagnostics: [{ type: "error", message: "marker-service-secret" }] });
	await assert.rejects(createRuntime(composed, reportedError.sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "resources");
		assert.match(error.message, /reported 1 of their 1 diagnostics as errors/);
		return true;
	});
});

test("a provider error the services raised refuses the call before the exact model is looked up", async () => {
	const composed = input();
	const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { getErrorAfterServices: MARKERS.aggregate });
	await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string; cause?: unknown }) => {
		assert.equal(error.message, `${MODELS_REFUSED}. Models file in use: ${composed.modelsPath}`, "the same fixed refusal, whichever side of the services it was reported on");
		pinsModelsRefusal(error, composed, "a provider error reported after the services");
		return true;
	});
	assert.equal(calls.services.length, 1, "the services were built, which is what registers an extension's providers and refreshes the catalog");
	assert.deepEqual(calls.getModel, [], "and the error refuses the call before the model is looked up, though that exact model is there");
	assert.deepEqual(calls.session, [], "so no session is created either");
	// A credential the runtime reports after the services is the same refusal again: this path has no more to say
	// about which half of the aggregate it was than the early one does.
	const credential = fakeSdk(["deepseek/deepseek-chat"], { getErrorAfterServices: MARKERS.credential });
	await assert.rejects(createRuntime(composed, credential.sdk), (error: Error & { stage?: string; cause?: unknown }) => {
		pinsModelsRefusal(error, composed, "a credential error reported after the services");
		return true;
	});
	assert.equal(credential.calls.services.length, 1);
	assert.deepEqual(credential.calls.getModel, [], "and it refuses before the model is looked up, exactly as the other half does");
	assert.deepEqual(credential.calls.session, []);
	// The control: the same runtime with nothing reported after the services goes on and selects the model.
	const clean = fakeSdk(["deepseek/deepseek-chat"]);
	await createRuntime(composed, clean.sdk);
	assert.deepEqual(clean.calls.getModel, ["deepseek/deepseek-chat"]);
});

test("what the loader reports about this call's resources is read, and a failure refuses the call by path or by count", async () => {
	const composed = input();
	const markers = ["marker-extension-secret", "marker-skill-secret", "marker-collision-secret", "marker-service-secret"];
	const refusals: Array<{ what: string; fault: Fault; expect: RegExp; names?: string[] }> = [
		{
			what: "an extension that failed to load",
			fault: { loader: { extensions: [{ path: "/work/ext.ts", error: "marker-extension-secret at line 3" }] } },
			expect: /^1 of the 0 extensions this call named failed to load/,
			names: ["/work/ext.ts"],
		},
		{
			what: "two extensions, one of which names no path",
			fault: { loader: { extensions: [{ path: "/work/ext.ts", error: "marker-extension-secret" }, { error: "marker-extension-secret" }] } },
			expect: /^2 of the 0 extensions this call named failed to load/,
			names: ["/work/ext.ts"],
		},
		{
			what: "extensions that failed and name no path at all",
			fault: { loader: { extensions: [{ error: "marker-extension-secret" }] } },
			expect: /failed to load.*: 1 that name no path/s,
		},
		{
			what: "a skill that failed to load",
			fault: { loader: { skills: [{ type: "error", message: "marker-skill-secret", path: "/work/skill" }] } },
			expect: /^the 0 skills this call named were reported with 1 failing diagnostics/,
			names: ["/work/skill"],
		},
		{
			what: "a skill error with no path",
			fault: { loader: { skills: [{ type: "error", message: "marker-skill-secret" }] } },
			expect: /failing diagnostics.*: 1 that name no path/s,
		},
		{
			what: "two skills of one name",
			fault: {
				loader: {
					skills: [{ type: "collision", message: "marker-collision-secret", collision: { resourceType: "skill", name: "review", winnerPath: "/work/a/SKILL.md", loserPath: "/work/b/SKILL.md" } }],
				},
			},
			expect: /one of two skills of the same name/,
			names: ["/work/a/SKILL.md", "/work/b/SKILL.md"],
		},
		{
			what: "a collision that names no path",
			fault: { loader: { skills: [{ type: "collision", message: "marker-collision-secret" }] } },
			expect: /failing diagnostics.*: 1 that name no path/s,
		},
		{
			what: "a service that reported an error",
			fault: { serviceDiagnostics: [{ type: "info", message: "started" }, { type: "error", message: "marker-service-secret Extension \"/work/.pi/p.ts\" error" }] },
			expect: /^the services this child would run on reported 1 of their 2 diagnostics as errors/,
		},
	];
	for (const one of refusals) {
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], one.fault);
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "resources", one.what);
			assert.match(error.message, one.expect, one.what);
			for (const name of one.names ?? []) assert.ok(error.message.includes(name), `${one.what} should name ${name}: ${error.message}`);
			for (const marker of markers) assert.ok(!error.message.includes(marker), `${one.what} must not repeat ${marker}`);
			return true;
		});
		assert.deepEqual(calls.getModel, [], `${one.what}: a resource that failed refuses the call before a model is looked up`);
		assert.deepEqual(calls.session, [], `${one.what}: and no session is created`);
	}
	// A warning is not a refusal: the loader says something about a skill and the call goes on with it.
	const warned = fakeSdk(["deepseek/deepseek-chat"], {
		loader: { skills: [{ type: "warning", message: "a skill has no description", path: "/work/skill" }] },
		serviceDiagnostics: [{ type: "warning", message: "something worth saying" }, { type: "info", message: "and something else" }],
	});
	await createRuntime(composed, warned.sdk);
	assert.deepEqual(warned.calls.getModel, ["deepseek/deepseek-chat"], "a warning leaves the call exactly as it was");
	assert.equal(warned.calls.session.length, 1);
});

test("a resource entry that loaded nothing refuses, and a resource nobody named refuses too", async () => {
	await withDirAsync(async (root) => {
		const extension = path.join(root, "ext.ts");
		fs.writeFileSync(extension, "export default () => {};\n");
		const skills = path.join(root, "skills");
		fs.mkdirSync(skills);
		fs.writeFileSync(path.join(skills, "SKILL.md"), "# skill\n");
		const sibling = path.join(root, "skills-extra");
		fs.mkdirSync(sibling);
		const composed = checkInput({ ...input(), extensions: [extension], skills: [skills] });

		// An entry that loaded nothing: the loader answers a skill file it will not read, an empty directory and a local
		// extension it skipped with a warning or with silence, and each of them is a child running with less than its
		// role asked for. The control below is the same call with the loader reporting what it was given.
		const nothing = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { extensions: [], skills: [] } } });
		await assert.rejects(createRuntime(composed, nothing.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "resources");
			assert.match(error.message, /^the call input's extensions\[0\] loaded nothing: the child loaded 0 extensions/);
			assert.match(error.message, /this loader reports as a warning or as nothing at all/);
			assert.ok(!error.message.includes(extension), "an entry that loaded nothing is named by its index, the way the input rules name one");
			return true;
		});
		assert.deepEqual(nothing.calls.getModel, [], "and it refuses before a model is looked up");
		const noSkill = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { skills: [] } } });
		await assert.rejects(createRuntime(composed, noSkill.sdk), /^StartupError: the call input's skills\[0\] loaded nothing: the child loaded 0 skills/);

		// A loaded resource under a sibling whose name only starts the same way is not that entry's, so the entry loaded
		// nothing and the loaded skill is one nobody named. The entry is what fails first, because it is the more useful
		// thing to say.
		const prefixed = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { skills: [{ name: "extra", filePath: path.join(sibling, "SKILL.md") }] } } });
		await assert.rejects(createRuntime(composed, prefixed.sdk), /skills\[0\] loaded nothing: the child loaded 1 skills/);

		// A skill the loader found deep under the entry is that entry's: coverage is the entry or anything beneath it.
		const nested = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { skills: [{ name: "deep", filePath: path.join(skills, "nested", "deeper", "SKILL.md") }] } } });
		await createRuntime(composed, nested.sdk);
		assert.deepEqual(nested.calls.getModel, ["deepseek/deepseek-chat"], "a nested skill covers the entry it lies under");

		// A package an explicit extension path resolved to can bring its own bundled skill. One that lies under no
		// skills entry is a resource nobody selected and is refused, named by the path the loader reported.
		const bundled = path.join(root, "package", "skills", "bundled", "SKILL.md");
		fs.mkdirSync(path.dirname(bundled), { recursive: true });
		fs.writeFileSync(bundled, "# bundled\n");
		const undeclared = fakeSdk(["deepseek/deepseek-chat"], {
			loader: { loaded: { skills: [{ name: "own", filePath: path.join(skills, "SKILL.md") }, { name: "bundled", filePath: bundled }] } },
		});
		await assert.rejects(createRuntime(composed, undeclared.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "resources");
			assert.match(error.message, /^the child loaded 1 skills this call did not name, which a package an explicit path resolved to can bring with it/);
			assert.ok(error.message.includes(bundled), "the one thing that says which resource it was is the path the loader reported");
			assert.ok(!error.message.includes(path.join(skills, "SKILL.md")), "and a skill that was named is not named here");
			return true;
		});
		// The same skill, with the directory that holds it named as a skills entry of its own, is selected and passes.
		const selected = checkInput({ ...input(), extensions: [extension], skills: [skills, path.join(root, "package", "skills")] });
		const admitted = fakeSdk(["deepseek/deepseek-chat"], {
			loader: { loaded: { skills: [{ name: "own", filePath: path.join(skills, "SKILL.md") }, { name: "bundled", filePath: bundled }] } },
		});
		await createRuntime(selected, admitted.sdk);
		assert.deepEqual(admitted.calls.getModel, ["deepseek/deepseek-chat"], "a bundled skill this call selected by its own entry is the call's own");

		// A warning on a resource that did load stays a warning: the loader says something and the call goes on.
		const warned = fakeSdk(["deepseek/deepseek-chat"], { loader: { skills: [{ type: "warning", message: "this skill has no description", path: path.join(skills, "SKILL.md") }] } });
		await createRuntime(composed, warned.sdk);
		assert.deepEqual(warned.calls.getModel, ["deepseek/deepseek-chat"], "a warning is nonfatal when the coverage holds");
	});
});

test("an extension with no filesystem path of its own is refused, whatever an explicit entry would cover", async () => {
	// This composition passes one factory, its own control extension, so any other extension built from a factory is
	// one nobody asked for. It is refused for reporting no absolute path rather than for how that name is spelled —
	// and refused before the coverage comparison, so an explicit entry of the filesystem root cannot make a lexical
	// answer accept it. Each case is that spelling beside the control extension the loader really did load.
	const root = process.platform === "win32" ? path.parse(process.cwd()).root : "/";
	for (const spelling of ["<inline>", "<inline:bridge>", "<sdk:ask_orchestrator>", "not-a-path"]) {
		const inline = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { extensions: [{ path: spelling, resolvedPath: spelling }] } } });
		await assert.rejects(createRuntime(checkInput({ ...input(), extensions: [root] }), inline.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "resources", spelling);
			assert.match(error.message, /^the child loaded an extension that reports no absolute filesystem path of its own/, spelling);
			assert.match(error.message, /the one factory this call passes is this host's own control extension: 2 extensions loaded against the 1 this call named/, spelling);
			return true;
		});
		assert.deepEqual(inline.calls.getModel, [], `${spelling}: and it refuses before a model is looked up`);
	}
});

test("exactly one loaded extension may be this host's own control extension, and it has to be there", async () => {
	await withDirAsync(async (root) => {
		// The one entry the loader reports for the factory this composition passes: `<inline:pi-fusion>` as both its
		// path and its resolved path. A call's own extension paths are named beside it and are unaffected by it.
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(file, "export default () => {};\n");
		const composed = checkInput({ ...input(), extensions: [file] });
		const fine = fakeSdk();
		await createRuntime(composed, fine.sdk);
		assert.deepEqual(fine.calls.getModel, ["deepseek/deepseek-chat"], "the owned entry is admitted and the named path still covers its own");
		const ownEntry = { path: CONTROL_EXTENSION_PATH, resolvedPath: CONTROL_EXTENSION_PATH };
		const cases: Array<{ what: string; control: unknown[]; expect: RegExp }> = [
			{ what: "none of it", control: [], expect: /^the child loaded 0 extensions reporting this host's own control extension at <inline:pi-fusion>/ },
			{ what: "two of it", control: [ownEntry, { ...ownEntry }], expect: /^the child loaded 2 extensions reporting this host's own control extension at <inline:pi-fusion>/ },
			{ what: "a resolved path of its own", control: [{ path: CONTROL_EXTENSION_PATH, resolvedPath: path.join(root, "control.ts") }], expect: /reports <inline:pi-fusion> as one of its two paths and something else as the other/ },
			{ what: "a name of its own", control: [{ path: path.join(root, "control.ts"), resolvedPath: CONTROL_EXTENSION_PATH }], expect: /reports <inline:pi-fusion> as one of its two paths and something else as the other/ },
		];
		for (const one of cases) {
			const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { loader: { control: one.control } });
			await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string }) => {
				assert.equal(error.stage, "resources", one.what);
				assert.match(error.message, one.expect, one.what);
				return true;
			});
			assert.deepEqual(calls.getModel, [], `${one.what}: refused before a model is looked up`);
			assert.deepEqual(calls.session, [], `${one.what}: and before a session is created`);
		}
	});
});

test("a loaded prompt template or theme is refused, because a role on this backend selects none", async () => {
	const composed = input();
	const cases: Array<{ what: string; fault: Fault; expect: RegExp; names?: string[] }> = [
		{
			what: "a bundled prompt template",
			fault: { loader: { loaded: { prompts: [{ name: "review", filePath: "/work/package/prompts/review.md" }] } } },
			expect: /^the child loaded 1 prompts, and a role on this backend selects none/,
			names: ["/work/package/prompts/review.md"],
		},
		{
			what: "two prompt templates",
			fault: { loader: { loaded: { prompts: [{ name: "a", filePath: "/work/a.md" }, { name: "b" }] } } },
			expect: /^the child loaded 2 prompts, and a role on this backend selects none/,
			names: ["/work/a.md"],
		},
		{
			what: "a bundled theme",
			fault: { loader: { loaded: { themes: [{ name: "midnight", sourcePath: "/work/package/themes/midnight.json" }] } } },
			expect: /^the child loaded 1 themes, and a role on this backend selects none/,
			names: ["/work/package/themes/midnight.json"],
		},
		{
			what: "a theme that names no path",
			fault: { loader: { loaded: { themes: [{ name: "builtin" }] } } },
			expect: /^the child loaded 1 themes, and a role on this backend selects none: 1 that name no path/,
		},
	];
	for (const one of cases) {
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], one.fault);
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "resources", one.what);
			assert.match(error.message, one.expect, one.what);
			for (const name of one.names ?? []) assert.ok(error.message.includes(name), `${one.what} should name ${name}`);
			assert.match(error.message, /a resource nobody selected is refused rather than run with/, one.what);
			return true;
		});
		assert.deepEqual(calls.getModel, [], `${one.what}: refused before a model is looked up`);
		assert.deepEqual(calls.session, [], `${one.what}: and before a session is created`);
	}
});

test("a child that loaded this host's own extension is refused, and that is what the refusal says", async () => {
	await withDirAsync(async (root) => {
		const hostExtension = path.join(repoRoot, "extensions", "fusion.ts");
		const extensionsDir = path.join(repoRoot, "extensions");
		assert.ok(fs.existsSync(hostExtension), "this host's own extension is where the bootstrap resolves it from");
		const selfRefusal = /^the child loaded this host's own extension as one of its resources/;
		const ways: Array<{ what: string; named: string; loaded: string }> = [
			{ what: "named directly", named: hostExtension, loaded: hostExtension },
			{ what: "found in the directory that holds it", named: extensionsDir, loaded: hostExtension },
		];
		if (process.platform !== "win32") {
			const link = path.join(root, "aliased-fusion.ts");
			fs.symlinkSync(hostExtension, link);
			ways.push({ what: "reached through a link", named: link, loaded: link });
		}
		for (const one of ways) {
			const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { extensions: [{ path: one.loaded, resolvedPath: one.loaded }] } } });
			await assert.rejects(createRuntime(checkInput({ ...input(), extensions: [one.named] }), sdk), (error: Error & { stage?: string }) => {
				assert.equal(error.stage, "resources", one.what);
				assert.match(error.message, selfRefusal, one.what);
				assert.ok(error.message.includes(hostExtension), `${one.what}: the installed path this host knows is safe to name`);
				assert.match(error.message, /This says nothing about what any other resource imports/, one.what);
				return true;
			});
			assert.deepEqual(calls.getModel, [], `${one.what}: refused before a model is looked up`);
		}
		// The reason comes before the loader's own errors, so a directory holding this module beside a module that
		// failed to load says the useful thing rather than the incidental one.
		const alsoBroken = fakeSdk(["deepseek/deepseek-chat"], {
			loader: { loaded: { extensions: [{ path: hostExtension, resolvedPath: hostExtension }] }, extensions: [{ path: path.join(extensionsDir, "cards.ts"), error: "marker-extension-secret" }] },
		});
		await assert.rejects(createRuntime(checkInput({ ...input(), extensions: [extensionsDir] }), alsoBroken.sdk), (error: Error) => {
			assert.match(error.message, selfRefusal, "the self-inclusion reason is the one reported");
			assert.ok(!error.message.includes("marker-extension-secret"));
			return true;
		});
		// An ordinary module of this repository is not this host's extension, and is not refused for being near it.
		const sibling = path.join(repoRoot, "extensions", "review.ts");
		const fine = fakeSdk(["deepseek/deepseek-chat"], { loader: { loaded: { extensions: [{ path: sibling, resolvedPath: sibling }] } } });
		await createRuntime(checkInput({ ...input(), extensions: [sibling] }), fine.sdk);
		assert.deepEqual(fine.calls.getModel, ["deepseek/deepseek-chat"], "a sibling module is an ordinary resource");
	});
});

test("the coverage comparison is lexical and segment exact, and says nothing about a filesystem", () => {
	assert.equal(withinDirectory("/root/skills/SKILL.md", "/root/skills"), true);
	assert.equal(withinDirectory("/root/skills", "/root/skills"), true, "an entry covers itself, which is what a file entry needs");
	assert.equal(withinDirectory("/root/skills/a/b/SKILL.md", "/root/skills"), true);
	assert.equal(withinDirectory("/root/skills-extra/SKILL.md", "/root/skills"), false, "a sibling whose name starts the same way is outside");
	assert.equal(withinDirectory("/root/SKILL.md", "/root/skills"), false);
	assert.equal(withinDirectory("/root", "/root/skills"), false, "the parent of an entry is not beneath it");
	assert.equal(withinDirectory("/root/x", "/"), true, "a root covers everything under it");
	assert.equal(withinDirectory("/", "/"), true);
	assert.equal(withinDirectory("/root/skills/", "/root/skills"), true, "a trailing separator is the same directory");
	assert.equal(withinDirectory("relative/SKILL.md", "/root"), false, "a path that is not absolute is covered by nothing");
	assert.equal(withinDirectory("/root/SKILL.md", "relative"), false);
	// Windows: its own separators and its own casing, and a different drive is outside whatever the rest of the path
	// says. Pure cases over the comparison, exercised through the platform parameter; they say nothing about how a
	// Windows filesystem behaves, which only a run on Windows could.
	assert.equal(withinDirectory("c:\\Root\\Skills\\SKILL.md", "C:\\root\\skills", "win32"), true);
	assert.equal(withinDirectory("C:/root/skills/SKILL.md", "C:\\root\\skills", "win32"), true);
	assert.equal(withinDirectory("D:\\root\\skills\\SKILL.md", "C:\\root\\skills", "win32"), false, "another drive is outside");
	assert.equal(withinDirectory("C:\\root\\skills-extra\\SKILL.md", "C:\\root\\skills", "win32"), false);
	assert.equal(withinDirectory("/root/SKILLS/SKILL.md", "/root/skills", "linux"), false, "on posix a case difference is a different path");
});

test("a model error the services raised is reported before a resource error they also raised", async () => {
	// Both are true at once, and which one the host is told about matters: the model refusal is the credential-safe one
	// and it has to be the answer, before a model is looked up and before anything is said about a resource.
	const composed = input();
	const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], {
		getErrorAfterServices: MARKERS.aggregate,
		loader: { loaded: { prompts: [{ name: "review", filePath: "/work/p.md" }] }, extensions: [{ path: "/work/ext.ts", error: "marker-extension-secret" }] },
		serviceDiagnostics: [{ type: "error", message: "marker-service-secret" }],
	});
	await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "models", "the model configuration is what the call is refused for");
		assert.equal(error.message, `${MODELS_REFUSED}. Models file in use: ${composed.modelsPath}`);
		assert.ok(!error.message.includes("/work/p.md"), "and nothing of the resource findings is mixed into it");
		return true;
	});
	assert.deepEqual(calls.getModel, [], "no model is looked up");
	assert.deepEqual(calls.session, [], "and no session is created");
});

test("a loader this bootstrap cannot read the report of is an sdk compatibility refusal, never an empty result", async () => {
	const composed = input();
	const shapes: Array<{ what: string; fault: Fault; expect: RegExp }> = [
		{ what: "no resource loader at all", fault: { loader: { without: "resourceLoader" } }, expect: /createAgentSessionServices\(\) with something other than services whose resourceLoader provides getExtensions\(\), getSkills\(\), getPrompts\(\), getThemes\(\)/ },
		{ what: "no getExtensions", fault: { loader: { without: "getExtensions" } }, expect: /resourceLoader provides getExtensions\(\), getSkills\(\), getPrompts\(\), getThemes\(\)/ },
		{ what: "no getSkills", fault: { loader: { without: "getSkills" } }, expect: /resourceLoader provides getExtensions\(\), getSkills\(\), getPrompts\(\), getThemes\(\)/ },
		{ what: "no getPrompts", fault: { loader: { without: "getPrompts" } }, expect: /resourceLoader provides getExtensions\(\), getSkills\(\), getPrompts\(\), getThemes\(\)/ },
		{ what: "no getThemes", fault: { loader: { without: "getThemes" } }, expect: /resourceLoader provides getExtensions\(\), getSkills\(\), getPrompts\(\), getThemes\(\)/ },
		{ what: "extensions that are not a list", fault: { loader: { loaded: { extensions: "one" } } }, expect: /getExtensions\(\) with something other than a result whose extensions is a list of loaded extensions/ },
		{ what: "a loaded extension naming no path", fault: { loader: { loaded: { extensions: [{ hidden: false }] } } }, expect: /getExtensions\(\) with something other than a result whose extensions each report their own resolvedPath or path/ },
		{ what: "skills that are not a list", fault: { loader: { loaded: { skills: "one" } } }, expect: /getSkills\(\) with something other than a result whose skills is a list of loaded skills naming their own filePath/ },
		{ what: "a loaded skill naming no file", fault: { loader: { loaded: { skills: [{ name: "review" }] } } }, expect: /getSkills\(\) with something other than a result whose skills is a list of loaded skills naming their own filePath/ },
		{ what: "prompts that are not a list", fault: { loader: { loaded: { prompts: "one" } } }, expect: /getPrompts\(\) with something other than a result whose prompts is a list of loaded prompts/ },
		{ what: "themes that are not a list", fault: { loader: { loaded: { themes: "one" } } }, expect: /getThemes\(\) with something other than a result whose themes is a list of loaded themes/ },
		{ what: "errors that are not a list", fault: { loader: { extensions: "one failed" } }, expect: /resourceLoader\.getExtensions\(\) with something other than a result whose errors is a list of reported failures/ },
		{ what: "errors that are not records", fault: { loader: { extensions: ["/work/ext.ts"] } }, expect: /getExtensions\(\) with something other than a result whose errors is a list/ },
		{ what: "diagnostics that are not a list", fault: { loader: { skills: { type: "error" } } }, expect: /resourceLoader\.getSkills\(\) with something other than a result whose diagnostics is a list of warning, error, collision entries/ },
		{ what: "a diagnostic kind this bootstrap does not read", fault: { loader: { skills: [{ type: "note", message: "m" }] } }, expect: /getSkills\(\) with something other than a result whose diagnostics is a list of warning, error, collision entries/ },
		{ what: "service diagnostics that are not a list", fault: { serviceDiagnostics: "fine" }, expect: /createAgentSessionServices\(\) with something other than services whose diagnostics is a list of info, warning, error entries/ },
		{ what: "a service diagnostic with no type", fault: { serviceDiagnostics: [{ message: "m" }] }, expect: /services whose diagnostics is a list of info, warning, error entries/ },
		{ what: "a service diagnostic kind this bootstrap does not read", fault: { serviceDiagnostics: [{ type: "fatal", message: "m" }] }, expect: /services whose diagnostics is a list of info, warning, error entries/ },
	];
	for (const one of shapes) {
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], one.fault);
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "sdk", one.what);
			assert.match(error.message, one.expect, one.what);
			assert.match(error.message, /a call is not started on a public api whose answer this bootstrap cannot read/, one.what);
			return true;
		});
		assert.deepEqual(calls.getModel, [], `${one.what}: a report that cannot be read is not a clean one`);
	}
});

test("a resource getter that throws is an sdk compatibility refusal, not the stage that happened to be running", async () => {
	// A getter that throws says the same thing as one that answers a shape this bootstrap cannot read: the loader
	// cannot say what it loaded, so the call is not started. Reporting it as the construction summary of whichever
	// stage was running would name the stage and not the api, so each one is named here instead.
	const composed = input();
	for (const getter of ["getExtensions", "getSkills", "getPrompts", "getThemes"] as const) {
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { loader: { throws: { getter, error: marked(CONSTRUCTION_MARKERS.services) } } });
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string; cause?: unknown }) => {
			assert.equal(error.stage, "sdk", getter);
			assert.match(error.message, new RegExp(`answered resourceLoader\\.${getter}\\(\\) with something other than an answer at all rather than a failure of its own`), getter);
			assert.match(error.message, /a call is not started on a public api whose answer this bootstrap cannot read/, getter);
			assert.equal(error.cause, undefined, `${getter}: the thrown error is not carried along as a cause`);
			for (const marker of constructionMarkers) assert.ok(!error.message.includes(marker), `${getter} must not repeat ${marker}`);
			return true;
		});
		assert.deepEqual(calls.getModel, [], `${getter}: refused before a model is looked up`);
		assert.deepEqual(calls.session, [], `${getter}: and before a session is created`);
	}
});

test("the session constructor's own append happens before the tool check, and a refusal leaves it where it is", async () => {
	// What this models, and all it models: 0.85.1's `createAgentSessionFromServices` appends a `thinking_level_change`
	// to a branch that carries messages and has none, and it does that before this bootstrap has checked the session's
	// tools. The fake is scripted from reading that constructor and records the order of the two, which is a claim
	// about this composition's own ordering. It is not evidence about what a real child leaves on disk: no real session
	// is opened here, nothing is appended to a file, and the bridge of task 7 owns that measurement.
	const composed = input();
	const bridged = checkInput({ ...composed, tools: [...composed.tools, "ask_orchestrator"] });
	const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { appendsOnConstruct: "thinking_level_change", tools: { late: ["ask_orchestrator"] } });
	await assert.rejects(createRuntime(bridged, sdk), /^StartupError: the child's session does not have the tool ask_orchestrator/);
	assert.deepEqual(calls.appended, ["thinking_level_change"], "the append had already happened when the tool check refused the call");
	// And nothing here undoes it: no transcript surgery, no navigation, no recovery. A call that starts has the same
	// entry appended by the same constructor, which is the point — the entry is the SDK's, either way.
	const started = fakeSdk(["deepseek/deepseek-chat"], { appendsOnConstruct: "thinking_level_change" });
	await createRuntime(composed, started.sdk);
	assert.deepEqual(started.calls.appended, ["thinking_level_change"]);
});

test("every tool the role runs with has to be on the session the moment it exists", async () => {
	const composed = input();
	const { sdk, calls } = fakeSdk();
	const started = (await createRuntime(composed, sdk)) as { created: { session: { getActiveToolNames(): string[]; registerLate(): void } } };
	assert.deepEqual(calls.session[0].tools, composed.tools, "the role's list goes in as the allow list the session is built with");
	assert.deepEqual(started.created.session.getActiveToolNames(), composed.tools);
	assert.equal(started.created.session.getActiveToolNames().includes("powershell"), false, "a builtin outside the role's list is in the registry and is not active: the allow list is what the composition passes");
	// A tool an extension registers in its factory body is in the registry before the session exists, so a role that
	// names it starts; the same name registered afterwards, in a hook that runs inside runRpcMode, is not there yet.
	const bridged = checkInput({ ...composed, tools: [...composed.tools, "ask_orchestrator"] });
	const factory = fakeSdk(["deepseek/deepseek-chat"], { tools: { registry: ["ask_orchestrator"] } });
	const withBridge = (await createRuntime(bridged, factory.sdk)) as { created: { session: { getActiveToolNames(): string[] } } };
	assert.deepEqual(withBridge.created.session.getActiveToolNames(), bridged.tools, "a factory registration is active under the role's list");
	const late = fakeSdk(["deepseek/deepseek-chat"], { tools: { late: ["ask_orchestrator"] } });
	await assert.rejects(createRuntime(bridged, late.sdk), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "runtime");
		assert.match(error.message, /^the child's session does not have the tool ask_orchestrator this role runs with/);
		assert.match(error.message, /rather than run with fewer tools than its contract names/);
		assert.match(error.message, /registered in that extension's factory body/);
		return true;
	});
	// The same late registration, for a role that does not require the name: the run starts, and the name appears only
	// after the registration the check could not have seen. That is what makes the refusal above a check and not a race.
	const tolerated = fakeSdk(["deepseek/deepseek-chat"], { tools: { late: ["ask_orchestrator"] } });
	const running = (await createRuntime(composed, tolerated.sdk)) as { created: { session: { getActiveToolNames(): string[]; registerLate(): void } } };
	assert.equal(running.created.session.getActiveToolNames().includes("ask_orchestrator"), false);
	running.created.session.registerLate();
	assert.equal(running.created.session.getActiveToolNames().includes("ask_orchestrator"), false, "and a name outside the role's list stays inactive even once it is registered");
	// Two missing names are both named, and neither is dropped or stood in for.
	const twoMissing = checkInput({ ...composed, tools: [...composed.tools, "ask_orchestrator", "report_progress"] });
	const none = fakeSdk(["deepseek/deepseek-chat"]);
	await assert.rejects(createRuntime(twoMissing, none.sdk), /does not have the tools ask_orchestrator, report_progress this role runs with/);
	// A session that cannot answer for its tools, or answers in a shape this bootstrap does not read, is a
	// compatibility refusal that names the api and copies nothing of what it was told.
	for (const fault of [{ tools: { without: true } }, { tools: { active: "read,bash" } }, { tools: { active: [7] } }, { tools: { throws: marked(MARKERS.getError) } }] as Fault[]) {
		const shaped = fakeSdk(["deepseek/deepseek-chat"], fault);
		await assert.rejects(createRuntime(composed, shaped.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "sdk", JSON.stringify(fault));
			assert.match(error.message, /getActiveToolNames\(\)/);
			for (const marker of allMarkers) assert.ok(!error.message.includes(marker), `a compatibility refusal must not repeat ${marker}`);
			return true;
		});
	}
	// The ask role keeps the list its binding names, and nothing in this composition adds an edit or a write to it.
	const askRole: PiRole = piRole({ role: "ask", model: "deepseek/deepseek-chat" }, undefined, {});
	const asked = checkInput(bootstrapInput({ role: askRole, storage: STORAGE, session: { kind: "new" }, contract: "# ask" }));
	const askSdk = fakeSdk();
	const asking = (await createRuntime(asked, askSdk.sdk)) as { created: { session: { getActiveToolNames(): string[] } } };
	const active = asking.created.session.getActiveToolNames();
	assert.deepEqual(active, ["read", "bash", "grep", "find", "ls"]);
	for (const tool of ["edit", "write", "powershell"]) assert.equal(active.includes(tool), false, `an ask child has no ${tool} tool`);
});

/*
 * The search tools a call runs with, and the one bounded retry around the helper they download on first use. Every case
 * here drives the composition against the recording double: the definitions are the double's own, nothing starts a
 * session, runs a helper or downloads anything, and what a real `rg` or `fd` acquisition does is the harness's to
 * measure rather than this file's to claim. What these cases are about is which definitions the composition builds, what
 * it hands them to the constructor as, and what the wrapper does with the failures a definition reports.
 */

/** The credential-shaped text a misbehaving factory carries, which no refusal may repeat. */
const HELPER_MARKER = 'marker-helper-secret grep tool could not be built: "apiKey": "sk-marker-helper-0123456789"';

/** The definition of one name out of what the session was built with, so a case reads the composed tool and not a copy. */
const custom = (calls: Recorded, tool: string): Record<string, any> => {
	const found = (calls.session[0].customTools as Array<Record<string, any>>).find((one) => one.name === tool);
	assert.ok(found, `the composition passed a ${tool} definition`);
	return found;
};

test("a default call's search tools are the builtins wrapped, each factory asked once for its own and nothing else changed", async () => {
	const composed = input();
	assert.deepEqual([composed.tools.includes("grep"), composed.tools.includes("find"), composed.extensions], [true, true, []], "every role in this build runs both search tools and names no extension");
	const { sdk, calls } = fakeSdk();
	await createRuntime(composed, sdk);
	assert.deepEqual(
		calls.helperFactories,
		[
			{ tool: "grep", cwd: composed.cwd, args: 1 },
			{ tool: "find", cwd: composed.cwd, args: 1 },
		],
		"each public factory is called once, with this call's own working directory and no options at all",
	);
	assert.deepEqual(
		(calls.session[0].customTools as Array<Record<string, any>>).map((one) => one.name),
		["grep", "find"],
		"a custom definition replaces the builtin of the same name, so the names are the builtins' own",
	);
	assert.deepEqual(calls.session[0].tools, composed.tools, "the role's allow list is untouched: nothing is added to it and nothing is taken from it");
	for (const tool of ["grep", "find"]) {
		const definition = custom(calls, tool);
		const original = calls.helperAnswers[tool];
		assert.notEqual(definition, original, "the session was given a wrapper rather than the definition the factory built");
		assert.notEqual(definition.execute, original.execute);
		assert.equal(typeof definition.execute, "function");
		// Everything else the factory put on it comes through by reference, the schema included: a wrapper that lost a
		// definition's metadata would be a tool the model is shown differently, which is not what this changes.
		assert.deepEqual(Object.keys(definition), Object.keys(original));
		assert.equal(definition.parameters, HELPER_SCHEMA);
		assert.equal(definition.label, HELPER_LABEL[tool]);
		assert.equal(definition.description, `the installed ${tool}`);
	}
	assert.deepEqual(calls.helperAttempts, [], "composing a wrapper runs no attempt of its own");
});

test("the search tools are built for the working directory the session was built for, and not for one recomputed here", async () => {
	// Everywhere else in this file those two are the same value, so this is the one case that can tell them apart: the
	// double hands the session factory a directory of its own, and what the factories are given has to be that one. It is
	// a string this fake passes along and nothing more — no directory is made, resolved, read or looked at.
	const composed = input();
	const effective = "/work/effective-session-cwd";
	assert.notEqual(effective, composed.cwd);
	const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { sessionCwd: effective });
	await createRuntime(composed, sdk);
	assert.deepEqual(
		calls.helperFactories,
		[
			{ tool: "grep", cwd: effective, args: 1 },
			{ tool: "find", cwd: effective, args: 1 },
		],
		"each factory is given the session's own working directory",
	);
	assert.equal(calls.services[0].cwd, effective, "which is the directory the services were built for as well");
	assert.equal(calls.runtime[0].cwd, composed.cwd, "and the runtime is still asked for the call's own");
});

test("a composed search tool retries its own helper failure once, and neither tool retries the other's", async () => {
	const composed = input();
	const own = fakeSdk(["deepseek/deepseek-chat"], { helpers: { failure: "own" } });
	await createRuntime(composed, own.sdk);
	for (const tool of ["grep", "find"] as const) {
		const definition = custom(own.calls, tool);
		const notices: Array<Record<string, any>> = [];
		const notify = (update: Record<string, any>): void => {
			notices.push(update);
		};
		const params = { pattern: "needle" };
		const context = { cwd: "/work" };
		const signal = new AbortController().signal;
		const result = await definition.execute("toolu-1", params, signal, notify, context);
		const made = own.calls.helperAttempts.filter((attempt) => attempt.tool === tool);
		assert.equal(made.length, 2, `${tool} made two underlying attempts, which is the most one model-issued call may make`);
		for (const attempt of made) {
			assert.equal(attempt.id, "toolu-1", tool);
			assert.equal(attempt.params, params, tool);
			assert.equal(attempt.signal, signal, tool);
			assert.equal(attempt.onUpdate, notify, tool);
			assert.equal(attempt.context, context, tool);
			assert.equal(attempt.receiver, own.calls.helperAnswers[tool], `${tool}: both attempts are calls on the definition the factory built`);
		}
		assert.deepEqual(notices, [{ content: [{ type: "text", text: HELPER_RETRY_NOTICE }], details: undefined }], `${tool}: one notice, and it repeats nothing the failure said`);
		assert.deepEqual(result, { content: [{ type: "text", text: `${tool} ran on attempt 2` }], details: undefined }, `${tool}: the second attempt's own answer is the call's`);
	}
	// The same failure with the other tool's message: not this tool's helper failure, so nothing is retried and the error
	// the tool raised is what the call gets. The pairing is the factory entry's own, so a swap cannot be composed at all.
	const swapped = fakeSdk(["deepseek/deepseek-chat"], { helpers: { failure: "swapped" } });
	await createRuntime(composed, swapped.sdk);
	for (const tool of ["grep", "find"] as const) {
		const other = tool === "grep" ? "find" : "grep";
		const definition = custom(swapped.calls, tool);
		await assert.rejects(
			definition.execute("toolu-2", { pattern: "needle" }, undefined, undefined, { cwd: "/work" }),
			(error: Error) => {
				assert.equal(error.message, HELPER_UNAVAILABLE[other], tool);
				return true;
			},
			tool,
		);
		assert.equal(swapped.calls.helperAttempts.filter((attempt) => attempt.tool === tool).length, 1, `${tool}: one attempt, because that message is not this tool's helper failure`);
	}
});

test("a role that runs neither search tool gets no wrapper, and one that runs one gets one", async () => {
	const neither = checkInput({ ...input(), tools: ["read", "bash", "ls"] });
	const { sdk, calls } = fakeSdk();
	await createRuntime(neither, sdk);
	assert.deepEqual(calls.session[0].customTools, []);
	assert.deepEqual(calls.helperFactories, [], "a factory call is a call, and none is made for a tool this session would not run");
	const onlyGrep = checkInput({ ...input(), tools: ["read", "grep"] });
	const one = fakeSdk();
	await createRuntime(onlyGrep, one.sdk);
	assert.deepEqual(
		(one.calls.session[0].customTools as Array<Record<string, any>>).map((each) => each.name),
		["grep"],
	);
	assert.deepEqual(one.calls.helperFactories, [{ tool: "grep", cwd: onlyGrep.cwd, args: 1 }]);
});

test("a call that names an extension keeps that extension's own tools: no wrapper is composed and no factory is called", async () => {
	await withDirAsync(async (root) => {
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(file, "export default () => {};\n");
		const composed = checkInput({ ...input(), extensions: [file] });
		const { sdk, calls } = fakeSdk();
		await createRuntime(composed, sdk);
		assert.deepEqual(calls.session[0].customTools, [], "every refresh applies an extension's registrations first and the custom tools last, so a wrapper would win over an explicit override");
		assert.deepEqual(calls.helperFactories, []);
		assert.deepEqual(calls.session[0].tools, composed.tools, "the role's allow list is the same list either way");
		// And the exclusion does not depend on when the extension registers: an extension that registers a `grep` of its
		// own in its factory body and one that registers it later, in `session_start`, are the same case, because the
		// custom tools are applied after either of them. What decides it is that an extension was named at all.
		const registering = fakeSdk(["deepseek/deepseek-chat"], { tools: { registry: ["grep"] } });
		await createRuntime(composed, registering.sdk);
		assert.deepEqual(registering.calls.session[0].customTools, []);
		assert.deepEqual(registering.calls.helperFactories, []);
	});
});

test("a search-tool factory this bootstrap cannot read is a compatibility refusal, before any session is constructed", async () => {
	const composed = input();
	const cases: Array<{ what: string; helpers: NonNullable<Fault["helpers"]>; expect: RegExp }> = [
		{ what: "a factory that throws", helpers: { tool: "grep", throws: marked(HELPER_MARKER) }, expect: /answered createGrepToolDefinition\(\) with something other than an answer at all rather than a failure of its own/ },
		{ what: "a name that throws when it is read", helpers: { tool: "find", getter: { property: "name", throws: marked(HELPER_MARKER) } }, expect: /answered createFindToolDefinition\(\)\.name with something other than an answer at all/ },
		{ what: "an execute that throws when it is read", helpers: { tool: "grep", getter: { property: "execute", throws: marked(HELPER_MARKER) } }, expect: /answered createGrepToolDefinition\(\)\.execute with something other than an answer at all/ },
		{ what: "no definition at all", helpers: { tool: "grep", definition: null }, expect: /answered createGrepToolDefinition\(\) with something other than a tool definition of its own/ },
		{ what: "a definition that is a string", helpers: { tool: "find", definition: "fd" }, expect: /answered createFindToolDefinition\(\) with something other than a tool definition of its own/ },
		{ what: "a definition that is a list", helpers: { tool: "grep", definition: [] }, expect: /answered createGrepToolDefinition\(\) with something other than a tool definition of its own/ },
		{ what: "another tool's name", helpers: { tool: "grep", definition: { name: "ripgrep", execute: async () => ({}) } }, expect: /answered createGrepToolDefinition\(\) with something other than a tool definition named grep/ },
		{ what: "no name at all", helpers: { tool: "find", definition: { execute: async () => ({}) } }, expect: /answered createFindToolDefinition\(\) with something other than a tool definition named find/ },
		{ what: "no execute", helpers: { tool: "find", definition: { name: "find" } }, expect: /answered createFindToolDefinition\(\) with something other than a find tool definition with an execute\(\) to call/ },
		{ what: "an execute that is not callable", helpers: { tool: "grep", definition: { name: "grep", execute: "rg" } }, expect: /answered createGrepToolDefinition\(\) with something other than a grep tool definition with an execute\(\) to call/ },
	];
	for (const one of cases) {
		const { sdk, calls } = fakeSdk(["deepseek/deepseek-chat"], { helpers: one.helpers });
		await assert.rejects(createRuntime(composed, sdk), (error: Error & { stage?: string; cause?: unknown }) => {
			assert.equal(error.stage, "sdk", one.what);
			assert.match(error.message, one.expect, one.what);
			assert.match(error.message, /a call is not started on a public api whose answer this bootstrap cannot read/, `${one.what}: the same fixed wording a resource accessor gets, because what a reader does about it is the same`);
			assert.equal(error.cause, undefined, `${one.what}: the thrown value is not carried along as a cause`);
			for (const marker of [HELPER_MARKER, MARKERS.name, MARKERS.code, "marker-cause-secret", "sk-marker"]) {
				assert.ok(!error.message.includes(marker), `${one.what} must not repeat ${marker}`);
			}
			return true;
		});
		assert.deepEqual(calls.session, [], `${one.what}: the session was never constructed`);
	}
});

/*
 * The question tool a call may ask for: what the composer writes, what the bootstrap refuses, what the constructor is
 * handed, and what the definition itself does with one dialog. Nothing here runs a child, opens a dialog or maps a
 * question to a host queue: the runner that would do that does not exist yet, and these cases are about the
 * composition and the definition alone.
 */

test("a call that asks for questions runs the question tool, named once after the role's own list, and one that does not runs without it", () => {
	const compose = (questions?: boolean): BootstrapInput => bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "# implement", ...(questions === undefined ? {} : { questions }) });
	const quiet = compose();
	assert.equal(quiet.questionTool, false, "the field is always written, so a child reads it rather than inferring the tool from a name in its list");
	assert.deepEqual(quiet.tools, role.tools);
	assert.equal(compose(false).questionTool, false);
	const asking = compose(true);
	assert.equal(asking.questionTool, true);
	assert.deepEqual(asking.tools, [...role.tools, QUESTION_TOOL_NAME], "the role's own names in their own order, with the question tool after them");
	assert.equal(asking.tools.filter((tool) => tool === QUESTION_TOOL_NAME).length, 1, "named once");
	// A role that named it itself is not given it twice, and neither call writes to the list the binding handed over.
	const named: PiRole = { ...role, tools: [...role.tools, QUESTION_TOOL_NAME] };
	assert.deepEqual(bootstrapInput({ role: named, storage: STORAGE, session: { kind: "new" }, contract: "x", questions: true }).tools, named.tools);
	assert.deepEqual(role.tools, piRole({ role: "implement", model: "deepseek/deepseek-chat", effort: "high" }, undefined, {}).tools, "the role's own list is what its binding named");
});

test("the question flag is a boolean or absent, and a call that asks for the tool without naming it is refused before the SDK is loaded", () => {
	const refuses = (over: Partial<BootstrapInput>, expect: RegExp): void => {
		assert.throws(
			() => checkInput({ ...input(), ...over }),
			(error: Error & { stage?: string }) => {
				assert.equal(error.stage, "input", JSON.stringify(over));
				assert.match(error.message, expect, JSON.stringify(over));
				return true;
			},
			JSON.stringify(over),
		);
	};
	for (const flag of ["true", "", 1, 0, null, {}, []]) refuses({ questionTool: flag as unknown as boolean }, /questionTool is not a boolean/);
	// Absent is no question tool: an input hand-built before this field existed is a call that runs without it.
	const { questionTool: _flag, ...without } = input();
	const checked = checkInput(without);
	assert.equal("questionTool" in checked, false, "nothing is filled in for it");
	refuses({ questionTool: true }, /asks for the question tool and its tools do not name ask_orchestrator/);
	assert.equal(checkInput(bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "x", questions: true })).questionTool, true, "the composed pair is what checks out");
});

test("a call that asks for questions passes the question tool to the constructor beside the wrapped search tools", async () => {
	const asking = checkInput(bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "# implement", questions: true }));
	const { sdk, calls } = fakeSdk();
	const started = (await createRuntime(asking, sdk)) as { created: { session: { getActiveToolNames(): string[] } } };
	assert.deepEqual(
		(calls.session[0].customTools as Array<Record<string, any>>).map((one) => one.name),
		["grep", "find", QUESTION_TOOL_NAME],
		"the two wrapped builtins, then the one definition this composition adds a name for",
	);
	assert.deepEqual(calls.session[0].tools, asking.tools, "the allow list is the composed one, the question tool's name included");
	assert.deepEqual(started.created.session.getActiveToolNames(), asking.tools, "a custom definition is in the registry, so the name the role runs with is active");
	const definition = custom(calls, QUESTION_TOOL_NAME);
	assert.deepEqual([definition.label, definition.description], ["Ask orchestrator", QUESTION_TOOL_DESCRIPTION]);
	assert.equal(calls.helperFactories.length, 2, "and the search tools are composed exactly as they are for any other call");
	// A call that asks for nothing is exactly what it was: the two wrapped search tools and no third definition.
	const quiet = fakeSdk();
	await createRuntime(input(), quiet.sdk);
	assert.deepEqual(
		(quiet.calls.session[0].customTools as Array<Record<string, any>>).map((one) => one.name),
		["grep", "find"],
	);
});

test("a call that names an extension gets no question tool either, and that extension's own registration is the way to have one", async () => {
	await withDirAsync(async (root) => {
		const file = path.join(root, "ext.ts");
		fs.writeFileSync(file, "export default () => {};\n");
		const asking = checkInput({ ...bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "# implement", questions: true }), extensions: [file] });
		const { sdk, calls } = fakeSdk();
		await assert.rejects(createRuntime(asking, sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "runtime");
			assert.match(error.message, /does not have the tool ask_orchestrator this role runs with/, "the tool check refuses it by name rather than the call running without the tool its contract names");
			return true;
		});
		assert.deepEqual(calls.session[0].customTools, [], "no custom tool of Fusion's goes in beside an explicit user extension, the question tool included");
		// An extension that registers that tool in its factory body is what such a call runs on, and this composition
		// overrides nothing of it.
		const registering = fakeSdk(["deepseek/deepseek-chat"], { tools: { registry: [QUESTION_TOOL_NAME] } });
		const started = (await createRuntime(asking, registering.sdk)) as { created: { session: { getActiveToolNames(): string[] } } };
		assert.deepEqual(started.created.session.getActiveToolNames(), asking.tools);
		assert.deepEqual(registering.calls.session[0].customTools, []);
	});
});

test("the question tool asks one blocking dialog and answers with exactly what came back", async () => {
	const definition = questionTool();
	assert.deepEqual([definition.name, definition.label, definition.description], [QUESTION_TOOL_NAME, "Ask orchestrator", QUESTION_TOOL_DESCRIPTION]);
	const asked: Array<{ title: unknown; placeholder: unknown; options: unknown }> = [];
	/** One dialog as the extension ui answers it, recording what it was asked with by identity. */
	const ui = (answer: string | undefined) => ({
		input: async (title: unknown, placeholder?: unknown, options?: unknown): Promise<string | undefined> => {
			asked.push({ title, placeholder, options });
			return answer;
		},
	});
	const signal = new AbortController().signal;
	const answered = await definition.execute("toolu-1", { question: "which name?" }, signal, undefined, { ui: ui("the second one") });
	assert.deepEqual(answered, { content: [{ type: "text", text: "the second one" }], details: undefined });
	assert.deepEqual(asked, [{ title: "which name?", placeholder: undefined, options: { signal } }], "the question is the dialog's title, there is no placeholder, and the options carry the signal alone");
	assert.equal((asked[0].options as { signal: AbortSignal }).signal, signal, "the call's own signal, by identity, so an abort dismisses that dialog");
	// An empty answer is an answer: the host sent it, and nothing here turns it into a failure or a default.
	asked.length = 0;
	assert.deepEqual(await definition.execute("toolu-2", { question: "which name?" }, undefined, undefined, { ui: ui("") }), { content: [{ type: "text", text: "" }], details: undefined });
	assert.deepEqual(asked, [{ title: "which name?", placeholder: undefined, options: undefined }], "no signal, and then no dialog options at all rather than one holding undefined");
	// A dialog that produced no answer is one fixed failure, and the dialog is not opened a second time.
	asked.length = 0;
	await assert.rejects(definition.execute("toolu-3", { question: "which name?" }, undefined, undefined, { ui: ui(undefined) }), (error: Error) => {
		assert.equal(error.message, QUESTION_UNANSWERED);
		return true;
	});
	assert.equal(asked.length, 1, "one dialog per call: no retry, no second question and no timeout of its own");
});

test("the question tool is the name and the sentence the Claude backend's own question tool carries, and no builtin of this Pi", () => {
	assert.equal(QUESTION_TOOL_NAME, "ask_orchestrator");
	assert.equal(BUILTIN_TOOLS.includes(QUESTION_TOOL_NAME), false, "a custom definition replaces a builtin of the same name, and this name is no builtin's");
	// Read as source rather than imported: importing the Claude backend here would pull its SDK into a file that
	// builds nothing, and what has to hold is that the two files say the same thing to a child.
	const claude = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "claude.ts"), "utf8");
	assert.ok(claude.includes(`export const QUESTION_TOOL = ${JSON.stringify(QUESTION_TOOL_NAME)};`), "the Claude backend names the same tool");
	assert.ok(claude.includes(JSON.stringify(QUESTION_TOOL_DESCRIPTION)), "and describes it with the same sentence, because one contract tells both children to ask through it");
	const schema = questionTool().parameters as unknown as { required: string[]; properties: { question: { type: string; description: string } } };
	assert.deepEqual(schema.required, ["question"], "the question is the one parameter and it is required, so a call with none is not a question the host could answer");
	assert.equal(schema.properties.question.type, "string", "and it is a string rather than a shape a host would have to interpret");
	assert.ok(claude.includes(JSON.stringify(schema.properties.question.description)), "and asks for the question with the same words");
});

/*
 * The control extension this composition puts inside every child, and the two commands it registers. Every case here
 * drives the module itself or the recording double: nothing starts a child, navigates a session or forks one, so what
 * these prove is what Fusion composes and what its handlers do with an answer. What a real Pi does with either
 * command — which hooks run, what a cancellation leaves behind, what a fork writes — is a real child's to show.
 */

/** The commands the factory registers, by name, as the loader would hold them after running it. */
const controlCommands = (): Map<string, ControlCommand> => {
	const registered = new Map<string, ControlCommand>();
	controlExtension().factory({
		registerCommand: (name, command) => {
			registered.set(name, command);
		},
	});
	return registered;
};

/** A command context that records the operation it was asked for and answers with whatever the case decided. */
const operations = (answer: (operation: string) => unknown) => {
	const seen: Array<{ operation: string; id: unknown; options: unknown }> = [];
	const ctx: ControlCommandContext = {
		navigateTree: async (id, options) => {
			seen.push({ operation: "navigateTree", id, options });
			return answer("navigateTree");
		},
		fork: async (id, options) => {
			seen.push({ operation: "fork", id, options });
			return answer("fork");
		},
	};
	return { ctx, seen };
};

test("the control extension registers exactly the two commands a host moves a session with, and nothing else", () => {
	// Every property the factory touches on the api it was given, so a tool, a hook, a renderer or a widget would
	// show up here as an access this assertion does not allow.
	const touched: string[] = [];
	const registered: Array<{ name: string; command: ControlCommand }> = [];
	const api = new Proxy(
		{
			registerCommand: (name: string, command: ControlCommand) => {
				registered.push({ name, command });
			},
		} as Record<string, unknown>,
		{
			get: (target, property) => {
				touched.push(String(property));
				return target[String(property)];
			},
		},
	);
	const extension = controlExtension();
	assert.deepEqual(Object.keys(extension).sort(), ["factory", "name"], "a named factory and nothing beside it, so the loader reports one path for all of it");
	assert.equal(extension.name, CONTROL_EXTENSION_NAME);
	extension.factory(api as unknown as { registerCommand(name: string, command: ControlCommand): void });
	assert.deepEqual(touched, ["registerCommand", "registerCommand"], "two registrations, and no other api of the extension surface is even read");
	assert.deepEqual(
		registered.map((each) => each.name),
		[...CONTROL_COMMANDS],
		"the two commands, in the order this build names them",
	);
	assert.deepEqual([...CONTROL_COMMANDS], [NAVIGATE_COMMAND, FORK_COMMAND]);
	assert.equal(Object.isFrozen(CONTROL_COMMANDS), true, "the list is read rather than edited");
	for (const each of registered) {
		assert.equal(typeof each.command.description, "string");
		assert.notEqual(each.command.description.trim(), "", `${each.name} says what it is for in the command menu`);
		assert.equal(typeof each.command.handler, "function");
	}
	assert.notEqual(controlExtension().factory, extension.factory, "built fresh, so nothing is shared between two children of one host");
});

test("a control command takes one json string and hands that exact id to the one operation it names", async () => {
	const commands = controlCommands();
	// An ordinary id, and one carrying the characters a composed argument has to survive: spaces, quotes, a backslash
	// and a newline. The host sends `JSON.stringify(id)` and this Pi hands a handler everything after the first space,
	// so what comes back out of the decoding has to be the id exactly, with nothing trimmed or normalized.
	for (const id of ["entry-7", ' a "quoted" \\ back\\slash\nand a newline ']) {
		const navigating = operations(() => ({ cancelled: false }));
		await commands.get(NAVIGATE_COMMAND)!.handler(JSON.stringify(id), navigating.ctx);
		assert.deepEqual(navigating.seen, [{ operation: "navigateTree", id, options: { summarize: false } }], JSON.stringify(id));
		const forking = operations(() => ({ cancelled: false }));
		await commands.get(FORK_COMMAND)!.handler(JSON.stringify(id), forking.ctx);
		assert.deepEqual(forking.seen, [{ operation: "fork", id, options: { position: "at" } }], JSON.stringify(id));
	}
});

test("a control command called with anything but one json string fails before it touches the session", async () => {
	const commands = controlCommands();
	// Each of these is the two installs disagreeing rather than a user typing something, so each is the one fixed
	// sentence and none of them repeats what arrived.
	const refused = ["", "   ", "entry-7", "not json", "7", "null", "true", '["entry-7"]', '{"id":"entry-7"}', '""', '"   "', '"entry-7" "entry-8"'];
	for (const name of CONTROL_COMMANDS) {
		for (const args of refused) {
			const { ctx, seen } = operations(() => ({ cancelled: false }));
			await assert.rejects(commands.get(name)!.handler(args, ctx), (error: Error) => {
				assert.equal(error.message, CONTROL_INVALID_ARGUMENT, `${name} ${JSON.stringify(args)}`);
				return true;
			});
			assert.deepEqual(seen, [], `${name} ${JSON.stringify(args)}: no operation was asked for at all`);
			assert.equal(CONTROL_INVALID_ARGUMENT.includes(args.trim()) && args.trim() !== "", false, "and the refusal does not repeat what arrived");
		}
	}
});

test("what a session operation answered is what the control command reports, and nothing is guessed at", async () => {
	const commands = controlCommands();
	for (const name of CONTROL_COMMANDS) {
		// A completed operation is the one case a handler returns on. Extra fields the SDK may carry beside
		// `cancelled` are none of this handler's business and change nothing.
		assert.equal(await commands.get(name)!.handler('"entry-7"', operations(() => ({ cancelled: false })).ctx), undefined, name);
		assert.equal(await commands.get(name)!.handler('"entry-7"', operations(() => ({ cancelled: false, sessionFile: "/work/.pi/sessions/s.jsonl", leafId: "entry-9" })).ctx), undefined, name);
		const answers: Array<{ what: string; answer: unknown; expect: string }> = [
			{ what: "cancelled", answer: { cancelled: true }, expect: CONTROL_CANCELLED },
			{ what: "cancelled beside other fields", answer: { cancelled: true, reason: "a hook said so" }, expect: CONTROL_CANCELLED },
			{ what: "nothing at all", answer: undefined, expect: CONTROL_UNANSWERED },
			{ what: "null", answer: null, expect: CONTROL_UNANSWERED },
			{ what: "an empty object", answer: {}, expect: CONTROL_UNANSWERED },
			{ what: "a cancelled that is a word", answer: { cancelled: "no" }, expect: CONTROL_UNANSWERED },
			{ what: "a list", answer: [], expect: CONTROL_UNANSWERED },
			{ what: "a boolean of its own", answer: false, expect: CONTROL_UNANSWERED },
		];
		for (const one of answers) {
			await assert.rejects(commands.get(name)!.handler('"entry-7"', operations(() => one.answer).ctx), (error: Error) => {
				assert.equal(error.message, one.expect, `${name}: ${one.what}`);
				return true;
			});
		}
		// An error the operation itself threw is the runtime's own and passes through exactly as it is: not wrapped,
		// not replaced by one of the sentences above, and not retried.
		const thrown = new Error("Invalid entry ID for forking");
		await assert.rejects(
			commands.get(name)!.handler(
				'"entry-7"',
				operations(() => {
					throw thrown;
				}).ctx,
			),
			(error: Error) => {
				assert.equal(error, thrown, `${name}: the same error, by identity`);
				return true;
			},
		);
	}
});

test("both control commands have to be on the session under their own bare names, from this composition's own extension", async () => {
	const composed = input();
	// The clean case: the factory this composition passed registered them, the loader reported them under its own
	// inline path, and the call starts. The registrations the double recorded are the factory's own.
	const { sdk, calls } = fakeSdk();
	await createRuntime(composed, sdk);
	assert.deepEqual(
		calls.registrations.map((each) => [each.name, each.sourceInfo.path]),
		[
			[NAVIGATE_COMMAND, CONTROL_EXTENSION_PATH],
			[FORK_COMMAND, CONTROL_EXTENSION_PATH],
		],
		"the loader ran the one factory it was handed, and everything it registered carries that factory's own path",
	);
	const fromOwn = (name: string) => ({ name, invocationName: name, sourceInfo: { path: CONTROL_EXTENSION_PATH } });
	const foreign = "/work/.pi/agent/extensions/marker-command-secret-theirs.ts";
	// A registry that also holds commands nobody here registered: this check asks after two names of its own and
	// answers for nothing else, so a command from another source and one carrying only the `invocationName` this
	// check reads — no description, no sourceInfo — leave the call exactly as it was. That second entry is a partial
	// projection for this test rather than a complete command: the public `RegisteredCommand` also has a `name` and a
	// `handler`, and nothing here claims otherwise. What it exercises is that an unrelated entry is not held to the
	// metadata the two owned commands are, because requiring that would refuse a session over fields belonging to
	// whoever registered it.
	const beside = fakeSdk(["deepseek/deepseek-chat"], {
		commands: { list: [{ name: "review", invocationName: "review", description: "Review the diff", sourceInfo: { path: foreign } }, fromOwn(NAVIGATE_COMMAND), { invocationName: "skill:notes" }, fromOwn(FORK_COMMAND)] },
	});
	await createRuntime(composed, beside.sdk);
	assert.deepEqual(beside.calls.getModel, ["deepseek/deepseek-chat"], "the two commands are there under their own names, and the rest of the registry is none of this check's business");
	const refusals: Array<{ what: string; list: unknown[]; expect: RegExp }> = [
		{ what: "one of them missing", list: [fromOwn(NAVIGATE_COMMAND)], expect: /does not have the control command pi-fusion-fork from this host's own control extension/ },
		{ what: "neither of them", list: [], expect: /does not have the control commands pi-fusion-navigate, pi-fusion-fork/ },
		{
			// Two extensions registering one name is what this Pi renames, and a bare lookup of that name then finds
			// nothing at all, so the command a prompt would send is not there however many of it were registered.
			what: "renamed by a collision",
			list: [{ ...fromOwn(NAVIGATE_COMMAND), invocationName: `${NAVIGATE_COMMAND}:1` }, { ...fromOwn(NAVIGATE_COMMAND), invocationName: `${NAVIGATE_COMMAND}:2` }, fromOwn(FORK_COMMAND)],
			expect: /does not have the control command pi-fusion-navigate/,
		},
		{ what: "the bare name from another source", list: [{ name: NAVIGATE_COMMAND, invocationName: NAVIGATE_COMMAND, sourceInfo: { path: foreign } }, fromOwn(FORK_COMMAND)], expect: /does not have the control command pi-fusion-navigate/ },
		{ what: "a command that names no source at all", list: [{ name: FORK_COMMAND, invocationName: FORK_COMMAND }, fromOwn(NAVIGATE_COMMAND)], expect: /does not have the control command pi-fusion-fork/ },
	];
	for (const one of refusals) {
		const shaped = fakeSdk(["deepseek/deepseek-chat"], { commands: { list: one.list } });
		await assert.rejects(createRuntime(composed, shaped.sdk), (error: Error & { stage?: string }) => {
			assert.equal(error.stage, "runtime", one.what);
			assert.match(error.message, one.expect, one.what);
			assert.ok(!error.message.includes(foreign), `${one.what}: a refusal names the fixed command and nothing the registry holds`);
			assert.ok(!error.message.includes(":1") && !error.message.includes(":2"), `${one.what}: nor the name this Pi renamed it to`);
			return true;
		});
	}
	// A registry this bootstrap cannot read the answer of is the same compatibility finding every other public api
	// gets: it names the api and the shape, and copies nothing of what it was told.
	const shapes: Array<{ what: string; fault: Fault; expect: RegExp }> = [
		{ what: "no extension runner", fault: { commands: { without: "runner" } }, expect: /createAgentSessionFromServices\(\) with something other than a session whose extensionRunner provides getRegisteredCommands\(\)/ },
		{ what: "no accessor on it", fault: { commands: { without: "accessor" } }, expect: /a session whose extensionRunner provides getRegisteredCommands\(\)/ },
		{ what: "an accessor that throws", fault: { commands: { throws: marked(CONSTRUCTION_MARKERS.session) } }, expect: /getRegisteredCommands\(\) with something other than an answer at all rather than a failure of its own/ },
		{ what: "an answer that is not a list", fault: { commands: { list: "pi-fusion-navigate" } }, expect: /getRegisteredCommands\(\) with something other than a list of the registered commands, each naming its own invocationName/ },
		{ what: "a command that is not a record", fault: { commands: { list: ["pi-fusion-navigate"] } }, expect: /a list of the registered commands, each naming its own invocationName/ },
		{ what: "a command whose invocation name is not one", fault: { commands: { list: [{ invocationName: 7, sourceInfo: { path: CONTROL_EXTENSION_PATH } }] } }, expect: /a list of the registered commands, each naming its own invocationName/ },
	];
	for (const one of shapes) {
		const shaped = fakeSdk(["deepseek/deepseek-chat"], one.fault);
		await assert.rejects(createRuntime(composed, shaped.sdk), (error: Error & { stage?: string; cause?: unknown }) => {
			assert.equal(error.stage, "sdk", one.what);
			assert.match(error.message, one.expect, one.what);
			assert.equal(error.cause, undefined, `${one.what}: the thrown value is not carried along as a cause`);
			for (const marker of constructionMarkers) assert.ok(!error.message.includes(marker), `${one.what} must not repeat ${marker}`);
			return true;
		});
	}
});

test("the thinking levels the bootstrap accepts are Pi's own, and nothing else is a level", () => {
	assert.deepEqual([...THINKING_LEVELS], [...PI_EFFORTS], "the plain-ESM list and the list the host validates against are the same list");
	for (const level of PI_EFFORTS) assert.equal(checkInput({ ...input(), thinkingLevel: level }).thinkingLevel, level);
	for (const level of ["", "  ", "ultracode", "HIGH", "xhigh ", 3, null, {}]) {
		assert.throws(() => checkInput({ ...input(), thinkingLevel: level }), /is not one of off, minimal, low, medium, high, xhigh, max/, JSON.stringify(level));
	}
	const { thinkingLevel: _named, ...noLevel } = input();
	assert.equal("thinkingLevel" in checkInput(noLevel), false, "no level at all is still the model's own default");
});

test("a rejected path is named by its field and never by its value", () => {
	for (const [field, over] of [
		["session.file", { session: { kind: "open", file: "private-transcript-name.jsonl", sessionId: "abc123" } }],
		["authPath", { authPath: "private-auth-name.json" }],
		["modelsPath", { modelsPath: "private-models-name.json" }],
		["cwd", { cwd: "some-relative-project" }],
	] as Array<[string, Partial<BootstrapInput>]>) {
		assert.throws(
			() => checkInput({ ...input(), ...over }),
			(error: Error) => {
				assert.ok(error.message.includes(`${field} must be an absolute path`), `${field}: ${error.message}`);
				for (const value of ["private-transcript-name", "private-auth-name", "private-models-name", "some-relative-project"]) {
					assert.ok(!error.message.includes(value), `${field} must not repeat the value it refused: ${error.message}`);
				}
				return true;
			},
			field,
		);
	}
});

test("a package that does not export what the bootstrap calls is reported by name", () => {
	const { sdk } = fakeSdk();
	assert.deepEqual(checkSdk(sdk), { version: "0.85.1", sessionVersion: 3 });
	const stripped = { ...(sdk as unknown as Record<string, unknown>), SessionManager: { create: () => ({}) }, runRpcMode: undefined, CURRENT_SESSION_VERSION: undefined };
	assert.throws(() => checkSdk(stripped), (error: Error & { stage?: string }) => {
		assert.equal(error.stage, "sdk");
		assert.match(error.message, /runRpcMode\(\)/);
		assert.match(error.message, /SessionManager\.open\(\)/);
		assert.match(error.message, /CURRENT_SESSION_VERSION/);
		assert.match(error.message, /@earendil-works\/pi-coding-agent 0\.85\.1/, "the version it found is named, so the report says which install this is");
		assert.match(error.message, /nothing is installed or worked around here/);
		return true;
	});
	assert.throws(() => checkSdk({}), /does not provide the public API/);
	// The two search-tool factories are part of the same surface: an install that does not export one of them cannot
	// have the retry a default call installs, so it is named here rather than left to fail when a session is built.
	for (const factory of ["createGrepToolDefinition", "createFindToolDefinition"]) {
		assert.throws(
			() => checkSdk({ ...(sdk as unknown as Record<string, unknown>), [factory]: undefined }),
			new RegExp(`does not provide the public API this bootstrap runs on: ${factory}\\(\\)`),
			factory,
		);
	}
});

test("a package that does not say which version it is still works, and reports unknown", () => {
	const { sdk } = fakeSdk();
	const anonymous = { ...(sdk as unknown as Record<string, unknown>), VERSION: undefined };
	assert.deepEqual(checkSdk(anonymous), { version: "unknown", sessionVersion: 3 });
	const blank = { ...(sdk as unknown as Record<string, unknown>), VERSION: "   " };
	assert.equal(checkSdk(blank).version, "unknown");
	assert.throws(() => checkSdk({ ...(anonymous as Record<string, unknown>), runRpcMode: undefined }), /pi-coding-agent unknown at /);
});

test("the installed package provides every api the bootstrap names, and says which version it is", async () => {
	// The first of the two unfenced children, and the reason the exception exists: this is the floor the bootstrap's
	// own compatibility check stands on, so it has to read the real installation's exports. It imports the package and
	// runs `typeof` over it — no session is opened, no settings manager or model runtime is built, no process of Pi's
	// is started and nothing is asked of a provider — in a process of its own, with the same sanitized environment and
	// owned working directory as every other child here. The package resolves from the bootstrap's own location in
	// this repository, which is why an owned working directory changes nothing about what is found.
	const script = `
		const boot = await import(${JSON.stringify("__URL__")});
		const surface = boot.checkSdk(await boot.loadSdk());
		process.stdout.write(JSON.stringify(surface));
	`.replace("__URL__", bootstrapUrl);
	const probe = await installedPackageChild(["--input-type=module", "-e", script]);
	assert.equal(probe.code, 0, probe.stderr);
	const surface = JSON.parse(probe.stdout) as { version: string; sessionVersion: number };
	assert.match(surface.version, /^\d+\.\d+\.\d+/, `the installed ${SDK_PACKAGE} reports its version`);
	assert.equal(typeof surface.sessionVersion, "number", "the session version a preflight compares against comes from the package");
});

test("this file's own reader keeps the bootstrap's diagnostics out of whatever else a child wrote to stderr", () => {
	// stderr is not the bootstrap's alone: node writes a warning there, and the SDK writes its own line for a context
	// or prompt file it could not read. A reader that parsed every line would fail on one of those and take a case
	// down for a reason that has nothing to do with what it asserts. This is test parsing: nothing production writes is
	// filtered, suppressed or redacted by it, and every marker assertion in this file reads the raw stderr instead.
	const mixed = [
		"(node:1234) ExperimentalWarning: something is experimental",
		JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: "input" }),
		"Warning: Could not read /work/AGENTS.md: EACCES",
		"",
		"   ",
		"{not json at all",
		JSON.stringify({ event: "some-other-event", stage: "input" }),
		JSON.stringify(["a", "list"]),
		JSON.stringify("a bare string"),
		JSON.stringify(null),
		JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: "sdk", sdk: "0.85.1", error: "marker-only-in-the-record" }),
	].join("\n");
	const found = lines(mixed);
	assert.deepEqual(
		found.map((line) => line.stage),
		["input", "sdk"],
		"the bootstrap's own lines, in order, and nothing else that was written there",
	);
	assert.deepEqual(found[1], { event: DIAGNOSTIC_EVENT, stage: "sdk", sdk: "0.85.1", error: "marker-only-in-the-record" }, "and each one exactly as it was written");
	assert.deepEqual(lines(""), []);
	assert.deepEqual(lines("not json\nnot json either\n"), [], "a child that wrote no diagnostic at all reads as none, rather than throwing");
	// The raw text is still the raw text, which is what a case asserting a marker never reached stderr reads.
	assert.ok(mixed.includes("marker-only-in-the-record"));
});

test("a diagnostic line carries a stage, a version and an error, and no identity or credential at all", () => {
	assert.deepEqual(JSON.parse(diagnostic("sdk", { sdk: "0.85.1" })), { event: DIAGNOSTIC_EVENT, stage: "sdk", sdk: "0.85.1" });
	assert.deepEqual(JSON.parse(diagnostic("input")), { event: DIAGNOSTIC_EVENT, stage: "input" });
	const failure = JSON.parse(diagnostic("session", { sdk: "0.85.1", error: "the recorded session file is empty" }));
	assert.deepEqual(Object.keys(failure), ["event", "stage", "sdk", "error"]);
	for (const field of ["sessionId", "sessionFile", "session", "checkpoint", "authPath", "apiKey", "credential", "token"]) {
		assert.equal(field in failure, false, `a diagnostic has no ${field}`);
	}
	assert.equal(diagnostic("input", { sdk: undefined, error: undefined }), JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: "input" }));
});

test("the marker and the startup exit code are the protocol module's own, and the bootstrap re-exports what it writes with", () => {
	// Both ends of the wire stand on one declaration: this program writes them in the child and the host's transport
	// recognizes them there, and a second copy of either would be two protocols that agree until one of them is edited.
	// That the host no longer imports this program to read them, and that the protocol module imports nothing at all,
	// are `test/backends.test.ts`'s own static reads; what this case pins is where the values live and that every
	// caller reading them off the bootstrap — every assertion in this file included — reads the same ones.
	assert.equal(DIAGNOSTIC_EVENT, PROTOCOL_DIAGNOSTIC_EVENT, "the marker the bootstrap re-exports is the protocol module's own");
	assert.equal(STARTUP_EXIT_CODE, PROTOCOL_STARTUP_EXIT_CODE, "and so is the exit code a startup refusal uses");
	assert.deepEqual([PROTOCOL_DIAGNOSTIC_EVENT, PROTOCOL_STARTUP_EXIT_CODE], ["pi-fusion-bootstrap", 78], "the two values a child writes and a host reads, recorded here as well as declared there");
	// Where they are declared, read off the two sources: the protocol module declares both, and the bootstrap names it
	// and declares neither. Spacing and the order of the two names are formatting these are robust to; a second copy of
	// a value is not, which is the whole of what they refuse.
	const protocolSource = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-bootstrap-protocol.mjs"), "utf8");
	assert.match(protocolSource, new RegExp(`export\\s+const\\s+DIAGNOSTIC_EVENT\\s*=\\s*${JSON.stringify(PROTOCOL_DIAGNOSTIC_EVENT)}`), "the protocol module declares the marker");
	assert.match(protocolSource, new RegExp(`export\\s+const\\s+STARTUP_EXIT_CODE\\s*=\\s*${PROTOCOL_STARTUP_EXIT_CODE}\\b`), "the protocol module declares the exit code");
	const bootstrapSource = fs.readFileSync(PI_BOOTSTRAP_PATH, "utf8");
	assert.match(bootstrapSource, /from\s+"\.\/pi-bootstrap-protocol\.mjs"/, "the bootstrap takes both from the protocol module rather than writing them down again");
	for (const name of ["DIAGNOSTIC_EVENT", "STARTUP_EXIT_CODE"]) {
		assert.ok(bootstrapSource.includes(name), `the bootstrap no longer mentions ${name}, so this case is reading a file that could not drift`);
		assert.doesNotMatch(
			bootstrapSource,
			new RegExp(`(const|let|var)\\s+${name}\\s*=`),
			`the bootstrap declares ${name} of its own beside the protocol module's, and the child and the host can now disagree about it`,
		);
	}
});

test("the preflight's own failures name no session id and no transcript path", () => {
	withDir((dir) => {
		const file = sessionFile(dir, header({ id: "secret-session-id" }));
		const { sdk } = fakeSdk();
		assert.throws(
			() => preflightSession({ kind: "open", file, sessionId: "expected-id" }, sdk),
			(error: Error) => {
				assert.doesNotMatch(error.message, /secret-session-id|expected-id/, "the host knows which session it asked for; a diagnostic does not repeat it");
				assert.doesNotMatch(error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
				return true;
			},
		);
	});
});

test("the bootstrap reports each startup stage and keeps stdout for the protocol alone", async () => {
	await withDirAsync(async (dir) => {
		const file = path.join(dir, "bootstrap.json");
		fs.writeFileSync(file, JSON.stringify(input()));
		const ok = await child(["--input-type=module", "-e", mainScript], { CALL_INPUT: file, SCENARIO: "ok" });
		assert.equal(ok.code, 0, ok.stderr);
		assert.equal(ok.stdout, "", "stdout belongs to runRpcMode");
		assert.deepEqual(
			lines(ok.stderr).map((line) => [line.event, line.stage, line.sdk]),
			[
				[DIAGNOSTIC_EVENT, "input", undefined],
				[DIAGNOSTIC_EVENT, "sdk", "0.85.1"],
				[DIAGNOSTIC_EVENT, "runtime", "0.85.1"],
				[DIAGNOSTIC_EVENT, "serving", "0.85.1"],
			],
		);
	});
});

test("a startup failure is one actionable diagnostic and the startup exit code", async () => {
	await withDirAsync(async (dir) => {
		const file = path.join(dir, "bootstrap.json");
		fs.writeFileSync(file, JSON.stringify(input()));
		const missing = await child(["--input-type=module", "-e", mainScript], { CALL_INPUT: file, SCENARIO: "missing-api" });
		assert.equal(missing.code, STARTUP_EXIT_CODE);
		assert.equal(missing.stdout, "");
		const sdkFailure = lines(missing.stderr).at(-1);
		assert.equal(sdkFailure?.stage, "sdk");
		assert.match(String(sdkFailure?.error), /createAgentSessionRuntime\(\)/);

		// A constructor's own throw, through the real process, with a credential-shaped marker in its text: what lands on
		// stderr is the stage's fixed summary and the counts the call was configured with, and none of the marker.
		const threw = await child(["--input-type=module", "-e", mainScript], { CALL_INPUT: file, SCENARIO: "services-throw", MARKER: CONSTRUCTION_MARKERS.services });
		assert.equal(threw.code, STARTUP_EXIT_CODE);
		const stageFailure = lines(threw.stderr).at(-1);
		assert.deepEqual(
			[stageFailure?.stage, stageFailure?.sdk, stageFailure?.error],
			["resources", "0.85.1", RESOURCES_SUMMARY(0, 0)],
			"a resource failure is the resources stage's own refusal, and it says nothing the SDK said",
		);
		for (const marker of [...Object.values(CONSTRUCTION_MARKERS), "sk-marker"]) assert.ok(!threw.stderr.includes(marker), `${marker} must not reach stderr`);
		assert.equal(lines(threw.stderr).some((line) => line.stage === "serving"), false, "and nothing was served");

		// The three model-runtime failures, each through the real process, each with a credential-shaped marker in the
		// SDK's own text: what lands on stderr is the fixed refusal and the configured models path, and nothing else.
		const composed = input();
		const expected = `${MODELS_REFUSED}. Models file in use: ${composed.modelsPath}`;
		for (const scenario of ["create-throws", "geterror-throws", "reports"]) {
			const refused = await child(["--input-type=module", "-e", mainScript], { CALL_INPUT: file, SCENARIO: scenario, MARKER: MARKERS.aggregate });
			assert.equal(refused.code, STARTUP_EXIT_CODE, `${scenario}: a model configuration that cannot be used refuses the whole startup`);
			assert.equal(refused.stdout, "");
			const modelsFailure = lines(refused.stderr).at(-1);
			assert.deepEqual([modelsFailure?.stage, modelsFailure?.sdk, modelsFailure?.error], ["models", "0.85.1", expected], scenario);
			for (const marker of allMarkers) assert.ok(!refused.stderr.includes(marker), `${scenario}: ${marker} must not reach stderr`);
			assert.equal(lines(refused.stderr).some((line) => line.stage === "serving"), false, `${scenario}: nothing was served`);
		}
	});
});

/*
 * The isolation every process case above runs under, asserted rather than assumed. A child here runs the real
 * bootstrap, and what would otherwise stop it importing the installed Pi is a rule in the very code under test: a
 * mutation that removed one could let a real package load, build a settings manager and open a session in a process
 * this file only meant to watch fail. The fence closes that ordinary import, and these cases are what say it is
 * installed and what its rules decide. What it is not is said where it lives: a resolution rule, not a sandbox.
 */

test("a subprocess of this suite cannot import a backend sdk, and the rule that refuses it is a pure one", async () => {
	const fenceSource = fs.readFileSync(FENCE, "utf8");
	assert.ok(fenceSource.includes(`"${FENCE_MARKER}"`), "the marker this file matches is the marker the fence refuses with");
	assert.ok(fenceSource.includes(`"${FENCE_SENTINEL}"`), "and the sentinel this file imports is the sentinel the fence knows");
	// That the fence is installed at all, shown with the fence's own sentinel: a name that is installed nowhere and is
	// fenced by a rule of its own, so a fenced child answers with the marker while an unfenced one could only answer
	// that the module was not found. Nothing real is named, resolved or evaluated either way, and the rule behind it is
	// the one a mutation check may flip — flipping it leaves the rules that fence a real package exactly as they are.
	const sentinel = `try { await import(${JSON.stringify(FENCE_SENTINEL)}); process.stdout.write("imported"); } catch (error) { process.stdout.write(String(error && error.message)); }`;
	const fenced = await child(["--input-type=module", "-e", sentinel], {});
	assert.equal(fenced.code, 0, fenced.stderr);
	assert.ok(fenced.stdout.startsWith(FENCE_MARKER), `every child of this file is fenced: ${fenced.stdout}`);
	assert.equal(fs.existsSync(path.join(repoRoot, "node_modules", FENCE_SENTINEL)), false, "the sentinel is a name nothing installs, so refusing it cannot be refusing a real package");
	// And the two rules as pure predicates, exercised in a child so that reading them installs nothing here: a bare
	// name or a subpath of a fenced scope, and a resolved url inside one of those packages' installed directories,
	// whichever way the import that reached it was written.
	const specifiers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent/rpc-entry", "@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk/core", "node:fs", "./pi-bootstrap.mjs", "typebox", "@earendil/other"];
	const sentinels = [FENCE_SENTINEL, "pi-fusion-fence-sentinel-other", "@earendil-works/pi-coding-agent"];
	const urls = [
		pathToFileURL(path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href,
		"file:///elsewhere/node_modules/@anthropic-ai/claude-agent-sdk/index.js",
		pathToFileURL(PI_BOOTSTRAP_PATH).href,
		"file:///elsewhere/node_modules/typebox/index.js",
	];
	const script = `
		const fence = await import(${JSON.stringify(pathToFileURL(FENCE).href)});
		process.stdout.write(JSON.stringify({
			marker: fence.FENCE_MARKER,
			specifiers: ${JSON.stringify(specifiers)}.map((name) => fence.fencedSpecifier(name)),
			sentinels: ${JSON.stringify(sentinels)}.map((name) => fence.fencedSentinel(name)),
			sentinel: fence.FENCE_SENTINEL,
			urls: ${JSON.stringify(urls)}.map((url) => fence.fencedUrl(url)),
			either: fence.fenced("node:fs", ${JSON.stringify(urls[0])}),
			neither: fence.fenced("node:fs", ${JSON.stringify(urls[3])}),
		}));
	`;
	const rules = await child(["--input-type=module", "-e", script], {});
	assert.equal(rules.code, 0, rules.stderr);
	const answered = JSON.parse(rules.stdout) as { marker: string; specifiers: boolean[]; sentinels: boolean[]; sentinel: string; urls: boolean[]; either: boolean; neither: boolean };
	assert.equal(answered.marker, FENCE_MARKER);
	assert.equal(answered.sentinel, FENCE_SENTINEL);
	assert.deepEqual(answered.specifiers, [true, true, true, true, false, false, false, false], "a fenced scope by name or subpath, and nothing else");
	assert.deepEqual(answered.sentinels, [true, false, false], "the sentinel rule is that one exact name, and it is not what fences a real package");
	assert.deepEqual(answered.urls, [true, true, false, false], "a resolved url inside a fenced package, and nothing else");
	assert.deepEqual([answered.either, answered.neither], [true, false], "either rule is enough, and neither rule is a pass");
	// The real SDK's own name and its own installed url, decided by the rules rather than by a name that looks like it.
	assert.equal(answered.specifiers[0], true, `${SDK_PACKAGE} is refused by name`);
	assert.equal(answered.urls[0], true, "and the installed package's own resolved url is refused too");
});

test("a child that would import the installed sdk fails at the fence, before a setting, a session or a model exists", async () => {
	await withDirAsync(async (root) => {
		// A valid input through the real entry point, with no double: the bootstrap reads it, reports the input stage and
		// then reaches for the package, which the fence refuses. That is the ordering control — everything this file
		// asserts about a real-entry child holds because the package cannot be reached, not because it happened not to be.
		const file = path.join(root, "bootstrap.json");
		fs.writeFileSync(file, JSON.stringify(input()));
		const refused = await child([PI_BOOTSTRAP_PATH, file], {});
		assert.equal(refused.code, STARTUP_EXIT_CODE);
		assert.equal(refused.stdout, "", "nothing served");
		const reported = lines(refused.stderr);
		assert.deepEqual(
			reported.map((line) => line.stage),
			["input", "sdk"],
			`the input was read and the package was not: ${refused.stderr}`,
		);
		assert.equal("sdk" in reported[1], false, "no version is reported, because no package answered with one");
		assert.ok(String(reported[1].error).includes(FENCE_MARKER), `the fence is what refused it: ${reported[1].error}`);
		for (const stage of ["settings", "session", "models", "resources", "runtime", "serving"]) {
			assert.equal(
				reported.some((line) => line.stage === stage),
				false,
				`nothing reached the ${stage} stage`,
			);
		}
	});
});

test("exactly two subprocesses of this file run unfenced, and neither of them builds anything", () => {
	// A source-level assertion about this file, because the property is about the file rather than about one run: every
	// process case goes through the fenced helper, and the two exceptions are the ones counted here. `run` is the only
	// thing that starts a process and the unfenced option is written in one place, so a third exception would have to
	// be added for this to pass, which is what makes counting them worth doing.
	const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
	// This test's own body names those spellings in its assertions, so it is cut out of what is counted.
	const from = source.indexOf('test("exactly two subprocesses');
	const elsewhere = source.slice(0, from) + source.slice(source.indexOf("\n});\n", from));
	assert.equal((elsewhere.match(/fenced: false/g) ?? []).length, 1, "one helper composes an unfenced child, and nothing else names that option");
	assert.equal((elsewhere.match(/fenced: true/g) ?? []).length, 1, "and one composes a fenced one, which is what every other case uses");
	const sites = [...elsewhere.matchAll(/await installedPackageChild\(/g)].map((match) => match.index ?? 0);
	assert.equal(sites.length, 2, `exactly two calls run without the fence, and this file makes ${sites.length}`);
	// What each of the two is, and what neither may do. The first reads the installed package's exports through the
	// bootstrap's own compatibility check; the second calls the public accessor for the host agent directory. The
	// script each one runs is above its call, so that is what is read here, and neither may construct anything.
	const near = sites.map((at) => elsewhere.slice(Math.max(0, at - 1400), at + 200));
	assert.ok(near[0].includes("boot.checkSdk(await boot.loadSdk())"), "the first exception reads the package's exports and nothing more");
	assert.ok(near[1].includes("hostAgentDir()"), "the second exception calls the public agent-directory accessor and nothing more");
	for (const forbidden of ["createAgentSession", "SessionManager", "ModelRuntime", "SettingsManager", "runRpcMode", "createRuntime"]) {
		for (const [index, part] of near.entries()) {
			assert.equal(part.includes(`${forbidden}.`) || part.includes(`${forbidden}(`), false, `the unfenced exception ${index} must not build with ${forbidden}`);
		}
	}
	// And both of them run with the same owned environment and working directory as every fenced child, because the
	// only difference the unfenced helper makes is the fence itself.
	assert.match(elsewhere, /const installedPackageChild = \(args: string\[\], env: NodeJS\.ProcessEnv = \{\}\): Promise<Ran> => run\(args, env, \{ fenced: false \}\);/);
	assert.match(elsewhere, /const child = \(args: string\[\], env: NodeJS\.ProcessEnv\): Promise<Ran> => run\(args, env, \{ fenced: true \}\);/);
	assert.match(elsewhere, /const owned = sandbox\(\);/, "and both go through the same sandbox, which owns every directory either one writes in");
});

test("the bootstrap runs when node is pointed at it, through a symlink as well as directly", async () => {
	await withDirAsync(async (dir) => {
		const absent = path.join(dir, "no-such-input.json");
		const direct = await child([PI_BOOTSTRAP_PATH, absent], {});
		assert.equal(direct.code, STARTUP_EXIT_CODE);
		assert.equal(direct.stdout, "");
		const failure = lines(direct.stderr).at(-1);
		assert.equal(failure?.stage, "input");
		assert.match(String(failure?.error), /could not be read \(ENOENT\)/);

		if (process.platform === "win32") return;
		const link = path.join(dir, "linked-bootstrap.mjs");
		fs.symlinkSync(PI_BOOTSTRAP_PATH, link);
		const linked = await child([link, absent], {});
		assert.equal(linked.code, STARTUP_EXIT_CODE, "an install reached through a symlink still recognises itself");
		assert.equal(lines(linked.stderr).at(-1)?.stage, "input");
	});
});

test("importing the bootstrap runs nothing, so a test can use its pure functions", async () => {
	const imported = await child(["--input-type=module", "-e", `await import(${JSON.stringify(bootstrapUrl)}); process.stderr.write("imported");`], {});
	assert.equal(imported.code, 0);
	assert.equal(imported.stdout, "");
	assert.equal(imported.stderr, "imported", "no stage was reported, so nothing ran on import");
});

test("the call input is versioned, and a shape from another install is refused rather than guessed at", () => {
	assert.equal(input().version, BOOTSTRAP_INPUT_VERSION);
	assert.throws(() => checkInput({ ...input(), version: 2 }), /names version 2 and this bootstrap reads version 1/);
	assert.throws(() => checkInput({ ...input(), version: undefined }), /names version undefined/);
	assert.throws(() => checkInput("{}"), /is not an object/);
	assert.throws(() => checkInput({ ...input(), cwd: "work" }), /cwd must be an absolute path/);
	assert.throws(() => checkInput({ ...input(), sessionDir: undefined }), /sessionDir must be an absolute path/);
	assert.throws(() => checkInput({ ...input(), modelsPath: "models.json" }), /modelsPath must be an absolute path/);
	assert.throws(() => checkInput({ ...input(), modelsPath: null }), /modelsPath must be an absolute path/, "a child is never launched without a models path, because one without it loses the shared catalog store");
	assert.throws(() => checkInput({ ...input(), model: { provider: "deepseek" } }), /names no provider and model id/);
	assert.throws(() => checkInput({ ...input(), tools: [] }), /names no tools/);
	assert.throws(() => checkInput({ ...input(), contract: "  " }), /carries no contract text/);
	assert.throws(() => checkInput({ ...input(), allowModelNetwork: undefined }), /whether the child may refresh its model catalog/);
	assert.throws(() => checkInput({ ...input(), session: { kind: "fork", file: "/s.jsonl", sessionId: "a" } }), /names session kind "fork"/);
	assert.throws(() => checkInput({ ...input(), session: { kind: "open", file: "s.jsonl", sessionId: "a" } }), /session\.file must be an absolute path/);
	assert.throws(() => checkInput({ ...input(), session: { kind: "open", file: "/s.jsonl" } }), /carries no id/);
});

test("the composed input carries the role's model, level, tools and contract, and the role's own empty resource lists", () => {
	const composed = bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "# implement\nDo the task.\n" });
	assert.deepEqual(composed.model, { provider: "deepseek", model: "deepseek-chat" });
	assert.equal(composed.thinkingLevel, "high");
	assert.equal(composed.contract, "# implement\nDo the task.");
	assert.equal(
		composed.allowModelNetwork,
		true,
		"a child may refresh the catalog it shares with this host's other children, and that permission is composed explicitly rather than left to Pi's own false default",
	);
	assert.deepEqual([composed.extensions, composed.skills], [[], []]);
	assert.equal(composed.catalogBaseUrl, undefined);
	assert.equal(composed.agentDir, STORAGE.agentDir);
	assert.equal(composed.sessionDir, STORAGE.sessionDir);
	assert.equal(composed.authPath, STORAGE.authPath);
	assert.equal(composed.modelsStorePath, STORAGE.modelsStorePath);
	assert.equal(composed.cwd, STORAGE.cwd, "the working directory is the storage's own, and there is no second one to pass");
	assert.equal(composed.modelsPath, STORAGE.modelsPath);
	assert.equal(bootstrapInput({ role, storage: { ...STORAGE, modelsPath: null }, session: { kind: "new" }, contract: "x" }).modelsPath, STORAGE.privateModelsPath);
	const withProvider = bootstrapInput({ role: { ...role, model: "openrouter/deepseek/deepseek-chat" }, storage: STORAGE, session: { kind: "new" }, contract: "x" });
	assert.deepEqual(withProvider.model, { provider: "openrouter", model: "deepseek/deepseek-chat" }, "a provider's own slashes survive the split");
	const loopback = bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "x", catalogBaseUrl: "http://127.0.0.1:1/" });
	assert.equal(loopback.catalogBaseUrl, "http://127.0.0.1:1/");
});

test("the composer refuses a call it cannot compose", () => {
	assert.throws(() => bootstrapInput({ role: { ...role, model: "deepseek-chat" }, storage: STORAGE, session: { kind: "new" }, contract: "x" }), /which is not a pi provider and model id/);
	assert.throws(() => bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "   " }), /has no contract text/);
	assert.throws(() => bootstrapInput({ role, storage: { ...STORAGE, cwd: "project" }, session: { kind: "new" }, contract: "x" }), /working directory must be an absolute path/);
	assert.throws(() => bootstrapInput({ role, storage: STORAGE, session: { kind: "open", file: "s.jsonl", sessionId: "a" }, contract: "x" }), /recorded session file must be an absolute path/);
	assert.throws(() => bootstrapInput({ role: { ...role, tools: [] }, storage: STORAGE, session: { kind: "new" }, contract: "x" }), /role implement has no pi tool list/);
	assert.throws(() => bootstrapInput({ role: { ...role, tools: ["read", " "] }, storage: STORAGE, session: { kind: "new" }, contract: "x" }), /names a blank tool at tools\[1\]/);
});

test("a role's tools and resources come from its own binding, and an ask child has no way to change a file", () => {
	const of = (name: string): PiRole => piRole({ role: name, model: "deepseek/deepseek-chat" }, undefined, {});
	assert.deepEqual(of("ask").tools, ["read", "bash", "grep", "find", "ls"]);
	// A security child gets the coding set: it investigates, and writes the fix when its task authorizes one, which is
	// its contract's rule and the task's rather than a tool the binding takes away from a job that needs it.
	for (const name of ["plan", "implement", "security"]) assert.deepEqual(of(name).tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	assert.equal(of("security").contract, "security.md", "and it runs under a contract of its own, which no claude role names");
	for (const tool of ["edit", "write"]) assert.equal(of("ask").tools.includes(tool), false, `an ask child has no ${tool} tool`);
	for (const name of PI_ROLE_NAMES) {
		assert.deepEqual([of(name).extensions, of(name).skills], [[], []], `role ${name} names a resource, and no role in this build does`);
		assert.deepEqual(bootstrapInput({ role: of(name), storage: STORAGE, session: { kind: "new" }, contract: "x" }).tools, of(name).tools, `the composed input for ${name} is not the tool list its binding named`);
	}
	// Each call gets lists of its own, so a caller that sorts or appends to one changes nothing for the next call.
	const first = of("ask");
	first.tools.push("edit");
	first.extensions.push("/work/ext.ts");
	assert.deepEqual(of("ask").tools, ["read", "bash", "grep", "find", "ls"]);
	assert.deepEqual(of("ask").extensions, []);
	assert.throws(() => piRole({ role: "ultracode", model: "deepseek/deepseek-chat" }, undefined, {}), /does not run on the pi backend/);
});

test("a resource is a local path: relative to the child's working directory, absolute as it is, and never something to fetch", () => {
	const compose = (added: { extensions?: string[]; skills?: string[] }): BootstrapInput => bootstrapInput({ role, storage: STORAGE, session: { kind: "new" }, contract: "x", ...added });
	// The role's own lists come first and a call's additions after them, which is the order the fields report.
	const withRole: PiRole = { ...role, extensions: ["ext/role.ts"], skills: ["/skills/role"] };
	const composed = bootstrapInput({ role: withRole, storage: STORAGE, session: { kind: "new" }, contract: "x", extensions: ["./nested/call.ts"], skills: ["skills/call"] });
	assert.deepEqual(composed.extensions, ["/work/ext/role.ts", "/work/nested/call.ts"], "a relative resource is resolved against the child's working directory");
	assert.deepEqual(composed.skills, ["/skills/role", "/work/skills/call"], "an absolute resource is kept as it is");
	// Ordinary filesystem punctuation is ordinary: there is no glob language here, no `~` and no variable to expand.
	assert.deepEqual(compose({ extensions: ["a[1]/*.ts", "./~odd name/x.ts", "/abs/*.ts"] }).extensions, ["/work/a[1]/*.ts", "/work/~odd name/x.ts", "/abs/*.ts"]);
	assert.deepEqual(compose({ extensions: [" ./spaced.ts "] }).extensions, ["/work/spaced.ts"]);
	// Anything that begins with a scheme is refused by its shape, so `file:` and `data:` need no rule of their own and
	// neither does the next one somebody invents. Every form the earlier prefix list named is still refused.
	for (const entry of [
		"npm:pkg",
		"NPM:pkg",
		" npm:pkg",
		"git:some/repo",
		"git+ssh:host/x",
		"github:owner/repo",
		"http://example.com/x.ts",
		"HTTPS://example.com/x.ts",
		"ssh:host/x",
		"weird://host/x",
		"file:/work/ext.ts",
		"FILE:///work/ext.ts",
		"data:,x",
		"data:text/plain;base64,aGk=",
	]) {
		assert.throws(
			() => compose({ extensions: [entry] }),
			(error: Error) => {
				assert.match(error.message, /^extensions\[0\] (starts with a uri scheme|is a url), and a child loads local paths only/, entry);
				assert.equal(error.message.includes(entry.trim()), false, `the refusal repeated the entry itself: ${error.message}`);
				return true;
			},
			entry,
		);
	}
	// A refusal for a scheme says how a path that only looks like one is written, without repeating what was passed.
	assert.throws(() => compose({ extensions: ["npm:pkg"] }), /a relative path whose first segment holds a colon is written with a leading \.\//);
	// A Windows drive is the one colon that is a path: a single letter and then a separator, either way round. This is
	// the syntax rule and not a claim about a Windows filesystem, which this run says nothing about.
	assert.deepEqual(compose({ extensions: ["C:/work/ext.ts", "d:\\work\\ext.ts"] }).extensions.length, 2);
	for (const drive of ["C:/work/ext.ts", "d:\\work\\ext.ts"]) assert.doesNotThrow(() => compose({ skills: [drive] }), drive);
	// A relative first segment that holds a colon is written with `./`, which is a path and not a scheme.
	assert.deepEqual(compose({ extensions: ["./npm:thing"] }).extensions, [path.resolve("/work", "./npm:thing")]);
	// The index is the entry's own place in the composed list, and the field says which list it was in.
	assert.throws(() => compose({ extensions: ["/work/ok.ts", "npm:pkg"] }), /^Error: extensions\[1\] starts with a uri scheme/);
	assert.throws(() => compose({ skills: ["/work/ok", "  "] }), /^Error: skills\[1\] is blank; a resource entry is a local path on this machine/);
	assert.throws(() => compose({ skills: [undefined as unknown as string] }), /^Error: skills\[0\] is blank/);
	// Nothing is looked up: a path that is not there composes, and the child is what refuses it.
	assert.deepEqual(compose({ skills: ["/nowhere/at/all"] }).skills, ["/nowhere/at/all"]);
});

test("a recorded session becomes the open action, with its file and id together", () => {
	assert.deepEqual(openSession({ backend: "pi", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl" }), { kind: "open", file: "/sessions/s-1.jsonl", sessionId: "s-1" });
	assert.deepEqual(openSession({ backend: "pi", sessionId: "s-1", sessionFile: "/sessions/s-1.jsonl", checkpoint: "e-9" }), { kind: "open", file: "/sessions/s-1.jsonl", sessionId: "s-1", checkpoint: "e-9" });
});

test("the host agent directory is read through the SDK's public accessor, and only when a call asks for it", async () => {
	// The second of the two unfenced children: one call to the package's public accessor, which cannot be made without
	// the package. It builds nothing — no session, no settings manager, no model runtime, no backend — and the
	// directories it names are this case's own rather than a path on this machine that means something. In a process
	// of its own, and with the variable set after the import: a module that read the user's configuration at load
	// would answer with the directory from before, which is the thing this has to rule out.
	await withDirAsync(async (root) => {
		const before = path.join(root, "before-import");
		const asked = path.join(root, "when-asked");
		const launchUrl = pathToFileURL(path.join(repoRoot, "extensions", "backends", "pi-launch.ts")).href;
		const script = `
			const launch = await import(${JSON.stringify("__URL__")});
			process.env.PI_CODING_AGENT_DIR = ${JSON.stringify("__ASKED__")};
			process.stdout.write(await launch.hostAgentDir());
		`
			.replace("__URL__", launchUrl)
			.replace("__ASKED__", asked);
		const probe = await installedPackageChild(["--input-type=module", "-e", script], { PI_CODING_AGENT_DIR: before });
		assert.equal(probe.code, 0, probe.stderr);
		assert.equal(probe.stdout, asked, "the accessor runs when it is called, not when the module is imported");
		assert.deepEqual(fs.readdirSync(root), [], "and reading the accessor creates neither directory");
	});
});

test("the launch options run node from PATH on the installed bootstrap, in the child's own working directory", () => {
	const composed = input();
	const options = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin" } });
	assert.equal(options.command, "node", "node comes from PATH, so no path of this host's own runtime is baked in");
	assert.deepEqual(options.args, [PI_BOOTSTRAP_PATH, STORAGE.inputPath], "the input is the prepared storage's own, and a launch names no path of its own");
	assert.equal(options.cwd, composed.cwd);
	assert.equal(PI_BOOTSTRAP_PATH, path.join(repoRoot, "extensions", "backends", "pi-bootstrap.mjs"));
	assert.ok(fs.existsSync(PI_BOOTSTRAP_PATH), "the bootstrap is installed beside the module that launches it");
	assert.throws(() => piLaunch({ input: composed, storage: { ...STORAGE, inputPath: "bootstrap.json" } }), /call input file must be an absolute path/);
	assert.throws(() => piLaunch({ input: composed, storage: { ...STORAGE, cacheDir: "cache" } }), /call cache directory must be an absolute path/);
});

test("the child's environment is a copy with the Fusion-owned agent directory and the child marker, and the host's is untouched", () => {
	const composed = input();
	const host: NodeJS.ProcessEnv = { PATH: "/usr/bin", [PI_AGENT_DIR_VARIABLE]: "/home/someone/.pi/agent", HOME: "/home/someone" };
	const options = piLaunch({ input: composed, storage: STORAGE, env: host });
	assert.equal(options.env[PI_AGENT_DIR_VARIABLE], STORAGE.agentDir, "the child's agent directory is the stable Fusion-owned one");
	assert.equal(options.env[PI_CHILD_VARIABLE], PI_CHILD_MARKER, "a child carries the marker that keeps this extension from registering inside it");
	assert.equal(host[PI_AGENT_DIR_VARIABLE], "/home/someone/.pi/agent", "the host's own environment is not changed");
	assert.equal(PI_CHILD_VARIABLE in host, false, "the marker was set on the copy, never on the environment the host gave");
	assert.notEqual(options.env, host);
	assert.equal(options.env.PATH, `/usr/bin:${STORAGE.hostBinDir}`, "the ordinary PATH goes through with the host's helper bin after it");
	assert.equal(options.env.HOME, "/home/someone");
});

test("the host's helper bin is appended to the child's PATH, and to nothing else", () => {
	const composed = input();
	const host: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };
	const before = { ...host };
	const env = childEnvironment({ input: composed, storage: STORAGE, env: host }, "linux");
	assert.equal(env[PATH_VARIABLE], `/usr/bin:/bin:${STORAGE.hostBinDir}`, "a child looks in the host's helper bin last, after everything the user's own PATH resolves");
	assert.deepEqual(host, before, "the host's own environment was changed, and the host's process looks helpers up on its own PATH");
	// Exact concatenation: what the user wrote is what the child gets, with one delimiter and the bin after it. A value
	// that already ends in a delimiter keeps the empty entry that delimiter makes, because that entry is the user's.
	const trailing = childEnvironment({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin:" } }, "linux");
	assert.equal(trailing[PATH_VARIABLE], `/usr/bin::${STORAGE.hostBinDir}`, "a trailing delimiter was tidied away, and tidying one changes what the platform searches");
	for (const value of ["  ", "relative/dir", `/usr/bin:${STORAGE.hostBinDir}`]) {
		const kept = childEnvironment({ input: composed, storage: STORAGE, env: { PATH: value } }, "linux");
		assert.equal(kept[PATH_VARIABLE], `${value}:${STORAGE.hostBinDir}`, `PATH ${JSON.stringify(value)} was trimmed, normalised or deduplicated rather than appended to`);
	}
	// The two values this launch leaves alone, and it is the exception the module says it is: a sole directory in
	// either would replace what an absent or an empty PATH means to the platform's own lookup, so a child of a host
	// with one of those reuses no helper of the host's, and none is claimed for it.
	const absent = childEnvironment({ input: composed, storage: STORAGE, env: { HOME: "/home/someone" } }, "linux");
	assert.equal(PATH_VARIABLE in absent, false, "an absent PATH was given a value, which is a search rule this module does not get to write");
	const empty = childEnvironment({ input: composed, storage: STORAGE, env: { PATH: "" } }, "linux");
	assert.equal(empty[PATH_VARIABLE], "", "an empty PATH was filled in, which is a search rule this module does not get to write");
	// On POSIX a name is a name: `Path` is another variable and nothing here reads it as the search path.
	const posixCase = childEnvironment({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin", Path: "/opt/bin" } }, "linux");
	assert.equal(posixCase.Path, "/opt/bin", "a variable POSIX does not read as PATH was appended to");
	assert.equal(posixCase[PATH_VARIABLE], `/usr/bin:${STORAGE.hostBinDir}`);
	// On Windows the name is case insensitive and the delimiter is a semicolon, so every spelling that is there is the
	// search path and each one is appended to where it stands, with no canonical second key beside it.
	const windowsHost: NodeJS.ProcessEnv = { Path: "C:\\Windows", PATH: "C:\\Other" };
	const windows = childEnvironment({ input: composed, storage: STORAGE, env: windowsHost }, "win32");
	assert.equal(windows.Path, `C:\\Windows;${STORAGE.hostBinDir}`);
	assert.equal(windows[PATH_VARIABLE], `C:\\Other;${STORAGE.hostBinDir}`);
	assert.deepEqual(Object.keys(windows).filter((key) => key.toLowerCase() === "path").sort(), ["PATH", "Path"], "a spelling was added or lost, and one variable cannot have two values");
	assert.deepEqual(windowsHost, { Path: "C:\\Windows", PATH: "C:\\Other" }, "the host's own environment was changed");
	const oneSpelling = childEnvironment({ input: composed, storage: STORAGE, env: { Path: "C:\\Windows" } }, "win32");
	assert.equal(oneSpelling.Path, `C:\\Windows;${STORAGE.hostBinDir}`);
	assert.equal(PATH_VARIABLE in oneSpelling, false);
	// The bin is a path or it is nothing: a relative one would be resolved against the child's working directory by
	// whatever read it, which is a directory in the project rather than the host's own.
	assert.throws(
		() => childEnvironment({ input: composed, storage: { ...STORAGE, hostBinDir: "bin" }, env: { PATH: "/usr/bin" } }),
		/host helper bin directory must be an absolute path for a pi child/,
	);
});

test("a helper bin no search path could carry is skipped, and the call runs with the rest of its environment", () => {
	const composed = input();
	// Absolute on the platform this test runs on, so the guard above is not what is being exercised here, and holding
	// the delimiter that platform splits a search path on. A directory may legitimately be named this way.
	const unrepresentable = `${path.sep}host${path.sep}pi:fusion${path.sep}bin`;
	const host: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: "/home/someone", [NODE_COMPILE_CACHE_VARIABLE]: "/home/someone/.cache/node" };
	const before = { ...host };
	const env = childEnvironment({ input: composed, storage: { ...STORAGE, hostBinDir: unrepresentable }, env: host }, "linux");
	assert.equal(env[PATH_VARIABLE], "/usr/bin:/bin", "a bin holding the delimiter was appended, which would add two entries and one of them relative");
	assert.deepEqual(host, before, "the host's own environment was changed");
	// Skipping the append is all it skips: every other thing this launch composes is still there, so a legitimate
	// directory name costs the call its helper reuse and nothing else.
	assert.equal(env[PI_CHILD_VARIABLE], PI_CHILD_MARKER);
	assert.equal(env[PI_AGENT_DIR_VARIABLE], STORAGE.agentDir);
	assert.equal(env[JITI_CACHE_VARIABLE], path.join(STORAGE.cacheDir, JITI_CACHE_DIR));
	assert.equal(env[NODE_COMPILE_CACHE_VARIABLE], path.join(STORAGE.cacheDir, NODE_CACHE_DIR));
	assert.equal(env.HOME, "/home/someone");
	// A semicolon is an ordinary filename character on POSIX, so a bin holding one is appended there as it stands.
	const semicolon = `${path.sep}host${path.sep}pi;fusion${path.sep}bin`;
	const posix = childEnvironment({ input: composed, storage: { ...STORAGE, hostBinDir: semicolon }, env: { PATH: "/usr/bin" } }, "linux");
	assert.equal(posix[PATH_VARIABLE], `/usr/bin:${semicolon}`, "a semicolon was read as a POSIX delimiter, and POSIX splits on a colon");
	// On Windows it is the semicolon that cannot be carried, under every spelling of the variable at once.
	const windowsHost: NodeJS.ProcessEnv = { Path: "/windows/system32", PATH: "/other" };
	const windows = childEnvironment({ input: composed, storage: { ...STORAGE, hostBinDir: semicolon }, env: windowsHost }, "win32");
	assert.deepEqual([windows.Path, windows[PATH_VARIABLE]], ["/windows/system32", "/other"], "one spelling was appended to although the bin cannot be carried on that platform");
	assert.deepEqual(windowsHost, { Path: "/windows/system32", PATH: "/other" }, "the host's own environment was changed");
	// And a colon is ordinary there, which is what a drive letter needs.
	const colon = childEnvironment({ input: composed, storage: { ...STORAGE, hostBinDir: unrepresentable }, env: { Path: "/windows/system32" } }, "win32");
	assert.equal(colon.Path, `/windows/system32;${unrepresentable}`, "a colon was read as a Windows delimiter, and Windows splits on a semicolon");
});

test("whether the helper bin can go on a search path is one answer, read and never written", () => {
	const linux = (env: NodeJS.ProcessEnv, bin: string): string => hostBinPlacement(env, bin, "linux");
	const windows = (env: NodeJS.ProcessEnv, bin: string): string => hostBinPlacement(env, bin, "win32");
	// All three answers, under each platform's own delimiter, with the same two bins read the opposite way round.
	const colonBin = "/host/pi:fusion/bin";
	const semicolonBin = "/host/pi;fusion/bin";
	assert.equal(linux({ PATH: "/usr/bin" }, "/host/bin"), "appended");
	assert.equal(linux({ PATH: "/usr/bin" }, semicolonBin), "appended", "a semicolon is an ordinary character in a POSIX path");
	assert.equal(linux({ PATH: "/usr/bin" }, colonBin), "unrepresentable");
	assert.equal(windows({ Path: "C:\\Windows" }, "C:\\Users\\someone\\.pi\\agent\\bin"), "appended", "a drive letter's colon is not the character Windows splits a search path on");
	assert.equal(windows({ Path: "C:\\Windows" }, colonBin), "appended");
	assert.equal(windows({ Path: "C:\\Windows" }, semicolonBin), "unrepresentable");
	// No search path at all wins over either, because there is nothing to append to in the first place.
	for (const env of [{}, { PATH: undefined }, { PATH: "" }, { HOME: "/home/someone" }]) {
		assert.equal(linux(env, "/host/bin"), "no-path", JSON.stringify(env));
		assert.equal(linux(env, colonBin), "no-path", `${JSON.stringify(env)} with a bin that could not be carried either`);
	}
	assert.equal(linux({ Path: "/opt/bin" }, "/host/bin"), "no-path", "POSIX reads a name as the name it is, and Path is not PATH there");
	assert.equal(windows({ Path: "", PATH: "" }, "/host/bin"), "no-path");
	assert.equal(windows({ Path: "", PATH: "C:\\Other" }, "/host/bin"), "appended", "one empty spelling beside a non-empty one is still a search path to append to");
	// It answers and changes nothing: the environment it was handed is the environment it leaves.
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", Path: "/opt/bin" };
	const before = { ...env };
	hostBinPlacement(env, "/host/bin", "linux");
	hostBinPlacement(env, colonBin, "win32");
	assert.deepEqual(env, before, "the classifier wrote to the environment it was reading");
});

test("a child's compiler caches are inside the call directory the call owns, and its own disposal removes them", () => {
	const composed = input();
	const jiti = path.join(STORAGE.cacheDir, JITI_CACHE_DIR);
	const node = path.join(STORAGE.cacheDir, NODE_CACHE_DIR);
	const env = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin", [NODE_COMPILE_CACHE_VARIABLE]: "/home/someone/.cache/node" } }).env;
	assert.equal(env[JITI_CACHE_VARIABLE], jiti);
	assert.equal(env[NODE_COMPILE_CACHE_VARIABLE], node, "an inherited compile cache is retargeted into the call's own directory");
	for (const cache of [jiti, node]) assert.ok(cache.startsWith(`${STORAGE.callDir}${path.sep}`), `${cache} is outside the call directory that is disposed of`);
	// The variable is what turns Node's compile cache on, so an environment without one keeps it off: a child of a host
	// that never enabled the cache does not start writing one.
	const without = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin" } }).env;
	assert.equal(NODE_COMPILE_CACHE_VARIABLE in without, false, "an absent compile cache was enabled for the child");
	assert.equal(without[JITI_CACHE_VARIABLE], jiti, "jiti's cache is this call's own whether the host set one or not");
	// An inherited empty value leaves the cache off too, measured on node v24.18.0, so it is preserved rather than
	// turned into a directory: retargeting it would enable a cache this host was not asked for.
	const empty = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin", [NODE_COMPILE_CACHE_VARIABLE]: "" } }).env;
	assert.equal(empty[NODE_COMPILE_CACHE_VARIABLE], "", "an inherited empty compile cache was rewritten, which enables a cache the host had off");
	// Every non-empty value is a directory name to node, including ones that look like a false boolean, so each one is
	// retargeted as it stands and none of them is trimmed or read as off.
	for (const value of ["0", " ", "false", "./relative-cache", "/home/someone/.cache/node"]) {
		const retargeted = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin", [NODE_COMPILE_CACHE_VARIABLE]: value } }).env;
		assert.equal(retargeted[NODE_COMPILE_CACHE_VARIABLE], node, `compile cache ${JSON.stringify(value)} is a directory node would write in, so it is this call's own`);
	}
});

test("a windows environment spells a cache variable its own way, and that spelling is the one retargeted", () => {
	const composed = input();
	const node = path.join(STORAGE.cacheDir, NODE_CACHE_DIR);
	const host: NodeJS.ProcessEnv = { Path: "C:\\Windows", Node_Compile_Cache: "C:\\Users\\someone\\node-cache", Jiti_Fs_Cache: "C:\\Users\\someone\\jiti" };
	const env = childEnvironment({ input: composed, storage: STORAGE, env: host }, "win32");
	assert.equal(env.Node_Compile_Cache, node, "a mixed-case compile cache escaped retargeting, and Windows reads it as the same variable");
	assert.equal(NODE_COMPILE_CACHE_VARIABLE in env, false, "a second spelling was added beside the inherited one, and one variable cannot have two values");
	assert.equal(env.Jiti_Fs_Cache, path.join(STORAGE.cacheDir, JITI_CACHE_DIR));
	assert.equal(JITI_CACHE_VARIABLE in env, false);
	assert.equal(host.Node_Compile_Cache, "C:\\Users\\someone\\node-cache", "the host's own environment is not changed");
	// Nothing to retarget stays nothing to retarget, whatever the platform: the variable enables the cache.
	assert.equal(NODE_COMPILE_CACHE_VARIABLE in childEnvironment({ input: composed, storage: STORAGE, env: { Path: "C:\\Windows" } }, "win32"), false);
	// An inherited empty value is preserved under the spelling it came in, not rewritten and not joined by a second key.
	const emptyMixed = childEnvironment({ input: composed, storage: STORAGE, env: { Path: "C:\\Windows", Node_Compile_Cache: "" } }, "win32");
	assert.equal(emptyMixed.Node_Compile_Cache, "");
	assert.equal(NODE_COMPILE_CACHE_VARIABLE in emptyMixed, false);
	// On POSIX a name is a name: a mixed-case one is another variable, and this one is left exactly as it was.
	const posix = childEnvironment({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin", Node_Compile_Cache: "/home/someone/.cache/node" } }, "linux");
	assert.equal(posix.Node_Compile_Cache, "/home/someone/.cache/node", "a variable this host does not read was rewritten");
	assert.equal(NODE_COMPILE_CACHE_VARIABLE in posix, false, "the compile cache was enabled from a name POSIX does not read as that variable");
});

test("a launch refuses an input and a storage that are not the same call's, by the field that disagrees", () => {
	const composed = input();
	// The matching pair is the ordinary case, and it is asserted here so the refusals below are not vacuous.
	assert.doesNotThrow(() => piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin" } }));
	const other: CallStorage = {
		...STORAGE,
		cwd: "/elsewhere",
		agentDir: "/other/pi-fusion/children",
		sessionDir: "/other/pi-fusion/children/sessions/project-fedcba9876543210",
	};
	for (const field of ["cwd", "agentDir", "sessionDir"] as const) {
		const storage: CallStorage = { ...STORAGE, [field]: other[field] };
		assert.throws(
			() => piLaunch({ input: composed, storage, env: { PATH: "/usr/bin" } }),
			(error: Error) => {
				assert.match(error.message, new RegExp(`^the call input's ${field} is not the ${field} of the storage this launch was given`), field);
				for (const shown of [composed[field], other[field]]) assert.equal(error.message.includes(shown), false, `the refusal repeated a path: ${error.message}`);
				return true;
			},
			field,
		);
		// The same disagreement refuses the environment on its own, so no caller reaches a cache or a marker through it.
		assert.throws(() => childEnvironment({ input: composed, storage, env: { PATH: "/usr/bin" } }), /is not the .* of the storage this launch was given/, field);
	}
});

test("PI_OFFLINE reaches the child exactly as the user set it, absent, empty, false-looking or truthy", () => {
	const composed = input();
	for (const value of ["1", "true", "yes", "0", "", "  "]) {
		const options = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin", PI_OFFLINE: value } });
		assert.equal(options.env.PI_OFFLINE, value, `PI_OFFLINE ${JSON.stringify(value)} is passed through, not normalised`);
	}
	const unset = piLaunch({ input: composed, storage: STORAGE, env: { PATH: "/usr/bin" } });
	assert.equal("PI_OFFLINE" in unset.env, false, "Pi reads whether the variable is there at all, so an unset one stays unset");
});
