import assert from "node:assert/strict";
import test from "node:test";
import type { PiPrepared, PiQuestionWatch, PiUsageBaseline } from "../extensions/backends/pi-prepare.ts";
import type { PiQuestionOutcome } from "../extensions/backends/pi-question-routing.ts";
import { PI_STEER_QUEUE_MAX, PI_TASK_ERROR_MAX_CHARS, PI_TASK_TEXT_MAX_CHARS, PiSteerQueue, type PiSteerSink, type PiTaskEvidence, type PiTaskReason, type PiTaskRefused, type PiTaskResult, runPiTask, taskObserver } from "../extensions/backends/pi-task.ts";
import { type PiChild, type PiEvent, type PiExit, type PiExtensionError, type PiResponse, PiTransportError, type PiTurn, type PiUiResponse, piFailure } from "../extensions/backends/pi-transport.ts";

/*
 * What the host does with one task turn, driven against scripted in-memory doubles and nothing else: the child here
 * answers out of literals this file wrote, the prepared child is an object literal, the question watch is a deferred
 * and every event is a record typed out below. No case starts a process, speaks the native protocol, builds a session,
 * touches storage or imports an SDK, so what is measured is this host's own order, gate, evidence and shutdown, and
 * nothing at all about Pi. No scripted answer here is evidence that a real child streams these records, moves its leaf
 * this way or counts its usage like this.
 */

const SESSION_ID = "pi-session-1";
const SESSION_FILE = "/sessions/pi-session-1.jsonl";
const FORK_ID = "pi-session-2";
const FORK_FILE = "/sessions/pi-session-2.jsonl";
const CHECKPOINT = "entry-42";
const LEAF = "entry-77";
const MODEL = "deepseek/deepseek-chat";
const PROMPT = "implement the bounded slice";
const SESSION = { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE } as const;

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

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
};

/** Enough microtask turns for a settled promise to reach its handler and for that handler's own work to finish. */
const drain = async (): Promise<void> => {
	for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

/** One scripted answer: a response, one that arrives later, one built when it is asked for, or something thrown. */
type Answer = PiResponse | Promise<PiResponse> | (() => PiResponse) | Thrown;

const response = (command: string, success: boolean, data: unknown): PiResponse => ({ id: "pi-fusion-1", command, success, ...(success ? {} : { error: "the child refused this command" }), data });
const ok = (command: string, data: unknown): PiResponse => response(command, true, data);
const no = (command: string, data: unknown): PiResponse => response(command, false, data);

const countersOf = (): PiExit["counters"] => ({ straySettles: 0, earlySettles: 0, lateResponses: 0, extensionErrors: 0, uiCancelledByTransport: 0, unknownUiMethods: 0, listenerErrors: 0, droppedFrames: 0, streamsUnclosed: 0 });

/** One exit report in the shape the transport writes one. Nothing ran: it is what a scripted shutdown hands back. */
const exitOf = (over: Partial<PiExit> = {}): PiExit => {
	const outcome = { code: 0, signal: null };
	return {
		exit: outcome,
		cleanup: { root: "exited", exit: outcome, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false },
		stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: "", dropped: 0 },
		stoppedByUs: true,
		counters: countersOf(),
		...over,
	};
};

const turnOf = (over: Partial<PiTurn> = {}): PiTurn => ({ outcome: "settled", earlySettles: 0, extensionErrors: 0, events: 0, ...over });

/** An empty tally, for a scripted observer that has to answer something without counting anything. */
const noEvidence = (): PiTaskEvidence => ({ events: 0, assistantMessages: 0, agentEnds: 0, toolStarts: 0, toolErrors: 0, compactions: 0, autoRetries: 0, extensionErrors: 0 });

/** One extension error in the shape a turn's report carries one. It is a literal: nothing ran to produce it. */
const EXTENSION_ERROR: PiExtensionError = { error: "the control extension threw", extensionPath: "<inline:pi-fusion>", event: "command", cut: { error: false, extensionPath: false, event: false } };

const baselineOf = (over: Partial<PiUsageBaseline> = {}): PiUsageBaseline => ({
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	cost: 0.25,
	tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
	...over,
});

/** The statistics the child reports after the turn: every number at or above the baseline it started from. */
const statsOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	userMessages: 2,
	assistantMessages: 2,
	toolCalls: 1,
	toolResults: 1,
	totalMessages: 6,
	cost: 0.75,
	tokens: { input: 300, output: 60, cacheRead: 10, cacheWrite: 5, total: 375 },
	...over,
});

/** A state answer in the native shape: the same session, the same selection, and a child doing nothing else. */
const stateOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	model: { id: "deepseek-chat", provider: "deepseek", name: "DeepSeek Chat" },
	thinkingLevel: "medium",
	isStreaming: false,
	isCompacting: false,
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	...over,
});

const assistantMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", ...over });
const messageEnd = (message: unknown): PiEvent => ({ type: "message_end", message });

interface ChildScript {
	requests?: Record<string, Answer[]>;
	turn?: PiTurn | Promise<PiTurn> | (() => PiTurn | Promise<PiTurn>) | Thrown;
	exit?: PiExit | Thrown | (() => PiExit | Promise<PiExit>);
}

/** One child as a script: per-command answer queues, one turn, one shutdown, and what it was asked, in order. */
function childOf(script: ChildScript = {}) {
	const seen = { steps: [] as string[], turns: [] as Array<{ text: string; opts: unknown }>, shutdowns: [] as Array<"host" | "aborted" | undefined>, steers: [] as string[] };
	const queues: Record<string, Answer[]> = {};
	for (const [command, answers] of Object.entries(script.requests ?? {})) queues[command] = [...answers];
	let settleExit!: (exit: PiExit) => void;
	const exited = new Promise<PiExit>((resolve) => {
		settleExit = resolve;
	});
	const child: PiChild = {
		pid: 4242,
		startState: { sessionId: SESSION_ID, raw: { sessionId: SESSION_ID } },
		counters: countersOf(),
		exited,
		request: async (command) => {
			seen.steps.push(command.type);
			if (command.type === "steer") seen.steers.push(String(command.message));
			const answer = queues[command.type]?.shift();
			if (answer === undefined) return assert.fail(`this case scripted no ${command.type} answer, and one was asked for`);
			if (answer instanceof Thrown) throw answer.error;
			return await (typeof answer === "function" ? answer() : answer);
		},
		turn: async (text, opts) => {
			seen.steps.push("turn");
			seen.turns.push({ text, opts });
			if (script.turn === undefined) return assert.fail("this case scripted no turn, and one was started");
			if (script.turn instanceof Thrown) throw script.turn.error;
			return await (typeof script.turn === "function" ? script.turn() : script.turn);
		},
		respond: (_id: string, _answer: PiUiResponse) => "sent",
		shutdown: async (reason) => {
			seen.steps.push("shutdown");
			seen.shutdowns.push(reason);
			if (script.exit === undefined) return exitOf();
			if (script.exit instanceof Thrown) throw script.exit.error;
			return await (typeof script.exit === "function" ? script.exit() : script.exit);
		},
	};
	return { child, seen, settleExit };
}

function preparedOf(child: PiChild, over: Partial<PiPrepared> = {}): PiPrepared {
	return {
		ok: true,
		child,
		session: { ...SESSION },
		selection: { model: MODEL, effort: "medium" },
		usage: baselineOf(),
		...over,
	};
}

/** A question watch the case drives: no router, no dialog and no child behind it, only the one outcome it reports. */
function watchOf() {
	let first: PiQuestionOutcome | undefined;
	let resolveFatal!: (outcome: PiQuestionOutcome) => void;
	const firstFatal = new Promise<PiQuestionOutcome>((resolve) => {
		resolveFatal = resolve;
	});
	const watch: PiQuestionWatch = {
		get open(): number {
			return 0;
		},
		get counters() {
			return { routed: 1, refused: 0, settledAfterEnd: 0, listenerErrors: 0, answered: 0, fatal: first === undefined ? 0 : 1 };
		},
		get fatal(): PiQuestionOutcome | undefined {
			return first;
		},
		firstFatal,
	};
	const fail = (outcome: PiQuestionOutcome): void => {
		first = outcome;
		resolveFatal(outcome);
	};
	return { watch, fail };
}

const FATAL: PiQuestionOutcome = { id: "dialog-1", question: "which name?", end: "failed", error: new Error("no host is listening") };

const done = (result: PiTaskResult) => (result.ok ? result : assert.fail(`this task should have succeeded and refused with ${result.reason}`));
const refused = (result: PiTaskResult): PiTaskRefused => (result.ok ? assert.fail("this task should not have succeeded") : result);

interface RunCase {
	before?: unknown;
	after?: unknown;
	state?: Record<string, unknown>;
	stats?: Answer;
	text?: Answer;
	turn?: PiTurn | Thrown;
	exit?: PiExit | Thrown;
	prepared?: Partial<PiPrepared>;
	events?: PiEvent[];
	/** Records streamed while the first `get_tree` is answered: after `begin`, and before the prompt's own mark. */
	early?: PiEvent[];
}

/**
 * One whole task, scripted end to end, with the events of the turn streamed from inside the turn itself so they are
 * counted where a real stream would put them. Everything a case does not name is the shape that succeeds; `before` and
 * `after` are read by presence, because a leaf of `null` is an answer and not an absent one.
 */
async function runOnce(over: RunCase = {}) {
	const observer = taskObserver();
	const events = over.events ?? [messageEnd(assistantMessage())];
	const turn = over.turn ?? turnOf({ events: events.length });
	const firstTree = ok("get_tree", { tree: [], leafId: "before" in over ? over.before : null });
	const scripted = childOf({
		requests: {
			get_tree: [
				over.early === undefined
					? firstTree
					: () => {
							for (const event of over.early ?? []) observer.onEvent(event);
							return firstTree;
						},
				ok("get_tree", { tree: [], leafId: "after" in over ? over.after : LEAF }),
			],
			get_state: [ok("get_state", stateOf(over.state))],
			get_session_stats: [over.stats ?? ok("get_session_stats", statsOf())],
			get_last_assistant_text: [over.text ?? ok("get_last_assistant_text", { text: "done" })],
		},
		turn:
			turn instanceof Thrown
				? turn
				: () => {
						for (const event of events) observer.onEvent(event);
						return turn;
					},
		...(over.exit === undefined ? {} : { exit: over.exit }),
	});
	const prepared = preparedOf(scripted.child, over.prepared);
	const result = await runPiTask({ prepared, prompt: PROMPT, observer });
	return { result, seen: scripted.seen };
}

test("a task turn runs, is counted once per answer, reads back whole and ends with one stop", async () => {
	const observer = taskObserver();
	// Before `begin`: the records of the preparation that came before this turn, which this turn is not measured on.
	observer.onEvent(messageEnd(assistantMessage({ content: [{ type: "text", text: "from the preparation" }] })));

	const gate = deferred<PiTurn>();
	const long = "🙂".repeat(PI_TASK_TEXT_MAX_CHARS + 20);
	const answer = assistantMessage({ content: [{ type: "text", text: long }, { type: "thinking", thinking: "kept nowhere" }] });
	const scripted = childOf({
		requests: {
			get_tree: [ok("get_tree", { tree: [], leafId: null }), ok("get_tree", { tree: [], leafId: LEAF })],
			get_state: [ok("get_state", stateOf())],
			get_session_stats: [ok("get_session_stats", statsOf())],
			get_last_assistant_text: [ok("get_last_assistant_text", { text: "done" })],
			steer: [ok("steer", {})],
		},
		turn: gate.promise,
	});
	const queue = new PiSteerQueue();
	const prepared = preparedOf(scripted.child);
	const running = runPiTask({ prepared, prompt: PROMPT, observer, input: queue });
	await drain();

	assert.deepEqual(scripted.seen.steps, ["get_tree", "turn"], "the leaf is read before the prompt goes out, and nothing else is");
	assert.deepEqual(scripted.seen.turns, [{ text: PROMPT, opts: { completion: "settled" } }], "the prompt exactly as it was composed, ending at the child's own quiescence");
	assert.equal(queue.push("prefer the small change"), true);

	// One assistant answer, streamed the three ways this child reports it, plus a tool that failed and was tolerated.
	const streamed: PiEvent[] = [
		{ type: "tool_execution_start", toolName: "bash" },
		{ type: "tool_execution_end", toolName: "bash", isError: true },
		messageEnd(assistantMessage({ role: "user", content: "a user message ends too" })),
		messageEnd(answer),
		{ type: "turn_end", message: answer },
		{ type: "agent_end", messages: [answer], willRetry: false },
	];
	for (const event of streamed) observer.onEvent(event);
	await drain();
	assert.deepEqual(scripted.seen.steers, ["prefer the small change"], "a steer pushed after the prompt was taken goes out while the turn is still running");
	gate.resolve(turnOf({ events: 6 }));
	const result = done(await running);

	assert.deepEqual(scripted.seen.steps, ["get_tree", "turn", "steer", "get_state", "get_tree", "get_session_stats", "get_last_assistant_text", "shutdown"]);
	assert.deepEqual(scripted.seen.shutdowns, ["host"], "exactly one stop, asked for as the host's");
	assert.deepEqual(result.session, { ...SESSION, checkpoint: LEAF }, "the session it ran in, with the leaf this turn left as its checkpoint");
	assert.deepEqual(result.selection, prepared.selection, "the selection the preparation verified, not a second reading of it");
	assert.equal(result.text, "done");
	assert.deepEqual(result.usage.delta, { userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 4, cost: 0.5, tokens: { input: 200, output: 40, cacheRead: 10, cacheWrite: 5, total: 255 } });
	assert.equal(result.usage.before, prepared.usage, "the baseline the preparation took, as it was");
	assert.equal(result.usage.after.totalMessages, 6, "the reading this turn ended on, beside the share of it this turn had");

	const evidence = result.evidence;
	assert.equal(evidence.events, 6, "six records since begin, and nothing from before it");
	assert.equal(evidence.assistantMessages, 1, "one answer, counted at its message_end alone: turn_end and agent_end repeat it");
	assert.equal(evidence.agentEnds, 1);
	assert.deepEqual({ toolStarts: evidence.toolStarts, toolErrors: evidence.toolErrors, extensionErrors: evidence.extensionErrors }, { toolStarts: 1, toolErrors: 1, extensionErrors: 0 }, "a tool that failed is evidence and not a reason to fail a turn");
	assert.equal(evidence.last?.from, "agent_end", "the last record of that answer refreshed what is known of it");
	assert.equal(evidence.last?.stopReason, "stop");
	assert.equal([...(evidence.last?.text ?? "")].length, PI_TASK_TEXT_MAX_CHARS, "cut by code point, so no character is halved");
	assert.equal(evidence.last?.text.endsWith("🙂"), true);
	assert.deepEqual(evidence.last?.cut, { text: true, errorMessage: false });
	assert.equal(Object.isFrozen(evidence), true);

	observer.onEvent(messageEnd(assistantMessage()));
	assert.equal(result.evidence.events, 6, "a snapshot is a copy: what the result carries cannot change after it was handed back");
	assert.equal(result.steers?.open, false, "the input is closed before the child is stopped");
	assert.deepEqual({ pushed: result.steers?.pushed, sent: result.steers?.sent, dropped: result.steers?.dropped }, { pushed: 1, sent: 1, dropped: 0 });
	assert.equal(Object.isFrozen(result.steers), true);
	assert.equal(result.exit.failure, undefined);
});

test("the leaf gates hold at both ends: where the session was said to be, and that it moved", async () => {
	const CONTINUED: Partial<PiPrepared> = { session: { ...SESSION, checkpoint: CHECKPOINT } };
	const FORKED: Partial<PiPrepared> = { session: { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT }, usage: baselineOf({ sessionId: FORK_ID, sessionFile: FORK_FILE }) };

	interface Row {
		what: string;
		before: unknown;
		after?: unknown;
		prepared: Partial<PiPrepared>;
	}

	// A new session stands at nothing or at one real entry; a continuation stands at the exact checkpoint it recorded.
	const start: Row[] = [
		{ what: "a new session with nothing in it", before: null, prepared: {} },
		{ what: "a new session with an entry behind it", before: "entry-1", prepared: {} },
		{ what: "a resume at its own checkpoint", before: CHECKPOINT, prepared: CONTINUED },
	];
	for (const row of start) {
		const { result, seen } = await runOnce({ before: row.before, prepared: row.prepared });
		assert.equal(done(result).session.checkpoint, LEAF, `${row.what}: the new leaf is the checkpoint this turn leaves`);
		assert.equal(seen.steps.includes("turn"), true, `${row.what}: the prompt went out`);
	}

	const forked = await runOnce({
		before: CHECKPOINT,
		prepared: FORKED,
		state: { sessionId: FORK_ID, sessionFile: FORK_FILE },
		stats: ok("get_session_stats", statsOf({ sessionId: FORK_ID, sessionFile: FORK_FILE })),
	});
	assert.deepEqual(done(forked.result).session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: LEAF }, "a fork's own identity, with the leaf its turn left");

	const refusedBefore: Row[] = [
		{ what: "a leaf that is not an entry at all", before: 42, prepared: {} },
		{ what: "a continuation standing somewhere else", before: "entry-9", prepared: CONTINUED },
		{ what: "a continuation standing at nothing", before: null, prepared: CONTINUED },
	];
	for (const row of refusedBefore) {
		const { result, seen } = await runOnce({ before: row.before, prepared: row.prepared });
		const stopped = refused(result);
		assert.equal(stopped.reason, "leaf", `${row.what}: the task refuses before the prompt`);
		assert.deepEqual(seen.steps, ["get_tree", "shutdown"], `${row.what}: nothing was prompted`);
		assert.deepEqual(seen.shutdowns, ["host"], `${row.what}: and the child was stopped once`);
		assert.deepEqual(stopped.session, row.prepared.session ?? SESSION, `${row.what}: the session it was prepared in, exactly as it was`);
		assert.equal(stopped.turn, undefined);
	}

	const refusedAfter: Row[] = [
		{ what: "a leaf that did not move", before: "entry-1", after: "entry-1", prepared: {} },
		{ what: "a session that still has no entry", before: null, after: null, prepared: {} },
		{ what: "a leaf that is not an entry", before: null, after: 7, prepared: {} },
	];
	for (const row of refusedAfter) {
		const { result, seen } = await runOnce({ before: row.before, after: row.after, prepared: row.prepared });
		const stopped = refused(result);
		assert.equal(stopped.reason, "leaf", `${row.what}: a turn whose session did not move is not one to record`);
		assert.equal(stopped.turn?.outcome, "settled", `${row.what}: the turn that ran is kept on the refusal`);
		assert.equal(seen.steps.includes("get_session_stats"), false, `${row.what}: nothing after the leaf is read`);
		assert.deepEqual(seen.shutdowns, ["host"]);
	}
});

test("the steer queue takes, holds, sends in order and accounts for every steer, and never retries one", async () => {
	// Held until a child is there, then sent one at a time and in the order they were pushed.
	const held = new PiSteerQueue();
	const gate = deferred<PiResponse>();
	const seen: string[] = [];
	const answers: Array<Promise<PiResponse> | PiResponse> = [gate.promise, ok("steer", {})];
	let live = 0;
	let overlapped = false;
	const sink: PiSteerSink = async (text) => {
		seen.push(text);
		live += 1;
		if (live > 1) overlapped = true;
		try {
			return await (answers.shift() ?? ok("steer", {}));
		} finally {
			live -= 1;
		}
	};
	assert.equal(held.push("first"), true);
	assert.equal(held.push("second"), true);
	await drain();
	assert.deepEqual(seen, [], "nothing goes anywhere before a child is attached");
	held.attach(sink);
	await drain();
	assert.deepEqual(seen, ["first"], "one at a time: the second waits on the first");
	assert.throws(() => held.attach(sink), TypeError, "a queue sends to one child, and a second attach is two runs on one queue");
	assert.throws(() => new PiSteerQueue().attach(undefined as unknown as PiSteerSink), TypeError, "and a sink that cannot be called is refused before a steer is handed to it");

	// Closed with one attempt in flight: what is still queued is dropped and counted, and the one in flight finishes.
	assert.equal(held.push("third"), true);
	held.end();
	assert.equal(held.open, false);
	assert.equal(held.push("fourth"), false, "a closed queue takes nothing");
	gate.resolve(ok("steer", {}));
	await held.idle();
	assert.deepEqual(seen, ["first"], "the ones still queued when it closed never went out");
	assert.equal(overlapped, false);
	const report = held.report();
	assert.deepEqual({ ...report }, { open: false, pushed: 3, sent: 1, rejected: 0, refused: 0, failed: 0, dropped: 2 }, "the push a closed queue would not take is answered false and counted nowhere");
	assert.equal(report.pushed, report.sent + report.rejected + report.refused + report.failed + report.dropped, "every steer taken in ends as exactly one of the five");
	assert.equal(Object.isFrozen(report), true);

	// A value that is not text at all, and a queue with no room left: both are answered to the caller and neither is a
	// delivery, so no counter moves for either.
	const full = new PiSteerQueue();
	assert.equal(full.push(7 as unknown as string), false, "a steer is text, and this check is a runtime one because a tool is what pushes");
	for (let at = 0; at < PI_STEER_QUEUE_MAX; at += 1) assert.equal(full.push(`steer ${at}`), true);
	assert.equal(full.push("one too many"), false);
	assert.deepEqual({ ...full.report() }, { open: true, pushed: PI_STEER_QUEUE_MAX, sent: 0, rejected: 0, refused: 0, failed: 0, dropped: 0 });
	full.end();
	assert.equal(full.report().dropped, PI_STEER_QUEUE_MAX, "everything still queued when it closed");

	// The three ways a delivery ends badly, each under its own code and none of them retried: the child saying no, the
	// transport declining to send at all, and anything else that threw.
	const refusal = new PiSteerQueue();
	const failures: Array<PiResponse | Thrown> = [no("steer", undefined), new Thrown(new PiTransportError(piFailure("closed"))), new Thrown(undefined), new Thrown(new PiTransportError(piFailure("protocol")))];
	const tries: string[] = [];
	refusal.attach(async (text) => {
		tries.push(text);
		const answer = failures.shift() ?? ok("steer", {});
		if (answer instanceof Thrown) throw answer.error;
		return answer;
	});
	refusal.push("one");
	await drain();
	assert.deepEqual({ ...refusal.report().lastFailure }, { code: "rejected", response: "the child refused this command" }, "the child had it and said no, with the error string it carried");
	assert.equal(refusal.report().rejected, 1);
	refusal.push("two");
	await drain();
	const declined = refusal.report().lastFailure ?? assert.fail("a failure was kept");
	assert.equal(declined.code, "refused", "a transport that would not send it at all is not the child refusing it");
	assert.equal(declined.failure?.kind, "closed", "the transport's own typed failure");
	assert.ok(declined.error instanceof PiTransportError, "and the error it threw, kept as it was");
	const earlier = refusal.report();
	refusal.push("three");
	await drain();
	const last = refusal.report().lastFailure ?? assert.fail("a failure was kept");
	assert.equal(last.code, "failed");
	assert.equal("error" in last, true, "presence is what says a value was thrown");
	assert.equal(last.error, undefined);
	assert.equal(last.failure, undefined, "there is no typed failure behind a value this host cannot read");
	refusal.push("four");
	await drain();
	assert.equal(refusal.report().lastFailure?.code, "failed", "a typed failure of another kind is a delivery that broke, not one declined");
	assert.equal(refusal.report().lastFailure?.failure?.kind, "protocol");
	assert.deepEqual(tries, ["one", "two", "three", "four"], "one attempt each: a steer that did not arrive is not sent again");
	const account = refusal.report();
	assert.deepEqual({ pushed: account.pushed, sent: account.sent, rejected: account.rejected, refused: account.refused, failed: account.failed, dropped: account.dropped }, { pushed: 4, sent: 0, rejected: 1, refused: 1, failed: 2, dropped: 0 });
	assert.equal(earlier.lastFailure?.code, "refused", "and an earlier report is a snapshot, unchanged by what came after it");
});

test("a settled turn is refused for what its own records say: the model, the answer, the stream and either extension error", async () => {
	const error = "e".repeat(PI_TASK_ERROR_MAX_CHARS + 10);
	const rows: Array<{ what: string; reason: PiTaskReason; state?: Record<string, unknown>; events?: PiEvent[]; turn?: PiTurn }> = [
		{ what: "another session id", reason: "state", state: { sessionId: "pi-session-other" } },
		{ what: "another session file", reason: "state", state: { sessionFile: "/sessions/other.jsonl" } },
		{ what: "another model", reason: "state", state: { model: { id: "deepseek-reasoner", provider: "deepseek" } } },
		{ what: "another provider", reason: "state", state: { model: { id: "deepseek-chat", provider: "openrouter" } } },
		{ what: "another thinking level", reason: "state", state: { thinkingLevel: "high" } },
		{ what: "no assistant message at all", reason: "failed", events: [{ type: "agent_start" }] },
		{ what: "an answer that stopped for another reason", reason: "failed", events: [messageEnd(assistantMessage({ stopReason: "toolUse" }))] },
		{ what: "an answer that ended in an error", reason: "failed", events: [messageEnd(assistantMessage({ stopReason: "error", errorMessage: error }))] },
		{ what: "a stream this host saw less of than the turn counted", reason: "unobserved", turn: turnOf({ events: 9 }) },
		{ what: "an extension error the turn counted", reason: "extension", turn: turnOf({ events: 1, extensionErrors: 1, lastExtensionError: EXTENSION_ERROR }) },
		{ what: "an extension error this host was handed", reason: "extension", events: [messageEnd(assistantMessage()), { type: "extension_error", error: "an extension threw" }] },
	];
	for (const row of rows) {
		const { result, seen } = await runOnce({
			...(row.state === undefined ? {} : { state: row.state }),
			...(row.events === undefined ? {} : { events: row.events }),
			...(row.turn === undefined ? {} : { turn: row.turn }),
		});
		const stopped = refused(result);
		assert.equal(stopped.reason, row.reason, row.what);
		assert.equal(stopped.turn?.outcome, "settled", `${row.what}: the turn that ran comes back with the refusal`);
		assert.deepEqual(stopped.session, SESSION, `${row.what}: the prepared session, with no checkpoint added to it`);
		assert.deepEqual(seen.shutdowns, ["host"], `${row.what}: one stop`);
		assert.equal(seen.steps.includes("get_session_stats"), false, `${row.what}: nothing further is read off a turn this host cannot trust`);
		assert.equal(Object.isFrozen(stopped.evidence), true);
	}

	const failed = await runOnce({ events: [messageEnd(assistantMessage({ stopReason: "error", errorMessage: error }))] });
	const kept = refused(failed.result).evidence.last ?? assert.fail("the answer that failed is still evidence");
	assert.equal(kept.errorMessage?.length, PI_TASK_ERROR_MAX_CHARS);
	assert.deepEqual(kept.cut, { text: false, errorMessage: true });

	// The turn's own last extension error travels with the refusal it caused; the one this host was handed alone does
	// not invent one, because the bounded record is the transport's to make.
	const fromTurn = await runOnce({ turn: turnOf({ events: 1, extensionErrors: 1, lastExtensionError: EXTENSION_ERROR }) });
	assert.equal(refused(fromTurn.result).extensionError, EXTENSION_ERROR);
	const fromStream = await runOnce({ events: [messageEnd(assistantMessage()), { type: "extension_error", error: "an extension threw" }] });
	assert.equal(refused(fromStream.result).extensionError, undefined);

	// The answer check is the last assistant message and not a count of them: a turn whose only record of its answer is
	// the `agent_end` that repeated it has an `assistantMessages` of zero and still succeeds.
	const fallback = await runOnce({ events: [{ type: "agent_end", messages: [assistantMessage()], willRetry: false }] });
	const late = done(fallback.result);
	assert.equal(late.evidence.assistantMessages, 0, "nothing counted it, because `message_end` is the one place that counts");
	assert.equal(late.evidence.last?.from, "agent_end");
	assert.equal(late.session.checkpoint, LEAF);

	// Records that arrived before the prompt are not this turn's: the mark is taken with no await before `turn()`, so a
	// turn that counted records this host never saw is unobserved however busy the stream had been before it.
	const early = await runOnce({ early: [{ type: "agent_start" }, { type: "turn_start" }, { type: "queue_update" }], turn: turnOf({ events: 3 }) });
	const missed = refused(early.result);
	assert.equal(missed.reason, "unobserved", "three records before the prompt do not stand in for three of this turn's");
	assert.equal(missed.evidence.events, 4, "and all four are still there to look at");

	// Nor can a record that lands while the steer in flight finishes: the evidence is frozen when the input closes.
	const observer = taskObserver();
	const gate = deferred<PiTurn>();
	const steering = deferred<PiResponse>();
	const latecomer = childOf({
		requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })], steer: [steering.promise] },
		turn: gate.promise,
	});
	const queue = new PiSteerQueue();
	const running = runPiTask({ prepared: preparedOf(latecomer.child), prompt: PROMPT, observer, input: queue });
	await drain();
	queue.push("in flight");
	await drain();
	observer.onEvent(messageEnd(assistantMessage()));
	gate.resolve(turnOf({ events: 2 }));
	await drain();
	observer.onEvent({ type: "tool_execution_start", toolName: "bash" });
	steering.resolve(ok("steer", {}));
	const masked = refused(await running);
	assert.equal(masked.reason, "unobserved", "one record of the turn, and the one that came after it is not a second");
	assert.equal(masked.evidence.events, 1, "the evidence is what it was when the input closed");
	assert.deepEqual(latecomer.seen.shutdowns, ["host"]);
});

test("a turn that did not settle ends the task, whichever way it ended, and so does a child that had already gone", async () => {
	// One name per end, and no two of them collapsed into one: what ended a turn is what the refusal is called.
	const ends: Array<{ outcome: PiTurn["outcome"]; reason: PiTaskReason; stop: "host" | "aborted" }> = [
		{ outcome: "rejected", reason: "rejected", stop: "host" },
		{ outcome: "failed", reason: "turn", stop: "host" },
		{ outcome: "aborted", reason: "aborted", stop: "aborted" },
		{ outcome: "exited", reason: "exited", stop: "host" },
		{ outcome: "acknowledged", reason: "turn", stop: "host" },
	];
	for (const end of ends) {
		const { result, seen } = await runOnce({ turn: turnOf({ outcome: end.outcome, events: 1, ack: ok("prompt", undefined) }) });
		const stopped = refused(result);
		assert.equal(stopped.reason, end.reason, `a turn that ${end.outcome}`);
		assert.equal(stopped.turn?.outcome, end.outcome, "kept as it came, so what ended it is readable");
		assert.equal(stopped.turn?.ack?.command, "prompt", "with the acknowledgement it came back with, where it had one");
		assert.deepEqual(seen.steps, ["get_tree", "turn", "shutdown"], "nothing is read back off a turn that did not settle");
		assert.deepEqual(seen.shutdowns, [end.stop], "and the stop is asked for under the reason this task decided");
	}

	// A turn that failed with a typed failure keeps it where a reader looks for one.
	const broke = await runOnce({ turn: turnOf({ outcome: "failed", events: 1, failure: piFailure("timeout", { stage: "turn" }) }) });
	assert.equal(refused(broke.result).failure?.kind, "timeout");

	// A turn that threw rather than ended: two of the transport's kinds are ends this task has its own name for.
	const rows: Array<{ what: string; thrown: unknown; reason: PiTaskReason; stop: "host" | "aborted"; kind?: string }> = [
		{ what: "a cancellation", thrown: new PiTransportError(piFailure("aborted")), reason: "aborted", stop: "aborted", kind: "aborted" },
		{ what: "a child that had gone", thrown: new PiTransportError(piFailure("exited")), reason: "exited", stop: "host", kind: "exited" },
		{ what: "a failure of any other kind", thrown: new PiTransportError(piFailure("protocol")), reason: "transport", stop: "host", kind: "protocol" },
	];
	for (const row of rows) {
		const { result, seen } = await runOnce({ turn: new Thrown(row.thrown) });
		const stopped = refused(result);
		assert.equal(stopped.reason, row.reason, row.what);
		assert.equal(stopped.failure?.kind, row.kind, `${row.what}: with its own typed failure kept`);
		assert.equal(stopped.error, row.thrown);
		assert.deepEqual(seen.shutdowns, [row.stop], `${row.what}: and the stop asked for under this task's reason`);
	}

	const threw = await runOnce({ turn: new Thrown(undefined) });
	const nameless = refused(threw.result);
	assert.equal(nameless.reason, "transport");
	assert.equal("error" in nameless, true, "presence is what says a failure had a value");
	assert.equal(nameless.error, undefined);
	assert.equal(nameless.failure, undefined);
	assert.deepEqual(threw.seen.shutdowns, ["host"]);

	// A child that finished before this task sent it anything: the observation is registered first, and one microtask
	// turn is spent before the first request so an end that had already landed is read as one.
	const scripted = childOf({});
	scripted.settleExit(exitOf());
	const gone = refused(await runPiTask({ prepared: preparedOf(scripted.child), prompt: PROMPT, observer: taskObserver() }));
	assert.equal(gone.reason, "exited");
	assert.deepEqual(scripted.seen.steps, ["shutdown"], "nothing is asked of a child that has gone");
	assert.deepEqual(scripted.seen.shutdowns, ["host"]);
});

test("a question nobody could answer ends the turn through the one shutdown, and nothing is settled twice", async () => {
	const questions = watchOf();
	const gate = deferred<PiTurn>();
	const steering = deferred<PiResponse>();
	const scripted = childOf({
		requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })], steer: [steering.promise] },
		turn: gate.promise,
		// The stop is what ends a turn whose child is waiting on a dialog that will never be answered, and the steer in
		// flight is released with it: both are awaited before this task returns.
		exit: () => {
			gate.resolve(turnOf({ outcome: "exited", events: 2 }));
			steering.resolve(ok("steer", {}));
			return exitOf();
		},
	});
	const queue = new PiSteerQueue();
	const prepared = preparedOf(scripted.child, { questions: questions.watch });
	const running = runPiTask({ prepared, prompt: PROMPT, observer: taskObserver(), input: queue });
	await drain();
	queue.push("and this too");
	queue.push("never sent");
	await drain();
	questions.fail(FATAL);
	const stopped = refused(await running);

	assert.equal(stopped.reason, "question");
	assert.equal(stopped.outcome, FATAL, "the outcome the watch kept, exactly as it was");
	assert.equal(stopped.turn?.outcome, "exited", "and the turn the stop ended, because both are awaited before this returns");
	assert.deepEqual(scripted.seen.steps, ["get_tree", "turn", "steer", "shutdown"], "no readback is taken off a child that was stopped mid-turn");
	assert.deepEqual(scripted.seen.shutdowns, ["host"], "exactly one stop on this path");
	assert.deepEqual(stopped.session, SESSION, "the prepared session, with no checkpoint added to it");
	assert.equal(stopped.exit?.cleanup.root, "exited");
	assert.deepEqual({ open: stopped.steers?.open, sent: stopped.steers?.sent, dropped: stopped.steers?.dropped }, { open: false, sent: 1, dropped: 1 }, "the input is closed first, the one in flight is waited for, and the rest are dropped");

	// The same path with a shutdown that threw a value with no reading at all.
	const second = watchOf();
	const turning = deferred<PiTurn>();
	const broken = childOf({
		requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })] },
		turn: turning.promise,
		exit: () => {
			turning.resolve(turnOf({ outcome: "exited" }));
			throw 0;
		},
	});
	const brokenRun = runPiTask({ prepared: preparedOf(broken.child, { questions: second.watch }), prompt: PROMPT, observer: taskObserver() });
	await drain();
	second.fail(FATAL);
	const unverified = refused(await brokenRun);
	assert.equal(unverified.reason, "question", "what ended the task is still the question");
	assert.equal(unverified.unverified, true);
	assert.equal(unverified.shutdownError, 0, "the value the shutdown threw, kept as it was");
	assert.equal(unverified.exit, undefined, "and no exit guessed for it");
	assert.equal(unverified.turn?.outcome, "exited");
	assert.deepEqual(broken.seen.shutdowns, ["host"], "still one stop");

	// A question that had already failed before the task began: the gate reads it before anything is sent.
	const early = watchOf();
	early.fail(FATAL);
	const never = childOf({});
	const first = refused(await runPiTask({ prepared: preparedOf(never.child, { questions: early.watch }), prompt: PROMPT, observer: taskObserver() }));
	assert.equal(first.reason, "question");
	assert.deepEqual(never.seen.steps, ["shutdown"]);
});

test("a cancelled run stops where it is, under its own reason, and waits for the steer already in flight", async () => {
	const already = new AbortController();
	already.abort();
	const untouched = childOf({});
	const first = refused(await runPiTask({ prepared: preparedOf(untouched.child), prompt: PROMPT, observer: taskObserver(), signal: already.signal }));
	assert.equal(first.reason, "aborted");
	assert.deepEqual(untouched.seen.steps, ["shutdown"], "nothing is asked of the child at all");
	assert.deepEqual(untouched.seen.shutdowns, ["aborted"], "and the stop is asked for as the cancellation it was");

	// Cancelled while the turn was running: the gate right after the turn reads the signal before the turn's own
	// outcome, the steer in flight is waited for, and the ones still queued are dropped.
	const stopping = new AbortController();
	const gate = deferred<PiTurn>();
	const steering = deferred<PiResponse>();
	const scripted = childOf({
		requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })], steer: [steering.promise] },
		turn: gate.promise,
	});
	const queue = new PiSteerQueue();
	const observer = taskObserver();
	const running = runPiTask({ prepared: preparedOf(scripted.child), prompt: PROMPT, observer, input: queue, signal: stopping.signal });
	await drain();
	queue.push("in flight");
	queue.push("still queued");
	queue.push("also queued");
	await drain();
	stopping.abort();
	observer.onEvent(messageEnd(assistantMessage()));
	gate.resolve(turnOf({ events: 1 }));
	steering.resolve(ok("steer", {}));
	const stopped = refused(await running);

	assert.equal(stopped.reason, "aborted", "a run that was cancelled is cancelled, whatever the turn then reported");
	assert.equal(stopped.turn?.outcome, "settled", "the turn that came back anyway is still evidence");
	assert.deepEqual(scripted.seen.steps, ["get_tree", "turn", "steer", "shutdown"], "no readback is taken, and the stop is the last thing asked for");
	assert.deepEqual(scripted.seen.shutdowns, ["aborted"]);
	assert.deepEqual({ sent: stopped.steers?.sent, dropped: stopped.steers?.dropped, open: stopped.steers?.open }, { sent: 1, dropped: 2, open: false });
	assert.equal(stopped.evidence.assistantMessages, 1, "what the stream produced is still evidence of what happened");

	// Cancelled between two readbacks: the gate after each call is what reads it.
	const later = new AbortController();
	const answering = deferred<PiResponse>();
	const readback = taskObserver();
	const between = childOf({
		requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })], get_state: [answering.promise] },
		turn: () => {
			readback.onEvent(messageEnd(assistantMessage()));
			return turnOf({ events: 1 });
		},
	});
	const running2 = runPiTask({ prepared: preparedOf(between.child), prompt: PROMPT, observer: readback, signal: later.signal });
	await drain();
	assert.deepEqual(between.seen.steps, ["get_tree", "turn", "get_state"], "the state request is out and waiting");
	later.abort();
	answering.resolve(ok("get_state", stateOf()));
	const midway = refused(await running2);
	assert.equal(midway.reason, "aborted");
	assert.deepEqual(between.seen.steps, ["get_tree", "turn", "get_state", "shutdown"], "the answer that arrived after the cancellation is not read");
	assert.deepEqual(between.seen.shutdowns, ["aborted"]);
});

/*
 * The two ends can land together: a host cancels a run while a dialog of it is open, and the fatal question is what
 * wins the turn's own race. What ended the run is then the cancellation and not the dialog, read off the run's signal
 * alone, because a dialog that could not be answered on a run that was already cancelled is downstream of it. The
 * outcome is kept either way as the evidence of what became of that dialog, and the two rows below are the two shapes
 * it can have: one the cancellation itself ended, and one whose ask failed on its own while the run was cancelled.
 */
test("a run cancelled while a question is pending ends as cancellation, with the dialog's own outcome kept as evidence", async () => {
	const rows: Array<{ what: string; outcome: PiQuestionOutcome }> = [
		{ what: "a dialog the cancellation itself ended", outcome: { id: "dialog-9", question: "which name?", end: "aborted" } },
		{ what: "an ask that failed on its own", outcome: FATAL },
	];
	for (const row of rows) {
		const questions = watchOf();
		const cancelling = new AbortController();
		const gate = deferred<PiTurn>();
		const steering = deferred<PiResponse>();
		const observer = taskObserver();
		const scripted = childOf({
			requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })], steer: [steering.promise] },
			turn: gate.promise,
			// As on the question path it is the stop that ends this turn, and the steer in flight is released with it.
			exit: () => {
				gate.resolve(turnOf({ outcome: "aborted", events: 1 }));
				steering.resolve(ok("steer", {}));
				return exitOf();
			},
		});
		const queue = new PiSteerQueue();
		const running = runPiTask({ prepared: preparedOf(scripted.child, { questions: questions.watch }), prompt: PROMPT, observer, input: queue, signal: cancelling.signal });
		await drain();
		queue.push("in flight");
		queue.push("never sent");
		await drain();
		observer.onEvent(messageEnd(assistantMessage()));
		// The cancellation first and the dialog's end after it, which is the order a router that ends its dialogs on the
		// run's signal produces. No gate sits between the race and this branch, so the signal is read where it is read.
		cancelling.abort();
		questions.fail(row.outcome);
		const stopped = refused(await running);

		assert.equal(stopped.reason, "aborted", `${row.what} is cancellation on a run that was cancelled`);
		assert.equal(stopped.outcome, row.outcome, "and the outcome the watch kept travels on it, exactly as it was");
		assert.deepEqual(scripted.seen.shutdowns, ["aborted"], "one stop, asked for as the cancellation it was");
		assert.deepEqual(scripted.seen.steps, ["get_tree", "turn", "steer", "shutdown"], "no readback is taken off a child stopped mid-turn");
		assert.equal(stopped.turn?.outcome, "aborted", "the turn the stop ended is still awaited and still evidence");
		assert.deepEqual({ open: stopped.steers?.open, sent: stopped.steers?.sent, dropped: stopped.steers?.dropped }, { open: false, sent: 1, dropped: 1 }, "the input was closed before the stop, the one in flight waited for and the rest dropped");
		assert.equal(Object.isFrozen(stopped.evidence), true, "the evidence is the observer's own frozen snapshot");
		assert.equal(stopped.evidence.assistantMessages, 1, "and what the stream produced is still counted in it");
		assert.deepEqual(stopped.session, SESSION, "the prepared session, with no checkpoint added to it");
	}
});

/*
 * The other way round, and the gate's own: the turn wins its race on its own, so nothing of the question is read
 * there — and by the time the gate after that turn runs, the signal has gone and a dialog of this run has already
 * failed. That gate is a cancellation like any other, and it carries the outcome that was already recorded for the
 * same reason the race's own branch does: a run cancelled over a dialog nobody could answer should not lose what
 * became of that dialog just because the turn came back first. The evidence stays the snapshot taken before the wait
 * for the steer in flight, so what arrives during that wait is not in it.
 */
test("a cancellation the gate after the turn reads carries a question outcome already recorded, and the frozen evidence", async () => {
	const questions = watchOf();
	const cancelling = new AbortController();
	const gate = deferred<PiTurn>();
	const steering = deferred<PiResponse>();
	const observer = taskObserver();
	const scripted = childOf({
		requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })], steer: [steering.promise] },
		turn: gate.promise,
	});
	const queue = new PiSteerQueue();
	const running = runPiTask({ prepared: preparedOf(scripted.child, { questions: questions.watch }), prompt: PROMPT, observer, input: queue, signal: cancelling.signal });
	await drain();
	queue.push("in flight");
	queue.push("never sent");
	await drain();
	// The turn's own record, and then the turn itself, ending as the child's own abort: the question has not failed yet,
	// so the race is won by the turn and the branch that reads a question is never entered.
	observer.onEvent(messageEnd(assistantMessage()));
	gate.resolve(turnOf({ outcome: "aborted", events: 1 }));
	await drain();
	assert.deepEqual(scripted.seen.steps, ["get_tree", "turn", "steer"], "the turn is over and the task is waiting on the steer in flight");

	// Both land in that wait: the evidence is already frozen, and the gate past it is what reads either of them.
	cancelling.abort();
	questions.fail(FATAL);
	observer.onEvent(messageEnd(assistantMessage()));
	steering.resolve(ok("steer", {}));
	const stopped = refused(await running);

	assert.equal(stopped.reason, "aborted", "the gate reads the cancellation first, as it always has");
	assert.equal(stopped.outcome, FATAL, "and carries the outcome the watch had already recorded, exactly as it was");
	assert.deepEqual(scripted.seen.shutdowns, ["aborted"], "one stop, asked for as the cancellation it was");
	assert.deepEqual(scripted.seen.steps, ["get_tree", "turn", "steer", "shutdown"], "no readback is taken past that gate");
	assert.equal(stopped.turn?.outcome, "aborted", "the turn that came back is still evidence of what happened");
	assert.deepEqual({ open: stopped.steers?.open, sent: stopped.steers?.sent, dropped: stopped.steers?.dropped }, { open: false, sent: 1, dropped: 1 }, "the input was closed before the stop, the one in flight waited for and the rest dropped");
	assert.equal(Object.isFrozen(stopped.evidence), true, "the evidence is a frozen snapshot");
	assert.equal(stopped.evidence.assistantMessages, 1, "frozen before the wait: the record that arrived during it is not one of this turn's");
	assert.deepEqual(stopped.session, SESSION, "the prepared session, with no checkpoint added to it");
});

test("the statistics, the text and the stop are each read strictly, and a cleanup that failed publishes nothing", async () => {
	const rows: Array<{ what: string; reason: PiTaskReason; stats?: Answer; text?: Answer; state?: Record<string, unknown> }> = [
		{ what: "a failed statistics answer", reason: "usage", stats: no("get_session_stats", statsOf()) },
		{ what: "statistics of another session", reason: "usage", stats: ok("get_session_stats", statsOf({ sessionId: FORK_ID })) },
		{ what: "a token count that is text", reason: "usage", stats: ok("get_session_stats", statsOf({ tokens: { input: "300", output: 60, cacheRead: 10, cacheWrite: 5, total: 375 } })) },
		{ what: "a count that went backwards", reason: "usage", stats: ok("get_session_stats", statsOf({ assistantMessages: 0 })) },
		{ what: "a cost that went backwards", reason: "usage", stats: ok("get_session_stats", statsOf({ cost: 0.1 })) },
		{ what: "a last text that is neither text nor nothing", reason: "text", text: ok("get_last_assistant_text", { text: 42 }) },
		{ what: "a failed text answer", reason: "text", text: no("get_last_assistant_text", { text: "done" }) },
		{ what: "a state that is still streaming", reason: "state", state: { isStreaming: true } },
		{ what: "a state that is compacting", reason: "state", state: { isCompacting: true } },
	];
	for (const row of rows) {
		const { result, seen } = await runOnce({
			...(row.stats === undefined ? {} : { stats: row.stats }),
			...(row.text === undefined ? {} : { text: row.text }),
			...(row.state === undefined ? {} : { state: row.state }),
		});
		const stopped = refused(result);
		assert.equal(stopped.reason, row.reason, row.what);
		assert.deepEqual(stopped.session, SESSION, `${row.what}: the prepared session and no checkpoint`);
		assert.equal(stopped.leaf, undefined, `${row.what}: a leaf is reported for a failed cleanup alone`);
		assert.deepEqual(seen.shutdowns, ["host"], `${row.what}: one stop`);
	}

	// A `null` text is an answer like any other: the child has no assistant text to name, and that is not a failure.
	assert.equal(done((await runOnce({ text: ok("get_last_assistant_text", { text: null }) })).result).text, null);

	// The work read back whole and the stop then reported a failure of its own: nothing here is publishable.
	const unstoppable = await runOnce({ exit: exitOf({ failure: piFailure("unstoppable"), stoppedByUs: true }) });
	const dirty = refused(unstoppable.result);
	assert.equal(dirty.reason, "cleanup");
	assert.deepEqual(dirty.session, SESSION, "the old session, because a run whose child would not go is not one to continue from");
	assert.equal(dirty.leaf, LEAF, "the leaf it reached, as evidence a person may look at and not as a checkpoint");
	assert.equal(dirty.exit?.failure?.kind, "unstoppable", "and the whole exit, kept as it came");
	assert.equal(dirty.turn?.outcome, "settled");
	assert.deepEqual(unstoppable.seen.shutdowns, ["host"], "one stop on the success path too");

	const threw = await runOnce({ exit: new Thrown(0) });
	const unverified = refused(threw.result);
	assert.equal(unverified.reason, "cleanup");
	assert.equal(unverified.unverified, true);
	assert.equal(unverified.shutdownError, 0);
	assert.equal(unverified.exit, undefined, "no exit is invented for a stop that produced no report");
	assert.equal(unverified.leaf, LEAF);

	// A readback that threw a value with no reading at all, with the one stop after it.
	const broken = await runOnce({ stats: new Thrown(undefined) });
	const nameless = refused(broken.result);
	assert.equal(nameless.reason, "transport");
	assert.equal("error" in nameless, true);
	assert.equal(nameless.error, undefined);
	assert.equal(nameless.turn?.outcome, "settled", "the turn that had already run is kept");
	assert.deepEqual(broken.seen.shutdowns, ["host"]);

	// The observer is the caller's own object, and one that cannot be begun or read is this task's to refuse: the value
	// it threw is kept by presence, an empty tally stands in for what could not be read, and the child is stopped once.
	const unbeginnable = childOf({});
	const begun = refused(
		await runPiTask({
			prepared: preparedOf(unbeginnable.child),
			prompt: PROMPT,
			observer: {
				begin: () => {
					throw undefined;
				},
				onEvent: () => {},
				snapshot: () => noEvidence(),
			},
		}),
	);
	assert.equal(begun.reason, "transport");
	assert.equal("error" in begun, true, "presence is what says a failure had a value");
	assert.equal(begun.error, undefined);
	assert.deepEqual(unbeginnable.seen.steps, ["shutdown"], "nothing was asked of the child, and it was stopped once");

	const unreadable = childOf({ requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })] } });
	const boom = new Error("this observer cannot be read");
	const read = refused(
		await runPiTask({
			prepared: preparedOf(unreadable.child),
			prompt: PROMPT,
			observer: {
				begin: () => {},
				onEvent: () => {},
				snapshot: () => {
					throw boom;
				},
			},
		}),
	);
	assert.equal(read.reason, "transport");
	assert.equal(read.error, boom, "the value it threw, kept as it was");
	assert.deepEqual(unreadable.seen.steps, ["get_tree", "shutdown"], "the mark is read before the prompt, so nothing was prompted");
	assert.equal(read.evidence.events, 0, "and an empty tally stands in for the reading that faulted");
	assert.equal(Object.isFrozen(read.evidence), true);

	// An observer that only fails once the turn is over: the mark is read, the prompt goes out, and the reading taken
	// when the input closes faults. The task refuses under the reason a foreign value gets, and the turn that had
	// already come back is still on the refusal — a fault after the work is not a reason to report less than there was.
	const afterwards = childOf({ requests: { get_tree: [ok("get_tree", { tree: [], leafId: null })] }, turn: turnOf({ events: 1 }) });
	const late = new Error("this observer stopped answering");
	let readings = 0;
	const lateRead = refused(
		await runPiTask({
			prepared: preparedOf(afterwards.child),
			prompt: PROMPT,
			observer: {
				begin: () => {},
				onEvent: () => {},
				snapshot: () => {
					readings += 1;
					if (readings === 1) return noEvidence();
					throw late;
				},
			},
		}),
	);
	assert.equal(lateRead.reason, "transport");
	assert.equal(lateRead.error, late, "the value the second reading threw, kept exactly");
	assert.equal(lateRead.turn?.outcome, "settled", "the turn that had already come back is kept on the refusal");
	assert.deepEqual(afterwards.seen.steps, ["get_tree", "turn", "shutdown"], "no readback is taken off a turn this host can no longer account for");
	assert.deepEqual(afterwards.seen.shutdowns, ["host"], "and the child is stopped exactly once");
});
