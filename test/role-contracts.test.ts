import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadRoleGuidance, parseRoleContract } from "../extensions/role-contracts.ts";

const HEADER = "---\nhost:\n  description: A role description.\n  guidance:\n    - A host instruction.\n  task_brief: What the child needs.\n  snippet: short description\n---\n\n";

test("frontmatter supplies host metadata and never enters the child instructions", () => {
	const body = "Child instructions.\n\n---\nA body separator stays.\n";
	for (const newline of ["\n", "\r\n"]) {
		const parsed = parseRoleContract((HEADER + body).replaceAll("\n", newline), "role.md");
		assert.equal(parsed.body, body.replaceAll("\n", newline));
		assert.deepEqual(parsed.host, { description: "A role description.", guidance: ["A host instruction."], task_brief: "What the child needs.", snippet: "short description" });
	}
	assert.deepEqual(parseRoleContract(body, "plain.md"), { body });
});

test("malformed frontmatter refuses with the contract path rather than sending metadata to a child", () => {
	for (const text of [
		"---\nhost: {}\n",
		HEADER.replace("host:", "host: ["),
		HEADER.replace("host:", "other:"),
		HEADER.replace("A role description.", "''"),
		HEADER.replace("What the child needs.", "true"),
		HEADER.replace("short description", "42"),
		HEADER.replace("guidance:\n    - A host instruction.", "guidance: text"),
		HEADER.replace("- A host instruction.", "- false"),
		HEADER,
	]) assert.throws(() => parseRoleContract(text, "/contracts/broken.md"), /invalid role contract \/contracts\/broken\.md:/);
});

test("loading host metadata requires it for every role and names the broken file", (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-role-contracts-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const contracts = { plan: "role.md", implement: "role.md", ultracode: "role.md", ask: "role.md", security: "role.md" };
	fs.writeFileSync(path.join(directory, "role.md"), HEADER + "Child instructions.\n");
	const roles = loadRoleGuidance(directory, contracts);
	assert.deepEqual(Object.keys(roles), Object.keys(contracts));
	assert.equal(roles.security.description, "A role description.");
	fs.writeFileSync(path.join(directory, "role.md"), "Child instructions only.\n");
	assert.throws(() => loadRoleGuidance(directory, contracts), /role\.md has no host frontmatter/);
});
