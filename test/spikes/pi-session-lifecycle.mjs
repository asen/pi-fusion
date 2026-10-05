#!/usr/bin/env node
/*
 * Research spike, run by hand: what a Pi child can promise about session lifecycle — durable
 * checkpoints, restoring an older checkpoint, forking at an exact position, and what survives a
 * failed run. It is not part of `npm test`, because it spawns real Pi processes; the default test
 * glob (`test/*.test.ts`) does not reach this directory.
 *
 *   node test/spikes/pi-session-lifecycle.mjs [--case <name> | --case=<name>] [--keep] [--list]
 *
 * Two kinds of case live here, and their children are not the same program. The ten cases of `stage-a` and
 * `stage-b` run a bootstrap this file generates: a runtime built only from the package's public exports
 * (never `dist/bundle/cli.js`), with a bridge extension of the harness's own for the commands and the
 * notifications those rows measure. The five cases of `production` run the real thing instead —
 * `createPiBackend` from `extensions/backends/pi-backend.ts` over the production storage layout, bootstrap
 * input, launch, transport, preparation, session restore, task turn, outcome mapping and process cleanup,
 * with `extensions/backends/pi-bootstrap.mjs` as the child's own program. A production case still sets up through the
 * same `setupCase` every other case uses, so this file's generated bridge, bootstrap and open-probe sources do exist
 * in its case root — and a production child neither loads nor is ever pointed at one of them: the call input names the
 * production bootstrap and no extension resource at all, and nothing in the group starts a generated child.
 *
 * Five seams of this harness's own are injected into that composition, and exactly one of them is wrapped around the
 * launch: the host agent directory each case owns, the contract prose a call is given in place of the contract file
 * this install ships, the start seam, the environment `productionEnv` composes, and the `onCall` report that module
 * already keeps for a test. Everything else — the bounds, the bootstrap path, the storage, the task — is the shipped
 * default. The start seam is there for three things: the offline precondition and the containment checks below, which
 * is where a production call's own composed environment and paths are held to their rules, and registering the child's
 * pid in this harness's registry, which it can only do once `startPiChild` has handed that child back. It rewrites no
 * command, no argument and no bootstrap, and it calls the production `startPiChild` itself — so the default start
 * binding, which is what a call passing no seam would take, is measured by nothing here.
 *
 * What the network shape of a production case is, and what it is not. Two of the five production cases pass a question
 * callback of this harness's own, so their child runs the question tool and every dialog it opens is answered, held or
 * cancelled by this file and never by a person; the other three pass none and get no question tool at all. Whichever
 * it is, the host agent directory a production case composes holds one
 * `models.json` naming the loopback fixture, one `AGENTS.md` sentinel and no `auth.json` at all; no provider variable,
 * no credential of the user's and no paid model is anywhere in it; the environment the composition composed has to
 * carry `PI_OFFLINE=1` exactly or this harness refuses to launch the child; and the call input composes no catalog
 * base url. The loopback fixture server is network, and it is the only model endpoint this harness configures. That is
 * a set of preconditions and composed defaults and nothing more: there is no sandbox here, no fetch guard, no egress
 * boundary and no observation of what a child's process actually opens, so nothing in this group is evidence that a Pi
 * child could not reach another endpoint through another client, or ignore the offline switch entirely.
 *
 * The one window that registration leaves open, named rather than designed around: between the transport spawning a
 * production child and `startPiChild` resolving, that child's pid is in no registry of this harness's, so an interrupt
 * inside it leaks the process instead of killing it. It is not the window the pid-file sweep closes and nothing here
 * closes it the same way — a sweep works because the fixture commands of row 6 and the owned script of
 * `prod-detached-cancelled` write their pids to files it can read, and a production child writes no such file of its
 * own: what those files name is a descendant of its shell tool, never the child. It is bounded by the transport's own
 * startup bound and by nothing else, and closing it would need a seam inside the transport, which this harness does
 * not add. Those files are an oracle for this harness's own proofs and assertions and its own last-resort cleanup, and
 * they are never an input to production's cleanup: what that cleanup acts on is the process table it reads for itself.
 *
 * Every child of either kind runs in a disposable temp root that also holds HOME, the child's agent directory, the
 * fake project, the session directory, TMPDIR, the XDG directories and both compile caches. The fake user profile
 * models.json is read from belongs to the generated-bootstrap cases; a production child reads the host agent
 * directory's own models.json instead, and that fake profile is a directory nothing in the group points at. The
 * harness refuses to launch when any of those resolves outside the root: every environment variable that names a path,
 * every path field of the generated bootstrap's configuration, and, for a production call, every path-valued variable
 * of the environment its launch composed together with every path field of its own call input (cwd, agentDir,
 * sessionDir, authPath, modelsPath, modelsStorePath, and the recorded session file a continuation reopens) goes
 * through the same check, and a self-test before the first case proves that the refusal still fires and that the
 * sentinel guard still reports a modified file. The only model endpoint is a scripted loopback fixture server; its
 * recorded HTTP payloads, the session JSONL read back as evidence, and Pi's own RPC output are the only things
 * assertions are derived from.
 *
 * In the ten generated-bootstrap cases every assertion about Fusion's record rules is a SIMULATION of
 * `extensions/fusion.ts` (`recordRun`, `nextSession`) run by the in-harness ledger, and is labelled as such.
 * Only the Pi side — what the fork contains, what the leaf is, what goes out on the wire — is measured. The
 * five `production` cases simulate nothing: what a run publishes there is `extensions/backends/pi-outcome.ts`'s
 * own answer, and the ledger takes no part in them.
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
import { fileURLToPath, pathToFileURL } from "node:url";
// The production composition the `production` group drives, imported from the extension itself: nothing here
// reimplements a part of it, and a call that stopped being composable this way fails the group rather than being
// worked around in it. Node runs this .mjs and these .ts modules under the same type stripping `npm test` uses.
import { createPiBackend } from "../../extensions/backends/pi-backend.ts";
import { piRole } from "../../extensions/backends/pi-binding.ts";
import { hostSdkDir, PI_BOOTSTRAP_PATH, PI_SDK_RESOLVE_PATH, SDK_DIR_VARIABLE } from "../../extensions/backends/pi-launch.ts";
// The one cap a production case has to reproduce rather than restate: how much of a tool's own first argument the
// progress mapper puts in a `tool_call` event's `brief`. Imported so a pinned event cannot drift from the window the
// mapper actually cuts to, and so no number here is a second copy of that decision.
import { PI_ACTIVITY_CHARS } from "../../extensions/backends/pi-outcome.ts";
import { piPaths } from "../../extensions/backends/pi-storage.ts";
import { PI_BOUNDS, startPiChild } from "../../extensions/backends/pi-transport.ts";
import { failed } from "../../extensions/backends/types.ts";

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
 * would run every case in the catalogue and exit 0 for a command line that named nothing.
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

/**
 * The sentinel of the host agent directory a production case composes. It is a directory Pi never reads a context
 * file from — the child's own agent directory is the one `piPaths` puts under it — so its presence in a system prompt
 * would mean the layout sent a child somewhere it was not meant to look. It is its own constant rather than the fake
 * user profile's, so the two absences the production cases check are told apart.
 */
const PROD_HOST_AGENT_SENTINEL = "SPIKE-PROD-HOST-AGENT-CONTEXT-SENTINEL";
/** The contract prose a production call is given, in place of the file this install ships, and the sentinel in it. */
const PROD_CONTRACT_SENTINEL = "PROD-CONTRACT-SENTINEL";
const PROD_CONTRACT = `# implement\nDo the task.\n${PROD_CONTRACT_SENTINEL}`;
/** The one model and thinking level a production call asks for, named exactly and resolved by nothing. */
const PROD_MODEL = `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`;
const PROD_EFFORT = "medium";
/**
 * The stage diagnostics `extensions/backends/pi-bootstrap.mjs` writes on a child that got as far as serving: input,
 * sdk, runtime and serving, the last of them named. A count that is not four is a startup that took another path.
 */
const PROD_STAGE_COUNT = 4;
const PROD_LAST_STAGE = "serving";
/**
 * The one value `PI_OFFLINE` may have in the environment a production launch composed, checked before that launch
 * happens and a refusal when it is anything else. It is exact rather than truthy because Pi's own runtime, read in
 * 0.85.1's source, asks whether the variable is set at all, so `0` and an empty string are as offline as `1` there
 * while meaning the opposite to a reader here; requiring the literal keeps the harness's own switch unambiguous.
 *
 * What this is: a precondition of this harness, refusing to start a child it was not able to configure this way. What
 * it is not, and no case here may be read as: a network sandbox, an egress boundary or a fetch guard. Nothing in this
 * group observes or restricts what a child's own process actually opens, so it is no evidence that a Pi child could
 * not reach another endpoint through another client, or ignore this switch entirely.
 */
const PROD_REQUIRED_OFFLINE = "1";
/**
 * The fixed sentence `extensions/backends/pi-outcome.ts` maps a restore that refused on its postcondition to. It is
 * written out here rather than imported, so that a change to that text fails the case that asserts on it instead of
 * following it silently.
 */
const PROD_CHECKPOINT_REFUSAL = "the pi child did not read back as standing at the recorded checkpoint";
/**
 * The fixed sentence `extensions/backends/pi-outcome.ts` maps a cancelled turn to, written out here for the same
 * reason: a change to that text fails the cancellation cases instead of being followed silently. It is the whole of
 * what a cancelled production run says for itself — no question, no answer, no prompt, no path and no pid is in it,
 * and the marker checks of the two cancellation cases below are what hold it to that.
 */
const PROD_CANCELLED_MESSAGE = "the run was cancelled";
/**
 * What this harness's own question callback rejects with when it was told to hold a question rather than answer it.
 * Fixed text with no question, no answer and no identifier in it, and deliberately recognisable: the cancellation
 * cases assert that it reaches no diagnostic, no run text and no terminal event, which is only worth asserting if a
 * leak would actually be visible.
 */
const PROD_QUESTION_HELD = "SPIKE-PROD-HELD the harness held this question until the run's own cancellation reached it";
/** The literal platform tool the detached-descendant case needs. Never composed, never looked up on `PATH`. */
const PROD_SETSID = "/usr/bin/setsid";
/** How much of a run's own text a printed summary carries. A summary is a preview, never the answer. */
const PROD_TEXT_PREVIEW_CHARS = 120;
/** How far a computed cost and the one Pi reported may differ before the arithmetic below is called wrong. */
const PROD_COST_EPSILON = 1e-9;

/** models.json cost fields, so a printed cost has a stated provenance instead of reading as "free". */
const MODEL_COST = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const MODEL_CONTEXT_WINDOW = 200_000;
const MODEL_MAX_TOKENS = 4096;

const COMMAND_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 90_000;
const EXIT_DEADLINE_MS = 10_000;
const GLOBAL_DEADLINE_MS = 10 * 60_000;
/**
 * How long one whole production call — a child started, prepared, restored where the intent asks for one, prompted and
 * stopped — may take before the case fails. It is arithmetic over the transport's own default timers rather than a
 * number anybody liked the look of, and it is derived from `PI_BOUNDS` itself so that a default which changes carries
 * this with it: a production call is given no bounds of its own and runs on exactly those defaults.
 *
 * The terms are a startup, the acknowledgement of a prompt, one further request and one shutdown step, added rather
 * than maximised, plus the harness's own exit deadline as the margin. So it sits above each of those individual
 * production bounds and below `GLOBAL_DEADLINE_MS`, which stays the ultimate deadline that ends the whole run.
 *
 * What the arithmetic is not is an upper bound on a legitimate call. One call issues several requests and waits for a
 * settle — a restore alone sends a state read, a command list, the control prompt and two readbacks, and the turn
 * after it can compact or retry inside its own acknowledgement bound — so a perfectly healthy call can take longer
 * than these four terms added together. This is therefore the harness's own patience and never a verdict about the
 * transport or the child: when it fires, the call is cancelled through its own signal and then awaited, and what the
 * case says is that the call did not come back inside that patience.
 */
const PROD_CALL_DEADLINE_MS = PI_BOUNDS.startupMs + PI_BOUNDS.ackMs + PI_BOUNDS.requestMs + PI_BOUNDS.shutdownStepMs + EXIT_DEADLINE_MS;
/**
 * How long a case that cancels its call mid-turn may wait for the thing it cancels *on* — a question the child has
 * opened, or a descendant of its shell tool that has written its pid — before the case fails. It is the same
 * arithmetic over the transport's own defaults: a startup, the acknowledgement of the prompt and the one request that
 * carries the tool call, which is everything that has to happen before the trigger can fire. It sits deliberately
 * below `PROD_CALL_DEADLINE_MS`, so a trigger that never fires is reported as the trigger's own failure rather than
 * as the call running out of patience, and the call is cancelled and awaited to the end either way.
 */
const PROD_TRIGGER_DEADLINE_MS = PI_BOUNDS.startupMs + PI_BOUNDS.ackMs + PI_BOUNDS.requestMs;
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

/**
 * The variables every child of this harness gets, whichever composition names the rest of them: the owned HOME, temp,
 * XDG and cache directories, the offline and quiet switches, and the dummy key the fixture accepts. `extra` is for the
 * variables one composition names and another does not, and it is spread where those variables have always sat, so it
 * goes through the same containment check and the same owned-directory creation as everything around it — which is the
 * whole point of there being one function for this.
 */
function baseChildEnv(root, extra = {}) {
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
		...extra,
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

/** Every writable location a child knows about is inside the temp root, and that is checked before launch. */
function childEnv(root, { agentDir, sessionDir }) {
	return baseChildEnv(root, { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir });
}

/**
 * The environment a production call's child is composed from: the same base, and deliberately without
 * `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` in it. `childEnvironment` in
 * `extensions/backends/pi-launch.ts` writes the first itself, from the call's own storage, and the session directory
 * reaches a production child through the call input rather than through a variable — so naming either here would hide
 * the composition this group exists to measure behind a value the harness had already chosen. Everything that is left
 * is the owned one: the directories inside the root, an offline child, a quiet one, and the dummy fixture key.
 */
const productionEnv = (root) => baseChildEnv(root);

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

	/**
	 * The two cancellable session hooks, armed by naming them in PI_SPIKE_CANCEL_HOOKS. A child that
	 * does not name one registers no handler for it at all, which is what Pi's own hasHandlers() fast
	 * path checks, so the positive control runs against a genuinely absent hook rather than a passive
	 * one. Each firing is notified before the answer, so "the hook ran" is evidence of its own and does
	 * not have to be inferred from the command's result.
	 */
	for (const hook of (process.env.PI_SPIKE_CANCEL_HOOKS || "").split(",").filter((name) => name.length > 0)) {
		pi.on(hook, async (event, ctx) => {
			const manager = ctx.sessionManager;
			notifyJson(ctx, "SPIKE_HOOK", {
				hook: hook,
				cancel: true,
				// session_before_tree carries a preparation; session_before_fork carries entryId/position.
				targetId: event.preparation ? event.preparation.targetId : event.entryId || null,
				oldLeafId: event.preparation ? event.preparation.oldLeafId : manager.getLeafId() || null,
				position: event.position || null,
				sessionId: manager.getSessionId(),
			});
			return { cancel: true };
		});
	}

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

/**
 * Fields 3, 4, 5 and 6 of /proc/<pid>/stat — the run state, the parent, the process group and the session — plus
 * field 22, the start identity, all read exactly the way `processStartTime` reads that one: from after the comm field's
 * own closing parenthesis, so a command name holding a space or a bracket cannot shift them. It is how "this descendant
 * called setsid" is proved rather than assumed: a session leader's session and group are its own pid, and a process
 * still inside its parent's session is not one. `state` travels beside them because a zombie satisfies every relation
 * above while being a process nobody is running any more, and `start` because a pid the operating system has handed to
 * somebody else satisfies them too — so all three questions are answered off one read rather than three.
 *
 * Undefined off Linux and for a pid that has gone, which the caller fails on rather than reading as either answer.
 */
function processRelations(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const state = fields[0];
		const start = fields[19];
		const [ppid, pgrp, session] = [Number(fields[1]), Number(fields[2]), Number(fields[3])];
		if (typeof state !== "string" || state === "") return undefined;
		return [ppid, pgrp, session].every((value) => Number.isInteger(value) && value > 0) ? { state, ppid, pgrp, session, start } : undefined;
	} catch {
		return undefined;
	}
}

/** The two /proc run states that are a process nobody is running any more: reaped-but-unwaited, and dead. */
const FINISHED_STATES = new Set(["Z", "X"]);

/**
 * Whether this platform answers the reads the predicate below is built on at all, asked once and of this process
 * itself — which is the one pid that is certainly there. Without it, "no /proc entry" and "no /proc" would be the same
 * answer, and every live process would read as over on a platform that simply has no such filesystem.
 */
const PROC_READABLE = processRelations(process.pid) !== undefined;

/**
 * Whether a process this harness was watching is over, answered from one read and with no wait, retry or timer in it.
 * It exists because `pidAlive` deliberately answers a different question — "would a signal reach this pid at all",
 * EPERM included — which is the right question for deciding whether to signal and the wrong one for deciding whether
 * the thing being measured has ended: a zombie still answers `kill(pid, 0)`, and a pid the operating system has since
 * handed to somebody else answers it as that other process.
 *
 * So, in order: no `/proc` entry at all, or a run state of `Z` or `X`, is gone. For a pid this harness registered, a
 * start identity that no longer matches what was recorded is gone too — the process it was is over and the pid now
 * names something else — which is `isOurProcess`'s own rule read for this purpose, off the same single read as the run
 * state rather than through a second one: this is one `/proc/<pid>/stat` read and nothing else, so a process that ends
 * between two reads cannot be seen half one way and half the other. Anything else is still live, and the reading is
 * returned beside the verdict so a failure can say what it saw.
 *
 * Off a platform without `/proc` it answers the only question that can be answered there, which is `pidAlive`'s own,
 * and says so in the reason rather than pretending to more: a zombie cannot be told from a live process without a run
 * state to read, so nothing on such a platform is stricter than it always was.
 *
 * `pidAlive`'s own semantics are untouched: this is a second predicate for a second question, not a replacement, and
 * `isOurProcess` stays exactly what cleanup asks before it signals anything.
 */
function processEnded(pid) {
	if (!Number.isFinite(pid) || pid <= 0) return { gone: true, why: "no pid" };
	if (!PROC_READABLE) {
		return pidAlive(pid)
			? { gone: false, why: "still signal-reachable, and this platform has no /proc to read a run state from" }
			: { gone: true, why: "no longer signal-reachable, which is the most this platform can say" };
	}
	const relations = processRelations(pid);
	if (relations === undefined) return { gone: true, why: "no /proc entry" };
	if (FINISHED_STATES.has(relations.state)) return { gone: true, why: `state ${relations.state}` };
	// Registered and recycled: the pid is alive, and what it is alive as is not what this harness started. The recorded
	// identity is compared to the one this read already carries — both absent is the same match `isOurProcess` makes for
	// a platform that answers neither.
	if (spawnedPids.has(pid)) {
		const recorded = spawnedPids.get(pid);
		const same = recorded === undefined ? relations.start === undefined : recorded === relations.start;
		if (!same) return { gone: true, why: "start identity changed, so this pid was recycled" };
	}
	return { gone: false, why: `state ${relations.state}` };
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
 * A pid written by one of the harness's own fixture commands or owned scripts. `echo $$ >` truncates the file before
 * it writes, so content without a trailing newline may still be half-written and must read as absent rather
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
function startChild(dirs, label, { session, tools = ["read"], settings, modelsPath, agentDir = dirs.agentDir, extraEnv }) {
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
	const base = agentDir === dirs.agentDir ? dirs.env : childEnv(dirs.root, { agentDir, sessionDir: dirs.sessionDir });
	// extraEnv is for switches, never for locations: childEnv is where the containment check lives, so a
	// value that looks like a path would bypass it. Refuse one rather than launch an unchecked child.
	for (const [name, value] of Object.entries(extraEnv ?? {})) {
		if (String(value).includes(path.sep)) throw new Error(`refusing to launch: extraEnv ${name}=${value} names a path, which childEnv is what checks`);
	}
	const env = extraEnv ? { ...base, ...extraEnv } : base;
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

/** The hook firings the bridge reported at or after `from`, which is the proof that a hook ran at all. */
const hookFirings = (child, from = 0) =>
	child
		.notifications(from)
		.filter((message) => message.startsWith("SPIKE_HOOK "))
		.map((message) => JSON.parse(message.slice("SPIKE_HOOK ".length)));

/**
 * The refusal a cancellation and nothing else produces. A case asserts on this exact string, so removing or
 * reordering the guard's `cancelled` check fails the case instead of passing on whichever postcondition
 * happened to disagree next.
 */
const cancelledRefusal = (kind) => `the ${kind} was cancelled, so this run has no verified session to prompt`;

/**
 * The restore-or-fork-then-task path an adapter owes, exercised rather than described: a cancelled
 * operation is a refusal on its own, before any postcondition is looked at, because a cancelled
 * navigation can leave the leaf wherever the guard hoped to find it and a satisfied postcondition is
 * not permission to ignore `cancelled: true`. Only a verified operation may submit the task prompt, so
 * a refusal is observable as a provider request that never happened.
 */
async function guardedOperation(child, { kind, targetId, expect, task, deadlineMs = SETTLE_DEADLINE_MS }) {
	const prefix = kind === "fork" ? "SPIKE_FORK" : "SPIKE_NAVIGATE";
	const mark = child.mark();
	const response = await child.send({ type: "prompt", message: `${kind === "fork" ? "/spike-fork" : "/spike-navigate"} ${targetId}` });
	const ack = await child.waitNotification(prefix, mark, COMMAND_DEADLINE_MS);
	const refuse = (reason) => ({ mark, response, ack, submitted: false, reason, run: undefined });
	if (response.success !== true) return refuse(`the prompt carrying the ${kind} was rejected`);
	if (ack.ok !== true) return refuse(`the ${kind} command failed: ${ack.error ?? "?"}`);
	if (ack.cancelled === true) return refuse(cancelledRefusal(kind));
	const problems = [];
	if (ack.leafId !== targetId) problems.push(`leaf ${ack.leafId} is not the target ${targetId}`);
	if (kind === "fork") {
		if (!ack.sessionFile) problems.push("the fork reported no session file");
		else if (!fs.existsSync(ack.sessionFile)) problems.push(`the fork's session file ${ack.sessionFile} is not on disk`);
		if (ack.sessionId === expect.sessionId) problems.push(`the fork reported the source session id ${ack.sessionId}`);
		if (ack.sessionFile === expect.sessionFile) problems.push(`the fork reported the source session file ${ack.sessionFile}`);
	} else {
		if (ack.sessionId !== expect.sessionId) problems.push(`session id ${ack.sessionId} is not the recorded ${expect.sessionId}`);
		if (ack.sessionFile !== expect.sessionFile) problems.push(`session file ${ack.sessionFile} is not the recorded ${expect.sessionFile}`);
	}
	if (problems.length > 0) return refuse(`${kind} postconditions failed: ${problems.join("; ")}`);
	const run = await runPrompt(child, task, deadlineMs);
	return { mark, response, ack, submitted: true, reason: undefined, run };
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

/** How many managed-subtree paths a summary names before it says how many more there were. */
const MANAGED_SUMMARY_MAX = 6;

/**
 * A directory a case owns whose own root must stay as the case left it, with exactly one subtree the code under test
 * manages. Everything created, modified or removed at or below that subtree is the thing being measured and is
 * summarised; anything else in the root — an `auth.json`, a settings file, a `bin`, a stray sibling of any kind — is a
 * failure and is named, because a root sibling is a file the code under test wrote where this case gave it nothing.
 *
 * It is a diff of the whole root rather than a check on a list of names, so a sibling nobody thought of is caught too.
 */
function guardManagedRoot(result, guard) {
	const diff = diffSnapshots(guard.before, snapshot(guard.dir));
	const prefix = `${guard.managed}${path.posix.sep}`;
	const managed = (rel) => rel === guard.managed || rel.startsWith(prefix);
	const signed = [...diff.created.map((rel) => ({ rel, text: `+${rel}` })), ...diff.modified.map((rel) => ({ rel, text: `~${rel}` })), ...diff.removed.map((rel) => ({ rel, text: `-${rel}` }))];
	const outside = signed.filter((entry) => !managed(entry.rel)).map((entry) => entry.text);
	const inside = signed.filter((entry) => managed(entry.rel)).map((entry) => entry.text);
	result.check(outside.length === 0, `${guard.label} changed outside ${guard.managed}, which this case wrote nothing into: ${outside.join(" ")}`);
	const shown = inside.slice(0, MANAGED_SUMMARY_MAX).join(" ");
	const more = inside.length > MANAGED_SUMMARY_MAX ? ` and ${inside.length - MANAGED_SUMMARY_MAX} more` : "";
	result.say(`${guard.label}: ${outside.length} change(s) outside ${guard.managed}, ${inside.length} at or below it${inside.length === 0 ? "" : ` (${shown}${more})`}`);
}

/**
 * The sentinel check the runner owes every case, on the failure path as much as on the success path:
 * a case that threw halfway is the one most likely to have written where it promised not to.
 *
 * `dirs.managed` is optional and only a production case sets one, so every case written before it is checked exactly
 * as it always was.
 */
function guardOpenCases(result) {
	for (const dirs of openCases.splice(0)) {
		guardUnchanged(result, "fake user profile", dirs.profileBefore, dirs.profile);
		guardUnchanged(result, "fake project", dirs.projectBefore, dirs.project);
		if (dirs.managed !== undefined) guardManagedRoot(result, dirs.managed);
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

/**
 * Row 4, cancellation variant: a `session_before_tree` or `session_before_fork` handler that answers
 * `{ cancel: true }`. Pi returns that as an ordinary `{ cancelled: true }` result, not as the
 * `extension_error` the invalid-target phase above measures and not as a failed prompt acknowledgement,
 * so a guard that only watches for errors would walk straight past it.
 */
async function caseCancelledOperations(root, server, result) {
	const dirs = setupCase(root, server, result.name);
	const ledger = new Ledger((line) => result.say(line));
	const HOST = "host-session-1";
	const OTHER_HOST = "host-session-2";
	/** The one marker that must never appear anywhere: the task the guard has to refuse to submit. */
	const BLOCKED = "ROW4C-BLOCKED-TASK";
	const ARMED = { PI_SPIKE_CANCEL_HOOKS: "session_before_tree,session_before_fork" };
	server.install([
		textStep("s1", "ROW4C-S1-ANSWER"),
		textStep("s2", "ROW4C-S2-ANSWER"),
		textStep("nav-control", "ROW4C-NAV-CONTROL-ANSWER"),
		textStep("fork-control", "ROW4C-FORK-CONTROL-ANSWER"),
	]);

	/* (a) two settled turns, so the older checkpoint is a real move rather than a no-op */
	result.phase("(a) two settled turns: S1 becomes the older checkpoint, S2 the leaf");
	const planA = ledger.plan("row4cancel", HOST);
	const childA = startChild(dirs, "setup", { session: { mode: "create" }, settings: { retry: { enabled: false } } });
	let sessionFile;
	let sessionId;
	let checkpointS1;
	let checkpointS2;
	try {
		await runPrompt(childA, "ROW4C-S1 first turn.");
		const afterS1 = await state(childA);
		checkpointS1 = afterS1.leafId;
		sessionFile = afterS1.sessionFile;
		sessionId = afterS1.sessionId;
		await runPrompt(childA, "ROW4C-S2 second turn.");
		const afterS2 = await state(childA);
		checkpointS2 = afterS2.leafId;
		result.say(`session ${sessionId} at ${sessionFile}; S1 ${checkpointS1}, S2 ${checkpointS2} (${afterS2.leafType})`);
		ledger.record("row4cancel", { hostSessionId: HOST, plan: planA, sessionId, checkpoint: checkpointS2, ok: true });
	} finally {
		await childA.close();
	}
	const priorRecord = { ...ledger.get("row4cancel") };
	const sessionsBefore = snapshot(dirs.sessionDir);
	const fileHashBefore = hashFile(sessionFile);
	const entryCountBefore = readSessionEntries(sessionFile).length;
	result.say(`durable state before any cancelled operation: sha ${fileHashBefore}, ${entryCountBefore} line(s), ${sessionsBefore.size} path(s) under the session directory`);

	/* (b) and (c): one armed child, a cancelled navigation and a cancelled fork */
	const childB = startChild(dirs, "cancelled", {
		session: { mode: "open", file: sessionFile, requireCheckpoint: checkpointS1 },
		settings: { retry: { enabled: false } },
		extraEnv: ARMED,
	});
	try {
		const opened = await state(childB);
		result.check(opened.leafId === checkpointS2, `the reopened leaf is ${opened.leafId}, not the file's last line ${checkpointS2}`);

		result.phase("(b) measured Pi behaviour: a navigation to the current leaf never reaches the hook");
		const noopMark = childB.mark();
		const noop = (await bridgeCommand(childB, `/spike-navigate ${checkpointS2}`, "SPIKE_NAVIGATE")).data;
		result.check(noop.ok === true && noop.cancelled === false, `navigating to the current leaf answered ${JSON.stringify({ ok: noop.ok, cancelled: noop.cancelled })}`);
		result.check(hookFirings(childB, noopMark).length === 0, "session_before_tree fired for a navigation to the current leaf");
		result.say(`navigating to the current leaf ${checkpointS2}: ack ${JSON.stringify({ ok: noop.ok, cancelled: noop.cancelled, leafId: noop.leafId })}, hook firings ${hookFirings(childB, noopMark).length}`);
		result.say(
			"source (core/agent-session.js navigateTree): a target equal to the current leaf returns { cancelled: false } before the event is emitted, so a cancel hook cannot be relied on to see every navigation, and the harness submits no task here",
		);

		result.phase("(c) a cancelled navigation: the guard refuses it and submits nothing");
		const planB = ledger.plan("row4cancel", HOST);
		result.check(planB.action === "resume" && planB.checkpoint === checkpointS2, `the same host planned ${planB.action} at ${planB.checkpoint}`);
		result.say(
			`the ledger's record still names ${checkpointS2}; this case targets the earlier ${checkpointS1} instead, which is the harness's own choice and outside what this ledger models — a host /tree move would supply it from an earlier record the ledger does not keep`,
		);
		const requestsBeforeNavigate = server.requests.length;
		const navigateMark = childB.mark();
		const navigate = await guardedOperation(childB, {
			kind: "navigate",
			targetId: checkpointS1,
			expect: { sessionId, sessionFile },
			task: `${BLOCKED} this prompt must never be sent after a cancelled navigation.`,
		});
		const navigateHooks = hookFirings(childB, navigateMark);
		result.say(`session_before_tree firings: ${JSON.stringify(navigateHooks)}`);
		result.check(navigateHooks.length === 1 && navigateHooks[0].hook === "session_before_tree", `the navigation fired ${navigateHooks.length} session_before_tree handler(s)`);
		result.check(navigateHooks[0]?.targetId === checkpointS1, `the hook saw target ${navigateHooks[0]?.targetId} instead of ${checkpointS1}`);
		result.check(navigateHooks[0]?.oldLeafId === checkpointS2, `the hook saw old leaf ${navigateHooks[0]?.oldLeafId} instead of ${checkpointS2}`);
		result.say(`navigate ack: ${JSON.stringify({ ok: navigate.ack.ok, cancelled: navigate.ack.cancelled, leafId: navigate.ack.leafId, sessionId: navigate.ack.sessionId })}`);
		result.check(navigate.response.success === true, "the prompt carrying the cancelled navigation did not answer success:true");
		result.check(navigate.ack.ok === true, `the cancelled navigation was reported as a command failure: ${navigate.ack.error ?? "?"}`);
		result.check(navigate.ack.cancelled === true, "navigateTree did not report cancelled:true for a hook that answered { cancel: true }");
		result.check(childB.extensionErrors(navigateMark).length === 0, `the cancelled navigation also produced ${childB.extensionErrors(navigateMark).length} extension_error event(s)`);
		result.say("measured Pi behaviour: a cancelled navigation is an ordinary result — success:true on the prompt, no extension_error, cancelled:true in the return value");
		result.check(navigate.submitted === false, "the guard submitted the task after a cancelled navigation");
		result.say(`the guard refused: ${navigate.reason}`);
		result.check(
			navigate.reason === cancelledRefusal("navigate"),
			`the guard refused the navigation for another reason than its cancellation: ${JSON.stringify(navigate.reason)}`,
		);
		result.check(navigate.ack.leafId === checkpointS2, `the cancelled navigation moved the leaf to ${navigate.ack.leafId}`);
		result.check(server.requests.length === requestsBeforeNavigate, `the cancelled navigation produced ${server.requests.length - requestsBeforeNavigate} provider request(s)`);
		result.say(`provider requests across the cancelled navigation: ${requestsBeforeNavigate} -> ${server.requests.length}`);
		ledger.record("row4cancel", { hostSessionId: HOST, plan: planB, sessionId: navigate.ack.sessionId, checkpoint: navigate.ack.leafId, ok: false });
		result.check(
			JSON.stringify(ledger.get("row4cancel")) === JSON.stringify(priorRecord),
			`the cancelled navigation changed the record from ${JSON.stringify(priorRecord)} to ${JSON.stringify(ledger.get("row4cancel"))}`,
		);

		result.phase("(d) a cancelled fork: no fork identity, no fork transcript, nothing recorded");
		const planC = ledger.plan("row4cancel", OTHER_HOST);
		result.check(planC.action === "fork" && planC.checkpoint === checkpointS2, `the other host planned ${planC.action} at ${planC.checkpoint}`);
		const requestsBeforeFork = server.requests.length;
		const forkMark = childB.mark();
		const fork = await guardedOperation(childB, {
			kind: "fork",
			targetId: checkpointS1,
			expect: { sessionId, sessionFile },
			task: `${BLOCKED} this prompt must never be sent after a cancelled fork.`,
		});
		const forkHooks = hookFirings(childB, forkMark);
		result.say(`session_before_fork firings: ${JSON.stringify(forkHooks)}`);
		result.check(forkHooks.length === 1 && forkHooks[0].hook === "session_before_fork", `the fork fired ${forkHooks.length} session_before_fork handler(s)`);
		result.check(forkHooks[0]?.targetId === checkpointS1, `the hook saw entry ${forkHooks[0]?.targetId} instead of ${checkpointS1}`);
		result.check(forkHooks[0]?.position === "at", `the hook saw position ${JSON.stringify(forkHooks[0]?.position)} instead of "at"`);
		result.say(`fork ack: ${JSON.stringify({ ok: fork.ack.ok, cancelled: fork.ack.cancelled, sessionId: fork.ack.sessionId, sessionFile: fork.ack.sessionFile })}`);
		result.check(fork.response.success === true, "the prompt carrying the cancelled fork did not answer success:true");
		result.check(fork.ack.ok === true, `the cancelled fork was reported as a command failure: ${fork.ack.error ?? "?"}`);
		result.check(fork.ack.cancelled === true, "fork did not report cancelled:true for a hook that answered { cancel: true }");
		result.check(childB.extensionErrors(forkMark).length === 0, `the cancelled fork also produced ${childB.extensionErrors(forkMark).length} extension_error event(s)`);
		result.check(fork.submitted === false, "the guard submitted the task after a cancelled fork");
		result.say(`the guard refused: ${fork.reason}`);
		result.check(fork.reason === cancelledRefusal("fork"), `the guard refused the fork for another reason than its cancellation: ${JSON.stringify(fork.reason)}`);
		result.check(fork.ack.sessionId === sessionId && fork.ack.sessionFile === sessionFile, `the cancelled fork left the child on ${fork.ack.sessionId} at ${fork.ack.sessionFile}`);
		result.say(
			"source (core/agent-session-runtime.js fork): the cancel is answered before the entry is even looked up and before any session replacement, so the child keeps the source session and no branched file is created",
		);
		result.check(server.requests.length === requestsBeforeFork, `the cancelled fork produced ${server.requests.length - requestsBeforeFork} provider request(s)`);
		result.say(`provider requests across the cancelled fork: ${requestsBeforeFork} -> ${server.requests.length}`);
		ledger.record("row4cancel", { hostSessionId: OTHER_HOST, plan: planC, sessionId: undefined, checkpoint: undefined, ok: false });
		result.check(
			JSON.stringify(ledger.get("row4cancel")) === JSON.stringify(priorRecord),
			`the cancelled fork changed the record from ${JSON.stringify(priorRecord)} to ${JSON.stringify(ledger.get("row4cancel"))}`,
		);
		result.say("simulated Fusion policy: a cancellation before a fork exists records nothing, so the prior durable reference stays authoritative; the settled rule for a failure after a fork exists is the one row4-failures measures and is untouched here");

		result.phase("(e) a bounded quiet window: no task prompt arrives late");
		const quietFrom = server.requests.length;
		await sleep(SETTLE_QUIET_MS);
		result.check(server.requests.length === quietFrom, `${server.requests.length - quietFrom} provider request(s) arrived in the ${SETTLE_QUIET_MS}ms after the two cancelled operations`);
		result.say(`provider requests after both cancellations: ${server.requests.length}, unchanged across ${SETTLE_QUIET_MS}ms`);
		const settledState = await state(childB);
		result.say(`child state after both cancellations: ${JSON.stringify({ sessionId: settledState.sessionId, leafId: settledState.leafId, entryCount: settledState.entryCount })}`);
		result.check(settledState.sessionId === opened.sessionId, `the session id changed from ${opened.sessionId} to ${settledState.sessionId}`);
		result.check(settledState.sessionFile === opened.sessionFile, "the session file changed across the cancelled operations");
		result.check(settledState.leafId === opened.leafId, `the leaf moved from ${opened.leafId} to ${settledState.leafId}`);
		result.check(settledState.entryCount === opened.entryCount, `the entry count changed from ${opened.entryCount} to ${settledState.entryCount}`);
		const liveDiff = diffSnapshots(sessionsBefore, snapshot(dirs.sessionDir));
		result.say(`session directory while the child is still open: ${formatDiff(liveDiff)}`);
		result.check(isEmptyDiff(liveDiff), `the cancelled operations changed the session directory while the child was still open: ${formatDiff(liveDiff)}`);
	} finally {
		await childB.close();
	}

	result.phase("(f) the durable side: same bytes, no fork file, and the blocked task nowhere");
	const sessionsAfter = snapshot(dirs.sessionDir);
	const diff = diffSnapshots(sessionsBefore, sessionsAfter);
	result.say(`session directory after the cancelled operations: ${formatDiff(diff)}`);
	result.check(isEmptyDiff(diff), `the cancelled operations changed the session directory: ${formatDiff(diff)}`);
	result.check(hashFile(sessionFile) === fileHashBefore, `the source transcript's bytes changed: ${fileHashBefore} -> ${hashFile(sessionFile)}`);
	result.check(readSessionEntries(sessionFile).length === entryCountBefore, `the source transcript gained or lost lines: ${entryCountBefore} -> ${readSessionEntries(sessionFile).length}`);
	result.check(sessionsAfter.size === sessionsBefore.size, "a cancelled fork created a session file");
	// snapshot() keys are relative to the directory it walked, and only its file entries are readable.
	const blockedOnDisk = [...sessionsAfter]
		.filter(([, value]) => value.startsWith("file:"))
		.map(([rel]) => path.join(dirs.sessionDir, rel))
		.filter((file) => fs.readFileSync(file, "utf8").includes(BLOCKED));
	result.check(blockedOnDisk.length === 0, `the blocked task marker reached ${JSON.stringify(blockedOnDisk)}`);
	result.check(
		!server.requests.some((request) => JSON.stringify(request.messages ?? []).includes(BLOCKED)),
		"the blocked task marker reached the fixture's recorded payloads",
	);
	result.say(`measured: the ${BLOCKED} marker is in no provider payload and in no file under the session directory; the two bridge commands that carried the cancelled operations are prompts and persist nothing, which is what the unchanged line count shows`);

	/* (g) the positive control: the same guard, the same targets, no hook registered at all */
	result.phase("(g) positive control: with the hooks unregistered the guard permits both operations");
	const childC = startChild(dirs, "control", {
		session: { mode: "open", file: sessionFile, requireCheckpoint: checkpointS1 },
		settings: { retry: { enabled: false } },
	});
	let controlForkFile;
	try {
		const requestsBeforeControl = server.requests.length;
		const controlMark = childC.mark();
		const navigate = await guardedOperation(childC, {
			kind: "navigate",
			targetId: checkpointS1,
			expect: { sessionId, sessionFile },
			task: "ROW4C-NAV-CONTROL a task the guard is allowed to submit.",
		});
		result.check(hookFirings(childC, controlMark).length === 0, "a hook fired in the control child, which registers none");
		result.check(navigate.ack.cancelled === false, `the control navigation reported cancelled ${navigate.ack.cancelled}`);
		result.check(navigate.submitted === true, `the guard refused the control navigation: ${navigate.reason}`);
		result.check(navigate.ack.leafId === checkpointS1, `the control navigation left the leaf at ${navigate.ack.leafId}`);
		result.check(navigate.run?.response.success === true && navigate.run?.settled !== undefined, "the control navigation's task did not settle");
		result.check(server.requests.length === requestsBeforeControl + 1, `the control navigation's task produced ${server.requests.length - requestsBeforeControl} provider request(s)`);
		const navRequest = server.requests.at(-1);
		result.say(`control navigation request: ${describeRequest(navRequest)}`);
		result.check(conversationTexts(navRequest).some((text) => text.includes("ROW4C-NAV-CONTROL")), "the control navigation's task is missing from the payload");

		const forkMark = childC.mark();
		const fork = await guardedOperation(childC, {
			kind: "fork",
			targetId: checkpointS1,
			expect: { sessionId, sessionFile },
			task: "ROW4C-FORK-CONTROL a task on a fork the guard verified.",
		});
		result.check(hookFirings(childC, forkMark).length === 0, "a hook fired in the control child's fork");
		result.check(fork.ack.cancelled === false, `the control fork reported cancelled ${fork.ack.cancelled}`);
		result.check(fork.submitted === true, `the guard refused the control fork: ${fork.reason}`);
		controlForkFile = fork.ack.sessionFile;
		result.say(`control fork ${fork.ack.sessionId} at ${controlForkFile}, leaf ${fork.ack.leafId}`);
		result.check(fork.ack.sessionId !== sessionId && controlForkFile !== sessionFile, "the control fork reported the source identity");
		result.check(fork.run?.response.success === true && fork.run?.settled !== undefined, "the control fork's task did not settle");
		const forkRequest = server.requests.at(-1);
		result.say(`control fork request: ${describeRequest(forkRequest)}`);
		result.check(conversationTexts(forkRequest).some((text) => text.includes("ROW4C-FORK-CONTROL")), "the control fork's task is missing from the payload");
	} finally {
		await childC.close();
	}
	result.check(Boolean(controlForkFile) && fs.existsSync(controlForkFile), `the permitted fork left no transcript at ${JSON.stringify(controlForkFile)}`);
	result.say("the control proves the guard is not refusing everything: the same guard, on the same targets, permitted a navigation and a fork and let each one reach the local fixture");
	result.say("what stays simulation: the record decisions above are the in-harness ledger, and no Fusion adapter is involved in either the refusal or the submission");

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
		// Recorded rather than required: 0.85.1 restarted the run with the queued work, and Pi 1.0.1 measured none. What
		// the host relies on is clear_queue before abort, which phase (a) measures holds either way; this phase is the
		// evidence for why, and on a Pi that no longer restarts it is evidence that the order is now merely harmless.
		if (restarted > 0) {
			const texts = server.requests.slice(1).flatMap(conversationTexts);
			result.say(
				`the restarted turn carried the steer: ${texts.some((text) => text.includes("ROW6-A2-STEER"))}, the follow-up: ${texts.some((text) => text.includes("ROW6-A2-FOLLOWUP"))}`,
			);
			result.say("measured Pi behaviour: abort waits for idle and then continues queued messages under a fresh abort controller, so clear_queue must precede abort");
		} else {
			result.say("measured Pi behaviour: abort with a steer and a follow-up still queued restarted nothing on this Pi, so clear_queue before abort is a precaution here rather than the fix it was on 0.85.1");
		}
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
		// Pi 1.0.1 also summarises the prefix of the turn it cut, in a second summary request before the retry, which
		// 0.85.1 did not: the step after the first summary is whichever of the two comes, and a 0.85.1 run leaves the
		// last step unused rather than reaching an unscripted request.
		textStep("c-prefix-or-recovered", "ROW7C-RECOVERED"),
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
		const summaries = server.requests.filter((request) => request.systemText?.startsWith(SUMMARY_SYSTEM_PREFIX));
		result.check(
			(summaries.length === 1 || summaries.length === 2) && server.requests.length === 3 + summaries.length,
			`expected the turn, the overflow, one or two summaries and the retry, got ${server.requests.length} request(s) of which ${summaries.length} summaries`,
		);
		for (const request of server.requests) result.say(`  request ${request.index} (${request.step}): ${describeRequest(request)}`);
		result.say(
			summaries.length === 2
				? "measured Pi behaviour: the overflow compaction made two summary requests — the history before the cut, and the prefix of the turn it cut — before the one retry"
				: "measured Pi behaviour: the overflow compaction made one summary request before the one retry",
		);
		const retried = server.requests.at(-1);
		if (retried) {
			const texts = conversationTexts(retried);
			result.check(texts[0]?.startsWith(COMPACTION_SUMMARY_PREFIX), `the retried turn does not start from the summary: ${JSON.stringify(texts[0]?.slice(0, 60))}`);
			if (summaries.length === 2) {
				// 1.0.1's shape: the prompt that overflowed is the prefix it summarised, so the retry carries that summary
				// in place of the prompt's own text rather than losing it.
				result.check(conversationTexts(summaries[1]).some((text) => text.includes("ROW7C-T2 second turn")), "the second summary request does not carry the prompt that overflowed");
				result.check(!texts.some((text) => text.includes("ROW7C-T2 second turn")), "the retried turn carries the prompt that overflowed as well as its summary");
				result.say("measured Pi behaviour: the prompt that overflowed reaches the retry only as its own summary, not as the text that was sent");
			} else {
				result.check(texts.some((text) => text.includes("ROW7C-T2 second turn")), "the retried turn lost the prompt that overflowed");
			}
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

/* ------------------------------------------------------------ the production group */

/**
 * The five cases below drive the real backend rather than a stand-in for it: `createPiBackend` with five seams of this
 * harness's own — the host agent directory this case owns, the contract prose in place of the file this install ships,
 * the wrapped start described in the file header, the environment `productionEnv` composes, and the `onCall` report
 * that module already keeps for a test — and production's own everything else. No bounds, no cleanup, no bootstrap
 * path, no storage and no task are passed, so each of those is the shipped default. The storage layout, the bootstrap
 * input, the launch, the transport, the preparation, the session
 * restore, the task turn, the outcome mapping and the process cleanup are all the shipped ones, the child's program is
 * `extensions/backends/pi-bootstrap.mjs`, and the SDK behind it is this repository's Pi.
 *
 * What that buys, and what it does not. It measures this composition against a real child: which requests one call
 * sends, what a restore of a recorded checkpoint does to a real transcript, what a fork of one contains, what a
 * question of the child's own is answered or cancelled as, what a cancellation mid-turn leaves of the child and of a
 * descendant that left its process group, what the
 * outcome mapping then publishes, and whether the child and its storage are actually gone afterwards. It measures
 * nothing about a real provider, a real credential or a paid model: the loopback fixture is the only model endpoint
 * configured, the composed child environment must carry `PI_OFFLINE=1` exactly before a launch happens, and neither of
 * those is a sandbox or evidence about what a child could reach by another route. It changes no policy either: the exact-leaf gate, the record rules and the retention rules are the shipped ones, and a
 * refusal is reported as the composition reported it rather than worked around here.
 *
 * The three cases that came last are the loud half of the group, and what they add is one question answered with a
 * steer beside it, one question held until the run's own cancellation reached it, and one cancellation onto a shell
 * tool that had already put a `setsid` descendant outside the process group Pi kills. Each of the three still ends at
 * the same strict ground the quiet two do — a disposition with no concern, this call's own storage gone, every process
 * of it over — and none of them terminates anything itself before asserting that: the pid files the owned script
 * writes are an oracle for those proofs and assertions and a last-resort net for this harness's own cleanup, never an
 * input to production's, and a native cleanup that failed is a failed case rather than something this file tidies up
 * over. "Over" is `processEnded`'s question rather than `pidAlive`'s, so a zombie never passes as a survivor and a
 * recycled pid never passes as the process it used to be.
 */

/** Session files of this case's own durable session directory, sorted, or nothing at all while there are none. */
function sessionFiles(prod) {
	try {
		return fs
			.readdirSync(prod.paths.sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
	} catch {
		return [];
	}
}

/** What is left in the layout's own calls directory, which after a call that ended cleanly is nothing. */
function callDirs(prod) {
	try {
		return fs.readdirSync(prod.paths.callsDir).sort();
	} catch {
		return [];
	}
}

/** The user message of a turn, found by the prompt it carries, which is how a case names an entry it never chose. */
const userEntry = (entries, text) =>
	entries.find((entry) => entry.type === "message" && entry.message?.role === "user" && messageText(entry.message).includes(text));

/** An entry's own ancestry inside one transcript, oldest first, the entry itself included. */
function ancestryOf(entries, id) {
	const byId = new Map(entries.filter((entry) => entry.type !== "session").map((entry) => [entry.id, entry]));
	const line = [];
	for (let current = byId.get(id); current; current = current.parentId ? byId.get(current.parentId) : undefined) line.unshift(current);
	return line;
}

/**
 * What `MODEL_COST` prices one fixture usage chunk at, read as a price per million tokens, which is how a models.json
 * cost is stated. The fixture sends no cache tokens, so only the two rates that matter are in it.
 */
const fixtureCost = (usage) => (usage.prompt_tokens * MODEL_COST.input + usage.completion_tokens * MODEL_COST.output) / 1_000_000;

/**
 * One production call under the harness's patience, and what running out of it does: the call is cancelled through its
 * own signal — the same `AbortSignal` a real host hands a run, and the only way to end one from outside — and then
 * awaited to the end, so the composition performs its own shutdown and cleanup before this reports anything. A case
 * that fails this way therefore leaves nothing of its call running, and no later case starts beside an abandoned child
 * writing into a temp root somebody else now owns.
 *
 * It never races the call and never abandons it: the same promise is awaited on both paths, which is also why there is
 * no unhandled rejection to mop up. A call that ignores its own cancellation is left to `GLOBAL_DEADLINE_MS`, which
 * stays the ultimate bound on the whole run.
 *
 * Nothing is cancelled unless the patience actually runs out: a call that answers in time was never signalled, and the
 * error a timed-out call is reported with keeps whatever that call did after the cancellation.
 */
async function withinDeadline(what, controller, work, ms = PROD_CALL_DEADLINE_MS) {
	let fired = false;
	const timer = setTimeout(() => {
		fired = true;
		controller.abort();
	}, ms);
	let outcome;
	try {
		// Settled rather than raced: the value and the rejection are both taken, so the wait below is the whole call.
		outcome = await work.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
	} finally {
		clearTimeout(timer);
	}
	if (!fired) {
		if (outcome.ok) return outcome.value;
		throw outcome.error;
	}
	const after = outcome.ok ? "it reported a run afterwards" : `it rejected afterwards with ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;
	throw new Error(`${what} had not come back inside the harness's patience of ${ms}ms, so it was cancelled through its own signal and awaited to the end: ${after}`);
}

/**
 * One event-driven latch, which is the whole of how a case waits for something to happen *inside* a call: a promise
 * that resolves the first time `open` is called, and nothing else.
 *
 * What that claim is and is not. The latch holds no timer and polls nothing: it is opened by the event it is waiting
 * for and by nothing else, so nothing here samples, sleeps or wakes up to look. It is **not** an unbounded wait, and
 * the bound is deliberate and elsewhere: `awaitTrigger` races every trigger against a real rejecting timer, so a latch
 * that never opens ends the call through its own signal rather than hanging. `close` is there so that a latch and a
 * watcher are the same shape to a caller.
 */
function latch(what) {
	let opened;
	const ready = new Promise((resolve) => {
		opened = resolve;
	});
	return { what, ready, open: () => opened(), close: () => {} };
}

/**
 * The same readiness for a descendant that has written its pid, and the one reason it is a watcher rather than a
 * poll: between a process starting and this harness knowing its pid there is a window an interrupt would leak it in,
 * and a watcher closes that window to one filesystem event instead of one poll period. One `fs.watch` on the
 * directory the fixture script writes into, read once when it is installed — a file finished before that fires no
 * event — and again on every event, resolving when every named file parses as a whole pid. `readPidFile` is what
 * "whole" means: a file without its trailing newline is a half-written one and reads as absent.
 *
 * The same honest bound as `latch`: no timer and no poll are in here, and the wait is still bounded, by
 * `awaitTrigger`'s own rejecting timer rather than by anything this watcher does.
 *
 * It registers nothing and proves nothing: what to do with the pids, and whether they are really this run's, is the
 * caller's, which is also where the containment, identity and detachment proofs live. `close` takes the watcher off,
 * and the caller's `finally` is what calls it. `found` is the live view of what has parsed so far, which is the one
 * thing worth printing when readiness never came: "neither file" and "one of the two" are different failures.
 */
function watchPidFiles(what, files) {
	const labels = Object.keys(files);
	const found = {};
	let settle;
	const ready = new Promise((resolve, reject) => {
		settle = { resolve, reject };
	});
	const look = () => {
		for (const label of labels) {
			if (found[label] !== undefined) continue;
			const pid = readPidFile(files[label]);
			if (pid !== undefined) found[label] = pid;
		}
		if (labels.every((label) => found[label] !== undefined)) settle.resolve({ ...found });
	};
	let watcher;
	try {
		// One directory for every file, which is what makes a single watcher enough; `persistent: false` so a watcher
		// nobody closed could never be what keeps this process alive.
		const dirs = new Set(labels.map((label) => path.dirname(files[label])));
		if (dirs.size !== 1) throw new Error(`refusing to watch: ${JSON.stringify([...dirs])} is more than one directory, and this watcher is one directory's`);
		watcher = fs.watch([...dirs][0], { persistent: false }, () => {
			try {
				look();
			} catch (error) {
				settle.reject(error);
			}
		});
		look();
	} catch (error) {
		settle.reject(error);
	}
	return { what, found, ready, close: () => watcher?.close() };
}

/**
 * The trigger of a cancellation that has to land in the middle of a call: the thing the case cancels *on*, awaited
 * under its own bound and never instead of the call itself. The call's own settled promise is in the race for one
 * reason only — a call that was already over has nothing left to cancel, and saying so is better than spending the
 * whole bound on a trigger that can no longer fire — and the caller awaits that same promise to the end afterwards,
 * so nothing here races the call away or abandons it.
 *
 * The timer and the watcher both go in the `finally`, whichever way this ended, so no clock of this harness's and no
 * watch of its own outlives the call it belonged to. Every promise in the race has both handlers attached by `race`
 * itself, so a trigger or a bound that settles after the winner leaves nothing unhandled behind.
 */
async function awaitTrigger(label, trigger, settled, ms = PROD_TRIGGER_DEADLINE_MS) {
	let timer;
	const bounded = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: ${trigger.what} was not ready inside the harness's patience of ${ms}ms, so the call was cancelled and awaited to the end without it`)), ms);
	});
	try {
		const first = await Promise.race([trigger.ready.then(() => "ready"), settled.then(() => "ended"), bounded]);
		if (first === "ended") throw new Error(`${label}: the call was over before ${trigger.what} was ready, so there was nothing left for this case to cancel`);
	} finally {
		clearTimeout(timer);
		trigger.close();
	}
}

/**
 * A question this harness was told to hold rather than answer, held on the dialog's own `AbortSignal` and on nothing
 * else: no timer, no poll and no sleep is in the hold itself, and the bound on the whole call is `awaitTrigger`'s
 * rejecting timer and `withinDeadline`'s patience, both of which end it through the run's own signal. What aborts the
 * dialog's signal is the router ending that dialog, which is what a cancellation of the run does to one — so this
 * rejects exactly when the cancellation has reached the question, with fixed text that names neither the question nor
 * anything about the run.
 *
 * `released` is called once, immediately before the rejection, and it is the point of the callback: it is this
 * harness's own record that the dialog's signal aborted, which is evidence of the cancellation reaching the question
 * that does not depend on which side of the task's own race happened to win and therefore on whether the task kept the
 * dialog's outcome at all.
 */
const holdQuestion = (signal, released) =>
	new Promise((_resolve, reject) => {
		const give = () => {
			released?.();
			reject(new Error(PROD_QUESTION_HELD));
		};
		if (signal.aborted) {
			give();
			return;
		}
		signal.addEventListener("abort", give, { once: true });
	});

/**
 * One production case's own ground: the directories, sentinels and guards every case has, plus the host agent
 * directory this one gives the backend. When the case starts that directory holds exactly two files — one
 * `models.json` naming the loopback fixture, which is the one a production child reads, and one `AGENTS.md` whose
 * sentinel must never reach a system prompt — and no `auth.json` at all, which is what sends the production storage to
 * a private credential path inside the call's own directory. The layout underneath it is production's: `piPaths`
 * computes it here so the case can look at what the call actually made.
 *
 * `setupCase` also writes this file's generated bridge, bootstrap and open-probe sources into the case root, because
 * every case goes through it. A production case names none of them and starts no child from any of them; they sit
 * there unread.
 *
 * The root itself is snapshotted after those two files are written, and `dirs.managed` is what the runner then diffs it
 * against in its `finally`: the Fusion-owned subtree `piPaths` puts under this directory is allowed to appear and
 * change, and anything else in the root — a credential file, a settings file, a helper `bin` — fails the case and is
 * named. The subtree's own name is read back from `piPaths` rather than written out here, so it cannot drift from the
 * layout it is meant to describe.
 */
/**
 * The Pi package a production child runs, which is this host's own: the same lookup the backend's default takes, read
 * once here so each case can hold the composed launch to exactly that directory.
 */
const HOST_SDK_DIR = await hostSdkDir();

function setupProductionCase(root, server, name) {
	const dirs = setupCase(root, server, name);
	const hostAgent = assertInsideRoot(root, "production host agent directory", path.join(dirs.caseRoot, "host-agent"));
	fs.mkdirSync(hostAgent, { recursive: true });
	const paths = piPaths(hostAgent, dirs.project);
	writeJson(paths.userModelsPath, modelsJson(server.baseUrl));
	write(path.join(hostAgent, "AGENTS.md"), `# Host agent directory context\n\n${PROD_HOST_AGENT_SENTINEL}\n`);
	trackSentinel(dirs, "production host agent models.json", paths.userModelsPath);
	trackSentinel(dirs, "production host agent AGENTS.md", path.join(hostAgent, "AGENTS.md"));
	if (fs.existsSync(paths.userAuthPath)) throw new Error(`refusing to run: ${paths.userAuthPath} exists, so this case would point a child at a credential file it did not write`);
	dirs.managed = { label: "production host agent root", dir: hostAgent, managed: path.relative(hostAgent, paths.root), before: snapshot(hostAgent) };
	for (const field of ["root", "agentDir", "catalogDir", "modelsStorePath", "sessionDir", "callsDir", "userModelsPath", "userAuthPath", "hostBinDir"]) {
		assertInsideRoot(root, `piPaths.${field}`, paths[field]);
	}
	return { dirs, server, root, hostAgent, paths, env: productionEnv(root), sdkDir: HOST_SDK_DIR };
}

/**
 * The start seam a production call is given, and the three things it is there for: the offline precondition, which is
 * the one value `PI_OFFLINE` may have in the environment this composition composed; the containment checks, which is
 * where the paths it composed for itself are held to the temp root; and registering the child's pid in this harness's
 * registry. The first two are refusals before the launch rather than assertions after it, and neither is a sandbox —
 * see `PROD_REQUIRED_OFFLINE` for what the offline one does and does not say. Everything else travels through untouched — the command, the arguments, the bootstrap, the
 * environment, the bounds and the cleanup are the composition's own, and `startPiChild` is the production one — and a
 * startup that failed is rethrown exactly as it came, because the composition above it reads that error.
 *
 * What the registration is, exactly. A pid is registered once `startPiChild` has handed a child back, because that is
 * when this seam first has one, and it is forgotten again as soon as that child's `exited` settles — the same rule
 * `RpcChild` keeps, so a pid the operating system has since reused is never one this harness signals. It follows that
 * a child spawned by the transport and not yet handed over is in no registry here: an interrupt in that window leaks
 * the process rather than killing it. Nothing here closes that window, and it is not the one the pid-file sweep
 * closes: that sweep works by reading pid files a fixture command or an owned script wrote, and a production child
 * writes none of its own — the two that `prod-detached-cancelled` reads name a descendant of its shell tool and the
 * script that shell tool ran. It is bounded by the
 * transport's own startup bound and by nothing else, and closing it would need a seam inside the transport, which
 * this harness does not add.
 *
 * A path outside the root is a refusal here rather than a diagnostic, the same rule every other child of this harness
 * launches under, and what is checked is everything the composition composed rather than a list somebody kept up to
 * date: the launch's own working directory, every value of the launch environment that looks like a path — HOME,
 * USERPROFILE, the temp and XDG directories, the child agent directory and both compiler caches among them, with
 * `PATH` the one exception, because the host's own search path is in it and the launch appends to that rather than
 * replacing it — and every path field of the call input the bootstrap will read from the second argument, the recorded
 * session file of a continuation included. A switch that is not a path, such as `NO_COLOR` or the marker, carries no
 * separator and is passed over by the same rule. What is recorded beside them is what the case then asserts on: the
 * command, the bootstrap, the child marker, the `PI_OFFLINE` value this seam refused or allowed, and the session,
 * tools, question tool, configured file paths and catalog fields of that same input — one entry per start attempt, so
 * the checks over them cannot pass by having nothing to look at.
 */
function productionStart(prod) {
	const evidence = { attempts: 0, resolved: 0, commands: [], preloads: [], bootstraps: [], sdkDirs: [], markers: [], offline: [], inputs: [], pids: [] };
	const start = async (options) => {
		evidence.attempts += 1;
		const launch = options.launch;
		evidence.commands.push(launch.command);
		// The preload goes in front of the bootstrap, so the input is the last argument and the bootstrap the one before.
		evidence.preloads.push(launch.args?.slice(0, -2));
		evidence.bootstraps.push(launch.args?.at(-2));
		evidence.sdkDirs.push(launch.env?.[SDK_DIR_VARIABLE]);
		evidence.markers.push(launch.env?.PI_FUSION_CHILD);
		evidence.offline.push(launch.env?.PI_OFFLINE);
		// Refused before the launch rather than asserted after it: a child this harness could not configure offline is
		// one it does not start at all. See PROD_REQUIRED_OFFLINE for what this is and, more importantly, what it is not.
		if (launch.env?.PI_OFFLINE !== PROD_REQUIRED_OFFLINE) {
			throw new Error(
				`refusing to launch: the environment this call composed has PI_OFFLINE=${JSON.stringify(launch.env?.PI_OFFLINE)} rather than exactly ${JSON.stringify(PROD_REQUIRED_OFFLINE)}`,
			);
		}
		assertInsideRoot(prod.root, "production launch cwd", launch.cwd);
		// Every path-valued variable of the composed environment, by the same rule `baseChildEnv` checks its own by:
		// anything holding a separator is a path this child could read or write, and `PATH` is the one exception.
		for (const [name, value] of Object.entries(launch.env ?? {})) {
			// The host's own Pi package is the one exception beside `PATH`: it is code the child imports, read-only like the
			// bootstrap itself, which also lies outside the root. `checkComposedStart` holds it to exactly the package the
			// host's own lookup names, so the exception cannot carry another path.
			if (name === "PATH" || name === SDK_DIR_VARIABLE || typeof value !== "string" || !value.includes(path.sep)) continue;
			assertInsideRoot(prod.root, `production launch env ${name}`, value);
		}
		const inputPath = assertInsideRoot(prod.root, "production call input file", launch.args?.at(-1));
		const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
		for (const field of CONTAINED_CONFIG_FIELDS) assertInsideRoot(prod.root, `production call input ${field}`, input[field]);
		// The transcript a continuation reopens is a path the host composed too, and the only one that is not a field
		// of the input's own top level.
		if (typeof input.session?.file === "string") assertInsideRoot(prod.root, "production call input session.file", input.session.file);
		evidence.inputs.push({
			session: input.session,
			tools: input.tools,
			questionTool: input.questionTool,
			modelsPath: input.modelsPath,
			authPath: input.authPath,
			sessionDir: input.sessionDir,
			agentDir: input.agentDir,
			// The catalog half of the same question, kept as read rather than as a verdict: `allowModelNetwork` is
			// production's own explicit permission, and `catalogBaseUrl` is the url it composes for a refresh — absent by
			// production default, which is what the check below holds it to. Presence is recorded separately so that a
			// `catalogBaseUrl: undefined` written into the input reads as present rather than as never composed.
			allowModelNetwork: input.allowModelNetwork,
			catalogBaseUrl: input.catalogBaseUrl,
			hasCatalogBaseUrl: Object.hasOwn(input, "catalogBaseUrl"),
		});
		const child = await startPiChild(options);
		evidence.resolved += 1;
		evidence.pids.push(child.pid);
		registerPid(child.pid);
		// The registry holds pids the harness may signal, and a child that has ended is not one: the same rule RpcChild
		// keeps for its own process, so an interrupt never reaches a pid somebody else has since been given.
		const forget = () => spawnedPids.delete(child.pid);
		child.exited.then(forget, forget);
		return child;
	};
	return { evidence, start };
}

/**
 * One call through the production backend, with everything it left behind collected in one place: the run it reported,
 * the single call report, what a monitor saw, how often progress was reported, the fixture requests that arrived while
 * it ran, and the composed-start evidence. The role is the explicit one on a first call and the recorded selection on
 * a continuation, which is what `piRole` is given a recorded selection for.
 *
 * The call is given a signal of its own, which is how a real host runs one, and the only two things that ever abort it
 * are the harness running out of patience in `withinDeadline` and a case that asked for a `trigger`: a call with
 * neither that answers in time ran to the end uncancelled. The controller is this call's alone, so one case's
 * patience can never reach another's child.
 *
 * The three optional halves, and why each is composed here rather than in a case:
 *
 * - `question` turns the call's questions on, because the presence of an `onQuestion` is the whole of what does that
 *   in `pi-prepare.ts`. The callback records the prompt exactly as the child asked it and holds it to the one the case
 *   named in `expect`, pushes whatever `steers` this call carries, signals the case's own `opened` latch, and then
 *   either returns the one configured answer or holds the dialog until its own signal aborts. The order is deliberate:
 *   a steer goes in before the latch opens, so a case whose trigger cancels on that latch can never pre-empt its own
 *   steer, and the answer comes last of all.
 * - `steers` is pushed through a real `backend.control()` queue, which is the same object the run lifecycle hands a
 *   backend, and is pushed from the question callback and nowhere else — a steer only means something while a turn is
 *   live, and a question being open is the one moment this harness can be sure of one. A call with steers and no
 *   question is therefore a composition error and is refused rather than pushed at some guessed moment.
 * - `trigger` is a cancellation that has to land mid-call. The run's promise is created first, awaited by nothing yet;
 *   the trigger is then awaited under its own bound; and only then is this call's controller aborted and the same
 *   promise awaited to the end through `withinDeadline`. Nothing is raced against the call and nothing is abandoned,
 *   and a trigger that failed still cancels and still awaits — it is reported afterwards, once the call is over.
 */
async function productionCall(prod, result, { label, prompt, intent, recorded, question, steers, trigger }) {
	if (steers !== undefined && question === undefined) {
		throw new Error(`the production call ${label} names steers and no question: this harness pushes a call's steers from its question callback, so a call with no question has no moment it can be sure of to push one at`);
	}
	const role = piRole({ role: "implement", ...(recorded === undefined ? { model: PROD_MODEL, effort: PROD_EFFORT } : {}) }, recorded, {});
	const reports = [];
	const events = [];
	const contracts = [];
	const counts = { progress: 0 };
	const controller = new AbortController();
	const { evidence, start } = productionStart(prod);
	const backend = createPiBackend({
		agentDir: async () => prod.hostAgent,
		readContract: (name) => {
			contracts.push(name);
			return PROD_CONTRACT;
		},
		start,
		env: prod.env,
		onCall: (report) => reports.push(report),
	});
	const queue = steers === undefined ? undefined : backend.control();
	// What the case then asserts on: the prompts the child actually asked, how many steers this queue took in, and how
	// many held dialogs were released by their own signal aborting. A push the queue would not take is `false` and is
	// not counted here either, which is what makes `admitted` the number the steer report's own `pushed` has to agree
	// with; `released` is this harness's own race-independent evidence that a cancellation reached a held question.
	const asked = { prompts: [], admitted: 0, released: 0 };
	const onQuestion =
		question === undefined
			? undefined
			: async (text, signal) => {
					asked.prompts.push(text);
					// Pinned where it happens rather than after the call: a question that is not the one the fixture scripted
					// makes every assertion below it about something else, and it is worth saying so at the moment it arrives.
					result.check(text === question.expect, `${label}: the child asked ${JSON.stringify(text)} rather than the exact question this case scripted`);
					for (const steer of steers ?? []) {
						if (queue.push(steer)) asked.admitted += 1;
					}
					question.opened?.();
					if (question.answer === undefined) {
						return await holdQuestion(signal, () => {
							asked.released += 1;
						});
					}
					return question.answer;
				};
	const from = prod.server.requests.length;
	const running = backend.run({
		role,
		prompt,
		cwd: prod.dirs.project,
		session: backend.session(intent ?? { kind: "new" }),
		signal: controller.signal,
		...(queue === undefined ? {} : { input: queue }),
		...(onQuestion === undefined ? {} : { onQuestion }),
		onProgress: () => {
			counts.progress += 1;
		},
		onEvent: (event) => events.push(event),
	});
	// Settled once, right here, for two reasons: a rejection that lands while a trigger is being waited for is already
	// observed and can never be an unhandled one, and the trigger's own race can see a call that is already over.
	// `withinDeadline` below still attaches its own handlers to the same promise and still reports it whole.
	const settled = running.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
	let triggerFailure;
	if (trigger !== undefined) {
		try {
			await awaitTrigger(label, trigger, settled);
			result.say(`${label}: ${trigger.what} is ready, so this call is now cancelled through its own signal`);
		} catch (error) {
			triggerFailure = error;
		}
		// Either way. A trigger that failed is still a case that has a call running, and the only way to end one from
		// outside is its own signal: it is cancelled and awaited below, and the failure is reported once that is done.
		controller.abort();
	}
	const run = await withinDeadline(`the production call ${label}`, controller, running);
	const call = {
		label,
		role,
		// Kept because the checks over a cancellation need it: a run's prompt is a thing no diagnostic may repeat, and
		// the marker check for that is composed from the call rather than restated by every case.
		prompt,
		run,
		reports,
		report: reports[0],
		events,
		contracts,
		progress: counts.progress,
		requests: prod.server.requests.slice(from),
		start: evidence,
		questions: asked,
		...(queue === undefined ? {} : { queue }),
	};
	result.say(
		`${label}: ok ${!failed(run)}, stopReason ${run.stopReason}, session ${run.session?.sessionId ?? "-"} at ${run.session?.checkpoint ?? "-"}, tokens ${run.tokensIn}/${run.tokensOut}, cost ${run.costUsd ?? 0}, turns ${run.numTurns ?? 0}, events ${JSON.stringify(events.map((event) => event.type))}, provider requests ${call.requests.length}, progress ${call.progress}`,
	);
	result.say(
		`${label} text: ${JSON.stringify((run.text ?? "").slice(0, PROD_TEXT_PREVIEW_CHARS))}${run.errorMessage === undefined ? "" : `, message ${JSON.stringify(run.errorMessage)}`}`,
	);
	if (question !== undefined) result.say(`${label} questions: ${asked.prompts.length} asked, ${asked.admitted} steer(s) admitted into the queue, ${asked.released} released by their own signal aborting`);
	// After the two summary lines, so a trigger that failed still prints what the call it cancelled came back with.
	if (triggerFailure !== undefined) throw triggerFailure;
	return call;
}

/**
 * What the composition put in the launch, checked rather than assumed, and the call input it wrote beside it.
 *
 * `questionTool` is the one thing a caller chooses, and it chooses between two assertions rather than relaxing one: a
 * call that passed no question callback has to have composed `questionTool: false` and a tool list with no
 * `ask_orchestrator` in it at all, and a call that passed one has to have composed `true` with that name in the list
 * exactly once and last — last because `pi-launch.ts` appends it after the role's own tools, and the list a session
 * is built with is the allow list, so a name that moved or appeared twice is a composition this case did not measure.
 */
function checkComposedStart(result, prod, call, { questionTool = false } = {}) {
	const evidence = call.start;
	const input = evidence.inputs[0];
	result.check(evidence.attempts === 1 && evidence.resolved === 1, `${call.label}: ${evidence.attempts} start attempt(s) and ${evidence.resolved} child(ren) for one call`);
	result.check(evidence.commands.every((command) => command === "node"), `${call.label}: the composition launched ${JSON.stringify(evidence.commands)} rather than node`);
	result.check(
		evidence.bootstraps.every((bootstrap) => bootstrap === PI_BOOTSTRAP_PATH),
		`${call.label}: the launch named ${JSON.stringify(evidence.bootstraps)} rather than the installed ${PI_BOOTSTRAP_PATH}`,
	);
	result.check(evidence.markers.every((marker) => marker === "pi"), `${call.label}: the child marker was ${JSON.stringify(evidence.markers)} rather than pi`);
	const preload = ["--import", pathToFileURL(PI_SDK_RESOLVE_PATH).href];
	result.check(
		evidence.preloads.every((args) => JSON.stringify(args) === JSON.stringify(preload)),
		`${call.label}: the launch preloaded ${JSON.stringify(evidence.preloads)} rather than the resolver that runs the host's own Pi`,
	);
	result.check(
		evidence.sdkDirs.every((dir) => dir === prod.sdkDir),
		`${call.label}: the child was pointed at ${JSON.stringify(evidence.sdkDirs)} rather than the host's own Pi package ${prod.sdkDir}`,
	);
	// Non-vacuous by counting first: an empty evidence list would satisfy every() below, so the recorded values have to
	// be one per start attempt before their contents are worth anything.
	result.check(
		evidence.offline.length === evidence.attempts && evidence.inputs.length === evidence.attempts && evidence.attempts > 0,
		`${call.label}: ${evidence.attempts} start attempt(s) left ${evidence.offline.length} offline reading(s) and ${evidence.inputs.length} recorded input(s)`,
	);
	result.check(
		evidence.offline.every((value) => value === PROD_REQUIRED_OFFLINE),
		`${call.label}: the composed environment carried PI_OFFLINE ${JSON.stringify(evidence.offline)} rather than exactly ${JSON.stringify(PROD_REQUIRED_OFFLINE)}`,
	);
	// The catalog default, which the offline switch above is the other half of: production permits a refresh explicitly
	// and composes no url for one, so the only base url a child could refresh from is Pi's own default. A composed url
	// would be a second endpoint this group never configured, and it fails the case rather than being noted.
	result.check(
		evidence.inputs.every((recorded) => recorded.hasCatalogBaseUrl === false && recorded.catalogBaseUrl === undefined),
		`${call.label}: the call input composed a catalogBaseUrl: ${JSON.stringify(evidence.inputs.map((recorded) => recorded.catalogBaseUrl))}`,
	);
	result.say(
		`${call.label} network shape: PI_OFFLINE ${JSON.stringify(evidence.offline)}, allowModelNetwork ${JSON.stringify(evidence.inputs.map((recorded) => recorded.allowModelNetwork))}, catalogBaseUrl composed ${JSON.stringify(evidence.inputs.map((recorded) => recorded.hasCatalogBaseUrl))} (a harness precondition and a composed default, not a sandbox)`,
	);
	result.check(call.contracts.length === 1 && call.contracts[0] === call.role.contract, `${call.label}: the contract asked for was ${JSON.stringify(call.contracts)} rather than the role's own`);
	if (questionTool) {
		const tools = input?.tools ?? [];
		result.check(input?.questionTool === true, `${call.label}: the call input's questionTool is ${JSON.stringify(input?.questionTool)}, and this call passed a question callback`);
		result.check(
			tools.filter((tool) => tool === "ask_orchestrator").length === 1,
			`${call.label}: the call input's tools name the question tool ${tools.filter((tool) => tool === "ask_orchestrator").length} time(s): ${JSON.stringify(tools)}`,
		);
		result.check(tools.at(-1) === "ask_orchestrator", `${call.label}: the question tool is not the last of the composed tools ${JSON.stringify(tools)}`);
	} else {
		result.check(input?.questionTool === false, `${call.label}: the call input's questionTool is ${JSON.stringify(input?.questionTool)}, and this call passed no question callback`);
		result.check(input?.tools?.includes("ask_orchestrator") === false, `${call.label}: the call input's tools name the question tool: ${JSON.stringify(input?.tools)}`);
	}
	result.check(input?.modelsPath === prod.paths.userModelsPath, `${call.label}: the child reads its models from ${input?.modelsPath} rather than the host agent directory's own`);
	result.check(
		typeof input?.authPath === "string" && path.dirname(path.dirname(input.authPath)) === prod.paths.callsDir,
		`${call.label}: the auth path is ${input?.authPath}, and a host with no credential file of its own gets one inside the call's own directory`,
	);
	result.check(input?.agentDir === prod.paths.agentDir && input?.sessionDir === prod.paths.sessionDir, `${call.label}: the call input names agentDir ${input?.agentDir} and sessionDir ${input?.sessionDir}`);
	result.say(`${call.label} launch: node ${PI_BOOTSTRAP_PATH} <call input>, marker ${evidence.markers[0]}, pid ${evidence.pids[0]}`);
	result.say(`${call.label} input: session ${JSON.stringify(input?.session)}, tools ${JSON.stringify(input?.tools)}, questionTool ${input?.questionTool}`);
	result.say(`${call.label} input paths: modelsPath ${input?.modelsPath}, authPath ${input?.authPath}`);
}

/**
 * What a child's own ending has to look like for a production call to have left nothing behind. It is read off the
 * exit report the stage that stopped the child reported, whichever stage that was, and every field of it is one the
 * production retention decision is made from.
 *
 * `counters` is the one thing a caller may widen, and it widens by naming values rather than by switching a check
 * off: a counter named here may take one of exactly the values listed for it, and every counter not named must still
 * be zero. `total`, where a caller gives one, is the exact sum over the named counters — which is how "one dialog was
 * cancelled once, by one of the two mechanisms that can cancel one" is asserted without picking which mechanism.
 *
 * `failure` is the transport's own verdict on how the child ended, and it is named rather than always required to be
 * absent because the two are different endings: a child this host asked to stop that then stopped carries none, and a
 * cancelled one carries the `aborted` failure the cancellation itself was noted as. Either way it is pinned to exactly
 * one value, and the retention decision reads none of it — a failure of that kind is not a concern.
 */
function checkCleanExit(result, label, exit, { counters = {}, total, failure } = {}) {
	if (exit === undefined) {
		result.check(false, `${label}: the stage that stopped this child reported no exit at all`);
		return;
	}
	const cleanup = exit.cleanup;
	result.check(exit.failure?.kind === failure, `${label}: the transport's verdict on how the child ended is ${JSON.stringify(exit.failure?.kind)} rather than ${JSON.stringify(failure)}`);
	result.check(exit.stoppedByUs === true, `${label}: the child ended itself rather than being stopped by this host`);
	result.check(cleanup.root === "exited" || cleanup.root === "stopped", `${label}: its root is ${cleanup.root} rather than one that says the root is over`);
	result.check(cleanup.stdio === "closed", `${label}: its pipes are ${cleanup.stdio}`);
	result.check(cleanup.discovery === "ok", `${label}: descendant discovery was ${cleanup.discovery}`);
	result.check(cleanup.leftovers.length === 0, `${label}: ${cleanup.leftovers.length} verified leftover process(es)`);
	result.check(cleanup.skipped.length === 0, `${label}: ${cleanup.skipped.length} target(s) whose identity it could not prove`);
	result.check(cleanup.deadlineHit === false, `${label}: the cleanup hit its own deadline`);
	// Stricter than the retention decision on purpose, and knowingly so: a counter no caller named has to be zero,
	// deliberately, although only `streamsUnclosed` is itself a concern the disposition reads. The rest — a stray
	// settle, a late response, a dropped frame, a cancelled dialog — is timing evidence about the wire rather than
	// something left behind, so a nonzero one of those is a finding to look at and not proof of an unclean cleanup; it
	// fails here because a case that started counting one it did not expect is no longer the case this group is
	// measuring. What a case may do instead is name the counters its *own* shape legitimately produces and the exact
	// values they may take — a cancellation cancels one open dialog once, and that is a counter, not a leftover — and
	// `streamsUnclosed` is never one of those, because it is the only one retention actually reads. Every value is
	// printed so what it was is visible either way.
	const counted = Object.entries(exit.counters).filter(([, value]) => value !== 0);
	const unexpected = counted.filter(([name, value]) => !(counters[name] ?? []).includes(value));
	result.check(
		unexpected.length === 0,
		`${label}: counters that are not zero and were not named by this case: ${JSON.stringify(unexpected)} (named: ${JSON.stringify(counters)}; timing evidence about the wire, and only streamsUnclosed is itself a cleanup concern)`,
	);
	if (total !== undefined) {
		const named = Object.keys(counters);
		const sum = named.reduce((running, name) => running + (exit.counters[name] ?? 0), 0);
		result.check(sum === total, `${label}: the counters ${JSON.stringify(named)} add up to ${sum} rather than the ${total} this case's own shape produces`);
	}
	if (counted.length > 0) result.say(`${label}: counters that are not zero: ${JSON.stringify(counted)}`);
	const stderr = exit.stderr;
	result.check(
		stderr.serving === true && stderr.lastStage === PROD_LAST_STAGE && stderr.stageCount === PROD_STAGE_COUNT,
		`${label}: the bootstrap's stage diagnostics read serving=${stderr.serving}, last ${stderr.lastStage}, count ${stderr.stageCount}`,
	);
	result.say(
		`${label}: root ${cleanup.root}, stdio ${cleanup.stdio}, discovery ${cleanup.discovery}, stages ${stderr.stageCount} (last ${stderr.lastStage}, sdk ${stderr.sdk ?? "-"}), stderr tail ${JSON.stringify(stderr.tail.trim().split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200))}`,
	);
}

/**
 * The cut `extensions/backends/pi-outcome.ts` makes on a value it bounds, reproduced exactly: the first `max` code
 * points, with one ellipsis appended when and only when something was dropped. It is code points rather than units so
 * a cut never halves a character, which is that module's own rule and the reason this is written out rather than done
 * with `slice`. The cap itself is never a number of this file's own — `PI_ACTIVITY_CHARS` is imported — so a pinned
 * `brief` follows the window the mapper actually cuts to instead of a copy of it that could drift.
 */
function codePointCut(value, max) {
	const points = [...value];
	return points.length <= max ? value : `${points.slice(0, max).join("")}…`;
}

/**
 * The two events one tool call of the child's own becomes for a monitor, composed exactly the way
 * `extensions/backends/pi-outcome.ts`'s mapper composes them — the same fields in the same order — so that comparing
 * a whole event list compares whole events rather than a few of their fields. A spec is complete on purpose: `brief`
 * is what that mapper's own one-argument summary comes to, bounded by `codePointCut` above, `input` its bounded
 * argument record and `result` the
 * bounded text of the tool's own result, and a case that left one of them to chance would be a case that had stopped
 * measuring what the mapper does with a record. `id` is required because every fixture step here carries one, and the
 * mapper leaves a result with no id out altogether rather than filing it under nothing.
 */
function expectedToolEvents({ name, id, brief = "", input, result = "", isError = false }) {
	if (typeof name !== "string" || typeof id !== "string") throw new Error(`a tool event spec names a tool and the id its call carries, and this one is ${JSON.stringify({ name, id })}`);
	return [
		{ type: "tool_call", name, brief, id, ...(input === undefined ? {} : { input }) },
		{ type: "tool_result", toolUseId: id, text: result, isError },
	];
}

/**
 * Everything an ordinary production call owes, whichever session it ran in: a turn that finished, one report at the
 * task stage, one child started and stopped cleanly, a disposition with no concern and the call directory gone with
 * it, the structured session reference a record would carry and no flat checkpoint beside it, the exact selection the
 * call asked for, this turn's own canonical accounting, the events a monitor should see, and loopback requests each
 * carrying this call's contract and the project's context and neither of the two sentinels nothing points a child at.
 *
 * Three things a caller may say, and none of them relaxes anything. `requests` is how many requests this turn's work
 * takes, and the accounting is then the sum over all of them rather than one request's: tokens, the price
 * `models.json` puts on them, and the assistant messages the turn counted, which is one per request. `tools` is the
 * tool calls the child makes along the way, in order, each becoming the exact pair of events above and nothing else
 * between them. `questionTool` travels through to `checkComposedStart`. The default of all three is the quiet call
 * this helper has always checked: one request, no tool, no question, and exactly two events.
 */
function checkProductionCall(result, prod, call, { text, tools = [], requests = 1, questionTool = false }) {
	const run = call.run;
	const report = call.report;
	const session = run.session;
	result.check(failed(run) === false, `${call.label}: the run failed (${run.errorMessage ?? run.stopReason})`);
	result.check(run.stopReason === "stop", `${call.label}: stopReason ${run.stopReason}`);
	result.check(run.text === text, `${call.label}: the run's text is ${JSON.stringify(run.text)} rather than ${JSON.stringify(text)}`);
	result.check(call.reports.length === 1, `${call.label}: ${call.reports.length} call report(s) for one call`);
	result.check(report?.stage === "task", `${call.label}: the call stopped at ${report?.stage} rather than its task`);
	result.check(report?.startCalled === true && report?.startResolved === true, `${call.label}: start called ${report?.startCalled}, resolved ${report?.startResolved}`);
	const ended = report?.ended;
	result.check(ended?.kind === "task", `${call.label}: the call ended ${ended?.kind} rather than at a task`);
	const task = ended?.kind === "task" ? ended.result : undefined;
	result.check(task?.ok === true, `${call.label}: the turn refused with ${task?.ok === false ? task.reason : "no result at all"}`);
	checkCleanExit(result, `${call.label} exit`, task?.exit);
	result.check(report?.disposition?.safe === true && report?.disposition?.concerns?.length === 0, `${call.label}: disposition ${JSON.stringify(report?.disposition)}`);
	result.check(report?.storage?.attempted === true && report?.storage?.disposed === true, `${call.label}: storage attempted ${report?.storage?.attempted}, disposed ${report?.storage?.disposed}`);
	result.check(path.dirname(report?.storage?.callDir ?? "") === prod.paths.callsDir, `${call.label}: the call directory ${report?.storage?.callDir} is not under the layout's own calls directory`);
	result.check(report?.storage?.callDir !== undefined && !fs.existsSync(report.storage.callDir), `${call.label}: the call directory ${report?.storage?.callDir} is still on disk`);
	for (const pid of call.start.pids) result.check(!pidAlive(pid), `${call.label}: the child pid ${pid} is still alive`);

	result.check(session?.backend === "pi", `${call.label}: the published session is ${JSON.stringify(session)}`);
	result.check(
		typeof session?.sessionFile === "string" && path.dirname(session.sessionFile) === prod.paths.sessionDir,
		`${call.label}: the session file ${session?.sessionFile} is not in this project's own durable session directory`,
	);
	const onDisk = typeof session?.sessionFile === "string" && fs.existsSync(session.sessionFile);
	result.check(onDisk, `${call.label}: the published session file is not on disk`);
	result.check(run.sessionId === session?.sessionId, `${call.label}: the scalar id ${run.sessionId} is not the reference's ${session?.sessionId}`);
	result.check(run.checkpoint === undefined, `${call.label}: a flat checkpoint ${run.checkpoint} was published, and a pi continuation stands on the reference alone`);
	const entries = onDisk ? readSessionEntries(session.sessionFile) : [];
	const last = entries.at(-1);
	result.check(last?.id === session?.checkpoint, `${call.label}: the checkpoint ${session?.checkpoint} is not the transcript's last entry ${last?.id}`);
	result.check(
		last?.type === "message" && last?.message?.role === "assistant",
		`${call.label}: the entry the checkpoint names is ${last === undefined ? "absent" : entryLabel(last)} rather than an assistant message`,
	);

	result.check(run.selection?.model === PROD_MODEL && run.selection?.effort === PROD_EFFORT, `${call.label}: the selection read back as ${JSON.stringify(run.selection)}`);
	result.check(run.modelId === PROD_MODEL, `${call.label}: the run names model ${run.modelId}`);
	result.check(call.requests.length === requests, `${call.label}: ${call.requests.length} provider request(s) for a turn this case expects ${requests} of`);
	const request = call.requests[0];
	result.check(run.numTurns === requests, `${call.label}: the turn counted ${run.numTurns} assistant message(s) rather than the ${requests} its requests produced`);
	// The sum over every request of the turn, which is what the canonical accounting is a delta of: one request's own
	// usage would under-report a turn that took several, and a sum that is short of one of them names which.
	const usages = call.requests.map((one) => one.usageSent);
	const whole = usages.every((sent) => sent !== undefined);
	const promptTokens = whole ? usages.reduce((running, sent) => running + sent.prompt_tokens, 0) : undefined;
	const completionTokens = whole ? usages.reduce((running, sent) => running + sent.completion_tokens, 0) : undefined;
	result.check(
		whole && run.tokensIn === promptTokens && run.tokensOut === completionTokens && run.cacheRead === 0 && run.cacheWrite === 0,
		`${call.label}: the canonical accounting is ${run.tokensIn}/${run.tokensOut} (cache ${run.cacheRead}/${run.cacheWrite}) against the usage the fixture sent across ${usages.length} request(s), ${JSON.stringify(usages)}`,
	);
	const expected = whole ? usages.reduce((running, sent) => running + fixtureCost(sent), 0) : undefined;
	result.check(
		expected !== undefined && typeof run.costUsd === "number" && Math.abs(run.costUsd - expected) < PROD_COST_EPSILON,
		`${call.label}: the reported cost ${run.costUsd} is not ${expected}, which is what models.json prices ${JSON.stringify(usages)} at per million tokens (${JSON.stringify(MODEL_COST)})`,
	);
	result.check(
		JSON.stringify(call.events) === JSON.stringify([{ type: "init", sessionId: session?.sessionId }, ...tools.flatMap(expectedToolEvents), { type: "turn_result", ok: true }]),
		`${call.label}: the events a monitor saw are ${JSON.stringify(call.events)}`,
	);
	result.check(call.progress >= 2, `${call.label}: progress was reported ${call.progress} time(s)`);

	// Every request of the turn, not the first alone: the model, the key and the four sentinels are what each one of
	// them has to carry, and a second request that dropped the contract or picked up a sentinel is the interesting one.
	for (const [index, one] of call.requests.entries()) {
		const at = `${call.label} request ${index + 1}`;
		result.say(`${at}: ${describeRequest(one)}`);
		result.check(one.model === FIXTURE_MODEL, `${at}: the request asked for ${one.model}`);
		result.check(one.authorizationMatchesFixtureKey === true, `${at}: the request did not carry the dummy fixture key`);
		result.check(one.systemText?.includes(PROD_CONTRACT_SENTINEL) === true, `${at}: the contract this call was given is not in the system content`);
		result.check(one.systemText?.includes(PROJECT_CONTEXT_SENTINEL) === true, `${at}: the project's own AGENTS.md sentinel is not in the system content`);
		result.check(one.systemText?.includes(PROD_HOST_AGENT_SENTINEL) === false, `${at}: the host agent directory's context sentinel reached the system content`);
		result.check(one.systemText?.includes(USER_CONTEXT_SENTINEL) === false, `${at}: the fake user profile's context sentinel reached the system content`);
	}
	result.check(call.requests.length > 0, `${call.label}: no provider request arrived, so the checks over them looked at nothing`);
	checkComposedStart(result, prod, call, { questionTool });
	return { entries, request };
}

/**
 * Everything a production call the harness cancelled mid-turn owes, which is the other half of the two checks above
 * and is deliberately no looser than them. A cancellation is a failure with a shape of its own: the run says it was
 * cancelled and says so in `pi-outcome.ts`'s own fixed sentence and nothing else; it publishes the identity the
 * preparation verified and *no* checkpoint, flat or structured, because a cancelled turn produced none; the call
 * stopped at its task with that task refusing for `aborted`; the child was started, stopped once and ended with a
 * cleanup that left nothing at all; this call's own storage is gone, which is the disposition's own decision and only
 * ever licensed by a concern list that is empty; and every process of it is over.
 *
 * What `tool` is for: a cancellation lands on a tool call, so the events a monitor saw are the init, that call, at
 * most one result for it — Pi may or may not get as far as failing the tool before the child stops, and both are
 * honest — and the failed terminal event. Nothing else may be among them. The call itself is pinned whole, because
 * every field of it is the mapper's own composition; the optional result is pinned on its type, the id it is filed
 * under and whether it was an error, and its text is left as the child's own, because what a cancelled tool writes
 * into a result is the child's business and not something this harness fixes.
 *
 * **The two surfaces, and why they are not the same check.** A progress event deliberately carries a bounded copy of
 * a tool's own arguments: that is what the mapper is for, and a monitor showing a shell command is the feature rather
 * than a leak. A diagnostic is the opposite — `pi-outcome.ts` composes every sentence of one out of fixed text, and
 * nothing of the call, the child or the question may reach it. So:
 *
 * - `markers` is checked against the **diagnostic** surfaces alone: `run.errorMessage`, `run.cleanupNotice`, the
 *   terminal `turn_result` message, and `run.stderr`, which is additionally pinned to the empty string because the
 *   child's own stderr is the transport's to keep and is never a field of a run.
 * - `softMarkers` is checked against the two surfaces that are allowed to carry a tool's own text but not a prompt,
 *   a question or a session identity: `run.activity`, which the mapper writes the tool's name and brief into, and the
 *   optional tool result's own text. They are checked against the diagnostic surface as well, because anything the
 *   looser surface may not carry the stricter one certainly may not.
 * - Every call's own prompt and both halves of its session identity are composed here rather than named by a case, and
 *   are forbidden on both surfaces.
 * - The `tool_call` event's own `brief` and `input` are checked against neither. They are the argument, bounded, and
 *   a case that marker-checked its own command there would be asserting that the mapper does not do its job.
 *
 * No list's values are ever printed in a failure: a marker is named by its list and index, because the whole point of
 * one is that it should not appear in output.
 *
 * **What `question` is, and is not, evidence of.** A run cancelled with a dialog open has two ends in flight, and the
 * run's own signal is the whole of what classifies either of them: the task names the cancellation whichever end
 * arrives first, and both of its paths retain the dialog's recorded outcome beside that reason — the question branch
 * carries the outcome it raced on, and the gate the turn branch reaches reads the same recorded one. So the outcome is
 * required, its end is pinned exactly and its admission has to say nothing was written. What says the cancellation
 * reached the question is the case's own assertion on `questions.released`, which is this harness's record of the held
 * dialog's signal aborting and is independent proof rather than a second reading of the same evidence.
 *
 * What it will not do: terminate anything. A process still running here is a failed case, and the harness's own
 * registry is a net for the end of the run rather than something that could make a native cleanup that failed read as
 * a pass. "Over" is `processEnded`'s question rather than `pidAlive`'s, so a zombie and a recycled pid both read as
 * over rather than as a survivor.
 */
function checkProductionAbort(result, prod, call, { tool, toolEnd, requests = 1, counters = {}, countersTotal, question, questionTool = false, markers = [], softMarkers = [], terminated = [] }) {
	const run = call.run;
	const report = call.report;
	const label = call.label;

	result.check(failed(run) === true, `${label}: the cancelled call was reported as a run that finished`);
	result.check(run.aborted === true, `${label}: the run's aborted flag is ${run.aborted}`);
	result.check(run.stopReason === "aborted", `${label}: stopReason ${run.stopReason}`);
	result.check(run.errorMessage === PROD_CANCELLED_MESSAGE, `${label}: the run's message is ${JSON.stringify(run.errorMessage)} rather than the fixed sentence for a cancelled turn`);
	result.check(run.cleanupNotice === undefined, `${label}: the run carries a cleanup line (${JSON.stringify(run.cleanupNotice)}), so its child's ending left something behind`);
	result.check(run.text === "", `${label}: the run's text is ${JSON.stringify(run.text)}, and a cancelled turn whose only answer was a tool call has none`);
	// Exactly the empty string, which is `finishRun`'s own first act: the child's stderr is the transport's to keep, for
	// a person to look at where it is kept, and a run's own field is not that place.
	result.check(run.stderr === "", `${label}: the run carries ${JSON.stringify((run.stderr ?? "").slice(0, PROD_TEXT_PREVIEW_CHARS))} as its stderr rather than the empty string`);
	result.say(`${label} activity: ${JSON.stringify(run.activity)}`);

	result.check(call.reports.length === 1, `${label}: ${call.reports.length} call report(s) for one call`);
	result.check(report?.stage === "task", `${label}: the call stopped at ${report?.stage} rather than its task`);
	result.check(report?.startCalled === true && report?.startResolved === true, `${label}: start called ${report?.startCalled}, resolved ${report?.startResolved}`);
	const ended = report?.ended;
	result.check(ended?.kind === "task", `${label}: the call ended ${ended?.kind} rather than at a task`);
	const task = ended?.kind === "task" ? ended.result : undefined;
	result.check(task?.ok === false && task.reason === "aborted", `${label}: the turn ended ${task?.ok === true ? "ok" : JSON.stringify(task?.reason)} rather than refusing for a cancellation`);

	// The session the preparation verified, and nothing a continuation could stand on: that is the whole of what a
	// cancelled run may publish, and a checkpoint on either the reference or the flat field would be one too many.
	result.check(run.session?.backend === "pi" && typeof run.session?.sessionId === "string", `${label}: the published session is ${JSON.stringify(run.session)}`);
	result.check(run.session?.checkpoint === undefined, `${label}: the published session names checkpoint ${run.session?.checkpoint}, and a cancelled turn produced none`);
	result.check(run.checkpoint === undefined, `${label}: a flat checkpoint ${run.checkpoint} was published`);
	result.check(run.sessionId === run.session?.sessionId, `${label}: the scalar id ${run.sessionId} is not the reference's ${run.session?.sessionId}`);

	// The dialog, required whichever side of the task's own race arrived first. A run cancelled with a question open has
	// two ends in flight — the turn the transport abandons and the fatal outcome the router produces — and the signal is
	// what classifies both of them as the cancellation they are; each path retains the outcome the router recorded, the
	// question branch by carrying the one it raced on and the turn branch through the gate that reads it. So the outcome
	// is pinned rather than reported, and what says the cancellation actually reached the question is asserted by the
	// case itself, off this harness's own callback: the held dialog's signal aborting, which is independent of the race.
	if (question === undefined) {
		result.check(task?.outcome === undefined, `${label}: the turn kept a question outcome (${JSON.stringify(task?.outcome?.end)}) for a call that asked none`);
	} else {
		const outcome = task?.outcome;
		result.check(outcome !== undefined, `${label}: the turn kept no question outcome beside the cancellation it reported, and both of its cancellation paths retain the one the router recorded`);
		result.check(outcome?.end === question.end, `${label}: the dialog ended ${JSON.stringify(outcome?.end)} rather than ${JSON.stringify(question.end)}`);
		// Not pinned to one code: a cancellation reaches the dialog through the transport's own abort listener and the
		// router's, in that order, and which of the two got there first decides whether the answer came back `closed` or
		// `duplicate`. Both say the same thing — nothing was admitted for writing — and that is what is asserted.
		result.check(outcome?.admission !== undefined && outcome.admission.code !== "sent", `${label}: the answer to the cancelled dialog was admitted as ${JSON.stringify(outcome?.admission)}`);
		result.say(`${label} question outcome: end ${outcome?.end}, admission ${JSON.stringify(outcome?.admission?.code)}, error kept ${outcome !== undefined && "error" in outcome}`);
	}

	// The steer account, which is zero on both cancellation cases: neither pushes one, and a queue that counted a
	// delivery nobody asked for would be a steer this harness did not send.
	const steers = task?.steers;
	result.check(steers !== undefined, `${label}: the turn reported no steer account at all`);
	result.check(
		steers?.open === false && steers?.pushed === 0 && steers?.sent === 0 && steers?.rejected === 0 && steers?.refused === 0 && steers?.failed === 0 && steers?.dropped === 0 && steers?.lastFailure === undefined,
		`${label}: the steer account is ${JSON.stringify(steers)} rather than a closed queue nothing was pushed into`,
	);

	// `aborted` rather than absent: a cancellation is noted as this child's own ending by the transport, which is not a
	// concern the retention decision reads and is exactly the verdict a cancelled child has to carry.
	checkCleanExit(result, `${label} exit`, task?.exit, { counters, failure: "aborted", ...(countersTotal === undefined ? {} : { total: countersTotal }) });
	result.check(report?.disposition?.safe === true && report?.disposition?.concerns?.length === 0, `${label}: disposition ${JSON.stringify(report?.disposition)}`);
	result.check(report?.storage?.attempted === true && report?.storage?.disposed === true, `${label}: storage attempted ${report?.storage?.attempted}, disposed ${report?.storage?.disposed}`);
	result.check(path.dirname(report?.storage?.callDir ?? "") === prod.paths.callsDir, `${label}: the call directory ${report?.storage?.callDir} is not under the layout's own calls directory`);
	result.check(report?.storage?.callDir !== undefined && !fs.existsSync(report.storage.callDir), `${label}: the call directory ${report?.storage?.callDir} is still on disk`);
	result.check(callDirs(prod).length === 0, `${label}: the calls directory still holds ${JSON.stringify(callDirs(prod))}`);
	// `processEnded` rather than `pidAlive`: the question here is whether the process this call started is over, and a
	// zombie answers `kill(pid, 0)` while being over, so the signal-reachability question would read one as alive.
	for (const pid of call.start.pids) {
		const over = processEnded(pid);
		result.check(over.gone, `${label}: the child pid ${pid} is not over (${over.why})`);
	}

	// The descendants production's own cleanup says it signalled and then verified gone. A case names the ones it put
	// there on purpose; the list is printed either way, because what a cleanup reached is the finding.
	const cleanup = task?.exit?.cleanup;
	const reached = (cleanup?.terminated ?? []).map((process) => process.pid);
	for (const pid of terminated) result.check(reached.includes(pid), `${label}: the cleanup's terminated list ${JSON.stringify(reached)} does not name the pid ${pid} this case proved was live and detached`);
	result.say(`${label} cleanup: terminated ${JSON.stringify(reached)}, leftovers ${JSON.stringify((cleanup?.leftovers ?? []).map((process) => process.pid))}, skipped ${JSON.stringify((cleanup?.skipped ?? []).map((process) => process.pid))}`);

	result.check(call.requests.length === requests, `${label}: ${call.requests.length} provider request(s) reached the fixture for a call this case cancelled after ${requests}`);
	result.check(prod.server.unscripted.length === 0, `${label}: the fixture saw ${prod.server.unscripted.length} unscripted request(s): ${JSON.stringify(prod.server.unscripted.map((request) => request.note))}`);

	// The init, the tool call this case cancelled on, at most one result for it, and the failed terminal event, and
	// nothing else among them. The result is optional because the child may or may not reach the point of failing the
	// tool before it is stopped, and both are honest; what is pinned about one that did arrive is its type, the id it is
	// filed under and whether it was an error, and its text is read and printed rather than fixed, because what a
	// cancelled tool writes is the child's own and is not something this harness decides.
	const [callEvent, resultEvent] = expectedToolEvents(tool);
	const events = call.events;
	result.check(events.length === 3 || events.length === 4, `${label}: a monitor saw ${events.length} event(s) rather than the init, the tool call, an optional result and the terminal one: ${JSON.stringify(events)}`);
	result.check(JSON.stringify(events[0]) === JSON.stringify({ type: "init", sessionId: run.session?.sessionId }), `${label}: the first event is ${JSON.stringify(events[0])} rather than this run's own init`);
	result.check(JSON.stringify(events[1]) === JSON.stringify(callEvent), `${label}: the tool call event is ${JSON.stringify(events[1])} rather than ${JSON.stringify(callEvent)}`);
	const seenResult = events.length === 4 ? events[2] : undefined;
	if (seenResult !== undefined) {
		result.check(
			seenResult.type === resultEvent.type && seenResult.toolUseId === resultEvent.toolUseId && seenResult.isError === toolEnd?.isError && typeof seenResult.text === "string",
			`${label}: the tool result event is ${JSON.stringify({ type: seenResult.type, toolUseId: seenResult.toolUseId, isError: seenResult.isError })} rather than an error result of the kind this case expects, filed under ${JSON.stringify(resultEvent.toolUseId)}`,
		);
	}
	result.check(
		JSON.stringify(events.at(-1)) === JSON.stringify({ type: "turn_result", ok: false, message: PROD_CANCELLED_MESSAGE }),
		`${label}: the terminal event is ${JSON.stringify(events.at(-1))} rather than the failed one carrying the fixed cancellation sentence`,
	);
	result.say(`${label} tool result event: ${seenResult === undefined ? "none arrived before the child was stopped" : `isError ${seenResult.isError}, text ${JSON.stringify(String(seenResult.text).slice(0, PROD_TEXT_PREVIEW_CHARS))}`}`);

	// The two surfaces, checked apart, and the three lists over them.
	//
	// `diagnostics` is what `pi-outcome.ts` composes out of fixed text alone, so nothing of the call, the child or its
	// question may be anywhere in it. `soft` is the pair that is *allowed* to carry a tool's own command — the mapper
	// writes the tool's name and brief into an activity line, and a cancelled tool writes whatever it likes into its
	// result — and still may not carry a prompt, a question or a session identity.
	//
	// `common` is every call's own: its prompt and both halves of the session identity it ran in, which are forbidden
	// on both surfaces and are composed here rather than repeated by each case. `markers` is a case's own additions to
	// the diagnostic surface alone, which is where a path belongs — a case root or a script path is legitimately inside
	// an activity line. `softMarkers` is a case's additions to the softer surface, and they are checked against the
	// diagnostic one too, because anything the looser surface may not carry the stricter one certainly may not.
	//
	// No marker's value is ever printed in a failure: each is named by its list and position, because a marker turning
	// up in output is the leak being looked for.
	const diagnostics = [run.errorMessage, run.cleanupNotice, events.at(-1)?.message, run.stderr].filter((value) => typeof value === "string");
	const soft = [run.activity, seenResult?.text].filter((value) => typeof value === "string");
	const common = [call.prompt, run.session?.sessionId, run.session?.sessionFile].filter((value) => typeof value === "string" && value !== "");
	const leakCheck = (list, name, surfaces, what) => {
		for (const [index, marker] of list.entries()) {
			const leaked = surfaces.filter((value) => value.includes(marker)).length;
			result.check(leaked === 0, `${label}: the value this case keeps as evidence alone at ${name}[${index}] reached ${leaked} of the ${surfaces.length} ${what}`);
		}
	};
	leakCheck(common, "common", [...diagnostics, ...soft], "diagnostic, activity and tool-result texts");
	leakCheck(markers, "markers", diagnostics, "diagnostic texts a person is shown");
	leakCheck(softMarkers, "softMarkers", [...diagnostics, ...soft], "diagnostic, activity and tool-result texts");
	result.check(common.length === 3, `${label}: ${common.length} of the prompt, session id and session file were available to check as markers, so that check looked at less than it should`);

	checkComposedStart(result, prod, call, { questionTool });
}

/**
 * What the production group deliberately does not measure, said out loud so that nobody reads a passing group as
 * covering it. None of the four below is exercised by any case of the group, and nothing here claims an answer.
 */
function sayProductionNotRun(result) {
	result.phase("NOT RUN in this group");
	result.say(
		"NOT RUN: a recorded checkpoint that is a custom_message, and one that is a session label. Producing either needs an extension inside the child to write it, and every role's own metadata in this build names no extension resource — so reaching those two shapes would mean naming one purely to manufacture them, which changes the role input this group is measuring. The exact-leaf gate's behaviour for both is therefore unmeasured here, and nothing here relaxes, restates or decides anything about that gate",
	);
	result.say(
		"NOT RUN: a branch that carries messages and no thinking-level entry, which is the reconstruction that appends one and advances the leaf. Reaching it needs a transcript fabricated by hand, and this group only ever reads transcripts a real child wrote",
	);
	result.say(
		"NOT RUN: a fork whose session file is not on disk when the host looks. Production records an assistant checkpoint and the forked turn that succeeded wrote its own file, so this group never reaches the deferred-write case — its existence is not ruled out by anything here",
	);
	result.say(
		"NOT RUN: the leaf a native navigation to a user target actually leaves behind. What U2 measures is the refusal — a session that did not read back as standing at the recorded entry — and that the leaf then stands at that entry's parent is inference from 0.85.1's own source rather than a reading of this child: the refusal stops the child before this harness can ask it where its leaf is",
	);
	result.say("none of the four is measured by this group: each is named so a pass below is not read as covering it");
}

/** Production: a new session, two restores of trusted checkpoints, and a fork at one, through the real backend. */
async function caseProductionTrustedCheckpoints(root, server, result) {
	const prod = setupProductionCase(root, server, result.name);
	server.install([textStep("prod-t1", "PROD-T1-ANSWER"), textStep("prod-t2", "PROD-T2-ANSWER"), textStep("prod-t3", "PROD-T3-ANSWER"), textStep("prod-f1", "PROD-F1-ANSWER")]);
	result.say(`production composition: createPiBackend over host agent directory ${prod.hostAgent}`);
	result.say(`layout: root ${prod.paths.root}, child agent directory ${prod.paths.agentDir}, sessions ${prod.paths.sessionDir}, calls ${prod.paths.callsDir}`);

	result.phase("A: a new session, through the production backend from end to end");
	const a = await productionCall(prod, result, { label: "A", prompt: "PROD-T1 first turn." });
	checkProductionCall(result, prod, a, { text: "PROD-T1-ANSWER" });
	result.check(fs.existsSync(prod.paths.agentDir), "the stable child agent directory is not there after a call");
	result.check(fs.existsSync(prod.paths.modelsStorePath), "the catalog store the layout publishes is not there after a call");
	result.check(callDirs(prod).length === 0, `the calls directory still holds ${JSON.stringify(callDirs(prod))}`);
	result.check(!fs.existsSync(prod.paths.userAuthPath), "the call wrote an auth file into the host agent directory, which it was given none of");
	result.check(sessionFiles(prod).length === 1, `the session directory holds ${JSON.stringify(sessionFiles(prod))} rather than one transcript`);
	const refA = a.run.session;
	if (refA === undefined) throw new Error("A published no session, so there is nothing for B, C and D to continue from");
	result.say(`refA: ${JSON.stringify(refA)}`);

	result.phase("B: resume A's checkpoint while it is still the transcript's last entry");
	const beforeB = readSessionEntries(refA.sessionFile);
	result.check(beforeB.at(-1)?.id === refA.checkpoint, `A's checkpoint ${refA.checkpoint} is not the last entry ${beforeB.at(-1)?.id}, so B would not be the current-leaf case`);
	result.say("what B measures: the recorded checkpoint is the transcript's own last entry when B starts, which is the current-leaf case of the restore's exact-leaf gate; what reopening itself appended in front of the navigation is asserted below and printed with it, rather than assumed");
	const b = await productionCall(prod, result, { label: "B", prompt: "PROD-T2 second turn.", intent: { kind: "resume", ref: refA }, recorded: a.run.selection });
	const evidenceB = checkProductionCall(result, prod, b, { text: "PROD-T2-ANSWER" });
	const refB = b.run.session;
	result.check(refB?.sessionId === refA.sessionId && refB?.sessionFile === refA.sessionFile, `the resume reported ${JSON.stringify(refB)} rather than A's own identity`);
	result.check(refB?.checkpoint !== refA.checkpoint, "the resumed turn left the checkpoint where it was, so B shows no movement");
	const addedByB = evidenceB.entries.slice(beforeB.length);
	result.say(`B appended: ${JSON.stringify(addedByB.map(entryLabel))}`);
	const inFrontOfB = addedByB.filter((entry) => entry.type !== "message");
	// Asserted rather than printed, because this is the whole of what makes B the current-leaf case. The claim is that
	// the navigation B's restore sent found the checkpoint already at the leaf and returned natively without moving it;
	// from outside the child the only evidence for that is that reopening appended no entry of its own in front of B's
	// own prompt. A reopening that wrote one — a thinking-level entry, say — would mean the leaf had been pushed off the
	// checkpoint and the navigation was a real move, which is a different gate passing under the same green result. So
	// it fails the case here, and the 15/15 result is what protects the no-op claim rather than a line of output.
	result.check(
		inFrontOfB.length === 0,
		`B: reopening appended ${JSON.stringify(inFrontOfB.map((entry) => entry.type))} of its own in front of B's prompt, so B's restore was a real move back to the checkpoint rather than Pi's current-leaf no-op, and B is no longer the case this phase measures`,
	);
	result.say(
		inFrontOfB.length === 0
			? "measured: reopening appended no entry of its own, so the navigation B's restore sent found the checkpoint already at the leaf — Pi's own current-leaf no-op, which passes this gate having skipped the hooks a real move runs"
			: `measured: reopening appended ${JSON.stringify(inFrontOfB.map((entry) => entry.type))} before the navigation, so B's restore moved the leaf back to the checkpoint rather than finding it there`,
	);
	const requestB = evidenceB.request;
	result.check(JSON.stringify(requestB?.roles) === JSON.stringify(["system", "user", "assistant", "user"]), `B's role sequence is ${JSON.stringify(requestB?.roles)}`);
	const textsB = conversationTexts(requestB ?? { messages: [] });
	result.check(
		textsB[0]?.includes("PROD-T1 first turn") && textsB[1]?.includes("PROD-T1-ANSWER") && textsB[2]?.includes("PROD-T2 second turn"),
		"B's outgoing context is not T1's turn followed by B's own prompt",
	);
	const userB = userEntry(evidenceB.entries, "PROD-T2 second turn.");
	result.check(userB?.parentId === refA.checkpoint, `B's user entry hangs off ${userB?.parentId} rather than A's checkpoint ${refA.checkpoint}`);
	if (refB === undefined) throw new Error("B published no session, so there is nothing for D to fork from");
	result.say(`refB: ${JSON.stringify(refB)}`);

	result.phase("C: resume A's checkpoint again, now that B has advanced the file");
	const c = await productionCall(prod, result, { label: "C", prompt: "PROD-T3 third turn.", intent: { kind: "resume", ref: refA }, recorded: a.run.selection });
	const evidenceC = checkProductionCall(result, prod, c, { text: "PROD-T3-ANSWER" });
	result.check(c.run.session?.sessionId === refA.sessionId && c.run.session?.sessionFile === refA.sessionFile, `C reported ${JSON.stringify(c.run.session)} rather than A's own identity`);
	const requestC = evidenceC.request;
	result.check(JSON.stringify(requestC?.roles) === JSON.stringify(["system", "user", "assistant", "user"]), `C's role sequence is ${JSON.stringify(requestC?.roles)}`);
	const textsC = conversationTexts(requestC ?? { messages: [] });
	result.check(
		textsC[0]?.includes("PROD-T1 first turn") && textsC[1]?.includes("PROD-T1-ANSWER") && textsC[2]?.includes("PROD-T3 third turn"),
		"C's outgoing context is not T1's branch alone followed by C's own prompt",
	);
	result.check(!textsC.some((text) => text.includes("PROD-T2")), "B's turn reached C's outgoing context, so the restore did not move off B's branch");
	const childrenOfA = evidenceC.entries.filter((entry) => entry.parentId === refA.checkpoint);
	result.say(`children of A's checkpoint: ${JSON.stringify(childrenOfA.map(entryLabel))}`);
	const userChildren = childrenOfA.filter((entry) => entry.type === "message" && entry.message?.role === "user");
	result.check(
		userChildren.length === 2 &&
			userChildren.some((entry) => messageText(entry.message).includes("PROD-T2 second turn")) &&
			userChildren.some((entry) => messageText(entry.message).includes("PROD-T3 third turn")),
		`B's and C's prompts are not the two user entries under A's checkpoint: ${JSON.stringify(userChildren.map(entryLabel))}`,
	);

	result.phase("D: fork at B's checkpoint, after C has branched the source");
	const sourceBeforeD = readSessionEntries(refB.sessionFile);
	const sourceHashBeforeD = hashFile(refB.sessionFile);
	const ancestry = ancestryOf(sourceBeforeD, refB.checkpoint);
	result.say(`ancestry of B's checkpoint: ${JSON.stringify(ancestry.map((entry) => entry.id))}`);
	const d = await productionCall(prod, result, { label: "D", prompt: "PROD-F1 fork turn.", intent: { kind: "fork", from: refB }, recorded: a.run.selection });
	const evidenceD = checkProductionCall(result, prod, d, { text: "PROD-F1-ANSWER" });
	const refF = d.run.session;
	// Presence first, so an absent reference cannot satisfy "not the source's" by being nothing at all: a fork that
	// published no session is a failure of this assertion rather than a pass through its optional chaining.
	result.check(
		typeof refF?.sessionId === "string" && typeof refF?.sessionFile === "string" && refF.sessionId !== refB.sessionId && refF.sessionFile !== refB.sessionFile,
		`the fork published ${JSON.stringify(refF)} rather than a session id and file of its own, both different from the source's`,
	);
	result.check(
		typeof refF?.sessionFile === "string" && path.dirname(refF.sessionFile) === prod.paths.sessionDir && fs.existsSync(refF.sessionFile),
		`the fork's session file ${refF?.sessionFile} is not a file in this project's own session directory`,
	);
	const prepared = d.report?.ended?.kind === "task" ? d.report.ended.prepared : undefined;
	result.check(prepared?.session?.checkpoint === refB.checkpoint, `the prepared fork stood at ${prepared?.session?.checkpoint} rather than the recorded ${refB.checkpoint}`);
	result.check(prepared?.session?.sessionId === refF?.sessionId, `the prepared fork's identity ${prepared?.session?.sessionId} is not the one the run published`);
	const header = evidenceD.entries[0];
	result.check(header?.type === "session" && header?.parentSession === refB.sessionFile, `the fork header's parentSession is ${header?.parentSession} rather than the source file`);
	const forkBody = evidenceD.entries.filter((entry) => entry.type !== "session");
	const preF1 = forkBody.slice(0, ancestry.length);
	result.check(
		JSON.stringify(preF1.map((entry) => entry.id)) === JSON.stringify(ancestry.map((entry) => entry.id)),
		`the fork's own first entries ${JSON.stringify(preF1.map((entry) => entry.id))} are not the source ancestry id for id`,
	);
	result.check(JSON.stringify(preF1.map(entryLabel)) === JSON.stringify(ancestry.map(entryLabel)), "the fork's copied entries differ in shape from the ancestry they came from");
	const ancestryIds = new Set(ancestry.map((entry) => entry.id));
	const addedByF1 = forkBody.slice(ancestry.length);
	result.check(!addedByF1.some((entry) => ancestryIds.has(entry.id)), "an entry of the ancestry appears after the copied prefix in the fork");
	result.say(`the fork added after the ancestry: ${JSON.stringify(addedByF1.map(entryLabel))}`);
	const textsD = conversationTexts(evidenceD.request ?? { messages: [] });
	result.check(
		textsD.some((text) => text.includes("PROD-T1 first turn")) && textsD.some((text) => text.includes("PROD-T2 second turn")) && textsD.some((text) => text.includes("PROD-F1 fork turn")),
		"the fork's turn does not carry T1, T2 and its own prompt",
	);
	result.check(!textsD.some((text) => text.includes("PROD-T3")), "C's turn reached the fork's outgoing context");
	result.check(
		hashFile(refB.sessionFile) === sourceHashBeforeD,
		`the source session file changed while the fork ran: ${JSON.stringify(readSessionEntries(refB.sessionFile).slice(sourceBeforeD.length).map(entryLabel))}`,
	);
	result.check(sessionFiles(prod).length === 2, `the session directory holds ${JSON.stringify(sessionFiles(prod))} rather than the source and its fork`);
	result.check(callDirs(prod).length === 0, `the calls directory still holds ${JSON.stringify(callDirs(prod))}`);

	result.phase("the two transcripts, read back");
	result.say("source:");
	for (const line of describeEntries(readSessionEntries(refB.sessionFile))) result.say(`  ${line}`);
	result.say("fork:");
	if (refF === undefined) result.say("  (the fork published no session of its own)");
	else for (const line of describeEntries(readSessionEntries(refF.sessionFile))) result.say(`  ${line}`);
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
	sayProductionNotRun(result);
}

/** Production: a recorded checkpoint that is a user message, and the exact-leaf gate that refuses to continue it. */
async function caseProductionUserTarget(root, server, result) {
	const prod = setupProductionCase(root, server, result.name);
	server.install([textStep("prod-u1", "PROD-U1-ANSWER")]);
	result.say(`production composition: createPiBackend over host agent directory ${prod.hostAgent}`);

	result.phase("U1: a new session, so there is a real transcript to name an entry of");
	const a = await productionCall(prod, result, { label: "U1", prompt: "PROD-U1 first turn." });
	const evidence = checkProductionCall(result, prod, a, { text: "PROD-U1-ANSWER" });
	const refA = a.run.session;
	if (refA === undefined) throw new Error("U1 published no session, so there is no recorded checkpoint to rewrite");
	const user = userEntry(evidence.entries, "PROD-U1 first turn.");
	result.check(user !== undefined, "the user message of the first turn is not in the transcript, so this case has no user target to name");
	if (user === undefined) throw new Error("no user entry to aim a continuation at");
	result.say(`the user entry of U1 is ${user.id}<-${user.parentId ?? "root"}, and U1's own trusted checkpoint is ${refA.checkpoint}`);

	result.phase("U2: a continuation whose recorded checkpoint is that user message");
	const hashBefore = hashFile(refA.sessionFile);
	const before = readSessionEntries(refA.sessionFile);
	const u2 = await productionCall(prod, result, {
		label: "U2",
		prompt: "PROD-U2 refused turn.",
		intent: { kind: "resume", ref: { ...refA, checkpoint: user.id } },
		recorded: a.run.selection,
	});
	const run = u2.run;
	const report = u2.report;
	result.check(failed(run) === true, "the refused continuation was reported as a run that finished");
	result.check(run.aborted === false, "the refusal was reported as a cancellation, and nothing cancelled this run");
	result.check(u2.reports.length === 1, `${u2.reports.length} call report(s) for one call`);
	result.check(report?.stage === "prepare-refused", `the call stopped at ${report?.stage} rather than a preparation that refused`);
	result.check(report?.startCalled === true && report?.startResolved === true, `start called ${report?.startCalled}, resolved ${report?.startResolved}`);
	const ended = report?.ended;
	result.check(ended?.kind === "prepare", `the call ended ${ended?.kind} rather than at its preparation`);
	const refused = ended?.kind === "prepare" ? ended.refused : undefined;
	result.check(refused?.reason === "restore", `the preparation refused with ${refused?.reason} rather than at its restore`);
	const restore = refused?.restore;
	result.check(restore?.reason === "postcondition", `the restore refused with ${restore?.reason} rather than on its postcondition`);
	result.check(restore?.cancelled === undefined, `the restore reported the operation as cancelled (${restore?.cancelled})`);
	// The published shape of this refusal, and not a turn record: a `postcondition` refusal retains no turn, because
	// `turn` is attached to the two refusals a turn is the evidence for — one that was never acknowledged, and one the
	// command itself failed. Asserting an acknowledged turn here would be asserting a field this reason never carries.
	result.check(restore?.turn === undefined, `the postcondition refusal carries a turn record (${JSON.stringify(restore?.turn?.outcome)}), and this reason does not retain one`);
	result.check(
		restore?.failure === undefined && restore?.error === undefined,
		`the postcondition refusal carries a transport failure or a thrown value (${JSON.stringify(restore?.failure?.kind)}, ${JSON.stringify(String(restore?.error))}), so the sequence threw rather than answering`,
	);
	result.say(
		"what this is: the production composition classified the refusal as `postcondition`, which is a reason it can only reach after its own turn and operation gates have passed — so the control command was acknowledged and carried no extension error as a control-flow implication of that classification, and not as native evidence this harness read. The shape deliberately publishes no successful turn record, so the acknowledgement itself is not exposed and is not observed here",
	);
	result.say(
		"what is measured: the session did not read back as standing at the recorded entry, which is the whole of what `postcondition` says. That reason covers both readbacks the restore makes — the session identity it expected to be in and the leaf it expected to stand at — so this result does not say which of the two disagreed, and nothing here asked the child. What it does say is that the refusal is the gate's rather than a failed operation's: it carries no cancellation, no transport failure and no thrown value, each checked above. That the leaf then stands at the recorded entry's parent is source inference from 0.85.1 and is named under NOT RUN below",
	);
	checkCleanExit(result, "U2 exit", restore?.exit);
	result.check(restore?.unverified === undefined, "the one shutdown the restore attempted reported nothing about how the child ended");
	result.check(report?.disposition?.safe === true && report?.disposition?.concerns?.length === 0, `disposition ${JSON.stringify(report?.disposition)}`);
	result.check(report?.storage?.attempted === true && report?.storage?.disposed === true, `storage attempted ${report?.storage?.attempted}, disposed ${report?.storage?.disposed}`);
	result.check(report?.storage?.callDir !== undefined && !fs.existsSync(report.storage.callDir), `the call directory ${report?.storage?.callDir} is still on disk`);
	result.check(run.stopReason === "restore", `the run's stopReason is ${run.stopReason}`);
	result.check(run.errorMessage === PROD_CHECKPOINT_REFUSAL, `the run's message is ${JSON.stringify(run.errorMessage)} rather than the fixed sentence for a restore postcondition`);
	result.check(
		run.session === undefined && run.sessionId === undefined && run.checkpoint === undefined,
		`the refused run published a session: ${JSON.stringify([run.session, run.sessionId, run.checkpoint])}`,
	);
	result.check(u2.requests.length === 0, `${u2.requests.length} provider request(s) reached the fixture for a continuation that was refused`);
	result.check(
		JSON.stringify(u2.events) === JSON.stringify([{ type: "turn_result", ok: false, message: PROD_CHECKPOINT_REFUSAL }]),
		`the events a monitor saw are ${JSON.stringify(u2.events)}, and a refused preparation names no session to initialise`,
	);
	result.check(
		hashFile(refA.sessionFile) === hashBefore,
		`the source session file changed during the refused continuation: ${JSON.stringify(readSessionEntries(refA.sessionFile).slice(before.length).map(entryLabel))}`,
	);
	result.check(sessionFiles(prod).length === 1, `the session directory holds ${JSON.stringify(sessionFiles(prod))} rather than the one transcript`);
	for (const pid of u2.start.pids) result.check(!pidAlive(pid), `the refused call's child pid ${pid} is still alive`);
	checkComposedStart(result, prod, u2);
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
	result.say(
		"no workaround: nothing here navigates on the child's behalf, retries the restore, relaxes the gate or rewrites the recorded checkpoint — the refusal is reported exactly as the production composition reported it, and a host that records a user message as a checkpoint has a record it cannot continue",
	);
	sayProductionNotRun(result);
}

/** The question the child asks in the answered case, the answer it gets, the steer pushed while it waits, and the id. */
const PROD_Q_PROMPT = "PROD-Q-MARKER which branch should I take?";
const PROD_Q_ANSWER = "PROD-Q-ANSWER";
const PROD_Q_STEER = "PROD-Q-STEER pushed while the question was still being held.";
const PROD_Q_CALL_ID = "call_prod_q1";

/**
 * Production: one question of the child's own, answered through the production question routing, with one steer
 * pushed into the call's own queue while that question was still open.
 *
 * What makes this the routing's case rather than the protocol's. Nothing here writes an `extension_ui_response`, waits
 * for an `extension_ui_request` or knows that a dialog is what carries a question: the call is given an `onQuestion`,
 * which is the whole of what turns questions on in `pi-prepare.ts`, and every step between the child's tool call and
 * the answer reaching it — the launch input's question tool, the transport's ui callback, the router's arbitration,
 * the watch that decides whether an outcome was fatal — is the shipped one. What this harness supplies is the answer
 * and the moment it arrives, which is a host's own part.
 *
 * And what the steer proves beside it: that the queue a real host hands a backend reaches a live turn. It is pushed
 * from inside the question callback, so it is pushed while the child is blocked on its dialog and before the answer
 * exists — and the second provider request is then where both land, the tool result first and the steer as the
 * ordinary user message after it, which is exactly the ordering row 5 measured on a generated child.
 */
async function caseProductionQuestionAnswered(root, server, result) {
	const prod = setupProductionCase(root, server, result.name);
	server.install([toolCallStep("prod-q-ask", "ask_orchestrator", { question: PROD_Q_PROMPT }, PROD_Q_CALL_ID), textStep("prod-q-final", PROD_Q_ANSWER)]);
	result.say(`production composition: createPiBackend over host agent directory ${prod.hostAgent}`);
	result.say(
		"what this measures: the production composition's own question path end to end — the composed question tool, the transport's dialog, the router's one decision per dialog and the watch over it — with this harness supplying only the answer and the moment it arrives",
	);

	result.phase("Q: the child asks, the harness steers and then answers, and the turn finishes");
	const q = await productionCall(prod, result, {
		label: "Q",
		prompt: "PROD-Q ask the orchestrator which branch to take.",
		question: { expect: PROD_Q_PROMPT, answer: PROD_Q_ANSWER },
		steers: [PROD_Q_STEER],
	});
	// The callback's own evidence first, because every assertion below it is only worth something if the question this
	// harness answered is the one the child asked: exactly one, with the prompt the fixture put in the tool call.
	result.check(q.questions.prompts.length === 1, `the question callback was called ${q.questions.prompts.length} time(s) for one scripted question`);
	result.check(q.questions.admitted === 1, `${q.questions.admitted} of this call's steers were admitted into the queue while the question was held`);
	result.check(q.questions.released === 0, `${q.questions.released} dialog(s) of an answered call were released by their own signal aborting, so the hold path ran where the answer path should have`);

	const evidence = checkProductionCall(result, prod, q, {
		text: PROD_Q_ANSWER,
		tools: [{ name: "ask_orchestrator", id: PROD_Q_CALL_ID, brief: "", input: { question: PROD_Q_PROMPT }, result: PROD_Q_ANSWER, isError: false }],
		requests: 2,
		questionTool: true,
	});

	result.phase("the steer account, as the queue itself reports it");
	const task = q.report?.ended?.kind === "task" ? q.report.ended.result : undefined;
	const steers = task?.ok === true ? task.steers : undefined;
	result.say(`steer report: ${JSON.stringify(steers)}`);
	result.check(
		steers?.pushed === 1 && steers?.sent === 1 && steers?.rejected === 0 && steers?.refused === 0 && steers?.failed === 0 && steers?.dropped === 0 && steers?.open === false && steers?.lastFailure === undefined,
		`the steer this case pushed is not accounted for as one the child admitted: ${JSON.stringify(steers)}`,
	);
	result.check(steers?.pushed === q.questions.admitted, `the queue took in ${steers?.pushed} steer(s) and this harness pushed ${q.questions.admitted}`);

	result.phase("the second request: the answer as a tool result, and the steer after it");
	const second = q.requests[1];
	result.say(`request 2 roles: ${JSON.stringify(second?.roles)}`);
	result.check(
		JSON.stringify(second?.roles) === JSON.stringify(["system", "user", "assistant", "tool", "user"]),
		`request 2's role sequence is ${JSON.stringify(second?.roles)} rather than the prompt, the tool-calling answer, its result and the steer`,
	);
	const toolMessage = second?.messages[3];
	result.check(toolMessage?.toolCallId === PROD_Q_CALL_ID, `the tool result is correlated to ${JSON.stringify(toolMessage?.toolCallId)} rather than the id the fixture issued`);
	result.check(toolMessage?.text === PROD_Q_ANSWER, `the tool result carries ${JSON.stringify(toolMessage?.text)} rather than exactly the answer this harness sent`);
	const steerMessage = second?.messages[4];
	result.check(steerMessage?.text === PROD_Q_STEER, `the last message of request 2 is ${JSON.stringify(steerMessage?.text)} rather than exactly the steer this case pushed`);
	result.check(!conversationTexts(second ?? { messages: [] }).some((text) => text.includes(PROD_QUESTION_HELD)), "the harness's own hold sentence reached the provider, so the held path ran for a question it was told to answer");

	result.phase("the transcript and the layout afterwards");
	result.check(sessionFiles(prod).length === 1, `the session directory holds ${JSON.stringify(sessionFiles(prod))} rather than one transcript`);
	result.check(callDirs(prod).length === 0, `the calls directory still holds ${JSON.stringify(callDirs(prod))}`);
	for (const line of describeEntries(evidence.entries)) result.say(`  ${line}`);
	result.check(server.unscripted.length === 0, `the fixture saw ${server.unscripted.length} unscripted request(s)`);
	sayProductionNotRun(result);
}

/** The question the cancelled case asks, and the id its tool call carries. There is no answer: it is held. */
const PROD_QC_PROMPT = "PROD-QC-MARKER a question nobody is going to answer?";
const PROD_QC_CALL_ID = "call_prod_qc1";

/**
 * Production: the same question, held until the run's own cancellation reached it, which is the only way a real host
 * ends a waiting run from outside.
 *
 * The order is the whole of the case, and it is event-driven where it matters: the callback signals a latch the moment
 * the child's question arrives, the call's own `AbortController` is aborted on that latch and on nothing else, and the
 * same call is then awaited to the end so the composition performs its own shutdown and cleanup before anything is
 * read. Nothing here polls or sleeps to find its moment — and it is still bounded, by `awaitTrigger`'s own rejecting
 * timer, which cancels and awaits the call rather than letting a question that never arrives hang the case.
 *
 * What is then asserted is a cancellation that is deterministically a cancellation. A run cancelled while a dialog was
 * open has two ends racing — the turn the transport abandons, and the fatal question the router produces — and the
 * task's own precedence names the signal whichever of them arrives first: so the reason is `aborted` and the run says
 * `pi-outcome.ts`'s fixed sentence for one, either way.
 *
 * What the race does not decide is whether the dialog's own outcome is retained beside that reason: the question branch
 * carries the outcome it raced on, and the turn branch reaches the gate that reads the same recorded one, so either
 * path keeps it and this case requires it — the exact end, and an admission saying nothing was written. What says the
 * cancellation actually reached the question is a separate observation, this harness's own callback: the held dialog's
 * signal aborting, counted as `released`, which neither branch can hide.
 *
 * The evidence stays evidence, and each piece of it to its own surface. The question is the `ask_orchestrator` call's
 * own argument, so it is held off the diagnostic surfaces and the terminal event alone — the bounded copy a monitor
 * sees in the `tool_call` event is the mapper doing its job, and the activity line and the cancelled tool's own result
 * are the looser surface that may carry it. This harness's own hold sentence is nobody's argument and reaches no
 * surface at all. The marker lists hold both to exactly that.
 */
async function caseProductionQuestionCancelled(root, server, result) {
	const prod = setupProductionCase(root, server, result.name);
	// One step only: the turn that follows an answer is not scripted, so a second provider request would be recorded as
	// an unscripted one and fail the case rather than being answered.
	server.install([toolCallStep("prod-qc-ask", "ask_orchestrator", { question: PROD_QC_PROMPT }, PROD_QC_CALL_ID)]);
	result.say(`production composition: createPiBackend over host agent directory ${prod.hostAgent}`);
	result.say(
		"what this measures: a run cancelled while its child was blocked on a question of its own, and that the production composition reports it as a cancellation — not as a question that failed — with the dialog's own recorded outcome kept beside that reason whichever end of the task's race arrived first",
	);

	result.phase("QC: the question opens, the run is cancelled, and the call is awaited to the end");
	const opened = latch("the production child's own question, opened and held");
	const qc = await productionCall(prod, result, {
		label: "QC",
		prompt: "PROD-QC ask a question I am going to cancel.",
		question: { expect: PROD_QC_PROMPT, opened: opened.open },
		trigger: opened,
	});
	result.check(qc.questions.prompts.length === 1, `the question callback was called ${qc.questions.prompts.length} time(s) for one scripted question`);
	// The race-independent half: whichever end the task reported, the dialog this harness was holding was released by
	// its own signal aborting, which is the router ending it and is what a cancellation reaching a question looks like
	// from here. Exactly one, because there was one dialog and `holdQuestion` releases each one once.
	result.check(qc.questions.released === 1, `${qc.questions.released} held dialog(s) were released by their own signal aborting, so the cancellation did not reach the question this case held`);

	checkProductionAbort(result, prod, qc, {
		tool: { name: "ask_orchestrator", id: PROD_QC_CALL_ID, brief: "", input: { question: PROD_QC_PROMPT } },
		// The dialog was cancelled rather than answered, so the tool it was opened by failed: that is what a question
		// with no answer leaves, and the text it failed with is the child's own and is read rather than fixed here.
		toolEnd: { isError: true },
		requests: 1,
		// One dialog, cancelled exactly once, by one of the two mechanisms that can cancel one — the transport's own
		// shutdown, which counts `uiCancelledByTransport`, or a frame that could not be written, which counts
		// `droppedFrames`. Which of the two it was is a finding to read and not something to pin; that it happened once
		// and that nothing else started counting is the assertion.
		counters: { uiCancelledByTransport: [0, 1], droppedFrames: [0, 1] },
		countersTotal: 1,
		question: { end: "aborted" },
		questionTool: true,
		// The case root and the question itself on the diagnostic surface alone: no sentence of a cancellation names a
		// path of this call's, and the question text here is the `ask_orchestrator` call's own argument, which the
		// looser surface is allowed to carry a bounded copy of exactly as it may carry a shell command. The harness's
		// own hold sentence is the one addition to both surfaces, because it is this harness's text and the tool's
		// argument it is not.
		markers: [prod.dirs.caseRoot, PROD_QC_PROMPT],
		softMarkers: [PROD_QUESTION_HELD],
	});

	result.phase("the transcript and the layout afterwards");
	result.check(sessionFiles(prod).length === 1, `the session directory holds ${JSON.stringify(sessionFiles(prod))} rather than the one transcript the cancelled turn opened`);
	const ref = qc.run.session;
	if (ref !== undefined && fs.existsSync(ref.sessionFile)) for (const line of describeEntries(readSessionEntries(ref.sessionFile))) result.say(`  ${line}`);
	else result.say("  (the cancelled run published no session file to read back)");
	result.say(
		"no workaround: nothing here answers the question after the cancellation, retries it, stops the child itself or terminates anything — the cancellation goes in through the run's own signal and everything after it is the composition's own",
	);
	sayProductionNotRun(result);
}

/** The id the detached case's shell tool call carries, and the owned script its whole command is the path of. */
const PROD_D_CALL_ID = "call_prod_d1";
const PROD_D_SCRIPT_NAME = "spawn.sh";
/** Exactly owner read, write and execute: the script is this harness's own and nothing else has business reaching it. */
const PROD_D_SCRIPT_MODE = 0o700;
/** How long the owned shell and its detached descendant live, which is far longer than the case needs either of them. */
const PROD_D_SLEEP_SECONDS = 300;
/**
 * The fixed sentence a proof that did not hold refuses the trigger with, and the whole of what travels with it is the
 * closed set of labels `proveDetachedDescendant` composes — no path, no environment and no /proc line of its own.
 */
const PROD_D_PROOF_REFUSAL = "refusing to cancel: this case could not prove a live owned shell with a detached setsid descendant";

/**
 * The script the shell tool is handed the absolute path of, and the only thing that tool's `command` argument is. It
 * exists rather than an inline command for one reason: a `command` that was a whole multi-line program would make the
 * thing the progress mapper bounds into an event the program itself, and what this case measures is a cancellation
 * rather than how a long argument is cut. One path in, one path bounded, and the program on disk where a person can
 * read it.
 *
 * What it does, in the order it does it: writes its own pid, starts `/usr/bin/setsid` — named literally, never looked
 * up on `PATH` — on a shell that writes *its* own pid and then execs a long sleep, and then execs a long sleep itself.
 * Both `exec`s matter: the pid each file names stays the pid of the process that is still there when the cancellation
 * lands, so neither reading is of a shell that has since been replaced by something with another pid.
 *
 * Every path baked into it is absolute and inside the case's own root, which is what `assertInsideRoot` has already
 * held them to. The background job is not a process-group leader — Pi spawns its shell detached, so the shell leads the
 * group and its child does not — so `setsid` sets a new session in place rather than forking, which is what keeps the
 * detached pid a child of the owned shell and makes the parentage below provable at all.
 */
const detachedScriptSource = (shellPidFile, detachedPidFile) =>
	[
		"#!/bin/sh",
		"# Generated by test/spikes/pi-session-lifecycle.mjs for prod-detached-cancelled. Rewritten on every run.",
		`echo $$ > "${shellPidFile}"`,
		`${PROD_SETSID} /bin/sh -c 'echo $$ > "${detachedPidFile}"; exec sleep ${PROD_D_SLEEP_SECONDS}' &`,
		`exec sleep ${PROD_D_SLEEP_SECONDS}`,
		"",
	].join("\n");

/**
 * Everything the detached case has to know before it cancels anything, read once and answered whole. It proves, off
 * one reading per pid: that the two pid files name two different processes; that both are alive and that neither
 * `/proc` run state is one of the finished ones, so a zombie cannot pass as a live descendant; that both environments
 * name this run's own root, which is how a pid read out of a file is told from a recycled one; that the detached pid
 * is a child of the owned shell; that it is its own process group and session leader, which is what `setsid` did; and
 * that its session is not the shell's, which is the boundary Pi's own abort stops at.
 *
 * `failures` is a closed set of fixed sentences of this file's own: a refusal composed from them names which proof did
 * not hold and carries no path, no environment and no /proc field with it.
 */
function proveDetachedDescendant(found, root) {
	const relations = { shell: processRelations(found.shell), detached: processRelations(found.detached) };
	const proof = {
		pids: { ...found },
		distinct: found.shell !== found.detached,
		alive: { shell: pidAlive(found.shell), detached: pidAlive(found.detached) },
		relations,
		environs: { shell: environMentions(found.shell, root), detached: environMentions(found.detached, root) },
		failures: [],
	};
	const shell = relations.shell;
	const detached = relations.detached;
	if (!proof.distinct) proof.failures.push("the two pid files name one process rather than two");
	if (!proof.alive.shell || !proof.alive.detached) proof.failures.push("one of the two pids is not alive");
	if (!proof.environs.shell || !proof.environs.detached) proof.failures.push("one of the two pids' environments does not name this run's own root");
	if (shell === undefined || detached === undefined) proof.failures.push("one of the two pids has no readable /proc entry");
	else {
		if (FINISHED_STATES.has(shell.state) || FINISHED_STATES.has(detached.state)) proof.failures.push("one of the two pids is already a finished process");
		if (detached.ppid !== found.shell) proof.failures.push("the detached pid is not a child of the owned shell");
		if (detached.pgrp !== found.detached || detached.session !== found.detached) proof.failures.push("the detached pid is not its own process group and session leader");
		if (detached.session === shell.session) proof.failures.push("the detached pid is still in the owned shell's own session");
	}
	proof.ok = proof.failures.length === 0;
	return proof;
}

/**
 * Production: a cancellation that lands on a live shell tool which has already put a descendant outside the process
 * group Pi kills, and what the production cleanup does about it.
 *
 * Why it is the interesting cancellation. Row 6 measured, on a generated child, that Pi's own abort is a process-group
 * SIGKILL and stops at the group boundary: a descendant that called `setsid` outlives it. The production transport
 * answers that with an owned cleanup that reads the process table *before* the abort goes out — while the live child
 * still owns its descendants — and then signals each of them by pid. So this case is the one that says whether that
 * actually reaches a `setsid` descendant of a tool's shell, and the evidence is production's own cleanup report: the
 * detached pid has to be in `terminated`, the leftovers and skipped lists have to be empty, and both pids have to be
 * dead when this harness looks.
 *
 * **The barrier, which is the order this case is correct by.** Nothing is registered, cancelled or asserted until the
 * whole of `proveDetachedDescendant` has held: both pid files parse whole, the two pids differ, both are alive and
 * neither is a finished `/proc` state, both environments name this run's own root, the detached pid is a child of the
 * owned shell, it is its own process group and session leader, and its session is not the shell's. Readiness is one
 * `fs.watch` and the proof is one reading per pid — no poll and no sleep — and the bound on the whole wait is
 * `awaitTrigger`'s own rejecting timer. A proof that did not hold rejects the trigger with this file's own fixed text,
 * and `productionCall` still cancels the call and still awaits it to the end before the case fails on it.
 *
 * Registration comes *after* that proof, deliberately: a pid this harness could not prove is one it will not put in a
 * registry that signals things. The proof is captured, printed and asserted again after the cleanup, so a green result
 * is one where the thing production had to reach was shown to have been there.
 *
 * What the pid files are and are not. They are this harness's own oracle for those proofs and, through the sweep in
 * `cleanup`, its own last-resort net for the end of the run; they are never an input to production's cleanup, which
 * reads the process table for itself. Nothing here signals either pid: a survivor fails the case, and the registry
 * sweep that would eventually reach it cannot turn a native cleanup that failed into a pass. "Gone" is
 * `processEnded`'s question rather than `pidAlive`'s, so a zombie and a recycled pid both read as over.
 *
 * It is a Linux qualification and says so: `/usr/bin/setsid` is named literally and `/proc` is what the parentage, the
 * group, the session and the run state are read from, so a platform without them leaves the case unproven rather than
 * skipped or passed.
 */
async function caseProductionDetachedCancelled(root, server, result) {
	const prod = setupProductionCase(root, server, result.name);
	result.say(`production composition: createPiBackend over host agent directory ${prod.hostAgent}`);
	let executable = false;
	try {
		fs.accessSync(PROD_SETSID, fs.constants.X_OK);
		executable = true;
	} catch {
		executable = false;
	}
	if (process.platform !== "linux" || !executable) {
		result.unproven = `this case needs linux and an executable ${PROD_SETSID}, and this host is ${process.platform} with ${executable ? "one" : "none"}: the detached-descendant half of the production cancellation cannot be measured here`;
		result.say(result.unproven);
		result.say("not skipped and not passed: a platform that cannot produce a detached descendant cannot say anything about a cleanup that reaches one");
		return;
	}

	const pidsDir = assertInsideRoot(root, "production detached pids directory", path.join(prod.dirs.caseRoot, "pids"));
	fs.mkdirSync(pidsDir, { recursive: true });
	const shellPidFile = assertInsideRoot(root, "production detached shell pid file", path.join(pidsDir, "shell"));
	const detachedPidFile = assertInsideRoot(root, "production detached descendant pid file", path.join(pidsDir, "detached"));
	const scriptPath = assertInsideRoot(root, "production detached spawn script", path.join(pidsDir, PROD_D_SCRIPT_NAME));
	write(scriptPath, detachedScriptSource(shellPidFile, detachedPidFile));
	fs.chmodSync(scriptPath, PROD_D_SCRIPT_MODE);
	const mode = fs.statSync(scriptPath).mode & 0o777;
	result.check(mode === PROD_D_SCRIPT_MODE, `the owned spawn script is mode 0${mode.toString(8)} rather than exactly 0${PROD_D_SCRIPT_MODE.toString(8)}`);
	result.say(`owned spawn script: ${scriptPath} (mode 0${mode.toString(8)})`);
	for (const line of detachedScriptSource(shellPidFile, detachedPidFile).split("\n").filter(Boolean)) result.say(`  ${line}`);
	// The whole of the tool's own argument: one absolute path inside this case's root and nothing else, so what the
	// progress mapper bounds into an event is a path rather than a program.
	const command = scriptPath;
	server.install([toolCallStep("prod-d-shell", "bash", { command }, PROD_D_CALL_ID)]);
	result.say(
		"what this measures: production's own owned cleanup against a descendant that left the process group Pi's abort kills — the process table it reads before the abort, the per-pid signals after it, and the report it hands back",
	);

	result.phase("D: the owned script runs, its detached descendant is proved, and the run is then cancelled");
	const probe = { what: "an owned shell and a detached setsid descendant of it, both proved", proof: undefined, registered: undefined };
	const watch = watchPidFiles(probe.what, { shell: shellPidFile, detached: detachedPidFile });
	// The barrier: readiness, then the whole proof, then registration, and only then the cancellation. A proof that did
	// not hold rejects this trigger with fixed text, and `productionCall` still cancels the call and awaits it to the
	// end before the case fails on it — so a case that could not prove its descendant leaves nothing running either.
	// Registration is last on purpose: a pid this harness could not prove is not one it will put in a signalling
	// registry, and the pid-file sweep in `cleanup` is the net that still reaches such a process at the end of the run.
	const trigger = {
		what: probe.what,
		ready: watch.ready.then((found) => {
			const proven = proveDetachedDescendant(found, root);
			probe.proof = proven;
			if (!proven.ok) throw new Error(`${PROD_D_PROOF_REFUSAL}: ${proven.failures.join("; ")}`);
			for (const pid of [found.shell, found.detached]) registerPid(pid);
			probe.registered = { shell: spawnedPids.has(found.shell), detached: spawnedPids.has(found.detached) };
		}),
		close: () => watch.close(),
	};
	let d;
	try {
		d = await productionCall(prod, result, {
			label: "D",
			prompt: "PROD-D run a script that outlives its own shell.",
			trigger,
		});
	} catch (error) {
		// Readiness that never came and a proof that did not hold are different failures, and only these two say which.
		// The call has already been cancelled and awaited by then, so this prints and rethrows.
		result.say(`the pid files the watcher had read when this failed: ${JSON.stringify(watch.found)}`);
		result.say(`the proof this case had reached when it failed: ${JSON.stringify(probe.proof)}`);
		throw error;
	}

	result.phase("the proof taken before the cancellation, asserted again now");
	const proof = probe.proof;
	result.say(`recorded pids: pi child ${JSON.stringify(d.start.pids)}, shell ${proof?.pids?.shell}, detached ${proof?.pids?.detached}`);
	result.say(`alive when the barrier read them: ${JSON.stringify(proof?.alive)}`);
	result.say(`environments naming this run's own root: ${JSON.stringify(proof?.environs)}`);
	result.say(`/proc relations: ${JSON.stringify(proof?.relations)}`);
	result.say(`registered after the proof: ${JSON.stringify(probe.registered)}`);
	result.check(proof !== undefined, "the barrier never ran, so this case proved nothing about a detached descendant");
	result.check(proof?.ok === true, `the barrier's own proof did not hold: ${JSON.stringify(proof?.failures)}`);
	const shell = proof?.pids?.shell;
	const detached = proof?.pids?.detached;
	// Each clause of that proof restated here rather than left to `ok`, so a failure names the one that did not hold.
	result.check(proof?.distinct === true, `the two pid files name ${shell} and ${detached}, which are not two distinct processes`);
	result.check(proof?.alive?.shell === true && proof?.alive?.detached === true, `one of the recorded pids was not alive when the barrier read it: ${JSON.stringify(proof?.alive)}`);
	result.check(proof?.environs?.shell === true && proof?.environs?.detached === true, `the recorded pids' environments do not both name this run's own root: ${JSON.stringify(proof?.environs)}`);
	const shellRelation = proof?.relations?.shell;
	const detachedRelation = proof?.relations?.detached;
	result.check(shellRelation !== undefined && detachedRelation !== undefined, "one of the recorded pids had no readable /proc entry at the barrier, so the detachment was never proved");
	result.check(
		shellRelation !== undefined && detachedRelation !== undefined && !FINISHED_STATES.has(shellRelation.state) && !FINISHED_STATES.has(detachedRelation.state),
		`one of the recorded pids was a finished process at the barrier: states ${JSON.stringify([shellRelation?.state, detachedRelation?.state])}`,
	);
	result.check(
		detachedRelation !== undefined && detachedRelation.ppid === shell,
		`the detached pid's parent is ${detachedRelation?.ppid} rather than the owned shell ${shell}, so what was proved detached is not a descendant of this case's own script`,
	);
	result.check(
		detachedRelation !== undefined && detachedRelation.session === detached && detachedRelation.pgrp === detached,
		`the detached pid's session and process group are ${JSON.stringify([detachedRelation?.session, detachedRelation?.pgrp])} rather than its own pid ${detached}, so it is not a session leader and setsid did not take`,
	);
	result.check(
		shellRelation !== undefined && detachedRelation !== undefined && detachedRelation.session !== shellRelation.session,
		`the detached pid is still in its parent's session ${shellRelation?.session}, so it never left the group Pi's own abort kills`,
	);
	result.check(probe.registered?.shell === true && probe.registered?.detached === true, `the proven pids were not both put in this harness's own registry: ${JSON.stringify(probe.registered)}`);

	checkProductionAbort(result, prod, d, {
		// The command is the script's own path, so the brief is that path cut to the mapper's own activity window — the
		// cap is imported rather than restated, and `codePointCut` is this file's own faithful reproduction of that cut
		// over the imported cap rather than the mapper's own function.
		tool: { name: "bash", id: PROD_D_CALL_ID, brief: codePointCut(scriptPath, PI_ACTIVITY_CHARS), input: { command } },
		// The shell was killed under the tool, so the call it was serving failed: that is what an interrupted command
		// leaves, and whatever text the child put in it is the child's own and is read rather than fixed here.
		toolEnd: { isError: true },
		requests: 1,
		questionTool: false,
		// The one thing this case adds to the strict cleanup ground: the detached pid has to be in the list production's
		// own cleanup says it signalled and then verified gone.
		terminated: detached === undefined ? [] : [detached],
		// Diagnostic surface only, every one of them: no sentence of a cancellation names a path of this call's. They
		// are deliberately not soft markers — the activity line legitimately carries the script path, which is what the
		// mapper is for, and marker-checking it there would be asserting that the mapper does not do its job.
		markers: [prod.dirs.caseRoot, pidsDir, scriptPath, shellPidFile, detachedPidFile],
	});

	result.phase("both processes, asserted gone rather than terminated here");
	const over = { shell: processEnded(shell), detached: processEnded(detached) };
	result.say(`after the production cleanup reported: ${JSON.stringify(over)}`);
	result.check(over.shell.gone, `the owned shell ${shell} is not over after the production cleanup (${over.shell.why})`);
	result.check(over.detached.gone, `the detached descendant ${detached} is not over after the production cleanup (${over.detached.why}), so the owned cleanup did not reach past the process-group boundary`);
	// Only a pid that is really over is forgotten, and off the readings just asserted rather than a second deadness read
	// of its own: a fresh read could answer differently from the one this case passed or failed on, and nothing here
	// waits, polls or retries for a kinder answer. One that survived stays in the registry so the end of the run still
	// reaches it, and the failure above is what reports it rather than this file quietly tidying up over it.
	for (const [which, pid] of Object.entries({ shell, detached })) if (pid !== undefined && over[which].gone) spawnedPids.delete(pid);
	result.say(
		"no workaround: nothing here sent a signal, swept a pid file into production's cleanup or waited for a process to go — the cancellation went in through the run's own signal, and what is gone above is production's own cleanup's result",
	);

	result.phase("the transcript and the layout afterwards");
	result.check(sessionFiles(prod).length === 1, `the session directory holds ${JSON.stringify(sessionFiles(prod))} rather than the one transcript the cancelled turn opened`);
	const ref = d.run.session;
	if (ref !== undefined && fs.existsSync(ref.sessionFile)) for (const line of describeEntries(readSessionEntries(ref.sessionFile))) result.say(`  ${line}`);
	else result.say("  (the cancelled run published no session file to read back)");
	sayProductionNotRun(result);
}

const CASES = [
	{ name: "row8-model-thinking", row: 8, title: "strict model and thinking checks", run: caseModelThinking },
	{ name: "row1-durable-checkpoint", row: 1, title: "a completed run's checkpoint survives the child process", run: caseDurableCheckpoint },
	{ name: "row2-older-checkpoint", row: 2, title: "restoring an older checkpoint after a later turn (host /tree simulation)", run: caseOlderCheckpoint },
	{ name: "row3-fork-at", row: 3, title: "fork at an exact checkpoint, two transcripts that stay apart", run: caseForkAt },
	{ name: "row4-failures", row: 4, title: "failed continuation, failed new run, failed fork after creation, invalid targets", run: caseFailures },
	{
		name: "row4-cancelled-operations",
		row: 4,
		title: "a cancelled navigation and a cancelled fork, and the guard that refuses to prompt after them",
		run: caseCancelledOperations,
	},
	{ name: "row2-compaction-checkpoint", row: 2, title: "a compaction at the checkpoint, and the hazard of recording the assistant message instead", run: caseCompactionCheckpoint },
	{ name: "row5-questions", row: 5, title: "a blocking question, duplicate answers, two in a row, and a steer that waits", run: caseQuestions },
	{ name: "row6-cancellation", row: 6, title: "clear_queue before abort, and a descendant that leaves the killed process group", run: caseCancellation },
	{ name: "row7-retry-compaction", row: 7, title: "retry, threshold and overflow compaction, and queued work before agent_settled", run: caseRetryCompaction },
	{ name: "prod-trusted-checkpoints", row: "prod", title: "the production backend: a new session, two restores and a fork at a trusted checkpoint", run: caseProductionTrustedCheckpoints },
	{ name: "prod-user-target-refused", row: "prod", title: "the production backend: a recorded checkpoint that is a user message, refused by the exact-leaf gate", run: caseProductionUserTarget },
	{ name: "prod-question-answered", row: "prod", title: "the production backend: a question of the child's own, answered, with a steer pushed while it waited", run: caseProductionQuestionAnswered },
	{ name: "prod-question-cancelled", row: "prod", title: "the production backend: a question held until the run's own cancellation reached it", run: caseProductionQuestionCancelled },
	{
		name: "prod-detached-cancelled",
		row: "prod",
		title: "the production backend: a cancellation onto a live shell tool with a detached setsid descendant (linux)",
		run: caseProductionDetachedCancelled,
	},
];

// The order inside a group is the order the cases are meant to be read in: for `production`, the two quiet
// qualification cases first, then the question answered, then the two cancellations — the question held, and the one
// that lands on a shell tool with a descendant outside the group Pi kills.
const GROUPS = {
	"stage-a": ["row8-model-thinking", "row1-durable-checkpoint", "row2-older-checkpoint", "row3-fork-at", "row4-failures", "row4-cancelled-operations"],
	"stage-b": ["row2-compaction-checkpoint", "row5-questions", "row6-cancellation", "row7-retry-compaction"],
	production: ["prod-trusted-checkpoints", "prod-user-target-refused", "prod-question-answered", "prod-question-cancelled", "prod-detached-cancelled"],
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
 * A descendant whose pid file a fixture command or an owned script has written but which nothing has registered yet:
 * the file exists before the next poll reads it, and an interrupt in that window consults only the in-memory
 * registry. Sweeping the files closes it, and the environment check is what makes signalling the pid safe.
 *
 * It is the net for a second window too, and that one is deliberate: `prod-detached-cancelled` registers a pid only
 * once it has proved what that pid is, so a proof that did not hold leaves a live process the registry never took.
 * This is what still reaches it at the end of the run — and it stays cleanup rather than evidence, because no case
 * asserts on it and nothing here feeds a pid file into production's own cleanup.
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
