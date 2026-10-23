import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileHostPolicyLoader, hostPolicyLoader, memoryHostPolicyLoader } from "../extensions/host-policy.ts";
import { INSTRUCTION_MAX_BYTES, instructionSourceLabel } from "../extensions/instruction-files.ts";
import { fileRoleContractLoader, memoryRoleContractLoader, ROLE_CONTRACT_FILES, roleContractLoader, SHIPPED_ROLE_CONTRACTS_DIR } from "../extensions/role-contract-loader.ts";

/** All roots, including both agent and project directories, belong to the case. */
function fixture(t: { after: (fn: () => void) => void }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-project-instructions-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agent = path.join(root, "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agent);
	fs.mkdirSync(cwd);
	return { root, agent, cwd, user: path.join(agent, "pi-fusion"), project: path.join(cwd, ".pi", "pi-fusion") };
}

const write = (file: string, text: string | Uint8Array): string => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
};
const contract = (label: string): string => `---\nhost:\n  description: Host ${label}.\n  guidance: []\n  task_brief: Brief ${label}.\n  snippet: Snippet ${label}.\n---\n\nChild ${label}.\n`;

test("missing project files fall back individually to user and shipped files without creating directories", async (t) => {
	const f = fixture(t);
	write(path.join(f.user, "host.md"), "User policy.\n");
	write(path.join(f.user, "contracts", "implement.md"), contract("user"));
	const context = { cwd: f.cwd, projectTrusted: true };
	const policy = await hostPolicyLoader(async () => f.agent).load(context);
	const roles = await roleContractLoader(async () => f.agent).load(context);
	assert.equal(policy.source, "override");
	assert.equal(policy.text, "User policy.\n");
	assert.equal(roles.files["implement.md"].source, "override");
	assert.equal(roles.files["implement.md"].body, "Child user.\n");
	assert.equal(roles.files["plan.md"].source, "shipped");
	assert.deepEqual(fs.readdirSync(f.cwd), [], "loading does not even create .pi");
});

test("a project can replace only one role, retaining other user overrides and shipped roles", async (t) => {
	const f = fixture(t);
	write(path.join(f.user, "host.md"), "User policy.\n");
	write(path.join(f.user, "contracts", "implement.md"), contract("user implement"));
	write(path.join(f.user, "contracts", "ask-answer.md"), contract("user ask"));
	const projectPolicy = write(path.join(f.project, "host.md"), "Project policy.\n");
	const projectRole = write(path.join(f.project, "contracts", "implement.md"), contract("project implement"));
	const context = { cwd: f.cwd, projectTrusted: true };
	assert.deepEqual(await hostPolicyLoader(async () => f.agent).load(context), { text: "Project policy.\n", source: "project", path: projectPolicy });
	const roles = await roleContractLoader(async () => f.agent).load(context);
	assert.equal(roles.files["implement.md"].path, projectRole);
	assert.equal(roles.files["implement.md"].source, "project");
	assert.equal(roles.files["implement.md"].body, "Child project implement.\n");
	assert.equal(roles.guidance.implement.description, "Host project implement.");
	assert.equal(roles.guidance.ask.description, "Host user ask.");
	assert.equal(roles.files["ask-answer.md"].source, "override");
	assert.equal(roles.files["ask-review.md"].source, "shipped");
	assert.deepEqual(fs.readdirSync(path.join(f.project, "contracts")), ["implement.md"]);
	assert.equal(instructionSourceLabel(roles.files["implement.md"]), "project override");
});

test("valid project files do not consult lower-priority user paths", async (t) => {
	const f = fixture(t);
	write(path.join(f.project, "host.md"), "Project policy.\n");
	for (const name of ROLE_CONTRACT_FILES) write(path.join(f.project, "contracts", name), name === "ask-review.md" ? "Project review.\n" : contract(name));
	let userResolutions = 0;
	const user = async (): Promise<string> => { userResolutions++; throw new Error("must not resolve user paths"); };
	const context = { cwd: f.cwd, projectTrusted: true };
	assert.equal((await hostPolicyLoader(user).load(context)).source, "project");
	const roles = await roleContractLoader(user).load(context);
	assert.ok(Object.values(roles.files).every((file) => file.source === "project" && file.diagnostic === undefined));
	assert.equal(userResolutions, 0);
});

test("invalid project policies fall back with diagnostics, retaining reasons when both override layers fail", async (t) => {
	const f = fixture(t);
	const user = write(path.join(f.user, "host.md"), "User policy.\n");
	const context = { cwd: f.cwd, projectTrusted: true };
	const project = path.join(f.project, "host.md");
	for (const [text, why] of [["", /is empty/], [" \n", /is blank/], [Uint8Array.from([0xff]), /not valid UTF-8/], ["x".repeat(INSTRUCTION_MAX_BYTES + 1), /larger than/]] as const) {
		write(project, text);
		const selected = await hostPolicyLoader(async () => f.agent).load(context);
		assert.equal(selected.path, user);
		assert.equal(selected.source, "override");
		assert.match(selected.diagnostic!, why);
		assert.ok(selected.diagnostic!.includes(project));
		assert.match(selected.diagnostic!, /using the user host policy instead$/);
		assert.equal(instructionSourceLabel(selected), "user override (project override set aside)");
	}
	write(project, " \n");
	write(user, " \n");
	const both = await hostPolicyLoader(async () => f.agent).load(context);
	assert.equal(both.source, "shipped");
	assert.ok(both.diagnostic!.includes(project));
	assert.ok(both.diagnostic!.includes(user));
	assert.match(both.diagnostic!, /using the shipped host policy instead$/);
	fs.rmSync(project);
	fs.mkdirSync(project);
	assert.match((await hostPolicyLoader(async () => f.agent).load(context)).diagnostic!, /not a regular file/);
});

test("invalid project contracts fall back whole, never mixing project bodies with user metadata", async (t) => {
	const f = fixture(t);
	const user = write(path.join(f.user, "contracts", "implement.md"), contract("user"));
	const project = write(path.join(f.project, "contracts", "implement.md"), "Project body without its required metadata.\n");
	write(path.join(f.project, "contracts", "ask-review.md"), "Project review.\n");
	const context = { cwd: f.cwd, projectTrusted: true };
	const first = await roleContractLoader(async () => f.agent).load(context);
	assert.equal(first.files["implement.md"].path, user);
	assert.equal(first.files["implement.md"].body, "Child user.\n");
	assert.equal(first.guidance.implement.description, "Host user.");
	assert.match(first.files["implement.md"].diagnostic!, /no host frontmatter/);
	assert.equal(first.files["ask-review.md"].source, "project", "a bad file does not discard another project override");
	write(project, "---\nhost: [PRIVATE_PROJECT_VALUE\n---\nBody.");
	write(user, "Invalid user contract without metadata.");
	const both = (await roleContractLoader(async () => f.agent).load(context)).files["implement.md"];
	assert.equal(both.source, "shipped");
	assert.ok(both.diagnostic!.includes(project));
	assert.ok(both.diagnostic!.includes(user));
	assert.doesNotMatch(both.diagnostic!, /PRIVATE_PROJECT_VALUE/);
});

test("project lookup requires affirmative context trust; memory loaders never consult project files", async (t) => {
	const f = fixture(t);
	write(path.join(f.user, "host.md"), "User policy.\n");
	write(path.join(f.project, "host.md"), " \n");
	write(path.join(f.project, "contracts", "implement.md"), "Invalid project contract.");
	for (const context of [undefined, { cwd: f.cwd, projectTrusted: false }]) {
		const policy = await hostPolicyLoader(async () => f.agent).load(context);
		assert.equal(policy.source, "override");
		assert.equal(policy.diagnostic, undefined, "the invalid project file was not consulted");
		const roles = await roleContractLoader(async () => f.agent).load(context);
		assert.equal(roles.files["implement.md"].source, "shipped");
		assert.equal(roles.files["implement.md"].diagnostic, undefined);
	}
	const context = { cwd: f.cwd, projectTrusted: true };
	assert.equal((await memoryHostPolicyLoader().load(context)).source, "shipped");
	assert.ok(Object.values((await memoryRoleContractLoader().load(context)).files).every((file) => file.source === "shipped" && file.diagnostic === undefined));
});

test("lookup uses the supplied session cwd, searches no ancestors, and snapshots stay independent between projects", async (t) => {
	const f = fixture(t);
	write(path.join(f.project, "host.md"), "First project.\n");
	const projectRole = write(path.join(f.project, "contracts", "implement.md"), contract("first project"));
	const nested = path.join(f.cwd, "nested");
	fs.mkdirSync(nested);
	write(path.join(nested, ".pi", "pi-fusion", "host.md"), "Nested project.\n");
	const policies = hostPolicyLoader(async () => f.agent);
	assert.equal((await policies.load({ cwd: f.cwd, projectTrusted: true })).text, "First project.\n");
	assert.equal((await policies.load({ cwd: nested, projectTrusted: true })).text, "Nested project.\n");
	const roles = roleContractLoader(async () => f.agent);
	const first = await roles.load({ cwd: f.cwd, projectTrusted: true });
	assert.equal((await roles.load({ cwd: nested, projectTrusted: true })).files["implement.md"].source, "shipped", "parent contracts do not leak into nested working directories");
	write(projectRole, contract("edited"));
	assert.equal(first.files["implement.md"].body, "Child first project.\n");
	assert.equal((await roles.load({ cwd: f.cwd, projectTrusted: true })).files["implement.md"].body, "Child edited.\n");
});

test("project path-resolution failures fall back, and a failed contract directory is resolved only once", async (t) => {
	const f = fixture(t);
	const userPolicy = write(path.join(f.user, "host.md"), "User policy.\n");
	const shippedPolicy = write(path.join(f.root, "shipped.md"), "Shipped policy.\n");
	const policy = await fileHostPolicyLoader({ shipped: shippedPolicy, override: () => userPolicy, project: () => { throw new Error("no project path"); } }).load();
	assert.equal(policy.source, "override");
	assert.match(policy.diagnostic!, /project host policy override could not be located \(no project path\)/);
	write(path.join(f.user, "contracts", "implement.md"), contract("user"));
	let resolutions = 0;
	const roles = await fileRoleContractLoader({ shipped: SHIPPED_ROLE_CONTRACTS_DIR, override: () => path.join(f.user, "contracts"), project: () => { resolutions++; throw new Error("no project directory"); } }).load();
	assert.equal(resolutions, 1);
	assert.equal(roles.files["implement.md"].source, "override");
	assert.equal(roles.files["implement.md"].body, "Child user.\n");
	assert.ok(Object.values(roles.files).every((file) => file.diagnostic!.includes("no project directory")));
});

test("broken shipped files fail before either project or user paths are resolved", async (t) => {
	const f = fixture(t);
	let resolutions = 0;
	const resolve = (): string => { resolutions++; throw new Error("must not resolve overrides"); };
	await assert.rejects(fileHostPolicyLoader({ shipped: path.join(f.root, "missing.md"), override: resolve, project: resolve }).load(), /shipped host policy .* is missing/);
	const shipped = path.join(f.root, "shipped");
	fs.mkdirSync(shipped);
	for (const name of ROLE_CONTRACT_FILES) fs.copyFileSync(path.join(SHIPPED_ROLE_CONTRACTS_DIR, name), path.join(shipped, name));
	fs.rmSync(path.join(shipped, "security.md"));
	await assert.rejects(fileRoleContractLoader({ shipped, override: resolve, project: resolve }).load(), /shipped role contract security.md .* is missing/);
	assert.equal(resolutions, 0);
});
