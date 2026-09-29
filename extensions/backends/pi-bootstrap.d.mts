import type { HelperRetryDefinition } from "./pi-helper-retry.mjs";
import type { BootstrapInput, BootstrapSession } from "./pi-launch.ts";

/**
 * What `pi-bootstrap.mjs` exports, declared so a TypeScript caller and a test can use it without the bootstrap itself
 * needing a loader: the file that runs in the child stays plain ESM, and this is the only place its shape is typed.
 */

export declare const BOOTSTRAP_INPUT_VERSION: number;
export declare const STARTUP_EXIT_CODE: number;
export declare const DIAGNOSTIC_EVENT: string;
export declare const SDK_PACKAGE: string;
/** Pi's thinking levels, repeated in the plain-ESM bootstrap and asserted against the TypeScript side's own list. */
export declare const THINKING_LEVELS: readonly string[];

export declare class StartupError extends Error {
	readonly stage: string;
	constructor(stage: string, message: string, options?: ErrorOptions);
}

/** What one diagnostic line may carry, and all it may carry. */
export interface BootstrapDiagnostic {
	sdk?: string;
	error?: string;
}

/**
 * The public SDK surface the bootstrap calls, named loosely on purpose: the installed package satisfies it, and a
 * test passes a double that records what it was handed. Nothing here re-declares Pi's own types.
 */
export interface BootstrapSdk {
	VERSION?: unknown;
	CURRENT_SESSION_VERSION: unknown;
	SettingsManager: { inMemory(settings?: unknown, options?: unknown): unknown };
	ModelRuntime: { create(options?: unknown): Promise<{ getError?: () => string | undefined } & Record<string, unknown>> };
	SessionManager: {
		create(cwd: string, sessionDir?: string, options?: unknown): unknown;
		open(file: string, sessionDir?: string, cwdOverride?: string): unknown;
	};
	/**
	 * The two public search-tool factories, each taking one working directory and no options at all. What they answer
	 * with is described by the part this bootstrap reads and validates — a definition's own name, and an `execute` the
	 * retry wrapper calls — so a richer definition satisfies it and nothing re-declares the SDK's own tool type.
	 */
	createGrepToolDefinition(cwd: string): HelperRetryDefinition & { name: string };
	createFindToolDefinition(cwd: string): HelperRetryDefinition & { name: string };
	createAgentSessionServices(options: unknown): Promise<unknown>;
	createAgentSessionFromServices(options: unknown): Promise<unknown>;
	createAgentSessionRuntime(factory: unknown, options: unknown): Promise<unknown>;
	runRpcMode(runtime: unknown): Promise<never>;
	parseSessionEntries(content: string): unknown;
}

export declare function diagnostic(stage: string, detail?: BootstrapDiagnostic): string;
export declare function report(stage: string, detail?: BootstrapDiagnostic): void;
export declare function checkSdk(pkg: unknown): { version: string; sessionVersion: number };
export declare function loadSdk(): Promise<BootstrapSdk>;
/** The two kinds a resource may be, which is also what decides the access a probe asks for. */
export type ResourceKind = "file" | "directory";

/**
 * How a resource path is looked at, which is a parameter so a test can hand in a filesystem that reports a path this
 * process may not use. Production passes none of it: `readInput` calls `checkInput` with the default. `readable` is
 * given the kind the stat reported, because a directory is listed and walked into rather than opened and read, and on
 * POSIX those are two permissions rather than one.
 */
export interface ResourceProbe {
	stat(file: string): { isFile(): boolean; isDirectory(): boolean };
	readable(file: string, kind: ResourceKind): void;
}
export declare const resourceProbe: ResourceProbe;
export declare function checkInput(value: unknown, probe?: ResourceProbe): BootstrapInput;
/** Whether a file's own directory is the directory named, compared lexically for the platform named and nothing more. */
export declare function inDirectory(file: string, directory: string, platform?: NodeJS.Platform): boolean;
/**
 * Whether a loaded resource is the entry named or lies beneath it, compared lexically and segment by segment for the
 * platform named. No filesystem is read: this answers coverage, not identity.
 */
export declare function withinDirectory(file: string, directory: string, platform?: NodeJS.Platform): boolean;
/** The fixed wording every model-runtime refusal carries, which holds nothing the SDK produced. */
export declare const MODELS_REFUSED: string;
export declare function checkFraming(text: string): void;
export declare function readInput(file: unknown): BootstrapInput;
export declare function preflightSession(session: Extract<BootstrapSession, { kind: "open" }>, sdk: BootstrapSdk): { entries: number };
export declare function openSessionManager(input: BootstrapInput, sdk: BootstrapSdk): unknown;
export declare function buildSettings(input: BootstrapInput, sdk: BootstrapSdk): unknown;
/** One instruction file as the loader hands it to an override: its path and its content, and nothing else. */
export interface AgentsFile {
	path: string;
	content: string;
}
export declare function resourceOptions(
	input: BootstrapInput,
	platform?: NodeJS.Platform,
): {
	additionalExtensionPaths: string[];
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
	additionalThemePaths: string[];
	extensionFactories: unknown[];
	noExtensions: boolean;
	noSkills: boolean;
	noPromptTemplates: boolean;
	noThemes: boolean;
	noContextFiles: boolean;
	agentsFilesOverride: (base: { agentsFiles: AgentsFile[] }) => { agentsFiles: AgentsFile[] };
	systemPromptOverride: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride: (base: string[]) => string[];
};
export declare function createRuntime(input: BootstrapInput, sdk: BootstrapSdk): Promise<unknown>;
export declare function main(argv: readonly unknown[], options?: { sdk?: BootstrapSdk }): Promise<void>;
