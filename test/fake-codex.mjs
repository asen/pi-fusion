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
 * the json it parsed to or the raw text it was. `FAKE_CODEX_START` and `FAKE_CODEX_READ` are json objects laid over a
 * thread/start answer and a thread/read answer's thread, so a backend case can make one field disagree, and
 * `FAKE_CODEX_EXIT_CODE` is the status an orderly end of stdin exits with. All are this fixture's own and no production
 * module reads any of them.
 *
 * thread/resume, thread/fork, thread/turns/list and turn/steer are answered only in the scenarios named in
 * `FOUNDATIONS`, and method-not-found in every other one, so a stage 1 scenario's wire is what it was. Those scenarios
 * treat any thread id they are asked to load as a persisted thread with a fixed history and a fixed cumulative usage
 * seed: the seed is this fixture's own constant, and no request field carries or asks for it. A case that continues a
 * thread an earlier fake process ran says what that process left with `FAKE_CODEX_HISTORY`, a json object of `turns`
 * (oldest first, each an id and a status) and a `seed` total, and gives this process's ids a `FAKE_CODEX_PREFIX` so
 * its new turns are not named like the earlier process's. `FAKE_CODEX_FORK_RENAME` names a fork's copied turns anew,
 * `FAKE_CODEX_REEMIT` sends a loaded thread's last usage update twice, and `steer-script` answers each turn/steer by the
 * next entry of the comma list `FAKE_CODEX_STEERS` — `accept`, `reject` or `silent` — and completes its turn after the
 * last one. All of these are this fixture's own; no production request carries any of them.
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
const json = (name) => {
	try {
		return JSON.parse(process.env[name] ?? "{}");
	} catch {
		return {};
	}
};
const START_OVER = json("FAKE_CODEX_START");
const READ_OVER = json("FAKE_CODEX_READ");
const EXIT_CODE = Number(process.env.FAKE_CODEX_EXIT_CODE ?? 0);
const HISTORY = json("FAKE_CODEX_HISTORY");
const PREFIX = process.env.FAKE_CODEX_PREFIX ?? "";
const FORK_RENAME = process.env.FAKE_CODEX_FORK_RENAME === "1";
const REEMIT = process.env.FAKE_CODEX_REEMIT === "1";
const STEERS = (process.env.FAKE_CODEX_STEERS ?? "").split(",").filter(Boolean);

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

/** The scenarios that answer the resume, fork, latest-turn and steer methods. */
const FOUNDATIONS = new Set(["resume-ok", "resume-reset", "resume-moved", "resume-mismatch", "fork-ok", "fork-same-id", "fork-tip-missing", "turns-interrupted", "steer-ok", "steer-rejected", "steer-script"]);
/** What a persisted thread's cumulative total already is when it is loaded: the fake's seed, never a request's. */
const SEED = HISTORY.seed ?? usage(5_000, 2_000, 200, 50);
let forkCount = 0;
let steerCount = 0;

/** A persisted thread's turns, oldest first. `resume-moved` has one past the tip a host recorded; `turns-interrupted` ends cold. */
const persisted = () => {
	const history = Array.isArray(HISTORY.turns)
		? HISTORY.turns.map((turn) => ({ ...turn }))
		: [
				{ id: "turn-seed-1", status: "completed" },
				{ id: "turn-seed-2", status: "completed" },
			];
	if (SCENARIO === "resume-moved") history.push({ id: "turn-moved", status: "completed" });
	if (SCENARIO === "turns-interrupted") history.push({ id: "turn-cold", status: "interrupted" });
	return history;
};

const plus = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + (b[key] ?? 0)]));

const tokenUsage = (threadId, turnId, total, last, window = 200_000) => notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last, modelContextWindow: window } });

const completed = (threadId, turnId, status = "completed", error = null) => {
	notify("turn/completed", { threadId, turn: { id: turnId, status, items: [], error, durationMs: 12 } });
	notify("thread/status/changed", { threadId, status: { type: "idle" } });
	const thread = threads.get(threadId);
	if (thread) {
		thread.status = { type: "idle" };
		if (thread.activeTurn === turnId) thread.activeTurn = undefined;
		const listed = thread.history?.find((turn) => turn.id === turnId);
		if (listed) listed.status = status;
	}
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
	const threadId = `${PREFIX}thr-${threadCount}`;
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
	result = { ...result, ...START_OVER };
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
	const turnId = `${PREFIX}turn-${turnCount}`;
	if (params.effort !== undefined) thread.turnEffort = params.effort;
	thread.status = { type: "active", activeFlags: [] };
	thread.activeTurn = turnId;
	thread.history?.push({ id: turnId, status: "inProgress" });
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
		case "steer-script":
		case "steer-ok":
		case "steer-rejected":
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
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "rerouted answer" } });
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
				notify("item/completed", { threadId, turnId, completedAtMs: 3, item: { type: "agentMessage", id: "msg-1", text: "declined and reported" } });
				tokenUsage(threadId, turnId, usage(30, 0, 3, 0), usage(30, 0, 3, 0));
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
		case "retry":
			answer();
			notify("error", { threadId, turnId, willRetry: true, error: { message: "stream disconnected, retrying", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } } });
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "answer after a retry" } });
			tokenUsage(threadId, turnId, usage(80, 0, 8, 0), usage(80, 0, 8, 0));
			completed(threadId, turnId);
			return;
		case "foreign-final":
			answer();
			notify("item/started", { threadId, turnId, startedAtMs: 1, item: { type: "commandExecution", id: "cmd-1", command: "ls -la\nsecond line", status: "inProgress" } });
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "commandExecution", id: "cmd-1", command: "ls -la", status: "completed", exitCode: 0, aggregatedOutput: "file-a\nfile-b" } });
			notify("item/completed", { threadId, turnId, completedAtMs: 3, item: { type: "agentMessage", id: "msg-1", text: "own final report" } });
			tokenUsage(threadId, turnId, usage(300, 100, 30, 0), usage(200, 100, 20, 0));
			// A subagent's thread and another turn of this thread, each with a later final message and its own usage.
			notify("item/started", { threadId: "thr-sub", turnId: "turn-sub", startedAtMs: 4, item: { type: "commandExecution", id: "cmd-sub", command: "rm -rf subagent", status: "inProgress" } });
			notify("item/completed", { threadId: "thr-sub", turnId: "turn-sub", completedAtMs: 4, item: { type: "agentMessage", id: "msg-sub", text: "subagent final text" } });
			tokenUsage("thr-sub", "turn-sub", usage(9_000, 0, 900, 0), usage(9_000, 0, 900, 0));
			notify("item/completed", { threadId, turnId: "turn-other", completedAtMs: 5, item: { type: "agentMessage", id: "msg-other", text: "foreign turn text" } });
			tokenUsage(threadId, "turn-other", usage(7_000, 0, 700, 0), usage(7_000, 0, 700, 0));
			notify("turn/completed", { threadId: "thr-sub", turn: { id: "turn-sub", status: "completed", items: [] } });
			completed(threadId, turnId);
			return;
		case "self-interrupt":
			// An end the host never asked for: the child interrupts its own turn.
			answer();
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "half an answer" } });
			completed(threadId, turnId, "interrupted");
			return;
		case "no-final":
			answer();
			tokenUsage(threadId, turnId, usage(10, 0, 1, 0), usage(10, 0, 1, 0));
			completed(threadId, turnId);
			return;
		case "no-usage":
			answer();
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "an answer with no usage" } });
			completed(threadId, turnId);
			return;
		case "two-turns": {
			// One short answer per turn on the same thread, each update's total cumulative for the thread and its last one
			// response's. Turn 1 reports no cache-write field at all; turn 2 has two responses that report it as 0.
			answer();
			const item = (at, type, extra) => notify("item/completed", { threadId, turnId, completedAtMs: at, item: { type, id: `${type}-${turnId}-${at}`, ...extra } });
			const reasoning = { summary: [], content: [] };
			if (turnCount === 1) {
				item(1, "reasoning", reasoning);
				item(2, "agentMessage", { text: "OK", phase: null });
				tokenUsage(threadId, turnId, usage(1_000, 0, 50, 10), usage(1_000, 0, 50, 10));
			} else {
				const write = (breakdown) => ({ ...breakdown, cacheWriteInputTokens: 0 });
				item(1, "reasoning", reasoning);
				item(2, "agentMessage", { text: "working", phase: null });
				tokenUsage(threadId, turnId, write(usage(2_100, 900, 70, 10)), write(usage(1_100, 900, 20, 0)));
				item(3, "reasoning", reasoning);
				item(4, "agentMessage", { text: "OK again", phase: null });
				tokenUsage(threadId, turnId, write(usage(3_250, 1_900, 100, 15)), write(usage(1_150, 1_000, 30, 5)));
			}
			completed(threadId, turnId);
			return;
		}
		case "resume-ok":
		case "resume-reset":
		case "resume-moved":
		case "resume-mismatch":
		case "fork-ok":
		case "fork-same-id":
		case "fork-tip-missing":
		case "turns-interrupted": {
			// One answer on a loaded thread: its total is cumulative from the seed, except `resume-reset`'s output.
			answer();
			const last = usage(400, 300, 20, 5);
			let total = plus(thread.seed ?? usage(0, 0, 0, 0), last);
			if (SCENARIO === "resume-reset") total = { ...total, outputTokens: last.outputTokens, totalTokens: total.inputTokens + last.outputTokens };
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "loaded answer", phase: null } });
			tokenUsage(threadId, turnId, total, last);
			if (REEMIT) tokenUsage(threadId, turnId, total, last);
			completed(threadId, turnId);
			return;
		}
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
			...READ_OVER,
		},
	};
	if (SCENARIO === "late-response" && withheld === undefined) {
		withheld = () => respond(id, result);
		return;
	}
	respond(id, result);
}

/** thread/resume and thread/fork: a persisted thread loaded under its own id, or forked under a new one. */
function loadThread(id, method, params) {
	if (!FOUNDATIONS.has(SCENARIO)) return fail(id, -32601, "method not found");
	const source = params?.threadId;
	if (typeof source !== "string" || source === "") return fail(id, -32600, "no thread id");
	let history = persisted();
	let threadId = source;
	let forkedFromId = null;
	if (method === "thread/fork") {
		const at = history.findIndex((turn) => turn.id === params.lastTurnId);
		if (at === -1) return fail(id, -32600, "no such turn");
		history = SCENARIO === "fork-tip-missing" ? [] : history.slice(0, at + 1);
		if (FORK_RENAME) history = history.map((turn) => ({ ...turn, id: `fork-${turn.id}` }));
		forkedFromId = source;
		if (SCENARIO !== "fork-same-id") {
			forkCount += 1;
			threadId = `${PREFIX}thr-fork-${forkCount}`;
		}
	}
	if (method === "thread/resume" && BAD === "resume-id") threadId = "thr-foreign";
	const model = params?.model ?? "gpt-host-default";
	const modelProvider = SCENARIO === "resume-mismatch" ? "azure" : (params?.modelProvider ?? "openai");
	threads.set(threadId, { model, modelProvider, startEffort: "high", turnEffort: undefined, status: { type: "idle" }, history, seed: SEED });
	const sandbox = params?.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false };
	const thread = { id: threadId, forkedFromId, sessionId: threadId, cwd, modelProvider, status: { type: "idle" }, turns: [], preview: "", ephemeral: false, cliVersion: "0.160.0", createdAt: 1, updatedAt: 1, source: "appServer", projectId: "p" };
	respond(id, { thread, model, modelProvider, cwd, sandbox, reasoningEffort: "high", approvalPolicy: params?.approvalPolicy ?? "on-request", approvalsReviewer: "user", instructionSources: [] });
}

/** thread/turns/list, newest first: each turn's id and status, with no items. */
function listTurns(id, params) {
	if (!FOUNDATIONS.has(SCENARIO)) return fail(id, -32601, "method not found");
	const thread = threads.get(params?.threadId);
	if (!thread) return fail(id, -32600, "no such thread");
	const newest = [...(thread.history ?? [])].reverse().slice(0, params.limit ?? Infinity);
	respond(id, { data: newest.map((turn) => ({ id: turn.id, items: [], status: turn.status, error: null })), nextCursor: null });
}

/** turn/steer: taken for the running turn it expects, or refused whole in `steer-rejected`, or scripted in `steer-script`. */
function steer(id, params) {
	if (!FOUNDATIONS.has(SCENARIO)) return fail(id, -32601, "method not found");
	if (SCENARIO === "steer-rejected") return fail(id, -32600, "the turn takes no input now");
	const thread = threads.get(params?.threadId);
	if (!thread || thread.activeTurn !== params.expectedTurnId) return fail(id, -32600, "expected turn mismatch");
	if (SCENARIO === "steer-script") {
		const at = steerCount;
		steerCount += 1;
		const action = STEERS[at] ?? "accept";
		if (action === "accept") respond(id, { turnId: params.expectedTurnId });
		else if (action === "reject") fail(id, -32600, "the turn takes no input now");
		// The last scripted steer ends the turn it was sent to, with this turn's own answer and usage.
		if (at === STEERS.length - 1) {
			const { threadId, expectedTurnId: turnId } = params;
			const last = usage(400, 300, 20, 5);
			notify("item/completed", { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: "msg-1", text: "steered answer", phase: null } });
			tokenUsage(threadId, turnId, plus(thread.seed ?? usage(0, 0, 0, 0), last), last);
			completed(threadId, turnId);
		}
		return;
	}
	respond(id, { turnId: BAD === "steer-turn" ? "turn-other" : params.expectedTurnId });
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
		case "thread/resume":
		case "thread/fork":
			return loadThread(message.id, message.method, message.params);
		case "thread/turns/list":
			return listTurns(message.id, message.params);
		case "turn/steer":
			return steer(message.id, message.params);
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
	process.exit(EXIT_CODE);
});
