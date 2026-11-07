import { parse } from "yaml";
import { type BackendName, isBackendName } from "./backends/types.ts";
import type { KnownRoleName } from "./roles.ts";

/** Static role prose for the host; runtime capabilities and settings are supplied separately. */
export interface RoleGuidance {
	description: string;
	guidance: string[];
	task_brief: string;
	snippet: string;
}

export type RoleGuidanceMap = Record<KnownRoleName, RoleGuidance>;

/**
 * A contract's startup defaults for its role: the backend a fresh configuration starts the role on, and optionally the
 * model and effort it overlays on that backend's legacy defaults. Which values a role and backend accept is checked by
 * the host's loader, which knows the role; this shape alone is the parser's.
 */
export interface ContractDefaults {
	backend: BackendName;
	model?: string;
	effort?: string;
}

export interface ParsedRoleContract {
	body: string;
	host?: RoleGuidance;
	/** Present only when the header says `disabled: true`: the role is unavailable for this instance's life. */
	disabled?: true;
	defaults?: ContractDefaults;
	/** Present only when `implement.md` says `claudeWebTools: true`: a Claude implement child also gets WebSearch and WebFetch. */
	claudeWebTools?: true;
}

/** The one contract file that may carry `claudeWebTools`: the Claude tool lists of every other role are fixed. */
const WEB_TOOLS_CONTRACT = "implement.md";

const HEADER_FIELDS = new Set(["host", "disabled", "defaults", "claudeWebTools"]);
const HOST_FIELDS = new Set(["description", "guidance", "task_brief", "snippet"]);
const DEFAULT_FIELDS = new Set(["backend", "model", "effort"]);

/**
 * Split host-only YAML from child instructions, leaving contracts without a header unchanged. Only `host`, `disabled`,
 * `defaults` and, on `implement.md`, `claudeWebTools` may appear at the top, so a misspelt availability key is refused
 * rather than read as an available role; a disabled contract may have no child body, every other one must have a
 * nonblank one. `name` is the contract file this text is, never guessed from `source`, which only labels diagnostics:
 * it decides the mode contract's owner and whether the web-tools switch is allowed, so text of unknown identity has none.
 */
export function parseRoleContract(text: string, source: string, name?: string): ParsedRoleContract {
	if (!/^---\r?\n/.test(text)) return { body: text };
	const owner = name === undefined ? undefined : contractOwner(name);
	const fail = (why: string): never => { throw new Error(`pi-fusion: invalid role contract ${source}: ${why}`); };
	const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!header) return fail("unterminated frontmatter");
	let metadata: unknown;
	try {
		metadata = parse(header[1]!, { logLevel: "error" });
	} catch {
		// YAML diagnostics quote source lines; config and startup warnings must not print contract contents.
		return fail("invalid YAML");
	}
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fail("host must be an object");
	// Diagnostics name the category, never the key or value as written: they reach warnings and /fusion config.
	for (const key of Object.keys(metadata)) if (!HEADER_FIELDS.has(key)) fail("unknown frontmatter field; use only host, disabled, defaults and, on implement.md, claudeWebTools");
	const top = metadata as Record<string, unknown>;
	const host = top.host;
	if (!host || typeof host !== "object" || Array.isArray(host)) return fail("host must be an object");
	const fields = host as Record<string, unknown>;
	// A `disabled`, `defaults` or `claudeWebTools` placed under host would otherwise be ignored as if it said nothing.
	for (const key of Object.keys(fields)) if (!HOST_FIELDS.has(key)) fail("host has an unknown field; use only description, guidance, task_brief and snippet, and put disabled, defaults and claudeWebTools at the top level");
	for (const field of ["description", "task_brief", "snippet"] as const) {
		if (typeof fields[field] !== "string" || !fields[field].trim()) return fail(`host.${field} must be nonblank text`);
	}
	if (!Array.isArray(fields.guidance) || !fields.guidance.every((line) => typeof line === "string" && line.trim())) return fail("host.guidance must be a list of nonblank text");
	// A mode contract runs as its role, so only the role's own file may say whether the role exists and where it starts.
	if (owner !== undefined && (top.disabled !== undefined || top.defaults !== undefined)) return fail(`disabled and defaults belong to ${owner}, which decides this mode's role`);
	if (top.disabled !== undefined && typeof top.disabled !== "boolean") return fail("disabled must be true or false");
	const disabled = top.disabled === true;
	const defaults = top.defaults === undefined ? undefined : contractDefaults(top.defaults, fail);
	// Even `false` is refused elsewhere: a file that names the switch where it does nothing reads as if it did.
	if (top.claudeWebTools !== undefined && name !== WEB_TOOLS_CONTRACT) return fail(`claudeWebTools belongs to ${WEB_TOOLS_CONTRACT} only`);
	if (top.claudeWebTools !== undefined && typeof top.claudeWebTools !== "boolean") return fail("claudeWebTools must be true or false");
	const web = top.claudeWebTools === true;
	const body = text.slice(header[0].length).replace(/^\r?\n/, "");
	if (!disabled && !body.trim()) return fail("child instructions are blank");
	return { body, host: fields as unknown as RoleGuidance, ...(disabled ? { disabled: true as const } : {}), ...(defaults ? { defaults } : {}), ...(web ? { claudeWebTools: true as const } : {}) };
}

/** The shape of `defaults`: a backend whenever a model or effort is named, and nothing a reader would have to guess at. */
function contractDefaults(value: unknown, fail: (why: string) => never): ContractDefaults {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail("defaults must be an object");
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) if (!DEFAULT_FIELDS.has(key)) fail("defaults has an unknown field; use only backend, model and effort");
	if (fields.backend === undefined) return fail("defaults.backend is required; a model or effort belongs to one backend");
	if (!isBackendName(fields.backend)) return fail("defaults.backend must be claude, pi or codex");
	for (const field of ["model", "effort"] as const) {
		if (fields[field] !== undefined && (typeof fields[field] !== "string" || !fields[field].trim())) fail(`defaults.${field} must be nonblank text; leave it out instead`);
	}
	return { backend: fields.backend, ...(fields.model === undefined ? {} : { model: fields.model as string }), ...(fields.effort === undefined ? {} : { effort: fields.effort as string }) };
}

/** The file whose header decides a mode contract's availability: ask's review mode belongs to role ask. */
export const CONTRACT_OWNERS: Readonly<Record<string, string>> = { "ask-review.md": "ask-answer.md" };

/** The owning file of a mode contract, or undefined for a role's own contract. */
export const contractOwner = (name: string): string | undefined => (Object.hasOwn(CONTRACT_OWNERS, name) ? CONTRACT_OWNERS[name] : undefined);

/** A contract read lazily runs only when it is valid, not disabled and has child instructions. */
function runnableBody(read: (name: string) => string, name: string): string {
	const parsed = parseRoleContract(read(name), name, name);
	if (parsed.disabled) throw new Error(`pi-fusion: role contract ${name} declares its role disabled`);
	if (!parsed.body.trim()) throw new Error(`pi-fusion: role contract ${name} has blank child instructions`);
	return parsed.body;
}

/**
 * A contract body a backend reads itself because no startup body was supplied. A disabled, blank or invalid canonical
 * contract runs nothing, and a mode contract runs only when its role's own file would: the caller refuses before it
 * creates storage or starts a child. Availability is the host's to decide; this only keeps a lazy read from turning a
 * disabled or empty declaration into a child's instructions.
 */
export function canonicalContractBody(read: (name: string) => string, name: string): string {
	const owner = contractOwner(name);
	if (owner !== undefined) {
		try {
			runnableBody(read, owner);
		} catch (error) {
			throw new Error(`pi-fusion: ${name} is not run because its role's contract cannot run: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return runnableBody(read, name);
}

/** A body the host already resolved at startup: checked for text only, never parsed again as frontmatter. */
export function suppliedContractBody(body: string): string {
	if (typeof body !== "string" || !body.trim()) throw new Error("pi-fusion: the supplied role contract body is blank");
	return body;
}
