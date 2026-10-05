/**
 * What `pi-helper-retry.mjs` exports, declared so a TypeScript caller and a test can use it without the module itself
 * needing a loader: the file that runs in the child stays plain ESM, and this is the only place its shape is typed.
 * Nothing here imports or re-declares the SDK's own types — the shapes below are the minimum the wrapper reads and
 * writes, named loosely enough that the installed tool definitions and a test's own fakes both satisfy them.
 */

/** The exact message each builtin rejects with when it could not get its helper, keyed by the tool's own name. */
export declare const HELPER_UNAVAILABLE: {
	readonly grep: string;
	readonly find: string;
};

/** The one fixed sentence a retry announces itself with, which holds nothing of the error it retries. */
export declare const HELPER_RETRY_NOTICE: string;

/** The update a retry sends: the public tool-result shape, with text content and no details, and all it ever sends. */
export interface HelperRetryNotice {
	content: { type: "text"; text: string }[];
	details: undefined;
}

/**
 * A tool definition as far as this wrapper reads it. `execute` is written as a method so a definition whose own
 * parameter types are narrower than these still satisfies it, and the two it only forwards are `unknown` because
 * nothing here looks inside them. The return is a promise because the replacement always returns one. Everything else
 * a definition carries is the caller's own, which is why the definition's type is the type parameter below: the fields
 * and their types come back exactly as they went in, the factory's metadata included.
 */
export interface HelperRetryDefinition {
	execute(
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: HelperRetryNotice) => void) | undefined,
		context: unknown,
	): Promise<unknown>;
}

export declare function withHelperRetry<Definition extends HelperRetryDefinition>(definition: Definition, unavailable: string): Definition;
