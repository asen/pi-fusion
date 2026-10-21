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

test("invalid override text or metadata falls back per file, naming its path and reason", async (t) => {
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
		assert.equal(loaded.files["implement.md"].source, "shipped");
		assert.match(loaded.files["implement.md"].diagnostic!, why);
		assert.ok(loaded.files["implement.md"].diagnostic!.includes(where));
		assert.doesNotMatch(loaded.files["implement.md"].diagnostic!, /PRIVATE_CONTRACT_VALUE/, "YAML error excerpts never enter diagnostics");
		assert.equal(loaded.guidance.implement.description, (await memoryRoleContractLoader().load()).guidance.implement.description);
		assert.equal(loaded.files["plan.md"].diagnostic, undefined);
		assert.equal(loaded.files["ask-review.md"].source, "override", "one bad override does not discard another valid one");
	}
	const dir = root(t);
	fs.mkdirSync(path.join(dir, "pi-fusion", "contracts", "plan.md"), { recursive: true });
	assert.match((await roleContractLoader(async () => dir).load()).files["plan.md"].diagnostic!, /not a regular file/);
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

test("an unresolved agent directory falls back with diagnostics and is requested only once", async () => {
	let resolved = 0;
	const loaded = await roleContractLoader(async () => { resolved++; throw new Error("no agent directory"); }).load();
	assert.equal(resolved, 1);
	for (const file of Object.values(loaded.files)) {
		assert.equal(file.source, "shipped");
		assert.match(file.diagnostic!, /override could not be located \(no agent directory\)/);
	}
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
