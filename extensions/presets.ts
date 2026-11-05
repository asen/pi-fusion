import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_DIR } from "./backends/pi-storage.ts";
import { instructionText, readInstructionFile } from "./instruction-files.ts";
import { queued, writePrivate } from "./profile-store.ts";

/**
 * Which instruction source an extension instance loads its host policy and role contracts from: one of five fixed
 * names, never a path, registry or download. A selection is made once, when the instance starts, and only a reload or
 * a new instance applies another one.
 *
 *   builtin    this build's contracts/ alone
 *   architect  this build's bundled presets/architect/ alone, complete in itself
 *   user       <agent dir>/pi-fusion/ files, a missing one falling back to builtin
 *   project    trusted <cwd>/.pi/pi-fusion/ files, a missing one falling back to builtin
 *   auto       trusted project, then user, then builtin, per file
 *
 * The selection comes from, in order: this session's branch entry, a trusted project's default, the user's default,
 * then `auto`. The first that names a preset decides alone; lower ones are not read.
 */
export const PRESET_NAMES = ["builtin", "architect", "user", "project", "auto"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const isPresetName = (value: unknown): value is PresetName => typeof value === "string" && (PRESET_NAMES as readonly string[]).includes(value);

/** The preset an instance uses when nothing selects one: today's per-file project, user, builtin selection. */
export const DEFAULT_PRESET: PresetName = "auto";

/** Where this build's bundled presets ship, beside contracts/. */
export const PRESETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "presets");

/** The one bundled preset besides builtin, which is contracts/ itself. */
export const ARCHITECT_DIR = path.join(PRESETS_DIR, "architect");

/** The custom session entry a session's own choice is kept in; the latest on the branch wins. */
export const PRESET_ENTRY = "pi-fusion-preset";
export const PRESET_ENTRY_VERSION = 1;

/** The session entry's data: a preset, or null for no session choice so the defaults decide. */
export interface PresetEntry {
	version: typeof PRESET_ENTRY_VERSION;
	preset: PresetName | null;
}

/** What the branch says: nothing, a choice (null clears it), or a latest entry this build cannot use. */
export type SessionPreset = { kind: "none" } | { kind: "set"; preset: PresetName | null } | { kind: "invalid"; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The session's choice from its active branch alone, latest entry first. A latest entry this build cannot read is the
 * branch's answer: it never falls back to an earlier entry, which would bring back a choice the session replaced.
 */
export function sessionPreset(branch: readonly unknown[]): SessionPreset {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (entry?.type !== "custom" || entry.customType !== PRESET_ENTRY) continue;
		const data = entry.data;
		if (!isRecord(data) || data.version !== PRESET_ENTRY_VERSION) return { kind: "invalid", reason: "the latest preset entry on this branch has a version this build does not read" };
		if (Object.keys(data).some((key) => key !== "version" && key !== "preset")) return { kind: "invalid", reason: "the latest preset entry on this branch has an unknown field" };
		if (data.preset !== null && !isPresetName(data.preset)) return { kind: "invalid", reason: `the latest preset entry on this branch names no preset this build has; use one of ${PRESET_NAMES.join(", ")}` };
		return { kind: "set", preset: data.preset as PresetName | null };
	}
	return { kind: "none" };
}

/** Where a selection came from, as status says it. */
export type PresetOrigin = "session" | "project default" | "user default" | "fallback";

export interface PresetSelection {
	preset: PresetName;
	from: PresetOrigin;
}

export type PresetScope = "user" | "project";

/**
 * The default preset files: `<agent dir>/pi-fusion/preset.json` and `<cwd>/.pi/pi-fusion/preset.json`. A missing file,
 * or one whose default is null, selects nothing; a present file this build cannot read is an error, never a quiet
 * fall-through to another workflow. Reading creates nothing.
 */
export interface PresetDefaultsStore {
	where(scope: PresetScope, cwd: string): Promise<string>;
	/** The default the file names, or undefined when it names none; throws for a file that is present and unusable. */
	read(scope: PresetScope, cwd: string): Promise<PresetName | undefined>;
	/** Rereads the file, refusing an unusable one, and writes the new default, or null to clear it. */
	write(scope: PresetScope, cwd: string, preset: PresetName | null): Promise<void>;
}

export const PRESET_FILE = "preset.json";
export const PRESET_FILE_VERSION = 1;

/** The default a file's text holds; diagnostics name what is wrong without repeating the file's contents. */
export function parsePresetFile(text: string, where: string): PresetName | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// JSON diagnostics quote the text; a selector file's contents never reach a warning.
		throw new Error(`preset file ${where} is not valid JSON; fix or remove it`);
	}
	if (!isRecord(value)) throw new Error(`preset file ${where} must hold a JSON object; fix or remove it`);
	if (value.version !== PRESET_FILE_VERSION) throw new Error(`preset file ${where} has a version this build does not read (it reads version ${PRESET_FILE_VERSION}); fix or remove it`);
	if (Object.keys(value).some((key) => key !== "version" && key !== "defaultPreset")) throw new Error(`preset file ${where} has an unknown field; it holds version and defaultPreset only`);
	const preset = value.defaultPreset ?? null;
	if (preset !== null && !isPresetName(preset)) throw new Error(`preset file ${where} names no preset this build has; use one of ${PRESET_NAMES.join(", ")} or null`);
	return preset as PresetName | null;
}

export const serializePresetFile = (preset: PresetName | null): string => `${JSON.stringify({ version: PRESET_FILE_VERSION, defaultPreset: preset }, null, 2)}\n`;

/** The production store: the user file under the agent directory Pi resolves, the project file under the session cwd. */
export function filePresetDefaults(agentDir: () => Promise<string>): PresetDefaultsStore {
	const file = async (scope: PresetScope, cwd: string): Promise<string> => path.resolve(scope === "user" ? path.join(await agentDir(), FUSION_DIR) : path.join(cwd, ".pi", FUSION_DIR), PRESET_FILE);
	/** Bounded, strict UTF-8, regular file only, and a dangling link is a present file, as for instruction files. */
	const readFile = async (target: string): Promise<PresetName | null | undefined> => {
		const read = await readInstructionFile(target);
		if ("missing" in read) return undefined;
		if ("error" in read) throw new Error(`preset file ${target} ${read.error}; fix or remove it`);
		const text = instructionText(read.bytes);
		if ("error" in text) throw new Error(`preset file ${target} ${text.error}; fix or remove it`);
		return parsePresetFile(text.text, target);
	};
	return {
		where: file,
		read: async (scope, cwd) => (await readFile(await file(scope, cwd))) ?? undefined,
		write: async (scope, cwd, preset) => {
			const target = await file(scope, cwd);
			await queued(target, async () => {
				// A file this cannot read is never replaced as a side effect of a command: the person fixes it first.
				await readFile(target);
				await writePrivate(target, serializePresetFile(preset), "preset file");
			});
		},
	};
}

type MemoryDefault = PresetName | null | { error: string };

/** A store held in memory, for a host that must never read or write the user's or a project's file. */
export function memoryPresetDefaults(initial: Partial<Record<PresetScope, MemoryDefault>> = {}): PresetDefaultsStore & { value(scope: PresetScope): MemoryDefault | undefined; reads: PresetScope[] } {
	const values: Partial<Record<PresetScope, MemoryDefault>> = { ...initial };
	const reads: PresetScope[] = [];
	const current = (scope: PresetScope): PresetName | undefined => {
		const value = Object.hasOwn(values, scope) ? values[scope] : undefined;
		if (value !== null && typeof value === "object") throw new Error(`preset file (${scope} preset.json, in memory) ${value.error}; fix or remove it`);
		return value ?? undefined;
	};
	return {
		where: async (scope) => `(${scope} preset.json, in memory)`,
		read: async (scope) => {
			reads.push(scope);
			return current(scope);
		},
		write: async (scope, _cwd, preset) => {
			current(scope);
			values[scope] = preset;
		},
		value: (scope) => values[scope],
		reads,
	};
}

/** The refusal a selection of `project` meets in a working directory Pi does not report as trusted. */
export const UNTRUSTED_PROJECT =
	"preset project needs a trusted project, and Pi does not report this working directory as trusted, so no instructions were loaded. Trust the project and reload, or choose another preset with /fusion preset use <name> and /reload";

/**
 * The selection a startup uses: the branch's choice, then a trusted project's default, then the user's, then auto.
 * The session's choice is read by the caller before anything awaits, so a command that lands meanwhile cannot change
 * it. An unusable entry or default file refuses rather than choosing another source; `project` refuses without trust.
 */
export async function resolvePreset(session: SessionPreset, context: { cwd: string; projectTrusted: boolean }, defaults: PresetDefaultsStore): Promise<PresetSelection> {
	const selection = await (async (): Promise<PresetSelection> => {
		if (session.kind === "invalid") throw new Error(`${session.reason}. Choose one with /fusion preset use <name> or clear it with /fusion preset reset, then /reload`);
		if (session.kind === "set" && session.preset !== null) return { preset: session.preset, from: "session" };
		if (context.projectTrusted) {
			const project = await defaults.read("project", context.cwd);
			if (project !== undefined) return { preset: project, from: "project default" };
		}
		const user = await defaults.read("user", context.cwd);
		if (user !== undefined) return { preset: user, from: "user default" };
		return { preset: DEFAULT_PRESET, from: "fallback" };
	})();
	if (selection.preset === "project" && !context.projectTrusted) throw new Error(`${UNTRUSTED_PROJECT} (selected by the ${selection.from === "session" ? "session's choice" : selection.from})`);
	return selection;
}

/** How a selection reads in status: the preset and what chose it. */
export const selectionText = (selection: PresetSelection): string =>
	`${selection.preset} (${selection.from === "session" ? "this session's choice" : selection.from === "fallback" ? "nothing selects one, so auto" : `the ${selection.from}`})`;
