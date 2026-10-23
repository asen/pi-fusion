import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_DIR } from "./backends/pi-storage.ts";
import { instructionBytes, INSTRUCTION_MAX_BYTES, instructionOverride, type InstructionContext, type InstructionSource, instructionText, readInstructionFile, selectInstruction, shippedInstruction } from "./instruction-files.ts";

/**
 * Plain Markdown telling the host how to orchestrate, never child instructions. Project/user files replace shipped
 * text whole, without templating, includes or frontmatter. Loading reads only and never copies or creates a file.
 * File bounds, strict UTF-8, fallback and diagnostics are shared with role-contract loading.
 */
export const HOST_POLICY_FILE = "host.md";
export const HOST_POLICY_MAX_BYTES = INSTRUCTION_MAX_BYTES;
export const SHIPPED_HOST_POLICY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts", HOST_POLICY_FILE);
export const policyText = instructionText;

export interface HostPolicy extends InstructionSource {
	/** The Markdown as decoded, unchanged. */
	text: string;
}

export interface HostPolicyLoader {
	/** Reads configured sources afresh; the host supplies its startup cwd/trust once per instance. */
	load(context?: InstructionContext): Promise<HostPolicy>;
}

const policy = (text: string): { text: string } => ({ text });

/** Validate the shipped policy first, then locate and select its optional whole-file replacement. */
export function fileHostPolicyLoader(sources: { shipped: string; override: () => string | Promise<string>; project?: () => string | Promise<string> }): HostPolicyLoader {
	return {
		load: async () => {
			const shipped = shippedInstruction(await readInstructionFile(sources.shipped), sources.shipped, "host policy", policy);
			return instructionOverride(shipped, sources.override, "host policy", policy, sources.project);
		},
	};
}

/** Project lookup uses only an affirmatively trusted session cwd; user lookup stays lazy and is the fallback. */
export function hostPolicyLoader(agentDir: () => Promise<string>): HostPolicyLoader {
	return {
		load: (context) => fileHostPolicyLoader({
			shipped: SHIPPED_HOST_POLICY_PATH,
			override: async () => path.join(await agentDir(), FUSION_DIR, HOST_POLICY_FILE),
			...(context?.projectTrusted === true ? { project: () => path.join(context.cwd, ".pi", FUSION_DIR, HOST_POLICY_FILE) } : {}),
		}).load(),
	};
}

/** A test host never reads the user's override; omitted shipped text still comes from this build. */
export function memoryHostPolicyLoader(sources: { shipped?: string | Uint8Array; override?: string | Uint8Array } = {}): HostPolicyLoader {
	return {
		load: async () => {
			const where = sources.shipped === undefined ? SHIPPED_HOST_POLICY_PATH : "(shipped, in memory)";
			const read = sources.shipped === undefined ? await readInstructionFile(where) : instructionBytes(sources.shipped);
			const shipped = shippedInstruction(read, where, "host policy", policy);
			return selectInstruction(shipped, sources.override === undefined ? { missing: true } : instructionBytes(sources.override), "(override, in memory)", "host policy", policy);
		},
	};
}
