import assert from "node:assert/strict";
import test from "node:test";
import type { PiRole } from "../extensions/backends/pi-binding.ts";
import {
	boundedInput,
	CLEANUP_ATTENTION,
	CLEANUP_UNCERTAIN,
	diagnose,
	DISPOSE_FAILED,
	DISPOSE_WARNING,
	disposition,
	exitConcerns,
	finishRun,
	newRun,
	PI_ACTIVITY_CHARS,
	PI_EVENT_FIELD_MAX_CHARS,
	PI_EVENT_INPUT_MAX_KEYS,
	PI_EVENT_KEY_MAX_CHARS,
	PI_EVENT_TEXT_MAX_CHARS,
	PI_UNTRUSTED_SESSION,
	type PiConcern,
	type PiDisposal,
	type PiEnded,
	type PiRun,
	piSession,
	progressMapper,
	resultText,
	RUN_CANCELLED,
	RUN_UNVERIFIED,
	STORAGE_LEFT,
} from "../extensions/backends/pi-outcome.ts";
import type { PiPrepareReason, PiPrepareRefused, PiUsageBaseline } from "../extensions/backends/pi-prepare.ts";
import type { PiQuestionOutcome } from "../extensions/backends/pi-question-routing.ts";
import type { PiRestoreReason, PiRestoreRefused } from "../extensions/backends/pi-session-restore.ts";
import type { PiTaskDone, PiTaskEvidence, PiTaskReason, PiTaskRefused, PiUsageDelta } from "../extensions/backends/pi-task.ts";
import type { PiEvent, PiExit, PiTurn } from "../extensions/backends/pi-transport.ts";
import { type ChildEvent, failed, type PiSessionRef, type ResolvedSelection, type SessionIntent } from "../extensions/backends/types.ts";
import { failureMessage, recordDecision } from "../extensions/fusion.ts";

/*
 * What this host decides once a Pi call has ended, driven against object literals and nothing else: every exit
 * report, refusal, task result and streamed record below was typed out in this file. No case starts a process,
 * speaks a protocol, opens a session, touches storage or imports an SDK, and nothing here constructs a backend,
 * because none is registered yet. So what is measured is the mapping itself — which session a request becomes,
 * which concerns an ending left, what a person is told, what the record layer is handed and what a monitor sees —
 * and nothing at all about how a real Pi child ends, cleans up or streams.
 *
 * Two functions are imported from the host, for one thing each and with no run lifecycle behind either:
 * `recordDecision`, for what the record layer does with a run this mapping produced, and `failureMessage`, for what
 * a person is actually shown for one, which for a cancelled run is its activity line and nothing else.
 */

const SESSION_ID = "pi-session-1";
const SESSION_FILE = "/sessions/pi-session-1.jsonl";
const FORK_ID = "pi-session-2";
const FORK_FILE = "/sessions/pi-session-2.jsonl";
const CHECKPOINT = "entry-42";
const LEAF = "entry-77";
const MODEL = "deepseek/deepseek-chat";

const SESSION: PiSessionRef = { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE };
const FORKED: PiSessionRef = { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT };
const SOURCE: PiSessionRef = { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: CHECKPOINT };
const SELECTION: ResolvedSelection = { model: MODEL, effort: "medium" };

const ROLE: PiRole = { name: "implement", model: MODEL, effort: "medium", contract: "implement.md", tools: ["read", "bash"], extensions: [], skills: [] };

/** Markers planted in every field a diagnostic may never repeat, so a leak reads as the field it came from. */
const SECRETS = {
	error: "SECRET-thrown-value",
	shutdown: "SECRET-shutdown-error",
	question: "SECRET-question-text",
	resolved: "SECRET-answer-text",
	extension: "SECRET-extension-error",
	steer: "SECRET-steer-response",
	stderr: "SECRET-stderr-tail",
	path: "SECRET-session-path",
};

const noSecrets = (message: string, where: string): void => {
	for (const [field, marker] of Object.entries(SECRETS)) assert.ok(!message.includes(marker), `${where} must not repeat the ${field} it kept: ${message}`);
};

const processOf = (pid: number) => ({ pid, ppid: 1, pgid: pid, state: "S", started: "1000" });

const CLEANUP: PiExit["cleanup"] = { root: "exited", exit: { code: 0, signal: null }, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false };
const COUNTERS: PiExit["counters"] = { straySettles: 0, earlySettles: 0, lateResponses: 0, extensionErrors: 0, uiCancelledByTransport: 0, unknownUiMethods: 0, listenerErrors: 0, droppedFrames: 0, streamsUnclosed: 0 };

/** One exit report, in the shape the transport writes one. Nothing ran: it is a literal, like everything here. */
const exitOf = (over: Partial<PiExit> = {}): PiExit => ({
	exit: { code: 0, signal: null },
	cleanup: { ...CLEANUP },
	stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: SECRETS.stderr, dropped: 0 },
	stoppedByUs: true,
	counters: { ...COUNTERS },
	...over,
});

const exitWithCleanup = (over: Partial<PiExit["cleanup"]>, rest: Partial<PiExit> = {}): PiExit => exitOf({ cleanup: { ...CLEANUP, ...over }, ...rest });

const turnOf = (): PiTurn => ({ outcome: "settled", earlySettles: 0, extensionErrors: 0, events: 6 });

const evidenceOf = (over: Partial<PiTaskEvidence> = {}): PiTaskEvidence => ({ events: 6, assistantMessages: 1, agentEnds: 1, toolStarts: 1, toolErrors: 0, compactions: 0, autoRetries: 0, extensionErrors: 0, ...over });

const BASELINE: PiUsageBaseline = {
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 2,
	cost: 0.25,
	tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
};

const afterOf = (over: Partial<PiUsageBaseline> = {}): PiUsageBaseline => ({
	...BASELINE,
	userMessages: 2,
	assistantMessages: 3,
	toolCalls: 1,
	toolResults: 1,
	totalMessages: 6,
	cost: 0.75,
	tokens: { input: 300, output: 60, cacheRead: 10, cacheWrite: 5, total: 375 },
	contextUsage: { tokens: 1_200, contextWindow: 64_000, percent: 1.9 },
	...over,
});

const DELTA: PiUsageDelta = { userMessages: 1, assistantMessages: 2, toolCalls: 1, toolResults: 1, totalMessages: 4, cost: 0.5, tokens: { input: 200, output: 40, cacheRead: 10, cacheWrite: 5, total: 255 } };

const doneOf = (over: Partial<PiTaskDone> = {}): PiTaskDone => ({
	ok: true,
	session: { ...SESSION, checkpoint: LEAF },
	selection: SELECTION,
	usage: { before: BASELINE, after: afterOf(), delta: DELTA },
	text: "## Changed\nfoo.ts",
	turn: turnOf(),
	evidence: evidenceOf(),
	exit: exitOf(),
	...over,
});

const refusedTaskOf = (over: Partial<PiTaskRefused> = {}): PiTaskRefused => ({
	ok: false,
	reason: "failed",
	session: { ...SESSION },
	selection: SELECTION,
	evidence: evidenceOf(),
	exit: exitOf(),
	...over,
});

const OUTCOME: PiQuestionOutcome = { id: "ui-1", question: SECRETS.question, end: "failed", error: SECRETS.error, resolved: SECRETS.resolved };

const SAFE = { attempted: true, failed: false };
const LEFT_BEHIND = { attempted: true, failed: true };
/** The third storage report: a removal nobody tried, which is what a caller makes of an ending it will not remove one under. */
const RETAINED: PiDisposal = { attempted: false, failed: false, retained: true };

/** An ending that happened, which is the only kind `diagnose` takes: a run that never started is `finishRun`'s own. */
type Ended = Exclude<PiEnded, { kind: "none" }>;

/** One ending's own disposition, so no case can hand `finishRun` a disposition its ending did not produce. */
const finishedOf = (ended: PiEnded, disposal: PiDisposal = SAFE, ms = 1_234): PiRun => finishRun(newRun(ROLE), ended, disposition(ended), disposal, ms);

/** What the record layer reads off a finished run, in the shape `recordDecision` takes one. */
const outcomeOf = (run: PiRun) => ({
	ok: !failed(run),
	...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
	...(run.session === undefined ? {} : { session: run.session }),
	...(run.selection === undefined ? {} : { selection: run.selection }),
	...(run.contextTokens === undefined ? {} : { contextTokens: run.contextTokens }),
	...(run.contextWindow === undefined ? {} : { contextWindow: run.contextWindow }),
});

test("a pi session request is its intent's own, and a reference with no trusted checkpoint is refused rather than mended", () => {
	const fresh: SessionIntent = { kind: "new" };
	const opened = piSession(fresh);
	assert.deepEqual(opened, { kind: "new", intent: fresh });
	assert.equal(opened.intent, fresh, "the intent travels as the object the host handed over");
	assert.equal(opened.id, undefined, "a new session is named by the child that opens it, not by this host");

	const resume: SessionIntent = { kind: "resume", ref: SOURCE };
	assert.deepEqual(piSession(resume), { kind: "resume", id: SESSION_ID, file: SESSION_FILE, at: CHECKPOINT, intent: resume });
	const fork: SessionIntent = { kind: "fork", from: SOURCE };
	const forked = piSession(fork);
	assert.deepEqual(forked, { kind: "fork", from: SESSION_ID, file: SESSION_FILE, at: CHECKPOINT, intent: fork });
	assert.equal(forked.id, undefined, "a fork's own session is the child's to open, so nothing names one here");

	const claude = { backend: "claude", sessionId: "c-1", checkpoint: "m-1" } as const;
	assert.throws(() => piSession({ kind: "resume", ref: claude }), /claude session c-1 cannot be continued by the pi backend/);
	assert.throws(() => piSession({ kind: "fork", from: claude }), /claude session c-1 cannot be continued by the pi backend/);

	const untrusted: PiSessionRef[] = [
		{ backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE },
		{ backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: "   " },
		{ backend: "pi", sessionId: SESSION_ID, sessionFile: "sessions/pi-session-1.jsonl", checkpoint: CHECKPOINT },
		{ backend: "pi", sessionId: "  ", sessionFile: SESSION_FILE, checkpoint: CHECKPOINT },
	];
	const untrustedError = (error: unknown): boolean => error instanceof Error && error.message === PI_UNTRUSTED_SESSION;
	for (const ref of untrusted) {
		assert.throws(() => piSession({ kind: "resume", ref }), untrustedError, JSON.stringify(ref));
		assert.throws(() => piSession({ kind: "fork", from: ref }), untrustedError, JSON.stringify(ref));
	}
	// A shape that is not an intent at all is the caller's own composition error, and it throws where it is read.
	assert.throws(() => piSession({ kind: "resume" } as unknown as SessionIntent), TypeError);
});

test("every concern a child's ending can leave is kept, in one order, and a stage that reported nothing is unverified", () => {
	assert.deepEqual(exitConcerns(exitOf()), [], "a child this host stopped, that stopped, left nothing behind");
	const one: Array<[PiExit, PiConcern]> = [
		[exitWithCleanup({ root: "unstoppable" }), "root-unstoppable"],
		[exitWithCleanup({ stdio: "held" }), "stdio-held"],
		[exitWithCleanup({ discovery: "unavailable" }), "discovery-unavailable"],
		[exitWithCleanup({ leftovers: [processOf(4_242)] }), "leftovers"],
		[exitWithCleanup({ skipped: [processOf(4_243)] }), "skipped"],
		[exitWithCleanup({ deadlineHit: true }), "deadline-hit"],
		[exitOf({ counters: { ...COUNTERS, streamsUnclosed: 2 } }), "streams-unclosed"],
	];
	for (const [exit, concern] of one) assert.deepEqual(exitConcerns(exit), [concern]);
	for (const root of ["unspawned", "exited", "stopped"] as const) {
		assert.deepEqual(exitConcerns(exitWithCleanup({ root })), [], `a root that is ${root} says nothing on its own`);
		assert.deepEqual(exitConcerns(exitWithCleanup({ root, leftovers: [processOf(1_000)] })), ["leftovers"], "and it clears nothing either");
	}
	const everything = exitOf({
		cleanup: { ...CLEANUP, root: "unstoppable", stdio: "held", discovery: "unavailable", leftovers: [processOf(1)], skipped: [processOf(2)], deadlineHit: true },
		counters: { ...COUNTERS, streamsUnclosed: 1 },
	});
	assert.deepEqual(exitConcerns(everything), ["root-unstoppable", "stdio-held", "discovery-unavailable", "leftovers", "skipped", "deadline-hit", "streams-unclosed"]);

	assert.deepEqual(disposition({ kind: "none" }), { safe: true, concerns: [] });
	const preStart: PiPrepareRefused = { ok: false, reason: "aborted" };
	assert.deepEqual(disposition({ kind: "prepare", refused: preStart }), { safe: true, concerns: [] }, "a call cancelled before its child existed left nothing to clean up");
	assert.deepEqual(disposition({ kind: "prepare", refused: { ok: false, reason: "state", exit: exitOf() } }), { safe: true, concerns: [] });
	assert.deepEqual(disposition({ kind: "prepare", refused: { ok: false, reason: "state", exit: exitWithCleanup({ stdio: "held" }), unverified: true } }).concerns, ["stdio-held", "unverified"]);
	// The foreign seam: a stage that claimed a child and said nothing about how its stop went.
	assert.deepEqual(disposition({ kind: "prepare", refused: { ok: false, reason: "selection" } }).concerns, ["unverified"]);

	const restoreOf = (over: Partial<PiRestoreRefused> = {}): PiPrepareRefused => ({ ok: false, reason: "restore", restore: { ok: false, reason: "operation", ...over } });
	assert.deepEqual(disposition({ kind: "prepare", refused: restoreOf({ exit: exitWithCleanup({ leftovers: [processOf(3)] }) }) }).concerns, ["leftovers"]);
	assert.deepEqual(disposition({ kind: "prepare", refused: restoreOf({ unverified: true, shutdownError: SECRETS.shutdown }) }).concerns, ["unverified"]);
	assert.deepEqual(disposition({ kind: "prepare", refused: restoreOf() }).concerns, ["unverified"], "a restore stops its own child, so one that reported neither was never read");
	// Both halves of one refusal, with the concern they share counted once.
	const both = disposition({ kind: "prepare", refused: { ok: false, reason: "restore", exit: exitWithCleanup({ stdio: "held" }), restore: { ok: false, reason: "turn", exit: exitWithCleanup({ stdio: "held", deadlineHit: true }) } } });
	assert.deepEqual(both.concerns, ["stdio-held", "deadline-hit"]);

	const prepared = { session: SESSION, selection: SELECTION };
	assert.deepEqual(disposition({ kind: "task", result: doneOf(), prepared }), { safe: true, concerns: [] });
	assert.deepEqual(disposition({ kind: "task", result: doneOf({ exit: exitWithCleanup({ skipped: [processOf(9)] }) }), prepared }).concerns, ["skipped"]);
	assert.deepEqual(disposition({ kind: "task", result: refusedTaskOf({ exit: exitWithCleanup({ root: "unstoppable" }) }), prepared }).concerns, ["root-unstoppable"]);
	assert.deepEqual(disposition({ kind: "task", result: refusedTaskOf({ reason: "cleanup", exit: undefined, unverified: true, shutdownError: SECRETS.shutdown }), prepared }).concerns, ["unverified"]);
	assert.deepEqual(disposition({ kind: "task", result: refusedTaskOf({ exit: undefined }), prepared }).concerns, ["unverified"]);
	// A refusal carrying both an exit and `unverified` is a shape the transport does not make and the type permits:
	// both halves are read, because dropping either would be this host choosing which evidence to believe.
	const contradictory = disposition({
		kind: "task",
		result: refusedTaskOf({ reason: "cleanup", exit: exitWithCleanup({ stdio: "held", leftovers: [processOf(77)] }), unverified: true, shutdownError: SECRETS.shutdown }),
		prepared,
	});
	assert.deepEqual(contradictory, { safe: false, concerns: ["stdio-held", "leftovers", "unverified"] });
	assert.deepEqual(disposition({ kind: "unverified", where: "task", prepared }), { safe: false, concerns: ["unverified"] });
});

test("every reason of every stage has a fixed sentence, and none of them repeats what the refusal kept", () => {
	const PREPARE_REASONS: Record<PiPrepareReason, true> = { aborted: true, startup: true, exited: true, state: true, restore: true, selection: true, usage: true, question: true, transport: true };
	const RESTORE_REASONS: Record<PiRestoreReason, true> = { reference: true, aborted: true, state: true, commands: true, turn: true, operation: true, postcondition: true, transport: true };
	const TASK_REASONS: Record<PiTaskReason, true> = {
		aborted: true,
		exited: true,
		question: true,
		rejected: true,
		turn: true,
		unobserved: true,
		extension: true,
		failed: true,
		leaf: true,
		state: true,
		usage: true,
		text: true,
		cleanup: true,
		transport: true,
	};
	const leaky = exitOf({ stderr: { serving: false, stageCount: 1, truncatedLines: 2, lines: 9, tail: SECRETS.stderr, dropped: 12 } });
	const secretSession: PiSessionRef = { backend: "pi", sessionId: SESSION_ID, sessionFile: `/sessions/${SECRETS.path}/pi-1.jsonl` };

	const prepareMessages = new Set<string>();
	for (const reason of Object.keys(PREPARE_REASONS) as PiPrepareReason[]) {
		const refused: PiPrepareRefused = { ok: false, reason, error: SECRETS.error, shutdownError: SECRETS.shutdown, outcome: OUTCOME, session: secretSession, selection: SELECTION, exit: leaky };
		const ended: Ended = { kind: "prepare", refused };
		const diagnostic = diagnose(ended, disposition(ended), SAFE);
		assert.ok(diagnostic, `a preparation that refused with ${reason} says why`);
		assert.equal(diagnostic.stage, "prepare");
		assert.equal(diagnostic.stopReason, reason === "aborted" ? "aborted" : "prepare");
		noSecrets(diagnostic.message, `the ${reason} preparation refusal`);
		prepareMessages.add(diagnostic.message);
	}
	assert.equal(prepareMessages.size, Object.keys(PREPARE_REASONS).length, "each preparation reason reads as itself");

	const restoreMessages = new Set<string>();
	for (const reason of Object.keys(RESTORE_REASONS) as PiRestoreReason[]) {
		const restore: PiRestoreRefused = { ok: false, reason, cancelled: true, error: SECRETS.error, shutdownError: SECRETS.shutdown, exit: leaky };
		const ended: Ended = { kind: "prepare", refused: { ok: false, reason: "restore", restore } };
		const diagnostic = diagnose(ended, disposition(ended), SAFE);
		assert.ok(diagnostic, `a restore that refused with ${reason} says why`);
		assert.equal(diagnostic.stage, "restore", "a nested restore is reported as the stage that actually failed");
		assert.equal(diagnostic.stopReason, reason === "aborted" ? "aborted" : "restore");
		assert.match(diagnostic.message, /reported the operation as cancelled/, "a cancelled operation says so");
		noSecrets(diagnostic.message, `the ${reason} restore refusal`);
		restoreMessages.add(diagnostic.message);
	}
	assert.equal(restoreMessages.size, Object.keys(RESTORE_REASONS).length);
	const uncancelled: Ended = { kind: "prepare", refused: { ok: false, reason: "restore", restore: { ok: false, reason: "operation", exit: leaky } } };
	assert.doesNotMatch(diagnose(uncancelled, disposition(uncancelled), SAFE)?.message ?? "", /cancelled/, "only a cancelled operation carries that suffix");

	const taskMessages = new Set<string>();
	for (const reason of Object.keys(TASK_REASONS) as PiTaskReason[]) {
		const result = refusedTaskOf({
			reason,
			session: secretSession,
			error: SECRETS.error,
			shutdownError: SECRETS.shutdown,
			outcome: OUTCOME,
			extensionError: { error: SECRETS.extension, extensionPath: `/x/${SECRETS.path}`, event: "command", cut: { error: false, extensionPath: false, event: false } },
			steers: { open: false, pushed: 1, sent: 0, rejected: 1, refused: 0, failed: 0, dropped: 0, lastFailure: { code: "rejected", response: SECRETS.steer } },
			evidence: evidenceOf({ last: { from: "message_end", stopReason: "error", text: SECRETS.error, errorMessage: SECRETS.error, cut: { text: false, errorMessage: false } } }),
			exit: leaky,
		});
		const ended: Ended = { kind: "task", result, prepared: { session: SESSION, selection: SELECTION } };
		const diagnostic = diagnose(ended, disposition(ended), SAFE);
		assert.ok(diagnostic, `a task that refused with ${reason} says why`);
		assert.equal(diagnostic.stage, reason === "cleanup" ? "cleanup" : "task");
		assert.equal(diagnostic.stopReason, reason === "aborted" ? "aborted" : reason === "cleanup" ? "cleanup" : "task");
		noSecrets(diagnostic.message, `the ${reason} task refusal`);
		taskMessages.add(diagnostic.message);
	}
	assert.equal(taskMessages.size, Object.keys(TASK_REASONS).length);

	// The suffixes: a question names how its dialog ended and what became of the answer, and an extension error
	// names nothing of its own at all.
	const asked: Ended = { kind: "task", result: refusedTaskOf({ reason: "question", outcome: { ...OUTCOME, end: "aborted", admission: { code: "threw", error: SECRETS.error } } }), prepared: { session: SESSION, selection: SELECTION } };
	const askedMessage = diagnose(asked, disposition(asked), SAFE)?.message ?? "";
	assert.match(askedMessage, /its dialog ended aborted, and the answer to it was threw/);
	noSecrets(askedMessage, "a question refusal");
	const noAdmission: Ended = { kind: "prepare", refused: { ok: false, reason: "question", outcome: OUTCOME, exit: exitOf() } };
	assert.match(diagnose(noAdmission, disposition(noAdmission), SAFE)?.message ?? "", /its dialog ended failed, and the answer to it was none/);
	// Neither vocabulary is a shape to trust at runtime: a value outside it, and one naming something off
	// `Object.prototype`, are both unknown. That the two tables cover their unions is the compiler's own check.
	const forgedDialog = { id: "ui-2", question: SECRETS.question, end: "hijacked", admission: { code: "toString" } } as unknown as PiQuestionOutcome;
	const forged: Ended = { kind: "task", result: refusedTaskOf({ reason: "question", outcome: forgedDialog }), prepared: { session: SESSION, selection: SELECTION } };
	assert.match(diagnose(forged, disposition(forged), SAFE)?.message ?? "", /its dialog ended unknown, and the answer to it was unknown/);
	const broke: Ended = { kind: "task", result: refusedTaskOf({ reason: "extension" }), prepared: { session: SESSION, selection: SELECTION } };
	assert.match(diagnose(broke, disposition(broke), SAFE)?.message ?? "", /kept as evidence and is not repeated here/);

	// A failure the transport composed is the one text from elsewhere that may travel: it is fixed text, a stage
	// name and an exit, under the transport's own policy.
	const composed = "the pi child did not become ready at the models stage (exit code 3)";
	const startup: Ended = { kind: "prepare", refused: { ok: false, reason: "startup", failure: { kind: "startup", message: composed, stage: "models" }, error: SECRETS.error, exit: exitOf() } };
	assert.equal(diagnose(startup, disposition(startup), SAFE)?.message, composed);

	// A cancellation is a cancellation whichever half of the refusal says so: `preparePiChild` refuses a signal that
	// aborted during startup under the `startup` reason, with the transport's own `aborted` failure on it.
	const abortedStartup: Ended = { kind: "prepare", refused: { ok: false, reason: "startup", failure: { kind: "aborted", message: "the run was cancelled" }, error: SECRETS.error, exit: exitOf() } };
	assert.equal(diagnose(abortedStartup, disposition(abortedStartup), SAFE)?.stopReason, "aborted");
	const abortedTurn: Ended = { kind: "task", result: refusedTaskOf({ reason: "transport", failure: { kind: "aborted", message: "the run was cancelled" } }), prepared: { session: SESSION, selection: SELECTION } };
	assert.equal(diagnose(abortedTurn, disposition(abortedTurn), SAFE)?.stopReason, "aborted");
	const abortedRestore: Ended = { kind: "prepare", refused: { ok: false, reason: "restore", restore: { ok: false, reason: "transport", failure: { kind: "aborted", message: "the run was cancelled" }, unverified: true, shutdownError: SECRETS.shutdown } } };
	const abortedRestoreDiagnostic = diagnose(abortedRestore, disposition(abortedRestore), SAFE);
	assert.equal(abortedRestoreDiagnostic?.stopReason, "aborted", "a cancellation outranks the shutdown that could not be read");
	assert.match(abortedRestoreDiagnostic?.message ?? "", /the cleanup after it left: unverified/, "and that shutdown is still on the record as the concern it is");

	// What the cleanup left, and the storage nobody could remove, are both appended and neither replaces the reason.
	const messy: Ended = { kind: "task", result: refusedTaskOf({ reason: "leaf", exit: exitWithCleanup({ leftovers: [processOf(11)], deadlineHit: true }) }), prepared: { session: SESSION, selection: SELECTION } };
	const messyMessage = diagnose(messy, disposition(messy), LEFT_BEHIND)?.message ?? "";
	assert.match(messyMessage, /^the pi session was not standing where this run required it to be /);
	assert.match(messyMessage, /the cleanup after it left: leftovers, deadline-hit/);
	assert.ok(messyMessage.endsWith(DISPOSE_FAILED), messyMessage);

	const unverified: Ended = { kind: "unverified", where: "prepare" };
	const unverifiedDiagnostic = diagnose(unverified, disposition(unverified), SAFE);
	assert.equal(unverifiedDiagnostic?.stage, "prepare");
	assert.equal(unverifiedDiagnostic?.stopReason, "unverified");
	assert.match(unverifiedDiagnostic?.message ?? "", new RegExp(`^${RUN_UNVERIFIED}`));

	const ok: Ended = { kind: "task", result: doneOf(), prepared: { session: SESSION, selection: SELECTION } };
	assert.equal(diagnose(ok, disposition(ok), SAFE), undefined, "a turn that finished with nothing left behind says nothing");
	assert.equal(diagnose(ok, disposition(ok), LEFT_BEHIND), undefined, "and storage left behind is a note on it, not an error");
});

test("a turn that finished reports the session it settled in and the statistics of that turn alone", () => {
	const ended: PiEnded = { kind: "task", result: doneOf(), prepared: { session: SESSION, selection: SELECTION } };
	const run = finishedOf(ended);
	assert.equal(failed(run), false);
	assert.deepEqual([run.stopReason, run.exitCode, run.signal, run.aborted, run.stderr, run.errorMessage], ["stop", 0, null, false, "", undefined]);
	assert.equal(run.ms, 1_234);
	assert.deepEqual(run.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: LEAF });
	assert.equal(run.sessionId, SESSION_ID, "the scalar id is there for the readers that show one");
	assert.equal(run.checkpoint, undefined, "a pi run's checkpoint lives on its reference alone");
	assert.deepEqual(run.selection, SELECTION);
	assert.equal(run.text, "## Changed\nfoo.ts");

	assert.deepEqual([run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite], [215, 40, 10, 5], "the input already counts the cache the turn read and wrote");
	assert.equal(run.costUsd, 0.5);
	assert.equal(run.numTurns, 2);
	assert.equal(run.modelId, MODEL);
	assert.deepEqual(run.models, [{ model: MODEL, inputTokens: 200, outputTokens: 40, cacheRead: 10, cacheWrite: 5, costUsd: 0.5, contextWindow: 64_000 }]);
	assert.deepEqual([run.contextTokens, run.contextWindow], [1_200, 64_000]);
	assert.deepEqual([run.thinking, run.deniedTools, run.abandonedTasks, run.workflowTokens, run.apiMs], [undefined, undefined, undefined, undefined, undefined]);

	// A run under a subscription costs nothing measurable, and a zero price is not one to show.
	const free = finishedOf({ kind: "task", result: doneOf({ usage: { before: BASELINE, after: afterOf(), delta: { ...DELTA, cost: 0 } } }), prepared: { session: SESSION, selection: SELECTION } });
	assert.equal(free.costUsd, undefined);
	assert.equal(free.models?.[0]?.costUsd, 0);

	// The live context fields the stream left are cleared when the session reports no estimate for them: a session
	// that has just compacted reports a window and no number, and one that reports nothing at all keeps neither.
	const compacted = newRun(ROLE);
	compacted.contextTokens = 9_999;
	compacted.contextWindow = 32_000;
	const afterCompaction: PiEnded = { kind: "task", result: doneOf({ usage: { before: BASELINE, after: afterOf({ contextUsage: { tokens: null, contextWindow: 64_000, percent: null } }), delta: DELTA } }), prepared: { session: SESSION, selection: SELECTION } };
	finishRun(compacted, afterCompaction, disposition(afterCompaction), SAFE, 10);
	assert.equal(compacted.contextTokens, undefined, "an estimate the child does not have is not one the stream may stand in for");
	assert.equal(compacted.contextWindow, 64_000);
	const unknown = newRun(ROLE);
	unknown.contextTokens = 9_999;
	unknown.contextWindow = 32_000;
	const noContext: PiEnded = { kind: "task", result: doneOf({ usage: { before: BASELINE, after: afterOf({ contextUsage: undefined }), delta: DELTA } }), prepared: { session: SESSION, selection: SELECTION } };
	finishRun(unknown, noContext, disposition(noContext), SAFE, 10);
	assert.deepEqual([unknown.contextTokens, unknown.contextWindow], [undefined, undefined]);
	assert.equal(unknown.models?.[0]?.contextWindow, undefined);

	// Storage nobody could remove is a note in the report, and the run is still a success.
	const noted = finishedOf(ended, LEFT_BEHIND);
	assert.equal(failed(noted), false);
	assert.equal(noted.errorMessage, undefined);
	assert.equal(noted.text, `## Changed\nfoo.ts\n\n${DISPOSE_WARNING}`);
	const silent = finishedOf({ kind: "task", result: doneOf({ text: null }), prepared: { session: SESSION, selection: SELECTION } }, LEFT_BEHIND);
	assert.equal(silent.text, DISPOSE_WARNING, "a child that named no text still carries the note");
});

test("a turn whose child would not let go is demoted, and publishes the session it stood in before the turn", () => {
	const messy = exitWithCleanup({ leftovers: [processOf(4_242)] }, { stoppedByUs: false, exit: { code: null, signal: "SIGKILL" } });
	const ended: PiEnded = { kind: "task", result: doneOf({ exit: messy }), prepared: { session: SESSION, selection: SELECTION } };
	const run = finishedOf(ended);
	assert.equal(failed(run), true);
	assert.equal(run.stopReason, "cleanup");
	assert.equal(run.aborted, false);
	assert.deepEqual([run.exitCode, run.signal], [null, "SIGKILL"], "a child nobody stopped reports the ending it had");
	assert.match(run.errorMessage ?? "", new RegExp(`^${CLEANUP_UNCERTAIN}: leftovers\\.`));
	assert.match(run.errorMessage ?? "", /trusted only to the point it stood at before the turn/);
	noSecrets(run.errorMessage ?? "", "a demoted success");
	assert.deepEqual(run.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE }, "never the leaf the turn produced");
	assert.equal(run.text, "## Changed\nfoo.ts", "the work read back, and what it said is still reported");
	assert.equal(run.tokensIn, 215, "so is what the turn spent");

	// A caller's own disposition is its record of the storage decision it made, and it is not authority over this:
	// one that says everything was fine changes neither the demotion nor the labels the run reports.
	const forged = { safe: true, concerns: [] };
	const unsuppressed = finishRun(newRun(ROLE), ended, forged, SAFE, 1_234);
	assert.equal(failed(unsuppressed), true, "a demotion is decided from the ending, not from what a caller passes");
	assert.equal(unsuppressed.stopReason, "cleanup");
	assert.equal(unsuppressed.errorMessage, run.errorMessage);
	assert.deepEqual(unsuppressed.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE });
	assert.match(diagnose(ended as Ended, forged, SAFE)?.message ?? "", /leftovers/);
	assert.deepEqual(disposition(ended), { safe: false, concerns: ["leftovers"] }, "and safe is that list being empty, never a flag beside it");

	// What the record layer then does with it, for each of the three intents a call can have had.
	const call = { handle: "f1", role: "implement", backend: "pi" as const, hostSessionId: "host-1" };
	const fresh = recordDecision({ ...call, intent: { kind: "new" } }, outcomeOf(run));
	assert.deepEqual(fresh, { entry: { run: "f1", role: "implement", backend: "pi", hostSessionId: "host-1", session: { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE }, selection: SELECTION } }, "a first call that failed keeps its identity and no checkpoint");

	const forkRun = finishedOf({ kind: "task", result: doneOf({ session: { ...FORKED, checkpoint: LEAF }, exit: messy }), prepared: { session: FORKED, selection: SELECTION } });
	const fork = recordDecision({ ...call, intent: { kind: "fork", from: SOURCE } }, outcomeOf(forkRun));
	assert.deepEqual((fork as { entry: Record<string, unknown> }).entry.session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT }, "a fork that failed keeps the checkpoint it forked at");

	const resumeRun = finishedOf({ kind: "task", result: doneOf({ session: { ...SOURCE, checkpoint: LEAF }, exit: messy }), prepared: { session: SOURCE, selection: SELECTION } });
	assert.deepEqual(recordDecision({ ...call, intent: { kind: "resume", ref: SOURCE } }, outcomeOf(resumeRun)), { keep: true }, "a continuation that failed leaves the record it continues authoritative");

	// And the same run undemoted, so the demotion is what the difference is.
	const settled = finishedOf({ kind: "task", result: doneOf(), prepared: { session: SESSION, selection: SELECTION } });
	const recorded = recordDecision({ ...call, intent: { kind: "new" } }, outcomeOf(settled));
	assert.deepEqual((recorded as { entry: Record<string, unknown> }).entry.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: LEAF });
	assert.deepEqual((recorded as { entry: Record<string, unknown> }).entry.contextTokens, 1_200);
});

test("every other ending reports what was verified before it, and nothing it was not", () => {
	const prepared = { session: SESSION, selection: SELECTION };

	// A task that refused: exactly the session it reported, the evidence's own last text, and the live counts as
	// the stream left them.
	const live = newRun(ROLE);
	live.tokensIn = 77;
	live.tokensOut = 11;
	live.toolCalls = 3;
	const refused: PiEnded = { kind: "task", result: refusedTaskOf({ evidence: evidenceOf({ last: { from: "message_end", stopReason: "length", text: "half an answer", cut: { text: false, errorMessage: false } } }) }), prepared };
	finishRun(live, refused, disposition(refused), SAFE, 500);
	assert.equal(failed(live), true);
	assert.equal(live.stopReason, "task");
	assert.equal(live.text, "half an answer");
	assert.deepEqual([live.tokensIn, live.tokensOut, live.toolCalls], [77, 11, 3], "what the stream counted is all a failed run has");
	assert.deepEqual(live.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE });
	assert.equal(live.errorMessage, "the turn produced no finished answer");
	assert.equal(finishedOf({ kind: "task", result: refusedTaskOf({ evidence: evidenceOf() }), prepared }).text, "", "a turn with no assistant record of its own says nothing");
	const cutShort = finishedOf({ kind: "task", result: refusedTaskOf({ evidence: evidenceOf({ last: { from: "message_end", stopReason: "length", text: "half an answ", cut: { text: true, errorMessage: false } } }) }), prepared });
	assert.equal(cutShort.text, "half an answ…", "a preview the observer cut says so rather than reading as the whole of what the child said");

	const cancelled = finishedOf({ kind: "task", result: refusedTaskOf({ reason: "aborted" }), prepared });
	assert.deepEqual([cancelled.aborted, cancelled.stopReason], [true, "aborted"]);
	// A cancellation the transport's own failure names rather than the reason: a signal that aborts during startup
	// comes back under the `startup` reason, and a run that reported it as a failure of the child would be lying.
	const cancelledStartup = finishedOf({ kind: "prepare", refused: { ok: false, reason: "startup", failure: { kind: "aborted", message: "the run was cancelled" }, exit: exitOf() } });
	assert.deepEqual([cancelledStartup.aborted, cancelledStartup.stopReason], [true, "aborted"]);

	// The exit a run reports: a child asked to stop that stopped is a stop, and anything else is the ending it had.
	assert.deepEqual([cancelled.exitCode, cancelled.signal], [0, null]);
	const crashed = finishedOf({ kind: "task", result: refusedTaskOf({ reason: "exited", exit: exitWithCleanup({ root: "exited" }, { stoppedByUs: false, exit: { code: 3, signal: null } }) }), prepared });
	assert.deepEqual([crashed.exitCode, crashed.signal], [3, null]);
	const unstoppable = finishedOf({ kind: "task", result: refusedTaskOf({ reason: "cleanup", exit: exitWithCleanup({ root: "unstoppable" }, { exit: { code: null, signal: "SIGKILL" } }) }), prepared });
	assert.deepEqual([unstoppable.exitCode, unstoppable.signal], [null, "SIGKILL"]);
	assert.equal(unstoppable.stopReason, "cleanup");
	const nothing = finishedOf({ kind: "task", result: refusedTaskOf({ exit: undefined, unverified: true, shutdownError: SECRETS.shutdown }), prepared });
	assert.deepEqual([nothing.exitCode, nothing.signal], [null, null]);
	assert.equal(nothing.stopReason, "unverified");
	noSecrets(nothing.errorMessage ?? "", "a shutdown that threw");

	// A preparation that refused: whatever identity it had already verified, and no text at all.
	const halfway = finishedOf({ kind: "prepare", refused: { ok: false, reason: "usage", session: SESSION, selection: SELECTION, exit: exitOf() } });
	assert.equal(halfway.text, "");
	assert.deepEqual(halfway.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE });
	assert.deepEqual(halfway.selection, SELECTION);
	assert.equal(halfway.stopReason, "prepare");
	const blind = finishedOf({ kind: "prepare", refused: { ok: false, reason: "startup", exit: exitOf() } });
	assert.deepEqual([blind.session, blind.selection, blind.sessionId], [undefined, undefined, undefined], "a call that verified nothing publishes nothing");
	const nested = finishedOf({ kind: "prepare", refused: { ok: false, reason: "restore", restore: { ok: false, reason: "postcondition", exit: exitWithCleanup({ root: "stopped" }, { exit: { code: null, signal: "SIGTERM" } }) } } });
	assert.deepEqual([nested.exitCode, nested.signal, nested.stopReason], [0, null, "restore"], "the nested exit is the one this run had");

	// A stage this host cannot say anything about at all.
	const unknown = finishedOf({ kind: "unverified", where: "task", prepared });
	assert.deepEqual([unknown.exitCode, unknown.signal, unknown.stopReason, unknown.aborted], [null, null, "unverified", false]);
	assert.deepEqual(unknown.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE });
	assert.match(unknown.errorMessage ?? "", new RegExp(`^${RUN_UNVERIFIED}`));
	assert.deepEqual(finishedOf({ kind: "unverified", where: "prepare" }).session, undefined);

	// Nothing ran at all.
	const none = finishedOf({ kind: "none" }, SAFE, 7);
	assert.deepEqual([none.aborted, none.stopReason, none.exitCode, none.signal, none.text, none.ms], [true, "aborted", null, null, "", 7]);
	assert.equal(none.errorMessage, RUN_CANCELLED);
	assert.deepEqual([none.session, none.sessionId], [undefined, undefined]);
	const leftOver = finishedOf({ kind: "none" }, LEFT_BEHIND);
	assert.equal(leftOver.errorMessage, `${RUN_CANCELLED} ${DISPOSE_FAILED}`);
	assert.equal(leftOver.activity, `${CLEANUP_ATTENTION}: ${STORAGE_LEFT}`);

	// What a user is actually shown for a cancelled run is its activity and nothing else — not the error message,
	// not the text — so a cancellation that left a child's cleanup unfinished has to say so there or nowhere.
	const messyCancel: PiEnded = { kind: "task", result: refusedTaskOf({ reason: "aborted", exit: exitWithCleanup({ leftovers: [processOf(5)] }, { stoppedByUs: false, exit: { code: null, signal: "SIGKILL" } }) }), prepared };
	const noisy = newRun(ROLE);
	noisy.activity = "bash npm test";
	finishRun(noisy, messyCancel, disposition(messyCancel), LEFT_BEHIND, 10);
	assert.equal(noisy.aborted, true);
	assert.equal(noisy.activity, `${CLEANUP_ATTENTION}: leftovers; ${STORAGE_LEFT}`);
	const shown = failureMessage(noisy);
	assert.match(shown, /^implement aborted while /);
	assert.ok(shown.includes("leftovers") && shown.includes(STORAGE_LEFT), shown);
	noSecrets(shown, "what a user is shown for a cancelled run");
	// A plain cancellation keeps the line its child was cut off on, which is the useful thing to show for one.
	const quiet = newRun(ROLE);
	quiet.activity = "bash npm test";
	finishRun(quiet, { kind: "none" }, disposition({ kind: "none" }), SAFE, 10);
	assert.equal(failureMessage(quiet), "implement aborted while bash npm test");
});

test("what an ending left for a person is one line on the run, composed here alone and absent when there is nothing", () => {
	const prepared = { session: SESSION, selection: SELECTION };
	const bothHalves = `${CLEANUP_ATTENTION}: leftovers; ${STORAGE_LEFT}`;

	// Nothing at all: a turn that read back whole on a child that let go, and a directory that was removed.
	const settled: PiEnded = { kind: "task", result: doneOf(), prepared };
	assert.equal(finishedOf(settled).cleanupNotice, undefined);
	// A record that already carried one loses it, because the field is this ending's own answer and not a log.
	const stale = newRun(ROLE);
	stale.cleanupNotice = "left over from some other ending";
	finishRun(stale, settled, disposition(settled), SAFE, 10);
	assert.equal(Object.hasOwn(stale, "cleanupNotice"), false, "a clean ending leaves the key absent rather than stale or empty");

	// The storage half alone: an ending that left no concern, whose removal was tried and threw.
	assert.equal(finishedOf(settled, LEFT_BEHIND).cleanupNotice, `${CLEANUP_ATTENTION}: ${STORAGE_LEFT}`);

	// Both halves, for a removal nobody tried: a cancellation onto a child that left a process behind. The directory
	// reads the same to whoever has to look at it whether the removal failed or was never attempted.
	const messyCancel: PiEnded = { kind: "task", result: refusedTaskOf({ reason: "aborted", exit: exitWithCleanup({ leftovers: [processOf(5)] }) }), prepared };
	const cancelled = finishedOf(messyCancel, RETAINED);
	assert.equal(cancelled.cleanupNotice, bothHalves);
	assert.equal(cancelled.activity, bothHalves, "a cancelled run carries it as its activity too, because that is all the host shows for one");

	// And the same line for an ending nobody cancelled: a demoted turn says it without being aborted, and the line
	// its child was last on is left alone, because a run that failed is shown its own message instead.
	const demoted: PiEnded = { kind: "task", result: doneOf({ exit: exitWithCleanup({ leftovers: [processOf(5)] }) }), prepared };
	const working = newRun(ROLE);
	working.activity = "bash npm test";
	finishRun(working, demoted, disposition(demoted), RETAINED, 10);
	assert.deepEqual([working.aborted, working.cleanupNotice, working.activity], [false, bothHalves, "bash npm test"]);

	// It is this module's own labels and phrases and nothing else: every marker a refusal carried stays where it is.
	const leaky = exitWithCleanup({ stdio: "held", skipped: [processOf(9)] }, { stderr: { serving: false, stageCount: 1, truncatedLines: 0, lines: 1, tail: SECRETS.stderr, dropped: 0 } });
	const carrying: PiEnded = {
		kind: "prepare",
		refused: { ok: false, reason: "startup", error: SECRETS.error, shutdownError: SECRETS.shutdown, outcome: OUTCOME, session: { backend: "pi", sessionId: SESSION_ID, sessionFile: `/sessions/${SECRETS.path}/pi-1.jsonl` }, selection: SELECTION, exit: leaky },
	};
	const kept = finishedOf(carrying, RETAINED);
	assert.equal(kept.cleanupNotice, `${CLEANUP_ATTENTION}: stdio-held, skipped; ${STORAGE_LEFT}`, "the concern labels in this module's own order");
	for (const [where, run] of [
		["a cancellation", cancelled],
		["a demoted turn", working],
		["a refusal that kept every value it had", kept],
	] as const) {
		noSecrets(run.cleanupNotice ?? "", `what ${where} left for a person to look at`);
	}
});

test("the progress mapper counts inside its own window, bounds everything it shows and never throws back", () => {
	const events: ChildEvent[] = [];
	let progressCalls = 0;
	const run = newRun(ROLE);
	const mapper = progressMapper(run, {
		progress: () => {
			progressCalls += 1;
		},
		event: (event) => {
			events.push(event);
		},
	});

	// Before the window: the records a preparation produced are not this run's work.
	mapper.onEvent({ type: "tool_execution_start", toolCallId: "call-0", toolName: "bash", args: { command: "true" } });
	assert.deepEqual([run.toolCalls, progressCalls, events.length], [0, 0, 0]);

	mapper.begin();
	mapper.onEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm run typecheck\nsecond line", cwd: "/repo" } });
	assert.equal(run.toolCalls, 1);
	assert.equal(run.activity, "bash npm run typecheck");
	const call = events[0] as Extract<ChildEvent, { type: "tool_call" }>;
	assert.deepEqual([call.type, call.name, call.brief, call.id], ["tool_call", "bash", "npm run typecheck", "call-1"]);
	assert.deepEqual({ ...(call.input as Record<string, string>) }, { command: "npm run typecheck\nsecond line", cwd: "/repo" });
	mapper.onEvent({ type: "tool_execution_start", toolName: "", args: 7 });
	const nameless = events[1] as Extract<ChildEvent, { type: "tool_call" }>;
	assert.deepEqual([nameless.name, nameless.brief, nameless.id, nameless.input], ["?", "", undefined, undefined]);
	assert.equal(run.toolCalls, 2);

	mapper.onEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }, { type: "image" }, { type: "text", text: "done" }] }, isError: "yes" });
	const result = events[2] as Extract<ChildEvent, { type: "tool_result" }>;
	assert.deepEqual([result.type, result.toolUseId, result.text, result.isError], ["tool_result", "call-1", "ok\ndone", false], "only an exact true is an error");
	assert.equal(run.activity, "waiting for model");
	const before = events.length;
	mapper.onEvent({ type: "tool_execution_end", toolName: "bash", result: "unattached", isError: true });
	assert.equal(events.length, before, "a result with no call id has nothing to attach to");

	// An empty id is no id either: every empty one is the same key, so a monitor would file unrelated calls and
	// results under it. The call is emitted without one, and the result that carries it is emitted not at all.
	mapper.onEvent({ type: "tool_execution_start", toolCallId: "", toolName: "bash", args: { command: "true" } });
	const blank = events[events.length - 1] as Extract<ChildEvent, { type: "tool_call" }>;
	assert.deepEqual([blank.type, blank.name, blank.id], ["tool_call", "bash", undefined]);
	const blankBefore = events.length;
	mapper.onEvent({ type: "tool_execution_end", toolCallId: "", toolName: "bash", result: "unattached", isError: false });
	assert.equal(events.length, blankBefore, "a result with an empty call id has nothing to attach to either");

	mapper.onEvent({ type: "message_start", message: { role: "assistant", content: [] } });
	assert.equal(run.activity, "thinking");
	mapper.onEvent({ type: "message_start", message: { role: "user", content: [] } });
	assert.equal(run.activity, "thinking", "a user message is not the model thinking");
	mapper.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135, cost: { total: 0.125 } } } });
	assert.deepEqual([run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite], [115, 20, 10, 5]);
	// The prompt of that call, from the three components that are the prompt: Pi's own `totalTokens` counts the
	// output with them, and a context line read off it would grow with every answer the child gives.
	assert.deepEqual([run.contextTokens, run.costUsd], [115, 0.125]);
	assert.equal(run.activity, "writing");
	mapper.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: -1, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.125 } } } });
	assert.deepEqual([run.tokensIn, run.tokensOut], [115, 20], "a reading with a component missing adds none of itself");
	assert.equal(run.costUsd, 0.25, "and the cost it did report still counts");
	mapper.onEvent({ type: "compaction_start" });
	assert.equal(run.activity, "compacting");
	mapper.onEvent({ type: "auto_retry_start", attempt: 2 });
	assert.equal(run.activity, "retrying");
	const quiet = events.length;
	const counts = [run.toolCalls, run.tokensIn];
	for (const ignored of [{ type: "turn_end" }, { type: "agent_end", messages: [] }, { type: "message_update" }, { type: "token_update", tokens: 9 }]) mapper.onEvent(ignored as PiEvent);
	assert.deepEqual([events.length, run.toolCalls, run.tokensIn], [quiet, ...counts], "the turn's own records are the task observer's evidence, not a run's progress");

	// A name and an id come from the child like every other field, so both are cut to the same cap, and the call
	// and its result are cut through one function so the two still name the same call afterwards.
	const longName = "b".repeat(PI_EVENT_KEY_MAX_CHARS + 20);
	const longId = "call-".padEnd(PI_EVENT_KEY_MAX_CHARS + 20, "9");
	mapper.onEvent({ type: "tool_execution_start", toolCallId: longId, toolName: longName, args: { command: "true" } });
	const huge = events[events.length - 1] as Extract<ChildEvent, { type: "tool_call" }>;
	assert.equal(huge.name.length, PI_EVENT_KEY_MAX_CHARS + 1);
	assert.equal(huge.id?.length, PI_EVENT_KEY_MAX_CHARS + 1);
	// Read through a function whose declared answer is the field's own type. Every `assert.equal` above narrowed
	// `run.activity` to the one literal it was compared with, and those literals differ, so by here the compiler has
	// no type left to read a length off; an annotated copy keeps that narrowing, and a call's result cannot.
	const readActivity = (value: string | undefined): string | undefined => value;
	const lastActivity = readActivity(run.activity);
	assert.equal(lastActivity, `${huge.name} true`, "the activity line holds the cut name, never the child's own");
	assert.ok((lastActivity?.length ?? 0) <= PI_EVENT_KEY_MAX_CHARS + PI_ACTIVITY_CHARS + 2, lastActivity);
	mapper.onEvent({ type: "tool_execution_end", toolCallId: longId, toolName: longName, result: "done", isError: false });
	const hugeResult = events[events.length - 1] as Extract<ChildEvent, { type: "tool_result" }>;
	assert.equal(hugeResult.toolUseId, huge.id, "one cut, so a result still attaches to the call it answers");
	const counted = run.toolCalls;

	mapper.end();
	mapper.onEvent({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: {} });
	mapper.begin();
	mapper.onEvent({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: {} });
	assert.equal(run.toolCalls, counted, "a closed run stays closed, and a second begin opens nothing");

	// The bounds, on their own. Seventeen fields are sixteen and a count of the rest.
	const many: Record<string, unknown> = {};
	for (let at = 0; at < PI_EVENT_INPUT_MAX_KEYS + 1; at += 1) many[`k${at}`] = at;
	const bounded = boundedInput(many);
	assert.equal(Object.keys(bounded ?? {}).length, PI_EVENT_INPUT_MAX_KEYS + 1);
	assert.equal(bounded?.k15, "15");
	assert.equal(bounded?.k16, undefined);
	assert.equal(bounded?.["…"], "1 more fields");
	assert.equal(Object.getPrototypeOf(bounded), null, "a __proto__ field from a child writes into this object, never through it");
	const polluted = boundedInput(JSON.parse('{"__proto__": {"polluted": true}}'));
	assert.equal(polluted?.["__proto__"], '{"polluted":true}');
	assert.equal(({} as { polluted?: boolean }).polluted, undefined);

	const long = "x".repeat(PI_EVENT_FIELD_MAX_CHARS + 10);
	const longKey = "k".repeat(PI_EVENT_KEY_MAX_CHARS + 10);
	const capped = boundedInput({ [longKey]: long, [`${longKey}-other`]: "second", nested: { a: [1, 2, { b: "c" }] }, nothing: undefined, none: null, flag: false });
	const keys = Object.keys(capped ?? {});
	assert.equal(keys[0]?.length, PI_EVENT_KEY_MAX_CHARS + 1, "a long name is cut on a code point and says so");
	assert.equal(capped?.[keys[0] as string]?.length, PI_EVENT_FIELD_MAX_CHARS + 1);
	assert.equal(keys.length, 4, "a name that caps onto one already taken is dropped, and an undefined field is not shown");
	assert.equal(capped?.nested, '{"a":[1,2,{"b":"c"}]}');
	assert.deepEqual([capped?.none, capped?.flag], ["null", "false"]);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	assert.equal(boundedInput({ circular })?.circular, "[unserializable]");
	for (const value of [undefined, null, 7, "text", [1, 2]]) assert.equal(boundedInput(value), undefined, JSON.stringify(value ?? null));

	const text = "y".repeat(PI_EVENT_TEXT_MAX_CHARS + 10);
	assert.equal(resultText(text).length, PI_EVENT_TEXT_MAX_CHARS + 1);
	assert.equal(resultText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "one\ntwo");
	for (const value of [undefined, null, 7, [1, 2], { content: "not an array" }]) assert.equal(resultText(value), "");
	assert.ok(PI_ACTIVITY_CHARS === 60, "the activity window is the one every backend's status line uses");

	// A caller whose own emitters throw loses nothing else: the transport counts a listener's error against the child.
	const angry = progressMapper(run, {
		progress: () => {
			throw new Error("progress exploded");
		},
		event: () => {
			throw new Error("event exploded");
		},
	});
	angry.begin();
	angry.onEvent({ type: "tool_execution_start", toolCallId: "call-x", toolName: "bash", args: { command: "true" } });
	assert.equal(run.toolCalls, counted + 1, "the record was still counted");
	angry.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } });
	angry.onEvent(undefined as unknown as PiEvent);
	angry.end();
});
