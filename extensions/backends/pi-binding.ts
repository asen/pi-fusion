import { isPiModel, PI_EFFORTS, type ResolvedSelection } from "./types.ts";

/**
 * What a role runs as on the Pi backend: the model and thinking level a call resolves to, the contract that role has
 * always run under, and the tools and resources the role is made of. This is a binding, not an execution adapter:
 * nothing here starts a child, reads a provider configuration or knows Pi's protocol, and the lists it hands back are
 * plain names and plain paths — nothing is resolved against a directory, looked up on disk or fetched from anywhere.
 * Which models exist and which thinking levels one of them offers is the adapter's check against the child; this
 * module only settles what the call asks for and refuses what it cannot.
 */

/** A Pi child's role. `effort` is absent when nothing named one, which leaves the child its own default. */
export interface PiRole {
	name: string;
	/** A provider and a model id, such as `deepseek/deepseek-chat`. There is no default: a call without one is refused. */
	model: string;
	effort?: string;
	contract: string;
	mode?: PiMode;
	/** The tools this role's child runs with, as Pi names its own. Explicit: a role with no list gets none guessed for it. */
	tools: string[];
	/**
	 * The local resources this role adds, as the call names them and no more: this build's roles name none, and a path
	 * here is neither resolved nor read. What a composed path may be, and which forms are refused, is `pi-launch.ts`'s.
	 */
	extensions: string[];
	skills: string[];
}

/** The roles this build binds on Pi, `security` included: it runs here and on no other backend. */
export const PI_ROLE_NAMES = ["plan", "implement", "ask", "security"] as const;
export type PiRoleName = (typeof PI_ROLE_NAMES)[number];

export const PI_MODES = ["answer", "review"] as const;
export type PiMode = (typeof PI_MODES)[number];

/**
 * The tools each role's child runs with, as Pi names its own. `ask` reads, searches and runs commands and has no edit
 * or write tool at all, which is what a review and an answer need; `plan` and `implement` get the standard coding set,
 * the same shape their Claude bindings have always had. `security` gets that same set rather than a read-only one,
 * because the role investigates and, when its task authorizes one, writes the fix: whether it may change application
 * code is its contract's rule and the task's, and not a tool this binding takes away from a job that needs it.
 */
const PI_ROLE_TOOLS: Record<PiRoleName, readonly string[]> = {
	plan: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	implement: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	ask: ["read", "bash", "grep", "find", "ls"],
	security: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/**
 * The local resources each role adds. Empty for every role in this build, and named here rather than left out so that
 * enabling one is an edit to a role's own metadata: a child loads the resources its role names and discovers none.
 */
const PI_ROLE_RESOURCES: Record<PiRoleName, { extensions: readonly string[]; skills: readonly string[] }> = {
	plan: { extensions: [], skills: [] },
	implement: { extensions: [], skills: [] },
	ask: { extensions: [], skills: [] },
	security: { extensions: [], skills: [] },
};

/**
 * The contracts a Pi role runs under: the same prose the Claude roles run under, named here as metadata and no more.
 * `security` runs on no other backend, so its contract is one no Claude role names.
 */
const PI_CONTRACTS: Record<PiRoleName, string> = { plan: "plan.md", implement: "implement.md", ask: "ask-answer.md", security: "security.md" };
const PI_ASK_CONTRACTS: Record<PiMode, string> = { answer: "ask-answer.md", review: "ask-review.md" };

/**
 * Every contract file a Pi role can run under, the ask modes included: what the extension checks is there at load, so
 * a contract only Pi names is as much a broken install as one a Claude role names. Names and no paths, like the rest
 * of this module: where the contracts live is the host's.
 */
export const PI_CONTRACT_FILES: readonly string[] = [...new Set([...Object.values(PI_CONTRACTS), ...Object.values(PI_ASK_CONTRACTS)])];

/** The call parameters each Pi role takes. Unlike Claude, every Pi role takes a model, because none of them has one. */
const PI_ROLE_PARAMETERS: Record<"fresh" | "mode" | "model" | "effort", readonly PiRoleName[]> = {
	fresh: ["plan"],
	mode: ["ask"],
	model: ["plan", "implement", "ask", "security"],
	effort: ["plan", "implement", "ask", "security"],
};

/** What a call asks of a Pi role: the role it names, an ask run's mode, and the selection it overrides. */
export interface PiCall {
	role: string;
	mode?: string;
	model?: string;
	effort?: string;
	fresh?: boolean;
}

/** The variables that configure a role's Pi binding. There is no shared default model and no shared default level. */
export const piModelVariable = (role: string): string => `PI_FUSION_PI_${role.toUpperCase()}_MODEL`;
export const piEffortVariable = (role: string): string => `PI_FUSION_PI_${role.toUpperCase()}_EFFORT`;

const isPiRoleName = (role: string): role is PiRoleName => (PI_ROLE_NAMES as readonly string[]).includes(role);

/**
 * The role and mode a Pi call names, or an error naming what the role cannot take. This is the parameter half of the
 * binding: it settles nothing about a model, so a call can be refused for its parameters before anything asks whether
 * this build can run Pi at all.
 */
export function piParams(call: PiCall): { name: PiRoleName; mode: PiMode } {
	if (!isPiRoleName(call.role)) throw new Error(`role ${call.role} does not run on the pi backend; use one of ${PI_ROLE_NAMES.join(", ")}`);
	const name = call.role;
	for (const [parameter, roles] of Object.entries(PI_ROLE_PARAMETERS)) {
		if (call[parameter as keyof PiCall] !== undefined && !roles.includes(name)) throw new Error(`${parameter} is not allowed for role ${name}`);
	}
	if (call.mode !== undefined && !(PI_MODES as readonly string[]).includes(call.mode)) throw new Error(`unknown mode ${call.mode}; use one of ${PI_MODES.join(", ")}`);
	return { name, mode: (call.mode ?? "answer") as PiMode };
}

/** Where a field of the selection came from, so a value this host will not use says which setting to correct. */
export interface Chosen {
	value: string;
	from: string;
}

const chosen = (field: "model" | "effort", call: string | undefined, recorded: string | undefined, configured: Chosen | undefined): Chosen | undefined => {
	if (call !== undefined) {
		const named = call.trim();
		// A call that names the field and leaves it blank is a mistake, not permission to choose something else for it:
		// falling through would run a model or a level the call did not ask for and did not see.
		if (!named) throw new Error(`the call names an empty ${field} for the pi backend; name one or leave the ${field} parameter out to take the recorded or configured value`);
		return { value: named, from: "the call" };
	}
	// The selection the run actually ran with wins over a configuration that has changed since, so a continuation repeats it.
	if (recorded) return { value: recorded, from: "the selection the run it continues ran with" };
	return configured;
};

/**
 * What a role falls back on when neither the call nor the run it continues names a field: each value with the setting
 * it came from, so a value this binding refuses says what to correct, and the sentence a call with no model gets.
 */
export interface PiFallback {
	model?: Chosen;
	effort?: Chosen;
	missing: string;
}

/** The fallback the role's own variables are, which is what a host that passes no configuration gets. */
export function variableFallback(role: string, env: NodeJS.ProcessEnv = process.env): PiFallback {
	const model = env[piModelVariable(role)]?.trim();
	const effort = env[piEffortVariable(role)]?.trim();
	return {
		...(model ? { model: { value: model, from: piModelVariable(role) } } : {}),
		...(effort ? { effort: { value: effort, from: piEffortVariable(role) } } : {}),
		missing: `role ${role} has no model for the pi backend: set ${piModelVariable(role)} to a provider and a model id, such as deepseek/deepseek-chat, or name one in the call's model parameter. The pi backend has no default model and resolves none for you`,
	};
}

/**
 * The Pi role a call runs, with the model and thinking level it resolved to: the call's own override first, then the
 * selection the run it continues actually ran with, then the fallback — the session's configuration, or the role's
 * own variables when the caller passes none. A model is required from one of those, because Pi has no model of its
 * own to fall back on and this host guesses none. A level is not: a first call that names none leaves the child its
 * own default, and the child reports back what that was.
 */
export function piRole(call: PiCall, recorded?: ResolvedSelection, env: NodeJS.ProcessEnv = process.env, fallback?: PiFallback): PiRole {
	const { name, mode } = piParams(call);
	const base = fallback ?? variableFallback(name, env);
	const model = chosen("model", call.model, recorded?.model, base.model);
	if (!model) throw new Error(base.missing);
	if (!isPiModel(model.value)) throw new Error(`${model.from} names model ${JSON.stringify(model.value)}, which is not a pi provider and model id such as deepseek/deepseek-chat`);
	const effort = chosen("effort", call.effort, recorded?.effort, base.effort);
	if (effort && !(PI_EFFORTS as readonly string[]).includes(effort.value)) {
		throw new Error(`${effort.from} names effort ${JSON.stringify(effort.value)}, which is not a pi thinking level; use one of ${PI_EFFORTS.join(", ")}`);
	}
	// Each field is copied out of the tables, so nothing a caller does to the lists it gets back reaches the next call.
	return {
		name,
		model: model.value,
		...(effort ? { effort: effort.value } : {}),
		contract: name === "ask" ? PI_ASK_CONTRACTS[mode] : PI_CONTRACTS[name],
		...(name === "ask" ? { mode } : {}),
		tools: [...PI_ROLE_TOOLS[name]],
		extensions: [...PI_ROLE_RESOURCES[name].extensions],
		skills: [...PI_ROLE_RESOURCES[name].skills],
	};
}
