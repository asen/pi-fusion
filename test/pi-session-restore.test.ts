import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_CANCELLED, CONTROL_EXTENSION_PATH, FORK_COMMAND, NAVIGATE_COMMAND } from "../extensions/backends/pi-control-extension.mjs";
import { type PiRestore, type PiRestoreDone, type PiRestoreRefused, type RestoreChild, restoreSession } from "../extensions/backends/pi-session-restore.ts";
import { type PiExit, type PiExtensionError, type PiResponse, PiTransportError, type PiTurn, piFailure } from "../extensions/backends/pi-transport.ts";
import type { ClaudeSessionRef, PiSessionRef, SessionIntent } from "../extensions/backends/types.ts";

/*
 * What the host does with a child's answers while it restores a session, driven against one scripted child that is
 * neither a process nor a protocol: every answer below is a literal this file wrote, so what is measured is the
 * sequence, the checks and the cleanup, and nothing at all about Pi. No case here starts a child, speaks the native
 * protocol, imports an SDK or touches a session file. A real child's session semantics — that a fork holds what the
 * source held, that any of it was persisted — is not something a scripted answer can show, and none is claimed.
 */

const SESSION_ID = "pi-session-source";
const SESSION_FILE = "/sessions/pi-session-source.jsonl";
const CHECKPOINT = "entry-42";
const FORK_ID = "pi-session-fork";
const FORK_FILE = "/sessions/pi-session-fork.jsonl";

/**
 * A value a scripted answer throws instead of answering, held in a wrapper so `undefined` is a value like any other.
 * The field is declared and assigned rather than written as a constructor parameter property, because node runs these
 * files by stripping their types and a parameter property is syntax that stripping cannot erase.
 */
class Thrown {
	readonly error: unknown;
	constructor(error: unknown) {
		this.error = error;
	}
}

/** One scripted answer: a response, a response built when it is asked for, or something thrown in its place. */
type Answer = PiResponse | (() => PiResponse) | Thrown;

interface ChildScript {
	/** The `get_state` answers, in the order the restore asks for them. */
	state?: Answer[];
	commands?: Answer;
	tree?: Answer;
	turn?: PiTurn | Thrown;
	/** What the shutdown every refusal attempts reports, or throws. */
	exit?: PiExit | Thrown;
}

/**
 * What the child was asked, in order. The three lists are what most cases read an absence off, and `steps` is the
 * three of them interleaved, so a case can assert the order the requests, the prompt and the stop actually happened
 * in rather than three orders that each hold on their own.
 */
interface Seen {
	steps: string[];
	requests: string[];
	turns: Array<{ text: string; opts: unknown }>;
	shutdowns: Array<"host" | "aborted" | undefined>;
}

const response = (command: string, success: boolean, data: unknown): PiResponse => ({ id: "pi-fusion-1", command, success, ...(success ? {} : { error: "the child refused this command" }), data });
const ok = (command: string, data: unknown): PiResponse => response(command, true, data);
const no = (command: string, data: unknown): PiResponse => response(command, false, data);

/** A state answer in the native shape, with fields this restore reads nothing from kept on it so it carries them. */
const stateData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	sessionId: SESSION_ID,
	sessionFile: SESSION_FILE,
	isStreaming: false,
	isCompacting: false,
	thinkingLevel: "off",
	messageCount: 7,
	...over,
});

const commandRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	name: NAVIGATE_COMMAND,
	description: "Move this session to an entry of its tree",
	source: "extension",
	sourceInfo: { path: CONTROL_EXTENSION_PATH, source: "inline", scope: "temporary", origin: "top-level" },
	...over,
});

const commandsOf = (...rows: unknown[]): PiResponse => ok("get_commands", { commands: rows });

/** A registration this restore has nothing to do with, carrying none of the optional metadata a row may have. */
const unrelatedRow = { name: "skill:notes", source: "skill" };

/**
 * What a child with this host's control extension answers with: both of its commands, and something else beside them.
 * Both happy paths use it, so each of them proves the other's command and an unrelated row change nothing about the
 * one the intent needs.
 */
const controlCommands = (): PiResponse => commandsOf(commandRow(), commandRow({ name: FORK_COMMAND, description: "Fork this session at an entry of its tree" }), unrelatedRow);

const treeOf = (leafId: unknown): PiResponse => ok("get_tree", { tree: [], leafId });

const turnOf = (over: Partial<PiTurn> = {}): PiTurn => ({ outcome: "acknowledged", ack: ok("prompt", undefined), earlySettles: 0, extensionErrors: 0, events: 1, ...over });

const extensionError = (over: Partial<PiExtensionError> = {}): PiExtensionError => ({
	error: CONTROL_CANCELLED,
	extensionPath: `command:${NAVIGATE_COMMAND}`,
	event: "command",
	cut: { error: false, extensionPath: false, event: false },
	...over,
});

/** One exit report in the shape the transport writes one. Nothing ran: it is what a scripted shutdown hands back. */
const exitOf = (over: { cleanup?: Partial<PiExit["cleanup"]> } = {}): PiExit => ({
	exit: { code: 0, signal: null },
	cleanup: { root: "exited", exit: { code: 0, signal: null }, stdio: "closed", discovery: "ok", terminated: [], leftovers: [], skipped: [], deadlineHit: false, ...over.cleanup },
	stderr: { serving: true, stageCount: 4, truncatedLines: 0, lines: 4, tail: "", dropped: 0 },
	stoppedByUs: true,
	counters: { straySettles: 0, earlySettles: 0, lateResponses: 0, extensionErrors: 0, uiCancelledByTransport: 0, unknownUiMethods: 0, listenerErrors: 0, droppedFrames: 0, streamsUnclosed: 0 },
});

/** One child, scripted and in memory. A command the restore has no business sending fails the case that sent it. */
function scripted(script: ChildScript): { child: RestoreChild; seen: Seen } {
	const seen: Seen = { steps: [], requests: [], turns: [], shutdowns: [] };
	const states = [...(script.state ?? [])];
	const deliver = (answer: Answer | undefined, what: string): PiResponse => {
		if (answer === undefined) return assert.fail(`this case scripted no ${what} answer, and one was asked for`);
		if (answer instanceof Thrown) throw answer.error;
		return typeof answer === "function" ? answer() : answer;
	};
	const child: RestoreChild = {
		request: async (command) => {
			seen.steps.push(command.type);
			seen.requests.push(command.type);
			if (command.type === "get_state") return deliver(states.shift(), "get_state");
			if (command.type === "get_commands") return deliver(script.commands, "get_commands");
			if (command.type === "get_tree") return deliver(script.tree, "get_tree");
			return assert.fail(`the restore sent ${command.type}, which is not one of the three commands it has`);
		},
		turn: async (text, opts) => {
			seen.steps.push("turn");
			seen.turns.push({ text, opts });
			if (script.turn === undefined) return assert.fail("this case scripted no turn, and one was started");
			if (script.turn instanceof Thrown) throw script.turn.error;
			return script.turn;
		},
		shutdown: async (reason) => {
			seen.steps.push("shutdown");
			seen.shutdowns.push(reason);
			if (script.exit === undefined) return exitOf();
			if (script.exit instanceof Thrown) throw script.exit.error;
			return script.exit;
		},
	};
	return { child, seen };
}

/** The happy resume, which every case below changes one thing of. */
const resumeScript = (over: ChildScript = {}): ChildScript => ({
	state: [ok("get_state", stateData()), ok("get_state", stateData())],
	commands: controlCommands(),
	tree: treeOf(CHECKPOINT),
	turn: turnOf(),
	...over,
});

/** The happy fork: the same source, and a session of its own after the command. */
const forkScript = (over: ChildScript = {}): ChildScript => ({
	state: [ok("get_state", stateData()), ok("get_state", stateData({ sessionId: FORK_ID, sessionFile: FORK_FILE }))],
	commands: controlCommands(),
	tree: treeOf(CHECKPOINT),
	turn: turnOf(),
	...over,
});

/**
 * The recorded reference, with whatever a case is about written over it. A blank field and a relative path are both
 * references a host could be holding and neither is one the declared shape admits, so the cast lives here alone.
 */
const refOf = (over: Record<string, unknown> = {}): PiSessionRef => ({ backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: CHECKPOINT, ...over }) as unknown as PiSessionRef;

const resumeOf = (over: Record<string, unknown> = {}): SessionIntent => ({ kind: "resume", ref: refOf(over) });
const forkOf = (over: Record<string, unknown> = {}): SessionIntent => ({ kind: "fork", from: refOf(over) });

const RESUME = resumeOf();
const FORK = forkOf();

const success = (result: PiRestore): PiRestoreDone => (result.ok ? result : assert.fail(`this restore should have succeeded and refused with ${result.reason}`));
const refusal = (result: PiRestore): PiRestoreRefused => (result.ok ? assert.fail("this restore should not have succeeded") : result);

const navigate = (checkpoint: string): string => `/${NAVIGATE_COMMAND} ${JSON.stringify(checkpoint)}`;

test("a resume reads the session back at every step, sends one command line, and hands the child on", async () => {
	const script = resumeScript();
	const { child, seen } = scripted(script);
	const result = success(await restoreSession(child, RESUME));

	assert.deepEqual(seen.steps, ["get_state", "get_commands", "turn", "get_state", "get_tree"], "the prompt sits between the commands it was checked against and the readbacks that follow it");
	assert.deepEqual(seen.requests, ["get_state", "get_commands", "get_state", "get_tree"], "the state, the commands, the state again and the tree, in that order");
	assert.deepEqual(seen.turns, [{ text: navigate(CHECKPOINT), opts: { completion: "acknowledged" } }], "one prompt, ending at the acknowledgement because a control command runs no agent loop");
	assert.deepEqual(result.session, { backend: "pi", sessionId: SESSION_ID, sessionFile: SESSION_FILE, checkpoint: CHECKPOINT });
	assert.equal(result.state, (script.state?.[1] as PiResponse).data, "the state handed back is the answer the child gave, not a copy of the parts that were read");
	assert.deepEqual(seen.shutdowns, [], "a restore that worked leaves the child to the caller that started it");

	// An entry id is opaque: whatever is in it travels as the one json string the child's own parser decodes.
	for (const checkpoint of ["  padded  ", 'holds "quotes"', "holds \\ backslash", "holds\nnewline"]) {
		const odd = scripted(resumeScript({ tree: treeOf(checkpoint) }));
		const restored = success(await restoreSession(odd.child, resumeOf({ checkpoint })));
		assert.deepEqual(odd.seen.turns, [{ text: navigate(checkpoint), opts: { completion: "acknowledged" } }]);
		assert.equal(restored.session.checkpoint, checkpoint, "the checkpoint is the one that arrived, neither trimmed nor normalized");
	}
});

test("a fork ends in a session of its own, at the leaf it was forked at", async () => {
	const { child, seen } = scripted(forkScript());
	const result = success(await restoreSession(child, FORK));

	assert.deepEqual(seen.steps, ["get_state", "get_commands", "turn", "get_state", "get_tree"], "the same interleaving, with the fork's own command in the middle of it");
	assert.deepEqual(seen.requests, ["get_state", "get_commands", "get_state", "get_tree"]);
	assert.deepEqual(seen.turns, [{ text: `/${FORK_COMMAND} ${JSON.stringify(CHECKPOINT)}`, opts: { completion: "acknowledged" } }]);
	assert.deepEqual(result.session, { backend: "pi", sessionId: FORK_ID, sessionFile: FORK_FILE, checkpoint: CHECKPOINT }, "the id and the file are the ones read back, and the checkpoint the one the tree confirmed");
	assert.deepEqual(seen.shutdowns, []);
});

test("an intent this build cannot run is refused before the child is touched at all", async () => {
	const claude: ClaudeSessionRef = { backend: "claude", sessionId: "claude-session", checkpoint: CHECKPOINT };
	const unsupported: SessionIntent[] = [{ kind: "new" }, { kind: "resume", ref: claude }, { kind: "fork", from: claude }];
	for (const intent of unsupported) {
		const { child, seen } = scripted({});
		await assert.rejects(restoreSession(child, intent), TypeError);
		assert.deepEqual([seen.requests, seen.turns, seen.shutdowns], [[], [], []], "nothing was sent and nothing was stopped: the caller still owns the child it started");
	}
});

test("a reference this host cannot act on is refused before anything is sent, and the child is stopped once", async () => {
	const references: Array<Record<string, unknown>> = [{ checkpoint: undefined }, { sessionId: "   " }, { sessionFile: "sessions/relative.jsonl" }];
	for (const over of references) {
		const { child, seen } = scripted({});
		const result = refusal(await restoreSession(child, resumeOf(over)));
		assert.equal(result.reason, "reference");
		assert.deepEqual([seen.requests, seen.turns], [[], []], "a reference is read before any of it is acted on");
		assert.deepEqual(seen.shutdowns, ["host"], "the child was claimed by a supported intent, so it is stopped");
		assert.equal(result.exit?.cleanup.root, "exited", "and what the shutdown reported comes back with the refusal");
	}
});

test("a state answer that is not the session this call named stops the restore before a command is read", async () => {
	const answers: Answer[] = [ok("get_state", stateData({ sessionId: "pi-session-other" })), no("get_state", stateData()), ok("get_state", stateData({ isStreaming: true }))];
	for (const answer of answers) {
		const { child, seen } = scripted(resumeScript({ state: [answer] }));
		const result = refusal(await restoreSession(child, RESUME));
		assert.equal(result.reason, "state");
		assert.deepEqual(seen.requests, ["get_state"], "the commands are not asked for on a child that opened something else");
		assert.deepEqual(seen.shutdowns, ["host"]);
	}
});

test("the control command has to be the one bare name this host's own extension registered", async () => {
	const answers: Answer[] = [
		commandsOf(),
		commandsOf(commandRow({ name: `${NAVIGATE_COMMAND}:2` })),
		commandsOf(commandRow(), commandRow({ name: `${NAVIGATE_COMMAND}:2` })),
		commandsOf(commandRow(), commandRow()),
		commandsOf(commandRow({ source: "prompt" })),
		commandsOf(commandRow({ sourceInfo: { path: "/somebody/else/extension.mjs", source: "project", scope: "project", origin: "top-level" } })),
		no("get_commands", { commands: [commandRow()] }),
	];
	for (const answer of answers) {
		const { child, seen } = scripted(resumeScript({ commands: answer }));
		const result = refusal(await restoreSession(child, RESUME));
		assert.equal(result.reason, "commands");
		assert.deepEqual(seen.requests, ["get_state", "get_commands"], "nothing is sent to a child whose command this host cannot account for");
		assert.deepEqual(seen.turns, []);
		assert.deepEqual(seen.shutdowns, ["host"]);
	}
});

test("a prompt that was not acknowledged is the turn's failure, and an error behind one is the operation's", async () => {
	const unacknowledged = scripted(resumeScript({ turn: turnOf({ outcome: "rejected" }) }));
	const rejected = refusal(await restoreSession(unacknowledged.child, RESUME));
	assert.equal(rejected.reason, "turn");
	assert.equal(rejected.turn?.outcome, "rejected", "the turn comes back as the evidence it is");
	assert.equal(rejected.cancelled, undefined);
	assert.deepEqual(unacknowledged.seen.requests, ["get_state", "get_commands"], "nothing is read back after a prompt that did not go through");

	// Acknowledged and then failed: cancelled is the control extension's own sentence, from the command that was sent,
	// whole. Anything else is an operation failure this host cannot name, and a cut field is a prefix rather than it.
	const errors: Array<{ what: string; last: PiExtensionError; cancelled: boolean }> = [
		{ what: "the cancellation itself", last: extensionError(), cancelled: true },
		{ what: "another error the command failed with", last: extensionError({ error: "the runtime lost the entry" }), cancelled: false },
		{ what: "the cancellation reported for another event", last: extensionError({ event: "session_start" }), cancelled: false },
		{ what: "the cancellation from another command", last: extensionError({ extensionPath: `command:${FORK_COMMAND}` }), cancelled: false },
		{ what: "a cancellation whose error was cut", last: extensionError({ cut: { error: true, extensionPath: false, event: false } }), cancelled: false },
	];
	for (const { what, last, cancelled } of errors) {
		const { child, seen } = scripted(resumeScript({ turn: turnOf({ extensionErrors: 1, lastExtensionError: last }) }));
		const result = refusal(await restoreSession(child, RESUME));
		assert.equal(result.reason, "operation", what);
		assert.equal(result.cancelled, cancelled ? true : undefined, what);
		assert.equal(result.turn?.extensionErrors, 1, what);
		assert.deepEqual(seen.requests, ["get_state", "get_commands"], `${what}: an operation that failed is never read back as one that happened`);
		assert.deepEqual(seen.shutdowns, ["host"], what);
	}
});

test("a session acknowledged as moved and not read back as moved is a postcondition failure", async () => {
	// Two of these rows stand for shapes read out of 0.85.1's source rather than run: a native move to a user or
	// custom message leaves the leaf at that entry's parent, and a fork re-chains the branch's labels behind its last
	// retained entry, so each reads a leaf back that is not the checkpoint. The answers below are this file's own
	// literals — nothing here executed either shape, and neither row is evidence about what a real child does.
	const cases: Array<{ what: string; script: ChildScript; intent: SessionIntent; asked: string[] }> = [
		{ what: "a resume that ended in another session", script: resumeScript({ state: [ok("get_state", stateData()), ok("get_state", stateData({ sessionId: "pi-session-other" }))] }), intent: RESUME, asked: ["get_state", "get_commands", "get_state"] },
		{ what: "a resume left at another leaf, the shape a native move to a user or custom message's parent has", script: resumeScript({ tree: treeOf("entry-41-parent") }), intent: RESUME, asked: ["get_state", "get_commands", "get_state", "get_tree"] },
		{ what: "a fork left at another leaf, the shape a branch whose labels are re-chained last has", script: forkScript({ tree: treeOf("entry-label-7") }), intent: FORK, asked: ["get_state", "get_commands", "get_state", "get_tree"] },
		{ what: "a fork that kept the source id", script: forkScript({ state: [ok("get_state", stateData()), ok("get_state", stateData({ sessionFile: FORK_FILE }))] }), intent: FORK, asked: ["get_state", "get_commands", "get_state"] },
		{ what: "a fork that kept the source file", script: forkScript({ state: [ok("get_state", stateData()), ok("get_state", stateData({ sessionId: FORK_ID }))] }), intent: FORK, asked: ["get_state", "get_commands", "get_state"] },
		{ what: "a fork whose file is not absolute", script: forkScript({ state: [ok("get_state", stateData()), ok("get_state", stateData({ sessionId: FORK_ID, sessionFile: "sessions/fork.jsonl" }))] }), intent: FORK, asked: ["get_state", "get_commands", "get_state"] },
		{ what: "a session still streaming when it was read back", script: forkScript({ state: [ok("get_state", stateData()), ok("get_state", stateData({ sessionId: FORK_ID, sessionFile: FORK_FILE, isStreaming: true }))] }), intent: FORK, asked: ["get_state", "get_commands", "get_state"] },
	];
	for (const { what, script, intent, asked } of cases) {
		const { child, seen } = scripted(script);
		const result = refusal(await restoreSession(child, intent));
		assert.equal(result.reason, "postcondition", what);
		assert.deepEqual(seen.requests, asked, what);
		assert.deepEqual(seen.shutdowns, ["host"], what);
	}
});

test("a step that threw its own failure keeps that failure, the value it threw, and whatever the shutdown reported", async () => {
	const timedOut = new PiTransportError(piFailure("timeout"));
	const unstoppable = exitOf({ cleanup: { root: "unstoppable", leftovers: [{ pid: 4242, ppid: 41, pgid: 41, state: "S", started: "1" }] } });
	const { child, seen } = scripted(resumeScript({ commands: new Thrown(timedOut), exit: unstoppable }));
	const result = refusal(await restoreSession(child, RESUME));
	assert.equal(result.reason, "transport");
	assert.equal(result.failure?.kind, "timeout");
	assert.equal(result.failure?.message, timedOut.message, "the typed failure is the one the transport composed");
	assert.equal(result.error, timedOut, "and the error itself is kept as it was thrown");
	assert.equal(result.exit, unstoppable, "the exit is what the shutdown reported, root and leftovers exactly as they were");
	assert.deepEqual(seen.shutdowns, ["host"]);

	// A cancellation that arrived as a transport error is a cancellation, and the stop is asked for as one.
	const cancelled = new PiTransportError(piFailure("aborted"));
	const second = scripted(resumeScript({ commands: new Thrown(cancelled) }));
	const stopped = refusal(await restoreSession(second.child, RESUME));
	assert.equal(stopped.reason, "aborted");
	assert.equal(stopped.failure?.kind, "aborted");
	assert.deepEqual(second.seen.shutdowns, ["aborted"]);
});

test("a step that threw nothing and a shutdown that threw zero are both kept exactly as they were", async () => {
	const { child, seen } = scripted(resumeScript({ turn: new Thrown(undefined), exit: new Thrown(0) }));
	const result = refusal(await restoreSession(child, RESUME));
	assert.equal(result.reason, "transport");
	assert.equal(Object.hasOwn(result, "error"), true, "a thrown undefined is still the value that was thrown");
	assert.equal(result.error, undefined);
	assert.equal(result.failure, undefined, "nothing typed it, so no failure is invented for it");
	assert.equal(result.unverified, true);
	assert.equal(Object.hasOwn(result, "shutdownError"), true, "and a thrown zero is kept the same way");
	assert.equal(result.shutdownError, 0);
	assert.equal(Object.hasOwn(result, "exit"), false, "a shutdown that reported nothing invents no exit");
	assert.deepEqual(seen.shutdowns, ["host"]);
});

test("a cancelled restore stops at a boundary, and never reports a session it did not finish reading back", async () => {
	const first = new AbortController();
	first.abort();
	const before = scripted(resumeScript());
	const stopped = refusal(await restoreSession(before.child, RESUME, { signal: first.signal }));
	assert.equal(stopped.reason, "aborted");
	assert.deepEqual([before.seen.requests, before.seen.turns], [[], []], "a signal that was already aborted sends nothing");
	assert.deepEqual(before.seen.shutdowns, ["aborted"]);

	// Aborted as the commands answer arrives: the boundary before the prompt is where that is read.
	const second = new AbortController();
	const atCommand = scripted(
		resumeScript({
			commands: () => {
				second.abort();
				return controlCommands();
			},
		}),
	);
	const unsent = refusal(await restoreSession(atCommand.child, RESUME, { signal: second.signal }));
	assert.equal(unsent.reason, "aborted");
	assert.deepEqual(atCommand.seen.turns, [], "the prompt is not sent on a run that was cancelled before it");

	// And aborted as the last answer arrives: the gate after it is what keeps a cancelled restore from succeeding.
	const third = new AbortController();
	const atTree = scripted(
		resumeScript({
			tree: () => {
				third.abort();
				return treeOf(CHECKPOINT);
			},
		}),
	);
	const late = refusal(await restoreSession(atTree.child, RESUME, { signal: third.signal }));
	assert.equal(late.reason, "aborted");
	assert.deepEqual(atTree.seen.requests, ["get_state", "get_commands", "get_state", "get_tree"], "every step ran, and the cancellation is still what the restore reports");
	assert.deepEqual(atTree.seen.shutdowns, ["aborted"]);
});
