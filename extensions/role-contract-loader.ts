import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_DIR } from "./backends/pi-storage.ts";
import { instructionBytes, instructionOverride, type InstructionSource, readInstructionFile, selectInstruction, shippedInstruction } from "./instruction-files.ts";
import { parseRoleContract, type RoleGuidanceMap } from "./role-contracts.ts";

export const ROLE_CONTRACTS = { plan: "plan.md", implement: "implement.md", ultracode: "ultracode.md", ask: "ask-answer.md", security: "security.md" } as const;
export const ROLE_CONTRACT_FILES = [...Object.values(ROLE_CONTRACTS), "ask-review.md"] as const;
export type RoleContractName = (typeof ROLE_CONTRACT_FILES)[number];
export const SHIPPED_ROLE_CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts");

type ParsedContract = ReturnType<typeof parseRoleContract>;
export type LoadedRoleContract = ParsedContract & InstructionSource;

/** Metadata and child bodies come from the same startup selection, never separate reads. */
export interface RoleContractSnapshot {
	files: Record<RoleContractName, LoadedRoleContract>;
	guidance: RoleGuidanceMap;
}

export interface RoleContractLoader {
	/** The host calls this once; profile/settings changes never reload contracts. */
	load(): Promise<RoleContractSnapshot>;
}

/** The five advertised roles need host metadata; review may remain a headerless child contract. */
const parser = (name: RoleContractName) => (text: string, source: string): ParsedContract => {
	const parsed = parseRoleContract(text, source);
	if (name !== "ask-review.md" && !parsed.host) throw new Error(`pi-fusion: role contract ${source} has no host frontmatter`);
	return parsed;
};

const snapshot = (files: RoleContractSnapshot["files"]): RoleContractSnapshot => ({
	files,
	guidance: Object.fromEntries(Object.entries(ROLE_CONTRACTS).map(([role, name]) => [role, files[name].host!])) as RoleGuidanceMap,
});

/** Fixed filenames only: no caller can turn contract lookup into arbitrary path access. */
export function roleContractBody(contracts: RoleContractSnapshot, name: string): string {
	if (!Object.hasOwn(contracts.files, name)) throw new Error(`pi-fusion: unknown role contract ${name}`);
	return contracts.files[name as RoleContractName].body;
}

/** Validate every shipped contract before locating user overrides, so replacements cannot hide a broken install. */
export function fileRoleContractLoader(sources: { shipped: string; override: () => string | Promise<string> }): RoleContractLoader {
	return {
		load: async () => {
			const files = {} as RoleContractSnapshot["files"];
			for (const name of ROLE_CONTRACT_FILES) {
				const file = path.join(sources.shipped, name);
				files[name] = shippedInstruction(await readInstructionFile(file), file, `role contract ${name}`, parser(name));
			}
			let directory: Promise<string> | undefined;
			for (const name of ROLE_CONTRACT_FILES) {
				files[name] = await instructionOverride(files[name], async () => path.join(await (directory ??= Promise.resolve().then(sources.override)), name), `role contract ${name}`, parser(name));
			}
			return snapshot(files);
		},
	};
}

/** Construction reads and resolves nothing; startup uses the same agent directory as the host policy. */
export function roleContractLoader(agentDir: () => Promise<string>): RoleContractLoader {
	return fileRoleContractLoader({ shipped: SHIPPED_ROLE_CONTRACTS_DIR, override: async () => path.join(await agentDir(), FUSION_DIR, "contracts") });
}

type MemoryContracts = Partial<Record<RoleContractName, string | Uint8Array>>;

/** Test hosts may replace named contracts without consulting any user-directory path. */
export function memoryRoleContractLoader(sources: { shipped?: MemoryContracts; overrides?: MemoryContracts } = {}): RoleContractLoader {
	return {
		load: async () => {
			const files = {} as RoleContractSnapshot["files"];
			for (const name of ROLE_CONTRACT_FILES) {
				const supplied = sources.shipped && Object.hasOwn(sources.shipped, name) ? sources.shipped[name] : undefined;
				const where = supplied === undefined ? path.join(SHIPPED_ROLE_CONTRACTS_DIR, name) : `(shipped ${name}, in memory)`;
				files[name] = shippedInstruction(supplied === undefined ? await readInstructionFile(where) : instructionBytes(supplied), where, `role contract ${name}`, parser(name));
			}
			for (const name of ROLE_CONTRACT_FILES) {
				const supplied = sources.overrides && Object.hasOwn(sources.overrides, name) ? sources.overrides[name] : undefined;
				files[name] = selectInstruction(files[name], supplied === undefined ? { missing: true } : instructionBytes(supplied), `(override ${name}, in memory)`, `role contract ${name}`, parser(name));
			}
			return snapshot(files);
		},
	};
}
