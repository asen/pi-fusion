import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { INSTRUCTION_MAX_BYTES } from "../extensions/instruction-files.ts";
import { fileRoleContractLoader, memoryRoleContractLoader, ROLE_CONTRACT_FILES, ROLE_CONTRACTS, roleContractBody, roleContractLoader, SHIPPED_ROLE_CONTRACTS_DIR } from "../extensions/role-contract-loader.ts";
import { parseRoleContract } from "../extensions/role-contracts.ts";

const contract = (label: string, body = `Child ${label}.\n`): string => `---\nhost:\n  description: Host ${label}.\n  guidance:\n    - Guidance ${label}.\n  task_brief: Brief ${label}.\n  snippet: Snippet ${label}.\n---\n\n${body}`;

/** Temporary roots only; production resolution is exercised with an explicitly supplied agent directory. */
function root(t: { after: (fn: () => void) => void }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-role-contract-loader-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const write = (file: string, text: string | Uint8Array): string => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
};

test("missing role overrides select shipped bodies and metadata and create nothing", async (t) => {
	const dir = root(t);
	let resolutions = 0;
	const loader = roleContractLoader(async () => (++resolutions, dir));
	assert.equal(resolutions, 0, "constructing a loader resolves and reads nothing");
	const loaded = await loader.load();
	assert.equal(resolutions, 1, "the agent directory is resolved once for all six files");
	assert.deepEqual(fs.readdirSync(dir), []);
	assert.deepEqual(loaded, await memoryRoleContractLoader().load());
	for (const name of ROLE_CONTRACT_FILES) {
		const where = path.join(SHIPPED_ROLE_CONTRACTS_DIR, name);
		assert.deepEqual(loaded.files[name], { ...parseRoleContract(fs.readFileSync(where, "utf8"), where), source: "shipped", path: where });
	}
	for (const [role, name] of Object.entries(ROLE_CONTRACTS)) assert.equal(loaded.guidance[role as keyof typeof ROLE_CONTRACTS], loaded.files[name].host);
});

test("each named override replaces its whole contract, and host metadata and child body have the same source", async (t) => {
	const dir = root(t);
	for (const name of ROLE_CONTRACT_FILES) write(path.join(dir, "pi-fusion", "contracts", name), name === "ask-review.md" ? "Review only.\n" : contract(name));
	const loaded = await roleContractLoader(async () => dir).load();
	for (const name of ROLE_CONTRACT_FILES) {
		assert.equal(loaded.files[name].source, "override");
		assert.equal(loaded.files[name].path, path.join(dir, "pi-fusion", "contracts", name));
		assert.equal(loaded.files[name].diagnostic, undefined);
		assert.equal(roleContractBody(loaded, name), name === "ask-review.md" ? "Review only.\n" : `Child ${name}.\n`);
	}
	for (const [role, name] of Object.entries(ROLE_CONTRACTS)) assert.deepEqual(loaded.guidance[role as keyof typeof ROLE_CONTRACTS], { description: `Host ${name}.`, guidance: [`Guidance ${name}.`], task_brief: `Brief ${name}.`, snippet: `Snippet ${name}.` });
	assert.throws(() => roleContractBody(loaded, "../host.md"), /unknown role contract/);
	assert.throws(() => roleContractBody(loaded, "toString"), /unknown role contract/);
});

test("invalid override text or metadata makes its role unavailable per file, naming its path and reason, never falling back", async (t) => {
	for (const [bad, why] of [
		["", /is empty/],
		[" \n", /is blank/],
		[Uint8Array.from([0xc3, 0x28]), /not valid UTF-8/],
		["a".repeat(INSTRUCTION_MAX_BYTES + 1), /larger than 65536/],
		["Only child instructions.", /no host frontmatter/],
		["---\nhost: [PRIVATE_CONTRACT_VALUE\n---\nBody.", /invalid YAML/],
		[contract("bad").replace("Host bad.", "''"), /host.description/],
		[contract("bad", " \n"), /child instructions are blank/],
	] as const) {
		const dir = root(t);
		const where = write(path.join(dir, "pi-fusion", "contracts", "implement.md"), bad);
		write(path.join(dir, "pi-fusion", "contracts", "ask-review.md"), "Custom review.\n");
		const loaded = await roleContractLoader(async () => dir).load();
		const file = loaded.files["implement.md"];
		assert.equal(file.source, "override");
		assert.equal(file.path, where);
		assert.equal(file.unusable, true);
		assert.equal(file.body, "", "no lower scope's body stands in");
		assert.equal(file.host, undefined);
		assert.match(file.diagnostic!, why);
		assert.ok(file.diagnostic!.includes(where));
		assert.match(file.diagnostic!, /role implement is unavailable in this instance; fix or remove that file, then restart Pi, \/reload or start a new session$/);
		assert.doesNotMatch(file.diagnostic!, /PRIVATE_CONTRACT_VALUE/, "YAML error excerpts never enter diagnostics");
		assert.equal(loaded.unavailable.implement, file.diagnostic);
		assert.throws(() => roleContractBody(loaded, "implement.md"), /role implement is unavailable/);
		assert.equal(loaded.files["plan.md"].diagnostic, undefined);
		assert.deepEqual(Object.keys(loaded.unavailable), ["implement"]);
		assert.equal(loaded.files["ask-review.md"].source, "override", "one bad override does not discard another valid one");
	}
	const dir = root(t);
	fs.mkdirSync(path.join(dir, "pi-fusion", "contracts", "plan.md"), { recursive: true });
	const directory = await roleContractLoader(async () => dir).load();
	assert.match(directory.files["plan.md"].diagnostic!, /not a regular file/);
	assert.match(directory.unavailable.plan!, /not a regular file/);
});

test("an unusable ask-review override makes role ask unavailable rather than falling back to the shipped reviewer", async () => {
	for (const bad of [" \n", { error: "could not be read (EACCES)" }, `---\ndisabled: true\n${contract("x").slice(4)}`] as const) {
		const loaded = await memoryRoleContractLoader({ overrides: { "ask-review.md": bad } }).load();
		assert.equal(loaded.files["ask-review.md"].unusable, true);
		assert.equal(loaded.files["ask-answer.md"].source, "shipped");
		assert.match(loaded.unavailable.ask!, /ask-review\.md override/);
		assert.throws(() => roleContractBody(loaded, "ask-review.md"), /role ask is unavailable/);
		assert.throws(() => roleContractBody(loaded, "ask-answer.md"), /role ask is unavailable/);
	}
});

test("disabled and defaults metadata: availability, checked defaults, and the minimal disabled contract", async () => {
	const minimal = "---\ndisabled: true\nhost:\n  description: Not used in this project.\n  guidance: []\n  task_brief: None.\n  snippet: unavailable\n---\n";
	const loaded = await memoryRoleContractLoader({
		overrides: {
			"plan.md": minimal,
			"ultracode.md": minimal.replace("disabled: true", "disabled: true\ndefaults:\n  backend: claude\n  model: fable"),
			"implement.md": contract("implement").replace("---\nhost:", "---\ndisabled: false\ndefaults:\n  backend: codex\n  model: gpt-x\nhost:"),
			"ask-answer.md": contract("ask").replace("---\nhost:", "---\ndefaults:\n  backend: pi\n  effort: low\nhost:"),
		},
	}).load();
	assert.deepEqual(Object.keys(loaded.unavailable).sort(), ["plan", "ultracode"]);
	assert.equal(loaded.unavailable.plan, "the user override (override plan.md, in memory) declares disabled: true");
	assert.equal(loaded.files["plan.md"].body, "");
	assert.equal(loaded.guidance.plan.description, "Not used in this project.", "a disabled contract still has its host metadata");
	assert.throws(() => roleContractBody(loaded, "plan.md"), /role plan is unavailable/);
	assert.deepEqual(loaded.defaults, {
		implement: { backend: "codex", model: "gpt-x", path: "(override implement.md, in memory)" },
		ask: { backend: "pi", effort: "low", path: "(override ask-answer.md, in memory)" },
	}, "an unavailable role's declared defaults are not offered");
	assert.equal(roleContractBody(loaded, "implement.md"), "Child implement.md.\n".replace(".md", ""));
	// A shipped disabled contract is a valid declaration too; this build ships none.
	const shipped = await memoryRoleContractLoader({ shipped: { "security.md": minimal } }).load();
	assert.match(shipped.unavailable.security!, /^the shipped contract \(shipped security\.md, in memory\) declares disabled: true$/);
	assert.deepEqual((await memoryRoleContractLoader().load()).unavailable, {}, "this build's shipped contracts are all available");
});

test("defaults are checked for the role and backend that declare them, and an invalid one makes the role unavailable", async () => {
	const withDefaults = (role: string, defaults: string): string => contract(role).replace("---\nhost:", `---\ndefaults:\n${defaults}\nhost:`);
	for (const [name, defaults, why] of [
		["implement.md", "  model: opus", /defaults\.backend is required/],
		["implement.md", "  backend: gemini", /defaults\.backend must be claude, pi or codex/],
		["implement.md", "  backend: claude\n  temperature: 1", /defaults has an unknown field/],
		["implement.md", "  backend: claude\n  model: ''", /defaults\.model must be nonblank text/],
		["implement.md", "  backend: claude\n  effort: ludicrous", /not a claude effort/],
		["implement.md", "  backend: pi\n  model: no-slash", /not a pi provider and model id/],
		["implement.md", "  backend: codex\n  effort: two words", /not a codex effort/],
		["ultracode.md", "  backend: pi", /role ultracode runs on claude only/],
		["ultracode.md", "  backend: claude\n  effort: high", /must be ultracode or left out/],
		["security.md", "  backend: claude", /role security runs on pi only/],
		["plan.md", "  backend: claude\n  model: ' opus'", /has spaces around it/],
		["plan.md", "  - backend", /defaults must be an object/],
	] as const) {
		const loaded = await memoryRoleContractLoader({ overrides: { [name]: withDefaults(name, defaults) } }).load();
		const role = name.replace(".md", "") as keyof typeof loaded.unavailable;
		assert.match(loaded.unavailable[role] ?? "", why, `${name}: ${defaults}`);
		assert.equal(loaded.files[name].unusable, true);
	}
	for (const [text, why] of [
		[contract("x").replace("---\nhost:", "---\ndisable: true\nhost:"), /unknown frontmatter field/],
		[contract("x").replace("host:\n", "host:\n  disabled: true\n"), /host has an unknown field/],
		[contract("x").replace("host:\n", "host:\n  defaults:\n    backend: codex\n"), /host has an unknown field/],
		[contract("x").replace("---\nhost:", "---\ndisabled: \"true\"\nhost:"), /disabled must be true or false/],
		[contract("x").replace("---\nhost:", "---\ndisabled: yes please\nhost:"), /disabled must be true or false/],
		["---\ndisabled: true\n---\n", /host must be an object/],
		[contract("x", ""), /child instructions are blank/],
	] as const) {
		const loaded = await memoryRoleContractLoader({ overrides: { "plan.md": text } }).load();
		assert.match(loaded.unavailable.plan ?? "", why);
	}
	for (const header of ["disabled: false", "defaults:\n  backend: claude"]) {
		const loaded = await memoryRoleContractLoader({ overrides: { "ask-review.md": `---\n${header}\n${contract("review").slice(4)}` } }).load();
		assert.match(loaded.unavailable.ask ?? "", /disabled and defaults belong to ask-answer\.md/);
	}
	await assert.rejects(memoryRoleContractLoader({ shipped: { "plan.md": withDefaults("plan", "  backend: codex\n  model: two words") } }).load(), /shipped role contract .* is invalid/, "a broken shipped default fails startup");
});

test("the exact byte bound is accepted and multibyte overflow is refused", async () => {
	const header = contract("bounded", "");
	const exact = header + "x".repeat(INSTRUCTION_MAX_BYTES - Buffer.byteLength(header));
	assert.equal((await memoryRoleContractLoader({ overrides: { "plan.md": exact } }).load()).files["plan.md"].source, "override");
	assert.match((await memoryRoleContractLoader({ overrides: { "plan.md": exact + "é" } }).load()).files["plan.md"].diagnostic!, /larger than/);
});

test("every shipped contract is validated before any user path is resolved; overrides never hide a broken install", async (t) => {
	const dir = root(t);
	for (const name of ROLE_CONTRACT_FILES) {
		const shipped = path.join(dir, name.replace(".md", ""));
		fs.mkdirSync(shipped);
		for (const file of ROLE_CONTRACT_FILES) fs.copyFileSync(path.join(SHIPPED_ROLE_CONTRACTS_DIR, file), path.join(shipped, file));
		fs.rmSync(path.join(shipped, name));
		let resolved = 0;
		await assert.rejects(fileRoleContractLoader({ shipped, override: () => { resolved++; throw new Error("must not resolve"); } }).load(), /shipped role contract .* is missing/);
		assert.equal(resolved, 0);
		write(path.join(shipped, name), name === "ask-review.md" ? " \n" : "Missing host frontmatter.");
		await assert.rejects(fileRoleContractLoader({ shipped, override: () => { resolved++; return dir; } }).load(), /is blank|no host frontmatter/);
		assert.equal(resolved, 0);
		await assert.rejects(memoryRoleContractLoader({ shipped: { [name]: " \n" }, overrides: { [name]: contract("valid") } }).load(), /shipped role contract .* is blank/);
	}
});

test("an unresolved agent directory makes every role unavailable with diagnostics and is requested only once", async () => {
	let resolved = 0;
	const loaded = await roleContractLoader(async () => { resolved++; throw new Error("no agent directory"); }).load();
	assert.equal(resolved, 1);
	for (const file of Object.values(loaded.files)) {
		assert.equal(file.unusable, true);
		assert.match(file.diagnostic!, /override could not be located \(no agent directory\)/);
	}
	assert.deepEqual(Object.keys(loaded.unavailable).sort(), ["ask", "implement", "plan", "security", "ultracode"]);
});

test("a loaded snapshot survives edits and deletion; another load observes them", async (t) => {
	const dir = root(t);
	const where = write(path.join(dir, "pi-fusion", "contracts", "plan.md"), contract("first", "---\nBody separator, not metadata.\n"));
	const loader = roleContractLoader(async () => dir);
	const first = await loader.load();
	write(where, contract("second"));
	assert.equal(first.guidance.plan.description, "Host first.");
	assert.equal(first.files["plan.md"].body, "---\nBody separator, not metadata.\n");
	assert.equal((await loader.load()).guidance.plan.description, "Host second.");
	fs.rmSync(where);
	assert.equal((await loader.load()).files["plan.md"].source, "shipped");
	assert.equal(first.files["plan.md"].source, "override");
});

test("contract diagnostics in the snapshot, shipped errors included, never repeat an unknown key or a rejected value", async () => {
	const header = (top: string, host = ""): string => contract("x").replace("---\nhost:\n", `---\n${top}host:\n${host}`);
	const secrets = [
		header("PRIVATE_TOP_KEY: PRIVATE_TOP_VALUE\n"),
		header("defaults:\n  backend: claude\n  PRIVATE_DEFAULT_KEY: 1\n"),
		header("", "  PRIVATE_HOST_KEY: PRIVATE_HOST_VALUE\n"),
		header("defaults:\n  backend: claude\n  effort: PRIVATE_EFFORT\n"),
		header("defaults:\n  backend: claude\n  model: ' PRIVATE_MODEL'\n"),
		header("defaults:\n  backend: pi\n  model: PRIVATE_MODEL\n"),
		header("defaults:\n  backend: pi\n  effort: PRIVATE_EFFORT\n"),
		header("defaults:\n  backend: codex\n  model: PRIVATE MODEL\n"),
		header("defaults:\n  backend: codex\n  effort: PRIVATE EFFORT\n"),
	];
	for (const text of secrets) {
		const loaded = await memoryRoleContractLoader({ overrides: { "plan.md": text } }).load();
		assert.ok(loaded.unavailable.plan, text);
		assert.doesNotMatch(loaded.unavailable.plan!, /PRIVATE/, text);
		assert.doesNotMatch(loaded.files["plan.md"].diagnostic!, /PRIVATE/, text);
		await assert.rejects(memoryRoleContractLoader({ shipped: { "plan.md": text } }).load(), (error: Error) => /shipped role contract/.test(error.message) && !/PRIVATE/.test(error.message), text);
	}
});

test("a dangling override link, at the file or at a directory above it, closes its role; absent files and valid links do not", async (t) => {
	const dir = root(t);
	const contracts = path.join(dir, "pi-fusion", "contracts");
	fs.mkdirSync(contracts, { recursive: true });
	fs.symlinkSync(path.join(dir, "absent.md"), path.join(contracts, "plan.md"));
	const file = await roleContractLoader(async () => dir).load();
	assert.equal(file.files["plan.md"].unusable, true);
	assert.match(file.unavailable.plan!, /plan\.md is a link to a missing file; role plan is unavailable/);
	assert.equal(file.unavailable.implement, undefined, "a genuinely absent implement.md falls through");
	assert.equal(file.files["implement.md"].source, "shipped");

	// A valid link to a file is that file.
	fs.rmSync(path.join(contracts, "plan.md"));
	const real = write(path.join(dir, "elsewhere", "plan.md"), contract("linked"));
	fs.symlinkSync(real, path.join(contracts, "plan.md"));
	const linked = await roleContractLoader(async () => dir).load();
	assert.equal(linked.files["plan.md"].source, "override");
	assert.equal(linked.files["plan.md"].body, "Child linked.\n");

	// A dangling link where the contracts directory belongs closes every role, rather than reading as no overrides.
	fs.rmSync(path.join(dir, "pi-fusion"), { recursive: true });
	fs.mkdirSync(path.join(dir, "pi-fusion"));
	fs.symlinkSync(path.join(dir, "gone"), contracts);
	const directory = await roleContractLoader(async () => dir).load();
	assert.deepEqual(Object.keys(directory.unavailable).sort(), ["ask", "implement", "plan", "security", "ultracode"]);
	assert.match(directory.unavailable.plan!, /is below .*contracts, a link to a missing directory/);

	// A valid directory link with the file absent below it is an ordinary absent override.
	fs.mkdirSync(path.join(dir, "gone"));
	const resolved = await roleContractLoader(async () => dir).load();
	assert.deepEqual(resolved.unavailable, {});
	assert.ok(Object.values(resolved.files).every((entry) => entry.source === "shipped"));

	// No directory at all is still nothing to read.
	assert.deepEqual((await roleContractLoader(async () => path.join(dir, "never")).load()).unavailable, {});
});
