#!/usr/bin/env node
/*
 * The SDK process of the manual auth-store spike, run by hand through `test/spikes/pi-auth.mjs` and by nothing else:
 * the default test glob is `test/*.test.ts`, so `npm test` never reaches this directory.
 *
 *   node pi-auth-driver.mjs resolve <spec.json>
 *
 * What it is: one caller that asks the installed SDK's public `ModelRuntime` to resolve auth for one fixture provider,
 * against the exact auth, models and catalog paths the production helpers select. It calls `prepareCallStorage` and
 * `bootstrapInput` for those paths rather than composing paths of its own, and hands `ModelRuntime.create` the same
 * option set `extensions/backends/pi-bootstrap.mjs` hands it, so what this measures is the store half of a production
 * call. It is not the production bootstrap: there is no session, no model request, no RPC and no transport here, and
 * the transport that will run this for real is step 4 task 6's.
 *
 * What it is not, and must not be read as: a provider client, an auth implementation or a credential store. The
 * provider it registers is a fixture whose every credential is a literal `DUMMY-` label, whose token endpoint is a
 * loopback service the harness owns, and whose `login` throws. No real profile, token, registry or live endpoint is
 * reached, and the harness preloads `pi-fetch-guard.mjs` into this process so a request to anywhere else fails.
 *
 * What it reports, and the reason for the shape: stages, the paths the production helpers selected, the numeric label
 * of every minted dummy credential and plain booleans. A resolved credential blob never goes in, and neither does a
 * foreign message, its cause or its stack. Two kinds of failure are kept apart on purpose. This fixture's own
 * failures are `SpikeError`s, whose text this file composed itself, and those are the only ones whose wording is
 * ever written out. Everything else — anything thrown by the SDK, by node or by a production helper — is recorded as
 * evidence alone: presence, type, an error name and code only when they are one of the fixed labels observed here,
 * shape booleans when they are not, whether the text starts with one of the prefixes this SDK version is known to
 * use, and whether it contains the dummy marker at all. That last one is the evidence for why the production
 * bootstrap refuses to repeat an SDK error text, and `test/spikes/pi-auth.mjs`'s fake-constructor control is what
 * proves this file does not repeat one either.
 *
 * Who reads the shared credential file, precisely. Inside this process the SDK's own credential store reads it and
 * rotates it through the public API — that is the behavior under measurement and the whole point of the spike. What
 * never happens is this file's own observation code reading its bytes: no probe here opens a user's `auth.json`,
 * before the runtime is created, after it or after a resolution, so nothing this driver records is taken from that
 * file's content. The only credential file the observation code reads is the private one inside this call's own
 * directory, which exists because the user had none; the adjacent lock is looked at by its metadata alone; and what
 * a shared file holds is the controller's to snapshot, while no driver is running.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
/** Every credential value this fixture ever mints or seeds carries this, so a leak into a message is visible. */
const DUMMY_MARKER = "DUMMY-";
/** A minted dummy credential is `DUMMY-access-<n>`: the number is the label a case asserts, and `n` is all we report. */
const LABEL = /^DUMMY-(?:access|refresh)-(\d+)$/;
/**
 * The message prefixes this SDK version produces around auth, recorded as booleans rather than by copying the text.
 * A prefix that stops matching is a measurement this spike reports, not a rule it enforces on the SDK.
 */
const KNOWN_PREFIXES = [
	"OAuth refresh failed for",
	"OAuth refresh returned a token that expires too soon for",
	"OAuth auth derivation failed for",
	"Credential store modify failed for",
	"Credential store read failed for",
	"API key auth failed for provider",
];

/**
 * The error names and codes this spike has actually observed, and the only ones it ever writes out. An unknown label
 * is reported by its shape instead, because a name or a code is a string a thrower chooses: allowlisting the observed
 * ones keeps an arbitrary value — a credential label among them — out of the record, and a new label showing up as
 * `other` is a finding to add here by hand rather than something to classify at runtime. This is a fixed list, not a
 * classifier: nothing here decides what a failure means.
 */
const KNOWN_NAMES = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "ModelsError", "CredentialSynchronizationError", "SpikeError", "StartupError"];
const KNOWN_CODES = ["auth", "oauth", "provider", "api", "ENOENT", "EACCES", "EISDIR", "ENOTDIR", "ABORT_ERR", "ERR_PI_FUSION_TEST_FENCE", "ERR_MODULE_NOT_FOUND"];

/**
 * This fixture's own failure, and the one kind whose wording is ever written out. Every text it carries is composed
 * in this file from this file's own values; nothing thrown by anything else is ever wrapped into one.
 */
class SpikeError extends Error {
	constructor(message) {
		super(message);
		this.name = "SpikeError";
	}
}

const [mode, specFile] = process.argv.slice(2);
const note = (text) => process.stderr.write(`[driver] ${text}\n`);

/** The numeric label of a dummy credential, or null: the value itself is never reported, only which generation it is. */
const labelOf = (value) => {
	const found = typeof value === "string" ? LABEL.exec(value) : null;
	return found ? Number(found[1]) : null;
};

/**
 * What a failure is allowed to say here. `name` and `code` are the SDK's own fixed vocabulary — a class name and a
 * one-word error kind — and are kept because they are what a reader needs to tell a refresh failure from a store
 * failure. The message is never copied: only its length, which of the known prefixes it starts with, and whether it
 * carries a dummy credential label at all.
 */
const failureEvidence = (error) => {
	const message = error instanceof Error && typeof error.message === "string" ? error.message : "";
	const rawName = typeof error?.name === "string" ? error.name : null;
	const rawCode = typeof error?.code === "string" ? error.code : null;
	return {
		present: true,
		type: typeof error,
		isError: error instanceof Error,
		// An observed label by its own name; anything else by its shape alone, so no value a thrower chose is echoed.
		name: rawName !== null && KNOWN_NAMES.includes(rawName) ? rawName : null,
		nameKind: rawName === null ? "absent" : KNOWN_NAMES.includes(rawName) ? "known" : "other",
		code: rawCode !== null && KNOWN_CODES.includes(rawCode) ? rawCode : null,
		codeKind: rawCode === null ? "absent" : KNOWN_CODES.includes(rawCode) ? "known" : "other",
		messageLength: message.length,
		prefix: KNOWN_PREFIXES.find((prefix) => message.startsWith(prefix)) ?? null,
		containsDummyMarker: message.includes(DUMMY_MARKER),
		hasCause: error?.cause !== undefined,
		hasStack: typeof error?.stack === "string",
	};
};

/**
 * A path by its metadata alone: what it is, how big it is and what mode it carries. Nothing is opened and no byte is
 * read, so this is what a path the driver does not own is looked at with — the adjacent credential lock above all.
 */
const describePath = (file) => {
	let stats;
	try {
		stats = fs.lstatSync(file);
	} catch (error) {
		return { present: false, code: error?.code ?? String(error) };
	}
	// proper-lockfile takes its lock by creating a directory beside the credential file, so a lock probe lands here.
	const kind = stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
	return { present: true, kind, bytes: stats.size, mode: (stats.mode & 0o777).toString(8) };
};

/**
 * A credential file this call owns, read by this file's own observation code: the private path inside this call's own
 * directory, which exists only because the user had none. The containment check is the boundary made explicit rather
 * than assumed — a path outside the call directory is refused here instead of being opened — so a user's own shared
 * file has no way through this function at all, whatever the SDK's credential store does with it elsewhere in this
 * process. Its content is still never reported: only whether it is the empty object the SDK creates and how many
 * entries it holds.
 */
const describePrivateFile = (file, callDir) => {
	const resolved = path.resolve(file);
	if (!resolved.startsWith(`${path.resolve(callDir)}${path.sep}`)) throw new SpikeError("this driver reads a credential file only inside its own call directory, and the path it was given is outside one");
	const meta = describePath(resolved);
	if (!meta.present || meta.kind !== "file") return meta;
	let text;
	try {
		text = fs.readFileSync(resolved, "utf8");
	} catch (error) {
		return { ...meta, unreadable: error?.code ?? String(error) };
	}
	return { ...meta, emptyObject: text.trim() === "{}", entries: countEntries(text) };
};

/** How many provider entries a file holds, or null when it does not parse: no value of any entry is read out. */
const countEntries = (text) => {
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).length : null;
	} catch {
		return null;
	}
};

/**
 * The SDK this driver runs against, resolved from the package root the spec names and from nothing else: its own
 * `package.json` has to say it is this package, has to carry a version string, and has to publish an `import`
 * condition for the public entry that resolves to a file inside that same package root. There is no bin here, no
 * private subpath and no generic runtime override: a call is refused before anything is imported when any of that
 * does not hold, because a measurement against a package this check could not identify says nothing at all.
 */
function resolveSdk(packageRoot) {
	const root = path.resolve(packageRoot);
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	} catch {
		// Deliberately unbound, like every other refusal here: the wording is fixed, and neither the thrown value nor
		// anything the file held reaches it. The path is the one the caller composed and is safe to name.
		throw new SpikeError(`the package at ${root} has no readable package.json metadata, so this driver cannot say which build it would measure`);
	}
	// The manifest's own fields are untrusted content and are never echoed: what the refusal names is the rule broken.
	if (manifest.name !== SDK_PACKAGE) throw new SpikeError(`the package at ${root} does not name ${SDK_PACKAGE} in its manifest, and this driver measures that package alone`);
	if (typeof manifest.version !== "string" || !manifest.version.trim()) throw new SpikeError(`the package at ${root} carries no version string in its manifest, so a measurement could not say which build it was against`);
	const specifier = manifest.exports?.["."]?.import;
	if (typeof specifier !== "string" || !specifier.startsWith("./")) throw new SpikeError(`${SDK_PACKAGE} at ${root} publishes no local exports["."].import entry, and this driver imports the public entry alone`);
	const entry = path.resolve(root, specifier);
	if (!entry.startsWith(`${root}${path.sep}`)) throw new SpikeError(`${SDK_PACKAGE} at ${root} points its public entry outside its own package root`);
	// Asked as a condition rather than by letting a filesystem error escape: a foreign throw here would be recorded as
	// evidence with no wording at all, and this is a rule of this driver's own with a wording of its own.
	let entryIsFile = false;
	try {
		entryIsFile = fs.statSync(entry).isFile();
	} catch {
		entryIsFile = false;
	}
	if (!entryIsFile) throw new SpikeError(`${SDK_PACKAGE} at ${root} has no readable file at the public entry its manifest names`);
	return { root, name: manifest.name, version: manifest.version, entry };
}

/**
 * What `ModelRuntime.getError()` answers, read the way the production bootstrap reads it and recorded with the same
 * distinctions. A missing accessor and one that throws or answers a shape the bootstrap does not read are `usable:
 * false` — they are compatibility findings, not an empty aggregate, and nothing here lets one pass for "no error".
 * A string is empty or not by the same rule production uses, which is whether it holds any non-blank text. The text
 * itself is never copied: its length and whether it carries the dummy marker are what is kept.
 */
const aggregateError = (runtime) => {
	if (typeof runtime?.getError !== "function") return { api: "missing", usable: false };
	let reported;
	try {
		reported = runtime.getError();
	} catch {
		// Deliberately unbound: there is no path from a thrown value here into a message, a cause or a code.
		return { api: "threw", usable: false };
	}
	if (reported === undefined) return { api: "function", usable: true, shape: "undefined", empty: true };
	if (typeof reported !== "string") return { api: "function", usable: false, shape: typeof reported };
	return { api: "function", usable: true, shape: "string", empty: reported.trim() === "", length: reported.length, containsDummyMarker: reported.includes(DUMMY_MARKER) };
};

/** One loopback call to a service the harness owns. Every url in a spec is one of the harness's own origins. */
async function control(url, { timeoutMs = 120_000 } = {}) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	const text = await response.text();
	if (!response.ok) throw new Error(`the harness control ${url} answered ${response.status}`);
	return text;
}

async function runResolve(spec) {
	const observations = {
		mode: "resolve",
		caller: spec.caller,
		pid: process.pid,
		startedAt: Date.now(),
		// The one environment value the runtime below reads for itself: production composes permission to refresh a
		// catalog, and this build's `ModelRuntime` asks whether `PI_OFFLINE` is set at all before it acts on it. What
		// this process actually got is recorded rather than assumed, so the controller checks both halves.
		env: { PI_OFFLINE: process.env.PI_OFFLINE ?? null },
		stages: [],
		callback: [],
		marks: [],
	};
	const persist = () => fs.writeFileSync(spec.observations, `${JSON.stringify(observations, null, 2)}\n`);
	const stage = (name, detail) => {
		observations.stages.push({ stage: name, at: Date.now(), ...(detail === undefined ? {} : { detail }) });
		persist();
	};
	const mark = async (name) => {
		if (!spec.controlUrl) return;
		observations.marks.push({ mark: name, at: Date.now() });
		persist();
		await control(`${spec.controlUrl}/mark?stage=${encodeURIComponent(name)}&caller=${encodeURIComponent(spec.caller)}`);
	};
	let storage;
	try {
		stage("start");
		const sdkInfo = resolveSdk(spec.packageRoot);
		observations.sdk = { name: sdkInfo.name, version: sdkInfo.version, entry: sdkInfo.entry };
		stage("sdk-resolved", { version: sdkInfo.version });

		// The production helpers, imported from the repository this spike lives in: the paths below are the ones a real
		// call would run on, and this driver composes none of them itself.
		const storageModule = await import(pathToFileURL(path.join(spec.repoRoot, "extensions", "backends", "pi-storage.ts")).href);
		const launchModule = await import(pathToFileURL(path.join(spec.repoRoot, "extensions", "backends", "pi-launch.ts")).href);
		const bindingModule = await import(pathToFileURL(path.join(spec.repoRoot, "extensions", "backends", "pi-binding.ts")).href);
		const role = bindingModule.piRole({ role: spec.role.name, model: spec.role.model }, undefined, {});
		storage = storageModule.prepareCallStorage({ hostAgentDir: spec.hostAgentDir, cwd: spec.cwd, handle: spec.handle });
		const input = launchModule.bootstrapInput({ role, storage, session: { kind: "new" }, contract: fs.readFileSync(spec.contractFile, "utf8") });
		observations.selected = {
			sharedAuth: storage.sharedAuth,
			authPath: storage.authPath,
			userAuthPath: storage.userAuthPath,
			modelsPath: storage.modelsPath,
			privateModelsPath: storage.privateModelsPath,
			modelsStorePath: storage.modelsStorePath,
			callDir: storage.callDir,
			// What the bootstrap would hand the runtime, which is what this driver hands it below.
			input: { authPath: input.authPath, modelsPath: input.modelsPath, modelsStorePath: input.modelsStorePath, allowModelNetwork: input.allowModelNetwork },
			inputModelsPathExists: fs.existsSync(input.modelsPath),
			// A shared path is the user's own file: the SDK's store reads and rotates it below, and this observation
			// code never opens it. A private path is this call's own and is described.
			authFileBeforeCreate: storage.sharedAuth ? { probed: false, reason: "shared user file: observed by the controller, never read by this driver's own probes" } : describePrivateFile(input.authPath, storage.callDir),
		};
		stage("storage-prepared", { sharedAuth: storage.sharedAuth });

		const sdk = await import(pathToFileURL(sdkInfo.entry).href);
		if (typeof sdk.ModelRuntime?.create !== "function") throw new SpikeError(`${SDK_PACKAGE} ${sdkInfo.version} exports no ModelRuntime.create(), so there is nothing to measure here`);
		observations.sdk.reportedVersion = typeof sdk.VERSION === "string" ? sdk.VERSION : null;
		stage("sdk-imported");

		// Exactly the option set `createModelRuntime` in the production bootstrap passes, its catalog permission
		// included: the auth path is the one the storage selected, and the models path is the user's own or this
		// call's absent private one. No catalog request follows it here, because `PI_OFFLINE` is set in this
		// environment and recorded above.
		const runtime = await sdk.ModelRuntime.create({
			authPath: input.authPath,
			modelsPath: input.modelsPath,
			modelsStorePath: input.modelsStorePath,
			allowModelNetwork: input.allowModelNetwork === true,
		});
		observations.runtimeCreated = true;
		observations.authFileAfterCreate = storage.sharedAuth ? { probed: false, reason: "shared user file: observed by the controller, never read by this driver's own probes" } : describePrivateFile(input.authPath, storage.callDir);
		// Read where the production bootstrap reads it, and again after the provider work below, because the aggregate
		// covers composition and availability as well as the configuration this call started from.
		observations.aggregate = { afterCreate: aggregateError(runtime) };
		stage("runtime-created");

		const providerId = spec.provider.id;
		runtime.registerProvider(providerId, {
			name: spec.provider.name,
			baseUrl: spec.provider.baseUrl,
			api: "openai-completions",
			models: [
				{
					id: spec.provider.modelId,
					name: spec.provider.modelId,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
			oauth: {
				name: "fixture oauth (dummy credentials, loopback token endpoint)",
				// Nothing in this spike logs in: a login here would be a flow, and what is measured is the store.
				login: async () => {
					observations.callback.push({ event: "login-refused", at: Date.now() });
					throw new Error("the fixture provider does not log in: this spike measures the credential store, not a login flow");
				},
				/**
				 * The one network call this fixture makes, to the harness's own loopback endpoint, with the signal the
				 * SDK supplies so its refresh timeout and the caller's cancellation both reach it. Every field of the
				 * current credential is re-emitted deliberately: the SDK's extension-oauth adapter stores exactly what
				 * this returns with `type` added, so a provider-specific extra field survives a rotation because this
				 * callback carries it over, and not because the SDK preserves anything implicitly.
				 */
				refreshToken: async (credentials, signal) => {
					const sentLabel = labelOf(credentials.refresh);
					observations.callback.push({ event: "refresh-start", at: Date.now(), sentRefreshLabel: sentLabel });
					persist();
					let response;
					try {
						response = await fetch(spec.tokenUrl, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ refresh: credentials.refresh, caller: spec.caller }),
							signal,
						});
					} catch (error) {
						observations.callback.push({ event: "refresh-transport-failed", at: Date.now(), evidence: failureEvidence(error) });
						persist();
						throw new Error("the fixture token endpoint could not be reached");
					}
					if (!response.ok) {
						observations.callback.push({ event: "refresh-rejected", at: Date.now(), status: response.status });
						persist();
						throw new Error(`the fixture token endpoint answered ${response.status}`);
					}
					const minted = await response.json();
					const next = { ...credentials, access: minted.access, refresh: minted.refresh, expires: Date.now() + minted.expiresInMs };
					observations.callback.push({ event: "refresh-end", at: Date.now(), mintedAccessLabel: labelOf(next.access), mintedRefreshLabel: labelOf(next.refresh), expiresInMs: minted.expiresInMs });
					persist();
					return next;
				},
				getApiKey: (credentials) => credentials.access,
			},
		});
		// `create` already ran its own refresh, so the provider registered after it needs one for its availability to
		// be settled before anything below reads it. `allowNetwork` is false: no catalog is fetched by this spike.
		await runtime.refresh({ allowNetwork: false });
		observations.aggregate.afterRegister = aggregateError(runtime);
		observations.hasConfiguredAuth = runtime.hasConfiguredAuth(providerId);
		observations.registeredProviderIds = [...runtime.getRegisteredProviderIds()].sort();
		stage("provider-registered", { hasConfiguredAuth: observations.hasConfiguredAuth });

		// The ready gate: this caller is fully constructed and available, and waits here until the harness releases it.
		// That is what keeps the store's own startup locks out of an overlap case — both callers are past them already.
		if (spec.gate) {
			observations.gate = { name: spec.gate, arrivedAt: Date.now() };
			persist();
			await control(`${spec.controlUrl}/gate?name=${encodeURIComponent(spec.gate)}&caller=${encodeURIComponent(spec.caller)}`);
			observations.gate.releasedAt = Date.now();
			stage("gate-released", { name: spec.gate });
		}

		// Whether the adjacent lock is there the instant before this caller asks: proper-lockfile names it `<file>.lock`
		// beside the credential file, so its presence is what an overlapping caller can actually observe.
		if (spec.lockProbe) {
			observations.lockBeforeGetAuth = describePath(`${input.authPath}.lock`);
			stage("lock-probed", { present: observations.lockBeforeGetAuth.present });
		}

		const overrides = spec.minOAuthValidityMs === undefined ? {} : { minOAuthValidityMs: spec.minOAuthValidityMs };
		observations.minOAuthValidityMs = spec.minOAuthValidityMs ?? null;
		observations.getAuthInvokedAt = Date.now();
		const pending = runtime.getAuth(providerId, overrides);
		// Attached immediately so a rejection that happens while this caller is publishing its in-flight marker is not
		// an unhandled rejection; the outcome is still read from the same promise below.
		pending.catch(() => {});
		stage("getauth-invoked");
		// The in-flight marker: a caller that must be proved to be inside `getAuth` while another one holds the lock
		// says so before it awaits, because a marker sent afterwards would only prove it had already finished.
		if (spec.deferAwait) await mark("inflight");
		try {
			const result = await pending;
			observations.getAuth = {
				ok: true,
				at: Date.now(),
				resolved: result !== undefined,
				source: typeof result?.source === "string" ? result.source : null,
				apiKeyPresent: typeof result?.auth?.apiKey === "string",
				apiKeyLabel: labelOf(result?.auth?.apiKey),
				apiKeyIsDummy: typeof result?.auth?.apiKey === "string" && result.auth.apiKey.includes(DUMMY_MARKER),
			};
		} catch (error) {
			observations.getAuth = { ok: false, at: Date.now(), evidence: failureEvidence(error) };
		}
		stage("getauth-settled", { ok: observations.getAuth.ok });
		// What the file holds afterwards is the controller's to snapshot, while no driver is running.
		await mark("done");
	} catch (error) {
		observations.error = failureEvidence(error);
		observations.errorStage = "driver";
		// The one place a wording is written out, and only for this fixture's own failure: a `SpikeError`'s text was
		// composed in this file. Anything else that reaches here — an SDK constructor, a production helper, node
		// itself — is evidence and nothing more, because its message, its cause and its stack can all quote a file
		// that holds credentials. There is no fallback that prints a foreign name, code or message instead.
		observations.errorOwn = error instanceof SpikeError;
		observations.errorText = error instanceof SpikeError ? String(error.message).slice(0, 400) : undefined;
		note(observations.errorOwn ? `failed: ${observations.errorText}` : "failed: a foreign error was thrown and is recorded as evidence only");
	} finally {
		if (storage) {
			// The private path is this call's own, so its creation and its removal are both this driver's to report;
			// a shared path belongs to the user's profile and is never removed here.
			observations.privateAuthBeforeDispose = storage.sharedAuth ? null : describePrivateFile(storage.authPath, storage.callDir);
			try {
				storage.dispose();
				observations.disposed = !fs.existsSync(storage.callDir);
				observations.privateAuthAfterDispose = storage.sharedAuth ? null : fs.existsSync(storage.authPath);
			} catch (error) {
				observations.disposeError = failureEvidence(error);
			}
		}
		observations.endedAt = Date.now();
		persist();
	}
	process.exitCode = observations.error ? 1 : 0;
}

const readSpec = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

if (mode === "resolve" && specFile) await runResolve(readSpec(specFile));
else {
	process.stderr.write(`[driver] usage: node pi-auth-driver.mjs resolve <spec.json>\n`);
	process.exitCode = 2;
}
