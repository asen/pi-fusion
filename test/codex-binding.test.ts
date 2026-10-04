import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	CODEX_CONTRACT_FILES,
	CODEX_HOST_DEFAULT,
	CODEX_MODES,
	CODEX_ROLE_NAMES,
	codexEffortVariable,
	codexModelVariable,
	codexParams,
	codexRole,
	codexVariableFallback,
} from "../extensions/backends/codex-binding.ts";
import { KNOWN_ROLE_NAMES, runsOn } from "../extensions/roles.ts";

/**
 * The Codex binding on its own: what a call resolves to, from which setting, and what it refuses. Pure: no host, no
 * backend and no child, and every environment it reads is one this file passes in.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NO_ENV = {} as NodeJS.ProcessEnv;
const IMPLEMENT = { name: "implement", contract: "implement.md", addendum: "codex-no-questions.md", sandboxMode: "workspace-write", approvalPolicy: "never" } as const;
const ask = (mode: "answer" | "review") => ({ name: "ask", contract: `ask-${mode}.md`, addendum: "codex-no-questions.md", mode, sandboxMode: "read-only", approvalPolicy: "never" }) as const;

test("the codex binding binds the roles the role table runs on codex, and no other", () => {
	assert.deepEqual([...CODEX_ROLE_NAMES], KNOWN_ROLE_NAMES.filter((role) => runsOn(role, "codex")));
	for (const role of ["plan", "ultracode", "security", "audit"]) {
		assert.throws(() => codexRole({ role }, undefined, NO_ENV), new RegExp(`^Error: role ${role} does not run on the codex backend; use one of implement, ask$`), role);
		assert.throws(() => codexParams({ role }), new RegExp(`^Error: role ${role} does not run on the codex backend`), role);
	}
});

test("a role that names no model binds none, so the host's own codex default is what runs and the display label never reaches a runtime", () => {
	const implement = codexRole({ role: "implement" }, undefined, NO_ENV);
	assert.deepEqual(implement, IMPLEMENT);
	for (const field of ["model", "provider", "effort"]) assert.equal(field in implement, false, `${field} is held as a key though nothing named it`);
	assert.equal(CODEX_HOST_DEFAULT, "host default");
	assert.ok(!(Object.values(implement) as string[]).includes(CODEX_HOST_DEFAULT));
	assert.deepEqual(codexRole({ role: "ask" }, undefined, NO_ENV), ask("answer"));
	assert.deepEqual(codexRole({ role: "ask", mode: "review" }, undefined, NO_ENV), ask("review"));
});

test("an ask run reads in a read-only sandbox and an implement run writes in its workspace, both with no approval ever asked", () => {
	assert.equal(codexRole({ role: "ask" }, undefined, NO_ENV).sandboxMode, "read-only");
	assert.equal(codexRole({ role: "ask", mode: "review" }, undefined, NO_ENV).sandboxMode, "read-only");
	assert.equal(codexRole({ role: "implement" }, undefined, NO_ENV).sandboxMode, "workspace-write");
	for (const role of CODEX_ROLE_NAMES) assert.equal(codexRole({ role }, undefined, NO_ENV).approvalPolicy, "never");
});

test("the parameters: mode is ask's alone and only answer or review, model and effort are both roles', and fresh is no codex role's", () => {
	assert.deepEqual(codexParams({ role: "ask" }), { name: "ask", mode: "answer" });
	assert.deepEqual(codexParams({ role: "ask", mode: "review" }), { name: "ask", mode: "review" });
	assert.deepEqual([...CODEX_MODES], ["answer", "review"]);
	for (const mode of ["summary", "Review", "", " review"]) assert.throws(() => codexParams({ role: "ask", mode }), new RegExp(`^Error: unknown mode ${mode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; use one of answer, review$`), JSON.stringify(mode));
	assert.throws(() => codexParams({ role: "implement", mode: "answer" }), /^Error: mode is not allowed for role implement on the codex backend$/);
	for (const role of CODEX_ROLE_NAMES) {
		assert.doesNotThrow(() => codexParams({ role, model: "gpt-5-codex", effort: "high" }), role);
		for (const fresh of [true, false]) assert.throws(() => codexParams({ role, fresh }), new RegExp(`^Error: fresh is not allowed for role ${role} on the codex backend$`), role);
	}
});

test("the selection comes from the call, then the run it continues, then the fallback, then the role's own variables, field by field", () => {
	const env = { [codexModelVariable("implement")]: " gpt-5-codex ", [codexEffortVariable("implement")]: "medium" } as NodeJS.ProcessEnv;
	assert.equal(codexModelVariable("implement"), "PI_FUSION_CODEX_IMPLEMENT_MODEL");
	assert.equal(codexEffortVariable("ask"), "PI_FUSION_CODEX_ASK_EFFORT");
	assert.deepEqual(codexVariableFallback("implement", env), { model: { value: "gpt-5-codex", from: "PI_FUSION_CODEX_IMPLEMENT_MODEL" }, effort: { value: "medium", from: "PI_FUSION_CODEX_IMPLEMENT_EFFORT" } });
	assert.deepEqual(codexVariableFallback("ask", { PI_FUSION_CODEX_ASK_MODEL: "  " } as NodeJS.ProcessEnv), {}, "a blank variable is unset, not a model");
	// The role's own variables, when the caller passes no fallback.
	assert.deepEqual(codexRole({ role: "implement" }, undefined, env), { ...IMPLEMENT, model: "gpt-5-codex", effort: "medium" });
	// A fallback the caller passes replaces the variables entirely: a profile never borrows a variable for a field it left out.
	const configured = { model: { value: "o3", from: "profile work" } };
	assert.deepEqual(codexRole({ role: "implement" }, undefined, env, configured), { ...IMPLEMENT, model: "o3" });
	// The recorded selection wins over the fallback, provider and effort included.
	const recorded = { model: "gpt-5.5", provider: "openai", effort: "low" };
	assert.deepEqual(codexRole({ role: "implement" }, recorded, env, configured), { ...IMPLEMENT, model: "gpt-5.5", provider: "openai", effort: "low" });
	// The call wins over both for the fields it names, trimmed, and the recorded provider stays with the thread.
	assert.deepEqual(codexRole({ role: "implement", model: " o4-mini ", effort: "xhigh" }, recorded, env, configured), { ...IMPLEMENT, model: "o4-mini", provider: "openai", effort: "xhigh" });
	assert.deepEqual(codexRole({ role: "implement", effort: "high" }, recorded, env), { ...IMPLEMENT, model: "gpt-5.5", provider: "openai", effort: "high" });
	// A recorded selection with no effort leaves the effort to the fallback, which names none here: it stays unset.
	assert.deepEqual(codexRole({ role: "ask" }, { model: "gpt-5.5", provider: "azure" }, NO_ENV), { ...ask("answer"), model: "gpt-5.5", provider: "azure" });
	// The effort is optional on its own: a configured model with no level leaves the level to the host.
	assert.deepEqual(codexRole({ role: "ask" }, undefined, { PI_FUSION_CODEX_ASK_MODEL: "gpt-5-codex" } as NodeJS.ProcessEnv), { ...ask("answer"), model: "gpt-5-codex" });
	// A fresh call has no provider: nothing a call or a configuration names is one.
	assert.equal("provider" in codexRole({ role: "implement", model: "gpt-5-codex" }, undefined, env), false);
});

test("a value no codex child could take is refused with the setting it came from, and a blank call field never falls through", () => {
	assert.throws(() => codexRole({ role: "implement" }, undefined, { PI_FUSION_CODEX_IMPLEMENT_MODEL: "gpt 5" } as NodeJS.ProcessEnv), /^Error: PI_FUSION_CODEX_IMPLEMENT_MODEL names model "gpt 5", which is not a codex model: name one model id with no whitespace in it, or leave it unset for the host default$/);
	assert.throws(() => codexRole({ role: "ask" }, undefined, { PI_FUSION_CODEX_ASK_EFFORT: "very high" } as NodeJS.ProcessEnv), /^Error: PI_FUSION_CODEX_ASK_EFFORT names effort "very high", which is not a codex effort: name one level with no whitespace in it, or leave it unset for the host default$/);
	assert.throws(() => codexRole({ role: "implement" }, undefined, NO_ENV, { model: { value: "a\tb", from: "profile work (modified)" } }), /^Error: profile work \(modified\) names model "a\\tb", which is not a codex model/);
	assert.throws(() => codexRole({ role: "implement", model: "gpt 5" }, undefined, NO_ENV), /^Error: the call names model "gpt 5", which is not a codex model/);
	assert.throws(() => codexRole({ role: "implement", effort: "x high" }, undefined, NO_ENV), /^Error: the call names effort "x high", which is not a codex effort/);
	const recorded = { model: "gpt-5.5", provider: "openai", effort: "low" };
	for (const blank of ["", " ", "\t"]) {
		assert.throws(() => codexRole({ role: "implement", model: blank }, recorded, NO_ENV), /^Error: the call names an empty model for the codex backend; name one or leave the model parameter out to take the recorded, configured or host default model$/, JSON.stringify(blank));
		assert.throws(() => codexRole({ role: "implement", effort: blank }, recorded, NO_ENV), /^Error: the call names an empty effort for the codex backend/, JSON.stringify(blank));
	}
	// A recorded selection this host did not write is refused rather than repeated.
	assert.throws(() => codexRole({ role: "implement" }, { model: "gpt-5.5", provider: "open ai" }, NO_ENV), /^Error: the selection the run it continues ran with names provider "open ai", which is not a codex model provider$/);
	assert.throws(() => codexRole({ role: "implement" }, { model: "gpt 5.5", provider: "openai" }, NO_ENV), /^Error: the selection the run it continues ran with names model "gpt 5\.5"/);
});

test("every contract a codex role runs under is a shipped file, and the addendum says how a codex child does without questions", () => {
	assert.deepEqual([...CODEX_CONTRACT_FILES].sort(), ["ask-answer.md", "ask-review.md", "codex-no-questions.md", "implement.md"]);
	for (const name of CODEX_CONTRACT_FILES) assert.ok(fs.existsSync(path.join(repoRoot, "contracts", name)), `contracts/${name} is not shipped`);
	const addendum = fs.readFileSync(path.join(repoRoot, "contracts", "codex-no-questions.md"), "utf8");
	assert.match(addendum, /no ask_orchestrator tool/);
	assert.match(addendum, /A message from the user or the orchestrator may arrive while you work\. It is not an answer to a question of yours\./);
	assert.doesNotMatch(addendum, /no message or steer arrives/, "a codex run's input is open, so the addendum no longer says nothing arrives");
	assert.match(addendum, /under Escalation/);
	assert.match(addendum, /under Escalation for an implement report, under Open questions for an ask answer, and under Notes for an ask review/);
	// Each section the addendum sends a missing decision to is one the shared contract of that role and mode really has,
	// so a review is never told to write under an Open questions heading its report shape lacks.
	const sections: Array<[string, string]> = [
		["implement", "Escalation"],
		["ask-answer", "Open questions"],
		["ask-review", "Notes"],
	];
	for (const [contract, section] of sections) {
		const text = fs.readFileSync(path.join(repoRoot, "contracts", `${contract}.md`), "utf8");
		assert.match(text, new RegExp(`^## ${section}$`, "m"), `contracts/${contract}.md has no ${section} section for the addendum to point at`);
	}
	assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, "contracts", "ask-review.md"), "utf8"), /^## Open questions$/m, "the review shape has no Open questions section");
	assert.match(addendum, /end your report/);
	assert.match(addendum, /Do not commit/);
	assert.match(addendum, /Hosted web search is Codex's own tool/);
	assert.match(addendum, /only when the host's Codex configuration allows it/);
	assert.match(addendum, /name each source/);
});
