import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_DIR } from "./backends/pi-storage.ts";
import { checkInstruction, fileScope, instructionBytes, type InstructionContext, type InstructionRead, type InstructionScope, type InstructionSource, readInstructionFile, shippedInstruction } from "./instruction-files.ts";
import { ARCHITECT_DIR, DEFAULT_PRESET, type PresetName, UNTRUSTED_PROJECT } from "./presets.ts";
import { type StartupDefault, startupDefault } from "./profiles.ts";
import { contractOwner, type ParsedRoleContract, parseRoleContract, type RoleGuidanceMap } from "./role-contracts.ts";
import type { KnownRoleName } from "./roles.ts";

export const ROLE_CONTRACTS = { plan: "plan.md", implement: "implement.md", ultracode: "ultracode.md", ask: "ask-answer.md", security: "security.md" } as const;
export const ROLE_CONTRACT_FILES = [...Object.values(ROLE_CONTRACTS), "ask-review.md"] as const;
export type RoleContractName = (typeof ROLE_CONTRACT_FILES)[number];
export const SHIPPED_ROLE_CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts");

/**
 * One selected file. An override that was present and could not be used is kept as `unusable`, with no body and no
 * metadata: its role is unavailable rather than quietly run under a lower scope's instructions.
 */
export type LoadedRoleContract = ParsedRoleContract & InstructionSource & { unusable?: true };

/** A role's checked contract defaults and the file that declared them. */
export type LoadedDefault = StartupDefault & { path: string };

/** Metadata, child bodies, availability and defaults all come from the same startup selection, never separate reads. */
export interface RoleContractSnapshot {
	files: Record<RoleContractName, LoadedRoleContract>;
	guidance: RoleGuidanceMap;
	/** Why each unavailable role is unavailable; a role not named here is available for this instance's life. */
	unavailable: Partial<Record<KnownRoleName, string>>;
	/** The defaults each available role's contract declares. */
	defaults: Partial<Record<KnownRoleName, LoadedDefault>>;
}

export interface RoleContractLoader {
	/** The host calls this once; profile/settings changes never reload contracts. */
	load(context?: InstructionContext): Promise<RoleContractSnapshot>;
}

/** The role each file belongs to: a mode contract belongs to the role whose file owns it. */
const ROLE_OF: Record<RoleContractName, KnownRoleName> = { "plan.md": "plan", "implement.md": "implement", "ultracode.md": "ultracode", "ask-answer.md": "ask", "security.md": "security", "ask-review.md": "ask" };

/** The five advertised roles need host metadata and may declare availability and defaults; review may remain a headerless child contract. */
const parser = (name: RoleContractName) => (text: string, source: string): ParsedRoleContract => {
	const owner = contractOwner(name);
	const parsed = parseRoleContract(text, source, owner);
	if (owner !== undefined) return parsed;
	if (!parsed.host) throw new Error(`pi-fusion: role contract ${source} has no host frontmatter`);
	if (!parsed.defaults) return parsed;
	try {
		return { ...parsed, defaults: startupDefault(ROLE_OF[name], parsed.defaults, "defaults") };
	} catch (error) {
		throw new Error(`pi-fusion: invalid role contract ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
};

/** How a selected file is named in an availability reason. */
const sourceText = (file: InstructionSource): string => (file.source === "project" ? "project override" : file.source === "override" ? "user override" : file.source === "bundled" ? "bundled preset contract" : "shipped contract");

const remedy = (role: KnownRoleName): string => `role ${role} is unavailable in this instance; fix or remove that file, then restart Pi, /reload or start a new session`;

/** One override scope: where its file is and what reading it found, or a throw when it cannot be located. */
type Scope = InstructionScope;

/**
 * The first scope that has the file wins whole. A missing file falls through; a present file that is unreadable or
 * invalid, or a scope that cannot be located, stops the search: no lower scope stands in for what that file restricted.
 */
async function selectRoleContract(shipped: LoadedRoleContract, name: RoleContractName, scopes: readonly Scope[]): Promise<LoadedRoleContract> {
	const parse = parser(name);
	for (const scope of scopes) {
		const label = scope.source === "project" ? "project" : "user";
		let found: { where: string; read: InstructionRead };
		try {
			found = await scope.read();
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			return { body: "", source: scope.source, path: `(${label} override not located)`, unusable: true, diagnostic: `the ${label} role contract ${name} override could not be located (${why}); ${remedy(ROLE_OF[name])}` };
		}
		if ("missing" in found.read) continue;
		const result = checkInstruction(found.read, found.where, parse);
		if ("value" in result) return { ...result.value, source: scope.source, path: found.where };
		return { body: "", source: scope.source, path: found.where, unusable: true, diagnostic: `the ${label} role contract ${name} override ${found.where} ${result.error}; ${remedy(ROLE_OF[name])}` };
	}
	return shipped;
}

const UNAVAILABLE_GUIDANCE = (role: KnownRoleName) => ({ description: `${role} (unavailable in this instance)`, guidance: [], task_brief: "Unavailable in this instance.", snippet: role });

/** Availability is decided once from the selection: an unusable file, or a role file that says `disabled: true`. */
const snapshot = (files: RoleContractSnapshot["files"]): RoleContractSnapshot => {
	const guidance = {} as RoleGuidanceMap;
	const unavailable: RoleContractSnapshot["unavailable"] = {};
	const defaults: RoleContractSnapshot["defaults"] = {};
	for (const [role, name] of Object.entries(ROLE_CONTRACTS) as [KnownRoleName, RoleContractName][]) {
		const file = files[name];
		const mode = role === "ask" ? files["ask-review.md"] : undefined;
		guidance[role] = file.host ?? UNAVAILABLE_GUIDANCE(role);
		if (file.unusable) unavailable[role] = file.diagnostic!;
		else if (mode?.unusable) unavailable[role] = mode.diagnostic!;
		else if (file.disabled) unavailable[role] = `the ${sourceText(file)} ${file.path} declares disabled: true`;
		else if (file.defaults) defaults[role] = { ...file.defaults, path: file.path };
	}
	return { files, guidance, unavailable, defaults };
};

/** Fixed filenames only: no caller can turn contract lookup into arbitrary path access, or read an unavailable role's body. */
export function roleContractBody(contracts: RoleContractSnapshot, name: string): string {
	if (!Object.hasOwn(contracts.files, name)) throw new Error(`pi-fusion: unknown role contract ${name}`);
	const role = ROLE_OF[name as RoleContractName];
	const unavailable = Object.hasOwn(contracts.unavailable, role) ? contracts.unavailable[role] : undefined;
	if (unavailable !== undefined) throw new Error(`pi-fusion: role ${role} is unavailable: ${unavailable}`);
	const body = contracts.files[name as RoleContractName].body;
	if (!body.trim()) throw new Error(`pi-fusion: role contract ${name} has blank child instructions`);
	return body;
}

/** Where a selection's scopes are: each file's scope by name, and the bundled preset's directory. */
interface PresetSources {
	user: (name: RoleContractName) => Scope;
	project?: (name: RoleContractName) => Scope;
	architect: (name: RoleContractName) => Promise<{ where: string; read: InstructionRead }>;
}

/**
 * The snapshot a selected preset loads, from shipped files already validated. builtin is those files alone; architect
 * is its complete bundle alone, failing startup when any file is unusable rather than borrowing from builtin; user and
 * project consult their one scope per file; auto consults the trusted project, then the user. A scope the preset does
 * not name is never located or read.
 */
async function selectedContracts(shipped: RoleContractSnapshot["files"], preset: PresetName, sources: PresetSources): Promise<RoleContractSnapshot> {
	const files = { ...shipped };
	if (preset === "builtin") return snapshot(files);
	if (preset === "architect") {
		for (const name of ROLE_CONTRACT_FILES) {
			const { where, read } = await sources.architect(name);
			files[name] = { ...shippedInstruction(read, where, `architect preset role contract ${name}`, parser(name)), source: "bundled" };
		}
		return snapshot(files);
	}
	if (preset === "project" && !sources.project) throw new Error(UNTRUSTED_PROJECT);
	for (const name of ROLE_CONTRACT_FILES) {
		const scopes = preset === "user" ? [sources.user(name)] : preset === "project" ? [sources.project!(name)] : [...(sources.project ? [sources.project(name)] : []), sources.user(name)];
		files[name] = await selectRoleContract(files[name], name, scopes);
	}
	return snapshot(files);
}

/** Validate every shipped contract before locating any other source, so a selection cannot hide a broken install. */
export function fileRoleContractLoader(sources: { shipped: string; override: () => string | Promise<string>; project?: () => string | Promise<string>; architect?: string }): RoleContractLoader {
	return {
		load: async (context) => {
			const files = {} as RoleContractSnapshot["files"];
			for (const name of ROLE_CONTRACT_FILES) {
				const file = path.join(sources.shipped, name);
				files[name] = shippedInstruction(await readInstructionFile(file), file, `role contract ${name}`, parser(name));
			}
			let directory: Promise<string> | undefined;
			let projectDirectory: Promise<string> | undefined;
			const resolveProject = sources.project;
			const architect = path.join(sources.architect ?? ARCHITECT_DIR, "contracts");
			return selectedContracts(files, context?.preset ?? DEFAULT_PRESET, {
				user: (name) => fileScope("override", async () => path.join(await (directory ??= Promise.resolve().then(sources.override)), name)),
				...(resolveProject === undefined ? {} : { project: (name: RoleContractName) => fileScope("project", async () => path.join(await (projectDirectory ??= Promise.resolve().then(resolveProject)), name)) }),
				architect: async (name) => {
					const where = path.join(architect, name);
					return { where, read: await readInstructionFile(where) };
				},
			});
		},
	};
}

/** Startup uses the same trusted cwd and lazy user agent directory as the host policy, without ancestor discovery. */
export function roleContractLoader(agentDir: () => Promise<string>): RoleContractLoader {
	return {
		load: (context) => fileRoleContractLoader({
			shipped: SHIPPED_ROLE_CONTRACTS_DIR,
			override: async () => path.join(await agentDir(), FUSION_DIR, "contracts"),
			...(context?.projectTrusted === true ? { project: () => path.join(context.cwd, ".pi", FUSION_DIR, "contracts") } : {}),
		}).load(context),
	};
}

/** A memory override is text, bytes, or a read error standing for a present file that could not be read. */
type MemoryContracts = Partial<Record<RoleContractName, string | Uint8Array | { error: string }>>;

const memoryRead = (value: string | Uint8Array | { error: string }): InstructionRead => (typeof value === "object" && !(value instanceof Uint8Array) ? { error: value.error } : instructionBytes(value));

/**
 * Test hosts may replace named contracts without consulting any user-directory or project path. `overrides` is the
 * user scope (`user` is its other name); `project` is consulted only with affirmative trust, as in production; architect
 * is this build's bundled preset.
 */
export function memoryRoleContractLoader(sources: { shipped?: MemoryContracts; overrides?: MemoryContracts; user?: MemoryContracts; project?: MemoryContracts } = {}): RoleContractLoader {
	const memory = (source: Scope["source"], label: string, contracts: MemoryContracts | undefined) => (name: RoleContractName): Scope => ({
		source,
		read: async () => {
			const supplied = contracts && Object.hasOwn(contracts, name) ? contracts[name] : undefined;
			return { where: `(${label} ${name}, in memory)`, read: supplied === undefined ? { missing: true } : memoryRead(supplied) };
		},
	});
	return {
		load: async (context) => {
			const files = {} as RoleContractSnapshot["files"];
			for (const name of ROLE_CONTRACT_FILES) {
				const supplied = sources.shipped && Object.hasOwn(sources.shipped, name) ? sources.shipped[name] : undefined;
				const where = supplied === undefined ? path.join(SHIPPED_ROLE_CONTRACTS_DIR, name) : `(shipped ${name}, in memory)`;
				files[name] = shippedInstruction(supplied === undefined ? await readInstructionFile(where) : memoryRead(supplied), where, `role contract ${name}`, parser(name));
			}
			return selectedContracts(files, context?.preset ?? DEFAULT_PRESET, {
				user: memory("override", "override", sources.user ?? sources.overrides),
				...(context?.projectTrusted === true ? { project: memory("project", "project", sources.project) } : {}),
				architect: async (name) => {
					const where = path.join(ARCHITECT_DIR, "contracts", name);
					return { where, read: await readInstructionFile(where) };
				},
			});
		},
	};
}
