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
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** A dummy key: it never leaves the temp root and the fixture server accepts any bearer. */
const FIXTURE_KEY = "spike-dummy-key-not-a-secret";
const FIXTURE_PROVIDER = "fixture";
const EXTENSION_PROVIDER = "fixture-ext";
const FIXTURE_MODEL = "fixture-model";
const ANSWER = "SPIKE_OK";
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

/** A loopback OpenAI-completions server. Deterministic, never asked for anything but one short answer. */
async function startFixtureServer() {
	const requests = [];
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
			};
			requests.push(record);
			if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
				return;
			}
			try {
				record.model = JSON.parse(body).model;
			} catch {
				record.model = undefined;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
			const chunk = (choices, usage) =>
				`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: FIXTURE_MODEL, choices, ...(usage ? { usage } : {}) })}\n\n`;
			res.write(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
			res.write(chunk([{ index: 0, delta: { content: ANSWER }, finish_reason: null }]));
			res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
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
	console.log(result.failures.length === 0 ? "  RESULT: guarantees held" : `  RESULT: ${result.failures.length} failure(s)`);
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

		const wanted = (name) => !onlyCase || onlyCase === name;

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

		if (onlyCase && results.length === 0) {
			console.log(`no case is named ${onlyCase}`);
			process.exitCode = 2;
			return;
		}

		console.log(`pi-fusion spike: keeping a Pi child out of the user's configuration`);
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

		const failed = results.filter((result) => result.failures.length > 0);
		console.log(`\n${results.length - failed.length}/${results.length} cases kept their guarantees`);
		if (keepRoot) writeJson(path.join(root, "report.json"), { results: results.map((r) => ({ ...r, phases: r.phases.map((p) => ({ ...p, diffs: undefined, diff: Object.fromEntries(Object.entries(p.diffs).map(([k, v]) => [k, formatDiff(v)])) })) })), exportProbe });
		process.exitCode = failed.length === 0 ? 0 : 1;
	} finally {
		await server.close();
		if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
	}
}

await main();
