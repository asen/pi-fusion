import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/*
 * The pure half of `codex-app-server.mjs`, the stage 1 Codex qualification harness: its command line, its case
 * catalogue and the rules a case's status follows. Node builtins only, and importing it does nothing: no process, no
 * `PATH` lookup, no Codex home, configuration or auth read, no production module loaded. `test/codex-harness.test.ts`
 * imports it directly, which is why it is apart from the entry program.
 *
 * The sandbox and permissions are the user's own Codex configuration, trusted as Claude's and Pi's are: no case
 * re-audits that boundary. The cases measure what Fusion relies on — the handshake, the start checks and readback, a
 * turn's outcome, cancellation and the owned shutdown — and that the user's configuration is left unchanged.
 */

/** Exit codes, the same as the Pi harnesses': every selected case passed, any failed or is unproven, or none ran. */
export const EXIT = Object.freeze({ pass: 0, failure: 1, none: 2 });

/**
 * Every case this stage-1 harness knows. `model` marks a case that starts a turn, which is a provider request on the
 * user's own login and quota with a cost Codex does not report; the others start a child and at most a thread. `fake`
 * marks a case the fake app-server can drive end to end; the rest need a native child that really runs a model. `needs`
 * names the option without which a case skips before anything starts, which it then does in either mode.
 */
export const CASES = Object.freeze([
	{ id: "Q1", model: false, fake: true, title: "initialize: reported Codex home, user agent and platform against the prediction; node and version evidence" },
	{ id: "Q2", model: false, fake: true, title: "thread/start + thread/read with no request cwd: host-default and explicit model/provider/effort readback, implement and both ask modes, cwd realpath binding" },
	{ id: "Q3", model: true, fake: false, title: "implement: a minimal fixture edit and a nonce delivered only in developer instructions, with no commit" },
	{ id: "Q3b", model: true, fake: false, needs: "effort", title: "a named effort (--effort) that differs from the configured default reads back exactly; skipped without one" },
	{ id: "Q4", model: true, fake: true, title: "read-only ask: answer from a fixture file, readOnly reported, no fixture write, no commit and no approval; hosted search items observed, not gating" },
	{ id: "Q6", model: true, fake: true, title: "cancellation through the production signal once the primary turn's first command starts (fake: at turn admission): aborted, stop requested, clean owned shutdown" },
	{ id: "Q7", model: false, fake: true, title: "under the production owned shutdown (SIGTERM to observed descendants first, then stdin end) the root exits by itself: status 0, no root signal, nothing left" },
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
	for (const key of ["model", "effort"]) {
		if (parsed[key] !== undefined && !isToken(parsed[key])) parsed.problems.push(`--${key} must be one token with no whitespace`);
	}
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
  --keep                    keep the fixture root even when every child ended cleanly
  --list | --help           print and exit 2; nothing runs

Exit 0: every selected case passed (skips allowed). 1: a case failed or is unproven. 2: nothing ran.

${WARNING}`;

/* ------------------------------------------------------------------------------------------------------------------
 * paths
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * The canonical form of an absolute path that may not exist yet: the realpath of its nearest existing ancestor with the
 * rest appended, so a reported path and the one it is compared against go through the same symlinks.
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

/** The harness's exit code from every selected case's status. */
export function exitCode(statuses) {
	if (statuses.some((status) => status === "fail" || status === "unproven")) return EXIT.failure;
	return statuses.includes("pass") ? EXIT.pass : EXIT.none;
}

/** What a second interrupt prints before exiting at once: the fixture root left behind, and that nothing was proved over. */
export function forcedExitNotice(root) {
	return [
		"interrupted again: exiting now, without cleanup, without waiting for any child, and without proving anything over",
		`  retained (uncertain): ${root}`,
		"  inspect it and any codex process this harness started yourself; nothing here says they are gone",
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

/** The version a user agent such as `originator/0.160.0 (Linux ...)` names after its first slash, or none. Unverified. */
export function versionFromUserAgent(userAgent) {
	const match = /^[^\s/]+\/(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(userAgent ?? "");
	return match ? match[1] : undefined;
}
