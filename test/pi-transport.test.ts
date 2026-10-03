import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { isDeadState, type LaunchOptions, type ObservedProcess, type OwnedCleanup, type ProcessFacilities, readProcessTable } from "../extensions/process-tree.ts";
import { piRole } from "../extensions/backends/pi-binding.ts";
import { CONTROL_CANCELLED, NAVIGATE_COMMAND } from "../extensions/backends/pi-control-extension.mjs";
import { DIAGNOSTIC_EVENT, STARTUP_EXIT_CODE } from "../extensions/backends/pi-bootstrap.mjs";
import { bootstrapInput, piLaunch } from "../extensions/backends/pi-launch.ts";
import { type PreparedCall, prepareCallStorage, writeCallInput } from "../extensions/backends/pi-storage.ts";
import {
	LineFramer,
	MAX_TIMER_MS,
	PI_BOUNDS,
	PI_DIAGNOSTIC_FIELD_MAX_CHARS,
	PI_REQUEST_PREFIX,
	type PiBounds,
	type PiChild,
	type PiChildOptions,
	PiCorrelator,
	type PiExit,
	type PiFailure,
	type PiLine,
	type PiOutcome,
	type PiResponse,
	PiTransportError,
	type PiUiRequest,
	piBounds,
	piFailure,
	startPiChild,
	startupFailure,
	StderrReader,
	validateResponse,
	writerCaps,
} from "../extensions/backends/pi-transport.ts";

/*
 * Two halves, and they are not the same kind of evidence.
 *
 * The first is the transport's pure pieces, driven directly: nothing there starts a process, opens a stream or
 * reaches a network. The second drives the lifecycle against `test/fake-pi.mjs`, which speaks the native RPC
 * protocol and the bootstrap's own stage diagnostics and is not Pi: it is composed through the production storage,
 * input and launch and run as a fenced subprocess with directories of its own, so what is exercised is this host's
 * own reading of the protocol. Neither half is evidence about Pi's behavior, which only a real child can give.
 *
 * Every SDK import here is a type, so the native shapes below are pinned by the compiler and erased at runtime. No
 * test in this file imports a backend, builds a session or starts a model runtime.
 */

/** What a decoder puts where it could not read a character. Built by code point, so no test here holds one itself. */
const REPLACEMENT = String.fromCharCode(0xfffd);

const buf = (text: string): Buffer => Buffer.from(text, "utf8");
const texts = (lines: PiLine[]): string[] => lines.map((line) => line.text);
const diagnostic = (detail: { [key: string]: unknown }): string => JSON.stringify({ event: DIAGNOSTIC_EVENT, ...detail });

const accept = (value: unknown): PiResponse => {
	const check = validateResponse(value);
	if (!check.ok) assert.fail(`a valid response was refused: ${check.failure.message}`);
	return check.response;
};

const refuse = (value: unknown): PiFailure => {
	const check = validateResponse(value);
	if (check.ok) assert.fail(`this response should not have been accepted: ${JSON.stringify(check.response)}`);
	return check.failure;
};

test("a frame ends at its LF, one CRLF's CR goes with it, and no other separator is a boundary", () => {
	const framer = new LineFramer(1024);
	// The two separators node's own line reader splits on, inside a json string where they are ordinary characters.
	// Built by code point, so this source holds neither of them and a reader can see which two they are.
	const separator = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
	const separators = JSON.stringify({ type: "message_update", text: separator });
	const lines = framer.push(buf(`{"a":1}\n{"b":2}\r\n${separators}\n`));
	assert.deepEqual(texts(lines), ['{"a":1}', '{"b":2}', separators]);
	assert.equal(
		lines.every((line) => !line.truncated && !line.partial),
		true,
	);
	assert.equal(JSON.parse(lines[2].text).text, separator, "the separators stayed inside the frame that carried them");
	assert.deepEqual(framer.counters, { lines: 3, truncated: 0, partial: 0, dropped: 0 });
	// The CR is the line's own byte until the LF says it was a terminator, so it is counted and then dropped.
	assert.equal(lines[1].bytes, 8);
});

test("a character the stream cut in half is whole when its last byte arrives, and half of one at the end is flagged", () => {
	const whole = buf('{"t":"→"}\n');
	const framer = new LineFramer(1024);
	// Two of the three bytes of U+2192, and nothing else of it, in the first chunk.
	assert.deepEqual(framer.push(whole.subarray(0, 7)), []);
	const lines = framer.push(whole.subarray(7));
	assert.deepEqual(texts(lines), ['{"t":"→"}']);
	assert.equal(lines[0].bytes, whole.length - 1);
	assert.equal(JSON.parse(lines[0].text).t, "→");

	const torn = new LineFramer(1024);
	torn.push(buf("→").subarray(0, 2));
	const rest = torn.end();
	assert.deepEqual(rest, [{ text: REPLACEMENT, bytes: 2, truncated: false, partial: true }], "a character with no end is one replacement character, and the line says it is unterminated");
});

test("a line exactly at the cap is whole, and one byte more is cut, counted and kept out of the frames", () => {
	const cap = 16;
	const at = new LineFramer(cap);
	const full = "x".repeat(cap);
	assert.deepEqual(at.push(buf(`${full}\n`)), [{ text: full, bytes: cap, truncated: false, partial: false }]);
	assert.deepEqual(at.counters, { lines: 1, truncated: 0, partial: 0, dropped: 0 });

	const over = new LineFramer(cap);
	assert.deepEqual(over.push(buf(`${"x".repeat(cap + 1)}\n`)), [{ text: "", bytes: cap + 1, truncated: true, partial: false }]);
	assert.deepEqual(over.counters, { lines: 1, truncated: 1, partial: 0, dropped: cap + 1 }, "a dropped line drops whole, the part that had fit included");
});

test("an over-cap line is reported once however it arrives, and the frames after it are read normally", () => {
	const framer = new LineFramer(8);
	const lines = framer.push(buf(`${"y".repeat(40)}\n{"ok":1}\n`));
	assert.deepEqual(
		lines.map((line) => [line.truncated, line.text]),
		[
			[true, ""],
			[false, '{"ok":1}'],
		],
	);
	assert.equal(framer.counters.truncated, 1);

	const split = new LineFramer(8);
	for (let chunk = 0; chunk < 5; chunk += 1) assert.deepEqual(split.push(buf("y".repeat(8))), []);
	assert.deepEqual(split.counters, { lines: 0, truncated: 0, partial: 0, dropped: 0 }, "nothing is reported before the line ends");
	assert.deepEqual(split.push(buf("\n")), [{ text: "", bytes: 40, truncated: true, partial: false }]);
	assert.equal(split.counters.truncated, 1, "one report for one over-cap line, however many chunks it came in");
});

test("a flood with no newline in it is bounded by the cap, and the valid frame after it still arrives", () => {
	const cap = 64 * 1024;
	const framer = new LineFramer(cap, "keep-prefix");
	const chunk = Buffer.alloc(64 * 1024, 0x79);
	const flood = 5 * 1024 * 1024;
	assert.deepEqual(framer.push(chunk), []);
	assert.deepEqual(framer.inProgress, { seen: cap, retained: cap, truncated: false }, "exactly at the cap is not past it");
	for (let sent = chunk.length; sent < flood; sent += chunk.length) {
		assert.deepEqual(framer.push(chunk), []);
		// Known at the push that made it oversized: no LF anywhere, and no end of stream to wait for.
		assert.equal(framer.inProgress.truncated, true);
	}
	assert.equal(framer.inProgress.seen, flood);
	// What the framer retains, which is what it is answerable for; this counts bytes and measures no heap.
	assert.equal(framer.inProgress.retained, cap);
	const lines = framer.push(buf('\n{"ok":1}\n'));
	assert.deepEqual(
		lines.map((line) => [line.truncated, line.bytes, Buffer.byteLength(line.text)]),
		[
			[true, flood, cap],
			[false, 8, 8],
		],
	);
	assert.equal(framer.counters.dropped, flood - cap);
	assert.deepEqual(framer.inProgress, { seen: 0, retained: 0, truncated: false }, "the flood is not held past its own line, and neither is the flag");
});

test("a kept prefix is a prefix and says so, never half a character and never a frame to parse", () => {
	const framer = new LineFramer(12, "keep-prefix");
	const [line] = framer.push(buf('{"a":"aaaaaaaaaaaaaaaa"}\n'));
	assert.equal(line.truncated, true);
	assert.equal(line.text, '{"a":"aaaaaa');
	assert.equal(Buffer.byteLength(line.text), 12);
	assert.throws(() => JSON.parse(line.text), SyntaxError, "a prefix is not a frame, and nothing above may parse one");

	const wide = new LineFramer(5, "keep-prefix");
	const [cut] = wide.push(buf("→→→\n"));
	assert.deepEqual(cut, { text: "→", bytes: 9, truncated: true, partial: false }, "the cap fell inside a character, so that character is not in the prefix");
	assert.equal(cut.text.includes(REPLACEMENT), false);
	assert.equal(wide.counters.dropped, 6);
});

test("a line whose replacement characters outgrow the cap is cut too, however few bytes it took", () => {
	const invalid = Buffer.from([0xff]);
	// Nine bytes and one invalid byte: at the raw cap, past what may be retained once that byte becomes a character.
	const noticed = new LineFramer(10);
	noticed.push(Buffer.concat([buf("x".repeat(9)), invalid]));
	assert.deepEqual(noticed.inProgress, { seen: 10, retained: 9, truncated: true }, "the retention cut is the cap as much as the raw one, and it shows before any LF");
	assert.deepEqual(noticed.push(buf("\n")), [{ text: "", bytes: 10, truncated: true, partial: false }]);
	assert.deepEqual(noticed.counters, { lines: 1, truncated: 1, partial: 0, dropped: 10 });
	assert.deepEqual(noticed.inProgress, { seen: 0, retained: 0, truncated: false }, "and it goes with the line it belonged to");

	// The part that fit is valid json on its own, which is exactly why it is handed over flagged rather than clean.
	const kept = new LineFramer(8, "keep-prefix");
	const [line] = kept.push(Buffer.concat([buf('{"a":1}'), invalid, buf("\n")]));
	assert.deepEqual(line, { text: '{"a":1}', bytes: 8, truncated: true, partial: false });
	assert.deepEqual(JSON.parse(line.text), { a: 1 }, "it parses, and the flag is the only thing that keeps it from being read as a whole frame");
	assert.equal(kept.counters.dropped, 1);
});

test("text that arrives with no room left for it is the same cut, and a chunk boundary does not decide whether it is one", () => {
	const invalid = Buffer.from([0xff]);
	// Three bytes is one replacement character exactly, so after that byte the cap is reached and the 'a' behind it is
	// content with nowhere to go. In one chunk the cap falls inside the decoded text; in two it is already reached when
	// the text arrives, which is the same loss and has to be the same line.
	for (const overflow of ["drop", "keep-prefix"] as const) {
		const one = new LineFramer(3, overflow);
		one.push(Buffer.concat([invalid, buf("a")]));
		assert.deepEqual(one.inProgress, { seen: 2, retained: 3, truncated: true }, overflow);

		const two = new LineFramer(3, overflow);
		two.push(invalid);
		assert.deepEqual(two.inProgress, { seen: 1, retained: 3, truncated: false }, "the replacement character fit exactly, and a line at the cap is not past it");
		two.push(buf("a"));
		assert.deepEqual(two.inProgress, { seen: 2, retained: 3, truncated: true }, `${overflow}: the byte that had nowhere to go is the cut, and it shows before any LF`);

		const [split] = two.push(buf("\n"));
		const [whole] = one.push(buf("\n"));
		assert.deepEqual(split, whole, `${overflow}: one chunk or two, the line handed over is the same one`);
		assert.equal(split.text, overflow === "keep-prefix" ? REPLACEMENT : "");
		assert.equal(split.text.includes("a"), false, "what was lost is not in it, and the flag is what says something was");
		// The count is the bytes this line does not hold rather than the bytes it lost: a replacement character wider
		// than the byte it replaced can leave a line that lost content counting nothing at all.
		assert.deepEqual(two.counters, { lines: 1, truncated: 1, partial: 0, dropped: overflow === "keep-prefix" ? 0 : 2 }, overflow);
	}
});

test("a byte sequence still unfinished when the stream ends is loss and is unterminated, and says both", () => {
	for (const overflow of ["drop", "keep-prefix"] as const) {
		const framer = new LineFramer(3, overflow);
		framer.push(Buffer.from([0xff]));
		// The first byte of a three-byte character and nothing after it: the decoder holds it and hands over no text, so
		// nothing is known about it until the end of the stream flushes it into a line with no room left for it.
		framer.push(Buffer.from([0xe2]));
		assert.deepEqual(framer.inProgress, { seen: 2, retained: 3, truncated: false }, overflow);
		const [line] = framer.end();
		assert.deepEqual([line.truncated, line.partial, line.bytes], [true, true, 2], `${overflow}: no room for the flushed character, and no LF after it either`);
		assert.equal(line.text, overflow === "keep-prefix" ? REPLACEMENT : "");
		assert.deepEqual(framer.counters, { lines: 1, truncated: 1, partial: 1, dropped: overflow === "keep-prefix" ? 0 : 2 }, overflow);
	}
});

test("a retained prefix that parses on its own is never handed over whole when more of its line arrived", () => {
	const invalid = Buffer.from([0xff]);
	// The one invalid byte is inside a json string, so what is retained parses: nine bytes on the wire, eleven once that
	// byte is a replacement character, which is this cap exactly and leaves no room for whatever comes next.
	const head = Buffer.concat([buf('{"a":"'), invalid, buf('"}')]);
	const cap = Buffer.byteLength(`{"a":"${REPLACEMENT}"}`);
	for (const overflow of ["drop", "keep-prefix"] as const) {
		const framer = new LineFramer(cap, overflow);
		framer.push(head);
		assert.deepEqual(framer.inProgress, { seen: head.length, retained: cap, truncated: false }, `${overflow}: at the cap, not past it, and json so far`);
		framer.push(buf("x"));
		assert.equal(framer.inProgress.truncated, true, `${overflow}: the line went on past what may be retained of it`);
		const [line] = framer.push(buf("\n"));
		assert.equal(line.truncated, true, "so what is held is a prefix of a record and never a record");
		assert.equal(line.bytes, head.length + 1);
		if (overflow === "drop") assert.equal(line.text, "");
		else {
			assert.deepEqual(JSON.parse(line.text), { a: REPLACEMENT }, "it parses, which is exactly why the flag has to be on it");
			assert.equal(line.text.endsWith("x"), false, "and the byte it does not hold is what the flag is about");
		}
	}
});

test("a character the LF cut in half belongs to the line its bytes arrived in, and the next line is clean", () => {
	// A roomy cap: nothing here is about the cap, and the only thing wrong with the first line is its last byte.
	const lead = Buffer.from([0xe2]);
	const framer = new LineFramer(1024);
	const lines = framer.push(Buffer.concat([buf('{"t":1}'), lead, buf('\n{"u":2}\n')]));
	assert.deepEqual(texts(lines), [`{"t":1}${REPLACEMENT}`, '{"u":2}'], "the unfinished character stayed in its own line, and nothing of it reached the one after");
	assert.throws(() => JSON.parse(lines[0].text), SyntaxError, "so the torn line is not json, which is what a reader of it has to find");
	assert.deepEqual(JSON.parse(lines[1].text), { u: 2 }, "and the line behind it is exactly what the child wrote");
	assert.deepEqual(
		lines.map((line) => [line.bytes, line.truncated, line.partial]),
		[
			[8, false, false],
			[7, false, false],
		],
		"each line's bytes are its own, and a torn character is neither the cap nor an unterminated end",
	);
	assert.deepEqual(framer.counters, { lines: 2, truncated: 0, partial: 0, dropped: 0 });
	assert.deepEqual(framer.end(), [], "the torn line ended at its LF, so the end of the stream adds no line after it");

	// The same bytes with the lone lead byte as the whole last chunk before the LF: the decoder is holding it when that
	// LF arrives, which is the split a reader that flushed nowhere would carry into the next line.
	const split = new LineFramer(1024);
	assert.deepEqual(split.push(buf('{"t":1}')), []);
	assert.deepEqual(split.push(lead), []);
	assert.deepEqual(texts(split.push(buf("\n"))), [`{"t":1}${REPLACEMENT}`]);
	assert.deepEqual(texts(split.push(buf('{"u":2}\n'))), ['{"u":2}']);
	assert.deepEqual(split.counters, { lines: 2, truncated: 0, partial: 0, dropped: 0 });
});

test("what the stream left after its last LF is handed over as unterminated, and the framer is then finished", () => {
	const framer = new LineFramer(64);
	assert.deepEqual(framer.push(buf('{"half":')), []);
	assert.deepEqual(framer.end(), [{ text: '{"half":', bytes: 8, truncated: false, partial: true }]);
	assert.equal(framer.counters.partial, 1);
	assert.deepEqual(framer.end(), [], "the end is the end: a second one hands over nothing");
	assert.throws(() => framer.push(buf("x")), /has ended/);

	const clean = new LineFramer(64);
	clean.push(buf("a\n"));
	assert.deepEqual(clean.end(), [], "a stream that ended on a boundary has nothing left over");
});

test("a framer takes a positive safe cap and one of the two overflow rules, and nothing else", () => {
	for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => new LineFramer(cap), TypeError, String(cap));
	assert.throws(() => new LineFramer(8, "truncate" as unknown as "drop"), TypeError);
});

test("the bounds are the ones this transport was designed around, and they are not a setting", () => {
	assert.deepEqual(PI_BOUNDS, {
		maxFrameBytes: 67_108_864,
		maxOutboundFrameBytes: 16_777_216,
		maxStderrLineBytes: 1_048_576,
		maxStderrTailBytes: 65_536,
		maxDiagnosticBytes: 16_384,
		maxPendingRequests: 64,
		maxOpenUiRequests: 16,
		maxUiIds: 4096,
		startupMs: 120_000,
		ackMs: 300_000,
		requestMs: 30_000,
		shutdownStepMs: 5_000,
	});
	assert.equal(Object.isFrozen(PI_BOUNDS), true);
	assert.deepEqual(piBounds(), { ...PI_BOUNDS });
	assert.deepEqual(piBounds({ requestMs: undefined }), { ...PI_BOUNDS }, "a field left out takes its default, named as undefined or not named at all");
	assert.equal(piBounds({ requestMs: 1_000 }).requestMs, 1_000);
	assert.equal(piBounds({ requestMs: 1_000 }).ackMs, PI_BOUNDS.ackMs, "what a caller did not name keeps its default");
});

test("every bound is a positive safe integer, and a refusal names the field without repeating its value", () => {
	const fields = Object.keys(PI_BOUNDS) as (keyof PiBounds)[];
	assert.equal(fields.length, 12);
	for (const field of fields) {
		// null among them: a field named with it asked for something, and it is not the default it did not name.
		for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null]) {
			assert.throws(
				() => piBounds({ [field]: value } as unknown as Partial<PiBounds>),
				(error: unknown) => {
					assert.ok(error instanceof TypeError, `${field} ${value}`);
					assert.match(error.message, new RegExp(`^${field} must be a positive safe integer$`));
					assert.equal(error.message.includes(String(value)), false, "a refusal names the field and never the value it refused");
					return true;
				},
				`${field} ${value}`,
			);
		}
	}
});

test("a millisecond bound may be exactly as long as one timer runs, and no longer", () => {
	for (const field of ["startupMs", "ackMs", "requestMs", "shutdownStepMs"] as const) {
		assert.equal(piBounds({ [field]: MAX_TIMER_MS } as Partial<PiBounds>)[field], MAX_TIMER_MS);
		assert.throws(
			() => piBounds({ [field]: MAX_TIMER_MS + 1 } as Partial<PiBounds>),
			(error: unknown) => {
				assert.ok(error instanceof TypeError);
				assert.match(error.message, new RegExp(`^${field} must be at most ${MAX_TIMER_MS},`));
				assert.equal(error.message.includes(String(MAX_TIMER_MS + 1)), false);
				return true;
			},
		);
	}
	// A byte bound is not a timer: it is held to being a positive safe integer and to nothing else.
	assert.equal(piBounds({ maxFrameBytes: MAX_TIMER_MS + 1 }).maxFrameBytes, MAX_TIMER_MS + 1);
});

test("a bound that would leave the writer's own caps uncountable is refused before anything is built on it", () => {
	assert.deepEqual(writerCaps(PI_BOUNDS), { items: 64 + 16 + 2, bytes: 2 * 16 * 1024 * 1024 });
	assert.deepEqual(writerCaps(piBounds({ maxPendingRequests: 1, maxOpenUiRequests: 1, maxOutboundFrameBytes: 10 })), { items: 4, bytes: 20 });
	// The object form rather than a bare pattern, because a bare one is tested against the whole `toString()` — the kind
	// in front of the text — and these are anchored on the field each refusal names first, in the message itself.
	const itemCap = { name: "TypeError", message: /^maxPendingRequests and maxOpenUiRequests must leave/ };
	assert.throws(() => piBounds({ maxPendingRequests: Number.MAX_SAFE_INTEGER }), itemCap);
	assert.throws(() => piBounds({ maxOpenUiRequests: Number.MAX_SAFE_INTEGER }), itemCap);
	assert.throws(() => piBounds({ maxOutboundFrameBytes: Number.MAX_SAFE_INTEGER }), { name: "TypeError", message: /^maxOutboundFrameBytes must leave/ });
});

test("the bootstrap's own stages are read from its diagnostics, and the record is fields rather than a history", () => {
	const reader = new StderrReader();
	reader.push(
		buf(
			`${[diagnostic({ stage: "input" }), diagnostic({ stage: "sdk", sdk: "0.85.1" }), diagnostic({ stage: "runtime", sdk: "0.85.1" }), diagnostic({ stage: "serving", sdk: "0.85.1" })].join("\n")}\n`,
		),
	);
	const record = reader.record;
	assert.deepEqual([record.serving, record.lastStage, record.stageCount, record.sdk], [true, "serving", 4, "0.85.1"]);
	assert.equal(record.failure, undefined);
	assert.deepEqual([record.lines, record.truncatedLines, record.tail, record.dropped], [4, 0, "", 0]);
	assert.deepEqual(Object.keys(record).sort(), ["dropped", "lastStage", "lines", "sdk", "serving", "stageCount", "tail", "truncatedLines"]);
});

test("a stage that keeps failing leaves the last of it and a count, and no list of the ones before", () => {
	const reader = new StderrReader();
	for (let attempt = 1; attempt <= 500; attempt += 1) reader.push(buf(`${diagnostic({ stage: "runtime", sdk: "0.85.1", error: `attempt ${attempt}` })}\n`));
	const record = reader.record;
	assert.deepEqual([record.stageCount, record.lines, record.lastStage], [500, 500, "runtime"]);
	assert.deepEqual(record.failure, { stage: "runtime", error: "attempt 500", cut: false });
	assert.deepEqual(Object.keys(record).sort(), ["dropped", "failure", "lastStage", "lines", "sdk", "serving", "stageCount", "tail", "truncatedLines"]);
	// The record's own size, which is what it holds rather than what this process measures.
	assert.ok(JSON.stringify(record).length < 512, `the record stayed ${JSON.stringify(record).length} characters over 500 diagnostics`);
});

test("a models failure is the stage and the error the child named, and it composes the startup failure", () => {
	const reader = new StderrReader();
	const text = "a model or credential configuration could not be used";
	reader.push(buf(`${diagnostic({ stage: "input" })}\n${diagnostic({ stage: "models", sdk: "0.85.1", error: text })}\n`));
	const record = reader.record;
	assert.deepEqual(record.failure, { stage: "models", error: text, cut: false });
	assert.deepEqual([record.serving, record.lastStage, record.stageCount], [false, "models", 2]);

	const failure = startupFailure(record, { code: 78, signal: null });
	assert.equal(failure.kind, "startup");
	assert.equal(failure.stage, "models");
	assert.deepEqual(failure.exit, { code: 78, signal: null });
	assert.equal(failure.message, `the pi child did not become ready at the models stage (exit code 78): ${text}`);
});

test("a diagnostic's error is cut to the diagnostic cap on a character boundary, and says it was cut", () => {
	for (const [cap, kept] of [
		[9, "→→→"],
		[8, "→→"],
	] as const) {
		const reader = new StderrReader(piBounds({ maxDiagnosticBytes: cap }));
		reader.push(buf(`${diagnostic({ stage: "runtime", error: "→".repeat(10) })}\n`));
		const failure = reader.record.failure;
		assert.ok(failure);
		assert.deepEqual([failure.stage, failure.error, failure.cut], ["runtime", kept, true]);
		assert.equal(failure.error?.includes(REPLACEMENT), false, "a cut that fell inside a character kept the characters before it");
	}
	const whole = new StderrReader(piBounds({ maxDiagnosticBytes: 64 }));
	whole.push(buf(`${diagnostic({ stage: "runtime", error: "short" })}\n`));
	assert.deepEqual(whole.record.failure, { stage: "runtime", error: "short", cut: false });
});

test("stderr that is not a diagnostic is text, kept in a bounded tail with what it dropped counted", () => {
	const first = "node:internal/process/esm_loader something went wrong";
	const second = "a second line of ordinary text from the child";
	const reader = new StderrReader(piBounds({ maxStderrTailBytes: 48 }));
	reader.push(buf(`${first}\n`));
	reader.push(buf(`${second}\n`));
	const record = reader.record;
	assert.deepEqual([record.lines, record.stageCount, record.truncatedLines], [2, 0, 0]);
	assert.equal(Buffer.byteLength(record.tail) <= 48, true);
	assert.equal(record.tail.endsWith(`${second}\n`), true, "what the child wrote last is what the tail keeps");
	assert.equal(record.dropped, Buffer.byteLength(`${first}\n${second}\n`) - Buffer.byteLength(record.tail), "the tail's own cap pushed the rest out, and the count says how much");
});

test("a line the cap cut is neither a diagnostic nor tail text: it names no stage and invents no error", () => {
	// Wide enough for an ordinary diagnostic and far under the one below it, so what the cap cuts is the long line alone.
	const reader = new StderrReader(piBounds({ maxStderrLineBytes: 96 }));
	const long = diagnostic({ stage: "input", error: "x".repeat(200) });
	reader.push(buf(`${long}\n${diagnostic({ stage: "sdk", sdk: "0.85.1" })}\n`));
	const record = reader.record;
	assert.deepEqual([record.lines, record.truncatedLines, record.stageCount], [2, 1, 1]);
	assert.equal(record.lastStage, "sdk", "the stage is the one the line that arrived whole named");
	assert.equal(record.failure, undefined, "and the cut line attributed no error to it");
	assert.equal(record.tail, "", "a cut line is not tail text either: half a line reads as a whole one");
	assert.equal(record.dropped, Buffer.byteLength(long));
});

test("a whole diagnostic with one invalid byte after it is a cut line, and attributes nothing", () => {
	const whole = diagnostic({ stage: "serving", sdk: "0.85.1" });
	// One byte over what may be retained, and none over the raw cap: the line is cut by what it decoded to.
	const reader = new StderrReader(piBounds({ maxStderrLineBytes: Buffer.byteLength(whole) + 1 }));
	reader.push(Buffer.concat([buf(whole), Buffer.from([0xff]), buf("\n")]));
	const record = reader.record;
	assert.deepEqual([record.lines, record.truncatedLines, record.stageCount, record.serving], [1, 1, 0, false]);
	assert.equal(record.lastStage, undefined, "a prefix that would have parsed is still not a stage this child reported");
	assert.equal(record.failure, undefined);
	assert.equal(record.tail, "", "and it is not tail text either");
	assert.equal(record.dropped, Buffer.byteLength(whole) + 1);
});

test("a diagnostic whose last character never arrived attributes nothing, and the diagnostic after it is still read", () => {
	const reader = new StderrReader(piBounds({ maxStderrLineBytes: 4096 }));
	const torn = diagnostic({ stage: "models", error: "a model or credential configuration could not be used" });
	// One lone lead byte between a whole diagnostic and its LF, which is what a child cut off mid-write leaves behind.
	// The line is well under the cap, so this is not a cut line: it is a whole line that is not json.
	reader.push(Buffer.concat([buf(torn), Buffer.from([0xe2]), buf("\n")]));
	const half = reader.record;
	assert.deepEqual([half.lines, half.stageCount, half.truncatedLines], [1, 0, 0], "one line, and nothing recognized in it");
	assert.equal(half.lastStage, undefined, "a prefix that would have parsed is still no stage this child reported");
	assert.equal(half.failure, undefined, "and it attributed no error to one");
	assert.equal(half.tail, `${torn}${REPLACEMENT}\n`, "what is not recognized is kept as the text it is, the replacement included");

	reader.push(buf(`${diagnostic({ stage: "serving", sdk: "0.85.1" })}\n`));
	const after = reader.record;
	assert.deepEqual([after.stageCount, after.lastStage, after.serving, after.sdk], [1, "serving", true, "0.85.1"], "the next diagnostic arrived whole, with nothing of the torn line in front of it");
	assert.equal(after.truncatedLines, 0);
	assert.equal(after.dropped, 0, "the line cap cut nothing and the tail's own cap pushed nothing out");
});

test("only a whole line carrying the bootstrap's marker and a string stage is a diagnostic", () => {
	const long = "s".repeat(PI_DIAGNOSTIC_FIELD_MAX_CHARS + 1);
	for (const line of [
		JSON.stringify([{ event: DIAGNOSTIC_EVENT, stage: "input" }]),
		JSON.stringify({ event: "something-else", stage: "input" }),
		JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: 7 }),
		JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: "" }),
		JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: "in\nput" }),
		JSON.stringify({ event: DIAGNOSTIC_EVENT, stage: long }),
		`${DIAGNOSTIC_EVENT} but not json at all`,
	]) {
		const reader = new StderrReader();
		reader.push(buf(`${line}\n`));
		const record = reader.record;
		assert.deepEqual([record.stageCount, record.serving], [0, false], line);
		assert.equal(record.lastStage, undefined, line);
		assert.equal(record.tail, `${line}\n`, "what this transport does not recognize is kept as the text it is");
	}

	// A line with no LF after it is never parsed, however much of a diagnostic it looks like.
	const cut = new StderrReader();
	cut.push(buf(diagnostic({ stage: "serving", sdk: "0.85.1" })));
	cut.end();
	const record = cut.record;
	assert.deepEqual([record.serving, record.stageCount, record.lines], [false, 0, 1]);
	assert.equal(record.tail.startsWith("{"), true);
});

/*
 * The stage rule above is about control characters, which is the one place a module can end up holding the bytes it
 * is describing — source a reader cannot see and a tool reads as binary. So the rule is written as code points, and
 * this checks that it stayed that way. A read of the file's own text rather than of anything it does: no process and
 * no command, and it says nothing about any other file.
 */
test("the module writes its control-character rule as code points, and holds none of those characters itself", () => {
	const source = fs.readFileSync(fileURLToPath(new URL("../extensions/backends/pi-transport.ts", import.meta.url)), "utf8");
	assert.ok(source.includes("if (code < 0x20 || code === 0x7f) return undefined;"), "the rule is numbers a reader can see rather than characters they cannot");
	const embedded = [...source].filter((char) => {
		const code = char.codePointAt(0) ?? 0;
		return (code < 0x20 && char !== "\t" && char !== "\n") || code === 0x7f;
	});
	assert.deepEqual(embedded, [], "and nothing in the module is written as a control byte of its own");
});

/*
 * Where the descendants are remembered is the whole of what lets the cleanup find them: Pi's own abort kills a tool's
 * shell, and a detached descendant of one is re-parented out of the root's subtree as that shell dies, so an
 * observation moved after `abort` would see less while reporting exactly the same shutdown. The dynamic cases below
 * read that report and would pass either way, so this reads the finalization's own text for the one ordering that
 * matters. A read of the file rather than of anything it does: no process, no child and nothing about any other file.
 */
test("the finalization observes the tree once before it sends `clear_queue` and then `abort`", () => {
	const source = fs.readFileSync(fileURLToPath(new URL("../extensions/backends/pi-transport.ts", import.meta.url)), "utf8");
	const opens = source.indexOf("private async runFinalize(");
	assert.notEqual(opens, -1, "the one memoized finalization is still a method of that name");
	const ends = source.indexOf("\n\t}\n", opens);
	assert.ok(ends > opens, "and it still ends at its own closing brace, so this reads that method and no other");
	const body = source.slice(opens, ends);

	const awaited = "await this.tree.observe()";
	const observed = body.indexOf(awaited);
	const cleared = body.indexOf('this.control("clear_queue")');
	const aborted = body.indexOf('this.control("abort", true)');
	assert.ok(observed !== -1, "the finalization still observes the tree");
	assert.ok(cleared !== -1 && aborted !== -1, "and still sends both shutdown controls");
	assert.ok(observed < cleared, "the observation is awaited before `clear_queue`, while the live child still owns its descendants");
	assert.ok(cleared < aborted, "and the two controls keep their own order after it");
	assert.equal(body.indexOf("this.tree.observe()", observed + awaited.length), -1, "it observes once: nothing here samples, retries or polls");
	assert.ok(
		body.includes(`${awaited}.catch(() => undefined)`),
		"and its rejection is swallowed, so an observation that threw cannot stand in for the root's own end, the turn's, or the controls that follow it; a table read that could not be made still shows up as the cleanup's own `discovery`",
	);
});

test("a child that never served fails by what its own stderr said, and a silent refusal guesses nothing", () => {
	const silent = new StderrReader(piBounds({ maxStderrLineBytes: 16 }));
	silent.push(buf(`${"noise ".repeat(20)}\nplain\n`));
	const refusal = startupFailure(silent.record, { code: 78, signal: null });
	// A silent refusal is still a child that never became ready: the wording says what happened, the kind says what it
	// was. Ready rather than serving, because the bootstrap's serving diagnostic is a stage and not an answer.
	assert.equal(refusal.kind, "startup");
	assert.equal(refusal.stage, undefined);
	assert.equal(
		refusal.message,
		"the pi child did not become ready (exit code 78): it refused the call before it could serve, and left no diagnostic this host could read (2 stderr lines, 1 of them cut)\n\nChild stderr (truncated):\nplain",
	);
	assert.equal(refusal.message.includes("noise"), false, "nothing of the discarded text reaches the message");

	const tailed = new StderrReader();
	tailed.push(buf("a line from something the child started, which is nobody's diagnostic\n"));
	const other = startupFailure(tailed.record, { code: 1, signal: null });
	assert.equal(other.kind, "startup");
	assert.equal(other.stage, undefined);
	assert.equal(other.message, "the pi child did not become ready (exit code 1)\n\nChild stderr:\na line from something the child started, which is nobody's diagnostic");

	const signalled = startupFailure(new StderrReader().record, { code: null, signal: "SIGKILL" });
	assert.equal(signalled.message, "the pi child did not become ready (signal SIGKILL)");
	assert.equal(startupFailure(new StderrReader().record).message, "the pi child did not become ready");
});

test("a failure is a kind, a fixed message and what the child itself named", () => {
	// The two that are decided on this side and the child's own state are not the same kind, and do not read as one.
	assert.deepEqual(piFailure("refused"), { kind: "refused", message: "this transport would not send this call" });
	assert.deepEqual(piFailure("busy"), { kind: "busy", message: "the pi child already has a turn running" });
	assert.deepEqual(piFailure("exited", { exit: { code: 0, signal: null } }), {
		kind: "exited",
		message: "the pi child exited before its work was done (exit code 0)",
		exit: { code: 0, signal: null },
	});
	assert.equal(piFailure("timeout", { exit: { code: null, signal: null } }).message, "the pi child did not answer inside its bound (no exit code and no signal)");

	const error = new PiTransportError(piFailure("aborted", { stage: "prompt" }));
	assert.ok(error instanceof Error);
	assert.equal(error.name, "PiTransportError");
	assert.deepEqual([error.kind, error.stage, error.exit], ["aborted", "prompt", undefined]);
	assert.deepEqual(error.failure, { kind: "aborted", message: "the run was cancelled at the prompt stage", stage: "prompt" });
});

test("a cleanup that produced no report is one fixed sentence, with no exit, no stage and nothing of what threw", () => {
	// The absence of evidence, named. It is the one failure that must carry nothing: every field it could carry would be
	// this host's guess about a process it stopped being able to see.
	assert.deepEqual(piFailure("unverified"), { kind: "unverified", message: "the pi child's cleanup produced no report, and the state of its process is unverified" });

	const refusal = new PiTransportError(piFailure("unverified"));
	assert.deepEqual([refusal.kind, refusal.stage, refusal.exit, refusal.finalExit], ["unverified", undefined, undefined, undefined], "a refusal for a child nobody could report on has no record to travel on");
	assert.deepEqual(refusal.failure, { kind: "unverified", message: "the pi child's cleanup produced no report, and the state of its process is unverified" });
	// Nothing in the sentence says the process stopped, and nothing says it is running: both would be claims.
	for (const claim of ["exited", "stopped", "killed", "still running", "leftover"]) {
		assert.equal(refusal.message.includes(claim), false, claim);
	}
});

test("a response is read by the envelope the native protocol declares, and its data is left opaque", () => {
	const queue = { steering: ["one"], followUp: [] };
	const accepted: RpcResponse = { id: "pi-fusion-1", type: "response", command: "prompt", success: true };
	const cleared: RpcResponse = { id: "pi-fusion-2", type: "response", command: "clear_queue", success: true, data: queue };
	const refused: RpcResponse = { id: "pi-fusion-3", type: "response", command: "set_model", success: false, error: "Model not found: invalid/model" };

	assert.deepEqual(accept(accepted), { id: "pi-fusion-1", command: "prompt", success: true });
	const answered = accept(cleared);
	assert.equal(answered.data, queue, "what a command answered with is the bridge's to read, and is not copied or checked here");
	assert.deepEqual(accept(refused), { id: "pi-fusion-3", command: "set_model", success: false, error: "Model not found: invalid/model" });
});

test("a response this transport cannot read is a protocol failure, and the native parse reply is one of them", () => {
	const parse: RpcResponse = { type: "response", command: "parse", success: false, error: "Failed to parse command: Unexpected token" };
	const missing = refuse(parse);
	assert.equal(missing.kind, "protocol");
	assert.match(missing.message, /^the pi child sent something this transport cannot read: a response repeats the id/);
	assert.equal(missing.message.includes("Unexpected token"), false, "a protocol failure carries none of what it refused");

	for (const value of [null, undefined, 7, "a string", [], [{ id: "pi-fusion-1", type: "response", command: "prompt", success: true }]]) {
		assert.match(refuse(value).message, /a response is a json object/, String(value));
	}
	assert.match(refuse({ id: "pi-fusion-1", type: "event", command: "prompt", success: true }).message, /says its type is response/);
	assert.match(refuse({ id: "pi-fusion-1", type: "response", success: true }).message, /names the command it answers/);
	assert.match(refuse({ id: "pi-fusion-1", type: "response", command: "", success: true }).message, /names the command it answers/);
	assert.match(refuse({ id: "pi-fusion-1", type: "response", command: "prompt", success: "yes" }).message, /says whether its command succeeded/);
	assert.match(refuse({ id: "pi-fusion-1", type: "response", command: "prompt", success: false }).message, /carries the error its command failed with/);
	assert.match(refuse({ id: "pi-fusion-1", type: "response", command: "prompt", success: false, error: 7 }).message, /carries the error its command failed with/);
	assert.match(refuse({ id: 7, type: "response", command: "prompt", success: true }).message, /repeats the id of the command it answers/);
	assert.match(refuse({ id: "", type: "response", command: "prompt", success: true }).message, /repeats the id of the command it answers/);
});

test("ids go out in order, and a response is matched by its id and by the command it answers", () => {
	const correlator = new PiCorrelator();
	const hooks = { settle: () => {} };
	const first = correlator.issue("get_state", hooks);
	const second = correlator.issue("prompt", hooks);
	assert.deepEqual([first, second], [
		{ id: "pi-fusion-1", command: "get_state" },
		{ id: "pi-fusion-2", command: "prompt" },
	]);
	assert.deepEqual([correlator.issued, correlator.size], [2, 2]);

	const answer = accept({ id: "pi-fusion-1", type: "response", command: "get_state", success: true, data: { sessionId: "s-1" } });
	assert.deepEqual(correlator.match(answer), { state: "pending", request: first });
	// The same id answering another command answers this request nowhere, and is not settled as if it had.
	const crossed = accept({ id: "pi-fusion-1", type: "response", command: "prompt", success: true });
	assert.deepEqual(correlator.match(crossed), { state: "mismatch", request: first });
	// A failed response is still this request's answer: what failed is the command, not the correlation.
	const failed = accept({ id: "pi-fusion-2", type: "response", command: "prompt", success: false, error: "no model" });
	assert.deepEqual(correlator.match(failed), { state: "pending", request: second });
	assert.throws(() => correlator.issue("", hooks), TypeError);
});

test("a request settles once, its timer stopped first, and a second answer finds nothing left to settle", () => {
	const correlator = new PiCorrelator();
	const events: string[] = [];
	const request = correlator.issue("get_state", {
		stopTimer: () => events.push("timer"),
		settle: (outcome: PiOutcome) => events.push(outcome.ok ? `response ${outcome.response.command}` : `failure ${outcome.failure.kind}`),
	});
	const response = accept({ id: request.id, type: "response", command: "get_state", success: true });
	assert.equal(correlator.settle(request.id, { ok: true, response }), true);
	assert.deepEqual(events, ["timer", "response get_state"]);
	assert.equal(correlator.settle(request.id, { ok: true, response }), false, "the record goes before either hook runs, so nothing settles twice");
	assert.equal(correlator.settle(request.id, { ok: false, failure: piFailure("timeout") }), false, "and a timeout that fires after an answer settles nothing either");
	assert.deepEqual(events, ["timer", "response get_state"]);
	assert.deepEqual([correlator.size, correlator.issued], [0, 1]);
	assert.equal(correlator.classify(request.id), "late", "the id stays classifiable with nothing of it kept");
});

test("an id is pending, late or impossible, and a finished one is answered from the counter alone", () => {
	const correlator = new PiCorrelator();
	const hooks = { settle: () => {} };
	const pending = correlator.issue("prompt", hooks);
	const done = correlator.issue("abort", hooks);
	assert.equal(correlator.classify(pending.id), "pending");
	correlator.settle(done.id, { ok: false, failure: piFailure("timeout") });
	assert.equal(correlator.classify(done.id), "late");
	for (const id of [
		"pi-fusion-3",
		"pi-fusion-0",
		"pi-fusion-01",
		"pi-fusion-1e0",
		"pi-fusion--1",
		"pi-fusion-1 ",
		" pi-fusion-1",
		"pi-fusion-",
		`pi-fusion-${Number.MAX_SAFE_INTEGER}0`,
		"req-1",
		"",
		7,
		null,
		undefined,
		{ id: "pi-fusion-1" },
	]) {
		assert.equal(correlator.classify(id), "impossible", String(id));
	}
});

test("the pending cap is admission, a refused request takes no id, and a released slot is usable again", () => {
	const correlator = new PiCorrelator(piBounds({ maxPendingRequests: 2 }));
	const hooks = { settle: () => {} };
	const first = correlator.issue("prompt", hooks);
	correlator.issue("get_state", hooks);
	let thrown: unknown;
	try {
		correlator.issue("abort", hooks);
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof PiTransportError);
	assert.equal(thrown.kind, "refused", "a slot this transport does not have is its own refusal, not a turn the child is running");
	assert.deepEqual([correlator.issued, correlator.size], [2, 2], "a request that cannot be waited on takes no id and is never written");

	// Dropping a request the writer never sent is this same call: the slot comes back and its caller is told why.
	assert.equal(correlator.settle(first.id, { ok: false, failure: piFailure("aborted") }), true);
	assert.equal(correlator.issue("abort", hooks).id, "pi-fusion-3");
	assert.equal(correlator.classify(first.id), "late");
});

test("one failure settles everything outstanding, once each, and there is nothing left to settle after it", () => {
	const correlator = new PiCorrelator();
	const seen: string[] = [];
	for (const command of ["prompt", "get_state", "abort"]) {
		correlator.issue(command, { settle: (outcome: PiOutcome) => seen.push(outcome.ok ? "response" : outcome.failure.kind) });
	}
	assert.equal(correlator.settleAll(piFailure("closed")), 3);
	assert.deepEqual(seen, ["closed", "closed", "closed"]);
	assert.deepEqual([correlator.size, correlator.issued], [0, 3]);
	assert.equal(correlator.settleAll(piFailure("closed")), 0);
	assert.deepEqual(seen, ["closed", "closed", "closed"]);
});

test("a settle hook that throws does not keep the request behind it waiting, and its own error still comes out", () => {
	const correlator = new PiCorrelator(piBounds({ maxPendingRequests: 4 }));
	const thrown = new Error("this caller's own settle hook threw");
	const settled: string[] = [];
	const stopped: string[] = [];
	const first = correlator.issue("get_state", {
		stopTimer: () => stopped.push("first"),
		settle: () => {
			throw thrown;
		},
	});
	const second = correlator.issue("get_session_stats", {
		stopTimer: () => stopped.push("second"),
		settle: (outcome: PiOutcome) => settled.push(outcome.ok ? "response" : outcome.failure.kind),
	});

	const failure = piFailure("unverified");
	assert.throws(
		() => correlator.settleAll(failure),
		(error: unknown) => error === thrown,
		"the first hook's own value comes back out, unwrapped and not replaced by anything the loop did afterwards",
	);
	assert.deepEqual(settled, ["unverified"], "the request behind the one that threw was settled all the same, which is what it was owed");
	assert.deepEqual(stopped, ["first", "second"], "and each one's timer was stopped as its record left the map");
	assert.equal(correlator.size, 0, "nothing is left pending: a record is removed before either of its hooks runs");

	// So a second pass has nothing to find, and no hook is replayed for the id whose own hook threw.
	assert.equal(correlator.settleAll(failure), 0);
	assert.deepEqual(settled, ["unverified"]);
	assert.deepEqual(stopped, ["first", "second"]);
	assert.deepEqual([correlator.classify(first.id), correlator.classify(second.id)], ["late", "late"], "both ids are finished ones rather than ids this correlator is still waiting on");
});

/* ------------------------------------------------------------------------------------------------------------------
 * The lifecycle, against the protocol-speaking fake. Everything below starts a process.
 * ---------------------------------------------------------------------------------------------------------------- */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The same resolution fence every other subprocess in this suite runs behind: a rule, not a sandbox. */
const FENCE = path.join(repoRoot, "test", "sdk-fence.mjs");
const FAKE_PI = path.join(repoRoot, "test", "fake-pi.mjs");

/** Short enough that a case which hangs fails instead, and far longer than anything the fake actually takes. */
const TEST_BOUNDS: Partial<PiBounds> = { startupMs: 20_000, ackMs: 20_000, requestMs: 10_000, shutdownStepMs: 1_500 };
const TEST_CLEANUP: OwnedCleanup = { exitGraceMs: 1_500, stopGraceMs: 1_500, leftoverGraceMs: 300, pipeGraceMs: 800, tableTimeoutMs: 3_000 };
/** The grace every child of a case is given before its tree escalates. Named so the arithmetic below can read it. */
const TEST_KILL_GRACE_MS = 2_000;

/**
 * Everything one case's own teardown is configured to be allowed to take, added together: every cleanup grace above
 * and the kill grace beside them. It is arithmetic over this file's own constants and not a duration anybody measured,
 * and it exists so a failure deadline can be set above it rather than at a number somebody liked the look of.
 */
const CLEANUP_BUDGET_MS =
	(TEST_CLEANUP.exitGraceMs ?? 0) + (TEST_CLEANUP.stopGraceMs ?? 0) + (TEST_CLEANUP.leftoverGraceMs ?? 0) + (TEST_CLEANUP.pipeGraceMs ?? 0) + (TEST_CLEANUP.tableTimeoutMs ?? 0) + TEST_KILL_GRACE_MS;

/** How long a call a case put under a deadline may take before that case fails. Well above the budget it covers. */
const CASE_DEADLINE_MS = CLEANUP_BUDGET_MS + 10_000;

/**
 * One call under a failure deadline, which is what this is and all it is: it says whether the call came back at all,
 * and nothing about how long anything took. The bound is far above everything the work it covers is configured to be
 * allowed to take, so only a call waiting on something it should never be waiting on can reach it. Nothing is
 * cancelled when it does — the call goes on, and the case's own teardown still awaits whatever it started.
 */
async function within<T>(what: string, work: Promise<T>, ms = CASE_DEADLINE_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} had not come back inside this case's failure deadline of ${ms}ms`)), ms);
	});
	// The loser of the race is left to nobody, so its rejection is taken here rather than becoming an unhandled one.
	deadline.catch(() => {});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Paths a case named instead of leaving silent, for either of two reasons: nothing proved its child was over, so the
 * removal was never attempted, or a removal that was attempted did not finish.
 *
 * It is a list of paths to look at and not a claim about any of them. A case that never reached the gate did not
 * delete blind; a removal that threw part way through may have left the directory gone, there, or there with some of
 * what it held already removed, and nothing here infers which.
 */
const RETAINED: string[] = [];

interface Owned {
	root: string;
	storage: PreparedCall;
	launch: LaunchOptions;
	logPath: string;
	dispose(): void;
}

/**
 * One case's own world: a unique root, the directories a program reads to decide where to put a home, a temporary
 * file or a cache, and the production storage, input and launch composed inside it. The environment is built up
 * rather than copied down — nothing of the host's configuration, no provider key, no auth path and no PI variable —
 * so what the child gets is what this case gave it and the two fixture variables.
 *
 * What is composed is the real thing: `prepareCallStorage`, `bootstrapInput`, `writeCallInput` and `piLaunch`, with
 * the fake named as the bootstrap. Only then is the command replaced with this node and the fence put in front of
 * it, because `piLaunch` says `node` and a test may not depend on what that resolves to on a search path.
 */
function ownedCase(scenario: string): Owned {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-fusion-transport-"));
	const own = (name: string): string => {
		const at = path.join(root, name);
		fs.mkdirSync(at, { recursive: true });
		return at;
	};
	const cwd = own("cwd");
	const hostAgentDir = own("agent");
	const logPath = path.join(own("log"), "fake-pi.jsonl");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: own("home"),
		TMPDIR: own("tmp"),
		XDG_CONFIG_HOME: own("xdg/config"),
		XDG_DATA_HOME: own("xdg/data"),
		XDG_CACHE_HOME: own("xdg/cache"),
		XDG_STATE_HOME: own("xdg/state"),
		FAKE_PI_SCENARIO: scenario,
		FAKE_PI_LOG: logPath,
	};
	if (process.platform === "win32") {
		for (const name of ["SystemRoot", "SystemDrive", "windir", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
			if (process.env[name] !== undefined) env[name] = process.env[name];
		}
		Object.assign(env, { APPDATA: own("appdata"), LOCALAPPDATA: own("localappdata"), USERPROFILE: env.HOME, TEMP: env.TMPDIR, TMP: env.TMPDIR });
	}
	const storage = prepareCallStorage({ hostAgentDir, cwd, handle: "run-1" });
	const role = piRole({ role: "implement", model: "deepseek/deepseek-chat", effort: "high" }, undefined, {});
	const input = bootstrapInput({ role, storage, session: { kind: "new" }, contract: "# implement\nDo the task." });
	writeCallInput(storage, input);
	const composed = piLaunch({ input, storage, env, bootstrap: FAKE_PI });
	return {
		root,
		storage,
		logPath,
		launch: { ...composed, command: process.execPath, args: ["--import", pathToFileURL(FENCE).href, ...composed.args] },
		dispose: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

interface Fixture {
	owned: Owned;
	start(over?: Partial<PiChildOptions>): Promise<PiChild>;
	/**
	 * Every exit this case has a report for: a child that was shut down, and a refused startup that carried one. What
	 * is in here decides the cleanup together with how many starts were attempted, because a start with no report in
	 * here is the case the count is for.
	 */
	exits: PiExit[];
}

/**
 * One thing a case threw, kept exactly as it was thrown. The value sits in a field rather than being tested for truth:
 * `undefined`, `null` and `""` are all values a throw can carry, and none of them may be lost on the way out.
 */
interface Thrown {
	/** What was being done, for a reader of the aggregate. Never a substitute for the error itself. */
	what: string;
	error: unknown;
}

/**
 * The root outcomes that say the root process itself is over, listed one by one rather than derived from what is not
 * `unstoppable`: an outcome added to the report later would otherwise be read as proof by default.
 */
const ROOT_OVER: readonly PiExit["cleanup"]["root"][] = ["unspawned", "exited", "stopped"];

/**
 * Whether this case's own root directory may be removed, and everything missing when it may not.
 *
 * Every start attempt has to be answered by a report the transport itself wrote — a child's own shutdown, or the
 * `finalExit` a refused startup carries — and each report has to say the root process is over, that its pipes closed,
 * that this host's reading of both streams ended, and that nothing the cleanup listed is unresolved. A start that
 * threw with no report on it is proof of nothing: no report was written, so none is read, and the root is kept and
 * named instead of being inferred from an error's type or a status nobody observed. Nothing here is decided by
 * `every` over an empty list either — the attempt count is what makes an empty list of reports mean anything, and no
 * attempt with no report is the one case that may be removed on that emptiness.
 *
 * `discovery === "unavailable"` and `deadlineHit` do not keep a root here, and that is this fixture's own topology
 * rather than a general rule: a case's child is `test/fake-pi.mjs` preloaded with `test/sdk-fence.mjs`, and neither of
 * them starts anything — the fake imports `node:fs` and `node:path`, the fence imports `node:module`, and a test below
 * pins both — so the root is the whole tree, and a process table this cleanup could not read says nothing about
 * descendants that were never there. What is required instead is the root's own termination, closed pipes on both
 * sides, and empty `leftovers` and `skipped`. A held pipe, a verified leftover or a target whose identity could not be
 * proved is uncertainty, and uncertainty keeps the directory; none of those flags is an observation of a live survivor
 * either, which is why one is never read as proof in the other direction.
 *
 * What this does not qualify: any fixture whose child does start something. A descendant that inherited a pipe, or one
 * that closed its pipes and went on running, is invisible to every field read here, and a fixture like that needs
 * proof of its own rather than this function — which is still pending work, not something this stands in for.
 */
function disposalEvidence(attempts: number, results: readonly PiExit[]): { dispose: boolean; missing: string[] } {
	const missing: string[] = [];
	if (attempts !== results.length) missing.push(`${attempts} start attempts against ${results.length} reports, so a start that left no report is unaccounted for`);
	for (const [at, result] of results.entries()) {
		const which = `report ${at + 1} of ${results.length}`;
		const cleanup = result.cleanup;
		if (!ROOT_OVER.includes(cleanup.root)) missing.push(`${which}: its root is "${cleanup.root}" rather than one that says the root is over`);
		if (cleanup.stdio !== "closed") missing.push(`${which}: its pipes are "${cleanup.stdio}"`);
		if (result.counters.streamsUnclosed !== 0) missing.push(`${which}: ${result.counters.streamsUnclosed} of its streams had not closed`);
		if (cleanup.leftovers.length) missing.push(`${which}: ${cleanup.leftovers.length} verified leftovers`);
		if (cleanup.skipped.length) missing.push(`${which}: ${cleanup.skipped.length} targets whose identity it could not prove`);
	}
	return { dispose: missing.length === 0, missing };
}

/**
 * The failure a case reports for a root it would not remove: the path a reader needs first, then every reason.
 *
 * This wording belongs to the negative gate alone. A removal that threw after the gate passed is not this — the child
 * was proved over before anything was removed — and it says so in its own words rather than borrowing these.
 */
const retainedRootFailure = (root: string, missing: readonly string[]): Error => new Error(`the root ${root} was kept, because nothing proved this case's child was over: ${missing.join("; ")}`);

/**
 * The two removals a case is authorized to attempt, as functions, so a regression can drive both without a disk. Both
 * are called as plain functions, so a caller hands in closures over what they remove rather than methods off an object.
 */
interface OwnedDisposers {
	/** This call's own directory, through the disposer the storage bound to it: it can name no other path. */
	call(): void;
	/** The root this case made, which holds that call directory and everything else the case wrote. */
	root(): void;
}

/**
 * The removal of one case's own directories, attempted past the positive termination gate and nowhere else.
 *
 * Both steps run and each is caught on its own. A call disposer that threw must not keep this case from attempting
 * the root removal it is authorized to attempt, and neither step may escape: an unguarded removal would leave the
 * case throwing whatever the filesystem said in place of the failure the body already had. Every original value is
 * kept as it was thrown, falsy values included, in the same problems list as everything else, with the step it was
 * and the path it was for.
 *
 * What a failure here does not say. It says nothing about a process: the gate has already read the reports that say
 * the child was over, so a step that threw is a removal that did not finish and no more than that. It says nothing
 * about the path either — after a removal that stopped part way the directory may be gone, may be there, and may be
 * there with some of what it held removed — so the report names the path and describes no state of it. Nothing here
 * retries, waits, signals anything or widens what may be removed.
 */
function disposeOwned(root: string, disposers: OwnedDisposers, problems: Thrown[]): boolean {
	let threw = false;
	for (const [step, dispose] of [
		["the disposer of this call's own directory", disposers.call],
		["the removal of the root this case made", disposers.root],
	] as const) {
		try {
			dispose();
		} catch (error) {
			threw = true;
			problems.push({ what: `${step}, for ${root}, threw instead of finishing`, error });
		}
	}
	return threw;
}

/**
 * What a case throws at the end of itself, and nothing when nothing went wrong.
 *
 * One problem is thrown exactly as it was thrown, so a case that only failed its own assertion reads the way it always
 * did. Several become one `AggregateError` that names the retained root and keeps every original, in the order they
 * happened: a teardown never replaces the body's failure, and a body failure never hides the root that was kept. This
 * answers with what to throw rather than throwing, because `undefined` is a value a throw can carry and a truthiness
 * test on the way out would lose it.
 */
function caseFailure(problems: readonly Thrown[], root: string): { throws: false } | { throws: true; error: unknown } {
	if (problems.length === 0) return { throws: false };
	if (problems.length === 1) return { throws: true, error: problems[0].error };
	return {
		throws: true,
		error: new AggregateError(
			problems.map((problem) => problem.error),
			`this case had ${problems.length} failures and its root is ${root}: ${problems.map((problem) => problem.what).join("; ")}`,
		),
	};
}

/**
 * Every child of a case, asked to finish in the order it was started. Each one is asked whatever the one before it did,
 * because a shutdown that rejected must not leave the child behind it unasked, and a rejection is kept rather than
 * swallowed: it is a child this case has no report for, which is exactly what the gate above refuses to remove on.
 */
async function finishAll(children: readonly Pick<PiChild, "pid" | "shutdown">[], exits: PiExit[], problems: Thrown[]): Promise<void> {
	for (const child of children) {
		try {
			exits.push(await child.shutdown());
		} catch (error) {
			problems.push({ what: `the shutdown of the child with pid ${child.pid}, which rejected instead of reporting how it ended`, error });
		}
	}
}

/**
 * One case, from its own root to the removal of it. Every child the body started is asked to finish before anything is
 * removed, and the root goes only when `disposalEvidence` says every attempted start was reported on and every report
 * was positive: deleting under something that may still be writing there, and signalling a pid this test merely
 * remembers, are both worse than a directory left behind and named.
 *
 * Nothing is lost on the way out. The body's own failure, each shutdown that rejected, each removal step that threw,
 * and the root that was kept are separate problems: one of them is rethrown exactly as it was thrown, and several
 * become one `AggregateError` that names the root and keeps every original. A teardown never masks the body, a removal
 * that threw never takes the place of either, and a body failure never hides the path that was left behind.
 */
async function withFake(scenario: string, body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const owned = ownedCase(scenario);
	const exits: PiExit[] = [];
	const children: PiChild[] = [];
	const problems: Thrown[] = [];
	/** Every call to `start`, answered or not: what the gate counts its reports against. */
	let attempts = 0;
	const fixture: Fixture = {
		owned,
		exits,
		start: async (over: Partial<PiChildOptions> = {}) => {
			attempts += 1;
			const { bounds, ...rest } = over;
			// The launch is this case's own and is written last, so no override can point a child somewhere else.
			const options: PiChildOptions = { killGraceMs: TEST_KILL_GRACE_MS, cleanup: TEST_CLEANUP, ...rest, launch: owned.launch, bounds: { ...TEST_BOUNDS, ...bounds } };
			try {
				const child = await startPiChild(options);
				children.push(child);
				return child;
			} catch (error) {
				// A refused startup carries the whole record of the child it finished; a refusal with none is a start
				// nobody reported on, and it stays unaccounted for rather than being read as a child that never ran.
				if (error instanceof PiTransportError && error.finalExit) exits.push(error.finalExit);
				throw error;
			}
		},
	};
	try {
		await body(fixture);
	} catch (error) {
		problems.push({ what: "the case's own body", error });
	}
	await finishAll(children, exits, problems);
	const evidence = disposalEvidence(attempts, exits);
	if (evidence.dispose) {
		// Owned, and only past the gate: this call's own directory, and then the root that holds it and nothing else.
		// A step that threw is named as a path to look at, without a claim that anything is or is not still there.
		if (disposeOwned(owned.root, { call: () => owned.storage.dispose(), root: () => owned.dispose() }, problems)) RETAINED.push(owned.root);
	} else {
		RETAINED.push(owned.root);
		problems.push({ what: "the evidence this case's root could be removed on", error: retainedRootFailure(owned.root, evidence.missing) });
	}
	const ending = caseFailure(problems, owned.root);
	if (ending.throws) throw ending.error;
}

after(() => {
	assert.deepEqual(RETAINED, [], "every case proved its child was over, and every removal one of them was allowed to attempt finished; a path here is one to look at rather than one claimed to be there");
});

/** The refusal a call was supposed to get. Anything else thrown is that test's own failure and is rethrown. */
async function refusal(work: Promise<unknown>): Promise<PiTransportError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof PiTransportError) return error;
		throw error;
	}
	return assert.fail("this call should have been refused");
}

/** A command whose name the compiler pins against the native union, so a fixture cannot drift from the protocol. */
const ASK_STATS: Extract<RpcCommand, { type: "get_session_stats" }> = { type: "get_session_stats" };

/**
 * Every command the fake wrote down as having read, in the order it read them, from this case's own log file and
 * nowhere else. The fake appends that line before it answers, so a command whose answer a case already has is in
 * here; a command nobody sent is in here nowhere, which is what makes an absence readable at all.
 */
const commandsRead = (owned: Owned): Array<{ type: string; [key: string]: unknown }> =>
	fs
		.readFileSync(owned.logPath, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { read?: string })
		.flatMap((entry) => (typeof entry.read === "string" ? [JSON.parse(entry.read) as { type: string; [key: string]: unknown }] : []));

const ZERO_COUNTERS = {
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

/* ------------------------------------------------------------------------------------------------------------------
 * The harness's own rules, driven directly. These build reports in the shape the transport writes them and stub the
 * two members of a child that the teardown uses: nothing below starts a process, removes a directory or reads one, so
 * the combinations the gate has to refuse are cases here rather than children a test would have to arrange.
 * ---------------------------------------------------------------------------------------------------------------- */

/** One process row, for the two lists whose emptiness the gate reads. Numbers this test made up and never signals. */
const OBSERVED_ROW = { pid: 424_242, ppid: 1, pgid: 424_242, state: "S", started: "1" };

/**
 * One exit report, positive in every field the gate reads, with whatever a case is about named over it. Nothing here
 * ran: it is a report in the shape the transport writes one, so a case can be about one field instead of about a child
 * it would have had to arrange to get that field.
 */
const reportedExit = (over: { cleanup?: Partial<PiExit["cleanup"]>; counters?: Partial<PiExit["counters"]> } = {}): PiExit => ({
	exit: { code: 0, signal: null },
	cleanup: { root: "exited", exit: { code: 0, signal: null }, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false, ...over.cleanup },
	stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: "", dropped: 0 },
	stoppedByUs: true,
	counters: { ...ZERO_COUNTERS, ...over.counters },
});

test("a case that started nothing has nothing to prove, and one that started something accounts for every attempt", () => {
	assert.deepEqual(disposalEvidence(0, []), { dispose: true, missing: [] }, "no attempt and no report is the one case an empty list of reports is enough for");
	const unreported = disposalEvidence(1, []);
	assert.equal(unreported.dispose, false, "a start that threw with no report on it is not proof that nothing is left running");
	assert.equal(unreported.missing.length, 1);
	assert.match(unreported.missing[0], /1 start attempts against 0 reports/);
	assert.equal(disposalEvidence(2, [reportedExit()]).dispose, false, "and a positive report does not cover the attempt that has none");
	assert.equal(disposalEvidence(1, [reportedExit()]).dispose, true, "one attempt answered by one positive report is a root that may go");
});

test("a root that is over, with its pipes closed and nothing unresolved, is the whole of what the gate asks for", () => {
	for (const root of ["exited", "stopped", "unspawned"] as const) {
		assert.deepEqual(disposalEvidence(1, [reportedExit({ cleanup: { root } })]), { dispose: true, missing: [] }, root);
	}
	assert.equal(disposalEvidence(2, [reportedExit(), reportedExit({ cleanup: { root: "unspawned" } })]).dispose, true, "two children in one case, both reported on");
	// A terminated descendant is a signal that was proved to have landed, which is the one list that is not uncertainty.
	assert.equal(disposalEvidence(1, [reportedExit({ cleanup: { terminated: [OBSERVED_ROW] } })]).dispose, true);
});

test("a root nothing could stop keeps the directory, and the reason it was kept is what the root itself said", () => {
	const kept = disposalEvidence(1, [reportedExit({ cleanup: { root: "unstoppable" } })]);
	assert.equal(kept.dispose, false);
	assert.equal(kept.missing.length, 1);
	assert.match(kept.missing[0], /its root is "unstoppable"/);
	const failure = retainedRootFailure("/tmp/pi-fusion-transport-kept", kept.missing);
	assert.match(failure.message, /\/tmp\/pi-fusion-transport-kept/, "the path a reader has to have is in the message");
	assert.match(failure.message, /unstoppable/, "and so is what kept it");
});

test("a held pipe, a stream that never closed, a verified leftover and an unproved target each keep the root on their own", () => {
	for (const [what, exit] of [
		["pipes the cleanup could not see close", reportedExit({ cleanup: { stdio: "held" } })],
		["a stream this host stopped waiting on", reportedExit({ counters: { streamsUnclosed: 1 } })],
		["a descendant verified still alive", reportedExit({ cleanup: { leftovers: [OBSERVED_ROW] } })],
		["a target whose identity could not be proved", reportedExit({ cleanup: { skipped: [OBSERVED_ROW] } })],
	] as const) {
		const kept = disposalEvidence(1, [exit]);
		assert.equal(kept.dispose, false, what);
		assert.equal(kept.missing.length, 1, what);
	}

	// Everything at once is reported at once: a reader gets every reason rather than the first one that failed.
	const all = disposalEvidence(2, [reportedExit({ cleanup: { root: "unstoppable", stdio: "held", leftovers: [OBSERVED_ROW], skipped: [OBSERVED_ROW] }, counters: { streamsUnclosed: 2 } })]);
	assert.equal(all.dispose, false);
	assert.equal(all.missing.length, 6, "the attempt with no report, and the five things the report it does have said");
});

/** The builtins a program would have to reach for to start a process, by both spellings node accepts for each. */
const WAYS_TO_START = ["child_process", "node:child_process", "worker_threads", "node:worker_threads", "cluster", "node:cluster"];

/** The import specifiers of one of this fixture's own programs, read as text — the form the fake's import pin reads. */
const importSpecifiers = (source: string): string[] => [...source.matchAll(/^import .*? from "(.*?)";$/gm)].map((match) => match[1]);

test("an unreadable process table and a deadline that was hit do not keep a root of a fixture that grows no tree", () => {
	// Why this is this fixture's own rule and not a general one: the child of a case is the fake, preloaded with the
	// fence, and neither of them starts anything — so the root is the whole tree, and a process table nobody could read
	// says nothing about descendants that were never there.
	//
	// What the two pins below are: a regression pin on how these programs are spelled and on what they import today.
	// Neither is a containment proof — a fence is a resolution rule and not a sandbox, and either file could be changed
	// to start something — which is why a change to either one has to fail here and be read rather than adjusted away.
	const source = fs.readFileSync(FAKE_PI, "utf8");
	for (const way of ["spawn", "fork", "child_process", "worker_threads", "execFile"]) {
		assert.equal(source.includes(way), false, `the fake starts nothing, and names no way of starting anything (${way})`);
	}
	for (const way of WAYS_TO_START) assert.equal(importSpecifiers(source).includes(way), false, `and it imports none either (${way})`);

	// The fence is the other half of the child's topology. Its own prose is about what it does not cover and names a
	// spawn among the things it says nothing about, so what is pinned here is what it imports and not what it explains.
	const fence = importSpecifiers(fs.readFileSync(FENCE, "utf8"));
	assert.deepEqual(fence, ["node:module"], "the fence preloaded into every case's child imports one builtin, and it is the hook api");
	for (const way of WAYS_TO_START) assert.equal(fence.includes(way), false, `and it imports no way of starting a process (${way})`);

	assert.deepEqual(disposalEvidence(1, [reportedExit({ cleanup: { discovery: "unavailable", deadlineHit: true } })]), { dispose: true, missing: [] }, "the root ended, both pipes closed, and nothing was left unresolved");

	// And neither flag rescues a root that is not over: they are uncertainty about descendants, not evidence either way.
	assert.equal(disposalEvidence(1, [reportedExit({ cleanup: { discovery: "unavailable", deadlineHit: true, root: "unstoppable" } })]).dispose, false);
	assert.equal(disposalEvidence(1, [reportedExit({ cleanup: { discovery: "unavailable", deadlineHit: true, skipped: [OBSERVED_ROW] } })]).dispose, false);
	assert.equal(disposalEvidence(1, [reportedExit({ cleanup: { discovery: "unavailable", deadlineHit: true, stdio: "held" } })]).dispose, false);
});

test("every child of a case is asked to finish even when the one before it rejected, and a rejection is a missing report", async () => {
	const exits: PiExit[] = [];
	const problems: Thrown[] = [];
	const asked: number[] = [];
	const first = reportedExit({ cleanup: { root: "stopped" } });
	const last = reportedExit();
	const rejected = new Error("this shutdown never reported how its child ended");
	// Stubs of exactly the two members the teardown uses. A shutdown or an exit that rejects with no report at all is
	// what a later fix to the transport's own finalization can produce, and this harness has to keep the root for it.
	const children: Pick<PiChild, "pid" | "shutdown">[] = [
		{
			pid: 11,
			shutdown: async () => {
				asked.push(11);
				return first;
			},
		},
		{
			pid: 12,
			shutdown: async () => {
				asked.push(12);
				throw rejected;
			},
		},
		{
			pid: 13,
			shutdown: async () => {
				asked.push(13);
				return last;
			},
		},
	];
	await finishAll(children, exits, problems);
	assert.deepEqual(asked, [11, 12, 13], "a rejection in the middle does not end the teardown");
	assert.deepEqual(exits, [first, last], "and the two that reported are the only reports there are");
	assert.equal(problems.length, 1);
	assert.equal(problems[0].error, rejected, "kept as it was thrown, with its own stack");
	assert.match(problems[0].what, /pid 12/, "and it says which child there is no report for");
	assert.equal(disposalEvidence(3, exits).dispose, false, "three children and two reports: the root is kept for the one that answered nothing");
});

test("a case keeps every failure it collected, unwrapped when there is one and named with its root when there are more", () => {
	const root = "/tmp/pi-fusion-transport-kept";
	const body = new Error("the assertion the case itself failed");
	const teardown = new Error("a shutdown that rejected afterwards");
	const kept = retainedRootFailure(root, disposalEvidence(1, []).missing);

	assert.deepEqual(caseFailure([], root), { throws: false }, "a case that went well throws nothing at all");

	const alone = caseFailure([{ what: "the case's own body", error: body }], root);
	assert.deepEqual(alone, { throws: true, error: body }, "one problem is that problem, unwrapped and with its own stack");

	// A falsy throw is a throw, and the one that would be dropped by a truthiness test on the way out.
	const falsy = caseFailure([{ what: "a shutdown", error: undefined }], root);
	assert.deepEqual(falsy, { throws: true, error: undefined });
	const empty = caseFailure([{ what: "a shutdown", error: "" }], root);
	assert.deepEqual(empty, { throws: true, error: "" });

	const several = caseFailure(
		[
			{ what: "the case's own body", error: body },
			{ what: "a shutdown", error: teardown },
			{ what: "the evidence this case's root could be removed on", error: kept },
		],
		root,
	);
	assert.equal(several.throws, true);
	const aggregate = several.throws ? several.error : undefined;
	if (!(aggregate instanceof AggregateError)) return assert.fail("several problems are one error carrying all of them");
	assert.deepEqual(aggregate.errors, [body, teardown, kept], "the originals, in the order they happened, none of them wrapped");
	assert.equal(aggregate.errors[0], body, "so the body's failure is not masked by what teardown did after it");
	assert.match(aggregate.message, /pi-fusion-transport-kept/, "and the retained root is named whether the body failed or not");
	assert.match(aggregate.errors[2].message, /unstoppable|unaccounted for/, "the root that was kept says why, and the body's failure did not hide it");
});

/** A path this test names and never touches: every removal below is a stub function, and none of them is a disk. */
const OWNED_ROOT = "/tmp/pi-fusion-transport-owned";

test("a removal that went through adds nothing, and both steps happen in the order a case owns them", () => {
	const order: string[] = [];
	const problems: Thrown[] = [];
	const threw = disposeOwned(OWNED_ROOT, { call: () => order.push("call"), root: () => order.push("root") }, problems);
	assert.equal(threw, false, "a removal that finished is not a failure of the case");
	assert.deepEqual(order, ["call", "root"], "this call's own directory first, then the root that holds it");
	assert.deepEqual(problems, [], "and a clean removal leaves the case with nothing to throw");
});

test("a removal step that threw does not stop the other one, and never escapes to take another failure's place", () => {
	// The hole this closes: either disposer ran unguarded, so whatever the filesystem said left the case throwing that
	// instead of the failure its body had already collected, and the second step was never attempted at all.
	const callThrew = new Error("this call's directory would not go");
	const attempted: string[] = [];
	const afterCall: Thrown[] = [];
	assert.equal(
		disposeOwned(
			OWNED_ROOT,
			{
				call: () => {
					throw callThrew;
				},
				root: () => attempted.push("root"),
			},
			afterCall,
		),
		true,
	);
	assert.deepEqual(attempted, ["root"], "the root removal this case is authorized to attempt still happens");
	assert.equal(afterCall.length, 1);
	assert.equal(afterCall[0].error, callThrew, "kept as it was thrown, and not wrapped");
	assert.match(afterCall[0].what, /pi-fusion-transport-owned/, "and the path it was for is in what it says");
	assert.equal(/still (there|exists)|intact/.test(afterCall[0].what), false, "a step that threw says nothing about what is on disk");

	const rootThrew = new Error("the root would not go");
	const ran: string[] = [];
	const afterRoot: Thrown[] = [];
	assert.equal(
		disposeOwned(
			OWNED_ROOT,
			{
				call: () => ran.push("call"),
				root: () => {
					throw rootThrew;
				},
			},
			afterRoot,
		),
		true,
	);
	assert.deepEqual(ran, ["call"]);
	assert.deepEqual(
		afterRoot.map((problem) => problem.error),
		[rootThrew],
		"a root removal that threw is the one problem here, and the step before it was no problem at all",
	);
});

test("both removals can fail at once, and a falsy value thrown by one of them is still a problem", () => {
	const problems: Thrown[] = [];
	const threw = disposeOwned(
		OWNED_ROOT,
		{
			call: () => {
				throw undefined;
			},
			root: () => {
				throw "";
			},
		},
		problems,
	);
	assert.equal(threw, true);
	assert.equal(problems.length, 2, "each step is caught on its own, so the second was attempted and kept too");
	assert.deepEqual(
		problems.map((problem) => problem.error),
		[undefined, ""],
		"a falsy throw is a throw, and neither of these may be lost on the way out",
	);
	assert.match(problems[0].what, /this call's own directory/);
	assert.match(problems[1].what, /the root this case made/);
});

test("a removal that threw is kept beside the failure the case already had, in the order the two happened", () => {
	const body = new Error("the assertion the case itself failed");
	const rootThrew = new Error("the root would not go");
	// The body's failure is already collected when the gate passes, which is what an unguarded removal would replace.
	const problems: Thrown[] = [{ what: "the case's own body", error: body }];
	assert.equal(
		disposeOwned(
			OWNED_ROOT,
			{
				call: () => undefined,
				root: () => {
					throw rootThrew;
				},
			},
			problems,
		),
		true,
	);
	const ending = caseFailure(problems, OWNED_ROOT);
	assert.equal(ending.throws, true);
	const aggregate = ending.throws ? ending.error : undefined;
	if (!(aggregate instanceof AggregateError)) return assert.fail("a body failure and a removal that threw are one error carrying both");
	assert.deepEqual(aggregate.errors, [body, rootThrew], "the body's failure first, the removal's second, neither masked by the other");
	assert.match(aggregate.message, /pi-fusion-transport-owned/, "and the path is visible in what a reader sees first");
	assert.equal(aggregate.message.includes("nothing proved this case's child was over"), false, "a removal that threw after the gate is not the negative gate's failure");
});

test("the fake speaks the bootstrap's own marker and configuration exit code, and imports no sdk", () => {
	const source = fs.readFileSync(FAKE_PI, "utf8");
	assert.ok(source.includes(`const DIAGNOSTIC_EVENT = ${JSON.stringify(DIAGNOSTIC_EVENT)};`), "the marker the fake writes is the one the bootstrap writes");
	assert.ok(source.includes(`const STARTUP_EXIT_CODE = ${STARTUP_EXIT_CODE};`), "and the exit code it refuses with is the bootstrap's own");
	const imports = [...source.matchAll(/^import .*? from "(.*?)";$/gm)].map((match) => match[1]);
	assert.deepEqual(imports, ["node:fs", "node:path"], "the fake imports node builtins and nothing else: no sdk, no production module and no harness");
});

test("a child starts through the real launch composition and answers what it opened, and nothing more is claimed", async () => {
	await withFake("ok", async (fixture) => {
		const child = await fixture.start();
		assert.ok(child.pid > 0);
		// Pinned against the native state shape, so the fixture cannot drift from the protocol it stands in for.
		const state = child.startState.raw as unknown as RpcSessionState;
		assert.equal(state.sessionId, "fake-pi-session-0001");
		assert.equal(child.startState.sessionId, state.sessionId);
		assert.equal(path.dirname(state.sessionFile ?? ""), fixture.owned.storage.sessionDir, "the session the child named is inside the session directory the call gave it");
		assert.equal(fs.existsSync(fixture.owned.storage.inputPath), true, "and it was launched from the input file the production storage wrote");
		assert.deepEqual(child.counters, ZERO_COUNTERS);

		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined, "a child this host asked to stop, that stopped, failed at nothing");
		assert.equal(exit.stoppedByUs, true);
		assert.equal(exit.cleanup.root, "exited", "closing its stdin is what an orderly pi shutdown is, and it ended on its own");
		assert.deepEqual([exit.stderr.serving, exit.stderr.lastStage, exit.stderr.sdk, exit.stderr.stageCount], [true, "serving", "0.85.1", 4]);
		// Stderr is not the fake's alone — node writes its own warnings there — so what is claimed is that a
		// recognized diagnostic became a field rather than tail text, and not that the tail is empty.
		assert.equal(exit.stderr.tail.includes(DIAGNOSTIC_EVENT), false);
		assert.deepEqual(exit.counters, ZERO_COUNTERS);
		assert.equal(await child.exited, exit, "the exit is decided once, and every reader of it gets that one record");

		// The fixture's own log, under this case's root and nowhere else: what the child was actually asked before it
		// was handed over, which is one state request and nothing else.
		const logged = fs
			.readFileSync(fixture.owned.logPath, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as { read?: string });
		const asked = logged.filter((entry) => typeof entry.read === "string").map((entry) => (JSON.parse(entry.read as string) as { type: string }).type);
		assert.deepEqual(asked, ["get_state"]);
	});
});

test("a prompt acknowledged and settled inside one chunk is one turn, and neither is read in a continuation", async () => {
	await withFake("ok", async (fixture) => {
		const events: string[] = [];
		const child = await fixture.start({ onEvent: (event) => events.push(event.type) });
		const turn = await child.turn("do the thing");
		assert.equal(turn.outcome, "settled");
		assert.equal(turn.ack?.success, true);
		assert.equal(turn.ack?.command, "prompt");
		assert.deepEqual([turn.earlySettles, turn.extensionErrors, turn.events], [0, 0, 2]);
		assert.equal(turn.failure, undefined);
		assert.deepEqual(events, ["agent_start", "agent_settled"], "forwarded synchronously and in the child's own order");
		assert.deepEqual(child.counters, ZERO_COUNTERS, "a settle that landed after its acknowledgement is neither stray nor early");

		const second = await child.turn("and again");
		assert.equal(second.outcome, "settled");
		assert.equal(second.ack?.id, "pi-fusion-3", "the second turn is its own request on the same child");
		assert.deepEqual(events, ["agent_start", "agent_settled", "agent_start", "agent_settled"]);
	});
});

test("a turn that runs is the only one, and a steer is admitted only while one is", async () => {
	await withFake("ack-never", async (fixture) => {
		const child = await fixture.start();
		const running = child.turn("the one that never comes back");
		const busy = await refusal(child.turn("a second one"));
		assert.equal(busy.kind, "busy");

		// A turn is admitted the moment its prompt reaches stdin, which is what makes a steer meaningful at all.
		const steered = await child.request({ type: "steer", message: "this way instead" });
		assert.deepEqual([steered.command, steered.success], ["steer", true]);

		const exit = await child.shutdown("aborted");
		const turn = await running;
		assert.equal(turn.outcome, "aborted", "the outcome is fixed when the shutdown starts, not by whatever lands later");
		assert.equal(turn.failure?.kind, "aborted");
		assert.equal(exit.failure?.kind, "aborted");
		assert.equal(exit.stoppedByUs, true);

		const afterwards = await refusal(child.request({ type: "steer", message: "too late" }));
		assert.equal(afterwards.kind, "closed");
	});
});

test("a prompt the child refuses is a rejected turn, and what it refused with is the child's own answer", async () => {
	await withFake("ack-fails", async (fixture) => {
		const child = await fixture.start();
		const turn = await child.turn("something it will not take");
		assert.equal(turn.outcome, "rejected");
		assert.equal(turn.ack?.success, false);
		assert.equal(turn.ack?.error, "Cannot prompt while agent is streaming");
		assert.equal(turn.failure, undefined, "the command failed; the transport did not");
		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined);
	});
});

test("a prompt that is never acknowledged ends the child inside its own bound, and says which bound", async () => {
	await withFake("ack-never", async (fixture) => {
		const child = await fixture.start({ bounds: { ackMs: 400 } });
		const turn = await child.turn("the one it never answers");
		assert.equal(turn.outcome, "failed");
		assert.equal(turn.failure?.kind, "timeout");
		const exit = await child.exited;
		assert.equal(exit.failure?.kind, "timeout", "an acknowledgement that never came is what ended this child");
		assert.equal(exit.stoppedByUs, true);
		assert.equal(exit.counters.streamsUnclosed, 0);
	});
});

/**
 * How long this one case lets its child's shutdown step run. It is deliberately far past everything else the case is
 * configured with, so a shutdown that spends it is a shutdown that waited, and the deadline the call below is under —
 * which is above the whole cleanup budget and well under this — is what says so. Nothing here measures anything: one
 * bound is a failure deadline, the other is a wait this case asserts is never entered.
 */
const UNREACHABLE_STOP_WAIT_MS = 120_000;

test("an abort this side could not admit is not waited for, and none of that shutdown reached the child", async () => {
	await withFake("ack-never", async (fixture) => {
		// One pending slot, taken by the prompt: the shutdown's own `clear_queue` and `abort` are refused by this side's
		// admission before either is composed, and a refusal of this side's own is not the child answering anything.
		const child = await fixture.start({ bounds: { maxPendingRequests: 1, shutdownStepMs: UNREACHABLE_STOP_WAIT_MS } });
		const running = child.turn("the one that never comes back");
		// Observed the moment it exists, and then read for whether it has settled — a microtask against an already
		// resolved value, which is not a wait and measures nothing.
		const ending = running.then((turn) => ({ turn }), (error: unknown) => ({ error }));
		const busy = await refusal(child.turn("a second one"));
		assert.equal(busy.kind, "busy", "there is a turn in flight, which is what makes the shutdown take the branch that would have waited");
		assert.equal(await Promise.race([ending, Promise.resolve("pending" as const)]), "pending", "and it has not settled when the shutdown starts");

		const exit = await within("the shutdown of a child whose abort this side never admitted", child.shutdown("aborted"));
		assert.equal(exit.failure?.kind, "aborted", "the cause the shutdown started with is what it reports");
		assert.equal(exit.stoppedByUs, true);
		assert.equal(exit.cleanup.root, "exited", "and the tree's own cleanup is what ended the child, which is what a control nobody could send leaves");

		const turn = await running;
		assert.equal(turn.outcome, "aborted", "the outcome is the one the shutdown fixed");
		assert.equal(turn.failure?.kind, "aborted");

		// The fixture's own log, under this case's root: what the child was actually asked. A control that was refused
		// here was refused before anything of it was framed, so there is nothing of either one on the wire.
		const asked = commandsRead(fixture.owned).map((command) => command.type);
		assert.deepEqual(asked, ["get_state", "prompt"], "the state probe and the prompt, and nothing behind them");
		assert.equal(asked.includes("abort"), false);
		assert.equal(asked.includes("clear_queue"), false);
	});
});

test("a caller that knows its prompt runs no agent loop finishes at the acknowledgement", async () => {
	await withFake("command-ack", async (fixture) => {
		const child = await fixture.start();
		const turn = await child.turn("/a command that answers itself", { completion: "acknowledged" });
		assert.equal(turn.outcome, "acknowledged");
		assert.equal(turn.ack?.success, true);
		assert.deepEqual([turn.events, turn.earlySettles], [0, 0], "nothing settled, and nothing was waited for");
		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined);
	});
});

/*
 * The one case here that a session restore depends on, and the whole of what it shows: that an `extension_error`
 * written before a prompt's acknowledgement is reported on that turn rather than on nothing. It is about the ordering
 * of two records and an acknowledged completion; it restores no session, sends no real control command and is not
 * evidence that Pi's own commands fail this way. The fixture writes both records in one write, which arranges their
 * order and claims nothing about how the pipe delivers them.
 */
test("an extension error written before the acknowledgement belongs to the acknowledged turn", async () => {
	await withFake("command-ack-extension-error", async (fixture) => {
		const child = await fixture.start();
		const turn = await child.turn(`/${NAVIGATE_COMMAND} ${JSON.stringify("entry-1")}`, { completion: "acknowledged" });
		assert.equal(turn.outcome, "acknowledged");
		assert.equal(turn.ack?.success, true);
		assert.equal(turn.extensionErrors, 1, "the error belongs to this turn, and a host reads it there");
		// The fixture holds these as literals and imports nothing: comparing them against the control extension's own
		// exports is what makes a drift between the two a failure rather than a case that quietly stops matching.
		assert.equal(turn.lastExtensionError?.error, CONTROL_CANCELLED);
		assert.equal(turn.lastExtensionError?.extensionPath, `command:${NAVIGATE_COMMAND}`);
		assert.equal(turn.lastExtensionError?.event, "command");
		assert.deepEqual(turn.lastExtensionError?.cut, { error: false, extensionPath: false, event: false }, "nothing of it was cut, so each field is the whole of what arrived");
		assert.deepEqual([turn.events, turn.earlySettles], [1, 0], "the extension error is the one record this turn saw, and nothing settled");
		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined);
	});
});

test("an ordinary request that runs out of time ends that call and leaves the child running", async () => {
	await withFake("request-never", async (fixture) => {
		const child = await fixture.start();
		const first = await refusal(child.request(ASK_STATS, 300));
		assert.equal(first.kind, "timeout");
		// Still up and still correlating: the second call reaches its own bound rather than a closed transport.
		const second = await refusal(child.request({ type: "get_last_assistant_text" }, 300));
		assert.equal(second.kind, "timeout");
		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined, "a request that timed out is not a reason to call the child failed");
		assert.equal(exit.cleanup.root, "exited");
	});
});

test("a reply that arrives after its call gave up is counted and settles nothing", async () => {
	await withFake("late-reply", async (fixture) => {
		const child = await fixture.start();
		const timedOut = await refusal(child.request(ASK_STATS, 300));
		assert.equal(timedOut.kind, "timeout");
		// Released by the next command rather than by a clock: the held reply is written in front of this one's.
		const answered = await child.request({ type: "get_last_assistant_text" });
		assert.deepEqual([answered.command, answered.id], ["get_last_assistant_text", "pi-fusion-3"]);
		assert.equal(child.counters.lateResponses, 1);
		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined);
		assert.equal(exit.counters.lateResponses, 1);
	});
});

test("a response this transport cannot place is a protocol failure, and it carries none of what it refused", async () => {
	for (const [scenario, reason] of [
		["mismatched-command", "a response from it answers a command other than the one its id was issued for"],
		["unknown-id", "a response from it carries an id this transport never issued"],
		["no-id", "a response repeats the id of the command it answers"],
		["bad-frame", "a record from it is not json"],
	] as const) {
		await withFake(scenario, async (fixture) => {
			const child = await fixture.start();
			const refused = await refusal(child.request(ASK_STATS));
			assert.equal(refused.kind, "protocol", scenario);
			const exit = await child.exited;
			assert.equal(exit.failure?.kind, "protocol", scenario);
			assert.equal(exit.failure?.message, `the pi child sent something this transport cannot read: ${reason}`, scenario);
			assert.equal(exit.failure?.message.includes("Unexpected token"), false, "nothing the child wrote reaches the message");
			assert.equal(exit.failure?.message.includes("this line is not json"), false);
			assert.equal(exit.stoppedByUs, true, "a child that spoke something unreadable is stopped by this host");
		});
	}
});

/** The three whole event records the batch fixture writes behind the one no host can read, in its own order. */
const BEHIND_THE_BAD_FRAME = ["agent_start", "auto_retry_start", "compaction_start"];

test("whole records framed behind one this transport refused are counted as read and delivered nowhere", async () => {
	await withFake("batch-behind-bad-frame", async (fixture) => {
		const events: string[] = [];
		const child = await fixture.start({ onEvent: (event) => events.push(event.type) });
		const refused = await refusal(child.request(ASK_STATS));
		assert.equal(refused.kind, "protocol", "the record that stopped the read is what ends the child, however much was behind it");
		const exit = await child.exited;
		assert.equal(exit.failure?.kind, "protocol");
		assert.equal(exit.failure?.message, "the pi child sent something this transport cannot read: a record from it is not json");
		assert.equal(exit.stoppedByUs, true);

		/*
		 * What this may claim, and what it may not.
		 *
		 * The fixture writes the refused line and the three records behind it in one `writeSync`. That arranges the
		 * content and the order and nothing else: a pipe may hand one write over as one chunk or as several, a partial
		 * write needs no boundary kept, and nothing here observed a chunk. So what is asserted is the accounting rather
		 * than the chunking — each of the three is accounted for exactly once, either counted as read and delivered
		 * nowhere or delivered to this listener, and the line that stopped the batch is not among them. That the whole
		 * batch arriving at once makes the count three and the deliveries none is this transport's own source reasoning
		 * and this case's reason for existing; it is not something this run measured.
		 */
		assert.equal(events.length + exit.counters.droppedFrames, BEHIND_THE_BAD_FRAME.length, "every record behind the refused one is accounted for once: counted undelivered, or delivered here");
		assert.deepEqual(events, BEHIND_THE_BAD_FRAME.slice(BEHIND_THE_BAD_FRAME.length - events.length), "and whatever was delivered is a tail of what the fixture wrote, in its own order");
		if (events.length === 0) assert.equal(exit.counters.droppedFrames, BEHIND_THE_BAD_FRAME.length, "with nothing delivered, the count is the three of them and never the refused line too");
	});
});

test("a record whose last character never arrived is not the json in front of it, and none of it reaches the refusal", async () => {
	await withFake("torn-record", async (fixture) => {
		const child = await fixture.start();
		// The answer is correlated and would have parsed without its last byte, which is exactly what must not be
		// accepted: a record the decoder could not finish is not the record the json prefix of it looks like.
		const refused = await refusal(child.request(ASK_STATS));
		assert.equal(refused.kind, "protocol");
		const exit = await child.exited;
		assert.equal(exit.failure?.kind, "protocol");
		assert.equal(exit.failure?.message, "the pi child sent something this transport cannot read: a record from it is not json");
		assert.equal(exit.failure?.message.includes(REPLACEMENT), false, "what the decoder put where the character was is not in the message");
		assert.equal(exit.failure?.message.includes("get_session_stats"), false, "and neither is anything else the child wrote");
		assert.equal(exit.stoppedByUs, true);
	});
});

test("a child that exits in the middle of a turn is a failure whatever its exit code was", async () => {
	await withFake("exit-mid-turn", async (fixture) => {
		const child = await fixture.start();
		const turn = await child.turn("the one it walks out of");
		assert.equal(turn.outcome, "exited");
		assert.equal(turn.ack?.success, true, "it acknowledged the prompt and then went");
		assert.equal(turn.failure?.kind, "exited");
		const exit = await child.exited;
		assert.deepEqual([exit.exit.code, exit.exit.signal], [0, null]);
		assert.equal(exit.failure?.kind, "exited", "nobody asked it to stop, so a clean code is still a failure");
		assert.equal(exit.failure?.message, "the pi child exited before its work was done (exit code 0)");
		assert.equal(exit.stoppedByUs, false);
		assert.equal(exit.cleanup.root, "exited");
	});
});

test("a child that never became ready is refused with its own diagnostic, and the whole record travels with it", async () => {
	await withFake("startup-fail", async (fixture) => {
		const refused = await refusal(fixture.start());
		assert.equal(refused.kind, "startup");
		assert.equal(refused.stage, "models");
		assert.equal(refused.message, "the pi child did not become ready at the models stage (exit code 78): a model or credential configuration could not be used");
		const exit = refused.finalExit;
		assert.ok(exit, "the child is over by the time this is thrown, so its record is on the refusal or it is lost");
		assert.deepEqual([exit.stderr.lastStage, exit.stderr.serving, exit.stderr.sdk], ["models", false, "0.85.1"]);
		assert.deepEqual([exit.exit.code, exit.cleanup.root, exit.counters.streamsUnclosed], [78, "exited", 0]);
	});
});

test("a child that left nothing readable is refused for what it did, with none of what it wrote", async () => {
	await withFake("startup-fail-unreadable", async (fixture) => {
		// Wide enough that node's own warnings on this stderr arrive whole and only the fake's two lines are cut, so
		// the count below is about what this child wrote rather than about what else happened to be on the pipe.
		const refused = await refusal(fixture.start({ bounds: { maxStderrLineBytes: 200 } }));
		assert.equal(refused.kind, "startup");
		assert.equal(refused.stage, undefined, "a stage guessed from text that was discarded would be an invention");
		assert.match(refused.message, /^the pi child did not become ready \(exit code 78\): it refused the call before it could serve, and left no diagnostic this host could read \(\d+ stderr lines, 2 of them cut\)$/);
		assert.equal(refused.message.includes("noise"), false);
		assert.equal(refused.finalExit?.stderr.tail.includes("noise"), false, "a cut line is not tail text either");
	});
});

test("a child that exits before it serves never became ready, whatever its code was", async () => {
	await withFake("exit-before-serving", async (fixture) => {
		const refused = await refusal(fixture.start());
		assert.equal(refused.kind, "startup");
		assert.equal(refused.message, "the pi child did not become ready (exit code 0)");
		assert.deepEqual([refused.finalExit?.stderr.serving, refused.finalExit?.stderr.lastStage], [false, "sdk"]);
		assert.equal(refused.finalExit?.stoppedByUs, false);
	});
});

test("a child that reaches its serving stage and then answers nothing is bounded by the startup deadline", async () => {
	await withFake("probe-never", async (fixture) => {
		const refused = await refusal(fixture.start({ bounds: { startupMs: 600 } }));
		assert.equal(refused.kind, "startup");
		const exit = refused.finalExit;
		assert.ok(exit);
		assert.equal(exit.stderr.serving, true, "it said it was serving, which is a stage and not an answer");
		assert.equal(exit.stoppedByUs, true);
		assert.notEqual(exit.cleanup.root, "unstoppable");
	});
});

/*
 * The two below are about one moment: the probe's own answer and the record behind it arriving together, which is what
 * a child writing two records into one write arranges. The answer to the probe resolves first and the read of what
 * follows it fails the transport or aborts the run before the startup can go on, so the question each asks is whether
 * a startup that already began ending can still publish readiness. The chunking is what these fixtures write in one
 * `writeSync`; nothing here observed a chunk, and nothing ran.
 */

test("a record that fails this transport behind the probe's own answer is the startup's failure, and no child is handed over", async () => {
	await withFake("probe-then-bad-frame", async (fixture) => {
		const refused = await refusal(fixture.start());
		assert.equal(refused.kind, "protocol", "the answer had resolved, and what came behind it in the same write still decided the startup");
		assert.equal(refused.message, "the pi child sent something this transport cannot read: a record from it is not json");
		const exit = refused.finalExit;
		assert.ok(exit, "a startup that handed no child over carries the whole record of the one it finished");
		assert.equal(exit.failure?.kind, "protocol", "and the cause the finalization recorded is not replaced by a startup laid over it");
		assert.equal(exit.failure?.message, "the pi child sent something this transport cannot read: a record from it is not json");
		assert.equal(exit.failure?.message.includes("this line is not json"), false, "nothing the child wrote reaches the message");
		assert.equal(exit.stoppedByUs, true, "a child that spoke something unreadable is stopped by this host");
		assert.equal(exit.stderr.serving, true, "it had reached its serving stage, which is what let the probe be written at all");
	});
});

test("an event behind the probe's own answer that aborts the run ends the startup, and no child is handed over", async () => {
	await withFake("probe-then-event", async (fixture) => {
		const controller = new AbortController();
		const events: string[] = [];
		const refused = await refusal(
			fixture.start({
				signal: controller.signal,
				onEvent: (event) => {
					events.push(event.type);
					controller.abort();
				},
			}),
		);
		// Non-vacuous on purpose: without the event actually reaching this listener there is no abort, and the case would
		// be about nothing. What it was is asserted too, so a different record could not stand in for it.
		assert.deepEqual(events, ["agent_start"], "the event was delivered to the caller's own listener, which is what aborted the run");
		assert.equal(refused.kind, "aborted", "an abort while the probe's answer had already resolved is what this startup failed with");
		assert.equal(refused.message, "the run was cancelled");
		const exit = refused.finalExit;
		assert.ok(exit);
		assert.equal(exit.failure?.kind, "aborted", "and it is the abort's own failure rather than a startup laid over it");
		assert.equal(exit.stoppedByUs, true);
		assert.equal(exit.stderr.serving, true);
	});
});

test("a dialog opened before anything could take it is cancelled rather than dispatched, and the startup is still bounded", async () => {
	await withFake("ui-at-startup", async (fixture) => {
		const seen: PiUiRequest[] = [];
		const refused = await refusal(
			fixture.start({
				bounds: { startupMs: 900 },
				onUiRequest: (request) => {
					seen.push(request);
					return true;
				},
			}),
		);
		assert.equal(refused.kind, "startup");
		assert.deepEqual(seen, [], "there is no caller holding this child yet, so nothing of it is dispatched");
		// The cancellation is written; whether it ever unblocks that extension is the child's own ordering and is not
		// claimed here. What is claimed is that the startup stayed bounded and the child was stopped.
		assert.equal(refused.finalExit?.counters.uiCancelledByTransport, 1);
		assert.equal(refused.finalExit?.counters.droppedFrames, 0);
		assert.equal(refused.finalExit?.stoppedByUs, true);
	});
});

test("a signal that fired before the call spawns nothing at all", async () => {
	await withFake("ok", async (fixture) => {
		const refused = await refusal(fixture.start({ signal: AbortSignal.abort() }));
		assert.equal(refused.kind, "aborted");
		assert.equal(refused.message, "the run was cancelled");
		const exit = refused.finalExit;
		assert.ok(exit);
		assert.equal(exit.cleanup.root, "unspawned");
		assert.deepEqual([exit.exit.code, exit.exit.signal], [null, null]);
		assert.deepEqual([exit.stderr.lines, exit.stderr.serving], [0, false], "nothing was started, so nothing wrote anything");
		assert.deepEqual(exit.counters, ZERO_COUNTERS);
	});
});

test("a command this transport keeps for itself is refused before anything is queued, and the child is untouched", async () => {
	await withFake("ok", async (fixture) => {
		const child = await fixture.start();
		const reserved: Array<{ type: string; [key: string]: unknown }> = [
			{ type: "prompt", message: "x" },
			{ type: "abort" },
			{ type: "clear_queue" },
			{ type: "extension_ui_response", id: "x", cancelled: true },
			{ type: "steer", message: "x" },
			{ type: "follow_up", message: "x" },
		];
		for (const command of reserved) {
			const refused = await refusal(child.request(command));
			assert.equal(refused.kind, "refused", command.type);
		}
		const own = await refusal(child.request({ type: "get_state", id: "mine-1" }));
		assert.equal(own.kind, "refused", "a caller's own id would answer somebody else's request");
		// Nothing of any of that reached the child: the next ordinary call is the first thing it was asked.
		const answered = await child.request(ASK_STATS);
		assert.deepEqual([answered.id, answered.command, answered.success], ["pi-fusion-2", "get_session_stats", true]);
		assert.deepEqual(child.counters, ZERO_COUNTERS);
	});
});

test("after a shutdown every call is refused, and the record of it does not change", async () => {
	await withFake("ok", async (fixture) => {
		const child = await fixture.start();
		const exit = await child.shutdown();
		assert.equal(await child.shutdown(), exit, "a second shutdown is the same shutdown");
		assert.equal((await refusal(child.request(ASK_STATS))).kind, "closed");
		assert.equal((await refusal(child.turn("too late"))).kind, "closed");
		assert.equal(child.respond("a-dialog-nobody-opened", { cancelled: true }), "unknown");
		assert.deepEqual(child.counters, exit.counters);
	});
});

test("a dialog answer this transport would not send at all is the caller's own error", async () => {
	await withFake("ok", async (fixture) => {
		const child = await fixture.start();
		for (const answer of [{}, { value: 7 }, { confirmed: "yes" }, { cancelled: false }, { value: "a", confirmed: true }]) {
			assert.throws(() => child.respond("some-dialog", answer as never), TypeError, JSON.stringify(answer));
		}
		// The shape is read before the id is, because a caller that composed nonsense made a mistake either way.
		assert.equal(child.respond("some-dialog", { cancelled: true }), "unknown");
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * One dialog answer against a writer that has no room for it. The room is taken by ordinary requests of this case's
 * own, against a fake that has stopped reading its stdin, so what refuses the answer is the writer's real byte cap and
 * not a record composed to be too large for anything.
 * ---------------------------------------------------------------------------------------------------------------- */

/** The bounds this case runs with: a byte cap two padded frames fill, and item and pending caps far out of the way. */
const UI_ADMISSION_BOUNDS: Partial<PiBounds> = { maxPendingRequests: 1_024, maxOutboundFrameBytes: 4_096 };
const UI_ADMISSION_CAPS = writerCaps(piBounds(UI_ADMISSION_BOUNDS));

/** How many padded requests one synchronous burst issues. Fixed, and far more than that queue could ever hold. */
const BURST_REQUESTS = 300;

/** A failure bound on one burst call, not a wait: every admitted one is answered as soon as the fake is released. */
const BURST_REQUEST_MS = 20_000;

/** What one padded frame is sized to, which is under the frame cap and over half the queue's whole byte cap. */
const PADDED_FRAME_BYTES = 4_090;

/** The two names the paused fixture owns, repeated here because a case has to write one and read the other back. */
const PAUSED_DIALOG_ID = "fake-dialog-backpressure";
const RELEASE_MARKER = "release-the-fake";

/**
 * The fixture's own command, and deliberately not one of the native union: it asks the fake to install its release
 * watcher, stop reading its stdin and open a dialog, and it is answered only once all three are done.
 */
const PAUSE_COMMAND: { type: string; [key: string]: unknown } = { type: "fake_pause" };

/** One outbound frame's size, encoded the way the transport encodes one: the record's json, and the LF after it. */
const encodedFrame = (record: Record<string, unknown>): number => Buffer.byteLength(`${JSON.stringify(record)}\n`);

/**
 * The padded request this burst issues, sized against the longest id this case can reach — the probe's, the pause
 * command's and then one per burst call — so every frame of it is at most `PADDED_FRAME_BYTES` and none is refused for
 * its own size. The padding is a field the fake reads nothing out of.
 */
const BURST_TYPE = "get_last_assistant_text";
const FIRST_BURST_ID = `${PI_REQUEST_PREFIX}3`;
const LAST_BURST_ID = `${PI_REQUEST_PREFIX}${BURST_REQUESTS + 2}`;
const BURST_COMMAND: { type: string; [key: string]: unknown } = { type: BURST_TYPE, pad: "p".repeat(PADDED_FRAME_BYTES - encodedFrame({ id: LAST_BURST_ID, type: BURST_TYPE, pad: "" })) };
const SMALLEST_BURST_FRAME = encodedFrame({ id: FIRST_BURST_ID, ...BURST_COMMAND });
const LARGEST_BURST_FRAME = encodedFrame({ id: LAST_BURST_ID, ...BURST_COMMAND });
const UI_ANSWER_FRAME = encodedFrame({ type: "extension_ui_response", id: PAUSED_DIALOG_ID, confirmed: true });

/** What the two steps are called in a failure a reader has to make sense of. Fixed text, and this file's own. */
const PAUSED_BODY = "the part of this case that runs while its fixture may be paused";
const PAUSED_RELEASE = "the release of the marker that fixture is waiting on";

/**
 * Everything that runs from the moment this case may have asked its fixture to pause, and the release of that pause
 * afterwards — attempted whatever the body did, and never in place of what the body had to say.
 *
 * Both failures are kept, through the same `Thrown` records and the same `caseFailure` every other case leaves by: one
 * of them is rethrown exactly as it was thrown, falsy values included, and two become one `AggregateError` that names
 * this case's root and keeps both originals in the order they happened. So a release that threw never replaces the
 * assertion that failed before it, and an assertion that failed never hides a release that did not go through.
 *
 * What it does not claim. The release is attempted, and that is all: a marker this could not write may leave the fake
 * paused until its own bounded keepalive, and what becomes of the child after that is the case's owned memoized
 * shutdown and the positive disposal gate's to report, not this function's. Nothing here signals anything, waits for
 * anything, polls, retries or holds a clock.
 */
async function withRelease(root: string, body: () => Promise<void>, release: () => void): Promise<void> {
	const problems: Thrown[] = [];
	try {
		await body();
	} catch (error) {
		problems.push({ what: PAUSED_BODY, error });
	}
	// Unconditional, and after the body whatever the body did: this is the one thing the fixture on the other side is
	// waiting on, and a case that failed an assertion is exactly the case that would otherwise leave it waiting.
	try {
		release();
	} catch (error) {
		problems.push({ what: PAUSED_RELEASE, error });
	}
	const ending = caseFailure(problems, root);
	if (ending.throws) throw ending.error;
}

/** What one call threw, kept as it was thrown: a falsy value is a value, and a truthiness test would lose it. */
async function thrownBy(work: Promise<void>): Promise<{ error: unknown }> {
	const outcome = await work.then(() => ({ threw: false as const }), (error: unknown) => ({ threw: true as const, error }));
	if (!outcome.threw) return assert.fail("this call should have thrown, and it returned instead");
	return { error: outcome.error };
}

test("a paused case releases its fixture whatever its body did, and neither failure is lost to the other", async () => {
	// Nothing here writes a file, starts a process or touches a case's own root: the release is a closure that counts
	// its calls, and the root is a path this test made up for the message it ends up in.
	const root = "/tmp/pi-fusion-transport-paused";
	const done = async (): Promise<void> => {};
	let releases = 0;
	const release = (): void => {
		releases += 1;
	};

	await withRelease(root, done, release);
	assert.equal(releases, 1, "a body that returned is still followed by the release");

	const bodyFailure = new Error("an assertion of the body's own");
	const failingBody = async (): Promise<void> => {
		throw bodyFailure;
	};
	assert.equal((await thrownBy(withRelease(root, failingBody, release))).error, bodyFailure, "the body's failure comes back out unwrapped");
	assert.equal(releases, 2, "and the release was attempted all the same, which is what the fixture is waiting on");

	const releaseFailure = new Error("the marker could not be written");
	const failingRelease = (): void => {
		throw releaseFailure;
	};
	assert.equal((await thrownBy(withRelease(root, done, failingRelease))).error, releaseFailure, "a release that threw with nothing else wrong is that case's own failure");

	const both = (await thrownBy(withRelease(root, failingBody, failingRelease))).error;
	if (!(both instanceof AggregateError)) return assert.fail("a body failure and a release that threw are one error carrying both");
	assert.equal(both.errors.length, 2);
	assert.equal(both.errors[0], bodyFailure, "the body's own value first, by identity and not by anything that looks like it");
	assert.equal(both.errors[1], releaseFailure, "and the release's second, in the order the two happened");
	assert.match(both.message, /pi-fusion-transport-paused/, "the root a reader needs is in what they see first");
	assert.ok(both.message.includes(PAUSED_BODY) && both.message.includes(PAUSED_RELEASE), "and so is which of the two each one was");

	// Falsy values are values: neither may be replaced by the other's, and neither may be dropped for being falsy.
	const falsyBody = async (): Promise<void> => {
		throw undefined;
	};
	const falsyRelease = (): void => {
		throw "";
	};
	const falsy = (await thrownBy(withRelease(root, falsyBody, falsyRelease))).error;
	if (!(falsy instanceof AggregateError)) return assert.fail("two falsy failures are still two failures");
	assert.deepEqual(falsy.errors, [undefined, ""], "both of them, in order, neither lost and neither standing in for the other");
	assert.deepEqual(await thrownBy(withRelease(root, falsyBody, release)), { error: undefined }, "one falsy failure comes back out as itself rather than as a resolved call");
	assert.equal(releases, 3, "each of the three cases this counting release was given attempted it exactly once");
});

test("an answer the writer has no room for is refused and spends nothing, and that dialog is still there to cancel", async () => {
	await withFake("ui-backpressure", async (fixture) => {
		// The arithmetic this case rests on, pinned against the real encoding before anything is started: two of the
		// smallest padded frames fit and leave less room than the answer takes, three never fit at all, and the answer
		// itself is far inside the frame cap — so a refusal of it is the queue's own byte cap and can be nothing else.
		assert.ok(LARGEST_BURST_FRAME <= (UI_ADMISSION_BOUNDS.maxOutboundFrameBytes ?? 0), "a padded frame is inside the outbound cap, so it is never refused for its size");
		assert.ok(2 * LARGEST_BURST_FRAME <= UI_ADMISSION_CAPS.bytes, "two of them fit in the queue at once");
		assert.ok(3 * SMALLEST_BURST_FRAME > UI_ADMISSION_CAPS.bytes, "and three of them never do");
		assert.ok(UI_ADMISSION_CAPS.bytes - 2 * SMALLEST_BURST_FRAME < UI_ANSWER_FRAME, "what two of them leave is less than the answer takes");
		assert.ok(4 * UI_ANSWER_FRAME < (UI_ADMISSION_BOUNDS.maxOutboundFrameBytes ?? 0), "and the answer is comfortably inside the frame cap, so its own size refuses nothing");

		let dialog: PiUiRequest | undefined;
		let announce!: () => void;
		const delivered = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const child = await fixture.start({
			bounds: UI_ADMISSION_BOUNDS,
			onUiRequest: (request) => {
				dialog = request;
				announce();
				return true;
			},
		});
		// Derived before anything can pause: a path this case owns, and one `path.join` of two strings it already has.
		const marker = path.join(path.dirname(fixture.owned.logPath), RELEASE_MARKER);
		const outcomes: Array<Promise<{ admitted: true } | { admitted: false; error: unknown }>> = [];
		// Everything from the command that may pause the fixture onwards, with the release attempted whatever any of it
		// did. The pause command's own answer is inside this region rather than in front of it: once it has been sent,
		// the fake may already be paused, and an assertion about that very answer must not be what leaves it paused.
		// Both failures leave together, through this file's own conventions, before anything below is asserted.
		await withRelease(
			fixture.owned.root,
			async () => {
				const paused = await child.request(PAUSE_COMMAND);
				assert.equal(paused.success, true, "the fake had installed its own release watcher and stopped reading before it answered this");

				// The dialog as it was actually delivered, rather than as something this case assumed had arrived.
				await within("the dialog the paused fixture opens", delivered);
				assert.deepEqual([dialog?.id, dialog?.method, dialog?.expectsResponse], [PAUSED_DIALOG_ID, "confirm", true]);

				// One synchronous burst, with nothing awaited inside it or after it until the answer below: a drain can
				// only run between turns of the loop this case does not give it, so what the queue holds when the answer
				// is composed is what this burst put there.
				for (let n = 0; n < BURST_REQUESTS; n += 1) {
					try {
						// Observed as each one is made, which is what makes an early failure here safe: a refusal arrives
						// as a rejection, and any of these still unobserved when something threw would be an unhandled one.
						outcomes.push(child.request(BURST_COMMAND, BURST_REQUEST_MS).then(() => ({ admitted: true as const }), (error: unknown) => ({ admitted: false as const, error })));
					} catch (error) {
						// `request` answers a refusal with a rejection rather than a throw, and nothing here rests on that.
						outcomes.push(Promise.resolve({ admitted: false as const, error }));
					}
				}

				assert.throws(
					() => child.respond(PAUSED_DIALOG_ID, { confirmed: true }),
					(error: unknown) => error instanceof PiTransportError && error.kind === "refused" && error.message === "this transport would not send this call",
					"an answer there is no room to queue is refused to its caller, rather than answered as though the transport were closed",
				);
			},
			// The release itself: that one file appearing, which is the event the fake's own watcher is waiting for.
			() => fs.writeFileSync(marker, ""),
		);

		const settled = await Promise.all(outcomes);
		const turnedAway = settled.flatMap((one) => (one.admitted ? [] : [one.error]));
		const admitted = settled.length - turnedAway.length;
		assert.equal(settled.length, BURST_REQUESTS, "every call of the burst was observed");
		assert.ok(admitted > 0, "some of the burst was admitted, or the queue this case is about was never reached");
		assert.ok(turnedAway.length > 0, `some of it was refused: ${admitted} of ${BURST_REQUESTS} were admitted`);
		for (const error of turnedAway) {
			if (!(error instanceof PiTransportError)) return assert.fail("a call the queue had no room for is refused with this transport's own failure");
			// The one refusal this burst accepts: not a frame past the cap, not a closed transport, not a call that ran
			// out of time. Any of those would mean the answer above was refused for a reason this case is not about.
			assert.equal(error.kind, "refused");
		}

		// Nothing of the refused answer was spent, so this is the first thing that goes out under that id — and the
		// second call finds an id that is answered, which is the rule the rollback must not have weakened.
		assert.equal(child.respond(PAUSED_DIALOG_ID, { cancelled: true }), "sent");
		assert.equal(child.respond(PAUSED_DIALOG_ID, { confirmed: true }), "duplicate");

		// The barrier: stdin is one stream read in order, so an answer to this call is the fake saying it has read
		// everything written before it, the cancellation included.
		const barrier = await child.request(ASK_STATS, BURST_REQUEST_MS);
		assert.equal(barrier.success, true);
		const answers = commandsRead(fixture.owned).filter((command) => command.type === "extension_ui_response");
		assert.equal(answers.length, 1, "one dialog, one answer on the wire");
		assert.deepEqual(answers[0], { type: "extension_ui_response", id: PAUSED_DIALOG_ID, cancelled: true }, "and it is the cancellation, never the answer there had been no room for");

		const exit = await child.shutdown();
		assert.equal(exit.failure, undefined);
		assert.equal(exit.counters.uiCancelledByTransport, 0, "this caller answered its own dialog, so the transport never had to");
		assert.equal(exit.counters.droppedFrames, 0, "and an answer that was never admitted is not a frame that was dropped");
	});
});

/* ------------------------------------------------------------------------------------------------------------------
 * The one conditional fault: a cleanup that throws where it has nothing left to report with, and what a fixture may
 * claim about the process afterwards. It is kept apart from `withFake` deliberately — there is no report for that
 * gate to read, and no report may be invented to get past its missing-report rule.
 * ---------------------------------------------------------------------------------------------------------------- */

/** The malformed answer, named and truthy, so what the cleanup sees is a bad table and not an unavailable read. */
const NOT_A_TABLE = { malformed: "this is not a process table" } as unknown as ObservedProcess[];

/**
 * The ceiling one of this watch's own reads runs under: this file's own fixed value, read from the cleanup constants
 * above and never from what a case handed in. A case that overrode its `tableTimeoutMs` does not raise this, so the
 * two can differ and no equality with a per-case override is claimed. What a read actually gets is still bounded the
 * way production bounds the same one: the lesser of this ceiling and whatever the caller said was left of its budget,
 * with this ceiling alone when a caller named none.
 */
const WATCH_TABLE_MS = TEST_CLEANUP.tableTimeoutMs ?? 3_000;

/** The one refusal every send this fixture is asked for gets. One fixed string, so a message is never composed. */
const WATCH_NO_SIGNAL = "this fixture signals nothing: it has no authority over any process";

/**
 * The root one case watches, read through the production table reader and nothing else.
 *
 * Every read is the real platform read the cleanup would have made anyway, bounded the way production's own facilities
 * bound it: this watch's ceiling, or whatever the caller says is left of its deadline, whichever is shorter. The first of
 * those reads is also the availability check — nothing probes a process at module load, or outside a read the tree itself
 * asked for, and there is no sampler, poll or wait anywhere here.
 *
 * What a read is not is signal-free in the code it runs: `readProcessTable` runs a platform helper of its own and may
 * terminate that helper, through the handle it owns, when a read runs out of time. This fixture's own non-signalling is
 * narrower and exact — the `signal` below refuses every target it is ever asked for — and it is no claim about what any
 * other actor does.
 *
 * What it captures is an identity, and only from a live real row for the pid it was told to follow: the pid, a non-empty
 * birth stamp that fingerprints it and a positive process group, none of them dead. Without all of that there is nothing
 * to capture, because a pid on its own is a number rather than a process. The read that captures returns the real rows
 * unconditionally: what it saw was the process alive, so there is nothing for it to be evidence of.
 *
 * The one thing this adds is a malformed answer, returned at most once and only on a *later* real read that shows the
 * captured identity absent, replaced or dead. That is what makes the cleanup throw inside its own walk of the table,
 * which is the collapse this case is about. A read that answered nothing is passed through as nothing, and is never
 * treated as though something ended.
 *
 * What this fixture is not about: production root signalling. `OwnedCleanup.facilities` is all or nothing, so taking the
 * reader means taking the sender too, and the production sender would reach a pid through `process.kill` without the
 * owned child handle behind it. So every send here is refused instead — see `facilities.signal` below — and what this
 * exercises is the table fault and the collapse behind it. A root that does not end on its own is not chased: the tree
 * treats a throwing send as a send that did not happen and reports `unstoppable`, and this case then keeps its root and
 * says so. That this fake normally ends when its stdin closes is not authority for a pid-only send, and nothing here
 * turns it into one.
 */
interface RootWatch {
	facilities: ProcessFacilities;
	/** The pid to capture an identity for, learned from the child that started. Never proof of anything by itself. */
	follow(pid: number): void;
	readonly captured?: ObservedProcess;
	readonly reads: number;
	readonly injected: boolean;
	readonly availability: "unread" | "ok" | "unavailable";
	/**
	 * The one fresh real read this case is allowed afterwards, and the whole of its authority to remove anything.
	 *
	 * It answers about the captured identity alone: absent, replaced or dead is gone; still live, unknown, or an identity
	 * that was never captured is not gone, and the root is kept and named. What it is not: evidence about a pipe. It says
	 * nothing about whether either stream ever closed, and this fixture has no way to observe that, so nothing here
	 * claims it. Nor is it a statement about descendants — the fake and the fence it runs behind start nothing, which is
	 * the only reason a root-only answer is worth anything here, and it does not carry to a fixture whose child spawns.
	 */
	confirmGone(): Promise<{ gone: boolean; why: string }>;
}

function rootWatch(): RootWatch {
	let pid: number | undefined;
	let captured: ObservedProcess | undefined;
	let injected = false;
	let reads = 0;
	let availability: "unread" | "ok" | "unavailable" = "unread";
	/** Whether the captured identity is still the live process it was: the stamp and the group, not the pid alone. */
	const stillLive = (rows: ObservedProcess[]): boolean => {
		const known = captured;
		if (!known) return false;
		const row = rows.find((candidate) => candidate.pid === known.pid);
		return row !== undefined && row.started === known.started && row.pgid === known.pgid && !isDeadState(row.state);
	};
	return {
		facilities: {
			/**
			 * Every send, refused, and the same refusal for each: a pid, a negative group, the root itself, before the
			 * identity was followed or long after it: this root, its group and any descendant target alike, with no target
			 * it would ever send to. That is the whole of what this fixture's non-signalling means, and it is a property of
			 * this function rather than of the code around it. This fixture holds no authority to signal anything — the production
			 * sender it would otherwise have to borrow reaches a pid through `process.kill` without the owned child handle
			 * behind it, and a pid this fixture merely remembers is not a process it may act on. The tree reads a send that
			 * threw as a send that did not happen, so a root that will not end on its own is reported `unstoppable` and
			 * this case keeps its root and names it, which is the honest outcome rather than a chase.
			 */
			signal: () => {
				throw new Error(WATCH_NO_SIGNAL);
			},
			table: async (budgetMs) => {
				// The production reader, under production's own bounding: this watch's ceiling or what the caller has left.
				const rows = await readProcessTable(budgetMs === undefined ? WATCH_TABLE_MS : Math.min(WATCH_TABLE_MS, budgetMs));
				reads += 1;
				if (!rows) {
					// Unavailable is unavailable: it is not evidence that anything ended, and nothing is injected on it.
					availability = "unavailable";
					return undefined;
				}
				availability = "ok";
				if (!captured) {
					// A live row for the followed pid, with a stamp and a group: anything less is not an identity. On a
					// platform whose rows carry no group — Windows reports zero — nothing is ever captured here, and this
					// case reaches no fault at all rather than capturing something weaker.
					const row = pid === undefined ? undefined : rows.find((candidate) => candidate.pid === pid);
					if (row && row.started !== "" && row.pgid > 0 && !isDeadState(row.state)) captured = { ...row };
					// The read that captured is never the read that injects: what it saw was a process alive.
					return rows;
				}
				if (!injected && !stillLive(rows)) {
					injected = true;
					return NOT_A_TABLE;
				}
				return rows;
			},
		},
		follow: (value) => {
			pid = value;
		},
		get captured() {
			return captured;
		},
		get reads() {
			return reads;
		},
		get injected() {
			return injected;
		},
		get availability() {
			return availability;
		},
		confirmGone: async () => {
			const known = captured;
			if (!known) return { gone: false, why: "this case never captured the root's own identity from a real row, so it has nothing to ask about" };
			const rows = await readProcessTable(WATCH_TABLE_MS);
			if (!rows) return { gone: false, why: `the one fresh read this case is allowed answered nothing, so the state of pid ${known.pid} is unknown` };
			const row = rows.find((candidate) => candidate.pid === known.pid);
			if (!row) return { gone: true, why: `pid ${known.pid} is absent from a fresh real read of the process table` };
			if (row.started !== known.started || row.pgid !== known.pgid) return { gone: true, why: `pid ${known.pid} now belongs to a different process than the one this case captured` };
			if (isDeadState(row.state)) return { gone: true, why: `the process this case captured is in a dead state (${row.state})` };
			return { gone: false, why: `the process this case captured is still live, so nothing here may remove the root it ran under` };
		},
	};
}

interface FaultedCase {
	owned: Owned;
	watch: RootWatch;
	start(over?: Partial<PiChildOptions>): Promise<PiChild>;
}

/** What a faulted case says about itself once it is over, and only once its own teardown has gone through. */
interface FaultedOutcome {
	injected: boolean;
	captured?: ObservedProcess;
	availability: RootWatch["availability"];
}

/**
 * One case for the conditional fault: its own world, its own watch, and two kinds of evidence kept apart.
 *
 * One start per case, because there is one identity to watch and one root to prove. The child is asked for its shutdown
 * in the teardown whatever the body did — `shutdown` is memoized, so a child the body already stopped answers with that
 * same outcome and one the body never reached is asked here for the first time — and a report that comes back goes into
 * this case's reports once.
 *
 * Which gate then decides removal depends on what came back, not on what the case hoped for:
 *
 *  - A report for every start, none included, is the reviewed `disposalEvidence` gate and `disposeOwned`, unchanged. The
 *    ordinary path — an unavailable table, or a read that never saw the captured identity end — goes here, because it has
 *    a real report and needs no physical proof of anything.
 *  - Exactly one expected missing report — `watch.injected` and a `PiTransportError` of kind `unverified` — with an
 *    identity captured from a live real row is the one case that may ask `confirmGone`, once. Absent, replaced or dead is
 *    this fixture's root-only disposal; unknown keeps the root and says so.
 *  - Anything else keeps the root: an identity never captured, a start that failed with no report on it, a rejection this
 *    fixture did not arrange. None of them is a report, and none of them is made into one.
 *
 * Nothing goes missing on the way out. The body's failure, a shutdown that rejected unexpectedly, the one fresh read
 * failing, every removal step that threw and the kept root itself are all problems in the same list, and they leave
 * through the reviewed `caseFailure` with the root named. A removal that threw is reported as a path to look at, never as
 * a directory that is known to be there or known to be gone.
 */
async function withFaultedFake(scenario: string, body: (fault: FaultedCase) => Promise<void>): Promise<FaultedOutcome> {
	const owned = ownedCase(scenario);
	const watch = rootWatch();
	const problems: Thrown[] = [];
	const exits: PiExit[] = [];
	let attempts = 0;
	let child: PiChild | undefined;
	/** The expected no-report collapse, if that is what the shutdown answered with. Nothing else is ever put here. */
	let collapsed: PiTransportError | undefined;
	const fault: FaultedCase = {
		owned,
		watch,
		start: async (over: Partial<PiChildOptions> = {}) => {
			if (attempts > 0) throw new Error("this fixture starts one child per case: it watches one identity and proves one root");
			attempts += 1;
			const { bounds, cleanup, ...rest } = over;
			try {
				const started = await startPiChild({
					killGraceMs: TEST_KILL_GRACE_MS,
					...rest,
					launch: owned.launch,
					bounds: { ...TEST_BOUNDS, ...bounds },
					// The seam that is already there, and the only one used: this watch in place of the platform facilities.
					// Nothing of the transport, the tree or an SDK is replaced or doubled.
					cleanup: { ...TEST_CLEANUP, ...cleanup, facilities: watch.facilities },
				});
				child = started;
				watch.follow(started.pid);
				return started;
			} catch (error) {
				// A refused startup that carried a report is a report; one that carried none stays unaccounted for.
				if (error instanceof PiTransportError && error.finalExit) exits.push(error.finalExit);
				throw error;
			}
		},
	};
	try {
		await body(fault);
	} catch (error) {
		problems.push({ what: "the case's own body", error });
	}
	if (child) {
		try {
			exits.push(await child.shutdown());
		} catch (error) {
			// The one rejection this fixture arranges, and the only one it treats as anything but a failure: a collapse it
			// injected the table fault for. Anything else is kept, unless this very value already came out of the body —
			// one failure is one entry, and identity is what says whether it is the same one.
			if (watch.injected && error instanceof PiTransportError && error.kind === "unverified") collapsed = error;
			else if (!problems.some((problem) => problem.error === error)) problems.push({ what: "the shutdown of this case's own child", error });
		}
	}
	const keep = (why: string): void => {
		RETAINED.push(owned.root);
		problems.push({ what: "the evidence this case could remove its root on", error: new Error(`the root ${owned.root} was kept: ${why}`) });
	};
	const remove = (): void => {
		if (disposeOwned(owned.root, { call: () => owned.storage.dispose(), root: () => owned.dispose() }, problems)) RETAINED.push(owned.root);
	};
	if (exits.length === attempts) {
		// Every start accounted for by a report the transport wrote: the reviewed gate reads them and nothing else does.
		const gate = disposalEvidence(attempts, exits);
		if (gate.dispose) remove();
		else {
			RETAINED.push(owned.root);
			problems.push({ what: "the evidence this case could remove its root on", error: retainedRootFailure(owned.root, gate.missing) });
		}
	} else if (collapsed && watch.captured) {
		let evidence: { gone: boolean; why: string } | undefined;
		try {
			evidence = await watch.confirmGone();
		} catch (error) {
			problems.push({ what: "the one fresh table read this case's own disposal rests on", error });
		}
		if (evidence?.gone) remove();
		else keep(evidence ? evidence.why : "the one fresh read it is allowed threw, so what became of the process it started is unknown");
	} else if (collapsed) {
		keep("the collapse this case expected happened, but no identity was ever captured from a live real row, so there is nothing a fresh read could be asked about");
	} else {
		keep(`this case has ${exits.length} reports for ${attempts} starts, and for the one with none there is neither a report nor an expected collapse to go on`);
	}
	const ending = caseFailure(problems, owned.root);
	if (ending.throws) throw ending.error;
	// Answered only here: a caller that reads this has a teardown that went through behind it.
	return { injected: watch.injected, ...(watch.captured === undefined ? {} : { captured: watch.captured }), availability: watch.availability };
}

test("a cleanup that produced no report rejects both the shutdown and the exit, settles what was waiting, and claims nothing", async (t) => {
	const seen = await withFaultedFake("request-never", async (fault) => {
		const child = await fault.start();
		// Observed the moment each exists. A collapse rejects both of these from inside the transport, and a test that
		// only awaited them later would have had an unhandled rejection in between.
		const onExit = child.exited.then(() => undefined, (error: unknown) => error);
		// An ordinary admitted request the fake never answers. Its own bound is far past the graces this case is configured
		// with added together — arithmetic over this file's own constants, not a duration anybody measured — so what
		// settles it is the shutdown rather than its own clock. It is a failure bound and not a wait for anything.
		const onPending = child.request(ASK_STATS, 60_000).then(() => undefined, (error: unknown) => error);

		const stopped = await child.shutdown().then(
			(exit) => ({ reported: true as const, exit }),
			(error: unknown) => ({ reported: false as const, error }),
		);

		if (!fault.watch.injected) {
			// Nothing was injected, so this is the ordinary shutdown and there is no fault here to assert. What it is
			// checked for instead is that it reported and settled what was waiting; whether the case counts as skipped is
			// decided by the caller below, after this case's own teardown has gone through.
			assert.equal(stopped.reported, true, "with nothing injected this is the ordinary shutdown, which reports");
			assert.ok(stopped.reported && stopped.exit.cleanup, "and what it answers with is the tree's own report rather than anything this case made up");
			assert.ok((await onPending) instanceof PiTransportError, "the request that was waiting was settled by that shutdown rather than left hanging");
			assert.equal(await onExit, undefined, "and the exit resolved, because there was a report to resolve it with");
			return;
		}

		assert.equal(stopped.reported, false, "a cleanup that threw wrote no report, so there is nothing for the shutdown to resolve with");
		const refused = stopped.reported ? undefined : stopped.error;
		if (!(refused instanceof PiTransportError)) return assert.fail("a collapsed finalization rejects with this transport's own refusal");
		assert.equal(refused.kind, "unverified");
		assert.equal(refused.message, "the pi child's cleanup produced no report, and the state of its process is unverified");
		assert.deepEqual([refused.finalExit, refused.exit, refused.stage], [undefined, undefined, undefined], "nothing was invented to carry: no exit, no cleanup report, no counters and no stage");
		assert.equal(refused.message.includes("not a process table"), false, "and nothing of what threw reaches the message");
		assert.equal(refused.message.includes("malformed"), false);

		assert.equal(await onExit, refused, "the exit rejects with that same refusal, and it was observed as it happened");
		assert.equal(await child.shutdown().then(() => undefined, (error: unknown) => error), refused, "a second shutdown is the same collapse and the same refusal");

		const stranded = await onPending;
		if (!(stranded instanceof PiTransportError)) return assert.fail("the request that was still waiting is settled rather than left hanging");
		assert.equal(stranded.kind, "unverified", "and it is settled with what is known, which is that nothing is known about the child");

		// Closed to everything afterwards, and still not claiming anything about the process.
		assert.equal((await refusal(child.request(ASK_STATS, 1_000))).kind, "closed");
		assert.equal((await refusal(child.turn("too late"))).kind, "closed");
		assert.equal(child.respond("a-dialog-nobody-opened", { cancelled: true }), "unknown");
		// The counters are still readable with no report to read them from, and they are not evidence of anything about
		// the pipes: a stream this host stopped waiting on is not a stream anybody saw close.
		assert.equal(typeof child.counters.streamsUnclosed, "number");
	});
	// Only here, and only because the call above returned: the case's own teardown — the owned shutdown, the one fresh read
	// and every removal it was allowed to attempt — has already gone through, so a skip cannot hide a failure in any of
	// them. The fault is conditional by construction, and this says which condition was not met rather than letting the
	// case pass quietly as though it had exercised one.
	if (!seen.injected) {
		t.skip(`the table fault was not reached: ${seen.captured ? `pid ${seen.captured.pid} was captured` : "no live identity was captured"}, and this case's table reads were ${seen.availability}`);
	}
});
