/**
 * The boundary between the shared run lifecycle and the harness a child runs in. Nothing here names a backend's
 * SDK or protocol: a backend translates its own stream into these records and takes its role and session shapes,
 * which stay its own, through the generic parameters.
 */

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
	ms: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
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
	readonly name: string;
	/** A queue of steers for a run the host is about to start, which it holds for the run's lifetime. */
	control(): TControl;
	run(request: RunRequest<TRole, TSession, TControl>): Promise<ChildRun<TRole>>;
}
