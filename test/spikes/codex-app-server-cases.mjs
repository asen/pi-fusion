import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/*
 * The pure half of `codex-app-server.mjs`, the stage 1 Codex qualification harness: its command line, its case
 * catalogue and the oracle it judges sandbox probes by. Node builtins only, and importing it does nothing: no process,
 * no `PATH` lookup, no Codex home, configuration or auth read, no production module loaded. `test/codex-harness.test.ts`
 * imports it directly, which is why it is apart from the entry program.
 *
 * The oracle is the host's CURRENT reported policy and nothing else. It assumes no universal denial: a workspace-write
 * thread may write its cwd, every explicit writable root it reports, and the implicit temp grants — `/tmp` and the
 * inherited `TMPDIR` — unless the policy reports them excluded. An exclusion removes an implicit grant, never an explicit
 * root that covers the same place. A field the answer left out is UNKNOWN: a probe whose expectation depends on it is
 * not applicable and is skipped with that reason, never judged as if the roots were empty or the flags false.
 */

/** Exit codes, the same as the Pi harnesses': every selected case passed, any failed or is unproven, or none ran. */
export const EXIT = Object.freeze({ pass: 0, failure: 1, none: 2 });

/**
 * Every case this stage-1 harness knows. `model` marks a case that starts a turn, which is a provider request on the
 * user's own login and quota with a cost Codex does not report; the others start a child and at most a thread. `fake`
 * marks a case the fake app-server can drive end to end; the rest need a native child that really runs commands. `needs`
 * names the option without which a case skips before anything starts, which it then does in either mode.
 */
export const CASES = Object.freeze([
	{ id: "Q1", model: false, fake: true, title: "initialize: reported Codex home, user agent and platform against the prediction; node and version evidence" },
	{ id: "Q2", model: false, fake: true, title: "thread/start + thread/read with no request cwd: host-default and explicit model/provider/effort readback, implement and both ask modes, cwd realpath binding" },
	{ id: "Q3", model: true, fake: false, title: "implement: a minimal fixture edit and a nonce delivered only in developer instructions, with no commit" },
	{ id: "Q3b", model: true, fake: false, needs: "effort", title: "a named effort (--effort) that differs from the configured default reads back exactly; skipped without one" },
	{ id: "Q4", model: true, fake: true, title: "read-only ask: answer from a fixture file with no write, no commit and no approval" },
	{ id: "Q5", model: true, fake: false, title: "workspace-write probes against the reported policy (cwd, /tmp, TMPDIR, an ungranted outside target, the controller's loopback listener); PASS needs every applicable probe to match AND at least one observed denial, else UNPROVEN" },
	{ id: "Q5b", model: true, fake: false, title: "hosted web search observed alongside command network off; conditional, never command-network evidence" },
	{ id: "Q5c", model: true, fake: false, title: "loopback network probe after an operator's own network configuration change, which this harness never makes; conditional" },
	{ id: "Q6", model: true, fake: true, title: "cancellation interrupts a running command's turn and the owned shutdown is clean" },
	{ id: "Q7", model: false, fake: true, title: "under the production owned shutdown (SIGTERM to observed descendants first, then stdin end) the root exits by itself: status 0, no root signal, nothing left" },
	{ id: "Q8", model: true, fake: false, needs: "unsupportedEffort", title: "an unsupported effort (--unsupported-effort) is recorded as it behaves, assuming neither refusal nor no charge; skipped without one" },
	{ id: "Q8b", model: true, fake: false, needs: "nullEffortModel", title: "a model with no effort (--null-effort-model) reads back null and records none; skipped without one" },
	{ id: "Q9", model: false, fake: true, title: "an untrusted fixture cwd started with no request cwd: configuration bytes unchanged, sandbox kept" },
]);

/** Named selections. `all` is spelled out on purpose: nothing native runs without a `--case`. */
export const GROUPS = Object.freeze({
	"model-free": ["Q1", "Q2", "Q7", "Q9"],
	all: CASES.map((entry) => entry.id),
});

/** The flags that take a value, in either `--flag value` or `--flag=value` spelling. */
const VALUE_FLAGS = Object.freeze({
	"--case": "case",
	"--model": "model",
	"--effort": "effort",
	"--unsupported-effort": "unsupportedEffort",
	"--null-effort-model": "nullEffortModel",
	"--outside-dir": "outsideDir",
});
const BOOLEAN_FLAGS = Object.freeze({ "--run": "run", "--fake": "fake", "--list": "list", "--help": "help", "-h": "help", "--keep": "keep" });

/** One model id or effort level as Codex takes one: non-empty, bounded, with no whitespace or control character. */
export function isToken(value) {
	if (typeof value !== "string" || value === "" || value.length > 256) return false;
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return false;
	}
	return true;
}

/**
 * Strict on purpose, as the Pi harnesses are: every spelling reaches the same place, a valueless or repeated flag is a
 * problem rather than a default, and anything unrecognised is collected, because an ignored `--case=nope` must never
 * run a different selection than the one the command line named.
 */
export function parseArgs(args) {
	const parsed = { run: false, fake: false, list: false, help: false, keep: false, unknown: [], problems: [] };
	const seen = new Set();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (Object.hasOwn(BOOLEAN_FLAGS, arg)) {
			parsed[BOOLEAN_FLAGS[arg]] = true;
			continue;
		}
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		if (!Object.hasOwn(VALUE_FLAGS, flag)) {
			parsed.unknown.push(arg);
			continue;
		}
		let value;
		if (eq !== -1) value = arg.slice(eq + 1);
		else if (args[index + 1] !== undefined && !args[index + 1].startsWith("-")) value = args[++index];
		const key = VALUE_FLAGS[flag];
		if (seen.has(key)) parsed.problems.push(`${flag} is given more than once`);
		seen.add(key);
		if (value === undefined || value === "") {
			parsed.problems.push(`${flag} needs a value`);
			continue;
		}
		parsed[key] = value;
	}
	for (const key of ["model", "effort", "unsupportedEffort", "nullEffortModel"]) {
		if (parsed[key] !== undefined && !isToken(parsed[key])) parsed.problems.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be one token with no whitespace`);
	}
	if (parsed.outsideDir !== undefined && !path.isAbsolute(parsed.outsideDir)) parsed.problems.push("--outside-dir must be an absolute path");
	return parsed;
}

/** The cases a `--case` value names: comma-separated ids or group names, case-insensitive, in catalogue order. */
export function selectCases(spec) {
	if (spec === undefined || spec.trim() === "") return { error: "--case needs a case id, a comma-separated list, a group, or all" };
	const wanted = new Set();
	for (const raw of spec.split(",")) {
		const name = raw.trim();
		const group = Object.keys(GROUPS).find((key) => key === name.toLowerCase());
		if (group) {
			for (const id of GROUPS[group]) wanted.add(id);
			continue;
		}
		const entry = CASES.find((candidate) => candidate.id.toLowerCase() === name.toLowerCase());
		if (!entry) return { error: `no case or group is named ${JSON.stringify(name)}` };
		wanted.add(entry.id);
	}
	return { cases: CASES.filter((entry) => wanted.has(entry.id)) };
}

export const WARNING = `NATIVE RUNS USE YOUR OWN CODEX INSTALL AS IT IS.
  The child is the host's codex (PI_FUSION_CODEX_BIN or the first codex on PATH) with this process's environment
  unchanged: your Codex home, configuration, profiles, login, MCP servers, remote-control and multi-agent settings.
  Cases marked [model] start turns: provider requests on your authentication and quota, with a cost Codex does not
  report (USD unknown, never estimated). Every thread may leave rollouts, logs or state in your existing Codex home.
  Nothing is isolated, copied, logged in or overridden; config.toml is hashed before and after and never written.`;

export const USAGE = `node test/spikes/codex-app-server.mjs --list
node test/spikes/codex-app-server.mjs --run --case <ids|group|all> [options]
node test/spikes/codex-app-server.mjs --run --fake --case <ids> [options]

  --run                     required for anything to start; without it nothing is located, read or spawned
  --case Q1,Q2 | model-free | all
                            what runs; there is no default selection
  --fake                    drive test/fake-codex.mjs by path instead of Codex: NOT NATIVE evidence
  --model <id>              Q2 explicit-model leg
  --effort <level>          Q3b named effort (skipped without one; no catalogue is guessed)
  --unsupported-effort <level>
                            Q8 effort the configured model does not support (skipped without one)
  --null-effort-model <id>  Q8b model that reports no effort (skipped without one)
  --outside-dir <abs dir>   Q5 parent for a disposable outside target (else /dev/shm, XDG_RUNTIME_DIR, the fixture
                            root's parent, then an existing HOME/.cache), used only when no reported grant covers it
  --keep                    keep the fixture root even when every child ended cleanly
  --list | --help           print and exit 2; nothing runs

Exit 0: every selected case passed (skips allowed). 1: a case failed or is unproven. 2: nothing ran.

${WARNING}`;

/* ------------------------------------------------------------------------------------------------------------------
 * paths
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * The canonical form of an absolute path that may not exist yet: the realpath of its nearest existing ancestor with the
 * rest appended, so a probe target and the root it is compared against go through the same symlinks.
 */
export function canonicalPath(file) {
	let current = path.resolve(file);
	const rest = [];
	for (;;) {
		try {
			const real = fs.realpathSync.native(current);
			return rest.length === 0 ? real : path.join(real, ...rest.reverse());
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(file);
			rest.push(path.basename(current));
			current = parent;
		}
	}
}

/** Whether `child` is `root` or under it, by path segments: `/tmp/ab` is not under `/tmp/a`. Both canonical. */
export function within(child, root) {
	const relative = path.relative(root, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Subpaths Codex keeps read-only inside a writable root (source reading); a target under one is not judged here. */
const PROTECTED_SUBPATHS = new Set([".git", ".codex", ".agents"]);

/* ------------------------------------------------------------------------------------------------------------------
 * the policy oracle
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * What the reported sandbox grants for writing, from the thread/start answer's policy and nothing else.
 *
 * `{ kind: "none" }` for a reported read-only policy, `{ kind: "all" }` for full access, `{ kind: "unknown" }` for a
 * policy this harness has no rule for, and for workspace-write `{ kind: "grants", grants, unknown }`: the cwd always,
 * each explicit root, `/tmp` unless excluded and the inherited `TMPDIR` unless excluded. A field the answer left out
 * becomes an `unknown` entry with the scope it could cover — `null` for roots, which could cover anything.
 */
export function writeGrants(sandbox, { cwd, tmpdirEnv, slashTmp = "/tmp", canonical = canonicalPath }) {
	if (!sandbox || typeof sandbox.type !== "string") return { kind: "unknown", reason: "no sandbox policy was reported" };
	if (sandbox.type === "readOnly") return { kind: "none" };
	if (sandbox.type === "dangerFullAccess") return { kind: "all" };
	if (sandbox.type !== "workspaceWrite") return { kind: "unknown", reason: `the reported sandbox ${sandbox.type} has no write rule in this harness` };
	const grants = [{ root: canonical(cwd), source: "cwd" }];
	const unknown = [];
	if (Array.isArray(sandbox.writableRoots)) for (const root of sandbox.writableRoots) grants.push({ root: canonical(root), source: "explicit writable root" });
	else unknown.push({ scope: null, reason: "writableRoots was not reported" });
	const tmp = canonical(slashTmp);
	if (sandbox.excludeSlashTmp === false) grants.push({ root: tmp, source: "implicit /tmp" });
	else if (sandbox.excludeSlashTmp === undefined) unknown.push({ scope: tmp, reason: "excludeSlashTmp was not reported" });
	if (typeof tmpdirEnv === "string" && path.isAbsolute(tmpdirEnv)) {
		const tmpdir = canonical(tmpdirEnv);
		if (sandbox.excludeTmpdirEnvVar === false) grants.push({ root: tmpdir, source: "implicit TMPDIR" });
		else if (sandbox.excludeTmpdirEnvVar === undefined) unknown.push({ scope: tmpdir, reason: "excludeTmpdirEnvVar was not reported" });
	}
	return { kind: "grants", grants, unknown };
}

/**
 * What a write to `target` is expected to do under those grants: `{ applicable: true, expected: "permit" | "deny" }`
 * with the grant or reason, or `{ applicable: false, reason }` when an unknown field could decide it either way.
 */
export function expectWrite(granted, target, canonical = canonicalPath) {
	if (granted.kind === "unknown") return { applicable: false, reason: granted.reason };
	if (granted.kind === "none") return { applicable: true, expected: "deny", reason: "the reported sandbox is read-only" };
	if (granted.kind === "all") return { applicable: true, expected: "permit", reason: "the reported sandbox grants full access" };
	const at = canonical(target);
	const hits = granted.grants.filter((grant) => within(at, grant.root));
	for (const grant of hits) {
		const first = path.relative(grant.root, at).split(path.sep)[0];
		if (PROTECTED_SUBPATHS.has(first)) return { applicable: false, reason: `the target is under ${first} in a writable root, whose read-only rule this harness does not model` };
	}
	if (hits.length > 0) return { applicable: true, expected: "permit", reason: `granted by ${hits.map((grant) => grant.source).join(", ")}` };
	const open = granted.unknown.find((entry) => entry.scope === null || within(at, entry.scope));
	if (open) return { applicable: false, reason: `${open.reason}, so whether the target is granted is unknown` };
	return { applicable: true, expected: "deny", reason: "outside the cwd, every reported explicit root and every implicit temp grant not excluded" };
}

/** The command network the reported policy says a probe should see, or not applicable when it reports no boolean. */
export function expectNetwork(sandbox) {
	if (typeof sandbox?.networkAccess === "boolean") return { applicable: true, expected: sandbox.networkAccess ? "reach" : "blocked", reason: `networkAccess is ${sandbox.networkAccess}` };
	return { applicable: false, reason: "the reported policy carries no networkAccess boolean" };
}

/* ------------------------------------------------------------------------------------------------------------------
 * probe evidence
 * ---------------------------------------------------------------------------------------------------------------- */

/** The probe program's exit codes: done, refused by the operating system (EACCES/EPERM/EROFS), anything else. */
export const PROBE_EXIT = Object.freeze({ ok: 0, denied: 10, other: 11, usage: 12 });

/** Characters a word may carry outside quotes. Anything else — `;`, `|`, `&`, `$`, a redirect, a newline — is refused. */
const UNQUOTED = /[A-Za-z0-9_\-.,/:=+@%]/;

/**
 * The words of one command line the way a POSIX shell would split it, for comparison only: single and double quotes and
 * backslash escapes, and nothing that expands or executes. A line with an unquoted metacharacter, an expansion inside
 * double quotes or an unterminated quote is `undefined`: not a form this harness recognises.
 */
export function shellWords(text) {
	const words = [];
	let word = null;
	let at = 0;
	while (at < text.length) {
		const char = text[at];
		if (char === " " || char === "\t") {
			if (word !== null) words.push(word);
			word = null;
			at += 1;
		} else if (char === "'") {
			const end = text.indexOf("'", at + 1);
			if (end === -1) return undefined;
			word = (word ?? "") + text.slice(at + 1, end);
			at = end + 1;
		} else if (char === '"') {
			let out = "";
			let next = at + 1;
			for (;;) {
				if (next >= text.length) return undefined;
				const inner = text[next];
				if (inner === '"') break;
				if (inner === "$" || inner === "`") return undefined;
				if (inner === "\\" && next + 1 < text.length && '"\\$`'.includes(text[next + 1])) {
					out += text[next + 1];
					next += 2;
					continue;
				}
				out += inner;
				next += 1;
			}
			word = (word ?? "") + out;
			at = next + 1;
		} else if (char === "\\") {
			if (at + 1 >= text.length || text[at + 1] === "\n") return undefined;
			word = (word ?? "") + text[at + 1];
			at += 2;
		} else {
			if (!UNQUOTED.test(char)) return undefined;
			word = (word ?? "") + char;
			at += 1;
		}
	}
	if (word !== null) words.push(word);
	return words;
}

/** The shells a recorded command may name when Codex reports the wrapper it ran a command line in. */
const SHELLS = new Set(["bash", "sh", "zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh", "/bin/zsh", "/usr/bin/zsh"]);

const sameWords = (a, b) => a.length === b.length && a.every((word, index) => word === b[index]);

/**
 * Whether a recorded command is the harness's own probe command, word for word: the interpreter, the probe script,
 * the verb and every argument, token included. Two forms are recognised — the command line itself (however it is
 * quoted), or one shell wrapper `<shell> -c|-lc <that command line>` — and nothing else, so an `echo` or a `curl` that
 * merely carries the token is never the probe.
 */
export function sameProbeCommand(recorded, expected) {
	const want = shellWords(expected);
	if (want === undefined || want.length === 0) return false;
	const got = Array.isArray(recorded) ? (recorded.every((word) => typeof word === "string") ? recorded : undefined) : typeof recorded === "string" ? shellWords(recorded) : undefined;
	if (got === undefined) return false;
	if (sameWords(got, want)) return true;
	if (got.length !== 3 || !SHELLS.has(got[0]) || (got[1] !== "-c" && got[1] !== "-lc")) return false;
	const inner = shellWords(got[2]);
	return inner !== undefined && sameWords(inner, want);
}

/**
 * The completed command items of the primary turn that are exactly the probe's command, and how many other command
 * items carried its token without being it. Only the status and exit code are kept; output never is.
 */
export function probeItems(notifications, expected, token, scope) {
	const items = [];
	let unrecognised = 0;
	for (const notification of notifications) {
		if (notification.method !== "item/completed") continue;
		const params = notification.params;
		if (!params || typeof params !== "object" || params.threadId !== scope.threadId || params.turnId !== scope.turnId) continue;
		const item = params.item;
		if (!item || item.type !== "commandExecution") continue;
		const text = typeof item.command === "string" ? item.command : Array.isArray(item.command) ? item.command.join(" ") : "";
		if (sameProbeCommand(item.command, expected)) items.push({ status: typeof item.status === "string" ? item.status : undefined, exitCode: typeof item.exitCode === "number" ? item.exitCode : null });
		else if (text.includes(token)) unrecognised += 1;
	}
	return { items, unrecognised };
}

/** Another command carried the token: the fixture or listener may hold its doing, so nothing here is evidence. */
const tainted = (match) => ({ observed: "inconclusive", detail: `${match.unrecognised} command(s) carried the probe's token without being its exact command; not evidence` });

/** What a write probe did, from its exact command items and the file it was to write — never from the model's report. */
export function classifyWrite(match, state, token) {
	if (match.unrecognised > 0) return tainted(match);
	const { items } = match;
	if (items.length === 0) return { observed: "not-run", detail: "no command item was the probe's exact command" };
	if (items.some((item) => item.status === "declined")) return { observed: "declined", detail: "a probe command was declined" };
	const exits = items.map((item) => item.exitCode);
	const wrote = state.exists && typeof state.content === "string" && state.content.trim() === token;
	if (wrote && exits.includes(PROBE_EXIT.ok)) return { observed: "permit", detail: `exit ${exits.join(",")}, target holds the token` };
	if (!state.exists && exits.every((code) => code === PROBE_EXIT.denied)) return { observed: "deny", detail: `exit ${exits.join(",")} (operating-system refusal), target absent` };
	return { observed: "inconclusive", detail: `exit ${exits.join(",")}, target ${state.exists ? (wrote ? "holds the token" : "exists without the token") : "absent"}` };
}

/** What a loopback probe did, from its exact command items and the controller's own listener. */
export function classifyNetwork(match, hits) {
	if (match.unrecognised > 0) return tainted(match);
	const { items } = match;
	if (items.length === 0) return { observed: "not-run", detail: "no command item was the probe's exact command" };
	if (items.some((item) => item.status === "declined")) return { observed: "declined", detail: "a probe command was declined" };
	const exits = items.map((item) => item.exitCode);
	if (hits > 0 && exits.includes(PROBE_EXIT.ok)) return { observed: "reach", detail: `exit ${exits.join(",")}, listener saw ${hits} request(s)` };
	if (hits === 0 && exits.every((code) => code === PROBE_EXIT.denied)) return { observed: "blocked", detail: `exit ${exits.join(",")} (socket refused by the operating system), listener saw nothing` };
	return { observed: "inconclusive", detail: `exit ${exits.join(",")}, listener saw ${hits} request(s); not a denial signature this harness reads as the sandbox` };
}

/** One probe's verdict: skip when not applicable, unproven without evidence, fail on a declined approval or a mismatch. */
export function probeVerdict(expectation, observation) {
	if (!expectation.applicable) return { status: "skip", why: expectation.reason };
	if (observation.observed === "declined") return { status: "fail", why: `an approval was requested and declined under approval never (${observation.detail})` };
	if (observation.observed === "not-run" || observation.observed === "inconclusive") return { status: "unproven", why: observation.detail };
	return observation.observed === expectation.expected
		? { status: "pass", why: `${observation.observed} as expected (${expectation.reason}; ${observation.detail})` }
		: { status: "fail", why: `${observation.observed}, expected ${expectation.expected} (${expectation.reason}; ${observation.detail})` };
}

/**
 * A loopback probe's verdict, which needs the controller's own trusted request to the same listener to have reached it
 * both before and after the turn: without that, neither reach nor a refusal says anything about the sandbox. It speaks
 * for that one 127.0.0.1 listener only, never for other endpoints, and hosted search is a separate thing entirely.
 */
export function networkVerdict(expectation, observation, controls) {
	const failed = ["before", "after"].filter((when) => controls?.[when]?.ok !== true);
	if (failed.length > 0) {
		const why = `the controller's own loopback control ${failed.join(" and ")} the turn did not reach its listener, so the probe says nothing about the sandbox`;
		return expectation.applicable ? { status: "unproven", why } : { status: "skip", why: `${expectation.reason}; ${why}` };
	}
	const verdict = probeVerdict(expectation, observation);
	return { ...verdict, why: `${verdict.why}; the controller's 127.0.0.1 listener only` };
}

/** Q5's answer when every applicable probe matched and none was a denial: a permissive host is not a failure. */
export const Q5_NO_DENIAL = "boundary not demonstrated under this host's policy; permit measurements recorded; G1 denial evidence pending";

/**
 * Q5 as a whole. FAIL for a policy that is not workspace-write, an approval asked under never, or any probe that
 * contradicted the reported policy; UNPROVEN when the inside write did not pass, when any applicable probe lacks
 * evidence, or when nothing was actually denied; PASS only with every applicable probe matching AND at least one
 * observed denial (a refused write with the target absent, or a refused socket with the listener untouched).
 */
export function q5Verdict(probes, { sandboxType, approvals }) {
	if (sandboxType !== "workspaceWrite") return { status: "fail", why: `the reported sandbox is ${sandboxType ?? "missing"}, not workspaceWrite` };
	if (approvals > 0) return { status: "fail", why: `${approvals} approval(s) were requested under approval never` };
	const contradicted = probes.filter((probe) => probe.verdict.status === "fail");
	if (contradicted.length > 0) return { status: "fail", why: `contradicted the reported policy: ${contradicted.map((probe) => probe.name).join(", ")}` };
	const inside = probes.find((probe) => probe.name === "inside");
	if (inside?.verdict.status !== "pass") return { status: "unproven", why: `the inside-cwd write is necessary evidence and is ${inside ? inside.verdict.status : "missing"}` };
	const open = probes.filter((probe) => probe.verdict.status === "unproven");
	if (open.length > 0) return { status: "unproven", why: `no evidence for applicable probe(s): ${open.map((probe) => probe.name).join(", ")}` };
	const denials = probes.filter((probe) => probe.verdict.status === "pass" && (probe.observation.observed === "deny" || probe.observation.observed === "blocked"));
	if (denials.length === 0) return { status: "unproven", why: Q5_NO_DENIAL };
	return { status: "pass", why: `every applicable probe matched the reported policy, with observed denial by ${denials.map((probe) => probe.name).join(", ")}` };
}

/**
 * The first candidate parent an outside probe may use: an existing directory this harness may write (none is created),
 * not inside the Codex home, and one the reported policy denies outright. A covered or unknown candidate is passed over
 * with its reason, and none at all is a skip, never a guessed denial.
 */
export function pickOutside(candidates, { granted, codexHome, usable, canonical = canonicalPath }) {
	const reasons = [];
	const home = codexHome === undefined ? undefined : canonical(codexHome);
	for (const candidate of candidates) {
		if (typeof candidate.parent !== "string" || !path.isAbsolute(candidate.parent)) continue;
		if (!usable(candidate.parent)) {
			reasons.push(`${candidate.label}: not an existing directory this harness may write`);
			continue;
		}
		const at = canonical(candidate.parent);
		if (home !== undefined && within(at, home)) {
			reasons.push(`${candidate.label}: inside the Codex home`);
			continue;
		}
		const expected = expectWrite(granted, path.join(at, "pi-fusion-codex-probe"), canonical);
		if (expected.applicable && expected.expected === "deny") return { chosen: { ...candidate, parent: at }, reasons };
		reasons.push(`${candidate.label}: ${expected.applicable ? `granted (${expected.reason})` : `unknown (${expected.reason})`}`);
	}
	return { reasons };
}

/* ------------------------------------------------------------------------------------------------------------------
 * what the backend sends
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * A role's developer instructions as `createCodexBackend` composes them: the contract, then the addendum. Kept here so
 * the model-free cases, which drive the transport without a turn, send the same body, and a test pins the two together.
 */
export function composeInstructions(role, read) {
	return `${read(role.contract).trimEnd()}\n\n${read(role.addendum).trim()}\n`;
}

/** The thread/start body the backend sends for a role: only the named selection, the sandbox mode, approval never, instructions. */
export function threadParams(role, instructions) {
	return {
		...(role.model === undefined ? {} : { model: role.model }),
		...(role.provider === undefined ? {} : { modelProvider: role.provider }),
		sandbox: role.sandboxMode,
		approvalPolicy: role.approvalPolicy,
		developerInstructions: instructions,
	};
}

/**
 * A case's status from its own measurements and the guards around them. Guards — configuration unchanged, a clean
 * owned shutdown, no approval asked, a preflight child — can fail or leave a case unproven, but never pass it: only a
 * primary measurement can. A case whose measurements were all skipped stays a skip however many guards held.
 */
export function caseStatus(primary, guards) {
	if (primary.includes("fail") || guards.includes("fail")) return "fail";
	if (primary.includes("unproven") || guards.includes("unproven")) return "unproven";
	return primary.includes("pass") ? "pass" : "skip";
}

/** Parts of one kind: any failure fails them, then anything unproven, then a pass if anything passed. */
export function combine(statuses) {
	if (statuses.includes("fail")) return "fail";
	if (statuses.includes("unproven")) return "unproven";
	if (statuses.includes("pass")) return "pass";
	return "skip";
}

/** The harness's exit code from every selected case's status. */
export function exitCode(statuses) {
	if (statuses.some((status) => status === "fail" || status === "unproven")) return EXIT.failure;
	return statuses.includes("pass") ? EXIT.pass : EXIT.none;
}

/* ------------------------------------------------------------------------------------------------------------------
 * the cancellation probe's identity
 * ---------------------------------------------------------------------------------------------------------------- */

/** A pid as a probe's own pid file states it: one positive safe integer and nothing else, or undefined. */
export function readPidText(text) {
	if (typeof text !== "string" || !/^\d{1,10}\n?$/.test(text)) return undefined;
	const pid = Number(text.trim());
	return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/** The start time in a /proc/<pid>/stat line: field 22, counted after the parenthesised command name. */
export function startTimeOf(stat) {
	if (typeof stat !== "string") return undefined;
	const close = stat.lastIndexOf(")");
	if (close === -1) return undefined;
	const fields = stat.slice(close + 2).split(" ");
	return /^\d+$/.test(fields[19] ?? "") ? fields[19] : undefined;
}

const sameArgv = (a, b) => Array.isArray(a) && a.length === b.length && a.every((word, index) => word === b[index]);

/**
 * Which live process is the sleep probe: its exact argv (interpreter, script, verb, pid file, seconds) and start time.
 * The pid its own file names is tried first; a sandbox with its own pid namespace writes a pid the host does not
 * know, so then exactly one process with that exact argv is. A `cat` or `echo` of the pid file, or the shell wrapper,
 * never matches. `proc.list()` is undefined when the table cannot be read; `proc.read(pid)` undefined when that pid is.
 */
export function identifyProbe(argv, pidFileText, proc) {
	const named = readPidText(pidFileText);
	if (named !== undefined) {
		const read = proc.read(named);
		if (read && sameArgv(read.argv, argv) && read.start !== undefined) return { identity: { pid: named, start: read.start }, how: "its pid file" };
	}
	const pids = proc.list();
	if (pids === undefined) return { why: "the process table could not be read" };
	const found = [];
	for (const pid of pids) {
		const read = proc.read(pid);
		if (read && sameArgv(read.argv, argv) && read.start !== undefined) found.push({ pid, start: read.start });
	}
	if (found.length === 1) return { identity: found[0], how: "its exact argv in the process table" };
	return { why: found.length === 0 ? `no process with the probe's exact argv${named === undefined ? " and no usable pid file" : ""}` : `${found.length} processes share the probe's argv` };
}

/**
 * Whether an identified probe is still there: `gone` when its pid is absent from a readable table or now belongs to a
 * process that started at another time, `alive` when the same process is, `unknown` when the table cannot be read.
 */
export function probeAfter(identity, proc) {
	const pids = proc.list();
	if (pids === undefined) return "unknown";
	if (!pids.includes(identity.pid)) return "gone";
	const read = proc.read(identity.pid);
	if (read === undefined) return "unknown";
	return read.start === identity.start ? "alive" : "gone";
}

/** What a second interrupt prints before exiting at once: the paths left behind, and that nothing was proved over. */
export function forcedExitNotice(root, outside) {
	const paths = [root, ...outside].filter((entry) => typeof entry === "string" && entry !== "");
	return [
		"interrupted again: exiting now, without cleanup, without waiting for any child, and without proving anything over",
		...paths.map((entry) => `  retained (uncertain): ${entry}`),
		"  inspect these and any codex process this harness started yourself; nothing here says they are gone",
	].join("\n");
}

/* ------------------------------------------------------------------------------------------------------------------
 * configuration and version evidence
 * ---------------------------------------------------------------------------------------------------------------- */

/** A file's sha256, `absent` when there is none, or `unreadable`. Bytes are hashed in memory and never kept or shown. */
export function fileDigest(file) {
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch (error) {
		return error && error.code === "ENOENT" ? "absent" : "unreadable";
	}
}

const WEB_SEARCH_WORDS = new Set(["live", "cached", "disabled", "true", "false"]);

/**
 * The top-level `web_search` key of one user-layer config.toml text, before its first table header: its value when it
 * is one of the words Codex documents, `present` for anything else, `absent` without one. This is the USER LAYER ONLY
 * and NOT the merged effective configuration — profiles, project layers, `[tools]`, features and defaults are not read.
 */
export function topLevelWebSearch(text) {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) break;
		const match = /^web_search\s*=\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		const value = match[1].replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
		return WEB_SEARCH_WORDS.has(value) ? value : "present";
	}
	return "absent";
}

/** The version a user agent such as `originator/0.160.0 (Linux ...)` names after its first slash, or none. Unverified. */
export function versionFromUserAgent(userAgent) {
	const match = /^[^\s/]+\/(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(userAgent ?? "");
	return match ? match[1] : undefined;
}
