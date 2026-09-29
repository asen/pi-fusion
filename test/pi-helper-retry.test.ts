import assert from "node:assert/strict";
import test from "node:test";
import { HELPER_RETRY_NOTICE, HELPER_UNAVAILABLE, type HelperRetryNotice, withHelperRetry } from "../extensions/backends/pi-helper-retry.mjs";

/*
 * What the one-retry wrapper forwards, retries and lets through, driven against fake tool definitions. No case here
 * constructs an SDK tool, starts a child or runs a helper: each definition's `execute` is a script, so what is measured
 * is the wrapper's own behavior and nothing about Pi's builtins, whose actual error path only a real child can qualify.
 * The abort cases settle a promise by hand rather than wait on a timer.
 */

type Params = { pattern: string };
type Context = { cwd: string };
type Result = { content: { type: "text"; text: string }[]; details: undefined };
type Notify = (update: HelperRetryNotice) => void;

interface FakeTool {
	name: string;
	label: string;
	source: { kind: string };
	execute(id: string, params: Params, signal: AbortSignal | undefined, onUpdate: Notify | undefined, context: Context): Promise<Result>;
}

/** What one attempt was handed, the receiver included, so a test can assert identities rather than equal-looking copies. */
interface Attempt {
	id: string;
	params: Params;
	signal: AbortSignal | undefined;
	onUpdate: Notify | undefined;
	context: Context;
	receiver: unknown;
}

const ID = "toolu-1";
const PARAMS: Params = { pattern: "needle" };
const CONTEXT: Context = { cwd: "/work" };

const hit = (text: string): Result => ({ content: [{ type: "text", text }], details: undefined });

/** A definition whose `execute` is the given script, and the record of what each attempt was called with. */
function fake(script: (attempt: number) => Promise<Result>): { definition: FakeTool; calls: Attempt[] } {
	const calls: Attempt[] = [];
	const definition: FakeTool = {
		name: "grep",
		label: "Search file contents",
		source: { kind: "builtin" },
		execute(id, params, signal, onUpdate, context) {
			calls.push({ id, params, signal, onUpdate, context, receiver: this });
			return script(calls.length);
		},
	};
	return { definition, calls };
}

/** A notice callback that records what it was sent. */
function notice(): { notify: Notify; seen: HelperRetryNotice[] } {
	const seen: HelperRetryNotice[] = [];
	return {
		notify: (update) => {
			seen.push(update);
		},
		seen,
	};
}

/** A promise this test rejects by hand, so an abort can land between a call and its failure without a timer. */
function deferred<T>(): { promise: Promise<T>; reject: (reason: unknown) => void } {
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((_resolve, rejected) => {
		reject = rejected;
	});
	return { promise, reject };
}

test("the messages the retry keys on are the builtins' own, exactly, and the notice repeats neither", () => {
	assert.equal(HELPER_UNAVAILABLE.grep, "ripgrep (rg) is not available and could not be downloaded");
	assert.equal(HELPER_UNAVAILABLE.find, "fd is not available and could not be downloaded");
	assert.ok(!HELPER_RETRY_NOTICE.includes(HELPER_UNAVAILABLE.grep));
	assert.ok(!HELPER_RETRY_NOTICE.includes(HELPER_UNAVAILABLE.find));
	assert.ok(Object.isFrozen(HELPER_UNAVAILABLE));
});

test("a first attempt that succeeds is the only attempt, and says nothing", async () => {
	const result = hit("one match");
	const { definition, calls } = fake(async () => result);
	const { notify, seen } = notice();
	const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.grep);
	assert.equal(await wrapped.execute(ID, PARAMS, undefined, notify, CONTEXT), result);
	assert.equal(calls.length, 1);
	assert.deepEqual(seen, []);
});

for (const [tool, message] of Object.entries(HELPER_UNAVAILABLE)) {
	test(`a ${tool} call whose helper was not there is retried once, on the same definition with the same arguments`, async () => {
		const second = hit("one match");
		const { definition, calls } = fake(async (attempt) => {
			if (attempt === 1) throw new Error(message);
			return second;
		});
		const { notify, seen } = notice();
		const signal = new AbortController().signal;
		const wrapped = withHelperRetry(definition, message);
		assert.equal(await wrapped.execute(ID, PARAMS, signal, notify, CONTEXT), second);
		assert.equal(calls.length, 2);
		for (const call of calls) {
			assert.equal(call.id, ID);
			assert.equal(call.params, PARAMS);
			assert.equal(call.signal, signal);
			assert.equal(call.onUpdate, notify);
			assert.equal(call.context, CONTEXT);
			assert.equal(call.receiver, definition);
		}
		assert.deepEqual(seen, [{ content: [{ type: "text", text: HELPER_RETRY_NOTICE }], details: undefined }]);
	});
}

test("a helper that stays unavailable stops after the second attempt and raises that attempt's own error", async () => {
	const first = new Error(HELPER_UNAVAILABLE.grep);
	const second = new Error(HELPER_UNAVAILABLE.grep);
	const { definition, calls } = fake(async (attempt) => {
		throw attempt === 1 ? first : second;
	});
	const { notify, seen } = notice();
	const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.grep);
	await assert.rejects(wrapped.execute(ID, PARAMS, undefined, notify, CONTEXT), (error: unknown) => error === second);
	assert.equal(calls.length, 2);
	assert.equal(seen.length, 1);
});

const passedThrough: { what: string; thrown: unknown; unavailable: string }[] = [
	{ what: "an unrelated failure of the tool's own", thrown: new Error("Path not found: x"), unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "an abort the tool reports itself", thrown: new Error("Operation aborted"), unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "the message thrown as a string rather than an error", thrown: HELPER_UNAVAILABLE.grep, unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "a thrown value that is no error at all", thrown: { message: HELPER_UNAVAILABLE.grep }, unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "the message with something after it", thrown: new Error(`${HELPER_UNAVAILABLE.grep} in /work`), unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "the message with a trailing space", thrown: new Error(`${HELPER_UNAVAILABLE.grep} `), unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "the message on a line of its own", thrown: new Error(`\n${HELPER_UNAVAILABLE.grep}`), unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "the message in another case", thrown: new Error(HELPER_UNAVAILABLE.grep.toUpperCase()), unavailable: HELPER_UNAVAILABLE.grep },
	{ what: "one helper's message on the other helper's wrapper", thrown: new Error(HELPER_UNAVAILABLE.grep), unavailable: HELPER_UNAVAILABLE.find },
];

for (const { what, thrown, unavailable } of passedThrough) {
	test(`${what} is raised as it came, with no notice and no second attempt`, async () => {
		const { definition, calls } = fake(async () => {
			throw thrown;
		});
		const { notify, seen } = notice();
		const wrapped = withHelperRetry(definition, unavailable);
		await assert.rejects(wrapped.execute(ID, PARAMS, undefined, notify, CONTEXT), (error: unknown) => error === thrown);
		assert.equal(calls.length, 1);
		assert.deepEqual(seen, []);
	});
}

test("a call aborted before its first attempt failed is not retried", async () => {
	const controller = new AbortController();
	const failure = new Error(HELPER_UNAVAILABLE.grep);
	const gate = deferred<Result>();
	const { definition, calls } = fake(() => gate.promise);
	const { notify, seen } = notice();
	const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.grep);
	const running = wrapped.execute(ID, PARAMS, controller.signal, notify, CONTEXT);
	controller.abort();
	gate.reject(failure);
	await assert.rejects(running, (error: unknown) => error === failure);
	assert.equal(calls.length, 1);
	assert.deepEqual(seen, []);
});

test("a notice callback that aborts stops the call with the first attempt's error", async () => {
	const controller = new AbortController();
	const failure = new Error(HELPER_UNAVAILABLE.grep);
	const { definition, calls } = fake(async (attempt) => {
		if (attempt === 1) throw failure;
		return hit("one match");
	});
	const seen: HelperRetryNotice[] = [];
	const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.grep);
	await assert.rejects(
		wrapped.execute(
			ID,
			PARAMS,
			controller.signal,
			(update) => {
				seen.push(update);
				controller.abort();
			},
			CONTEXT,
		),
		(error: unknown) => error === failure,
	);
	assert.equal(calls.length, 1);
	assert.equal(seen.length, 1);
});

for (const { what, thrown } of [
	{ what: "an error of its own", thrown: new Error("the transport is gone") },
	{ what: "an error carrying the helper's own message", thrown: new Error(HELPER_UNAVAILABLE.grep) },
]) {
	test(`a notice callback that throws ${what} raises it, with no second attempt`, async () => {
		const { definition, calls } = fake(async () => {
			throw new Error(HELPER_UNAVAILABLE.grep);
		});
		const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.grep);
		await assert.rejects(
			wrapped.execute(
				ID,
				PARAMS,
				undefined,
				() => {
					throw thrown;
				},
				CONTEXT,
			),
			(error: unknown) => error === thrown,
		);
		assert.equal(calls.length, 1);
	});
}

test("a call with no notice callback is retried just the same", async () => {
	const second = hit("one match");
	const { definition, calls } = fake(async (attempt) => {
		if (attempt === 1) throw new Error(HELPER_UNAVAILABLE.find);
		return second;
	});
	const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.find);
	assert.equal(await wrapped.execute(ID, PARAMS, undefined, undefined, CONTEXT), second);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].onUpdate, undefined);
});

test("everything but execute comes through as it was, and the definition handed in is left alone", async () => {
	const result = hit("one match");
	const { definition, calls } = fake(async () => result);
	const original = definition.execute;
	const source = definition.source;
	const wrapped = withHelperRetry(definition, HELPER_UNAVAILABLE.grep);
	assert.notEqual(wrapped, definition);
	assert.deepEqual(Object.keys(wrapped), Object.keys(definition));
	assert.equal(wrapped.name, definition.name);
	assert.equal(wrapped.label, definition.label);
	assert.equal(wrapped.source, source);
	assert.equal(definition.source, source);
	assert.equal(definition.execute, original);
	assert.notEqual(wrapped.execute, original);
	assert.equal(await wrapped.execute(ID, PARAMS, undefined, undefined, CONTEXT), result);
	assert.equal(calls.length, 1);
});
