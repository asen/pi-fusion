import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type PiRole, piModelVariable, piRole } from "../extensions/backends/pi-binding.ts";
import type { Backend, ChildControl, ChildRun, HostBackend, PiSessionRef, ResolvedSelection, SessionIntent } from "../extensions/backends/types.ts";
import { hostBackend } from "../extensions/backends/types.ts";
import fusion, { claudeCall, claudeRoute, type FusionParams, fusionCall, fusionRoute, ROLE_NAMES, roleFor, type RunRecords, runRecords } from "../extensions/fusion.ts";
import { KNOWN_ROLE_NAMES, roleSpec } from "../extensions/roles.ts";
import { History } from "../extensions/history.ts";
import { memoryProfileStore } from "../extensions/profile-store.ts";
import { PI_SELECTION_VARIABLES, piTripwire, productionDefaults } from "./tripwire.ts";
import { toolList, turnOn } from "./host-tools.ts";

const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.PI_FUSION_CLAUDE_BIN = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.FAKE_CLAUDE_SCENARIO = "ok";
process.env.PI_FUSION_DASHBOARD_OPEN = "0";

const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });

const PI_REF: PiSessionRef = { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-9" };
const PI_SELECTION: ResolvedSelection = { model: "deepseek/deepseek-chat", effort: "medium" };

const piEntry = (data: Record<string, unknown> = {}) => ({
	run: "run-1",
	role: "implement",
	backend: "pi",
	hostSessionId: "host-1",
	session: { ...PI_REF },
	selection: { ...PI_SELECTION },
	...data,
});

const claudeEntry = (data: Record<string, unknown> = {}) => ({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", ...data });

const records = (...entries: Array<Record<string, unknown>>): RunRecords => runRecords(entries.map(entry));

/** The environment a Pi role reads, so a binding test never depends on what this process has set. */
const piEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PI_FUSION_PI_IMPLEMENT_MODEL: "deepseek/deepseek-chat", ...over }) as NodeJS.ProcessEnv;

test("a new call without a backend goes to the sole backend its role runs on, else to claude", () => {
	for (const role of ["plan", "implement", "ask"]) {
		const route = fusionRoute({ role, task: "x" }, records());
		assert.equal(route.backend, "claude", `role ${role} is supported by both backends, so it stays on claude`);
		assert.equal(route.handle, "run-1");
	}
	assert.equal(fusionRoute({ role: "ultracode", task: "x" }, records()).backend, "claude");
});

test("an explicit backend must run the role, and an unknown one names the backends this build knows", () => {
	assert.equal(fusionRoute({ role: "implement", task: "x", backend: "pi" }, records()).backend, "pi");
	assert.equal(fusionRoute({ role: "implement", task: "x", backend: "claude" }, records()).backend, "claude");
	assert.throws(() => fusionRoute({ role: "ultracode", task: "x", backend: "pi" }, records()), /^Error: role ultracode does not run on the pi backend; use one of claude$/);
	assert.throws(() => fusionRoute({ role: "implement", task: "x", backend: "elsewhere" }, records()), /^Error: unknown backend elsewhere; use one of claude, pi$/);
});

test("the security role runs on pi alone: a call with no backend goes there, claude is refused and a record continues there", () => {
	// Pi is the sole backend the role runs on, so a call that names no backend goes there rather than to the default one.
	const fresh = fusionRoute({ role: "security", task: "audit the token check" }, records());
	assert.deepEqual([fresh.backend, fresh.role, fresh.handle], ["pi", "security", "run-1"]);
	assert.equal(fusionRoute({ role: "security", task: "x", backend: "pi" }, records()).backend, "pi");
	assert.throws(() => fusionRoute({ role: "security", task: "x", backend: "claude" }, records()), /^Error: role security does not run on the claude backend; use one of pi$/);
	// The compatibility tool advertises four roles and this is not one of them, so its own list refuses it by name
	// rather than by a capability that tool never advertised.
	assert.throws(() => claudeRoute({ role: "security", task: "x" }, records()), /^Error: unknown role security; use one of plan, implement, ultracode, ask$/);
	assert.throws(() => claudeCall({ role: "security", task: "x" }, records()), /^Error: unknown role security; use one of plan, implement, ultracode, ask$/);
	// A security record on the branch is continued on the backend it ran on, with the selection that run ran with.
	const branch = records({ run: "run-1", role: "security", backend: "pi", hostSessionId: "host-1", session: { ...PI_REF }, selection: { ...PI_SELECTION } });
	const continued = fusionCall({ continue: "run-1", task: "and the refresh path?" }, branch);
	assert.deepEqual(
		[continued.backend, continued.handle, continued.bound.name, continued.bound.model, continued.bound.contract],
		["pi", "run-1", "security", "deepseek/deepseek-chat", "security.md"],
	);
	// The whole selection the run ran with is what its binding repeats, the thinking level included.
	assert.deepEqual(piRole(continued.call, continued.record?.selection, piEnv()), { name: "security", model: "deepseek/deepseek-chat", effort: "medium", contract: "security.md", ...PI_CODING_METADATA });
	assert.equal(fusionRoute({ continue: "run-1", task: "x", backend: "pi" }, branch).backend, "pi");
	assert.throws(() => fusionRoute({ continue: "run-1", task: "x", backend: "claude" }, branch), /^Error: run-1 ran on the pi backend; omit backend or use pi$/);
	// A role nothing knows is refused by the roles there are, which is every role a record may name.
	assert.throws(() => fusionRoute({ role: "audit", task: "x" } as FusionParams, records()), /^Error: unknown role audit; use one of plan, implement, ultracode, ask, security$/);
});

test("the pi security binding runs implement's tools under its own contract, and takes a model and a level and nothing else", () => {
	const env = piEnv({ PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat", PI_FUSION_PI_SECURITY_EFFORT: "xhigh" });
	assert.deepEqual(piRole({ role: "security" }, undefined, env), { name: "security", model: "deepseek/deepseek-chat", effort: "xhigh", contract: "security.md", ...PI_CODING_METADATA });
	// The call's own selection and the recorded one win in the same order as every other pi role's.
	assert.deepEqual(piRole({ role: "security" }, { model: "openai/gpt-5", effort: "low" }, env), { name: "security", model: "openai/gpt-5", effort: "low", contract: "security.md", ...PI_CODING_METADATA });
	assert.equal(piRole({ role: "security", model: "openai/gpt-5", effort: "max" }, { model: "deepseek/deepseek-chat", effort: "low" }, env).model, "openai/gpt-5");
	// A security run is not an ask run and not a plan run: it has no mode to be in and no plan to start fresh from.
	assert.throws(() => piRole({ role: "security", mode: "review" }, undefined, env), /^Error: mode is not allowed for role security$/);
	assert.throws(() => piRole({ role: "security", fresh: true }, undefined, env), /^Error: fresh is not allowed for role security$/);
	assert.equal(piModelVariable("security"), "PI_FUSION_PI_SECURITY_MODEL");
	assert.throws(
		() => piRole({ role: "security" }, undefined, piEnv()),
		/^Error: role security has no model for the pi backend: set PI_FUSION_PI_SECURITY_MODEL to a provider and a model id, such as deepseek\/deepseek-chat, or name one in the call's model parameter\. The pi backend has no default model and resolves none for you$/,
	);
	assert.ok(fs.existsSync(path.join(repoRoot, "contracts", "security.md")), "the pi security binding names a contract that is not there");
});

test("a continued run stays on the backend its record names, and an explicit conflict is refused", () => {
	const pi = records(piEntry());
	assert.equal(fusionRoute({ continue: "run-1", task: "more" }, pi).backend, "pi");
	assert.equal(fusionRoute({ continue: "run-1", task: "more", backend: "pi" }, pi).backend, "pi");
	assert.throws(() => fusionRoute({ continue: "run-1", task: "more", backend: "claude" }, pi), /^Error: run-1 ran on the pi backend; omit backend or use pi$/);
	const claude = records(claudeEntry());
	assert.equal(fusionRoute({ continue: "run-1", task: "more" }, claude).backend, "claude");
	assert.throws(() => fusionRoute({ continue: "run-1", task: "more", backend: "pi" }, claude), /^Error: run-1 ran on the claude backend; omit backend or use claude$/);
});

test("a record this host will not act on fails the call before anything is bound, weighed or started", () => {
	const unknownTag = records({ run: "run-1", role: "implement", backend: "elsewhere", hostSessionId: "host-1", sessionId: "s-1" });
	assert.throws(() => fusionRoute({ continue: "run-1", task: "more" }, unknownTag), /^Error: run-1 was recorded by backend "elsewhere", which this pi-fusion does not know/);
	const { checkpoint, ...noCheckpoint } = PI_REF;
	const untrusted = records(piEntry({ session: noCheckpoint }));
	assert.throws(() => fusionRoute({ continue: "run-1", task: "more" }, untrusted), /^Error: run-1 ran on pi and recorded no trusted checkpoint/);
});

test("the latest plan run a call continues is its own backend's, and a refused one stops the call", () => {
	const both = records(
		{ run: "run-1", role: "plan", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" },
		piEntry({ run: "run-2", role: "plan" }),
	);
	const onClaude = fusionRoute({ role: "plan", task: "follow-up" }, both);
	assert.deepEqual([onClaude.backend, onClaude.handle], ["claude", "run-1"]);
	const onPi = fusionRoute({ role: "plan", task: "follow-up", backend: "pi" }, both);
	assert.deepEqual([onPi.backend, onPi.handle], ["pi", "run-2"]);
	assert.equal(onPi.record?.handle, "run-2");
	// fresh takes the next handle on the backend the call routes to, and never the other backend's plan run.
	assert.deepEqual(fusionRoute({ role: "plan", task: "new topic", fresh: true, backend: "pi" }, both).handle, "run-3");

	const refused = records(
		{ run: "run-1", role: "plan", backend: "pi", hostSessionId: "host-1", session: { ...PI_REF } },
		piEntry({ run: "run-2", role: "plan", session: { backend: "pi", sessionId: "pi-2", sessionFile: "/sessions/pi-2.jsonl" } }),
	);
	// The refused record is still pi's latest plan: the call fails rather than walking back to run-1 or starting fresh.
	assert.throws(() => fusionRoute({ role: "plan", task: "follow-up", backend: "pi" }, refused), /^Error: run-2 ran on pi and recorded no trusted checkpoint/);
	assert.equal(fusionRoute({ role: "plan", task: "follow-up", backend: "pi", fresh: true }, refused).handle, "run-3");

	const earlyFailure = records(piEntry({ role: "plan" }), { run: "run-2", role: "plan", backend: "pi", hostSessionId: "host-1" });
	assert.throws(() => fusionRoute({ role: "plan", task: "follow-up", backend: "pi" }, earlyFailure), /^Error: run-2 ran on pi and recorded no verified session/);
	assert.throws(() => fusionRoute({ role: "plan", task: "another model", backend: "pi", model: "openai/gpt-5" }, earlyFailure), /^Error: run-2 ran on pi and recorded no verified session/, "changing models does not bypass the refusal or return to run-1");
	assert.equal(fusionRoute({ role: "plan", task: "retry", backend: "pi", fresh: true }, earlyFailure).handle, "run-3");
});

test("a plan handoff stays on the backend the plan run is on", () => {
	const over = records(piEntry({ run: "run-1", role: "plan", contextTokens: 400_000, contextWindow: 1_000_000 }));
	const route = fusionRoute({ role: "plan", task: "next", backend: "pi" }, over, 35);
	assert.equal(route.backend, "pi");
	assert.equal(route.handle, "run-2");
	assert.deepEqual(route.handoff, { from: "run-1", reason: { kind: "cap", share: 0.4 } });
	// The claude route sees no plan run of its own, so it starts one rather than handing off the pi run.
	const onClaude = fusionRoute({ role: "plan", task: "next" }, over, 35);
	assert.deepEqual([onClaude.handle, onClaude.handoff], ["run-2", undefined]);
});

/**
 * What each backend can say the last plan run is on, which is what a model handoff is decided against: Claude keeps
 * the chosen model flat on the entry and falls back to the role's own default, while a Pi run is only ever on the
 * selection it recorded. Neither backend resolves the other's model, so each one's answer is read here.
 */
test("a plan call that names another model hands the plan off on the backend the plan run is on", () => {
	const chosen = records(claudeEntry({ run: "run-1", role: "plan", model: "opus" }));
	const handed = fusionRoute({ role: "plan", task: "harder than it looked", model: "fable" }, chosen);
	assert.deepEqual([handed.backend, handed.handle, handed.record], ["claude", "run-2", undefined]);
	assert.deepEqual(handed.handoff, { from: "run-1", reason: { kind: "model", from: "opus", to: "fable" } });
	assert.equal(handed.call.model, "fable", "the fresh run runs the model the call named");
	// A plan run that chose nothing ran the role's own default, which is the model a handoff is named after.
	const byDefault = fusionRoute({ role: "plan", task: "a bounded question", model: "opus" }, records(claudeEntry({ run: "run-1", role: "plan" })));
	assert.deepEqual(byDefault.handoff, { from: "run-1", reason: { kind: "model", from: "fable", to: "opus" } });

	// A pi plan run's model is the selection it recorded, and nothing falls back to a default this backend has none of.
	const pi = records(piEntry({ run: "run-1", role: "plan" }));
	const onPi = fusionRoute({ role: "plan", task: "harder than it looked", backend: "pi", model: "openai/gpt-5" }, pi);
	assert.deepEqual([onPi.backend, onPi.handle], ["pi", "run-2"]);
	assert.deepEqual(onPi.handoff, { from: "run-1", reason: { kind: "model", from: "deepseek/deepseek-chat", to: "openai/gpt-5" } });
	assert.equal(onPi.call.model, "openai/gpt-5");
});

test("a plan call that names the model the plan run is on continues it, on either backend", () => {
	const chosen = records(claudeEntry({ run: "run-1", role: "plan", model: "opus" }));
	const same = fusionRoute({ role: "plan", task: "and the next step?", model: "opus" }, chosen);
	assert.deepEqual([same.handle, same.handoff, same.call.model], ["run-1", undefined, "opus"]);
	// The run keeps its own model when the call names none: a plan call never silently drops back to the default, and
	// the model it keeps is the route's default beneath the call rather than something written into the call.
	const unnamed = fusionRoute({ role: "plan", task: "and the next step?" }, chosen);
	assert.deepEqual([unnamed.handle, unnamed.handoff, unnamed.call.model, unnamed.defaults.model], ["run-1", undefined, undefined, "opus"]);
	assert.equal(fusionCall({ role: "plan", task: "and the next step?" }, chosen).bound.model, "opus");
	// A plan run on the role's own default is continued by a call that names that same default.
	const byDefault = records(claudeEntry({ run: "run-1", role: "plan" }));
	assert.deepEqual([fusionRoute({ role: "plan", task: "more", model: "fable" }, byDefault).handle, fusionRoute({ role: "plan", task: "more" }, byDefault).handle], ["run-1", "run-1"]);

	const pi = records(piEntry({ run: "run-1", role: "plan" }));
	const onPi = fusionRoute({ role: "plan", task: "and the next step?", backend: "pi", model: "deepseek/deepseek-chat" }, pi);
	assert.deepEqual([onPi.handle, onPi.handoff], ["run-1", undefined]);
});

/**
 * A cap handoff keeps the planner's model on both backends, because that model is the run's and not the call's. Its
 * effort is the call's or the role's default on Claude, as it always was; on Pi the recorded level goes with the
 * recorded model, because a level chosen for another model may be one this model does not offer.
 */
test("a cap handoff carries the plan run's model on either backend, and on pi the level it ran at too", () => {
	const full = { contextTokens: 400_000, contextWindow: 1_000_000 };
	const sonnet = records(claudeEntry({ run: "run-1", role: "plan", model: "sonnet", effort: "low", ...full }));
	const claude = fusionRoute({ role: "plan", task: "next" }, sonnet, 35);
	assert.deepEqual(claude.handoff, { from: "run-1", reason: { kind: "cap", share: 0.4 } });
	assert.deepEqual([claude.handle, claude.call.model], ["run-2", undefined], "nothing is written into the call");
	const bound = fusionCall({ role: "plan", task: "next" }, sonnet, 35).bound as { model: string; effort?: string };
	assert.deepEqual([bound.model, bound.effort], ["sonnet", "xhigh"], "the planner's model, at the role's own effort rather than the old run's");
	assert.equal((fusionCall({ role: "plan", task: "next", effort: "max" }, sonnet, 35).bound as { effort?: string }).effort, "max", "an effort the call names wins");
	// A deliberately fresh plan takes the defaults, not the planner's model.
	assert.equal(fusionCall({ role: "plan", task: "next", fresh: true }, sonnet, 35).bound.model, "fable");

	const pi = fusionCall({ role: "plan", task: "next", backend: "pi" }, records(piEntry({ run: "run-1", role: "plan", ...full })), 35);
	assert.deepEqual(pi.handoff, { from: "run-1", reason: { kind: "cap", share: 0.4 } });
	assert.equal(pi.record, undefined, "a cap handoff carries no record: it is a fresh run");
	assert.deepEqual({ model: pi.bound.model, effort: (pi.bound as PiRole).effort }, PI_SELECTION, "the model and the level the plan run recorded, together");
	const level = fusionCall({ role: "plan", task: "next", backend: "pi", effort: "low" }, records(piEntry({ run: "run-1", role: "plan", ...full })), 35);
	assert.deepEqual({ model: level.bound.model, effort: (level.bound as PiRole).effort }, { model: PI_SELECTION.model, effort: "low" }, "an effort the call names wins on pi too");
});

test("a continued claude run keeps the model it recorded, and a continued pi run keeps its recorded selection", () => {
	const kept = fusionRoute({ continue: "run-1", task: "and the tests?" }, records(claudeEntry({ model: "sonnet" })));
	assert.deepEqual([kept.backend, kept.call.model, kept.defaults.model], ["claude", undefined, "sonnet"]);
	assert.equal(fusionCall({ continue: "run-1", task: "and the tests?" }, records(claudeEntry({ model: "sonnet" }))).bound.model, "sonnet");
	// The call's own model wins over the recorded one, and a run that recorded none keeps the role's default.
	assert.equal(fusionRoute({ continue: "run-1", task: "more", model: "opus" }, records(claudeEntry({ model: "sonnet" }))).call.model, "opus");
	assert.equal(fusionCall({ continue: "run-1", task: "more" }, records(claudeEntry())).bound.model, "opus");
	// Nothing puts a model on a pi continuation's call: the recorded selection is the binding's to repeat.
	const onPi = fusionRoute({ continue: "run-1", task: "and the tests?" }, records(piEntry()));
	assert.deepEqual([onPi.backend, onPi.call.model, onPi.record?.selection], ["pi", undefined, PI_SELECTION]);
});

test("the claude route forces its backend and never continues or reuses a pi run", () => {
	const pi = records(piEntry(), piEntry({ run: "run-2", role: "plan" }));
	assert.throws(() => claudeRoute({ continue: "run-1", task: "more" }, pi), /^Error: run-1 ran on the pi backend, which the claude tool does not run; continue it with fusion and continue run-1$/);
	// A pi plan run is not the claude route's latest plan, so an implicit plan call starts a claude run of its own.
	const fresh = claudeRoute({ role: "plan", task: "goal" }, pi);
	assert.deepEqual([fresh.backend, fresh.handle, fresh.record], ["claude", "run-3", undefined]);
});

test("the legacy claude call still returns the Claude role it always did", () => {
	const call = claudeCall({ role: "implement", task: "x", model: "sonnet", effort: "max" }, records());
	assert.deepEqual(call.role, {
		name: "implement",
		model: "sonnet",
		effort: "max",
		tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
		permissionMode: "bypassPermissions",
		contract: "implement.md",
	});
	assert.equal(call.handle, "run-1");
	const continued = claudeCall({ continue: "run-1", task: "more" }, records(claudeEntry()));
	assert.deepEqual([continued.handle, continued.record?.backend, continued.role.model], ["run-1", "claude", "opus"]);
	assert.throws(() => claudeCall({ continue: "run-1", task: "more" }, records(piEntry())), /continue it with fusion and continue run-1/);
});

test("each backend checks the parameters its role takes, and rejects an effort the other one offers", () => {
	assert.throws(() => fusionRoute({ role: "implement", task: "x", effort: "off" }, records()), /^Error: unknown effort off; use one of low, medium, high, xhigh, max$/);
	assert.throws(() => fusionRoute({ role: "implement", task: "x", effort: "minimal", backend: "claude" }, records()), /^Error: unknown effort minimal; use one of low, medium, high, xhigh, max$/);
	// Role plan takes a model on both backends now; role ultracode still takes none, on the one backend that runs it.
	assert.equal(fusionRoute({ role: "plan", task: "x", model: "opus" }, records()).call.model, "opus");
	assert.throws(() => fusionRoute({ role: "ultracode", task: "x", model: "fable" }, records()), /^Error: model is not allowed for role ultracode$/);
	assert.throws(() => fusionRoute({ role: "implement", task: "x", fresh: true, backend: "pi" }, records()), /^Error: fresh is not allowed for role implement$/);
	assert.throws(() => fusionRoute({ role: "implement", task: "x", mode: "review", backend: "pi" }, records()), /^Error: mode is not allowed for role implement$/);
	// Pi takes a model for every role it runs, and Pi's own thinking levels for each of them.
	const route = fusionRoute({ role: "plan", task: "x", model: "deepseek/deepseek-chat", effort: "off", backend: "pi" }, records());
	assert.deepEqual([route.backend, route.role], ["pi", "plan"]);
});

test("a fusion call binds the role its backend owns: claude keeps its defaults, pi resolves its own selection", () => {
	const claude = fusionCall({ role: "implement", task: "x" }, records());
	assert.equal(claude.bound.name, "implement");
	assert.equal(claude.bound.model, "opus", "the claude binding keeps the role defaults it has always had");
	assert.equal(claude.bound.contract, "implement.md");
	process.env.PI_FUSION_PI_IMPLEMENT_MODEL = "deepseek/deepseek-chat";
	try {
		const pi = fusionCall({ role: "implement", task: "x", backend: "pi" }, records());
		assert.deepEqual({ name: pi.bound.name, model: pi.bound.model, contract: pi.bound.contract }, { name: "implement", model: "deepseek/deepseek-chat", contract: "implement.md" });
		assert.equal((pi.bound as PiRole).effort, undefined, "an initial pi call that names no level leaves the child its own default");
		// A continuation repeats the selection the run actually ran with, not whatever is configured now.
		process.env.PI_FUSION_PI_IMPLEMENT_MODEL = "deepseek/deepseek-reasoner";
		const continued = fusionCall({ continue: "run-1", task: "more" }, records(piEntry()));
		assert.deepEqual({ model: continued.bound.model, effort: (continued.bound as PiRole).effort }, PI_SELECTION);
	} finally {
		delete process.env.PI_FUSION_PI_IMPLEMENT_MODEL;
	}
});

/**
 * The tools and the empty resource lists every pi role carries, so a selection assertion stays about the selection.
 * Which role gets which list is `test/pi-bootstrap.test.ts`'s, against the binding itself.
 */
const PI_CODING_METADATA = { tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], extensions: [], skills: [] };
const PI_ASK_METADATA = { tools: ["read", "bash", "grep", "find", "ls"], extensions: [], skills: [] };

test("a pi role takes its model from the call, then the recorded selection, then its own variable", () => {
	const recorded: ResolvedSelection = { model: "deepseek/deepseek-chat", effort: "medium" };
	const env = piEnv({ PI_FUSION_PI_IMPLEMENT_MODEL: "openrouter/deepseek/deepseek-chat", PI_FUSION_PI_IMPLEMENT_EFFORT: "high" });
	assert.deepEqual(piRole({ role: "implement" }, undefined, env), { name: "implement", model: "openrouter/deepseek/deepseek-chat", effort: "high", contract: "implement.md", ...PI_CODING_METADATA });
	assert.deepEqual(piRole({ role: "implement" }, recorded, env), { name: "implement", model: "deepseek/deepseek-chat", effort: "medium", contract: "implement.md", ...PI_CODING_METADATA }, "the recorded selection wins over a variable that has changed");
	assert.deepEqual(piRole({ role: "implement", model: "openai/gpt-5", effort: "max" }, recorded, env), { name: "implement", model: "openai/gpt-5", effort: "max", contract: "implement.md", ...PI_CODING_METADATA });
	// A call that overrides the model alone keeps the effort the run actually ran with, not the variable's.
	assert.deepEqual(piRole({ role: "implement", model: "openai/gpt-5" }, recorded, env).effort, "medium");
	assert.deepEqual(piRole({ role: "implement", effort: "low" }, recorded, env).model, "deepseek/deepseek-chat");
});

test("a pi role has no default model and no default level, and says which setting is missing", () => {
	assert.throws(
		() => piRole({ role: "implement" }, undefined, {} as NodeJS.ProcessEnv),
		/^Error: role implement has no model for the pi backend: set PI_FUSION_PI_IMPLEMENT_MODEL to a provider and a model id, such as deepseek\/deepseek-chat, or name one in the call's model parameter\. The pi backend has no default model and resolves none for you$/,
	);
	assert.equal(piModelVariable("ask"), "PI_FUSION_PI_ASK_MODEL");
	// An initial call with no level at all leaves the level to the child, which reports back what it ran with.
	const initial = piRole({ role: "ask" }, undefined, { PI_FUSION_PI_ASK_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv);
	assert.deepEqual(initial, { name: "ask", model: "deepseek/deepseek-chat", contract: "ask-answer.md", mode: "answer", ...PI_ASK_METADATA });
	assert.equal(piRole({ role: "ask", mode: "review" }, undefined, { PI_FUSION_PI_ASK_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv).contract, "ask-review.md");
});

test("a pi model is a provider and a model id, whatever slashes the id itself carries", () => {
	const env = {} as NodeJS.ProcessEnv;
	for (const model of ["deepseek/deepseek-chat", "openrouter/deepseek/deepseek-chat", "openrouter/a/b/c"]) {
		assert.equal(piRole({ role: "implement", model }, undefined, env).model, model);
	}
	for (const model of ["deepseek-chat", "/deepseek-chat", "deepseek/", " / "]) {
		assert.throws(() => piRole({ role: "implement", model }, undefined, env), /which is not a pi provider and model id/, model);
	}
	assert.throws(() => piRole({ role: "implement" }, undefined, piEnv({ PI_FUSION_PI_IMPLEMENT_MODEL: "deepseek-chat" })), /^Error: PI_FUSION_PI_IMPLEMENT_MODEL names model "deepseek-chat", which is not a pi provider and model id/);
	assert.throws(() => piRole({ role: "implement", effort: "ultracode" }, undefined, piEnv()), /^Error: the call names effort "ultracode", which is not a pi thinking level; use one of off, minimal, low, medium, high, xhigh, max$/);
	assert.throws(() => piRole({ role: "ultracode" }, undefined, piEnv()), /^Error: role ultracode does not run on the pi backend; use one of plan, implement, ask, security$/);
});

test("a continued pi ask run keeps its recorded mode unless the call names another", () => {
	const env = { PI_FUSION_PI_ASK_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv;
	process.env.PI_FUSION_PI_ASK_MODEL = env.PI_FUSION_PI_ASK_MODEL;
	try {
		const branch = records(piEntry({ role: "ask", mode: "review" }));
		const kept = fusionCall({ continue: "run-1", task: "and the tests?" }, branch);
		assert.deepEqual([kept.backend, kept.bound.contract, kept.bound.mode], ["pi", "ask-review.md", "review"]);
		const changed = fusionCall({ continue: "run-1", task: "why this design?", mode: "answer" }, branch);
		assert.deepEqual([changed.bound.contract, changed.bound.mode], ["ask-answer.md", "answer"]);
		// The mode a record carries belongs to ask alone, on either backend.
		assert.throws(() => fusionRoute({ continue: "run-1", task: "x", mode: "fix" }, branch), /^Error: unknown mode fix; use one of answer, review$/);
	} finally {
		delete process.env.PI_FUSION_PI_ASK_MODEL;
	}
});

/** A Pi session request as a backend of its own would make one: the host only reads it, and never builds one itself. */
interface StubSession {
	kind: "new" | "resume" | "fork";
	id?: string;
	from?: string;
	at?: string;
	file?: string;
}

interface Started {
	role: PiRole;
	prompt: string;
	session?: StubSession;
}

/** A backend injected in place of Pi: it settles at once, reports a session and a selection, and starts no process. */
interface StubOutcome {
	/** A scalar session id the child reports as a diagnostic, which is never an identity on Pi. */
	sessionId?: string;
	/** False for a run that ended before it verified a session reference, which is what a failure before settle is. */
	verified?: boolean;
	fail?: boolean;
}

function stubBackend(outcome: StubOutcome = {}): { backend: HostBackend; started: Started[] } {
	const started: Started[] = [];
	const control = (): ChildControl => ({ open: true, push: () => true, end: () => {} });
	const backend: Backend<PiRole, StubSession, ChildControl> = {
		name: "pi",
		control,
		session: (intent: SessionIntent): StubSession => {
			if (intent.kind === "new") return { kind: "new" };
			const ref = intent.kind === "resume" ? intent.ref : intent.from;
			if (ref.backend !== "pi") throw new Error(`${ref.backend} session ${ref.sessionId} cannot be continued by the pi backend`);
			const at = ref.checkpoint ? { at: ref.checkpoint } : {};
			if (intent.kind === "resume") return { kind: "resume", id: ref.sessionId, file: ref.sessionFile, ...at };
			return { kind: "fork", from: ref.sessionId, file: ref.sessionFile, ...at };
		},
		run: async (request): Promise<ChildRun<PiRole>> => {
			started.push({ role: request.role, prompt: request.prompt, ...(request.session === undefined ? {} : { session: request.session }) });
			const session: PiSessionRef = { backend: "pi", sessionId: request.session?.id ?? "pi-new", sessionFile: request.session?.file ?? "/sessions/pi-new.jsonl", checkpoint: "entry-42" };
			const child: ChildRun<PiRole> = {
				role: request.role,
				text: "## Changed\nfoo.ts",
				toolCalls: 1,
				tokensIn: 10,
				tokensOut: 5,
				cacheRead: 0,
				cacheWrite: 0,
				...(outcome.verified === false ? {} : { session }),
				...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
				selection: { model: request.role.model, effort: request.role.effort ?? "medium" },
				ms: 1,
				exitCode: outcome.fail ? 1 : 0,
				signal: null,
				aborted: false,
				stopReason: outcome.fail ? "error" : "stop",
				...(outcome.fail ? { errorMessage: "the provider refused the request" } : {}),
				stderr: "",
			};
			// A backend reports its progress as it goes, which is what the ledger, the dashboard and the history read.
			request.onProgress(child);
			return child;
		},
	};
	return { backend: hostBackend(backend), started };
}

interface Extension {
	tools: Map<string, { execute: (id: string, params: any, signal: undefined, onUpdate: undefined, ctx: any) => Promise<{ content: Array<{ text: string }>; details?: any }> }>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	appended: Array<[string, any]>;
}

/** The recording host one registration is made on, built apart so each of the two registrations below is one line. */
function recorder(): { ext: Extension; api: ExtensionAPI } {
	const ext: Extension = { tools: new Map(), commands: new Map(), appended: [] };
	const { activeTools: _active, ...toolAccess } = toolList(() => ext.tools.keys());
	const api = {
		...toolAccess,
		registerTool: (tool: any) => ext.tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => ext.commands.set(name, command),
		on: () => {},
		appendEntry: (customType: string, data: unknown) => ext.appended.push([customType, data]),
		registerMessageRenderer: () => {},
	} as unknown as ExtensionAPI;
	return { ext, api };
}

/**
 * The extension as every case here registers it: the tripwire in place of the pi backend this build registers by
 * default, with the backends the case named over it. A case that wants the defaults themselves says so with
 * `defaultExtension`, and there is exactly one of those in this file.
 */
const makeExtension = (backends: Partial<Record<"claude" | "pi", HostBackend>> = {}): Extension => {
	const { ext, api } = recorder();
	fusion(api, { backends: { ...piTripwire(), ...backends }, profiles: memoryProfileStore() });
	void turnOn(ext.tools.get("fusion_activate"));
	return ext;
};

/** The extension exactly as a host with no backends of its own gets it, this build's own pi backend included. */
const defaultExtension = (): Extension => {
	const { ext, api } = recorder();
	fusion(api, productionDefaults());
	void turnOn(ext.tools.get("fusion_activate"));
	return ext;
};

/** A host whose notices the test reads, which is where /fusion says what it found. */
const makeCtx = (branch: unknown[] = [], sessionId = "host-1") => {
	const notices: string[] = [];
	return {
		cwd: repoRoot,
		mode: "print",
		hasUI: true,
		notices,
		ui: { setStatus() {}, notify: (text: string) => notices.push(text) },
		sessionManager: { getSessionFile: () => undefined, getSessionId: () => sessionId, getBranch: () => branch },
	};
};

const call = async (ext: Extension, tool: string, params: Record<string, unknown>, ctx: any): Promise<{ text?: string; error?: string; details?: any }> => {
	const registered = ext.tools.get(tool);
	assert.ok(registered, `tool ${tool} not registered`);
	try {
		const result = await registered.execute("call-1", params, undefined, undefined, ctx);
		return { text: result.content[0]!.text, details: result.details };
	} catch (error) {
		return { error: (error as Error).message };
	}
};

const command = async (ext: Extension, args: string, ctx: any): Promise<void> => {
	const registered = ext.commands.get("fusion");
	assert.ok(registered, "the fusion command is not registered");
	await registered.handler(args, ctx);
};

/** Nothing a pi run shows may read as a claude session to resume, whatever scalar id the child reported. */
const noClaudeResume = (where: string, ...texts: Array<string | undefined>): void => {
	for (const text of texts) {
		assert.ok(!/claude --resume/.test(text ?? ""), `${where} offers a claude resume: ${text}`);
		assert.ok(!/pi-scalar/.test(text ?? ""), `${where} shows a scalar pi session id as if it were an identity: ${text}`);
	}
};

test("an injected backend runs through the same lifecycle, records its own identity and repeats its selection", async () => {
	process.env.PI_FUSION_PI_IMPLEMENT_MODEL = "deepseek/deepseek-chat";
	process.env.PI_FUSION_PI_IMPLEMENT_EFFORT = "high";
	try {
		const { backend, started } = stubBackend();
		const ext = makeExtension({ pi: backend });
		const first = await call(ext, "fusion", { role: "implement", task: "do the thing", backend: "pi" }, makeCtx());
		assert.equal(first.error, undefined);
		assert.match(first.text ?? "", /^## Changed\nfoo\.ts\n\n\[run-1 · implement · deepseek\/deepseek-chat · /);
		assert.match(first.text ?? "", /pi session \/sessions\/pi-new\.jsonl\]$/);
		assert.ok(!/claude --resume/.test(first.text ?? ""), "no claude resume command is offered for a pi session");
		assert.deepEqual(started.map((run) => [run.role.name, run.role.model, run.role.effort, run.session?.kind]), [["implement", "deepseek/deepseek-chat", "high", "new"]]);
		assert.deepEqual(ext.appended, [
			[
				"pi-fusion",
				{
					run: "run-1",
					role: "implement",
					backend: "pi",
					hostSessionId: "host-1",
					session: { backend: "pi", sessionId: "pi-new", sessionFile: "/sessions/pi-new.jsonl", checkpoint: "entry-42" },
					selection: { model: "deepseek/deepseek-chat", effort: "high" },
				},
			],
		]);

		// The recorded selection is what a continuation runs with, however the variables have changed since.
		process.env.PI_FUSION_PI_IMPLEMENT_MODEL = "openai/gpt-5";
		process.env.PI_FUSION_PI_IMPLEMENT_EFFORT = "low";
		const branch = [entry(ext.appended[0]![1])];
		const next = stubBackend();
		const continued = makeExtension({ pi: next.backend });
		const second = await call(continued, "fusion", { continue: "run-1", task: "and the tests?" }, makeCtx(branch));
		assert.equal(second.error, undefined);
		assert.deepEqual(next.started.map((run) => [run.role.model, run.role.effort]), [["deepseek/deepseek-chat", "high"]]);
		assert.deepEqual(next.started[0]?.session, { kind: "resume", id: "pi-new", file: "/sessions/pi-new.jsonl", at: "entry-42" });
		assert.equal(continued.appended.length, 1);
		assert.equal((continued.appended[0]![1] as { run: string }).run, "run-1");
	} finally {
		delete process.env.PI_FUSION_PI_IMPLEMENT_MODEL;
		delete process.env.PI_FUSION_PI_IMPLEMENT_EFFORT;
	}
});

test("a security call goes to the injected pi backend with no backend named, and records that role and its selection", async () => {
	process.env.PI_FUSION_PI_SECURITY_MODEL = "deepseek/deepseek-chat";
	process.env.PI_FUSION_PI_SECURITY_EFFORT = "xhigh";
	try {
		const { backend, started } = stubBackend();
		const ext = makeExtension({ pi: backend });
		const ran = await call(ext, "fusion", { role: "security", task: "audit the token check" }, makeCtx());
		assert.equal(ran.error, undefined);
		assert.match(ran.text ?? "", /^## Changed\nfoo\.ts\n\n\[run-1 · security · deepseek\/deepseek-chat · /);
		// No backend was named: the role runs on pi alone, so that is where the call went, under its own contract.
		assert.deepEqual(
			started.map((run) => [run.role.name, run.role.model, run.role.effort, run.role.contract, run.session?.kind]),
			[["security", "deepseek/deepseek-chat", "xhigh", "security.md", "new"]],
		);
		assert.deepEqual(ext.appended, [
			[
				"pi-fusion",
				{
					run: "run-1",
					role: "security",
					backend: "pi",
					hostSessionId: "host-1",
					session: { backend: "pi", sessionId: "pi-new", sessionFile: "/sessions/pi-new.jsonl", checkpoint: "entry-42" },
					selection: { model: "deepseek/deepseek-chat", effort: "xhigh" },
				},
			],
		]);
		// The compatibility tool advertises no such role, whatever is configured for it.
		const refused = await call(ext, "claude", { role: "security", task: "audit the token check" }, makeCtx());
		assert.equal(refused.error, "unknown role security; use one of plan, implement, ultracode, ask");
		assert.equal(started.length, 1, "and nothing started for the refused call");
	} finally {
		delete process.env.PI_FUSION_PI_SECURITY_MODEL;
		delete process.env.PI_FUSION_PI_SECURITY_EFFORT;
	}
});

test("a run of an injected backend keeps its backend, reference and selection in the on-disk history", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-routing-history-"));
	tempDirs.push(dir);
	process.env.PI_FUSION_HISTORY = "1";
	process.env.PI_FUSION_HISTORY_DIR = dir;
	process.env.PI_FUSION_PI_IMPLEMENT_MODEL = "deepseek/deepseek-chat";
	process.env.PI_FUSION_PI_IMPLEMENT_EFFORT = "high";
	try {
		const ext = makeExtension({ pi: stubBackend().backend });
		const ctx = { ...makeCtx(), sessionManager: { ...makeCtx().sessionManager, getSessionFile: () => path.join(dir, "host-1.jsonl") } };
		const ran = await call(ext, "fusion", { role: "implement", task: "do the thing", backend: "pi" }, ctx);
		assert.equal(ran.error, undefined);
		const held = new History(dir).load("host-1").records.at(-1);
		assert.ok(held, "the history kept no record of the run");
		assert.equal(held.backend, "pi");
		assert.deepEqual(held.ref, { backend: "pi", sessionId: "pi-new", sessionFile: "/sessions/pi-new.jsonl", checkpoint: "entry-42" });
		assert.deepEqual(held.selection, { model: "deepseek/deepseek-chat", effort: "high" });
		assert.equal(held.sessionId, undefined, "a pi run fills no flat claude session id, so no reader offers a claude resume");
		assert.deepEqual(held.session, { kind: "new", backend: "pi" });
		assert.equal(held.model, "deepseek/deepseek-chat");
	} finally {
		delete process.env.PI_FUSION_HISTORY;
		delete process.env.PI_FUSION_HISTORY_DIR;
		delete process.env.PI_FUSION_PI_IMPLEMENT_MODEL;
		delete process.env.PI_FUSION_PI_IMPLEMENT_EFFORT;
	}
});

test("a pi run's scalar session id stays a diagnostic: no resume command, no record field and no host detail", async () => {
	process.env.PI_FUSION_PI_IMPLEMENT_MODEL = "deepseek/deepseek-chat";
	try {
		const verified = makeExtension({ pi: stubBackend({ sessionId: "pi-scalar" }).backend });
		const ctx = makeCtx();
		const done = await call(verified, "fusion", { role: "implement", task: "do the thing", backend: "pi" }, ctx);
		assert.equal(done.error, undefined);
		assert.match(done.text ?? "", /pi session \/sessions\/pi-new\.jsonl\]$/, done.text);
		noClaudeResume("a settled pi run's report", done.text, JSON.stringify(done.details));
		assert.equal(done.details.sessionId, undefined, "the flat id a claude consumer resumes is not a pi run's to carry");
		assert.equal((verified.appended[0]![1] as { sessionId?: string }).sessionId, undefined, "and the record keeps the reference alone");
		await command(verified, "status run-1", ctx);
		noClaudeResume("/fusion status of a settled pi run", ...ctx.notices);
		assert.ok(ctx.notices.some((text) => text.includes("pi session /sessions/pi-new.jsonl")), ctx.notices.join("\n"));

		// A pi run that failed before it verified a reference keeps its scalar id as a diagnostic and nothing more.
		const unverified = makeExtension({ pi: stubBackend({ sessionId: "pi-scalar", verified: false, fail: true }).backend });
		const other = makeCtx();
		const failed = await call(unverified, "fusion", { role: "implement", task: "do the thing", backend: "pi" }, other);
		assert.match(failed.error ?? "", /^implement exited 1: the provider refused the request/);
		noClaudeResume("a failed pi run's error", failed.error);
		assert.deepEqual(unverified.appended, [["pi-fusion", { run: "run-1", role: "implement", backend: "pi", hostSessionId: "host-1" }]], "an unverified failure records the handle alone");
		const status = await call(unverified, "fusion_control", { action: "status", run: "run-1" }, other);
		noClaudeResume("fusion_control status of a failed pi run", status.text, JSON.stringify(status.details));
		await command(unverified, "status run-1", other);
		noClaudeResume("/fusion status of a failed pi run", ...other.notices);
	} finally {
		delete process.env.PI_FUSION_PI_IMPLEMENT_MODEL;
	}
});

test("a blank pi model or effort the call names is refused, and no recorded or configured value stands in for it", () => {
	const env = piEnv({ PI_FUSION_PI_IMPLEMENT_MODEL: "openrouter/deepseek/deepseek-chat", PI_FUSION_PI_IMPLEMENT_EFFORT: "high" });
	const recorded: ResolvedSelection = { model: "deepseek/deepseek-chat", effort: "medium" };
	for (const blank of ["", " ", "\t"]) {
		assert.throws(
			() => piRole({ role: "implement", model: blank }, recorded, env),
			/^Error: the call names an empty model for the pi backend; name one or leave the model parameter out to take the recorded or configured value$/,
			JSON.stringify(blank),
		);
		assert.throws(() => piRole({ role: "implement", effort: blank }, recorded, env), /^Error: the call names an empty effort for the pi backend/, JSON.stringify(blank));
	}
	// Leaving the parameter out is what takes the recorded value, so the fallback was there and the blank call did not use it.
	assert.deepEqual(piRole({ role: "implement" }, recorded, env), { name: "implement", model: "deepseek/deepseek-chat", effort: "medium", contract: "implement.md", ...PI_CODING_METADATA });
	assert.deepEqual(piRole({ role: "implement" }, undefined, env).model, "openrouter/deepseek/deepseek-chat");
	// The claude binding keeps the behavior it has always had: a blank model is no model, and the role's default stands.
	assert.equal(fusionCall({ role: "implement", task: "x", model: "  " }, records()).bound.model, "opus");
	assert.throws(() => fusionRoute({ role: "implement", task: "x", effort: " " }, records()), /^Error: unknown effort  ; use one of low, medium, high, xhigh, max$/);
});

test("the pi backend this build registers is reached through its binding, which refuses a call nothing configured a model for", async () => {
	// One of exactly two registrations in the suite that take the production defaults on purpose, with the tripwire left
	// out: what this case reads is that registration itself. No child may start here, and nothing stops one but the
	// binding, so every variable a pi role could resolve a model from is deleted first — `productionDefaults` refuses
	// the registration outright if one is still set. The refusal below is then the binding's own and not this process's
	// environment, and it lands before the backend is asked for a session, a control or a run.
	const kept = PI_SELECTION_VARIABLES.map((name) => [name, process.env[name]] as const);
	for (const [name] of kept) delete process.env[name];
	try {
		const ext = defaultExtension();
		const refused = await call(ext, "fusion", { role: "implement", task: "do the thing", backend: "pi" }, makeCtx());
		assert.equal(
			refused.error,
			"role implement has no model for the pi backend: set PI_FUSION_PI_IMPLEMENT_MODEL to a provider and a model id, such as deepseek/deepseek-chat, or name one in the call's model parameter. The pi backend has no default model and resolves none for you",
		);
		assert.doesNotMatch(refused.error ?? "", /not available in this build/, "the backend is registered now, so an unconfigured call is refused by the binding rather than by availability");
		// The role pi alone runs takes the same path with no backend named at all: routed to pi, then refused by the
		// binding for having no model, before that backend is asked for a session, a control or a run.
		const security = await call(ext, "fusion", { role: "security", task: "audit the token check" }, makeCtx());
		assert.equal(
			security.error,
			"role security has no model for the pi backend: set PI_FUSION_PI_SECURITY_MODEL to a provider and a model id, such as deepseek/deepseek-chat, or name one in the call's model parameter. The pi backend has no default model and resolves none for you",
		);
		assert.deepEqual(ext.appended, [], "a refused call records nothing");
		// The handle was not taken either: the next call is still run-1.
		const ran = await call(ext, "fusion", { role: "implement", task: "do it here" }, makeCtx());
		assert.equal(ran.error, undefined);
		assert.equal((ext.appended[0]![1] as { run: string }).run, "run-1");
	} finally {
		for (const [name, value] of kept) if (value !== undefined) process.env[name] = value;
	}
});

test("a backend a host left out is refused without asking the user to configure it", async () => {
	// An explicit undefined over this build's own default, which is the one way a host registers no pi backend at all.
	const ext = makeExtension({ pi: undefined });
	const refused = await call(ext, "fusion", { role: "implement", task: "x", backend: "pi" }, makeCtx());
	assert.match(refused.error ?? "", /the pi backend is not available in this build/i);
	assert.match(refused.error ?? "", /Nothing was started and nothing was recorded/);
	assert.match(refused.error ?? "", /this pi-fusion runs claude only/, "a key overridden with nothing is not a backend to take the work to");
	assert.doesNotMatch(refused.error ?? "", /PI_FUSION_PI_/, "a backend that runs nowhere is never a configuration problem");
	assert.match(refused.error ?? "", /no configuration makes pi available here/);
	// Whole, so the list of harnesses that are left is pinned as well: the backend the host left out is not in it.
	assert.equal(
		refused.error,
		"the pi backend is not available in this build: run-1 would run role implement on it, and this pi-fusion runs claude only. Nothing was started and nothing was recorded. Take the work to claude with a role it runs, or do it yourself; no configuration makes pi available here.",
	);
	assert.deepEqual(ext.appended, [], "a refused call records nothing");
});

test("a host that left out every backend says so, rather than offering an empty list of harnesses", async () => {
	// Both keys overridden with nothing, which is a host that registered no backend at all. The sentence that names
	// where the work goes instead has nowhere to point, so it is replaced rather than composed around an empty list.
	const ext = makeExtension({ claude: undefined, pi: undefined });
	const refused = await call(ext, "fusion", { role: "implement", task: "x" }, makeCtx());
	assert.equal(
		refused.error,
		"the claude backend is not available in this build: run-1 would run role implement on it, and this pi-fusion runs no backend at all. Nothing was started and nothing was recorded. Nothing can run this here; no configuration makes claude available here.",
	);
	assert.doesNotMatch(refused.error ?? "", /runs {2}only/, "an empty list must never read as a harness this build runs");
	assert.doesNotMatch(refused.error ?? "", /to {2}with/, "nor as somewhere to take the work to");
	assert.deepEqual(ext.appended, [], "a refused call records nothing");
});

test("both control tools act on a run either tool started", async () => {
	const ext = makeExtension();
	const ran = await call(ext, "fusion", { role: "implement", task: "do the thing" }, makeCtx());
	assert.equal(ran.error, undefined);
	for (const tool of ["claude_control", "fusion_control"]) {
		const status = await call(ext, tool, { action: "status", run: "run-1" }, makeCtx());
		assert.match(status.text ?? "", /^run-1 · implement · opus · done/, `${tool} does not see the run`);
	}
	const unknown = await call(ext, "fusion_control", { action: "status", run: "run-9" }, makeCtx());
	assert.equal(unknown.error, "unknown run run-9");
});

test("the claude tool refuses to continue a pi run and names the tool that can", async () => {
	const ext = makeExtension();
	const branch = [entry(piEntry())];
	const refused = await call(ext, "claude", { continue: "run-1", task: "more" }, makeCtx(branch));
	assert.match(refused.error ?? "", /^run-1 ran on the pi backend, which the claude tool does not run; continue it with fusion and continue run-1$/);
	assert.deepEqual(ext.appended, []);
});

test("every role the tools advertise has capabilities and a binding on each backend it names, so the lists cannot drift", () => {
	const ext = makeExtension();
	// The primary tool advertises every role a record may name, because every one of them runs on a backend of this
	// build; the compatibility tool advertises the roles claude runs and no other.
	for (const [tool, roles] of [
		["fusion", KNOWN_ROLE_NAMES],
		["claude", ROLE_NAMES],
	] as const) {
		const schema = (ext.tools.get(tool) as unknown as { parameters: { properties: { role: { enum: string[] } } } }).parameters;
		assert.deepEqual(schema.properties.role.enum, [...roles], `the ${tool} tool advertises another role list than the host runs`);
	}
	assert.deepEqual(
		[...ROLE_NAMES],
		KNOWN_ROLE_NAMES.filter((role) => roleSpec(role)?.backends.includes("claude")),
		"the compatibility tool's list is the roles claude runs, so a role it cannot run is never advertised there",
	);
	const env = piEnv({ PI_FUSION_PI_PLAN_MODEL: "deepseek/deepseek-chat", PI_FUSION_PI_ASK_MODEL: "deepseek/deepseek-chat", PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat" });
	for (const role of KNOWN_ROLE_NAMES) {
		const spec = roleSpec(role);
		assert.ok(spec, `role ${role} is advertised and has no capabilities`);
		assert.ok(spec.backends.length, `role ${role} is advertised and runs on no backend`);
		for (const backend of spec.backends) {
			const bound = backend === "claude" ? roleFor({ role, task: "x" }) : piRole({ role }, undefined, env);
			assert.equal(bound.name, role, `the ${backend} binding of ${role} bound another role`);
			assert.ok(bound.model, `the ${backend} binding of ${role} resolved no model`);
			assert.ok(fs.existsSync(path.join(repoRoot, "contracts", bound.contract)), `the ${backend} binding of ${role} names a contract that is not there: ${bound.contract}`);
		}
	}
	// The one role the two lists differ by is the one that runs on pi alone, and it is the primary tool's alone.
	assert.deepEqual(
		KNOWN_ROLE_NAMES.filter((role) => !(ROLE_NAMES as readonly string[]).includes(role)),
		["security"],
	);
	assert.deepEqual(roleSpec("security")?.backends, ["pi"]);
});
