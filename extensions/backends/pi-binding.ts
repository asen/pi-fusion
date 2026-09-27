import { isPiModel, PI_EFFORTS, type ResolvedSelection } from "./types.ts";

/**
 * What a role runs as on the Pi backend: the model and thinking level a call resolves to, and the contract that role
 * has always run under. This is a binding, not an execution adapter: nothing here starts a child, reads a provider
 * configuration or knows Pi's protocol. Which models exist and which thinking levels one of them offers is the
 * adapter's check against the child; this module only settles what the call asks for and refuses what it cannot.
 */

/** A Pi child's role. `effort` is absent when nothing named one, which leaves the child its own default. */
export interface PiRole {
	name: string;
	/** A provider and a model id, such as `deepseek/deepseek-chat`. There is no default: a call without one is refused. */
	model: string;
	effort?: string;
	contract: string;
	mode?: PiMode;
}

/** The roles this build binds on Pi. `security` is metadata until it has a contract and a binding of its own. */
export const PI_ROLE_NAMES = ["plan", "implement", "ask"] as const;
export type PiRoleName = (typeof PI_ROLE_NAMES)[number];

export const PI_MODES = ["answer", "review"] as const;
export type PiMode = (typeof PI_MODES)[number];

/** The contracts a Pi role runs under: the same prose the Claude roles run under, named here as metadata and no more. */
const PI_CONTRACTS: Record<PiRoleName, string> = { plan: "plan.md", implement: "implement.md", ask: "ask-answer.md" };
const PI_ASK_CONTRACTS: Record<PiMode, string> = { answer: "ask-answer.md", review: "ask-review.md" };

/** The call parameters each Pi role takes. Unlike Claude, every Pi role takes a model, because none of them has one. */
const PI_ROLE_PARAMETERS: Record<"fresh" | "mode" | "model" | "effort", readonly PiRoleName[]> = {
	fresh: ["plan"],
	mode: ["ask"],
	model: ["plan", "implement", "ask"],
	effort: ["plan", "implement", "ask"],
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
interface Chosen {
	value: string;
	from: string;
}

const chosen = (field: "model" | "effort", call: string | undefined, recorded: string | undefined, variable: string, env: NodeJS.ProcessEnv): Chosen | undefined => {
	if (call !== undefined) {
		const named = call.trim();
		// A call that names the field and leaves it blank is a mistake, not permission to choose something else for it:
		// falling through would run a model or a level the call did not ask for and did not see.
		if (!named) throw new Error(`the call names an empty ${field} for the pi backend; name one or leave the ${field} parameter out to take the recorded or configured value`);
		return { value: named, from: "the call" };
	}
	// The selection the run actually ran with wins over a variable that has changed since, so a continuation repeats it.
	if (recorded) return { value: recorded, from: "the selection the run it continues ran with" };
	const configured = env[variable]?.trim();
	return configured ? { value: configured, from: variable } : undefined;
};

/**
 * The Pi role a call runs, with the model and thinking level it resolved to: the call's own override first, then the
 * selection the run it continues actually ran with, then the role's configured default. A model is required from one
 * of those three, because Pi has no model of its own to fall back on and this host guesses none. A level is not: a
 * first call that names none leaves the child its own default, and the child reports back what that was.
 */
export function piRole(call: PiCall, recorded?: ResolvedSelection, env: NodeJS.ProcessEnv = process.env): PiRole {
	const { name, mode } = piParams(call);
	const variable = piModelVariable(name);
	const model = chosen("model", call.model, recorded?.model, variable, env);
	if (!model) {
		throw new Error(
			`role ${name} has no model for the pi backend: set ${variable} to a provider and a model id, such as deepseek/deepseek-chat, or name one in the call's model parameter. The pi backend has no default model and resolves none for you`,
		);
	}
	if (!isPiModel(model.value)) throw new Error(`${model.from} names model ${JSON.stringify(model.value)}, which is not a pi provider and model id such as deepseek/deepseek-chat`);
	const effort = chosen("effort", call.effort, recorded?.effort, piEffortVariable(name), env);
	if (effort && !(PI_EFFORTS as readonly string[]).includes(effort.value)) {
		throw new Error(`${effort.from} names effort ${JSON.stringify(effort.value)}, which is not a pi thinking level; use one of ${PI_EFFORTS.join(", ")}`);
	}
	return {
		name,
		model: model.value,
		...(effort ? { effort: effort.value } : {}),
		contract: name === "ask" ? PI_ASK_CONTRACTS[mode] : PI_CONTRACTS[name],
		...(name === "ask" ? { mode } : {}),
	};
}
