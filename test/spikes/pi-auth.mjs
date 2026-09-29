#!/usr/bin/env node
/*
 * Manual auth-store qualification harness, run by hand: what the installed SDK's public credential store does with
 * the auth file a production Pi call would be pointed at. It is not part of `npm test` — the default glob is
 * `test/*.test.ts`, which does not reach this directory — and nothing here is imported by a test.
 *
 *   node test/spikes/pi-auth.mjs [--case <name|group>[,<name|group>...]] [--package <dir>] [--keep]
 *
 * What runs each case is `test/spikes/pi-auth-driver.mjs`, one process per caller, which asks the production
 * `prepareCallStorage` and `bootstrapInput` which auth, models and catalog paths a call runs on and then hands
 * `ModelRuntime.create` the same options the production bootstrap hands it. This harness owns everything around
 * that: a disposable fixture root per run, a synthesized minimal environment, a loopback control service that mints
 * the dummy tokens and holds the gates, and the assertions.
 *
 * Safety, which the cases below depend on rather than assume: every credential value is a literal `DUMMY-` label and
 * no real profile, token, provider or registry is ever reached; every writable path a driver knows about is inside
 * this run's own fixture root; the environment is built from nothing, so no provider key, Pi variable, profile path,
 * `NODE_OPTIONS` or compile-cache setting of this machine reaches a driver; and `pi-fetch-guard.mjs` is preloaded
 * into every driver, so a request to an origin this harness does not own fails before it is sent and is recorded.
 * The guard wraps `globalThis.fetch` in the processes it is preloaded into and nothing else: it is not a sandbox, not
 * a socket boundary and says nothing about a subprocess. A claim that no request was made is therefore only made
 * where the guard is proved to have been installed in the process the claim is about.
 *
 * One entry here is a control rather than a case, and is counted apart everywhere: `C1-fake-constructor-leak` runs no
 * SDK at all. It points the driver at a generated fake package, with the repository's own test-only module fence
 * preloaded so an import of the real SDK by name would be refused, and checks that a foreign constructor failure
 * quoting dummy credentials reaches the record as evidence and reaches no stream or file as text. It is evidence
 * about this harness, never about a build, a credential or a version.
 *
 * What this is not: the production bootstrap, a transport, a provider client, an auth implementation or a credential
 * store of Fusion's own. There is no session, no model request and no RPC in this half at all — a driver that failed
 * or was refused is not a session, because none of these processes ever constructs one. Everything it reports is a
 * measurement of the installed SDK, never a version rule this repository enforces.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const spikeDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(spikeDir, "..", "..");
const DRIVER = path.join(spikeDir, "pi-auth-driver.mjs");
const FETCH_GUARD = path.join(spikeDir, "pi-fetch-guard.mjs");
/** What the guard claims about itself, so an older or weakened copy cannot pass for the one these cases require. */
const GUARD_REDIRECT_CLAIM = "never followed automatically";
const CONTRACT_FILE = path.join(repoRoot, "contracts", "implement.md");
/** The repository's own test-only module fence, used by the fake-constructor control alone. */
const SDK_FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");
const SDK_FENCE_MARKER = "pi-fusion test fence:";
/** The repository's own SDK: the package the production bootstrap would import, resolved the way an importer does. */
const repoPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");

const PROVIDER = "fixture-oauth";
const MODEL = "fixture-model";
const ROLE_MODEL = `${PROVIDER}/${MODEL}`;
const DUMMY_MARKER = "DUMMY-";
/** The provider-specific extra field on the selected entry: it survives a rotation only if the callback re-emits it. */
const EXTRA_FIELD = "fixtureExtra";
const EXTRA_VALUE = "DUMMY-extra-keep-me";
const MINUTE = 60_000;

/** Bounds. Each one is a deadline on something observable, never a sleep that stands in for a handshake. */
const GATE_DEADLINE_MS = 60_000;
const TOKEN_DEADLINE_MS = 30_000;
/** The overlap bound, from the first held token request. Below the SDK's own 15s OAuth refresh timeout on purpose. */
const OVERLAP_DEADLINE_MS = 10_000;
const DRIVER_EXIT_DEADLINE_MS = 120_000;

/* ------------------------------------------------------------------ selectors */

const argv = process.argv.slice(2);
/**
 * A flag that takes a value, read before anything is opened or started. A flag with nothing after it, or with the
 * next flag in the value's place, is a mistake rather than a value: reading it as one would send this harness at a
 * path the caller did not name, so it is collected here and refused in `main` before any file is touched.
 */
const flagErrors = [];
const flag = (name) => {
	const index = argv.indexOf(name);
	if (index === -1) return undefined;
	const value = argv[index + 1];
	if (value === undefined) {
		flagErrors.push(`${name} needs a value and nothing follows it`);
		return undefined;
	}
	if (value.startsWith("--")) {
		flagErrors.push(`${name} needs a value and the next argument is the flag ${JSON.stringify(value)}`);
		return undefined;
	}
	return value;
};
const keepRoot = argv.includes("--keep");
const selector = flag("--case");
const altPackage = flag("--package");

/* ------------------------------------------------------------------ small file helpers */

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
const write = (file, text, options) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, options);
};
const writeJson = (file, value, options) => write(file, `${JSON.stringify(value, null, 2)}\n`, options);
const readJsonIfPresent = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** path -> kind/size/hash for everything under dir, so a diff names files instead of counting them. */
function snapshot(dir) {
	const entries = new Map();
	const walk = (current, prefix) => {
		let names;
		try {
			names = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				entries.set(rel, `symlink:${fs.readlinkSync(full)}`);
				continue;
			}
			if (entry.isDirectory()) {
				entries.set(rel, "dir");
				walk(full, rel);
				continue;
			}
			try {
				entries.set(rel, `file:${fs.statSync(full).size}:${sha(fs.readFileSync(full))}`);
			} catch {
				entries.set(rel, "file:unreadable");
			}
		}
	};
	walk(dir, "");
	return entries;
}

function diffSnapshots(before, after) {
	const created = [];
	const modified = [];
	const removed = [];
	for (const [rel, value] of after) {
		const previous = before.get(rel);
		if (previous === undefined) created.push(rel);
		else if (previous !== value) modified.push(rel);
	}
	for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
	return { created, modified, removed };
}

const isEmptyDiff = (diff) => diff.created.length === 0 && diff.modified.length === 0 && diff.removed.length === 0;
const formatDiff = (diff) => `created=${JSON.stringify(diff.created)} modified=${JSON.stringify(diff.modified)} removed=${JSON.stringify(diff.removed)}`;

/**
 * What the generic profile diff leaves out, and why that is not a gap. Three paths are excluded from it: the managed
 * subtree, which is Fusion's own and is inspected separately; the user's `auth.json`, which the rotation cases are
 * about; and the adjacent `auth.json.lock`, which the credential store creates and removes for a read as much as for
 * a refresh. Both excluded credential paths are asserted on their own terms instead — the file by its bytes, its
 * selected entry's labels, its unrelated entries and its mode, and the lock by having to be gone once every writer
 * has exited — so nothing about them is merely unwatched.
 */
const FUSION_MANAGED_DIR = "pi-fusion";
const AUTH_FILE = "auth.json";
const profileSnapshot = (profile) => new Map([...snapshot(profile)].filter(([rel]) => rel !== FUSION_MANAGED_DIR && !rel.startsWith(`${FUSION_MANAGED_DIR}/`) && rel !== AUTH_FILE && rel !== `${AUTH_FILE}.lock` && !rel.startsWith(`${AUTH_FILE}.lock/`)));

/** Where a path under the managed subtree may appear: the published catalog, the durable sessions, the call dirs. */
const managedPathIsExpected = (rel) => ["children", "calls"].some((top) => rel === top || rel.startsWith(`${top}/`));

/* ------------------------------------------------------------------ the shared credential file */

/**
 * The seed every case writes into the user profile's `auth.json`, and the only credential material anywhere in this
 * spike. Who touches this file, precisely: inside a driver the SDK's own credential store reads it and rotates it
 * through the public API, which is the behavior under measurement; that driver's own observation code never reads its
 * bytes; and the controller below snapshots it only while no driver is running — before a case's writers start, or
 * after every one of them has exited. Besides the selected entry it carries three unrelated ones that every assertion requires to come back JSON
 * for JSON: an ordinary api-key credential for another provider, an entry under the key `meta` standing for something
 * a newer runtime may write beside the credentials, and an entry for a provider nothing here registers. All three are
 * valid generic credential shapes with dummy values, because an entry the store refuses to parse would be testing a
 * different thing. No credential here is a command value and none is a real refresh-token family.
 */
const UNRELATED = {
	"fixture-other": { type: "api_key", key: "DUMMY-api-key-other", env: { FIXTURE_ACCOUNT: "DUMMY-account-id" } },
	meta: { type: "api_key", key: "DUMMY-api-key-meta-newer-entry" },
	"fixture-unknown-provider": { type: "api_key", key: "DUMMY-api-key-unknown-provider" },
};

const seedCredential = (expiresAt) => ({ type: "oauth", access: "DUMMY-access-1", refresh: "DUMMY-refresh-1", expires: expiresAt, [EXTRA_FIELD]: EXTRA_VALUE });

/** One shared file, seeded 0600. There is never a copy of the family: every leg of every case reads this one file. */
function seedAuthFile(file, selected) {
	const data = selected === undefined ? { ...UNRELATED } : { [PROVIDER]: selected, ...UNRELATED };
	write(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	return fs.readFileSync(file);
}

const readAuth = (file) => {
	const bytes = fs.readFileSync(file);
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		parsed = undefined;
	}
	return { bytes, sha: sha(bytes), parsed, mode: (fs.statSync(file).mode & 0o777).toString(8) };
};

const labelOf = (value) => {
	const found = typeof value === "string" ? /^DUMMY-(?:access|refresh)-(\d+)$/.exec(value) : null;
	return found ? Number(found[1]) : null;
};

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Two path-to-count maps, compared as sets of pairs: which path was requested first must not decide a case. */
const sameCounts = (a, b) => sameJson(Object.entries(a).sort(), Object.entries(b).sort());
const unrelatedPreserved = (parsed) => parsed !== undefined && Object.keys(UNRELATED).every((key) => sameJson(parsed[key], UNRELATED[key]));

/* ------------------------------------------------------------------ fixture root and environment */

/**
 * One case's own directories, all of them under this run's fixture root: the user profile the storage layout is
 * derived from, the project a call runs in, and the home, temporary, cache and default-agent directories the driver's
 * environment points at, so a driver that ignored what it was handed would still write inside this root.
 */
function setupCase(root, name) {
	const caseRoot = path.join(root, "cases", name);
	const dirs = {
		name,
		caseRoot,
		profile: path.join(caseRoot, "user-profile"),
		project: path.join(caseRoot, "project"),
		home: path.join(caseRoot, "home"),
		tmp: path.join(caseRoot, "tmp"),
		xdg: path.join(caseRoot, "xdg"),
		caches: path.join(caseRoot, "caches"),
		defaultAgentDir: path.join(caseRoot, "default-agent-dir"),
		logs: path.join(caseRoot, "logs"),
	};
	for (const dir of [dirs.profile, dirs.project, dirs.home, dirs.tmp, dirs.xdg, dirs.caches, dirs.defaultAgentDir, dirs.logs]) fs.mkdirSync(dir, { recursive: true });
	write(path.join(dirs.project, "AGENTS.md"), "# Auth spike fixture project\n\nNothing here is read by a model: this half runs no session.\n");
	dirs.authPath = path.join(dirs.profile, AUTH_FILE);
	dirs.fetchLog = path.join(dirs.logs, "fetch.log");
	// Composing the environment once here creates every directory a driver's environment names, so the snapshot a case
	// takes next is of the shape a driver will find rather than of one an environment then adds directories to.
	driverEnv(dirs, { caller: "setup", origins: [] });
	return dirs;
}

/**
 * A driver's environment, synthesized from nothing: this machine's provider keys, Pi variables, profile paths,
 * coverage and compile-cache settings and `NODE_OPTIONS` reach no driver, because none of them is copied. `PATH` is
 * the one inherited value, and it is the ordinary one — no shim directory is put in front of it anywhere in this
 * spike. Every other value that names a path is created and required to be inside the case's own root.
 */
function driverEnv(dirs, { caller, origins, fence = false }) {
	const env = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: dirs.home,
		USERPROFILE: dirs.home,
		TMPDIR: dirs.tmp,
		TMP: dirs.tmp,
		TEMP: dirs.tmp,
		XDG_CACHE_HOME: path.join(dirs.xdg, "cache"),
		XDG_CONFIG_HOME: path.join(dirs.xdg, "config"),
		XDG_DATA_HOME: path.join(dirs.xdg, "data"),
		XDG_STATE_HOME: path.join(dirs.xdg, "state"),
		APPDATA: path.join(dirs.home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(dirs.home, "AppData", "Local"),
		NODE_COMPILE_CACHE: path.join(dirs.caches, "node"),
		JITI_FS_CACHE: path.join(dirs.caches, "jiti"),
		// Where a default agent directory would land if anything resolved one: inside this case, never a real profile.
		PI_CODING_AGENT_DIR: dirs.defaultAgentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		NO_COLOR: "1",
	};
	const caseReal = fs.realpathSync(dirs.caseRoot);
	for (const [name, value] of Object.entries(env)) {
		if (name === "PATH" || name === "NO_COLOR" || !value.includes(path.sep)) continue;
		const resolved = path.resolve(value);
		if (resolved !== caseReal && !resolved.startsWith(`${caseReal}${path.sep}`)) throw new Error(`refusing to launch: ${name}=${value} is outside the case root ${caseReal}`);
		fs.mkdirSync(resolved, { recursive: true });
	}
	// The guard has to be this spike's own file and has to still claim what these cases rest on.
	if (!fs.existsSync(FETCH_GUARD) || path.dirname(FETCH_GUARD) !== spikeDir) throw new Error(`the fetch guard must be this spike's own ${FETCH_GUARD}`);
	if (!fs.readFileSync(FETCH_GUARD, "utf8").includes(GUARD_REDIRECT_CLAIM)) throw new Error(`${FETCH_GUARD} no longer claims ${JSON.stringify(GUARD_REDIRECT_CLAIM)}, so it is not the guard this harness requires`);
	const guardUrl = pathToFileURL(FETCH_GUARD).href;
	if (/\s/.test(guardUrl)) throw new Error(`the fetch guard's path holds whitespace, which NODE_OPTIONS cannot carry: ${guardUrl}`);
	// Added after the loop above: a log file, an origin list and a `--import` option are not directories to create.
	env.PI_SPIKE_CALLER = caller;
	env.PI_SPIKE_FETCH_LOG = dirs.fetchLog;
	env.PI_SPIKE_ALLOWED_ORIGINS = origins.join(",");
	const preloads = [`--import ${guardUrl}`];
	// The second preload, for the fake-constructor control alone: this repository's own test-only module fence, named
	// by its own path and required to be the file that says what that fence says. With it armed, an accidental import
	// of the real SDK by name — by the driver or by the fake package it is pointed at — is refused while it is still a
	// specifier, so a control that must not reach a real runtime cannot reach one. It is a module-resolution rule in
	// that process and nothing more: not a sandbox, not a network boundary.
	if (fence) {
		if (!fs.existsSync(SDK_FENCE) || path.dirname(SDK_FENCE) !== path.join(repoRoot, "test")) throw new Error(`the sdk fence must be this repository's own ${SDK_FENCE}`);
		if (!fs.readFileSync(SDK_FENCE, "utf8").includes(SDK_FENCE_MARKER)) throw new Error(`${SDK_FENCE} does not carry ${JSON.stringify(SDK_FENCE_MARKER)}, so it is not the fence this control requires`);
		const fenceUrl = pathToFileURL(SDK_FENCE).href;
		if (/\s/.test(fenceUrl)) throw new Error(`the sdk fence's path holds whitespace, which NODE_OPTIONS cannot carry: ${fenceUrl}`);
		preloads.push(`--import ${fenceUrl}`);
	}
	env.NODE_OPTIONS = preloads.join(" ");
	return env;
}

/* ------------------------------------------------------------------ the guard's log */

const fetchRecords = (file) => {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		// Absence of evidence rather than evidence of absence: a case claiming "no request" fails on this record.
		return [{ event: "log-missing", file }];
	}
	const records = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			records.push({ event: "unparsed", line });
		}
	}
	return records;
};

/**
 * What the guard says about a case, and the conditions a negative claim rests on: the log has to be readable, every
 * caller the claim is about has to have installed the guard, the installed guards have to still claim redirect
 * protection, and nothing may have been blocked. `expectedPaths` is the exact traffic a case allows — token requests
 * and control calls — asserted by count and by path, because the count is what a rotation claim rests on.
 */
function checkGuard(result, dirs, callers, expectedPaths) {
	const records = fetchRecords(dirs.fetchLog);
	const installed = records.filter((record) => record.event === "installed");
	const installedBy = new Set(installed.map((record) => record.caller));
	const blocked = records.filter((record) => record.event === "blocked");
	const unusable = records.filter((record) => record.event === "no-global-fetch" || record.event === "unparsed" || record.event === "log-missing");
	const allowed = records.filter((record) => record.event === "allowed");
	const byPath = {};
	for (const record of allowed) byPath[record.path] = (byPath[record.path] ?? 0) + 1;
	result.observations.guard = {
		log: records.some((record) => record.event === "log-missing") ? "missing" : "present",
		installedBy: [...installedBy].sort(),
		redirectClaims: [...new Set(installed.map((record) => record.redirects ?? null))],
		allowed: allowed.length,
		blocked: blocked.length,
		byPath,
	};
	const absent = callers.filter((caller) => !installedBy.has(caller));
	result.check(unusable.length === 0, `the guard could not watch a process or wrote something unreadable: ${JSON.stringify(unusable.slice(0, 2))}`);
	result.check(absent.length === 0, `no guard was installed in ${JSON.stringify(absent)}, so a request claim about this case would be about a process nothing was watching`);
	result.check(installed.length > 0 && installed.every((record) => record.redirects === GUARD_REDIRECT_CLAIM), `an installed guard did not claim redirect protection: ${JSON.stringify(result.observations.guard.redirectClaims)}`);
	result.check(blocked.length === 0, `the guard blocked ${blocked.length} request(s) to an origin this fixture does not own: ${JSON.stringify(blocked.slice(0, 3))}`);
	if (expectedPaths !== undefined) {
		result.check(sameCounts(byPath, expectedPaths), `the guarded traffic was ${JSON.stringify(byPath)} and this case allows exactly ${JSON.stringify(expectedPaths)}`);
	}
	return { records, allowed, byPath };
}

/* ------------------------------------------------------------------ the loopback control service */

/**
 * One loopback service per case: the token endpoint the fixture provider's refresh callback posts to, the gates a
 * caller waits on, and the marks a caller publishes. It mints dummy credentials and nothing else — there is no model
 * endpoint behind it, because this half makes no model request; a request to any other path is recorded as
 * unexpected and answered 404 so a case can assert it never happened.
 */
async function startControlService() {
	const state = {
		tokenRequests: [],
		marks: [],
		gates: [],
		unexpected: [],
		/** The generation counter: the seed is label 1, so the first minted credential is label 2. */
		nextLabel: 2,
		lifetimeMs: 40 * MINUTE,
		failNext: 0,
		hold: false,
		heldResponses: [],
		releasedGates: new Set(),
		gateWaiters: [],
	};

	const mint = () => {
		const label = state.nextLabel++;
		return { access: `DUMMY-access-${label}`, refresh: `DUMMY-refresh-${label}`, expiresInMs: state.lifetimeMs, label };
	};
	const answer = (response, body, status = 200) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};

	const server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		if (url.pathname === "/token" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				let sent;
				try {
					sent = JSON.parse(body);
				} catch {
					sent = {};
				}
				const record = { at: Date.now(), caller: sent.caller ?? null, refreshLabel: labelOf(sent.refresh), carriesDummyMarker: typeof sent.refresh === "string" && sent.refresh.includes(DUMMY_MARKER) };
				state.tokenRequests.push(record);
				if (state.failNext > 0) {
					state.failNext--;
					record.outcome = "500";
					answer(response, { error: "fixture token endpoint refused before minting" }, 500);
					return;
				}
				if (state.hold) {
					record.outcome = "held";
					state.heldResponses.push({ response, record });
					return;
				}
				const minted = mint();
				record.outcome = "minted";
				record.mintedLabel = minted.label;
				answer(response, minted);
			});
			return;
		}
		if (url.pathname === "/gate") {
			const name = url.searchParams.get("name") ?? "";
			const arrival = { name, caller: url.searchParams.get("caller"), at: Date.now(), response };
			state.gates.push(arrival);
			if (state.releasedGates.has(name)) {
				arrival.releasedAt = Date.now();
				answer(response, { released: true });
			} else {
				state.gateWaiters.push(arrival);
			}
			return;
		}
		if (url.pathname === "/mark") {
			state.marks.push({ stage: url.searchParams.get("stage"), caller: url.searchParams.get("caller"), at: Date.now() });
			answer(response, { recorded: true });
			return;
		}
		state.unexpected.push({ at: Date.now(), method: request.method, path: url.pathname });
		answer(response, { error: "no such fixture endpoint" }, 404);
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const baseUrl = `http://127.0.0.1:${port}`;

	/** Waits for something observable, never for a duration: a deadline that expires is a failure a case reports. */
	const waitFor = async (what, predicate, timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const value = predicate();
			if (value) return value;
			await sleep(20);
		}
		throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
	};

	return {
		baseUrl,
		origin: baseUrl,
		state,
		setMint: ({ lifetimeMs }) => {
			state.lifetimeMs = lifetimeMs;
		},
		failNextTokenRequests: (count) => {
			state.failNext = count;
		},
		holdTokenResponses: (hold) => {
			state.hold = hold;
		},
		releaseHeldTokens: () => {
			const held = state.heldResponses.splice(0);
			for (const entry of held) {
				const minted = mint();
				entry.record.outcome = "minted-after-hold";
				entry.record.mintedLabel = minted.label;
				entry.record.releasedAt = Date.now();
				answer(entry.response, minted);
			}
			return held.length;
		},
		releaseGate: (name) => {
			state.releasedGates.add(name);
			const waiting = state.gateWaiters.filter((entry) => entry.name === name);
			state.gateWaiters = state.gateWaiters.filter((entry) => entry.name !== name);
			for (const entry of waiting) {
				entry.releasedAt = Date.now();
				answer(entry.response, { released: true });
			}
			return waiting.length;
		},
		waitForGate: (name, timeoutMs = GATE_DEADLINE_MS) => waitFor(`gate ${name}`, () => state.gates.find((entry) => entry.name === name), timeoutMs),
		waitForTokenRequests: (count, timeoutMs = TOKEN_DEADLINE_MS) => waitFor(`${count} token request(s)`, () => (state.tokenRequests.length >= count ? state.tokenRequests.slice(0, count) : undefined), timeoutMs),
		waitForMark: (stage, caller, timeoutMs) => waitFor(`the ${stage} mark from ${caller}`, () => state.marks.find((mark) => mark.stage === stage && mark.caller === caller), timeoutMs),
		marksOf: (stage) => state.marks.filter((mark) => mark.stage === stage),
		close: async () => {
			for (const entry of state.heldResponses.splice(0)) answer(entry.response, { error: "fixture closing" }, 503);
			for (const entry of state.gateWaiters.splice(0)) answer(entry.response, { error: "fixture closing" }, 503);
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/* ------------------------------------------------------------------ drivers */

const driverSpec = ({ dirs, service, caller, handle, packageRoot, minOAuthValidityMs, gate, lockProbe, deferAwait, control }) => ({
	caller,
	repoRoot,
	packageRoot,
	hostAgentDir: dirs.profile,
	cwd: dirs.project,
	handle,
	role: { name: "implement", model: ROLE_MODEL },
	contractFile: CONTRACT_FILE,
	provider: { id: PROVIDER, name: "Fixture OAuth (dummy)", baseUrl: `${service.baseUrl}/v1`, modelId: MODEL },
	tokenUrl: `${service.baseUrl}/token`,
	...(control === false ? {} : { controlUrl: service.baseUrl }),
	...(minOAuthValidityMs === undefined ? {} : { minOAuthValidityMs }),
	...(gate === undefined ? {} : { gate }),
	...(lockProbe ? { lockProbe: true } : {}),
	...(deferAwait ? { deferAwait: true } : {}),
	observations: path.join(dirs.logs, `${caller}.json`),
});

/** Starts one driver and keeps its own handle: every bound below is on this handle, never on a remembered pid. */
function startDriver(dirs, service, options) {
	const spec = driverSpec({ dirs, service, ...options });
	const specFile = path.join(dirs.logs, `${options.caller}.spec.json`);
	writeJson(specFile, spec);
	const env = driverEnv(dirs, { caller: options.caller, origins: [service.origin], fence: options.fence === true });
	const child = spawn(process.execPath, [DRIVER, "resolve", specFile], { cwd: dirs.project, env, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	// Both streams are kept, not just the one a case reads: the leakage control asserts about the raw bytes of each.
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) => {
		child.on("error", (error) => resolve({ code: null, signal: null, error: String(error.message ?? error) }));
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	return {
		caller: options.caller,
		child,
		spec,
		finish: async () => {
			// The deadline is a timer on the handle this harness owns, cleared the moment the driver exits: an overrun
			// is killed through that handle and reported, and nothing here searches for a process by a remembered pid.
			let killedAfterDeadline = false;
			const timer = setTimeout(() => {
				killedAfterDeadline = true;
				child.kill("SIGKILL");
			}, DRIVER_EXIT_DEADLINE_MS);
			const exit = await exited;
			clearTimeout(timer);
			return {
				exit: killedAfterDeadline ? { ...exit, killedAfterDeadline: true } : exit,
				observations: readJsonIfPresent(spec.observations) ?? { missing: true },
				observationsText: (() => {
					try {
						return fs.readFileSync(spec.observations, "utf8");
					} catch {
						return "";
					}
				})(),
				stdout,
				stderr,
			};
		},
	};
}

const runDriver = async (dirs, service, options) => startDriver(dirs, service, options).finish();

/* ------------------------------------------------------------------ results */

function caseResult(name, group, title, notes = []) {
	const result = { name, group, kind: "case", title, notes: [...notes], observations: {}, failures: [], skipped: null };
	result.check = (ok, message) => {
		if (!ok) result.failures.push(message);
		return ok;
	};
	return result;
}

/** The driver ran at all, exited cleanly and left its observations: everything else a case asserts rests on this. */
function checkDriverRan(result, key, run, { expectAggregateError = false } = {}) {
	const aggregate = run.observations.aggregate ?? {};
	result.observations[key] = {
		exit: run.exit,
		sdk: run.observations.sdk ? { version: run.observations.sdk.version, reportedVersion: run.observations.sdk.reportedVersion } : null,
		stages: (run.observations.stages ?? []).map((entry) => entry.stage),
		sharedAuth: run.observations.selected?.sharedAuth ?? null,
		authPath: run.observations.selected?.authPath ?? null,
		inputOptions: run.observations.selected?.input ?? null,
		observedOffline: run.observations.env?.PI_OFFLINE ?? null,
		inputModelsPathExists: run.observations.selected?.inputModelsPathExists ?? null,
		aggregate,
		hasConfiguredAuth: run.observations.hasConfiguredAuth ?? null,
		getAuth: run.observations.getAuth ?? null,
		callback: run.observations.callback ?? [],
		disposed: run.observations.disposed ?? null,
	};
	if (run.observations.error) result.observations[key].driverError = run.observations.error;
	if (run.stderr.trim()) result.observations[`${key}Stderr`] = run.stderr.trim().split("\n").slice(-3).join(" | ");
	result.check(run.exit.code === 0, `${key} exited ${JSON.stringify(run.exit)} rather than 0`);
	result.check(run.observations.runtimeCreated === true, `${key} did not construct a model runtime`);
	// The option set is the production one: the bootstrap's own catalog permission and the storage's own paths. That
	// permission is composed true, and this spike still makes no catalog request, because the driver's environment
	// carries `PI_OFFLINE=1` and this build's runtime acts on the permission only when that variable is absent. Both
	// halves are required here, so a case can never pass on one of them alone.
	result.check(run.observations.selected?.input?.allowModelNetwork === true, `${key} was not given the composed allowModelNetwork=true`);
	result.check(run.observations.env?.PI_OFFLINE === "1", `${key} ran with PI_OFFLINE=${JSON.stringify(run.observations.env?.PI_OFFLINE)} rather than the synthesized "1", so its catalog permission was not held off by the environment`);
	// And the models path is the absent private one the layout depends on: a models file that existed, or a path that
	// was not the storage's own private one, would mean this call ran on a configuration nobody here composed.
	result.check(
		run.observations.selected?.input?.modelsPath === run.observations.selected?.privateModelsPath,
		`${key} was given models path ${JSON.stringify(run.observations.selected?.input?.modelsPath)} rather than the storage's own private one ${JSON.stringify(run.observations.selected?.privateModelsPath)}`,
	);
	result.check(run.observations.selected?.inputModelsPathExists === false, `${key} was given a models path that exists, and this layout depends on that path being absent`);
	// The aggregate has to be readable at both points before anything is concluded from it: an accessor that is
	// missing, throws or answers a shape the production bootstrap does not read is a compatibility finding, and it
	// must never pass for "no error was reported".
	result.check(aggregate.afterCreate?.usable === true && aggregate.afterRegister?.usable === true, `${key} could not read ModelRuntime.getError() at both points: ${JSON.stringify(aggregate)}`);
	if (expectAggregateError) {
		// The one opt-out, taken by a case whose configuration is deliberately broken; that case asserts its own
		// evidence rather than leaving the aggregate unexamined.
		result.observations[`${key}AggregateExpected`] = "this case expects a reported aggregate error and asserts it itself";
	} else {
		// A healthy configuration reports nothing, which is exactly what production requires before it runs a call.
		result.check(aggregate.afterCreate?.empty === true, `${key} reported an aggregate error after create, and production refuses a call on one: ${JSON.stringify(aggregate.afterCreate)}`);
		result.check(aggregate.afterRegister?.empty === true, `${key} reported an aggregate error after registering the provider: ${JSON.stringify(aggregate.afterRegister)}`);
	}
	// Every driver disposes of its own call directory, whatever else it found.
	result.check(run.observations.disposed === true, `${key} did not dispose of its own call directory (disposed=${JSON.stringify(run.observations.disposed)})`);
	return run.observations;
}

/** What a call that must not create a user file leaves behind: a private path inside its own call directory. */
function checkPrivateAuth(result, key, observations) {
	result.check(observations.selected?.sharedAuth === false, `${key} selected a shared auth file although this case has none the storage may read`);
	result.check(typeof observations.selected?.authPath === "string" && observations.selected.authPath.startsWith(`${observations.selected.callDir}${path.sep}`), `${key} did not put its private auth file inside its own call directory: ${observations.selected?.authPath}`);
	result.check(observations.selected?.authFileBeforeCreate?.present === false, `${key} found a private auth file before the runtime was created: ${JSON.stringify(observations.selected?.authFileBeforeCreate)}`);
	result.check(observations.authFileAfterCreate?.present === true && observations.authFileAfterCreate?.emptyObject === true, `${key} did not get an empty private auth file from the runtime: ${JSON.stringify(observations.authFileAfterCreate)}`);
	result.check(observations.privateAuthBeforeDispose?.present === true, `${key} had no private auth file before disposal: ${JSON.stringify(observations.privateAuthBeforeDispose)}`);
	result.check(observations.privateAuthAfterDispose === false, `${key} left its private auth file behind after disposal`);
	result.check(observations.disposed === true, `${key} left its call directory behind`);
	result.observations[`${key}PrivateAuth`] = { before: observations.selected?.authFileBeforeCreate, afterCreate: observations.authFileAfterCreate, afterDispose: observations.privateAuthAfterDispose };
}

/** The user's own files, the project and the home directory: none of them may change in any case here. */
function checkSurroundings(result, dirs, before) {
	const diffs = {
		profile: diffSnapshots(before.profile, profileSnapshot(dirs.profile)),
		project: diffSnapshots(before.project, snapshot(dirs.project)),
		home: diffSnapshots(before.home, snapshot(dirs.home)),
	};
	result.observations.surroundings = Object.fromEntries(Object.entries(diffs).map(([name, diff]) => [name, formatDiff(diff)]));
	result.check(isEmptyDiff(diffs.profile), `the user's own profile files changed outside the managed subtree and the auth file: ${formatDiff(diffs.profile)}`);
	result.check(isEmptyDiff(diffs.project), `the project changed: ${formatDiff(diffs.project)}`);
	result.check(isEmptyDiff(diffs.home), `the home directory changed: ${formatDiff(diffs.home)}`);
	const managed = [...snapshot(path.join(dirs.profile, FUSION_MANAGED_DIR)).keys()].filter((rel) => !managedPathIsExpected(rel));
	result.check(managed.length === 0, `the managed subtree gained something outside the child agent directory and the calls directory: ${JSON.stringify(managed)}`);
	// Every writer has exited by now, so the calls directory has to be empty in every case rather than only where a
	// case looked: a call directory left behind is a leak whoever made it, and the list above is not widened to hide one.
	const callsLeft = fs.readdirSync(path.join(dirs.profile, FUSION_MANAGED_DIR, "calls"));
	result.observations.callsDirAfterExits = callsLeft;
	result.check(callsLeft.length === 0, `the managed calls directory still holds ${JSON.stringify(callsLeft)} after every writer had exited`);
	// The lock is the store's own and is adjacent to the credential file; none may survive the writers.
	result.observations.lockAfterExits = fs.existsSync(`${dirs.authPath}.lock`);
	result.check(result.observations.lockAfterExits === false, "an auth.json.lock was still there after every writer had exited");
}

const beforeSnapshots = (dirs) => ({ profile: profileSnapshot(dirs.profile), project: snapshot(dirs.project), home: snapshot(dirs.home) });

/* ------------------------------------------------------------------ the cases */

/** A1: a credential inside the ordinary five-minute refresh window rotates once and writes back to the user's file. */
async function caseRotate(ctx) {
	const dirs = setupCase(ctx.root, "A1-rotate");
	const result = caseResult("A1-rotate", "A1", "one caller, expiry inside the ordinary refresh window: one token request, one write back");
	const service = ctx.service;
	const seedBytes = seedAuthFile(dirs.authPath, seedCredential(Date.now() + MINUTE));
	const before = beforeSnapshots(dirs);
	service.setMint({ lifetimeMs: 40 * MINUTE });
	const run = await runDriver(dirs, service, { caller: "A1", handle: "a1", packageRoot: ctx.repoPackageRoot, control: false });
	const observations = checkDriverRan(result, "caller", run);
	result.check(observations.selected?.sharedAuth === true, "the storage did not select the user's own auth file");
	result.check(observations.selected?.authPath === dirs.authPath, `the storage selected ${observations.selected?.authPath} rather than the user's own auth file`);
	result.check(observations.getAuth?.ok === true && observations.getAuth.apiKeyLabel === 2, `getAuth resolved ${JSON.stringify(observations.getAuth)} rather than the minted label 2`);
	const after = readAuth(dirs.authPath);
	const selected = after.parsed?.[PROVIDER];
	result.observations.rotated = { accessLabel: labelOf(selected?.access), refreshLabel: labelOf(selected?.refresh), expiresInFutureMs: typeof selected?.expires === "number" ? selected.expires - Date.now() : null, extra: selected?.[EXTRA_FIELD] === EXTRA_VALUE, mode: after.mode, type: selected?.type };
	result.check(labelOf(selected?.access) === 2 && labelOf(selected?.refresh) === 2, `the source file holds ${JSON.stringify(result.observations.rotated)} rather than the minted label 2`);
	result.check(typeof selected?.expires === "number" && selected.expires > Date.now() + 30 * MINUTE, "the written credential does not carry the minted expiry");
	result.check(selected?.[EXTRA_FIELD] === EXTRA_VALUE, "the provider-specific extra field did not survive the rotation, although the callback re-emits it");
	result.check(unrelatedPreserved(after.parsed), "an unrelated credential entry did not come back JSON for JSON");
	result.check(after.sha !== sha(seedBytes), "the source file was not rewritten at all");
	result.check(after.mode === "600", `the seeded 0600 mode became ${after.mode}`);
	result.observations.tokenRequests = service.state.tokenRequests;
	result.check(service.state.tokenRequests.length === 1, `the endpoint saw ${service.state.tokenRequests.length} token request(s) rather than exactly one`);
	result.check(service.state.tokenRequests[0]?.refreshLabel === 1, "the token request did not carry the seeded refresh label");
	checkGuard(result, dirs, ["A1"], { "/token": 1 });
	checkSurroundings(result, dirs, before);
	return result;
}

/** A2: a credential far outside the window is used as it is — no token request and no write at all. */
async function caseFresh(ctx) {
	const dirs = setupCase(ctx.root, "A2-fresh");
	const result = caseResult("A2-fresh", "A2", "one caller, expiry far outside the refresh window: no token request and byte-identical auth file");
	const service = ctx.service;
	const seedBytes = seedAuthFile(dirs.authPath, seedCredential(Date.now() + 60 * MINUTE));
	const before = beforeSnapshots(dirs);
	const run = await runDriver(dirs, service, { caller: "A2", handle: "a2", packageRoot: ctx.repoPackageRoot, control: false });
	const observations = checkDriverRan(result, "caller", run);
	result.check(observations.getAuth?.ok === true && observations.getAuth.apiKeyLabel === 1, `getAuth resolved ${JSON.stringify(observations.getAuth)} rather than the seeded label 1`);
	const after = readAuth(dirs.authPath);
	result.observations.auth = { sha: after.sha, seedSha: sha(seedBytes), mode: after.mode };
	result.check(after.sha === sha(seedBytes), "the auth file changed although nothing was refreshed");
	result.check(Buffer.compare(after.bytes, seedBytes) === 0, "the auth file is not byte-identical to the seed");
	result.check(service.state.tokenRequests.length === 0, `the endpoint saw ${service.state.tokenRequests.length} token request(s) although this case expects none`);
	result.check((observations.callback ?? []).length === 0, `the refresh callback ran: ${JSON.stringify(observations.callback)}`);
	checkGuard(result, dirs, ["A2"], {});
	checkSurroundings(result, dirs, before);
	return result;
}

/**
 * A3: two callers, one shared file, one refresh. Both are constructed and available before either asks, so the
 * store's own startup locks are not what they contend on; the first is released into `getAuth` and its token response
 * is held, the second is released while that lock is held, and the held response is let go only once the second is
 * proved to be inside `getAuth` and neither has finished.
 */
async function caseOverlap(ctx) {
	const dirs = setupCase(ctx.root, "A3-overlap");
	const result = caseResult("A3-overlap", "A3", "two callers overlapping on one shared auth file: one refresh serves both", [
		"the overlap is bounded from the first held token request, below the SDK's own 15s OAuth refresh timeout",
	]);
	const service = ctx.service;
	seedAuthFile(dirs.authPath, seedCredential(Date.now() + MINUTE));
	const before = beforeSnapshots(dirs);
	service.setMint({ lifetimeMs: 40 * MINUTE });
	const first = startDriver(dirs, service, { caller: "A3a", handle: "a3a", packageRoot: ctx.repoPackageRoot, gate: "A3a" });
	let second;
	let firstRun;
	let secondRun;
	try {
		await service.waitForGate("A3a");
		// Sequential startup on purpose: the second caller constructs its runtime while the first is parked at its
		// gate, so neither one's synchronous startup read is what the other waits on later.
		second = startDriver(dirs, service, { caller: "A3b", handle: "a3b", packageRoot: ctx.repoPackageRoot, gate: "A3b", lockProbe: true, deferAwait: true });
		await service.waitForGate("A3b");
		service.holdTokenResponses(true);
		service.releaseGate("A3a");
		const held = await service.waitForTokenRequests(1);
		const deadline = Date.now() + OVERLAP_DEADLINE_MS;
		result.observations.heldTokenRequestAt = held[0].at;
		service.releaseGate("A3b");
		let inflight;
		try {
			inflight = await service.waitForMark("inflight", "A3b", Math.max(0, deadline - Date.now()));
		} catch (error) {
			result.check(false, `the second caller never reported being inside getAuth within the bound: ${String(error.message ?? error)}`);
		}
		result.observations.inflightMark = inflight ?? null;
		const doneBeforeRelease = service.marksOf("done");
		result.observations.doneMarksBeforeRelease = doneBeforeRelease.map((mark) => mark.caller);
		result.check(doneBeforeRelease.length === 0, `a caller had already finished before the held token response was released: ${JSON.stringify(result.observations.doneMarksBeforeRelease)}`);
		result.observations.releasedHeld = service.releaseHeldTokens();
	} finally {
		service.holdTokenResponses(false);
		// Whatever happened above, nothing is left parked: both gates are released and both handles are awaited.
		service.releaseGate("A3a");
		service.releaseGate("A3b");
		service.releaseHeldTokens();
		firstRun = await first.finish();
		if (second) secondRun = await second.finish();
	}
	const firstObservations = checkDriverRan(result, "first", firstRun);
	const secondObservations = secondRun ? checkDriverRan(result, "second", secondRun) : {};
	result.observations.lockSeenBySecondCaller = secondObservations.lockBeforeGetAuth ?? null;
	result.check(secondObservations.lockBeforeGetAuth?.present === true, `the second caller did not see an adjacent lock before it asked: ${JSON.stringify(secondObservations.lockBeforeGetAuth)}`);
	result.check(firstObservations.getAuth?.ok === true && firstObservations.getAuth.apiKeyLabel === 2, `the first caller resolved ${JSON.stringify(firstObservations.getAuth)} rather than the minted label 2`);
	result.check(secondObservations.getAuth?.ok === true && secondObservations.getAuth.apiKeyLabel === 2, `the second caller resolved ${JSON.stringify(secondObservations.getAuth)} rather than the same minted label 2`);
	result.observations.tokenRequests = service.state.tokenRequests;
	result.check(service.state.tokenRequests.length === 1, `two callers produced ${service.state.tokenRequests.length} token request(s) rather than exactly one`);
	result.check((secondObservations.callback ?? []).every((entry) => entry.event !== "refresh-start"), "the second caller ran the refresh callback as well");
	const after = readAuth(dirs.authPath);
	const selected = after.parsed?.[PROVIDER];
	result.observations.rotated = { accessLabel: labelOf(selected?.access), refreshLabel: labelOf(selected?.refresh), extra: selected?.[EXTRA_FIELD] === EXTRA_VALUE, mode: after.mode };
	result.check(labelOf(selected?.access) === 2, `the persisted file holds ${JSON.stringify(result.observations.rotated)} rather than one rotation to label 2`);
	result.check(unrelatedPreserved(after.parsed), "an unrelated credential entry did not come back JSON for JSON");
	// Two gate calls, two mark calls from the deferring caller and one from the other, and one token request.
	checkGuard(result, dirs, ["A3a", "A3b"], { "/token": 1, "/gate": 2, "/mark": 3 });
	checkSurroundings(result, dirs, before);
	return result;
}

/** A4: a callback failure before the endpoint ever minted, and the same family used by a later caller afterwards. */
async function caseFailThenReuse(ctx) {
	const dirs = setupCase(ctx.root, "A4-fail-then-reuse");
	const result = caseResult("A4-fail-then-reuse", "A4", "a refresh that fails before a token is minted, then a later caller on the same file", [
		"this measures a callback failure before a successful token return, not a response lost after a real provider had already rotated",
	]);
	const service = ctx.service;
	const seedBytes = seedAuthFile(dirs.authPath, seedCredential(Date.now() + MINUTE));
	const before = beforeSnapshots(dirs);
	service.setMint({ lifetimeMs: 40 * MINUTE });
	service.failNextTokenRequests(1);
	const failed = await runDriver(dirs, service, { caller: "A4a", handle: "a4a", packageRoot: ctx.repoPackageRoot, control: false });
	const failedObservations = checkDriverRan(result, "failing", failed);
	result.check(failedObservations.getAuth?.ok === false, `the first caller resolved ${JSON.stringify(failedObservations.getAuth)} although the endpoint refused`);
	result.observations.failureEvidence = failedObservations.getAuth?.evidence ?? null;
	result.check(failedObservations.getAuth?.evidence?.containsDummyMarker === false, "the SDK's failure text carried a dummy credential label, which is evidence the production bootstrap must keep refusing to repeat");
	const between = readAuth(dirs.authPath);
	result.observations.afterFailure = { sha: between.sha, seedSha: sha(seedBytes), lock: fs.existsSync(`${dirs.authPath}.lock`) };
	result.check(between.sha === sha(seedBytes), "the source file changed although no token was ever minted");
	result.check(fs.existsSync(`${dirs.authPath}.lock`) === false, "the lock was still held after the failing caller exited");
	const reused = await runDriver(dirs, service, { caller: "A4b", handle: "a4b", packageRoot: ctx.repoPackageRoot, control: false });
	const reusedObservations = checkDriverRan(result, "reusing", reused);
	result.check(reusedObservations.getAuth?.ok === true && reusedObservations.getAuth.apiKeyLabel === 2, `the later caller resolved ${JSON.stringify(reusedObservations.getAuth)} rather than the minted label 2`);
	const after = readAuth(dirs.authPath);
	result.observations.tokenRequests = service.state.tokenRequests;
	result.check(labelOf(after.parsed?.[PROVIDER]?.access) === 2, "the later caller did not write the minted credential back");
	result.check(unrelatedPreserved(after.parsed), "an unrelated credential entry did not come back JSON for JSON");
	result.check(service.state.tokenRequests.length === 2, `the endpoint saw ${service.state.tokenRequests.length} token request(s) rather than the refused one and the minted one`);
	result.check(service.state.tokenRequests.every((request) => request.refreshLabel === 1), "a token request did not carry the seeded refresh label");
	checkGuard(result, dirs, ["A4a", "A4b"], { "/token": 2 });
	checkSurroundings(result, dirs, before);
	return result;
}

/** A5: no user auth file to read, either because there is none or because the path is a link to nothing. */
async function caseMissing(ctx, { dangling }) {
	const name = dangling ? "A5-dangling" : "A5-missing";
	const dirs = setupCase(ctx.root, name);
	const result = caseResult(name, "A5", dangling ? "the user's auth path is a link to an absent target" : "the user has no auth file at all", [
		"what this measures is the selection: the storage resolves the user's file before the call directory exists, and an external replacement between that read and the call is a race this does not claim to close",
	]);
	const service = ctx.service;
	const target = path.join(dirs.profile, "absent-auth-target.json");
	if (dangling) fs.symlinkSync(target, dirs.authPath);
	const before = beforeSnapshots(dirs);
	const run = await runDriver(dirs, service, { caller: dangling ? "A5d" : "A5m", handle: dangling ? "a5d" : "a5m", packageRoot: ctx.repoPackageRoot, control: false });
	const observations = checkDriverRan(result, "caller", run);
	checkPrivateAuth(result, "caller", observations);
	result.check(observations.getAuth?.ok === true && observations.getAuth.resolved === false, `getAuth resolved ${JSON.stringify(observations.getAuth)} although this case has no credential for the provider`);
	result.check(service.state.tokenRequests.length === 0, `the endpoint saw ${service.state.tokenRequests.length} token request(s) although this case expects none`);
	if (dangling) {
		const link = fs.lstatSync(dirs.authPath);
		result.observations.link = { symlink: link.isSymbolicLink(), target: fs.readlinkSync(dirs.authPath), targetExists: fs.existsSync(target) };
		result.check(link.isSymbolicLink() && fs.readlinkSync(dirs.authPath) === target, "the dangling link was replaced or retargeted");
		result.check(fs.existsSync(target) === false, "the link's absent target was created");
	} else {
		result.observations.userAuthPresent = fs.existsSync(dirs.authPath);
		result.check(fs.existsSync(dirs.authPath) === false, "a user auth file was created where the user had none");
	}
	checkGuard(result, dirs, [dangling ? "A5d" : "A5m"], {});
	// The profile snapshot excludes the auth file itself, so the link is asserted above and the rest here.
	checkSurroundings(result, dirs, before);
	return result;
}

/** A6: a malformed shared file, which is where the production bootstrap's refusal to repeat SDK text comes from. */
async function caseMalformed(ctx) {
	const dirs = setupCase(ctx.root, "A6-malformed");
	const result = caseResult("A6-malformed", "A6", "a malformed shared auth file carrying a dummy credential label", [
		"this records what the store does with it; it introduces no auth-only classifier, because the public surface has none",
	]);
	const service = ctx.service;
	const malformed = `{\n  "${PROVIDER}": { "type": "oauth", "access": "DUMMY-access-1", "refresh": "DUMMY-refresh-1",\n`;
	write(dirs.authPath, malformed, { mode: 0o600 });
	const seedBytes = fs.readFileSync(dirs.authPath);
	const before = beforeSnapshots(dirs);
	const run = await runDriver(dirs, service, { caller: "A6", handle: "a6", packageRoot: ctx.repoPackageRoot, control: false });
	// The one case that opts out of the empty-aggregate gate, because its configuration is broken on purpose: what it
	// owes instead is the assertion below, so the negative evidence is kept rather than waved through.
	const observations = checkDriverRan(result, "caller", run, { expectAggregateError: true });
	result.observations.observed = { aggregate: observations.aggregate, hasConfiguredAuth: observations.hasConfiguredAuth, getAuth: observations.getAuth };
	result.check(observations.aggregate?.afterCreate?.empty === false, `the malformed credential file produced no aggregate error after create: ${JSON.stringify(observations.aggregate?.afterCreate)}`);
	result.check(observations.aggregate?.afterRegister?.empty === false, `the malformed credential file produced no aggregate error after the provider was registered: ${JSON.stringify(observations.aggregate?.afterRegister)}`);
	// It still goes on to ask, because what `getAuth` does with the same file is the other half of this evidence.
	result.check(observations.getAuth !== undefined, "the case did not reach getAuth at all, so its resolution behavior is unmeasured");
	const after = readAuth(dirs.authPath);
	result.check(Buffer.compare(after.bytes, seedBytes) === 0, "the malformed file was rewritten");
	result.check(service.state.tokenRequests.length === 0, `the endpoint saw ${service.state.tokenRequests.length} token request(s) although this case expects none`);
	result.check(observations.aggregate?.afterCreate?.containsDummyMarker !== true, "the aggregate runtime error carried a dummy credential label");
	checkGuard(result, dirs, ["A6"], {});
	checkSurroundings(result, dirs, before);
	return result;
}

/** A7: credential shapes the store hands back as they are — an incomplete oauth entry and an unknown type. */
async function caseShapes(ctx, { shape }) {
	const name = shape === "partial-oauth" ? "A7-partial-oauth" : "A7-unknown-type";
	const dirs = setupCase(ctx.root, name);
	const result = caseResult(name, "A7", shape === "partial-oauth" ? "the selected entry is {type:oauth} with no access, refresh or expires" : "the selected entry is an unknown credential type", [
		"what the runtime answers here is reported as measured; this case claims nothing about the entry being valid credentials",
	]);
	const service = ctx.service;
	const selected = shape === "partial-oauth" ? { type: "oauth", note: "DUMMY-partial-oauth-entry" } : { type: "mystery", value: "DUMMY-unknown-type-entry" };
	const seedBytes = seedAuthFile(dirs.authPath, selected);
	const before = beforeSnapshots(dirs);
	const run = await runDriver(dirs, service, { caller: shape === "partial-oauth" ? "A7p" : "A7u", handle: shape === "partial-oauth" ? "a7p" : "a7u", packageRoot: ctx.repoPackageRoot, control: false });
	const observations = checkDriverRan(result, "caller", run);
	result.observations.observed = { hasConfiguredAuth: observations.hasConfiguredAuth, getAuth: observations.getAuth, callback: observations.callback };
	const after = readAuth(dirs.authPath);
	result.check(Buffer.compare(after.bytes, seedBytes) === 0, "the source file was rewritten");
	result.check(service.state.tokenRequests.length === 0, `the endpoint saw ${service.state.tokenRequests.length} token request(s); this case was measured with none, so a non-zero count is a finding to report rather than an assertion to relax`);
	result.check((observations.callback ?? []).length === 0, `the provider's callbacks ran: ${JSON.stringify(observations.callback)}`);
	checkGuard(result, dirs, [shape === "partial-oauth" ? "A7p" : "A7u"], {});
	checkSurroundings(result, dirs, before);
	return result;
}

/**
 * A8: one credential family, one file, three legs across two installed builds. Nothing is reseeded or copied between
 * them: each leg has to rotate the family the previous leg left, which is what makes this a skew measurement rather
 * than three independent rotations. It runs only when `--package` names the other installed build.
 */
async function caseSkew(ctx) {
	const result = caseResult("A8-skew", "A8", "one credential family rotated by two installed builds in turn", [
		"the alternate build's public entry is imported and executed in its own leg's driver; its CLI is never invoked and nothing is installed",
		"what this compares is the public ModelRuntime credential path alone, not full bootstrap compatibility with that build",
		"this is a manual comparison; the production bootstrap still imports the SDK installed beside it",
	]);
	if (!ctx.altPackage) {
		result.skipped = "no --package <dir> was given, so the skew legs were NOT RUN and nothing here is qualified across versions";
		return result;
	}
	const dirs = setupCase(ctx.root, "A8-skew");
	const service = ctx.service;
	seedAuthFile(dirs.authPath, seedCredential(Date.now() + 10 * MINUTE));
	const before = beforeSnapshots(dirs);
	const legs = [
		{ caller: "A8a", handle: "a8a", packageRoot: ctx.repoPackageRoot, minOAuthValidityMs: 20 * MINUTE, lifetimeMs: 40 * MINUTE, expectSent: 1, expectMinted: 2 },
		{ caller: "A8b", handle: "a8b", packageRoot: ctx.altPackage.root, minOAuthValidityMs: 60 * MINUTE, lifetimeMs: 120 * MINUTE, expectSent: 2, expectMinted: 3 },
		{ caller: "A8c", handle: "a8c", packageRoot: ctx.repoPackageRoot, minOAuthValidityMs: 180 * MINUTE, lifetimeMs: 360 * MINUTE, expectSent: 3, expectMinted: 4 },
	];
	result.observations.legs = [];
	for (const leg of legs) {
		service.setMint({ lifetimeMs: leg.lifetimeMs });
		const run = await runDriver(dirs, service, { caller: leg.caller, handle: leg.handle, packageRoot: leg.packageRoot, minOAuthValidityMs: leg.minOAuthValidityMs, control: false });
		const observations = checkDriverRan(result, leg.caller, run);
		const after = readAuth(dirs.authPath);
		const selected = after.parsed?.[PROVIDER];
		const request = service.state.tokenRequests[service.state.tokenRequests.length - 1];
		result.observations.legs.push({
			caller: leg.caller,
			sdk: observations.sdk?.version ?? null,
			sentRefreshLabel: request?.refreshLabel ?? null,
			resolvedLabel: observations.getAuth?.apiKeyLabel ?? null,
			fileAccessLabel: labelOf(selected?.access),
			fileRefreshLabel: labelOf(selected?.refresh),
			extra: selected?.[EXTRA_FIELD] === EXTRA_VALUE,
			mode: after.mode,
			requests: service.state.tokenRequests.length,
		});
		result.check(observations.sdk?.version === (leg.packageRoot === ctx.altPackage.root ? ctx.altPackage.version : ctx.repoVersion), `${leg.caller} ran against ${observations.sdk?.version}, which is not the build this leg names`);
		result.check(request?.refreshLabel === leg.expectSent, `${leg.caller} sent refresh label ${request?.refreshLabel} rather than the previous leg's ${leg.expectSent}`);
		result.check(observations.getAuth?.ok === true && observations.getAuth.apiKeyLabel === leg.expectMinted, `${leg.caller} resolved ${JSON.stringify(observations.getAuth)} rather than label ${leg.expectMinted}`);
		result.check(labelOf(selected?.access) === leg.expectMinted && labelOf(selected?.refresh) === leg.expectMinted, `${leg.caller} left the file at ${labelOf(selected?.access)} rather than advancing it exactly once to ${leg.expectMinted}`);
		result.check(selected?.[EXTRA_FIELD] === EXTRA_VALUE, `${leg.caller} dropped the provider-specific extra field`);
		result.check(unrelatedPreserved(after.parsed), `${leg.caller} did not preserve the unrelated entries JSON for JSON`);
		result.check(after.mode === "600", `${leg.caller} left the file at mode ${after.mode}`);
	}
	result.observations.tokenRequests = service.state.tokenRequests;
	result.check(service.state.tokenRequests.length === 3, `three legs produced ${service.state.tokenRequests.length} token request(s) rather than one each`);
	checkGuard(result, dirs, legs.map((leg) => leg.caller), { "/token": 3 });
	checkSurroundings(result, dirs, before);
	return result;
}

/* ------------------------------------------------------------------ the fake-constructor control */

/*
 * A control over this harness's own reporting, and the one place in this spike where no real SDK is involved at all.
 * Everything below is FAKE and says so in its own name and version: an owned package inside the generated root whose
 * public entry throws from `ModelRuntime.create` an error that quotes a dummy credential label, carries a cause that
 * quotes another, and has a name and a code nothing here allowlists. The driver is pointed at it with the
 * repository's own module fence preloaded, so an accidental import of the real SDK by name would be refused rather
 * than resolved, and the fake entry probes that fence itself and writes what it found into the root.
 *
 * What it proves: that a foreign constructor failure reaches the driver's record as evidence — booleans, shapes, a
 * containment flag — and that none of its message, cause, stack, name or code reaches the driver's own streams or its
 * observations file. What it does not prove: anything about a real SDK build, a credential, a version or what an SDK
 * might write to its own stderr from inside a process; this control's own process is a fake one, and it is counted
 * apart from the real drivers and the auth cases for exactly that reason.
 */

const FAKE_SDK_VERSION = "0.0.0-fixture-fake";
/** The opaque wording the fake throws. A case asserts it appears nowhere in what the driver produced. */
const FAKE_OPAQUE_SENTENCE = "fake sdk constructor failure quoting credential material";
const FAKE_CAUSE_SENTENCE = "fake sdk constructor cause quoting credential material";
const FAKE_ERROR_NAME = "FakeLeakyConstructorError";
const FAKE_ERROR_CODE = "fake_leak_code";
/** The dummy labels the fake quotes, which are the same shape the real fixture mints. */
const FAKE_ACCESS_LABEL = "DUMMY-access-9";
const FAKE_REFRESH_LABEL = "DUMMY-refresh-9";

/** The fake package's public entry, written into the generated root. It imports nothing real and serves no request. */
const fakeEntrySource = () =>
	[
		"/*",
		" * FAKE fixture package, generated by test/spikes/pi-auth.mjs into that run's own disposable root. It is not an",
		" * SDK, it is not installed anywhere, and nothing but the leakage control ever imports it: its whole job is to",
		" * throw one constructor failure that quotes dummy credential labels, so the harness can prove the driver never",
		" * repeats such a text. Its version says it is a fixture.",
		" */",
		'import { writeFileSync } from "node:fs";',
		'import * as path from "node:path";',
		'import { fileURLToPath } from "node:url";',
		"",
		"const here = path.dirname(fileURLToPath(import.meta.url));",
		"",
		"/* The fence's own positive control: with it preloaded this import is refused while it is still a specifier. */",
		"let fenceProbe;",
		"try {",
		'\tawait import("@earendil-works/pi-coding-agent");',
		'\tfenceProbe = { refused: false, note: "the real sdk resolved in this process, so the fence was not armed" };',
		"} catch (error) {",
		'\tconst message = typeof error?.message === "string" ? error.message : "";',
		'\tfenceProbe = { refused: true, code: typeof error?.code === "string" ? error.code : null, fenceMarker: message.startsWith("pi-fusion test fence:") };',
		"}",
		'writeFileSync(path.join(here, "fence-probe.json"), JSON.stringify(fenceProbe, null, 2));',
		"",
		`export const VERSION = ${JSON.stringify(FAKE_SDK_VERSION)};`,
		"export const CURRENT_SESSION_VERSION = 0;",
		"",
		"export class ModelRuntime {",
		"\tstatic async create() {",
		`\t\tconst cause = new Error(${JSON.stringify(`${FAKE_CAUSE_SENTENCE} ${FAKE_REFRESH_LABEL}`)});`,
		`\t\tconst error = new Error(${JSON.stringify(`${FAKE_OPAQUE_SENTENCE} ${FAKE_ACCESS_LABEL}`)}, { cause });`,
		`\t\terror.name = ${JSON.stringify(FAKE_ERROR_NAME)};`,
		`\t\terror.code = ${JSON.stringify(FAKE_ERROR_CODE)};`,
		"\t\tthrow error;",
		"\t}",
		"}",
		"",
	].join("\n");

/** The owned fake package: a manifest this driver's identity check accepts, and the entry above beside it. */
function seedFakeSdk(dirs) {
	const root = path.join(dirs.caseRoot, "fake-sdk");
	writeJson(path.join(root, "package.json"), {
		name: "@earendil-works/pi-coding-agent",
		version: FAKE_SDK_VERSION,
		type: "module",
		description: "FAKE fixture package generated by the pi-fusion auth spike; not an SDK and never installed",
		exports: { ".": { import: "./fake-entry.mjs" } },
	});
	write(path.join(root, "fake-entry.mjs"), fakeEntrySource());
	return { root, fenceProbe: path.join(root, "fence-probe.json") };
}

/** C1: a foreign constructor failure that quotes credentials, and what the driver does and does not say about it. */
async function controlFakeConstructorLeak(ctx) {
	const dirs = setupCase(ctx.root, "C1-fake-constructor-leak");
	const result = caseResult("C1-fake-constructor-leak", "C1", "FAKE package control: a constructor error quoting dummy credentials is recorded as evidence only", [
		"no real SDK runs in this control, and its process is counted apart from the real drivers and the auth cases",
		"it says nothing about any SDK version, credential or bootstrap behavior",
	]);
	result.kind = "control";
	const fake = seedFakeSdk(dirs);
	seedAuthFile(dirs.authPath, seedCredential(Date.now() + MINUTE));
	const run = await runDriver(dirs, ctx.service, { caller: "C1", handle: "c1", packageRoot: fake.root, control: false, fence: true });
	const fenceProbe = readJsonIfPresent(fake.fenceProbe);
	result.observations.fence = fenceProbe ?? { missing: true };
	result.observations.driver = {
		exit: run.exit,
		sdkVersion: run.observations.sdk?.version ?? null,
		runtimeCreated: run.observations.runtimeCreated ?? false,
		stages: (run.observations.stages ?? []).map((entry) => entry.stage),
		errorOwn: run.observations.errorOwn ?? null,
		errorText: run.observations.errorText ?? null,
		evidence: run.observations.error ?? null,
		disposed: run.observations.disposed ?? null,
	};
	// The fence was actually armed in the process this control is about; otherwise a fake that reached a real package
	// would make the rest of it meaningless.
	result.check(fenceProbe?.refused === true && fenceProbe?.fenceMarker === true && fenceProbe?.code === "ERR_PI_FUSION_TEST_FENCE", `the module fence was not armed in the control process: ${JSON.stringify(fenceProbe)}`);
	result.check(run.observations.sdk?.version === FAKE_SDK_VERSION, `the control did not run against its own fake package: ${JSON.stringify(run.observations.sdk?.version)}`);
	result.check(run.observations.runtimeCreated !== true, "the fake package constructed a runtime, so nothing was refused and this control measured nothing");
	result.check(run.exit.code === 1, `the control driver exited ${JSON.stringify(run.exit)} rather than 1`);
	// The evidence is there, and it is evidence rather than text: the containment flag says the message carried a
	// dummy label, while the name and the code are unknown labels and are reported by their shape alone.
	const evidence = run.observations.error ?? {};
	result.check(evidence.containsDummyMarker === true, `the driver did not record that the foreign message carried a dummy label: ${JSON.stringify(evidence)}`);
	result.check(evidence.hasCause === true && evidence.hasStack === true, `the driver did not record the cause and stack as present: ${JSON.stringify(evidence)}`);
	result.check(evidence.name === null && evidence.nameKind === "other", `an unknown error name was echoed rather than reported by its shape: ${JSON.stringify(evidence)}`);
	result.check(evidence.code === null && evidence.codeKind === "other", `an unknown error code was echoed rather than reported by its shape: ${JSON.stringify(evidence)}`);
	result.check(run.observations.errorOwn === false && run.observations.errorText === undefined, "a foreign failure was given this fixture's own descriptive-text path");
	// And nothing of it reached what the driver produced. The raw bytes of both streams and of the observations file.
	const forbidden = [DUMMY_MARKER, FAKE_OPAQUE_SENTENCE, FAKE_CAUSE_SENTENCE, FAKE_ERROR_NAME, FAKE_ERROR_CODE, "at ModelRuntime.create"];
	const leaks = [];
	for (const [where, text] of [
		["stdout", run.stdout],
		["stderr", run.stderr],
		["observations", run.observationsText],
	]) {
		for (const needle of forbidden) if (text.includes(needle)) leaks.push(`${where} carries ${JSON.stringify(needle)}`);
	}
	result.observations.output = { stdoutBytes: run.stdout.length, stderrBytes: run.stderr.length, observationBytes: run.observationsText.length, stderrTail: run.stderr.trim().split("\n").slice(-2).join(" | "), leaks };
	result.check(leaks.length === 0, `the driver repeated foreign text: ${leaks.join("; ")}`);
	// A failed construction still disposes of the call directory it made.
	result.check(run.observations.disposed === true, `the control driver did not dispose of its own call directory: ${JSON.stringify(run.observations.disposed)}`);
	result.check(fs.readdirSync(path.join(dirs.profile, FUSION_MANAGED_DIR, "calls")).length === 0, "the control left a call directory behind");
	result.check(ctx.service.state.tokenRequests.length === 0, `the control made ${ctx.service.state.tokenRequests.length} token request(s), although its runtime never existed`);
	checkGuard(result, dirs, ["C1"], {});
	return result;
}

/* ------------------------------------------------------------------ the runner */

const CASES = [
	{ name: "A1-rotate", group: "A1", kind: "case", run: caseRotate },
	{ name: "A2-fresh", group: "A2", kind: "case", run: caseFresh },
	{ name: "A3-overlap", group: "A3", kind: "case", run: caseOverlap },
	{ name: "A4-fail-then-reuse", group: "A4", kind: "case", run: caseFailThenReuse },
	{ name: "A5-missing", group: "A5", kind: "case", run: (ctx) => caseMissing(ctx, { dangling: false }) },
	{ name: "A5-dangling", group: "A5", kind: "case", run: (ctx) => caseMissing(ctx, { dangling: true }) },
	{ name: "A6-malformed", group: "A6", kind: "case", run: caseMalformed },
	{ name: "A7-partial-oauth", group: "A7", kind: "case", run: (ctx) => caseShapes(ctx, { shape: "partial-oauth" }) },
	{ name: "A7-unknown-type", group: "A7", kind: "case", run: (ctx) => caseShapes(ctx, { shape: "unknown-type" }) },
	{ name: "A8-skew", group: "A8", kind: "case", run: caseSkew },
	// A control rather than a case, and counted as one: it runs no real SDK and is evidence about this harness alone.
	{ name: "C1-fake-constructor-leak", group: "C1", kind: "control", run: controlFakeConstructorLeak },
];

/** A selector names cases or groups. A name that matches neither is a mistake, and a mistake must not run anything. */
function selectCases(value) {
	if (value === undefined) return CASES;
	const wanted = value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!wanted.length) return { error: "--case was given with no case or group name" };
	const unknown = wanted.filter((entry) => entry !== "all" && !CASES.some((entry_) => entry_.name === entry || entry_.group === entry));
	if (unknown.length) return { error: `no case or group is named ${unknown.map((entry) => JSON.stringify(entry)).join(", ")}; the cases are ${CASES.map((entry) => entry.name).join(", ")}` };
	if (wanted.includes("all")) return CASES;
	return CASES.filter((entry) => wanted.includes(entry.name) || wanted.includes(entry.group));
}

/** The alternate installed build, read as metadata and a public entry: nothing of it is run and nothing is installed. */
function readAltPackage(dir) {
	const root = path.resolve(dir);
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	} catch (error) {
		throw new Error(`--package ${root} has no readable package.json, so this harness cannot tell which build it would measure (${error?.code ?? String(error)})`);
	}
	if (manifest.name !== "@earendil-works/pi-coding-agent") throw new Error(`--package ${root} is ${JSON.stringify(manifest.name)}, not @earendil-works/pi-coding-agent`);
	if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new Error(`--package ${root} names no version string`);
	const specifier = manifest.exports?.["."]?.import;
	if (typeof specifier !== "string" || !specifier.startsWith("./")) throw new Error(`--package ${root} publishes no local exports["."].import entry`);
	const entry = path.resolve(root, specifier);
	if (!entry.startsWith(`${root}${path.sep}`) || !fs.statSync(entry).isFile()) throw new Error(`--package ${root} does not contain the public entry it names`);
	if (root === repoPackageRoot) throw new Error(`--package ${root} is the repository's own dependency, so it would compare a build against itself`);
	return { root, version: manifest.version, entry };
}

function printCase(result) {
	console.log(`\n=== ${result.name}: ${result.title}`);
	if (result.skipped) {
		console.log(`  SKIPPED: ${result.skipped}`);
		return;
	}
	for (const [key, value] of Object.entries(result.observations)) console.log(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
	for (const note of result.notes) console.log(`  note: ${note}`);
	console.log(result.failures.length === 0 ? "  RESULT: guarantees held" : `  RESULT: ${result.failures.length} failure(s)`);
	for (const failure of result.failures) console.log(`    FAIL ${failure}`);
}

async function main() {
	// Argument mistakes first, before a package file is read or a fixture root exists.
	if (flagErrors.length) {
		for (const error of flagErrors) console.log(error);
		process.exitCode = 2;
		return;
	}
	const selected = selectCases(selector);
	if (selected.error) {
		console.log(selected.error);
		process.exitCode = 2;
		return;
	}
	let altPackageInfo;
	if (altPackage !== undefined) {
		try {
			altPackageInfo = readAltPackage(altPackage);
		} catch (error) {
			console.log(String(error.message ?? error));
			process.exitCode = 2;
			return;
		}
	}
	const repoVersion = JSON.parse(fs.readFileSync(path.join(repoPackageRoot, "package.json"), "utf8")).version;
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-auth-spike-"));
	const results = [];
	let service;
	try {
		console.log(`pi-fusion auth spike: what the installed credential store does with a call's auth file`);
		console.log(`node ${process.version}, ${new Date().toISOString()}`);
		console.log(`sdk under test: ${repoVersion} at ${repoPackageRoot}`);
		console.log(altPackageInfo ? `alternate sdk: ${altPackageInfo.version} at ${altPackageInfo.root}` : "alternate sdk: none given, so the skew case is NOT RUN");
		console.log(`fixture root: ${root}${keepRoot ? " (kept)" : " (removed on exit)"}`);
		for (const entry of selected) {
			// One service per case, so a request count is that case's own and a gate cannot be released by another.
			service = await startControlService();
			const ctx = { root, service, repoPackageRoot, repoVersion, altPackage: altPackageInfo };
			let result;
			try {
				result = await entry.run(ctx);
			} catch (error) {
				result = caseResult(entry.name, entry.group, "the case itself failed");
				result.kind = entry.kind;
				result.check(false, `the harness threw: ${String(error?.message ?? error)}`);
			}
			result.observations.unexpectedFixturePaths = service.state.unexpected;
			result.check(service.state.unexpected.length === 0, `the fixture service saw a request it serves no endpoint for: ${JSON.stringify(service.state.unexpected.slice(0, 3))}`);
			results.push(result);
			await service.close();
			service = undefined;
		}
		for (const result of results) printCase(result);
		// Cases and controls are counted apart: a control runs a fake package, so folding it into the case totals would
		// report a process that never touched an SDK as if it were one that did.
		const ran = results.filter((result) => !result.skipped && result.kind !== "control");
		const controlResults = results.filter((result) => !result.skipped && result.kind === "control");
		const failed = [...ran, ...controlResults].filter((result) => result.failures.length > 0);
		const skipped = results.filter((result) => result.skipped);
		const drivers = ran.reduce((total, result) => total + Object.keys(result.observations).filter((key) => result.observations[key]?.exit !== undefined).length, 0);
		const rotations = ran.reduce((total, result) => total + (result.observations.tokenRequests ?? []).filter((request) => String(request.outcome ?? "").startsWith("minted")).length, 0);
		const controlCalls = ran.reduce((total, result) => total + (result.observations.guard?.byPath?.["/gate"] ?? 0) + (result.observations.guard?.byPath?.["/mark"] ?? 0), 0);
		console.log(`\nsdk builds exercised by the cases: ${[repoVersion, altPackageInfo?.version].filter(Boolean).join(", ")}`);
		console.log(`real sdk driver processes: ${drivers}; token mints: ${rotations}; loopback control calls (gates and marks): ${controlCalls}`);
		console.log(`fake-package control processes: ${controlResults.length} (no sdk, no credential and no version evidence in them)`);
		const casesFailed = ran.filter((result) => result.failures.length > 0);
		const controlsFailed = controlResults.filter((result) => result.failures.length > 0);
		console.log(`${ran.length - casesFailed.length}/${ran.length} cases kept their guarantees; ${controlResults.length - controlsFailed.length}/${controlResults.length} controls held; ${skipped.length} skipped (${skipped.map((result) => result.name).join(", ") || "none"})`);
		if (keepRoot) writeJson(path.join(root, "report.json"), { node: process.version, sdk: repoVersion, alternate: altPackageInfo ?? null, results });
		process.exitCode = failed.length === 0 ? 0 : 1;
	} finally {
		if (service) await service.close();
		if (!keepRoot) fs.rmSync(root, { recursive: true, force: true });
	}
}

await main();
