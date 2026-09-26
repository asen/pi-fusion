#!/usr/bin/env node
/*
 * Research spike, run by hand: what a Pi child can promise about session lifecycle — durable
 * checkpoints, restoring an older checkpoint, forking at an exact position, and what survives a
 * failed run. It is not part of `npm test`, because it spawns real Pi processes; the default test
 * glob (`test/*.test.ts`) does not reach this directory.
 *
 *   node test/spikes/pi-session-lifecycle.mjs [--case <name> | --case=<name>] [--keep] [--list]
 *
 * Every child is the public SDK bootstrap (never `dist/bundle/cli.js`), generated into a disposable
 * temp root that also holds HOME, the child's agent directory (PI_CODING_AGENT_DIR), the fake user profile
 * that models.json is read from, the fake project, the session directory, TMPDIR, the XDG directories and
 * both compile caches. The harness refuses to launch when any of those resolves outside the root: every
 * environment variable that names a path, and every path field of the bootstrap configuration (cwd,
 * agentDir, sessionDir, authPath, modelsPath, modelsStorePath), goes through the same check, and a
 * self-test before the first case proves that the refusal still fires and that the sentinel guard still
 * reports a modified file. The only model endpoint is a scripted loopback fixture server;
 * its recorded HTTP payloads, the session JSONL read back as evidence, and Pi's own RPC output are
 * the only things assertions are derived from.
 *
 * Every assertion about Fusion's record rules is a SIMULATION of `extensions/fusion.ts`
 * (`recordRun`, `nextSession`) run by the in-harness ledger, and is labelled as such. Only the Pi
 * side — what the fork contains, what the leaf is, what goes out on the wire — is measured.
 *
 * Exit codes: 0 when every selected case is a measured pass, 1 when any case failed or is unproven, and 2
 * whenever no case ran at all — an unmatched or valueless `--case` in either spelling, an unrecognised
 * argument, or `--list`, which prints the catalogue and runs nothing.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The package publishes only an "import" condition, so require.resolve cannot find it; resolve the
// public entry point the way an ESM importer does.
const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const packageRoot = path.resolve(path.dirname(packageEntry), "..");
const piVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

/**
 * Strict on purpose, because the exit codes this harness advertises are only worth something if every
 * spelling of `--case` reaches the same place. Absent is undefined; `--case` with a missing, flag-shaped or
 * empty value is the empty string, which names no case; both `--case x` and `--case=x` are the same
 * argument; and anything unrecognised is collected rather than ignored, because an ignored `--case=nope`
 * would run all nine cases and exit 0 for a command line that named nothing.
 */
function parseArgv(args) {
	const parsed = { onlyCase: undefined, keep: false, list: false, unknown: [] };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--keep") parsed.keep = true;
		else if (arg === "--list") parsed.list = true;
		else if (arg === "--case") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("--")) parsed.onlyCase = "";
			else {
				parsed.onlyCase = value;
				index++;
			}
		} else if (arg.startsWith("--case=")) parsed.onlyCase = arg.slice("--case=".length);
		else parsed.unknown.push(arg);
	}
	return parsed;
}
const cli = parseArgv(process.argv.slice(2));
const onlyCase = cli.onlyCase;
const keepRoot = cli.keep;
const listOnly = cli.list;

/** A dummy key: it never leaves the temp root and the fixture server accepts any bearer. */
const FIXTURE_KEY = "spike-dummy-key-not-a-secret";
const FIXTURE_PROVIDER = "fixture";
const FIXTURE_MODEL = "fixture-model";
const USER_CONTEXT_SENTINEL = "SPIKE-PROFILE-CONTEXT-SENTINEL";
const AGENT_DIR_CONTEXT_SENTINEL = "SPIKE-AGENTDIR-CONTEXT-SENTINEL";
const PROJECT_CONTEXT_SENTINEL = "SPIKE-PROJECT-CONTEXT-SENTINEL";
/** An id that generateId() cannot produce (it emits 8 hex characters), so it is always absent. */
const ABSENT_ENTRY_ID = "zzzzzzzz";

/** models.json cost fields, so a printed cost has a stated provenance instead of reading as "free". */
const MODEL_COST = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const MODEL_CONTEXT_WINDOW = 200_000;
const MODEL_MAX_TOKENS = 4096;

const COMMAND_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 90_000;
const EXIT_DEADLINE_MS = 10_000;
const GLOBAL_DEADLINE_MS = 10 * 60_000;
/** "agent_settled was last" is only a claim about a window: nothing can be observed in zero time. */
const SETTLE_QUIET_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ snapshots */

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

/** path -> kind/size/hash for everything under dir, so a diff names files rather than counts them. */
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

const formatDiff = (diff) =>
	isEmptyDiff(diff)
		? "unchanged"
		: [...diff.created.map((f) => `+${f}`), ...diff.modified.map((f) => `~${f}`), ...diff.removed.map((f) => `-${f}`)].join(" ");

/* ------------------------------------------------------------------- fixtures */

const write = (file, content) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
};
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`);

// The context window is per case: threshold compaction is provoked by a small window plus large
// usage numbers in the fixture's usage chunk, which is cheaper than sending a large payload.
const modelsJson = (baseUrl, contextWindow = MODEL_CONTEXT_WINDOW) => ({
	providers: {
		[FIXTURE_PROVIDER]: {
			baseUrl,
			api: "openai-completions",
			apiKey: "$SPIKE_FIXTURE_KEY",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
			models: [
				{
					id: FIXTURE_MODEL,
					name: "Fixture Model",
					reasoning: true,
					input: ["text"],
					contextWindow,
					maxTokens: MODEL_MAX_TOKENS,
					cost: MODEL_COST,
				},
			],
		},
	},
});

/**
 * A fake user profile. Nothing here is the child's agent directory: the child gets its own, so the
 * user-level AGENTS.md must never reach a system prompt, and every file here must stay byte-identical.
 */
function seedUserProfile(dir, baseUrl, contextWindow) {
	writeJson(path.join(dir, "models.json"), modelsJson(baseUrl, contextWindow));
	writeJson(path.join(dir, "settings.json"), { defaultProvider: FIXTURE_PROVIDER, defaultModel: FIXTURE_MODEL, theme: "dark" });
	writeJson(path.join(dir, "auth.json"), { [FIXTURE_PROVIDER]: { type: "api_key", key: "spike-profile-credential-never-read" } });
	fs.chmodSync(path.join(dir, "auth.json"), 0o600);
	write(path.join(dir, "AGENTS.md"), `# User context\n\n${USER_CONTEXT_SENTINEL}\n`);
}

/** A fake project: the cwd every child runs in, with the context sentinel the child should inherit. */
function seedProject(dir) {
	write(path.join(dir, "AGENTS.md"), `# Project context\n\n${PROJECT_CONTEXT_SENTINEL}\n`);
	write(path.join(dir, "README.md"), "Spike project fixture for the Pi session lifecycle harness.\n");
}

/* ------------------------------------------------------------------------ env */

/**
 * One containment rule for everything a child is pointed at, whether it arrives as an environment
 * variable or as a field of the bootstrap configuration: a path outside the disposable root is a
 * refusal, not a diagnostic, because the case would otherwise read or write the real machine.
 */
function assertInsideRoot(root, label, value) {
	const rootReal = fs.realpathSync(root);
	const resolved = path.resolve(value);
	if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) {
		throw new Error(`refusing to launch: ${label}=${value} is outside the temp root ${rootReal}`);
	}
	return resolved;
}

/** The bootstrap fields that decide where a child reads and writes; none of them goes through childEnv. */
const CONTAINED_CONFIG_FIELDS = ["cwd", "agentDir", "sessionDir", "authPath", "modelsPath", "modelsStorePath"];

/** Write a child's bootstrap configuration, having checked every path in it against the root. */
function writeChildConfig(root, file, config) {
	for (const field of CONTAINED_CONFIG_FIELDS) assertInsideRoot(root, field, config[field]);
	writeJson(file, config);
	return file;
}

/** Every writable location a child knows about is inside the temp root, and that is checked before launch. */
function childEnv(root, { agentDir, sessionDir }) {
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
		SPIKE_FIXTURE_KEY: FIXTURE_KEY,
		// The bridge's in-child view of the outgoing payload is opt-in, so the flag has to be forwarded.
		...(process.env.PI_SPIKE_LOG_PROVIDER_REQUESTS === "1" ? { PI_SPIKE_LOG_PROVIDER_REQUESTS: "1" } : {}),
	};
	for (const [name, value] of Object.entries(env)) {
		if (name === "PATH" || name === "NO_COLOR" || !value.includes(path.sep)) continue;
		fs.mkdirSync(assertInsideRoot(root, name, value), { recursive: true });
	}
	return env;
}

/* ------------------------------------------------------------- fixture server */

const DEFAULT_USAGE = { prompt_tokens: 120, completion_tokens: 8 };

const messageText = (message) => {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
	return "";
};

/**
 * A scripted loopback OpenAI-completions server. Every case installs an ordered script; an unscripted
 * request gets a 500 and is recorded as a failure, so no case can pass because a request went missing.
 */
async function startFixtureServer() {
	const state = { script: [], cursor: 0, requests: [], unscripted: [] };
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const record = {
				index: state.requests.length,
				at: Date.now(),
				method: req.method,
				url: req.url,
				hasAuthorization: typeof req.headers.authorization === "string",
				authorizationMatchesFixtureKey: req.headers.authorization === `Bearer ${FIXTURE_KEY}`,
			};
			state.requests.push(record);
			if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
				record.scripted = false;
				record.note = "unexpected path";
				state.unscripted.push(record);
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
			record.messages = (parsed?.messages ?? []).map((message) => ({
				role: message.role,
				text: messageText(message),
				toolCalls: (message.tool_calls ?? []).map((call) => call.function?.name),
				toolCallId: message.tool_call_id,
			}));
			record.roles = record.messages.map((message) => message.role);
			record.systemText = record.messages.find((message) => message.role === "system")?.text ?? "";
			record.toolNames = (parsed?.tools ?? []).map((tool) => tool.function?.name);
			record.hasToolsKey = parsed?.tools !== undefined;
			record.maxTokens = parsed?.max_tokens ?? parsed?.max_completion_tokens;

			const step = state.script[state.cursor];
			if (!step) {
				record.scripted = false;
				record.note = "no scripted response left";
				state.unscripted.push(record);
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "SPIKE_UNSCRIPTED_REQUEST" } }));
				return;
			}
			state.cursor++;
			record.scripted = true;
			record.step = step.name ?? step.kind;
			record.stepIndex = state.cursor - 1;
			record.usageSent = step.kind === "http_error" ? undefined : { ...DEFAULT_USAGE, ...(step.usage ?? {}) };
			respond(res, step, record);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		get requests() {
			return state.requests;
		},
		get unscripted() {
			return state.unscripted;
		},
		/** Install a case's script and forget every earlier request, so a case owns its whole log. */
		install(script) {
			state.script = script;
			state.cursor = 0;
			state.requests = [];
			state.unscripted = [];
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

function respond(res, step, record) {
	if (step.kind === "http_error") {
		res.writeHead(step.status ?? 500, { "content-type": "application/json" });
		res.end(JSON.stringify(step.body ?? { error: { message: "SPIKE_SCRIPTED_FAILURE" } }));
		return;
	}
	const usage = record.usageSent;
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
	const chunk = (choices, extra) =>
		`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: FIXTURE_MODEL, choices, ...(extra ?? {}) })}\n\n`;
	res.write(chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]));
	// `delayMs` holds the stream open, which is the only reliable way to queue work into a live run.
	if (step.delayMs) {
		setTimeout(() => finishResponse(res, step, chunk, usage), step.delayMs);
		return;
	}
	finishResponse(res, step, chunk, usage);
}

function finishResponse(res, step, chunk, usage) {
	if (step.kind === "tool_call") {
		res.write(
			chunk([
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: step.toolCallId ?? "call_spike_1",
								type: "function",
								function: { name: step.toolName, arguments: JSON.stringify(step.arguments ?? {}) },
							},
						],
					},
					finish_reason: null,
				},
			]),
		);
		res.write(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]));
	} else {
		res.write(chunk([{ index: 0, delta: { content: step.text ?? "SPIKE_OK" }, finish_reason: null }]));
		res.write(chunk([{ index: 0, delta: {}, finish_reason: step.finishReason ?? "stop" }]));
	}
	res.write(chunk([], { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } }));
	res.write("data: [DONE]\n\n");
	res.end();
}

const textStep = (name, text, usage) => ({ kind: "text", name, text, usage });
const toolCallStep = (name, toolName, args, toolCallId, usage) => ({ kind: "tool_call", name, toolName, arguments: args, toolCallId, usage });
const errorStep = (name, status = 500, message = "SPIKE_SCRIPTED_FAILURE upstream refused the call") => ({
	kind: "http_error",
	name,
	status,
	body: { error: { message, type: "spike_error" } },
});

/* ------------------------------------------------- generated child: bootstrap */

/**
 * The child under test: a runtime built only from the package's public exports. It never goes through
 * the CLI, so no startup migration runs, and its settings live in memory, so there is no settings file
 * to write. `session.mode` chooses between a fresh session and reopening a recorded one; the preflight
 * is explicit because SessionManager.open on a missing path silently starts a different session.
 */
const bootstrapSource = `import { existsSync, readFileSync } from "node:fs";
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

const refuse = (reason) => {
	process.stderr.write("SPIKE_PREFLIGHT_REFUSED " + reason + "\\n");
	process.exit(3);
};

/**
 * Fail closed before any session exists. Pi's own open() would create a brand new session bound to a
 * missing path, and branch()/navigateTree() would then throw on an id that is simply not there.
 */
const preflight = (file, checkpoint) => {
	if (!existsSync(file)) refuse("session file does not exist: " + file);
	let ids;
	try {
		ids = new Set(
			readFileSync(file, "utf8")
				.split("\\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.type !== "session")
				.map((entry) => entry.id),
		);
	} catch (error) {
		refuse("session file is unreadable as JSONL: " + (error && error.message ? error.message : String(error)));
	}
	if (checkpoint && !ids.has(checkpoint)) refuse("checkpoint " + checkpoint + " is not in " + file);
};

const settingsManager = SettingsManager.inMemory(config.settings ?? {});
const modelRuntime = await ModelRuntime.create({
	authPath: config.authPath,
	modelsPath: config.modelsPath,
	modelsStorePath: config.modelsStorePath,
	allowModelNetwork: false,
});

let sessionManager;
if (config.session.mode === "open") {
	if (config.session.preflight !== false) preflight(config.session.file, config.session.requireCheckpoint);
	sessionManager = SessionManager.open(config.session.file, config.sessionDir);
	// A bootstrap-side leaf move, kept as a labelled comparison against the bridge's navigateTree().
	if (config.session.bootstrapBranch) sessionManager.branch(config.session.bootstrapBranch);
} else {
	sessionManager = SessionManager.create(config.cwd, config.sessionDir);
}

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
	if (!model) throw new Error("the fixture model " + config.provider + "/" + config.model + " is not available to the child");
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
	sessionStartEvent: { type: "session_start", reason: config.session.mode === "open" ? "resume" : "startup" },
});
await runRpcMode(runtime);
`;

/** A read-only probe: what SessionManager.open does with a path that does not exist. */
const openProbeSource = `import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { SessionManager } = await import(pathToFileURL(config.packageEntry).href);

const existedBefore = existsSync(config.target);
const manager = SessionManager.open(config.target, config.sessionDir);
process.stdout.write(
	JSON.stringify({
		existedBefore,
		threw: false,
		sessionId: manager.getSessionId(),
		sessionFileAfterOpen: manager.getSessionFile(),
		entryCount: manager.getEntries().length,
		leafId: manager.getLeafId(),
		fileExistsAfterOpen: existsSync(config.target),
	}),
);
`;

/* ------------------------------------------------ generated child: the bridge */

/**
 * The Fusion child bridge stand-in. Commands are the only way to reach fork(position:"at") and
 * navigateTree() in 0.85.1 — RPC has no navigate_tree command and its fork cannot take a position.
 */
const bridgeSource = `/** Generated by test/spikes/pi-session-lifecycle.mjs. Do not edit: it is rewritten on every run. */
const notifyJson = (ctx, prefix, value) => ctx.ui.notify(prefix + " " + JSON.stringify(value), "info");

const describe = (ctx, extra) => {
	const manager = ctx.sessionManager;
	const leafId = manager.getLeafId();
	const leaf = leafId ? manager.getEntry(leafId) : undefined;
	const contextEntries = manager.buildContextEntries();
	const shape = {
		mode: ctx.mode,
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile() || null,
		leafId: leafId || null,
		leafType: leaf ? (leaf.type === "message" ? "message:" + leaf.message.role : leaf.type) : null,
		entryCount: manager.getEntries().length,
		contextEntryIds: contextEntries.map((entry) => entry.id),
		contextEntryTypes: contextEntries.map((entry) => (entry.type === "message" ? "message:" + entry.message.role : entry.type)),
		model: ctx.model ? ctx.model.provider + "/" + ctx.model.id : null,
		thinkingLevel: ctx.thinkingLevel,
		isIdle: ctx.isIdle(),
	};
	return Object.assign(shape, extra || {});
};

export default function (pi) {
	/** A question that blocks its child: the tool's own signal is forwarded, or abort would deadlock.
	 * The identifier is the one the spike brief fixed; the prose calls the other side the host. */
	pi.registerTool({
		name: "ask_orchestrator",
		label: "Ask orchestrator",
		description: "Ask the host a question and wait for exactly one answer.",
		parameters: {
			type: "object",
			properties: { question: { type: "string", description: "The question for the host" } },
			required: ["question"],
			additionalProperties: false,
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			notifyJson(ctx, "SPIKE_QUESTION", { toolCallId: toolCallId, question: params.question });
			const answer = await ctx.ui.input(params.question, undefined, { signal: signal });
			if (answer === undefined) {
				notifyJson(ctx, "SPIKE_QUESTION_END", { toolCallId: toolCallId, outcome: "cancelled", aborted: signal.aborted });
				throw new Error("ask_orchestrator: cancelled or aborted before an answer arrived");
			}
			notifyJson(ctx, "SPIKE_QUESTION_END", { toolCallId: toolCallId, outcome: "answered" });
			return { content: [{ type: "text", text: answer }], details: {} };
		},
	});

	pi.registerCommand("spike-state", {
		description: "Report the child's session identity, leaf and context entry ids",
		handler: async (_args, ctx) => {
			notifyJson(ctx, "SPIKE_STATE", describe(ctx));
		},
	});

	pi.registerCommand("spike-navigate", {
		description: "Move the leaf to a checkpoint without summarising the abandoned branch",
		handler: async (args, ctx) => {
			const targetId = args.trim();
			try {
				const result = await ctx.navigateTree(targetId, { summarize: false });
				notifyJson(ctx, "SPIKE_NAVIGATE", describe(ctx, { ok: true, targetId: targetId, cancelled: result.cancelled === true }));
			} catch (error) {
				notifyJson(ctx, "SPIKE_NAVIGATE", { ok: false, targetId: targetId, error: error && error.message ? error.message : String(error) });
				throw error;
			}
		},
	});

	pi.registerCommand("spike-fork", {
		description: "Fork at an exact entry, so the checkpoint itself is included; a second argument is an id to ask for",
		handler: async (args, ctx) => {
			const words = args.trim().split(" ").filter(function (word) {
				return word.length > 0;
			});
			const targetId = words[0];
			/** Passed on purpose: 0.85.1's fork() reads only position and withSession, so the harness can
			 * measure that a supplied id is ignored instead of asserting that two random uuids differ. */
			const requestedId = words[1];
			let acked = false;
			try {
				const options = { position: "at" };
				if (requestedId) options.id = requestedId;
				options.withSession = async (nextCtx) => {
					acked = true;
					notifyJson(nextCtx, "SPIKE_FORK", describe(nextCtx, { ok: true, targetId: targetId, requestedId: requestedId || null, cancelled: false }));
				};
				const result = await ctx.fork(targetId, options);
				// A cancelled fork never replaces the session, so this ctx is still the live one.
				if (!acked)
					notifyJson(ctx, "SPIKE_FORK", describe(ctx, { ok: true, targetId: targetId, requestedId: requestedId || null, cancelled: result.cancelled === true }));
			} catch (error) {
				notifyJson(ctx, "SPIKE_FORK", {
					ok: false,
					targetId: targetId,
					requestedId: requestedId || null,
					error: error && error.message ? error.message : String(error),
				});
				throw error;
			}
		},
	});

	/** Supplemental only: an in-child view of the outgoing payload, never the primary evidence. */
	if (process.env.PI_SPIKE_LOG_PROVIDER_REQUESTS === "1") {
		pi.on("before_provider_request", async (event, ctx) => {
			const messages = (event.payload && event.payload.messages) || [];
			notifyJson(ctx, "SPIKE_PAYLOAD", { supplemental: true, messageCount: messages.length, roles: messages.map((m) => m.role) });
			return undefined;
		});
	}
}
`;

/* --------------------------------------------------------------------- client */

/** Every process this harness starts, with its start time, so cleanup can prove none of them outlived the run. */
const spawnedPids = new Map();

/** Field 22 of /proc/<pid>/stat: pids are recycled, (pid, starttime) is not. Undefined off Linux. */
function processStartTime(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

/** The earliest observation of a pid wins: a later re-registration could only pin a recycled one. */
const registerPid = (pid) => {
	if (!Number.isFinite(pid) || pid <= 0 || spawnedPids.has(pid)) return;
	spawnedPids.set(pid, processStartTime(pid));
};

/**
 * The harness signals only processes it started. A pid that has been reaped and reused belongs to
 * somebody else, and `-pid` would then reach a whole unrelated process group on the user's machine.
 */
function isOurProcess(pid) {
	if (!pidAlive(pid)) return false;
	if (!spawnedPids.has(pid)) return false;
	const recorded = spawnedPids.get(pid);
	const current = processStartTime(pid);
	if (recorded === undefined && current === undefined) return true;
	return recorded !== undefined && recorded === current;
}

function killTree(pid) {
	if (!isOurProcess(pid)) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

/**
 * A pid written by one of the harness's own fixture commands. `echo $$ >` truncates the file before it
 * writes, so content without a trailing newline may still be half-written and must read as absent rather
 * than as a truncated pid that belongs to somebody else.
 */
function readPidFile(file) {
	let content;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	if (!content.endsWith("\n")) return undefined;
	const pid = Number(content.trim());
	return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Poll a set of pid files and register each pid the moment its own file is readable, rather than after the
 * slowest of them appears: between a descendant starting and the harness knowing its pid there is a window
 * in which an interrupt would leak it, and this keeps that window down to one poll period.
 */
async function collectPidFiles(files, deadlineMs = COMMAND_DEADLINE_MS) {
	const labels = Object.keys(files);
	const found = {};
	const until = Date.now() + deadlineMs;
	while (Object.keys(found).length < labels.length) {
		for (const label of labels) {
			if (found[label] !== undefined) continue;
			const pid = readPidFile(files[label]);
			if (pid === undefined) continue;
			found[label] = pid;
			registerPid(pid);
		}
		if (Object.keys(found).length === labels.length) break;
		if (Date.now() > until) throw new Error(`the bash command never wrote both pid files (so far ${JSON.stringify(found)})`);
		await sleep(25);
	}
	return found;
}

/** EPERM means the pid exists and belongs to somebody else, which still counts as alive. */
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Graceful first, then forced, and to the group as well as the process: a descendant that called
 * setsid has left the group Pi kills, so only a per-pid signal reaches it.
 */
async function terminatePid(pid) {
	const attempts = [];
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		if (!isOurProcess(pid)) break;
		for (const target of [-pid, pid]) {
			try {
				process.kill(target, signal);
				attempts.push(`${signal}->${target}`);
			} catch (error) {
				attempts.push(`${signal}->${target} ${error?.code ?? "failed"}`);
			}
		}
		await sleep(250);
	}
	return { attempts, alive: pidAlive(pid) };
}

class RpcChild {
	constructor(label, command, args, options) {
		this.label = label;
		this.events = [];
		this.stderr = "";
		this.pending = new Map();
		this.waiters = [];
		this.nextId = 0;
		this.exit = undefined;
		this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		registerPid(this.child.pid);
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code, signal) => {
				this.exit = { code, signal };
				spawnedPids.delete(this.child.pid);
				for (const pending of this.pending.values()) pending.reject(new Error(`child ${label} exited (${code ?? signal}) before responding`));
				this.pending.clear();
				for (const waiter of [...this.waiters]) waiter.reject(new Error(`child ${label} exited (${code ?? signal}) while waiting`));
				this.waiters.length = 0;
				resolve(this.exit);
			});
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
			if (process.env.PI_SPIKE_DEBUG) process.stderr.write(`[${label}] ${String(chunk).slice(0, 2000)}`);
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
			if (pending) {
				pending.resolve(message);
				return;
			}
		}
		this.events.push(message);
		for (const waiter of [...this.waiters]) {
			if (waiter.match(message)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	}

	/** A cursor into the event log, taken before a send so a later wait cannot match an older event. */
	mark() {
		return this.events.length;
	}

	send(command, deadlineMs = COMMAND_DEADLINE_MS) {
		if (this.exit) return Promise.reject(new Error(`child ${this.label} already exited (${JSON.stringify(this.exit)})`));
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

	/**
	 * A protocol line that has no response to correlate. An `extension_ui_response` is answered by
	 * the dialog promise inside the child, never by an RPC response, so `send` would time out on it.
	 */
	write(message) {
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	/** Wait for an event at or after `from`; the waiter is registered before any further send. */
	waitFrom(from, match, deadlineMs = SETTLE_DEADLINE_MS, description = "event") {
		for (let i = from; i < this.events.length; i++) {
			if (match(this.events[i])) return Promise.resolve(this.events[i]);
		}
		if (this.exit) return Promise.reject(new Error(`child ${this.label} exited before ${description}`));
		return new Promise((resolve, reject) => {
			const waiter = { match, resolve: undefined, reject: undefined };
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) this.waiters.splice(index, 1);
				reject(new Error(`no ${description} within ${deadlineMs}ms`));
			}, deadlineMs);
			waiter.resolve = (event) => {
				clearTimeout(timer);
				resolve(event);
			};
			waiter.reject = (error) => {
				clearTimeout(timer);
				reject(error);
			};
			this.waiters.push(waiter);
		});
	}

	waitSettled(from, deadlineMs = SETTLE_DEADLINE_MS) {
		return this.waitFrom(from, (event) => event.type === "agent_settled", deadlineMs, "agent_settled");
	}

	notifications(from = 0) {
		return this.events
			.slice(from)
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => event.message ?? "");
	}

	/** The trailing space is load-bearing: SPIKE_QUESTION is a prefix of SPIKE_QUESTION_END. */
	waitNotification(prefix, from = 0, deadlineMs = COMMAND_DEADLINE_MS) {
		const marker = `${prefix} `;
		return this.waitFrom(
			from,
			(event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message ?? "").startsWith(marker),
			deadlineMs,
			`${prefix} notification`,
		).then((event) => JSON.parse(String(event.message).slice(marker.length)));
	}

	extensionErrors(from = 0) {
		return this.events.slice(from).filter((event) => event.type === "extension_error");
	}

	diagnostics() {
		return [
			`  last events: ${JSON.stringify(this.events.slice(-10).map((event) => event.type ?? "?"))}`,
			`  stderr tail: ${this.stderr.trim().split("\n").filter(Boolean).slice(-6).join(" | ") || "(empty)"}`,
		].join("\n");
	}

	/** Close stdin first and give the child its own shutdown path; kill the group only if it stays. */
	async close() {
		if (this.exit) return this.exit;
		try {
			this.child.stdin.end();
		} catch {}
		if ((await Promise.race([this.exited, sleep(EXIT_DEADLINE_MS).then(() => "timeout")])) === "timeout") {
			killTree(this.child.pid);
			await Promise.race([this.exited, sleep(2000)]);
		}
		return this.exit;
	}
}

/** A short-lived helper process: probes and the preflight-refusal measurements, never an RPC session. */
function runNode(args, options, deadlineMs = 30_000) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		registerPid(child.pid);
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
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child.pid);
		}, deadlineMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			spawnedPids.delete(child.pid);
			resolve({ code, signal, stdout, stderr, timedOut });
		});
	});
}

/* ----------------------------------------------------------------- the ledger */

/**
 * The in-harness stand-in for the host record on a Fusion branch (`extensions/fusion.ts`: `nextSession`
 * ~246, `recordRun` ~1820). It decides what the next child restores. Every line it prints is SIMULATED
 * Fusion policy, not measured Pi behaviour.
 */
class Ledger {
	constructor(say) {
		this.records = new Map();
		this.say = say;
	}

	/**
	 * What the next run for this handle should do, given the host session asking for it. `allocatedId`
	 * mirrors nextSession's `randomUUID()` for a fork, which is the one part of the rule Pi cannot take:
	 * `createBranchedSession` generates the fork's id itself, so row 3 confronts the two.
	 */
	plan(handle, hostSessionId) {
		const record = this.records.get(handle);
		let plan;
		if (!record || !record.sessionId) plan = { action: "new" };
		else if (record.hostSessionId === hostSessionId) plan = { action: "resume", sessionId: record.sessionId, checkpoint: record.checkpoint };
		else plan = { action: "fork", sessionId: record.sessionId, checkpoint: record.checkpoint, allocatedId: crypto.randomUUID() };
		this.say(`simulated Fusion policy: nextSession(${handle}, host=${hostSessionId}) -> ${JSON.stringify(plan)}`);
		return plan;
	}

	/** What the branch records once a run has ended. Mirrors recordRun's four outcomes. */
	record(handle, { hostSessionId, plan, sessionId, checkpoint, ok }) {
		const prior = this.records.get(handle);
		let outcome;
		if (!sessionId) {
			if (!prior) {
				this.records.set(handle, { handle, hostSessionId });
				outcome = "no session id, no prior record -> handle-only entry";
			} else {
				outcome = "no session id, prior record kept -> nothing recorded";
			}
		} else if (ok) {
			this.records.set(handle, { handle, hostSessionId, sessionId, checkpoint });
			outcome = `success -> id ${sessionId} at checkpoint ${checkpoint}`;
		} else if (plan.action === "resume") {
			outcome = "failed resume -> nothing recorded, the prior successful record stays authoritative";
		} else if (plan.action === "fork") {
			this.records.set(handle, { handle, hostSessionId, sessionId, checkpoint: plan.checkpoint });
			outcome = `failed fork after creation -> fork id ${sessionId} at the fork-at checkpoint ${plan.checkpoint}`;
		} else {
			this.records.set(handle, { handle, hostSessionId, sessionId, checkpoint: undefined });
			outcome = `failed new run -> id ${sessionId} with no checkpoint`;
		}
		this.say(`simulated Fusion policy: recordRun(${handle}) ${outcome}`);
		return this.records.get(handle);
	}

	get(handle) {
		return this.records.get(handle);
	}
}

/* ------------------------------------------------------- session file evidence */

const readSessionEntries = (file) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));

const entryLabel = (entry) => {
	if (entry.type === "session") return "header";
	if (entry.type !== "message") return entry.type;
	const text = messageText(entry.message).replace(/\s+/g, " ").trim();
	return `message:${entry.message.role}${text ? ` "${text.slice(0, 40)}"` : ""}${entry.message.stopReason ? ` [${entry.message.stopReason}]` : ""}`;
};

const describeEntries = (entries) => entries.filter((entry) => entry.type !== "session").map((entry) => `${entry.id}<-${entry.parentId ?? "root"} ${entryLabel(entry)}`);

/* ------------------------------------------------------------ request evidence */

const describeRequest = (request) =>
	request.messages
		.map((message) => {
			const text = message.text.replace(/\s+/g, " ").trim();
			if (message.role === "system") return `system(${message.text.length}ch)`;
			if (message.toolCalls.length > 0) return `${message.role}[toolCall:${message.toolCalls.join(",")}]`;
			return `${message.role} "${text.slice(0, 48)}"`;
		})
		.join(" | ");

/** Non-system message texts, which is what a "does this turn carry T2?" question is really about. */
const conversationTexts = (request) => request.messages.filter((message) => message.role !== "system").map((message) => message.text);

/** The first words of the summarizer's system prompt and of a compaction summary replayed as context. */
const SUMMARY_SYSTEM_PREFIX = "You are a context summarization assistant.";
const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

/**
 * A compaction summary call, not a turn: a standalone context with the summarizer system prompt, one
 * user message that opens with the serialized conversation, and no `tools` key at all.
 */
const isSummaryRequest = (request) =>
	request.systemText.startsWith(SUMMARY_SYSTEM_PREFIX) &&
	request.hasToolsKey === false &&
	(request.messages.find((message) => message.role === "user")?.text ?? "").startsWith("<conversation>");

const eventTypes = (child, from = 0) => child.events.slice(from).map((event) => event.type ?? "?");

/** Index of the first event at or after `from` that matches, or -1; used for ordering assertions. */
const eventIndex = (child, from, match) => {
	for (let index = from; index < child.events.length; index++) if (match(child.events[index])) return index;
	return -1;
};

/** Wait for the fixture to have been hit `count` times, so a case can act while a stream is open. */
async function waitForRequests(server, count, deadlineMs = COMMAND_DEADLINE_MS) {
	const until = Date.now() + deadlineMs;
	while (server.requests.length < count) {
		if (Date.now() > until) throw new Error(`only ${server.requests.length} of ${count} provider request(s) arrived within ${deadlineMs}ms`);
		await sleep(25);
	}
	return server.requests.length;
}

const waitInputRequest = (child, from, deadlineMs = COMMAND_DEADLINE_MS) =>
	child.waitFrom(from, (event) => event.type === "extension_ui_request" && event.method === "input", deadlineMs, "extension_ui_request(input)");

/* ---------------------------------------------------------------- case runner */

class CaseResult {
	constructor(name, row, title) {
		this.name = name;
		this.row = row;
		this.title = title;
		this.failures = [];
		this.unproven = undefined;
	}
	say(line) {
		console.log(`  ${line}`);
	}
	phase(name) {
		console.log(`  -- ${name}`);
	}
	check(ok, message) {
		if (!ok) {
			this.failures.push(message);
			console.log(`    FAIL ${message}`);
		}
		return ok;
	}
	get status() {
		if (this.failures.length > 0) return "fail";
		if (this.unproven) return "unproven";
		return "pass";
	}
}

/* ------------------------------------------------------------- case plumbing */

/**
 * The directories of every case set up during the current case, so the runner can check their sentinels
 * in a finally. A case that threw is exactly the case whose promise not to touch them is worth checking.
 */
const openCases = [];

/** One case's directories, generated child sources and environment. */
function setupCase(root, server, name, options = {}) {
	const contextWindow = options.contextWindow ?? MODEL_CONTEXT_WINDOW;
	const caseRoot = path.join(root, "cases", name);
	const profile = path.join(caseRoot, "user-profile");
	const project = path.join(caseRoot, "project");
	const agentDir = path.join(caseRoot, "child-agent");
	const sessionDir = path.join(caseRoot, "sessions");
	const bridge = path.join(caseRoot, "bridge.ts");
	const bootstrap = path.join(caseRoot, "bootstrap.mjs");
	const probe = path.join(caseRoot, "open-probe.mjs");
	for (const dir of [profile, project, agentDir, sessionDir]) fs.mkdirSync(dir, { recursive: true });
	seedUserProfile(profile, server.baseUrl, contextWindow);
	seedProject(project);
	// The child's own agent directory carries the same user-level sentinel, so a case can tell
	// "the child inherited the user's global context" from "the child inherited the project's".
	write(path.join(agentDir, "AGENTS.md"), `# Child agent directory context\n\n${AGENT_DIR_CONTEXT_SENTINEL}\n`);
	write(bridge, bridgeSource);
	write(bootstrap, bootstrapSource);
	write(probe, openProbeSource);
	const env = childEnv(root, { agentDir, sessionDir });
	const dirs = { name, root, caseRoot, profile, project, agentDir, sessionDir, bridge, bootstrap, probe, env, contextWindow, sentinels: [] };
	dirs.profileBefore = snapshot(profile);
	dirs.projectBefore = snapshot(project);
	trackSentinel(dirs, "child agent directory AGENTS.md", path.join(agentDir, "AGENTS.md"));
	openCases.push(dirs);
	return dirs;
}

/**
 * A single file whose bytes a case promises not to change, inside a directory Pi legitimately writes to: the
 * child's agent directory receives `auth.json` and `models-store.json`, so it cannot be required
 * byte-identical as a whole, while the context file the child reads from it can be, and is the one that matters.
 */
function trackSentinel(dirs, label, file) {
	dirs.sentinels.push({ label, file, hash: hashFile(file) });
}

/** Write a child configuration and start it. `session` chooses new versus reopened. */
function startChild(dirs, label, { session, tools = ["read"], settings, modelsPath, agentDir = dirs.agentDir }) {
	const configFile = path.join(dirs.caseRoot, `bootstrap-${label}.json`);
	writeChildConfig(dirs.root, configFile, {
		packageEntry,
		cwd: dirs.project,
		agentDir,
		sessionDir: dirs.sessionDir,
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: modelsPath ?? path.join(dirs.profile, "models.json"),
		modelsStorePath: path.join(agentDir, "models-store.json"),
		extensionPaths: [dirs.bridge],
		provider: FIXTURE_PROVIDER,
		model: FIXTURE_MODEL,
		tools,
		settings: { defaultTools: tools, ...(settings ?? {}) },
		session,
	});
	// PI_CODING_AGENT_DIR has to name the same directory as the configuration, so a child on another agent
	// directory is given its own environment; every other variable, and the containment check, is unchanged.
	const env = agentDir === dirs.agentDir ? dirs.env : childEnv(dirs.root, { agentDir, sessionDir: dirs.sessionDir });
	return new RpcChild(`${dirs.name}/${label}`, process.execPath, [dirs.bootstrap, configFile], { cwd: dirs.project, env });
}

/** Run a bridge command and read its acknowledgement. The notify always precedes the prompt response. */
async function bridgeCommand(child, command, prefix, deadlineMs = COMMAND_DEADLINE_MS) {
	const mark = child.mark();
	const response = await child.send({ type: "prompt", message: command }, deadlineMs);
	const data = await child.waitNotification(prefix, mark, deadlineMs);
	return { response, data, mark };
}

const state = (child) => bridgeCommand(child, "/spike-state", "SPIKE_STATE").then((result) => result.data);

/** Send a run's prompt and wait for the terminal event, with the waiter registered before the send. */
async function runPrompt(child, message, deadlineMs = SETTLE_DEADLINE_MS) {
	const mark = child.mark();
	const response = await child.send({ type: "prompt", message }, COMMAND_DEADLINE_MS);
	if (!response.success) return { mark, response, settled: undefined };
	const settled = await child.waitSettled(mark, deadlineMs);
	return { mark, response, settled };
}

/** Pi's own view of what the run cost, beside the numbers the fixture actually sent. */
async function readStats(child) {
	const response = await child.send({ type: "get_session_stats" });
	return response.data;
}

const formatStats = (stats) =>
	stats
		? `tokens ${JSON.stringify(stats.tokens)} cost ${stats.cost} contextUsage ${JSON.stringify(stats.contextUsage)}`
		: "(unavailable)";

const statsDelta = (before, after) => ({
	input: after.tokens.input - before.tokens.input,
	output: after.tokens.output - before.tokens.output,
	total: after.tokens.total - before.tokens.total,
	cost: Number((after.cost - before.cost).toFixed(6)),
});

/** Everything the case promised not to touch, checked after the case rather than claimed. */
function guardUnchanged(result, label, before, dir) {
	const diff = diffSnapshots(before, snapshot(dir));
	result.check(isEmptyDiff(diff), `${label} changed during the case: ${formatDiff(diff)}`);
	result.say(`${label}: ${formatDiff(diff)}`);
}

/** The sentinel bytes a child is really pointed at, checked file by file rather than by whole directory. */
function guardSentinel(result, sentinel) {
	const now = fs.existsSync(sentinel.file) ? hashFile(sentinel.file) : "(missing)";
	result.check(now === sentinel.hash, `${sentinel.label} changed during the case: ${sentinel.hash} -> ${now}`);
	result.say(`${sentinel.label}: ${now === sentinel.hash ? "unchanged" : `changed (${now})`}`);
}

/**
 * The sentinel check the runner owes every case, on the failure path as much as on the success path:
 * a case that threw halfway is the one most likely to have written where it promised not to.
 */
function guardOpenCases(result) {
	for (const dirs of openCases.splice(0)) {
		guardUnchanged(result, "fake user profile", dirs.profileBefore, dirs.profile);
		guardUnchanged(result, "fake project", dirs.projectBefore, dirs.project);
		for (const sentinel of dirs.sentinels) guardSentinel(result, sentinel);
	}
}

/* ------------------------------------------------------------------ the cases */

/** Row 8: a model or thinking level the child cannot serve must never reach the provider. */
async function caseModelThinking(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	server.install([textStep("row8-run", "ROW8-ANSWER")]);
	const child = startChild(dirs, "c1", { session: { mode: "create" }, settings: { defaultThinkingLevel: "off", retry: { enabled: false } } });
	try {
		result.phase("startup and the model catalogue");
		const startState = await child.send({ type: "get_state" }, 60_000);
		result.check(startState.success === true, "get_state failed at startup");
		result.say(`model at startup: ${startState.data?.model?.provider}/${startState.data?.model?.id}, thinkingLevel ${startState.data?.thinkingLevel}`);
		const models = await child.send({ type: "get_available_models" });
		const names = (models.data?.models ?? []).map((model) => `${model.provider}/${model.id}`);
		result.say(`available models: ${JSON.stringify(names)}`);
		result.check(names.includes(`${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`), "the fixture model is not available to the child");

		result.phase("strict model selection: typo, wrong case, glob pattern, synthetic provider");
		const rejections = [
			{ label: "typo id", provider: FIXTURE_PROVIDER, modelId: "fixture-modl" },
			{ label: "wrong-case id", provider: FIXTURE_PROVIDER, modelId: FIXTURE_MODEL.toUpperCase() },
			// A pattern that would match this very model under the CLI's resolver, so a pass here
			// measures that RPC's set_model looks the id up exactly rather than resolving patterns.
			{ label: "glob-shaped id", provider: FIXTURE_PROVIDER, modelId: "fixture-*" },
			{ label: "synthetic provider", provider: "fixture-synthetic", modelId: FIXTURE_MODEL },
		];
		for (const rejection of rejections) {
			const response = await child.send({ type: "set_model", provider: rejection.provider, modelId: rejection.modelId });
			result.say(`set_model ${rejection.label} (${rejection.provider}/${rejection.modelId}) -> success=${response.success} error=${response.error ?? "-"}`);
			result.check(response.success === false, `set_model accepted a ${rejection.label}; strictness does not hold`);
		}
		result.check(server.requests.length === 0, `a rejected model still reached the provider (${server.requests.length} requests)`);
		result.say(`fixture requests after the rejected selections: ${server.requests.length}`);
		result.say("source: rpc-mode's set_model finds the model by exact provider and id in the available snapshot and resolves nothing; the substring match and the synthesized model id of core/model-resolver.js belong to the CLI's --model argument and its minimatch path to the configured model scope, none of which this child takes");

		result.phase("thinking level: the response is not the read-back");
		const levels = await child.send({ type: "get_available_thinking_levels" });
		result.say(`supported thinking levels: ${JSON.stringify(levels.data?.levels)}`);
		result.check((levels.data?.levels ?? []).includes("xhigh") === false, "the fixture model unexpectedly supports xhigh, so this case cannot test clamping");
		const setUnsupported = await child.send({ type: "set_thinking_level", level: "xhigh" });
		const afterUnsupported = await child.send({ type: "get_state" });
		result.say(`set_thinking_level xhigh -> success=${setUnsupported.success}, get_state.thinkingLevel=${afterUnsupported.data?.thinkingLevel}`);
		result.check(setUnsupported.success === true, "set_thinking_level did not answer success, which is what makes the read-back necessary");
		result.check(
			afterUnsupported.data?.thinkingLevel !== "xhigh",
			"set_thinking_level did not clamp an unsupported level, so the documented hazard has changed",
		);
		result.say("simulated Fusion policy: the read-back differs from the requested level, so the harness sends no prompt on this selection");
		result.check(server.requests.length === 0, "a clamped thinking level still reached the provider");

		result.phase("the valid selection, its read-back and its session entry");
		const setModel = await child.send({ type: "set_model", provider: FIXTURE_PROVIDER, modelId: FIXTURE_MODEL });
		const afterModel = await child.send({ type: "get_state" });
		result.check(setModel.success === true, "the valid model selection was rejected");
		result.check(
			`${afterModel.data?.model?.provider}/${afterModel.data?.model?.id}` === `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`,
			"the model read-back does not equal the selection",
		);
		// setModel re-applies a thinking level of its own, so the order of the two setters matters.
		result.say(`measured Pi behaviour: set_model reset thinkingLevel from ${afterUnsupported.data?.thinkingLevel} to ${afterModel.data?.thinkingLevel} (the settings default), so a role must set its effort AFTER its model`);
		result.check(
			afterModel.data?.thinkingLevel === "off",
			`set_model left thinkingLevel at ${afterModel.data?.thinkingLevel}; the documented reset to the settings default has changed`,
		);
		const setLevel = await child.send({ type: "set_thinking_level", level: "medium" });
		const afterValid = await child.send({ type: "get_state" });
		result.check(setLevel.success === true, "the valid thinking level was rejected");
		result.check(afterValid.data?.thinkingLevel === "medium", `thinkingLevel read back as ${afterValid.data?.thinkingLevel} instead of medium`);

		result.phase("one run, then the durable evidence");
		const statsBefore = await readStats(child);
		const run = await runPrompt(child, "ROW8-RUN say the fixture answer.");
		result.check(run.response.success === true, "the run's prompt was rejected");
		const statsAfter = await readStats(child);
		result.check(server.requests.length === 1, `expected exactly one provider request, got ${server.requests.length}`);
		const request = server.requests[0];
		result.say(`request 0: ${describeRequest(request)}`);
		result.check(request.authorizationMatchesFixtureKey === true, "the request did not carry the seeded credential");
		result.check(request.model === FIXTURE_MODEL, `the request asked for ${request.model}`);
		result.check(request.systemText.includes(PROJECT_CONTEXT_SENTINEL), "the project AGENTS.md sentinel is not in the system content");
		result.check(
			request.systemText.includes(AGENT_DIR_CONTEXT_SENTINEL),
			"the child agent directory's AGENTS.md sentinel is not in the system content, so this case cannot tell user-level context from project context",
		);
		result.check(!request.systemText.includes(USER_CONTEXT_SENTINEL), "the fake user profile's AGENTS.md sentinel reached the system content");
		result.say(
			`context sentinels in the system content: project ${request.systemText.includes(PROJECT_CONTEXT_SENTINEL)}, fake user profile ${request.systemText.includes(USER_CONTEXT_SENTINEL)}, child agent directory ${request.systemText.includes(AGENT_DIR_CONTEXT_SENTINEL)}`,
		);
		result.say(`cost provenance: models.json cost per million tokens = ${JSON.stringify(MODEL_COST)}`);
		result.say(`stats delta over the run: ${JSON.stringify(statsDelta(statsBefore, statsAfter))}; fixture sent usage ${JSON.stringify(request.usageSent)}`);
		result.say(`stats after settle: ${formatStats(statsAfter)}`);

		const identity = await state(child);
		await child.close();
		const entries = readSessionEntries(identity.sessionFile);
		const modelChanges = entries.filter((entry) => entry.type === "model_change");
		result.say(`model_change entries: ${JSON.stringify(modelChanges.map((entry) => `${entry.provider}/${entry.modelId}`))}`);
		result.check(
			modelChanges.length > 0 && modelChanges.every((entry) => entry.provider === FIXTURE_PROVIDER && entry.modelId === FIXTURE_MODEL),
			"a model_change entry names something other than the exact selection",
		);
		const thinkingChanges = entries.filter((entry) => entry.type === "thinking_level_change").map((entry) => entry.thinkingLevel);
		result.say(`thinking_level_change entries: ${JSON.stringify(thinkingChanges)}`);
		result.check(thinkingChanges.at(-1) === "medium", `the last persisted thinking level is ${thinkingChanges.at(-1)}, not the selected medium`);
		result.check(thinkingChanges.includes("xhigh") === false, "the unsupported level was persisted, contradicting the clamp");
		result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
	} finally {
		await child.close();
	}

	// The negative above — the fake user profile's sentinel is absent — is worth nothing on its own: nothing
	// points a child at that directory. A control child pointed at a copy of the very same bytes makes it
	// falsifiable. The copy exists because Pi writes auth.json and models-store.json into whatever agent
	// directory it is given, and the fake user profile has to stay byte-identical.
	result.phase("the falsifiable half: the same sentinel bytes in a directory the child IS pointed at");
	const controlAgentDir = path.join(dirs.caseRoot, "profile-as-agent-dir");
	fs.mkdirSync(controlAgentDir, { recursive: true });
	fs.copyFileSync(path.join(dirs.profile, "AGENTS.md"), path.join(controlAgentDir, "AGENTS.md"));
	trackSentinel(dirs, "control agent directory AGENTS.md", path.join(controlAgentDir, "AGENTS.md"));
	server.install([textStep("row8-control", "ROW8-CONTROL-ANSWER")]);
	const control = startChild(dirs, "control", { session: { mode: "create" }, agentDir: controlAgentDir, settings: { retry: { enabled: false } } });
	try {
		const run = await runPrompt(control, "ROW8-CONTROL say the fixture answer.");
		result.check(run.response.success === true, "the control run's prompt was rejected");
		result.check(server.requests.length === 1, `expected exactly one provider request from the control child, got ${server.requests.length}`);
		const request = server.requests[0];
		result.say(`control child: PI_CODING_AGENT_DIR=${controlAgentDir}, holding a byte-identical copy of the fake user profile's AGENTS.md`);
		result.check(
			request.systemText.includes(USER_CONTEXT_SENTINEL),
			"the user-level sentinel stayed out of the system content even with the child's agent directory pointed at the file holding it, so the absence measured above proves nothing",
		);
		result.say(
			`the same bytes in the child's agent directory: sentinel in the system content ${request.systemText.includes(USER_CONTEXT_SENTINEL)}; in a directory nothing points at (the fake user profile): false`,
		);
		result.say(
			"measured Pi behaviour: user-level context is read from the agent directory the child is given and from the ancestors of its cwd (loadProjectContextFiles), so the fake user profile stays out of the prompt because nothing names it — not because Pi ignores a user-level AGENTS.md",
		);
		result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in the control phase`);
	} finally {
		await control.close();
	}
}

/** Row 1: a settled run's checkpoint survives the child process, and a later abandoned turn does not. */
async function caseDurableCheckpoint(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	const ledger = new Ledger((line) => result.say(line));
	const HOST = "host-session-1";
	server.install([textStep("c1", "ROW1-C1-ANSWER"), textStep("c2", "ROW1-C2-ANSWER"), errorStep("c3"), textStep("c4", "ROW1-C4-ANSWER")]);

	result.phase("what SessionManager.open does with a path that does not exist (public-API probe)");
	const missing = path.join(dirs.sessionDir, "definitely-not-here.jsonl");
	const probeConfig = path.join(dirs.caseRoot, "open-probe.json");
	writeJson(probeConfig, { packageEntry, target: missing, sessionDir: dirs.sessionDir });
	const probe = await runNode([dirs.probe, probeConfig], { cwd: dirs.project, env: dirs.env });
	let probeReport;
	try {
		probeReport = JSON.parse(probe.stdout);
	} catch {
		probeReport = { error: probe.stderr.trim().split("\n").slice(-3).join(" | ") };
	}
	result.say(`open(missing path) -> ${JSON.stringify(probeReport)}`);
	result.check(probe.code === 0, `the open probe exited ${probe.code}`);
	result.check(
		probeReport.threw === false && probeReport.entryCount === 0,
		"SessionManager.open on a missing path no longer starts an empty session silently; the preflight rationale needs rechecking",
	);
	result.say("measured Pi behaviour: open() on a missing path does not throw, it binds a brand new session id to that path, which is why the bootstrap preflights");

	result.phase("run C1: a new session settles and the leaf becomes the checkpoint");
	const plan1 = ledger.plan("row1", HOST);
	result.check(plan1.action === "new", `the first run planned ${plan1.action} instead of new`);
	const child1 = startChild(dirs, "c1", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let sessionFile;
	let checkpoint1;
	let sessionId;
	try {
		const run1 = await runPrompt(child1, "ROW1-C1 first run.");
		result.check(run1.response.success === true, "C1 was rejected");
		const after1 = await state(child1);
		sessionFile = after1.sessionFile;
		sessionId = after1.sessionId;
		checkpoint1 = after1.leafId;
		result.say(`C1 settled: sessionId ${sessionId}, leaf ${checkpoint1} (${after1.leafType}), entries ${after1.entryCount}`);
		result.say("the checkpoint is the leaf id at settle, not the last assistant message id; after a compaction those differ");
		ledger.record("row1", { hostSessionId: HOST, plan: plan1, sessionId, checkpoint: checkpoint1, ok: true });
	} finally {
		const exit = await child1.close();
		result.say(`C1 child exit: ${JSON.stringify(exit)}`);
	}

	result.phase("the preflight fails closed");
	const refusals = [
		{ label: "missing session file", session: { mode: "open", file: missing, requireCheckpoint: checkpoint1 } },
		{ label: "unknown checkpoint id", session: { mode: "open", file: sessionFile, requireCheckpoint: ABSENT_ENTRY_ID } },
	];
	for (const refusal of refusals) {
		const configFile = path.join(dirs.caseRoot, `preflight-${refusal.label.replace(/\s+/g, "-")}.json`);
		writeChildConfig(dirs.root, configFile, {
			packageEntry,
			cwd: dirs.project,
			agentDir: dirs.agentDir,
			sessionDir: dirs.sessionDir,
			authPath: path.join(dirs.agentDir, "auth.json"),
			modelsPath: path.join(dirs.profile, "models.json"),
			modelsStorePath: path.join(dirs.agentDir, "models-store.json"),
			extensionPaths: [dirs.bridge],
			provider: FIXTURE_PROVIDER,
			model: FIXTURE_MODEL,
			tools: ["read"],
			settings: { defaultTools: ["read"] },
			session: refusal.session,
		});
		const refused = await runNode([dirs.bootstrap, configFile], { cwd: dirs.project, env: dirs.env }, 30_000);
		const line = refused.stderr.split("\n").find((value) => value.startsWith("SPIKE_PREFLIGHT_REFUSED")) ?? "(none)";
		result.say(`preflight ${refusal.label}: exit ${refused.code}, ${line}`);
		result.check(refused.code === 3, `the preflight did not refuse a ${refusal.label} (exit ${refused.code})`);
	}

	result.phase("run C2: reopen, observe the leaf before restoring, then restore and continue");
	const plan2 = ledger.plan("row1", HOST);
	result.check(plan2.action === "resume" && plan2.checkpoint === checkpoint1, "the ledger did not plan a resume at C1's checkpoint");
	const child2 = startChild(dirs, "c2", {
		session: { mode: "open", file: sessionFile, requireCheckpoint: plan2.checkpoint },
		settings: { retry: { enabled: false } },
	});
	let checkpoint2;
	try {
		const beforeNavigate = await state(child2);
		result.say(`leaf immediately after reopen, before any restore: ${beforeNavigate.leafId} (${beforeNavigate.leafType})`);
		result.check(beforeNavigate.sessionId === sessionId, "the reopened child reports a different session id");
		result.check(beforeNavigate.sessionFile === sessionFile, "the reopened child reports a different session file");
		const navigated = (await bridgeCommand(child2, `/spike-navigate ${plan2.checkpoint}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true, `restore failed: ${navigated.error ?? "?"}`);
		result.check(navigated.leafId === plan2.checkpoint, `after restore the leaf is ${navigated.leafId}, not the checkpoint ${plan2.checkpoint}`);
		result.check(navigated.sessionId === sessionId && navigated.sessionFile === sessionFile, "restoring changed the session identity");
		result.say(`restored: leaf ${navigated.leafId}, context entries ${JSON.stringify(navigated.contextEntryTypes)}`);

		// Stats are read after the restore and before the prompt, so the delta belongs to this run alone.
		const statsBefore = await readStats(child2);
		const run2 = await runPrompt(child2, "ROW1-C2 second run.");
		result.check(run2.response.success === true, "C2 was rejected");
		const statsAfter = await readStats(child2);
		result.say(`C2 stats delta: ${JSON.stringify(statsDelta(statsBefore, statsAfter))}; fixture sent usage ${JSON.stringify(server.requests.at(-1).usageSent)}`);
		result.say(`C2 stats after settle: ${formatStats(statsAfter)} (getSessionStats sums the whole file, abandoned branches included, so only the delta is per-run)`);
		const request = server.requests.at(-1);
		result.say(`C2 request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(JSON.stringify(request.roles) === JSON.stringify(["system", "user", "assistant", "user"]), `C2 role sequence is ${JSON.stringify(request.roles)}`);
		result.check(texts[0].includes("ROW1-C1"), "C2's context does not start with C1's prompt");
		result.check(texts[1].includes("ROW1-C1-ANSWER"), "C2's context does not carry C1's answer");
		result.check(texts[2].includes("ROW1-C2"), "C2's own prompt is missing from its context");
		const after2 = await state(child2);
		checkpoint2 = after2.leafId;
		ledger.record("row1", { hostSessionId: HOST, plan: plan2, sessionId: after2.sessionId, checkpoint: checkpoint2, ok: true });

		result.phase("run C3: a provider failure with retry disabled, abandoned rather than recorded");
		const plan3 = ledger.plan("row1", HOST);
		const run3 = await runPrompt(child2, "ROW1-C3 abandoned run.");
		result.check(run3.response.success === true, "C3's prompt was rejected before reaching the provider");
		const failedRequest = server.requests.at(-1);
		result.say(`C3 request: ${describeRequest(failedRequest)} -> scripted ${failedRequest.step}`);
		const lastText = await child2.send({ type: "get_last_assistant_text" });
		result.say(`last assistant text after the failure: ${JSON.stringify(lastText.data?.text ?? null)}`);
		const after3 = await state(child2);
		result.say(`leaf after the failed run: ${after3.leafId} (${after3.leafType}), entries ${after3.entryCount}`);
		result.check(after3.leafId !== checkpoint2, "the failed run left the leaf where it was, so this case cannot show exclusion");
		ledger.record("row1", { hostSessionId: HOST, plan: plan3, sessionId: after3.sessionId, checkpoint: after3.leafId, ok: false });
		const kept = ledger.get("row1");
		result.check(kept.checkpoint === checkpoint2, `the ledger moved off C2's checkpoint after a failed resume (now ${kept.checkpoint})`);
	} finally {
		const exit = await child2.close();
		result.say(`C2/C3 child exit: ${JSON.stringify(exit)}`);
	}

	result.phase("run C4: restart, restore the last good checkpoint, and check what goes out");
	const plan4 = ledger.plan("row1", HOST);
	const child3 = startChild(dirs, "c4", {
		session: { mode: "open", file: sessionFile, requireCheckpoint: plan4.checkpoint },
		settings: { retry: { enabled: false } },
	});
	try {
		const beforeNavigate = await state(child3);
		result.say(`leaf after reopen, before restore: ${beforeNavigate.leafId} (${beforeNavigate.leafType})`);
		result.check(
			beforeNavigate.leafId !== plan4.checkpoint,
			"the reopened leaf already equals the checkpoint, so this run does not show that restoration is required",
		);
		result.say("measured Pi behaviour: the leaf is not persisted; a reopened session resumes at the file's last line, so the checkpoint must be re-established every time");
		const navigated = (await bridgeCommand(child3, `/spike-navigate ${plan4.checkpoint}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === plan4.checkpoint, "the restore to C2's checkpoint failed");
		const run4 = await runPrompt(child3, "ROW1-C4 fourth run.");
		result.check(run4.response.success === true, "C4 was rejected");
		const request = server.requests.at(-1);
		result.say(`C4 request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(
			JSON.stringify(request.roles) === JSON.stringify(["system", "user", "assistant", "user", "assistant", "user"]),
			`C4 role sequence is ${JSON.stringify(request.roles)}`,
		);
		result.check(!texts.some((text) => text.includes("ROW1-C3")), "the abandoned C3 prompt is still in the outgoing context");
		result.check(!texts.some((text) => text.includes("SPIKE_SCRIPTED_FAILURE")), "the C3 provider error text reached the outgoing context");
		result.check(texts.at(-1).includes("ROW1-C4"), "C4's own prompt is missing from its context");
	} finally {
		const exit = await child3.close();
		result.say(`C4 child exit: ${JSON.stringify(exit)}`);
	}

	result.phase("the durable file, read back as evidence");
	const entries = readSessionEntries(sessionFile);
	for (const line of describeEntries(entries)) result.say(`  ${line}`);
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
}

/** Row 2: restoring an older checkpoint after a later turn settled, the /tree move simulated. */
async function caseOlderCheckpoint(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	const ledger = new Ledger((line) => result.say(line));
	const HOST = "host-session-1";
	server.install([textStep("t1", "ROW2-T1-ANSWER"), textStep("t2", "ROW2-T2-ANSWER"), textStep("t3", "ROW2-T3-ANSWER")]);

	const plan1 = ledger.plan("row2", HOST);
	const child1 = startChild(dirs, "t1", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let sessionFile;
	let sessionId;
	let checkpointT1;
	let checkpointT2;
	try {
		result.phase("turns T1 and T2 settle");
		await runPrompt(child1, "ROW2-T1 first turn.");
		const afterT1 = await state(child1);
		checkpointT1 = afterT1.leafId;
		sessionFile = afterT1.sessionFile;
		sessionId = afterT1.sessionId;
		result.say(`T1 leaf: ${checkpointT1} (${afterT1.leafType})`);
		await runPrompt(child1, "ROW2-T2 second turn.");
		const afterT2 = await state(child1);
		checkpointT2 = afterT2.leafId;
		result.say(`T2 leaf: ${checkpointT2} (${afterT2.leafType})`);
		ledger.record("row2", { hostSessionId: HOST, plan: plan1, sessionId, checkpoint: checkpointT2, ok: true });
	} finally {
		await child1.close();
	}

	result.phase("restart and restore T1's checkpoint, the way a host /tree move would");
	result.say(`simulated Fusion policy: the host selects the earlier record on the branch, so the next child restores ${checkpointT1} rather than ${checkpointT2}`);
	const child2 = startChild(dirs, "t3", {
		session: { mode: "open", file: sessionFile, requireCheckpoint: checkpointT1 },
		settings: { retry: { enabled: false } },
	});
	try {
		const beforeNavigate = await state(child2);
		result.say(`leaf after reopen, before restore: ${beforeNavigate.leafId} (${beforeNavigate.leafType})`);
		result.check(beforeNavigate.leafId === checkpointT2, `the reopened leaf is ${beforeNavigate.leafId}, not the file's last line ${checkpointT2}`);
		const navigated = (await bridgeCommand(child2, `/spike-navigate ${checkpointT1}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === checkpointT1, `the restore to T1 failed: ${navigated.error ?? navigated.leafId}`);
		result.say(`restored context entries: ${JSON.stringify(navigated.contextEntryTypes)}`);

		const run = await runPrompt(child2, "ROW2-T3 third turn.");
		result.check(run.response.success === true, "T3 was rejected");
		const request = server.requests.at(-1);
		result.say(`T3 request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(JSON.stringify(request.roles) === JSON.stringify(["system", "user", "assistant", "user"]), `T3 role sequence is ${JSON.stringify(request.roles)}`);
		result.check(!texts.some((text) => text.includes("ROW2-T2")), "T2's prompt is still in T3's outgoing context");
		result.check(!texts.some((text) => text.includes("ROW2-T2-ANSWER")), "T2's answer is still in T3's outgoing context");
		result.check(texts[0].includes("ROW2-T1") && texts[1].includes("ROW2-T1-ANSWER"), "T1's turn is missing from T3's context");
	} finally {
		await child2.close();
	}

	result.phase("the durable file keeps T2 as a sibling branch");
	const entries = readSessionEntries(sessionFile);
	for (const line of describeEntries(entries)) result.say(`  ${line}`);
	const children = entries.filter((entry) => entry.parentId === checkpointT1);
	result.say(`children of T1's checkpoint ${checkpointT1}: ${JSON.stringify(children.map((entry) => `${entry.id} ${entryLabel(entry)}`))}`);
	result.check(children.length === 2, `expected T2 and T3 to be siblings under ${checkpointT1}, found ${children.length} child entries`);
	result.check(
		children.some((entry) => messageText(entry.message ?? {}).includes("ROW2-T2")) && children.some((entry) => messageText(entry.message ?? {}).includes("ROW2-T3")),
		"T2 and T3 are not both children of T1's checkpoint",
	);
	result.phase("comparison only: a bootstrap-side branch() instead of the bridge's navigateTree()");
	const child3 = startChild(dirs, "t3-branch", {
		session: { mode: "open", file: sessionFile, requireCheckpoint: checkpointT1, bootstrapBranch: checkpointT1 },
		settings: { retry: { enabled: false } },
	});
	try {
		const branched = await state(child3);
		result.say(`leaf after open()+branch(), before any navigate: ${branched.leafId} (${branched.leafType}), context entries ${JSON.stringify(branched.contextEntryTypes)}`);
		result.check(branched.leafId === checkpointT1, `open()+branch() left the leaf at ${branched.leafId} instead of ${checkpointT1}`);
		result.say("labelled comparison: branching the SessionManager before the session is built reaches the same leaf, but it is not the mechanism Fusion plans to use");
	} finally {
		await child3.close();
	}

	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
}

/** Row 3: fork at an exact checkpoint, and two transcripts that cannot see each other afterwards. */
async function caseForkAt(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	const ledger = new Ledger((line) => result.say(line));
	server.install([textStep("a", "ROW3-A-ANSWER"), textStep("f1", "ROW3-F1-ANSWER"), textStep("o1", "ROW3-O1-ANSWER")]);

	const child1 = startChild(dirs, "fork", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let originalFile;
	let originalId;
	let checkpoint;
	let forkFile;
	let forkId;
	let originalHashAfterA;
	let planForOtherHost;
	try {
		result.phase("the parent turn A settles and becomes the fork-at checkpoint");
		await runPrompt(child1, "ROW3-A parent turn.");
		const afterA = await state(child1);
		originalFile = afterA.sessionFile;
		originalId = afterA.sessionId;
		checkpoint = afterA.leafId;
		originalHashAfterA = hashFile(originalFile);
		result.say(`original ${originalId} at ${originalFile}, checkpoint ${checkpoint} (${afterA.leafType}), sha ${originalHashAfterA}`);

		// The simulated plan is made before the fork, so the id it allocated can be handed to Pi: what the
		// row records is what Pi does with a supplied id, not that two independently generated uuids differ.
		result.phase("the simulated record, and the fork id the simulated policy allocates up front");
		ledger.record("row3", { hostSessionId: "host-A", plan: { action: "new" }, sessionId: originalId, checkpoint, ok: true });
		planForOtherHost = ledger.plan("row3", "host-B");
		result.check(planForOtherHost.action === "fork", `a record from another host planned ${planForOtherHost.action} instead of fork`);
		result.check(planForOtherHost.checkpoint === checkpoint, "the planned fork does not use the recorded checkpoint");

		result.phase("fork at that exact entry, asking fork() for the allocated id");
		const forked = (await bridgeCommand(child1, `/spike-fork ${checkpoint} ${planForOtherHost.allocatedId}`, "SPIKE_FORK")).data;
		result.check(forked.ok === true, `the fork failed: ${forked.error ?? "?"}`);
		forkFile = forked.sessionFile;
		forkId = forked.sessionId;
		result.say(`fork ${forkId} at ${forkFile}, leaf ${forked.leafId} (${forked.leafType}), id asked for ${forked.requestedId}`);
		result.check(forkId !== originalId, "the fork reports the parent's session id");
		result.check(forkFile !== originalFile, "the fork reports the parent's session file");
		result.check(forked.leafId === checkpoint, `the fork's leaf is ${forked.leafId}, not the checkpoint ${checkpoint}`);
		result.check(forked.requestedId === planForOtherHost.allocatedId, `the bridge asked for ${forked.requestedId} instead of the allocated ${planForOtherHost.allocatedId}`);
		result.check(
			forkId !== planForOtherHost.allocatedId,
			"fork() honoured the id it was handed, so the incompatibility this row records is gone and nextSession could keep allocating fork ids",
		);
		result.say(
			`measured Pi behaviour: fork() was called with { position: "at", id: ${planForOtherHost.allocatedId} } and created ${forkId} instead — the option is not read, the id comes from createBranchedSession, and it can only be read back`,
		);

		const sourceEntries = readSessionEntries(originalFile).filter((entry) => entry.type !== "session");
		const forkEntries = readSessionEntries(forkFile).filter((entry) => entry.type !== "session");
		const ancestry = [];
		const byId = new Map(sourceEntries.map((entry) => [entry.id, entry]));
		for (let current = byId.get(checkpoint); current; current = current.parentId ? byId.get(current.parentId) : undefined) ancestry.unshift(current);
		result.say(`ancestry of the checkpoint: ${JSON.stringify(ancestry.map((entry) => entry.id))}`);
		result.say(`fork file entries:          ${JSON.stringify(forkEntries.map((entry) => entry.id))}`);
		result.check(
			JSON.stringify(forkEntries.map((entry) => entry.id)) === JSON.stringify(ancestry.map((entry) => entry.id)),
			"the fork's entries are not exactly the checkpoint's ancestry",
		);
		result.check(
			JSON.stringify(forkEntries.map(entryLabel)) === JSON.stringify(ancestry.map(entryLabel)),
			"the fork's entry contents differ from the ancestry they were copied from",
		);
		const header = readSessionEntries(forkFile)[0];
		result.say(`fork header: id ${header.id}, parentSession ${header.parentSession}`);
		result.check(header.parentSession === originalFile, "the fork header does not point back at the parent session file");

		result.phase("the first turn on the fork carries only the ancestry");
		const run = await runPrompt(child1, "ROW3-F1 fork-only turn.");
		result.check(run.response.success === true, "F1 was rejected");
		const request = server.requests.at(-1);
		result.say(`F1 request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(JSON.stringify(request.roles) === JSON.stringify(["system", "user", "assistant", "user"]), `F1 role sequence is ${JSON.stringify(request.roles)}`);
		result.check(texts[0].includes("ROW3-A") && texts[1].includes("ROW3-A-ANSWER"), "the fork's first turn does not carry the ancestry");
		result.check(texts.at(-1).includes("ROW3-F1"), "F1's own prompt is missing");
		result.check(hashFile(originalFile) === originalHashAfterA, "the parent session file changed while the fork was being written to");
	} finally {
		await child1.close();
	}

	result.phase("continue the original, and check neither file sees the other's prompt");
	const forkHashAfterF1 = hashFile(forkFile);
	const child2 = startChild(dirs, "original", {
		session: { mode: "open", file: originalFile, requireCheckpoint: checkpoint },
		settings: { retry: { enabled: false } },
	});
	try {
		const navigated = (await bridgeCommand(child2, `/spike-navigate ${checkpoint}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === checkpoint, "the restore on the original failed");
		result.check(navigated.sessionId === originalId, "reopening the original produced a different session id");
		const run = await runPrompt(child2, "ROW3-O1 original-only turn.");
		result.check(run.response.success === true, "O1 was rejected");
		const request = server.requests.at(-1);
		result.say(`O1 request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(!texts.some((text) => text.includes("ROW3-F1")), "the fork's prompt reached the original's context");
		result.check(texts.at(-1).includes("ROW3-O1"), "O1's own prompt is missing");
	} finally {
		await child2.close();
	}
	result.check(hashFile(forkFile) === forkHashAfterF1, "the fork's session file changed while the original was being continued");
	result.say(`fork file sha before/after the original's turn: ${forkHashAfterF1} / ${hashFile(forkFile)}`);

	result.phase("the two transcripts, read back");
	result.say("original:");
	for (const line of describeEntries(readSessionEntries(originalFile))) result.say(`  ${line}`);
	result.say("fork:");
	for (const line of describeEntries(readSessionEntries(forkFile))) result.say(`  ${line}`);

	result.phase("first-use fork semantics, simulated");
	result.say(
		`the incompatibility, measured against simulated policy: nextSession allocates the fork's id up front (here ${planForOtherHost.allocatedId}), that id was passed to fork(), and the fork Pi actually created is ${forkId}. Source: core/session-manager.js createBranchedSession calls createSessionId() itself and takes no id, and agent-session-runtime's fork() reads only position and withSession from its options, so the id can only be read back afterwards`,
	);
	result.say("consequence for Fusion: the record rule has to record the fork id the child reports, not one the host chose, which also means a fork's identity does not exist until the fork call returns");
	result.say("simulated Fusion policy only: no Fusion integration exists; the measured half is that a fork at that checkpoint contains exactly the ancestry");
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
}

/** Row 4: the four failure shapes, and what each one leaves behind for the next run. */
async function caseFailures(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	const ledger = new Ledger((line) => result.say(line));
	const HOST = "host-session-1";
	server.install([
		textStep("g1", "ROW4-G1-ANSWER"),
		errorStep("g2"),
		textStep("g3", "ROW4-G3-ANSWER"),
		errorStep("new-run"),
		textStep("new-run-probe", "ROW4-PROBE-ANSWER"),
		textStep("h1", "ROW4-H1-ANSWER"),
		errorStep("fork-first"),
		textStep("h2", "ROW4-H2-ANSWER"),
		textStep("invalid-setup", "ROW4-INVALID-ANSWER"),
	]);

	/* (a) a failed continuation of a session that already has a good checkpoint */
	result.phase("(a) failed continuation: the ledger keeps the last good checkpoint");
	const planA1 = ledger.plan("row4a", HOST);
	const childA = startChild(dirs, "a", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let fileA;
	let checkpointA;
	try {
		await runPrompt(childA, "ROW4-G1 good run.");
		const good = await state(childA);
		fileA = good.sessionFile;
		checkpointA = good.leafId;
		ledger.record("row4a", { hostSessionId: HOST, plan: planA1, sessionId: good.sessionId, checkpoint: checkpointA, ok: true });
		const planA2 = ledger.plan("row4a", HOST);
		const failed = await runPrompt(childA, "ROW4-G2 failing run.");
		result.check(failed.response.success === true, "the failing prompt was rejected before it reached the provider");
		const bad = await state(childA);
		result.say(`leaf after the failure: ${bad.leafId} (${bad.leafType}); last assistant text ${JSON.stringify((await childA.send({ type: "get_last_assistant_text" })).data?.text ?? null)}`);
		ledger.record("row4a", { hostSessionId: HOST, plan: planA2, sessionId: bad.sessionId, checkpoint: bad.leafId, ok: false });
		result.check(ledger.get("row4a").checkpoint === checkpointA, "the failed resume changed the recorded checkpoint");
	} finally {
		await childA.close();
	}
	const planA3 = ledger.plan("row4a", HOST);
	const childA2 = startChild(dirs, "a2", {
		session: { mode: "open", file: fileA, requireCheckpoint: planA3.checkpoint },
		settings: { retry: { enabled: false } },
	});
	try {
		const navigated = (await bridgeCommand(childA2, `/spike-navigate ${planA3.checkpoint}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === planA3.checkpoint, "the restore after the failed continuation failed");
		await runPrompt(childA2, "ROW4-G3 recovery run.");
		const request = server.requests.at(-1);
		result.say(`G3 request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(!texts.some((text) => text.includes("ROW4-G2")), "the failed prompt is still in the recovery context");
		result.check(!texts.some((text) => text.includes("SPIKE_SCRIPTED_FAILURE")), "the provider error text is still in the recovery context");
	} finally {
		await childA2.close();
	}

	/* (b) a new run whose very first prompt fails */
	result.phase("(b) failed NEW run: what the file holds and what a whole-session reopen would send");
	const planB = ledger.plan("row4b", HOST);
	result.check(planB.action === "new", "the first run for a fresh handle did not plan a new session");
	const childB = startChild(dirs, "b", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let fileB;
	try {
		const failed = await runPrompt(childB, "ROW4-NEW failing first run.");
		result.check(failed.response.success === true, "the first prompt was rejected before it reached the provider");
		const after = await state(childB);
		fileB = after.sessionFile;
		result.say(`new-run session id ${after.sessionId}, file ${fileB}, leaf ${after.leafId} (${after.leafType})`);
		result.say(`file exists on disk: ${fs.existsSync(fileB)}`);
		ledger.record("row4b", { hostSessionId: HOST, plan: planB, sessionId: after.sessionId, checkpoint: after.leafId, ok: false });
		const record = ledger.get("row4b");
		result.check(record.sessionId !== undefined && record.checkpoint === undefined, "a failed new run was not recorded as id-without-checkpoint");
	} finally {
		await childB.close();
	}
	const reopenable = Boolean(fileB) && fs.existsSync(fileB);
	if (reopenable) {
		result.say("the failed new run's file, read back:");
		for (const line of describeEntries(readSessionEntries(fileB))) result.say(`  ${line}`);
	} else {
		result.say("measured Pi behaviour: no session file exists, because persistence is deferred until the first assistant message");
	}
	if (!reopenable) {
		// Refusing here rather than reopening: the preflight would refuse a null path anyway, and the
		// case would be recorded as "case threw" instead of as the sub-row it could not measure.
		result.unproven = `the failed new run left no readable session file (${JSON.stringify(fileB)}), so what a "whole session" contains on Pi could not be measured, and the id-without-checkpoint record has no measured meaning`;
		result.say(`unproven: ${result.unproven}`);
	} else {
		const childB2 = startChild(dirs, "b2", { session: { mode: "open", file: fileB }, settings: { retry: { enabled: false } } });
		try {
			const reopened = await state(childB2);
			result.say(`whole-session reopen: leaf ${reopened.leafId} (${reopened.leafType}), context entries ${JSON.stringify(reopened.contextEntryTypes)}`);
			await runPrompt(childB2, "ROW4-PROBE what a whole-session continuation actually sends.");
			const request = server.requests.at(-1);
			result.say(`whole-session continuation request: ${describeRequest(request)}`);
			const texts = conversationTexts(request);
			const carriesFailedPrompt = texts.some((text) => text.includes("ROW4-NEW"));
			result.say(`measured Pi behaviour: the failed prompt is ${carriesFailedPrompt ? "REPLAYED into" : "absent from"} the whole-session continuation`);
			const errorEntryOnBranch = reopened.contextEntryTypes.at(-1) === "message:assistant";
			result.say(
				`measured Pi behaviour: the error assistant entry is ${errorEntryOnBranch ? "on" : "off"} the restored branch, yet the outgoing roles are ${JSON.stringify(request.roles)} — the openai-completions converter drops an assistant message that has no content and no tool calls`,
			);
			const consecutiveUsers = request.roles.some((role, index) => index > 0 && role === "user" && request.roles[index - 1] === "user");
			result.say(`measured hazard: dropping it leaves two consecutive user messages in the payload: ${consecutiveUsers}`);
			// The three facts below are what "whole session" means here; asserting them is what keeps the
			// sub-row from printing pass if Pi changed any of them underneath it.
			result.check(
				carriesFailedPrompt === true,
				"the failed prompt is no longer replayed into a whole-session continuation, so what a failed NEW run's session contains has changed and the record rule needs re-measuring",
			);
			result.check(
				errorEntryOnBranch === true,
				"the error assistant entry is no longer the last entry of the reopened branch, so the hazard this sub-row documents has changed",
			);
			result.check(
				consecutiveUsers === true,
				"the dropped error entry no longer leaves two consecutive user messages in the payload, so the documented hazard has changed",
			);
			result.say("this case records what is there; it does not claim a whole-session resume is safe for Fusion");
		} finally {
			await childB2.close();
		}
	}

	/* (c) a fork that was created and whose first continuation then failed */
	result.phase("(c) failed fork AFTER creation: recorded with the fork id and the fork-at checkpoint");
	const planC1 = ledger.plan("row4c", HOST);
	const childC = startChild(dirs, "c", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let forkFile;
	let forkId;
	let forkAt;
	try {
		await runPrompt(childC, "ROW4-H1 parent turn.");
		const parent = await state(childC);
		forkAt = parent.leafId;
		ledger.record("row4c", { hostSessionId: HOST, plan: planC1, sessionId: parent.sessionId, checkpoint: forkAt, ok: true });
		const planC2 = ledger.plan("row4c", "host-session-2");
		result.check(planC2.action === "fork", `the other host planned ${planC2.action} instead of fork`);
		const forked = (await bridgeCommand(childC, `/spike-fork ${planC2.checkpoint}`, "SPIKE_FORK")).data;
		result.check(forked.ok === true, `the fork failed before its first continuation: ${forked.error ?? "?"}`);
		forkFile = forked.sessionFile;
		forkId = forked.sessionId;
		result.say(`fork created: ${forkId} at ${forkFile}, leaf ${forked.leafId}`);
		const failed = await runPrompt(childC, "ROW4-FORK-FIRST failing first continuation on the fork.");
		result.check(failed.response.success === true, "the fork's first prompt was rejected before it reached the provider");
		const after = await state(childC);
		result.say(`fork leaf after the failure: ${after.leafId} (${after.leafType})`);
		ledger.record("row4c", { hostSessionId: "host-session-2", plan: planC2, sessionId: forkId, checkpoint: after.leafId, ok: false });
		const record = ledger.get("row4c");
		result.check(record.sessionId === forkId, `the ledger recorded ${record.sessionId} instead of the fork id ${forkId}`);
		result.check(record.checkpoint === forkAt, `the ledger recorded checkpoint ${record.checkpoint} instead of the fork-at ${forkAt}`);
	} finally {
		await childC.close();
	}
	const planC3 = ledger.plan("row4c", "host-session-2");
	result.check(planC3.action === "resume" && planC3.sessionId === forkId, "the next use of the fork did not plan a resume of the fork itself");
	const childC2 = startChild(dirs, "c2", {
		session: { mode: "open", file: forkFile, requireCheckpoint: planC3.checkpoint },
		settings: { retry: { enabled: false } },
	});
	try {
		const navigated = (await bridgeCommand(childC2, `/spike-navigate ${planC3.checkpoint}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === planC3.checkpoint, "the restore on the fork failed");
		await runPrompt(childC2, "ROW4-H2 second continuation on the fork.");
		const request = server.requests.at(-1);
		result.say(`fork recovery request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(JSON.stringify(request.roles) === JSON.stringify(["system", "user", "assistant", "user"]), `fork recovery role sequence is ${JSON.stringify(request.roles)}`);
		result.check(!texts.some((text) => text.includes("ROW4-FORK-FIRST")), "the fork's failed prompt is still in its recovery context");
		result.check(texts[0].includes("ROW4-H1"), "the fork's recovery context lost the ancestry");
	} finally {
		await childC2.close();
	}

	/* (d) targets that do not exist: the command fails, the session does not move */
	result.phase("(d) invalid navigation and fork targets");
	const childD = startChild(dirs, "d", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	try {
		await runPrompt(childD, "ROW4-INVALID setup turn.");
		const before = await state(childD);
		const requestsBefore = server.requests.length;
		for (const attempt of [
			{ command: `/spike-navigate ${ABSENT_ENTRY_ID}`, prefix: "SPIKE_NAVIGATE", label: "navigateTree" },
			{ command: `/spike-fork ${ABSENT_ENTRY_ID}`, prefix: "SPIKE_FORK", label: "fork" },
		]) {
			const mark = childD.mark();
			const response = await childD.send({ type: "prompt", message: attempt.command });
			const ack = await childD.waitNotification(attempt.prefix, mark);
			const errors = await childD.waitFrom(mark, (event) => event.type === "extension_error", COMMAND_DEADLINE_MS, `${attempt.label} extension_error`);
			result.say(`${attempt.label} on an absent id: prompt success=${response.success}, ack ${JSON.stringify(ack)}`);
			result.say(`${attempt.label} extension_error: ${JSON.stringify(errors)}`);
			result.check(response.success === true, `the prompt carrying an invalid ${attempt.label} target did not answer success:true`);
			result.check(ack.ok === false, `the bridge reported success for an invalid ${attempt.label} target`);
			result.check(errors.event === "command" && typeof errors.error === "string", `the invalid ${attempt.label} target produced no usable extension_error`);
			result.say(`measured Pi behaviour: the failure surfaces as extensionPath ${errors.extensionPath}, not as a failed prompt response`);
		}
		const after = await state(childD);
		result.check(after.sessionId === before.sessionId, `the session id changed from ${before.sessionId} to ${after.sessionId}`);
		result.check(after.sessionFile === before.sessionFile, "the session file changed after an invalid target");
		result.check(after.leafId === before.leafId, `the leaf moved from ${before.leafId} to ${after.leafId}`);
		result.check(after.entryCount === before.entryCount, `the entry count changed from ${before.entryCount} to ${after.entryCount}`);
		result.say("simulated Fusion policy: the harness sends no prompt for the run after a refused restore or fork");
		result.check(server.requests.length === requestsBefore, `an invalid target still produced ${server.requests.length - requestsBefore} provider request(s)`);
	} finally {
		await childD.close();
	}

	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s): ${JSON.stringify(server.unscripted.map((r) => r.note))}`);
}

/* ------------------------------------------------------- stage B: questions */

/** Row 5: a question blocks its child until exactly one answer arrives, and a second one changes nothing. */
async function caseQuestions(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	// ask_orchestrator is registered by the bridge but filtered out unless the run's tool list names it.
	const TOOLS = ["read", "ask_orchestrator"];
	const SETTINGS = { retry: { enabled: false } };
	const HOLD_MS = 2000;
	const QUIET_MS = 2000;

	result.phase(`(a) the question holds the provider for a measured ${HOLD_MS}ms window, and one answer releases it`);
	server.install([
		toolCallStep("a-question", "ask_orchestrator", { question: "ROW5-QA which branch should I take?" }, "call_row5_a1"),
		textStep("a-final", "ROW5-A-FINAL"),
	]);
	const childA = startChild(dirs, "a", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
	try {
		const mark = childA.mark();
		const prompt = await childA.send({ type: "prompt", message: "ROW5-A ask the host a question." });
		result.check(prompt.success === true, "the prompt that should produce a question was rejected");
		const dialog = await waitInputRequest(childA, mark);
		result.say(`extension_ui_request: method ${dialog.method}, title ${JSON.stringify(dialog.title)}, timeout ${JSON.stringify(dialog.timeout)}`);
		const asked = await childA.waitNotification("SPIKE_QUESTION", mark);
		result.say(`the tool's own view of the open question: ${JSON.stringify(asked)}`);
		const requestsWhenAsked = server.requests.length;
		result.check(requestsWhenAsked === 1, `expected one provider request before the answer, got ${requestsWhenAsked}`);
		await sleep(HOLD_MS);
		result.say(`provider requests that arrived during the ${HOLD_MS}ms hold: ${server.requests.length - requestsWhenAsked}`);
		result.check(server.requests.length === requestsWhenAsked, "the provider was called again while the question was still waiting");

		const answerMark = childA.mark();
		childA.write({ type: "extension_ui_response", id: dialog.id, value: "ROW5-A1-ANSWER" });
		const answered = await childA.waitNotification("SPIKE_QUESTION_END", answerMark);
		result.check(answered.outcome === "answered", `the tool reported outcome ${answered.outcome} for an answered question`);
		// A second response for the same id, sent while the run is still going.
		childA.write({ type: "extension_ui_response", id: dialog.id, value: "ROW5-DUPLICATE-DURING-RUN" });
		await childA.waitSettled(mark);
		result.check(server.requests.length === 2, `expected two provider requests after the answer, got ${server.requests.length}`);
		const second = server.requests[1];
		result.say(`request 2: ${describeRequest(second)}`);
		const toolResults = second.messages.filter((message) => message.role === "tool");
		result.check(toolResults.length === 1, `request 2 carries ${toolResults.length} tool results instead of one`);
		result.check(toolResults[0]?.text.includes("ROW5-A1-ANSWER"), `the tool result is ${JSON.stringify(toolResults[0]?.text)}, not the answer`);
		result.check(toolResults[0]?.toolCallId === "call_row5_a1", `the tool result is correlated to ${toolResults[0]?.toolCallId}`);
		result.check(!conversationTexts(second).some((text) => text.includes("ROW5-DUPLICATE")), "a duplicate answer reached the provider");

		const afterSettle = childA.mark();
		childA.write({ type: "extension_ui_response", id: dialog.id, value: "ROW5-DUPLICATE-AFTER-SETTLE" });
		await sleep(QUIET_MS);
		result.say(`events in the ${QUIET_MS}ms after a post-settle duplicate: ${JSON.stringify(eventTypes(childA, afterSettle))}`);
		result.check(childA.events.length === afterSettle, "a duplicate answer after settle produced further events");
		result.check(server.requests.length === 2, `duplicate answers produced extra provider requests (${server.requests.length})`);
		result.say("measured Pi behaviour: a second extension_ui_response with the same id is silently dropped — no response, no error, no event, no second tool result");
		result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (a)`);
	} finally {
		await childA.close();
	}

	result.phase("(b) two sequential questions, each blocking in turn");
	server.install([
		toolCallStep("b-q1", "ask_orchestrator", { question: "ROW5-QB1 first question?" }, "call_row5_b1"),
		toolCallStep("b-q2", "ask_orchestrator", { question: "ROW5-QB2 second question?" }, "call_row5_b2"),
		textStep("b-final", "ROW5-B-FINAL"),
	]);
	const childB = startChild(dirs, "b", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
	try {
		const mark = childB.mark();
		await childB.send({ type: "prompt", message: "ROW5-B ask two questions in a row." });
		let cursor = mark;
		for (const [index, answer] of [["b1", "ROW5-B1-ANSWER"], ["b2", "ROW5-B2-ANSWER"]]) {
			const dialog = await waitInputRequest(childB, cursor);
			cursor = childB.mark();
			result.say(`question ${index}: title ${JSON.stringify(dialog.title)}, provider requests so far ${server.requests.length}`);
			childB.write({ type: "extension_ui_response", id: dialog.id, value: answer });
			await childB.waitNotification("SPIKE_QUESTION_END", cursor);
		}
		await childB.waitSettled(mark);
		result.check(server.requests.length === 3, `expected three provider requests, got ${server.requests.length}`);
		const third = server.requests[2];
		result.say(`request 3: ${describeRequest(third)}`);
		const answers = third.messages.filter((message) => message.role === "tool").map((message) => message.text);
		result.say(`tool results in request 3, in order: ${JSON.stringify(answers)}`);
		result.check(answers.length === 2, `request 3 carries ${answers.length} tool results instead of two`);
		result.check(
			answers[0]?.includes("ROW5-B1-ANSWER") && answers[1]?.includes("ROW5-B2-ANSWER"),
			"the two answers are not in the order they were given",
		);
		result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (b)`);
	} finally {
		await childB.close();
	}

	result.phase("(c) a steer queued while the question waits lands after the tool result");
	server.install([
		toolCallStep("c-question", "ask_orchestrator", { question: "ROW5-QC a question to steer around?" }, "call_row5_c1"),
		textStep("c-final", "ROW5-C-FINAL"),
	]);
	const childC = startChild(dirs, "c", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
	try {
		const mark = childC.mark();
		await childC.send({ type: "prompt", message: "ROW5-C ask a question I will steer around." });
		const dialog = await waitInputRequest(childC, mark);
		const steered = await childC.send({ type: "steer", message: "ROW5-STEER steer queued while the question waits." });
		result.check(steered.success === true, "the steer was rejected while a question was open");
		await sleep(QUIET_MS);
		result.say(`provider requests in the ${QUIET_MS}ms between the steer and the answer: ${server.requests.length - 1}`);
		result.check(server.requests.length === 1, "the queued steer reached the provider before the question was answered");
		childC.write({ type: "extension_ui_response", id: dialog.id, value: "ROW5-C1-ANSWER" });
		await childC.waitSettled(mark);
		result.check(server.requests.length === 2, `expected two provider requests, got ${server.requests.length}`);
		const second = server.requests[1];
		result.say(`request 2: ${describeRequest(second)}`);
		const toolIndex = second.messages.findIndex((message) => message.role === "tool");
		const steerIndex = second.messages.findIndex((message) => message.role === "user" && message.text.includes("ROW5-STEER"));
		result.say(`positions in request 2: tool result at ${toolIndex}, steer at ${steerIndex}, of ${second.messages.length} messages`);
		result.check(toolIndex !== -1, "the tool result is missing from the turn that follows the answer");
		result.check(steerIndex !== -1, "the steer never reached the provider");
		result.check(toolIndex < steerIndex, "the steer was placed before the tool result");
		result.check(steerIndex === second.messages.length - 1, "the steer is not the last message before the next assistant turn");
		result.say("measured Pi behaviour: steering queued during a tool call is drained after turn_end and injected as an ordinary user message at the top of the next turn");
		result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (c)`);
	} finally {
		await childC.close();
	}

	result.say("this case proves the child protocol only: which side supplies the answer is host/user arbitration, which the spike does not model");
}

/* ---------------------------------------------------- stage B: cancellation */

/** Row 6: what abort actually stops — queued work, an open question, and a detached descendant. */
async function caseCancellation(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	const TOOLS = ["read", "bash", "ask_orchestrator"];
	const SETTINGS = { retry: { enabled: false } };
	const QUIET_MS = 2500;

	result.phase("(a) clear_queue before abort: a queued steer cannot restart the run");
	// Only the question is scripted, so any further provider call is recorded as an unscripted failure.
	server.install([toolCallStep("a-question", "ask_orchestrator", { question: "ROW6-QA a question I will cancel?" }, "call_row6_a1")]);
	const childA = startChild(dirs, "a", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
	let sessionFileA;
	try {
		const mark = childA.mark();
		await childA.send({ type: "prompt", message: "ROW6-A ask a question I will cancel." });
		const dialog = await waitInputRequest(childA, mark);
		const steered = await childA.send({ type: "steer", message: "ROW6-A-STEER queued before the cancellation." });
		result.check(steered.success === true, "the steer was rejected");
		const cleared = await childA.send({ type: "clear_queue" });
		result.say(`clear_queue returned ${JSON.stringify(cleared.data)}`);
		result.check(
			(cleared.data?.steering ?? []).some((text) => text.includes("ROW6-A-STEER")),
			"clear_queue did not return the queued steer, so the harness cannot prove the queue was empty before abort",
		);
		const abortMark = childA.mark();
		const aborted = await childA.send({ type: "abort" });
		result.check(aborted.success === true, `abort answered success=${aborted.success} error=${aborted.error ?? "-"}`);
		const questionEnd = await childA.waitNotification("SPIKE_QUESTION_END", mark);
		result.say(`the tool's own view on abort: ${JSON.stringify(questionEnd)}`);
		result.check(questionEnd.outcome === "cancelled", `the tool reported ${questionEnd.outcome} instead of a cancellation`);
		result.check(questionEnd.aborted === true, "the tool's AbortSignal was not aborted, so the dialog was released by something else");
		await childA.waitSettled(mark);
		const replies = childA.events.slice(abortMark).filter((event) => event.id === dialog.id);
		result.say(`stdout messages carrying the pending dialog id after abort: ${JSON.stringify(replies)}`);
		result.check(replies.length === 0, "Pi sent something for the cancelled dialog id, which the harness did not model");
		result.say("measured Pi behaviour: the pending extension_ui_request is resolved inside the child by the forwarded AbortSignal; nothing is written back on stdout, so a host must treat abort as the dialog's answer");
		await sleep(QUIET_MS);
		result.say(`provider requests in the ${QUIET_MS}ms after abort: ${server.requests.length - 1}`);
		result.check(server.requests.length === 1, `abort after clear_queue still produced ${server.requests.length - 1} further provider request(s)`);
		result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) after abort`);
		const identity = await state(childA);
		sessionFileA = identity.sessionFile;
		result.say(`state after abort: leaf ${identity.leafId} (${identity.leafType}), isIdle ${identity.isIdle}`);
	} finally {
		await childA.close();
	}
	if (sessionFileA && fs.existsSync(sessionFileA)) {
		const toolResult = readSessionEntries(sessionFileA)
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
			.at(-1);
		result.say(`the cancelled question's tool result: ${JSON.stringify(messageText(toolResult?.message ?? {}).slice(0, 120))}`);
		result.check(
			messageText(toolResult?.message ?? {}).includes("cancelled or aborted"),
			"the cancelled question did not leave a tool result that names the cancellation",
		);
	} else {
		result.check(false, "the aborted run left no session file to read the tool result from");
	}

	result.phase("(a2) counterexample: abort with work still queued");
	server.install([
		toolCallStep("a2-question", "ask_orchestrator", { question: "ROW6-QA2 a question I will cancel?" }, "call_row6_a2"),
		textStep("a2-restart", "ROW6-A2-RESTARTED"),
	]);
	const childA2 = startChild(dirs, "a2", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
	try {
		const mark = childA2.mark();
		await childA2.send({ type: "prompt", message: "ROW6-A2 ask a question I will cancel without clearing the queue." });
		const dialog = await waitInputRequest(childA2, mark);
		await childA2.send({ type: "steer", message: "ROW6-A2-STEER queued steer, not cleared." });
		await childA2.send({ type: "follow_up", message: "ROW6-A2-FOLLOWUP queued follow-up, not cleared." });
		const aborted = await childA2.send({ type: "abort" });
		result.check(aborted.success === true, "abort did not answer success in the counterexample");
		result.say(`dialog ${dialog.id} was abandoned without an answer`);
		await sleep(QUIET_MS);
		const restarted = server.requests.length - 1;
		result.say(`provider requests in the ${QUIET_MS}ms after an abort with a steer and a follow-up still queued: ${restarted}`);
		for (const request of server.requests.slice(1)) result.say(`  restarted request: ${describeRequest(request)}`);
		result.check(restarted > 0, "abort with queued work produced no further provider request, so this case shows no counterexample and clear_queue may no longer be required");
		const texts = server.requests.slice(1).flatMap(conversationTexts);
		result.say(
			`the restarted turn carried the steer: ${texts.some((text) => text.includes("ROW6-A2-STEER"))}, the follow-up: ${texts.some((text) => text.includes("ROW6-A2-FOLLOWUP"))}`,
		);
		result.say("measured Pi behaviour: abort waits for idle and then continues queued messages under a fresh abort controller, so clear_queue must precede abort");
		result.check(
			server.unscripted.length === 0,
			`the fixture saw ${server.unscripted.length} unscripted request(s) in phase (a2): ${JSON.stringify(server.unscripted.map((request) => request.note))}`,
		);
	} finally {
		await childA2.close();
	}

	result.phase("(b) a bash tool call, its shell, and a detached grandchild that leaves the killed group");
	const setsid = "/usr/bin/setsid";
	if (!fs.existsSync(setsid)) {
		result.unproven = `setsid is not installed at ${setsid}, so the detached-grandchild half of row 6 cannot be measured here`;
		result.say(result.unproven);
	} else {
		const pidsDir = path.join(dirs.caseRoot, "pids");
		fs.mkdirSync(pidsDir, { recursive: true });
		const shellPidFile = path.join(pidsDir, "shell");
		const grandchildPidFile = path.join(pidsDir, "grandchild");
		const command = `echo $$ > "${shellPidFile}"; ${setsid} sh -c 'echo $$ > "${grandchildPidFile}"; exec sleep 300' & sleep 300`;
		server.install([toolCallStep("b-bash", "bash", { command }, "call_row6_b1")]);
		const childB = startChild(dirs, "b", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
		let shellPid;
		let grandchildPid;
		let sessionFileB;
		try {
			const mark = childB.mark();
			await childB.send({ type: "prompt", message: "ROW6-B run a command that outlives its shell." });
			// collectPidFiles registers each pid as its own file becomes readable, so both are in the cleanup
			// registry — and reachable by the interrupt handler — long before the abort.
			const pids = await collectPidFiles({ shell: shellPidFile, grandchild: grandchildPidFile });
			shellPid = pids.shell;
			grandchildPid = pids.grandchild;
			result.say(`recorded pids: pi child ${childB.child.pid}, bash shell ${shellPid}, detached grandchild ${grandchildPid}`);
			result.check(
				pidAlive(childB.child.pid) && pidAlive(shellPid) && pidAlive(grandchildPid),
				"one of the recorded pids was already dead before the abort",
			);
			// The interrupt handler's last-resort net, measured rather than asserted: an interrupt can arrive in
			// the window between a descendant writing its pid file and a poll reading it, so cleanup sweeps those
			// files. Forget the grandchild on purpose and require the sweep to find it again.
			spawnedPids.delete(grandchildPid);
			const swept = sweepPidFiles(dirs.root);
			result.say(`pid-file sweep with the live grandchild deliberately unregistered: ${JSON.stringify(swept)}`);
			result.check(swept.includes(grandchildPid), `the pid-file sweep did not recover the unregistered grandchild ${grandchildPid}`);
			// Re-registered whatever the sweep concluded, so a failed sweep cannot turn into a leaked process.
			registerPid(grandchildPid);
			result.check(spawnedPids.has(grandchildPid), `the grandchild ${grandchildPid} is not in the cleanup registry`);
			const aborted = await childB.send({ type: "abort" });
			result.check(aborted.success === true, `abort answered success=${aborted.success} error=${aborted.error ?? "-"}`);
			await childB.waitSettled(mark);
			await sleep(500);
			const alive = { piChild: pidAlive(childB.child.pid), shell: pidAlive(shellPid), grandchild: pidAlive(grandchildPid) };
			result.say(`alive 500ms after abort: ${JSON.stringify(alive)}`);
			result.check(alive.shell === false, "the bash shell survived Pi's abort, so the documented process-group SIGKILL did not reach it");
			// A Pi that reached the grandchild would be an improvement, not a harness failure: the row
			// documents an escape, so a closed escape leaves the row unproven rather than failed.
			if (alive.grandchild !== true) {
				result.unproven =
					"Pi's abort now reaches a setsid descendant, so the escape this row documents has closed; the row must be rewritten before it is reported either way";
				result.say(`unproven: ${result.unproven}`);
			} else {
				result.say("measured Pi behaviour: the detached grandchild outlived the abort, so the kill stops at the process-group boundary");
			}
			result.say("measured Pi behaviour: abort calls killProcessTree, which sends SIGKILL to the shell's process group only — no SIGTERM, no grace, and nothing that reaches a setsid descendant");
			result.say(`provider requests after abort: ${server.requests.length - 1}; unscripted ${server.unscripted.length}`);
			result.check(server.requests.length === 1, `the aborted bash turn still produced ${server.requests.length - 1} further provider request(s)`);
			const identity = await state(childB);
			sessionFileB = identity.sessionFile;
		} finally {
			// Register whatever the command started even on a failure path, so the harness's own
			// cleanup reaches it when the phase never got as far as recording the pids itself.
			for (const file of [shellPidFile, grandchildPidFile]) {
				const pid = readPidFile(file);
				if (pid !== undefined) registerPid(pid);
			}
			await childB.close();
		}

		result.phase("explicit termination of every recorded pid, because a group kill is not enough");
		for (const [label, pid] of [
			["bash shell", shellPid],
			["detached grandchild", grandchildPid],
		]) {
			const outcome = await terminatePid(pid);
			// Only forget a pid once it is gone: a survivor dropped from the registry would be unreachable for
			// the final cleanup and the interrupt handler, turning a detected failure into a silent leak.
			if (!outcome.alive) spawnedPids.delete(pid);
			result.say(`${label} (${pid}): ${outcome.attempts.length > 0 ? outcome.attempts.join(", ") : "already gone"} -> alive ${outcome.alive}`);
		}
		result.check(
			!pidAlive(shellPid) && !pidAlive(grandchildPid),
			"a recorded pid is still alive after explicit per-pid and per-group SIGTERM then SIGKILL",
		);
		result.say("measured requirement: a host that cancels a run must record descendant pids itself and terminate them per pid; Pi's own cleanup is a group SIGKILL and stops at the group boundary");
		result.check(
			server.unscripted.length === 0,
			`the fixture saw ${server.unscripted.length} unscripted request(s) in phase (b): ${JSON.stringify(server.unscripted.map((request) => request.note))}`,
		);
		if (sessionFileB && fs.existsSync(sessionFileB)) {
			const toolResult = readSessionEntries(sessionFileB)
				.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
				.at(-1);
			const text = messageText(toolResult?.message ?? {});
			result.say(`the aborted bash tool result: ${JSON.stringify(text.slice(0, 120))}`);
			result.check(text.includes("Command aborted"), "the aborted bash call did not leave a tool result that names the abort");
		} else {
			result.check(false, "the aborted bash run left no session file to read the tool result from");
		}

		result.phase("(c) ending the child's stdin instead of aborting: the same group boundary applies");
		const eofShellPidFile = path.join(pidsDir, "shell-eof");
		const eofGrandchildPidFile = path.join(pidsDir, "grandchild-eof");
		const eofCommand = `echo $$ > "${eofShellPidFile}"; ${setsid} sh -c 'echo $$ > "${eofGrandchildPidFile}"; exec sleep 300' & sleep 300`;
		server.install([toolCallStep("c-bash", "bash", { command: eofCommand }, "call_row6_c1")]);
		const childC = startChild(dirs, "c", { session: { mode: "create" }, tools: TOOLS, settings: SETTINGS });
		let eofShellPid;
		let eofGrandchildPid;
		try {
			await childC.send({ type: "prompt", message: "ROW6-C run a long command and then take my stdin away." });
			const pids = await collectPidFiles({ shell: eofShellPidFile, grandchild: eofGrandchildPidFile });
			eofShellPid = pids.shell;
			eofGrandchildPid = pids.grandchild;
			result.say(`recorded pids: pi child ${childC.child.pid}, bash shell ${eofShellPid}, detached grandchild ${eofGrandchildPid}`);
		} finally {
			for (const file of [eofShellPidFile, eofGrandchildPidFile]) {
				const pid = readPidFile(file);
				if (pid !== undefined) registerPid(pid);
			}
			const exit = await childC.close();
			result.say(`the child's exit after its stdin ended: ${JSON.stringify(exit)} (the harness allows ${EXIT_DEADLINE_MS}ms before killing its group)`);
		}
		await sleep(500);
		const eofAlive = { shell: pidAlive(eofShellPid), grandchild: pidAlive(eofGrandchildPid) };
		result.say(`alive after the child is gone: ${JSON.stringify(eofAlive)}`);
		result.check(eofAlive.shell === false, "the bash shell survived the child's own shutdown");
		if (eofAlive.grandchild !== true) {
			result.unproven =
				"a stdin-EOF shutdown now reaches a setsid descendant, so the group boundary this row documents has moved; the row must be rewritten before it is reported either way";
			result.say(`unproven: ${result.unproven}`);
		} else {
			result.say("measured Pi behaviour: the detached grandchild outlived the child's own shutdown too, at the same group boundary");
		}
		result.say(
			"measured Pi behaviour: a clean stdin-EOF shutdown disposes the runtime, which calls agent.abort(), so the running bash call is killed by exactly the same process-group SIGKILL as an explicit abort — and stops at exactly the same boundary. Source: killTrackedDetachedChildren runs only from Pi's SIGTERM and SIGHUP handlers, and it is a group kill too",
		);
		for (const [label, pid] of [
			["bash shell", eofShellPid],
			["detached grandchild", eofGrandchildPid],
		]) {
			const outcome = await terminatePid(pid);
			// Only forget a pid once it is gone: a survivor dropped from the registry would be unreachable for
			// the final cleanup and the interrupt handler, turning a detected failure into a silent leak.
			if (!outcome.alive) spawnedPids.delete(pid);
			result.say(`${label} (${pid}): ${outcome.attempts.length > 0 ? outcome.attempts.join(", ") : "already gone"} -> alive ${outcome.alive}`);
		}
		result.check(!pidAlive(eofShellPid) && !pidAlive(eofGrandchildPid), "a recorded pid survived explicit per-pid and per-group SIGTERM then SIGKILL");
		result.say(
			"measured requirement: neither exit path measured here — an explicit abort or closing the child's stdin — reaches a descendant that called setsid, so the host must record descendant pids itself and terminate them per pid. The SIGTERM path is not measured here; source says it is killTrackedDetachedChildren, which is the same group kill",
		);
		result.check(
			server.unscripted.length === 0,
			`the fixture saw ${server.unscripted.length} unscripted request(s) in phase (c): ${JSON.stringify(server.unscripted.map((request) => request.note))}`,
		);
	}
}

/* ---------------------------------------- stage B: retry and auto compaction */

/**
 * Small enough that a scripted usage chunk crosses the threshold without a large payload, and still
 * comfortably above pi-ai's CONTEXT_SAFETY_TOKENS of 4096: below that every request's max_tokens is
 * clamped to 1, which phase (e) measures on purpose and the compaction phases must not run into.
 */
const COMPACTION_CONTEXT_WINDOW = 40_000;
const COMPACTION_RESERVE_TOKENS = 12_000;
/** Low enough that the cut point lands on the second turn instead of keeping the whole branch. */
const COMPACTION_KEEP_RECENT_TOKENS = 20;
/** prompt_tokens + completion_tokens is what Pi reads as the context size, so this crosses 28000. */
const COMPACTION_TRIGGER_PROMPT_TOKENS = 30_000;
/** A window at or below pi-ai's 4096-token safety margin, used only to measure the clamp. */
const DEGENERATE_CONTEXT_WINDOW = 4000;
/** 400 characters, so the padded turn's own chars/4 estimate alone exceeds keepRecentTokens. */
const LONG_TURN_PADDING = "padding ".repeat(50);

const COMPACTION_SETTINGS = {
	retry: { enabled: false },
	compaction: { enabled: true, reserveTokens: COMPACTION_RESERVE_TOKENS, keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS },
};
/** Every other phase in a small-window case must switch compaction off, or every turn would compact. */
const NO_COMPACTION_SETTINGS = { retry: { enabled: false }, compaction: { enabled: false } };

const thresholdScript = (marker, summaryText) => [
	textStep(`${marker}-t1`, `${marker}-T1-ANSWER`),
	textStep(`${marker}-t2`, `${marker}-T2A`, { prompt_tokens: COMPACTION_TRIGGER_PROMPT_TOKENS, completion_tokens: 5 }),
	textStep(`${marker}-summary`, summaryText),
];

/**
 * Two turns whose second crosses the threshold, with the automatic compaction sequence asserted where
 * it is common to every caller. Returns the identities a checkpoint rule needs; the caller closes the child.
 */
async function driveThresholdCompaction(dirs, server, result, { label, marker, summaryText }) {
	server.install(thresholdScript(marker, summaryText));
	const child = startChild(dirs, label, { session: { mode: "create" }, settings: COMPACTION_SETTINGS });
	try {
		await runPrompt(child, `${marker}-T1 first turn.`);
		const afterT1 = await state(child);
		result.say(`T1 settled: leaf ${afterT1.leafId} (${afterT1.leafType})`);
		const mark = child.mark();
		const statsBefore = await readStats(child);
		const run = await runPrompt(child, `${marker}-T2 second turn, padded so the cut point lands on it. ${LONG_TURN_PADDING}`);
		result.check(run.response.success === true, "the threshold turn's prompt was rejected");
		result.say(`events after the threshold turn: ${JSON.stringify(eventTypes(child, mark))}`);

		const startIndex = eventIndex(child, mark, (event) => event.type === "compaction_start");
		const endIndex = eventIndex(child, mark, (event) => event.type === "compaction_end");
		const settledIndex = eventIndex(child, mark, (event) => event.type === "agent_settled");
		result.check(startIndex !== -1, "no compaction_start was emitted, so the threshold was never crossed");
		result.check(child.events[startIndex]?.reason === "threshold", `compaction_start reason is ${child.events[startIndex]?.reason}, not threshold`);
		result.check(endIndex > startIndex, "compaction_end did not follow compaction_start");
		const compactionEnd = child.events[endIndex] ?? {};
		result.check(compactionEnd.aborted === false, `compaction_end reports aborted=${compactionEnd.aborted} errorMessage=${compactionEnd.errorMessage ?? "-"}`);
		result.check(Boolean(compactionEnd.result), `compaction_end carries no result: ${compactionEnd.errorMessage ?? "(no error message)"}`);
		result.check(settledIndex > endIndex, "agent_settled was emitted before compaction_end, so settle does not wait for recovery work");
		result.say(
			`compaction result: firstKeptEntryId ${compactionEnd.result?.firstKeptEntryId}, tokensBefore ${compactionEnd.result?.tokensBefore}, estimatedTokensAfter ${compactionEnd.result?.estimatedTokensAfter}, summary usage total ${compactionEnd.result?.usage?.totalTokens ?? null}`,
		);

		const summaryRequests = server.requests.filter(isSummaryRequest);
		result.check(summaryRequests.length === 1, `expected exactly one summary request, got ${summaryRequests.length}`);
		const summaryRequest = summaryRequests[0];
		if (summaryRequest) {
			const conversation = summaryRequest.messages.find((message) => message.role === "user")?.text ?? "";
			result.say(
				`summary request ${summaryRequest.index}: system ${JSON.stringify(summaryRequest.systemText.slice(0, 44))}, tools key present ${summaryRequest.hasToolsKey}, maxTokens ${summaryRequest.maxTokens}`,
			);
			result.check(conversation.includes(`${marker}-T1 first turn`), "the summary request does not carry the turn it is supposed to summarise");
			result.check(!conversation.includes(`${marker}-T2 second turn`), "the summary request also carries the retained turn, so the cut point is not where this case assumes");
			result.check(
				summaryRequest.maxTokens > 1,
				`the summary request asked for max_tokens ${summaryRequest.maxTokens}; pi-ai clamps it to contextWindow - estimated context - 4096, so this case's window is too small to summarise at all`,
			);
		}

		const afterCompaction = await state(child);
		result.say(`leaf at settle: ${afterCompaction.leafId} (${afterCompaction.leafType}), context entries ${JSON.stringify(afterCompaction.contextEntryTypes)}`);
		result.check(afterCompaction.leafType === "compaction", `the leaf at settle is ${afterCompaction.leafType}, not the compaction entry`);
		const statsAfter = await readStats(child);
		result.say(`stats delta over the threshold turn and its compaction: ${JSON.stringify(statsDelta(statsBefore, statsAfter))}`);
		result.say(
			`fixture usage for that turn ${JSON.stringify(server.requests[1]?.usageSent)} and for the summary ${JSON.stringify(summaryRequest?.usageSent)}; getSessionStats adds the compaction entry's own usage, so the delta covers both`,
		);
		result.say(`cost provenance: models.json cost per million tokens = ${JSON.stringify(MODEL_COST)}`);
		result.say(`contextUsage immediately after compaction: ${JSON.stringify(statsAfter.contextUsage)}`);
		result.check(
			statsAfter.contextUsage?.tokens === null && statsAfter.contextUsage?.percent === null,
			`contextUsage is ${JSON.stringify(statsAfter.contextUsage)} right after compaction, not the documented nulls`,
		);

		const entries = readSessionEntries(afterCompaction.sessionFile);
		for (const line of describeEntries(entries)) result.say(`  ${line}`);
		const compactionEntry = entries.find((entry) => entry.id === afterCompaction.leafId);
		result.check(compactionEntry?.type === "compaction", "the leaf at settle is not a compaction entry in the durable file");
		result.check(
			compactionEntry?.firstKeptEntryId === compactionEnd.result?.firstKeptEntryId,
			"the persisted compaction entry disagrees with the compaction_end result about firstKeptEntryId",
		);
		// A compaction entry is not a self-contained checkpoint here: 0.85.1's coding-agent session
		// layer writes firstKeptEntryId and no retainedTail, so the tail is read from the branch.
		result.check(
			compactionEntry?.retainedTail === undefined,
			"the compaction entry carries a retainedTail, which 0.85.1's coding-agent session layer does not write",
		);
		result.say("measured Pi behaviour: the compaction entry is appended as a child of the last assistant message and becomes the leaf, so a checkpoint taken as 'the last assistant message' is an ancestor of it");
		// Every caller reinstalls a script for its own next phase, which forgets this log, so the compaction
		// phase has to account for its own requests here or an unscripted 500 during it would go unnoticed.
		result.check(
			server.unscripted.length === 0,
			`the fixture saw ${server.unscripted.length} unscripted request(s) during the threshold compaction: ${JSON.stringify(server.unscripted.map((request) => request.note))}`,
		);
		return {
			child,
			sessionFile: afterCompaction.sessionFile,
			sessionId: afterCompaction.sessionId,
			compactionEntryId: afterCompaction.leafId,
			preCompactionAssistantId: compactionEntry?.parentId,
			firstKeptEntryId: compactionEntry?.firstKeptEntryId,
		};
	} catch (error) {
		await child.close();
		throw error;
	}
}

/** Row 7: what has to finish before agent_settled — a retry, a threshold compaction, an overflow recovery. */
async function caseRetryCompaction(root, server, result) {
	const dirs = setupCase(root, server, result.name, { contextWindow: COMPACTION_CONTEXT_WINDOW });
	result.say(`this case runs with contextWindow ${COMPACTION_CONTEXT_WINDOW} and reserveTokens ${COMPACTION_RESERVE_TOKENS}, so the threshold is ${COMPACTION_CONTEXT_WINDOW - COMPACTION_RESERVE_TOKENS} tokens`);

	result.phase("(a) a transient provider failure is retried before the run settles");
	server.install([errorStep("a-transient", 500, "SPIKE_TRANSIENT_FAILURE the upstream is overloaded"), textStep("a-ok", "ROW7-A-RECOVERED")]);
	const childA = startChild(dirs, "a", {
		session: { mode: "create" },
		settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 }, compaction: { enabled: false } },
	});
	let fileA;
	try {
		const mark = childA.mark();
		const statsBefore = await readStats(childA);
		const run = await runPrompt(childA, "ROW7-A one transient failure, then success.");
		result.check(run.response.success === true, "the retried prompt was rejected");
		result.say(`events: ${JSON.stringify(eventTypes(childA, mark))}`);
		const firstEnd = eventIndex(childA, mark, (event) => event.type === "agent_end");
		const retryStart = eventIndex(childA, mark, (event) => event.type === "auto_retry_start");
		const retryEnd = eventIndex(childA, mark, (event) => event.type === "auto_retry_end");
		const settled = eventIndex(childA, mark, (event) => event.type === "agent_settled");
		result.check(firstEnd !== -1, "no agent_end was emitted for the failed attempt");
		result.check(childA.events[firstEnd]?.willRetry === true, `the first agent_end reports willRetry=${childA.events[firstEnd]?.willRetry}`);
		result.check(retryStart > firstEnd, "auto_retry_start did not follow the first agent_end");
		result.say(`auto_retry_start: ${JSON.stringify({ attempt: childA.events[retryStart]?.attempt, maxAttempts: childA.events[retryStart]?.maxAttempts, delayMs: childA.events[retryStart]?.delayMs })}`);
		result.check(childA.events[retryStart]?.attempt === 1, `auto_retry_start reports attempt ${childA.events[retryStart]?.attempt}`);
		result.check(childA.events[retryStart]?.maxAttempts === 2, `auto_retry_start reports maxAttempts ${childA.events[retryStart]?.maxAttempts}`);
		result.check(retryEnd > retryStart, "auto_retry_end did not follow auto_retry_start");
		result.check(childA.events[retryEnd]?.success === true, `auto_retry_end reports success=${childA.events[retryEnd]?.success}`);
		result.check(settled > retryEnd, "agent_settled was emitted before the retry finished");
		// A settle is only "last" over a window: an event that arrives a moment later is simply not
		// in the log yet when the await resolves, so the claim is made after a quiet period.
		await sleep(SETTLE_QUIET_MS);
		result.check(
			eventTypes(childA, settled + 1).length === 0,
			`agent_settled is not the last event; ${JSON.stringify(eventTypes(childA, settled + 1))} followed it within ${SETTLE_QUIET_MS}ms`,
		);
		result.check(server.requests.length === 2, `expected two provider requests, got ${server.requests.length}`);
		const second = server.requests[1];
		result.say(`request 2: ${describeRequest(second)}`);
		result.check(JSON.stringify(second.roles) === JSON.stringify(["system", "user"]), `the retried request's roles are ${JSON.stringify(second.roles)}`);
		result.check(!conversationTexts(second).some((text) => text.includes("SPIKE_TRANSIENT_FAILURE")), "the failed attempt's error text reached the retried request");
		const statsAfter = await readStats(childA);
		result.say(`stats delta over the retried run: ${JSON.stringify(statsDelta(statsBefore, statsAfter))}; the fixture sent usage only on the successful attempt ${JSON.stringify(second.usageSent)}, and none on the 500`);
		const identity = await state(childA);
		fileA = identity.sessionFile;
	} finally {
		await childA.close();
	}
	const entriesA = readSessionEntries(fileA);
	for (const line of describeEntries(entriesA)) result.say(`  ${line}`);
	const failedAssistants = entriesA.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error");
	result.say(`assistant entries with stopReason "error" in the durable file: ${failedAssistants.length}`);
	result.check(failedAssistants.length === 1, `expected the failed attempt to stay in the file, found ${failedAssistants.length} error entries`);
	result.say("measured Pi behaviour: the failed assistant message is persisted and stays on the branch, while _prepareRetry removes it from agent state only, so the retried request does not carry it");
	result.check(
		server.unscripted.length === 0,
		`the fixture saw ${server.unscripted.length} unscripted request(s) in phase (a): ${JSON.stringify(server.unscripted.map((request) => request.note))}`,
	);

	result.phase("(b) automatic threshold compaction, and the post-compaction checkpoint restored after a restart");
	const compaction = await driveThresholdCompaction(dirs, server, result, {
		label: "b",
		marker: "ROW7B",
		summaryText: "ROW7B-SUMMARY-SENTINEL the first turn asked for a fixture answer and got one.",
	});
	await compaction.child.close();
	result.say(`simulated Fusion policy: the checkpoint recorded for this call is the leaf at settle, ${compaction.compactionEntryId}, which is the compaction entry and not the last assistant message ${compaction.preCompactionAssistantId}`);

	server.install([textStep("b-t3", "ROW7-B-T3-ANSWER")]);
	const childB2 = startChild(dirs, "b2", {
		session: { mode: "open", file: compaction.sessionFile, requireCheckpoint: compaction.compactionEntryId },
		settings: COMPACTION_SETTINGS,
	});
	try {
		const navigated = (await bridgeCommand(childB2, `/spike-navigate ${compaction.compactionEntryId}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === compaction.compactionEntryId, `restoring the compaction checkpoint failed: ${navigated.error ?? navigated.leafId}`);
		result.say(`restored context entries: ${JSON.stringify(navigated.contextEntryTypes)}`);
		const statsBefore = await readStats(childB2);
		result.say(`contextUsage after restore, before the next prompt: ${JSON.stringify(statsBefore.contextUsage)}`);
		const run = await runPrompt(childB2, "ROW7-B-T3 continue from the summary.");
		result.check(run.response.success === true, "the post-compaction continuation was rejected");
		result.check(server.requests.length === 1, `the restored child made ${server.requests.length} provider requests instead of one`);
		const request = server.requests[0];
		result.say(`post-compaction request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(texts[0]?.startsWith(COMPACTION_SUMMARY_PREFIX), `the outgoing context does not start with the compaction summary: ${JSON.stringify(texts[0]?.slice(0, 60))}`);
		result.check(texts[0]?.includes("ROW7B-SUMMARY-SENTINEL"), "the replayed summary is not the one the fixture wrote");
		result.check(!texts.some((text) => text.includes("ROW7B-T1 first turn")), "a summarised prompt is still in the outgoing context");
		result.check(!texts.some((text) => text.includes("ROW7B-T1-ANSWER")), "a summarised answer is still in the outgoing context");
		result.check(texts.some((text) => text.includes("ROW7B-T2 second turn")), "the retained tail's prompt is missing from the outgoing context");
		result.check(texts.some((text) => text.includes("ROW7B-T2A")), "the retained tail's answer is missing from the outgoing context");
		result.check(texts.at(-1)?.includes("ROW7-B-T3"), "the continuation's own prompt is missing");
		result.say(`measured: the restored payload is the summary plus the entries from firstKeptEntryId ${compaction.firstKeptEntryId} onwards, and roles are ${JSON.stringify(request.roles)}`);
		const statsAfter = await readStats(childB2);
		result.say(`stats delta for the continuation: ${JSON.stringify(statsDelta(statsBefore, statsAfter))}; fixture usage ${JSON.stringify(request.usageSent)}`);
	} finally {
		await childB2.close();
	}
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (b)`);

	result.phase("(c) overflow compaction: one compact-and-retry attempt inside the same run");
	server.install([
		textStep("c-t1", "ROW7C-T1-ANSWER"),
		errorStep("c-overflow", 400, "Your input exceeds the context window of this model"),
		textStep("c-summary", "ROW7C-SUMMARY-SENTINEL the first turn asked for a fixture answer."),
		textStep("c-recovered", "ROW7C-RECOVERED"),
	]);
	const childC = startChild(dirs, "c", { session: { mode: "create" }, settings: COMPACTION_SETTINGS });
	try {
		await runPrompt(childC, "ROW7C-T1 first turn.");
		const mark = childC.mark();
		const run = await runPrompt(childC, `ROW7C-T2 second turn, padded so the cut point lands on it. ${LONG_TURN_PADDING}`);
		result.check(run.response.success === true, "the overflow turn's prompt was rejected");
		result.say(`events after the overflow turn: ${JSON.stringify(eventTypes(childC, mark))}`);
		const startIndex = eventIndex(childC, mark, (event) => event.type === "compaction_start");
		const endIndex = eventIndex(childC, mark, (event) => event.type === "compaction_end");
		const settled = eventIndex(childC, mark, (event) => event.type === "agent_settled");
		result.check(startIndex !== -1, "no compaction_start was emitted, so the overflow was not classified as one");
		result.check(childC.events[startIndex]?.reason === "overflow", `compaction_start reason is ${childC.events[startIndex]?.reason}, not overflow`);
		result.check(childC.events[endIndex]?.willRetry === true, `compaction_end reports willRetry=${childC.events[endIndex]?.willRetry}`);
		result.check(Boolean(childC.events[endIndex]?.result), `compaction_end carries no result: ${childC.events[endIndex]?.errorMessage ?? "(none)"}`);
		result.check(settled > endIndex, "agent_settled was emitted before the overflow recovery finished");
		// A settle is only "last" over a window: an event that arrives a moment later is simply not
		// in the log yet when the await resolves, so the claim is made after a quiet period.
		await sleep(SETTLE_QUIET_MS);
		result.check(
			eventTypes(childC, settled + 1).length === 0,
			`agent_settled is not the last event; ${JSON.stringify(eventTypes(childC, settled + 1))} followed it within ${SETTLE_QUIET_MS}ms`,
		);
		result.check(server.requests.length === 4, `expected four provider requests (turn, overflow, summary, retry), got ${server.requests.length}`);
		for (const request of server.requests) result.say(`  request ${request.index} (${request.step}): ${describeRequest(request)}`);
		const retried = server.requests[3];
		if (retried) {
			const texts = conversationTexts(retried);
			result.check(texts[0]?.startsWith(COMPACTION_SUMMARY_PREFIX), `the retried turn does not start from the summary: ${JSON.stringify(texts[0]?.slice(0, 60))}`);
			result.check(texts.some((text) => text.includes("ROW7C-T2 second turn")), "the retried turn lost the prompt that overflowed");
			result.check(!texts.some((text) => text.includes("ROW7C-T1 first turn")), "the retried turn still carries the summarised first turn");
		}
		result.say("measured Pi behaviour: an overflow-classified error is not retried by the retry path; compaction runs once and the interrupted turn is continued exactly once");
	} finally {
		await childC.close();
	}
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (c)`);

	result.phase("(d) work queued before the run would stop is processed before agent_settled");
	server.install([{ ...textStep("d1", "ROW7-D1-ANSWER"), delayMs: 1500 }, textStep("d2", "ROW7-D2-ANSWER")]);
	const childD = startChild(dirs, "d", { session: { mode: "create" }, settings: NO_COMPACTION_SETTINGS });
	try {
		const mark = childD.mark();
		await childD.send({ type: "prompt", message: "ROW7-D1 a turn held open by the fixture." });
		// The fixture holds the first response open, so the follow-up is queued while the run is live.
		await waitForRequests(server, 1);
		const queued = await childD.send({ type: "follow_up", message: "ROW7-D2 queued follow-up." });
		result.check(queued.success === true, "the follow-up was rejected");
		const settled = await childD.waitSettled(mark);
		result.check(Boolean(settled), "the run never settled");
		result.say(`events: ${JSON.stringify(eventTypes(childD, mark))}`);
		const settledIndex = eventIndex(childD, mark, (event) => event.type === "agent_settled");
		const settledCount = childD.events.slice(mark).filter((event) => event.type === "agent_settled").length;
		result.check(settledCount === 1, `${settledCount} agent_settled events were emitted for one prompt plus its queued follow-up`);
		result.check(server.requests.length === 2, `expected two provider requests, got ${server.requests.length}`);
		// A settle is only "last" over a window: an event that arrives a moment later is simply not
		// in the log yet when the await resolves, so the claim is made after a quiet period.
		await sleep(SETTLE_QUIET_MS);
		result.check(
			eventTypes(childD, settledIndex + 1).length === 0,
			`agent_settled is not the last event; ${JSON.stringify(eventTypes(childD, settledIndex + 1))} followed it within ${SETTLE_QUIET_MS}ms`,
		);
		const second = server.requests[1];
		result.say(`request 2: ${describeRequest(second)}`);
		result.check(conversationTexts(second).some((text) => text.includes("ROW7-D2")), "the queued follow-up never reached the provider");
		result.say("measured Pi behaviour: agent_end is not terminal — the queued follow-up runs its own turn and agent_settled is emitted once, after it");
	} finally {
		await childD.close();
	}

	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (d)`);

	result.phase(`(e) a model whose contextWindow is at or below pi-ai's 4096-token safety margin asks for one output token`);
	// Its own models.json, so the phase measures the clamp without disturbing the compaction phases.
	const smallModels = path.join(dirs.caseRoot, "small-window-models.json");
	writeJson(smallModels, modelsJson(server.baseUrl, DEGENERATE_CONTEXT_WINDOW));
	server.install([textStep("e", "ROW7-E-ANSWER")]);
	const childE = startChild(dirs, "e", { session: { mode: "create" }, settings: NO_COMPACTION_SETTINGS, modelsPath: smallModels });
	try {
		await runPrompt(childE, "ROW7-E one turn on a tiny context window.");
		const request = server.requests[0];
		result.say(`with contextWindow ${DEGENERATE_CONTEXT_WINDOW} and maxTokens ${MODEL_MAX_TOKENS} in models.json, the outgoing request asked for max_tokens ${request?.maxTokens}`);
		result.check(request?.maxTokens === 1, `expected the clamp to bottom out at 1, the request asked for ${request?.maxTokens}`);
		result.say(
			"measured Pi behaviour: pi-ai's clampMaxTokensToContext computes contextWindow - estimated context - 4096 and floors the result at 1, so any model configured with a contextWindow at or below ~4096 asks a real provider for a single output token, and anything longer than that risks being truncated at the provider. This fixture ignores max_tokens, so the live behaviour is untested; source says Pi refuses a length-stopped compaction summary as incomplete, so automatic compaction would fail on such a window wherever the provider honours the limit",
		);
		result.say("consequence for the harness: the compaction phases above run at a window of 40000 so this clamp cannot be mistaken for compaction behaviour");
	} finally {
		await childE.close();
	}

	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) in phase (e)`);
}

/** Row 2, compaction variant: which checkpoint a compacted run leaves, and what the other one costs. */
async function caseCompactionCheckpoint(root, server, result) {
	const dirs = setupCase(root, server, result.name, { contextWindow: COMPACTION_CONTEXT_WINDOW });
	const ledger = new Ledger((line) => result.say(line));
	const HOST = "host-session-1";

	result.phase("a run that ends in an automatic compaction");
	const plan = ledger.plan("row2c", HOST);
	result.check(plan.action === "new", `the first run planned ${plan.action} instead of new`);
	const compaction = await driveThresholdCompaction(dirs, server, result, {
		label: "compact",
		marker: "ROW2C",
		summaryText: "ROW2C-SUMMARY-SENTINEL the first turn asked for a fixture answer and got one.",
	});
	await compaction.child.close();
	ledger.record("row2c", { hostSessionId: HOST, plan, sessionId: compaction.sessionId, checkpoint: compaction.compactionEntryId, ok: true });
	result.check(
		ledger.get("row2c").checkpoint === compaction.compactionEntryId,
		"the ledger recorded something other than the leaf at settle as the checkpoint",
	);
	result.say(
		`simulated Fusion policy: the recorded checkpoint is the post-compaction leaf ${compaction.compactionEntryId}; the last assistant message ${compaction.preCompactionAssistantId} is its parent`,
	);

	result.phase("restoring the recorded post-compaction checkpoint");
	const restorePlan = ledger.plan("row2c", HOST);
	server.install([textStep("post", "ROW2C-POST-ANSWER")]);
	const childPost = startChild(dirs, "post", {
		session: { mode: "open", file: compaction.sessionFile, requireCheckpoint: restorePlan.checkpoint },
		settings: COMPACTION_SETTINGS,
	});
	try {
		const beforeNavigate = await state(childPost);
		result.say(`leaf after reopen, before restore: ${beforeNavigate.leafId} (${beforeNavigate.leafType})`);
		const navigated = (await bridgeCommand(childPost, `/spike-navigate ${restorePlan.checkpoint}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === restorePlan.checkpoint, `restoring the compaction checkpoint failed: ${navigated.error ?? navigated.leafId}`);
		result.say(`restored context entries: ${JSON.stringify(navigated.contextEntryTypes)}`);
		await runPrompt(childPost, "ROW2C-POST continue from the recorded checkpoint.");
		result.check(server.requests.length === 1, `the restored child made ${server.requests.length} provider requests instead of one`);
		const request = server.requests[0];
		result.say(`request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(texts[0]?.startsWith(COMPACTION_SUMMARY_PREFIX), `the restored payload does not start from the summary: ${JSON.stringify(texts[0]?.slice(0, 60))}`);
		result.check(texts[0]?.includes("ROW2C-SUMMARY-SENTINEL"), "the replayed summary is not the one the fixture wrote");
		result.check(!texts.some((text) => text.includes("ROW2C-T1 first turn")), "a summarised prompt is back in the outgoing context");
		result.check(texts.some((text) => text.includes("ROW2C-T2 second turn")), "the retained tail is missing from the outgoing context");
	} finally {
		await childPost.close();
	}
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s) while the recorded checkpoint was restored`);

	result.phase("the hazard: restoring the last assistant message instead puts the compaction off the branch");
	server.install([textStep("pre", "ROW2C-PRE-ANSWER")]);
	const childPre = startChild(dirs, "pre", {
		session: { mode: "open", file: compaction.sessionFile, requireCheckpoint: compaction.preCompactionAssistantId },
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
	});
	try {
		const navigated = (await bridgeCommand(childPre, `/spike-navigate ${compaction.preCompactionAssistantId}`, "SPIKE_NAVIGATE")).data;
		result.check(navigated.ok === true && navigated.leafId === compaction.preCompactionAssistantId, `restoring the pre-compaction checkpoint failed: ${navigated.error ?? navigated.leafId}`);
		result.say(`restored context entries: ${JSON.stringify(navigated.contextEntryTypes)}`);
		result.check(
			!navigated.contextEntryTypes.includes("compaction"),
			"the compaction entry is still on the branch, so this phase does not show the hazard it is meant to show",
		);
		await runPrompt(childPre, "ROW2C-PRE continue from the last assistant message.");
		result.check(server.requests.length === 1, `the restored child made ${server.requests.length} provider requests instead of one`);
		const request = server.requests[0];
		result.say(`request: ${describeRequest(request)}`);
		const texts = conversationTexts(request);
		result.check(!texts.some((text) => text.startsWith(COMPACTION_SUMMARY_PREFIX)), "the summary is in a payload restored from before the compaction");
		result.check(texts.some((text) => text.includes("ROW2C-T1 first turn")), "the pre-compaction restore did not re-expand the summarised history");
		result.say(
			"measured hazard: a checkpoint recorded as the child's last assistant message is an ancestor of the compaction entry, so restoring it drops the compaction off the branch and rebuilds the full pre-compaction history — the whole point of compacting is undone",
		);
	} finally {
		await childPre.close();
	}

	result.phase("the durable file, with the compaction and both continuations as siblings");
	for (const line of describeEntries(readSessionEntries(compaction.sessionFile))) result.say(`  ${line}`);
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
}

const CASES = [
	{ name: "row8-model-thinking", row: 8, title: "strict model and thinking checks", run: caseModelThinking },
	{ name: "row1-durable-checkpoint", row: 1, title: "a completed run's checkpoint survives the child process", run: caseDurableCheckpoint },
	{ name: "row2-older-checkpoint", row: 2, title: "restoring an older checkpoint after a later turn (host /tree simulation)", run: caseOlderCheckpoint },
	{ name: "row3-fork-at", row: 3, title: "fork at an exact checkpoint, two transcripts that stay apart", run: caseForkAt },
	{ name: "row4-failures", row: 4, title: "failed continuation, failed new run, failed fork after creation, invalid targets", run: caseFailures },
	{ name: "row2-compaction-checkpoint", row: 2, title: "a compaction at the checkpoint, and the hazard of recording the assistant message instead", run: caseCompactionCheckpoint },
	{ name: "row5-questions", row: 5, title: "a blocking question, duplicate answers, two in a row, and a steer that waits", run: caseQuestions },
	{ name: "row6-cancellation", row: 6, title: "clear_queue before abort, and a descendant that leaves the killed process group", run: caseCancellation },
	{ name: "row7-retry-compaction", row: 7, title: "retry, threshold and overflow compaction, and queued work before agent_settled", run: caseRetryCompaction },
];

const GROUPS = {
	"stage-a": ["row8-model-thinking", "row1-durable-checkpoint", "row2-older-checkpoint", "row3-fork-at", "row4-failures"],
	"stage-b": ["row2-compaction-checkpoint", "row5-questions", "row6-cancellation", "row7-retry-compaction"],
};

/* ------------------------------------------------------------------ the spike */

function selectCases(name) {
	if (name === undefined) return CASES;
	if (GROUPS[name]) return CASES.filter((entry) => GROUPS[name].includes(entry.name));
	return CASES.filter((entry) => entry.name === name);
}

/**
 * The containment guard is the one safety claim a passing run cannot exercise: every path a case builds is
 * derived from the temp root, so the refusal branch is unreachable from the cases themselves. Prove it here
 * instead of asserting it in prose, and refuse to launch if it no longer fires.
 */
function selftestContainment(root) {
	const outside = path.join(fs.realpathSync(os.tmpdir()), `pi-session-spike-outside-the-root-${process.pid}`);
	let refusal;
	try {
		assertInsideRoot(root, "selftest-outside", outside);
	} catch (error) {
		refusal = error instanceof Error ? error.message : String(error);
	}
	if (!refusal) throw new Error(`refusing to launch: the containment guard accepted ${outside}, so no case's paths are really checked`);
	if (fs.existsSync(outside)) throw new Error(`refusing to launch: ${outside} exists, so the guard cannot be what stopped a write to it`);
	const inside = assertInsideRoot(root, "selftest-inside", path.join(root, "tmp"));
	return { refusal, inside };
}

/**
 * The same argument for the sentinel guard: a case that passes never modifies a sentinel, so the guard's
 * failure branch is unreachable from the cases. Prove it against a file of the harness's own, on a quiet
 * stand-in for a CaseResult so a deliberate failure does not print as one.
 */
function selftestSentinelGuard(root) {
	const file = path.join(root, "selftest", "AGENTS.md");
	write(file, "sentinel guard self-test\n");
	const dirs = { sentinels: [] };
	trackSentinel(dirs, "self-test sentinel", file);
	const probe = {
		failures: [],
		say: () => {},
		check(ok, message) {
			if (!ok) this.failures.push(message);
		},
	};
	guardSentinel(probe, dirs.sentinels[0]);
	if (probe.failures.length !== 0) throw new Error(`refusing to launch: the sentinel guard reported an untouched file as changed (${probe.failures[0]})`);
	write(file, "sentinel guard self-test, modified\n");
	guardSentinel(probe, dirs.sentinels[0]);
	if (probe.failures.length !== 1) throw new Error("refusing to launch: the sentinel guard did not report a modified sentinel, so no case's promise about its bytes is checked");
	return probe.failures[0];
}

async function main() {
	if (cli.unknown.length > 0) {
		console.log(`unrecognised argument(s): ${cli.unknown.join(" ")}`);
		return 2;
	}
	if (listOnly) {
		console.log("cases:");
		for (const entry of CASES) console.log(`  ${entry.name.padEnd(26)} row ${entry.row}  ${entry.title}`);
		console.log("groups:");
		for (const [name, members] of Object.entries(GROUPS)) console.log(`  ${name.padEnd(26)} ${members.join(", ")}`);
		// 2, not 0: listing runs no case, and "no case ran" is exactly what this harness's 2 means.
		return 2;
	}

	const selected = selectCases(onlyCase);
	if (selected.length === 0) {
		console.log(onlyCase === "" ? "--case needs a case or group name" : `no case or group is named ${onlyCase}`);
		return 2;
	}

	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-session-spike-"));
	const server = await startFixtureServer();
	// An interrupt is the one exit the finally below never sees, and row 6 deliberately creates a
	// grandchild that no longer belongs to any group the operating system will reap for us.
	const interrupt = (signal) => {
		console.log(`\n${signal} received; killing every recorded pid and cleaning up`);
		cleanup(root, server, true);
		process.exit(1);
	};
	const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
		const handler = () => interrupt(signal);
		process.once(signal, handler);
		return [signal, handler];
	});
	const results = [];
	let deadlineTimer;
	try {
		deadlineTimer = setTimeout(() => {
			console.log(`\nGLOBAL DEADLINE of ${GLOBAL_DEADLINE_MS}ms reached; cleaning up and failing the run`);
			cleanup(root, server, true);
			process.exit(1);
		}, GLOBAL_DEADLINE_MS);
		deadlineTimer.unref();

		console.log("pi-fusion spike: what a Pi child can promise about session lifecycle");
		console.log(`node ${process.version}, ${new Date().toISOString()}`);
		console.log(`pi under test: ${piVersion} (repository dependency), public SDK bootstrap only`);
		console.log(`temp root: ${root}${keepRoot ? " (kept)" : " (removed on exit)"}`);
		console.log(`fixture model server: ${server.baseUrl}`);
		const containment = selftestContainment(root);
		console.log(`containment self-test: a path outside the root is refused ("${containment.refusal}") and ${containment.inside} is accepted`);
		console.log(`sentinel guard self-test: a modified sentinel is reported ("${selftestSentinelGuard(root)}")`);
		console.log(`selected: ${selected.map((entry) => entry.name).join(", ")}`);

		for (const entry of selected) {
			const result = new CaseResult(entry.name, entry.row, entry.title);
			console.log(`\n== ${entry.name} (matrix row ${entry.row}): ${entry.title} ==`);
			try {
				await entry.run(root, server, result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.failures.push(`case threw: ${message}`);
				console.log(`    FAIL case threw: ${message}`);
				if (error instanceof Error && error.stack) console.log(`    ${error.stack.split("\n").slice(1, 4).join("\n    ")}`);
				console.log(`  request log: ${server.requests.length} request(s), last ${JSON.stringify(server.requests.slice(-3).map((request) => request.step ?? request.note ?? "?"))}`);
			} finally {
				guardOpenCases(result);
			}
			results.push(result);
			console.log(
				result.status === "pass"
					? "  RESULT: pass"
					: result.status === "unproven"
						? `  RESULT: unproven (${result.unproven})`
						: `  RESULT: fail (${result.failures.length} failure(s))`,
			);
		}

		console.log("\nmatrix summary");
		for (const result of results) {
			const suffix = result.status === "unproven" ? ` (${result.unproven})` : result.status === "fail" ? ` (${result.failures[0]})` : "";
			console.log(`  row ${result.row} ${result.name.padEnd(26)} ${result.status}${suffix}`);
		}
		const notPassed = results.filter((result) => result.status !== "pass");
		console.log(`\n${results.length - notPassed.length}/${results.length} selected rows are measured passes`);
		return notPassed.length === 0 ? 0 : 1;
	} finally {
		if (deadlineTimer) clearTimeout(deadlineTimer);
		for (const [signal, handler] of handlers) process.removeListener(signal, handler);
		cleanup(root, server, false);
		await server.close();
	}
}

/**
 * The environment of a live pid still names this run's temp root, which is how a pid read back from a file is
 * told from a recycled one belonging to somebody else. Off Linux there is no /proc, so this reads false.
 */
function environMentions(pid, root) {
	try {
		return fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(root);
	} catch {
		return false;
	}
}

/**
 * A descendant whose pid file the fixture command has written but which no poll has registered yet: the file
 * exists before the next poll reads it, and an interrupt in that window consults only the in-memory registry.
 * Sweeping the files closes it, and the environment check is what makes signalling the pid safe.
 */
function sweepPidFiles(root) {
	const swept = [];
	let caseDirs;
	try {
		caseDirs = fs.readdirSync(path.join(root, "cases"));
	} catch {
		return swept;
	}
	for (const caseName of caseDirs) {
		const pidsDir = path.join(root, "cases", caseName, "pids");
		let names;
		try {
			names = fs.readdirSync(pidsDir);
		} catch {
			continue;
		}
		for (const name of names) {
			const pid = readPidFile(path.join(pidsDir, name));
			if (pid === undefined || spawnedPids.has(pid) || !pidAlive(pid) || !environMentions(pid, root)) continue;
			registerPid(pid);
			swept.push(pid);
		}
	}
	return swept;
}

function cleanup(root, server, sync) {
	const swept = sweepPidFiles(root);
	if (swept.length > 0) console.log(`pid files named ${swept.length} live process(es) the registry had not reached yet: ${swept.join(", ")}`);
	for (const pid of [...spawnedPids.keys()]) {
		killTree(pid);
		spawnedPids.delete(pid);
	}
	if (sync) {
		server.close();
	}
	if (!keepRoot) {
		try {
			fs.rmSync(root, { recursive: true, force: true });
		} catch {}
	}
}

process.exitCode = await main();
