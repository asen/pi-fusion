import * as path from "node:path";

/**
 * The Codex app-server's wire shapes, as the strict minimum this host reads of each, and nothing that runs: no
 * process, no stream, no clock and no Codex package. Every reader takes a value that already parsed as json and
 * answers with what it read or with one fixed reason it could not, so a test of them needs no child at all.
 *
 * Provenance, kept apart on purpose: each shape below was read in Codex 0.160.0's app-server protocol source (its v2
 * types and the generated schema of that version), and none of it is measured against a running app-server. A later
 * version may move any of it. A field that Codex marks experimental is not read here, and an extra field a shape
 * carries is tolerated and ignored rather than refused, because ignoring it promotes nothing to evidence.
 *
 * Fail closed is the rule for what decides a run — a thread's identity and selection, a turn's start and end, its usage
 * and the errors and reroutes it reports: a malformed one is a reason, never a partial value or a default. Tool items
 * are not that. They are display and diagnostics, and a malformed one is counted by the caller and never evidence.
 */

/** Where the shapes in this module come from: a source reading of one version, not a runtime qualification. */
export const CODEX_PROTOCOL_PROVENANCE = Object.freeze({ version: "0.160.0", evidence: "source inspection", runtime: "unqualified" } as const);

/** One read: the value, or the one fixed phrase saying what it lacked. A reason never echoes what arrived. */
export type CodexRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** How long an identity a child names may be: a thread or turn id, a model, a provider, an effort or a status tag. */
export const CODEX_ID_MAX_CHARS = 256;
/** How long a path a child reports may be, in utf-16 code units. */
export const CODEX_PATH_MAX_CHARS = 4096;

type Fields = { [key: string]: unknown };

const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const ok = <T>(value: T): CodexRead<T> => ({ ok: true, value });
const no = <T>(reason: string): CodexRead<T> => ({ ok: false, reason });

/** A non-empty identity of bounded length with no whitespace or control character in it, or nothing. */
const ident = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value === "" || value.length > CODEX_ID_MAX_CHARS) return undefined;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return undefined;
	}
	return value;
};

/** An absolute path of bounded length. POSIX only, like the launch it is compared against. */
const absolute = (value: unknown): string | undefined => (typeof value === "string" && value.length <= CODEX_PATH_MAX_CHARS && path.isAbsolute(value) ? value : undefined);

/** An identity that may be null or left out, which both mean the same thing here: the child reports none. */
const nullableIdent = (value: unknown): { value: string | null } | undefined => {
	if (value === undefined || value === null) return { value: null };
	const named = ident(value);
	return named === undefined ? undefined : { value: named };
};

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** A text cut to a byte cap on a character boundary, saying whether it was cut. Never a half character. */
export function boundText(text: string, maxBytes: number): { text: string; cut: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return { text, cut: false };
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return { text: buffer.subarray(0, end).toString("utf8"), cut: true };
}

/* ------------------------------------------------------------------------------------------------------------------
 * initialize
 * ---------------------------------------------------------------------------------------------------------------- */

/** What the handshake answered: the home the child uses, and the platform it says it is. */
export interface CodexInitialize {
	codexHome: string;
	platformFamily: string;
	platformOs: string;
	userAgent: string;
}

export function readInitialize(result: unknown): CodexRead<CodexInitialize> {
	if (!isRecord(result)) return no("its initialize answer is not an object");
	const codexHome = absolute(result.codexHome);
	if (codexHome === undefined) return no("its initialize answer names no absolute codex home");
	const platformFamily = ident(result.platformFamily);
	const platformOs = ident(result.platformOs);
	if (platformFamily === undefined || platformOs === undefined) return no("its initialize answer names no platform");
	if (typeof result.userAgent !== "string" || result.userAgent === "" || result.userAgent.length > CODEX_PATH_MAX_CHARS) return no("its initialize answer names no user agent");
	return ok({ codexHome, platformFamily, platformOs, userAgent: result.userAgent });
}

/* ------------------------------------------------------------------------------------------------------------------
 * thread/start and thread/read
 * ---------------------------------------------------------------------------------------------------------------- */

/** The sandbox a thread/start request names: Codex's own mode words, which are not the tags its answer uses. */
export type CodexSandboxRequest = "read-only" | "workspace-write";

/**
 * The sandbox a thread/start answer reports: a tagged policy (`readOnly`, `workspaceWrite`, `dangerFullAccess` or
 * `externalSandbox`), read for its tag alone. Whatever else the policy says is the user's Codex configuration, which
 * this host trusts and leaves unread. `type` is any identity the child wrote, so an answer reporting a sandbox this
 * host never asks for is read as exactly that and compared later, never mapped onto one it did ask for.
 */
export interface CodexSandboxPolicy {
	type: string;
}

/** The request mode a reported policy tag corresponds to, or nothing for a tag no request of this host's names. */
export function sandboxModeOf(policy: CodexSandboxPolicy): CodexSandboxRequest | undefined {
	if (policy.type === "readOnly") return "read-only";
	if (policy.type === "workspaceWrite") return "workspace-write";
	return undefined;
}

const readSandbox = (value: unknown): CodexSandboxPolicy | undefined => {
	if (!isRecord(value)) return undefined;
	const type = ident(value.type);
	return type === undefined ? undefined : { type };
};

/**
 * What a thread/start answered, read for the thread it opened and the selection it opened it with. The effort is
 * nullable: thread/start takes none, so a thread started at the host's default reports whatever its configuration
 * says, or null. None of this is a turn's execution: a model a turn is rerouted to is the turn's, not the thread's.
 */
export interface CodexThreadStart {
	threadId: string;
	model: string;
	modelProvider: string;
	cwd: string;
	sandbox: CodexSandboxPolicy;
	reasoningEffort: string | null;
	/** The approval policy when the child reported it as one of its words; a granular policy object is left unread. */
	approvalPolicy?: string;
}

export function readThreadStart(result: unknown): CodexRead<CodexThreadStart> {
	return readThreadOpened(result, "thread/start");
}

/**
 * The core every answer that opens a thread shares — thread/start, thread/resume and thread/fork — read the same way
 * and refused the same way, each reason naming the method that answered.
 */
function readThreadOpened(result: unknown, method: string): CodexRead<CodexThreadStart> {
	if (!isRecord(result)) return no(`its ${method} answer is not an object`);
	if (!isRecord(result.thread)) return no(`its ${method} answer carries no thread`);
	const threadId = ident(result.thread.id);
	if (threadId === undefined) return no(`its ${method} answer names no thread id`);
	const model = ident(result.model);
	if (model === undefined) return no(`its ${method} answer names no model`);
	const modelProvider = ident(result.modelProvider);
	if (modelProvider === undefined) return no(`its ${method} answer names no model provider`);
	const cwd = absolute(result.cwd);
	if (cwd === undefined) return no(`its ${method} answer names no absolute working directory`);
	const sandbox = readSandbox(result.sandbox);
	if (sandbox === undefined) return no(`its ${method} answer reports no tagged sandbox policy`);
	const effort = nullableIdent(result.reasoningEffort);
	if (effort === undefined) return no(`its ${method} answer reports an effort that is not one`);
	const approval = ident(result.approvalPolicy);
	return ok({ threadId, model, modelProvider, cwd, sandbox, reasoningEffort: effort.value, ...(approval === undefined ? {} : { approvalPolicy: approval }) });
}

/**
 * What a thread/resume or thread/fork answered: the same core as thread/start — 0.160.0's resume and fork responses
 * carry the start response's fields, none of them experimental (source inspection only) — and the thread's
 * `forkedFromId` when it named one. Null and absent both mean it named none and are left out. That id is metadata
 * reported as it arrived: whether a fork's answer names the source it was asked for is the backend's postcondition.
 */
export interface CodexThreadResume extends CodexThreadStart {
	forkedFromId?: string;
}

export function readThreadResume(result: unknown, method: "thread/resume" | "thread/fork" = "thread/resume"): CodexRead<CodexThreadResume> {
	const core = readThreadOpened(result, method);
	if (!core.ok) return core;
	const forked = nullableIdent((result as { thread: Fields }).thread.forkedFromId);
	if (forked === undefined) return no(`its ${method} answer reports a forked-from id that is not one`);
	return ok(forked.value === null ? core.value : { ...core.value, forkedFromId: forked.value });
}

/** A thread's runtime status, by its tag. `activeFlags` is present for an active thread and nowhere else. */
export interface CodexThreadStatus {
	type: "idle" | "active" | "systemError" | "notLoaded";
	activeFlags?: string[];
}

const STATUS_TYPES: readonly string[] = ["idle", "active", "systemError", "notLoaded"];

/**
 * One status, or nothing. A tag this version does not have is refused rather than read as "not idle", because a status
 * is lifecycle evidence and a later version's new tag is not something this host can say anything true about.
 */
const readStatus = (value: unknown): CodexThreadStatus | undefined => {
	if (!isRecord(value) || typeof value.type !== "string" || !STATUS_TYPES.includes(value.type)) return undefined;
	const type = value.type as CodexThreadStatus["type"];
	if (type !== "active") return { type };
	if (!Array.isArray(value.activeFlags)) return undefined;
	const flags = value.activeFlags.map(ident);
	if (flags.some((flag) => flag === undefined)) return undefined;
	return { type, activeFlags: flags as string[] };
};

/**
 * What a thread/read answered. Model and effort are the thread's configured values — null when it has none to report
 * — and never per-turn execution telemetry; the context window is not here, it travels with usage.
 */
export interface CodexThreadRead {
	threadId: string;
	model: string | null;
	modelProvider: string;
	reasoningEffort: string | null;
	cwd: string;
	status: CodexThreadStatus;
}

export function readThreadRead(result: unknown): CodexRead<CodexThreadRead> {
	if (!isRecord(result) || !isRecord(result.thread)) return no("its thread/read answer carries no thread");
	const thread = result.thread;
	const threadId = ident(thread.id);
	if (threadId === undefined) return no("its thread/read answer names no thread id");
	const model = nullableIdent(thread.model);
	if (model === undefined) return no("its thread/read answer reports a model that is not one");
	const modelProvider = ident(thread.modelProvider);
	if (modelProvider === undefined) return no("its thread/read answer names no model provider");
	const effort = nullableIdent(thread.reasoningEffort);
	if (effort === undefined) return no("its thread/read answer reports an effort that is not one");
	const cwd = absolute(thread.cwd);
	if (cwd === undefined) return no("its thread/read answer names no absolute working directory");
	const status = readStatus(thread.status);
	if (status === undefined) return no("its thread/read answer reports no status this version has");
	return ok({ threadId, model: model.value, modelProvider, reasoningEffort: effort.value, cwd, status });
}

/** A thread/status/changed notification. */
export function readThreadStatusChanged(params: unknown): CodexRead<{ threadId: string; status: CodexThreadStatus }> {
	if (!isRecord(params)) return no("a thread status change carries no params");
	const threadId = ident(params.threadId);
	const status = readStatus(params.status);
	if (threadId === undefined || status === undefined) return no("a thread status change names no thread or no status this version has");
	return ok({ threadId, status });
}

/* ------------------------------------------------------------------------------------------------------------------
 * turns
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * What a turn/start answered: the id of the turn it admitted, and nothing about how that turn goes. The answer is a
 * synthetic acknowledgement, and its status is whatever the turn was at that moment; only turn/completed ends a turn.
 */
export function readTurnStart(result: unknown): CodexRead<{ turnId: string }> {
	if (!isRecord(result) || !isRecord(result.turn)) return no("its turn/start answer carries no turn");
	const turnId = ident(result.turn.id);
	if (turnId === undefined) return no("its turn/start answer names no turn id");
	return ok({ turnId });
}

/** The statuses a listed turn may carry in 0.160.0: the three ends, and `inProgress`. */
export type CodexListedTurnStatus = CodexTurnStatus | "inProgress";

const LISTED_STATUSES: readonly string[] = ["completed", "interrupted", "failed", "inProgress"];

/**
 * A thread's latest turn as thread/turns/list answered it, asked for newest first and one at a time: its id and status,
 * or `none` when the thread has no turn. Only `data` and its first entry's id and status are read. A status is the
 * child's as stored, not a live observation: a turn left in progress on a thread that is not loaded may be listed as
 * `interrupted`, so a caller that needs a finished checkpoint requires exactly `completed`.
 */
export type CodexLatestTurn = { none: true } | { none: false; turnId: string; status: CodexListedTurnStatus };

export function readTurnsList(result: unknown): CodexRead<CodexLatestTurn> {
	if (!isRecord(result) || !Array.isArray(result.data)) return no("its thread/turns/list answer carries no list of turns");
	if (result.data.length === 0) return ok({ none: true });
	const first: unknown = result.data[0];
	if (!isRecord(first)) return no("its thread/turns/list answer lists a turn that is not one");
	const turnId = ident(first.id);
	if (turnId === undefined) return no("its thread/turns/list answer lists a turn with no id");
	if (typeof first.status !== "string" || !LISTED_STATUSES.includes(first.status)) return no("its thread/turns/list answer lists a turn with no status this version has");
	return ok({ none: false, turnId, status: first.status as CodexListedTurnStatus });
}

/** What a turn/steer answered: the turn the input went to. Accepted is not consumed; nothing here says the model read it. */
export function readTurnSteer(result: unknown): CodexRead<{ turnId: string }> {
	if (!isRecord(result)) return no("its turn/steer answer is not an object");
	const turnId = ident(result.turnId);
	if (turnId === undefined) return no("its turn/steer answer names no turn id");
	return ok({ turnId });
}

/** A turn's error, as much of it as a report may carry: its message cut to the caller's cap, and Codex's own code. */
export interface CodexTurnError {
	message: string;
	cut: boolean;
	/** Codex's error tag — `usageLimitExceeded`, or the key of a tagged one such as `httpConnectionFailed` — when it named one. */
	info?: string;
	httpStatusCode?: number;
}

const readTurnError = (value: unknown, maxBytes: number): CodexTurnError | undefined => {
	if (!isRecord(value) || typeof value.message !== "string") return undefined;
	const message = boundText(value.message, maxBytes);
	const error: CodexTurnError = { message: message.text, cut: message.cut };
	const info = value.codexErrorInfo;
	if (typeof info === "string") {
		const tag = ident(info);
		if (tag !== undefined) error.info = tag;
	} else if (isRecord(info)) {
		const keys = Object.keys(info);
		const tag = keys.length === 1 ? ident(keys[0]) : undefined;
		if (tag !== undefined) {
			error.info = tag;
			const detail = info[keys[0]];
			const status = isRecord(detail) ? count(detail.httpStatusCode) : undefined;
			if (status !== undefined) error.httpStatusCode = status;
		}
	}
	return error;
};

/** The two ids every turn-scoped notification carries, which is what correlates it with one turn of one thread. */
export interface CodexTurnKey {
	threadId: string;
	turnId: string;
}

/** A turn/started notification. */
export function readTurnStarted(params: unknown): CodexRead<CodexTurnKey> {
	if (!isRecord(params) || !isRecord(params.turn)) return no("a turn start carries no turn");
	const threadId = ident(params.threadId);
	const turnId = ident(params.turn.id);
	if (threadId === undefined || turnId === undefined) return no("a turn start names no thread or no turn");
	return ok({ threadId, turnId });
}

/** The three ends a turn/completed reports. `inProgress` is a turn's status but never its end, so it is refused. */
export type CodexTurnStatus = "completed" | "failed" | "interrupted";

export interface CodexTurnCompleted extends CodexTurnKey {
	status: CodexTurnStatus;
	error: CodexTurnError | null;
}

export function readTurnCompleted(params: unknown, maxErrorBytes: number): CodexRead<CodexTurnCompleted> {
	if (!isRecord(params) || !isRecord(params.turn)) return no("a turn completion carries no turn");
	const threadId = ident(params.threadId);
	const turnId = ident(params.turn.id);
	if (threadId === undefined || turnId === undefined) return no("a turn completion names no thread or no turn");
	const status = params.turn.status;
	if (status !== "completed" && status !== "failed" && status !== "interrupted") return no("a turn completion reports no end this version has");
	let error: CodexTurnError | null = null;
	if (params.turn.error !== undefined && params.turn.error !== null) {
		const read = readTurnError(params.turn.error, maxErrorBytes);
		if (read === undefined) return no("a turn completion reports an error with no message");
		error = read;
	}
	return ok({ threadId, turnId, status, error });
}

/**
 * An `error` notification. `willRetry` true is Codex retrying on its own and is no end of anything; false is the
 * turn's terminal error, which the turn/completed after it is what actually ends the turn.
 */
export interface CodexErrorNotice extends CodexTurnKey {
	willRetry: boolean;
	error: CodexTurnError;
}

export function readErrorNotice(params: unknown, maxErrorBytes: number): CodexRead<CodexErrorNotice> {
	if (!isRecord(params)) return no("an error notification carries no params");
	const threadId = ident(params.threadId);
	const turnId = ident(params.turnId);
	if (threadId === undefined || turnId === undefined) return no("an error notification names no thread or no turn");
	if (typeof params.willRetry !== "boolean") return no("an error notification does not say whether it will retry");
	const error = readTurnError(params.error, maxErrorBytes);
	if (error === undefined) return no("an error notification carries no error message");
	return ok({ threadId, turnId, willRetry: params.willRetry, error });
}

/**
 * A model/rerouted notification: per-turn telemetry that one turn ran on another model, and never the thread's
 * configured selection. Whether a reroute is acceptable is a policy decision above this transport.
 */
export interface CodexReroute extends CodexTurnKey {
	fromModel: string;
	toModel: string;
	reason: string;
}

export function readReroute(params: unknown): CodexRead<CodexReroute> {
	if (!isRecord(params)) return no("a reroute carries no params");
	const threadId = ident(params.threadId);
	const turnId = ident(params.turnId);
	const fromModel = ident(params.fromModel);
	const toModel = ident(params.toModel);
	const reason = ident(params.reason);
	if (threadId === undefined || turnId === undefined || fromModel === undefined || toModel === undefined || reason === undefined) return no("a reroute does not name its thread, turn, models and reason");
	return ok({ threadId, turnId, fromModel, toModel, reason });
}

/* ------------------------------------------------------------------------------------------------------------------
 * usage
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * One usage breakdown. `inputTokens` already includes `cachedInputTokens`, so the cached count is a part of the input
 * and never added to it; a breakdown whose cached count exceeds its input is refused as one that contradicts that.
 */
export interface CodexTokenBreakdown {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	/**
	 * Absent in the shape means zero, which is its declared default. Reported as Codex reported it and never added to
	 * `inputTokens` or clamped against it: whether these tokens are a subset of the input, like cached input, is not
	 * settled by the source this reads and stays a native qualification question (Q14), so no arithmetic assumes it.
	 */
	cacheWriteInputTokens: number;
}

/**
 * A thread/tokenUsage/updated notification. `total` is cumulative for the whole thread, `last` is the latest model
 * response alone — not the turn's sum — and the context window may be null when the child does not know it.
 */
export interface CodexTokenUsage extends CodexTurnKey {
	total: CodexTokenBreakdown;
	last: CodexTokenBreakdown;
	modelContextWindow: number | null;
}

const readBreakdown = (value: unknown): CodexTokenBreakdown | undefined => {
	if (!isRecord(value)) return undefined;
	const inputTokens = count(value.inputTokens);
	const cachedInputTokens = count(value.cachedInputTokens);
	const outputTokens = count(value.outputTokens);
	const reasoningOutputTokens = count(value.reasoningOutputTokens);
	const totalTokens = count(value.totalTokens);
	const cacheWriteInputTokens = value.cacheWriteInputTokens === undefined ? 0 : count(value.cacheWriteInputTokens);
	if (inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined || reasoningOutputTokens === undefined || totalTokens === undefined || cacheWriteInputTokens === undefined) return undefined;
	if (cachedInputTokens > inputTokens) return undefined;
	return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, cacheWriteInputTokens };
};

export function readTokenUsage(params: unknown): CodexRead<CodexTokenUsage> {
	if (!isRecord(params) || !isRecord(params.tokenUsage)) return no("a usage update carries no usage");
	const threadId = ident(params.threadId);
	const turnId = ident(params.turnId);
	if (threadId === undefined || turnId === undefined) return no("a usage update names no thread or no turn");
	const total = readBreakdown(params.tokenUsage.total);
	const last = readBreakdown(params.tokenUsage.last);
	if (total === undefined || last === undefined) return no("a usage update carries a breakdown that is not one");
	const window = params.tokenUsage.modelContextWindow;
	const modelContextWindow = window === undefined || window === null ? null : count(window);
	if (modelContextWindow === undefined) return no("a usage update reports a context window that is not a count");
	return ok({ threadId, turnId, total, last, modelContextWindow });
}

/* ------------------------------------------------------------------------------------------------------------------
 * items and approvals: diagnostics, never evidence
 * ---------------------------------------------------------------------------------------------------------------- */

/** One item as far as a report shows it: its id and type, a tool's status, and an agent message's text, bounded. */
export interface CodexItem extends CodexTurnKey {
	itemId: string;
	type: string;
	status?: string;
	text?: { text: string; cut: boolean };
}

/** An item/started or item/completed notification. Malformed answers a reason the caller counts and drops. */
export function readItem(params: unknown, maxTextBytes: number): CodexRead<CodexItem> {
	if (!isRecord(params) || !isRecord(params.item)) return no("an item notification carries no item");
	const threadId = ident(params.threadId);
	const turnId = ident(params.turnId);
	const itemId = ident(params.item.id);
	const type = ident(params.item.type);
	if (threadId === undefined || turnId === undefined || itemId === undefined || type === undefined) return no("an item notification does not name its thread, turn, id and type");
	const item: CodexItem = { threadId, turnId, itemId, type };
	const status = ident(params.item.status);
	if (status !== undefined) item.status = status;
	if (type === "agentMessage" && typeof params.item.text === "string") item.text = boundText(params.item.text, maxTextBytes);
	return item.type === "agentMessage" && item.text === undefined ? no("an agent message item carries no text") : ok(item);
}

/** The two approval requests this host answers, always with `decline`, and the kind of denial each one is. */
export const CODEX_APPROVAL_METHODS: Readonly<Record<string, "command" | "file">> = Object.freeze({
	"item/commandExecution/requestApproval": "command",
	"item/fileChange/requestApproval": "file",
});

/**
 * A denial this host made: which kind of approval was asked for and, where the request named them, the turn and
 * item it was for and the command it wanted to run. Ids a request did not name are left out, never guessed.
 */
export interface CodexDenial {
	kind: "command" | "file";
	threadId?: string;
	turnId?: string;
	itemId?: string;
	command?: { text: string; cut: boolean };
}

export function readApproval(kind: "command" | "file", params: unknown, maxTextBytes: number): CodexDenial {
	const denial: CodexDenial = { kind };
	if (!isRecord(params)) return denial;
	const threadId = ident(params.threadId);
	const turnId = ident(params.turnId);
	const itemId = ident(params.itemId);
	if (threadId !== undefined) denial.threadId = threadId;
	if (turnId !== undefined) denial.turnId = turnId;
	if (itemId !== undefined) denial.itemId = itemId;
	if (typeof params.command === "string") denial.command = boundText(params.command, maxTextBytes);
	return denial;
}
