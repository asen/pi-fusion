import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A Codex app-server as the transport sees one, and no more of one than that: JSON-RPC lines on stdin and stdout in
 * the shape Codex 0.160.0's app-server source declares, literals for everything they carry, and a line of stderr now
 * and then. It is not Codex. Nothing here imports a package, reads a Codex home or auth file, reaches a model or a
 * provider, or looks anything up on `PATH`; it imports node builtins and nothing else, and a test launches it by its
 * own path under this host's node.
 *
 * `FAKE_CODEX_SCENARIO` chooses what it does and `FAKE_CODEX_LOG` names a file every line it read is appended to, as
 * the json it parsed to or the raw text it was. Both are this fixture's own and no production module reads either.
 *
 * It stays alive through its stdin reader, so a host's own shutdown — which ends stdin first — is what ends it, and the
 * owned cleanup's report is about a process that was really there. Two scenarios differ on purpose: `hang` ignores the
 * end of stdin and `no-read` stops reading it, and both stay up on a bounded keepalive until the cleanup signals them.
 * That timer is a liveness bound so a broken case fails rather than hangs; nothing is synchronized on it.
 */

const SCENARIO = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const BAD = process.env.FAKE_CODEX_BAD ?? "";
const LOG = process.env.FAKE_CODEX_LOG;
const KEEPALIVE_MS = 30_000;

const log = (what) => {
	if (!LOG) return;
	try {
		fs.appendFileSync(LOG, `${JSON.stringify(what)}\n`, { mode: 0o600 });
	} catch {}
};

/** Synchronous, so a scenario that writes and then exits loses nothing; a full non-blocking pipe is retried. */
function writeAll(fd, text) {
	const bytes = Buffer.from(text, "utf8");
	let at = 0;
	while (at < bytes.length) {
		try {
			at += fs.writeSync(fd, bytes, at, bytes.length - at);
		} catch (error) {
			if (error && error.code === "EAGAIN") continue;
			throw error;
		}
	}
}

const send = (record) => writeAll(1, `${JSON.stringify(record)}\n`);
const raw = (text) => writeAll(1, text);
const respond = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const notify = (method, params) => send({ method, params });

log({ argv: process.argv.slice(2), scenario: SCENARIO });

const cwd = fs.realpathSync(process.cwd());
const home = process.env.CODEX_HOME ? path.resolve(cwd, process.env.CODEX_HOME) : path.join(cwd, ".codex");
const threads = new Map();
let threadCount = 0;
let turnCount = 0;
/** What `interrupt` withholds until the next request: the completion its acknowledgement is not. */
let deferredCompletion;
/** What `late-response` withholds until the next request: the answer to the first thread/read. */
let withheld;
/** What `late-turn-ack` withholds until stdin ends: the turn/start answer, sent only after the host gave up on it. */
let lateTurnAnswer;
/** How many turn/start requests `turn-start-error` has refused: the first, and no other. */
let refusedStarts = 0;
/** The server requests `approvals` and the others are waiting on, by id. */
const awaiting = new Map();
let afterReplies;

const usage = (input, cached, output, reasoning) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output });

const tokenUsage = (threadId, turnId, total, last, window = 200_000) => notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last, modelContextWindow: window } });

const completed = (threadId, turnId, status = "completed", error = null) => {
	notify("turn/completed", { threadId, turn: { id: turnId, status, items: [], error, durationMs: 12 } });
	notify("thread/status/changed", { threadId, status: { type: "idle" } });
	const thread = threads.get(threadId);
	if (thread) thread.status = { type: "idle" };
};

function initialize(id) {
	if (SCENARIO === "hang") return;
	if (SCENARIO === "handshake-error") return fail(id, -32000, "the fake refuses this handshake");
	if (SCENARIO === "stderr-flood") {
		for (let line = 0; line < 64; line += 1) writeAll(2, `fake codex log line ${line} ${"x".repeat(200)}\n`);
		writeAll(2, `${"y".repeat(20_000)}\n`);
		writeAll(2, "fake codex last line\n");
	}
	if (SCENARIO === "bad-initialize") return respond(id, { platformFamily: "unix", platformOs: "linux", userAgent: "fake-codex/0.160.0" });
	respond(id, { codexHome: home, platformFamily: "unix", platformOs: "linux", userAgent: "fake-codex/0.160.0", laterStableField: true });
}

function startThread(id, params) {
	threadCount += 1;
	const threadId = `thr-${threadCount}`;
	const model = params?.model ?? "gpt-host-default";
	const modelProvider = params?.modelProvider ?? "openai";
	const startEffort = SCENARIO === "host-effort" ? "medium" : null;
	threads.set(threadId, { model, modelProvider, startEffort, turnEffort: undefined, status: { type: "idle" } });
	const sandbox = params?.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false };
	const thread = { id: threadId, sessionId: threadId, cwd, modelProvider, status: { type: "idle" }, turns: [], preview: "", ephemeral: false, cliVersion: "0.160.0", createdAt: 1, updatedAt: 1, source: "appServer", projectId: "p" };
	let result = { thread, model, modelProvider, cwd, sandbox, reasoningEffort: startEffort, approvalPolicy: params?.approvalPolicy ?? "on-request", approvalsReviewer: "user", instructionSources: [], laterStableField: 1 };
	if (SCENARIO === "wrong-start") result = { ...result, model: "gpt-other", modelProvider: "azure", cwd: "/", sandbox: { type: "dangerFullAccess" }, approvalPolicy: "on-request" };
	if (SCENARIO === "bad-start") {
		if (BAD === "thread-id") result = { ...result, thread: { ...thread, id: undefined } };
		if (BAD === "model") result = { ...result, model: undefined };
		if (BAD === "provider") result = { ...result, modelProvider: "" };
		if (BAD === "cwd") result = { ...result, cwd: "work" };
		if (BAD === "sandbox") result = { ...result, sandbox: "workspace-write" };
		if (BAD === "effort") result = { ...result, reasoningEffort: 3 };
	}
	notify("thread/started", { thread });
	if (SCENARIO === "wrong-id") return respond(999, result);
	respond(id, result);
	if (SCENARIO === "duplicate-response") respond(id, result);
	// From here on the fake reads nothing: what the host writes stays in the pipe and the host's writer has to wait.
	if (SCENARIO === "no-read") {
		process.stdin.pause();
		setTimeout(() => {}, KEEPALIVE_MS);
	}
}

function startTurn(id, params) {
	const threadId = params?.threadId;
	const thread = threads.get(threadId);
	if (!thread) return fail(id, -32600, "no such thread");
	if (SCENARIO === "turn-start-error" && refusedStarts === 0) {
		refusedStarts += 1;
		return fail(id, -32000, "turn refused");
	}
	turnCount += 1;
	const turnId = `turn-${turnCount}`;
	if (params.effort !== undefined) thread.turnEffort = params.effort;
	thread.status = { type: "active", activeFlags: [] };
	const answer = () => respond(id, { turn: { id: turnId, status: "inProgress", items: [], error: null } });
	notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
	// Early: the turn's own start goes out ahead of the answer that names it.
	notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
	switch (SCENARIO) {
		case "early-complete":
			notify("item/completed", { threadId, turnId, completedAtMs: 1, item: { type: "agentMessage", id: "msg-1", text: "early answer" } });
			tokenUsage(threadId, turnId, usage(100, 40, 10, 2), usage(100, 40, 10, 2));
			completed(threadId, turnId);
			answer();
			return;
		case "forever":
		case "interrupt":
		case "signal-on-interrupt":
		case "exit-nonzero":
			answer();
			return;
		case "late-turn-ack":
			lateTurnAnswer = answer;
			return;
		case "crash":
			answer();
			writeAll(2, "fake codex crashed\n");
			process.exit(3);
			return;
		case "reroute":
			answer();
			notify("model/rerouted", { threadId, turnId, fromModel: "gpt-host-default", toModel: "gpt-safer", reason: "highRiskCyberActivity" });
			tokenUsage(threadId, turnId, usage(50, 0, 5, 0), usage(50, 0, 5, 0));
			completed(threadId, turnId);
			return;
		case "errors":
			answer();
			notify("error", { threadId, turnId, willRetry: true, error: { message: "stream disconnected, retrying", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } } });
			notify("error", { threadId, turnId, willRetry: false, error: { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded" } });
			completed(threadId, turnId, "failed", { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded", additionalDetails: null });
			return;
		case "approvals":
			answer();
			awaiting.set("string:srv-1", true);
			awaiting.set("number:7", true);
			awaiting.set("number:8", true);
			send({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "cmd-1", command: "rm -rf /tmp/fake-target", startedAtMs: 1 } });
			// The same id again: one request, one answer.
			send({ id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: "cmd-1", command: "rm -rf /tmp/fake-target", startedAtMs: 1 } });
			send({ id: 7, method: "item/fileChange/requestApproval", params: { threadId, turnId, itemId: "patch-1", startedAtMs: 1 } });
			send({ id: 8, method: "item/commandExecution/requestApproval", params: { startedAtMs: 1 } });
			afterReplies = () => {
				notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "commandExecution", id: "cmd-1", status: "declined", command: "rm -rf /tmp/fake-target", commandActions: [], cwd } });
				completed(threadId, turnId);
			};
			return;
		case "user-input":
			answer();
			send({ id: 11, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: "ask-1", questions: [], isBlocking: true } });
			return;
		case "unknown-request":
			// One write for both, so the host reads the answer and the request in one chunk: the turn has to be admitted
			// by the time the request ends the run, or there is no turn to interrupt.
			raw(`${JSON.stringify({ id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } })}\n${JSON.stringify({ id: "x-1", method: "fake/surprise", params: {} })}\n`);
			return;
		case "bad-completed":
			answer();
			notify("turn/completed", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
			return;
		case "bad-usage":
			answer();
			tokenUsage(threadId, turnId, usage(10, 20, 1, 0), usage(10, 20, 1, 0));
			return;
		case "malformed-frame":
			answer();
			raw("this is not json\n");
			return;
		case "oversized-frame":
			answer();
			notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: "z".repeat(64 * 1024) });
			return;
		default:
			break;
	}
	answer();
	notify("item/started", { threadId, turnId, startedAtMs: 1, item: { type: "agentMessage", id: "msg-1", text: "" } });
	notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "fake answer", phase: null } });
	// An optional tool item with no id: a diagnostic for the host to count, never evidence.
	notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "commandExecution", status: "completed" } });
	// A subagent's thread: its own turn and its own completion, which must not end this one.
	notify("turn/started", { threadId: "thr-sub", turn: { id: "turn-sub", status: "inProgress", items: [] } });
	notify("turn/completed", { threadId: "thr-sub", turn: { id: "turn-sub", status: "completed", items: [] } });
	// Another turn of this very thread, which no turn/start of the host's named.
	notify("turn/started", { threadId, turn: { id: "turn-other", status: "inProgress", items: [] } });
	notify("fake/unknown", { anything: true });
	const window = SCENARIO === "null-readback" ? null : 200_000;
	tokenUsage(threadId, turnId, usage(1_000, 400, 100, 20), usage(600, 400, 60, 10), window);
	completed(threadId, turnId);
	// Late: usage for the same turn after its completion, cumulative for the thread.
	tokenUsage(threadId, turnId, usage(1_200, 400, 130, 25), usage(200, 0, 30, 5), window);
}

function readThread(id, params) {
	const thread = threads.get(params?.threadId);
	if (!thread) return fail(id, -32600, "no such thread");
	const nulls = SCENARIO === "null-readback";
	const result = {
		thread: {
			id: params.threadId,
			sessionId: params.threadId,
			cwd,
			model: nulls ? null : thread.model,
			modelProvider: thread.modelProvider,
			reasoningEffort: nulls ? null : (thread.turnEffort ?? thread.startEffort),
			status: thread.status,
			turns: [],
			preview: "",
			ephemeral: false,
			cliVersion: "0.160.0",
			createdAt: 1,
			updatedAt: 2,
			source: "appServer",
			projectId: "p",
		},
	};
	if (SCENARIO === "late-response" && withheld === undefined) {
		withheld = () => respond(id, result);
		return;
	}
	respond(id, result);
}

function interrupt(id, params) {
	// A death the host did not cause, by a signal that leaves no core or crash report behind.
	if (SCENARIO === "signal-on-interrupt") {
		process.kill(process.pid, "SIGUSR2");
		return;
	}
	respond(id, {});
	const finish = () => completed(params.threadId, params.turnId, "interrupted");
	// The acknowledgement first and the completion only on the next request, so the two are two observations.
	if (SCENARIO === "interrupt") deferredCompletion = finish;
	else finish();
}

function request(message) {
	// Whatever was withheld goes out before the next request is answered, in the order a real server's would.
	if (deferredCompletion) {
		const finish = deferredCompletion;
		deferredCompletion = undefined;
		finish();
	}
	if (withheld && message.method !== "thread/read") {
		const answer = withheld;
		withheld = undefined;
		answer();
	} else if (withheld && message.method === "thread/read") {
		const answer = withheld;
		withheld = () => {};
		answer();
	}
	switch (message.method) {
		case "initialize":
			return initialize(message.id);
		case "thread/start":
			return startThread(message.id, message.params);
		case "turn/start":
			return startTurn(message.id, message.params);
		case "thread/read":
			return readThread(message.id, message.params);
		case "turn/interrupt":
			return interrupt(message.id, message.params);
		default:
			return fail(message.id, -32601, "method not found");
	}
}

function reply(message) {
	const key = `${typeof message.id}:${message.id}`;
	if (!awaiting.delete(key)) return;
	if (awaiting.size === 0 && afterReplies) {
		const next = afterReplies;
		afterReplies = undefined;
		next();
	}
}

function line(text) {
	let message;
	try {
		message = JSON.parse(text);
	} catch {
		log({ raw: text.slice(0, 256) });
		return;
	}
	log({ in: message });
	if (typeof message.method === "string" && "id" in message) return request(message);
	if (typeof message.method === "string") return;
	if ("id" in message) return reply(message);
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	pending = Buffer.concat([pending, chunk]);
	for (;;) {
		const lf = pending.indexOf(0x0a);
		if (lf === -1) return;
		const text = pending.subarray(0, lf).toString("utf8");
		pending = pending.subarray(lf + 1);
		line(text);
	}
});
process.stdin.on("end", () => {
	log({ stdin: "end" });
	if (lateTurnAnswer) lateTurnAnswer();
	if (SCENARIO === "exit-nonzero") process.exit(2);
	if (SCENARIO === "hang") {
		setTimeout(() => {}, KEEPALIVE_MS);
		return;
	}
	process.exit(0);
});
