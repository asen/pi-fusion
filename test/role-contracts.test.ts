import assert from "node:assert/strict";
import test from "node:test";
import { parseRoleContract } from "../extensions/role-contracts.ts";

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
