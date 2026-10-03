import { registerHooks } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The preload a Pi child is started with, so the Pi it runs is the host's own rather than whatever copy happens to lie
 * beside this install. Pi installs an extension from git or npm without its development dependencies and without its
 * peers, and the host's own extension loader answers this extension's imports from the host's package; a child is a
 * plain node process that loader never touches, so without this its imports of the SDK and of `typebox` find nothing,
 * or find a copy of another version than the host it runs beside — which shares that host's `auth.json`.
 *
 * The host names its package directory in `PI_FUSION_SDK_DIR`, an internal variable a launch alone sets. This module
 * reads it once and removes it, so nothing the child runs inherits it, and registers one resolve hook: an import of the
 * SDK or of `typebox`, by its bare name or a subpath, made by a module of this extension's own, is resolved as if from
 * inside that package — the SDK through its own name, which a package with an export map resolves to itself, and
 * `typebox` through that package's own dependency. Every other import, and every import a module outside this
 * extension makes, is node's own resolution untouched: the SDK's own imports already resolve from where it lies.
 *
 * A launch that sets no variable gets no hook, which is how a test or a harness that composes its own launch runs the
 * copy beside this install. Plain ESM importing node builtins alone, for the reason the bootstrap is.
 */

/** The variable the host names its own Pi package directory in. A launch sets it and this module removes it. */
export const SDK_DIR_VARIABLE = "PI_FUSION_SDK_DIR";

/** The two packages a child resolves from the host's install: the bare names, each also with its subpaths. */
export const REDIRECTED = ["@earendil-works/pi-coding-agent", "typebox"];

/** This extension's own modules, which are the only importers whose resolution is redirected. */
const SCOPE = pathToFileURL(path.dirname(path.dirname(fileURLToPath(import.meta.url))) + path.sep).href;

/** Whether `specifier`, imported by `parentURL`, is resolved from the host's package rather than from beside its importer. */
export const redirected = (specifier, parentURL, scope = SCOPE) =>
	typeof parentURL === "string" && parentURL.startsWith(scope) && REDIRECTED.some((name) => specifier === name || specifier.startsWith(`${name}/`));

/** Registers the hook for `dir`, the host's package directory, and returns where an import is resolved from. */
export function redirectTo(dir, scope = SCOPE) {
	if (!path.isAbsolute(dir)) throw new Error(`${SDK_DIR_VARIABLE} is not an absolute path; the host names its own Pi package directory there and nothing else`);
	const anchor = pathToFileURL(path.join(dir, "package.json")).href;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			return redirected(specifier, context.parentURL, scope) ? nextResolve(specifier, { ...context, parentURL: anchor }) : nextResolve(specifier, context);
		},
	});
	return anchor;
}

const dir = process.env[SDK_DIR_VARIABLE];
delete process.env[SDK_DIR_VARIABLE];
if (dir !== undefined) redirectTo(dir);
