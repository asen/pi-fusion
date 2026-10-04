import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { CODEX_APP_SERVER_ARGS } from "../extensions/backends/codex-launch.ts";
import {
	boundText,
	CODEX_PROTOCOL_PROVENANCE,
	readApproval,
	readErrorNotice,
	readInitialize,
	readItem,
	readReroute,
	readThreadRead,
	readThreadStart,
	readThreadStatusChanged,
	readTokenUsage,
	readTurnCompleted,
	readTurnStart,
	readTurnStarted,
	sandboxModeOf,
} from "../extensions/backends/codex-protocol.ts";
import {
	CODEX_BOUNDS,
	CODEX_UNSUPPORTED_CODE,
	type CodexBounds,
	type CodexChild,
	type CodexChildOptions,
	CodexCorrelator,
	type CodexExit,
	CodexStderrTail,
	CodexTransportError,
	type CodexTurnResult,
	codexBounds,
	codexWriterCaps,
	readMessage,
	startCodexChild,
} from "../extensions/backends/codex-transport.ts";
import type { OwnedCleanup } from "../extensions/process-tree.ts";

/*
 * Two halves, and they are not the same kind of evidence. The first drives the pure readers, envelope, correlator and
 * stderr tail directly: nothing there starts a process. The second drives the lifecycle against `test/fake-codex.mjs`,
 * a node program speaking literal app-server JSON-RPC, launched by its own path under this host's node with an
 * environment of its own: no Codex package, binary, home, auth or `PATH` lookup is involved, and nothing here is
 * evidence about what a real Codex app-server does. The shapes are a source reading of Codex 0.160.0.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CODEX = path.join(repoRoot, "test", "fake-codex.mjs");
/** The suite's resolution fence for subprocesses: a rule, not a sandbox. */
const FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");

/* ------------------------------------------------------------------------------------------------------------------
 * Pure pieces
 * ---------------------------------------------------------------------------------------------------------------- */

test("the protocol says where it comes from: a source reading of one version, never a runtime qualification", () => {
	assert.deepEqual({ ...CODEX_PROTOCOL_PROVENANCE }, { version: "0.160.0", evidence: "source inspection", runtime: "unqualified" });
	assert.ok(Object.isFrozen(CODEX_PROTOCOL_PROVENANCE));
});

test("the bounds are bounded by default, refuse what is not a positive safe integer, and derive the writer's caps", () => {
	assert.deepEqual(codexBounds(), { ...CODEX_BOUNDS });
	for (const value of Object.values(CODEX_BOUNDS)) assert.ok(Number.isSafeInteger(value) && value > 0);
	assert.ok(CODEX_BOUNDS.initializeMs <= 120_000 && CODEX_BOUNDS.requestMs <= 120_000 && CODEX_BOUNDS.shutdownStepMs <= 30_000, "every production clock is finite and short");
	for (const bad of [0, -1, 1.5, Number.NaN, null as unknown as number, "5" as unknown as number]) assert.throws(() => codexBounds({ requestMs: bad }), /requestMs must be a positive safe integer/);
	assert.throws(() => codexBounds({ shutdownStepMs: 2 ** 31 }), /at most/);
	assert.deepEqual(codexWriterCaps({ ...CODEX_BOUNDS, maxPendingRequests: 3, maxOutboundFrameBytes: 100 }), { items: 8, bytes: 200 });
});

test("an envelope is read as Codex speaks it: jsonrpc optional, ids and methods checked, exactly one of result and error", () => {
	assert.deepEqual(readMessage({ id: 1, result: {} }), { ok: true, value: { kind: "result", id: 1, result: {} } });
	assert.deepEqual(readMessage({ jsonrpc: "2.0", id: 2, result: null }), { ok: true, value: { kind: "result", id: 2, result: null } });
	assert.deepEqual(readMessage({ id: 3, error: { code: -32600, message: "no", data: 1 } }), { ok: true, value: { kind: "error", id: 3, code: -32600, message: "no", cut: false } });
	assert.deepEqual(readMessage({ method: "turn/started", params: { a: 1 } }), { ok: true, value: { kind: "notification", method: "turn/started", params: { a: 1 } } });
	assert.deepEqual(readMessage({ id: "srv-1", method: "item/commandExecution/requestApproval", params: {} }), { ok: true, value: { kind: "request", id: "srv-1", method: "item/commandExecution/requestApproval", params: {} } });
	const cut = readMessage({ id: 4, error: { code: 1, message: "é".repeat(100) } }, 11);
	assert.ok(cut.ok && cut.value.kind === "error" && cut.value.cut && cut.value.message === "é".repeat(5));
	for (const bad of [[], "x", null, { jsonrpc: "1.0", id: 1, result: 1 }, { id: 1 }, { id: 1, result: 1, error: { code: 1, message: "m" } }, { id: 1, error: { message: "m" } }, { id: 1, error: "m" }, { method: "" }, { method: 7 }, { method: "a b" }, { method: "x", id: 1.5 }, { method: "x", id: {} }, { params: {} }]) {
		assert.equal(readMessage(bad).ok, false, JSON.stringify(bad));
	}
});

test("host ids count up from one and live apart from the child's: pending, late and impossible, with a slot cap", () => {
	const correlator = new CodexCorrelator(2);
	const settled: unknown[] = [];
	const first = correlator.issue("thread/read", { settle: (outcome) => settled.push(outcome) });
	const second = correlator.issue("thread/read", { settle: (outcome) => settled.push(outcome) });
	assert.deepEqual([first, second], [1, 2]);
	assert.throws(() => correlator.issue("thread/read", { settle: () => {} }), (error: unknown) => error instanceof CodexTransportError && error.kind === "refused");
	assert.equal(correlator.classify(1), "pending");
	assert.equal(correlator.classify("1"), "impossible", "a string id is a server request's kind of id, never one of ours");
	assert.equal(correlator.classify(3), "impossible");
	assert.equal(correlator.classify(0), "impossible");
	assert.equal(correlator.settle(1, { ok: true, result: 1 }), true);
	assert.equal(correlator.settle(1, { ok: true, result: 2 }), false, "an answer repeated settles nothing");
	assert.equal(correlator.classify(1), "late");
	assert.equal(correlator.settleAll({ kind: "closed", message: "closed" }), 1);
	assert.equal(settled.length, 2);
});

/** The contract text a thread is started with; the fake's log is what shows it went over the wire unchanged. */
const CONTRACT = "You are the implement role.\nFollow the contract exactly.";

const START = {
	thread: { id: "thr-1", status: { type: "idle" }, extra: 1 },
	model: "gpt-5",
	modelProvider: "openai",
	cwd: "/work",
	sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
	reasoningEffort: null,
	approvalPolicy: "never",
	laterField: "tolerated",
};

test("thread/start is read for its identity and selection, effort nullable, extra fields tolerated, and every missing piece refused", () => {
	const read = readThreadStart(START);
	assert.deepEqual(read, { ok: true, value: { threadId: "thr-1", model: "gpt-5", modelProvider: "openai", cwd: "/work", sandbox: { type: "workspaceWrite" }, reasoningEffort: null, approvalPolicy: "never" } });
	const { reasoningEffort: _effort, ...noEffort } = START;
	assert.equal(readThreadStart(noEffort).ok && (readThreadStart(noEffort) as { value: { reasoningEffort: unknown } }).value.reasoningEffort, null, "an effort left out is the same as null");
	assert.deepEqual(readThreadStart({ ...START, reasoningEffort: "high" }).ok && (readThreadStart({ ...START, reasoningEffort: "high" }) as { value: { reasoningEffort: unknown } }).value.reasoningEffort, "high");
	assert.equal(sandboxModeOf({ type: "readOnly" }), "read-only");
	assert.equal(sandboxModeOf({ type: "workspaceWrite" }), "workspace-write");
	assert.equal(sandboxModeOf({ type: "dangerFullAccess" }), undefined, "a tag no request names maps onto none");
	const broken: [string, unknown][] = [
		["no thread", { ...START, thread: undefined }],
		["no thread id", { ...START, thread: {} }],
		["no model", { ...START, model: undefined }],
		["blank model", { ...START, model: "" }],
		["no provider", { ...START, modelProvider: undefined }],
		["relative cwd", { ...START, cwd: "work" }],
		["untagged sandbox", { ...START, sandbox: "workspace-write" }],
		["sandbox with no tag", { ...START, sandbox: {} }],
		["effort of another type", { ...START, reasoningEffort: 3 }],
		["an array", [START]],
	];
	for (const [what, value] of broken) assert.equal(readThreadStart(value).ok, false, what);
});

test("a reported sandbox is read for its tag alone, whatever else the policy carries tolerated and left out", () => {
	const sandbox = (policy: unknown) => {
		const read = readThreadStart({ ...START, sandbox: policy });
		assert.ok(read.ok, "a policy field beyond the tag never fails the answer");
		return read.value.sandbox;
	};
	assert.deepEqual(sandbox({ type: "workspaceWrite", writableRoots: ["/a", "relative"], networkAccess: "yes", excludeSlashTmp: 0 }), { type: "workspaceWrite" });
	assert.deepEqual(sandbox({ type: "externalSandbox", networkAccess: "restricted" }), { type: "externalSandbox" });
	assert.equal(sandboxModeOf(sandbox({ type: "workspaceWrite", writableRoots: ["/a"] })), "workspace-write", "the mode comparison reads the tag alone");
});

test("thread/read reports configured values that may be null and a status this version has, and refuses anything else", () => {
	const thread = { id: "thr-1", model: null, modelProvider: "openai", reasoningEffort: null, cwd: "/work", status: { type: "idle" }, turns: [] };
	assert.deepEqual(readThreadRead({ thread }), { ok: true, value: { threadId: "thr-1", model: null, modelProvider: "openai", reasoningEffort: null, cwd: "/work", status: { type: "idle" } } });
	const active = readThreadRead({ thread: { ...thread, model: "gpt-5", reasoningEffort: "low", status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
	assert.ok(active.ok && active.value.model === "gpt-5" && active.value.status.type === "active" && active.value.status.activeFlags?.[0] === "waitingOnApproval");
	for (const [what, value] of [
		["unknown status", { thread: { ...thread, status: { type: "sleeping" } } }],
		["active with no flags", { thread: { ...thread, status: { type: "active" } } }],
		["no provider", { thread: { ...thread, modelProvider: null } }],
		["model of another type", { thread: { ...thread, model: 5 } }],
		["no thread", {}],
	] as [string, unknown][]) {
		assert.equal(readThreadRead(value).ok, false, what);
	}
	assert.equal(readThreadStatusChanged({ threadId: "thr-1", status: { type: "systemError" } }).ok, true);
	assert.equal(readThreadStatusChanged({ threadId: "thr-1", status: { type: "later" } }).ok, false);
});

test("turns: the start answer names a turn and nothing more, completion has three ends, errors and reroutes keep their turn", () => {
	assert.deepEqual(readTurnStart({ turn: { id: "turn-1", status: "inProgress", items: [] } }), { ok: true, value: { turnId: "turn-1" } });
	assert.equal(readTurnStart({ turn: {} }).ok, false);
	assert.deepEqual(readTurnStarted({ threadId: "t", turn: { id: "u" } }), { ok: true, value: { threadId: "t", turnId: "u" } });
	for (const status of ["completed", "failed", "interrupted"]) assert.equal(readTurnCompleted({ threadId: "t", turn: { id: "u", status, items: [] } }, 64).ok, true, status);
	assert.equal(readTurnCompleted({ threadId: "t", turn: { id: "u", status: "inProgress" } }, 64).ok, false, "in progress is never an end");
	assert.equal(readTurnCompleted({ threadId: "t", turn: { status: "completed" } }, 64).ok, false);
	assert.equal(readTurnCompleted({ threadId: "t", turn: { id: "u", status: "failed", error: { codexErrorInfo: "other" } } }, 64).ok, false, "an error with no message is not one");
	const failed = readTurnCompleted({ threadId: "t", turn: { id: "u", status: "failed", error: { message: "m".repeat(100), codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } } } }, 10);
	assert.deepEqual(failed.ok && failed.value.error, { message: "m".repeat(10), cut: true, info: "responseStreamDisconnected", httpStatusCode: 503 });
	const retry = readErrorNotice({ threadId: "t", turnId: "u", willRetry: true, error: { message: "again", codexErrorInfo: "serverOverloaded" } }, 64);
	assert.deepEqual(retry, { ok: true, value: { threadId: "t", turnId: "u", willRetry: true, error: { message: "again", cut: false, info: "serverOverloaded" } } });
	assert.equal(readErrorNotice({ threadId: "t", turnId: "u", error: { message: "x" } }, 64).ok, false, "an error must say whether it retries");
	assert.deepEqual(readReroute({ threadId: "t", turnId: "u", fromModel: "a", toModel: "b", reason: "highRiskCyberActivity" }), { ok: true, value: { threadId: "t", turnId: "u", fromModel: "a", toModel: "b", reason: "highRiskCyberActivity" } });
	assert.equal(readReroute({ threadId: "t", turnId: "u", fromModel: "a", reason: "r" }).ok, false);
});

test("usage: cumulative total and latest response apart, cached input inside input, the window nullable, malformed refused", () => {
	const b = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 12 };
	const read = readTokenUsage({ threadId: "t", turnId: "u", tokenUsage: { total: b, last: { ...b, cacheWriteInputTokens: 3 }, modelContextWindow: null } });
	assert.deepEqual(read, { ok: true, value: { threadId: "t", turnId: "u", total: { ...b, cacheWriteInputTokens: 0 }, last: { ...b, cacheWriteInputTokens: 3 }, modelContextWindow: null } });
	for (const [what, usage] of [
		["cached past input", { total: { ...b, cachedInputTokens: 11 }, last: b }],
		["negative", { total: { ...b, outputTokens: -1 }, last: b }],
		["fractional", { total: b, last: { ...b, totalTokens: 1.5 } }],
		["no last", { total: b }],
		["window of another type", { total: b, last: b, modelContextWindow: "big" }],
	] as [string, unknown][]) {
		assert.equal(readTokenUsage({ threadId: "t", turnId: "u", tokenUsage: usage }).ok, false, what);
	}
});

test("items and approvals are diagnostics: bounded text, malformed reads as a reason, and an approval keeps only the ids it named", () => {
	const message = readItem({ threadId: "t", turnId: "u", item: { type: "agentMessage", id: "m", text: "hello world" } }, 5);
	assert.deepEqual(message.ok && message.value.text, { text: "hello", cut: true });
	assert.equal(readItem({ threadId: "t", turnId: "u", item: { type: "commandExecution", status: "completed" } }, 5).ok, false);
	assert.equal(readItem({ threadId: "t", turnId: "u", item: { type: "agentMessage", id: "m" } }, 5).ok, false);
	assert.deepEqual(readApproval("command", { threadId: "t", turnId: "u", itemId: "i", command: "ls -la" }, 2), { kind: "command", threadId: "t", turnId: "u", itemId: "i", command: { text: "ls", cut: true } });
	assert.deepEqual(readApproval("file", null, 2), { kind: "file" });
	assert.deepEqual(boundText("a→b", 2), { text: "a", cut: true }, "a cut never leaves half a character");
});

test("initialize is strict about the home and platform it reports", () => {
	const good = { codexHome: "/home/u/.codex", platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.160.0", later: 1 };
	assert.deepEqual(readInitialize(good), { ok: true, value: { codexHome: "/home/u/.codex", platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.160.0" } });
	for (const bad of [{ ...good, codexHome: ".codex" }, { ...good, codexHome: undefined }, { ...good, platformOs: "" }, { ...good, userAgent: 1 }, null]) assert.equal(readInitialize(bad).ok, false);
});

test("stderr is a bounded tail: a cut line is counted and dropped, an old line evicted, nothing parsed", () => {
	const tail = new CodexStderrTail({ maxStderrLineBytes: 16, maxStderrTailBytes: 24 });
	tail.push(Buffer.from(`first line\n${"x".repeat(40)}\nsecond line\nthird line\nunterminated`));
	tail.end();
	const record = tail.record;
	assert.equal(record.lines, 5);
	assert.equal(record.truncatedLines, 1);
	assert.ok(Buffer.byteLength(record.tail) <= 24);
	assert.ok(record.tail.endsWith("third line\nunterminated\n"));
	assert.ok(record.dropped >= 40);
});

/* ------------------------------------------------------------------------------------------------------------------
 * The lifecycle, against the literal fake. Everything below starts a process: that fake, and nothing else.
 * ---------------------------------------------------------------------------------------------------------------- */

const TEST_BOUNDS: Partial<CodexBounds> = { initializeMs: 10_000, requestMs: 10_000, shutdownStepMs: 1_500 };
const TEST_CLEANUP: OwnedCleanup = { exitGraceMs: 800, stopGraceMs: 1_000, leftoverGraceMs: 200, pipeGraceMs: 500, tableTimeoutMs: 3_000 };
const TEST_KILL_GRACE_MS = 1_000;
/** Far above everything one case's teardown is configured to take, so only a wait on something that never comes reaches it. */
const CASE_DEADLINE_MS = 20_000;

/** Roots a case kept because nothing proved its child was over. Checked empty when the file ends. */
const RETAINED: string[] = [];

after(() => {
	assert.deepEqual(RETAINED, [], "every case proved its fake was over before its root was removed");
});

async function within<T>(what: string, work: Promise<T>, ms = CASE_DEADLINE_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} had not come back inside the case deadline of ${ms}ms`)), ms);
	});
	work.catch(() => {});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function refusal(work: Promise<unknown>): Promise<CodexTransportError> {
	try {
		await within("a call that should be refused", work);
	} catch (error) {
		if (error instanceof CodexTransportError) return error;
		throw error;
	}
	return assert.fail("this call should have been refused");
}

/** Whether a promise has settled by now, without waiting for it. */
const settledYet = async (promise: Promise<unknown>): Promise<boolean> => {
	const marker = Symbol("pending");
	const value = await Promise.race([promise.then(() => true, () => true), new Promise((resolve) => setImmediate(() => resolve(marker)))]);
	return value === true;
};

interface Fixture {
	root: string;
	work: string;
	/** Every line the fake read, parsed, in order, once the fake has gone. */
	log(): { in?: Record<string, any>; raw?: string; argv?: string[]; stdin?: string }[];
	start(over?: Partial<CodexChildOptions>): Promise<CodexChild>;
	exits: CodexExit[];
}

/**
 * One case and its own root: a work directory the fake runs in and a log it appends to. The launch is spelled out here
 * — this host's node, the fence, the fake's path and the app-server's own arguments — and nothing is located. Every
 * child is shut down, and the root is removed only when every report says its process is over and its pipes closed.
 */
async function withFake(scenario: string, body: (fixture: Fixture) => Promise<void>, extraEnv: Record<string, string> = {}): Promise<void> {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-codex-transport-"));
	fs.chmodSync(root, 0o700);
	const work = path.join(root, "work");
	fs.mkdirSync(work);
	const logFile = path.join(root, "requests.log");
	const children: CodexChild[] = [];
	const exits: CodexExit[] = [];
	let attempts = 0;
	const fixture: Fixture = {
		root,
		work,
		exits,
		log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
		start: async (over = {}) => {
			attempts += 1;
			const { bounds, ...rest } = over;
			const options: CodexChildOptions = {
				killGraceMs: TEST_KILL_GRACE_MS,
				cleanup: TEST_CLEANUP,
				...rest,
				bounds: { ...TEST_BOUNDS, ...bounds },
				launch: {
					command: process.execPath,
					args: ["--import", pathToFileURL(FENCE).href, FAKE_CODEX, ...CODEX_APP_SERVER_ARGS],
					cwd: work,
					env: { FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_LOG: logFile, CODEX_HOME: path.join(root, "codex-home"), ...extraEnv },
				},
			};
			try {
				const child = await within("a start", startCodexChild(options));
				children.push(child);
				return child;
			} catch (error) {
				if (error instanceof CodexTransportError && error.finalExit) exits.push(error.finalExit);
				throw error;
			}
		},
	};
	let failure: unknown;
	try {
		await body(fixture);
	} catch (error) {
		failure = error;
	}
	for (const child of children) {
		try {
			exits.push(await within("a shutdown", child.shutdown()));
		} catch (error) {
			failure ??= error;
		}
	}
	const over = exits.length === attempts && exits.every((exit) => ["unspawned", "exited", "stopped"].includes(exit.cleanup.root) && exit.cleanup.stdio === "closed" && exit.counters.streamsUnclosed === 0 && !exit.cleanup.leftovers.length && !exit.cleanup.skipped.length);
	if (over) fs.rmSync(root, { recursive: true, force: true });
	else {
		RETAINED.push(root);
		failure ??= new Error(`the root ${root} was kept: not every child of this case was proved over`);
	}
	if (failure !== undefined) throw failure;
}

const requests = (fixture: Fixture) => fixture.log().filter((entry) => entry.in !== undefined).map((entry) => entry.in!);

test("a valid stream: handshake, a host-default thread, an explicit-effort turn with early, foreign and late events, readback and an orderly stop", async () => {
	await withFake("ok", async (fixture) => {
		const shown: string[] = [];
		const child = await fixture.start({ onNotification: ({ method, params }) => shown.push(`${method} ${(params as { threadId?: string }).threadId ?? ""}`) });
		assert.ok(child.pid > 0);
		assert.deepEqual(child.initialize, { codexHome: path.join(fixture.root, "codex-home"), platformFamily: "unix", platformOs: "linux", userAgent: "fake-codex/0.160.0" });
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		assert.deepEqual(thread, { threadId: "thr-1", model: "gpt-host-default", modelProvider: "openai", cwd: fixture.work, sandbox: { type: "workspaceWrite" }, reasoningEffort: null, approvalPolicy: "never" });
		assert.equal(sandboxModeOf(thread.sandbox), "workspace-write");

		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "do the task", effort: "high" }));
		assert.deepEqual([turn.threadId, turn.turnId], ["thr-1", "turn-1"]);
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "completed");
		assert.equal(result.failure, undefined);
		assert.equal(result.started, true, "the turn/started that arrived ahead of the answer was held for it");
		assert.deepEqual(result.completion, { status: "completed", error: null });
		assert.deepEqual(result.finalMessage, { text: "fake answer", cut: false });
		assert.deepEqual(result.items, { started: 1, completed: 1 }, "the malformed tool item counted toward nothing of the turn's");
		assert.equal(result.usage?.total.inputTokens, 1_000);

		// Late usage: it lands after the completion, and a readback after it has seen it.
		const read = await within("thread/read", child.readThread(thread.threadId));
		assert.deepEqual(read, { threadId: "thr-1", model: "gpt-host-default", modelProvider: "openai", reasoningEffort: "high", cwd: fixture.work, status: { type: "idle" } });
		const evidence = turn.snapshot();
		assert.equal(evidence.usageUpdates, 2);
		assert.equal(evidence.usageAfterCompletion, 1);
		assert.deepEqual(evidence.usage, {
			total: { inputTokens: 1_200, cachedInputTokens: 400, outputTokens: 130, reasoningOutputTokens: 25, totalTokens: 1_330, cacheWriteInputTokens: 0 },
			last: { inputTokens: 200, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 5, totalTokens: 230, cacheWriteInputTokens: 0 },
			modelContextWindow: 200_000,
		});
		assert.deepEqual(child.threadStatus("thr-1"), { type: "idle" });

		// Display data, unfiltered: the subagent's completion reaches the listener though it is none of this turn's evidence.
		assert.ok(shown.includes("turn/completed thr-sub"));
		assert.ok(shown.includes("turn/completed thr-1"));
		const counters = child.counters;
		assert.equal(counters.unknownNotifications, 1);
		assert.equal(counters.malformedItems, 1);
		assert.equal(counters.otherThreadNotifications, 2, "the subagent's start and completion are not this turn's");
		assert.equal(counters.foreignTurnNotifications, 1);
		assert.ok(counters.earlyNotifications >= 1);
		assert.equal(counters.lateResponses, 0);

		const exit = await within("the shutdown", child.shutdown());
		assert.equal(await child.shutdown(), exit, "one shutdown, one answer");
		assert.equal(await child.exited, exit);
		assert.equal(exit.failure, undefined);
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, true);
		assert.deepEqual(exit.exit, { code: 0, signal: null }, "the fake ended on the end of its stdin");
		assert.equal(exit.cleanup.root, "exited");
		assert.equal((await refusal(child.readThread("thr-1"))).kind, "closed");

		const sent = requests(fixture);
		assert.deepEqual(
			sent.map((message) => message.method ?? "reply"),
			["initialize", "initialized", "thread/start", "turn/start", "thread/read"],
		);
		for (const message of sent) assert.equal("jsonrpc" in message, false, "no jsonrpc member is sent");
		assert.deepEqual(sent[0], { id: 1, method: "initialize", params: { clientInfo: { name: "pi-fusion", title: "Pi-Fusion", version: "0" } } });
		assert.deepEqual(sent[1], { method: "initialized" }, "the notification after the handshake carries no id");
		assert.deepEqual(sent[2], { id: 2, method: "thread/start", params: { sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT } }, "the contract, and no cwd, effort, model, sandbox policy or configuration at the host default");
		assert.deepEqual(sent[3], { id: 3, method: "turn/start", params: { threadId: "thr-1", input: [{ type: "text", text: "do the task" }], effort: "high" } }, "no provider, sandbox policy or configuration");
		assert.deepEqual(sent[4], { id: 4, method: "thread/read", params: { threadId: "thr-1", includeTurns: false } });
		assert.deepEqual(fixture.log()[0].argv, [...CODEX_APP_SERVER_ARGS]);
	});
});

test("an explicit model and a host-configured effort: the selection goes where each request takes it, and the readback carries it", async () => {
	await withFake("host-effort", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ model: "gpt-explicit", modelProvider: "openai", sandbox: "read-only", approvalPolicy: "never", developerInstructions: CONTRACT }));
		assert.equal(thread.model, "gpt-explicit");
		assert.equal(thread.reasoningEffort, "medium", "thread/start takes no effort; this one is the host configuration's");
		assert.equal(sandboxModeOf(thread.sandbox), "read-only");
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "answer", model: "gpt-explicit" }));
		assert.equal((await within("the turn", turn.done)).outcome, "completed");
		const read = await within("thread/read", child.readThread(thread.threadId));
		assert.deepEqual([read.model, read.reasoningEffort], ["gpt-explicit", "medium"]);
		const sent = requests(fixture);
		assert.deepEqual(sent[2].params, { sandbox: "read-only", approvalPolicy: "never", developerInstructions: CONTRACT, model: "gpt-explicit", modelProvider: "openai" });
		assert.deepEqual(sent[3].params, { threadId: "thr-1", input: [{ type: "text", text: "answer" }], model: "gpt-explicit" });
	});
});

test("a null readback and a null context window are reported as null, not as defaults", async () => {
	await withFake("null-readback", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "read-only", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		await within("the turn", turn.done);
		const read = await within("thread/read", child.readThread(thread.threadId));
		assert.deepEqual([read.model, read.reasoningEffort], [null, null]);
		assert.equal(turn.snapshot().usage?.modelContextWindow, null);
	});
});

test("wrong identity data is handed back exactly as reported, for the caller to compare and refuse", async () => {
	await withFake("wrong-start", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ model: "gpt-asked", sandbox: "read-only", approvalPolicy: "never", developerInstructions: CONTRACT }));
		assert.deepEqual(thread, { threadId: "thr-1", model: "gpt-other", modelProvider: "azure", cwd: "/", sandbox: { type: "dangerFullAccess" }, reasoningEffort: null, approvalPolicy: "on-request" });
		assert.equal(sandboxModeOf(thread.sandbox), undefined);
	});
});

test("missing identity, model, provider, cwd, sandbox or a malformed effort fails closed as a protocol failure that ends the child", async () => {
	for (const bad of ["thread-id", "model", "provider", "cwd", "sandbox", "effort"]) {
		await withFake(
			"bad-start",
			async (fixture) => {
				const child = await fixture.start();
				const refused = await refusal(child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
				assert.equal(refused.kind, "protocol", bad);
				const exit = await within("the exit", child.exited);
				assert.equal(exit.failure?.kind, "protocol", bad);
				assert.equal(exit.stopRequested, true);
				assert.equal(exit.cleanExit, true);
			},
			{ FAKE_CODEX_BAD: bad },
		);
	}
});

test("notifications that complete a turn ahead of its turn/start answer are held for it and end it at once", async () => {
	await withFake("early-complete", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		assert.equal(await settledYet(turn.done), true);
		const result = await turn.done;
		assert.equal(result.outcome, "completed");
		assert.deepEqual(result.finalMessage, { text: "early answer", cut: false });
		assert.equal(result.usage?.last.cachedInputTokens, 40);
		assert.ok(child.counters.earlyNotifications >= 4);
	});
});

test("a reroute is per-turn telemetry on the turn's report, and the thread's configured selection is untouched", async () => {
	await withFake("reroute", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "completed");
		assert.deepEqual(result.reroutes, [{ fromModel: "gpt-host-default", toModel: "gpt-safer", reason: "highRiskCyberActivity" }]);
		assert.equal(result.rerouteCount, 1);
		assert.equal((await within("thread/read", child.readThread(thread.threadId))).model, "gpt-host-default");
	});
});

test("a retryable error is not an end; a terminal error and a failed completion are, with Codex's own codes kept", async () => {
	await withFake("errors", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "failed");
		assert.equal(result.retryableErrors, 1);
		assert.deepEqual(result.lastRetryableError, { message: "stream disconnected, retrying", cut: false, info: "httpConnectionFailed", httpStatusCode: 502 });
		assert.equal(result.terminalErrors, 1);
		assert.deepEqual(result.completion, { status: "failed", error: { message: "usage limit reached", cut: false, info: "usageLimitExceeded" } });
		assert.equal(result.failure, undefined, "the child's own failed turn is its report, not a transport failure");
	});
});

test("approval requests are declined on the wire, once per id, and surfaced as denials on the turn or the exit", async () => {
	await withFake("approvals", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "completed");
		assert.equal(result.denialCount, 2);
		assert.deepEqual(result.denials, [
			{ kind: "command", threadId: "thr-1", turnId: "turn-1", itemId: "cmd-1", command: { text: "rm -rf /tmp/fake-target", cut: false } },
			{ kind: "file", threadId: "thr-1", turnId: "turn-1", itemId: "patch-1" },
		]);
		assert.deepEqual(child.counters.declinedApprovals, 3);
		assert.deepEqual(child.counters.duplicateServerRequests, 1);
		const exit = await within("the shutdown", child.shutdown());
		assert.deepEqual(exit.lastUnmatchedDenial, { kind: "command" });
		assert.equal(exit.failure, undefined);
		const replies = requests(fixture).filter((message) => message.method === undefined);
		assert.deepEqual(replies, [
			{ id: "srv-1", result: { decision: "decline" } },
			{ id: 7, result: { decision: "decline" } },
			{ id: 8, result: { decision: "decline" } },
		]);
	});
});

for (const [scenario, method] of [
	["user-input", "item/tool/requestUserInput"],
	["unknown-request", "fake/surprise"],
] as const) {
	test(`a ${method} request is answered with a JSON-RPC error and fails the run: the turn is interrupted and the child stopped`, async () => {
		await withFake(scenario, async (fixture) => {
			const child = await fixture.start();
			const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
			const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
			const result = await within("the turn", turn.done);
			assert.equal(result.outcome, "transport");
			assert.equal(result.failure?.kind, "unsupported");
			assert.ok(result.failure?.message.includes(method));
			assert.deepEqual(result.completion, { status: "interrupted", error: null }, "the interrupt was sent and the child's own end of the turn recorded");
			const exit = await within("the exit", child.exited);
			assert.equal(exit.failure?.kind, "unsupported");
			assert.equal(exit.cleanup.root, "exited");
			const sent = requests(fixture);
			const reply = sent.find((message) => message.method === undefined);
			assert.deepEqual(reply?.error?.code, CODEX_UNSUPPORTED_CODE);
			assert.ok(sent.some((message) => message.method === "turn/interrupt" && message.params.turnId === "turn-1"));
			assert.equal(child.counters.unsupportedRequests, 1);
		});
	});
}

for (const [scenario, reason, bounds] of [
	["bad-completed", /turn completion reports no end/, {}],
	["bad-usage", /usage update carries a breakdown/, {}],
	["malformed-frame", /not json/, {}],
	["oversized-frame", /longer than this transport reads/, { maxFrameBytes: 16 * 1024 }],
] as const) {
	test(`malformed lifecycle evidence fails closed: ${scenario}`, async () => {
		await withFake(scenario, async (fixture) => {
			const child = await fixture.start({ bounds });
			const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
			const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
			const result = await within("the turn", turn.done);
			assert.equal(result.outcome, "transport");
			assert.equal(result.failure?.kind, "protocol");
			assert.match(result.failure?.message ?? "", reason);
			const exit = await within("the exit", child.exited);
			assert.equal(exit.failure?.kind, "protocol");
			assert.ok(requests(fixture).some((message) => message.method === "turn/interrupt"), "the admitted turn was interrupted before the child was stopped");
		});
	});
}

test("a duplicate response is late and dropped; the transport goes on", async () => {
	await withFake("duplicate-response", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		await within("thread/read", child.readThread(thread.threadId));
		assert.equal(child.counters.lateResponses, 1);
	});
});

test("a response with an id this transport never issued is a protocol failure", async () => {
	await withFake("wrong-id", async (fixture) => {
		const child = await fixture.start();
		const refused = await refusal(child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		assert.equal(refused.kind, "protocol");
		assert.match(refused.message, /never issued/);
	});
});

test("a request that times out is the caller's alone: its late answer is counted, and the next request is answered", async () => {
	await withFake("late-response", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		assert.equal((await refusal(child.readThread(thread.threadId, 300))).kind, "timeout");
		const read = await within("thread/read", child.readThread(thread.threadId));
		assert.equal(read.threadId, "thr-1");
		assert.equal(child.counters.lateResponses, 1);
	});
});

test("an interrupt's acknowledgement is not the turn's end: the turn ends with its own completion", async () => {
	await withFake("interrupt", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		await within("turn/interrupt", child.interrupt(turn));
		assert.equal(turn.snapshot().completion, undefined);
		assert.equal(await settledYet(turn.done), false);
		await within("thread/read", child.readThread(thread.threadId));
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "interrupted");
		assert.equal((await refusal(child.interrupt(turn))).kind, "refused", "an ended turn is not interrupted again");
	});
});

test("a host shutdown during a turn interrupts it, waits one bounded step for its end, ends stdin and reports a clean stop", async () => {
	await withFake("forever", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		assert.equal((await refusal(child.startTurn({ threadId: thread.threadId, text: "y" }))).kind, "busy");
		assert.equal((await refusal(child.readThread("thr-elsewhere"))).kind, "refused");
		const exit = await within("the shutdown", child.shutdown());
		const result = await turn.done;
		assert.equal(result.outcome, "aborted");
		assert.deepEqual(result.completion, { status: "interrupted", error: null });
		assert.equal(exit.failure, undefined);
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, true);
		assert.equal(exit.cleanup.root, "exited");
		assert.deepEqual(exit.exit, { code: 0, signal: null });
	});
});

test("cancellation during a turn is an abort: the turn is interrupted and the run reports it as cancelled", async () => {
	await withFake("forever", async (fixture) => {
		const controller = new AbortController();
		const child = await fixture.start({ signal: controller.signal });
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		controller.abort();
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "aborted");
		assert.equal(result.failure?.kind, "aborted");
		const exit = await within("the exit", child.exited);
		assert.equal(exit.failure?.kind, "aborted");
		assert.equal(exit.cleanup.root, "exited");
	});
});

test("a cancellation that came first spawns nothing", async () => {
	await withFake("ok", async (fixture) => {
		const controller = new AbortController();
		controller.abort();
		const refused = await refusal(fixture.start({ signal: controller.signal }));
		assert.equal(refused.kind, "aborted");
		assert.equal(refused.finalExit?.cleanup.root, "unspawned");
		assert.deepEqual(fixture.log(), [], "the fake never ran");
	});
});

test("a crash mid-turn rejects what is outstanding as exited and keeps a bounded stderr tail", async () => {
	await withFake("crash", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		const result = await within("the turn", turn.done);
		assert.equal(result.outcome, "exited");
		assert.equal(result.failure?.kind, "exited");
		const exit = await within("the exit", child.exited);
		assert.deepEqual(exit.exit, { code: 3, signal: null });
		assert.equal(exit.failure?.kind, "exited");
		assert.equal(exit.stopRequested, false);
		assert.equal(exit.cleanExit, false, "a nonzero status is no clean stop");
		assert.match(exit.stderr.tail, /fake codex crashed/);
		assert.equal((await refusal(child.readThread(thread.threadId))).kind, "exited");
	});
});

test("developer instructions are required, bounded and refused whole rather than cut", async () => {
	await withFake("ok", async (fixture) => {
		const child = await fixture.start({ bounds: { maxInstructionsBytes: 64 } });
		await assert.rejects(child.startThread({ sandbox: "read-only", approvalPolicy: "never", developerInstructions: "" }), /developerInstructions/);
		const long = await refusal(child.startThread({ sandbox: "read-only", approvalPolicy: "never", developerInstructions: "x".repeat(65) }));
		assert.equal(long.kind, "refused");
		const thread = await within("thread/start", child.startThread({ sandbox: "read-only", approvalPolicy: "never", developerInstructions: "x".repeat(64) }));
		assert.equal(thread.threadId, "thr-1");
		const sent = requests(fixture).filter((message) => message.method === "thread/start");
		assert.equal(sent.length, 1, "neither refusal reached the wire");
		assert.equal(sent[0].params.developerInstructions, "x".repeat(64));
	});
});

test("a turn/start that is never answered in time ends the child: one request, the timeout kept, later starts refused, a late answer only counted", async () => {
	await withFake("late-turn-ack", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const timedOut = await refusal(child.startTurn({ threadId: thread.threadId, text: "x" }, 300));
		assert.equal(timedOut.kind, "timeout");
		assert.match(timedOut.message, /did not answer turn\/start/);
		const second = await refusal(child.startTurn({ threadId: thread.threadId, text: "y" }));
		assert.equal(second.kind, "closed", "no second start on a child that may be running an unnamed turn");
		assert.equal((await refusal(child.readThread(thread.threadId))).kind, "closed");
		const exit = await within("the exit", child.exited);
		assert.equal(exit.failure?.kind, "timeout");
		assert.match(exit.failure?.message ?? "", /did not answer turn\/start/);
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, true);
		assert.equal(exit.cleanup.root, "exited");
		assert.equal(exit.counters.lateResponses, 1, "the answer it sent on the way out settled nothing");
		const sent = requests(fixture);
		assert.equal(sent.filter((message) => message.method === "turn/start").length, 1);
		assert.equal(sent.filter((message) => message.method === "turn/interrupt").length, 0, "nothing is interrupted on a guessed id");
	});
});

test("a JSON-RPC error answering turn/start is the child's definite refusal: rejected with its code, and the next start is admitted", async () => {
	await withFake("turn-start-error", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const refused = await refusal(child.startTurn({ threadId: thread.threadId, text: "x" }));
		assert.equal(refused.kind, "rejected");
		assert.equal(refused.code, -32000);
		assert.match(refused.message, /turn refused/);
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "y" }));
		assert.equal((await within("the turn", turn.done)).outcome, "completed");
		assert.equal(requests(fixture).filter((message) => message.method === "turn/start").length, 2);
	});
});

test("an unexpected signal death while being stopped is a failure, not a clean stop the host asked for", async () => {
	// SIGUSR2 rather than a crash signal, so no core or crash report is made: the check is the same for any signal this
	// tree did not send, SIGSEGV included. This is not a measurement of a real crash.
	await withFake("signal-on-interrupt", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		const exit = await within("the shutdown", child.shutdown());
		assert.deepEqual(exit.exit, { code: null, signal: "SIGUSR2" });
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, false);
		assert.equal(exit.failure?.kind, "exited");
		const result = await turn.done;
		assert.equal(result.outcome, "exited");
		assert.equal(result.failure?.kind, "exited");
	});
});

test("a nonzero exit while being stopped is a failure too, even after the turn ended as asked", async () => {
	await withFake("exit-nonzero", async (fixture) => {
		const child = await fixture.start();
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const turn = await within("turn/start", child.startTurn({ threadId: thread.threadId, text: "x" }));
		const exit = await within("the shutdown", child.shutdown());
		assert.deepEqual(exit.exit, { code: 2, signal: null });
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, false);
		assert.equal(exit.failure?.kind, "exited");
		assert.equal(exit.cleanup.root, "exited");
		const result = await turn.done;
		assert.equal(result.outcome, "aborted", "the turn had ended on its interrupt before the child exited");
		assert.deepEqual(result.completion, { status: "interrupted", error: null });
	});
});

test("a child that never answers initialize is a handshake failure inside its bound, and the owned cleanup stops it", async () => {
	await withFake("hang", async (fixture) => {
		const refused = await refusal(fixture.start({ bounds: { initializeMs: 400 } }));
		assert.equal(refused.kind, "handshake");
		assert.match(refused.message, /did not answer initialize/);
		const exit = refused.finalExit!;
		assert.equal(exit.cleanup.root, "stopped", "it ignored the end of its stdin, so the cleanup signalled it");
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, true, "it died of the tree's own signal, which is an owned stop");
	});
});

test("a refused or malformed handshake fails the start with the child's code or the reader's reason", async () => {
	await withFake("handshake-error", async (fixture) => {
		const refused = await refusal(fixture.start());
		assert.equal(refused.kind, "handshake");
		assert.equal(refused.code, -32000);
		assert.equal(refused.finalExit?.cleanup.root, "exited");
	});
	await withFake("bad-initialize", async (fixture) => {
		const refused = await refusal(fixture.start());
		assert.equal(refused.kind, "handshake");
		assert.match(refused.message, /no absolute codex home/);
	});
});

test("stderr is read throughout and kept to its bounds: a flood is a tail, a long line is counted and dropped", async () => {
	await withFake("stderr-flood", async (fixture) => {
		const child = await fixture.start({ bounds: { maxStderrLineBytes: 4_096, maxStderrTailBytes: 2_048 } });
		const exit = await within("the shutdown", child.shutdown());
		assert.equal(exit.stderr.lines, 66);
		assert.equal(exit.stderr.truncatedLines, 1);
		assert.ok(Buffer.byteLength(exit.stderr.tail) <= 2_048);
		assert.ok(exit.stderr.tail.endsWith("fake codex last line\n"));
		assert.ok(exit.stderr.dropped >= 20_000);
	});
});

test("a child that stops reading: frames past the pipe wait in the bounded writer, slots and frame size are refused, and the cleanup stops it", async () => {
	await withFake("no-read", async (fixture) => {
		const child = await fixture.start({ bounds: { maxPendingRequests: 3, maxOutboundFrameBytes: 1024 * 1024 } });
		const thread = await within("thread/start", child.startThread({ sandbox: "workspace-write", approvalPolicy: "never", developerInstructions: CONTRACT }));
		const oversized = await refusal(child.startTurn({ threadId: thread.threadId, text: "x".repeat(1024 * 1024) }));
		assert.equal(oversized.kind, "refused");
		assert.match(oversized.message, /one frame/);
		// Far more than a pipe holds, so the write is only partly taken and the writer has to wait for a drain.
		const starting = child.startTurn({ threadId: thread.threadId, text: "y".repeat(800 * 1024) }, 15_000);
		starting.catch(() => {});
		const first = child.readThread(thread.threadId, 300);
		const second = child.readThread(thread.threadId, 300);
		const third = await refusal(child.readThread(thread.threadId, 300));
		assert.equal(third.kind, "refused");
		assert.match(third.message, /no request slot/);
		assert.equal((await refusal(first)).kind, "timeout");
		assert.equal((await refusal(second)).kind, "timeout");
		assert.equal(child.counters.droppedFrames, 2, "both reads were still queued behind the blocked write, and went unwritten");
		const exit = await within("the shutdown", child.shutdown());
		assert.equal((await refusal(starting)).kind, "closed");
		assert.equal(exit.failure, undefined);
		assert.equal(exit.cleanup.root, "stopped");
		assert.equal(exit.stopRequested, true);
		assert.equal(exit.cleanExit, true);
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * Boundaries
 * ---------------------------------------------------------------------------------------------------------------- */

const importsOf = (file: string): string[] => ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles.map((reference) => reference.fileName);

test("the fake imports node builtins and nothing else, and reads no Codex install", () => {
	const names = importsOf(FAKE_CODEX);
	assert.ok(names.length > 0);
	for (const name of names) assert.match(name, /^node:/, `the fake names ${name}`);
	const source = fs.readFileSync(FAKE_CODEX, "utf8");
	for (const forbidden of ["PI_FUSION_CODEX_BIN", "auth.json", "@openai/codex", "child_process"]) assert.ok(!source.includes(forbidden), forbidden);
});

test("this suite launches only the fake by its own path, never a located Codex: it takes the app-server's arguments and nothing else from the launch module", () => {
	const file = fileURLToPath(import.meta.url);
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
	const taken = source.statements
		.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.endsWith("/codex-launch.ts"))
		.flatMap((statement) => {
			const bindings = statement.importClause?.namedBindings;
			return bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => element.name.text) : ["<not named>"];
		});
	assert.deepEqual(taken, ["CODEX_APP_SERVER_ARGS"]);
});
