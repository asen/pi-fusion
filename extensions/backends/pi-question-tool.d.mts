import type { Static, TObject, TString } from "typebox";

/**
 * What `pi-question-tool.mjs` exports, declared so a TypeScript caller and a test can use it without the module itself
 * needing a loader: the file that runs in the child stays plain ESM, and this is the only place its shape is typed.
 * Nothing here imports or re-declares the SDK's own types — the schema is typebox's own, and the context is the one
 * method this tool calls on it, named loosely enough that the installed extension context and a test's own fake both
 * satisfy it.
 */

export declare const QUESTION_TOOL_NAME: "ask_orchestrator";
export declare const QUESTION_TOOL_DESCRIPTION: string;
/** The one fixed sentence a dialog that produced no answer fails with, which holds nothing of the call. */
export declare const QUESTION_UNANSWERED: string;

/** The parameters the model fills in: one question, described for it. */
export type QuestionParameters = TObject<{ question: TString }>;

/** The result the tool answers with: the answer as its only content, and no structured details at all. */
export interface QuestionAnswer {
	content: { type: "text"; text: string }[];
	details: undefined;
}

/**
 * The part of an extension context this tool reads, and all of it: one blocking input dialog. The options are the
 * public dialog options' own shape, narrowed to the field this tool ever passes.
 */
export interface QuestionContext {
	ui: { input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined> };
}

/**
 * The definition as far as this module writes it. `execute` is written as a method so a caller whose own parameter
 * types are narrower still satisfies it, and `onUpdate` is `unknown` because nothing here sends an update at all.
 */
export interface QuestionToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: QuestionParameters;
	execute(toolCallId: string, params: Static<QuestionParameters>, signal: AbortSignal | undefined, onUpdate: unknown, context: QuestionContext): Promise<QuestionAnswer>;
}

export declare function questionTool(): QuestionToolDefinition;
