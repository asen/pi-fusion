/**
 * One search tool call, retried once when the child could not get its helper the first time.
 *
 * A Pi child's `grep` and `find` acquire their helper — `rg`, `fd` — on first use, and two children sharing one managed
 * bin can overlap there: the one that loses that race comes back with the tool's own unavailable error, and the other
 * attempt's install may by then have been published, or may not — the recorded experiment observed the end state, not
 * that interval continuously, so nothing here treats the winner's helper as being on disk at the moment the loser
 * fails. This wraps such a tool definition so a second attempt runs against whatever is there by the time it runs. It
 * wraps one tool call and nothing else: no prompt, no session and no task is repeated, and there is no loop, no sleep,
 * no lock, no warmup, no filesystem probe and no setting of its own. The SDK's own network retries inside a download
 * are untouched, and nothing here is imported from it — this file is plain ESM because the bootstrap that will install
 * it is.
 */

/**
 * The exact sentence each builtin rejects with when it could not get its helper, keyed by the tool's own name. The
 * text is the whole of the signal: those builtins call their tool manager with no status callback and reject with one
 * fixed sentence, so a failed download, a failed extraction and a failed lookup are the same string here and nothing
 * else on the error tells them apart. That is also the limit — this says a message is that failure, never that a
 * failure whose message it does not know came from somewhere else, and text alone distinguishes no error's origin. A
 * build that rewords these turns the retry off rather than making it misfire, which is the direction worth failing in.
 */
export const HELPER_UNAVAILABLE = Object.freeze({
	grep: "ripgrep (rg) is not available and could not be downloaded",
	find: "fd is not available and could not be downloaded",
});

/**
 * What a retry says for itself, once, before the second attempt. One fixed sentence: nothing from the caught error, no
 * path and no value of the call's own is ever put in it, so it carries no credential and nothing of the host's.
 */
export const HELPER_RETRY_NOTICE = "The search helper was not available on the first attempt, so this tool call is being retried once.";

/**
 * The same tool definition with `execute` replaced by one that may run the original twice, so a model-issued call makes
 * at most two underlying attempts. The copy carries the definition's own enumerable fields, by reference and otherwise
 * unchanged, so the metadata a factory put on it and whatever else reads it stay what they were; the definition handed
 * in is not mutated. The original is called as a method on itself, with the same argument identities, so a definition
 * that uses its own `this` or compares what it was handed sees no difference between the two attempts.
 *
 * What is retried is narrow on purpose: a rejection that is an `Error` whose message is exactly `unavailable`, and
 * nothing else. Another message, a substring of this one, another case or spacing, a non-`Error` value — each is
 * rethrown as it came, by identity, and no cause, code or stack is read. An already aborted signal ends the call with
 * that first error, before the notice and before a second attempt, and the signal is read again immediately after the
 * notice, because a notice callback may abort. The notice goes to the caller's own `onUpdate` in the tool-result shape
 * the public API already has, not a protocol of this module's own; the installed `grep` and `find` call no `onUpdate`
 * themselves and are composed with no custom operation, so the one this sends is the only update such a call carries.
 * A callback that throws is left to throw: its error is not caught, not translated and not followed by a second
 * attempt. At most one second call is made, with the same arguments, and its result or rejection is the call's own.
 *
 * The limit, and it is worth being plain about: the second `execute` re-enters the SDK's whole acquisition path rather
 * than looking a file up. Where the lookup now finds a helper another attempt published, it is cheap; where the lookup
 * still misses, that attempt performs another complete download — version resolution, fetch, extraction, publication —
 * and can contend with an attempt still in flight at the same shared archive name. The SDK's own fetch retries stay
 * exactly as they are inside each attempt, and nothing here serializes, locks or coordinates the two. It fails like the
 * first attempt when nothing was published in time, when offline mode is on, or when whatever made the helper
 * unavailable is still true. One bounded best-effort recovery, then: not a repair of the race, not a guarantee, and not
 * necessarily a cheap second call.
 */
export function withHelperRetry(definition, unavailable) {
	const retrying = { ...definition };
	retrying.execute = async (id, params, signal, onUpdate, ctx) => {
		try {
			return await definition.execute(id, params, signal, onUpdate, ctx);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== unavailable || signal?.aborted) throw error;
			onUpdate?.({ content: [{ type: "text", text: HELPER_RETRY_NOTICE }], details: undefined });
			if (signal?.aborted) throw error;
			return await definition.execute(id, params, signal, onUpdate, ctx);
		}
	};
	return retrying;
}
