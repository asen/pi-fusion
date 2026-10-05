import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Where a Pi child's storage lives: one subtree Fusion manages inside the host's own agent directory, kept apart from
 * the user's files there rather than sitting beside the profile. One stable child agent directory holds the catalog
 * cache, the helpers Pi downloads and the durable per-project sessions, and each call gets a directory of its own for
 * the input file it is launched with, the compiler caches its child writes and, where the user has none of their own,
 * private credential and model-config paths. The user's `models.json`, their `auth.json` and the host's own helper
 * `bin` are inputs: they are resolved and never created here, and the bin is a name this layout computes and nothing
 * more — nothing here stats it, creates it or requires it to be there, because whether a helper is in it is the
 * child's own question at the moment it looks. Nothing in this module reads a credential, copies one, or removes
 * anything but a call's own directory, and nothing collects what a run leaves behind: there is no garbage collector,
 * no cleanup command and no variable that moves any of these paths.
 */

/** The directory Fusion owns under the host's agent directory. Everything Fusion writes for a child is inside it. */
export const FUSION_DIR = "pi-fusion";
/** The one child agent directory, stable across calls: a per-call one would send Pi to fetch its helpers again. */
export const CHILDREN_DIR = "children";
export const CATALOG_DIR = "catalog";
export const SESSIONS_DIR = "sessions";
export const CALLS_DIR = "calls";
export const MODELS_STORE_FILE = "models-store.json";
export const MODELS_FILE = "models.json";
export const AUTH_FILE = "auth.json";
/**
 * The helper directory inside the *host's* own agent directory, which Pi fills with the helpers it downloads. It is
 * not under the Fusion-owned root: it is the user's own, read by a child through that child's `PATH` and written by
 * nothing here.
 */
export const BIN_DIR = "bin";
export const INPUT_FILE = "bootstrap.json";
/**
 * Where a call's child writes what it compiles: inside the call's own directory, so the caches go when the call does
 * and two calls never write the same cache file. One subdirectory per cache, because Node's compile cache and jiti's
 * filesystem cache are two formats and neither expects the other's files beside it.
 */
export const CACHE_DIR = "cache";
export const JITI_CACHE_DIR = "jiti";
export const NODE_CACHE_DIR = "node";

/** The mode a directory this module creates is made with. It applies at creation only, and means nothing on Windows. */
const OWNED_DIR_MODE = 0o700;
/** The mode a file this module creates is made with: the call input and a freshly published store are private. */
const PRIVATE_FILE_MODE = 0o600;
/** What a temporary catalog directory is called while it is being staged, so a leftover one is recognisable. */
const STAGING_PREFIX = ".catalog-";
/**
 * A handle names a directory, so it may hold no separator, no traversal and nothing else a path would read: the
 * leading character rules out `.` and `..` outright, and the rest rules out `/`, `\`, a drive letter and a colon.
 */
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const codeOf = (error: unknown): string | undefined => {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
};

/** A rename that lost: the stable directory is already there, so another initializer published it first. */
const TAKEN = new Set(["ENOTEMPTY", "EEXIST", "EPERM", "ENOTDIR", "EISDIR"]);

/**
 * The name a project's session directory takes: the directory's own name, reduced to characters every platform
 * carries, and a digest of the absolute working directory. The digest is what makes it one directory per project
 * rather than per name, since two checkouts can share a basename; the name is there so a person can tell which
 * project a directory belongs to without resolving a hash.
 */
export function projectSlug(cwd: string): string {
	const absolute = path.resolve(cwd);
	const digest = crypto.createHash("sha256").update(absolute).digest("hex").slice(0, 16);
	const name = path
		.basename(absolute)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+/, "")
		.slice(0, 40);
	return name ? `${name}-${digest}` : digest;
}

/** The paths of the layout, computed and nothing more: this creates no directory and touches no file. */
export interface PiPaths {
	/** `<host-agent-dir>/pi-fusion`: what Fusion owns. */
	root: string;
	/** The child's `PI_CODING_AGENT_DIR`, the same one for every call. */
	agentDir: string;
	catalogDir: string;
	modelsStorePath: string;
	/** This project's durable session directory, which survives a host shutdown, a resume and a fork. */
	sessionDir: string;
	callsDir: string;
	/** The user's own files, read in place where they exist and never created here. */
	userModelsPath: string;
	userAuthPath: string;
	/**
	 * The host agent directory's own `bin`, which a child reads through its `PATH` so a helper the host already
	 * downloaded is not fetched again. Metadata and nothing else: it is computed from the host agent directory this
	 * layout was given, and preparing a call neither creates it nor requires it, so a host that has never downloaded a
	 * helper is a host whose children simply find none there.
	 */
	hostBinDir: string;
}

export function piPaths(hostAgentDir: string, cwd: string): PiPaths {
	const host = path.resolve(hostAgentDir);
	const root = path.join(host, FUSION_DIR);
	const agentDir = path.join(root, CHILDREN_DIR);
	const catalogDir = path.join(agentDir, CATALOG_DIR);
	return {
		root,
		agentDir,
		catalogDir,
		modelsStorePath: path.join(catalogDir, MODELS_STORE_FILE),
		sessionDir: path.join(agentDir, SESSIONS_DIR, projectSlug(cwd)),
		callsDir: path.join(root, CALLS_DIR),
		userModelsPath: path.join(host, MODELS_FILE),
		userAuthPath: path.join(host, AUTH_FILE),
		hostBinDir: path.join(host, BIN_DIR),
	};
}

/** The storage one call runs with: the stable layout, this call's own directory, and the inputs it resolved. */
export interface CallStorage extends PiPaths {
	handle: string;
	cwd: string;
	/** This one invocation's directory, unique even when the same handle is continued. */
	callDir: string;
	inputPath: string;
	/** This call's compiler caches, which exist before the child starts and are removed with the call directory. */
	cacheDir: string;
	/** The user's `models.json`, or null when they have none: a missing one is never created. */
	modelsPath: string | null;
	/**
	 * A models file path inside this call's own directory, which nothing here creates and nothing writes to. It exists
	 * because `ModelRuntime.create` falls back to an in-memory catalog store whenever it is given no models file at
	 * all, which would throw away the persistent store this layout publishes; given a path that is simply absent it
	 * loads an empty configuration and still uses the shared store. Absent is the point: it must stay that way.
	 */
	privateModelsPath: string;
	/** The auth file the child reads: the user's own where it exists, and this call's private path where it does not. */
	authPath: string;
	/** True while `authPath` is the user's own file, which is the file the authorized rotation writes back to. */
	sharedAuth: boolean;
}

export interface StorageRequest {
	/** The host's agent directory, which the caller reads through the SDK's public accessor. */
	hostAgentDir: string;
	/** The working directory the child runs in, which decides the project's session directory. */
	cwd: string;
	/** The handle this call runs under. It names the call directory, so it is checked before it becomes a path. */
	handle: string;
}

/**
 * The one seam this module has, and it is here for a window a test cannot otherwise reach: `onStaged` runs after a
 * publisher has written its temporary catalog directory and before it renames that directory into place, which is
 * exactly the window another initializer can win in. Nothing in production passes it.
 */
export interface PublishHooks {
	onStaged?: (temporaryDir: string) => void;
}

const inspect = (target: string, what: string): string => `inspect ${target} and repair it by hand: ${what}`;

/**
 * A directory Fusion owns, created where it is absent and checked where it is not. An existing one is never replaced.
 * The profile store creates the shared `pi-fusion` root through this too, so the two agree on what that root may be:
 * a directory this user can read, write and search, created private. It follows a symbolic link and checks neither
 * the owner nor the mode of a directory that already exists.
 */
export function ownedDir(dir: string): void {
	try {
		fs.mkdirSync(dir, { recursive: true, mode: OWNED_DIR_MODE });
	} catch (error) {
		const code = codeOf(error);
		if (code !== "EEXIST" && code !== "ENOTDIR") throw new Error(inspect(dir, `it could not be created (${code ?? String(error)})`), { cause: error });
	}
	let stats: fs.Stats;
	try {
		stats = fs.statSync(dir);
	} catch (error) {
		throw new Error(inspect(dir, `it could not be read (${codeOf(error) ?? String(error)})`), { cause: error });
	}
	if (!stats.isDirectory()) throw new Error(inspect(dir, "it is not a directory, and Fusion needs one there"));
	try {
		fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
	} catch (error) {
		throw new Error(inspect(dir, `it is not readable, writable and searchable by this user (${codeOf(error) ?? String(error)})`), { cause: error });
	}
}

/**
 * Whether a user input file is there to be read. A file that is absent, and a symlink whose target is absent, both
 * mean no input at that path, which is the one case this answers `false` for. Anything else — a directory, a socket,
 * a file this user may not read, a parent this user may not search — is a path a call cannot use and says so, rather
 * than passing for a file the user simply does not have.
 */
export function readableInput(file: string): boolean {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(file);
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT") return false;
		throw new Error(inspect(file, `it could not be read (${code ?? String(error)})`), { cause: error });
	}
	if (!stats.isFile()) throw new Error(inspect(file, "it is not a regular file, and Pi reads it as one"));
	try {
		fs.accessSync(file, fs.constants.R_OK);
	} catch (error) {
		throw new Error(inspect(file, `it is not readable by this user (${codeOf(error) ?? String(error)})`), { cause: error });
	}
	return true;
}

/**
 * What an existing catalog directory has to be for a child to use it. The store inside it is checked for its kind and
 * its access and never parsed: Pi writes it under a lock, so an unlocked reader can see a legitimate write half
 * finished, and calling that a malformed store would refuse a healthy profile. Whether the contents make sense is
 * Pi's own check, inside the lock, when the runtime loads the store.
 */
function checkCatalog(catalogDir: string, modelsStorePath: string): void {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(catalogDir);
	} catch (error) {
		throw new Error(inspect(catalogDir, `it could not be read (${codeOf(error) ?? String(error)})`), { cause: error });
	}
	if (!stats.isDirectory()) throw new Error(inspect(catalogDir, "it is not a directory, and the child's model catalog lives in one"));
	try {
		fs.accessSync(catalogDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
	} catch (error) {
		throw new Error(inspect(catalogDir, `it is not readable, writable and searchable by this user (${codeOf(error) ?? String(error)})`), { cause: error });
	}
	let store: fs.Stats;
	try {
		store = fs.statSync(modelsStorePath);
	} catch (error) {
		// A catalog directory without its store is refused rather than used. Letting Pi create the file there is
		// exactly the unlocked cold-file creation this publisher exists to prevent: the store is written before the
		// lock is taken, so two children starting at once can truncate a store the other has populated.
		if (codeOf(error) === "ENOENT") {
			throw new Error(
				inspect(modelsStorePath, "the catalog directory is there and its model store is missing, so the child would create the store unlocked; restore the store, or move the catalog directory aside for Fusion to publish a fresh one"),
				{ cause: error },
			);
		}
		throw new Error(inspect(modelsStorePath, `it could not be read (${codeOf(error) ?? String(error)})`), { cause: error });
	}
	if (!store.isFile()) throw new Error(inspect(modelsStorePath, "it is not a regular file, and Pi's model catalog store is one"));
	try {
		fs.accessSync(modelsStorePath, fs.constants.R_OK | fs.constants.W_OK);
	} catch (error) {
		throw new Error(inspect(modelsStorePath, `it is not readable and writable by this user (${codeOf(error) ?? String(error)})`), { cause: error });
	}
}

/**
 * Publishes the catalog directory with the store already in it, by renaming a directory that is complete into place.
 * Pi's own store looks for a missing file and writes `{}` into it before it takes its lock, so an initializer that
 * decided the file was missing can truncate a store another child has since populated. A directory that arrives
 * whole closes that window: whoever renames first wins, the store is never absent inside a published directory, and
 * a publisher that loses removes its own temporary directory and uses what the winner left. An existing directory is
 * never replaced, emptied or parsed, so a populated store stays byte for byte what it was and a malformed one stays
 * there to be looked at.
 */
export function publishCatalog(paths: Pick<PiPaths, "agentDir" | "catalogDir" | "modelsStorePath">, hooks?: PublishHooks): boolean {
	if (fs.existsSync(paths.catalogDir)) {
		checkCatalog(paths.catalogDir, paths.modelsStorePath);
		return false;
	}
	const staging = fs.mkdtempSync(path.join(paths.agentDir, STAGING_PREFIX));
	let renamed = false;
	try {
		fs.writeFileSync(path.join(staging, path.basename(paths.modelsStorePath)), "{}", { mode: PRIVATE_FILE_MODE });
		hooks?.onStaged?.(staging);
		try {
			fs.renameSync(staging, paths.catalogDir);
			renamed = true;
		} catch (error) {
			if (!TAKEN.has(codeOf(error) ?? "")) throw new Error(inspect(paths.catalogDir, `it could not be published (${codeOf(error) ?? String(error)})`), { cause: error });
			checkCatalog(paths.catalogDir, paths.modelsStorePath);
		}
	} finally {
		// Only ever this publisher's own staging directory: the winner's is the one that is no longer at this path.
		if (!renamed) fs.rmSync(staging, { recursive: true, force: true });
	}
	return renamed;
}

/** The handle as a directory name, or an error naming what it holds that a path may not. */
export function safeHandle(handle: string): string {
	if (!SAFE_HANDLE.test(handle)) {
		throw new Error(
			`handle ${JSON.stringify(handle)} cannot name a directory: a handle holds letters, digits, dot, dash and underscore, starts with a letter or a digit, and carries no path separator, no drive letter and no ..`,
		);
	}
	return handle;
}

/** The storage one call runs with, and the only way to remove what preparing it made. */
export interface PreparedCall extends CallStorage {
	/**
	 * Removes this call's own directory, and only ever the one this call made: the path is closed over rather than
	 * passed in, so no caller can name another call's directory, a session directory or the catalog cache here.
	 * Removing a directory that is already gone is a no-op, so a caller's `finally` can run twice.
	 */
	dispose(): void;
}

/**
 * The storage one call runs with, prepared: the stable directories exist, the catalog directory is published, and
 * this invocation has a directory of its own. Continuing a handle prepares a new call directory rather than reusing
 * the last one, because the input a continuation is launched with is not the input the first call was launched with.
 */
export function prepareCallStorage(request: StorageRequest, hooks?: PublishHooks): PreparedCall {
	const handle = safeHandle(request.handle);
	const paths = piPaths(request.hostAgentDir, request.cwd);
	// The session directory's own parent is created with it: a recursive mkdir gives every directory it makes the mode.
	for (const dir of [paths.root, paths.agentDir, paths.sessionDir, paths.callsDir]) ownedDir(dir);
	publishCatalog(paths, hooks);
	// The user's own files are resolved before this call has a directory of its own, so a profile that has to be
	// repaired first fails without leaving a directory nobody holds the name of behind in the calls directory.
	const modelsPath = readableInput(paths.userModelsPath) ? paths.userModelsPath : null;
	const sharedAuth = readableInput(paths.userAuthPath);
	// mkdtemp makes the directory itself, and makes it private: a unique one per invocation, handle continued or not.
	const callDir = fs.mkdtempSync(path.join(paths.callsDir, `${handle}-`));
	try {
		const cacheDir = path.join(callDir, CACHE_DIR);
		for (const dir of [cacheDir, path.join(cacheDir, JITI_CACHE_DIR), path.join(cacheDir, NODE_CACHE_DIR)]) ownedDir(dir);
		return {
			...paths,
			handle,
			cwd: path.resolve(request.cwd),
			callDir,
			inputPath: path.join(callDir, INPUT_FILE),
			cacheDir,
			modelsPath,
			privateModelsPath: path.join(callDir, MODELS_FILE),
			// A user with no auth file gets this call's private path, never the path they do not have: Pi creates the
			// file it is given, and the one place a child may create one is a directory Fusion disposes of afterwards.
			authPath: sharedAuth ? paths.userAuthPath : path.join(callDir, AUTH_FILE),
			sharedAuth,
			dispose: () => disposeCall(callDir),
		};
	} catch (error) {
		// Nobody holds this directory's name yet: the call it was made for never got a disposer, so the one caller that
		// could remove it is this one. A cleanup that cannot finish leaves the directory behind rather than the failure.
		try {
			disposeCall(callDir);
		} catch {}
		throw error;
	}
}

/** Writes the input this call's child is launched with. Private, because it names the auth file the child reads. */
export function writeCallInput(storage: CallStorage, input: unknown): string {
	fs.writeFileSync(storage.inputPath, JSON.stringify(input), { mode: PRIVATE_FILE_MODE });
	return storage.inputPath;
}

/**
 * What `dispose` does, and it is not exported: the only caller is the closure `prepareCallStorage` bound to the
 * directory it made. The shape check stays as the second line of defence, so a future refactor that widened the way
 * in would still remove nothing outside a call directory.
 */
function disposeCall(callDir: string): void {
	const resolved = path.resolve(callDir);
	const parent = path.dirname(resolved);
	if (path.basename(parent) !== CALLS_DIR || path.basename(path.dirname(parent)) !== FUSION_DIR) {
		throw new Error(`refusing to dispose ${resolved}: a call directory sits directly under ${FUSION_DIR}/${CALLS_DIR} and this path does not, so nothing was removed`);
	}
	fs.rmSync(resolved, { recursive: true, force: true });
}
