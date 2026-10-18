import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_DIR } from "./backends/pi-storage.ts";
import { reason } from "./profile-store.ts";

/**
 * The host policy: plain Markdown saying how the host orchestrates, which the host is told beside the delegation
 * guidance. This build ships one in `contracts/host.md`; a person may replace it with `host.md` in the Fusion-owned
 * directory under the host agent directory. An override replaces the shipped text whole, never appends to it, and is
 * read as it is: no templating, includes or frontmatter, only strict UTF-8 that is nonblank and at most 64 KiB.
 *
 * Loading reads only. A missing override is the shipped policy and nothing else; an override that cannot be read or is
 * not acceptable text is the shipped policy with a diagnostic saying why, for the host to warn once. The shipped policy
 * is read first and its failure is the load's failure, so a broken install is never hidden by a valid override.
 * Nothing here creates a directory or a file, or copies the shipped text anywhere.
 */

export const HOST_POLICY_FILE = "host.md";
/** The largest policy, in bytes, either source may hold. */
export const HOST_POLICY_MAX_BYTES = 64 * 1024;
export const SHIPPED_HOST_POLICY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts", HOST_POLICY_FILE);

/** The policy one load selected. */
export interface HostPolicy {
	/** The Markdown as decoded, unchanged. */
	text: string;
	source: "shipped" | "override";
	/** Where `text` came from. */
	path: string;
	/** Why an override that is there was not used, for the host to say once. Absent when nothing was set aside. */
	diagnostic?: string;
}

export interface HostPolicyLoader {
	/** Reads both sources afresh and selects one; rejects when the shipped policy itself is unusable. */
	load(): Promise<HostPolicy>;
}

/** One source as read: its bytes, absent for a source that is not there, or why it could not be read. */
type Read = { bytes: Uint8Array } | { missing: true } | { error: string };

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The text the bytes hold, or why they are not a policy. Size is checked first, so oversize bytes are never decoded. */
export function policyText(bytes: Uint8Array): { text: string } | { error: string } {
	if (bytes.byteLength > HOST_POLICY_MAX_BYTES) return { error: `is larger than ${HOST_POLICY_MAX_BYTES} bytes` };
	if (bytes.byteLength === 0) return { error: "is empty" };
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		return { error: "is not valid UTF-8" };
	}
	if (!text.trim()) return { error: "is blank" };
	return { text };
}

/**
 * Opened without blocking where the platform has the flag, so a FIFO or device at the path cannot hold the open, and
 * typed from the opened descriptor rather than from the path, so nothing swapped in between a check and the open is
 * read. Windows has no such flag and no FIFO a path open would block on.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Up to one byte past the limit of a regular file, so an oversize file is refused without reading all of it. Anything
 * else at the path, a directory or a FIFO, is refused before a byte is read.
 */
async function readBounded(file: string): Promise<Read> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, OPEN_FLAGS);
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return { missing: true };
		return { error: `could not be read (${reason(error)})` };
	}
	try {
		if (!(await handle.stat()).isFile()) return { error: "is not a regular file" };
		const buffer = Buffer.alloc(HOST_POLICY_MAX_BYTES + 1);
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

/** The shipped policy the read holds, or the load's failure: a broken install is refused before the override is looked for. */
function shippedPolicy(read: Read, where: string): HostPolicy {
	const base = "bytes" in read ? policyText(read.bytes) : "missing" in read ? { error: "is missing" } : read;
	if ("error" in base) throw new Error(`pi-fusion: the shipped host policy ${where} ${base.error}`);
	return { text: base.text, source: "shipped", path: where };
}

/** The override as read when it holds a policy, which replaces the shipped one; otherwise the shipped one, with why when one was there. */
function select(shipped: HostPolicy, override: { read: Read; where: string }): HostPolicy {
	if ("missing" in override.read) return shipped;
	const chosen = "bytes" in override.read ? policyText(override.read.bytes) : override.read;
	if ("error" in chosen) return { ...shipped, diagnostic: `the host policy override ${override.where} ${chosen.error}; using the shipped host policy instead` };
	return { text: chosen.text, source: "override", path: override.where };
}

/**
 * A loader over two files. The shipped one is read and checked first, so a broken install fails before the override's
 * place is asked for; that place is resolved on each load, so constructing a loader reads and resolves nothing.
 */
export function fileHostPolicyLoader(sources: { shipped: string; override: () => string | Promise<string> }): HostPolicyLoader {
	return {
		load: async () => {
			const shipped = shippedPolicy(await readBounded(sources.shipped), sources.shipped);
			let where: string;
			try {
				where = path.resolve(await sources.override());
			} catch (error) {
				// The override's place is unknown, so whether one is there is too: the shipped policy, said once.
				return { ...shipped, diagnostic: `the host policy override could not be located (${error instanceof Error ? error.message : String(error)}); using the shipped host policy instead` };
			}
			return select(shipped, { read: await readBounded(where), where });
		},
	};
}

/**
 * The production loader: the shipped policy, and `host.md` in the Fusion directory under the agent directory Pi itself
 * resolves, which is only asked for when a load needs it.
 */
export function hostPolicyLoader(agentDir: () => Promise<string>): HostPolicyLoader {
	return fileHostPolicyLoader({ shipped: SHIPPED_HOST_POLICY_PATH, override: async () => path.join(await agentDir(), FUSION_DIR, HOST_POLICY_FILE) });
}

/**
 * A loader for a host that must never read the user's override. The shipped source is this build's own file unless
 * text or bytes are given for it; the override is absent unless given. Both go through the same checks as files do.
 */
export function memoryHostPolicyLoader(sources: { shipped?: string | Uint8Array; override?: string | Uint8Array } = {}): HostPolicyLoader {
	const bytes = (value: string | Uint8Array): Uint8Array => (typeof value === "string" ? new TextEncoder().encode(value) : value);
	return {
		load: async () => {
			const shipped = sources.shipped === undefined ? shippedPolicy(await readBounded(SHIPPED_HOST_POLICY_PATH), SHIPPED_HOST_POLICY_PATH) : shippedPolicy({ bytes: bytes(sources.shipped) }, "(shipped, in memory)");
			const override: Read = sources.override === undefined ? { missing: true } : { bytes: bytes(sources.override) };
			return select(shipped, { read: override, where: "(override, in memory)" });
		},
	};
}
