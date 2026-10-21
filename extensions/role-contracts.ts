import { parse } from "yaml";
import type { KnownRoleName } from "./roles.ts";

/** Static role prose for the host; runtime capabilities and settings are supplied separately. */
export interface RoleGuidance {
	description: string;
	guidance: string[];
	task_brief: string;
	snippet: string;
}

export type RoleGuidanceMap = Record<KnownRoleName, RoleGuidance>;

/** Split host-only YAML from child instructions, leaving contracts without a header unchanged. */
export function parseRoleContract(text: string, source: string): { body: string; host?: RoleGuidance } {
	if (!/^---\r?\n/.test(text)) return { body: text };
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
	const host = metadata && typeof metadata === "object" && "host" in metadata ? metadata.host : undefined;
	if (!host || typeof host !== "object" || Array.isArray(host)) return fail("host must be an object");
	const fields = host as Record<string, unknown>;
	for (const field of ["description", "task_brief", "snippet"] as const) {
		if (typeof fields[field] !== "string" || !fields[field].trim()) return fail(`host.${field} must be nonblank text`);
	}
	if (!Array.isArray(fields.guidance) || !fields.guidance.every((line) => typeof line === "string" && line.trim())) return fail("host.guidance must be a list of nonblank text");
	const body = text.slice(header[0].length).replace(/^\r?\n/, "");
	if (!body.trim()) return fail("child instructions are blank");
	return { body, host: fields as unknown as RoleGuidance };
}
