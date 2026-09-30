import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A Pi child as the transport sees one, and no more of one than that: the bootstrap's own stage diagnostics on
 * stderr, the native RPC protocol on stdout and stdin, and literals for everything either of them carries.
 *
 * Nothing here imports an SDK, reaches a model or a provider, downloads a helper or starts an installed CLI. It is
 * launched exactly the way a real child is — the production storage, input and launch composition, with this file
 * named as the bootstrap — so what a test drives is the real composition and a fake process at the end of it.
 *
 * `FAKE_PI_SCENARIO` chooses what it does and `FAKE_PI_LOG` names a file every line it read and every record it
 * wrote is appended to. Both are this fixture's own: no production module reads either, and neither has a default
 * that changes what the honest path does.
 *
 * It stays alive through handles it owns and nothing else: a scenario that reads stdin is held up by that reader and
 * ends when stdin does. The three that differ each differ in their own way. `ui-at-startup` is the one that never
 * attaches a reader at all, and holds a bounded timer instead. `probe-never` does attach one and reads normally; what
 * it withholds is an answer, not a read. `ui-backpressure` attaches one and then pauses it: the release marker its own
 * watcher is waiting for is what that pause ends on ordinarily, and it is not the only way it can end — an error from
 * that watcher and the bounded timer beside it each close the watcher and resume the reader as well, and a stdin that
 * ends or a process that exits ends the whole of it whatever the pause was doing. Which of those any run took is not
 * something described here, and none of them is claimed to have happened.
 *
 * Every timer here is fixture machinery of the same kind: a liveness bound, so that a case that failed leaves nothing
 * waiting for good and fails rather than hanging. None of them is a sleep, a step anything is synchronized on, or a
 * measurement of how long anything took.
 */

/** The bootstrap's own marker and configuration exit code, repeated here and pinned against its exports by the test. */
const DIAGNOSTIC_EVENT = "pi-fusion-bootstrap";
const STARTUP_EXIT_CODE = 78;
const SDK_VERSION = "0.85.1";

/** The one bound the two uses of this timer share: it ends the lifetime of a scenario that reads no stdin, and it bounds how long one that paused its reader stays paused — which that scenario resumes from rather than exits on. Bounded, referenced, and owned. */
const KEEPALIVE_MS = 30_000;

/**
 * The control extension's own cancellation sentence, as a literal: this fixture imports nothing of the host's, and the
 * test that drives the scenario using it compares this against the exported constant, so a drift between them fails.
 */
const CONTROL_CANCELLED_TEXT =
	"the session operation reported itself cancelled, so this command did not do what it was asked; nothing here retries it, and where the session stands now is read back rather than assumed";

const SCENARIO = process.env.FAKE_PI_SCENARIO ?? "ok";
const LOG = process.env.FAKE_PI_LOG;

/**
 * Written with `writeSync` rather than through the stream: a pipe's stream is asynchronous, and a scenario that
 * writes a record and then exits would lose it. `EAGAIN` is a full pipe on a non-blocking descriptor and is retried,
 * because the reader on the other end is the transport under test and it is reading.
 *
 * Text or bytes: one scenario's whole point is a byte no decoder can read as a character, and text is encoded here
 * rather than by its caller so that scenario can hand over the bytes it means instead of what utf8 makes of them.
 */
function writeAll(fd, data) {
	const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
	let at = 0;
	while (at < bytes.length) {
		try {
			at += fs.writeSync(fd, bytes, at, bytes.length - at);
		} catch (error) {
			if (error && error.code === "EAGAIN") continue;
			throw error;
		}
	}
}

const log = (what) => {
	if (!LOG) return;
	try {
		fs.appendFileSync(LOG, `${JSON.stringify(what)}\n`);
	} catch {}
};

/** One stdout record, framed the way the protocol frames one: one complete json object, then LF. */
const out = (record) => {
	log({ wrote: record });
	writeAll(1, `${JSON.stringify(record)}\n`);
};

/** Raw stdout, for the scenarios whose whole point is what a record is not, and for one write that holds two. */
const raw = (text) => {
	log({ wroteRaw: text });
	writeAll(1, text);
};

const diagnostic = (stage, detail = {}) => writeAll(2, `${JSON.stringify({ event: DIAGNOSTIC_EVENT, stage, ...detail })}\n`);

const success = (id, command, data) => (data === undefined ? { id, type: "response", command, success: true } : { id, type: "response", command, success: true, data });
const failed = (id, command, error) => ({ id, type: "response", command, success: false, error });

const inputPath = process.argv[2];
let input = {};
try {
	input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
} catch (error) {
	// The same shape a real bootstrap refuses an unreadable input with, so a broken fixture is not read as a protocol
	// failure: the stage says where it stopped and the exit code says it never served.
	diagnostic("input", { error: `the fake pi child could not read its input file (${error && error.code ? error.code : "unreadable"})` });
	process.exit(STARTUP_EXIT_CODE);
}

/** The session this child pretends to have opened. Its file is under the session directory the call named, as Pi's is. */
const SESSION_ID = "fake-pi-session-0001";
const sessionFile = path.join(input.sessionDir ?? process.cwd(), `${SESSION_ID}.jsonl`);

/** A `get_state` answer in the native shape: the model the input named, and the session this child says it opened. */
const state = () => {
	const model = input.model ?? { provider: "fake", model: "fake-model" };
	return {
		model: {
			id: model.model,
			name: model.model,
			api: "openai-completions",
			provider: model.provider,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			contextWindow: 65_536,
			maxTokens: 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		thinkingLevel: input.thinkingLevel ?? "off",
		isStreaming: false,
		isCompacting: false,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionFile,
		sessionId: SESSION_ID,
		autoCompactionEnabled: true,
		messageCount: 0,
		pendingMessageCount: 0,
	};
};

/** One record this child held back, to be released by the next command rather than by a clock. */
let held;

/** The one release marker a paused case writes, under the log directory that case already owns and nowhere else. */
const RELEASE_MARKER = "release-the-fake";

/** The dialog the paused case holds open. One id, so what a host answered is readable in the wire log by itself. */
const PAUSED_DIALOG_ID = "fake-dialog-backpressure";

/**
 * The pause one case needs to fill a host's outbound queue: a watcher for the owned release marker, then a stdin this
 * child reads no further, then the dialog that case holds open, and only then the acknowledgement — so a host whose
 * command was answered knows the watcher is installed and the reading has stopped.
 *
 * The release is that marker appearing, and nothing else: an event, with no poll, no interval and no retry anywhere.
 * The keepalive beside it is a bound on how long this fixture may stay paused at all, so a case whose assertions threw
 * before it could release leaves nothing here waiting for good; it is a liveness bound and not a wait for anything.
 * Both handles are this fixture's own and both are closed on every path out.
 */
function pauseUntilReleased(id, type) {
	if (!LOG) {
		out(failed(id, type, "this fixture pauses only under a case that named a log directory of its own"));
		return;
	}
	const dir = path.dirname(LOG);
	let watcher;
	let keepalive;
	const release = () => {
		if (keepalive !== undefined) clearTimeout(keepalive);
		keepalive = undefined;
		if (watcher) {
			watcher.close();
			watcher = undefined;
		}
		process.stdin.resume();
	};
	try {
		watcher = fs.watch(dir, (_event, filename) => {
			// Exactly the one name this fixture owns: anything else in that directory is somebody else's file.
			if (filename === RELEASE_MARKER) release();
		});
		watcher.on("error", release);
	} catch (error) {
		release();
		out(failed(id, type, `this fixture could not watch for its own release marker (${error && error.code ? error.code : "unwatchable"})`));
		return;
	}
	keepalive = setTimeout(release, KEEPALIVE_MS);
	process.stdin.pause();
	out({ type: "extension_ui_request", id: PAUSED_DIALOG_ID, method: "confirm", message: "hold this one open" });
	out(success(id, type));
}

/** The answer an ordinary command gets when the scenario has nothing to say about it. */
function ordinary(id, type) {
	if (type === "get_session_stats") return success(id, type, { sessionFile, sessionId: SESSION_ID, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 });
	if (type === "get_last_assistant_text") return success(id, type, { text: null });
	if (type === "clear_queue") return success(id, type, { steering: [], followUp: [] });
	if (type === "get_tree") return success(id, type, { tree: [], leafId: null });
	return success(id, type);
}

/**
 * One prompt. The scenarios differ only here, because the acknowledgement and the settle are what a turn is made of:
 * the acknowledgement is emitted after a preflight in the native implementation and the settle comes with the run.
 */
function prompt(id) {
	if (SCENARIO === "ack-never") return;
	if (SCENARIO === "ack-fails") {
		out(failed(id, "prompt", "Cannot prompt while agent is streaming"));
		return;
	}
	if (SCENARIO === "command-ack") {
		// A prompt a caller knows runs no agent loop: it is acknowledged and nothing settles, ever.
		out(success(id, "prompt"));
		return;
	}
	if (SCENARIO === "command-ack-extension-error") {
		// A control command that failed: the runner emits its error and the prompt is acknowledged after it, which is the
		// ordering a host has to read as one turn rather than as an error belonging to nothing. One write holds both,
		// and what a write becomes on the other side is not this fixture's to say.
		raw(`${JSON.stringify({ type: "extension_error", extensionPath: "command:pi-fusion-navigate", event: "command", error: CONTROL_CANCELLED_TEXT })}\n${JSON.stringify(success(id, "prompt"))}\n`);
		return;
	}
	if (SCENARIO === "exit-mid-turn") {
		out(success(id, "prompt"));
		// Exit code zero on purpose: an exit nobody asked for is a failure whatever the code was.
		process.exit(0);
	}
	out({ type: "agent_start" });
	// One write holding both records, which is what a transport that reads the acknowledgement only in a continuation
	// would get wrong: at this size one write is one chunk, and the settle is behind the acknowledgement inside it.
	raw(`${JSON.stringify(success(id, "prompt"))}\n${JSON.stringify({ type: "agent_settled" })}\n`);
}

/** Every command that is not a prompt and not the state probe. This is where the correlation scenarios live. */
function other(command) {
	const id = command.id;
	const type = command.type;
	if (SCENARIO === "request-never") return;
	if (SCENARIO === "late-reply") {
		if (held === undefined) {
			// Held, and released by the next command rather than by a clock: what makes it late is the transport
			// having given up on it, and that is the test's own observation to make before it asks for anything else.
			held = ordinary(id, type);
			return;
		}
		const late = held;
		held = undefined;
		out(late);
		out(ordinary(id, type));
		return;
	}
	if (SCENARIO === "mismatched-command") {
		out(success(id, "get_tree", { tree: [], leafId: null }));
		return;
	}
	if (SCENARIO === "unknown-id") {
		// Shaped like an id this transport issues and far past the ones it has: an answer to nothing it is waiting on.
		out(success("pi-fusion-424242", type));
		return;
	}
	if (SCENARIO === "no-id") {
		// The native parse reply, which carries no id at all and therefore answers no request of anybody's.
		out({ type: "response", command: "parse", success: false, error: "Failed to parse command: Unexpected token" });
		return;
	}
	if (SCENARIO === "bad-frame") {
		raw("this line is not json at all\n");
		return;
	}
	if (SCENARIO === "batch-behind-bad-frame") {
		// One write holding a record no host can read and three whole event records behind it. What one write becomes on
		// the other side is not this fixture's to say — a pipe may cut it anywhere and nothing here observes a chunk —
		// so this arranges the records and their order, and claims nothing about how they arrive.
		const events = [{ type: "agent_start" }, { type: "auto_retry_start" }, { type: "compaction_start" }];
		raw(`this line is not json at all\n${events.map((event) => `${JSON.stringify(event)}\n`).join("")}`);
		return;
	}
	if (SCENARIO === "ui-backpressure" && type === "fake_pause") {
		pauseUntilReleased(id, type);
		return;
	}
	if (SCENARIO === "torn-record") {
		// A whole ordinary answer to this command, then the first byte of a three-byte character, then the LF that ends
		// the record: one write, so what arrives is one record whose last character never came rather than a clean record
		// with a stray byte behind it. The json in front of that byte is a prefix of this record and not a record itself.
		const record = JSON.stringify(ordinary(id, type));
		log({ wroteTorn: record });
		writeAll(1, Buffer.concat([Buffer.from(record, "utf8"), Buffer.from([0xe2, 0x0a])]));
		return;
	}
	out(ordinary(id, type));
}

function onCommand(line) {
	log({ read: line });
	let command;
	try {
		command = JSON.parse(line);
	} catch (error) {
		out({ type: "response", command: "parse", success: false, error: `Failed to parse command: ${error instanceof Error ? error.message : String(error)}` });
		return;
	}
	if (!command || typeof command !== "object") return;
	// A dialog answer is answered with nothing at all, the way the native reader answers one.
	if (command.type === "extension_ui_response") return;
	if (command.type === "get_state") {
		if (SCENARIO === "probe-never") return;
		if (SCENARIO === "probe-then-bad-frame") {
			// The answer to the probe and then a record that is not json, in one write: at this size one write is one
			// chunk, so a host reading them gets the valid answer and the record behind it together.
			raw(`${JSON.stringify(success(command.id, "get_state", state()))}\nthis line is not json at all\n`);
			return;
		}
		if (SCENARIO === "probe-then-event") {
			// The answer to the probe and then one ordinary session event, in that same one write: whatever a host does
			// when it reads that event, it does it with the answer to its own probe already resolved.
			raw(`${JSON.stringify(success(command.id, "get_state", state()))}\n${JSON.stringify({ type: "agent_start" })}\n`);
			return;
		}
		out(success(command.id, "get_state", state()));
		return;
	}
	if (command.type === "prompt") {
		prompt(command.id);
		return;
	}
	other(command);
}

/** LF framing on the way in too: split on LF and on nothing else, and keep whatever came after the last one. */
function readCommands() {
	let rest = "";
	process.stdin.on("data", (chunk) => {
		rest += chunk.toString("utf8");
		for (;;) {
			const lf = rest.indexOf("\n");
			if (lf === -1) return;
			const line = rest.slice(0, lf).replace(/\r$/, "");
			rest = rest.slice(lf + 1);
			if (line !== "") onCommand(line);
		}
	});
	// Closing stdin is how a host asks for an orderly shutdown, and an orderly shutdown is a clean exit.
	process.stdin.on("end", () => process.exit(0));
	process.stdin.on("error", () => process.exit(0));
}

/* The stages, in the order the bootstrap reports them, and then whatever this scenario is about. */
if (SCENARIO === "startup-fail") {
	diagnostic("input");
	diagnostic("sdk", { sdk: SDK_VERSION });
	diagnostic("models", { sdk: SDK_VERSION, error: "a model or credential configuration could not be used" });
	process.exit(STARTUP_EXIT_CODE);
} else if (SCENARIO === "startup-fail-unreadable") {
	// Nothing a diagnostic could be read out of: two long lines of ordinary text, which a small line cap cuts, and
	// then the configuration exit. What a host may say about this child is that it refused, and nothing more.
	writeAll(2, `${"noise from something this child started ".repeat(8)}\n`);
	writeAll(2, `${"more of the same, and none of it anybody's diagnostic ".repeat(8)}\n`);
	process.exit(STARTUP_EXIT_CODE);
} else if (SCENARIO === "exit-before-serving") {
	diagnostic("input");
	diagnostic("sdk", { sdk: SDK_VERSION });
	process.exit(0);
} else if (SCENARIO === "ui-at-startup") {
	diagnostic("input");
	diagnostic("sdk", { sdk: SDK_VERSION });
	diagnostic("runtime", { sdk: SDK_VERSION });
	diagnostic("serving", { sdk: SDK_VERSION });
	// A dialog before anything reads stdin, which is the ordering a real extension can produce: the cancellation a
	// host sends back sits in the pipe, and nothing here claims it unblocks anyone.
	out({ type: "extension_ui_request", id: "fake-dialog-1", method: "select", title: "Which way?", options: ["one", "two"] });
	setTimeout(() => process.exit(0), KEEPALIVE_MS);
} else {
	diagnostic("input");
	diagnostic("sdk", { sdk: SDK_VERSION });
	diagnostic("runtime", { sdk: SDK_VERSION });
	diagnostic("serving", { sdk: SDK_VERSION });
	readCommands();
}
