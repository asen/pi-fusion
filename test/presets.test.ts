import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileHostPolicyLoader, HOST_POLICY_FILE, memoryHostPolicyLoader, SHIPPED_HOST_POLICY_PATH } from "../extensions/host-policy.ts";
import {
	ARCHITECT_DIR,
	filePresetDefaults,
	memoryPresetDefaults,
	parsePresetFile,
	PRESET_ENTRY,
	PRESET_NAMES,
	type PresetName,
	resolvePreset,
	type SessionPreset,
	sessionPreset,
	UNTRUSTED_PROJECT,
} from "../extensions/presets.ts";
import { fileRoleContractLoader, memoryRoleContractLoader, ROLE_CONTRACT_FILES, roleContractBody, SHIPPED_ROLE_CONTRACTS_DIR } from "../extensions/role-contract-loader.ts";

/**
 * Preset selection and the sources each preset reads, as pure functions and loaders over temporary roots and memory.
 * Nothing here registers the extension, reads the user's own preset or instruction files, or starts a child.
 */

const entry = (data: unknown, customType = PRESET_ENTRY) => ({ type: "custom", customType, data });
const choice = (preset: PresetName | null) => entry({ version: 1, preset });

function root(t: { after: (fn: () => void) => void }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-presets-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const write = (file: string, text: string): string => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
};

const contract = (label: string, body = `Child ${label}.\n`): string => `---\nhost:\n  description: Host ${label}.\n  guidance: []\n  task_brief: Brief ${label}.\n  snippet: Snippet ${label}.\n---\n\n${body}`;

test("the branch's latest preset entry decides; an unusable latest entry never falls back to an earlier one", () => {
	assert.deepEqual(sessionPreset([]), { kind: "none" });
	assert.deepEqual(sessionPreset([choice("architect"), entry({ run: "run-1" }, "pi-fusion"), choice("builtin")]), { kind: "set", preset: "builtin" });
	assert.deepEqual(sessionPreset([choice("architect"), choice(null)]), { kind: "set", preset: null });
	for (const latest of [{ version: 2, preset: "builtin" }, { version: 1, preset: "custom" }, { version: 1, preset: "builtin", extra: true }, "builtin", null]) {
		const read = sessionPreset([choice("architect"), entry(latest)]);
		assert.equal(read.kind, "invalid", JSON.stringify(latest));
	}
	assert.match((sessionPreset([entry({ version: 1, preset: "PRIVATE_NAME" })]) as { reason: string }).reason, /names no preset this build has/);
	assert.doesNotMatch((sessionPreset([entry({ version: 1, preset: "PRIVATE_NAME" })]) as { reason: string }).reason, /PRIVATE/);
});

test("a preset file holds a version and one of the five names or null; diagnostics never repeat its contents", () => {
	assert.equal(parsePresetFile('{"version":1,"defaultPreset":"architect"}', "f"), "architect");
	assert.equal(parsePresetFile('{"version":1,"defaultPreset":null}', "f"), null);
	assert.equal(parsePresetFile('{"version":1}', "f"), null);
	for (const [text, why] of [
		["PRIVATE_TEXT", /is not valid JSON/],
		['["PRIVATE"]', /must hold a JSON object/],
		['{"version":2,"defaultPreset":"PRIVATE"}', /has a version this build does not read/],
		['{"version":1,"PRIVATE_KEY":1}', /has an unknown field/],
		['{"version":1,"defaultPreset":"PRIVATE"}', /names no preset this build has/],
		['{"version":1,"defaultPreset":"default"}', /names no preset this build has/],
	] as const) {
		assert.throws(() => parsePresetFile(text, "/p/preset.json"), (error: Error) => why.test(error.message) && !/PRIVATE/.test(error.message), text);
	}
	assert.deepEqual([...PRESET_NAMES], ["builtin", "architect", "user", "project", "auto"]);
});

test("selection precedence: session, then a trusted project's default, then the user's, then auto; the first that names one stops the reads", async () => {
	const trusted = { cwd: "/p", projectTrusted: true };
	const untrusted = { cwd: "/p", projectTrusted: false };
	const none: SessionPreset = { kind: "none" };
	const cases: Array<[SessionPreset, Parameters<typeof memoryPresetDefaults>[0], typeof trusted, string, string, string[]]> = [
		[{ kind: "set", preset: "builtin" }, { project: { error: "is broken" }, user: { error: "is broken" } }, trusted, "builtin", "session", []],
		[none, { project: "architect", user: { error: "is broken" } }, trusted, "architect", "project default", ["project"]],
		[none, { project: "auto", user: "builtin" }, trusted, "auto", "project default", ["project"]],
		[none, { project: { error: "is broken" }, user: "builtin" }, untrusted, "builtin", "user default", ["user"]],
		[none, { project: null, user: "user" }, trusted, "user", "user default", ["project", "user"]],
		[none, {}, trusted, "auto", "fallback", ["project", "user"]],
		[{ kind: "set", preset: null }, { user: "architect" }, untrusted, "architect", "user default", ["user"]],
	];
	for (const [session, defaults, context, preset, from, reads] of cases) {
		const store = memoryPresetDefaults(defaults);
		assert.deepEqual(await resolvePreset(session, context, store), { preset, from }, JSON.stringify([session, defaults]));
		assert.deepEqual(store.reads, reads, JSON.stringify([session, defaults]));
	}
});

test("selection refuses rather than choosing another source: an unusable entry or default, or project without trust", async () => {
	const trusted = { cwd: "/p", projectTrusted: true };
	await assert.rejects(resolvePreset({ kind: "invalid", reason: "the latest preset entry on this branch has a version this build does not read" }, trusted, memoryPresetDefaults({ user: "builtin" })), /\/fusion preset use <name> or clear it with \/fusion preset reset, then \/reload/);
	// A cleared session choice follows the defaults, so it does not get past an unusable default file; an explicit choice does.
	await assert.rejects(resolvePreset({ kind: "set", preset: null }, trusted, memoryPresetDefaults({ user: { error: "is not valid JSON" } })), /is not valid JSON/);
	await assert.rejects(resolvePreset({ kind: "none" }, trusted, memoryPresetDefaults({ project: { error: "is not valid JSON" }, user: "builtin" })), /is not valid JSON/);
	assert.deepEqual(await resolvePreset({ kind: "set", preset: "builtin" }, trusted, memoryPresetDefaults({ user: { error: "is not valid JSON" } })), { preset: "builtin", from: "session" });
	for (const [session, defaults, by] of [
		[{ kind: "set", preset: "project" }, {}, /session's choice/],
		[{ kind: "none" }, { user: "project" }, /user default/],
	] as const) {
		await assert.rejects(resolvePreset(session as SessionPreset, { cwd: "/p", projectTrusted: false }, memoryPresetDefaults(defaults)), (error: Error) => error.message.startsWith(UNTRUSTED_PROJECT) && by.test(error.message));
	}
	assert.deepEqual(await resolvePreset({ kind: "set", preset: "project" }, trusted, memoryPresetDefaults()), { preset: "project", from: "session" });
});

test("preset files: reading creates nothing, a dangling link is present and unusable, and a write refuses a file it cannot read", async (t) => {
	const dir = root(t);
	const agent = path.join(dir, "agent");
	const cwd = path.join(dir, "project");
	fs.mkdirSync(cwd);
	const store = filePresetDefaults(async () => agent);
	assert.equal(await store.read("user", cwd), undefined);
	assert.equal(await store.read("project", cwd), undefined);
	assert.deepEqual([fs.existsSync(agent), fs.readdirSync(cwd)], [false, []], "reads create nothing");
	await store.write("project", cwd, "architect");
	const project = path.join(cwd, ".pi", "pi-fusion", "preset.json");
	assert.equal(await store.where("project", cwd), project);
	assert.deepEqual(JSON.parse(fs.readFileSync(project, "utf8")), { version: 1, defaultPreset: "architect" });
	if (process.platform !== "win32") assert.equal(fs.statSync(project).mode & 0o777, 0o600);
	assert.equal(await store.read("project", cwd), "architect");
	await store.write("project", cwd, null);
	assert.equal(await store.read("project", cwd), undefined, "a cleared default selects nothing");
	const user = write(path.join(agent, "pi-fusion", "preset.json"), "PRIVATE_TEXT");
	await assert.rejects(store.read("user", cwd), (error: Error) => /is not valid JSON/.test(error.message) && !/PRIVATE/.test(error.message));
	await assert.rejects(store.write("user", cwd, "builtin"), /is not valid JSON/);
	assert.equal(fs.readFileSync(user, "utf8"), "PRIVATE_TEXT", "an unusable file is never replaced by a command");
	fs.rmSync(user);
	fs.symlinkSync(path.join(dir, "absent.json"), user);
	await assert.rejects(store.read("user", cwd), /is a link to a missing file/);
});

/** Locators that record each scope they were asked for; none of these cases means a scope it did not name to be located. */
function locators(dir: string) {
	const located: string[] = [];
	return {
		located,
		user: () => (located.push("user"), path.join(dir, "user")),
		project: () => (located.push("project"), path.join(dir, "project")),
	};
}

test("each preset reads only its own sources: builtin and architect read no override, user no project, project no user", async (t) => {
	const dir = root(t);
	for (const scope of ["user", "project"]) {
		write(path.join(dir, scope, "implement.md"), contract(`${scope} implement`));
		write(path.join(dir, scope, "host.md"), `${scope} policy\n`);
	}
	const expected: Record<PresetName, { implement: string; plan: string; policy: string; located: string[] }> = {
		builtin: { implement: "shipped", plan: "shipped", policy: "shipped", located: [] },
		architect: { implement: "bundled", plan: "bundled", policy: "bundled", located: [] },
		user: { implement: "override", plan: "shipped", policy: "override", located: ["user"] },
		project: { implement: "project", plan: "shipped", policy: "project", located: ["project"] },
		auto: { implement: "project", plan: "shipped", policy: "project", located: ["project", "user"] },
	};
	for (const preset of PRESET_NAMES) {
		const roles = locators(dir);
		const loaded = await fileRoleContractLoader({ shipped: SHIPPED_ROLE_CONTRACTS_DIR, override: roles.user, project: roles.project }).load({ cwd: dir, projectTrusted: true, preset });
		assert.equal(loaded.files["implement.md"].source, expected[preset].implement, preset);
		assert.equal(loaded.files["plan.md"].source, expected[preset].plan, `${preset}: a file a partial source lacks comes from builtin`);
		assert.deepEqual([...new Set(roles.located)], expected[preset].located, `${preset}: role scopes located`);
		const policies = locators(dir);
		const policy = await fileHostPolicyLoader({ shipped: SHIPPED_HOST_POLICY_PATH, override: () => path.join(policies.user(), HOST_POLICY_FILE), project: () => path.join(policies.project(), HOST_POLICY_FILE) }).load({ cwd: dir, projectTrusted: true, preset });
		assert.equal(policy.source, expected[preset].policy, `${preset}: policy`);
		// A valid project policy is selected whole, so auto never needs the user scope for it.
		assert.deepEqual(policies.located, preset === "auto" ? ["project"] : expected[preset].located, `${preset}: policy scopes located`);
	}
	// A partial user source falls back to builtin, never to the project; and a broken excluded source cannot fail a preset.
	write(path.join(dir, "project", "plan.md"), contract("project plan"));
	write(path.join(dir, "user", "ultracode.md"), "NOT A CONTRACT");
	const user = await fileRoleContractLoader({ shipped: SHIPPED_ROLE_CONTRACTS_DIR, override: () => path.join(dir, "user"), project: () => path.join(dir, "project") }).load({ cwd: dir, projectTrusted: true, preset: "user" });
	assert.equal(user.files["plan.md"].source, "shipped");
	assert.equal(user.unavailable.ultracode !== undefined, true, "an unusable file in the selected scope still closes its role");
	for (const preset of ["builtin", "architect", "project"] as const) {
		const loaded = await fileRoleContractLoader({ shipped: SHIPPED_ROLE_CONTRACTS_DIR, override: () => path.join(dir, "user"), project: () => path.join(dir, "project") }).load({ cwd: dir, projectTrusted: true, preset });
		assert.notEqual(loaded.files["ultracode.md"].source, "override", `${preset} never reads the broken user file`);
		assert.equal(loaded.files["ultracode.md"].unusable, undefined, preset);
	}
});

test("project without a trusted project source refuses in both loaders rather than becoming builtin", async () => {
	await assert.rejects(fileRoleContractLoader({ shipped: SHIPPED_ROLE_CONTRACTS_DIR, override: () => "/nowhere" }).load({ cwd: "/p", projectTrusted: false, preset: "project" }), (error: Error) => error.message === UNTRUSTED_PROJECT);
	await assert.rejects(fileHostPolicyLoader({ shipped: SHIPPED_HOST_POLICY_PATH, override: () => "/nowhere" }).load({ cwd: "/p", projectTrusted: false, preset: "project" }), (error: Error) => error.message === UNTRUSTED_PROJECT);
	await assert.rejects(memoryRoleContractLoader({ project: { "plan.md": contract("p") } }).load({ cwd: "/p", projectTrusted: false, preset: "project" }), (error: Error) => error.message === UNTRUSTED_PROJECT);
	await assert.rejects(memoryHostPolicyLoader({ project: "Project policy.\n" }).load({ cwd: "/p", projectTrusted: false, preset: "project" }), (error: Error) => error.message === UNTRUSTED_PROJECT);
});

test("memory loaders honour every preset: overrides are the user scope, project needs trust, architect is the bundle", async () => {
	const sources = { overrides: { "implement.md": contract("user") }, project: { "implement.md": contract("project") } } as const;
	const body = async (preset: PresetName, projectTrusted = true) => roleContractBody(await memoryRoleContractLoader(sources).load({ cwd: "/p", projectTrusted, preset }), "implement.md");
	assert.equal(await body("user"), "Child user.\n");
	assert.equal(await body("project"), "Child project.\n");
	assert.equal(await body("auto"), "Child project.\n");
	assert.equal(await body("auto", false), "Child user.\n");
	assert.equal(await body("builtin"), (await memoryRoleContractLoader().load()).files["implement.md"].body);
	assert.equal(await body("architect"), fs.readFileSync(path.join(ARCHITECT_DIR, "contracts", "implement.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n\n?/, ""));
	assert.equal((await memoryRoleContractLoader({ user: { "plan.md": contract("named user") } }).load({ cwd: "/p", projectTrusted: false, preset: "user" })).files["plan.md"].body, "Child named user.\n");
	const policy = memoryHostPolicyLoader({ override: "User policy.\n", project: "Project policy.\n" });
	assert.equal((await policy.load({ cwd: "/p", projectTrusted: true, preset: "auto" })).text, "Project policy.\n");
	assert.equal((await policy.load({ cwd: "/p", projectTrusted: false, preset: "auto" })).text, "User policy.\n");
	assert.equal((await policy.load({ cwd: "/p", projectTrusted: true, preset: "user" })).text, "User policy.\n");
	assert.equal((await policy.load({ cwd: "/p", projectTrusted: true, preset: "architect" })).source, "bundled");
});

test("the bundled architect preset is complete and valid: its policy, three unavailable roles, two defaults and independent review", async () => {
	const loaded = await memoryRoleContractLoader().load({ cwd: "/p", projectTrusted: false, preset: "architect" });
	for (const name of ROLE_CONTRACT_FILES) {
		assert.equal(loaded.files[name].source, "bundled", name);
		assert.equal(loaded.files[name].path, path.join(ARCHITECT_DIR, "contracts", name));
		assert.equal(loaded.files[name].diagnostic, undefined, name);
	}
	assert.deepEqual(Object.keys(loaded.unavailable).sort(), ["plan", "security", "ultracode"]);
	for (const name of ["plan.md", "ultracode.md", "security.md"] as const) {
		assert.throws(() => roleContractBody(loaded, name), /is unavailable/);
		assert.equal(loaded.files[name].body, "", `${name} has no child instructions to send`);
	}
	assert.deepEqual(loaded.defaults, {
		implement: { backend: "claude", model: "opus[1m]", effort: "high", path: path.join(ARCHITECT_DIR, "contracts", "implement.md") },
		ask: { backend: "codex", model: "gpt-6.1-sol", effort: "high", path: path.join(ARCHITECT_DIR, "contracts", "ask-answer.md") },
	});
	const review = roleContractBody(loaded, "ask-review.md");
	assert.match(review, /^# Independent code review/);
	assert.match(review, /you did not write it and do not implement fixes/);
	assert.match(roleContractBody(loaded, "implement.md"), /^You are the implementer\./);
	assert.match(roleContractBody(loaded, "ask-answer.md"), /external web researcher/);
	const policy = await memoryHostPolicyLoader().load({ cwd: "/p", projectTrusted: false, preset: "architect" });
	assert.deepEqual([policy.source, policy.path, policy.diagnostic], ["bundled", path.join(ARCHITECT_DIR, HOST_POLICY_FILE), undefined]);
	assert.match(policy.text, /^# Architect policy\n/);
	assert.match(policy.text, /This preset's role contracts make `plan`, `ultracode` and `security` unavailable/);
	assert.match(policy.text, /Handle small, low-risk, self-contained, user-authorized tasks directly/);
	assert.match(policy.text, /Judge by risk, ambiguity and context needs, not line count\./);
	assert.match(policy.text, /Do not split larger work to fit this exception\./);
	assert.match(policy.text, /Direct tasks need no implementer critique cycle\./);
	assert.doesNotMatch(policy.text, /Implement directly only when the user explicitly asks you to\./);
	for (const file of [HOST_POLICY_FILE, ...ROLE_CONTRACT_FILES.map((name) => path.join("contracts", name))]) {
		assert.doesNotMatch(fs.readFileSync(path.join(ARCHITECT_DIR, file), "utf8"), /\bthis project's (role|review|ask|contract)|in this project\b/i, `${file} speaks of this preset, not a project`);
	}
});

test("architect separates research from read-only review and keeps selective review, triage and escalation in the host policy", async () => {
	const context = { cwd: "/p", projectTrusted: false, preset: "architect" as const };
	const loaded = await memoryRoleContractLoader().load(context);
	const answer = roleContractBody(loaded, "ask-answer.md");
	const review = roleContractBody(loaded, "ask-review.md");
	assert.match(answer, /Do not inspect local project files, Git history or diffs, run project code\/tests\/builds, or perform code review/);
	assert.match(answer, /If web access or a needed source is unavailable, say so explicitly/);
	assert.match(review, /Inspect the named working-tree change, commit range or files/);
	assert.match(review, /Do not modify repository files, implement fixes, change Git state/);
	assert.match(review, /Run only documented, model-free verification that leaves the working tree unchanged/);
	assert.match(review, /Return findings to the Architect, not directly to the implementer/);
	assert.match(review, /Use `ask_orchestrator` for missing details or blockers/);
	assert.match(review, /After one substantive Architect response/);
	assert.match(review, /Existing discussion limits do not reset for a review finding/);
	assert.match(review, /Do not paste the patch or full command output/);
	for (const heading of ["Verdict", "Findings", "Verification", "Notes and limits", "Escalation"]) assert.ok(review.includes(`## ${heading}\n`), heading);
	const metadata = loaded.guidance.ask;
	assert.match(metadata.description, /answer mode.*review mode/);
	assert.match(metadata.guidance.join("\n"), /Answer mode is web-research only/);
	assert.match(metadata.guidance.join("\n"), /Review mode is read-only code review/);
	assert.match(metadata.task_brief, /answer mode.*review mode/);
	assert.doesNotMatch(JSON.stringify(metadata), /declines|no repository investigation or code review/);
	const policy = (await memoryHostPolicyLoader().load(context)).text;
	assert.match(policy, /risk, complexity, subsystem interactions or context cost/);
	assert.match(policy, /Small, clear, low-risk changes get proportionate host checks/);
	assert.match(policy, /Prefer one fresh reviewer at a coherent completion boundary/);
	assert.match(policy, /Automatic review must remain unset or disabled/);
	assert.match(policy, /spot-check relevant critical paths rather than routinely repeating the entire large-diff inspection/);
	assert.match(policy, /Triage them and relay accepted findings/);
	assert.match(policy, /Escalate review findings that require a user decision or remain disputed after one substantive Architect response/);
	assert.match(policy, /Do not force agreement or reset existing discussion limits/);
	assert.doesNotMatch(policy, /`ask` only for external web research|Do not use `ask` review mode|review contract declines/);
});

test("an unusable bundled preset fails its selection, after builtin is validated, and never borrows a missing file from builtin", async (t) => {
	const dir = root(t);
	const copy = path.join(dir, "architect");
	fs.cpSync(ARCHITECT_DIR, copy, { recursive: true });
	const roles = (architect: string, shipped = SHIPPED_ROLE_CONTRACTS_DIR) => fileRoleContractLoader({ shipped, override: () => { throw new Error("must not locate"); }, architect }).load({ cwd: dir, projectTrusted: false, preset: "architect" });
	assert.deepEqual(Object.keys((await roles(copy)).unavailable).sort(), ["plan", "security", "ultracode"]);
	fs.rmSync(path.join(copy, "contracts", "implement.md"));
	await assert.rejects(roles(copy), /the shipped architect preset role contract implement\.md .* is missing/);
	fs.writeFileSync(path.join(copy, "contracts", "implement.md"), "No metadata.");
	await assert.rejects(roles(copy), /the shipped architect preset role contract implement\.md .* is invalid/);
	fs.cpSync(path.join(ARCHITECT_DIR, "contracts", "implement.md"), path.join(copy, "contracts", "implement.md"));
	fs.writeFileSync(path.join(copy, HOST_POLICY_FILE), " \n");
	await assert.rejects(fileHostPolicyLoader({ shipped: SHIPPED_HOST_POLICY_PATH, override: () => { throw new Error("must not locate"); }, architect: copy }).load({ cwd: dir, projectTrusted: false, preset: "architect" }), /the shipped architect preset host policy .* is blank/);
	// A broken builtin install fails first, whichever preset is selected.
	const shipped = path.join(dir, "shipped");
	fs.cpSync(SHIPPED_ROLE_CONTRACTS_DIR, shipped, { recursive: true });
	fs.writeFileSync(path.join(shipped, "plan.md"), " \n");
	await assert.rejects(roles(ARCHITECT_DIR, shipped), /the shipped role contract plan\.md .* is blank/);
});
