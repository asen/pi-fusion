import * as path from "node:path";
import type { OwnedCleanup } from "../process-tree.ts";
import type { PiRole } from "./pi-binding.ts";
import { type BootstrapSession, bootstrapInput, openSession, piLaunch } from "./pi-launch.ts";
import { type PiQuestionCounters, type PiQuestionOutcome, type PiQuestionRouter, questionRouter } from "./pi-question-routing.ts";
import { type PiRestoreRefused, restoreSession } from "./pi-session-restore.ts";
import { type CallStorage, writeCallInput } from "./pi-storage.ts";
import { type PiBounds, type PiChild, type PiChildOptions, type PiEvent, type PiExit, type PiFailure, type PiResponse, PiTransportError, type PiUiRequest, startPiChild } from "./pi-transport.ts";
import { type Ask, PI_EFFORTS, type PiSessionRef, piModelParts, type ResolvedSelection, type SessionIntent } from "./types.ts";

/**
 * The startup of one Pi call, and nothing past it: from a role and the storage a call was prepared on to a child
 * standing in a session this host has verified, with the selection it actually runs and the usage it starts from
 * read back off it. What comes after — the task turn, the steers, the events, the outcome and the delta against the
 * baseline below — is the runner's, and none of it is here. Nothing constructs one of these yet.
 *
 * It composes, it writes one input file, it starts one child and it reads that child back. It allocates no storage
 * and disposes of none: the caller prepared the call directory and the caller removes it, on every path, because a
 * prepared child is still running in it.
 *
 * **What is owned when.** Before the child exists nothing is owned: an already cancelled signal is a refusal that
 * composes nothing, an intent this build cannot run and a reference another backend wrote throw, and a composition
 * or a write that failed rejects with the error it failed with. None of those took a child, so none of them stops
 * one. A startup that failed is the transport's own refusal, with its error, its typed failure and the whole final
 * exit it carried preserved and no shutdown attempted, because there was never a handle to stop. Past the moment
 * `start` resolves the child is this call's: every refusal from there asks it to stop exactly once and reports what
 * that attempt said, and a success hands it back running, with the watch beside it for the questions the run that
 * follows will still get. The one exception is a restore refusal, which already stopped the child itself: it is
 * passed through whole and never stopped a second time.
 *
 * **The gate.** Three things end a preparation that is otherwise going fine: the run's own cancellation, a child that
 * has gone, and a question whose outcome was fatal. Always in that order, and always decided before the shutdown that
 * a refusal then performs, so what a refusal says happened is what this host observed rather than what the stopping
 * produced. Where it is read is exactly this: before every call this module itself issues to the child, after each of
 * those calls returns, once after the restore helper returns, and once more, synchronously, before a success is handed
 * back. It does not run inside that helper — the requests and the prompt a restore sends are gated by the restore's
 * own signal checks, which are a cancellation gate and nothing else — so a question that failed or a child that went
 * away while a restore was in flight is caught by the next gate after it returns rather than in the middle of it.
 * Nothing here adds a listener, a race or a timer of its own: the signal is the caller's, the child's end is the one
 * promise the transport already publishes, and a question's outcome is the router's own report.
 *
 * **What the result's session is.** It is a verified preparation identity — the session the child opened for a new
 * call, or the session and the checkpoint a restore confirmed for a continuation — and it is explicitly not
 * authority over any record. Whether a run's session, checkpoint and selection are written down is decided from
 * that run's own outcome, afterwards and elsewhere; a task that fails after this succeeded is not made recordable by
 * it. This module composes no task and confirms no checkpoint of its own: the one a verified fork carries is the one
 * the restore's own readback confirmed.
 */

/** Where a preparation stopped. Each one is a step of the sequence, and `transport` is everything that threw. */
export type PiPrepareReason = "aborted" | "startup" | "exited" | "state" | "restore" | "selection" | "usage" | "question" | "transport";

/**
 * What the child's own session statistics said at the moment it was ready, validated field by field: the run that
 * follows subtracts this from a later reading, because Pi's statistics sum the whole transcript rather than a turn.
 * The identity is kept on it so a baseline can be read on its own without the session it was taken against beside it.
 */
export interface PiUsageBaseline {
	sessionId: string;
	sessionFile: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	cost: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/**
	 * The child's own context-window estimate, absent when it reported none. `tokens` and `percent` are null while
	 * the estimate is unknown, which is what a session reports right after a compaction, and a null is kept as the
	 * unknown it is rather than replaced with a number.
	 */
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** The router's own counts, with the two this watch keeps of its own: answers that landed, and outcomes that failed. */
export interface PiQuestionWatchCounters extends PiQuestionCounters {
	answered: number;
	fatal: number;
}

/**
 * The questions of one call, as the caller that gets a prepared child reads them. It holds no history: the first
 * fatal outcome is kept and every later one is counted, because what a runner does with one is stop the run, and the
 * second reason it should have stopped is not a second decision.
 *
 * An outcome is fatal unless the ask answered it and the transport admitted that answer for writing — which is what
 * `sent` is and all it is. This watch never stops the child and never ends the router: a fatal outcome after this
 * preparation succeeded is the run's own to notice, through `fatal` or `firstFatal`, and to act on.
 */
export interface PiQuestionWatch {
	/** How many dialogs are open right now. */
	readonly open: number;
	readonly counters: PiQuestionWatchCounters;
	/** The first outcome that was not an answer the transport took, memoized, or undefined while there is none. */
	readonly fatal: PiQuestionOutcome | undefined;
	/** The same outcome as a promise, resolved once and never rejected, for a caller that waits rather than polls. */
	readonly firstFatal: Promise<PiQuestionOutcome>;
}

/** A child prepared: it is running, it stands in this session, and these are the readbacks it stands on. */
export interface PiPrepared {
	ok: true;
	child: PiChild;
	/** The verified preparation identity, with the checkpoint a continuation's restore confirmed. Not a record. */
	session: PiSessionRef;
	selection: ResolvedSelection;
	usage: PiUsageBaseline;
	questions?: PiQuestionWatch;
}

/**
 * A preparation that did not, and the evidence it kept. `failure` and `error` are the transport's typed failure and
 * the value that was thrown, `restore` the whole refusal a continuation's restore reported, and `outcome` the
 * question outcome a gate refused on. `session` and `selection` are there when they had already been verified when
 * the failure landed, because a refusal that knows which session the child stood in is worth more than one that does
 * not. `exit` is what the one shutdown attempt reported — or, for a startup, the final exit the transport's own
 * refusal carried — kept exactly as it came, and `unverified` with `shutdownError` beside it is a shutdown that threw
 * instead, for which no exit is invented.
 *
 * `error` and `shutdownError` are values from somewhere else, kept so a person reading a failure has what there was.
 * Keeping them here is not permission to put either of them into a record, a card or anything a user reads.
 */
export interface PiPrepareRefused {
	ok: false;
	reason: PiPrepareReason;
	failure?: PiFailure;
	error?: unknown;
	restore?: PiRestoreRefused;
	outcome?: PiQuestionOutcome;
	session?: PiSessionRef;
	selection?: ResolvedSelection;
	exit?: PiExit;
	unverified?: true;
	shutdownError?: unknown;
	questions?: PiQuestionWatch;
}

export type PiPrepareResult = PiPrepared | PiPrepareRefused;

/**
 * One call's preparation, as the caller composes it. Everything here is either the call itself or an internal seam:
 * there is no user parameter, variable or setting that reaches any of it, and `start`, `cleanup`, `bounds` and
 * `bootstrap` are module-level inputs a test or a harness passes and production does not.
 */
export interface PiPrepareRequest {
	role: PiRole;
	/** The storage this call runs on, which this module neither allocates nor disposes of. */
	storage: CallStorage;
	intent: SessionIntent;
	/** The role contract's prose, already read by the host: nothing here opens a contract file. */
	contract: string;
	signal?: AbortSignal;
	/**
	 * Where a child's question goes. Its presence is the whole of what turns questions on: it composes the input's
	 * question tool, it builds the router, and a call without it gets no dialog routing at all.
	 */
	onQuestion?: Ask;
	onEvent?: (event: PiEvent) => void;
	killGraceMs?: number;
	/** The host's environment, handed to the launch composition and read nowhere here. */
	env?: NodeJS.ProcessEnv;
	/** What starts the child. Internal, for a test: production leaves it and gets the transport's own. */
	start?: (options: PiChildOptions) => Promise<PiChild>;
	cleanup?: OwnedCleanup;
	bounds?: Partial<PiBounds>;
	/** The bootstrap the launch names. Internal, for a harness; the launch's own default is the installed one. */
	bootstrap?: string;
	/** The host's own Pi package directory, which the child resolves the SDK from; the backend always passes one. */
	sdkDir?: string;
}

/** A refusal as the sequence decides it, before the shutdown a claimed failure performs adds its report to it. */
type Refusal = Omit<PiPrepareRefused, "exit" | "unverified" | "shutdownError" | "questions">;

/** The router and the watch over it, built together and only for a call that can answer a question at all. */
interface Watched {
	router: PiQuestionRouter;
	watch: PiQuestionWatch;
}

/** The session a state answer names, with the whole answer kept: what its other fields mean is read elsewhere. */
interface OpenedSession {
	sessionId: string;
	sessionFile: string;
	raw: Record<string, unknown>;
}

const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const plain = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** A number a count, a cost or a token total may be: finite and not negative. Nothing is clamped, rounded or coerced. */
const amount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** Every named field as such a number, or nothing at all: a baseline is validated whole rather than field by field. */
function amounts<K extends string>(source: Record<string, unknown>, fields: readonly K[]): Record<K, number> | undefined {
	const read = {} as Record<K, number>;
	for (const field of fields) {
		const value = amount(source[field]);
		if (value === undefined) return undefined;
		read[field] = value;
	}
	return read;
}

/** The data of an answer this preparation may act on: a failed response answers no step of it, whatever it carries. */
const answered = (response: PiResponse): Record<string, unknown> | undefined => (response.success === true ? plain(response.data) : undefined);

/**
 * The session a fresh child opened, and nothing about it while that child is streaming. The file has to be absolute
 * because a Pi session is reachable by its transcript path and a relative one names a different file from a
 * different working directory, which is not an identity a later call can reopen.
 */
function openedSession(response: PiResponse): OpenedSession | undefined {
	const data = answered(response);
	if (!data || data.isStreaming !== false) return undefined;
	const { sessionId, sessionFile } = data;
	if (!nonblank(sessionId) || !nonblank(sessionFile) || !path.isAbsolute(sessionFile)) return undefined;
	return { sessionId, sessionFile, raw: data };
}

/**
 * What the child is asked to construct, or a refusal to take the call at all. A reference another backend wrote names
 * a session this one cannot open and a kind this build does not know is a call composed wrong, so both throw, before
 * anything is written and before a child could exist to own.
 */
function sessionAction(intent: SessionIntent): BootstrapSession {
	const asked = plain(intent);
	const kind = asked?.kind;
	if (kind === "new") return { kind: "new" };
	if (kind === "resume" || kind === "fork") {
		const ref = plain(kind === "resume" ? asked?.ref : asked?.from);
		if (ref?.backend === "pi") return openSession(ref as unknown as PiSessionRef);
		throw new TypeError("a pi child continues a pi session, and this intent carries another backend's reference");
	}
	throw new TypeError("a pi child is prepared for a new session, a resume or a fork, and this intent is none of them");
}

/**
 * The selection the child actually runs, read off the one state answer this preparation already verified and held to
 * exactly what the role asked for. Nothing is set, defaulted, clamped or matched loosely: the model is the provider
 * and the id the role named, compared as the two parts Pi splits them into, and the thinking level is one of Pi's own
 * and is the role's own whenever the role named one.
 *
 * A child's constructor can legitimately clamp a requested level to what a model offers, and that is what this
 * refuses: a call that asked for one level and got another ran something the caller did not ask for, and running it
 * anyway would put a selection in a record that a continuation would then repeat. A role that named no level takes
 * whatever the child reported, which is the level that call runs and the one a continuation should repeat.
 */
function readSelection(role: PiRole, state: Record<string, unknown>): ResolvedSelection | undefined {
	const wanted = piModelParts(role.model);
	const model = plain(state.model);
	if (wanted === undefined || model === undefined) return undefined;
	const { provider, id } = model;
	if (!nonblank(provider) || !nonblank(id)) return undefined;
	if (provider !== wanted.provider || id !== wanted.model) return undefined;
	const level = state.thinkingLevel;
	if (typeof level !== "string" || !(PI_EFFORTS as readonly string[]).includes(level)) return undefined;
	if (role.effort !== undefined && level !== role.effort) return undefined;
	return { model: `${provider}/${id}`, effort: level };
}

/**
 * The baseline, from an answer that names the session this preparation verified and carries every field of it. No
 * equation between the fields is checked: which of them a compaction, a branch summary or a tool's own reported
 * usage moves is Pi's business, and a host that required them to add up would refuse a healthy session.
 *
 * It is exported because a later reading has to be read by exactly this grammar to be subtracted from this one: a
 * task's own share of the statistics is a delta against a baseline, and two readers would make it a delta between two
 * different things.
 */
export function usageReading(response: PiResponse, session: PiSessionRef): PiUsageBaseline | undefined {
	const data = answered(response);
	if (!data) return undefined;
	if (data.sessionId !== session.sessionId || data.sessionFile !== session.sessionFile) return undefined;
	const head = amounts(data, ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "cost"]);
	const counted = plain(data.tokens);
	const tokens = counted === undefined ? undefined : amounts(counted, ["input", "output", "cacheRead", "cacheWrite", "total"]);
	if (head === undefined || tokens === undefined) return undefined;
	const baseline: PiUsageBaseline = { sessionId: session.sessionId, sessionFile: session.sessionFile, ...head, tokens };
	if (data.contextUsage === undefined) return baseline;
	const context = plain(data.contextUsage);
	const contextWindow = context === undefined ? undefined : amount(context.contextWindow);
	// A window of zero is not a window: it would make every share of it either undefined or infinite.
	if (context === undefined || contextWindow === undefined || contextWindow <= 0) return undefined;
	const used = context.tokens === null ? null : amount(context.tokens);
	const percent = context.percent === null ? null : amount(context.percent);
	// A share past 100 is not refused: what an estimate says about a window is the child's own accounting to report.
	if (used === undefined || percent === undefined) return undefined;
	return { ...baseline, contextUsage: { tokens: used, contextWindow, percent } };
}

/**
 * The router this call routes its dialogs through, and the watch a caller reads it by. The observer is this module's
 * own and cannot throw, because the router counts an observer's error and carries on and an outcome lost that way is
 * a question failure nobody would ever see.
 */
function questionWatch(ask: Ask, signal: AbortSignal | undefined): Watched {
	let answeredCount = 0;
	let fatalCount = 0;
	let first: PiQuestionOutcome | undefined;
	let resolveFatal!: (outcome: PiQuestionOutcome) => void;
	// Never rejected, and never awaited by this module: a caller that holds a prepared child may wait on it for as
	// long as that child runs, and a call that ends with no fatal question leaves it unsettled with nothing attached.
	const firstFatal = new Promise<PiQuestionOutcome>((resolve) => {
		resolveFatal = resolve;
	});
	const onOutcome = (outcome: PiQuestionOutcome): void => {
		// An answer the transport took is the one end that is not a failure. `sent` is admission for writing and says
		// nothing about the child having read it, and that is as much as this host can ever know about one.
		if (outcome.end === "answered" && outcome.admission?.code === "sent") {
			answeredCount += 1;
			return;
		}
		fatalCount += 1;
		if (first !== undefined) return;
		first = outcome;
		resolveFatal(outcome);
	};
	const router = questionRouter({ ask, onOutcome, ...(signal === undefined ? {} : { signal }) });
	const watch: PiQuestionWatch = {
		get open(): number {
			return router.open;
		},
		get counters(): PiQuestionWatchCounters {
			return { ...router.counters, answered: answeredCount, fatal: fatalCount };
		},
		get fatal(): PiQuestionOutcome | undefined {
			return first;
		},
		firstFatal,
	};
	return { router, watch };
}

/**
 * The one shutdown a claimed failure attempts. It is an attempt and not a promise that the process stopped: what the
 * shutdown reported travels back exactly as it was, and a shutdown that threw is `unverified` with the value it threw
 * kept and no exit guessed for it. The reason this preparation already decided is what the stop is asked under, so a
 * signal that aborts while the child is stopping renames nothing that has already happened.
 */
async function settle(child: Pick<PiChild, "shutdown">, refusal: Refusal, watched: Watched | undefined): Promise<PiPrepareRefused> {
	const questions = watched === undefined ? {} : { questions: watched.watch };
	try {
		const exit = await child.shutdown(refusal.reason === "aborted" ? "aborted" : "host");
		return { ...refusal, exit, ...questions };
	} catch (shutdownError) {
		return { ...refusal, unverified: true, shutdownError, ...questions };
	}
}

/**
 * Everything after the child exists, where this module owns it. The readbacks are three: which session the child
 * stands in, what it runs with, and what its statistics started at. A continuation gets the first of them from the
 * restore helper, which already owns the child for the length of its own sequence and stops it itself when it
 * refuses; a new session gets it from the one state answer this asks for, and the child's own `startState` is not
 * read, because readiness is not a session a record may be written against.
 */
async function claimed(request: PiPrepareRequest, action: BootstrapSession, child: PiChild, watched: Watched | undefined): Promise<PiPrepareResult> {
	let ended = false;
	const gone = (): void => {
		ended = true;
	};

	let session: PiSessionRef | undefined;
	let selection: ResolvedSelection | undefined;
	const refuse = (reason: PiPrepareReason, detail: Omit<Refusal, "ok" | "reason"> = {}): Refusal => ({
		ok: false,
		reason,
		...(session === undefined ? {} : { session }),
		...(selection === undefined ? {} : { selection }),
		...detail,
	});

	/**
	 * The three ends, in the one order they are read in: the caller's cancellation, the child, then the questions. It
	 * is read around the calls this function makes itself, and not inside the restore helper, whose own boundaries are
	 * gated on the signal alone: an end that lands while a restore is in flight is read by the gate after it returns.
	 */
	const gate = (): Refusal | undefined => {
		if (request.signal?.aborted === true) return refuse("aborted");
		if (ended) return refuse("exited");
		const fatal = watched?.watch.fatal;
		return fatal === undefined ? undefined : refuse("question", { outcome: fatal });
	};

	const thrown = (error: unknown): Refusal => {
		if (error instanceof PiTransportError) {
			const failure = error.failure;
			return refuse(failure.kind === "aborted" ? "aborted" : "transport", { failure, error });
		}
		// Kept as the value it was, `undefined` included, so a failure nobody expected is still evidence of one.
		return refuse("transport", { error });
	};

	try {
		// Inside the try, before anything is asked of the child: past the start seam this child is this call's, so a
		// handle whose `exited` is not something two handlers can be attached to at all fails where every other failure
		// of a claimed child fails, and is settled through the one shutdown rather than escaping as a rejection nobody
		// stopped a child for. Both handlers, because a cleanup that produced no report rejects and is still the end of
		// the child, and the rejection is consumed here: this is an observation, not a second caller awaiting the exit.
		child.exited.then(gone, gone);
		if (watched !== undefined) watched.router.attach(child);

		let stop = gate();
		if (stop) return await settle(child, stop, watched);

		let state: Record<string, unknown>;
		if (action.kind === "new") {
			const opened = await child.request({ type: "get_state" });
			stop = gate();
			if (stop) return await settle(child, stop, watched);
			const fresh = openedSession(opened);
			if (fresh === undefined) return await settle(child, refuse("state"), watched);
			// No checkpoint: a session with no entry behind it has no point a continuation could restore to.
			session = { backend: "pi", sessionId: fresh.sessionId, sessionFile: fresh.sessionFile };
			state = fresh.raw;
		} else {
			const restored = await restoreSession(child, request.intent, { ...(request.signal === undefined ? {} : { signal: request.signal }) });
			// A restore that refused has already asked the child to stop, once, and kept what that attempt reported.
			// Stopping it again here would be a second attempt on a child this call no longer knows the state of.
			if (!restored.ok) return { ok: false, reason: "restore", restore: restored, ...(watched === undefined ? {} : { questions: watched.watch }) };
			session = restored.session;
			state = restored.state;
			// The one gate a restore gets from here: its own steps were gated on the signal alone, so a fatal question
			// or a child that went away during the sequence is read now, on the way out of it.
			stop = gate();
			if (stop) return await settle(child, stop, watched);
		}

		// Read off that exact state and no other: a second state request could answer after something moved, and the
		// selection this call reports has to be the one the session it verified was standing in.
		const chosen = readSelection(request.role, state);
		if (chosen === undefined) return await settle(child, refuse("selection"), watched);
		selection = chosen;

		stop = gate();
		if (stop) return await settle(child, stop, watched);
		const stats = await child.request({ type: "get_session_stats" });
		stop = gate();
		if (stop) return await settle(child, stop, watched);
		const usage = usageReading(stats, session);
		if (usage === undefined) return await settle(child, refuse("usage"), watched);

		// The last gate reads nothing new — no await stands between it and the one above — and it is here so that the
		// rule holds without exception: nothing is handed back as prepared that one of the three ends had already
		// overtaken.
		stop = gate();
		if (stop) return await settle(child, stop, watched);
		return { ok: true, child, session, selection, usage, ...(watched === undefined ? {} : { questions: watched.watch }) };
	} catch (error) {
		return await settle(child, thrown(error), watched);
	}
}

/**
 * One preparation, start to finish. The order in front of the child is the order ownership is taken in, and every
 * step of it refuses without a child to stop: a signal that is already aborted composes nothing and writes nothing,
 * an intent this build cannot run throws, and a composition, a write or a launch that failed rejects with its own
 * error rather than becoming a result, because the caller that composed the call is the one that can fix it and the
 * storage it holds is still its own to dispose of.
 *
 * The child is started with an owned cleanup whichever way the caller composed one: the transport defaults it too,
 * and pinning it here is what keeps the portable descendant cleanup a property of every Pi child rather than of the
 * transport's current default. The question router is built before the start and not after, because the transport
 * takes `onUiRequest` as a launch option and a dialog can arrive before the child is ready — the inactive router
 * refuses that one, which is the second of the two guards it already has.
 */
export async function preparePiChild(request: PiPrepareRequest): Promise<PiPrepareResult> {
	// Before anything is composed: a cancelled call writes no input, starts no process and watches no questions.
	if (request.signal?.aborted === true) return { ok: false, reason: "aborted" };

	const action = sessionAction(request.intent);
	const input = bootstrapInput({ role: request.role, storage: request.storage, session: action, questions: request.onQuestion !== undefined, contract: request.contract });
	writeCallInput(request.storage, input);
	const launch = piLaunch({
		input,
		storage: request.storage,
		...(request.env === undefined ? {} : { env: request.env }),
		...(request.bootstrap === undefined ? {} : { bootstrap: request.bootstrap }),
		...(request.sdkDir === undefined ? {} : { sdkDir: request.sdkDir }),
	});

	const watched = request.onQuestion === undefined ? undefined : questionWatch(request.onQuestion, request.signal);

	const start = request.start ?? startPiChild;
	let child: PiChild;
	try {
		child = await start({
			launch,
			cleanup: request.cleanup ?? {},
			...(request.signal === undefined ? {} : { signal: request.signal }),
			...(request.killGraceMs === undefined ? {} : { killGraceMs: request.killGraceMs }),
			...(request.bounds === undefined ? {} : { bounds: request.bounds }),
			...(request.onEvent === undefined ? {} : { onEvent: request.onEvent }),
			...(watched === undefined ? {} : { onUiRequest: (ui: PiUiRequest) => watched.router.onUiRequest(ui) }),
		});
	} catch (error) {
		// Anything else came from a seam that is not the transport's, and no child was handed over for it either: it
		// is rethrown exactly as it was rather than dressed as a refusal this module can account for.
		if (!(error instanceof PiTransportError)) throw error;
		return {
			ok: false,
			reason: "startup",
			error,
			failure: error.failure,
			...(error.finalExit === undefined ? {} : { exit: error.finalExit }),
			...(error.kind === "unverified" ? { unverified: true as const } : {}),
			...(watched === undefined ? {} : { questions: watched.watch }),
		};
	}
	return await claimed(request, action, child, watched);
}
