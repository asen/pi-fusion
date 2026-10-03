import { type BackendName, isBackendName, isPiModel, PI_EFFORTS } from "./backends/types.ts";
import { KNOWN_ROLE_NAMES, type KnownRoleName, ROLE_SPECS } from "./roles.ts";

/**
 * What a session runs each role as: whether the role may start or continue a run, the backend a fresh run goes to,
 * and the model and effort that backend runs it with. This module is pure: it reads no file, starts nothing and asks
 * no provider whether a model exists. Where a configuration is stored is `profile-store.ts`'s, and which backend can
 * run a role at all is `roles.ts`'s, which this checks a backend against rather than repeating.
 */

/** Claude Code's effort levels, which every Claude role but ultracode takes. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The one effort ultracode runs at: xhigh plus the standing workflow opt-in, so no other level is a choice for it. */
export const ULTRACODE_EFFORT = "ultracode";

/** The name the built-in defaults go by. It is never a stored profile, so it can be neither saved over nor deleted. */
export const BUILTIN = "builtin";

/** What a profile may be called: plain, case-sensitive and short enough to type. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The version of the profiles file this build reads and writes. */
export const PROFILES_VERSION = 1;

export interface RoleSetting {
	enabled: boolean;
	backend: BackendName;
	/** A Claude alias or id, or a Pi provider and model id. Absent is an unconfigured Pi role, refused when called. */
	model?: string;
	/** Absent leaves a Pi child its own default level; ultracode's is always `ultracode`. */
	effort?: string;
}

export type RoleSettings = Record<KnownRoleName, RoleSetting>;

/** A model and effort one backend runs a role with when nothing else names them. */
export interface Selection {
	model?: string;
	effort?: string;
}

/**
 * The legacy defaults this extension instance started with, per role and per backend: Claude's from its role
 * variables and built-in models, Pi's from `PI_FUSION_PI_<ROLE>_MODEL` and `_EFFORT`. It is captured once, so a call
 * that names the other backend than the configured one gets the same answer for the life of the instance.
 */
export type Baseline = Record<KnownRoleName, Partial<Record<BackendName, Selection>>>;

const trimmed = (env: NodeJS.ProcessEnv, key: string): string | undefined => env[key]?.trim() || undefined;

/** The legacy defaults, read from a copy of the environment once and kept. */
export function captureBaseline(env: NodeJS.ProcessEnv = process.env): Baseline {
	const pi = (role: string): Selection => {
		const model = trimmed(env, `PI_FUSION_PI_${role.toUpperCase()}_MODEL`);
		const effort = trimmed(env, `PI_FUSION_PI_${role.toUpperCase()}_EFFORT`);
		return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
	};
	return {
		plan: { claude: { model: trimmed(env, "PI_FUSION_PLAN_MODEL") ?? "fable", effort: "xhigh" }, pi: pi("plan") },
		implement: { claude: { model: trimmed(env, "PI_FUSION_IMPLEMENT_MODEL") ?? "opus", effort: trimmed(env, "PI_FUSION_IMPLEMENT_EFFORT") ?? "high" }, pi: pi("implement") },
		ultracode: { claude: { model: trimmed(env, "PI_FUSION_ULTRACODE_MODEL") ?? "fable", effort: ULTRACODE_EFFORT } },
		ask: { claude: { model: trimmed(env, "PI_FUSION_ASK_MODEL") ?? "opus", effort: trimmed(env, "PI_FUSION_ASK_EFFORT") ?? "high" }, pi: pi("ask") },
		security: { pi: pi("security") },
	};
}

/** The backend a role goes to when nothing names one: the sole backend it runs on, or Claude. */
export const defaultBackend = (role: KnownRoleName): BackendName => {
	const backends = ROLE_SPECS[role].backends;
	return backends.length === 1 ? backends[0]! : "claude";
};

/** The built-in role defaults: security is opt-in; model and effort defaults come from the captured baseline. */
export function builtinSettings(baseline: Baseline): RoleSettings {
	const settings = {} as RoleSettings;
	for (const role of KNOWN_ROLE_NAMES) {
		const backend = defaultBackend(role);
		settings[role] = { enabled: role !== "security", backend, ...copySelection(baseline[role][backend]) };
	}
	return settings;
}

const copySelection = (selection: Selection | undefined): Selection => ({
	...(selection?.model === undefined ? {} : { model: selection.model }),
	...(selection?.effort === undefined ? {} : { effort: selection.effort }),
});

/** A copy nothing else holds, so editing one configuration never reaches another or a run that was admitted with it. */
export function copySettings(settings: RoleSettings): RoleSettings {
	const copy = {} as RoleSettings;
	for (const role of KNOWN_ROLE_NAMES) copy[role] = { enabled: settings[role].enabled, backend: settings[role].backend, ...copySelection(settings[role]) };
	return copy;
}

export function sameSettings(one: RoleSettings, other: RoleSettings): boolean {
	return KNOWN_ROLE_NAMES.every((role) => {
		const a = one[role];
		const b = other[role];
		return a.enabled === b.enabled && a.backend === b.backend && a.model === b.model && a.effort === b.effort;
	});
}

/** The efforts a role takes on a backend, or none for ultracode, whose one level is not a choice. */
export function effortsFor(role: KnownRoleName, backend: BackendName): readonly string[] {
	if (role === "ultracode") return [];
	return backend === "claude" ? CLAUDE_EFFORTS : PI_EFFORTS;
}

const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(value) : String(value));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const ROLE_FIELDS = new Set(["enabled", "backend", "model", "effort"]);

/** One role's setting, checked whole, or an error naming the field that is wrong and where it is. */
function roleSetting(role: KnownRoleName, value: unknown, where: string): RoleSetting {
	if (!isRecord(value)) throw new Error(`${where} must be an object`);
	for (const key of Object.keys(value)) if (!ROLE_FIELDS.has(key)) throw new Error(`${where} has unknown field ${JSON.stringify(key)}; use enabled, backend, model and effort`);
	if (typeof value.enabled !== "boolean") throw new Error(`${where}.enabled must be true or false`);
	if (!isBackendName(value.backend)) throw new Error(`${where}.backend must be claude or pi`);
	const backend = value.backend;
	const runs = ROLE_SPECS[role].backends;
	if (!runs.includes(backend)) throw new Error(`${where}.backend is ${backend}, but role ${role} runs on ${runs.join(", ")} only`);
	const setting: RoleSetting = { enabled: value.enabled, backend };
	if (value.model !== undefined) {
		// A blank model is a mistake rather than a way of saying none: leaving the field out is how a role has none.
		if (typeof value.model !== "string" || !value.model.trim()) throw new Error(`${where}.model must be a non-empty string; leave it out instead`);
		if (value.model !== value.model.trim()) throw new Error(`${where}.model ${shown(value.model)} has spaces around it`);
		if (backend === "pi" && !isPiModel(value.model)) throw new Error(`${where}.model ${shown(value.model)} is not a pi provider and model id such as deepseek/deepseek-chat`);
		setting.model = value.model;
	}
	if (value.effort !== undefined) {
		if (role === "ultracode") {
			if (value.effort !== ULTRACODE_EFFORT) throw new Error(`${where}.effort must be ${ULTRACODE_EFFORT} or left out: role ultracode runs at no other level`);
		} else if (typeof value.effort !== "string" || !effortsFor(role, backend).includes(value.effort)) {
			throw new Error(`${where}.effort ${shown(value.effort)} is not a ${backend} effort; use one of ${effortsFor(role, backend).join(", ")}`);
		}
		setting.effort = value.effort;
	}
	// A disabled role needs nothing more than its flag and a backend: it starts nothing, so nothing has to be chosen for it.
	// An enabled Claude role runs on a model and an effort it names, because a profile never borrows a variable's.
	// An enabled Pi role may name no model: that is an unconfigured role, refused when it is called, never guessed for.
	if (setting.enabled && backend === "claude") {
		if (setting.model === undefined) throw new Error(`${where} is enabled on claude and names no model`);
		if (role !== "ultracode" && setting.effort === undefined) throw new Error(`${where} is enabled on claude and names no effort`);
	}
	return setting;
}

/** A complete configuration, every known role in it and nothing else, or an error naming what is wrong. */
export function parseSettings(value: unknown, where = "roles"): RoleSettings {
	if (!isRecord(value)) throw new Error(`${where} must be an object`);
	for (const key of Object.keys(value)) {
		if (!(KNOWN_ROLE_NAMES as readonly string[]).includes(key)) throw new Error(`${where} has unknown role ${JSON.stringify(key)}; use ${KNOWN_ROLE_NAMES.join(", ")}`);
	}
	const settings = {} as RoleSettings;
	for (const role of KNOWN_ROLE_NAMES) {
		if (!(role in value)) throw new Error(`${where} has no ${role} role; a profile names all of ${KNOWN_ROLE_NAMES.join(", ")}`);
		settings[role] = roleSetting(role, value[role], `${where}.${role}`);
	}
	return settings;
}

/** Why a profile name cannot be used, or undefined when it can. */
export function nameProblem(name: string): string | undefined {
	if (name === BUILTIN) return `${BUILTIN} is the built-in configuration and cannot be saved over`;
	if (!PROFILE_NAME.test(name)) return `profile name ${shown(name)} must start with a letter or digit and use only letters, digits, dots, dashes and underscores, at most 64 characters`;
	return undefined;
}

/** The whole profiles file: its version, the profile future sessions start with, and the profiles by name. */
export interface ProfileDocument {
	version: typeof PROFILES_VERSION;
	/** The profile a new extension instance loads, or null for the built-in configuration. */
	defaultProfile: string | null;
	profiles: Record<string, RoleSettings>;
}

export const emptyDocument = (): ProfileDocument => ({ version: PROFILES_VERSION, defaultProfile: null, profiles: {} });

const DOCUMENT_FIELDS = new Set(["version", "defaultProfile", "profiles"]);

/**
 * The profiles file as this build reads it, or an error naming what is wrong. A default that names a profile the file
 * does not hold is not an error of the file: it is read, and whoever loads the default says it is missing.
 */
export function parseDocument(value: unknown): ProfileDocument {
	if (!isRecord(value)) throw new Error("the file must hold a JSON object");
	for (const key of Object.keys(value)) if (!DOCUMENT_FIELDS.has(key)) throw new Error(`the file has unknown field ${JSON.stringify(key)}`);
	if (value.version !== PROFILES_VERSION) throw new Error(`the file has version ${shown(value.version)}, and this build reads version ${PROFILES_VERSION} only`);
	const defaultProfile = value.defaultProfile ?? null;
	if (defaultProfile !== null) {
		if (typeof defaultProfile !== "string") throw new Error("defaultProfile must be a profile name or null");
		const problem = nameProblem(defaultProfile);
		if (problem) throw new Error(`defaultProfile: ${problem}; use null for ${BUILTIN}`);
	}
	const profiles: Record<string, RoleSettings> = {};
	const stored = value.profiles ?? {};
	if (!isRecord(stored)) throw new Error("profiles must be an object of profiles by name");
	for (const [name, profile] of Object.entries(stored)) {
		const problem = nameProblem(name);
		if (problem) throw new Error(`profiles: ${problem}`);
		if (!isRecord(profile)) throw new Error(`profiles.${name} must be an object`);
		for (const key of Object.keys(profile)) if (key !== "roles") throw new Error(`profiles.${name} has unknown field ${JSON.stringify(key)}; a profile holds roles alone`);
		profiles[name] = parseSettings(profile.roles, `profiles.${name}.roles`);
	}
	return { version: PROFILES_VERSION, defaultProfile, profiles };
}

/** The document as it is written: every profile under its roles, in the order a reader expects to find the fields. */
export function serializeDocument(document: ProfileDocument): string {
	const profiles: Record<string, { roles: RoleSettings }> = {};
	for (const name of Object.keys(document.profiles).sort()) profiles[name] = { roles: copySettings(document.profiles[name]!) };
	return `${JSON.stringify({ version: PROFILES_VERSION, defaultProfile: document.defaultProfile, profiles }, null, 2)}\n`;
}

/** The effort a role's setting runs at, as a person reads it: ultracode's fixed one, or what the setting names. */
export const effortShown = (role: KnownRoleName, setting: RoleSetting): string =>
	role === "ultracode" ? `${ULTRACODE_EFFORT} (fixed)` : (setting.effort ?? (setting.backend === "pi" ? "child default" : "none"));

/** One line per role, in columns: what `/fusion config` shows and what the editor offers to change. */
export function settingsTable(settings: RoleSettings): string[] {
	const rows = [["role", "enabled", "backend", "model", "effort"]];
	for (const role of KNOWN_ROLE_NAMES) {
		const setting = settings[role];
		rows.push([role, setting.enabled ? "yes" : "no", setting.backend, setting.model ?? "unconfigured", effortShown(role, setting)]);
	}
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
	return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join("  "));
}
