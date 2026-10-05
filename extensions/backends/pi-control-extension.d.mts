/**
 * What `pi-control-extension.mjs` exports, declared so a TypeScript caller and a test can use it without the module
 * itself needing a loader: the file that runs in the child stays plain ESM, and this is the only place its shape is
 * typed. Nothing here imports or re-declares the SDK's own types — each shape below is narrowed to the part this
 * extension actually uses, so the installed extension api and context satisfy it and a test's own fakes do too.
 */

export declare const CONTROL_EXTENSION_NAME: "pi-fusion";
/** The path the resource loader reports a named factory under, which is `<inline:name>` for this one. */
export declare const CONTROL_EXTENSION_PATH: string;
export declare const NAVIGATE_COMMAND: "pi-fusion-navigate";
export declare const FORK_COMMAND: "pi-fusion-fork";
/** The commands this extension registers, in the order it registers them. */
export declare const CONTROL_COMMANDS: readonly string[];
/** The one fixed sentence a command called with anything but one json string fails with. */
export declare const CONTROL_INVALID_ARGUMENT: string;
/** The one fixed sentence a cancelled session operation fails with. */
export declare const CONTROL_CANCELLED: string;
/** The one fixed sentence an operation that did not say whether it was cancelled fails with. */
export declare const CONTROL_UNANSWERED: string;

/**
 * The part of a command context these handlers use, and all of it: the two session operations, each with the one
 * option this file passes. What they answer with is `unknown` on purpose — the handler checks the shape at runtime
 * rather than trusting a declaration, because the answer comes from the installed package rather than from here.
 */
export interface ControlCommandContext {
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<unknown>;
	fork(entryId: string, options?: { position?: "before" | "at" }): Promise<unknown>;
}

/** One command as it is registered: a description for the menu, and the handler the argument string reaches. */
export interface ControlCommand {
	description: string;
	handler(args: string, ctx: ControlCommandContext): Promise<void>;
}

/** The part of the extension api this factory uses, which is one registration method. */
export interface ControlExtensionApi {
	registerCommand(name: string, command: ControlCommand): void;
}

/** The named factory the loader takes, which is what fixes the path everything it registers is reported under. */
export interface ControlExtension {
	name: string;
	factory(pi: ControlExtensionApi): void;
}

export declare function controlExtension(): ControlExtension;
