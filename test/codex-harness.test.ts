import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CodexCall, codexRole } from "../extensions/backends/codex-binding.ts";
import { CODEX_APP_SERVER_ARGS } from "../extensions/backends/codex-launch.ts";
import { CODEX_CONTRACTS_DIR, createCodexBackend } from "../extensions/backends/codex.ts";
import {
	CASES,
	canonicalPath,
	classifyNetwork,
	caseStatus,
	boundedUtf8,
	classifyWrite,
	combine,
	composeInstructions,
	exitCode,
	expectNetwork,
	expectWrite,
	type Expectation,
	forcedExitNotice,
	formatProbeReport,
	identifyProbe,
	type LoopbackControl,
	networkVerdict,
	type Observation,
	type OutsideCandidate,
	parseArgs,
	pickOutside,
	probeAfter,
	type ProbeProc,
	probeItems,
	probeReport,
	probeVerdict,
	PROBE_OUTPUT_MAX_BYTES,
	PROBE_REPORT_MAX_BYTES,
	Q5_NO_DENIAL,
	q5Verdict,
	readPidText,
	readProbeReport,
	type ReportedSandbox,
	sameProbeCommand,
	selectCases,
	shellWords,
	startTimeOf,
	type Status,
	threadParams,
	topLevelWebSearch,
	versionFromUserAgent,
	within,
	writeGrants,
} from "./spikes/codex-app-server-cases.mjs";

/*
 * The manual Codex qualification harness's own safety, tested without Codex: its pure policy oracle and command line,
 * its guard paths run as a subprocess with a tripwire `codex` on `PATH` and as `PI_FUSION_CODEX_BIN`, and one explicit
 * `--fake` run over `test/fake-codex.mjs` by path. None of this is native evidence; it shows the harness refuses to
 * start anything without `--run`, loads no production module before it, judges probes by the reported policy, and
 * drives the fake through the production transport and backend with its teardown proved.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(repoRoot, "test", "spikes", "codex-app-server.mjs");
const PROBE = path.join(repoRoot, "test", "spikes", "codex-app-server-probe.mjs");
const same = (file: string) => file;

/* ------------------------------------------------------------------------------------------------------------------
 * the policy oracle
 * ---------------------------------------------------------------------------------------------------------------- */

const WORKSPACE: ReportedSandbox = { type: "workspaceWrite", networkAccess: false, writableRoots: ["/data/a"], excludeSlashTmp: false, excludeTmpdirEnvVar: false };
/** `null` is an environment with no TMPDIR; left out, the environment names `/var/tmpx`. */
const decide = (sandbox: ReportedSandbox | undefined, target: string, tmpdirEnv: string | null = "/var/tmpx"): Expectation => expectWrite(writeGrants(sandbox, { cwd: "/work", ...(tmpdirEnv === null ? {} : { tmpdirEnv }), canonical: same }), target, same);
const expected = (sandbox: ReportedSandbox | undefined, target: string, tmpdirEnv?: string | null) => {
	const decision = decide(sandbox, target, tmpdirEnv);
	return decision.applicable ? decision.expected : "not applicable";
};

test("the oracle grants the cwd, explicit roots and the implicit /tmp and TMPDIR the reported policy does not exclude, by path segment", () => {
	assert.equal(expected(WORKSPACE, "/work/file"), "permit");
	assert.equal(expected(WORKSPACE, "/work"), "permit");
	assert.equal(expected(WORKSPACE, "/data/a/b"), "permit");
	assert.equal(expected(WORKSPACE, "/data/ab"), "deny", "a sibling sharing a prefix is not under the root");
	assert.equal(expected(WORKSPACE, "/workshop/file"), "deny");
	assert.equal(expected(WORKSPACE, "/tmp/x"), "permit", "an outside-the-fixture sibling under /tmp is granted, not a false denial");
	assert.equal(expected(WORKSPACE, "/var/tmpx/y"), "permit");
	assert.equal(expected(WORKSPACE, "/dev/shm/x"), "deny");
	assert.equal(expected(WORKSPACE, "/work/.git/HEAD"), "not applicable", "protected subpaths are not modelled");
	assert.match((decide(WORKSPACE, "/data/a/b") as { reason: string }).reason, /explicit writable root/);
});

test("an exclusion removes an implicit temp grant and never an explicit root over the same place", () => {
	const excluded: ReportedSandbox = { ...WORKSPACE, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
	assert.equal(expected(excluded, "/tmp/x"), "deny");
	assert.equal(expected(excluded, "/var/tmpx/y"), "deny");
	const kept: ReportedSandbox = { ...excluded, writableRoots: ["/tmp/keep", "/var/tmpx"] };
	assert.equal(expected(kept, "/tmp/keep/x"), "permit");
	assert.equal(expected(kept, "/tmp/other"), "deny");
	assert.equal(expected(kept, "/var/tmpx/y"), "permit");
	assert.equal(expected(WORKSPACE, "/var/tmpx/y", null), "deny", "no TMPDIR in the environment is no TMPDIR grant");
	assert.equal(expected(WORKSPACE, "/var/tmpx/y", "relative/tmp"), "deny", "a relative TMPDIR grants nothing here");
});

test("a field the answer left out is unknown: the probes it would decide are not applicable, never judged as [] or false", () => {
	const { writableRoots: _roots, ...noRoots } = WORKSPACE;
	assert.equal(expected(noRoots, "/work/file"), "permit", "the cwd is granted whatever the roots are");
	assert.equal(expected(noRoots, "/dev/shm/x"), "not applicable");
	assert.match((decide(noRoots, "/dev/shm/x") as { reason: string }).reason, /writableRoots was not reported/);
	const { excludeSlashTmp: _slash, ...noSlash } = WORKSPACE;
	assert.equal(expected(noSlash, "/tmp/x"), "not applicable");
	assert.equal(expected(noSlash, "/dev/shm/x"), "deny", "an unknown /tmp flag decides nothing outside /tmp");
	const { excludeTmpdirEnvVar: _tmpdir, ...noTmpdir } = WORKSPACE;
	assert.equal(expected(noTmpdir, "/var/tmpx/y"), "not applicable");
	assert.equal(expected(noTmpdir, "/var/tmpx/y", null), "deny", "with no TMPDIR set, its flag decides nothing");
});

test("other sandbox tags: read-only denies, full access permits, and an unknown or missing policy is not applicable", () => {
	assert.equal(expected({ type: "readOnly", networkAccess: false }, "/work/file"), "deny");
	assert.equal(expected({ type: "dangerFullAccess" }, "/anywhere"), "permit");
	assert.equal(expected({ type: "externalSandbox" }, "/work/file"), "not applicable");
	assert.equal(expected(undefined, "/work/file"), "not applicable");
	assert.deepEqual(expectNetwork({ type: "workspaceWrite", networkAccess: false }), { applicable: true, expected: "blocked", reason: "networkAccess is false" });
	assert.deepEqual(expectNetwork({ type: "workspaceWrite", networkAccess: true }), { applicable: true, expected: "reach", reason: "networkAccess is true" });
	assert.equal(expectNetwork({ type: "workspaceWrite" }).applicable, false);
	assert.equal(expectNetwork(undefined).applicable, false);
});

test("canonical paths go through symlinks and a missing tail, and containment is by segment", () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-harness-paths-"));
	try {
		const real = path.join(root, "real");
		fs.mkdirSync(real);
		fs.symlinkSync(real, path.join(root, "link"), "dir");
		assert.equal(canonicalPath(path.join(root, "link")), real);
		assert.equal(canonicalPath(path.join(root, "link", "not", "yet")), path.join(real, "not", "yet"), "a target that does not exist yet resolves through its existing parent");
		assert.equal(canonicalPath(path.join(root, "link", "..", "real")), real);
		const granted = writeGrants({ type: "workspaceWrite", writableRoots: [], excludeSlashTmp: true, excludeTmpdirEnvVar: true }, { cwd: path.join(root, "link") });
		assert.deepEqual(expectWrite(granted, path.join(real, "x")), { applicable: true, expected: "permit", reason: "granted by cwd" }, "a cwd reported through a symlink still grants its realpath");
		assert.equal((expectWrite(granted, `${real}2/x`) as { expected?: string }).expected, "deny");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.ok(within("/a/b", "/a"));
	assert.ok(within("/a", "/a"));
	assert.ok(!within("/ab", "/a"));
	assert.ok(!within("/a/../b", "/a/x"));
	assert.ok(!within("/", "/a"));
	assert.ok(within("/a/..b", "/a"), "a name starting with two dots is still inside");
});

/* ------------------------------------------------------------------------------------------------------------------
 * probe evidence
 * ---------------------------------------------------------------------------------------------------------------- */

const PROBE_CMD = (verb: string, ...args: string[]) => ["'/usr/bin/node'", "'/fx/probe/probe.mjs'", verb, ...args].join(" ");
const WRITE_CMD = PROBE_CMD("write", "'/fx/target.txt'", "tok-1");

test("only a command item that is word for word the probe's own command is evidence, in its direct or one shell-wrapper form", () => {
	assert.deepEqual(shellWords(WRITE_CMD), ["/usr/bin/node", "/fx/probe/probe.mjs", "write", "/fx/target.txt", "tok-1"]);
	assert.deepEqual(shellWords(`a "b c" d\\ e`), ["a", "b c", "d e"]);
	for (const refused of ["a; b", "a | b", "a && b", "echo $HOME", 'echo "$(id)"', "a > b", "a\nb", "'open", "a `b`"]) assert.equal(shellWords(refused), undefined, refused);
	assert.ok(sameProbeCommand(WRITE_CMD, WRITE_CMD));
	assert.ok(sameProbeCommand("/usr/bin/node /fx/probe/probe.mjs write /fx/target.txt tok-1", WRITE_CMD), "requoting is the same argv");
	assert.ok(sameProbeCommand(`bash -lc "${WRITE_CMD}"`, WRITE_CMD));
	assert.ok(sameProbeCommand(`/bin/sh -c "/usr/bin/node /fx/probe/probe.mjs write /fx/target.txt tok-1"`, WRITE_CMD));
	assert.ok(sameProbeCommand(["/bin/bash", "-lc", WRITE_CMD], WRITE_CMD), "an argv array in the wrapper form");
	assert.ok(sameProbeCommand(["/usr/bin/node", "/fx/probe/probe.mjs", "write", "/fx/target.txt", "tok-1"], WRITE_CMD));
	for (const imitation of [
		"echo tok-1",
		"tok-1",
		`curl http://127.0.0.1:1/tok-1`,
		`bash -lc "echo tok-1; exit 10"`,
		`bash -lc "${WRITE_CMD}; echo done"`,
		`bash -lc "${WRITE_CMD} extra"`,
		PROBE_CMD("write", "'/fx/other.txt'", "tok-1"),
		PROBE_CMD("net", "'/fx/target.txt'", "tok-1"),
		["/usr/bin/node", "/elsewhere/probe.mjs", "write", "/fx/target.txt", "tok-1"].join(" "),
		`python3 -c "print('tok-1')"`,
		`fish -c "${WRITE_CMD}"`,
		`bash -lc "bash -lc '${WRITE_CMD}'"`,
	]) assert.equal(sameProbeCommand(imitation, WRITE_CMD), false, imitation);
});

test("probe evidence is the exact command item's status and exit and the fixture's state, scoped to the primary turn; token-only commands never count", () => {
	const scope = { threadId: "thr-1", turnId: "turn-1" };
	const item = (command: unknown, extra: Record<string, unknown> = {}, ids = scope) => ({ method: "item/completed", params: { ...ids, item: { type: "commandExecution", id: "c", command, status: "completed", exitCode: 0, aggregatedOutput: "secret output", ...extra } } });
	const notes = [
		item(WRITE_CMD),
		item(`bash -lc "${WRITE_CMD}"`, { status: "failed", exitCode: 10 }),
		item(WRITE_CMD, {}, { threadId: "thr-sub", turnId: "turn-sub" }),
		item(PROBE_CMD("write", "'/fx/target.txt'", "tok-2")),
		{ method: "item/started", params: { ...scope, item: { type: "commandExecution", command: WRITE_CMD } } },
		{ method: "item/completed", params: { ...scope, item: { type: "agentMessage", text: "tok-1" } } },
	];
	assert.deepEqual(probeItems(notes, WRITE_CMD, "tok-1", scope), { items: [{ status: "completed", exitCode: 0 }, { status: "failed", exitCode: 10 }], unrecognised: 0 }, "another thread, another token, a started item and prose are not evidence; output is never kept");

	// An imitation that carries the token, even with the denial exit code, is never a denial and taints the probe.
	const imitated = probeItems([item("echo tok-1; exit 10", { status: "failed", exitCode: 10 })], WRITE_CMD, "tok-1", scope);
	assert.deepEqual(imitated, { items: [], unrecognised: 1 });
	assert.equal(classifyWrite(imitated, { exists: false }, "tok-1").observed, "inconclusive");
	assert.equal(classifyNetwork(probeItems([item("curl http://127.0.0.1:9/tok-1", { exitCode: 10, status: "failed" })], PROBE_CMD("net", "http://127.0.0.1:9/tok-1"), "tok-1", scope), 0).observed, "inconclusive");
	const mixed = probeItems([item(WRITE_CMD), item("echo tok-1 > /fx/target.txt")], WRITE_CMD, "tok-1", scope);
	assert.equal(classifyWrite(mixed, { exists: true, content: "tok-1\n" }, "tok-1").observed, "inconclusive", "the file may be the imitation's doing");

	const only = (...items: { status?: string; exitCode: number | null }[]) => ({ items, unrecognised: 0 });
	assert.equal(classifyWrite(only(), { exists: false }, "tok").observed, "not-run");
	assert.equal(classifyWrite(only({ status: "declined", exitCode: null }), { exists: false }, "tok").observed, "declined");
	assert.equal(classifyWrite(only({ status: "completed", exitCode: 0 }), { exists: true, content: "tok\n" }, "tok").observed, "permit");
	assert.equal(classifyWrite(only({ status: "failed", exitCode: 10 }), { exists: false }, "tok").observed, "deny");
	assert.equal(classifyWrite(only({ status: "completed", exitCode: 0 }), { exists: false }, "tok").observed, "inconclusive", "a zero exit with no file is not a write");
	assert.equal(classifyWrite(only({ status: "failed", exitCode: 11 }), { exists: false }, "tok").observed, "inconclusive", "an error that is not an operating-system refusal is not a denial");
	assert.equal(classifyWrite(only({ status: "failed", exitCode: 10 }), { exists: true, content: "other" }, "tok").observed, "inconclusive");
	assert.equal(classifyNetwork(only({ status: "completed", exitCode: 0 }), 1).observed, "reach");
	assert.equal(classifyNetwork(only({ status: "failed", exitCode: 10 }), 0).observed, "blocked");
	assert.equal(classifyNetwork(only({ status: "failed", exitCode: 11 }), 0).observed, "inconclusive", "a connection error is not assumed to be the sandbox");
	assert.equal(classifyNetwork(only({ status: "completed", exitCode: 0 }), 0).observed, "inconclusive", "a zero exit the listener never saw is not reach");
	assert.equal(classifyNetwork(only(), 0).observed, "not-run");
});

test("a probe's own report is logged from its single exact item as verb, ok and an error-code token only, and never changes a verdict", () => {
	const scope = { threadId: "thr-1", turnId: "turn-1" };
	const item = (command: unknown, extra: Record<string, unknown> = {}, ids = scope) => ({ method: "item/completed", params: { ...ids, item: { type: "commandExecution", id: "c", command, status: "failed", exitCode: 11, ...extra } } });
	const report = (output: unknown) => item(WRITE_CMD, { aggregatedOutput: output });
	const enoent = `${JSON.stringify({ probe: "write", ok: false, code: "ENOENT" })}\n`;

	// Exit 11 with ENOENT is displayed, but the write is still inconclusive and Q5 still unproven.
	const notes = [report(enoent)];
	const line = probeReport(notes, WRITE_CMD, "write", scope);
	assert.equal(line, "probe=write ok=false code=ENOENT (the probe's own output; diagnostic only, not evidence)");
	const match = probeItems(notes, WRITE_CMD, "tok-1", scope);
	assert.deepEqual(match, { items: [{ status: "failed", exitCode: 11 }], unrecognised: 0 }, "the match still keeps no output");
	const observation = classifyWrite(match, { exists: false }, "tok-1");
	assert.equal(observation.observed, "inconclusive");
	const verdict = probeVerdict({ applicable: true, expected: "deny", reason: "outside" }, observation);
	assert.equal(verdict.status, "unproven");
	const ok = { sandboxType: "workspaceWrite", approvals: 0 };
	const inside = { name: "inside", observation: { observed: "permit" as const, detail: "" }, verdict: { status: "pass" as Status, why: "" } };
	assert.equal(q5Verdict([inside, { name: "outside", observation, verdict }], ok).status, "unproven");

	// Exit 10 EACCES with the target absent stays a denial; a report never makes or unmakes one.
	const eacces = [report(JSON.stringify({ probe: "write", ok: false, code: "EACCES" }))].map((note) => ({ ...note, params: { ...note.params, item: { ...note.params.item, exitCode: 10 } } }));
	assert.match(probeReport(eacces, WRITE_CMD, "write", scope), /^probe=write ok=false code=EACCES /);
	assert.equal(classifyWrite(probeItems(eacces, WRITE_CMD, "tok-1", scope), { exists: false }, "tok-1").observed, "deny");
	assert.equal(classifyWrite(probeItems([item(WRITE_CMD, { exitCode: 10 })], WRITE_CMD, "tok-1", scope), { exists: false }, "tok-1").observed, "deny", "no report is not evidence either way");

	// No output, no exact item, or more than one exact item: nothing is read.
	assert.equal(probeReport([item(WRITE_CMD)], WRITE_CMD, "write", scope), "none captured (the item carried no output)");
	assert.equal(probeReport([report("")], WRITE_CMD, "write", scope), "none captured (the item carried no output)");
	assert.equal(probeReport([report("  \n")], WRITE_CMD, "write", scope), "none captured (the item carried no output)");
	assert.equal(probeReport([], WRITE_CMD, "write", scope), "none captured (no command item was the probe's exact command)");
	assert.match(probeReport([report(enoent), report(enoent)], WRITE_CMD, "write", scope), /^unavailable \(2 command items were the probe's exact command; none is read\)$/);
	assert.match(probeReport([report(enoent)], WRITE_CMD, "write", {}), /^none captured \(no primary turn\)$/);
	for (const other of [
		item(`bash -lc "echo tok-1; exit 11"`, { aggregatedOutput: enoent }),
		item("echo tok-1", { aggregatedOutput: enoent }),
		item(PROBE_CMD("write", "'/fx/target.txt'", "tok-2"), { aggregatedOutput: enoent }),
		item(WRITE_CMD, { aggregatedOutput: enoent }, { threadId: "thr-sub", turnId: "turn-sub" }),
		{ method: "item/started", params: { ...scope, item: { type: "commandExecution", command: WRITE_CMD, aggregatedOutput: enoent } } },
		{ method: "item/completed", params: { ...scope, item: { type: "agentMessage", command: WRITE_CMD, text: enoent } } },
	]) assert.match(probeReport([other], WRITE_CMD, "write", scope), /^none captured \(no command item/, JSON.stringify(other));

	// Only the whitelisted primitives are ever printed; anything else rejects the report outright.
	const secret = "sk-SECRET-/home/u/.codex/auth.json-NONCE";
	for (const output of [
		JSON.stringify({ probe: "write", ok: false, code: "ENOENT", path: secret }),
		JSON.stringify({ probe: "write", ok: false, code: secret }),
		JSON.stringify({ probe: "write", ok: false, code: "ENOENT\u001b[2J" }),
		JSON.stringify({ probe: "write", ok: false, code: "unknown" }),
		JSON.stringify({ probe: "write", ok: false, code: "E".repeat(40) }),
		JSON.stringify({ probe: "write", ok: false, code: 2 }),
		JSON.stringify({ probe: "write", ok: true, code: "ENOENT" }),
		JSON.stringify({ probe: "write", ok: "false" }),
		JSON.stringify({ probe: "net", ok: false, code: "ENOENT" }),
		JSON.stringify({ probe: "write", ok: false, status: 500 }),
		JSON.stringify([{ probe: "write", ok: false }]),
		"null",
		`${JSON.stringify({ probe: "write", ok: false, code: "ENOENT" })}\n${secret}`,
		`${secret}\n${enoent}`,
		`{"probe":"write","ok":false,"code":"ENOENT"`,
		`{"probe":"write","ok":false,"code":"ENOENT","x":"${"a".repeat(2_000)}"}`,
		`{"probe":"write","ok":false,"code":"ENOENT","x":"\u0007"}`,
		{ probe: "write", ok: false, code: "ENOENT" },
	]) {
		const printed = probeReport([report(output)], WRITE_CMD, "write", scope);
		assert.match(printed, /^unavailable \(/, String(output).slice(0, 80));
		assert.ok(!printed.includes("SECRET") && !printed.includes("/home/") && !printed.includes("\u001b"), printed);
		assert.ok(Buffer.byteLength(printed, "utf8") <= PROBE_REPORT_MAX_BYTES);
	}
	assert.ok("unavailable" in readProbeReport(enoent, "eval"), "an unknown verb is never read");
	assert.deepEqual(readProbeReport(JSON.stringify({ probe: "net", ok: false, status: 503 }), "net"), { report: { probe: "net", ok: false } }, "a known numeric field is checked but not printed");
	assert.deepEqual(readProbeReport(JSON.stringify({ probe: "sleep", ok: true, slept: 120 }), "sleep"), { report: { probe: "sleep", ok: true } });
	assert.deepEqual(readProbeReport(JSON.stringify({ probe: "net", ok: false, code: "ECONNREFUSED" }), "net"), { report: { probe: "net", ok: false, code: "ECONNREFUSED" } });

	// The scan is bounded in bytes, not characters, and the printed line never splits a character.
	// U+3000 is whitespace `trim` removes and three UTF-8 bytes: the same report padded by characters under the cap but bytes over it is oversize.
	const base = enoent.trim();
	const room = PROBE_OUTPUT_MAX_BYTES - base.length;
	const fits = `${base}${"\u3000".repeat(Math.floor(room / 3))}`;
	const over = `${base}${"\u3000".repeat(Math.floor(room / 3) + 1)}`;
	assert.ok(over.length < PROBE_OUTPUT_MAX_BYTES && Buffer.byteLength(over, "utf8") > PROBE_OUTPUT_MAX_BYTES);
	assert.deepEqual(readProbeReport(fits, "write"), { report: { probe: "write", ok: false, code: "ENOENT" } });
	assert.deepEqual(readProbeReport(over, "write"), { unavailable: `the output is over ${PROBE_OUTPUT_MAX_BYTES} bytes` }, "never a parsed prefix");
	assert.equal(boundedUtf8("ab\u00e9", 3), "ab", "a two-byte character that does not fit is dropped whole");
	assert.equal(boundedUtf8("a\u{1F600}b", 4), "a", "a four-byte character is never split");
	assert.equal(boundedUtf8("abc", 3), "abc");
	assert.ok(Buffer.byteLength(formatProbeReport({ unavailable: "\u00e9".repeat(400) }), "utf8") <= PROBE_REPORT_MAX_BYTES);
	assert.ok(formatProbeReport({ unavailable: "\u00e9".repeat(400) }).endsWith("\u00e9"), "cut at a character boundary");

	// The cancellation probe's report reads the same primitives from its own exact command.
	const SLEEP_CMD = PROBE_CMD("sleep", "'/fx/work/tok.pid'", "120");
	assert.equal(probeReport([item(SLEEP_CMD, { aggregatedOutput: JSON.stringify({ probe: "sleep", ok: false, code: "EEXIST" }) })], SLEEP_CMD, "sleep", scope), "probe=sleep ok=false code=EEXIST (the probe's own output; diagnostic only, not evidence)");
	assert.match(probeReport([item(SLEEP_CMD, { aggregatedOutput: JSON.stringify({ probe: "sleep", ok: false, code: "EEXIST", pid: secret }) })], SLEEP_CMD, "sleep", scope), /^unavailable \(/);
	assert.match(probeReport([item(SLEEP_CMD, { aggregatedOutput: enoent })], SLEEP_CMD, "sleep", scope), /^unavailable \(/, "another verb's report is not this probe's");
});

test("the probe program's own failure output reads back as its error code, and Q5 and Q6 print that report line", () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-harness-report-"));
	try {
		const run = spawnSync(process.execPath, [PROBE, "write", path.join(root, "absent", "probe.txt"), "tok"], { encoding: "utf8", timeout: 10_000 });
		assert.equal(run.status, 11, "a missing parent is not an operating-system refusal");
		assert.deepEqual(readProbeReport(run.stdout, "write"), { report: { probe: "write", ok: false, code: "ENOENT" } });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	const source = fs.readFileSync(HARNESS, "utf8");
	assert.ok(source.includes("result.fact(`probe ${entry.name} report`, probeReport(record.notifications, entry.command, entry.kind, scope));"), "Q5 prints each probe's report line");
	assert.ok(source.includes(`result.fact("probe sleep report", probeReport(record.notifications, command, "sleep", { threadId: record.thread?.threadId, turnId: record.turn?.turnId }));`), "Q6 prints the sleep probe's report line");
	assert.doesNotMatch(source, /aggregatedOutput/, "the entry program never reads command output itself");
});

const CONTROL_OK: LoopbackControl = { ok: true, exit: 0, hits: 1 };

test("a loopback verdict needs the controller's own request to reach the listener before and after the turn", () => {
	const blocked: Expectation = { applicable: true, expected: "blocked", reason: "networkAccess is false" };
	const refused: Observation = { observed: "blocked", detail: "exit 10" };
	assert.equal(networkVerdict(blocked, refused, { before: CONTROL_OK, after: CONTROL_OK }).status, "pass");
	assert.match(networkVerdict(blocked, refused, { before: CONTROL_OK, after: CONTROL_OK }).why, /127\.0\.0\.1 listener only/);
	for (const controls of [undefined, {}, { before: CONTROL_OK }, { after: CONTROL_OK }, { before: { ok: false, exit: 11, hits: 0 }, after: CONTROL_OK }, { before: CONTROL_OK, after: { ok: false, exit: 0, hits: 0 } }]) {
		const verdict = networkVerdict(blocked, refused, controls);
		assert.equal(verdict.status, "unproven", JSON.stringify(controls));
		assert.equal(networkVerdict(blocked, { observed: "reach", detail: "" }, controls).status, "unproven", "no control, no failure either");
	}
	assert.equal(networkVerdict({ applicable: false, reason: "no flag" }, refused, {}).status, "skip");
	assert.equal(networkVerdict(blocked, { observed: "inconclusive", detail: "ECONNREFUSED" }, { before: CONTROL_OK, after: CONTROL_OK }).status, "unproven", "a refused connection under good controls is still not read as the sandbox");
});

test("Q5 passes only when every applicable probe matched AND one was actually denied; all permits are unproven, never a failure", () => {
	const probe = (name: string, observed: Observation["observed"], status: Status) => ({ name, observation: { observed, detail: "" }, verdict: { status, why: "" } });
	const ok = { sandboxType: "workspaceWrite", approvals: 0 };
	const denied = q5Verdict([probe("inside", "permit", "pass"), probe("slash-tmp", "permit", "pass"), probe("outside", "deny", "pass"), probe("loopback", "blocked", "skip")], ok);
	assert.equal(denied.status, "pass");
	assert.match(denied.why, /observed denial by outside/);
	assert.equal(q5Verdict([probe("inside", "permit", "pass"), probe("loopback", "blocked", "pass")], ok).status, "pass", "a blocked socket under good controls is a denial");
	const permissive = q5Verdict([probe("inside", "permit", "pass"), probe("slash-tmp", "permit", "pass"), probe("outside", "permit", "skip"), probe("loopback", "reach", "pass")], ok);
	assert.deepEqual(permissive, { status: "unproven", why: Q5_NO_DENIAL });
	assert.match(Q5_NO_DENIAL, /boundary not demonstrated under this host's policy; permit measurements recorded; G1 denial evidence pending/);
	assert.equal(exitCode([permissive.status as Status]), 1);
	assert.equal(q5Verdict([probe("inside", "permit", "pass"), probe("outside", "deny", "pass")], { ...ok, approvals: 1 }).status, "fail", "an approval under never fails");
	assert.equal(q5Verdict([probe("inside", "permit", "pass"), probe("outside", "permit", "fail")], ok).status, "fail", "a contradiction fails");
	assert.equal(q5Verdict([probe("inside", "permit", "pass"), probe("outside", "deny", "pass")], { ...ok, sandboxType: "dangerFullAccess" }).status, "fail", "an invalid policy fails");
	assert.equal(q5Verdict([probe("inside", "permit", "skip"), probe("outside", "deny", "pass")], ok).status, "unproven", "the inside write cannot be skipped into a pass");
	assert.equal(q5Verdict([probe("outside", "deny", "pass")], ok).status, "unproven");
	assert.equal(q5Verdict([probe("inside", "permit", "pass"), probe("outside", "deny", "pass"), probe("slash-tmp", "inconclusive", "unproven")], ok).status, "unproven", "every applicable probe needs evidence");
	assert.equal(q5Verdict([probe("inside", "deny", "fail")], ok).status, "fail");
});

test("an outside target is chosen only from an existing, writable parent that no reported grant covers and that is not in the Codex home", () => {
	const granted = writeGrants({ type: "workspaceWrite", writableRoots: ["/data"], excludeSlashTmp: false, excludeTmpdirEnvVar: true }, { cwd: "/tmp/root/work", tmpdirEnv: "/var/tmpdir", canonical: same });
	const usable = (parent: string) => parent !== "/missing";
	const pick = (candidates: OutsideCandidate[], codexHome = "/home/u/.codex") => pickOutside(candidates, { granted, codexHome, usable, canonical: same });
	assert.deepEqual(pick([{ label: "a", parent: "/missing" }, { label: "b", parent: "/data/x" }, { label: "c", parent: "/tmp" }, { label: "d", parent: "/home/u/.codex/tmp" }, { label: "e", parent: "/dev/shm" }]), {
		chosen: { label: "e", parent: "/dev/shm" },
		reasons: ["a: not an existing directory this harness may write", "b: granted (granted by explicit writable root)", "c: granted (granted by implicit /tmp)", "d: inside the Codex home"],
	});
	assert.equal(pick([{ label: "tmpdir", parent: "/var/tmpdir" }]).chosen?.label, "tmpdir", "an excluded TMPDIR is genuinely outside");
	assert.equal(pick([{ label: "relative", parent: "rel" }, { label: "none", parent: undefined }]).chosen, undefined);
	const unknownRoots = writeGrants({ type: "workspaceWrite", excludeSlashTmp: true, excludeTmpdirEnvVar: true }, { cwd: "/w", canonical: same });
	const skipped = pickOutside([{ label: "shm", parent: "/dev/shm" }], { granted: unknownRoots, usable, canonical: same });
	assert.equal(skipped.chosen, undefined, "unknown roots never yield a guessed denial");
	assert.match(skipped.reasons[0]!, /unknown \(writableRoots was not reported/);
});

test("a probe verdict skips what is not applicable, is unproven without evidence and fails a mismatch or an approval", () => {
	const permit: Expectation = { applicable: true, expected: "permit", reason: "granted by cwd" };
	assert.equal(probeVerdict({ applicable: false, reason: "unknown" }, { observed: "permit", detail: "" }).status, "skip");
	assert.equal(probeVerdict(permit, { observed: "permit", detail: "" }).status, "pass");
	assert.equal(probeVerdict(permit, { observed: "deny", detail: "" }).status, "fail");
	assert.equal(probeVerdict(permit, { observed: "not-run", detail: "" }).status, "unproven");
	assert.equal(probeVerdict(permit, { observed: "inconclusive", detail: "" }).status, "unproven");
	assert.equal(probeVerdict(permit, { observed: "declined", detail: "" }).status, "fail");
	assert.equal(probeVerdict({ applicable: true, expected: "blocked", reason: "" }, { observed: "reach", detail: "" }).status, "fail");
	assert.equal(combine(["pass", "skip"]), "pass");
	assert.equal(combine(["pass", "unproven"]), "unproven");
	assert.equal(combine(["unproven", "fail"]), "fail");
	assert.equal(combine(["skip"]), "skip");
	assert.equal(combine([]), "skip");
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
	assert.equal(exitCode([caseStatus(["skip"], ["pass"]), caseStatus(["skip"], ["pass"])]), 2, "guards alone never make exit 0");
	// Q5's own probe skips are folded into its single verdict, so they cannot demote a legitimate denial pass.
	const probe = (name: string, observed: Observation["observed"], status: Status) => ({ name, observation: { observed, detail: "" }, verdict: { status, why: "" } });
	const q5 = q5Verdict([probe("inside", "permit", "pass"), probe("tmpdir", "permit", "skip"), probe("outside", "deny", "pass")], { sandboxType: "workspaceWrite", approvals: 0 });
	assert.equal(caseStatus([q5.status], ["pass", "pass"]), "pass");
});

/** A process table double: pid -> argv and start time. */
const table = (rows: Record<number, { argv: string[]; start?: string }>, readable = true): ProbeProc => ({
	list: () => (readable ? Object.keys(rows).map(Number) : undefined),
	read: (pid) => (rows[pid] ? { argv: rows[pid]!.argv, start: rows[pid]!.start } : undefined),
});

test("the cancellation probe is identified by its exact argv and start time, never by a command that merely names its key", () => {
	const pidFile = "/fx/work/pfq-q6-sleep-abc.pid";
	const argv = ["/usr/bin/node", "/fx/probe/probe.mjs", "sleep", pidFile, "120"];
	const imitations = {
		200: { argv: ["cat", pidFile], start: "5" },
		201: { argv: ["/bin/bash", "-lc", `'/usr/bin/node' '/fx/probe/probe.mjs' sleep '${pidFile}' 120`], start: "6" },
		202: { argv: ["echo", "pfq-q6-sleep-abc"], start: "7" },
	};
	assert.equal(identifyProbe(argv, "200\n", table(imitations)).identity, undefined, "a cat of the pid file, the wrapper or an echo is never the probe");
	assert.match(identifyProbe(argv, "200\n", table(imitations)).why ?? "", /no process with the probe's exact argv/);
	assert.deepEqual(identifyProbe(argv, "300\n", table({ ...imitations, 300: { argv, start: "9" } })), { identity: { pid: 300, start: "9" }, how: "its pid file" });
	assert.deepEqual(identifyProbe(argv, "2\n", table({ ...imitations, 301: { argv, start: "9" } })), { identity: { pid: 301, start: "9" }, how: "its exact argv in the process table" }, "a namespace pid the host does not know falls back to the exact argv");
	assert.equal(identifyProbe(argv, undefined, table({ 301: { argv, start: "9" }, 302: { argv, start: "10" } })).identity, undefined, "two candidates are no identity");
	assert.equal(identifyProbe(argv, "300\n", table({ 300: { argv } })).identity, undefined, "no start time, no identity");
	assert.match(identifyProbe(argv, "x", table({}, false)).why ?? "", /could not be read/);
	assert.equal(probeAfter({ pid: 300, start: "9" }, table({ 200: { argv: ["cat"], start: "5" } })), "gone");
	assert.equal(probeAfter({ pid: 300, start: "9" }, table({ 300: { argv, start: "9" } })), "alive");
	assert.equal(probeAfter({ pid: 300, start: "9" }, table({ 300: { argv: ["other"], start: "44" } })), "gone", "a reused pid with another start time is not the probe");
	assert.equal(probeAfter({ pid: 300, start: "9" }, table({}, false)), "unknown", "an unreadable table is never gone");
	assert.equal(probeAfter({ pid: 300, start: "9" }, { list: () => [300], read: () => undefined }), "unknown");
	assert.equal(readPidText("4242\n"), 4242);
	for (const bad of [undefined, "", "0", "1", "-5", "12 34", "12\n13", "1e3", "99999999999"]) assert.equal(readPidText(bad), undefined, String(bad));
	const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
	assert.equal(startTimeOf(`77 (node (x) y) ${fields.join(" ")}`), "22", "field 22, counted after the last parenthesis");
	assert.equal(startTimeOf("garbage"), undefined);
});

test("a second interrupt says what it leaves behind and claims nothing about it", () => {
	const notice = forcedExitNotice("/tmp/root", ["/dev/shm/p-1", "/tmp/p-2"]);
	assert.match(notice, /without cleanup/);
	for (const entry of ["/tmp/root", "/dev/shm/p-1", "/tmp/p-2"]) assert.ok(notice.includes(`retained (uncertain): ${entry}`));
	assert.doesNotMatch(notice, /removed|ended cleanly|no cleanup concern/i, "no claim that anything was cleaned up or is over");
});

test("the probe program writes exclusively, reports an operating-system refusal as 10, and reaches only a loopback url", async () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-harness-probe-"));
	const server = http.createServer((_request, response) => response.end("ok"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const probe = async (...args: string[]) => {
			const { spawn } = await import("node:child_process");
			return new Promise<number | null>((resolve) => spawn(process.execPath, [PROBE, ...args], { stdio: "ignore" }).on("close", resolve));
		};
		const target = path.join(root, "probe.txt");
		assert.equal(await probe("write", target, "tok"), 0);
		assert.equal(fs.readFileSync(target, "utf8"), "tok\n");
		assert.equal(await probe("write", target, "tok"), 11, "never overwrites: an existing target is another failure");
		const locked = path.join(root, "locked");
		fs.mkdirSync(locked, { mode: 0o500 });
		if (process.getuid?.() !== 0) assert.equal(await probe("write", path.join(locked, "x"), "tok"), 10, "a permission refusal is the denial signature");
		const { port } = server.address() as { port: number };
		assert.equal(await probe("net", `http://127.0.0.1:${port}/tok-1`), 0);
		assert.equal(await probe("net", "http://example.com/tok"), 12, "only a loopback url is taken");
		assert.equal(await probe("eval", "1"), 12);
	} finally {
		server.close();
		try {
			fs.chmodSync(path.join(root, "locked"), 0o700);
		} catch {}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------------------------------------------------------
 * command line and configuration evidence
 * ---------------------------------------------------------------------------------------------------------------- */

test("the command line is strict: both spellings, no valueless or repeated flag, no malformed token, and no default selection", () => {
	assert.deepEqual(parseArgs(["--run", "--case", "Q1", "--model=gpt-x"]), { run: true, fake: false, list: false, help: false, keep: false, unknown: [], problems: [], case: "Q1", model: "gpt-x" });
	assert.deepEqual(parseArgs(["--case"]).problems, ["--case needs a value"]);
	assert.deepEqual(parseArgs(["--case", "--run"]).problems, ["--case needs a value"]);
	assert.deepEqual(parseArgs(["--case="]).problems, ["--case needs a value"]);
	assert.deepEqual(parseArgs(["--case", "Q1", "--case=Q2"]).problems, ["--case is given more than once"]);
	assert.deepEqual(parseArgs(["--effort", "very high"]).problems, ["--effort must be one token with no whitespace"]);
	assert.deepEqual(parseArgs(["--outside-dir", "relative"]).problems, ["--outside-dir must be an absolute path"]);
	assert.deepEqual(parseArgs(["--case=Q1", "--bogus", "Q2"]).unknown, ["--bogus", "Q2"]);
	assert.equal(parseArgs([]).case, undefined);
	assert.deepEqual(selectCases("q2,Q1")?.cases?.map((entry) => entry.id), ["Q1", "Q2"]);
	assert.deepEqual(selectCases("model-free")?.cases?.map((entry) => entry.id), ["Q1", "Q2", "Q7", "Q9"]);
	assert.equal(selectCases("all")?.cases?.length, CASES.length);
	assert.match(selectCases("Q1,nope").error ?? "", /nope/);
	assert.match(selectCases(undefined).error ?? "", /needs/);
	assert.match(selectCases(" ").error ?? "", /needs/);
	assert.ok(CASES.filter((entry) => !entry.model).every((entry) => ["Q1", "Q2", "Q7", "Q9"].includes(entry.id)), "only the model-free group starts no turn");
});

test("configuration evidence: only a top-level user-layer web_search word, and a version parsed from the user agent", () => {
	assert.equal(topLevelWebSearch('model = "x"\nweb_search = "live" # comment\n[tools]\nweb_search = true\n'), "live");
	assert.equal(topLevelWebSearch('[profiles.a]\nweb_search = "live"\n'), "absent", "a key inside a table is not the top level");
	assert.equal(topLevelWebSearch('web_search = "https://secret.example"\n'), "present", "an unexpected value is never echoed");
	assert.equal(topLevelWebSearch(""), "absent");
	assert.equal(versionFromUserAgent("pi-fusion/0.160.0 (Linux 6.1; x86_64) xterm"), "0.160.0");
	assert.equal(versionFromUserAgent("codex_cli_rs/0.161.0-alpha.2"), "0.161.0-alpha.2");
	assert.equal(versionFromUserAgent("no version here"), undefined);
	assert.equal(versionFromUserAgent(undefined), undefined);
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
		for (const args of [[], ["--help"], ["-h"], ["--list"], ["--bogus"], ["--case", "Q1"], ["--fake", "--case", "Q1"], ["--run"], ["--run", "--case"], ["--run", "--case", "nope"], ["--run", "--case=Q1", "--model"], ["--run", "--case", "all", "--effort", "a b"], ["--list", "--run", "--case", "all"]]) {
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
		assert.match(harness(box, ["--list"]).stdout, /Q5 .*\[model\][\s\S]*model-free/);
		assert.ok(!fs.existsSync(box.tripped), "no codex ran");
		assert.ok(!fs.existsSync(box.env.CODEX_HOME!) && !fs.existsSync(box.env.HOME!), "no Codex home or home was created");
		assert.deepEqual(fs.readdirSync(box.env.TMPDIR!), [], "no fixture root was made");
	} finally {
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

/** Git on the inherited PATH, found the way a shell would, for the fake run's fixture repositories. */
function gitDirectory(): string | undefined {
	for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!entry) continue;
		try {
			fs.accessSync(path.join(entry, "git"), fs.constants.X_OK);
			return entry;
		} catch {}
	}
	return undefined;
}

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
		assert.match(out, /child's own turn completion: interrupted/);
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
		assert.match(early.stdout, /UNPROVEN the cancellation point never came/);
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

test("a case skipped for a missing option, or for needing a native child, stays SKIP with its reason after its guards pass", { timeout: 30_000 }, () => {
	const box = sandbox();
	try {
		const ran = harness(box, ["--run", "--fake", "--case", "Q3,Q3b,Q8,Q8b,Q5c"], 25_000);
		const out = ran.stdout;
		assert.equal(ran.status, 2, `nothing was measured, so nothing ran: ${out}\n${ran.stderr}`);
		assert.match(out, /RESULT Q3: skip \(needs a native child/);
		assert.match(out, /RESULT Q3b: skip \(no --effort given/);
		assert.match(out, /RESULT Q8: skip \(no --unsupported-effort given/);
		assert.match(out, /RESULT Q8b: skip \(no --null-effort-model given/);
		assert.match(out, /RESULT Q5c: skip \(needs a native child/);
		assert.equal((out.match(/PASS \(guard\) config\.toml bytes unchanged/g) ?? []).length, 3, "the option cases ran to their skip with the configuration guard around them");
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
