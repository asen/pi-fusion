import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiRole } from "../extensions/backends/pi-binding.ts";
import type { BackendName, HostBackend } from "../extensions/backends/types.ts";
import fusion, { builtinConfiguration, type Configuration, claudeRoute, fusionCall, fusionRoute, roleFor, type RunRecords, runRecords } from "../extensions/fusion.ts";
import { fileProfileStore, memoryProfileStore, PROFILES_FILE, type ProfileStore } from "../extensions/profile-store.ts";
import {
	BUILTIN,
	builtinSettings,
	captureBaseline,
	copySettings,
	nameProblem,
	parseDocument,
	parseSettings,
	type RoleSettings,
	serializeDocument,
	settingsTable,
} from "../extensions/profiles.ts";
import { type FakeBackend, fakeBackend } from "./fake-pi-backend.ts";
import { piTripwire } from "./tripwire.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs: string[] = [];
after(() => {
	for (const dir of tempDirs) {
		try {
			fs.chmodSync(dir, 0o700);
		} catch {}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
const tempDir = (name: string): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fusion-profiles-${name}-`));
	tempDirs.push(dir);
	return dir;
};

/** The environment every baseline in this file is captured from, so nothing here depends on what this process has set. */
const ENV = {} as NodeJS.ProcessEnv;
const baseline = captureBaseline(ENV);
const LEGACY = builtinSettings(baseline);

/** The legacy defaults with the roles a case names over them, as a complete configuration. */
const settings = (over: Partial<Record<keyof RoleSettings, Record<string, unknown>>> = {}): RoleSettings => parseSettings({ ...LEGACY, ...over });

const configured = (roles: RoleSettings, profile = "work"): Configuration => ({ profile, modified: false, roles, baseline });

const document = (profiles: Record<string, RoleSettings>, defaultProfile: string | null = null): string => serializeDocument({ version: 1, defaultProfile, profiles });

const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "pi-fusion", data });
const records = (...entries: Array<Record<string, unknown>>): RunRecords => runRecords(entries.map(entry));

// ---------------------------------------------------------------------------------------------------------------------
// The configuration itself: pure, with no file and no host.

test("the built-in configuration is the legacy defaults: every role enabled on its legacy backend, captured from the environment it is given", () => {
	assert.deepEqual(LEGACY, {
		plan: { enabled: true, backend: "claude", model: "fable", effort: "xhigh" },
		implement: { enabled: true, backend: "claude", model: "opus", effort: "high" },
		ultracode: { enabled: true, backend: "claude", model: "fable", effort: "ultracode" },
		ask: { enabled: true, backend: "claude", model: "opus", effort: "high" },
		security: { enabled: true, backend: "pi" },
	});
	const env = { PI_FUSION_IMPLEMENT_MODEL: "sonnet", PI_FUSION_ASK_EFFORT: "low", PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat", PI_FUSION_PI_PLAN_EFFORT: "high" } as NodeJS.ProcessEnv;
	const captured = captureBaseline(env);
	assert.deepEqual(builtinSettings(captured).implement, { enabled: true, backend: "claude", model: "sonnet", effort: "high" });
	assert.deepEqual(builtinSettings(captured).security, { enabled: true, backend: "pi", model: "deepseek/deepseek-chat" });
	assert.deepEqual(captured.plan.pi, { effort: "high" }, "the other backend's legacy defaults are captured too, for a call that names it");
	env.PI_FUSION_IMPLEMENT_MODEL = "haiku";
	assert.equal(captured.implement.claude?.model, "sonnet", "a baseline is a copy: a variable changed later does not reach it");
});

test("a configuration is validated whole: every role, its backend, its model and its effort", () => {
	assert.deepEqual(parseSettings(copySettings(LEGACY)), LEGACY);
	const bad: Array<[unknown, RegExp]> = [
		[{ ...LEGACY, extra: LEGACY.plan }, /^Error: roles has unknown role "extra"/],
		[(({ security: _, ...rest }) => rest)(LEGACY), /^Error: roles has no security role/],
		[{ ...LEGACY, plan: { ...LEGACY.plan, colour: "red" } }, /^Error: roles\.plan has unknown field "colour"/],
		[{ ...LEGACY, plan: { ...LEGACY.plan, enabled: "yes" } }, /^Error: roles\.plan\.enabled must be true or false$/],
		[{ ...LEGACY, plan: { ...LEGACY.plan, backend: "codex" } }, /^Error: roles\.plan\.backend must be claude or pi$/],
		[{ ...LEGACY, ultracode: { enabled: true, backend: "pi" } }, /^Error: roles\.ultracode\.backend is pi, but role ultracode runs on claude only$/],
		[{ ...LEGACY, security: { enabled: false, backend: "claude" } }, /^Error: roles\.security\.backend is claude, but role security runs on pi only$/],
		[{ ...LEGACY, ask: { enabled: true, backend: "pi", model: "deepseek-chat" } }, /^Error: roles\.ask\.model "deepseek-chat" is not a pi provider and model id/],
		[{ ...LEGACY, ask: { ...LEGACY.ask, model: "  " } }, /^Error: roles\.ask\.model must be a non-empty string; leave it out instead$/],
		[{ ...LEGACY, ask: { ...LEGACY.ask, model: " opus" } }, /^Error: roles\.ask\.model " opus" has spaces around it$/],
		[{ ...LEGACY, ask: { ...LEGACY.ask, effort: "off" } }, /^Error: roles\.ask\.effort "off" is not a claude effort; use one of low, medium, high, xhigh, max$/],
		[{ ...LEGACY, ask: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "ultracode" } }, /^Error: roles\.ask\.effort "ultracode" is not a pi effort/],
		[{ ...LEGACY, ultracode: { ...LEGACY.ultracode, effort: "xhigh" } }, /^Error: roles\.ultracode\.effort must be ultracode or left out/],
		[{ ...LEGACY, implement: { enabled: true, backend: "claude", effort: "high" } }, /^Error: roles\.implement is enabled on claude and names no model$/],
		[{ ...LEGACY, implement: { enabled: true, backend: "claude", model: "opus" } }, /^Error: roles\.implement is enabled on claude and names no effort$/],
		[[], /^Error: roles must be an object$/],
	];
	for (const [value, expected] of bad) assert.throws(() => parseSettings(value), expected, JSON.stringify(value));
	// What may be left out: a disabled role needs no model, an enabled pi role may be unconfigured, ultracode's effort.
	const loose = parseSettings({
		...LEGACY,
		implement: { enabled: false, backend: "claude" },
		ask: { enabled: true, backend: "pi" },
		ultracode: { enabled: true, backend: "claude", model: "fable" },
		plan: { enabled: true, backend: "pi", model: "openrouter/deepseek/deepseek-chat", effort: "off" },
	});
	assert.deepEqual(loose.implement, { enabled: false, backend: "claude" });
	assert.deepEqual(loose.ask, { enabled: true, backend: "pi" });
	assert.equal(loose.plan.model, "openrouter/deepseek/deepseek-chat", "a provider's own slashes survive");
	// A disabled role's supplied fields are still checked.
	assert.throws(() => parseSettings({ ...LEGACY, ask: { enabled: false, backend: "pi", model: "nope" } }), /roles\.ask\.model "nope"/);
});

test("a copy of a configuration shares nothing with it", () => {
	const copy = copySettings(LEGACY);
	copy.plan.model = "sonnet";
	copy.ask.enabled = false;
	assert.equal(LEGACY.plan.model, "fable");
	assert.equal(LEGACY.ask.enabled, true);
});

test("profile names are plain and case-sensitive, and builtin is no name a profile can take", () => {
	for (const name of ["work", "Work", "a", "w.2_x-y", "x".repeat(64)]) assert.equal(nameProblem(name), undefined, name);
	for (const name of ["", "-x", ".x", "a b", "a/b", "x".repeat(65), "ü"]) assert.match(nameProblem(name) ?? "", /must start with a letter or digit/, name);
	assert.match(nameProblem(BUILTIN) ?? "", /^builtin is the built-in configuration and cannot be saved over$/);
});

test("the profiles file is versioned, and anything this build does not read is refused rather than guessed at", () => {
	const work = settings({ ask: { enabled: false, backend: "claude" } });
	const parsed = parseDocument(JSON.parse(document({ work }, "work")));
	assert.deepEqual(parsed, { version: 1, defaultProfile: "work", profiles: { work } });
	assert.deepEqual(parseDocument({ version: 1, profiles: {} }), { version: 1, defaultProfile: null, profiles: {} }, "no default is the built-in configuration");
	assert.deepEqual(parseDocument({ version: 1, defaultProfile: "gone", profiles: {} }).defaultProfile, "gone", "a default the file does not hold is the loader's to report");
	const bad: Array<[unknown, RegExp]> = [
		[{ version: 2, profiles: {} }, /has version 2, and this build reads version 1 only/],
		[{ profiles: {} }, /has version undefined/],
		[{ version: 1, profiles: {}, extra: true }, /unknown field "extra"/],
		[{ version: 1, defaultProfile: "builtin", profiles: {} }, /defaultProfile: builtin is the built-in configuration and cannot be saved over; use null for builtin/],
		[{ version: 1, profiles: { builtin: { roles: LEGACY } } }, /profiles: builtin is the built-in configuration/],
		[{ version: 1, profiles: { "a b": { roles: LEGACY } } }, /profiles: profile name "a b"/],
		[{ version: 1, profiles: { work: { roles: LEGACY, note: "x" } } }, /profiles\.work has unknown field "note"/],
		[{ version: 1, profiles: { work: { roles: { ...LEGACY, plan: { enabled: 1, backend: "claude" } } } } }, /profiles\.work\.roles\.plan\.enabled must be true or false/],
		["text", /must hold a JSON object/],
	];
	for (const [value, expected] of bad) assert.throws(() => parseDocument(value), expected, JSON.stringify(value));
});

test("the configuration table names every role with its backend, model and effort, unconfigured and fixed included", () => {
	assert.deepEqual(settingsTable(settings({ implement: { enabled: false, backend: "claude" }, ask: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat" } })), [
		"role       enabled  backend  model                   effort",
		"plan       yes      claude   fable                   xhigh",
		"implement  no       claude   unconfigured            none",
		"ultracode  yes      claude   fable                   ultracode (fixed)",
		"ask        yes      pi       deepseek/deepseek-chat  child default",
		"security   yes      pi       unconfigured            child default",
	]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The store: one JSON file, read without writing and replaced whole.

test("a missing profiles file reads as an empty store and creates nothing", async () => {
	const root = tempDir("absent");
	const fusionDir = path.join(root, "agent", "pi-fusion");
	const store = fileProfileStore(() => fusionDir);
	assert.deepEqual(await store.read(), { version: 1, defaultProfile: null, profiles: {} });
	assert.equal(await store.where(), path.join(fusionDir, PROFILES_FILE));
	assert.equal(fs.existsSync(path.join(root, "agent")), false, "reading created no directory");
});

test("a save creates the private directory and file, round-trips the snapshot and keeps every other profile", async () => {
	const fusionDir = path.join(tempDir("save"), "agent", "pi-fusion");
	const store = fileProfileStore(() => fusionDir);
	const work = settings({ ultracode: { enabled: false, backend: "claude" } });
	const home = settings({ implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" } });
	await store.update((current) => ({ ...current, profiles: { ...current.profiles, work } }));
	await store.update((current) => ({ ...current, defaultProfile: "home", profiles: { ...current.profiles, home } }));
	assert.equal(fs.statSync(fusionDir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(fusionDir, PROFILES_FILE)).mode & 0o777, 0o600);
	assert.deepEqual(await store.read(), { version: 1, defaultProfile: "home", profiles: { home, work } });
	assert.deepEqual(fs.readdirSync(fusionDir), [PROFILES_FILE], "no temporary file is left beside it");
});

test("a malformed profiles file is reported, never overwritten by a command, and left byte for byte as it was", async () => {
	const fusionDir = tempDir("malformed");
	const file = path.join(fusionDir, PROFILES_FILE);
	const store = fileProfileStore(() => fusionDir);
	for (const text of ["{ not json", JSON.stringify({ version: 9, profiles: {} })]) {
		fs.writeFileSync(file, text);
		await assert.rejects(store.read(), new RegExp(`^Error: profiles file ${file.replaceAll("/", "\\/")}`));
		await assert.rejects(store.update((current) => current), /fix it by hand$/);
		assert.equal(fs.readFileSync(file, "utf8"), text);
	}
});

test("two stores on one file in this process queue their writes, each rereading what the one before it left", async () => {
	const fusionDir = tempDir("queue");
	const one = fileProfileStore(() => fusionDir);
	// The same file named another way: the queue is keyed by the absolute path, not by the string a store was given.
	const other = fileProfileStore(() => path.join(fusionDir, ".", "x", ".."));
	const names = ["a", "b", "c", "d", "e", "f"];
	await Promise.all(names.map((name, index) => (index % 2 ? one : other).update((current) => ({ ...current, profiles: { ...current.profiles, [name]: LEGACY } }))));
	assert.deepEqual(Object.keys((await one.read()).profiles).sort(), names, "no save lost another's profile");
	// A change that throws fails that update alone; the one queued after it still runs on the latest document.
	const failing = one.update(() => {
		throw new Error("refused");
	});
	const next = other.update((current) => ({ ...current, defaultProfile: "a" }));
	await assert.rejects(failing, /^Error: refused$/);
	assert.equal((await next).defaultProfile, "a");
	assert.equal(Object.keys((await one.read()).profiles).length, names.length);
});

test("a write that fails leaves the file it would have replaced as it was, and no temporary file of its own", async () => {
	const fusionDir = tempDir("failing");
	const store = fileProfileStore(() => fusionDir);
	await store.update((current) => ({ ...current, profiles: { work: LEGACY } }));
	const file = path.join(fusionDir, PROFILES_FILE);
	const before = fs.readFileSync(file, "utf8");
	// The rename is the step that replaces the file, so failing it after the temporary file was written is the case
	// the cleanup is for.
	const rename = fs.promises.rename;
	fs.promises.rename = async () => {
		throw Object.assign(new Error("simulated"), { code: "EXDEV" });
	};
	try {
		await assert.rejects(store.update((current) => ({ ...current, defaultProfile: "work" })), /could not be written \(EXDEV\); it is unchanged$/);
	} finally {
		fs.promises.rename = rename;
	}
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.deepEqual(fs.readdirSync(fusionDir), [PROFILES_FILE], "the temporary file this write made is gone");
	// A directory this user cannot write is refused by the shared directory check before anything is written.
	if (process.getuid?.() !== 0) {
		fs.chmodSync(fusionDir, 0o500);
		try {
			await assert.rejects(store.update((current) => ({ ...current, defaultProfile: "work" })), /could not be written: inspect .* it is not readable, writable and searchable by this user \(EACCES\)$/);
		} finally {
			fs.chmodSync(fusionDir, 0o700);
		}
		assert.equal(fs.readFileSync(file, "utf8"), before);
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// Routing under a configuration: pure, with records written out as literals.

test("a fresh run goes to the role's configured backend, on its configured model and effort, and a call's own values win", () => {
	const config = configured(
		settings({
			implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" },
			ask: { enabled: true, backend: "claude", model: "sonnet", effort: "low" },
		}),
	);
	const implement = fusionCall({ role: "implement", task: "x" }, records(), 35, config);
	assert.deepEqual([implement.backend, implement.bound.model, (implement.bound as PiRole).effort], ["pi", "deepseek/deepseek-chat", "high"]);
	const ask = fusionCall({ role: "ask", task: "x" }, records(), 35, config);
	assert.deepEqual([ask.backend, ask.bound.model, ask.bound.effort], ["claude", "sonnet", "low"]);
	const named = fusionCall({ role: "ask", task: "x", model: "opus", effort: "max" }, records(), 35, config);
	assert.deepEqual([named.bound.model, named.bound.effort], ["opus", "max"]);
	assert.equal(fusionRoute({ role: "ask", task: "x" }, records(), 35, config).call.model, undefined, "a configured default is never written into the call");
});

test("a call naming the other backend runs on that backend's legacy defaults, and nothing configured for the role's backend leaks across", () => {
	const piBaseline = captureBaseline({ PI_FUSION_PI_IMPLEMENT_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv);
	const config: Configuration = { profile: "work", modified: false, roles: settings({ implement: { enabled: true, backend: "claude", model: "sonnet", effort: "low" } }), baseline: piBaseline };
	const onPi = fusionCall({ role: "implement", task: "x", backend: "pi" }, records(), 35, config);
	assert.deepEqual([onPi.bound.model, (onPi.bound as PiRole).effort], ["deepseek/deepseek-chat", undefined], "the pi baseline, never the claude model or effort");
	const noPi: Configuration = { ...config, baseline };
	assert.throws(() => fusionCall({ role: "implement", task: "x", backend: "pi" }, records(), 35, noPi), /^Error: role implement has no model for the pi backend: set PI_FUSION_PI_IMPLEMENT_MODEL/);
	// And the other way round: a role configured on pi runs on claude's own defaults when a call names claude.
	const toClaude = configured(settings({ plan: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "off" } }));
	const plan = fusionCall({ role: "plan", task: "x", backend: "claude" }, records(), 35, toClaude);
	assert.deepEqual([plan.bound.model, plan.bound.effort], ["fable", "xhigh"]);
	// The compatibility tool is that same explicit override, forced.
	const forced = claudeRoute({ role: "plan", task: "x" }, records(), 35, toClaude);
	assert.deepEqual([forced.backend, roleFor(forced.call, forced.defaults).model], ["claude", "fable"]);
});

test("a pi role a profile leaves unconfigured is refused in that profile's words, and never borrows a variable", () => {
	const piBaseline = captureBaseline({ PI_FUSION_PI_SECURITY_MODEL: "deepseek/deepseek-chat" } as NodeJS.ProcessEnv);
	const config: Configuration = { profile: "work", modified: true, roles: settings({ security: { enabled: true, backend: "pi" } }), baseline: piBaseline };
	assert.throws(
		() => fusionCall({ role: "security", task: "x" }, records(), 35, config),
		/^Error: role security has no model for the pi backend in profile work \(modified\): choose a provider and a model id, such as deepseek\/deepseek-chat, with \/fusion config, or name one in the call's model parameter/,
	);
	assert.equal(fusionCall({ role: "security", task: "x", model: "openai/gpt-5" }, records(), 35, config).bound.model, "openai/gpt-5");
	// The built-in configuration as it started is the variables, and says so.
	assert.equal(fusionCall({ role: "security", task: "x" }, records(), 35, builtinConfiguration(piBaseline)).bound.model, "deepseek/deepseek-chat");
});

test("a disabled role is refused before anything is bound, whatever the call names, and for a continuation too", () => {
	const config = configured(settings({ ultracode: { enabled: false, backend: "claude" }, implement: { enabled: false, backend: "claude" } }));
	const refusal = /^Error: role implement is disabled in profile work; change \/fusion config or select another profile$/;
	assert.throws(() => fusionRoute({ role: "implement", task: "x" }, records(), 35, config), refusal);
	assert.throws(() => fusionRoute({ role: "implement", task: "x", backend: "pi", model: "deepseek/deepseek-chat", effort: "high" }, records(), 35, config), refusal);
	assert.throws(() => claudeRoute({ role: "implement", task: "x", model: "opus" }, records(), 35, config), refusal);
	const done = records({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "opus", effort: "high" });
	assert.throws(() => fusionRoute({ continue: "run-1", task: "more" }, done, 35, config), refusal);
	assert.throws(() => claudeRoute({ continue: "run-1", task: "more" }, done, 35, config), refusal);
	assert.throws(() => fusionRoute({ role: "ultracode", task: "x" }, records(), 35, config), /^Error: role ultracode is disabled in profile work;/);
	// An unknown role is still an unknown role, before any configuration is read.
	assert.throws(() => fusionRoute({ role: "audit", task: "x" }, records(), 35, config), /^Error: unknown role audit;/);
	// Enabling the role is all a continuation needs.
	assert.equal(fusionRoute({ continue: "run-1", task: "more" }, done, 35, configured(LEGACY)).handle, "run-1");
});

test("a continuation keeps the model and effort it recorded, whatever profile is selected since", () => {
	const other = configured(settings({ implement: { enabled: true, backend: "claude", model: "haiku", effort: "low" }, plan: { enabled: true, backend: "claude", model: "opus", effort: "medium" } }));
	const implement = records({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "sonnet", effort: "max" });
	const kept = fusionCall({ continue: "run-1", task: "more" }, implement, 35, other);
	assert.deepEqual([kept.bound.model, kept.bound.effort, kept.unrecorded], ["sonnet", "max", undefined]);
	// An implicit plan continuation keeps the plan run's model: a configured default is not a change of model.
	const plan = records({ run: "run-1", role: "plan", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "sonnet", effort: "low" });
	const implicit = fusionCall({ role: "plan", task: "next" }, plan, 35, other);
	assert.deepEqual([implicit.handle, implicit.handoff, implicit.bound.model, implicit.bound.effort], ["run-1", undefined, "sonnet", "low"]);
	// A deliberately fresh plan takes the profile's.
	const fresh = fusionCall({ role: "plan", task: "start over", fresh: true }, plan, 35, other);
	assert.deepEqual([fresh.handle, fresh.bound.model, fresh.bound.effort], ["run-2", "opus", "medium"]);
	// An old entry's missing fields are the legacy defaults this instance started with, never the profile's, and it says so.
	const old = records({ run: "run-1", role: "implement", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1" });
	const legacy = fusionCall({ continue: "run-1", task: "more" }, old, 35, other);
	assert.deepEqual([legacy.bound.model, legacy.bound.effort], ["opus", "high"]);
	assert.equal(legacy.unrecorded, "run-1 was recorded before its settings were kept, so it runs on the default this Pi process started with: model (opus), effort (high)");
});

test("a cap replacement keeps the planner's model unless the call names another, and takes its effort from the call or the configured role", () => {
	const fable = configured(settings({ plan: { enabled: true, backend: "claude", model: "fable", effort: "xhigh" } }));
	const full = { contextTokens: 400_000, contextWindow: 1_000_000 };
	const sonnet = records({ run: "run-1", role: "plan", backend: "claude", hostSessionId: "host-1", sessionId: "s-1", checkpoint: "c-1", model: "sonnet", effort: "low", ...full });
	const handed = fusionCall({ role: "plan", task: "next" }, sonnet, 35, fable);
	assert.deepEqual([handed.handle, handed.handoff?.reason.kind, handed.bound.model, handed.bound.effort], ["run-2", "cap", "sonnet", "xhigh"]);
	assert.equal(fusionCall({ role: "plan", task: "next", effort: "max" }, sonnet, 35, fable).bound.effort, "max");
	// Another model named is a model handoff, on that model, at the configured effort.
	const model = fusionCall({ role: "plan", task: "next", model: "opus" }, sonnet, 35, fable);
	assert.deepEqual([model.handoff?.reason.kind, model.bound.model, model.bound.effort], ["model", "opus", "xhigh"]);
	assert.equal(fusionCall({ role: "plan", task: "next", fresh: true }, sonnet, 35, fable).bound.model, "fable");
	// On pi the recorded model and level go together.
	const onPi = configured(settings({ plan: { enabled: true, backend: "pi", model: "openai/gpt-5", effort: "xhigh" } }));
	const piPlan = records({
		run: "run-1",
		role: "plan",
		backend: "pi",
		hostSessionId: "host-1",
		session: { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-1" },
		selection: { model: "deepseek/deepseek-chat", effort: "low" },
		...full,
	});
	const piHanded = fusionCall({ role: "plan", task: "next" }, piPlan, 35, onPi);
	assert.deepEqual([piHanded.backend, piHanded.handoff?.reason.kind, piHanded.bound.model, (piHanded.bound as PiRole).effort], ["pi", "cap", "deepseek/deepseek-chat", "low"]);
	assert.deepEqual([fusionCall({ role: "plan", task: "next", fresh: true }, piPlan, 35, onPi).bound.model], ["openai/gpt-5"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The extension on a host whose tool registry behaves as Pi 0.85.1's does in the two ways this feature depends on.

interface Tool {
	name: string;
	description: string;
	promptGuidelines?: string[];
	execute: (id: string, params: any, signal: AbortSignal | undefined, onUpdate: undefined, ctx: any) => Promise<{ content: Array<{ text: string }>; details?: any }>;
}

interface SdkHostOptions {
	profiles?: ProfileStore;
	/** The host's `--tools` allow list, which a registry refresh puts back on the active list whole. */
	allowed?: string[];
	backends?: Partial<Record<BackendName, HostBackend>>;
	/** The answers the host's select and input dialogs give, in order; a function picks one of the options offered. */
	dialogs?: Array<string | undefined | ((options: string[]) => string | undefined | Promise<string | undefined>)>;
	ui?: boolean;
	modelRegistry?: unknown;
}

/**
 * A host whose tool registry models what this feature relies on in the installed SDK, and nothing else: registering
 * a name again replaces its definition, a name new to the registry becomes active, and a refresh under an allow list
 * puts every allowed tool back on the active list. It measures what Fusion does with those behaviours; that the SDK
 * has them is the manual spike's to show, never this file's.
 */
function sdkHost(options: SdkHostOptions = {}) {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void>; getArgumentCompletions: (prefix: string) => unknown }>();
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown> | unknown>();
	const branch: unknown[] = [];
	const notices: Array<[string, string]> = [];
	const active: string[] = ["read", "bash"];
	const registrations: string[] = [];
	const dialogs = [...(options.dialogs ?? [])];
	const titles: string[] = [];
	const api = {
		registerTool: (tool: Tool) => {
			registrations.push(tool.name);
			const known = tools.has(tool.name);
			tools.set(tool.name, tool);
			if (!known && !active.includes(tool.name)) active.push(tool.name);
			for (const name of options.allowed ?? []) if (tools.has(name) && !active.includes(name)) active.push(name);
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: any) => handlers.set(event, handler),
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		sendMessage: () => {},
		registerMessageRenderer: () => {},
	} as unknown as ExtensionAPI;
	fusion(api, { backends: { ...piTripwire(), ...options.backends }, profiles: options.profiles ?? memoryProfileStore() });
	const answer = (options: string[]) => {
		const next = dialogs.shift();
		return typeof next === "function" ? next(options) : next;
	};
	const ui = {
		setStatus() {},
		setWidget() {},
		notify: (text: string, level: string) => notices.push([text, level]),
		...(options.ui === false
			? {}
			: {
					select: async (title: string, choices: string[]) => {
						titles.push(title);
						return answer(choices);
					},
					input: async (title: string) => {
						titles.push(title);
						return answer([]);
					},
				}),
	};
	const ctx = {
		cwd: repoRoot,
		mode: "print",
		hasUI: options.ui !== false,
		ui,
		...(options.modelRegistry === undefined ? {} : { modelRegistry: options.modelRegistry }),
		sessionManager: { getSessionId: () => "host-1", getBranch: () => branch, getSessionFile: () => undefined },
	};
	const call = async (tool: string, params: Record<string, unknown>) => {
		try {
			const result = await tools.get(tool)!.execute("call-1", params, undefined, undefined, ctx);
			return { text: result.content[0]!.text, details: result.details };
		} catch (error) {
			return { error: (error as Error).message };
		}
	};
	return {
		tools,
		active,
		registrations,
		notices,
		titles,
		branch,
		dialogs,
		start: async () => handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx),
		command: async (args: string) => commands.get("fusion")!.handler(args, ctx),
		completions: (prefix: string) => commands.get("fusion")!.getArgumentCompletions(prefix),
		fusion: (params: Record<string, unknown>) => call("fusion", params),
		claude: (params: Record<string, unknown>) => call("claude", params),
		shutdown: async () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx),
		last: () => notices.at(-1)?.[0],
	};
}

const WORK = settings({
	implement: { enabled: true, backend: "claude", model: "sonnet", effort: "low" },
	ultracode: { enabled: false, backend: "claude" },
	ask: { enabled: true, backend: "claude", model: "haiku", effort: "medium" },
});

test("the default profile loads as the session starts, and the host's guidance and every call follow it", async () => {
	const claude = fakeBackend({ name: "claude" });
	const host = sdkHost({ profiles: memoryProfileStore(document({ work: WORK }, "work")), backends: { claude: claude.backend } });
	assert.match(host.tools.get("fusion")!.description, /implement runs on claude with model opus at effort high/, "before the session starts, the built-in guidance");
	await host.start();
	assert.deepEqual(host.notices, [], "a default that loaded is no warning");
	const description = host.tools.get("fusion")!.description;
	assert.match(description, /In this session's configuration plan runs on claude with model fable at effort xhigh; implement runs on claude with model sonnet at effort low; ultracode is disabled; ask runs on claude with model haiku at effort medium;/);
	const guidelines = host.tools.get("fusion")!.promptGuidelines ?? [];
	assert.ok(guidelines.some((line) => /disables role ultracode: a fusion call to a disabled role is refused/.test(line)), guidelines.join("\n"));
	assert.ok(!guidelines.some((line) => /Use fusion with role ultracode/.test(line)), "a disabled role is recommended nowhere");
	assert.match(host.tools.get("claude")!.description, /ultracode is disabled/);
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.deepEqual([claude.starts[0]!.role.model, claude.starts[0]!.role.effort], ["sonnet", "low"]);
	assert.equal((host.branch.at(-1) as any).data.effort, "low", "and the run records what it was admitted with");
	assert.equal((await host.claude({ role: "ultracode", task: "x" })).error, "role ultracode is disabled in profile work; change /fusion config or select another profile");
	assert.equal(claude.starts.length, 1, "a refused call starts nothing");
	await host.shutdown();
});

test("a broken profiles file or a missing default leaves the built-in configuration and a warning, and rewrites nothing", async () => {
	const broken = memoryProfileStore("{ nope");
	const host = sdkHost({ profiles: broken });
	await host.start();
	assert.equal(host.notices.length, 1);
	assert.match(host.notices[0]![0], /^fusion: profiles file \(in memory\) is not valid JSON .*; fix it by hand; this session uses the builtin configuration$/);
	assert.equal(broken.text(), "{ nope");
	await host.command("profile use work");
	assert.match(host.last() ?? "", /^profile work was not loaded: profiles file \(in memory\) is not valid JSON/);
	await host.command("config");
	assert.match(host.titles.at(-1) ?? "", /^fusion config · builtin\n/, "and the session is still on the built-in configuration");

	const missing = sdkHost({ profiles: memoryProfileStore(document({}, "gone")), ui: false });
	await missing.start();
	assert.deepEqual(missing.notices, [["fusion: the default profile gone is not in (in memory); this session uses the builtin configuration", "warning"]]);
});

test("profile save, list, use and default each do one thing, and only use changes this session", async () => {
	const store = memoryProfileStore();
	const host = sdkHost({ profiles: store, ui: false });
	await host.start();
	await host.command("profile save work");
	assert.equal(host.last(), "saved profile work; it is not the default for new sessions unless /fusion profile default work makes it one");
	await host.command("profile save work");
	assert.match(host.last() ?? "", /^replaced profile work;/);
	await host.command("profile list");
	assert.equal(host.last(), "builtin (default for new sessions)\nwork (current)");
	await host.command("profile default work");
	assert.equal(host.last(), "new sessions start with work; this session keeps work");
	await host.command("profile default nope");
	assert.equal(host.last(), "the default was not changed: unknown profile nope; the profiles are builtin, work");
	assert.equal(parseDocument(JSON.parse(store.text()!)).defaultProfile, "work");
	await host.command("profile use builtin");
	assert.equal(host.last(), "fusion uses profile builtin in this session");
	await host.command("profile list");
	assert.equal(host.last(), "builtin (current)\nwork (default for new sessions)");
	await host.command("profile use nope");
	assert.equal(host.last(), "unknown profile nope; the profiles are builtin, work");
	await host.command("profile default builtin");
	assert.equal(parseDocument(JSON.parse(store.text()!)).defaultProfile, null);
	await host.command("profile");
	assert.match(host.last() ?? "", /^builtin \(current; default for new sessions\)\nwork\nUsage: \/fusion profile/);
	await host.command("config");
	assert.deepEqual(host.last()?.split("\n"), ["fusion configuration: builtin · new sessions start with builtin", ...settingsTable(LEGACY), "profiles file: (in memory)"]);
	// Completion offers what the last read found.
	assert.deepEqual(host.completions("profile use w"), [{ value: "profile use work", label: "profile use work" }]);
	assert.deepEqual(host.completions("profile save "), [{ value: "profile save work", label: "profile save work" }], "save never offers builtin");
	assert.deepEqual(
		(host.completions("profile default ") as Array<{ value: string }>).map((item) => item.value),
		["profile default builtin", "profile default work"],
	);
});

test("an edit made to the file elsewhere reaches this session only when a profile is loaded again", async () => {
	const fusionDir = tempDir("external");
	const store = fileProfileStore(() => fusionDir);
	await store.update(() => ({ version: 1, defaultProfile: "work", profiles: { work: LEGACY } }));
	const claude = fakeBackend({ name: "claude" });
	const host = sdkHost({ profiles: store, ui: false, backends: { claude: claude.backend } });
	await host.start();
	fs.writeFileSync(path.join(fusionDir, PROFILES_FILE), document({ work: WORK }, "work"));
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.equal(claude.starts[0]!.role.model, "opus", "the session keeps the snapshot it loaded");
	await host.command("profile use work");
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.equal(claude.starts[1]!.role.model, "sonnet");
});

/** A claude backend whose first run is held until the case releases it, for a run that stays unfinished. */
async function heldRun(host: ReturnType<typeof sdkHost>, claude: FakeBackend) {
	const call = host.fusion({ role: "implement", task: "long work" });
	const held = await claude.started(1);
	return { call, release: () => held.release() };
}

test("applying settings is refused while any run is unfinished, and saving or changing the default is not", async () => {
	const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }, {}] });
	const store = memoryProfileStore(document({ work: WORK }));
	const host = sdkHost({ profiles: store, backends: { claude: claude.backend }, ui: false });
	await host.start();
	const run = await heldRun(host, claude);
	await host.command("profile use work");
	assert.equal(
		host.last(),
		"fusion settings stay as they are while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry.",
	);
	await host.command("profile use builtin");
	assert.match(host.last() ?? "", /^fusion settings stay as they are while runs are unfinished/);
	await host.command("profile save snapshot");
	assert.match(host.last() ?? "", /^saved profile snapshot;/);
	await host.command("profile default work");
	assert.equal(host.last(), "new sessions start with work; this session keeps snapshot");
	run.release();
	await run.call;
	await host.command("profile use work");
	assert.equal(host.last(), "fusion uses profile work in this session; disabled: ultracode");
	assert.equal((await host.fusion({ role: "implement", task: "x" })).error, undefined);
	assert.equal(claude.starts[1]!.role.model, "sonnet");
});

test("the editor stages every change and applies them together, and a run that starts while it is open refuses the apply", async () => {
	const row = (role: string) => (options: string[]) => options.find((option) => option.startsWith(`${role} `));
	const claude = fakeBackend({ name: "claude", scripts: [{ pending: true }, {}] });
	// Cancel leaves everything as it was.
	const cancelled = sdkHost({ dialogs: [row("ultracode"), "enabled: yes", "Back", "Cancel"] });
	await cancelled.start();
	await cancelled.command("config");
	assert.equal(cancelled.last(), "fusion config cancelled; nothing changed");
	assert.match(cancelled.tools.get("fusion")!.description, /ultracode runs on claude with model fable/);

	// Several edits, one apply: ultracode off, implement to pi on a model picked from the host's own list, at a level.
	const registry = { getAvailable: () => [{ provider: "deepseek", id: "deepseek-chat" }, { provider: "openrouter", id: "deepseek/deepseek-r1" }] };
	const host = sdkHost({
		modelRegistry: registry,
		backends: { claude: claude.backend },
		dialogs: [
			row("ultracode"),
			"enabled: yes",
			"Back",
			row("implement"),
			"backend: claude",
			"pi",
			"model: unconfigured",
			(options) => {
				assert.deepEqual(options, ["deepseek/deepseek-chat", "openrouter/deepseek/deepseek-r1", "Type a provider/model id…", "Unconfigured"]);
				return "openrouter/deepseek/deepseek-r1";
			},
			"effort: child default",
			"high",
			"Back",
			"Apply",
		],
	});
	await host.start();
	await host.command("config");
	assert.equal(host.last(), "fusion settings applied to this session; disabled: ultracode; save them with /fusion profile save <name>");
	assert.match(host.tools.get("fusion")!.description, /implement runs on pi with model openrouter\/deepseek\/deepseek-r1 at effort high; ultracode is disabled/);
	await host.command("profile list");
	assert.match(host.last() ?? "", /^builtin \(current, modified; default for new sessions\)$/m);

	// A run admitted while the editor is open: the apply is refused and nothing changes.
	const racing = sdkHost({ backends: { claude: claude.backend } });
	await racing.start();
	let run: Awaited<ReturnType<typeof heldRun>> | undefined;
	// The last answer is a dialog still open while a run is admitted, which is what the apply has to notice.
	racing.dialogs.push(row("ask"), "enabled: yes", "Back", async () => {
		run = await heldRun(racing, claude);
		return "Apply";
	});
	await racing.command("config");
	assert.equal(racing.last(), "fusion settings stay as they are while runs are unfinished: run-1 (implement). Wait for each run or cancel it with /fusion cancel run-N, then retry.");
	assert.match(racing.tools.get("fusion")!.description, /ask runs on claude with model opus at effort high/, "the ask role is still enabled");
	run!.release();
	await run!.call;
});

test("an empty answer changes nothing, and a backend changed and changed back starts from that backend's own defaults", async () => {
	const host = sdkHost({
		dialogs: [
			(options) => options.find((option) => option.startsWith("ask ")),
			"model: opus",
			"",
			"Back",
			"Apply",
			"Cancel",
		],
	});
	await host.start();
	await host.command("config");
	// An empty input leaves the model as it was, so this draft is the built-in one and applying it changes nothing.
	assert.equal(host.notices.at(-1)?.[0], "fusion config: nothing changed");
	const blanked = sdkHost({ dialogs: [(options) => options.find((option) => option.startsWith("plan ")), "backend: claude", "pi", "Back", (options) => options.find((option) => option.startsWith("plan ")), "backend: pi", "claude", "Back", "Apply"] });
	await blanked.start();
	await blanked.command("config");
	assert.equal(blanked.last(), "fusion config: nothing changed", "a backend changed and changed back starts from that backend's own defaults again");
});

test("a re-registration keeps the host's active tools exactly as they were, under an allow list, while off, and between changes", async () => {
	const store = memoryProfileStore(document({ work: WORK, other: settings({ ask: { enabled: false, backend: "claude" } }) }));
	// The host allows `write` as well, and the user has it off: a refresh must not turn it back on.
	const host = sdkHost({ profiles: store, allowed: ["read", "bash", "write", "fusion", "fusion_control", "claude", "claude_control"], ui: false });
	await host.start();
	assert.deepEqual(host.active, ["read", "bash", "fusion", "claude", "fusion_control", "claude_control"]);
	const before = host.registrations.length;
	await host.command("profile use work");
	assert.ok(host.registrations.length > before, "applying a profile re-registered the guidance");
	assert.deepEqual(host.active, ["read", "bash", "fusion", "claude", "fusion_control", "claude_control"], "write stays off");

	// The list is read fresh for each re-registration, so a change made between two applications is kept.
	host.active.splice(host.active.indexOf("bash"), 1);
	await host.command("profile use other");
	assert.deepEqual(host.active, ["read", "fusion", "claude", "fusion_control", "claude_control"]);

	// While off, a profile change re-registers the tools and leaves them hidden; on gives back what off hid.
	await host.command("off");
	assert.deepEqual(host.active, ["read"]);
	await host.command("profile use work");
	assert.equal(host.last(), "fusion uses profile work in this session; disabled: ultracode");
	assert.deepEqual(host.active, ["read"], "nothing the allow list names came back while fusion is off");
	assert.match(host.tools.get("fusion")!.description, /implement runs on claude with model sonnet/, "and the hidden tools carry the new guidance");
	await host.command("on");
	assert.deepEqual(host.active, ["read", "fusion", "claude", "fusion_control", "claude_control"]);
	// A profile whose guidance is the same as the current one re-registers nothing.
	const settled = host.registrations.length;
	await host.command("profile use work");
	assert.equal(host.registrations.length, settled);
});

test("a guidance refresh that throws puts the previous configuration and its guidance back", async () => {
	const store = memoryProfileStore(document({ work: WORK }));
	const host = sdkHost({ profiles: store, ui: false });
	await host.start();
	const tools = host.tools;
	const original = tools.get("fusion")!.description;
	// The next registration of the claude tool throws, as a stale extension runtime's would.
	let armed = true;
	const set = tools.set.bind(tools);
	tools.set = ((name: string, tool: Tool) => {
		if (armed && name === "claude") {
			armed = false;
			throw new Error("extension runtime is stale");
		}
		return set(name, tool);
	}) as typeof tools.set;
	await host.command("profile use work");
	assert.equal(host.last(), "fusion settings stay as they are: the host's tool guidance did not change: extension runtime is stale");
	assert.equal(tools.get("fusion")!.description, original, "the fusion tool, re-registered first, was put back");
	await host.command("profile list");
	assert.match(host.last() ?? "", /^builtin \(current/);
});

test("the profile chooser lists every profile with its marks and loads the one picked, and closing it changes nothing", async () => {
	const store = memoryProfileStore(document({ work: WORK }, "work"));
	const host = sdkHost({
		profiles: store,
		dialogs: [
			(options) => {
				assert.deepEqual(options, ["builtin", "work (current; default for new sessions)"]);
				return "builtin";
			},
			undefined,
		],
	});
	await host.start();
	await host.command("profile");
	assert.equal(host.titles.at(-1), "fusion profile: load one into this session");
	assert.equal(host.last(), "fusion uses profile builtin in this session");
	await host.command("profile");
	assert.equal(host.last(), "fusion profile: nothing changed");
	assert.match(host.tools.get("fusion")!.description, /ultracode runs on claude with model fable/);
});
