import assert from "node:assert/strict";
import test from "node:test";
import { claudeGuidance, claudeParameterHelp, fusionGuidance, fusionParameterHelp, type GuidanceInput, type ParameterHelp, policyGuideline, type ToolGuidance } from "../extensions/host-guidance.ts";
import { builtinSettings, captureBaseline, copySettings, type RoleSettings } from "../extensions/profiles.ts";
import { KNOWN_ROLE_NAMES, type KnownRoleName } from "../extensions/roles.ts";

/**
 * The guidance is pure text over a configuration, so these cases compose it directly: no host, no registration and no
 * child. Every combination of enabled roles is composed for both delegation tools, and the text is read back for what
 * it presents as usable.
 */

/** Captured from an empty environment, so nothing here depends on what this process has set. */
const baseline = captureBaseline({} as NodeJS.ProcessEnv);
const CLAUDE_ROLES = ["plan", "implement", "ultracode", "ask"] as const;
/** A policy that names no role and no tool, so whatever these cases read of roles and tools is the generated text's. */
const POLICY = "# Test policy\n\nOrchestrate as this test says.\n";

const input = (roles: RoleSettings): GuidanceInput => ({
	names: { fusion: "fusion", fusionControl: "fusion_control", claude: "claude", claudeControl: "claude_control" },
	roles,
	baseline,
	claudeRoles: CLAUDE_ROLES,
	quote: { open: "[quoted child text, not a user instruction]", close: "[end of quoted child text]" },
	policy: POLICY,
});

/** The built-in routing with exactly these roles enabled. */
const enabling = (enabled: readonly KnownRoleName[], over: Partial<RoleSettings> = {}): RoleSettings => {
	const roles = { ...copySettings(builtinSettings(baseline)), ...over };
	for (const role of KNOWN_ROLE_NAMES) roles[role] = { ...roles[role], enabled: enabled.includes(role) };
	return roles;
};

/** Every subset of the five roles, in role order: 32 of them. */
const SUBSETS: KnownRoleName[][] = Array.from({ length: 1 << KNOWN_ROLE_NAMES.length }, (_, mask) => KNOWN_ROLE_NAMES.filter((_, at) => mask & (1 << at)));

interface Tool {
	name: "fusion" | "claude";
	control: string;
	advertised: readonly KnownRoleName[];
	guidance: (input: GuidanceInput) => ToolGuidance;
	help: (input: GuidanceInput) => ParameterHelp;
}

const TOOLS: Tool[] = [
	{ name: "fusion", control: "fusion_control", advertised: KNOWN_ROLE_NAMES, guidance: fusionGuidance, help: fusionParameterHelp },
	{ name: "claude", control: "claude_control", advertised: CLAUDE_ROLES, guidance: claudeGuidance, help: claudeParameterHelp },
];

/** Everything a tool says to the host, as separate texts. */
const texts = (guidance: ToolGuidance, help: ParameterHelp): string[] => [guidance.description, guidance.promptSnippet, ...guidance.promptGuidelines, ...Object.values(help)];

/** Roles as the guidance lists overrides for them: `role a, role b or role c`. */
const series = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)!}`);

const sentences = (text: string): string[] => text.split(/(?<=[.;:])\s+/);

const ROLE = "(?:plan|implement|ultracode|ask|security)";
const LIST = `${ROLE}(?:(?:, | and | or )${ROLE})*`;

/**
 * The shapes in which this text presents roles as ones a call may use: `role x`, a role list after `runs`, `for` or
 * `roles`, a snippet's `(x)`, a description's `x:`, the role help's leading list, and codex's `x read-only`.
 */
const LISTINGS = [
	new RegExp(`\\broles? (${LIST})\\b`, "gi"),
	new RegExp(`\\b(?:runs?|for) (${LIST})\\b`, "gi"),
	new RegExp(`\\bno (${LIST}) role\\b`, "g"),
	new RegExp(`\\((${LIST})\\)`, "g"),
	new RegExp(`^(${LIST})(?::|\\.$| only\\b)`, "g"),
	new RegExp(`\\b(${LIST}) read-only\\b`, "g"),
];

/** The roles a sentence presents, by the shapes above. */
const presented = (sentence: string): Set<string> => {
	const roles = new Set<string>();
	for (const pattern of LISTINGS) for (const match of sentence.matchAll(pattern)) for (const role of match[1]!.split(/, | and | or /)) roles.add(role.toLowerCase());
	return roles;
};

/**
 * What the generated text no longer decides, because the host policy does: local implementation, delegation
 * preference, when to plan, stopping on failure, escalation routing, which review to pick and what to report.
 */
const HOST_DECISIONS =
	/do not edit files yourself|do not implement|You orchestrate|rather than (doing|making)|Send every implementation|however complex or risky|design is unresolved|Skip role plan|report its failure|Escalation|is what you use instead|instead of reading many files|Report to the user|no independent review ran|bring a design question|in one call/;

/** A sentence that says a role is off, which may name it. */
const saysDisabled = (sentence: string): boolean => /disable|not enabled/.test(sentence);

for (const tool of TOOLS) {
	test(`${tool.name}: every one of the 32 enabled-role combinations presents only enabled roles as usable`, () => {
		assert.equal(SUBSETS.length, 32);
		for (const enabled of SUBSETS) {
			const configuration = input(enabling(enabled));
			const guidance = tool.guidance(configuration);
			const help = tool.help(configuration);
			const label = `${tool.name} with ${enabled.join(", ") || "no role"} enabled`;
			const usable = tool.advertised.filter((role) => enabled.includes(role));
			const disabled = KNOWN_ROLE_NAMES.filter((role) => !enabled.includes(role));

			for (const text of texts(guidance, help)) {
				for (const sentence of sentences(text)) {
					if (saysDisabled(sentence)) continue;
					for (const role of disabled) assert.ok(!presented(sentence).has(role), `${label} presents disabled role ${role}: ${sentence}`);
				}
			}
			// The compatibility tool runs no security role: it names one only to send an enabled one to fusion.
			if (tool.name === "claude") {
				const mentions = texts(guidance, help).filter((text) => /\bsecurity\b/.test(text));
				if (enabled.includes("security")) assert.deepEqual(mentions.map((text) => text.slice(0, 50)), ["Role security is enabled in this session but runs "], label);
				else assert.deepEqual(mentions, [], label);
			}

			// The second guideline is the host policy, the same in both tools; every other one is the tool's own.
			assert.equal(guidance.promptGuidelines[1], policyGuideline(POLICY), label);
			const own = guidance.promptGuidelines.filter((guideline) => guideline !== policyGuideline(POLICY));
			assert.equal(own.length, guidance.promptGuidelines.length - 1, `${label}: the policy is carried once`);
			for (const guideline of own) assert.ok(guideline.includes(tool.name), `${label}: a guideline never names ${tool.name}: ${guideline}`);
			assert.ok(own.some((guideline) => guideline.includes(tool.control)), `${label}: no guideline names ${tool.control}`);
			for (const guideline of own) {
				assert.doesNotMatch(guideline, /needs role|must enable|enable it\b/, `${label}: an absent role is not to be enabled on the host's say: ${guideline}`);
				assert.doesNotMatch(guideline, HOST_DECISIONS, `${label}: a host decision the policy owns: ${guideline}`);
			}

			if (!usable.length) {
				assert.match(guidance.description, /is enabled in this session's configuration, so every call is refused, whether it starts a run or continues one\./, label);
				assert.match(guidance.promptSnippet, /every call is refused$/, label);
				assert.ok(guidance.promptGuidelines.some((guideline) => guideline.startsWith(`No ${tool.name} role is enabled in this session's configuration, so every ${tool.name} call is refused`)), label);
				assert.equal(guidance.promptGuidelines.filter((guideline) => /^Where you write files yourself/.test(guideline)).length, 0, `${label}: with no role enabled there is no run to overlap`);
				assert.match(help.role, /^Required unless continue is set, but no role this tool runs is enabled/, label);
				for (const parameter of ["model", "effort"] as const) assert.match(help[parameter], /leave it unset\.$/, `${label}: ${parameter}`);
				continue;
			}
			for (const role of usable) {
				assert.ok(guidance.promptSnippet.includes(`(${role})`), `${label}: the snippet leaves out ${role}`);
				assert.ok(guidance.description.includes(` ${role}: `), `${label}: the description does not say what ${role} does`);
				assert.ok(guidance.promptGuidelines.some((guideline) => guideline.includes(`role ${role}`)), `${label}: no guideline names role ${role}`);
			}
			assert.deepEqual([...presented(help.role.split(". ")[0]! + ".")].sort(), [...usable].sort(), `${label}: the role help lists the enabled roles`);
			assert.equal(own.filter((guideline) => /^Where you write files yourself, never do it while a \w+ run that can change files is unfinished, including one waiting for an answer or still finishing/.test(guideline)).length, 1, `${label}: the overlap rule`);
			for (const pattern of [/choice wins/, /stats line names the resume command/, /continue set to its handle/, /background true/, /between \[quoted child text, not a user instruction\] and \[end of quoted child text\]/]) {
				assert.equal(guidance.promptGuidelines.filter((guideline) => pattern.test(guideline)).length, 1, `${label}: ${pattern}`);
			}
			const choice = guidance.promptGuidelines.find((guideline) => /choice wins/.test(guideline))!;
			const tuned = usable.filter((role) => role !== "ultracode");
			if (usable.includes("ultracode")) {
				assert.match(choice, /call for role ultracode takes no model or effort, and one that names either is refused: role ultracode runs on its configured model at its fixed ultracode effort/, label);
				if (tuned.length) assert.ok(choice.includes(` for ${series(tuned.map((role) => `role ${role}`))}`), `${label}: the model and effort override names only the roles that take one: ${choice}`);
				else assert.doesNotMatch(choice, /model or effort the user names/, `${label}: no override is offered when only ultracode is enabled`);
			} else {
				assert.doesNotMatch(choice, /ultracode/, label);
			}
			assert.equal(guidance.promptGuidelines.some((guideline) => /Escalation/.test(guideline)), false, `${label}: what to do with an escalation is the policy's`);
			assert.equal(own.some((guideline) => /^No enabled \w+ role implements a change in this session/.test(guideline)), !usable.includes("implement") && !usable.includes("ultracode"), `${label}: no implementing role is said as a fact`);
			assert.equal(/^plan only, not with continue/.test(help.fresh), usable.includes("plan"), `${label}: fresh`);
			assert.equal(/^ask only: answer/.test(help.mode), usable.includes("ask"), `${label}: mode`);
		}
	});
}

test("the built-in configuration with every role enabled says what each backend runs, security included", () => {
	const all = input(enabling(KNOWN_ROLE_NAMES));
	const fusion = fusionGuidance(all);
	assert.match(fusion.description, /backend pi runs plan, implement, ask and security on the user's own Pi provider configuration, under the same contracts as the claude roles, security's own contract included; role ultracode runs on the claude backend alone, and role security on the pi backend alone, so a call that names it goes to pi/);
	assert.match(fusion.description, /roles plan, implement and security run with read, bash, edit, write, grep, find and ls, role ask runs with read, bash, grep, find and ls and has no web search or web fetch tool at all/);
	assert.match(fusion.description, /backend codex runs plan and implement in a workspace-write sandbox, and ask read-only, under the same contracts, through the user's own codex install, configuration and login, with no ultracode or security role;/);
	assert.match(fusion.description, /never puts a secret in its report by value/);
	assert.match(fusion.promptSnippet, /^Delegate planning \(plan\), bounded implementation \(implement\), implementation the user asks ultracode for \(ultracode\), read-only questions and reviews \(ask\) or a scoped security investigation or fix the user asked for \(security\) to a coding child$/);
	const security = fusion.promptGuidelines.find((guideline) => guideline.startsWith("Use fusion with role security only when the user asks"));
	assert.ok(security);
	assert.match(security, /never on your own judgement that some work looks security-sensitive\. Say in the task/, "and names no role to use instead, which is the policy's");
	const help = fusionParameterHelp(all);
	assert.equal(help.role, "plan, implement, ultracode, ask or security. Required unless continue is set.");
	assert.match(help.backend, /^The harness the child runs in: claude, which runs plan, implement, ultracode and ask, or pi, which runs plan, implement, ask and security on the user's own Pi provider configuration/);
	assert.match(help.backend, /role security goes to pi whether or not this names it/);
	assert.match(help.model, /on the pi backend a provider and model id such as deepseek\/deepseek-chat, for plan, implement, ask and security/);
	assert.match(help.task, /For security: the concern/);
});

test("security alone: fusion describes it on pi, and claude, which runs none of the enabled roles, sends it to fusion", () => {
	const only = input(enabling(["security"], { security: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat" } }));
	const fusion = fusionGuidance(only);
	assert.match(fusion.description, /backend pi runs security on the user's own Pi provider configuration, under security's own contract; role security runs on the pi backend alone/);
	assert.match(fusion.description, /Backend claude and backend codex run no role this session enables\./);
	assert.doesNotMatch(fusion.description, /backend codex runs/);
	const security = fusion.promptGuidelines.find((guideline) => guideline.startsWith("Use fusion with role security only when the user asks"))!;
	assert.match(security, /never on your own judgement that some work looks security-sensitive\. /, "no disabled role is offered in its place");
	assert.match(security, /on deepseek\/deepseek-chat unless the user names another model/);
	assert.ok(fusion.promptGuidelines.some((guideline) => /No enabled fusion role implements a change in this session other than a security fix the user asks for/.test(guideline)));
	const help = fusionParameterHelp(only);
	assert.match(help.backend, /claude, which runs no enabled role, or pi, which runs security/);
	assert.match(help.backend, /codex runs no enabled role\./);
	assert.equal(help.model, "A model instead of the role's configured one: on the pi backend a provider and model id such as deepseek/deepseek-chat, for security. A run keeps its model for later calls that name no model.");

	const claude = claudeGuidance(only);
	assert.match(claude.description, /No role this tool runs is enabled in this session's configuration, so every call is refused/);
	assert.doesNotMatch(claude.description, /security/);
	assert.ok(claude.promptGuidelines.some((guideline) => guideline.startsWith("Role security is enabled in this session but runs only through fusion, on the pi backend; claude does not run it.")));
	const claudeHelp = claudeParameterHelp(only);
	assert.equal(claudeHelp.model, "No role this tool runs is enabled in this session's configuration, so leave it unset.");
});

test("ultracode alone: no parameter a call could tune is offered, and no comparison with role implement is made", () => {
	const only = input(enabling(["ultracode"]));
	for (const [guidance, help] of [[fusionGuidance(only), fusionParameterHelp(only)], [claudeGuidance(only), claudeParameterHelp(only)]] as const) {
		assert.match(guidance.description, /It is slow and costly; use it only when the user asks for it\./);
		assert.doesNotMatch(guidance.description, /costlier than implement/);
		assert.match(help.model, /^No enabled role takes a model in the call: role ultracode runs on its configured model, so leave it unset\.$/);
		assert.match(help.effort, /^No enabled role takes an effort in the call: role ultracode runs at its own fixed effort, so leave it unset\.$/);
		assert.ok(!guidance.promptGuidelines.some((guideline) => /Route section/.test(guideline)), "a Route section comes from role plan, which is disabled");
	}
});

test("mixed backends: claude guidance names the configured pi and codex routes and what a forced claude call runs instead", () => {
	const roles = enabling(KNOWN_ROLE_NAMES, {
		implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" },
		ask: { enabled: true, backend: "codex", model: "gpt-5-codex", effort: "medium" },
		security: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat" },
	});
	const mixed = input(roles);
	const claude = claudeGuidance(mixed);
	assert.match(claude.description, /implement is configured on pi with model deepseek\/deepseek-chat at effort high, and claude runs it on claude with this instance's legacy Claude defaults, model opus at effort high;/);
	assert.match(claude.description, /ask is configured on codex with model gpt-5-codex at effort medium, and claude runs it on claude with this instance's legacy Claude defaults, model opus at effort high\./);
	assert.doesNotMatch(claude.description, /implement runs on claude|ask runs on claude/, "the forced claude run is never presented as the configured route");
	assert.match(claude.description, /plan runs on claude with model fable at effort xhigh;/);
	const guidelines = claude.promptGuidelines.join("\n");
	assert.match(guidelines, /^This session routes role implement to pi\. Use fusion for these roles unless the user explicitly asks for Claude Code/m);
	assert.match(guidelines, /^This session routes role ask to codex\. Use fusion for these roles/m);
	assert.match(guidelines, /^Role ask runs on codex in this session, which fusion runs and claude does not\./m);
	assert.match(guidelines, /call fusion with role implement, one clear, bounded task per call/);
	assert.match(guidelines, /call fusion with role ask;/);
	assert.match(guidelines, /call claude with role plan/);
	assert.match(guidelines, /or this instance's legacy Claude defaults for role implement and role ask, configured on another backend\./);
	assert.match(guidelines, /^Role security is enabled in this session but runs only through fusion/m);
	const claudeHelp = claudeParameterHelp(mixed);
	assert.match(claudeHelp.model, /^plan, implement and ask only: a Claude Code model alias or id instead of the role's configured one, or this instance's legacy Claude default model for implement and ask, configured on another backend\./);

	const fusion = fusionGuidance(mixed);
	assert.match(fusion.description, /implement runs on pi with model deepseek\/deepseek-chat at effort high; ultracode runs on claude with model fable; ask runs on codex with model gpt-5-codex at effort medium; security runs on pi with model deepseek\/deepseek-chat\./);
	assert.ok(fusion.promptGuidelines.some((guideline) => guideline.startsWith("Role ask runs on codex in this session. ")));
	assert.ok(!fusion.promptGuidelines.some((guideline) => /Use fusion for these roles unless/.test(guideline)), "fusion runs every route itself");
});

test("all roles on codex but ultracode and security, both disabled: codex is described without naming them", () => {
	const roles = enabling(["plan", "implement", "ask"], {
		plan: { enabled: true, backend: "codex" },
		implement: { enabled: true, backend: "codex" },
		ask: { enabled: true, backend: "codex" },
	});
	const codex = input(roles);
	const fusion = fusionGuidance(codex);
	assert.match(fusion.description, /backend codex runs plan and implement in a workspace-write sandbox, and ask read-only, under the same contracts, through the user's own codex install, configuration and login; /);
	assert.match(fusion.description, /A codex plan handoff carries the model and effort/);
	const claude = claudeGuidance(codex);
	assert.match(claude.description, /plan is configured on codex with the host's default codex model, and claude runs it on claude with this instance's legacy Claude defaults, model fable at effort xhigh/);
	assert.ok(claude.promptGuidelines.some((guideline) => guideline.startsWith("This session routes role plan, role implement, role ask to codex.")));
	assert.ok(claude.promptGuidelines.some((guideline) => guideline.startsWith("This session's configuration disables role ultracode: a claude call to a disabled role is refused")));
	assert.ok(!claude.promptGuidelines.some((guideline) => /security/.test(guideline)));
});

test("a disabled role's notice is factual: it is refused, and enabling it is the user's choice", () => {
	const roles = input(enabling(["implement", "ask"]));
	for (const guidance of [fusionGuidance(roles), claudeGuidance(roles)]) {
		const notice = guidance.promptGuidelines.find((guideline) => /disables role plan, role ultracode/.test(guideline));
		assert.ok(notice);
		assert.match(notice, /a (fusion|claude) call to a disabled role is refused, whether it starts a run or continues one, so do not call one\. Whether to enable one is the user's choice, through \/fusion config or another profile\.$/);
		assert.ok(!guidance.promptGuidelines.some((guideline) => /design question/.test(guideline)), "where a design question goes is the policy's");
	}
});

test("the user-choice guideline offers model and effort overrides only for roles that take them, never for ultracode", () => {
	const refused = /call for role ultracode takes no model or effort, and one that names either is refused: role ultracode runs on its configured model at its fixed ultracode effort, so leave both unset for it, and tell the user so when they name one\.$/;
	const choiceOf = (guidance: ToolGuidance): string => guidance.promptGuidelines.find((guideline) => /choice wins/.test(guideline))!;

	const only = input(enabling(["ultracode"]));
	const fusionOnly = choiceOf(fusionGuidance(only));
	assert.equal(
		fusionOnly,
		"The user's explicit choice wins over these fusion guidelines, including asking for role ultracode. A backend the user names goes in fusion's backend parameter; otherwise leave it unset, which runs the role on this session's configured backend. A fusion call for role ultracode takes no model or effort, and one that names either is refused: role ultracode runs on its configured model at its fixed ultracode effort, so leave both unset for it, and tell the user so when they name one.",
	);
	const claudeOnly = choiceOf(claudeGuidance(only));
	assert.equal(
		claudeOnly,
		"The user's explicit choice wins over these claude guidelines, including asking for role ultracode. A claude call for role ultracode takes no model or effort, and one that names either is refused: role ultracode runs on its configured model at its fixed ultracode effort, so leave both unset for it, and tell the user so when they name one.",
	);
	for (const choice of [fusionOnly, claudeOnly]) assert.doesNotMatch(choice, /model or effort the user names/, "no override the binding refuses is offered");

	// Mixed: implement on pi beside ultracode on claude, so the role a call names may be either.
	const mixed = input(enabling(["implement", "ultracode"], { implement: { enabled: true, backend: "pi", model: "deepseek/deepseek-chat", effort: "high" } }));
	const fusionMixed = choiceOf(fusionGuidance(mixed));
	assert.match(fusionMixed, /A backend the user names goes in fusion's backend parameter, and a model or effort the user names goes in its model or effort parameter for role implement; otherwise leave them unset/);
	assert.match(fusionMixed, refused);
	const claudeMixed = choiceOf(claudeGuidance(mixed));
	assert.match(claudeMixed, /For an explicit claude call for role implement, put a model or effort the user names in its model or effort parameter; otherwise leave both unset to use the role's configured Claude settings, or this instance's legacy Claude defaults for role implement, configured on another backend\./);
	assert.match(claudeMixed, refused);

	// And without ultracode the override stays unrestricted, as every enabled role takes one.
	const noUltracode = input(enabling(["plan", "implement", "ask"]));
	assert.match(choiceOf(fusionGuidance(noUltracode)), /A backend, model or effort the user names goes in fusion's backend, model or effort parameter; otherwise leave all three unset/);
	assert.match(choiceOf(claudeGuidance(noUltracode)), /For an explicit claude call, put a model or effort the user names in its model or effort parameter;/);
});

test("the host policy is one guideline, the same in both tools, with its Markdown unchanged after a lead that names no role or tool", () => {
	const typed = "---\ntitle: x\n---\n# Mine\n\n{{role}} ${tool} <!-- include: a.md --> stays as typed.\n\n";
	const configuration = { ...input(enabling(KNOWN_ROLE_NAMES)), policy: typed };
	const carried = [fusionGuidance(configuration), claudeGuidance(configuration)].map((guidance) => guidance.promptGuidelines.filter((guideline) => guideline.includes(typed)));
	assert.deepEqual(carried, [[policyGuideline(typed)], [policyGuideline(typed)]]);
	const lead = policyGuideline(typed).slice(0, -typed.length);
	assert.ok(lead.endsWith("\n\n") && lead.startsWith("Host policy: "));
	assert.doesNotMatch(lead, /\b(plan|implement|ultracode|ask|security|fusion|claude|delegate)\b/, "the lead is role- and tool-neutral; Fusion is the product, fusion the tool");
	// Before the instance has loaded it, both tools say so in its place, and say no call runs without it.
	const pending = { ...configuration, policy: undefined };
	for (const guidance of [fusionGuidance(pending), claudeGuidance(pending)]) {
		assert.equal(guidance.promptGuidelines[1], policyGuideline(undefined));
		assert.match(guidance.promptGuidelines[1]!, /^Host policy: not loaded yet in this Fusion instance\. A Fusion call waits for it and is refused, before anything starts, when it cannot be loaded\.$/);
	}
});

test("a policy that stages ultracode work is carried by both tools beside no generated whole-plan mandate, and ultracode's facts stay", () => {
	const staged = "# Staged\n\nWhen the user asks for ultracode, give it one stage of the agreed plan per call and check each stage before the next.\n";
	for (const enabled of [["plan", "implement", "ultracode", "ask"], ["plan", "ultracode"], ["ultracode"]] as KnownRoleName[][]) {
		const configuration = { ...input(enabling(enabled)), policy: staged };
		for (const [name, guidance] of [["fusion", fusionGuidance(configuration)], ["claude", claudeGuidance(configuration)]] as const) {
			const label = `${name} with ${enabled.join(", ")}`;
			assert.deepEqual(guidance.promptGuidelines.filter((guideline) => guideline.includes(staged)), [policyGuideline(staged)], `${label}: the staging policy, once and unchanged`);
			const own = guidance.promptGuidelines.filter((guideline) => guideline !== policyGuideline(staged));
			for (const guideline of own) assert.doesNotMatch(guideline, /in one call|whole (agreed plan|task)|one stage/, `${label}: the generated text decides how ultracode work is split: ${guideline}`);
			const ultracode = own.find((guideline) => guideline.includes(`Use ${name} with role ultracode only when the user explicitly asks for ultracode`));
			assert.ok(ultracode, `${label}: ultracode stays explicit-only`);
			assert.match(ultracode, /Review section is a self-review by agents it briefed, not an independent review/, label);
			assert.match(ultracode, /runs its agents one at a time so builds and tests do not overlap/, label);
			assert.equal(/even when a Route section recommends it/.test(ultracode), enabled.includes("plan"), `${label}: a Route section does not authorize it`);
			assert.ok(own.some((guideline) => /call for role ultracode takes no model or effort, and one that names either is refused/.test(guideline)), `${label}: its parameter restriction`);
		}
	}
});
