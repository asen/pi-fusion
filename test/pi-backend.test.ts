import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { CONTRACTS_DIR } from "../extensions/backends/claude.ts";
import {
	AGENT_DIR_UNREADABLE,
	CALL_NOT_COMPOSED,
	CONTRACT_UNREADABLE,
	createPiBackend,
	PI_CONTRACTS_DIR,
	type PiBackendDeps,
	type PiCallReport,
	STORAGE_RETAINED,
} from "../extensions/backends/pi-backend.ts";
import type { PiRole } from "../extensions/backends/pi-binding.ts";
import { CONTROL_EXTENSION_PATH, FORK_COMMAND, NAVIGATE_COMMAND } from "../extensions/backends/pi-control-extension.mjs";
import { CLEANUP_ATTENTION, CLEANUP_UNCERTAIN, DISPOSE_FAILED, DISPOSE_WARNING, type PiRun, type PiSession, RUN_CANCELLED, RUN_UNVERIFIED, STORAGE_LEFT } from "../extensions/backends/pi-outcome.ts";
import { type PreparedCall, prepareCallStorage, type StorageRequest } from "../extensions/backends/pi-storage.ts";
import { PiSteerQueue, type PiTaskObserver, type PiTaskRequest, type PiTaskResult } from "../extensions/backends/pi-task.ts";
import { type PiChild, type PiChildOptions, type PiEvent, type PiExit, piFailure, type PiResponse, PiTransportError, type PiTurn, type PiUiResponse } from "../extensions/backends/pi-transport.ts";
import { type ChildEvent, failed, hostBackend, type RunRequest, type SessionIntent } from "../extensions/backends/types.ts";
import { recordDecision } from "../extensions/fusion.ts";

/*
 * What this host does when it composes one whole Pi call: the contract, the agent directory, the storage, the
 * preparation, the task and the mapping, driven against scripted in-memory doubles of this file's own. Nothing here
 * starts a Pi child, speaks the native protocol, builds a session, reaches a provider, runs a model or sends a paid
 * request: every answer a child gives below is a literal written here, and the two host seams a real call would read —
 * the SDK's own agent-directory accessor and this install's contract files — are injected in every run, so neither is
 * ever reached. Nothing in production constructs this backend either, so none of it is reachable by a user.
 *
 * The one real thing is the local filesystem: the ordinary cases prepare their call storage the way production does,
 * under a root each case owns and removes, so a directory that is disposed of or left behind is one that was really
 * made. That is a test writing into a directory it owns, and it is not a child, a process or a run.
 *
 * What none of it measures: how a real Pi child opens a session, streams a record, moves a leaf, counts its usage,
 * cleans up or ends. Every one of those is scripted here, and a scripted answer is evidence about this host's own
 * order, gate, accounting and retention policy and about nothing else.
 *
 * Two host modules are imported, for one thing each: `recordDecision`, for what the record layer then does with a run
 * one of these calls produced, and the Claude backend's `CONTRACTS_DIR`, for the one directory both read contracts
 * from. The production module under test imports neither, which the last case reads out of its source. One
 * non-builtin package is imported as well, and it is test-only: TypeScript's own compiler, for the preprocessor the
 * static reads below scan source with, the same dependency `test/backends.test.ts` already takes for that.
 */

const SESSION_ID = "pi-session-1";
const SESSION_FILE = "/sessions/pi-session-1.jsonl";
const SOURCE_ID = "pi-session-source";
const SOURCE_FILE = "/sessions/pi-session-source.jsonl";
const FORK_ID = "pi-session-fork";
const FORK_FILE = "/sessions/pi-session-fork.jsonl";
const CHECKPOINT = "entry-42";
const LEAF = "entry-77";
const MODEL = "deepseek/deepseek-chat";
const PROMPT = "implement the bounded slice";
const ANSWER = "## Changed\nfoo.ts";

/** The reference every continuation below is composed from. */
const SOURCE = { backend: "pi", sessionId: SOURCE_ID, sessionFile: SOURCE_FILE, checkpoint: CHECKPOINT } as const;

/** Where the production modules are, for the two static reads the last case makes. */
const EXTENSIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions");

/**
 * TypeScript's own preprocessor, imported the way `test/backends.test.ts` already imports it for the same job. It is
 * what reads the specifiers below rather than a regular expression over the text: a side-effect import, a re-export
 * and a dynamic `import("…")` with a literal in it are all specifiers a module names, and a pattern matching
 * `from "…"` would see none of them. It stays a regression pin on what a file names today rather than a proof of what
 * it can reach: a specifier built at runtime is invisible to any static read, which is what the dynamic-import check
 * beside it is for.
 */
const importSpecifiers = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);

/** Every production module but the one under test, in every extension this repository ships: what none may name. */
const productionFiles = (): string[] =>
	fs
		.readdirSync(EXTENSIONS_DIR, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(m|c)?(ts|js)$/.test(entry.name) && entry.name !== "pi-backend.ts")
		.map((entry) => path.join(entry.parentPath, entry.name));

/**
 * A value a scripted call throws instead of answering, held in a wrapper so `undefined` is a value like any other.
 * The field is declared and assigned rather than written as a constructor parameter property, because node runs these
 * files by stripping their types and a parameter property is syntax that stripping cannot erase.
 */
class Thrown {
	readonly error: unknown;
	constructor(error: unknown) {
		this.error = error;
	}
}

const response = (command: string, success: boolean, data: unknown): PiResponse => ({ id: "pi-fusion-1", command, success, ...(success ? {} : { error: "the child refused this command" }), data });
const ok = (command: string, data: unknown): PiResponse => response(command, true, data);
const no = (command: string, data: unknown): PiResponse => response(command, false, data);

const countersOf = (): PiExit["counters"] => ({ straySettles: 0, earlySettles: 0, lateResponses: 0, extensionErrors: 0, uiCancelledByTransport: 0, unknownUiMethods: 0, listenerErrors: 0, droppedFrames: 0, streamsUnclosed: 0 });

const CLEANUP: PiExit["cleanup"] = { root: "exited", exit: { code: 0, signal: null }, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false };

/** One exit report in the shape the transport writes one. Nothing ran: it is what a scripted shutdown hands back. */
const exitOf = (over: Partial<PiExit> = {}): PiExit => ({
	exit: { code: 0, signal: null },
	cleanup: { ...CLEANUP },
	stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: "the child's own stderr tail", dropped: 0 },
	stoppedByUs: true,
	counters: countersOf(),
	...over,
});

const exitWithCleanup = (over: Partial<PiExit["cleanup"]>): PiExit => exitOf({ cleanup: { ...CLEANUP, ...over } });

const processOf = (pid: number) => ({ pid, ppid: 1, pgid: pid, state: "S", started: "1000" });

const turnOf = (over: Partial<PiTurn> = {}): PiTurn => ({ outcome: "settled", earlySettles: 0, extensionErrors: 0, events: 0, ...over });

/** The role every case runs, with whatever it is about written over it. */
const roleOf = (over: Partial<PiRole> = {}): PiRole => ({
	name: "implement",
	model: MODEL,
	effort: "medium",
	contract: "implement.md",
	tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	extensions: [],
	skills: [],
	...over,
});

/** A state answer in the native shape, with fields nothing below reads kept on it. */
const stateOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	model: { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", api: "openai-completions", contextWindow: 64_000 },
	thinkingLevel: "medium",
	isStreaming: false,
	isCompacting: false,
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	...over,
});

/** The statistics a preparation reads as its baseline. */
const statsOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	cost: 0.25,
	tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
	contextUsage: { tokens: 100, contextWindow: 64_000, percent: 1 },
	...over,
});

/** And the reading one turn ends on, every number at or above that baseline. */
const afterStats = (over: Record<string, unknown> = {}): Record<string, unknown> =>
	statsOf({
		userMessages: 2,
		assistantMessages: 2,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: 6,
		cost: 0.75,
		tokens: { input: 300, output: 60, cacheRead: 10, cacheWrite: 5, total: 375 },
		contextUsage: { tokens: 1_200, contextWindow: 64_000, percent: 2 },
		...over,
	});

const assistantMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	role: "assistant",
	content: [{ type: "text", text: ANSWER }],
	stopReason: "stop",
	// Live counts the stream leaves behind, deliberately far from the session's own: a turn that finished reports the
	// canonical delta instead, and a case that used the same numbers for both could not tell which it was reading.
	usage: { input: 9_999, output: 9_999, cacheRead: 0, cacheWrite: 0 },
	...over,
});

/** The records one turn streams: a tool that ran, its result, and the answer the turn ended on. */
const TURN_EVENTS: PiEvent[] = [
	{ type: "tool_execution_start", toolName: "bash", toolCallId: "call-1", args: { command: "npm test", note: "kept bounded" } },
	{ type: "tool_execution_end", toolName: "bash", toolCallId: "call-1", result: "2 passing", isError: false },
	{ type: "message_end", message: assistantMessage() },
];

const commandRow = (name: string): Record<string, unknown> => ({
	name,
	description: "a control command of this host's own extension",
	source: "extension",
	sourceInfo: { path: CONTROL_EXTENSION_PATH, source: "inline", scope: "temporary", origin: "top-level" },
});

/** One scripted answer: a response, one built when it is asked for, or something thrown in its place. */
type Answer = PiResponse | (() => PiResponse | Promise<PiResponse>) | Thrown;

interface ChildScript {
	/** One queue per command, in the order this call asks for them. */
	requests?: Record<string, Answer[]>;
	turn?: PiTurn | Thrown | ((stream: (event: PiEvent) => void) => PiTurn | Promise<PiTurn>);
	exit?: PiExit | Thrown;
}

/** What the child was asked, in order, with the turns and the stops apart as well. */
interface Seen {
	steps: string[];
	turns: Array<{ text: string; opts: unknown }>;
	shutdowns: Array<"host" | "aborted" | undefined>;
	/**
	 * What the child was asked for that its case scripted no answer to. It is a list rather than an `assert.fail`
	 * because the code under test catches what a child throws: failing inside the double would be swallowed and read
	 * back as an ordinary refusal, so the ask is recorded here and the case is failed afterwards, by the hook below.
	 */
	missing: string[];
}

interface SeamOptions {
	onStart?: (options: PiChildOptions) => void;
	/** What the start seam throws instead of handing a child over. */
	startError?: Thrown;
}

interface HarnessOptions {
	script?: ChildScript;
	seam?: SeamOptions;
	deps?: Partial<PiBackendDeps>;
}

/**
 * One backend over one scripted child, with this case's own root under it. The agent directory and the contract are
 * injected in every harness, so no case reads a contract file this install ships or reaches the SDK's own accessor;
 * the storage is the production one unless a case replaces it.
 */
function harnessOf(t: TestContext, over: HarnessOptions = {}) {
	const script = over.script ?? {};
	const seam = over.seam ?? {};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-backend-"));
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const agentDir = path.join(root, "agent");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const seen: Seen = { steps: [], turns: [], shutdowns: [], missing: [] };
	// Registered beside the root's own removal: a scripting mistake has to fail its case, and it cannot do that from
	// inside the double, whose throw the code under test would catch and report as an ordinary refusal.
	t.after(() => assert.deepEqual(seen.missing, [], "a case scripts every answer the call it drives asks for"));
	const queues: Record<string, Answer[]> = {};
	for (const [command, answers] of Object.entries(script.requests ?? {})) queues[command] = [...answers];
	const options: PiChildOptions[] = [];
	/** Records reach the host the way the transport delivers them: through the callback this call was started with. */
	const stream = (event: PiEvent): void => options[0]?.onEvent?.(event);

	const child: PiChild = {
		pid: 4242,
		startState: { sessionId: SESSION_ID, raw: { sessionId: SESSION_ID } },
		counters: countersOf(),
		// Settled by no case here: a child that has not ended is what every one of these calls runs against.
		exited: new Promise<PiExit>(() => {}),
		request: async (command) => {
			const asked = String(command.type).slice(0, 64);
			seen.steps.push(command.type);
			const answer = queues[command.type]?.shift();
			// A refusal rather than a throw or a plausible answer: it satisfies no readback, so the call fails on its own
			// terms and the hook above is what names the scripting mistake.
			if (answer === undefined) {
				seen.missing.push(`no scripted answer for ${asked}`);
				return no(asked, undefined);
			}
			if (answer instanceof Thrown) throw answer.error;
			return typeof answer === "function" ? await answer() : answer;
		},
		turn: async (text, opts) => {
			seen.steps.push("turn");
			seen.turns.push({ text, opts });
			if (script.turn === undefined) {
				seen.missing.push("no scripted turn");
				return turnOf({ outcome: "failed" });
			}
			if (script.turn instanceof Thrown) throw script.turn.error;
			return typeof script.turn === "function" ? await script.turn(stream) : script.turn;
		},
		respond: (_id: string, _answer: PiUiResponse) => "sent",
		shutdown: async (reason) => {
			seen.steps.push("shutdown");
			seen.shutdowns.push(reason);
			if (script.exit === undefined) return exitOf();
			if (script.exit instanceof Thrown) throw script.exit.error;
			return script.exit;
		},
	};

	/** The bootstrap input each start reads off the launch it was handed, which is the file the composition wrote. */
	const inputs: Array<Record<string, unknown>> = [];
	const start = async (given: PiChildOptions): Promise<PiChild> => {
		options.push(given);
		const inputPath = given.launch.args[1];
		if (typeof inputPath === "string") inputs.push(JSON.parse(fs.readFileSync(inputPath, "utf8")) as Record<string, unknown>);
		seam.onStart?.(given);
		if (seam.startError !== undefined) throw seam.startError.error;
		return child;
	};

	const events: ChildEvent[] = [];
	const reports: PiCallReport[] = [];
	const counts = { progress: 0 };
	const deps: PiBackendDeps = {
		agentDir: async () => agentDir,
		readContract: (name) => `the ${name} contract, as prose the host already read.`,
		start,
		env: { PATH: "/usr/bin" },
		onCall: (report) => reports.push(report),
		...over.deps,
	};
	const backend = createPiBackend(deps);

	const call = (request: Partial<RunRequest<PiRole, PiSession, PiSteerQueue>> = {}): Promise<PiRun> =>
		backend.run({
			role: roleOf(),
			prompt: PROMPT,
			cwd,
			signal: undefined,
			onProgress: () => {
				counts.progress += 1;
			},
			onEvent: (event) => events.push(event),
			...request,
		});

	return { agentDir, backend, call, counts, cwd, deps, events, inputs, options, reports, root, seen, stream };
}

/** The whole scripted new-session call that succeeds, with the one or two answers a case changes written over it. */
const happyScript = (over: { exit?: PiExit | Thrown; after?: PiResponse } = {}): ChildScript => ({
	requests: {
		get_state: [ok("get_state", stateOf()), ok("get_state", stateOf())],
		get_session_stats: [ok("get_session_stats", statsOf()), ok("get_session_stats", afterStats())],
		get_tree: [ok("get_tree", { tree: [], leafId: null }), over.after ?? ok("get_tree", { tree: [], leafId: LEAF })],
		get_last_assistant_text: [ok("get_last_assistant_text", { text: ANSWER })],
	},
	turn: (stream) => {
		for (const event of TURN_EVENTS) stream(event);
		return turnOf({ events: TURN_EVENTS.length });
	},
	...(over.exit === undefined ? {} : { exit: over.exit }),
});

/** The steps one whole new-session call takes: the preparation's two readbacks, then the turn's own, then one stop. */
const HAPPY_STEPS = ["get_state", "get_session_stats", "get_tree", "turn", "get_state", "get_tree", "get_session_stats", "get_last_assistant_text", "shutdown"];

/** One scripted restore: the session the child opened, the control command, the move, and the readbacks after it. */
const restoreScript = (kind: "resume" | "fork"): ChildScript => {
	const moved = kind === "resume" ? { sessionId: SOURCE_ID, sessionFile: SOURCE_FILE } : { sessionId: FORK_ID, sessionFile: FORK_FILE };
	return {
		requests: {
			get_state: [ok("get_state", stateOf({ sessionId: SOURCE_ID, sessionFile: SOURCE_FILE })), ok("get_state", stateOf(moved))],
			get_commands: [ok("get_commands", { commands: [commandRow(kind === "resume" ? NAVIGATE_COMMAND : FORK_COMMAND)] })],
			// The restore's own readback, and then the task's, which is the leaf every one of these cases stops at.
			get_tree: [ok("get_tree", { leafId: CHECKPOINT }), ok("get_tree", { tree: [], leafId: "moved-away" })],
			get_session_stats: [ok("get_session_stats", statsOf(moved))],
		},
		turn: turnOf({ outcome: "acknowledged", ack: ok("prompt", undefined), events: 1 }),
	};
};

const reportOf = (reports: PiCallReport[]): PiCallReport => (reports.length === 1 ? (reports[0] as PiCallReport) : assert.fail(`one report per call, and this call made ${reports.length}`));

type TurnResult = Extract<ChildEvent, { type: "turn_result" }>;

const terminal = (events: ChildEvent[]): TurnResult => {
	const last = events[events.length - 1];
	return last?.type === "turn_result" ? last : assert.fail(`the last event of a call is its own turn_result, and this one is ${last?.type}`);
};

/** What the record layer reads off a finished run, in the shape `recordDecision` takes one. */
const outcomeOf = (run: PiRun) => ({
	ok: !failed(run),
	...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
	...(run.session === undefined ? {} : { session: run.session }),
	...(run.selection === undefined ? {} : { selection: run.selection }),
	...(run.contextTokens === undefined ? {} : { contextTokens: run.contextTokens }),
	...(run.contextWindow === undefined ? {} : { contextWindow: run.contextWindow }),
});

test("one new-session call runs the whole composition, stops its child once, and removes the storage it ran on", async (t) => {
	const harness = harnessOf(t, { script: happyScript() });
	const run = await harness.call();

	assert.deepEqual(harness.seen.steps, HAPPY_STEPS, "the preparation's readbacks, then the turn's own, in one order");
	assert.deepEqual(harness.seen.shutdowns, ["host"], "one stop, and it is the task's own: this composition never stops a child itself");
	assert.deepEqual(harness.seen.turns, [{ text: PROMPT, opts: { completion: "settled" } }], "the prompt exactly as it was composed");

	// What a monitor saw: the session, the tool call bounded to what a monitor may hold, its result, and the end. It
	// is compared through json because a bounded tool input has a null prototype on purpose, and a strict deep
	// comparison reads that as a mismatch rather than as the defence it is.
	assert.deepEqual(
		JSON.parse(JSON.stringify(harness.events)),
		[
			{ type: "init", sessionId: SESSION_ID },
			{ type: "tool_call", name: "bash", brief: "npm test", id: "call-1", input: { command: "npm test", note: "kept bounded" } },
			{ type: "tool_result", toolUseId: "call-1", text: "2 passing", isError: false },
			{ type: "turn_result", ok: true },
		],
		"every event of the call, in order",
	);
	assert.ok(harness.counts.progress >= 2, "progress is reported while the turn runs and once at the end");

	assert.equal(failed(run), false);
	assert.equal(run.stopReason, "stop");
	assert.equal(run.text, ANSWER);
	assert.deepEqual(run.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: LEAF }, "the leaf the turn left, on the structured reference");
	assert.equal(run.sessionId, SESSION_ID);
	assert.equal(run.checkpoint, undefined, "a pi continuation stands on the structured reference alone");
	assert.deepEqual(run.selection, { model: MODEL, effort: "medium" });
	assert.equal(run.modelId, MODEL);
	// The canonical accounting: this turn's own delta against the preparation's baseline, and never the live counts
	// the stream left behind, which this case made large enough to tell the two apart.
	assert.deepEqual([run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite], [215, 40, 10, 5]);
	assert.equal(run.costUsd, 0.5);
	assert.deepEqual([run.contextTokens, run.contextWindow], [1_200, 64_000]);
	assert.equal(run.cleanupNotice, undefined, "an ending that left nothing behind leaves a person nothing to look at");

	const report = reportOf(harness.reports);
	assert.equal(report.stage, "task");
	assert.deepEqual([report.startCalled, report.startResolved], [true, true]);
	assert.deepEqual(report.disposition, { safe: true, concerns: [] });
	assert.deepEqual([report.storage?.attempted, report.storage?.disposed], [true, true]);
	assert.equal(fs.existsSync(report.storage?.callDir ?? ""), false, "an ending that left nothing behind is what licences removing the call directory");
});

test("a resume and a fork are launched from the recorded session, and what each failed one records is its own intent's", async (t) => {
	const call = { handle: "f1", role: "implement", backend: "pi" as const, hostSessionId: "host-1" };

	const resumeHarness = harnessOf(t, { script: restoreScript("resume") });
	const resumeIntent: SessionIntent = { kind: "resume", ref: { ...SOURCE } };
	const resumed = await resumeHarness.call({ session: resumeHarness.backend.session(resumeIntent) });

	assert.deepEqual(resumeHarness.inputs[0]?.session, { kind: "open", file: SOURCE_FILE, sessionId: SOURCE_ID, checkpoint: CHECKPOINT }, "the input the child is launched with names the recorded file and the recorded checkpoint");
	assert.equal(resumeHarness.seen.turns[0]?.text, `/${NAVIGATE_COMMAND} ${JSON.stringify(CHECKPOINT)}`, "the continuation is carried out by this host's own control command");
	assert.equal(resumeHarness.seen.turns.length, 1, "and that command is the only thing sent: this case's prompt never reached the child");
	assert.deepEqual(resumeHarness.seen.shutdowns, ["host"], "the task stopped the child once when its own leaf gate refused");
	assert.equal(failed(resumed), true);
	assert.equal(resumed.stopReason, "task");
	assert.equal(resumed.errorMessage, "the pi session was not standing where this run required it to be", "which is the refusal the leaf gate makes before a prompt goes out");
	assert.deepEqual(resumed.session, { backend: "pi", sessionId: SOURCE_ID, sessionFile: SOURCE_FILE, checkpoint: CHECKPOINT });
	assert.deepEqual(recordDecision({ ...call, intent: resumeIntent }, outcomeOf(resumed)), { keep: true }, "a continuation that failed leaves the record it continues authoritative");
	assert.equal(reportOf(resumeHarness.reports).stage, "task");

	const forkHarness = harnessOf(t, { script: restoreScript("fork") });
	const forkIntent: SessionIntent = { kind: "fork", from: { ...SOURCE } };
	const forked = await forkHarness.call({ session: forkHarness.backend.session(forkIntent) });

	assert.deepEqual(forkHarness.inputs[0]?.session, { kind: "open", file: SOURCE_FILE, sessionId: SOURCE_ID, checkpoint: CHECKPOINT });
	assert.equal(forkHarness.seen.turns[0]?.text, `/${FORK_COMMAND} ${JSON.stringify(CHECKPOINT)}`);
	assert.equal(forkHarness.seen.turns.length, 1, "one turn here too, and it is the fork command rather than this case's prompt");
	assert.equal(failed(forked), true);
	assert.equal(forked.errorMessage, "the pi session was not standing where this run required it to be");
	assert.deepEqual(forked.session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT }, "a fork that failed keeps its own identity and the checkpoint it forked at");
	const decision = recordDecision({ ...call, intent: forkIntent }, outcomeOf(forked)) as { entry: Record<string, unknown> };
	assert.deepEqual(decision.entry.session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT });
	assert.deepEqual(decision.entry.selection, { model: MODEL, effort: "medium" });
});

test("a preparation that refused reports its own stage, and its storage goes exactly when its child's ending left nothing", async (t) => {
	// A startup that failed on a child that was over: nothing was left behind, so the call directory goes.
	const clean = harnessOf(t, { seam: { startError: new Thrown(new PiTransportError(piFailure("startup", { stage: "models" }), exitOf())) } });
	const cleanRun = await clean.call();
	assert.equal(failed(cleanRun), true);
	assert.equal(cleanRun.stopReason, "prepare");
	assert.equal(cleanRun.session, undefined, "nothing was verified, so nothing is published");
	assert.deepEqual(clean.seen.shutdowns, [], "a startup that never handed a child over has nothing to stop");
	assert.deepEqual(clean.events, [{ type: "turn_result", ok: false, message: cleanRun.errorMessage }], "a call that never had a child emits no init");
	const cleanReport = reportOf(clean.reports);
	assert.equal(cleanReport.stage, "prepare-refused");
	assert.deepEqual([cleanReport.startCalled, cleanReport.startResolved], [true, false]);
	assert.deepEqual([cleanReport.storage?.attempted, cleanReport.storage?.disposed], [true, true]);
	assert.equal(fs.existsSync(cleanReport.storage?.callDir ?? ""), false);

	// The same refusal with a root nothing could stop: the concern travels into what a person is told, and the call
	// directory stays, because a process that may still be writing into it is what this rule is for.
	const messy = harnessOf(t, { seam: { startError: new Thrown(new PiTransportError(piFailure("startup", { stage: "models" }), exitWithCleanup({ root: "unstoppable" }))) } });
	const messyRun = await messy.call();
	assert.match(messyRun.errorMessage ?? "", /\(the cleanup after it left: root-unstoppable\)/);
	assert.ok(messyRun.errorMessage?.endsWith(STORAGE_RETAINED), `and the run says the storage was kept: ${messyRun.errorMessage}`);
	assert.equal(terminal(messy.events).message, messyRun.errorMessage, "the terminal event carries that same combined text");
	const messyReport = reportOf(messy.reports);
	assert.deepEqual(messyReport.disposition, { safe: false, concerns: ["root-unstoppable"] });
	assert.equal(messyReport.storage?.attempted, false, "storage nothing may remove is not attempted at all");
	assert.equal(fs.existsSync(messyReport.storage?.callDir ?? ""), true);
	assert.equal(messyRun.errorMessage?.includes(messyReport.storage?.callDir ?? "no directory"), false, "and what it says names no path");

	// A continuation whose restore refused, with a pipe its cleanup still held: the diagnostic is the restore's own,
	// and the held pipe keeps the directory just as an unstoppable root does.
	const restore = harnessOf(t, {
		script: {
			// The child opened some other session, which is what a restore's first readback refuses.
			requests: { get_state: [ok("get_state", stateOf())] },
			exit: exitWithCleanup({ stdio: "held" }),
		},
	});
	const restoreRun = await restore.call({ session: restore.backend.session({ kind: "resume", ref: { ...SOURCE } }) });
	assert.equal(restoreRun.stopReason, "restore");
	assert.match(restoreRun.errorMessage ?? "", /^the pi child did not open the recorded session/);
	assert.match(restoreRun.errorMessage ?? "", /\(the cleanup after it left: stdio-held\)/);
	assert.ok(restoreRun.errorMessage?.endsWith(STORAGE_RETAINED));
	assert.deepEqual(restore.seen.shutdowns, ["host"], "the restore stopped the child itself, once, and this composition added none");
	assert.equal(terminal(restore.events).ok, false);
	assert.equal(restore.events.some((event) => event.type === "init"), false);
	const restoreReport = reportOf(restore.reports);
	assert.equal(restoreReport.stage, "prepare-refused");
	assert.deepEqual(restoreReport.disposition, { safe: false, concerns: ["stdio-held"] });
	assert.equal(fs.existsSync(restoreReport.storage?.callDir ?? ""), true);
});

test("a turn that read back whole on a child that left processes behind is demoted, and its storage is kept", async (t) => {
	const harness = harnessOf(t, { script: happyScript({ exit: exitWithCleanup({ leftovers: [processOf(5)] }) }) });
	const run = await harness.call();

	assert.equal(failed(run), true, "a success is only one while its child's own ending left nothing behind");
	assert.equal(run.stopReason, "cleanup");
	assert.match(run.errorMessage ?? "", new RegExp(`^${CLEANUP_UNCERTAIN}: leftovers\\.`));
	assert.match(run.errorMessage ?? "", /trusted only to the point it stood at before the turn/);
	assert.ok(run.errorMessage?.endsWith(STORAGE_RETAINED), `a demoted success says its storage was kept too: ${run.errorMessage}`);
	// The line a person is pointed at, on a run nobody cancelled: what the cleanup left and the directory it kept.
	assert.equal(run.cleanupNotice, `${CLEANUP_ATTENTION}: leftovers; ${STORAGE_LEFT}`);
	assert.equal((run.activity ?? "").includes(CLEANUP_ATTENTION), false, "and the line its child was last on is left alone, because a failed run is shown its own message");
	assert.equal(terminal(harness.events).message, run.errorMessage);
	assert.deepEqual(run.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE }, "the identity it stood on before the turn, never the leaf that turn produced");
	assert.equal(run.text, ANSWER, "the work read back, and what it said is still reported");
	assert.deepEqual([run.tokensIn, run.tokensOut], [215, 40], "and so is the canonical accounting of the turn");
	assert.equal(terminal(harness.events).ok, false);

	const report = reportOf(harness.reports);
	assert.equal(report.stage, "task");
	assert.deepEqual(report.disposition, { safe: false, concerns: ["leftovers"] });
	assert.equal(report.storage?.attempted, false);
	assert.equal(fs.existsSync(report.storage?.callDir ?? ""), true);
});

test("a cancelled call takes nothing it cannot account for, and asks for at most one stop wherever it was cut off", async (t) => {
	// Before anything: no contract is read, no directory is made and no child is started.
	const before = harnessOf(t);
	const queue = new PiSteerQueue();
	const beforeRun = await before.call({ signal: AbortSignal.abort(), input: queue });
	assert.equal(beforeRun.aborted, true);
	assert.equal(beforeRun.errorMessage, RUN_CANCELLED);
	assert.deepEqual(before.events, [{ type: "turn_result", ok: false, message: RUN_CANCELLED }]);
	assert.equal(before.counts.progress, 1, "even a call that never started reports its run once");
	assert.equal(queue.open, false, "and the queue it was handed is closed");
	const beforeReport = reportOf(before.reports);
	assert.equal(beforeReport.stage, "aborted-before-start");
	assert.deepEqual([beforeReport.startCalled, beforeReport.storage], [false, undefined]);
	assert.equal(fs.existsSync(path.join(before.agentDir, "pi-fusion")), false, "nothing was made under the agent directory at all");
	assert.deepEqual(before.seen.steps, []);

	// While the preparation reads its child back: the gate refuses, the preparation stops the child once, and this
	// composition adds no stop of its own.
	const duringPrepare = new AbortController();
	const prepare = harnessOf(t, {
		script: {
			requests: {
				get_state: [
					() => {
						duringPrepare.abort();
						return ok("get_state", stateOf());
					},
				],
			},
		},
	});
	const prepareRun = await prepare.call({ signal: duringPrepare.signal });
	assert.equal(prepareRun.aborted, true);
	assert.deepEqual(prepare.seen.shutdowns, ["aborted"], "one stop, asked for under the cancellation that caused it");
	assert.equal(reportOf(prepare.reports).stage, "prepare-refused");

	// And while the turn runs: the task's own gate refuses once the turn comes back, and stops the child once. This one
	// is cancelled onto a child that left a process behind, because that is the case where a cancellation has something
	// to say: the host shows a cancelled run its activity and nothing else, so the storage it kept goes there or nowhere.
	const duringTask = new AbortController();
	const task = harnessOf(t, {
		script: {
			...happyScript({ exit: exitWithCleanup({ leftovers: [processOf(7)] }) }),
			turn: () => {
				duringTask.abort();
				return turnOf({ events: 0 });
			},
		},
	});
	const taskRun = await task.call({ signal: duringTask.signal });
	assert.equal(taskRun.aborted, true);
	assert.equal(taskRun.stopReason, "aborted");
	assert.deepEqual(task.seen.shutdowns, ["aborted"]);
	assert.equal(taskRun.cleanupNotice, `${CLEANUP_ATTENTION}: leftovers; ${STORAGE_LEFT}`, "the one line a cancelled run is shown says both what the cleanup left and that the storage stayed");
	assert.equal(taskRun.activity, taskRun.cleanupNotice, "and it is the activity as well, because that is the field the host reads for a run its own signal aborted");
	assert.ok(taskRun.errorMessage?.endsWith(STORAGE_RETAINED));
	const taskReport = reportOf(task.reports);
	assert.equal(taskReport.stage, "task");
	assert.deepEqual(taskReport.disposition, { safe: false, concerns: ["leftovers"] });
	assert.equal(fs.existsSync(taskReport.storage?.callDir ?? ""), true);
	assert.equal((taskRun.cleanupNotice ?? "").includes(taskReport.storage?.callDir ?? "no directory"), false, "and it names no path");
});

test("storage that could not be removed is a note on a success and a sentence on a failure, and never a value or a path", async (t) => {
	const refusedDispose = new Error("SECRET-dispose-refused");
	/** The production storage with one seam over it: a disposer that throws, which no real layout has. */
	const brittle = (request: StorageRequest): PreparedCall => {
		const real = prepareCallStorage(request);
		return {
			...real,
			dispose: () => {
				throw refusedDispose;
			},
		};
	};

	const success = harnessOf(t, { script: happyScript(), deps: { storage: brittle } });
	const run = await success.call();
	assert.equal(failed(run), false, "a directory nobody could remove is not a reason to fail a turn that read back whole");
	assert.deepEqual(run.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: LEAF }, "so its checkpoint still stands");
	assert.equal(run.text, `${ANSWER}\n\n${DISPOSE_WARNING}`);
	assert.deepEqual(terminal(success.events), { type: "turn_result", ok: true, message: DISPOSE_WARNING });
	const report = reportOf(success.reports);
	assert.deepEqual([report.storage?.attempted, report.storage?.disposed], [true, false]);
	assert.equal(report.storage?.disposeError?.error, refusedDispose, "the exact value, in the report and nowhere else");
	assert.equal(fs.existsSync(report.storage?.callDir ?? ""), true, "and the directory is still there to be looked at");
	assert.equal(run.cleanupNotice, `${CLEANUP_ATTENTION}: ${STORAGE_LEFT}`, "a directory still there is worth saying even on a run that succeeded");
	for (const shown of [run.text, run.errorMessage ?? "", run.cleanupNotice ?? "", JSON.stringify(success.events)]) {
		assert.equal(shown.includes("SECRET-dispose-refused"), false, `what the disposer threw reaches nothing a person reads: ${shown}`);
		assert.equal(shown.includes(report.storage?.callDir ?? "no directory"), false, `and neither does the path: ${shown}`);
	}

	// The same failure on a run that failed: one more sentence on the message it already had.
	const failing = harnessOf(t, { script: happyScript({ after: ok("get_tree", { tree: [], leafId: null }) }), deps: { storage: brittle } });
	const failedRun = await failing.call();
	assert.equal(failed(failedRun), true);
	assert.equal(failedRun.errorMessage, `the pi session was not standing where this run required it to be ${DISPOSE_FAILED}`);
	assert.equal(fs.existsSync(reportOf(failing.reports).storage?.callDir ?? ""), true);
});

test("a helper that threw rather than reported leaves this host unable to say how the call ended, and it says so", async (t) => {
	// The task seam, which in production is the real task: a value thrown out of it may or may not have spent that
	// task's own one shutdown, so nothing is stopped from here and the call ends unverified.
	const taskError = new Error("SECRET-task-threw");
	const taskHarness = harnessOf(t, {
		script: happyScript(),
		deps: {
			task: async (_request: PiTaskRequest): Promise<PiTaskResult> => {
				throw taskError;
			},
		},
	});
	const taskRun = await taskHarness.call();
	assert.equal(failed(taskRun), true);
	assert.equal(taskRun.stopReason, "unverified");
	assert.match(taskRun.errorMessage ?? "", new RegExp(`^${RUN_UNVERIFIED}`));
	assert.ok(taskRun.errorMessage?.endsWith(STORAGE_RETAINED), `a run nobody could account for says its storage was kept: ${taskRun.errorMessage}`);
	assert.equal(taskRun.errorMessage?.includes("SECRET-task-threw"), false);
	assert.deepEqual(taskRun.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE }, "the identity the preparation verified, and no checkpoint");
	assert.deepEqual(taskHarness.seen.shutdowns, [], "this composition stops no child, here least of all");
	const taskReport = reportOf(taskHarness.reports);
	assert.equal(taskReport.stage, "task-rejected");
	assert.equal(taskReport.thrown?.error, taskError, "the exact value, internal to the report");
	assert.deepEqual(taskReport.disposition, { safe: false, concerns: ["unverified"] });
	assert.equal(fs.existsSync(taskReport.storage?.callDir ?? ""), true);

	// A start seam that threw something which is not a transport error at all. What this proves is the policy and not
	// a child: the seam below is a function that spawned nothing, and this host keeps the storage anyway, because the
	// seam was entered and a host that was handed no child cannot say what that seam did.
	const startError = new Error("SECRET-start-threw");
	const startHarness = harnessOf(t, { seam: { startError: new Thrown(startError) } });
	const startRun = await startHarness.call();
	assert.equal(startRun.stopReason, "unverified");
	assert.ok(startRun.errorMessage?.endsWith(STORAGE_RETAINED));
	assert.equal(startRun.session, undefined, "nothing was verified before it, so there is no identity to publish");
	assert.deepEqual(startHarness.seen.shutdowns, []);
	const startReport = reportOf(startHarness.reports);
	assert.equal(startReport.stage, "prepare-rejected");
	assert.deepEqual([startReport.startCalled, startReport.startResolved], [true, false]);
	assert.equal(startReport.thrown?.error, startError);
	assert.deepEqual(startReport.disposition, { safe: false, concerns: ["unverified"] });
	assert.equal(fs.existsSync(startReport.storage?.callDir ?? ""), true, "conservative on purpose: entered is enough to keep the directory");
});

test("everything in front of the child throws rather than reporting a run, and a call that never started one disposes of its storage", async (t) => {
	// The contract this install ships and the host's own agent directory are both local problems, wrapped in one fixed
	// sentence each with the value that failed kept as the cause and nowhere else.
	const contractError = new Error("SECRET-no-contract-file");
	const contract = harnessOf(t, {
		deps: {
			readContract: () => {
				throw contractError;
			},
		},
	});
	await assert.rejects(contract.call(), (error: Error) => {
		assert.equal(error.message, CONTRACT_UNREADABLE);
		assert.equal(error.cause, contractError);
		return true;
	});
	const contractReport = reportOf(contract.reports);
	assert.equal(contractReport.stage, "contract");
	assert.equal(contractReport.thrown?.error, contractError);
	assert.deepEqual([contractReport.startCalled, contractReport.storage, contractReport.ended], [false, undefined, undefined]);
	assert.deepEqual(contract.events, [], "a call that threw reports no run, so it emits no terminal event either");

	const agentError = new Error("SECRET-no-agent-dir");
	const agent = harnessOf(t, { deps: { agentDir: async () => Promise.reject(agentError) } });
	await assert.rejects(agent.call(), (error: Error) => {
		assert.equal(error.message, AGENT_DIR_UNREADABLE);
		assert.equal(error.cause, agentError);
		return true;
	});
	assert.equal(reportOf(agent.reports).stage, "agent-dir");

	// Storage composes its own actionable repair message, so what it threw travels out exactly as it was.
	const storageError = new Error("inspect this and repair it by hand: it is not a directory");
	const storage = harnessOf(t, {
		deps: {
			storage: () => {
				throw storageError;
			},
		},
	});
	await assert.rejects(storage.call(), (error: unknown) => error === storageError);
	const storageReport = reportOf(storage.reports);
	assert.equal(storageReport.stage, "storage");
	assert.deepEqual([storageReport.startCalled, storageReport.storage], [false, undefined]);

	// A call the preparation would not compose at all, in front of the start: definitely no child, so the directory
	// this call made goes and the caller gets the error that says what to fix.
	const composed = harnessOf(t);
	await assert.rejects(composed.call({ role: roleOf({ tools: [] }) }), (error: Error) => {
		assert.match(error.message, /has no pi tool list/);
		return true;
	});
	const composedReport = reportOf(composed.reports);
	assert.equal(composedReport.stage, "prepare-rejected");
	assert.deepEqual([composedReport.startCalled, composedReport.storage?.attempted, composedReport.storage?.disposed], [false, true, true]);
	assert.equal(fs.existsSync(composedReport.storage?.callDir ?? ""), false);

	// The same, with a disposer that threw and a value that is not an `Error` to take a message from: both fixed
	// texts, both exact values kept in the report, and neither of them in what is thrown.
	const notAnError = "a value nobody expected";
	const disposeError = new Error("SECRET-dispose-refused");
	const brittle = (request: StorageRequest): PreparedCall => {
		const real = prepareCallStorage(request);
		const copy: PreparedCall = {
			...real,
			dispose: () => {
				throw disposeError;
			},
		};
		// One way to fail a composition with something that is not an error: the path the call input is written to is
		// read off the storage, and this one refuses to name it.
		Object.defineProperty(copy, "inputPath", {
			get(): string {
				throw notAnError;
			},
		});
		return copy;
	};
	const both = harnessOf(t, { deps: { storage: brittle } });
	await assert.rejects(both.call(), (error: Error) => {
		assert.equal(error.message, `${CALL_NOT_COMPOSED} ${DISPOSE_FAILED}`);
		assert.equal(error.cause, notAnError);
		return true;
	});
	const bothReport = reportOf(both.reports);
	assert.equal(bothReport.thrown?.error, notAnError);
	assert.equal(bothReport.storage?.disposeError?.error, disposeError);
	assert.deepEqual([bothReport.storage?.attempted, bothReport.storage?.disposed], [true, false]);
});

test("the host's own callbacks cannot change what a call reports, and nothing in this build constructs this backend", async (t) => {
	// Every callback a host passes, throwing, and the run is the same run. Each is counted before it throws, so what
	// this reads is that they were called rather than that a throw was swallowed somewhere.
	const counted = { progress: 0, events: 0, reports: 0 };
	const harness = harnessOf(t, {
		script: happyScript(),
		deps: {
			onCall: () => {
				counted.reports += 1;
				throw new Error("a caller's own report handler threw");
			},
		},
	});
	const run = await harness.call({
		onProgress: () => {
			counted.progress += 1;
			throw new Error("a caller's own progress handler threw");
		},
		onEvent: () => {
			counted.events += 1;
			throw new Error("a caller's own event handler threw");
		},
	});
	assert.equal(failed(run), false, "a monitor that throws is not a reason for a run to report something else");
	assert.deepEqual(run.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: LEAF });
	assert.equal(counted.events, 4, "the init, the tool call, its result and the terminal event all went out");
	assert.ok(counted.progress >= 2);
	assert.equal(counted.reports, 1, "and the call is reported exactly once");

	// The combined event handler, in the one order that matters: the turn's own evidence counts a record before a
	// monitor is handed it, which is read here from inside the monitor's own callback.
	let observedWhenEmitted = -1;
	let observer: PiTaskObserver | undefined;
	/** The harness's own stream, bound after it exists: a task that reached for it directly would name it before it was. */
	let streamRecord: ((event: PiEvent) => void) | undefined;
	const ordering = harnessOf(t, {
		script: happyScript(),
		deps: {
			// A scripted task, so this case can stream one record at a moment it controls. It stops no child, which is
			// why the call below ends with the storage kept.
			task: async (request: PiTaskRequest): Promise<PiTaskResult> => {
				observer = request.observer;
				request.observer.begin();
				streamRecord?.({ type: "tool_execution_start", toolName: "bash", toolCallId: "call-9", args: { command: "npm test" } });
				return { ok: false, reason: "turn", session: request.prepared.session, selection: request.prepared.selection, evidence: request.observer.snapshot() };
			},
		},
	});
	streamRecord = ordering.stream;
	const orderedRun = await ordering.call({
		onEvent: (event) => {
			if (event.type !== "tool_call") return;
			observedWhenEmitted = observer?.snapshot().events ?? -1;
			throw new Error("and a monitor that throws on that record costs the run nothing");
		},
	});
	assert.equal(observedWhenEmitted, 1, "the observer had already counted the record when the mapper handed it to the monitor");
	assert.equal(failed(orderedRun), true, "the scripted task refused, which is what this case's own task returns");
	const orderedReport = reportOf(ordering.reports);
	assert.equal(orderedReport.stage, "task");
	assert.deepEqual(orderedReport.disposition, { safe: false, concerns: ["unverified"] });
	assert.equal(fs.existsSync(orderedReport.storage?.callDir ?? ""), true, "a task that reported no exit is unverified, and unverified keeps the directory");

	// The shapes the host reads a backend through, and the one directory both backends read their contracts from.
	assert.equal(PI_CONTRACTS_DIR, CONTRACTS_DIR);
	const erased = hostBackend(createPiBackend(harness.deps));
	assert.equal(erased.name, "pi");
	assert.ok(erased.control() instanceof PiSteerQueue);
	const intent: SessionIntent = { kind: "new" };
	assert.deepEqual(createPiBackend().session(intent), { kind: "new", intent });

	// What this module may import, read through the compiler's own preprocessor so every form of naming a module is
	// seen: no claude backend, no host, no card and no package specifier at all, so nothing in it can reach an SDK.
	// It is a regression pin on the dependencies rather than a proof of isolation, which is why the dynamic-import
	// check is beside it: a specifier composed at runtime is what no static read of any kind would catch.
	const source = fs.readFileSync(path.join(EXTENSIONS_DIR, "backends", "pi-backend.ts"), "utf8");
	const specifiers = importSpecifiers(source);
	assert.deepEqual(
		[...new Set(specifiers)].sort(),
		["../process-tree.ts", "./pi-binding.ts", "./pi-launch.ts", "./pi-outcome.ts", "./pi-prepare.ts", "./pi-storage.ts", "./pi-task.ts", "./pi-transport.ts", "./types.ts", "node:fs", "node:path", "node:url"].sort(),
	);
	for (const forbidden of ["claude.ts", "fusion.ts", "cards.ts"]) {
		assert.equal(
			specifiers.some((specifier) => specifier.includes(forbidden)),
			false,
			`the pi backend imports no ${forbidden}`,
		);
	}
	for (const specifier of specifiers) assert.ok(specifier.startsWith(".") || specifier.startsWith("node:"), `a package specifier would be a way to an sdk, and this one is ${specifier}`);
	assert.equal(/\bimport\s*\(/.test(source), false, "and it reaches for nothing dynamically either");

	// And nothing constructs it: no production file names this module at all.
	assert.deepEqual(
		productionFiles().filter((file) => fs.readFileSync(file, "utf8").includes("pi-backend")),
		[],
		"the pi backend is registered nowhere, so no production file imports it",
	);
});
