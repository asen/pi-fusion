#!/usr/bin/env node
/**
 * Manual, no-inference check of what Fusion profiles rely on in the installed Pi SDK: that registering a tool again
 * under its own name replaces its definition and rebuilds the host's system prompt, that a registry refresh under a
 * `--tools` allow list puts every allowed tool back on the active list, and that Fusion's own restore of the active
 * list keeps /fusion off's hidden tools hidden through a profile change. It is outside `test/*.test.ts` and `npm test`,
 * and is run by hand: `node test/spikes/pi-profile-guidance.mjs`.
 *
 * What it builds: one throwaway agent directory and home under a temporary root, an in-memory settings manager and
 * session manager, and a real `AgentSession` with this extension passed in as an inline factory over an in-memory
 * profile store. What it never does: send a prompt to a model, start a child, configure a provider or credential, or
 * make a network request — every `session.prompt()` here is a `/fusion` slash command, which the SDK hands to the
 * extension's command handler without an agent turn. The host's system prompt is read straight off the session, so a
 * host-level system prompt override is not in play: nothing here sets one.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-profile-guidance-")));
const agentDir = path.join(root, "agent");
const home = path.join(root, "home");
const project = path.join(root, "project");
for (const dir of [agentDir, home, project]) fs.mkdirSync(dir, { recursive: true });
// Nothing the SDK resolves may land in the user's own directories, and no provider may be reachable by name.
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
for (const name of Object.keys(process.env)) if (/_API_KEY$|^PI_FUSION_/.test(name)) delete process.env[name];

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { default: fusion } = await import(path.join(repoRoot, "extensions", "fusion.ts"));
const { memoryProfileStore } = await import(path.join(repoRoot, "extensions", "profile-store.ts"));
const { builtinSettings, captureBaseline, serializeDocument } = await import(path.join(repoRoot, "extensions", "profiles.ts"));

const legacy = builtinSettings(captureBaseline({}));
const work = { ...legacy, implement: { enabled: true, backend: "claude", model: "sonnet", effort: "low" }, ultracode: { enabled: false, backend: "claude" } };
const other = { ...legacy, ask: { enabled: false, backend: "claude" } };

const results = [];
const check = async (name, body) => {
	try {
		await body();
		results.push({ name, ok: true });
		console.log(`ok   ${name}`);
	} catch (error) {
		results.push({ name, ok: false });
		console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message.split("\n").join("\n     ") : String(error)}`);
	}
};

/** One real session with the extension loaded, under the allow list given, its session_start already emitted. */
async function session(tools) {
	const settingsManager = SettingsManager.inMemory();
	const profiles = memoryProfileStore(serializeDocument({ version: 1, defaultProfile: null, profiles: { work, other } }));
	const resourceLoader = new DefaultResourceLoader({
		cwd: project,
		agentDir,
		settingsManager,
		extensionFactories: [{ name: "pi-fusion", factory: (pi) => fusion(pi, { profiles }) }],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session: created } = await createAgentSession({
		cwd: project,
		agentDir,
		settingsManager,
		sessionManager: SessionManager.inMemory(project),
		resourceLoader,
		...(tools ? { tools } : {}),
	});
	const notices = [];
	await created.bindExtensions({ mode: "print", uiContext: { notify: (text, level) => notices.push([text, level]), setStatus() {}, setWidget() {} } });
	return { session: created, notices };
}

const command = async (held, text) => {
	await held.session.prompt(text);
	return held.notices.at(-1)?.[0];
};

await check("a profile applied by command rebuilds the host's system prompt with the new guidance, with no model turn", async () => {
	const held = await session();
	const before = held.session.systemPrompt;
	assert.match(before, /Use fusion with role ultracode only when the user explicitly asks/, "the built-in guidance recommends ultracode");
	assert.equal(await command(held, "/fusion profile use work"), "fusion uses profile work in this session; disabled: ultracode");
	const after = held.session.systemPrompt;
	assert.notEqual(after, before);
	assert.doesNotMatch(after, /Use fusion with role ultracode only when the user explicitly asks/, "a disabled role is no longer recommended");
	assert.match(after, /This session's configuration disables role ultracode/);
	const fusionTool = held.session.getAllTools?.().find((tool) => tool.name === "fusion");
	if (fusionTool) assert.match(fusionTool.description, /implement runs on claude with model sonnet at effort low/);
	assert.deepEqual(held.session.messages.filter((message) => message.role === "assistant"), [], "no assistant turn ran");
});

await check("under a --tools allow list, a re-registration keeps the active list exactly as it was", async () => {
	const allowed = ["read", "bash", "write", "fusion", "fusion_control", "claude", "claude_control"];
	const held = await session(allowed);
	held.session.setActiveToolsByName(held.session.getActiveToolNames().filter((name) => name !== "write"));
	const before = held.session.getActiveToolNames();
	assert.ok(!before.includes("write"));
	await command(held, "/fusion profile use work");
	assert.deepEqual(held.session.getActiveToolNames(), before, "the allow list's write tool stayed off");
});

await check("the SDK itself re-adds allowed tools on a refresh, which is why Fusion restores the list (control)", async () => {
	const allowed = ["read", "bash", "write", "fusion", "fusion_control", "claude", "claude_control"];
	const held = await session(allowed);
	held.session.setActiveToolsByName(["read"]);
	// A refresh the SDK runs for any reason other than Fusion's own re-registration, with no restore after it.
	held.session._refreshToolRegistry?.();
	assert.ok(held.session.getActiveToolNames().includes("write"), `the refresh did not re-add the allowed tools: ${held.session.getActiveToolNames().join(", ")}`);
});

await check("while fusion is off, a profile change leaves the fusion tools hidden under an allow list, and on gives them back", async () => {
	const held = await session(["read", "bash", "fusion", "fusion_control", "claude", "claude_control"]);
	const on = held.session.getActiveToolNames();
	assert.equal(await command(held, "/fusion off"), "fusion is off; no run can start until /fusion on");
	assert.deepEqual(held.session.getActiveToolNames(), ["read", "bash"]);
	await command(held, "/fusion profile use other");
	assert.deepEqual(held.session.getActiveToolNames(), ["read", "bash"], "no fusion tool came back");
	assert.doesNotMatch(held.session.systemPrompt, /\bfusion_control\b/, "and the prompt names none of them");
	await command(held, "/fusion on");
	assert.deepEqual([...held.session.getActiveToolNames()].sort(), [...on].sort());
	assert.match(held.session.systemPrompt, /disables role ask/, "and the prompt carries the profile applied while off");
});

fs.rmSync(root, { recursive: true, force: true });
const failed = results.filter((result) => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
