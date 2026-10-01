import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { ChildTree, type CleanupReport, type ExitOutcome, KILL_GRACE_MS, type LaunchedProcess, type LaunchOptions, type OwnedCleanup } from "../process-tree.ts";
import { DIAGNOSTIC_EVENT, STARTUP_EXIT_CODE } from "./pi-bootstrap-protocol.mjs";

/**
 * The Pi transport: one child process, read and written as the native RPC protocol, and the bounds everything it can
 * make this host hold is cut to.
 *
 * The first half of the file is pure. The bounds, the line framer a child's streams are read through, the bounded
 * reader of its stderr, the failures this transport speaks in and the correlation of a request with the response that
 * answers it each take what they are given and answer: nothing there starts a process, opens a stream, writes a byte
 * or imports an SDK, so a test of them needs no child at all. The second half is the lifecycle, which owns the child,
 * its two pipes and its clocks, and is assembled out of those pieces.
 *
 * The two facts it shares with the child — the marker a bootstrap diagnostic carries, and the exit code a startup
 * refusal uses — come from `./pi-bootstrap-protocol.mjs`, which imports nothing and runs nothing. The child's own
 * program is never imported here: reading them off it would pull that program and everything behind it into the host
 * for two literals, and would make an install missing it a module error of this host's rather than the refusal the
 * extension's own loader composes for a backend it cannot launch.
 *
 * Why the bounds are stated once, here: what a child writes decides how much of this host's memory it uses, and a host
 * that cannot say where that limit is in one place cannot say it at all. These are internal options of one backend,
 * not a setting: no environment variable, tool argument or configuration file reaches any of them.
 */

/** How long one timer may be asked to run: past this node fires it at once, so a bound past it is no bound at all. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Every ceiling this transport keeps, each one named for what it is a ceiling on rather than for the code that reads
 * it. Zero is not a value any of them takes: an unbounded frame, an unbounded wait and an unbounded queue are the
 * three ways a child decides for the host how long it runs and how much it holds.
 */
export interface PiBounds {
	/** One inbound frame. The native `get_tree` can carry a whole transcript, which is why this is far over a message. */
	maxFrameBytes: number;
	/** One outbound frame: a host prompt or a steer. An outbound frame past it is refused before anything queues it. */
	maxOutboundFrameBytes: number;
	/** One stderr line. The bootstrap's own diagnostics can name a list of resource paths and still fit well under it. */
	maxStderrLineBytes: number;
	/** How much non-diagnostic stderr is kept at all: a bounded tail of what the child last wrote, never all of it. */
	maxStderrTailBytes: number;
	/** How much of a recognized bootstrap error a failure may carry. The raw tail is not this and never becomes it. */
	maxDiagnosticBytes: number;
	/** How many requests may be outstanding at once. */
	maxPendingRequests: number;
	/** How many of the child's ui requests may be open at once. */
	maxOpenUiRequests: number;
	/**
	 * How many dialog ids one transport answers over its whole life, answered and open together. Nothing is evicted
	 * from that count and no heap total is claimed from it; an id's own length is bounded where ids are read.
	 */
	maxUiIds: number;
	/** One spawn, through the bootstrap's stages, to a child that answers `get_state`. */
	startupMs: number;
	/**
	 * Admission and queueing through the acknowledgement of a prompt. Longer than any other request on purpose: the
	 * child may refresh a credential or compact before it acknowledges, and neither is this host's to hurry.
	 */
	ackMs: number;
	/** Every other request, the wait for a free pending slot included, because a queue is part of an answer's time. */
	requestMs: number;
	/** One step of a shutdown, and the wait for this transport's own streams to close after the tree is cleaned up. */
	shutdownStepMs: number;
}

export const PI_BOUNDS: Readonly<PiBounds> = Object.freeze({
	maxFrameBytes: 64 * 1024 * 1024,
	maxOutboundFrameBytes: 16 * 1024 * 1024,
	maxStderrLineBytes: 1024 * 1024,
	maxStderrTailBytes: 64 * 1024,
	maxDiagnosticBytes: 16 * 1024,
	maxPendingRequests: 64,
	maxOpenUiRequests: 16,
	maxUiIds: 4096,
	startupMs: 120_000,
	ackMs: 300_000,
	requestMs: 30_000,
	shutdownStepMs: 5_000,
});

/* Taken from the defaults themselves, so a field added above is validated without being listed a second time. */
const BOUND_FIELDS = Object.keys(PI_BOUNDS) as (keyof PiBounds)[];
const MS_FIELDS: readonly (keyof PiBounds)[] = ["startupMs", "ackMs", "requestMs", "shutdownStepMs"];

/**
 * The bounds a caller runs with: the defaults, with whatever it named over them. A value that is not a positive safe
 * integer is refused by name and never by echo — these come from this build's own code, and a message that repeated
 * one would be the one place a bound's value reached a log.
 */
export function piBounds(over: Partial<PiBounds> = {}): PiBounds {
	const bounds = { ...PI_BOUNDS } as PiBounds;
	for (const field of BOUND_FIELDS) {
		// A field left out takes its default; a field named with anything else is that caller's value, null included,
		// and is held to the rule below rather than quietly replaced by the default it did not ask for.
		const named = over[field];
		const value = named === undefined ? PI_BOUNDS[field] : named;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive safe integer`);
		if (MS_FIELDS.includes(field) && value > MAX_TIMER_MS) throw new TypeError(`${field} must be at most ${MAX_TIMER_MS}, which is as long as one timer can run`);
		bounds[field] = value;
	}
	writerCaps(bounds);
	return bounds;
}

/** What the writer may hold at once, in items and in bytes. */
export interface PiWriterCaps {
	items: number;
	bytes: number;
}

/**
 * The writer's caps, derived rather than configured beside the bounds, so the two can never disagree: one item per
 * pending request, one answer per open ui request, and two more for the turn's own prompt and the close that ends it.
 * The byte cap is two outbound frames, which is one being written and one waiting behind it. The arithmetic is
 * checked rather than assumed: a bound near the safe-integer ceiling would make a cap that no longer counts.
 */
export function writerCaps(bounds: Readonly<PiBounds>): PiWriterCaps {
	const items = bounds.maxPendingRequests + bounds.maxOpenUiRequests + 2;
	if (!Number.isSafeInteger(items)) throw new TypeError("maxPendingRequests and maxOpenUiRequests must leave the writer's item cap a safe integer");
	const bytes = 2 * bounds.maxOutboundFrameBytes;
	if (!Number.isSafeInteger(bytes)) throw new TypeError("maxOutboundFrameBytes must leave the writer's byte cap a safe integer");
	return { items, bytes };
}

/** What a framer does with a line past its cap: keep nothing of it, or keep the prefix that fit and say it is cut. */
export type PiOverflow = "drop" | "keep-prefix";

/** One line as the framer hands it over. A line that is `truncated` or `partial` is not a frame and is never parsed. */
export interface PiLine {
	/** The line's own text, LF gone and one CRLF's CR stripped. Empty for a cut line a `drop` framer kept none of. */
	text: string;
	/** The bytes this line took before its LF, a stripped CR and every discarded byte of a cut line included. */
	bytes: number;
	/** True when the cap cut this line: what is in `text` is a prefix of it at most, and never a whole line. */
	truncated: boolean;
	/** True when the stream ended with no LF after this text, so what is here is all of it there will ever be. */
	partial: boolean;
}

/** What one framer has done, in lines and in bytes. `lines` counts every line handed over, cut and partial included. */
export interface PiFramerCounters {
	lines: number;
	truncated: number;
	partial: number;
	/**
	 * Bytes of a line that were not retained: the discarded part of a cut one, and all of it in `drop` mode. It is the
	 * line's own bytes less the bytes what was retained re-encodes to, never below zero, and that arithmetic is what it
	 * is rather than byte-identity accounting: an invalid byte decodes to a replacement character wider than itself, so
	 * a line that lost content while gaining bytes that way can count zero here. `truncated` is what says content was
	 * lost; this says how much of the wire a bounded record does not hold, and no byte of one is mapped to a byte of
	 * the other.
	 */
	dropped: number;
}

const NEWLINE = 0x0a;

/**
 * LF-delimited framing, which is what the protocol says and no more than that: a record ends at an LF, one CR before
 * that LF is a CRLF's and is stripped, and nothing else is a boundary. U+2028 and U+2029 in particular are not, and a
 * generic line reader that splits on them would cut a frame in half inside a json string.
 *
 * The cap is counted in bytes rather than in characters, because bytes are what a child can make this host hold. Past
 * it the framer stops retaining and discards through the next LF: the line is reported once, as cut, and the frames
 * after it are read normally. Every byte still goes through the decoder even while it is being discarded, because a
 * character split across two chunks is only whole in the decoder's own state.
 *
 * A line can pass the cap in two ways, and both are the same cut: in the bytes it took, or in what those bytes decode
 * to — an invalid byte becomes a replacement character wider than itself, so a line under the raw cap can still be
 * more than may be retained. Either one is what `cut` answers, and a line is flagged truncated on either, and text
 * that arrives with no room left for it is the second of the two rather than something to drop quietly.
 *
 * The decoder's state belongs to one line, because the delimiter is a byte no character holds: a byte sequence still
 * incomplete when the LF arrives can never be completed, since what follows the LF is the next record and not that
 * character's continuation. So every LF flushes the decoder into the line it ends and starts the next line on a fresh
 * one. A character split across two chunks inside a line is untouched by that — the decoder is only ever flushed at a
 * boundary — and an incomplete sequence is reported in its own line rather than corrupting the one after it.
 */
export class LineFramer {
	private readonly max: number;
	private readonly keep: boolean;
	/** Replaced at every LF, so one line's unfinished bytes are never read as the beginning of the next one's. */
	private decoder = new StringDecoder("utf8");
	private parts: string[] = [];
	private retained = 0;
	private seen = 0;
	private over = false;
	private full = false;
	private ended = false;
	private readonly tally: PiFramerCounters = { lines: 0, truncated: 0, partial: 0, dropped: 0 };

	constructor(maxBytes: number, overflow: PiOverflow = "drop") {
		if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be a positive safe integer");
		if (overflow !== "drop" && overflow !== "keep-prefix") throw new TypeError("overflow must be drop or keep-prefix");
		this.max = maxBytes;
		this.keep = overflow === "keep-prefix";
	}

	get counters(): PiFramerCounters {
		return { ...this.tally };
	}

	/** Past the cap, by the line's own bytes or by what they decoded to. One condition, read everywhere it matters. */
	private get cut(): boolean {
		return this.over || this.full;
	}

	/**
	 * The line being read right now: the bytes it has taken, how many of them are still held, and whether it is over
	 * the cap already. That last one is what lets a caller see an oversized frame at the push that made it oversized,
	 * with no LF and no end of stream needed, and it goes back to false with the line it belonged to.
	 */
	get inProgress(): { seen: number; retained: number; truncated: boolean } {
		return { seen: this.seen, retained: this.retained, truncated: this.cut };
	}

	/** Every line this chunk completed, in order. A chunk that completes none answers with none. */
	push(chunk: Buffer): PiLine[] {
		if (this.ended) throw new Error("this framer has ended, and a stream that has ended has nothing left to frame");
		const lines: PiLine[] = [];
		let at = 0;
		for (;;) {
			const lf = chunk.indexOf(NEWLINE, at);
			if (lf === -1) {
				this.take(chunk.subarray(at));
				return lines;
			}
			this.take(chunk.subarray(at, lf));
			this.seal();
			lines.push(this.finish(false));
			at = lf + 1;
		}
	}

	/**
	 * The end of the stream. Whatever was read after the last LF is handed over as one partial line, which is content
	 * the child wrote and not a frame: the caller is told it is unterminated rather than left to parse it as whole.
	 */
	end(): PiLine[] {
		if (this.ended) return [];
		// The decoder's own end flushes a character the stream cut in half as one replacement character. A decoder that
		// has flushed is not written to again, which is why this framer is finished too and a later push is an error.
		// A stream that ended on an LF has nothing to flush: that LF already flushed and replaced the decoder, so no
		// line is manufactured here out of a character the last record already accounted for.
		this.retain(this.decoder.end());
		this.ended = true;
		return this.seen === 0 ? [] : [this.finish(true)];
	}

	/**
	 * The end of one line's bytes, which is what its LF is: whatever the decoder still holds belongs to this line, so it
	 * is flushed into it, and the next line starts on a decoder holding nothing of this one.
	 */
	private seal(): void {
		this.retain(this.decoder.end());
		this.decoder = new StringDecoder("utf8");
	}

	private take(slice: Buffer): void {
		if (!slice.length) return;
		this.seen += slice.length;
		const text = this.decoder.write(slice);
		if (this.seen > this.max) this.over = true;
		this.retain(text);
	}

	/**
	 * Text into the line being read, or the cut that says it did not fit. Text arriving with the cap already reached is
	 * the retention cut as much as text the cap falls inside: either way this line is not all of what the child wrote,
	 * and a line that lost content without saying so would be handed over as a whole frame and parsed as one.
	 */
	private retain(text: string): void {
		if (!text || this.full) return;
		if (this.retained >= this.max) {
			this.full = true;
			return;
		}
		this.append(text);
	}

	private append(text: string): void {
		const room = this.max - this.retained;
		const size = Buffer.byteLength(text);
		if (size <= room) {
			this.parts.push(text);
			this.retained += size;
			return;
		}
		// The cap falls inside this text: whole characters only, so a prefix is text rather than half of a character.
		let kept = "";
		let bytes = 0;
		for (const char of text) {
			const width = Buffer.byteLength(char);
			if (bytes + width > room) break;
			kept += char;
			bytes += width;
		}
		if (kept) this.parts.push(kept);
		this.retained += bytes;
		this.full = true;
	}

	private finish(partial: boolean): PiLine {
		const truncated = this.cut;
		const holds = !truncated || this.keep;
		let text = holds ? this.parts.join("") : "";
		// A cut line ends wherever the cap fell, so nothing is stripped from it: that CR would be content, not an end.
		if (!truncated && !partial && text.endsWith("\r")) text = text.slice(0, -1);
		const line: PiLine = { text, bytes: this.seen, truncated, partial };
		this.tally.lines += 1;
		if (truncated) this.tally.truncated += 1;
		if (partial) this.tally.partial += 1;
		// Never below zero: an invalid byte decodes to a replacement character wider than itself, and a line that
		// gained bytes that way lost none.
		this.tally.dropped += Math.max(0, this.seen - (holds ? this.retained : 0));
		this.parts = [];
		this.retained = 0;
		this.seen = 0;
		this.over = false;
		this.full = false;
		return line;
	}
}

/** How long a stage or an sdk version may be in a recognized diagnostic: both are short words the bootstrap writes. */
export const PI_DIAGNOSTIC_FIELD_MAX_CHARS = 64;

/**
 * The bootstrap's last stage, the one it reports before it serves. Named here rather than imported because the
 * bootstrap exports the marker and the exit code but no list of its stages, and this reads one stage by name only.
 */
export const PI_SERVING_STAGE = "serving";

/** What the child last failed at, as its own diagnostic said it: never a stage or an error this host made up. */
export interface PiStderrFailure {
	stage: string;
	/** The bootstrap's own error text, cut to the diagnostic cap on a character boundary when it did not fit. */
	error?: string;
	cut: boolean;
}

/**
 * Everything this transport keeps of a child's stderr, and all it keeps: last fields and counters, never a history.
 * A stage or an error is read from a recognized diagnostic alone, and recognizing one is a convention — the marker
 * the bootstrap writes — rather than proof of who wrote the line. `tail` is the opposite of that: arbitrary text from
 * the child or anything it started, kept for a person to look at and never put into a failure message on its own.
 */
export interface PiStderrRecord {
	/**
	 * True once a diagnostic named the serving stage with no error of its own, and sticky from then on. It says that
	 * stage was seen and nothing more: it is not readiness, and it is no promise that nothing failed afterwards — a
	 * serving diagnostic can itself carry an error, and a later one can too. What says a child is actually serving is
	 * a correlated `get_state` that came back, which is the lifecycle's to require rather than this reader's.
	 */
	serving: boolean;
	lastStage?: string;
	stageCount: number;
	sdk?: string;
	failure?: PiStderrFailure;
	/** Lines the line cap cut. None of them was parsed, and none of them reached the tail. */
	truncatedLines: number;
	/** Every line read at all: recognized diagnostics, tail lines, cut lines and one unterminated last line. */
	lines: number;
	tail: string;
	/**
	 * How much of its stderr this record does not hold — as one total of two counts that are not in the same units, and
	 * deliberately so: what is wanted here is a number that says something was left out, not a ledger of the wire.
	 *
	 * A line the line cap cut contributes the line's own raw bytes, every byte it took before its LF and the part that
	 * was retained included, because this reader frames in drop mode and keeps none of such a line. The other half is
	 * the tail's own eviction, and it counts what this reader stored rather than what arrived: a tail line is held as
	 * its decoded text with an LF this reader appends, and whatever the tail cap pushed out later or never had room for
	 * is counted in those re-encoded bytes. So in that half, and only there, a byte the decoder had to replace is
	 * counted as the wider replacement it became; the appended separator is counted with the line even for a last one
	 * that arrived unterminated, whose LF was never on the wire; and a CR stripped from a CRLF was never retained at
	 * all, so it is in neither half.
	 *
	 * Their sum is therefore approximate omission accounting rather than byte-identity provenance: no byte of the wire
	 * is mapped to a byte of this count, and it is not an exact measure of what invalid utf8 cost. A recognized
	 * diagnostic's own fields are not in it — an error cut to the diagnostic cap says so with `cut` — and it never
	 * goes down.
	 */
	dropped: number;
}

/**
 * A short identifying field of a diagnostic — its stage, or the sdk version beside it — or nothing. A stage is a
 * label this host puts into its own failure messages, so it has to be one: non-empty, at most the field cap, and with
 * no control character in it that would put a line break in a message. That is stricter than "a string", on purpose,
 * and it is a recognition rule rather than a repair: a producer that ever wrote a stage outside it would leave the
 * line unrecognized, which falls back to the generic refusal a silent child gets rather than to a guessed stage. The
 * bootstrap's own stages — input, sdk, session, models, runtime, serving — are all well inside it.
 *
 * A diagnostic's `error` is not this. It is free-form diagnostic text and is kept as the child wrote it, bounded to
 * the diagnostic cap and otherwise faithful: nothing here strips characters from it or claims anything was redacted.
 */
function shortField(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || value.length > PI_DIAGNOSTIC_FIELD_MAX_CHARS) return undefined;
	// Written as code points rather than as an escape class. This is the one rule whose own characters must not be in
	// the source that describes them — a control byte here makes the file unreadable and a tool call it binary — and
	// comparing numbers says what is rejected without a reader having to decode an escape to find out.
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return undefined;
	}
	return value;
}

/** The first `max` bytes of a text, cut back to a character boundary so a prefix is never half a character. */
function keepFirstBytes(text: string, max: number): { text: string; bytes: number; cut: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= max) return { text, bytes: buffer.length, cut: false };
	let end = max;
	// A cut that lands inside a character lands on a continuation byte: step back to that character's own first byte.
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	const kept = buffer.subarray(0, end);
	return { text: kept.toString("utf8"), bytes: kept.length, cut: true };
}

/** The last `max` bytes of a text, from a character boundary, which is what a rolling tail keeps. */
function keepLastBytes(text: string, max: number): { text: string; bytes: number } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= max) return { text, bytes: buffer.length };
	let at = buffer.length - max;
	while (at < buffer.length && (buffer[at] & 0xc0) === 0x80) at += 1;
	const kept = buffer.subarray(at);
	return { text: kept.toString("utf8"), bytes: kept.length };
}

/**
 * The child's stderr, read through the framer and kept inside the bounds. A complete, untruncated line that parses to
 * an object carrying the bootstrap's marker and a string stage is a diagnostic, and its fields replace the ones before
 * them; everything else is text, and text goes to the bounded tail. A cut line is neither: it is counted and dropped,
 * because half a line parsed is an invented stage and half a line in the tail reads as a whole one.
 */
export class StderrReader {
	private readonly framer: LineFramer;
	private readonly tailMax: number;
	private readonly diagnosticMax: number;
	private readonly state = { serving: false, stageCount: 0, truncatedLines: 0, lines: 0 };
	private lastStage: string | undefined;
	private sdk: string | undefined;
	private failure: PiStderrFailure | undefined;
	private tail = "";
	private tailBytes = 0;
	private evicted = 0;

	constructor(bounds: Readonly<PiBounds> = PI_BOUNDS) {
		this.framer = new LineFramer(bounds.maxStderrLineBytes, "drop");
		this.tailMax = bounds.maxStderrTailBytes;
		this.diagnosticMax = bounds.maxDiagnosticBytes;
	}

	push(chunk: Buffer): void {
		for (const line of this.framer.push(chunk)) this.read(line);
	}

	/** The end of the child's stderr. Whatever came after the last LF is text, and is never read as a diagnostic. */
	end(): void {
		for (const line of this.framer.end()) this.read(line);
	}

	/**
	 * The one field of the record a reader watches rather than reports: the lifecycle asks after every stderr chunk,
	 * and building the whole record — the tail included — to read one boolean would copy it for each one.
	 */
	get serving(): boolean {
		return this.state.serving;
	}

	get record(): PiStderrRecord {
		return {
			serving: this.state.serving,
			...(this.lastStage === undefined ? {} : { lastStage: this.lastStage }),
			stageCount: this.state.stageCount,
			...(this.sdk === undefined ? {} : { sdk: this.sdk }),
			...(this.failure === undefined ? {} : { failure: { ...this.failure } }),
			truncatedLines: this.state.truncatedLines,
			lines: this.state.lines,
			tail: this.tail,
			dropped: this.framer.counters.dropped + this.evicted,
		};
	}

	private read(line: PiLine): void {
		this.state.lines += 1;
		if (line.truncated) {
			this.state.truncatedLines += 1;
			return;
		}
		// A line with no LF after it is text whose end nobody saw, so it is kept and never parsed.
		if (!line.partial && this.diagnostic(line.text)) return;
		this.addTail(line.text);
	}

	private diagnostic(text: string): boolean {
		// A cheap refusal first: every diagnostic carries the marker, and most stderr lines are not json at all.
		if (!text.includes(DIAGNOSTIC_EVENT)) return false;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return false;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const record = value as { [key: string]: unknown };
		if (record.event !== DIAGNOSTIC_EVENT) return false;
		const stage = shortField(record.stage);
		if (stage === undefined) return false;
		this.state.stageCount += 1;
		this.lastStage = stage;
		if (stage === PI_SERVING_STAGE && record.error === undefined) this.state.serving = true;
		const sdk = shortField(record.sdk);
		if (sdk !== undefined) this.sdk = sdk;
		if (record.error !== undefined) {
			// An error that is not text is a diagnostic all the same: the stage is what says where the child stopped.
			const error = typeof record.error === "string" && record.error !== "" ? keepFirstBytes(record.error, this.diagnosticMax) : undefined;
			this.failure = { stage, ...(error === undefined ? {} : { error: error.text }), cut: error?.cut ?? false };
		}
		return true;
	}

	private addTail(text: string): void {
		const line = `${text}\n`;
		this.tail += line;
		this.tailBytes += Buffer.byteLength(line);
		if (this.tailBytes <= this.tailMax) return;
		const kept = keepLastBytes(this.tail, this.tailMax);
		this.evicted += this.tailBytes - kept.bytes;
		this.tail = kept.text;
		this.tailBytes = kept.bytes;
	}
}

/**
 * What this transport can fail with, and the whole of it.
 *
 * `startup` is a child that never became ready: a recognized diagnostic names the stage it stopped at, and the bootstrap's
 * own configuration exit with nothing readable behind it is that same kind, carrying the generic refusal wording
 * below rather than a guessed stage. `refused` is a call this side would not send at all — a frame past the outbound
 * cap, a pending slot it does not have, a command name it keeps for itself — decided here and never by the child.
 * `busy` is a turn already running, which is the run's state rather than a local limit. `exited` is a child that
 * ended when it was not asked to, and `closed` is a transport that has nothing left to send on.
 *
 * `unverified` is the one that says nothing about the child at all: a finalization that threw instead of reporting, so
 * no cleanup report was written and this host cannot say what became of the process. It is the absence of evidence
 * given a name, which is why it carries no exit, no stage and no record — inventing any of those is the failure this
 * kind exists to avoid.
 */
export type PiFailureKind = "spawn" | "startup" | "exited" | "protocol" | "timeout" | "closed" | "aborted" | "unstoppable" | "refused" | "busy" | "unverified";

/**
 * One failure, as the lifecycle records and reports it. The message is composed here out of fixed text, the stage a
 * diagnostic named, the exit the process had and a recognized bootstrap error cut to the diagnostic cap. Nothing else
 * may reach it: not a command line, not an environment, not the input a call was composed from, not the raw stderr
 * tail and not the text of an error some other library threw.
 */
export interface PiFailure {
	kind: PiFailureKind;
	message: string;
	stage?: string;
	exit?: ExitOutcome;
}

const FAILURE_TEXT: { [kind in PiFailureKind]: string } = {
	spawn: "the pi child could not be started",
	// Ready, rather than serving: the bootstrap's serving diagnostic says a stage was reached, and a child that wrote
	// it and then answered nothing never became ready. Saying "serving stage" here would name the weaker of the two.
	startup: "the pi child did not become ready",
	exited: "the pi child exited before its work was done",
	protocol: "the pi child sent something this transport cannot read",
	timeout: "the pi child did not answer inside its bound",
	closed: "this transport is closed",
	aborted: "the run was cancelled",
	unstoppable: "the pi child could not be stopped",
	refused: "this transport would not send this call",
	busy: "the pi child already has a turn running",
	// One fixed sentence, and the whole of what this host may say: no thrown value, no cause, no guessed exit and no
	// claim in either direction about whether the process is still running.
	unverified: "the pi child's cleanup produced no report, and the state of its process is unverified",
};

/**
 * What a child that exited with the bootstrap's own configuration code and left nothing readable is reported with. It
 * is a startup failure like any other — the kind says what happened, and no stage is invented for it — and this says
 * only what is known: that it refused before it served, with the line counts beside it and nothing from the text.
 */
const SILENT_REFUSAL = "it refused the call before it could serve, and left no diagnostic this host could read";

/** What may be added to a failure's fixed text, and all that may be. */
export interface PiFailureDetail {
	stage?: string;
	exit?: ExitOutcome;
	/** A recognized bootstrap error, cut to the diagnostic cap by whoever read it. Never the raw stderr tail. */
	error?: string;
	/** One of this module's own fixed phrases. Never a value that arrived from anywhere. */
	reason?: string;
	/** What a refusal can say when nothing readable came back: how many stderr lines there were, and how many were cut. */
	counts?: { lines: number; truncated: number };
}

const exitText = (exit: ExitOutcome): string => {
	if (exit.signal !== null) return `signal ${exit.signal}`;
	return exit.code === null ? "no exit code and no signal" : `exit code ${exit.code}`;
};

export function piFailure(kind: PiFailureKind, detail: PiFailureDetail = {}): PiFailure {
	let message = FAILURE_TEXT[kind];
	if (detail.stage !== undefined) message += ` at the ${detail.stage} stage`;
	if (detail.exit !== undefined) message += ` (${exitText(detail.exit)})`;
	if (detail.reason !== undefined) message += `: ${detail.reason}`;
	if (detail.counts !== undefined) message += ` (${detail.counts.lines} stderr lines, ${detail.counts.truncated} of them cut)`;
	if (detail.error !== undefined) message += `: ${detail.error}`;
	return {
		kind,
		message,
		...(detail.stage === undefined ? {} : { stage: detail.stage }),
		...(detail.exit === undefined ? {} : { exit: { ...detail.exit } }),
	};
}

/**
 * A failure as something that can be thrown and caught, carrying the record rather than a message alone.
 *
 * `finalExit` is on it for one caller: a startup that never handed a `PiChild` over. The child is finished by then and
 * nobody else holds it, so the whole `PiExit` — the cleanup report, the stderr record and the counters — travels with
 * the refusal or it is lost. It is a separate property because `exit` is the process's own code and signal and has
 * been since before this one existed, and one of the two would otherwise have to change meaning.
 */
export class PiTransportError extends Error {
	readonly kind: PiFailureKind;
	readonly stage?: string;
	readonly exit?: ExitOutcome;
	readonly finalExit?: PiExit;

	constructor(failure: PiFailure, finalExit?: PiExit) {
		super(failure.message);
		this.name = "PiTransportError";
		this.kind = failure.kind;
		if (failure.stage !== undefined) this.stage = failure.stage;
		if (failure.exit !== undefined) this.exit = failure.exit;
		if (finalExit !== undefined) this.finalExit = finalExit;
	}

	get failure(): PiFailure {
		return {
			kind: this.kind,
			message: this.message,
			...(this.stage === undefined ? {} : { stage: this.stage }),
			...(this.exit === undefined ? {} : { exit: { ...this.exit } }),
		};
	}
}

/**
 * What a child that never served failed with, decided from its own stderr record and its exit alone, and always of
 * kind `startup`: where it stopped is what varies, not what kind of failure it is. A recognized diagnostic names the
 * stage and carries its error; the bootstrap's configuration exit with nothing readable behind it takes the generic
 * refusal wording and the line counts instead, because a stage guessed from text that was discarded is an invention.
 * The lifecycle attaches the exit it observed; nothing here runs a process.
 */
export function startupFailure(record: PiStderrRecord, exit?: ExitOutcome, bounds: Readonly<PiBounds> = PI_BOUNDS): PiFailure {
	const at = exit === undefined ? {} : { exit };
	if (record.failure) {
		const error = record.failure.error === undefined ? undefined : keepFirstBytes(record.failure.error, bounds.maxDiagnosticBytes).text;
		return piFailure("startup", { stage: record.failure.stage, ...at, ...(error === undefined ? {} : { error }) });
	}
	if (exit?.code === STARTUP_EXIT_CODE) return piFailure("startup", { ...at, reason: SILENT_REFUSAL, counts: { lines: record.lines, truncated: record.truncatedLines } });
	return piFailure("startup", at);
}

/**
 * One response, in the shape this transport requires of it, with its data left exactly as it arrived: what a command
 * answered with is the bridge's to read, and this validates the envelope alone.
 */
export interface PiResponse {
	id: string;
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

export type PiResponseCheck = { ok: true; response: PiResponse } | { ok: false; failure: PiFailure };

const malformed = (reason: string): PiResponseCheck => ({ ok: false, failure: piFailure("protocol", { reason }) });

/**
 * A response as the native protocol declares it: an object saying `response`, the command it answers, whether that
 * command succeeded, and an error string when it did not. The id is a string here though the native shape leaves it
 * optional, because every request this transport sends carries one — a response with none, the native parse failure
 * among them, answers no request of ours and is a protocol failure rather than something to guess an owner for.
 */
export function validateResponse(value: unknown): PiResponseCheck {
	if (!value || typeof value !== "object" || Array.isArray(value)) return malformed("a response is a json object");
	const record = value as { [key: string]: unknown };
	if (record.type !== "response") return malformed("a response says its type is response");
	if (typeof record.command !== "string" || record.command === "") return malformed("a response names the command it answers");
	if (typeof record.success !== "boolean") return malformed("a response says whether its command succeeded");
	if (record.success === false && typeof record.error !== "string") return malformed("a failed response carries the error its command failed with");
	if (typeof record.id !== "string" || record.id === "") return malformed("a response repeats the id of the command it answers");
	const response: PiResponse = { id: record.id, command: record.command, success: record.success };
	if (record.success === false) response.error = record.error as string;
	if ("data" in record) response.data = record.data;
	return { ok: true, response };
}

/** The prefix every id this transport issues carries, so an id it never issued is recognizable as one. */
export const PI_REQUEST_PREFIX = "pi-fusion-";

/* The prefix holds no character a pattern reads as anything but itself, so the one constant above builds this. */
const CANONICAL_ID = new RegExp(`^${PI_REQUEST_PREFIX}[1-9][0-9]*$`);

/** What an id is: one this transport is waiting on, one it issued and is no longer waiting on, or one it never made. */
export type PiIdClass = "pending" | "late" | "impossible";

/** A request this transport is waiting for an answer to. */
export interface PiPendingRequest {
	readonly id: string;
	readonly command: string;
}

/** How a request ends: with the response that answered it, or with the failure that ended it instead. */
export type PiOutcome = { ok: true; response: PiResponse } | { ok: false; failure: PiFailure };

/**
 * What the correlator calls when a request settles, exactly once each and in this order. The caller owns the timer
 * completely: it starts it, it decides how long it runs, and it hands in the way to stop it, which this calls at the
 * moment the request leaves the pending map. The correlator starts no timer and holds no clock of its own, so
 * "settled once" is a property of this class rather than of every caller. Internal to this transport, not an
 * extension point: nothing outside it hands these in.
 */
export interface PiRequestHooks {
	stopTimer?(): void;
	settle(outcome: PiOutcome): void;
}

/** What a response is against the requests outstanding right now. A mismatch names the request the id belongs to. */
export type PiMatch = { state: "pending"; request: PiPendingRequest } | { state: "mismatch"; request: PiPendingRequest } | { state: "late" } | { state: "impossible" };

/**
 * Ids out, answers back. Ids are `pi-fusion-<n>` with n counted up from one, which is what lets a completed id stay
 * classifiable from the counter alone: nothing here keeps a set of ids it has finished with, so a long run's memory is
 * its outstanding requests and not its history. A late answer is not a failure — the lifecycle counts and drops it —
 * and an id this never issued is impossible, which is a protocol failure wherever it arrived from.
 */
export class PiCorrelator {
	private readonly max: number;
	private readonly pending = new Map<string, { request: PiPendingRequest; hooks: PiRequestHooks }>();
	private count = 0;

	constructor(bounds: Readonly<PiBounds> = PI_BOUNDS) {
		this.max = bounds.maxPendingRequests;
	}

	/** How many ids have ever been issued, which is also the largest one that can be anything but impossible. */
	get issued(): number {
		return this.count;
	}

	get size(): number {
		return this.pending.size;
	}

	/**
	 * The next id, for one command. Admission is here rather than at the writer: a request that cannot be waited on
	 * must not be written, so the cap refuses it before anything of it is composed. That refusal is this side's own —
	 * a slot this transport does not have — which is `refused`; a turn the child is already running is `busy`, and it
	 * is not decided here.
	 */
	issue(command: string, hooks: PiRequestHooks): PiPendingRequest {
		if (typeof command !== "string" || command === "") throw new TypeError("command must name the command this request carries");
		if (this.pending.size >= this.max) throw new PiTransportError(piFailure("refused"));
		this.count += 1;
		const request: PiPendingRequest = { id: `${PI_REQUEST_PREFIX}${this.count}`, command };
		this.pending.set(request.id, { request, hooks });
		return request;
	}

	classify(id: unknown): PiIdClass {
		if (typeof id !== "string") return "impossible";
		if (this.pending.has(id)) return "pending";
		if (!CANONICAL_ID.test(id)) return "impossible";
		const n = Number(id.slice(PI_REQUEST_PREFIX.length));
		return Number.isSafeInteger(n) && n >= 1 && n <= this.count ? "late" : "impossible";
	}

	/** Which request a response belongs to, if any. A response that answers another command answers this one nowhere. */
	match(response: PiResponse): PiMatch {
		const state = this.classify(response.id);
		if (state !== "pending") return { state };
		const entry = this.pending.get(response.id)!;
		return { state: response.command === entry.request.command ? "pending" : "mismatch", request: entry.request };
	}

	/**
	 * Ends one request, once. The record goes before either hook runs, so a hook that settles again — or a response
	 * that arrives twice — finds nothing to settle and is told so. Dropping a request that was never written is this
	 * same call with a failure: there is no way to remove a pending record without settling it.
	 */
	settle(id: string, outcome: PiOutcome): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		entry.hooks.stopTimer?.();
		entry.hooks.settle(outcome);
		return true;
	}

	/**
	 * Ends every outstanding request with one failure, which is what a close, an abort or a lost child does.
	 *
	 * Every id in the snapshot taken here is attempted, one hook throwing included: a caller whose own settle hook fails
	 * must not leave the request behind it waiting for an answer that is never coming. The first value thrown is kept as
	 * it was thrown — a falsy one included, which is why it is held in a wrapper rather than tested for truth — and comes
	 * back out after the loop, so nothing is swallowed and no other error replaces it.
	 *
	 * The count is what was settled and no more than that: an id whose hook threw is not in it, because `settle` throws
	 * before it can answer true, and claiming it would be inventing a settlement that the caller never saw. That id is
	 * still gone from the pending map — a record is removed before either hook runs — so a second pass over what is left
	 * finds nothing of it and replays no hook.
	 */
	settleAll(failure: PiFailure): number {
		let settled = 0;
		let thrown: { error: unknown } | undefined;
		for (const id of [...this.pending.keys()]) {
			try {
				if (this.settle(id, { ok: false, failure })) settled += 1;
			} catch (error) {
				thrown ??= { error };
			}
		}
		if (thrown) throw thrown.error;
		return settled;
	}
}

/* ------------------------------------------------------------------------------------------------------------------
 * The lifecycle: one child, from the spawn to the exit. Everything below owns a process; nothing above it does.
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * How long a dialog id may be, in utf-16 code units. An id is the child's own text and this host records one per
 * dialog, so it is held to a length before it is kept: Pi's own are uuids, and a bound here is what keeps the record
 * of open dialogs a bound on memory rather than a promise about it.
 */
export const PI_UI_ID_MAX_CHARS = 128;

/** What one `extension_error` may carry into a turn's report: the error itself, and the two short fields beside it. */
export const PI_EXTENSION_ERROR_MAX_BYTES = 4 * 1024;
export const PI_EXTENSION_PATH_MAX_CHARS = 512;
export const PI_EXTENSION_EVENT_MAX_CHARS = 128;

/**
 * One record the child streamed that is neither a response nor an extension ui record: the native session events, as
 * they arrived and with nothing added. This transport keeps no history of them — a caller that wants one keeps it.
 */
export interface PiEvent {
	type: string;
	[key: string]: unknown;
}

/**
 * One extension ui record, handed to the caller as it arrived. `expectsResponse` is this transport's reading of the
 * method against 0.85.1's own list — `select`, `confirm`, `input` and `editor` block the extension that called them,
 * and the fire-and-forget methods do not — and it is what decides whether the caller's answer means anything.
 */
export interface PiUiRequest {
	id: string;
	method: string;
	expectsResponse: boolean;
	/** The whole record, opaque: what a method's own fields mean is the bridge's to read and not this transport's. */
	record: Record<string, unknown>;
}

/** The three answers the native protocol takes to a dialog, and the whole of what may be sent back for one. */
export type PiUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

/** One `extension_error`, cut to what a turn's report may carry. Each field says for itself whether a cap cut it. */
export interface PiExtensionError {
	error: string;
	extensionPath?: string;
	event?: string;
	/** Which of the three were cut. Nothing here is elided or redacted: a cut is a prefix, and it says so. */
	cut: { error: boolean; extensionPath: boolean; event: boolean };
}

/**
 * How one turn ended. `settled` is the child's own quiescence and says nothing about whether the work succeeded;
 * `acknowledged` is a caller that asked to be done at the acknowledgement because it knows its prompt runs no agent
 * loop; `rejected` is a prompt the child refused; `aborted`, `exited` and `failed` are the three ways the turn ended
 * without the child saying it was finished.
 */
export interface PiTurn {
	outcome: "settled" | "acknowledged" | "rejected" | "aborted" | "exited" | "failed";
	/** The response to the prompt itself, where one arrived: it is the acknowledgement, not the work's result. */
	ack?: PiResponse;
	/** Settles between the prompt reaching stdin and its acknowledgement. Counted, never taken for the turn's end. */
	earlySettles: number;
	extensionErrors: number;
	lastExtensionError?: PiExtensionError;
	/** Records forwarded to the caller while this turn was live, the acknowledgement's own response excepted. */
	events: number;
	failure?: PiFailure;
}

/**
 * What one child did that a number can say, kept for the exit record rather than for a decision: nothing in the
 * lifecycle branches on any of these. Each counts records or events, and none of them measures memory or time.
 */
export interface PiCounters {
	/** `agent_settled` records that belonged to no turn: none was running, or its prompt had not been written yet. */
	straySettles: number;
	/** `agent_settled` records after a prompt reached stdin and before it was acknowledged. Counted, not accepted. */
	earlySettles: number;
	/** Responses to requests this transport had already settled — a timed-out one answered afterwards. Dropped. */
	lateResponses: number;
	/** `extension_error` records the child streamed. The last of them is kept, bounded; the ones before it are not. */
	extensionErrors: number;
	/** Dialogs this transport answered itself: the caller would not take one, or there was no room to hold it open. */
	uiCancelledByTransport: number;
	/** Extension ui records naming a method neither 0.85.1's dialogs nor its fire-and-forget list knows. */
	unknownUiMethods: number;
	/** Exceptions `onEvent` and `onUiRequest` threw, caught here so a child is never lost to a caller's own error. */
	listenerErrors: number;
	/** Records read and delivered nowhere, and answers accepted for writing and then dropped unwritten. */
	droppedFrames: number;
	/** How many of the child's two pipes had neither ended nor closed when this transport stopped waiting: 0, 1 or 2. */
	streamsUnclosed: number;
}

/**
 * How one child ended, and everything this transport knows about it. `failure` is absent only for a child this host
 * asked to stop that then stopped: an exit nobody asked for is a failure whatever its code was, and a root the
 * cleanup could not stop is one whatever the turn did.
 */
export interface PiExit {
	exit: ExitOutcome;
	cleanup: CleanupReport;
	stderr: PiStderrRecord;
	failure?: PiFailure;
	/** True when this transport asked the child to stop, or the tree killed it, rather than the child ending itself. */
	stoppedByUs: boolean;
	counters: PiCounters;
}

/**
 * What one child is started with. `launch` is composed elsewhere — this module resolves no path, reads no file and
 * names no bootstrap — and `cleanup` and `bounds` are internal seams a test reaches, never a user setting.
 */
export interface PiChildOptions {
	launch: LaunchOptions;
	/** Cancellation from above. A signal that is already aborted is a call that never spawns anything. */
	signal?: AbortSignal;
	killGraceMs?: number;
	cleanup?: OwnedCleanup;
	bounds?: Partial<PiBounds>;
	/** Called synchronously, in the child's own order, for every record that is not a response or a ui request. */
	onEvent?: (event: PiEvent) => void;
	/**
	 * Called for every extension ui record. Its answer means something for a dialog alone: `true` says the caller has
	 * taken the dialog and will answer it through `respond`, and anything else — `false`, no handler, or a throw —
	 * leaves this transport to cancel it, so a child is never left blocked on a dialog nobody owns.
	 */
	onUiRequest?: (request: PiUiRequest) => boolean;
}

/** One child as its caller drives it. Every method here is refused once the child is closing or gone. */
export interface PiChild {
	readonly pid: number;
	/**
	 * What the first `get_state` answered with: the session id the child opened, and that whole answer beside it.
	 * This is readiness and nothing else — that the child is up and correlating. Whether the session it named is the
	 * one a record may be written against is the bridge's question, and it is not answered here.
	 */
	readonly startState: { sessionId: string; raw: Record<string, unknown> };
	readonly counters: PiCounters;
	/**
	 * How this child ended, once it has. It rejects instead, with an `unverified` failure and no record on it, for the
	 * one case where there is nothing to report: a cleanup that threw rather than answering, after which what became of
	 * the process is not something this host knows. A resolved value is always a real report.
	 */
	readonly exited: Promise<PiExit>;
	/** One command and its answer. A refusal, a timeout and a child that went away all arrive as a rejection. */
	request(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<PiResponse>;
	/**
	 * One prompt and the run it starts. Rejects only for what is refused before the prompt is admitted — another turn
	 * already running, a closed transport, no room to wait on or to queue it — and otherwise resolves with how the
	 * turn ended, failures included. A turn is never two promises for one prompt.
	 */
	turn(text: string, opts?: { streamingBehavior?: "steer" | "followUp"; completion?: "settled" | "acknowledged" }): Promise<PiTurn>;
	/**
	 * Answers one dialog. `sent` means admitted for writing and nothing about the child having read it; `duplicate` is
	 * an id that is already answered or was dropped unwritten, `unknown` one this transport never recorded, and `closed`
	 * a transport with nothing left to send on. An answer that is not one of the three shapes, or that is too large to
	 * frame, is the caller's own error and throws.
	 *
	 * A queue with no room for it throws too, with a `refused` failure, and that one says nothing is spent: the dialog is
	 * still open and still this caller's to answer or this transport's to cancel. What it does not mean is that the
	 * dialog was answered and lost — an answer that went out and was then dropped unwritten is `duplicate` afterwards.
	 */
	respond(id: string, response: PiUiResponse): "sent" | "duplicate" | "unknown" | "closed";
	/**
	 * Stops this child and reports how it ended. Called more than once it is the same shutdown and the same answer. It
	 * rejects, exactly as `exited` does and with that same refusal, when the cleanup produced no report at all.
	 */
	shutdown(reason?: "host" | "aborted"): Promise<PiExit>;
}

/**
 * The commands this transport issues for itself. A caller that sent one of them would answer its own turn, cancel a
 * dialog this side is arbitrating, or race the shutdown's own ordering, so they are refused before anything queues.
 */
const RESERVED_COMMANDS = new Set(["prompt", "extension_ui_response", "abort", "clear_queue"]);

/** The two a caller may send only while a turn of its own is admitted: neither means anything without one. */
const TURN_COMMANDS = new Set(["steer", "follow_up"]);

/** The dialog methods of 0.85.1: each one blocks the extension that called it until an answer with its id arrives. */
const UI_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** The fire-and-forget methods of 0.85.1. Each is a record to look at; none of them is waiting for anything. */
const UI_FIRE_AND_FORGET = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

/* Every fixed phrase a lifecycle failure can carry. Each is this module's own text; none of it comes from anywhere. */
const OVERSIZED_RECORD = "a record from it is longer than this transport reads";
const NOT_JSON = "a record from it is not json";
const NOT_OBJECT = "a record from it is not a json object";
const NO_TYPE = "a record from it does not say what type it is";
const UNKNOWN_ID = "a response from it carries an id this transport never issued";
const CROSSED_ID = "a response from it answers a command other than the one its id was issued for";
const UI_NO_ID = "an extension ui request from it carries no id this transport can hold";
const UI_NO_METHOD = "an extension ui request from it names no method";
const UI_REOPENED = "it opened a second dialog under an id that is already open";
const UI_IDS_EXHAUSTED = "the child opened more dialogs than this transport records";
const TRAILING_RECORD = "its last record was cut off before its end";
const STATE_REFUSED = "it refused the first state request this transport made";
const STATE_UNREADABLE = "its first state answer does not name the session it opened";

/** A deferred, which is what a protocol read resolving a caller's await needs and what an async function cannot be. */
interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

/** The first `max` code points of a text, so a cut never leaves half a character behind. */
const keepFirstChars = (value: unknown, max: number): { text: string; cut: boolean } | undefined => {
	if (typeof value !== "string" || value === "") return undefined;
	const chars = [...value];
	return chars.length <= max ? { text: value, cut: false } : { text: chars.slice(0, max).join(""), cut: true };
};

/** One `extension_error` cut to what a report may carry. A field that is not text is left out rather than stringified. */
function boundExtensionError(record: Record<string, unknown>, bounds: Readonly<PiBounds>): PiExtensionError {
	const error = typeof record.error === "string" ? keepFirstBytes(record.error, Math.min(PI_EXTENSION_ERROR_MAX_BYTES, bounds.maxDiagnosticBytes)) : undefined;
	const at = keepFirstChars(record.extensionPath, PI_EXTENSION_PATH_MAX_CHARS);
	const event = keepFirstChars(record.event, PI_EXTENSION_EVENT_MAX_CHARS);
	return {
		error: error?.text ?? "",
		...(at === undefined ? {} : { extensionPath: at.text }),
		...(event === undefined ? {} : { event: event.text }),
		cut: { error: error?.cut ?? false, extensionPath: at?.cut ?? false, event: event?.cut ?? false },
	};
}

/** One dialog answer, checked before it can become a frame. A caller that composed something else made a mistake. */
function checkUiResponse(response: PiUiResponse): Record<string, unknown> {
	const value = response as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("a dialog answer is an object carrying value, confirmed or cancelled");
	const record = value as { [key: string]: unknown };
	const keys = Object.keys(record);
	if (keys.length !== 1) throw new TypeError("a dialog answer carries exactly one of value, confirmed and cancelled");
	if (keys[0] === "value" && typeof record.value === "string") return { value: record.value };
	if (keys[0] === "confirmed" && typeof record.confirmed === "boolean") return { confirmed: record.confirmed };
	if (keys[0] === "cancelled" && record.cancelled === true) return { cancelled: true };
	throw new TypeError("a dialog answer is a string value, a boolean confirmed, or cancelled true");
}

const positiveTimer = (what: string, value: number): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${what} must be a positive safe integer`);
	if (value > MAX_TIMER_MS) throw new TypeError(`${what} must be at most ${MAX_TIMER_MS}, which is as long as one timer can run`);
	return value;
};

/** Which kind of record a queued frame is, so a shutdown can drop what is the caller's and keep what is its own. */
type PiWriteKind = "request" | "dialog" | "control";

interface PiWriteItem {
	kind: PiWriteKind;
	/** The request id or dialog id this frame belongs to, so dropping it settles or marks exactly its one owner. */
	owner: string;
	text: string;
	bytes: number;
	/** Run once, synchronously, at the moment the frame was handed to `stdin.write` and not when it was queued. */
	onHandoff?: () => void;
}

/**
 * The one way anything reaches the child: a bounded FIFO in front of its stdin.
 *
 * Bounded in two ways at once, because one frame's size and the number of frames are two different ways to run out of
 * memory, and the caps are derived from the bounds rather than set beside them. A queue that is full refuses
 * admission: it never waits and never retries, because a caller waiting for room is a caller whose own deadline is
 * being spent by a child that is not reading. Backpressure is honoured — a `write` that answered false gates every
 * later write until `drain` — and a close, an error or a destroyed pipe releases that gate rather than leaving a
 * frame waiting for a drain that cannot come.
 */
class PiWriter {
	private readonly queue: PiWriteItem[] = [];
	private stream?: Writable;
	private bytes = 0;
	private blocked = false;
	private shut = false;
	private readonly caps: PiWriterCaps;
	/** What becomes of frames that will never be written: called once per item, with the items in queue order. */
	private readonly onDropped: (items: PiWriteItem[]) => void;

	constructor(caps: PiWriterCaps, onDropped: (items: PiWriteItem[]) => void) {
		this.caps = caps;
		this.onDropped = onDropped;
	}

	attach(stream: Writable | undefined): void {
		if (!stream) {
			this.close();
			return;
		}
		this.stream = stream;
		this.pump();
	}

	/** True while a frame could still reach the child. A closed writer refuses everything, for good. */
	get open(): boolean {
		return !this.shut;
	}

	enqueue(item: PiWriteItem): boolean {
		if (this.shut) return false;
		if (this.queue.length >= this.caps.items) return false;
		if (this.bytes + item.bytes > this.caps.bytes) return false;
		this.queue.push(item);
		this.bytes += item.bytes;
		this.pump();
		return true;
	}

	drained(): void {
		this.blocked = false;
		this.pump();
	}

	/** Removes every queued frame the filter names that has not been written, and hands them to the drop callback. */
	dropUnsent(matches: (item: PiWriteItem) => boolean): void {
		const dropped: PiWriteItem[] = [];
		const kept: PiWriteItem[] = [];
		for (const item of this.queue) (matches(item) ? dropped : kept).push(item);
		if (!dropped.length) return;
		this.queue.length = 0;
		this.queue.push(...kept);
		this.bytes = kept.reduce((total, item) => total + item.bytes, 0);
		this.onDropped(dropped);
	}

	/** The end of the writer: nothing more is admitted, and whatever was still waiting was never written. */
	close(): void {
		if (this.shut) return;
		this.shut = true;
		this.blocked = false;
		if (!this.queue.length) return;
		const dropped = this.queue.splice(0, this.queue.length);
		this.bytes = 0;
		this.onDropped(dropped);
	}

	private pump(): void {
		if (!this.stream || this.blocked || this.shut) return;
		while (this.queue.length) {
			// A pipe that is no longer writable takes nothing: the close listener above will release what is queued.
			if (!this.stream.writable) return;
			const item = this.queue.shift()!;
			this.bytes -= item.bytes;
			let accepted: boolean;
			try {
				accepted = this.stream.write(item.text);
			} catch {
				// The write itself threw, so this frame reached nothing: it goes back to the front and the pipe is done.
				this.queue.unshift(item);
				this.bytes += item.bytes;
				this.close();
				return;
			}
			item.onHandoff?.();
			if (!accepted) {
				this.blocked = true;
				return;
			}
		}
	}
}

/*
 * The two callbacks an abandoned pipe is left with. Declared here, at module scope, precisely so that neither of them
 * closes over a transport, a framer or a reader: a listener that stays on a stream must hold nothing this host owns.
 */
const DISCARD_CHUNK = (_chunk: Buffer): void => {};
const DO_NOTHING = (): void => {};

/**
 * One of the child's own pipes as this transport reads it. `finished` is whichever of `end` and `close` came first,
 * because an owned cleanup destroys a pipe it still holds and a destroyed pipe arrives as a `close` with no `end`
 * before it: waiting for both would be waiting for one that will never come. A stream that is not there at all — a
 * spawn that produced no stdio — is finished the moment it is attached, so nothing waits on it either.
 */
class PipeReader {
	private readonly done = deferred<void>();
	private onChunk: (chunk: Buffer) => void;
	private onFinish: () => void;
	private over = false;
	private given = false;

	constructor(stream: Readable | undefined, onChunk: (chunk: Buffer) => void, onFinish: () => void) {
		this.onChunk = onChunk;
		this.onFinish = onFinish;
		if (!stream) {
			this.finish();
			return;
		}
		stream.on("data", (chunk: Buffer | string) => {
			if (this.over) return;
			this.onChunk(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		});
		stream.on("end", () => this.finish());
		stream.on("close", () => this.finish());
		stream.on("error", () => this.finish());
	}

	get finished(): boolean {
		return this.over;
	}

	/** True once this reader was given up on. It is not `finished`: nothing here says the stream ever closed. */
	get abandoned(): boolean {
		return this.given;
	}

	/**
	 * Gives up on reading this pipe, and claims nothing about it.
	 *
	 * What it does: drops the two callbacks, so neither the framer nor the transport is reachable through this reader or
	 * through the listeners it installed. What it deliberately does not do: end the stream, destroy it, mark this reader
	 * finished or resolve the wait as if a close had happened. Nothing observed a close, so nothing says one happened.
	 *
	 * The stream's own listeners stay on until it actually closes, and that is the policy rather than an oversight: the
	 * child may still be running with this pipe as its stdout, and a reader that removed its `data` listener would leave
	 * it to fill the pipe and block on a write nobody is draining. So the data that arrives is read and discarded, an
	 * error is taken and ignored, and a real `end`, `close` or `error` still resolves this reader's own wait — for
	 * nobody, since `onFinish` is gone. Discarding is what this does; it is not a claim that the child stopped writing.
	 */
	abandon(): void {
		this.given = true;
		this.onChunk = DISCARD_CHUNK;
		this.onFinish = DO_NOTHING;
	}

	/** Whether this pipe finished inside the bound. A pipe a descendant is still holding answers false and is counted. */
	async closedWithin(ms: number): Promise<boolean> {
		if (this.over) return true;
		let timer: NodeJS.Timeout | undefined;
		const bound = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		});
		try {
			return await Promise.race([this.done.promise.then(() => true), bound]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private finish(): void {
		if (this.over) return;
		this.over = true;
		this.onFinish();
		this.done.resolve(undefined);
	}
}

/** One dialog id, for as long as this transport lives: what became of it, and whether its answer ever went out. */
interface PiUiEntry {
	state: "open" | "answered" | "dropped";
	delivery: "none" | "queued" | "written";
}

/** The turn in flight, which is at most one. Everything a `PiTurn` reports is accumulated here while it runs. */
interface PiTurnRecord {
	completion: "settled" | "acknowledged";
	requestId: string;
	/** True once the prompt reached `stdin.write`. Tracked apart from queueing, because a settle before it is stray. */
	written: boolean;
	acked: boolean;
	ack?: PiResponse;
	earlySettles: number;
	extensionErrors: number;
	lastExtensionError?: PiExtensionError;
	events: number;
	/** Fixed by a finalization, so a settle that lands afterwards releases a wait and never renames the outcome. */
	fixed?: PiTurn["outcome"];
	done: boolean;
	answer: Deferred<PiTurn>;
}

/** Why a child is being finished, which decides what an active turn becomes and whether this host asked for it. */
interface PiFinalCause {
	reason: "host" | "aborted" | "startup" | "protocol" | "timeout" | "exited" | "spawn";
	failure?: PiFailure;
}

class PiChildImpl implements PiChild {
	private readonly bounds: PiBounds;
	private readonly tree: ChildTree;
	private readonly writer: PiWriter;
	private readonly correlator: PiCorrelator;
	private readonly stdoutFramer: LineFramer;
	private readonly stderrReader: StderrReader;
	private readonly onEvent?: (event: PiEvent) => void;
	private readonly onUi?: (request: PiUiRequest) => boolean;
	private readonly signal?: AbortSignal;
	private readonly exitedAt = deferred<PiExit>();
	/* Rejects the moment a startup fails, so the two awaits in `start` do not have to be raced against the child. */
	private readonly startupGate = deferred<never>();
	private readonly servingAt = deferred<void>();
	private readonly tally: PiCounters = {
		straySettles: 0,
		earlySettles: 0,
		lateResponses: 0,
		extensionErrors: 0,
		uiCancelledByTransport: 0,
		unknownUiMethods: 0,
		listenerErrors: 0,
		droppedFrames: 0,
		streamsUnclosed: 0,
	};
	/* Every dialog id this transport has ever recorded, answered ones included. Nothing is evicted from it. */
	private readonly uiIds = new Map<string, PiUiEntry>();
	private readonly openUi = new Set<string>();
	private readonly stopWaiters: Array<() => void> = [];
	private state: "starting" | "ready" | "closing" | "ended" = "starting";
	private handle?: LaunchedProcess;
	private out?: PipeReader;
	private err?: PipeReader;
	private turnRecord?: PiTurnRecord;
	private failure?: PiFailure;
	private startupTimer?: NodeJS.Timeout;
	private abortListener?: () => void;
	/* This transport's own listeners on the root and on its stdin, so the exceptional path can take exactly those off. */
	private rootListeners?: { error: (error: unknown) => void; exit: (code: number | null, signal: NodeJS.Signals | null) => void };
	private stdinListeners?: { error: () => void; close: () => void; drain: () => void };
	private ending?: Promise<PiExit>;
	private exitSeen?: ExitOutcome;
	private spawnRefused = false;
	private stderrDone = false;
	private trailing = false;
	private requestedStop = false;
	private ready = false;
	private childPid = 0;
	private firstState: { sessionId: string; raw: Record<string, unknown> } = { sessionId: "", raw: {} };
	private readonly options: PiChildOptions;

	constructor(options: PiChildOptions, bounds: PiBounds) {
		this.options = options;
		this.bounds = bounds;
		this.onEvent = options.onEvent;
		this.onUi = options.onUiRequest;
		this.signal = options.signal;
		this.correlator = new PiCorrelator(bounds);
		this.stdoutFramer = new LineFramer(bounds.maxFrameBytes, "drop");
		this.stderrReader = new StderrReader(bounds);
		this.writer = new PiWriter(writerCaps(bounds), (items) => this.releaseDropped(items));
		this.tree = new ChildTree(options.killGraceMs ?? KILL_GRACE_MS, options.cleanup ?? {}, { stderr: "stream" });
		this.startupGate.promise.catch(() => {});
	}

	get pid(): number {
		return this.childPid;
	}

	get startState(): { sessionId: string; raw: Record<string, unknown> } {
		return this.firstState;
	}

	get counters(): PiCounters {
		return { ...this.tally };
	}

	get exited(): Promise<PiExit> {
		return this.exitedAt.promise;
	}

	/**
	 * Spawn to ready, under one deadline: the spawn itself, the bootstrap's own stages through the serving diagnostic,
	 * and the first correlated `get_state` after it. A child that fails anywhere in there is finished here and never
	 * handed over, and the whole exit record travels on the refusal because nobody else would be holding it.
	 */
	async start(): Promise<PiChild> {
		// An abort that arrived before the call did spawns nothing at all: there is no process to clean up after.
		if (this.signal?.aborted) throw await this.startupRefusal({ reason: "aborted", failure: piFailure("aborted") });
		try {
			this.handle = this.tree.spawn(this.options.launch);
		} catch {
			// `spawn` itself threw, so no process was made and no handle exists: node reports the ordinary failures
			// asynchronously instead, and those arrive as the root's own `error` below.
			this.spawnRefused = true;
			throw await this.startupRefusal({ reason: "spawn" });
		}
		// Every listener goes on before the first await, so nothing a child writes or does in the meantime is missed.
		this.bind();
		this.startupTimer = setTimeout(() => this.fail({ reason: "startup" }), this.bounds.startupMs);
		if (this.signal) {
			this.abortListener = () => this.fail({ reason: "aborted", failure: piFailure("aborted") });
			this.signal.addEventListener("abort", this.abortListener, { once: true });
		}
		try {
			// The serving diagnostic first, because a probe written before the bootstrap reached that stage would be
			// waiting on a child that is still building a runtime. It is a convention and nothing more: the bootstrap
			// writes that line *before* it calls `runRpcMode`, and `runRpcMode` is what binds the extensions and attaches
			// the child's own stdin reader, so the probe below can sit unread in the pipe for a while. What says the child
			// is up is the correlated, successful answer to that probe: never the diagnostic, and never a reader on the
			// other side that this host has no way to see.
			await Promise.race([this.servingAt.promise, this.startupGate.promise]);
			// A finalization that has already begun is the end of this startup, whatever else arrived: the race above
			// resolves on whichever of the two settled first, so a serving diagnostic and a failure in the same turn can
			// leave this line running with the child already closing.
			if (this.ending) throw await this.startupRefusal({ reason: "startup" });
			const response = await this.probe();
			// The same guard, and this is the one the race inside `probe` needs. One stdout chunk can carry the probe's own
			// answer and then a record that fails this transport, or an event whose listener aborts the run: the answer
			// settles the request first, the read of what follows it begins the finalization synchronously, and the race
			// can still hand back the answer that had already resolved. Readiness after that would reopen a closing child.
			//
			// The refusal is the finalization that is already running, which is memoized: `startup` here is only what an
			// exit with no recorded failure would fall back to, and it never replaces the cause that began it. Nothing
			// between this line and the publication of readiness below may await, or this guard is back where it started.
			if (this.ending) throw await this.startupRefusal({ reason: "startup" });
			if (!response.success) throw await this.startupRefusal({ reason: "startup", failure: piFailure("startup", { reason: STATE_REFUSED }) });
			const data = response.data;
			if (!data || typeof data !== "object" || Array.isArray(data) || typeof (data as { sessionId?: unknown }).sessionId !== "string" || (data as { sessionId: string }).sessionId === "") {
				throw await this.startupRefusal({ reason: "protocol", failure: piFailure("protocol", { reason: STATE_UNREADABLE }) });
			}
			const pid = this.tree.pid;
			if (pid === undefined) throw await this.startupRefusal({ reason: "spawn" });
			this.childPid = pid;
			this.firstState = { sessionId: (data as { sessionId: string }).sessionId, raw: data as Record<string, unknown> };
		} catch (error) {
			// A refusal that already carries the finished child's record is this startup's own answer and goes back out as
			// it is. Anything else thrown in there ends the startup as one that could not complete, and that is all it is
			// allowed to say: the value is not echoed, not classified and not read for a cause — it could be a throw from
			// anywhere — so `startup` here is a fixed fallback rather than a finding. What is reported instead is whatever
			// the finalization already recorded, which is authoritative; and a finalization that collapsed answers every
			// caller with its own memoized `unverified` rejection, which comes back out of this line unchanged.
			if (error instanceof PiTransportError && error.finalExit) throw error;
			throw await this.startupRefusal({ reason: "startup" });
		}
		this.clearStartupTimer();
		this.ready = true;
		this.state = "ready";
		return this;
	}

	async request(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<PiResponse> {
		// Every refusal here is decided before anything is composed or queued, and arrives as a rejection rather than
		// a throw, so one caller handles a refused call and a failed one the same way. The transport's own state is
		// read first: once it is closing there is nothing to send on, and saying so is more use to a caller than
		// which of the rules below a call it can no longer make would have broken.
		if (!command || typeof command !== "object" || Array.isArray(command)) return Promise.reject(new TypeError("a command is a json object naming its type"));
		if (typeof command.type !== "string" || command.type === "") return Promise.reject(new TypeError("a command names its type"));
		if (this.state !== "ready") return Promise.reject(new PiTransportError(this.closedFailure()));
		if ("id" in command) return Promise.reject(new PiTransportError(piFailure("refused")));
		if (RESERVED_COMMANDS.has(command.type)) return Promise.reject(new PiTransportError(piFailure("refused")));
		if (TURN_COMMANDS.has(command.type) && !this.admittedTurn()) return Promise.reject(new PiTransportError(piFailure("refused")));
		let bound: number;
		try {
			bound = timeoutMs === undefined ? this.bounds.requestMs : positiveTimer("timeoutMs", timeoutMs);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.send(command, bound, "request");
	}

	turn(text: string, opts: { streamingBehavior?: "steer" | "followUp"; completion?: "settled" | "acknowledged" } = {}): Promise<PiTurn> {
		if (typeof text !== "string") return Promise.reject(new TypeError("a turn is started with the text of its prompt"));
		if (opts.streamingBehavior !== undefined && opts.streamingBehavior !== "steer" && opts.streamingBehavior !== "followUp") {
			return Promise.reject(new TypeError("streamingBehavior is steer or followUp"));
		}
		if (opts.completion !== undefined && opts.completion !== "settled" && opts.completion !== "acknowledged") return Promise.reject(new TypeError("completion is settled or acknowledged"));
		// Closed before busy, for the same reason: a transport that is shutting down has a turn it is ending, and
		// telling a caller it is busy would invite it to try again on a child that is going away.
		if (this.state !== "ready") return Promise.reject(new PiTransportError(this.closedFailure()));
		if (this.turnRecord && !this.turnRecord.done) return Promise.reject(new PiTransportError(piFailure("busy")));

		// Registered before anything is written, because the acknowledgement and the settle that ends the turn can
		// arrive in one stdout chunk: a record created after the write would miss whichever of them came first.
		const record: PiTurnRecord = {
			completion: opts.completion ?? "settled",
			requestId: "",
			written: false,
			acked: false,
			earlySettles: 0,
			extensionErrors: 0,
			events: 0,
			done: false,
			answer: deferred<PiTurn>(),
		};
		this.turnRecord = record;

		let ackTimer: NodeJS.Timeout | undefined;
		let request: PiPendingRequest;
		try {
			request = this.correlator.issue("prompt", {
				// The correlator owns no clock: it stops this one at the moment the request leaves its pending map.
				stopTimer: () => {
					if (ackTimer !== undefined) clearTimeout(ackTimer);
				},
				settle: (outcome) => this.settledPrompt(record, outcome),
			});
		} catch (error) {
			this.turnRecord = undefined;
			return Promise.reject(error);
		}
		record.requestId = request.id;
		// The acknowledgement's clock starts at admission, so the wait for a writer slot is part of what it bounds.
		ackTimer = setTimeout(() => this.ackTimedOut(request.id), this.bounds.ackMs);

		const framed = this.frame({ id: request.id, type: "prompt", message: text, ...(opts.streamingBehavior === undefined ? {} : { streamingBehavior: opts.streamingBehavior }) });
		const queued = framed !== undefined && this.writer.enqueue({ kind: "request", owner: request.id, text: framed.text, bytes: framed.bytes, onHandoff: () => (record.written = true) });
		if (!queued) {
			// Nothing of this turn was ever admitted, so the caller is refused rather than handed a turn that failed.
			this.correlator.settle(request.id, { ok: false, failure: piFailure("refused") });
			record.done = true;
			this.turnRecord = undefined;
			return Promise.reject(new PiTransportError(piFailure("refused")));
		}
		return record.answer.promise;
	}

	respond(id: string, response: PiUiResponse): "sent" | "duplicate" | "unknown" | "closed" {
		const body = checkUiResponse(response);
		const entry = this.uiIds.get(id);
		if (!entry) return "unknown";
		if (entry.state !== "open") return "duplicate";
		if (this.state === "closing" || this.state === "ended" || !this.writer.open) return "closed";
		// An answer a caller composed that cannot be framed at all is that caller's own error, not a closed transport.
		const framed = this.frame({ type: "extension_ui_response", id, ...body });
		if (!framed) throw new PiTransportError(piFailure("refused"));
		// Marked before it is queued, because a queue with room writes it inside `enqueue` and the handoff hook is what
		// upgrades it: recording the answer afterwards would overwrite what the write itself had already recorded.
		entry.state = "answered";
		entry.delivery = "queued";
		this.openUi.delete(id);
		if (!this.writer.enqueue({ kind: "dialog", owner: id, text: framed.text, bytes: framed.bytes, onHandoff: () => (entry.delivery = "written") })) {
			// Nothing of this answer was admitted: no frame was queued, no hook ran and nothing was dropped, so the dialog
			// goes back exactly as it was and the caller is refused rather than told the transport is closed. It stays
			// answerable — by this caller when there is room again, or by the cancellation a shutdown sends.
			//
			// This is the one rollback, and it is decided by the admission alone. A write that threw after this frame was
			// admitted is not this: `enqueue` answered true, the drop callback has already spent the id, and reopening it
			// there would let one dialog be answered on the wire twice.
			entry.state = "open";
			entry.delivery = "none";
			this.openUi.add(id);
			throw new PiTransportError(piFailure("refused"));
		}
		// Accepted for writing, which is all this can say: the child's receipt is not something a writer observes.
		return "sent";
	}

	shutdown(reason: "host" | "aborted" = "host"): Promise<PiExit> {
		return this.finalize({ reason, ...(reason === "aborted" ? { failure: piFailure("aborted") } : {}) });
	}

	/* ---------------------------------------------------------------------------------------------------------- */

	private clearStartupTimer(): void {
		if (!this.startupTimer) return;
		clearTimeout(this.startupTimer);
		this.startupTimer = undefined;
	}

	private admittedTurn(): boolean {
		return this.turnRecord !== undefined && !this.turnRecord.done && this.turnRecord.written;
	}

	private closedFailure(): PiFailure {
		return piFailure(this.failure?.kind === "exited" ? "exited" : "closed");
	}

	private alive(): boolean {
		return this.tree.spawned && this.exitSeen === undefined;
	}

	/** One outbound frame, or nothing: a record that cannot be serialized, and one past the cap, are both refused. */
	private frame(record: Record<string, unknown>): { text: string; bytes: number } | undefined {
		let body: string;
		try {
			body = JSON.stringify(record);
		} catch {
			return undefined;
		}
		if (typeof body !== "string" || !body.startsWith("{")) return undefined;
		const text = `${body}\n`;
		const bytes = Buffer.byteLength(text);
		return bytes > this.bounds.maxOutboundFrameBytes ? undefined : { text, bytes };
	}

	private send(command: { type: string; [key: string]: unknown }, timeoutMs: number, kind: PiWriteKind): Promise<PiResponse> {
		const answer = deferred<PiResponse>();
		let timer: NodeJS.Timeout | undefined;
		let request: PiPendingRequest;
		try {
			request = this.correlator.issue(command.type, {
				stopTimer: () => {
					if (timer !== undefined) clearTimeout(timer);
				},
				settle: (outcome) => (outcome.ok ? answer.resolve(outcome.response) : answer.reject(new PiTransportError(outcome.failure))),
			});
		} catch (error) {
			return Promise.reject(error);
		}
		// At admission, so a frame that waits behind others spends the caller's bound rather than starting a new one.
		timer = setTimeout(() => this.requestTimedOut(request.id), timeoutMs);
		const framed = this.frame({ id: request.id, ...command });
		if (!framed || !this.writer.enqueue({ kind, owner: request.id, text: framed.text, bytes: framed.bytes })) {
			this.correlator.settle(request.id, { ok: false, failure: piFailure("refused") });
		}
		return answer.promise;
	}

	private probe(): Promise<PiResponse> {
		const asked = this.send({ type: "get_state" }, this.bounds.startupMs, "control");
		// The gate can reject first, and the loser of a race is left to nobody: this is where its rejection is taken.
		asked.catch(() => {});
		return Promise.race([asked, this.startupGate.promise]);
	}

	/** A request that ran out of time. The child is left running: whether that is worth stopping it over is the caller's. */
	private requestTimedOut(id: string): void {
		// Settled first and dropped after: dropping a frame settles its owner too, and the caller is owed the timeout
		// that ended its call rather than the closure that took the frame out of the queue.
		this.correlator.settle(id, { ok: false, failure: piFailure("timeout") });
		this.writer.dropUnsent((item) => item.owner === id);
	}

	/** A prompt that was never acknowledged, which is the one request whose bound ends the child rather than the call. */
	private ackTimedOut(id: string): void {
		void this.finalize({ reason: "timeout", failure: piFailure("timeout") });
		this.correlator.settle(id, { ok: false, failure: piFailure("timeout") });
	}

	private bind(): void {
		const handle = this.handle!;
		// Kept rather than inlined, so the exceptional path can take this transport's own listeners off again. The tree's
		// listeners are not these and are none of this transport's business.
		this.rootListeners = {
			error: (error: unknown) => this.rootError(error),
			exit: (code: number | null, signal: NodeJS.Signals | null) => this.rootExit({ code, signal }),
		};
		handle.on("error", this.rootListeners.error);
		handle.on("exit", this.rootListeners.exit);
		const stdin = handle.stdin as Writable | undefined;
		if (stdin) {
			// The tree already swallows stdin errors so none of them is thrown at the process; this is about the queue.
			this.stdinListeners = {
				error: () => this.writer.close(),
				close: () => this.writer.close(),
				drain: () => this.writer.drained(),
			};
			stdin.on("error", this.stdinListeners.error);
			stdin.on("close", this.stdinListeners.close);
			stdin.on("drain", this.stdinListeners.drain);
		}
		this.writer.attach(stdin);
		this.out = new PipeReader(handle.stdout, (chunk) => this.readStdout(chunk), () => this.endStdout());
		this.err = new PipeReader(handle.stderr, (chunk) => this.readStderr(chunk), () => this.endStderr());
	}

	/** Node reports a signal it could not deliver the same way it reports a spawn that never happened: by the pid. */
	private rootError(_error: unknown): void {
		if (this.tree.pid !== undefined) return;
		this.spawnRefused = true;
		this.fail({ reason: "spawn" });
	}

	private rootExit(exit: ExitOutcome): void {
		this.exitSeen = exit;
		this.releaseStop();
		this.fail({ reason: "exited", failure: piFailure("exited", { exit }) });
	}

	private readStderr(chunk: Buffer): void {
		// A reader that has ended refuses a push, and a throw out of a `data` listener is an uncaught exception. The
		// snapshot can end this reader while the pipe is still open — a descendant holding it past the bound — so a
		// chunk after that is dropped here rather than thrown at the process.
		if (this.stderrDone) return;
		this.stderrReader.push(chunk);
		// Sticky and observed here rather than polled: the reader turns it on at the first clean serving diagnostic.
		if (this.stderrReader.serving) this.servingAt.resolve(undefined);
	}

	private endStderr(): void {
		if (this.stderrDone) return;
		this.stderrDone = true;
		this.stderrReader.end();
		if (this.stderrReader.serving) this.servingAt.resolve(undefined);
	}

	private endStdout(): void {
		// Whatever came after the last LF is content the child wrote and no frame, so it is flagged rather than parsed.
		for (const line of this.stdoutFramer.end()) {
			if (line.partial && line.text !== "") this.trailing = true;
		}
	}

	private readStdout(chunk: Buffer): void {
		if (this.state === "ended") return;
		let lines: PiLine[];
		try {
			lines = this.stdoutFramer.push(chunk);
		} catch {
			return;
		}
		for (const [at, line] of lines.entries()) {
			if (this.readLine(line)) continue;
			// Whatever this chunk had already framed behind the line that stopped it was read off the wire and delivered
			// nowhere: counted here, once each, so a batch that ends in a refusal says how much of itself went unread.
			// The refused line is not among them — it is the reason rather than a casualty — and neither is anything
			// before it, which was delivered. Nothing of any of them is kept: this is a count and not a history.
			this.tally.droppedFrames += lines.length - at - 1;
			return;
		}
		// Both flags on every push: a flood with no LF in it is over the cap long before any line is completed, and
		// waiting for that line's end would be waiting for the child to decide how much this host holds.
		if (this.stdoutFramer.inProgress.truncated) this.protocol(OVERSIZED_RECORD);
	}

	/** One complete line. Answers false once something has stopped this transport from reading any more of them. */
	private readLine(line: PiLine): boolean {
		if (this.state === "ended") return false;
		if (line.truncated) {
			this.protocol(OVERSIZED_RECORD);
			return false;
		}
		if (line.partial) {
			if (line.text !== "") this.trailing = true;
			return false;
		}
		let value: unknown;
		try {
			value = JSON.parse(line.text);
		} catch {
			this.protocol(NOT_JSON);
			return false;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			this.protocol(NOT_OBJECT);
			return false;
		}
		const record = value as { [key: string]: unknown };
		if (typeof record.type !== "string" || record.type === "") {
			this.protocol(NO_TYPE);
			return false;
		}
		if (record.type === "response") return this.readResponse(record);
		if (record.type === "extension_ui_request") return this.readUi(record);
		this.readEvent(record as PiEvent);
		return true;
	}

	private readResponse(record: { [key: string]: unknown }): boolean {
		const check = validateResponse(record);
		if (!check.ok) {
			this.fail({ reason: "protocol", failure: check.failure });
			return false;
		}
		const match = this.correlator.match(check.response);
		if (match.state === "impossible") {
			this.protocol(UNKNOWN_ID);
			return false;
		}
		if (match.state === "mismatch") {
			this.protocol(CROSSED_ID);
			return false;
		}
		if (match.state === "late") {
			// A request this transport already gave up on, answered afterwards. It settles nothing and ends nothing.
			this.tally.lateResponses += 1;
			return true;
		}
		// Synchronously, inside this frame: the hooks are what move a turn from written to acknowledged, and the
		// settle that ends that turn can be the very next line of the same chunk.
		this.correlator.settle(check.response.id, { ok: true, response: check.response });
		return true;
	}

	/**
	 * Every record that is not a response and not a ui request. Two of them mean something here — the settle that ends
	 * a turn and the extension error a turn reports — and the rest are forwarded and not kept. `agent_end`,
	 * `auto_retry_start`, `compaction_start`, `compaction_end` and `extension_error` are all records a run can go on
	 * after, so none of them ends a turn: 0.85.1 says a run is over with `agent_settled` and with nothing else.
	 */
	private readEvent(event: PiEvent): void {
		// Counted before it is read, so the settle that ends a turn is one of that turn's own records rather than the
		// first of nobody's.
		const turn = this.turnRecord;
		if (turn && !turn.done) turn.events += 1;
		if (event.type === "agent_settled") this.settled();
		else if (event.type === "extension_error") this.extensionError(event);
		if (!this.onEvent) return;
		try {
			this.onEvent(event);
		} catch {
			this.tally.listenerErrors += 1;
		}
	}

	private settled(): void {
		// Any settle releases a shutdown that is waiting, this one's own turn or not: it is the child saying it has
		// stopped working, which is one of the three things that wait is for. It never renames a fixed outcome.
		this.releaseStop();
		const turn = this.turnRecord;
		if (!turn || turn.done || !turn.written) {
			this.tally.straySettles += 1;
			return;
		}
		if (!turn.acked) {
			this.tally.earlySettles += 1;
			turn.earlySettles += 1;
			return;
		}
		this.finishTurn(turn, "settled");
	}

	private extensionError(event: PiEvent): void {
		this.tally.extensionErrors += 1;
		const turn = this.turnRecord;
		if (!turn || turn.done) return;
		turn.extensionErrors += 1;
		turn.lastExtensionError = boundExtensionError(event, this.bounds);
	}

	private settledPrompt(record: PiTurnRecord, outcome: PiOutcome): void {
		if (!outcome.ok) {
			const kind = outcome.failure.kind;
			this.finishTurn(record, kind === "aborted" ? "aborted" : kind === "exited" ? "exited" : "failed", outcome.failure);
			return;
		}
		record.ack = outcome.response;
		if (!outcome.response.success) {
			this.finishTurn(record, "rejected");
			return;
		}
		record.acked = true;
		// A caller that knows its prompt runs no agent loop is done here; everything else waits for the quiescence.
		if (record.completion === "acknowledged") this.finishTurn(record, "acknowledged");
	}

	private finishTurn(record: PiTurnRecord, outcome: PiTurn["outcome"], failure?: PiFailure): void {
		if (record.done) return;
		record.done = true;
		// A finalization fixes the outcome before this runs, so a settle that arrives during a shutdown releases the
		// wait and is never reported as a turn that finished normally.
		const settled = record.fixed ?? outcome;
		const ended = settled === "settled" || settled === "acknowledged" || settled === "rejected";
		const reported = failure ?? (ended ? undefined : this.failure);
		record.answer.resolve({
			outcome: settled,
			...(record.ack === undefined ? {} : { ack: record.ack }),
			earlySettles: record.earlySettles,
			extensionErrors: record.extensionErrors,
			...(record.lastExtensionError === undefined ? {} : { lastExtensionError: record.lastExtensionError }),
			events: record.events,
			...(reported === undefined ? {} : { failure: reported }),
		});
	}

	/* ---------------------------------------------------------------------------------------------------------- */

	private readUi(record: { [key: string]: unknown }): boolean {
		const id = record.id;
		const method = record.method;
		if (typeof id !== "string" || id === "" || id.length > PI_UI_ID_MAX_CHARS) {
			this.protocol(UI_NO_ID);
			return false;
		}
		if (typeof method !== "string" || method === "") {
			this.protocol(UI_NO_METHOD);
			return false;
		}
		if (!UI_DIALOG_METHODS.has(method) && !UI_FIRE_AND_FORGET.has(method)) {
			// A method neither list knows is treated as one nothing is waiting on: answering an unknown id is how a
			// client makes up a protocol, and this build's own lists are what say which ones block an extension.
			this.tally.unknownUiMethods += 1;
		}
		if (!UI_DIALOG_METHODS.has(method)) {
			if (this.state !== "ready") {
				this.tally.droppedFrames += 1;
				return true;
			}
			this.dispatchUi({ id, method, expectsResponse: false, record });
			return true;
		}
		const seen = this.uiIds.get(id);
		if (seen) {
			if (seen.state === "open") {
				this.protocol(UI_REOPENED);
				return false;
			}
			// An id this transport already answered. Nothing is dispatched and nothing is sent: one dialog, one answer.
			this.tally.droppedFrames += 1;
			return true;
		}
		if (this.uiIds.size >= this.bounds.maxUiIds) {
			// The lifetime cap has no eviction, so there is no room to record this id and no way to answer it safely.
			// The child is finished rather than left holding a dialog this host has stopped being able to account for.
			this.protocol(UI_IDS_EXHAUSTED);
			return false;
		}
		// Recorded before anything is queued, so an answer can never go out under an id this transport is not holding.
		this.uiIds.set(id, { state: "open", delivery: "none" });
		this.openUi.add(id);
		// Closing: a dialog is not handed to the caller any more, and the cancellation it gets is queued behind the
		// shutdown's own controls rather than in front of them, because the queue is one FIFO and they are in it.
		if (this.state !== "ready" || this.openUi.size > this.bounds.maxOpenUiRequests) {
			this.cancelDialog(id);
			return true;
		}
		let taken = false;
		try {
			taken = this.onUi?.({ id, method, expectsResponse: true, record }) === true;
		} catch {
			this.tally.listenerErrors += 1;
		}
		// A handler that answered inside the call has already arbitrated, whatever it went on to return.
		if (!taken && this.uiIds.get(id)?.state === "open") this.cancelDialog(id);
		return true;
	}

	private dispatchUi(request: PiUiRequest): void {
		if (!this.onUi) return;
		try {
			this.onUi(request);
		} catch {
			this.tally.listenerErrors += 1;
		}
	}

	/** Cancels one open dialog, if there is room to say so at all. There is no waiting for room and no retry. */
	private cancelDialog(id: string): void {
		const entry = this.uiIds.get(id);
		if (!entry || entry.state !== "open") return;
		const framed = this.frame({ type: "extension_ui_response", id, cancelled: true });
		entry.state = "answered";
		entry.delivery = "queued";
		this.openUi.delete(id);
		if (!framed || !this.writer.enqueue({ kind: "dialog", owner: id, text: framed.text, bytes: framed.bytes, onHandoff: () => (entry.delivery = "written") })) {
			entry.state = "dropped";
			entry.delivery = "none";
			this.tally.droppedFrames += 1;
			return;
		}
		this.tally.uiCancelledByTransport += 1;
	}

	/** Frames that will never be written: each owner is settled or marked once, and none of them can be sent later. */
	private releaseDropped(items: PiWriteItem[]): void {
		const failure = this.failure ?? piFailure("closed");
		for (const item of items) {
			if (item.kind === "dialog") {
				const entry = this.uiIds.get(item.owner);
				if (entry) {
					entry.state = "dropped";
					entry.delivery = "none";
				}
				this.openUi.delete(item.owner);
				this.tally.droppedFrames += 1;
				continue;
			}
			this.correlator.settle(item.owner, { ok: false, failure });
		}
	}

	/* ---------------------------------------------------------------------------------------------------------- */

	private protocol(reason: string): void {
		this.fail({ reason: "protocol", failure: piFailure("protocol", { reason }) });
	}

	private fail(cause: PiFinalCause): void {
		void this.finalize(cause);
	}

	private note(failure: PiFailure): void {
		this.failure ??= failure;
	}

	/** Releases whatever a shutdown is waiting on: the abort's own answer, a settle from the child, or the exit. */
	private releaseStop(): void {
		const waiters = this.stopWaiters.splice(0, this.stopWaiters.length);
		for (const waiter of waiters) waiter();
	}

	/**
	 * The startup's own end: the child is finished here, and the whole record travels on the refusal.
	 *
	 * A finalization that produced no report has nothing to travel: the await below rejects with that collapse's own
	 * `unverified` refusal, which is what a caller of `start` gets, and no `finalExit` is attached to it because there is
	 * no exit to attach. Nothing is caught here to turn it into a report of its own.
	 */
	private async startupRefusal(cause: PiFinalCause): Promise<PiTransportError> {
		const exit = await this.finalize(cause);
		return new PiTransportError(exit.failure ?? piFailure("startup"), exit);
	}

	/**
	 * One finalization per transport, and one answer for every caller of it. The ordinary way out is the report
	 * `runFinalize` writes; the other is a finalization that threw where it had nothing left to report with, and that one
	 * is collapsed here, once, into a rejection every later caller gets too.
	 *
	 * The memo is set before the collapse can run, so anything that re-enters this during it — a dropped frame settling
	 * its owner, a root exit arriving late — gets this same promise back and never starts a second finalization. The
	 * rejection is observed immediately and is still handed to callers rejecting: a collapse set off from inside this
	 * transport, by a read or a listener nobody is awaiting, must not become an unhandled rejection while it waits for
	 * the first caller to ask. Observing it here is not catching it for them.
	 */
	private finalize(cause: PiFinalCause): Promise<PiExit> {
		if (this.ending) return this.ending;
		const ending = this.runFinalize(cause).catch((error: unknown) => {
			throw this.collapse(error);
		});
		this.ending = ending;
		ending.catch(() => {});
		return ending;
	}

	/**
	 * A finalization that threw instead of reporting: the child is given up on, and nothing is claimed about it.
	 *
	 * What this may say is one fixed failure. There is no cleanup report, so there is no exit, no signal, no counters and
	 * no `PiExit` — and none of those is invented here, which is the whole point of the `unverified` kind. The value that
	 * was thrown is not read, not wrapped and not carried: it came from a place that had already failed, and a message
	 * built out of it would be this host's guess about a process it cannot see.
	 *
	 * What it does instead is let go of everything local, in order, each step on its own so that one that throws does not
	 * keep the rest from being attempted: the timers and the abort listener, whatever is waiting on a stop, the writer's
	 * queue with every frame released to its owner, every outstanding request, the turn in flight, the dialogs that can
	 * no longer be answered, this transport's own listeners, and finally the two pipes — abandoned, never closed and
	 * never called closed. A second finalization cannot start behind any of it: the memo is already set.
	 *
	 * What it does not promise is that every one of those steps succeeded, or that a transport whose own records were
	 * corrupted is put back together. Each step is attempted once: one that throws is something this host could not
	 * finish, said by the failure below rather than retried or repaired.
	 *
	 * The process itself is left exactly as it was. Nothing here signals it, kills it, reaps it or destroys a pipe it may
	 * still be writing to, because an unverified process is one this host has no standing to act on.
	 */
	private collapse(_error: unknown): PiTransportError {
		const failure = piFailure("unverified");
		// `note` keeps the cause that started this finalization where there was one, so a shutdown that was already an
		// abort still reads as one; with no cause at all, what is known is this.
		this.note(failure);
		this.state = "ended";
		for (const step of [
			() => this.clearStartupTimer(),
			() => this.detachAbort(),
			// Stop waiters are this transport's own deferred resolvers and nothing else: each one clears its own timer as
			// it runs, and no caller's code is behind any of them.
			() => this.releaseStop(),
			// Admission first: nothing more is composed or queued, and every frame still waiting is released to its owner
			// through the drop callback, which settles requests and marks dialogs and finalizes nothing. A drop loop that
			// threw part way is caught by this loop, and what it had not reached yet is still where it was: those requests
			// are in the correlator for the settle below, and the dialog ids it did reach stay spent and unwritten, so
			// none is reopened and none is answered twice. What such a failure can cost is a dropped-frame count that is
			// short — a counter, not a claim that every callback ran.
			() => this.writer.close(),
			// Every remaining obligation is attempted even when one caller's hook throws; the first value thrown comes
			// back out of `settleAll` and is swallowed here, and no id it removed can be settled a second time.
			() => this.correlator.settleAll(this.failure ?? failure),
			() => this.abandonTurn(),
			() => this.abandonUi(),
			() => this.abandonListeners(),
			() => this.abandonPipes(),
		]) {
			try {
				step();
			} catch {
				// Swallowed on purpose, and not counted: this path is already the one where something threw where it
				// could not, and a step that fails here must not take the steps after it with it.
			}
		}
		const refusal = new PiTransportError(failure);
		this.exitedAt.reject(refusal);
		// Rejecting for whoever asks, and observed now so that a caller who never asks leaves nothing unhandled.
		this.exitedAt.promise.catch(() => {});
		return refusal;
	}

	/**
	 * The turn in flight, ended without rewriting what it already is. A turn that is done stays done, and one a
	 * finalization fixed — an abort's `aborted` above all — keeps that outcome: `finishTurn` reads `fixed` first, and the
	 * failure it reports is the cause this finalization began with.
	 */
	private abandonTurn(): void {
		const turn = this.turnRecord;
		if (!turn || turn.done) return;
		this.finishTurn(turn, turn.fixed ?? "failed");
	}

	/**
	 * Every dialog still open, given up on. None of them is answered and none is cancelled: an answer would have to be
	 * written to a child whose state is unverified, and a dialog this transport cannot answer is one it stops recording
	 * as open. The id stays spent, so nothing can be answered twice if anything ever reaches it.
	 */
	private abandonUi(): void {
		for (const id of [...this.openUi]) {
			const entry = this.uiIds.get(id);
			if (entry?.state === "open") {
				entry.state = "dropped";
				entry.delivery = "none";
			}
			this.openUi.delete(id);
		}
	}

	/** This transport's own listeners on the root and its stdin, taken off. The pipes' own are not these; see below. */
	private abandonListeners(): void {
		const handle = this.handle;
		const root = this.rootListeners;
		this.rootListeners = undefined;
		if (handle && root) {
			handle.off("error", root.error);
			handle.off("exit", root.exit);
		}
		const stdin = handle?.stdin as Writable | undefined;
		const listeners = this.stdinListeners;
		this.stdinListeners = undefined;
		if (stdin && listeners) {
			stdin.off("error", listeners.error);
			stdin.off("close", listeners.close);
			stdin.off("drain", listeners.drain);
		}
	}

	/**
	 * Both pipes, given up on and neither closed nor described as closed. `abandon` drops the callbacks that reach this
	 * transport and its framer and leaves the stream's own discard listeners in place until it really closes, so a child
	 * that is still writing does not block on a pipe nobody reads. The references go too, so nothing here reads a pipe
	 * again or reports anything about one.
	 */
	private abandonPipes(): void {
		this.out?.abandon();
		this.err?.abandon();
		this.out = undefined;
		this.err = undefined;
	}

	/**
	 * One finalization, memoized, whatever set it off: a host shutdown, an abort, a startup, protocol or
	 * acknowledgement failure, a spawn that never happened, or an exit nobody asked for.
	 *
	 * The order is what the native side makes possible and no more than that. External admission stops first and every
	 * unsent frame of the caller's goes, settling its owner once, which is also what frees the room the controls need.
	 * For a live child with a turn the descendants are then observed once, while that child still owns them and before
	 * its own abort can re-parent one of them away — at most one table timeout in front of the cleanup's own deadline,
	 * and a read that failed is left to show as that cleanup's own `discovery` rather than swallowed with the error.
	 * `clear_queue` and `abort` then go out in that order with nothing awaited between them, because 0.85.1 reads one
	 * stdin line at a time and starts each command's handler in the order it read them: there is no handshake to wait
	 * for and none is invented. Whatever comes back before that is observed normally. Then, for an abort this side was
	 * able to admit, one bounded wait for its own answer, the turn settling or the exit; and then the tree's own
	 * cleanup — never a bare kill.
	 */
	private async runFinalize(cause: PiFinalCause): Promise<PiExit> {
		this.state = "closing";
		this.clearStartupTimer();
		this.detachAbort();
		if (cause.failure) this.note(cause.failure);
		this.requestedStop = cause.reason !== "exited" && cause.reason !== "spawn";
		this.startupGate.reject(new PiTransportError(this.failure ?? piFailure("startup")));

		const turn = this.turnRecord && !this.turnRecord.done ? this.turnRecord : undefined;
		if (turn) {
			// Fixed now, so a settle that lands during the shutdown releases the wait without renaming the outcome.
			if (cause.reason === "host" || cause.reason === "aborted") turn.fixed = "aborted";
			else if (cause.reason === "protocol" || cause.reason === "timeout" || cause.reason === "startup") turn.fixed = "failed";
		}

		this.writer.dropUnsent((item) => item.kind !== "control");
		// Only a turn is worth waiting on: with none there is nothing for an abort to answer, and closing the child's
		// stdin — which the tree's own cleanup does first — is what an orderly Pi shutdown is.
		if (this.alive() && turn) {
			// Remembered here and nowhere else, because this is the last moment the live child still owns its descendants:
			// Pi's own abort kills a tool's shell, and a detached `setsid` descendant of one is re-parented out of this
			// root's subtree as that shell dies, so a walk after the abort would no longer find it. One read and no more
			// — nothing here samples, retries or polls — bounded by the owned cleanup's own `tableTimeoutMs` and by
			// nothing else, because the aggregate `deadlineMs` starts inside `shutdown()` below. So the cost is at most
			// that one table timeout in front of the whole deadline rather than inside it: separately bounded and
			// additive, deliberately, because an observation that ate the deadline would cost the cleanup its own steps.
			//
			// The rejection is swallowed for one reason and no other: so this sequence carries on to `clear_queue`, to
			// `abort` and to the cleanup, and so an error from an observation cannot take the place of the root's own
			// end or of the turn's. What it can and cannot absorb is exact. Every way a production table read fails —
			// its own timeout, a reader that threw, a result that is absent — sets the tree's own sticky discovery
			// failure rather than rejecting here, so the cleanup comes back `discovery: "unavailable"`, which is a
			// concern, an unsafe disposition and a call whose storage is kept: the conservative answer, because a
			// descendant may have been missed, and nothing here clears it, restores it or makes up for it. The one
			// rejection this `catch` does absorb is a malformed truthy non-array table, which the survey's own walk
			// throws on and which exists only through injected facilities, never through the table this build reads.
			await this.tree.observe().catch(() => undefined);
			this.control("clear_queue");
			const aborting = this.control("abort", true);
			for (const id of [...this.openUi]) this.cancelDialog(id);
			// Only an abort this side actually admitted is worth a wait: one it refused reached no child, so nothing is
			// coming back for that wait to end on and the whole of it would be spent on a command that was never sent.
			if (aborting) await this.waitForStop();
		} else for (const id of [...this.openUi]) this.cancelDialog(id);

		const cleanup = await this.tree.shutdown();
		// Both pipes are consumed right through the cleanup, and the last frames the child buffered are read here. A
		// descendant that inherited a pipe can hold it open past everything, so this wait is bounded too and says so.
		const closed = await Promise.all([this.out?.closedWithin(this.bounds.shutdownStepMs) ?? Promise.resolve(true), this.err?.closedWithin(this.bounds.shutdownStepMs) ?? Promise.resolve(true)]);
		this.tally.streamsUnclosed = closed.filter((done) => !done).length;
		this.writer.close();
		if (this.out?.finished !== true) this.endStdout();
		const record = this.stderrSnapshot();
		const exit = cleanup.exit;

		if (this.trailing && !this.explained(exit)) this.note(piFailure("protocol", { reason: TRAILING_RECORD }));
		if (!this.ready) {
			// Before readiness every end is a child that never became ready, said in its own diagnostics: the
			// bootstrap's configuration exit among them, which carries the stage it stopped at and nothing invented.
			if (this.spawnRefused) this.failure = piFailure("spawn", { exit });
			else if (this.failure === undefined || this.failure.kind === "exited") this.failure = startupFailure(record, exit, this.bounds);
		}
		// A root nothing could stop is an error whatever else happened, and no clean success is claimed over it.
		if (cleanup.root === "unstoppable") this.failure = piFailure("unstoppable", { exit });

		// Every outstanding request goes with one failure, and each one's own timer is stopped by the correlator as it
		// leaves the pending map, so no clock of this transport's is still running when the exit is reported.
		this.correlator.settleAll(this.failure ?? piFailure("closed"));
		if (turn && !turn.done) this.finishTurn(turn, turn.fixed ?? (this.failure?.kind === "exited" ? "exited" : "failed"));
		this.state = "ended";

		const result: PiExit = {
			exit,
			cleanup,
			stderr: record,
			...(this.failure === undefined ? {} : { failure: this.failure }),
			stoppedByUs: this.requestedStop || this.tree.stoppedBy(exit),
			counters: { ...this.tally },
		};
		this.exitedAt.resolve(result);
		return result;
	}

	/** True when something stronger than an unterminated last record already says why this child stopped. */
	private explained(exit: ExitOutcome): boolean {
		return this.failure !== undefined || exit.signal !== null || (exit.code !== null && exit.code !== 0);
	}

	/**
	 * One shutdown control, and whether it was admitted at all. A control that cannot be — no pending slot, no room in
	 * the queue, a record that would not compose — is not retried and is not waited for: the cause this shutdown started
	 * with is what is reported, and the tree's own cleanup is what ends the child instead. Saying which it was is what
	 * lets the abort's own wait be skipped, because waiting for an answer to a command nothing carried is waiting for
	 * something that cannot arrive.
	 *
	 * `releases` belongs to the abort alone, and it releases on an answer from the child and on nothing else. The local
	 * refusal below settles this very request too, and that settlement is this side's own bookkeeping — as is a queued
	 * frame dropped by a closing writer — rather than evidence that the child read anything or stopped doing anything.
	 */
	private control(type: string, releases = false): boolean {
		if (!this.alive() || !this.writer.open) return false;
		let request: PiPendingRequest;
		try {
			request = this.correlator.issue(type, { settle: (outcome) => (releases && outcome.ok ? this.releaseStop() : undefined) });
		} catch {
			return false;
		}
		const framed = this.frame({ id: request.id, type });
		if (!framed || !this.writer.enqueue({ kind: "control", owner: request.id, text: framed.text, bytes: framed.bytes })) {
			this.correlator.settle(request.id, { ok: false, failure: piFailure("refused") });
			return false;
		}
		return true;
	}

	private waitForStop(): Promise<void> {
		if (!this.alive()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = (): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(finish, this.bounds.shutdownStepMs);
			this.stopWaiters.push(finish);
		});
	}

	private stderrSnapshot(): PiStderrRecord {
		// Taken after the drain, so the last diagnostic the child wrote on its way out is in it.
		this.endStderr();
		return this.stderrReader.record;
	}

	private detachAbort(): void {
		if (!this.signal || !this.abortListener) return;
		this.signal.removeEventListener("abort", this.abortListener);
		this.abortListener = undefined;
	}
}

/**
 * One Pi child, spawned and brought to the point where it answers. What it is launched with is composed elsewhere —
 * nothing here resolves a path, reads a file or names a bootstrap — and what comes back is a handle whose every call
 * is bounded. A startup that fails rejects with a `PiTransportError` carrying the whole finished `PiExit`, because the
 * child is over by then and nobody else is holding its record.
 */
export async function startPiChild(options: PiChildOptions): Promise<PiChild> {
	if (!options || typeof options !== "object") throw new TypeError("a pi child is started from the options that launch it");
	if (options.killGraceMs !== undefined) positiveTimer("killGraceMs", options.killGraceMs);
	const bounds = piBounds(options.bounds);
	return new PiChildImpl(options, bounds).start();
}
