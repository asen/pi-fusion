import type { BackendName, ResolvedSelection, SessionRef } from "./backends/types.ts";
import type { ChangedFile } from "./changes.ts";
import { type ArchiveKey, type ArchivePage, MAX_STRING_CHARS, type RestoredView, restoredView, type RunSession } from "./dashboard.ts";
import { asEnded, type BranchIdentity, HISTORY_ABORTED, type HistoryRecord, type StampedLoad, sameChild } from "./history.ts";

/**
 * What one pi-fusion entry on the host's current branch says about a handle: which host session recorded it and which
 * child it had there. A branch record from `branchEvidence` is one, superseded or not. It vouches for reading a
 * history record and for nothing else: continuation, control and review keep reading the branch's latest record.
 */
export interface BranchEvidence extends BranchIdentity {
	handle: string;
	hostSessionId?: string;
}

/**
 * What eligibility reads of a history record: the session it ran in, its handle, the child it names, its state as
 * saved, and of its launch request only the kind, the parent it named, the parent's file and the backend tag.
 */
export type ArchiveIdentity = Pick<HistoryRecord, "hostSessionId" | "handle" | "backend" | "ref" | "sessionId" | "state" | "session">;

/** The records one host session's history file gave back, under the session the file is for. */
export interface ArchiveSource {
	hostSessionId: string;
	records: readonly HistoryRecord[];
}

/** What the archive is read against: this host session, the current branch's evidence, and the runs this process started. */
export interface ArchiveScope {
	current: string;
	evidence: readonly BranchEvidence[];
	/** The history ids of runs this Pi process started, which are its own to finish and never an earlier process's. */
	started?: ReadonlySet<string>;
}

/**
 * The ancestor host sessions the current branch names, first seen first, which are the only other history files an
 * archive reads: an ancestor file holds runs of branches this one left, and only what the branch recorded is its own.
 */
export function archiveSessions(evidence: readonly BranchEvidence[], current: string): string[] {
	const sessions = new Set<string>();
	for (const entry of evidence) {
		if (entry.hostSessionId && entry.hostSessionId !== current) sessions.add(entry.hostSessionId);
	}
	return [...sessions];
}

/**
 * Why the current branch may show a record: `recorded` when its own entries allow it, `lineage` when only the parent
 * its launch request named does, which vouches for that request and never for any child the run itself reported.
 */
export type ArchiveAdmission = "recorded" | "lineage";

/** The states of a run that ended with no child the host accepted, or that a process left going. */
const UNSETTLED: ReadonlySet<string> = new Set(["failed", "aborted", "cancelled", "running", "waiting"]);

/**
 * A request field long enough that the history may have cut it: `cap` keeps `MAX_STRING_CHARS` and drops a trailing
 * high surrogate, with no flag either way, so a value this long may be the start of the parent it named, not that one.
 */
const exactRequest = (value: string | undefined): value is string => typeof value === "string" && value.length > 0 && value.length < MAX_STRING_CHARS - 1;

/**
 * Whether a record of this host session that ended without an accepted child, or was left going, asked to continue a
 * child the current branch recorded for its handle: the parent its resume or fork request named is exactly the one an
 * entry of the same handle and backend accepted, superseded or not and whichever host session wrote it. A Pi parent
 * is its session id and file together, checkpoint aside. A request that names no parent, names one only in part, may
 * have been cut, or carries another backend's tag proves nothing, and nothing here becomes a reference.
 */
function launchedFromBranch(record: ArchiveIdentity, evidence: readonly BranchEvidence[]): boolean {
	const request = record.session;
	const backend = record.backend ?? "claude";
	if (!UNSETTLED.has(record.state) || !request || (request.backend !== undefined && request.backend !== backend)) return false;
	const parent = request.kind === "resume" ? request.id : request.kind === "fork" ? request.from : undefined;
	if (!exactRequest(parent)) return false;
	if (backend === "pi") {
		const file = request.file;
		if (!exactRequest(file)) return false;
		return evidence.some((entry) => entry.handle === record.handle && entry.backend === "pi" && entry.session?.backend === "pi" && entry.session.sessionId === parent && entry.session.sessionFile === file);
	}
	if (backend === "codex") {
		return evidence.some((entry) => entry.handle === record.handle && entry.backend === "codex" && entry.session?.backend === "codex" && entry.session.sessionId === parent);
	}
	if (backend !== "claude") return false;
	return evidence.some((entry) => entry.handle === record.handle && entry.backend === "claude" && (entry.session?.sessionId ?? entry.sessionId) === parent);
}

/**
 * Why a history record of the file for `source` belongs on the current branch, or undefined when it does not. A record
 * of this host session that the branch never recorded is readable, because a run killed in flight or refused before
 * its entry left none; one whose child contradicts every entry this session wrote for its handle ran on a branch this
 * one left, unless it failed, stopped or was left going after asking to continue a child the branch recorded, which
 * no entry of its own could say. An ancestor's record needs an entry naming its host session, handle, backend and
 * child, since its file also holds the runs of every other branch of that session. An entry with no host session
 * predates the field and is this one's.
 */
export function archiveAdmission(record: ArchiveIdentity, source: string, scope: ArchiveScope): ArchiveAdmission | undefined {
	if (record.hostSessionId !== source) return undefined;
	if (source === scope.current) {
		const mine = scope.evidence.filter((entry) => entry.handle === record.handle && (!entry.hostSessionId || entry.hostSessionId === source));
		if (!mine.length || mine.some((entry) => sameChild(record, entry))) return "recorded";
		return launchedFromBranch(record, scope.evidence) ? "lineage" : undefined;
	}
	const backend = record.backend ?? "claude";
	return scope.evidence.some((entry) => entry.hostSessionId === source && entry.handle === record.handle && entry.backend === backend && sameChild(record, entry)) ? "recorded" : undefined;
}

/** Whether a history record of the file for `source` belongs on the current branch, for either reason. */
export function archiveEligible(record: ArchiveIdentity, source: string, scope: ArchiveScope): boolean {
	return archiveAdmission(record, source, scope) !== undefined;
}

/**
 * The history records the current branch may show, each run invocation once by its history id and never folded by
 * handle, oldest first. A record left running or waiting by a process that is gone reads as aborted, with nothing to
 * answer, and is never written back here. Records are handed back as the history kept them otherwise: one with no
 * child identity stays a diagnostic, and nothing here adds a reference, a continuation or any other authority.
 */
export function archiveRecords(sources: readonly ArchiveSource[], scope: ArchiveScope): HistoryRecord[] {
	const kept = new Map<string, HistoryRecord>();
	for (const source of sources) {
		for (const record of source.records) {
			if (kept.has(record.id) || !archiveEligible(record, source.hostSessionId, scope)) continue;
			kept.set(record.id, scope.started?.has(record.id) ? record : (asEnded(record) ?? record));
		}
	}
	return [...kept.values()].sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * What the history never saves about a run, so no archived run has it: not zero, absent. A live run's log, tool calls,
 * tasks, thinking, cache and per-model usage, agent and error counts, turns, API time, context, denied tools, its
 * activity and question, and when its child last reported, all stay in the memory of the process that watched it.
 */
export const ARCHIVE_NOT_SAVED = [
	"activity",
	"question",
	"lastEventAt",
	"log",
	"calls",
	"tasks",
	"thinking",
	"cache",
	"models",
	"agentToolCalls",
	"toolErrors",
	"numTurns",
	"apiMs",
	"context",
	"deniedTools",
] as const;

/**
 * Why an archived view lacks something, beyond what no archived run has: no usage at all, no cost in it, no
 * changed-file count, a count without its list, no report, or an end time the run never recorded because nobody
 * finished it.
 */
export type ArchiveAbsence = (typeof ARCHIVE_NOT_SAVED)[number] | "usage" | "cost" | "files" | "fileList" | "report" | "endedAt";

/** A finished state an archived run can show. */
export type ArchiveStatus = "done" | "failed" | "aborted" | "cancelled";

/**
 * One archived invocation as the run list shows it: small, bounded by the history's own field caps, and carrying no
 * prompt or report. `provenance` says it came from disk history, and `unavailable` names every field it lacks, so a
 * reader never shows a missing measurement as a zero. It names no continuation, control or question of any kind.
 */
export interface ArchiveSummary {
	id: string;
	handle?: string;
	backend: BackendName;
	background?: true;
	role: string;
	model: string;
	effort?: string;
	title?: string;
	tool?: string;
	toolCallId?: string;
	hostSessionId: string;
	origin?: string;
	reviews?: string;
	reviewedBy?: string;
	status: ArchiveStatus;
	startedAt: number;
	endedAt?: number;
	provenance: "history";
	/** Set for a run a Pi process that is gone left running or waiting: it reads aborted, and nobody can answer it. */
	interrupted?: true;
	/** What the child confirmed it ran with, when the outcome the host accepted said so. */
	selection?: ResolvedSelection;
	/** The counters the history saved, exactly those: a field it never had is absent, never zero. */
	usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number; workflowTokens?: number; toolCalls?: number };
	filesChanged?: number;
	reportFlags?: string[];
	unavailable: ArchiveAbsence[];
}

/**
 * One archived invocation in full, read from its file when asked for and never kept. `session` is the launch request
 * and `ref` the session the backend verified, each exactly as saved; a run with neither names no child at all.
 */
export interface ArchiveDetail extends ArchiveSummary {
	prompt: string;
	promptTruncated: boolean;
	contract?: string;
	session?: RunSession;
	/** The Claude session id the run reported, which is the flat field every Claude reader has always used. */
	sessionId?: string;
	ref?: SessionRef;
	files?: ChangedFile[];
	/** True when the history kept fewer changed paths than the run changed. */
	filesTruncated: boolean;
	report?: string;
	reportTruncated: boolean;
	failure?: string;
	failureTruncated: boolean;
	/**
	 * Set when `sessionId` is only what the run reported: the branch showed this run for the parent its request named,
	 * never for that id, and no reference the host accepted names it. It stays readable, and nothing offers to resume it.
	 */
	diagnosticSessionId?: true;
}

/**
 * The record as a finished run, through `asEnded` when a gone process left it going, and whether a gone process left
 * it going: either as it was, or as a later process on the same host session already wrote `asEnded`'s correction
 * back, which is that state, that failure and an end dated at the start when nobody recorded one.
 */
function archivedView(record: HistoryRecord): { view: RestoredView; interrupted: boolean } | undefined {
	const ended = asEnded(record);
	const corrected = ended === undefined && record.state === "aborted" && record.failure === HISTORY_ABORTED;
	const view = restoredView(ended ?? record, record.startedAt);
	if (!view) return undefined;
	// `asEnded`'s stand-in end is the start, which is no time the run actually ended: an end it kept is a real one.
	if ((ended && record.endedAt === undefined) || (corrected && record.endedAt === record.startedAt)) delete view.endedAt;
	return { view, interrupted: ended !== undefined || corrected };
}

function summaryOf(view: RestoredView, interrupted: boolean, source: string): ArchiveSummary {
	const unavailable: ArchiveAbsence[] = [...ARCHIVE_NOT_SAVED];
	const summary: ArchiveSummary = {
		id: view.id,
		backend: view.backend,
		role: view.role,
		model: view.model,
		hostSessionId: view.hostSessionId ?? source,
		status: view.status as ArchiveStatus,
		startedAt: view.startedAt,
		provenance: "history",
		unavailable,
	};
	if (view.handle !== undefined) summary.handle = view.handle;
	if (view.background) summary.background = true;
	if (view.effort !== undefined) summary.effort = view.effort;
	if (view.title !== undefined) summary.title = view.title;
	if (view.tool !== undefined) summary.tool = view.tool;
	if (view.toolCallId !== undefined) summary.toolCallId = view.toolCallId;
	if (view.origin !== undefined) summary.origin = view.origin;
	if (view.reviews !== undefined) summary.reviews = view.reviews;
	if (view.reviewedBy !== undefined) summary.reviewedBy = view.reviewedBy;
	if (view.endedAt !== undefined) summary.endedAt = view.endedAt;
	else unavailable.push("endedAt");
	if (interrupted) summary.interrupted = true;
	if (view.selection !== undefined) summary.selection = { ...view.selection };
	if (view.usage !== undefined) {
		summary.usage = { ...view.usage };
		if (view.usage.costUsd === undefined) unavailable.push("cost");
	} else unavailable.push("usage");
	if (view.filesTotal !== undefined) summary.filesChanged = view.filesTotal;
	else unavailable.push("files");
	if (view.files === undefined) unavailable.push("fileList");
	if (view.reportFlags !== undefined) summary.reportFlags = [...view.reportFlags];
	if (view.report === undefined) unavailable.push("report");
	return summary;
}

/** An archived record as the run list shows it, or undefined when it is no record this module can show. */
export function archiveSummary(record: HistoryRecord, source: string = record.hostSessionId): ArchiveSummary | undefined {
	const archived = archivedView(record);
	return archived && summaryOf(archived.view, archived.interrupted, source);
}

/** An archived record in full: what it was asked, what it did, what it changed, and the child it verified, as saved. */
export function archiveDetail(record: HistoryRecord, source: string = record.hostSessionId): ArchiveDetail | undefined {
	const archived = archivedView(record);
	if (!archived) return undefined;
	const { view } = archived;
	const detail: ArchiveDetail = {
		...summaryOf(view, archived.interrupted, source),
		prompt: view.prompt ?? "",
		promptTruncated: view.promptTruncated,
		filesTruncated: view.files !== undefined && view.filesTotal !== undefined && view.files.length < view.filesTotal,
		reportTruncated: view.reportTruncated,
		failureTruncated: view.failureTruncated,
	};
	if (view.contract !== undefined) detail.contract = view.contract;
	if (view.session !== undefined) detail.session = { ...view.session };
	if (view.sessionId !== undefined) detail.sessionId = view.sessionId;
	if (view.ref !== undefined) detail.ref = { ...view.ref };
	if (view.files !== undefined) detail.files = view.files.map((file) => ({ ...file }));
	if (view.report !== undefined) detail.report = view.report;
	if (view.failure !== undefined) detail.failure = view.failure;
	return detail;
}

/** The part of `History` an archive reads with, and nothing that writes: `History` is one. */
export interface ArchiveReader {
	loadStamped(hostSessionId: string): StampedLoad;
	stamp(hostSessionId: string): string | undefined;
}

/** What the index keeps of one record between requests: its identity for eligibility and its summary, no body. */
interface Candidate {
	identity: ArchiveIdentity;
	/** Set for a record left running or waiting, which a run this process started shows live, never from here. */
	going: boolean;
	summary: ArchiveSummary;
}

/** What the index keeps of one file: which file it read, whether it must read it again, and what it found there. */
interface CachedFile {
	stamp?: string;
	stale: boolean;
	candidates: Candidate[];
}

function identityOf(record: HistoryRecord): ArchiveIdentity {
	const identity: ArchiveIdentity = { hostSessionId: record.hostSessionId, handle: record.handle, state: record.state };
	if (record.backend !== undefined) identity.backend = record.backend;
	if (record.ref !== undefined) identity.ref = { ...record.ref };
	if (record.sessionId !== undefined) identity.sessionId = record.sessionId;
	// Only the parent a resume or fork named and its file: a fork's own new id and any checkpoint decide nothing here.
	const request = record.session;
	if (request && request.kind !== "new") {
		const lineage: NonNullable<ArchiveIdentity["session"]> = { kind: request.kind };
		if (request.kind === "resume" && request.id !== undefined) lineage.id = request.id;
		if (request.kind === "fork" && request.from !== undefined) lineage.from = request.from;
		if (request.file !== undefined) lineage.file = request.file;
		if (request.backend !== undefined) lineage.backend = request.backend;
		identity.session = lineage;
	}
	return identity;
}

function candidatesOf(records: readonly HistoryRecord[], source: string): Candidate[] {
	const candidates: Candidate[] = [];
	for (const record of records) {
		const summary = archiveSummary(record, source);
		if (summary) candidates.push({ identity: identityOf(record), going: record.state === "running" || record.state === "waiting", summary });
	}
	return candidates;
}

function scopeOf(scope: ArchiveScope): ArchiveScope {
	const evidence = scope.evidence.map((entry): BranchEvidence => {
		const copy: BranchEvidence = { handle: entry.handle };
		if (entry.hostSessionId !== undefined) copy.hostSessionId = entry.hostSessionId;
		if (entry.backend !== undefined) copy.backend = entry.backend;
		if (entry.session !== undefined) copy.session = { ...entry.session };
		if (entry.sessionId !== undefined) copy.sessionId = entry.sessionId;
		return copy;
	});
	return { current: scope.current, evidence, started: new Set(scope.started ?? []) };
}

/** A record the branch may show: the file it came from, what the index keeps of it, and why it may be shown. */
interface Shown {
	source: string;
	candidate: Candidate;
	admission: ArchiveAdmission;
}

/**
 * Whether a detail's Claude session id is one only the run itself reported, on a record the branch shows through its
 * request alone: no entry and no accepted reference confirms it, so it is a diagnostic and never a session to resume.
 */
function diagnosticOnly(detail: ArchiveDetail, admission: ArchiveAdmission): boolean {
	if (admission !== "lineage" || detail.backend !== "claude" || detail.sessionId === undefined) return false;
	return !(detail.ref?.backend === "claude" && detail.ref.sessionId === detail.sessionId);
}

/** Newest first, then by id, which is the order a page of older runs walks. */
const newestFirst = (left: ArchiveSummary, right: ArchiveSummary): number => right.startedAt - left.startedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

/**
 * The archived runs the current branch may show, from the history files of this host session and of the ancestors
 * the branch names, and no other file. Between requests it keeps one summary and the identity eligibility reads per
 * record, never a prompt, report or failure: `detail` reads the file again and keeps nothing of it. A file is read
 * again when its stamp moved or `invalidate` named it, so a record the history pruned or rewrote never outlives the
 * file that held it. It reads through `ArchiveReader`, which is `History`'s own validation, and writes nothing.
 *
 * `refresh(scope)` brings the index up to date with the branch, the started runs and the files, and `revision` moves
 * whenever what `summaries` returns may have changed, including through a `detail` that found a file changed.
 */
export class ArchiveIndex {
	private readonly reader: ArchiveReader;
	private readonly warn: ((warning: string) => void) | undefined;
	private readonly files = new Map<string, CachedFile>();
	private sessions: string[] = [];
	private scope: ArchiveScope | undefined;
	private shown: Shown[] = [];
	private readonly byId = new Map<string, Shown>();
	private signature = "";
	private changes = 0;

	constructor(reader: ArchiveReader, warn?: (warning: string) => void) {
		this.reader = reader;
		this.warn = warn;
	}

	/** Moves whenever the summaries may have changed, so a reader holding a page knows to ask again. */
	get revision(): number {
		return this.changes;
	}

	/** Makes the next read of one session's file, or of every file, read it again whatever its stamp says. */
	invalidate(hostSessionId?: string): void {
		for (const [session, cached] of this.files) {
			if (hostSessionId === undefined || session === hostSessionId) cached.stale = true;
		}
	}

	/** Reads what moved and recomputes what the branch may show; returns the revision that leaves. */
	refresh(scope: ArchiveScope): number {
		const held = scopeOf(scope);
		const sessions = [held.current, ...archiveSessions(held.evidence, held.current)];
		for (const session of [...this.files.keys()]) {
			if (!sessions.includes(session)) this.files.delete(session);
		}
		for (const session of sessions) {
			const cached = this.files.get(session);
			if (cached && !cached.stale && cached.stamp !== undefined && this.reader.stamp(session) === cached.stamp) continue;
			this.read(session);
		}
		this.sessions = sessions;
		this.scope = held;
		this.rebuild();
		return this.changes;
	}

	/** Every archived run the branch may show, newest first, as copies the caller may change freely. */
	summaries(): ArchiveSummary[] {
		return this.shown.map(({ candidate }) => structuredClone(candidate.summary));
	}

	/**
	 * The runs strictly older than `before` in the order `summaries` gives, or the newest when it is left out, as copies.
	 * A position is a start time and an id, not an offset, so runs archived since a page was read never repeat on the next.
	 */
	page(before: ArchiveKey | undefined, size: number): ArchivePage {
		const shown = this.shown;
		let start = 0;
		if (before !== undefined) {
			start = shown.findIndex(({ candidate }) => candidate.summary.startedAt < before.startedAt || (candidate.summary.startedAt === before.startedAt && candidate.summary.id < before.id));
			if (start < 0) start = shown.length;
		}
		const taken = shown.slice(start, start + Math.max(0, size));
		const last = taken.at(-1)?.candidate.summary;
		const page: ArchivePage = { entries: taken.map(({ candidate }) => structuredClone(candidate.summary)), total: shown.length };
		if (last && start + taken.length < shown.length) page.next = { startedAt: last.startedAt, id: last.id };
		return page;
	}

	/** One archived run in full, read from its file now, or undefined when the branch may not show it any more. */
	detail(id: string): ArchiveDetail | undefined {
		const held = this.byId.get(id);
		if (!held) return undefined;
		// The whole file is read for this one record anyway, so the index takes what the file says now as well.
		const records = this.read(held.source);
		this.rebuild();
		const now = this.byId.get(id);
		if (now?.source !== held.source) return undefined;
		const record = records.find((entry) => entry.id === id);
		const detail = record && archiveDetail(record, held.source);
		if (detail && diagnosticOnly(detail, now.admission)) detail.diagnosticSessionId = true;
		return detail;
	}

	private read(session: string): HistoryRecord[] {
		const loaded = this.reader.loadStamped(session);
		if (loaded.warning) this.warn?.(loaded.warning);
		this.files.set(session, { ...(loaded.stamp === undefined ? {} : { stamp: loaded.stamp }), stale: false, candidates: candidatesOf(loaded.records, session) });
		return loaded.records;
	}

	private rebuild(): void {
		const scope = this.scope;
		this.byId.clear();
		const shown: Shown[] = [];
		if (scope) {
			for (const session of this.sessions) {
				for (const candidate of this.files.get(session)?.candidates ?? []) {
					const id = candidate.summary.id;
					if (this.byId.has(id) || (candidate.going && scope.started?.has(id))) continue;
					const admission = archiveAdmission(candidate.identity, session, scope);
					if (admission === undefined) continue;
					const entry: Shown = { source: session, candidate, admission };
					this.byId.set(id, entry);
					shown.push(entry);
				}
			}
		}
		shown.sort((left, right) => newestFirst(left.candidate.summary, right.candidate.summary));
		this.shown = shown;
		// Why a run is shown is part of it: a detail read for another reason may offer another resume.
		const signature = JSON.stringify([shown.map(({ source, candidate, admission }) => [source, candidate.summary.id, admission]), this.sessions.map((session) => this.files.get(session)?.stamp ?? null)]);
		if (signature !== this.signature) {
			this.signature = signature;
			this.changes++;
		}
	}
}
