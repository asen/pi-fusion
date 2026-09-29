import * as nodeModule from "node:module";

/*
 * A fence for this suite's own subprocesses, and nothing else: test-only, never imported by production, and never
 * reachable from one. `child()` in `test/pi-bootstrap.test.ts` passes it with node's own `--import`, so the ordinary
 * module resolution those subprocesses use — an `import` or a `require` of a backend SDK by name, by subpath, or by a
 * path that resolves into one of those installed packages — is refused rather than resolved.
 *
 * Why a fence rather than trust: a subprocess here runs the real bootstrap, and what stops that bootstrap importing
 * the installed Pi is a validation failure earlier in its own code. That is the very code under test, so a mutation
 * that removes a rule would otherwise let a real package load, construct a settings manager and open a session in a
 * process the test only meant to watch fail. This closes that ordinary path: the import is refused while it is still a
 * specifier, before anything is resolved, read or evaluated.
 *
 * What it is not. It is not a sandbox and it is not a network or filesystem boundary: a subprocess can still run
 * arbitrary code, spawn a process of its own, read a file by hand or reach a socket, and none of that goes through a
 * resolve hook. Two calls in that test file deliberately run without it, named and justified there. It covers node's
 * own module resolution in the process it is preloaded into, which is what these helpers use and all it claims.
 *
 * It fails closed. Without node's resolve hooks it throws at preload instead of letting an unfenced child run, and it
 * denies before it resolves, so a denied name never reaches the loader. It says nothing at all when nothing is denied.
 * The only module it imports is a node builtin.
 */

/** How a refusal says who refused. A test matches this, so it is one fixed string and not a sentence. */
export const FENCE_MARKER = "pi-fusion test fence:";

/** The scopes no subprocess of this suite may import from, bare or by subpath. */
export const FENCED_SCOPES = ["@earendil-works/", "@anthropic-ai/"];

/**
 * A name that is not installed anywhere and is fenced by a rule of its own. It is how a test shows the fence is
 * actually installed in a child without importing anything real, and it is the only rule a mutation check may flip:
 * flipping it leaves both scope rules and the url rule armed, so no experiment about this fence can let a subprocess
 * reach a backend SDK.
 */
export const FENCE_SENTINEL = "pi-fusion-fence-sentinel";

/** Whether a specifier is that sentinel. Its own rule, kept apart from the rules that fence a real package. */
export function fencedSentinel(specifier) {
	return specifier === FENCE_SENTINEL;
}

/**
 * Whether a specifier names a fenced package. The scope prefix covers the package and every subpath export of it, so
 * `@earendil-works/pi-coding-agent` and `@earendil-works/pi-coding-agent/rpc-entry` are one rule.
 */
export function fencedSpecifier(specifier) {
	return typeof specifier === "string" && FENCED_SCOPES.some((scope) => specifier.startsWith(scope));
}

/**
 * Whether a resolved url points inside a fenced package's own installed directory. This is the other way in: a
 * relative import, an absolute path or a file url that lands in `node_modules/@earendil-works/...` is the same package
 * by another name. The separators in a url are always `/`, on every platform.
 */
export function fencedUrl(url) {
	if (typeof url !== "string") return false;
	return FENCED_SCOPES.some((scope) => url.includes(`/node_modules/${scope}`));
}

/** Whether an import is fenced, by any of the rules. Pure, and exported so a test can read them without a subprocess. */
export function fenced(specifier, url) {
	return fencedSpecifier(specifier) || fencedSentinel(specifier) || fencedUrl(url);
}

const refuse = (what) => {
	const error = new Error(`${FENCE_MARKER} a test subprocess may not import ${what}; this suite starts no real backend child, and these subprocesses resolve no backend SDK`);
	error.code = "ERR_PI_FUSION_TEST_FENCE";
	return error;
};

/**
 * Installed once per process. `registerHooks` is the synchronous in-thread hook API; a runtime without it cannot be
 * fenced, and an unfenced subprocess is the thing this exists to prevent, so that is a refusal rather than a warning.
 */
if (!globalThis.__piFusionTestFence) {
	if (typeof nodeModule.registerHooks !== "function") {
		throw new Error(`${FENCE_MARKER} this node has no module.registerHooks(), so a subprocess of this suite cannot be fenced against resolving a backend SDK`);
	}
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			// Denied while it is still a name: nothing is resolved, read or evaluated for a fenced specifier.
			if (fencedSpecifier(specifier) || fencedSentinel(specifier)) throw refuse(specifier);
			const resolved = nextResolve(specifier, context);
			if (fencedUrl(resolved?.url)) throw refuse(specifier);
			return resolved;
		},
	});
	globalThis.__piFusionTestFence = true;
}
