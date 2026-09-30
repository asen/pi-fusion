import assert from "node:assert/strict";
import test from "node:test";
import { type PiQuestionChild, type PiQuestionOutcome, type PiQuestionRouter, questionRouter } from "../extensions/backends/pi-question-routing.ts";
import { type PiExit, PiTransportError, type PiUiRequest, type PiUiResponse, piFailure } from "../extensions/backends/pi-transport.ts";
import type { Ask } from "../extensions/backends/types.ts";

/*
 * What the host does with a child's dialogs while it routes its questions, driven against one scripted child and one
 * scripted ask that are neither a process nor a protocol: every record below is a literal this file wrote, so what is
 * measured is the router's own arbitration — which dialogs it takes, which terminal event wins one, and what it
 * reports — and nothing at all about Pi. No case here starts a child, speaks the native protocol or imports an SDK,
 * and no scripted answer is evidence that a real child opens a dialog, reads an answer or exits this way.
 */

/** The four codes the transport admits an answer under, written out here so a case names one rather than deriving it. */
type Code = "sent" | "duplicate" | "unknown" | "closed";

/**
 * A value a scripted call throws instead of answering, held in a wrapper so `undefined` is a value like any other. The
 * field is declared and assigned rather than written as a constructor parameter property, because node runs these
 * files by stripping their types and a parameter property is syntax that stripping cannot erase.
 */
class Thrown {
	readonly error: unknown;
	constructor(error: unknown) {
		this.error = error;
	}
}

/** Enough microtask turns for a settled ask to reach its handler and for that handler's own work to finish. No timer, no sleep, no polling. */
const drain = async (): Promise<void> => {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

/** One exit report in the shape the transport writes one. Nothing ran: it is what a scripted child hands back. */
const exitOf = (): PiExit => ({
	exit: { code: 0, signal: null },
	cleanup: { root: "exited", exit: { code: 0, signal: null }, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false },
	stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: "", dropped: 0 },
	stoppedByUs: true,
	counters: { straySettles: 0, earlySettles: 0, lateResponses: 0, extensionErrors: 0, uiCancelledByTransport: 0, unknownUiMethods: 0, listenerErrors: 0, droppedFrames: 0, streamsUnclosed: 0 },
});

/** One extension ui record in the native shape: the fields the child sends, with the method's own beside them. */
const uiRequest = (id: string, method: string, fields: Record<string, unknown>, expectsResponse = true): PiUiRequest => ({
	id,
	method,
	expectsResponse,
	record: { type: "extension_ui_request", id, method, ...fields },
});

const input = (id: string, title: string): PiUiRequest => uiRequest(id, "input", { title });

/** One scripted child. It answers `sent` unless a case scripted something else for this call. */
function childDouble(codes: Array<Code | Thrown> = []) {
	let settle!: (exit: PiExit) => void;
	let fail!: (error: unknown) => void;
	const exited = new Promise<PiExit>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const child = {
		exited,
		sent: [] as Array<{ id: string; response: PiUiResponse }>,
		codes: [...codes],
		respond(id: string, response: PiUiResponse): Code {
			// Its own state is read through `this`, so a router that had taken this method off the child and called it bare
			// would fail here rather than quietly answer a dialog under no receiver at all. The attempt is recorded before
			// a scripted throw, so a case can say the answer was tried exactly once.
			this.sent.push({ id, response });
			const next = this.codes.shift() ?? "sent";
			if (next instanceof Thrown) throw next.error;
			return next;
		},
	};
	return { child, settle, fail };
}

/** One question as the router asked it, held open until the case settles it. */
interface Asked {
	question: string;
	signal: AbortSignal;
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

/** The ask every case uses unless it is about an ask that throws where it stands: one deferred per question. */
function askDouble(): { ask: Ask; asked: Asked[] } {
	const asked: Asked[] = [];
	const ask: Ask = (question, signal) =>
		new Promise<string>((resolve, reject) => {
			// The cast lives here: a case about an ask that resolved something other than text needs to hand one over.
			asked.push({ question, signal, resolve: (value) => resolve(value as string), reject });
		});
	return { ask, asked };
}

/** One router with its ask, its observer and its child, none of them attached yet. */
function routed(over: { signal?: AbortSignal; ask?: Ask; onOutcome?: (outcome: PiQuestionOutcome) => void; codes?: Array<Code | Thrown> } = {}) {
	const { ask, asked } = askDouble();
	const outcomes: PiQuestionOutcome[] = [];
	const router = questionRouter({
		ask: over.ask ?? ask,
		onOutcome:
			over.onOutcome ??
			((outcome: PiQuestionOutcome): void => {
				outcomes.push(outcome);
			}),
		...(over.signal === undefined ? {} : { signal: over.signal }),
	});
	const { child, settle, fail } = childDouble(over.codes);
	return { router, asked, outcomes, child, settle, fail };
}

test("an input dialog is routed to the ask, answered once, and reported answered", async () => {
	const { router, asked, outcomes, child } = routed();
	router.attach(child);

	const taken = router.onUiRequest(input("d-1", "which name should this take?"));
	assert.equal(taken, true, "an input dialog is this router's to answer");
	assert.equal(asked.length, 1, "one dialog, one question");
	assert.equal(asked[0].question, "which name should this take?", "the question is the record's own title, exactly as it arrived");
	assert.equal(asked[0].signal.aborted, false, "the dialog's signal is live while the question is open");
	assert.equal(router.open, 1);
	assert.deepEqual(child.sent, [], "nothing is sent before there is an answer to send");

	asked[0].resolve("yes");
	await drain();

	assert.deepEqual(child.sent, [{ id: "d-1", response: { value: "yes" } }], "one answer, on the dialog's own id");
	assert.deepEqual(outcomes, [{ id: "d-1", question: "which name should this take?", end: "answered", admission: { code: "sent" } }]);
	assert.equal(asked[0].signal.aborted, true, "the question's own signal is spent once its dialog has ended");
	assert.equal(router.open, 0);
	assert.deepEqual(router.counters, { routed: 1, refused: 0, settledAfterEnd: 0, listenerErrors: 0 });

	// An empty answer is an answer: it is text the host sent, and the child is told so rather than told nothing came.
	const empty = routed();
	empty.router.attach(empty.child);
	assert.equal(empty.router.onUiRequest(input("d-2", "anything to add?")), true);
	empty.asked[0].resolve("");
	await drain();
	assert.deepEqual(empty.child.sent, [{ id: "d-2", response: { value: "" } }], "one respond for one dialog, with the empty answer on it");
	assert.deepEqual(empty.outcomes, [{ id: "d-2", question: "anything to add?", end: "answered", admission: { code: "sent" } }]);

	// A `timeout` of `0` arms no deadline in 0.85.1's own ui, which tests the field for truthiness, so it is a question
	// like any other here rather than one refused for holding the field at all.
	const slack = routed();
	slack.router.attach(slack.child);
	assert.equal(slack.router.onUiRequest(uiRequest("d-3", "input", { title: "no deadline on this one", timeout: 0 })), true);
	slack.asked[0].resolve("still answerable");
	await drain();
	assert.deepEqual(slack.child.sent, [{ id: "d-3", response: { value: "still answerable" } }]);
	assert.deepEqual(slack.outcomes, [{ id: "d-3", question: "no deadline on this one", end: "answered", admission: { code: "sent" } }]);
	assert.deepEqual(slack.router.counters, { routed: 1, refused: 0, settledAfterEnd: 0, listenerErrors: 0 });
});

test("a router with no child, a dialog it has no reading of, and a second attach are each refused", async () => {
	const { router, asked, outcomes, child } = routed();

	// Inactive: the router holds nothing it could answer through, so it takes nothing, whatever the dialog is.
	assert.equal(router.onUiRequest(input("d-early", "too early")), false);
	assert.equal(router.counters.refused, 1, "a dialog nobody took is refused and counted");
	assert.deepEqual([asked, outcomes], [[], []], "no question was asked and no outcome was reported for it");

	// A child this router cannot answer through is refused by throwing, and refusing one leaves the router as it was.
	const fresh = routed();
	for (const wrong of [undefined, {}, { respond: () => "sent" }, { exited: Promise.resolve(exitOf()) }]) {
		assert.throws(() => fresh.router.attach(wrong as unknown as PiQuestionChild), TypeError, "a child with no answer to give, or no end to wait on, is not one to attach");
	}
	fresh.router.attach(fresh.child);
	assert.equal(fresh.router.onUiRequest(input("d-fresh", "the router is still attachable")), true, "none of those attempts left the router holding anything");

	router.attach(child);

	/** Every dialog an active router still refuses: a method it has no reading of, and a title that is not text. */
	const refusedDialogs: PiUiRequest[] = [
		uiRequest("d-select", "select", { title: "pick one", options: ["a", "b"] }),
		uiRequest("d-confirm", "confirm", { title: "go ahead?" }),
		uiRequest("d-editor", "editor", { title: "edit this", content: "text" }),
		uiRequest("d-numeric", "input", { title: 7 }),
		uiRequest("d-missing", "input", {}),
		// A dialog with an active clock can expire in the child while this host still holds the id, so it is declined.
		uiRequest("d-timeout", "input", { title: "with a clock of its own", timeout: 30_000 }),
	];
	for (const dialog of refusedDialogs) assert.equal(router.onUiRequest(dialog), false, `${dialog.id} is not a question this router can route`);

	assert.equal(router.onUiRequest(input("d-live", "the one it takes")), true);
	assert.equal(router.onUiRequest(input("d-live", "under the same id")), false, "one dialog per id while it is open");

	// Nothing is waiting on a fire-and-forget record, so refusing one is not a refusal of anything.
	const beforeNotices = router.counters.refused;
	assert.equal(router.onUiRequest(uiRequest("d-notify", "notify", { message: "a status line" }, false)), false);
	assert.equal(router.onUiRequest(uiRequest("d-status", "setStatus", { status: "working" }, false)), false);
	assert.equal(router.counters.refused, beforeNotices, "a record nothing waits on is not counted as a refusal");

	assert.equal(router.counters.refused, 1 + refusedDialogs.length + 1, "the early dialog, every dialog in the table, and the duplicate id");
	assert.equal(router.counters.routed, 1, "one of all those records was a question");
	assert.equal(asked.length, 1, "and the ask heard only that one");

	assert.throws(() => router.attach(child), TypeError, "a router answers one child");
	assert.throws(() => router.attach(childDouble().child), TypeError, "including another one");
	assert.equal(router.open, 1, "and the dialog it already had is untouched by either attempt");

	asked[0].resolve("still answerable");
	await drain();
	assert.deepEqual(child.sent, [{ id: "d-live", response: { value: "still answerable" } }]);
	assert.deepEqual(outcomes, [{ id: "d-live", question: "the one it takes", end: "answered", admission: { code: "sent" } }]);
});

test("an ask that fails, and one that resolves something other than text, cancel the dialog and keep what there was", async () => {
	for (const error of [new Error("the host could not decide"), undefined, 0]) {
		const { router, asked, outcomes, child } = routed();
		router.attach(child);
		assert.equal(router.onUiRequest(input("d-reject", "a question that fails")), true);
		asked[0].reject(error);
		await drain();

		assert.deepEqual(child.sent, [{ id: "d-reject", response: { cancelled: true } }], "the dialog is cancelled once, so the child stops waiting");
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].end, "failed");
		assert.deepEqual(outcomes[0].admission, { code: "sent" });
		assert.equal("error" in outcomes[0], true, "a failure has an error field even when what it failed with was falsy");
		assert.equal(outcomes[0].error, error, "and that field holds the value itself, not a description of it");
		assert.equal("resolved" in outcomes[0], false, "nothing resolved, so there is nothing resolved to report");
		assert.equal(router.open, 0);
	}

	// An ask that threw where it stood is a failure like any other: the throw is observed rather than left to escape.
	const thrown = new TypeError("the ask itself is wrong");
	const sync = routed({
		ask: (): Promise<string> => {
			throw thrown;
		},
	});
	sync.router.attach(sync.child);
	assert.equal(sync.router.onUiRequest(input("d-throw", "a question the ask cannot take")), true);
	await drain();
	assert.deepEqual(sync.child.sent, [{ id: "d-throw", response: { cancelled: true } }]);
	assert.deepEqual(sync.outcomes, [{ id: "d-throw", question: "a question the ask cannot take", end: "failed", error: thrown, admission: { code: "sent" } }]);

	const odd = routed();
	odd.router.attach(odd.child);
	assert.equal(odd.router.onUiRequest(input("d-number", "a question answered with a number")), true);
	odd.asked[0].resolve(42);
	await drain();
	assert.deepEqual(odd.child.sent, [{ id: "d-number", response: { cancelled: true } }], "what is not text is never sent to the child as an answer");
	assert.equal(odd.outcomes.length, 1);
	assert.equal(odd.outcomes[0].end, "failed");
	assert.equal(odd.outcomes[0].resolved, 42, "the value the ask produced is kept exactly as it was");
	assert.equal("error" in odd.outcomes[0], false, "it resolved, so it has no error");
});

test("the run's own cancellation ends every open dialog once, and a later settlement sends nothing", async () => {
	const run = new AbortController();
	// The scripted child answers `duplicate` to both, which is what the routine ordering produces against a real one:
	// the transport registers its own abort listener on this signal before a router is given it, so the dialogs are
	// usually already spent by the time the cancellation reaches here. That ordering is scripted evidence of how this
	// host reads the code, not a measurement of which listener a real transport runs first.
	const { router, asked, outcomes, child } = routed({ signal: run.signal, codes: ["duplicate", "duplicate"] });
	router.attach(child);
	assert.equal(router.onUiRequest(input("d-a", "first question")), true);
	assert.equal(router.onUiRequest(input("d-b", "second question")), true);
	assert.equal(router.open, 2, "several questions may be open at once, under the transport's own cap");

	run.abort();

	assert.deepEqual(child.sent, [
		{ id: "d-a", response: { cancelled: true } },
		{ id: "d-b", response: { cancelled: true } },
	]);
	assert.deepEqual(
		outcomes.map((outcome) => [outcome.id, outcome.end, outcome.admission]),
		[
			["d-a", "aborted", { code: "duplicate" }],
			["d-b", "aborted", { code: "duplicate" }],
		],
		"a dialog the transport had already cancelled is a duplicate observed, and the outcome says so rather than hiding it",
	);
	assert.deepEqual(
		asked.map((one) => one.signal.aborted),
		[true, true],
		"each question's own signal is spent, so an ask that watches one stops waiting",
	);
	assert.equal(router.open, 0);

	// The asks settle afterwards, which is what a cancelled ask does: they are counted and nothing more is sent.
	asked[0].reject(new Error("cancelled"));
	asked[1].reject(new Error("cancelled"));
	await drain();
	assert.equal(child.sent.length, 2, "one answer per dialog, whatever arrives afterwards");
	assert.equal(outcomes.length, 2, "and one outcome per dialog");
	assert.equal(router.counters.settledAfterEnd, 2);

	assert.equal(router.onUiRequest(input("d-c", "after the cancellation")), false, "a cancelled run takes no new dialog");
	assert.equal(router.counters.refused, 1);
	assert.equal(router.counters.routed, 2);

	// A run already cancelled when the child was attached leaves the router closed rather than active.
	const already = new AbortController();
	already.abort();
	const late = routed({ signal: already.signal });
	late.router.attach(late.child);
	assert.equal(late.router.onUiRequest(input("d-late", "a question with no run left")), false);
	assert.deepEqual(late.router.counters, { routed: 0, refused: 1, settledAfterEnd: 0, listenerErrors: 0 });
	assert.deepEqual([late.asked, late.outcomes, late.child.sent], [[], [], []], "nothing was asked and nothing was sent by attaching");
});

test("a child that has gone ends its dialogs with nothing sent, whichever way it ended", async () => {
	// The exit that reports carries the reentrancy with it: two dialogs are open, and the observer of the first outcome
	// cancels the run and offers the router another dialog from inside the exit's own loop.
	const run = new AbortController();
	const outcomes: PiQuestionOutcome[] = [];
	const nested: boolean[] = [];
	let exiting: PiQuestionRouter | undefined;
	let firstOutcome = true;
	const reported = routed({
		signal: run.signal,
		onOutcome: (outcome) => {
			outcomes.push(outcome);
			if (!firstOutcome || exiting === undefined) return;
			firstOutcome = false;
			run.abort();
			nested.push(exiting.onUiRequest(input("d-nested", "a question raised from inside an outcome")));
		},
	});
	exiting = reported.router;
	reported.router.attach(reported.child);
	assert.equal(reported.router.onUiRequest(input("d-one", "the first question")), true);
	assert.equal(reported.router.onUiRequest(input("d-two", "the second question")), true);

	reported.settle(exitOf());
	await drain();

	assert.deepEqual(reported.child.sent, [], "an exit answers nothing: the transport that would carry an answer is closed");
	assert.deepEqual(
		outcomes,
		[
			{ id: "d-one", question: "the first question", end: "exited" },
			{ id: "d-two", question: "the second question", end: "exited" },
		],
		"one outcome per dialog, and a cancellation raised from inside the first of them adds none",
	);
	assert.deepEqual(nested, [false], "a dialog offered from inside an outcome, after the child has gone, is refused");
	assert.deepEqual(
		reported.asked.map((one) => one.signal.aborted),
		[true, true],
		"each question is cancelled even though the child is not told",
	);
	assert.equal(reported.router.open, 0);

	reported.asked[0].resolve("an answer that arrived too late");
	reported.asked[1].reject(new Error("cancelled"));
	await drain();
	assert.deepEqual(reported.child.sent, [], "a host settlement after the child has gone is counted, not sent");
	assert.equal(outcomes.length, 2);
	assert.deepEqual(reported.router.counters, { routed: 2, refused: 1, settledAfterEnd: 2, listenerErrors: 0 });

	// An exit this host could not verify is a rejection rather than a report, and ends its dialogs the same way.
	const failed = routed();
	failed.router.attach(failed.child);
	assert.equal(failed.router.onUiRequest(input("d-gone", "a question the child cannot hear")), true);
	failed.fail(new PiTransportError(piFailure("unverified")));
	await drain();

	assert.deepEqual(failed.child.sent, []);
	assert.deepEqual(failed.outcomes, [{ id: "d-gone", question: "a question the child cannot hear", end: "exited" }]);
	assert.equal("admission" in failed.outcomes[0], false, "nothing was sent, so there is no admission to report");
	assert.equal(failed.asked[0].signal.aborted, true);

	failed.asked[0].resolve("an answer that arrived too late");
	await drain();
	assert.deepEqual(failed.child.sent, []);
	assert.equal(failed.router.counters.settledAfterEnd, 1);
	assert.equal(failed.outcomes.length, 1);
	assert.equal(failed.router.onUiRequest(input("d-after", "after the exit")), false);
	assert.equal(failed.router.counters.refused, 1);
});

test("how the transport took an answer is reported as it was, and an observer's own error costs nothing but itself", async () => {
	for (const code of ["duplicate", "unknown", "closed"] as const) {
		const { router, asked, outcomes, child } = routed({ codes: [code] });
		router.attach(child);
		assert.equal(router.onUiRequest(input(`d-${code}`, "a question whose answer went nowhere")), true);
		asked[0].resolve("an answer");
		await drain();
		assert.deepEqual(child.sent, [{ id: `d-${code}`, response: { value: "an answer" } }], "one attempt, and no retry of it");
		assert.deepEqual(outcomes, [{ id: `d-${code}`, question: "a question whose answer went nowhere", end: "answered", admission: { code } }], "the answer stands and the admission says what became of it");
	}

	// The transport's own refusal: the answer was not spent and the dialog is still open, which the caller reads off the code.
	const refusal = new PiTransportError(piFailure("refused"));
	const refused = routed({ codes: [new Thrown(refusal)] });
	refused.router.attach(refused.child);
	assert.equal(refused.router.onUiRequest(input("d-refused", "a question the transport would not send")), true);
	refused.asked[0].resolve("an answer");
	await drain();
	assert.equal(refused.child.sent.length, 1, "one attempt, and nothing retried after it was refused");
	assert.deepEqual(refused.outcomes, [{ id: "d-refused", question: "a question the transport would not send", end: "answered", admission: { code: "refused", error: refusal } }]);
	const refusedAdmission = refused.outcomes[0].admission;
	assert.equal(refusedAdmission && "error" in refusedAdmission ? refusedAdmission.error : undefined, refusal, "the failure travels as the value it was, not as a copy of it");

	// Anything else the call threw is kept as it was, without being read as a refusal it never claimed to be.
	const broken = new TypeError("respond is not this");
	const threw = routed({ codes: [new Thrown(broken)] });
	threw.router.attach(threw.child);
	assert.equal(threw.router.onUiRequest(input("d-threw", "a question whose answer threw")), true);
	threw.asked[0].resolve("an answer");
	await drain();
	assert.deepEqual(threw.outcomes, [{ id: "d-threw", question: "a question whose answer threw", end: "answered", admission: { code: "threw", error: broken } }]);
	const threwAdmission = threw.outcomes[0].admission;
	assert.equal(threwAdmission && "error" in threwAdmission ? threwAdmission.error : undefined, broken, "kept as the value it was, without being read as a refusal");

	// An observer that throws on the first outcome: counted, and the second outcome is still delivered to it.
	const seen: PiQuestionOutcome[] = [];
	let first = true;
	const observed = routed({
		onOutcome: (outcome) => {
			if (first) {
				first = false;
				throw new Error("the observer is broken");
			}
			seen.push(outcome);
		},
	});
	observed.router.attach(observed.child);
	assert.equal(observed.router.onUiRequest(input("d-one", "the first question")), true);
	assert.equal(observed.router.onUiRequest(input("d-two", "the second question")), true);
	observed.asked[0].resolve("one");
	observed.asked[1].resolve("two");
	await drain();
	assert.equal(observed.router.counters.listenerErrors, 1);
	assert.deepEqual(seen, [{ id: "d-two", question: "the second question", end: "answered", admission: { code: "sent" } }], "the outcome after the one that threw arrived");
	assert.deepEqual(observed.child.sent, [
		{ id: "d-one", response: { value: "one" } },
		{ id: "d-two", response: { value: "two" } },
	]);
});
