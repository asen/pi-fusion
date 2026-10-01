import type { Backend, BackendName, ChildControl, ChildRun, HostBackend, HostRole, HostSession, ResolvedSelection, RunRequest, SessionIntent, SessionRef } from "../extensions/backends/types.ts";
import { hostBackend } from "../extensions/backends/types.ts";

/**
 * A backend the tests inject in place of a real harness. It starts no process, speaks no protocol and reads no
 * configuration: it scripts what each run reports and captures what the host asked of it, so the shared lifecycle
 * can be driven end to end in memory. It is not a Pi emulator and proves nothing about Pi; what it proves is what
 * Fusion does with a backend's answers. A real child's own semantics stay the lifecycle spike's to measure.
 */

/** The session request this backend makes for a run: the host's display view, with the intent it was mapped from. */
export interface FakeSession extends HostSession {
	/** The whole intent the host handed over, which the display view flattens. Only the fake reads this. */
	intent: SessionIntent;
}

/** What one run reports, and how it behaves while it runs. Everything is optional; the defaults are a policy-correct run. */
export interface FakeScript {
	/** The child's report. */
	text?: string;
	/** The verified reference the outcome carries: one of the caller's own, or null for a run that verified none. */
	session?: SessionRef | null;
	/** The selection the child read back, or null for an outcome that reports none. */
	selection?: ResolvedSelection | null;
	/** A scalar session id beside the reference, which on a backend identified by a reference is a diagnostic only.
	 * Null is an outcome that reports none at all, which for the Claude shape is a run with no flat identity. */
	sessionId?: string | null;
	/** The checkpoint of the default reference, or of a Claude run's flat outcome. Null drops it. */
	checkpoint?: string | null;
	/** The identity a run that opens a session allocates, instead of the one the fake would generate. */
	newId?: string;
	newFile?: string;
	contextTokens?: number;
	contextWindow?: number;
	/** Questions the child asks, in order, before it settles. */
	questions?: string[];
	/** The run holds until the test calls `release()` on its start. */
	pending?: boolean;
	/** The run fails, with this text as its error message when it is one. */
	fail?: boolean | string;
	/** `run` throws instead of returning an outcome: a backend that broke, not a child that failed. */
	throws?: string;
	/** The same, after the run has reported progress once: a backend that broke with a claim already in flight. */
	throwsLate?: string;
	/**
	 * Fields set on the terminal outcome this run returns, over the ones a backend of this name would report. No
	 * production backend has any of them: this is how a test plants what an outcome carrying unknown metadata would look
	 * like — a credential-looking field, a path, a structured blob — so what the host composes from an outcome can be
	 * shown to be the fields it names and nothing else. Test-only, and absent it changes nothing: a run without it
	 * reports exactly what it reported before.
	 */
	extra?: Record<string, unknown>;
	/**
	 * What the run reports while it is still going, over what its outcome reports. A child can claim a session in
	 * progress and return another, or none, and nothing the host has not checked may be kept from either.
	 */
	running?: Omit<FakeScript, "running" | "onAbort" | "questions" | "pending" | "throws" | "throwsLate" | "runningProgress" | "finalProgress" | "extra">;
	/** False reports no progress at all, so the returned outcome is the only thing the host ever hears from the run. */
	runningProgress?: boolean;
	/** False leaves the settled outcome out of the progress stream, so the returned value is the only place it is. */
	finalProgress?: boolean;
	/** What the outcome becomes when the run is aborted, over a cancelled run's own defaults. */
	onAbort?: Omit<FakeScript, "onAbort" | "questions" | "pending" | "throws">;
	costUsd?: number;
	/** The line the child was last on, as an outcome may report one. Absent it changes nothing: no outcome carried one before. */
	activity?: string;
	/**
	 * The fixed line a backend puts on an outcome to say what the ending left for a person to look at. A Pi backend
	 * writes one for a cleanup that did not finish or a call directory it kept; a Claude one never does. It is scripted
	 * on the terminal outcome, and on the aborted one through `onAbort`, because a cancelled run is where it matters.
	 * A backend that writes one may mirror it into `activity` as well, which the Pi one does for a cancelled run, so a
	 * script that sets both is what an outcome of that shape looks like to this host.
	 */
	cleanupNotice?: string;
}

/** One run the host started on this backend, as the backend saw it, with the channels the test drives it through. */
export interface FakeStart {
	role: HostRole;
	prompt: string;
	title?: string;
	session?: FakeSession;
	/** The intent the host mapped into that session, which is what a continuation test reads. */
	intent?: SessionIntent;
	/** The steers the host pushed into this run, in order. */
	steers: string[];
	/** The answers the run's questions got, in order. */
	answers: string[];
	/** Resolves with the next steer that arrives, or at once with one that arrived and no waiter took. */
	nextSteer(): Promise<string>;
	/** Lets a pending run settle, with these fields over the ones it was scripted with. */
	release(over?: Partial<FakeScript>): void;
	/** Resolves when the run's outcome has been handed back to the host. */
	ended: Promise<void>;
}

export interface FakeBackendOptions {
	/** The backend this one stands in for. The host's own bindings and records read this name, so it matters. */
	name?: BackendName;
	/** The effort a run reports when the role's binding named none, which is what a first Pi call leaves to the child. */
	defaultEffort?: string;
	/** The scripts the first runs take, in order. The last one repeats for every run after them. */
	scripts?: FakeScript[];
}

export interface FakeBackend {
	name: BackendName;
	backend: HostBackend;
	/** Every run the host started here, in order. */
	starts: FakeStart[];
	/** Every intent the host asked this backend to map, which a run it never started leaves empty. */
	sessions: SessionIntent[];
	/** Queues the scripts the next runs take, replacing what was queued before. */
	script(...scripts: FakeScript[]): void;
	/** Resolves once the nth run (1-based) has started, so a test gates on the run rather than on a timer. */
	started(n?: number, ms?: number): Promise<FakeStart>;
}

/** A steer queue that records what the host pushed and hands each steer to whoever waits for it. */
class FakeControl implements ChildControl {
	open = true;
	readonly pushed: string[] = [];
	private readonly waiters: Array<(text: string) => void> = [];
	private taken = 0;

	push(text: string): boolean {
		if (!this.open) return false;
		this.pushed.push(text);
		const waiter = this.waiters.shift();
		if (waiter) {
			this.taken += 1;
			waiter(text);
		}
		return true;
	}

	end(): void {
		this.open = false;
	}

	next(): Promise<string> {
		const held = this.pushed[this.taken];
		if (held !== undefined) {
			this.taken += 1;
			return Promise.resolve(held);
		}
		return new Promise<string>((resolve) => this.waiters.push(resolve));
	}
}

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
};

/** The session request an intent becomes here: the same pure mapping a real backend makes, and no session opened. */
function fakeSession(name: BackendName, intent: SessionIntent): FakeSession {
	if (intent.kind === "new") return { kind: "new", intent };
	const ref = intent.kind === "resume" ? intent.ref : intent.from;
	if (ref.backend !== name) throw new Error(`${ref.backend} session ${ref.sessionId} cannot be continued by the ${name} backend`);
	const at = ref.checkpoint === undefined ? {} : { at: ref.checkpoint };
	const file = ref.backend === "pi" ? { file: ref.sessionFile } : {};
	if (intent.kind === "resume") return { kind: "resume", id: ref.sessionId, ...file, ...at, intent };
	return { kind: "fork", from: ref.sessionId, ...file, ...at, intent };
}

/** The reference a run of this backend verified, before a script overrides it: what a correct child would report. */
function defaultRef(name: BackendName, intent: SessionIntent | undefined, script: FakeScript, ok: boolean, serial: number): SessionRef | undefined {
	const source = intent?.kind === "resume" ? intent.ref : intent?.kind === "fork" ? intent.from : undefined;
	if (name === "claude") return undefined;
	const held = source?.backend === "pi" ? source : undefined;
	const resumed = intent?.kind === "resume" && held;
	// A fork is a session of its own, so its default identity is derived from the source rather than numbered beside
	// it: a fork that reported the session it forked from is a postcondition failure, never a fake's accident.
	const fresh = intent?.kind === "fork" && held ? `${held.sessionId}-fork-${serial}` : `pi-${serial}`;
	const sessionId = resumed ? held.sessionId : (script.newId ?? fresh);
	const sessionFile = resumed ? held.sessionFile : (script.newFile ?? `/sessions/${sessionId}.jsonl`);
	// A settled call's checkpoint is the point it settled on; a fork that failed keeps the point it forked at, and a
	// first call that failed has none at all, which is the recovery policy this backend is scripted against.
	const checkpoint = ok ? `entry-${serial}` : intent?.kind === "fork" ? held?.checkpoint : undefined;
	return { backend: "pi", sessionId, sessionFile, ...(checkpoint === undefined ? {} : { checkpoint }) };
}

export function fakeBackend(options: FakeBackendOptions = {}): FakeBackend {
	const name = options.name ?? "pi";
	const defaultEffort = options.defaultEffort ?? "medium";
	let scripts: FakeScript[] = options.scripts ? [...options.scripts] : [];
	const starts: FakeStart[] = [];
	const sessions: SessionIntent[] = [];
	const watchers: Array<() => void> = [];
	let serial = 0;

	const announce = () => {
		for (const watcher of watchers.splice(0)) watcher();
	};

	const scriptFor = (index: number): FakeScript => scripts[Math.min(index, scripts.length - 1)] ?? {};

	const backend: Backend<HostRole, FakeSession, FakeControl> = {
		name,
		control: () => new FakeControl(),
		session: (intent) => {
			sessions.push(intent);
			return fakeSession(name, intent);
		},
		run: async (request: RunRequest<HostRole, FakeSession, FakeControl>): Promise<ChildRun<HostRole>> => {
			const index = starts.length;
			const script = scriptFor(index);
			serial += 1;
			const mine = serial;
			const input = (request.input as FakeControl | undefined) ?? new FakeControl();
			const gate = deferred<Partial<FakeScript>>();
			const done = deferred<void>();
			const start: FakeStart = {
				role: request.role,
				prompt: request.prompt,
				...(request.title === undefined ? {} : { title: request.title }),
				...(request.session === undefined ? {} : { session: request.session, intent: request.session.intent }),
				steers: input.pushed,
				answers: [],
				nextSteer: () => input.next(),
				release: (over) => gate.resolve(over ?? {}),
				ended: done.promise,
			};
			starts.push(start);
			announce();
			try {
				if (script.throws) throw new Error(script.throws);
				const outcome = async (): Promise<ChildRun<HostRole>> => {
					let over: Partial<FakeScript> = {};
					let aborted = false;
					const stopped = new Promise<void>((resolve) => {
						if (request.signal?.aborted) return resolve();
						request.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					// A backend need not report progress at all: a child that settles in one turn can say nothing until it ends.
					if (script.runningProgress !== false) request.onProgress(child(request.role, { ...script, ...script.running }, { name, defaultEffort }, undefined, mine, false, 1));
					if (script.throwsLate) throw new Error(script.throwsLate);
					try {
						for (const text of script.questions ?? []) {
							if (!request.onQuestion) throw new Error("the run was started without a question channel");
							start.answers.push(await request.onQuestion(text, request.signal ?? new AbortController().signal));
						}
						if (script.pending) over = await Promise.race([gate.promise, stopped.then(() => ({}))]);
					} catch (error) {
						if (!request.signal?.aborted) throw error;
					}
					aborted = request.signal?.aborted === true;
					// A run nobody let finish verified nothing, unless the script says what the child had already reported.
					const merged: FakeScript = aborted ? { ...script, session: null, selection: null, ...script.onAbort, ...over } : { ...script, ...over };
					const settled = child(request.role, merged, { name, defaultEffort }, request.session?.intent, mine, aborted, 2);
					// Planted last and on the terminal outcome alone, so they are exactly what this backend would never report.
					return merged.extra === undefined ? settled : { ...settled, ...merged.extra };
				};
				const result = await outcome();
				// A backend need not announce its own settled outcome as progress, and a host that only reads the
				// progress stream would then keep the last thing the child said instead of what it returned.
				if (script.finalProgress !== false) request.onProgress(result);
				return result;
			} finally {
				done.resolve();
			}
		},
	};

	return {
		name,
		backend: hostBackend(backend),
		starts,
		sessions,
		script: (...next: FakeScript[]) => {
			scripts = next;
		},
		// A deadline, because a test that waits for a run the host never started must fail rather than hang.
		started: (n = 1, ms = 5_000) =>
			new Promise<FakeStart>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`the ${name} backend did not start run ${n}; it started ${starts.length}`)), ms);
				timer.unref();
				const check = () => {
					const start = starts[n - 1];
					if (!start) return watchers.push(check);
					clearTimeout(timer);
					resolve(start);
				};
				check();
			}),
	};
}

/** The outcome record a scripted run hands back, built the way a correct backend of this name would build it. */
function child(
	role: HostRole,
	script: FakeScript,
	backend: { name: BackendName; defaultEffort: string },
	intent: SessionIntent | undefined,
	serial: number,
	aborted: boolean,
	toolCalls: number,
): ChildRun<HostRole> {
	const ok = !aborted && !script.fail;
	const base = defaultRef(backend.name, intent, script, ok, serial);
	const ref = script.session === undefined ? base : (script.session ?? undefined);
	const checkpoint = script.checkpoint;
	const session =
		ref === undefined
			? undefined
			: checkpoint === undefined
				? ref
				: checkpoint === null
					? { ...ref, checkpoint: undefined }
					: { ...ref, checkpoint };
	const selection =
		script.selection === undefined
			? backend.name === "pi"
				? { model: role.model, effort: (role as HostRole & { effort?: string }).effort ?? backend.defaultEffort }
				: undefined
			: (script.selection ?? undefined);
	const flatId = script.sessionId === null ? undefined : backend.name === "claude" ? (script.sessionId ?? `c-${serial}`) : script.sessionId;
	const flatCheckpoint = backend.name === "claude" ? (checkpoint === null ? undefined : (checkpoint ?? (ok ? `m-${serial}` : undefined))) : undefined;
	const failure = typeof script.fail === "string" ? script.fail : "the child reported a failure";
	return {
		role,
		text: script.text ?? "## Changed\nfoo.ts",
		toolCalls,
		tokensIn: 10,
		tokensOut: 5,
		cacheRead: 0,
		cacheWrite: 0,
		...(script.costUsd === undefined ? {} : { costUsd: script.costUsd }),
		...(session === undefined ? {} : { session: session.checkpoint === undefined ? stripCheckpoint(session) : session }),
		...(flatId === undefined ? {} : { sessionId: flatId }),
		...(flatCheckpoint === undefined ? {} : { checkpoint: flatCheckpoint }),
		...(selection === undefined ? {} : { selection }),
		...(script.contextTokens === undefined ? {} : { contextTokens: script.contextTokens }),
		...(script.contextWindow === undefined ? {} : { contextWindow: script.contextWindow }),
		ms: 1,
		exitCode: aborted ? null : script.fail ? 1 : 0,
		signal: null,
		aborted,
		...(aborted ? {} : { stopReason: script.fail ? "error" : "stop" }),
		...(script.fail ? { errorMessage: failure } : {}),
		...(script.activity === undefined ? {} : { activity: script.activity }),
		...(script.cleanupNotice === undefined ? {} : { cleanupNotice: script.cleanupNotice }),
		stderr: "",
	};
}

/** A reference with no checkpoint at all, rather than one carrying an undefined: a record must not hold the key. */
function stripCheckpoint(ref: SessionRef): SessionRef {
	const { checkpoint: _dropped, ...rest } = ref as SessionRef & { checkpoint?: string };
	return rest as SessionRef;
}
