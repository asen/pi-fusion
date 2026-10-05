import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { PI_BOOTSTRAP_PATH, PI_SDK_RESOLVE_PATH, SDK_DIR_VARIABLE as LAUNCH_VARIABLE } from "../extensions/backends/pi-launch.ts";
import { REDIRECTED, redirected, SDK_DIR_VARIABLE } from "../extensions/backends/pi-sdk-resolve.mjs";

/**
 * The preload a Pi child resolves the host's own Pi through. The subprocess below loads a fake package of literals that
 * stands where the host's would, so no case here imports the real SDK: what it measures is which file an import lands
 * on, and nothing about Pi.
 */

const SCOPE = "file:///install/extensions/";

test("the launch and the preload name the same variable", () => {
	assert.equal(LAUNCH_VARIABLE, SDK_DIR_VARIABLE);
	assert.deepEqual(REDIRECTED, ["@earendil-works/pi-coding-agent", "typebox"]);
});

test("only this extension's own imports of the SDK and typebox are redirected", () => {
	const ours = `${SCOPE}backends/pi-bootstrap.mjs`;
	for (const specifier of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent/rpc-entry", "typebox", "typebox/value"]) {
		assert.equal(redirected(specifier, ours, SCOPE), true, `${specifier} from this extension goes to the host's package`);
	}
	for (const specifier of ["@earendil-works/pi-coding-agent-extra", "typebox-extra", "@earendil-works/pi-ai", "node:fs", "./pi-question-tool.mjs"]) {
		assert.equal(redirected(specifier, ours, SCOPE), false, `${specifier} is not one of the two packages`);
	}
	assert.equal(redirected("typebox", "file:///host/node_modules/@earendil-works/pi-coding-agent/dist/index.js", SCOPE), false, "the SDK's own imports already resolve from where it lies");
	assert.equal(redirected("typebox", "file:///install/extensions-other/x.mjs", SCOPE), false, "a sibling directory that shares the prefix is not this extension");
	assert.equal(redirected("typebox", undefined, SCOPE), false, "an entry point with no importer is left alone");
});

test("a child started through the preload loads the host's package, and its tools inherit no variable", (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-sdk-resolve-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const host = path.join(root, "host", "node_modules", "@earendil-works", "pi-coding-agent");
	const write = (file: string, text: string): void => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};
	write(path.join(host, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: { ".": { import: "./index.js" } } }));
	write(path.join(host, "index.js"), 'export const VERSION = "host-fake";\n');
	const typebox = path.join(host, "node_modules", "typebox");
	write(path.join(typebox, "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": { import: "./index.js" } } }));
	write(path.join(typebox, "index.js"), 'globalThis.__hostTypebox = true;\nexport const Type = { Object: (shape) => ({ shape }), String: (options) => ({ options }) };\n');

	// The bootstrap imports the question tool, and with it `typebox`, at load; `loadSdk` is its own import of the SDK.
	const script = [
		`const bootstrap = await import(${JSON.stringify(pathToFileURL(PI_BOOTSTRAP_PATH).href)});`,
		"const sdk = await bootstrap.loadSdk();",
		`console.log(JSON.stringify({ sdk: sdk.VERSION, typebox: globalThis.__hostTypebox === true, inherited: process.env[${JSON.stringify(SDK_DIR_VARIABLE)}] ?? null }));`,
	].join("\n");
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: root, [SDK_DIR_VARIABLE]: host };
	const child = spawnSync(process.execPath, ["--import", pathToFileURL(PI_SDK_RESOLVE_PATH).href, "--input-type=module", "-e", script], { cwd: root, env, encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { sdk: "host-fake", typebox: true, inherited: null });
});

test("a preload handed a relative directory refuses to start rather than resolve against the working directory", (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-sdk-resolve-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, TMPDIR: root, [SDK_DIR_VARIABLE]: "relative/pi" };
	const child = spawnSync(process.execPath, ["--import", pathToFileURL(PI_SDK_RESOLVE_PATH).href, "--input-type=module", "-e", "console.log('ran')"], { cwd: root, env, encoding: "utf8" });
	assert.notEqual(child.status, 0);
	assert.equal(child.stdout, "");
	assert.match(child.stderr, /PI_FUSION_SDK_DIR is not an absolute path/);
});
