import * as fs from "node:fs";
import * as path from "node:path";
import { reason } from "./profile-store.ts";
import type { PresetName } from "./presets.ts";

/** Host policies and role contracts share the same bounded, read-only file rules; only the host policy falls back past an unusable override. */
export const INSTRUCTION_MAX_BYTES = 64 * 1024;

export type InstructionRead = { bytes: Uint8Array } | { missing: true } | { error: string };

/**
 * The first startup context fixes project lookup for this instance; absent trust means user/shipped only. `preset`
 * names the one instruction source the startup selected, `auto` when absent; only the scopes it names are read.
 */
export interface InstructionContext {
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly preset?: PresetName;
}

export interface InstructionSource {
	/** `bundled` is a preset this build ships besides contracts/, such as architect. */
	source: "shipped" | "override" | "project" | "bundled";
	path: string;
	diagnostic?: string;
}

/** Decode only bounded, nonblank strict UTF-8; callers validate their own instruction format afterward. */
export function instructionText(bytes: Uint8Array): { text: string } | { error: string } {
	if (bytes.byteLength > INSTRUCTION_MAX_BYTES) return { error: `is larger than ${INSTRUCTION_MAX_BYTES} bytes` };
	if (bytes.byteLength === 0) return { error: "is empty" };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { error: "is not valid UTF-8" };
	}
	if (!text.trim()) return { error: "is blank" };
	return { text };
}

/**
 * Why an open that found nothing still found something: a link, at the file or at the nearest existing directory above
 * it, whose target is gone. That is a file someone put there, not an absent one, so it must not read as missing. Only
 * the first existing path component is examined; a link that resolves leaves whatever is missing below it missing.
 */
async function brokenLink(file: string): Promise<InstructionRead | undefined> {
	const target = path.resolve(file);
	for (let at = target; ; ) {
		let stats: fs.Stats;
		try {
			stats = await fs.promises.lstat(at);
		} catch (error) {
			if ((error as { code?: unknown }).code !== "ENOENT") return { error: `could not be read (${reason(error)})` };
			const parent = path.dirname(at);
			if (parent === at) return undefined;
			at = parent;
			continue;
		}
		if (!stats.isSymbolicLink()) return undefined;
		try {
			await fs.promises.stat(at);
			return undefined;
		} catch {
			return { error: at === target ? "is a link to a missing file" : `is below ${at}, a link to a missing directory` };
		}
	}
}

/** Type the opened descriptor, not a prior path check; a FIFO must never block startup. */
export async function readInstructionFile(file: string): Promise<InstructionRead> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return (await brokenLink(file)) ?? { missing: true };
		return { error: `could not be read (${reason(error)})` };
	}
	try {
		if (!(await handle.stat()).isFile()) return { error: "is not a regular file" };
		const buffer = Buffer.alloc(INSTRUCTION_MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		return { bytes: buffer.subarray(0, length) };
	} catch (error) {
		return { error: `could not be read (${reason(error)})` };
	} finally {
		await handle.close().catch(() => {});
	}
}

/** Text checks and format validation have the same fallback semantics. Role contracts select with this directly. */
export function checkInstruction<T extends object>(read: InstructionRead, where: string, parse: (text: string, source: string) => T): { value: T } | { error: string } {
	const decoded = "bytes" in read ? instructionText(read.bytes) : "missing" in read ? { error: "is missing" } : read;
	if ("error" in decoded) return decoded;
	try {
		return { value: parse(decoded.text, where) };
	} catch (error) {
		return { error: `is invalid (${error instanceof Error ? error.message : String(error)})` };
	}
}

/** A broken install fails before any override is consulted, even when that override would be valid. */
export function shippedInstruction<T extends object>(read: InstructionRead, where: string, label: string, parse: (text: string, source: string) => T): T & InstructionSource {
	const result = checkInstruction(read, where, parse);
	if ("error" in result) throw new Error(`pi-fusion: the shipped ${label} ${where} ${result.error}`);
	return { ...result.value, source: "shipped", path: where };
}

/** Replace a whole instruction file, or retain its shipped value with a diagnostic for an unusable override. */
export function selectInstruction<T extends object>(shipped: T & InstructionSource, read: InstructionRead, where: string, label: string, parse: (text: string, source: string) => T): T & InstructionSource {
	if ("missing" in read) return shipped;
	const result = checkInstruction(read, where, parse);
	if ("error" in result) return { ...shipped, diagnostic: `the ${label} override ${where} ${result.error}; using the shipped ${label} instead` };
	return { ...result.value, source: "override", path: where };
}

/** One override scope a selection may consult: where its file is and what reading it found, or a throw when it cannot be located. */
export interface InstructionScope {
	source: "project" | "override";
	read(): Promise<{ where: string; read: InstructionRead }>;
}

/** A scope over a file path, read through the bounded reader; the path is resolved only when the scope is consulted. */
export const fileScope = (source: InstructionScope["source"], locate: () => string | Promise<string>): InstructionScope => ({
	source,
	read: async () => {
		const where = path.resolve(await locate());
		return { where, read: await readInstructionFile(where) };
	},
});

/**
 * The first usable scope in order wins whole; a missing or unusable file falls through to the next, then to the shipped
 * value, and every reason a file was set aside is kept in one diagnostic. Only scopes a selection names are consulted.
 */
export async function fallbackInstruction<T extends object>(shipped: T & InstructionSource, scopes: readonly InstructionScope[], label: string, parse: (text: string, source: string) => T): Promise<T & InstructionSource> {
	const problems: string[] = [];
	const finish = (selected: T & InstructionSource): T & InstructionSource => {
		if (!problems.length) return selected;
		const instead = selected.source === "override" ? "user" : selected.source === "project" ? "project" : "shipped";
		return { ...selected, diagnostic: `${problems.join("; ")}; using the ${instead} ${label} instead` };
	};
	for (const scope of scopes) {
		const named = scope.source === "project" ? `project ${label}` : label;
		let found: { where: string; read: InstructionRead };
		try {
			found = await scope.read();
		} catch (error) {
			problems.push(`the ${named} override could not be located (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		if ("missing" in found.read) continue;
		const result = checkInstruction(found.read, found.where, parse);
		if ("value" in result) return finish({ ...result.value, source: scope.source, path: found.where });
		problems.push(`the ${named} override ${found.where} ${result.error}`);
	}
	return finish(shipped);
}

/** Consult a project file before the user file; missing or invalid files fall through without merging their contents. */
export async function instructionOverride<T extends object>(shipped: T & InstructionSource, override: (() => string | Promise<string>) | undefined, label: string, parse: (text: string, source: string) => T, project?: () => string | Promise<string>): Promise<T & InstructionSource> {
	return fallbackInstruction(shipped, [...(project ? [fileScope("project", project)] : []), ...(override ? [fileScope("override", override)] : [])], label, parse);
}

/** Source reporting distinguishes a bad higher-priority project file from an invalid user override. */
export function instructionSourceLabel(file: InstructionSource): string {
	if (file.source === "bundled") return "bundled preset";
	if (file.source === "project") return "project override";
	if (file.source === "override") return file.diagnostic === undefined ? "user override" : "user override (project override set aside)";
	return file.diagnostic === undefined ? "shipped" : "shipped (override set aside)";
}

/** Memory loaders exercise the same validation without ever reaching the user's files. */
export const instructionBytes = (value: string | Uint8Array): InstructionRead => ({ bytes: typeof value === "string" ? new TextEncoder().encode(value) : value });
