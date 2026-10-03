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

/**
 * Every host-side production module of every extension this repository ships: the TypeScript ones, with declarations
 * left out, because a `.d.mts` naming a module is a type reference rather than something a process imports. The plain
 * ESM beside them is the child's own program and the modules it is composed of, which run in a child and not here.
 */
const productionModules = (dir = path.join(repoRoot, "extensions")): string[] =>
	fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(m|c)?ts$/.test(entry.name) && !/\.d\.(m|c)?ts$/.test(entry.name))
		.map((entry) => path.join(entry.parentPath, entry.name));

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

test("the pi outcome mapping is pure: node's own path helper, this backend's own modules, and nothing else", () => {
	const names = dependenciesOf("backends/pi-outcome.ts");
	// `node:path` is there for one thing, deciding whether a recorded session file is absolute; everything else it
	// names is a value-shape it maps from. A host, another backend, a card and a package are all outside that.
	const allowed = ["node:path", "./types.ts", "./pi-binding.ts", "./pi-prepare.ts", "./pi-task.ts", "./pi-transport.ts", "./pi-session-restore.ts", "./pi-question-routing.ts", "../process-tree.ts"];
	for (const name of names) {
		assert.ok(allowed.includes(name), `the outcome mapping must name no host, no adapter and no package; it names ${name}`);
	}
	for (const forbidden of ["./claude.ts", "../fusion.ts", "../cards.ts"]) {
		assert.ok(!names.includes(forbidden), `the outcome mapping must not depend on ${forbidden}`);
	}
});

test("the pi storage layout depends on node itself, so a path is composed before any package is loaded", () => {
	const names = dependenciesOf("backends/pi-storage.ts");
	assert.ok(names.length > 0, "the storage layout does its own file work, so it names node's own modules");
	for (const name of names) assert.match(name, /^node:/, `the storage layout must name no host, no backend and no SDK; it names ${names.join(", ")}`);
});

test("the program a Pi child runs is the child's alone, and the host reads the two protocol constants from a module that imports nothing", () => {
	// The host extension reaches the transport through the pi backend, so whatever the transport names is loaded in this
	// host's own process. What reading the two constants off the bootstrap cost was the dependency itself: the host
	// evaluated the child's entry module, so an install missing that program was a module error at import time instead
	// of the fixed existence refusal the loader composes for it by name. It is not a claim about the modules behind
	// that entry — the host imports `pi-control-extension.mjs` and `pi-question-tool.mjs` through the restore and the
	// launch anyway — nor about the public SDK, which the child's own program loads when it runs.
	assert.deepEqual(dependenciesOf("backends/pi-bootstrap-protocol.mjs"), [], "the shared protocol constants must stand on their own, so a host pays nothing to read them");
	const transport = dependenciesOf("backends/pi-transport.ts");
	assert.ok(transport.includes("./pi-bootstrap-protocol.mjs"), `the transport must read the diagnostic marker and the startup exit code from the protocol module; it names ${transport.join(", ")}`);
	assert.ok(!transport.includes("./pi-bootstrap.mjs"), "the transport must not import the program a child runs");
	// And no other host module either, through any form a reference takes. `extensions/backends/pi-launch.ts` still
	// names that file, as the path it composes for a launch rather than a module it imports, which is exactly the
	// difference the compiler's own scanner reads and a pattern over the text would not.
	for (const file of productionModules()) {
		const named = modulesNamedIn(fs.readFileSync(file, "utf8"));
		assert.ok(
			!named.some((name) => name.endsWith("pi-bootstrap.mjs")),
			`${relative(file)} imports the program a Pi child runs, which belongs in the child; the host reads what it shares with it from ./pi-bootstrap-protocol.mjs`,
		);
	}
	const launch = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-launch.ts"), "utf8");
	assert.ok(launch.includes('"pi-bootstrap.mjs"'), "the launch module no longer names the child's program as a path, so the audit above is reading files that never mention it");
	assert.deepEqual(modulesNamedIn(launch).filter((name) => name.endsWith("pi-bootstrap.mjs")), [], "and it names it as that path alone");
});

test("the preload that resolves the host's own Pi is the child's alone, and the launch names it as a path", () => {
	// Importing the preload registers its resolve hook in whatever process imported it, which in this host would
	// redirect the host's own imports: the launch composes its path and restates its one variable instead.
	for (const file of productionModules()) {
		const named = modulesNamedIn(fs.readFileSync(file, "utf8"));
		assert.ok(!named.some((name) => name.endsWith("pi-sdk-resolve.mjs")), `${relative(file)} imports the preload a Pi child is started with`);
	}
	assert.deepEqual(dependenciesOf("backends/pi-sdk-resolve.mjs"), ["node:module", "node:path", "node:url"], "the preload stands on node itself, because it runs before anything else in the child");
	const launch = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-launch.ts"), "utf8");
	assert.ok(launch.includes('"pi-sdk-resolve.mjs"'), "the launch module no longer names the preload as a path");
});

/**
 * Every test file the audit below reads, walked rather than listed: a registration written in a file one directory
 * down would be outside `test/*.test.ts`, which is where the runner looks, and still a registration. `test/spikes`
 * is left out by name, because those are manual harnesses that run no case of this suite, and anything that is not
 * a `.test.ts` is left out with them. The order is the walk's own, so the pins below can be written in it.
 */
function testFiles(dir = path.join(repoRoot, "test")): string[] {
	const found: string[] = [];
	for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const at = path.join(dir, item.name);
		if (item.isDirectory()) {
			if (item.name !== "spikes") found.push(...testFiles(at));
		} else if (item.name.endsWith(".test.ts")) found.push(at);
	}
	return found;
}

/** A path as the pins below name one, so a walk on Windows reads back the same as a walk here. */
const relative = (file: string): string => path.relative(repoRoot, file).split(path.sep).join("/");

/**
 * Every registration of the Fusion extension in one file, as the source text of the whole call: a call of the default
 * export of `extensions/fusion.ts`, under whatever name that file imported it as, found through the compiler's own
 * parser rather than a pattern over the text. That is what makes it robust to the forms a registration actually
 * takes — a call that spans lines or sits inside a helper comes back whole, an import is no call at all, and a
 * `host.fusion(...)` of a test's own helper is a property access rather than this.
 *
 * What it does not see, said plainly: it follows the default import and nothing else. A file that reached the
 * extension through a namespace import, a re-export, a dynamic import or a reference passed around as a value would
 * register one this finds no call for. That is why the population below is pinned as well as the markers — a
 * detector that stopped seeing the registrations that are there fails on the counts instead of passing silently.
 */
function fusionRegistrations(source: string): string[] {
	const file = ts.createSourceFile("registration.ts", source, ts.ScriptTarget.Latest, true);
	let local: string | undefined;
	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const from = statement.moduleSpecifier;
		if (!ts.isStringLiteral(from) || !from.text.endsWith("extensions/fusion.ts")) continue;
		const name = statement.importClause?.name;
		if (name) local = name.text;
	}
	if (local === undefined) return [];
	const calls: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === local) calls.push(node.getText(file));
		ts.forEachChild(node, visit);
	};
	visit(file);
	return calls;
}

/**
 * Where the suite registers the extension today, and how often in each place. It is pinned, not counted, for two
 * reasons: a registration that appears somewhere new is a decision somebody should make on purpose, and a detector
 * that quietly stopped finding the calls that are there would otherwise pass this whole audit with nothing to check.
 */
const REGISTRATIONS: Record<string, number> = {
	"test/control.test.ts": 1,
	"test/extension.test.ts": 4,
	"test/lifecycle.test.ts": 1,
	"test/profiles.test.ts": 1,
	"test/routing.test.ts": 2,
	"test/session.test.ts": 1,
};
const REGISTRATIONS_TOTAL = 10;

test("every Fusion registration in the suite names the backends it takes, and the registrations are the ones pinned here", () => {
	// A registration that names neither marker would run with the pi backend this build registers, which is a real
	// harness: a case that routed to it would start a child instead of failing in a way a test can read. So every
	// registration has to say which of the two it is, and a bare one that somebody adds later fails here.
	const TRIPWIRE = "piTripwire";
	const DEFAULTS = "productionDefaults";
	const defaults: string[] = [];
	const counted: Record<string, number> = {};
	for (const file of testFiles()) {
		const where = relative(file);
		for (const call of fusionRegistrations(fs.readFileSync(file, "utf8"))) {
			counted[where] = (counted[where] ?? 0) + 1;
			const tripwire = call.includes(TRIPWIRE);
			const production = call.includes(DEFAULTS);
			assert.ok(tripwire || production, `${where} registers the extension without naming ${TRIPWIRE} or ${DEFAULTS}: ${call}`);
			assert.ok(!(tripwire && production), `${where} registers the extension naming both ${TRIPWIRE} and ${DEFAULTS}, which cannot both be what it takes: ${call}`);
			if (production) defaults.push(where);
		}
	}
	assert.deepEqual(counted, REGISTRATIONS, "the suite registers the extension somewhere new, or the detector above stopped seeing a registration that is still there");
	assert.equal(
		Object.values(counted).reduce((all, one) => all + one, 0),
		REGISTRATIONS_TOTAL,
		"the total is pinned beside the map so a count moved from one file to another still has to be looked at",
	);
	assert.deepEqual(defaults, ["test/extension.test.ts", "test/routing.test.ts"], "exactly two cases read this build's own pi registration, and every other one keeps the tripwire in its place");
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
	// `ROLE_NAMES` is the claude binding's own list, which is what the compatibility tool advertises: security runs on
	// the pi backend alone, so it is not in it, and the primary tool advertises every role a record may name.
	assert.deepEqual([...ROLE_NAMES].sort(), ["ask", "implement", "plan", "ultracode"], "security runs on pi alone, so the claude binding has no role of that name");
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
	assert.equal(runsOn("security", "pi"), true, "and the backend it does run on binds it");
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
