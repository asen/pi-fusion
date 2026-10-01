/**
 * The boundary between the shared run lifecycle and the harness a child runs in. Nothing here names a backend's
 * SDK or protocol: a backend translates its own stream into these records and takes its role and session shapes,
 * which stay its own, through the generic parameters.
 */

/** The harnesses a run can go through. A record that names none of them was written before backends were tagged. */
export const BACKEND_NAMES = ["claude", "pi"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export const isBackendName = (value: unknown): value is BackendName => typeof value === "string" && (BACKEND_NAMES as readonly string[]).includes(value);

/**
 * Where a later call finds the child session of a run, verified by the backend that made it. Claude names a session
 * id the SDK resumes; Pi names the session id and the file that holds it, because a Pi session is only reachable
 * through its own transcript file. The checkpoint is the durable point a continuation restores, when one is trusted.
 */
export interface ClaudeSessionRef {
	backend: "claude";
	sessionId: string;
	checkpoint?: string;
}

export interface PiSessionRef {
	backend: "pi";
	sessionId: string;
	/** The transcript file the session lives in: half of a Pi session's identity, never optional in a known reference. */
	sessionFile: string;
	checkpoint?: string;
}

export type SessionRef = ClaudeSessionRef | PiSessionRef;

/** What the host asks of a session, with no backend detail in it: a backend maps this to its own session shape. */
export type SessionIntent = { kind: "new" } | { kind: "resume"; ref: SessionRef } | { kind: "fork"; from: SessionRef };

/** The model and effort a call asks for, before a backend has validated them against what the child offers. */
export interface SelectionRequest {
	model: string;
	effort?: string;
}

/** The model and effort the child actually runs with, read back from it, so a continuation repeats that selection. */
export interface ResolvedSelection {
	model: string;
	effort: string;
}

/**
 * Pi's own thinking levels, which a resolved Pi selection names one of. The host validates a stored selection against
 * this list without reaching into an adapter; which of them a model offers is the adapter's check, not this one.
 */
export const PI_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const named = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/**
 * A Pi model id, split where Pi splits it: the provider up to the first slash, and the model id after it, which is
 * opaque and can hold slashes of its own, as `openrouter/deepseek/deepseek-chat` does. Nothing here resolves a model
 * by pattern, names a known provider or guesses one from a bare id; whether the model exists is the adapter's check.
 */
export function piModelParts(value: unknown): { provider: string; model: string } | undefined {
	const id = named(value);
	if (!id) return undefined;
	const slash = id.indexOf("/");
	if (slash === -1) return undefined;
	const provider = id.slice(0, slash).trim();
	const model = id.slice(slash + 1).trim();
	return provider && model ? { provider, model } : undefined;
}

/** True for a value a Pi selection may name as its model: a provider and a model id, and nothing else. */
export const isPiModel = (value: unknown): boolean => piModelParts(value) !== undefined;

/**
 * A session reference read back from a record or an outcome, or undefined when the value is not one this host may
 * act on. A Pi reference without its session file is such a value: the file is half of the identity, not a detail.
 */
export function sessionRefOf(value: unknown, backend: "claude"): ClaudeSessionRef | undefined;
export function sessionRefOf(value: unknown, backend: "pi"): PiSessionRef | undefined;
export function sessionRefOf(value: unknown, backend?: BackendName): SessionRef | undefined;
export function sessionRefOf(value: unknown, backend?: BackendName): SessionRef | undefined {
	const data = value as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const tag = data.backend === undefined ? backend : isBackendName(data.backend) ? data.backend : undefined;
	if (tag === undefined || (backend !== undefined && tag !== backend)) return undefined;
	const sessionId = named(data.sessionId);
	if (!sessionId) return undefined;
	const checkpoint = named(data.checkpoint);
	if (data.checkpoint !== undefined && checkpoint === undefined) return undefined;
	const at = checkpoint === undefined ? {} : { checkpoint };
	if (tag === "claude") return data.sessionFile === undefined ? { backend: "claude", sessionId, ...at } : undefined;
	const sessionFile = named(data.sessionFile);
	return sessionFile ? { backend: "pi", sessionId, sessionFile, ...at } : undefined;
}

/** The selection a record or an outcome carries, or undefined when it is not one a continuation could repeat. */
export function resolvedSelectionOf(value: unknown, backend: BackendName): ResolvedSelection | undefined {
	const data = value as Record<string, unknown> | null;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const model = named(data.model);
	const effort = named(data.effort);
	if (!model || !effort) return undefined;
	if (backend === "claude") return { model, effort };
	// A Pi model is a provider and a model id, read by the same grammar a request is read by, so a record this host
	// wrote always reads back as the selection it meant, however many slashes the provider's own id carries.
	if (!isPiModel(model)) return undefined;
	return (PI_EFFORTS as readonly string[]).includes(effort) ? { model, effort } : undefined;
}

/**
 * How long a field of a session reference or a selection may be for a record outside the host branch to keep it.
 * A session file is a path, and a path can be long: this is far over any platform's own limit, so a value past it
 * is a value nothing here expects rather than a long one to shorten.
 */
export const REF_FIELD_MAX_CHARS = 32_768;

/**
 * The reference a monitor or a history file may keep, read by the same grammar every other reader uses and with
 * every field exactly as the backend reported it. A reference is opaque: a session id, a session file and a
 * checkpoint are matched, opened and copied whole, so a shortened one is a different identity, not a smaller one.
 * A field past the ceiling therefore drops the whole reference rather than a part of it, and the run keeps none.
 * The host branch is not bounded by this: what a continuation resumes from is the entry, and it is never cut.
 */
export function keptRef(value: unknown, backend: BackendName, max = REF_FIELD_MAX_CHARS): SessionRef | undefined {
	const ref = sessionRefOf(value, backend);
	if (!ref) return undefined;
	const fields = [ref.sessionId, ref.checkpoint, ...(ref.backend === "pi" ? [ref.sessionFile] : [])];
	return fields.every((field) => field === undefined || field.length <= max) ? ref : undefined;
}

/** The selection such a record may keep, under the same rule: a shortened model id names another model, not this one. */
export function keptSelection(value: unknown, backend: BackendName, max = REF_FIELD_MAX_CHARS): ResolvedSelection | undefined {
	const selection = resolvedSelectionOf(value, backend);
	if (!selection) return undefined;
	return selection.model.length <= max && selection.effort.length <= max ? selection : undefined;
}

/** One model's share of a run, as the backend reports it: the main loop, subagents and any agents it ran. */
export interface ModelCost {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	contextWindow?: number;
}

/** What a child reports while it works and when it ends, progress and outcome in one record. */
export interface ChildRun<TRole> {
	role: TRole;
	text: string;
	toolCalls: number;
	activity?: string;
	tokensIn: number;
	tokensOut: number;
	/** The main loop's cache reads and writes; `tokensIn` already counts them. */
	cacheRead: number;
	cacheWrite: number;
	/** The backend's running estimate for the whole run, subagents and workflow agents included. */
	costUsd?: number;
	models?: ModelCost[];
	numTurns?: number;
	apiMs?: number;
	/** The model id the backend reported at init, for example `claude-fable-5-1[1m]`. */
	modelId?: string;
	/** The prompt size of the main loop's latest model call: its input plus cache reads and writes. */
	contextTokens?: number;
	contextWindow?: number;
	/** The main loop's latest thinking blocks, oldest first. */
	thinking?: string[];
	workflowTokens?: number;
	deniedTools?: string[];
	/** Background tasks the child still had running when it exited on its own. */
	abandonedTasks?: string[];
	sessionId?: string;
	/** Where a later call resumes or forks this child: a durable point the backend names and the host only carries. */
	checkpoint?: string;
	/** The session the backend verified this run ran in, with its trusted checkpoint when it has one. */
	session?: SessionRef;
	/** What the child actually ran with, read back from it. A backend whose selection cannot drift leaves it unset. */
	selection?: ResolvedSelection;
	ms: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	stopReason?: string;
	errorMessage?: string;
	/**
	 * What this run's ending left for a person to go and look at, in the backend's own fixed text: which parts of a
	 * child's cleanup did not finish, and whether a directory of the call is still there. It is set only when there is
	 * something to say — a run that ended cleanly carries none — and it is bounded by construction: a path, a thrown
	 * value, the child's stderr and anything the child itself wrote are evidence where they are kept and reach none of
	 * it. The lifecycle carries it whole and reads nothing out of it, so a backend that adds nothing changes nothing.
	 */
	cleanupNotice?: string;
	stderr: string;
}

/**
 * True for a run that did not end the way it was meant to: it was aborted, it left background tasks running, or it
 * exited on anything other than a clean stop. Every backend reports its outcome in these fields, so this is shared.
 */
export function failed(run: ChildRun<unknown>): boolean {
	if (run.aborted || run.abandonedTasks?.length) return true;
	return !(run.exitCode === 0 && run.signal === null && run.stopReason === "stop");
}

/** What a run reports to a monitor: task and agent activity the run itself does not keep. */
export type ChildEvent =
	| { type: "init"; sessionId: string }
	| { type: "tool_call"; name: string; brief: string; id?: string; input?: unknown }
	| { type: "agent_tool_call"; parentToolUseId: string; name: string; id?: string; input?: unknown }
	| { type: "tool_result"; toolUseId: string; text: string; isError: boolean }
	| { type: "task_started"; taskId: string; toolUseId?: string; taskType?: string; name: string; subagentType?: string }
	| { type: "task_progress"; taskId: string; description?: string; summary?: string; lastTool?: string; tokens?: number; toolUses?: number; phase?: string; agents?: Array<{ label: string; state: string }> }
	| { type: "task_ended"; taskId: string; status: "completed" | "failed" | "stopped"; summary?: string; tokens?: number }
	| { type: "turn_result"; ok: boolean; message?: string };

/** Answers a child's question, and rejects when the signal aborts, which is what cancelling a waiting run does. */
export type Ask = (question: string, signal: AbortSignal) => Promise<string>;

/** Where the host pushes a steer into a running child, and what closes the child's input when it has no work left. */
export interface ChildControl {
	readonly open: boolean;
	push(text: string): boolean;
	end(): void;
}

/** What the host asks a backend to run, and the callbacks it takes the run's progress and events through. */
export interface RunRequest<TRole, TSession, TControl extends ChildControl = ChildControl> {
	role: TRole;
	prompt: string;
	cwd: string;
	session?: TSession;
	title?: string;
	signal: AbortSignal | undefined;
	/** Where the caller pushes steers. Without it the run takes only the prompt. */
	input?: TControl;
	/** Answers the child's questions. Without it the child gets no question tool. */
	onQuestion?: Ask;
	onProgress: (run: ChildRun<TRole>) => void;
	onEvent?: (event: ChildEvent) => void;
	killGraceMs?: number;
}

/** A harness the host runs a child in. The role and session shapes are the backend's own. */
export interface Backend<TRole, TSession, TControl extends ChildControl = ChildControl> {
	readonly name: BackendName;
	/** A queue of steers for a run the host is about to start, which it holds for the run's lifetime. */
	control(): TControl;
	/**
	 * The session request that intent becomes for this backend, and nothing else: a pure mapping, made before the run
	 * and with no session opened by it. A backend refuses an intent that carries another backend's reference.
	 */
	session(intent: SessionIntent): TSession;
	run(request: RunRequest<TRole, TSession, TControl>): Promise<ChildRun<TRole>>;
}

/**
 * What the host reads of any backend's role, whatever else that backend's own role shape holds: the name records and
 * capabilities use, the model every card and stats line shows, the contract the history names, and an ask run's mode.
 * A backend's role stays its own; this is the part the shared lifecycle may read, and it binds no model and no tools.
 */
export interface HostRole {
	name: string;
	model: string;
	contract: string;
	mode?: "answer" | "review";
}

/**
 * What the host reads of the session request a backend made for a run: enough to show it and keep it in the history.
 * The fields a backend fills are its own business; a Claude session is named by an id, a Pi one by a file as well.
 */
export interface HostSession {
	kind: "new" | "resume" | "fork";
	id?: string;
	from?: string;
	at?: string;
	file?: string;
}

/** A backend the shared lifecycle can run without naming its role and session shapes. */
export type HostBackend = Backend<HostRole, HostSession, ChildControl>;

/**
 * A backend as the host holds it, with its own role and session shapes erased at this one place. The host never
 * invents either of them: it runs the role that backend's binding built and hands back the session that backend's
 * own `session` returned, so the cast here carries values this backend made rather than values shaped for another.
 */
export function hostBackend<TRole extends HostRole, TSession extends HostSession, TControl extends ChildControl>(backend: Backend<TRole, TSession, TControl>): HostBackend {
	return {
		name: backend.name,
		control: () => backend.control(),
		session: (intent) => backend.session(intent),
		run: (request) => backend.run(request as unknown as RunRequest<TRole, TSession, TControl>),
	};
}
