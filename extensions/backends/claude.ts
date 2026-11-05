import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createSdkMcpServer,
	type EffortLevel,
	type HookCallback,
	type Options,
	type PermissionMode,
	query,
	type SDKUserMessage,
	type Settings,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resultText } from "../cards.ts";
import { ChildTree, KILL_GRACE_MS } from "../process-tree.ts";
import { canonicalContractBody, suppliedContractBody } from "../role-contracts.ts";
import { type Ask, type Backend, BLOCKER_LABEL_CHARS, type ChildControl, type ChildEvent, type ChildRun, failed, MAX_BLOCKERS, type ModelCost, type RunRequest, type SessionIntent, type SessionRef } from "./types.ts";

/**
 * The Claude Code backend: the SDK options a role runs with, the questions bridge the child asks through, and the
 * stream loop that turns the SDK's messages into the run record and the events the host reads. The role and session
 * shapes here are this backend's own, not the host's: a Claude Code session id is a uuid the host preallocates.
 */

/** Contracts sit beside the extension, two directories up from this backend. */
export const CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts");
/** How much of a child's latest line of thinking or writing its activity shows. */
export const ACTIVITY_CHARS = 60;
const WORKFLOW_LABEL_CHARS = 200;
const MAX_WORKFLOW_AGENTS = 200;
const DELTA_PROGRESS_MS = 250;
const THINKING_BLOCKS = 5;
const THINKING_CHARS = 8_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000;
const QUESTION_SERVER = "pi-fusion";
export const QUESTION_TOOL = "ask_orchestrator";
/** The largest MCP tool-call timeout Claude Code accepts, in ms: a question has no time limit. */
const QUESTION_TIMEOUT_MS = 2_147_483_647;
/** A callback hook's timeout, in seconds, kept under Node's 2,147,483,647 ms timer limit. */
const HOOK_TIMEOUT_S = 2_147_483;

/** A role run as a headless Claude Code session in the host's working directory. */
export interface Role {
	name: string;
	model: string;
	/** A Claude Code effort level, or `ultracode`: xhigh plus the standing Workflow opt-in. */
	effort: string;
	/**
	 * The built-in tools the child gets, and nothing else: no MCP servers. Undefined gives it Claude Code's
	 * full tool set and the user's MCP servers.
	 */
	tools?: string[];
	permissionMode: string;
	contract: string;
	/** The ask role's mode, which picks its contract. The host's own `ASK_MODES` is the same list. */
	mode?: "answer" | "review";
}

/**
 * The Claude Code session a child runs in. Every id is a UUID that `claude --resume` accepts. `at` is the uuid of
 * an assistant message in the session; a resume or fork at it continues from that message on a new branch of the
 * transcript, leaving anything after it in the file but out of context.
 */
export type ChildSession =
	| { kind: "new"; id: string }
	| { kind: "resume"; id: string; at?: string }
	| { kind: "fork"; id: string; from: string; at?: string };

/**
 * The Claude session request an intent becomes: this backend allocates the uuid a new session and a fork run under,
 * and carries a reference's checkpoint as the position to continue from. A reference another backend wrote names a
 * session this one cannot open, so it is refused here rather than resumed as if the id were a Claude one.
 */
export function claudeSession(intent: SessionIntent): ChildSession {
	if (intent.kind === "new") return { kind: "new", id: randomUUID() };
	const ref = intent.kind === "resume" ? intent.ref : intent.from;
	if (ref.backend !== "claude") throw new Error(`${ref.backend} session ${ref.sessionId} cannot be continued by the claude backend`);
	const at = ref.checkpoint ? { at: ref.checkpoint } : {};
	if (intent.kind === "resume") return { kind: "resume", id: ref.sessionId, ...at };
	return { kind: "fork", id: randomUUID(), from: ref.sessionId, ...at };
}

/** A Claude child's run: the shared record over this backend's own role shape. Its checkpoint is a message uuid. */
export type ClaudeRun = ChildRun<Role>;

/** Unset, the SDK runs the Claude Code binary it bundles. A `.js`, `.mjs` or `.cjs` path runs under node. */
export function claudeExecutable(): Pick<Options, "pathToClaudeCodeExecutable" | "executable"> {
	const bin = process.env.PI_FUSION_CLAUDE_BIN?.trim();
	if (!bin) return {};
	if (/\.(js|mjs|cjs)$/i.test(bin)) return { pathToClaudeCodeExecutable: bin, executable: "node" };
	return { pathToClaudeCodeExecutable: bin };
}

/** The variable Claude Code reads a lower proactive auto-compact percentage from. */
export const CLAUDE_COMPACT_VARIABLE = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";

/**
 * What a run's compaction request adds to the child's environment. Claude Code's bundled source (CLI 2.1.281, read,
 * not measured) parses the variable with `parseFloat`, uses it only above 0 and at most 100, and takes the lower of
 * that share of its effective auto-compact window and its own threshold: it can bring compaction earlier and never
 * later, and it turns nothing on. A value the host already exports that Claude Code would read as no higher is kept,
 * so this never postpones the user's own; the window, `DISABLE_AUTO_COMPACT` and every settings file are untouched.
 * Whether a session enforces that threshold at all, rather than waiting for the API's prompt-too-long, is the
 * child's decision and nothing here reads it back.
 */
export function compactionEnv(compactPct: number | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
	if (compactPct === undefined || compactPct <= 0) return {};
	const raw = env[CLAUDE_COMPACT_VARIABLE];
	const existing = raw ? Number.parseFloat(raw) : Number.NaN;
	if (existing > 0 && existing <= compactPct) return {};
	return { [CLAUDE_COMPACT_VARIABLE]: String(compactPct) };
}

/** The SDK's typed effort levels stop at max; `ultracode` is only a CLI flag value. */
function effortOptions(effort: string): Pick<Options, "effort" | "extraArgs"> {
	return effort === "ultracode" ? { extraArgs: { effort } } : { effort: effort as EffortLevel };
}

export function childOptions(role: Role, session: ChildSession | undefined, title: string, contract?: string): Options {
	const options: Options = {
		model: role.model,
		...effortOptions(role.effort),
		permissionMode: role.permissionMode as PermissionMode,
		allowDangerouslySkipPermissions: role.permissionMode === "bypassPermissions",
		permissionPrompts: "none",
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: contract !== undefined ? suppliedContractBody(contract) : canonicalContractBody((name) => fs.readFileSync(path.join(CONTRACTS_DIR, name), "utf8"), role.contract),
		},
		includePartialMessages: true,
		title,
	};
	if (role.tools) {
		options.tools = role.tools;
		options.strictMcpConfig = true;
	}
	const size = process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE?.trim();
	if (role.effort === "ultracode" && size) options.settings = { workflowSizeGuideline: size as Settings["workflowSizeGuideline"] };
	if (session?.kind === "new") options.sessionId = session.id;
	else if (session?.kind === "resume") options.resume = session.id;
	else if (session?.kind === "fork") {
		options.resume = session.from;
		options.forkSession = true;
		options.sessionId = session.id;
	}
	if (session?.kind !== "new" && session?.at) options.resumeSessionAt = session.at;
	return options;
}

function briefArg(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const value = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.description ?? "";
	const text = String(value).split("\n")[0];
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function activityTail(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/\*\*/g, "").trim())
		.filter(Boolean);
	const line = lines[lines.length - 1] ?? "";
	return line.length > ACTIVITY_CHARS ? `…${line.slice(-ACTIVITY_CHARS)}` : line;
}

/** Streams deltas to the status line at most once per window, with a trailing call so the last delta is shown. */
function throttled(ms: number, fn: () => void): { call(): void; cancel(): void } {
	let last = 0;
	let timer: NodeJS.Timeout | undefined;
	const fire = () => {
		timer = undefined;
		last = Date.now();
		fn();
	};
	return {
		call() {
			if (timer) return;
			const wait = ms - (Date.now() - last);
			if (wait <= 0) fire();
			else {
				timer = setTimeout(fire, wait);
				timer.unref();
			}
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

class StreamedBlocks {
	private blocks = new Map<string | number, string>();

	reset(): void {
		this.blocks.clear();
	}

	append(kind: "thinking" | "writing", index: string | number, delta: string): string {
		const text = `${this.blocks.get(index) ?? ""}${delta}`;
		this.blocks.set(index, text);
		const tail = activityTail(text);
		return tail ? `${kind} · ${tail}` : kind;
	}
}

function newRun(role: Role): ClaudeRun {
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

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelCosts(usage: unknown): ModelCost[] {
	if (!usage || typeof usage !== "object") return [];
	return Object.entries(usage as Record<string, any>).map(([model, entry]) => ({
		model,
		inputTokens: count(entry?.inputTokens),
		outputTokens: count(entry?.outputTokens),
		cacheRead: count(entry?.cacheReadInputTokens),
		cacheWrite: count(entry?.cacheCreationInputTokens),
		costUsd: count(entry?.costUSD),
		...(typeof entry?.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
	}));
}

function promptTokens(usage: any): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const total = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
	return total > 0 ? total : undefined;
}

function contextWindowOf(modelId: string | undefined, models: ModelCost[] | undefined): number {
	const reported = models?.find((entry) => entry.model === modelId)?.contextWindow;
	if (reported) return reported;
	return modelId && /\[1m\]/i.test(modelId) ? LONG_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

function cappedLabel(value: unknown): string {
	const text = String(value ?? "");
	return text.length > WORKFLOW_LABEL_CHARS ? text.slice(0, WORKFLOW_LABEL_CHARS) : text;
}

/** `workflow_progress` is not in the SDK's types, so every entry and field is checked before it is read. */
function workflowProgress(event: any): { phase?: string; agents: Array<{ label: string; state: string }>; done: number; total: number } {
	const entries = Array.isArray(event?.workflow_progress) ? event.workflow_progress : [];
	const agents: Array<{ label: string; state: string }> = [];
	let phase: string | undefined;
	let total = 0;
	let done = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "workflow_phase" && typeof entry.title === "string") phase = entry.title;
		else if (entry.type === "workflow_agent") {
			total++;
			if (entry.state === "done") done++;
			if (typeof entry.label === "string" && agents.length < MAX_WORKFLOW_AGENTS) agents.push({ label: cappedLabel(entry.label), state: cappedLabel(entry.state) });
		}
	}
	return { ...(phase === undefined ? {} : { phase }), agents, done, total };
}

function hasWorkflowProgress(event: any): boolean {
	return Array.isArray(event.workflow_progress) && event.workflow_progress.length > 0;
}

function workflowSummary(event: any): string | undefined {
	if (!hasWorkflowProgress(event)) return typeof event.description === "string" && event.description ? event.description : undefined;
	const { phase, done, total } = workflowProgress(event);
	return `workflow${phase ? ` ${phase}` : ""} · ${done}/${total} agents done`;
}

function taskKind(taskType: unknown): string {
	return typeof taskType === "string" ? taskType.replace(/^local_/, "") : "task";
}

function taskName(event: any, taskId: string): string {
	if (typeof event.workflow_name === "string") return event.workflow_name;
	if (typeof event.description === "string" && event.description) return event.description;
	return taskId;
}

function taskStatus(status: unknown): "completed" | "failed" | "stopped" {
	return status === "completed" || status === "failed" || status === "stopped" ? status : "failed";
}

/**
 * The child's stdin as a queue of user messages. A string prompt makes the SDK close stdin after the first
 * result, which for an ultracode run comes as soon as its workflow starts; a queue stays open for steers until
 * the run has no work left.
 */
export class ChildInput implements AsyncIterable<SDKUserMessage>, ChildControl {
	private readonly queue: SDKUserMessage[] = [];
	private wake?: () => void;
	private ended = false;
	private count = 0;

	get open(): boolean {
		return !this.ended;
	}

	/**
	 * How many messages this input has taken, the prompt included. Taken is not read: the run compares it with the count
	 * at its last result and idle state, so a message taken after either leaves that evidence stale.
	 */
	get taken(): number {
		return this.count;
	}

	/** Messages taken and not yet handed to the SDK. They still reach the child before EOF, which drains them first. */
	get pending(): number {
		return this.queue.length;
	}

	push(text: string): boolean {
		if (this.ended) return false;
		this.count++;
		this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
		this.wake?.();
		return true;
	}

	end(): void {
		this.ended = true;
		this.wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		for (;;) {
			const next = this.queue.shift();
			if (next) yield next;
			else if (this.ended) return;
			else await new Promise<void>((resolve) => (this.wake = resolve));
		}
	}
}

interface AskedQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

function askedQuestions(input: unknown): AskedQuestion[] {
	const questions = (input as { questions?: unknown })?.questions;
	if (!Array.isArray(questions)) return [];
	return questions.filter((entry): entry is AskedQuestion => typeof entry?.question === "string" && entry.question.trim() !== "");
}

/** AskUserQuestion's questions and options as the one question the host answers. */
export function questionText(questions: readonly AskedQuestion[]): string {
	const one = (entry: AskedQuestion, prefix: string) => {
		const lines = [`${prefix}${entry.header ? `[${entry.header}] ` : ""}${entry.question}`];
		for (const option of entry.options ?? []) lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
		if (entry.multiSelect) lines.push("(one or more, separated by commas)");
		return lines.join("\n");
	};
	if (questions.length === 1) return one(questions[0]!, "");
	return `${questions.map((entry, index) => one(entry, `${index + 1}. `)).join("\n\n")}\n\nAnswer each question on its own line, in order.`;
}

/** The answers map AskUserQuestion takes: one line per question when the lines match the questions, else the whole answer for each. */
export function questionAnswers(questions: readonly AskedQuestion[], answer: string): Record<string, string> {
	const lines = answer.split("\n").map((line) => line.trim()).filter(Boolean);
	const split = questions.length > 1 && lines.length === questions.length;
	return Object.fromEntries(questions.map((entry, index) => [entry.question, split ? lines[index]!.replace(/^\d+\.\s*/, "") : answer.trim()]));
}

/**
 * The ask_orchestrator tool and the AskUserQuestion hook, which both hold the child's tool call open until the host
 * answers. A PreToolUse hook and not canUseTool, because with permissionPrompts "none" the SDK never calls canUseTool.
 */
function questionOptions(ask: Ask, signal: AbortSignal): Pick<Options, "mcpServers" | "allowedTools" | "hooks"> {
	const server = createSdkMcpServer({
		name: QUESTION_SERVER,
		timeout: QUESTION_TIMEOUT_MS,
		alwaysLoad: true,
		tools: [
			tool(
				QUESTION_TOOL,
				"Ask the orchestrator that gave you this task for a decision you need to go on, such as a name or a choice between options inside the task's scope. The call waits until the orchestrator answers, which can take a long time; the answer is the result.",
				{ question: z.string().describe("The question, with the options you see and the one you recommend.") },
				async ({ question }) => ({ content: [{ type: "text" as const, text: await ask(question, signal) }] }),
			),
		],
	});
	const askUser: HookCallback = async (input) => {
		if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "AskUserQuestion") return {};
		const questions = askedQuestions(input.tool_input);
		if (!questions.length) return {};
		const answer = await ask(questionText(questions), signal);
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { ...(input.tool_input as Record<string, unknown>), answers: questionAnswers(questions, answer) },
			},
		};
	};
	return {
		mcpServers: { [QUESTION_SERVER]: server },
		allowedTools: [`mcp__${QUESTION_SERVER}__${QUESTION_TOOL}`],
		hooks: { PreToolUse: [{ matcher: "AskUserQuestion", timeout: HOOK_TIMEOUT_S, hooks: [askUser] }] },
	};
}

/**
 * The session this run is known to have used, with a checkpoint only where one is trusted: the message the child
 * ended on when the run succeeded, and for a fork that failed after the session existed, the message it forked at,
 * never the failed tip. The run's own scalar `sessionId` and `checkpoint` stay as they were, for the callers that
 * read them.
 */
function verifiedSession(run: ClaudeRun, session: ChildSession | undefined): SessionRef | undefined {
	if (!run.sessionId) return undefined;
	const ok = !failed(run);
	const checkpoint = (ok && run.checkpoint) || (session?.kind === "fork" ? session.at : undefined);
	return { backend: "claude", sessionId: run.sessionId, ...(checkpoint ? { checkpoint } : {}) };
}

export async function runChild(opts: RunRequest<Role, ChildSession, ChildInput>): Promise<ClaudeRun> {
	const { role } = opts;
	const run = newRun(role);
	const started = Date.now();
	const controller = new AbortController();
	const child = new ChildTree(opts.killGraceMs ?? KILL_GRACE_MS);
	const input = opts.input ?? new ChildInput();
	input.push(opts.prompt);
	const onAbort = () => {
		run.aborted = true;
		input.end();
		controller.abort();
		child.kill();
	};
	if (opts.signal?.aborted) onAbort();
	else opts.signal?.addEventListener("abort", onAbort, { once: true });

	const toolUseIds = new Set<string>();
	const agentToolUseIds = new Set<string>();
	const workflowTokens = new Map<string, number>();
	/** The background tasks that keep the child's input open: a pending task's notification starts another turn. */
	let pendingTasks = new Map<string, string>();
	/**
	 * Task ids a membership snapshot has listed, ambient ones included, or that left the membership or ended. Once a
	 * snapshot has been seen it governs: a start edge, whose order against the snapshots is unspecified, adds only an
	 * id none of them has ruled on, so a late one never brings back a task that has ended or been listed as ambient.
	 */
	const ruledTasks = new Set<string>();
	/** Whether the child reports its session state; once one valid state arrives, completion also needs idle. */
	let reportsState = false;
	/** The input count when the child last reported idle, or undefined while it is not known to be idle. */
	let idleAt: number | undefined;
	/** The input count at the last top-level result, or undefined while a top-level turn is known to be in progress. */
	let resultAt: number | undefined;
	let questionsOpen = 0;
	/**
	 * Closes the child's input once nothing could still start a turn this run waits for: no blocking task, no open
	 * question, nothing left in the local queue, a top-level result after the last message taken and after any later
	 * top-level activity, and, from a child that reports its session state, an idle state at least as new. EOF ends
	 * nothing the child already holds: Claude Code still drains queued input and pending task notifications before it
	 * exits, so a follow-up turn's result reaches this run. Nothing here waits on quiet time.
	 */
	const settle = () => {
		if (!input.open || pendingTasks.size || questionsOpen || input.pending) return;
		if (resultAt === undefined || resultAt !== input.taken) return;
		if (reportsState && idleAt !== input.taken) return;
		input.end();
	};
	/**
	 * The question callback, counted so that an open question keeps the input open: its answer travels back over that
	 * input. An answer is new work for the turn or agent that asked, so a result or idle state from before it, the main
	 * turn's own included, is stale; the answer itself closes nothing, and the result of the turn that reads it, or of
	 * the turn the asking task's notification starts, brings the evidence that does.
	 */
	const ask: Ask | undefined = opts.onQuestion
		? async (question, signal) => {
				questionsOpen++;
				try {
					return await opts.onQuestion!(question, signal);
				} finally {
					questionsOpen--;
					resultAt = undefined;
					idleAt = undefined;
				}
			}
		: undefined;
	const resultIds = new Set<string>();
	const streamed = new StreamedBlocks();
	const deltaProgress = throttled(DELTA_PROGRESS_MS, () => opts.onProgress(run));
	const emit = (event: ChildEvent) => {
		try {
			opts.onEvent?.(event);
		} catch {}
	};
	let blockersSent = "";
	/** Tells the monitor which tasks the run now waits for, whenever that changes; the set itself stays exact. */
	const publishBlockers = () => {
		const tasks = [...pendingTasks].slice(0, MAX_BLOCKERS).map(([id, label]) => ({ id, label: label.length > BLOCKER_LABEL_CHARS ? `${label.slice(0, BLOCKER_LABEL_CHARS)}…` : label }));
		const key = JSON.stringify([pendingTasks.size, tasks]);
		if (key === blockersSent) return;
		blockersSent = key;
		emit({ type: "blockers", tasks, total: pendingTasks.size });
	};
	let interims = 0;
	let interimResult: string | undefined;
	const onMessage = (event: any) => {
		if (event.parent_tool_use_id && event.type === "assistant") {
			const parts = Array.isArray(event.message?.content) ? event.message.content : [];
			for (const part of parts) {
				if (part?.type !== "tool_use") continue;
				if (typeof part.id === "string") {
					if (agentToolUseIds.has(part.id)) continue;
					agentToolUseIds.add(part.id);
				}
				emit({
					type: "agent_tool_call",
					parentToolUseId: String(event.parent_tool_use_id),
					name: String(part.name ?? "?"),
					...(typeof part.id === "string" ? { id: part.id, input: part.input } : {}),
				});
			}
		}
		if (event.type === "user" && Array.isArray(event.message?.content)) {
			for (const part of event.message.content) {
				if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string" || resultIds.has(part.tool_use_id)) continue;
				resultIds.add(part.tool_use_id);
				emit({ type: "tool_result", toolUseId: part.tool_use_id, text: resultText(part.content), isError: part.is_error === true });
			}
		}
		if (event.parent_tool_use_id) return;
		// Top-level model output is a turn in progress, so a result and an idle state seen before it are stale.
		// Subagent frames, returned above, and task events are not: they run beside an idle session.
		if (event.type === "assistant" || event.type === "stream_event" || event.type === "user") {
			resultAt = undefined;
			idleAt = undefined;
		}
		if (event.type === "system") {
			if (event.subtype === "init") {
				if (typeof event.session_id === "string") {
					run.sessionId = event.session_id;
					emit({ type: "init", sessionId: event.session_id });
				}
				if (typeof event.model === "string" && event.model) {
					run.modelId = event.model;
					run.contextWindow = contextWindowOf(run.modelId, run.models);
				}
				run.activity = "waiting for model";
				opts.onProgress(run);
			}
			if (event.subtype === "task_started") {
				if (event.task_id !== undefined && event.task_id !== null) {
					const taskId = String(event.task_id);
					// Ambient tasks, such as watchers, get no task_notification: Claude Code neither waits for nor sweeps them.
					if (event.ambient !== true && event.skip_transcript !== true && !ruledTasks.has(taskId)) pendingTasks.set(taskId, `${taskKind(event.task_type)} ${taskName(event, taskId)}`);
					emit({
						type: "task_started",
						taskId,
						...(typeof event.tool_use_id === "string" ? { toolUseId: event.tool_use_id } : {}),
						...(typeof event.task_type === "string" ? { taskType: event.task_type } : {}),
						name: taskName(event, taskId),
						...(typeof event.subagent_type === "string" ? { subagentType: event.subagent_type } : {}),
					});
					publishBlockers();
				}
				if (typeof event.workflow_name === "string") {
					run.activity = `Workflow ${event.workflow_name}`;
					opts.onProgress(run);
				}
			}
			if (event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
				// The full live membership, which replaces the set: an ambient entry, or one that turns back from ambient, is
				// the snapshot's to say. Shrinking it is no new work, so idle stays as it was.
				const live = new Map<string, string>();
				for (const task of event.tasks) {
					if (!task || typeof task.task_id !== "string") continue;
					ruledTasks.add(task.task_id);
					if (task.ambient !== true) live.set(task.task_id, `${taskKind(task.task_type)} ${taskName(task, task.task_id)}`);
				}
				for (const taskId of pendingTasks.keys()) ruledTasks.add(taskId);
				pendingTasks = live;
				publishBlockers();
				settle();
			}
			if (event.subtype === "session_state_changed" && (event.state === "idle" || event.state === "running" || event.state === "requires_action")) {
				reportsState = true;
				// Running or awaiting action is a turn in progress, so the last result is no longer the current turn's.
				if (event.state === "idle") idleAt = input.taken;
				else {
					idleAt = undefined;
					resultAt = undefined;
				}
				settle();
			}
			if ((event.subtype === "task_progress" || event.subtype === "task_notification") && event.task_id !== undefined) {
				const tokens = event.usage?.total_tokens;
				if (typeof tokens === "number") {
					workflowTokens.set(String(event.task_id), tokens);
					run.workflowTokens = [...workflowTokens.values()].reduce((sum, n) => sum + n, 0);
				}
				if (event.subtype === "task_progress") {
					const progress = hasWorkflowProgress(event) ? workflowProgress(event) : undefined;
					emit({
						type: "task_progress",
						taskId: String(event.task_id),
						...(typeof event.description === "string" && event.description ? { description: event.description } : {}),
						...(typeof event.summary === "string" ? { summary: event.summary } : {}),
						...(typeof event.last_tool_name === "string" ? { lastTool: event.last_tool_name } : {}),
						...(typeof tokens === "number" ? { tokens } : {}),
						...(typeof event.usage?.tool_uses === "number" ? { toolUses: event.usage.tool_uses } : {}),
						...(progress?.phase === undefined ? {} : { phase: progress.phase }),
						...(progress?.agents.length ? { agents: progress.agents } : {}),
					});
					const summary = workflowSummary(event);
					if (summary) run.activity = summary;
					opts.onProgress(run);
				} else {
					pendingTasks.delete(String(event.task_id));
					ruledTasks.add(String(event.task_id));
					emit({
						type: "task_ended",
						taskId: String(event.task_id),
						status: taskStatus(event.status),
						...(typeof event.summary === "string" && event.summary ? { summary: event.summary } : {}),
						...(typeof tokens === "number" ? { tokens } : {}),
					});
					publishBlockers();
					settle();
				}
			}
		} else if (event.type === "stream_event") {
			const streamEvent = event.event ?? {};
			if (streamEvent.type === "message_start") {
				streamed.reset();
				const context = promptTokens(streamEvent.message?.usage);
				if (context !== undefined) run.contextTokens = context;
			}
			else if (streamEvent.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
				run.activity = `calling ${String(streamEvent.content_block.name ?? "?")}`;
				opts.onProgress(run);
			} else if (streamEvent.type === "content_block_delta") {
				const delta = streamEvent.delta ?? {};
				if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
					run.activity = streamed.append("thinking", streamEvent.index, delta.thinking);
					deltaProgress.call();
				} else if (delta.type === "text_delta" && typeof delta.text === "string") {
					run.activity = streamed.append("writing", streamEvent.index, delta.text);
					deltaProgress.call();
				}
			}
		} else if (event.type === "user") {
			run.activity = "waiting for model";
			opts.onProgress(run);
		} else if (event.type === "assistant") {
			if (typeof event.uuid === "string") run.checkpoint = event.uuid;
			const context = promptTokens(event.message?.usage);
			if (context !== undefined) run.contextTokens = context;
			for (const part of event.message?.content ?? []) {
				if (part?.type !== "thinking" || typeof part.thinking !== "string" || !part.thinking.trim()) continue;
				const text = part.thinking.length > THINKING_CHARS ? `${part.thinking.slice(0, THINKING_CHARS)}…` : part.thinking;
				run.thinking = [...(run.thinking ?? []), text].slice(-THINKING_BLOCKS);
			}
			for (const part of event.message?.content ?? []) {
				if (part?.type !== "tool_use") continue;
				if (typeof part.id === "string") {
					if (toolUseIds.has(part.id)) continue;
					toolUseIds.add(part.id);
				}
				run.toolCalls++;
				const arg = briefArg(part.input);
				emit({ type: "tool_call", name: String(part.name ?? "?"), brief: arg, ...(typeof part.id === "string" ? { id: part.id, input: part.input } : {}) });
				run.activity = arg ? `${part.name} ${arg}` : String(part.name ?? "?");
				opts.onProgress(run);
			}
		} else if (event.type === "result") {
			if (typeof event.session_id === "string") run.sessionId = event.session_id;
			const usage = event.usage;
			if (usage) {
				run.tokensIn += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
				run.tokensOut += usage.output_tokens || 0;
				run.cacheRead += usage.cache_read_input_tokens || 0;
				run.cacheWrite += usage.cache_creation_input_tokens || 0;
			}
			if (typeof event.total_cost_usd === "number" && event.total_cost_usd > 0) run.costUsd = event.total_cost_usd;
			const models = modelCosts(event.modelUsage);
			if (models.length) {
				run.models = models;
				run.contextWindow = contextWindowOf(run.modelId, models);
			}
			if (typeof event.num_turns === "number") run.numTurns = (run.numTurns ?? 0) + event.num_turns;
			if (typeof event.duration_api_ms === "number") run.apiMs = (run.apiMs ?? 0) + event.duration_api_ms;
			const text = typeof event.result === "string" ? event.result : "";
			if (text.trim()) run.text = text;
			if (event.is_error) {
				// An error subtype carries its text in errors[]; a success subtype with is_error carries it in result.
				const errors = Array.isArray(event.errors) ? event.errors.filter((error: unknown) => typeof error === "string" && error.trim()) : [];
				run.stopReason = "error";
				run.errorMessage = text.trim() || errors.join("\n") || String(event.subtype ?? "error");
			} else {
				run.stopReason = "stop";
			}
			const message = run.errorMessage;
			emit({ type: "turn_result", ok: !event.is_error, ...(event.is_error && message !== undefined ? { message } : {}) });
			const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
			for (const denial of denials) run.deniedTools = [...(run.deniedTools ?? []), String(denial?.tool_name ?? "?")];
			resultAt = input.taken;
			settle();
			// A report the run keeps going after: the input is still open and a task it waits for still runs. Each
			// result is one report, so a result seen again under the same id is not a new revision.
			const identity = typeof event.uuid === "string" ? event.uuid : undefined;
			if (!event.is_error && text.trim() && input.open && pendingTasks.size && (identity === undefined || identity !== interimResult)) {
				interimResult = identity;
				emit({ type: "interim", revision: ++interims, text });
			}
			opts.onProgress(run);
		}
	};

	let sdkError: Error | undefined;
	try {
		const messages = query({
			prompt: input,
			options: {
				...childOptions(role, opts.session, opts.title ?? `pi-fusion ${role.name}`, opts.contract),
				...(ask ? questionOptions(ask, controller.signal) : {}),
				...claudeExecutable(),
				cwd: opts.cwd,
				env: {
					...process.env,
					CLAUDE_AGENT_SDK_CLIENT_APP: "pi-fusion",
					// Headless Claude Code kills background tasks still running 10 min after the turn ends. Only an abort stops the child.
					CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
					// Session state events are opt-in; their idle is what tells a finished turn from one still holding results back.
					CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
					...compactionEnv(opts.compactPct, process.env),
				},
				abortController: controller,
				spawnClaudeCodeProcess: (options) => child.spawn(options),
			},
		});
		for await (const message of messages) onMessage(message);
	} catch (error) {
		sdkError = error instanceof Error ? error : new Error(String(error));
	} finally {
		input.end();
		opts.signal?.removeEventListener("abort", onAbort);
		deltaProgress.cancel();
	}
	const exit = await child.exited();
	run.ms = Date.now() - started;
	/*
	 * Once the conversation has ended, an error result included, the SDK stops the child through the handle, and a
	 * child still running after that is stopped here. Neither stop is the child's outcome.
	 */
	const stopped = child.stoppedBy(exit) && !run.aborted;
	run.exitCode = stopped ? 0 : exit.code;
	run.signal = stopped ? null : exit.signal;
	run.stderr = child.stderr;
	if (child.spawnError) run.errorMessage ??= `failed to spawn ${child.command}: ${child.spawnError.message}`;
	// On abort and non-zero exit the SDK's error only restates what the run already records.
	else if (sdkError && !run.aborted && !run.exitCode) run.errorMessage ??= sdkError.message;
	if (run.aborted) run.stopReason = "aborted";
	else if (pendingTasks.size) run.abandonedTasks = [...pendingTasks.values()];
	run.session = verifiedSession(run, opts.session);
	return run;
}

/** The Claude Code backend: the harness every role has run in so far. */
export const claudeBackend: Backend<Role, ChildSession, ChildInput> = {
	name: "claude",
	control: () => new ChildInput(),
	session: claudeSession,
	run: runChild,
};
