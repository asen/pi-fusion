import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ACTIVITY_CHARS,
	ChildInput,
	type ChildSession,
	childOptions,
	claudeBackend,
	claudeExecutable,
	type ClaudeRun as ChildRun,
	CONTRACTS_DIR,
	QUESTION_TOOL,
	questionAnswers,
	questionText,
	type Role,
	runChild,
} from "./backends/claude.ts";
import { createPiBackend } from "./backends/pi-backend.ts";
import { PI_CONTRACT_FILES, type PiFallback, piEffortVariable, piModelVariable, piParams, piRole, variableFallback } from "./backends/pi-binding.ts";
import { hostAgentDir, PI_BOOTSTRAP_PATH } from "./backends/pi-launch.ts";
import {
	type Ask,
	BACKEND_NAMES,
	type BackendName,
	type ChildControl,
	type ChildEvent,
	type ChildRun as BackendRun,
	failed,
	type HostBackend,
	hostBackend,
	type HostRole,
	type HostSession,
	isBackendName,
	isPiModel,
	keptRef,
	keptSelection,
	type ModelCost,
	PI_EFFORTS,
	type ResolvedSelection,
	resolvedSelectionOf,
	type SessionIntent,
	type SessionRef,
	sessionRefOf,
} from "./backends/types.ts";
import { budgetConfig, budgetProblems, type CallUsage, Ledger } from "./budget.ts";
import { bodyLines, Card, CARD_FILES, CARD_QUESTION_CHARS, type CardDetails, cardDetails, type CardMode, type CardTheme, headerLine, plainText, resultText, type WidgetRun, widgetLines } from "./cards.ts";
import { type ChangedFile, changedFiles, type Snapshot, snapshot } from "./changes.ts";
import { type Dashboard, RunStore, startDashboard } from "./dashboard.ts";
import { contextShare, continueNote, handoffBlocked, handoffNote, handoffPrompt, handoffShare, planContextPct, planProblems, sharePercent, type HandoffReason } from "./handoff.ts";
import { History, type HistoryRecord, historyDir, historyEnabled } from "./history.ts";
import { hostProfileStore, type ProfileStore } from "./profile-store.ts";
import {
	type Baseline,
	BUILTIN,
	builtinSettings,
	CLAUDE_EFFORTS,
	captureBaseline,
	copySettings,
	effortsFor,
	nameProblem,
	type ProfileDocument,
	parseSettings,
	type RoleSetting,
	type RoleSettings,
	sameSettings,
	type Selection,
	settingsTable,
	ULTRACODE_EFFORT,
} from "./profiles.ts";
import { reviewable, reviewPrompt } from "./review.ts";
import { canChangeFiles, isKnownRole, KNOWN_ROLE_NAMES, type KnownRoleName, ROLE_SPECS, type RoleSpec, roleSpec } from "./roles.ts";

/** A run as the shared lifecycle reads it, whichever backend produced it: the record over the part of a role the host uses. */
type HostRun = BackendRun<HostRole>;

/** The Claude child's own surface, kept as this module's exports: its callers and tests read the backend through it. */
export { ChildInput, childOptions, claudeExecutable, failed, QUESTION_TOOL, questionAnswers, questionText, runChild };
export type { BackendName, ChildEvent, ChildRun, ChildSession, HostBackend, HostRole, HostSession, ModelCost, ResolvedSelection, Role, SessionIntent, SessionRef };

const SESSION_ENTRY = "pi-fusion";
const TICK_MS = 1_000;
/** How often a running run's changed-file count is sampled: a git call per second per run is too many. */
const FILE_SAMPLE_MS = 10_000;

export const ROLE_NAMES = ["plan", "implement", "ultracode", "ask"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * What each Claude role is apart from its model and effort: its tools, permission mode and contract. The model and
 * effort are a session's configuration, resolved per call, so nothing here pins them when this module is imported.
 */
type ClaudeShape = Omit<Role, "model" | "effort">;

const ROLES: Record<RoleName, ClaudeShape> = {
	plan: {
		name: "plan",
		tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
		permissionMode: "bypassPermissions",
		contract: "plan.md",
	},
	implement: {
		name: "implement",
		tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
		permissionMode: "bypassPermissions",
		contract: "implement.md",
	},
	ultracode: {
		name: "ultracode",
		permissionMode: process.env.PI_FUSION_ULTRACODE_PERMISSION_MODE?.trim() || "bypassPermissions",
		contract: "ultracode.md",
	},
	ask: {
		name: "ask",
		tools: ["Read", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"],
		permissionMode: "bypassPermissions",
		contract: "ask-answer.md",
	},
};

export const ASK_MODES = ["answer", "review"] as const;
export type AskMode = (typeof ASK_MODES)[number];
const ASK_CONTRACTS: Record<AskMode, string> = { answer: "ask-answer.md", review: "ask-review.md" };

export const EFFORTS = CLAUDE_EFFORTS;

/** The claude parameters only some roles take. `ultracode` takes no effort, because any other level turns its workflows off. */
const ROLE_PARAMETERS: Record<"fresh" | "mode" | "model" | "effort", readonly RoleName[]> = {
	fresh: ["plan"],
	mode: ["ask"],
	model: ["plan", "implement", "ask"],
	effort: ["plan", "implement", "ask"],
};

/** Every effort level any backend takes: Pi's thinking levels, which already hold the Claude tiers. A level is checked against the backend the call routes to, never here. */
export const FUSION_EFFORTS = PI_EFFORTS;

export interface ClaudeParams {
	role?: string;
	task: string;
	context?: string;
	continue?: string;
	fresh?: boolean;
	background?: boolean;
	mode?: string;
	model?: string;
	effort?: string;
}

/** A fusion call: the claude parameters and the backend to run them on. An omitted backend is the role's own default. */
export interface FusionParams extends ClaudeParams {
	backend?: string;
}

/**
 * The role the compatibility tool runs, or the sentence it has always refused another name with. The claude tool
 * advertises these four roles and no more, so a role this build runs on Pi alone is not one it knows: it is refused by
 * this list rather than by a capability that tool never advertised. One place composes the sentence, because the
 * parameter check and the claude route both have to refuse such a name the same way.
 */
function claudeRoleName(role: string): RoleName {
	if (!(ROLE_NAMES as readonly string[]).includes(role)) throw new Error(`unknown role ${role}; use one of ${ROLE_NAMES.join(", ")}`);
	return role as RoleName;
}

/**
 * The role and mode a claude call names, or an error naming what the role cannot take. This is the parameter half of
 * the Claude binding, so a call can be refused for its parameters before anything resolves a model.
 */
export function claudeParams(params: ClaudeParams & { role: string }): { name: RoleName; mode: AskMode } {
	const name = claudeRoleName(params.role);
	for (const [parameter, roles] of Object.entries(ROLE_PARAMETERS)) {
		if (params[parameter as keyof ClaudeParams] !== undefined && !roles.includes(name)) throw new Error(`${parameter} is not allowed for role ${name}`);
	}
	if (params.effort !== undefined && !(EFFORTS as readonly string[]).includes(params.effort)) {
		throw new Error(`unknown effort ${params.effort}; use one of ${EFFORTS.join(", ")}`);
	}
	if (params.mode !== undefined && !(ASK_MODES as readonly string[]).includes(params.mode)) {
		throw new Error(`unknown mode ${params.mode}; use one of ${ASK_MODES.join(", ")}`);
	}
	return { name, mode: (params.mode ?? "answer") as AskMode };
}

/**
 * The role a claude call runs: the call's own model and effort, then the defaults its route settled on — the session's
 * configuration, the run it continues or the legacy defaults — and the legacy defaults of the environment as it is
 * now when no route gave any. Ultracode's effort is always its own. Throws on a role or parameter the call cannot use.
 */
export function roleFor(params: ClaudeParams & { role: string }, defaults?: Selection): Role {
	const { name, mode } = claudeParams(params);
	const base = defaults ?? captureBaseline()[name].claude ?? {};
	const model = params.model?.trim() || base.model;
	const effort = name === "ultracode" ? ULTRACODE_EFFORT : params.effort || base.effort;
	if (!model) throw new Error(`role ${name} has no model for the claude backend; name one in the call's model parameter or choose one with /fusion config`);
	if (!effort) throw new Error(`role ${name} has no effort for the claude backend; name one in the call's effort parameter or choose one with /fusion config`);
	return {
		...ROLES[name],
		model,
		effort,
		...(name === "ask" ? { mode, contract: ASK_CONTRACTS[mode] } : {}),
	};
}

/** What the host session records about a run: the last entry for a handle on the host's branch wins. */
export interface RunRecord {
	handle: string;
	role: KnownRoleName;
	/** An ask run's mode, which a continue keeps unless it names another. */
	mode?: AskMode;
	/**
	 * The backend that ran it. An entry without one was written before backends were tagged, which means Claude; an
	 * entry naming a backend this host does not know has none, because a record is never read as Claude by default.
	 */
	backend?: BackendName;
	/** Why this record cannot be continued. It still holds its handle, and a plan record is still its backend's latest. */
	refusal?: string;
	/** The verified session a continuation of this run opens, with the checkpoint it restores when one is trusted. */
	session?: SessionRef;
	/** What the child ran with, for a backend whose continuation has to repeat that selection rather than resolve it again. */
	selection?: ResolvedSelection;
	/** The Claude session id and checkpoint as the flat entry carries them, which the Claude helpers still read. */
	sessionId?: string;
	hostSessionId?: string;
	/** The last assistant message of the last successful call on this host branch. */
	checkpoint?: string;
	/**
	 * The Claude model and effort the run was admitted with, which later calls to the run keep unless they name others.
	 * Every run this build writes records both, the defaults included; an older entry carries the model only when a
	 * call chose one over the role's default, and no effort at all.
	 */
	model?: string;
	effort?: string;
	/** The prompt size of that call's last model turn, and the window it filled, so a plan call can weigh continuing it. */
	contextTokens?: number;
	contextWindow?: number;
}

export interface RunRecords {
	runs: Map<string, RunRecord>;
	/**
	 * The handle of the plan run that a plan call without continue or fresh continues, per backend: a plan run of one
	 * backend never continues into another. A record this host refuses is still its backend's latest plan, so an
	 * implicit continuation stops at it instead of walking silently back to an older plan run.
	 */
	lastPlan: Map<BackendName, string>;
	highest: number;
}

const HANDLE = /^run-([1-9]\d*)$/;

/** What a record says when the entry names it but this host will not act on it. */
const refused = (record: RunRecord, why: string): RunRecord => ({ ...record, refusal: `${record.handle} ${why}` });

const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : String(value));

/** The Claude half of an entry: the flat session id and checkpoint it has always carried. */
function claudeRecord(base: RunRecord, data: Record<string, unknown>): RunRecord {
	const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
	const checkpoint = typeof data.checkpoint === "string" ? data.checkpoint : undefined;
	const record: RunRecord = {
		...base,
		backend: "claude",
		...(sessionId === undefined ? {} : { sessionId }),
		...(checkpoint === undefined ? {} : { checkpoint }),
		// The flat model is this backend's own: a Pi run's model is in the selection it recorded, never in this field.
		...(typeof data.model === "string" && data.model ? { model: data.model } : {}),
		...(typeof data.effort === "string" && data.effort ? { effort: data.effort } : {}),
		...(typeof data.contextTokens === "number" ? { contextTokens: data.contextTokens } : {}),
		...(typeof data.contextWindow === "number" ? { contextWindow: data.contextWindow } : {}),
	};
	if (data.session !== undefined) {
		// A Claude entry carries its identity flat. A structured reference in one is another backend's record mis-tagged.
		const ref = sessionRefOf(data.session, "claude");
		if (!ref || (sessionId !== undefined && ref.sessionId !== sessionId)) return refused(record, "carries a session reference that is not the claude session it records; it cannot be continued, so start a new run");
		// A reference and no flat id is an entry no writer of this format makes. Reading it as a run with no identity
		// would start a new session over a child the entry names, so the handle is kept and the record is refused.
		if (sessionId === undefined) {
			return refused(record, `records its claude session ${ref.sessionId} in a session reference and not in the session id this format carries; it cannot be continued, so start a new run`);
		}
	}
	// An empty id is no identity: such an entry has always started a new session rather than resumed an empty one.
	if (!sessionId) return record;
	return { ...record, session: { backend: "claude", sessionId, ...(checkpoint ? { checkpoint } : {}) } };
}

/**
 * The Pi half of an entry. A Pi run is only ever identified by the structured reference it recorded, session file and
 * all: a loose session id, a loose checkpoint or an incomplete reference is refused rather than read as a run with no
 * identity, which would start a new session over a child that exists. A handle alone keeps the failed run for reading,
 * never for continuation: retrying requires an explicitly new run.
 */
function piRecord(base: RunRecord, data: Record<string, unknown>): RunRecord {
	const record: RunRecord = { ...base, backend: "pi" };
	const loose = ["sessionId", "checkpoint", "sessionFile"].filter((field) => data[field] !== undefined);
	if (data.session === undefined) {
		if (loose.length) return refused(record, `records its pi session in ${loose.join(", ")} rather than in a session reference; it cannot be continued, so start a new run`);
		return refused(record, "ran on pi and recorded no verified session, so it cannot be continued; start a new run without continue (a plan call takes fresh true)");
	}
	const ref = sessionRefOf(data.session, "pi");
	if (!ref) return refused(record, "has an incomplete or mismatched pi session reference; it cannot be continued, so start a new run");
	if (loose.length) return refused({ ...record, session: ref }, `carries both a pi session reference and ${loose.join(", ")}; it cannot be continued, so start a new run`);
	const held: RunRecord = { ...record, session: ref };
	const selection = resolvedSelectionOf(data.selection, "pi");
	if (!ref.checkpoint) {
		return refused(
			held,
			`ran on pi and recorded no trusted checkpoint, so it is kept for reading and not continued; its session file is ${ref.sessionFile}, and new work needs a new run (a plan call takes fresh true)`,
		);
	}
	if (!selection) {
		return refused(
			held,
			`recorded no model and effort this host can repeat, so it is kept for reading and not continued against whatever is configured now; its session file is ${ref.sessionFile}, and new work needs a new run (a plan call takes fresh true)`,
		);
	}
	return {
		...held,
		selection,
		...(typeof data.contextTokens === "number" ? { contextTokens: data.contextTokens } : {}),
		...(typeof data.contextWindow === "number" ? { contextWindow: data.contextWindow } : {}),
	};
}

/**
 * Entries written before handles existed carry only the plan session, under the consolidator keys. Generation g
 * reads as handle run-(g+1), so each fresh plan session keeps a handle of its own.
 */
function recordOf(data: Record<string, unknown>): RunRecord | undefined {
	const hostSessionId = typeof data.hostSessionId === "string" ? { hostSessionId: data.hostSessionId } : {};
	if (typeof data.run === "string") {
		if (!HANDLE.test(data.run) || !isKnownRole(data.role)) return undefined;
		const base: RunRecord = {
			handle: data.run,
			role: data.role,
			...((ASK_MODES as readonly unknown[]).includes(data.mode) ? { mode: data.mode as AskMode } : {}),
			...hostSessionId,
		};
		if (data.backend === undefined || data.backend === "claude") return claudeRecord(base, data);
		if (data.backend === "pi") return piRecord(base, data);
		return refused(base, `was recorded by backend ${shown(data.backend)}, which this pi-fusion does not know; it cannot be continued, so start a new run`);
	}
	if (typeof data.consolidatorGeneration !== "number") return undefined;
	const generation: RunRecord = { handle: `run-${data.consolidatorGeneration + 1}`, role: "plan", ...hostSessionId };
	// The consolidator keys are Claude's own, from before backends were tagged: only an entry that names no other
	// backend reads as one. A tag over them is a record this host cannot make sense of, and its handle stays taken.
	if (data.backend === undefined || data.backend === "claude") {
		return claudeRecord(generation, {
			...(typeof data.consolidatorSessionId === "string" ? { sessionId: data.consolidatorSessionId } : {}),
			...(typeof data.consolidatorCheckpoint === "string" ? { checkpoint: data.consolidatorCheckpoint } : {}),
		});
	}
	if (data.backend === "pi") return refused({ ...generation, backend: "pi" }, "is tagged pi over the consolidator keys of a claude entry and names no pi session; it cannot be continued, so start a new run");
	return refused(generation, `was recorded by backend ${shown(data.backend)}, which this pi-fusion does not know; it cannot be continued, so start a new run`);
}

export function runRecords(branch: readonly unknown[]): RunRecords {
	const records: RunRecords = { runs: new Map(), lastPlan: new Map(), highest: 0 };
	for (const entry of branch) {
		const candidate = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
		if (candidate?.type !== "custom" || candidate.customType !== SESSION_ENTRY) continue;
		const record = recordOf(candidate.data ?? {});
		if (!record) continue;
		records.runs.set(record.handle, record);
		records.highest = Math.max(records.highest, handleNumber(record.handle));
		// A refused plan record is still the latest plan of its backend: skipping it would continue an older one instead.
		if (record.role === "plan" && record.backend) records.lastPlan.set(record.backend, record.handle);
	}
	return records;
}

/**
 * A recorded session continues in the host session that recorded it, from the recorded checkpoint, so a host that
 * went back with /tree takes the run back with it. Any other host session, which is what a fork of that host is,
 * gets its own fork of it from that checkpoint, so the two hosts stop sharing its context from there on. Which
 * session that becomes is the backend's to say: this names the intent and nothing about a session id.
 */
export function intentFor(record: RunRecord | undefined, hostSessionId: string): SessionIntent {
	if (!record) return { kind: "new" };
	if (record.refusal) throw new Error(record.refusal);
	// A Claude record keeps its identity flat, and a record from before backends were tagged has nothing else.
	const flat: SessionRef | undefined =
		record.backend === "pi" || !record.sessionId ? undefined : { backend: "claude", sessionId: record.sessionId, ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}) };
	const ref = record.session ?? flat;
	if (!ref) return { kind: "new" };
	return record.hostSessionId === hostSessionId ? { kind: "resume", ref } : { kind: "fork", from: ref };
}

/** The Claude session a record continues in: the shared intent, mapped by the backend that allocates the ids. */
export function nextSession(record: RunRecord | undefined, hostSessionId: string): ChildSession {
	return claudeBackend.session(intentFor(record, hostSessionId));
}

/** What a finished run's outcome says about its session, which is what the host records from. */
export interface RunOutcome {
	ok: boolean;
	sessionId?: string;
	checkpoint?: string;
	session?: SessionRef;
	selection?: ResolvedSelection;
	contextTokens?: number;
	contextWindow?: number;
}

/** What the run to record is, apart from its outcome: its handle and role, and the session it was started for. */
export interface RecordCall {
	handle: string;
	role: string;
	mode?: AskMode;
	backend: BackendName;
	hostSessionId: string;
	intent: SessionIntent;
	/**
	 * The model and effort this call ran on. Only the Claude half of an entry carries them: a Pi run's are in the
	 * selection it records, which its continuation repeats.
	 */
	model?: string;
	effort?: string;
	/** What the branch already records for this handle, which a run that recorded nothing leaves as it is. */
	prior?: RunRecord;
}

/** Recording a finished run: the entry to append, nothing to append, or an outcome the host will not record at all. */
export type RecordDecision = { entry: Record<string, unknown> } | { keep: true } | { invalid: string };

const postcondition = (handle: string, why: string): { invalid: string } => ({
	invalid: `invalid session postcondition: ${handle} ${why}, so nothing was recorded for it and its earlier record, if any, is unchanged`,
});

/**
 * The Claude entry a finished run writes: the flat fields, unchanged, under this backend's tag. A run that also
 * reports a structured reference has it checked first, so a reference from another backend or one naming another
 * session fails the run instead of being recorded beside a session id it disagrees with. Its checkpoint is not
 * checked against the flat one: a fork that failed keeps the message it forked at while the flat one is the tip.
 */
function claudeDecision(call: RecordCall, outcome: RunOutcome, entry: Record<string, unknown>): RecordDecision {
	// The model and effort are recorded even for a run that reported no session: they are what the handle ran on, and an
	// entry written for a run with no identity is still the record a later reader of this handle sees.
	if (call.model) entry.model = call.model;
	if (call.effort) entry.effort = call.effort;
	if (outcome.session !== undefined) {
		const ref = sessionRefOf(outcome.session, "claude");
		if (!ref) return postcondition(call.handle, "reported a session reference that is not a claude session");
		if (outcome.sessionId !== undefined && ref.sessionId !== outcome.sessionId) return postcondition(call.handle, "reported one claude session in its reference and another in its outcome");
		// A claude run's identity is the flat id every reader of this backend uses. An outcome that knows its session
		// and leaves that id out would be recorded as a run with no session at all, so it fails instead of losing one.
		if (outcome.sessionId === undefined) return postcondition(call.handle, `reported claude session ${ref.sessionId} in a session reference and no session id beside it`);
	}
	if (!outcome.sessionId) return call.prior ? { keep: true } : { entry };
	// A failed continuation records nothing, so the last successful checkpoint of this handle stays authoritative.
	if (call.intent.kind === "resume" && !outcome.ok) return { keep: true };
	entry.sessionId = outcome.sessionId;
	const checkpoint = (outcome.ok && outcome.checkpoint) || (call.intent.kind === "fork" ? call.intent.from.checkpoint : undefined);
	if (checkpoint) entry.checkpoint = checkpoint;
	if (outcome.ok && outcome.contextTokens && outcome.contextWindow) {
		entry.contextTokens = outcome.contextTokens;
		entry.contextWindow = outcome.contextWindow;
	}
	return { entry };
}

/**
 * The Pi entry a finished run writes. Identity comes from the reference the outcome carries and from nowhere else,
 * and every rule the recovery policy states is checked here: a successful call needs a verified reference with a
 * trusted checkpoint and the selection it actually ran with; a failed continuation records nothing; a fork that
 * failed after its session existed keeps the checkpoint it forked at, never the tip it failed on; a first call that
 * failed with an identity keeps that identity without a checkpoint, so the next call for the handle fails closed.
 */
function piDecision(call: RecordCall, outcome: RunOutcome, entry: Record<string, unknown>): RecordDecision {
	const { handle, intent } = call;
	const source = intent.kind === "resume" ? intent.ref : intent.kind === "fork" ? intent.from : undefined;
	const ref = outcome.session === undefined ? undefined : sessionRefOf(outcome.session, "pi");
	if (outcome.session !== undefined && !ref) return postcondition(handle, "reported a session reference without a pi session id and session file");
	if (ref && source) {
		const from = source.backend === "pi" ? source : undefined;
		if (!from) return postcondition(handle, `was started from a ${source.backend} session, which no pi run can continue`);
		if (intent.kind === "resume" && (ref.sessionId !== from.sessionId || ref.sessionFile !== from.sessionFile)) {
			return postcondition(handle, "resumed one session and reported another");
		}
		if (intent.kind === "fork" && (ref.sessionId === from.sessionId || ref.sessionFile === from.sessionFile)) {
			return postcondition(handle, "forked its session and reported the session it forked from");
		}
	}
	const selection = resolvedSelectionOf(outcome.selection, "pi");
	if (outcome.ok) {
		if (!ref) return postcondition(handle, "succeeded without reporting the session it ran in");
		if (!ref.checkpoint) return postcondition(handle, "succeeded without reporting the checkpoint its session settled on");
		if (!selection) return postcondition(handle, "succeeded without reporting the model and effort it ran with");
		entry.session = { ...ref };
		entry.selection = selection;
		if (outcome.contextTokens && outcome.contextWindow) {
			entry.contextTokens = outcome.contextTokens;
			entry.contextWindow = outcome.contextWindow;
		}
		return { entry };
	}
	if (!ref) {
		// Nothing was verified, so a continuation leaves its record alone and a brand new handle records itself alone.
		if (intent.kind !== "new" || call.prior) return { keep: true };
		return { entry };
	}
	if (intent.kind === "resume") return { keep: true };
	if (intent.kind === "fork") {
		const at = source?.backend === "pi" ? source.checkpoint : undefined;
		if (!at || ref.checkpoint !== at) return postcondition(handle, "forked and failed without keeping the checkpoint it forked at");
		// The fork is verified by then: its id and file are not the source's, and its checkpoint is the point it forked
		// at. A call that failed or was cancelled before it read a selection back is a partial failure, not a claim this
		// host has to disbelieve, so the identity is kept and the selection only when the child reported a usable one.
		// Nothing here stands in for it: the request, the variables and the source's selection are all guesses about a
		// child that never said what it ran with. The record is then unrepeatable, and the read side refuses to continue
		// it; dropping the fork instead would leave a child nothing names and send the next call forking the source
		// again. A claimed success is the other case, and still fails without a reference, a checkpoint and a selection.
		entry.session = { ...ref };
		if (selection) entry.selection = selection;
		return { entry };
	}
	if (ref.checkpoint) return postcondition(handle, "failed and claimed a trusted checkpoint, which only a settled call or a fork has");
	entry.session = { ...ref };
	if (selection) entry.selection = selection;
	return { entry };
}

/** What the host branch records for a finished run, decided from the outcome alone and from no id guessed before it. */
export function recordDecision(call: RecordCall, outcome: RunOutcome): RecordDecision {
	const entry: Record<string, unknown> = { run: call.handle, role: call.role, backend: call.backend, hostSessionId: call.hostSessionId };
	if (call.mode) entry.mode = call.mode;
	return call.backend === "pi" ? piDecision(call, outcome, entry) : claudeDecision(call, outcome, entry);
}

/** A plan call that started a fresh run rather than continue the last one. */
export interface Handoff {
	from: string;
	reason: HandoffReason;
}

/**
 * What a session runs its roles as: the role settings it applied, where they came from, and the legacy defaults its
 * extension instance started with, which a call naming the other backend than the configured one runs on.
 */
export interface Configuration {
	/** The profile the settings were loaded from, `builtin` for the legacy defaults. */
	profile: string;
	/** True once the settings were edited in this session and no longer match the profile they came from. */
	modified: boolean;
	roles: RoleSettings;
	baseline: Baseline;
}

/** The built-in configuration over a baseline: the legacy defaults, every role enabled on its legacy backend. */
export function builtinConfiguration(baseline: Baseline = captureBaseline()): Configuration {
	return { profile: BUILTIN, modified: false, roles: builtinSettings(baseline), baseline };
}

/** How a configuration names itself in a message: the profile, and whether this session has edited it since. */
export const configurationLabel = (config: Configuration): string => `${config.profile}${config.modified ? " (modified)" : ""}`;

/**
 * The model and effort a route settled on beneath the call's own: the configuration's, a continued or handed-off run's,
 * or the baseline's. `from` names where they came from for a Pi binding that refuses one, and is absent when they are
 * the role's own variables, whose names are what such a refusal points at.
 */
export interface RouteDefaults extends Selection {
	from?: string;
}

/**
 * Where a call goes before any backend has bound a role for it: the backend it runs on, the role it runs, the handle
 * it takes and the record it continues. Everything a call can be refused for that does not depend on a model is
 * settled here, so a route can be refused for its record, its role or its parameters before a binding resolves one.
 */
export interface FusionRoute {
	backend: BackendName;
	role: KnownRoleName;
	handle: string;
	record?: RunRecord;
	handoff?: Handoff;
	/** The call as the role's own binding reads it, with the role and, for an ask run, the mode the route settled on. */
	call: FusionParams & { role: KnownRoleName };
	/** What the binding falls back on where the call names nothing. Never written into `call`, which stays the call's own. */
	defaults: RouteDefaults;
	/** What a continued Claude run never recorded, so the defaults this instance started with stood in for it. */
	unrecorded?: string;
}

/** A routed call with the role its backend bound for it. */
export interface FusionCall extends FusionRoute {
	bound: HostRole;
}

/** The backend a call names, or an error naming the ones this pi-fusion knows. */
function namedBackend(value: string): BackendName {
	if (!isBackendName(value)) throw new Error(`unknown backend ${value}; use one of ${BACKEND_NAMES.join(", ")}`);
	return value;
}

/**
 * The capabilities of a role a call may run. Every role a record may name is one a backend of this build runs, so the
 * capabilities are the whole of the check: which backends may run it is the refusal a role bound to one of them gets,
 * and it is `freshBackend`'s to make. A name no record and no call may use is refused here by the roles there are.
 */
function executableRole(role: string): RoleSpec {
	const spec = roleSpec(role);
	if (spec) return spec;
	throw new Error(`unknown role ${role}; use one of ${KNOWN_ROLE_NAMES.join(", ")}`);
}

/**
 * Refuses a role the configuration disabled, for a fresh run and a continuation alike, whatever backend, model or
 * effort the call names: a disabled role starts nothing, takes no handle and is never asked of a backend.
 */
function enabledRole(role: KnownRoleName, config: Configuration): void {
	if (!config.roles[role].enabled) throw new Error(`role ${role} is disabled in profile ${configurationLabel(config)}; change /fusion config or select another profile`);
}

/** The backend a new run goes to: the one the call named, or the one the configuration names for the role. */
function freshBackend(role: string, asked: string | undefined, config: Configuration): BackendName {
	const spec = executableRole(role);
	if (asked === undefined) return config.roles[spec.name].backend;
	const backend = namedBackend(asked);
	if (!spec.backends.includes(backend)) throw new Error(`role ${role} does not run on the ${backend} backend; use one of ${spec.backends.join(", ")}`);
	return backend;
}

/**
 * The defaults a fresh run on a backend takes: the configuration's when that is the backend it names for the role, and
 * otherwise the legacy defaults this instance started with for that backend. A profile's settings for one backend are
 * never read as the other's, and a field a profile leaves out is not filled in from a variable.
 */
function freshDefaults(role: KnownRoleName, backend: BackendName, config: Configuration): RouteDefaults {
	const setting = config.roles[role];
	if (setting.backend !== backend) return { ...config.baseline[role][backend] };
	const configured: RouteDefaults = { ...(setting.model === undefined ? {} : { model: setting.model }), ...(setting.effort === undefined ? {} : { effort: setting.effort }) };
	// The built-in configuration as it started is the role's own variables, which is what a refusal should point at.
	return config.profile === BUILTIN && !config.modified ? configured : { ...configured, from: `profile ${configurationLabel(config)}` };
}

/**
 * The defaults a continued Claude run keeps: the model and effort its record names, and for a field an older record
 * never wrote, the legacy default this instance started with — never the profile selected now — with a sentence that
 * says so. A field the call names itself needs no stand-in and earns no sentence.
 */
function claudeKept(record: RunRecord, params: FusionParams, config: Configuration): { defaults: RouteDefaults; unrecorded?: string } {
	const base = config.baseline[record.role].claude ?? {};
	const missing = [
		...(params.model === undefined && !record.model ? [`model (${base.model ?? "none"})`] : []),
		...(params.effort === undefined && !record.effort && record.role !== "ultracode" ? [`effort (${base.effort ?? "none"})`] : []),
	];
	const defaults: RouteDefaults = { ...(record.model ?? base.model ? { model: record.model ?? base.model } : {}), ...(record.effort ?? base.effort ? { effort: record.effort ?? base.effort } : {}) };
	if (!missing.length) return { defaults };
	return { defaults, unrecorded: `${record.handle} was recorded before its ${missing.length === 1 ? "setting was" : "settings were"} kept, so it runs on the default this Pi process started with: ${missing.join(", ")}` };
}

/**
 * The backend a continued run stays on: the one its record names. A record with no tag at all is one this host reads
 * as Claude, which is what every entry from before backends were tagged is; a record it cannot read is refused above.
 */
function continuedBackend(record: RunRecord, asked: string | undefined): BackendName {
	const on = record.backend ?? claudeBackend.name;
	if (asked === undefined) return on;
	const backend = namedBackend(asked);
	if (backend !== on) throw new Error(`${record.handle} ran on the ${on} backend; omit backend or use ${on}`);
	return backend;
}

/** Refuses the parameters the call's role does not take on the backend it routes to, before a model is resolved. */
function checkParams(backend: BackendName, call: FusionParams & { role: KnownRoleName }): void {
	if (backend === "claude") claudeParams(call);
	else piParams(call);
}

/**
 * The route a fusion call takes. Throws on a handle, backend, role or parameter the call cannot use. A host that passes
 * no configuration routes on the built-in one over the environment as it is now.
 */
export function fusionRoute(params: FusionParams, records: RunRecords, planPct: number = planContextPct(), config: Configuration = builtinConfiguration()): FusionRoute {
	if (params.continue !== undefined) {
		if (params.fresh !== undefined) throw new Error("fresh is not allowed with continue");
		const record = records.runs.get(params.continue);
		if (!record) {
			const known = [...records.runs.keys()];
			throw new Error(`unknown run ${params.continue}; the runs on this branch are ${known.length ? known.join(", ") : "none"}`);
		}
		if (params.role !== undefined && params.role !== record.role) throw new Error(`${record.handle} has role ${record.role}; omit role or use ${record.role}`);
		// A record this host will not act on stops the call here, before a handoff is weighed or a child is started.
		if (record.refusal) throw new Error(record.refusal);
		executableRole(record.role);
		enabledRole(record.role, config);
		const backend = continuedBackend(record, params.backend);
		const mode = params.mode ?? record.mode;
		const call = { ...params, role: record.role, ...(mode ? { mode } : {}) };
		checkParams(backend, call);
		// A Claude run keeps the model and effort it was admitted with unless the call names others. A Pi run's selection
		// is its record's own, and its binding repeats that rather than reading one off the configuration. A Pi record
		// without a verified session and selection was refused above, so no continuation guesses fallback defaults.
		const kept = backend === "claude" ? claudeKept(record, params, config) : { defaults: {} };
		return { backend, role: record.role, handle: record.handle, record, call, ...kept };
	}
	if (params.role === undefined) throw new Error("role is required unless continue is set");
	executableRole(params.role);
	const role = params.role as KnownRoleName;
	enabledRole(role, config);
	const backend = freshBackend(role, params.backend, config);
	const call = { ...params, role };
	checkParams(backend, call);
	const fresh = freshDefaults(role, backend, config);
	// A plan run of one backend is never continued into another, so the latest plan is the one this route's backend ran.
	const latestPlan = records.lastPlan.get(backend);
	const last = role === "plan" && params.fresh !== true && latestPlan ? records.runs.get(latestPlan) : undefined;
	const next = `run-${records.highest + 1}`;
	if (!last) return { backend, role, handle: next, call, defaults: fresh };
	// A latest plan record this host refuses stops the call: an implicit plan call never walks back to an older run.
	if (last.refusal) throw new Error(last.refusal);
	// What the last plan run actually ran on, in its own backend's terms: Claude keeps its model flat, and an older
	// record that kept none ran on the legacy default, while a Pi run is only ever on the selection it recorded. A
	// configured default is not what the run ran on, so it never stands in here and never reads as a change of model.
	const lastModel = backend === "claude" ? (last.model ?? config.baseline.plan.claude?.model) : last.selection?.model;
	const named = params.model?.trim();
	// Another model is not a continuation: the run holds its agreement in a context this call would not be reading.
	if (named && lastModel && named !== lastModel) {
		return { backend, role, handle: next, handoff: { from: last.handle, reason: { kind: "model", from: lastModel, to: named } }, call, defaults: fresh };
	}
	const share = handoffShare(last, planPct);
	if (share === undefined) {
		const kept = backend === "claude" ? claudeKept(last, params, config) : { defaults: {} };
		return { backend, role, handle: last.handle, record: last, call, ...kept };
	}
	// A cap hands off to a fresh run that keeps the planner's model, because that model is the run's and not the call's.
	// On Claude the effort is the call's or the role's default, as it always was. On Pi the model and the level the run
	// recorded go together, because a level chosen for another model may be one this model does not offer.
	const carried: RouteDefaults =
		backend === "claude"
			? { ...fresh, ...(lastModel ? { model: lastModel } : {}) }
			: last.selection
				? { model: last.selection.model, effort: last.selection.effort, from: `the plan run ${last.handle} hands off from` }
				: fresh;
	return { backend, role, handle: next, handoff: { from: last.handle, reason: { kind: "cap", share } }, call, defaults: carried };
}

/** What a Pi binding falls back on for a route: the defaults it settled on, named after where they came from. */
function piFallback(route: FusionRoute): PiFallback {
	const { model, effort, from } = route.defaults;
	const name = route.role;
	// The role's own variables, as this instance captured them: the binding's own fallback over those values.
	if (from === undefined) return variableFallback(name, { [piModelVariable(name)]: model, [piEffortVariable(name)]: effort } as NodeJS.ProcessEnv);
	return {
		...(model ? { model: { value: model, from } } : {}),
		...(effort ? { effort: { value: effort, from } } : {}),
		missing: `role ${name} has no model for the pi backend in ${from}: choose a provider and a model id, such as deepseek/deepseek-chat, with /fusion config, or name one in the call's model parameter. The pi backend has no default model and resolves none for you`,
	};
}

/**
 * The role a route runs, bound by the backend it routes to: each backend's binding owns its own model and effort
 * rules. A continued run's binding reads the selection that run actually ran with, which is what a Pi continuation
 * repeats rather than resolving its model again against whatever is configured now.
 */
export function fusionRole(route: FusionRoute): HostRole {
	if (route.backend === "claude") return roleFor(route.call, route.defaults);
	return piRole(route.call, route.record?.selection, process.env, piFallback(route));
}

/** The run a fusion call starts or continues, with the role its backend bound for it. */
export function fusionCall(params: FusionParams, records: RunRecords, planPct: number = planContextPct(), config?: Configuration): FusionCall {
	const route = fusionRoute(params, records, planPct, config);
	return { ...route, bound: fusionRole(route) };
}

/**
 * The claude tool's own route: the shared one with the backend forced, so nothing infers Pi from a call or a record.
 * A Pi run is continued through fusion, which knows its backend and the selection it has to repeat. A role the
 * configuration puts on Pi is run on Claude here as any call naming the other backend is: on the legacy defaults.
 */
export function claudeRoute(params: ClaudeParams, records: RunRecords, planPct: number = planContextPct(), config?: Configuration): FusionRoute {
	const prior = params.continue === undefined ? undefined : records.runs.get(params.continue);
	if (prior?.backend === "pi") throw new Error(`${prior.handle} ran on the pi backend, which the claude tool does not run; continue it with fusion and continue ${prior.handle}`);
	// A fresh call's role is checked against the four this tool advertises before the shared route reads a capability:
	// a role that runs on Pi alone is one this tool does not know, and saying so is what it has always done.
	if (params.continue === undefined && params.role !== undefined) claudeRoleName(params.role);
	return fusionRoute({ ...params, backend: claudeBackend.name }, records, planPct, config);
}

/** The run a claude call starts or continues, with the Claude role it binds. Throws on anything the call cannot use. */
export function claudeCall(
	params: ClaudeParams,
	records: RunRecords,
	planPct: number = planContextPct(),
	config?: Configuration,
): { role: Role; handle: string; record?: RunRecord; handoff?: Handoff } {
	const route = claudeRoute(params, records, planPct, config);
	return {
		role: roleFor(route.call, route.defaults),
		handle: route.handle,
		...(route.record === undefined ? {} : { record: route.record }),
		...(route.handoff === undefined ? {} : { handoff: route.handoff }),
	};
}

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

/** Dollars as the dashboard shows them: cents are too coarse for a single cheap call. */
function formatUsd(n: number): string {
	return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** Why a claude call is refused once this Pi session's estimated cost has reached PI_FUSION_BUDGET_LIMIT_USD. */
export function budgetBlockMessage(block: { limitUsd: number; costUsd: number }): string {
	return `the runs of this Pi session have cost an estimated ${formatUsd(block.costUsd)}, at or over the PI_FUSION_BUDGET_LIMIT_USD limit of ${formatUsd(block.limitUsd)}; no new run starts and no run is continued. Active runs are not cancelled; wait for them, message them or cancel them with fusion_control. The estimate uses list prices and updates when a child turn ends, so it can lag; raise or unset the variable and restart Pi to start runs again`;
}

/**
 * How to reach the child's session again, in its own backend's terms. The backend is the one the run went through,
 * named by the caller and never inferred from the fields: a Pi run that ended before it verified a reference can
 * still carry a scalar session id as a diagnostic, and `claude --resume` on such an id names a session the Claude
 * CLI cannot open. Only a Claude run's flat id is a resume command, and only a verified Pi reference names a file.
 * That reference is passed in, never read off the snapshot: what a child claimed in progress and what an outcome
 * the host refused carried are both on the snapshot, and neither is a path anyone may be handed.
 */
function sessionHint(run: { sessionId?: string } | undefined, ref: SessionRef | undefined, backend: BackendName): string[] {
	if (ref?.backend === "pi") return [`pi session ${ref.sessionFile}`];
	return backend === "claude" && run?.sessionId ? [`claude --resume ${run.sessionId}`] : [];
}

function stats(handle: string, run: HostRun, backend: BackendName, ref: SessionRef | undefined): string {
	const secs = Math.round(run.ms / 1000);
	const parts = [`${handle} · ${run.role.name} · ${run.role.model} · ${secs}s · ${run.toolCalls} tool calls · in ${formatTokens(run.tokensIn)} out ${formatTokens(run.tokensOut)}`];
	const { contextTokens, contextWindow } = run;
	if (contextTokens && contextWindow) parts.push(`context ${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${sharePercent(contextTokens / contextWindow)})`);
	if (run.workflowTokens) parts.push(`workflow agents ${formatTokens(run.workflowTokens)} tokens`);
	if (run.deniedTools?.length) parts.push(`denied: ${[...new Set(run.deniedTools)].join(", ")}`);
	parts.push(...sessionHint(run, ref, backend));
	return parts.join(" · ");
}

function failureDetail(run: HostRun): string {
	const fromError = run.errorMessage?.trim();
	if (fromError) return fromError;
	const stderrLines = run.stderr
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
	const errorLines = stderrLines.filter((line) => !line.startsWith("Warning:"));
	const detail = errorLines.length ? errorLines : stderrLines;
	if (detail.length) return detail.slice(-5).join("\n");
	return run.text.trim();
}

export function failureMessage(run: HostRun): string {
	const name = run.role.name;
	if (run.aborted) return run.activity ? `${name} aborted while ${run.activity}` : `${name} aborted`;
	const outcome = run.signal
		? `${name} killed by ${run.signal}`
		: run.exitCode !== 0
			? `${name} ${run.exitCode === null ? "did not start" : `exited ${run.exitCode}`}`
			: run.abandonedTasks?.length
				? `${name} exited with ${run.abandonedTasks.join(", ")} still running`
				: run.stopReason === "error"
					? `${name} model error`
					: run.stopReason === undefined
						? `${name} produced no response`
						: `${name} ended with stopReason ${run.stopReason}`;
	const detail = failureDetail(run);
	return detail ? `${outcome}: ${detail}` : outcome;
}

/** The primary pair of tools, and the compatibility pair that forces the Claude backend. Both act on the same runs. */
const TOOL_NAME = "fusion";
const CONTROL_TOOL_NAME = "fusion_control";
const CLAUDE_TOOL_NAME = "claude";
const CLAUDE_CONTROL_NAME = "claude_control";
/** The workflow tools: every tool off hides from the host, so no route to a run is left beside the guards. */
const FUSION_TOOLS: readonly string[] = [TOOL_NAME, CONTROL_TOOL_NAME, CLAUDE_TOOL_NAME, CLAUDE_CONTROL_NAME];
/** The mode tools, one per direction: only the one that leaves the current mode is ever active, and neither starts a run. */
const ACTIVATE_NAME = "fusion_activate";
const DEACTIVATE_NAME = "fusion_deactivate";
const MODE_TOOLS: readonly string[] = [ACTIVATE_NAME, DEACTIVATE_NAME];
/** What a call or review that would start a run is told while fusion is off. */
const FUSION_OFF = "fusion is off; turn it on with /fusion on, or ask for Fusion by name";
const NOTICE_TYPE = "pi-fusion-run";
/** What a run notice is about: the run itself, or what the user did to it. */
const NOTICE_LABELS = new Map([
	["steer", "user steer"],
	["answer", "user answer"],
	["review", "user review"],
]);
/** What became of a run whose Pi process ended while it was still going: nobody was left to finish it. */
const HISTORY_ABORTED = "aborted when the earlier Pi process ended";
/** How long a going run's record may stay as it is on disk, on top of the write every turn that spent tokens gets. */
const HISTORY_SPEND_MS = 15_000;
const SUMMARY_CHARS = 600;
const CONTROL_ACTIONS = ["status", "wait", "message", "cancel"] as const;

type RunState = "running" | "waiting" | "done" | "failed" | "aborted" | "cancelled";

interface OpenQuestion {
	id: string;
	text: string;
	answer: (text: string) => void;
	drop: (error: Error) => void;
	/** Who answered it, so whoever arrives second can be told who was first. */
	answered?: { by: "user" | "host"; text: string; at: number };
}

/** What answering a run gave: a question is answered once, so a second caller in the same tick gets ok false. */
type Answered = { ok: true; question: OpenQuestion; next?: OpenQuestion } | { ok: false };

/** What started a run: the claude tool, a review the user asked for, or a review this extension started on its own. */
export type RunOrigin = "tool" | "review" | "auto-review";

/** What a review needs of the run it reads, so a run of this Pi process and one the history kept both fit. */
interface ReviewTarget {
	handle: string;
	role: string;
	state: string;
	prompt: string;
	report?: string;
	failure?: string;
	files?: ReadonlyArray<ChangedFile>;
	/** The working directory the run was made in, when that is not this one: a review reads the tree the run changed. */
	madeIn?: string;
	/** Links the source to the review that reads it, wherever the source is kept. */
	markReviewed(handle: string): void;
}

/** What a finished run records: why its outcome could not be recorded at all, and the write itself, once its state lands. */
interface RecordedRun {
	invalid?: string;
	commit(): void;
}

/** A run this Pi process started, from its start to its end, foreground or background. */
interface LiveRun {
	/** The run's id in the dashboard store. */
	id: string;
	handle: string;
	role: HostRole;
	/** The prompt the child was started with. */
	prompt: string;
	origin: RunOrigin;
	/** The handle of the latest independent review of this run. */
	reviewedBy?: string;
	/** For a review run, the handle of the run it reviews. */
	reviews?: string;
	background: boolean;
	started: number;
	endedAt?: number;
	state: RunState;
	input: ChildControl;
	controller: AbortController;
	cancelled: boolean;
	cancelledBy?: "user" | "host";
	/**
	 * The latest snapshot of the child: its last progress report while it works, and the outcome it returned once it
	 * has, because that outcome is what the run actually spent and did. What a backend reports as it returns is not
	 * required to come through the progress stream, so a host that kept the last progress would show and keep less
	 * than the run cost. No structured session reference is read from here; only `verified` says what the host checked.
	 * A Claude run's flat session id is the one exception, read off this snapshot as it always was.
	 */
	latest?: HostRun;
	cwd: string;
	before?: Snapshot;
	report?: string;
	failure?: string;
	/**
	 * What the backend said its ending left behind, for a run this host cancelled: fixed text the backend composed and
	 * this host only carries, kept because a cancelled run's own failure line is composed here rather than read off the
	 * outcome. It is never read as progress and never parsed; it is the backend's sentence, already in `failure`.
	 */
	cleanupNotice?: string;
	stats?: string;
	/** What the host must read with this run's outcome, such as the plan handoff that gave the run its own handle. */
	note?: string;
	files?: ChangedFile[];
	/** What the run had changed when the render last sampled it, and when that was, while it is still running. */
	filesSampledAt?: number;
	filesSampled?: ChangedFile[];
	/** The child's open questions, oldest first; the run is waiting while there is one. */
	questions: OpenQuestion[];
	/** The answer the user gave the run's last question, until the host has been told about it. */
	userAnswer?: { questionId: string; text: string; at: number; acknowledged: boolean };
	/** True once a tool result carried the outcome, so no completion notice repeats it. */
	delivered: boolean;
	/** Called once when the run ends or opens a question. */
	waiters: Set<() => void>;
	/** The user's own observers of those events; unlike a waiter, one never keeps the run's notice from the host. */
	watchers: Set<() => void>;
	/** True once the run's entry is recorded and its report delivered, which is after its state turns terminal. */
	finished: boolean;
	/**
	 * What the host validated about the session this run ended in, set once its outcome has been decided and only
	 * then: the reference and the selection a monitor and the history may keep. What a child reported while it was
	 * still working is never this, however complete that looked; nor is the outcome of a run that failed a session
	 * postcondition, one whose decision threw before it reached one, or one whose backend threw instead of returning.
	 */
	verified?: { ref?: SessionRef; selection?: ResolvedSelection };
	/** The Pi tool that started the run, the id of its call, and the Pi session that made it, for the history. */
	tool?: string;
	toolCallId?: string;
	hostSessionId?: string;
	title: string;
	/** The backend the child runs in, which decides how its session is named wherever this run is shown. */
	backend: BackendName;
	session: HostSession;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
	ended: Promise<void>;
}

const isActive = (run: LiveRun | undefined): boolean => run?.state === "running" || run?.state === "waiting";

/** What the run changed: the list it ended with, or the sample the render took while it was still going. */
function runFiles(run: LiveRun): ChangedFile[] | undefined {
	return run.files ?? (isActive(run) ? run.filesSampled : undefined);
}

/** What every card about a run reads: bounded, and the same wherever a run's details go. */
function runDetails(run: LiveRun): CardDetails {
	const files = runFiles(run);
	const question = run.state === "waiting" ? run.questions[0]?.text : undefined;
	return {
		handle: run.handle,
		role: run.role.name,
		model: run.role.model,
		state: run.state,
		background: run.background,
		elapsedMs: (run.endedAt ?? Date.now()) - run.started,
		...(run.latest?.costUsd === undefined ? {} : { costUsd: run.latest.costUsd }),
		...(files === undefined ? {} : { filesChanged: files.length, ...(files.length ? { files: files.slice(0, CARD_FILES).map((file) => file.path) } : {}) }),
		...(run.reviewedBy === undefined ? {} : { reviewedBy: run.reviewedBy }),
		...(run.reviews === undefined ? {} : { reviews: run.reviews }),
		...(question === undefined ? {} : { question: question.slice(0, CARD_QUESTION_CHARS) }),
	};
}

/** What the editor widget says about an active run. */
function widgetRun(run: LiveRun): WidgetRun {
	const files = runFiles(run);
	return {
		handle: run.handle,
		role: run.role.name,
		...(run.reviews === undefined ? {} : { reviews: run.reviews }),
		state: run.state,
		elapsedMs: Date.now() - run.started,
		toolCalls: run.latest?.toolCalls ?? 0,
		...(run.latest?.activity === undefined ? {} : { activity: run.latest.activity }),
		...(files === undefined ? {} : { filesChanged: files.length }),
		...(run.questions[0] === undefined ? {} : { question: run.questions[0].text }),
	};
}

/** What the body of a card needs of a run's details, so a renderer passes on the details it already read. */
function bodyOf(details: CardDetails): { question?: string; handle?: string; files?: string[]; filesChanged?: number } {
	return {
		...(details.question === undefined ? {} : { question: details.question }),
		...(details.handle === undefined ? {} : { handle: details.handle }),
		...(details.files === undefined ? {} : { files: details.files }),
		...(details.filesChanged === undefined ? {} : { filesChanged: details.filesChanged }),
	};
}

/** The card a render slot already has, refilled, or a new one: Pi keeps the component it was given last time. */
function reuse(context: { lastComponent?: unknown }, header: string, lines: string[], mode: CardMode = "wrap"): Card {
	const last = context.lastComponent;
	if (!(last instanceof Card)) return new Card(header, lines, mode);
	last.setMode(mode);
	last.setHeader(header);
	last.setLines(lines);
	return last;
}

/** A collapsed card cuts its lines: a report written as paragraphs would otherwise fill the transcript. */
function cardMode(expanded: boolean): CardMode {
	return expanded ? "wrap" : "truncate";
}

/** A tool argument as a card shows it: anything but a string reads as nothing, because a render must never throw. */
function argText(value: unknown): string {
	return typeof value === "string" ? plainText(value) : "";
}

/** The card a finished delegation or control call shows, whichever of the tool names made it: the run's header over its report, files and question. */
function resultCard(
	label: string,
	result: { content?: unknown; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: CardTheme,
	context: { lastComponent?: unknown; isError?: boolean },
): Card {
	const text = resultText(result.content);
	// firstLine leaves the text as the host reads it, so a card strips the child's activity here, where it is drawn.
	if (options.isPartial) return reuse(context, theme.fg("muted", firstLine(plainText(text))), []);
	const details = cardDetails(result.details);
	// A tool that threw returns no details, so the row's own error state is all that names what became of the run.
	if (!details.state && context.isError) details.state = "failed";
	return reuse(context, headerLine(theme, { label, details }), bodyLines(theme, text, { expanded: options.expanded, ...bodyOf(details) }), cardMode(options.expanded));
}

function activityLine(run: LiveRun): string {
	const secs = Math.round((Date.now() - run.started) / 1000);
	const latest = run.latest;
	if (run.state === "waiting") return `${run.handle} ${run.role.name} · ${secs}s · waiting for an answer`;
	if (!latest) return `${run.handle} ${run.role.name} · ${secs}s · starting`;
	return `${run.handle} ${run.role.name} · ${secs}s · ${latest.toolCalls} tool calls${latest.activity ? ` · ${plainText(latest.activity)}` : ""}`;
}

function statusLine(run: LiveRun): string {
	const secs = Math.round(((run.endedAt ?? Date.now()) - run.started) / 1000);
	const question = run.questions[0] ? `\n  question: ${firstLine(run.questions[0].text)}` : "";
	const reviews = run.reviews ? ` · review of ${run.reviews}` : "";
	const share = contextShare(run.latest);
	const context = share === undefined ? "" : ` · context ${sharePercent(share)}`;
	return `${run.handle} · ${run.role.name} · ${run.role.model} · ${run.state}${run.background ? " · background" : ""} · ${secs}s${context}${reviews}${question}`;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > ACTIVITY_CHARS * 2 ? `${line.slice(0, ACTIVITY_CHARS * 2)}…` : line;
}

function askedText(run: LiveRun): string {
	return `${run.handle} (${roleText(run)}) asks:\n\n${run.questions[0]?.text ?? ""}\n\nThe run waits in the background until you answer with fusion_control message and run ${run.handle}. Ask the user first if the decision is theirs.`;
}

/** How a run names itself in its reports: a review names the run it reviews, because its handle alone says nothing. */
function roleText(run: LiveRun): string {
	return run.reviews ? `${run.role.name}, review of ${run.reviews}` : run.role.name;
}

/** What a run's final text adds once a review of it has started, so whoever reads the report knows one is coming. */
function reviewLine(handle: string): string {
	return `${handle} reviews this run in the background; its report arrives as a message.`;
}

function finalText(run: LiveRun): string {
	const body = run.state === "done" ? run.report?.trim() || "(no output)" : run.failure ?? run.state;
	const reviewed = run.reviewedBy ? `\n\n${reviewLine(run.reviewedBy)}` : "";
	const note = run.note ? `${run.note}\n\n` : "";
	return `${note}${run.handle} (${roleText(run)}) ${run.state}.\n\n${body}${run.stats ? `\n\n[${run.stats}]` : ""}${reviewed}`;
}

/** The record of a run no process is running any more, or undefined when the record already ended: a run still going when its Pi process ended was finished by nobody. */
function asEnded(held: HistoryRecord): HistoryRecord | undefined {
	if (held.state !== "running" && held.state !== "waiting") return undefined;
	return { ...held, state: "aborted", endedAt: held.endedAt ?? held.startedAt, failure: HISTORY_ABORTED };
}

/** Why the run the on-disk history kept cannot be reviewed, or undefined when it can be. */
function heldNotReviewable(held: HistoryRecord): string | undefined {
	return reviewable({ state: held.state, role: held.role, ...(held.files ? { files: held.files } : {}) });
}

/**
 * What a run of an earlier Pi process, as the history kept it, tells the user and the host: what it did and what is
 * left. `cwd` is where this Pi process runs, because a review reads the tree the run changed and no other.
 */
function heldText(held: HistoryRecord, branch: RunRecord | undefined, cwd: string): string {
	const secs = Math.round(((held.endedAt ?? held.startedAt) - held.startedAt) / 1000);
	const files = held.filesTotal ?? held.files?.length ?? 0;
	const body = (held.state === "done" ? held.report : held.failure)?.trim() ?? "";
	const lines = [`${held.handle} (${held.role}) ran in an earlier Pi process: ${held.state}, ${secs}s, ${files} changed files`];
	if (body) lines.push(body.length > SUMMARY_CHARS ? `${body.slice(0, SUMMARY_CHARS)}…` : body);
	// Only a run the branch recorded has a child session to resume; a run killed in flight recorded none, and a
	// record this host will not act on says why instead of offering a continuation the next call would refuse.
	if (branch?.refusal) lines.push(branch.refusal);
	else if (branch) lines.push(`continue it with ${continueWith(branch.backend ?? held.backend)} and continue ${held.handle}`);
	if (held.cwd === cwd && heldNotReviewable(held) === undefined) lines.push(`review it with /fusion review ${held.handle}`);
	return lines.join("\n");
}

function summary(run: LiveRun): string {
	const text = (run.state === "done" ? run.report : run.failure)?.trim() ?? "";
	return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

/** The tool that continues a run of this backend: a Pi run is only ever continued through the primary tool. */
const continueWith = (backend: string | undefined): string => (backend === "pi" ? TOOL_NAME : CLAUDE_TOOL_NAME);

function handleNumber(handle: string): number {
	return Number(HANDLE.exec(handle)?.[1] ?? 0);
}

const FUSION_ARGS = ["dashboard", "dashboard stop", "status", "cancel", "steer", "wait", "answer", "review", "on", "off", "config", "profile", "profile list", "profile use", "profile save", "profile default"];
const USAGE =
	"Usage: /fusion dashboard | /fusion dashboard stop | /fusion status [run-N] | /fusion cancel run-N | /fusion wait run-N | /fusion steer run-N <text> | /fusion answer [run-N] [text] | /fusion review run-N | /fusion on | /fusion off | /fusion config | /fusion profile [list | use <name> | save <name> | default <name>]";
const PROFILE_USAGE = "Usage: /fusion profile [list | use <name> | save <name> | default <name>]; builtin names the built-in configuration for use and default";
/** A /fusion profile argument list that names a profile, as far as it is typed, for completion. */
const PROFILE_ARG = /^profile\s+(use|save|default)\s+(\S*)$/;
/** A /fusion argument list that names a run, as far as it is typed, for completion. */
const RUN_ARG = /^(status|cancel|wait|steer|answer|review)\s+(\S*)$/;
const BROWSER_OPENER: Record<string, string> = { darwin: "open", linux: "xdg-open" };

/** What a /fusion argument list asks for. */
export type FusionCommand =
	| { kind: "dashboard" }
	| { kind: "dashboard-stop" }
	| { kind: "on" }
	| { kind: "off" }
	| { kind: "status"; handle?: string }
	| { kind: "cancel" | "wait" | "review"; handle: string }
	| { kind: "steer"; handle: string; text: string }
	| { kind: "answer"; handle?: string; text?: string }
	| { kind: "config" }
	| { kind: "profile" }
	| { kind: "profile-list" }
	| { kind: "profile-use"; name: string }
	| { kind: "profile-save"; name: string }
	| { kind: "profile-default"; name: string }
	| { kind: "usage"; message: string };

/** The command a /fusion argument list names, or the usage when it names none. */
export function parseFusion(args: string): FusionCommand {
	const usage: FusionCommand = { kind: "usage", message: USAGE };
	const text = args.trim();
	const tokens = text ? text.split(/\s+/) : [];
	const [first, second] = tokens;
	if (first === "dashboard") {
		if (tokens.length === 1) return { kind: "dashboard" };
		return tokens.length === 2 && second === "stop" ? { kind: "dashboard-stop" } : usage;
	}
	if (first === "config") return tokens.length === 1 ? { kind: "config" } : usage;
	if (first === "profile") {
		if (tokens.length === 1) return { kind: "profile" };
		if (second === "list") return tokens.length === 2 ? { kind: "profile-list" } : { kind: "usage", message: PROFILE_USAGE };
		if ((second === "use" || second === "save" || second === "default") && tokens.length === 3) {
			const name = tokens[2]!;
			// builtin is a configuration to use or start with, never a name to save under.
			const problem = second === "save" || name !== BUILTIN ? nameProblem(name) : undefined;
			if (problem) return { kind: "usage", message: `${problem}. ${PROFILE_USAGE}` };
			return second === "use" ? { kind: "profile-use", name } : second === "save" ? { kind: "profile-save", name } : { kind: "profile-default", name };
		}
		return { kind: "usage", message: PROFILE_USAGE };
	}
	if (first === "on") return tokens.length === 1 ? { kind: "on" } : usage;
	if (first === "off") return tokens.length === 1 ? { kind: "off" } : usage;
	if (first === "status") {
		if (tokens.length === 1) return { kind: "status" };
		return tokens.length === 2 && HANDLE.test(second) ? { kind: "status", handle: second } : usage;
	}
	if (first === "cancel" || first === "wait" || first === "review") return tokens.length === 2 && HANDLE.test(second) ? { kind: first, handle: second } : usage;
	if (first === "steer") {
		const parts = /^steer\s+(\S+)\s+([\s\S]+)$/.exec(text);
		const steer = parts?.[2].trim();
		return parts && HANDLE.test(parts[1]) && steer ? { kind: "steer", handle: parts[1], text: steer } : usage;
	}
	if (first === "answer") {
		if (tokens.length === 1) return { kind: "answer" };
		const rest = text.slice(first.length).trim();
		if (!HANDLE.test(second)) return { kind: "answer", text: rest };
		const reply = rest.slice(second.length).trim();
		return { kind: "answer", handle: second, ...(reply ? { text: reply } : {}) };
	}
	return usage;
}

/** Best effort: a browser that will not start must not fail the command or reach the session as an unhandled error. */
function openInBrowser(url: string): void {
	const opener = BROWSER_OPENER[process.platform];
	if (!opener) return;
	try {
		const browser = spawn(opener, [url], { stdio: "ignore", detached: true });
		browser.on("error", () => {});
		browser.unref();
	} catch {}
}

/**
 * How the host routes work to a delegation tool, in that tool's own names: the primary tool and its control tool
 * carry the fusion names; compatibility guidance sends Pi-routed roles through fusion rather than silently overriding
 * the profile. What a role runs on is said in the description; a disabled role is not
 * recommended anywhere here, and one guideline says it is refused.
 */
const guidelines = (tool: string, control: string, roles: RoleSettings, options: { backend: boolean }): string[] => {
	const on = (role: KnownRoleName): boolean => roles[role].enabled;
	const roleTool = (role: KnownRoleName): string => !options.backend && roles[role].backend === "pi" ? TOOL_NAME : tool;
	const planTool = roleTool("plan");
	const implementTool = roleTool("implement");
	const askTool = roleTool("ask");
	const lines: string[] = [`These ${tool} guidelines apply while Fusion is on, as it is now; once the user has turned Fusion off they no longer apply and you work directly.`];
	const piRoles = options.backend ? [] : ROLE_NAMES.filter((role) => on(role) && roles[role].backend === "pi");
	if (piRoles.length) lines.push(`This session routes ${piRoles.map((role) => `role ${role}`).join(", ")} to pi. Use fusion for these roles unless the user explicitly asks for Claude Code: ${tool} forces the claude backend and uses this instance's legacy Claude defaults instead of the configured Pi settings.`);
	if (on("plan")) {
		lines.push(
			`Call ${planTool} with role plan, giving the goal, a short plan, constraints and what is already decided, when the design is unresolved: more than one viable approach, unclear requirements, a change to a shared contract or interface, or risk you cannot bound by reading the code. Treat the returned agreed plan as the contract and its Route section as a recommendation. Skip role plan when you can already state what to change, where, the acceptance criteria and how to verify it.`,
			`Leave ${planTool}'s model unset for role plan, which runs it on its configured model. Later plan calls keep the plan run's model; name another model only when the user asks for one, which starts a fresh plan run that carries the plan so far.`,
			`A ${planTool} call with role plan continues the last plan run while that run's context stays under its cap, 35% of the window by default, and while the call names the model that run is on. Past the cap, or when the call names another model, it starts a fresh plan run that carries the last report, the plan agreed so far, instead of the transcript behind it, and the result says which run replaced which. A fresh run past the cap keeps the plan run's model. Keep working with the fresh run: state anything the earlier run knew and its report does not say, and call ${planTool} with continue and the older handle only when you need what it dropped.`,
		);
	}
	lines.push(
		`A ${tool} call with continue is never handed off, because you named the run. Past the cap its result says so and names what a fresh run would take instead; act on that when the next step can stand on its own, and keep continuing the run while it cannot.`,
		`You orchestrate ${tool} runs and do not implement: delegate implementation in dependency order, pass earlier results on as context, check each report against the task's acceptance criteria before the next task${on("ask") ? `, and review the change with ${askTool} role ask and mode review` : ""}; do not edit files yourself. When a run fails, report its failure message rather than doing the task yourself.`,
	);
	if (on("implement") || on("ultracode")) {
		const implement = on("implement")
			? `Send every implementation task to ${implementTool} with role implement, however complex or risky: one clear, bounded task at a time, straight from the user's request when no design question is open, or task by task from a plan that role plan agreed.`
			: `Role implement is disabled, so send implementation to ${tool} with role ultracode only when the user asks for it, and otherwise tell the user it needs role implement.`;
		const ultracode = on("ultracode")
			? ` Use ${tool} with role ultracode only when the user explicitly asks for ultracode, even when a Route section recommends it; then give it the whole agreed plan in one call, expect it to be slow, and treat its report's Review section as a self-review by agents it briefed. Role ultracode runs its agents one at a time so builds and tests do not overlap, so do not ask it for parallel work.`
			: "";
		lines.push(`${implement}${ultracode}`);
	}
	if (on("implement")) {
		lines.push(
			`When a ${implementTool} role implement report has an Escalation section, do not re-send or widen the task yourself. Keep what it changed and verified, then ${on("plan") ? `take the design question to ${planTool} with role plan or the broader work to` : "take broader work to"} a new ${implementTool} role implement run, with the report as context.${on("plan") ? "" : " For a design question, tell the user role plan is disabled."}`,
		);
	}
	lines.push(
		options.backend
			? `The user's explicit choice wins over these ${tool} guidelines, including asking for or skipping role plan and asking for role ultracode. A backend, model or effort the user names goes in ${tool}'s backend, model or effort parameter; otherwise leave all three unset, which runs each role on this session's configured defaults.`
			: `The user's explicit choice wins over these ${tool} guidelines, including asking for or skipping role plan and asking for role ultracode. For an explicit ${tool} call, put a model or effort the user names in its model or effort parameter; otherwise leave both unset to use the role's configured Claude settings, or this instance's legacy Claude defaults when the role is configured on Pi.`,
	);
	if (on("ask")) {
		lines.push(
			`Use ${askTool} with role ask to answer a question about the code or its dependencies without changing files, instead of reading many files yourself, and with role ask and mode review for an independent review of a change, naming the diff or files and what the change must do. Role ask runs read-only tools and returns an answer or ranked findings with file and line references; it never implements.`,
		);
	}
	lines.push(
		`To follow up on an earlier ${tool} run, such as a test that still fails after an implementation, call ${tool} with continue set to its handle and the follow-up as task instead of starting a new run; the child keeps its context. Start a new run when the work is unrelated.`,
		`Call ${tool} with background true when the run will take long and you have other work or the user wants to keep talking, such as a long implementation; the call returns the handle at once and the report arrives later as a message. Tell the user the handle, so they can follow the run with /fusion. Only one run that can change files is active at a time, but role ask runs can go next to it. Use ${control} status to check a run, wait to block on its report, message to steer it, and cancel to stop it. A message to a run that has ended is not sent; decide from the returned report whether to continue the run with ${tool} continue or leave it.`,
		`A ${tool} child can ask you a question while it works. The ${tool} call, a ${control} wait or a message then gives you the question, and the run waits in the background, keeping its context, until you answer with ${control} message. Answer it yourself when the conversation already settles it; otherwise ask the user and pass on their answer. Do not start or continue another run that can change files while it waits.`,
		`A ${tool} child does not commit, whatever it changed. Commit only when the user asks you to.`,
		`Report to the user which ${tool} roles you used and why, what role plan agreed when it ran, what each implementation changed and how it was verified, ${on("ask") ? "and what a review found" : "and that no independent review ran because role ask is disabled"}; give the resume command or session file each run's stats line names, so the user can reach the child again, and summarize rather than pasting the child reports verbatim.`,
	);
	const disabled = KNOWN_ROLE_NAMES.filter((role) => !on(role) && (options.backend || role !== "security"));
	if (disabled.length) {
		lines.push(
			`This session's configuration disables ${disabled.map((role) => `role ${role}`).join(", ")}: a ${tool} call to a disabled role is refused, whether it starts a run or continues one. Do not call one; when the work needs it, tell the user, who can enable it with /fusion config or another profile.`,
		);
	}
	return lines;
};

/**
 * The one guideline the compatibility tool cannot carry, because it advertises no backend parameter at all: which
 * harness a run goes to is the user's to name, so the tool that takes that name is the only one told where it goes.
 */
const backendGuideline = (tool: string): string =>
	`When the user names the harness a task is to run on, pass that name in ${tool}'s backend parameter; leave backend unset otherwise, which runs the role on the backend this session's configuration names for it. A harness the role does not run on is refused before anything starts. A run on the pi backend is the other reason to set ${tool}'s model parameter: a pi role with no model configured needs a provider and model id there.`;

/**
 * The other guideline only the primary tool carries, because it is the only one that advertises the role: `security`
 * is the user's to ask for, enabled or not. Nothing here lets the host decide that work looks security-sensitive and
 * route it there on its own, and the task is where the authorization to change application code comes from.
 */
const securityGuideline = (tool: string, setting: RoleSetting): string =>
	`Use ${tool} with role security only when the user asks for a security investigation, audit or fix: never on your own judgement that some work looks security-sensitive, where role implement, role ultracode or role ask with mode review is what you use instead. Say in the task whether fixes are authorized, and what is in scope; a security task that does not say reports findings and changes no application code. Role security runs on the pi backend alone, ${setting.model ? `on ${setting.model} unless the user names another model` : `and this session configures no model for it, so it needs a provider and model id in ${tool}'s model parameter or one chosen with /fusion config`}, and like role implement it takes the single active file-changing slot.`;

/** How a role's setting reads in a description: where a fresh run of it goes and what it runs as there. */
const settingText = (role: KnownRoleName, setting: RoleSetting): string => {
	if (!setting.enabled) return `${role} is disabled`;
	const model = setting.model ? `model ${setting.model}` : "no model configured";
	const effort = role === "ultracode" || !setting.effort ? "" : ` at effort ${setting.effort}`;
	return `${role} runs on ${setting.backend} with ${model}${effort}`;
};

/** The configuration as the fusion tool says it: every role, its backend, model and effort, or that it is disabled. */
const configurationText = (roles: RoleSettings): string => `In this session's configuration ${KNOWN_ROLE_NAMES.map((role) => settingText(role, roles[role])).join("; ")}.`;

/**
 * What the claude tool runs each of its roles as: the configured setting for a role this session runs on Claude, and
 * the legacy Claude defaults for one it runs on Pi, which is what a call naming the other backend gets.
 */
const claudeConfigurationText = (config: Configuration): string =>
	`In this session's configuration ${ROLE_NAMES.map((role) => {
		const setting = config.roles[role];
		const claude: RoleSetting = setting.backend === "claude" ? setting : { enabled: setting.enabled, backend: "claude", ...config.baseline[role].claude };
		return settingText(role, claude);
	}).join("; ")}.`;

/** A plain string enum: some providers reject the anyOf of consts that a union of literals becomes. */
const stringEnum = <T extends readonly string[]>(values: T, description: string) =>
	Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });

/** What this build of pi-fusion can run: the backends a host registers over the Claude and Pi ones it always has. */
export interface FusionOptions {
	/** The backends this runtime runs a child in, merged over this build's own. Nothing reads this from the user. */
	backends?: Partial<Record<BackendName, HostBackend>>;
	/**
	 * Where profiles are read and saved. Left out, it is the user's own `profiles.json` under the host agent directory,
	 * resolved on first use; every test host passes a store of its own so no case reads or writes that file.
	 */
	profiles?: ProfileStore;
}

export default function fusion(pi: ExtensionAPI, options: FusionOptions = {}) {
	// A Pi child of this extension is an ordinary Pi session, so it loads this extension too. Registering the delegation
	// tools inside a child would let a child delegate again, and its `/tree`, shutdown and dashboard machinery would run
	// beside the host's. `piLaunch` is the one thing that sets this marker and it sets it for a Pi child alone, so a host
	// never carries it; nothing is registered here, and the child is left with the tools its role names. Any other value
	// registers the ordinary surface, because a marker this build does not know is not a child of this build.
	if (process.env.PI_FUSION_CHILD === "pi") return;
	// Every contract any role of either backend can run under, in one check: the Claude roles' own, the ask modes' and
	// the Pi bindings', which is where a contract no Claude role names comes from. An install missing one of them is a
	// broken install whichever backend would have run it, so none of them waits for a call to find out.
	for (const name of new Set([...Object.values(ROLES).map((role) => role.contract), ...Object.values(ASK_CONTRACTS), ...PI_CONTRACT_FILES])) {
		const contract = path.join(CONTRACTS_DIR, name);
		if (!fs.existsSync(contract)) throw new Error(`pi-fusion: missing contract ${contract}`);
	}
	// Every Pi child is launched by running this one program, which ships beside the module that names it. An install
	// missing it could still route a call to Pi and would only find out once a child was being started, so it is read
	// here, beside the contracts and for the same reason: a backend this host cannot launch is a broken install.
	// Nothing in this host imports that program, which is what leaves this a refusal of its own: the two constants the
	// transport shares with a child come from `backends/pi-bootstrap-protocol.mjs` instead, so an absent child program
	// is caught here, after the contracts, rather than as node's own module error before a line of this ran. That
	// protocol module is not this check's business — it is one of this host's own sources, and an install missing one
	// of those cannot load this extension at all. What is checked is that one entry file and nothing else, and the
	// modules it imports are not all the child's: `pi-control-extension.mjs` reaches this host through
	// `backends/pi-session-restore.ts` and `pi-question-tool.mjs` through `backends/pi-launch.ts`, so an install
	// missing either fails as a module error of this host's own before `fusion()` runs at all. `pi-helper-retry.mjs`
	// is the one that is the child's alone: an install missing it passes this check and fails when the child starts.
	if (!fs.existsSync(PI_BOOTSTRAP_PATH)) throw new Error(`pi-fusion: missing pi bootstrap ${PI_BOOTSTRAP_PATH}`);

	/**
	 * The harnesses this runtime can run a child in: the Claude backend and the Pi one, both this build's own, with a
	 * host's own registration over either of them. Nothing reads a backend from the user, and a backend this build
	 * knows and a host left out is still recognized by records and by routing, so a call that would go there is
	 * refused with what happened instead of read as a Claude run.
	 */
	// A backend is reached by the name it is registered under, and it tags every record and every run with the name it
	// calls itself. Those two disagreeing would run a child on one backend and record it as another, so a registration
	// that disagrees is refused here, before a session is mapped, a child is started or an entry is written.
	for (const [key, registered] of Object.entries(options.backends ?? {})) {
		if (!registered) continue;
		if (!isBackendName(key)) throw new Error(`pi-fusion: ${shown(key)} is not a backend this build knows; use one of ${BACKEND_NAMES.join(", ")}`);
		if (registered.name !== key) throw new Error(`pi-fusion: the backend registered as ${key} calls itself ${shown(registered.name)}; a backend must be registered under its own name`);
	}
	// Constructing a Pi backend takes nothing: the factory reads no file, resolves no path and starts nothing, so a host
	// that never delegates to Pi pays for this line and no more.
	const backends: Partial<Record<BackendName, HostBackend>> = { claude: hostBackend(claudeBackend), pi: hostBackend(createPiBackend()), ...options.backends };

	/** Why a routed call goes nowhere: its backend is one this build knows and does not run, and nothing has started. */
	const unavailable = (backend: BackendName, what: string, continued: boolean): string => {
		// A key a host overrode with nothing is a backend it left out, not one it registered, so it is not offered here.
		// The test is truthiness rather than `!== undefined` on purpose: the types say the only way to leave a backend
		// out is `undefined`, but a host that is not compiled against them can pass `null`, and a null backend offered
		// as somewhere to take the work would be a lie that the next call turns into a crash.
		const names = Object.entries(backends).filter(([, registered]) => registered).map(([name]) => name);
		const why = `the ${backend} backend is not available in this build: ${what}, `;
		// A host that registered nothing at all has nowhere to send the work. Composing the ordinary sentence around an
		// empty list would say "runs  only" and "Take the work to  with a role it runs", so it is replaced rather than
		// filled in: the whole of what can be said is that nothing here runs this.
		if (names.length === 0) return `${why}and this pi-fusion runs no backend at all. Nothing was started and nothing was recorded. Nothing can run this here; no configuration makes ${backend} available here.`;
		const available = names.join(", ");
		const instead = continued ? `Read what that run reported and start a new run on ${available}` : `Take the work to ${available} with a role it runs, or do it yourself`;
		return `${why}and this pi-fusion runs ${available} only. Nothing was started and nothing was recorded. ${instead}; no configuration makes ${backend} available here.`;
	};

	/**
	 * The legacy defaults this instance started with, from a copy of the environment taken now: the built-in
	 * configuration, and what a call naming the other backend than the configured one runs on, for the instance's life.
	 */
	const baseline = captureBaseline({ ...process.env });
	/**
	 * What this session runs its roles as. It lives in this instance alone, like on and off: a reload or another host
	 * session loads the default profile again. A run reads it once, when it is admitted, and keeps what it bound.
	 */
	let configuration: Configuration = builtinConfiguration(baseline);
	const profileStore = options.profiles ?? hostProfileStore(hostAgentDir);
	/** The profiles file as the last read found it, for completion, which cannot wait for a read. */
	let knownProfiles: ProfileDocument | undefined;
	/** Why the default profile was not loaded at startup, said once where a notice can be shown. */
	let profileWarning: string | undefined;
	let initializing: Promise<void> | undefined;
	/** True once the startup load has settled, so a call after it registers its run without yielding to anything first. */
	let initialized = false;
	/** True once this session chose its settings itself, which a late startup load must not overwrite. */
	let chosen = false;

	/** Reads the profiles file, remembering what it held for completion. */
	const readProfiles = async (): Promise<ProfileDocument> => {
		const document = await profileStore.read();
		knownProfiles = document;
		return document;
	};

	/**
	 * Loads the default profile once per instance, before any run starts or any setting is applied: a call or a command
	 * that arrives first waits for it. A file that cannot be read, or a default it does not hold, leaves the built-in
	 * configuration and a warning; nothing is rewritten and nothing claims the broken profile was applied.
	 */
	const initialize = (): Promise<void> =>
		(initializing ??= (async () => {
			try {
				await loadDefault();
			} finally {
				initialized = true;
			}
		})());

	const loadDefault = async (): Promise<void> => {
		let document: ProfileDocument;
		try {
			document = await readProfiles();
		} catch (error) {
			profileWarning = `${error instanceof Error ? error.message : String(error)}; this session uses the ${BUILTIN} configuration`;
			return;
		}
		const name = document.defaultProfile;
		if (name === null || chosen) return;
		const settings = Object.hasOwn(document.profiles, name) ? document.profiles[name] : undefined;
		if (!settings) {
			profileWarning = `the default profile ${name} is not in ${await profileStore.where().catch(() => "the profiles file")}; this session uses the ${BUILTIN} configuration`;
			return;
		}
		try {
			applyConfiguration({ profile: name, modified: false, roles: copySettings(settings), baseline });
		} catch (error) {
			profileWarning = `the default profile ${name} was not applied: ${error instanceof Error ? error.message : String(error)}; this session uses the ${BUILTIN} configuration`;
		}
	};

	/** Says once, where a notice can be shown, that the default profile was not what this session started with. */
	const noteProfiles = (ctx: any): void => {
		if (profileWarning === undefined) return;
		const warning = profileWarning;
		profileWarning = undefined;
		record(() => ctx.ui.notify(`fusion: ${warning}`, "warning"));
	};

	/**
	 * Makes a configuration this session's, with the host's tool guidance in the same synchronous step, so the host is
	 * never told one configuration while calls run on another. A guidance refresh that throws puts both back.
	 */
	const applyConfiguration = (next: Configuration): void => {
		const previous = configuration;
		const activeTools = pi.getActiveTools();
		configuration = next;
		try {
			registerGuidance(true);
		} catch (error) {
			configuration = previous;
			try {
				registerGuidance(true);
			} catch {}
			// A failed restoration may have changed only part of the list; rollback must use the original snapshot.
			try {
				pi.setActiveTools(activeTools);
			} catch {}
			throw new Error(`the host's tool guidance did not change: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/**
	 * Applies settings to this session, or says why not. The unfinished-run check and the assignment share one synchronous
	 * block, the same rule /fusion off keeps, so a run admitted while a dialog was open or a file was read refuses it.
	 */
	const switchTo = (next: Configuration): string | undefined => {
		const names = unfinishedNames();
		if (names) return `fusion settings stay as they are while runs are unfinished: ${names}. Wait for each run or cancel it with /fusion cancel run-N, then retry.`;
		try {
			applyConfiguration(next);
		} catch (error) {
			return `fusion settings stay as they are: ${error instanceof Error ? error.message : String(error)}`;
		}
		chosen = true;
		return undefined;
	};

	const store = new RunStore();
	const ledger = new Ledger(budgetConfig());
	/** The variables that are set and name nothing their control can use, read where the ledger reads them: when Pi loads this. */
	const budgetTrouble = [...budgetProblems(), ...planProblems()];
	/** The share of its window, as a percentage, past which a plan run is handed off to a fresh one. */
	const planPct = planContextPct();
	let budgetNoted = false;
	/** Whether an implement, ultracode or security run that changed files gets an independent review without being asked. */
	const autoReview = process.env.PI_FUSION_AUTO_REVIEW?.trim() === "1";
	/** Whether this Pi session keeps its runs on disk, so a later process on the same host session can show them. */
	const historyOn = historyEnabled();
	let history: History | undefined;
	/** The runs an earlier Pi process left in this host session's file, the newest record per handle. */
	const historical = new Map<string, HistoryRecord>();
	const loadedHistory = new Set<string>();
	let historyWarned = false;
	/** The latest ctx a call gave this extension, so a completion, which is given none, can still read the branch. */
	let lastCtx: any;
	let dashboard: Promise<Dashboard> | undefined;

	/** Monitoring is never worth a failed tool call, so nothing the store does reaches the caller. */
	const record = (call: () => void): void => {
		try {
			call();
		} catch {}
	};

	/** Says once, on the first call of the process, that a budget variable turned its control off instead of setting it. */
	const noteBudget = (ctx: any): void => {
		if (budgetNoted || !budgetTrouble.length) return;
		budgetNoted = true;
		for (const trouble of budgetTrouble) record(() => ctx.ui.notify(`fusion: ${trouble}`, "warning"));
	};

	/** The session spend the dashboard header shows, with the thresholds that make it worth watching. */
	const sessionUsage = () => ({
		...ledger.totals(),
		warnUsd: ledger.config.warnUsd,
		...(ledger.config.limitUsd === undefined ? {} : { limitUsd: ledger.config.limitUsd }),
	});

	const openDashboard = (cwd: string): Promise<Dashboard> => {
		if (dashboard) return dashboard;
		const starting: Promise<Dashboard> = startDashboard(store, { cwd, usage: sessionUsage }).catch((error) => {
			if (dashboard === starting) dashboard = undefined;
			throw error;
		});
		dashboard = starting;
		return starting;
	};

	/** Closes a started dashboard, and a start still in flight once it has resolved, so no server is left listening. */
	const closeDashboard = async (): Promise<boolean> => {
		const starting = dashboard;
		dashboard = undefined;
		if (!starting) return false;
		try {
			await (await starting).close();
		} catch {}
		return true;
	};


	/** A history that cannot be read or written costs the user a list, never a run, so it is said once and dropped. */
	const warnHistory = (ctx: any, warning: string): void => {
		if (historyWarned) return;
		historyWarned = true;
		record(() => ctx.ui.notify(`fusion history: ${warning}`, "warning"));
	};

	/** The host session this Pi process is on, or none when the host cannot say, because no history call may fail. */
	const hostSession = (ctx: any): string | undefined => {
		try {
			const id = ctx.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * Writes runs into the file of the host session named, which is only ever one this runtime loaded: the file of an
	 * ancestor session is read and never written back, because a Pi process still on it would lose the records it wrote
	 * between this read and this rename. A run that started under a session id the host has since changed still lands
	 * in the file it started in. Several runs go in one call, because a write rewrites the whole file.
	 */
	const saveHistory = (ctx: any, hostSessionId: string | undefined, ...held: HistoryRecord[]): void => {
		if (!history || !held.length || !hostSessionId || !loadedHistory.has(hostSessionId)) return;
		record(() => {
			const trouble = history?.saveAll(hostSessionId, held[0]!.cwd, held);
			if (trouble?.warning) warnHistory(ctx, trouble.warning);
		});
	};

	/** The run as the history keeps it: what it was asked, what it did, and where its child session is. */
	const historyRecord = (run: LiveRun, state: RunState, child?: HostRun): HistoryRecord => ({
		id: run.id,
		handle: run.handle,
		role: run.role.name,
		...(run.role.mode === undefined ? {} : { mode: run.role.mode }),
		model: run.role.model,
		...(run.role.effort ? { effort: run.role.effort } : {}),
		hostSessionId: run.hostSessionId ?? "",
		cwd: run.cwd,
		...(run.tool === undefined ? {} : { tool: run.tool }),
		...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
		origin: run.origin,
		...(run.reviews === undefined ? {} : { reviews: run.reviews }),
		...(run.reviewedBy === undefined ? {} : { reviewedBy: run.reviewedBy }),
		state,
		...(run.background ? { background: true } : {}),
		startedAt: run.started,
		...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
		prompt: run.prompt,
		...(run.report === undefined ? {} : { report: run.report }),
		...(run.failure === undefined ? {} : { failure: run.failure }),
		...(run.files === undefined ? {} : { files: run.files, filesTotal: run.files.length }),
		// The flat id and checkpoint stay Claude's own, so a reader that only knows them never offers a resume for a Pi run.
		...(run.backend !== "claude" || child?.sessionId === undefined ? {} : { sessionId: child.sessionId }),
		...(run.backend !== "claude" || child?.checkpoint === undefined ? {} : { checkpoint: child.checkpoint }),
		backend: run.backend,
		// The structured reference and the selection come from the outcome the host validated, never from `child`,
		// which is only the latest snapshot of the run, progress while it works and its returned outcome after that: a
		// run still going has reported no result to keep, a record written mid-run that named one would come back from
		// a killed Pi process as a session nothing had checked, and a returned outcome may be one the decision refused.
		// The flat Claude fields above are the exception, and they still come from the snapshot as they always did.
		...(run.verified?.ref === undefined ? {} : { ref: run.verified.ref }),
		...(run.verified?.selection === undefined ? {} : { selection: run.verified.selection }),
		session: { ...run.session, backend: run.backend },
		contract: `contracts/${run.role.contract}`,
		title: run.title,
		...(child === undefined
			? {}
			: {
					usage: {
						...(child.costUsd === undefined ? {} : { costUsd: child.costUsd }),
						tokensIn: child.tokensIn,
						tokensOut: child.tokensOut,
						...(child.workflowTokens === undefined ? {} : { workflowTokens: child.workflowTokens }),
						toolCalls: child.toolCalls,
					},
				}),
	});

	/** Turns what an earlier Pi process left behind into what this one shows: its spend, its dashboard and its lookups. */
	const restoreHistory = (hostSessionId: string, ctx: any): void => {
		const loaded = history?.load(hostSessionId);
		if (!loaded) return;
		if (loaded.warning) warnHistory(ctx, loaded.warning);
		const corrected: HistoryRecord[] = [];
		for (const read of loaded.records) {
			const interrupted = asEnded(read);
			const held = interrupted ?? read;
			if (interrupted) corrected.push(interrupted);
			if (held.usage) ledger.update(held.id, held.usage);
			// A Pi run's verified selection names the effort its child confirmed, which a run that named none only learns there.
			const effort = held.selection?.effort ?? held.effort;
			store.restore({ ...held, ...(effort ? { effort } : {}) });
			historical.set(held.handle, held);
		}
		saveHistory(ctx, hostSessionId, ...corrected);
	};

	/**
	 * Loads this host session's runs from disk once per runtime, so a later Pi process on the same session shows what
	 * ran before it. A session Pi keeps no file for keeps no history, and nothing here is worth a failed call.
	 */
	const ensureHistory = (ctx: any): void => {
		lastCtx = ctx;
		if (!historyOn) return;
		let file: unknown;
		let hostSessionId: unknown;
		try {
			file = ctx.sessionManager?.getSessionFile?.();
			hostSessionId = ctx.sessionManager?.getSessionId?.();
		} catch {
			return;
		}
		if (typeof file !== "string" || typeof hostSessionId !== "string" || !hostSessionId || loadedHistory.has(hostSessionId)) return;
		loadedHistory.add(hostSessionId);
		history ??= new History(historyDir());
		record(() => restoreHistory(hostSessionId as string, ctx));
	};

	/** The runs the host branch remembers, or none when the host cannot say, because a completion must not fail. */
	const branchRuns = (ctx: any): Map<string, RunRecord> => {
		try {
			return runRecords(ctx.sessionManager.getBranch()).runs;
		} catch {
			return new Map();
		}
	};

	/**
	 * A record of the branch's run and the history's run are the same run when neither names another child session.
	 * A Pi identity is the session id and the session file together, and only a verified reference carries it: a
	 * scalar id a Pi child reported is a diagnostic and is never read here, an identity on one side and none on the
	 * other is not a match, and two runs with no identity at all still match, which is all a diagnostic needs. The
	 * Claude comparison is unchanged, flat id and all, because that is the identity every Claude reader uses.
	 */
	const sameChild = (held: HistoryRecord, branch: RunRecord): boolean => {
		const backend = held.backend ?? "claude";
		if (branch.backend !== undefined && backend !== branch.backend) return false;
		if (backend === "pi" || branch.backend === "pi") {
			const one = held.ref?.backend === "pi" ? held.ref : undefined;
			const other = branch.session?.backend === "pi" ? branch.session : undefined;
			if (!one || !other) return !one && !other;
			return one.sessionId === other.sessionId && one.sessionFile === other.sessionFile;
		}
		const one = held.ref?.sessionId ?? held.sessionId;
		const other = branch.session?.sessionId ?? branch.sessionId;
		return one === undefined || other === undefined || one === other;
	};

	/**
	 * What the history kept about a run the branch remembers and this process never started. A run of an ancestor host
	 * session, which is what a fork leaves behind, is read from that session's file and never written back to it.
	 */
	const heldRun = (handle: string, branch: RunRecord, ctx: any): HistoryRecord | undefined => {
		if (!history) return undefined;
		const current = hostSession(ctx);
		if (!branch.hostSessionId || branch.hostSessionId === current) {
			const held = historical.get(handle);
			return held && sameChild(held, branch) ? held : undefined;
		}
		const loaded = history.load(branch.hostSessionId);
		if (loaded.warning) warnHistory(ctx, loaded.warning);
		const held = [...loaded.records].reverse().find((entry) => entry.handle === handle && sameChild(entry, branch));
		// That session's file is another process's to correct, so a run it left going ends here and nowhere else.
		return held === undefined ? undefined : (asEnded(held) ?? held);
	};

	/** The runs this Pi process started, by handle. Pi builds a new extension runtime for every host session. */
	const runs = new Map<string, LiveRun>();
	let ui: { setStatus(key: string, text: string | undefined): void; setWidget?(key: string, lines: string[] | undefined): void } | undefined;
	let ticker: NodeJS.Timeout | undefined;
	let shuttingDown = false;
	/**
	 * Whether the host orchestrates: the one mode state. Every extension instance starts off, so a reload or another host
	 * session starts off again; it turns on only when the user asks, and off only while no run is unfinished, so off never
	 * strands a run the host cannot reach.
	 */
	let enabled = false;
	/** A tool activation gets one reminder after the host settles; a deliberate /fusion on needs none. */
	let activationReminder = false;
	/**
	 * The workflow tools on gives back and no other. The first is what the host had active before this instance first
	 * hid them, and each off takes the subset active at that moment; an empty subset is one, not a request for all four.
	 */
	let hidden: string[] = [];
	/** Whether the starting mask has been applied: once per instance, by whichever entry point binds the host first. */
	let masked = false;
	/** Whether the active runs also show over the editor; the footer status line stays either way. */
	const widgetOn = process.env.PI_FUSION_WIDGET?.trim() !== "0";

	const active = (): LiveRun[] => [...runs.values()].filter(isActive);

	/** The runs that have not finished, the ones still in their end path named as finishing, or undefined when none is. */
	const unfinishedNames = (): string | undefined => {
		const unfinished = [...runs.values()].filter((run) => !run.finished);
		return unfinished.length ? unfinished.map((run) => `${run.handle} (${run.role.name}${isActive(run) ? "" : ", finishing"})`).join(", ") : undefined;
	};

	/**
	 * The active list one mode leaves: the tools unrelated to Fusion as the host has them now, the saved workflow subset
	 * when on, and the one mode tool that leaves that mode, only when the host's registry offers it. A tool an allow list
	 * or an exclusion keeps out is never forced in: the slash command still switches modes without it.
	 */
	const modeTools = (current: readonly string[], on: boolean, workflow: readonly string[]): string[] => {
		const offered = new Set(pi.getAllTools().map((tool) => tool.name));
		const own = on ? DEACTIVATE_NAME : ACTIVATE_NAME;
		const kept = current.filter((name) => !FUSION_TOOLS.includes(name) && !MODE_TOOLS.includes(name));
		return [...new Set([...kept, ...(on ? workflow : []), ...(offered.has(own) ? [own] : [])])];
	};

	/** Sets the host's active list, and puts back the one it had when the host threw part way through the change. */
	const setTools = (next: string[], previous: string[]): void => {
		try {
			pi.setActiveTools(next);
		} catch (error) {
			try {
				pi.setActiveTools(previous);
			} catch {}
			throw error;
		}
	};

	/**
	 * Hides the workflow tools and shows the activation tool, once per instance, the first time the host's tool list is
	 * bound: at session_start, or at whichever command or tool call reaches this first, such as on a host that reloads
	 * with no session_start. The subset it hides is what the first on gives back. A host that cannot be read yet, or
	 * refuses the change, is tried again at the next entry point; nothing here can start a run while it is not applied.
	 */
	const mask = (): void => {
		if (masked) return;
		let current: string[];
		try {
			current = pi.getActiveTools();
			setTools(modeTools(current, false, []), current);
		} catch {
			return;
		}
		hidden = current.filter((name) => FUSION_TOOLS.includes(name));
		masked = true;
	};

	/** What a mode change came to: done, already so, refused for unfinished runs, or a host that would not change its tools. */
	type ModeOutcome = { kind: "changed" | "already" } | { kind: "unfinished"; names: string } | { kind: "failed"; reason: string };

	/**
	 * Turns orchestration on, for the command and the tool alike. Nothing here awaits, so the tool list and the mode
	 * change in one step; a call already made from the off guidance is refused by the guard, not by the tool list.
	 */
	const turnOn = (): ModeOutcome => {
		mask();
		if (enabled) return { kind: "already" };
		if (!masked) return { kind: "failed", reason: "the host's tool list cannot be read yet" };
		try {
			const current = pi.getActiveTools();
			setTools(modeTools(current, true, hidden), current);
		} catch (error) {
			return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
		}
		enabled = true;
		hidden = [];
		return { kind: "changed" };
	};

	/** Why off was refused, the same for the command and the tool; each adds how its own user retries. */
	const modeUnfinished = (names: string): string => `fusion stays on while runs are unfinished: ${names}.`;

	/** Turns orchestration off, for the command and the tool alike: the unfinished check and the switch share one step. */
	const turnOff = (): ModeOutcome => {
		mask();
		if (!enabled) return { kind: "already" };
		const names = unfinishedNames();
		if (names) return { kind: "unfinished", names };
		let workflow: string[];
		try {
			const current = pi.getActiveTools();
			workflow = current.filter((name) => FUSION_TOOLS.includes(name));
			setTools(modeTools(current, false, []), current);
		} catch (error) {
			return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
		}
		enabled = false;
		activationReminder = false;
		hidden = workflow;
		return { kind: "changed" };
	};

	/** Monitoring only: a host that cannot take the status or an update must not fail the run that renders. */
	const render = () => {
		const running = active();
		record(() => ui?.setStatus("fusion", running.length ? running.map(activityLine).join(" | ") : undefined));
		for (const run of running) record(() => run.onUpdate?.({ content: [{ type: "text", text: activityLine(run) }], details: {} }));
		if (widgetOn) {
			record(() => {
				const lines = widgetLines(undefined, running.map(widgetRun), ledger.config.warnUsd.length || ledger.config.limitUsd !== undefined ? sessionUsage() : undefined);
				ui?.setWidget?.("fusion", lines.length ? lines : undefined);
			});
		}
		for (const run of running) sampleFiles(run);
		if (running.length && !ticker) {
			ticker = setInterval(render, TICK_MS);
			ticker.unref();
		} else if (!running.length && ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	/** pi.sendMessage throws when this extension runtime is no longer the session's, which must not fail the caller. */
	const send = (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
		try {
			pi.sendMessage(message, options);
		} catch {}
	};

	const notify = (run: LiveRun, text: string) => {
		send(
			{ customType: NOTICE_TYPE, content: `Background run ${text}`, display: true, details: runDetails(run) },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	/** Calls the run's waiters and watchers and reports whether a waiter heard, so a notice goes out only when none did. */
	const settle = (run: LiveRun): boolean => {
		const waiters = [...run.waiters];
		const watchers = [...run.watchers];
		run.waiters.clear();
		run.watchers.clear();
		for (const listener of [...waiters, ...watchers]) listener();
		return waiters.length > 0;
	};

	const waitOn = (run: LiveRun, listeners: Set<() => void>, signal?: AbortSignal): Promise<boolean> =>
		new Promise((resolve) => {
			if (run.state !== "running") return resolve(true);
			const stop = () => {
				listeners.delete(done);
				resolve(false);
			};
			const done = () => {
				signal?.removeEventListener("abort", stop);
				resolve(true);
			};
			listeners.add(done);
			if (signal?.aborted) stop();
			else signal?.addEventListener("abort", stop, { once: true });
		});

	/** Resolves true when the run ends or opens a question, or false when the signal stops the wait first. */
	const settled = (run: LiveRun, signal?: AbortSignal): Promise<boolean> => waitOn(run, run.waiters, signal);

	/** The same wait for the user, which leaves the run's notice to the host. */
	const watched = (run: LiveRun, signal?: AbortSignal): Promise<boolean> => waitOn(run, run.watchers, signal);

	/**
	 * Answers the run's oldest open question, if the run still waits for one. Everything up to the resolve is
	 * synchronous, so of two callers in the same tick the first answers and the second is told there was nothing left
	 * to answer. A run that has ended keeps its questions until its end lands, and answering one of those would put the
	 * finished run back to running, so the state decides whether there is anything to answer, not the list.
	 */
	const answer = (run: LiveRun, text: string, by: "user" | "host"): Answered => {
		if (run.state !== "waiting") return { ok: false };
		const question = run.questions.shift();
		if (!question) return { ok: false };
		const at = Date.now();
		question.answered = { by, text, at };
		if (by === "user") run.userAnswer = { questionId: question.id, text, at, acknowledged: false };
		else delete run.userAnswer;
		question.answer(text);
		const next = run.questions[0];
		return { ok: true, question, ...(next ? { next } : {}) };
	};

	/**
	 * Raises the records' highest handle over the runs of this Pi process and the ones the history kept, so a new run
	 * never takes the name of a run that ended in no branch entry, which is what a Pi process killed mid-run leaves.
	 */
	const coverLiveHandles = (records: RunRecords): RunRecords => {
		for (const handle of [...runs.keys(), ...historical.keys()]) records.highest = Math.max(records.highest, handleNumber(handle));
		return records;
	};

	/** What a handle names now: a run of this Pi process, a run an earlier one left in the history, or neither. */
	const found = (handle: string, ctx: any): { run: LiveRun } | { held: HistoryRecord; branch?: RunRecord } | { gone: RunRecord } | { unknown: true } => {
		const run = runs.get(handle);
		if (run) return { run };
		const branch = branchRuns(ctx).get(handle);
		// A run its Pi process never saw end recorded no entry, so the history is all that still names it.
		if (!branch) {
			const held = historical.get(handle);
			return held ? { held } : { unknown: true };
		}
		const held = heldRun(handle, branch, ctx);
		return held ? { held, branch } : { gone: branch };
	};

	/** A run's last report, from this Pi process or from the history an earlier one left, for a plan handoff to carry. */
	const lastReport = (handle: string): string | undefined => {
		const live = runs.get(handle)?.report?.trim();
		if (live) return live;
		return historical.get(handle)?.report?.trim() || undefined;
	};

	/**
	 * The callback that records a finished run's session on the host branch, so a later call can continue it, and
	 * that says when the outcome named a session the run cannot have had. Such an outcome records nothing at all:
	 * the branch keeps whatever it held for the handle, and the run fails with what the postcondition was.
	 */
	const recordRun =
		(call: { handle: string; role: HostRole; backend: BackendName; hostSessionId: string; intent: SessionIntent; prior?: RunRecord }) =>
		(child: HostRun): RecordedRun => {
			const decision = recordDecision(
				{
					handle: call.handle,
					role: call.role.name,
					...(call.role.mode === undefined ? {} : { mode: call.role.mode }),
					backend: call.backend,
					hostSessionId: call.hostSessionId,
					intent: call.intent,
					// The model and effort the run was admitted with, defaults included: they are what a later call to this run
					// keeps, so switching profiles or changing a variable afterwards does not move a run it never chose.
					...(call.backend === "claude" ? { model: call.role.model, ...(call.role.effort ? { effort: call.role.effort } : {}) } : {}),
					...(call.prior === undefined ? {} : { prior: call.prior }),
				},
				{
					ok: !failed(child),
					// The flat id and checkpoint are the Claude identity; a Pi outcome is identified by its reference alone,
					// so a scalar id one carries stays a diagnostic and never reaches a record or a resume command.
					...(call.backend !== "claude" || child.sessionId === undefined ? {} : { sessionId: child.sessionId }),
					...(call.backend !== "claude" || child.checkpoint === undefined ? {} : { checkpoint: child.checkpoint }),
					...(child.session === undefined ? {} : { session: child.session }),
					...(child.selection === undefined ? {} : { selection: child.selection }),
					...(child.contextTokens === undefined ? {} : { contextTokens: child.contextTokens }),
					...(child.contextWindow === undefined ? {} : { contextWindow: child.contextWindow }),
				},
			);
			if ("invalid" in decision) return { invalid: decision.invalid, commit: () => {} };
			const entry = "entry" in decision ? decision.entry : undefined;
			// The entry is written where it always was, after the run's last snapshot, so /tree stays refused until then.
			return { commit: () => entry && pi.appendEntry(SESSION_ENTRY, entry) };
		};

	/** Adds a call's latest counters to the session ledger and warns the user once at each threshold the total passes. */
	const meter = (run: LiveRun, usage: CallUsage, ctx: any): void => {
		record(() => ledger.update(run.id, usage));
		for (let threshold = ledger.nextWarning(); threshold !== undefined; threshold = ledger.nextWarning()) {
			try {
				ctx.ui.notify(
					`fusion: the runs of this Pi session have cost an estimated ${formatUsd(ledger.totals().costUsd)} so far, past the ${formatUsd(threshold)} warning threshold (list prices; the estimate updates when a child turn ends, so it lags)`,
					"warning",
				);
			} catch {
				return;
			}
			ledger.markWarned(threshold);
		}
	};

	const startRun = async (call: {
		/** The Pi tool that started the run and the id of its call, when a tool did. */
		tool?: string;
		toolCallId?: string;
		role: HostRole;
		handle: string;
		prompt: string;
		origin: RunOrigin;
		/** For a review run, the handle of the run it reviews. */
		reviews?: string;
		/** What the host reads with the run's outcome, over the child's own report. */
		note?: string;
		/** The harness that runs the child, which the caller chose: this lifecycle is the same whichever one it is. */
		backend: HostBackend;
		session: HostSession;
		title: string;
		background: boolean;
		onUpdate: LiveRun["onUpdate"];
		ctx: any;
		/** Decides what the run's outcome records, before the run's state is fixed, and writes it once that state lands. */
		onRun: (run: HostRun) => RecordedRun;
	}): Promise<LiveRun> => {
		const { toolCallId, role, handle, prompt, session, title, ctx } = call;
		let hostSessionId: string | undefined;
		try {
			hostSessionId = ctx.sessionManager?.getSessionId() || undefined;
		} catch {}
		const run: LiveRun = {
			id: randomUUID(),
			handle,
			role,
			prompt,
			origin: call.origin,
			...(call.reviews === undefined ? {} : { reviews: call.reviews }),
			...(call.note === undefined ? {} : { note: call.note }),
			...(call.tool === undefined ? {} : { tool: call.tool }),
			...(toolCallId === undefined ? {} : { toolCallId }),
			...(hostSessionId === undefined ? {} : { hostSessionId }),
			title,
			backend: call.backend.name,
			session,
			background: call.background,
			started: Date.now(),
			state: "running",
			input: call.backend.control(),
			controller: new AbortController(),
			cancelled: false,
			cwd: ctx.cwd,
			questions: [],
			delivered: false,
			waiters: new Set(),
			watchers: new Set(),
			finished: false,
			...(call.onUpdate ? { onUpdate: call.onUpdate } : {}),
			ended: Promise.resolve(),
		};
		runs.set(handle, run);
		const id = run.id;
		record(() =>
			store.start({
				id,
				handle,
				backend: run.backend,
				role: role.name,
				model: role.model,
				...(role.effort ? { effort: role.effort } : {}),
				...(toolCallId === undefined ? {} : { toolCallId }),
				...(call.tool === undefined ? {} : { tool: call.tool }),
				origin: call.origin,
				...(call.reviews === undefined ? {} : { reviews: call.reviews }),
				...(hostSessionId === undefined ? {} : { hostSessionId }),
				prompt,
				contract: `contracts/${role.contract}`,
				title,
				session: { ...session, backend: run.backend },
				...(call.background ? { background: true } : {}),
			}),
		);
		saveHistory(ctx, run.hostSessionId, historyRecord(run, "running"));
		render();
		/** The control message that answered the last question returns the next one, so that one gets no notice. */
		const opened = (announce: boolean) => {
			run.state = "waiting";
			record(() => store.question(id, run.questions[0]!.text));
			render();
			if (!settle(run) && announce && run.background && !shuttingDown) notify(run, askedText(run));
		};
		const onQuestion: Ask = (text, signal) =>
			new Promise<string>((resolve, reject) => {
				if (signal.aborted) return reject(new Error(`${role.name} stopped`));
				const onAbort = () => question.drop(new Error(`${role.name} stopped`));
				const question: OpenQuestion = {
					id: randomUUID(),
					text,
					answer: (reply) => {
						signal.removeEventListener("abort", onAbort);
						resolve(reply);
						if (run.questions.length) opened(false);
						else {
							run.state = "running";
							record(() => store.question(id, undefined));
							render();
						}
					},
					drop: (error) => {
						signal.removeEventListener("abort", onAbort);
						run.questions = run.questions.filter((open) => open !== question);
						reject(error);
					},
				};
				signal.addEventListener("abort", onAbort, { once: true });
				// A new question is not the one the user answered, so their answer no longer describes the run.
				delete run.userAnswer;
				run.questions.push(question);
				if (run.questions.length === 1) opened(true);
			});
		const before = canChangeFiles(role.name) ? await snapshot(ctx.cwd) : undefined;
		run.before = before;
		/** Monitoring only: a git failure leaves the file list out and never fails the run. */
		const files = async () => {
			const after = before && (await snapshot(ctx.cwd));
			if (!before || !after) return {};
			try {
				return { files: await changedFiles(before, after) };
			} catch {
				return {};
			}
		};
		/** What the run had spent when the history last took it, so a Pi process killed mid-run loses little of its cost. */
		let spent = { at: 0, tokens: 0 };
		const saveSpend = () => {
			const tokens = (run.latest?.tokensIn ?? 0) + (run.latest?.tokensOut ?? 0);
			const now = Date.now();
			if (tokens === spent.tokens && now - spent.at < HISTORY_SPEND_MS) return;
			spent = { at: now, tokens };
			saveHistory(ctx, run.hostSessionId, historyRecord(run, run.state, run.latest));
		};
		run.ended = (async () => {
			try {
				let child: HostRun;
				try {
					child = await call.backend.run({
						role,
						prompt,
						cwd: ctx.cwd,
						session,
						title,
						signal: run.controller.signal,
						input: run.input,
						onQuestion,
						onProgress: (progress) => {
							run.latest = progress;
							meter(run, progress, ctx);
							record(() => store.progress(id, progress));
							saveSpend();
							render();
						},
						onEvent: (event) => record(() => store.event(id, event)),
					});
				} catch (error) {
					// A backend that threw returned no outcome, so the last progress stays this run's latest snapshot:
					// what the child had already spent is what is known about it, and nothing replaces it.
					run.failure = error instanceof Error ? error.message : String(error);
					run.state = "failed";
					const changed = await files();
					if (changed.files) run.files = changed.files;
					record(() => store.finish(id, { status: "failed", failure: run.failure!, ...changed }));
					return;
				}
				// The outcome is the run's latest snapshot as well as what it is metered on: it is what the run ended up
				// spending and doing, whether or not this backend also announced it as progress. A backend that shares
				// one record between its progress and its outcome, as the Claude one does, was already here.
				run.latest = child;
				meter(run, child, ctx);
				// What the outcome records is decided here, because an outcome naming a session the run cannot have had is itself a failure.
				let recorded: RecordedRun = { commit: () => {} };
				let decided = false;
				try {
					recorded = call.onRun(child);
					decided = true;
				} catch {}
				// What may be published as this run's session is what the decision just accepted, read from the returned
				// outcome by the same grammar the record was written with. A decision that refused the outcome, and one
				// that threw before it reached a verdict, leave it unset: neither checked what the child claimed.
				if (decided && !recorded.invalid) {
					const ref = keptRef(child.session, run.backend);
					const selection = keptSelection(child.selection, run.backend);
					run.verified = { ...(ref === undefined ? {} : { ref }), ...(selection === undefined ? {} : { selection }) };
				}
				// A cancelled run's line is this host's own, so nothing the outcome says about the child's own ending would
				// otherwise reach anyone: `failureMessage` is never called for one. The backend's `cleanupNotice` is
				// carried whole and appended once, here, which is why every reader downstream takes `run.failure` as it is.
				if (run.cancelled && child.cleanupNotice !== undefined) run.cleanupNotice = child.cleanupNotice;
				const failure = run.cancelled
					? `${role.name} cancelled${run.cancelledBy === "user" ? " by the user" : ""}${run.cleanupNotice === undefined ? "" : `; ${run.cleanupNotice}`}`
					: failed(child)
						? failureMessage(child)
						: recorded.invalid;
				run.state = run.cancelled ? "cancelled" : child.aborted ? "aborted" : failure !== undefined ? "failed" : "done";
				run.report = child.text;
				run.stats = stats(handle, child, run.backend, run.verified?.ref);
				if (failure !== undefined) run.failure = failure;
				const changed = await files();
				if (changed.files) run.files = changed.files;
				// The session the monitor names is the one this host validated when it decided what to record: a failed
				// or cancelled fork's own child and a first call's diagnostic identity count, and an outcome that failed
				// a postcondition does not, so nothing a run only claimed becomes a transcript path anyone can copy.
				const verified = run.verified?.ref;
				record(() =>
					store.finish(id, {
						status: run.state as Exclude<RunState, "running" | "waiting">,
						text: child.text,
						...(failure === undefined ? {} : { failure }),
						snapshot: child,
						...(verified === undefined ? {} : { ref: verified }),
						// A backend that mirrors this notice into the activity of its own outcome — which the Pi one does,
						// because a cancelled run is shown its activity and nothing else — would otherwise leave the monitor
						// showing the same sentence twice: once in the failure composed above and once as the line the run
						// was on. Only this branch sets it, and `run.cleanupNotice` is set nowhere but the cancelled one.
						...(run.cleanupNotice === undefined ? {} : { clearActivity: true }),
						...changed,
					}),
				);
				try {
					recorded.commit();
				} catch {}
			} finally {
				for (const question of [...run.questions]) question.drop(new Error(`${role.name} ended`));
				run.endedAt = Date.now();
				saveHistory(ctx, run.hostSessionId, historyRecord(run, run.state, run.latest));
				render();
				// Before the run settles, so the report the host reads already names the review that reads the same tree.
				record(() => startAutoReview(run, ctx));
				const heard = settle(run);
				if (run.background && !heard && !run.delivered && !shuttingDown) notify(run, finalText(run));
				run.finished = true;
			}
		})();
		return run;
	};

	/** Why the live run cannot be reviewed, or undefined when it can be. */
	const notReviewable = (run: LiveRun): string | undefined => reviewable({ state: run.state, role: run.role.name, ...(run.files ? { files: run.files } : {}) });

	/** The run a review reads: one this Pi process started, or one an earlier process left in the history. */
	const liveSource = (run: LiveRun, ctx: any): ReviewTarget => ({
		handle: run.handle,
		role: run.role.name,
		state: run.state,
		prompt: run.prompt,
		...(run.report === undefined ? {} : { report: run.report }),
		...(run.failure === undefined ? {} : { failure: run.failure }),
		...(run.files === undefined ? {} : { files: run.files }),
		markReviewed: (handle) => {
			run.reviewedBy = handle;
			record(() => store.reviewed(run.id, handle));
			saveHistory(ctx, run.hostSessionId, historyRecord(run, run.state, run.latest));
		},
	});

	const heldSource = (held: HistoryRecord, ctx: any): ReviewTarget => ({
		handle: held.handle,
		role: held.role,
		state: held.state,
		prompt: held.prompt,
		...(held.cwd === ctx.cwd ? {} : { madeIn: held.cwd }),
		...(held.report === undefined ? {} : { report: held.report }),
		...(held.failure === undefined ? {} : { failure: held.failure }),
		...(held.files === undefined ? {} : { files: held.files }),
		markReviewed: (handle) => {
			held.reviewedBy = handle;
			saveHistory(ctx, held.hostSessionId, held);
		},
	});

	/**
	 * Starts an independent review of a run that has ended: a background ask child that the run never briefed. It
	 * checks and takes its handle synchronously, before startRun's first await, so the run it returns is already in
	 * `runs` and no other run can take the same handle in between.
	 */
	const startReview = (source: ReviewTarget, origin: "review" | "auto-review", ctx: any): { run: LiveRun } | { refused: string } => {
		if (!enabled) return { refused: FUSION_OFF };
		if (source.madeIn) return { refused: `${source.handle} was made in ${source.madeIn}, not in this working directory; review it from there` };
		// Refused before the budget is read, a handle is taken, the source is linked to a review or any child starts.
		const reason = reviewable({ state: source.state, role: source.role, ...(source.files ? { files: source.files } : {}) });
		if (reason) return { refused: `${source.handle} ${reason}` };
		// A review is a fresh ask run, so the ask role's own setting decides whether there is one at all: the role of the
		// run it reads does not, and neither does anything that run recorded.
		if (!configuration.roles.ask.enabled) return { refused: `role ask is disabled in profile ${configurationLabel(configuration)}, so nothing reviews ${source.handle}; change /fusion config or select another profile` };
		const blocked = ledger.blocked();
		if (blocked) return { refused: budgetBlockMessage(blocked) };
		const handle = `run-${coverLiveHandles(runRecords(ctx.sessionManager.getBranch())).highest + 1}`;
		const hostSessionId: string = ctx.sessionManager.getSessionId();
		// Every review runs where this session runs role ask, on its configured model and effort, whatever the source was.
		const route: FusionRoute = {
			backend: configuration.roles.ask.backend,
			role: "ask",
			handle,
			call: { role: "ask", task: "", mode: "review" },
			defaults: freshDefaults("ask", configuration.roles.ask.backend, configuration),
		};
		const backend = backends[route.backend];
		if (!backend) return { refused: unavailable(route.backend, `${handle} would review ${source.handle}`, false) };
		// A binding that refuses the reviewer is this review's refusal and not the run's: nothing has started yet.
		let role: HostRole;
		try {
			role = fusionRole(route);
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			return { refused: `${handle} would review ${source.handle}, and its reviewer could not be bound: ${why.length > SUMMARY_CHARS ? `${why.slice(0, SUMMARY_CHARS)}…` : why}` };
		}
		const intent: SessionIntent = { kind: "new" };
		const session = backend.session(intent);
		const prompt = reviewPrompt({
			handle: source.handle,
			role: source.role,
			state: source.state === "done" ? "done" : "failed",
			task: source.prompt,
			report: source.report ?? "",
			...(source.failure === undefined ? {} : { failure: source.failure }),
			files: source.files ?? [],
		});
		// Nobody awaits a review, so a failure in its start reaches the user as a notice, not an unhandled rejection.
		void startRun({
			tool: `fusion ${origin}`,
			role,
			handle,
			prompt,
			origin,
			reviews: source.handle,
			backend,
			session,
			title: `pi-fusion ${handle} ask review of ${source.handle} · host ${hostSessionId}`,
			background: true,
			onUpdate: undefined,
			ctx,
			onRun: recordRun({ handle, role, backend: backend.name, hostSessionId, intent }),
		}).catch((error) => {
			record(() => ctx.ui.notify(`fusion: ${handle} did not start: ${error instanceof Error ? error.message : String(error)}`, "warning"));
		});
		// A start that threw before it registered its run left nothing behind, so the source keeps no link to it.
		const started = runs.get(handle);
		if (!started) return { refused: `${handle} could not start` };
		source.markReviewed(handle);
		return { run: started };
	};

	/** The review a run that changed files gets on its own, when the user turned automatic reviews on and role ask is enabled. */
	const startAutoReview = (run: LiveRun, ctx: any): void => {
		if (!enabled || !autoReview || !configuration.roles.ask.enabled || run.origin !== "tool" || run.state !== "done" || run.reviewedBy || shuttingDown) return;
		if (notReviewable(run)) return;
		const started = startReview(liveSource(run, ctx), "auto-review", ctx);
		if ("refused" in started) ctx.ui.notify(`fusion: auto-review of ${run.handle} did not start: ${started.refused}`, "warning");
	};

	/** The finished result of a foreground run, as the claude tool returns it. */
	const outcome = (run: LiveRun) => {
		if (run.state !== "done") throw new Error(run.stats ? `${run.failure}\n\n[${run.stats}]` : run.failure);
		const child = run.latest;
		const reviewed = run.reviewedBy ? `\n\n${reviewLine(run.reviewedBy)}` : "";
		const note = run.note ? `${run.note}\n\n` : "";
		return {
			content: [{ type: "text" as const, text: `${note}${run.report?.trim() || "(no output)"}\n\n[${run.stats}]${reviewed}` }],
			details: {
				...runDetails(run),
				handle: run.handle,
				role: run.role.name,
				model: run.role.model,
				...(run.reviewedBy ? { reviewedBy: run.reviewedBy } : {}),
				ms: (run.endedAt ?? Date.now()) - run.started,
				toolCalls: child?.toolCalls,
				tokensIn: child?.tokensIn,
				tokensOut: child?.tokensOut,
				workflowTokens: child?.workflowTokens,
				deniedTools: child?.deniedTools,
				// Only a Claude run's flat id is one anything may resume, so only such a run forwards it to the host.
				...(run.backend === "claude" && child?.sessionId !== undefined ? { sessionId: child.sessionId } : {}),
				sessionUsage: ledger.totals(),
			},
		};
	};

	/** Monitoring only: what a running run has changed, sampled at most every FILE_SAMPLE_MS and never waited for. */
	const sampleFiles = (run: LiveRun): void => {
		if (!run.before || run.files) return;
		const now = Date.now();
		if (run.filesSampledAt !== undefined && now - run.filesSampledAt < FILE_SAMPLE_MS) return;
		run.filesSampledAt = now;
		void currentFiles(run)
			.then((files) => {
				if (files) run.filesSampled = files;
			})
			.catch(() => {});
	};

	const currentFiles = async (run: LiveRun): Promise<ChangedFile[] | undefined> => {
		if (run.files || !run.before) return run.files;
		try {
			const after = await snapshot(run.cwd);
			return after ? await changedFiles(run.before, after) : undefined;
		} catch {
			return undefined;
		}
	};

	/** What a control status action reports about one run. */
	const runStatus = async (run: LiveRun): Promise<string[]> => {
		const lines = [statusLine(run)];
		if (run.state === "running" && run.latest?.activity) lines.push(`activity: ${run.latest.activity}`);
		lines.push(`tool calls: ${run.latest?.toolCalls ?? 0}`);
		const files = await currentFiles(run);
		if (files) lines.push(files.length ? `changed files:\n${files.map((file) => `${file.status} ${file.path}`).join("\n")}` : "changed files: none");
		return lines;
	};

	/** What the runs of this Pi session have cost so far, with the thresholds that act on it, for /fusion status. */
	const usageLine = (): string => {
		const totals = ledger.totals();
		const parts = [
			`session usage: est. ${formatUsd(totals.costUsd)} · in ${formatTokens(totals.tokensIn)} out ${formatTokens(totals.tokensOut)} tokens · workflow agents ${formatTokens(totals.workflowTokens)} tokens · ${totals.calls} calls`,
		];
		if (ledger.config.warnUsd.length) parts.push(`warn at ${ledger.config.warnUsd.map((threshold) => formatUsd(threshold)).join(", ")}`);
		if (ledger.config.limitUsd !== undefined) parts.push(`limit ${formatUsd(ledger.config.limitUsd)}`);
		return parts.join(" · ");
	};

	/** The dismissals of the /fusion waits now on screen, so a closing session can take them down. */
	const waits = new Set<() => void>();

	/** Shows the run's activity until it settles or the user presses Esc, which it reports as true. */
	const watchInTui = (run: LiveRun, ctx: any): Promise<boolean> =>
		ctx.ui.custom((tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, _keybindings: unknown, done: (escaped: boolean) => void) => {
			const stop = new AbortController();
			const ticker = setInterval(() => tui.requestRender(), TICK_MS);
			ticker.unref();
			const finish = (escaped: boolean) => {
				if (stop.signal.aborted) return;
				stop.abort();
				clearInterval(ticker);
				waits.delete(dismiss);
				done(escaped);
			};
			const dismiss = () => finish(false);
			waits.add(dismiss);
			void watched(run, stop.signal).then((heard) => {
				if (heard) finish(false);
			});
			return {
				render: (width: number) => [truncateToWidth(activityLine(run), width), truncateToWidth(theme.fg("dim", `Esc leaves ${run.handle} running`), width)],
				handleInput: (data: string) => {
					if (matchesKey(data, "escape")) finish(true);
				},
				invalidate: () => {},
				dispose: () => clearInterval(ticker),
			};
		});

	/**
	 * The runs of earlier Pi processes this branch can still name, oldest handle first, without the ones now live. A
	 * handle the branch gave another child is that child's; a handle the branch never recorded is the history's alone,
	 * because a run whose Pi process died in flight recorded nothing.
	 */
	const heldRuns = (ctx: any): HistoryRecord[] => {
		if (!historical.size) return [];
		const branch = branchRuns(ctx);
		return [...historical.values()]
			.filter((held) => {
				const record = branch.get(held.handle);
				return !runs.has(held.handle) && (record === undefined || sameChild(held, record));
			})
			.sort((left, right) => handleNumber(left.handle) - handleNumber(right.handle));
	};

	/** The working directory of the last call, or undefined when the host cannot say, because a completion must not fail. */
	const lastCwd = (): string | undefined => {
		try {
			return lastCtx?.cwd;
		} catch {
			return undefined;
		}
	};

	/** The handles a /fusion argument can still name: any for status, active for cancel and wait, running for steer, waiting for answer, reviewable for review. Status and review also name the runs an earlier Pi process left. */
	const completable = (kind: string): string[] => {
		const handles = (list: LiveRun[]) => list.map((run) => run.handle);
		const held = lastCtx ? heldRuns(lastCtx) : [];
		if (kind === "status") return [...handles([...runs.values()]), ...held.map((run) => run.handle)];
		if (kind === "steer") return handles([...runs.values()].filter((run) => run.state === "running"));
		if (kind === "answer") return handles([...runs.values()].filter((run) => run.state === "waiting"));
		if (kind === "review") {
			// A review of an earlier process's run reads the tree that run changed, so only one made here is offered.
			const here = lastCwd();
			const offered = held.filter((run) => run.cwd === here && heldNotReviewable(run) === undefined);
			return [...handles([...runs.values()].filter((run) => notReviewable(run) === undefined)), ...offered.map((run) => run.handle)];
		}
		return handles(active());
	};

	/** The profiles a list shows, built-in first, each marked as this session's selection and as the future default. */
	const profileLines = (document: ProfileDocument): string[] => {
		const startup = document.defaultProfile ?? BUILTIN;
		return [BUILTIN, ...Object.keys(document.profiles).sort()].map((name) => {
			const marks = [
				...(configuration.profile === name ? [configuration.modified ? "current, modified" : "current"] : []),
				...(startup === name ? ["default for new sessions"] : []),
			];
			return `${name}${marks.length ? ` (${marks.join("; ")})` : ""}`;
		});
	};

	/** The configuration as /fusion config shows it: where it came from, what future sessions start with, and every role. */
	const configurationLines = async (): Promise<string[]> => {
		let startup: string;
		try {
			startup = (await readProfiles()).defaultProfile ?? BUILTIN;
		} catch (error) {
			startup = `unknown (${error instanceof Error ? error.message : String(error)})`;
		}
		const where = await profileStore.where().catch(() => "unknown");
		return [`fusion configuration: ${configurationLabel(configuration)} · new sessions start with ${startup}`, ...settingsTable(configuration.roles), `profiles file: ${where}`];
	};

	/** The roles a configuration disables, as a notice ends with them, so a switch says what it turned off. */
	const disabledText = (roles: RoleSettings): string => {
		const off = KNOWN_ROLE_NAMES.filter((role) => !roles[role].enabled);
		return off.length ? `; disabled: ${off.join(", ")}` : "";
	};

	/** Loads a saved profile, or the built-in configuration, into this session; the file is read again for it. */
	const useProfile = async (name: string, notice: (text: string, level: "info" | "warning" | "error") => void): Promise<void> => {
		const early = unfinishedNames();
		if (early) {
			notice(`fusion settings stay as they are while runs are unfinished: ${early}. Wait for each run or cancel it with /fusion cancel run-N, then retry.`, "warning");
			return;
		}
		let next: Configuration;
		if (name === BUILTIN) next = builtinConfiguration(baseline);
		else {
			let document: ProfileDocument;
			try {
				document = await readProfiles();
			} catch (error) {
				notice(`profile ${name} was not loaded: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			const settings = Object.hasOwn(document.profiles, name) ? document.profiles[name] : undefined;
			if (!settings) {
				notice(`unknown profile ${name}; the profiles are ${[BUILTIN, ...Object.keys(document.profiles).sort()].join(", ")}`, "warning");
				return;
			}
			next = { profile: name, modified: false, roles: copySettings(settings), baseline };
		}
		const refused = switchTo(next);
		if (refused) {
			notice(refused, "warning");
			return;
		}
		notice(`fusion uses profile ${name} in this session${disabledText(next.roles)}`, "info");
	};

	/** The model a role's setting takes in the editor: one of the host's available models or one typed, or none for Pi. */
	const pickModel = async (ctx: any, role: KnownRoleName, setting: RoleSetting): Promise<string | null | undefined> => {
		if (setting.backend === "claude") {
			const typed = await ctx.ui.input(`Claude model for ${role}: an alias or id`, setting.model ?? "");
			return typed?.trim() || undefined;
		}
		// The host's own list of models it has credentials for, read and never fetched. A child resolves its model against
		// Fusion's own catalog, so a model offered here can still be one a child refuses when it starts.
		let available: string[] = [];
		try {
			available = (ctx.modelRegistry?.getAvailable?.() ?? []).map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`).filter((model: string) => isPiModel(model));
		} catch {}
		const TYPE = "Type a provider/model id…";
		const NONE = "Unconfigured";
		const choice = await ctx.ui.select(`Pi model for ${role}`, [...available, TYPE, NONE]);
		if (choice === undefined) return undefined;
		if (choice === NONE) return null;
		if (choice !== TYPE) return choice;
		const typed = (await ctx.ui.input(`Pi model for ${role}: a provider and model id`, "deepseek/deepseek-chat"))?.trim();
		if (!typed) return undefined;
		if (!isPiModel(typed)) {
			ctx.ui.notify(`${typed} is not a provider and model id such as deepseek/deepseek-chat; the model is unchanged`, "warning");
			return undefined;
		}
		return typed;
	};

	/** Edits one role of a draft in place, field by field, until the user goes back to the table. */
	const editRole = async (ctx: any, role: KnownRoleName, draft: RoleSettings): Promise<void> => {
		for (;;) {
			const setting = draft[role];
			const options = [
				`enabled: ${setting.enabled ? "yes" : "no"}`,
				`backend: ${setting.backend}`,
				`model: ${setting.model ?? "unconfigured"}`,
				role === "ultracode" ? `effort: ${ULTRACODE_EFFORT} (fixed)` : `effort: ${setting.effort ?? (setting.backend === "pi" ? "child default" : "none")}`,
				"Back",
			];
			const choice = await ctx.ui.select(`fusion config · ${role}`, options);
			if (choice === undefined || choice === "Back") return;
			const field = options.indexOf(choice);
			if (field === 0) draft[role] = { ...setting, enabled: !setting.enabled };
			else if (field === 1) {
				const backends = ROLE_SPECS[role].backends;
				if (backends.length === 1) {
					ctx.ui.notify(`role ${role} runs on ${backends[0]} alone`, "info");
					continue;
				}
				const backend = await ctx.ui.select(`Backend for ${role}`, [...backends]);
				// A model and an effort are one backend's own, so a new backend starts from its own defaults, not the old one's.
				if (isBackendName(backend) && backend !== setting.backend) draft[role] = { enabled: setting.enabled, backend, ...baseline[role][backend] };
			} else if (field === 2) {
				const model = await pickModel(ctx, role, setting);
				if (model === null) {
					const { model: _, ...rest } = setting;
					draft[role] = rest;
				} else if (model !== undefined) draft[role] = { ...setting, model };
			} else if (field === 3 && role !== "ultracode") {
				const DEFAULT = "child default";
				const efforts = [...effortsFor(role, setting.backend), ...(setting.backend === "pi" ? [DEFAULT] : [])];
				const effort = await ctx.ui.select(`Effort for ${role} on ${setting.backend}`, efforts);
				if (effort === DEFAULT) {
					const { effort: _, ...rest } = setting;
					draft[role] = rest;
				} else if (effort !== undefined) draft[role] = { ...setting, effort };
			}
		}
	};

	/**
	 * The editor: a table of roles over select and input dialogs. Every edit goes into a draft, and nothing reaches the
	 * session until Apply, which checks the whole draft and then the unfinished runs again; Cancel leaves it as it was.
	 */
	const editConfiguration = async (ctx: any, notice: (text: string, level: "info" | "warning" | "error") => void): Promise<void> => {
		const early = unfinishedNames();
		if (early) {
			notice(`fusion settings stay as they are while runs are unfinished: ${early}. Wait for each run or cancel it with /fusion cancel run-N, then retry.`, "warning");
			return;
		}
		const draft = copySettings(configuration.roles);
		for (;;) {
			const rows = settingsTable(draft);
			const APPLY = "Apply";
			const CANCEL = "Cancel";
			const choice = await ctx.ui.select(`fusion config · ${configurationLabel(configuration)}\n${rows[0]}`, [...rows.slice(1), APPLY, CANCEL]);
			if (choice === undefined || choice === CANCEL) {
				notice("fusion config cancelled; nothing changed", "info");
				return;
			}
			if (choice === APPLY) {
				let roles: RoleSettings;
				try {
					roles = parseSettings(draft);
				} catch (error) {
					notice(`these settings cannot be applied: ${error instanceof Error ? error.message : String(error)}`, "warning");
					continue;
				}
				if (sameSettings(roles, configuration.roles)) {
					notice("fusion config: nothing changed", "info");
					return;
				}
				const refused = switchTo({ profile: configuration.profile, modified: true, roles, baseline });
				if (refused) {
					notice(refused, "warning");
					return;
				}
				notice(`fusion settings applied to this session${disabledText(roles)}; save them with /fusion profile save <name>`, "info");
				return;
			}
			const role = KNOWN_ROLE_NAMES[rows.slice(1).indexOf(choice)];
			if (role) await editRole(ctx, role, draft);
		}
	};

	/** What /fusion config and /fusion profile do. Each reads the profiles file again rather than trusting a copy. */
	const configure = async (
		command: Extract<FusionCommand, { kind: "config" | "profile" | "profile-list" | "profile-use" | "profile-save" | "profile-default" }>,
		ctx: any,
		notice: (text: string, level: "info" | "warning" | "error") => void,
	): Promise<void> => {
		const dialogs = ctx.hasUI !== false && typeof ctx.ui?.select === "function";
		if (command.kind === "config") {
			if (dialogs) await editConfiguration(ctx, notice);
			else notice((await configurationLines()).join("\n"), "info");
			return;
		}
		if (command.kind === "profile-use") return useProfile(command.name, notice);
		if (command.kind === "profile-save") {
			let roles: RoleSettings;
			try {
				roles = parseSettings(copySettings(configuration.roles));
			} catch (error) {
				notice(`this session's settings cannot be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			let replaced = false;
			try {
				knownProfiles = await profileStore.update((document) => {
					replaced = Object.hasOwn(document.profiles, command.name);
					return { ...document, profiles: { ...document.profiles, [command.name]: roles } };
				});
			} catch (error) {
				notice(`profile ${command.name} was not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			// The session now matches the saved snapshot, unless something applied other settings while the file was written.
			if (sameSettings(roles, configuration.roles)) configuration = { ...configuration, profile: command.name, modified: false };
			notice(`${replaced ? "replaced" : "saved"} profile ${command.name}; it is not the default for new sessions unless /fusion profile default ${command.name} makes it one`, "info");
			return;
		}
		if (command.kind === "profile-default") {
			const name = command.name;
			try {
				knownProfiles = await profileStore.update((document) => {
					if (name !== BUILTIN && !Object.hasOwn(document.profiles, name)) throw new Error(`unknown profile ${name}; the profiles are ${[BUILTIN, ...Object.keys(document.profiles).sort()].join(", ")}`);
					return { ...document, defaultProfile: name === BUILTIN ? null : name };
				});
			} catch (error) {
				notice(`the default was not changed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				return;
			}
			notice(`new sessions start with ${name}; this session keeps ${configurationLabel(configuration)}`, "info");
			return;
		}
		let document: ProfileDocument;
		try {
			document = await readProfiles();
		} catch (error) {
			notice(`the profiles could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		if (command.kind === "profile-list" || !dialogs) {
			notice([...profileLines(document), ...(command.kind === "profile" ? [PROFILE_USAGE] : [])].join("\n"), "info");
			return;
		}
		const early = unfinishedNames();
		if (early) {
			notice(`fusion settings stay as they are while runs are unfinished: ${early}. Wait for each run or cancel it with /fusion cancel run-N, then retry.`, "warning");
			return;
		}
		const lines = profileLines(document);
		const choice = await ctx.ui.select("fusion profile: load one into this session", lines);
		if (choice === undefined) {
			notice("fusion profile: nothing changed", "info");
			return;
		}
		const name = [BUILTIN, ...Object.keys(document.profiles).sort()][lines.indexOf(choice)];
		if (name !== undefined) await useProfile(name, notice);
	};

	pi.registerCommand("fusion", {
		description: "Open or close the pi-fusion dashboard, check, cancel, steer, answer, review and wait for this session's runs, turn fusion on or off, or configure roles and profiles",
		getArgumentCompletions: (prefix: string) => {
			const profile = PROFILE_ARG.exec(prefix);
			if (profile) {
				const kind = profile[1];
				const names = [...(kind === "save" ? [] : [BUILTIN]), ...Object.keys(knownProfiles?.profiles ?? {}).sort()];
				const matches = names.filter((name) => name.startsWith(profile[2]!));
				return matches.length ? matches.map((name) => ({ value: `profile ${kind} ${name}`, label: `profile ${kind} ${name}` })) : null;
			}
			const named = RUN_ARG.exec(prefix);
			if (named) {
				const kind = named[1];
				const matches = completable(kind).filter((handle) => handle.startsWith(named[2]));
				return matches.length ? matches.map((handle) => ({ value: `${kind} ${handle}`, label: `${kind} ${handle}` })) : null;
			}
			const items = FUSION_ARGS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		async handler(args, ctx) {
			ui = ctx.ui;
			ensureHistory(ctx);
			noteBudget(ctx);
			/** Every notice /fusion shows: a child's report, activity, question or changed path reaches most of them. */
			const notice = (text: string, level: "info" | "warning" | "error") => ctx.ui.notify(plainText(text), level);
			mask();
			const command = parseFusion(args);
			if (command.kind === "usage") {
				notice(command.message, "warning");
				return;
			}
			// On and off read no configuration, so they switch at once, before the default profile has loaded.
			if (command.kind === "off") {
				const outcome = turnOff();
				if (outcome.kind === "already") notice("fusion is already off; turn it on with /fusion on", "info");
				else if (outcome.kind === "unfinished") notice(`${modeUnfinished(outcome.names)} Wait for each run or cancel it with /fusion cancel run-N, then retry /fusion off.`, "warning");
				else if (outcome.kind === "failed") notice(`fusion stays on: the host's tool list did not change: ${outcome.reason}`, "error");
				else notice("fusion is off; no run can start until /fusion on", "info");
				return;
			}
			if (command.kind === "on") {
				const outcome = turnOn();
				if (outcome.kind !== "failed") activationReminder = false;
				if (outcome.kind === "already") notice("fusion is already on", "info");
				else if (outcome.kind === "failed") notice(`fusion stays off: the host's tool list did not change: ${outcome.reason}`, "error");
				else notice("fusion is on", "info");
				return;
			}
			// A command that starts a review or applies settings reads the configuration, so it waits for the default
			// profile as a call does; once that has loaded, nothing here yields.
			if (!initialized) await initialize();
			noteProfiles(ctx);
			if (
				command.kind === "config" ||
				command.kind === "profile" ||
				command.kind === "profile-list" ||
				command.kind === "profile-use" ||
				command.kind === "profile-save" ||
				command.kind === "profile-default"
			) {
				await configure(command, ctx, notice);
				return;
			}

			if (command.kind === "dashboard") {
				let running: Dashboard;
				try {
					running = await openDashboard(ctx.cwd);
				} catch (error) {
					notice(`fusion: the dashboard did not start: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				notice(`fusion dashboard: ${running.url}`, "info");
				if (process.env.PI_FUSION_DASHBOARD_OPEN !== "0") openInBrowser(running.url);
				return;
			}
			if (command.kind === "dashboard-stop") {
				notice((await closeDashboard()) ? "fusion: dashboard closed" : "fusion: the dashboard is not running", "info");
				return;
			}
			/** The live run a handle names, or undefined once the user has been told what became of it. */
			const live = (handle: string): LiveRun | undefined => {
				const what = found(handle, ctx);
				if ("run" in what) return what.run;
				if ("held" in what) notice(heldText(what.held, what.branch, ctx.cwd), "info");
				else if ("gone" in what) {
					const left = what.gone.refusal ?? `continue it with ${continueWith(what.gone.backend)} and continue ${handle}`;
					notice(`${handle} (${what.gone.role}) ran before this Pi process started and is not active; ${left}`, "info");
				}
				else notice(`unknown run ${handle}; runs in this Pi session: ${[...runs.keys()].join(", ") || "none"}`, "warning");
				return undefined;
			};
			if (command.kind === "status") {
				if (command.handle === undefined) {
					const all = [...runs.values()];
					const earlier = heldRuns(ctx).map((held) => `${held.handle} · ${held.role} · ${held.model} · ${held.state} · earlier Pi process`);
					notice([`fusion: ${enabled ? "on" : "off"}`, ...(all.length ? all.map(statusLine) : ["no runs in this Pi session yet"]), ...earlier, usageLine()].join("\n"), "info");
					return;
				}
				const run = live(command.handle);
				if (!run) return;
				const lines = await runStatus(run);
				// The Pi path a status line offers is the one the run's outcome was accepted with, so a run still going
				// and one whose result the host refused offer none; a Claude id stays the live scalar it always was.
				lines.push(...sessionHint(run.latest, run.verified?.ref, run.backend));
				notice(lines.join("\n"), "info");
				return;
			}
			if (command.kind === "answer") {
				/** The one run waiting for an answer, or undefined once the user has been told there is none or more than one. */
				const sole = (): LiveRun | undefined => {
					const open = [...runs.values()].filter((entry) => entry.state === "waiting");
					if (!open.length) {
						notice("no run is waiting for an answer", "info");
						return undefined;
					}
					if (open.length > 1) {
						notice(`several runs are waiting for an answer: ${open.map((entry) => entry.handle).join(", ")}; name one with /fusion answer run-N [text]`, "warning");
						return undefined;
					}
					return open[0];
				};
				const run = command.handle === undefined ? sole() : live(command.handle);
				if (!run) return;
				const question = run.questions[0];
				if (run.state !== "waiting" || !question) {
					// An abort takes the run's questions away before its end lands, so only the end names the state.
					if (!question && run.controller.signal.aborted) await run.ended;
					notice(`${run.handle} is not waiting for an answer (state: ${run.state})`, "warning");
					return;
				}
				let text = command.text;
				if (text === undefined) {
					if (ctx.hasUI === false || typeof ctx.ui.editor !== "function") {
						notice(`${run.handle} needs the answer on the command line: /fusion answer ${run.handle} <text>`, "warning");
						return;
					}
					const typed = await ctx.ui.editor(plainText(`Answer ${run.handle}: ${firstLine(question.text)}`));
					if (!typed?.trim()) {
						notice(`answer cancelled; ${run.handle} still waits`, "info");
						return;
					}
					text = typed.trim();
				}
				// The run can move on while the editor is open, so only the question that was read is answered.
				const sent: Answered = run.questions[0]?.id === question.id ? answer(run, text, "user") : { ok: false };
				if (!sent.ok) {
					const already = question.answered;
					// The same abort window: the run reads as active with its questions gone until its end lands.
					if (!already && run.controller.signal.aborted) await run.ended;
					const why = already
						? `${run.handle}'s question was already answered by the ${already.by}: ${already.text}`
						: isActive(run)
							? `${run.handle} moved on to another question`
							: `${run.handle} has ended: ${run.state}`;
					notice(`${why}; your answer was not sent`, "warning");
					return;
				}
				const next = sent.next ? `\nIt has another question: ${firstLine(sent.next.text)}` : "";
				notice(`answer sent to ${run.handle}; the child goes on${next}`, "info");
				send(
					{
						customType: NOTICE_TYPE,
						content: `The user answered ${run.handle} (${run.role.name}): ${text}\n\nQuestion: ${firstLine(question.text)}`,
						display: true,
						details: { handle: run.handle, role: run.role.name, state: run.state, kind: "answer", by: "user", questionId: question.id },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				// The answer uncovered a question the host has not heard, and the answer message on its own starts no turn.
				if (sent.next && run.background && !shuttingDown) notify(run, askedText(run));
				return;
			}
			if (command.kind === "review") {
				const what = found(command.handle, ctx);
				// A run whose state has just turned terminal has no file list until its end path lands, and a review reads one.
				if ("run" in what && !isActive(what.run) && !what.run.finished) await what.run.ended;
				const source = "run" in what ? liveSource(what.run, ctx) : "held" in what ? heldSource(what.held, ctx) : undefined;
				if (!source) {
					// There is nothing to review: live() says what became of the handle, or that nobody here knows it.
					live(command.handle);
					return;
				}
				const started = startReview(source, "review", ctx);
				if ("refused" in started) {
					notice(started.refused, "warning");
					return;
				}
				const handle = started.run.handle;
				notice(`${handle} reviews ${source.handle} in the background; its report arrives as a message`, "info");
				send(
					{
						customType: NOTICE_TYPE,
						content: `The user started ${handle}, an independent review of ${source.handle}; its report arrives when it ends.`,
						display: true,
						details: { handle, role: "ask", state: "running", kind: "review", by: "user", reviews: source.handle },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				return;
			}
			const run = live(command.handle);
			if (!run) return;
			if (command.kind === "cancel") {
				if (!isActive(run)) {
					notice(`${run.handle} has already ended: ${run.state}`, "info");
					return;
				}
				run.cancelled = true;
				run.cancelledBy = "user";
				run.controller.abort();
				// run.ended is a resolved placeholder until the run's child starts, so the end signal is what to wait on.
				await watched(run);
				await run.ended;
				// A backend that had something to say about what the stop left behind says it here too, because this
				// notice is the whole of what the user who cancelled the run sees of its end.
				const left = run.cleanupNotice;
				notice(left === undefined ? `${run.handle} cancelled` : `${run.handle} cancelled; ${left}`, left === undefined ? "info" : "warning");
				return;
			}
			if (command.kind === "steer") {
				if (run.state === "waiting") {
					notice(`${run.handle} is waiting for an answer, not a steer; answer it with /fusion answer ${run.handle} <text>`, "warning");
					return;
				}
				if (!isActive(run)) {
					notice(`${run.handle} has ended: ${run.state}; nothing was sent`, "warning");
					return;
				}
				if (!run.input.push(command.text)) {
					notice(`${run.handle} no longer takes input`, "warning");
					return;
				}
				notice(`steer sent to ${run.handle}; the child reads it when it next takes input`, "info");
				send(
					{
						customType: NOTICE_TYPE,
						content: `The user steered ${run.handle} (${run.role.name}): ${command.text}`,
						display: true,
						details: { handle: run.handle, role: run.role.name, state: run.state, kind: "steer", by: "user" },
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				return;
			}
			if (!isActive(run)) {
				await run.ended;
				notice(finalText(run), "info");
				return;
			}
			let escaped = false;
			if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") escaped = await watchInTui(run, ctx);
			else await watched(run);
			if (shuttingDown) return;
			if (escaped) {
				notice(`stopped waiting; ${run.handle} goes on`, "info");
				return;
			}
			if (run.state === "waiting") {
				notice(`${run.handle} asks: ${firstLine(run.questions[0]?.text ?? "")}. Answer it with /fusion answer ${run.handle} <text>`, "warning");
				return;
			}
			await run.ended;
			notice(finalText(run), run.state === "done" ? "info" : "error");
		},
	});

	// Fusion starts off: the workflow tools are hidden before anything here awaits, so the first prompt carries none of
	// their guidance, and the default profile loads as the session starts, so on already finds its guidance in place.
	pi.on("session_start", async (_event, ctx) => {
		mask();
		await initialize();
		noteProfiles(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!activationReminder || !enabled || shuttingDown) return;
		activationReminder = false;
		record(() => ctx.ui.notify("Fusion remains on. Use /fusion off or ask to turn it off when you're done.", "info"));
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		record(() => ui?.setWidget?.("fusion", undefined));
		for (const dismiss of [...waits]) dismiss();
		waits.clear();
		for (const run of active()) {
			run.cancelled = true;
			run.controller.abort();
		}
		const unfinished = [...runs.values()].filter((run) => !run.finished);
		await Promise.all([closeDashboard(), ...unfinished.map((run) => run.ended)]);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		const names = unfinishedNames();
		if (!names) return undefined;
		ctx.ui.notify(
			`/tree is blocked while fusion runs are active: ${names}. A report or run record that arrives after /tree would land on the destination branch. Wait for each run or cancel it with fusion_control, then retry /tree.`,
			"warning",
		);
		return { cancel: true };
	});

	pi.registerMessageRenderer(NOTICE_TYPE, (message, options, theme) => {
		const details = cardDetails(message.details);
		const label = NOTICE_LABELS.get(details.kind ?? "") ?? "run";
		const header = headerLine(theme, { label, details, color: "customMessageLabel" });
		return new Card(header, bodyLines(theme, resultText(message.content), { expanded: options.expanded, ...bodyOf(details) }), cardMode(options.expanded));
	});

	/**
	 * What the fusion and claude tools both do: route the call to a backend, start the run there and return its report,
	 * or its handle when it runs in the background. The tools differ in what they advertise and in how they route, not
	 * in what a run then is: one lifecycle, one set of handles, one question arbitration, one ledger.
	 */
	const delegate = async (tool: string, toolCallId: string, params: FusionParams, signal: AbortSignal | undefined, onUpdate: LiveRun["onUpdate"], ctx: any) => {
		// A hidden tool leaves the host's tool list on its next turn, so a call already in this one still lands here.
		mask();
		if (!enabled) throw new Error(FUSION_OFF);
		ui = ctx.ui;
		// No call runs on the built-in defaults while the default profile is still loading. Once it has loaded, nothing
		// here yields before the run registers, which is what lets a cancel issued right after the call find it.
		if (!initialized) await initialize();
		noteProfiles(ctx);
		ensureHistory(ctx);
		noteBudget(ctx);
		// A run whose state has just turned terminal records its branch entry when its end path lands; a continue reads it.
		const finishing = params.continue === undefined ? undefined : runs.get(params.continue);
		if (finishing && !isActive(finishing) && !finishing.finished) await finishing.ended;
		const records = coverLiveHandles(runRecords(ctx.sessionManager.getBranch()));
		const refuseActive = (handle: string | undefined) => {
			if (handle !== undefined && isActive(runs.get(handle))) {
				throw new Error(`${handle} is still active; send it a message with fusion_control message, or wait for it with fusion_control wait`);
			}
		};
		refuseActive(params.continue);
		// The configuration is read here, after the last await before the run registers, so a switch that landed while
		// this call waited is the one it runs on; from here to the registration nothing yields, and the bound role is final.
		const route = tool === CLAUDE_TOOL_NAME ? claudeRoute(params, records, planPct, configuration) : fusionRoute(params, records, planPct, configuration);
		const { handle, record: prior, handoff } = route;
		/*
		 * A backend this build does not run is refused here: after the route, the record and the call's parameters have
		 * been checked, and before a handle is taken, the writer slot reserved, the tree sampled, a child started or an
		 * entry written. The role is bound after it, so a backend that runs nowhere never asks the user to configure it.
		 */
		const backend = backends[route.backend];
		if (!backend) throw new Error(unavailable(route.backend, route.record ? `${handle} ran on it` : `${handle} would run role ${route.role} on it`, route.record !== undefined));
		const role = fusionRole(route);
		refuseActive(handle);
		const busy = canChangeFiles(role.name) ? active().find((run) => canChangeFiles(run.role.name)) : undefined;
		if (busy) {
			throw new Error(`${busy.handle} (${busy.role.name}) is still active; wait for it, message it or cancel it with fusion_control before you start or continue another run that can change files`);
		}
		const blocked = ledger.blocked();
		if (blocked) throw new Error(budgetBlockMessage(blocked));
		const background = params.background === true;
		const task = params.context ? `${params.task}\n\n## Context\n${params.context}` : params.task;
		const carried = handoff ? lastReport(handoff.from) : undefined;
		if (handoff && carried === undefined) throw new Error(handoffBlocked(handoff.from, handoff.reason));
		const prompt = handoff && carried !== undefined ? handoffPrompt(task, handoff.from, carried, handoff.reason) : task;
		const continued = params.continue === undefined ? undefined : handoffShare(prior, planPct);
		const routed = handoff
			? handoffNote(handoff.from, handle, handoff.reason)
			: continued === undefined
				? undefined
				: continueNote(handle, role.name, continued, planPct);
		const note = [routed, route.unrecorded].filter((part) => part !== undefined).join("\n\n") || undefined;
		const hostSessionId: string = ctx.sessionManager.getSessionId();
		// The intent is the host's half of continuing a run; which session it becomes is the backend's own to say.
		const intent = intentFor(prior, hostSessionId);
		const session = backend.session(intent);
		const title = `pi-fusion ${handle} ${role.name} · host ${hostSessionId}`;
		/** Only the live run a continued call replaces knows the run it reviews, and the new one keeps naming it. */
		const reviews = params.continue === undefined ? undefined : runs.get(params.continue)?.reviews;
		// Off can be accepted while this call waited for the run it continues; startRun registers before its first await.
		if (!enabled) throw new Error(FUSION_OFF);
		const run = await startRun({
			tool,
			toolCallId,
			role,
			handle,
			prompt,
			origin: "tool",
			...(reviews === undefined ? {} : { reviews }),
			...(note === undefined ? {} : { note }),
			backend,
			session,
			title,
			background,
			onUpdate: background ? undefined : onUpdate,
			ctx,
			onRun: recordRun({ handle, role, backend: backend.name, hostSessionId, intent, ...(prior === undefined ? {} : { prior }) }),
		});
		if (background) {
			return {
				content: [{ type: "text" as const, text: `${note ? `${note}\n\n` : ""}${handle} started in the background; you get the report when it ends` }],
				details: { ...runDetails(run), handle, role: role.name, model: role.model, background: true, sessionUsage: ledger.totals() },
			};
		}
		const onAbort = () => run.controller.abort();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await settled(run);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (run.state === "waiting") {
			run.background = true;
			delete run.onUpdate;
			return {
				content: [{ type: "text" as const, text: `${note ? `${note}\n\n` : ""}${askedText(run)}` }],
				details: { ...runDetails(run), handle, role: role.name, model: role.model, background: true, state: "waiting", sessionUsage: ledger.totals() },
			};
		}
		await run.ended;
		run.delivered = true;
		return outcome(run);
	};

	/** The fusion tool as this session's configuration describes it; its executor and renderers never change. */
	const fusionTool = () => ({
		name: TOOL_NAME,
		executionMode: "sequential" as const,
		label: "Fusion",
		description: `Delegate work to a child: a headless coding session in this working directory, run through one of this build's backends. The role picks the job. plan: a planner on the configured model, or the model you name, which can read the code, run commands and write scratch files, challenges a goal and your proposed plan and consolidates it into an agreed, numbered task list with acceptance criteria. A plan call continues the last plan run of the backend it routes to, so follow-ups can refer to the earlier agreement, until that run's context passes its cap or the call names another model, when the call starts a fresh plan run carrying the agreed plan and says so; fresh starts a new plan run. implement: implements one clear, bounded task with full tools and reports what changed and how it was verified. If the task needs a broader scope or a design decision, it stops and reports under Escalation instead of widening the task. ultracode: Claude Code with ultracode on orchestrates Claude Opus 5 agents at xhigh effort, one agent at a time, to implement, verify and review a task, several tasks in dependency order, or a whole agreed plan. It is slower and costlier than implement; use it only when the user asks for it. ask: read-only tools (on claude: Read, Bash, Grep, Glob, WebSearch, WebFetch) answer a question about the code with file and line references, or with mode review give an independent review of a change, findings ranked by severity. It has no edit or write tool, and its contract forbids changing files through a shell. security: investigates one scoped security concern, area or change on the user's own Pi provider configuration, with the same tools as role implement. It confirms a finding where it can, reports each with a severity and with whether it is confirmed or inferred, and never puts a secret in its report by value. Its task says whether fixes are authorized: with none it reports findings and changes no application code, and with one it writes the smallest fix that closes a finding and verifies it. Ask for it only when the user asks for a security investigation, audit or fix. ${configurationText(configuration.roles)} A disabled role is refused whether a call starts or continues it. backend picks the harness a child runs in: leave backend unset unless the user names one, and a fresh run goes to the backend the configuration above names for its role, on that role's configured model and effort. A call that names the other backend runs there on that backend's own defaults, never on the settings configured for the role's other backend. backend pi runs plan, implement, ask and security on the user's own Pi provider configuration, under the same contracts as the claude roles, security's own contract included; role ultracode runs on the claude backend alone, and role security on the pi backend alone, so a call that names it goes to pi whether or not it names a backend and naming claude for it is refused before anything starts. On pi the tools are Pi's own and are not the claude lists above: roles plan, implement and security run with read, bash, edit, write, grep, find and ls, role ask runs with read, bash, grep, find and ls and has no web search or web fetch tool at all, and every pi role also gets ask_orchestrator, which is how a pi child asks you a question. A pi call's model is a provider and a model id, such as deepseek/deepseek-chat, taken from the call's model parameter, then the selection the run it continues actually ran with, then this session's configuration for that role, which by default comes from PI_FUSION_PI_<ROLE>_MODEL; a pi call with none of those is refused before anything starts, because nothing here resolves a pi model for you. Every run gets a handle such as run-3, shown in the stats line. continue with a handle sends the task as a follow-up to that run: the child keeps its context from the run's last successful call, across a resume of this session, /tree and forks, stays on the backend it ran on, and keeps the model and effort that run was started with unless the call names others, whatever profile is selected since. Calls run one at a time: Pi serializes any turn that contains one. Returns the child's report, or with background true the handle at once and the report later as a message; manage a background run with fusion_control. If the child asks a question, the call returns the question at once and the run waits in the background until you answer it with fusion_control message. Only one run that can change files is active at a time, waiting included; ask runs can go next to it. The claude tool is this same delegation forced to the claude backend, kept for compatibility, and fusion_control and claude_control both act on every run.`,
		promptSnippet:
			"Delegate planning (plan), bounded implementation (implement), implementation the user asks ultracode for (ultracode), read-only questions and reviews (ask) or a scoped security investigation or fix the user asked for (security) to a coding child",
		promptGuidelines: [
			...guidelines(TOOL_NAME, CONTROL_TOOL_NAME, configuration.roles, { backend: true }),
			...(configuration.roles.security.enabled ? [securityGuideline(TOOL_NAME, configuration.roles.security)] : []),
			backendGuideline(TOOL_NAME),
		],
		parameters: Type.Object({
			role: Type.Optional(stringEnum(KNOWN_ROLE_NAMES, "plan, implement, ultracode, ask or security. Required unless continue is set.")),
			task: Type.String({
				description:
					"Plain, readable prose, with the spaces between words kept. A new run has not seen this conversation, so make the task self-contained, and name files instead of pasting their contents. For plan: the goal, your proposed plan, constraints and decisions already made; the child reads the code itself. For implement and ultracode: the task or tasks, agreed or direct: what to change, where, acceptance criteria, and how to verify each one. For ask: the question, or for mode review the change to review (a diff, a commit range or files) and what it must do. For security: the concern, area or change to investigate, what the code is meant to guarantee, and whether fixes are authorized; without that it reports findings and changes no application code. With continue: the follow-up message.",
			}),
			continue: Type.Optional(Type.String({ description: "A run's handle, such as run-3: continue that run instead of starting a new one, on the backend it ran on." })),
			context: Type.Optional(Type.String({ description: "Extra context the child needs, in plain, readable prose: decisions, related files, results of earlier tasks." })),
			background: Type.Optional(Type.Boolean({ description: "Return at once with the run's handle and let the run go on; you get its report as a message when it ends. Default false." })),
			fresh: Type.Optional(Type.Boolean({ description: "plan only, not with continue: start a new plan run instead of continuing the last one." })),
			mode: Type.Optional(stringEnum(ASK_MODES, "ask only: answer (default) for a question, review for an independent review of a change. A continued ask run keeps its mode unless this names another.")),
			backend: Type.Optional(
				stringEnum(
					BACKEND_NAMES,
					"The harness the child runs in: claude, which runs every role but security, or pi, which runs plan, implement, ask and security on the user's own Pi provider configuration and needs a provider and model id from the call's model parameter or this session's configuration. Leave it unset to run the role on the backend this session's configuration names for it, and name one only when the user asks for it; role security goes to pi whether or not this names it, because no other harness runs it, and naming claude for it is refused. With continue it must name the backend that run is on, if it names one at all.",
				),
			),
			model: Type.Optional(
				Type.String({
					description:
						"A model instead of the role's configured one: on the claude backend a Claude Code alias or id, for plan, implement and ask only; on the pi backend a provider and model id such as deepseek/deepseek-chat, which every pi role takes. A run keeps its model for later calls that name no model. A plan call that names another model than the plan run is on starts a fresh plan run carrying the agreed plan.",
				}),
			),
			effort: Type.Optional(stringEnum(FUSION_EFFORTS, "The child's effort instead of the role's configured one, for plan, implement, ask and security: low, medium, high, xhigh or max on the claude backend, and any of these pi thinking levels on the pi backend, which is the only one role security runs on.")),
		}),
		async execute(toolCallId: string, params: FusionParams, signal: AbortSignal | undefined, onUpdate: LiveRun["onUpdate"], ctx: any) {
			return delegate(TOOL_NAME, toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args: unknown, theme: any, context: any) {
			const call = (args ?? {}) as Partial<Record<"continue" | "role" | "task", unknown>>;
			const continued = argText(call.continue);
			const target = continued ? `continue ${continued}` : argText(call.role);
			const label = theme.fg("toolTitle", theme.bold(target ? `${TOOL_NAME} ${target}` : TOOL_NAME));
			const task = firstLine(argText(call.task));
			return reuse(context, task ? `${label} ${theme.fg("muted", task)}` : label, [], "truncate");
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			return resultCard(TOOL_NAME, result, options, theme, context);
		},
	});

	/** The claude tool as this session's configuration describes it; its executor and renderers never change. */
	const claudeTool = () => ({
		name: CLAUDE_TOOL_NAME,
		executionMode: "sequential" as const,
		label: "Claude",
		description: `Delegate work to a child: a headless Claude Code session in this working directory. The role picks the job. plan: a planner on its configured model, or the model you name, which can read the code, run commands and write scratch files, challenges a goal and your proposed plan and consolidates it into an agreed, numbered task list with acceptance criteria. A plan call continues the last plan run, so follow-ups can refer to the earlier agreement, until that run's context passes its cap or the call names another model, when the call starts a fresh plan run carrying the agreed plan and says so; fresh starts a new plan run. implement: implements one clear, bounded task with full tools and reports what changed and how it was verified. If the task needs a broader scope or a design decision, it stops and reports under Escalation instead of widening the task. ultracode: Claude Code with ultracode on orchestrates Claude Opus 5 agents at xhigh effort, one agent at a time, to implement, verify and review a task, several tasks in dependency order, or a whole agreed plan. It is slower and costlier than implement; use it only when the user asks for it. ask: read-only tools (Read, Bash, Grep, Glob, WebSearch, WebFetch) answer a question about the code with file and line references, or with mode review give an independent review of a change, findings ranked by severity. It has no Edit or Write, and its contract forbids changing files through Bash. ${claudeConfigurationText(configuration)} A disabled role is refused whether a call starts or continues it. Every run gets a handle such as run-3, shown in the stats line. continue with a handle sends the task as a follow-up to that run: the child keeps its context from the run's last successful call, across a resume of this session, /tree and forks, and keeps the model and effort that run was started with unless the call names others. Calls run one at a time: Pi serializes any turn that contains one. Returns the child's report, or with background true the handle at once and the report later as a message; manage a background run with claude_control. If the child asks a question, the call returns the question at once and the run waits in the background until you answer it with claude_control message. Only one run that can change files is active at a time, waiting included; ask runs can go next to it.`,
		promptSnippet: "Delegate planning (plan), bounded implementation (implement), implementation the user asks ultracode for (ultracode) or read-only questions and reviews (ask) to a Claude Code child",
		promptGuidelines: guidelines(CLAUDE_TOOL_NAME, CLAUDE_CONTROL_NAME, configuration.roles, { backend: false }),
		parameters: Type.Object({
			role: Type.Optional(stringEnum(ROLE_NAMES, "plan, implement, ultracode or ask. Required unless continue is set.")),
			task: Type.String({
				description:
					"Plain, readable prose, with the spaces between words kept. A new run has not seen this conversation, so make the task self-contained, and name files instead of pasting their contents. For plan: the goal, your proposed plan, constraints and decisions already made; the child reads the code itself. For implement and ultracode: the task or tasks, agreed or direct: what to change, where, acceptance criteria, and how to verify each one. For ask: the question, or for mode review the change to review (a diff, a commit range or files) and what it must do. With continue: the follow-up message.",
			}),
			continue: Type.Optional(Type.String({ description: "A run's handle, such as run-3: continue that run instead of starting a new one." })),
			context: Type.Optional(Type.String({ description: "Extra context the child needs, in plain, readable prose: decisions, related files, results of earlier tasks." })),
			background: Type.Optional(Type.Boolean({ description: "Return at once with the run's handle and let the run go on; you get its report as a message when it ends. Default false." })),
			fresh: Type.Optional(Type.Boolean({ description: "plan only, not with continue: start a new plan run instead of continuing the last one." })),
			mode: Type.Optional(stringEnum(ASK_MODES, "ask only: answer (default) for a question, review for an independent review of a change. A continued ask run keeps its mode unless this names another.")),
			model: Type.Optional(Type.String({ description: "plan, implement and ask only: a Claude Code model alias or id instead of the role's configured one. The run keeps it for later calls that name no model, and a plan call that names another model starts a fresh plan run." })),
			effort: Type.Optional(stringEnum(EFFORTS, "plan, implement and ask only: the child's effort instead of the role's configured one.")),
		}),
		async execute(toolCallId: string, params: ClaudeParams, signal: AbortSignal | undefined, onUpdate: LiveRun["onUpdate"], ctx: any) {
			return delegate(CLAUDE_TOOL_NAME, toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args: unknown, theme: any, context: any) {
			const call = (args ?? {}) as Partial<Record<"continue" | "role" | "task", unknown>>;
			const continued = argText(call.continue);
			const target = continued ? `continue ${continued}` : argText(call.role);
			const label = theme.fg("toolTitle", theme.bold(target ? `${CLAUDE_TOOL_NAME} ${target}` : CLAUDE_TOOL_NAME));
			const task = firstLine(argText(call.task));
			return reuse(context, task ? `${label} ${theme.fg("muted", task)}` : label, [], "truncate");
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			return resultCard(CLAUDE_TOOL_NAME, result, options, theme, context);
		},
	});

	/** What each delegation tool was last registered with, so a refresh re-registers only a tool whose guidance changed. */
	const registered = new Map<string, string>();

	/**
	 * Registers the delegation tools from the current configuration. The first registration is the extension's load; a
	 * refresh re-registers a tool under its own name, which this SDK applies at once and which rebuilds the host's
	 * prompt. That refresh also puts back every tool a host allow list names, so the active list is taken just before
	 * each re-registration and set back just after it: a tool /fusion off hid, or one the user turned off, stays off.
	 */
	const registerGuidance = (refresh: boolean): void => {
		for (const definition of [fusionTool(), claudeTool()]) {
			const key = JSON.stringify([definition.description, definition.promptGuidelines, definition.parameters]);
			if (registered.get(definition.name) === key) continue;
			// The host may install the definition and then throw during its registry refresh; either way rollback must try.
			registered.delete(definition.name);
			if (!refresh) {
				pi.registerTool(definition as any);
				registered.set(definition.name, key);
			} else {
				const activeTools = pi.getActiveTools();
				try {
					pi.registerTool(definition as any);
					// Registration already changed the definition, even if restoring active tools then throws.
					registered.set(definition.name, key);
				} finally {
					pi.setActiveTools(activeTools);
				}
			}
		}
	};

	registerGuidance(false);


	/**
	 * What fusion_control and claude_control both do: act on a run of this Pi session by handle, whichever tool
	 * started it and whichever backend it runs in. The two names are one executor, so no handle is reachable
	 * through one of them alone.
	 */
	const control = async (params: { action: string; run?: string; message?: string }, signal: AbortSignal | undefined, ctx: any) => {
		mask();
		ui = ctx.ui;
		ensureHistory(ctx);
		noteBudget(ctx);
		const reply = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
		if (!(CONTROL_ACTIONS as readonly string[]).includes(params.action)) {
			throw new Error(`unknown action ${params.action}; use one of ${CONTROL_ACTIONS.join(", ")}`);
		}
		if (params.action === "status" && params.run === undefined) {
			const all = [...runs.values()];
			return reply(all.length ? all.map(statusLine).join("\n") : "no runs in this Pi session yet", { usage: ledger.totals() });
		}
		if (params.run === undefined) throw new Error(`${params.action} needs run`);
		if (params.action === "message" && !params.message?.trim()) throw new Error("message needs message");
		const handle = params.run;
		const run = runs.get(handle);
		if (!run) {
			const record = branchRuns(ctx).get(handle);
			const unsent = params.action === "message" ? " The message was not sent." : "";
			// A run its Pi process never saw end recorded no entry, so the history is all that still names it.
			if (!record) {
				const held = historical.get(handle);
				if (!held) throw new Error(`unknown run ${handle}`);
				if (params.action === "status") return reply(heldText(held, undefined, ctx.cwd), { handle, state: held.state, historical: true });
				return reply(`${handle} (${held.role}) ran in an earlier Pi process and is not active.${unsent} Read it with fusion_control status and run ${handle}, or take no action.`, {
					handle,
					state: held.state,
					historical: true,
				});
			}
			const held = params.action === "status" ? heldRun(handle, record, ctx) : undefined;
			if (held) return reply(heldText(held, record, ctx.cwd), { handle, state: held.state, historical: true, ...(record.refusal ? { refused: true } : {}) });
			const left = record.refusal ? `${record.refusal}.` : `Continue it with ${continueWith(record.backend)} and continue ${handle}, or take no action.`;
			return reply(`${handle} (${record.role}) ran before this Pi session started and is not active.${unsent} ${left}`, { handle, state: "ended", ...(record.refusal ? { refused: true } : {}) });
		}
		if (params.action === "status") {
			const lines = await runStatus(run);
			const answered = run.userAnswer;
			if (answered) {
				answered.acknowledged = true;
				lines.push(`answered by the user: ${answered.text}`);
			}
			return reply(lines.join("\n"), { ...runDetails(run), handle, state: run.state, usage: ledger.totals() });
		}
		if (params.action === "wait") {
			if (!(await settled(run, signal))) throw new Error(`stopped waiting; ${handle} goes on in the background`);
			const answered = run.userAnswer;
			if (answered) answered.acknowledged = true;
			const answerLine = answered ? `\n\nanswered by the user: ${answered.text}` : "";
			if (run.state === "waiting") return reply(`${askedText(run)}${answerLine}`, { ...runDetails(run), handle, state: run.state });
			// Taken before the run is awaited: a wait that lands while the run is still finishing carries the report too.
			run.delivered = true;
			await run.ended;
			return reply(`${finalText(run)}${answerLine}`, { ...runDetails(run), handle, state: run.state });
		}
		if (params.action === "message") {
			if (run.state === "waiting") {
				const sent = answer(run, params.message!, "host");
				if (sent.ok) {
					const next = sent.next ? `\n\nIt has another question:\n\n${sent.next.text}` : "";
					// The details name the answered question, so the host sees an answer that met a newer one than it read.
					return reply(`answer sent to ${handle}; the child goes on${next}`, { ...runDetails(run), handle, state: run.state, sent: "answer", answered: firstLine(sent.question.text) });
				}
			}
			const answered = run.userAnswer;
			if (run.state === "running" && answered && !answered.acknowledged) {
				answered.acknowledged = true;
				return reply(
					`The user already answered ${handle}'s question with: ${answered.text}. Your message was not sent; the child goes on with the user's answer. If it still applies, send it again with fusion_control message and it goes to the child as a steer, or as the answer if it has asked another question by then.`,
					{ ...runDetails(run), handle, state: run.state, sent: "none", answeredBy: "user" },
				);
			}
			if (run.state === "running" && run.input.push(params.message!)) {
				return reply(`steer sent to ${handle}; the child reads it when it next takes input`, { ...runDetails(run), handle, state: run.state, sent: "steer" });
			}
			await run.ended;
			const text = summary(run);
			// What the run left on the branch decides what is still possible: a record this host refuses is no
			// continuation to offer, however the run itself ended.
			const recorded = branchRuns(ctx).get(handle);
			const left = recorded?.refusal
				? `${recorded.refusal}.`
				: `If the message still applies, continue the run with ${continueWith(recorded?.backend ?? run.backend)} and continue ${handle}, where you can also set model, effort, context and background. Otherwise take no action.`;
			return reply(`${handle} (${run.role.name}) has ended: ${run.state}. The message was not sent.${text ? `\n\nReport summary:\n${text}` : ""}\n\n${left}`, {
				...runDetails(run),
				handle,
				state: run.state,
				sent: "none",
				...(recorded?.refusal ? { refused: true } : {}),
			});
		}
		if (!isActive(run)) return reply(`${handle} has already ended: ${run.state}. Nothing to cancel.`, { ...runDetails(run), handle, state: run.state });
		run.cancelled = true;
		run.delivered = true;
		run.controller.abort();
		// The same barrier `/fusion cancel` waits on, and for the same reason: `run.ended` is a resolved placeholder until
		// the run's child has started, so a cancel that raced the start would otherwise read the run's fields before the
		// outcome filled them in and report a stop the backend had not finished making.
		await watched(run);
		await run.ended;
		// The cancel takes the run's report, so what its backend said the stop left behind travels with this reply or
		// with nothing: the host is told no other way about a run it cancelled itself.
		return reply(run.cleanupNotice === undefined ? `${handle} cancelled` : `${handle} cancelled; ${run.cleanupNotice}`, { ...runDetails(run), handle, state: run.state });
	};

	pi.registerTool({
		name: CONTROL_TOOL_NAME,
		executionMode: "sequential",
		label: "Fusion control",
		description:
			"Act on the runs of this Pi session, whatever started them, by handle. A run is running, waiting (its child asked a question and waits for the answer), or has ended. status: without run, list every run with role, model, state, elapsed time and open question; with run, add its current activity, tool call count and, for a run that can change files, the work tree changes seen so far. wait: block until the run ends and return its report, or until it asks a question and return the question; Esc stops the wait, not the run. message: to a waiting run, the answer to its question; to a running child, a steer it reads when it next takes input; to a run that has ended it sends nothing and returns the run's state and a summary of its report, so you can decide to continue the run with fusion or take no action. cancel: stop the run.",
		promptSnippet: "Check, wait for, answer, steer or cancel a run by its handle",
		parameters: Type.Object({
			action: stringEnum(CONTROL_ACTIONS, "status, wait, message or cancel."),
			run: Type.Optional(Type.String({ description: "The run's handle, such as run-3. Required for every action except status." })),
			message: Type.Optional(Type.String({ description: "message only: the answer to a waiting run's question, or a steer for a running child." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return control(params, signal, ctx);
		},
		renderResult(result, options, theme, context) {
			const action = typeof context.args?.action === "string" ? ` ${context.args.action}` : "";
			return resultCard(`${CONTROL_TOOL_NAME}${action}`, result, options, theme, context);
		},
	});

	pi.registerTool({
		name: CLAUDE_CONTROL_NAME,
		executionMode: "sequential",
		label: "Claude control",
		description:
			"Act on the claude runs of this Pi session by handle. A run is running, waiting (its child asked a question and waits for the answer), or has ended. status: without run, list every run with role, model, state, elapsed time and open question; with run, add its current activity, tool call count and, for a run that can change files, the work tree changes seen so far. wait: block until the run ends and return its report, or until it asks a question and return the question; Esc stops the wait, not the run. message: to a waiting run, the answer to its question; to a running child, a steer it reads when it next takes input; to a run that has ended it sends nothing and returns the run's state and a summary of its report, so you can decide to continue the run with claude or take no action. cancel: stop the run.",
		promptSnippet: "Check, wait for, answer, steer or cancel a claude run by its handle",
		parameters: Type.Object({
			action: stringEnum(CONTROL_ACTIONS, "status, wait, message or cancel."),
			run: Type.Optional(Type.String({ description: "The run's handle, such as run-3. Required for every action except status." })),
			message: Type.Optional(Type.String({ description: "message only: the answer to a waiting run's question, or a steer for a running child." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return control(params, signal, ctx);
		},
		renderResult(result, options, theme, context) {
			const action = typeof context.args?.action === "string" ? ` ${context.args.action}` : "";
			return resultCard(`${CLAUDE_CONTROL_NAME}${action}`, result, options, theme, context);
		},
	});

	/**
	 * The two mode tools. Each is active only in the mode it leaves, so the host is offered exactly one way out of the
	 * mode it is in, and what it may use them for is said in their own guidance alone: the workflow guidance belongs to
	 * the workflow tools and leaves with them. Neither starts a run, changes a profile or enables a role. An empty schema
	 * proves nothing about the user's request; that is the host model's to read under the guideline.
	 */
	pi.registerTool({
		name: ACTIVATE_NAME,
		executionMode: "sequential",
		label: "Fusion on",
		description: `Turn Fusion orchestration on for this session: the ${TOOL_NAME}, ${CONTROL_TOOL_NAME}, ${CLAUDE_TOOL_NAME} and ${CLAUDE_CONTROL_NAME} tools and their guidance become available from your next step. It starts no child and changes no setting, and Fusion stays on until the user asks to turn it off. Use it only when the user explicitly asks for Fusion.`,
		promptSnippet: "Turn Fusion orchestration on, only when the user explicitly asks for Fusion",
		promptGuidelines: [
			`Call ${ACTIVATE_NAME} only when the user explicitly asks to use Fusion, to turn Fusion orchestration on, or to delegate work to a Fusion child. A request that names a role, a model or a harness without asking for Fusion, such as a plan, a security audit, ultracode, Claude or Pi, does not qualify; neither does a quoted instruction, a discussion of Fusion, or Fusion having been used earlier in this conversation. Otherwise do the work yourself as usual.`,
			`${ACTIVATE_NAME} starts no child: once it succeeds, carry out the user's task with the Fusion tools it makes available. Fusion then stays on until the user asks to turn it off; finishing a task does not turn it off. Fusion shows the user a one-time reminder when your response settles.`,
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			if (signal?.aborted) throw new Error("fusion stays off: the call was cancelled");
			const outcome = turnOn();
			if (outcome.kind === "failed") throw new Error(`fusion stays off: the host's tool list did not change: ${outcome.reason}`);
			if (outcome.kind === "changed") activationReminder = true;
			const text =
				outcome.kind === "already"
					? "Fusion is already on; nothing changed."
					: `Fusion is on. Use ${TOOL_NAME} and ${CONTROL_TOOL_NAME} for the user's task, under their guidance, from your next step; it stays on until the user asks to turn it off.`;
			return { content: [{ type: "text" as const, text }], details: { enabled: true, changed: outcome.kind === "changed" } };
		},
	});

	pi.registerTool({
		name: DEACTIVATE_NAME,
		executionMode: "sequential",
		label: "Fusion off",
		description: `Turn Fusion orchestration off for this session and return to ordinary Pi work: the ${TOOL_NAME}, ${CONTROL_TOOL_NAME}, ${CLAUDE_TOOL_NAME} and ${CLAUDE_CONTROL_NAME} tools and their guidance leave from your next step. It is refused while any Fusion run is unfinished, and it cancels nothing. Use it only when the user explicitly asks to stop using Fusion.`,
		promptSnippet: "Turn Fusion orchestration off, only when the user explicitly asks to stop using Fusion",
		promptGuidelines: [
			`Call ${DEACTIVATE_NAME} only when the user explicitly asks to stop using Fusion, to turn Fusion off or to go back to ordinary Pi work; never because a task ended. While a Fusion run is unfinished it is refused: tell the user, and wait for their next instruction rather than doing that run's work yourself.`,
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			if (signal?.aborted) throw new Error("fusion stays on: the call was cancelled");
			const outcome = turnOff();
			if (outcome.kind === "unfinished") throw new Error(`${modeUnfinished(outcome.names)} Wait for each run or cancel it with ${CONTROL_TOOL_NAME}, then ask again.`);
			if (outcome.kind === "failed") throw new Error(`fusion stays on: the host's tool list did not change: ${outcome.reason}`);
			const text =
				outcome.kind === "already"
					? "Fusion is already off; nothing changed."
					: "Fusion is off. From your next step you work directly, as ordinary Pi, and the Fusion orchestration guidance no longer applies.";
			return { content: [{ type: "text" as const, text }], details: { enabled: false, changed: outcome.kind === "changed" } };
		},
	});
}
