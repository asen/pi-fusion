import { type PiPrepared, type PiUsageBaseline, usageReading } from "./pi-prepare.ts";
import type { PiQuestionOutcome } from "./pi-question-routing.ts";
import { type PiEvent, type PiExit, type PiExtensionError, type PiFailure, type PiResponse, PiTransportError, type PiTurn } from "./pi-transport.ts";
import type { ChildControl, PiSessionRef, ResolvedSelection } from "./types.ts";

/**
 * One task turn on a child this host has already prepared, and nothing around it: the prompt goes out once, the steers
 * the caller pushes go out beside it, the records the child streams are counted as evidence, and what the child is
 * standing in afterwards is read back before anything is called a success. It starts no child, allocates and disposes
 * no storage, opens no session and writes no record, and nothing constructs one of these yet.
 *
 * **What a result is.** `PiTaskResult` is this module's own reading of one turn, and it is explicitly **not** a
 * backend outcome: it names no `ChildRun`, decides no record and publishes nothing. The runner that will sit above it
 * is what turns one into the other, and the one rule that shape owes the record layer is that `outcome.ok` and a
 * checkpoint may only ever come from `ok: true` here. Everything else `piDecision` already decides for itself and
 * this module does not touch: a failed call on a new session keeps the identity it verified with no checkpoint, a
 * failed resume leaves the recorded source authoritative, and a failed fork keeps the fork's own identity with the
 * checkpoint it forked at.
 *
 * **The gate**, in this one order and read before and after every call this module issues to the child: the run's own
 * cancellation, a child that has gone, then a question whose outcome was fatal. The child's end is observed with both
 * handlers, because a cleanup that produced no report rejects and is still the end of the child, and one microtask
 * turn is spent before the first request so a child that had already finished is read as gone rather than sent a
 * prompt.
 *
 * **What the readbacks establish.** Before the prompt: that the session is standing exactly where the caller said it
 * was, which for a continuation is the recorded checkpoint itself and for a new session is a leaf that is either
 * absent or a real entry. After the settled turn: that this host saw at least as many records **of this turn** as the
 * turn itself counted, measured from a mark taken immediately before the prompt rather than from everything the
 * observer ever saw; that no extension error was reported from either side; that the last assistant message this host
 * saw stopped for the one reason a finished answer stops for, which is the whole of the answer check and is why an
 * `agent_end` that is the only record of that answer can still carry a success; that the child is still idle in the
 * same session running the same selection; that the leaf has moved to a new entry; that the statistics read back
 * whole and no component of the delta against the preparation's baseline is negative; and that the child can name its
 * last assistant text. What they do not establish: what the transcript holds, that anything was persisted, or that a
 * leaf of any particular entry kind is what a checkpoint should be — the leaf is taken as it comes, with no filter on
 * what kind of entry it is, and whether that is the right checkpoint for every shape a real session produces stays
 * the same open compatibility question the restore helper's own exact-leaf gate records.
 *
 * **One shutdown, on every path.** The caller's input is closed first, always; then this child is stopped exactly
 * once, whether the turn failed, a gate ended the task, a readback refused or everything succeeded. A success is only
 * a success once that shutdown has reported and reported no `PiExit.failure` — and that field is the transport's own
 * verdict on how the child ended and nothing more. Its absence is **not** evidence that no pipe was still held, that
 * discovery was available, that nothing was left over, that no identity was skipped or that no deadline was hit: the
 * whole cleanup report travels back uninterpreted, for the storage-retention policy that will one day read it.
 * Nothing here reads it further, and nothing here removes a call's storage.
 */

/** How much of one assistant message this host keeps: a preview for a person to read, never the message itself. */
export const PI_TASK_TEXT_MAX_CHARS = 512;

/** And how much of the error one carried. Both cuts are prefixes, and each says for itself that it cut something. */
export const PI_TASK_ERROR_MAX_CHARS = 4_096;

/** How many steers may wait unsent at once. A push past it is answered `false` rather than queued or dropped. */
export const PI_STEER_QUEUE_MAX = 64;

/** The one reason a finished assistant message stops for. Anything else is a turn that did not produce an answer. */
const FINAL_STOP_REASON = "stop";

/**
 * The last assistant message this host saw, reduced to what evidence needs: why it stopped, a bounded preview of its
 * text and the error it carried. The message itself is never kept — the transcript is the child's, and a record, a
 * card and a log are all the wrong place for it.
 */
export interface PiAssistantRecord {
	/** Which record it was read off. `agent_end` is a fallback: it repeats messages a `message_end` already carried. */
	from: "message_end" | "agent_end";
	stopReason?: string;
	/** The message's text blocks joined, cut to `PI_TASK_TEXT_MAX_CHARS` code points so no character is halved. */
	text: string;
	errorMessage?: string;
	cut: { text: boolean; errorMessage: boolean };
}

/**
 * What one task turn's records amounted to, as this host counted them. Every number is of records seen since `begin`,
 * and nothing here is a decision: a tool that failed is evidence and not a reason to fail a run, because a model that
 * ran a failing command and carried on is doing its work.
 */
export interface PiTaskEvidence {
	/** Every record this observer was handed, whatever it was. */
	events: number;
	/** Assistant messages, counted at `message_end` alone: `agent_end` repeats them, and `turn_end` repeats one. */
	assistantMessages: number;
	agentEnds: number;
	toolStarts: number;
	toolErrors: number;
	compactions: number;
	autoRetries: number;
	extensionErrors: number;
	last?: PiAssistantRecord;
}

/**
 * The observer one task's records are counted through. It is task-local and defensive: it is handed whatever the
 * transport read, it never throws back into the transport's own delivery, and `begin` erases everything before it, so
 * the records a preparation produced can never be counted as a turn's.
 */
export interface PiTaskObserver {
	onEvent(event: PiEvent): void;
	/** Erases every count. The run calls it once, inside the block that owns the child, and nothing else calls it. */
	begin(): void;
	/** A frozen copy: what a caller holds after a result is what was true when it was taken. */
	snapshot(): PiTaskEvidence;
}

/**
 * What one steer's delivery came to when it was not admitted, kept by presence rather than by shape. `code` says
 * which of the three it was, because the counters are the account and a reader of the last one should not have to
 * infer it from which other fields happen to be there.
 */
export interface PiSteerFailure {
	code: "rejected" | "refused" | "failed";
	/** The child answered and said no: the error string that response carried, absent when it carried none. */
	response?: string;
	/** The transport's own typed failure, for a value that was one of its errors. */
	failure?: PiFailure;
	/** The value that was thrown, present even when it is `undefined`, because a throw is evidence either way. */
	error?: unknown;
}

/**
 * One steer queue's whole account of itself, frozen. Every counter but `pushed` is the outcome of a delivery this
 * queue attempted, and `pushed` is what it took in: after the queue is closed and idle, `pushed` is exactly
 * `sent + rejected + refused + failed + dropped`, because every steer taken in ends as one of those five.
 *
 * A push this queue would not take at all — a value that is not text, a closed queue, a queue with no room — is
 * answered to its caller with `false` and is counted nowhere here, because it never became a delivery and counting it
 * beside the child's own answers would read as one.
 */
export interface PiSteerReport {
	open: boolean;
	/** Steers taken into the queue. */
	pushed: number;
	/** Steers the child admitted. */
	sent: number;
	/** Steers the child answered and said no to. */
	rejected: number;
	/** Steers the transport itself would not send: refused, busy, closed, or a child that had gone. */
	refused: number;
	/** Steers whose delivery threw anything else. Never retried: a steer is a message, not a transaction. */
	failed: number;
	/** Steers still queued and unsent when the queue closed. */
	dropped: number;
	lastFailure?: PiSteerFailure;
}

/** Where one steer goes. The queue maps what comes back; it names no child and sends nothing itself. */
export type PiSteerSink = (text: string) => Promise<PiResponse>;

/** This turn's own share of the child's statistics: the final reading less the preparation's baseline. */
export interface PiUsageDelta {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * Both readings and the share between them: `before` is the baseline the preparation took, `after` the reading this
 * task ended on, and `delta` the one subtracted from the other. Both are kept because a share on its own says nothing
 * about the session it was taken in, and a reader that has to check the arithmetic needs what it was done on.
 */
export interface PiTaskUsage {
	before: PiUsageBaseline;
	after: PiUsageBaseline;
	delta: PiUsageDelta;
}

/**
 * Where a task stopped, one name per end and no collapsing of two into one. `aborted`, `exited` and `rejected` are
 * the turn's own ends of those names, and the first two are also what the gate and a transport error of that kind
 * say; `turn` is a turn that failed or came back merely acknowledged; `question` a dialog nobody could answer;
 * `unobserved` a turn whose records this host saw fewer of than the turn itself counted; `extension` an extension
 * error from either side; `failed` a turn that produced no finished answer; `state`, `leaf`, `usage` and `text` the
 * four readbacks; `cleanup` a shutdown that reported a failure or threw; and `transport` everything else that threw
 * rather than answered.
 */
export type PiTaskReason = "aborted" | "exited" | "question" | "rejected" | "turn" | "unobserved" | "extension" | "failed" | "leaf" | "state" | "usage" | "text" | "cleanup" | "transport";

/** One task that ran and read back whole, with the child stopped and its stop reporting no failure of its own. */
export interface PiTaskDone {
	ok: true;
	/** The session it ran in, with the leaf this turn left as the checkpoint. The one result a record may publish. */
	session: PiSessionRef & { checkpoint: string };
	selection: ResolvedSelection;
	usage: PiTaskUsage;
	/** What the child names as its last assistant text, or null when it names none. */
	text: string | null;
	turn: PiTurn;
	evidence: PiTaskEvidence;
	steers?: PiSteerReport;
	exit: PiExit;
}

/**
 * A task that did not, and the evidence it kept. `session` is the session the preparation verified, exactly as it was
 * and with no checkpoint added to it: a task that failed publishes no point to continue from. `leaf` is there for one
 * case alone — a cleanup that failed after the work itself had read back whole — and it is evidence a person may look
 * at rather than a checkpoint, because the run it belongs to is not one this host may call finished.
 *
 * `error` and `shutdownError` are values from somewhere else, kept so a person reading a failure has what there was.
 * Keeping them here is not permission to put either of them into a record, a card or anything a user reads.
 */
export interface PiTaskRefused {
	ok: false;
	reason: PiTaskReason;
	session: PiSessionRef;
	selection: ResolvedSelection;
	turn?: PiTurn;
	outcome?: PiQuestionOutcome;
	leaf?: string;
	/** The typed failure the turn itself reported, where it had one, or the one a thrown transport error carried. */
	failure?: PiFailure;
	/** The last extension error the turn kept, for a turn that reported one. Bounded by the transport, not here. */
	extensionError?: PiExtensionError;
	error?: unknown;
	evidence: PiTaskEvidence;
	steers?: PiSteerReport;
	exit?: PiExit;
	unverified?: true;
	shutdownError?: unknown;
}

export type PiTaskResult = PiTaskDone | PiTaskRefused;

/** One task, as the caller composes it. The prepared child is the whole of what it runs on. */
export interface PiTaskRequest {
	prepared: PiPrepared;
	/** The prompt, sent exactly as it was composed: nothing here trims, wraps or appends to it. */
	prompt: string;
	/** The observer the preparation's own `onEvent` feeds. The run begins it, and nothing else reads it. */
	observer: PiTaskObserver;
	signal?: AbortSignal;
	/** Where the caller pushes steers. Without one the task runs the prompt alone. */
	input?: PiSteerQueue;
}

const plain = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The data of an answer this task may act on: a failed response answers no step of it, whatever it carries. */
const answered = (response: PiResponse): Record<string, unknown> | undefined => (response.success === true ? plain(response.data) : undefined);

/** The first `max` code points of a text, so a cut never leaves half a character behind. */
function keepFirstChars(value: string, max: number): { text: string; cut: boolean } {
	const chars = [...value];
	return chars.length <= max ? { text: value, cut: false } : { text: chars.slice(0, max).join(""), cut: true };
}

/**
 * One assistant message reduced to a record, or nothing at all for a message of another role. The content is read
 * as the two shapes Pi writes — one string, or blocks of which the text ones are joined — and everything else on it,
 * the thinking and the tool calls included, is left where it is.
 */
function assistantRecord(message: unknown, from: PiAssistantRecord["from"]): PiAssistantRecord | undefined {
	const data = plain(message);
	if (data === undefined || data.role !== "assistant") return undefined;
	const parts: string[] = [];
	const content = data.content;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const block of content) {
			const one = plain(block);
			if (one?.type === "text" && typeof one.text === "string") parts.push(one.text);
		}
	}
	const text = keepFirstChars(parts.join("\n"), PI_TASK_TEXT_MAX_CHARS);
	const error = typeof data.errorMessage === "string" ? keepFirstChars(data.errorMessage, PI_TASK_ERROR_MAX_CHARS) : undefined;
	return {
		from,
		...(typeof data.stopReason === "string" ? { stopReason: data.stopReason } : {}),
		text: text.text,
		...(error === undefined ? {} : { errorMessage: error.text }),
		cut: { text: text.cut, errorMessage: error !== undefined && error.cut },
	};
}

/** The last assistant message in what an `agent_end` carried, which is a repeat of ones already streamed. */
function lastAssistant(messages: unknown): PiAssistantRecord | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let at = messages.length - 1; at >= 0; at -= 1) {
		const record = assistantRecord(messages[at], "agent_end");
		if (record !== undefined) return record;
	}
	return undefined;
}

const emptyEvidence = (): PiTaskEvidence => ({ events: 0, assistantMessages: 0, agentEnds: 0, toolStarts: 0, toolErrors: 0, compactions: 0, autoRetries: 0, extensionErrors: 0 });

/**
 * The counting itself, kept apart from the observer so that the observer's own catch is the only thing between it and
 * the transport. Each record is read for the one field it is counted by and for nothing else.
 */
function count(state: PiTaskEvidence, event: PiEvent): void {
	state.events += 1;
	switch (event.type) {
		case "message_end": {
			// The one place an assistant message is counted. `turn_end` carries the same message again and `agent_end`
			// carries the whole run's, so counting either of those would count one answer two or three times.
			const record = assistantRecord(event.message, "message_end");
			if (record !== undefined) {
				state.assistantMessages += 1;
				state.last = record;
			}
			return;
		}
		case "agent_end": {
			state.agentEnds += 1;
			// A fallback and not a count: it refreshes what this host knows of the last answer for a stream whose
			// `message_end` never arrived, and it leaves `assistantMessages` where it was either way.
			const record = lastAssistant(event.messages);
			if (record !== undefined) state.last = record;
			return;
		}
		case "tool_execution_start":
			state.toolStarts += 1;
			return;
		case "tool_execution_end":
			// Evidence alone: a tool that failed is ordinary work, and no run is failed here for one.
			if (event.isError === true) state.toolErrors += 1;
			return;
		case "compaction_end":
			state.compactions += 1;
			return;
		case "auto_retry_start":
			state.autoRetries += 1;
			return;
		case "extension_error":
			state.extensionErrors += 1;
			return;
		default:
			return;
	}
}

const frozenEvidence = (state: PiTaskEvidence): PiTaskEvidence => Object.freeze({ ...state, ...(state.last === undefined ? {} : { last: Object.freeze({ ...state.last, cut: Object.freeze({ ...state.last.cut }) }) }) });

/**
 * One task's observer. It counts and it forgets: no whole message, no record of what a tool did and no history of the
 * stream. Every call into it is guarded, because the transport delivers these synchronously and counts a listener's
 * error against the child — evidence that threw would cost a record the run actually needs.
 */
export function taskObserver(): PiTaskObserver {
	let state = emptyEvidence();
	return {
		begin(): void {
			state = emptyEvidence();
		},
		onEvent(event: PiEvent): void {
			try {
				if (plain(event) !== undefined) count(state, event);
			} catch {
				// Deliberately nothing: this is a tally, and no shape a child streamed may end a turn through it.
			}
		},
		snapshot(): PiTaskEvidence {
			return frozenEvidence(state);
		},
	};
}

/**
 * The transport's own ways of saying it would not send a steer at all: no room in front of the child's stdin, a turn
 * already running, a transport that is closing, and a child that has gone. Each of them means nothing was written, so
 * they are one outcome apart from a delivery that broke on the way.
 */
const DECLINED = new Set(["refused", "busy", "closed", "exited"]);

/**
 * The steers of one task, in the order they were pushed. It holds them until a sink is attached, sends them one at a
 * time and one attempt each, and accounts for the delivery of every one of them: a steer is a message the user typed,
 * so losing one silently is the failure this counts its way out of.
 *
 * The three delivery ends are kept apart because they mean different things to whoever reads them: the child
 * answering and saying no is `rejected`, the transport declining to send at all — refused, busy, closed, or a child
 * that has gone — is `refused`, and anything else that threw is `failed`. A push this queue would not take is none of
 * those: it never reached a child, so it is answered `false` to its caller and counted nowhere.
 *
 * What it will not do: retry. A steer that did not arrive is one that did not arrive, and sending it again after the
 * turn has moved on would deliver a correction to work that no longer exists.
 *
 * `end` is the close, and it is final: what is still queued is dropped and counted, an attempt already in flight is
 * left to finish, and `idle` is how a caller waits for that one. Both are what the shutdown order needs — the host
 * stops accepting steers before it stops the child.
 */
export class PiSteerQueue implements ChildControl {
	private readonly queued: string[] = [];
	private readonly counters = { pushed: 0, sent: 0, rejected: 0, refused: 0, failed: 0, dropped: 0 };
	private closed = false;
	private sink: PiSteerSink | undefined = undefined;
	private draining: Promise<void> | undefined = undefined;
	private lastFailure: PiSteerFailure | undefined = undefined;

	get open(): boolean {
		return !this.closed;
	}

	/**
	 * Takes one steer, or answers `false`. The type check is a runtime one because this is what a tool hands the host.
	 * None of the three ways this says no touches a counter: a value that is not text, a closed queue and a queue with
	 * no room are this queue's own answers to its caller, and putting them beside the child's own answers would make a
	 * steer that never left this process read as one a child turned down.
	 */
	push(text: string): boolean {
		if (typeof text !== "string" || this.closed || this.queued.length >= PI_STEER_QUEUE_MAX) return false;
		this.queued.push(text);
		this.counters.pushed += 1;
		this.pump();
		return true;
	}

	/**
	 * The one sink this queue sends through, attached once. A second attach is the caller composing two runs onto one
	 * queue, which would send one user's steers into another's turn, so it throws rather than picking one; a sink that
	 * is not callable is the same kind of composition error and is refused the same way, before a steer is handed to
	 * something that cannot take it.
	 */
	attach(sink: PiSteerSink): void {
		if (typeof sink !== "function") throw new TypeError("a steer queue sends through a function, and this is not one");
		if (this.sink !== undefined) throw new TypeError("a steer queue sends to one child, and this one already has one");
		this.sink = sink;
		this.pump();
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.counters.dropped += this.queued.length;
		this.queued.length = 0;
	}

	/** Resolves when nothing is in flight. It never rejects: an attempt's own failure is a count, not a throw. */
	async idle(): Promise<void> {
		while (this.draining !== undefined) await this.draining;
	}

	/** A frozen snapshot, so what a result carries cannot change after the result was handed back. */
	report(): PiSteerReport {
		return Object.freeze({
			open: this.open,
			...this.counters,
			...(this.lastFailure === undefined ? {} : { lastFailure: Object.freeze({ ...this.lastFailure }) }),
		});
	}

	private pump(): void {
		if (this.draining !== undefined || this.sink === undefined || this.queued.length === 0) return;
		this.draining = this.drain();
	}

	/** One at a time, in order, until there is nothing left: a steer sent beside the one before it would race it. */
	private async drain(): Promise<void> {
		try {
			for (;;) {
				const text = this.queued.shift();
				if (text === undefined) return;
				await this.attempt(text);
			}
		} finally {
			this.draining = undefined;
		}
	}

	/** One attempt, and the whole of what may come of it. Nothing escapes: the account is the only thing kept. */
	private async attempt(text: string): Promise<void> {
		const sink = this.sink;
		if (sink === undefined) return;
		try {
			const response = await sink(text);
			if (response?.success === true) {
				this.counters.sent += 1;
				return;
			}
			// The child had it and said no. That is its answer about this steer, and it is not the transport declining.
			this.counters.rejected += 1;
			this.lastFailure = { code: "rejected", ...(typeof response?.error === "string" ? { response: response.error } : {}) };
		} catch (error) {
			const failure = error instanceof PiTransportError ? error.failure : undefined;
			if (failure !== undefined && DECLINED.has(failure.kind)) {
				// The transport would not send it: there was no room, a turn was already running, it was closing, or the
				// child had gone. Nothing reached a model, and the steer is not tried again for it.
				this.counters.refused += 1;
				this.lastFailure = { code: "refused", failure, error };
				return;
			}
			this.counters.failed += 1;
			// Everything else, the typed failures of other kinds included, with the value itself kept either way and
			// `undefined` among the values it may be.
			this.lastFailure = { code: "failed", ...(failure === undefined ? {} : { failure }), error };
		}
	}
}

/** A refusal as the sequence decides it, before the one shutdown and the evidence are added to it. */
interface Decided {
	reason: PiTaskReason;
	turn?: PiTurn;
	outcome?: PiQuestionOutcome;
	leaf?: string;
	failure?: PiFailure;
	extensionError?: PiExtensionError;
	error?: unknown;
}

/** What the one shutdown attempt added: the report it made, or the value it threw with nothing invented for it. */
type Stopped = { exit: PiExit } | { unverified: true; shutdownError: unknown };

/** The evidence and the steer account as one pair, taken at the moment a path decides and frozen there. */
interface Taken {
	evidence: PiTaskEvidence;
	steers?: PiSteerReport;
}

/** How the turn ended, as one value that never rejects, so a race against it leaves nothing unhandled. */
type Finished = { kind: "turn"; turn: PiTurn } | { kind: "threw"; error: unknown };

/** What a thrown value is kept as. The transport's own error carries a typed failure; anything else is just itself. */
function detail(error: unknown): { failure?: PiFailure; error: unknown } {
	return error instanceof PiTransportError ? { failure: error.failure, error } : { error };
}

/**
 * What a thrown value is refused under. Two of the transport's own kinds name an end this task has a name for and
 * keeps: a cancellation is a cancellation whichever layer noticed it, and a child that has gone is gone. Every other
 * kind, and every value that is not one of these errors at all, is a transport failure.
 */
function thrownReason(error: unknown): PiTaskReason {
	if (!(error instanceof PiTransportError)) return "transport";
	if (error.failure.kind === "aborted") return "aborted";
	return error.failure.kind === "exited" ? "exited" : "transport";
}

/** A thrown value as a whole refusal: its own reason, its typed failure where there is one, and the value itself. */
const thrown = (error: unknown): Decided => ({ ...detail(error), reason: thrownReason(error) });

/**
 * How a turn that did not settle is refused. Each end keeps its own name rather than collapsing into one: a turn that
 * was cancelled and a child that went away are the two this host also decides for itself, a prompt the child would
 * not take is `rejected` with the acknowledgement it came back with, and a turn that failed or came back merely
 * acknowledged is `turn` — the last of those because this call asked to be done at `agent_settled`, so an
 * acknowledgement is a turn that ended where no work can be read out of it.
 */
function turnReason(outcome: PiTurn["outcome"]): PiTaskReason {
	if (outcome === "aborted") return "aborted";
	if (outcome === "exited") return "exited";
	return outcome === "rejected" ? "rejected" : "turn";
}

/** The leaf a tree answer names: an entry, or nothing at all for a session with no entry in it yet. */
function readLeaf(response: PiResponse): { leaf: string | null } | undefined {
	const data = answered(response);
	if (data === undefined) return undefined;
	const leafId = data.leafId;
	if (leafId === null) return { leaf: null };
	return nonblank(leafId) ? { leaf: leafId } : undefined;
}

/**
 * Whether the session is standing where the caller said it was before the prompt goes out. A continuation stands at
 * the exact checkpoint its record names, which is what the restore verified and what a second call would repeat; a new
 * session stands at whatever its own opening left, which is nothing at all or one real entry.
 */
function standsAt(read: { leaf: string | null } | undefined, checkpoint: string | undefined): boolean {
	if (read === undefined) return false;
	return checkpoint === undefined ? true : read.leaf === checkpoint;
}

/**
 * Whether the child is still the same child doing nothing else: the session it was prepared in, by both halves of
 * that identity, the selection it was prepared with, exactly and by both parts, and a session that is neither
 * streaming nor compacting. The selection is compared rather than resolved again, because the one this task may
 * report is the one the preparation verified and a second reading would be a second answer.
 */
function standsIn(response: PiResponse, prepared: PiPrepared): boolean {
	const data = answered(response);
	if (data === undefined) return false;
	if (data.isStreaming !== false || data.isCompacting !== false) return false;
	if (data.sessionId !== prepared.session.sessionId || data.sessionFile !== prepared.session.sessionFile) return false;
	const model = plain(data.model);
	if (model === undefined || !nonblank(model.provider) || !nonblank(model.id)) return false;
	return `${model.provider}/${model.id}` === prepared.selection.model && data.thinkingLevel === prepared.selection.effort;
}

/** The text a child names as its last assistant one, where `null` is an answer and anything else is not. */
function readText(response: PiResponse): { text: string | null } | undefined {
	const data = answered(response);
	if (data === undefined) return undefined;
	const text = data.text;
	if (text === null || typeof text === "string") return { text };
	return undefined;
}

const HEAD = ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "cost"] as const;
const TOKENS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/**
 * This turn's share of the statistics, component by component, or nothing when any component went backwards. Pi's
 * statistics sum the whole transcript, so a later reading is never smaller than an earlier one on the same session:
 * one that is says the two readings are not of the same thing, and a negative share of a turn is not a number to
 * report. No equation between the components is required — which of them a compaction or a tool's own usage moves is
 * Pi's business.
 */
function usageDelta(total: PiUsageBaseline, baseline: PiUsageBaseline): PiUsageDelta | undefined {
	const head = {} as Record<(typeof HEAD)[number], number>;
	for (const field of HEAD) {
		const share = total[field] - baseline[field];
		if (!(share >= 0)) return undefined;
		head[field] = share;
	}
	const tokens = {} as Record<(typeof TOKENS)[number], number>;
	for (const field of TOKENS) {
		const share = total.tokens[field] - baseline.tokens[field];
		if (!(share >= 0)) return undefined;
		tokens[field] = share;
	}
	return { ...head, tokens };
}

/**
 * One task turn on a prepared child, start to finish, with one shutdown at the end of every path through it.
 *
 * The order is the order the evidence is worth anything in: the observer is begun inside the block that owns the
 * child, the child's own end is observed before the first request, the session is checked to be standing where it
 * should be before the prompt is sent, a mark of the records seen so far is taken with no await between it and the
 * prompt, the steer queue is attached immediately after `turn()` has taken the prompt, and the evidence is frozen the
 * moment the turn side wins and the input is closed — before the wait for the steer in flight, so that records
 * arriving during that wait cannot make up for records of the turn this host never saw.
 */
export async function runPiTask(request: PiTaskRequest): Promise<PiTaskResult> {
	const { prepared, observer } = request;
	const child = prepared.child;
	const queue = request.input;

	let ended = false;
	const gone = (): void => {
		ended = true;
	};
	let turn: PiTurn | undefined;
	let taken: Taken | undefined;
	/** The first value a snapshot threw, boxed so that `undefined` is a fault like any other. */
	let fault: { error: unknown } | undefined;

	/**
	 * Every reading of the observer goes through here, and none of them can throw. The observer belongs to the caller
	 * and a caller's object that fails is not a reason to leave a child running or to stop it twice: the fault is kept
	 * by presence, an empty frozen tally stands in for the reading, and the path that asked for it decides what to do.
	 */
	const takeEvidence = (): PiTaskEvidence => {
		try {
			return observer.snapshot();
		} catch (error) {
			fault ??= { error };
			return frozenEvidence(emptyEvidence());
		}
	};

	/** That fault as the refusal it becomes where one is read: the value it threw, kept exactly, and one stop. */
	const faulted = (): Decided | undefined => (fault === undefined ? undefined : { ...detail(fault.error), reason: "transport" });

	const takeSteers = (): { steers?: PiSteerReport } => (queue === undefined ? {} : { steers: queue.report() });

	const takeNow = (): Taken => ({ evidence: takeEvidence(), ...takeSteers() });

	const gate = (): Decided | undefined => {
		if (request.signal?.aborted === true) return { reason: "aborted" };
		if (ended) return { reason: "exited" };
		const fatal = prepared.questions?.fatal;
		return fatal === undefined ? undefined : { reason: "question", outcome: fatal };
	};

	/**
	 * The one shutdown. It is an attempt and not a promise that the process stopped: what it reported travels back
	 * exactly as it came, and one that threw is `unverified` with the value it threw and no exit guessed for it.
	 */
	const stopChild = async (reason: PiTaskReason): Promise<Stopped> => {
		try {
			return { exit: await child.shutdown(reason === "aborted" ? "aborted" : "host") };
		} catch (shutdownError) {
			return { unverified: true, shutdownError };
		}
	};

	/**
	 * Every refusal but the fatal-question one, which has a turn still running under it. The input is closed first and
	 * waited for, then the evidence is fixed — before the stop, so what the refusal reports is what it decided on
	 * rather than whatever the shutdown's own records added to it.
	 */
	const settle = async (decided: Decided, already?: Taken): Promise<PiTaskRefused> => {
		queue?.end();
		await queue?.idle();
		const account = already ?? takeNow();
		const stop = await stopChild(decided.reason);
		return { ok: false, ...(turn === undefined ? {} : { turn }), ...decided, session: prepared.session, selection: prepared.selection, ...account, ...stop };
	};

	try {
		// Inside the block that owns the child, because an observer that throws here is an ordinary failure of this
		// task — one that refuses, stops the child once and keeps what was thrown — rather than a rejection handed back
		// to a caller whose child is still running. It is the caller's own object, so the reason is the one a foreign
		// value gets whatever it happened to throw.
		try {
			observer.begin();
		} catch (error) {
			return await settle({ ...detail(error), reason: "transport" });
		}
		// Both handlers, because a cleanup that produced no report rejects and is still the end of the child, and the
		// rejection is consumed here: this is an observation, not a second caller awaiting the exit.
		child.exited.then(gone, gone);
		// One turn of the microtask queue, and no more: the handler above is queued ahead of this continuation, so a
		// child that had already finished is read as gone before this task sends it anything.
		await Promise.resolve();

		let stop = gate();
		if (stop) return await settle(stop);

		const before = await child.request({ type: "get_tree" });
		stop = gate();
		if (stop) return await settle(stop);
		const leafBefore = readLeaf(before);
		if (!standsAt(leafBefore, prepared.session.checkpoint)) return await settle({ reason: "leaf" });

		stop = gate();
		if (stop) return await settle(stop);

		// The mark, and no await between it and the prompt: what this turn is measured by is the records that arrive
		// after this line, so anything the readback above produced belongs to what came before and is subtracted out.
		const marked = takeEvidence();
		const faultedMark = faulted();
		if (faultedMark) return await settle(faultedMark);
		const mark = marked.events;

		// The prompt, exactly as it was composed, ending at the child's own quiescence, and the queue attached
		// immediately after `turn()` has taken it. What that call returning means is that the prompt was accepted and
		// enqueued for the child's stdin; for an ordinary writable the handoff after it is synchronous, but a writer
		// already under backpressure can delay it, and a steer pushed into that window can come back as one visible
		// typed refusal. Such a steer is accounted for and is not retried, and nothing here waits on an acknowledgement
		// to avoid it.
		const turning = child.turn(request.prompt, { completion: "settled" });
		const finished: Promise<Finished> = turning.then(
			(reported) => ({ kind: "turn", turn: reported }),
			(error) => ({ kind: "threw", error }),
		);
		queue?.attach((text) => child.request({ type: "steer", message: text }));

		// A question nobody could answer leaves the child waiting on a dialog that will never be answered, so it is
		// raced against the turn rather than waited out. The turn's own promise is mapped first and never rejects, so
		// the side that loses this race is still awaited below with nothing unhandled left behind.
		const fatal = prepared.questions?.firstFatal.then((outcome) => ({ kind: "question", outcome }) as const);
		const first = fatal === undefined ? await finished : await Promise.race([finished, fatal]);

		if (first.kind === "question") {
			// The one shutdown of this path, started while the turn is still in flight, because the turn ends when the
			// stop ends it. All three are awaited: the stop's report, the turn's own end, and the steer in flight.
			queue?.end();
			const stopping = stopChild("question");
			const [stopReport, done] = await Promise.all([stopping, finished, queue?.idle() ?? Promise.resolve()]);
			// Taken after the stop on this path alone: an active task is being ended, so what the ending produced is
			// part of what there is to look at rather than evidence a decision was already made on.
			const ending = takeNow();
			const broke = faulted();
			return {
				ok: false,
				// The question is what ended this task, and a snapshot that faulted on the way out does not rename it.
				// The fault travels as the secondary value it is, where the turn's own thrown value has not taken that
				// place, and nothing about it asks for a second stop.
				reason: "question",
				outcome: first.outcome,
				...(done.kind === "turn" ? { turn: done.turn } : detail(done.error)),
				...(broke === undefined || done.kind === "threw" ? {} : { error: broke.error }),
				session: prepared.session,
				selection: prepared.selection,
				...ending,
				...stopReport,
			};
		}

		// The input is closed and the evidence frozen before the wait for the steer in flight, and both before any
		// await: records that arrive while that steer finishes belong to what came after this turn was judged, and
		// letting them in would let a late record stand in for one of the turn's own that never arrived.
		queue?.end();
		const evidence = takeEvidence();
		await queue?.idle();
		// The steer account is the other half, and it is taken here rather than above because a steer in flight is not
		// accounted for until it has landed.
		const fixed: Taken = { evidence, ...takeSteers() };
		taken = fixed;
		// Before every refusal below it, the fault among them: a turn that came back is evidence of what happened
		// whatever ends the task afterwards, so a run cancelled while its last records were arriving, or one whose
		// observer could not be read once the turn was already over, should not report less than there was. The thrown
		// side is left unset, because there is no turn to report for it.
		if (first.kind === "turn") turn = first.turn;

		const faultedFixed = faulted();
		if (faultedFixed) return await settle(faultedFixed, fixed);

		stop = gate();
		if (stop) return await settle(stop, taken);
		if (first.kind === "threw") return await settle(thrown(first.error), taken);

		// The same turn under the name the results below use directly, so none of them reads a variable a later path
		// could have left unset.
		const ran = first.turn;
		// Each end under its own name, with the typed failure a failed turn carried kept where a reader looks for one.
		if (ran.outcome !== "settled") return await settle({ reason: turnReason(ran.outcome), ...(ran.failure === undefined ? {} : { failure: ran.failure }) }, taken);

		// Of this turn: the records seen since the mark, against what the turn itself counted. A stream this host saw
		// less of than that is one it cannot say anything about, so nothing below is read off it.
		if (evidence.events - mark < ran.events) return await settle({ reason: "unobserved" }, taken);
		// Either side reporting one is enough: the turn's own count comes from the records the transport read, and the
		// observer's from the records it was handed, and an extension that failed inside this child may have failed at
		// the one thing this run depended on. The turn's own last one travels with the refusal where it had one.
		if (ran.extensionErrors !== 0 || evidence.extensionErrors !== 0) {
			return await settle({ reason: "extension", ...(ran.lastExtensionError === undefined ? {} : { extensionError: ran.lastExtensionError }) }, taken);
		}
		// The whole of the answer check, and deliberately not a count: what matters is that the last assistant message
		// this host saw finished, so an answer whose only record was the `agent_end` that repeated it still passes.
		if (evidence.last?.stopReason !== FINAL_STOP_REASON) return await settle({ reason: "failed" }, taken);

		stop = gate();
		if (stop) return await settle(stop, taken);
		const state = await child.request({ type: "get_state" });
		stop = gate();
		if (stop) return await settle(stop, taken);
		if (!standsIn(state, prepared)) return await settle({ reason: "state" }, taken);

		stop = gate();
		if (stop) return await settle(stop, taken);
		const afterTree = await child.request({ type: "get_tree" });
		stop = gate();
		if (stop) return await settle(stop, taken);
		const leafAfter = readLeaf(afterTree);
		// A new entry, whatever kind of entry it is: nothing here filters the leaf by what wrote it, because a role or
		// an extension may leave any of the shapes Pi writes, and which of them a checkpoint may be is settled by the
		// restore that would later stand on it rather than guessed at here.
		if (leafAfter === undefined || leafAfter.leaf === null || leafAfter.leaf === leafBefore?.leaf) return await settle({ reason: "leaf" }, taken);
		const checkpoint = leafAfter.leaf;

		stop = gate();
		if (stop) return await settle(stop, taken);
		const stats = await child.request({ type: "get_session_stats" });
		stop = gate();
		if (stop) return await settle(stop, taken);
		const after = usageReading(stats, prepared.session);
		const delta = after === undefined ? undefined : usageDelta(after, prepared.usage);
		if (after === undefined || delta === undefined) return await settle({ reason: "usage" }, taken);

		stop = gate();
		if (stop) return await settle(stop, taken);
		const said = await child.request({ type: "get_last_assistant_text" });
		stop = gate();
		if (stop) return await settle(stop, taken);
		const text = readText(said);
		if (text === undefined) return await settle({ reason: "text" }, taken);

		stop = gate();
		if (stop) return await settle(stop, taken);

		// The work read back whole. What is left is the stop, and a task is a success only once that stop has reported
		// and carried no `PiExit.failure`: a child nobody could stop is not a run to publish a checkpoint from. That
		// one field is all this reads — it is the transport's verdict on how the child ended, and it says nothing about
		// a pipe still held, a discovery that was unavailable, leftovers, skipped identities or a deadline that was
		// hit, all of which travel back on the report for a retention policy to read.
		queue?.end();
		let exit: PiExit;
		try {
			exit = await child.shutdown("host");
		} catch (shutdownError) {
			return { ok: false, reason: "cleanup", session: prepared.session, selection: prepared.selection, turn: ran, leaf: checkpoint, ...fixed, unverified: true, shutdownError };
		}
		if (exit.failure !== undefined) {
			// The leaf is kept as what it is: evidence of where the work got to, and not a checkpoint, because the
			// session this failed to let go of is not one a later call may stand on.
			return { ok: false, reason: "cleanup", session: prepared.session, selection: prepared.selection, turn: ran, leaf: checkpoint, ...fixed, exit };
		}
		return { ok: true, session: { ...prepared.session, checkpoint }, selection: prepared.selection, usage: { before: prepared.usage, after, delta }, text: text.text, turn: ran, exit, ...fixed };
	} catch (error) {
		return await settle(thrown(error), taken);
	}
}
