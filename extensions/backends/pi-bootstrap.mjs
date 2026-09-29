import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_UNAVAILABLE, withHelperRetry } from "./pi-helper-retry.mjs";
import { QUESTION_TOOL_NAME, questionTool } from "./pi-question-tool.mjs";

/**
 * The program a Pi child runs. Plain ESM on purpose: a node from `PATH` runs this file with no loader, no bundler and
 * no TypeScript step between them. Two packages reach it, both resolved from its own location and neither installed by
 * it: the public Pi SDK, and `typebox` through `./pi-question-tool.mjs`, which is the schema language a public tool
 * definition is written in and the same package the host's own tools are written against. Whether one copy of it ends
 * up serving both is a package manager's business and is claimed nowhere here. There is no stock CLI, no migration, no
 * private import, no provider client of its own and nothing it installs.
 *
 * The two reach it differently, and only one of them is reported. The SDK is loaded inside `loadSdk` and read by
 * `checkSdk`, so a missing install or an incompatible API is an actionable startup failure naming the version it
 * found. `typebox` is an ordinary static import of this module: a failure to resolve or evaluate it happens before
 * `main` runs at all, which is node's own module error on stderr and no diagnostic of this bootstrap's, because there
 * is no stage to report it in and nothing here catches it.
 *
 * Everything it composes is passed in. The host writes one input file and this reads it, so a child from another
 * install refuses a shape it does not know rather than guessing at it, and the SDK is a parameter to every function
 * below so a test can hand in a double instead of starting a real Pi. Nothing here reads a variable of its own.
 */

/** The input shape this bootstrap reads. It has to match `BOOTSTRAP_INPUT_VERSION` in `pi-launch.ts`. */
export const BOOTSTRAP_INPUT_VERSION = 1;

/** What the process exits with when it could not start at all: a configuration failure, in sysexits terms. */
export const STARTUP_EXIT_CODE = 78;

/** How a diagnostic line says who wrote it, so a transport reading stderr can tell it from a child's own output. */
export const DIAGNOSTIC_EVENT = "pi-fusion-bootstrap";

export const SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * The thinking levels Pi has. Repeated here rather than imported, because this file is plain ESM with no build step
 * between it and node; `test/pi-bootstrap.test.ts` asserts it is the same list the TypeScript side validates against.
 * Which of them a given model offers, and what the child read back, are the bridge's checks and not these.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The package-level functions this bootstrap calls. The two search-tool factories are among them because the retry a
 * default call installs is built out of them: an install that does not export them cannot have it, and that is a
 * compatibility refusal through the one mechanism rather than a call that quietly starts without it.
 */
const REQUIRED_FUNCTIONS = [
	"createAgentSessionServices",
	"createAgentSessionFromServices",
	"createAgentSessionRuntime",
	"runRpcMode",
	"parseSessionEntries",
	"createGrepToolDefinition",
	"createFindToolDefinition",
];
/** The statics it calls on the classes the package exports. */
const REQUIRED_STATICS = { SettingsManager: ["inMemory"], ModelRuntime: ["create"], SessionManager: ["create", "open"] };

/** A failure before the child could serve anything, with the stage it happened in. */
export class StartupError extends Error {
	constructor(stage, message, options) {
		super(message, options);
		this.name = "StartupError";
		this.stage = stage;
	}
}

/**
 * What a diagnostic says, and the only thing it says. The keys are fixed: a stage, the SDK version where one is
 * known, and an error where there is one. No session id, no transcript path and nothing from a credential ever goes
 * in a line here — the session this child runs in is read back over RPC and returned through the outcome the host
 * already has a contract for, which is where an identity belongs.
 */
export function diagnostic(stage, detail = {}) {
	const line = { event: DIAGNOSTIC_EVENT, stage };
	if (detail.sdk !== undefined) line.sdk = detail.sdk;
	if (detail.error !== undefined) line.error = String(detail.error);
	return JSON.stringify(line);
}

/** Writes one diagnostic line to stderr. stdout belongs to `runRpcMode` alone, so nothing here ever writes there. */
export function report(stage, detail = {}) {
	process.stderr.write(`${diagnostic(stage, detail)}\n`);
}

const failureText = (error) => (error instanceof Error && error.message ? error.message : String(error));
const codeOf = (error) => {
	const code = error?.code;
	return typeof code === "string" ? code : undefined;
};
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
/** Where this bootstrap itself lives, which is where its SDK is resolved from. */
const own = () => path.dirname(fileURLToPath(import.meta.url));

/**
 * The SDK's own surface, checked against what this bootstrap actually calls. `VERSION` is metadata rather than a
 * capability: a package that works and does not say which version it is still works, so it reports `unknown` instead
 * of refusing the call over a missing string.
 */
export function checkSdk(pkg) {
	const api = pkg ?? {};
	const version = isText(api.VERSION) ? api.VERSION.trim() : "unknown";
	const missing = [];
	for (const name of REQUIRED_FUNCTIONS) if (typeof api[name] !== "function") missing.push(`${name}()`);
	for (const [holder, statics] of Object.entries(REQUIRED_STATICS)) {
		for (const name of statics) if (typeof api[holder]?.[name] !== "function") missing.push(`${holder}.${name}()`);
	}
	if (typeof api.CURRENT_SESSION_VERSION !== "number") missing.push("CURRENT_SESSION_VERSION");
	if (missing.length) {
		throw new StartupError(
			"sdk",
			`${SDK_PACKAGE} ${version} at ${own()} does not provide the public API this bootstrap runs on: ${missing.join(", ")}. Install a version that exports all of them beside the bootstrap; nothing is installed or worked around here`,
		);
	}
	return { version, sessionVersion: api.CURRENT_SESSION_VERSION };
}

/** The installed SDK, resolved from this file's own location rather than from the working directory it runs in. */
export async function loadSdk() {
	try {
		return await import(SDK_PACKAGE);
	} catch (error) {
		throw new StartupError("sdk", `${SDK_PACKAGE} could not be imported from ${own()}: ${failureText(error)}. Install it beside the bootstrap; nothing is installed automatically here`, { cause: error });
	}
}

/**
 * A scheme at the front of an entry, and the one colon that is a path instead: a Windows drive, a single letter and
 * then a separator. These are the host composer's own two rules, repeated here because a child checks what it was
 * handed rather than trusting whoever handed it over, and because the resource loader turns a specifier into an
 * install: the shape that could become one is refused before this bootstrap has imported the SDK at all.
 */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * How a resource path is looked at: a parameter with this default rather than a call into `node:fs` at the point of
 * use, because the access rules have to be exercised against a filesystem that reports a path this process may not
 * use, and as root a mode of 000 is still readable. A test hands one in; production passes none, and no field of the
 * input, no variable and no argument names another.
 *
 * What `readable` asks for depends on the kind, because the two kinds are used differently. A regular file is opened
 * and read, which on a POSIX system is `R_OK`. A directory is listed and then walked into: on POSIX, `R_OK` on a
 * directory is permission to read the list of names it holds, and `X_OK` — search permission — is what permits
 * resolving one of those names and reaching what it holds, so a directory with one and not the other is a directory
 * the loader can name entries in and not open them, or open a known path in and not enumerate it. The loader does
 * both, so both are asked for. On Windows, Node documents `X_OK` as having no effect and behaving like `F_OK`, which
 * makes the composed mode there the same check as `R_OK` alone; that is what Node's documentation says rather than
 * anything this build has measured on a Windows runtime.
 */
export const resourceProbe = {
	stat: (file) => statSync(file),
	readable: (file, kind) => accessSync(file, kind === "directory" ? constants.R_OK | constants.X_OK : constants.R_OK),
};

/**
 * The suffix this Pi loads an explicit skill file by. `loadSkills` in 0.85.1 takes a skill path that is a regular file
 * only when the path ends in `.md`, compared exactly and so in lower case; a regular file with any other name is
 * answered with a `warning` diagnostic and produces no skill at all. A warning is not something a call is refused for
 * — it is the loader saying something and going on — so a role that named a `.txt` would start with the skill it asked
 * for silently absent. That is the case this suffix rule exists for, and it is a rule about what the loader does with
 * the file rather than a preference about how a file should be named. A directory is the other eligible kind and has
 * no name rule of its own here: what the loader finds inside one is a check this build does not make yet.
 */
const SKILL_SUFFIX = ".md";

/**
 * One resource entry, as the resource loader is about to be handed it: a local absolute path that is on this machine,
 * that this child may read, and that is one regular file or one directory. Each of those is a refusal here rather than
 * something the call runs past, because the loader's own answer to a path that is not there is an error in a list it
 * returns, and its own answer to a specifier is an install. Nothing is expanded, resolved, matched or fetched: `*`, `?`
 * and `[` are the ordinary filename characters they are, so existence is this literal path's own, and the entry is read
 * exactly as it was composed — a trailing space belongs to a filename on this filesystem rather than to a mistake.
 *
 * The message names the field, the index and the rule and never the entry: a composed path carries a project's name and
 * can carry a token, a diagnostic goes to stderr where the host keeps it, and the host composed the list and knows what
 * is in it. A filesystem's own error code is named where there is one, which says which rule failed and nothing else.
 */
const resourceEntry = (field, index, value, probe) => {
	const where = `the call input's ${field}[${index}]`;
	if (!isText(value)) throw new StartupError("input", `${where} is blank; a resource entry is a local path on this machine`);
	if (value.includes("://")) throw new StartupError("input", `${where} is a url, and a child loads local paths only: it installs nothing and fetches nothing`);
	if (URI_SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) {
		throw new StartupError("input", `${where} starts with a uri scheme, and a child loads local paths only: it installs nothing and fetches nothing`);
	}
	if (!path.isAbsolute(value)) {
		throw new StartupError("input", `${where} is not an absolute path; the host resolves a resource against the child's working directory before it composes the call, and a child resolves none of its own`);
	}
	let stats;
	try {
		stats = probe.stat(value);
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") throw new StartupError("input", `${where} is not on this machine; a resource is an existing local path, and nothing is installed or fetched to make one`);
		throw new StartupError("input", `${where} could not be looked at (${code ?? "no code"}); a resource this child cannot examine is refused rather than handed to the loader`);
	}
	const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : undefined;
	if (!kind) throw new StartupError("input", `${where} is neither a regular file nor a directory, and a resource is one file or one directory`);
	if (field === "skills" && kind === "file" && !path.basename(value).endsWith(SKILL_SUFFIX)) {
		throw new StartupError(
			"input",
			`${where} is a regular file whose name does not end in ${SKILL_SUFFIX}, and this Pi loads a skill from a file only when it does, compared exactly and so in lower case. Any other regular file is answered with a warning and no skill at all, which would start the child without the skill its role named, so it is refused here instead. Name the file with a ${SKILL_SUFFIX} suffix, or name the directory that holds it`,
		);
	}
	try {
		probe.readable(value, kind);
	} catch (error) {
		const code = codeOf(error) ?? "no code";
		throw new StartupError(
			"input",
			kind === "directory"
				? `${where} cannot be read and searched by this child (${code}); a directory the loader has to list and walk into is refused rather than half read`
				: `${where} cannot be read by this child (${code}); a resource it cannot read is refused rather than skipped`,
		);
	}
	return value;
};

/**
 * A field that has to be an absolute path. The message names the field and never the value: a rejected path can be a
 * transcript file or an auth file, and a diagnostic goes to stderr where the host reads it, so what went wrong is
 * said without repeating what it was. The host knows which paths it passed.
 */
const absolute = (field, value) => {
	if (!isText(value) || !path.isAbsolute(value)) throw new StartupError("input", `the call input's ${field} must be an absolute path, and it is not`);
	return value;
};

/**
 * The call input, checked field by field. Nothing unchecked reaches a session, a settings manager or the loader, and
 * every resource path is checked against the filesystem here, which is before the SDK is imported: a path that is not
 * there, one this child may not read and one that is neither a file nor a directory each fail the call while the only
 * thing that has happened is that a file was read and parsed.
 */
export function checkInput(value, probe = resourceProbe) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new StartupError("input", "the call input is not an object");
	if (value.version !== BOOTSTRAP_INPUT_VERSION) {
		throw new StartupError("input", `the call input names version ${JSON.stringify(value.version)} and this bootstrap reads version ${BOOTSTRAP_INPUT_VERSION}; the host and the child come from different installs`);
	}
	if (!isText(value.role)) throw new StartupError("input", "the call input names no role");
	for (const field of ["cwd", "agentDir", "sessionDir", "authPath", "modelsStorePath", "modelsPath"]) absolute(field, value[field]);
	if (!value.model || typeof value.model !== "object" || !isText(value.model.provider) || !isText(value.model.model)) {
		throw new StartupError("input", "the call input names no provider and model id; a child selects one exact model and resolves none for itself");
	}
	if (value.thinkingLevel !== undefined && !THINKING_LEVELS.includes(value.thinkingLevel)) {
		throw new StartupError("input", `the call input's thinkingLevel is ${JSON.stringify(value.thinkingLevel)}, which is not one of ${THINKING_LEVELS.join(", ")}`);
	}
	// A name is a non-blank name and nothing more: a tool an extension registers is named the way its extension names
	// it, so the list is not checked against Pi's builtins here. Whether each of these tools is actually on the session
	// is checked where it can be, on the session the moment it exists, by `checkTools` below.
	if (!Array.isArray(value.tools) || value.tools.length === 0 || !value.tools.every(isText)) throw new StartupError("input", "the call input names no tools; a role's tool list is explicit and is never inferred here");
	// Absent is no question tool: an input composed before this field existed, or hand-built by a caller that cannot
	// answer a question, is a call that runs without it rather than one this bootstrap decides for. A value that is
	// neither absent nor a boolean is refused by its field alone, the way every other input rule names one.
	if (value.questionTool !== undefined && typeof value.questionTool !== "boolean") {
		throw new StartupError("input", "the call input's questionTool is not a boolean; whether a child runs the question tool is said outright or not at all");
	}
	if (value.questionTool === true && !value.tools.includes(QUESTION_TOOL_NAME)) {
		throw new StartupError(
			"input",
			`the call input asks for the question tool and its tools do not name ${QUESTION_TOOL_NAME}; the role's list is the allow list the session is built with, so a tool outside it never becomes active however it was registered`,
		);
	}
	if (!isText(value.contract)) throw new StartupError("input", "the call input carries no contract text; the child's prompt is Pi's own plus the role contract");
	for (const field of ["extensions", "skills"]) {
		if (!Array.isArray(value[field])) throw new StartupError("input", `the call input's ${field} is not a list`);
		for (let index = 0; index < value[field].length; index++) resourceEntry(field, index, value[field][index], probe);
	}
	if (typeof value.allowModelNetwork !== "boolean") throw new StartupError("input", "the call input does not say whether the child may refresh its model catalog over the network");
	const session = value.session;
	if (!session || typeof session !== "object") throw new StartupError("input", "the call input names no session");
	if (session.kind === "open") {
		absolute("session.file", session.file);
		if (!isText(session.sessionId)) throw new StartupError("input", "a session to reopen is named by its file and its id together, and the call input carries no id");
		if (session.checkpoint !== undefined && !isText(session.checkpoint)) throw new StartupError("input", "the call input's session.checkpoint is not an entry id");
	} else if (session.kind !== "new") {
		throw new StartupError("input", `the call input names session kind ${JSON.stringify(session.kind)}; a child starts a new session or opens a recorded one`);
	}
	if (value.catalogBaseUrl !== undefined && !isText(value.catalogBaseUrl)) throw new StartupError("input", "the call input's catalogBaseUrl is not a url");
	return value;
}

/** The call input, read from the file the host wrote for this one call. */
export function readInput(file) {
	if (!isText(file)) throw new StartupError("input", "the bootstrap takes one argument: the path of the call input file");
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new StartupError("input", `the call input ${file} could not be read (${codeOf(error) ?? failureText(error)})`, { cause: error });
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StartupError("input", `the call input ${file} is not json (${failureText(error)})`, { cause: error });
	}
	return checkInput(parsed);
}

/**
 * How the file is framed, checked on the bytes before the parser sees them: a non-empty transcript ends with a
 * newline, and every line that is not blank is json. Pi tolerates neither condition as a failure — its loader appends
 * a missing final newline to the file itself, and it skips a line it cannot read and opens the session without it —
 * so what Pi does with these files is repair and silent loss. Fusion opens only a transcript it will neither repair
 * nor drop part of: a conservative preflight, not a recovery feature, and it rewrites nothing whatever it finds. A
 * refusal names the line and the rule it broke and never the line itself, because a transcript line is the run's own
 * content and a diagnostic is not where it belongs.
 */
export function checkFraming(text) {
	const lines = text.split("\n");
	if (!text.endsWith("\n")) {
		throw new StartupError(
			"session",
			`the recorded session file does not end with a newline: line ${lines.length} is unterminated. Pi would write that newline into the file as it opened it, so the file is refused rather than repaired`,
		);
	}
	// The element after the final newline is not a line, so it is not checked; a blank line in between is allowed.
	for (let index = 0; index < lines.length - 1; index++) {
		if (!lines[index].trim()) continue;
		try {
			JSON.parse(lines[index]);
		} catch {
			throw new StartupError(
				"session",
				`the recorded session file has a line that is not json: line ${index + 1}. Pi would skip that line and open the session without it, so the file is refused rather than opened with part of it dropped`,
			);
		}
	}
}

/**
 * What an opened session has to be before a `SessionManager` is built for it. The preflight reads the file and parses
 * it and writes nothing, which is the whole of what it promises: `SessionManager.open` migrates an older format in
 * place, so a run that only wanted to look at a recorded session would rewrite the file a later fork reads from, and
 * an older version is therefore refused rather than upgraded, with no automatic migration and no repair. A message
 * names no session id and no transcript path: the host knows which session it asked for, and an identity belongs in
 * the run's own outcome.
 *
 * The promise is the preflight's alone and does not extend past it. What a construction after it writes is named on
 * `createRuntime` below, because it is real and this file does not pretend otherwise.
 *
 * The framing is checked on the bytes first, and the entries the public parser returns are what the session's own
 * identity and its checkpoint are then read from. Nothing here validates an entry's schema, the tree they form or
 * where a run may navigate to: those are the bridge's.
 */
export function preflightSession(session, sdk) {
	let text;
	try {
		text = readFileSync(session.file, "utf8");
	} catch (error) {
		throw new StartupError("session", `the recorded session file could not be read (${codeOf(error) ?? failureText(error)}); it was not opened and nothing was written`, { cause: error });
	}
	if (!text.trim()) throw new StartupError("session", "the recorded session file is empty, so it holds no session to continue");
	checkFraming(text);
	let entries;
	try {
		entries = sdk.parseSessionEntries(text);
	} catch (error) {
		throw new StartupError("session", `the recorded session file could not be parsed (${failureText(error)}); it is left exactly as it is for inspection`, { cause: error });
	}
	const header = Array.isArray(entries) ? entries[0] : undefined;
	if (!header || header.type !== "session") throw new StartupError("session", "the recorded session file does not begin with a session header");
	if (header.version !== sdk.CURRENT_SESSION_VERSION) {
		throw new StartupError(
			"session",
			`the recorded session file is version ${JSON.stringify(header.version)} and this Pi writes version ${sdk.CURRENT_SESSION_VERSION}; opening it would migrate the file in place, so it is refused instead of upgraded`,
		);
	}
	if (header.id !== session.sessionId) throw new StartupError("session", "the recorded session file holds a different session id than the call expects, so it is not the session this run continues");
	if (session.checkpoint !== undefined && !entries.some((entry) => entry?.id === session.checkpoint)) {
		throw new StartupError("session", "the checkpoint this run restores is not an entry of the recorded session file");
	}
	return { entries: entries.length - 1 };
}

/**
 * The session manager a call runs with: a fresh session, or the recorded one, opened only after it checks out. A file
 * the preflight refused is never handed to `SessionManager.open`, which is what keeps a refusal from migrating the
 * file it refused.
 */
export function openSessionManager(input, sdk) {
	if (input.session.kind === "new") return sdk.SessionManager.create(input.cwd, input.sessionDir);
	preflightSession(input.session, sdk);
	return sdk.SessionManager.open(input.session.file, input.sessionDir, input.cwd);
}

/**
 * The child's settings: in memory, so no settings file of the user's, the project's or this machine's is read and none
 * is written. `packages` is empty, which is what leaves the resource loader with nowhere to install from, and the four
 * resource lists are empty because a child loads the resources its call names and discovers none. Project trust is
 * said out loud rather than left to a default, because a default is a decision somebody else made.
 *
 * The behavior settings are the values Pi 0.85.1 itself defaults to, written out for the same reason: each of them is
 * something the stock CLI writes into a user's settings file from an RPC setter, so a child that was silent about them
 * would be a child whose queueing, compaction and retry are whatever a later Pi decides they are. Each one matches the
 * installed default — `one-at-a-time` for both queues, compaction on, retry on with three attempts and a two-second
 * base delay, skill commands on — so this states what the child runs with without changing it.
 */
export function buildSettings(input, sdk) {
	return sdk.SettingsManager.inMemory(
		{
			defaultTools: [...input.tools],
			packages: [],
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			compaction: { enabled: true },
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
			enableSkillCommands: true,
		},
		{ projectTrusted: false },
	);
}

/**
 * Whether a file's own directory is the directory named, compared lexically: `path`'s rules for the platform named, a
 * trailing separator dropped, and on Windows the separators folded and the compare case insensitive, because that is
 * how Windows names a file. Nothing is resolved through the filesystem — no realpath, no symlink read, no stat —
 * because the loader already produced this path as metadata, and asking the filesystem would answer a question other
 * than the one being asked. `platform` is a parameter so the other platform's rule can be exercised at all; a rule
 * tested that way is tested as logic and says nothing about how that platform's filesystem behaves.
 */
export function inDirectory(file, directory, platform = process.platform) {
	const flavor = platform === "win32" ? path.win32 : path.posix;
	const lexical = (value) => {
		const normalized = flavor.normalize(String(value));
		const folded = platform === "win32" ? normalized.replace(/\\/g, "/").toLowerCase() : normalized;
		return folded.length > 1 && folded.endsWith("/") ? folded.replace(/\/+$/, "") : folded;
	};
	return lexical(flavor.dirname(String(file))) === lexical(directory);
}

/**
 * The project's own instruction files, with the child agent directory's own left out. Pi reads a context file from the
 * agent directory as a global one, and this child's agent directory is Fusion's rather than the user's, so a file that
 * landed there is a file nobody wrote for this run. Everything else stays exactly as the loader found it: the project's
 * own file, each ordinary ancestor's, and a nested project's own.
 *
 * The one case this cannot tell apart: with a working directory inside or equal to the agent directory, that same file
 * is both the agent directory's global file and an ancestor of the project, and what this override is given — a path and
 * a content, and nothing about where the loader found either — holds nothing that distinguishes the two. Such a file is
 * suppressed, which is the safe side of a collision public metadata cannot resolve, and it is a documented limitation
 * rather than a rule this build can lift without a context loader of its own, which it does not have and will not grow.
 */
function projectContext(base, input, platform) {
	const files = base?.agentsFiles;
	if (!Array.isArray(files) || !files.every((file) => isRecord(file) && isText(file.path))) {
		throw new StartupError(
			"sdk",
			`${SDK_PACKAGE} called agentsFilesOverride with something other than a list of files that name their own paths, and this bootstrap reads that shape to leave the child agent directory's own context file out; install a version whose resource loader passes that shape, because a child does not start on a prompt it cannot account for`,
		);
	}
	return { agentsFiles: files.filter((file) => !inDirectory(file.path, input.agentDir, platform)) };
}

/**
 * What the resource loader may find: nothing it discovers for itself, and exactly the resources this call named. The
 * four discovery switches turn off automatic discovery — a user's or a project's own extension, skill, prompt template
 * or theme is not looked for, and the two extra lists are empty so none is named either — and the extensions and
 * skills the call named go in as explicit paths, which is the one way a resource arrives here. What the switches do
 * not do is decide what an explicitly named path brings with it: an extension path that is a package directory is
 * resolved through the package manager, and a manifest can carry bundled skills, prompt templates and themes that are
 * then loaded beside the extension. That is why the checks after loading exist rather than being redundant — a loaded
 * prompt template or theme is refused outright, and a loaded skill only counts when it lies under a skills entry the
 * call named. `extensionFactories` is empty for the same reason the lists are explicit: this build ships no built-in
 * extension of its own, and the one Fusion's own bridge will need is a factory that task will pass rather than a
 * default hidden here.
 *
 * The two prompt overrides are the reason this is explicit rather than trusting discovery to be off — a `SYSTEM.md` or
 * an `APPEND_SYSTEM.md` in the child agent directory is found by its own path rather than by discovery, so the
 * overrides answer for both: Pi's default base prompt, and exactly this role's contract appended to it. The project's
 * own instruction files are the one thing a child picks up from its working directory, so `noContextFiles` is false and
 * says so, and `agentsFilesOverride` leaves out only the child agent directory's own file.
 */
export function resourceOptions(input, platform = process.platform) {
	return {
		additionalExtensionPaths: [...input.extensions],
		additionalSkillPaths: [...input.skills],
		additionalPromptTemplatePaths: [],
		additionalThemePaths: [],
		extensionFactories: [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: false,
		agentsFilesOverride: (base) => projectContext(base, input, platform),
		systemPromptOverride: () => undefined,
		appendSystemPromptOverride: () => [input.contract],
	};
}

/**
 * What a model-runtime failure says, whichever way it failed, and all it says. The wording is fixed and carries
 * nothing the SDK produced: a configuration error's text can quote `models.json` itself — a `JSON.parse` failure
 * names the fragment it choked on — and that file holds the user's credentials, so repeating it on stderr would put a
 * key in a diagnostic the host reads and may keep. What went wrong is therefore said in Fusion's own words, and the
 * one path in it is the models file the call was configured with, which the host passed in and already knows.
 *
 * What the runtime reports concerns the models it was configured with or the credentials those models are reached
 * through, and the refusal says both rather than only the first, because a child cannot tell them apart from one
 * unstructured text. The guidance after it is conditional for the same reason: it lists what a reader may check — the
 * configured models, their credentials, a provider extension a configured model comes from, the catalog — and
 * attributes the failure to none of them. Nothing here probes the filesystem to guess better: this bootstrap does not
 * look for the models file before it says this, so the sentence about an absent one states what the composition
 * supports rather than what some directory happens to hold. A call whose host has no models file of its own is given
 * this call's own absent private path, which is a supported configuration and not by itself a fault, and saying so is
 * what keeps a reader from hunting for a file that was never meant to be there.
 */
export const MODELS_REFUSED =
	"the child's model or credential configuration could not be used, so the call is refused before any work starts. A model-configuration error, a credential error, a provider-composition error and a catalog availability error each refuse startup, including one that concerns a provider this call does not use, because Pi reports them as one text a child cannot attribute. Check whichever of these this configuration has: that each model it names is spelled the way its provider names it, that a credential for every provider it composes is configured, that a provider extension a named model comes from loads, and that the model catalog is reachable. A configuration with no models file of its own is supported and is not by itself the fault. Correct the model or credential configuration and start the call again. Nothing here says which of those it was, which provider or which line was at fault, because the report Pi produces can quote credentials";

/** The one refusal, with the one path it may name. Nothing from the SDK's own error reaches it, cause included. */
const modelsRefused = (input) => new StartupError("models", `${MODELS_REFUSED}. Models file in use: ${input.modelsPath}`);

/**
 * What the model runtime reports, checked the same way wherever it is asked. `getError()` is an aggregate of the
 * configuration error, every provider composition error and the availability-refresh error, with no public way to tell
 * them apart or to say which provider each belongs to, so a reported error fails the call even when it concerns a
 * provider this call never uses and even when the exact model asked for is present: a call that ran anyway would be
 * running on a configuration the user's own file was silently dropped from. A provider composition error is where a
 * credential this runtime could not use is reported as well, which is the other half of what the one refusal has to
 * cover. Every reported error is the same refusal, and none of them carries the SDK's own text.
 *
 * A missing `getError` and one that answers with something other than a string are different: those are Fusion's own
 * compatibility findings, they name the API and the shape this bootstrap reads, and they copy nothing opaque.
 */
function checkModelRuntime(modelRuntime, input) {
	if (typeof modelRuntime?.getError !== "function") {
		throw new StartupError(
			"sdk",
			`${SDK_PACKAGE} built a model runtime with no getError(), so this bootstrap cannot tell whether the model configuration loaded; install a version whose ModelRuntime reports its errors, because a call is not started on a configuration that cannot be checked`,
		);
	}
	let reported;
	try {
		reported = modelRuntime.getError();
	} catch {
		throw modelsRefused(input);
	}
	if (reported !== undefined && typeof reported !== "string") {
		throw new StartupError(
			"sdk",
			`${SDK_PACKAGE} answered ModelRuntime.getError() with a value of type ${typeof reported}, and this bootstrap reads a string or undefined; install a version whose getError() reports that shape, because a call is not started on a configuration that cannot be checked`,
		);
	}
	if (isText(reported)) throw modelsRefused(input);
	return modelRuntime;
}

/** The model runtime this child reads its models and its credentials through, refused whenever it cannot be built. */
async function createModelRuntime(input, sdk) {
	let modelRuntime;
	try {
		modelRuntime = await sdk.ModelRuntime.create({
			authPath: input.authPath,
			modelsPath: input.modelsPath,
			modelsStorePath: input.modelsStorePath,
			allowModelNetwork: input.allowModelNetwork === true,
			...(input.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: input.catalogBaseUrl }),
		});
	} catch {
		// The thrown error is deliberately not bound: there is no path from it into a message, a cause or a code.
		throw modelsRefused(input);
	}
	return checkModelRuntime(modelRuntime, input);
}

/**
 * What a construction stage's own failure says, and all it says. Each wording is fixed: a constructor reads files — a
 * resource, a context file, a prompt, a settings blob — and a failure it throws can quote what it read, so nothing from
 * the thrown value reaches a diagnostic, its message, its name, its code and its cause included. The resources summary
 * names the counts the call was configured with, which the host composed and already knows, and neither names a path.
 *
 * What this fixes is the text of the failure Fusion reports. The SDK writes its own warnings on stderr for a context or
 * prompt file it could not read, and nothing here filters that: this is not a sandbox and not a redaction of a child's
 * own output, and the task output a run produces is not touched by any of it.
 */
const resourcesRefused = (input) =>
	new StartupError(
		"resources",
		`the child's resources could not be prepared, so the call is refused before any work starts. The call was configured with ${input.extensions.length} extensions and ${input.skills.length} skills, each an existing local path this bootstrap checked before it loaded the SDK. Nothing here repeats what the failure said, because loading a resource reads files whose text the failure can quote`,
	);

const settingsRefused = () =>
	new StartupError(
		"settings",
		"the child's settings could not be built, so the call is refused before any work starts. The settings this child runs on are held in memory and read no file of the user's, so there is nothing here to correct in a settings file; nothing repeats what the failure said, because a settings failure can quote the document it was given",
	);

const sessionStoreRefused = () =>
	new StartupError(
		"session",
		"the recorded session could not be opened, so the call is refused before any work starts. Nothing here repeats what the failure said, and nothing here names the session: a session manager's own failure can quote the transcript it read, and which session this run asked for is the host's to know. Every check this bootstrap makes on the file itself happens before this point and keeps its own wording",
	);

const agentSessionRefused = () =>
	new StartupError(
		"runtime",
		"the child's session could not be constructed, so the call is refused before any work starts. Nothing here repeats what the failure said, because constructing a session reads files whose text the failure can quote",
	);

const runtimeRefused = () =>
	new StartupError(
		"runtime",
		"the child's runtime could not be constructed, so the call is refused before any work starts. Nothing here repeats what the failure said, because constructing a runtime reads the working directory and files whose text the failure can quote",
	);

/**
 * One foreign construction call. A refusal this bootstrap composed passes through exactly as it is — the checks inside
 * the factory below are where several of them come from, and their stage and their wording are the answer the host
 * reads — while anything the SDK or a resource of its own threw becomes the fixed summary for that stage.
 */
const guarded = async (call, refused) => {
	try {
		return await call();
	} catch (error) {
		if (error instanceof StartupError) throw error;
		throw refused();
	}
};

/**
 * An api this bootstrap reads and the installed package does not answer in a shape it can read. One wording for every
 * one of them — a loader's own report of what it loaded, a session's account of its tools, a public factory's
 * definition — because what a reader has to do about it is the same in each case: install a version that answers it.
 * Nothing the package produced is in it, and nothing about it is a classifier: it names the api and the shape this
 * bootstrap reads, and that is all it says.
 */
const incompatible = (api, reads) =>
	new StartupError(
		"sdk",
		`${SDK_PACKAGE} answered ${api} with something other than ${reads}, and this bootstrap reads that shape to compose this call and to check what it composed; install a version that answers it, because a call is not started on a public api whose answer this bootstrap cannot read`,
	);

/**
 * One foreign accessor or factory, called for its answer: a resource accessor on the loader, a field of a tool
 * definition, a factory that builds one. A call that throws is the same finding as one that answers a shape this cannot
 * read — the package cannot say what this call is being composed from or what it composed, so the call is not started —
 * and it is that rather than a construction summary, which would report the stage that happened to be running and say
 * nothing about which api failed. Nothing of the thrown value reaches the refusal: no message, no name, no code, no
 * cause and no value it was carrying, because such an error quotes the file, the resource or the configuration it read.
 */
const answered = (api, call) => {
	try {
		return call();
	} catch {
		throw incompatible(api, "an answer at all rather than a failure of its own");
	}
};

/**
 * Whether a loaded resource is an entry the call named or lies beneath it, compared lexically and segment by segment.
 * `path.relative` for the platform named is what decides it: an empty result is the entry itself, an absolute result
 * is another root or another Windows drive, and a result that is `..` or starts with `..` and a separator is outside.
 * That makes a sibling whose name only starts the same way — `children-extra` beside `children` — outside, which a
 * prefix comparison would not, and it answers for a `/` root and for Windows's own separators and casing, because the
 * platform's own `path` is doing the work rather than a rule written out again here.
 *
 * Nothing is resolved through the filesystem. A loaded path keeps the spelling of the entry it came from, so a lexical
 * answer is the right one here, and a symlinked resource is a measurement 3c owes rather than something to guess at
 * with a realpath. The self-inclusion check below is the one place a real path is read, and it is a different
 * question: not whether a resource is covered, but whether one particular module is this host's own.
 *
 * `platform` is a parameter so the other platform's rule can be exercised at all; a rule tested that way is tested as
 * logic and says nothing about how that platform's filesystem behaves.
 */
export function withinDirectory(file, directory, platform = process.platform) {
	const flavor = platform === "win32" ? path.win32 : path.posix;
	const at = String(file);
	const root = String(directory);
	if (!flavor.isAbsolute(at) || !flavor.isAbsolute(root)) return false;
	const relative = flavor.relative(root, at);
	if (relative === "") return true;
	if (flavor.isAbsolute(relative)) return false;
	return relative !== ".." && !relative.startsWith(`..${flavor.sep}`);
}

/**
 * This install's own extension module, named from the bootstrap's own location rather than from a working directory or
 * a variable. A child that loaded it would be loading Fusion inside Fusion.
 */
const HOST_EXTENSION = path.resolve(own(), "..", "fusion.ts");

/** A path as the filesystem knows it, falling back to the path itself when it cannot be resolved. */
const realOf = (file) => {
	try {
		return realpathSync(file);
	} catch {
		return path.resolve(file);
	}
};

/**
 * The loaded extensions, as paths. Two things are settled here. An extension reports the path it was resolved to and
 * the path it was named by, and the resolved one is what a coverage answer is about; an extension that reports neither
 * as an absolute path is an inline one — `<inline>` is how 0.85.1 spells one — and this composition passes
 * `extensionFactories: []`, so there is none to expect and one is refused. It is refused for having no filesystem path
 * rather than for how that name is spelled: a spelling proves nothing about whose extension it is, and a name that is
 * not an absolute path cannot be judged against an explicit entry at all — an explicit entry of `/` would otherwise
 * make a naive comparison accept it. The bridge of task 7 will pass a factory of its own and account for it there.
 */
function loadedExtensions(result, input) {
	const list = result?.extensions;
	if (!Array.isArray(list) || !list.every(isRecord)) throw incompatible("resourceLoader.getExtensions()", "a result whose extensions is a list of loaded extensions");
	return list.map((entry) => {
		const at = isText(entry.resolvedPath) ? entry.resolvedPath : isText(entry.path) ? entry.path : undefined;
		if (at === undefined) throw incompatible("resourceLoader.getExtensions()", "a result whose extensions each report their own resolvedPath or path");
		if (!path.isAbsolute(at)) {
			throw new StartupError(
				"resources",
				`the child loaded an extension that reports no absolute filesystem path of its own, which is how an extension built from a factory rather than read from a file is reported, and this call passes no factory at all: ${list.length} extensions loaded against the ${input.extensions.length} this call named. An extension that is not one of the paths this call named is not this child's to run`,
			);
		}
		return at;
	});
}

/**
 * The one module a child may not load: this host's own extension. Compared as real paths, so an explicit file, a
 * directory that holds it, a package root that resolves to it and a symlink to any of those are the same finding.
 *
 * What this is not: it is a check on one known module, not a way of telling what a loaded extension imports. A child
 * that loaded Fusion would find it registers nothing at all, because `piLaunch` sets the child marker and `fusion()`
 * returns on it before it registers a tool — that marker is the protection, and nothing here is a sandbox or a
 * detector of an indirect import. This refusal is about the resource being the wrong resource, and it comes before the
 * loader's own errors are read so that a directory holding this module beside something that failed to load says the
 * useful thing rather than the incidental one.
 */
function checkSelfInclusion(loaded) {
	const self = realOf(HOST_EXTENSION);
	for (const at of loaded) {
		if (realOf(at) !== self) continue;
		throw new StartupError(
			"resources",
			`the child loaded this host's own extension as one of its resources: ${HOST_EXTENSION}. A child runs the role's own resources and not the host's, so the call is refused rather than started on it, whether it was named directly, through a directory that holds it or through a link to either. This says nothing about what any other resource imports; it compares one known module against what was loaded`,
		);
	}
}

/**
 * The coverage a call's own resource lists have to have, in both directions. Every entry the call named has to have
 * contributed at least one loaded resource of its own kind, at that path or beneath it, because the loader answers an
 * entry that produced nothing with a warning or with silence: a skill file this Pi will not read, an empty directory
 * and a local extension it skipped all leave a child running without what its role asked for, and each of them is a
 * failure the call never hears about otherwise. And every resource the child loaded has to lie under an entry of its
 * own kind, because an explicit extension path that is a package directory brings the manifest's own bundled skills
 * with it: one that lies under a skills entry the call named is that entry's, and one that does not is a resource
 * nobody selected, which is refused rather than quietly admitted.
 *
 * A missing entry is named by its index and not by its path, the way the input rules name one. An undeclared resource
 * is named by the path the loader reported, because that is the only thing that says which resource it was.
 */
function checkCoverage(field, named, loaded) {
	for (let index = 0; index < named.length; index++) {
		if (loaded.some((at) => withinDirectory(at, named[index]))) continue;
		throw new StartupError(
			"resources",
			`the call input's ${field}[${index}] loaded nothing: the child loaded ${loaded.length} ${field}, and not one of them is that entry or lies beneath it. A resource a role named and a child does not have is a child running with less than its role asked for, which this loader reports as a warning or as nothing at all, so it is refused here`,
		);
	}
	const undeclared = loaded.filter((at) => !named.some((entry) => withinDirectory(at, entry)));
	if (undeclared.length) {
		throw new StartupError(
			"resources",
			`the child loaded ${undeclared.length} ${field} this call did not name, which a package an explicit path resolved to can bring with it: ${undeclared.join(", ")}. A resource this role did not select is refused rather than run with`,
		);
	}
}

/**
 * A kind of resource this binding selects none of, refused by what was loaded. A role here names extensions and skills
 * and has no field for a prompt template or a theme, and turning discovery off does not answer for the bundle a
 * package directory carries, so what the loader ended up holding is what decides it. The paths are the loader's own
 * where the public shape has one — a prompt template names its file, a theme names its source — and a count where it
 * does not; nothing copies the object itself or anything it says.
 */
function checkUnselected(api, result, key, pathField) {
	const list = result?.[key];
	if (!Array.isArray(list) || !list.every(isRecord)) throw incompatible(api, `a result whose ${key} is a list of loaded ${key}`);
	if (!list.length) return;
	const named = list.map((entry) => entry[pathField]).filter(isText);
	throw new StartupError(
		"resources",
		`the child loaded ${list.length} ${key}, and a role on this backend selects none: ${named.length ? named.join(", ") : `${list.length} that name no path`}. Discovery is off, so what is loaded came in with a path this call named — a package a resource directory resolved to carries its own — and a resource nobody selected is refused rather than run with`,
	);
}

/**
 * What the loader says about what it loaded, refused rather than run past. Every one of these is a list the SDK returns
 * rather than throws, so a call that only looked at the exception it never got would run with an extension that failed
 * to load, a skill shadowed by another of the same name, a skill file this Pi reads nothing from, a bundled resource
 * nobody asked for, or a provider an extension could not register — each of them the silent difference between the
 * child the role asked for and the child that started.
 *
 * The order is deliberate. This host's own extension is the first thing looked for, so a directory that holds it says
 * so rather than reporting whatever else in that directory failed to load. Then the loader's own failures, then the
 * coverage both ways, then the kinds this binding selects none of, then what the services said about themselves.
 *
 * What a refusal carries is paths and counts: a resource path is one the host composed or one the loader reported,
 * while a diagnostic's own message quotes the file, the extension and the error it came from, so no message reaches a
 * diagnostic. A shape this cannot read is a compatibility refusal and never an empty result taken for a clean one.
 *
 * The fields read here are the installed 0.85.1 package's own public ones, and nothing else is touched: an extension's
 * `resolvedPath` and `path`, the `errors[].path` beside them, a skill's `filePath`, the skill `diagnostics`, a prompt
 * template's `filePath`, a theme's `sourcePath`, and the services' own `diagnostics`. No private state is read, no
 * error text is parsed and no second loader is built to answer any of it.
 */
function checkResources(services, input) {
	const loader = services?.resourceLoader;
	const getters = ["getExtensions", "getSkills", "getPrompts", "getThemes"];
	if (getters.some((name) => typeof loader?.[name] !== "function")) {
		throw incompatible("createAgentSessionServices()", `services whose resourceLoader provides ${getters.map((name) => `${name}()`).join(", ")}`);
	}
	const extensions = answered("resourceLoader.getExtensions()", () => loader.getExtensions());
	const loadedExtensionPaths = loadedExtensions(extensions, input);
	checkSelfInclusion(loadedExtensionPaths);
	const failed = extensions?.errors;
	if (!Array.isArray(failed) || !failed.every(isRecord)) throw incompatible("resourceLoader.getExtensions()", "a result whose errors is a list of reported failures");
	if (failed.length) {
		const named = failed.map((failure) => failure.path).filter(isText);
		throw new StartupError(
			"resources",
			`${failed.length} of the ${input.extensions.length} extensions this call named failed to load, and a child does not run without a resource its role asked for: ${named.length ? named.join(", ") : `${failed.length} that name no path`}. What each failure said is not repeated here, because loading an extension reads a file whose text the failure can quote`,
		);
	}
	const skills = answered("resourceLoader.getSkills()", () => loader.getSkills());
	const reported = skills?.diagnostics;
	const kinds = ["warning", "error", "collision"];
	if (!Array.isArray(reported) || !reported.every((entry) => isRecord(entry) && kinds.includes(entry.type))) {
		throw incompatible("resourceLoader.getSkills()", `a result whose diagnostics is a list of ${kinds.join(", ")} entries`);
	}
	// A warning is a warning: the loader says something about a skill and the call goes on, as long as the coverage
	// below holds. An error and a collision are not, because a collision means one skill of this name won and another
	// lost, and which one ran would be silent.
	const refusing = reported.filter((entry) => entry.type === "error" || entry.type === "collision");
	if (refusing.length) {
		const paths = new Set();
		for (const entry of refusing) {
			if (isText(entry.path)) paths.add(entry.path);
			if (isRecord(entry.collision)) for (const side of ["winnerPath", "loserPath"]) if (isText(entry.collision[side])) paths.add(entry.collision[side]);
		}
		throw new StartupError(
			"resources",
			`the ${input.skills.length} skills this call named were reported with ${refusing.length} failing diagnostics, and a child does not run with a skill that failed to load or one of two skills of the same name: ${paths.size ? [...paths].join(", ") : `${refusing.length} that name no path`}. No diagnostic's own message is repeated here, because it quotes the file it came from`,
		);
	}
	const loadedSkills = skills?.skills;
	if (!Array.isArray(loadedSkills) || !loadedSkills.every((entry) => isRecord(entry) && isText(entry.filePath))) {
		throw incompatible("resourceLoader.getSkills()", "a result whose skills is a list of loaded skills naming their own filePath");
	}
	checkCoverage("extensions", input.extensions, loadedExtensionPaths);
	checkCoverage(
		"skills",
		input.skills,
		loadedSkills.map((entry) => entry.filePath),
	);
	checkUnselected("resourceLoader.getPrompts()", answered("resourceLoader.getPrompts()", () => loader.getPrompts()), "prompts", "filePath");
	checkUnselected("resourceLoader.getThemes()", answered("resourceLoader.getThemes()", () => loader.getThemes()), "themes", "sourcePath");
	const diagnostics = services?.diagnostics;
	const levels = ["info", "warning", "error"];
	if (!Array.isArray(diagnostics) || !diagnostics.every((entry) => isRecord(entry) && levels.includes(entry.type))) {
		throw incompatible("createAgentSessionServices()", `services whose diagnostics is a list of ${levels.join(", ")} entries`);
	}
	const errors = diagnostics.filter((entry) => entry.type === "error");
	if (errors.length) {
		throw new StartupError(
			"resources",
			`the services this child would run on reported ${errors.length} of their ${diagnostics.length} diagnostics as errors, and a child does not start on services that reported one: a provider an extension could not register is reported this way, and a call that went on would run on a configuration part of which was dropped. No message is repeated here, because it quotes the extension and the error it came from`,
		);
	}
	return services;
}

/**
 * The tools the role asked for, required on the session the moment it exists. `tools` is the allow list the session is
 * built with, so a name outside the role's list cannot become active however it was registered, and a name inside it is
 * active as soon as its tool is in the registry — which, for a tool an extension provides, means the extension
 * registered it in its factory body. A registration in a later hook is too late for this check and for the allow list:
 * `session_start` and resource discovery run inside `runRpcMode`, after this, and Pi 0.85.1 answers no RPC command with
 * its tool names, so a transport could not check them later either. Lifecycle hooks still run as they always do; what
 * this requires is that a name the role runs on is there now.
 *
 * A missing name is a refusal that names it, never a run with fewer tools than the contract says, a substitute or a
 * name inferred from what happens to be active.
 */
function checkTools(created, input) {
	const session = created?.session;
	if (typeof session?.getActiveToolNames !== "function") throw incompatible("createAgentSessionFromServices()", "a session that provides getActiveToolNames()");
	let active;
	try {
		active = session.getActiveToolNames();
	} catch {
		throw incompatible("session.getActiveToolNames()", "a list of the names that are active");
	}
	if (!Array.isArray(active) || !active.every(isText)) throw incompatible("session.getActiveToolNames()", "a list of the names that are active");
	const missing = input.tools.filter((tool) => !active.includes(tool));
	if (missing.length) {
		throw new StartupError(
			"runtime",
			`the child's session does not have ${missing.length === 1 ? "the tool" : "the tools"} ${missing.join(", ")} this role runs with, so the call is refused rather than run with fewer tools than its contract names. A tool an extension provides has to be registered in that extension's factory body, which is what makes it active under the role's tool list; a registration in a later hook is not this session's tool`,
		);
	}
	return active;
}

/**
 * The two builtins that download a helper on first use, each paired with the factory that builds it and, through its own
 * name, with the message its retry keys on. One entry decides both, so nothing maps a name to a message anywhere else:
 * a `grep` definition wrapped with `find`'s failure is not a thing this composition can produce.
 */
const HELPER_TOOLS = [
	{ name: "grep", factory: "createGrepToolDefinition" },
	{ name: "find", factory: "createFindToolDefinition" },
];

/**
 * The search tools this session runs, each from its own public factory and each wrapped so one model-issued call may
 * make at most two helper attempts. `rg` and `fd` are downloaded into the managed bin on first use, and two children
 * sharing that bin can overlap there: the one that loses comes back with the tool's own fixed unavailable error, and a
 * second attempt is the one bounded recovery — `withHelperRetry` says exactly what that is worth and what it is not.
 *
 * A definition passed in `customTools` replaces the builtin of the same name, which is why the name is checked exactly
 * rather than trusted: a definition that answered with another name would add a tool instead of wrapping one, and the
 * role's own allow list and `checkTools` are untouched by any of it — the names a session runs with are the same names.
 * A tool the role did not ask for is not built at all, because a factory call is a call and there is no reason to make
 * one for a name this session would not run.
 *
 * Nothing of what a factory returned or threw reaches a refusal: a factory that fails, a definition that is not an
 * object, one whose name is not this tool's and one with no `execute` to call are each the one fixed compatibility
 * refusal naming the api, through the same `answered` and `incompatible` every other foreign accessor here goes through.
 */
function helperRetryTools(sdk, cwd, tools) {
	const definitions = [];
	for (const { name, factory } of HELPER_TOOLS) {
		if (!tools.includes(name)) continue;
		const api = `${factory}()`;
		const definition = answered(api, () => sdk[factory](cwd));
		if (!isRecord(definition)) throw incompatible(api, "a tool definition of its own");
		if (answered(`${api}.name`, () => definition.name) !== name) throw incompatible(api, `a tool definition named ${name}`);
		if (typeof answered(`${api}.execute`, () => definition.execute) !== "function") throw incompatible(api, `a ${name} tool definition with an execute() to call`);
		definitions.push(withHelperRetry(definition, HELPER_UNAVAILABLE[name]));
	}
	return definitions;
}

/**
 * The runtime the child serves from, composed out of the public constructors with the model runtime and the settings
 * manager supplied rather than defaulted: the file-backed defaults would read the user's settings and write a catalog
 * beside the user's `models.json`, which is the whole point of passing our own.
 *
 * The session comes first, because a session this run may not touch is a reason to refuse the run: an older, empty or
 * wrong file must fail before anything loads a configuration, refreshes a catalog or reaches a provider.
 *
 * What an opened session has written to it after that preflight, this bootstrap does not prevent and does not hide:
 * `createAgentSessionFromServices` appends a `thinking_level_change` entry to a branch that carries messages and has
 * none, and it does that before the tools this role runs with have been checked, so a refusal from that check can
 * leave that entry in the file. Nothing here removes it, rewrites it or navigates away from it — no transcript
 * surgery, no replacement of what the SDK does and no recovery — and what a real child actually leaves behind is the
 * bridge's to measure rather than this file's to claim.
 */
export async function createRuntime(input, sdk) {
	// The two constructors before the factory are guarded the same way the three inside it are: a settings document or
	// a transcript the SDK could not take is one fixed summary for its own stage, and every check this bootstrap made
	// on the file first keeps its own wording, because `guarded` lets a refusal of ours through untouched.
	const settingsManager = await guarded(() => buildSettings(input, sdk), settingsRefused);
	const sessionManager = await guarded(() => openSessionManager(input, sdk), sessionStoreRefused);
	const modelRuntime = await createModelRuntime(input, sdk);
	const createSession = async ({ cwd, agentDir, sessionManager: manager, sessionStartEvent }) => {
		const services = await guarded(
			() =>
				sdk.createAgentSessionServices({
					cwd,
					agentDir,
					settingsManager,
					modelRuntime,
					resourceLoaderOptions: resourceOptions(input),
				}),
			() => resourcesRefused(input),
		);
		// Services register an extension's own providers on this model runtime and refresh its catalog, so the same
		// credential-safe guard runs again over the same aggregate: an error that work raised has to refuse the call
		// before a model is looked up, or a provider that failed would be answered with whichever builtin is available.
		checkModelRuntime(modelRuntime, input);
		checkResources(services, input);
		// The exact pair the call named, and nothing near it: no default, no first available model and no fuzzy
		// resolve, so a model the child does not have fails the call instead of running as something else.
		const model = modelRuntime.getModel(input.model.provider, input.model.model);
		if (!model) {
			throw new StartupError("runtime", `the model ${input.model.provider}/${input.model.model} is not in this child's model configuration; configure that provider and model id, because no other model is selected in its place`);
		}
		const created = await guarded(() => {
			// A custom definition replaces the builtin of the same name, which is what makes the retry the same `grep` and
			// `find` the role already runs rather than a tool beside them. It is also why a call that names an extension
			// gets none: every refresh of the registry applies an extension's registrations first and the custom tools
			// last, so a wrapper of this composition's would win over an extension's own `grep` whenever it was
			// registered — in its factory body or later, in `session_start` — and an explicit override is the whole point
			// of naming an extension. No extension named, no override to lose; every role in this build names none, so
			// the default call is the wrapped one. Nothing here reads what an extension registers: the resource checks
			// above already refuse an extension this call did not name.
			//
			// The question tool is under that same gate, and deliberately so: a call that names an extension gets no
			// custom tool of Fusion's at all, rather than the question tool alone. That is the narrow rule, no Fusion
			// custom tool beside any explicit user extension, because the alternative is this composition silently
			// overriding a tool of that name the extension itself registered. A call that asks for questions and names
			// an extension therefore starts only if that extension registers `ask_orchestrator` in its factory body, and
			// `checkTools` below refuses it by name when nothing does. Every role in this build names no extension, so a
			// call that asks for questions gets the built-in bridge; that is not a promise about every combination of
			// resources and questions.
			const customTools = input.extensions.length ? [] : [...helperRetryTools(sdk, cwd, input.tools), ...(input.questionTool ? [questionTool()] : [])];
			return sdk.createAgentSessionFromServices({
				services,
				sessionManager: manager,
				sessionStartEvent,
				model,
				...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
				tools: [...input.tools],
				customTools,
			});
		}, agentSessionRefused);
		checkTools(created, input);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	// The factory runs inside this call, and the call itself checks that the working directory is there before it runs,
	// so both this constructor's own failure and every refusal the factory composed arrive here.
	return await guarded(() => sdk.createAgentSessionRuntime(createSession, { cwd: input.cwd, agentDir: input.agentDir, sessionManager }), runtimeRefused);
}

/**
 * One child, from the input file to serving RPC. `runRpcMode` owns stdout and exits the process itself, so nothing
 * after it runs; anything that fails before it is a startup failure, reported as one diagnostic line and exited with
 * the startup code. The SDK comes in through `options` only so a test can pass a double: production reads no variable
 * and takes no flag that could name another one.
 */
export async function main(argv, options = {}) {
	let version;
	let stage = "input";
	try {
		const input = readInput(argv[0]);
		report(stage, {});
		stage = "sdk";
		const sdk = options.sdk ?? (await loadSdk());
		version = checkSdk(sdk).version;
		report(stage, { sdk: version });
		stage = "runtime";
		const runtime = await createRuntime(input, sdk);
		report(stage, { sdk: version });
		stage = "serving";
		report(stage, { sdk: version });
		await sdk.runRpcMode(runtime);
	} catch (error) {
		report(error instanceof StartupError ? error.stage : stage, { ...(version === undefined ? {} : { sdk: version }), error: failureText(error) });
		process.exit(STARTUP_EXIT_CODE);
	}
}

/**
 * Runs the bootstrap when node was pointed at this file, and not when something imported it. Both sides are resolved
 * through their real paths, so an install reached through a symlink still recognises itself; a path that cannot be
 * resolved falls back to the path as it was given rather than to running by accident.
 */
const real = (file) => {
	try {
		return realpathSync(file);
	} catch {
		return path.resolve(file);
	}
};

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await main(process.argv.slice(2));
