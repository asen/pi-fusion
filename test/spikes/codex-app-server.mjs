#!/usr/bin/env node
/*
 * Manual stage 1 qualification harness for the Codex backend, run by hand and one agreed case group at a time. It is
 * not part of `npm test`: the default glob (`test/*.test.ts`) does not reach this directory, and a native run starts
 * the user's own Codex app-server on the user's own login, configuration and quota.
 *
 *   node test/spikes/codex-app-server.mjs --list
 *   node test/spikes/codex-app-server.mjs --run --case Q1,Q2,Q7,Q9            # model-free cases
 *   node test/spikes/codex-app-server.mjs --run --case Q3 --keep              # one model case
 *   node test/spikes/codex-app-server.mjs --run --fake --case Q1,Q2,Q4,Q6,Q7,Q9  # NOT NATIVE
 *
 * Nothing runs without `--run` and an explicit `--case` (`all` is a deliberate value, not a default). `--help`,
 * `--list`, an unknown or malformed argument, a missing `--run` or a missing or unmatched `--case` exit 2 before any
 * production module is imported: no `PATH` lookup, no Codex home, configuration or auth read, no child.
 *
 * What a native run is. The production pieces, unchanged: `codexLaunch` over this process's environment (the host's
 * binary, `CODEX_HOME`/`~/.codex`, configuration, login, MCP servers, remote-control and multi-agent settings, all
 * inherited and nothing isolated), `startCodexChild`, and for every turn `createCodexBackend` with only these seams of
 * the harness's own: a launch that calls the production `codexLaunch` and keeps its answer, a start that calls the
 * production `startCodexChild` and records what its child answered (the raw notifications included, for command
 * items), `onCall`, and for Q3 alone a contract reader that appends a nonce to the shipped addendum. Model-free cases
 * drive the transport directly with the thread/start body the backend composes. No request names a cwd, a sandbox
 * policy or a configuration override, and `fusion.ts` and the host runtime take no part.
 *
 * What it never does. It copies, reads or prints no credential or auth file, logs in to nothing, injects no API key,
 * prints no environment, and writes no Codex configuration. `config.toml` in the predicted Codex home is hashed in
 * memory before and after every case to report a mutation, and scanned only for a top-level user-layer `web_search`
 * key, labelled NOT the merged effective configuration; providers, MCP, profiles and the raw text are never printed.
 * Selection comes from the flags alone: `PI_FUSION_CODEX_<ROLE>_MODEL`/`_EFFORT` are not read, and no model or effort
 * catalogue is guessed.
 *
 * Evidence discipline. Sandbox probes are exact harness-authored commands running the bundled probe program; a verdict
 * reads the command item's status and exit code, the fixture's own state and the controller's loopback listener, never
 * the model's prose, and only a command item that is word for word the probe's own command counts. The oracle is the
 * policy the thread/start answer reports now, through `codex-app-server-cases.mjs`; a field the answer leaves out is
 * unknown, and a probe it would decide is skipped with that reason. Missing evidence is unproven, never a pass, and Q5
 * passes only with an observed denial. Loopback probes count only when the controller's own requests to the same
 * listener reached it before and after the turn, and speak for that one listener. Probe targets are only directories
 * this harness creates; fixtures and those directories are removed only after every owned child is proved over with no
 * cleanup concern, and otherwise kept and named.
 *
 * `--fake` swaps the launch for `test/fake-codex.mjs` by path under this host's node: no Codex binary is located. A
 * fake run exercises this harness's flow and the production transport/backend against literals, and is NOT NATIVE
 * evidence of anything a real Codex does.
 *
 * Exit codes: 0 when every selected case passed (annotated skips allowed), 1 when any failed or is unproven, 2 when no
 * case ran at all.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CASES,
	canonicalPath,
	caseStatus,
	classifyNetwork,
	classifyWrite,
	composeInstructions,
	EXIT,
	exitCode,
	expectNetwork,
	forcedExitNotice,
	expectWrite,
	fileDigest,
	GROUPS,
	identifyProbe,
	networkVerdict,
	parseArgs,
	pickOutside,
	probeAfter,
	probeItems,
	probeVerdict,
	q5Verdict,
	sameProbeCommand,
	selectCases,
	shellWords,
	startTimeOf,
	threadParams,
	topLevelWebSearch,
	USAGE,
	versionFromUserAgent,
	WARNING,
	writeGrants,
} from "./codex-app-server-cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FAKE_CODEX = path.join(REPO, "test", "fake-codex.mjs");
const FENCE = path.join(REPO, "test", "sdk-fence.mjs");
const PROBE_SOURCE = path.join(HERE, "codex-app-server-probe.mjs");

/** How long one model case may run before the harness cancels it through the production signal. */
const MODEL_CASE_MS = 10 * 60_000;
/** How long a cancelled run, or a child's exit, is waited for before the root is kept as uncertain. */
const SETTLE_MS = 90_000;
/** Raw notifications one child's record keeps; past it they are counted and dropped. */
const NOTIFICATION_CAP = 20_000;
const SLEEP_PROBE_S = 120;

async function main(cli) {
	if (cli.unknown.length > 0 || cli.problems.length > 0) {
		for (const arg of cli.unknown) console.log(`unrecognised argument: ${arg}`);
		for (const problem of cli.problems) console.log(problem);
		console.log("see --help; nothing ran");
		return EXIT.none;
	}
	if (cli.help) {
		console.log(USAGE);
		return EXIT.none;
	}
	if (cli.list) {
		console.log("cases ([model] starts a turn: a provider request on your login, USD unknown; [fake] runs under --fake):");
		for (const entry of CASES) console.log(`  ${entry.id.padEnd(4)} ${entry.model ? "[model]" : "       "} ${entry.fake ? "[fake]" : "      "} ${entry.title}`);
		console.log("groups:");
		for (const [name, members] of Object.entries(GROUPS)) console.log(`  ${name.padEnd(11)} ${members.join(", ")}`);
		console.log("\nG1 needs Q5 to PASS with observed denial evidence: a host whose reported policy permits every probe is UNPROVEN, not a failure, and cannot qualify the boundary.");
		console.log("\nStages 2/3 (Q10+) are not implemented here. Native results: PENDING until the user runs an agreed group.");
		return EXIT.none;
	}
	if (!cli.run) {
		console.log("nothing runs without --run: no codex is located, no Codex home or configuration is read, no child starts");
		console.log(`\n${WARNING}`);
		return EXIT.none;
	}
	const selection = selectCases(cli.case);
	if (selection.error) {
		console.log(`${selection.error}; nothing ran`);
		return EXIT.none;
	}
	return runSelected(cli, selection.cases);
}

/* ------------------------------------------------------------------------------------------------------------------
 * the run
 * ---------------------------------------------------------------------------------------------------------------- */

/** The production modules, imported only once a run is asked for, so a guard path loads none of them. */
async function loadProduction() {
	const [binding, launch, backend, outcome, transport, protocol, types] = await Promise.all([
		import("../../extensions/backends/codex-binding.ts"),
		import("../../extensions/backends/codex-launch.ts"),
		import("../../extensions/backends/codex.ts"),
		import("../../extensions/backends/codex-outcome.ts"),
		import("../../extensions/backends/codex-transport.ts"),
		import("../../extensions/backends/codex-protocol.ts"),
		import("../../extensions/backends/types.ts"),
	]);
	return { ...binding, ...launch, ...backend, ...outcome, ...transport, ...protocol, failed: types.failed };
}

async function runSelected(cli, cases) {
	const fake = cli.fake;
	const label = fake ? " [FAKE, NOT NATIVE]" : "";
	console.log(`pi-fusion codex app-server qualification harness, stage 1 (${fake ? "FAKE" : "NATIVE"})`);
	if (fake) console.log("FAKE LAUNCH: test/fake-codex.mjs by path under this node. NOT NATIVE EVIDENCE: nothing below says what a real Codex does.");
	else console.log(WARNING);
	console.log(`node ${process.version}, ${process.platform}-${process.arch}, ${new Date().toISOString()}`);
	console.log(`selected: ${cases.map((entry) => entry.id).join(", ")}`);
	const flags = ["model", "effort", "unsupportedEffort", "nullEffortModel", "outsideDir"].filter((key) => cli[key] !== undefined).map((key) => `${key}=${cli[key]}`);
	console.log(`options: ${flags.length === 0 ? "none" : flags.join(", ")}`);

	const mod = await loadProduction();
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-codex-qual-"));
	fs.chmodSync(root, 0o700);
	const ctx = new Context(cli, mod, root);
	console.log(`fixture root: ${root}`);
	console.log(`protocol shapes: ${mod.CODEX_PROTOCOL_PROVENANCE.evidence} of Codex ${mod.CODEX_PROTOCOL_PROVENANCE.version}, ${mod.CODEX_PROTOCOL_PROVENANCE.runtime}; client ${JSON.stringify(mod.codexClientInfo())}`);

	try {
		ctx.prepare();
	} catch (error) {
		console.log(`setup failed before any case: ${message(error)}`);
		ctx.finish();
		return EXIT.failure;
	}
	console.log(`codex: ${ctx.executable}`);
	console.log(`predicted Codex home: ${ctx.codexHome}`);
	console.log(`config.toml: ${short(ctx.digest())}`);
	console.log(`user-layer top-level web_search: ${ctx.webSearch()} (USER LAYER ONLY, NOT MERGED EFFECTIVE CONFIGURATION)`);

	const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
		const handler = () => {
			if (ctx.interrupted) {
				// No cleanup, survey or claim from here: only what is left behind, said before the process goes.
				process.stdout.write(`\n${forcedExitNotice(ctx.root, ctx.outside)}\n`);
				process.exit(EXIT.failure);
			}
			console.log(`\n${signal}: cancelling the running case through the production signal; again to exit at once`);
			ctx.interrupt();
		};
		process.on(signal, handler);
		return [signal, handler];
	});
	const results = [];
	try {
		for (const entry of cases) {
			const result = new CaseResult(entry);
			console.log(`\n== ${entry.id}${entry.model && !fake ? " [model]" : ""}: ${entry.title} ==`);
			// A case missing its option skips before anything starts, in either mode, so it runs to that skip here too.
			const unmet = entry.needs !== undefined && ctx.cli[entry.needs] === undefined;
			if (ctx.interrupted) result.skip("the harness was interrupted before this case");
			else if (fake && !entry.fake && !unmet) result.skip("needs a native child that really runs a model and commands; the fake app-server cannot");
			else {
				const before = ctx.digest();
				try {
					await RUNNERS[entry.id](ctx, result);
				} catch (error) {
					result.fail(`case threw: ${message(error)}`);
					ctx.keep(`${entry.id} threw`);
				}
				const after = ctx.digest();
				result.fact("config.toml before/after", `${short(before)} / ${short(after)}`);
				result.guard(before === after, "config.toml bytes unchanged by this case");
			}
			results.push(result);
			console.log(`  RESULT ${entry.id}: ${result.status}${result.status === "skip" || result.status === "unproven" ? ` (${result.reason})` : ""}${label}`);
		}
	} finally {
		for (const [signal, handler] of signals) process.removeListener(signal, handler);
		ctx.finish();
	}
	console.log(`\nsummary${label}`);
	for (const result of results) console.log(`  ${result.id.padEnd(4)} ${result.status}${result.status !== "pass" && result.reason ? ` - ${result.reason}` : ""}`);
	const statuses = results.map((result) => result.status);
	const code = ctx.interrupted ? EXIT.failure : exitCode(statuses);
	console.log(`exit ${code}${label}`);
	return code;
}

/**
 * One case's checks and facts, printed as they happen. Its own measurements are kept apart from the guards around them
 * (configuration, shutdown, approvals, preflight): a guard can fail a case or leave it unproven, never pass it.
 */
class CaseResult {
	constructor(entry) {
		this.id = entry.id;
		this.parts = [];
	}
	get status() {
		return caseStatus(this.parts.filter((part) => !part.guard).map((part) => part.status), this.parts.filter((part) => part.guard).map((part) => part.status));
	}
	get reason() {
		const status = this.status;
		// A skipped case is explained by its own skip, never by a guard that held around it.
		return this.parts.find((part) => part.status === status && (status !== "skip" || !part.guard))?.why;
	}
	fact(key, value) {
		console.log(`    ${key}: ${value}`);
	}
	add(status, why, guard = false) {
		this.parts.push({ status, why, guard });
		console.log(`    ${status.toUpperCase()}${guard ? " (guard)" : ""} ${why}`);
	}
	/** A primary measurement of what the case is about. */
	check(ok, what) {
		this.add(ok ? "pass" : "fail", what);
		return ok;
	}
	/** A guard: its failure fails the case, its pass proves nothing about what the case measures. */
	guard(ok, what) {
		this.add(ok ? "pass" : "fail", what, true);
		return ok;
	}
	fail(why) {
		this.add("fail", why);
	}
	skip(why) {
		this.add("skip", why);
	}
	unproven(why) {
		this.add("unproven", why);
	}
}

/** What every case shares: the mode, the root, what is kept and why, and the launch each child gets. */
class Context {
	constructor(cli, mod, root) {
		this.cli = cli;
		this.mod = mod;
		this.root = root;
		this.fake = cli.fake;
		this.keepReasons = [];
		this.outside = [];
		this.abort = new AbortController();
		this.interrupted = false;
	}

	/** Where the binary and home come from. Native: the production launch, which locates codex now. Fake: no lookup. */
	prepare() {
		if (this.fake) {
			this.fakeHome = path.join(this.root, "fake-codex-home");
			fs.mkdirSync(this.fakeHome);
			this.codexHome = this.mod.expectedCodexHome(this.fakeEnv("ok"), this.root);
			this.executable = `${FAKE_CODEX} (fake, by path under ${process.execPath})`;
			return;
		}
		const prepared = this.mod.codexLaunch({ cwd: this.root, env: process.env });
		this.codexHome = prepared.expectedCodexHome;
		this.executable = `${prepared.executable.path} (${prepared.executable.source === "override" ? "PI_FUSION_CODEX_BIN" : "first codex on PATH"})`;
	}

	get configPath() {
		return path.join(this.codexHome, "config.toml");
	}

	digest() {
		return fileDigest(this.configPath);
	}

	/** Whether config.toml mentions a path, as a yes or no; its text is never kept or shown. */
	configMentions(text) {
		try {
			return fs.readFileSync(this.configPath, "utf8").includes(text);
		} catch {
			return false;
		}
	}

	webSearch() {
		try {
			return topLevelWebSearch(fs.readFileSync(this.configPath, "utf8"));
		} catch (error) {
			return error && error.code === "ENOENT" ? "absent (no config.toml)" : "unreadable";
		}
	}

	/**
	 * A fake child's environment. The fake's own `FAKE_CODEX_*` variables, when already set, win over the case's scenario:
	 * a seam for exercising this harness's failure branches under `--fake`, read by the fake alone and never native.
	 */
	fakeEnv(scenario) {
		return { ...process.env, FAKE_CODEX_SCENARIO: process.env.FAKE_CODEX_SCENARIO ?? scenario, CODEX_HOME: this.fakeHome };
	}

	/** One launch. Native is exactly `codexLaunch` over this process's environment; fake is the fixture by path. */
	launchFor(cwd, scenario = "ok", env) {
		if (!this.fake) return this.mod.codexLaunch({ cwd, env: env ?? process.env });
		const childEnv = env ?? this.fakeEnv(scenario);
		return {
			launch: { command: process.execPath, args: ["--import", pathToFileURL(FENCE).href, FAKE_CODEX, ...this.mod.CODEX_APP_SERVER_ARGS], cwd, env: { ...childEnv } },
			executable: { command: process.execPath, prefix: [FAKE_CODEX], path: FAKE_CODEX, source: "override" },
			expectedCwd: fs.realpathSync(cwd),
			expectedCodexHome: this.mod.expectedCodexHome(childEnv, cwd),
		};
	}

	caseDir(id) {
		const dir = path.join(this.root, "cases", id);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	keep(why) {
		this.keepReasons.push(why);
	}

	interrupt() {
		this.interrupted = true;
		this.abort.abort();
	}

	/** Removes the root and every outside probe directory, unless something kept them. */
	finish() {
		const dirs = [this.root, ...this.outside];
		if (this.keepReasons.length > 0 || this.cli.keep) {
			console.log(`\nkept: ${dirs.join(", ")}${this.keepReasons.length > 0 ? ` (${[...new Set(this.keepReasons)].join("; ")})` : " (--keep)"}`);
			return;
		}
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		console.log(`\nremoved: ${dirs.join(", ")} (every owned child ended with no cleanup concern)`);
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * shared pieces
 * ---------------------------------------------------------------------------------------------------------------- */

const message = (error) => (error instanceof Error ? error.message : String(error));
const short = (digest) => (/^[0-9a-f]{64}$/.test(digest) ? `sha256:${digest.slice(0, 16)}` : digest);
const token = (id, name) => `pfq-${id.toLowerCase()}-${name}-${randomBytes(6).toString("hex")}`;

/** A harness-chosen path as one shell word; a path that would need more than single quotes is refused. */
const quote = (value) => {
	if (value.includes("'") || /[\n\r]/.test(value)) throw new Error(`refusing to put ${JSON.stringify(value)} in a probe command`);
	return `'${value}'`;
};

async function bounded(promise, ms) {
	let timer;
	try {
		return await Promise.race([promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })), new Promise((resolve) => (timer = setTimeout(() => resolve({ ok: false, timeout: true }), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/** How a child ended, the way the cases print it. */
function describeExit(exit) {
	if (!exit) return "no exit report";
	return `root=${exit.cleanup.root} code=${exit.exit.code} signal=${exit.exit.signal} cleanExit=${exit.cleanExit} stopRequested=${exit.stopRequested} leftovers=${exit.cleanup.leftovers.length} discovery=${exit.cleanup.discovery} stdio=${exit.cleanup.stdio} streamsUnclosed=${exit.counters.streamsUnclosed} failure=${exit.failure ? `${exit.failure.kind}: ${exit.failure.message}` : "none"}`;
}

/** No cleanup concern: a clean actual exit, nothing left, discovery and pipes settled. `aborted` is a requested stop. */
function cleanlyOver(exit, allowAborted = false) {
	return Boolean(exit && exit.cleanExit && exit.cleanup.leftovers.length === 0 && exit.cleanup.discovery === "ok" && exit.cleanup.stdio === "closed" && exit.counters.streamsUnclosed === 0 && (exit.failure === undefined || (allowAborted && exit.failure.kind === "aborted")));
}

/**
 * Keeps the fixtures whenever a child this harness was handed, or may have spawned, is not proved over: a missing exit
 * report, an unclean actual exit, a leftover, failed discovery, held stdio or an unclosed pipe. A requested stop is not
 * a concern. The two child helpers call this themselves, so no case's early return can skip it.
 */
function retainUnlessOver(ctx, id, exit, what) {
	if (!cleanlyOver(exit, true)) ctx.keep(`${id}: ${what} is not proved over (${describeExit(exit)})`);
}

/** The shutdown check every child gets: reported as a pass or a failure, and the fixtures kept on any concern. */
function checkShutdown(ctx, result, exit, what, allowAborted = false) {
	result.fact(`${what} exit`, describeExit(exit));
	retainUnlessOver(ctx, result.id, exit, what);
	return result.guard(cleanlyOver(exit, allowAborted), `${what}: owned shutdown clean (clean actual exit, no leftovers, discovery ok, pipes closed${allowAborted ? ", a requested abort allowed" : ""})`);
}

function describeSandbox(sandbox) {
	if (!sandbox) return "none reported";
	const roots = sandbox.writableRoots === undefined ? "unknown" : JSON.stringify(sandbox.writableRoots);
	const flag = (value) => (value === undefined ? "unknown" : String(value));
	return `type=${sandbox.type} networkAccess=${flag(sandbox.networkAccess)} writableRoots=${roots} excludeSlashTmp=${flag(sandbox.excludeSlashTmp)} excludeTmpdirEnvVar=${flag(sandbox.excludeTmpdirEnvVar)}`;
}

function describeStart(start) {
	return `thread=${start.threadId} model=${start.model} provider=${start.modelProvider} effort=${start.reasoningEffort} approvalPolicy=${start.approvalPolicy ?? "unread"} cwd=${start.cwd}`;
}

function describeRead(read) {
	return `model=${read.model} provider=${read.modelProvider} effort=${read.reasoningEffort} status=${read.status.type} cwd=${read.cwd}`;
}

/** A shipped contract file, read the way the backend's default reader does. */
function productionContract(mod, name) {
	return fs.readFileSync(path.join(mod.CODEX_CONTRACTS_DIR, name), "utf8");
}

/** The thread/start body the backend sends for a role, with the shipped contracts (pinned to the backend by a test). */
const roleThreadParams = (mod, role) => threadParams(role, composeInstructions(role, (name) => productionContract(mod, name)));

/**
 * One child driven directly through the production transport: launch, handshake, the body, and one host shutdown.
 * Used where a case must not start a turn.
 */
async function withChild(ctx, cwd, body, scenario = "ok") {
	const prepared = ctx.launchFor(cwd, scenario);
	let child;
	try {
		child = await ctx.mod.startCodexChild({ launch: prepared.launch, clientInfo: ctx.mod.codexClientInfo(), signal: ctx.abort.signal });
	} catch (error) {
		const exit = error && error.finalExit ? error.finalExit : undefined;
		retainUnlessOver(ctx, "child start", exit, "a child that failed to start");
		return { prepared, startError: error, ...(exit ? { exit } : {}) };
	}
	let value;
	let thrown;
	try {
		value = await body(child, prepared);
	} catch (error) {
		thrown = error;
	}
	let exit;
	try {
		exit = await child.shutdown("host");
	} catch {}
	retainUnlessOver(ctx, "child", exit, `the child in ${cwd}`);
	return { prepared, child, value, thrown, exit };
}

/** A model-free thread/start for a role, to read the policy and selection a later turn would run under. */
async function preflightStart(ctx, result, cwd, call) {
	const role = ctx.mod.codexRole(call, undefined, {});
	const outcome = await withChild(ctx, cwd, (child) => child.startThread(roleThreadParams(ctx.mod, role)));
	if (outcome.startError || outcome.thrown) {
		result.unproven(`preflight thread/start failed: ${message(outcome.startError ?? outcome.thrown)}`);
		checkShutdown(ctx, result, outcome.exit, "preflight child");
		return undefined;
	}
	result.fact("preflight thread/start (no turn)", describeStart(outcome.value));
	result.fact("preflight sandbox", describeSandbox(outcome.value.sandbox));
	if (!checkShutdown(ctx, result, outcome.exit, "preflight child")) return undefined;
	return outcome.value;
}

/**
 * The production backend over seams that only observe: the production launch (kept), the production start (its child
 * recorded, every raw notification teed), `onCall`, and optionally a contract reader. Cancels through the production
 * signal on the case deadline or an interrupt, and waits for every handed child to exit before answering.
 */
async function backendRun(ctx, result, { call, prompt, cwd, scenario = "ok", readContract, onNotification, onTurn, deadlineMs = MODEL_CASE_MS, allowAborted = false }) {
	const { mod } = ctx;
	const record = { notifications: [], dropped: 0 };
	const controller = new AbortController();
	const cancel = () => controller.abort();
	ctx.abort.signal.addEventListener("abort", cancel, { once: true });
	let deadlineHit = false;
	const timer = setTimeout(() => {
		deadlineHit = true;
		controller.abort();
	}, deadlineMs);
	const tee = (notification) => {
		if (record.notifications.length < NOTIFICATION_CAP) record.notifications.push(notification);
		else record.dropped += 1;
		try {
			onNotification?.(notification, controller, record);
		} catch {}
	};
	const start = async (options) => {
		let child;
		try {
			child = await mod.startCodexChild({ ...options, onNotification: (notification) => (tee(notification), options.onNotification?.(notification)) });
		} catch (error) {
			if (error && error.finalExit) record.exit = error.finalExit;
			record.startError = error;
			throw error;
		}
		record.child = child;
		record.initialize = child.initialize;
		return {
			get pid() {
				return child.pid;
			},
			get initialize() {
				return child.initialize;
			},
			get counters() {
				return child.counters;
			},
			get exited() {
				return child.exited;
			},
			startThread: async (params, timeoutMs) => {
				record.threadParams = params;
				record.thread = await child.startThread(params, timeoutMs);
				return record.thread;
			},
			startTurn: async (params, timeoutMs) => {
				record.turnParams = params;
				record.turn = await child.startTurn(params, timeoutMs);
				try {
					onTurn?.(record.turn, controller);
				} catch {}
				return record.turn;
			},
			readThread: async (threadId, timeoutMs) => {
				record.read = await child.readThread(threadId, timeoutMs);
				return record.read;
			},
			interrupt: (turn, timeoutMs) => child.interrupt(turn, timeoutMs),
			threadStatus: (threadId) => child.threadStatus(threadId),
			shutdown: (reason) => child.shutdown(reason),
		};
	};
	const backend = mod.createCodexBackend({
		...(ctx.fake ? { env: ctx.fakeEnv(scenario) } : {}),
		launch: (request) => (record.launch = ctx.launchFor(request.cwd, scenario, request.env)),
		start,
		...(readContract === undefined ? {} : { readContract }),
		onCall: (report) => (record.report = report),
	});
	const role = mod.codexRole(call, undefined, {});
	record.role = role;
	const running = backend.run({ role, prompt, cwd, session: backend.session({ kind: "new" }), signal: controller.signal, input: backend.control(), onProgress: () => {}, onEvent: () => {} });
	let settled = await bounded(running, deadlineMs + SETTLE_MS);
	clearTimeout(timer);
	ctx.abort.signal.removeEventListener("abort", cancel);
	if (settled.timeout) {
		controller.abort();
		settled = await bounded(running, SETTLE_MS);
	}
	if (deadlineHit) result.fact("deadline", `the case deadline of ${deadlineMs}ms cancelled the run`);
	if (!settled.ok) {
		ctx.keep(`${result.id}: the backend run did not come back`);
		result.unproven(settled.timeout ? "the backend run did not come back after cancellation" : `the backend run threw: ${message(settled.error)}`);
		return record;
	}
	record.run = settled.value;
	if (record.child) {
		const exited = await bounded(record.child.exited, SETTLE_MS);
		if (exited.ok) record.exit = exited.value;
	}
	if (record.turn) record.evidence = record.turn.snapshot();
	describeRun(ctx, result, record);
	// Reported here, before any case reads the record, so an early return in a case cannot skip either.
	if (record.report?.startCalled) {
		const declined = (record.evidence?.denialCount ?? 0) + (record.exit?.counters.declinedApprovals ?? 0);
		record.approvals = declined;
		result.guard(declined === 0, `no approval requested under approval never (declined ${declined})`);
		checkShutdown(ctx, result, record.exit, "child", allowAborted);
	}
	return record;
}

/** What every backend run prints: the production verdict, the selection, the readbacks and the turn's evidence. */
function describeRun(ctx, result, record) {
	const run = record.run;
	result.fact("production verdict", `${ctx.mod.failed(run) ? "failed" : "success"} stopReason=${run.stopReason}${run.errorMessage ? ` error=${JSON.stringify(run.errorMessage)}` : ""} stage=${record.report?.stage ?? "unknown"}`);
	if (record.initialize) result.fact("initialize", `userAgent=${JSON.stringify(record.initialize.userAgent)} home=${record.initialize.codexHome}`);
	if (record.threadParams) result.fact("thread/start sent", `model=${record.threadParams.model ?? "(host default)"} provider=${record.threadParams.modelProvider ?? "(none)"} sandbox=${record.threadParams.sandbox} approvalPolicy=${record.threadParams.approvalPolicy} instructions=${Buffer.byteLength(record.threadParams.developerInstructions)}B no cwd`);
	if (record.thread) {
		result.fact("thread/start answer", describeStart(record.thread));
		result.fact("reported sandbox", describeSandbox(record.thread.sandbox));
	}
	if (record.turnParams) result.fact("turn/start sent", `prompt=${Buffer.byteLength(record.turnParams.text)}B effort=${record.turnParams.effort ?? "(none)"}`);
	if (record.read) result.fact("thread/read answer", describeRead(record.read));
	if (run.selection) result.fact("verified selection", JSON.stringify(run.selection));
	const evidence = record.evidence;
	if (evidence) {
		result.fact("turn", `completion=${evidence.completion ? evidence.completion.status : "none"} usage=${evidence.usage ? "reported" : "none"} items=${evidence.items.completed} reroutes=${evidence.rerouteCount} denials=${evidence.denialCount} retryableErrors=${evidence.retryableErrors} terminalErrors=${evidence.terminalErrors}`);
		result.fact("item types (primary turn)", JSON.stringify(itemTypes(record)));
	}
	result.fact("tokens", `in=${run.tokensIn} out=${run.tokensOut} cacheRead=${run.cacheRead} cacheWrite=${run.cacheWrite} (cache write vs input: Q14, unqualified) cost=unknown (Codex reports none; never estimated)`);
	if (record.dropped > 0) result.fact("notifications dropped past the cap", String(record.dropped));
}

/** Completed item types in the primary turn, counted from the raw notifications. */
function itemTypes(record) {
	const counts = {};
	for (const notification of primaryItems(record)) counts[notification.type] = (counts[notification.type] ?? 0) + 1;
	return counts;
}

function primaryItems(record) {
	const threadId = record.thread?.threadId;
	const turnId = record.turn?.turnId;
	return record.notifications
		.filter((notification) => notification.method === "item/completed" && notification.params?.threadId === threadId && notification.params?.turnId === turnId && typeof notification.params?.item?.type === "string")
		.map((notification) => notification.params.item);
}

/* ------------------------------------------------------------------------------------------------------------------
 * fixtures
 * ---------------------------------------------------------------------------------------------------------------- */

/** The harness's own git, with its own home and no system, global or hook configuration. The child's env is untouched. */
function git(ctx, cwd, args) {
	const home = path.join(ctx.root, "git-home");
	fs.mkdirSync(home, { recursive: true });
	const env = { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LANG: "C", LC_ALL: "C" };
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}

function fixtureRepo(ctx, dir, files) {
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	git(ctx, dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
	git(ctx, dir, ["add", "-A"]);
	git(ctx, dir, ["-c", "user.name=pi-fusion-harness", "-c", "user.email=harness@invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "qualification fixture"]);
	return dir;
}

const head = (ctx, dir) => git(ctx, dir, ["rev-parse", "HEAD"]).trim();
const status = (ctx, dir) => git(ctx, dir, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean).sort();

/** Every file under a directory but `.git`, with its bytes' digest: the fixture's state, not anyone's report of it. */
function tree(dir) {
	const out = {};
	const walk = (at) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			if (entry.name === ".git" && at === dir) continue;
			const file = path.join(at, entry.name);
			const rel = path.relative(dir, file);
			if (entry.isDirectory()) walk(file);
			else if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(file)}`;
			else out[rel] = fileDigest(file);
		}
	};
	walk(dir);
	return JSON.stringify(out);
}

function fileState(file) {
	try {
		return { exists: true, content: fs.readFileSync(file, "utf8") };
	} catch {
		return { exists: fs.existsSync(file), content: undefined };
	}
}

/** The probe program, copied into a case's own directory so its command line names a short harness-owned path. */
function installProbe(dir) {
	const probeDir = path.join(dir, "probe");
	fs.mkdirSync(probeDir, { recursive: true });
	const file = path.join(probeDir, "probe.mjs");
	fs.copyFileSync(PROBE_SOURCE, file);
	return { file, command: (...args) => [quote(process.execPath), quote(file), ...args].join(" ") };
}

/** The controller's own loopback listener: the network probe's only destination, counting requests per token. */
async function loopback() {
	const hits = new Map();
	const server = http.createServer((request, response) => {
		const key = (request.url ?? "").slice(1);
		hits.set(key, (hits.get(key) ?? 0) + 1);
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("ok\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return { url: (key) => `http://127.0.0.1:${port}/${key}`, hits: (key) => hits.get(key) ?? 0, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * The controller's own trusted request to its listener, outside any sandbox: the probe program run directly by this
 * process with a control token of its own. Its hits are counted under that token and never as a model probe's.
 */
function loopbackControl(probe, net, label) {
	const key = token("ctl", label);
	return new Promise((resolve) => {
		execFile(process.execPath, [probe.file, "net", net.url(key)], { timeout: 15_000 }, (error) => {
			const exit = error ? (typeof error.code === "number" ? error.code : null) : 0;
			const hits = net.hits(key);
			resolve({ ok: exit === 0 && hits > 0, exit, hits });
		});
	});
}

/**
 * The host's process table as Q6 reads it, observed and never signalled: pids from /proc, and one pid's exact argv and
 * start time. Linux only; elsewhere, or when /proc cannot be read, the table is undefined and Q6 is unproven.
 */
const PROC = {
	list() {
		try {
			return fs
				.readdirSync("/proc")
				.filter((name) => /^\d+$/.test(name))
				.map(Number);
		} catch {
			return undefined;
		}
	},
	read(pid) {
		try {
			const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			if (argv.at(-1) === "") argv.pop();
			return { argv, start: startTimeOf(fs.readFileSync(`/proc/${pid}/stat`, "utf8")) };
		} catch {
			return undefined;
		}
	},
};

const readText = (file) => {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};

/* ------------------------------------------------------------------------------------------------------------------
 * the cases
 * ---------------------------------------------------------------------------------------------------------------- */

const RUNNERS = {
	Q1: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q1"), "work");
		fs.mkdirSync(work);
		const outcome = await withChild(ctx, work, async (child) => child.initialize);
		if (outcome.startError) {
			result.fail(`the child did not complete its handshake: ${message(outcome.startError)}`);
			checkShutdown(ctx, result, outcome.exit, "child");
			return;
		}
		const init = outcome.value;
		const version = versionFromUserAgent(init.userAgent);
		result.fact("userAgent", JSON.stringify(init.userAgent));
		result.fact("version", version ? `${version} (parsed from userAgent; reported, not independently verified)` : "none parsed from userAgent");
		result.fact("platform", `${init.platformFamily}/${init.platformOs} (child) vs ${process.platform}-${process.arch} (host), node ${process.version}`);
		result.fact("Codex home", `reported ${init.codexHome}, predicted ${outcome.prepared.expectedCodexHome}`);
		if (!ctx.fake && !(process.platform === "linux" && process.arch === "x64")) result.fact("target", "outside the Linux x64 qualification target: recorded, unqualified");
		if (!ctx.fake && version !== undefined && version !== ctx.mod.CODEX_PROTOCOL_PROVENANCE.version) result.fact("target", `reported version differs from the source-read ${ctx.mod.CODEX_PROTOCOL_PROVENANCE.version}: recorded, unqualified`);
		result.check(canonicalPath(init.codexHome) === canonicalPath(outcome.prepared.expectedCodexHome), "reported Codex home equals the predicted home (canonical)");
		checkShutdown(ctx, result, outcome.exit, "child");
	},

	Q2: async (ctx, result) => {
		const dir = ctx.caseDir("Q2");
		const work = path.join(dir, "work");
		fs.mkdirSync(work);
		// The launch cwd is a symlink to the work directory, so the binding is a realpath comparison and not a string match.
		const link = path.join(dir, "work-link");
		fs.symlinkSync(work, link, "dir");
		result.fact("launch cwd", `${link} -> ${fs.realpathSync(link)} (no request names a cwd)`);
		const legs = [
			{ label: "implement, host default", call: { role: "implement" } },
			{ label: "ask answer, host default", call: { role: "ask", mode: "answer" } },
			{ label: "ask review, host default", call: { role: "ask", mode: "review" } },
		];
		if (ctx.cli.model) legs.push({ label: `implement, explicit model ${ctx.cli.model}`, call: { role: "implement", model: ctx.cli.model } });
		else result.skip("explicit-model leg: no --model given, and this harness guesses no model catalogue");
		for (const leg of legs) {
			const role = ctx.mod.codexRole(leg.call, undefined, {});
			const outcome = await withChild(ctx, link, async (child, prepared) => {
				const start = await child.startThread(roleThreadParams(ctx.mod, role));
				result.fact(`${leg.label}: thread/start`, describeStart(start));
				result.fact(`${leg.label}: sandbox`, describeSandbox(start.sandbox));
				const problem = ctx.mod.threadStartProblem(role, start, canonicalPath(start.cwd), canonicalPath(prepared.expectedCwd));
				result.fact(`${leg.label}: reported cwd`, `${start.cwd} (${start.cwd === prepared.expectedCwd ? "the realpath" : start.cwd === link ? "the symlink as launched" : "neither the realpath nor the launch path"})`);
				if (!result.check(problem === undefined, `${leg.label}: production start checks pass (cwd bound by realpath, ${role.sandboxMode}, approval never, named selection exact)${problem ? `: ${problem}` : ""}`)) {
					result.fact(`${leg.label}`, "halted before any turn; a fallback that names the cwd stays disabled pending the user's consent");
					return;
				}
				let read;
				try {
					read = await child.readThread(start.threadId);
				} catch (error) {
					result.unproven(`${leg.label}: thread/read before any turn failed (${message(error)}); production reads only after a turn`);
					return;
				}
				result.fact(`${leg.label}: thread/read`, describeRead(read));
				result.check(canonicalPath(read.cwd) === canonicalPath(prepared.expectedCwd), `${leg.label}: readback cwd bound by realpath`);
				result.check(read.modelProvider === start.modelProvider, `${leg.label}: readback provider equals the start answer's`);
				if (role.model !== undefined) result.check(read.model === role.model || read.model === null, `${leg.label}: readback model is the named model (or null, which production notes and keeps the start answer's)`);
				else result.fact(`${leg.label}: host default`, `start model ${start.model}, readback model ${read.model}, effort start ${start.reasoningEffort} / read ${read.reasoningEffort}`);
			});
			if (outcome.startError) result.fail(`${leg.label}: the child did not start: ${message(outcome.startError)}`);
			if (outcome.thrown) result.fail(`${leg.label}: thread/start failed: ${message(outcome.thrown)}`);
			if (outcome.child) result.check(canonicalPath(outcome.child.initialize.codexHome) === canonicalPath(outcome.prepared.expectedCodexHome), `${leg.label}: reported home equals the predicted home`);
			checkShutdown(ctx, result, outcome.exit, `${leg.label} child`);
		}
	},

	Q3: async (ctx, result) => {
		const dir = ctx.caseDir("Q3");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "target.txt": "status: old\n" });
		const before = head(ctx, work);
		const nonce = token("Q3", "nonce");
		const role = ctx.mod.codexRole({ role: "implement" }, undefined, {});
		const readContract = (name) => {
			const text = productionContract(ctx.mod, name);
			return name === role.addendum ? `${text.trimEnd()}\n\nHARNESS_NONCE: ${nonce}\nThis manual qualification value appears only in these developer instructions; write it only where a task asks for it.\n` : text;
		};
		const prompt = "In target.txt in the current directory, replace the line `status: old` with `status: new`. Then create a file named nonce.txt in the current directory whose only content is the HARNESS_NONCE value from your developer instructions, followed by a newline. Change nothing else.";
		result.guard(!prompt.includes(nonce), "the prompt does not carry the nonce");
		const record = await backendRun(ctx, result, { call: { role: "implement" }, prompt, cwd: work, readContract });
		if (!record.run) return;
		result.check(record.threadParams?.developerInstructions.includes(nonce) === true && record.turnParams?.text.includes(nonce) === false, "the nonce went out in developerInstructions only");
		result.check(!ctx.mod.failed(record.run), "production verdict: success");
		result.check(fileState(path.join(work, "target.txt")).content === "status: new\n", "target.txt now reads `status: new` (fixture state)");
		const delivered = fileState(path.join(work, "nonce.txt"));
		result.check(delivered.content?.trim() === nonce, "nonce.txt holds the developer-only nonce (fixture state)");
		result.check(head(ctx, work) === before, "HEAD unchanged: no commit");
		const changed = status(ctx, work);
		result.fact("git status", JSON.stringify(changed));
		result.check(JSON.stringify(changed) === JSON.stringify([" M target.txt", "?? nonce.txt"]), "only target.txt changed and nonce.txt was added");
	},

	Q3b: async (ctx, result) => {
		const effort = ctx.cli.effort;
		if (!effort) return result.skip("no --effort given; this harness guesses no effort catalogue");
		const work = path.join(ctx.caseDir("Q3b"), "work");
		fs.mkdirSync(work);
		const start = await preflightStart(ctx, result, work, { role: "ask" });
		if (!start) return;
		result.fact("configured default effort (start answer)", String(start.reasoningEffort));
		if (start.reasoningEffort === effort) return result.skip(`--effort ${effort} equals the configured default, so it measures nothing distinct`);
		const record = await backendRun(ctx, result, { call: { role: "ask", effort }, prompt: "Reply with the single word OK.", cwd: work });
		if (!record.run) return;
		result.check(!ctx.mod.failed(record.run), "production verdict: success (a named effort must read back exactly)");
		result.check(record.read?.reasoningEffort === effort && record.run.selection?.effort === effort, `readback and verified selection name effort ${effort}`);
	},

	Q4: async (ctx, result) => {
		const dir = ctx.caseDir("Q4");
		const codename = token("Q4", "codename");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "facts.txt": `codename: ${codename}\n` });
		const before = { head: head(ctx, work), tree: tree(work), status: status(ctx, work) };
		const record = await backendRun(ctx, result, { call: { role: "ask", mode: "answer" }, prompt: "What codename is recorded in facts.txt in the current directory? Reply with the codename only.", cwd: work });
		if (!record.run) return;
		result.check(!ctx.mod.failed(record.run), "production verdict: success");
		result.check(record.thread?.sandbox.type === "readOnly", "reported sandbox is readOnly");
		result.check(tree(work) === before.tree, "fixture files unchanged (fixture state)");
		result.check(head(ctx, work) === before.head, "HEAD unchanged: no commit");
		result.check(JSON.stringify(status(ctx, work)) === JSON.stringify(before.status), "git status unchanged");
		result.fact("answer names the codename", `${record.run.text.includes(codename)} (model prose: supporting only, not evidence)`);
	},

	Q5: async (ctx, result) => {
		const dir = ctx.caseDir("Q5");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "README.txt": "sandbox probe fixture\n" });
		const preflight = await preflightStart(ctx, result, work, { role: "implement" });
		if (!preflight) return;
		const probe = installProbe(dir);
		const net = await loopback();
		try {
			const tmpdirEnv = process.env.TMPDIR;
			const planned = writeGrants(preflight.sandbox, { cwd: preflight.cwd, tmpdirEnv });
			const probes = [];
			const addWrite = (name, target) => {
				const key = token("Q5", name);
				probes.push({ name, kind: "write", key, target, command: probe.command("write", quote(target), key) });
			};
			// Every target is in a directory this harness just created: no existing file is written, and no configured root
			// is chosen as a location — though a disposable directory may itself lie under a user's grant, and is judged so.
			const disposable = (parent, prefix) => {
				const made = fs.mkdtempSync(path.join(canonicalPath(parent), prefix));
				ctx.outside.push(made);
				return made;
			};
			addWrite("inside", path.join(work, "probe-inside.txt"));
			if (fs.existsSync("/tmp")) addWrite("slash-tmp", path.join(disposable("/tmp", "pi-fusion-codex-q5-tmp-"), "probe.txt"));
			else result.fact("probe slash-tmp", "SKIP no /tmp on this host");
			if (typeof tmpdirEnv !== "string" || !path.isAbsolute(tmpdirEnv) || !fs.existsSync(tmpdirEnv)) result.fact("probe tmpdir", "SKIP no absolute, existing TMPDIR in the inherited environment");
			else if (canonicalPath(tmpdirEnv) === canonicalPath("/tmp")) result.fact("probe tmpdir", "SKIP TMPDIR is /tmp, already probed");
			else addWrite("tmpdir", path.join(disposable(tmpdirEnv, "pi-fusion-codex-q5-tmpdir-"), "probe.txt"));
			const home = process.env.HOME;
			const candidates = [
				{ label: "--outside-dir", parent: ctx.cli.outsideDir },
				{ label: "/dev/shm", parent: "/dev/shm" },
				{ label: "XDG_RUNTIME_DIR", parent: process.env.XDG_RUNTIME_DIR },
				{ label: "the fixture root's parent", parent: path.dirname(ctx.root) },
				{ label: "HOME/.cache", parent: typeof home === "string" && path.isAbsolute(home) ? path.join(home, ".cache") : undefined },
			];
			const usable = (parent) => {
				try {
					return fs.statSync(parent).isDirectory() && (fs.accessSync(parent, fs.constants.W_OK), true);
				} catch {
					return false;
				}
			};
			const outside = pickOutside(candidates, { granted: planned, codexHome: ctx.codexHome, usable });
			if (outside.chosen) addWrite("outside", path.join(disposable(outside.chosen.parent, "pi-fusion-codex-probe-"), "probe.txt"));
			result.fact("outside candidates", `${outside.chosen ? `chose ${outside.chosen.label} ${outside.chosen.parent}` : "SKIP none is genuinely outside every reported grant"}${outside.reasons.length ? `; passed over: ${outside.reasons.join("; ")}` : ""}`);
			const netKey = token("Q5", "net");
			probes.push({ name: "loopback", kind: "net", key: netKey, command: probe.command("net", net.url(netKey)) });

			const prompt = [
				"This is a manual sandbox qualification. Run each of the following shell commands exactly as written, one at a time, in order, without changing, combining or retrying any of them, and run no other command. A command that fails is an expected result: do not work around it. When all have run, reply with one line per command giving its exit code.",
				"",
				...probes.map((entry, index) => `${index + 1}. ${entry.command}`),
			].join("\n");
			const controls = { before: await loopbackControl(probe, net, "before") };
			const record = await backendRun(ctx, result, { call: { role: "implement" }, prompt, cwd: work });
			controls.after = await loopbackControl(probe, net, "after");
			result.fact("loopback controls", `before exit=${controls.before.exit} hits=${controls.before.hits}; after exit=${controls.after.exit} hits=${controls.after.hits} (controller-owned, never counted as the model's probe)`);
			if (!record.run) return;
			const start = record.thread;
			if (!start) return result.unproven("no thread was started, so no probe ran under a reported policy");
			if (describeSandbox(start.sandbox) !== describeSandbox(preflight.sandbox)) result.fact("note", "the run's reported policy differs from the preflight's; the run's own is the oracle");
			const granted = writeGrants(start.sandbox, { cwd: start.cwd, tmpdirEnv });
			const scope = { threadId: start.threadId, turnId: record.turn?.turnId };
			const measured = [];
			for (const entry of probes) {
				const match = probeItems(record.notifications, entry.command, entry.key, scope);
				const expectation = entry.kind === "write" ? expectWrite(granted, entry.target) : expectNetwork(start.sandbox);
				const observation = entry.kind === "write" ? classifyWrite(match, fileState(entry.target), entry.key) : classifyNetwork(match, net.hits(entry.key));
				const verdict = entry.kind === "write" ? probeVerdict(expectation, observation) : networkVerdict(expectation, observation, controls);
				result.fact(`probe ${entry.name}`, entry.command);
				result.fact(`probe ${entry.name} verdict`, `${verdict.status.toUpperCase()} ${verdict.why}`);
				measured.push({ name: entry.name, observation, verdict });
			}
			result.fact("run (not gating Q5)", `${ctx.mod.failed(record.run) ? "failed" : "success"}; the probes' exact command items, fixture state and listener are the evidence`);
			const verdict = q5Verdict(measured, { sandboxType: start.sandbox.type, approvals: record.approvals ?? 0 });
			result.add(verdict.status, `Q5: ${verdict.why}`);
		} finally {
			await net.close();
		}
	},

	Q5b: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q5b"), "work");
		fs.mkdirSync(work);
		const preflight = await preflightStart(ctx, result, work, { role: "ask" });
		if (!preflight) return;
		if (preflight.sandbox.networkAccess !== false) return result.skip(`condition unmet: the read-only policy reports networkAccess ${preflight.sandbox.networkAccess ?? "unknown"}, not false`);
		const record = await backendRun(ctx, result, {
			call: { role: "ask", mode: "answer" },
			prompt: "Use your web search tool, not a shell command, to look up the title of the page at https://example.com, and reply with that title and the source you used. Run no shell command.",
			cwd: work,
		});
		if (!record.run) return;
		const items = primaryItems(record);
		const searches = items.filter((item) => item.type === "webSearch").length;
		result.fact("hosted search items", `${searches} webSearch, ${items.filter((item) => item.type === "commandExecution").length} commandExecution (never command-network evidence)`);
		result.fact("user-layer top-level web_search", `${ctx.webSearch()} (NOT MERGED EFFECTIVE)`);
		if (record.thread?.sandbox.networkAccess !== false) result.skip("condition unmet in the run: its reported networkAccess is not false");
		else if (searches === 0) result.skip("no hosted search item observed: search is unavailable or unused under this configuration");
		else result.check(true, "hosted web search ran while the reported command network was off");
	},

	Q5c: async (ctx, result) => {
		const dir = ctx.caseDir("Q5c");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "README.txt": "network probe fixture\n" });
		const preflight = await preflightStart(ctx, result, work, { role: "implement" });
		if (!preflight) return;
		if (preflight.sandbox.networkAccess !== true) return result.skip(`the workspace-write policy reports networkAccess ${preflight.sandbox.networkAccess ?? "unknown"}; Q5c measures a network change you make to your own configuration first, and this harness makes none`);
		const probe = installProbe(dir);
		const net = await loopback();
		try {
			const key = token("Q5c", "net");
			const command = probe.command("net", net.url(key));
			const controls = { before: await loopbackControl(probe, net, "before") };
			const record = await backendRun(ctx, result, { call: { role: "implement" }, prompt: `This is a manual network qualification. Run exactly this shell command once, unchanged, run no other command, and reply with its exit code:\n\n${command}`, cwd: work });
			controls.after = await loopbackControl(probe, net, "after");
			result.fact("loopback controls", `before exit=${controls.before.exit} hits=${controls.before.hits}; after exit=${controls.after.exit} hits=${controls.after.hits}`);
			if (!record.run || !record.thread) return result.unproven("no thread was started");
			const match = probeItems(record.notifications, command, key, { threadId: record.thread.threadId, turnId: record.turn?.turnId });
			const verdict = networkVerdict(expectNetwork(record.thread.sandbox), classifyNetwork(match, net.hits(key)), controls);
			result.fact("probe loopback", command);
			result.add(verdict.status, `probe loopback: ${verdict.why}`);
			} finally {
			await net.close();
		}
	},

	Q6: async (ctx, result) => {
		const dir = ctx.caseDir("Q6");
		const work = fixtureRepo(ctx, path.join(dir, "work"), { "README.txt": "cancellation fixture\n" });
		const key = token("Q6", "sleep");
		const pidFile = path.join(work, `${key}.pid`);
		let prompt = "Reply with the single word OK.";
		let command;
		if (!ctx.fake) {
			command = installProbe(dir).command("sleep", quote(pidFile), String(SLEEP_PROBE_S));
			prompt = `Run exactly this shell command once, unchanged, and wait for it to finish; then reply with its exit code:\n\n${command}`;
		}
		// The probe's exact argv, as the process table shows it: interpreter, script, verb, pid file and seconds.
		const argv = command === undefined ? undefined : shellWords(command);
		let cancelledAt;
		let seen;
		const cancel = (controller, why) => {
			if (cancelledAt) return;
			cancelledAt = why;
			controller.abort();
		};
		const record = await backendRun(ctx, result, {
			call: { role: "implement" },
			prompt,
			cwd: work,
			scenario: "forever",
			allowAborted: true,
			// The fake runs no command: its turn being admitted is the cancellation point there.
			onTurn: (_turn, controller) => ctx.fake && cancel(controller, "the turn was admitted (fake)"),
			onNotification: (notification, controller) => {
				if (ctx.fake || notification.method !== "item/started" || notification.params?.item?.type !== "commandExecution") return;
				if (!sameProbeCommand(notification.params.item.command, command)) return;
				const deadline = Date.now() + 15_000;
				const poll = () => {
					if (controller.signal.aborted) return;
					seen = identifyProbe(argv, readText(pidFile), PROC);
					if (seen.identity || Date.now() > deadline) {
						cancel(controller, seen.identity ? `the sleep probe ran as pid ${seen.identity.pid} (identified by ${seen.how})` : `the probe's command started but the probe was not identified (${seen.why})`);
						return;
					}
					setTimeout(poll, 100);
				};
				poll();
			},
		});
		if (!record.run) return;
		if (!cancelledAt) return result.unproven("the cancellation point never came: no turn was admitted, or it ended before the probe ran");
		result.fact("cancelled when", cancelledAt);
		result.fact("child's own turn completion", record.evidence?.completion ? record.evidence.completion.status : "none (the transport ended the turn)");
		result.check(record.run.stopReason === "aborted", "production verdict: aborted");
		result.check(record.exit?.stopRequested === true, "the host requested the stop");
		if (ctx.fake) return;
		if (!seen?.identity) {
			ctx.keep("Q6: the sleep probe was never identified, so whether it is gone is unknown");
			return result.unproven(`the sleep probe was not identified before cancellation (${seen?.why ?? "it never started"}), so nothing says it is gone`);
		}
		// Observation only: production cleanup is what is measured, and this harness signals nothing itself.
		const after = probeAfter(seen.identity, PROC);
		if (after !== "gone") ctx.keep(`Q6: the sleep probe pid ${seen.identity.pid} is ${after === "alive" ? "still running" : "not provably gone"} after the shutdown; inspect it yourself`);
		if (after === "unknown") return result.unproven("the process table could not be read after the shutdown, so whether the sleep probe is gone is unknown");
		result.check(after === "gone", `the sleep probe (pid ${seen.identity.pid}, start ${seen.identity.start}) is gone after the owned shutdown`);
	},

	Q7: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q7"), "work");
		fs.mkdirSync(work);
		const role = ctx.mod.codexRole({ role: "ask" }, undefined, {});
		for (const leg of [{ label: "after initialize", thread: false }, { label: "with an open thread", thread: true }]) {
			const outcome = await withChild(ctx, work, async (child) => (leg.thread ? child.startThread(roleThreadParams(ctx.mod, role)) : undefined));
			if (outcome.startError || outcome.thrown) {
				result.fail(`${leg.label}: ${message(outcome.startError ?? outcome.thrown)}`);
				checkShutdown(ctx, result, outcome.exit, `${leg.label} child`);
				continue;
			}
			const exit = outcome.exit;
			const self = Boolean(exit && exit.cleanup.root === "exited" && exit.exit.code === 0 && exit.exit.signal === null);
			result.check(self, `${leg.label}: under the production owned shutdown (SIGTERM to observed descendants first, then stdin end) the root exited by itself with status 0 and no root signal`);
			checkShutdown(ctx, result, exit, `${leg.label} child`);
		}
	},

	Q8: async (ctx, result) => {
		const effort = ctx.cli.unsupportedEffort;
		if (!effort) return result.skip("no --unsupported-effort given; this harness guesses no effort catalogue");
		const work = path.join(ctx.caseDir("Q8"), "work");
		fs.mkdirSync(work);
		const record = await backendRun(ctx, result, { call: { role: "ask", effort }, prompt: "Reply with the single word OK.", cwd: work });
		if (!record.run) return;
		const thrown = record.report?.thrown?.error;
		result.fact("behavior (RECORDED, not judged)", `stage=${record.report?.stage} verdict=${ctx.mod.failed(record.run) ? "failed" : "success"} turnAdmitted=${record.turn !== undefined} readbackEffort=${record.read ? record.read.reasoningEffort : "no readback"}${thrown ? ` thrown=${JSON.stringify(message(thrown))}` : ""}`);
		result.fact("charge", record.evidence?.usage ? "usage was reported: a provider charge is possible, USD unknown" : "no usage reported, which is not evidence that nothing was charged");
		result.check(true, "the behavior was recorded; neither a refusal nor no charge is assumed");
	},

	Q8b: async (ctx, result) => {
		const model = ctx.cli.nullEffortModel;
		if (!model) return result.skip("no --null-effort-model given; this harness guesses no model catalogue");
		const work = path.join(ctx.caseDir("Q8b"), "work");
		fs.mkdirSync(work);
		const record = await backendRun(ctx, result, { call: { role: "ask", model }, prompt: "Reply with the single word OK.", cwd: work });
		if (!record.run) return;
		if (ctx.mod.failed(record.run)) return result.fail(`production verdict: failed (${record.run.errorMessage ?? record.run.stopReason})`);
		if (record.read?.reasoningEffort !== null) return result.skip(`the model read back effort ${record.read?.reasoningEffort ?? "none"}: not a null-effort model`);
		result.check(record.run.selection?.effort === undefined, "production verdict success, readback effort null and no effort recorded");
	},

	Q9: async (ctx, result) => {
		const work = path.join(ctx.caseDir("Q9"), "untrusted");
		fs.mkdirSync(work);
		const real = fs.realpathSync(work);
		const mentionedBefore = ctx.configMentions(real);
		const before = tree(work);
		const role = ctx.mod.codexRole({ role: "implement" }, undefined, {});
		const outcome = await withChild(ctx, work, async (child, prepared) => {
			const start = await child.startThread(roleThreadParams(ctx.mod, role));
			result.fact("thread/start", describeStart(start));
			result.fact("sandbox", describeSandbox(start.sandbox));
			const problem = ctx.mod.threadStartProblem(role, start, canonicalPath(start.cwd), canonicalPath(prepared.expectedCwd));
			result.check(problem === undefined, `production start checks pass in an untrusted cwd: workspace-write kept, approval never, cwd bound${problem ? `: ${problem}` : ""}`);
		});
		if (outcome.startError || outcome.thrown) result.fail(`thread/start in the untrusted fixture failed: ${message(outcome.startError ?? outcome.thrown)}`);
		result.check(!mentionedBefore && !ctx.configMentions(real), "config.toml does not name the fixture before or after (no trust entry written)");
		result.check(tree(work) === before, "the fixture cwd is unchanged by thread/start");
		checkShutdown(ctx, result, outcome.exit, "child");
	},
};

// Last, so every class and table above is initialized before the first await reaches them.
process.exitCode = await main(parseArgs(process.argv.slice(2)));
