import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ChildTree,
	type CleanupReport,
	descendantsFrom,
	type ExitOutcome,
	isDeadState,
	type LaunchedProcess,
	type ObservedProcess,
	type OwnedCleanup,
	parseUnixProcessTable,
	parseWindowsProcessTable,
	type ProcessFacilities,
	productionFacilities,
	readProcessTable,
	type SignalHandle,
} from "../extensions/process-tree.ts";

/*
 * The opt-in cleanup, driven against real processes. The fixture tree is plain node and knows nothing about Pi or
 * Claude, and its pid files are the test's own oracle and emergency cleanup: no pid ever goes from a marker file into
 * the code under test, so every kill here is one production discovery found for itself. Fault cases wrap the real
 * facilities and drop or bend one narrow thing; the positive cases run on the production ones unchanged.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "test", "tree-fixture.mjs");

interface Topology {
	role: string;
	mode: "same-group" | "detached" | "inherit";
	env?: { [key: string]: string };
	spawn?: Topology[];
}

const run = (args: string[], env: { [key: string]: string }): Promise<{ code: number | null; stdout: string; stderr: string }> =>
	new Promise((resolve) => {
		const proc = execFile(process.execPath, args, { env: { ...process.env, ...env }, encoding: "utf8" }, (_error, stdout, stderr) => {
			resolve({ code: proc.exitCode, stdout, stderr });
		});
	});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits on a condition, bounded: a readiness poll, never a sleep long enough to make a race look settled. */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (await ok()) return;
		if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
		await delay(20);
	}
}

const newDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pi-fusion-tree-"));
const pidOf = (dir: string, role: string): number => Number(fs.readFileSync(path.join(dir, `${role}.pid`), "utf8"));
const ready = (dir: string, roles: string[]): Promise<void> =>
	until(`${roles.join(", ")} to be ready`, () => roles.every((role) => fs.existsSync(path.join(dir, `${role}.ready`))));

/** The platform's own answer about one pid, so a zombie counts as dead and an unreaped child is not called alive. */
async function livePids(): Promise<Set<number>> {
	const table = await readProcessTable(5_000);
	assert.ok(table, "the process table must be readable for this assertion");
	return new Set(table.filter((row) => !isDeadState(row.state)).map((row) => row.pid));
}

const gone = async (pid: number): Promise<boolean> => !(await livePids()).has(pid);

/** Kills whatever the fixture wrote a pid for. The test's own last resort, and the only place a marker pid is used. */
function reap(dir: string): void {
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".pid")) continue;
		try {
			process.kill(Number(fs.readFileSync(path.join(dir, file), "utf8")), "SIGKILL");
		} catch {}
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

const grace = (over: Partial<OwnedCleanup> = {}): OwnedCleanup => ({
	exitGraceMs: 600,
	stopGraceMs: 1_500,
	leftoverGraceMs: 400,
	pipeGraceMs: 400,
	tableTimeoutMs: 2_000,
	deadlineMs: 20_000,
	...over,
});

function startRoot(tree: ChildTree, dir: string, opts: { env?: { [key: string]: string }; spawn?: Topology[] } = {}): LaunchedProcess {
	return tree.spawn({
		command: process.execPath,
		args: [fixture],
		env: { ...process.env, FIXTURE_DIR: dir, FIXTURE_ROLE: "root", FIXTURE_SPAWN: JSON.stringify(opts.spawn ?? []), ...opts.env },
	});
}

interface Recorded {
	sends: { target: number; signal: NodeJS.Signals; step: number }[];
	events: string[];
	facilities: ProcessFacilities;
}

/**
 * The production facilities with a notebook around them: every send is recorded and then forwarded unless the test
 * drops that one, and the table is the real one unless the test bends it. What is not faulted stays production.
 */
function recorder(opts: { drop?: (target: number, signal: NodeJS.Signals) => boolean; table?: (real: ProcessFacilities) => Promise<ObservedProcess[] | undefined> } = {}): Recorded {
	const real = productionFacilities();
	const recorded: Recorded = {
		sends: [],
		events: [],
		facilities: {
			table: async () => {
				const rows = opts.table ? await opts.table(real) : await real.table();
				recorded.events.push(rows ? "table" : "table-unavailable");
				return rows;
			},
			signal: (target, signal) => {
				recorded.sends.push({ target, signal, step: recorded.events.length });
				recorded.events.push(`signal ${target} ${signal}`);
				if (opts.drop?.(target, signal)) return;
				real.signal(target, signal);
			},
		},
	};
	return recorded;
}

const pids = (found: ObservedProcess[]): number[] => found.map((row) => row.pid);

const tableAvailable = (await readProcessTable(10_000)) !== undefined;
/** A test that drives real processes needs the platform's table; nothing here guesses when it cannot have it. */
const needsTable = tableAvailable ? false : "the platform's process table is unavailable here, so production discovery cannot be exercised";
/** Ignoring a signal is a POSIX disposition: on Windows a terminate request is not something a process can refuse. */
const posixOnly = process.platform === "win32" ? "signal dispositions are POSIX, so a Windows process cannot ignore SIGTERM" : needsTable;
const groupsOnly = process.platform === "win32" ? "Windows has no process groups to signal" : needsTable;

test("an owned tree's descendants are found and cleaned up before the root's own normal exit", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(400, grace());
		startRoot(tree, dir, {
			spawn: [{ role: "middle", mode: "same-group", spawn: [{ role: "grandchild", mode: "detached" }] }],
		});
		await ready(dir, ["root", "middle", "grandchild"]);
		const middle = pidOf(dir, "middle");
		const grandchild = pidOf(dir, "grandchild");
		const report = await tree.shutdown();
		// The root closes its own input and exits 0; nothing signalled it, and its descendants are gone all the same.
		assert.deepEqual([report.root, report.exit.code, report.exit.signal], ["exited", 0, null]);
		assert.equal(tree.stoppedBy(report.exit), false);
		assert.equal(report.discovery, "ok");
		assert.equal(report.stdio, "closed");
		assert.equal(report.deadlineHit, false);
		/*
		 * Both are terminated, and that alone dates the discovery: a walk is only kept while the root is alive, so a
		 * descendant of a dead root — a re-parented grandchild above all — could never have been found at all.
		 */
		assert.deepEqual(pids(report.terminated).sort(), [middle, grandchild].sort());
		assert.deepEqual([report.leftovers, report.skipped], [[], []]);
		assert.equal(await gone(middle), true);
		assert.equal(await gone(grandchild), true);
	} finally {
		reap(dir);
	}
});

test("the descendant cleanup runs before the root exits, and does not signal the root to do it", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(400, grace());
		// This root exits 0 on the end of its input, but only once the child's own terminate handler has left a mark:
		// unless the cleanup signalled the child while the tree was still up, the root is still running at its grace.
		startRoot(tree, dir, {
			env: { FIXTURE_EOF_WAIT: "middle.term" },
			spawn: [{ role: "middle", mode: "same-group", env: { FIXTURE_TERM_MARK: "1" }, spawn: [{ role: "grandchild", mode: "detached" }] }],
		});
		await ready(dir, ["root", "middle", "grandchild"]);
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.code, report.exit.signal], ["exited", 0, null]);
		assert.equal(fs.existsSync(path.join(dir, "middle.term")), true, "the child was terminated before the root could exit");
		assert.deepEqual(pids(report.terminated).sort(), [pidOf(dir, "middle"), pidOf(dir, "grandchild")].sort());
	} finally {
		reap(dir);
	}
});

test("a root that ignores the end of its input is stopped with its descendants", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(600, grace({ exitGraceMs: 300 }));
		startRoot(tree, dir, {
			env: { FIXTURE_IGNORE_EOF: "1" },
			spawn: [{ role: "middle", mode: "same-group", spawn: [{ role: "grandchild", mode: "detached" }] }],
		});
		await ready(dir, ["root", "middle", "grandchild"]);
		const root = tree.pid!;
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.signal], ["stopped", "SIGTERM"]);
		assert.equal(tree.stoppedBy(report.exit), true, "the root died of a signal this shutdown sent");
		assert.deepEqual(pids(report.terminated).sort(), [pidOf(dir, "middle"), pidOf(dir, "grandchild")].sort());
		assert.deepEqual(report.leftovers, []);
		assert.equal(await gone(root), true);
	} finally {
		reap(dir);
	}
});

test("a root and a descendant that ignore SIGTERM are escalated to SIGKILL", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(400, grace({ exitGraceMs: 250, stopGraceMs: 2_000 }));
		startRoot(tree, dir, {
			env: { FIXTURE_IGNORE_EOF: "1", FIXTURE_IGNORE_TERM: "1" },
			spawn: [{ role: "middle", mode: "detached", env: { FIXTURE_IGNORE_TERM: "1" } }],
		});
		await ready(dir, ["root", "middle"]);
		const middle = pidOf(dir, "middle");
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.signal], ["stopped", "SIGKILL"]);
		assert.equal(tree.stoppedBy(report.exit), true);
		assert.deepEqual(pids(report.terminated), [middle], "a descendant that refused SIGTERM was forced after its grace");
		assert.equal(await gone(middle), true);
	} finally {
		reap(dir);
	}
});

test("a root nothing can stop is reported unstoppable, and its descendants are cleaned up anyway", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const root = { pid: 0 };
		// The fault: the root's own force never reaches it. On Windows nothing can be refused, so no root send does.
		const seam = recorder({
			drop: (target, signal) => (process.platform === "win32" ? Math.abs(target) === root.pid : signal === "SIGKILL" && Math.abs(target) === root.pid),
		});
		const tree = new ChildTree(300, grace({ exitGraceMs: 250, stopGraceMs: 500, deadlineMs: 6_000, facilities: seam.facilities }));
		const env: { [key: string]: string } = { FIXTURE_IGNORE_EOF: "1" };
		if (process.platform !== "win32") env.FIXTURE_IGNORE_TERM = "1";
		startRoot(tree, dir, { env, spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		root.pid = tree.pid!;
		const middle = pidOf(dir, "middle");
		const started = Date.now();
		const report = await tree.shutdown();
		assert.equal(report.root, "unstoppable", "a root this could not stop is an error, not a clean success");
		assert.deepEqual(report.exit, { code: null, signal: null });
		assert.ok(Date.now() - started < 12_000, `the cleanup stayed bounded, took ${Date.now() - started} ms`);
		assert.deepEqual(pids(report.terminated), [middle]);
		assert.equal(await gone(middle), true);
		assert.equal(await gone(root.pid), false, "the fault held: the root is still there for this test to clean up");
	} finally {
		reap(dir);
	}
});

test("without a process table only the root's own pid is signalled, and no group at all", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const seam = recorder({ table: async () => undefined });
		const tree = new ChildTree(400, grace({ exitGraceMs: 250, facilities: seam.facilities }));
		startRoot(tree, dir, {
			env: { FIXTURE_IGNORE_EOF: "1" },
			spawn: [{ role: "middle", mode: "detached", spawn: [{ role: "grandchild", mode: "detached" }] }],
		});
		await ready(dir, ["root", "middle", "grandchild"]);
		const root = tree.pid!;
		const report = await tree.shutdown();
		assert.equal(report.discovery, "unavailable");
		assert.equal(report.root, "stopped");
		assert.deepEqual(
			[...new Set(seam.sends.map((send) => send.target))],
			[root],
			"with no table there is no ownership to prove, so nothing but the root may be signalled",
		);
		assert.deepEqual([report.terminated, report.leftovers, report.skipped], [[], [], []], "nothing was discovered, so nothing is claimed");
		// The undiscovered descendants outlive the run: a documented limitation, and this test's own cleanup.
		assert.equal(await gone(pidOf(dir, "grandchild")), false);
	} finally {
		reap(dir);
	}
});

test("a descendant whose birth stamp changed after it was observed is skipped and never signalled again", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		let reused = 0;
		// The one narrow fault: the real table, with the observed descendant's birth stamp changed under it, which is
		// what this host would see had that pid been reused. Everything else, discovery and sends alike, is production.
		const seam = recorder({
			table: async (real) => {
				const rows = await real.table();
				return rows?.map((row) => (row.pid === reused ? { ...row, started: `${row.started} (reused)` } : row));
			},
		});
		const tree = new ChildTree(400, grace({ exitGraceMs: 250, facilities: seam.facilities }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1" }, spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const middle = pidOf(dir, "middle");
		const observed = await tree.observe();
		assert.deepEqual(pids(observed), [middle], "the real discovery found it first, at its real identity");
		reused = middle;
		const report = await tree.shutdown();
		assert.equal(report.root, "stopped");
		assert.deepEqual(pids(report.skipped), [middle], "an identity this can no longer prove is skipped, not signalled");
		assert.deepEqual(report.terminated, []);
		assert.equal(
			seam.sends.some((send) => Math.abs(send.target) === middle),
			false,
			"neither the pid nor its group was signalled once the identity stopped matching",
		);
		assert.equal(await gone(middle), false, "the skipped process is untouched, and this test kills it");
	} finally {
		reap(dir);
	}
});

test("a grandchild re-parented when its own parent dies is still cleaned up while its identity holds", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(400, grace({ exitGraceMs: 250 }));
		startRoot(tree, dir, {
			env: { FIXTURE_IGNORE_EOF: "1" },
			spawn: [{ role: "middle", mode: "same-group", spawn: [{ role: "grandchild", mode: "detached" }] }],
		});
		await ready(dir, ["root", "middle", "grandchild"]);
		const middle = pidOf(dir, "middle");
		const grandchild = pidOf(dir, "grandchild");
		assert.deepEqual((await tree.observe()).map((row) => row.pid).sort(), [middle, grandchild].sort());
		// The middle goes on its own, which re-parents the grandchild: a walk from the root will not find it again.
		process.kill(middle, "SIGKILL");
		await until("the middle process to be gone", () => gone(middle));
		const report = await tree.shutdown();
		assert.equal(report.root, "stopped");
		assert.deepEqual(pids(report.terminated), [grandchild], "the observation is what makes the re-parented grandchild provable");
		assert.equal(await gone(grandchild), true);
	} finally {
		reap(dir);
	}
});

test("a descendant holding the child's pipes leaves a dead root exited, the stdio held and a leftover reported", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const root = { pid: 0 };
		// The fault: nothing but the root may be signalled, so the pipe holder stays and the close never comes.
		const seam = recorder({ drop: (target) => target !== root.pid });
		const tree = new ChildTree(400, grace({ pipeGraceMs: 300, deadlineMs: 8_000, facilities: seam.facilities }));
		startRoot(tree, dir, { spawn: [{ role: "holder", mode: "inherit" }] });
		await ready(dir, ["root", "holder"]);
		root.pid = tree.pid!;
		const holder = pidOf(dir, "holder");
		const started = Date.now();
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.code, report.exit.signal], ["exited", 0, null], "the root ended by itself; only its pipes outlived it");
		assert.equal(report.stdio, "held");
		assert.deepEqual(pids(report.leftovers), [holder], "an observed leftover is reported, and it was verified alive");
		assert.ok(Date.now() - started < 8_000, `the cleanup stayed bounded, took ${Date.now() - started} ms`);
		assert.equal(await gone(holder), false);
	} finally {
		reap(dir);
	}
});

test("a process table that never answers cannot hold the cleanup up, and its late answer signals nothing", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const hung = recorder({ table: () => new Promise<undefined>(() => {}) });
		const tree = new ChildTree(300, grace({ exitGraceMs: 1_500, tableTimeoutMs: 200, pipeGraceMs: 300, deadlineMs: 4_000, facilities: hung.facilities }));
		startRoot(tree, dir, { spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const started = Date.now();
		const report = await tree.shutdown();
		const took = Date.now() - started;
		assert.ok(took < 4_000 + 2_000, `a reader that never answers still returns within the deadline, took ${took} ms`);
		assert.equal(report.discovery, "unavailable");
		// The root had its whole exit grace and used it: what it did is what is reported, not what would be tidy.
		assert.deepEqual([report.root, report.exit.code, report.exit.signal], ["exited", 0, null]);
		assert.deepEqual(hung.sends, [], "nothing was ever proved, so nothing was ever signalled");
		await delay(600);
		assert.deepEqual(hung.sends, [], "no send arrived after the report");
	} finally {
		reap(dir);
	}
});

test("a process table that answers after its bound is dropped: nothing it names is signalled", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const late = recorder({
			table: async (real) => {
				await delay(700);
				return real.table();
			},
		});
		const tree = new ChildTree(300, grace({ exitGraceMs: 1_500, tableTimeoutMs: 150, pipeGraceMs: 300, deadlineMs: 5_000, facilities: late.facilities }));
		startRoot(tree, dir, { spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const report = await tree.shutdown();
		assert.equal(report.discovery, "unavailable");
		assert.deepEqual([report.root, report.exit.code], ["exited", 0]);
		assert.deepEqual(late.sends, [], "rows that arrived after their bound are merged nowhere and signal nothing");
		await delay(1_500);
		assert.deepEqual(late.sends, [], "a reader still in flight at the report reaches nothing after it");
		assert.equal(await gone(pidOf(dir, "middle")), false, "undiscovered, so untouched: this test kills it");
	} finally {
		reap(dir);
	}
});

test("a zombie descendant is read as dead, not as a leftover, and an externally killed one is not claimed", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const seam = recorder();
		const tree = new ChildTree(400, grace({ exitGraceMs: 250, facilities: seam.facilities }));
		startRoot(tree, dir, {
			env: { FIXTURE_IGNORE_EOF: "1" },
			spawn: [{ role: "middle", mode: "same-group", env: { FIXTURE_ZOMBIE: "1" }, spawn: [{ role: "sibling", mode: "detached" }] }],
		});
		await ready(dir, ["root", "middle", "sibling"]);
		const zombie = pidOf(dir, "zombie");
		const sibling = pidOf(dir, "sibling");
		await until("the unreaped child to show up as a zombie", async () => {
			const table = await readProcessTable(5_000);
			return !!table?.some((row) => row.pid === zombie && isDeadState(row.state));
		});
		// Both are the run's own, and discovery has them: what follows is about a process this cleanup did not stop.
		assert.deepEqual(pids(await tree.observe()).sort(), [pidOf(dir, "middle"), sibling, zombie].sort());
		// The sibling is killed by something other than this cleanup, and the cleanup may not take the credit.
		process.kill(sibling, "SIGKILL");
		await until("the sibling to be gone", () => gone(sibling));
		const report = await tree.shutdown();
		assert.equal(
			seam.sends.some((send) => Math.abs(send.target) === sibling),
			false,
			"an observed descendant that was already gone took no signal from this cleanup",
		);
		assert.equal(
			seam.sends.some((send) => send.target === zombie),
			false,
			"the state column said dead, so no signal went to it",
		);
		assert.equal(pids(report.leftovers).includes(zombie), false, "a zombie is dead, and no leftover to warn about");
		assert.equal(pids(report.terminated).includes(zombie), false);
		for (const [list, name] of [
			[report.terminated, "terminated"],
			[report.leftovers, "leftovers"],
			[report.skipped, "skipped"],
		] as const) {
			assert.equal(pids(list).includes(sibling), false, `something else stopped it, so the report does not carry it in ${name}`);
		}
	} finally {
		reap(dir);
	}
});

test("observing and shutting down are the opt-in's own, and a tree without it is untouched", async () => {
	const plain = new ChildTree(200);
	await assert.rejects(() => plain.observe(), /observe needs an owned cleanup/);
	await assert.rejects(() => plain.shutdown(), /shutdown needs an owned cleanup/);
});

/*
 * The other opt-in, and it is the launch's rather than the cleanup's: who reads the child's stderr. The fixture writes
 * its line and waits for that write to land before it will read its own stdin, so these tests end stdin at once and
 * are driven by events from there on: a chunk, an exit, a pipe's end. Nothing below polls a marker file or sleeps.
 */
const STDERR_LINE = "a diagnostic line";

/** One event, awaited under a bound. A deadline that fails the test, never slack that lets a race pass for settled. */
async function settled<T>(what: string, work: Promise<T>, ms = 15_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Consumes a raw stderr pipe from the moment it is handed over, which is what a transport that owns one has to do:
 * every chunk is kept as it arrived, `line` settles on the first chunk that completes a line, and `finished` settles
 * on the pipe's own end or on its close, because a tree that destroys the stdio it holds gives a close with no end.
 */
function drainRaw(stream: Readable): { chunks: unknown[]; line: Promise<void>; finished: Promise<"end" | "close"> } {
	const chunks: unknown[] = [];
	let sawLine: (() => void) | undefined;
	const line = new Promise<void>((resolve) => {
		sawLine = resolve;
	});
	stream.on("data", (chunk: unknown) => {
		chunks.push(chunk);
		if (String(chunk).endsWith("\n")) sawLine?.();
	});
	const finished = new Promise<"end" | "close">((resolve, reject) => {
		stream.once("end", () => resolve("end"));
		stream.once("close", () => resolve("close"));
		stream.once("error", reject);
	});
	/*
	 * The pipe can fail before the test reaches its own await, and a rejection nobody has looked at yet takes the whole
	 * process down instead of failing an assertion. This marks it looked at and does nothing else: what is handed back
	 * is that same promise, so whoever awaits it still gets that exact error rather than an end or a close.
	 */
	finished.catch(() => {});
	return { chunks, line, finished };
}

/**
 * The owned tree's own shutdown as teardown, awaited. It is memoized, so this is the shutdown the body may already
 * have run rather than a second one, and on a body that threw before reaching it this is the one that does the work.
 * The directory goes only once the report establishes the tree is gone. A root the cleanup could not stop has no
 * further safe escalation from here — that report is final, its sends are fenced behind it, and this test knows no
 * pid it could prove — so the failure and the kept directory are reported instead of a kill being invented.
 */
async function endOwned(tree: ChildTree, dir: string): Promise<void> {
	// Past the cleanup's own deadline, so this bound only fires if that deadline did not hold.
	const report = await settled(`the owned cleanup to finish before ${dir} is removed`, tree.shutdown(), 25_000);
	if (report.root === "unstoppable" || report.leftovers.length || report.skipped.length) {
		assert.fail(
			`the cleanup established no end for this tree (root ${report.root}, ${report.leftovers.length} leftovers, ${report.skipped.length} skipped), so ${dir} is kept as it is`,
		);
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Legacy teardown, routed through the handle the test was given: the wait for the exit is registered before the kill,
 * so it cannot be missed, and the directory goes only once that exit has arrived. What this establishes is what the
 * legacy path has always established — node's own handle for the root it spawned — and no identity check of the kind
 * the opt-in cleanup does is added here.
 */
async function endLegacy(tree: ChildTree, child: LaunchedProcess, dir: string): Promise<void> {
	if (child.exitCode === null && !child.signalCode) {
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await settled(`the root to exit before ${dir} is removed`, exited);
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * The body and its teardown, with neither able to hide the other: a teardown that fails after a failing body is
 * reported beside it rather than in place of it, so the assertion that failed is still the one a reader sees first.
 */
async function withTeardown(body: () => Promise<void>, teardown: () => Promise<void>): Promise<void> {
	let failed = false;
	let failure: unknown;
	try {
		await body();
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		await teardown();
	} catch (error) {
		if (!failed) throw error;
		throw new AggregateError([failure, error], "the test failed, and its teardown could not finish either");
	}
	if (failed) throw failure;
}

test("the default and an explicit collect keep the stderr this module has always collected, and put none on the handle", async () => {
	for (const io of [undefined, { stderr: "collect" } as const]) {
		const dir = newDir();
		const tree = new ChildTree(400, undefined, io);
		const child = startRoot(tree, dir, { env: { FIXTURE_STDERR: STDERR_LINE } });
		await withTeardown(
			async () => {
				assert.equal("stderr" in child, false, "a collecting caller's handle carries no stderr key at all");
				const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
				child.stdin.end();
				await settled("the root to exit", exited);
				// Waited for past its exit, so the wait is the close it always was and not this test's own patience.
				const exit = await settled("the root's pipes to close", tree.exited());
				assert.deepEqual([exit.code, exit.signal], [0, null]);
				// That close is past the pipes, so every byte the child wrote has been decoded into the tree by now.
				assert.equal(tree.stderr, `${STDERR_LINE}\n`, "the pipe was decoded as utf8 into the tree, exactly as before");
			},
			() => endLegacy(tree, child, dir),
		);
	}
});

/* The stderr opt-in is the launch's and the cleanup opt-in is the shutdown's, so the streaming mode runs under both. */
const streamVariants: { what: string; cleanup?: OwnedCleanup }[] = [
	{ what: "a caller that took no cleanup with it", cleanup: undefined },
	{ what: "a caller that owns the cleanup too", cleanup: grace({ exitGraceMs: 2_000 }) },
];

for (const variant of streamVariants) {
	test(`the streaming mode hands ${variant.what} the child's raw stderr pipe, and the tree reads none of it itself`, async () => {
		const dir = newDir();
		const tree = new ChildTree(400, variant.cleanup, { stderr: "stream" });
		const child = startRoot(tree, dir, { env: { FIXTURE_STDERR: STDERR_LINE } });
		await withTeardown(async () => {
			const stderr = child.stderr;
			assert.ok(stderr, "the streaming caller's handle exposes the child's own pipe");
			assert.equal(stderr.readableEncoding, null, "nothing installed an encoding on it: the caller is handed bytes");
			const raw = drainRaw(stderr);
			// Consumed from the spawn, and the line landing is also what says the child is up: no marker is read for it.
			await settled("the child's stderr line", raw.line);
			let exit: ExitOutcome;
			if (variant.cleanup) {
				// The owned shutdown ends the child's stdin itself, and the root exits on it while its pipe is being read.
				const report = await tree.shutdown();
				assert.deepEqual([report.root, report.stdio], ["exited", "closed"], "the root ended by itself and its pipes closed with it");
				assert.deepEqual([report.leftovers, report.terminated], [[], []], "this run had no descendants to account for");
				exit = report.exit;
			} else {
				const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
				child.stdin.end();
				await settled("the root to exit", exited);
				exit = await settled("the root's pipes to close", tree.exited());
			}
			assert.deepEqual([exit.code, exit.signal], [0, null]);
			assert.equal(await settled("the pipe to finish", raw.finished), "end", "a pipe read to the end ends, rather than being destroyed under its reader");
			assert.ok(raw.chunks.length > 0, "the caller got the child's line, and nothing consumed it before it");
			assert.ok(
				raw.chunks.every((chunk) => Buffer.isBuffer(chunk)),
				"every chunk is raw bytes, never a string this tree decoded",
			);
			assert.equal(Buffer.concat(raw.chunks as Buffer[]).toString("utf8"), `${STDERR_LINE}\n`);
			assert.equal(tree.stderr, "", "the tree collected nothing: framing and bounding those bytes are the caller's own");
			// The cleanup opt-in decides the teardown too: the owned tree ends through its own shutdown, and the plain
			// one through the handle, which is the same routing each of them uses while the test is running.
		}, () => (variant.cleanup ? endOwned(tree, dir) : endLegacy(tree, child, dir)));
	});
}

test("the opt-in dispatches the tree's own signal, its escalation and its wait", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(400, grace({ exitGraceMs: 250 }));
		const child = startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1" }, spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const middle = pidOf(dir, "middle");
		// The handle a transport holds: one terminate, proved first and sent asynchronously, ends the whole tree.
		assert.equal(child.kill("SIGTERM"), true);
		await until("the root and its descendant to be gone", async () => (await gone(tree.pid!)) && (await gone(middle)));
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.signal], ["stopped", "SIGTERM"]);
		assert.equal(tree.stoppedBy(report.exit), true);
		assert.deepEqual(pids(report.terminated), [middle]);
	} finally {
		reap(dir);
	}
});

test("an opted-in kill escalates on its own timer, and the wait for the exit reports the shutdown's outcome", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(300, grace({ exitGraceMs: 200, stopGraceMs: 2_000 }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1", FIXTURE_IGNORE_TERM: "1" } });
		await ready(dir, ["root"]);
		tree.kill();
		const exit = await tree.exited();
		assert.equal(exit.signal, "SIGKILL", "the terminate was refused, so the escalation ended it");
		assert.equal(tree.stoppedBy(exit), true);
		const report = await tree.shutdown();
		assert.deepEqual(report.exit, exit, "the wait and the report are the one shutdown");
		assert.equal(report.root, "stopped");
	} finally {
		reap(dir);
	}
});

test("a table that answers once and then fails buys no blind group send afterwards", { skip: groupsOnly }, async () => {
	const dir = newDir();
	try {
		let reads = 0;
		const seam = recorder({
			table: async (real) => {
				reads += 1;
				return reads === 1 ? real.table() : undefined;
			},
		});
		const tree = new ChildTree(400, grace({ exitGraceMs: 250, facilities: seam.facilities }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1" }, spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const root = tree.pid!;
		const middle = pidOf(dir, "middle");
		const report = await tree.shutdown();
		assert.equal(report.discovery, "unavailable");
		assert.equal(report.root, "stopped");
		const groups = seam.sends.filter((send) => send.target < 0).map((send) => send.target);
		assert.deepEqual([...new Set(groups)], [-middle], "the one group send is the anchored one from the read that worked");
		assert.ok(
			seam.sends.some((send) => send.target === root),
			"the root is still signalled through its own pid",
		);
		assert.equal(
			seam.sends.some((send) => send.target === -root),
			false,
			"the root's group needs an anchor from a table this no longer has",
		);
		assert.equal(await gone(middle), true);
	} finally {
		reap(dir);
	}
});

/*
 * The cleanup is something a caller awaits, and after a normal root exit the awaited grace can be the only thing this
 * process still has to do. A node process with nothing referenced left exits, so this runs the whole thing in a plain
 * node process with no test runner and no host around it: if the shutdown's own waits did not hold the loop open, the
 * report would never be written. The fixture keepalive belongs to the child tree, never to the caller under test.
 */
test("a standalone caller's awaited shutdown finishes after the root exits, with only its own grace left running", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const script = [
			'const { ChildTree } = await import(process.env.TREE_MODULE);',
			'const fs = await import("node:fs");',
			'const path = await import("node:path");',
			'const dir = process.env.FIXTURE_DIR;',
			'const tree = new ChildTree(700, { exitGraceMs: 800, stopGraceMs: 800, leftoverGraceMs: 400, pipeGraceMs: 400, tableTimeoutMs: 2000, deadlineMs: 15000 });',
			'tree.spawn({',
			'\tcommand: process.execPath,',
			'\targs: [process.env.FIXTURE_SCRIPT],',
			'\tenv: { ...process.env, FIXTURE_ROLE: "root", FIXTURE_SPAWN: JSON.stringify([{ role: "middle", mode: "detached", env: { FIXTURE_IGNORE_TERM: "1" } }]) },',
			'});',
			'const ready = (role) => fs.existsSync(path.join(dir, role + ".ready"));',
			'while (!(ready("root") && ready("middle"))) await new Promise((resolve) => setTimeout(resolve, 20));',
			'const report = await tree.shutdown();',
			'process.stdout.write(JSON.stringify(report));',
		].join("\n");
		const standalone = await run(["--input-type=module", "-e", script], {
			TREE_MODULE: pathToFileURL(path.join(repoRoot, "extensions", "process-tree.ts")).href,
			FIXTURE_SCRIPT: fixture,
			FIXTURE_DIR: dir,
		});
		assert.equal(standalone.code, 0, `the standalone caller failed: ${standalone.stderr}`);
		assert.ok(standalone.stdout, `the awaited shutdown never resolved, so nothing was reported: ${standalone.stderr}`);
		const report = JSON.parse(standalone.stdout) as CleanupReport;
		assert.deepEqual([report.root, report.exit.code, report.exit.signal], ["exited", 0, null]);
		// The descendant refused the terminate, so the report was only reachable through a grace this process awaited.
		assert.deepEqual(pids(report.terminated), [pidOf(dir, "middle")]);
		assert.equal(report.deadlineHit, false);
		assert.equal(await gone(pidOf(dir, "middle")), true);
	} finally {
		reap(dir);
	}
});

test("the root's own group is no target once its row is gone, and a remembered descendant still is", { skip: groupsOnly }, async () => {
	const dir = newDir();
	try {
		const seam = recorder();
		const tree = new ChildTree(500, grace({ facilities: seam.facilities }));
		const child = startRoot(tree, dir, { spawn: [{ role: "middle", mode: "same-group", env: { FIXTURE_IGNORE_TERM: "1" } }] });
		await ready(dir, ["root", "middle"]);
		const root = tree.pid!;
		const middle = pidOf(dir, "middle");
		assert.deepEqual(pids(await tree.observe()), [middle]);
		// The root goes first and its row with it, which leaves its group number belonging to nothing in particular.
		child.stdin.end();
		await until("the root to exit on its own", () => gone(root));
		child.kill("SIGTERM");
		await until("the remembered descendant to be signalled", () => seam.sends.some((send) => send.target === middle));
		const report = await tree.shutdown();
		assert.equal(
			seam.sends.some((send) => send.target === -root),
			false,
			"the root's own group is never a descendant-only target, and after the root exits it is nobody's",
		);
		assert.deepEqual([report.root, report.exit.code], ["exited", 0]);
		assert.deepEqual(pids(report.terminated), [middle], "the descendant was reached per pid, and forced after its grace");
		assert.equal(await gone(middle), true);
	} finally {
		reap(dir);
	}
});

test("past the deadline nothing is discovered or signalled but the root's own guarded termination", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const seam = recorder();
		const tree = new ChildTree(400, grace({ deadlineMs: 5, facilities: seam.facilities }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1" }, spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const root = tree.pid!;
		const started = Date.now();
		const report = await tree.shutdown();
		assert.ok(Date.now() - started < 2_000, `a spent deadline returns at once, took ${Date.now() - started} ms`);
		assert.deepEqual([report.deadlineHit, report.discovery], [true, "unavailable"]);
		assert.deepEqual([...new Set(seam.sends.map((send) => send.target))], [root], "no group, no remembered pid: the root's own pid and nothing else");
		assert.ok(["stopped", "unstoppable"].includes(report.root), `the report says what it could see, and said ${report.root}`);
		assert.deepEqual([report.terminated, report.leftovers], [[], []], "nothing was discovered, so nothing is claimed either way");
	} finally {
		reap(dir);
	}
});

test("a root that ended on its own after its grace, with nothing of ours delivered, is exited and not stopped", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const real = productionFacilities();
		const sends: number[] = [];
		let reads = 0;
		const seam: ProcessFacilities = {
			table: async (budgetMs) => {
				reads += 1;
				const rows = await real.table(budgetMs);
				// The root is let out of its own wait exactly at the stopping phase's read: its exit lands there.
				if (reads === 2) fs.writeFileSync(path.join(dir, "go"), "1");
				return rows;
			},
			signal: (target, signal) => {
				sends.push(target);
				throw new Error(`the platform refused ${signal} for ${target}`);
			},
		};
		const tree = new ChildTree(3_000, grace({ exitGraceMs: 40, facilities: seam }));
		startRoot(tree, dir, { env: { FIXTURE_EOF_WAIT: "go" } });
		await ready(dir, ["root"]);
		const root = tree.pid!;
		const report = await tree.shutdown();
		assert.ok(sends.includes(root), "the stopping phase did try the root, and every send of it failed");
		assert.deepEqual([report.root, report.exit.code, report.exit.signal], ["exited", 0, null], "it ended by itself, late, and that is not this shutdown stopping it");
		assert.equal(tree.stoppedBy(report.exit), false);
	} finally {
		reap(dir);
	}
});

test("a phase given no grace of its own bounds itself, and is no deadline running out", { skip: posixOnly }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(0, grace({ exitGraceMs: 0, stopGraceMs: 0, leftoverGraceMs: 0, pipeGraceMs: 0, tableTimeoutMs: 2_000, deadlineMs: 20_000 }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1", FIXTURE_IGNORE_TERM: "1" }, spawn: [{ role: "middle", mode: "detached" }] });
		await ready(dir, ["root", "middle"]);
		const middle = pidOf(dir, "middle");
		const report = await tree.shutdown();
		assert.equal(report.deadlineHit, false, "every wait was as long as its caller asked for, and the deadline had 20 s left");
		assert.equal(report.discovery, "ok");
		assert.ok(["stopped", "unstoppable"].includes(report.root), `the report says what it saw, and said ${report.root}`);
		// Forced with no grace to go in, it is accounted for either way: gone already, or reported as still there.
		assert.equal(pids([...report.terminated, ...report.leftovers]).includes(middle), true);
		await until("the forced descendant to be gone", () => gone(middle));
	} finally {
		reap(dir);
	}
});

test("a kill grace already spent is no deadline running out either", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(0, grace({ deadlineMs: 20_000 }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1" } });
		await ready(dir, ["root"]);
		tree.kill();
		const report = await tree.shutdown();
		assert.equal(report.deadlineHit, false, "the kill's own grace was zero from the start, which the deadline knows nothing about");
		assert.equal(report.root, "stopped");
		assert.equal(tree.stoppedBy(report.exit), true);
	} finally {
		reap(dir);
	}
});

test("the production facilities send the root's own signal through its handle, and a refusal is no send", () => {
	const asked: NodeJS.Signals[] = [];
	let takes = true;
	const handle: SignalHandle = {
		// A pid no platform hands out, so nothing real is reachable even if this fell through to process.kill.
		pid: 1_000_000_000,
		exitCode: null,
		signalCode: null,
		kill: (signal) => {
			asked.push(signal);
			return takes;
		},
	};
	const facilities = productionFacilities(() => handle);
	facilities.signal(handle.pid!, "SIGTERM");
	assert.deepEqual(asked, ["SIGTERM"], "the root goes through the handle node is waiting on, not through a bare pid");
	takes = false;
	// A handle that says it delivered nothing has delivered nothing, and a cleanup counts no send for it.
	assert.throws(() => facilities.signal(handle.pid!, "SIGKILL"), /did not take SIGKILL/);
	assert.deepEqual(asked, ["SIGTERM", "SIGKILL"]);
	const orphan: SignalHandle = { pid: undefined, exitCode: null, signalCode: null, kill: () => assert.fail("a handle with no pid has nothing to signal") };
	assert.throws(() => productionFacilities(() => orphan).signal(1_000_000_000, "SIGTERM"), "a root that never started is not signalled through its handle either");
});

test("an error after the spawn is no exit, no spawn failure and no crash, however many arrive", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const tree = new ChildTree(500, grace({ exitGraceMs: 250 }));
		startRoot(tree, dir, { env: { FIXTURE_IGNORE_EOF: "1" } });
		await ready(dir, ["root"]);
		const root = tree.pid!;
		/*
		 * Node reports a signal the platform refused as an `error` on the child itself, and provoking a real EPERM
		 * would take privileges this test will not ask for. So the same event is raised on the same live handle,
		 * twice: the second is the one a listener that had already been consumed would have crashed the process on.
		 */
		const refused = () => Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
		const proc = (tree as unknown as { proc: NodeJS.EventEmitter }).proc;
		proc.emit("error", refused());
		proc.emit("error", refused());
		assert.equal(tree.spawnError, undefined, "a root that has a pid started, so nothing here is a spawn failure");
		assert.deepEqual(tree.refusedSignals, { count: 2, last: "kill EPERM" });
		assert.equal(await gone(root), false, "no exit was invented for it, and it is still running");
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.signal], ["stopped", "SIGTERM"], "the escalation went on and the root's own exit is what is reported");
		assert.equal(tree.spawnError, undefined);
		assert.equal(report.deadlineHit, false);
	} finally {
		reap(dir);
	}
});

test("a spawn that never happened is a spawn failure on either path", async () => {
	const missing = path.join(repoRoot, "test", "no-such-command-pi-fusion");
	const legacy = new ChildTree(200);
	legacy.spawn({ command: missing, args: [], env: process.env });
	assert.deepEqual(await legacy.exited(), { code: null, signal: null });
	assert.ok(legacy.spawnError, "the default path reports the failure it always did");
	const owned = new ChildTree(200, grace());
	const handle = owned.spawn({ command: missing, args: [], env: process.env });
	await new Promise<void>((resolve) => handle.once("error", () => resolve()));
	assert.ok(owned.spawnError, "a root with no pid never started, and the opt-in path says so too");
	const report = await owned.shutdown();
	assert.deepEqual([report.root, report.exit, report.discovery], ["unspawned", { code: null, signal: null }, "ok"]);
	assert.deepEqual(owned.refusedSignals, { count: 0 }, "a spawn failure is not a refused signal");
});

test("a table read is handed what its caller has left, and the production reader caps its own subprocess by it", { skip: needsTable }, async () => {
	const dir = newDir();
	try {
		const budgets: (number | undefined)[] = [];
		const real = productionFacilities();
		const seam: ProcessFacilities = {
			table: (budgetMs) => {
				budgets.push(budgetMs);
				return real.table(budgetMs);
			},
			signal: (target, signal) => real.signal(target, signal),
		};
		const tree = new ChildTree(0, grace({ tableTimeoutMs: 500, deadlineMs: 20_000, facilities: seam }));
		startRoot(tree, dir);
		await ready(dir, ["root"]);
		const report = await tree.shutdown();
		assert.deepEqual([report.root, report.exit.code], ["exited", 0]);
		assert.ok(budgets.length >= 2, `every read was handed a budget, and there were ${budgets.length} of them`);
		for (const budget of budgets) assert.ok(budget !== undefined && budget > 0 && budget <= 500, `a read was handed ${budget}, which is neither nothing nor more than the reader's own ceiling`);
		assert.ok(budgets[0]! > 400, `with 20 s of deadline left the ceiling is the reader's own, and it was handed ${budgets[0]}`);

		const short = new ChildTree(0, grace({ tableTimeoutMs: 5_000, deadlineMs: 250, facilities: seam }));
		budgets.length = 0;
		short.spawn({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"], env: process.env });
		const shortRoot = short.pid!;
		const stopped = await short.shutdown();
		assert.ok(budgets[0]! <= 250, `a deadline shorter than the ceiling is what a read gets, and it was handed ${budgets[0]}`);
		// Past its deadline the root's own termination still goes out, but there is no wait left to see it land: the
		// report says what it could see, and the exit this waits for afterwards is what proves the send did land.
		assert.ok(["stopped", "unstoppable"].includes(stopped.root), `the report said ${stopped.root}`);
		await until("the short-deadline root to be gone", () => gone(shortRoot));

		// The production reader takes the cap as its own subprocess's, so a read nobody waits for stops costing.
		const started = Date.now();
		assert.equal(await productionFacilities(undefined, 10_000).table(1), undefined);
		assert.equal(await readProcessTable(1), undefined);
		assert.ok(Date.now() - started < 3_000, `a capped read returns at its cap, and took ${Date.now() - started} ms`);
	} finally {
		reap(dir);
	}
});

test("the unix table reader keeps a pid's identity, its state and the rest of the line as its birth stamp", () => {
	const rows = parseUnixProcessTable(
		[
			"  PID  PPID  PGID STAT STARTED",
			"  101     1   101 Ss   Sat Sep 27 10:00:00 2026",
			"  102   101   101 S+   Sat Sep  6 09:59:59 2026",
			"  103   102   103 Z    Sat Sep 27 10:00:01 2026",
			"  104   101   104 R",
			"  bad   101   104 S    Sat Sep 27 10:00:02 2026",
			"   -5   101   104 S    Sat Sep 27 10:00:02 2026",
			"",
			"  105   101   105 Sl   Sat Sep 27 10:00:03 2026  ",
		].join("\r\n"),
	);
	assert.deepEqual(rows, [
		{ pid: 101, ppid: 1, pgid: 101, state: "Ss", started: "Sat Sep 27 10:00:00 2026" },
		{ pid: 102, ppid: 101, pgid: 101, state: "S+", started: "Sat Sep 6 09:59:59 2026" },
		{ pid: 103, ppid: 102, pgid: 103, state: "Z", started: "Sat Sep 27 10:00:01 2026" },
		{ pid: 105, ppid: 101, pgid: 105, state: "Sl", started: "Sat Sep 27 10:00:03 2026" },
	]);
	assert.equal(isDeadState("Z"), true);
	assert.equal(isDeadState("Z+"), true);
	assert.equal(isDeadState("Ss"), false);
});

test("the windows table reader takes the CIM columns, and leaves a row it cannot date without an identity", () => {
	const rows = parseWindowsProcessTable(
		[
			"#TYPE Selected.Microsoft.Management.Infrastructure.CimInstance",
			'"ProcessId","ParentProcessId","Created"',
			'"101","4","133712345670000000"',
			'"102","101","133712345680000000"',
			'"103","101",""',
			'"oops","101","133712345690000000"',
			'"104","","133712345700000000"',
			'"105","101","133712345710000000"',
			"",
		].join("\r\n"),
	);
	assert.deepEqual(rows, [
		{ pid: 101, ppid: 4, pgid: 0, state: "", started: "133712345670000000" },
		{ pid: 102, ppid: 101, pgid: 0, state: "", started: "133712345680000000" },
		{ pid: 103, ppid: 101, pgid: 0, state: "", started: "" },
		{ pid: 104, ppid: 0, pgid: 0, state: "", started: "133712345700000000" },
		{ pid: 105, ppid: 101, pgid: 0, state: "", started: "133712345710000000" },
	]);
	// A field with a comma in it, and a doubled quote, still read as one field.
	assert.deepEqual(parseWindowsProcessTable(['"ProcessId","ParentProcessId","Created","Name"', '"7","1","133712345670000000","a,b ""c"""'].join("\n")), [
		{ pid: 7, ppid: 1, pgid: 0, state: "", started: "133712345670000000" },
	]);
	assert.deepEqual(parseWindowsProcessTable('"Handle","Name"\n"7","node"'), [], "a table without the three columns names no process");
	assert.deepEqual(parseWindowsProcessTable(""), []);
});

test("a walk from a root needs its parent's row, and leaves out a child older than the parent it names", () => {
	const row = (pid: number, ppid: number, pgid: number, started: string): ObservedProcess => ({ pid, ppid, pgid, state: "S", started });
	const table = [
		row(100, 1, 100, "1000"),
		row(101, 100, 100, "2000"),
		row(102, 101, 102, "3000"),
		// A pid the platform reused: the row is older than the parent it names, so the edge is stale, not a descendant.
		row(103, 100, 103, "500"),
		// A parent nothing can see: the edge is unusable rather than assumed.
		row(104, 900, 104, "4000"),
		row(105, 105, 105, "5000"),
		row(1, 1, 1, "1"),
	];
	assert.deepEqual(pids(descendantsFrom(table, 100)), [101, 102]);
	assert.deepEqual(descendantsFrom(table, 900), [], "a root that is not in the table has no provable descendants");
	// A date `ps` writes as a string orders nothing, so the same shape with a stamp that is not a number keeps the row.
	const dated = [row(100, 1, 100, "Sat Sep 27 10:00:00 2026"), row(103, 100, 103, "Sat Sep 27 09:00:00 2026")];
	assert.deepEqual(pids(descendantsFrom(dated, 100)), [103]);
});
