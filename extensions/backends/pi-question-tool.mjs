import { Type } from "typebox";

/**
 * The one tool a Pi child asks the host a question with. It is composed and nothing more: this module starts nothing,
 * holds no state, reads no configuration and imports no SDK — `typebox` is the schema language a public tool
 * definition is written in, the same one the host's own tools use, and it is plain ESM because the bootstrap that
 * passes this definition to a session is.
 *
 * The name and the sentence are the Claude backend's own, word for word: a contract tells a child to ask through
 * `ask_orchestrator` whichever harness runs it, so a child that found another name or a different description here
 * would be reading one contract and running another tool.
 *
 * What holds a call open is Pi's own blocking dialog rather than anything of this module's. `ctx.ui.input` is one
 * `extension_ui_request` on the child's stdout that resolves when an `extension_ui_response` with the same id comes
 * back on its stdin, so the child waits where it already knows how to wait. Exactly one dialog per call, with no
 * timeout, no retry and no second question: how long a question may wait, who may answer it and what a late answer
 * means are the host's arbitration, and a timeout composed here would answer one of those with a number this module
 * has no business choosing. Nothing here maps a dialog to a run, a handle or a queue either — that is the bridge's,
 * and it is not in this file.
 */

/** The name a role's contract names, and the name the role's own tool list has to carry for this tool to be active. */
export const QUESTION_TOOL_NAME = "ask_orchestrator";

/** What the model reads about it: the Claude question tool's own description, so neither child is told less. */
export const QUESTION_TOOL_DESCRIPTION =
	"Ask the orchestrator that gave you this task for a decision you need to go on, such as a name or a choice between options inside the task's scope. The call waits until the orchestrator answers, which can take a long time; the answer is the result.";

/**
 * What a dialog that produced no answer fails the call with, and all it says. A dismissed dialog, a cancelled one and
 * one an abort dismissed all arrive as `undefined` — that is the one value 0.85.1's RPC ui resolves a `cancelled`
 * response with — so one fixed wording covers them rather than claiming which of them it was. It is a failed tool
 * result and not an empty answer, because an empty answer is something the host can actually send and this is the
 * absence of one. Nothing of the question, the dialog or the host is in it.
 */
export const QUESTION_UNANSWERED = "the question was dismissed rather than answered, so this call has no answer to report; ask again if the decision is still needed";

/**
 * The tool definition a call is given, built fresh so nothing is shared between two calls. The result is the public
 * tool-result shape with the answer as its only content and no structured details: an answer is the orchestrator's own
 * text, and there is nothing here for a renderer or a reconstruction to read beside it.
 */
export function questionTool() {
	return {
		name: QUESTION_TOOL_NAME,
		label: "Ask orchestrator",
		description: QUESTION_TOOL_DESCRIPTION,
		parameters: Type.Object({
			question: Type.String({ description: "The question, with the options you see and the one you recommend." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// The dialog options carry the call's own signal and nothing else, and are left out entirely when there is no
			// signal: `{ signal: undefined }` and no options at all are the same thing to the ui, and passing the second
			// would say this tool composed an option it did not.
			const answer = await ctx.ui.input(params.question, undefined, signal ? { signal } : undefined);
			if (answer === undefined) throw new Error(QUESTION_UNANSWERED);
			return { content: [{ type: "text", text: answer }], details: undefined };
		},
	};
}
