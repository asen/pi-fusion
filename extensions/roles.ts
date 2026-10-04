import { type BackendName, BACKEND_NAMES } from "./backends/types.ts";

/**
 * What each role is, apart from any harness that runs it: which backends may run it, whether it can change files,
 * and whether an independent review reads it. Scheduling, snapshots and review eligibility read these capabilities
 * rather than naming roles one by one. Nothing here binds a role to a model, a tool list or a contract: those are
 * the host's and the backend's, and this module imports neither.
 */

/**
 * Every role a record may name, which is every role a backend of this build runs: `security` runs on Pi and nowhere
 * else, and Codex runs `implement` and `ask` alone until its checkpoints are qualified for a plan run to continue.
 */
export const KNOWN_ROLE_NAMES = ["plan", "implement", "ultracode", "ask", "security"] as const;
export type KnownRoleName = (typeof KNOWN_ROLE_NAMES)[number];

export interface RoleSpec {
	name: KnownRoleName;
	/** The backends that may run the role. A call naming another one is refused before a child starts. */
	backends: readonly BackendName[];
	/** True for a role that takes the single active file-changing slot and gets a changed-file snapshot. */
	canChangeFiles: boolean;
	/** True for a role whose finished run an independent review reads. */
	reviewable: boolean;
}

export const ROLE_SPECS: Record<KnownRoleName, RoleSpec> = {
	// plan writes its own notes and files, so it keeps the file-changing classification it has always had.
	plan: { name: "plan", backends: ["claude", "pi"], canChangeFiles: true, reviewable: false },
	implement: { name: "implement", backends: BACKEND_NAMES, canChangeFiles: true, reviewable: true },
	ultracode: { name: "ultracode", backends: ["claude"], canChangeFiles: true, reviewable: true },
	ask: { name: "ask", backends: BACKEND_NAMES, canChangeFiles: false, reviewable: false },
	security: { name: "security", backends: ["pi"], canChangeFiles: true, reviewable: true },
};

export const isKnownRole = (value: unknown): value is KnownRoleName => typeof value === "string" && Object.hasOwn(ROLE_SPECS, value);

/** The role's capabilities, or undefined for a name no record and no call may use. */
export const roleSpec = (role: string): RoleSpec | undefined => (isKnownRole(role) ? ROLE_SPECS[role] : undefined);

/** True for a role that occupies the single active file-changing slot; an unknown role is treated as one that does. */
export const canChangeFiles = (role: string): boolean => roleSpec(role)?.canChangeFiles !== false;

/** True for a role an independent review reads. An unknown role is not one. */
export const isReviewable = (role: string): boolean => roleSpec(role)?.reviewable === true;

/** True when the backend may run the role at all. */
export const runsOn = (role: string, backend: BackendName): boolean => roleSpec(role)?.backends.includes(backend) === true;
