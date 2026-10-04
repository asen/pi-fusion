import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CodexCall, codexRole } from "../extensions/backends/codex-binding.ts";
import { CODEX_APP_SERVER_ARGS } from "../extensions/backends/codex-launch.ts";
import { CODEX_CONTRACTS_DIR, createCodexBackend } from "../extensions/backends/codex.ts";
import {
	additivity,
	CASES,
	cacheWriteObservation,
	canonicalPath,
	caseStatus,
	composeInstructions,
	describeCounters,
	exitCode,
	forcedExitNotice,
	GROUPS,
	parseArgs,
	reportedCount,
	selectCases,
	threadParams,
	usageCounters,
	usageProblem,
	versionFromUserAgent,
} from "./spikes/codex-app-server-cases.mjs";

/*
 * The manual Codex qualification harness's own safety, tested without Codex: its pure status rules and command line,
 * its guard paths run as a subprocess with a tripwire `codex` on `PATH` and as `PI_FUSION_CODEX_BIN`, and explicit
 * `--fake` runs over `test/fake-codex.mjs` by path. None of this is native evidence; it shows the harness refuses to
 * start anything without `--run`, loads no production module before it, never lets a guard pass a case, and drives
 * the fake through the production transport and backend with its teardown proved.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(repoRoot, "test", "spikes", "codex-app-server.mjs");

/* ------------------------------------------------------------------------------------------------------------------
 * status rules
 * ---------------------------------------------------------------------------------------------------------------- */

test("canonical paths go through symlinks and a missing tail", () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-harness-paths-"));
	try {
		const real = path.join(root, "real");
		fs.mkdirSync(real);
		fs.symlinkSync(real, path.join(root, "link"), "dir");
		assert.equal(canonicalPath(path.join(root, "link")), real);
		assert.equal(canonicalPath(path.join(root, "link", "not", "yet")), path.join(real, "not", "yet"), "a path that does not exist yet resolves through its existing parent");
		assert.equal(canonicalPath(path.join(root, "link", "..", "real")), real);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the exit code says whether anything failed, is unproven, passed or ran at all", () => {
	assert.equal(exitCode(["pass", "skip"]), 0);
	assert.equal(exitCode(["pass", "unproven"]), 1);
	assert.equal(exitCode(["skip", "skip"]), 2, "every case skipped is nothing run");
	assert.equal(exitCode([]), 2);
});

test("guards never pass a case: a case whose own measurements were skipped stays a skip, and a failed guard still fails it", () => {
	assert.equal(caseStatus(["skip"], ["pass", "pass"]), "skip", "config unchanged and a clean shutdown are not a measurement");
	assert.equal(caseStatus([], ["pass"]), "skip");
	assert.equal(caseStatus([], []), "skip");
	assert.equal(caseStatus(["skip"], ["fail"]), "fail");
	assert.equal(caseStatus(["skip"], ["unproven", "pass"]), "unproven");
	assert.equal(caseStatus(["pass", "skip"], ["pass"]), "pass", "an optional leg's skip does not demote a measured pass");
	assert.equal(caseStatus(["pass"], ["fail"]), "fail");
	assert.equal(caseStatus(["pass", "unproven"], ["pass"]), "unproven");
	assert.equal(caseStatus(["unproven"], ["pass", "pass"]), "unproven", "an unproven measurement is not rescued by its guards");
	assert.equal(exitCode([caseStatus(["skip"], ["pass"]), caseStatus(["skip"], ["pass"])]), 2, "guards alone never make exit 0");
});

test("a second interrupt names the retained root and claims nothing about it", () => {
	const notice = forcedExitNotice("/tmp/root");
	assert.match(notice, /without cleanup/);
	assert.ok(notice.includes("retained (uncertain): /tmp/root"));
	assert.equal(notice.match(/retained \(uncertain\)/g)?.length, 1, "the fixture root is the only thing it leaves");
	assert.doesNotMatch(notice, /removed|ended cleanly|no cleanup concern/i, "no claim that anything was cleaned up or is over");
});

/* ------------------------------------------------------------------------------------------------------------------
 * command line and configuration evidence
 * ---------------------------------------------------------------------------------------------------------------- */

test("the command line is strict: both spellings, no valueless or repeated flag, no malformed token, no removed flag, and no default selection", () => {
	assert.deepEqual(parseArgs(["--run", "--case", "Q1", "--model=gpt-x"]), { run: true, fake: false, list: false, help: false, keep: false, unknown: [], problems: [], case: "Q1", model: "gpt-x" });
	assert.deepEqual(parseArgs(["--run", "--case=Q3b", "--effort", "high"]), { run: true, fake: false, list: false, help: false, keep: false, unknown: [], problems: [], case: "Q3b", effort: "high" });
	assert.deepEqual(parseArgs(["--case"]).problems, ["--case needs a value"]);
	assert.deepEqual(parseArgs(["--case", "--run"]).problems, ["--case needs a value"]);
	assert.deepEqual(parseArgs(["--case="]).problems, ["--case needs a value"]);
	assert.deepEqual(parseArgs(["--case", "Q1", "--case=Q2"]).problems, ["--case is given more than once"]);
	assert.deepEqual(parseArgs(["--effort", "very high"]).problems, ["--effort must be one token with no whitespace"]);
	assert.deepEqual(parseArgs(["--model", "a\tb"]).problems, ["--model must be one token with no whitespace"]);
	assert.deepEqual(parseArgs(["--case=Q1", "--bogus", "Q2"]).unknown, ["--bogus", "Q2"]);
	assert.deepEqual(parseArgs(["--outside-dir=/x", "--unsupported-effort", "max", "--null-effort-model=m"]).unknown, ["--outside-dir=/x", "--unsupported-effort", "max", "--null-effort-model=m"], "removed flags are unrecognised, never quietly taken");
	assert.equal(parseArgs([]).case, undefined);
	assert.deepEqual(selectCases("q2,Q1")?.cases?.map((entry) => entry.id), ["Q1", "Q2"]);
	assert.deepEqual(selectCases("model-free")?.cases?.map((entry) => entry.id), ["Q1", "Q2", "Q7", "Q9"]);
	assert.deepEqual(selectCases("all")?.cases?.map((entry) => entry.id), ["Q1", "Q2", "Q3", "Q3b", "Q4", "Q6", "Q7", "Q9", "Q14"]);
	assert.deepEqual(selectCases("q14")?.cases?.map((entry) => entry.id), ["Q14"]);
	assert.deepEqual(Object.keys(GROUPS), ["model-free", "all"]);
	assert.ok(!GROUPS["model-free"]!.includes("Q14"), "Q14 starts turns, so the model-free group leaves it out");
	assert.equal(CASES.find((entry) => entry.id === "Q14")?.model, true);
	assert.deepEqual(CASES.filter((entry) => entry.fake).map((entry) => entry.id), ["Q1", "Q2", "Q4", "Q6", "Q7", "Q9", "Q14"]);
	assert.match(selectCases("Q1,nope").error ?? "", /nope/);
	for (const removed of ["Q5", "Q5b", "Q5c", "Q8", "Q8b"]) assert.match(selectCases(removed).error ?? "", new RegExp(removed), `${removed} is no longer a case`);
	assert.match(selectCases(undefined).error ?? "", /needs/);
	assert.match(selectCases(" ").error ?? "", /needs/);
	assert.ok(CASES.filter((entry) => !entry.model).every((entry) => ["Q1", "Q2", "Q7", "Q9"].includes(entry.id)), "only the model-free group starts no turn");
});

test("version evidence: a version parsed from the user agent, reported and never verified", () => {
	assert.equal(versionFromUserAgent("pi-fusion/0.160.0 (Linux 6.1; x86_64) xterm"), "0.160.0");
	assert.equal(versionFromUserAgent("codex_cli_rs/0.161.0-alpha.2"), "0.161.0-alpha.2");
	assert.equal(versionFromUserAgent("no version here"), undefined);
	assert.equal(versionFromUserAgent(undefined), undefined);
});

/* ------------------------------------------------------------------------------------------------------------------
 * Q14 usage counters
 * ---------------------------------------------------------------------------------------------------------------- */

const breakdown = (input: number, cached: number, output: number, reasoning: number, write?: number | null) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output, ...(write === undefined ? {} : { cacheWriteInputTokens: write }) });
const update = (total: object, last: object, window: unknown = 200_000) => usageCounters({ threadId: "t", turnId: "u", tokenUsage: { total, last, modelContextWindow: window } });
/** One breakdown as Q14 reads it, so a field left out of the literal is `absent`. */
const counts = (raw: object) => update(raw, raw).total;

test("Q14 reads every counter as reported: an absent or null field stays absent or null, never zero", () => {
	assert.equal(reportedCount({ a: 3 }, "a"), 3);
	assert.equal(reportedCount({ a: 0 }, "a"), 0);
	assert.equal(reportedCount({}, "a"), "absent");
	assert.equal(reportedCount({ a: null }, "a"), "null");
	for (const bad of [-1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1, {}]) assert.equal(reportedCount({ a: bad }, "a"), "invalid");
	assert.equal(reportedCount(undefined, "a"), "absent");
	assert.equal(reportedCount(Object.create({ a: 1 }), "a"), "absent", "an inherited key is not reported");
	const counters = update(breakdown(10, 4, 2, 1), breakdown(10, 4, 2, 1, null), null);
	assert.equal(counters.total.cacheWriteInputTokens, "absent");
	assert.equal(counters.last.cacheWriteInputTokens, "null");
	assert.equal(counters.modelContextWindow, "null");
	assert.equal(usageCounters({ tokenUsage: { total: breakdown(1, 0, 1, 0), last: breakdown(1, 0, 1, 0) } }).modelContextWindow, "absent");
	assert.deepEqual(Object.keys(usageCounters({ tokenUsage: { total: { extra: 1, inputTokens: 1 } } }).total), ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens", "cacheWriteInputTokens"], "only the known counters are read");
	assert.equal(usageCounters(null).total.inputTokens, "absent");
	assert.equal(describeCounters(counters.total), "inputTokens=10 cachedInputTokens=4 outputTokens=2 reasoningOutputTokens=1 totalTokens=12 cacheWriteInputTokens=absent");
});

test("Q14 usage is usable only with an update whose total and last carry every required count; an absent cache write or window does not unmake it", () => {
	assert.match(usageProblem([]) ?? "", /no usage update/);
	assert.equal(usageProblem([update(breakdown(10, 0, 1, 0), breakdown(10, 0, 1, 0), null)]), undefined);
	assert.match(usageProblem([update({ ...breakdown(10, 0, 1, 0), outputTokens: null }, breakdown(10, 0, 1, 0))]) ?? "", /total has no count for outputTokens \(null\)/);
	const { inputTokens: _input, ...noInput } = breakdown(10, 0, 1, 0);
	assert.match(usageProblem([update(breakdown(10, 0, 1, 0), noInput)]) ?? "", /last has no count for inputTokens \(absent\)/);
	assert.equal(usageProblem([update(noInput, noInput), update(breakdown(10, 0, 1, 0), breakdown(10, 0, 1, 0))]), undefined, "the latest update is the one read");
});

test("Q14 additivity compares the cumulative total with the previous total plus every last, and says unknown rather than reading a missing count as zero", () => {
	const first = counts(breakdown(1_000, 0, 50, 10));
	const lasts = [counts(breakdown(1_100, 900, 20, 0, 0)), counts(breakdown(1_150, 1_000, 30, 5, 0))];
	const sums = additivity(first, counts(breakdown(3_250, 1_900, 100, 15, 0)), lasts);
	assert.deepEqual(sums.inputTokens, { previous: 1_000, current: 3_250, sumOfLasts: 2_250, holds: "yes" });
	assert.equal(sums.totalTokens!.holds, "yes");
	assert.deepEqual(sums.cacheWriteInputTokens, { previous: "absent", current: 0, sumOfLasts: "unknown", holds: "unknown" }, "an absent count in the first total is not taken for zero");
	// A last repeated by a second update for the same response, or a total that counts more than its responses.
	const repeated = additivity(first, counts(breakdown(2_100, 900, 70, 10, 0)), [lasts[0]!, lasts[0]!]);
	assert.equal(repeated.inputTokens!.holds, "no");
	assert.equal(repeated.inputTokens!.sumOfLasts, 2_200);
	assert.equal(additivity(first, counts(breakdown(2_100, 900, 70, 10)), [counts({ ...breakdown(1_100, 900, 20, 0), outputTokens: null })]).outputTokens!.holds, "unknown");
	assert.equal(additivity(first, first, []).inputTokens!.holds, "yes", "a turn with no lasts holds only when the total did not move");
});

test("Q14 relates cache write to input only from a positive count, and says when the run measures no relation", () => {
	const none = cacheWriteObservation([update(breakdown(10, 0, 1, 0), breakdown(10, 0, 1, 0)), update(breakdown(20, 5, 2, 0, 0), breakdown(10, 5, 1, 0, null))]);
	assert.match(none, /over 4 breakdowns: 0 positive, 1 zero, 2 absent, 1 null, 0 invalid/);
	assert.match(none, /measures no cache-write vs input relation/);
	const some = cacheWriteObservation([update(breakdown(100, 40, 1, 0, 50), breakdown(100, 40, 1, 0, 70))]);
	assert.match(some, /2 positive/);
	assert.match(some, /cached \+ cacheWrite <= input held in 1 of 2 positive breakdowns \(an observation, not proof that cache write is part of input\)/);
});

/* ------------------------------------------------------------------------------------------------------------------
 * the harness as a program
 * ---------------------------------------------------------------------------------------------------------------- */

interface Sandbox {
	root: string;
	tripped: string;
	resolved: string;
	env: Record<string, string>;
}

/**
 * A subprocess environment where any Codex lookup would find a tripwire first: an executable `codex` that only records
 * that it ran, first on `PATH` and named by `PI_FUSION_CODEX_BIN`. HOME and CODEX_HOME name directories that do not
 * exist, so creating either is visible, and a resolve hook preloaded into the harness logs every module it loads.
 */
function sandbox(extraPath: string[] = []): Sandbox {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-harness-cli-"));
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.mkdirSync(path.join(root, "tmp"));
	const tripped = path.join(root, "TRIPPED");
	const codex = path.join(bin, "codex");
	fs.writeFileSync(codex, `#!/bin/sh\necho ran >> '${tripped}'\nexit 99\n`, { mode: 0o755 });
	const resolved = path.join(root, "resolved.log");
	fs.writeFileSync(path.join(root, "resolve-log.mjs"), `import { appendFileSync } from "node:fs";\nimport { registerHooks } from "node:module";\nregisterHooks({ resolve(specifier, context, next) { const found = next(specifier, context); appendFileSync(${JSON.stringify(resolved)}, found.url + "\\n"); return found; } });\n`);
	return {
		root,
		tripped,
		resolved,
		env: {
			PATH: [bin, ...extraPath].join(path.delimiter),
			HOME: path.join(root, "home"),
			CODEX_HOME: path.join(root, "codex-home"),
			PI_FUSION_CODEX_BIN: codex,
			TMPDIR: path.join(root, "tmp"),
			LANG: "C",
		},
	};
}

function harness(box: Sandbox, args: string[], timeout = 15_000) {
	return spawnSync(process.execPath, ["--import", pathToFileURL(path.join(box.root, "resolve-log.mjs")).href, HARNESS, ...args], { env: box.env, encoding: "utf8", timeout });
}

const loaded = (box: Sandbox): string[] => (fs.existsSync(box.resolved) ? fs.readFileSync(box.resolved, "utf8").split("\n").filter(Boolean) : []);

test("every guard path exits 2 having loaded no production module, located no codex and touched no Codex home", () => {
	const box = sandbox();
	try {
		for (const args of [
			[],
			["--help"],
			["-h"],
			["--list"],
			["--bogus"],
			["--case", "Q1"],
			["--fake", "--case", "Q1"],
			["--case", "Q14"],
			["--fake", "--case", "Q14"],
			["--list", "--run", "--fake", "--case", "Q14"],
			["--run"],
			["--run", "--case"],
			["--run", "--case", "nope"],
			["--run", "--case", "Q5"],
			["--run", "--case", "Q8b"],
			["--run", "--case=Q1", "--model"],
			["--run", "--case", "all", "--effort", "a b"],
			["--run", "--case", "Q6", "--outside-dir", "/dev/shm"],
			["--run", "--case", "Q3b", "--unsupported-effort=max"],
			["--run", "--fake", "--case", "Q1", "--null-effort-model", "m"],
			["--list", "--run", "--case", "all"],
		]) {
			fs.rmSync(box.resolved, { force: true });
			const ran = harness(box, args);
			assert.equal(ran.status, 2, `${JSON.stringify(args)} exits 2\n${ran.stdout}${ran.stderr}`);
			assert.equal(ran.stderr, "", `${JSON.stringify(args)} writes nothing to stderr`);
			const modules = loaded(box);
			assert.ok(modules.some((url) => url.endsWith("/codex-app-server-cases.mjs")), "the resolve log is live");
			assert.deepEqual(modules.filter((url) => url.includes("/extensions/")), [], `${JSON.stringify(args)} loads no production module`);
		}
		assert.match(harness(box, ["--run"]).stdout, /--case needs/);
		assert.match(harness(box, []).stdout, /nothing runs without --run[\s\S]*USD unknown/);
		const list = harness(box, ["--list"]).stdout;
		assert.deepEqual(
			[...list.matchAll(/^ {2}(Q\S+) /gm)].map((match) => match[1]),
			["Q1", "Q2", "Q3", "Q3b", "Q4", "Q6", "Q7", "Q9", "Q14"],
			"--list names the nine cases",
		);
		assert.match(list, /Q6 +\[model\] \[fake\][\s\S]*model-free/);
		assert.match(list, /Q14 +\[model\] \[fake\] usage over two sequential turns/);
		assert.match(list, /model-free +Q1, Q2, Q7, Q9\n/, "the model-free group lists no model case");
		assert.match(list, /G1 needs Q1, Q2, Q3, Q4, Q6, Q7 and Q9 to PASS natively; Q3b is optional/);
		assert.match(list, /Q14 is stage 2 preparation, a usage measurement outside G1; G2 is not enabled/);
		assert.match(harness(box, ["--run", "--case", "Q1", "--outside-dir", "/dev/shm"]).stdout, /unrecognised argument: --outside-dir/);
		assert.ok(!fs.existsSync(box.tripped), "no codex ran");
		assert.ok(!fs.existsSync(box.env.CODEX_HOME!) && !fs.existsSync(box.env.HOME!), "no Codex home or home was created");
		assert.deepEqual(fs.readdirSync(box.env.TMPDIR!), [], "no fixture root was made");
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

/** A command's directory on the inherited PATH, found the way a shell would: git for the fake run's fixture repositories, ps for the owned cleanup's discovery. */
function commandDirectory(name: string): string | undefined {
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!entry) continue;
		try {
			fs.accessSync(path.join(entry, name), fs.constants.X_OK);
			return entry;
		} catch {}
	}
	return undefined;
}

const gitDirectory = (): string | undefined => commandDirectory("git");

test("an explicit --fake run drives the fake by path through the production transport and backend, labelled NOT NATIVE, and removes its root", { timeout: 55_000 }, (t) => {
	const gitDir = gitDirectory();
	if (!gitDir) return t.skip("no git on PATH for the fixture repositories");
	// The tripwire's directory comes first, so a lookup of `codex` would find it before anything in git's directory.
	const box = sandbox([gitDir]);
	try {
		const ran = harness(box, ["--run", "--fake", "--case", "Q1,Q2,Q3,Q4,Q6,Q7,Q9", "--model", "gpt-explicit"], 50_000);
		const out = ran.stdout;
		assert.equal(ran.status, 0, `${out}\n${ran.stderr}`);
		assert.match(out, /NOT NATIVE EVIDENCE/);
		const results = out.split("\n").filter((line) => line.includes("RESULT "));
		assert.equal(results.length, 7);
		assert.ok(results.every((line) => line.endsWith("[FAKE, NOT NATIVE]")), "every result says it is not native");
		for (const id of ["Q1", "Q2", "Q4", "Q6", "Q7", "Q9"]) assert.match(out, new RegExp(`RESULT ${id}: pass`));
		assert.match(out, /RESULT Q3: skip \(needs a native child/);
		assert.match(out, /implement, explicit model gpt-explicit: thread\/start: thread=\S+ model=gpt-explicit/);
		assert.match(out, /reported sandbox: type=readOnly/);
		assert.match(out, /cancelled when: the turn was admitted \(fake\)/);
		assert.match(out, /child's own turn completion: interrupted/);
		assert.match(out, /PASS production verdict: aborted/);
		assert.match(out, /PASS the child's actual exit report says the host requested the stop/);
		assert.match(out, /PASS \(guard\) child: owned shutdown clean \(clean actual exit, no leftovers, discovery ok, pipes closed, a requested abort allowed\)/);
		assert.match(out, /hosted search items \(observed, not gating\): 0 webSearch/);
		assert.match(out, /cost=unknown/);
		assert.match(out, /exit 0 \[FAKE, NOT NATIVE\]/);
		const modules = loaded(box);
		assert.ok(modules.some((url) => url.endsWith("/extensions/backends/codex.ts")) && modules.some((url) => url.endsWith("/extensions/backends/codex-transport.ts")), "the production backend and transport were loaded");
		assert.ok(!modules.some((url) => url.endsWith("/extensions/fusion.ts")), "the host runtime takes no part");
		assert.ok(!fs.existsSync(box.tripped), "no codex ran: the fake was launched by path");
		assert.ok(!fs.existsSync(box.env.CODEX_HOME!), "the inherited CODEX_HOME was neither created nor used");
		assert.deepEqual(fs.readdirSync(box.env.TMPDIR!), [], "the fixture root was removed once every child was proved over");
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

test("a child that is not proved over keeps the fixtures whichever case branch returns, and the run is not reported clean", { timeout: 55_000 }, (t) => {
	const gitDir = gitDirectory();
	if (!gitDir) return t.skip("no git on PATH for the fixture repositories");
	const box = sandbox([gitDir]);
	try {
		// The fake's own seam: every fake child exits 3 when stdin ends, an unclean actual exit with no other concern.
		const ran = harness({ ...box, env: { ...box.env, FAKE_CODEX_EXIT_CODE: "3" } }, ["--run", "--fake", "--case", "Q1,Q4,Q7"], 50_000);
		const out = ran.stdout;
		assert.equal(ran.status, 1, `${out}\n${ran.stderr}`);
		for (const id of ["Q1", "Q4", "Q7"]) assert.match(out, new RegExp(`RESULT ${id}: fail`));
		assert.match(out, /FAIL \(guard\) child: owned shutdown clean/);
		assert.match(out, /\nkept: /);
		assert.doesNotMatch(out, /\nremoved: /, "no caption claims a clean cleanup");
		assert.equal(fs.readdirSync(box.env.TMPDIR!).filter((name) => name.startsWith("pi-fusion-codex-qual-")).length, 1, "the fixture root was retained");
		assert.ok(!fs.existsSync(box.tripped));

		// An early return: the thread/start answer fails production's checks, so Q6 never reaches its cancellation point
		// and returns unproven before its own checks — and the unclean exit is still reported and still keeps the root.
		const early = harness({ ...box, env: { ...box.env, FAKE_CODEX_EXIT_CODE: "3", FAKE_CODEX_SCENARIO: "wrong-start" } }, ["--run", "--fake", "--case", "Q6"], 50_000);
		assert.equal(early.status, 1, `${early.stdout}\n${early.stderr}`);
		assert.match(early.stdout, /UNPROVEN the cancellation point never came: no turn was admitted/);
		assert.match(early.stdout, /FAIL \(guard\) child: owned shutdown clean/);
		assert.match(early.stdout, /RESULT Q6: fail/);
		assert.match(early.stdout, /\nkept: .*Q6: child is not proved over/);
		assert.doesNotMatch(early.stdout, /\nremoved: /);
		assert.equal(fs.readdirSync(box.env.TMPDIR!).filter((name) => name.startsWith("pi-fusion-codex-qual-")).length, 2, "the second root was retained too");
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

test("the body the model-free cases send is the body createCodexBackend sends, contracts included, over the fenced fake", async () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-harness-parity-"));
	const work = path.join(root, "work");
	const home = path.join(root, "codex-home");
	fs.mkdirSync(work);
	const log = path.join(root, "requests.log");
	try {
		const calls: CodexCall[] = [{ role: "implement" }, { role: "ask", mode: "answer" }, { role: "ask", mode: "review" }, { role: "implement", model: "gpt-explicit" }, { role: "ask", effort: "high" }];
		for (const call of calls) {
			fs.rmSync(log, { force: true });
			const backend = createCodexBackend({
				env: { FAKE_CODEX_SCENARIO: "ok", FAKE_CODEX_LOG: log, CODEX_HOME: home },
				launch: (request) => ({
					launch: { command: process.execPath, args: ["--import", pathToFileURL(path.join(repoRoot, "test", "sdk-fence.mjs")).href, path.join(repoRoot, "test", "fake-codex.mjs"), ...CODEX_APP_SERVER_ARGS], cwd: request.cwd, env: { ...request.env } },
					executable: { command: process.execPath, prefix: [], path: "fake", source: "override" },
					expectedCwd: fs.realpathSync(request.cwd),
					expectedCodexHome: home,
				}),
				cleanup: { exitGraceMs: 800, stopGraceMs: 1_000, leftoverGraceMs: 200, pipeGraceMs: 500, tableTimeoutMs: 3_000 },
				bounds: { initializeMs: 10_000, requestMs: 10_000, shutdownStepMs: 1_500 },
			});
			const role = codexRole(call, undefined, {});
			const run = await backend.run({ role, prompt: "do the task", cwd: work, session: backend.session({ kind: "new" }), signal: undefined, input: backend.control(), onProgress: () => {} });
			assert.equal(run.stopReason, "stop", run.errorMessage);
			const sent = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.in?.method).map((entry) => entry.in);
			const thread = sent.find((message) => message.method === "thread/start");
			const turn = sent.find((message) => message.method === "turn/start");
			const harnessBody = threadParams(role, composeInstructions(role, (name) => fs.readFileSync(path.join(CODEX_CONTRACTS_DIR, name), "utf8")));
			assert.deepEqual(thread.params, harnessBody, `${JSON.stringify(call)}: the harness's thread/start body is the backend's, byte for byte`);
			assert.ok(!("cwd" in thread.params) && !("config" in thread.params));
			assert.deepEqual(Object.keys(turn.params).sort(), call.effort === undefined ? ["input", "threadId"] : ["effort", "input", "threadId"], "turn/start names only the thread, the input and a named effort");
			assert.equal(turn.params.effort, call.effort);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an explicit --fake Q14 runs two turns on one thread through the production transport, prints every counter, and passes NOT NATIVE", { timeout: 30_000 }, (t) => {
	const psDir = commandDirectory("ps");
	if (!psDir) return t.skip("no ps on PATH for the owned cleanup's discovery");
	const box = sandbox([psDir]);
	const log = path.join(box.root, "fake-requests.log");
	try {
		const ran = harness({ ...box, env: { ...box.env, FAKE_CODEX_LOG: log } }, ["--run", "--fake", "--case", "Q14"], 25_000);
		const out = ran.stdout;
		assert.equal(ran.status, 0, `${out}\n${ran.stderr}`);
		assert.match(out, /NOT NATIVE EVIDENCE/);
		assert.match(out, /evidence: the fake's literal counters: NOT NATIVE/);
		assert.match(out, /RESULT Q14: pass \[FAKE, NOT NATIVE\]/);
		for (const turn of [1, 2]) {
			assert.match(out, new RegExp(`PASS turn ${turn}: the child's own turn/completed says completed`));
			assert.match(out, new RegExp(`PASS turn ${turn}: the thread reads back idle after the turn`));
			assert.match(out, new RegExp(`PASS turn ${turn}: usable usage counters`));
		}
		assert.match(out, /turn 1: update 1 total: inputTokens=1000 cachedInputTokens=0 outputTokens=50 reasoningOutputTokens=10 totalTokens=1050 cacheWriteInputTokens=absent/);
		assert.match(out, /turn 2: usage updates: 2 scoped to this thread and turn/);
		assert.match(out, /turn 2: update 2 last: .*cacheWriteInputTokens=0 modelContextWindow=200000/);
		assert.match(out, /turn 1: completed items: agentMessage=1 reasoning=1 .*not model responses/);
		assert.match(out, /turn 2: completed items: agentMessage=2 reasoning=2/);
		assert.match(out, /PASS two turns admitted on the one owned thread, under distinct turn ids/);
		assert.match(out, /additivity inputTokens: turn 2 total 3250 vs turn 1 total 1000 \+ turn 2 lasts 2250: yes/);
		assert.match(out, /additivity cacheWriteInputTokens: .*: unknown/);
		assert.match(out, /no positive cache write was reported, so this run measures no cache-write vs input relation/);
		assert.match(out, /additivity: observed, not required: a `no` or `unknown` is evidence of how the counters behaved/);
		assert.match(out, /malformed items: 0 seen by the harness on any thread, 0 by the transport/);
		assert.match(out, /cost: unknown/);
		assert.match(out, /PASS \(guard\) child: owned shutdown clean/);
		assert.doesNotMatch(out, /OK again|working/, "no model prose is printed");
		const sent = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.in?.method).map((entry) => entry.in);
		const starts = sent.filter((message) => message.method === "turn/start");
		assert.equal(starts.length, 2, "the fake was asked for two turns");
		assert.equal(new Set(starts.map((message) => message.params.threadId)).size, 1, "both on one thread");
		assert.equal(sent.filter((message) => message.method === "thread/start").length, 1);
		const modules = loaded(box);
		assert.ok(modules.some((url) => url.endsWith("/extensions/backends/codex-transport.ts")), "the production transport was loaded");
		assert.ok(!modules.some((url) => url.endsWith("/extensions/fusion.ts")), "the host runtime takes no part");
		assert.ok(!fs.existsSync(box.tripped), "no codex ran: the fake was launched by path");
		assert.ok(!fs.existsSync(box.env.CODEX_HOME!), "the inherited CODEX_HOME was neither created nor used");
		assert.deepEqual(fs.readdirSync(box.env.TMPDIR!), [], "the fixture root was removed once the child was proved over");
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

test("a --fake Q14 whose turns report no usage is UNPROVEN however cleanly its guards hold", { timeout: 30_000 }, (t) => {
	const psDir = commandDirectory("ps");
	if (!psDir) return t.skip("no ps on PATH for the owned cleanup's discovery");
	const box = sandbox([psDir]);
	try {
		const ran = harness({ ...box, env: { ...box.env, FAKE_CODEX_SCENARIO: "no-usage" } }, ["--run", "--fake", "--case", "Q14"], 25_000);
		const out = ran.stdout;
		assert.equal(ran.status, 1, `${out}\n${ran.stderr}`);
		assert.match(out, /UNPROVEN turn 1: usage is not usable: no usage update named this turn/);
		assert.match(out, /PASS \(guard\) child: owned shutdown clean/);
		assert.match(out, /RESULT Q14: unproven \(turn 1: usage is not usable/);
		assert.doesNotMatch(out, /additivity inputTokens/, "no additivity is computed from missing usage");
		assert.ok(!fs.existsSync(box.tripped));
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

test("a --fake Q14 whose usage update the production reader rejects (cached input above input) FAILs with the reader's fixed reason and prints no counter from it", { timeout: 30_000 }, (t) => {
	const psDir = commandDirectory("ps");
	if (!psDir) return t.skip("no ps on PATH for the owned cleanup's discovery");
	const box = sandbox([psDir]);
	try {
		// The fake's `bad-usage` turn reports inputTokens 10 with cachedInputTokens 20, and nothing after it.
		const ran = harness({ ...box, env: { ...box.env, FAKE_CODEX_SCENARIO: "bad-usage" } }, ["--run", "--fake", "--case", "Q14"], 25_000);
		const out = ran.stdout;
		assert.equal(ran.status, 1, `${out}\n${ran.stderr}`);
		assert.match(out, /turn 1: turn=\S+ outcome=transport completion=\S+ failure=protocol/);
		assert.match(out, /turn 1: protocol failure: the codex app-server sent something this transport cannot read: a usage update carries a breakdown that is not one\n/);
		assert.match(out, /turn 1: limit: a notification the production reader rejects, a malformed usage update among them, ends the child before the harness's listener runs/);
		assert.match(out, /FAIL turn 1: the child's own turn\/completed says completed/);
		assert.match(out, /turn 1: usage updates: 0 scoped/);
		assert.doesNotMatch(out, /update 1 (total|last)|inputTokens=|additivity inputTokens/, "no counter from the rejected update, and no additivity");
		assert.doesNotMatch(out, /turn 2/, "no second turn after a failed first");
		assert.match(out, /RESULT Q14: fail/);
		assert.doesNotMatch(out, /RESULT Q14: (pass|unproven)/);
		assert.ok(!fs.existsSync(box.tripped));
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

test("a case skipped for a missing option, or for needing a native child, stays SKIP with its reason after its guards pass", { timeout: 30_000 }, () => {
	const box = sandbox();
	try {
		const ran = harness(box, ["--run", "--fake", "--case", "Q3,Q3b"], 25_000);
		const out = ran.stdout;
		assert.equal(ran.status, 2, `nothing was measured, so nothing ran: ${out}\n${ran.stderr}`);
		assert.match(out, /RESULT Q3: skip \(needs a native child/);
		assert.match(out, /RESULT Q3b: skip \(no --effort given/);
		assert.equal((out.match(/PASS \(guard\) config\.toml bytes unchanged/g) ?? []).length, 1, "the option case ran to its skip with the configuration guard around it");
		assert.match(out, /\n {2}Q3b {2}skip - no --effort given/);
		assert.doesNotMatch(out, /RESULT \S+: pass/);
		assert.match(out, /exit 2 \[FAKE, NOT NATIVE\]/);
		assert.ok(!fs.existsSync(box.tripped));
		const flagged = harness(box, ["--run", "--fake", "--case", "Q3b", "--effort", "high"], 25_000);
		assert.equal(flagged.status, 2);
		assert.match(flagged.stdout, /RESULT Q3b: skip \(needs a native child/, "given its option, the case needs a native child");
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});
