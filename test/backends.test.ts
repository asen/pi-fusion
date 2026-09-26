import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { claudeBackend, type Role } from "../extensions/backends/claude.ts";
import { ASK_MODES, type AskMode, failed } from "../extensions/fusion.ts";
import { ChildTree } from "../extensions/process-tree.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeClaude = path.join(repoRoot, "test", "fake-claude.mjs");
process.env.PI_FUSION_CLAUDE_BIN = fakeClaude;

const implementRole: Role = {
	name: "implement",
	model: "opus",
	effort: "high",
	tools: ["Read", "Bash", "Edit", "Write", "Grep", "Glob"],
	permissionMode: "bypassPermissions",
	contract: "implement.md",
};

/**
 * Every module a file names, whatever form the reference takes: a static import, a bare import, a re-export, or a
 * dynamic import or require with a literal path. TypeScript's own scanner reads it, so a module named in a comment
 * or in a string is not mistaken for a dependency, which a regular expression over the source would be.
 */
const modulesNamedIn = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map((reference) => reference.fileName);

const dependenciesOf = (name: string): string[] => modulesNamedIn(fs.readFileSync(path.join(repoRoot, "extensions", name), "utf8"));

/** Fails to compile once the adapter's mode and the host's list of ask modes are no longer the same two values. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const MODE_STAYS_ASK_MODE: Exactly<NonNullable<Role["mode"]>, AskMode> = true;

test("the host and the shared boundary depend on no backend SDK", () => {
	for (const name of ["fusion.ts", "backends/types.ts", "process-tree.ts"]) {
		assert.ok(!dependenciesOf(name).includes("@anthropic-ai/claude-agent-sdk"), `${name} must reach a child through the backend boundary, not through the SDK`);
	}
});

test("the shared boundary depends on nothing, and the process-tree helper only on node itself", () => {
	assert.deepEqual(dependenciesOf("backends/types.ts"), [], "the boundary types must stand on their own");
	for (const name of dependenciesOf("process-tree.ts")) {
		assert.match(name, /^node:/, "the process-tree helper must not depend on a backend or on the host extension");
	}
});

test("the Claude backend does not depend on the host extension", () => {
	const names = dependenciesOf("backends/claude.ts");
	assert.ok(
		!names.some((name) => name.endsWith("fusion.ts")),
		`the backend must not depend on the extension that routes to it; it names ${names.join(", ")}`,
	);
});

test("a module reference is found in every form it takes, and nowhere else", () => {
	const source = [
		'// import "commented-out.ts";',
		'/* import "block-comment.ts"; */',
		'import plain from "static.ts";',
		"import { single } from './single-quote.ts';",
		'import "bare.ts";',
		'import type { Only } from "type-only.ts";',
		'export { re } from "re-export.ts";',
		'export type { Type } from "type-re-export.ts";',
		'export * from "star.ts";',
		'const quoted = \'import "in-a-string.ts";\';',
		'const lazy = await import("dynamic.ts");',
		'const required = require("required.ts");',
		"const computed = await import(namedElsewhere);",
	].join("\n");
	assert.deepEqual(modulesNamedIn(source), [
		"static.ts",
		"./single-quote.ts",
		"bare.ts",
		"type-only.ts",
		"re-export.ts",
		"type-re-export.ts",
		"star.ts",
		"dynamic.ts",
		"required.ts",
	]);
});

test("the Claude role's mode is the host's own list of ask modes", () => {
	assert.equal(MODE_STAYS_ASK_MODE, true);
	for (const mode of ASK_MODES) {
		// Compiles only while every ask mode the host validates still fits the mode the adapter's role takes.
		const role: Role = { ...implementRole, name: "ask", mode };
		assert.equal(role.mode, mode);
	}
});

test("a run goes through the backend boundary", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	assert.equal(claudeBackend.name, "claude");
	const input = claudeBackend.control();
	assert.equal(input.open, true);
	const child = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, input, onProgress: () => {} });
	assert.equal(failed(child), false);
	assert.equal(child.text, "## Changed\nfoo.ts");
	assert.equal(child.role, implementRole);
	assert.equal(input.open, false, "the run closes its input when the child has no work left");
});

test("the process tree reports how its child exited, and its stderr", async () => {
	const tree = new ChildTree(200);
	const child = tree.spawn({ command: process.execPath, args: ["-e", "process.stderr.write('trouble'); process.exit(3)"], env: process.env });
	assert.equal(tree.spawned, true);
	assert.equal(typeof child.kill, "function");
	const exit = await tree.exited();
	assert.equal(exit.code, 3);
	assert.equal(exit.signal, null);
	assert.equal(tree.stderr, "trouble");
	assert.equal(tree.stoppedBy(exit), false, "a child that exited on its own was stopped by nothing this sent");
});

test("killing the process tree stops a child that would run on", async () => {
	const tree = new ChildTree(200);
	tree.spawn({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"], env: process.env });
	tree.kill();
	const exit = await tree.exited();
	assert.equal(exit.signal, "SIGTERM");
	assert.equal(tree.stoppedBy(exit), true, "a signal this sent is this shutdown, not the child's own outcome");
});
