/**
 * What `pi-sdk-resolve.mjs` exports, declared so a test can read its rule without the module needing a loader. No
 * production module imports it: a launch names it as the path a child preloads, and importing it is what registers
 * its hook, which in this host would be the wrong process.
 */

/** The variable the host names its own Pi package directory in. A launch sets it and the preload removes it. */
export declare const SDK_DIR_VARIABLE: string;

/** The two packages a child resolves from the host's install: the bare names, each also with its subpaths. */
export declare const REDIRECTED: readonly string[];

/** Whether `specifier`, imported by `parentURL`, is resolved from the host's package rather than from beside its importer. */
export declare function redirected(specifier: string, parentURL: string | undefined, scope?: string): boolean;

/** Registers the hook for `dir`, the host's package directory, and returns where an import is resolved from. */
export declare function redirectTo(dir: string, scope?: string): string;
