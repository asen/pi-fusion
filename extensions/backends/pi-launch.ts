import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { LaunchOptions } from "../process-tree.ts";
import type { PiRole } from "./pi-binding.ts";
import { QUESTION_TOOL_NAME } from "./pi-question-tool.mjs";
import { type CallStorage, JITI_CACHE_DIR, NODE_CACHE_DIR } from "./pi-storage.ts";
import { piModelParts, type PiSessionRef } from "./types.ts";

/**
 * What a Pi child is launched with: the input the bootstrap reads, and the process options that run it. Both are
 * composed and nothing more — this module opens no session, starts no process and reads no configuration of the
 * user's. The input is one serializable record with a version on it, because the bootstrap is a separate program
 * reading a file rather than a function taking objects, and a version is how a child from another install says so.
 * The role's tools and resources come from the role: this module composes a call's own additions onto them and
 * decides what a resource path may be, and keeps no list of its own — the one name it adds, for a call that asks for
 * questions, is the question tool's own. What a composed path has to be on the machine it
 * names — there, readable, one file or one directory — is the bootstrap's own check, and every role in this build names
 * no resource at all, so a child of it loads none.
 */

/** The shape of the input file. A bootstrap that reads a version it does not know refuses the call. */
export const BOOTSTRAP_INPUT_VERSION = 1;

/** The bootstrap this host runs, beside this module in the same install: there is no variable that names another. */
export const PI_BOOTSTRAP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-bootstrap.mjs");

/** The environment variable Pi reads its agent directory from, which the child's points at the Fusion-owned one. */
export const PI_AGENT_DIR_VARIABLE = "PI_CODING_AGENT_DIR";

/** The search path a child's helpers are looked up on, and the one variable this launch appends to rather than sets. */
export const PATH_VARIABLE = "PATH";

/**
 * The session the child constructs: a fresh one, or the recorded one reopened at the point the record named. `open`
 * is a constructor argument and not permission to do anything with the session: navigating to the checkpoint,
 * refusing a failed tip and guarding a fork are the bridge's, and are not in this module or in the bootstrap.
 */
export type BootstrapSession = { kind: "new" } | { kind: "open"; file: string; sessionId: string; checkpoint?: string };

/** A recorded Pi session as the child is asked to reopen it: the file and the id together, which is Pi's identity. */
export const openSession = (ref: PiSessionRef): BootstrapSession => ({
	kind: "open",
	file: ref.sessionFile,
	sessionId: ref.sessionId,
	...(ref.checkpoint === undefined ? {} : { checkpoint: ref.checkpoint }),
});

/** The model the child selects, split where Pi splits it, so the bootstrap resolves an exact pair and guesses nothing. */
export interface BootstrapModel {
	provider: string;
	model: string;
}

/** Everything the bootstrap needs, and nothing it could read for itself from the user's profile or the environment. */
export interface BootstrapInput {
	version: number;
	/** The role's name, for the diagnostics the bootstrap writes. It binds nothing on its own. */
	role: string;
	cwd: string;
	/** The stable child agent directory, which is also what the child's `PI_CODING_AGENT_DIR` names. */
	agentDir: string;
	sessionDir: string;
	/**
	 * The models file the child reads: the user's own where they have one, and this call's absent private path where
	 * they do not. Never null and never absent as a field, because `ModelRuntime.create` given no models file at all
	 * falls back to an in-memory catalog store and ignores `modelsStorePath`, which would drop the persistent store
	 * this layout publishes. A path that does not exist loads as an empty configuration and keeps the shared store.
	 */
	modelsPath: string;
	authPath: string;
	modelsStorePath: string;
	model: BootstrapModel;
	/** Pi's own thinking level. Absent leaves the child the level the model comes with. */
	thinkingLevel?: string;
	tools: string[];
	/**
	 * Whether this call's child runs Fusion's own question tool. Always written, never absent: a child reads one field
	 * rather than inferring the tool from a name in `tools`, which is a list the role owns. When it is true the tool's
	 * own name is in `tools` as well, because the session's allow list is what makes a tool active at all.
	 */
	questionTool: boolean;
	/** The role contract's prose, read by the host: the bootstrap appends this text and opens no contract file. */
	contract: string;
	/**
	 * Local resource paths, absolute: the role's own lists with this call's internal additions after them, composed and
	 * validated for their syntax here. Every role in this build names none, so a child of it loads none; a path that is
	 * composed here is checked against the filesystem by the bootstrap before it reaches the resource loader.
	 */
	extensions: string[];
	skills: string[];
	/** Whether the child may refresh its model catalog over the network. */
	allowModelNetwork: boolean;
	session: BootstrapSession;
	/** Where a catalog refresh would go instead of the real endpoint. Internal, for a loopback harness, never a user setting. */
	catalogBaseUrl?: string;
}

export interface BootstrapRequest {
	role: PiRole;
	/**
	 * The storage this call runs on, which is also where its working directory comes from: there is no second cwd to
	 * pass, because a directory other than the one the session directory was derived from would run one project's
	 * child against another project's sessions.
	 */
	storage: CallStorage;
	session: BootstrapSession;
	/**
	 * Whether this call's child may ask the host a question. Internal, for a caller inside Fusion: there is no
	 * parameter, variable or setting a user turns it on through, and a runner asks for it when it has somewhere to send
	 * a question. Absent is no question tool at all, which is what a call that cannot answer one composes.
	 */
	questions?: boolean;
	/** The contract's prose, already read by the host. */
	contract: string;
	/**
	 * Resources this one call adds to the role's own lists, appended after them. Internal, for a caller inside Fusion:
	 * there is no parameter, variable or file a user names a resource through, and a role's own metadata is where a
	 * resource this build ships would be named.
	 */
	extensions?: readonly string[];
	skills?: readonly string[];
	catalogBaseUrl?: string;
}

const absolute = (what: string, value: string): string => {
	if (!value || !path.isAbsolute(value)) throw new Error(`${what} must be an absolute path for a pi child; it is ${JSON.stringify(value)}`);
	return value;
};

/**
 * A scheme at the front of an entry: a letter, then letters, digits and `+`, `.` or `-`, up to the colon. Every form
 * something would have to fetch, install or interpret before a child could load it starts this way — `npm:`, `git:`,
 * `github:`, `http:`, `https:`, `ssh:`, `file:` and `data:` alike — so the rule is the shape rather than a list of
 * names that would have to grow every time another one appeared.
 */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** The one colon that is a path and not a scheme: a Windows drive, which is a single letter and then a separator. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
/** How a caller writes a relative path whose own first segment holds a colon, which is otherwise read as a scheme. */
const DISAMBIGUATE = "a relative path whose first segment holds a colon is written with a leading ./";

/**
 * One resource entry as a local path. The error names the field, the entry's index and the rule it broke and never the
 * entry itself: a specifier can carry a token or a host nobody wants in a diagnostic the host keeps, and the caller
 * composed the list and knows what is in it. A relative entry is resolved against the child's working directory,
 * because that is the only thing a call names a resource relative to; an absolute one is kept as it is. Nothing is
 * expanded and nothing is looked up: there is no `~`, no variable and no glob language here, so `*`, `?` and `[` are
 * the ordinary filename characters they are on a filesystem, and whether the path exists is the child's own check.
 * A rejected entry is rejected by its syntax alone: nothing here parses a url, resolves a scheme or asks a filesystem.
 */
const resourcePath = (field: "extensions" | "skills", index: number, value: string, cwd: string): string => {
	// Trimmed before the shape is read as well as after: a leading space in a composed path is a mistake either way,
	// and leaving it would let ` npm:pkg` past a check the untrimmed entry would have failed.
	const entry = typeof value === "string" ? value.trim() : "";
	if (!entry) throw new Error(`${field}[${index}] is blank; a resource entry is a local path on this machine`);
	if (entry.includes("://")) throw new Error(`${field}[${index}] is a url, and a child loads local paths only: it installs nothing and fetches nothing`);
	if (URI_SCHEME.test(entry) && !WINDOWS_DRIVE.test(entry)) {
		throw new Error(`${field}[${index}] starts with a uri scheme, and a child loads local paths only: it installs nothing and fetches nothing; ${DISAMBIGUATE}`);
	}
	return path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
};

/** A role's own resources with this call's additions after them, each one checked and resolved before it is composed. */
const resources = (field: "extensions" | "skills", role: readonly string[], added: readonly string[] | undefined, cwd: string): string[] =>
	[...role, ...(added ?? [])].map((entry, index) => resourcePath(field, index, entry, cwd));

/**
 * The tools the role names, or an error: a role with no list gets none guessed for it here or anywhere else. A call
 * that asks for questions has the question tool's own name appended after the role's, once, because that list is the
 * allow list the session is built with and a tool outside it never becomes active however it was registered. The
 * role's own list is copied rather than changed, so a role that names the tool already is not given it twice and no
 * caller's array is written to.
 */
const roleTools = (role: PiRole, questions: boolean): string[] => {
	const tools = [...role.tools];
	if (!tools.length) throw new Error(`role ${role.name} has no pi tool list; a role runs with the tools its binding names and none are inferred`);
	tools.forEach((tool, index) => {
		if (!tool.trim()) throw new Error(`role ${role.name} names a blank tool at tools[${index}]; a tool is named by the name Pi knows it as`);
	});
	if (questions && !tools.includes(QUESTION_TOOL_NAME)) tools.push(QUESTION_TOOL_NAME);
	return tools;
};

/**
 * The input one call's child is launched with. `allowModelNetwork` is true here and said so explicitly rather than
 * left to Pi's default, which is false: a child may refresh the catalog it shares with the other children of this
 * host, so a model the user configured after that catalog was last written is one a call can still reach. It is
 * permission and not a requirement, and it is not the whole answer either — read in 0.85.1's own source, and not
 * measured here, Pi's runtime asks whether `PI_OFFLINE` is set at all, so a user who has it set to anything, `0` and
 * an empty string included, would have no catalog refresh whatever this field says. The matrix that would measure
 * that variable's values against a real child has not been run, so nothing here says every startup network failure
 * is harmless. A refresh is never forced and no call depends on one.
 */
export function bootstrapInput(request: BootstrapRequest): BootstrapInput {
	const model = piModelParts(request.role.model);
	if (!model) throw new Error(`role ${request.role.name} names model ${JSON.stringify(request.role.model)}, which is not a pi provider and model id such as deepseek/deepseek-chat`);
	const contract = request.contract.trim();
	if (!contract) throw new Error(`role ${request.role.name} has no contract text; the child's prompt is Pi's own plus this role's contract, so an empty one is a call with no contract`);
	const cwd = absolute("the child's working directory", request.storage.cwd);
	const questions = request.questions === true;
	const extensions = resources("extensions", request.role.extensions, request.extensions, cwd);
	const skills = resources("skills", request.role.skills, request.skills, cwd);
	const session: BootstrapSession = request.session.kind === "new" ? { kind: "new" } : { ...request.session, file: absolute("a recorded session file", request.session.file) };
	return {
		version: BOOTSTRAP_INPUT_VERSION,
		role: request.role.name,
		cwd,
		agentDir: absolute("the child agent directory", request.storage.agentDir),
		sessionDir: absolute("the session directory", request.storage.sessionDir),
		modelsPath: absolute("the models file", request.storage.modelsPath ?? request.storage.privateModelsPath),
		authPath: absolute("the auth file", request.storage.authPath),
		modelsStorePath: absolute("the model catalog store", request.storage.modelsStorePath),
		model,
		...(request.role.effort === undefined ? {} : { thinkingLevel: request.role.effort }),
		tools: roleTools(request.role, questions),
		questionTool: questions,
		contract,
		extensions,
		skills,
		allowModelNetwork: true,
		session,
		...(request.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: request.catalogBaseUrl }),
	};
}

/** The marker a Pi child of this extension carries, so the copy of Fusion that child loads registers nothing at all. */
export const PI_CHILD_VARIABLE = "PI_FUSION_CHILD";
export const PI_CHILD_MARKER = "pi";

/** Node's own compile cache, which this variable alone turns on: an environment without it stays without it. */
export const NODE_COMPILE_CACHE_VARIABLE = "NODE_COMPILE_CACHE";
/** The filesystem cache jiti writes, which is how Pi's loader caches what it compiles. */
export const JITI_CACHE_VARIABLE = "JITI_FS_CACHE";

export interface LaunchRequest {
	input: BootstrapInput;
	/**
	 * The storage this call was prepared on, which is where the input file and the compiler caches are: a launch names
	 * no path of its own, so a child cannot be pointed at an input or a cache outside the directory its call owns.
	 */
	storage: CallStorage;
	/** The host's environment, copied and never changed: the host's own `PI_CODING_AGENT_DIR` stays what it is. */
	env?: NodeJS.ProcessEnv;
	/** The bootstrap to run. Defaults to the one installed beside this module. */
	bootstrap?: string;
}

/**
 * Every key an environment spells one variable with and gives a value to. On Windows a variable name is case
 * insensitive, so an inherited `Node_Compile_Cache` is the same variable as `NODE_COMPILE_CACHE`: writing the
 * canonical spelling beside it would leave two keys for one variable and the child could read the inherited one, so
 * each spelling that is there is rewritten where it is. On POSIX a name is a name, and only the exact one counts.
 */
const spellings = (env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string[] => {
	if (platform !== "win32") return env[name] === undefined ? [] : [name];
	const lower = name.toLowerCase();
	return Object.keys(env).filter((key) => key.toLowerCase() === lower && env[key] !== undefined);
};

/** A variable this launch sets, under every spelling the environment already carries it under, or under its own name. */
const setVariable = (env: NodeJS.ProcessEnv, name: string, value: string, platform: NodeJS.Platform): void => {
	const keys = spellings(env, name, platform);
	for (const key of keys.length ? keys : [name]) env[key] = value;
};

/**
 * The one character a search path is split on, which is the target platform's and not this process's: a launch is
 * composed for the platform its naming rule is being read against, and on POSIX a semicolon is an ordinary filename
 * character while on Windows a colon is the one a drive letter carries.
 */
const pathDelimiter = (platform: NodeJS.Platform): string => (platform === "win32" ? ";" : ":");

/** What a launch can do with the host's helper bin: append it to the child's search path, or one of two reasons not to. */
export type HostBinPlacement = "appended" | "no-path" | "unrepresentable";

/**
 * Whether the host's helper bin can go on a child's search path at all, decided before anything is written and with
 * no environment changed: this reads, and `childEnvironment` is the one caller that acts on the answer.
 *
 * `no-path` is an environment with no non-empty spelling of `PATH` in it, which is the deliberate exception below:
 * an absent or an empty search path is left exactly as it is. `unrepresentable` is a bin whose own path holds the
 * delimiter that platform splits a search path on — a legitimate directory name, which a `PATH` entry simply cannot
 * carry, since appending it would add two entries and one of them relative. Reuse of the host's helpers is an
 * optimization, so the answer there is to skip the append and run the call, not to refuse a call over the name of a
 * directory nothing has been asked to look in. Nothing here quotes, escapes or invents a second directory for it.
 */
export function hostBinPlacement(env: NodeJS.ProcessEnv, hostBinDir: string, platform: NodeJS.Platform = process.platform): HostBinPlacement {
	const carried = spellings(env, PATH_VARIABLE, platform).filter((key) => env[key] !== "");
	if (!carried.length) return "no-path";
	return hostBinDir.includes(pathDelimiter(platform)) ? "unrepresentable" : "appended";
}

/**
 * The paths a launch reads from both sides, which have to be the one call's: the input says where the child works and
 * which directories it writes, and the storage says where its input file and its caches are. One call's input beside
 * another call's storage would run a child in one project's working directory against another call's cache and input,
 * so it is refused here rather than launched. The fields are named and the paths are not: a caller that composed both
 * knows what it passed, and a mismatch is about which call this is, not about what either path says.
 */
const sameCall = (request: LaunchRequest): void => {
	for (const field of ["cwd", "agentDir", "sessionDir"] as const) {
		if (request.input[field] !== request.storage[field]) {
			throw new Error(`the call input's ${field} is not the ${field} of the storage this launch was given; an input and a launch belong to one call, and these are two`);
		}
	}
};

/**
 * The environment a child runs in: a copy of the host's, with the Fusion-owned agent directory, the marker that says
 * this process is a Pi child of Fusion, and the compiler caches pointed inside this call's own directory, which is
 * disposed of with it. jiti's cache is always this call's own. Node's compile cache is a cache the variable itself
 * turns on, so what the environment says about it is preserved: absent stays absent and an empty value stays empty,
 * both of which leave the cache off, while any non-empty value is a directory name — measured on Node v24.18.0, where
 * `" "` and `"0"` each enable the cache in a directory of that name — and is retargeted into this call's own. Nothing
 * is trimmed and nothing is read as a boolean. `PI_OFFLINE` is copied exactly as the user set it — unset, empty, `0`
 * or truthy alike — because Pi reads it in more than one way and normalising it here would decide something the user
 * did not.
 *
 * The host agent directory's own `bin` is appended to the child's `PATH`, and to the child's alone: it is where Pi
 * puts the helpers it downloads, so a child of a host that already has `rg` or `fd` there finds one instead of
 * fetching it again. Appended rather than prepended, so nothing of the host's takes precedence over what the user's
 * own `PATH` already resolves, and exactly concatenated: the existing value is not trimmed, split, deduplicated or
 * normalised, so a value that already ends in the delimiter keeps the empty entry that delimiter makes, which is the
 * entry the user wrote. A `PATH` that is absent stays absent and an empty one stays empty, and that is a deliberate
 * exception rather than an oversight: writing the bin into either would leave the child searching one directory of
 * Fusion's choosing instead of whatever an absent or empty `PATH` means to the platform's own lookup, which is a
 * search rule this module has no business replacing. The second exception is a bin whose own absolute path holds that
 * platform's delimiter, which `hostBinPlacement` calls unrepresentable: an entry in a search path cannot carry the
 * character the path is split on, so the append is skipped and every spelling is left byte for byte what it was.
 * Reuse is an optimization and a legitimate agent-directory name is not a reason to refuse a call. A child in either
 * case reuses no host helper, and none is claimed for it.
 *
 * `platform` is a parameter so the other platform's variable-naming rule can be exercised at all; a caller passes
 * none, and a rule tested this way is tested as logic and says nothing about how that platform actually behaves.
 */
export function childEnvironment(request: LaunchRequest, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
	sameCall(request);
	const cacheDir = absolute("the call cache directory", request.storage.cacheDir);
	const hostBinDir = absolute("the host helper bin directory", request.storage.hostBinDir);
	const env: NodeJS.ProcessEnv = { ...(request.env ?? process.env) };
	setVariable(env, PI_AGENT_DIR_VARIABLE, absolute("the child agent directory", request.input.agentDir), platform);
	setVariable(env, PI_CHILD_VARIABLE, PI_CHILD_MARKER, platform);
	setVariable(env, JITI_CACHE_VARIABLE, path.join(cacheDir, JITI_CACHE_DIR), platform);
	// Per spelling, so an inherited empty value keeps the cache off under the name the environment already spells it
	// with, and a spelling that names a directory is the one pointed at this call's own.
	for (const key of spellings(env, NODE_COMPILE_CACHE_VARIABLE, platform)) {
		if (env[key] !== "") env[key] = path.join(cacheDir, NODE_CACHE_DIR);
	}
	// Per spelling as well, for the same reason the caches are: on Windows an inherited `Path` is the search path, and
	// a canonical `PATH` written beside it would be a second key for one variable. Whether the bin can go on a search
	// path at all is `hostBinPlacement`'s single answer rather than a rule repeated here, so the two cannot drift.
	if (hostBinPlacement(env, hostBinDir, platform) === "appended") {
		const delimiter = pathDelimiter(platform);
		for (const key of spellings(env, PATH_VARIABLE, platform)) {
			if (env[key] !== "") env[key] = `${env[key]}${delimiter}${hostBinDir}`;
		}
	}
	return env;
}

/**
 * The options a Pi child is launched with, and only those: nothing here spawns anything. `node` comes from `PATH`,
 * the way decision 7 settles it, and the input the child reads is the one its own call storage holds. The environment
 * is composed first, because that is what refuses an input and a storage that are not the same call's.
 */
export function piLaunch(request: LaunchRequest): LaunchOptions {
	const env = childEnvironment(request);
	return {
		command: "node",
		args: [request.bootstrap ?? PI_BOOTSTRAP_PATH, absolute("the call input file", request.storage.inputPath)],
		cwd: absolute("the child's working directory", request.input.cwd),
		env,
	};
}

/**
 * The host's own agent directory, through the SDK's public accessor and only when a call asks for it. The import is
 * dynamic on purpose: loading the package settles the user's configuration paths, and a host that never delegates to
 * Pi should not read them because this module was imported.
 */
export async function hostAgentDir(): Promise<string> {
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	return getAgentDir();
}
