#!/usr/bin/env node
/*
 * Research spike, run by hand: which ways of starting a Pi child reuse the user's provider and model
 * configuration without writing to the user's configuration. It is not part of `npm test`, because it
 * spawns real Pi processes; the default test glob (`test/*.test.ts`) does not reach this directory.
 *
 *   node test/spikes/pi-config-writes.mjs [--pi <cli path>] [--keep] [--case <name>]
 *
 * Everything a child can write goes into one disposable temp root: HOME, the Pi agent directory, the
 * session directory, TMPDIR, the XDG directories and the two compile caches. No real user configuration
 * is read and no credential value is printed. Every model request goes to a loopback fixture server, so
 * no provider is contacted. Exits non-zero when a case breaks a guarantee it is supposed to keep.
 */
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
/**
 * The production retry wrapper's own notice text, imported rather than copied: the concurrent cases below look for this
 * exact string in a real child's own event stream, so a build whose wording changed fails those cases instead of
 * matching a duplicate kept here. The module is plain ESM that imports nothing, so reading it starts and loads nothing
 * else in this process — no SDK, no settings, no child.
 */
import { HELPER_RETRY_NOTICE } from "../../extensions/backends/pi-helper-retry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The package publishes only an "import" condition, so require.resolve cannot find it; resolve the
// public entry point the way an ESM importer does.
const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = path.resolve(path.dirname(packageEntry), "..");
const repoPiVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const repoPiCli = path.join(packageRoot, "dist", "bundle", "cli.js");

const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
};
const altPiCli = flag("--pi");
const onlyCase = flag("--case");
const keepRoot = argv.includes("--keep");
/**
 * Which half of the harness runs. The cases above are the research-stage ones, unchanged; the ones below are the
 * implementation-stage ones, which drive the production bootstrap and storage. They are kept selectable because a
 * verification run must not overlap them: `--stage impl` first, then `--stage historical` to show preservation.
 */
const stage = flag("--stage") ?? "all";
if (!["all", "impl", "historical"].includes(stage)) {
	// The same exit code a mistyped case name gets: a mistyped selector must not be able to pass for a clean run.
	console.log(`--stage takes all, impl or historical, not ${JSON.stringify(stage)}`);
	process.exit(2);
}

/** A dummy key: it never leaves the temp root and the fixture server accepts any bearer. */
const FIXTURE_KEY = "spike-dummy-key-not-a-secret";
const FIXTURE_PROVIDER = "fixture";
const EXTENSION_PROVIDER = "fixture-ext";
const FIXTURE_MODEL = "fixture-model";
const ANSWER = "SPIKE_OK";
/**
 * The label every credential the OAuth cases seed or mint carries, and the shape of one: `DUMMY-access-2` is
 * generation 2, and a generation number is the only part of a credential this harness ever writes down.
 */
const DUMMY_MARKER = "DUMMY-";
const DUMMY_ACCESS_BEARER = /^Bearer DUMMY-access-(\d+)$/;

/**
 * What a model request's `Authorization` header was, in this fixture's own vocabulary and never as the header itself:
 * the seeded api-key credential the cases above use, the generation of a literal dummy access label the OAuth cases
 * mint, or none at all. Anything else is `unrecognized` and carries nothing of the value, so a case fails on a header
 * this fixture never issued rather than logging one.
 */
const bearerLabel = (header) => {
	if (typeof header !== "string") return { kind: "absent" };
	if (header === `Bearer ${FIXTURE_KEY}`) return { kind: "fixture-key" };
	const found = DUMMY_ACCESS_BEARER.exec(header);
	return found ? { kind: "dummy-access", label: Number(found[1]) } : { kind: "unrecognized" };
};
const USER_CONTEXT_SENTINEL = "SPIKE-USER-CONTEXT-SENTINEL";
const PROJECT_CONTEXT_SENTINEL = "SPIKE-PROJECT-CONTEXT-SENTINEL";

const COMMAND_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 90_000;
const EXIT_DEADLINE_MS = 10_000;

/* ------------------------------------------------------------------ snapshots */

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

/** path -> kind/size/hash for everything under dir, so a phase diff names files rather than counts them. */
function snapshot(dir) {
	const entries = new Map();
	const walk = (current, prefix) => {
		let names;
		try {
			names = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				entries.set(rel, `symlink:${fs.readlinkSync(full)}`);
				continue;
			}
			if (entry.isDirectory()) {
				entries.set(rel, "dir");
				walk(full, rel);
				continue;
			}
			try {
				entries.set(rel, `file:${fs.statSync(full).size}:${hashFile(full)}`);
			} catch {
				entries.set(rel, "file:unreadable");
			}
		}
	};
	walk(dir, "");
	return entries;
}

function diffSnapshots(before, after) {
	const created = [];
	const modified = [];
	const removed = [];
	for (const [rel, value] of after) {
		const previous = before.get(rel);
		if (previous === undefined) created.push(rel);
		else if (previous !== value) modified.push(rel);
	}
	for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
	return { created, modified, removed };
}

const isEmptyDiff = (diff) => diff.created.length === 0 && diff.modified.length === 0 && diff.removed.length === 0;

const snapshotAll = (dirs) => Object.fromEntries(Object.entries(dirs).map(([name, dir]) => [name, snapshot(dir)]));

const sameSnapshots = (a, b) =>
	Object.keys(a).every((name) => {
		const diff = diffSnapshots(a[name], b[name]);
		return isEmptyDiff(diff);
	});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pi persists settings through an async write queue, so a command response does not mean the write
 * happened. Read until several reads in a row agree before attributing a diff to a phase. An empty diff
 * therefore means "nothing appeared inside this window", not "nothing can ever appear".
 */
const SETTLE_POLL_MS = 200;
const SETTLE_STABLE_READS = 3;
const SETTLE_MAX_POLLS = 20;

async function settledSnapshot(dirs, { pollMs = SETTLE_POLL_MS, stableReads = SETTLE_STABLE_READS, maxPolls = SETTLE_MAX_POLLS } = {}) {
	let current = snapshotAll(dirs);
	let stable = 0;
	for (let i = 0; i < maxPolls; i++) {
		await sleep(pollMs);
		const next = snapshotAll(dirs);
		stable = sameSnapshots(current, next) ? stable + 1 : 0;
		current = next;
		if (stable >= stableReads) return current;
	}
	return current;
}

/** Wait for a value to appear on disk, so a setter's async write is not judged by one quick read. */
async function pollFor(read, accept, { pollMs = SETTLE_POLL_MS, maxPolls = SETTLE_MAX_POLLS } = {}) {
	for (let i = 0; i < maxPolls; i++) {
		const value = read();
		if (accept(value)) return { ok: true, value };
		await sleep(pollMs);
	}
	const value = read();
	return { ok: accept(value), value };
}

const readJsonIfPresent = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/* ------------------------------------------------------------- fixture server */

/**
 * A loopback OpenAI-completions server. Deterministic: every request is answered with one short answer, unless a case
 * has installed a script under a sentinel and the conversation holds that sentinel, in which case the script's next
 * step answers it. A script is how one case gets a tool call it asked for; every other case is unaffected, because a
 * request that carries no sentinel is answered exactly as it always was.
 */
async function startFixtureServer() {
	const requests = [];
	const scripts = new Map();
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const record = {
				method: req.method,
				url: req.url,
				hasAuthorization: typeof req.headers.authorization === "string",
				authorizationMatchesFixtureKey: req.headers.authorization === `Bearer ${FIXTURE_KEY}`,
				// The credential a request carried, as a label and a kind: the OAuth cases assert which generation
				// reached the model, and no case ever has the header itself to log.
				authorization: bearerLabel(req.headers.authorization),
			};
			requests.push(record);
			if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			record.model = parsed?.model;
			// The tool schemas the child offered, recorded as corroboration for what its resources registered: the
			// names and each one's parameter property names, and nothing from the conversation itself.
			const offered = Array.isArray(parsed?.tools) ? parsed.tools : [];
			record.toolNames = offered.map((tool) => tool?.function?.name).filter((name) => typeof name === "string").sort();
			record.toolSchemas = Object.fromEntries(
				offered
					.filter((tool) => typeof tool?.function?.name === "string")
					.map((tool) => [tool.function.name, Object.keys(tool.function?.parameters?.properties ?? {}).sort()]),
			);
			const conversation = JSON.stringify(parsed?.messages ?? []);
			const script = [...scripts.values()].find((installed) => conversation.includes(installed.sentinel));
			const step = script ? script.steps[script.cursor] : undefined;
			if (script) {
				record.script = script.sentinel;
				record.scriptStep = step?.name ?? "exhausted";
				if (step) script.cursor += 1;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
			const chunk = (choices, usage) =>
				`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: FIXTURE_MODEL, choices, ...(usage ? { usage } : {}) })}\n\n`;
			res.write(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
			if (step?.kind === "tool_call") {
				res.write(
					chunk([
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, id: step.toolCallId ?? "call_spike", type: "function", function: { name: step.toolName, arguments: JSON.stringify(step.arguments ?? {}) } }] },
							finish_reason: null,
						},
					]),
				);
				res.write(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
			} else {
				res.write(chunk([{ index: 0, delta: { content: step?.text ?? ANSWER }, finish_reason: null }]));
				res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
			}
			res.write(chunk([], { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }));
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		/** One case's ordered answers, selected by a sentinel the case puts in its own prompt and nothing else carries. */
		script: (sentinel, steps) => scripts.set(sentinel, { sentinel, steps, cursor: 0 }),
		scriptState: (sentinel) => scripts.get(sentinel),
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/* ------------------------------------------------------------------- fixtures */

const write = (file, content) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
};
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

const modelsJson = (baseUrl, apiKey) => ({
	providers: {
		[FIXTURE_PROVIDER]: {
			baseUrl,
			api: "openai-completions",
			...(apiKey ? { apiKey } : {}),
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [
				{
					id: FIXTURE_MODEL,
					name: "Fixture Model",
					reasoning: true,
					input: ["text"],
					contextWindow: 32000,
					maxTokens: 1024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		},
	},
});

const markerExtension = (command, description) => `export default function (pi) {
	pi.registerCommand("${command}", {
		description: ${JSON.stringify(description)},
		handler: async (_args, ctx) => {
			ctx.ui.notify("${command} ran", "info");
		},
	});
}
`;

/**
 * A provider extension: the shape a role would need when its model comes from an extension rather than
 * from models.json. It points at the same loopback fixture and takes its key from the child environment.
 */
const providerExtension = (providerId, modelId, baseUrl) => `export default function (pi) {
	pi.registerProvider(${JSON.stringify(providerId)}, {
		name: "Fixture provider extension",
		baseUrl: ${JSON.stringify(baseUrl)},
		api: "openai-completions",
		apiKey: "$SPIKE_FIXTURE_KEY",
		models: [
			{
				id: ${JSON.stringify(modelId)},
				name: "Fixture Model (extension)",
				reasoning: true,
				input: ["text"],
				contextWindow: 32000,
				maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			},
		],
	});
}
`;

/** The Fusion child bridge stands in for the real one: it reports what the child's command context offers. */
const bridgeExtension = `export default function (pi) {
	pi.registerCommand("spike-report", {
		description: "Report what the child sees",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			const report = {
				mode: ctx.mode,
				hasUI: ctx.hasUI,
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				model: ctx.model ? \`\${ctx.model.provider}/\${ctx.model.id}\` : null,
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				fork: typeof ctx.fork,
				navigateTree: typeof ctx.navigateTree,
				newSession: typeof ctx.newSession,
				switchSession: typeof ctx.switchSession,
				systemPromptHasUserContext: prompt.includes(${JSON.stringify(USER_CONTEXT_SENTINEL)}),
				systemPromptHasProjectContext: prompt.includes(${JSON.stringify(PROJECT_CONTEXT_SENTINEL)}),
			};
			ctx.ui.notify("SPIKE_REPORT " + JSON.stringify(report), "info");
		},
	});
}
`;

/**
 * A realistic user profile: a provider and model the child should reuse, a stored api_key credential,
 * discoverable extensions, a skill, a prompt template, a local-path package and a trusted project.
 * The legacy variant instead carries the shapes the startup migrations rewrite.
 */
function seedUserProfile(dir, { baseUrl, project, legacy = false }) {
	if (legacy) {
		writeJson(path.join(dir, "settings.json"), {
			defaultProvider: FIXTURE_PROVIDER,
			defaultModel: FIXTURE_MODEL,
			apiKeys: { [FIXTURE_PROVIDER]: FIXTURE_KEY },
		});
		writeJson(path.join(dir, "oauth.json"), {
			"legacy-oauth-provider": { access: "spike-dummy-access", refresh: "spike-dummy-refresh", expires: 4102444800000 },
		});
		write(path.join(dir, "commands", "legacy-prompt.md"), "---\ndescription: Legacy prompt\n---\nLegacy prompt body.\n");
		writeJson(path.join(dir, "models.json"), modelsJson(baseUrl));
		return;
	}
	writeJson(path.join(dir, "settings.json"), {
		defaultProvider: FIXTURE_PROVIDER,
		defaultModel: FIXTURE_MODEL,
		defaultThinkingLevel: "medium",
		theme: "dark",
		steeringMode: "all",
		followUpMode: "all",
		compaction: { enabled: true, reserveTokens: 16384 },
		retry: { enabled: true, maxRetries: 3 },
		defaultProjectTrust: "always",
		packages: ["./local-pkg"],
	});
	writeJson(path.join(dir, "models.json"), modelsJson(baseUrl));
	writeJson(path.join(dir, "auth.json"), { [FIXTURE_PROVIDER]: { type: "api_key", key: FIXTURE_KEY } });
	fs.chmodSync(path.join(dir, "auth.json"), 0o600);
	writeJson(path.join(dir, "trust.json"), { [project]: true });
	write(path.join(dir, "AGENTS.md"), `# User context\n\n${USER_CONTEXT_SENTINEL}\n`);
	write(path.join(dir, "extensions", "user-ext.ts"), markerExtension("user-ext-marker", "User extension marker"));
	write(
		path.join(dir, "skills", "spike-skill", "SKILL.md"),
		"---\nname: spike-skill\ndescription: A seeded user skill used to detect skill inheritance\n---\n\nDo nothing.\n",
	);
	write(path.join(dir, "prompts", "spike-prompt.md"), "---\ndescription: A seeded user prompt template\n---\nDo nothing.\n");
	writeJson(path.join(dir, "local-pkg", "package.json"), {
		name: "spike-local-pkg",
		version: "1.0.0",
		private: true,
		pi: { extensions: ["./pkg-ext.ts"] },
	});
	write(path.join(dir, "local-pkg", "pkg-ext.ts"), markerExtension("pkg-marker", "Local package extension marker"));
}

/**
 * The project carries a legacy `.pi/commands` directory as well, because the CLI's startup migrations
 * rename project-local commands to prompts regardless of which agent directory the child uses.
 */
function seedProject(dir) {
	write(path.join(dir, "AGENTS.md"), `# Project context\n\n${PROJECT_CONTEXT_SENTINEL}\n`);
	write(path.join(dir, "README.md"), "Spike project fixture.\n");
	writeJson(path.join(dir, ".pi", "settings.json"), { compaction: { reserveTokens: 8192 } });
	write(path.join(dir, ".pi", "extensions", "project-ext.ts"), markerExtension("project-ext-marker", "Project extension marker"));
	write(path.join(dir, ".pi", "commands", "legacy-project-prompt.md"), "---\ndescription: Legacy project prompt\n---\nLegacy project prompt body.\n");
}

/** Did the CLI rename this project's `.pi/commands` to `.pi/prompts`? */
const projectCommandsMigrated = (dir) =>
	!fs.existsSync(path.join(dir, ".pi", "commands")) && fs.existsSync(path.join(dir, ".pi", "prompts", "legacy-project-prompt.md"));

/* ------------------------------------------------------------------------ env */

/** Every writable location a child knows about is inside the temp root, and that is checked before launch. */
function childEnv(root, { agentDir, sessionDir, extra = {} }) {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: path.join(root, "home"),
		USERPROFILE: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TEMP: path.join(root, "tmp"),
		XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
		XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
		XDG_DATA_HOME: path.join(root, "xdg", "data"),
		XDG_STATE_HOME: path.join(root, "xdg", "state"),
		NODE_COMPILE_CACHE: path.join(root, "node-compile-cache"),
		JITI_FS_CACHE: path.join(root, "jiti-cache"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: sessionDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		NO_COLOR: "1",
		...extra,
	};
	const rootReal = fs.realpathSync(root);
	for (const [name, value] of Object.entries(env)) {
		if (name === "PATH" || name === "NO_COLOR" || !value.includes(path.sep)) continue;
		const resolved = path.resolve(value);
		if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
			throw new Error(`refusing to launch: ${name}=${value} is outside the temp root ${rootReal}`);
		}
		fs.mkdirSync(resolved, { recursive: true });
	}
	return env;
}

/* --------------------------------------------------------------------- client */

class RpcChild {
	constructor(command, args, options) {
		this.events = [];
		this.notifications = [];
		this.stderr = "";
		this.pending = new Map();
		this.waiters = [];
		this.nextId = 0;
		this.exit = undefined;
		this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code, signal) => {
				this.exit = { code, signal };
				for (const pending of this.pending.values()) pending.reject(new Error(`child exited (${code ?? signal}) before responding`));
				this.pending.clear();
				resolve(this.exit);
			});
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
			if (process.env.PI_SPIKE_DEBUG) process.stderr.write(`[child] ${String(chunk).slice(0, 2000)}`);
		});
		let buffer = "";
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			buffer += chunk;
			// LF only: RPC framing is strict JSONL, and readline would also split on U+2028/U+2029.
			for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (line.trim()) this.handle(line);
			}
		});
	}

	handle(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.events.push({ type: "unparsed", line });
			return;
		}
		if (message.type === "response" && message.id !== undefined) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			pending?.resolve(message);
			return;
		}
		if (message.type === "extension_ui_request" && message.method === "notify") this.notifications.push(message.message ?? "");
		this.events.push(message);
		for (const waiter of [...this.waiters]) {
			if (waiter.match(message)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	}

	send(command, deadlineMs = COMMAND_DEADLINE_MS) {
		if (this.exit) return Promise.reject(new Error(`child already exited (${JSON.stringify(this.exit)})`));
		const id = `spike-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`no response to ${command.type} within ${deadlineMs}ms`));
			}, deadlineMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	waitFor(type, deadlineMs = SETTLE_DEADLINE_MS) {
		const existing = this.events.find((event) => event.type === type);
		if (existing) return Promise.resolve(existing);
		if (this.exit) return Promise.reject(new Error(`child exited before ${type}`));
		return new Promise((resolve, reject) => {
			const waiter = { match: (event) => event.type === type, resolve: undefined };
			const timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				reject(new Error(`no ${type} event within ${deadlineMs}ms`));
			}, deadlineMs);
			waiter.resolve = (event) => {
				clearTimeout(timer);
				resolve(event);
			};
			this.waiters.push(waiter);
		});
	}

	/** Close stdin first and give the child its own shutdown path; kill the process tree only if it stays. */
	async close() {
		if (this.exit) return this.exit;
		try {
			this.child.stdin.end();
		} catch {}
		const timeout = sleep(EXIT_DEADLINE_MS).then(() => "timeout");
		if ((await Promise.race([this.exited, timeout])) === "timeout") {
			try {
				process.kill(-this.child.pid, "SIGKILL");
			} catch {
				this.child.kill("SIGKILL");
			}
			await Promise.race([this.exited, sleep(2000)]);
		}
		return this.exit;
	}
}

/* ---------------------------------------------------------------- case runner */

/** One Pi process, driven through the same phases in every case so the diffs are comparable. */
async function runRpcCase(spec) {
	const result = {
		name: spec.name,
		title: spec.title,
		pi: spec.piLabel,
		phases: [],
		observations: {},
		failures: [],
		notes: [...(spec.notes ?? [])],
	};
	const check = (ok, message) => {
		if (!ok) result.failures.push(message);
		return ok;
	};
	const provider = spec.provider ?? FIXTURE_PROVIDER;
	const model = spec.model ?? FIXTURE_MODEL;
	const firstRequest = spec.server.requests.length;
	let before = await settledSnapshot(spec.watch);
	const phase = async (name, action) => {
		process.stderr.write(`[${spec.name}] ${name}\n`);
		let error;
		try {
			if (child.exit && name !== "exit") throw new Error(`child already exited (${JSON.stringify(child.exit)})`);
			await action();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
			result.failures.push(`${name}: ${error}`);
		}
		const after = await settledSnapshot(spec.watch);
		const diffs = {};
		for (const watched of Object.keys(spec.watch)) diffs[watched] = diffSnapshots(before[watched], after[watched]);
		before = after;
		result.phases.push({ name, error, diffs });
	};

	const child = new RpcChild(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
	try {
		await phase("startup", async () => {
			const state = await child.send({ type: "get_state" }, 60_000);
			check(state.success, "get_state failed at startup");
			result.observations.startupModel = state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : null;
			result.observations.sessionFile = state.data?.sessionFile ?? null;
		});
		await phase("get_available_models", async () => {
			const models = await child.send({ type: "get_available_models" });
			check(models.success, "get_available_models failed");
			result.observations.availableModels = (models.data?.models ?? []).map((model) => `${model.provider}/${model.id}`);
			check(
				result.observations.availableModels.includes(`${provider}/${model}`),
				`${provider}/${model} is not available, so the model configuration or credential was not reused`,
			);
		});
		await phase("get_commands", async () => {
			const commands = await child.send({ type: "get_commands" });
			check(commands.success, "get_commands failed");
			result.observations.commands = (commands.data?.commands ?? []).map((command) => command.name).sort();
		});
		await phase("set_model", async () => {
			const response = await child.send({ type: "set_model", provider, modelId: model });
			check(response.success, `set_model failed: ${response.error ?? ""}`);
		});
		await phase("set_thinking_level", async () => {
			const response = await child.send({ type: "set_thinking_level", level: "high" });
			check(response.success, "set_thinking_level failed");
		});
		/**
		 * The four setters that persist. Each one waits for the value to reach the settings file it is
		 * expected to reach, so "it wrote nothing" is a bounded observation rather than one fast read.
		 */
		const persisted = {};
		const setter = (name, command, read) =>
			phase(name, async () => {
				const response = await child.send(command);
				check(response.success, `${name} failed`);
				const settings = () => (spec.settingsFile ? readJsonIfPresent(spec.settingsFile) : undefined);
				const wanted = spec.settingsFile !== undefined;
				const outcome = await pollFor(
					() => read(settings()),
					(value) => (wanted ? value === true : value !== true),
					{ maxPolls: wanted ? SETTLE_MAX_POLLS : SETTLE_STABLE_READS },
				);
				persisted[name] = outcome.value === true;
				check(
					wanted ? outcome.ok : persisted[name] === false,
					wanted
						? `${name} did not reach ${spec.settingsFile} within the polling window`
						: `${name} reached a settings file although this case has none`,
				);
			});
		await setter("set_steering_mode", { type: "set_steering_mode", mode: "one-at-a-time" }, (settings) => settings?.steeringMode === "one-at-a-time");
		await setter("set_follow_up_mode", { type: "set_follow_up_mode", mode: "one-at-a-time" }, (settings) => settings?.followUpMode === "one-at-a-time");
		await setter("set_auto_compaction", { type: "set_auto_compaction", enabled: false }, (settings) => settings?.compaction?.enabled === false);
		await setter("set_auto_retry", { type: "set_auto_retry", enabled: false }, (settings) => settings?.retry?.enabled === false);
		result.observations.settersPersistedToDisk = persisted;
		await phase("bridge_report", async () => {
			const response = await child.send({ type: "prompt", message: "/spike-report" });
			check(response.success, "the bridge command was rejected");
			const line = await waitForNotification(child, "SPIKE_REPORT ", 10_000);
			result.observations.bridge = JSON.parse(line.slice("SPIKE_REPORT ".length));
			check(result.observations.bridge.fork === "function", "the command context has no fork()");
			check(result.observations.bridge.navigateTree === "function", "the command context has no navigateTree()");
		});
		await phase("prompt", async () => {
			const response = await child.send({ type: "prompt", message: "Say the fixture answer." });
			check(response.success, "the prompt was rejected");
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			result.observations.answer = text.data?.text ?? null;
			check(result.observations.answer?.includes(ANSWER) === true, "the fixture answer did not come back");
		});
		await phase("exit", async () => {
			const exit = await child.close();
			result.observations.exit = exit;
			check(exit?.code === 0 && exit?.signal === null, `child exited with ${JSON.stringify(exit)} instead of code 0`);
		});
	} finally {
		await child.close();
		result.stderr = child.stderr.trim().split("\n").filter(Boolean).slice(-6).join("\n");
	}

	// Cases run one at a time, so this slice belongs to this case alone.
	const requests = spec.server.requests.slice(firstRequest);
	result.observations.fixtureRequests = requests.length;
	check(requests.length >= 1, "the case never reached the fixture model server");
	for (const request of requests) {
		check(
			request.method === "POST" && request.url.endsWith("/chat/completions"),
			`unexpected fixture request ${request.method} ${request.url}`,
		);
		check(request.model === model, `a fixture request asked for ${request.model} instead of ${model}`);
		check(request.authorizationMatchesFixtureKey, "a fixture request did not carry the seeded credential");
	}

	for (const expectation of [spec.expect].flat()) expectation?.(result, check);
	return result;
}

function waitForNotification(child, prefix, deadlineMs) {
	const found = child.notifications.find((message) => message.startsWith(prefix));
	if (found) return Promise.resolve(found);
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			const message = child.notifications.find((value) => value.startsWith(prefix));
			if (message) {
				clearInterval(timer);
				resolve(message);
			} else if (Date.now() - started > deadlineMs) {
				clearInterval(timer);
				reject(new Error(`no ${prefix.trim()} notification within ${deadlineMs}ms`));
			}
		}, 50);
	});
}

/** One Pi process started and stopped again, for the cases that only measure what startup does. */
async function runStartupCase(spec) {
	const before = await settledSnapshot(spec.watch);
	const child = new RpcChild(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });
	const failures = [];
	let error;
	try {
		const state = await child.send({ type: "get_state" }, 60_000);
		if (!state.success) error = `get_state failed: ${state.error ?? ""}`;
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
	}
	const exit = await child.close();
	if (error) failures.push(`startup: ${error}`);
	const after = await settledSnapshot(spec.watch);
	const diffs = {};
	for (const watched of Object.keys(spec.watch)) diffs[watched] = diffSnapshots(before[watched], after[watched]);
	const result = {
		name: spec.name,
		title: spec.title,
		pi: spec.piLabel,
		phases: [{ name: "startup+exit", error, diffs }],
		observations: { exit },
		notes: [...(spec.notes ?? [])],
		failures,
		stderr: child.stderr.trim().split("\n").filter(Boolean).slice(-4).join("\n"),
	};
	spec.expect?.(result, (ok, message) => {
		if (!ok) failures.push(message);
		return ok;
	});
	return result;
}

/** The CLI renames a project's legacy `.pi/commands` at startup; the SDK bootstrap has no migrations. */
function expectProjectMigration(projectDir, shouldMigrate) {
	return (result, check) => {
		const migrated = projectCommandsMigrated(projectDir);
		result.observations.projectCommandsMigrated = migrated;
		check(
			migrated === shouldMigrate,
			shouldMigrate
				? "expected the CLI to rename the project's .pi/commands to .pi/prompts; it did not"
				: "the project's .pi/commands was renamed, although this case is supposed to leave the project alone",
		);
	};
}

/** Whether a child's own auth file exists and whether it ended up holding the seeded credential. */
function describeAuthFile(file) {
	let stats;
	try {
		stats = fs.lstatSync(file);
	} catch {
		return { present: false };
	}
	if (stats.isSymbolicLink()) return { present: true, symlinkTo: fs.readlinkSync(file), holdsTheCredential: false, sharedWithTheUser: true };
	const content = fs.readFileSync(file, "utf8");
	return {
		present: true,
		bytes: stats.size,
		mode: (stats.mode & 0o777).toString(8),
		holdsTheCredential: content.includes(FIXTURE_KEY),
		providers: Object.keys(JSON.parse(content || "{}")),
	};
}

/** Everything the case must not have touched in the seeded user profile. */
function expectUnchanged(watched, label) {
	return (result, check) => {
		for (const phase of result.phases) {
			const diff = phase.diffs[watched];
			check(
				isEmptyDiff(diff),
				`${label} changed during ${phase.name}: ${[...diff.created.map((f) => `+${f}`), ...diff.modified.map((f) => `~${f}`), ...diff.removed.map((f) => `-${f}`)].join(", ")}`,
			);
		}
	};
}

/* ---------------------------------------------------------------- plain runs */

function runCli(command, args, options, deadlineMs = 60_000) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

/**
 * Which of the names experiment C needs are reachable through the package's public entry point. This is a
 * read-only import probe, not a session: it runs in a temp directory whose `node_modules` is a symlink to the
 * repository's, so the bare specifier resolves the way a Fusion child would resolve it.
 */
async function probePublicExports(env, cwd) {
	const script = `
		const names = ["SettingsManager","ModelRuntime","SessionManager","AuthStorage","createAgentSession","createAgentSessionServices","createAgentSessionFromServices","createAgentSessionRuntime","AgentSessionRuntime","runRpcMode","DefaultResourceLoader"];
		const report = { exported: {}, deepImport: null };
		const pkg = await import("@earendil-works/pi-coding-agent");
		for (const name of names) report.exported[name] = typeof pkg[name];
		report.staticsOnSettingsManager = typeof pkg.SettingsManager?.inMemory;
		report.staticsOnModelRuntime = typeof pkg.ModelRuntime?.create;
		try {
			await import("@earendil-works/pi-coding-agent/dist/core/auth-storage.js");
			report.deepImport = "resolved";
		} catch (error) {
			report.deepImport = error?.code ?? error?.name ?? "failed";
		}
		process.stdout.write(JSON.stringify(report));
	`;
	const result = await runCli(process.execPath, ["--input-type=module", "-e", script], { cwd, env });
	try {
		return JSON.parse(result.stdout);
	} catch {
		return { error: result.stderr.trim().split("\n").slice(-3).join("\n") };
	}
}

/** Experiment C runs this: a runtime built from the package's public exports, no CLI, no migrations. */
const bootstrapSource = `import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pi = await import(pathToFileURL(config.packageEntry).href);
const {
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	runRpcMode,
} = pi;

// Settings live in memory, so no settings file exists for the child to write to.
const settingsManager = SettingsManager.inMemory({ defaultTools: config.tools });
// The user's models.json and auth.json are read in place; the refreshed catalog cache is redirected
// into the child's own directory so reuse does not write next to the user's models.json.
const modelRuntime = await ModelRuntime.create({
	authPath: config.authPath,
	modelsPath: config.modelsPath,
	modelsStorePath: config.modelsStorePath,
	allowModelNetwork: false,
});
const sessionManager = SessionManager.create(config.cwd, config.sessionDir);

const createRuntime = async ({ cwd, sessionManager: manager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({
		cwd,
		agentDir: config.agentDir,
		settingsManager,
		modelRuntime,
		resourceLoaderOptions: {
			additionalExtensionPaths: config.extensionPaths,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	});
	const model = modelRuntime.getModel(config.provider, config.model);
	if (!model) throw new Error("the fixture model is not in the reused model configuration");
	const created = await createAgentSessionFromServices({
		services,
		sessionManager: manager,
		sessionStartEvent,
		model,
		tools: config.tools,
	});
	return { ...created, services, diagnostics: services.diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: config.cwd,
	agentDir: config.agentDir,
	sessionManager,
});
await runRpcMode(runtime);
`;

/* ----------------------------------------------------------------- the spike */

const formatDiff = (diff) =>
	isEmptyDiff(diff)
		? "-"
		: [...diff.created.map((f) => `+${f}`), ...diff.modified.map((f) => `~${f}`), ...diff.removed.map((f) => `-${f}`)].join(" ");

/**
 * What one result is, decided in one place: a case with failures **failed**, whatever else it says about itself, so a
 * case that both refused to run and broke a guarantee is never reported as merely skipped. A case is **skipped** when it
 * recorded a reason as a non-empty string, which is how every case here says NOT RUN. Anything else **held**.
 *
 * The string is what makes it a skip, deliberately: `P5-counts` records a `skipped` **array** of the case names its
 * group skipped, which is an observation about other cases and not a refusal of its own, so a list there still holds.
 */
function classifyResult(result) {
	if (result.failures.length > 0) return "failed";
	const reason = result.observations?.skipped;
	return typeof reason === "string" && reason.trim() !== "" ? "skipped" : "held";
}

/** The verdict line a case prints. A skipped case is never given the wording of one that kept its guarantees. */
function resultVerdictLine(result) {
	const verdict = classifyResult(result);
	if (verdict === "failed") return `  RESULT: ${result.failures.length} failure(s)`;
	if (verdict === "skipped") return `  RESULT: NOT RUN (${result.observations.skipped})`;
	return "  RESULT: guarantees held";
}

/**
 * The run's own headline. With nothing skipped it is the sentence it has always been, word for word; a skipped case is
 * counted out of the cases that kept their guarantees and named, because a case that did not run is not one that passed.
 */
function summaryLine(results) {
	const failed = results.filter((result) => classifyResult(result) === "failed");
	const skipped = results.filter((result) => classifyResult(result) === "skipped");
	const held = results.length - failed.length - skipped.length;
	const tail = skipped.length === 0 ? "" : `, ${skipped.length} NOT RUN and counted as neither: ${skipped.map((result) => result.name).join(", ")}`;
	return `${held}/${results.length} cases kept their guarantees${tail}`;
}

function printCase(result) {
	console.log(`\n== ${result.name}: ${result.title} (pi ${result.pi}) ==`);
	const watched = Object.keys(result.phases[0]?.diffs ?? {});
	for (const phase of result.phases) {
		const cells = watched.map((name) => `${name}: ${formatDiff(phase.diffs[name])}`);
		console.log(`  ${phase.name.padEnd(20)}${cells.join("   ")}${phase.error ? `   !! ${phase.error}` : ""}`);
	}
	for (const [key, value] of Object.entries(result.observations)) {
		console.log(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
	}
	for (const note of result.notes) console.log(`  note: ${note}`);
	if (result.stderr) console.log(`  stderr (tail): ${result.stderr.replace(/\n/g, " | ")}`);
	console.log(resultVerdictLine(result));
	for (const failure of result.failures) console.log(`    FAIL ${failure}`);
}

async function main() {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-config-spike-"));
	const server = await startFixtureServer();
	const results = [];
	try {
		const probeDir = path.join(root, "probe", "cwd");
		fs.mkdirSync(probeDir, { recursive: true });
		fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(probeDir, "node_modules"), "dir");
		const probeEnv = childEnv(root, { agentDir: path.join(root, "probe", "agent"), sessionDir: path.join(root, "probe", "sessions") });
		const exportProbe = await probePublicExports(probeEnv, probeDir);

		let altVersion;
		if (altPiCli) {
			const version = await runCli(altPiCli, ["--version"], { cwd: probeDir, env: probeEnv });
			altVersion = version.stdout.trim() || "unknown";
		}

		/** Build one case directory: its own copy of the user profile, project and child directories. */
		const setupCase = (name, { legacy = false } = {}) => {
			const caseRoot = path.join(root, "cases", name);
			const profile = path.join(caseRoot, "user-profile");
			const project = path.join(caseRoot, "project");
			const privateAgent = path.join(caseRoot, "child-agent");
			const sessions = path.join(caseRoot, "sessions");
			const bridge = path.join(caseRoot, "bridge.ts");
			fs.mkdirSync(profile, { recursive: true });
			fs.mkdirSync(project, { recursive: true });
			fs.mkdirSync(privateAgent, { recursive: true });
			fs.mkdirSync(sessions, { recursive: true });
			seedUserProfile(profile, { baseUrl: server.baseUrl, project, legacy });
			seedProject(project);
			write(bridge, bridgeExtension);
			return { caseRoot, profile, project, privateAgent, sessions, bridge };
		};

		const stockArgs = (dirs, { model = `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, extensions = [dirs.bridge] } = {}) => [
			repoPiCli,
			"--mode",
			"rpc",
			"-ne",
			"-ns",
			"-np",
			"--no-themes",
			...extensions.flatMap((extension) => ["-e", extension]),
			"--tools",
			"read",
			"--session-dir",
			dirs.sessions,
			"--model",
			model,
		];

		/** A research-stage case runs when it is named, or when nothing is, and never under `--stage impl`. */
		const wanted = (name) => (!onlyCase || onlyCase === name) && stage !== "impl";
		/** An implementation-stage group runs as a unit: its cases depend on each other's fixtures. */
		const wantedGroup = (group) => (!onlyCase || onlyCase === group) && stage !== "historical";

		/* A: the stock CLI pointed at the user's own agent directory. */
		if (wanted("A")) {
			const dirs = setupCase("A");
			results.push(
				await runRpcCase({
					name: "A",
					title: "stock CLI in RPC, user agent directory, explicit-only resources",
					piLabel: `${repoPiVersion} (repo dependency)`,
					server,
					command: process.execPath,
					args: stockArgs(dirs),
					cwd: dirs.project,
					env: childEnv(root, { agentDir: dirs.profile, sessionDir: dirs.sessions }),
					watch: { profile: dirs.profile, project: dirs.project },
					settingsFile: path.join(dirs.profile, "settings.json"),
					notes: [
						"the child's agent directory is the user profile, so any settings write lands in the user's settings.json",
					],
					expect: [
						(result, check) => {
							const touched = result.phases.filter((phase) => phase.diffs.profile.modified.includes("settings.json"));
							check(
								touched.length > 0,
								"expected the RPC setters to rewrite the user's settings.json; they did not, so this spike's premise needs rechecking",
							);
							result.observations.settingsWritingPhases = touched.map((phase) => phase.name);
						},
						expectProjectMigration(dirs.project, true),
					],
				}),
			);
		}

		/* A-migrate: the same start against a legacy profile, to see what the startup migrations rewrite. */
		if (wanted("A-migrate")) {
			const dirs = setupCase("A-migrate", { legacy: true });
			results.push(
				await runStartupCase({
					name: "A-migrate",
					title: "stock CLI startup against a legacy profile (migrations only)",
					piLabel: `${repoPiVersion} (repo dependency)`,
					command: process.execPath,
					args: stockArgs(dirs),
					cwd: dirs.project,
					env: childEnv(root, { agentDir: dirs.profile, sessionDir: dirs.sessions }),
					watch: { profile: dirs.profile, project: dirs.project },
					notes: ["startup only: this case measures the one-time migrations, not the RPC setters"],
					expect: (result, check) => {
						const diff = result.phases[0].diffs.profile;
						check(
							diff.created.includes("auth.json") && diff.created.includes("oauth.json.migrated"),
							`expected the legacy auth migration to write auth.json and rename oauth.json; got ${formatDiff(diff)}`,
						);
						expectProjectMigration(dirs.project, true)(result, check);
					},
				}),
			);
		}

		/* B: a private child agent directory, with four ways of giving the child the user's credential. */
		const bPlan = [
			{
				name: "B1",
				title: "private child directory, --api-key on the command line",
				modelsApiKey: undefined,
				extraEnv: {},
				extraArgs: ["--api-key", FIXTURE_KEY],
				notes: ["the key is an argv element, so it is visible to anything that can read the process table"],
			},
			{
				name: "B2",
				title: "private child directory, provider key resolved from the child's environment",
				modelsApiKey: "$SPIKE_FIXTURE_KEY",
				extraEnv: { SPIKE_FIXTURE_KEY: FIXTURE_KEY },
				extraArgs: [],
				notes: [
					"models.json holds a $VAR reference, so the key exists only in the child's environment, never on disk",
					"the key still has to come from somewhere: the pi auth print-api-key step below reads it from the user profile",
				],
			},
			{
				name: "B3",
				title: "private child directory, auth.json symlinked to the user's auth.json",
				modelsApiKey: undefined,
				extraEnv: {},
				extraArgs: [],
				symlinkAuth: true,
				notes: ["no copy of the credential exists, but the child holds a writable handle on the user's auth.json"],
			},
			{
				name: "B4",
				title: "private child directory, both auth.json and models.json symlinked to the user's",
				modelsApiKey: undefined,
				extraEnv: {},
				extraArgs: [],
				symlinkAuth: true,
				symlinkModels: true,
				notes: [
					"nothing is copied: the child reads the user's provider configuration and credential where they are",
					"the refreshed catalog cache still lands next to the symlink, in the child's own directory",
				],
			},
		];
		for (const plan of bPlan) {
			if (!wanted(plan.name)) continue;
			const dirs = setupCase(plan.name);
			writeJson(path.join(dirs.privateAgent, "settings.json"), { defaultProjectTrust: "never" });
			if (plan.symlinkModels) fs.symlinkSync(path.join(dirs.profile, "models.json"), path.join(dirs.privateAgent, "models.json"));
			else writeJson(path.join(dirs.privateAgent, "models.json"), modelsJson(server.baseUrl, plan.modelsApiKey));
			if (plan.symlinkAuth) fs.symlinkSync(path.join(dirs.profile, "auth.json"), path.join(dirs.privateAgent, "auth.json"));
			const args = stockArgs(dirs);
			const result = await runRpcCase({
				name: plan.name,
				title: plan.title,
				piLabel: `${repoPiVersion} (repo dependency)`,
				server,
				command: process.execPath,
				args: [...args, ...plan.extraArgs],
				cwd: dirs.project,
				env: childEnv(root, { agentDir: dirs.privateAgent, sessionDir: dirs.sessions, extra: plan.extraEnv }),
				watch: { source: dirs.profile, private: dirs.privateAgent, project: dirs.project },
				settingsFile: path.join(dirs.privateAgent, "settings.json"),
				notes: plan.notes,
				expect: [expectUnchanged("source", "the user profile"), expectProjectMigration(dirs.project, true)],
			});
			result.observations.childAuthFile = describeAuthFile(path.join(dirs.privateAgent, "auth.json"));
			if (result.observations.childAuthFile.holdsTheCredential && !plan.symlinkAuth) {
				result.failures.push("the child's own auth.json ended up holding a copy of the user's credential");
			}
			results.push(result);
		}

		/*
		 * B5: the same private directory, but the symlink points at a user auth.json that does not exist yet.
		 * Pi creates the file it expects to lock, and the creation lands at the target of the dangling link.
		 */
		if (wanted("B5")) {
			const dirs = setupCase("B5", { legacy: true });
			const sourceAuth = path.join(dirs.profile, "auth.json");
			writeJson(path.join(dirs.privateAgent, "settings.json"), { defaultProjectTrust: "never" });
			writeJson(path.join(dirs.privateAgent, "models.json"), modelsJson(server.baseUrl, "$SPIKE_FIXTURE_KEY"));
			fs.symlinkSync(sourceAuth, path.join(dirs.privateAgent, "auth.json"));
			const result = await runRpcCase({
				name: "B5",
				title: "private child directory, auth.json symlinked to a user auth.json that does not exist",
				piLabel: `${repoPiVersion} (repo dependency)`,
				server,
				command: process.execPath,
				args: stockArgs(dirs),
				cwd: dirs.project,
				env: childEnv(root, { agentDir: dirs.privateAgent, sessionDir: dirs.sessions, extra: { SPIKE_FIXTURE_KEY: FIXTURE_KEY } }),
				watch: { source: dirs.profile, private: dirs.privateAgent, project: dirs.project },
				settingsFile: path.join(dirs.privateAgent, "settings.json"),
				notes: [
					"the credential comes from the child environment, so the run does not depend on the missing file",
					"this case is expected to write: it records a hazard, it does not promise non-interference",
				],
				expect: [
					expectProjectMigration(dirs.project, true),
					(result, check) => {
						const created = result.phases.some((phase) => phase.diffs.source.created.includes("auth.json"));
						result.observations.createdUserAuthFile = created;
						result.observations.userAuthFile = describeAuthFile(sourceAuth);
						check(
							created,
							"expected the dangling symlink to create the user's auth.json; it did not, so this hazard needs rechecking",
						);
					},
				],
			});
			results.push(result);

			/* And the consequence: the empty auth.json it left behind stops the user's own legacy migration. */
			results.push(
				await runStartupCase({
					name: "B5-after",
					title: "the user's next Pi startup, after the empty auth.json B5 left behind",
					piLabel: `${repoPiVersion} (repo dependency)`,
					command: process.execPath,
					args: [...stockArgs(dirs), "--api-key", FIXTURE_KEY],
					cwd: dirs.project,
					env: childEnv(root, { agentDir: dirs.profile, sessionDir: dirs.sessions }),
					watch: { profile: dirs.profile },
					notes: ["compare with A-migrate, which is the same legacy profile without the empty auth.json"],
					expect: (result, check) => {
						const diff = result.phases[0].diffs.profile;
						const migrated = diff.created.includes("oauth.json.migrated");
						result.observations.legacyAuthMigrationRan = migrated;
						result.observations.oauthStillLegacy = fs.existsSync(path.join(dirs.profile, "oauth.json"));
						check(
							!migrated && result.observations.oauthStillLegacy,
							"the legacy auth migration ran after all; the suppression this case is meant to show did not happen",
						);
					},
				}),
			);
		}

		/* B-provider: the model comes from an explicitly loaded provider extension, not from models.json. */
		if (wanted("B-provider")) {
			const dirs = setupCase("B-provider");
			const providerExt = path.join(dirs.caseRoot, "provider-ext.ts");
			write(providerExt, providerExtension(EXTENSION_PROVIDER, FIXTURE_MODEL, server.baseUrl));
			writeJson(path.join(dirs.privateAgent, "settings.json"), { defaultProjectTrust: "never" });
			results.push(
				await runRpcCase({
					name: "B-provider",
					title: "private child directory, provider supplied by an explicitly loaded provider extension",
					piLabel: `${repoPiVersion} (repo dependency)`,
					server,
					provider: EXTENSION_PROVIDER,
					model: FIXTURE_MODEL,
					command: process.execPath,
					args: stockArgs(dirs, {
						model: `${EXTENSION_PROVIDER}/${FIXTURE_MODEL}`,
						extensions: [dirs.bridge, providerExt],
					}),
					cwd: dirs.project,
					env: childEnv(root, { agentDir: dirs.privateAgent, sessionDir: dirs.sessions, extra: { SPIKE_FIXTURE_KEY: FIXTURE_KEY } }),
					watch: { source: dirs.profile, private: dirs.privateAgent, project: dirs.project },
					settingsFile: path.join(dirs.privateAgent, "settings.json"),
					notes: [
						"the child's directory holds no models.json at all; the provider exists only because the role listed the extension",
					],
					expect: [expectUnchanged("source", "the user profile"), expectProjectMigration(dirs.project, true)],
				}),
			);
		}

		/* The credential has to reach B2 somehow; measure the step that reads it out of the user profile. */
		if (wanted("B2")) {
			const dirs = setupCase("B2-auth-read");
			const env = childEnv(root, { agentDir: dirs.profile, sessionDir: dirs.sessions });
			const before = await settledSnapshot({ profile: dirs.profile });
			const printed = await runCli(process.execPath, [repoPiCli, "auth", "print-api-key", "--provider", FIXTURE_PROVIDER], {
				cwd: dirs.project,
				env,
			});
			const after = await settledSnapshot({ profile: dirs.profile });
			const diff = diffSnapshots(before.profile, after.profile);
			const step = {
				name: "B2-auth-read",
				title: "pi auth print-api-key against the user profile (the key source for B2)",
				pi: `${repoPiVersion} (repo dependency)`,
				phases: [{ name: "print-api-key", error: printed.code === 0 ? undefined : `exit ${printed.code}`, diffs: { profile: diff } }],
				observations: {
					exitCode: printed.code,
					printedKeyMatchesSeededCredential: printed.stdout.trim() === FIXTURE_KEY,
					printedBytes: printed.stdout.trim().length,
				},
				notes: ["the printed value is compared in memory and never logged"],
				failures: [],
				stderr: printed.stderr.trim().split("\n").filter(Boolean).slice(-4).join("\n"),
			};
			if (printed.code !== 0) step.failures.push(`pi auth print-api-key exited ${printed.code}`);
			if (printed.stdout.trim() !== FIXTURE_KEY) step.failures.push("pi auth print-api-key did not return the seeded credential");
			results.push(step);
		}

		/* C: the public SDK, no CLI, in-memory settings, the user's model and auth files read in place. */
		if (wanted("C")) {
			const dirs = setupCase("C");
			const bootstrap = path.join(dirs.caseRoot, "bootstrap.mjs");
			const config = path.join(dirs.caseRoot, "bootstrap.json");
			const providerExt = path.join(dirs.caseRoot, "provider-ext.ts");
			write(bootstrap, bootstrapSource);
			write(providerExt, providerExtension(EXTENSION_PROVIDER, FIXTURE_MODEL, server.baseUrl));
			writeJson(config, {
				packageEntry,
				authPath: path.join(dirs.profile, "auth.json"),
				modelsPath: path.join(dirs.profile, "models.json"),
				modelsStorePath: path.join(dirs.privateAgent, "models-store.json"),
				agentDir: dirs.privateAgent,
				sessionDir: dirs.sessions,
				cwd: dirs.project,
				extensionPaths: [dirs.bridge, providerExt],
				provider: FIXTURE_PROVIDER,
				model: FIXTURE_MODEL,
				tools: ["read"],
			});
			const result = await runRpcCase({
				name: "C",
				title: "public SDK bootstrap: in-memory settings, user model/auth files read in place",
				piLabel: `${repoPiVersion} (repo dependency, public exports)`,
				server,
				command: process.execPath,
				args: [bootstrap, config],
				cwd: dirs.project,
				env: childEnv(root, { agentDir: dirs.privateAgent, sessionDir: dirs.sessions, extra: { SPIKE_FIXTURE_KEY: FIXTURE_KEY } }),
				watch: { source: dirs.profile, private: dirs.privateAgent, project: dirs.project },
				notes: [
					"no CLI, so no startup migrations run",
					"settings are in memory, so the setters have no file to write",
					"an explicitly listed provider extension rides along, to see whether the SDK path registers it",
				],
				expect: [
					expectUnchanged("source", "the user profile"),
					expectProjectMigration(dirs.project, false),
					(result, check) => {
						result.observations.providerExtensionModelAvailable = (result.observations.availableModels ?? []).includes(
							`${EXTENSION_PROVIDER}/${FIXTURE_MODEL}`,
						);
						check(
							result.observations.providerExtensionModelAvailable,
							"the explicitly listed provider extension did not register its model through the SDK path",
						);
					},
				],
			});
			result.observations.childAuthFile = describeAuthFile(path.join(dirs.privateAgent, "auth.json"));
			results.push(result);
		}

		/* Optional, clearly labelled: the same stock-CLI case against another installed Pi. */
		if (altPiCli && wanted("A-alt")) {
			const dirs = setupCase("A-alt");
			const args = stockArgs(dirs);
			args[0] = altPiCli;
			results.push(
				await runRpcCase({
					name: "A-alt",
					title: "stock CLI in RPC, user agent directory, alternate installation",
					piLabel: `${altVersion} (--pi ${altPiCli})`,
					server,
					command: altPiCli,
					args: args.slice(1),
					cwd: dirs.project,
					env: childEnv(root, { agentDir: dirs.profile, sessionDir: dirs.sessions }),
					watch: { profile: dirs.profile, project: dirs.project },
					settingsFile: path.join(dirs.profile, "settings.json"),
					notes: [`this is Pi ${altVersion}, not the repository's ${repoPiVersion}; treat it as a comparison only`],
				}),
			);
		}

		if (IMPL_GROUPS.some((group) => wantedGroup(group))) {
			await implementationCases({ root, server, setupCase, wanted: wantedGroup, results });
		}

		if (onlyCase && results.length === 0) {
			console.log(`no case is named ${onlyCase}`);
			process.exitCode = 2;
			return;
		}

		console.log(`pi-fusion spike: keeping a Pi child out of the user's configuration (stage: ${stage})`);
		console.log(`node ${process.version}, ${new Date().toISOString()}`);
		console.log(`pi under test: ${repoPiVersion} (repository dependency) at ${repoPiCli}`);
		if (altPiCli) console.log(`comparison pi: ${altVersion} at ${altPiCli}`);
		console.log(`temp root: ${root}${keepRoot ? " (kept)" : " (removed on exit)"}`);
		console.log(`fixture model server: ${server.baseUrl}`);
		console.log(`\npublic exports of @earendil-works/pi-coding-agent: ${JSON.stringify(exportProbe)}`);
		for (const result of results) printCase(result);

		// Each RPC case already asserts its own slice of these; this is the running total for the whole run.
		console.log(`\nfixture model requests: ${server.requests.length} (each case asserts its own slice)`);
		const unexpected = server.requests.filter((request) => !request.url.endsWith("/chat/completions"));
		if (unexpected.length > 0) console.log(`  unexpected fixture paths: ${JSON.stringify(unexpected)}`);

		const failed = results.filter((result) => classifyResult(result) === "failed");
		console.log(`\n${summaryLine(results)}`);
		if (keepRoot) writeJson(path.join(root, "report.json"), { results: results.map((r) => ({ ...r, phases: r.phases.map((p) => ({ ...p, diffs: undefined, diff: Object.fromEntries(Object.entries(p.diffs).map(([k, v]) => [k, formatDiff(v)])) })) })), exportProbe });
		process.exitCode = failed.length === 0 ? 0 : 1;
	} finally {
		await server.close();
		if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
	}
}

/* --------------------------------------- implementation-stage cases (step 4, task 2b) */

/*
 * Everything below measures the production modules that landed in task 2a — `extensions/backends/pi-storage.ts`,
 * `extensions/backends/pi-launch.ts` and `extensions/backends/pi-bootstrap.mjs` — against real SDK children. The
 * cases above stay what they were: they compared ways of starting a child before the bootstrap existed, and they are
 * re-run unchanged to show these cases leave the user's files alone the same way.
 *
 * What runs a call here is `test/spikes/pi-storage-caller.mjs`, a fixture controller that calls the production
 * helpers and inherits its child's stdio, so this harness drives the real child. It stands in for the Pi transport
 * that step 4 task 6 will write; nothing here is a transport, a bridge, a registered backend or a production
 * environment override, and no host session entry, history file or dashboard record is written by any of it.
 */

const spikeDir = path.dirname(fileURLToPath(import.meta.url));
/** The production bootstrap, imported for its own constants: the exit code, the refusal wording and its level list. */
const bootstrapModule = await import(pathToFileURL(path.join(repoRoot, "extensions", "backends", "pi-bootstrap.mjs")).href);
/** The production role binding, imported for the tool list a role actually runs with: no case writes one of its own. */
const bindingModule = await import(pathToFileURL(path.join(repoRoot, "extensions", "backends", "pi-binding.ts")).href);
/** A role's own tools, as the binding resolves them with an empty environment, so a case adds to that list rather than replacing it. */
const p5RoleTools = (role, model = `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`) => bindingModule.piRole({ role, model }, undefined, {}).tools;
const FETCH_GUARD = path.join(spikeDir, "pi-fetch-guard.mjs");
/** The second preload, loaded after the guard and never instead of it, for the helper-download cases alone. */
const HELPER_INTERPOSER = path.join(spikeDir, "pi-helper-interposer.mjs");
const STORAGE_CALLER = path.join(spikeDir, "pi-storage-caller.mjs");
const CONTRACT_FILE = path.join(repoRoot, "contracts", "implement.md");
/** The other contract a real role in this build runs under: the concurrent cases below pair an `ask` child with an `implement` one. */
const ASK_CONTRACT_FILE = path.join(repoRoot, "contracts", "ask-answer.md");
/** Which builtin providers a catalog case will take its exact model from, in the order it prefers them. */
const BUILTIN_PREFERENCE = ["deepseek", "openai", "groq", "mistral"];
const BUILTIN_KEY_VARIABLE = { deepseek: "DEEPSEEK_API_KEY", openai: "OPENAI_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY" };
/** A dummy provider key: it makes a builtin provider's models available, and no request of any case ever carries it. */
const DUMMY_PROVIDER_KEY = "spike-dummy-provider-key-not-a-secret";
/**
 * The api-key variables the catalog cases set to that dummy value. Pi refreshes a provider's catalog only where the
 * provider is configured, so several of them are what gives the shared store several entries — which is what makes a
 * lost or truncated entry visible in the concurrent case. None of these providers is ever sent a request.
 */
const DUMMY_PROVIDER_KEYS = Object.fromEntries(
	["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "TOGETHER_API_KEY", "FIREWORKS_API_KEY", "NVIDIA_API_KEY"].map((name) => [name, DUMMY_PROVIDER_KEY]),
);
/** The model the loopback catalog fixture adds to every provider, so a persisted overlay is visible in the child. */
const CANARY_MODEL = "spike-canary-remote";
/** Later than the installed build's own catalog stamp, or Pi discards the overlay it just stored. */
const CATALOG_LAST_MODIFIED = "Sun, 20 Sep 2026 00:00:00 GMT";
/** A marker that stands in for a credential inside a malformed models file. Startup must not echo it. */
const MODELS_MARKER = "SPIKE-MARKER-DUMMY-CREDENTIAL-do-not-echo";
const FUSION_MANAGED_DIR = "pi-fusion";
/** The call directory's compiler caches, as the production layout names them. */
const CALL_CACHE_DIR = "cache";
const CALL_CACHE_SUBDIRS = ["jiti", "node"];

const IMPL_GROUPS = ["G", "P1", "P2", "P3", "P4", "P5", "P6", "P7"];
const originOf = (url) => new URL(url).origin;

/* -------------------------------------------------------- loopback catalog and control fixtures */

/**
 * The model catalog endpoint Pi refreshes from, on loopback: `GET /api/models/providers/<id>`. One server per caller,
 * which is how a request is attributed — a child is configured with one catalog origin and can reach no other, so a
 * request that arrives here was made by that caller's process. `gate` holds a response open, which is how two real
 * children are shown to overlap.
 */
async function startCatalogServer({ label, gate }) {
	const requests = [];
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const match = /^\/api\/models\/providers\/(.+)$/.exec(url.pathname);
		const record = { label, method: req.method, path: url.pathname, provider: match ? decodeURIComponent(match[1]) : undefined, at: Date.now() };
		requests.push(record);
		if (!match || req.method !== "GET") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: `unexpected ${req.method} ${url.pathname}` }));
			return;
		}
		const answer = () => {
			record.respondedAt = Date.now();
			res.writeHead(200, { "content-type": "application/json", "last-modified": CATALOG_LAST_MODIFIED, etag: `"spike-${record.provider}"` });
			res.end(
				JSON.stringify([
					{
						id: CANARY_MODEL,
						name: `Spike canary (${record.provider})`,
						reasoning: false,
						input: ["text"],
						contextWindow: 32000,
						maxTokens: 1024,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				]),
			);
		};
		if (!gate) {
			answer();
			return;
		}
		Promise.resolve(gate(record)).then(answer, answer);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		label,
		origin: `http://127.0.0.1:${port}`,
		requests,
		catalogRequests: () => requests.filter((request) => request.provider !== undefined),
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/**
 * A loopback listener that answers every request with a 302 to somewhere else, and records what it was asked for. The
 * redirect control needs one on an allowed origin so the guard's promise — that no redirect is ever followed
 * automatically — is measured rather than read off the source. The target is always another loopback listener of this
 * fixture's; no real provider or download endpoint is ever named here.
 */
async function startRedirectServer({ label, location }) {
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push({ label, method: req.method, path: req.url, at: Date.now() });
		res.writeHead(302, { location, "content-type": "text/plain" });
		res.end("redirecting");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		label,
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** A loopback listener that must never be reached: it exists to be counted, and it answers 200 if it ever is. */
async function startForbiddenServer({ label }) {
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push({ label, method: req.method, path: req.url, at: Date.now() });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ reached: true }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		label,
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** A loopback barrier: a staged publisher blocks on `GET /barrier/<name>` until this harness releases it. */
async function startControlServer() {
	const held = new Map();
	const entry = (name) => {
		let found = held.get(name);
		if (!found) {
			found = { arrived: undefined, released: undefined, waiters: [] };
			found.arrival = new Promise((resolve) => {
				found.arrived = resolve;
			});
			found.gate = new Promise((resolve) => {
				found.released = resolve;
			});
			held.set(name, found);
		}
		return found;
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const name = url.pathname.startsWith("/barrier/") ? url.pathname.slice("/barrier/".length) : undefined;
		if (!name) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end("{}");
			return;
		}
		const found = entry(name);
		found.arrivedAt = Date.now();
		found.arrived();
		found.gate.then(() => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ released: true }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}`,
		url: (name) => `http://127.0.0.1:${port}/barrier/${name}`,
		/** Bounded: a barrier nobody reaches fails its case instead of hanging the run. */
		waitFor: async (name, deadlineMs = 120_000) => {
			const found = entry(name);
			const timeout = sleep(deadlineMs).then(() => "timeout");
			return (await Promise.race([found.arrival.then(() => "arrived"), timeout])) === "arrived";
		},
		release: (name) => entry(name).released(),
		arrivedAt: (name) => held.get(name)?.arrivedAt,
		close: () => {
			for (const found of held.values()) found.released();
			return new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			});
		},
	};
}

/**
 * A rendezvous between two real children, used as a catalog response barrier: a gated request is held until every
 * label has one in flight, so both children are provably inside their catalog refresh at the same moment. A retried
 * attempt re-arrives under the same label, which is why arrivals are counted as in-flight requests rather than once.
 */
function requestRendezvous(labels, deadlineMs) {
	const inFlight = new Map(labels.map((label) => [label, 0]));
	const waiters = [];
	const state = { met: false, metAt: undefined, timedOut: false, firstArrivalAt: undefined };
	const releaseAll = () => {
		for (const waiter of waiters.splice(0)) waiter();
	};
	// The deadline is how long one arrival waits for the other, so it starts at the first arrival rather than when this
	// was built: a child that takes its time starting must not spend the window before it has asked for anything. The
	// outer waits are unchanged — the RPC deadlines and the controllers' own exits still bound the case.
	let timer;
	const openWindow = () => {
		if (timer !== undefined) return;
		state.firstArrivalAt = Date.now();
		timer = setTimeout(() => {
			state.timedOut = true;
			releaseAll();
		}, deadlineMs);
	};
	return {
		state,
		async hold(label) {
			openWindow();
			inFlight.set(label, (inFlight.get(label) ?? 0) + 1);
			if ([...inFlight.values()].every((count) => count > 0)) {
				state.met = true;
				state.metAt = Date.now();
				clearTimeout(timer);
				releaseAll();
			} else if (!state.met && !state.timedOut) {
				await new Promise((resolve) => waiters.push(resolve));
			}
			inFlight.set(label, (inFlight.get(label) ?? 1) - 1);
		},
		done: () => {
			if (timer !== undefined) clearTimeout(timer);
		},
	};
}

/* ----------------------------------------------------------------- environment and snapshots */

/**
 * The variables this composition decides for itself, which the raw pass-through below may not name. They are refused
 * rather than overwritten, because `rawExtra` is assigned last: a case that named one of these would silently replace
 * the search path this harness constructed, the preload that installs the guard, or one of the three values the guard
 * reads to know who it is watching and where it may go. Everything else still passes through — the package cases' own
 * `npm_config_registry` and this file's helper log among them — so this is a check on one fixture's own input and not a
 * sandbox, a policy or a claim about what a child can reach.
 *
 * The last three are the helper-fetch interposer's, added for the same reason: a raw value that replaced the mapped url
 * list, the loopback origin they are mapped to or the interposer's own log would leave a download case measuring
 * something nobody composed. They are set by `interposer` below and by nothing else.
 */
const IMPL_RESERVED_VARIABLES = [
	"PATH",
	"NODE_OPTIONS",
	"PI_SPIKE_CALLER",
	"PI_SPIKE_FETCH_LOG",
	"PI_SPIKE_ALLOWED_ORIGINS",
	"PI_SPIKE_HELPER_ORIGIN",
	"PI_SPIKE_HELPER_URLS",
	"PI_SPIKE_INTERPOSER_LOG",
];

/**
 * A child environment for an implementation-stage case: `childEnv`'s sanitized one, plus the three variables the
 * fetch guard reads and the preload that installs it. They are added after `childEnv` returns on purpose — its guard
 * treats every value holding a separator as a directory to create inside the temp root, and a log file, an origin
 * list and a `--import` option are none of those. `PI_OFFLINE` is deleted rather than set to an empty string, because
 * Pi enables its own model network exactly when the variable is absent.
 *
 * `offline` takes `true` for the sanitized default of `1`, `false` for a case that needs the variable **absent**, and
 * an exact string for a case that measures what one particular value does to a real child: an empty string is one of
 * those values, which is why it is assigned here rather than passed through `childEnv`'s own defaults.
 */
function implEnv(root, { agentDir, sessionDir, caller, origins, fetchLog, offline = true, extra = {}, guardFile = FETCH_GUARD, fence = false, interposer, pathPrefix, rawExtra = {} }) {
	const guard = pathToFileURL(guardFile).href;
	const rootReal = fs.realpathSync(root);
	// Checked before anything is composed, and case-insensitively: a platform that reads `Path` as `PATH` must not be a
	// way around the list, and a refusal is only useful before the value it would have replaced has been built.
	for (const name of Object.keys(rawExtra)) {
		const reserved = IMPL_RESERVED_VARIABLES.find((one) => one.toLowerCase() === name.toLowerCase());
		if (reserved !== undefined) throw new Error(`refusing to launch: a raw pass-through value may not name ${name}, which this composition decides itself (${IMPL_RESERVED_VARIABLES.join(", ")})`);
	}
	// Either this spike's own guard, or a deliberately mutated copy of it inside the disposable root whose name says so:
	// the guard's own control cases need the second, and nothing else may quietly substitute a file for it.
	const mutated = path.basename(guardFile).startsWith("mutated-guard") && path.resolve(guardFile).startsWith(`${rootReal}${path.sep}`);
	if (!fs.existsSync(guardFile) || !(path.dirname(guardFile) === spikeDir || mutated)) throw new Error(`the fetch guard must be this spike's own file or a mutated copy under the temp root; ${guardFile} is neither`);
	if (/\s/.test(guard)) throw new Error(`the fetch guard's path holds whitespace, which NODE_OPTIONS cannot carry: ${guard}`);
	if (!path.resolve(fetchLog).startsWith(`${rootReal}${path.sep}`)) throw new Error(`the fetch log ${fetchLog} is outside the temp root`);
	// A case that constructs the child's whole search path itself names every entry in it, and every one of them has to
	// be inside the disposable root: nothing outside it may be on a child's PATH. The ordinary copied path the cases
	// above run with is not constrained here — it is this machine's own, it is what those cases are about, and
	// `childEnv` deliberately leaves it alone.
	if (typeof extra.PATH === "string") {
		for (const entry of extra.PATH.split(path.delimiter)) {
			if (!entry) throw new Error("a constructed PATH must not carry an empty entry, which is the working directory to every platform's own lookup");
			const resolved = path.resolve(entry);
			if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error(`refusing to launch: the constructed PATH entry ${entry} is outside the temp root ${rootReal}`);
		}
	}
	const env = childEnv(root, { agentDir, sessionDir, extra });
	if (offline === false) delete env.PI_OFFLINE;
	else if (typeof offline === "string") env.PI_OFFLINE = offline;
	env.PI_SPIKE_CALLER = caller;
	env.PI_SPIKE_FETCH_LOG = fetchLog;
	env.PI_SPIKE_ALLOWED_ORIGINS = origins.join(",");
	const preloads = [`--import ${guard}`];
	// The second preload, for the input-refusal cases alone: this repository's own test-only module fence, named by its
	// own path rather than by anything a case composes, and required to be the file that says what that fence says.
	if (fence) {
		const fenceUrl = pathToFileURL(SDK_FENCE).href;
		if (!fs.existsSync(SDK_FENCE)) throw new Error(`the sdk fence must be this repository's own ${SDK_FENCE}, and it is not there`);
		if (!fs.readFileSync(SDK_FENCE, "utf8").includes(SDK_FENCE_MARKER)) throw new Error(`${SDK_FENCE} does not carry ${JSON.stringify(SDK_FENCE_MARKER)}, so it is not the fence this harness requires`);
		if (/\s/.test(fenceUrl)) throw new Error(`the sdk fence's path holds whitespace, which NODE_OPTIONS cannot carry: ${fenceUrl}`);
		preloads.push(`--import ${fenceUrl}`);
	}
	// The third preload, for the helper-download cases alone, and always after the guard: it captures the guarded
	// `fetch` rather than replacing it. Everything it is given is checked here, before a child could be launched on a
	// mapping this harness did not mean — the file is this spike's own with no mutated copy allowed, the origin has to
	// be a loopback listener with a port, every mapped url has to be an exact absolute url with a path, and the log has
	// to be inside the disposable root. A real origin as the mapping target is refused twice, here and in the preload.
	if (interposer !== undefined) {
		const interposerUrl = pathToFileURL(HELPER_INTERPOSER).href;
		if (!fs.existsSync(HELPER_INTERPOSER)) throw new Error(`the helper interposer must be this spike's own ${HELPER_INTERPOSER}, and it is not there`);
		if (/\s/.test(interposerUrl)) throw new Error(`the helper interposer's path holds whitespace, which NODE_OPTIONS cannot carry: ${interposerUrl}`);
		let origin;
		try {
			origin = new URL(interposer.origin);
		} catch {
			throw new Error(`the interposer origin ${JSON.stringify(interposer.origin)} is not a url`);
		}
		if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || !origin.port || origin.origin !== interposer.origin) {
			throw new Error(`the interposer origin ${JSON.stringify(interposer.origin)} is not an exact loopback origin with a port, and only a listener this harness owns may be mapped to`);
		}
		if (!Array.isArray(interposer.urls) || interposer.urls.length === 0) throw new Error("the interposer needs an explicit list of exact urls to map, and it was given none");
		for (const value of interposer.urls) {
			let url;
			try {
				url = new URL(value);
			} catch {
				throw new Error(`the interposer url ${JSON.stringify(value)} is not an absolute url`);
			}
			if (url.href !== value || url.pathname === "/" || url.search !== "" || url.hash !== "") throw new Error(`the interposer url ${JSON.stringify(value)} is not an exact normalized url naming a path, so no exact mapping could be asserted for it`);
			if (value.includes(",")) throw new Error(`the interposer url ${JSON.stringify(value)} holds a comma, which is the separator the list is carried in`);
		}
		if (!path.resolve(interposer.log).startsWith(`${rootReal}${path.sep}`)) throw new Error(`the interposer log ${interposer.log} is outside the temp root`);
		preloads.push(`--import ${interposerUrl}`);
	}
	env.NODE_OPTIONS = preloads.join(" ");
	// A directory of this case's own in front of the inherited PATH, which is how the installer shims are reached. It
	// has to be inside the temp root: nothing outside it may be put in front of a child's PATH.
	if (pathPrefix !== undefined) {
		if (!path.resolve(pathPrefix).startsWith(`${rootReal}${path.sep}`)) throw new Error(`the path prefix ${pathPrefix} is outside the temp root`);
		env.PATH = `${pathPrefix}${path.delimiter}${env.PATH}`;
	}
	// Values that are not directories and must not be treated as ones: `childEnv` creates a directory for every value
	// holding a separator, and a registry url is a url. The interposer's three are assigned here for the same reason —
	// a url, a comma-separated url list and a log file are none of them a directory to create.
	if (interposer !== undefined) {
		env.PI_SPIKE_HELPER_ORIGIN = interposer.origin;
		env.PI_SPIKE_HELPER_URLS = interposer.urls.join(",");
		env.PI_SPIKE_INTERPOSER_LOG = interposer.log;
	}
	for (const [name, value] of Object.entries(rawExtra)) env[name] = value;
	if (env.PI_FUSION_HISTORY !== undefined) throw new Error("a case environment must not carry PI_FUSION_HISTORY");
	return env;
}

/** The managed subtree is Fusion's own, so the user-profile comparison excludes it and it is inspected separately. */
const withoutManaged = (entries) => new Map([...entries].filter(([rel]) => rel !== FUSION_MANAGED_DIR && !rel.startsWith(`${FUSION_MANAGED_DIR}/`)));

const implSnapshot = (watch) =>
	Object.fromEntries(
		Object.entries(watch).map(([name, spec]) => {
			const entries = snapshot(spec.dir);
			return [name, spec.excludeManaged ? withoutManaged(entries) : entries];
		}),
	);

/** Three agreeing reads before a diff is attributed, the same rule the cases above use for Pi's async writes. */
async function implSettled(watch, { pollMs = 120, stableReads = 3, maxPolls = 25 } = {}) {
	let current = implSnapshot(watch);
	let stable = 0;
	for (let i = 0; i < maxPolls; i++) {
		await sleep(pollMs);
		const next = implSnapshot(watch);
		stable = sameSnapshots(current, next) ? stable + 1 : 0;
		current = next;
		if (stable >= stableReads) return current;
	}
	return current;
}

const implDiffs = (before, after) => Object.fromEntries(Object.keys(before).map((name) => [name, diffSnapshots(before[name], after[name])]));

/* --------------------------------------------------------------------- the implementation runner */

/** One implementation-stage case: the same result shape the cases above print, without their fixed phase sequence. */
function implResult(name, title, notes = []) {
	const result = { name, title, pi: `${repoPiVersion} (repo dependency, production bootstrap)`, phases: [], observations: {}, notes: [...notes], failures: [] };
	result.check = (ok, message) => {
		if (!ok) result.failures.push(message);
		return ok;
	};
	return result;
}

/** The diagnostic lines the production bootstrap wrote, which is the only thing it is allowed to put on stderr. */
function bootstrapDiagnostics(stderr) {
	const lines = [];
	for (const line of stderr.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed.event === "pi-fusion-bootstrap") lines.push(parsed);
		} catch {
			// Not a diagnostic line: the child's own output and the controller's notes share this stream.
		}
	}
	return lines;
}

const fetchRecords = (file, caller) => {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		// A log that cannot be read is the absence of evidence, not the evidence of absence: it is reported as its own
		// record so a case that claims "no request was made" fails instead of passing on an empty array.
		return [{ caller, event: "log-missing", file }];
	}
	const records = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (caller === undefined || parsed.caller === caller || parsed.caller === `${caller}/child`) records.push(parsed);
		} catch {
			records.push({ event: "unparsed", line });
		}
	}
	return records;
};

/** What one call's controller is given. Every path in it is inside the harness's disposable root. */
function callSpec({ dirs, caller, handle, role, session, controlled, observations, stagedBarrier, contractFile = CONTRACT_FILE }) {
	return {
		caller,
		repoRoot,
		hostAgentDir: dirs.profile,
		cwd: dirs.project,
		handle,
		role,
		contractFile,
		session,
		...(controlled === undefined ? {} : { controlled }),
		...(stagedBarrier === undefined ? {} : { stagedBarrier }),
		observations,
	};
}

/** Starts a controller process and returns it as an RPC child: its stdio is the real Pi child's. */
function startCaller(specFile, spec, { cwd, env }) {
	writeJson(specFile, spec);
	return new RpcChild(process.execPath, [STORAGE_CALLER, "call", specFile], { cwd, env });
}

/** Ends the call and reports the controller's exit together with what it recorded. */
async function finishCaller(child, observationsFile) {
	const exit = await child.close();
	return { exit, observations: readJsonIfPresent(observationsFile) ?? { missing: true }, stderr: child.stderr };
}

const isProcessGone = (pid) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error?.code === "ESRCH";
	}
};

/** The probes every implementation-stage child answers, in the shapes the adapter will read. */
async function probeChild(child, result, { provider, model, effort, requested = effort, key = "probe" }) {
	const probe = {};
	result.observations[key] = probe;
	const state = await child.send({ type: "get_state" }, 90_000);
	result.check(state.success === true, `get_state failed: ${state.error ?? ""}`);
	const selected = state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : null;
	probe.state = {
		model: selected,
		thinkingLevel: state.data?.thinkingLevel ?? null,
		sessionId: state.data?.sessionId ?? null,
		sessionFile: state.data?.sessionFile ?? null,
		messageCount: state.data?.messageCount ?? null,
	};
	result.check(selected === `${provider}/${model}`, `the child runs ${selected} instead of the exact ${provider}/${model} the call named`);
	// What the call asked for and what the child came up with are both recorded: a model that does not offer the level
	// asked for is answered with one of its own, and the read-back that decides what to do about that is task 7's.
	probe.thinkingLevel = { requested: requested ?? null, reported: state.data?.thinkingLevel ?? null };
	if (effort !== undefined) result.check(state.data?.thinkingLevel === effort, `the child's thinking level is ${JSON.stringify(state.data?.thinkingLevel)} instead of the ${effort} the call named`);
	const models = await child.send({ type: "get_available_models" }, 60_000);
	result.check(models.success === true, "get_available_models failed");
	const listed = models.data?.models;
	result.check(Array.isArray(listed), "get_available_models did not answer with a models array");
	probe.availableModels = (listed ?? []).map((entry) => `${entry.provider}/${entry.id}`).sort();
	result.check(probe.availableModels.includes(`${provider}/${model}`), `${provider}/${model} is not in get_available_models`);
	const levels = await child.send({ type: "get_available_thinking_levels" }, 60_000);
	result.check(levels.success === true, "get_available_thinking_levels failed");
	probe.thinkingLevels = levels.data?.levels ?? null;
	result.check(Array.isArray(levels.data?.levels) && levels.data.levels.every((level) => typeof level === "string"), "get_available_thinking_levels did not answer with a list of level names");
	result.check(
		(levels.data?.levels ?? []).every((level) => bootstrapModule.THINKING_LEVELS.includes(level)),
		`the child offers a thinking level the bootstrap does not know: ${JSON.stringify(levels.data?.levels)}`,
	);
	return { state: state.data ?? {}, probe };
}

/**
 * The three places inside the managed root a call may write, and their own descendants. Matched segment by segment
 * rather than by prefix: `children/catalogue`, `children/sessionsX` and `calls-elsewhere` are strays that a prefix
 * test would wave through, and `managedFilterSelfCheck` asserts each of them is caught.
 */
const MANAGED_WRITEABLE = [
	["children", "catalog"],
	["children", "sessions"],
	["calls"],
];

function managedPathIsExpected(rel) {
	const segments = rel.split("/");
	// Expected means: inside one of the three, one of them exactly, or a directory on the way to one — which is what a
	// diff reports when `children` itself appears. Every comparison is a whole segment against a whole segment.
	return MANAGED_WRITEABLE.some((allowed) => {
		const shared = Math.min(allowed.length, segments.length);
		return allowed.slice(0, shared).every((segment, index) => segments[index] === segment);
	});
}

/**
 * The filter's own negative control, run as a case so it is reported rather than trusted: every path a call may write
 * is expected, and every look-alike a prefix test would have waved through is caught.
 */
function managedFilterSelfCheck() {
	const result = implResult("G-managed-filter", "the managed-root filter matches directory names by segment, not by prefix", [
		"a pure check of the harness's own predicate: no process, no child, no fixture",
	]);
	const expected = ["children", "children/catalog", "children/catalog/models-store.json", "children/sessions", "children/sessions/project-abc/2026.jsonl", "calls", "calls/run-1-ab12/bootstrap.json"];
	const strays = ["children/catalogue", "children/catalogue/models-store.json", "children/sessionsX", "children/sessionsX/y", "calls-elsewhere", "calls-elsewhere/z", "children/models.json", "children/bin/rg", "helpers", "children/catalog-old/models-store.json"];
	result.observations.expectedAccepted = expected.filter((rel) => managedPathIsExpected(rel));
	result.observations.straysCaught = strays.filter((rel) => !managedPathIsExpected(rel));
	result.check(result.observations.expectedAccepted.length === expected.length, `the filter rejected a path a call legitimately writes: ${expected.filter((rel) => !managedPathIsExpected(rel)).join(", ")}`);
	result.check(result.observations.straysCaught.length === strays.length, `the filter accepted a stray: ${strays.filter((rel) => managedPathIsExpected(rel)).join(", ")}`);
	return result;
}

/**
 * What a call directory held apart from the compiler caches the layout makes inside it. The caches are the call's own
 * and are named by the layout, so a case that is about what Pi wrote there reads the rest of the directory; whether the
 * caches are there, and inside the call directory, is asserted on its own by `checkManagedCall`.
 */
const callEntriesOutsideCache = (entries) => (entries ?? []).filter((rel) => rel !== `${CALL_CACHE_DIR}/` && !rel.startsWith(`${CALL_CACHE_DIR}/`));

/** Every assertion that is the same in every implementation-stage case, asserted from what the caller recorded. */
function checkManagedCall(result, observations, { dirs, diffs, expectSharedAuth, alongsideAnotherCall = false, seededManaged = [], helperArtifacts = [], projectCreated, profileModified = [] }) {
	result.check(observations.error === undefined, `the caller failed: ${observations.error ?? ""}`);
	result.check(observations.disposed === true, "the call directory was not disposed of");
	result.check(observations.env?.PI_FUSION_HISTORY === null, "PI_FUSION_HISTORY reached the caller's environment");
	result.check(observations.launch?.childAgentDir === observations.storage?.agentDir, "the child's PI_CODING_AGENT_DIR is not the Fusion-owned child agent directory");
	result.check(observations.launch?.childMarker === "pi", `the child carried PI_FUSION_CHILD=${JSON.stringify(observations.launch?.childMarker)} instead of the pi marker`);
	// The two compiler caches are inside the call's own directory, so they go when it is disposed of: the caller's own
	// inherited values, which this harness points inside the temp root, are recorded beside them to show the retargeting.
	const callDir = observations.storage?.callDir;
	const cacheDir = observations.storage?.cacheDir;
	result.check(cacheDir === path.join(callDir ?? "", CALL_CACHE_DIR), `the call's cache directory is ${JSON.stringify(cacheDir)} and not inside its own call directory`);
	for (const [variable, sub] of [["childJitiCache", "jiti"], ["childNodeCompileCache", "node"]]) {
		const value = observations.launch?.[variable];
		result.check(value === path.join(cacheDir ?? "", sub), `the child's ${variable} is ${JSON.stringify(value)} and not this call's own ${sub} cache`);
		result.check(value !== observations.launch?.[variable.replace("child", "caller")], `the child inherited the caller's ${variable} instead of a cache of its own`);
	}
	const cacheEntries = (observations.callDirEntries ?? []).filter((rel) => rel === `${CALL_CACHE_DIR}/` || rel.startsWith(`${CALL_CACHE_DIR}/`));
	for (const sub of CALL_CACHE_SUBDIRS) {
		result.check(cacheEntries.includes(`${CALL_CACHE_DIR}/${sub}/`), `the call directory held no ${CALL_CACHE_DIR}/${sub} directory: ${JSON.stringify(cacheEntries)}`);
	}
	// The child's search path, asserted rather than only recorded: the caller's own value with the host's helper bin
	// after it, exactly, and the caller's own left as it was. Every profile this harness builds sits under the temp
	// root and carries no path delimiter in its name, so the production classifier has to answer `appended` here —
	// a launch that stopped appending, or one that mutated the environment it was handed, fails instead of passing
	// quietly. This is an assertion about the launch options and nothing more: whether a child's own helper lookup
	// then finds anything in that directory is not measured anywhere in this stage.
	const originalPath = observations.launch?.callerPathBefore;
	const hostBin = observations.launch?.hostBinDir;
	result.check(typeof originalPath === "string" && originalPath.length > 0, `the caller's PATH before the launch was ${JSON.stringify(originalPath)}, and an append can only be asserted against a non-empty one`);
	result.check(typeof hostBin === "string" && hostBin.length > 0 && !hostBin.includes(path.delimiter), `the host helper bin ${JSON.stringify(hostBin)} is empty or holds this platform's path delimiter, so no append could be asserted for it`);
	result.check(observations.launch?.hostBinPlacement === "appended", `the production classifier answered ${JSON.stringify(observations.launch?.hostBinPlacement)} rather than "appended" for a representable bin and a non-empty search path`);
	result.check(
		observations.launch?.childPath === `${originalPath}${path.delimiter}${hostBin}`,
		`the child's PATH is ${JSON.stringify(observations.launch?.childPath)} rather than the caller's own with ${JSON.stringify(hostBin)} appended after one delimiter`,
	);
	result.check(observations.launch?.callerPathAfter === originalPath, "composing the launch changed the caller's own PATH, and a child's environment is supposed to be a copy");
	result.check(observations.launch?.childAgentDir !== dirs.profile, "the child's agent directory is the user's own profile");
	result.check(observations.storage?.agentDir?.startsWith(path.join(dirs.profile, FUSION_MANAGED_DIR)), "the managed child agent directory is not inside <host-agent-dir>/pi-fusion");
	if (expectSharedAuth !== undefined) result.check(observations.storage?.sharedAuth === expectSharedAuth, `sharedAuth is ${observations.storage?.sharedAuth} and this case expects ${expectSharedAuth}`);
	// The user's own files, with one exact allowance: the authorized rotation writes the credential file back, so a case
	// that expects one names it here and everything else still has to be empty — the modified set exactly as expected,
	// and nothing created or removed at all. It is a list of paths rather than a relaxed comparison, and the transient
	// adjacent `auth.json.lock` is not on it: a lock still there when this diff is taken is a created path and fails.
	if (profileModified.length === 0) result.check(isEmptyDiff(diffs.profile), `the user's own files changed: ${formatDiff(diffs.profile)}`);
	else {
		const expected = [...profileModified].sort().join(",");
		result.check(
			[...diffs.profile.modified].sort().join(",") === expected && diffs.profile.created.length === 0 && diffs.profile.removed.length === 0,
			`the user's own files changed ${formatDiff(diffs.profile)} rather than exactly a modified ${expected}`,
		);
	}
	// A case that deliberately has its child write in the project names exactly what it expects, and everything else
	// still has to be an empty diff: the exemption is a list of paths, never a relaxed comparison.
	if (projectCreated === undefined) result.check(isEmptyDiff(diffs.project), `the project changed: ${formatDiff(diffs.project)}`);
	else {
		const created = [...diffs.project.created].sort().join(",");
		result.check(
			created === [...projectCreated].sort().join(",") && diffs.project.modified.length === 0 && diffs.project.removed.length === 0,
			`the project changed ${formatDiff(diffs.project)} rather than exactly ${[...projectCreated].sort().join(", ")}`,
		);
	}
	result.check(isEmptyDiff(diffs.decoySessions), `the inherited session directory was written to although the child takes its session directory from the call input: ${formatDiff(diffs.decoySessions)}`);
	// The one exemption, and it is a list of exact paths a case seeded itself before the run: a configuration seeded in
	// the stable child directory is an input that case owns, and it is compared byte for byte by the case as well.
	// The other exemption, for a call that is expected to leave a helper inside the managed subtree: exact
	// managed-relative paths a case names, each one required to be in the created set and each one exempted on its own.
	// It is a list of paths and never a prefix, a subtree or a wildcard, `MANAGED_WRITEABLE` is not widened for it and
	// neither is its self-check, so a helper path no case named is still a stray. A case that seeds a helper itself
	// names it under `seededManaged` and compares its bytes as well; this list is for one a call created.
	//
	// Exact means exact, spelling included: `snapshot` names every entry by its own relative path, a directory with no
	// trailing slash, so a download that creates the bin as well as the program in it has to name `children/bin` **and**
	// `children/bin/rg` — two entries rather than one allowance covering both. (The trailing-slash spelling is
	// `listTree`'s, which is what the controller reports a call directory with, and it is not this list's.) The download
	// cases of the `P7` group are what exercise it; the seeded cases there own their files before the call and use
	// `seededManaged` plus their own byte-and-mode comparisons instead.
	for (const rel of helperArtifacts) {
		result.check(diffs.managed.created.includes(rel), `the call left no ${rel} in the managed root, and this case requires it: created ${JSON.stringify(diffs.managed.created)}`);
	}
	const seeded = new Set([...seededManaged, ...helperArtifacts]);
	const stray = [...diffs.managed.created, ...diffs.managed.modified].filter((rel) => !managedPathIsExpected(rel) && !seeded.has(rel));
	result.check(stray.length === 0, `the managed root gained something outside the catalog, the sessions and the calls directory: ${stray.join(", ")}`);
	// Both of these are about what one call leaves behind, so they are only asserted where one call ran alone: a case
	// that deliberately overlaps two callers has the other one's call directory, or its held staging directory, there
	// at this instant, and what matters then is the state once every caller has exited, asserted by the case itself.
	if (!alongsideAnotherCall) {
		result.check((observations.callsDirAfterDispose ?? []).length === 0, `the calls directory still holds ${JSON.stringify(observations.callsDirAfterDispose)} after disposal`);
		result.check((observations.stagingDirsLeft ?? []).length === 0, `a staging catalog directory was left behind: ${JSON.stringify(observations.stagingDirsLeft)}`);
	}
}

/** What the guard must have claimed about itself, so an older or weakened copy cannot pass for the one required here. */
const GUARD_REDIRECT_CLAIM = "never followed automatically";

/**
 * No fetch left this fixture's loopback origins, and none was attempted to anywhere else — but only once the guard is
 * proved to have been installed in every process the claim is about. A negative claim rests on the guard being there,
 * so a missing log, a process that installed no guard, a `no-global-fetch` process and a guard that does not claim
 * redirect protection each fail the case rather than reading as "nothing was requested". `expectChild` is false only
 * for a fixture process that launches no child of its own.
 */
function checkFetchLog(result, fetchLog, caller, { expectAllowed, expectChild = true, key = "fetch" }) {
	const records = fetchRecords(fetchLog, caller);
	const blocked = records.filter((record) => record.event === "blocked");
	const allowed = records.filter((record) => record.event === "allowed");
	const installed = records.filter((record) => record.event === "installed");
	const unusable = records.filter((record) => record.event === "no-global-fetch" || record.event === "unparsed");
	const logMissing = records.some((record) => record.event === "log-missing");
	const installedBy = new Set(installed.map((record) => record.caller));
	const required = expectChild ? [caller, `${caller}/child`] : [caller];
	const absent = required.filter((identity) => !installedBy.has(identity));
	result.observations[key] = {
		log: logMissing ? "missing" : "present",
		installedBy: [...installedBy].sort(),
		redirectClaims: [...new Set(installed.map((record) => record.redirects ?? null))],
		allowed: allowed.length,
		blocked: blocked.length,
		origins: [...new Set(allowed.map((record) => record.origin))],
	};
	result.check(!logMissing, `the guarded-fetch log ${fetchLog} could not be read, so this case holds no evidence about what was requested`);
	result.check(unusable.length === 0, `the guard could not watch a process, or wrote something unreadable: ${JSON.stringify(unusable.slice(0, 2))}`);
	result.check(absent.length === 0, `no guard was installed in ${JSON.stringify(absent)}, so a request claim about ${caller} would be about a process nothing was watching`);
	result.check(
		installed.length > 0 && installed.every((record) => record.redirects === GUARD_REDIRECT_CLAIM),
		`an installed guard did not claim redirect protection (${JSON.stringify(result.observations[key].redirectClaims)}), so it is not the guard this fixture requires`,
	);
	result.check(blocked.length === 0, `the guard blocked ${blocked.length} request(s) to an origin this fixture does not own: ${JSON.stringify(blocked.slice(0, 3))}`);
	if (expectAllowed === 0) result.check(allowed.length === 0, `the child made ${allowed.length} request(s) although this case expects none: ${JSON.stringify(allowed.slice(0, 3))}`);
	if (expectAllowed === "some") result.check(allowed.length > 0, "the case expects the child to reach the loopback fixture, and the guard recorded no request at all");
	return { records, allowed, blocked, installedBy: [...installedBy] };
}

/* --------------------------------------------------------------------------- the cases */

/**
 * Case P1: the production bootstrap started through the production storage, input and launch helpers, probed with the
 * three non-task RPC operations the adapter reads, with no prompt submitted at all. There is no ready protocol here
 * and no capability handshake: `get_state`, `get_available_models` and `get_available_thinking_levels` are read for
 * their shapes, and `get_commands` is not used as introspection.
 */
async function caseBootstrapStartup(ctx) {
	const dirs = ctx.setupCase("P1-bootstrap");
	const result = implResult("P1-bootstrap", "production bootstrap startup and non-task RPC probes, no prompt", [
		"the storage, the call input and the launch options are the production helpers' own; only the harness's controller is a stand-in",
		"the inherited PI_CODING_AGENT_SESSION_DIR points at a decoy directory, so a session written there would mean the child ignored its input",
	]);
	const fetchLog = path.join(dirs.caseRoot, "fetch.log");
	const observationsFile = path.join(dirs.caseRoot, "caller.json");
	const specFile = path.join(dirs.caseRoot, "call.json");
	const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: "P1", origins: [originOf(ctx.server.baseUrl)], fetchLog });
	const watch = {
		profile: { dir: dirs.profile, excludeManaged: true },
		managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) },
		project: { dir: dirs.project },
		decoySessions: { dir: dirs.sessions },
	};
	const before = await implSettled(watch);
	const firstRequest = ctx.server.requests.length;
	const spec = callSpec({
		dirs,
		caller: "P1",
		handle: "run-1",
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		session: { kind: "new" },
		observations: observationsFile,
	});
	const child = startCaller(specFile, spec, { cwd: dirs.project, env });
	let state = {};
	try {
		({ state } = await probeChild(child, result, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" }));
	} catch (error) {
		result.failures.push(`probes: ${error instanceof Error ? error.message : String(error)}`);
	}
	const finished = await finishCaller(child, observationsFile);
	const after = await implSettled(watch);
	const diffs = implDiffs(before, after);
	result.phases.push({ name: "startup+probes", diffs });
	const observations = finished.observations;
	result.observations.callerExit = finished.exit;
	result.observations.childExit = observations.childExit;
	result.observations.callDirEntries = observations.callDirEntries;
	result.observations.storage = observations.storage;
	result.observations.launch = observations.launch;
	result.observations.inputVersion = observations.input?.version;
	result.observations.inputAllowModelNetwork = observations.input?.allowModelNetwork;
	result.observations.diagnostics = bootstrapDiagnostics(finished.stderr).map((line) => `${line.stage}${line.sdk ? `:${line.sdk}` : ""}${line.error ? " !" : ""}`);
	const diagnostics = bootstrapDiagnostics(finished.stderr);
	result.observations.sdkFromDiagnostic = diagnostics.find((line) => line.sdk)?.sdk ?? null;
	result.observations.sdkFromPackageMetadata = repoPiVersion;
	result.check(finished.exit?.code === 0, `the caller exited ${JSON.stringify(finished.exit)} instead of 0`);
	result.check(observations.childExit?.code === 0 && observations.childExit?.signal === null, `the child exited ${JSON.stringify(observations.childExit)} instead of code 0`);
	result.check(diagnostics.map((line) => line.stage).join(",") === "input,sdk,runtime,serving", `the bootstrap's stages were ${JSON.stringify(diagnostics.map((line) => line.stage))}`);
	result.check(diagnostics.every((line) => line.error === undefined), "the bootstrap reported an error on a startup that is supposed to succeed");
	// An unknown VERSION is metadata the package did not carry, not an incompatibility: it is reported either way.
	if (result.observations.sdkFromDiagnostic !== "unknown") result.check(result.observations.sdkFromDiagnostic === repoPiVersion, `the child reported SDK ${result.observations.sdkFromDiagnostic} and the resolved package says ${repoPiVersion}`);
	result.check(observations.input?.allowModelNetwork === true, "normal composition is supposed to permit a catalog refresh explicitly in this build");
	result.check(observations.input?.catalogBaseUrl === undefined, "normal composition is supposed to name no catalog base url");
	result.check((observations.controlledOverrides ?? []).length === 0, `this case is supposed to override nothing, and it overrode ${JSON.stringify(observations.controlledOverrides)}`);
	const sessionFile = state.sessionFile ?? "";
	result.check(typeof state.sessionId === "string" && state.sessionId.length > 0, "the child reported no session id");
	result.check(path.isAbsolute(sessionFile), `the child reported a session path that is not absolute: ${JSON.stringify(sessionFile)}`);
	result.check(sessionFile.startsWith(`${observations.storage?.sessionDir}${path.sep}`), "the child's session path is not inside this project's durable session directory");
	result.observations.sessionPathUsable = fs.existsSync(path.dirname(sessionFile));
	result.check(result.observations.sessionPathUsable, "the directory the child's session path names does not exist, so the path is not usable");
	result.check(callEntriesOutsideCache(observations.callDirEntries).join(",") === "bootstrap.json", `the call directory held ${JSON.stringify(observations.callDirEntries)} rather than the call input and its own caches`);
	checkManagedCall(result, observations, { dirs, diffs, expectSharedAuth: true });
	checkFetchLog(result, fetchLog, "P1", { expectAllowed: 0 });
	const requests = ctx.server.requests.slice(firstRequest);
	result.observations.fixtureModelRequests = requests.length;
	result.check(requests.length === 0, `the case reached the model server ${requests.length} time(s) although it submits no prompt`);
	result.check(fs.existsSync(path.join(dirs.project, ".pi", "commands")), "the project's legacy .pi/commands was migrated, and the bootstrap runs no migrations");
	result.observations.catalogStore = readJsonIfPresent(path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "catalog", "models-store.json"));
	result.check(result.observations.catalogStore !== undefined, "the published catalog store is missing or unreadable");
	return result;
}

/* ------------------------------------------------------------------ P2: durable sessions */

/** The transcript mutations the real preflight is measured against. Each one is a copy; no source is ever rewritten. */
function sessionMutations(transcript, sessionVersion) {
	const text = fs.readFileSync(transcript, "utf8");
	const lines = text.split("\n");
	const header = JSON.parse(lines[0]);
	const rewriteHeader = (version) => [JSON.stringify({ ...header, version }), ...lines.slice(1)].join("\n");
	const other = "11111111-2222-3333-4444-555555555555";
	return [
		{ name: "missing", expect: "could not be read", file: null, note: "the recorded file was never created" },
		{ name: "empty", expect: "empty", content: "" },
		{ name: "headerless", expect: "session header", content: lines.slice(1).join("\n") },
		{ name: "malformed-leading", expect: "not json", content: `this line is not json\n${text}` },
		{ name: "malformed-trailing", expect: "not json", content: `${text}{"truncated": \n` },
		{ name: "no-final-newline", expect: "newline", content: text.replace(/\n$/, "") },
		{ name: "old-version", expect: "version", content: rewriteHeader(sessionVersion - 1) },
		{ name: "new-version", expect: "version", content: rewriteHeader(sessionVersion + 1) },
		{ name: "wrong-id", expect: "different session id", content: text, sessionId: other },
		{ name: "unknown-checkpoint", expect: "checkpoint", content: text, checkpoint: other },
	];
}

/**
 * Case group P2: a durable transcript created by one real child in one process, closed, and reopened by another real
 * child in another process, plus the refusals the production preflight answers with. This is storage persistence and
 * the diagnostic boundary; trusted navigation, branching, forking and host transcript recording are task 7's, and
 * nothing here submits a prompt on a reopened session.
 */
async function caseDurableSessions(ctx) {
	const results = [];
	const create = ctx.setupCase("P2-durable");
	const createResult = implResult("P2-durable-create", "durable transcript created by a real child, one loopback-model task, then closed", [
		"the one prompt in this group: a deterministic loopback fixture answer, so the transcript has a real turn in it",
	]);
	const fetchLog = path.join(create.caseRoot, "fetch.log");
	const observationsFile = path.join(create.caseRoot, "caller.json");
	const env = implEnv(ctx.root, { agentDir: create.profile, sessionDir: create.sessions, caller: "P2a", origins: [originOf(ctx.server.baseUrl)], fetchLog });
	const watch = {
		profile: { dir: create.profile, excludeManaged: true },
		managed: { dir: path.join(create.profile, FUSION_MANAGED_DIR) },
		project: { dir: create.project },
		decoySessions: { dir: create.sessions },
	};
	const before = await implSettled(watch);
	const firstRequest = ctx.server.requests.length;
	const child = startCaller(
		path.join(create.caseRoot, "call.json"),
		callSpec({
			dirs: create,
			caller: "P2a",
			handle: "run-2",
			role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
			session: { kind: "new" },
			observations: observationsFile,
		}),
		{ cwd: create.project, env },
	);
	let recorded = {};
	try {
		await probeChild(child, createResult, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
		const prompt = await child.send({ type: "prompt", message: "Say the fixture answer." });
		createResult.check(prompt.success === true, "the prompt was rejected");
		await child.waitFor("agent_settled");
		const text = await child.send({ type: "get_last_assistant_text" });
		createResult.observations.answer = text.data?.text ?? null;
		createResult.check(text.data?.text?.includes(ANSWER) === true, "the loopback fixture answer did not come back");
		const state = await child.send({ type: "get_state" });
		recorded = { sessionId: state.data?.sessionId, sessionFile: state.data?.sessionFile, messageCount: state.data?.messageCount };
		createResult.observations.recorded = recorded;
	} catch (error) {
		createResult.failures.push(`task: ${error instanceof Error ? error.message : String(error)}`);
	}
	const finished = await finishCaller(child, observationsFile);
	const after = await implSettled(watch);
	createResult.phases.push({ name: "create+settle", diffs: implDiffs(before, after) });
	const diffs = implDiffs(before, after);
	createResult.observations.callerExit = finished.exit;
	createResult.observations.childExit = finished.observations.childExit;
	createResult.observations.callerPid = finished.observations.pid;
	createResult.check(finished.exit?.code === 0, `the caller exited ${JSON.stringify(finished.exit)}`);
	createResult.check(finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(finished.observations.childExit)}`);
	checkManagedCall(createResult, finished.observations, { dirs: create, diffs, expectSharedAuth: true });
	const requests = ctx.server.requests.slice(firstRequest);
	createResult.observations.fixtureModelRequests = requests.length;
	createResult.check(requests.length >= 1, "the task never reached the loopback model server");
	for (const request of requests) {
		createResult.check(request.method === "POST" && request.url.endsWith("/chat/completions"), `unexpected model request ${request.method} ${request.url}`);
		createResult.check(request.model === FIXTURE_MODEL, `a model request asked for ${request.model}`);
		createResult.check(request.authorizationMatchesFixtureKey === true, "a model request did not carry the seeded dummy credential");
	}
	const transcript = recorded.sessionFile;
	let transcriptBytes;
	if (typeof transcript === "string" && fs.existsSync(transcript)) {
		transcriptBytes = fs.readFileSync(transcript);
		const header = (() => {
			try {
				return JSON.parse(transcriptBytes.toString("utf8").split("\n")[0]);
			} catch {
				return undefined;
			}
		})();
		createResult.observations.transcript = { bytes: transcriptBytes.length, sha: hashFile(transcript), endsWithNewline: transcriptBytes.toString("utf8").endsWith("\n"), headerType: header?.type, headerVersion: header?.version, headerId: header?.id, entries: transcriptBytes.toString("utf8").trim().split("\n").length };
		createResult.check(header?.type === "session", "the recorded transcript does not begin with a session header");
		createResult.check(header?.id === recorded.sessionId, "the transcript's header id is not the session id the child reported");
		createResult.check(header?.version === ctx.builtins.sessionVersion, `the transcript is version ${header?.version} and this Pi writes ${ctx.builtins.sessionVersion}`);
		createResult.check(transcript.startsWith(`${finished.observations.storage?.sessionDir}${path.sep}`), "the transcript is not inside the managed durable session directory");
	} else {
		createResult.failures.push(`the child reported no transcript on disk: ${JSON.stringify(transcript)}`);
	}
	const callerPid = finished.observations.pid;
	createResult.observations.callerGoneAfterClose = typeof callerPid === "number" ? isProcessGone(callerPid) : null;
	createResult.check(createResult.observations.callerGoneAfterClose === true, "the first storage caller process is still alive after its call ended");
	checkFetchLog(createResult, fetchLog, "P2a", { expectAllowed: "some" });
	results.push(createResult);

	if (!transcriptBytes) return results;

	/* Reopened in a fresh process, by the absolute path the first run recorded. */
	const reopenResult = implResult("P2-durable-reopen", "the recorded transcript reopened by its absolute path in a new process", [
		"no prompt is submitted on the reopened session: this is persistence, not the trusted navigation task 7 owes",
		"the first caller process was shown to have exited before this one started",
	]);
	const reopenLog = path.join(create.caseRoot, "fetch-reopen.log");
	const reopenObservations = path.join(create.caseRoot, "caller-reopen.json");
	const reopenEnv = implEnv(ctx.root, { agentDir: create.profile, sessionDir: create.sessions, caller: "P2b", origins: [originOf(ctx.server.baseUrl)], fetchLog: reopenLog });
	reopenResult.observations.previousCallerGone = typeof callerPid === "number" ? isProcessGone(callerPid) : null;
	reopenResult.check(reopenResult.observations.previousCallerGone === true, "the second caller started while the first was still running");
	const reopenBefore = await implSettled(watch);
	const reopenFirstRequest = ctx.server.requests.length;
	const reopenChild = startCaller(
		path.join(create.caseRoot, "call-reopen.json"),
		callSpec({
			dirs: create,
			caller: "P2b",
			handle: "run-2",
			role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
			session: { kind: "open", sessionId: recorded.sessionId, sessionFile: transcript },
			observations: reopenObservations,
		}),
		{ cwd: create.project, env: reopenEnv },
	);
	try {
		const { state } = await probeChild(reopenChild, reopenResult, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
		reopenResult.check(state.sessionId === recorded.sessionId, `the reopened child reports session ${state.sessionId} instead of ${recorded.sessionId}`);
		reopenResult.check(state.sessionFile === transcript, `the reopened child reports transcript ${state.sessionFile} instead of the recorded ${transcript}`);
		reopenResult.check((state.messageCount ?? 0) >= 2, `the reopened session holds ${state.messageCount} messages, so the recorded turn did not come back`);
		const text = await reopenChild.send({ type: "get_last_assistant_text" });
		reopenResult.observations.lastAssistantText = text.data?.text ?? null;
		reopenResult.check(text.data?.text?.includes(ANSWER) === true, "the reopened transcript does not hold the answer the first run recorded");
	} catch (error) {
		reopenResult.failures.push(`reopen: ${error instanceof Error ? error.message : String(error)}`);
	}
	const reopened = await finishCaller(reopenChild, reopenObservations);
	const reopenAfter = await implSettled(watch);
	reopenResult.phases.push({ name: "reopen", diffs: implDiffs(reopenBefore, reopenAfter) });
	reopenResult.observations.callerExit = reopened.exit;
	reopenResult.observations.childExit = reopened.observations.childExit;
	reopenResult.check(reopened.exit?.code === 0 && reopened.observations.childExit?.code === 0, `the reopening call ended ${JSON.stringify(reopened.observations.childExit)} under caller exit ${JSON.stringify(reopened.exit)}`);
	const afterBytes = fs.readFileSync(transcript);
	reopenResult.observations.transcriptAfter = { bytes: afterBytes.length, sha: hashFile(transcript), unchanged: afterBytes.equals(transcriptBytes), recordedPrefixIntact: afterBytes.subarray(0, transcriptBytes.length).equals(transcriptBytes) };
	reopenResult.check(reopenResult.observations.transcriptAfter.recordedPrefixIntact, "the bytes the first run recorded are no longer at the start of the transcript");
	// Byte identity, not just a surviving prefix: this case submits no prompt, so a reopened transcript that gained an
	// entry, or that Pi repaired on the way in, is a finding and not something to record as an append.
	reopenResult.check(reopenResult.observations.transcriptAfter.unchanged, `reopening rewrote the transcript: ${JSON.stringify(reopenResult.observations.transcriptAfter)}`);
	reopenResult.check((reopened.observations.callDirEntries ?? []).includes("models.json") === false, "a per-call models file was created");
	reopenResult.check(reopened.observations.disposed === true, "the reopening call's directory was not disposed of");
	const reopenRequests = ctx.server.requests.slice(reopenFirstRequest);
	reopenResult.observations.fixtureModelRequests = reopenRequests.length;
	reopenResult.check(reopenRequests.length === 0, `reopening reached the model server ${reopenRequests.length} time(s), and it submits no prompt`);
	reopenResult.observations.historyInCallerEnv = reopened.observations.env?.PI_FUSION_HISTORY ?? null;
	reopenResult.check(reopened.observations.env?.PI_FUSION_HISTORY === null, "PI_FUSION_HISTORY was set for the reopening call");
	checkFetchLog(reopenResult, reopenLog, "P2b", { expectAllowed: 0 });
	results.push(reopenResult);

	/* A healthy startup with no user auth file, so the private auth path the refusals check for is one Pi does create. */
	results.push(await caseStartupPrivateAuth(ctx));

	/* The refusals, each one a copy of disposable data that the production preflight is asked to open. */
	ctx.recordedSessionId = recorded.sessionId;
	for (const mutation of sessionMutations(transcript, ctx.builtins.sessionVersion)) {
		results.push(await caseSessionRefusal(ctx, mutation));
	}
	results.push(await caseModelsRefusal(ctx));
	return results;
}

/** Strips the user's own model and credential files, so a call falls back to this call's private paths. */
function withoutUserModelFiles(dirs) {
	fs.rmSync(path.join(dirs.profile, "models.json"), { force: true });
	fs.rmSync(path.join(dirs.profile, "auth.json"), { force: true });
	return dirs;
}

/**
 * The positive control for the refusals below: the same profile shape, with no user auth file, on a startup that is
 * supposed to succeed. Pi creates the private auth file the call selected, which is what makes its absence in a
 * refused call evidence that the preflight ran before the model runtime was built.
 */
async function caseStartupPrivateAuth(ctx) {
	const dirs = withoutUserModelFiles(ctx.setupCase("P2-private-auth-control"));
	const result = implResult("P2-private-auth-control", "healthy startup with no user auth file: the private auth path is created inside the call directory", [
		"the model is an exact builtin from the installed SDK's own catalog, made available by a dummy provider key in the child environment",
		"no prompt, and no catalog network: composition permits one, and this case's PI_OFFLINE=1 is what keeps the runtime from making it",
	]);
	const fetchLog = path.join(dirs.caseRoot, "fetch.log");
	const observationsFile = path.join(dirs.caseRoot, "caller.json");
	const env = implEnv(ctx.root, {
		agentDir: dirs.profile,
		sessionDir: dirs.sessions,
		caller: "P2c",
		origins: [originOf(ctx.server.baseUrl)],
		fetchLog,
		extra: { [BUILTIN_KEY_VARIABLE[ctx.builtins.chosen.provider]]: DUMMY_PROVIDER_KEY },
	});
	const watch = { profile: { dir: dirs.profile, excludeManaged: true }, managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) }, project: { dir: dirs.project }, decoySessions: { dir: dirs.sessions } };
	const before = await implSettled(watch);
	const firstRequest = ctx.server.requests.length;
	const child = startCaller(
		path.join(dirs.caseRoot, "call.json"),
		callSpec({
			dirs,
			caller: "P2c",
			handle: "run-3",
			role: { name: "implement", model: `${ctx.builtins.chosen.provider}/${ctx.builtins.chosen.model}`, effort: "medium", contract: "implement.md" },
			session: { kind: "new" },
			observations: observationsFile,
		}),
		{ cwd: dirs.project, env },
	);
	try {
		await probeChild(child, result, { provider: ctx.builtins.chosen.provider, model: ctx.builtins.chosen.model, requested: "medium" });
	} catch (error) {
		result.failures.push(`probes: ${error instanceof Error ? error.message : String(error)}`);
	}
	const finished = await finishCaller(child, observationsFile);
	const diffs = implDiffs(before, await implSettled(watch));
	result.phases.push({ name: "startup", diffs });
	result.observations.callerExit = finished.exit;
	result.observations.childExit = finished.observations.childExit;
	result.observations.callDirEntries = finished.observations.callDirEntries;
	result.observations.authPathWasPrivate = finished.observations.storage?.authPath === path.join(finished.observations.storage?.callDir ?? "", "auth.json");
	result.check(finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(finished.observations.childExit)} instead of code 0`);
	result.check(result.observations.authPathWasPrivate === true, "the call did not select its private auth path although the user has no auth file");
	result.check((finished.observations.callDirEntries ?? []).includes("auth.json"), `the SDK did not create the private auth file: the call directory held ${JSON.stringify(finished.observations.callDirEntries)}`);
	result.check((finished.observations.callDirEntries ?? []).includes("models.json") === false, "a per-call models file was created, and that path must stay absent");
	result.check(fs.existsSync(path.join(dirs.profile, "auth.json")) === false, "the user's missing auth file was created");
	result.check(fs.existsSync(path.join(dirs.profile, "models.json")) === false, "the user's missing models file was created");
	checkManagedCall(result, finished.observations, { dirs, diffs, expectSharedAuth: false });
	checkFetchLog(result, fetchLog, "P2c", { expectAllowed: 0 });
	result.observations.fixtureModelRequests = ctx.server.requests.length - firstRequest;
	result.check(result.observations.fixtureModelRequests === 0, "a model request was made although this control submits no prompt");
	return result;
}

/** One refused transcript: exit 78, a session-stage diagnostic, unchanged bytes, no model request, no private auth. */
async function caseSessionRefusal(ctx, mutation) {
	const name = `P2-refuse-${mutation.name}`;
	const dirs = withoutUserModelFiles(ctx.setupCase(name));
	const result = implResult(name, `the production preflight refuses a ${mutation.name} transcript`, [
		"the transcript is a copy of the disposable one case P2-durable-create wrote; no original is ever mutated",
		...(mutation.note ? [mutation.note] : []),
	]);
	const recordedDir = path.join(dirs.caseRoot, "recorded");
	fs.mkdirSync(recordedDir, { recursive: true });
	const file = path.join(recordedDir, "session.jsonl");
	if (mutation.content !== undefined) fs.writeFileSync(file, mutation.content);
	const sourceBefore = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
	const fetchLog = path.join(dirs.caseRoot, "fetch.log");
	const observationsFile = path.join(dirs.caseRoot, "caller.json");
	const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: name, origins: [originOf(ctx.server.baseUrl)], fetchLog, extra: { [BUILTIN_KEY_VARIABLE[ctx.builtins.chosen.provider]]: DUMMY_PROVIDER_KEY } });
	const watch = { profile: { dir: dirs.profile, excludeManaged: true }, managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) }, project: { dir: dirs.project }, decoySessions: { dir: dirs.sessions } };
	const before = await implSettled(watch);
	const firstRequest = ctx.server.requests.length;
	const child = startCaller(
		path.join(dirs.caseRoot, "call.json"),
		callSpec({
			dirs,
			caller: name,
			handle: "run-4",
			role: { name: "implement", model: `${ctx.builtins.chosen.provider}/${ctx.builtins.chosen.model}`, effort: "medium", contract: "implement.md" },
			session: { kind: "open", sessionId: mutation.sessionId ?? ctx.recordedSessionId, sessionFile: file, ...(mutation.checkpoint === undefined ? {} : { checkpoint: mutation.checkpoint }) },
			observations: observationsFile,
		}),
		{ cwd: dirs.project, env },
	);
	const finished = await finishCaller(child, observationsFile);
	const diffs = implDiffs(before, await implSettled(watch));
	result.phases.push({ name: "refused", diffs });
	const diagnostics = bootstrapDiagnostics(finished.stderr);
	const failure = diagnostics.find((line) => line.error !== undefined);
	result.observations.childExit = finished.observations.childExit;
	result.observations.stage = failure?.stage ?? null;
	result.observations.diagnostic = failure?.error ?? null;
	result.observations.callDirEntries = finished.observations.callDirEntries;
	result.check(finished.observations.childExit?.code === bootstrapModule.STARTUP_EXIT_CODE, `the child exited ${JSON.stringify(finished.observations.childExit)} instead of ${bootstrapModule.STARTUP_EXIT_CODE}`);
	result.check(failure?.stage === "session", `the refusal came from stage ${JSON.stringify(failure?.stage)} instead of the session stage`);
	result.check(typeof failure?.error === "string" && failure.error.includes(mutation.expect), `the diagnostic does not say ${JSON.stringify(mutation.expect)}: ${JSON.stringify(failure?.error)}`);
	result.check(failure?.error?.includes(file) !== true, "the diagnostic repeated the transcript path, and a session identity belongs in the run's outcome");
	if (sourceBefore) {
		result.observations.sourceUnchanged = fs.readFileSync(file).equals(sourceBefore);
		result.check(result.observations.sourceUnchanged === true, "the refused transcript was rewritten");
	} else {
		result.observations.sourceStillAbsent = fs.existsSync(file) === false;
		result.check(result.observations.sourceStillAbsent === true, "the missing transcript was created by the call that refused it");
	}
	result.check(
		callEntriesOutsideCache(finished.observations.callDirEntries).join(",") === "bootstrap.json",
		`the refused call left ${JSON.stringify(finished.observations.callDirEntries)} in its call directory; the private auth file must not be created when the preflight refuses`,
	);
	result.check(finished.observations.storage?.authPath === path.join(finished.observations.storage?.callDir ?? "", "auth.json"), "this case is only evidence when the call selects its private auth path, and it did not");
	result.check(fs.existsSync(path.join(dirs.profile, "auth.json")) === false, "the user's missing auth file was created");
	checkManagedCall(result, finished.observations, { dirs, diffs, expectSharedAuth: false });
	checkFetchLog(result, fetchLog, name, { expectAllowed: 0 });
	result.observations.fixtureModelRequests = ctx.server.requests.length - firstRequest;
	result.check(result.observations.fixtureModelRequests === 0, "a refused call reached the model server");
	return result;
}

/** A malformed user models file holding a credential marker: startup refuses and the marker never reaches stderr. */
async function caseModelsRefusal(ctx) {
	const dirs = ctx.setupCase("P2-refuse-models");
	const result = implResult("P2-refuse-models", "a malformed user models configuration refuses startup without echoing a credential", [
		"the marker stands in for a credential: Node's own JSON error quotes the fragment it choked on, which is why the refusal carries Fusion's fixed wording",
	]);
	const modelsFile = path.join(dirs.profile, "models.json");
	fs.writeFileSync(modelsFile, `{"providers": {"fixture": {"baseUrl": "http://127.0.0.1:1/v1", "api": "openai-completions", "apiKey": "${MODELS_MARKER}"`);
	fs.rmSync(path.join(dirs.profile, "auth.json"), { force: true });
	const sourceBefore = fs.readFileSync(modelsFile);
	const fetchLog = path.join(dirs.caseRoot, "fetch.log");
	const observationsFile = path.join(dirs.caseRoot, "caller.json");
	const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: "P2-models", origins: [originOf(ctx.server.baseUrl)], fetchLog });
	const watch = { profile: { dir: dirs.profile, excludeManaged: true }, managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) }, project: { dir: dirs.project }, decoySessions: { dir: dirs.sessions } };
	const before = await implSettled(watch);
	const firstRequest = ctx.server.requests.length;
	const child = startCaller(
		path.join(dirs.caseRoot, "call.json"),
		callSpec({
			dirs,
			caller: "P2-models",
			handle: "run-5",
			role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
			session: { kind: "new" },
			observations: observationsFile,
		}),
		{ cwd: dirs.project, env },
	);
	const finished = await finishCaller(child, observationsFile);
	const diffs = implDiffs(before, await implSettled(watch));
	result.phases.push({ name: "refused", diffs });
	const diagnostics = bootstrapDiagnostics(finished.stderr);
	const failure = diagnostics.find((line) => line.error !== undefined);
	result.observations.childExit = finished.observations.childExit;
	result.observations.stage = failure?.stage ?? null;
	result.observations.diagnosticIsTheFixedWording = failure?.error?.startsWith(bootstrapModule.MODELS_REFUSED) === true;
	result.observations.markerInStderr = finished.stderr.includes(MODELS_MARKER);
	result.check(finished.observations.childExit?.code === bootstrapModule.STARTUP_EXIT_CODE, `the child exited ${JSON.stringify(finished.observations.childExit)} instead of ${bootstrapModule.STARTUP_EXIT_CODE}`);
	result.check(failure?.stage === "models", `the refusal came from stage ${JSON.stringify(failure?.stage)} instead of the models stage`);
	result.check(result.observations.diagnosticIsTheFixedWording, `the refusal is not the bootstrap's fixed wording: ${JSON.stringify(failure?.error)}`);
	result.check(result.observations.markerInStderr === false, "the credential marker from the malformed models file appeared on stderr");
	result.check(fs.readFileSync(modelsFile).equals(sourceBefore), "the malformed models file was rewritten");
	result.check(fs.existsSync(path.join(dirs.profile, "auth.json")) === false, "the user's missing auth file was created");
	checkManagedCall(result, finished.observations, { dirs, diffs, expectSharedAuth: false });
	checkFetchLog(result, fetchLog, "P2-models", { expectAllowed: 0 });
	result.observations.fixtureModelRequests = ctx.server.requests.length - firstRequest;
	result.check(result.observations.fixtureModelRequests === 0, "a refused call reached the model server");
	return result;
}

/* --------------------------------------------------------- P3: the persistent shared catalog */

/**
 * Case group P3: a child with no user models file at all, refreshing its catalog from a loopback fixture, and a second
 * child in a new process that must find the persisted cache warm. Two things together put a request on the wire here,
 * and only one of them is this fixture's: normal composition permits the refresh, which is production's own policy
 * since step 4 task 5, and this case deletes `PI_OFFLINE` from the child's environment and points the base url at a
 * loopback catalog the harness owns, which is what keeps the request inside the fixture. Nothing about a real catalog
 * endpoint is measured here.
 */
async function caseCatalog(ctx) {
	const results = [];
	const dirs = withoutUserModelFiles(ctx.setupCase("P3-catalog"));
	const strayModels = path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "models.json");
	writeJson(strayModels, {
		providers: {
			"spike-stray": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "stray-model", name: "Stray", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
		},
	});
	const strayBefore = fs.readFileSync(strayModels);
	const chosen = ctx.builtins.chosen;
	const watch = { profile: { dir: dirs.profile, excludeManaged: true }, managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) }, project: { dir: dirs.project }, decoySessions: { dir: dirs.sessions } };
	const storePath = path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "catalog", "models-store.json");

	const run = async (label, title, notes) => {
		const result = implResult(label, title, notes);
		const fetchLog = path.join(dirs.caseRoot, `fetch-${label}.log`);
		const observationsFile = path.join(dirs.caseRoot, `caller-${label}.json`);
		const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: label, origins: [originOf(ctx.server.baseUrl), ctx.catalog.origin], fetchLog, offline: false, extra: DUMMY_PROVIDER_KEYS });
		result.observations.offlineVariable = env.PI_OFFLINE ?? null;
		result.check(env.PI_OFFLINE === undefined, "PI_OFFLINE is still in the case environment, and Pi enables its model network only when the variable is absent");
		const before = await implSettled(watch);
		const firstRequest = ctx.server.requests.length;
		const firstCatalogRequest = ctx.catalog.requests.length;
		const child = startCaller(
			path.join(dirs.caseRoot, `call-${label}.json`),
			callSpec({
				dirs,
				caller: label,
				handle: label.replace(/[^A-Za-z0-9._-]/g, "-"),
				role: { name: "implement", model: `${chosen.provider}/${chosen.model}`, effort: "medium", contract: "implement.md" },
				session: { kind: "new" },
				controlled: { catalogBaseUrl: ctx.catalog.origin },
				observations: observationsFile,
			}),
			{ cwd: dirs.project, env },
		);
		let probe;
		try {
			({ probe } = await probeChild(child, result, { provider: chosen.provider, model: chosen.model, requested: "medium" }));
		} catch (error) {
			result.failures.push(`probes: ${error instanceof Error ? error.message : String(error)}`);
		}
		const finished = await finishCaller(child, observationsFile);
		const diffs = implDiffs(before, await implSettled(watch));
		result.phases.push({ name: label, diffs });
		result.observations.childExit = finished.observations.childExit;
		result.observations.controlledOverrides = finished.observations.controlledOverrides;
		result.observations.callDirEntries = finished.observations.callDirEntries;
		result.observations.catalogRequests = ctx.catalog.requests.length - firstCatalogRequest;
		result.observations.fixtureModelRequests = ctx.server.requests.length - firstRequest;
		result.check(finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(finished.observations.childExit)} instead of code 0`);
		result.check(finished.observations.input?.allowModelNetwork === true, "the composed catalog permission did not reach the child");
		result.check(result.observations.fixtureModelRequests === 0, "a provider prompt was sent, and this group sends none");
		result.check((probe?.availableModels ?? []).includes(`${chosen.provider}/${CANARY_MODEL}`), `the loopback catalog's canary model is not available in the child: ${JSON.stringify((probe?.availableModels ?? []).slice(0, 8))}`);
		result.check((probe?.availableModels ?? []).some((id) => id.startsWith("spike-stray/")) === false, "the stray models.json in the stable child directory was inherited");
		result.check((finished.observations.callDirEntries ?? []).includes("models.json") === false, "the per-call models file was created, and that path must stay absent");
		result.check(fs.existsSync(path.join(dirs.profile, "models.json")) === false, "the user's missing models file was created");
		result.check(fs.existsSync(path.join(dirs.profile, "auth.json")) === false, "the user's missing auth file was created");
		result.check(fs.readFileSync(strayModels).equals(strayBefore), "the stray models.json in the child agent directory was rewritten");
		checkManagedCall(result, finished.observations, { dirs, diffs, expectSharedAuth: false });
		const { allowed } = checkFetchLog(result, fetchLog, label, { expectAllowed: undefined });
		result.observations.catalogFetches = allowed.filter((record) => record.origin === ctx.catalog.origin).length;
		return { result, finished };
	};

	const cold = await run("P3-catalog-cold", "no user models file, a loopback catalog refresh, and a persistent shared store", [
		"the permission is production's own composed default; the controlled fixture input is the loopback catalog base url, and the absent PI_OFFLINE is this case's environment",
		"the model is an exact builtin id read from the installed SDK's own catalog by a separate probe process",
	]);
	const store = readJsonIfPresent(storePath);
	cold.result.observations.store = store === undefined ? null : { providers: Object.keys(store).length, canaryProviders: Object.keys(store).filter((id) => (store[id]?.models ?? []).some((model) => model.id === CANARY_MODEL)).length, chosenEntry: store[chosen.provider] === undefined ? null : { models: store[chosen.provider].models.map((model) => model.id), hasCheckedAt: typeof store[chosen.provider].checkedAt === "number", hasLastModified: typeof store[chosen.provider].lastModified === "number", etag: typeof store[chosen.provider].etag === "string" } };
	cold.result.check(store !== undefined, "the shared catalog store is missing or not valid json after the writer exited");
	cold.result.check(Object.keys(store ?? {}).length >= 2, `the catalog refresh persisted ${Object.keys(store ?? {}).length} entr(ies), and this case configures several providers so a later loss is visible`);
	cold.result.check((store?.[chosen.provider]?.models ?? []).some((model) => model.id === CANARY_MODEL), `the shared store holds no usable entry for ${chosen.provider}`);
	cold.result.check(typeof store?.[chosen.provider]?.checkedAt === "number" && typeof store?.[chosen.provider]?.lastModified === "number", "the persisted entry carries no freshness stamp, so no later child could treat it as a cache");
	cold.result.check(cold.result.observations.catalogFetches > 0, "the cold child fetched no catalog at all");
	results.push(cold.result);

	const warm = await run("P3-catalog-warm", "a second process finds the persisted catalog warm and fetches nothing", [
		"warm is shown by the guarded fetch log and by the persisted bytes staying usable, not by a file merely existing",
	]);
	const warmStore = readJsonIfPresent(storePath);
	warm.result.observations.store = warmStore === undefined ? null : { providers: Object.keys(warmStore).length, sameAsCold: JSON.stringify(warmStore) === JSON.stringify(store) };
	warm.result.check(warm.result.observations.catalogFetches === 0, `the warm child fetched the catalog ${warm.result.observations.catalogFetches} time(s) although the persisted entries are fresh`);
	warm.result.check(warm.result.observations.catalogRequests === 0, `the loopback catalog server saw ${warm.result.observations.catalogRequests} request(s) from the warm child`);
	warm.result.check(warm.result.observations.store?.sameAsCold === true, "the warm run changed the persisted catalog although it fetched nothing");
	results.push(warm.result);
	ctx.catalogControl = { providers: Object.keys(store ?? {}).sort(), models: Object.fromEntries(Object.entries(store ?? {}).map(([id, entry]) => [id, (entry?.models ?? []).length])) };
	return results;
}

/* -------------------------------------------- P4: independent initialization and concurrency */

/**
 * Case group P4: two independent initializer processes into the same initially empty managed root. Nothing is
 * initialized once in this harness and then handed to two users: each case starts from a profile that has no
 * `pi-fusion` directory at all, and the production initializer is what creates it, twice, concurrently.
 */
async function caseIndependentInitialization(ctx) {
	const results = [];
	const chosen = ctx.builtins.chosen;

	/** One caller against one catalog server, driven to its probes and closed. Used by all three cases below. */
	const startOne = async ({ dirs, label, catalog, result, handle, stagedBarrier, alongsideAnotherCall = false }) => {
		const fetchLog = path.join(dirs.caseRoot, `fetch-${label}.log`);
		const observationsFile = path.join(dirs.caseRoot, `caller-${label}.json`);
		const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: label, origins: [ctx.control.origin, catalog.origin], fetchLog, offline: false, extra: DUMMY_PROVIDER_KEYS });
		const child = startCaller(
			path.join(dirs.caseRoot, `call-${label}.json`),
			callSpec({
				dirs,
				caller: label,
				handle,
				role: { name: "implement", model: `${chosen.provider}/${chosen.model}`, effort: "medium", contract: "implement.md" },
				session: { kind: "new" },
				controlled: { catalogBaseUrl: catalog.origin },
				observations: observationsFile,
				stagedBarrier,
			}),
			{ cwd: dirs.project, env },
		);
		let probe;
		const probeOnce = async () => {
			try {
				({ probe } = await probeChild(child, result, { provider: chosen.provider, model: chosen.model, requested: "medium", key: label }));
			} catch (error) {
				result.failures.push(`${label} probes: ${error instanceof Error ? error.message : String(error)}`);
			}
			return probe;
		};
		const close = async () => {
			const finished = await finishCaller(child, observationsFile);
			result.check(finished.observations.childExit?.code === 0, `${label}'s child exited ${JSON.stringify(finished.observations.childExit)} instead of code 0`);
			result.check(finished.observations.disposed === true, `${label} did not dispose of its call directory`);
			if (!alongsideAnotherCall) result.check((finished.observations.stagingDirsLeft ?? []).length === 0, `${label} left a staging catalog directory behind: ${JSON.stringify(finished.observations.stagingDirsLeft)}`);
			result.check((probe?.availableModels ?? []).includes(`${chosen.provider}/${CANARY_MODEL}`), `${label} came out without the loopback catalog's canary model, so it has no usable catalog data`);
			checkFetchLog(result, fetchLog, label, { expectAllowed: undefined, key: `fetch-${label}` });
			return finished;
		};
		return {
			label,
			child,
			fetchLog,
			observationsFile,
			/** The probes, on their own, so a case can hold this child open while another call disposes of its own. */
			probe: probeOnce,
			/** Answers a non-task probe again: what shows a child is still serving after another call was disposed of. */
			stillServing: async () => {
				const state = await child.send({ type: "get_state" }, 60_000);
				return state.success === true ? state.data : undefined;
			},
			close,
			/** Probe and close in one, for the cases that have no reason to hold a child open. */
			finish: async () => {
				await probeOnce();
				return await close();
			},
		};
	};

	/* The single-child control the concurrent case is compared against: same catalog fixture, its own empty root. */
	const controlDirs = withoutUserModelFiles(ctx.setupCase("P4-control"));
	const controlResult = implResult("P4-control", "single-child control: what one initializer alone persists from the same catalog fixture", []);
	const controlCatalog = await startCatalogServer({ label: "P4-control" });
	ctx.servers.push(controlCatalog);
	const controlWatch = { profile: { dir: controlDirs.profile, excludeManaged: true }, managed: { dir: path.join(controlDirs.profile, FUSION_MANAGED_DIR) }, project: { dir: controlDirs.project }, decoySessions: { dir: controlDirs.sessions } };
	const controlBefore = await implSettled(controlWatch);
	const control = await startOne({ dirs: controlDirs, label: "P4-control", catalog: controlCatalog, result: controlResult, handle: "run-control" });
	const controlFinished = await control.finish();
	const controlDiffs = implDiffs(controlBefore, await implSettled(controlWatch));
	controlResult.phases.push({ name: "single child", diffs: controlDiffs });
	checkManagedCall(controlResult, controlFinished.observations, { dirs: controlDirs, diffs: controlDiffs, expectSharedAuth: false });
	const controlStore = readJsonIfPresent(path.join(controlDirs.profile, FUSION_MANAGED_DIR, "children", "catalog", "models-store.json"));
	const controlShape = { providers: Object.keys(controlStore ?? {}).sort(), models: Object.fromEntries(Object.entries(controlStore ?? {}).map(([id, entry]) => [id, (entry?.models ?? []).length])) };
	controlResult.observations.store = { providers: controlShape.providers.length, entriesWithModels: Object.values(controlShape.models).filter((count) => count > 0).length };
	controlResult.check(controlShape.providers.length > 0, "the single-child control persisted no catalog entry, so it cannot serve as a control");
	results.push(controlResult);

	/* The deterministic interleaving: a publisher held at its staged directory while another one publishes for real. */
	const staleDirs = withoutUserModelFiles(ctx.setupCase("P4-stale"));
	const staleResult = implResult("P4-stale-publisher", "a staged publisher loses the rename to an initializer that has already populated the cache", [
		"the loser is held in the production initializer's own onStaged window, which is internal test infrastructure and the only way to reach that window",
		"the winner's populated bytes are read by the loser after its failed publication and before its child is launched",
	]);
	const staleWatch = { profile: { dir: staleDirs.profile, excludeManaged: true }, managed: { dir: path.join(staleDirs.profile, FUSION_MANAGED_DIR) }, project: { dir: staleDirs.project }, decoySessions: { dir: staleDirs.sessions } };
	const staleBefore = await implSettled(staleWatch);
	const loserCatalog = await startCatalogServer({ label: "P4-loser" });
	const winnerCatalog = await startCatalogServer({ label: "P4-winner" });
	ctx.servers.push(loserCatalog, winnerCatalog);
	const loser = await startOne({ dirs: staleDirs, label: "P4-loser", catalog: loserCatalog, result: staleResult, handle: "run-loser", stagedBarrier: ctx.control.url("P4-loser") });
	staleResult.observations.loserReachedStagedWindow = await ctx.control.waitFor("P4-loser", 120_000);
	staleResult.check(staleResult.observations.loserReachedStagedWindow === true, "the staged publisher never reached its staging window, so this interleaving did not happen");
	const winner = await startOne({ dirs: staleDirs, label: "P4-winner", catalog: winnerCatalog, result: staleResult, handle: "run-winner", alongsideAnotherCall: true });
	const winnerFinished = await winner.finish();
	const storePath = path.join(staleDirs.profile, FUSION_MANAGED_DIR, "children", "catalog", "models-store.json");
	const winnerStore = fs.readFileSync(storePath);
	const winnerParsed = JSON.parse(winnerStore.toString("utf8"));
	staleResult.observations.winner = { providers: Object.keys(winnerParsed).length, sha: crypto.createHash("sha256").update(winnerStore).digest("hex").slice(0, 16), catalogRequests: winnerCatalog.catalogRequests().length };
	staleResult.check(Object.keys(winnerParsed).length > 0, "the winning initializer published an empty cache, so the loser has nothing to preserve");
	staleResult.check(winnerFinished.observations.catalogExistedBeforePrepare === false, "the winning initializer found a catalog directory already there, so it did not publish one");
	ctx.control.release("P4-loser");
	const loserFinished = await loser.finish();
	const staleDiffs = implDiffs(staleBefore, await implSettled(staleWatch));
	staleResult.phases.push({ name: "stale publisher", diffs: staleDiffs });
	staleResult.observations.loser = {
		catalogExistedBeforePrepare: loserFinished.observations.catalogExistedBeforePrepare,
		stagedDir: loserFinished.observations.staged?.dir,
		barrier: loserFinished.observations.staged?.barrier,
		storeAfterPrepare: loserFinished.observations.storeAfterPrepare,
		storeBeforeSpawn: loserFinished.observations.storeBeforeSpawn,
		catalogRequests: loserCatalog.catalogRequests().length,
	};
	staleResult.check(loserFinished.observations.catalogExistedBeforePrepare === false, "the losing initializer saw a catalog directory before it began, so it was not an independent initializer");
	staleResult.check(loserFinished.observations.staged?.dir !== undefined, "the losing initializer never staged a directory");
	staleResult.check(loserFinished.observations.storeAfterPrepare?.sha === staleResult.observations.winner.sha, `the winner's populated bytes did not survive the losing publication: ${JSON.stringify(loserFinished.observations.storeAfterPrepare)}`);
	staleResult.check(loserFinished.observations.storeBeforeSpawn?.sha === staleResult.observations.winner.sha, "the store changed between the losing publication and the loser's own launch");
	staleResult.check(fs.existsSync(loserFinished.observations.staged?.dir ?? "") === false, "the losing publisher's staging directory is still there");
	staleResult.check(loserCatalog.catalogRequests().length === 0, `the loser fetched the catalog ${loserCatalog.catalogRequests().length} time(s) although it inherited a fresh populated cache`);
	const afterStale = fs.readFileSync(storePath);
	staleResult.observations.finalStore = { sha: crypto.createHash("sha256").update(afterStale).digest("hex").slice(0, 16), providers: Object.keys(JSON.parse(afterStale.toString("utf8"))).length };
	staleResult.check(afterStale.equals(winnerStore), "the final store is not the winner's file");
	const staleCatalogDirs = fs.readdirSync(path.join(staleDirs.profile, FUSION_MANAGED_DIR, "children")).filter((name) => name.startsWith("catalog") || name.startsWith(".catalog-"));
	staleResult.observations.catalogDirectories = staleCatalogDirs;
	staleResult.check(staleCatalogDirs.join(",") === "catalog", `the child agent directory holds ${JSON.stringify(staleCatalogDirs)} instead of one stable catalog directory`);
	checkManagedCall(staleResult, loserFinished.observations, { dirs: staleDirs, diffs: staleDiffs, expectSharedAuth: false });
	staleResult.observations.callsDirectoryAtEnd = fs.readdirSync(path.join(staleDirs.profile, FUSION_MANAGED_DIR, "calls"));
	staleResult.check(staleResult.observations.callsDirectoryAtEnd.length === 0, `both callers have exited and the calls directory still holds ${JSON.stringify(staleResult.observations.callsDirectoryAtEnd)}`);
	results.push(staleResult);

	/* Two real children overlapping for real, held at a catalog response barrier until both are inside the refresh. */
	const raceDirs = withoutUserModelFiles(ctx.setupCase("P4-concurrent"));
	const raceResult = implResult("P4-concurrent", "two independent initializers and two real children using the shared catalog at once", [
		"overlap is proved by a loopback catalog response barrier and by which port each request arrived on, not by a stress loop",
		"one caller is closed while the other child is still serving, so a disposal is shown to leave a live call alone",
	]);
	const rendezvous = requestRendezvous(["P4-first", "P4-second"], 3_500);
	const gate = async (record) => {
		if (record.provider !== chosen.provider) return;
		record.gatedAt = Date.now();
		await rendezvous.hold(record.label);
		record.releasedAt = Date.now();
	};
	const firstCatalog = await startCatalogServer({ label: "P4-first", gate });
	const secondCatalog = await startCatalogServer({ label: "P4-second", gate });
	ctx.servers.push(firstCatalog, secondCatalog);
	const raceWatch = { profile: { dir: raceDirs.profile, excludeManaged: true }, managed: { dir: path.join(raceDirs.profile, FUSION_MANAGED_DIR) }, project: { dir: raceDirs.project }, decoySessions: { dir: raceDirs.sessions } };
	const raceBefore = await implSettled(raceWatch);
	// Genuinely cold: the managed root does not exist yet, so both processes below are initializers rather than users of
	// something this harness prepared for them.
	const raceManagedRoot = path.join(raceDirs.profile, FUSION_MANAGED_DIR);
	raceResult.observations.managedRootBeforeLaunch = fs.existsSync(raceManagedRoot) ? fs.readdirSync(raceManagedRoot) : null;
	raceResult.check(raceResult.observations.managedRootBeforeLaunch === null, `the managed root already held ${JSON.stringify(raceResult.observations.managedRootBeforeLaunch)} before either initializer was launched`);
	const [first, second] = await Promise.all([
		startOne({ dirs: raceDirs, label: "P4-first", catalog: firstCatalog, result: raceResult, handle: "run-first", alongsideAnotherCall: true }),
		startOne({ dirs: raceDirs, label: "P4-second", catalog: secondCatalog, result: raceResult, handle: "run-second", alongsideAnotherCall: true }),
	]);
	await Promise.all([first.probe(), second.probe()]);
	/*
	 * One caller is closed first, deliberately, while the other child's stdin stays open: that is what shows a
	 * `dispose()` removes its own call directory and leaves a live call's alone. Ordering by wall clock, or closing both
	 * at once and reading a snapshot, would prove nothing — both snapshots could be taken after both disposals.
	 */
	const firstFinished = await first.close();
	const stillServing = await second.stillServing();
	raceResult.observations.secondStillServingAfterFirstDisposed = stillServing === undefined ? null : { sessionId: stillServing.sessionId, model: stillServing.model ? `${stillServing.model.provider}/${stillServing.model.id}` : null };
	raceResult.check(stillServing !== undefined, "the second child stopped answering a non-task probe once the first caller had disposed of its call directory");
	const secondFinished = await second.close();
	rendezvous.done();
	const secondCallDir = secondFinished.observations.storage?.callDir === undefined ? undefined : path.basename(secondFinished.observations.storage.callDir);
	raceResult.observations.disposalIsolation = { firstSawInCallsDir: firstFinished.observations.callsDirAfterDispose, secondCallDir };
	raceResult.check(
		secondCallDir !== undefined && (firstFinished.observations.callsDirAfterDispose ?? []).includes(`${secondCallDir}/`),
		`when the first caller disposed of its own call directory, the calls directory should still have held the second caller's ${JSON.stringify(secondCallDir)}; it held ${JSON.stringify(firstFinished.observations.callsDirAfterDispose)}`,
	);
	const raceDiffs = implDiffs(raceBefore, await implSettled(raceWatch));
	raceResult.phases.push({ name: "concurrent", diffs: raceDiffs });
	const gated = [...firstCatalog.requests, ...secondCatalog.requests].filter((record) => record.gatedAt !== undefined);
	raceResult.observations.overlap = {
		barrierMet: rendezvous.state.met,
		barrierTimedOut: rendezvous.state.timedOut,
		gatedRequests: gated.map((record) => ({ label: record.label, gatedAt: record.gatedAt - (rendezvous.state.metAt ?? 0), respondedAt: (record.respondedAt ?? 0) - (rendezvous.state.metAt ?? 0) })),
		labels: [...new Set(gated.map((record) => record.label))].sort(),
	};
	raceResult.check(rendezvous.state.met === true && rendezvous.state.timedOut === false, "the catalog response barrier was never met by both children, so no overlap was proved");
	raceResult.check(raceResult.observations.overlap.labels.length === 2, `only ${JSON.stringify(raceResult.observations.overlap.labels)} reached the gated catalog request`);
	const lastArrival = Math.max(...gated.map((record) => record.gatedAt));
	const firstResponse = Math.min(...gated.map((record) => record.respondedAt ?? Number.POSITIVE_INFINITY));
	raceResult.check(Number.isFinite(firstResponse) && lastArrival <= firstResponse, "one gated request was answered before the other arrived, so the two children did not overlap");
	raceResult.observations.initializers = { first: firstFinished.observations.catalogExistedBeforePrepare, second: secondFinished.observations.catalogExistedBeforePrepare };
	// At least one of them had to find no catalog: which one publishes is a real race, and ordinary scheduling can let
	// the winner finish before the other one even looks, so requiring both to have seen it absent would be wrong.
	raceResult.check(
		firstFinished.observations.catalogExistedBeforePrepare === false || secondFinished.observations.catalogExistedBeforePrepare === false,
		"neither initializer saw the catalog absent, so something other than these two processes created it",
	);
	const raceStorePath = path.join(raceDirs.profile, FUSION_MANAGED_DIR, "children", "catalog", "models-store.json");
	const raceBytes = fs.readFileSync(raceStorePath);
	let raceStore;
	try {
		raceStore = JSON.parse(raceBytes.toString("utf8"));
	} catch (error) {
		raceResult.failures.push(`the shared catalog store is not valid json after both writers exited: ${error instanceof Error ? error.message : String(error)}`);
	}
	const raceShape = { providers: Object.keys(raceStore ?? {}).sort(), models: Object.fromEntries(Object.entries(raceStore ?? {}).map(([id, entry]) => [id, (entry?.models ?? []).length])) };
	raceResult.observations.store = { providers: raceShape.providers.length, control: controlShape.providers.length, entriesWithModels: Object.values(raceShape.models).filter((count) => count > 0).length };
	const missing = controlShape.providers.filter((id) => !raceShape.providers.includes(id));
	const truncated = controlShape.providers.filter((id) => raceShape.models[id] !== undefined && raceShape.models[id] < controlShape.models[id]);
	raceResult.observations.lostAgainstControl = { missing, truncated };
	raceResult.check(missing.length === 0, `the concurrent run lost ${missing.length} provider entr(ies) the single-child control kept: ${missing.slice(0, 6).join(", ")}`);
	raceResult.check(truncated.length === 0, `the concurrent run truncated ${truncated.length} provider entr(ies): ${truncated.slice(0, 6).join(", ")}`);
	const raceCatalogDirs = fs.readdirSync(path.join(raceDirs.profile, FUSION_MANAGED_DIR, "children")).filter((name) => name.startsWith("catalog") || name.startsWith(".catalog-"));
	raceResult.observations.catalogDirectories = raceCatalogDirs;
	raceResult.check(raceCatalogDirs.join(",") === "catalog", `the child agent directory holds ${JSON.stringify(raceCatalogDirs)} instead of one stable catalog directory`);
	checkManagedCall(raceResult, firstFinished.observations, { dirs: raceDirs, diffs: raceDiffs, expectSharedAuth: false, alongsideAnotherCall: true });
	raceResult.observations.callsDirectoryAtEnd = fs.readdirSync(path.join(raceDirs.profile, FUSION_MANAGED_DIR, "calls"));
	raceResult.check(raceResult.observations.callsDirectoryAtEnd.length === 0, `both callers have exited and the calls directory still holds ${JSON.stringify(raceResult.observations.callsDirectoryAtEnd)}`);
	raceResult.check(secondFinished.observations.disposed === true && firstFinished.observations.disposed === true, "one of the two concurrent callers did not dispose of its call directory");
	// Which of two independent initializers publishes is a real race, and this case does not fix it: what it requires is
	// that one catalog directory exists afterwards, that no entry the control kept was lost, and that at least one of
	// them began with no catalog there. The note says which of those two shapes this run took, and claims no winner:
	// when both staged, the rename decided, and nothing observable here records whose rename it was.
	const sawAbsent = [firstFinished, secondFinished].filter((one) => one.observations.catalogExistedBeforePrepare === false).length;
	raceResult.notes.push(
		sawAbsent === 2
			? "in this run both initializers found no catalog before they began, so both staged one and the rename decided which was published"
			: "in this run one initializer found no catalog and published one, and the other found it already there",
	);
	results.push(raceResult);
	return results;
}

/* --------------------------------------------------------------- G: the fetch guard's control */

/**
 * The guard is a harness preload, so what it actually guards is measured rather than asserted: one request to an
 * origin this fixture owns goes through, one to a loopback origin it does not own is rejected before it is sent, and
 * the server behind that origin is asked whether anything arrived. It guards `globalThis.fetch` and nothing else.
 */
async function caseFetchGuardControl(ctx) {
	const result = implResult("G-fetch-guard", "the manual harness's fetch guard, with a positive and a negative control", [
		"this guards `globalThis.fetch` in the processes the preload reaches, and that alone: not a raw socket, not a subprocess's own client, not a native binding",
	]);
	const dirs = ctx.setupCase("G-fetch-guard");
	const decoy = await startCatalogServer({ label: "G-decoy" });
	ctx.servers.push(decoy);
	const fetchLog = path.join(dirs.caseRoot, "fetch.log");
	const observationsFile = path.join(dirs.caseRoot, "probe.json");
	const specFile = path.join(dirs.caseRoot, "probe-spec.json");
	const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: "G", origins: [ctx.catalog.origin], fetchLog, offline: false });
	writeJson(specFile, {
		observations: observationsFile,
		attempts: [
			{ label: "owned", url: `${ctx.catalog.origin}/api/models/providers/${ctx.builtins.chosen.provider}` },
			{ label: "not-owned", url: `${decoy.origin}/api/models/providers/${ctx.builtins.chosen.provider}` },
		],
	});
	const probe = await runCli(process.execPath, [STORAGE_CALLER, "fetch-probe", specFile], { cwd: dirs.project, env });
	const report = readJsonIfPresent(observationsFile) ?? {};
	result.observations.probeExit = probe.code;
	result.observations.attempts = report.attempts;
	result.observations.decoyRequests = decoy.requests.length;
	const owned = (report.attempts ?? []).find((attempt) => attempt.label === "owned");
	const notOwned = (report.attempts ?? []).find((attempt) => attempt.label === "not-owned");
	result.check(owned?.ok === true, `the request to this fixture's own loopback origin did not go through: ${JSON.stringify(owned)}`);
	result.check(notOwned?.ok === false && String(notOwned?.error ?? "").includes("spike fetch guard"), `the request to an origin this fixture does not own was not rejected by the guard: ${JSON.stringify(notOwned)}`);
	result.check(decoy.requests.length === 0, `the origin this fixture does not own received ${decoy.requests.length} request(s)`);
	const records = fetchRecords(fetchLog, "G");
	result.observations.log = { allowed: records.filter((r) => r.event === "allowed").length, blocked: records.filter((r) => r.event === "blocked").length };
	result.check(result.observations.log.allowed === 1, `the log recorded ${result.observations.log.allowed} allowed request(s) instead of one`);
	result.check(result.observations.log.blocked === 1, `the log recorded ${result.observations.log.blocked} blocked request(s) instead of one`);
	// This case's own guard has to be proved installed as well, even though it is the guard being measured: a probe
	// nothing was watching would report two attempts and mean nothing.
	const installed = records.filter((record) => record.event === "installed");
	result.observations.installedBy = installed.map((record) => record.caller);
	result.check(installed.length === 1 && installed[0].caller === "G", `the guard was not installed in this probe: ${JSON.stringify(result.observations.installedBy)}`);
	result.check(installed.every((record) => record.redirects === GUARD_REDIRECT_CLAIM), "the installed guard did not claim redirect protection");
	result.check(records.some((record) => record.event === "no-global-fetch") === false, "the probe process had no global fetch to guard");
	return [result];
}

/**
 * The redirect control: an allowed loopback origin answers 302 to a loopback listener that is **not** on the
 * allow-list, and the guard must refuse the redirect at request time rather than learn about it from `response.url`.
 * Both signs are measured, the second one by running the same probe again under a copy of the guard with its redirect
 * protection removed — recorded as a mutation, separately from the result, because it is what shows the control is not
 * vacuous.
 */
async function caseFetchRedirectControl(ctx) {
	const result = implResult("G-fetch-redirect", "the fetch guard refuses a redirect out of an allowed loopback origin", [
		"the forbidden target is another loopback listener of this fixture's; no real provider or download endpoint is ever named",
		"the mutation below reverts only the redirect protection, in a copy of the guard under the temp root",
	]);
	const dirs = ctx.setupCase("G-fetch-redirect");
	const forbidden = await startForbiddenServer({ label: "G-redirect-target" });
	const redirector = await startRedirectServer({ label: "G-redirector", location: `${forbidden.origin}/escaped` });
	ctx.servers.push(forbidden, redirector);
	const attempts = [{ label: "redirected", url: `${redirector.origin}/api/models/providers/anything` }];
	const probe = async (label, guardFile) => {
		const fetchLog = path.join(dirs.caseRoot, `fetch-${label}.log`);
		const observationsFile = path.join(dirs.caseRoot, `probe-${label}.json`);
		const specFile = path.join(dirs.caseRoot, `probe-${label}-spec.json`);
		writeJson(specFile, { observations: observationsFile, attempts });
		const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: label, origins: [redirector.origin], fetchLog, offline: false, guardFile });
		const run = await runCli(process.execPath, [STORAGE_CALLER, "fetch-probe", specFile], { cwd: dirs.project, env });
		return { exit: run.code, report: readJsonIfPresent(observationsFile) ?? {}, records: fetchRecords(fetchLog, label), fetchLog };
	};

	const guarded = await probe("G-redirect", FETCH_GUARD);
	const attempt = (guarded.report.attempts ?? [])[0];
	result.observations.redirectorRequests = redirector.requests.length;
	result.observations.attempt = attempt;
	result.observations.forbiddenRequests = forbidden.requests.length;
	result.observations.recordedRedirectMode = [...new Set(guarded.records.filter((record) => record.event === "allowed").map((record) => record.redirect))];
	result.check(redirector.requests.length === 1, `the allowed loopback origin was asked ${redirector.requests.length} time(s) instead of once, so the control did not run as written`);
	result.check(attempt?.ok === false, `the redirect was followed instead of refused: ${JSON.stringify(attempt)}`);
	result.check(forbidden.requests.length === 0, `the loopback origin this fixture does not allow received ${forbidden.requests.length} request(s) through a redirect`);
	result.check(result.observations.recordedRedirectMode.join(",") === "error", `the guard recorded redirect mode ${JSON.stringify(result.observations.recordedRedirectMode)} instead of refusing redirects`);
	checkFetchLog(result, guarded.fetchLog, "G-redirect", { expectAllowed: "some", expectChild: false });

	// The mutation: the same probe, under a guard whose redirect protection has been taken out. Reverting it has to
	// break the control, or the control was not testing anything.
	const mutatedGuard = path.join(dirs.caseRoot, "mutated-guard-follows-redirects.mjs");
	const source = fs.readFileSync(FETCH_GUARD, "utf8");
	const protection = '		const redirect = asked === "manual" ? "manual" : "error";';
	if (!source.includes(protection)) {
		result.failures.push("the guard's redirect protection could not be found to mutate, so this control cannot say whether reverting it would fail");
	} else {
		write(mutatedGuard, source.replace(protection, '		const redirect = asked ?? "follow";'));
		const before = forbidden.requests.length;
		const reverted = await probe("G-redirect-mutated", mutatedGuard);
		const mutatedAttempt = (reverted.report.attempts ?? [])[0];
		result.observations.mutationRevertedProtection = {
			attempt: mutatedAttempt,
			forbiddenRequestsAfterMutation: forbidden.requests.length - before,
			recordedRedirectMode: [...new Set(reverted.records.filter((record) => record.event === "allowed").map((record) => record.redirect))],
		};
		result.check(
			result.observations.mutationRevertedProtection.forbiddenRequestsAfterMutation > 0,
			"reverting the guard's redirect protection did not reach the forbidden loopback origin either, so this control proves nothing about the protection",
		);
	}
	return result;
}

/**
 * The guard's presence is a prerequisite, not a detail, so the two ways of losing it are measured: a child launched
 * without the preload, and a log that is gone. Both must make an otherwise clean zero-request case fail. The control
 * is the same call with the preload in place, so the mutation is read against a run that does pass.
 */
async function caseGuardRequired(ctx) {
	const result = implResult("G-guard-required", "a zero-request claim fails without the guard's own evidence", [
		"two real children: one with the preload, one deliberately launched without it",
		"the mutated checks run against a throwaway result, so what they report is evidence and not this case's own outcome",
	]);
	const chosen = ctx.builtins.chosen;
	const run = async (label, mutate) => {
		const dirs = withoutUserModelFiles(ctx.setupCase(label));
		const fetchLog = path.join(dirs.caseRoot, "fetch.log");
		const observationsFile = path.join(dirs.caseRoot, "caller.json");
		const env = implEnv(ctx.root, { agentDir: dirs.profile, sessionDir: dirs.sessions, caller: label, origins: [originOf(ctx.server.baseUrl)], fetchLog, extra: { [BUILTIN_KEY_VARIABLE[chosen.provider]]: DUMMY_PROVIDER_KEY } });
		const spec = callSpec({
			dirs,
			caller: label,
			handle: "run-guard",
			role: { name: "implement", model: `${chosen.provider}/${chosen.model}`, effort: "medium", contract: "implement.md" },
			session: { kind: "new" },
			observations: observationsFile,
		});
		const child = startCaller(path.join(dirs.caseRoot, "call.json"), { ...spec, ...(mutate ? { mutate } : {}) }, { cwd: dirs.project, env });
		const state = await child.send({ type: "get_state" }, 90_000);
		const finished = await finishCaller(child, observationsFile);
		return { label, fetchLog, state, finished };
	};

	const control = await run("G-guard-control-call", undefined);
	result.observations.control = { childExit: control.finished.observations.childExit, stateOk: control.state.success === true };
	result.check(control.state.success === true && control.finished.observations.childExit?.code === 0, `the control call did not run cleanly: ${JSON.stringify(control.finished.observations.childExit)}`);
	checkFetchLog(result, control.fetchLog, "G-guard-control-call", { expectAllowed: 0 });

	const withoutPreload = await run("G-guard-no-preload", { dropChildPreload: true });
	result.check(withoutPreload.state.success === true && withoutPreload.finished.observations.childExit?.code === 0, `the mutated call did not run cleanly, so the mutation says nothing: ${JSON.stringify(withoutPreload.finished.observations.childExit)}`);
	result.check(withoutPreload.finished.observations.childPreloadDropped === true, "the caller did not report dropping the child's preload");
	const missingChild = implResult("mutation", "child launched without the guard");
	checkFetchLog(missingChild, withoutPreload.fetchLog, "G-guard-no-preload", { expectAllowed: 0 });
	result.observations.mutationChildWithoutGuard = { failures: missingChild.failures, installedBy: missingChild.observations.fetch?.installedBy };
	result.check(missingChild.failures.length > 0, "a child launched without the fetch guard still passed the log check, so a zero-request claim would not depend on the guard being there");

	fs.rmSync(control.fetchLog, { force: true });
	const missingLog = implResult("mutation", "log deleted");
	checkFetchLog(missingLog, control.fetchLog, "G-guard-control-call", { expectAllowed: 0 });
	result.observations.mutationLogDeleted = { failures: missingLog.failures, log: missingLog.observations.fetch?.log };
	result.check(missingLog.failures.length > 0, "a deleted log still passed the log check, so a zero-request claim would not depend on any evidence");
	return result;
}


/* --------------------------------- P5: configuration and resource qualification (step 4, task 3c) */

/*
 * Case group P5: what a real child's configuration and its explicit resources actually are. The groups above measure
 * the default composition, where every role names no resource at all; this one names them. It covers the inherited
 * configuration a seeded profile and a seeded stable child directory must not reach, the resources a call names
 * loading for real, the forms the production input refuses before the SDK is imported, the refusals the loader's own
 * results produce, a local package's bundled assets, this host's own extension named as a resource, an indirect
 * import of it, and one ordinary shell write a child's own task makes on purpose.
 *
 * Two protections are added here and nowhere else in this harness, and both are the harness's own rather than
 * production's:
 *
 * - For the input-refusal cases, this repository's test-only module fence (`test/sdk-fence.mjs`) is preloaded beside
 *   the fetch guard. Those cases hand a child a specifier — `npm:`, `git:`, `github:`, `https:` — that a resource
 *   loader would turn into an install, so a preflight that stopped refusing must not be able to reach the SDK and its
 *   package manager at all. A correct refusal happens before the SDK is imported, so the fence never fires: that it
 *   did not fire is asserted, and the fence is this repository's own file rather than a path a case composes.
 * - For the same cases, and for one control of their own, runtime-generated `npm` and `git` shims go on the front of
 *   the child's `PATH`. Each logs what it was asked to do and exits 86 without running anything, and
 *   `npm_config_registry` names a loopback listener this fixture owns. The control invokes the shims on purpose, to
 *   show they are live; the refusal cases require the log to exist and to hold no attempt at all.
 *
 * The fence is the primary protection. The shims cover the two commands a package install resolves through `PATH` and
 * nothing else: they are not a sandbox, they say nothing about arbitrary code a resource could run, and they do not
 * make a network claim of their own.
 */

/** The test-only fence, by its own path in this repository: a case never composes one, and no other file may stand in. */
const SDK_FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");
/** The fixed string that fence writes when it refuses. Repeated rather than imported: importing it installs the hook. */
const SDK_FENCE_MARKER = "pi-fusion test fence:";
/** What the shims write and exit with: a status nothing else in this harness uses, so a log line is unmistakable. */
const SHIM_EXIT_CODE = 86;
const SHIM_COMMANDS = ["npm", "git"];
/** A sentence from Pi's own default base prompt, which the child's prompt has to hold for the role contract to sit on. */
const P5_BASE_PROMPT = "You are an expert coding assistant operating inside pi";
/** A sentence from `contracts/implement.md`, the contract every P5 call runs under. */
const P5_CONTRACT_SENTINEL = "You run the `implement` role in a three-model workflow";
/** The tool a probe extension registers in its factory body, which a case then requires through the role's tool list. */
const P5_PROBE_TOOL = "spike_probe";
const P5_PROBE_COMMAND = "spike-probe-report";
const P5_PROMPT_PREFIX = "SPIKE_PROMPT";
const P5_RECURSION_PREFIX = "SPIKE_RECURSION";
const P5_RECURSION_COMMAND = "spike-recursion-report";
/** The marker the one deliberate shell write leaves, and the only path that task is asked to write. */
const P5_WRITE_MARKER = "SPIKE-PROJECT-WRITE-MARKER";
const P5_WRITE_RELATIVE = "node_modules/spike-marker.txt";
/** The sentinel that selects the scripted model answer for that task, so no other case can reach the script. */
const P5_WRITE_SENTINEL = "SPIKE-BASH-WRITE-SENTINEL";

/** Everything a seeded configuration puts where a child must not pick it up, and the two it must. */
const P5_SENTINELS = {
	userAgents: USER_CONTEXT_SENTINEL,
	childAgents: "SPIKE-CHILD-AGENT-DIR-SENTINEL",
	userSystem: "SPIKE-USER-SYSTEM-MD-SENTINEL",
	userAppend: "SPIKE-USER-APPEND-SYSTEM-MD-SENTINEL",
	childSystem: "SPIKE-CHILD-SYSTEM-MD-SENTINEL",
	childAppend: "SPIKE-CHILD-APPEND-SYSTEM-MD-SENTINEL",
	project: PROJECT_CONTEXT_SENTINEL,
	ancestor: "SPIKE-ANCESTOR-CONTEXT-SENTINEL",
	basePrompt: P5_BASE_PROMPT,
	contract: P5_CONTRACT_SENTINEL,
};

/**
 * A probe extension: one tool registered in the factory body, which is what makes it active under the role's tool
 * list, and one command that reports what the child's real system prompt holds. The prompt itself is never copied out
 * — the command answers with one boolean per sentinel and the prompt's length — because a system prompt carries the
 * project's own instructions and this report goes through a notification the harness logs.
 */
const p5ProbeExtension = ({ tool = P5_PROBE_TOOL, command = P5_PROBE_COMMAND, sentinels = P5_SENTINELS, extraCommands = [] } = {}) => `export default function (pi) {
	pi.registerTool({
		name: ${JSON.stringify(tool)},
		label: "Spike probe",
		description: "A fixture tool this extension registers in its factory body",
		parameters: { type: "object", properties: { note: { type: "string", description: "anything at all" } }, required: [], additionalProperties: false },
		async execute() {
			return { content: [{ type: "text", text: "spike probe ran" }], details: {} };
		},
	});
${extraCommands.map((name) => `	pi.registerCommand(${JSON.stringify(name)}, { description: "A second fixture command", handler: async (_args, ctx) => ctx.ui.notify(${JSON.stringify(name)} + " ran", "info") });\n`).join("")}	pi.registerCommand(${JSON.stringify(command)}, {
		description: "Report what the child's real system prompt holds",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			const sentinels = ${JSON.stringify(sentinels)};
			const found = {};
			for (const name of Object.keys(sentinels)) found[name] = prompt.includes(sentinels[name]);
			ctx.ui.notify(
				${JSON.stringify(P5_PROMPT_PREFIX)} +
					" " +
					JSON.stringify({
						found,
						promptBytes: prompt.length,
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
						model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : null,
					}),
				"info",
			);
		},
	});
}
`;

/** An extension whose module body throws, so the loader reports it as a failure rather than loading it. */
const p5BrokenExtension = (marker) => `throw new Error(${JSON.stringify(marker)});
`;

/** An extension that registers its tool in a later hook, which is exactly what the production tool check refuses. */
const p5LateToolExtension = (tool) => `export default function (pi) {
	pi.on("session_start", async () => {
		pi.registerTool({
			name: ${JSON.stringify(tool)},
			label: "Spike late probe",
			description: "A fixture tool registered in session_start rather than in the factory body",
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			async execute() {
				return { content: [{ type: "text", text: "late" }], details: {} };
			},
		});
	});
}
`;

/**
 * A local extension that imports this host's own extension and calls it with an instrumented wrapper of the real
 * `ExtensionAPI` it was handed. Every property read and every call the host extension makes is recorded and none is
 * performed, so a host extension that registered anything is visible as a recorded call rather than as a tool nobody
 * can see afterwards. The fixture then registers its own command on the original api, which is what shows a normal
 * extension still works beside the wrapper.
 */
const p5RecursionExtension = ({ fusionPath, report, command = P5_RECURSION_COMMAND }) => `import * as fs from "node:fs";
import fusion from ${JSON.stringify(fusionPath)};

export default function (pi) {
	const seen = { properties: [], calls: [], error: null, marker: process.env.PI_FUSION_CHILD ?? null };
	const wrapper = new Proxy(pi, {
		get(target, property, receiver) {
			const name = typeof property === "symbol" ? property.toString() : String(property);
			seen.properties.push(name);
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function") return value;
			return (...args) => {
				seen.calls.push({ method: name, first: typeof args[0] === "string" ? args[0] : typeof args[0] });
				return undefined;
			};
		},
	});
	try {
		fusion(wrapper);
	} catch (error) {
		seen.error = String(error && error.message ? error.message : error);
	}
	fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(seen) + "\\n");
	pi.registerCommand(${JSON.stringify(command)}, {
		description: "Report what the host extension did with the real extension api",
		handler: async (_args, ctx) => {
			ctx.ui.notify(${JSON.stringify(P5_RECURSION_PREFIX)} + " " + JSON.stringify(seen), "info");
		},
	});
}
`;

/** One skill directory, in the shape Pi reads: a `SKILL.md` with the frontmatter the standard requires. */
function p5WriteSkill(dir, { name, description, body = "Do nothing at all." }) {
	write(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
	return dir;
}

/** A local package, in the public shapes `docs/packages.md` documents: a manifest and the assets it names. */
function p5WritePackage(dir, { name, extension, skill, prompt, theme }) {
	const manifest = { name, version: "1.0.0", private: true, keywords: ["pi-package"], pi: { extensions: ["./extensions"] } };
	write(path.join(dir, "extensions", "pkg-ext.ts"), extension);
	if (skill) {
		manifest.pi.skills = ["./skills"];
		p5WriteSkill(path.join(dir, "skills", skill.name), skill);
	}
	if (prompt) {
		manifest.pi.prompts = ["./prompts"];
		write(path.join(dir, "prompts", `${prompt.name}.md`), `---\ndescription: ${prompt.description}\n---\n${prompt.body}\n`);
	}
	if (theme) {
		manifest.pi.themes = ["./themes"];
		writeJson(path.join(dir, "themes", `${theme.name}.json`), theme.value);
	}
	writeJson(path.join(dir, "package.json"), manifest);
	return dir;
}

/**
 * The `npm` and `git` shims, written at runtime into this case's own directory. Each one appends what it was asked to
 * do to a log beside it and exits 86 without running anything: an installer this harness did not expect is a line in
 * that log rather than a package on this machine. The log path is written into the script rather than read from the
 * environment, so a child with a sanitized environment still records its attempt.
 */
function p5InstallerShims(caseRoot) {
	const shimDir = path.join(caseRoot, "shims");
	const log = path.join(caseRoot, "installer-attempts.log");
	// Created empty, so "nothing was invoked" is a readable log with no lines in it rather than a file that is not
	// there: a case that claims no installer ran must fail on a missing log, the way the fetch log's absence fails one.
	write(log, "");
	for (const command of SHIM_COMMANDS) {
		const file = path.join(shimDir, command);
		write(file, `#!/bin/sh\nprintf '%s\\t%s\\n' ${JSON.stringify(command)} "$*" >> ${JSON.stringify(log)}\nexit ${SHIM_EXIT_CODE}\n`);
		fs.chmodSync(file, 0o755);
	}
	return { shimDir, log };
}

/** What the shims recorded: an unreadable log is its own record, so a claim of no attempt cannot rest on a missing file. */
function p5InstallerAttempts(log) {
	let text;
	try {
		text = fs.readFileSync(log, "utf8");
	} catch (error) {
		return { present: false, code: error?.code ?? String(error), attempts: [] };
	}
	const attempts = text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [command, ...rest] = line.split("\t");
			return { command, args: rest.join("\t") };
		});
	return { present: true, attempts };
}

/** What a P5 run is counted as, so a refused call is never reported as a session that ran. */
function p5Counters() {
	return { bootstrapInvocations: 0, preSdkRefusals: 0, sdkLoaded: 0, serving: 0, rpcAnswered: 0, refusalsAfterSdk: 0, loopbackModelRequests: 0 };
}

/**
 * One call of a group that names resources, from the fixtures a case has already written to the diffs it left behind.
 * Everything such a case shares lives here: the guarded environment, the four watched trees, the production helpers
 * through the same controller every other implementation-stage case uses, and the accounting that keeps a refusal out
 * of the session totals. P5 is where it came from and P6 runs on it as it is: a case may add loopback origins of its
 * own to the allow list — the OAuth cases have a token endpoint beside the model server — and brings its own counter
 * set, so one group's totals never absorb another's.
 */
async function p5Run(ctx, spec) {
	const { dirs, caller, result } = spec;
	const fetchLog = path.join(dirs.caseRoot, `fetch-${caller}.log`);
	const observationsFile = path.join(dirs.caseRoot, `caller-${caller}.json`);
	const specFile = path.join(dirs.caseRoot, `call-${caller}.json`);
	const counters = spec.counters ?? ctx.p5;
	const env = implEnv(ctx.root, {
		agentDir: dirs.profile,
		sessionDir: dirs.sessions,
		caller,
		origins: [originOf(ctx.server.baseUrl), ...(spec.extraOrigins ?? [])],
		fetchLog,
		extra: spec.extraEnv ?? {},
		// Three narrow pass-throughs a group below needs and no case above uses: the exact `PI_OFFLINE` this call runs
		// with, and values that are not directories and must reach the child as they are.
		...(spec.offline === undefined ? {} : { offline: spec.offline }),
		...(spec.rawExtra === undefined ? {} : { rawExtra: spec.rawExtra }),
		...(spec.fence === true ? { fence: true } : {}),
		// The helper-download cases' own second preload, with the exact url map and the log it writes; every other case
		// composes no interposer at all and reaches the guard directly, as it always did.
		...(spec.interposer === undefined ? {} : { interposer: spec.interposer }),
		...(spec.pathPrefix === undefined ? {} : { pathPrefix: spec.pathPrefix }),
	});
	const watch = {
		profile: { dir: dirs.profile, excludeManaged: true },
		managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) },
		project: { dir: dirs.project },
		decoySessions: { dir: dirs.sessions },
		...(spec.watch ?? {}),
	};
	const before = await implSettled(watch);
	const firstRequest = ctx.server.requests.length;
	const sessionsBefore = snapshot(path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "sessions"));
	const call = {
		...callSpec({
			dirs,
			caller,
			handle: spec.handle ?? "run-p5",
			role: spec.role,
			session: { kind: "new" },
			// The loopback catalog base url, for a group that measures what a real child does about a catalog: the
			// controller records it as its one labelled fixture input, exactly as the catalog cases above pass it.
			controlled: spec.controlled,
			observations: observationsFile,
		}),
		...(spec.resources === undefined ? {} : { resources: spec.resources }),
		...(spec.rawInput === undefined ? {} : { mutate: { rawInput: spec.rawInput } }),
	};
	const child = startCaller(specFile, call, { cwd: dirs.project, env });
	let answered = false;
	try {
		answered = (await spec.drive?.(child, result)) === true;
	} catch (error) {
		result.failures.push(`${spec.driveLabel ?? "drive"}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const finished = await finishCaller(child, observationsFile);
	const after = await implSettled(watch);
	const diffs = implDiffs(before, after);
	result.phases.push({ name: spec.phase ?? "call", diffs });
	const diagnostics = bootstrapDiagnostics(finished.stderr);
	const failure = diagnostics.find((line) => line.error !== undefined);
	const stages = diagnostics.filter((line) => line.error === undefined).map((line) => line.stage);
	result.observations.callerExit = finished.exit;
	result.observations.childExit = finished.observations.childExit;
	result.observations.stagesReported = stages;
	result.observations.controlledOverrides = finished.observations.controlledOverrides;
	result.observations.composed = {
		extensions: finished.observations.input?.extensions,
		skills: finished.observations.input?.skills,
		tools: finished.observations.input?.tools,
	};
	// The two environment facts every P5 case is read against, both taken from the environment this call composed for
	// the launch rather than from the child: the preload it was started with, and what stood at the front of its PATH.
	// Nothing in this Pi reports the options its own process was started under, so this is the composed environment,
	// and the controller's `childPreloadDropped` is what says it reached the child unaltered.
	result.observations.childNodeOptions = env.NODE_OPTIONS;
	result.observations.pathHead = (env.PATH ?? "").split(path.delimiter)[0];
	const requests = ctx.server.requests.slice(firstRequest);
	result.observations.fixtureModelRequests = requests.length;
	const sessionsAfter = snapshot(path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "sessions"));
	const sessionsCreated = diffSnapshots(sessionsBefore, sessionsAfter).created;
	// A file, not a directory: preparing a call creates this project's session directory whatever the call then does,
	// and what a refusal must not leave behind is a transcript in it.
	const transcripts = sessionsCreated.filter((rel) => String(sessionsAfter.get(rel) ?? "").startsWith("file:"));
	result.observations.sessionDirsCreated = sessionsCreated.filter((rel) => !transcripts.includes(rel));
	result.observations.transcriptFilesCreated = transcripts;
	counters.bootstrapInvocations += 1;
	counters.loopbackModelRequests += requests.length;
	if (stages.includes("sdk")) counters.sdkLoaded += 1;
	else if (failure?.stage === "input") counters.preSdkRefusals += 1;
	if (stages.includes("serving")) counters.serving += 1;
	if (failure !== undefined && stages.includes("sdk")) counters.refusalsAfterSdk += 1;
	if (answered) counters.rpcAnswered += 1;
	return { finished, diffs, watch, env, diagnostics, failure, stages, requests, fetchLog, transcripts, observations: finished.observations };
}

/** The checks a refused P5 call shares: the exit code, the stage, the wording, and what must not be in the diagnostic. */
function p5CheckRefusal(result, run, { stage, expect = [], absent = [], preSdk = false }) {
	result.observations.stage = run.failure?.stage ?? null;
	result.observations.diagnostic = run.failure?.error ?? null;
	result.check(
		run.finished.observations.childExit?.code === bootstrapModule.STARTUP_EXIT_CODE,
		`the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of ${bootstrapModule.STARTUP_EXIT_CODE}`,
	);
	result.check(run.failure?.stage === stage, `the refusal came from stage ${JSON.stringify(run.failure?.stage)} instead of the ${stage} stage`);
	for (const text of expect) {
		result.check(typeof run.failure?.error === "string" && run.failure.error.includes(text), `the diagnostic does not say ${JSON.stringify(text)}: ${JSON.stringify(run.failure?.error)}`);
	}
	for (const text of absent) {
		result.check(run.finished.stderr.includes(text) === false, `${JSON.stringify(text)} reached the child's stderr, and a refusal carries no value it was handed and no text it was given`);
	}
	result.check(run.requests.length === 0, `a refused call reached the model server ${run.requests.length} time(s)`);
	result.check(run.transcripts.length === 0, `a refused call left ${JSON.stringify(run.transcripts)} in the durable session directory`);
	if (preSdk) {
		result.observations.refusedBeforeSdk = run.stages.length === 0 && run.failure?.sdk === undefined;
		// What says the refusal came before the import: no stage was completed and the diagnostic carries no version.
		result.check(run.stages.length === 0, `the child reported stage(s) ${JSON.stringify(run.stages)} before refusing, so the refusal was not the input stage's own`);
		result.check(run.failure?.sdk === undefined, "the refusal carried sdk metadata, so it did not happen before the SDK was loaded");
		// And what says the fence was there to fire. A silent stderr proves nothing on its own — an uninstalled fence is
		// silent too — so two things are asserted before the marker's absence is read. First, the preload in the
		// environment this call composed for its launch: that is the environment, not the child's own report of itself,
		// because nothing in this Pi answers with the options it was started under. Second, that the controller did not
		// take the preload away, which is the one switch in it that can, and which the guard's own control uses.
		// Beside them, `checkFetchLog` requires the fetch guard to have recorded its own installation inside the child,
		// which is the one piece of evidence here that the child process itself produced.
		result.observations.fenceInLaunchEnvironment = (result.observations.childNodeOptions ?? "").includes(pathToFileURL(SDK_FENCE).href);
		result.check(result.observations.fenceInLaunchEnvironment === true, `the environment composed for this launch did not carry ${SDK_FENCE}, so the absence of its marker says nothing: ${JSON.stringify(result.observations.childNodeOptions)}`);
		result.observations.childPreloadDropped = run.finished.observations.childPreloadDropped ?? null;
		result.check(result.observations.childPreloadDropped === false, `the controller reported childPreloadDropped ${JSON.stringify(result.observations.childPreloadDropped)}, so what the child was preloaded with is not what this case composed`);
		result.observations.fenceFired = run.finished.stderr.includes(SDK_FENCE_MARKER);
		result.check(result.observations.fenceFired === false, "the test fence refused an SDK import, so this child reached the import a correct refusal happens before");
	}
}

/** The commands a child actually offers, read through the RPC command every case uses for it. */
async function p5Commands(child, result, key = "commands") {
	const response = await child.send({ type: "get_commands" }, 60_000);
	result.check(response.success === true, `get_commands failed: ${response.error ?? ""}`);
	const commands = (response.data?.commands ?? []).map((command) => command.name).sort();
	result.observations[key] = commands;
	return commands;
}

/** One fixture command, invoked and read back from the notification it writes. */
async function p5Notified(child, result, command, prefix, key) {
	const response = await child.send({ type: "prompt", message: `/${command}` }, 60_000);
	result.check(response.success === true, `the /${command} command was rejected: ${response.error ?? ""}`);
	const line = await waitForNotification(child, `${prefix} `, 30_000);
	const report = JSON.parse(line.slice(prefix.length + 1));
	result.observations[key] = report;
	return report;
}

/**
 * Case P5.1: the installer shims, invoked on purpose. Everything the refusal cases below claim about installers rests
 * on these being live, so they are exercised here — both directly and through `PATH`, which is how a package install
 * would find them — and the loopback registry they point at is asked whether anything arrived.
 */
async function caseP5ShimControl(ctx) {
	const result = implResult("P5-shim-control", "the runtime-generated npm and git shims are live: they log what they were asked and exit 86", [
		"no child and no SDK in this case: it invokes the shims themselves, which is what makes an empty log in the refusal cases evidence",
		"the shims cover the two commands a package install resolves through PATH; they are not a sandbox and make no network claim of their own",
	]);
	const dirs = ctx.setupCase("P5-shim-control");
	if (process.platform === "win32") {
		result.observations.skipped = "the shims are POSIX shell scripts, and this platform is not qualified here";
		result.notes.push("skipped on this platform, and reported as skipped rather than as a result");
		return result;
	}
	const { shimDir, log } = p5InstallerShims(dirs.caseRoot);
	const env = implEnv(ctx.root, {
		agentDir: dirs.profile,
		sessionDir: dirs.sessions,
		caller: "P5-shim",
		origins: [originOf(ctx.server.baseUrl)],
		fetchLog: path.join(dirs.caseRoot, "fetch.log"),
		fence: true,
		pathPrefix: shimDir,
		rawExtra: { npm_config_registry: `${ctx.p5Registry.origin}/` },
	});
	const registryBefore = ctx.p5Registry.requests.length;
	result.observations.pathHead = (env.PATH ?? "").split(path.delimiter)[0];
	result.observations.registry = env.npm_config_registry;
	result.observations.childNodeOptions = env.NODE_OPTIONS;
	result.check(result.observations.pathHead === shimDir, `the shim directory is not at the front of PATH: ${result.observations.pathHead}`);
	// Resolved the way a package install would resolve it, rather than by running the file this harness just wrote.
	const resolved = await runCli("/bin/sh", ["-c", "command -v npm; command -v git"], { cwd: dirs.project, env });
	result.observations.resolvedThroughPath = resolved.stdout.trim().split("\n");
	result.check(
		result.observations.resolvedThroughPath.join(",") === SHIM_COMMANDS.map((command) => path.join(shimDir, command)).join(","),
		`PATH resolved ${JSON.stringify(result.observations.resolvedThroughPath)} rather than this case's own shims`,
	);
	const invocations = [];
	for (const command of SHIM_COMMANDS) {
		const run = await runCli("/bin/sh", ["-c", `${command} --version`], { cwd: dirs.project, env });
		invocations.push({ command, code: run.code, stderr: run.stderr.trim().slice(0, 80) });
	}
	result.observations.invocations = invocations;
	result.check(
		invocations.every((invocation) => invocation.code === SHIM_EXIT_CODE),
		`a shim exited with something other than ${SHIM_EXIT_CODE}: ${JSON.stringify(invocations)}`,
	);
	const attempts = p5InstallerAttempts(log);
	result.observations.attempts = attempts;
	result.check(attempts.present === true, `the installer log ${log} could not be read`);
	result.check(attempts.attempts.length === SHIM_COMMANDS.length, `the log recorded ${attempts.attempts.length} attempt(s) instead of ${SHIM_COMMANDS.length}`);
	result.check(
		attempts.attempts.every((attempt) => attempt.args === "--version") && attempts.attempts.map((attempt) => attempt.command).sort().join(",") === [...SHIM_COMMANDS].sort().join(","),
		`the log recorded ${JSON.stringify(attempts.attempts)} rather than one harmless call per shim`,
	);
	result.observations.registryRequests = ctx.p5Registry.requests.length - registryBefore;
	result.check(result.observations.registryRequests === 0, "the loopback registry this fixture owns received a request, and no shim runs an installer");
	return result;
}

/**
 * Case P5.2: a seeded user profile, a seeded stable child agent directory and a seeded project, with exactly one
 * extension named by the call. What has to arrive is Pi's own base prompt, this role's contract and the project's and
 * its ancestor's own instructions; what has to be absent is every discovered resource, both `SYSTEM.md` overrides,
 * both `APPEND_SYSTEM.md` overrides, the user's own global context file and the child agent directory's own. The
 * prompt is read through the supported command context rather than guessed at from what the child answers.
 */
async function caseP5Suppression(ctx) {
	const dirs = ctx.setupCase("P5-suppression");
	const result = implResult("P5-suppression", "seeded profile, seeded stable child directory and seeded project: only the contract, the project's instructions and the named extension reach the child", [
		"the system prompt is the child's own, read through the supported command context's getSystemPrompt(); the harness receives booleans and a length, never the prompt",
		"the seeded files are inputs this case owns: they are compared byte for byte afterwards and are the only paths exempted from the managed-root stray filter",
	]);
	const managedRoot = path.join(dirs.profile, FUSION_MANAGED_DIR);
	const seeded = [];
	const seed = (rel, content) => {
		write(path.join(managedRoot, rel), content);
		seeded.push(rel);
	};
	seed("children/AGENTS.md", `# Child agent directory context\n\n${P5_SENTINELS.childAgents}\n`);
	seed("children/SYSTEM.md", `${P5_SENTINELS.childSystem}\n`);
	seed("children/APPEND_SYSTEM.md", `${P5_SENTINELS.childAppend}\n`);
	seed("children/extensions/child-ext.ts", markerExtension("child-ext-marker", "Child agent directory extension marker"));
	seed("children/extensions/child-provider.ts", providerExtension(EXTENSION_PROVIDER, FIXTURE_MODEL, ctx.server.baseUrl));
	seed("children/skills/child-skill/SKILL.md", "---\nname: child-skill\ndescription: A skill seeded in the stable child agent directory\n---\n\nDo nothing.\n");
	seed("children/prompts/child-prompt.md", "---\ndescription: A prompt template seeded in the stable child agent directory\n---\nDo nothing.\n");
	seed("children/settings.json", `${JSON.stringify({ packages: [path.join(dirs.profile, "local-pkg")], theme: "dark", defaultProjectTrust: "always" }, null, 2)}\n`);
	// The user's own profile already carries a context file, an extension, a skill, a prompt template and a local
	// package; the two prompt overrides are what `seedUserProfile` has no reason to write.
	write(path.join(dirs.profile, "SYSTEM.md"), `${P5_SENTINELS.userSystem}\n`);
	write(path.join(dirs.profile, "APPEND_SYSTEM.md"), `${P5_SENTINELS.userAppend}\n`);
	// An ordinary ancestor of the project, which is the other half of the positive control: the project's own file and
	// an ancestor's have to arrive while the agent directory's own does not.
	write(path.join(dirs.caseRoot, "AGENTS.md"), `# Ancestor context\n\n${P5_SENTINELS.ancestor}\n`);
	const seededBefore = Object.fromEntries(seeded.map((rel) => [rel, hashFile(path.join(managedRoot, rel))]));
	const probe = path.join(dirs.caseRoot, "resources", "probe-ext.ts");
	write(probe, p5ProbeExtension());
	const tools = [...p5RoleTools("implement"), P5_PROBE_TOOL];
	const run = await p5Run(ctx, {
		dirs,
		caller: "P5-suppression",
		result,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [probe] },
		rawInput: { tools },
		driveLabel: "probes and prompt report",
		drive: async (child, outcome) => {
			const { probe: probed } = await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const commands = await p5Commands(child, outcome);
			const report = await p5Notified(child, outcome, P5_PROBE_COMMAND, P5_PROMPT_PREFIX, "systemPrompt");
			outcome.check(commands.includes(P5_PROBE_COMMAND), `the one extension this call named registered no command: ${JSON.stringify(commands)}`);
			const suppressedCommands = ["user-ext-marker", "pkg-marker", "project-ext-marker", "child-ext-marker", "skill:spike-skill", "skill:child-skill", "spike-prompt", "child-prompt"];
			const leaked = suppressedCommands.filter((name) => commands.includes(name));
			outcome.observations.leakedCommands = leaked;
			outcome.check(leaked.length === 0, `a discovered resource reached the child's commands: ${leaked.join(", ")}`);
			outcome.check(
				probed.availableModels.includes(`${EXTENSION_PROVIDER}/${FIXTURE_MODEL}`) === false,
				"the provider extension seeded in the stable child agent directory registered its model, so a discovered extension ran",
			);
			for (const name of ["basePrompt", "contract", "project", "ancestor"]) {
				outcome.check(report.found?.[name] === true, `the child's own system prompt does not hold the ${name} sentinel`);
			}
			for (const name of ["userAgents", "childAgents", "userSystem", "userAppend", "childSystem", "childAppend"]) {
				outcome.check(report.found?.[name] === false, `the child's own system prompt holds the ${name} sentinel, which nothing wrote for this run`);
			}
			return true;
		},
	});
	result.observations.seededPaths = seeded;
	result.observations.seededUnchanged = seeded.every((rel) => fs.existsSync(path.join(managedRoot, rel)) && hashFile(path.join(managedRoot, rel)) === seededBefore[rel]);
	result.check(result.observations.seededUnchanged === true, "a seeded file under the managed root was rewritten or removed by the call");
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.check(run.requests.length === 0, `the case reached the model server ${run.requests.length} time(s) although it submits no task prompt`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true, seededManaged: seeded });
	checkFetchLog(result, run.fetchLog, "P5-suppression", { expectAllowed: 0 });
	return result;
}

/** The skill description a positive case looks for in the child's own system prompt. */
const P5_SKILL_SENTINEL = "SPIKE-SKILL-DESCRIPTION-SENTINEL";
const P5_SKILL_NAME = "spike-explicit-skill";

/**
 * Case P5.3: the resources a call names, loading for real. An extension registers the command and the tool the role's
 * list requires, a provider extension supplies the exact loopback model the call selects, and a skill directory
 * reaches the child's own commands and its own system prompt. One task prompt goes out, so the tool schema the child
 * offered a provider is recorded as corroboration for what the factory registered.
 */
async function caseP5ExplicitResources(ctx) {
	const dirs = ctx.setupCase("P5-resources");
	const result = implResult("P5-resources-explicit", "an explicitly named extension, provider extension and skill directory load, and the role's tool list requires the factory's own tool", [
		"the model is the provider extension's own, selected exactly: a role's model does not have to come from a models file",
		"one task prompt, answered by the loopback fixture, so the tool schemas the child offered are recorded",
	]);
	const resources = path.join(dirs.caseRoot, "resources");
	const probe = path.join(resources, "probe-ext.ts");
	const provider = path.join(resources, "provider-ext.ts");
	const skill = p5WriteSkill(path.join(resources, "skills", P5_SKILL_NAME), {
		name: P5_SKILL_NAME,
		description: `An explicitly selected fixture skill. ${P5_SKILL_SENTINEL}`,
	});
	write(probe, p5ProbeExtension({ sentinels: { ...P5_SENTINELS, skill: P5_SKILL_SENTINEL } }));
	write(provider, providerExtension(EXTENSION_PROVIDER, FIXTURE_MODEL, ctx.server.baseUrl));
	const resourcesBefore = snapshot(resources);
	const tools = [...p5RoleTools("implement"), P5_PROBE_TOOL];
	const run = await p5Run(ctx, {
		dirs,
		caller: "P5-resources",
		result,
		role: { name: "implement", model: `${EXTENSION_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [probe, provider], skills: [skill] },
		rawInput: { tools },
		extraEnv: { SPIKE_FIXTURE_KEY: FIXTURE_KEY },
		watch: { resources: { dir: resources } },
		driveLabel: "probes, commands, prompt report and one task",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: EXTENSION_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const commands = await p5Commands(child, outcome);
			outcome.check(commands.includes(P5_PROBE_COMMAND), `the named extension registered no command: ${JSON.stringify(commands)}`);
			outcome.check(commands.includes(`skill:${P5_SKILL_NAME}`), `the named skill registered no command: ${JSON.stringify(commands)}`);
			const report = await p5Notified(child, outcome, P5_PROBE_COMMAND, P5_PROMPT_PREFIX, "systemPrompt");
			outcome.check(report.found?.skill === true, "the explicitly selected skill's description is not in the child's own system prompt");
			outcome.check(report.found?.contract === true, "the role contract is not in the child's own system prompt");
			outcome.check(report.model === `${EXTENSION_PROVIDER}/${FIXTURE_MODEL}`, `the command context reports model ${report.model}`);
			const prompt = await child.send({ type: "prompt", message: "Say the fixture answer." });
			outcome.check(prompt.success === true, "the task prompt was rejected");
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			outcome.observations.answer = text.data?.text ?? null;
			outcome.check(text.data?.text?.includes(ANSWER) === true, "the loopback fixture answer did not come back");
			return true;
		},
	});
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.observations.composedTools = run.observations.input?.tools;
	result.check(
		(run.observations.input?.tools ?? []).includes(P5_PROBE_TOOL),
		"the call input did not require the factory's own tool, so the child starting says nothing about it",
	);
	// The tool schemas the child offered the provider: corroboration for the factory registration, not a tool list of
	// its own — the allow list is what decides which tools are active, and a model request only shows the ones sent.
	result.observations.requestToolNames = run.requests.map((request) => (request.toolNames ?? []).join(" "));
	result.observations.probeToolSchema = run.requests.map((request) => request.toolSchemas?.[P5_PROBE_TOOL] ?? null);
	result.check(run.requests.length === 1, `the case made ${run.requests.length} model request(s) instead of the one it prompts for`);
	result.check(
		run.requests.every((request) => (request.toolNames ?? []).includes(P5_PROBE_TOOL)),
		`the tool the extension registered in its factory body was not offered to the model: ${JSON.stringify(result.observations.requestToolNames)}`,
	);
	result.check(
		run.requests.every((request) => (request.toolSchemas?.[P5_PROBE_TOOL] ?? []).join(",") === "note"),
		`the tool schema the child sent is ${JSON.stringify(result.observations.probeToolSchema)} rather than the fixture's own one parameter`,
	);
	const cacheFiles = (run.observations.callDirEntries ?? []).filter((rel) => rel.startsWith(`${CALL_CACHE_DIR}/`) && !rel.endsWith("/"));
	result.observations.compilerCacheFiles = cacheFiles.length;
	result.check(cacheFiles.length > 0, "compiling the named resources wrote nothing into this call's own compiler caches");
	result.observations.resourceSourceDiff = formatDiff(diffSnapshots(resourcesBefore, snapshot(resources)));
	result.check(isEmptyDiff(run.diffs.resources), `the resource source directory was written to: ${formatDiff(run.diffs.resources)}`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	checkFetchLog(result, run.fetchLog, "P5-resources", { expectAllowed: "some" });
	return result;
}

/**
 * Case P5.4: the same shapes reached through symlinks alone. The call names only the aliases, never the files behind
 * them, because naming both would let a lexical coverage answer hold for the original rather than for the link. What
 * the loader reports a loaded resource's path as is what decides whether the production coverage check — which is
 * lexical and resolves nothing — holds for a linked resource, so this case measures it rather than assuming it.
 */
async function caseP5SymlinkResources(ctx) {
	const result = implResult("P5-resources-symlink", "an extension file and a skill directory reached only through symlink aliases", [
		"only the aliases are named: the originals are never in the same selection, so a lexical coverage answer cannot come from them",
		"production resolves no real path for coverage; this case is the measurement of what the loader reports, not a claim about it",
	]);
	const dirs = ctx.setupCase("P5-resources-symlink");
	if (process.platform === "win32") {
		result.observations.skipped = "symlink creation is not qualified on this platform here";
		result.notes.push("skipped on this platform, and reported as skipped rather than as a result");
		return result;
	}
	const real = path.join(dirs.caseRoot, "real");
	const links = path.join(dirs.caseRoot, "links");
	const probe = path.join(real, "probe-ext.ts");
	write(probe, p5ProbeExtension({ sentinels: { ...P5_SENTINELS, skill: P5_SKILL_SENTINEL } }));
	const skill = p5WriteSkill(path.join(real, "skills", P5_SKILL_NAME), { name: P5_SKILL_NAME, description: `A linked fixture skill. ${P5_SKILL_SENTINEL}` });
	fs.mkdirSync(links, { recursive: true });
	const extensionAlias = path.join(links, "linked-ext.ts");
	const skillAlias = path.join(links, "linked-skill");
	try {
		fs.symlinkSync(probe, extensionAlias);
		fs.symlinkSync(skill, skillAlias, "dir");
	} catch (error) {
		result.observations.skipped = `this filesystem refused a symlink (${error?.code ?? String(error)})`;
		result.notes.push("skipped: no symlink could be created here, and a skipped case is reported as skipped");
		return result;
	}
	result.observations.aliases = {
		extension: { at: extensionAlias, realPath: fs.realpathSync(extensionAlias) },
		skill: { at: skillAlias, realPath: fs.realpathSync(skillAlias) },
	};
	const tools = [...p5RoleTools("implement"), P5_PROBE_TOOL];
	const run = await p5Run(ctx, {
		dirs,
		caller: "P5-symlink",
		result,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [extensionAlias], skills: [skillAlias] },
		rawInput: { tools },
		driveLabel: "probes and commands",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const commands = await p5Commands(child, outcome);
			outcome.check(commands.includes(P5_PROBE_COMMAND), `the linked extension registered no command: ${JSON.stringify(commands)}`);
			outcome.check(commands.includes(`skill:${P5_SKILL_NAME}`), `the linked skill registered no command: ${JSON.stringify(commands)}`);
			const report = await p5Notified(child, outcome, P5_PROBE_COMMAND, P5_PROMPT_PREFIX, "systemPrompt");
			outcome.check(report.found?.skill === true, "the linked skill's description is not in the child's own system prompt");
			return true;
		},
	});
	result.check(
		run.finished.observations.childExit?.code === 0,
		`the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0; the refusal, where there is one, is ${JSON.stringify(run.failure?.error ?? null)}`,
	);
	result.check(run.requests.length === 0, `the case reached the model server ${run.requests.length} time(s) although it submits no task prompt`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	checkFetchLog(result, run.fetchLog, "P5-symlink", { expectAllowed: 0 });
	return result;
}

/**
 * The input-stage refusals, each one a resource entry the production bootstrap has to refuse before it imports the
 * SDK. The five specifier forms are written into the call input through the labelled patch, because the host composer
 * refuses them itself and this case is about the child's own check; the other four are ordinary local paths the
 * composer accepts and the child then looks at.
 *
 * Every one of them runs with the test fence and the installer shims: a preflight that stopped refusing would find no
 * SDK to import and no installer on its PATH, and both of those are asserted rather than assumed.
 */
function p5InputRefusalPlans() {
	return [
		{ name: "npm", field: "extensions", raw: true, value: "npm:spike-fixture-package", expect: "starts with a uri scheme", title: "an npm specifier as an extension entry" },
		{ name: "git", field: "extensions", raw: true, value: "git:spike-fixture.invalid/fixture/repo", expect: "starts with a uri scheme", title: "a git specifier as an extension entry" },
		{ name: "github", field: "extensions", raw: true, value: "github:spike-fixture/repo", expect: "starts with a uri scheme", title: "a github shorthand as an extension entry" },
		{ name: "https", field: "extensions", raw: true, value: "https://127.0.0.1:1/spike-fixture.ts", expect: "is a url", title: "an https url as an extension entry" },
		{ name: "file-url", field: "skills", raw: true, value: "file:///spike-fixture/skills/spike-skill", expect: "is a url", title: "a file url as a skill entry" },
		{
			name: "missing",
			field: "extensions",
			raw: false,
			expect: "is not on this machine",
			title: "an extension path that is not there",
			make: (dirs) => ({ value: path.join(dirs.caseRoot, "resources", "absent-ext.ts") }),
		},
		{
			name: "skill-suffix",
			field: "skills",
			raw: false,
			expect: "does not end in .md",
			title: "a regular skill file this Pi would answer with a warning and no skill",
			make: (dirs) => {
				const file = path.join(dirs.caseRoot, "resources", "spike-skill.txt");
				write(file, "---\nname: spike-skill-text\ndescription: A skill in a file this Pi does not read\n---\n\nDo nothing.\n");
				return { value: file };
			},
		},
		{
			name: "unreadable-file",
			field: "extensions",
			raw: false,
			permission: true,
			expect: "cannot be read by this child",
			title: "an extension file this child may not read",
			make: (dirs) => {
				const file = path.join(dirs.caseRoot, "resources", "unreadable-ext.ts");
				write(file, markerExtension("unreadable-marker", "never loaded"));
				fs.chmodSync(file, 0o000);
				return { value: file, restore: () => fs.chmodSync(file, 0o600) };
			},
		},
		{
			name: "unsearchable-dir",
			field: "skills",
			raw: false,
			permission: true,
			expect: "cannot be read and searched",
			title: "a skill directory this child may list and not walk into",
			make: (dirs) => {
				const dir = p5WriteSkill(path.join(dirs.caseRoot, "resources", "unsearchable-skill"), { name: "unsearchable-skill", description: "A skill in a directory this child may not search" });
				fs.chmodSync(dir, 0o600);
				return { value: dir, restore: () => fs.chmodSync(dir, 0o700) };
			},
		},
	];
}

/** Whether the two permission cases can say anything here: as root a mode of 000 is still readable. */
const p5PermissionCasesApply = () => process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

async function caseP5InputRefusal(ctx, plan) {
	const name = `P5-input-${plan.name}`;
	const dirs = ctx.setupCase(name);
	const result = implResult(name, `the production input refuses ${plan.title} before the SDK is imported`, [
		"the test fence is preloaded beside the fetch guard: a preflight that stopped refusing would find no SDK to import",
		"runtime-generated npm and git shims stand at the front of PATH, and the log they write is required to exist and to be empty",
		...(plan.raw ? ["the entry is written into the composed input through the labelled fixture patch, because the host composer refuses this form itself"] : []),
	]);
	if (plan.permission === true && !p5PermissionCasesApply()) {
		result.observations.skipped = "a permission case says nothing as root or on a platform whose file modes these are not";
		result.notes.push("skipped, and reported as skipped rather than as a result");
		return result;
	}
	const made = plan.make ? plan.make(dirs) : { value: plan.value };
	const { shimDir, log } = p5InstallerShims(dirs.caseRoot);
	const registryBefore = ctx.p5Registry.requests.length;
	try {
		const entry = [made.value];
		const run = await p5Run(ctx, {
			dirs,
			caller: name,
			result,
			role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
			fence: true,
			pathPrefix: shimDir,
			rawExtra: { npm_config_registry: `${ctx.p5Registry.origin}/` },
			...(plan.raw ? { rawInput: { [plan.field]: entry } } : { resources: { [plan.field]: entry } }),
			phase: "refused",
		});
		result.observations.entryKind = plan.raw ? `rawInput:${plan.field}` : `resources.${plan.field}`;
		p5CheckRefusal(result, run, { stage: "input", expect: [plan.expect], absent: [made.value], preSdk: true });
		const attempts = p5InstallerAttempts(log);
		result.observations.installerAttempts = attempts;
		result.check(attempts.present === true, `the installer log ${log} could not be read, so this case holds no evidence about what was invoked`);
		result.check(attempts.attempts.length === 0, `an installer shim was invoked: ${JSON.stringify(attempts.attempts)}`);
		result.observations.registryRequests = ctx.p5Registry.requests.length - registryBefore;
		result.check(result.observations.registryRequests === 0, "the loopback registry this fixture owns received a request");
		checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
		checkFetchLog(result, run.fetchLog, name, { expectAllowed: 0 });
	} finally {
		made.restore?.();
	}
	return result;
}

/**
 * The refusals only a real SDK child can produce: the loader's own results, read after it has run. Each one is a
 * resource the input check passes — it is there, it is readable, it is one file or one directory — and each is a
 * child that must not start: an entry that loaded nothing, an extension that failed, and two tool lists whose tool is
 * not on the session the moment it exists.
 */
async function caseP5SdkRefusal(ctx, plan) {
	const name = `P5-sdk-${plan.name}`;
	const dirs = ctx.setupCase(name);
	const result = implResult(name, plan.title, plan.notes ?? []);
	const made = plan.make(dirs);
	const run = await p5Run(ctx, {
		dirs,
		caller: name,
		result,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		...(made.resources === undefined ? {} : { resources: made.resources }),
		...(made.rawInput === undefined ? {} : { rawInput: made.rawInput }),
		phase: "refused",
	});
	p5CheckRefusal(result, run, { stage: plan.stage, expect: plan.expect, absent: made.absent ?? [] });
	// A real SDK ran: the sdk stage was reported, and the refusal came before the child served anything.
	result.check(run.stages.includes("sdk"), `the child did not report the sdk stage, so this refusal is not a real-SDK measurement: ${JSON.stringify(run.stages)}`);
	result.check(run.stages.includes("serving") === false, `the child reached the serving stage before refusing: ${JSON.stringify(run.stages)}`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	checkFetchLog(result, run.fetchLog, name, { expectAllowed: 0 });
	return result;
}

function p5SdkRefusalPlans() {
	const brokenMarker = "SPIKE-BROKEN-EXTENSION-MARKER-do-not-echo";
	return [
		{
			name: "empty-skill-dir",
			title: "a skills entry that is an empty directory, which the loader answers with nothing at all",
			stage: "resources",
			expect: ["loaded nothing"],
			notes: ["the entry exists and is readable, so the input check passes it: only the loader's own result says it brought no skill"],
			make: (dirs) => {
				const empty = path.join(dirs.caseRoot, "resources", "empty-skills");
				fs.mkdirSync(empty, { recursive: true });
				return { resources: { skills: [empty] } };
			},
		},
		{
			name: "broken-extension",
			title: "a local extension whose module body throws, which the loader reports as a failure rather than raising",
			stage: "resources",
			expect: ["failed to load"],
			notes: ["the marker inside the failure stands in for a file's own text: the refusal must not repeat what the failure said"],
			make: (dirs) => {
				const broken = path.join(dirs.caseRoot, "resources", "broken-ext.ts");
				write(broken, p5BrokenExtension(brokenMarker));
				return { resources: { extensions: [broken] }, absent: [brokenMarker] };
			},
		},
		{
			name: "missing-tool",
			title: "a role tool list naming a tool no resource registers",
			stage: "runtime",
			expect: ["spike_absent_tool"],
			notes: ["the extension loads and registers its own tool; the missing name is the one nothing registers"],
			make: (dirs) => {
				const probe = path.join(dirs.caseRoot, "resources", "probe-ext.ts");
				write(probe, p5ProbeExtension());
				return { resources: { extensions: [probe] }, rawInput: { tools: [...p5RoleTools("implement"), "spike_absent_tool"] } };
			},
		},
		{
			name: "late-tool",
			title: "a tool an extension registers in session_start rather than in its factory body",
			stage: "runtime",
			expect: ["spike_late_tool"],
			notes: ["the deliberate limit the production check names: a registration in a later hook is not this session's tool"],
			make: (dirs) => {
				const late = path.join(dirs.caseRoot, "resources", "late-ext.ts");
				write(late, p5LateToolExtension("spike_late_tool"));
				return { resources: { extensions: [late] }, rawInput: { tools: [...p5RoleTools("implement"), "spike_late_tool"] } };
			},
		},
	];
}

/** The installed build's own built-in theme, copied under a fixture name: a theme a package bundles has to be a real one. */
const p5ThemeValue = (name) => {
	const builtin = JSON.parse(fs.readFileSync(path.join(packageRoot, "dist", "modes", "interactive", "theme", "dark.json"), "utf8"));
	return { ...builtin, name };
};

/**
 * Case group P5.7: a local package named as an extensions entry, in three shapes. A package manifest can carry more
 * than the extension the call wanted, and turning discovery off does not answer for what a package brings with it, so
 * what the loader ended up holding is what decides each of these. The package is a real one on disk, loaded through
 * the public package rules; nothing here simulates a loader result.
 */
async function caseP5Packages(ctx) {
	const results = [];

	const bundled = implResult("P5-package-prompts-themes", "a package that bundles a prompt template and a theme beside its extension", [
		"this package bundles no skill at all, so the refusal under test is the one for a kind this binding selects none of",
	]);
	const bundledDirs = ctx.setupCase("P5-package-prompts-themes");
	const bundledPackage = p5WritePackage(path.join(bundledDirs.caseRoot, "resources", "spike-pkg-assets"), {
		name: "spike-pkg-assets",
		extension: markerExtension("p5-package-command", "A fixture package extension"),
		prompt: { name: "spike-pkg-prompt", description: "A prompt template this package bundles", body: "Do nothing." },
		theme: { name: "spike-pkg-theme", value: p5ThemeValue("spike-pkg-theme") },
	});
	const bundledRun = await p5Run(ctx, {
		dirs: bundledDirs,
		caller: "P5-package-assets",
		result: bundled,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [bundledPackage] },
		phase: "refused",
	});
	p5CheckRefusal(bundled, bundledRun, { stage: "resources", expect: ["a role on this backend selects none"] });
	bundled.check(bundledRun.stages.includes("sdk"), `the child did not report the sdk stage: ${JSON.stringify(bundledRun.stages)}`);
	checkManagedCall(bundled, bundledRun.observations, { dirs: bundledDirs, diffs: bundledRun.diffs, expectSharedAuth: true });
	checkFetchLog(bundled, bundledRun.fetchLog, "P5-package-assets", { expectAllowed: 0 });
	results.push(bundled);

	/* The same package shape with a bundled skill, first unselected and then selected. */
	const skillDirs = ctx.setupCase("P5-package-skills");
	const skillPackage = p5WritePackage(path.join(skillDirs.caseRoot, "resources", "spike-pkg-skills"), {
		name: "spike-pkg-skills",
		extension: markerExtension("p5-package-command", "A fixture package extension"),
		skill: { name: "spike-pkg-skill", description: `A skill this package bundles. ${P5_SKILL_SENTINEL}` },
	});
	const packageSkills = path.join(skillPackage, "skills");

	const undeclared = implResult("P5-package-skill-undeclared", "a package whose manifest brings a skill the call did not select", [
		"the package carries no prompt template and no theme, so the refusal under test is the undeclared skill and not another kind",
	]);
	const undeclaredRun = await p5Run(ctx, {
		dirs: skillDirs,
		caller: "P5-package-undeclared",
		result: undeclared,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [skillPackage] },
		phase: "refused",
	});
	p5CheckRefusal(undeclared, undeclaredRun, { stage: "resources", expect: ["skills this call did not name"] });
	undeclared.check(undeclaredRun.stages.includes("sdk"), `the child did not report the sdk stage: ${JSON.stringify(undeclaredRun.stages)}`);
	checkManagedCall(undeclared, undeclaredRun.observations, { dirs: skillDirs, diffs: undeclaredRun.diffs, expectSharedAuth: true });
	checkFetchLog(undeclared, undeclaredRun.fetchLog, "P5-package-undeclared", { expectAllowed: 0 });
	results.push(undeclared);

	const selected = implResult("P5-package-skill-selected", "the same bundled skill, selected through the call's own skills list", [
		"the one difference from the case above is the skills entry: the same package, the same assets, and a call that selected the skill",
	]);
	const selectedRun = await p5Run(ctx, {
		dirs: skillDirs,
		caller: "P5-package-selected",
		result: selected,
		handle: "run-p5b",
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [skillPackage], skills: [packageSkills] },
		driveLabel: "probes and commands",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const commands = await p5Commands(child, outcome);
			outcome.check(commands.includes("p5-package-command"), `the package's own extension registered no command: ${JSON.stringify(commands)}`);
			outcome.check(commands.includes("skill:spike-pkg-skill"), `the package's own skill registered no command: ${JSON.stringify(commands)}`);
			outcome.check(commands.includes("pkg-marker") === false, "the local package seeded in the user's own settings was loaded as well");
			return true;
		},
	});
	selected.check(selectedRun.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(selectedRun.finished.observations.childExit)} instead of code 0`);
	selected.check(selectedRun.requests.length === 0, `the case reached the model server ${selectedRun.requests.length} time(s) although it submits no task prompt`);
	checkManagedCall(selected, selectedRun.observations, { dirs: skillDirs, diffs: selectedRun.diffs, expectSharedAuth: true });
	checkFetchLog(selected, selectedRun.fetchLog, "P5-package-selected", { expectAllowed: 0 });
	results.push(selected);
	return results;
}

/**
 * Case group P5.8: this host's own extension named as a resource, three ways — the module itself, the directory that
 * holds it, and the repository root, whose own package manifest resolves to that module. Each one has to be refused at
 * the resources stage. The module is loaded before that check runs, and the child marker is what keeps a loaded Fusion
 * from registering anything: this is a refusal about the resource being the wrong resource, not a claim that no copy
 * of Fusion was ever evaluated in the child.
 *
 * The three do not all refuse for the same reason, and the difference is measured rather than smoothed over. An
 * explicit extensions entry goes through this Pi's package manager: a file is loaded as a module, a directory is read
 * by package rules — its `pi` manifest, or the conventional `extensions/`, `skills/`, `prompts/` and `themes/`
 * directories inside it — and a directory those rules find nothing in is then handed to the module loader as it is.
 * `extensions/` here is such a directory, so this host's module is never loaded from it and the call is refused as an
 * extension that failed to load rather than as self-inclusion. The refusal, the stage, the exit code and the absence of
 * any model request are the same; which of the two refusals arrives is what each variant records.
 */
async function caseP5SelfInclusion(ctx) {
	const results = [];
	const variants = [
		{ name: "file", entry: path.join(repoRoot, "extensions", "fusion.ts"), title: "this install's own extension module named directly", self: true },
		{
			name: "directory",
			entry: path.join(repoRoot, "extensions"),
			title: "the directory that holds this install's own extension",
			self: false,
			expect: ["failed to load"],
			note: "measured, not assumed: package rules find no resource directory inside it, so this Pi hands the directory itself to the module loader and the self check never sees this host's module",
		},
		{ name: "package-root", entry: repoRoot, title: "this repository's root, whose package manifest names that module", self: true },
	];
	for (const variant of variants) {
		const name = `P5-self-${variant.name}`;
		const dirs = ctx.setupCase(name);
		const result = implResult(name, `the child refuses ${variant.title}`, [
			"the marker `PI_FUSION_CHILD=pi` is what stops a loaded Fusion registering anything; this case asserts the marker and the refusal, not that the module was never evaluated",
			...(variant.note ? [variant.note] : []),
		]);
		const run = await p5Run(ctx, {
			dirs,
			caller: name,
			result,
			role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
			resources: { extensions: [variant.entry] },
			phase: "refused",
		});
		p5CheckRefusal(result, run, { stage: "resources", expect: variant.expect ?? ["this host's own extension"] });
		result.observations.selfRefusal = run.failure?.error?.includes("this host's own extension") === true;
		result.check(
			result.observations.selfRefusal === variant.self,
			variant.self
				? `the refusal is not the self-inclusion one: ${JSON.stringify(run.failure?.error)}`
				: `this variant is recorded as refusing for another reason, and it refused as self-inclusion after all: ${JSON.stringify(run.failure?.error)}`,
		);
		result.observations.childMarker = run.observations.launch?.childMarker ?? null;
		result.check(result.observations.childMarker === "pi", `the child carried ${JSON.stringify(result.observations.childMarker)} instead of the pi marker`);
		result.check(run.stages.includes("sdk"), `the child did not report the sdk stage: ${JSON.stringify(run.stages)}`);
		checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
		checkFetchLog(result, run.fetchLog, name, { expectAllowed: 0 });
		results.push(result);
	}
	return results;
}

/**
 * Case P5.9: the other way in. A local fixture extension imports this host's extension and calls it with an
 * instrumented wrapper of the real `ExtensionAPI` it was handed, so what the host extension does with a real api is
 * recorded rather than inferred. The fixture then registers a command of its own on the original api, which is the
 * control: a normal extension still works beside the wrapper.
 *
 * What this cannot do: Pi 0.85.1 answers no RPC command with the session's tool names, and `get_state` carries no tool
 * field, so there is no tool list to read back. Nothing here invents one. The commands are read where they are
 * readable, the wrapper's own record is the direct evidence, and the host-side positive control for registration lives
 * in the default suite against a fake api — never as an unmarked Fusion in a real child.
 */
async function caseP5IndirectRecursion(ctx) {
	const dirs = ctx.setupCase("P5-indirect-recursion");
	const result = implResult("P5-indirect-recursion", "a local extension that imports this host's extension and calls it with the real extension api", [
		"the wrapper records and performs nothing, so a registration the host extension attempted is a recorded call rather than a tool nobody can see",
		"Pi 0.85.1 has no tool-list RPC response and no tool field on get_state; a model request's tool schemas are corroboration and an allow list can hide a registered tool",
	]);
	const report = path.join(dirs.caseRoot, "recursion.json");
	const fixture = path.join(dirs.caseRoot, "resources", "recursion-ext.ts");
	write(fixture, p5RecursionExtension({ fusionPath: path.join(repoRoot, "extensions", "fusion.ts"), report }));
	const run = await p5Run(ctx, {
		dirs,
		caller: "P5-recursion",
		result,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [fixture] },
		driveLabel: "probes, commands and the wrapper's report",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const commands = await p5Commands(child, outcome);
			outcome.check(commands.includes(P5_RECURSION_COMMAND), `the fixture extension registered no command of its own: ${JSON.stringify(commands)}`);
			outcome.check(commands.includes("fusion") === false, `this host's own command reached a child: ${JSON.stringify(commands)}`);
			const seen = await p5Notified(child, outcome, P5_RECURSION_COMMAND, P5_RECURSION_PREFIX, "wrapper");
			outcome.check(seen.marker === "pi", `the child's marker was ${JSON.stringify(seen.marker)} inside the extension`);
			outcome.check(Array.isArray(seen.calls) && seen.calls.length === 0, `the host extension called the extension api ${JSON.stringify(seen.calls)}`);
			// Not only that it registered nothing: that it read nothing off the api either, which is what returning on
			// the marker before touching it looks like.
			outcome.check(Array.isArray(seen.properties) && seen.properties.length === 0, `the host extension read ${JSON.stringify(seen.properties)} off the extension api`);
			outcome.check(seen.error === null, `calling the host extension threw: ${JSON.stringify(seen.error)}`);
			return true;
		},
	});
	result.observations.wrapperReportFile = readJsonIfPresent(report) ?? { missing: true };
	result.check(Array.isArray(result.observations.wrapperReportFile.calls) && result.observations.wrapperReportFile.calls.length === 0, "the record the extension wrote to disk holds a call the host extension made");
	result.check(Array.isArray(result.observations.wrapperReportFile.properties) && result.observations.wrapperReportFile.properties.length === 0, "the record the extension wrote to disk holds a property the host extension read");
	result.check(result.observations.wrapperReportFile.error === null, `the record the extension wrote to disk holds a throw: ${JSON.stringify(result.observations.wrapperReportFile.error)}`);
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.check(run.requests.length === 0, `the case reached the model server ${run.requests.length} time(s) although it submits no task prompt`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	checkFetchLog(result, run.fetchLog, "P5-recursion", { expectAllowed: 0 });
	return result;
}

/**
 * Case P5.10: one ordinary write a child's own task makes on purpose. The scripted loopback model answers the task
 * with a `bash` tool call that writes one marker file and then settles with text, so what is measured is a shell
 * command a model asked for and the exact change it left in the disposable project. This case runs with the ordinary
 * copied `PATH` and **no** installer shim, so it says nothing about what would happen if an installation were asked
 * for: what it says is that no installation was asked for. The script holds one tool call and one final text, and the
 * one tool call writes the marker file.
 */
async function caseP5ProjectWrite(ctx) {
	const dirs = ctx.setupCase("P5-project-write");
	const result = implResult("P5-project-write", "a child's own task writes one marker file in the disposable project, through the bash tool", [
		"the model is a loopback fixture answering a script: one bash tool call, then one final text, and no other step exists in it",
		"the ordinary copied PATH, with no installer shim in front of it: the script requests no installation, and its one tool call writes the marker file",
	]);
	const marker = path.join(dirs.project, P5_WRITE_RELATIVE);
	const command = `mkdir -p node_modules && printf '%s\\n' '${P5_WRITE_MARKER}' > ${P5_WRITE_RELATIVE}`;
	ctx.server.script(P5_WRITE_SENTINEL, [
		{ kind: "tool_call", name: "write-marker", toolName: "bash", arguments: { command }, toolCallId: "call_p5_write" },
		{ kind: "text", name: "final", text: ANSWER },
	]);
	const run = await p5Run(ctx, {
		dirs,
		caller: "P5-write",
		result,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		driveLabel: "one scripted task",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const prompt = await child.send({ type: "prompt", message: `${P5_WRITE_SENTINEL} write the marker file the script names.` });
			outcome.check(prompt.success === true, "the task prompt was rejected");
			// The settled event, not the end of a turn: a retry, a compaction retry or a queued continuation would
			// still be ahead of a run that had only ended.
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			outcome.observations.answer = text.data?.text ?? null;
			outcome.check(text.data?.text?.includes(ANSWER) === true, "the scripted final answer did not come back");
			return true;
		},
	});
	result.observations.markerFile = fs.existsSync(marker) ? { present: true, content: fs.readFileSync(marker, "utf8").trim() } : { present: false };
	result.check(result.observations.markerFile.content === P5_WRITE_MARKER, `the marker file holds ${JSON.stringify(result.observations.markerFile)}`);
	result.observations.projectDiff = formatDiff(run.diffs.project);
	result.observations.scriptSteps = run.requests.map((request) => request.scriptStep ?? null);
	result.check(run.requests.length === 2, `the task made ${run.requests.length} model request(s) instead of the two the script answers`);
	result.check(
		run.requests.every((request) => request.method === "POST" && request.url.endsWith("/chat/completions") && request.model === FIXTURE_MODEL),
		`an unexpected model request was made: ${JSON.stringify(run.requests.map((request) => `${request.method} ${request.url} ${request.model}`))}`,
	);
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	checkManagedCall(result, run.observations, {
		dirs,
		diffs: run.diffs,
		expectSharedAuth: true,
		projectCreated: ["node_modules", P5_WRITE_RELATIVE],
	});
	checkFetchLog(result, run.fetchLog, "P5-write", { expectAllowed: "some" });
	return result;
}

/**
 * What P5 actually ran, counted apart: a refused call is never a session, and a skipped case is never either. The
 * numbers come from what each run reported — the diagnostic stages the child wrote and the requests the loopback
 * fixture recorded — rather than from the number of cases in the group.
 */
function p5CountsResult(ctx, results) {
	const counts = ctx.p5;
	const result = implResult("P5-counts", "what the group ran, counted by kind", [
		"a pure accounting case: no process, no child and no fixture of its own",
	]);
	result.observations = {
		...counts,
		// The group's own cases, this accounting one excluded: it is built from what has already run.
		casesBeforeThisOne: results.length,
		skipped: results.filter((one) => one.observations?.skipped !== undefined).map((one) => one.name),
		failedCases: results.filter((one) => one.failures.length > 0).map((one) => one.name),
	};
	result.check(
		counts.bootstrapInvocations === counts.preSdkRefusals + counts.sdkLoaded,
		`the ${counts.bootstrapInvocations} bootstrap invocations do not account as ${counts.preSdkRefusals} pre-SDK refusals plus ${counts.sdkLoaded} children that loaded the SDK`,
	);
	result.check(counts.serving <= counts.sdkLoaded, "more children served than loaded the SDK, which cannot be");
	result.check(counts.rpcAnswered <= counts.serving, "more children answered RPC than reached the serving stage, which cannot be");
	result.check(counts.refusalsAfterSdk + counts.serving === counts.sdkLoaded, `${counts.sdkLoaded} children loaded the SDK, and ${counts.refusalsAfterSdk} refusals plus ${counts.serving} serving children do not add up to it`);
	return result;
}

/** The P5 group, in the order its fixtures and its controls depend on each other. */
async function caseP5Group(ctx) {
	const results = [];
	ctx.p5 = p5Counters();
	// A loopback listener that must never be reached: the shims point `npm_config_registry` at it, so a case that
	// somehow ran an installer would leave a request here rather than reaching a real registry.
	ctx.p5Registry = await startForbiddenServer({ label: "P5-registry" });
	ctx.servers.push(ctx.p5Registry);
	results.push(await caseP5ShimControl(ctx));
	results.push(await caseP5Suppression(ctx));
	results.push(await caseP5ExplicitResources(ctx));
	results.push(await caseP5SymlinkResources(ctx));
	for (const plan of p5InputRefusalPlans()) results.push(await caseP5InputRefusal(ctx, plan));
	for (const plan of p5SdkRefusalPlans()) results.push(await caseP5SdkRefusal(ctx, plan));
	results.push(...(await caseP5Packages(ctx)));
	results.push(...(await caseP5SelfInclusion(ctx)));
	results.push(await caseP5IndirectRecursion(ctx));
	results.push(await caseP5ProjectWrite(ctx));
	results.push(p5CountsResult(ctx, results));
	return results;
}

/* ---------------------------------------------------------------------- the group runner */

/* ------------------------------------------------- P6: the shared credential file on a real child (step 4, task 4) */

/*
 * What this group adds, and what it is not. The auth half of step 4 was measured once before, in
 * `test/spikes/pi-auth.mjs`, against the public `ModelRuntime` credential path with no session, no prompt and no
 * bootstrap: that report keeps its own provenance and is not restated or replaced here. These three cases run the
 * **production bootstrap** as a real child, through the same controller and the same production helpers every case
 * above uses, with one OAuth provider whose every credential is a literal `DUMMY-` label and whose token endpoint is a
 * loopback service this harness owns. The provider reaches the child the ordinary way — a fixture extension the call
 * names in `resources.extensions`, composed by the production composer — and nothing here registers a provider for it,
 * hands it a key or sets a variable that could stand in for the shared credential file.
 *
 * Two things at the user's auth path are kept apart, exactly as the auth spike keeps them: the rotating credential
 * write into `auth.json`, which only a refresh performs and which `checkManagedCall`'s `profileModified` allowance
 * names as the one expected change, and the transient adjacent `auth.json.lock` the SDK's credential store takes for a
 * read as much as for a refresh, which is asserted on its own by having to be gone once every writer has exited.
 *
 * Who reads the shared file: inside the child the SDK's own credential store reads and rotates it, which is the
 * behavior under measurement, and this harness reads its bytes only while no caller and no child is running — the
 * seed before a case starts, the assertions after every process of that case has exited.
 */

const OAUTH_PROVIDER = "fixture-oauth";
const AUTH_FILE = "auth.json";
const MINUTE = 60_000;
/** The provider-specific extra field on the selected entry: it survives a rotation only if the callback re-emits it. */
const OAUTH_EXTRA_FIELD = "fixtureExtra";
const OAUTH_EXTRA_VALUE = "DUMMY-extra-keep-me";
/** A marker that stands in for a credential inside a malformed auth file. Startup must not echo it. */
const AUTH_MARKER = "SPIKE-MARKER-DUMMY-AUTH-CREDENTIAL-do-not-echo";
/** The lifetime a minted dummy credential carries, well outside the SDK's own five-minute refresh window. */
const TOKEN_LIFETIME_MS = 40 * MINUTE;
/** How long a case waits for the token endpoint to be asked, and for a task that cannot resolve a credential to end. */
const TOKEN_DEADLINE_MS = 30_000;
const FAILED_TASK_DEADLINE_MS = 120_000;
/**
 * How many times this build asks a provider's refresh callback for one task whose every attempt fails, measured rather
 * than chosen: the bootstrap's own in-memory retry settings are what decide it, and this harness neither disables them
 * nor adds an attempt of its own. A build that does something else is a finding to record here by hand.
 */
const P6_EXPECTED_REFRESH_ATTEMPTS = 4;

/**
 * The entries a seeded credential file carries besides the selected one, all of them dummy values in valid generic
 * credential shapes: the api-key credential the seeded `models.json` provider is reached through, one for another
 * provider, one under `meta` standing for something a newer runtime may write beside the credentials, and one for a
 * provider nothing here registers. Every case requires all four back JSON for JSON, because the authorized write is
 * one entry's and not the file's.
 */
const P6_UNRELATED = {
	[FIXTURE_PROVIDER]: { type: "api_key", key: FIXTURE_KEY },
	"fixture-other": { type: "api_key", key: "DUMMY-api-key-other", env: { FIXTURE_ACCOUNT: "DUMMY-account-id" } },
	meta: { type: "api_key", key: "DUMMY-api-key-meta-newer-entry" },
	"fixture-unknown-provider": { type: "api_key", key: "DUMMY-api-key-unknown-provider" },
};

/** The seeded OAuth credential: generation 1, and the only credential material this group starts from. */
const p6Credential = (expiresAt) => ({ type: "oauth", access: "DUMMY-access-1", refresh: "DUMMY-refresh-1", expires: expiresAt, [OAUTH_EXTRA_FIELD]: OAUTH_EXTRA_VALUE });

/**
 * One shared credential file, seeded in place at mode 0600 over the one the profile fixture wrote. There is never a
 * second copy of the family and never a reseed inside a case: the file a case asserts on is the file its child read.
 */
function p6SeedAuth(file, selected) {
	write(file, `${JSON.stringify({ [OAUTH_PROVIDER]: selected, ...P6_UNRELATED }, null, 2)}\n`);
	fs.chmodSync(file, 0o600);
	return fs.readFileSync(file);
}

/** The credential file by its bytes, its entries and its mode. Read by this harness only while nothing is running. */
const p6ReadAuth = (file) => {
	const bytes = fs.readFileSync(file);
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		parsed = undefined;
	}
	return { bytes, sha: hashFile(file), parsed, mode: (fs.statSync(file).mode & 0o777).toString(8) };
};

/** The generation of a dummy credential, or null: the value itself is never reported, only which generation it is. */
const p6LabelOf = (value) => {
	const found = typeof value === "string" ? /^DUMMY-(?:access|refresh)-(\d+)$/.exec(value) : null;
	return found ? Number(found[1]) : null;
};

const p6Unrelated = (parsed) => Object.keys(P6_UNRELATED).every((key) => JSON.stringify(parsed?.[key]) === JSON.stringify(P6_UNRELATED[key]));

/**
 * The token endpoint this group's fixture provider posts to: a loopback listener that mints the next dummy generation,
 * or refuses before minting for the whole of the case that measures a failed refresh. It is the auth spike's own
 * endpoint narrowed to what these three cases need — no gates, no marks, no held responses — and it is a fixture
 * credential minter and not an OAuth server: there is no authorization code, no client, no discovery and no provider
 * api anywhere in it. Every request is recorded by the generation it carried, and any other path is recorded as
 * unexpected and answered 404 so a case can assert it never happened.
 */
async function startTokenServer({ label, refuseAlways = false }) {
	const requests = [];
	const unexpected = [];
	/** The seed is generation 1, so the first minted credential is generation 2. */
	let nextLabel = 2;
	const answer = (response, body, status = 200) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
	const server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		if (url.pathname === "/token" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				let sent;
				try {
					sent = JSON.parse(body);
				} catch {
					sent = {};
				}
				const record = {
					at: Date.now(),
					// What the callback posted, as a generation and a boolean: never the credential it carried.
					refreshLabel: p6LabelOf(sent?.refresh),
					carriesDummyMarker: typeof sent?.refresh === "string" && sent.refresh.includes(DUMMY_MARKER),
				};
				requests.push(record);
				if (refuseAlways) {
					record.outcome = "500";
					answer(response, { error: "fixture token endpoint refused before minting" }, 500);
					return;
				}
				const minted = nextLabel++;
				record.outcome = "minted";
				record.mintedLabel = minted;
				answer(response, { access: `DUMMY-access-${minted}`, refresh: `DUMMY-refresh-${minted}`, expiresInMs: TOKEN_LIFETIME_MS });
			});
			return;
		}
		unexpected.push({ at: Date.now(), method: request.method, path: url.pathname });
		answer(response, { error: "no such fixture endpoint" }, 404);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const baseUrl = `http://127.0.0.1:${port}`;
	let closed = false;
	return {
		label,
		baseUrl,
		origin: baseUrl,
		tokenUrl: `${baseUrl}/token`,
		requests,
		unexpected,
		/** Waits for something observable rather than for a duration: an expired deadline is a failure a case reports. */
		waitForRequests: async (count, timeoutMs = TOKEN_DEADLINE_MS) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (requests.length >= count) return requests.slice(0, count);
				await sleep(20);
			}
			throw new Error(`the token endpoint was asked ${requests.length} time(s) and not ${count} within ${timeoutMs}ms`);
		},
		close: async () => {
			if (closed) return;
			closed = true;
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * The fixture OAuth provider, as an extension a call names like any other resource. It registers one provider with one
 * exact model at the loopback model server and the three public callbacks a provider with OAuth support has — `login`,
 * `refreshToken` and `getApiKey`, beside the display name the block also carries. There is
 * no `apiKey` and no environment credential on it: the only credential it can run on is the one the shared auth file
 * holds, which is the whole point of the cases below.
 *
 * `login` throws, because this measures the credential store on a real child and not a login flow. `refreshToken`
 * posts the current dummy refresh label to the harness's own endpoint with the signal the SDK supplies, so the SDK's
 * own refresh timeout and a cancellation both reach it; a refusal is a fixed sentence of this fixture's own and the
 * status the fixture itself answered, and nothing of a response body reaches it. Every field of the current credential
 * is re-emitted deliberately: the SDK's extension-oauth adapter stores what this returns with `type` added, so the
 * provider-specific extra field survives a rotation because this callback carries it over and not because anything
 * preserves it implicitly. `getApiKey` returns the access label, which is what a model request then carries.
 */
const p6OauthExtension = ({ providerId, modelId, baseUrl, tokenUrl }) => `export default function (pi) {
	pi.registerProvider(${JSON.stringify(providerId)}, {
		name: "Fixture OAuth provider (dummy credentials, loopback token endpoint)",
		baseUrl: ${JSON.stringify(baseUrl)},
		api: "openai-completions",
		models: [
			{
				id: ${JSON.stringify(modelId)},
				name: "Fixture Model (oauth)",
				reasoning: true,
				input: ["text"],
				contextWindow: 32000,
				maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			},
		],
		oauth: {
			name: "fixture oauth (dummy credentials, loopback token endpoint)",
			login: async () => {
				throw new Error("the fixture provider does not log in: this case measures the credential store on a real child, not a login flow");
			},
			refreshToken: async (credentials, signal) => {
				const response = await fetch(${JSON.stringify(tokenUrl)}, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ refresh: credentials.refresh }),
					signal,
				});
				if (!response.ok) throw new Error("the fixture token endpoint answered " + response.status);
				const minted = await response.json();
				return { ...credentials, access: minted.access, refresh: minted.refresh, expires: Date.now() + minted.expiresInMs };
			},
			getApiKey: (credentials) => credentials.access,
		},
	});
}
`;

/** One case's own fixture: the seeded credential file, its own token endpoint and the extension that reaches it. */
async function p6Fixture(ctx, name, { selected, refuseAlways = false }) {
	const dirs = ctx.setupCase(name);
	const authFile = path.join(dirs.profile, AUTH_FILE);
	const seedBytes = selected === undefined ? undefined : p6SeedAuth(authFile, selected);
	const token = await startTokenServer({ label: name, refuseAlways });
	ctx.servers.push(token);
	const extension = path.join(dirs.caseRoot, "resources", "oauth-provider-ext.ts");
	write(extension, p6OauthExtension({ providerId: OAUTH_PROVIDER, modelId: FIXTURE_MODEL, baseUrl: ctx.server.baseUrl, tokenUrl: token.tokenUrl }));
	return { dirs, authFile, seedBytes, token, extension };
}

/** The exact loopback traffic a P6 call made, by origin and path together, compared as a whole rather than counted. */
function p6CheckTraffic(result, run, caller, expected) {
	const { allowed } = checkFetchLog(result, run.fetchLog, caller, { expectAllowed: Object.keys(expected).length === 0 ? 0 : "some" });
	const counts = {};
	for (const record of allowed) {
		const key = `${record.origin}${record.path}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}
	result.observations.guardedTraffic = counts;
	const asText = (value) => JSON.stringify(Object.entries(value).sort());
	result.check(asText(counts) === asText(expected), `the guarded traffic was ${asText(counts)} rather than exactly ${asText(expected)}`);
}

/** What a case says about the credential file once every process of that case has exited, and about the lock beside it. */
function p6CheckLock(result, authFile) {
	result.observations.lockAfterExit = fs.existsSync(`${authFile}.lock`);
	result.check(result.observations.lockAfterExit === false, "the credential store's adjacent auth.json.lock was still there after every writer had exited");
}

/**
 * Case P6.1: one real bootstrap child on a credential inside the ordinary refresh window. The child selects the
 * fixture OAuth provider's exact model, answers the non-task probes, runs one ordinary prompt through RPC, and the
 * credential it reaches the model with is the one its own refresh minted rather than the one the file was seeded with.
 * The seeded file is the user's own: `sharedAuth` is true and the path the storage selected is that file.
 */
async function caseP6Rotation(ctx, counters) {
	const result = implResult("P6-oauth-rotation", "a real bootstrap child rotates the shared credential once and reaches the model with the credential it minted", [
		"the provider comes in as an ordinary named resource through the production composer; no key, variable or apiKey field can stand in for the shared file",
		"one prompt, so the credential the model request carried is a measurement rather than an inference",
		"no Fusion record, history file or dashboard entry is written anywhere in this case: the controller still stands in for the transport task 6 owes",
	]);
	const { dirs, authFile, seedBytes, token, extension } = await p6Fixture(ctx, "P6-oauth-rotation", { selected: p6Credential(Date.now() + MINUTE) });
	const run = await p5Run(ctx, {
		dirs,
		caller: "P6-rotation",
		result,
		counters,
		handle: "run-p6",
		role: { name: "implement", model: `${OAUTH_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [extension] },
		extraOrigins: [token.origin],
		driveLabel: "probes and one prompt",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: OAUTH_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			// When the prompt went out, by this harness's own clock, which is also the clock the token endpoint records
			// with: startup and the three non-task probes are on the other side of it, so a request before this instant
			// would be one the child made without being asked to do any work.
			outcome.observations.promptAt = Date.now();
			const prompt = await child.send({ type: "prompt", message: "Say the fixture answer." });
			outcome.check(prompt.success === true, `the task prompt was rejected: ${prompt.error ?? ""}`);
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			outcome.observations.answer = text.data?.text ?? null;
			outcome.check(text.data?.text?.includes(ANSWER) === true, "the loopback fixture answer did not come back");
			return true;
		},
	});
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	// The file the call ran on is the user's own, named by the storage rather than by this case.
	result.observations.authPath = run.observations.storage?.authPath;
	result.check(run.observations.storage?.authPath === authFile, `the call ran on ${JSON.stringify(run.observations.storage?.authPath)} instead of the seeded user file ${authFile}`);
	// The token endpoint: one request, carrying the seeded generation, answered with the next one.
	result.observations.tokenRequests = token.requests;
	result.observations.tokenUnexpected = token.unexpected;
	result.check(token.requests.length === 1, `the token endpoint was asked ${token.requests.length} time(s) instead of once`);
	result.observations.tokenRequestsBeforePrompt = token.requests.filter((request) => request.at < result.observations.promptAt).length;
	result.check(result.observations.tokenRequestsBeforePrompt === 0, `${result.observations.tokenRequestsBeforePrompt} token request(s) were made before the prompt, so this build refreshes a credential to start a child rather than to run its work`);
	result.check(token.requests[0]?.refreshLabel === 1, `the refresh carried generation ${JSON.stringify(token.requests[0]?.refreshLabel)} instead of the seeded 1`);
	result.check(token.requests[0]?.carriesDummyMarker === true, "the refresh did not carry one of this fixture's own dummy credentials");
	result.check(token.requests[0]?.mintedLabel === 2, `the endpoint minted generation ${JSON.stringify(token.requests[0]?.mintedLabel)} instead of 2`);
	result.check(token.unexpected.length === 0, `the token service was asked for ${JSON.stringify(token.unexpected)}`);
	// The model request: exactly one, and the credential on it is the minted generation and nothing else.
	result.observations.modelRequests = run.requests.map((request) => ({ model: request.model, authorization: request.authorization }));
	result.check(run.requests.length === 1, `the case made ${run.requests.length} model request(s) instead of the one it prompts for`);
	result.check(
		run.requests.every((request) => request.authorization?.kind === "dummy-access" && request.authorization.label === 2),
		`a model request carried ${JSON.stringify(result.observations.modelRequests)} rather than only the minted generation 2`,
	);
	result.check(
		run.requests.every((request) => request.authorizationMatchesFixtureKey === false),
		"a model request carried the seeded api-key credential instead of the provider's own OAuth credential",
	);
	// The file afterwards, read now that the caller and its child have both exited.
	const after = p6ReadAuth(authFile);
	const selected = after.parsed?.[OAUTH_PROVIDER];
	result.observations.authAfter = {
		accessLabel: p6LabelOf(selected?.access),
		refreshLabel: p6LabelOf(selected?.refresh),
		expiresInMinutes: typeof selected?.expires === "number" ? Math.round((selected.expires - Date.now()) / MINUTE) : null,
		extraField: selected?.[OAUTH_EXTRA_FIELD] === OAUTH_EXTRA_VALUE,
		type: selected?.type ?? null,
		entries: Object.keys(after.parsed ?? {}).sort(),
		mode: after.mode,
		rewritten: after.bytes.equals(seedBytes) === false,
	};
	result.check(result.observations.authAfter.rewritten, "the credential file was not rewritten, so no rotation reached it");
	result.check(result.observations.authAfter.accessLabel === 2 && result.observations.authAfter.refreshLabel === 2, `the written credential is generation ${JSON.stringify([result.observations.authAfter.accessLabel, result.observations.authAfter.refreshLabel])} instead of 2`);
	result.check(typeof selected?.expires === "number" && selected.expires > Date.now() + 30 * MINUTE, "the written credential does not carry the minted expiry");
	result.check(result.observations.authAfter.extraField, "the provider-specific extra field did not survive the rotation");
	result.check(result.observations.authAfter.type === "oauth", `the written entry is of type ${JSON.stringify(result.observations.authAfter.type)}`);
	result.check(p6Unrelated(after.parsed), "an unrelated credential entry did not come back JSON for JSON");
	result.check(after.mode === "600", `the credential file came back at mode ${after.mode} instead of 600`);
	p6CheckLock(result, authFile);
	// No private credential file anywhere: the call ran on the shared one, so its own directory holds the input alone.
	result.observations.callDirEntries = callEntriesOutsideCache(run.observations.callDirEntries);
	result.check(result.observations.callDirEntries.join(",") === "bootstrap.json", `the call directory held ${JSON.stringify(run.observations.callDirEntries)} rather than the call input and its own caches`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true, profileModified: [AUTH_FILE] });
	p6CheckTraffic(result, run, "P6-rotation", { [`${originOf(ctx.server.baseUrl)}/v1/chat/completions`]: 1, [`${token.origin}/token`]: 1 });
	return result;
}

/**
 * Case P6.2: the same child and the same seeded credential, with the token endpoint refusing for the whole case before
 * it has ever minted. What this pins is the SDK's own behavior rather than a policy of Fusion's: the production retry
 * settings are left exactly as the bootstrap composes them, this harness adds no retry and no attempt of its own, and
 * how many attempts the SDK makes is recorded and required rather than assumed. A prompt this Pi acknowledges is not a
 * task that finished, so the case waits for the session to settle and then asks a non-task operation, which is what
 * says the child is still there. Nothing is minted, no model request is made, and the credential file is left as it was.
 */
async function caseP6RefreshFails(ctx, counters) {
	const result = implResult("P6-oauth-refresh-fails", "a refresh that cannot mint fails the task, leaves the credential file as it was and leaves the child answering", [
		"the endpoint refuses before minting for the whole case: this is a failure before a token was ever issued, and a response lost after a provider had already rotated a family is a different thing and is not measured here",
		"the retry policy is the production bootstrap's own in-memory one, and the attempts below are what this SDK did with it",
	]);
	const { dirs, authFile, seedBytes, token, extension } = await p6Fixture(ctx, "P6-oauth-refresh-fails", { selected: p6Credential(Date.now() + MINUTE), refuseAlways: true });
	const run = await p5Run(ctx, {
		dirs,
		caller: "P6-refresh-fails",
		result,
		counters,
		handle: "run-p6",
		role: { name: "implement", model: `${OAUTH_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [extension] },
		extraOrigins: [token.origin],
		driveLabel: "probes, one prompt that cannot resolve a credential, and a non-task probe after it",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: OAUTH_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			outcome.observations.promptAt = Date.now();
			const prompt = await child.send({ type: "prompt", message: "Say the fixture answer." });
			// An acknowledged prompt says the preflight passed and nothing about the task: what ends it is the settle.
			outcome.observations.promptAcknowledged = prompt.success === true;
			await child.waitFor("agent_settled", FAILED_TASK_DEADLINE_MS);
			// The error surface this SDK produced, recorded as evidence and never copied: how the events came, how many
			// automatic retries it announced, and whether any of that text carries one of this fixture's own labels. The
			// three booleans below are required rather than only recorded, because what they pin is this fixture's own
			// measured surface on this build — that a failed refresh surfaces as this SDK's OAuth wording and as the
			// sentence this fixture's own callback threw, and that no dummy credential label came with it. A change in
			// any of the three is a finding to report here. None of it is a redaction claim: nothing filters a child's
			// own task output or the SDK's own stderr, and this is one fixture on one build rather than a rule.
			outcome.observations.events = child.events.map((event) => event.type);
			outcome.observations.retries = child.events.filter((event) => event.type === "auto_retry_start").map((event) => ({ attempt: event.attempt, maxAttempts: event.maxAttempts }));
			const ends = child.events.filter((event) => event.type === "agent_end");
			outcome.observations.agentEnds = ends.map((event) => ({ willRetry: event.willRetry }));
			const surfaced = JSON.stringify(child.events.filter((event) => event.type !== "response"));
			outcome.observations.errorSurface = {
				carriesDummyMarker: surfaced.includes(DUMMY_MARKER),
				namesTheFixtureEndpointRefusal: surfaced.includes("the fixture token endpoint answered 500"),
				oauthPrefix: surfaced.includes("OAuth refresh failed for"),
			};
			// The child is still there: a non-task operation after the failed task, answered as it was before it.
			const state = await child.send({ type: "get_state" }, 60_000);
			outcome.observations.stateAfterFailure = {
				ok: state.success === true,
				model: state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : null,
			};
			outcome.check(state.success === true, `the child did not answer get_state after its failed task: ${state.error ?? ""}`);
			outcome.check(outcome.observations.stateAfterFailure.model === `${OAUTH_PROVIDER}/${FIXTURE_MODEL}`, `the child reports model ${outcome.observations.stateAfterFailure.model} after its failed task`);
			return true;
		},
	});
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.check(result.observations.promptAcknowledged === true, "the prompt was not acknowledged, so what follows is not a failure of the task this case is about");
	// Every attempt the SDK made, and not one more: the count is this build's and is required rather than assumed.
	result.observations.tokenRequests = token.requests;
	result.observations.tokenAttempts = token.requests.length;
	result.check(token.requests.length === P6_EXPECTED_REFRESH_ATTEMPTS, `the token endpoint was asked ${token.requests.length} time(s) instead of the ${P6_EXPECTED_REFRESH_ATTEMPTS} this build makes`);
	result.check(token.requests.every((request) => request.refreshLabel === 1 && request.carriesDummyMarker === true), `an attempt carried something other than the seeded generation 1: ${JSON.stringify(token.requests)}`);
	result.check(token.requests.every((request) => request.outcome === "500"), "the endpoint minted a credential although this case refuses before minting");
	result.observations.tokenRequestsBeforePrompt = token.requests.filter((request) => request.at < result.observations.promptAt).length;
	result.check(result.observations.tokenRequestsBeforePrompt === 0, `${result.observations.tokenRequestsBeforePrompt} of the attempts were made before the prompt, so the startup this case measures did not reach the endpoint for its own sake`);
	result.check(token.unexpected.length === 0, `the token service was asked for ${JSON.stringify(token.unexpected)}`);
	result.observations.modelRequests = run.requests.length;
	result.check(run.requests.length === 0, `the case reached the model server ${run.requests.length} time(s) although no credential could be resolved`);
	// The measured surface of that failure, required on this build and this fixture: the SDK's own OAuth wording, this
	// fixture's own refusal sentence, and no credential label anywhere in what the child emitted over RPC.
	const surface = result.observations.errorSurface ?? {};
	result.check(surface.oauthPrefix === true, `the child's events did not carry this SDK's own OAuth refresh wording: ${JSON.stringify(surface)}`);
	result.check(surface.namesTheFixtureEndpointRefusal === true, `the child's events did not carry the sentence this fixture's own callback threw: ${JSON.stringify(surface)}`);
	result.check(surface.carriesDummyMarker === false, `a dummy credential label reached what the child emitted over RPC: ${JSON.stringify(surface)}`);
	// The file, byte for byte, now that the caller and its child have both exited.
	const after = p6ReadAuth(authFile);
	result.observations.authUnchanged = after.bytes.equals(seedBytes);
	result.observations.authMode = after.mode;
	result.check(result.observations.authUnchanged, "the credential file was rewritten although no token was ever minted");
	result.check(p6Unrelated(after.parsed), "an unrelated credential entry did not come back JSON for JSON");
	result.check(after.mode === "600", `the credential file came back at mode ${after.mode} instead of 600`);
	p6CheckLock(result, authFile);
	result.observations.callDirEntries = callEntriesOutsideCache(run.observations.callDirEntries);
	result.check(result.observations.callDirEntries.join(",") === "bootstrap.json", `the call directory held ${JSON.stringify(run.observations.callDirEntries)} rather than the call input and its own caches`);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	p6CheckTraffic(result, run, "P6-refresh-fails", { [`${token.origin}/token`]: P6_EXPECTED_REFRESH_ATTEMPTS });
	return result;
}

/**
 * Case P6.3: a malformed credential file, with everything else about the configuration healthy — the models file, the
 * named resource and the exact model are the ones the case above runs on. The production bootstrap refuses at its
 * models stage, which is where it reads the one unstructured aggregate that a credential failure and a model failure
 * both arrive in, before any prompt, any model request and any token request. The auth spike measured that aggregate
 * directly and said the bootstrap *would* refuse by the rule it applies; this is that refusal, measured on a child.
 */
async function caseP6MalformedAuth(ctx, counters) {
	const result = implResult("P6-refuse-malformed-auth", "a malformed shared credential file refuses startup without echoing what it held", [
		"the marker stands in for a credential: the SDK's own read failure quotes the file it choked on, which is why the refusal carries Fusion's fixed wording and no path, error or cause of its own",
		"the source finding is the auth spike's aggregate read; what this case adds is the refusal itself, on a real child",
	]);
	const { dirs, authFile, token, extension } = await p6Fixture(ctx, "P6-refuse-malformed-auth", { selected: undefined });
	// Malformed on purpose, and holding something that stands in for a credential: valid JSON up to the point it stops.
	write(authFile, `{"${OAUTH_PROVIDER}": {"type": "oauth", "access": "${AUTH_MARKER}"`);
	fs.chmodSync(authFile, 0o600);
	const seedBytes = fs.readFileSync(authFile);
	const run = await p5Run(ctx, {
		dirs,
		caller: "P6-malformed-auth",
		result,
		counters,
		handle: "run-p6",
		phase: "refused",
		role: { name: "implement", model: `${OAUTH_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		resources: { extensions: [extension] },
		extraOrigins: [token.origin],
	});
	p5CheckRefusal(result, run, { stage: "models", expect: [bootstrapModule.MODELS_REFUSED], absent: [AUTH_MARKER] });
	result.observations.diagnosticIsTheFixedWording = run.failure?.error?.startsWith(bootstrapModule.MODELS_REFUSED) === true;
	result.check(result.observations.diagnosticIsTheFixedWording, `the refusal is not the bootstrap's fixed wording: ${JSON.stringify(run.failure?.error)}`);
	// What the one diagnostic line may hold: the fixed wording and the models path the host composed, and nothing of
	// the credential file at all — not its marker, not its path, not the SDK's own error and not a cause.
	const diagnostic = JSON.stringify(run.failure ?? {});
	result.observations.diagnosticKeys = Object.keys(run.failure ?? {}).sort();
	result.observations.diagnosticNamesAuth = diagnostic.includes(AUTH_MARKER) || diagnostic.includes(authFile) || diagnostic.includes(AUTH_FILE);
	result.check(result.observations.diagnosticNamesAuth === false, "the diagnostic named the credential file or something it held");
	result.check(result.observations.diagnosticKeys.join(",") === "error,event,sdk,stage", `the diagnostic carried the keys ${JSON.stringify(result.observations.diagnosticKeys)}`);
	result.observations.stagesReported = run.stages;
	result.check(run.stages.join(",") === "input,sdk", `the child completed the stages ${JSON.stringify(run.stages)} rather than refusing at the models stage after the SDK loaded`);
	// The bytes, and everything the refusal must not have reached: a token endpoint, a transcript, a lock, a call directory.
	result.observations.tokenRequests = token.requests.length;
	result.check(token.requests.length === 0, `a refused call asked the token endpoint ${token.requests.length} time(s)`);
	result.observations.authUnchanged = fs.readFileSync(authFile).equals(seedBytes);
	result.check(result.observations.authUnchanged, "the malformed credential file was rewritten");
	p6CheckLock(result, authFile);
	result.observations.callDirEntries = callEntriesOutsideCache(run.observations.callDirEntries);
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	p6CheckTraffic(result, run, "P6-malformed-auth", {});
	return result;
}

/**
 * The P6 group: the rotation first, because the two below are read against it, then the failed refresh and the
 * refusal. Each case seeds its own credential file and runs its own token endpoint, and they run one after another —
 * there is no overlap case here, and two children on one credential file is the auth spike's own measurement.
 */
async function caseP6Group(ctx) {
	// The same counter shape the group above uses, and a set of its own: one group's totals never absorb another's.
	const counters = p5Counters();
	const results = [];
	results.push(await caseP6Rotation(ctx, counters));
	results.push(await caseP6RefreshFails(ctx, counters));
	results.push(await caseP6MalformedAuth(ctx, counters));
	// The group's own accounting, on stderr beside the case progress: a refused call is not a session, and a case that
	// never reached the model server is not one that made no request.
	process.stderr.write(`[P6] ${JSON.stringify(counters)}\n`);
	return results;
}

/* --------------------- P7: helper precedence, the catalog matrix and the helper download (step 4, task 5) */

/*
 * What this group adds, and what it is not. Task 5's composition half is measured above as launch options alone: every
 * implementation-stage call records a child `PATH` that is the caller's own with the host agent directory's `bin`
 * appended after one delimiter. What no case above measures is what a real child then does with that path, what
 * `PI_OFFLINE` and a model catalog endpoint do to a real child's startup, and what a child with no helper anywhere
 * downloads, and what two of them downloading one helper into one shared bin at the same time do. These twenty cases
 * measure that, in four halves and against real children through the same controller and the same production helpers:
 *
 *   - **Helper precedence**, with generated `rg` and `fd` fixtures in the three places the SDK's own lookup can find
 *     one: the child agent directory's own `bin`, an ordinary owned `PATH` entry, and the host's appended `bin`. The
 *     two session tools that use them — `grep` and `find` — already belong to every ordinary Pi role in this build, so
 *     a scripted model asks for one of each and the public `tool_execution_end` events say which program answered.
 *   - **The catalog matrix**: `PI_OFFLINE` unset, `1`, `0` and empty against a real child, a warm second child on the
 *     first one's own stable directory, a catalog that is always unavailable, and one that accepts and never answers.
 *   - **The helper download**: a child with no `rg` or `fd` anywhere, which resolves a release, downloads one asset,
 *     unpacks it and installs the program in its own `bin` — all of it the SDK's own code — while this fixture answers
 *     two exact urls per helper at a loopback listener through the interposer preload beside the guard. Then a second
 *     child that installs the other helper beside the first without disturbing it, a third that reuses both offline,
 *     and the three `PI_OFFLINE` values that path parses as truth rather than as presence.
 *   - **Two children at once**: two real children on one profile and one shared `children/bin`, each on its first use
 *     of the same helper, put through one deterministic interleaving of the SDK's own installer by two release
 *     listeners this harness owns — one per child, so every request is attributed by the listener it arrived at.
 *
 * What the generated programs are: `#!/bin/sh` scripts of a few lines that append what they were asked to an owned log
 * and print one line of the shape their caller parses. They are **not** ripgrep and **not** fd, they search nothing,
 * and no case here asserts anything about search semantics — what is measured is which program was invoked and with
 * what. The absolute `/bin/sh` interpreter is deliberate and is the one thing these fixtures rely on: a script's
 * interpreter is a path the kernel reads and cannot be looked up on `PATH`, so it cannot come from the owned utility
 * directory, and the platform's own shell is what every POSIX platform has. Nothing is installed from a registry, no
 * command here comes from this machine's own profile configuration, and the only archives anywhere in this group are
 * the two this harness builds itself with the owned `tar` and `gzip`.
 *
 * What this group does **not** measure, and makes no claim about: any scheduling of two downloads other than the one
 * interleaving the two concurrent cases construct, and any platform other than the one they run on.
 */

/** The three places a lookup can find a helper, as a token baked into the program that lives there. */
const P7_TOKENS = { childBin: "childbin", pathBin: "pathbin", hostBin: "hostbin" };
/** The two helpers Pi's `grep` and `find` tools run, in the order those two tools are asked for below. */
const P7_HELPERS = ["rg", "fd"];
/** Every name the SDK's own lookup tries for those two, which is what has to be absent before a case seeds one. */
const P7_ABSENT_HELPERS = ["rg", "fd", "fdfind"];
/** The utilities the owned search path carries besides node: what a later download would unpack a helper with. */
const P7_UTILITIES = ["tar", "gzip"];
/** A file, not a directory: it reaches a child through `rawExtra` for exactly that reason. */
const P7_HELPER_LOG_VARIABLE = "PI_SPIKE_HELPER_LOG";
const P7_SEARCH_SENTINEL = "SPIKE-P7-SEARCH-SENTINEL";
const P7_GREP_PATTERN = "SPIKE-P7-HELPER-PATTERN";
const P7_FIND_PATTERN = "*.txt";
/** `fetchWithRetry`'s own default of two retries, read from the installed source and required rather than assumed. */
const P7_CATALOG_ATTEMPTS = 3;
/** `REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS` in the installed source, which is what bounds one hung attempt. */
const P7_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
/** How long a child may take to reach a catalog at all before the case fails for having no arrival to measure from. */
const P7_FIRST_ARRIVAL_DEADLINE_MS = 60_000;
/** Three bounded attempts plus an allowance, measured from the first arrival rather than from the launch. */
const P7_HANGING_ANSWER_MS = 20_000;
/**
 * Which providers a catalog case expects to hear from: the ones `DUMMY_PROVIDER_KEYS` configures a dummy key for, by
 * that variable's own prefix lowercased, which is how this build spells all ten of their ids. The mapping is asserted
 * rather than assumed — a case compares the set that arrived against this one exactly, so a provider id that stopped
 * following the variable's spelling, or a provider that asked without a key, is a failure and a finding.
 */
const P7_CONFIGURED_PROVIDERS = Object.keys(DUMMY_PROVIDER_KEYS)
	.map((variable) => variable.replace(/_API_KEY$/, "").toLowerCase())
	.sort();

/* ----------------------------------------------- the download half of this group's fixtures ----------------------- */

/**
 * What the SDK's own tool manager asks for, read from the installed source and never guessed: the release page of a
 * fixed repository per helper, with `redirect: "manual"`, and then one asset on the same origin whose name it builds
 * from the tag the redirect named. The version below is this fixture's own and exists nowhere else, so an url built
 * from it can only be answered by this harness's own listener.
 */
const P7_RELEASE_ORIGIN = "https://github.com";
const P7_SPIKE_VERSION = "99.0.0-spike";
const P7_RELEASES = {
	rg: { repo: "BurntSushi/ripgrep", tagPrefix: "", asset: (arch) => `ripgrep-${P7_SPIKE_VERSION}-${arch}-unknown-linux-musl.tar.gz` },
	fd: { repo: "sharkdp/fd", tagPrefix: "v", asset: (arch) => `fd-v${P7_SPIKE_VERSION}-${arch}-unknown-linux-musl.tar.gz` },
};
/** The asset names of this platform, in the SDK's own spelling for a linux musl build. */
const P7_MUSL_ARCH = { x64: "x86_64", arm64: "aarch64" };
/** The token a downloaded program carries, which no seeded fixture uses: a trace line names which program ran by it. */
const P7_DOWNLOAD_TOKEN = "downloaded";
/**
 * The exact text Pi's own two tools reject with when a helper is neither found nor downloadable, read from the
 * installed source. A case compares the tool result against it byte for byte rather than looking for a word in it.
 */
const P7_UNAVAILABLE_MESSAGE = {
	rg: "ripgrep (rg) is not available and could not be downloaded",
	fd: "fd is not available and could not be downloaded",
};
/**
 * The two session tools that run those two helpers, with the arguments this group's scripted model asks for. The
 * expected result is a call rather than a reference because the two formatters are declared further down this file.
 */
const P7_HELPER_TOOLS = {
	rg: { tool: "grep", args: { pattern: P7_GREP_PATTERN, path: "." }, result: (token) => p7ExpectedGrepResult(token) },
	fd: { tool: "find", args: { pattern: P7_FIND_PATTERN }, result: (token) => p7ExpectedFindResult(token) },
};

/** Every url one helper's download goes through, and the redirect target the fixture answers the first one with. */
function p7ReleaseUrls(tool) {
	const release = P7_RELEASES[tool];
	const arch = P7_MUSL_ARCH[process.arch];
	const asset = release.asset(arch);
	const tag = `${release.tagPrefix}${P7_SPIKE_VERSION}`;
	const latestPath = `/${release.repo}/releases/latest`;
	// A relative location, so the redirect this fixture answers with names no origin at all: `getLatestVersion` resolves
	// it against github.com itself and takes the last path segment as the tag.
	const tagLocation = `/${release.repo}/releases/tag/${tag}`;
	const downloadPath = `/${release.repo}/releases/download/${tag}/${asset}`;
	return { tool, asset, tag, latestPath, tagLocation, downloadPath, latestUrl: `${P7_RELEASE_ORIGIN}${latestPath}`, downloadUrl: `${P7_RELEASE_ORIGIN}${downloadPath}` };
}

/** The twenty cases of this group, in the order they run, so a platform that cannot run any reports all twenty. */
const P7_CASES = {
	"P7-helper-fixture-control": "the owned search path resolves node, tar and gzip and no helper at all, the generated helper fixtures answer for themselves, and this harness's own input and reporting rules are checked where no child runs",
	"P7-helper-child-bin-wins": "a real child runs the helper in its own agent directory's bin rather than the one an ordinary PATH entry offers",
	"P7-helper-host-bin-reuse": "a real child resolves a helper through the host agent directory's appended bin when it has none of its own",
	"P7-helper-path-before-host-bin": "an ordinary PATH entry takes precedence over the host's appended bin, and the host's is never invoked",
	"P7-offline-unset-refreshes": "a real child with PI_OFFLINE absent refreshes the model catalog once per configured provider",
	"P7-catalog-warm-second-child": "a second child on the first one's stable directory finds the persisted catalog warm and asks for nothing",
	"P7-offline-one-no-refresh": "PI_OFFLINE=1 leaves a real child with no catalog request, and its model still answers",
	"P7-offline-zero-no-refresh": "PI_OFFLINE=0 leaves a real child with no catalog request either, although the helper paths read that value as false",
	"P7-offline-empty-no-refresh": "an empty PI_OFFLINE leaves a real child with no catalog request, which is presence and not truth",
	"P7-catalog-unavailable": "a catalog that answers 503 costs three attempts per provider, leaves the model usable, and persists no freshness a later child could trust",
	"P7-catalog-hanging": "a catalog that accepts and never answers is bounded by the SDK's own attempt timeout, and the already available model answers afterwards",
	"P7-helper-interposer-control": "the narrow url map reaches this fixture's own listener for the two release urls it names and for nothing else, and taking the interposer away blocks the same request",
	"P7-helper-rg-download-fallback": "a real child with no rg anywhere downloads one from this fixture's own release endpoint, installs it in its own bin and answers a grep call with it",
	"P7-helper-fd-download-fallback": "the same child directory then downloads fd on its own, leaving the rg it already has untouched",
	"P7-helper-download-reuse": "a third child on that stable bin runs both downloaded helpers with no request of any kind, offline",
	"P7-helper-offline-one-refuses": "PI_OFFLINE=1 leaves a real child with no helper, no download and a grep call that comes back as an error rather than a refused startup",
	"P7-helper-offline-zero-downloads": "PI_OFFLINE=0 is false to the helper path, so a real child downloads rg and the grep call works",
	"P7-helper-offline-empty-downloads": "an empty PI_OFFLINE is false to the helper path too, so a real child downloads rg and the grep call works",
	"P7-helper-concurrent-rg": "two real children with no rg anywhere reach one shared bin at the same time, with one download's body held open across the other's whole install, and both model-issued grep calls succeed: the fast child with no retry notice and the held child with exactly one",
	"P7-helper-concurrent-fd": "the same interleaving for fd, on a profile, a shared bin and a pair of listeners of its own",
};

/** One owned utility directory, and what a lookup on this machine resolved each entry from. */
function p7Utilities(root) {
	const dir = path.join(root, "p7-utilities");
	const resolved = { node: fs.realpathSync(process.execPath) };
	for (const name of P7_UTILITIES) {
		// An ordinary search-path lookup, done once: no shell, no `which`, and nothing read from this machine's own
		// profile configuration. A missing utility is what makes this whole group NOT RUN rather than a passing case.
		const found = p7Lookup(name);
		if (found === undefined) return { missing: name };
		resolved[name] = found;
	}
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, target] of Object.entries(resolved)) fs.symlinkSync(target, path.join(dir, name));
	return { dir, resolved };
}

/** An ordinary search-path lookup by hand: the first entry holding an executable file of that name, and nothing else. */
function p7Lookup(name, search = process.env.PATH ?? "") {
	for (const entry of search.split(path.delimiter)) {
		if (!entry) continue;
		const candidate = path.join(entry, name);
		try {
			if (!fs.statSync(candidate).isFile()) continue;
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Not there, not a file, or not executable by this user: keep looking, the way a lookup does.
		}
	}
	return undefined;
}

/**
 * One generated helper fixture. It answers `--version` so the SDK's own `commandExists` probe succeeds, appends one
 * tab-separated line per invocation to the owned log — the kind it is, the tool it stands for, its own absolute path,
 * the `$0` it was started as, the search path it saw and the arguments it was given — and prints the one line its
 * caller parses: a ripgrep `--json` match event, or one relative path the way fd prints them. It is a fixture: it
 * opens no file, searches nothing and tells the truth about nothing except which program ran.
 *
 * `mode` is 0o755 for a program a case seeds where a lookup will find it, and 0o600 for one staged into a release
 * archive the download cases serve: the mode a downloaded program ends up with is the SDK's own `chmod`, and it can
 * only be read as that if what was archived was not executable to begin with.
 */
function p7WriteHelper({ dir, tool, token, mode = 0o755 }) {
	const file = path.join(dir, tool);
	const output =
		tool === "rg"
			? `printf '{"type":"match","data":{"path":{"text":"%s-match.txt"},"line_number":1,"lines":{"text":"%s"}}}\\n' "$kind" "$kind"\n`
			: `printf '%s-find.txt\\n' "$kind"\n`;
	write(
		file,
		[
			// The interpreter is an absolute path because the kernel reads it and cannot look one up on PATH; it is the
			// platform's own shell, and nothing else about this program depends on anything outside the temp root.
			"#!/bin/sh",
			`# A pi-fusion spike fixture generated by test/spikes/pi-config-writes.mjs: it is not ${tool} and it searches nothing.`,
			`kind=${token}`,
			`tool=${tool}`,
			`self=${file}`,
			`log="$${P7_HELPER_LOG_VARIABLE}"`,
			'if [ -z "$log" ]; then',
			`\tprintf 'pi-fusion spike helper: ${P7_HELPER_LOG_VARIABLE} is not set\\n' >&2`,
			"\texit 91",
			"fi",
			"event=invoke",
			'if [ "$1" = "--version" ]; then event=version; fi',
			'printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$event" "$kind" "$tool" "$self" "$0" "$PATH" "$*" >> "$log"',
			'if [ "$event" = version ]; then',
			`\tprintf '${tool} 0.0.0-pi-fusion-spike-fixture (%s)\\n' "$kind"`,
			"\texit 0",
			"fi",
			output.trimEnd(),
			"exit 0",
			"",
		].join("\n"),
	);
	fs.chmodSync(file, mode);
	return file;
}

/** What one helper fixture prints when it is invoked as a tool, and what the session tool then reports back. */
const p7ExpectedGrepResult = (token) => `${token}-match.txt:1: ${token}`;
const p7ExpectedFindResult = (token) => `${token}-find.txt`;

/** A file's bytes and mode, for the before-and-after comparison every seeded helper goes through. */
const p7Fingerprint = (file) => {
	try {
		return { present: true, sha: hashFile(file), mode: (fs.statSync(file).mode & 0o777).toString(8) };
	} catch (error) {
		return { present: false, code: error?.code ?? String(error) };
	}
};
const p7Fingerprints = (files) => Object.fromEntries(files.map((file) => [file, p7Fingerprint(file)]));

/**
 * What the helper fixtures recorded. An unreadable log is its own record, the way the installer log above is: a claim
 * that one program answered and another did not cannot rest on a file that is not there.
 */
function p7HelperTrace(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { present: false, code: error?.code ?? String(error), entries: [] };
	}
	const entries = text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [event, kind, tool, self, argv0, search, args] = line.split("\t");
			return { event, kind, tool, self, argv0, search, args: args ?? "" };
		});
	return { present: true, entries };
}

/** The `<event>:<tool>:<kind>` sequence a case compares as a whole, rather than counting lines by kind. */
const p7TraceShape = (entries) => entries.map((entry) => `${entry.event}:${entry.tool}:${entry.kind}`);

/**
 * A loopback catalog endpoint that cannot serve: it answers 503 to everything, or accepts and never answers at all.
 * Separate from `startCatalogServer` so that fixture stays exactly what the cases above measure against, and its held
 * responses are this fixture's own — closing it destroys only the sockets it accepted itself.
 */
async function startFailingCatalogServer({ label, mode }) {
	const requests = [];
	const held = new Set();
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const match = /^\/api\/models\/providers\/(.+)$/.exec(url.pathname);
		requests.push({ label, method: req.method, path: url.pathname, provider: match ? decodeURIComponent(match[1]) : undefined, at: Date.now() });
		if (mode === "hang") {
			// Accepted and never answered: what ends the attempt is the SDK's own per-attempt timeout, and this fixture
			// adds no timer, no sleep and no response of its own.
			held.add(res);
			res.on("close", () => held.delete(res));
			return;
		}
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "unavailable" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		label,
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				for (const response of held) {
					try {
						response.destroy();
					} catch {
						// Already gone: a client that timed out took its own socket with it.
					}
				}
				held.clear();
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** How many times each provider's catalog path was asked for, which is what an attempt count is read from. */
function p7AttemptsByProvider(records) {
	const counts = {};
	for (const record of records) {
		if (record.provider === undefined) continue;
		counts[record.provider] = (counts[record.provider] ?? 0) + 1;
	}
	return counts;
}

/**
 * One P7 call: `p5Run` with this group's own environment. The child's whole search path is constructed here — the
 * owned utility directory first, then whatever helper directory the case puts on it — and the helper log goes through
 * `rawExtra` because `childEnv` creates a directory for every value holding a separator and a log file is none of
 * those. The counters are this group's own, so no total of P5's or P6's absorbs a P7 child.
 */
async function p7Run(ctx, spec) {
	const rootReal = fs.realpathSync(ctx.root);
	const owned = (label, value) => {
		if (!path.resolve(value).startsWith(`${rootReal}${path.sep}`)) throw new Error(`the ${label} ${value} is outside the temp root ${rootReal}`);
		return value;
	};
	const search = [ctx.p7.utilityDir, ...(spec.pathDirs ?? [])].map((dir) => owned("constructed PATH entry", dir));
	const log = spec.helperLog === undefined ? undefined : owned("helper log", spec.helperLog);
	// The download half's second preload, with its own log inside the temp root as well: it reaches `implEnv`, which is
	// where the file, the loopback origin and every mapped url are validated before a child could be launched.
	if (spec.interposer !== undefined) owned("interposer log", spec.interposer.log);
	return p5Run(ctx, {
		...spec,
		counters: ctx.p7.counters,
		extraEnv: { ...(spec.extraEnv ?? {}), PATH: search.join(path.delimiter) },
		...(log === undefined ? {} : { rawExtra: { ...(spec.rawExtra ?? {}), [P7_HELPER_LOG_VARIABLE]: log } }),
	});
}

/** The environment facts every P7 case reads back from the launch the production helpers composed. */
function p7CheckEnvironment(result, run, { offline, search }) {
	result.observations.offlineVariable = { caller: run.observations.env?.PI_OFFLINE ?? null, child: run.observations.launch?.childOffline ?? null };
	result.check(run.observations.env?.PI_OFFLINE === offline, `the caller inherited PI_OFFLINE ${JSON.stringify(run.observations.env?.PI_OFFLINE)} rather than ${JSON.stringify(offline)}`);
	result.check(run.observations.launch?.childOffline === offline, `the child was launched with PI_OFFLINE ${JSON.stringify(run.observations.launch?.childOffline)} rather than ${JSON.stringify(offline)}`);
	// The constructed path, read back from the launch: the entries this case named, then the host's bin appended by the
	// production classifier. `checkManagedCall` asserts the append itself; this is the entries being the owned ones.
	result.observations.childPath = run.observations.launch?.childPath ?? null;
	result.check(run.observations.launch?.callerPathBefore === search, `the caller's own PATH was ${JSON.stringify(run.observations.launch?.callerPathBefore)} rather than the constructed ${JSON.stringify(search)}`);
}

/** The one settled task every precedence case runs: one grep call, one find call, one final answer, and no other step. */
function p7SearchScript(ctx, sentinel) {
	ctx.server.script(sentinel, [
		{ kind: "tool_call", name: "grep", toolName: "grep", arguments: { pattern: P7_GREP_PATTERN, path: "." }, toolCallId: "call_p7_grep" },
		{ kind: "tool_call", name: "find", toolName: "find", arguments: { pattern: P7_FIND_PATTERN }, toolCallId: "call_p7_find" },
		{ kind: "text", name: "final", text: ANSWER },
	]);
}

/**
 * The three precedence cases, which differ only in where a helper is seeded. Each one seeds its fixtures, runs one
 * real child through one scripted task, and is read against the public `tool_execution_end` events and the helper log:
 * the final assistant text is not evidence about which program ran, and neither is an acknowledged prompt.
 */
async function caseP7Precedence(ctx, plan) {
	const dirs = ctx.setupCase(plan.name);
	const result = implResult(plan.name, P7_CASES[plan.name], plan.notes);
	const managedRoot = path.join(dirs.profile, FUSION_MANAGED_DIR);
	const where = {
		childBin: path.join(managedRoot, "children", "bin"),
		hostBin: path.join(dirs.profile, "bin"),
		pathBin: path.join(dirs.caseRoot, "path-bin"),
	};
	// Before anything is seeded: none of the three directories a lookup could find a helper in is there at all, and the
	// constructed search path resolves no helper under any of the names the SDK's own lookup tries.
	result.observations.binsBeforeSeeding = Object.fromEntries(Object.entries(where).map(([name, dir]) => [name, fs.existsSync(dir)]));
	result.check(
		Object.values(result.observations.binsBeforeSeeding).every((present) => present === false),
		`a helper directory existed before this case seeded one: ${JSON.stringify(result.observations.binsBeforeSeeding)}`,
	);
	const helperLog = path.join(dirs.caseRoot, "helpers.log");
	// Created empty on purpose: "nothing was invoked" has to be a readable log with no lines in it rather than a file
	// that is not there, the same rule the installer log above follows.
	write(helperLog, "");
	const seeded = [];
	for (const [place, tools] of Object.entries(plan.seed)) {
		for (const tool of tools) seeded.push(p7WriteHelper({ dir: where[place], tool, token: P7_TOKENS[place] }));
	}
	const before = p7Fingerprints(seeded);
	result.observations.seededHelpers = Object.fromEntries(Object.entries(before).map(([file, value]) => [path.relative(dirs.caseRoot, file), value]));
	const sentinel = `${P7_SEARCH_SENTINEL}-${plan.name}`;
	p7SearchScript(ctx, sentinel);
	const winner = P7_TOKENS[plan.winner];
	const search = [ctx.p7.utilityDir, ...(plan.pathDirs ?? []).map((place) => where[place])].join(path.delimiter);
	const run = await p7Run(ctx, {
		dirs,
		caller: plan.name,
		result,
		handle: plan.name,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		helperLog,
		pathDirs: (plan.pathDirs ?? []).map((place) => where[place]),
		driveLabel: "probes and one scripted search task",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const prompt = await child.send({ type: "prompt", message: `${sentinel} search this project and list its files.` });
			outcome.check(prompt.success === true, `the task prompt was rejected: ${prompt.error ?? ""}`);
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			outcome.observations.answer = text.data?.text ?? null;
			outcome.check(text.data?.text?.includes(ANSWER) === true, "the scripted final answer did not come back");
			// The tool results themselves, which is what says a helper ran and what it answered. A final text and an
			// acknowledged prompt say nothing about either.
			const ends = child.events.filter((event) => event.type === "tool_execution_end");
			outcome.observations.toolResults = ends.map((event) => ({
				toolName: event.toolName,
				isError: event.isError,
				text: event.result?.content?.[0]?.text ?? null,
				details: event.result?.details ?? null,
			}));
			const expected = [
				{ toolName: "grep", text: p7ExpectedGrepResult(winner) },
				{ toolName: "find", text: p7ExpectedFindResult(winner) },
			];
			outcome.check(ends.length === expected.length, `the child ended ${ends.length} tool execution(s) instead of the ${expected.length} the script asks for`);
			for (const [index, one] of expected.entries()) {
				const actual = outcome.observations.toolResults[index];
				outcome.check(actual?.toolName === one.toolName, `tool execution ${index} was ${JSON.stringify(actual?.toolName)} instead of ${one.toolName}`);
				outcome.check(actual?.isError === false, `the ${one.toolName} call came back as an error: ${JSON.stringify(actual?.text)}`);
				outcome.check(actual?.text === one.text, `the ${one.toolName} call answered ${JSON.stringify(actual?.text)} rather than exactly ${JSON.stringify(one.text)}`);
			}
			return true;
		},
	});
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.observations.scriptSteps = run.requests.map((request) => request.scriptStep ?? null);
	result.check(run.requests.length === 3, `the task made ${run.requests.length} model request(s) instead of the three this script answers`);
	// The trace: which program the child actually started, under which `$0`, and with which search path. A version
	// probe is the SDK's own `commandExists`, so its presence or absence is part of the expected sequence rather than
	// something to be tolerated: a child bin hit never probes, and a path lookup always does.
	const trace = p7HelperTrace(helperLog);
	result.observations.helperTrace = trace.present ? trace.entries.map((entry) => ({ event: entry.event, tool: entry.tool, kind: entry.kind, argv0: entry.argv0, self: entry.self })) : trace;
	result.check(trace.present, `the helper log ${helperLog} could not be read, so this case holds no evidence about which program ran`);
	result.check(
		p7TraceShape(trace.entries).join(" ") === plan.expectTrace.join(" "),
		`the helper fixtures recorded ${JSON.stringify(p7TraceShape(trace.entries))} rather than exactly ${JSON.stringify(plan.expectTrace)}`,
	);
	// Which program each line came from, by the absolute path the generator baked into the program itself, so a line is
	// attributed by what it is rather than by what it was called.
	const winnerDir = where[plan.winner];
	result.check(
		trace.entries.every((entry) => entry.self === path.join(winnerDir, entry.tool)),
		`a helper line named a program outside ${winnerDir}: ${JSON.stringify(trace.entries.map((entry) => entry.self))}`,
	);
	// The `$0` every line carries, which names the program on disk in all three cases: a child-bin hit is spawned by the
	// absolute path the lookup answered with, and a name resolved on `PATH` is spawned as that bare name — but the
	// program a shebang line starts is given the path the kernel resolved, so `$0` is the absolute path either way. It is
	// asserted rather than only recorded, and what tells the two lookups apart is the version probe in the trace above.
	result.observations.invokedAs = trace.entries.filter((entry) => entry.event === "invoke").map((entry) => ({ tool: entry.tool, argv0: entry.argv0 }));
	result.check(
		trace.entries.every((entry) => entry.argv0 === path.join(winnerDir, entry.tool)),
		`the child started a helper as ${JSON.stringify(trace.entries.map((entry) => entry.argv0))} rather than as this case's own programs under ${winnerDir}`,
	);
	result.check(
		trace.entries.every((entry) => entry.search === run.observations.launch?.childPath),
		"a helper saw a search path that is not the one the launch composed for this child",
	);
	// Nothing the case did not seed, and nothing seeded rewritten: the loser fixtures are byte-identical too, which is
	// what says a precedence claim is about which program ran rather than about which one existed.
	const after = p7Fingerprints(seeded);
	result.observations.seededUnchanged = JSON.stringify(after) === JSON.stringify(before);
	result.check(result.observations.seededUnchanged, `a seeded helper changed across the call: ${JSON.stringify(after)}`);
	result.observations.binsAfter = Object.fromEntries(Object.entries(where).map(([name, dir]) => [name, fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null]));
	for (const [place, dir] of Object.entries(where)) {
		const expected = plan.seed[place] === undefined ? null : [...plan.seed[place]].sort();
		result.check(
			JSON.stringify(result.observations.binsAfter[place]) === JSON.stringify(expected),
			`${place} (${dir}) held ${JSON.stringify(result.observations.binsAfter[place])} rather than ${JSON.stringify(expected)} after the call`,
		);
	}
	// The two places this case computed, against the two the production helpers actually resolved for this call: the
	// host helper bin the launch appended, and the bin inside the child agent directory the storage prepared. Without
	// this the ordinary-PATH case could pass on a layout that moved: a trace with no host-bin line reads the same
	// whether the host's bin lost the race or was never a place this child would have looked at all.
	result.observations.productionLocations = {
		hostBinDir: run.observations.launch?.hostBinDir ?? null,
		childAgentDir: run.observations.storage?.agentDir ?? null,
		childBinComputed: where.childBin,
		hostBinComputed: where.hostBin,
	};
	result.check(
		run.observations.launch?.hostBinDir === where.hostBin,
		`this case seeded ${where.hostBin} as the host helper bin and the production launch resolved ${JSON.stringify(run.observations.launch?.hostBinDir)}`,
	);
	result.check(
		typeof run.observations.storage?.agentDir === "string" && path.join(run.observations.storage.agentDir, "bin") === where.childBin,
		`this case seeded ${where.childBin} as the child's own helper bin and the production storage prepared the child agent directory ${JSON.stringify(run.observations.storage?.agentDir)}`,
	);
	p7CheckEnvironment(result, run, { offline: "1", search });
	checkManagedCall(result, run.observations, {
		dirs,
		diffs: run.diffs,
		expectSharedAuth: true,
		// The exact managed-relative paths this case seeded itself, where it seeded any: they are inputs it owns and
		// they are compared byte for byte above as well.
		seededManaged: (plan.seed.childBin ?? []).map((tool) => `children/bin/${tool}`),
	});
	checkFetchLog(result, run.fetchLog, plan.name, { expectAllowed: "some" });
	result.observations.requestOrigins = [...new Set(fetchRecords(run.fetchLog, plan.name).filter((record) => record.event === "allowed").map((record) => record.origin))];
	result.check(
		result.observations.requestOrigins.join(",") === originOf(ctx.server.baseUrl),
		`this case reached ${JSON.stringify(result.observations.requestOrigins)} rather than the loopback model server alone`,
	);
	return result;
}

/** The three precedence plans: where each one seeds a helper, which one has to win, and what that leaves in the log. */
function p7PrecedencePlans() {
	// A child bin hit is returned without a `commandExists` probe, so its trace is two invocations; a lookup that
	// resolves through `PATH` probes `--version` first, so its trace is a probe and an invocation for each tool. Both
	// are read from the installed source and required here rather than tolerated.
	const probed = ["version:rg:", "invoke:rg:", "version:fd:", "invoke:fd:"];
	const direct = ["invoke:rg:", "invoke:fd:"];
	const shape = (entries, token) => entries.map((entry) => `${entry}${token}`);
	return [
		{
			name: "P7-helper-child-bin-wins",
			seed: { childBin: P7_HELPERS, pathBin: P7_HELPERS },
			pathDirs: ["pathBin"],
			winner: "childBin",
			expectTrace: shape(direct, P7_TOKENS.childBin),
			notes: [
				"both places hold a helper of each kind and the two sets are different programs, so the winner is read off the output and the trace rather than inferred from one existing",
				"PI_OFFLINE=1, so no download is possible in this case at all: what is measured is a lookup, not a fallback",
			],
		},
		{
			name: "P7-helper-host-bin-reuse",
			seed: { hostBin: P7_HELPERS },
			pathDirs: [],
			winner: "hostBin",
			expectTrace: shape(probed, P7_TOKENS.hostBin),
			notes: [
				"the child agent directory has no bin at all and the constructed search path is helper-free, so the only helper anywhere is the host's — which the child reaches through the appended entry the production launch put there",
				"this is the measurement task 5 names as its acceptance: a real child resolving a host helper through its own PATH",
			],
		},
		{
			name: "P7-helper-path-before-host-bin",
			seed: { pathBin: P7_HELPERS, hostBin: P7_HELPERS },
			pathDirs: ["pathBin"],
			winner: "pathBin",
			expectTrace: shape(probed, P7_TOKENS.pathBin),
			notes: [
				"the host's bin is appended after the ordinary entries, so an ordinary PATH helper wins and the host's is never invoked; the host's fixtures are byte-identical afterwards and their kind appears nowhere in the trace",
			],
		},
	];
}

/**
 * Case A0, the fixture control: no child, no SDK and no backend in it. It reads what the constructed search path
 * resolves before anything is seeded, and it invokes the generated helper fixtures itself, which is what makes every
 * claim the three cases below make about them evidence rather than an assumption. It makes no claim about requests —
 * there is no fetch guard in this case because there is no process here that could make one.
 */
async function caseP7FixtureControl(ctx) {
	const dirs = ctx.setupCase("P7-helper-fixture-control");
	const result = implResult("P7-helper-fixture-control", P7_CASES["P7-helper-fixture-control"], [
		"no child, no SDK and no model in this case: it is the control the precedence cases below rest on",
		"the utilities are this machine's own tar and gzip, resolved once by an ordinary search-path lookup and reached through symlinks in an owned directory; node is this process's own executable, no command comes from a profile configuration, and nothing is downloaded or installed",
		"two rules of the harness itself are checked here because this is where nothing runs: that a raw pass-through value cannot name a variable the composition decides, and that a case which did not run is never reported as one that passed",
	]);
	const search = ctx.p7.utilityDir;
	const intended = ["gzip", "node", "tar"];
	result.observations.utilityDir = { dir: search, entries: fs.readdirSync(search).sort() };
	result.check(
		result.observations.utilityDir.entries.join(",") === intended.join(","),
		`the owned utility directory holds ${JSON.stringify(result.observations.utilityDir.entries)} rather than exactly ${JSON.stringify(intended)}`,
	);
	const candidates = {};
	for (const name of intended) {
		const found = p7Lookup(name, search);
		candidates[name] = { resolvedTo: found, symlinkTo: found === undefined ? null : fs.readlinkSync(found), intended: ctx.p7.resolved[name] };
		result.check(found === path.join(search, name), `${name} resolved to ${JSON.stringify(found)} on the constructed search path rather than to that path's own entry`);
		result.check(candidates[name].symlinkTo === ctx.p7.resolved[name], `the owned ${name} points at ${JSON.stringify(candidates[name].symlinkTo)} rather than the utility the lookup resolved, ${JSON.stringify(ctx.p7.resolved[name])}`);
		result.check(fs.existsSync(ctx.p7.resolved[name]), `the utility ${name} resolved to ${JSON.stringify(ctx.p7.resolved[name])}, which is not there`);
	}
	result.observations.candidates = candidates;
	result.check(candidates.node.symlinkTo === fs.realpathSync(process.execPath), "the owned node is not this process's own executable, which is where a child's node has to come from");
	const helperLog = path.join(dirs.caseRoot, "helpers.log");
	// Created empty, so a claim that a program was not invoked reads as a log with no line in it.
	write(helperLog, "");
	const env = childEnv(ctx.root, { agentDir: path.join(dirs.caseRoot, "agent"), sessionDir: path.join(dirs.caseRoot, "sessions"), extra: { PATH: search } });
	// A file rather than a directory, which is why it is assigned here: `childEnv` creates a directory for every value
	// that holds a separator, and the child launches below pass it through `rawExtra` for the same reason.
	env[P7_HELPER_LOG_VARIABLE] = helperLog;
	// Before anything is seeded: no helper under any of the names the SDK's own lookup tries, by a lookup and by an
	// actual invocation on this very path. An unintended helper anywhere on it would make every case below meaningless.
	const absent = {};
	for (const name of P7_ABSENT_HELPERS) {
		const probe = spawnSync(name, ["--version"], { cwd: dirs.project, env, stdio: "pipe" });
		absent[name] = { lookup: p7Lookup(name, search) ?? null, code: probe.error?.code ?? null, status: probe.status ?? null };
		result.check(absent[name].lookup === null, `${name} is already on the constructed search path, at ${JSON.stringify(absent[name].lookup)}`);
		result.check(absent[name].code === "ENOENT", `invoking ${name} on the constructed search path answered ${JSON.stringify(absent[name])} rather than failing with ENOENT`);
	}
	result.observations.absentBeforeSeeding = absent;
	// The generated programs, one of each tool for each of the three places, invoked directly by their own absolute
	// paths in an owned working directory and an owned environment.
	const programs = [];
	const invocations = [];
	for (const [place, token] of Object.entries(P7_TOKENS)) {
		for (const tool of P7_HELPERS) {
			const file = p7WriteHelper({ dir: path.join(dirs.caseRoot, "fixtures", place), tool, token });
			const mode = (fs.statSync(file).mode & 0o777).toString(8);
			programs.push({ place, token, tool, file, mode });
			result.check(mode === "755", `${place}/${tool} was written at mode ${mode}`);
			const version = spawnSync(file, ["--version"], { cwd: dirs.project, env, stdio: "pipe" });
			// The arguments Pi's own two tools pass, so what is exercised here is the shape those callers produce.
			const args =
				tool === "rg"
					? ["--json", "--line-number", "--color=never", "--hidden", "--", P7_GREP_PATTERN, dirs.project]
					: ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", "1000", "--", P7_FIND_PATTERN, dirs.project];
			const invoked = spawnSync(file, args, { cwd: dirs.project, env, stdio: "pipe" });
			const observed = {
				place,
				tool,
				token,
				versionStatus: version.status ?? null,
				versionLine: String(version.stdout ?? "").trim(),
				status: invoked.status ?? null,
				stdout: String(invoked.stdout ?? "").trim(),
				stderr: String(invoked.stderr ?? "").trim(),
			};
			invocations.push(observed);
			result.check(observed.versionStatus === 0, `${place}/${tool} answered --version with status ${JSON.stringify(observed.versionStatus)}`);
			result.check(
				observed.versionLine.includes(tool) && observed.versionLine.includes(token),
				`${place}/${tool} answered --version with ${JSON.stringify(observed.versionLine)}, which does not name the tool it stands for and the place it is in`,
			);
			result.check(observed.status === 0, `${place}/${tool} exited ${JSON.stringify(observed.status)}: ${observed.stderr}`);
			result.check(observed.stderr === "", `${place}/${tool} wrote ${JSON.stringify(observed.stderr)} to stderr`);
			if (tool === "rg") {
				let parsed;
				try {
					parsed = JSON.parse(observed.stdout);
				} catch {
					parsed = undefined;
				}
				result.check(
					parsed?.type === "match" && parsed?.data?.path?.text === `${token}-match.txt` && parsed?.data?.line_number === 1 && parsed?.data?.lines?.text === token,
					`${place}/rg printed ${JSON.stringify(observed.stdout)}, which is not the one match event its caller parses`,
				);
			} else {
				result.check(observed.stdout === p7ExpectedFindResult(token), `${place}/fd printed ${JSON.stringify(observed.stdout)} rather than ${JSON.stringify(p7ExpectedFindResult(token))}`);
			}
		}
	}
	result.observations.programs = programs.map(({ place, tool, token, mode }) => ({ place, tool, token, mode }));
	result.observations.invocations = invocations;
	const trace = p7HelperTrace(helperLog);
	result.observations.trace = trace.present ? p7TraceShape(trace.entries) : trace;
	result.check(trace.present, `the helper log ${helperLog} could not be read, so nothing here says what these programs recorded`);
	const expected = programs.flatMap(({ tool, token }) => [`version:${tool}:${token}`, `invoke:${tool}:${token}`]);
	result.check(
		p7TraceShape(trace.entries).join(" ") === expected.join(" "),
		`the fixtures recorded ${JSON.stringify(p7TraceShape(trace.entries))} rather than exactly ${JSON.stringify(expected)}`,
	);
	result.check(
		trace.entries.every((entry) => entry.search === search),
		"a fixture saw a search path other than the constructed one, so the path it recorded is not the path it was invoked on",
	);
	result.check(
		trace.entries.every((entry) => entry.argv0 === entry.self),
		`a fixture's own $0 is not the program this case invoked: ${JSON.stringify(trace.entries.map((entry) => [entry.argv0, entry.self]))}`,
	);
	// The one failure that would make every trace below unreadable: a fixture that silently skips its own log. With the
	// variable taken away it refuses instead, and writes nothing, which is what makes an empty log evidence.
	const withoutLog = { ...env };
	delete withoutLog[P7_HELPER_LOG_VARIABLE];
	const refused = spawnSync(programs[0].file, ["--version"], { cwd: dirs.project, env: withoutLog, stdio: "pipe" });
	result.observations.withoutLogVariable = { status: refused.status ?? null, stdout: String(refused.stdout ?? "").trim(), stderr: String(refused.stderr ?? "").trim() };
	result.check(
		result.observations.withoutLogVariable.status === 91 && result.observations.withoutLogVariable.stdout === "",
		`a fixture with no ${P7_HELPER_LOG_VARIABLE} answered ${JSON.stringify(result.observations.withoutLogVariable)} rather than refusing and printing nothing`,
	);
	result.check(p7HelperTrace(helperLog).entries.length === trace.entries.length, "the refusing invocation wrote to the log after all");
	p7CheckReserved(result, ctx, dirs, helperLog);
	p7CheckReporting(result);
	return result;
}

/**
 * The composed negative controls, in the case that starts no child: a raw pass-through value naming a variable this
 * composition decides itself has to refuse the launch **before** one is composed, under the name's own spelling and
 * under one this platform would read as the same variable. The positive beside them is the one value this group really
 * does pass that way — the helper log — which has to be accepted and to arrive as itself. Nothing here launches
 * anything, and none of it says what a child could reach: it is a check on this fixture's own input.
 */
function p7CheckReserved(result, ctx, dirs, helperLog) {
	const compose = (rawExtra) =>
		implEnv(ctx.root, {
			agentDir: path.join(dirs.caseRoot, "reserved-agent"),
			sessionDir: path.join(dirs.caseRoot, "reserved-sessions"),
			caller: "P7-reserved",
			origins: [originOf(ctx.server.baseUrl)],
			fetchLog: path.join(dirs.caseRoot, "reserved-fetch.log"),
			extra: { PATH: ctx.p7.utilityDir },
			rawExtra,
		});
	const refusals = {};
	// Every reserved name under its own spelling, plus one lower-cased and one mixed-case spelling of the two that would
	// do the most damage, because the comparison is case-insensitive on purpose.
	for (const name of [...IMPL_RESERVED_VARIABLES, "path", "Node_Options", "pi_spike_allowed_origins"]) {
		let refused;
		try {
			compose({ [name]: "spike-should-never-be-composed" });
			refused = null;
		} catch (error) {
			refused = String(error?.message ?? error);
		}
		refusals[name] = refused === null ? "composed" : refused.includes("may not name") ? "refused" : `refused for another reason: ${refused}`;
		result.check(refusals[name] === "refused", `a raw pass-through value named ${name} and the composition answered ${JSON.stringify(refusals[name])}`);
	}
	result.observations.reservedRawExtra = refusals;
	// And the accepted one: the helper log is a path with separators in it, so it must reach the environment as itself
	// rather than be taken for a directory, and it must not have been created as one.
	let accepted;
	try {
		const composed = compose({ [P7_HELPER_LOG_VARIABLE]: helperLog });
		accepted = { value: composed[P7_HELPER_LOG_VARIABLE] ?? null, isDirectory: fs.statSync(helperLog).isDirectory() };
	} catch (error) {
		accepted = { error: String(error?.message ?? error) };
	}
	result.observations.acceptedRawExtra = accepted;
	result.check(accepted.value === helperLog && accepted.isDirectory === false, `the helper log did not pass through as itself: ${JSON.stringify(accepted)}`);
}

/**
 * The reporting logic, checked on synthetic results in the one case that measures nothing about a child. It exists
 * because the platform guard above cannot be exercised here: this machine is the platform these fixtures qualify, so
 * nothing here ever takes the NOT RUN path, and a reporting rule that is only reached on a platform this run is not
 * would be a rule nothing checks. These four results are made up, are in no group's list and are counted nowhere —
 * what is asserted is how each one would be classified and what its line would say.
 */
function p7CheckReporting(result) {
	const synthetic = (name, { failures = [], skipped } = {}) => {
		const one = implResult(name, "a synthetic result, in no group and counted nowhere");
		one.failures.push(...failures);
		if (skipped !== undefined) one.observations.skipped = skipped;
		return one;
	};
	const held = synthetic("synthetic-held");
	const notRun = synthetic("synthetic-not-run", { skipped: "a reason a case gives for not running" });
	const bothway = synthetic("synthetic-failed-and-skipped", { failures: ["a broken guarantee"], skipped: "a reason beside it" });
	const counting = synthetic("synthetic-counts-case", { skipped: ["another-case", "and-another"] });
	const classified = Object.fromEntries([held, notRun, bothway, counting].map((one) => [one.name, classifyResult(one)]));
	const lines = Object.fromEntries([held, notRun, bothway, counting].map((one) => [one.name, resultVerdictLine(one)]));
	result.observations.reportingClassification = classified;
	result.observations.reportingLines = lines;
	result.check(classified["synthetic-held"] === "held", `a clean result classified as ${classified["synthetic-held"]}`);
	result.check(classified["synthetic-not-run"] === "skipped", `a result with a reason classified as ${classified["synthetic-not-run"]}`);
	result.check(classified["synthetic-failed-and-skipped"] === "failed", `a result with a failure and a reason classified as ${classified["synthetic-failed-and-skipped"]}, and a failure takes priority over a skip`);
	// The accounting case of the group above records a `skipped` **array** of other cases' names, which is an observation
	// about them rather than a refusal of its own: it still holds, and this is what says so.
	result.check(classified["synthetic-counts-case"] === "held", `a result recording a list of other cases' skips classified as ${classified["synthetic-counts-case"]}`);
	result.check(lines["synthetic-held"] === "  RESULT: guarantees held", `a clean result's line is ${JSON.stringify(lines["synthetic-held"])}`);
	result.check(
		lines["synthetic-not-run"].includes("NOT RUN") && !lines["synthetic-not-run"].includes("guarantees held"),
		`a skipped result's line is ${JSON.stringify(lines["synthetic-not-run"])}, and a case that did not run is never given the wording of one that kept its guarantees`,
	);
	result.check(lines["synthetic-failed-and-skipped"] === "  RESULT: 1 failure(s)", `a failed result's line is ${JSON.stringify(lines["synthetic-failed-and-skipped"])}`);
	// And the headline: a skip is counted as neither a pass nor a failure, and a run with none of them says exactly what
	// it has always said.
	result.observations.reportingSummaries = {
		withSkip: summaryLine([held, notRun, bothway, counting]),
		withoutSkip: summaryLine([held, counting]),
	};
	result.check(
		result.observations.reportingSummaries.withSkip === "2/4 cases kept their guarantees, 1 NOT RUN and counted as neither: synthetic-not-run",
		`the headline for a run with one skip is ${JSON.stringify(result.observations.reportingSummaries.withSkip)}`,
	);
	result.check(
		result.observations.reportingSummaries.withoutSkip === "2/2 cases kept their guarantees",
		`the headline for a run with no skip is ${JSON.stringify(result.observations.reportingSummaries.withoutSkip)}, and a run with nothing skipped says what it always said`,
	);
}

/** The provider id the harness's own control call names, which no case's child ever asks for. */
const P7_CONTROL_PROVIDER = "spike-control-provider";

/** The persisted catalog store the managed root holds, read once every process of a case has exited. */
const p7Store = (dirs) => readJsonIfPresent(path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "catalog", "models-store.json"));

/** What each provider's persisted entry holds, which is what a later child would or would not treat as a cache. */
const p7StoreShape = (store) =>
	store === undefined
		? null
		: Object.fromEntries(
				Object.entries(store).map(([id, entry]) => [
					id,
					{
						models: (entry?.models ?? []).length,
						canary: (entry?.models ?? []).some((model) => model.id === CANARY_MODEL),
						checkedAt: typeof entry?.checkedAt === "number",
						lastModified: entry?.lastModified === undefined ? "absent" : typeof entry.lastModified,
						etag: entry?.etag === undefined ? "absent" : typeof entry.etag,
					},
				]),
			);

/**
 * One catalog-matrix call: a real child against the loopback catalog this case owns, with the exact `PI_OFFLINE` value
 * the case measures, the three non-task probes and one ordinary prompt. The model is the loopback fixture provider from
 * the user's own seeded `models.json` — a configured provider, which has no remote catalog of its own — so every
 * catalog request in this half comes from one of the builtin providers `DUMMY_PROVIDER_KEYS` configures, which is the
 * **ten** that constant names rather than the four `BUILTIN_KEY_VARIABLE` picks an exact model from. Ten arrivals is
 * this fixture's own configuration read back, and the set is asserted per case. The prompt is answered by the fixture
 * whatever the catalog did.
 */
async function p7CatalogCall(ctx, { dirs, result, caller, catalog, offline, handle, beforeProbe }) {
	const arrivalsBefore = catalog.requests.length;
	const run = await p7Run(ctx, {
		dirs,
		caller,
		result,
		handle: handle ?? caller,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		offline,
		controlled: { catalogBaseUrl: catalog.origin },
		extraOrigins: [catalog.origin],
		extraEnv: DUMMY_PROVIDER_KEYS,
		driveLabel: "probes and one ordinary prompt",
		drive: async (child, outcome) => {
			if (beforeProbe !== undefined) await beforeProbe(child, outcome);
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const prompt = await child.send({ type: "prompt", message: "Say the fixture answer." });
			outcome.check(prompt.success === true, `the task prompt was rejected: ${prompt.error ?? ""}`);
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			outcome.observations.answer = text.data?.text ?? null;
			outcome.check(text.data?.text?.includes(ANSWER) === true, "the fixture model did not answer the prompt, so nothing here says an available model stayed usable");
			return true;
		},
	});
	const arrivals = catalog.requests.slice(arrivalsBefore);
	result.observations.catalogArrivals = arrivals.length;
	result.observations.catalogAttemptsByProvider = p7AttemptsByProvider(arrivals);
	result.observations.catalogArrivalSpacingsMs = arrivals.slice(1).map((one, index) => one.at - arrivals[index].at);
	result.observations.unexpectedCatalogPaths = arrivals.filter((one) => one.provider === undefined).map((one) => `${one.method} ${one.path}`);
	result.check(result.observations.unexpectedCatalogPaths.length === 0, `the catalog endpoint was asked for ${JSON.stringify(result.observations.unexpectedCatalogPaths)}, which is not a provider catalog path`);
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.check(run.observations.input?.allowModelNetwork === true, "the composed catalog permission did not reach the child, so nothing in this case is about what PI_OFFLINE decided");
	result.check(run.observations.controlledOverrides?.includes(`catalogBaseUrl=${catalog.origin}`) === true, `the call's one labelled fixture input is ${JSON.stringify(run.observations.controlledOverrides)} rather than this case's own catalog base url`);
	result.check(run.requests.length === 1, `the case made ${run.requests.length} model request(s) instead of the one it prompts for`);
	// The canary model only exists in the loopback catalog's own answer, so it is what says an overlay came from this
	// listener rather than from the installed build's own baseline.
	result.observations.canaryModels = (result.observations.probe?.availableModels ?? []).filter((id) => id.endsWith(`/${CANARY_MODEL}`));
	p7CheckEnvironment(result, run, { offline: offline === false ? null : offline, search: ctx.p7.utilityDir });
	checkManagedCall(result, run.observations, { dirs, diffs: run.diffs, expectSharedAuth: true });
	checkFetchLog(result, run.fetchLog, caller, { expectAllowed: "some" });
	const allowed = fetchRecords(run.fetchLog, caller).filter((record) => record.event === "allowed");
	result.observations.requestOrigins = [...new Set(allowed.map((record) => record.origin))].sort();
	result.observations.catalogFetches = allowed.filter((record) => record.origin === catalog.origin).length;
	const owned = [originOf(ctx.server.baseUrl), catalog.origin];
	result.check(
		result.observations.requestOrigins.every((origin) => owned.includes(origin)),
		`the child reached ${JSON.stringify(result.observations.requestOrigins)}, and this case owns only ${JSON.stringify(owned)}`,
	);
	result.check(
		result.observations.catalogFetches === arrivals.length,
		`the guard recorded ${result.observations.catalogFetches} catalog request(s) and the endpoint itself saw ${arrivals.length}, so the two accounts of this case's traffic disagree`,
	);
	return { run, arrivals };
}

/** The listener a no-request case names, asked once by the harness itself: a zero-request claim is not about a dead port. */
async function p7CatalogControlCall(result, catalog) {
	try {
		const response = await fetch(`${catalog.origin}/api/models/providers/${P7_CONTROL_PROVIDER}`, { signal: AbortSignal.timeout(10_000) });
		const body = await response.json();
		result.observations.catalogControlCall = { status: response.status, models: Array.isArray(body) ? body.length : null, by: "the harness itself, after the child had exited" };
		result.check(response.status === 200 && Array.isArray(body), `the catalog listener this case named answered ${response.status} to the harness's own call, so a zero-request claim about it would be about an endpoint nothing could reach`);
	} catch (error) {
		result.observations.catalogControlCall = { error: String(error?.message ?? error) };
		result.check(false, `the catalog listener this case named could not be reached by the harness itself: ${result.observations.catalogControlCall.error}`);
	}
	const seen = catalog.requests.filter((one) => one.provider === P7_CONTROL_PROVIDER);
	result.check(seen.length === 1 && catalog.requests.length === 1, `the listener recorded ${JSON.stringify(catalog.requests.map((one) => one.provider))} rather than the harness's own control call alone`);
}

/**
 * The catalog half: `PI_OFFLINE` at four representative values against four cold children, a warm second child on the
 * first one's own stable directory, an endpoint that is always unavailable, and one that accepts and never answers.
 * Each cold case is a profile of its own, so a no-request claim is never made warm; the warm case deliberately shares
 * the unset case's directory and runs after it, which is why the two are one pair here.
 */
async function caseP7CatalogMatrix(ctx) {
	const results = [];

	// The unset case and the warm case on one listener and one stable directory: the second is warm on the first's own
	// persisted store, with nothing reseeded, copied or pre-warmed between them.
	const shared = await startCatalogServer({ label: "P7-unset" });
	ctx.servers.push(shared);
	const coldDirs = ctx.setupCase("P7-offline-unset");
	const cold = implResult("P7-offline-unset-refreshes", P7_CASES["P7-offline-unset-refreshes"], [
		"PI_OFFLINE is absent rather than empty, which is the one state the installed runtime enables its model network in",
		"the catalog is a loopback listener this harness owns and the model is the loopback fixture provider, so both halves of the case are this fixture's own",
	]);
	const coldRun = await p7CatalogCall(ctx, { dirs: coldDirs, result: cold, caller: "P7-offline-unset", catalog: shared, offline: false });
	cold.check(coldRun.arrivals.length > 0, "PI_OFFLINE was absent and this child asked for no catalog at all, which is the state this case measures");
	const coldAttempts = cold.observations.catalogAttemptsByProvider;
	cold.check(
		Object.keys(coldAttempts).sort().join(",") === P7_CONFIGURED_PROVIDERS.join(","),
		`the providers that asked are ${JSON.stringify(Object.keys(coldAttempts).sort())} rather than the ${P7_CONFIGURED_PROVIDERS.length} this fixture configures a dummy key for, ${JSON.stringify(P7_CONFIGURED_PROVIDERS)}`,
	);
	cold.check(Object.values(coldAttempts).every((count) => count === 1), `a provider's catalog was asked for more than once against a healthy endpoint: ${JSON.stringify(coldAttempts)}`);
	const coldStore = p7Store(coldDirs);
	cold.observations.store = p7StoreShape(coldStore);
	cold.check(coldStore !== undefined, "no catalog store was persisted, so the warm case below would have nothing to be warm on");
	for (const provider of Object.keys(coldAttempts)) {
		const entry = coldStore?.[provider];
		cold.check(
			typeof entry?.checkedAt === "number" && typeof entry?.lastModified === "number" && (entry?.models ?? []).some((model) => model.id === CANARY_MODEL),
			`the entry persisted for ${provider} is ${JSON.stringify(p7StoreShape(coldStore)?.[provider])}, and a warm child needs both freshness stamps and this listener's own model in it`,
		);
	}
	cold.check(cold.observations.canaryModels.length > 0, "no model from the loopback catalog is available in the child, so nothing says the refresh reached it");
	results.push(cold);

	const warm = implResult("P7-catalog-warm-second-child", P7_CASES["P7-catalog-warm-second-child"], [
		"the same stable child directory as the unset case above and the same listener, with nothing reseeded, copied or pre-warmed between the two children: the store is the one the first child wrote",
		"the case it depends on runs as its own counted case in this group rather than as a hidden child of this one",
	]);
	const warmRun = await p7CatalogCall(ctx, { dirs: coldDirs, result: warm, caller: "P7-catalog-warm", catalog: shared, offline: false });
	warm.check(warmRun.arrivals.length === 0, `the warm child asked the catalog ${warmRun.arrivals.length} time(s) although the persisted entries are inside the four-hour window this build refreshes on`);
	warm.check(warm.observations.catalogFetches === 0, `the guard recorded ${warm.observations.catalogFetches} catalog request(s) from the warm child`);
	const warmStore = p7Store(coldDirs);
	warm.observations.store = p7StoreShape(warmStore);
	warm.observations.storeSameAsCold = JSON.stringify(warmStore) === JSON.stringify(coldStore);
	warm.check(warm.observations.storeSameAsCold, "the warm child rewrote the persisted catalog although it made no request");
	warm.check(warm.observations.canaryModels.length > 0, "the warm child does not offer the loopback catalog's own model, so its persisted overlay was not restored");
	results.push(warm);

	// The three values that are present rather than absent, each on a cold profile and a listener of its own.
	for (const [name, value, note] of [
		["P7-offline-one-no-refresh", "1", "a truthy value, which is what the helper and package paths of this build read as true"],
		["P7-offline-zero-no-refresh", "0", "a false-looking value, which those same paths read as false and the model runtime still reads as present"],
		["P7-offline-empty-no-refresh", "", "an empty value, which is presence rather than truth and reaches the child as an empty string"],
	]) {
		const dirs = ctx.setupCase(name);
		const catalog = await startCatalogServer({ label: name });
		ctx.servers.push(catalog);
		const result = implResult(name, P7_CASES[name], [
			`PI_OFFLINE=${JSON.stringify(value)}: ${note}`,
			"the listener is live and answering, and this case's own zero-request claim is checked against it by one control call the harness makes itself",
			"the dummy provider keys are the same ones the unset case runs with, so the only difference between the two is the variable",
		]);
		const run = await p7CatalogCall(ctx, { dirs, result, caller: name, catalog, offline: value });
		result.check(run.arrivals.length === 0, `the child asked the catalog ${run.arrivals.length} time(s) although PI_OFFLINE was ${JSON.stringify(value)}`);
		result.check(result.observations.catalogFetches === 0, `the guard recorded ${result.observations.catalogFetches} catalog request(s) from a child that was supposed to make none`);
		result.check(result.observations.canaryModels.length === 0, `the child offers ${JSON.stringify(result.observations.canaryModels)}, which only a catalog refresh could have put there`);
		result.observations.store = p7StoreShape(p7Store(dirs));
		result.check(result.observations.store === null || Object.keys(result.observations.store).length === 0, `a catalog entry was persisted without a request: ${JSON.stringify(result.observations.store)}`);
		await p7CatalogControlCall(result, catalog);
		results.push(result);
	}

	// An endpoint that answers 503 to everything, on a cold profile of its own.
	const unavailableDirs = ctx.setupCase("P7-catalog-unavailable");
	const unavailable = await startFailingCatalogServer({ label: "P7-catalog-unavailable", mode: "unavailable" });
	ctx.servers.push(unavailable);
	const failed = implResult("P7-catalog-unavailable", P7_CASES["P7-catalog-unavailable"], [
		"the attempt count is this build's own: the SDK retries a retryable status twice on its own, and this harness adds no retry, no attempt and no bound of its own",
		"what this case does not claim: the entry a failed refresh persists carries a checked-at stamp and no last-modified one, so a later child may ask again and no warm-and-quiet claim follows a failure",
	]);
	const failedRun = await p7CatalogCall(ctx, { dirs: unavailableDirs, result: failed, caller: "P7-catalog-unavailable", catalog: unavailable, offline: false });
	const failedAttempts = failed.observations.catalogAttemptsByProvider;
	failed.check(
		Object.keys(failedAttempts).sort().join(",") === P7_CONFIGURED_PROVIDERS.join(","),
		`the providers that asked are ${JSON.stringify(Object.keys(failedAttempts).sort())} rather than the ${P7_CONFIGURED_PROVIDERS.length} this fixture configures, ${JSON.stringify(P7_CONFIGURED_PROVIDERS)}`,
	);
	failed.check(
		Object.values(failedAttempts).every((count) => count === P7_CATALOG_ATTEMPTS),
		`the endpoint was asked ${JSON.stringify(failedAttempts)} rather than exactly ${P7_CATALOG_ATTEMPTS} time(s) per provider`,
	);
	failed.check(failedRun.arrivals.every((one) => one.path === `/api/models/providers/${one.provider}`), "an arrival was on a path other than the provider catalog path it was counted under");
	const failedStore = p7Store(unavailableDirs);
	failed.observations.store = p7StoreShape(failedStore);
	for (const provider of Object.keys(failedAttempts)) {
		const entry = failedStore?.[provider];
		failed.check(
			typeof entry?.checkedAt === "number" && entry?.lastModified === undefined,
			`the entry persisted for ${provider} after the failure is ${JSON.stringify(p7StoreShape(failedStore)?.[provider])}, and this build persists a checked-at stamp without a last-modified one there`,
		);
	}
	failed.check(failed.observations.canaryModels.length === 0, "a model from a catalog that never answered is available in the child");
	results.push(failed);

	// An endpoint that accepts and never answers, on a cold profile of its own.
	const hangingDirs = ctx.setupCase("P7-catalog-hanging");
	const hanging = await startFailingCatalogServer({ label: "P7-catalog-hanging", mode: "hang" });
	ctx.servers.push(hanging);
	const hung = implResult("P7-catalog-hanging", P7_CASES["P7-catalog-hanging"], [
		"the listener accepts the connection and never answers: what ends an attempt is the SDK's own four-second per-attempt timeout, and this harness adds no sleep, no timer and no modelRefreshTimeoutMs of its own",
		"the answer window is measured from the first arrival at that listener rather than from the launch, and a child that never reaches it fails the case for having no reference point instead of passing",
	]);
	const startedAt = Date.now();
	const hungRun = await p7CatalogCall(ctx, {
		dirs: hangingDirs,
		result: hung,
		caller: "P7-catalog-hanging",
		catalog: hanging,
		offline: false,
		beforeProbe: async (child, outcome) => {
			// A poll on an observable condition rather than a wait of a chosen length: the first arrival is the instant
			// every timing claim below is measured from, and it is allowed its own generous startup window.
			const waited = await pollFor(() => hanging.requests[0], (value) => value !== undefined, { pollMs: 100, maxPolls: P7_FIRST_ARRIVAL_DEADLINE_MS / 100 });
			outcome.observations.firstArrival = waited.ok ? { provider: waited.value.provider, waitedMs: waited.value.at - startedAt } : null;
			outcome.check(waited.ok, `no catalog request arrived within ${P7_FIRST_ARRIVAL_DEADLINE_MS}ms, so this case has no reference point to measure an answer from`);
			if (!waited.ok) return;
			const state = await child.send({ type: "get_state" }, P7_FIRST_ARRIVAL_DEADLINE_MS + P7_HANGING_ANSWER_MS);
			const answeredIn = Date.now() - waited.value.at;
			outcome.observations.firstProbe = { answered: state.success === true, msFromFirstArrival: answeredIn, allowanceMs: P7_HANGING_ANSWER_MS };
			outcome.check(state.success === true, `the first non-task probe failed: ${state.error ?? ""}`);
			outcome.check(
				answeredIn <= P7_HANGING_ANSWER_MS,
				`the first probe answered ${answeredIn}ms after the first catalog request, and ${P7_CATALOG_ATTEMPTS} bounded ${P7_CATALOG_ATTEMPT_TIMEOUT_MS}ms attempts plus this case's allowance is ${P7_HANGING_ANSWER_MS}ms`,
			);
		},
	});
	hung.check(hungRun.arrivals.length > 0, "nothing arrived at the hanging listener at all");
	hung.observations.hangingAttemptsByProvider = p7AttemptsByProvider(hungRun.arrivals);
	hung.check(
		Object.keys(hung.observations.hangingAttemptsByProvider).sort().join(",") === P7_CONFIGURED_PROVIDERS.join(","),
		`the providers that reached the hanging listener are ${JSON.stringify(Object.keys(hung.observations.hangingAttemptsByProvider).sort())} rather than the ${P7_CONFIGURED_PROVIDERS.length} this fixture configures`,
	);
	hung.check(
		Object.values(hung.observations.hangingAttemptsByProvider).every((count) => count === P7_CATALOG_ATTEMPTS),
		`the hanging endpoint was accepted ${JSON.stringify(hung.observations.hangingAttemptsByProvider)} times per provider rather than exactly ${P7_CATALOG_ATTEMPTS}`,
	);
	hung.observations.store = p7StoreShape(p7Store(hangingDirs));
	hung.check(hung.observations.canaryModels.length === 0, "a model from a catalog that never answered is available in the child");
	results.push(hung);
	return results;
}

/* ------------------------- P7, second half: the helper download, its interposer and the offline matrix ------------- */

/*
 * What the six cases below measure, and what they deliberately do not. Pi's `grep` and `find` tools call the SDK's own
 * `ensureTool`, which — when neither a child-bin program nor a `PATH` one answers — resolves a repository's latest
 * release, downloads one asset, unpacks it with the platform's `tar`, renames the program into the child agent
 * directory's `bin` and makes it executable. That whole path is what runs here, unchanged: nothing in this harness
 * imports `ensureTool`, stubs it, patches the SDK, writes a downloader of its own or puts a program where a lookup
 * would find one. The only thing this fixture changes is **where two exact urls go**, through the interposer preload
 * beside the guard, and what those urls answer with: a 302 to a fixture tag and one archive holding a generated shell
 * program. The install is therefore the SDK's own; the bytes it installs are this harness's.
 */

/**
 * One release archive per helper, built with the owned `tar` and `gzip` and verified before any child runs. Each one
 * holds a single member at the path the SDK looks for first — `<asset-without-.tar.gz>/<tool>` — and the program inside
 * it is staged at 0600: a downloaded program that ends up at 0755 can only be read as the SDK's own `chmod` if what was
 * archived was not executable, so the archive is extracted once here and that mode is measured rather than assumed.
 * The program's output is independent of any working directory, so one archive can serve more than one case.
 */
function p7BuildReleases(ctx) {
	const dir = path.join(ctx.root, "p7-releases");
	const tarCommand = path.join(ctx.p7.utilityDir, "tar");
	const archives = {};
	for (const tool of P7_HELPERS) {
		const release = p7ReleaseUrls(tool);
		const stageRoot = path.join(dir, `stage-${tool}`);
		const memberDir = path.join(stageRoot, release.asset.replace(/\.tar\.gz$/, ""));
		const program = p7WriteHelper({ dir: memberDir, tool, token: P7_DOWNLOAD_TOKEN, mode: 0o600 });
		const stagedMode = (fs.statSync(program).mode & 0o777).toString(8);
		const member = `${path.basename(memberDir)}/${tool}`;
		const archive = path.join(dir, release.asset);
		// Real tar and real gzip, both from this group's own utility directory and reached through a search path holding
		// nothing else: no shell, no pipeline and no compression written here.
		const utilities = { PATH: ctx.p7.utilityDir };
		const created = spawnSync(tarCommand, ["czf", archive, "-C", stageRoot, member], { env: utilities, stdio: "pipe" });
		if (created.status !== 0) throw new Error(`the ${tool} release archive could not be created: ${String(created.stderr ?? created.error)}`);
		const listed = spawnSync(tarCommand, ["tzf", archive], { env: utilities, stdio: "pipe" });
		const verifyDir = path.join(dir, `verify-${tool}`);
		fs.mkdirSync(verifyDir, { recursive: true });
		const extracted = spawnSync(tarCommand, ["xzf", archive, "-C", verifyDir], { env: utilities, stdio: "pipe" });
		if (extracted.status !== 0) throw new Error(`the ${tool} release archive could not be extracted: ${String(extracted.stderr ?? extracted.error)}`);
		const extractedFile = path.join(verifyDir, member);
		archives[tool] = {
			...release,
			program,
			member,
			archive,
			stagedMode,
			stagedSha: hashFile(program),
			listing: String(listed.stdout ?? "").trim().split("\n"),
			extractedMode: (fs.statSync(extractedFile).mode & 0o777).toString(8),
			extractedSha: hashFile(extractedFile),
			body: fs.readFileSync(archive),
		};
	}
	// The exact urls the interposer maps, and the only ones: two per helper, in the order a download goes through them.
	const urls = P7_HELPERS.flatMap((tool) => [archives[tool].latestUrl, archives[tool].downloadUrl]);
	return { dir, archives, urls };
}

/**
 * The fixture release endpoint: a loopback listener that answers exactly the paths the two mapped urls carry — a 302 to
 * a relative fixture tag for a `releases/latest`, and one archive for an asset — and 404s anything else, recorded. It
 * is the origin the interposer maps to, and nothing in this group ever names a real release endpoint as a target.
 */
async function startReleaseServer({ label, releases }) {
	const requests = [];
	const routes = new Map();
	for (const one of Object.values(releases.archives)) {
		routes.set(one.latestPath, { kind: "latest", location: one.tagLocation, tool: one.tool });
		routes.set(one.downloadPath, { kind: "asset", body: one.body, tool: one.tool });
	}
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const route = routes.get(url.pathname);
		requests.push({ label, method: req.method, path: url.pathname, kind: route?.kind ?? "unexpected", tool: route?.tool, at: Date.now() });
		if (route === undefined) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: `this fixture serves two release urls per helper and nothing else; ${url.pathname} is not one of them` }));
			return;
		}
		if (route.kind === "latest") {
			// The shape `getLatestVersion` reads: a 3xx with a relative `location` naming a `/releases/tag/<tag>` path.
			// The caller asked for `redirect: "manual"`, so this answer is returned to it rather than followed.
			res.writeHead(302, { location: route.location, "content-type": "text/html; charset=utf-8" });
			res.end("<html><body>spike fixture redirect</body></html>");
			return;
		}
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(route.body.length) });
		res.end(route.body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		label,
		origin: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** What one call hands the interposer: this group's own listener, its exact url list, and a log of the call's own. */
const p7Interposer = (ctx, log) => ({ origin: ctx.p7.release.origin, urls: ctx.p7.releases.urls, log });

/**
 * What the interposer recorded, which every download claim rests on: the preload was installed in the processes this
 * case is about, it captured the guard rather than replacing it, it offered exactly the url map this group composed,
 * and the original urls it mapped are exactly the ones expected. The same reader the guard's log uses, because the two
 * logs are the same JSONL shape and are separate files on purpose — this one holds the **original** urls a child asked
 * for, and the guard's holds the **actual** loopback traffic that went out.
 *
 * `expectInstalled: false` is the omission control's: with the preload left out, nothing may be there. That is what
 * makes these checks non-vacuous, so they are the same checks in both runs rather than a claim in one of them.
 */
function p7CheckInterposer(result, log, caller, { expectInstalled = true, expectChild = true, expectMapped = [], expectedUrls, key = "interposer" }) {
	const records = fetchRecords(log, caller);
	const installed = records.filter((record) => record.event === "installed");
	const mapped = records.filter((record) => record.event === "mapped");
	const unusable = records.filter((record) => ["refused", "no-global-fetch", "unmappable-request", "unparsed"].includes(record.event));
	const installedBy = [...new Set(installed.map((record) => record.caller))].sort();
	result.observations[key] = {
		log: records.some((record) => record.event === "log-missing") ? "missing" : "present",
		installedBy,
		wraps: [...new Set(installed.map((record) => record.wraps ?? null))],
		origins: [...new Set(installed.map((record) => record.origin ?? null))],
		mapped: mapped.map((record) => ({ original: record.original, to: record.to, method: record.method, redirect: record.redirect })),
		unmapped: records.filter((record) => record.event === "unmapped").map((record) => `${record.origin}${record.path}`),
		unusable,
	};
	const actualMapped = mapped.map((record) => record.original);
	// The one check that comes before every branch, the omission control's included: an unreadable log is the absence of
	// evidence rather than the evidence of absence, so "nothing was mapped" has to be a log this harness created empty
	// and can still read. A log that is gone fails here whichever way the case expects the rest to come out.
	result.check(result.observations[key].log === "present", `the interposer log ${log} could not be read, so this case holds no evidence about which urls were mapped`);
	if (!expectInstalled) {
		result.check(installed.length === 0, `the interposer was installed in ${JSON.stringify(installedBy)} although this run leaves its preload out`);
		result.check(mapped.length === 0, `the interposer mapped ${JSON.stringify(actualMapped)} although this run leaves its preload out`);
		return result.observations[key];
	}
	const required = expectChild ? [caller, `${caller}/child`] : [caller];
	const absent = required.filter((identity) => !installedBy.includes(identity));
	result.check(absent.length === 0, `no interposer was installed in ${JSON.stringify(absent)}, so a download claim about ${caller} would be about a process nothing was mapping for`);
	result.check(unusable.length === 0, `the interposer refused its configuration or could not map a request: ${JSON.stringify(unusable.slice(0, 2))}`);
	// The ordering, read off the function it captured: the guard's own wrapper is `guardedFetch`, so an interposer that
	// had been loaded first — and would therefore have sent a mapped request itself, unwatched — fails here.
	result.check(
		installed.length > 0 && installed.every((record) => record.wraps === "guardedFetch"),
		`an installed interposer captured ${JSON.stringify(result.observations[key].wraps)} rather than the guard's own wrapper, so it was not loaded after the guard`,
	);
	result.check(
		installed.every((record) => (record.mapped ?? []).join(",") === expectedUrls.join(",")),
		`an installed interposer offered the map ${JSON.stringify(result.observations[key].origins)} ${JSON.stringify(installed.map((record) => record.mapped))} rather than exactly this group's ${JSON.stringify(expectedUrls)}`,
	);
	// Which process did the mapping, and not only that some process did. A download case is a claim about the **child**:
	// the controller is preloaded too, and a run whose child mapped nothing while the controller mapped everything is a
	// different measurement wearing the same log. So the exact expected list is required of `<caller>/child` and the
	// controller is required to have mapped nothing at all; a control with no child of its own is read under the
	// caller's own identity, where there is only one process to attribute anything to.
	const identity = expectChild ? `${caller}/child` : caller;
	const byIdentity = mapped.filter((record) => record.caller === identity).map((record) => record.original);
	const elsewhere = mapped.filter((record) => record.caller !== identity).map((record) => `${record.caller}: ${record.original}`);
	result.observations[key].mappedBy = { identity, forIt: byIdentity, elsewhere };
	result.check(
		byIdentity.join(" ") === expectMapped.join(" "),
		`${identity} mapped ${JSON.stringify(byIdentity)} rather than exactly ${JSON.stringify(expectMapped)}`,
	);
	result.check(elsewhere.length === 0, `a process other than ${identity} mapped a url in this case: ${JSON.stringify(elsewhere)}`);
	result.check(
		actualMapped.join(" ") === expectMapped.join(" "),
		`the interposer mapped ${JSON.stringify(actualMapped)} rather than exactly ${JSON.stringify(expectMapped)}`,
	);
	return result.observations[key];
}

/**
 * The checker's own two negative controls, in the case that starts nothing: they exist because both rules above are
 * about the **absence** of something, and a rule that cannot fail is not a rule. Each one hands `p7CheckInterposer` a
 * log this function writes itself — owned, inside the disposable root, and never one of the logs a real call produced —
 * and requires the checker to report failures for it. No process, no network, no SDK and no backend is involved: the
 * records are literal lines in the shape the preload writes.
 *
 * The first is a log that is not there at all, read the way the omission run is read, `expectInstalled: false` included:
 * a missing log must fail even where nothing is expected to have been installed. The second is a log in which both
 * processes installed correctly but every mapped url is the controller's, which is what the per-process attribution is
 * for. Both run against a throwaway result that is in no group and counted nowhere; what is asserted is that the
 * checker rejected them, and the kept logs of the real calls are untouched by either.
 */
function p7CheckInterposerControls(result, dirs, { origin, urls, caller }) {
	const synthetic = (label) => implResult(label, "a synthetic result for the interposer checker's own controls, in no group and counted nowhere");
	const line = (entry) => `${JSON.stringify(entry)}\n`;

	// A path inside this case's own directory that is deliberately never created. `write` is what makes every other log
	// in this group readable; this one is the one nothing wrote.
	const absent = path.join(dirs.caseRoot, "interposer-control-missing.log");
	fs.rmSync(absent, { force: true });
	const missing = synthetic("synthetic-interposer-log-missing");
	p7CheckInterposer(missing, absent, caller, { expectInstalled: false, expectChild: false, expectedUrls: urls, key: "interposer" });
	result.observations.checkerMissingLogControl = { log: absent, exists: fs.existsSync(absent), failures: missing.failures, observed: missing.observations.interposer?.log ?? null };
	result.check(
		missing.failures.length > 0 && missing.observations.interposer?.log === "missing",
		`a missing interposer log passed the checker with ${JSON.stringify(missing.failures)}, so "nothing was mapped" would not have to rest on a log that is there`,
	);

	// Both processes installed, with the right map and the right captured wrapper, and every mapped url the
	// controller's: the child mapped nothing, which is exactly the shape a download claim must not accept.
	const misattributed = path.join(dirs.caseRoot, "interposer-control-misattributed.log");
	const installed = (who) => line({ caller: who, at: 0, event: "installed", origin, mapped: urls, wraps: "guardedFetch" });
	write(
		misattributed,
		`${installed(caller)}${installed(`${caller}/child`)}${urls
			.slice(0, 2)
			.map((url) => line({ caller, at: 0, event: "mapped", original: url, to: `${origin}${new URL(url).pathname}`, method: "GET", redirect: null }))
			.join("")}`,
	);
	const wrongProcess = synthetic("synthetic-interposer-mapped-by-controller");
	p7CheckInterposer(wrongProcess, misattributed, caller, { expectChild: true, expectedUrls: urls, expectMapped: urls.slice(0, 2), key: "interposer" });
	result.observations.checkerAttributionControl = {
		log: misattributed,
		failures: wrongProcess.failures,
		mappedBy: wrongProcess.observations.interposer?.mappedBy ?? null,
	};
	result.check(
		wrongProcess.failures.length > 0 && (wrongProcess.observations.interposer?.mappedBy?.forIt ?? []).length === 0,
		`a log whose child mapped nothing and whose controller mapped everything passed the checker with ${JSON.stringify(wrongProcess.failures)}`,
	);
}

/**
 * Case B0, the interposer's own control: no child, no SDK and no backend in it, and it runs before the first download
 * case so nothing below rests on an unproved map. Two probe runs of the same five attempts' worth of intent: with the
 * preload, the two `releases/latest` urls reach this fixture's own listener and answer the manual 302 the SDK's tool
 * manager reads, while an unrelated `github.com` release page and an asset no case listed are refused by the guard
 * before anything is sent; without the preload, the same rg url is refused too, and the installation and mapping
 * evidence the first run requires is absent — which is what says those checks are not vacuous.
 *
 * Beside the two runs, two further things, both of them separate concerns and neither a case of its own. The checker's
 * own negative controls, on synthetic logs this case writes: a log that is gone has to fail even where nothing was
 * expected to be installed, and a log whose controller did all the mapping has to fail a claim about a child. And the
 * preload's own configuration validation, which `implEnv`'s cannot stand in for: an ordinary environment with one of
 * the three interposer values replaced by a malformed one afterwards has to make the preload refuse before the program
 * it was loaded into runs at all. A real origin as the mapping target is one of those.
 */
async function caseP7InterposerControl(ctx) {
	const dirs = ctx.setupCase("P7-helper-interposer-control");
	const name = "P7-helper-interposer-control";
	const result = implResult(name, P7_CASES[name], [
		"no child, no SDK and no model in this case: it is the control the six download cases below rest on, and it runs before the first of them",
		"the interposer is a second preload after the guard: it rewrites two exact urls per helper to a loopback listener this harness owns and passes everything else through to the guard, which refuses an origin this fixture does not own",
		"the guard is never taken away here and no real release endpoint is ever contacted: the blocked attempts are refused before a request is sent, which the listener's own request list corroborates",
	]);
	const releases = ctx.p7.releases;
	const endpoint = ctx.p7.release;
	const { rg, fd } = releases.archives;
	result.observations.releases = Object.fromEntries(
		Object.entries(releases.archives).map(([tool, one]) => [
			tool,
			{ latestUrl: one.latestUrl, downloadUrl: one.downloadUrl, tagLocation: one.tagLocation, asset: one.asset, member: one.member, listing: one.listing, stagedMode: one.stagedMode, extractedMode: one.extractedMode, bytes: one.body.length },
		]),
	);
	result.observations.interposerOrigin = endpoint.origin;
	result.observations.mappedUrls = releases.urls;
	// The archives themselves, checked here rather than trusted below: one member at the path the SDK looks for first,
	// and a mode that is not executable, so a downloaded program at 0755 is the SDK's own chmod and not tar's doing.
	for (const [tool, one] of Object.entries(releases.archives)) {
		result.check(one.listing.join(",") === one.member, `the ${tool} archive holds ${JSON.stringify(one.listing)} rather than exactly its own ${one.member}`);
		result.check(one.stagedMode === "600" && one.extractedMode === "600", `the ${tool} archive's program is staged ${one.stagedMode} and extracts as ${one.extractedMode}, and this group needs a non-executable mode to read the SDK's chmod from`);
		result.check(one.extractedSha === one.stagedSha, `the ${tool} archive's program does not come back out of it byte for byte`);
	}

	const probe = async (label, { interposer }) => {
		const fetchLog = path.join(dirs.caseRoot, `fetch-${label}.log`);
		const interposerLog = path.join(dirs.caseRoot, `interposer-${label}.log`);
		const observationsFile = path.join(dirs.caseRoot, `probe-${label}.json`);
		const specFile = path.join(dirs.caseRoot, `probe-${label}-spec.json`);
		// Created empty on purpose: with the preload left out, "nothing was mapped" has to be a readable log with no
		// line in it rather than a file that is not there.
		write(interposerLog, "");
		const attempts =
			interposer === true
				? [
						{ label: "rg-latest", url: rg.latestUrl, redirect: "manual" },
						{ label: "fd-latest", url: fd.latestUrl, redirect: "manual" },
						{ label: "unrelated-github-latest", url: `${P7_RELEASE_ORIGIN}/spike-unrelated/spike-unrelated/releases/latest`, redirect: "manual" },
						{ label: "unlisted-rg-asset", url: `${P7_RELEASE_ORIGIN}/${P7_RELEASES.rg.repo}/releases/download/${rg.tag}/ripgrep-${P7_SPIKE_VERSION}-unlisted-target.tar.gz` },
					]
				: [{ label: "rg-latest", url: rg.latestUrl, redirect: "manual" }];
		writeJson(specFile, { observations: observationsFile, attempts });
		const env = implEnv(ctx.root, {
			agentDir: dirs.profile,
			sessionDir: dirs.sessions,
			caller: label,
			// The listener is an owned origin for the guard, which is what lets a mapped request through; every url
			// this probe names is still refused unless the interposer rewrote it, because github.com is not on this list.
			origins: [endpoint.origin],
			fetchLog,
			extra: { PATH: ctx.p7.utilityDir },
			...(interposer === true ? { interposer: p7Interposer(ctx, interposerLog) } : {}),
		});
		const arrivalsBefore = endpoint.requests.length;
		const run = await runCli(process.execPath, [STORAGE_CALLER, "fetch-probe", specFile], { cwd: dirs.project, env });
		return {
			label,
			exit: run.code,
			nodeOptions: env.NODE_OPTIONS,
			attempts: (readJsonIfPresent(observationsFile) ?? {}).attempts ?? [],
			arrivals: endpoint.requests.slice(arrivalsBefore),
			fetchLog,
			interposerLog,
			records: fetchRecords(fetchLog, label),
		};
	};

	const mapped = await probe("P7-interposer-mapped", { interposer: true });
	result.observations.mappedRun = { exit: mapped.exit, nodeOptions: mapped.nodeOptions, attempts: mapped.attempts, arrivals: mapped.arrivals.map((one) => ({ path: one.path, kind: one.kind })) };
	const byLabel = Object.fromEntries(mapped.attempts.map((attempt) => [attempt.label, attempt]));
	for (const [label, one] of [
		["rg-latest", rg],
		["fd-latest", fd],
	]) {
		const attempt = byLabel[label];
		// The 302 itself, and where it pointed: `getLatestVersion` asks for `manual` and reads the location header, so a
		// fixture that answered 200, or followed its own redirect, would not be measuring what that function does.
		result.check(attempt?.status === 302, `the mapped ${label} answered ${JSON.stringify(attempt)} rather than the 302 the SDK's tool manager reads a tag from`);
		result.check(attempt?.redirect === "manual", `the ${label} attempt was made with redirect ${JSON.stringify(attempt?.redirect)} rather than the manual mode the SDK uses`);
		result.check(attempt?.location === one.tagLocation, `the mapped ${label} pointed at ${JSON.stringify(attempt?.location)} rather than exactly ${JSON.stringify(one.tagLocation)}`);
	}
	for (const label of ["unrelated-github-latest", "unlisted-rg-asset"]) {
		const attempt = byLabel[label];
		result.check(
			attempt?.ok === false && String(attempt?.error ?? "").includes("spike fetch guard"),
			`${label} was not refused by the guard: ${JSON.stringify(attempt)}`,
		);
	}
	result.check(
		mapped.arrivals.map((one) => `${one.kind}:${one.path}`).join(" ") === `latest:${rg.latestPath} latest:${fd.latestPath}`,
		`this fixture's listener was asked for ${JSON.stringify(mapped.arrivals.map((one) => one.path))} rather than exactly the two mapped release pages`,
	);
	const mappedRecords = mapped.records;
	result.observations.mappedGuardLog = {
		allowed: mappedRecords.filter((record) => record.event === "allowed").map((record) => `${record.origin}${record.path}`),
		blocked: mappedRecords.filter((record) => record.event === "blocked").map((record) => `${record.origin}${record.path}`),
	};
	// The two accounts of the same traffic: the guard's log holds the actual loopback requests, the interposer's holds
	// the original urls, and the blocked pair reached the guard without a rewrite.
	result.check(
		result.observations.mappedGuardLog.allowed.join(" ") === `${endpoint.origin}${rg.latestPath} ${endpoint.origin}${fd.latestPath}`,
		`the guard recorded the actual traffic ${JSON.stringify(result.observations.mappedGuardLog.allowed)} rather than the two mapped requests at this fixture's own listener`,
	);
	result.check(
		result.observations.mappedGuardLog.blocked.length === 2 && result.observations.mappedGuardLog.blocked.every((one) => one.startsWith(P7_RELEASE_ORIGIN)),
		`the guard blocked ${JSON.stringify(result.observations.mappedGuardLog.blocked)} rather than exactly the two unmapped release urls`,
	);
	p7CheckInterposer(result, mapped.interposerLog, "P7-interposer-mapped", {
		expectChild: false,
		expectedUrls: releases.urls,
		expectMapped: [rg.latestUrl, fd.latestUrl],
		key: "interposerMapped",
	});

	// The same rg url with the preload left out and the guard still in place: refused, nothing reaches the listener, and
	// the installation and mapping evidence above is absent rather than merely different.
	const arrivalsBeforeOmission = endpoint.requests.length;
	const omitted = await probe("P7-interposer-omitted", { interposer: false });
	result.observations.omittedRun = { exit: omitted.exit, nodeOptions: omitted.nodeOptions, attempts: omitted.attempts, arrivals: omitted.arrivals.length };
	result.check(!omitted.nodeOptions.includes(path.basename(HELPER_INTERPOSER)), `the omission run was still composed with the interposer preload: ${omitted.nodeOptions}`);
	result.check(omitted.nodeOptions.includes(path.basename(FETCH_GUARD)), `the omission run lost the guard as well, which it must never do: ${omitted.nodeOptions}`);
	const omittedAttempt = omitted.attempts[0];
	result.check(
		omittedAttempt?.ok === false && String(omittedAttempt?.error ?? "").includes("spike fetch guard"),
		`with the interposer left out the rg release page was not refused by the guard: ${JSON.stringify(omittedAttempt)}`,
	);
	result.check(endpoint.requests.length === arrivalsBeforeOmission, `this fixture's listener was asked ${endpoint.requests.length - arrivalsBeforeOmission} time(s) by a run whose urls nothing was mapping`);
	p7CheckInterposer(result, omitted.interposerLog, "P7-interposer-omitted", { expectInstalled: false, expectChild: false, expectedUrls: releases.urls, key: "interposerOmitted" });

	// The checker's own two negative controls, on logs this case writes for them: a separate concern from the two probe
	// runs above and from the startup refusals below, because what they exercise is the reader rather than the preload.
	p7CheckInterposerControls(result, dirs, { origin: endpoint.origin, urls: releases.urls, caller: "P7-interposer-checker" });

	// The preload's own configuration checks. `implEnv` refuses these before composing anything, so they are reached by
	// composing an ordinary environment and replacing one value in it afterwards — a fixture-side mutation, recorded as
	// one. The program is `process.exitCode = 7` and never runs: the refusal happens while the preload is imported.
	const refusalLog = path.join(dirs.caseRoot, "interposer-refusals.log");
	write(refusalLog, "");
	const base = implEnv(ctx.root, {
		agentDir: dirs.profile,
		sessionDir: dirs.sessions,
		caller: "P7-interposer-refusals",
		origins: [endpoint.origin],
		fetchLog: path.join(dirs.caseRoot, "fetch-refusals.log"),
		extra: { PATH: ctx.p7.utilityDir },
		interposer: p7Interposer(ctx, refusalLog),
	});
	const refusals = {};
	for (const [label, patch] of Object.entries({
		"origin-absent": { PI_SPIKE_HELPER_ORIGIN: undefined },
		"origin-not-loopback": { PI_SPIKE_HELPER_ORIGIN: P7_RELEASE_ORIGIN },
		"origin-with-path": { PI_SPIKE_HELPER_ORIGIN: `${endpoint.origin}/releases` },
		"urls-absent": { PI_SPIKE_HELPER_URLS: undefined },
		"urls-malformed": { PI_SPIKE_HELPER_URLS: "not a url at all" },
		"urls-whole-origin": { PI_SPIKE_HELPER_URLS: `${P7_RELEASE_ORIGIN}/` },
		"urls-repeated": { PI_SPIKE_HELPER_URLS: `${rg.latestUrl},${rg.latestUrl}` },
		// The one patch that leaves nothing to record with: a preload whose own log is gone still refuses, and does it
		// without a record, which is why a case's evidence is a log it created empty rather than one it found.
		"log-absent": { PI_SPIKE_INTERPOSER_LOG: undefined },
	})) {
		const env = { ...base };
		for (const [variable, value] of Object.entries(patch)) {
			if (value === undefined) delete env[variable];
			else env[variable] = value;
		}
		const before = fetchRecords(refusalLog, undefined).length;
		const run = await runCli(process.execPath, ["-e", "process.exitCode = 7"], { cwd: dirs.project, env });
		const recorded = fetchRecords(refusalLog, undefined).slice(before);
		refusals[label] = { exit: run.code, refused: recorded.filter((record) => record.event === "refused").map((record) => record.reason), installed: recorded.some((record) => record.event === "installed") };
		result.check(run.code !== 0 && run.code !== 7, `a ${label} interposer configuration exited ${JSON.stringify(run.code)}, so it either installed or let the program it was loaded into run`);
		result.check(refusals[label].installed === false, `a ${label} interposer configuration installed itself anyway`);
		const expectedRecords = label === "log-absent" ? 0 : 1;
		result.check(
			refusals[label].refused.length === expectedRecords,
			`a ${label} interposer configuration recorded ${JSON.stringify(refusals[label].refused)} rather than exactly ${expectedRecords} refusal(s)`,
		);
	}
	result.observations.configurationRefusals = refusals;
	return result;
}

/**
 * One download-half call: a real child, a script that asks for exactly one session tool call per helper this case
 * names and then a final answer, and the interposer beside the guard. Everything a case reads afterwards comes from
 * the public `tool_execution_end` events, the helper fixtures' own log, the two guarded logs and the listener's own
 * request list — never from a final assistant text or an acknowledged prompt.
 */
async function p7DownloadCall(ctx, { dirs, result, caller, helpers, offline, catalog, expectUnavailable = false }) {
	const helperLog = path.join(dirs.caseRoot, `helpers-${caller}.log`);
	const interposerLog = path.join(dirs.caseRoot, `interposer-${caller}.log`);
	// Both created empty: "this program was never invoked" and "this url was never mapped" have to be readable logs
	// with no line in them rather than files that are not there.
	write(helperLog, "");
	write(interposerLog, "");
	const sentinel = `${P7_SEARCH_SENTINEL}-${caller}`;
	ctx.server.script(sentinel, [
		...helpers.map((tool) => ({ kind: "tool_call", name: P7_HELPER_TOOLS[tool].tool, toolName: P7_HELPER_TOOLS[tool].tool, arguments: P7_HELPER_TOOLS[tool].args, toolCallId: `call_${caller}_${tool}` })),
		{ kind: "text", name: "final", text: ANSWER },
	]);
	const arrivalsBefore = ctx.p7.release.requests.length;
	const run = await p7Run(ctx, {
		dirs,
		caller,
		result,
		handle: caller,
		role: { name: "implement", model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: "implement.md" },
		helperLog,
		interposer: p7Interposer(ctx, interposerLog),
		// Helper-free: the owned utility directory is the whole search path, and no case here seeds a program anywhere.
		pathDirs: [],
		offline,
		...(catalog === undefined ? {} : { controlled: { catalogBaseUrl: catalog.origin } }),
		extraOrigins: [ctx.p7.release.origin, ...(catalog === undefined ? [] : [catalog.origin])],
		driveLabel: "probes and one scripted search task",
		drive: async (child, outcome) => {
			await probeChild(child, outcome, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium" });
			const prompt = await child.send({ type: "prompt", message: `${sentinel} search this project and list its files.` });
			outcome.check(prompt.success === true, `the task prompt was rejected: ${prompt.error ?? ""}`);
			await child.waitFor("agent_settled");
			const text = await child.send({ type: "get_last_assistant_text" });
			outcome.observations.answer = text.data?.text ?? null;
			outcome.check(text.data?.text?.includes(ANSWER) === true, "the scripted final answer did not come back");
			const ends = child.events.filter((event) => event.type === "tool_execution_end");
			outcome.observations.toolResults = ends.map((event) => ({
				toolName: event.toolName,
				isError: event.isError,
				text: event.result?.content?.[0]?.text ?? null,
				details: event.result?.details ?? null,
			}));
			outcome.check(ends.length === helpers.length, `the child ended ${ends.length} tool execution(s) instead of the ${helpers.length} the script asks for`);
			for (const [index, tool] of helpers.entries()) {
				const expected = P7_HELPER_TOOLS[tool];
				const actual = outcome.observations.toolResults[index];
				outcome.check(actual?.toolName === expected.tool, `tool execution ${index} was ${JSON.stringify(actual?.toolName)} instead of ${expected.tool}`);
				if (expectUnavailable) {
					// The exact rejection Pi's own tool makes when no helper is available and none may be downloaded,
					// as a tool result rather than as a refused startup: this child ran and answered afterwards.
					outcome.check(actual?.isError === true, `the ${expected.tool} call came back as a success although no helper could be available: ${JSON.stringify(actual?.text)}`);
					outcome.check(
						actual?.text === P7_UNAVAILABLE_MESSAGE[tool],
						`the ${expected.tool} call answered ${JSON.stringify(actual?.text)} rather than exactly ${JSON.stringify(P7_UNAVAILABLE_MESSAGE[tool])}`,
					);
					continue;
				}
				outcome.check(actual?.isError === false, `the ${expected.tool} call came back as an error: ${JSON.stringify(actual?.text)}`);
				outcome.check(actual?.text === expected.result(P7_DOWNLOAD_TOKEN), `the ${expected.tool} call answered ${JSON.stringify(actual?.text)} rather than exactly ${JSON.stringify(expected.result(P7_DOWNLOAD_TOKEN))}`);
			}
			return true;
		},
	});
	result.check(run.finished.observations.childExit?.code === 0, `the child exited ${JSON.stringify(run.finished.observations.childExit)} instead of code 0`);
	result.observations.scriptSteps = run.requests.map((request) => request.scriptStep ?? null);
	result.check(run.requests.length === helpers.length + 1, `the task made ${run.requests.length} model request(s) instead of the ${helpers.length + 1} this script answers`);
	const trace = p7HelperTrace(helperLog);
	result.observations.helperTrace = trace.present ? trace.entries.map((entry) => ({ event: entry.event, tool: entry.tool, kind: entry.kind, argv0: entry.argv0, self: entry.self })) : trace;
	result.check(trace.present, `the helper log ${helperLog} could not be read, so this case holds no evidence about which program ran`);
	// A version probe is the SDK's own `commandExists`, and a program the download installed is never asked for one:
	// `ensureTool` returns the path it just wrote, and a later child finds it in the child bin without a probe. So the
	// expected sequence is one `invoke` per requested tool and no `version` line anywhere.
	const expectedTrace = expectUnavailable ? [] : helpers.map((tool) => `invoke:${tool}:${P7_DOWNLOAD_TOKEN}`);
	result.check(
		p7TraceShape(trace.entries).join(" ") === expectedTrace.join(" "),
		`the helper fixtures recorded ${JSON.stringify(p7TraceShape(trace.entries))} rather than exactly ${JSON.stringify(expectedTrace)}`,
	);
	result.observations.helperEventsByKind = { version: trace.entries.filter((entry) => entry.event === "version").length, invoke: trace.entries.filter((entry) => entry.event === "invoke").length };
	const arrivals = ctx.p7.release.requests.slice(arrivalsBefore);
	result.observations.releaseRequests = arrivals.map((one) => ({ path: one.path, kind: one.kind }));
	result.check(arrivals.every((one) => one.kind !== "unexpected"), `the release listener was asked for a path it does not serve: ${JSON.stringify(result.observations.releaseRequests)}`);
	p7CheckEnvironment(result, run, { offline: offline === false ? null : offline, search: ctx.p7.utilityDir });
	checkFetchLog(result, run.fetchLog, caller, { expectAllowed: "some" });
	const owned = [originOf(ctx.server.baseUrl), ctx.p7.release.origin, ...(catalog === undefined ? [] : [catalog.origin])];
	result.observations.requestOrigins = [...new Set(fetchRecords(run.fetchLog, caller).filter((record) => record.event === "allowed").map((record) => record.origin))].sort();
	result.check(
		result.observations.requestOrigins.every((origin) => owned.includes(origin)),
		`the call reached ${JSON.stringify(result.observations.requestOrigins)}, and it owns only ${JSON.stringify(owned)}`,
	);
	return { run, trace, arrivals, interposerLog };
}

/** Where a call's own helpers can be, bound after the fact to what the production helpers resolved for that call. */
function p7CheckLocations(result, run, where) {
	result.observations.productionLocations = {
		hostBinDir: run.observations.launch?.hostBinDir ?? null,
		childAgentDir: run.observations.storage?.agentDir ?? null,
		childBinComputed: where.childBin,
		hostBinComputed: where.hostBin,
	};
	result.check(
		run.observations.launch?.hostBinDir === where.hostBin,
		`this case computed ${where.hostBin} as the host helper bin and the production launch resolved ${JSON.stringify(run.observations.launch?.hostBinDir)}`,
	);
	result.check(
		typeof run.observations.storage?.agentDir === "string" && path.join(run.observations.storage.agentDir, "bin") === where.childBin,
		`this case computed ${where.childBin} as the child's own helper bin and the production storage prepared the child agent directory ${JSON.stringify(run.observations.storage?.agentDir)}`,
	);
	result.check(fs.existsSync(where.hostBin) === false, `the host agent directory's own bin ${where.hostBin} exists, and no case in this half may offer a child a helper there`);
}

/** The bin a call's child installs into, and the host bin it must never find one in, for one case's own profile. */
const p7Where = (dirs) => ({
	childBin: path.join(dirs.profile, FUSION_MANAGED_DIR, "children", "bin"),
	hostBin: path.join(dirs.profile, "bin"),
});

/** Nothing a lookup could answer with, under every name the SDK tries, before a case that is about a download. */
function p7CheckNoHelper(result, ctx, where, tools, key = "beforeCall") {
	const search = ctx.p7.utilityDir;
	const found = {};
	for (const name of tools) {
		found[name] = { onPath: p7Lookup(name, search) ?? null, inChildBin: fs.existsSync(path.join(where.childBin, name)), inHostBin: fs.existsSync(path.join(where.hostBin, name)) };
		result.check(
			found[name].onPath === null && found[name].inChildBin === false && found[name].inHostBin === false,
			`${name} was already available before this case ran: ${JSON.stringify(found[name])}`,
		);
	}
	result.observations[key] = found;
}

/** A downloaded program, compared with the archive member it came out of, and the bin it is the only thing in. */
function p7CheckInstalled(result, ctx, where, tools, key = "installed") {
	const installed = {};
	for (const tool of tools) {
		const file = path.join(where.childBin, tool);
		const archived = ctx.p7.releases.archives[tool];
		installed[tool] = { ...p7Fingerprint(file), expectedSha: archived.stagedSha };
		result.check(installed[tool].present === true, `no ${tool} was installed at ${file}: ${JSON.stringify(installed[tool])}`);
		result.check(installed[tool].sha === archived.stagedSha, `the installed ${tool} is not the program the archive carried: ${JSON.stringify(installed[tool])}`);
		result.check(installed[tool].mode === "755", `the installed ${tool} is mode ${JSON.stringify(installed[tool].mode)} rather than the 0755 the SDK chmods it to, from the 0600 it was archived at`);
	}
	result.observations[key] = installed;
	// Nothing else in that directory: the archive the SDK wrote there and the unique extraction directory it made are
	// both removed by its own cleanup, so a leftover of either is a finding rather than a detail.
	const entries = fs.existsSync(where.childBin) ? fs.readdirSync(where.childBin).sort() : null;
	result.observations[`${key}BinEntries`] = entries;
	result.check(JSON.stringify(entries) === JSON.stringify([...tools].sort()), `the child's bin holds ${JSON.stringify(entries)} rather than exactly ${JSON.stringify([...tools].sort())}, so an archive or an extraction directory was left behind`);
}

/**
 * Cases B1, B2 and B3, in one sequence on **one** profile and one stable child bin, because that is what they are
 * about: a child that downloads rg, then a second one that downloads fd beside it without disturbing it, then a third
 * that runs both offline and asks for nothing. Nothing is copied, seeded or re-warmed between them; each is its own
 * counted case, its own child and its own call directory.
 */
async function caseP7DownloadSequence(ctx, catalog) {
	const results = [];
	const dirs = ctx.setupCase("P7-helper-download");
	const where = p7Where(dirs);

	const first = implResult("P7-helper-rg-download-fallback", P7_CASES["P7-helper-rg-download-fallback"], [
		"PI_OFFLINE is absent, which is the only state the SDK's helper path treats as downloadable, and the catalog a child would then refresh is a loopback listener this harness owns",
		"the whole install is the SDK's own: this fixture serves a 302 and one archive at two mapped urls, and nothing here imports, stubs or replaces the tool manager or puts a program where a lookup would find one",
	]);
	p7CheckNoHelper(first, ctx, where, P7_ABSENT_HELPERS);
	first.check(fs.existsSync(where.childBin) === false, `${where.childBin} existed before the first download case ran`);
	const rgRun = await p7DownloadCall(ctx, { dirs, result: first, caller: "P7-helper-rg-download", helpers: ["rg"], offline: false, catalog });
	p7CheckLocations(first, rgRun.run, where);
	// The program that answered, by the `$0` the child started it as: the absolute path inside its own bin. `self` is
	// the staged path the archive was built from, which is what says the bytes came out of this fixture's own archive.
	first.observations.invokedAs = rgRun.trace.entries.map((entry) => ({ tool: entry.tool, argv0: entry.argv0, self: entry.self }));
	first.check(
		rgRun.trace.entries.every((entry) => entry.argv0 === path.join(where.childBin, entry.tool)),
		`the child started a helper as ${JSON.stringify(rgRun.trace.entries.map((entry) => entry.argv0))} rather than the program in its own bin`,
	);
	first.check(
		rgRun.trace.entries.every((entry) => entry.self === ctx.p7.releases.archives[entry.tool].program),
		`a helper line named a program this fixture did not archive: ${JSON.stringify(rgRun.trace.entries.map((entry) => entry.self))}`,
	);
	first.check(rgRun.trace.entries.every((entry) => entry.search === rgRun.run.observations.launch?.childPath), "a helper saw a search path that is not the one the launch composed for this child");
	first.check(
		rgRun.arrivals.map((one) => `${one.kind}:${one.path}`).join(" ") === `latest:${ctx.p7.releases.archives.rg.latestPath} asset:${ctx.p7.releases.archives.rg.downloadPath}`,
		`the release listener saw ${JSON.stringify(rgRun.arrivals.map((one) => one.path))} rather than exactly this helper's own release page and asset`,
	);
	p7CheckInterposer(first, rgRun.interposerLog, "P7-helper-rg-download", {
		expectedUrls: ctx.p7.releases.urls,
		expectMapped: [ctx.p7.releases.archives.rg.latestUrl, ctx.p7.releases.archives.rg.downloadUrl],
	});
	p7CheckInstalled(first, ctx, where, ["rg"]);
	checkManagedCall(first, rgRun.run.observations, {
		dirs,
		diffs: rgRun.run.diffs,
		expectSharedAuth: true,
		// The two exact managed-relative paths this download creates, in the spelling a snapshot diff uses: the bin
		// itself and the one program in it. Two entries rather than one allowance covering both.
		helperArtifacts: ["children/bin", "children/bin/rg"],
	});
	results.push(first);

	const second = implResult("P7-helper-fd-download-fallback", P7_CASES["P7-helper-fd-download-fallback"], [
		"the same profile and the same stable child bin as the case above, with nothing copied, re-seeded or re-warmed between the two children",
		"fd is looked up under both names the SDK tries, fd and fdfind, and neither is anywhere on this child's search path",
	]);
	const rgBefore = p7Fingerprint(path.join(where.childBin, "rg"));
	second.observations.rgBeforeThisCall = rgBefore;
	second.check(rgBefore.present === true && rgBefore.mode === "755", `the rg the case above installed is not in place for this one: ${JSON.stringify(rgBefore)}`);
	p7CheckNoHelper(second, ctx, where, ["fd", "fdfind"]);
	const fdRun = await p7DownloadCall(ctx, { dirs, result: second, caller: "P7-helper-fd-download", helpers: ["fd"], offline: false, catalog });
	p7CheckLocations(second, fdRun.run, where);
	second.check(
		fdRun.trace.entries.every((entry) => entry.argv0 === path.join(where.childBin, entry.tool)),
		`the child started a helper as ${JSON.stringify(fdRun.trace.entries.map((entry) => entry.argv0))} rather than the program in its own bin`,
	);
	second.check(
		fdRun.arrivals.map((one) => `${one.kind}:${one.path}`).join(" ") === `latest:${ctx.p7.releases.archives.fd.latestPath} asset:${ctx.p7.releases.archives.fd.downloadPath}`,
		`the release listener saw ${JSON.stringify(fdRun.arrivals.map((one) => one.path))} rather than exactly fd's own release page and asset`,
	);
	p7CheckInterposer(second, fdRun.interposerLog, "P7-helper-fd-download", {
		expectedUrls: ctx.p7.releases.urls,
		expectMapped: [ctx.p7.releases.archives.fd.latestUrl, ctx.p7.releases.archives.fd.downloadUrl],
	});
	p7CheckInstalled(second, ctx, where, ["fd", "rg"]);
	const rgAfter = p7Fingerprint(path.join(where.childBin, "rg"));
	second.observations.rgAfterThisCall = rgAfter;
	second.check(JSON.stringify(rgAfter) === JSON.stringify(rgBefore), `the second download rewrote the rg beside it: ${JSON.stringify(rgAfter)}`);
	checkManagedCall(second, fdRun.run.observations, {
		dirs,
		diffs: fdRun.run.diffs,
		expectSharedAuth: true,
		// The bin is already there from the case above, so this call creates exactly one path.
		helperArtifacts: ["children/bin/fd"],
	});
	results.push(second);

	const third = implResult("P7-helper-download-reuse", P7_CASES["P7-helper-download-reuse"], [
		"a third child on the same stable bin with PI_OFFLINE=1, so no download is possible in this case at all: what it measures is reuse",
		"both programs are found in the child's own bin, which is the one place the SDK's lookup tries before a PATH search, so neither is asked for its version",
	]);
	const beforeReuse = p7Fingerprints(P7_HELPERS.map((tool) => path.join(where.childBin, tool)));
	third.observations.helpersBeforeThisCall = beforeReuse;
	third.check(Object.values(beforeReuse).every((one) => one.present === true && one.mode === "755"), `the two downloaded helpers are not both in place for this case: ${JSON.stringify(beforeReuse)}`);
	const reuseRun = await p7DownloadCall(ctx, { dirs, result: third, caller: "P7-helper-reuse", helpers: ["rg", "fd"], offline: "1" });
	p7CheckLocations(third, reuseRun.run, where);
	third.check(
		reuseRun.trace.entries.every((entry) => entry.argv0 === path.join(where.childBin, entry.tool)),
		`a helper was started as ${JSON.stringify(reuseRun.trace.entries.map((entry) => entry.argv0))} rather than the program in the child's own bin`,
	);
	third.check(reuseRun.arrivals.length === 0, `an offline child asked this fixture's release listener ${reuseRun.arrivals.length} time(s)`);
	p7CheckInterposer(third, reuseRun.interposerLog, "P7-helper-reuse", { expectedUrls: ctx.p7.releases.urls, expectMapped: [] });
	const afterReuse = p7Fingerprints(P7_HELPERS.map((tool) => path.join(where.childBin, tool)));
	third.observations.helpersAfterThisCall = afterReuse;
	third.check(JSON.stringify(afterReuse) === JSON.stringify(beforeReuse), `a reused helper changed across the call: ${JSON.stringify(afterReuse)}`);
	p7CheckInstalled(third, ctx, where, ["fd", "rg"], "stillInstalled");
	checkManagedCall(third, reuseRun.run.observations, { dirs, diffs: reuseRun.run.diffs, expectSharedAuth: true });
	results.push(third);
	return results;
}

/**
 * Cases B4, B5 and B6: the three `PI_OFFLINE` values the SDK's **helper** path parses, each against a fresh profile,
 * a fresh child bin and a helper-free search path. `1` is the only one of them that is true to it, so that child has no
 * helper at all and its grep call comes back as the tool's own error rather than as a refused startup; `0` and an empty
 * string are both false to it, so those two children download and work. Beside them the model runtime reads the same
 * variable as presence rather than truth, which is why none of the three refreshes a catalog and why none of them needs
 * one: the matrix in the first half of this group is what measured that, and this half inherits it.
 */
async function caseP7HelperOfflineMatrix(ctx) {
	const results = [];
	for (const [name, caller, value, note] of [
		["P7-helper-offline-one-refuses", "P7-helper-offline-one", "1", "the one value the SDK's helper path reads as true, beside `true` and `yes`"],
		["P7-helper-offline-zero-downloads", "P7-helper-offline-zero", "0", "a false-looking value, which that path reads as false although the model runtime reads it as present"],
		["P7-helper-offline-empty-downloads", "P7-helper-offline-empty", "", "an empty value, which that path reads as false as well and which reaches the child as an empty string"],
	]) {
		const dirs = ctx.setupCase(caller);
		const where = p7Where(dirs);
		const result = implResult(name, P7_CASES[name], [
			`PI_OFFLINE=${JSON.stringify(value)}: ${note}`,
			"a fresh profile and a fresh child bin of its own, a helper-free constructed search path and no host helper bin, so what this case measures is the download decision and nothing else",
			"the value is measured for rg alone; fd reads the same variable through the same function in the same source, and no separate measurement of it is claimed here",
			"the variable is present, so no catalog refresh is possible and this case names no catalog listener: an attempt at one would leave this fixture's own origins and be blocked by the guard",
		]);
		p7CheckNoHelper(result, ctx, where, P7_ABSENT_HELPERS);
		const unavailable = value === "1";
		const run = await p7DownloadCall(ctx, { dirs, result, caller, helpers: ["rg"], offline: value, expectUnavailable: unavailable });
		p7CheckLocations(result, run.run, where);
		if (unavailable) {
			result.check(run.arrivals.length === 0, `an offline child asked this fixture's release listener ${run.arrivals.length} time(s)`);
			p7CheckInterposer(result, run.interposerLog, caller, { expectedUrls: ctx.p7.releases.urls, expectMapped: [] });
			result.observations.childBinAfter = fs.existsSync(where.childBin) ? fs.readdirSync(where.childBin).sort() : null;
			result.check(result.observations.childBinAfter === null, `a child that could not download anything created ${where.childBin}: ${JSON.stringify(result.observations.childBinAfter)}`);
			checkManagedCall(result, run.run.observations, { dirs, diffs: run.run.diffs, expectSharedAuth: true });
		} else {
			result.check(
				run.arrivals.map((one) => `${one.kind}:${one.path}`).join(" ") === `latest:${ctx.p7.releases.archives.rg.latestPath} asset:${ctx.p7.releases.archives.rg.downloadPath}`,
				`the release listener saw ${JSON.stringify(run.arrivals.map((one) => one.path))} rather than exactly rg's own release page and asset`,
			);
			p7CheckInterposer(result, run.interposerLog, caller, {
				expectedUrls: ctx.p7.releases.urls,
				expectMapped: [ctx.p7.releases.archives.rg.latestUrl, ctx.p7.releases.archives.rg.downloadUrl],
			});
			result.check(
				run.trace.entries.every((entry) => entry.argv0 === path.join(where.childBin, entry.tool)),
				`the child started a helper as ${JSON.stringify(run.trace.entries.map((entry) => entry.argv0))} rather than the program in its own bin`,
			);
			p7CheckInstalled(result, ctx, where, ["rg"]);
			checkManagedCall(result, run.run.observations, { dirs, diffs: run.run.diffs, expectSharedAuth: true, helperArtifacts: ["children/bin", "children/bin/rg"] });
		}
		results.push(result);
	}
	return results;
}

/* ---- P7, third half: two children, one shared bin, and one model-issued search call each (step 4, task 5) --------- */

/*
 * What the two cases below measure, and what nothing above them does. Every download case so far is one child at a
 * time: it has the stable `children/bin` to itself, and the SDK's own installer runs from its first request to its own
 * cleanup with nothing else in that directory. The obligation this half closes is the other one — two real children
 * reaching **one** shared bin for the **same** helper at the same time, each on its first use of it. The installed
 * source names a per-process extraction directory for exactly this reason and still writes the downloaded archive to
 * one fixed shared pathname, `<bin>/<asset-name>`, which it removes in its own `finally`. That is a read of the source
 * and a risk, not a measured failure; what these cases do is put two real children through one controlled interleaving
 * of it and record what each one's model-issued search call came back as.
 *
 * What these cases are measured against now, and what they were measured against before. The first qualification of
 * this half was run before any recovery existed and its gate was each child's **first underlying attempt** succeeding; it
 * **failed**, with the held child answered by the tool's own unavailable sentence, and that measurement remains in
 * Git history. Current behavior and qualification limits are in [the Pi backend docs](../../docs/pi-backend.md).
 * The approved **bounded recovery** — which repairs nothing about the SDK's shared-archive race and does not claim to — is
 * not in the SDK and not in this harness: it is `extensions/backends/pi-helper-retry.mjs` in production, which wraps the
 * public builtin `grep` and `find` definitions so **one model-issued tool call** may make **at most two** underlying
 * builtin attempts, retrying once on that exact sentence alone. So the gate here is now one model-issued tool call per
 * child, **both succeeding**, with the fast child A carrying **no** retry notice and the held child B **exactly one**.
 *
 * What that notice is evidence of, precisely. It is the production wrapper's own fixed text, sent through the public
 * tool-update path, so one of them in B's stream says the wrapper reached its matching-acquisition-failure branch before
 * it recovered — B's first underlying attempt **failed**, and that failure stays visible here rather than being relabelled
 * as a first-attempt success. What it is **not**: an observation of the underlying syscall, the operation that failed or
 * its root cause, and not an independent count of two executions either — the native stream reports one tool execution
 * for one tool call. The at-most-two bound is established by the wrapper's own source and its fake tests in
 * `test/pi-helper-retry.test.ts` and `test/pi-bootstrap.test.ts`, not by anything measurable from here. Nothing in this
 * harness mocks that failure, overrides production, retries at the controller or the model level, or scripts a second
 * tool call that could rescue a child.
 *
 * What such a case can and cannot attribute. Interference at that one shared pathname is observable here — this harness
 * reads that name's own presence, size and inode from the owned bin, per process and per handshake. Which operation
 * inside the SDK then failed is **not** directly observed and is not claimed by these cases: a stream or pipeline
 * failure, an extraction, a lookup of the extracted binary and a publication into the bin can all end in the same
 * generic "could not be downloaded" text, because `grep` and `find` call `ensureTool` without an `onStatus` callback, so
 * whatever reason it had does not surface anywhere a child's own tool result could carry it. Nothing here instruments
 * the SDK, reads an open descriptor or traces a syscall, and a failing operation named from the source stays a
 * source-supported candidate rather than a measurement.
 *
 * The interleaving, and why it is a handshake rather than a stress loop. Each child gets a release listener of its own
 * — its own loopback origin, its own allow-list entry, the same two exact urls mapped through the same interposer —
 * so every request is attributed by the listener it arrived at rather than by a header this harness would have had to
 * add. The two listeners share one gate object per case, and the case answers them itself:
 *
 *   1. both children are constructed and readied one at a time, and only then are both prompts sent, so nothing here
 *      measures two sessions being built at once;
 *   2. both release pages have to arrive before either is answered, and both 302s are then released together, which is
 *      what says both children looked a helper up and found none before either could have installed one;
 *   3. both asset requests have to arrive before either is answered, which is what says both are inside the same first
 *      use, and both have created the one shared bin by then;
 *   4. an `fs.watch` observer is installed on that bin alone, then the **held** child B is sent valid headers with the
 *      full content length and a short nonzero prefix of the body, and the archive is required to reach exactly that
 *      size before anything else happens;
 *   5. only then is child A's complete body sent, and A's own first `tool_execution_end` is waited for — the point at
 *      which the source has A removing the shared pathname in its own `finally` while B's stream is still open;
 *   6. one tool execution from A and none from B is asserted, because the wait below answers with the first event of its
 *      type a child has already produced, and only then is B's remainder released and B's own first
 *      `tool_execution_end` waited for.
 *
 * All of it is ordinary HTTP response timing at listeners this harness owns. Nothing here edits a file under a child,
 * holds a lock, patches the SDK, simulates a tool error, retries a call or seeds a helper, and every bound has an
 * unconditional release of every held response behind it, so a missed handshake ends the case rather than leaving a
 * child or a listener hanging. Each ordering above is an assertion that ends the sequence rather than a recorded failure
 * the steps after it would run on regardless, and the two harness causes are told apart in the report: a bound this
 * harness set and did not reach, and an ordering it asserted and did not get. Neither is read as a helper failure.
 *
 * What the acceptance is, deliberately: **both** model-issued search calls succeed, with the exact result text a
 * downloaded program answers with, the exact program in the shared bin and nothing left beside it, A carrying zero retry
 * notices and B exactly one. One child succeeding while the other comes back with the tool's own unavailable error is a
 * **failure** of the case even though a healthy helper is in the bin at the end, because what is measured is each
 * child's own call and not the directory's final state. A child that needed the bounded recovery is not a pass of the
 * old first-attempt gate and is never reported as one, and a case with no notice in B's stream is not a quiet success
 * either: the acceptance names that count exactly, in both directions.
 */

/** How long the second release page may take to arrive after the first, strictly below the SDK's own 10s bound. */
const P7_CONCURRENT_LATEST_GAP_MS = 8_000;
/** How long the two asset requests may take to arrive once both release pages were answered together. */
const P7_CONCURRENT_ASSET_GAP_MS = 8_000;
/** How long the observer may take to see the held child's prefix in the shared bin before the other child is let go. */
const P7_CONCURRENT_PREFIX_DEADLINE_MS = 10_000;
/** How long a child may take to end its one tool execution once its own body was completed. */
const P7_CONCURRENT_TOOL_DEADLINE_MS = 30_000;
/** The whole hold on the slow child, kept well inside `DOWNLOAD_TIMEOUT_MS` (120s) in the installed source. */
const P7_CONCURRENT_HOLD_LIMIT_MS = 100_000;
/**
 * The two roles a case pairs, and which of them is the child whose body is completed first. Two different roles rather
 * than the same one twice, because a shared bin is shared across roles as well; both of them run Pi's `grep` and `find`
 * tools in this build, and `ask` runs under a contract of its own, which is what the second contract file below is.
 */
const P7_CONCURRENT_PAIR = {
	a: { role: "implement", contract: "implement.md", contractFile: CONTRACT_FILE, note: "the child whose body is completed first" },
	b: { role: "ask", contract: "ask-answer.md", contractFile: ASK_CONTRACT_FILE, note: "the child whose body is held open across the other one's whole install" },
};

/**
 * The gate two release listeners of one case share: the arrivals, in the order they happened, and a way to wait for a
 * number of them without sleeping. It answers nothing and holds no response of its own — a listener records into it
 * and the case decides what to answer — so what it settles is only **when** the case may act.
 */
function p7ConcurrentGate(label) {
	const arrivals = [];
	const waiters = [];
	const settle = () => {
		for (const waiter of [...waiters]) {
			const seen = arrivals.filter((one) => one.kind === waiter.kind);
			if (seen.length < waiter.count) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(seen.slice(0, waiter.count));
		}
	};
	return {
		label,
		arrivals,
		/** Called by a listener the instant a request arrives, and before any part of it is answered. */
		record: (kind, who, requestPath) => {
			const record = { kind, who, path: requestPath, at: Date.now() };
			arrivals.push(record);
			settle();
			return record;
		},
		/** Settles when `count` requests of that kind have arrived, and rejects when the bound passes. Never polls. */
		reach: (kind, count, deadlineMs) =>
			new Promise((resolve, reject) => {
				const waiter = { kind, count, resolve: undefined };
				const timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1);
					reject(new Error(`${label}: ${arrivals.filter((one) => one.kind === kind).length} of ${count} ${kind} request(s) arrived within ${deadlineMs}ms`));
				}, deadlineMs);
				waiter.resolve = (seen) => {
					clearTimeout(timer);
					resolve(seen);
				};
				waiters.push(waiter);
				settle();
			}),
	};
}

/**
 * One child's own release listener: the same two paths `startReleaseServer` serves for that helper, with the same
 * bytes, and one difference that is the whole point — it answers **nothing** by itself. Every arrival is recorded into
 * the case's gate and held, and the case writes the redirect, the headers, a prefix and the remainder itself. That is
 * what makes the order two downloads reach one shared bin in this case's own rather than the scheduler's.
 *
 * `releaseHeld` is the unconditional cleanup every bound below is wrapped in: a held response that is never answered
 * would leave a child waiting for its own 120s download bound and a listener with an open socket, so a missed
 * handshake destroys both held responses rather than hoping the case's later steps run.
 */
async function startPairedReleaseServer({ label, who, archive, gate }) {
	const requests = [];
	const served = [];
	const held = { latest: undefined, asset: undefined };
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const kind = url.pathname === archive.latestPath ? "latest" : url.pathname === archive.downloadPath ? "asset" : "unexpected";
		const record = { label, who, method: req.method, path: url.pathname, kind, at: Date.now() };
		requests.push(record);
		if (kind === "unexpected") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: `this listener serves one helper's two release urls and nothing else; ${url.pathname} is not one of them` }));
			return;
		}
		if (held[kind] !== undefined) {
			// One request of each kind per child is what the whole interleaving is written against: a second one would
			// be a retry nothing here asked for, and answering it would hide that.
			record.kind = "repeat";
			res.writeHead(409, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: `this listener already holds a ${kind} request from ${who}` }));
			return;
		}
		held[kind] = res;
		gate.record(kind, who, url.pathname);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const responseFor = (kind) => {
		const response = held[kind];
		if (response === undefined) throw new Error(`${label}: no ${kind} request has arrived, so there is nothing to answer`);
		return response;
	};
	const mark = (event, extra = {}) => {
		served.push({ event, at: Date.now(), ...extra });
		return served[served.length - 1];
	};
	return {
		label,
		who,
		origin: `http://127.0.0.1:${port}`,
		requests,
		/** Every byte this listener released and when, which is the case's own account of the interleaving. */
		served,
		/** The manual 302 the SDK's own release lookup reads, written when the case says so and not before. */
		releaseLatest: () => {
			const response = responseFor("latest");
			response.writeHead(302, { location: archive.tagLocation, "content-type": "text/html; charset=utf-8" });
			response.end("<html><body>spike fixture redirect</body></html>");
			return mark("latest-released");
		},
		/** Valid headers with the whole body's own length: what follows them is a real stream, not a truncated answer. */
		assetHeaders: () => {
			const response = responseFor("asset");
			response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(archive.body.length) });
			return mark("asset-headers", { contentLength: archive.body.length });
		},
		/** A short nonzero prefix of the same bytes, with the rest of the stream still open. */
		assetPrefix: (bytes) => {
			responseFor("asset").write(bytes);
			return mark("asset-prefix", { bytes: bytes.length });
		},
		/** Everything from `from` on, and the end of the stream. `from` is 0 for the child that is never held. */
		assetRest: (from) => {
			responseFor("asset").end(archive.body.subarray(from));
			return mark("asset-rest", { bytes: archive.body.length - from, from });
		},
		/**
		 * Unconditional: nothing may stay held because a bound was missed, whatever else the case then reports. Safe to
		 * call twice — a response that was answered or already destroyed is skipped, so a second call records nothing and
		 * an empty list means nothing was still held rather than that this was never reached.
		 */
		releaseHeld: () => {
			const destroyed = [];
			for (const [kind, response] of Object.entries(held)) {
				if (response === undefined || response.writableEnded || response.destroyed) continue;
				try {
					response.destroy();
					destroyed.push(kind);
				} catch {
					// Already gone with its own socket: a child that reached its own bound took it.
				}
			}
			if (destroyed.length) mark("held-released", { kinds: destroyed });
			return destroyed;
		},
		close: () =>
			new Promise((resolve) => {
				for (const response of Object.values(held)) {
					try {
						response?.destroy();
					} catch {
						// Nothing to do about a response whose socket is already gone.
					}
				}
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** The shared archive's own state, read from the owned bin alone: presence, size and the inode the name points at. */
function p7ArchiveState(file) {
	try {
		const stats = fs.statSync(file);
		return { present: true, bytes: stats.size, ino: stats.ino };
	} catch (error) {
		return { present: false, code: error?.code ?? String(error) };
	}
}

/**
 * The observer on the shared bin, and only on it: one `fs.watch` on that directory, an immediate read of the archive's
 * state so an event that happened before this call cannot be missed, and another read on every event. `reaches` settles
 * from the state now or from a later event and never sleeps or polls. Events can coalesce, so the event list is
 * best-effort evidence; what a case asserts on is the state at its own handshakes.
 *
 * What the size and inode in it are: this process's own readings of one pathname at the moments it read them. A sequence
 * of them is evidence that the name was interfered with, and it is not an attribution of which child performed which
 * operation on it — nothing here holds a descriptor, and no reading names a writer.
 */
function p7WatchBin(binDir, archivePath) {
	const events = [];
	const listeners = new Set();
	const check = (why, name) => {
		const state = p7ArchiveState(archivePath);
		events.push({ why, name: name ?? null, at: Date.now(), ...state });
		for (const listener of [...listeners]) listener(state);
		return state;
	};
	const watcher = fs.watch(binDir, (eventType, filename) => check(eventType, filename));
	const initial = check("installed");
	return {
		events,
		initial,
		state: () => p7ArchiveState(archivePath),
		entries: () => (fs.existsSync(binDir) ? fs.readdirSync(binDir).sort() : null),
		reaches: (bytes, deadlineMs) =>
			new Promise((resolve, reject) => {
				let done = false;
				const listener = (state) => {
					if (done || !(state.present && state.bytes === bytes)) return;
					done = true;
					clearTimeout(timer);
					listeners.delete(listener);
					resolve(state);
				};
				const timer = setTimeout(() => {
					done = true;
					listeners.delete(listener);
					reject(new Error(`the shared archive ${archivePath} did not reach ${bytes} byte(s) within ${deadlineMs}ms: ${JSON.stringify(p7ArchiveState(archivePath))}`));
				}, deadlineMs);
				// The state now, before anything is awaited, so a write that landed before this call is still seen.
				listener(p7ArchiveState(archivePath));
				if (!done) listeners.add(listener);
			}),
		close: () => watcher.close(),
	};
}

/**
 * One child of a concurrent case. `p5Run` drives a child from its launch to its disposal, which two children that have
 * to be inside one first use at the same time cannot both be inside; so this uses the pair mechanics `P4` uses for the
 * same reason — `implEnv`, `callSpec`, `startCaller`, `probeChild` and `finishCaller` directly — with this group's own
 * environment around them. The accounting `p5Run` does is repeated by `p7ConcurrentCount` rather than approximated, so
 * this group's counters still mean what they meant before, and the `progress` record below is what makes that possible:
 * `p5Run` counts a call as answered when its own drive ran to the end, whatever the checks in it then reported, so this
 * tracks the same four RPC operations here rather than substituting a tool outcome for them.
 */
function p7ConcurrentCall(ctx, { dirs, result, caller, key, pair, tool, release, offline }) {
	const fetchLog = path.join(dirs.caseRoot, `fetch-${caller}.log`);
	const helperLog = path.join(dirs.caseRoot, `helpers-${caller}.log`);
	const interposerLog = path.join(dirs.caseRoot, `interposer-${caller}.log`);
	const observationsFile = path.join(dirs.caseRoot, `caller-${caller}.json`);
	const specFile = path.join(dirs.caseRoot, `call-${caller}.json`);
	// Both created empty, for the same reason every other case in this half creates them: "this program was never
	// invoked" and "this url was never mapped" have to be readable logs with no line in them.
	write(helperLog, "");
	write(interposerLog, "");
	const rootReal = fs.realpathSync(ctx.root);
	for (const [what, file] of [["helper log", helperLog], ["interposer log", interposerLog], ["fetch log", fetchLog]]) {
		if (!path.resolve(file).startsWith(`${rootReal}${path.sep}`)) throw new Error(`the ${what} ${file} is outside the temp root ${rootReal}`);
	}
	const sentinel = `${P7_SEARCH_SENTINEL}-${caller}`;
	// Exactly one model-issued tool call and one final text: no follow-up step exists in this script, so no second tool
	// call can rescue a child, and a third model request would be answered as `exhausted` and read as one.
	const toolCallId = `call_${caller}`;
	ctx.server.script(sentinel, [
		{ kind: "tool_call", name: P7_HELPER_TOOLS[tool].tool, toolName: P7_HELPER_TOOLS[tool].tool, arguments: P7_HELPER_TOOLS[tool].args, toolCallId },
		{ kind: "text", name: "final", text: ANSWER },
	]);
	const role = { name: pair.role, model: `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`, effort: "medium", contract: pair.contract };
	const env = implEnv(ctx.root, {
		agentDir: dirs.profile,
		sessionDir: dirs.sessions,
		caller,
		// This child's own listener and the model server, and nothing else: a request to the other child's listener
		// would be blocked by the guard and recorded, which is what makes the attribution by listener worth anything.
		origins: [originOf(ctx.server.baseUrl), release.origin],
		fetchLog,
		offline,
		extra: { PATH: ctx.p7.utilityDir },
		rawExtra: { [P7_HELPER_LOG_VARIABLE]: helperLog },
		interposer: { origin: release.origin, urls: ctx.p7.releases.urls, log: interposerLog },
	});
	let child;
	let closing;
	// One fact per RPC operation, each set only once that operation has resolved: the probes, the accepted prompt, the
	// settlement and the last-text read. `answered()` is their conjunction and nothing else — it says this call's drive
	// completed, not that its result checks or its helper tool succeeded, which is exactly what `p5Run` counts.
	const progress = { probed: false, promptReturned: false, settled: false, lastText: false };
	return {
		caller,
		key,
		sentinel,
		toolCallId,
		role,
		release,
		fetchLog,
		helperLog,
		interposerLog,
		env,
		progress,
		answered: () => progress.probed && progress.promptReturned && progress.settled && progress.lastText,
		/** The launch and the three non-task probes, one child at a time: no case here measures a contended startup. */
		start: async () => {
			child = startCaller(specFile, callSpec({ dirs, caller, handle: caller, role, session: { kind: "new" }, observations: observationsFile, contractFile: pair.contractFile }), { cwd: dirs.project, env });
			const probed = await probeChild(child, result, { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, effort: "medium", key: `${key}Probe` });
			progress.probed = true;
			return probed;
		},
		// The send itself happens before this returns its promise, so two prompts started in one turn still leave neither
		// child a head start; the flag is set once the child's own response to it has come back.
		prompt: async () => {
			const answer = await child.send({ type: "prompt", message: `${sentinel} search this project and list its files.` });
			progress.promptReturned = true;
			return answer;
		},
		firstToolEnd: (deadlineMs) => child.waitFor("tool_execution_end", deadlineMs),
		settled: async (deadlineMs) => {
			const event = await child.waitFor("agent_settled", deadlineMs);
			progress.settled = true;
			return event;
		},
		lastText: async () => {
			const text = await child.send({ type: "get_last_assistant_text" });
			progress.lastText = true;
			return text;
		},
		toolEnds: () =>
			child.events
				.filter((event) => event.type === "tool_execution_end")
				.map((event) => ({ toolName: event.toolName, isError: event.isError, text: event.result?.content?.[0]?.text ?? null })),
		/**
		 * This child's own event stream as it arrived, in order, for the retry-notice evidence below. It is the same list
		 * `toolEnds` and `waitFor` already read — no second collector, no observer of its own and nothing subscribed here.
		 */
		events: () => (child === undefined ? [] : [...child.events]),
		/** This child's own model requests, by the sentinel only its own conversation carries. */
		requests: () => ctx.server.requests.filter((one) => one.script === sentinel),
		trace: () => p7HelperTrace(helperLog),
		// Memoized, and defensive twice over: a start that threw before the controller was spawned must not turn into a
		// second failure here, and the ordered closes on the normal path and the unconditional cleanup behind every path
		// both call this, so one controller is ended once and both callers read the same answer.
		close: () => {
			if (closing === undefined) closing = child === undefined ? Promise.resolve({ exit: null, observations: { missing: true }, stderr: "" }) : finishCaller(child, observationsFile);
			return closing;
		},
	};
}

/** `p5Run`'s own accounting for a call this half made without it, so one group's totals still mean one thing. */
function p7ConcurrentCount(counters, finished, { answered }) {
	const diagnostics = bootstrapDiagnostics(finished.stderr ?? "");
	const failure = diagnostics.find((line) => line.error !== undefined);
	const stages = diagnostics.filter((line) => line.error === undefined).map((line) => line.stage);
	counters.bootstrapInvocations += 1;
	if (stages.includes("sdk")) counters.sdkLoaded += 1;
	else if (failure?.stage === "input") counters.preSdkRefusals += 1;
	if (stages.includes("serving")) counters.serving += 1;
	if (failure !== undefined && stages.includes("sdk")) counters.refusalsAfterSdk += 1;
	if (answered) counters.rpcAnswered += 1;
	return { stages, failure: failure ?? null };
}

/** The environment facts a concurrent child is read against, under a key of its own so two children never share one. */
function p7ConcurrentEnvironment(result, key, observations, { offline, search }) {
	result.observations[key] = {
		caller: observations.env?.PI_OFFLINE ?? null,
		child: observations.launch?.childOffline ?? null,
		callerPathBefore: observations.launch?.callerPathBefore ?? null,
		childPath: observations.launch?.childPath ?? null,
		childPid: observations.childPid ?? null,
		role: observations.role?.name ?? null,
		contract: observations.role?.contract ?? null,
	};
	result.check(observations.env?.PI_OFFLINE === offline, `the caller inherited PI_OFFLINE ${JSON.stringify(observations.env?.PI_OFFLINE)} rather than ${JSON.stringify(offline)}`);
	result.check(observations.launch?.childOffline === offline, `the child was launched with PI_OFFLINE ${JSON.stringify(observations.launch?.childOffline)} rather than ${JSON.stringify(offline)}`);
	result.check(observations.launch?.callerPathBefore === search, `the caller's own PATH was ${JSON.stringify(observations.launch?.callerPathBefore)} rather than the constructed ${JSON.stringify(search)}`);
}

/**
 * What one child's **model-issued** search call came back as, read from the public tool events alone. `callOk` is that
 * call succeeding and is deliberately not called a first-use or first-attempt success: with the production wrapper in
 * place one call may have made two underlying builtin attempts, and which of those it was is read from the retry notices
 * below rather than from this result.
 */
function p7ModelCall(one, tool) {
	const ends = one.toolEnds();
	const first = ends[0];
	return {
		caller: one.caller,
		role: one.role.name,
		executions: ends.length,
		toolName: first?.toolName ?? null,
		isError: first?.isError ?? null,
		text: first?.text ?? null,
		callOk: ends.length === 1 && first?.toolName === P7_HELPER_TOOLS[tool].tool && first?.isError === false && first?.text === P7_HELPER_TOOLS[tool].result(P7_DOWNLOAD_TOKEN),
	};
}

/**
 * Which fields these two events carry is settled by source rather than guessed at: the installed public `AgentEvent`
 * union declares `tool_execution_update` with `toolCallId`, `toolName`, `args` and `partialResult`, and
 * `tool_execution_end` with `toolCallId`, `toolName`, `result` and `isError`; `AgentSessionEvent` extends that union, RPC
 * mode streams those events as they occur, and the session emits them under those names. An `RpcChild` stores each
 * parsed message verbatim, so what a case reads here is that declared shape and nothing else — no alias, no alternate
 * spelling and no protocol of this harness's own. A shape that is not that one is a **named failed check** below rather
 * than an unread event quietly counted as "no notice".
 */

/** The text blocks one update carries, from the documented `partialResult.content` alone. Never parsed, never joined. */
function p7UpdateTexts(event) {
	const texts = [];
	const content = event?.partialResult?.content;
	if (!Array.isArray(content)) return texts;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
	}
	return texts;
}

/** The tool-call id an event names, from the declared `toolCallId` alone; `null` when it is absent or not a string. */
function p7EventCallId(event) {
	return typeof event?.toolCallId === "string" ? event.toolCallId : null;
}

/**
 * One update's own shape, against the four things this case reads out of the declared union: a string `toolCallId` and
 * `toolName` to attribute it by, and a `partialResult` object carrying a `content` array to read its text from. Recorded
 * per update and checked for every child, whatever its expected notice count is, so a changed event shape fails a case
 * that expected zero notices instead of passing it by finding none.
 */
function p7UpdateShape(event) {
	const partialResult = event?.partialResult;
	const fields = {
		toolCallId: typeof event?.toolCallId === "string",
		toolName: typeof event?.toolName === "string",
		partialResult: partialResult !== null && typeof partialResult === "object" && !Array.isArray(partialResult),
		content: Array.isArray(partialResult?.content),
	};
	const missing = Object.entries(fields)
		.filter(([, ok]) => !ok)
		.map(([field]) => field);
	return { ...fields, valid: missing.length === 0, missing };
}

/**
 * The bounded recovery, as one child's own native event stream reports it. Every `tool_execution_update` is recorded with
 * the tool it names, the call it correlates to, its text blocks, its own keys and its shape against the declared fields
 * above, and a notice is one whose text is exactly the production `HELPER_RETRY_NOTICE` — never a substring, a word in it
 * or a notice this harness made. Each one is then attributed: to the helper tool this case runs, to the one scripted
 * tool-call id, and to a position before that call's own final `tool_execution_end`, which is what says the wrapper sent
 * it while the call was still running.
 *
 * What a count of one means and what it does not: the wrapper reached its matching-acquisition-failure branch once, so
 * that child's first underlying attempt failed and its second succeeded. The stream reports one execution for one call
 * either way, so nothing here counts the two attempts independently — the wrapper's source and its fake tests are what
 * bound a call to two.
 */
function p7RetryEvidence(one, tool) {
	const expectedTool = P7_HELPER_TOOLS[tool].tool;
	const events = one.events();
	const updates = [];
	const ends = [];
	for (const [index, event] of events.entries()) {
		if (event?.type === "tool_execution_update") {
			updates.push({ index, toolName: event.toolName ?? null, callId: p7EventCallId(event), texts: p7UpdateTexts(event), keys: Object.keys(event).sort(), shape: p7UpdateShape(event) });
			continue;
		}
		if (event?.type === "tool_execution_end") ends.push({ index, toolName: event.toolName ?? null, callId: p7EventCallId(event), isError: event.isError ?? null });
	}
	const notices = updates.filter((update) => update.texts.includes(HELPER_RETRY_NOTICE));
	const finalEnd = ends.find((end) => end.toolName === expectedTool) ?? ends[0] ?? null;
	const attributed = notices.filter((notice) => notice.toolName === expectedTool && notice.callId === one.toolCallId);
	return {
		caller: one.caller,
		expectedTool,
		expectedCallId: one.toolCallId,
		updates: updates.length,
		updateEvents: updates,
		notices: notices.length,
		noticeEvents: notices,
		ends,
		finalEnd,
		attributedNotices: attributed.length,
		noticesBeforeFinalEnd: finalEnd === null ? 0 : notices.filter((notice) => notice.index < finalEnd.index).length,
		attributedBeforeFinalEnd: finalEnd === null ? 0 : attributed.filter((notice) => notice.index < finalEnd.index).length,
		// Every update whose shape is not the declared one, with what it was missing and which keys it did carry: the check
		// below fails on any of these rather than letting an unread update stand for an absent notice.
		invalidUpdates: updates.filter((update) => update.shape.valid === false).map((update) => ({ index: update.index, missing: update.shape.missing, keys: update.keys })),
	};
}

/**
 * What one child's bounded recovery has to look like: `expected` notices, every one of them attributed to this case's
 * helper tool and scripted call id and sent before that call's own end. A child that needed none and a child that needed
 * one are two different expectations, and neither is allowed to pass as the other.
 */
function p7CheckRetryEvidence(result, evidence, { caller, expected, key }) {
	result.observations[key] = evidence;
	// First, and for every child whatever its expected count: each update this child sent has to be the shape the installed
	// public `AgentEvent` union declares for a `tool_execution_update`, because that is what a notice is read out of. An
	// update this reader could not read is a failure that names the fields it expected and the keys it saw, never a
	// zero-notice conclusion and never an acceptance through some other field that happened to hold the text.
	result.check(
		evidence.invalidUpdates.length === 0,
		`${caller}: ${evidence.invalidUpdates.length} of its ${evidence.updates} tool update(s) are not the shape the installed public AgentEvent union declares for a tool_execution_update — a string toolCallId, a string toolName and a partialResult object holding a content array — so no notice can be read out of them and none is inferred absent: ${JSON.stringify(evidence.invalidUpdates)}`,
	);
	result.check(
		evidence.notices === expected,
		`${caller} carried ${evidence.notices} retry notice(s) in its own event stream and this case requires exactly ${expected}: ${JSON.stringify(evidence.updateEvents)}`,
	);
	result.check(
		evidence.attributedNotices === expected,
		`${caller}: ${evidence.attributedNotices} of its retry notice(s) name ${evidence.expectedTool} and ${JSON.stringify(evidence.expectedCallId)}, and this case requires ${expected}: ${JSON.stringify(evidence.noticeEvents)}`,
	);
	result.check(
		evidence.attributedBeforeFinalEnd === expected,
		`${caller}: ${evidence.attributedBeforeFinalEnd} of its attributed notice(s) arrived before that call's own tool_execution_end, and this case requires ${expected}: ${JSON.stringify({ finalEnd: evidence.finalEnd, notices: evidence.noticeEvents })}`,
	);
}

/**
 * One concurrent case: two real children, one shared `children/bin`, one helper, and the interleaving above. Its own
 * profile, its own project and its own pair of listeners; nothing is shared with the cases above it except the release
 * archive bytes this group built once, which both listeners serve identically.
 */
async function caseP7Concurrent(ctx, tool) {
	const name = `P7-helper-concurrent-${tool}`;
	const dirs = ctx.setupCase(name);
	const where = p7Where(dirs);
	const archive = ctx.p7.releases.archives[tool];
	const archivePath = path.join(where.childBin, archive.asset);
	const result = implResult(name, P7_CASES[name], [
		"two real children on one profile and one stable child bin, each with a release listener of its own: every request is attributed by the listener it arrived at, and neither child's origin is on the other's allow list",
		"the interleaving is this case's own handshakes at those listeners — ordinary HTTP response timing — and not a stress loop, a lock, a patched SDK, a seeded helper or a simulated tool error",
		"both children are constructed and readied one at a time, so nothing here measures two sessions or two credential stores being built at once",
		"the acceptance is both model-issued search calls succeeding: one child succeeding while the other comes back with the tool's own unavailable error fails this case, whatever the bin holds at the end",
		"the bounded recovery is production's own, in `extensions/backends/pi-helper-retry.mjs`, and is read from each child's native tool updates: the fast child A has to carry zero of its fixed notice and the held child B exactly one, which is what says B's first underlying attempt failed and its second succeeded",
		"nothing here mocks that failure, overrides production, retries at the controller or the model level, or scripts a second tool call that could rescue a child; the at-most-two-attempts bound is the wrapper's own source and its fake tests, not a count this stream can make",
	]);
	// Nothing to find under any name the SDK's lookup tries, and no shared bin yet: both children's own lookups happen
	// after this and before either could have installed anything, which the held release pages below then show.
	p7CheckNoHelper(result, ctx, where, P7_ABSENT_HELPERS);
	result.check(fs.existsSync(where.childBin) === false, `${where.childBin} existed before this case ran`);
	const prefix = archive.body.subarray(0, Math.max(1, Math.floor(archive.body.length / 3)));
	result.observations.archiveBytes = { total: archive.body.length, prefix: prefix.length, asset: archive.asset, sharedPath: archivePath };
	result.check(prefix.length > 0 && prefix.length < archive.body.length, `the prefix this case holds back is ${prefix.length} of ${archive.body.length} byte(s), and it has to be a short nonzero part of the body`);

	const gate = p7ConcurrentGate(name);
	const listeners = {
		a: await startPairedReleaseServer({ label: `${name}-a`, who: "a", archive, gate }),
		b: await startPairedReleaseServer({ label: `${name}-b`, who: "b", archive, gate }),
	};
	// Registered for the stage's own cleanup as well as closed below: a listener must not outlive this case even if
	// something above the case throws.
	ctx.servers.push(listeners.a, listeners.b);
	const watch = { dir: where.childBin, observer: undefined };
	const flow = { promptedAt: null, latest: null, latestReleasedAt: null, asset: null, prefixObservedAt: null, aToolEndAt: null, remainderAt: null, bToolEndAt: null, holdMs: null };

	const callFor = (who) =>
		p7ConcurrentCall(ctx, {
			dirs,
			result,
			caller: `${name}-${who}`,
			key: `child${who.toUpperCase()}`,
			pair: P7_CONCURRENT_PAIR[who],
			tool,
			release: listeners[who],
			// Preserved exactly: `0` is false to the helper path, so a download is permitted, and present to the model
			// runtime, so no catalog refresh is possible and this case names no catalog listener at all.
			offline: "0",
		});
	const a = callFor("a");
	const b = callFor("b");
	const watched = {
		profile: { dir: dirs.profile, excludeManaged: true },
		managed: { dir: path.join(dirs.profile, FUSION_MANAGED_DIR) },
		project: { dir: dirs.project },
		decoySessions: { dir: dirs.sessions },
	};
	// Every caller this case created, for the one cleanup behind every path below: the reuse child joins this list the
	// moment it exists, so nothing that throws anywhere in the body can leave a controller of this case running.
	const callers = [a, b];
	// Where the body got to, for a failure that is none of the checks' own: an unexpected error is recorded against the
	// phase it stopped in rather than thrown out of the case, so the result this case did reach is not lost.
	let phase = "the pair's own first snapshot";
	let sequenced = false;
	let finishedA;
	let finishedB;
	try {
		// One snapshot before either writer starts, and one after both have exited: what two overlapping callers leave
		// behind is only readable once neither of them is still running.
		const before = await implSettled(watched);
		const windowStart = ctx.server.requests.length;

		phase = "the interleaving";
		try {
			// Every ordering this case constructs is asserted with this rather than recorded as a failure and stepped
			// over: a step whose precondition does not hold would make the steps after it measure something else, so it
			// ends the sequence. The catch below tells that apart from a bound this harness set and did not reach, and
			// neither of them is read as a helper outcome.
			const sequence = (ok, message) => {
				if (ok) return;
				const error = new Error(message);
				error.sequenceAssertion = true;
				throw error;
			};
			await a.start();
			await b.start();
			// Both prompts in one turn, so neither child is given a head start this case chose.
			flow.promptedAt = Date.now();
			const prompts = [a.prompt(), b.prompt()];
			const answers = await Promise.all(prompts);
			result.observations.promptsAccepted = answers.map((one) => one.success === true);
			for (const [index, one] of answers.entries()) sequence(one.success === true, `the ${index === 0 ? "a" : "b"} task prompt was rejected: ${one.error ?? ""}`);

			// The release pages: both have to be there before either is answered, and both are answered in one turn.
			const firstLatest = await gate.reach("latest", 1, P7_FIRST_ARRIVAL_DEADLINE_MS);
			const bothLatest = await gate.reach("latest", 2, P7_CONCURRENT_LATEST_GAP_MS);
			flow.latest = bothLatest.map((one) => ({ who: one.who, msFromPrompts: one.at - flow.promptedAt }));
			flow.latestGapMs = bothLatest[1].at - firstLatest[0].at;
			listeners.a.releaseLatest();
			listeners.b.releaseLatest();
			flow.latestReleasedAt = Date.now();

			// The assets: both have to be there before either is answered, which is what says both children are inside
			// the same first use. Both have created the one shared bin by now — the installer makes it before it
			// downloads.
			const bothAssets = await gate.reach("asset", 2, P7_CONCURRENT_ASSET_GAP_MS);
			flow.asset = bothAssets.map((one) => ({ who: one.who, msFromLatestRelease: one.at - flow.latestReleasedAt }));
			const assetArrival = Object.fromEntries(bothAssets.map((one) => [one.who, one.at]));
			result.observations.binAtAssetGate = fs.existsSync(where.childBin) ? fs.readdirSync(where.childBin).sort() : null;
			sequence(result.observations.binAtAssetGate !== null, `the shared bin ${where.childBin} did not exist although both children had asked for an asset`);

			// The observer before the first byte, so an event cannot be missed; it reads the archive's state immediately
			// as well as on every event, and the state at each handshake below is what this case asserts on.
			watch.observer = p7WatchBin(where.childBin, archivePath);
			result.observations.archiveBeforeAnyBody = watch.observer.initial;
			// Nothing at the shared name yet, or a name with no bytes at it: the prefix released next has to be the
			// first content there for the state reads below it to mean what this case reads them as.
			sequence(
				watch.observer.initial.present === false || watch.observer.initial.bytes === 0,
				`the shared archive ${archivePath} already held ${JSON.stringify(watch.observer.initial)} before either body was released`,
			);
			listeners.b.assetHeaders();
			listeners.b.assetPrefix(prefix);
			const atPrefix = await watch.observer.reaches(prefix.length, P7_CONCURRENT_PREFIX_DEADLINE_MS);
			flow.prefixObservedAt = Date.now();
			result.observations.archiveAtPrefix = { ...atPrefix, binEntries: watch.observer.entries() };

			// Only now the other child's complete body, and then its own first use. The installed source has that child
			// removing the shared pathname in its own `finally` while the held stream is still open, which is the
			// candidate this interleaving exists to put a real pair of children through.
			listeners.a.assetHeaders();
			listeners.a.assetRest(0);
			await a.firstToolEnd(P7_CONCURRENT_TOOL_DEADLINE_MS);
			flow.aToolEndAt = Date.now();
			result.observations.archiveAtFirstUse = { ...watch.observer.state(), binEntries: watch.observer.entries() };

			// One tool execution from the child whose body is complete and none at all from the held one, asserted here
			// because the wait after the release below answers with the first event of that type this child has already
			// produced: a held child that had somehow ended one would make that wait return the earlier event.
			result.observations.toolEndsBeforeRemainder = { a: a.toolEnds().length, b: b.toolEnds().length };
			sequence(
				result.observations.toolEndsBeforeRemainder.a === 1 && result.observations.toolEndsBeforeRemainder.b === 0,
				`before the held remainder was released the two children had ended ${JSON.stringify(result.observations.toolEndsBeforeRemainder)} tool execution(s), and this interleaving requires exactly one of a's and none of b's`,
			);
			listeners.b.assetRest(prefix.length);
			flow.remainderAt = Date.now();
			flow.holdMs = flow.remainderAt - assetArrival.b;
			await b.firstToolEnd(P7_CONCURRENT_TOOL_DEADLINE_MS);
			flow.bToolEndAt = Date.now();
			result.observations.archiveAfterBothUses = { ...watch.observer.state(), binEntries: watch.observer.entries() };
			sequenced = true;
		} catch (error) {
			// Two harness causes, told apart: an ordering this case asserted about its own interleaving, and a bound it
			// set and did not reach. Neither is a helper failure, neither leaves `sequenced` true, and the distinction
			// is in the wording as well as in the observation.
			const message = error instanceof Error ? error.message : String(error);
			result.observations.sequencingError = message;
			result.observations.sequencingStop = error?.sequenceAssertion === true ? "a sequencing assertion this case makes about its own interleaving" : "a bound this harness set and did not reach";
			result.failures.push(
				`the intended interleaving was not reached — ${result.observations.sequencingStop}, so nothing below is a measured first use and none of it is read as a helper failure: ${message}`,
			);
		} finally {
			// Unconditional, whichever way the sequence came out: no response stays held and no child waits on one.
			result.observations.heldReleasedOnCleanup = { a: listeners.a.releaseHeld(), b: listeners.b.releaseHeld() };
			watch.observer?.close();
		}
		// Derived from the sequence alone: a case that did not reach it claims no interleaving whatever else it observed.
		result.observations.interleavingReached = sequenced;
		result.observations.flow = flow;
		result.observations.gateArrivals = gate.arrivals.map((one) => ({ kind: one.kind, who: one.who, msFromPrompts: flow.promptedAt === null ? null : one.at - flow.promptedAt }));
		result.observations.served = { a: listeners.a.served, b: listeners.b.served };
		// Each event's own timestamp, relative to the prompts, from what the observer already recorded: these events are
		// best-effort evidence and can coalesce, and reading them against the handshakes needs their timing.
		result.observations.watcherEvents = (watch.observer?.events ?? []).map((one) => ({
			why: one.why,
			name: one.name,
			present: one.present,
			bytes: one.bytes ?? null,
			ino: one.ino ?? null,
			msFromPrompts: flow.promptedAt === null ? null : one.at - flow.promptedAt,
		}));
		if (sequenced) {
			result.check(flow.latestGapMs <= P7_CONCURRENT_LATEST_GAP_MS, `the two release pages arrived ${flow.latestGapMs}ms apart, and this interleaving holds the first one for at most ${P7_CONCURRENT_LATEST_GAP_MS}ms`);
			result.check(flow.holdMs < P7_CONCURRENT_HOLD_LIMIT_MS, `the held download was held ${flow.holdMs}ms, and this case keeps that strictly under ${P7_CONCURRENT_HOLD_LIMIT_MS}ms so the SDK's own 120s download bound is never what ended it`);
		}

		// Both tasks settle and both callers close, whatever the sequence did: a child that is still working would make
		// the snapshot below meaningless, and a caller left open would leave its call directory there.
		phase = "both tasks settling";
		for (const one of [a, b]) {
			try {
				await one.settled();
				const text = await one.lastText();
				result.observations[`${one.key}Answer`] = text.data?.text ?? null;
				result.check(text.data?.text?.includes(ANSWER) === true, `${one.caller}: the scripted final answer did not come back`);
			} catch (error) {
				result.failures.push(`${one.caller} did not settle: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// What each child's own RPC drive did, as `p5Run` would have counted it: the four operations that resolved, and
		// their conjunction. A helper call that came back as the tool's own error is not one of these facts, and neither is
		// a call that needed the bounded recovery.
		result.observations.rpcProgress = {
			a: { ...a.progress, answered: a.answered() },
			b: { ...b.progress, answered: b.answered() },
		};
		// The first caller is closed while the other child is still serving, which is what shows one call's disposal
		// leaves the other's directory alone; what the calls directory holds once both have exited is asserted after
		// that. Both closes are memoized, so the cleanup behind every path below reads these same answers.
		phase = "the two ordered closes";
		finishedA = await a.close();
		finishedB = await b.close();
		const window = ctx.server.requests.slice(windowStart);
		ctx.p7.counters.loopbackModelRequests += window.length;
		const after = await implSettled(watched);
		const diffs = implDiffs(before, after);
		result.phases.push({ name: "two children, one bin", diffs });

		phase = "the pair's own reads";
		const modelCalls = { a: p7ModelCall(a, tool), b: p7ModelCall(b, tool) };
		result.observations.modelCalls = modelCalls;
		result.observations.childPids = { a: finishedA.observations.childPid ?? null, b: finishedB.observations.childPid ?? null };
		// The acceptance, in one check: both model-issued calls, or neither. A bin holding a healthy helper afterwards is
		// not one, and neither is a call that succeeded on a second attempt being read as a first-attempt success — which is
		// what the notice counts below are for.
		result.check(
			modelCalls.a.callOk && modelCalls.b.callOk,
			`this case accepts only both model-issued search calls succeeding, and they came back as ${JSON.stringify({ a: { isError: modelCalls.a.isError, text: modelCalls.a.text }, b: { isError: modelCalls.b.isError, text: modelCalls.b.text } })}`,
		);
		for (const call of Object.values(modelCalls)) {
			result.check(call.executions === 1, `${call.caller} ended ${call.executions} tool execution(s) instead of the one model-issued call its script asks for`);
			result.check(call.toolName === P7_HELPER_TOOLS[tool].tool, `${call.caller}'s tool execution was ${JSON.stringify(call.toolName)} instead of ${P7_HELPER_TOOLS[tool].tool}`);
			result.check(call.isError === false, `${call.caller}'s ${tool} call came back as an error: ${JSON.stringify(call.text)}`);
			result.check(call.text === P7_HELPER_TOOLS[tool].result(P7_DOWNLOAD_TOKEN), `${call.caller}'s ${P7_HELPER_TOOLS[tool].tool} call answered ${JSON.stringify(call.text)} rather than exactly ${JSON.stringify(P7_HELPER_TOOLS[tool].result(P7_DOWNLOAD_TOKEN))}`);
		}
		// The bounded recovery, per child and from its own stream: none for the child whose body completed first, exactly
		// one for the held child, each attributed to this helper tool, to the one scripted call id and to a position before
		// that call's end. A missing notice on B would mean its first attempt never failed, which this interleaving is built
		// to make it do, and an extra one anywhere would mean more recovery than one call is allowed.
		// B's required notice is also this case's positive delivery control for A's zero: both children run the same build,
		// the same tool and the same composition in one case, so a run where B carries its one notice shows the notice does
		// arrive here, which is what makes A's zero worth reading as "A needed no recovery" rather than "no notice would
		// have been seen anyway". It is that control and no more — it does not prove every event-delivery property, and the
		// shape check above is what keeps an unreadable update from standing in for an absent one.
		const retry = { a: p7RetryEvidence(a, tool), b: p7RetryEvidence(b, tool) };
		p7CheckRetryEvidence(result, retry.a, { caller: a.caller, expected: 0, key: "childARetry" });
		p7CheckRetryEvidence(result, retry.b, { caller: b.caller, expected: 1, key: "childBRetry" });
		// What this case does and does not say about underlying attempts, recorded with the evidence rather than only in
		// prose: the counts are notices, the bound is the wrapper's, and the failure B recovered from stays visible.
		result.observations.boundedRecovery = {
			policy: "one model-issued tool call, at most two underlying builtin attempts, retried once on the exact native helper-unavailable sentence",
			noticeText: HELPER_RETRY_NOTICE,
			notices: { a: retry.a.notices, b: retry.b.notices },
			childAFirstAttemptSucceeded: retry.a.notices === 0 && modelCalls.a.callOk,
			childBFirstAttemptFailedAndRecovered: retry.b.notices === 1 && modelCalls.b.callOk,
			attemptsCountedHere: "no: one call ends one tool execution in this stream either way, so the at-most-two bound is the wrapper's own source and its fake tests",
			rootCauseObservedHere: "no: the notice says the wrapper matched that exact sentence, not which underlying operation or syscall failed",
		};

		for (const [one, finished] of [
			[a, finishedA],
			[b, finishedB],
		]) {
			const requests = one.requests();
			const trace = one.trace();
			result.observations[`${one.key}Call`] = {
				caller: one.caller,
				role: one.role.name,
				childExit: finished.observations.childExit ?? null,
				callerExit: finished.exit ?? null,
				modelRequests: requests.length,
				scriptSteps: requests.map((request) => request.scriptStep ?? null),
				releaseRequests: one.release.requests.map((request) => ({ kind: request.kind, path: request.path })),
				helperTrace: trace.present ? trace.entries.map((entry) => ({ event: entry.event, tool: entry.tool, kind: entry.kind, argv0: entry.argv0, self: entry.self })) : trace,
			};
			result.check(finished.observations.childExit?.code === 0, `${one.caller}'s child exited ${JSON.stringify(finished.observations.childExit)} instead of code 0`);
			result.check(requests.length === 2, `${one.caller} made ${requests.length} model request(s) instead of the 2 its script answers`);
			// The model-call boundary, from the request log this case already keeps: exactly one model-issued tool call and
			// one final text. A third request would be answered as `exhausted` and is what a second, model-scripted rescue
			// call would look like from here, so the step names are required exactly rather than counted.
			const steps = requests.map((request) => request.scriptStep ?? null);
			result.check(
				steps.join(" ") === `${P7_HELPER_TOOLS[tool].tool} final`,
				`${one.caller}'s model requests answered ${JSON.stringify(steps)} rather than exactly one ${P7_HELPER_TOOLS[tool].tool} call and one final text, and no second tool call may rescue a child in this case`,
			);
			// The composition a default call actually got, read from the input the controller recorded: an empty extensions
			// list is the condition the production wrapper is installed under. Nothing here patches that input or names a
			// resource — this case's spec carries no resources and no mutation, and the role's own binding names none — so
			// what this asserts is the default retry-enabled composition rather than something the fixture arranged.
			result.observations[`${one.key}InputExtensions`] = finished.observations.input?.extensions ?? null;
			result.check(
				Array.isArray(finished.observations.input?.extensions) && finished.observations.input.extensions.length === 0,
				`${one.caller}'s composed input named ${JSON.stringify(finished.observations.input?.extensions ?? null)} as its extensions, and the retry is composed only for a call whose extensions list is exactly empty`,
			);
			result.check(trace.present, `${one.caller}'s helper log could not be read, so this case holds no evidence about which program it ran`);
			result.check(
				p7TraceShape(trace.entries).join(" ") === `invoke:${tool}:${P7_DOWNLOAD_TOKEN}`,
				`${one.caller}'s helper fixtures recorded ${JSON.stringify(p7TraceShape(trace.entries))} rather than exactly ${JSON.stringify([`invoke:${tool}:${P7_DOWNLOAD_TOKEN}`])}`,
			);
			result.check(
				trace.entries.every((entry) => entry.argv0 === path.join(where.childBin, entry.tool)),
				`${one.caller} started a helper as ${JSON.stringify(trace.entries.map((entry) => entry.argv0))} rather than the program in the shared bin`,
			);
			result.check(
				trace.entries.every((entry) => entry.self === archive.program),
				`${one.caller} ran a program this fixture did not archive: ${JSON.stringify(trace.entries.map((entry) => entry.self))}`,
			);
			// Exactly this helper's own two urls at this child's own listener, in the order a download goes through them.
			result.check(
				one.release.requests.map((request) => `${request.kind}:${request.path}`).join(" ") === `latest:${archive.latestPath} asset:${archive.downloadPath}`,
				`${one.caller}'s own listener saw ${JSON.stringify(one.release.requests.map((request) => `${request.kind}:${request.path}`))} rather than exactly this helper's release page and asset`,
			);
			// What a recovery that downloaded again would look like from here, recorded rather than left to the line above:
			// a second request of either kind reaches this listener, which answers it 409 and records it as a repeat exactly
			// as it always did — no listener behavior, byte, status or bound changed for the retry. The recovery this case
			// accepts is the one that finds the helper the other child published, so a repeat is a failure that says so.
			result.observations[`${one.key}RepeatArrivals`] = one.release.requests.filter((request) => request.kind === "repeat").length;
			result.check(
				result.observations[`${one.key}RepeatArrivals`] === 0,
				`${one.caller}'s own listener saw ${result.observations[`${one.key}RepeatArrivals`]} repeat release request(s), so its recovery asked to download again rather than finding the installed helper`,
			);
			p7CheckInterposer(result, one.interposerLog, one.caller, {
				expectedUrls: ctx.p7.releases.urls,
				expectMapped: [archive.latestUrl, archive.downloadUrl],
				key: `${one.key}Interposer`,
			});
			checkFetchLog(result, one.fetchLog, one.caller, { expectAllowed: "some", key: `${one.key}Fetch` });
			const owned = [originOf(ctx.server.baseUrl), one.release.origin];
			const origins = [...new Set(fetchRecords(one.fetchLog, one.caller).filter((record) => record.event === "allowed").map((record) => record.origin))].sort();
			result.observations[`${one.key}RequestOrigins`] = origins;
			result.check(origins.every((origin) => owned.includes(origin)), `${one.caller} reached ${JSON.stringify(origins)}, and it owns only ${JSON.stringify(owned)}`);
			p7ConcurrentEnvironment(result, `${one.key}Environment`, finished.observations, { offline: "0", search: ctx.p7.utilityDir });
			p7CheckLocations(result, { observations: finished.observations }, where);
			// Both callers ran at once, so what one of them left behind is asserted once both have exited, below.
			checkManagedCall(result, finished.observations, {
				dirs,
				diffs,
				expectSharedAuth: true,
				alongsideAnotherCall: true,
				helperArtifacts: ["children/bin", `children/bin/${tool}`],
			});
			// The call's own drive, never its tool outcome: a child that answered every probe, took its prompt, settled
			// and returned its last text answered RPC whatever its first use of the helper then came back as.
			p7ConcurrentCount(ctx.p7.counters, finished, { answered: one.answered() });
		}
		result.observations.modelRequestsInWindow = { total: window.length, withoutScript: window.filter((request) => request.script === undefined).length };
		result.check(window.filter((request) => request.script === undefined).length === 0, `${result.observations.modelRequestsInWindow.withoutScript} model request(s) in this case carried neither child's sentinel`);
		// One helper in the shared bin, equal to the archived program, at 0755, with no archive and no extraction
		// directory left beside it by either child.
		p7CheckInstalled(result, ctx, where, [tool]);
		result.observations.sharedArchiveAtEnd = p7ArchiveState(archivePath);
		result.check(result.observations.sharedArchiveAtEnd.present === false, `the shared archive ${archivePath} is still there after both children exited: ${JSON.stringify(result.observations.sharedArchiveAtEnd)}`);
		const secondCallDir = finishedB.observations.storage?.callDir === undefined ? undefined : path.basename(finishedB.observations.storage.callDir);
		result.observations.disposalIsolation = { firstSawInCallsDir: finishedA.observations.callsDirAfterDispose, secondCallDir };
		result.check(
			secondCallDir !== undefined && (finishedA.observations.callsDirAfterDispose ?? []).includes(`${secondCallDir}/`),
			`when the first caller disposed of its own call directory the second one's ${JSON.stringify(secondCallDir)} should still have been there; it held ${JSON.stringify(finishedA.observations.callsDirAfterDispose)}`,
		);
		result.observations.callsDirectoryAtEnd = fs.readdirSync(path.join(dirs.profile, FUSION_MANAGED_DIR, "calls"));
		result.check(result.observations.callsDirectoryAtEnd.length === 0, `both callers have exited and the calls directory still holds ${JSON.stringify(result.observations.callsDirectoryAtEnd)}`);

		// The reuse subphase, and only when both model-issued calls succeeded with the notice counts this case requires —
		// the installation invariants above included, since `result.failures` covers them: a case that did not meet its
		// gate is never followed by a third child, and it is reported as NOT RUN rather than left looking like a pass. It
		// is a subphase of this case, counted as no case of its own, and it is the same profile and the same bin — nothing
		// is copied from another case's. It is read with the same isolation this case reads its pair with, on a snapshot
		// of its own.
		if (result.failures.length === 0 && modelCalls.a.callOk && modelCalls.b.callOk && retry.a.notices === 0 && retry.b.notices === 1) {
			phase = "the reuse subphase";
			const beforeReuse = p7Fingerprints([path.join(where.childBin, tool)]);
			const reuse = p7ConcurrentCall(ctx, {
				dirs,
				result,
				caller: `${name}-reuse`,
				key: "reuse",
				pair: P7_CONCURRENT_PAIR.a,
				tool,
				release: listeners.a,
				// The one value the helper path reads as true, so no download is possible in this subphase at all.
				offline: "1",
			});
			callers.push(reuse);
			const requestsBefore = { a: listeners.a.requests.length, b: listeners.b.requests.length };
			const reuseWindow = ctx.server.requests.length;
			// This subphase's own snapshot pair: the helper is already installed when it is taken, so what the third
			// call is allowed to leave behind is the ordinary managed set with no helper allowance at all.
			const reuseSnapshot = await implSettled(watched);
			await reuse.start();
			const prompt = await reuse.prompt();
			result.check(prompt.success === true, `the reuse prompt was rejected: ${prompt.error ?? ""}`);
			await reuse.settled();
			const reuseText = await reuse.lastText();
			result.observations.reuseAnswer = reuseText.data?.text ?? null;
			result.check(reuseText.data?.text?.includes(ANSWER) === true, `${reuse.caller}: the scripted final answer did not come back`);
			const use = p7ModelCall(reuse, tool);
			// A third fresh child on an installed helper has nothing to acquire, so it must need no recovery at all: its
			// own stream has to carry none of the notice, which is read the same way and attributed the same way as the
			// pair's.
			const reuseRetry = p7RetryEvidence(reuse, tool);
			p7CheckRetryEvidence(result, reuseRetry, { caller: reuse.caller, expected: 0, key: "reuseRetry" });
			const finishedReuse = await reuse.close();
			const reuseDiffs = implDiffs(reuseSnapshot, await implSettled(watched));
			result.phases.push({ name: "one reuse child on the shared bin", diffs: reuseDiffs });
			ctx.p7.counters.loopbackModelRequests += ctx.server.requests.length - reuseWindow;
			p7ConcurrentCount(ctx.p7.counters, finishedReuse, { answered: reuse.answered() });
			const afterReuse = p7Fingerprints([path.join(where.childBin, tool)]);
			result.observations.reuse = {
				run: true,
				use,
				notices: reuseRetry.notices,
				inputExtensions: finishedReuse.observations.input?.extensions ?? null,
				rpcProgress: { ...reuse.progress, answered: reuse.answered() },
				helperBefore: beforeReuse,
				helperAfter: afterReuse,
				releaseRequests: { a: listeners.a.requests.length - requestsBefore.a, b: listeners.b.requests.length - requestsBefore.b },
				childExit: finishedReuse.observations.childExit ?? null,
			};
			result.check(use.callOk, `the reuse child's ${P7_HELPER_TOOLS[tool].tool} call came back as ${JSON.stringify({ isError: use.isError, text: use.text })}`);
			// The same default composition the pair ran under, for the child that proves reuse: an empty extensions list,
			// read from the input the controller recorded rather than arranged by this subphase.
			result.check(
				Array.isArray(finishedReuse.observations.input?.extensions) && finishedReuse.observations.input.extensions.length === 0,
				`the reuse child's composed input named ${JSON.stringify(finishedReuse.observations.input?.extensions ?? null)} as its extensions, and this subphase runs the same default retry-enabled composition as the pair`,
			);
			result.check(JSON.stringify(afterReuse) === JSON.stringify(beforeReuse), `the reused helper changed across the third child's call: ${JSON.stringify(afterReuse)}`);
			result.check(
				result.observations.reuse.releaseRequests.a === 0 && result.observations.reuse.releaseRequests.b === 0,
				`the offline reuse child asked this case's listeners ${JSON.stringify(result.observations.reuse.releaseRequests)} time(s)`,
			);
			p7CheckInterposer(result, reuse.interposerLog, reuse.caller, { expectedUrls: ctx.p7.releases.urls, expectMapped: [], key: "reuseInterposer" });
			checkFetchLog(result, reuse.fetchLog, reuse.caller, { expectAllowed: "some", key: "reuseFetch" });
			p7ConcurrentEnvironment(result, "reuseEnvironment", finishedReuse.observations, { offline: "1", search: ctx.p7.utilityDir });
			p7CheckLocations(result, { observations: finishedReuse.observations }, where);
			// No helper allowance here: `children/bin` and the program in it predate this subphase's own snapshot, so a
			// reuse call that created either of them would be a write this case does not permit.
			checkManagedCall(result, finishedReuse.observations, { dirs, diffs: reuseDiffs, expectSharedAuth: true });
			p7CheckInstalled(result, ctx, where, [tool], "stillInstalled");
			result.observations.callsDirectoryAfterReuse = fs.readdirSync(path.join(dirs.profile, FUSION_MANAGED_DIR, "calls"));
			result.check(
				result.observations.callsDirectoryAfterReuse.length === 0,
				`the reuse caller has exited and the calls directory still holds ${JSON.stringify(result.observations.callsDirectoryAfterReuse)}`,
			);
		} else {
			result.observations.reuse = {
				run: false,
				reason: "NOT RUN: the pair did not meet this case's gate — both model-issued calls succeeding, A with no retry notice and B with exactly one, and every installation invariant above holding — so no third child ran and nothing about reuse is claimed here",
			};
		}
	} catch (error) {
		// Anything the checks above do not cover, recorded against the phase it stopped in: a case that got this far
		// holds real observations, and losing them to an unhandled rejection would cost more than the failure itself.
		result.observations.stoppedAt = phase;
		result.failures.push(`this case stopped at ${phase}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		// The one cleanup, behind every path out of the body above: nothing stays held, the observer is closed, every
		// caller that was created is ended and both listeners are closed. Each step is on its own, so one that fails
		// cannot skip the next, and each close is the bounded one those helpers already implement. The callers' closes
		// are memoized, so the ordered pair of closes on the normal path is what these read back.
		const cleanup = [];
		result.observations.heldReleasedAtEnd = { a: listeners.a.releaseHeld(), b: listeners.b.releaseHeld() };
		watch.observer?.close();
		for (const one of callers) {
			try {
				await one.close();
			} catch (error) {
				cleanup.push(`${one.caller} could not be closed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const [who, listener] of Object.entries(listeners)) {
			try {
				await listener.close();
			} catch (error) {
				cleanup.push(`the ${who} listener could not be closed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (cleanup.length > 0) {
			result.observations.cleanupErrors = cleanup;
			for (const message of cleanup) result.failures.push(message);
		}
	}
	return result;
}

/**
 * The download half, in the order its cases depend on each other: the interposer's own control first, so no claim
 * below rests on an unproved map, then the three-child sequence on one stable bin, then the three `PI_OFFLINE` values
 * on profiles of their own, and last the two concurrent cases, which need the archive bytes the rest of this half is
 * built on and bring listeners of their own. One release listener and one catalog listener serve everything before them.
 */
async function caseP7DownloadGroup(ctx) {
	ctx.p7.releases = p7BuildReleases(ctx);
	ctx.p7.release = await startReleaseServer({ label: "P7-releases", releases: ctx.p7.releases });
	ctx.servers.push(ctx.p7.release);
	const catalog = await startCatalogServer({ label: "P7-download" });
	ctx.servers.push(catalog);
	const results = [await caseP7InterposerControl(ctx)];
	results.push(...(await caseP7DownloadSequence(ctx, catalog)));
	results.push(...(await caseP7HelperOfflineMatrix(ctx)));
	// One case per helper, each on a profile, a shared bin and a pair of listeners of its own: nothing either of them
	// installs, downloads or holds open can reach the other, and neither runs on a directory another case prepared.
	for (const tool of P7_HELPERS) results.push(await caseP7Concurrent(ctx, tool));
	return results;
}

/**
 * The P7 group. The fixture control runs first, because every claim the precedence cases make about the generated
 * programs rests on it; then the three precedence cases, each on a profile of its own; then the catalog matrix, whose
 * warm case deliberately follows the unset one on the same stable directory; then the download half, which starts with
 * the interposer's own control for the same reason the first half starts with the fixture control. On a platform these
 * fixtures do not qualify, or without the utilities they need, every one of the twenty is reported as NOT RUN rather
 * than as a pass.
 */
async function caseP7Group(ctx) {
	const results = [];
	let reason;
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
		reason = `these fixtures are qualified on linux x64 and linux arm64 alone, and this is ${process.platform}/${process.arch}`;
	}
	let utilities;
	if (reason === undefined) {
		try {
			utilities = p7Utilities(ctx.root);
		} catch (error) {
			reason = `the owned utility directory could not be built here (${error?.code ?? String(error)})`;
		}
		if (utilities?.missing !== undefined) reason = `${utilities.missing} is not on this machine's own search path, and these fixtures require ${P7_UTILITIES.join(" and ")}`;
	}
	if (reason !== undefined) {
		for (const [name, title] of Object.entries(P7_CASES)) {
			const result = implResult(name, title, ["NOT RUN: reported as skipped rather than as a result, and nothing in it is measured, claimed or qualified"]);
			result.observations.skipped = reason;
			results.push(result);
		}
		process.stderr.write(`[P7] NOT RUN: ${Object.keys(P7_CASES).length} cases skipped, ${reason}\n`);
		return results;
	}
	ctx.p7 = { counters: p5Counters(), utilityDir: utilities.dir, resolved: utilities.resolved };
	results.push(await caseP7FixtureControl(ctx));
	for (const plan of p7PrecedencePlans()) results.push(await caseP7Precedence(ctx, plan));
	results.push(...(await caseP7CatalogMatrix(ctx)));
	results.push(...(await caseP7DownloadGroup(ctx)));
	// The group's own accounting, on stderr beside the case progress: this group's children are counted apart from
	// every other group's, the control case above runs no child and is in none of these numbers, and any case that did
	// not run is named here with its reason rather than disappearing into a count of cases that passed.
	const skipped = results.filter((one) => classifyResult(one) === "skipped").map((one) => `${one.name}: ${one.observations.skipped}`);
	process.stderr.write(`[P7] ${JSON.stringify(ctx.p7.counters)} NOT RUN: ${JSON.stringify(skipped)}\n`);
	return results;
}

/** Which exact builtin model the installed SDK offers, read in a process of its own with disposable storage. */
async function probeBuiltins(root) {
	const dir = path.join(root, "builtin-probe");
	fs.mkdirSync(path.join(dir, "store"), { recursive: true });
	const observations = path.join(dir, "builtins.json");
	writeJson(path.join(dir, "spec.json"), {
		observations,
		preferred: BUILTIN_PREFERENCE,
		// Disposable storage of its own: no user auth or models file is read, and the runtime is built with no network.
		authPath: path.join(dir, "store", "auth.json"),
		modelsPath: path.join(dir, "store", "models.json"),
		modelsStorePath: path.join(dir, "store", "models-store.json"),
	});
	const fetchLog = path.join(dir, "fetch.log");
	const env = implEnv(root, { agentDir: path.join(dir, "agent"), sessionDir: path.join(dir, "sessions"), caller: "builtins", origins: [], fetchLog });
	const probe = await runCli(process.execPath, [STORAGE_CALLER, "builtins", path.join(dir, "spec.json")], { cwd: dir, env });
	const report = readJsonIfPresent(observations) ?? {};
	return { ...report, exit: probe.code, stderr: probe.stderr.trim().split("\n").slice(-3).join("\n"), fetchLog, fetch: fetchRecords(fetchLog, "builtins") };
}

/**
 * The implementation-stage groups, in dependency order: the guard's own control, the bootstrap's startup, the durable
 * session group whose transcript the refusals copy, the catalog group, the two independent initializers, the
 * configuration and resource group, which is the first one that names a resource at all, the credential group, whose
 * fixture OAuth provider is a named resource too, and the helper and catalog group, which builds a search path of its
 * own rather than copying this machine's.
 */
async function implementationCases({ root, server, setupCase, wanted, results }) {
	const servers = [];
	const control = await startControlServer();
	const catalog = await startCatalogServer({ label: "shared" });
	servers.push(control, catalog);
	const ctx = { root, server, setupCase, servers, control, catalog };
	try {
		ctx.builtins = await probeBuiltins(root);
		const summary = implResult("P0-builtin-probe", "which exact builtin model the installed SDK offers", ["a disposable runtime with no network, so a case selects a real builtin id instead of inventing one"]);
		summary.pi = `${repoPiVersion} (repo dependency)`;
		Object.assign(summary.observations, {
			sdk: ctx.builtins.sdk,
			sessionVersion: ctx.builtins.sessionVersion,
			providers: (ctx.builtins.providers ?? []).length,
			chosen: ctx.builtins.chosen,
			runtimeError: ctx.builtins.error ?? null,
			authFileCreated: ctx.builtins.authFileCreated,
			exit: ctx.builtins.exit,
		});
		checkFetchLog(summary, ctx.builtins.fetchLog, "builtins", { expectAllowed: 0, expectChild: false });
		// Two of this probe's results are prerequisites for every group below, so they stop the stage rather than only
		// failing their own case; a guard failure above fails this case and is reported, like any other.
		const blocking = [];
		if (!ctx.builtins.chosen) blocking.push(`the probe found none of ${BUILTIN_PREFERENCE.join(", ")} in the installed SDK's catalog: ${ctx.builtins.failure ?? ctx.builtins.stderr}`);
		if (typeof ctx.builtins.sessionVersion !== "number") blocking.push("the probe read no CURRENT_SESSION_VERSION, which the version mutations below need");
		summary.failures.push(...blocking);
		results.push(summary);
		if (blocking.length) return;
		if (wanted("G")) {
			results.push(...(await caseFetchGuardControl(ctx)));
			results.push(await caseFetchRedirectControl(ctx));
			results.push(await caseGuardRequired(ctx));
			results.push(managedFilterSelfCheck());
		}
		if (wanted("P1")) results.push(await caseBootstrapStartup(ctx));
		if (wanted("P2")) {
			const group = await caseDurableSessions(ctx);
			results.push(...group);
		}
		if (wanted("P3")) results.push(...(await caseCatalog(ctx)));
		if (wanted("P4")) results.push(...(await caseIndependentInitialization(ctx)));
		if (wanted("P5")) results.push(...(await caseP5Group(ctx)));
		if (wanted("P6")) results.push(...(await caseP6Group(ctx)));
		if (wanted("P7")) results.push(...(await caseP7Group(ctx)));
	} finally {
		for (const one of ctx.servers) await one.close();
	}
}

await main();
