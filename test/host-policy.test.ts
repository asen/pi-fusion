import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileHostPolicyLoader, HOST_POLICY_FILE, HOST_POLICY_MAX_BYTES, hostPolicyLoader, memoryHostPolicyLoader, SHIPPED_HOST_POLICY_PATH } from "../extensions/host-policy.ts";

/** A temporary agent directory per case, removed after it, so no case reads the user's own. */
function agentDir(t: { after: (fn: () => void) => void }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-host-policy-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Writes an override under the agent directory's Fusion directory, where the production loader looks. */
function writeOverride(dir: string, content: string | Uint8Array): string {
	const file = path.join(dir, "pi-fusion", HOST_POLICY_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** Every path under the directory, for a case that checks loading created nothing. */
const tree = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

const shipped = fs.readFileSync(SHIPPED_HOST_POLICY_PATH, "utf8");

test("the shipped host policy is nonblank strict UTF-8 within the size limit, and is what a load with no override selects", async () => {
	const bytes = fs.readFileSync(SHIPPED_HOST_POLICY_PATH);
	assert.ok(bytes.byteLength > 0 && bytes.byteLength <= HOST_POLICY_MAX_BYTES);
	assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(bytes), shipped);
	assert.ok(shipped.trim());
	assert.equal(path.relative(path.resolve(import.meta.dirname, ".."), SHIPPED_HOST_POLICY_PATH), path.join("contracts", "host.md"));
	assert.deepEqual(await memoryHostPolicyLoader().load(), { text: shipped, source: "shipped", path: SHIPPED_HOST_POLICY_PATH });
});

test("a valid override replaces the shipped policy whole rather than appending to it", async (t) => {
	const dir = agentDir(t);
	const file = writeOverride(dir, "# Mine\n\nImplement directly when asked.\n");
	const loaded = await hostPolicyLoader(async () => dir).load();
	assert.deepEqual(loaded, { text: "# Mine\n\nImplement directly when asked.\n", source: "override", path: file });
	assert.ok(!loaded.text.includes(shipped.trim().split("\n")[0]!), "nothing of the shipped policy is kept beside an override");
	assert.deepEqual(await memoryHostPolicyLoader({ override: "only this" }).load(), { text: "only this", source: "override", path: "(override, in memory)" });
});

test("a missing override is the shipped policy with no diagnostic, and loading creates no directory or file", async (t) => {
	const dir = agentDir(t);
	assert.deepEqual(await hostPolicyLoader(async () => dir).load(), { text: shipped, source: "shipped", path: SHIPPED_HOST_POLICY_PATH });
	assert.deepEqual(tree(dir), [], "no pi-fusion directory, no host.md and no copy of the shipped policy");
	// An existing Fusion directory without host.md is the same, and is left as it was.
	fs.mkdirSync(path.join(dir, "pi-fusion"));
	assert.equal((await hostPolicyLoader(async () => dir).load()).diagnostic, undefined);
	assert.deepEqual(tree(dir), ["pi-fusion"]);
});

test("an override that is not acceptable text is set aside for the shipped policy, with a diagnostic naming it and why", async (t) => {
	const cases: [string, string | Uint8Array, RegExp][] = [
		["empty", "", /is empty/],
		["blank", " \n\t\r\n  \n", /is blank/],
		["malformed UTF-8", Uint8Array.from([0x23, 0x20, 0xc3, 0x28, 0x0a]), /is not valid UTF-8/],
		["a truncated multibyte sequence", Uint8Array.from([0x61, 0xe2, 0x82]), /is not valid UTF-8/],
		["oversize", "a".repeat(HOST_POLICY_MAX_BYTES + 1), /is larger than 65536 bytes/],
	];
	for (const [what, content, why] of cases) {
		const dir = agentDir(t);
		const file = writeOverride(dir, content);
		const loaded = await hostPolicyLoader(async () => dir).load();
		assert.equal(loaded.source, "shipped", what);
		assert.equal(loaded.text, shipped, what);
		assert.equal(loaded.path, SHIPPED_HOST_POLICY_PATH, what);
		assert.match(loaded.diagnostic ?? "", why, what);
		assert.ok(loaded.diagnostic!.includes(file), `${what}: the diagnostic names the override`);
		assert.match(loaded.diagnostic!, /using the shipped host policy instead$/, what);
		const memory = await memoryHostPolicyLoader({ override: content }).load();
		assert.equal(memory.source, "shipped", `${what} in memory`);
		assert.match(memory.diagnostic ?? "", why, `${what} in memory`);
	}
});

test("an override that cannot be read is set aside for the shipped policy, with a diagnostic", async (t) => {
	const dir = agentDir(t);
	fs.mkdirSync(path.join(dir, "pi-fusion", HOST_POLICY_FILE), { recursive: true });
	const directory = await hostPolicyLoader(async () => dir).load();
	assert.equal(directory.source, "shipped");
	assert.match(directory.diagnostic ?? "", /host\.md is not a regular file/);

	// Permission bits do not stop root, so this half says what it proves only where they apply.
	const unreadable = agentDir(t);
	const file = writeOverride(unreadable, "# Mine\n");
	fs.chmodSync(file, 0o000);
	if (process.getuid?.() !== 0 && process.platform !== "win32") {
		const loaded = await hostPolicyLoader(async () => unreadable).load();
		assert.equal(loaded.source, "shipped");
		assert.match(loaded.diagnostic ?? "", /could not be read \(EACCES\)/);
	}

	// An agent directory that cannot be resolved leaves the override's place unknown: shipped, said once.
	const unresolved = await hostPolicyLoader(async () => {
		throw new Error("no Pi here");
	}).load();
	assert.equal(unresolved.source, "shipped");
	assert.match(unresolved.diagnostic ?? "", /could not be located \(no Pi here\)/);
});

test("the size limit is in bytes: exactly 64 KiB is a policy, one byte past it is not, whatever characters make it up", async () => {
	const exact = "a".repeat(HOST_POLICY_MAX_BYTES);
	assert.equal((await memoryHostPolicyLoader({ override: exact }).load()).source, "override");
	// 21845 three-byte characters are 65535 bytes; one more ASCII byte is the limit, and a two-byte one is past it.
	const wide = "€".repeat(21845);
	assert.equal((await memoryHostPolicyLoader({ override: `${wide}a` }).load()).source, "override");
	assert.match((await memoryHostPolicyLoader({ override: `${wide}é` }).load()).diagnostic ?? "", /larger than/);
	assert.match((await memoryHostPolicyLoader({ override: `${exact}a` }).load()).diagnostic ?? "", /larger than/);
});

test("an override is read as it is: no frontmatter, include or template is interpreted", async () => {
	const text = "---\ntitle: x\n---\n{{ include shipped }}\n@contracts/host.md\n";
	assert.equal((await memoryHostPolicyLoader({ override: text }).load()).text, text);
});

test("the production loader reads host.md under the agent directory it is given, and asks for it only when it loads", async (t) => {
	const dir = agentDir(t);
	const custom = path.join(dir, "elsewhere", "agent");
	const file = writeOverride(custom, "custom\n");
	let asked = 0;
	const loader = hostPolicyLoader(async () => {
		asked++;
		return custom;
	});
	assert.equal(asked, 0, "constructing the loader resolves nothing");
	assert.deepEqual(await loader.load(), { text: "custom\n", source: "override", path: file });
	assert.equal(asked, 1);
	// Each load reads afresh: a removed override is the shipped policy again.
	fs.rmSync(file);
	assert.equal((await loader.load()).source, "shipped");
	assert.equal(asked, 2);
});

test("a broken shipped policy fails the load, and a valid override does not hide it", async (t) => {
	const dir = agentDir(t);
	const override = writeOverride(dir, "a valid override\n");
	const broken: [string, string | Uint8Array | undefined, RegExp][] = [
		["missing", undefined, /is missing/],
		["empty", "", /is empty/],
		["blank", "\n\n", /is blank/],
		["malformed", Uint8Array.from([0xff, 0xfe, 0x00]), /is not valid UTF-8/],
		["oversize", "a".repeat(HOST_POLICY_MAX_BYTES + 1), /is larger than/],
	];
	for (const [what, content, why] of broken) {
		const file = path.join(dir, `shipped-${what}.md`);
		if (content !== undefined) fs.writeFileSync(file, content);
		const loader = fileHostPolicyLoader({ shipped: file, override: () => override });
		await assert.rejects(loader.load(), (error: Error) => why.test(error.message) && error.message.startsWith(`pi-fusion: the shipped host policy ${file} `), what);
		// The shipped policy is checked before the override's place is asked for, so a resolver that would hang or
		// do something is never reached: one called here would leave this load pending and fail the case.
		let resolved = 0;
		const hanging = fileHostPolicyLoader({ shipped: file, override: () => {
			resolved++;
			return new Promise<string>(() => {});
		} });
		await assert.rejects(hanging.load(), why, `${what} before the override`);
		assert.equal(resolved, 0, `${what}: the override resolver was not called`);
		if (content !== undefined) await assert.rejects(memoryHostPolicyLoader({ shipped: content, override: "valid" }).load(), why, `${what} in memory`);
	}
	const directory = path.join(dir, "shipped-dir");
	fs.mkdirSync(directory);
	await assert.rejects(fileHostPolicyLoader({ shipped: directory, override: () => override }).load(), /is not a regular file/);
	// A shipped policy that is fine, with the same override, selects the override.
	const fine = path.join(dir, "shipped-fine.md");
	fs.writeFileSync(fine, "shipped\n");
	assert.equal((await fileHostPolicyLoader({ shipped: fine, override: () => override }).load()).source, "override");
});

test("the host policy module imports no Pi SDK and resolves the agent directory only through the seam it is given", () => {
	const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "extensions", "host-policy.ts"), "utf8");
	const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
	assert.deepEqual(imports, ["node:fs", "node:path", "node:url", "./backends/pi-storage.ts", "./profile-store.ts"]);
	assert.doesNotMatch(source, /import\(/, "no dynamic import either");
});

/** The descriptors this process has open, where the platform lists them; undefined elsewhere. */
const openDescriptors = (): number | undefined => (fs.existsSync("/proc/self/fd") ? fs.readdirSync("/proc/self/fd").length : undefined);

test("an override is typed from its opened descriptor, so a FIFO is refused without blocking, whatever a path check would say", async (t) => {
	if (process.platform === "win32") return t.skip("no FIFO a path open would block on");
	const dir = agentDir(t);
	const file = path.join(dir, "pi-fusion", HOST_POLICY_FILE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (spawnSync("mkfifo", [file]).status !== 0) return t.skip("mkfifo is not available");
	// A path check that called this FIFO a regular file, as one would that ran before a swap, decides nothing: the
	// loader asks the descriptor it opened. With no writer a blocking open of the FIFO would never return, and would
	// leave a thread-pool job no timeout can cancel, so the guard below refuses any open of it that is not read-only and
	// nonblocking instead of passing it on: a regression fails here, at once, rather than hanging the file.
	const promises = fs.promises as { stat: unknown; open: (target: unknown, flags?: unknown, mode?: unknown) => Promise<unknown> };
	const { stat, open } = promises;
	const { O_NONBLOCK, O_WRONLY, O_RDWR } = fs.constants;
	const opens: unknown[] = [];
	const blocking: unknown[] = [];
	promises.stat = async () => ({ isFile: () => true });
	promises.open = async (target, flags, mode) => {
		if (path.resolve(String(target)) !== file) return open(target, flags, mode);
		opens.push(flags);
		if (typeof flags !== "number" || (flags & O_NONBLOCK) === 0 || (flags & (O_WRONLY | O_RDWR)) !== 0) {
			blocking.push(flags);
			throw Object.assign(new Error("the guard refused a blocking open of the FIFO"), { code: "EGUARD" });
		}
		return open(target, flags, mode);
	};
	let loaded: Awaited<ReturnType<ReturnType<typeof hostPolicyLoader>["load"]>>;
	try {
		loaded = await hostPolicyLoader(async () => dir).load();
	} finally {
		promises.stat = stat;
		promises.open = open;
	}
	assert.deepEqual(blocking, [], "the FIFO was opened without O_NONBLOCK, or for writing: a blocking open would have hung here");
	assert.equal(opens.length, 1, "the FIFO was opened once, through fs.promises.open, so the guard saw it");
	// The refusal is the descriptor's own type check, not some other fallback such as an empty read of the FIFO.
	assert.equal(loaded.source, "shipped");
	assert.equal(loaded.text, shipped);
	assert.equal(loaded.diagnostic, `the host policy override ${file} is not a regular file; using the shipped host policy instead`);
});

test("every descriptor a load opens is closed, whether the override is read, refused for its type or refused for its size", async (t) => {
	const before = openDescriptors();
	if (before === undefined) return t.skip("this platform does not list open descriptors");
	const directory = agentDir(t);
	fs.mkdirSync(path.join(directory, "pi-fusion", HOST_POLICY_FILE), { recursive: true });
	const oversize = agentDir(t);
	writeOverride(oversize, "a".repeat(HOST_POLICY_MAX_BYTES + 1));
	const valid = agentDir(t);
	writeOverride(valid, "mine\n");
	for (let round = 0; round < 5; round++) {
		for (const dir of [directory, oversize, valid]) await hostPolicyLoader(async () => dir).load();
	}
	assert.equal(openDescriptors(), before);
});

test("the shipped policy asks for an independent child review after each implementation step, and keeps the kinds of review apart", () => {
	const text = shipped.replace(/\s+/g, " ");
	assert.match(text, /After each implementation step, get a fresh independent child review of that change when an enabled reviewer is available, and address its findings before the next step or any commit\./);
	assert.match(text, /An independent review of the same change that was already started, such as an automatic one, satisfies this once it has completed\./);
	assert.match(text, /A reviewer is available only when it is enabled and its configuration and admission let the review start; enabled alone is not enough\./);
	assert.match(text, /When no independent child review is available, review the change yourself and tell the user that no independent child review ran, and why\./);
	assert.match(text, /Reading a child's report or diff yourself is host review\. A child reviewing its own work, as ultracode's agents do, is self-review\. An independent review is a fresh child run that did not write the change and inherits nothing from it\./);
	assert.match(text, /never present a host review or a self-review as independent/);
	// An explicit workflow is still never substituted silently, review included.
	assert.match(text, /Never substitute silently\. When the user names a backend, model, role or workflow, use it, or say why you cannot and ask before using anything else\./);
});
