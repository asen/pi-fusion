#!/usr/bin/env node
/*
 * A fixture controller for the manual spike, and a stand-in for one caller Fusion does not have yet: the Pi transport
 * of step 4 task 6 is what will prepare a call's storage, compose its input and launch its child in production. This
 * script does exactly those three things through the production helpers — `piRole`, `prepareCallStorage`,
 * `bootstrapInput`, `writeCallInput` and `piLaunch` — and nothing else: it speaks no protocol, reads no response and
 * decides nothing about a run. The role it hands over is the production binding's own, resolved from what the spec
 * names with an empty environment, so no variable of this machine's reaches it. The child's stdio is inherited, so the
 * harness that spawned this process drives the real child directly, and what this records is what the production
 * helpers resolved and what the call directory held before it was disposed of.
 *
 *   node pi-storage-caller.mjs call <spec.json>       one call: storage, input, launch, wait, dispose
 *   node pi-storage-caller.mjs barrier <url>          block until the harness releases a loopback barrier
 *   node pi-storage-caller.mjs builtins <spec.json>   which exact builtin model the installed SDK offers
 *   node pi-storage-caller.mjs fetch-probe <spec.json>  the fetch guard's positive control
 *
 * One check this has that production does not: composition permits a model catalog refresh, and Pi makes one exactly
 * when `PI_OFFLINE` is absent, so a call that is online and names no loopback catalog base url is refused here before
 * a child starts rather than allowed to reach the real endpoint. It is fixture safety; no production caller has it.
 *
 * Two things a spec may add to a call, both of them fixture input and both recorded: `resources`, the extensions and
 * skills the production composer takes as a call's own additions, and `mutate.rawInput`, a labelled patch written into
 * the composed input afterwards. The patch may name `extensions`, `skills` and `tools` and nothing else, because the
 * cases it exists for are a specifier the composer refuses on purpose — which a child has to refuse for itself — and a
 * fixture extension's own tool a role's list cannot name. It is recorded as `rawInput:<field>` beside the other
 * overrides; no production caller has anything like it.
 *
 * It is manual-harness-only: the default test glob is `test/*.test.ts`, so nothing here is imported by `npm test`.
 * Every path it writes to comes from the spec the harness wrote, inside the harness's own disposable root.
 */
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const [mode, argument] = process.argv.slice(2);
const note = (text) => process.stderr.write(`[caller] ${text}\n`);

const readSpec = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The only fields the labelled post-composition patch below may write. Everything else is the composer's own. */
const RAW_INPUT_FIELDS = ["extensions", "skills", "tools"];

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);

/** What a catalog store holds, read as bytes and as JSON, so a populated one can be compared against a later read. */
function describeStore(file) {
	let bytes;
	try {
		bytes = fs.readFileSync(file);
	} catch (error) {
		return { present: false, code: error?.code ?? String(error) };
	}
	const store = { present: true, bytes: bytes.length, sha: sha(bytes) };
	try {
		const parsed = JSON.parse(bytes.toString("utf8"));
		store.providers = Object.keys(parsed).sort();
		store.models = Object.fromEntries(store.providers.map((id) => [id, Array.isArray(parsed[id]?.models) ? parsed[id].models.length : null]));
	} catch (error) {
		// Not called corruption: Pi writes this file under a lock, and an unlocked read can see a legitimate write
		// half finished. The harness validates the JSON once the writers have exited.
		store.parse = `failed: ${error?.message ?? String(error)}`;
	}
	return store;
}

/** A file as bytes, with the mode it was created with: what the call input is measured by, and never its content. */
function describeFile(file) {
	try {
		const stats = fs.statSync(file);
		return { present: true, bytes: stats.size, mode: (stats.mode & 0o777).toString(8), sha: sha(fs.readFileSync(file)) };
	} catch (error) {
		return { present: false, code: error?.code ?? String(error) };
	}
}

/** Everything in a directory, relative and sorted: the call directory is listed before it is disposed of. */
function listTree(dir) {
	const found = [];
	const walk = (current, prefix) => {
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				found.push(`${rel}/`);
				walk(path.join(current, entry.name), rel);
			} else {
				found.push(rel);
			}
		}
	};
	walk(dir, "");
	return found;
}

async function runCall(spec) {
	const observations = { mode: "call", pid: process.pid, startedAt: Date.now(), caller: spec.caller };
	const write = () => fs.writeFileSync(spec.observations, `${JSON.stringify(observations, null, 2)}\n`);
	const storageModule = await import(path.join(spec.repoRoot, "extensions", "backends", "pi-storage.ts"));
	const launchModule = await import(path.join(spec.repoRoot, "extensions", "backends", "pi-launch.ts"));
	const bindingModule = await import(path.join(spec.repoRoot, "extensions", "backends", "pi-binding.ts"));
	const { prepareCallStorage, writeCallInput, piPaths } = storageModule;
	const { bootstrapInput, piLaunch, openSession, hostBinPlacement } = launchModule;
	const { piRole } = bindingModule;
	let storage;
	try {
		// The environment this process runs in is the evidence for what a child inherits, so it is recorded as it is.
		observations.env = {
			PI_FUSION_HISTORY: process.env.PI_FUSION_HISTORY ?? null,
			PI_OFFLINE: process.env.PI_OFFLINE ?? null,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
			PI_SPIKE_CALLER: process.env.PI_SPIKE_CALLER ?? null,
			hasNodeOptions: typeof process.env.NODE_OPTIONS === "string",
		};
		const paths = piPaths(spec.hostAgentDir, spec.cwd);
		observations.paths = { ...paths };
		observations.catalogExistedBeforePrepare = fs.existsSync(paths.catalogDir);
		observations.storeBeforePrepare = describeStore(paths.modelsStorePath);
		const hooks = spec.stagedBarrier
			? {
					onStaged: (temporaryDir) => {
						observations.staged = { dir: temporaryDir, at: Date.now(), entries: listTree(temporaryDir) };
						note(`staged ${temporaryDir}, holding at the barrier`);
						// The hook is synchronous, so the wait is a child process that returns when the harness
						// releases the barrier: a handshake rather than a sleep.
						const waited = spawnSync(process.execPath, [self, "barrier", spec.stagedBarrier], { timeout: spec.barrierTimeoutMs ?? 120_000, stdio: ["ignore", "ignore", "inherit"] });
						observations.staged.barrier = { status: waited.status ?? null, signal: waited.signal ?? null, error: waited.error ? String(waited.error.message ?? waited.error) : undefined };
						observations.staged.releasedAt = Date.now();
						note("barrier released, publishing");
					},
				}
			: undefined;
		storage = prepareCallStorage({ hostAgentDir: spec.hostAgentDir, cwd: spec.cwd, handle: spec.handle }, hooks);
		observations.storage = {
			handle: storage.handle,
			cwd: storage.cwd,
			callDir: storage.callDir,
			inputPath: storage.inputPath,
			modelsPath: storage.modelsPath,
			privateModelsPath: storage.privateModelsPath,
			authPath: storage.authPath,
			sharedAuth: storage.sharedAuth,
			agentDir: storage.agentDir,
			sessionDir: storage.sessionDir,
			catalogDir: storage.catalogDir,
			modelsStorePath: storage.modelsStorePath,
			cacheDir: storage.cacheDir,
			hostBinDir: storage.hostBinDir,
		};
		// Read the published store the moment preparation returns: for a publisher that lost the rename this is the
		// winner's file, and it is read before this caller's own child has started.
		observations.storeAfterPrepare = describeStore(storage.modelsStorePath);
		const session = spec.session.kind === "open" ? openSession({ sessionId: spec.session.sessionId, sessionFile: spec.session.sessionFile, ...(spec.session.checkpoint === undefined ? {} : { checkpoint: spec.session.checkpoint }) }) : { kind: "new" };
		// The role is the production binding's, resolved with an empty environment so nothing this machine has set can
		// reach it: the spec names the role, the model and the level, and the tools, the resources and the contract are
		// the binding's own answer. A spec that also names a contract is checked against it rather than believed.
		const role = piRole(
			{ role: spec.role.name, model: spec.role.model, ...(spec.role.effort === undefined ? {} : { effort: spec.role.effort }), ...(spec.role.mode === undefined ? {} : { mode: spec.role.mode }) },
			undefined,
			{},
		);
		observations.role = { ...role };
		if (spec.role.contract !== undefined && spec.role.contract !== role.contract) throw new Error(`the spec names contract ${spec.role.contract} and the binding resolves ${role.contract}`);
		const composed = bootstrapInput({
			role,
			storage,
			session,
			contract: fs.readFileSync(spec.contractFile, "utf8"),
			// A call's own resource additions, which is the internal parameter the production composer already takes:
			// the spec names local paths, the composer checks and resolves them, and nothing here writes a list of its own.
			...(spec.resources?.extensions === undefined ? {} : { extensions: spec.resources.extensions }),
			...(spec.resources?.skills === undefined ? {} : { skills: spec.resources.skills }),
			...(spec.controlled?.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: spec.controlled.catalogBaseUrl }),
		});
		// Normal composition now permits a catalog refresh, so a catalog case names a loopback base url and overrides
		// nothing at all. What is left in this list is the base url itself and the raw-input patch below.
		const controlled = [];
		const input = { ...composed };
		if (input.catalogBaseUrl !== undefined) controlled.push(`catalogBaseUrl=${input.catalogBaseUrl}`);
		// The second labelled override, and the only other one: a value the production composer refuses on purpose — a
		// `npm:` or `https:` specifier a child has to refuse for itself — and a tool list a fixture extension's own tool
		// is on, written into the composed input after composition. Three fields and no others, so this can never turn
		// into a general way of rewriting a call: a spec naming anything else fails the call here rather than launching
		// a child on an input nobody composed. It is fixture-only; no production caller has a patch like this.
		for (const [field, value] of Object.entries(spec.mutate?.rawInput ?? {})) {
			if (!RAW_INPUT_FIELDS.includes(field)) throw new Error(`mutate.rawInput may name ${RAW_INPUT_FIELDS.join(", ")} and nothing else; it names ${field}`);
			input[field] = value;
			controlled.push(`rawInput:${field}`);
		}
		observations.controlledOverrides = controlled;
		observations.input = input;
		// What composition decided about the catalog network, on its own rather than only inside the whole input.
		observations.inputAllowModelNetwork = input.allowModelNetwork;
		// A safety check this fixture has and production does not: composition permits a catalog refresh, and Pi turns
		// that permission into a real request exactly when `PI_OFFLINE` is absent. Every online case in these spikes
		// points the refresh at a loopback catalog the harness owns, so a case that is online and names no base url is
		// a case that would reach the real endpoint, and this refuses to launch a child for it. Production has no
		// equivalent knob or check: the user's own online call is supposed to reach the user's own catalog.
		if (process.env.PI_OFFLINE === undefined && input.catalogBaseUrl === undefined) {
			throw new Error("refusing to launch: PI_OFFLINE is absent and the composed input names no catalog base url, so a catalog refresh would leave this harness's own loopback origins");
		}
		writeCallInput(storage, input);
		observations.inputFile = describeFile(storage.inputPath);
		const callerEnv = { ...process.env, PI_SPIKE_CALLER: `${spec.caller}/child` };
		// A mutation switch for the harness's own guard control, and the only thing here that weakens a run on purpose:
		// it takes the fetch guard's preload away from the child, so a case claiming the child made no request must fail.
		if (spec.mutate?.dropChildPreload === true) delete callerEnv.NODE_OPTIONS;
		observations.childPreloadDropped = spec.mutate?.dropChildPreload === true;
		// Read before the launch composes anything, so a case comparing the caller's search path before and after has
		// two independent readings rather than the same one twice. `piLaunch` is supposed to copy this environment and
		// leave it alone, and that is what the pair is here to show.
		const callerPathBefore = callerEnv.PATH ?? null;
		// The production classifier's own answer for this call, so a case reads what the launch decided rather than
		// deciding it again for itself.
		const placement = hostBinPlacement(callerEnv, storage.hostBinDir);
		const launch = piLaunch({ input, storage, env: callerEnv });
		const callerPathAfter = callerEnv.PATH ?? null;
		observations.launch = {
			command: launch.command,
			args: launch.args,
			cwd: launch.cwd,
			childAgentDir: launch.env.PI_CODING_AGENT_DIR,
			childHistory: launch.env.PI_FUSION_HISTORY ?? null,
			childOffline: launch.env.PI_OFFLINE ?? null,
			childMarker: launch.env.PI_FUSION_CHILD ?? null,
			childJitiCache: launch.env.JITI_FS_CACHE ?? null,
			childNodeCompileCache: launch.env.NODE_COMPILE_CACHE ?? null,
			// The whole values rather than a claim about them: what the child would search for a helper, what this
			// caller's own search path was before the launch and after it, and what the production classifier decided.
			// A case asserts on these; what a child's own helper lookup then does with them is not measured here.
			childPath: launch.env.PATH ?? null,
			callerPathBefore,
			callerPathAfter,
			// The same reading as `callerPathAfter`, kept under its old name so an earlier kept artifact still reads.
			callerPath: callerPathAfter,
			hostBinDir: storage.hostBinDir,
			hostBinPlacement: placement,
			callerJitiCache: callerEnv.JITI_FS_CACHE ?? null,
			callerNodeCompileCache: callerEnv.NODE_COMPILE_CACHE ?? null,
		};
		observations.storeBeforeSpawn = describeStore(storage.modelsStorePath);
		note(`launching ${launch.command} ${launch.args.join(" ")}`);
		const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["inherit", "inherit", "inherit"] });
		observations.childPid = child.pid;
		observations.childExit = await new Promise((resolve) => {
			child.on("error", (error) => resolve({ code: null, signal: null, error: String(error.message ?? error) }));
			child.on("exit", (code, signal) => resolve({ code, signal }));
		});
		note(`child exited ${JSON.stringify(observations.childExit)}`);
		observations.storeAfterChild = describeStore(storage.modelsStorePath);
		observations.callDirEntries = listTree(storage.callDir);
		observations.stagingDirsLeft = fs.readdirSync(storage.agentDir).filter((name) => name.startsWith(".catalog-"));
	} catch (error) {
		observations.error = String(error?.message ?? error);
		observations.errorStage = "caller";
		note(`failed: ${observations.error}`);
	} finally {
		if (storage) {
			storage.dispose();
			observations.disposed = !fs.existsSync(storage.callDir);
			// Disposal removes this call's directory and nothing above it: both are recorded rather than assumed.
			observations.callsDirAfterDispose = listTree(storage.callsDir);
		}
		observations.endedAt = Date.now();
		write();
	}
	process.exitCode = observations.error ? 1 : 0;
}

/** Blocks until the harness answers, which is how a staged publisher is held open for a deterministic interleaving. */
async function runBarrier(url) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(110_000) });
		await response.text();
		process.exitCode = response.ok ? 0 : 3;
	} catch (error) {
		process.stderr.write(`[barrier] ${String(error?.message ?? error)}\n`);
		process.exitCode = 4;
	}
}

/**
 * Which exact builtin provider and model the installed SDK offers, so a case selects one from the catalog rather than
 * inventing an id. The runtime this builds is given disposable storage of its own and no network: it never reads the
 * user's auth or models file, and `allowModelNetwork` stays false.
 */
async function runBuiltins(spec) {
	const report = { mode: "builtins" };
	try {
		const pkg = await import("@earendil-works/pi-coding-agent");
		report.sdk = typeof pkg.VERSION === "string" ? pkg.VERSION : "unknown";
		report.sessionVersion = pkg.CURRENT_SESSION_VERSION;
		const runtime = await pkg.ModelRuntime.create({
			authPath: spec.authPath,
			modelsPath: spec.modelsPath,
			modelsStorePath: spec.modelsStorePath,
			allowModelNetwork: false,
		});
		report.error = runtime.getError() ?? null;
		report.providers = runtime.getProviders().map((provider) => provider.id).sort();
		report.candidates = {};
		for (const providerId of spec.preferred) {
			const models = runtime.getModels(providerId).map((model) => model.id);
			if (models.length) report.candidates[providerId] = models;
		}
		const providerId = spec.preferred.find((id) => report.candidates[id]?.length);
		if (providerId) report.chosen = { provider: providerId, model: report.candidates[providerId][0] };
		report.authFileCreated = fs.existsSync(spec.authPath);
	} catch (error) {
		report.failure = String(error?.message ?? error);
	}
	fs.writeFileSync(spec.observations, `${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = report.chosen ? 0 : 1;
}

/**
 * The fetch guard's positive control: one origin this fixture owns, one it does not, both attempted for real.
 *
 * An attempt may name its own `redirect` mode, and what a 3xx answered with is reported as the `location` header's own
 * value. Both are for one control that has no child in it — the helper-fetch interposer's, whose mapped endpoint
 * answers the redirect Pi's own tool manager asks for with `redirect: "manual"`. Nothing here follows anything: the
 * guard is what decides that, and this reports what came back.
 */
async function runFetchProbe(spec) {
	const report = { mode: "fetch-probe", attempts: [] };
	for (const attempt of spec.attempts) {
		try {
			const response = await fetch(attempt.url, { signal: AbortSignal.timeout(10_000), ...(attempt.redirect === undefined ? {} : { redirect: attempt.redirect }) });
			report.attempts.push({
				label: attempt.label,
				ok: response.ok,
				status: response.status,
				redirect: attempt.redirect ?? null,
				// One header, by name, because a redirect control is about where a 3xx pointed. No other header is read.
				location: response.headers.get("location"),
			});
		} catch (error) {
			report.attempts.push({ label: attempt.label, ok: false, redirect: attempt.redirect ?? null, error: String(error?.message ?? error) });
		}
	}
	fs.writeFileSync(spec.observations, `${JSON.stringify(report, null, 2)}\n`);
}

if (mode === "call") await runCall(readSpec(argument));
else if (mode === "barrier") await runBarrier(argument);
else if (mode === "builtins") await runBuiltins(readSpec(argument));
else if (mode === "fetch-probe") await runFetchProbe(readSpec(argument));
else {
	process.stderr.write(`[caller] unknown mode ${JSON.stringify(mode)}\n`);
	process.exitCode = 2;
}
