import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { CodexSessionRef, PiSessionRef, SessionIntent } from "../extensions/backends/types.ts";
import { intentFor, nextSession, type RecordCall, recordDecision, type RunOutcome, type RunRecord, runRecords } from "../extensions/fusion.ts";
import { canChangeFiles, isKnownRole, roleSpec } from "../extensions/roles.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });

const only = (data: Record<string, unknown>): RunRecord => {
	const records = runRecords([entry(data)]);
	const record = [...records.runs.values()][0];
	assert.ok(record, "the entry recorded no run");
	return record;
};

const PI_REF: PiSessionRef = { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-9" };
const PI_SELECTION = { model: "deepseek/deepseek-chat", effort: "medium" };

const piEntry = (data: Record<string, unknown> = {}) => ({
	run: "run-1",
	role: "implement",
	backend: "pi",
	hostSessionId: "host-1",
	session: { ...PI_REF },
	selection: { ...PI_SELECTION },
	...data,
});

test("an entry without a backend is the claude run it has always been, flat fields and all", () => {
	const record = only({ run: "run-1", role: "plan", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", contextTokens: 10, contextWindow: 100 });
	assert.deepEqual(record, {
		handle: "run-1",
		role: "plan",
		backend: "claude",
		hostSessionId: "host-1",
		sessionId: "s-1",
		checkpoint: "c-1",
		contextTokens: 10,
		contextWindow: 100,
		session: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" },
	});
	assert.deepEqual(intentFor(record, "host-1"), { kind: "resume", ref: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } });
});

test("a consolidator entry from before handles existed is still a claude plan run", () => {
	const record = only({ consolidatorGeneration: 1, consolidatorSessionId: "s-0", consolidatorCheckpoint: "c-0", hostSessionId: "host-1" });
	assert.deepEqual(record, {
		handle: "run-2",
		role: "plan",
		backend: "claude",
		hostSessionId: "host-1",
		sessionId: "s-0",
		checkpoint: "c-0",
		session: { backend: "claude", sessionId: "s-0", checkpoint: "c-0" },
	});
});

test("a consolidator entry tagged with another backend keeps its generated handle and is refused, never read as claude", () => {
	for (const backend of ["pi", "elsewhere", 7, null]) {
		const records = runRecords([entry({ consolidatorGeneration: 1, consolidatorSessionId: "s-0", consolidatorCheckpoint: "c-0", hostSessionId: "host-1", backend })]);
		const record = records.runs.get("run-2");
		assert.ok(record, `backend ${String(backend)} dropped the generated handle`);
		assert.equal(record.sessionId, undefined, "the consolidator keys are claude's own and are not read under another tag");
		assert.equal(record.session, undefined);
		assert.equal(record.backend, backend === "pi" ? "pi" : undefined, "an unknown tag names no backend, and a pi tag is not claude");
		assert.match(record.refusal ?? "", /^run-2 /);
		assert.equal(records.highest, 2, "the generated handle stays taken");
		assert.throws(() => intentFor(record, "host-1"), /run-2 (is tagged pi|was recorded by backend)/);
	}
	assert.deepEqual(runRecords([entry({ consolidatorGeneration: 1, consolidatorSessionId: "s-0", hostSessionId: "host-1", backend: "claude" })]).runs.get("run-2"), {
		handle: "run-2",
		role: "plan",
		backend: "claude",
		hostSessionId: "host-1",
		sessionId: "s-0",
		session: { backend: "claude", sessionId: "s-0" },
	});
});

test("an empty session id is no identity, so the run starts a new session as it always did", () => {
	const record = only({ run: "run-1", role: "plan", hostSessionId: "host-1", sessionId: "", checkpoint: "" });
	assert.equal(record.session, undefined, "an empty id is never a session reference to resume");
	assert.equal(record.refusal, undefined, "it is the absence of a session, not a record to refuse");
	assert.deepEqual(intentFor(record, "host-1"), { kind: "new" });
	const session = nextSession(record, "host-1");
	assert.equal(session.kind, "new");
	assert.match(session.id, UUID, "a new session gets an id of its own, never the empty one");
	const checkpointless = only({ run: "run-1", role: "plan", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "" });
	assert.deepEqual(checkpointless.session, { backend: "claude", sessionId: "s-1" }, "an empty checkpoint is no position to restore");
	assert.deepEqual(nextSession(checkpointless, "host-1"), { kind: "resume", id: "s-1" });
});

test("a pi entry keeps its session reference and the selection it ran with", () => {
	const record = only(piEntry({ contextTokens: 10, contextWindow: 100 }));
	assert.equal(record.backend, "pi");
	assert.equal(record.refusal, undefined);
	assert.deepEqual(record.session, PI_REF);
	assert.deepEqual(record.selection, PI_SELECTION);
	assert.equal(record.sessionId, undefined, "a pi run never fills the flat claude session id");
	assert.deepEqual(intentFor(record, "host-1"), { kind: "resume", ref: PI_REF });
	assert.deepEqual(intentFor(record, "host-2"), { kind: "fork", from: PI_REF });
});

test("a pi entry with no verified session keeps its handle and refuses continuation for every pi role", () => {
	for (const role of ["plan", "implement", "ask", "security"]) {
		const records = runRecords([entry({ run: "run-1", role, backend: "pi", hostSessionId: "host-1" })]);
		const record = records.runs.get("run-1")!;
		assert.equal(record.role, role);
		assert.equal(record.session, undefined);
		assert.equal(record.selection, undefined);
		assert.match(record.refusal ?? "", /^run-1 ran on pi and recorded no verified session/);
		assert.match(record.refusal ?? "", /start a new run without continue \(a plan call takes fresh true\)/);
		assert.throws(() => intentFor(record, "host-1"), /recorded no verified session/);
		assert.equal(records.highest, 1, "the failed handle stays taken");
		if (role === "plan") assert.equal(records.lastPlan.get("pi"), "run-1", "the refused plan remains the latest plan");
	}
});

test("a pi record with no trusted checkpoint is kept for reading and refused for continuing", () => {
	const { checkpoint, ...ref } = PI_REF;
	const record = only(piEntry({ session: ref }));
	assert.deepEqual(record.session, ref);
	assert.match(record.refusal ?? "", /^run-1 ran on pi and recorded no trusted checkpoint/);
	assert.match(record.refusal ?? "", /\/sessions\/pi-1\.jsonl/);
	assert.match(record.refusal ?? "", /new run \(a plan call takes fresh true\)/);
	assert.throws(() => intentFor(record, "host-1"), /recorded no trusted checkpoint/);
});

test("a pi record whose selection is missing or unusable is not resumed against whatever is configured now", () => {
	for (const selection of [undefined, { model: "deepseek-chat", effort: "medium" }, { model: "deepseek/deepseek-chat" }, { model: "deepseek/deepseek-chat", effort: "ultracode" }]) {
		const record = only(piEntry(selection === undefined ? { selection: undefined } : { selection }));
		assert.match(record.refusal ?? "", /recorded no model and effort this host can repeat/, `selection ${JSON.stringify(selection)}`);
		assert.match(record.refusal ?? "", /its session file is \/sessions\/pi-1\.jsonl, and new work needs a new run \(a plan call takes fresh true\)/, `selection ${JSON.stringify(selection)}`);
		assert.deepEqual(record.session, PI_REF, "the reference is still there to read");
	}
});

test("a recorded pi model keeps the slashes its provider's own id carries, so such a run is still continued", () => {
	for (const model of ["deepseek/deepseek-chat", "openrouter/deepseek/deepseek-chat", "openrouter/a/b/c"]) {
		const record = only(piEntry({ selection: { model, effort: "medium" } }));
		assert.equal(record.refusal, undefined, model);
		assert.deepEqual(record.selection, { model, effort: "medium" }, model);
	}
	// A bare model id is still no selection this host can repeat: the provider is half of it.
	assert.match(only(piEntry({ selection: { model: "deepseek-chat", effort: "medium" } })).refusal ?? "", /recorded no model and effort this host can repeat/);
});

test("pi identity in flat fields, in an incomplete reference or under another backend's tag is refused, never reinterpreted", () => {
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{ session: undefined, sessionId: "pi-1" }, /records its pi session in sessionId rather than in a session reference/],
		[{ session: undefined, sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-9" }, /records its pi session in sessionId, checkpoint, sessionFile/],
		[{ session: { backend: "pi", sessionId: "pi-1", checkpoint: "entry-9" } }, /has an incomplete or mismatched pi session reference/],
		[{ session: { backend: "claude", sessionId: "pi-1", checkpoint: "entry-9" } }, /has an incomplete or mismatched pi session reference/],
		[{ session: { ...PI_REF, backend: "elsewhere" } }, /has an incomplete or mismatched pi session reference/],
		[{ sessionId: "pi-1" }, /carries both a pi session reference and sessionId/],
	];
	for (const [data, expected] of cases) {
		const record = only(piEntry(data));
		assert.match(record.refusal ?? "", expected, JSON.stringify(data));
		assert.equal(record.backend, "pi");
		assert.throws(() => intentFor(record, "host-1"), expected);
	}
});

test("a claude entry carrying another backend's session reference is refused", () => {
	const record = only({ run: "run-1", role: "implement", hostSessionId: "host-1", sessionId: "s-1", session: { ...PI_REF } });
	assert.match(record.refusal ?? "", /carries a session reference that is not the claude session it records/);
	const mismatched = only({ run: "run-1", role: "implement", hostSessionId: "host-1", sessionId: "s-1", session: { backend: "claude", sessionId: "s-2" } });
	assert.match(mismatched.refusal ?? "", /carries a session reference that is not the claude session it records/);
});

test("an entry naming a backend this host does not know keeps its handle and is never read as claude", () => {
	for (const backend of ["elsewhere", 7, null, { name: "pi" }]) {
		const records = runRecords([entry({ run: "run-3", role: "plan", backend, hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" })]);
		const record = records.runs.get("run-3");
		assert.ok(record);
		assert.equal(record.backend, undefined, `backend ${String(backend)} must not read as claude`);
		assert.equal(record.session, undefined);
		assert.match(record.refusal ?? "", /^run-3 was recorded by backend .*which this pi-fusion does not know/);
		assert.equal(records.highest, 3, "the handle stays taken");
		assert.deepEqual([...records.lastPlan], [], "a record with no known backend is no backend's latest plan");
		assert.throws(() => intentFor(record, "host-1"), /does not know/);
	}
});

const CODEX_REF: CodexSessionRef = { backend: "codex", sessionId: "thread-1", checkpoint: "turn-2" };
const CODEX_SELECTION = { model: "gpt-5-codex", provider: "openai" };

const codexEntry = (data: Record<string, unknown> = {}) => ({
	run: "run-4",
	role: "implement",
	backend: "codex",
	hostSessionId: "host-1",
	session: { ...CODEX_REF },
	selection: { ...CODEX_SELECTION },
	...data,
});

test("a codex entry with its thread, a trusted checkpoint and a configured selection is one to continue, exactly as recorded", () => {
	const record = only(codexEntry({ selection: { ...CODEX_SELECTION, effort: "high" }, contextTokens: 10, contextWindow: 100 }));
	assert.deepEqual(record, {
		handle: "run-4",
		role: "implement",
		backend: "codex",
		hostSessionId: "host-1",
		session: CODEX_REF,
		selection: { ...CODEX_SELECTION, effort: "high" },
		contextTokens: 10,
		contextWindow: 100,
	});
	assert.deepEqual(only(codexEntry()).selection, CODEX_SELECTION, "a child left on its own effort names none, and is still repeatable");
	// The intent names exactly the recorded thread and checkpoint: resumed in its own host session, forked in another.
	assert.deepEqual(intentFor(record, "host-1"), { kind: "resume", ref: CODEX_REF });
	assert.deepEqual(intentFor(record, "host-2"), { kind: "fork", from: CODEX_REF });
	// A codex record built without its thread is not a new run in disguise.
	assert.throws(() => intentFor({ handle: "run-4", role: "implement", backend: "codex" }, "host-1"), /^Error: run-4 names no codex thread with a trusted checkpoint/);
	const { checkpoint, ...bare } = CODEX_REF;
	assert.throws(() => intentFor({ handle: "run-4", role: "implement", backend: "codex", session: bare }, "host-1"), /names no codex thread with a trusted checkpoint/);
	assert.throws(() => intentFor({ handle: "run-4", role: "implement", backend: "codex", sessionId: "s-1", checkpoint: "c-1" }, "host-1"), /names no codex thread/, "a flat id is never a codex thread");
});

test("a codex thread with no trusted checkpoint is kept for reading, and every continuation of it points at codex resume", () => {
	const { checkpoint, ...bare } = CODEX_REF;
	const record = only(codexEntry({ session: bare }));
	assert.deepEqual(record.session, bare, "the thread this host owns is still named");
	assert.equal(record.selection, undefined);
	assert.equal(
		record.refusal,
		"run-4 ran on codex and recorded no trusted checkpoint, so it is kept for reading and not continued; open its thread with codex resume thread-1, and new work needs a new run without continue",
	);
	assert.throws(() => intentFor(record, "host-1"), /recorded no trusted checkpoint/);
	assert.throws(() => intentFor(record, "host-2"), /recorded no trusted checkpoint/, "a forked host session is refused the same way");
});

test("a codex entry is identified by its tagged thread alone: missing, malformed, mixed and cross-backend shapes keep the handle and continue nothing", () => {
	const { checkpoint, ...bare } = CODEX_REF;
	const cases: Array<[Record<string, unknown>, RegExp, boolean]> = [
		[{ session: undefined, selection: undefined }, /^run-4 ran on codex and recorded no verified thread, so it cannot be continued; start a new run without continue$/, false],
		[{ session: undefined, sessionId: "thread-1", checkpoint: "turn-2" }, /^run-4 records its codex run in sessionId, checkpoint rather than in a thread reference/, false],
		[{ session: undefined, model: "gpt-5-codex", effort: "high" }, /^run-4 records its codex run in model, effort rather than in a thread reference/, false],
		[{ session: { sessionId: "thread-1", checkpoint: "turn-2" } }, /has an incomplete or mismatched codex thread reference/, false],
		[{ session: { ...PI_REF } }, /has an incomplete or mismatched codex thread reference/, false],
		[{ session: { ...CODEX_REF, sessionFile: "/sessions/pi-1.jsonl" } }, /has an incomplete or mismatched codex thread reference/, false],
		[{ session: { ...CODEX_REF, sessionId: "" } }, /has an incomplete or mismatched codex thread reference/, false],
		[{ session: { ...CODEX_REF, checkpoint: "" } }, /has an incomplete or mismatched codex thread reference/, false],
		[{ session: "thread-1" }, /has an incomplete or mismatched codex thread reference/, false],
		[{ sessionId: "thread-1" }, /carries both a codex thread reference and sessionId/, true],
		[{ checkpoint: "turn-2" }, /carries both a codex thread reference and checkpoint/, true],
		[{ sessionFile: "/sessions/pi-1.jsonl" }, /carries both a codex thread reference and sessionFile/, true],
		[{ model: "gpt-5-codex" }, /carries both a codex thread reference and model/, true],
		[{ selection: undefined }, /recorded no codex model and provider this host can repeat.*codex resume thread-1/, true],
		[{ selection: { model: "gpt-5-codex" } }, /recorded no codex model and provider this host can repeat/, true],
		[{ selection: { model: "gpt-5-codex", effort: "high" } }, /recorded no codex model and provider this host can repeat/, true],
		[{ selection: { ...PI_SELECTION } }, /recorded no codex model and provider this host can repeat/, true],
		[{ selection: { ...CODEX_SELECTION, effort: "very high" } }, /recorded no codex model and provider this host can repeat/, true],
		[{ selection: { ...CODEX_SELECTION, provider: "" } }, /recorded no codex model and provider this host can repeat/, true],
		[{ session: bare, selection: { model: "gpt-5-codex" } }, /recorded no trusted checkpoint/, true],
	];
	for (const [over, expected, held] of cases) {
		const records = runRecords([entry({ ...codexEntry(), ...over })]);
		const record = records.runs.get("run-4");
		assert.ok(record, JSON.stringify(over));
		assert.equal(record.backend, "codex");
		assert.match(record.refusal ?? "", expected, JSON.stringify(over));
		assert.equal(record.selection, undefined, "a refused record repeats no selection");
		assert.equal(record.sessionId, undefined, "and no flat identity is read out of it");
		assert.equal(record.session !== undefined, held, `only a well-formed codex thread is held for reading: ${JSON.stringify(over)}`);
		if (record.session) assert.equal(record.session.backend, "codex");
		assert.equal(records.highest, 4, "the handle stays taken");
		assert.throws(() => intentFor(record, "host-1"), (error: Error) => error.message === record.refusal);
	}
	const generation = runRecords([entry({ consolidatorGeneration: 0, consolidatorSessionId: "s-1", backend: "codex" })]).runs.get("run-1");
	assert.equal(generation?.backend, "codex");
	assert.match(generation?.refusal ?? "", /^run-1 is tagged codex over the consolidator keys of a claude entry and names no codex session/);
});

test("an entry with an unknown or inherited role is dropped", () => {
	for (const role of ["nobody", "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
		assert.equal(isKnownRole(role), false, role);
		assert.equal(roleSpec(role), undefined, role);
		assert.equal(canChangeFiles(role), true, "unknown roles retain the conservative file-changing classification");
		for (const backend of ["claude", "pi"]) {
			const records = runRecords([entry({ run: "run-1", role, backend })]);
			assert.deepEqual([...records.runs], [], `${backend}: ${role}`);
			assert.equal(records.highest, 0, "an invalid role takes no handle");
		}
	}
	assert.deepEqual([...runRecords([entry({ run: "job-1", role: "plan" })]).runs], []);
});

test("the latest plan run is tracked per backend, and a refused pi plan is still pi's latest", () => {
	const records = runRecords([
		entry({ run: "run-1", role: "plan", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" }),
		entry(piEntry({ run: "run-2", role: "plan" })),
		entry(piEntry({ run: "run-3", role: "plan", session: { backend: "pi", sessionId: "pi-3", sessionFile: "/sessions/pi-3.jsonl" } })),
	]);
	assert.deepEqual([...records.lastPlan].sort(), [
		["claude", "run-1"],
		["pi", "run-3"],
	]);
	assert.match(records.runs.get("run-3")?.refusal ?? "", /no trusted checkpoint/);
});

test("nextSession still maps a record to the claude session shapes it always had, and refuses a pi one", () => {
	assert.equal(nextSession(undefined, "h-1").kind, "new");
	assert.deepEqual(nextSession(only({ run: "run-1", role: "plan", hostSessionId: "h-1", sessionId: "s-1" }), "h-1"), { kind: "resume", id: "s-1" });
	assert.deepEqual(nextSession(only({ run: "run-1", role: "plan", hostSessionId: "h-1", sessionId: "s-1", checkpoint: "c-1" }), "h-1"), { kind: "resume", id: "s-1", at: "c-1" });
	const forked = nextSession(only({ run: "run-1", role: "plan", hostSessionId: "h-1", sessionId: "s-1", checkpoint: "c-1" }), "h-2");
	assert.equal(forked.kind, "fork");
	assert.match(forked.id, UUID);
	assert.deepEqual({ from: (forked as { from: string }).from, at: (forked as { at?: string }).at }, { from: "s-1", at: "c-1" });
	assert.throws(() => nextSession(only({ run: "run-1", role: "plan", backend: "pi", hostSessionId: "h-1" }), "h-1"), /recorded no verified session/);
	assert.throws(() => nextSession(only(piEntry()), "host-1"), /pi session pi-1 cannot be continued by the claude backend/);
});

const claudeCall = (over: Partial<RecordCall> = {}): RecordCall => ({ handle: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", intent: { kind: "new" }, ...over });

const piCall = (over: Partial<RecordCall> = {}): RecordCall => ({ handle: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", intent: { kind: "new" }, ...over });

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({ ok: true, ...over });

const RESUME: SessionIntent = { kind: "resume", ref: PI_REF };
const FORK: SessionIntent = { kind: "fork", from: PI_REF };
const FORKED: PiSessionRef = { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl", checkpoint: PI_REF.checkpoint };

test("a claude run records what it always recorded, under its backend tag", () => {
	assert.deepEqual(recordDecision(claudeCall(), outcome({ sessionId: "s-1", checkpoint: "c-1", contextTokens: 10, contextWindow: 100 })), {
		entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", contextTokens: 10, contextWindow: 100 },
	});
	assert.deepEqual(recordDecision(claudeCall(), outcome({ ok: false })), { entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1" } });
	assert.deepEqual(recordDecision(claudeCall({ prior: { handle: "run-1", role: "implement" } }), outcome({ ok: false })), { keep: true });
	const source = { backend: "claude" as const, sessionId: "s-1", checkpoint: "c-1" };
	assert.deepEqual(recordDecision(claudeCall({ intent: { kind: "resume", ref: source } }), outcome({ ok: false, sessionId: "s-1", checkpoint: "c-9" })), { keep: true });
	assert.deepEqual(recordDecision(claudeCall({ intent: { kind: "fork", from: source } }), outcome({ ok: false, sessionId: "s-2", checkpoint: "c-9" })), {
		entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-2", checkpoint: "c-1" },
	});
	assert.deepEqual(recordDecision(claudeCall({ mode: "review", role: "ask" }), outcome({ sessionId: "s-1" })), {
		entry: { run: "run-1", role: "ask", backend: "claude", hostSessionId: "host-1", mode: "review", sessionId: "s-1" },
	});
});

test("a claude run that also reports a structured reference has it checked, and a legacy outcome is still recorded from its flat fields", () => {
	const ref = { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } as const;
	assert.deepEqual(recordDecision(claudeCall(), outcome({ sessionId: "s-1", checkpoint: "c-1", session: ref })), {
		entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" },
	});
	// A failed fork's reference keeps the checkpoint it forked at while the flat one is the tip it failed on: both are recorded as they were.
	const source = { backend: "claude" as const, sessionId: "s-1", checkpoint: "c-1" };
	assert.deepEqual(
		recordDecision(claudeCall({ intent: { kind: "fork", from: source } }), outcome({ ok: false, sessionId: "s-2", checkpoint: "c-9", session: { backend: "claude", sessionId: "s-2", checkpoint: "c-1" } })),
		{ entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-2", checkpoint: "c-1" } },
	);
	const cases: Array<[RunOutcome, RegExp]> = [
		[outcome({ sessionId: "s-1", session: PI_REF }), /reported a session reference that is not a claude session/],
		[outcome({ sessionId: "s-1", session: { backend: "claude", sessionId: "" } as never }), /reported a session reference that is not a claude session/],
		[outcome({ sessionId: "s-1", session: { backend: "claude", sessionId: "s-2" } }), /reported one claude session in its reference and another in its outcome/],
		[outcome({ sessionId: "s-1", checkpoint: "c-1", session: { sessionId: "s-2" } as never }), /reported one claude session in its reference and another in its outcome/],
	];
	for (const [given, expected] of cases) {
		const decision = recordDecision(claudeCall({ prior: { handle: "run-1", role: "implement", backend: "claude", sessionId: "s-0" } }), given);
		assert.ok("invalid" in decision, `expected an invalid postcondition for ${expected}`);
		assert.match(decision.invalid, /^invalid session postcondition: run-1 /);
		assert.match(decision.invalid, expected);
		assert.match(decision.invalid, /its earlier record, if any, is unchanged/);
	}
	// An untagged reference in a claude run is that run's own, exactly as a nested session in a claude entry is.
	assert.deepEqual(recordDecision(claudeCall(), outcome({ sessionId: "s-1", checkpoint: "c-1", session: { sessionId: "s-1" } as never })), {
		entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" },
	});
});

test("a successful pi run records the session it settled in, its checkpoint and its actual selection", () => {
	assert.deepEqual(recordDecision(piCall(), outcome({ session: PI_REF, selection: PI_SELECTION, contextTokens: 10, contextWindow: 100 })), {
		entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: PI_REF, selection: PI_SELECTION, contextTokens: 10, contextWindow: 100 },
	});
	assert.deepEqual(recordDecision(piCall({ intent: RESUME }), outcome({ session: PI_REF, selection: PI_SELECTION })), {
		entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: PI_REF, selection: PI_SELECTION },
	});
});

test("a pi outcome that claims a session the run cannot have had records nothing and fails the run", () => {
	const { checkpoint, ...noCheckpoint } = PI_REF;
	const cases: Array<[RecordCall, RunOutcome, RegExp]> = [
		[piCall(), outcome({ selection: PI_SELECTION }), /succeeded without reporting the session it ran in/],
		[piCall(), outcome({ session: noCheckpoint, selection: PI_SELECTION }), /succeeded without reporting the checkpoint its session settled on/],
		[piCall(), outcome({ session: PI_REF }), /succeeded without reporting the model and effort it ran with/],
		[piCall(), outcome({ session: { backend: "pi", sessionId: "pi-1" } as PiSessionRef, selection: PI_SELECTION }), /without a pi session id and session file/],
		[piCall({ intent: RESUME }), outcome({ session: { ...PI_REF, sessionId: "pi-9" }, selection: PI_SELECTION }), /resumed one session and reported another/],
		[piCall({ intent: RESUME }), outcome({ session: { ...PI_REF, sessionFile: "/sessions/other.jsonl" }, selection: PI_SELECTION }), /resumed one session and reported another/],
		[piCall({ intent: FORK }), outcome({ session: { ...FORKED, sessionId: PI_REF.sessionId }, selection: PI_SELECTION }), /forked its session and reported the session it forked from/],
		[piCall({ intent: FORK }), outcome({ session: { ...FORKED, sessionFile: PI_REF.sessionFile }, selection: PI_SELECTION }), /forked its session and reported the session it forked from/],
		[piCall({ intent: FORK }), outcome({ ok: false, session: { ...FORKED, checkpoint: "entry-99" }, selection: PI_SELECTION }), /forked and failed without keeping the checkpoint it forked at/],
		[piCall({ intent: FORK }), outcome({ ok: false, session: { ...FORKED, checkpoint: undefined }, selection: PI_SELECTION }), /forked and failed without keeping the checkpoint it forked at/],
		[piCall(), outcome({ ok: false, session: PI_REF, selection: PI_SELECTION }), /failed and claimed a trusted checkpoint/],
		[piCall({ intent: { kind: "resume", ref: { backend: "claude", sessionId: "s-1" } } }), outcome({ session: PI_REF, selection: PI_SELECTION }), /was started from a claude session/],
	];
	for (const [call, given, expected] of cases) {
		const decision = recordDecision(call, given);
		assert.ok("invalid" in decision, `expected an invalid postcondition for ${expected}`);
		assert.match(decision.invalid, /^invalid session postcondition: run-1 /);
		assert.match(decision.invalid, expected);
		assert.match(decision.invalid, /nothing was recorded for it and its earlier record, if any, is unchanged/);
	}
});

test("a pi run that failed records only what the recovery policy trusts", () => {
	const { checkpoint, ...identity } = PI_REF;
	// A first call that failed with an identity keeps it, so the next call for the handle fails closed rather than reopening it.
	assert.deepEqual(recordDecision(piCall(), outcome({ ok: false, session: identity, selection: PI_SELECTION })), {
		entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: identity, selection: PI_SELECTION },
	});
	assert.deepEqual(recordDecision(piCall(), outcome({ ok: false, session: identity })), {
		entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: identity },
	});
	// A failure before any session exists records the handle alone, and only when the branch holds nothing for it yet.
	assert.deepEqual(recordDecision(piCall(), outcome({ ok: false })), { entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1" } });
	assert.deepEqual(recordDecision(piCall({ prior: { handle: "run-1", role: "implement", backend: "pi" } }), outcome({ ok: false })), { keep: true });
	// A failed continuation records nothing at all, so its last successful checkpoint stays authoritative.
	assert.deepEqual(recordDecision(piCall({ intent: RESUME }), outcome({ ok: false, session: PI_REF, selection: PI_SELECTION })), { keep: true });
	assert.deepEqual(recordDecision(piCall({ intent: RESUME }), outcome({ ok: false })), { keep: true });
	assert.deepEqual(recordDecision(piCall({ intent: FORK }), outcome({ ok: false })), { keep: true }, "a fork cancelled before it existed leaves the source record");
	// A fork that failed after its session existed keeps that session and the checkpoint it forked at.
	assert.deepEqual(recordDecision(piCall({ intent: FORK }), outcome({ ok: false, session: FORKED, selection: PI_SELECTION })), {
		entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: FORKED, selection: PI_SELECTION },
	});
});

test("a fork verified before the call failed keeps its identity even when no selection was ever read back", () => {
	// The fork exists: another id, another file, and the checkpoint it forked at. A partial failure that never read a
	// selection back leaves that identity recorded, and nothing stands in for the selection it did not report.
	for (const given of [outcome({ ok: false, session: FORKED }), outcome({ ok: false, session: FORKED, selection: { model: "deepseek-chat", effort: "medium" } })]) {
		assert.deepEqual(recordDecision(piCall({ intent: FORK }), given), {
			entry: { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: FORKED },
		});
	}
	// The record that makes reads back as the fork, for reading only: it names no selection to repeat, so it is
	// refused for continuation and says which file holds the child, rather than being reforked or run on a guess.
	const decision = recordDecision(piCall({ intent: FORK }), outcome({ ok: false, session: FORKED }));
	assert.ok("entry" in decision);
	const record = only(decision.entry as Record<string, unknown>);
	assert.deepEqual(record.session, FORKED, "the fork this host owns is still named");
	assert.equal(record.selection, undefined);
	assert.match(record.refusal ?? "", /^run-1 recorded no model and effort this host can repeat/);
	assert.match(record.refusal ?? "", /its session file is \/sessions\/pi-2\.jsonl/);
	assert.throws(() => intentFor(record, "host-1"), /recorded no model and effort this host can repeat/);
	// A claimed success is the other case and is still refused: a settled call reports all three or it did not settle.
	const claimed = recordDecision(piCall({ intent: FORK }), outcome({ session: FORKED }));
	assert.ok("invalid" in claimed);
	assert.match(claimed.invalid, /succeeded without reporting the model and effort it ran with/);
});

test("a pi entry this host wrote reads back as the record it meant", () => {
	const decision = recordDecision(piCall({ handle: "run-2", role: "plan" }), outcome({ session: PI_REF, selection: PI_SELECTION }));
	assert.ok("entry" in decision);
	const record = only(decision.entry as Record<string, unknown>);
	assert.deepEqual(record, { handle: "run-2", role: "plan", backend: "pi", hostSessionId: "host-1", session: PI_REF, selection: PI_SELECTION });
});

const codexCall = (over: Partial<RecordCall> = {}): RecordCall => ({ handle: "run-1", role: "implement", backend: "codex", hostSessionId: "host-1", intent: { kind: "new" }, ...over });
const CODEX_ENTRY = { run: "run-1", role: "implement", backend: "codex", hostSessionId: "host-1" };
const CODEX_RESUME: SessionIntent = { kind: "resume", ref: CODEX_REF };
const CODEX_FORK: SessionIntent = { kind: "fork", from: CODEX_REF };
const CODEX_FORKED: CodexSessionRef = { backend: "codex", sessionId: "thread-2", checkpoint: CODEX_REF.checkpoint };

test("a successful codex run records its thread and configured selection, with a checkpoint when it settled on one", () => {
	const { checkpoint, ...bare } = CODEX_REF;
	const withEffort = { ...CODEX_SELECTION, effort: "xhigh" };
	assert.deepEqual(recordDecision(codexCall(), outcome({ session: CODEX_REF, selection: withEffort, contextTokens: 10, contextWindow: 100 })), {
		entry: { ...CODEX_ENTRY, session: CODEX_REF, selection: withEffort, contextTokens: 10, contextWindow: 100 },
	});
	assert.deepEqual(recordDecision(codexCall(), outcome({ session: bare, selection: CODEX_SELECTION })), { entry: { ...CODEX_ENTRY, session: bare, selection: CODEX_SELECTION } }, "a checkpoint is not required yet");
	assert.deepEqual(recordDecision(codexCall({ mode: "review", role: "ask" }), outcome({ session: CODEX_REF, selection: CODEX_SELECTION })), {
		entry: { ...CODEX_ENTRY, role: "ask", mode: "review", session: CODEX_REF, selection: CODEX_SELECTION },
	});
	// A resume reports the thread it resumed, at the checkpoint it settled on.
	assert.deepEqual(recordDecision(codexCall({ intent: CODEX_RESUME }), outcome({ session: { ...CODEX_REF, checkpoint: "turn-3" }, selection: CODEX_SELECTION })), {
		entry: { ...CODEX_ENTRY, session: { ...CODEX_REF, checkpoint: "turn-3" }, selection: CODEX_SELECTION },
	});
	assert.deepEqual(recordDecision(codexCall({ intent: CODEX_FORK }), outcome({ session: { ...CODEX_FORKED, checkpoint: "turn-3" }, selection: CODEX_SELECTION })), {
		entry: { ...CODEX_ENTRY, session: { ...CODEX_FORKED, checkpoint: "turn-3" }, selection: CODEX_SELECTION },
	});
	// What a successful entry says reads back as the record it meant: continued with a checkpoint, kept for reading without one.
	const settled = recordDecision(codexCall({ handle: "run-2" }), outcome({ session: CODEX_REF, selection: withEffort }));
	assert.ok("entry" in settled);
	assert.deepEqual(only(settled.entry as Record<string, unknown>), { handle: "run-2", role: "implement", backend: "codex", hostSessionId: "host-1", session: CODEX_REF, selection: withEffort });
	const unsettled = recordDecision(codexCall(), outcome({ session: bare, selection: CODEX_SELECTION }));
	assert.ok("entry" in unsettled);
	const readable = only(unsettled.entry as Record<string, unknown>);
	assert.deepEqual(readable.session, bare);
	assert.match(readable.refusal ?? "", /^run-1 ran on codex and recorded no trusted checkpoint.*codex resume thread-1/);
	assert.throws(() => intentFor(readable, "host-1"), /recorded no trusted checkpoint/);
});

test("a codex outcome that claims a thread or a selection the run cannot have had records nothing and fails the run", () => {
	const cases: Array<[RecordCall, RunOutcome, RegExp]> = [
		[codexCall(), outcome({ selection: CODEX_SELECTION }), /succeeded without reporting the thread it ran in/],
		[codexCall(), outcome({ session: CODEX_REF }), /succeeded without reporting the configured model and provider it ran with/],
		[codexCall(), outcome({ session: CODEX_REF, selection: { model: "gpt-5-codex" } }), /succeeded without reporting the configured model and provider/],
		[codexCall(), outcome({ session: CODEX_REF, selection: { model: "gpt-5-codex", effort: "high" } }), /succeeded without reporting the configured model and provider/],
		[codexCall(), outcome({ session: CODEX_REF, selection: { ...CODEX_SELECTION, effort: "" } }), /succeeded without reporting the configured model and provider/],
		[codexCall(), outcome({ session: { sessionId: "thread-1" } as never, selection: CODEX_SELECTION }), /reported a session reference that is not a codex thread/],
		[codexCall(), outcome({ session: PI_REF, selection: CODEX_SELECTION }), /reported a session reference that is not a codex thread/],
		[codexCall(), outcome({ session: { backend: "claude", sessionId: "thread-1" }, selection: CODEX_SELECTION }), /reported a session reference that is not a codex thread/],
		[codexCall(), outcome({ session: { ...CODEX_REF, sessionFile: "/sessions/pi-1.jsonl" } as never, selection: CODEX_SELECTION }), /reported a session reference that is not a codex thread/],
		[codexCall(), outcome({ session: { ...CODEX_REF, sessionId: "" }, selection: CODEX_SELECTION }), /reported a session reference that is not a codex thread/],
		[codexCall(), outcome({ sessionId: "thread-1", selection: CODEX_SELECTION }), /reported a flat session id or checkpoint/],
		[codexCall(), outcome({ sessionId: "thread-1", checkpoint: "turn-2", session: CODEX_REF, selection: CODEX_SELECTION }), /reported a flat session id or checkpoint/],
		[codexCall(), outcome({ ok: false, checkpoint: "turn-2" }), /reported a flat session id or checkpoint/],
		[codexCall({ intent: CODEX_RESUME }), outcome({ session: { ...CODEX_REF, sessionId: "thread-9" }, selection: CODEX_SELECTION }), /resumed one thread and reported another/],
		[codexCall({ intent: CODEX_RESUME }), outcome({ ok: false, session: { ...CODEX_REF, sessionId: "thread-9" } }), /resumed one thread and reported another/],
		[codexCall({ intent: CODEX_FORK }), outcome({ session: CODEX_REF, selection: CODEX_SELECTION }), /forked its thread and reported the thread it forked from/],
		// Only a new thread may succeed without a checkpoint: a continuation that settled on none fails, and its prior record stays.
		[codexCall({ intent: CODEX_RESUME }), outcome({ session: { ...CODEX_REF, checkpoint: undefined }, selection: CODEX_SELECTION }), /continued its thread and succeeded without reporting the checkpoint it settled on/],
		[codexCall({ intent: CODEX_FORK }), outcome({ session: { ...CODEX_FORKED, checkpoint: undefined }, selection: CODEX_SELECTION }), /continued its thread and succeeded without reporting the checkpoint it settled on/],
		[codexCall({ intent: CODEX_FORK }), outcome({ ok: false, session: { ...CODEX_FORKED, checkpoint: "turn-9" } }), /forked and failed without keeping the checkpoint it forked at/],
		[codexCall({ intent: CODEX_FORK }), outcome({ ok: false, session: { ...CODEX_FORKED, checkpoint: undefined } }), /forked and failed without keeping the checkpoint it forked at/],
		[codexCall(), outcome({ ok: false, session: CODEX_REF, selection: CODEX_SELECTION }), /failed and claimed a trusted checkpoint/],
		[codexCall({ intent: RESUME }), outcome({ session: CODEX_REF, selection: CODEX_SELECTION }), /was started from a pi session, which no codex run can continue/],
		[codexCall({ intent: { kind: "fork", from: { backend: "claude", sessionId: "s-1" } } }), outcome({ ok: false }), /was started from a claude session, which no codex run can continue/],
	];
	for (const [call, given, expected] of cases) {
		const decision = recordDecision({ ...call, prior: { handle: "run-1", role: "implement", backend: "codex", session: CODEX_REF, selection: CODEX_SELECTION } }, given);
		assert.ok("invalid" in decision, `expected an invalid postcondition for ${expected}`);
		assert.match(decision.invalid, /^invalid session postcondition: run-1 /);
		assert.match(decision.invalid, expected);
		assert.match(decision.invalid, /nothing was recorded for it and its earlier record, if any, is unchanged/);
	}
});

test("a codex run that failed records only what the recovery policy trusts", () => {
	const { checkpoint, ...bare } = CODEX_REF;
	// A first call that failed with a thread keeps it without a checkpoint, for reading only.
	assert.deepEqual(recordDecision(codexCall(), outcome({ ok: false, session: bare, selection: CODEX_SELECTION })), { entry: { ...CODEX_ENTRY, session: bare, selection: CODEX_SELECTION } });
	assert.deepEqual(recordDecision(codexCall(), outcome({ ok: false, session: bare, selection: { model: "gpt-5-codex" } })), { entry: { ...CODEX_ENTRY, session: bare } }, "an unusable selection is dropped");
	// A failure before any thread exists records the handle alone, and only when the branch holds nothing for it yet.
	assert.deepEqual(recordDecision(codexCall(), outcome({ ok: false })), { entry: CODEX_ENTRY });
	assert.deepEqual(only({ ...CODEX_ENTRY }).refusal, "run-1 ran on codex and recorded no verified thread, so it cannot be continued; start a new run without continue");
	assert.deepEqual(recordDecision(codexCall({ prior: { handle: "run-1", role: "implement", backend: "codex" } }), outcome({ ok: false })), { keep: true });
	// A failed continuation records nothing at all, so the last successful record of the handle stays authoritative.
	assert.deepEqual(recordDecision(codexCall({ intent: CODEX_RESUME }), outcome({ ok: false, session: { ...CODEX_REF, checkpoint: "turn-3" }, selection: CODEX_SELECTION })), { keep: true });
	assert.deepEqual(recordDecision(codexCall({ intent: CODEX_RESUME }), outcome({ ok: false })), { keep: true });
	assert.deepEqual(recordDecision(codexCall({ intent: CODEX_FORK }), outcome({ ok: false })), { keep: true }, "a fork cancelled before it existed leaves the source record");
	// A fork that failed after its thread existed keeps that thread at the checkpoint it forked at, selection only when read back.
	assert.deepEqual(recordDecision(codexCall({ intent: CODEX_FORK }), outcome({ ok: false, session: CODEX_FORKED, selection: CODEX_SELECTION })), { entry: { ...CODEX_ENTRY, session: CODEX_FORKED, selection: CODEX_SELECTION } });
	const fork = recordDecision(codexCall({ intent: CODEX_FORK }), outcome({ ok: false, session: CODEX_FORKED }));
	assert.deepEqual(fork, { entry: { ...CODEX_ENTRY, session: CODEX_FORKED } });
	assert.ok("entry" in fork);
	const record = only(fork.entry as Record<string, unknown>);
	assert.deepEqual(record.session, CODEX_FORKED, "the fork this host owns is still named");
	assert.match(record.refusal ?? "", /^run-1 recorded no codex model and provider this host can repeat.*codex resume thread-2/);
	assert.throws(() => intentFor(record, "host-1"), /recorded no codex model and provider/);
});

test("a claude entry that keeps its identity only in a session reference is refused, never read as a run with none", () => {
	const record = only({ run: "run-1", role: "implement", hostSessionId: "host-1", session: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } });
	assert.equal(record.handle, "run-1", "the handle stays taken");
	assert.equal(record.backend, "claude");
	assert.equal(record.session, undefined, "an identity this host will not act on is not one it holds");
	assert.match(record.refusal ?? "", /^run-1 records its claude session s-1 in a session reference and not in the session id this format carries; it cannot be continued, so start a new run$/);
	assert.throws(() => intentFor(record, "host-1"), /records its claude session s-1 in a session reference/);
	// An entry with neither is the run with no identity it has always been, and still starts a new session.
	const none = only({ run: "run-1", role: "implement", hostSessionId: "host-1" });
	assert.equal(none.refusal, undefined);
	assert.deepEqual(intentFor(none, "host-1"), { kind: "new" });
	// And an empty flat id keeps the legacy reading it has always had: no identity, no refusal.
	const empty = only({ run: "run-1", role: "implement", hostSessionId: "host-1", sessionId: "" });
	assert.equal(empty.refusal, undefined);
	assert.deepEqual(intentFor(empty, "host-1"), { kind: "new" });
});

/*
 * Metadata no outcome of any backend in this build reports, shaped like what a credential-aware one could: a path to
 * an auth file, a path to a models file, a key, a token pair and a structured blob holding more of the same. A record
 * is composed from the fields it names, so a decision must carry none of it, whichever backend and whichever verdict.
 * What this pins is the allowlisting of the structured metadata Fusion composes; it is not redaction of a task, a
 * report or a model name, which are the run's own text and are recorded as the run gave them.
 */
const EXTRA: Record<string, unknown> = {
	authPath: "/dummy/auth-DUMMYAUTHPATH.json",
	modelsPath: "/dummy/models-DUMMYMODELSPATH.json",
	apiKey: "sk-DUMMYAPIKEY-0123456789",
	access: "DUMMYACCESSTOKEN-0123456789",
	refresh: "DUMMYREFRESHTOKEN-0123456789",
	credential: { provider: "dummy", store: "/dummy/store-DUMMYSTOREPATH.json", apiKey: "sk-DUMMYNESTEDKEY-0123456789", expiresAt: 4_102_444_800_000 },
};

/** Every planted value that must appear in no entry, so a match is unmistakable rather than a plausible coincidence. */
const DUMMIES = ["DUMMYAUTHPATH", "DUMMYMODELSPATH", "DUMMYAPIKEY", "DUMMYACCESSTOKEN", "DUMMYREFRESHTOKEN", "DUMMYSTOREPATH", "DUMMYNESTEDKEY", "sk-DUMMY"];

/** The same outcome with that metadata on it, which no production backend composes and no reader of one expects. */
const withExtra = (given: RunOutcome): RunOutcome => ({ ...given, ...EXTRA }) as RunOutcome;

/** What a decision recorded, checked for the planted fields and values by key and by serialised text alike. */
const carriesNoExtra = (what: string, entry: Record<string, unknown>): void => {
	const text = JSON.stringify(entry);
	for (const key of Object.keys(EXTRA)) assert.ok(!(key in entry), `${what} kept the planted field ${key}`);
	for (const key of Object.keys(EXTRA)) assert.ok(!text.includes(`"${key}"`), `${what} kept the planted field ${key} somewhere inside it`);
	for (const dummy of DUMMIES) assert.ok(!text.includes(dummy), `${what} kept the planted value ${dummy}`);
};

test("an outcome carrying metadata no backend reports records the supported fields and exactly those", () => {
	const piEntryFields = { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1" };
	const claudeEntryFields = { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1" };
	const { checkpoint, ...identity } = PI_REF;
	const claudeSource = { backend: "claude" as const, sessionId: "s-1", checkpoint: "c-1" };
	const cases: Array<{ what: string; call: RecordCall; given: RunOutcome; entry: Record<string, unknown> }> = [
		{
			what: "a settled pi run",
			call: piCall(),
			given: withExtra(outcome({ session: PI_REF, selection: PI_SELECTION, contextTokens: 10, contextWindow: 100 })),
			entry: { ...piEntryFields, session: PI_REF, selection: PI_SELECTION, contextTokens: 10, contextWindow: 100 },
		},
		{
			what: "a first pi call that failed with an identity",
			call: piCall(),
			given: withExtra(outcome({ ok: false, session: identity, selection: PI_SELECTION })),
			entry: { ...piEntryFields, session: identity, selection: PI_SELECTION },
		},
		{
			what: "a pi fork that failed after its session existed",
			call: piCall({ intent: FORK }),
			given: withExtra(outcome({ ok: false, session: FORKED, selection: PI_SELECTION })),
			entry: { ...piEntryFields, session: FORKED, selection: PI_SELECTION },
		},
		{
			what: "a pi run that verified nothing",
			call: piCall(),
			given: withExtra(outcome({ ok: false })),
			entry: piEntryFields,
		},
		{
			what: "a settled claude run",
			call: claudeCall(),
			given: withExtra(outcome({ sessionId: "s-1", checkpoint: "c-1", contextTokens: 10, contextWindow: 100 })),
			entry: { ...claudeEntryFields, sessionId: "s-1", checkpoint: "c-1", contextTokens: 10, contextWindow: 100 },
		},
		{
			what: "a claude fork that failed",
			call: claudeCall({ intent: { kind: "fork", from: claudeSource } }),
			given: withExtra(outcome({ ok: false, sessionId: "s-2", checkpoint: "c-9" })),
			entry: { ...claudeEntryFields, sessionId: "s-2", checkpoint: "c-1" },
		},
		{
			what: "a claude review run",
			call: claudeCall({ mode: "review", role: "ask" }),
			given: withExtra(outcome({ sessionId: "s-1" })),
			entry: { run: "run-1", role: "ask", backend: "claude", hostSessionId: "host-1", mode: "review", sessionId: "s-1" },
		},
	];
	for (const one of cases) {
		const decision = recordDecision(one.call, one.given);
		assert.ok("entry" in decision, `${one.what}: expected an entry`);
		// The positive control and the absence in one assertion: the entry is the supported fields, so nothing was planted
		// in it and nothing legitimate was dropped to get there either.
		assert.deepEqual(decision.entry, one.entry, one.what);
		carriesNoExtra(one.what, decision.entry);
	}
	// A decision that records nothing, and one the host refuses, carry no planted field either: there is nothing to put it in.
	assert.deepEqual(recordDecision(piCall({ intent: RESUME }), withExtra(outcome({ ok: false, session: PI_REF, selection: PI_SELECTION }))), { keep: true });
	const refused = recordDecision(piCall(), withExtra(outcome({ session: PI_REF })));
	assert.ok("invalid" in refused);
	for (const dummy of DUMMIES) assert.ok(!refused.invalid.includes(dummy), `a refusal repeats the planted ${dummy}`);
	// And the entry a settled pi run wrote reads back as the record it meant, with no planted field surviving the round trip.
	const settled = recordDecision(piCall(), withExtra(outcome({ session: PI_REF, selection: PI_SELECTION })));
	assert.ok("entry" in settled);
	const record = only(settled.entry as Record<string, unknown>);
	assert.deepEqual(record, { handle: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1", session: PI_REF, selection: PI_SELECTION });
	carriesNoExtra("the record a settled pi entry reads back as", record as unknown as Record<string, unknown>);
});

test("a claude outcome that knows its session only as a reference fails instead of recording a run with no session", () => {
	const ref = { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } as const;
	for (const call of [claudeCall(), claudeCall({ prior: { handle: "run-1", role: "implement", backend: "claude", sessionId: "s-0" } })]) {
		const decision = recordDecision(call, outcome({ session: ref }));
		assert.ok("invalid" in decision, "a known identity must not be dropped into a handle-only record");
		assert.match(decision.invalid, /^invalid session postcondition: run-1 reported claude session s-1 in a session reference and no session id beside it/);
		assert.match(decision.invalid, /its earlier record, if any, is unchanged/);
	}
	// A run that reported no session at all is unchanged: a first call records its handle, a continued one nothing.
	assert.deepEqual(recordDecision(claudeCall(), outcome({})), { entry: { run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1" } });
	assert.deepEqual(recordDecision(claudeCall({ prior: { handle: "run-1", role: "implement" } }), outcome({})), { keep: true });
});
