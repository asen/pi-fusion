import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { PiRole } from "../extensions/backends/pi-binding.ts";
import { CONTROL_EXTENSION_PATH, FORK_COMMAND, NAVIGATE_COMMAND } from "../extensions/backends/pi-control-extension.mjs";
import { type PiPrepared, type PiPrepareRefused, type PiPrepareRequest, type PiPrepareResult, type PiQuestionWatch, preparePiChild } from "../extensions/backends/pi-prepare.ts";
import { QUESTION_TOOL_NAME } from "../extensions/backends/pi-question-tool.mjs";
import { type PreparedCall, prepareCallStorage } from "../extensions/backends/pi-storage.ts";
import { type PiChild, type PiChildOptions, type PiExit, type PiResponse, PiTransportError, type PiTurn, type PiUiRequest, type PiUiResponse, piFailure } from "../extensions/backends/pi-transport.ts";
import type { Ask, SessionIntent } from "../extensions/backends/types.ts";

/*
 * What the host does while it prepares a Pi child, driven against one scripted start seam and one scripted child that
 * are neither a process nor a protocol: every answer below is a literal this file wrote, so what is measured is the
 * composition, the order of the readbacks, the gate and the one shutdown a claimed failure performs, and nothing at
 * all about Pi. No case here starts a child, speaks the native protocol, builds a session or imports an SDK, and no
 * scripted answer is evidence that a real child opens a session, reports a selection or counts its usage this way.
 *
 * The one thing that is real here is the local filesystem: each case prepares its call storage the way production
 * does, under a root of its own that it removes afterwards, so the input this composition writes is a file that was
 * actually written. That is a test writing json into a directory it owns, and it is not a child, a process or a run.
 */

const SESSION_ID = "pi-session-fresh";
const SESSION_FILE = "/sessions/pi-session-fresh.jsonl";
const SOURCE_ID = "pi-session-source";
const SOURCE_FILE = "/sessions/pi-session-source.jsonl";
const FORK_ID = "pi-session-fork";
const FORK_FILE = "/sessions/pi-session-fork.jsonl";
const CHECKPOINT = "entry-42";
const MODEL = "deepseek/deepseek-chat";

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

/** Enough microtask turns for a settled promise to reach its handler and for that handler's own work to finish. */
const drain = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/** One scripted answer: a response, one built when it is asked for, or something thrown in its place. */
type Answer = PiResponse | (() => PiResponse | Promise<PiResponse>) | Thrown;

interface ChildScript {
	/** One queue per command, in the order this preparation asks for them. */
	requests?: Record<string, Answer[]>;
	turn?: PiTurn | Thrown;
	/** What the shutdown a claimed failure attempts reports, or throws. */
	exit?: PiExit | Thrown;
}

/** What the child was asked, in order: the three lists apart, and the interleaving of them beside it. */
interface Seen {
	steps: string[];
	requests: string[];
	turns: Array<{ text: string; opts: unknown }>;
	shutdowns: Array<"host" | "aborted" | undefined>;
	answers: Array<{ id: string; response: PiUiResponse }>;
}

interface SeamOptions {
	/** Runs inside the seam, after the options are captured and before the child is handed over. */
	onStart?: (options: PiChildOptions) => void | Promise<void>;
	startError?: Thrown;
}

const response = (command: string, success: boolean, data: unknown): PiResponse => ({ id: "pi-fusion-1", command, success, ...(success ? {} : { error: "the child refused this command" }), data });
const ok = (command: string, data: unknown): PiResponse => response(command, true, data);
const no = (command: string, data: unknown): PiResponse => response(command, false, data);

const countersOf = (): PiExit["counters"] => ({ straySettles: 0, earlySettles: 0, lateResponses: 0, extensionErrors: 0, uiCancelledByTransport: 0, unknownUiMethods: 0, listenerErrors: 0, droppedFrames: 0, streamsUnclosed: 0 });

/** One exit report in the shape the transport writes one. Nothing ran: it is what a scripted shutdown hands back. */
const exitOf = (code: number | null = 0): PiExit => {
	const outcome = { code, signal: null };
	return {
		exit: outcome,
		cleanup: { root: "exited", exit: outcome, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false },
		stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: "", dropped: 0 },
		stoppedByUs: true,
		counters: countersOf(),
	};
};

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

/** A state answer in the native shape, with fields this preparation reads nothing from kept on it. */
const stateOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	model: { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat", api: "openai-completions", contextWindow: 64_000 },
	thinkingLevel: "medium",
	isStreaming: false,
	isCompacting: false,
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	messageCount: 0,
	...over,
});

/** A statistics answer in the native shape. Every number here is one a baseline keeps. */
const statsOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	userMessages: 3,
	assistantMessages: 4,
	toolCalls: 5,
	toolResults: 5,
	totalMessages: 12,
	tokens: { input: 900, output: 120, cacheRead: 400, cacheWrite: 60, total: 1_480 },
	cost: 0.25,
	...over,
});

const commandRow = (name: string): Record<string, unknown> => ({
	name,
	description: "a control command of this host's own extension",
	source: "extension",
	sourceInfo: { path: CONTROL_EXTENSION_PATH, source: "inline", scope: "temporary", origin: "top-level" },
});

const controlCommands = (): PiResponse => ok("get_commands", { commands: [commandRow(NAVIGATE_COMMAND), commandRow(FORK_COMMAND)] });
const turnOf = (): PiTurn => ({ outcome: "acknowledged", ack: ok("prompt", undefined), earlySettles: 0, extensionErrors: 0, events: 1 });

/** One extension ui record in the native shape, as the transport hands one over. */
const uiInput = (id: string, title: string): PiUiRequest => ({ id, method: "input", expectsResponse: true, record: { type: "extension_ui_request", id, method: "input", title } });

/**
 * One start seam and the child behind it. The seam captures what it was handed and answers with the child; the child
 * answers out of per-command queues and records what it was asked, in order.
 */
function seamOf(script: ChildScript = {}, over: SeamOptions = {}) {
	const seen: Seen = { steps: [], requests: [], turns: [], shutdowns: [], answers: [] };
	const queues: Record<string, Answer[]> = {};
	for (const [command, answers] of Object.entries(script.requests ?? {})) queues[command] = [...answers];
	let settleExit!: (exit: PiExit) => void;
	let failExit!: (error: unknown) => void;
	const exited = new Promise<PiExit>((resolve, reject) => {
		settleExit = resolve;
		failExit = reject;
	});
	const child: PiChild = {
		pid: 4242,
		startState: { sessionId: "pi-session-ready", raw: { sessionId: "pi-session-ready" } },
		counters: countersOf(),
		exited,
		request: async (command) => {
			seen.steps.push(command.type);
			seen.requests.push(command.type);
			const answer = queues[command.type]?.shift();
			if (answer === undefined) return assert.fail(`this case scripted no ${command.type} answer, and one was asked for`);
			if (answer instanceof Thrown) throw answer.error;
			return typeof answer === "function" ? await answer() : answer;
		},
		turn: async (text, opts) => {
			seen.steps.push("turn");
			seen.turns.push({ text, opts });
			if (script.turn === undefined) return assert.fail("this case scripted no turn, and one was started");
			if (script.turn instanceof Thrown) throw script.turn.error;
			return script.turn;
		},
		respond: (id, answer) => {
			seen.answers.push({ id, response: answer });
			return "sent";
		},
		shutdown: async (reason) => {
			seen.steps.push("shutdown");
			seen.shutdowns.push(reason);
			if (script.exit === undefined) return exitOf();
			if (script.exit instanceof Thrown) throw script.exit.error;
			return script.exit;
		},
	};
	const options: PiChildOptions[] = [];
	const start = async (given: PiChildOptions): Promise<PiChild> => {
		options.push(given);
		await over.onStart?.(given);
		if (over.startError !== undefined) throw over.startError.error;
		return child;
	};
	/** One dialog, fed the way the transport feeds one: through the callback this call was started with. */
	const dialog = (request: PiUiRequest): boolean => options[0]?.onUiRequest?.(request) ?? false;
	return { seen, child, options, start, dialog, settleExit, failExit };
}

/**
 * The storage one case runs on, prepared the way production prepares it, under a root this case owns and removes. A
 * fresh root per call, so an input written by one case can never be the file another case reads.
 */
function storageOf(t: TestContext): PreparedCall {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prepare-"));
	const cwd = path.join(root, "project");
	fs.mkdirSync(cwd, { recursive: true });
	const storage = prepareCallStorage({ hostAgentDir: path.join(root, "agent"), cwd, handle: "run1" });
	t.after(() => {
		storage.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	});
	return storage;
}

/** One request, with this case's own storage under it. */
function callOf(t: TestContext, over: Partial<PiPrepareRequest> = {}): { request: PiPrepareRequest; storage: PreparedCall } {
	const storage = storageOf(t);
	const request: PiPrepareRequest = {
		role: roleOf(),
		storage,
		intent: { kind: "new" },
		contract: "the implement contract, as prose the host already read.",
		env: { PATH: "/usr/bin" },
		...over,
	};
	return { request, storage };
}

const prepared = (result: PiPrepareResult): PiPrepared => (result.ok ? result : assert.fail(`this preparation should have succeeded and refused with ${result.reason}`));
const refused = (result: PiPrepareResult): PiPrepareRefused => (result.ok ? assert.fail("this preparation should not have succeeded") : result);
const watchOf = (result: PiPrepareResult): PiQuestionWatch => result.questions ?? assert.fail("a call that can answer a question has a question watch");

/** The reference a continuation is composed from, and the one every restore case below moves. */
const SOURCE = { backend: "pi", sessionId: SOURCE_ID, sessionFile: SOURCE_FILE, checkpoint: CHECKPOINT } as const;
const RESUME: SessionIntent = { kind: "resume", ref: SOURCE };
const FORK: SessionIntent = { kind: "fork", from: SOURCE };

/** A fresh session's script: one state answer, one statistics answer, and nothing else to send. */
const freshScript = (over: { state?: Answer[]; stats?: Answer[] } = {}): ChildScript => ({
	requests: {
		get_state: over.state ?? [ok("get_state", stateOf())],
		get_session_stats: over.stats ?? [ok("get_session_stats", statsOf())],
	},
});

/**
 * A continuation's script: the restore's own five answers, with the statistics this preparation asks for after them.
 * The first state answers a different thinking level from the second on purpose — the selection is read off the
 * session the child ended in, and a case that read the first one would come out with the wrong level.
 */
const continuedScript = (after: Record<string, unknown>, over: { stats?: Answer[] } = {}): ChildScript => ({
	requests: {
		get_state: [ok("get_state", stateOf({ sessionId: SOURCE_ID, sessionFile: SOURCE_FILE, thinkingLevel: "low" })), ok("get_state", stateOf(after))],
		get_commands: [controlCommands()],
		get_tree: [ok("get_tree", { tree: [], leafId: CHECKPOINT })],
		get_session_stats: over.stats ?? [ok("get_session_stats", statsOf({ sessionId: after.sessionId, sessionFile: after.sessionFile }))],
	},
	turn: turnOf(),
});

const RESUMED = { sessionId: SOURCE_ID, sessionFile: SOURCE_FILE };
const FORKED = { sessionId: FORK_ID, sessionFile: FORK_FILE };

test("a new session is composed, written, started and read back in one order, and the child is handed over running", async (t) => {
	const events: unknown[] = [];
	const onEvent = (event: unknown): void => {
		events.push(event);
	};
	const seam = seamOf(freshScript({ stats: [ok("get_session_stats", statsOf({ contextUsage: { tokens: 1_200, contextWindow: 64_000, percent: 1.875 } }))] }));
	const { request, storage } = callOf(t, { start: seam.start, onEvent });
	const result = prepared(await preparePiChild(request));

	assert.deepEqual(seam.seen.requests, ["get_state", "get_session_stats"], "the state the child opened, then the statistics it starts at, and no command besides");
	assert.deepEqual(seam.seen.turns, [], "a new session is moved nowhere, so nothing is prompted");
	assert.deepEqual(seam.seen.shutdowns, [], "a preparation that worked leaves the child running for the run that follows");
	assert.equal(result.child, seam.child, "the child handed back is the one the seam started");
	assert.deepEqual(result.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE });
	assert.equal("checkpoint" in result.session, false, "a session with nothing in it has no point a continuation could restore to");
	assert.deepEqual(result.selection, { model: MODEL, effort: "medium" });
	assert.deepEqual(result.usage, {
		sessionId: SESSION_ID,
		sessionFile: SESSION_FILE,
		userMessages: 3,
		assistantMessages: 4,
		toolCalls: 5,
		toolResults: 5,
		totalMessages: 12,
		cost: 0.25,
		tokens: { input: 900, output: 120, cacheRead: 400, cacheWrite: 60, total: 1_480 },
		contextUsage: { tokens: 1_200, contextWindow: 64_000, percent: 1.875 },
	});
	assert.equal(result.questions, undefined, "a call with nowhere to send a question watches none");

	assert.equal(seam.options.length, 1, "one child, started once");
	const options = seam.options[0];
	assert.equal(options.onEvent, onEvent, "the caller's own event callback, handed over as it was");
	assert.deepEqual(options.cleanup, {}, "every pi child is started under an owned cleanup, pinned here rather than left to a default");
	assert.equal(options.onUiRequest, undefined, "and a call that can answer no question routes no dialog");
	assert.equal(options.launch.args[1], storage.inputPath, "the child reads the input this call's own storage holds");

	const input = JSON.parse(fs.readFileSync(storage.inputPath, "utf8"));
	assert.equal(input.questionTool, false);
	assert.deepEqual(input.session, { kind: "new" });
	assert.deepEqual(input.tools, roleOf().tools, "the role's own tools, with nothing added to them");
	assert.equal(input.contract, request.contract);
	assert.deepEqual(events, [], "nothing here delivers an event: the callback is passed on, not called");
});

test("a resume and a fork are restored first, and everything after is read off the session that restore left", async (t) => {
	const rows: Array<{ what: string; intent: SessionIntent; after: Record<string, unknown>; command: string; session: Record<string, unknown>; context?: { tokens: null; contextWindow: number; percent: null } }> = [
		{ what: "resume", intent: RESUME, after: RESUMED, command: NAVIGATE_COMMAND, session: { backend: "pi", sessionId: SOURCE_ID, sessionFile: SOURCE_FILE, checkpoint: CHECKPOINT } },
		{ what: "fork", intent: FORK, after: FORKED, command: FORK_COMMAND, session: { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT }, context: { tokens: null, contextWindow: 64_000, percent: null } },
	];
	for (const row of rows) {
		const stats = statsOf({ sessionId: row.after.sessionId, sessionFile: row.after.sessionFile, ...(row.context === undefined ? {} : { contextUsage: row.context }) });
		const seam = seamOf(continuedScript(row.after, { stats: [ok("get_session_stats", stats)] }));
		const cleanup = { deadlineMs: 9_000 };
		const { request } = callOf(t, { start: seam.start, intent: row.intent, cleanup, killGraceMs: 1_500 });
		const result = prepared(await preparePiChild(request));

		assert.deepEqual(seam.seen.steps, ["get_state", "get_commands", "turn", "get_state", "get_tree", "get_session_stats"], `${row.what}: the statistics come after the whole restore, never inside it`);
		assert.deepEqual(seam.seen.turns, [{ text: `/${row.command} ${JSON.stringify(CHECKPOINT)}`, opts: { completion: "acknowledged" } }], `${row.what}: one control command, with the checkpoint as a json string`);
		assert.deepEqual(result.session, row.session, `${row.what}: the identity the restore verified, with the checkpoint its own tree confirmed`);
		assert.deepEqual(result.selection, { model: MODEL, effort: "medium" }, `${row.what}: the level of the session the child ended in, not the one it started from`);
		assert.equal(result.usage.sessionId, row.after.sessionId);
		assert.equal(result.usage.sessionFile, row.after.sessionFile);
		assert.deepEqual(result.usage.contextUsage, row.context, `${row.what}: an unknown share is kept as the nulls it came as, and an absent one stays absent`);
		assert.deepEqual(seam.seen.shutdowns, [], `${row.what}: a restored child is handed on running`);
		assert.equal(seam.options[0].cleanup, cleanup, `${row.what}: the caller's own cleanup, pinned rather than replaced`);
		assert.equal(seam.options[0].killGraceMs, 1_500);

		const input = JSON.parse(fs.readFileSync(request.storage.inputPath, "utf8"));
		assert.deepEqual(input.session, { kind: "open", file: SOURCE_FILE, sessionId: SOURCE_ID, checkpoint: CHECKPOINT }, `${row.what}: the child is asked to open the recorded session, whichever way it is then moved`);
	}
});

test("a call that can answer a question routes its dialogs, counts what came of each, and stops nothing itself", async (t) => {
	interface Asked {
		question: string;
		resolve(value: string): void;
		reject(error: unknown): void;
	}
	const asked: Asked[] = [];
	const ask: Ask = (question) =>
		new Promise<string>((resolve, reject) => {
			asked.push({ question, resolve, reject });
		});

	let early: boolean | undefined;
	const seam = seamOf(freshScript(), {
		// Fed through the callback the seam was handed, before the child exists: the router is inactive and refuses it.
		onStart: (options) => {
			early = options.onUiRequest?.(uiInput("dialog-early", "too soon?"));
		},
	});
	const { request, storage } = callOf(t, { start: seam.start, onQuestion: ask });
	const result = prepared(await preparePiChild(request));
	const watch = watchOf(result);

	assert.equal(early, false, "a dialog that arrived before the child was attached is refused, not held");
	const input = JSON.parse(fs.readFileSync(storage.inputPath, "utf8"));
	assert.equal(input.questionTool, true);
	assert.deepEqual(
		input.tools.filter((tool: string) => tool === QUESTION_TOOL_NAME),
		[QUESTION_TOOL_NAME],
		"the question tool's own name, once and at the end of the role's own list",
	);
	assert.equal(input.tools[input.tools.length - 1], QUESTION_TOOL_NAME);
	assert.equal(typeof seam.options[0].onUiRequest, "function");

	assert.equal(seam.dialog(uiInput("dialog-1", "which name?")), true, "a dialog after the child is attached is taken");
	await drain();
	assert.equal(asked[0].question, "which name?");
	asked[0].resolve("fusion");
	await drain();
	assert.deepEqual(seam.seen.answers, [{ id: "dialog-1", response: { value: "fusion" } }], "one answer, on the wire once");
	assert.equal(watch.fatal, undefined, "an answer the transport took is the one end that is not a failure");
	assert.equal(watch.counters.answered, 1);
	assert.equal(watch.counters.fatal, 0);

	assert.equal(seam.dialog(uiInput("dialog-2", "and again?")), true);
	await drain();
	const boom = new Error("the host could not answer this one");
	asked[1].reject(boom);
	await drain();
	const fatal = await watch.firstFatal;
	assert.equal(fatal.id, "dialog-2");
	assert.equal(fatal.end, "failed");
	assert.equal(fatal.error, boom);
	assert.equal(watch.fatal, fatal, "the first fatal outcome is kept, and the promise and the getter are the same one");
	assert.deepEqual({ routed: watch.counters.routed, refused: watch.counters.refused, answered: watch.counters.answered, fatal: watch.counters.fatal }, { routed: 2, refused: 1, answered: 1, fatal: 1 });
	assert.deepEqual(seam.seen.shutdowns, [], "a question that failed after the child was prepared is the run's to act on, and this module stops nothing for it");
});

test("a selection that is not exactly the one the role asked for refuses the call, and the child is stopped once", async (t) => {
	const rows: Array<{ what: string; state: Record<string, unknown>; role?: PiRole }> = [
		{ what: "another provider", state: { model: { id: "deepseek-chat", provider: "openrouter" } } },
		{ what: "another model id", state: { model: { id: "deepseek-reasoner", provider: "deepseek" } } },
		{ what: "no model at all", state: { model: null } },
		{ what: "no model field", state: { model: undefined } },
		{ what: "no thinking level", state: { thinkingLevel: undefined } },
		{ what: "a level pi does not have", state: { thinkingLevel: "ultra" } },
		{ what: "a level the child clamped", state: { thinkingLevel: "medium" }, role: roleOf({ effort: "high" }) },
	];
	for (const row of rows) {
		const seam = seamOf(freshScript({ state: [ok("get_state", stateOf(row.state))] }));
		const { request } = callOf(t, { start: seam.start, ...(row.role === undefined ? {} : { role: row.role }) });
		const result = refused(await preparePiChild(request));

		assert.equal(result.reason, "selection", `${row.what}: the selection is what this refuses on`);
		assert.deepEqual(seam.seen.requests, ["get_state"], `${row.what}: no baseline is taken off a child running something else`);
		assert.deepEqual(seam.seen.shutdowns, ["host"], `${row.what}: one stop, asked for as the host's`);
		assert.deepEqual(result.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE }, `${row.what}: the identity that was verified before this failed comes back with it`);
		assert.equal(result.selection, undefined);
		assert.equal(result.exit?.cleanup.root, "exited", `${row.what}: and what the shutdown reported is on it`);
	}

	// The same refusal on a fork, whose verified identity carries the checkpoint its own restore confirmed.
	const forked = seamOf(continuedScript({ ...FORKED, thinkingLevel: "high" }));
	const { request: forkRequest } = callOf(t, { start: forked.start, intent: FORK });
	const onFork = refused(await preparePiChild(forkRequest));
	assert.equal(onFork.reason, "selection");
	assert.deepEqual(onFork.session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT });
	assert.equal(forked.seen.requests.includes("get_session_stats"), false);
	assert.deepEqual(forked.seen.shutdowns, ["host"]);

	// A role that named no level takes the one the child reported, which is the level that call actually runs.
	const open = seamOf(freshScript({ state: [ok("get_state", stateOf({ thinkingLevel: "xhigh" }))] }));
	const { request: openRequest } = callOf(t, { start: open.start, role: roleOf({ effort: undefined }) });
	assert.deepEqual(prepared(await preparePiChild(openRequest)).selection, { model: MODEL, effort: "xhigh" });
});

test("a usage baseline that does not read back whole refuses the call, with the session it was taken against on it", async (t) => {
	const rows: Array<{ what: string; stats: PiResponse }> = [
		{ what: "a failed answer", stats: no("get_session_stats", statsOf(FORKED)) },
		{ what: "a token count that is text", stats: ok("get_session_stats", statsOf({ ...FORKED, tokens: { input: "900", output: 120, cacheRead: 400, cacheWrite: 60, total: 1_480 } })) },
		{ what: "a negative cost", stats: ok("get_session_stats", statsOf({ ...FORKED, cost: -1 })) },
		{ what: "another session id", stats: ok("get_session_stats", statsOf({ ...FORKED, sessionId: SOURCE_ID })) },
		{ what: "another session file", stats: ok("get_session_stats", statsOf({ ...FORKED, sessionFile: SOURCE_FILE })) },
		{ what: "a context window of zero", stats: ok("get_session_stats", statsOf({ ...FORKED, contextUsage: { tokens: 0, contextWindow: 0, percent: 0 } })) },
	];
	for (const row of rows) {
		const seam = seamOf(continuedScript(FORKED, { stats: [row.stats] }));
		const { request } = callOf(t, { start: seam.start, intent: FORK });
		const result = refused(await preparePiChild(request));

		assert.equal(result.reason, "usage", `${row.what}: the baseline is what this refuses on`);
		assert.deepEqual(seam.seen.steps, ["get_state", "get_commands", "turn", "get_state", "get_tree", "get_session_stats", "shutdown"], `${row.what}: the baseline is the last thing asked for, and the stop the only thing after it`);
		assert.deepEqual(seam.seen.shutdowns, ["host"], `${row.what}: one stop and no more`);
		assert.deepEqual(result.session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT }, `${row.what}: the fork this child stands in is still what it stands in`);
		assert.deepEqual(result.selection, { model: MODEL, effort: "medium" }, `${row.what}: and the selection verified before this failed comes back too`);
	}
});

test("a restore that refused is passed through whole, and the child it already stopped is not stopped again", async (t) => {
	const seam = seamOf({
		requests: {
			get_state: [ok("get_state", stateOf({ sessionId: SOURCE_ID, sessionFile: SOURCE_FILE }))],
			get_commands: [ok("get_commands", { commands: [] })],
		},
		exit: exitOf(0),
	});
	const { request } = callOf(t, { start: seam.start, intent: RESUME });
	const result = refused(await preparePiChild(request));

	assert.equal(result.reason, "restore", "one reason at the top, and the restore's own beneath it");
	assert.equal(result.restore?.reason, "commands");
	assert.equal(result.restore?.exit?.cleanup.root, "exited", "the stop the restore itself performed, reported where the restore reported it");
	assert.deepEqual(seam.seen.shutdowns, ["host"], "exactly one shutdown in the whole call, and it is the restore's");
	assert.deepEqual(seam.seen.requests, ["get_state", "get_commands"], "no baseline is taken off a child that was never moved");
	assert.equal(result.exit, undefined, "this module attached no exit of its own to a refusal it did not stop for");
	assert.equal(result.session, undefined);
	assert.equal(result.selection, undefined);
});

test("nothing is owned before the child exists, and everything is from the moment one is handed over", async (t) => {
	const finalExit = exitOf(70);
	const startup = new PiTransportError(piFailure("startup", { stage: "models" }), finalExit);
	const withExit = seamOf({}, { startError: new Thrown(startup) });
	const first = refused(await preparePiChild(callOf(t, { start: withExit.start }).request));
	assert.equal(first.reason, "startup");
	assert.equal(first.error, startup, "the transport's own error, kept as it was");
	assert.deepEqual(first.failure, startup.failure);
	assert.equal(first.exit, finalExit, "and the whole final exit it carried, because nobody else holds that child's record");
	assert.equal(first.unverified, undefined);
	assert.deepEqual(withExit.seen.shutdowns, [], "there was never a handle to stop");

	const unverified = new PiTransportError(piFailure("unverified"));
	const withoutExit = seamOf({}, { startError: new Thrown(unverified) });
	const second = refused(await preparePiChild(callOf(t, { start: withoutExit.start }).request));
	assert.equal(second.reason, "startup");
	assert.equal(second.error, unverified);
	assert.equal(second.failure?.kind, "unverified");
	assert.equal(second.unverified, true, "a startup whose cleanup produced no report says so");
	assert.equal(second.exit, undefined, "and no exit is invented for it");

	const boom = new TypeError("this seam is not a transport");
	const other = seamOf({}, { startError: new Thrown(boom) });
	await assert.rejects(preparePiChild(callOf(t, { start: other.start }).request), (error: unknown) => error === boom);
	assert.deepEqual(other.seen.shutdowns, [], "a value this module has no reading of is rethrown, and no child was handed over for it");

	// A role this composition cannot compose refuses before the seam is reached, so no input is written for it.
	const never = seamOf(freshScript());
	const { request, storage } = callOf(t, { start: never.start, role: roleOf({ model: "deepseek-chat" }) });
	await assert.rejects(preparePiChild(request), /pi provider and model id/);
	assert.equal(never.options.length, 0, "nothing was started");
	assert.equal(fs.existsSync(storage.inputPath), false, "and nothing was written: the caller still owns the storage it prepared");

	// The other side of that line. This seam hands a child over whose `exited` is not something handlers can be
	// attached to at all — the one narrow cast in this file, for a handle no declared type admits — and a child handed
	// over is this call's whatever is wrong with it: the observer registration sits inside the claimed block, so what
	// it throws is an ordinary claimed failure that stops the child once, rather than a rejection nobody stopped one for.
	const malformed = seamOf(freshScript());
	const withoutExited = { ...malformed.child, exited: undefined } as unknown as PiChild;
	const owned = refused(await preparePiChild(callOf(t, { start: async () => withoutExited }).request));
	assert.equal(owned.reason, "transport", "a refusal of this call's own, not a rejection handed back to the caller");
	assert.ok(owned.error instanceof TypeError, "the value the registration threw, kept as it was");
	assert.deepEqual(malformed.seen.requests, [], "nothing was asked of a child that could not be observed");
	assert.deepEqual(malformed.seen.shutdowns, ["host"], "and it was stopped exactly once, as the host's");
	assert.equal(owned.exit?.cleanup.root, "exited", "under the shutdown's own report");
	assert.equal(owned.unverified, undefined, "which is a stop that reported, so nothing here is unverified");
});

test("the gate ends a preparation at the first of its three ends, and reports what the one stop produced", async (t) => {
	const cancelled = new AbortController();
	cancelled.abort();
	const untouched = seamOf(freshScript());
	const { request: cancelledRequest, storage } = callOf(t, { start: untouched.start, signal: cancelled.signal });
	assert.deepEqual(await preparePiChild(cancelledRequest), { ok: false, reason: "aborted" }, "a call cancelled before it began composes nothing");
	assert.equal(untouched.options.length, 0);
	assert.equal(fs.existsSync(storage.inputPath), false);

	// Cancelled while the child was answering: the gate after the await reads the signal before anything else.
	const stopping = new AbortController();
	const abortive = seamOf(
		freshScript({
			state: [
				() => {
					stopping.abort();
					return ok("get_state", stateOf());
				},
			],
		}),
	);
	const midway = refused(await preparePiChild(callOf(t, { start: abortive.start, signal: stopping.signal }).request));
	assert.equal(midway.reason, "aborted");
	assert.deepEqual(abortive.seen.shutdowns, ["aborted"], "the stop is asked for under the reason this preparation already decided");
	assert.equal(midway.session, undefined, "the state answer that arrived after the cancellation is not read");

	// The child went away while it was answering: the exit the shutdown reports is what comes back, not the observed one.
	let release!: (exit: PiExit) => void;
	const departing = seamOf({
		...freshScript({
			stats: [
				async () => {
					release(exitOf(3));
					await drain();
					return ok("get_session_stats", statsOf());
				},
			],
		}),
		exit: exitOf(7),
	});
	release = departing.settleExit;
	const gone = refused(await preparePiChild(callOf(t, { start: departing.start }).request));
	assert.equal(gone.reason, "exited");
	assert.deepEqual(departing.seen.shutdowns, ["host"]);
	assert.equal(gone.exit?.exit.code, 7, "what the shutdown reported, kept exactly as it came, rather than the end this host happened to observe");
	assert.deepEqual(gone.selection, { model: MODEL, effort: "medium" }, "the selection verified before the child went is still evidence");

	// A question that failed while the child was answering: the run cannot continue on a child waiting for nobody.
	let feed!: (request: PiUiRequest) => boolean;
	const questioned = seamOf(
		freshScript({
			stats: [
				async () => {
					feed(uiInput("dialog-9", "who decides?"));
					await drain();
					return ok("get_session_stats", statsOf());
				},
			],
		}),
	);
	feed = questioned.dialog;
	const failing: Ask = async () => {
		throw new Error("no host is listening");
	};
	const asked = refused(await preparePiChild(callOf(t, { start: questioned.start, onQuestion: failing }).request));
	assert.equal(asked.reason, "question");
	assert.equal(asked.outcome?.id, "dialog-9");
	assert.equal(asked.outcome?.end, "failed");
	assert.deepEqual(questioned.seen.shutdowns, ["host"], "one stop, as the host's");
	assert.equal(watchOf(asked).counters.fatal, 1);

	// A step that threw something with no reading at all, and a shutdown that threw as well.
	const broken = seamOf({ requests: { get_state: [new Thrown(undefined)] }, exit: new Thrown(0) });
	const thrown = refused(await preparePiChild(callOf(t, { start: broken.start }).request));
	assert.equal(thrown.reason, "transport");
	assert.equal("error" in thrown, true, "presence is what says a failure had a value");
	assert.equal(thrown.error, undefined);
	assert.equal(thrown.failure, undefined, "there is no typed failure behind a value this host cannot read");
	assert.equal(thrown.unverified, true);
	assert.equal(thrown.shutdownError, 0, "the value the shutdown threw, kept as it was");
	assert.equal(thrown.exit, undefined, "and no exit guessed for it");
	assert.deepEqual(broken.seen.shutdowns, ["host"]);
});
