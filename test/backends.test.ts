import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { claudeBackend, type Role } from "../extensions/backends/claude.ts";
import { hostBackend, isPiModel, piModelParts, resolvedSelectionOf } from "../extensions/backends/types.ts";
import { ASK_MODES, type AskMode, type ChildRun as ExportedChildRun, failed, ROLE_NAMES } from "../extensions/fusion.ts";
import { ChildTree } from "../extensions/process-tree.ts";
import { canChangeFiles, isReviewable, KNOWN_ROLE_NAMES, ROLE_SPECS, runsOn } from "../extensions/roles.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

/**
 * Fails to compile once the host's exported `ChildRun` stops being the Claude run: its consumers read the Claude
 * role's own fields, and a run typed over the host's narrower view of a role would drop effort, tools and permission
 * mode from every one of them. The shared lifecycle has its own generic run type, which is not this export.
 */
const CHILD_RUN_STAYS_CLAUDE: Exactly<ExportedChildRun["role"], Role> = true;

test("the host and the shared boundary depend on no backend SDK", () => {
	for (const name of ["fusion.ts", "backends/types.ts", "process-tree.ts", "roles.ts"]) {
		assert.ok(!dependenciesOf(name).includes("@anthropic-ai/claude-agent-sdk"), `${name} must reach a child through the backend boundary, not through the SDK`);
	}
});

test("the shared boundary depends on nothing, and the process-tree helper only on node itself", () => {
	assert.deepEqual(dependenciesOf("backends/types.ts"), [], "the boundary types must stand on their own");
	for (const name of dependenciesOf("process-tree.ts")) {
		assert.match(name, /^node:/, "the process-tree helper must not depend on a backend or on the host extension");
	}
});

test("the role capabilities depend on the boundary and on nothing else", () => {
	for (const name of dependenciesOf("roles.ts")) {
		assert.equal(name, "./backends/types.ts", "role capabilities must name no host, no backend and no adapter");
	}
});

test("the pi binding is a binding, not an adapter: it depends on the boundary alone and names no SDK", () => {
	const names = dependenciesOf("backends/pi-binding.ts");
	assert.deepEqual(names, ["./types.ts"], `a role binding must name no host, no process and no SDK; it names ${names.join(", ")}`);
});

test("the pi storage layout depends on node itself, so a path is composed before any package is loaded", () => {
	const names = dependenciesOf("backends/pi-storage.ts");
	assert.ok(names.length > 0, "the storage layout does its own file work, so it names node's own modules");
	for (const name of names) assert.match(name, /^node:/, `the storage layout must name no host, no backend and no SDK; it names ${names.join(", ")}`);
});

test("a pi model is a provider and a model id split at the first slash, so a provider's own slashes survive", () => {
	assert.deepEqual(piModelParts("deepseek/deepseek-chat"), { provider: "deepseek", model: "deepseek-chat" });
	assert.deepEqual(piModelParts("openrouter/deepseek/deepseek-chat"), { provider: "openrouter", model: "deepseek/deepseek-chat" });
	for (const value of ["deepseek-chat", "/deepseek-chat", "deepseek/", "", "  ", 7, null, undefined, {}]) {
		assert.equal(piModelParts(value), undefined, JSON.stringify(value));
	}
	assert.equal(isPiModel("openrouter/deepseek/deepseek-chat"), true);
	assert.equal(isPiModel("deepseek-chat"), false);
	// The record grammar is the same one, so a model id with slashes reads back as the selection it was written as.
	assert.deepEqual(resolvedSelectionOf({ model: "openrouter/deepseek/deepseek-chat", effort: "medium" }, "pi"), { model: "openrouter/deepseek/deepseek-chat", effort: "medium" });
	assert.equal(resolvedSelectionOf({ model: "deepseek-chat", effort: "medium" }, "pi"), undefined);
});

test("a backend the host holds keeps its own role and session shapes behind the boundary", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	const held = hostBackend(claudeBackend);
	assert.equal(held.name, "claude");
	const session = held.session({ kind: "resume", ref: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } });
	assert.deepEqual(session, { kind: "resume", id: "s-1", at: "c-1" }, "the host reads the session its backend made and builds none of its own");
	const child = await held.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, input: held.control(), onProgress: () => {} });
	assert.equal(failed(child), false);
	assert.equal(child.role.name, "implement");
	assert.equal(child.role.model, "opus");
});

test("every role a record may name has capabilities, and the host advertises the roles it can run", () => {
	assert.deepEqual([...KNOWN_ROLE_NAMES].sort(), ["ask", "implement", "plan", "security", "ultracode"]);
	assert.deepEqual([...ROLE_NAMES].sort(), ["ask", "implement", "plan", "ultracode"], "security is metadata until a backend runs it");
	for (const name of KNOWN_ROLE_NAMES) assert.equal(ROLE_SPECS[name].name, name);
	assert.deepEqual(
		KNOWN_ROLE_NAMES.filter((name) => ROLE_SPECS[name].canChangeFiles),
		["plan", "implement", "ultracode", "security"],
	);
	assert.deepEqual(
		KNOWN_ROLE_NAMES.filter((name) => ROLE_SPECS[name].reviewable),
		["implement", "ultracode", "security"],
	);
	assert.deepEqual(ROLE_SPECS.ultracode.backends, ["claude"]);
	assert.deepEqual(ROLE_SPECS.security.backends, ["pi"]);
	assert.deepEqual([...ROLE_SPECS.implement.backends].sort(), ["claude", "pi"]);
	assert.equal(canChangeFiles("ask"), false);
	assert.equal(canChangeFiles("nobody"), true, "a role nothing knows is treated as one that can change files");
	assert.equal(isReviewable("nobody"), false);
	assert.equal(runsOn("security", "claude"), false);
	assert.equal(runsOn("ultracode", "pi"), false);
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

test("the exported child run is the Claude run, so its consumers still read the role's effort, tools and permission mode", async () => {
	assert.equal(CHILD_RUN_STAYS_CLAUDE, true);
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	const child: ExportedChildRun = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, onProgress: () => {} });
	assert.deepEqual([child.role.effort, child.role.permissionMode, child.role.tools], ["high", "bypassPermissions", ["Read", "Bash", "Edit", "Write", "Grep", "Glob"]]);
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

test("the claude backend maps an intent to its own session request, and refuses another backend's", () => {
	assert.match(claudeBackend.session({ kind: "new" }).id, UUID);
	assert.deepEqual(claudeBackend.session({ kind: "resume", ref: { backend: "claude", sessionId: "s-1" } }), { kind: "resume", id: "s-1" });
	assert.deepEqual(claudeBackend.session({ kind: "resume", ref: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } }), { kind: "resume", id: "s-1", at: "c-1" });
	const forked = claudeBackend.session({ kind: "fork", from: { backend: "claude", sessionId: "s-1", checkpoint: "c-1" } });
	assert.match(forked.id, UUID);
	assert.deepEqual({ kind: forked.kind, from: (forked as { from: string }).from, at: (forked as { at?: string }).at }, { kind: "fork", from: "s-1", at: "c-1" });
	const pi = { backend: "pi", sessionId: "pi-1", sessionFile: "/sessions/pi-1.jsonl", checkpoint: "entry-9" } as const;
	assert.throws(() => claudeBackend.session({ kind: "resume", ref: pi }), /pi session pi-1 cannot be continued by the claude backend/);
	assert.throws(() => claudeBackend.session({ kind: "fork", from: pi }), /pi session pi-1 cannot be continued by the claude backend/);
});

test("a run reports the claude session it ran in, with a checkpoint only where one is trusted", async () => {
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
	const ok = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, onProgress: () => {} });
	assert.deepEqual(ok.session, { backend: "claude", sessionId: ok.sessionId, checkpoint: ok.checkpoint });
	process.env.FAKE_CLAUDE_SCENARIO = "error";
	const fork = { kind: "fork", id: "11111111-1111-4111-8111-111111111111", from: "s-1", at: "c-1" } as const;
	const failedFork = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, session: fork, signal: undefined, onProgress: () => {} });
	assert.equal(failed(failedFork), true);
	assert.deepEqual(failedFork.session, { backend: "claude", sessionId: failedFork.sessionId, checkpoint: "c-1" }, "a failed fork keeps the checkpoint it forked at, never the tip it failed on");
	const failedNew = await claudeBackend.run({ role: implementRole, prompt: "do the thing", cwd: repoRoot, signal: undefined, onProgress: () => {} });
	assert.deepEqual(failedNew.session, { backend: "claude", sessionId: failedNew.sessionId }, "a failed first call has an identity and no trusted checkpoint");
	process.env.FAKE_CLAUDE_SCENARIO = "ok";
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
