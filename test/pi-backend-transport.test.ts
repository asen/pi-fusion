import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPiBackend, type PiCallReport } from "../extensions/backends/pi-backend.ts";
import { piRole } from "../extensions/backends/pi-binding.ts";
import { piPaths } from "../extensions/backends/pi-storage.ts";
import { type PiChild, type PiChildOptions, type PiExit, PiTransportError, startPiChild } from "../extensions/backends/pi-transport.ts";
import { type ChildEvent, failed } from "../extensions/backends/types.ts";

/*
 * One whole Pi call, composed the way production composes one and driven against a process at the end of it:
 * `createPiBackend` over the production storage, bootstrap input, launch, transport and process tree, with
 * `test/fake-pi.mjs` named as the bootstrap and its `backend-task` scenario answering on the native RPC protocol.
 *
 * What this is evidence about, and nothing else: this host's own composition, the order it drives a child in, the
 * canonical accounting it publishes, the single stop it takes and the retention decision it makes. It is no evidence
 * about Pi — nothing here builds a session, reaches a provider, runs a model, sends a paid request or loads an SDK —
 * and it is not a transport matrix: the transport's own protocol cases are `test/pi-transport.test.ts`'s, and one
 * scenario driven once is what this file is.
 *
 * The one thing wrapped around production is the start seam, and only so the child runs under this exact node with
 * `test/sdk-fence.mjs` preloaded: `piLaunch` says `node`, and a test may not depend on what that resolves to on a
 * search path. Everything the seam is handed otherwise travels through untouched, and the command the composition
 * handed in is asserted below to be that same `node`, so a launch that stopped being one fails this case rather than
 * being rewritten by it. What the seam is not evidence about is the default binding: the wrapper calls the real
 * `startPiChild` itself, so nothing here exercises the start production uses when no seam is passed. That
 * `extensions/fusion.ts` is the one production file that constructs this backend, and the import boundaries around
 * it, stay pinned by `test/pi-backend.test.ts`; that no case of the suite ever reaches a line of that registered
 * backend — `test/tripwire.ts` stands in its place in every host but two, and in those two the binding refuses the
 * pi call for having no model before that backend is asked for anything — stays pinned by `test/backends.test.ts`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The same module-resolution fence every other subprocess in this suite runs behind: a rule, not a sandbox. */
const FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");
const FAKE_PI = path.join(repoRoot, "test", "fake-pi.mjs");

/** The answer that one turn ends with, as the fake writes it: the run's text and the session's last assistant text. */
const FINAL_TEXT = "## Changed\nnothing, this was a fake";

/** Short enough that a case which hangs fails instead, and far longer than anything the fake actually takes. */
const TEST_BOUNDS = { startupMs: 20_000, ackMs: 20_000, requestMs: 10_000, shutdownStepMs: 1_500 };
const TEST_CLEANUP = { exitGraceMs: 1_500, stopGraceMs: 1_500, leftoverGraceMs: 300, pipeGraceMs: 800, tableTimeoutMs: 3_000 };
/** The grace this case's child is given before its tree escalates. Named so the arithmetic below can read it. */
const TEST_KILL_GRACE_MS = 2_000;

/**
 * Everything this case's own teardown is configured to be allowed to take, added together, so the failure deadline
 * below sits above it rather than at a number somebody liked the look of. It is arithmetic over the constants above
 * and not a duration anybody measured.
 */
const CLEANUP_BUDGET_MS = TEST_CLEANUP.exitGraceMs + TEST_CLEANUP.stopGraceMs + TEST_CLEANUP.leftoverGraceMs + TEST_CLEANUP.pipeGraceMs + TEST_CLEANUP.tableTimeoutMs + TEST_KILL_GRACE_MS;

/**
 * How long a call this case put under a deadline may take before the case fails: every bound the transport itself may
 * spend on one call — its startup, the prompt's acknowledgement and a request — plus the whole teardown budget above,
 * plus slack. Arithmetic over the constants above, so a case that fails this deadline outlived what it configured
 * rather than a number somebody liked, and no transport-owned bound can expire after it.
 */
const CASE_DEADLINE_MS = TEST_BOUNDS.startupMs + TEST_BOUNDS.ackMs + TEST_BOUNDS.requestMs + CLEANUP_BUDGET_MS + 10_000;

/**
 * One call under a failure deadline, which is what this is and all it is: it says whether the call came back at all,
 * and nothing about how long anything took. Nothing is cancelled when the deadline fires — the call goes on, and the
 * teardown still awaits whatever it started — so this claims no cancellation and performs none.
 */
async function within<T>(what: string, work: Promise<T>, ms = CASE_DEADLINE_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} had not come back inside this case's failure deadline of ${ms}ms`)), ms);
	});
	// The loser of the race is left to nobody, so its rejection is taken here rather than becoming an unhandled one.
	deadline.catch(() => {});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

test("one new-session call runs the whole composition against a child that speaks the protocol, and reports what that child did", async (t) => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-backend-"));
	const own = (name: string): string => {
		const at = path.join(root, name);
		fs.mkdirSync(at, { recursive: true });
		return at;
	};
	const cwd = own("cwd");
	const agentDir = own("agent");
	const logPath = path.join(own("log"), "fake-pi.jsonl");
	// Built up rather than copied down — nothing of the host's configuration, no provider key, no auth path and no PI
	// variable — so what the child gets is what this case gave it and the two fixture variables.
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: own("home"),
		TMPDIR: own("tmp"),
		XDG_CONFIG_HOME: own("xdg/config"),
		XDG_DATA_HOME: own("xdg/data"),
		XDG_CACHE_HOME: own("xdg/cache"),
		XDG_STATE_HOME: own("xdg/state"),
		FAKE_PI_SCENARIO: "backend-task",
		FAKE_PI_LOG: logPath,
	};
	if (process.platform === "win32") {
		for (const name of ["SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
			if (process.env[name] !== undefined) env[name] = process.env[name];
		}
		Object.assign(env, { APPDATA: own("appdata"), LOCALAPPDATA: own("localappdata"), USERPROFILE: env.HOME, TEMP: env.TMPDIR, TMP: env.TMPDIR });
	}

	/** Every start attempt, answered or not: what the teardown counts its reports against. */
	let attempts = 0;
	const children: PiChild[] = [];
	const exits: PiExit[] = [];
	const reports: PiCallReport[] = [];
	const events: ChildEvent[] = [];
	const counts = { progress: 0 };
	/** The exit the task's own stop reported, which the teardown's second stop has to be handed again. */
	let taskExit: PiExit | undefined;
	/** The command the composition itself put in the launch, kept before the seam replaces it and asserted in the body. */
	let composedCommand: string | undefined;

	/**
	 * Production's own start, with the launch's command and arguments rewritten and nothing else: this exact node, and
	 * the resolution fence in front of the bootstrap the composition named.
	 */
	const start = async (options: PiChildOptions): Promise<PiChild> => {
		attempts += 1;
		composedCommand = options.launch.command;
		const launch = { ...options.launch, command: process.execPath, args: ["--import", pathToFileURL(FENCE).href, ...options.launch.args] };
		try {
			const child = await startPiChild({ ...options, launch });
			children.push(child);
			return child;
		} catch (error) {
			// A refused startup carries the whole record of the child it finished; a refusal with none is a start nobody
			// reported on, and it stays unaccounted for rather than being read as a child that never ran.
			if (error instanceof PiTransportError && error.finalExit) exits.push(error.finalExit);
			throw error;
		}
	};

	/**
	 * Registered before the run, so a body that threw still leaves every child asked to finish. The order is fixed: the
	 * facts first, the removal only where those facts licence one, and the identity assertion last, so an assertion that
	 * fails cannot be what left a directory behind.
	 *
	 * `discovery` and `deadlineHit` are deliberately not required here, and that is this fixture's own topology rather
	 * than a general rule: this child is `test/fake-pi.mjs` under `test/sdk-fence.mjs`, which start nothing, so the root
	 * is the whole tree. Production's own disposition stays stricter and this case asserts that stricter answer in the
	 * body; nothing here relaxes it.
	 *
	 * The gate itself deliberately mirrors the one `test/pi-transport.test.ts` exercises, which stays the authoritative
	 * statement of when a child is over; this copy is fixture-local on purpose rather than a helper shared with it.
	 */
	t.after(async () => {
		const missing: string[] = [];
		for (const child of children) {
			try {
				// The transport memoizes its own shutdown, so this is the same stop and the same report the task already had.
				exits.push(await within(`the shutdown of the child with pid ${child.pid}`, child.shutdown()));
			} catch (error) {
				missing.push(`the shutdown of the child with pid ${child.pid} rejected instead of reporting how it ended: ${String(error)}`);
			}
		}
		if (attempts !== exits.length) missing.push(`${attempts} start attempts against ${exits.length} reports, so a start that left no report is unaccounted for`);
		for (const [at, exit] of exits.entries()) {
			const which = `report ${at + 1} of ${exits.length}`;
			const cleanup = exit.cleanup;
			if (!["unspawned", "exited", "stopped"].includes(cleanup.root)) missing.push(`${which}: its root is "${cleanup.root}" rather than one that says the root is over`);
			if (cleanup.stdio !== "closed") missing.push(`${which}: its pipes are "${cleanup.stdio}"`);
			if (exit.counters.streamsUnclosed !== 0) missing.push(`${which}: ${exit.counters.streamsUnclosed} of its streams had not closed`);
			if (cleanup.leftovers.length) missing.push(`${which}: ${cleanup.leftovers.length} verified leftovers`);
			if (cleanup.skipped.length) missing.push(`${which}: ${cleanup.skipped.length} targets whose identity it could not prove`);
		}
		if (missing.length) throw new Error(`the root ${root} was kept, because nothing proved this case's child was over: ${missing.join("; ")}`);
		fs.rmSync(root, { recursive: true, force: true });
		assert.equal(exits[0], taskExit, "the stop this teardown asked for is the one the task already took: one child, one shutdown, one report");
	});

	const backend = createPiBackend({
		agentDir: async () => agentDir,
		// The fake imports node builtins alone, so the preload this names redirects nothing it loads.
		sdkDir: async () => path.join(root, "host-pi"),
		readContract: (name) => `# ${name}\nDo the task.`,
		start,
		env,
		bootstrap: FAKE_PI,
		bounds: TEST_BOUNDS,
		cleanup: TEST_CLEANUP,
		onCall: (report) => reports.push(report),
	});

	const role = piRole({ role: "implement", model: "deepseek/deepseek-chat", effort: "high" }, undefined, {});
	const run = await within(
		"the pi call",
		backend.run({
			role,
			prompt: "Do the fake task.",
			cwd,
			session: backend.session({ kind: "new" }),
			signal: undefined,
			killGraceMs: TEST_KILL_GRACE_MS,
			onProgress: () => {
				counts.progress += 1;
			},
			onEvent: (event) => events.push(event),
		}),
	);

	assert.equal(failed(run), false);
	assert.equal(run.stopReason, "stop");
	assert.equal(run.text, FINAL_TEXT);

	// What the seam replaced, checked rather than assumed: the composition's own launch is the `node` this case stands in
	// for, so a build that launched something else would fail here instead of being quietly rewritten into node.
	assert.equal(composedCommand, "node", "the command production composed, before the seam pointed it at this node");

	// The identity a later call would stand on: the session the child opened, in the file the call's own session
	// directory names, at the leaf this turn left.
	assert.deepEqual(run.session, {
		backend: "pi",
		sessionId: "fake-pi-session-0001",
		sessionFile: path.join(piPaths(agentDir, cwd).sessionDir, "fake-pi-session-0001.jsonl"),
		checkpoint: "fake-entry-0002",
	});
	assert.equal(run.sessionId, "fake-pi-session-0001");
	assert.equal(run.checkpoint, undefined, "a pi continuation stands on the structured reference alone");
	assert.deepEqual(run.selection, { model: "deepseek/deepseek-chat", effort: "high" });
	assert.equal(run.modelId, "deepseek/deepseek-chat");

	// The canonical accounting: this turn's own delta against the preparation's baseline, and never the live counts the
	// stream left behind, which the fake makes large enough to tell the two apart.
	assert.deepEqual([run.tokensIn, run.tokensOut, run.cacheRead, run.cacheWrite], [315, 60, 10, 5]);
	assert.equal(run.costUsd, 0.5);
	assert.equal(run.numTurns, 1);
	assert.deepEqual([run.contextTokens, run.contextWindow], [1_200, 65_536]);
	assert.deepEqual([run.exitCode, run.signal], [0, null], "a child this host asked to stop, that stopped, exited because it was told to");

	// What a monitor saw, compared through json because a bounded tool input has a null prototype on purpose and a
	// strict deep comparison reads that as a mismatch rather than as the defence it is.
	assert.deepEqual(
		JSON.parse(JSON.stringify(events)),
		[
			{ type: "init", sessionId: "fake-pi-session-0001" },
			{ type: "tool_call", name: "bash", brief: "npm test", id: "call-1", input: { command: "npm test" } },
			{ type: "tool_result", toolUseId: "call-1", text: "2 passing", isError: false },
			{ type: "turn_result", ok: true },
		],
		"every event of the call, in order",
	);
	assert.ok(counts.progress >= 2, "progress is reported while the turn runs and once at the end");

	assert.equal(reports.length, 1, "one report per call");
	const report: PiCallReport = reports[0];
	assert.equal(report.stage, "task");
	assert.deepEqual([report.startCalled, report.startResolved], [true, true]);
	assert.deepEqual(report.disposition, { safe: true, concerns: [] });
	assert.deepEqual([report.storage?.attempted, report.storage?.disposed], [true, true]);
	const callDir = report.storage?.callDir ?? "";
	assert.equal(path.dirname(callDir), piPaths(agentDir, cwd).callsDir, "this call's own directory, where the layout puts one");
	assert.equal(fs.existsSync(callDir), false, "an ending that left nothing behind is what licences removing it");

	const ended = report.ended;
	if (ended?.kind !== "task") assert.fail(`this call ended at its task, and this one ended ${ended?.kind}`);
	const result = ended.result;
	if (!result.ok) assert.fail(`the turn read back whole, and this one refused with ${result.reason}`);
	taskExit = result.exit;
	assert.equal(taskExit.failure, undefined, "the transport's own verdict on how the child ended");
	assert.equal(taskExit.stoppedByUs, true);
	assert.equal(taskExit.cleanup.root, "exited");
	assert.equal(taskExit.cleanup.stdio, "closed");
	assert.deepEqual([taskExit.stderr.serving, taskExit.stderr.lastStage, taskExit.stderr.stageCount], [true, "serving", 4], "the four stage diagnostics the bootstrap writes, the last of them serving");
	assert.deepEqual(
		Object.entries(taskExit.counters).filter(([, value]) => value !== 0),
		[],
		"nothing strayed, dropped, timed out late or was left unclosed",
	);
	assert.deepEqual([attempts, children.length], [1, 1], "one child for one call");
	assert.equal(await within("the child's own exit", children[0].exited), taskExit, "the child's exit is the report the task's own stop made");

	// The wire, as the fake logged it: the transport's readiness probe, then the preparation's own readbacks, the
	// prompt, and the turn's four. The first `get_state` is readiness and the preparation's is its own; the run ends
	// with no `clear_queue` and no `abort`, because a host stop with no turn in flight sends neither.
	const wire = fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { read?: unknown })
		.filter((entry): entry is { read: string } => typeof entry.read === "string")
		.map((entry) => (JSON.parse(entry.read) as { type: string }).type);
	assert.deepEqual(wire, ["get_state", "get_state", "get_session_stats", "get_tree", "prompt", "get_state", "get_tree", "get_session_stats", "get_last_assistant_text"]);
});
