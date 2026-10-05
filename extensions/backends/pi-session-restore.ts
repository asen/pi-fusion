import * as path from "node:path";
import { CONTROL_CANCELLED, CONTROL_EXTENSION_PATH, FORK_COMMAND, NAVIGATE_COMMAND } from "./pi-control-extension.mjs";
import { type PiChild, type PiExit, type PiFailure, type PiResponse, PiTransportError, type PiTurn } from "./pi-transport.ts";
import type { PiSessionRef, SessionIntent } from "./types.ts";

/**
 * The host's half of a Pi session restore: the one sequence that turns a child which has opened a recorded session
 * into a child standing at the checkpoint a continuation asked for, and says what it stands on. It sends the control
 * command the child's own extension registered, reads the session back and reports; it opens nothing, writes no
 * record, resolves no path and touches no storage, so what a run publishes afterwards is still the caller's decision.
 *
 * What the readbacks establish, and the whole of it: that the child opened the session this call named, that the one
 * bare control command for this intent was registered by this host's own extension at the moment it was asked for,
 * that the prompt carrying it was acknowledged with no extension error behind it, that the session the child stands in
 * afterwards is the source itself for a resume and a distinct session under an absolute file for a fork, and that its
 * leaf is the requested checkpoint. What they do not establish: that the forked transcript holds the source's bytes,
 * what its parent session is, that anything was persisted, or that Pi's own fork and source isolation behave as a
 * continuation would need — none of that is readable from here, and only a real child can qualify it.
 *
 * What this leaf gate can refuse that a person would call legitimate, read from 0.85.1's own source and measured
 * nowhere. It is conditional in every case. `navigateTree` returns `{ cancelled: false }` at once when the target is
 * already the leaf (`core/agent-session.js` 2477-2479), so a checkpoint that is already current passes this gate —
 * having skipped the hooks a real move runs; when navigation does move, a user message or a `custom_message` target
 * leaves the leaf at that entry's *parent* (2573-2589), and that mismatch is what is refused. A fork refuses when the
 * labels it rebuilds are appended after the last retained entry and so advance the leaf past the target, or when the
 * checkpoint is itself a label and is stripped from the path (`core/session-manager.js` 1093-1162, the leaf being the
 * last entry at 686-696) — not merely because a session once held a label. A reconstruction can advance the leaf too,
 * by appending a `thinking_level_change` when the transcript carries no thinking entry (`core/sdk.js` 239-245,
 * `core/session-manager.js` 792-802); a branch or an explicit extension can produce a transcript without one, so
 * nothing here assumes that entry is always already in place.
 *
 * The gate is kept exactly as it is regardless: no second target, no session-manager call around the command, no
 * transcript replay, no checkpoint composed here, and no narrowing of what a durable checkpoint may be to the shapes
 * that happen to pass, because a later role or an explicit extension may write either kind of entry. Which of these
 * shapes a real session produces is unresolved: a compatibility question to settle against a real child before this
 * is enabled, and reading the source is not a measurement of this code.
 *
 * These are sequential snapshots of a child this caller has to itself, not one atomic operation: the extension inside
 * a child is trusted, and a trusted extension can register a command or move the session between two of these steps.
 * Nothing here takes a shortcut for a session already standing at the checkpoint, because the point of the sequence is
 * the evidence rather than the movement.
 *
 * Ownership is the other half of what this module is. An intent this build cannot run and a reference that is not a
 * Pi one are refused by throwing, before a request, a turn or a shutdown, so a caller that composed the wrong call
 * still holds the child it started. Past that point the child is this call's: every refusal asks it to stop, once, and
 * hands back whatever that attempt reported. A success hands the child back running, because the run it was started
 * for is what comes next.
 */

/** The part of a child a restore drives, and all of it: one command, one prompt, and the stop a refusal asks for. */
export type RestoreChild = Pick<PiChild, "request" | "turn" | "shutdown">;

/**
 * Where a restore stopped. `reference` is a reference this host could not act on at all, `aborted` a caller that
 * cancelled at one of the boundaries below, `state` the child's own opened session, `commands` the control command it
 * was to be moved with, `turn` a prompt that was never acknowledged, `operation` the command's own failure, and
 * `postcondition` a session that was acknowledged as moved and did not read back as moved. `transport` is everything
 * that threw rather than answered: a step of the sequence, and an unexpected throw while the reference itself was
 * being read, which is inside the owned part of the call rather than in front of it.
 */
export type PiRestoreReason = "reference" | "aborted" | "state" | "commands" | "turn" | "operation" | "postcondition" | "transport";

/**
 * A restore that reported the session it verified: the session the child stands in, the checkpoint its own tree
 * confirmed rather than the one it was asked for, and the raw state it answered with beside it.
 *
 * What this is is a verified preparation state, and it is not authority over any record. Whether a run's session and
 * checkpoint are written down is decided from that run's own outcome, afterwards and elsewhere: a task that fails
 * after this succeeded is not made recordable by it, and the checkpoint confirmed here is not one to publish on a run
 * that did not finish.
 */
export interface PiRestoreDone {
	ok: true;
	session: PiSessionRef & { checkpoint: string };
	state: Record<string, unknown>;
}

/**
 * A restore that did not, and the evidence it kept. `cancelled` is the one operation failure this host can name: the
 * control extension's own cancellation sentence, from the command it sent. `exit` is what the shutdown reported, kept
 * exactly as it was — a root nothing could stop, a held pipe and leftovers included — and `unverified` with the
 * original `shutdownError` beside it is a shutdown that threw instead, where no exit is invented for it.
 *
 * `error` and `shutdownError` are values from somewhere else, kept so a person reading a failure has what there was.
 * Keeping them here is not permission to put either of them into a record, a card or anything a user reads.
 */
export interface PiRestoreRefused {
	ok: false;
	reason: PiRestoreReason;
	cancelled?: boolean;
	turn?: PiTurn;
	failure?: PiFailure;
	error?: unknown;
	exit?: PiExit;
	unverified?: true;
	shutdownError?: unknown;
}

export type PiRestore = PiRestoreDone | PiRestoreRefused;

/** A refusal as the sequence decides it, before the cleanup that every refusal attempts adds its own report to it. */
type Refusal = Omit<PiRestoreRefused, "exit" | "unverified" | "shutdownError">;

/** What a restore is: which control command moves the session, and what the session has to look like afterwards. */
interface RestorePlan {
	kind: "resume" | "fork";
	command: string;
	ref: PiSessionRef;
}

/** The three primitives a restore is decided by, read off the reference once and never read again. */
interface RestoreSource {
	sessionId: string;
	sessionFile: string;
	checkpoint: string;
}

/** The session a `get_state` answer names, with the whole answer kept: what its other fields mean is not read here. */
interface OpenedSession {
	sessionId: string;
	sessionFile: string;
	raw: Record<string, unknown>;
}

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

const refused = (reason: PiRestoreReason, detail: Omit<Refusal, "ok" | "reason"> = {}): Refusal => ({ ok: false, reason, ...detail });

/**
 * The command an intent is carried out by, or a refusal to take the child at all. A new session moves nowhere and a
 * reference another backend wrote names a session this one cannot open, so both are the caller's own mistake: they
 * throw, before anything is sent and before this call could be said to own the child.
 */
function restorePlan(intent: SessionIntent): RestorePlan {
	const asked = record(intent);
	const kind = asked?.kind;
	if (kind === "resume" || kind === "fork") {
		const ref = record(kind === "resume" ? asked?.ref : asked?.from);
		if (ref?.backend === "pi") return { kind, command: kind === "resume" ? NAVIGATE_COMMAND : FORK_COMMAND, ref: ref as unknown as PiSessionRef };
		throw new TypeError("a pi session is restored from a pi reference, and this intent carries another backend's");
	}
	throw new TypeError("a restore continues a recorded session, so its intent is a resume or a fork");
}

/**
 * The reference read into the three values the rest of this file uses, taken before the first await so that a caller
 * mutating its own record afterwards cannot change what was checked into something else. A blank field and a session
 * file that is not absolute are references this host cannot act on: the emptiness is tested on a trimmed copy and
 * every value kept is the one that arrived, because a session id and a path are identities rather than text to tidy.
 */
function restoreSource(ref: PiSessionRef): RestoreSource | undefined {
	const sessionId = ref.sessionId;
	const sessionFile = ref.sessionFile;
	const checkpoint = ref.checkpoint;
	if (!nonblank(sessionId) || !nonblank(sessionFile) || !nonblank(checkpoint)) return undefined;
	return path.isAbsolute(sessionFile) ? { sessionId, sessionFile, checkpoint } : undefined;
}

/**
 * The data of an answer this restore may act on. A failed response with plausible data answers no step of this one,
 * and the success is compared against `true` itself rather than taken for whatever is truthy in that field.
 */
const answered = (response: PiResponse): Record<string, unknown> | undefined => (response.success === true ? record(response.data) : undefined);

/** The session a state answer names, and nothing about it while the child is streaming: a moving session is not one to read. */
function openedSession(response: PiResponse): OpenedSession | undefined {
	const data = answered(response);
	if (!data || data.isStreaming !== false) return undefined;
	const { sessionId, sessionFile } = data;
	return nonblank(sessionId) && nonblank(sessionFile) ? { sessionId, sessionFile, raw: data } : undefined;
}

/**
 * Whether the child has, right now, exactly the one control command this intent sends, from this host's own
 * extension. One bare name: this Pi renames every registration of a name two extensions both use to `name:n`, so a
 * bare name that is there is the only one of it, and a row carrying that name with a suffix says some other command
 * is reachable under a name this one's own could become. A row this host cannot read a name off is left alone — it is
 * neither the command nor a suffixed one — and what else a row carries is Pi's business rather than this check's.
 *
 * This is metadata about registrations, read once, and not an authentication of the code behind them: the extension
 * is trusted and can register over this between now and the prompt below.
 */
function hasControlCommand(response: PiResponse, command: string): boolean {
	const rows = answered(response)?.commands;
	if (!Array.isArray(rows)) return false;
	const bare: Record<string, unknown>[] = [];
	for (const row of rows) {
		const entry = record(row);
		const name = entry?.name;
		if (entry === undefined || typeof name !== "string") continue;
		if (name === command) bare.push(entry);
		else if (name.startsWith(`${command}:`)) return false;
	}
	if (bare.length !== 1) return false;
	const one = bare[0];
	return one.source === "extension" && record(one.sourceInfo)?.path === CONTROL_EXTENSION_PATH;
}

/**
 * Whether the operation the child ran reported itself cancelled, which is the one thing this host can read out of an
 * extension error: the control extension's own fixed sentence, from the command this call sent, whole. A cut field is
 * a prefix rather than the sentence, so each of the three has to say `false` itself — not merely something falsy —
 * before the sentence behind it counts; anything else the command failed with is an operation failure without a name,
 * and never a success.
 */
function cancelledOperation(turn: PiTurn, command: string): boolean {
	const last = turn.lastExtensionError;
	if (!last || last.cut.error !== false || last.cut.event !== false || last.cut.extensionPath !== false) return false;
	return last.error === CONTROL_CANCELLED && last.event === "command" && last.extensionPath === `command:${command}`;
}

/**
 * Whether the session read back is the one this intent was supposed to leave the child in. A resume ends in the source
 * itself, by both halves of its identity. A fork ends somewhere else: a session whose id and whose file are both other
 * than the source's, and whose file is absolute, which is what a distinct identity means here — not that the transcript
 * holds what the source held, and not that either file was written.
 */
function movedTo(kind: RestorePlan["kind"], after: OpenedSession, source: RestoreSource): boolean {
	if (kind === "resume") return after.sessionId === source.sessionId && after.sessionFile === source.sessionFile;
	return after.sessionId !== source.sessionId && after.sessionFile !== source.sessionFile && path.isAbsolute(after.sessionFile);
}

const leafIs = (response: PiResponse, checkpoint: string): boolean => answered(response)?.leafId === checkpoint;

const stopped = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/**
 * The cleanup every refusal attempts, once. It is an attempt and not a promise that the process stopped: what the
 * shutdown reported travels back exactly as it was reported, and a shutdown that threw is `unverified` with the value
 * it threw kept and no exit guessed for it. The reason this restore already decided is what the stop is asked under
 * and what comes back — a signal that aborts while the child is stopping renames nothing that has already happened.
 */
async function settle(child: RestoreChild, refusal: Refusal): Promise<PiRestore> {
	try {
		const exit = await child.shutdown(refusal.reason === "aborted" ? "aborted" : "host");
		return { ...refusal, exit };
	} catch (shutdownError) {
		return { ...refusal, unverified: true, shutdownError };
	}
}

/**
 * The sequence itself. The signal is read at each boundary — before every call that goes to the child, and once more
 * after the last answer is in — and nowhere else: a cancellation that lands inside a call is the caller's own signal
 * on the child it started, so nothing here adds a listener, a timer or a race of its own.
 */
async function runRestore(child: RestoreChild, plan: RestorePlan, source: RestoreSource, signal: AbortSignal | undefined): Promise<PiRestoreDone | Refusal> {
	if (stopped(signal)) return refused("aborted");
	const opened = openedSession(await child.request({ type: "get_state" }));
	if (!opened || opened.sessionId !== source.sessionId || opened.sessionFile !== source.sessionFile) return refused("state");

	if (stopped(signal)) return refused("aborted");
	if (!hasControlCommand(await child.request({ type: "get_commands" }), plan.command)) return refused("commands");

	if (stopped(signal)) return refused("aborted");
	// The prompt is the command line the child's own parser reads: the bare name, one space, and the entry id as a json
	// document, so an id holding a space, a quote or a newline arrives as the one string it is. The turn ends at the
	// acknowledgement because a control command runs no agent loop, and nothing is read back until it has.
	const turn = await child.turn(`/${plan.command} ${JSON.stringify(source.checkpoint)}`, { completion: "acknowledged" });
	if (turn.outcome !== "acknowledged") return refused("turn", { turn });
	if (turn.extensionErrors !== 0) return refused("operation", { turn, ...(cancelledOperation(turn, plan.command) ? { cancelled: true } : {}) });

	if (stopped(signal)) return refused("aborted");
	const after = openedSession(await child.request({ type: "get_state" }));
	if (!after || !movedTo(plan.kind, after, source)) return refused("postcondition");

	if (stopped(signal)) return refused("aborted");
	if (!leafIs(await child.request({ type: "get_tree" }), source.checkpoint)) return refused("postcondition");

	if (stopped(signal)) return refused("aborted");
	// The session the child says it is in now, and the checkpoint its own tree just confirmed as the leaf: a reference
	// built out of what was read back rather than out of what was asked for.
	return { ok: true, session: { backend: "pi", sessionId: after.sessionId, sessionFile: after.sessionFile, checkpoint: source.checkpoint }, state: after.raw };
}

/**
 * One restore, start to finish, with one place the child is stopped and one place a thrown value is read.
 *
 * The intent is checked first and throws for what this build cannot run, outside everything below, so a caller that
 * composed the wrong call still holds the child it started and nothing was stopped for it. Past that the child is
 * this call's, and reading the reference is part of the work rather than something in front of it: a field this host
 * cannot act on is an ordinary `reference` refusal, while a reference that threw while it was being read takes the
 * same path as any other step that threw. A step that threw rather than answered is a transport failure whichever way
 * it threw: the transport's own error carries its typed failure and reads as a cancellation when that is what it was,
 * and anything else is kept as the value it was, `undefined` included, so a failure nobody expected is still evidence.
 *
 * Whatever comes of all that is one outcome. A refusal gets exactly one shutdown attempt, whichever refusal it is; a
 * success gets none at all, and hands the child back to the caller still running.
 */
export async function restoreSession(child: RestoreChild, intent: SessionIntent, options: { signal?: AbortSignal } = {}): Promise<PiRestore> {
	const plan = restorePlan(intent);
	let outcome: PiRestoreDone | Refusal;
	try {
		const source = restoreSource(plan.ref);
		outcome = source === undefined ? refused("reference") : await runRestore(child, plan, source, options.signal);
	} catch (error) {
		if (error instanceof PiTransportError) {
			const failure = error.failure;
			outcome = refused(failure.kind === "aborted" ? "aborted" : "transport", { failure, error });
		} else {
			outcome = refused("transport", { error });
		}
	}
	return outcome.ok ? outcome : await settle(child, outcome);
}
