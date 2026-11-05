/*
 * A stand-in for the Claude Code binary the Agent SDK spawns. It answers the SDK's `initialize` control request,
 * takes the prompt from the `user` line that follows, then plays the scenario named by FAKE_CLAUDE_SCENARIO on
 * stdout in Claude Code's stream-json format.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
	const inline = argv.find((arg) => arg.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
};
const sessionId = flag("--session-id") ?? flag("--resume") ?? "sess-1";
const scenario = process.env.FAKE_CLAUDE_SCENARIO || "ok";
if (scenario === "hang-ignore-term") process.on("SIGTERM", () => {});
if (scenario === "result-then-hang-exit0") process.on("SIGTERM", () => process.exit(0));

const emit = (event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

let appendSystemPrompt;
let initialize;
let started = false;
/**
 * Lifecycle scenarios keep stdin too and end only once the run closes it, as Claude Code in stream-json mode does: a
 * scenario that sees EOF before the step it guards ends with a `stdin closed early` result, and one that waits for EOF
 * and never gets it ends with `stdin stayed open`.
 */
const LIFECYCLE = new Set([
	"state-plain",
	"state-clear-idle",
	"state-bash-idle",
	"state-ambient-flip",
	"state-stuck",
	"state-clear-mid-turn",
	"state-steer-after-idle",
	"state-question",
	"state-late-edges",
	"state-idle-noise",
	"state-running-stale-result",
	"nostate-drain",
	"nostate-mid-turn",
	"nostate-steer-after-result",
	"nostate-question",
	"interim-revisions",
]);
const KEEP_STDIN = new Set(["steer", "question", "question-escape", "question-then-steer", "question-then-question", "question-then-end", "two-questions", "ask-user", "tasks-cleared", ...LIFECYCLE]);
/** What each question scenario asks. question-escape paints its question red and hides a link behind a label, as a child's text can. */
const ASKED = {
	question: ["Which name?"],
	"question-escape": ["\u001b[31mWhich name?\u001b]8;;https://evil.test\u0007click me\u001b]8;;\u0007"],
	"two-questions": ["First?", "Second?"],
};
let nextRequest = 0;
const pending = new Map();
/** Sends a control request to the SDK, as Claude Code does for an SDK MCP server or a hook callback, and waits for the reply. */
const control = (request) =>
	new Promise((resolve) => {
		const id = `fake-${++nextRequest}`;
		pending.set(id, resolve);
		emit({ type: "control_request", request_id: id, request });
	});
let nextMcp = 0;
const mcp = async (method, params) => {
	const reply = await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", id: ++nextMcp, method, params } });
	return reply.mcp_response;
};
const inputs = [];
let onInput;
const nextInput = (ms) =>
	new Promise((resolve) => {
		if (inputs.length) return resolve(inputs.shift());
		const timer = setTimeout(() => resolve(undefined), ms);
		onInput = () => {
			clearTimeout(timer);
			resolve(inputs.shift());
		};
	});
let eof = false;
let onEof;
process.stdin.on("end", () => {
	eof = true;
	onEof?.();
});
/** Resolves true once stdin has ended, or false after `ms` without it. */
const eofWithin = (ms) =>
	new Promise((resolve) => {
		if (eof) return resolve(true);
		const timer = setTimeout(() => resolve(false), ms);
		onEof = () => {
			clearTimeout(timer);
			resolve(true);
		};
	});
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
	buffer += data;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) onLine(line);
});

function onLine(line) {
	if (!line.trim()) return;
	if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `stdin ${line.slice(0, 300)}\n`);
	const message = JSON.parse(line);
	if (message.type === "control_response") {
		const id = message.response?.request_id;
		pending.get(id)?.(message.response?.response ?? {});
		pending.delete(id);
	} else if (message.type === "control_request") {
		if (message.request?.subtype === "initialize") {
			appendSystemPrompt = message.request.appendSystemPrompt;
			initialize = { hooks: message.request.hooks, sdkMcpServers: message.request.sdkMcpServers, sdkMcpServerConfigs: message.request.sdkMcpServerConfigs };
		}
		emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
	} else if (message.type === "user") {
		const content = message.message?.content;
		const text = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("");
		if (started) {
			inputs.push(text);
			onInput?.();
			return;
		}
		started = true;
		// The SDK holds stdin open until it has seen the init message, so a scenario that never sends one must not wait for stdin to end.
		if (!KEEP_STDIN.has(scenario)) process.stdin.destroy();
		void main(text);
	}
}

async function main(prompt) {
	const argvOut = process.env.FAKE_CLAUDE_ARGV_OUT;
	if (argvOut) {
		fs.writeFileSync(
			argvOut,
			JSON.stringify({ argv, prompt, appendSystemPrompt, initialize, env: {
					CLAUDE_AGENT_SDK_CLIENT_APP: process.env.CLAUDE_AGENT_SDK_CLIENT_APP,
					CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
					CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
					CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
					DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT,
					DISABLE_COMPACT: process.env.DISABLE_COMPACT,
					CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
				} }),
		);
	}

	const init = () => {
		emit({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fable-5-1", permissionMode: "bypassPermissions" });
	};
	let assistantCount = 0;
	const assistant = (content) => {
		emit({ type: "assistant", uuid: `asst-${++assistantCount}`, session_id: sessionId, message: { role: "assistant", content } });
	};
	const toolUse = (id, name, input) => assistant([{ type: "tool_use", id, name, input }]);
	const result = (text, extra = {}) => {
		emit({
			type: "result",
			subtype: "success",
			is_error: false,
			result: text,
			session_id: sessionId,
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
			permission_denials: [],
			...extra,
		});
	};
	const errorResult = (subtype, text) => {
		emit({
			type: "result",
			subtype,
			is_error: true,
			errors: text ? [text] : [],
			session_id: sessionId,
			num_turns: 1,
			duration_ms: 1,
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
			permission_denials: [],
		});
	};
	const streamEvent = (event, parentToolUseId = null) => {
		emit({ type: "stream_event", event, session_id: sessionId, parent_tool_use_id: parentToolUseId });
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const state = (value) => emit({ type: "system", subtype: "session_state_changed", state: value, session_id: sessionId });
	const tasks = (list) => emit({ type: "system", subtype: "background_tasks_changed", tasks: list, session_id: sessionId });
	const taskStarted = (taskId, taskType, extra = {}) => emit({ type: "system", subtype: "task_started", task_id: taskId, task_type: taskType, description: taskId, ...extra });
	const taskEnded = (taskId) => emit({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: `${taskId} done` });
	const text = (value) => assistant([{ type: "text", text: value }]);
	/** True, after ending the run with a result saying so, when stdin closed before this step; a pause first lets a premature close arrive. */
	const closedEarly = async (step) => {
		await sleep(150);
		if (!eof) return false;
		result(`stdin closed early: ${step}`);
		return true;
	};
	/** Waits for the run to close stdin; without it, ends the run with a result saying so and stops reading. */
	const awaitEof = async () => {
		if (await eofWithin(3000)) return true;
		result("stdin stayed open");
		process.stdin.destroy();
		return false;
	};
	/** A follow-up turn the way Claude Code drains a pending notification after EOF: the result carries the final report. */
	const followUp = (taskId, report) => {
		taskEnded(taskId);
		text(report);
		result(report);
	};

	switch (scenario) {
		case "ok":
			init();
			toolUse("tu-1", "Workflow", { script: "export const meta = {}" });
			emit({ type: "system", subtype: "task_started", task_id: "wf-1", task_type: "local_workflow", workflow_name: "probe" });
			emit({
				type: "system",
				subtype: "task_progress",
				task_id: "wf-1",
				description: "Probe: a",
				usage: { total_tokens: 100 },
				workflow_progress: [
					{ type: "workflow_phase", index: 1, title: "Probe" },
					{ type: "workflow_agent", label: "a", state: "done" },
					{ type: "workflow_agent", label: "b", state: "start" },
					{ type: "workflow_agent", state: "start" },
				],
			});
			result("Workflow running; waiting for the completion notification.");
			emit({ type: "system", subtype: "task_notification", task_id: "wf-1", status: "completed", usage: { total_tokens: 250 } });
			emit({
				type: "assistant",
				uuid: `asst-${++assistantCount}`,
				session_id: sessionId,
				message: { role: "assistant", usage: { input_tokens: 6, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, content: [{ type: "thinking", thinking: "Run the tests next." }] },
			});
			toolUse("tu-2", "Bash", { command: "npm test" });
			result("## Changed\nfoo.ts", {
				usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
				total_cost_usd: 0.25,
				num_turns: 2,
				duration_api_ms: 1500,
				modelUsage: {
					"claude-fable-5-1": { inputTokens: 14, outputTokens: 8, cacheReadInputTokens: 9, cacheCreationInputTokens: 3, costUSD: 0.2, contextWindow: 1000000 },
					"claude-opus-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05, contextWindow: 1000000 },
				},
			});
			break;
		case "ok-sync":
			// "ok" with the workflow ending before the turn's result: the same spend, and no report while a task still runs.
			init();
			toolUse("tu-1", "Workflow", { script: "export const meta = {}" });
			emit({ type: "system", subtype: "task_started", task_id: "wf-1", task_type: "local_workflow", workflow_name: "probe" });
			emit({
				type: "system",
				subtype: "task_progress",
				task_id: "wf-1",
				description: "Probe: a",
				usage: { total_tokens: 100 },
				workflow_progress: [
					{ type: "workflow_phase", index: 1, title: "Probe" },
					{ type: "workflow_agent", label: "a", state: "done" },
					{ type: "workflow_agent", label: "b", state: "start" },
					{ type: "workflow_agent", state: "start" },
				],
			});
			emit({ type: "system", subtype: "task_notification", task_id: "wf-1", status: "completed", usage: { total_tokens: 250 } });
			result("Workflow finished.");
			emit({
				type: "assistant",
				uuid: `asst-${++assistantCount}`,
				session_id: sessionId,
				message: { role: "assistant", usage: { input_tokens: 6, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, content: [{ type: "thinking", thinking: "Run the tests next." }] },
			});
			toolUse("tu-2", "Bash", { command: "npm test" });
			result("## Changed\nfoo.ts", {
				usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 },
				total_cost_usd: 0.25,
				num_turns: 2,
				duration_api_ms: 1500,
				modelUsage: {
					"claude-fable-5-1": { inputTokens: 14, outputTokens: 8, cacheReadInputTokens: 9, cacheCreationInputTokens: 3, costUSD: 0.2, contextWindow: 1000000 },
					"claude-opus-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05, contextWindow: 1000000 },
				},
			});
			break;
		case "big-context":
			init();
			emit({
				type: "assistant",
				uuid: `asst-${++assistantCount}`,
				session_id: sessionId,
				message: { role: "assistant", usage: { input_tokens: 100000, output_tokens: 20, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "the plan so far" }] },
			});
			result("## Agreed plan\n1. rename the field", {
				modelUsage: {
					"claude-fable-5-1": { inputTokens: 100000, outputTokens: 20, cacheReadInputTokens: 300000, cacheCreationInputTokens: 0, costUSD: 0.5, contextWindow: 1000000 },
				},
			});
			break;
		case "agent":
			init();
			toolUse("tu-1", "Agent", { description: "probe files", prompt: "look" });
			emit({ type: "system", subtype: "task_started", task_id: "ag-1", tool_use_id: "tu-1", task_type: "local_agent", description: "probe files" });
			emit({
				type: "assistant",
				uuid: "asst-sub-1",
				session_id: sessionId,
				parent_tool_use_id: "tu-1",
				message: { role: "assistant", content: [{ type: "tool_use", id: "tu-sub-1", name: "Read", input: { file_path: "a.ts" } }] },
			});
			emit({
				type: "user",
				session_id: sessionId,
				parent_tool_use_id: "tu-1",
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-sub-1", content: "no such file", is_error: true }] },
			});
			emit({
				type: "system",
				subtype: "task_progress",
				task_id: "ag-1",
				tool_use_id: "tu-1",
				description: "probe files",
				usage: { total_tokens: 50, tool_uses: 1, duration_ms: 10 },
				last_tool_name: "Read",
			});
			emit({
				type: "system",
				subtype: "task_notification",
				task_id: "ag-1",
				tool_use_id: "tu-1",
				status: "completed",
				summary: "found it",
				usage: { total_tokens: 80, tool_uses: 1, duration_ms: 20 },
			});
			emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: [{ type: "text", text: "found it" }] }] } });
			result("done");
			break;
		case "ambient-task":
			init();
			emit({ type: "system", subtype: "task_started", task_id: "watch-1", task_type: "local_bash", description: "watch the build", ambient: true, skip_transcript: true });
			result("done");
			break;
		case "tasks-cleared":
			init();
			toolUse("tu-1", "Workflow", { script: "export const meta = {}" });
			emit({ type: "system", subtype: "task_started", task_id: "wf-1", task_type: "local_workflow", workflow_name: "probe" });
			result("partial");
			emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
			break;
		case "tasks-changed":
			init();
			emit({
				type: "system",
				subtype: "background_tasks_changed",
				tasks: [
					{ task_id: "wf-9", task_type: "local_workflow", description: "late probe" },
					{ task_id: "m-1", task_type: "monitor_ws", description: "journal", ambient: true },
				],
			});
			result("partial");
			break;
		case "wind-down":
			init();
			toolUse("tu-1", "Workflow", { script: "export const meta = {}" });
			emit({ type: "system", subtype: "task_started", task_id: "wf-1", task_type: "local_workflow", workflow_name: "probe" });
			result("Workflow running; waiting for the completion notification.");
			process.stderr.write("Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n");
			break;
		case "read":
			init();
			toolUse("tu-1", "Read", { file_path: "a.ts" });
			assistant([{ type: "text", text: "done" }]);
			result("done");
			break;
		case "edit":
			init();
			toolUse("tu-1", "Write", { file_path: "edited.txt", content: "edited by the child\n" });
			fs.writeFileSync(path.join(process.cwd(), "edited.txt"), "edited by the child\n");
			result("## Changed\nedited.txt\n\n## Verification\nnpm test passed", { total_cost_usd: 0.25 });
			break;
		case "dup-tool-use":
			init();
			toolUse("tu-1", "Read", { file_path: "a.ts" });
			toolUse("tu-1", "Read", { file_path: "a.ts" });
			result("done");
			break;
		case "error":
			init();
			errorResult("error_during_execution", "boom");
			break;
		case "max-turns":
			init();
			errorResult("error_max_turns", "");
			break;
		case "api-error":
			init();
			result("rate limited", { is_error: true });
			break;
		case "result-then-hang-exit0":
			init();
			result("partial");
			setInterval(() => {}, 1000);
			break;
		case "denied":
			init();
			result("WORKFLOW_ERROR=denied", { permission_denials: [{ tool_name: "Workflow", tool_use_id: "tu-1" }] });
			break;
		case "unicode":
			init();
			result(`x${"é".repeat(100000)}`);
			break;
		case "stream":
			init();
			streamEvent({ type: "message_start", message: { id: "msg-1", model: "claude-fable-5-1", usage: {} } });
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Planning" } });
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " the change" } });
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "\nSubagent noise" } }, "tu-sub");
			await sleep(300);
			streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Running" } });
			streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " tests" } });
			await sleep(300);
			streamEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu-1", name: "Bash", input: {} } });
			toolUse("tu-1", "Bash", { command: "npm test" });
			emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] } });
			result("done");
			break;
		case "burst":
			init();
			streamEvent({ type: "message_start", message: { id: "msg-1", model: "claude-fable-5-1", usage: {} } });
			for (let i = 0; i < 200; i++) streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `word${i} ` } });
			result("done");
			break;
		case "steer": {
			init();
			toolUse("tu-1", "Read", { file_path: "a.ts" });
			const steer = await nextInput(5000);
			assistant([{ type: "text", text: `steered: ${steer ?? "nothing"}` }]);
			result(`steered: ${steer ?? "nothing"}`);
			break;
		}
		case "question":
		case "question-escape":
		case "two-questions": {
			init();
			const asked = ASKED[scenario];
			asked.forEach((question, index) => toolUse(`tu-q${index}`, "mcp__pi-fusion__ask_orchestrator", { question }));
			await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
			await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
			const tools = await mcp("tools/list", {});
			const answers = await Promise.all(asked.map((question) => mcp("tools/call", { name: "ask_orchestrator", arguments: { question } })));
			const texts = answers.map((reply) => reply?.result?.content?.[0]?.text ?? JSON.stringify(reply));
			assistant([{ type: "text", text: "answered" }]);
			result(`answered: ${texts.join(" | ")}; tools: ${tools?.result?.tools?.map((entry) => entry.name).join(",")}`);
			break;
		}
		case "question-then-steer": {
			init();
			const question = "Which name?";
			toolUse("tu-q0", "mcp__pi-fusion__ask_orchestrator", { question });
			await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
			await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
			const reply = await mcp("tools/call", { name: "ask_orchestrator", arguments: { question } });
			const answered = reply?.result?.content?.[0]?.text ?? JSON.stringify(reply);
			const steer = await nextInput(1500);
			assistant([{ type: "text", text: `answered: ${answered}` }]);
			result(`answered: ${answered}; steered: ${steer ?? "nothing"}`);
			break;
		}
		case "question-then-question": {
			init();
			toolUse("tu-q0", "mcp__pi-fusion__ask_orchestrator", { question: "First?" });
			await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
			await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
			const ask = async (question) => {
				const reply = await mcp("tools/call", { name: "ask_orchestrator", arguments: { question } });
				return reply?.result?.content?.[0]?.text ?? JSON.stringify(reply);
			};
			const first = await ask("First?");
			toolUse("tu-q1", "mcp__pi-fusion__ask_orchestrator", { question: "Second?" });
			const second = await ask("Second?");
			assistant([{ type: "text", text: "answered" }]);
			result(`answered: ${first} >> ${second}`);
			break;
		}
		case "question-then-end": {
			init();
			const question = "Which name?";
			toolUse("tu-q0", "mcp__pi-fusion__ask_orchestrator", { question });
			await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
			await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
			void mcp("tools/call", { name: "ask_orchestrator", arguments: { question } });
			await sleep(300);
			result("ended while asking");
			// The child exits by itself with its question unanswered; an open question keeps the run's input open, so EOF
			// would never come.
			process.stdin.destroy();
			break;
		}
		case "ask-user": {
			init();
			const input = {
				questions: [
					{ question: "Which store?", header: "Store", multiSelect: false, options: [{ label: "sqlite", description: "one file" }, { label: "postgres" }] },
					{ question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "lint" }, { label: "types" }] },
				],
			};
			toolUse("tu-a", "AskUserQuestion", input);
			const callbackId = initialize?.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
			const output = await control({
				subtype: "hook_callback",
				callback_id: callbackId,
				input: { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: input, tool_use_id: "tu-a", session_id: sessionId, transcript_path: "", cwd: process.cwd() },
				tool_use_id: "tu-a",
			});
			result(JSON.stringify(output.hookSpecificOutput ?? output));
			break;
		}
		case "state-plain":
			init();
			state("running");
			text("done");
			result("done");
			if (await closedEarly("before idle")) break;
			state("idle");
			await awaitEof();
			break;
		case "state-clear-idle":
			init();
			state("running");
			taskStarted("wf-1", "local_workflow");
			tasks([{ task_id: "wf-1", task_type: "local_workflow", description: "probe" }]);
			result("report first");
			if (await closedEarly("after the result, with the workflow live")) break;
			tasks([]);
			if (await closedEarly("after the clear, before idle")) break;
			state("idle");
			await awaitEof();
			break;
		case "state-bash-idle":
			init();
			state("running");
			taskStarted("b-1", "local_bash");
			tasks([{ task_id: "b-1", task_type: "local_bash", description: "build" }]);
			text("report while the build runs");
			result("report while the build runs");
			// Claude Code reports idle with a background shell still running; the shell still blocks.
			state("idle");
			if (await closedEarly("at idle, with the shell live")) break;
			tasks([]);
			if (!(await awaitEof())) break;
			followUp("b-1", "build finished after EOF");
			break;
		case "state-ambient-flip":
			init();
			state("running");
			taskStarted("m-1", "monitor_ws");
			tasks([{ task_id: "m-1", task_type: "monitor_ws", description: "journal" }]);
			result("watching");
			if (await closedEarly("with the monitor not yet ambient")) break;
			tasks([{ task_id: "m-1", task_type: "monitor_ws", description: "journal", ambient: true }]);
			state("idle");
			await awaitEof();
			break;
		case "state-stuck":
			init();
			state("running");
			taskStarted("b-1", "local_bash");
			tasks([{ task_id: "b-1", task_type: "local_bash", description: "server" }]);
			result("report while the server runs");
			state("idle");
			setInterval(() => {
				if (eof) {
					result("stdin closed early: with the server live");
					process.exit(0);
				}
			}, 50);
			break;
		case "state-clear-mid-turn":
			init();
			state("running");
			taskStarted("wf-1", "local_workflow");
			taskStarted("wf-2", "local_workflow");
			tasks([
				{ task_id: "wf-1", task_type: "local_workflow", description: "probe" },
				{ task_id: "wf-2", task_type: "local_workflow", description: "scan" },
			]);
			result("started");
			// wf-2's notification starts a turn, and wf-1 ends in the middle of it.
			tasks([{ task_id: "wf-1", task_type: "local_workflow", description: "probe" }]);
			taskEnded("wf-2");
			state("running");
			text("reading wf-2's findings");
			tasks([]);
			taskEnded("wf-1");
			if (await closedEarly("mid-turn")) break;
			toolUse("tu-2", "Read", { file_path: "a.ts" });
			emit({ type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-2", content: "ok" }] } });
			if (await closedEarly("after a tool result")) break;
			text("final");
			result("final");
			if (await closedEarly("after the final result, before idle")) break;
			state("idle");
			await awaitEof();
			break;
		case "state-steer-after-idle": {
			init();
			state("running");
			taskStarted("b-1", "local_bash");
			tasks([{ task_id: "b-1", task_type: "local_bash", description: "build" }]);
			result("first report");
			state("idle");
			const steer = await nextInput(3000);
			// An idle written before Claude Code read the steer, then the shell ending: neither is the steer's turn.
			state("idle");
			tasks([]);
			if (await closedEarly("before the steer's turn")) break;
			state("running");
			text(`steered: ${steer ?? "nothing"}`);
			result(`steered: ${steer ?? "nothing"}`);
			state("idle");
			await awaitEof();
			break;
		}
		case "state-question": {
			init();
			state("running");
			taskStarted("ag-1", "local_agent");
			tasks([{ task_id: "ag-1", task_type: "local_agent", description: "probe" }]);
			result("agent started");
			state("idle");
			await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
			await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
			// The background agent asks while the session is idle and its task then leaves the membership.
			const asking = mcp("tools/call", { name: "ask_orchestrator", arguments: { question: "Which name?" } });
			await sleep(100);
			tasks([]);
			if (await closedEarly("with the question open")) break;
			const reply = await asking;
			if (await closedEarly("after the answer, before idle")) break;
			state("running");
			const answered = reply?.result?.content?.[0]?.text ?? "nothing";
			text(`answered: ${answered}`);
			result(`answered: ${answered}`);
			state("idle");
			await awaitEof();
			break;
		}
		case "state-late-edges":
			init();
			state("running");
			// A start edge before its snapshot, and a snapshot before its start edge.
			taskStarted("a-1", "local_bash");
			tasks([{ task_id: "a-1", task_type: "local_bash", description: "a" }]);
			tasks([
				{ task_id: "a-1", task_type: "local_bash", description: "a" },
				{ task_id: "b-1", task_type: "local_bash", description: "b" },
				{ task_id: "m-1", task_type: "monitor_ws", description: "journal", ambient: true },
			]);
			taskStarted("b-1", "local_bash");
			// A start edge for an id the snapshot lists as ambient adds no blocker.
			taskStarted("m-1", "monitor_ws");
			result("report with two shells");
			state("idle");
			// a-1 ends level first; its late edges, end and then start, neither invalidate idle nor bring it back.
			tasks([{ task_id: "b-1", task_type: "local_bash", description: "b" }, { task_id: "m-1", task_type: "monitor_ws", description: "journal", ambient: true }]);
			taskEnded("a-1");
			taskStarted("a-1", "local_bash");
			taskStarted("b-1", "local_bash");
			if (await closedEarly("with b-1 live")) break;
			// b-1 ends edge first.
			taskEnded("b-1");
			if (!(await awaitEof())) break;
			tasks([{ task_id: "m-1", task_type: "monitor_ws", description: "journal", ambient: true }]);
			break;
		case "state-idle-noise":
			init();
			state("running");
			taskStarted("b-1", "local_bash");
			tasks([{ task_id: "b-1", task_type: "local_bash", description: "build" }]);
			result("report");
			state("idle");
			// A background agent's progress and frames run beside the idle session.
			emit({ type: "system", subtype: "task_progress", task_id: "ag-1", description: "probe", usage: { total_tokens: 5 } });
			emit({ type: "assistant", uuid: "asst-sub-1", session_id: sessionId, parent_tool_use_id: "tu-ag", message: { role: "assistant", content: [{ type: "text", text: "sub" }] } });
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sub" } }, "tu-ag");
			if (await closedEarly("with the shell live")) break;
			tasks([]);
			await awaitEof();
			break;
		case "state-running-stale-result":
			init();
			state("running");
			taskStarted("b-1", "local_bash");
			tasks([{ task_id: "b-1", task_type: "local_bash", description: "build" }]);
			result("old report");
			state("idle");
			// A new turn starts with no frame yet, the shell leaves, and an idle arrives before the turn's own result.
			state("running");
			tasks([]);
			state("idle");
			if (await closedEarly("on the old turn's result")) break;
			text("new report");
			result("new report");
			if (await closedEarly("after the new result, before idle")) break;
			state("idle");
			await awaitEof();
			break;
		case "nostate-drain":
			init();
			taskStarted("wf-1", "local_workflow");
			tasks([{ task_id: "wf-1", task_type: "local_workflow", description: "probe" }]);
			result("report first");
			if (await closedEarly("with the workflow live")) break;
			// The membership clears before the notification; Claude Code drains the follow-up after EOF.
			tasks([]);
			if (!(await awaitEof())) break;
			followUp("wf-1", "final after the follow-up");
			break;
		case "nostate-mid-turn":
			init();
			taskStarted("wf-1", "local_workflow");
			taskStarted("wf-2", "local_workflow");
			result("report first");
			// wf-2's notification starts a turn, and wf-1 ends in the middle of it.
			taskEnded("wf-2");
			text("reading wf-2's findings");
			taskEnded("wf-1");
			if (await closedEarly("mid-turn")) break;
			text("final");
			result("final");
			await awaitEof();
			break;
		case "nostate-steer-after-result": {
			init();
			taskStarted("wf-1", "local_workflow");
			result("first report");
			const steer = await nextInput(3000);
			taskEnded("wf-1");
			if (await closedEarly("before the steer's turn")) break;
			text(`steered: ${steer ?? "nothing"}`);
			result(`steered: ${steer ?? "nothing"}`);
			await awaitEof();
			break;
		}
		case "nostate-question": {
			init();
			taskStarted("ag-1", "local_agent");
			text("starting the agent");
			await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
			await control({ subtype: "mcp_message", server_name: "pi-fusion", message: { jsonrpc: "2.0", method: "notifications/initialized" } });
			// The agent asks, the main turn ends and the agent leaves the membership, all while the question is open; the
			// answer comes back over stdin, so EOF then would lose it.
			const asking = mcp("tools/call", { name: "ask_orchestrator", arguments: { question: "Which name?" } });
			await sleep(100);
			result("agent started");
			taskEnded("ag-1");
			if (await closedEarly("with the question open")) break;
			const reply = await asking;
			// A repeated empty membership after the answer is no evidence the turn that reads it has ended.
			tasks([]);
			if (await closedEarly("after the answer, before the turn that reads it")) break;
			const answered = reply?.result?.content?.[0]?.text ?? "nothing";
			text(`answered: ${answered}`);
			result(`answered: ${answered}`);
			await awaitEof();
			break;
		}
		case "interim-revisions":
			init();
			state("running");
			taskStarted("wf-1", "local_workflow", { workflow_name: "probe" });
			tasks([{ task_id: "wf-1", task_type: "local_workflow", description: "probe" }]);
			result("first report", { uuid: "r-1" });
			// The same result seen again is the same report, not a new revision.
			result("first report", { uuid: "r-1" });
			state("idle");
			state("running");
			text("checking");
			result("   ", { uuid: "r-2" });
			tasks([
				{ task_id: "wf-1", task_type: "local_workflow", description: "probe" },
				{ task_id: "wf-2", task_type: "local_workflow", description: "scan" },
			]);
			state("idle");
			state("running");
			text("second report");
			result("second report", { uuid: "r-3" });
			state("idle");
			tasks([{ task_id: "wf-2", task_type: "local_workflow", description: "scan" }]);
			taskEnded("wf-1");
			state("running");
			text("final");
			tasks([]);
			taskEnded("wf-2");
			result("final", { uuid: "r-4" });
			state("idle");
			await awaitEof();
			break;
		case "many-blockers":
			init();
			tasks(Array.from({ length: 25 }, (_, index) => ({ task_id: `t-${index}`, task_type: "local_bash", description: `${index} ${"x".repeat(300)}` })));
			result("many going");
			break;
		case "interim-error":
			init();
			taskStarted("wf-1", "local_workflow", { workflow_name: "probe" });
			result("rate limited", { is_error: true });
			break;
		case "slow":
			init();
			toolUse("tu-1", "Bash", { command: "npm test" });
			await sleep(1300);
			result("done");
			break;
		case "silent":
			break;
		case "no-init-exit1":
			process.stderr.write("Not logged in. Please run /login\n");
			process.exitCode = 1;
			break;
		case "exit1":
			init();
			process.stderr.write("Warning: something minor\n");
			process.stderr.write("Not logged in. Please run /login\n");
			process.exitCode = 1;
			break;
		case "selfkill":
			init();
			process.kill(process.pid, "SIGKILL");
			break;
		case "hang":
		case "hang-ignore-term":
			init();
			toolUse("tu-1", "Read", { file_path: "a.ts" });
			setInterval(() => {}, 1000);
			break;
		case "hang-grandchild": {
			const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
				detached: true,
				stdio: "ignore",
			});
			grandchild.unref();
			fs.writeFileSync(process.env.FAKE_CLAUDE_GRANDCHILD_PID_FILE, String(grandchild.pid));
			init();
			toolUse("tu-1", "Read", { file_path: "a.ts" });
			setInterval(() => {}, 1000);
			break;
		}
		default:
			process.stderr.write(`unknown scenario ${scenario}\n`);
			process.exitCode = 3;
	}
}
