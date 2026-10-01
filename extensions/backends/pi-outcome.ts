import * as path from "node:path";
import type { PiRole } from "./pi-binding.ts";
import type { PiPrepareReason, PiPrepareRefused } from "./pi-prepare.ts";
import type { PiQuestionOutcome } from "./pi-question-routing.ts";
import type { PiRestoreReason, PiRestoreRefused } from "./pi-session-restore.ts";
import type { PiTaskDone, PiTaskReason, PiTaskRefused, PiTaskResult } from "./pi-task.ts";
import type { PiEvent, PiExit, PiFailure } from "./pi-transport.ts";
import type { ChildEvent, ChildRun, HostSession, PiSessionRef, ResolvedSelection, SessionIntent } from "./types.ts";

/**
 * What an eventual Pi run reports, and whether the storage that call ran on may be removed. It is pure: it opens no
 * session, starts and stops no child, reads and writes no file, and nothing constructs a backend from it yet. Every
 * value it reads is one another module already produced — an intent, a preparation's refusal, a task's result, the
 * cleanup report a shutdown made — and everything it hands back is a record, a disposition or a fixed sentence.
 *
 * **What it decides, and why in one place.** Three questions are answered off the same evidence, and answering them
 * apart would let them disagree: which concerns a child's own ending left, what a person is told about it, and what
 * the record layer is handed. A run whose work read back whole but whose child could not be let go of is not a
 * success this host may publish a checkpoint from, so it is demoted here rather than reported as one and corrected
 * later; and the storage of such a run is exactly the storage nothing may remove, which is why the disposition is
 * the same value both readers take.
 *
 * **What never reaches a message.** A thrown value, a shutdown's own error, the text of a question or its answer, an
 * extension error's fields, a steer's failure, the child's stderr tail, a path, a session id, the prompt and the
 * contract are all evidence a person may look at where it is kept, and none of them is composed into a diagnostic
 * here. The one exception is a `PiFailure.message`, which the transport already composed out of fixed text, a stage
 * name, an exit and a recognized bootstrap diagnostic, under its own policy.
 *
 * **Who decides.** The ending is the only authority. `diagnose` and `finishRun` take a `PiDisposition` because the
 * caller that composes a run holds one — it is that caller's own record of the storage decision it made — and
 * neither reads it: both derive the disposition from the ending again, so a caller that passed a stale, forged or
 * merely out-of-order one cannot suppress a demotion or drop a concern label from what a person is told.
 */

/** The session request a Pi call runs under: the host's own view of it, with the intent it was made from kept. */
export interface PiSession extends HostSession {
	/** The intent exactly as the host handed it over: what a continuation repeats is decided from this, not from the fields above. */
	intent: SessionIntent;
}

/**
 * What a Pi continuation needs and cannot be given a default for. A checkpoint is the only point this host may ask a
 * child to stand at, and a session file is half of a Pi session's identity: a relative one names a different file
 * from a different working directory. Neither is normalized into something plausible, because a session continued
 * from a guess is a transcript nobody asked for.
 */
export const PI_UNTRUSTED_SESSION =
	"this pi session has no trusted checkpoint in a session file this host can reopen, so there is nothing to continue from: start a new run for this handle instead";

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * The session request an intent becomes, and nothing else: a pure mapping made before a call runs, with no session
 * opened by it. A reference another backend wrote names a session this one cannot open, and a Pi reference with no
 * trusted checkpoint or a session file that is not absolute is one this host will not act on. A value of another
 * shape altogether throws where it is read, which is what a caller that composed the wrong intent should see.
 */
export function piSession(intent: SessionIntent): PiSession {
	if (intent.kind === "new") return { kind: "new", intent };
	const ref = intent.kind === "resume" ? intent.ref : intent.from;
	if (ref.backend !== "pi") throw new Error(`${ref.backend} session ${ref.sessionId} cannot be continued by the pi backend`);
	const { sessionId, sessionFile, checkpoint } = ref;
	if (!nonblank(sessionId) || !nonblank(sessionFile) || !nonblank(checkpoint) || !path.isAbsolute(sessionFile)) throw new Error(PI_UNTRUSTED_SESSION);
	if (intent.kind === "resume") return { kind: "resume", id: sessionId, file: sessionFile, at: checkpoint, intent };
	return { kind: "fork", from: sessionId, file: sessionFile, at: checkpoint, intent };
}

/**
 * What a child's ending left behind that a later call has to care about. `unverified` is the absence of evidence
 * rather than a state of the process: a shutdown that threw instead of reporting, or a layer that stopped a child
 * and said nothing about how it went.
 */
export type PiConcern = "root-unstoppable" | "stdio-held" | "discovery-unavailable" | "leftovers" | "skipped" | "deadline-hit" | "streams-unclosed" | "unverified";

/** The one order every list of concerns is read in, so two runs with the same concerns read the same way. */
const CONCERN_ORDER: readonly PiConcern[] = ["root-unstoppable", "stdio-held", "discovery-unavailable", "leftovers", "skipped", "deadline-hit", "streams-unclosed", "unverified"];

/** Whether this call's storage may be removed, and what says it may not. `safe` is exactly an empty list. */
export interface PiDisposition {
	safe: boolean;
	concerns: PiConcern[];
}

const ordered = (found: ReadonlySet<PiConcern>): PiConcern[] => CONCERN_ORDER.filter((concern) => found.has(concern));

/**
 * What one exit report says about the process this call left behind. A root that was never spawned, that exited or
 * that was stopped adds nothing of its own — and clears nothing either: a stopped root whose descendants are still
 * alive is a root that was stopped and leftovers, both.
 */
export function exitConcerns(exit: PiExit): PiConcern[] {
	const found = new Set<PiConcern>();
	const cleanup = exit.cleanup;
	if (cleanup.root === "unstoppable") found.add("root-unstoppable");
	if (cleanup.stdio === "held") found.add("stdio-held");
	if (cleanup.discovery === "unavailable") found.add("discovery-unavailable");
	if (cleanup.leftovers.length > 0) found.add("leftovers");
	if (cleanup.skipped.length > 0) found.add("skipped");
	if (cleanup.deadlineHit) found.add("deadline-hit");
	if (exit.counters.streamsUnclosed !== 0) found.add("streams-unclosed");
	return ordered(found);
}

/** The verified session and selection a stage had already read back when it failed, as this module takes them. */
export interface PiPreparedIdentity {
	session: PiSessionRef;
	selection: ResolvedSelection;
}

/**
 * How one Pi call ended, as the runner above this will report it: nothing at all, a preparation that refused, a task
 * that ran, or a stage this host cannot say anything about. `prepared` is the identity that stage stood on before the
 * work, which is what a demoted success is published under.
 */
export type PiEnded =
	| { kind: "none" }
	| { kind: "prepare"; refused: PiPrepareRefused }
	| { kind: "task"; result: PiTaskResult; prepared: PiPreparedIdentity }
	| { kind: "unverified"; where: "prepare" | "task"; prepared?: PiPreparedIdentity };

/** A refusal that never took a child: cancelled before anything was started, so there is nothing to have left behind. */
const preStartAbort = (refused: PiPrepareRefused): boolean => refused.reason === "aborted" && refused.exit === undefined && refused.unverified !== true && refused.restore === undefined;

/**
 * Whether this call's storage may be removed, decided from the ending alone. Every concern any layer reported is
 * kept, deduplicated and in the one order, because the reader of this is a retention policy: a list that dropped one
 * of them would licence removing a directory a process is still writing into.
 *
 * A stage that claimed a child and reported neither an exit nor a shutdown that threw is `unverified` rather than
 * safe. That is the foreign-seam case: this host asked something to stop a child and was told nothing about it.
 */
export function disposition(ended: PiEnded): PiDisposition {
	const found = new Set<PiConcern>();
	const add = (concerns: readonly PiConcern[]): void => {
		for (const concern of concerns) found.add(concern);
	};
	if (ended.kind === "prepare") {
		const refused = ended.refused;
		if (refused.exit !== undefined) add(exitConcerns(refused.exit));
		if (refused.unverified === true) found.add("unverified");
		const restore = refused.restore;
		if (restore !== undefined) {
			if (restore.exit !== undefined) add(exitConcerns(restore.exit));
			// A restore that refused has already stopped the child itself, so one that reports neither is a stop
			// nobody read the end of.
			if (restore.unverified === true || restore.exit === undefined) found.add("unverified");
		} else if (refused.exit === undefined && refused.unverified !== true && !preStartAbort(refused)) {
			found.add("unverified");
		}
	} else if (ended.kind === "task") {
		const result = ended.result;
		// Both halves, independently: the transport hands back one or the other, and a value that somehow carries
		// both is a value to read whole rather than one to pick a half of. The same rule as above adds the second
		// half for a refusal that reported neither, because a task stops its child on every path.
		if (result.exit !== undefined) add(exitConcerns(result.exit));
		if (!result.ok && (result.unverified === true || result.exit === undefined)) found.add("unverified");
	} else if (ended.kind === "unverified") {
		found.add("unverified");
	}
	const concerns = ordered(found);
	return { safe: concerns.length === 0, concerns };
}

/** Which part of a call a diagnostic is about. `backend` is everything in front of the first stage of one. */
export type PiRunStage = "prepare" | "restore" | "task" | "cleanup" | "backend";

/** What a failed run says for itself: where it stopped, the reason a record carries, and one fixed sentence. */
export interface PiRunDiagnostic {
	stage: PiRunStage;
	stopReason: string;
	message: string;
}

/** What became of this call's own storage, as the caller that owns it reports: never inferred from the ending. */
export interface PiDisposal {
	attempted: boolean;
	failed: boolean;
	/**
	 * The third case, beside removed and attempted-and-failed: a removal nobody tried, because the ending left something
	 * this host will not remove a directory under. It reads the same way to a person as one that failed — the directory
	 * is still there — which is why it is on this record rather than re-derived: the caller that decided not to try is
	 * the only one that knows it did not.
	 */
	retained?: boolean;
}

/** The demoted success: the work read back and the child's own ending did not, so no checkpoint is published. */
export const CLEANUP_UNCERTAIN = "the turn finished and the pi child's own cleanup did not";

/** What that demotion says about the session, so nobody reads the run's own leaf out of a run that failed. */
const TRUSTED_TO_PRE_TASK = "This run's session is trusted only to the point it stood at before the turn.";

/** How a failure names what the cleanup after it left. The labels are this module's own and carry no detail. */
const CLEANUP_LEFT = "the cleanup after it left";

/** Appended to a failed run's own message, because storage nobody removed is a thing for a person to go and remove. */
export const DISPOSE_FAILED = "This call's own storage could not be removed and is left behind.";

/** The same fact on a run that succeeded, which stays a success: it is a note in the report, not an error. */
export const DISPOSE_WARNING = "Note: this call's own storage could not be removed and is left behind.";

/** A run cancelled before its child was started: nothing ran, so there is no stage to name and nothing to clean up. */
export const RUN_CANCELLED = "the run was cancelled before its pi child was started";

/** A stage that claimed a child and reported nothing about how it ended. The absence of evidence, named. */
export const RUN_UNVERIFIED = "this host cannot say how the pi child's run ended";

/**
 * What heads the one line this module writes for a person to act on: the run's own `cleanupNotice`, which says which
 * parts of a child's cleanup did not finish and whether the call's storage is still there. It is composed here and
 * nowhere else, because two composers of one sentence would disagree: a cancelled run is shown its activity and
 * nothing else by the host's own failure message, and a run the host itself cancelled is shown neither its activity
 * nor its error message, so the field is what carries the fact through either path. The concern labels are this
 * module's own eight and the storage phrase is fixed, so what this composes is bounded by construction and carries
 * no path, no id and no value from anywhere.
 */
export const CLEANUP_ATTENTION = "cleaning up needs attention";

/** The storage half of that line, and of nothing else: the sentences above are for a message rather than a status. */
export const STORAGE_LEFT = "this call's storage is left behind";

const PREPARE_TEXT: { [reason in PiPrepareReason]: string } = {
	aborted: "the run was cancelled before its pi child was ready",
	startup: "the pi child could not be started",
	exited: "the pi child exited before it was ready",
	state: "the pi child did not name the session it opened",
	restore: "the recorded pi session could not be restored",
	selection: "the pi child did not run the model and thinking level this call asked for",
	usage: "the pi child did not report the statistics this run is measured against",
	question: "a question from the pi child could not be answered, so its child was stopped",
	transport: "the pi child could not be prepared",
};

const RESTORE_TEXT: { [reason in PiRestoreReason]: string } = {
	reference: "the recorded pi session is not one this host can continue",
	aborted: "the run was cancelled while its recorded pi session was being restored",
	state: "the pi child did not open the recorded session",
	commands: "the pi child did not offer the control command this continuation is carried out by",
	turn: "the control command carrying this continuation was never acknowledged",
	operation: "the pi child could not move to the recorded checkpoint",
	postcondition: "the pi child did not read back as standing at the recorded checkpoint",
	transport: "the recorded pi session could not be restored",
};

const TASK_TEXT: { [reason in PiTaskReason]: string } = {
	aborted: "the run was cancelled",
	exited: "the pi child exited before its turn was done",
	question: "a question from the pi child could not be answered, so its child was stopped",
	rejected: "the pi child would not take this run's prompt",
	turn: "the turn ended without the pi child finishing its work",
	unobserved: "this host saw fewer of the turn's records than the turn itself counted",
	extension: "an extension inside the pi child reported an error during the turn",
	failed: "the turn produced no finished answer",
	leaf: "the pi session was not standing where this run required it to be",
	state: "the pi child did not read back as idle in the session and selection it was prepared in",
	usage: "the pi child did not report usable statistics for the turn",
	text: "the pi child could not name the last assistant text of the turn",
	cleanup: "the pi child could not be stopped after its turn",
	transport: "the turn failed",
};

/** The one thing a restore's own operation failure may add, and it names nothing the operation reported. */
const CANCELLED_SUFFIX = " (the pi child reported the operation as cancelled)";

/** What an extension error adds. Its own fields are evidence where they are kept, and are not repeated here. */
const EXTENSION_SUFFIX = " (what it reported is kept as evidence and is not repeated here)";

/** What the routing calls one dialog's end, and what it calls the admission of an answer to one. */
type PiQuestionEnd = PiQuestionOutcome["end"];
type PiQuestionAdmissionCode = NonNullable<PiQuestionOutcome["admission"]>["code"];

/**
 * The two vocabularies a question suffix may name, as mapped records rather than lists: a value the routing adds to
 * either union and nobody wrote a key for here is a compile error, and a key for a value that union does not have is
 * one too. The lookup itself stays a runtime one, because what arrives can be any shape at all.
 */
const QUESTION_ENDS: { [end in PiQuestionEnd]: true } = { answered: true, failed: true, aborted: true, exited: true };
const QUESTION_ADMISSIONS: { [code in PiQuestionAdmissionCode]: true } = { sent: true, duplicate: true, unknown: true, closed: true, refused: true, threw: true };

/**
 * A value from one of those two tables, or the fallback: a foreign string is never composed into a message unread.
 * The table is taken as the object it is and only its own keys are tested, so a forged value naming something off
 * `Object.prototype` is as unknown here as any other.
 */
const known = (value: unknown, allowed: object): string => (typeof value === "string" && Object.hasOwn(allowed, value) ? value : "unknown");

/**
 * What a question failure may say about itself: how its dialog ended, and what became of the answer. Never the
 * question, never the answer, never what the ask threw, and never the id — the run's own evidence keeps all four.
 */
const questionSuffix = (outcome: PiQuestionOutcome | undefined): string => {
	if (outcome === undefined) return "";
	const admission = outcome.admission === undefined ? "none" : known(outcome.admission.code, QUESTION_ADMISSIONS);
	return ` (its dialog ended ${known(outcome.end, QUESTION_ENDS)}, and the answer to it was ${admission})`;
};

const withDisposal = (message: string, disposal: PiDisposal): string => (disposal.failed ? `${message} ${DISPOSE_FAILED}` : message);

/**
 * Whether a stage stopped because the run was cancelled, read from both places that can say so: the reason the
 * stage decided for itself, and the typed failure it kept. They disagree legitimately — a signal that aborts during
 * a startup is refused under the `startup` reason with an `aborted` failure on it — and a run reported as anything
 * but cancelled there would show a user their own cancellation as a failure of the child.
 */
const cancelled = (reason: string, failure: PiFailure | undefined): boolean => reason === "aborted" || failure?.kind === "aborted";

/**
 * How one refusal is named, in the one order the three can be true in: a cancellation is what happened whichever
 * layer noticed it; a shutdown that threw is the next thing worth saying; and otherwise the stage names itself. An
 * `unverified` shutdown under a cancellation is not lost by the order — it travels as the concern it is, on the
 * label list every diagnostic appends.
 */
const stopReasonOf = (stage: PiRunStage, reason: string, failure: PiFailure | undefined, unverified: true | undefined): string => {
	if (cancelled(reason, failure)) return "aborted";
	return unverified === true ? "unverified" : stage;
};

function restoreDiagnostic(restore: PiRestoreRefused): PiRunDiagnostic {
	// The transport composed its own message under its own policy; this one is fixed text for everything else.
	const message = restore.failure?.message ?? RESTORE_TEXT[restore.reason];
	const stopReason = stopReasonOf("restore", restore.reason, restore.failure, restore.unverified);
	return { stage: "restore", stopReason, message: `${message}${restore.cancelled === true ? CANCELLED_SUFFIX : ""}` };
}

function prepareDiagnostic(refused: PiPrepareRefused): PiRunDiagnostic {
	// A nested restore refusal is reported as the restore it was: it is the stage that actually failed, and the
	// preparation's own `restore` reason says nothing a person could act on.
	if (refused.restore !== undefined) return restoreDiagnostic(refused.restore);
	const message = refused.failure?.message ?? PREPARE_TEXT[refused.reason];
	const stopReason = stopReasonOf("prepare", refused.reason, refused.failure, refused.unverified);
	return { stage: "prepare", stopReason, message: `${message}${refused.reason === "question" ? questionSuffix(refused.outcome) : ""}` };
}

function taskDiagnostic(result: PiTaskRefused): PiRunDiagnostic {
	const message = result.failure?.message ?? TASK_TEXT[result.reason];
	// A turn whose work was done and whose child would not stop failed at the cleanup, and naming it the task stage
	// would send a reader looking at the turn.
	const stage: PiRunStage = result.reason === "cleanup" ? "cleanup" : "task";
	const stopReason = stopReasonOf(stage, result.reason, result.failure, result.unverified);
	const suffix = result.reason === "question" ? questionSuffix(result.outcome) : result.reason === "extension" ? EXTENSION_SUFFIX : "";
	return { stage, stopReason, message: `${message}${suffix}` };
}

/**
 * One ending read whole: the concerns it left, and what it says for itself. Both are derived here, from the ending
 * and the storage report alone — the `PiDisposition` the exported functions take is the caller's own copy of the
 * first of these and is never read, so nothing a caller passes can make a demoted run read as a finished one.
 */
function outcomeOf(ended: PiEnded, disposal: PiDisposal): { disposition: PiDisposition; diagnostic?: PiRunDiagnostic } {
	const decided = disposition(ended);
	const diagnostic = runDiagnostic(ended, decided, disposal);
	return { disposition: decided, ...(diagnostic === undefined ? {} : { diagnostic }) };
}

/** The whole diagnostic, `none` included, which the exported one narrows away because a run that never started is finishRun's. */
function runDiagnostic(ended: PiEnded, decided: PiDisposition, disposal: PiDisposal): PiRunDiagnostic | undefined {
	if (ended.kind === "none") return { stage: "backend", stopReason: "aborted", message: withDisposal(RUN_CANCELLED, disposal) };
	let base: PiRunDiagnostic;
	if (ended.kind === "prepare") base = prepareDiagnostic(ended.refused);
	else if (ended.kind === "unverified") base = { stage: ended.where === "prepare" ? "prepare" : "task", stopReason: "unverified", message: RUN_UNVERIFIED };
	else if (ended.result.ok) {
		// A success only stays one while its child's own ending left nothing behind. Storage that could not be
		// removed is not that: it is a note on a run that still succeeded, and `finishRun` puts it in the text.
		if (decided.concerns.length === 0) return undefined;
		const message = `${CLEANUP_UNCERTAIN}: ${decided.concerns.join(", ")}. ${TRUSTED_TO_PRE_TASK}`;
		return { stage: "cleanup", stopReason: "cleanup", message: withDisposal(message, disposal) };
	} else base = taskDiagnostic(ended.result);
	const concerns = decided.concerns.length === 0 ? base.message : `${base.message} (${CLEANUP_LEFT}: ${decided.concerns.join(", ")})`;
	return { stage: base.stage, stopReason: base.stopReason, message: withDisposal(concerns, disposal) };
}

/**
 * What a failed run says, or nothing at all for a task that succeeded and left nothing behind. Every reason of every
 * stage has a fixed sentence of its own here, so a reason nobody wrote one for is a compile error rather than an
 * empty message, and the only text from anywhere else that reaches one is a `PiFailure.message`.
 *
 * The `_reportedDisposition` parameter is the caller's own record of the storage decision it made, kept in the
 * signature for the composition that will pass it. It is deliberately not read — and named apart from the module's
 * own `disposition()`, which is the authority here and which a parameter of that name would shadow: the concerns
 * this message names are derived from the ending, so a caller holding a disposition that disagrees gets a
 * diagnostic that still tells the truth.
 */
export function diagnose(ended: Exclude<PiEnded, { kind: "none" }>, _reportedDisposition: PiDisposition, disposal: PiDisposal): PiRunDiagnostic | undefined {
	return outcomeOf(ended, disposal).diagnostic;
}

/** A Pi child's run: the shared record over this backend's own role shape. */
export type PiRun = ChildRun<PiRole>;

/** The record a run starts from: everything at zero, nothing claimed, and no session named before one is verified. */
export function newRun(role: PiRole): PiRun {
	return {
		role,
		text: "",
		toolCalls: 0,
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		cacheWrite: 0,
		ms: 0,
		exitCode: null,
		signal: null,
		aborted: false,
		stderr: "",
	};
}

/** The exit report the ending carries, if any: a task's own, a preparation's, or the one its nested restore made. */
function endedExit(ended: PiEnded): PiExit | undefined {
	if (ended.kind === "prepare") return ended.refused.exit ?? ended.refused.restore?.exit;
	return ended.kind === "task" ? ended.result.exit : undefined;
}

/**
 * The process code and signal a run reports. A child this host asked to stop, that then stopped, exited because it
 * was told to: reporting the signal that stopped it would read as the run's own outcome, which is what the Claude
 * lifecycle has always normalized away too. Anything else is the process's own code and signal, exactly.
 */
function normalizedExit(exit: PiExit | undefined): { exitCode: number | null; signal: NodeJS.Signals | null } {
	if (exit === undefined) return { exitCode: null, signal: null };
	if (exit.stoppedByUs && (exit.cleanup.root === "exited" || exit.cleanup.root === "stopped")) return { exitCode: 0, signal: null };
	return { exitCode: exit.exit.code, signal: exit.exit.signal };
}

/**
 * The session a run publishes. The scalar id travels for the readers that show one; the flat `checkpoint` never
 * does, because a Pi continuation stands on the structured reference alone and a flat one would be a second
 * authority for the same thing.
 */
function publish(run: PiRun, identity: { session: PiSessionRef; selection?: ResolvedSelection }): void {
	run.session = { ...identity.session };
	run.sessionId = identity.session.sessionId;
	if (identity.selection !== undefined) run.selection = { ...identity.selection };
}

/**
 * This turn's own share of the statistics, as the canonical accounting of a successful run: the delta the task took
 * against the baseline its preparation read, never the live counts the stream produced, which count whatever the
 * child streamed rather than what the session says it spent.
 */
function publishUsage(run: PiRun, result: PiTaskDone): void {
	const { usage, selection } = result;
	const { delta, after } = usage;
	const tokens = delta.tokens;
	run.tokensIn = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	run.tokensOut = tokens.output;
	run.cacheRead = tokens.cacheRead;
	run.cacheWrite = tokens.cacheWrite;
	// Zero is what a run under a subscription costs, and reporting it would show a price this host did not measure.
	if (delta.cost > 0) run.costUsd = delta.cost;
	else delete run.costUsd;
	run.numTurns = delta.assistantMessages;
	run.modelId = selection.model;
	// The session's own reading after the turn, which is Pi's native context-fill number — what compaction is decided
	// against — rather than the prompt-only one the live counter adds up out of a message's three input components.
	// The two are not guaranteed to mean the same thing, and this is the canonical one for a turn that finished.
	const context = after.contextUsage;
	run.models = [
		{
			model: selection.model,
			// The model's own input, not the run's `tokensIn`: that one already counts the cache on top of it.
			inputTokens: tokens.input,
			outputTokens: tokens.output,
			cacheRead: tokens.cacheRead,
			cacheWrite: tokens.cacheWrite,
			costUsd: delta.cost,
			...(context === undefined ? {} : { contextWindow: context.contextWindow }),
		},
	];
	// A session that has just compacted reports a window and no estimate at all, and the number the stream left
	// behind is about a prompt that no longer exists: it goes rather than standing in for one nobody measured.
	if (context === undefined) delete run.contextWindow;
	else run.contextWindow = context.contextWindow;
	if (typeof context?.tokens === "number") run.contextTokens = context.tokens;
	else delete run.contextTokens;
}

/**
 * The record one ended call hands to the run lifecycle, mutated in place and handed back. What it is, in one line
 * per ending: a success publishes the session, the checkpoint and the canonical usage of its turn; a success whose
 * child's cleanup left something behind is demoted to a failure and publishes the identity it stood on *before* the
 * turn, never the checkpoint the turn produced; every other ending publishes whatever identity was verified before
 * it failed, with the live counts the stream left as they are, because that is all there is to report.
 *
 * It is also the one composer of the run's `cleanupNotice`: every ending whose concerns or whose storage report leave
 * something for a person to look at gets that one line, and every other ending carries none at all. A cancelled run
 * shows it as its activity too, because that is the only field the host's own failure message reads for one.
 *
 * The `_reportedDisposition` parameter is the caller's own record of the storage decision it made and is not read
 * here, for the reason `diagnose` gives, and is named apart from the module's own `disposition()` for the same one:
 * what this run reports is derived from the ending, so no disposition a caller holds can turn a demoted run into a
 * finished one or take a concern off what it says.
 */
export function finishRun(run: PiRun, ended: PiEnded, _reportedDisposition: PiDisposition, disposal: PiDisposal, ms: number): PiRun {
	run.ms = ms;
	// The child's own stderr is the transport's, bounded and kept for a person to look at: it is not a run's field.
	run.stderr = "";
	const decided = outcomeOf(ended, disposal);
	const diagnostic = decided.diagnostic;
	const { exitCode, signal } = normalizedExit(endedExit(ended));
	run.exitCode = exitCode;
	run.signal = signal;
	// One reading of the cancellation, from the diagnostic that already decided it, so a run cannot be aborted here
	// and stopped for something else there.
	run.aborted = diagnostic?.stopReason === "aborted";
	if (diagnostic === undefined) {
		run.stopReason = "stop";
		delete run.errorMessage;
	} else {
		run.stopReason = diagnostic.stopReason;
		run.errorMessage = diagnostic.message;
	}
	// The one composition of that line, for every ending rather than for a cancelled one alone: what the cleanup left
	// and a directory still on disk are worth saying whichever way the run ended, and a caller that wrote a second
	// version of it would be a second authority on the same fact. The storage half covers both ways a directory
	// stays — a removal that was tried and failed, and one this call decided not to try — because they read the same
	// to whoever has to go and look at it.
	const leftBehind = decided.disposition.concerns;
	const storageLeft = disposal.failed || disposal.retained === true;
	if (leftBehind.length > 0 || storageLeft) {
		const parts = [...(leftBehind.length === 0 ? [] : [leftBehind.join(", ")]), ...(storageLeft ? [STORAGE_LEFT] : [])];
		run.cleanupNotice = `${CLEANUP_ATTENTION}: ${parts.join("; ")}`;
	} else delete run.cleanupNotice;
	// And the one place a cancelled run says it for itself: the host shows such a run its activity and nothing else,
	// so the same text goes there too. A plain cancellation keeps whatever line the child was last on, because that
	// is the useful thing to show for one.
	if (run.aborted && run.cleanupNotice !== undefined) run.activity = run.cleanupNotice;
	if (ended.kind === "prepare") {
		const refused = ended.refused;
		if (refused.session !== undefined) publish(run, { session: refused.session, ...(refused.selection === undefined ? {} : { selection: refused.selection }) });
		return run;
	}
	if (ended.kind === "unverified") {
		if (ended.prepared !== undefined) publish(run, ended.prepared);
		return run;
	}
	if (ended.kind === "none") return run;
	const result = ended.result;
	if (!result.ok) {
		// Exactly the session the task reported, with nothing added to it: a run that failed publishes no point to
		// continue from, and the checkpoint a failed fork keeps is the one it forked at, which is already on it.
		publish(run, { session: result.session, selection: result.selection });
		const last = result.evidence.last;
		// The preview the observer kept, with its own cut marked: without the mark, half of what a child said would
		// be shown as the whole of it, and the run that failed is exactly the one whose text a person reads closely.
		run.text = last === undefined ? "" : last.cut.text ? `${last.text}…` : last.text;
		return run;
	}
	publishUsage(run, result);
	if (diagnostic === undefined) {
		publish(run, { session: result.session, selection: result.selection });
		run.text = result.text ?? "";
		// A success with storage left behind is still a success: the note goes in the report a person reads, and no
		// error message is written for it.
		if (disposal.failed) run.text = run.text === "" ? DISPOSE_WARNING : `${run.text}\n\n${DISPOSE_WARNING}`;
		return run;
	}
	// The demotion: the work is reported as it was read back, and the identity is the one the turn started from, so
	// nothing downstream can record the leaf of a run this host will not call finished.
	publish(run, ended.prepared);
	run.text = result.text ?? "";
	return run;
}

/** How much of a child's latest line of work its activity shows, the same window the Claude backend's own uses. */
export const PI_ACTIVITY_CHARS = 60;

/** How much of a tool result one event may carry. A monitor shows a preview; the result itself stays the child's. */
export const PI_EVENT_TEXT_MAX_CHARS = 4_096;

/** And how much of a tool's arguments: how many fields, how long a name, and how long one rendered value. */
export const PI_EVENT_INPUT_MAX_KEYS = 16;
export const PI_EVENT_KEY_MAX_CHARS = 128;
export const PI_EVENT_FIELD_MAX_CHARS = 1_024;

/** What a value that could not be rendered at all is shown as. Fixed: a stringify error is not something to show. */
const UNSERIALIZABLE = "[unserializable]";

const plain = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** The first `max` code points, so a cut never halves a character, with the cut saying for itself that it happened. */
function capped(value: string, max: number): string {
	const chars = [...value];
	return chars.length <= max ? value : `${chars.slice(0, max).join("")}…`;
}

/** One argument as a string: a primitive as itself, anything structured as json, and nothing kept past the cap. */
function rendered(value: unknown): string {
	if (typeof value === "string") return capped(value, PI_EVENT_FIELD_MAX_CHARS);
	if (value === null || typeof value !== "object") return capped(String(value), PI_EVENT_FIELD_MAX_CHARS);
	try {
		// An object whose own `toJSON` answers nothing renders as nothing at all, which is why this is checked rather
		// than trusted: a caller looking at a field wants something on it, not the word `undefined`.
		const json = JSON.stringify(value);
		return capped(typeof json === "string" ? json : UNSERIALIZABLE, PI_EVENT_FIELD_MAX_CHARS);
	} catch {
		// A cycle, a getter that threw, a bigint: the value is not one this can show, and none of it is kept.
		return UNSERIALIZABLE;
	}
}

/**
 * A tool's arguments as a monitor may hold them: bounded in every direction and flat. The output has a null
 * prototype, because a `__proto__` key from a child's own tool call would otherwise write to this object's
 * prototype rather than into it, and a capped key that collides with one already taken is dropped rather than
 * overwriting it, so what is shown is the first field that claimed the name.
 */
export function boundedInput(args: unknown): Record<string, string> | undefined {
	const source = plain(args);
	if (source === undefined) return undefined;
	const bounded = Object.create(null) as Record<string, string>;
	const keys = Object.keys(source);
	for (const key of keys.slice(0, PI_EVENT_INPUT_MAX_KEYS)) {
		const value = source[key];
		// Absent and present-as-undefined read the same to anyone looking at this, so neither is shown.
		if (value === undefined) continue;
		const name = capped(key, PI_EVENT_KEY_MAX_CHARS);
		if (Object.hasOwn(bounded, name)) continue;
		bounded[name] = rendered(value);
	}
	const extra = keys.length - PI_EVENT_INPUT_MAX_KEYS;
	if (extra > 0) bounded["…"] = `${extra} more fields`;
	return bounded;
}

/** The text of a tool result: a string, or the text blocks of a content array, bounded and never held after. */
export function resultText(result: unknown): string {
	if (typeof result === "string") return capped(result, PI_EVENT_TEXT_MAX_CHARS);
	const content = plain(result)?.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const one = plain(block);
		if (one?.type === "text" && typeof one.text === "string") parts.push(one.text);
	}
	return capped(parts.join("\n"), PI_EVENT_TEXT_MAX_CHARS);
}

/** The first line of the one argument a tool call is worth naming by, cut to the activity window. */
function brief(args: unknown): string {
	const source = plain(args);
	if (source === undefined) return "";
	for (const field of ["command", "path", "file_path", "pattern"]) {
		const value = source[field];
		if (typeof value !== "string") continue;
		return capped(value.split("\n")[0] ?? "", PI_ACTIVITY_CHARS);
	}
	return "";
}

/**
 * A tool's name as a run and a monitor may hold it: the child's own, cut to the name cap, or the one placeholder.
 * It is capped for the same reason a field is — it arrives from the child and goes into an activity line and an
 * event — and under the key cap rather than a cap of its own, because a name is what that cap is for.
 */
const toolName = (value: unknown): string => (typeof value === "string" && value !== "" ? capped(value, PI_EVENT_KEY_MAX_CHARS) : "?");

/**
 * A tool call's id, under that same cap and through this one function, so the id a call is emitted under and the id
 * its result is emitted under are cut identically and still match. An id that is not text is no id at all, and
 * neither is an empty one: emitting every empty id as the same id would file unrelated calls and results under one
 * key in a monitor, which is the one thing having an id is for.
 */
const toolId = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? capped(value, PI_EVENT_KEY_MAX_CHARS) : undefined);

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** What the mapper writes into, kept as two calls so the run's own progress and a monitor's events stay apart. */
export interface PiProgressEmit {
	progress(): void;
	event(event: ChildEvent): void;
}

/** One run's live progress, opened once and closed permanently. Outside that window every record is ignored. */
export interface PiProgressMapper {
	onEvent(event: PiEvent): void;
	begin(): void;
	end(): void;
}

/**
 * The records a child streams, as a run's live progress and a monitor's events. It holds nothing: no message, no
 * result, no history of what a tool did — each record is read for the fields it is counted by and then forgotten,
 * and what a run keeps of one is a number, an activity line or a bounded preview handed straight to the monitor.
 *
 * It never throws back into the transport, which delivers these synchronously and counts a listener's error against
 * the child: a mapper that failed on one record would cost the run the records after it. The window is the other
 * half of that: records before the task's own turn belong to the preparation, and ones after it to the shutdown, so
 * neither is counted as this run's work. `begin` after `end` opens nothing, because a closed run stays closed.
 */
export function progressMapper(run: PiRun, emit: PiProgressEmit): PiProgressMapper {
	let open = false;
	let closed = false;

	const progress = (): void => {
		try {
			emit.progress();
		} catch {
			// Deliberately nothing: a caller's own failure is not a record to lose the ones after it for.
		}
	};
	const event = (child: ChildEvent): void => {
		try {
			emit.event(child);
		} catch {}
	};

	const assistant = (message: unknown): Record<string, unknown> | undefined => {
		const data = plain(message);
		return data?.role === "assistant" ? data : undefined;
	};

	const counted = (message: unknown): void => {
		const usage = plain(assistant(message)?.usage);
		if (usage === undefined) return;
		const input = finite(usage.input);
		const output = finite(usage.output);
		const cacheRead = finite(usage.cacheRead);
		const cacheWrite = finite(usage.cacheWrite);
		// Whole or not at all: a partial reading would add one field of a message and none of the rest, which reads
		// as a run that spent less than it did.
		if (input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined) {
			run.tokensIn += input + cacheRead + cacheWrite;
			run.tokensOut += output;
			run.cacheRead += cacheRead;
			run.cacheWrite += cacheWrite;
			// The prompt of the latest model call, which is what a context line shows, composed from the three
			// components that are that prompt. Pi's own `totalTokens` counts the output too, so a context line read
			// off it would grow with every answer and show a window filling that nothing is actually filling.
			const prompt = input + cacheRead + cacheWrite;
			if (prompt > 0) run.contextTokens = prompt;
		}
		const cost = finite(plain(usage.cost)?.total);
		if (cost !== undefined && cost > 0) run.costUsd = (run.costUsd ?? 0) + cost;
	};

	const map = (record: PiEvent): void => {
		switch (record.type) {
			case "tool_execution_start": {
				run.toolCalls += 1;
				const name = toolName(record.toolName);
				const first = brief(record.args);
				const input = boundedInput(record.args);
				const id = toolId(record.toolCallId);
				event({
					type: "tool_call",
					name,
					brief: first,
					...(id === undefined ? {} : { id }),
					...(input === undefined ? {} : { input }),
				});
				run.activity = first ? `${name} ${first}` : name;
				progress();
				return;
			}
			case "tool_execution_end": {
				// Without an id a monitor has nothing to attach the result to, and a result attached to nothing is
				// worse than none: the call it belongs to would go on showing as unanswered beside it.
				const id = toolId(record.toolCallId);
				if (id !== undefined) event({ type: "tool_result", toolUseId: id, text: resultText(record.result), isError: record.isError === true });
				run.activity = "waiting for model";
				progress();
				return;
			}
			case "message_start": {
				if (assistant(record.message) === undefined) return;
				run.activity = "thinking";
				progress();
				return;
			}
			case "message_end": {
				if (assistant(record.message) === undefined) return;
				counted(record.message);
				run.activity = "writing";
				progress();
				return;
			}
			case "compaction_start":
				run.activity = "compacting";
				progress();
				return;
			case "auto_retry_start":
				run.activity = "retrying";
				progress();
				return;
			default:
				// Token and message updates repeat what the two message records already carry, and the turn and agent
				// records are the task observer's own evidence rather than a run's progress.
				return;
		}
	};

	return {
		begin(): void {
			if (!closed) open = true;
		},
		end(): void {
			open = false;
			closed = true;
		},
		onEvent(record: PiEvent): void {
			if (!open) return;
			try {
				if (plain(record) !== undefined) map(record);
			} catch {
				// A shape nothing expected is a record not counted, never a run ended through the transport.
			}
		},
	};
}
