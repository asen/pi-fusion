import { type PiChild, PiTransportError, type PiUiRequest } from "./pi-transport.ts";
import type { Ask } from "./types.ts";

/**
 * The host's half of a Pi child's question: which dialogs it takes, who is asked, and what one dialog ends as. It owns
 * one decision per dialog and nothing else — no process, no session, no record, no queue and no clock — and it is
 * standalone: nothing constructs one yet, and wiring it into a run is the future runner's own slice.
 *
 * It has two phases, and the phase is what `onUiRequest` answers from. **Inactive**, before a child is attached, every
 * record is refused: the router holds nothing it could answer a dialog through, so taking one would be a promise to
 * answer that it cannot keep. That refusal is a second guard rather than the only one — the transport cancels a dialog
 * that arrives before the child is ready without calling this back at all — and nothing here claims which of the two a
 * real early dialog meets. **Active**, after exactly one successful `attach`, an `input` dialog carrying a string title
 * and no active timeout is taken: the title is the question, the ask is invoked with a signal of that dialog's own, and the answer, the
 * refusal or the abort that follows is one outcome. Everything else is refused and counted, and a fire-and-forget
 * record is refused without being counted at all, because nothing is waiting on one.
 *
 * The first terminal event for a dialog wins, through one `finish`: the ask resolving, the ask rejecting, the run's
 * signal aborting and the child exiting are four ways in, and whichever arrives first ends that dialog. A settlement
 * that lands afterwards is counted and sends nothing, so one dialog is answered on the wire at most once. A signal
 * that aborts and a child that exits at the same moment are two callbacks, not one race to arbitrate: each entry is
 * ended by whichever of them JavaScript runs first, and the other finds it gone.
 *
 * A cancellation of the run is the one end whose admission is routinely not `sent`: the transport registers its own
 * abort listener on the same signal before a router is ever given one, so by the time the cancellation reaches here the
 * dialog has often been cancelled already and the answer comes back `duplicate`. That code is an observation of who
 * got there first and not a failure being hidden — the dialog is spent either way, and the outcome says so.
 *
 * **Ownership, and what a caller still owes.** This router never stops a child. `sent` is an admission for writing and
 * nothing about the child having read the answer, and the future runner has to read an outcome as a failure whenever
 * `end` is not `answered` or `admission` is absent or not `sent`, and perform the bounded child shutdown itself: an
 * `admission` of `refused` in particular leaves the dialog open, still the transport's to cancel when it shuts down,
 * and this module neither retries it nor cancels it. An `exited` end sends nothing on purpose — the transport that
 * would carry the answer is closed and its dialog ids are spent — and a run whose request carries no `onQuestion` is a
 * run that constructs no router at all and leaves its launch input's questions off.
 *
 * **What a dialog's provenance is here, honestly.** A native ui request carries an id, a method and the method's own
 * fields, and no identity of the extension that opened it. So while a run has questions enabled, every blocking
 * `input` whose record matches the shape above and arms no timeout of its own is routed to the ask: this router
 * cannot tell Fusion's own `ask_orchestrator` from any other code inside the child that opened one, and an explicitly
 * named extension resource is a way for a call to have such code. Nothing is invented to cover that — no provenance
 * field is guessed and no name is matched — and the decision that bounds it is the runner's: questions are enabled for
 * a run that has an `onQuestion` and for no other, and what a child may load is the call's own input.
 */

/** The three answers the transport takes and the four codes it admits one under, read off the child's own method. */
type PiQuestionAnswer = Parameters<PiChild["respond"]>[1];
type PiAdmissionCode = ReturnType<PiChild["respond"]>;

/**
 * How one dialog was answered, or how the attempt to answer it ended. The four codes the transport returns are its
 * own; `refused` is its typed refusal, which says the answer was not spent and the dialog is still open; and `threw`
 * is anything else the call threw, kept exactly as it was so a failure nobody expected is still evidence.
 */
export type PiQuestionAdmission = { code: PiAdmissionCode } | { code: "refused"; error: PiTransportError } | { code: "threw"; error: unknown };

/**
 * What one dialog came to. `end` is the terminal event that won it: an answer, a failure of the ask itself, the run's
 * own cancellation, or a child that went away. `admission` is present exactly when an answer was attempted for it —
 * what became of that attempt is the code, and `refused` and `threw` are attempts that put nothing on the wire — and
 * `resolved` and `error` carry what the ask produced — `error` is present whenever the ask rejected or threw, whatever
 * it rejected with, `undefined` and `0` included, so presence is what says a failure had a value rather than the value.
 */
export interface PiQuestionOutcome {
	id: string;
	question: string;
	end: "answered" | "failed" | "aborted" | "exited";
	admission?: PiQuestionAdmission;
	error?: unknown;
	resolved?: unknown;
}

/** One end, named for the one place that decides it. */
type PiQuestionEnd = PiQuestionOutcome["end"];

/** What a case may add to an outcome. Presence in this record is presence in the outcome: neither field is defaulted. */
type OutcomeDetail = { error?: unknown } | { resolved?: unknown };

/**
 * What the router counts, and the whole of it. `routed` is dialogs taken, `refused` dialogs turned down, both of them
 * per record rather than per question; `settledAfterEnd` is asks that produced something after their dialog had
 * already ended; and `listenerErrors` is outcomes the observer threw on, caught so one of them cannot cost the next.
 */
export interface PiQuestionCounters {
	routed: number;
	refused: number;
	settledAfterEnd: number;
	listenerErrors: number;
}

/**
 * Where a question goes and where its outcome goes. `onOutcome` is required because an outcome is how a caller learns
 * a dialog failed, and a router whose failures went nowhere would be a way to lose one silently; `signal` is the run's
 * own cancellation, read through one listener registered at `attach`.
 */
export interface PiQuestionRoute {
	ask: Ask;
	onOutcome: (outcome: PiQuestionOutcome) => void;
	signal?: AbortSignal;
}

/** The part of a child this router drives, and all of it: one answer, and the end of the process behind it. */
export type PiQuestionChild = Pick<PiChild, "respond" | "exited">;

/** One router, as the caller that composed it holds it. */
export interface PiQuestionRouter {
	/** The transport's own callback: `true` says this router has taken the dialog and will answer it. */
	onUiRequest(request: PiUiRequest): boolean;
	/** The one child this router answers through. Called twice, or with something that is not one, it throws. */
	attach(child: PiQuestionChild): void;
	/** How many dialogs are open right now. */
	readonly open: number;
	readonly counters: PiQuestionCounters;
}

/** One dialog this router has taken, with the responder it was taken through kept beside it. */
interface Entry {
	question: string;
	controller: AbortController;
	done: boolean;
	/**
	 * The attached child's own `respond`, wrapped so the call keeps its receiver. A method taken off a child and then
	 * called bare would run with no `this` at all, which is a way to lose an answer the child is still waiting on.
	 */
	respond: (id: string, response: PiQuestionAnswer) => PiAdmissionCode;
}

const callable = (value: unknown): boolean => typeof value === "function";

/** A promise as far as this needs one: something with a `then` to attach two handlers to. */
const thenable = (value: unknown): boolean => (typeof value === "object" || typeof value === "function") && value !== null && callable((value as { then?: unknown }).then);

export function questionRouter(route: PiQuestionRoute): PiQuestionRouter {
	const pending = new Map<string, Entry>();
	const counters: PiQuestionCounters = { routed: 0, refused: 0, settledAfterEnd: 0, listenerErrors: 0 };
	let attached: PiQuestionChild | undefined;
	/** Set before any pending dialog is ended, so a dialog arriving while the ending is under way is refused. */
	let closed = false;
	let dropSignal: (() => void) | undefined;

	/** The observer, once per outcome. Its own error is counted and kept here: a later outcome is still delivered. */
	const report = (outcome: PiQuestionOutcome): void => {
		try {
			route.onOutcome(outcome);
		} catch {
			counters.listenerErrors += 1;
		}
	};

	/** One attempt at an answer, and how the transport took it. Nothing is retried and nothing else is sent for this id. */
	const send = (entry: Entry, id: string, answer: PiQuestionAnswer): PiQuestionAdmission => {
		try {
			return { code: entry.respond(id, answer) };
		} catch (error) {
			// The transport's own refusal says the answer was not spent and the dialog is still open, which is a different
			// thing from a call that threw for a reason this host has no reading of.
			if (error instanceof PiTransportError && error.failure.kind === "refused") return { code: "refused", error };
			return { code: "threw", error };
		}
	};

	/**
	 * The one end of a dialog. An entry already spent is left exactly as it was: the guard is what makes this idempotent
	 * against a snapshot taken before an observer of an earlier outcome ended the same dialog, and against any other way
	 * two callers reach one entry. Past it the entry is spent before anything is sent — marked, dropped and its ask
	 * cancelled — so a second terminal event finds it gone, and the answer, when there is one at all, is attempted once.
	 */
	const finish = (id: string, entry: Entry, end: PiQuestionEnd, answer: PiQuestionAnswer | undefined, detail: OutcomeDetail): void => {
		if (entry.done) return;
		entry.done = true;
		pending.delete(id);
		entry.controller.abort();
		const admission = answer === undefined ? undefined : send(entry, id, answer);
		report({ id, question: entry.question, end, ...detail, ...(admission === undefined ? {} : { admission }) });
	};

	/** Whether this settlement is one the dialog it belongs to has already outlived. */
	const late = (entry: Entry): boolean => {
		if (!entry.done) return false;
		counters.settledAfterEnd += 1;
		return true;
	};

	/**
	 * Every dialog still open, ended the one way this event ends them. It walks a snapshot, because an observer of one
	 * outcome may open, end or cancel things while this loop is running, and `finish` is what makes an entry that
	 * observer already ended a no-op when the snapshot reaches it.
	 */
	const endAll = (end: PiQuestionEnd, answer: PiQuestionAnswer | undefined): void => {
		closed = true;
		for (const [id, entry] of [...pending]) finish(id, entry, end, answer, {});
	};

	const refuse = (): false => {
		counters.refused += 1;
		return false;
	};

	return {
		onUiRequest(request: PiUiRequest): boolean {
			// Nothing is waiting on a fire-and-forget record, so refusing one is not a refusal of anything and is not counted.
			if (request.expectsResponse !== true) return false;
			// The child is read once, into the entry's own responder: what answers a dialog is the child that was attached
			// when it was taken, called on itself.
			const child = attached;
			if (child === undefined || closed) return refuse();
			if (request.method !== "input") return refuse();
			const question = request.record.title;
			if (typeof question !== "string") return refuse();
			// A dialog with an active timeout can expire inside the child while this host is still holding the id and the
			// transport is still willing to answer it, so an answer sent afterwards can come back `sent` for a child that
			// has stopped waiting. Truthiness is the test because that is the test 0.85.1's own ui makes — `if (opts?.timeout)`
			// — so a field that arms no deadline there, `0` among them, arms none here either and is not something to refuse
			// a question over. This build's own question tool sets no timeout at all. No timer is composed in its place:
			// how long a question may wait is the host's arbitration and not a number to invent.
			if (request.record.timeout) return refuse();
			// Defense in depth: the transport protocol-fails a child that reopens an id that is already open, before this
			// callback is reached at all, so nothing is claimed here about a second dialog being cancelled for us.
			if (pending.has(request.id)) return refuse();
			const entry: Entry = { question, controller: new AbortController(), done: false, respond: (id, response) => child.respond(id, response) };
			pending.set(request.id, entry);
			const id = request.id;
			// An async call rather than a bare one, so an ask that throws where it stands arrives as a rejection with both
			// handlers already attached: one of the two settles this dialog, and neither of them is ever unobserved.
			// Typed as `unknown` on purpose: what an ask resolves is checked here rather than trusted, because a value that
			// is not text cannot be sent to a child as an answer and a declared type is no guarantee at runtime.
			const answering: Promise<unknown> = (async () => route.ask(question, entry.controller.signal))();
			answering.then(
				(value) => {
					if (late(entry)) return;
					// An empty answer is an answer. Anything that is not text is a failure of the ask's own contract, kept as
					// the value it was and answered with a cancellation rather than sent to the child as something else.
					if (typeof value === "string") finish(id, entry, "answered", { value }, {});
					else finish(id, entry, "failed", { cancelled: true }, { resolved: value });
				},
				(error) => {
					if (late(entry)) return;
					finish(id, entry, "failed", { cancelled: true }, { error });
				},
			);
			counters.routed += 1;
			return true;
		},

		attach(child: PiQuestionChild): void {
			// Checked before anything is bound, and nothing is bound when any of it fails: a caller that composed the wrong
			// call still holds the child it started, and the router it holds is the inactive one it already had.
			if (attached !== undefined) throw new TypeError("a question router answers one child, and this one already has one");
			const candidate = child as { respond?: unknown; exited?: unknown } | undefined | null;
			if (!callable(candidate?.respond) || !thenable(candidate?.exited)) throw new TypeError("a question router is attached to a child with a respond method and an exited promise");
			attached = child;
			// Both handlers, because an exit this host could not verify rejects and is still the end of the child.
			const gone = (): void => {
				// The run's listener goes first, before a single dialog is ended: an observer of one of these outcomes may
				// cancel the run where it stands, and a cancellation that still had a listener would re-enter the abort path
				// while this loop is walking its own snapshot.
				if (dropSignal !== undefined) {
					dropSignal();
					dropSignal = undefined;
				}
				// The dialogs are ended with no answer at all: the transport that would carry one is closed and its ids are
				// spent, so sending here would be an answer nobody can receive.
				endAll("exited", undefined);
			};
			child.exited.then(gone, gone);
			const signal = route.signal;
			if (signal === undefined) return;
			// A run that was already cancelled leaves the router closed rather than active: there are no dialogs to end yet,
			// and nothing is sent or settled by attaching.
			if (signal.aborted) {
				closed = true;
				return;
			}
			const abort = (): void => endAll("aborted", { cancelled: true });
			signal.addEventListener("abort", abort, { once: true });
			dropSignal = () => signal.removeEventListener("abort", abort);
		},

		get open(): number {
			return pending.size;
		},

		get counters(): PiQuestionCounters {
			return { ...counters };
		},
	};
}
