import * as fs from "node:fs";
import * as path from "node:path";
import { reason } from "./profile-store.ts";

/** Host policies and role contracts share the same bounded, read-only override rules. */
export const INSTRUCTION_MAX_BYTES = 64 * 1024;

export type InstructionRead = { bytes: Uint8Array } | { missing: true } | { error: string };

export interface InstructionSource {
	source: "shipped" | "override";
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

/** Type the opened descriptor, not a prior path check; a FIFO must never block startup. */
export async function readInstructionFile(file: string): Promise<InstructionRead> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return { missing: true };
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

/** Text checks and format validation have the same fallback semantics. */
function checked<T extends object>(read: InstructionRead, where: string, parse: (text: string, source: string) => T): { value: T } | { error: string } {
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
	const result = checked(read, where, parse);
	if ("error" in result) throw new Error(`pi-fusion: the shipped ${label} ${where} ${result.error}`);
	return { ...result.value, source: "shipped", path: where };
}

/** Replace a whole instruction file, or retain its shipped value with a diagnostic for an unusable override. */
export function selectInstruction<T extends object>(shipped: T & InstructionSource, read: InstructionRead, where: string, label: string, parse: (text: string, source: string) => T): T & InstructionSource {
	if ("missing" in read) return shipped;
	const result = checked(read, where, parse);
	if ("error" in result) return { ...shipped, diagnostic: `the ${label} override ${where} ${result.error}; using the shipped ${label} instead` };
	return { ...result.value, source: "override", path: where };
}

/** Resolve user paths only during loading; an unavailable agent directory is an override failure, not a broken install. */
export async function instructionOverride<T extends object>(shipped: T & InstructionSource, override: () => string | Promise<string>, label: string, parse: (text: string, source: string) => T): Promise<T & InstructionSource> {
	let where: string;
	try {
		where = path.resolve(await override());
	} catch (error) {
		return { ...shipped, diagnostic: `the ${label} override could not be located (${error instanceof Error ? error.message : String(error)}); using the shipped ${label} instead` };
	}
	return selectInstruction(shipped, await readInstructionFile(where), where, label, parse);
}

/** Memory loaders exercise the same validation without ever reaching the user's files. */
export const instructionBytes = (value: string | Uint8Array): InstructionRead => ({ bytes: typeof value === "string" ? new TextEncoder().encode(value) : value });
