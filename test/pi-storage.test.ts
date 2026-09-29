import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	AUTH_FILE,
	BIN_DIR,
	CACHE_DIR,
	CALLS_DIR,
	CATALOG_DIR,
	CHILDREN_DIR,
	FUSION_DIR,
	INPUT_FILE,
	JITI_CACHE_DIR,
	MODELS_FILE,
	MODELS_STORE_FILE,
	NODE_CACHE_DIR,
	piPaths,
	prepareCallStorage,
	projectSlug,
	publishCatalog,
	readableInput,
	safeHandle,
	SESSIONS_DIR,
	writeCallInput,
} from "../extensions/backends/pi-storage.ts";

/*
 * The storage layout, against a throwaway host agent directory. Nothing here starts a Pi child or touches the user's
 * own profile: every case builds a host directory in a temp dir and reads back what the layout did to it. The mode and
 * symlink assertions are qualified where the platform decides them rather than skipped wholesale, so a Linux run says
 * what it checked on Linux and nothing about Windows.
 */

const posix = process.platform !== "win32";
const rootUser = posix && process.getuid?.() === 0;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withHost(body: (host: string, work: string) => void): void {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-storage-"));
	try {
		const host = path.join(root, "agent");
		const work = path.join(root, "project");
		fs.mkdirSync(host, { recursive: true });
		fs.mkdirSync(work, { recursive: true });
		body(host, work);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const mode = (target: string): string => (fs.statSync(target).mode & 0o777).toString(8);
const stagingLeft = (agentDir: string): string[] => fs.readdirSync(agentDir).filter((name) => name.startsWith(".catalog-"));

test("the layout puts everything Fusion manages in one subtree inside the host agent directory", () => {
	const paths = piPaths("/home/someone/.pi/agent", "/work/project");
	const root = path.join("/home/someone/.pi/agent", FUSION_DIR);
	assert.equal(paths.root, root);
	assert.equal(paths.agentDir, path.join(root, CHILDREN_DIR));
	assert.equal(paths.catalogDir, path.join(root, CHILDREN_DIR, CATALOG_DIR));
	assert.equal(paths.modelsStorePath, path.join(root, CHILDREN_DIR, CATALOG_DIR, MODELS_STORE_FILE));
	assert.equal(paths.sessionDir, path.join(root, CHILDREN_DIR, SESSIONS_DIR, projectSlug("/work/project")));
	assert.equal(paths.callsDir, path.join(root, CALLS_DIR));
	assert.equal(paths.userModelsPath, path.join("/home/someone/.pi/agent", MODELS_FILE));
	assert.equal(paths.userAuthPath, path.join("/home/someone/.pi/agent", AUTH_FILE));
	assert.equal(paths.hostBinDir, path.join("/home/someone/.pi/agent", BIN_DIR), "the helper bin is the host's own, beside the profile rather than inside what Fusion owns");
	assert.equal(paths.hostBinDir.startsWith(`${root}${path.sep}`), false, "the host's helper bin is not under the Fusion-owned root, so nothing here owns or removes it");
});

test("a session directory is one per project, named for the project and fixed by its absolute path", () => {
	assert.equal(projectSlug("/work/project"), projectSlug("/work/project/"), "the same project is the same directory");
	assert.notEqual(projectSlug("/work/project"), projectSlug("/other/project"), "two checkouts sharing a name get their own directories");
	assert.match(projectSlug("/work/my project (2)"), /^my-project-2--[0-9a-f]{16}$/, "a name a path could not carry is reduced to one it can");
	assert.match(projectSlug("/"), /^[0-9a-f]{16}$/, "a project with no name of its own is still one directory");
});

test("the stable directories are made once and reused, while each call gets a directory of its own", () => {
	withHost((host, work) => {
		const first = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		const second = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		for (const field of ["root", "agentDir", "catalogDir", "modelsStorePath", "sessionDir", "callsDir"] as const) {
			assert.equal(first[field], second[field], `${field} is the same directory for every call`);
		}
		assert.notEqual(first.callDir, second.callDir, "the same handle continued twice gets two call directories");
		assert.equal(path.dirname(first.callDir), first.callsDir);
		assert.equal(first.inputPath, path.join(first.callDir, INPUT_FILE));
		assert.equal(first.cacheDir, path.join(first.callDir, CACHE_DIR));
		assert.notEqual(first.cacheDir, second.cacheDir, "a call's caches are inside its own directory, so two calls share none of them");
		assert.ok(fs.statSync(first.agentDir).isDirectory());
		assert.ok(fs.statSync(first.sessionDir).isDirectory(), "the project's durable session directory is there before the child needs it");
		assert.ok(fs.statSync(second.callDir).isDirectory());
		for (const cache of [first.cacheDir, path.join(first.cacheDir, JITI_CACHE_DIR), path.join(first.cacheDir, NODE_CACHE_DIR)]) {
			assert.ok(fs.statSync(cache).isDirectory(), `${cache} is not there before the child that writes into it starts`);
		}
		if (posix) {
			assert.equal(mode(first.root), "700");
			assert.equal(mode(first.agentDir), "700");
			assert.equal(mode(first.sessionDir), "700");
			assert.equal(mode(first.callDir), "700");
			assert.equal(mode(first.cacheDir), "700");
			assert.equal(mode(path.join(first.cacheDir, JITI_CACHE_DIR)), "700");
			assert.equal(mode(path.join(first.cacheDir, NODE_CACHE_DIR)), "700");
		}
	});
});

test("a call carries a private models path of its own, and nothing creates the file at it", () => {
	withHost((host, work) => {
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.equal(storage.privateModelsPath, path.join(storage.callDir, MODELS_FILE));
		assert.equal(fs.existsSync(storage.privateModelsPath), false, "preparing storage does not create the private models file");
		writeCallInput(storage, { version: 1, role: "implement", modelsPath: storage.privateModelsPath });
		assert.equal(fs.existsSync(storage.privateModelsPath), false, "writing the call input does not create it either");
		assert.deepEqual(fs.readdirSync(storage.callDir).sort(), [INPUT_FILE, CACHE_DIR].sort(), "the call directory holds the input and the caches, and nothing Pi has not asked for yet");
		const second = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.notEqual(second.privateModelsPath, storage.privateModelsPath, "each call's private path is inside its own directory");
	});
});

test("the host's helper bin is a name the layout computes, and preparing a call neither creates it nor needs it", () => {
	withHost((host, work) => {
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.equal(storage.hostBinDir, path.join(host, BIN_DIR));
		assert.equal(fs.existsSync(storage.hostBinDir), false, "preparing a call created the host's helper bin, and that directory is Pi's own to fill");
		// A host that has never downloaded a helper is an ordinary host: the path is composed, the call is prepared, and
		// whether anything is in that directory is the child's own question when it looks.
		assert.deepEqual(fs.readdirSync(host).sort(), [FUSION_DIR], "preparing a call put something beside the Fusion-owned root in the host's agent directory");
		storage.dispose();
		// An existing one is not read, checked or changed either: it is input metadata and nothing here opens it.
		fs.mkdirSync(storage.hostBinDir);
		fs.writeFileSync(path.join(storage.hostBinDir, "rg"), "#!/bin/sh\n");
		const second = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-2" });
		assert.equal(second.hostBinDir, storage.hostBinDir, "the helper bin is the same directory for every call, as the host agent directory is");
		assert.deepEqual(fs.readdirSync(second.hostBinDir), ["rg"], "the helper bin was written to by preparing a call");
		second.dispose();
	});
});

test("the user's models and auth files are resolved as inputs and never created", () => {
	withHost((host, work) => {
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.equal(storage.modelsPath, null, "a user with no models file gets no models file, not an empty one");
		assert.equal(storage.sharedAuth, false);
		assert.equal(storage.authPath, path.join(storage.callDir, AUTH_FILE), "a missing user auth file becomes this call's private path, never the path the user does not have");
		assert.equal(fs.existsSync(path.join(host, MODELS_FILE)), false);
		assert.equal(fs.existsSync(path.join(host, AUTH_FILE)), false);
		assert.equal(fs.existsSync(storage.authPath), false, "the private auth path is a path, and Pi is what creates the file at it");

		fs.writeFileSync(path.join(host, MODELS_FILE), "{}");
		fs.writeFileSync(path.join(host, AUTH_FILE), '{"anthropic":{}}');
		const shared = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-2" });
		assert.equal(shared.modelsPath, path.join(host, MODELS_FILE));
		assert.equal(shared.authPath, path.join(host, AUTH_FILE), "an existing auth file is used where it lives");
		assert.equal(shared.sharedAuth, true);
		assert.equal(fs.readFileSync(path.join(host, AUTH_FILE), "utf8"), '{"anthropic":{}}', "resolving an input does not write to it");
	});
});

test("a symlinked input is read through, and a dangling one means no input at that path", { skip: posix ? false : "symlink creation needs privileges on this platform" }, () => {
	withHost((host, work) => {
		const real = path.join(host, "elsewhere-models.json");
		fs.writeFileSync(real, "{}");
		fs.symlinkSync(real, path.join(host, MODELS_FILE));
		fs.symlinkSync(path.join(host, "nothing-here.json"), path.join(host, AUTH_FILE));
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.equal(storage.modelsPath, path.join(host, MODELS_FILE), "a valid symlink to a regular file is an input");
		assert.equal(storage.sharedAuth, false, "a dangling symlink is no input at all");
		assert.equal(storage.authPath, path.join(storage.callDir, AUTH_FILE));
		assert.equal(fs.existsSync(path.join(host, "nothing-here.json")), false, "a dangling link's target is not created");
	});
});

test("an input path that is not a readable regular file fails actionably instead of passing for absent", () => {
	withHost((host, work) => {
		fs.mkdirSync(path.join(host, MODELS_FILE));
		assert.throws(
			() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }),
			(error: Error) => {
				assert.match(error.message, /inspect .*models\.json and repair it by hand: it is not a regular file/);
				assert.doesNotMatch(error.message, /delete|remove/i, "guidance never tells anyone to delete a path that may hold their data");
				return true;
			},
		);
	});
});

test("a file this user cannot read fails rather than reading as one the user does not have", { skip: posix && !rootUser ? false : "file modes do not deny this user on this platform" }, () => {
	withHost((host, work) => {
		const models = path.join(host, MODELS_FILE);
		fs.writeFileSync(models, "{}");
		fs.chmodSync(models, 0o000);
		try {
			assert.equal(readableInput(path.join(host, "absent.json")), false);
			assert.throws(() => readableInput(models), /is not readable by this user \(EACCES\)/);
			assert.throws(() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }), /models\.json/);
		} finally {
			fs.chmodSync(models, 0o600);
		}
	});
});

test("the catalog directory is published whole, with the store already in it", () => {
	withHost((host, work) => {
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.ok(fs.statSync(storage.catalogDir).isDirectory());
		assert.equal(fs.readFileSync(storage.modelsStorePath, "utf8"), "{}", "a published store is an empty store, never a missing file for Pi to find");
		assert.deepEqual(stagingLeft(storage.agentDir), [], "the publisher leaves no staging directory behind");
		if (posix) {
			assert.equal(mode(storage.catalogDir), "700");
			assert.equal(mode(storage.modelsStorePath), "600");
		}
	});
});

test("a populated catalog is left byte for byte what it was", () => {
	withHost((host, work) => {
		const first = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		const populated = JSON.stringify({ deepseek: { models: [{ id: "deepseek-chat" }] } }, null, 2);
		fs.writeFileSync(first.modelsStorePath, populated);
		const before = fs.statSync(first.modelsStorePath);
		assert.equal(publishCatalog(first), false, "an existing catalog directory is used, not republished");
		const second = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-2" });
		assert.equal(fs.readFileSync(second.modelsStorePath, "utf8"), populated);
		assert.equal(fs.statSync(second.modelsStorePath).mtimeMs, before.mtimeMs, "the publisher did not write to the store at all");
		assert.deepEqual(stagingLeft(second.agentDir), []);
	});
});

test("a publisher that lost the race removes only its own staging directory and uses the winner's store", () => {
	withHost((host, work) => {
		const paths = piPaths(host, work);
		const populated = JSON.stringify({ openrouter: { models: [{ id: "deepseek/deepseek-chat" }] } });
		let staged: string | undefined;
		// The window this closes is between staging and rename: the winner appears, populated, while this publisher is
		// holding a complete directory of its own. Driven through the production publisher, with no waiting involved.
		const storage = prepareCallStorage(
			{ hostAgentDir: host, cwd: work, handle: "run-1" },
			{
				onStaged: (temporary) => {
					staged = temporary;
					fs.mkdirSync(paths.catalogDir, { recursive: true, mode: 0o700 });
					fs.writeFileSync(paths.modelsStorePath, populated, { mode: 0o600 });
				},
			},
		);
		assert.ok(staged, "the publisher staged a directory before it tried to publish it");
		assert.equal(fs.existsSync(staged), false, "the loser removed its own staging directory");
		assert.equal(fs.readFileSync(storage.modelsStorePath, "utf8"), populated, "the winner's populated store survived the loser's publish");
		assert.deepEqual(stagingLeft(paths.agentDir), []);
	});
});

test("a malformed store is left exactly as it is for its owner to look at", () => {
	withHost((host, work) => {
		const paths = piPaths(host, work);
		fs.mkdirSync(paths.catalogDir, { recursive: true });
		const broken = '{"deepseek": {"models": [';
		fs.writeFileSync(paths.modelsStorePath, broken);
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.equal(fs.readFileSync(storage.modelsStorePath, "utf8"), broken, "the publisher parses no live store, so it repairs and truncates none either");
	});
});

test("an existing catalog directory without its store is refused, so no child creates that file unlocked", () => {
	for (const stray of [undefined, "leftover.json"]) {
		withHost((host, work) => {
			const paths = piPaths(host, work);
			fs.mkdirSync(paths.catalogDir, { recursive: true });
			if (stray) fs.writeFileSync(path.join(paths.catalogDir, stray), "{}");
			const before = fs.readdirSync(paths.catalogDir);
			assert.throws(
				() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }),
				(error: Error) => {
					assert.match(error.message, /models-store\.json and repair it by hand: the catalog directory is there and its model store is missing/);
					assert.match(error.message, /move the catalog directory aside/);
					assert.doesNotMatch(error.message, /delete|remove/i);
					return true;
				},
				stray ?? "an empty catalog directory",
			);
			assert.deepEqual(fs.readdirSync(paths.catalogDir), before, "a refusal publishes nothing and changes nothing");
			assert.equal(fs.existsSync(paths.modelsStorePath), false, "the store is not created by the refusal either");
			assert.deepEqual(stagingLeft(paths.agentDir), []);
			const calls = fs.existsSync(paths.callsDir) ? fs.readdirSync(paths.callsDir) : [];
			assert.deepEqual(calls, [], "the refusal comes before any call directory is made, so there is no input file and no launch to follow it");
		});
	}
});

test("a path of the wrong kind in the layout fails with inspect-or-repair guidance", () => {
	withHost((host, work) => {
		const paths = piPaths(host, work);
		fs.mkdirSync(paths.agentDir, { recursive: true });
		fs.writeFileSync(paths.catalogDir, "not a directory");
		assert.throws(() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }), /catalog and repair it by hand: it is not a directory/);
	});
	withHost((host, work) => {
		fs.writeFileSync(path.join(host, FUSION_DIR), "not a directory");
		assert.throws(() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }), /pi-fusion and repair it by hand/);
	});
	withHost((host, work) => {
		const paths = piPaths(host, work);
		fs.mkdirSync(paths.catalogDir, { recursive: true });
		fs.mkdirSync(paths.modelsStorePath);
		assert.throws(() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }), /models-store\.json and repair it by hand: it is not a regular file/);
	});
});

test("a handle that could leave the calls directory is refused before it becomes a path", () => {
	withHost((host, work) => {
		for (const handle of ["..", ".", "", "../evil", "a/b", "a\\b", "/absolute", "C:\\windows", ".hidden", "-lead", "run 1", "run:1"]) {
			assert.throws(() => safeHandle(handle), /cannot name a directory/, JSON.stringify(handle));
			assert.throws(() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle }), /cannot name a directory/, JSON.stringify(handle));
		}
		for (const handle of ["run-1", "run-12", "review_2", "a.b"]) assert.equal(safeHandle(handle), handle);
	});
});

test("a call disposes the directory it made, and that is the only directory it can dispose", () => {
	withHost((host, work) => {
		const storage = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		const other = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-2" });
		writeCallInput(storage, { version: 1, role: "implement" });
		assert.equal(fs.readFileSync(storage.inputPath, "utf8"), '{"version":1,"role":"implement"}');
		if (posix) assert.equal(mode(storage.inputPath), "600", "the call input names the auth file the child reads, so it is private");
		const transcript = path.join(storage.sessionDir, "session.jsonl");
		fs.writeFileSync(transcript, '{"type":"session"}\n');
		// A directory of the same shape and name under another root: the closure holds one path, so this is untouchable
		// through it, and there is no exported disposal a caller could hand this path to instead.
		const foreign = path.join(host, "other-root", FUSION_DIR, CALLS_DIR, path.basename(storage.callDir));
		fs.mkdirSync(foreign, { recursive: true });
		fs.writeFileSync(path.join(foreign, INPUT_FILE), "{}");

		const compiled = path.join(storage.cacheDir, NODE_CACHE_DIR, "compiled.blob");
		fs.writeFileSync(compiled, "cached");

		storage.dispose();
		assert.equal(fs.existsSync(storage.callDir), false);
		assert.equal(fs.existsSync(compiled), false, "what the child compiled goes with the call directory it was written into");
		assert.equal(fs.existsSync(other.callDir), true, "another call's directory is not this call's to remove");
		assert.equal(fs.existsSync(transcript), true, "durable sessions outlive the call that made them");
		assert.equal(fs.existsSync(storage.modelsStorePath), true, "the shared catalog outlives the call that published it");
		assert.equal(fs.existsSync(path.join(foreign, INPUT_FILE)), true, "a directory that only looks like this call's is not this call's");
		storage.dispose();
		storage.dispose();
		assert.equal(fs.existsSync(storage.callDir), false, "disposing again is a no-op, so a finally can run more than once");
		other.dispose();
		assert.equal(fs.existsSync(other.callDir), false);
		assert.equal(fs.existsSync(other.callsDir), true, "the calls directory itself is not a call's to remove");
	});
});

test("a call directory nobody holds the name of is removed before the failure that stopped it is reported", () => {
	// A fault the layout cannot reach any other way: everything after mkdtemp is a directory creation, so the narrowest
	// deterministic failure is `mkdirSync` refusing this call's own cache directory. The builtin is patched through the
	// CJS module object and the ESM views are synced, which is what reaches the import the layout already made; it is
	// restored in `finally`, and no production seam exists for this.
	const cjs = createRequire(import.meta.url)("node:fs") as typeof fs;
	const real = cjs.mkdirSync;
	withHost((host, work) => {
		const paths = piPaths(host, work);
		let refused: string | undefined;
		cjs.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
			if (path.basename(String(target)) === NODE_CACHE_DIR && String(target).startsWith(paths.callsDir)) {
				refused = String(target);
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return (real as (target: fs.PathLike, options?: fs.MakeDirectoryOptions) => string | undefined)(target, options);
		}) as typeof fs.mkdirSync;
		syncBuiltinESMExports();
		try {
			assert.throws(() => prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" }), /it could not be created \(EACCES\)/);
		} finally {
			cjs.mkdirSync = real;
			syncBuiltinESMExports();
		}
		assert.ok(refused, "the fault was never reached, so this proves nothing about what a failure leaves behind");
		assert.deepEqual(fs.readdirSync(paths.callsDir), [], "the call directory the failed preparation made is still there, and nobody holds its name");
		// The failure is the call's alone: what the stable layout published stays published, and the next call works.
		assert.equal(fs.readFileSync(paths.modelsStorePath, "utf8"), "{}");
		const after = prepareCallStorage({ hostAgentDir: host, cwd: work, handle: "run-1" });
		assert.ok(fs.statSync(path.join(after.cacheDir, NODE_CACHE_DIR)).isDirectory());
		after.dispose();
	});
});

test("the storage layout exports no disposal a caller could aim at a path of its own", () => {
	const source = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-storage.ts"), "utf8");
	assert.doesNotMatch(source, /export function disposeCall/, "disposal is the closure prepareCallStorage returns, bound to the directory it made");
});

test("the storage layout depends on node alone and reads no variable of its own", () => {
	const source = fs.readFileSync(path.join(repoRoot, "extensions", "backends", "pi-storage.ts"), "utf8");
	assert.doesNotMatch(source, /process\.env/, "no variable moves, overrides or collects any of these paths");
});
