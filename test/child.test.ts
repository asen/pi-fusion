import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BLOCKER_LABEL_CHARS, MAX_BLOCKERS } from "../extensions/backends/types.ts";
import { CLAUDE_COMPACT_VARIABLE, compactionEnv } from "../extensions/backends/claude.ts";
import { type ChildEvent, ChildInput, type ChildRun, type Role, childOptions, claudeExecutable, failed, failureMessage, questionAnswers, questionText, runChild } from "../extensions/fusion.ts";
import { parseRoleContract } from "../extensions/role-contracts.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaude = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.PI_FUSION_CLAUDE_BIN = fakeClaude;

const ultracodeRole: Role = {
	name: "ultracode",
	model: "fable",
	effort: "ultracode",
	permissionMode: "bypassPermissions",
	contract: "ultracode.md",
};
const implementRole: Role = {
	name: "implement",
	model: "opus",
	effort: "high",
	tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
	permissionMode: "bypassPermissions",
	contract: "implement.md",
};

function run(
	scenario: string,
	opts: {
		role?: Role;
		contract?: string;
		signal?: AbortSignal;
		killGraceMs?: number;
		onProgress?: (run: ChildRun) => void;
		onEvent?: (event: ChildEvent) => void;
		input?: ChildInput;
		onQuestion?: (question: string, signal: AbortSignal) => Promise<string>;
		compactPct?: number;
	} = {},
): Promise<ChildRun> {
	process.env.FAKE_CLAUDE_SCENARIO = scenario;
	return runChild({
		role: opts.role ?? ultracodeRole,
		prompt: "do the thing",
		contract: opts.contract,
		cwd: repoRoot,
		signal: opts.signal,
		onProgress: opts.onProgress ?? (() => {}),
		onEvent: opts.onEvent,
		killGraceMs: opts.killGraceMs,
		...(opts.input ? { input: opts.input } : {}),
		...(opts.onQuestion ? { onQuestion: opts.onQuestion } : {}),
		...(opts.compactPct === undefined ? {} : { compactPct: opts.compactPct }),
	});
}

/**
 * Runs a lifecycle scenario, which ends only once the run closes its input, and checks it ended cleanly with `text`.
 * A run still going after 15 seconds is aborted, so a regression fails here instead of leaving a child alive.
 */
async function closes(scenario: string, text: string, opts: Parameters<typeof run>[1] = {}): Promise<ChildRun> {
	const input = opts.input ?? new ChildInput();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	const child = await run(scenario, { ...opts, input, signal: controller.signal }).finally(() => clearTimeout(timer));
	assert.equal(child.aborted, false, "the input never closed");
	assert.equal(child.text, text);
	assert.equal(failed(child), false, child.errorMessage);
	assert.equal(child.abandonedTasks, undefined);
	assert.equal(input.open, false);
	return child;
}

/** A host steer, pushed after the event that prompted it has been handled, as a control call's would be. */
const steerOnFirstResult = (input: ChildInput, message: string) => {
	let sent = false;
	return (event: ChildEvent) => {
		if (event.type !== "turn_result" || sent) return;
		sent = true;
		setTimeout(() => input.push(message), 0);
	};
};

const distinct = (seen: string[]) => seen.filter((item, index) => item !== seen[index - 1]);

/** The throttle may render a partial delta before the trailing call, so check order, not the exact sequence. */
function assertInOrder(seen: string[], expected: string[]) {
	let from = 0;
	for (const item of expected) {
		const index = seen.indexOf(item, from);
		assert.ok(index !== -1, `expected ${JSON.stringify(item)} after position ${from} in ${JSON.stringify(seen)}`);
		from = index + 1;
	}
	assert.equal(seen[seen.length - 1], expected[expected.length - 1]);
}

test("the last result wins and usage is summed over turns", async () => {
	const seen: string[] = [];
	const child = await run("ok", { onProgress: (run) => seen.push(run.activity ?? "") });
	assert.equal(failed(child), false);
	assert.equal(child.text, "## Changed\nfoo.ts");
	assert.equal(child.toolCalls, 2);
	assert.equal(child.tokensIn, 26);
	assert.equal(child.tokensOut, 8);
	assert.equal(child.workflowTokens, 250);
	assert.equal(child.sessionId, "sess-1");
	assert.equal(child.checkpoint, "asst-3");
	assert.equal(child.abandonedTasks, undefined);
	assert.equal(child.stopReason, "stop");
	assert.equal(child.exitCode, 0);
	assert.equal(child.signal, null);
	assert.deepEqual(child.deniedTools, undefined);
	assert.deepEqual(distinct(seen), [
		"waiting for model",
		"Workflow",
		"Workflow probe",
		"workflow Probe · 1/3 agents done",
		"Bash npm test",
	]);
});

test("a workflow run reports its tasks as events", async () => {
	const events: ChildEvent[] = [];
	const child = await run("ok", { onEvent: (event) => events.push(event) });
	assert.equal(failed(child), false);
	assert.deepEqual(events, [
		{ type: "init", sessionId: "sess-1" },
		{ type: "tool_call", name: "Workflow", brief: "", id: "tu-1", input: { script: "export const meta = {}" } },
		{ type: "task_started", taskId: "wf-1", taskType: "local_workflow", name: "probe" },
		{ type: "blockers", tasks: [{ id: "wf-1", label: "workflow probe" }], total: 1 },
		{
			type: "task_progress",
			taskId: "wf-1",
			description: "Probe: a",
			tokens: 100,
			phase: "Probe",
			agents: [
				{ label: "a", state: "done" },
				{ label: "b", state: "start" },
			],
		},
		{ type: "turn_result", ok: true },
		{ type: "interim", revision: 1, text: "Workflow running; waiting for the completion notification." },
		{ type: "task_ended", taskId: "wf-1", status: "completed", tokens: 250 },
		{ type: "blockers", tasks: [], total: 0 },
		{ type: "tool_call", name: "Bash", brief: "npm test", id: "tu-2", input: { command: "npm test" } },
		{ type: "turn_result", ok: true },
	]);
});

test("a run adds up its cache, turns and API time and keeps the latest cost, models, context and thinking", async () => {
	const child = await run("ok");
	assert.equal(child.tokensIn, 10 + 2 + 1 + 4 + 7 + 2);
	assert.equal(child.cacheRead, 2 + 7);
	assert.equal(child.cacheWrite, 1 + 2);
	assert.equal(child.costUsd, 0.25);
	assert.equal(child.numTurns, 2);
	assert.equal(child.apiMs, 1500);
	assert.equal(child.modelId, "claude-fable-5-1");
	assert.equal(child.contextTokens, 1206);
	assert.equal(child.contextWindow, 1_000_000, "the window Claude Code reports for the main model wins over the default");
	assert.deepEqual(child.thinking, ["Run the tests next."]);
	assert.deepEqual(child.models, [
		{ model: "claude-fable-5-1", inputTokens: 14, outputTokens: 8, cacheRead: 9, cacheWrite: 3, costUsd: 0.2, contextWindow: 1_000_000 },
		{ model: "claude-opus-5", inputTokens: 100, outputTokens: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.05, contextWindow: 1_000_000 },
	]);
});

test("before a result reports it, the context window comes from the model id", async () => {
	const child = await run("read");
	assert.equal(child.modelId, "claude-fable-5-1");
	assert.equal(child.contextWindow, 200_000);
	assert.equal(child.costUsd, undefined);
});

test("an agent's tool calls are reported as events and stay out of the root run", async () => {
	const events: ChildEvent[] = [];
	const child = await run("agent", { onEvent: (event) => events.push(event) });
	assert.deepEqual(events, [
		{ type: "init", sessionId: "sess-1" },
		{ type: "tool_call", name: "Agent", brief: "probe files", id: "tu-1", input: { description: "probe files", prompt: "look" } },
		{ type: "task_started", taskId: "ag-1", toolUseId: "tu-1", taskType: "local_agent", name: "probe files" },
		{ type: "blockers", tasks: [{ id: "ag-1", label: "agent probe files" }], total: 1 },
		{ type: "agent_tool_call", parentToolUseId: "tu-1", name: "Read", id: "tu-sub-1", input: { file_path: "a.ts" } },
		{ type: "tool_result", toolUseId: "tu-sub-1", text: "no such file", isError: true },
		{ type: "task_progress", taskId: "ag-1", description: "probe files", lastTool: "Read", tokens: 50, toolUses: 1 },
		{ type: "task_ended", taskId: "ag-1", status: "completed", summary: "found it", tokens: 80 },
		{ type: "blockers", tasks: [], total: 0 },
		{ type: "tool_result", toolUseId: "tu-1", text: "found it", isError: false },
		{ type: "turn_result", ok: true },
	]);
	assert.equal(failed(child), false);
	assert.equal(child.toolCalls, 1);
	assert.equal(child.checkpoint, "asst-1");
	assert.equal(child.text, "done");
});

test("a failed turn reports its error message as an event", async () => {
	const events: ChildEvent[] = [];
	const child = await run("error", { onEvent: (event) => events.push(event) });
	assert.equal(failed(child), true);
	assert.deepEqual(events, [
		{ type: "init", sessionId: "sess-1" },
		{ type: "turn_result", ok: false, message: "boom" },
	]);
});

test("an event listener that throws does not change the run", async () => {
	const child = await run("read", {
		onEvent: () => {
			throw new Error("listener blew up");
		},
	});
	assert.equal(failed(child), false);
	assert.equal(child.text, "done");
	assert.equal(child.toolCalls, 1);
});

test("a child that exits with a background task still running fails instead of returning the turn's text", async () => {
	const child = await run("wind-down");
	assert.equal(failed(child), true);
	assert.equal(child.exitCode, 0);
	assert.equal(child.stopReason, "stop");
	assert.deepEqual(child.abandonedTasks, ["workflow probe"]);
	assert.equal(child.text, "Workflow running; waiting for the completion notification.");
	const message = failureMessage(child);
	assert.match(message, /^ultracode exited with workflow probe still running: /);
	assert.match(message, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0/);
});

test("an ambient task, such as a watcher, never counts as abandoned", async () => {
	const child = await run("ambient-task");
	assert.equal(failed(child), false);
	assert.equal(child.abandonedTasks, undefined);
	assert.equal(child.text, "done");
});

test("background_tasks_changed replaces the pending set and skips ambient tasks", async () => {
	await closes("tasks-cleared", "partial");

	const late = await run("tasks-changed");
	assert.equal(failed(late), true);
	assert.deepEqual(late.abandonedTasks, ["workflow late probe"]);
	assert.match(failureMessage(late), /^ultracode exited with workflow late probe still running/);
});

test("the input closes at idle after the last result, and not before idle once the child reports its state", async () => {
	await closes("state-plain", "done");
});

test("a report first, then the membership clearing, then idle, closes the input without another result", async () => {
	await closes("state-clear-idle", "report first");
});

test("idle with a background shell still live keeps the input open; the shell clearing closes it and the drained follow-up is the report", async () => {
	await closes("state-bash-idle", "build finished after EOF");
});

test("a task that turns ambient stops blocking", async () => {
	await closes("state-ambient-flip", "watching");
});

test("genuine background work keeps the input open until an abort", async () => {
	const input = new ChildInput();
	const controller = new AbortController();
	const pending = run("state-stuck", { input, signal: controller.signal });
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.equal(input.open, true);
	controller.abort();
	const child = await pending;
	assert.equal(child.stopReason, "aborted");
	assert.equal(child.text, "report while the server runs");
	assert.equal(input.open, false);
});

test("membership clearing mid-turn waits for that turn's result and idle, across tool results", async () => {
	await closes("state-clear-mid-turn", "final");
});

test("a steer taken after idle makes that idle and a stale one after it insufficient until the steer's own turn ends", async () => {
	const input = new ChildInput();
	await closes("state-steer-after-idle", "steered: use b", { input, onEvent: steerOnFirstResult(input, "use b") });
});

test("an open question keeps the input open and leaves the idle before it stale", async () => {
	await closes("state-question", "answered: beta", { onQuestion: async () => "beta" });
});

test("snapshots govern membership whichever side of them a task edge arrives, and late edges neither revive a task nor add an ambient one", async () => {
	await closes("state-late-edges", "report with two shells");
});

test("a running state makes the last result stale, so an idle before the new turn's result closes nothing", async () => {
	await closes("state-running-stale-result", "new report");
});

test("subagent frames and task progress after idle are not new work", async () => {
	await closes("state-idle-noise", "report");
});

test("without state events, a membership cleared after the result closes the input and the follow-up drained after EOF is the report", async () => {
	await closes("nostate-drain", "final after the follow-up");
});

test("without state events, an open question keeps the input open, since its answer comes back over it", async () => {
	const later = async () => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		return "beta";
	};
	await closes("nostate-question", "answered: beta", { onQuestion: later });
});

test("an open question outlasting a result keeps the input open until a cancel ends the run", async () => {
	const input = new ChildInput();
	const controller = new AbortController();
	const unanswered = (_question: string, signal: AbortSignal) =>
		new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
	const pending = run("nostate-question", { input, signal: controller.signal, onQuestion: unanswered });
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.equal(input.open, true);
	controller.abort();
	const child = await pending;
	assert.equal(child.stopReason, "aborted");
	assert.equal(child.text, "agent started");
	assert.equal(input.open, false);
});

test("without state events, the last task ending mid-turn waits for that turn's result", async () => {
	await closes("nostate-mid-turn", "final");
});

test("without state events, a steer taken after the result waits for a later result", async () => {
	const input = new ChildInput();
	await closes("nostate-steer-after-result", "steered: use b", { input, onEvent: steerOnFirstResult(input, "use b") });
});

test("a result while background tasks still run is an interim report, once per result, and the final one is not", async () => {
	const events: ChildEvent[] = [];
	const child = await closes("interim-revisions", "final", { onEvent: (event) => events.push(event) });
	assert.deepEqual(
		events.filter((event) => event.type === "interim"),
		[
			{ type: "interim", revision: 1, text: "first report" },
			{ type: "interim", revision: 2, text: "second report" },
		],
		"a repeated result, a blank one and the final one add no revision",
	);
	assert.deepEqual(
		events.filter((event) => event.type === "blockers"),
		[
			{ type: "blockers", tasks: [{ id: "wf-1", label: "workflow probe" }], total: 1 },
			{ type: "blockers", tasks: [{ id: "wf-1", label: "workflow probe" }, { id: "wf-2", label: "workflow scan" }], total: 2 },
			{ type: "blockers", tasks: [{ id: "wf-2", label: "workflow scan" }], total: 1 },
			{ type: "blockers", tasks: [], total: 0 },
		],
		"each change of what the run waits for is published once",
	);
	assert.equal(child.stopReason, "stop");
});

test("an error result while a task still runs is no interim report", async () => {
	const events: ChildEvent[] = [];
	const child = await run("interim-error", { onEvent: (event) => events.push(event) });
	assert.equal(failed(child), true);
	assert.deepEqual(events.filter((event) => event.type === "interim"), []);
});

test("what the run waits for is published bounded, with labels cut and the whole count, while the set itself stays exact", async () => {
	const events: ChildEvent[] = [];
	const child = await run("many-blockers", { onEvent: (event) => events.push(event) });
	const [blockers] = events.filter((event) => event.type === "blockers");
	assert.ok(blockers?.type === "blockers");
	assert.equal(blockers.total, 25);
	assert.equal(blockers.tasks.length, MAX_BLOCKERS);
	assert.ok(blockers.tasks.every((task) => task.label.length === BLOCKER_LABEL_CHARS + 1 && task.label.endsWith("…")), JSON.stringify(blockers.tasks[0]));
	assert.equal(child.abandonedTasks?.length, 25, "the run's own set is not cut");
	assert.deepEqual(events.filter((event) => event.type === "interim"), [{ type: "interim", revision: 1, text: "many going" }]);
});

test("partial messages show thinking, text and tool calls as activity", async () => {
	const seen: string[] = [];
	const child = await run("stream", { onProgress: (run) => seen.push(run.activity ?? "") });
	assert.equal(failed(child), false);
	assert.equal(child.toolCalls, 1);
	assertInOrder(distinct(seen), [
		"waiting for model",
		"thinking · Planning the change",
		"writing · Running tests",
		"calling Bash",
		"Bash npm test",
		"waiting for model",
	]);
	assert.ok(!seen.some((activity) => activity.includes("Subagent noise")), JSON.stringify(seen));
});

test("a burst of deltas is rendered a few times, not once per delta", async () => {
	const seen: string[] = [];
	const child = await run("burst", { onProgress: (run) => seen.push(run.activity ?? "") });
	assert.equal(failed(child), false);
	const writing = seen.filter((activity) => activity.startsWith("writing · "));
	assert.ok(writing.length >= 1 && writing.length <= 3, `expected 1 to 3 writing updates, got ${writing.length}`);
	assert.match(writing[writing.length - 1]!, /^writing · …\S.* word199$/);
});

test("a repeated tool_use block is counted once", async () => {
	const child = await run("dup-tool-use");
	assert.equal(failed(child), false);
	assert.equal(child.toolCalls, 1);
});

test("an error result fails with the error text", async () => {
	const child = await run("error");
	assert.equal(failed(child), true);
	const message = failureMessage(child);
	assert.match(message, /model error/);
	assert.match(message, /boom/);
});

test("an empty error result reports its subtype", async () => {
	const child = await run("max-turns");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /error_max_turns/);
});

test("an API error on a success result fails with its text", async () => {
	const child = await run("api-error");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /model error: rate limited/);
});


test("permission denials are recorded without failing the run", async () => {
	const child = await run("denied");
	assert.equal(failed(child), false);
	assert.deepEqual(child.deniedTools, ["Workflow"]);
});

test("silent child fails with no response", async () => {
	const child = await run("silent");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /no response/);
});

test("non-zero exit reports code and the stderr lines that are not warnings", async () => {
	const child = await run("exit1");
	assert.equal(failed(child), true);
	const message = failureMessage(child);
	assert.match(message, /exited 1/);
	assert.match(message, /Not logged in/);
	assert.ok(!message.includes("something minor"), message);
});

test("a child that exits before the handshake completes still reports its stderr", async () => {
	const child = await run("no-init-exit1");
	assert.equal(failed(child), true);
	assert.equal(child.sessionId, undefined);
	assert.match(failureMessage(child), /exited 1: Not logged in/);
});

test("child killed by signal reports the signal", async () => {
	const child = await run("selfkill");
	assert.equal(failed(child), true);
	assert.match(failureMessage(child), /SIGKILL/);
});

test("a null exit code reports failure without guessing whether the child started", async () => {
	const child = await run("ok", { role: implementRole });
	for (const detail of ["failed to spawn", "readiness timed out", "the pi child could not be stopped after its turn"]) {
		assert.equal(failureMessage({ ...child, exitCode: null, errorMessage: detail }), `implement failed: ${detail}`);
	}
	assert.equal(failureMessage({ ...child, exitCode: null, errorMessage: "", stderr: "", text: "" }), "implement failed");
	assert.equal(failureMessage({ ...child, exitCode: 7, errorMessage: "exit detail" }), "implement exited 7: exit detail");
	assert.equal(failureMessage({ ...child, exitCode: null, signal: "SIGTERM", errorMessage: "signal detail" }), "implement killed by SIGTERM: signal detail");
	assert.equal(failureMessage({ ...child, exitCode: null, aborted: true, activity: "reading" }), "implement aborted while reading");
});

test("a missing executable reports the spawn failure", async () => {
	const saved = process.env.PI_FUSION_CLAUDE_BIN;
	try {
		process.env.PI_FUSION_CLAUDE_BIN = "/nonexistent/claude";
		const child = await run("ok");
		assert.equal(failed(child), true);
		assert.equal(child.exitCode, null);
		const message = failureMessage(child);
		assert.match(message, /^ultracode failed:/);
		assert.match(message, /nonexistent/);
	} finally {
		process.env.PI_FUSION_CLAUDE_BIN = saved;
	}
});

test("hanging child is aborted by signal", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	try {
		const child = await run("hang", { signal: controller.signal });
		assert.equal(failed(child), true);
		assert.equal(child.aborted, true);
		assert.equal(child.stopReason, "aborted");
		assert.match(failureMessage(child), /aborted/);
		assert.ok(child.ms < 5000, `expected the abort to kill the child within 5s, took ${child.ms}ms`);
	} finally {
		clearTimeout(timer);
	}
});

test("an abort after an intermediate result still fails and keeps the partial text", async () => {
	const controller = new AbortController();
	const child = await run("result-then-hang-exit0", {
		signal: controller.signal,
		onProgress: (run) => {
			if (run.text === "partial") controller.abort();
		},
	});
	assert.equal(failed(child), true);
	assert.equal(child.aborted, true);
	assert.equal(child.stopReason, "aborted");
	assert.equal(child.exitCode, 0);
	assert.equal(child.signal, null);
	assert.equal(child.text, "partial");
	assert.match(failureMessage(child), /aborted/);
});

test("child ignoring SIGTERM is escalated to SIGKILL", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 200);
	try {
		const child = await run("hang-ignore-term", { signal: controller.signal, killGraceMs: 200 });
		assert.equal(failed(child), true);
		assert.equal(child.signal, "SIGKILL");
		assert.ok(child.ms < 5000, `expected escalation within 5s, took ${child.ms}ms`);
	} finally {
		clearTimeout(timer);
	}
});

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const waitFor = async (condition: () => boolean, ms: number): Promise<boolean> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return condition();
};

test("aborting kills a detached grandchild that ignores SIGTERM", async () => {
	const pidFile = path.join(os.tmpdir(), `pi-fusion-grandchild-${process.pid}.pid`);
	fs.rmSync(pidFile, { force: true });
	process.env.FAKE_CLAUDE_GRANDCHILD_PID_FILE = pidFile;
	const controller = new AbortController();
	let grandchild = 0;
	try {
		const pending = run("hang-grandchild", { role: implementRole, signal: controller.signal, killGraceMs: 200 });
		assert.ok(await waitFor(() => fs.existsSync(pidFile), 5_000), "fake claude did not start its grandchild");
		grandchild = Number(fs.readFileSync(pidFile, "utf8"));
		assert.ok(grandchild > 0 && alive(grandchild));
		controller.abort();
		const child = await pending;
		assert.equal(child.aborted, true);
		assert.equal(failureMessage(child), "implement aborted while Read a.ts");
		assert.ok(await waitFor(() => !alive(grandchild), 3_000), `grandchild ${grandchild} survived the abort`);
	} finally {
		if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
		fs.rmSync(pidFile, { force: true });
		delete process.env.FAKE_CLAUDE_GRANDCHILD_PID_FILE;
	}
});

test("a large non-ascii report survives chunk boundaries", async () => {
	const child = await run("unicode");
	assert.equal(failed(child), false);
	assert.equal(child.text, `x${"é".repeat(100_000)}`);
	assert.ok(!child.text.includes("�"), "report contains replacement characters");
});

test("a startup-resolved body reaches the Claude SDK without rereading a file or parsing the body as frontmatter", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-claude-contract-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const out = path.join(dir, "argv.json");
	const body = "---\nAlready parsed child instructions.\n";
	const previous = process.env.FAKE_CLAUDE_ARGV_OUT;
	process.env.FAKE_CLAUDE_ARGV_OUT = out;
	try {
		const result = await run("ok", { role: { ...implementRole, contract: "does-not-exist.md" }, contract: body });
		assert.equal(failed(result), false);
		assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).appendSystemPrompt, body);
	} finally {
		if (previous === undefined) delete process.env.FAKE_CLAUDE_ARGV_OUT;
		else process.env.FAKE_CLAUDE_ARGV_OUT = previous;
	}
});

test("a compaction request lowers Claude Code's native auto-compact percentage and never raises one already exported", () => {
	assert.equal(CLAUDE_COMPACT_VARIABLE, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
	// Unset and 0 add nothing, so whatever the host exports reaches the child exactly as it would without Fusion.
	assert.deepEqual(compactionEnv(undefined, {}), {});
	assert.deepEqual(compactionEnv(0, { [CLAUDE_COMPACT_VARIABLE]: "90" }), {});
	assert.deepEqual(compactionEnv(60, {}), { [CLAUDE_COMPACT_VARIABLE]: "60" });
	assert.deepEqual(compactionEnv(100, {}), { [CLAUDE_COMPACT_VARIABLE]: "100" }, "100 is a request, not the same as unset");
	// The child parses the value with parseFloat and uses it above 0 and up to 100: a lower one it would use is kept.
	assert.deepEqual(compactionEnv(60, { [CLAUDE_COMPACT_VARIABLE]: "40" }), {});
	assert.deepEqual(compactionEnv(60, { [CLAUDE_COMPACT_VARIABLE]: "60" }), {});
	assert.deepEqual(compactionEnv(60, { [CLAUDE_COMPACT_VARIABLE]: "45.5" }), {});
	// A higher one, or one the child would ignore, is replaced by the request.
	for (const ignored of ["80", "", "0", "-5", "150", "abc"]) assert.deepEqual(compactionEnv(60, { [CLAUDE_COMPACT_VARIABLE]: ignored }), { [CLAUDE_COMPACT_VARIABLE]: "60" }, ignored);
	// The overlay is that one variable: a disable or a window the host exports is not part of it, so it passes through.
	assert.deepEqual(compactionEnv(60, { DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }), { [CLAUDE_COMPACT_VARIABLE]: "60" });
});

test("a run's compaction request reaches the Claude child's environment, and an unset one leaves it alone", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-claude-compact-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const out = path.join(dir, "argv.json");
	const PRESERVED = ["DISABLE_AUTO_COMPACT", "DISABLE_COMPACT", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"] as const;
	const PRESERVED_VALUES: Record<(typeof PRESERVED)[number], string> = { DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" };
	const previous = { out: process.env.FAKE_CLAUDE_ARGV_OUT, pct: process.env[CLAUDE_COMPACT_VARIABLE], preserved: Object.fromEntries(PRESERVED.map((name) => [name, process.env[name]])) as Record<string, string | undefined> };
	process.env.FAKE_CLAUDE_ARGV_OUT = out;
	const childPct = async (compactPct: number | undefined): Promise<unknown> => {
		const result = await run("ok", { role: implementRole, ...(compactPct === undefined ? {} : { compactPct }) });
		assert.equal(failed(result), false);
		assert.equal(result.compactionNotice, undefined, "Claude reports no compaction notice: nothing it applies is read back");
		return JSON.parse(fs.readFileSync(out, "utf8")).env[CLAUDE_COMPACT_VARIABLE];
	};
	try {
		delete process.env[CLAUDE_COMPACT_VARIABLE];
		assert.equal(await childPct(undefined), undefined);
		assert.equal(await childPct(60), "60");
		process.env[CLAUDE_COMPACT_VARIABLE] = "30";
		assert.equal(await childPct(60), "30", "the host's lower value is the one the child gets");
		assert.equal(await childPct(undefined), "30", "and an unset request passes the host's own through");
		process.env[CLAUDE_COMPACT_VARIABLE] = "90";
		assert.equal(await childPct(60), "60");
		// The host's own disables and window reach the child beside the overlay, untouched.
		for (const name of PRESERVED) process.env[name] = PRESERVED_VALUES[name];
		assert.equal(await childPct(60), "60");
		const env = JSON.parse(fs.readFileSync(out, "utf8")).env;
		for (const name of PRESERVED) assert.equal(env[name], PRESERVED_VALUES[name], name);
	} finally {
		for (const name of PRESERVED) {
			if (previous.preserved[name] === undefined) delete process.env[name];
			else process.env[name] = previous.preserved[name];
		}
		if (previous.out === undefined) delete process.env.FAKE_CLAUDE_ARGV_OUT;
		else process.env.FAKE_CLAUDE_ARGV_OUT = previous.out;
		if (previous.pct === undefined) delete process.env[CLAUDE_COMPACT_VARIABLE];
		else process.env[CLAUDE_COMPACT_VARIABLE] = previous.pct;
	}
});

test("childOptions takes a supplied contract body as text, unparsed, and refuses a blank one before any child", () => {
	const headed = "---\ndisabled: true\n---\nAlready resolved.\n";
	assert.equal((childOptions(implementRole, undefined, "t", headed).systemPrompt as { append: string }).append, headed);
	assert.throws(() => childOptions(implementRole, undefined, "t", " \n"), /supplied role contract body is blank/);
});

test("childOptions maps a role to SDK options", () => {
	const saved = process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
	try {
		delete process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
		const ultracode = childOptions(ultracodeRole, undefined, "t");
		assert.equal(ultracode.model, "fable");
		assert.equal(ultracode.effort, undefined);
		assert.deepEqual(ultracode.extraArgs, { effort: "ultracode" });
		assert.equal(ultracode.tools, undefined);
		assert.equal(ultracode.strictMcpConfig, undefined);
		assert.equal(ultracode.permissionMode, "bypassPermissions");
		assert.equal(ultracode.allowDangerouslySkipPermissions, true);
		assert.equal(ultracode.permissionPrompts, "none");
		assert.equal(ultracode.includePartialMessages, true);
		assert.equal(ultracode.settings, undefined);
		assert.equal(ultracode.sessionId, undefined);
		assert.equal(ultracode.resume, undefined);
		const systemPrompt = ultracode.systemPrompt as { type: string; preset: string; append: string };
		assert.equal(systemPrompt.type, "preset");
		assert.equal(systemPrompt.preset, "claude_code");
		assert.equal(systemPrompt.append, parseRoleContract(fs.readFileSync(path.join(repoRoot, "contracts", "ultracode.md"), "utf8"), "ultracode.md").body);

		process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE = "large";
		assert.deepEqual(childOptions(ultracodeRole, undefined, "t").settings, { workflowSizeGuideline: "large" });
		assert.equal(childOptions(implementRole, undefined, "t").settings, undefined);

		const tools = childOptions(implementRole, undefined, "t");
		assert.equal(tools.effort, "high");
		assert.equal(tools.extraArgs, undefined);
		assert.deepEqual(tools.tools, ["Read", "Bash", "Edit", "Write", "Grep", "Glob"]);
		assert.equal(tools.strictMcpConfig, true);

		const acceptEdits = childOptions({ ...ultracodeRole, permissionMode: "acceptEdits" }, undefined, "t");
		assert.equal(acceptEdits.allowDangerouslySkipPermissions, false);

		const fresh = childOptions(implementRole, { kind: "new", id: "id-1" }, "t");
		assert.equal(fresh.sessionId, "id-1");
		assert.equal(fresh.resume, undefined);
		assert.equal(fresh.forkSession, undefined);
		const resumed = childOptions(implementRole, { kind: "resume", id: "id-1" }, "t");
		assert.equal(resumed.sessionId, undefined);
		assert.equal(resumed.resume, "id-1");
		assert.equal(resumed.forkSession, undefined);
		assert.equal(resumed.resumeSessionAt, undefined);
		const forked = childOptions(implementRole, { kind: "fork", id: "id-2", from: "id-1" }, "t");
		assert.equal(forked.sessionId, "id-2");
		assert.equal(forked.resume, "id-1");
		assert.equal(forked.forkSession, true);
		assert.equal(forked.resumeSessionAt, undefined);
		assert.equal(childOptions(implementRole, { kind: "resume", id: "id-1", at: "c-1" }, "t").resumeSessionAt, "c-1");
		assert.equal(childOptions(implementRole, { kind: "fork", id: "id-2", from: "id-1", at: "c-1" }, "t").resumeSessionAt, "c-1");
	} finally {
		if (saved === undefined) delete process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE;
		else process.env.PI_FUSION_ULTRACODE_WORKFLOW_SIZE = saved;
	}
});

test("claudeExecutable honours PI_FUSION_CLAUDE_BIN", () => {
	try {
		process.env.PI_FUSION_CLAUDE_BIN = "/x/fake.mjs";
		assert.deepEqual(claudeExecutable(), { pathToClaudeCodeExecutable: "/x/fake.mjs", executable: "node" });

		process.env.PI_FUSION_CLAUDE_BIN = "/usr/local/bin/claude";
		assert.deepEqual(claudeExecutable(), { pathToClaudeCodeExecutable: "/usr/local/bin/claude" });

		delete process.env.PI_FUSION_CLAUDE_BIN;
		assert.deepEqual(claudeExecutable(), {});
	} finally {
		process.env.PI_FUSION_CLAUDE_BIN = fakeClaude;
	}
});

test("AskUserQuestion's questions become one question, and the answer splits into one line per question only when the lines match", () => {
	const one = [{ question: "Which store?", options: [{ label: "sqlite", description: "one file" }, { label: "postgres" }] }];
	assert.equal(questionText(one), "Which store?\n- sqlite: one file\n- postgres");
	assert.deepEqual(questionAnswers(one, " sqlite \n"), { "Which store?": "sqlite" });
	const two = [{ question: "A?" }, { question: "B?", multiSelect: true }];
	assert.equal(questionText(two), "1. A?\n\n2. B?\n(one or more, separated by commas)\n\nAnswer each question on its own line, in order.");
	assert.deepEqual(questionAnswers(two, "1. yes\n2. x, y"), { "A?": "yes", "B?": "x, y" });
	assert.deepEqual(questionAnswers(two, "yes to both"), { "A?": "yes to both", "B?": "yes to both" });
});
