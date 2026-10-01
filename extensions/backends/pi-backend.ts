import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedCleanup } from "../process-tree.ts";
import type { PiRole } from "./pi-binding.ts";
import { hostAgentDir } from "./pi-launch.ts";
import { DISPOSE_FAILED, DISPOSE_WARNING, disposition, finishRun, newRun, type PiDisposal, type PiDisposition, type PiEnded, type PiPreparedIdentity, type PiRun, type PiSession, piSession, progressMapper } from "./pi-outcome.ts";
import { type PiPrepareRequest, type PiPrepareResult, preparePiChild } from "./pi-prepare.ts";
import { type PreparedCall, prepareCallStorage, type StorageRequest } from "./pi-storage.ts";
import { PiSteerQueue, type PiTaskRequest, type PiTaskResult, runPiTask, taskObserver } from "./pi-task.ts";
import { type PiBounds, type PiChild, type PiChildOptions, type PiEvent, startPiChild } from "./pi-transport.ts";
import { type Backend, type ChildEvent, failed, type RunRequest, type SessionIntent } from "./types.ts";

/**
 * One Pi call composed out of the parts that already exist: the contract the host reads, the storage the call runs
 * on, the preparation that starts and verifies a child, the task turn on that child, and the mapping that says what
 * the run reports and whether the storage may go. It decides nothing of its own — every judgement below is one of
 * those modules' — and it is registered nowhere: nothing in this build constructs a backend from it, so no user can
 * reach a line of it. There is no exported instance for the same reason.
 *
 * **The order, which is also the order ownership is taken in.** A signal that has already aborted ends the call
 * before a contract is read; then the contract, then the host agent directory, then the call's own storage, and only
 * then a child. Each of the three in front of the child throws rather than reporting a run, because none of them took
 * anything: a contract this host cannot read and an agent directory it cannot resolve are this install's own problem
 * and are wrapped in one fixed sentence with the original kept as the cause, and a storage failure is rethrown
 * exactly as it came, because `pi-storage.ts` composes its own actionable repair message and a wrapper would bury it.
 *
 * **What is retained, and why conservatively.** A call's storage is removed only when the ending left no concern at
 * all, which is `pi-outcome.ts`'s decision and not one repeated here: every held pipe, leftover process, skipped
 * identity, deadline and unverified stop keeps the directory, because a call directory a process may still be writing
 * into is not one to remove. The one place this module decides for itself is a preparation that rejected: with the
 * start seam never entered there is definitely no child, so the storage goes; with it entered there may be one this
 * host was never handed, so the call ends `unverified` and the storage stays. That is conservative on purpose — a
 * seam that spawned nothing still leaves this host unable to say so. Retention is said out loud either way: a run
 * whose storage was kept carries `STORAGE_RETAINED` after its own diagnostic, and the disposal this module reports for
 * it says the directory stayed, which is what `pi-outcome.ts` composes the run's own `cleanupNotice` line out of.
 *
 * **One finalize, one report.** Every ending that has a run to report goes through `finalize`, which closes the steer
 * queue, decides the disposition once for the storage it may remove, finishes the record, adds the retention sentence
 * where one is owed, emits the run's own `turn_result` with that same combined text and one last progress. Nothing
 * here ever calls `child.shutdown`: the preparation and the task each own exactly one stop of their own child, and a
 * second one from above would be a stop on a child this module no longer knows the state of. The host's callbacks are
 * wrapped so a monitor that throws cannot change what the run reports, and the call report is handed to `onCall`
 * exactly once, in the outer `finally`, whichever way the call ended.
 *
 * **What live progress covers, exactly.** The mapper's window opens immediately before the task helper is called and
 * closes when that call has returned, so the records of the preparation are outside it. It is **not** bounded by the
 * turn: the helper stops its own child before it resolves, so records that arrive during that shutdown are still
 * inside this window and can move the live counts and emit events. That is progress and not evidence — `runPiTask`
 * freezes what the turn is judged on before it stops the child, so nothing arriving afterwards changes the outcome.
 * What a turn that finished then republishes is exactly its canonical accounting: the token, cache, cost and context
 * fields are overwritten from the preparation's delta, so a late usage record cannot survive in them. `toolCalls` and
 * `activity` are **not** overwritten, so either one can still carry a record that arrived while the task helper was
 * stopping its child. That is an honest limit of a window with no earlier seam to close, not a defect to patch here:
 * narrowing it would need a seam the task does not have, and inventing one is not this slice's work.
 */

/** Contracts sit beside the extension, two directories up, the same place the Claude backend reads its own from. */
export const PI_CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts");

/** What a caller is told when this install's own contract file could not be read. The value is kept as the cause. */
export const CONTRACT_UNREADABLE = "the pi backend could not read the contract for this role";

/** And when the host's own agent directory could not be resolved, which is the same kind of local problem. */
export const AGENT_DIR_UNREADABLE = "the pi backend could not read the host agent directory";

/**
 * The message a composition failure falls back to when the value it failed with is not an `Error` to take a message
 * from. It is only ever used for the one path that has to rethrow something of its own: a preparation that rejected
 * before a child existed and whose storage then could not be removed either.
 */
export const CALL_NOT_COMPOSED = "the pi call could not be composed";

/**
 * What a run whose storage was kept says about it. Retention is a decision this host made and a directory a person may
 * have to go and look at, so it is reported rather than left as a silent difference between two runs that read alike.
 * It is fixed text: the path, what a child wrote and what anything threw are evidence where they are kept, and none of
 * them is composed into it. A disposal that was attempted and failed is the other case and keeps its own sentences.
 */
export const STORAGE_RETAINED = "This call's own storage was retained because cleanup did not finish cleanly.";

/**
 * Where one call stopped, as this composition itself names it. Each is a place this module decides something: the
 * three in front of the child, the two ways a preparation can end, the task, and the two rejections — a value thrown
 * out of a helper rather than reported by it — that leave this host unable to say what became of a child.
 */
export type PiCallStage = "aborted-before-start" | "contract" | "agent-dir" | "storage" | "prepare-rejected" | "prepare-refused" | "task" | "task-rejected";

/**
 * What one call did, for a test and for nothing else: it is handed to `onCall` and never to a user, a record or a
 * card. `thrown` and `disposeError` are exact values kept by presence, so `undefined` is a value like any other, and
 * neither of them may be composed into anything a person reads — `pi-outcome.ts` owns every sentence for that.
 */
export interface PiCallReport {
	stage: PiCallStage;
	/** Whether the start seam was entered at all, which is what says a child may exist. */
	startCalled: boolean;
	/** Whether it handed one back, which is what says the preparation owned one. */
	startResolved: boolean;
	ended?: PiEnded;
	disposition?: PiDisposition;
	storage?: { callDir: string; attempted: boolean; disposed: boolean; disposeError?: { error: unknown } };
	thrown?: { error: unknown };
}

/** The storage half of one report, named so the paths that fill it in hold it directly rather than by lookup. */
type PiCallStorageReport = NonNullable<PiCallReport["storage"]>;

/**
 * The seams one backend is built with. Every one of them is internal: there is no parameter, variable or setting a
 * user reaches any of it through, and production leaves them all unset and gets the real contract file, the SDK's own
 * agent-directory accessor, the production storage, the transport's own start and the real task.
 */
export interface PiBackendDeps {
	/** The host's agent directory. The default reaches the SDK dynamically, and only when a real call asks for it. */
	agentDir?: () => Promise<string>;
	readContract?: (name: string) => string;
	storage?: (request: StorageRequest) => PreparedCall;
	start?: (options: PiChildOptions) => Promise<PiChild>;
	task?: (request: PiTaskRequest) => Promise<PiTaskResult>;
	cleanup?: OwnedCleanup;
	bounds?: Partial<PiBounds>;
	bootstrap?: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	onCall?: (report: PiCallReport) => void;
}

/** The contract as this install ships it: read where it lies, by name, with nothing resolved against a user path. */
const readRoleContract = (name: string): string => readFileSync(path.join(PI_CONTRACTS_DIR, name), "utf8");

/** Nothing attempted and nothing left behind, which is what every path with no storage of its own reports. */
const NO_DISPOSAL: PiDisposal = { attempted: false, failed: false };

/** A removal nobody tried, because the ending left a concern: the directory is still there, so it is reported as such. */
const STORAGE_KEPT: PiDisposal = { attempted: false, failed: false, retained: true };

/** The message a failure that has to be thrown from here carries, with the original's own text where it has one. */
const composeFailure = (error: unknown): string => `${error instanceof Error ? error.message : CALL_NOT_COMPOSED} ${DISPOSE_FAILED}`;

/**
 * One call, start to finish. The whole body is inside one `try`/`finally` so that the steer queue is closed and the
 * call report handed over once whichever way it ends, a thrown composition failure included.
 */
async function runPiCall(request: RunRequest<PiRole, PiSession, PiSteerQueue>, deps: PiBackendDeps): Promise<PiRun> {
	const now = deps.now ?? Date.now;
	const started = now();
	const role = request.role;
	const run = newRun(role);
	// The caller's queue when it has one, so the steers a user pushes reach this turn, and one of this call's own when
	// it has none: the task closes what it was given, and a queue is what closes the child's input.
	const queue = request.input ?? new PiSteerQueue();
	// The entry state, which every terminal path below overwrites with the stage it actually stopped at.
	const report: PiCallReport = { stage: "aborted-before-start", startCalled: false, startResolved: false };

	// The host's own callbacks, wrapped: a monitor that throws is not a reason for a run to report something else.
	const progress = (): void => {
		try {
			request.onProgress(run);
		} catch {}
	};
	const emit = (event: ChildEvent): void => {
		try {
			request.onEvent?.(event);
		} catch {}
	};

	/**
	 * The one way a call that has a run to report ends. The disposition is decided once, from the ending, and used for
	 * both things it decides: whether this call's own storage may be removed, and what the record then says. A disposal
	 * that failed is a note rather than a failure — `finishRun` puts it in a successful run's text — so the terminal
	 * event says so when the run itself has nothing to say.
	 */
	const finalize = (ended: PiEnded, storage?: PreparedCall): PiRun => {
		queue.end();
		const decided = disposition(ended);
		report.ended = ended;
		report.disposition = decided;
		let disposal = NO_DISPOSAL;
		if (storage !== undefined) {
			if (decided.safe) {
				let broke = false;
				try {
					storage.dispose();
				} catch (error) {
					broke = true;
					if (report.storage !== undefined) report.storage.disposeError = { error };
				}
				if (report.storage !== undefined) {
					report.storage.attempted = true;
					report.storage.disposed = !broke;
				}
				disposal = { attempted: true, failed: broke };
			} else disposal = STORAGE_KEPT;
		}
		const final = finishRun(run, ended, decided, disposal, now() - started);
		// Storage kept is a decision this call made, so it is said rather than left implicit: one more fixed sentence after
		// the diagnostic, which is what says why it was kept, and never the directory's own path. The shorter line a
		// person is shown for a cancelled run is not composed here: `finishRun` was told the directory stayed, through
		// `retained` on the disposal above, and it is the one composer of the run's `cleanupNotice` and of the activity a
		// cancelled run carries it in.
		if (storage !== undefined && !decided.safe) {
			final.errorMessage = final.errorMessage === undefined ? STORAGE_RETAINED : `${final.errorMessage} ${STORAGE_RETAINED}`;
		}
		const message = final.errorMessage ?? (disposal.failed ? DISPOSE_WARNING : undefined);
		emit({ type: "turn_result", ok: !failed(final), ...(message === undefined ? {} : { message }) });
		progress();
		return final;
	};

	try {
		// Before anything is read or made: a call that was cancelled took no contract, no directory and no child, so
		// there is nothing to remove and nothing to stop.
		if (request.signal?.aborted === true) return finalize({ kind: "none" });

		let contract: string;
		try {
			contract = (deps.readContract ?? readRoleContract)(role.contract);
		} catch (error) {
			report.stage = "contract";
			report.thrown = { error };
			throw new Error(CONTRACT_UNREADABLE, { cause: error });
		}

		let agentDir: string;
		try {
			agentDir = await (deps.agentDir ?? hostAgentDir)();
		} catch (error) {
			report.stage = "agent-dir";
			report.thrown = { error };
			throw new Error(AGENT_DIR_UNREADABLE, { cause: error });
		}

		let storage: PreparedCall;
		try {
			// `StorageRequest` calls this field `handle`, and it is the name of a directory rather than the host's own
			// handle for the run: a `RunRequest` carries no handle, so this slice passes the role's name as a label that
			// is safe to put in a path, and `mkdtemp` is what makes one invocation's directory unique. Passing the real
			// host handle is the run lifecycle's to do when it composes these calls.
			storage = (deps.storage ?? prepareCallStorage)({ hostAgentDir: agentDir, cwd: request.cwd, handle: role.name });
		} catch (error) {
			report.stage = "storage";
			report.thrown = { error };
			// Exactly as it came: storage composes its own actionable repair message, and wrapping it would bury it.
			throw error;
		}
		const storageReport: PiCallStorageReport = { callDir: storage.callDir, attempted: false, disposed: false };
		report.storage = storageReport;

		const observer = taskObserver();
		const mapper = progressMapper(run, { progress, event: emit });
		// The observer first, because the task's own evidence is what a run is judged by and the mapper is what a person
		// watches: a mapper that somehow consumed a record before the count would cost the turn that record.
		const onEvent = (event: PiEvent): void => {
			observer.onEvent(event);
			mapper.onEvent(event);
		};
		const intent: SessionIntent = request.session?.intent ?? { kind: "new" };

		// Around the start seam rather than inside the preparation, because what this records is whether a child could
		// exist at all: entered is enough to keep this call's storage, and resolved is what says one was handed over.
		const start = async (options: PiChildOptions): Promise<PiChild> => {
			report.startCalled = true;
			const child = await (deps.start ?? startPiChild)(options);
			report.startResolved = true;
			return child;
		};

		const prepareRequest: PiPrepareRequest = {
			role,
			storage,
			intent,
			contract,
			onEvent,
			start,
			...(request.signal === undefined ? {} : { signal: request.signal }),
			...(request.onQuestion === undefined ? {} : { onQuestion: request.onQuestion }),
			...(request.killGraceMs === undefined ? {} : { killGraceMs: request.killGraceMs }),
			...(deps.cleanup === undefined ? {} : { cleanup: deps.cleanup }),
			...(deps.bounds === undefined ? {} : { bounds: deps.bounds }),
			...(deps.bootstrap === undefined ? {} : { bootstrap: deps.bootstrap }),
			...(deps.env === undefined ? {} : { env: deps.env }),
		};

		let prepared: PiPrepareResult;
		try {
			prepared = await preparePiChild(prepareRequest);
		} catch (error) {
			report.stage = "prepare-rejected";
			report.thrown = { error };
			if (report.startCalled) {
				// The seam was entered, so a child may be running that this host was never handed: nothing is stopped for
				// it — there is no handle to stop — and the storage stays, because a directory a process may still be
				// writing into is not one to remove. A seam that in fact spawned nothing is covered by the same rule.
				return finalize({ kind: "unverified", where: "prepare" }, storage);
			}
			// Definitely no child: the composition failed in front of the start, so this call's own directory goes and
			// the caller gets what it failed with. A removal that failed is the one thing added to it.
			let failedDispose = false;
			try {
				storage.dispose();
			} catch (disposeError) {
				failedDispose = true;
				storageReport.disposeError = { error: disposeError };
			}
			storageReport.attempted = true;
			storageReport.disposed = !failedDispose;
			if (!failedDispose) throw error;
			throw new Error(composeFailure(error), { cause: error });
		}

		if (!prepared.ok) {
			// The preparation already stopped whatever it had claimed, once, and reported what that attempt said.
			report.stage = "prepare-refused";
			return finalize({ kind: "prepare", refused: prepared }, storage);
		}

		// The identity the child stands on before its turn, which is what a demoted success is published under.
		const identity: PiPreparedIdentity = { session: prepared.session, selection: prepared.selection };
		run.session = { ...prepared.session };
		run.sessionId = prepared.session.sessionId;
		run.selection = { ...prepared.selection };
		run.modelId = prepared.selection.model;
		const context = prepared.usage.contextUsage;
		if (context !== undefined) run.contextWindow = context.contextWindow;
		run.activity = "waiting for model";
		emit({ type: "init", sessionId: prepared.session.sessionId });
		progress();

		const taskRequest: PiTaskRequest = {
			prepared,
			prompt: request.prompt,
			observer,
			input: queue,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		};
		let ran: { ok: true; result: PiTaskResult } | { ok: false; error: unknown };
		try {
			// Opened here, so the preparation's own records are outside it, and closed when this call returns — which is
			// after the task has stopped its child, because there is no seam to close it any earlier. Records that arrive
			// during that stop still move the live counts and still reach a monitor; what they cannot do is change the
			// outcome, which the task froze before stopping the child, or the canonical usage a turn that finished
			// publishes over them.
			mapper.begin();
			ran = { ok: true, result: await (deps.task ?? runPiTask)(taskRequest) };
		} catch (error) {
			ran = { ok: false, error };
		} finally {
			mapper.end();
		}
		if (!ran.ok) {
			// The task owns one stop of its child on every path of its own, so a value thrown out of it may already have
			// spent that stop: nothing is stopped from here, and the ending says what it is, which is that this host
			// cannot say how the run ended.
			report.stage = "task-rejected";
			report.thrown = { error: ran.error };
			return finalize({ kind: "unverified", where: "task", prepared: identity }, storage);
		}
		report.stage = "task";
		return finalize({ kind: "task", result: ran.result, prepared: identity }, storage);
	} finally {
		// Idempotent, and after every terminal callback: a queue nobody closed would leave a caller pushing steers into
		// a call that is over.
		queue.end();
		try {
			deps.onCall?.(report);
		} catch {}
	}
}

/**
 * A Pi backend over these seams. It is a factory rather than an instance because nothing registers one: a module-level
 * instance would be a backend this build could run by accident, and Pi is refused before a handle is taken.
 */
export function createPiBackend(deps: PiBackendDeps = {}): Backend<PiRole, PiSession, PiSteerQueue> {
	return {
		name: "pi",
		control: () => new PiSteerQueue(),
		session: piSession,
		run: (request) => runPiCall(request, deps),
	};
}
