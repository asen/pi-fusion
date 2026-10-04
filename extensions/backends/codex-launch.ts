import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import * as path from "node:path";
import type { LaunchOptions } from "../process-tree.ts";

/**
 * Where a Codex app-server child comes from and what it is launched with, composed and nothing more: this module
 * starts no process, sends no protocol message and runs no `codex --version`. The binary, its auth and its
 * configuration are the host's own Codex install, so the environment is the host's copied as it is, and the Codex
 * home is only predicted here — for a later handshake to compare against what the child reports — never created,
 * written or read.
 *
 * The working directory is the launch's, not the protocol's: the process cwd establishes it and its realpath is what a
 * response is later checked against. Read in Codex 0.160's source and not measured, a thread request that names a cwd
 * can have the app-server record a trust entry for it in the user's configuration when that project is writable and
 * not yet trusted; that is a conditional, version-specific reading, not a universal or qualified behavior, and leaving
 * the cwd out of the protocol is how this backend avoids it either way.
 *
 * Lookup follows POSIX rules only. On Windows a `codex` on `PATH` is an npm `.cmd` shim that cannot be spawned
 * without a shell, so this build refuses there when a launch is composed rather than when the extension loads. The
 * qualification target is Linux x64; macOS runs the same POSIX code and is not claimed measured.
 */

/** The variable that names a Codex binary instead of the first `codex` on `PATH`. */
export const CODEX_BIN_VARIABLE = "PI_FUSION_CODEX_BIN";
/** Codex's own home variable, read only to predict the home a child will report, and passed through untouched. */
export const CODEX_HOME_VARIABLE = "CODEX_HOME";
/** The executable name looked up on `PATH`. */
export const CODEX_EXECUTABLE_NAME = "codex";
/** The app-server over stdio, the one protocol this backend speaks. */
export const CODEX_APP_SERVER_ARGS: readonly string[] = ["app-server", "--listen", "stdio://"];

/**
 * A script override runs under this host's own node, the way `PI_FUSION_CLAUDE_BIN` treats one: `process.execPath`,
 * never a `node` from `PATH`. That assumes a Node host; under one whose executable is not Node, such as a compiled
 * binary, a script override would not run as a script, and a native override is the one to use there.
 */
const NODE_SCRIPT = /\.(js|mjs|cjs)$/i;

/** The binary a launch runs: the command and any arguments before the app-server's own, and where it was found. */
export interface CodexExecutable {
	command: string;
	/** Arguments ahead of the app-server's: a script override's own path, since the command is then node. */
	prefix: string[];
	/** The located file, as found: the override's value or the `PATH` entry joined with `codex`, not its realpath. */
	path: string;
	source: "override" | "path";
}

export interface CodexLaunchRequest {
	/** The host's working directory, absolute and existing: the child's process cwd and the only cwd it gets. */
	cwd: string;
	/** The host's environment, copied and never changed. Defaults to this process's. */
	env?: NodeJS.ProcessEnv;
	/** Only so the Windows refusal can be exercised; a caller passes none. */
	platform?: NodeJS.Platform;
}

/** The launch, and what a later handshake checks the child against. */
export interface CodexLaunch {
	launch: LaunchOptions;
	executable: CodexExecutable;
	/** The realpath of the launch cwd, which is what the child resolves its own working directory to. */
	expectedCwd: string;
	/** The Codex home the child is expected to use, realpath'd when it exists and otherwise only normalized. */
	expectedCodexHome: string;
}

const unsupported = (platform: NodeJS.Platform): void => {
	if (platform === "win32") throw new Error(`the codex backend does not launch Codex on Windows in this build: a codex on PATH there is a .cmd shim that needs a shell, which this backend does not start`);
};

const isFile = (file: string): boolean => {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
};

const allowed = (file: string, mode: number): boolean => {
	try {
		accessSync(file, mode);
		return true;
	} catch {
		return false;
	}
};

/**
 * The override, which is an explicit choice and so is refused rather than skipped when it is not usable: a relative
 * value would depend on whichever directory the host happens to be in, and a value that is not one regular file this
 * host may run would only fail later as a spawn error with less said about why. A symlink counts as the file it
 * names. A script needs to be readable, not executable, since node is what runs it.
 */
const override = (value: string): CodexExecutable => {
	if (!path.isAbsolute(value)) throw new Error(`${CODEX_BIN_VARIABLE} must be an absolute path to the Codex binary; it is ${JSON.stringify(value)}`);
	let stat;
	try {
		stat = statSync(value);
	} catch {
		throw new Error(`${CODEX_BIN_VARIABLE} names ${JSON.stringify(value)}, which does not exist`);
	}
	if (!stat.isFile()) throw new Error(`${CODEX_BIN_VARIABLE} names ${JSON.stringify(value)}, which is not a regular file`);
	if (NODE_SCRIPT.test(value)) {
		if (!allowed(value, constants.R_OK)) throw new Error(`${CODEX_BIN_VARIABLE} names the script ${JSON.stringify(value)}, which this host cannot read`);
		return { command: process.execPath, prefix: [value], path: value, source: "override" };
	}
	if (!allowed(value, constants.X_OK)) throw new Error(`${CODEX_BIN_VARIABLE} names ${JSON.stringify(value)}, which is not executable`);
	return { command: value, prefix: [], path: value, source: "override" };
};

/**
 * The first executable regular `codex` on the inherited `PATH`, searched the way execvp would without a shell: in
 * order, an empty or relative entry resolved against the host's working directory, and a directory, a missing file or
 * one without execute permission passed over for the next. An absent `PATH` is refused rather than given a default
 * search path this module would have to choose; an empty one is a single empty entry, which is the working directory.
 */
const onPath = (env: NodeJS.ProcessEnv, cwd: string): CodexExecutable => {
	const search = env.PATH;
	if (search === undefined) throw new Error(`no PATH in the inherited environment to find ${CODEX_EXECUTABLE_NAME} on; set ${CODEX_BIN_VARIABLE} to the Codex binary's absolute path`);
	for (const entry of search.split(path.delimiter)) {
		const file = path.join(path.resolve(cwd, entry), CODEX_EXECUTABLE_NAME);
		if (isFile(file) && allowed(file, constants.X_OK)) return { command: file, prefix: [], path: file, source: "path" };
	}
	throw new Error(`no executable ${CODEX_EXECUTABLE_NAME} on PATH; install Codex or set ${CODEX_BIN_VARIABLE} to its absolute path`);
};

/**
 * The binary a Codex child runs: `PI_FUSION_CODEX_BIN` when set, else the first executable `codex` on `PATH`. A blank
 * override counts as unset, as `PI_FUSION_CLAUDE_BIN`'s does. Nothing is run to check it is Codex.
 */
export function locateCodex(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform = process.platform): CodexExecutable {
	unsupported(platform);
	const value = env[CODEX_BIN_VARIABLE]?.trim();
	return value ? override(value) : onPath(env, cwd);
}

/** A realpath where there is something to resolve, and otherwise the normalized path, so nothing has to exist. */
const resolved = (file: string): string => {
	try {
		return realpathSync.native(file);
	} catch {
		return path.normalize(file);
	}
};

/**
 * The Codex home a child launched with this environment and cwd is expected to use: a non-empty `CODEX_HOME`, which a
 * relative value makes relative to the child's cwd, or else `.codex` in the user's home — `HOME` when it is non-empty
 * and the account's own home otherwise. This is the prediction a handshake checks, not a decision: the value is not
 * trimmed or rewritten in the child's environment, a home that does not exist is not created, and one that does is
 * not read. An account with no home to look up — no passwd entry, or an empty one — is refused by the variables that
 * would have named one, rather than surfacing the lookup's own system error.
 *
 * `accountHome` is only so that refusal can be exercised without changing the user this process runs as; a caller
 * passes none.
 */
export function expectedCodexHome(env: NodeJS.ProcessEnv, cwd: string, accountHome: () => string = () => userInfo().homedir): string {
	const configured = env[CODEX_HOME_VARIABLE];
	if (configured) return resolved(path.resolve(cwd, configured));
	let home = env.HOME;
	if (!home) {
		try {
			home = accountHome();
		} catch {
			home = undefined;
		}
	}
	if (!home) throw new Error(`neither ${CODEX_HOME_VARIABLE} nor HOME is set and this account has no home directory to look up, so the Codex home a child would use cannot be known; set ${CODEX_HOME_VARIABLE} or HOME`);
	return resolved(path.join(home, ".codex"));
}

/** The host working directory, which has to be an existing directory named absolutely, and its realpath. */
const workingDirectory = (cwd: string): string => {
	if (!cwd || !path.isAbsolute(cwd)) throw new Error(`the codex child's working directory must be an absolute path; it is ${JSON.stringify(cwd)}`);
	let real;
	try {
		real = realpathSync.native(cwd);
	} catch {
		throw new Error(`the codex child's working directory ${JSON.stringify(cwd)} does not exist`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`the codex child's working directory ${JSON.stringify(cwd)} is not a directory`);
	return real;
};

/**
 * The app-server launch for one call, and only its options: nothing here spawns. The environment is a copy of the
 * host's with nothing added or removed, so the child reads the user's own Codex home, auth and configuration.
 */
export function codexLaunch(request: CodexLaunchRequest): CodexLaunch {
	const platform = request.platform ?? process.platform;
	unsupported(platform);
	const env = request.env ?? process.env;
	const expectedCwd = workingDirectory(request.cwd);
	const executable = locateCodex(env, request.cwd, platform);
	return {
		launch: { command: executable.command, args: [...executable.prefix, ...CODEX_APP_SERVER_ARGS], cwd: request.cwd, env: { ...env } },
		executable,
		expectedCwd,
		expectedCodexHome: expectedCodexHome(env, request.cwd),
	};
}
