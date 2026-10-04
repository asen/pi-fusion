import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PiSessionRef } from "../extensions/backends/types.ts";
import {
	ARCHIVE_NOT_SAVED,
	type ArchiveReader,
	type ArchiveScope,
	ArchiveIndex,
	archiveAdmission,
	archiveDetail,
	archiveEligible,
	archiveRecords,
	archiveSessions,
	archiveSummary,
} from "../extensions/dashboard-archive.ts";
import { RunStore } from "../extensions/dashboard.ts";
import { branchEvidence, runRecords } from "../extensions/fusion.ts";
import { asEnded, History, HISTORY_ABORTED, HISTORY_PROMPT_CAP_BYTES, HISTORY_VERSION, type HistoryRecord, MAX_HISTORY_FILE_BYTES } from "../extensions/history.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");

const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });

const claudeEntry = (run: string, hostSessionId: string, sessionId: string, checkpoint = "c-1") => entry({ run, role: "implement", backend: "claude", hostSessionId, sessionId, checkpoint, model: "opus", effort: "high" });

const PI_REF: PiSessionRef = { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" };
const PI_SELECTION = { model: "deepseek/deepseek-chat", effort: "medium" };

/** A null session is an entry that recorded none, which is what a failed Pi run with no verified session leaves. */
const piEntry = (run: string, hostSessionId: string, session: PiSessionRef | null = PI_REF) =>
	entry({ run, role: "implement", backend: "pi", hostSessionId, ...(session ? { session: { ...session } } : {}), selection: { ...PI_SELECTION } });

const record = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
	id: "id-1",
	handle: "run-1",
	role: "implement",
	model: "opus",
	hostSessionId: "host-2",
	cwd: "/work",
	origin: "tool",
	state: "done",
	startedAt: 1_000,
	endedAt: 2_000,
	prompt: "do it",
	report: "done",
	backend: "claude",
	sessionId: "s-1",
	...over,
});

const piRecord = (over: Partial<HistoryRecord> = {}): HistoryRecord => {
	const held = record({ backend: "pi", ref: { ...PI_REF }, selection: { ...PI_SELECTION }, ...over });
	delete held.sessionId;
	return held;
};

const scope = (branch: readonly unknown[], current = "host-2", started?: ReadonlySet<string>): ArchiveScope => ({ current, evidence: branchEvidence(branch), ...(started ? { started } : {}) });

const ids = (records: ReadonlyArray<{ id: string }>): string[] => records.map((held) => held.id);

test("branch evidence keeps every valid entry in branch order, superseded ones too, while runRecords keeps the latest per handle", () => {
	const branch = [claudeEntry("run-1", "host-1", "s-1"), claudeEntry("run-2", "host-1", "s-2"), claudeEntry("run-1", "host-2", "s-9")];
	const evidence = branchEvidence(branch);
	assert.deepEqual(
		evidence.map((held) => [held.handle, held.hostSessionId, held.sessionId]),
		[
			["run-1", "host-1", "s-1"],
			["run-2", "host-1", "s-2"],
			["run-1", "host-2", "s-9"],
		],
	);
	const latest = runRecords(branch);
	assert.equal(latest.runs.size, 2);
	assert.equal(latest.runs.get("run-1")?.sessionId, "s-9", "continuation still reads the last entry for a handle");
	assert.equal(latest.highest, 2);
});

test("invalid custom entries are no evidence and vouch for nothing", () => {
	const invalid = [
		null,
		"pi-fusion",
		{ type: "message", customType: "pi-fusion", data: { run: "run-1", role: "implement", hostSessionId: "host-1", sessionId: "s-1" } },
		{ type: "custom", customType: "pi-fusion-run", data: { run: "run-1", role: "implement", hostSessionId: "host-1", sessionId: "s-1" } },
		entry({ run: "run-1", role: "nobody", hostSessionId: "host-1", sessionId: "s-1" }),
		entry({ run: "run-01", role: "implement", hostSessionId: "host-1", sessionId: "s-1" }),
		entry({ run: "job-1", role: "implement", hostSessionId: "host-1", sessionId: "s-1" }),
		{ type: "custom", customType: "pi-fusion" },
	];
	assert.deepEqual(branchEvidence(invalid), []);
	const ancestor = record({ hostSessionId: "host-1" });
	assert.equal(archiveEligible(ancestor, "host-1", scope(invalid)), false);
	assert.deepEqual(archiveSessions(branchEvidence(invalid), "host-2"), []);
	// An entry under a backend this host does not know keeps its handle on the branch but names no backend to match.
	const unknown = [entry({ run: "run-1", role: "implement", backend: "elsewhere", hostSessionId: "host-1", sessionId: "s-1" })];
	assert.equal(branchEvidence(unknown).length, 1);
	assert.equal(archiveEligible(ancestor, "host-1", scope(unknown)), false);
});

test("a repeated handle keeps every invocation by its history id, whatever checkpoint each one ended on", () => {
	const branch = [claudeEntry("run-1", "host-2", "s-1", "c-1"), claudeEntry("run-1", "host-2", "s-1", "c-2"), piEntry("run-2", "host-2", { ...PI_REF, checkpoint: "entry-7" })];
	const sources = [
		{
			hostSessionId: "host-2",
			records: [
				record({ id: "a", startedAt: 1 }),
				record({ id: "b", startedAt: 2, checkpoint: "c-1" }),
				record({ id: "c", startedAt: 3, checkpoint: "c-2" }),
				piRecord({ id: "d", handle: "run-2", startedAt: 4 }),
				piRecord({ id: "e", handle: "run-2", startedAt: 5, ref: { ...PI_REF, checkpoint: "entry-7" } }),
			],
		},
	];
	assert.deepEqual(ids(archiveRecords(sources, scope(branch))), ["a", "b", "c", "d", "e"]);
	// One history id is one invocation, so a duplicate of it in another file is not a second row.
	const twice = [...sources, { hostSessionId: "host-2", records: [record({ id: "a", startedAt: 1 })] }];
	assert.deepEqual(ids(archiveRecords(twice, scope(branch))), ["a", "b", "c", "d", "e"]);
	assert.deepEqual(ids(archiveRecords([{ hostSessionId: "host-2", records: [record({ id: "z", startedAt: 1 }), record({ id: "y", startedAt: 1 })] }], scope(branch))), ["y", "z"], "ties are ordered by id");
});

test("a host fork that changed the child keeps the ancestor's run through its superseded entry", () => {
	for (const backend of ["claude", "pi"] as const) {
		const forked: PiSessionRef = { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: "entry-2" };
		const branch =
			backend === "claude"
				? [claudeEntry("run-2", "host-1", "s-1"), claudeEntry("run-2", "host-2", "s-2")]
				: [piEntry("run-2", "host-1"), piEntry("run-2", "host-2", forked)];
		const original = backend === "claude" ? record({ id: "h1-a", handle: "run-2", hostSessionId: "host-1" }) : piRecord({ id: "h1-a", handle: "run-2", hostSessionId: "host-1" });
		// Another branch of the ancestor session gave the same handle another child, which this branch never recorded.
		const elsewhere =
			backend === "claude"
				? record({ id: "h1-b", handle: "run-2", hostSessionId: "host-1", sessionId: "s-other" })
				: piRecord({ id: "h1-b", handle: "run-2", hostSessionId: "host-1", ref: { ...PI_REF, sessionId: "pi-other", sessionFile: "/sessions/pi-other.jsonl" } });
		const continued = backend === "claude" ? record({ id: "h2-a", handle: "run-2", startedAt: 3_000, sessionId: "s-2" }) : piRecord({ id: "h2-a", handle: "run-2", startedAt: 3_000, ref: { ...forked } });
		const sources = [
			{ hostSessionId: "host-2", records: [continued] },
			{ hostSessionId: "host-1", records: [original, elsewhere] },
		];
		assert.deepEqual(archiveSessions(branchEvidence(branch), "host-2"), ["host-1"], backend);
		assert.deepEqual(ids(archiveRecords(sources, scope(branch))), ["h1-a", "h2-a"], backend);
		const latest = runRecords(branch).runs.get("run-2");
		assert.equal(latest?.hostSessionId, "host-2", `${backend}: continuation authority is still the fork's entry`);
	}
});

test("a record of this host session the branch never recorded stays readable, identity or none", () => {
	const branch = [claudeEntry("run-1", "host-2", "s-1")];
	const records = [
		record({ id: "a", handle: "run-5" }),
		piRecord({ id: "b", handle: "run-6" }),
		(() => {
			const held = piRecord({ id: "c", handle: "run-7", state: "failed", failure: "it broke" });
			delete held.ref;
			delete held.selection;
			return held;
		})(),
	];
	assert.deepEqual(ids(archiveRecords([{ hostSessionId: "host-2", records }], scope(branch))), ["a", "b", "c"]);
	assert.deepEqual(ids(archiveRecords([{ hostSessionId: "host-2", records }], scope([]))), ["a", "b", "c"], "an empty branch contradicts nothing");
});

test("a record whose child contradicts every entry this session wrote for its handle is left out", () => {
	const claude = [claudeEntry("run-3", "host-2", "s-3")];
	assert.equal(archiveEligible(record({ handle: "run-3", sessionId: "s-other" }), "host-2", scope(claude)), false);
	assert.equal(archiveEligible(record({ handle: "run-3", sessionId: "s-3" }), "host-2", scope(claude)), true);
	// One matching entry is enough: an earlier one for the handle does not contradict a later invocation.
	assert.equal(archiveEligible(record({ handle: "run-3", sessionId: "s-3" }), "host-2", scope([claudeEntry("run-3", "host-2", "s-0"), ...claude])), true);
	assert.equal(archiveEligible(record({ handle: "run-3", backend: "pi", sessionId: undefined, ref: { ...PI_REF } }), "host-2", scope(claude)), false, "another backend is another child");
	const piHandleOnly = [piEntry("run-4", "host-2", null)];
	assert.equal(archiveEligible(piRecord({ handle: "run-4" }), "host-2", scope(piHandleOnly)), false, "an identity against an entry with none is no match");
	const noRef = piRecord({ handle: "run-4" });
	delete noRef.ref;
	assert.equal(archiveEligible(noRef, "host-2", scope([piEntry("run-4", "host-2")])), false, "no identity against an entry with one is no match");
	// An entry of the ancestor session for the same handle says nothing about this session's run of it.
	assert.equal(archiveEligible(record({ handle: "run-3", sessionId: "s-new" }), "host-2", scope([claudeEntry("run-3", "host-1", "s-3")])), true);
});

test("a pi identity is the accepted session id and file together, and the checkpoint is no part of it", () => {
	for (const source of ["host-2", "host-1"]) {
		const branch = [piEntry("run-1", source)];
		const at = (ref: PiSessionRef) => archiveEligible(piRecord({ hostSessionId: source, ref }), source, scope(branch));
		assert.equal(at({ ...PI_REF }), true, source);
		assert.equal(at({ ...PI_REF, checkpoint: "entry-99" }), true, `${source}: another checkpoint is the same child`);
		const { checkpoint, ...bare } = PI_REF;
		assert.equal(at(bare as PiSessionRef), true, `${source}: no checkpoint is the same child`);
		assert.equal(at({ ...PI_REF, sessionFile: "/sessions/other.jsonl" }), false, `${source}: same id, another file`);
		assert.equal(at({ ...PI_REF, sessionId: "pi-other" }), false, `${source}: same file, another id`);
		// A flat id a Pi child reported is a diagnostic, never an identity that could stand in for the reference.
		const flat = piRecord({ hostSessionId: source, sessionId: "pi-1" });
		delete flat.ref;
		assert.equal(archiveEligible(flat, source, scope(branch)), false, `${source}: a flat id is not the reference`);
	}
});

test("legacy claude records and entries match as every claude reader has always matched them", () => {
	const untagged = record({ hostSessionId: "host-1", handle: "run-2" });
	delete untagged.backend;
	const legacyBranch = [entry({ consolidatorGeneration: 1, consolidatorSessionId: "s-1", consolidatorCheckpoint: "c-1", hostSessionId: "host-1" })];
	assert.equal(archiveEligible(untagged, "host-1", scope(legacyBranch)), true, "an untagged record is claude, and a consolidator entry is run-(g+1)");
	assert.equal(archiveEligible({ ...untagged, sessionId: "s-other" }, "host-1", scope(legacyBranch)), false);
	const untaggedEntry = [entry({ run: "run-2", role: "plan", hostSessionId: "host-1", sessionId: "s-1" })];
	assert.equal(archiveEligible(untagged, "host-1", scope(untaggedEntry)), true, "an entry without a backend is claude");
	// A side with no id has always matched a Claude run, which is what a run that never reported one needs.
	const noId = record({ hostSessionId: "host-1", handle: "run-2" });
	delete noId.sessionId;
	assert.equal(archiveEligible(noId, "host-1", scope(untaggedEntry)), true);
	assert.equal(archiveEligible(record({ hostSessionId: "host-1", handle: "run-2" }), "host-1", scope([entry({ run: "run-2", role: "plan", hostSessionId: "host-1" })])), true);
	// An entry from before host sessions were recorded is this session's, never evidence for an ancestor.
	const sessionless = [entry({ run: "run-2", role: "plan", sessionId: "s-1" })];
	assert.equal(archiveEligible(record({ handle: "run-2", sessionId: "s-other" }), "host-2", scope(sessionless)), false);
	assert.equal(archiveEligible(record({ handle: "run-2" }), "host-2", scope(sessionless)), true);
	assert.equal(archiveEligible(record({ handle: "run-2", hostSessionId: "host-1" }), "host-1", scope(sessionless)), false);
	assert.deepEqual(archiveSessions(branchEvidence(sessionless), "host-2"), []);
});

test("an ancestor file gives only what the branch recorded of it, and an unrelated session file gives nothing", () => {
	const branch = [claudeEntry("run-1", "host-1", "s-1"), claudeEntry("run-2", "host-2", "s-2")];
	const sources = [
		{ hostSessionId: "host-2", records: [record({ id: "mine", handle: "run-2", sessionId: "s-2" })] },
		{
			hostSessionId: "host-1",
			records: [
				record({ id: "kept", handle: "run-1", hostSessionId: "host-1" }),
				record({ id: "unrecorded", handle: "run-7", hostSessionId: "host-1", sessionId: "s-7" }),
				record({ id: "other-backend", handle: "run-1", hostSessionId: "host-1", backend: "pi", sessionId: undefined, ref: { ...PI_REF } }),
				record({ id: "misfiled", handle: "run-1", hostSessionId: "host-3" }),
			],
		},
		{ hostSessionId: "host-9", records: [record({ id: "unrelated", handle: "run-1", hostSessionId: "host-9" })] },
	];
	assert.deepEqual(archiveSessions(branchEvidence(branch), "host-2"), ["host-1"]);
	assert.deepEqual(ids(archiveRecords(sources, scope(branch))), ["kept", "mine"]);
	// The entry of the current session for run-2 vouches for nothing in the ancestor's file.
	assert.equal(archiveEligible(record({ handle: "run-2", hostSessionId: "host-1", sessionId: "s-2" }), "host-1", scope(branch)), false);
	// The pi child of a handle in the ancestor needs a pi entry of its own there.
	const piBranch = [piEntry("run-1", "host-1")];
	assert.equal(archiveEligible(piRecord({ handle: "run-1", hostSessionId: "host-1" }), "host-1", scope(piBranch)), true);
	assert.equal(archiveEligible(record({ handle: "run-1", hostSessionId: "host-1" }), "host-1", scope(piBranch)), false);
});

test("a run an earlier process left going reads as aborted, without touching what the history gave back", () => {
	const branch = [claudeEntry("run-1", "host-1", "s-1"), claudeEntry("run-2", "host-2", "s-2")];
	const ancestor = record({ id: "old", handle: "run-1", hostSessionId: "host-1", state: "waiting", startedAt: 10, endedAt: undefined, report: undefined });
	delete ancestor.endedAt;
	const running = record({ id: "gone", handle: "run-2", sessionId: "s-2", state: "running", startedAt: 20 });
	delete running.endedAt;
	const live = record({ id: "live", handle: "run-3", state: "running", startedAt: 30 });
	const sources = [
		{ hostSessionId: "host-2", records: [running, live] },
		{ hostSessionId: "host-1", records: [ancestor] },
	];
	const before = structuredClone(sources);
	const shown = archiveRecords(sources, scope(branch, "host-2", new Set(["live"])));
	assert.deepEqual(
		shown.map((held) => [held.id, held.state, held.endedAt, held.failure]),
		[
			["old", "aborted", 10, HISTORY_ABORTED],
			["gone", "aborted", 20, HISTORY_ABORTED],
			["live", "running", 2_000, undefined],
		],
	);
	assert.deepEqual(sources, before, "the records read are never rewritten");
	assert.ok(!shown.some((held) => held.state === "waiting"), "nothing is left with a question to answer");
});

test("a failed record with no identity stays a diagnostic and gets no reference it never had", () => {
	const failed = piRecord({ id: "f", handle: "run-4", hostSessionId: "host-1", state: "failed", failure: "no session", report: undefined });
	delete failed.ref;
	delete failed.selection;
	delete failed.report;
	const branch = [piEntry("run-4", "host-1", null)];
	const refusal = runRecords(branch).runs.get("run-4")?.refusal ?? "";
	assert.match(refusal, /recorded no verified session/, "the branch still refuses to continue it");
	const shown = archiveRecords([{ hostSessionId: "host-1", records: [failed] }], scope(branch));
	assert.deepEqual(shown, [failed], "the record comes back exactly as kept");
	assert.equal(shown[0]?.ref, undefined);
	assert.equal(shown[0]?.session, undefined);
	assert.equal(shown[0]?.sessionId, undefined);
	// An interrupted one without identity reads as aborted and still names no child.
	const interrupted = { ...failed, id: "i", state: "running" as const };
	const [ended] = archiveRecords([{ hostSessionId: "host-1", records: [interrupted] }], scope(branch));
	assert.equal(ended?.state, "aborted");
	assert.equal(ended?.ref, undefined);
	assert.equal(ended?.sessionId, undefined);
});

function withDir(body: (dir: string) => void): void {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-archive-"));
	try {
		body(path.join(root, "history"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

/** A reader over a real history that counts what it was asked for, so a test can say which files were touched. */
function counting(history: History): ArchiveReader & { loads: string[]; stamps: string[] } {
	const loads: string[] = [];
	const stamps: string[] = [];
	return {
		loads,
		stamps,
		loadStamped: (id) => {
			loads.push(id);
			return history.loadStamped(id);
		},
		stamp: (id) => {
			stamps.push(id);
			return history.stamp(id);
		},
	};
}

/** Every string an object graph holds, Maps and Sets included, so a test can say what an index keeps between requests. */
function strings(value: unknown, seen = new Set<unknown>()): string[] {
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object" || seen.has(value)) return [];
	seen.add(value);
	const parts = value instanceof Map ? [...value.keys(), ...value.values()] : value instanceof Set ? [...value] : Object.values(value);
	return parts.flatMap((part) => strings(part, seen));
}

const FULL_REF: PiSessionRef = { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: "entry-4" };

test("an archived detail gives back what the history saved: inputs, outputs, metadata, usage, files and the verified child", () => {
	withDir((dir) => {
		const history = new History(dir);
		const long = "p".repeat(HISTORY_PROMPT_CAP_BYTES + 10);
		const saved = piRecord({
			id: "full",
			handle: "run-3",
			mode: undefined,
			effort: "high",
			title: "pi-fusion run-3",
			tool: "fusion",
			toolCallId: "call-3",
			reviews: "run-1",
			reviewedBy: "run-4",
			background: true,
			prompt: long,
			report: "## Changed\nfoo.ts\n\n## Review\nlooks fine",
			reportTruncated: true,
			failure: "late warning",
			failureTruncated: true,
			contract: "contracts/implement.md",
			session: { kind: "fork", backend: "pi", from: "pi-1", file: "/sessions/pi-1.jsonl", at: "entry-1" },
			ref: { ...FULL_REF },
			selection: { model: "deepseek/deepseek-chat", effort: "high" },
			files: [{ path: "foo.ts", status: "M", added: 2, removed: 1 }],
			filesTotal: 4,
			usage: { costUsd: 0.5, tokensIn: 40, tokensOut: 9, workflowTokens: 3, toolCalls: 7 },
		});
		delete saved.mode;
		assert.equal(history.save("host-2", "/work", saved), undefined);
		const [read] = history.load("host-2").records;
		assert.ok(read);
		const detail = archiveDetail(read);
		assert.ok(detail);
		assert.equal(detail.provenance, "history");
		assert.equal(detail.interrupted, undefined);
		assert.equal(detail.prompt.length, HISTORY_PROMPT_CAP_BYTES);
		assert.equal(detail.promptTruncated, true, "the history cut the prompt and says so");
		assert.equal(detail.report, saved.report);
		assert.equal(detail.reportTruncated, true, "a saved flag survives a text short enough to fit");
		assert.equal(detail.failure, "late warning");
		assert.equal(detail.failureTruncated, true);
		assert.deepEqual(detail.reportFlags, ["Review"]);
		assert.deepEqual(detail.session, saved.session, "the launch request is the request");
		assert.deepEqual(detail.ref, FULL_REF, "the verified reference is the reference");
		assert.deepEqual(detail.selection, saved.selection);
		assert.equal(detail.sessionId, undefined);
		assert.deepEqual(detail.files, saved.files);
		assert.equal(detail.filesChanged, 4);
		assert.equal(detail.filesTruncated, true);
		assert.deepEqual(detail.usage, saved.usage);
		for (const field of ["handle", "role", "model", "effort", "title", "tool", "toolCallId", "hostSessionId", "origin", "reviews", "reviewedBy", "startedAt", "endedAt", "contract"] as const) {
			assert.equal(detail[field], saved[field], field);
		}
		assert.equal(detail.background, true);
		assert.equal(detail.status, "done");
		assert.deepEqual(detail.unavailable, [...ARCHIVE_NOT_SAVED]);
		const { prompt, promptTruncated, contract, session, ref, files, filesTruncated, report, reportTruncated, failure, failureTruncated, ...summary } = detail;
		assert.deepEqual(archiveSummary(read), summary, "a summary is the detail without its bodies");
	});
});

test("what the history never saved is named as unavailable and is never a zero", () => {
	const bare = record({ id: "bare", state: "failed", report: undefined, failure: "it broke" });
	delete bare.report;
	delete bare.endedAt;
	const summary = archiveSummary(bare);
	assert.ok(summary);
	for (const absent of ARCHIVE_NOT_SAVED) assert.ok(summary.unavailable.includes(absent), absent);
	for (const absent of ["usage", "files", "fileList", "report"] as const) assert.ok(summary.unavailable.includes(absent), absent);
	assert.ok(summary.unavailable.includes("endedAt"), "no end time was saved, so none is shown");
	assert.equal(summary.interrupted, undefined, "a failed run that recorded no end is not one a gone process left going");
	for (const field of ["usage", "filesChanged", "toolCalls", "tokensIn", "toolErrors", "agentToolCalls", "cacheRead", "models", "log", "tasks", "thinking", "question", "activity", "lastEventAt", "updatedAt", "restored"]) {
		assert.ok(!(field in summary), `${field} is absent, not zero`);
	}
	const counted = archiveSummary(record({ id: "counted", filesTotal: 12, usage: { tokensIn: 1, tokensOut: 2, toolCalls: 3 } }));
	assert.ok(counted);
	assert.equal(counted.filesChanged, 12);
	assert.ok(counted.unavailable.includes("fileList"), "the count is there without the list");
	assert.ok(!counted.unavailable.includes("files"));
	assert.ok(counted.unavailable.includes("cost"));
	assert.ok(!counted.unavailable.includes("usage"));
	assert.deepEqual(counted.usage, { tokensIn: 1, tokensOut: 2, toolCalls: 3 });
	const detail = archiveDetail(bare);
	assert.ok(detail);
	assert.equal(detail.files, undefined);
	assert.equal(detail.filesTruncated, false);
	assert.equal(detail.report, undefined);
});

test("a record with no identity names no child, and a launch request never becomes a reference", () => {
	const failed = piRecord({ id: "f", state: "failed", failure: "no session", session: { kind: "fork", backend: "pi", from: "pi-1", file: "/sessions/pi-1.jsonl" } });
	delete failed.ref;
	delete failed.selection;
	const detail = archiveDetail(failed);
	assert.ok(detail);
	assert.equal(detail.ref, undefined);
	assert.equal(detail.selection, undefined);
	assert.equal(detail.sessionId, undefined);
	assert.deepEqual(detail.session, failed.session);
	assert.ok(!("question" in detail), "an archived run has nothing to answer");
	// A reference under another backend's tag is no reference this run can have had.
	const crossed = archiveDetail(record({ id: "x", backend: "claude", ref: { ...FULL_REF } }));
	assert.equal(crossed?.ref, undefined);
});

test("a run a gone process left going reads aborted with no end time, and one this process started is not archived", () => {
	const going = record({ id: "going", state: "waiting" });
	delete going.endedAt;
	const summary = archiveSummary(going);
	assert.ok(summary);
	assert.equal(summary.status, "aborted");
	assert.equal(summary.interrupted, true);
	assert.equal(summary.endedAt, undefined, "asEnded's stand-in end is no time the run ended");
	assert.ok(summary.unavailable.includes("endedAt"));
	assert.equal(archiveDetail(going)?.failure, HISTORY_ABORTED);
	withDir((dir) => {
		const history = new History(dir);
		history.saveAll("host-2", "/work", [record({ id: "mine", state: "running", startedAt: 1 }), record({ id: "old", handle: "run-2", state: "running", startedAt: 2 }), record({ id: "ended", handle: "run-3", startedAt: 3 })]);
		const index = new ArchiveIndex(history);
		index.refresh(scope([], "host-2", new Set(["mine", "ended"])));
		assert.deepEqual(ids(index.summaries()), ["ended", "old"], "a finished run this process started is still archived");
		assert.equal(index.detail("mine"), undefined, "the live store shows a run this process still runs");
		assert.equal(index.detail("old")?.status, "aborted");
		index.refresh(scope([], "host-2"));
		assert.deepEqual(ids(index.summaries()), ["ended", "old", "mine"]);
	});
});

test("the index reads only the current session's file and the ancestors the branch names", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.save("host-2", "/work", record({ id: "mine", handle: "run-2", sessionId: "s-2", startedAt: 3 }));
		history.saveAll("host-1", "/work", [record({ id: "kept", hostSessionId: "host-1", startedAt: 1 }), record({ id: "unrecorded", handle: "run-7", hostSessionId: "host-1", sessionId: "s-7", startedAt: 2 })]);
		history.save("host-9", "/work", record({ id: "unrelated", hostSessionId: "host-9" }));
		const reader = counting(history);
		const index = new ArchiveIndex(reader);
		const branch = [claudeEntry("run-1", "host-1", "s-1"), claudeEntry("run-2", "host-2", "s-2")];
		index.refresh(scope(branch));
		assert.deepEqual(ids(index.summaries()), ["mine", "kept"]);
		assert.deepEqual(reader.loads, ["host-2", "host-1"]);
		assert.equal(index.detail("unrelated"), undefined);
		assert.equal(index.detail("unrecorded"), undefined);
		assert.ok(!reader.loads.includes("host-9") && !reader.stamps.includes("host-9"), "an unrelated session's file is never touched");
		// Nothing changed, so a second refresh only looks at the stamps.
		reader.loads.length = 0;
		const revision = index.revision;
		index.refresh(scope(branch));
		assert.deepEqual(reader.loads, []);
		assert.equal(index.revision, revision);
		// A branch that no longer names the ancestor drops it without reading anything.
		index.refresh(scope([claudeEntry("run-2", "host-2", "s-2")]));
		assert.deepEqual(reader.loads, []);
		assert.deepEqual(ids(index.summaries()), ["mine"]);
		assert.ok(index.revision > revision);
	});
});

test("the index keeps summaries, not bodies, and hands out copies", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.saveAll("host-2", "/work", [
			record({ id: "a", prompt: "PROMPT-BODY-a", report: "## Review\nREPORT-BODY-a", startedAt: 1, files: [{ path: "FILE-PATH-a", status: "M" }] }),
			record({ id: "b", handle: "run-2", prompt: "PROMPT-BODY-b", report: undefined, failure: "FAILURE-BODY-b", state: "failed", startedAt: 2 }),
		]);
		const index = new ArchiveIndex(history);
		index.refresh(scope([]));
		assert.equal(index.detail("a")?.prompt, "PROMPT-BODY-a");
		assert.equal(index.detail("b")?.failure, "FAILURE-BODY-b");
		const kept = strings(index).join("\n");
		for (const body of ["PROMPT-BODY", "REPORT-BODY", "FAILURE-BODY", "FILE-PATH"]) assert.ok(!kept.includes(body), `${body} is not kept between requests`);
		const [first] = index.summaries();
		assert.ok(first);
		assert.deepEqual(first.reportFlags, undefined);
		first.status = "running" as never;
		first.unavailable.length = 0;
		first.usage = { tokensIn: 999 };
		const second = index.summaries().find((held) => held.id === "a");
		assert.deepEqual(second?.reportFlags, ["Review"]);
		const again = index.summaries()[0]!;
		assert.equal(again.status, "failed");
		assert.deepEqual(again.unavailable.slice(0, ARCHIVE_NOT_SAVED.length), [...ARCHIVE_NOT_SAVED]);
		const detail = index.detail("a")!;
		detail.files!.push({ path: "x", status: "A" });
		assert.deepEqual(index.detail("a")?.files, [{ path: "FILE-PATH-a", status: "M" }]);
	});
});

test("a file written since the last read is read again, and what the history pruned or changed goes with it", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.save("host-2", "/work", record({ id: "a", startedAt: 1 }));
		const index = new ArchiveIndex(history);
		const start = index.refresh(scope([]));
		assert.deepEqual(ids(index.summaries()), ["a"]);
		history.save("host-2", "/work", record({ id: "b", handle: "run-2", startedAt: 2 }));
		const added = index.refresh(scope([]));
		assert.ok(added > start);
		assert.deepEqual(ids(index.summaries()), ["b", "a"]);
		// Another writer replaced the file: the detail reads what is there now, and the index follows it.
		const target = path.join(dir, "host-2.json");
		const file = JSON.parse(fs.readFileSync(target, "utf8"));
		file.records = file.records.filter((held: HistoryRecord) => held.id !== "a").map((held: HistoryRecord) => ({ ...held, report: "rewritten" }));
		fs.writeFileSync(`${target}.next`, JSON.stringify(file), { mode: 0o600 });
		fs.renameSync(`${target}.next`, target);
		assert.equal(index.detail("a"), undefined, "a record the file no longer holds has no detail");
		assert.deepEqual(ids(index.summaries()), ["b"]);
		assert.ok(index.revision > added);
		assert.equal(index.detail("b")?.report, "rewritten");
		fs.rmSync(target);
		index.refresh(scope([]));
		assert.deepEqual(index.summaries(), [], "a pruned file takes its records with it");
		assert.equal(index.detail("b"), undefined);
	});
});

test("invalidate makes the next refresh read a file its stamp does not show as changed", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.save("host-2", "/work", record({ id: "a", startedAt: 1 }));
		let loads = 0;
		const reader: ArchiveReader = {
			loadStamped: (id) => {
				loads++;
				return { ...history.loadStamped(id), stamp: "same" };
			},
			stamp: () => "same",
		};
		const index = new ArchiveIndex(reader);
		index.refresh(scope([]));
		history.save("host-2", "/work", record({ id: "b", handle: "run-2", startedAt: 2 }));
		index.refresh(scope([]));
		assert.equal(loads, 1, "an unchanged stamp is trusted");
		assert.deepEqual(ids(index.summaries()), ["a"]);
		index.invalidate("host-1");
		index.refresh(scope([]));
		assert.equal(loads, 1, "invalidating another session reads nothing here");
		index.invalidate("host-2");
		index.refresh(scope([]));
		assert.equal(loads, 2);
		assert.deepEqual(ids(index.summaries()), ["b", "a"]);
		index.invalidate();
		index.refresh(scope([]));
		assert.equal(loads, 3);
	});
});

test("a scope change re-decides eligibility from the summaries the index keeps, without reading again", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.saveAll("host-2", "/work", [record({ id: "a", handle: "run-3", sessionId: "s-a", startedAt: 1 }), record({ id: "b", handle: "run-3", sessionId: "s-b", startedAt: 2 })]);
		const reader = counting(history);
		const index = new ArchiveIndex(reader);
		index.refresh(scope([]));
		assert.deepEqual(ids(index.summaries()), ["b", "a"]);
		const before = index.revision;
		index.refresh(scope([claudeEntry("run-3", "host-2", "s-b")]));
		assert.deepEqual(ids(index.summaries()), ["b"], "the branch now names another child for the handle");
		assert.ok(index.revision > before);
		assert.equal(index.detail("a"), undefined);
		assert.deepEqual(reader.loads, ["host-2"], "eligibility changed with no new read of the file");
	});
});

test("an interrupted ancestor run is shown aborted and its file is never written", () => {
	withDir((dir) => {
		const history = new History(dir);
		const going = record({ id: "old", hostSessionId: "host-1", state: "waiting" });
		delete going.endedAt;
		history.save("host-1", "/work", going);
		const target = path.join(dir, "host-1.json");
		const bytes = fs.readFileSync(target);
		const mtime = fs.statSync(target).mtimeMs;
		const index = new ArchiveIndex(history);
		index.refresh(scope([claudeEntry("run-1", "host-1", "s-1")]));
		assert.equal(index.summaries()[0]?.status, "aborted");
		assert.equal(index.detail("old")?.failure, HISTORY_ABORTED);
		assert.deepEqual(fs.readFileSync(target), bytes);
		assert.equal(fs.statSync(target).mtimeMs, mtime);
		assert.equal(history.load("host-1").records[0]?.state, "waiting");
	});
});

test("files history refuses stay refused, with the warnings history gives, and nothing is written", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.save("host-2", "/work", record({ id: "a" }));
		const warnings: string[] = [];
		const index = new ArchiveIndex(history, (warning) => warnings.push(warning));
		const target = path.join(dir, "host-1.json");
		const branch = [claudeEntry("run-1", "host-1", "s-1")];
		const ancestor = (data: unknown) => {
			fs.rmSync(target, { force: true });
			fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
			const bytes = fs.readFileSync(target);
			warnings.length = 0;
			index.refresh(scope(branch));
			assert.deepEqual(ids(index.summaries()), ["a"]);
			assert.deepEqual(fs.readFileSync(target), bytes, "the file is left as it was");
			return warnings.join("; ");
		};
		const held = record({ id: "anc", hostSessionId: "host-1" });
		assert.match(ancestor({ version: HISTORY_VERSION + 1, hostSessionId: "host-1", cwd: "/work", records: [held] }), /written by a newer pi-fusion/);
		assert.match(ancestor({ version: HISTORY_VERSION, hostSessionId: "host-3", cwd: "/work", records: [held] }), /is unreadable and will be replaced/);
		assert.match(ancestor("not json"), /is unreadable/);
		assert.match(ancestor(`{"version":${HISTORY_VERSION},"x":"${"y".repeat(MAX_HISTORY_FILE_BYTES)}"}`), /is larger than/);
		fs.rmSync(target);
		const elsewhere = path.join(path.dirname(dir), "elsewhere.json");
		fs.writeFileSync(elsewhere, JSON.stringify({ version: HISTORY_VERSION, hostSessionId: "host-1", cwd: "/work", records: [held] }), { mode: 0o600 });
		fs.symlinkSync(elsewhere, target);
		warnings.length = 0;
		index.refresh(scope(branch));
		assert.deepEqual(ids(index.summaries()), ["a"]);
		assert.match(warnings.join("; "), /is not a regular file; it is left alone/);
		assert.ok(fs.lstatSync(target).isSymbolicLink());
		assert.equal(history.stamp("host-1"), undefined, "a link is nothing a stamp vouches for");
		// A directory open to others is made private by the read, as every history read does, and only then trusted.
		fs.chmodSync(dir, 0o755);
		assert.equal(history.stamp("host-2"), undefined);
		warnings.length = 0;
		index.refresh(scope([]));
		assert.match(warnings.join("; "), /was open to other users and is now mode 0700/);
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.ok(history.stamp("host-2"));
		assert.equal(history.stamp("not/a name"), undefined);
		assert.deepEqual(index.summaries().map((held) => held.id), ["a"]);
	});
});

test("archive reads never put a run into the live store or evict one from it", () => {
	withDir((dir) => {
		const history = new History(dir);
		history.saveAll("host-2", "/work", [record({ id: "a", startedAt: 1 }), record({ id: "b", handle: "run-2", startedAt: 2 })]);
		const store = new RunStore(() => 5, 1);
		store.start({ id: "live", role: "implement", model: "opus" });
		store.finish("live", { status: "done", text: "ok" });
		const before = store.summaries();
		const index = new ArchiveIndex(history);
		index.refresh(scope([]));
		index.detail("a");
		index.detail("b");
		assert.deepEqual(store.summaries(), before);
		assert.equal(store.detail("a"), undefined);
		assert.equal(store.maxRuns, 1);
	});
});

test("an interruption the host already wrote back reads as the interruption it was, with no measured end", () => {
	withDir((dir) => {
		const history = new History(dir);
		const going = (id: string, handle: string, state: "running" | "waiting", startedAt: number) => {
			const held = record({ id, handle, state, startedAt, report: undefined });
			delete held.endedAt;
			delete held.report;
			return held;
		};
		history.saveAll("host-2", "/work", [going("raw-running", "run-1", "running", 10), going("raw-waiting", "run-2", "waiting", 20)]);
		// What the host's restore writes back: `asEnded` of each, through the same save, which is the correction on disk.
		const raw = history.load("host-2").records;
		history.saveAll("host-2", "/work", raw.map((held) => asEnded(held)!));
		const corrected = history.load("host-2").records;
		assert.deepEqual(
			corrected.map((held) => [held.id, held.state, held.failure, held.endedAt]),
			[
				["raw-running", "aborted", HISTORY_ABORTED, 10],
				["raw-waiting", "aborted", HISTORY_ABORTED, 20],
			],
		);
		history.saveAll("host-2", "/work", [
			record({ id: "kept-end", handle: "run-3", state: "aborted", failure: HISTORY_ABORTED, startedAt: 30, endedAt: 35 }),
			record({ id: "aborted", handle: "run-4", state: "aborted", failure: "stopped by the user", startedAt: 40, endedAt: 40 }),
			record({ id: "cancelled", handle: "run-5", state: "cancelled", failure: HISTORY_ABORTED.toUpperCase(), startedAt: 50, endedAt: 50 }),
			record({ id: "failed", handle: "run-6", state: "failed", failure: "it broke", startedAt: 60, endedAt: 61 }),
		]);
		const index = new ArchiveIndex(history);
		index.refresh(scope([]));
		const shown = new Map(index.summaries().map((held) => [held.id, held]));
		for (const id of ["raw-running", "raw-waiting"]) {
			const summary = shown.get(id)!;
			assert.equal(summary.status, "aborted", id);
			assert.equal(summary.interrupted, true, id);
			assert.equal(summary.endedAt, undefined, `${id}: the stand-in end is no measured zero duration`);
			assert.ok(summary.unavailable.includes("endedAt"), id);
			const detail = index.detail(id)!;
			assert.equal(detail.failure, HISTORY_ABORTED);
			assert.equal(detail.endedAt, undefined);
			assert.ok(!("question" in detail), `${id} has nothing to answer`);
		}
		const kept = shown.get("kept-end")!;
		assert.equal(kept.interrupted, true);
		assert.equal(kept.endedAt, 35, "an end the record really has is kept");
		assert.ok(!kept.unavailable.includes("endedAt"));
		for (const [id, end] of [["aborted", 40], ["cancelled", 50], ["failed", 61]] as const) {
			const summary = shown.get(id)!;
			assert.equal(summary.interrupted, undefined, `${id} is an ordinary ending`);
			assert.equal(summary.endedAt, end, `${id} keeps the end it recorded, even one at its start`);
			assert.ok(!summary.unavailable.includes("endedAt"), id);
		}
	});
});

/** A record that asked to continue `parent` and ended with no child the host accepted, as a failed continuation does. */
const continued = (backend: "claude" | "pi", kind: "resume" | "fork", parent: string, over: Partial<HistoryRecord> = {}, file = PI_REF.sessionFile): HistoryRecord => {
	if (backend === "pi") {
		const held = piRecord({ state: "failed", failure: "it broke", report: undefined, session: { kind, backend: "pi", ...(kind === "resume" ? { id: parent } : { from: parent }), file, at: "entry-9" }, ...over });
		if (!("ref" in over)) delete held.ref;
		if (!("selection" in over)) delete held.selection;
		if (!("report" in over)) delete held.report;
		return held;
	}
	const held = record({ state: "failed", failure: "it broke", report: undefined, sessionId: "s-diag", session: kind === "resume" ? { kind, backend: "claude", id: parent, at: "c-9" } : { kind, backend: "claude", id: "s-new", from: parent, at: "c-9" }, ...over });
	if (!("report" in over)) delete held.report;
	return held;
};

const admission = (held: HistoryRecord, branch: readonly unknown[], source = "host-2") => archiveAdmission(held, source, scope(branch));

test("a failed continuation whose own child contradicts the branch is shown through the parent its request named", () => {
	// Claude: the run reported a session id the branch never recorded, but asked to continue the one it did.
	const claude = [claudeEntry("run-1", "host-2", "s-1")];
	for (const kind of ["resume", "fork"] as const) {
		const failed = continued("claude", kind, "s-1");
		assert.equal(admission(record({ sessionId: "s-diag" }), claude), undefined, `${kind}: the diagnostic id alone contradicts the branch`);
		assert.equal(admission(failed, claude), "lineage", kind);
		assert.equal(archiveEligible(failed, "host-2", scope(claude)), true, kind);
	}
	// Pi: no accepted reference at all, and a request whose checkpoint is no part of the parent.
	const pi = [piEntry("run-1", "host-2")];
	for (const kind of ["resume", "fork"] as const) {
		const failed = continued("pi", kind, "pi-1");
		assert.equal(failed.ref, undefined);
		assert.equal(admission(failed, pi), "lineage", kind);
	}
	// Whatever admits it, the record comes back as the history kept it: the request is no reference.
	const failed = continued("pi", "resume", "pi-1");
	const [shown] = archiveRecords([{ hostSessionId: "host-2", records: [failed] }], scope(pi));
	assert.deepEqual(shown, failed);
	assert.equal(shown?.ref, undefined);
	assert.equal(shown?.selection, undefined);
	const detail = archiveDetail(shown!);
	assert.deepEqual(detail?.session, failed.session);
	assert.equal(detail?.ref, undefined);
	assert.equal(detail?.sessionId, undefined);
	// The branch still continues what it recorded, and nothing the archive read changed that.
	assert.deepEqual(runRecords(pi).runs.get("run-1")?.session, PI_REF);
	// A record its own entries allow stays admitted as recorded, request or none.
	assert.equal(admission(record({ sessionId: "s-1", state: "failed", session: { kind: "resume", backend: "claude", id: "s-1" } }), claude), "recorded");
});

test("a failed fork from a superseded ancestor entry is shown, and stays shown after a later success replaced it", () => {
	const forked: PiSessionRef = { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: "entry-2" };
	const later: PiSessionRef = { backend: "pi", sessionId: "pi-3", sessionFile: "/sessions/pi-3.jsonl", checkpoint: "entry-3" };
	const cases = [
		{ backend: "claude" as const, parent: "s-1", ancestor: claudeEntry("run-1", "host-1", "s-1"), mine: claudeEntry("run-1", "host-2", "s-2"), success: claudeEntry("run-1", "host-2", "s-3") },
		{ backend: "pi" as const, parent: "pi-1", ancestor: piEntry("run-1", "host-1"), mine: piEntry("run-1", "host-2", forked), success: piEntry("run-1", "host-2", later) },
	];
	for (const { backend, parent, ancestor, mine, success } of cases) {
		const failed = continued(backend, "fork", parent);
		assert.equal(admission(failed, [ancestor, mine]), "lineage", `${backend}: the parent is a superseded entry of the ancestor session`);
		assert.equal(admission(failed, [ancestor, mine, success]), "lineage", `${backend}: a later success does not take it away`);
		assert.equal(runRecords([ancestor, mine, success]).runs.get("run-1")?.hostSessionId, "host-2", `${backend}: authority is still the latest entry`);
		// The same record in the ancestor's own file proves nothing about the ancestor's branch: that rule is strict.
		const there = { ...failed, hostSessionId: "host-1" };
		assert.equal(admission(there, [ancestor, mine, success], "host-1"), undefined, `${backend}: an ancestor file needs a matching child`);
		assert.equal(archiveEligible({ ...there, state: "aborted" }, "host-1", scope([ancestor])), false, `${backend}: whatever its state`);
	}
});

test("every state that accepted no child is admitted through its request, and a done run never is", () => {
	const branch = [claudeEntry("run-1", "host-2", "s-1"), piEntry("run-2", "host-2")];
	for (const state of ["failed", "aborted", "cancelled", "running", "waiting"] as const) {
		assert.equal(admission(continued("claude", "resume", "s-1", { state }), branch), "lineage", `claude ${state}`);
		assert.equal(admission(continued("pi", "resume", "pi-1", { handle: "run-2", state }), branch), "lineage", `pi ${state}`);
	}
	assert.equal(admission(continued("claude", "resume", "s-1", { state: "done" }), branch), undefined, "a done run with a contradicting child stays out");
	assert.equal(admission(continued("pi", "resume", "pi-1", { handle: "run-2", state: "done" }), branch), undefined, "and so does a pi one");
	// A run left going reads aborted, and one this process started comes back as it is.
	const going = continued("claude", "resume", "s-1", { id: "going", state: "waiting" });
	assert.equal(archiveRecords([{ hostSessionId: "host-2", records: [going] }], scope(branch))[0]?.state, "aborted");
	assert.equal(archiveRecords([{ hostSessionId: "host-2", records: [going] }], scope(branch, "host-2", new Set(["going"])))[0]?.state, "waiting");
});

test("a request proves nothing without an exact parent the branch recorded for the same handle and backend", () => {
	const claude = [claudeEntry("run-1", "host-2", "s-1"), claudeEntry("run-9", "host-2", "s-9")];
	const pi = [piEntry("run-1", "host-2"), piEntry("run-9", "host-2", { ...PI_REF, sessionId: "pi-9", sessionFile: "/sessions/pi-9.jsonl" })];
	const out: Array<[string, HistoryRecord, readonly unknown[]]> = [
		["a fresh failure", record({ state: "failed", sessionId: "s-diag", session: { kind: "new", backend: "claude", id: "s-1" } }), claude],
		["no request", record({ state: "failed", sessionId: "s-diag" }), claude],
		["an unrecorded parent", continued("claude", "resume", "s-zzz"), claude],
		["a prefix of the parent", continued("claude", "resume", "s-"), claude],
		["a parent with more", continued("claude", "resume", "s-1 "), claude],
		["a resume naming its parent only as from", record({ state: "failed", sessionId: "s-diag", session: { kind: "resume", backend: "claude", from: "s-1" } }), claude],
		["a fork naming its parent only as id", record({ state: "failed", sessionId: "s-diag", session: { kind: "fork", backend: "claude", id: "s-1" } }), claude],
		["no parent at all", record({ state: "failed", sessionId: "s-diag", session: { kind: "resume", backend: "claude" } }), claude],
		["an empty parent", continued("claude", "resume", ""), claude],
		["another handle's parent", continued("claude", "resume", "s-9"), claude],
		["another backend's tag", continued("claude", "resume", "s-1", { session: { kind: "resume", backend: "pi", id: "s-1" } }), claude],
		["a claude request against a pi entry", continued("claude", "resume", "pi-1"), [...claude, piEntry("run-1", "host-1")]],
		["a pi request against a claude entry", continued("pi", "resume", "s-1"), [piEntry("run-1", "host-2"), claudeEntry("run-1", "host-1", "s-1")]],
		["an unknown backend", continued("claude", "resume", "s-1", { backend: "elsewhere" }), claude],
		["a pi request in another file", continued("pi", "resume", "pi-1", {}, "/sessions/other.jsonl"), pi],
		["a pi request in a file that only starts the same", continued("pi", "resume", "pi-1", {}, "/sessions/pi-1.json"), pi],
		["a pi request with no file", continued("pi", "resume", "pi-1", { session: { kind: "resume", backend: "pi", id: "pi-1" } }), pi],
		["a pi request naming another handle's child", continued("pi", "resume", "pi-9", {}, "/sessions/pi-9.jsonl"), pi],
	];
	for (const [why, held, branch] of out) {
		assert.equal(admission(held, branch), undefined, why);
		assert.deepEqual(archiveRecords([{ hostSessionId: "host-2", records: [held] }], scope(branch)), [], why);
	}
	// The old contradiction holds for a pi record with no reference and no request.
	const noRef = piRecord({ handle: "run-4", state: "failed" });
	delete noRef.ref;
	assert.equal(archiveEligible(noRef, "host-2", scope([piEntry("run-4", "host-2")])), false);
	// An untagged request and an untagged record are claude, as the entries are.
	const untagged = continued("claude", "resume", "s-1", { session: { kind: "resume", id: "s-1" } });
	delete untagged.backend;
	assert.equal(admission(untagged, claude), "lineage");
	assert.equal(admission(untagged, [entry({ run: "run-1", role: "implement", sessionId: "s-1" })]), "lineage", "a sessionless entry is this branch's");
});

test("a request the history may have cut names no parent, while accepted references and recorded matches stay exact", () => {
	withDir((dir) => {
		const history = new History(dir);
		const long = "s".repeat(450);
		// The high half of a pair at the cut: `cap` drops it and keeps 399 characters, with no flag either way.
		const pair = `${"q".repeat(399)}\u{1F600}${"q".repeat(20)}`;
		const files = { long: `/sessions/${"f".repeat(450)}.jsonl`, pair: `/${"g".repeat(398)}\u{1F600}.jsonl` };
		const exact = "e".repeat(398);
		history.saveAll("host-2", "/work", [
			continued("claude", "resume", long, { id: "c-long", handle: "run-1", startedAt: 1 }),
			continued("claude", "fork", pair, { id: "c-pair", handle: "run-2", startedAt: 2 }),
			continued("claude", "resume", exact, { id: "c-exact", handle: "run-3", startedAt: 3 }),
			continued("pi", "resume", "pi-1", { id: "p-long", handle: "run-4", startedAt: 4 }, files.long),
			continued("pi", "fork", "pi-1", { id: "p-pair", handle: "run-5", startedAt: 5 }, files.pair),
			continued("pi", "resume", long, { id: "p-id", handle: "run-6", startedAt: 6 }),
			continued("pi", "resume", "pi-1", { id: "p-accepted", handle: "run-7", startedAt: 7, ref: { ...PI_REF, sessionFile: files.long } }, files.long),
		]);
		const read = new Map(history.load("host-2").records.map((held) => [held.id, held]));
		assert.equal(read.get("c-long")?.session?.id?.length, 400);
		assert.equal(read.get("c-pair")?.session?.from?.length, 399, "the cut fell inside the pair");
		assert.equal(read.get("c-exact")?.session?.id, exact);
		assert.equal(read.get("p-long")?.session?.file?.length, 400);
		assert.equal(read.get("p-pair")?.session?.file?.length, 399);
		assert.deepEqual(read.get("p-accepted")?.ref, { ...PI_REF, sessionFile: files.long }, "an accepted reference is kept exactly");
		const cut = (value: string, n: number) => value.slice(0, n);
		// Entries that hold exactly what the cut left, and the parents as they really were, for every handle.
		const branch = [
			claudeEntry("run-1", "host-2", cut(long, 400)),
			claudeEntry("run-1", "host-2", long),
			claudeEntry("run-2", "host-2", cut(pair, 399)),
			claudeEntry("run-2", "host-2", pair),
			claudeEntry("run-3", "host-2", exact),
			piEntry("run-4", "host-2", { ...PI_REF, sessionFile: cut(files.long, 400) }),
			piEntry("run-4", "host-2", { ...PI_REF, sessionFile: files.long }),
			piEntry("run-5", "host-2", { ...PI_REF, sessionFile: cut(files.pair, 399) }),
			piEntry("run-6", "host-2", { ...PI_REF, sessionId: cut(long, 400) }),
			piEntry("run-7", "host-2", { ...PI_REF, sessionFile: files.long }),
		];
		const expected = new Map([
			["c-long", undefined],
			["c-pair", undefined],
			["c-exact", "lineage"],
			["p-long", undefined],
			["p-pair", undefined],
			["p-id", undefined],
			["p-accepted", "recorded"],
		]);
		for (const [id, want] of expected) assert.equal(archiveAdmission(read.get(id)!, "host-2", scope(branch)), want, id);
		assert.deepEqual(ids(archiveRecords([{ hostSessionId: "host-2", records: [...read.values()] }], scope(branch))), ["c-exact", "p-accepted"]);
		const index = new ArchiveIndex(history);
		index.refresh(scope(branch));
		assert.deepEqual(ids(index.summaries()), ["p-accepted", "c-exact"]);
		assert.equal(index.detail("c-long"), undefined);
		assert.equal(index.detail("p-pair"), undefined);
		assert.deepEqual(index.detail("p-accepted")?.ref, { ...PI_REF, sessionFile: files.long });
	});
});

test("the index admits a failed continuation through its request, keeps no more of the request than the parent, and keeps request and reference apart", () => {
	withDir((dir) => {
		const history = new History(dir);
		const forked: PiSessionRef = { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: "entry-2" };
		history.saveAll("host-2", "/work", [
			piRecord({ id: "first", startedAt: 1, ref: { ...forked }, session: { kind: "fork", backend: "pi", from: "pi-1", file: PI_REF.sessionFile, at: "entry-1" } }),
			continued("pi", "resume", "pi-2", { id: "failed", startedAt: 2 }, forked.sessionFile),
			continued("claude", "fork", "s-1", { id: "claude-failed", handle: "run-2", startedAt: 3 }),
			continued("pi", "resume", "pi-zzz", { id: "stray", startedAt: 4 }, forked.sessionFile),
		]);
		history.save("host-1", "/work", piRecord({ id: "ancestor", hostSessionId: "host-1", startedAt: 0 }));
		const index = new ArchiveIndex(history);
		const branch = [piEntry("run-1", "host-1"), piEntry("run-1", "host-2", forked), claudeEntry("run-2", "host-2", "s-1")];
		index.refresh(scope(branch));
		assert.deepEqual(ids(index.summaries()), ["claude-failed", "failed", "first", "ancestor"]);
		const detail = index.detail("failed")!;
		assert.equal(detail.status, "failed");
		assert.deepEqual(detail.session, { kind: "resume", backend: "pi", id: "pi-2", file: forked.sessionFile, at: "entry-9" }, "the request as saved");
		assert.equal(detail.ref, undefined, "and no reference it never had");
		assert.equal(detail.selection, undefined);
		assert.equal(index.detail("claude-failed")?.sessionId, "s-diag", "the id the run reported, as saved");
		assert.equal(index.detail("claude-failed")?.ref, undefined);
		assert.equal(index.detail("stray"), undefined);
		const kept = strings(index);
		assert.ok(!kept.includes("s-new") && !kept.includes("entry-9") && !kept.includes("c-9"), "a fork's own new id and a request checkpoint are not kept");
		// A branch that no longer records the parent takes the failed run away without reading the file again.
		index.refresh(scope([piEntry("run-1", "host-2", { ...forked, sessionId: "pi-other" }), claudeEntry("run-2", "host-2", "s-1")]));
		assert.deepEqual(ids(index.summaries()), ["claude-failed"]);
		assert.equal(index.detail("failed"), undefined);
	});
});

test("only a claude id a run reported, on a record shown through its request alone, is marked diagnostic in its detail", () => {
	withDir((dir) => {
		const history = new History(dir);
		const legacyFailed = record({ id: "legacy", handle: "run-3", state: "failed", failure: "it broke", sessionId: "l-1", startedAt: 4 });
		delete legacyFailed.backend;
		history.saveAll("host-2", "/work", [
			record({ id: "first", sessionId: "c-1", startedAt: 1 }),
			continued("claude", "resume", "c-1", { id: "failed", sessionId: "c-2", report: "## Changed\nfoo.ts", startedAt: 2 }),
			record({ id: "third", sessionId: "c-3", session: { kind: "resume", backend: "claude", id: "c-1" }, startedAt: 3 }),
			legacyFailed,
			continued("claude", "resume", "d-1", { id: "accepted", handle: "run-2", sessionId: "d-9", ref: { backend: "claude", sessionId: "d-9" }, startedAt: 5 }),
			continued("claude", "resume", "d-1", { id: "crossed", handle: "run-2", sessionId: "d-8", ref: { backend: "claude", sessionId: "d-7" }, startedAt: 6 }),
			continued("pi", "resume", "pi-1", { id: "pi-failed", handle: "run-4", sessionId: "pi-diag", startedAt: 7 }),
		]);
		const branch = [claudeEntry("run-1", "host-2", "c-1"), claudeEntry("run-1", "host-2", "c-3"), claudeEntry("run-2", "host-2", "d-1"), piEntry("run-4", "host-2")];
		const index = new ArchiveIndex(history);
		index.refresh(scope(branch));
		assert.deepEqual(ids(index.summaries()), ["pi-failed", "crossed", "accepted", "legacy", "third", "failed", "first"]);
		const failed = index.detail("failed")!;
		assert.equal(failed.diagnosticSessionId, true);
		assert.equal(failed.sessionId, "c-2", "the id stays readable as saved");
		assert.equal(failed.ref, undefined, "and no reference is made from the request");
		assert.deepEqual(failed.session, { kind: "resume", backend: "claude", id: "c-1", at: "c-9" });
		assert.equal(failed.failure, "it broke");
		assert.equal(failed.report, "## Changed\nfoo.ts");
		assert.equal(index.detail("crossed")?.diagnosticSessionId, true, "a reference naming another id confirms nothing");
		for (const id of ["first", "third", "legacy", "accepted", "pi-failed"]) assert.equal(index.detail(id)?.diagnosticSessionId, undefined, id);
		assert.equal(index.detail("legacy")?.status, "failed", "a failed run its own entries allow keeps its hint");
		assert.ok(index.summaries().every((summary) => !("diagnosticSessionId" in summary)), "the list carries no such mark");
		// The mark is the detail's alone: it changes neither what the branch shows nor what it continues.
		assert.equal(archiveAdmission(history.load("host-2").records.find((held) => held.id === "failed")!, "host-2", scope(branch)), "lineage");
		assert.equal(runRecords(branch).runs.get("run-1")?.sessionId, "c-3");
		// A pure detail is read with no branch, so it says nothing either way.
		assert.equal(archiveDetail(history.load("host-2").records.find((held) => held.id === "failed")!)?.diagnosticSessionId, undefined);
	});
});
