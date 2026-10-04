import type { CodexRole } from "./codex-binding.ts";
import { type CodexDenial, type CodexThreadRead, type CodexThreadStart, sandboxModeOf } from "./codex-protocol.ts";
import type { CodexExit, CodexNotification, CodexTurnEvidence, CodexTurnResult } from "./codex-transport.ts";
import { type ChildEvent, type ChildRun, type ResolvedSelection, resolvedSelectionOf, type SessionIntent } from "./types.ts";

/**
 * What one Codex call reports, decided from evidence the composition in `codex.ts` gathered and from nothing else: the
 * session request an intent becomes, the checks a thread's start and its post-turn readback have to pass, the run
 * record an ending becomes, and the display feed a monitor watches. It is pure: no process, no file, no clock and no
 * transport instance — the transport's own types are all it takes from there.
 *
 * Evidence and display are kept apart on purpose. What decides a run is the admitted turn's scoped snapshot and end and
 * the thread's readbacks; the feed reads the transport's unfiltered notifications, filters them to the primary thread
 * and turn, and only ever moves counters, an activity line and monitor events. Nothing it reads becomes a run's report,
 * selection or final usage.
 */

/** A Codex child's run: the shared record over this backend's own role shape. */
export type CodexRun = ChildRun<CodexRole>;

/** The only session this build's Codex backend runs: a fresh thread. Continuing one is not qualified yet. */
export interface CodexSession {
	kind: "new";
}

/** Why a resume or a fork never reaches a Codex child in this build, said before anything is looked up or started. */
export const CODEX_FRESH_ONLY = "the codex backend runs fresh threads only in this build, so a codex run cannot be resumed or forked; start a new run without continue that carries the earlier report as context";

/** The session an intent becomes: a new thread, or a refusal made before any binary lookup, contract read or spawn. */
export function codexSession(intent: SessionIntent): CodexSession {
	if (intent.kind === "new") return { kind: "new" };
	throw new Error(CODEX_FRESH_ONLY);
}

/** The record a run starts from: everything at zero, nothing claimed and no thread named before one is verified. */
export function newCodexRun(role: CodexRole): CodexRun {
	return { role, text: "", toolCalls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, ms: 0, exitCode: null, signal: null, aborted: false, stderr: "" };
}

/* ------------------------------------------------------------------------------------------------------------------
 * Fixed sentences. Each names what failed, never a path; a model, provider, effort or sandbox tag the child reported is
 * an identity the protocol readers already bounded, so a mismatch may name it.
 * ---------------------------------------------------------------------------------------------------------------- */

export const RUN_CANCELLED = "the run was cancelled before its codex child was started";
export const RUN_ABORTED = "the run was cancelled";
/** A start seam that threw without the transport's report: a child may exist that this host was never handed. */
export const RUN_UNVERIFIED = "this host cannot say how the codex child's run ended";
export const HOME_MISMATCH = "the codex child reported a Codex home other than the one this host predicted for its environment, so no thread was started";
export const CWD_MISMATCH = "the codex child reported a working directory other than this run's, so no turn was started";
export const CWD_READ_MISMATCH = "the codex thread read back a working directory other than this run's after its turn";
export const NO_FINAL = "the codex turn completed without a final agent message for this turn";
export const NO_USAGE = "the codex turn completed without reporting its usage before its thread was read back";
export const NOT_IDLE = "the codex thread did not read back as idle after its turn";
export const TERMINAL_ERROR = "the codex turn reported a terminal error and still claimed to complete";
export const CLEANUP_UNCERTAIN = "the turn finished and the codex child's own shutdown did not end cleanly";
export const CLEANUP_ATTENTION = "cleaning up needs attention";
const CLEANUP_LEFT = "the cleanup after it left";

/** Where a failed call stopped. `startup` is the spawn and the handshake, `thread` the thread's start and its checks. */
export type CodexStage = "startup" | "thread" | "turn" | "verify" | "cleanup";

/* ------------------------------------------------------------------------------------------------------------------
 * Checks
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * What a thread/start answer has to say before any turn runs on it, or the one sentence saying what it did not. `cwd`
 * and `expectedCwd` are compared canonical: the caller resolves both the same way, so a symlinked spelling of the same
 * directory is the same directory and nothing else is. The approval policy must be confirmed as exactly the role's
 * word: an answer that reports none, reports null, or reports a granular policy object — which the reader leaves unread
 * and so reports as none — is refused like any other mismatch, because an unconfirmed policy is not `never`.
 */
export function threadStartProblem(role: CodexRole, start: CodexThreadStart, cwd: string, expectedCwd: string): string | undefined {
	if (cwd !== expectedCwd) return CWD_MISMATCH;
	const mode = sandboxModeOf(start.sandbox);
	if (mode !== role.sandboxMode) return `the codex child started its thread in a ${start.sandbox.type} sandbox, not the ${role.sandboxMode} sandbox role ${role.name} runs in, so no turn was started`;
	if (start.approvalPolicy === undefined) return `the codex child did not confirm approval policy ${role.approvalPolicy} for its thread, so no turn was started`;
	if (start.approvalPolicy !== role.approvalPolicy) return `the codex child started its thread with approval policy ${start.approvalPolicy}, not ${role.approvalPolicy}, so no turn was started`;
	if (role.model !== undefined && start.model !== role.model) return `the codex child started its thread on model ${start.model}, not the model ${role.model} this call named, so no turn was started`;
	if (role.provider !== undefined && start.modelProvider !== role.provider) return `the codex child started its thread on provider ${start.modelProvider}, not the provider ${role.provider} this call named, so no turn was started`;
	if (resolvedSelectionOf({ model: start.model, provider: start.modelProvider }, "codex") === undefined) return "the codex child started its thread on a model or provider that is not one codex token";
	return undefined;
}

/** A selection read back after the turn, with every note it owes a reader, or the sentence saying why there is none. */
export type CodexVerified = { ok: true; selection: ResolvedSelection; notes: string[] } | { ok: false; message: string };

/** How many reroutes a note quotes before it only counts the rest. */
const REROUTES_QUOTED = 3;

/**
 * The configured selection a fresh thread ran with, settled after its turn from the thread/start answer and the
 * post-turn thread/read, and never from a reroute: `model/rerouted` is per-turn telemetry, so an explicit-model run that
 * was rerouted fails, and a host-default one is accepted with a note quoting the reroute while its selection stays the
 * configured one. A model the readback leaves null keeps the start answer's with a note; one it names must equal it.
 * A named effort must read back exactly; an unnamed one is the readback's, then the start's, then none, each fallback
 * noted. The provider must read back as the one the thread started on.
 */
export function verifySelection(role: CodexRole, start: CodexThreadStart, read: CodexThreadRead, evidence: CodexTurnEvidence): CodexVerified {
	const notes: string[] = [];
	if (read.status.type !== "idle") return { ok: false, message: NOT_IDLE };
	if (read.modelProvider !== start.modelProvider) return { ok: false, message: `the codex thread read back provider ${read.modelProvider} after its turn, not the provider ${start.modelProvider} it started on` };
	let model = start.model;
	if (read.model === null) notes.push(`Note: the codex thread read back no model after its turn, so the model its start reported, ${start.model}, is what this run records.`);
	else if (read.model !== start.model) return { ok: false, message: `the codex thread read back model ${read.model} after its turn, not the model ${start.model} it started on` };
	else model = read.model;
	let effort: string | undefined;
	if (role.effort !== undefined) {
		if (read.reasoningEffort === null) return { ok: false, message: `the codex thread read back no effort after a turn this call ran at effort ${role.effort}, so the effort it ran at is unverified` };
		if (read.reasoningEffort !== role.effort) return { ok: false, message: `the codex thread read back effort ${read.reasoningEffort} after its turn, not the effort ${role.effort} this call named` };
		effort = role.effort;
	} else if (read.reasoningEffort !== null) effort = read.reasoningEffort;
	else if (start.reasoningEffort !== null) {
		effort = start.reasoningEffort;
		notes.push(`Note: the codex thread read back no effort after its turn, so the effort its start reported, ${effort}, is what this run records.`);
	} else notes.push("Note: the codex child reported no effort for this thread, so this run records none and its effort was whatever the host's Codex configuration chose.");
	if (evidence.rerouteCount > 0) {
		const quoted = evidence.reroutes.slice(0, REROUTES_QUOTED).map((reroute) => `from ${reroute.fromModel} to ${reroute.toModel} (${reroute.reason})`);
		const more = evidence.rerouteCount - quoted.length;
		const said = `${quoted.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
		if (role.model !== undefined) return { ok: false, message: `Codex rerouted this turn ${said}, so it did not run on the model ${role.model} this call named` };
		notes.push(`Note: Codex rerouted this turn ${said}; the selection recorded is the configured ${model}, not a model the turn was rerouted to.`);
	}
	if (evidence.usage !== undefined && evidence.usage.modelContextWindow === null) notes.push("Note: the codex child reported no context window, so this run shows no share of one.");
	const selection = resolvedSelectionOf({ model, provider: start.modelProvider, ...(effort === undefined ? {} : { effort }) }, "codex");
	if (selection === undefined) return { ok: false, message: "the codex thread read back a selection that is not one this host can record" };
	return { ok: true, selection, notes };
}

/** The sentence an admitted turn that did not complete ends with, and whether it was a cancellation. */
export function turnFailure(result: CodexTurnResult, cancelled: boolean): { message: string; aborted: boolean } {
	if (result.outcome === "aborted" || result.failure?.kind === "aborted") return { message: RUN_ABORTED, aborted: true };
	if (result.outcome === "interrupted" && cancelled) return { message: RUN_ABORTED, aborted: true };
	const error = result.completion?.error ?? result.terminalError;
	const said = error === undefined || error === null ? "" : `: ${error.message}${error.cut ? "…" : ""}${error.info === undefined ? "" : ` (${error.info})`}`;
	switch (result.outcome) {
		case "failed":
			return { message: `the codex turn failed${said}`, aborted: false };
		case "interrupted":
			return { message: `the codex turn was interrupted before it finished${said}`, aborted: false };
		case "exited":
			return { message: result.failure?.message ?? "the codex child exited before its turn was done", aborted: false };
		default:
			return { message: result.failure?.message ?? "the codex turn failed", aborted: cancelled };
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * The ending
 * ---------------------------------------------------------------------------------------------------------------- */

/** What the cleanup after a child left for a person to look at. The labels are this module's own and carry no detail. */
export type CodexConcern = "root-unstoppable" | "stdio-held" | "discovery-unavailable" | "leftovers" | "skipped" | "deadline-hit" | "streams-unclosed" | "unverified";

/** Every concern one exit report and one missing report raise, in the one order they are always read in. */
export function exitConcerns(exit: CodexExit | undefined, unverified: boolean): CodexConcern[] {
	const found: CodexConcern[] = [];
	if (exit !== undefined) {
		const cleanup = exit.cleanup;
		if (cleanup.root === "unstoppable") found.push("root-unstoppable");
		if (cleanup.stdio === "held") found.push("stdio-held");
		if (cleanup.discovery === "unavailable") found.push("discovery-unavailable");
		if (cleanup.leftovers.length > 0) found.push("leftovers");
		if (cleanup.skipped.length > 0) found.push("skipped");
		if (cleanup.deadlineHit) found.push("deadline-hit");
		if (exit.counters.streamsUnclosed !== 0) found.push("streams-unclosed");
	}
	if (unverified) found.push("unverified");
	return found;
}

/** What the composition settled before the child's one shutdown: a verified success, or one sentence of failure. */
export type CodexVerdict = { ok: true; text: string; cut: boolean; selection: ResolvedSelection; notes: string[] } | { ok: false; stage: CodexStage; message: string; aborted: boolean };

/**
 * How one call ended. `none` is a call cancelled before anything was read or launched. Otherwise `thread` is the id of a
 * thread whose start passed its checks, `evidence` the primary turn's last snapshot, `exit` the report of the one
 * shutdown, and `unverified` a shutdown or start seam that threw instead of reporting.
 */
export type CodexEnding = { kind: "none" } | { kind: "ended"; verdict: CodexVerdict; thread?: string; evidence?: CodexTurnEvidence; exit?: CodexExit; unverified: boolean };

/**
 * The parent thread's own usage, which is all a fresh thread's cumulative total covers: input already counts its cached
 * part, so the cache read is shown beside it and never added. The cache write is reported as Codex reported it, and the
 * input is Codex's own `inputTokens` unchanged: whether cache-write tokens are a subset of the input is not settled by
 * the source this reads and stays a native qualification question (Q14), so nothing here sums, subtracts or clamps
 * them, and no lifecycle or context-cap decision may lean on that relationship until Q14 is measured. The context is
 * the latest model response's input against the window when the child named one. No cost: Codex reports none, and
 * none is estimated here.
 */
function publishUsage(run: CodexRun, usage: NonNullable<CodexTurnEvidence["usage"]>): void {
	run.tokensIn = usage.total.inputTokens;
	run.tokensOut = usage.total.outputTokens;
	run.cacheRead = usage.total.cachedInputTokens;
	run.cacheWrite = usage.total.cacheWriteInputTokens;
	run.contextTokens = usage.last.inputTokens;
	if (usage.modelContextWindow === null) delete run.contextWindow;
	else run.contextWindow = usage.modelContextWindow;
	delete run.costUsd;
	delete run.models;
}

/** A denial as a run lists it: what kind of approval, and the command it was for when it named one. */
const deniedTool = (denial: CodexDenial): string => (denial.command === undefined ? `${denial.kind} approval declined` : `command approval declined: ${denial.command.text}${denial.command.cut ? "…" : ""}`);

/**
 * The record one ended call hands to the run lifecycle, mutated in place and handed back, and the one composer of its
 * `cleanupNotice`. A success stays one only while its child's one shutdown was clean — no failure on the exit, an
 * actual clean exit, nothing left behind — and is otherwise demoted, keeping the thread and the verified selection
 * because both are true of the work that was done. No checkpoint is ever published: a fresh Codex thread in this build
 * settles on none, so its record is kept for reading and a follow-up is a new run.
 */
export function finishCodexRun(run: CodexRun, ending: CodexEnding, ms: number): CodexRun {
	run.ms = ms;
	run.stderr = "";
	delete run.checkpoint;
	if (ending.kind === "none") {
		run.aborted = true;
		run.stopReason = "aborted";
		run.errorMessage = RUN_CANCELLED;
		delete run.cleanupNotice;
		return run;
	}
	const { verdict, exit, unverified, evidence } = ending;
	const concerns = exitConcerns(exit, unverified);
	const cleanStop = exit !== undefined && exit.stopRequested && exit.cleanExit;
	run.exitCode = exit === undefined ? null : cleanStop ? 0 : exit.exit.code;
	run.signal = exit === undefined || cleanStop ? null : exit.exit.signal;
	if (ending.thread !== undefined) {
		run.session = { backend: "codex", sessionId: ending.thread };
		// A diagnostic only: the host records a Codex run by its reference and never by this scalar.
		run.sessionId = ending.thread;
	}
	if (evidence?.usage !== undefined) publishUsage(run, evidence.usage);
	if (evidence !== undefined && evidence.denialCount > 0) run.deniedTools = evidence.denials.map(deniedTool);

	let stopReason: string;
	let message: string | undefined;
	if (verdict.ok) {
		run.selection = { ...verdict.selection };
		run.modelId = verdict.selection.model;
		run.text = [verdict.text + (verdict.cut ? "…" : ""), ...verdict.notes].join("\n\n");
		if (exit?.failure?.kind === "aborted") {
			stopReason = "aborted";
			message = RUN_ABORTED;
		} else if (exit === undefined || exit.failure !== undefined || !exit.cleanExit || concerns.length > 0) {
			stopReason = "cleanup";
			const why = exit?.failure === undefined ? "" : `: ${exit.failure.message}`;
			message = `${CLEANUP_UNCERTAIN}${why}${concerns.length === 0 ? "" : ` (${CLEANUP_LEFT}: ${concerns.join(", ")})`}`;
		} else stopReason = "stop";
	} else {
		stopReason = verdict.aborted ? "aborted" : verdict.stage;
		message = concerns.length === 0 ? verdict.message : `${verdict.message} (${CLEANUP_LEFT}: ${concerns.join(", ")})`;
		// The primary turn's own last message, marked when cut, and never another thread's or turn's.
		const last = evidence?.finalMessage;
		run.text = last === undefined ? "" : `${last.text}${last.cut ? "…" : ""}`;
	}
	run.aborted = stopReason === "aborted";
	run.stopReason = stopReason;
	if (message === undefined) delete run.errorMessage;
	else run.errorMessage = message;
	if (concerns.length > 0) run.cleanupNotice = `${CLEANUP_ATTENTION}: ${concerns.join(", ")}`;
	else delete run.cleanupNotice;
	if (run.aborted && run.cleanupNotice !== undefined) run.activity = run.cleanupNotice;
	return run;
}

/* ------------------------------------------------------------------------------------------------------------------
 * The display feed
 * ---------------------------------------------------------------------------------------------------------------- */

/** How much of a child's latest line of work its activity shows, the window the other backends use. */
export const CODEX_ACTIVITY_CHARS = 60;
/** How much of a tool's output one event carries, and how long one rendered argument may be. */
export const CODEX_EVENT_TEXT_MAX_CHARS = 4_096;
export const CODEX_EVENT_FIELD_MAX_CHARS = 1_024;
/** How long a tool name or an id a monitor files events under may be. */
export const CODEX_EVENT_KEY_MAX_CHARS = 128;
/** Notifications of the primary thread held until its turn is named: past this, they are dropped from the display. */
export const CODEX_FEED_EARLY_MAX = 128;
/** How many thinking summaries a run keeps, newest last. */
const THINKING_KEPT = 3;

type Fields = { [key: string]: unknown };
const record = (value: unknown): Fields | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** The first `max` code points, with the cut saying for itself that it happened. */
function capped(value: string, max: number): string {
	const chars = [...value];
	return chars.length <= max ? value : `${chars.slice(0, max).join("")}…`;
}

const firstLine = (value: string | undefined): string => capped((value ?? "").split("\n")[0] ?? "", CODEX_ACTIVITY_CHARS);
const key = (value: unknown): string | undefined => {
	const named = text(value);
	return named ? capped(named, CODEX_EVENT_KEY_MAX_CHARS) : undefined;
};

/** A tool item as a monitor shows one: a name, a one-line brief and a bounded input. Other items are not tools. */
function toolOf(item: Fields): { name: string; brief: string; input?: Record<string, string> } | undefined {
	switch (item.type) {
		case "commandExecution": {
			const command = text(item.command);
			return { name: "command", brief: firstLine(command), ...(command === undefined ? {} : { input: { command: capped(command, CODEX_EVENT_FIELD_MAX_CHARS) } }) };
		}
		case "fileChange": {
			const changes = Array.isArray(item.changes) ? item.changes : [];
			const first = text(record(changes[0])?.path);
			return { name: "edit", brief: firstLine(first), input: { files: String(changes.length) } };
		}
		case "mcpToolCall":
			return { name: capped(`${text(item.server) ?? "?"}/${text(item.tool) ?? "?"}`, CODEX_EVENT_KEY_MAX_CHARS), brief: "" };
		case "webSearch":
			return { name: "web search", brief: firstLine(text(item.query)) };
		case "collabAgentToolCall":
			return { name: "agent", brief: firstLine(text(item.tool)) };
		default:
			return undefined;
	}
}

/** The two callbacks the feed writes into, kept apart so a run's own progress and a monitor's events stay apart. */
export interface CodexFeedEmit {
	progress(): void;
	event(event: ChildEvent): void;
}

/** One run's display, opened on its primary thread, narrowed to its primary turn, and closed for good. */
export interface CodexFeed {
	onNotification(notification: CodexNotification): void;
	/** The verified primary thread: before this, nothing is shown. */
	thread(threadId: string): void;
	/** The admitted primary turn: what was held for it is shown, and only it from here on. */
	turn(turnId: string): void;
	end(): void;
}

/**
 * The transport's unfiltered notifications as live progress and monitor events, filtered to the primary thread and
 * turn: a subagent's thread, another turn of the same thread and anything before the thread was verified are dropped.
 * Between the thread and the turn's admission, the primary thread's notifications are held, bounded, and the ones for
 * the turn that was then admitted replayed. It holds no text past what one event carries, never throws back into the
 * transport, and decides nothing: a run's report, selection and final usage come from the turn's own evidence.
 */
export function codexFeed(run: CodexRun, emit: CodexFeedEmit): CodexFeed {
	let threadId: string | undefined;
	let turnId: string | undefined;
	let closed = false;
	const held: { turn: string; apply: () => void }[] = [];

	const progress = (): void => {
		try {
			emit.progress();
		} catch {}
	};
	const event = (child: ChildEvent): void => {
		try {
			emit.event(child);
		} catch {}
	};

	/**
	 * One notification digested into what showing it does, with every value it shows already cut to its bound, so a
	 * held one keeps a few short strings and numbers rather than the params a child sent. Nothing for one not shown.
	 */
	const digest = (method: string, data: Fields): (() => void) | undefined => {
		switch (method) {
			case "turn/started":
				return () => {
					run.activity = "waiting for model";
					progress();
				};
			case "item/started": {
				const item = record(data.item);
				if (!item) return undefined;
				if (item.type === "reasoning" || item.type === "agentMessage") {
					const activity = item.type === "reasoning" ? "thinking" : "writing";
					return () => {
						run.activity = activity;
						progress();
					};
				}
				const tool = toolOf(item);
				if (!tool) return undefined;
				const id = key(item.id);
				return () => {
					run.toolCalls += 1;
					event({ type: "tool_call", name: tool.name, brief: tool.brief, ...(id === undefined ? {} : { id }), ...(tool.input === undefined ? {} : { input: tool.input }) });
					run.activity = tool.brief ? `${tool.name} ${tool.brief}` : tool.name;
					progress();
				};
			}
			case "item/completed": {
				const item = record(data.item);
				if (!item) return undefined;
				if (item.type === "reasoning") {
					const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === "string" && part.trim() !== "").join("\n") : "";
					const kept = summary ? capped(summary, CODEX_EVENT_FIELD_MAX_CHARS) : undefined;
					return () => {
						if (kept !== undefined) run.thinking = [...(run.thinking ?? []), kept].slice(-THINKING_KEPT);
						progress();
					};
				}
				if (!toolOf(item)) return undefined;
				const id = key(item.id);
				const status = text(item.status);
				const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
				const output = capped(text(item.aggregatedOutput) ?? "", CODEX_EVENT_TEXT_MAX_CHARS);
				const isError = status === "failed" || status === "declined" || (exitCode !== undefined && exitCode !== 0);
				return () => {
					if (id !== undefined) event({ type: "tool_result", toolUseId: id, text: output, isError });
					run.activity = "waiting for model";
					progress();
				};
			}
			case "thread/tokenUsage/updated": {
				const usage = record(data.tokenUsage);
				const total = record(usage?.total);
				const input = count(total?.inputTokens);
				const output = count(total?.outputTokens);
				const cached = count(total?.cachedInputTokens);
				if (input === undefined || output === undefined || cached === undefined) return undefined;
				const written = count(total?.cacheWriteInputTokens) ?? 0;
				const context = count(record(usage?.last)?.inputTokens);
				const window = count(usage?.modelContextWindow);
				return () => {
					run.tokensIn = input;
					run.tokensOut = output;
					run.cacheRead = cached;
					run.cacheWrite = written;
					if (context !== undefined) run.contextTokens = context;
					if (window !== undefined) run.contextWindow = window;
					progress();
				};
			}
			case "error":
				if (data.willRetry !== true) return undefined;
				return () => {
					run.activity = "retrying";
					progress();
				};
			default:
				return undefined;
		}
	};

	return {
		thread(id: string): void {
			if (!closed && threadId === undefined) threadId = id;
		},
		turn(id: string): void {
			if (closed || threadId === undefined || turnId !== undefined) return;
			turnId = id;
			for (const one of held.splice(0, held.length)) {
				if (one.turn !== id) continue;
				try {
					one.apply();
				} catch {}
			}
		},
		end(): void {
			closed = true;
			held.length = 0;
		},
		onNotification(notification: CodexNotification): void {
			if (closed || threadId === undefined) return;
			try {
				const data = record(notification.params);
				if (!data || data.threadId !== threadId) return;
				const turn = text(data.turnId) ?? text(record(data.turn)?.id);
				if (turn === undefined || (turnId !== undefined && turn !== turnId)) return;
				const apply = digest(notification.method, data);
				if (apply === undefined) return;
				if (turnId === undefined) {
					if (held.length < CODEX_FEED_EARLY_MAX) held.push({ turn, apply });
					return;
				}
				apply();
			} catch {
				// A shape nothing expected is a record not shown, never a run ended through the transport.
			}
		},
	};
}
