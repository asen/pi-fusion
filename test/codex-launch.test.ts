import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CODEX_APP_SERVER_ARGS, CODEX_BIN_VARIABLE, codexLaunch, expectedCodexHome, locateCodex } from "../extensions/backends/codex-launch.ts";

/**
 * Codex launch preparation on its own: which binary a launch runs, with what arguments, cwd and environment, and the
 * cwd and home a later handshake expects. Every binary here is a fixture script under a temporary root that nothing
 * runs: the module starts no process, and this file starts none either.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A temporary root whose own path is already its realpath, so an expected realpath is the fixture's own path. */
const fixture = (t: { after(fn: () => void): void }): string => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-codex-launch-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
};

/** A file at `file`, executable or not; its body would fail loudly if anything ever ran it. */
const script = (file: string, mode: number): string => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "#!/bin/sh\necho 'a codex-launch fixture was run' >&2\nexit 99\n", { mode });
	fs.chmodSync(file, mode);
	return file;
};

const dir = (file: string): string => {
	fs.mkdirSync(file, { recursive: true });
	return file;
};

test("an override naming a native executable runs it directly as an app-server over stdio", (t) => {
	const root = fixture(t);
	const bin = script(path.join(root, "bin", "codex-native"), 0o755);
	const work = dir(path.join(root, "work"));
	const prepared = codexLaunch({ cwd: work, env: { [CODEX_BIN_VARIABLE]: bin, PATH: "" }, platform: "linux" });
	assert.deepEqual(prepared.executable, { command: bin, prefix: [], path: bin, source: "override" });
	assert.equal(prepared.launch.command, bin);
	assert.deepEqual(prepared.launch.args, ["app-server", "--listen", "stdio://"]);
	assert.deepEqual([...CODEX_APP_SERVER_ARGS], ["app-server", "--listen", "stdio://"]);
	assert.equal(prepared.launch.cwd, work);
});

test("an override naming a .js, .mjs or .cjs script runs it under this host's own node, executable or not", (t) => {
	const root = fixture(t);
	const work = dir(path.join(root, "work"));
	for (const name of ["codex.js", "codex.mjs", "codex.cjs", "CODEX.MJS"]) {
		const file = script(path.join(root, "wrappers", name), 0o644);
		const prepared = codexLaunch({ cwd: work, env: { [CODEX_BIN_VARIABLE]: file }, platform: "linux" });
		assert.deepEqual(prepared.executable, { command: process.execPath, prefix: [file], path: file, source: "override" }, name);
		assert.deepEqual(prepared.launch.args, [file, "app-server", "--listen", "stdio://"], name);
	}
});

test("an override is trimmed like PI_FUSION_CLAUDE_BIN's, and a blank one counts as unset", (t) => {
	const root = fixture(t);
	const bin = script(path.join(root, "bin", "codex"), 0o755);
	const other = script(path.join(root, "other", "codex"), 0o755);
	assert.equal(locateCodex({ [CODEX_BIN_VARIABLE]: `  ${other}\n` }, root, "linux").command, other);
	for (const blank of ["", "  "]) {
		const found = locateCodex({ [CODEX_BIN_VARIABLE]: blank, PATH: path.dirname(bin) }, root, "linux");
		assert.deepEqual(found, { command: bin, prefix: [], path: bin, source: "path" }, JSON.stringify(blank));
	}
});

test("an override that is relative, missing, not a regular file or not executable is refused by name, never passed over for PATH", (t) => {
	const root = fixture(t);
	const onPath = script(path.join(root, "path", "codex"), 0o755);
	const env = (value: string) => ({ [CODEX_BIN_VARIABLE]: value, PATH: path.dirname(onPath) });
	const native = script(path.join(root, "bin", "codex-plain"), 0o644);
	const folder = dir(path.join(root, "bin", "codex-dir"));
	const scriptFolder = dir(path.join(root, "bin", "codex-dir.mjs"));
	const linkToFolder = path.join(root, "bin", "codex-link");
	fs.symlinkSync(folder, linkToFolder);
	const cases: [string, RegExp][] = [
		["codex", /^Error: PI_FUSION_CODEX_BIN must be an absolute path to the Codex binary; it is "codex"$/],
		["./bin/codex", /^Error: PI_FUSION_CODEX_BIN must be an absolute path/],
		["bin/codex.mjs", /^Error: PI_FUSION_CODEX_BIN must be an absolute path/],
		[path.join(root, "missing", "codex"), /^Error: PI_FUSION_CODEX_BIN names ".*", which does not exist$/],
		[folder, /^Error: PI_FUSION_CODEX_BIN names ".*", which is not a regular file$/],
		[scriptFolder, /^Error: PI_FUSION_CODEX_BIN names ".*", which is not a regular file$/],
		[linkToFolder, /^Error: PI_FUSION_CODEX_BIN names ".*", which is not a regular file$/],
		[native, /^Error: PI_FUSION_CODEX_BIN names ".*", which is not executable$/],
	];
	for (const [value, message] of cases) {
		assert.throws(() => locateCodex(env(value), root, "linux"), message, value);
		assert.throws(() => codexLaunch({ cwd: root, env: env(value), platform: "linux" }), message, value);
	}
});

test("an override that is a symlink to an executable regular file is accepted as given, not as its target", (t) => {
	const root = fixture(t);
	const target = script(path.join(root, "real", "codex"), 0o755);
	const link = path.join(root, "codex-link");
	fs.symlinkSync(target, link);
	assert.deepEqual(locateCodex({ [CODEX_BIN_VARIABLE]: link }, root, "linux"), { command: link, prefix: [], path: link, source: "override" });
});

test("PATH lookup takes the first executable regular codex, passing over missing, non-executable and directory entries", (t) => {
	const root = fixture(t);
	const empty = dir(path.join(root, "empty"));
	const plain = script(path.join(root, "plain", "codex"), 0o644);
	const folder = dir(path.join(root, "folder", "codex"));
	const first = script(path.join(root, "first", "codex"), 0o755);
	const second = script(path.join(root, "second", "codex"), 0o755);
	const search = [path.join(root, "absent"), empty, path.dirname(plain), path.dirname(folder), path.dirname(first), path.dirname(second)].join(":");
	assert.deepEqual(locateCodex({ PATH: search }, root, "linux"), { command: first, prefix: [], path: first, source: "path" });
	assert.equal(locateCodex({ PATH: [path.dirname(second), path.dirname(first)].join(":") }, root, "linux").command, second);
});

test("PATH lookup finds a codex symlink, such as npm's bin link to a script, and runs the link itself rather than under node", (t) => {
	const root = fixture(t);
	const target = script(path.join(root, "lib", "codex.js"), 0o755);
	const link = path.join(dir(path.join(root, "bin")), "codex");
	fs.symlinkSync(target, link);
	assert.deepEqual(locateCodex({ PATH: path.dirname(link) }, root, "linux"), { command: link, prefix: [], path: link, source: "path" });
});

test("PATH lookup resolves an empty or relative entry against the host's working directory, as execvp would", (t) => {
	const root = fixture(t);
	const work = dir(path.join(root, "work"));
	const local = script(path.join(work, "codex"), 0o755);
	const relative = script(path.join(work, "tools", "codex"), 0o755);
	assert.equal(locateCodex({ PATH: "" }, work, "linux").command, local);
	assert.equal(locateCodex({ PATH: `${path.join(root, "absent")}::/nowhere` }, work, "linux").command, local);
	assert.equal(locateCodex({ PATH: "." }, work, "linux").command, local);
	assert.equal(locateCodex({ PATH: "tools" }, work, "linux").command, relative);
	assert.equal(codexLaunch({ cwd: work, env: { PATH: "tools" }, platform: "linux" }).launch.command, relative);
});

test("no codex on PATH, or no PATH at all, is refused naming PATH and the override variable", (t) => {
	const root = fixture(t);
	const empty = dir(path.join(root, "empty"));
	script(path.join(root, "plain", "codex"), 0o644);
	assert.throws(() => locateCodex({ PATH: [empty, path.join(root, "plain")].join(":") }, root, "linux"), /^Error: no executable codex on PATH; install Codex or set PI_FUSION_CODEX_BIN to its absolute path$/);
	assert.throws(() => locateCodex({}, root, "linux"), /^Error: no PATH in the inherited environment to find codex on; set PI_FUSION_CODEX_BIN to the Codex binary's absolute path$/);
	assert.throws(() => codexLaunch({ cwd: root, env: {}, platform: "linux" }), /no PATH in the inherited environment/);
});

test("the launch environment is a copy of the inherited one with nothing added, removed or rewritten", (t) => {
	const root = fixture(t);
	const bin = script(path.join(root, "bin", "codex"), 0o755);
	const env: NodeJS.ProcessEnv = {
		PATH: `${path.dirname(bin)}:`,
		HOME: root,
		CODEX_HOME: " ./relative-home ",
		OPENAI_API_KEY: "sk-fixture",
		CODEX_API_KEY: "codex-fixture",
		OPENAI_BASE_URL: "http://127.0.0.1:1/",
		RUST_LOG: "",
		PI_FUSION_CHILD: "pi",
		[CODEX_BIN_VARIABLE]: "",
		NODE_COMPILE_CACHE: "/somewhere",
		Path: "mixed-case",
	};
	const before = structuredClone(env);
	const prepared = codexLaunch({ cwd: root, env, platform: "linux" });
	assert.deepEqual(prepared.launch.env, before);
	assert.notEqual(prepared.launch.env, env, "the launch holds the host's own object, so a later write would reach the host");
	assert.deepEqual(env, before, "the inherited environment was changed");
	assert.deepEqual(Object.keys(prepared.launch.env), Object.keys(before));
});

test("an omitted environment is this process's own, copied", () => {
	const saved = process.env[CODEX_BIN_VARIABLE];
	process.env[CODEX_BIN_VARIABLE] = process.execPath;
	try {
		const prepared = codexLaunch({ cwd: repoRoot, platform: "linux" });
		assert.equal(prepared.launch.command, process.execPath);
		assert.deepEqual(prepared.launch.env, { ...process.env });
		assert.notEqual(prepared.launch.env, process.env);
	} finally {
		if (saved === undefined) delete process.env[CODEX_BIN_VARIABLE];
		else process.env[CODEX_BIN_VARIABLE] = saved;
	}
});

test("the launch cwd is the host's as given, and the expected cwd is its realpath", (t) => {
	const root = fixture(t);
	const bin = script(path.join(root, "bin", "codex"), 0o755);
	const real = dir(path.join(root, "real-work"));
	const link = path.join(root, "linked-work");
	fs.symlinkSync(real, link);
	const env = { [CODEX_BIN_VARIABLE]: bin, HOME: root };
	const prepared = codexLaunch({ cwd: link, env, platform: "linux" });
	assert.equal(prepared.launch.cwd, link);
	assert.equal(prepared.expectedCwd, real);
	assert.equal(codexLaunch({ cwd: path.join(link, "..", "linked-work"), env, platform: "linux" }).expectedCwd, real);
	assert.equal(codexLaunch({ cwd: `${real}/`, env, platform: "linux" }).expectedCwd, real);
});

test("a working directory that is relative, missing or not a directory is refused before any binary is looked up", (t) => {
	const root = fixture(t);
	const file = script(path.join(root, "file"), 0o644);
	const env = { PATH: "" };
	assert.throws(() => codexLaunch({ cwd: "work", env, platform: "linux" }), /^Error: the codex child's working directory must be an absolute path; it is "work"$/);
	assert.throws(() => codexLaunch({ cwd: "", env, platform: "linux" }), /must be an absolute path; it is ""$/);
	assert.throws(() => codexLaunch({ cwd: path.join(root, "missing"), env, platform: "linux" }), /^Error: the codex child's working directory ".*" does not exist$/);
	assert.throws(() => codexLaunch({ cwd: file, env, platform: "linux" }), /^Error: the codex child's working directory ".*" is not a directory$/);
});

test("the expected home is a non-empty CODEX_HOME, realpath'd against the cwd, or HOME's .codex, and is never created", (t) => {
	const root = fixture(t);
	const work = dir(path.join(root, "work"));
	const realHome = dir(path.join(root, "real-codex-home"));
	const linkedHome = path.join(root, "linked-codex-home");
	fs.symlinkSync(realHome, linkedHome);
	assert.equal(expectedCodexHome({ CODEX_HOME: linkedHome, HOME: "/elsewhere" }, work), realHome);
	assert.equal(expectedCodexHome({ CODEX_HOME: "../linked-codex-home" }, work), realHome);
	const missing = path.join(root, "missing-home");
	assert.equal(expectedCodexHome({ CODEX_HOME: `${missing}/./` }, work), missing);
	assert.equal(fs.existsSync(missing), false, "a missing CODEX_HOME was created");

	const user = dir(path.join(root, "user"));
	const userLink = path.join(root, "user-link");
	fs.symlinkSync(user, userLink);
	assert.equal(expectedCodexHome({ CODEX_HOME: "", HOME: userLink }, work), path.join(userLink, ".codex"));
	assert.equal(fs.existsSync(path.join(user, ".codex")), false, "the default home was created");
	const codexDir = dir(path.join(user, ".codex"));
	assert.equal(expectedCodexHome({ HOME: userLink }, work), codexDir);
	// An empty HOME falls to the account's own home, supplied here rather than read from the real account.
	assert.equal(expectedCodexHome({ HOME: "" }, work, () => user), codexDir);
	assert.equal(expectedCodexHome({}, work, () => path.join(root, "nobody")), path.join(root, "nobody", ".codex"));
	assert.equal(expectedCodexHome({ HOME: userLink }, work, () => assert.fail("the account was looked up though HOME is set")), codexDir);
	assert.equal(expectedCodexHome({ CODEX_HOME: linkedHome }, work, () => assert.fail("the account was looked up though CODEX_HOME is set")), realHome);
});

test("an account with no home to look up is refused naming CODEX_HOME and HOME, not with the lookup's own error", () => {
	const message = /^Error: neither CODEX_HOME nor HOME is set and this account has no home directory to look up, so the Codex home a child would use cannot be known; set CODEX_HOME or HOME$/;
	const failing = () => {
		throw Object.assign(new Error("uv_os_get_passwd returned ENOENT (no such file or directory)"), { code: "ERR_SYSTEM_ERROR" });
	};
	for (const env of [{}, { HOME: "" }, { CODEX_HOME: "", HOME: "" }] as NodeJS.ProcessEnv[]) {
		assert.throws(() => expectedCodexHome(env, "/work", failing), message, JSON.stringify(env));
		assert.throws(() => expectedCodexHome(env, "/work", () => ""), message, JSON.stringify(env));
	}
});

test("the launch's expected home reads the same environment the child inherits, unchanged", (t) => {
	const root = fixture(t);
	const bin = script(path.join(root, "bin", "codex"), 0o755);
	const home = dir(path.join(root, "codex-home"));
	const env = { [CODEX_BIN_VARIABLE]: bin, CODEX_HOME: "codex-home" };
	const prepared = codexLaunch({ cwd: root, env, platform: "linux" });
	assert.equal(prepared.expectedCodexHome, home);
	assert.equal(prepared.launch.env.CODEX_HOME, "codex-home");
	assert.deepEqual(fs.readdirSync(home), [], "the home was written to");
});

test("Windows is refused when a launch is composed, before anything is looked up", (t) => {
	const root = fixture(t);
	const bin = script(path.join(root, "codex.mjs"), 0o644);
	const message = /^Error: the codex backend does not launch Codex on Windows in this build/;
	assert.throws(() => locateCodex({ [CODEX_BIN_VARIABLE]: bin }, root, "win32"), message);
	assert.throws(() => codexLaunch({ cwd: "relative", env: {}, platform: "win32" }), message);
});

test("the launch module imports no process-starting module and nothing beyond node and process-tree's types", () => {
	const source = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "codex-launch.ts"), "utf8");
	const imports = [...source.matchAll(/^import\s+(type\s+)?.*?from\s+"([^"]+)";$/gm)].map((match) => `${match[1] ?? ""}${match[2]}`);
	assert.deepEqual(imports, ["node:fs", "node:os", "node:path", "type ../process-tree.ts"]);
	assert.doesNotMatch(source, /child_process|spawn\(|execFile|exec\(/);
});
