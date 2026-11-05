import assert from "node:assert/strict";
import test from "node:test";
import { canonicalContractBody, parseRoleContract, suppliedContractBody } from "../extensions/role-contracts.ts";

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

test("availability and defaults metadata: strict keys and types, a body only a disabled contract may omit", () => {
	const minimal = `---\ndisabled: true\n${HEADER.slice(4)}`;
	assert.deepEqual(parseRoleContract(minimal, "plan.md"), { body: "", host: parseRoleContract(HEADER + "x", "a").host, disabled: true });
	assert.deepEqual(parseRoleContract(`---\ndisabled: false\n${HEADER.slice(4)}Body.\n`, "plan.md").disabled, undefined, "false is the same as absent");
	assert.deepEqual(parseRoleContract(`---\ndefaults:\n  backend: codex\n  model: gpt-x\n${HEADER.slice(4)}Body.\n`, "plan.md").defaults, { backend: "codex", model: "gpt-x" });
	for (const [text, why] of [
		[`---\nDisabled: true\n${HEADER.slice(4)}Body.`, /unknown frontmatter field; use only host, disabled and defaults$/],
		[`---\ndisabled: 1\n${HEADER.slice(4)}Body.`, /disabled must be true or false/],
		[`---\ndefaults: codex\n${HEADER.slice(4)}Body.`, /defaults must be an object/],
		[`---\ndefaults:\n  effort: high\n${HEADER.slice(4)}Body.`, /defaults\.backend is required/],
		[`---\ndefaults:\n  backend: claude\n  extra: 1\n${HEADER.slice(4)}Body.`, /defaults has an unknown field; use only backend, model and effort$/],
		[`---\ndefaults:\n  backend: claude\n  model: 7\n${HEADER.slice(4)}Body.`, /defaults\.model must be nonblank text/],
		[`---\ndisabled: true\n---\n`, /host must be an object/],
	] as const) assert.throws(() => parseRoleContract(text, "/c/plan.md"), why);
	assert.throws(() => parseRoleContract(`---\ndisabled: true\n${HEADER.slice(4)}Body.`, "ask-review.md", "ask-answer.md"), /disabled and defaults belong to ask-answer\.md/);
	assert.equal(parseRoleContract("Review.\n", "ask-review.md", "ask-answer.md").body, "Review.\n");
});

test("host metadata takes only its four fields, so a misplaced disabled or defaults cannot leave a role available", () => {
	for (const misplaced of ["  disabled: true\n", "  defaults:\n    backend: codex\n", "  PRIVATE_HOST_KEY: PRIVATE_HOST_VALUE\n"]) {
		assert.throws(() => parseRoleContract(HEADER.replace("host:\n", `host:\n${misplaced}`) + "Body.", "/c/plan.md"), (error: Error) => {
			assert.match(error.message, /host has an unknown field; use only description, guidance, task_brief and snippet, and put disabled and defaults at the top level$/);
			assert.doesNotMatch(error.message, /PRIVATE_HOST|codex/);
			return true;
		});
	}
});

test("frontmatter diagnostics name the category and never repeat an unknown key or a supplied value", () => {
	for (const text of [`---\nPRIVATE_KEY: PRIVATE_VALUE\n${HEADER.slice(4)}Body.`, `---\ndefaults:\n  backend: claude\n  PRIVATE_KEY: PRIVATE_VALUE\n${HEADER.slice(4)}Body.`]) {
		assert.throws(() => parseRoleContract(text, "/c/plan.md"), (error: Error) => !/PRIVATE/.test(error.message));
	}
});

test("a lazy canonical read refuses a disabled, blank or invalid canonical contract, and a review mode whose role's contract cannot run; a supplied body is text only", () => {
	const disabled = `---\ndisabled: true\n${HEADER.slice(4)}`;
	const files: Record<string, string> = { "plan.md": disabled, "implement.md": `${HEADER}Implement.\n`, "ask-answer.md": disabled, "ask-review.md": "Review.\n" };
	const read = (name: string): string => files[name]!;
	assert.equal(canonicalContractBody(read, "implement.md"), "Implement.\n");
	assert.throws(() => canonicalContractBody(read, "plan.md"), /plan\.md declares its role disabled/);
	assert.throws(() => canonicalContractBody(read, "ask-review.md"), /ask-review\.md is not run because its role's contract cannot run: .*ask-answer\.md declares its role disabled/);
	for (const [owner, why] of [[" \n", /ask-answer\.md has blank child instructions/], [HEADER, /child instructions are blank/], ["---\nhost: [\n---\nAnswer.", /invalid YAML/]] as const) {
		files["ask-answer.md"] = owner;
		assert.throws(() => canonicalContractBody(read, "ask-review.md"), why, JSON.stringify(owner));
	}
	for (const blank of [" \n", HEADER]) {
		files["implement.md"] = blank;
		assert.throws(() => canonicalContractBody(read, "implement.md"), /blank/, "a genuinely blank lazy role file runs nothing");
	}
	files["ask-answer.md"] = `${HEADER}Answer.\n`;
	assert.equal(canonicalContractBody(read, "ask-review.md"), "Review.\n");
	files["ask-review.md"] = " \n";
	assert.throws(() => canonicalContractBody(read, "ask-review.md"), /ask-review\.md has blank child instructions/);
	assert.equal(suppliedContractBody(disabled), disabled);
	assert.throws(() => suppliedContractBody(" \n"), /blank/);
});
