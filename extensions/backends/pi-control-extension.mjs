/**
 * The one extension Fusion itself puts inside a Pi child: two commands a host uses to move that child's session, and
 * nothing else. It imports nothing at all — no SDK, no schema language, no node builtin — because it is composed by
 * the bootstrap and handed to the resource loader as a factory, and a module a child loads should bring nothing with
 * it that the child did not already have.
 *
 * Why commands rather than a tool or an RPC call. Pi's own session operations — navigating the tree and forking at an
 * entry — are on the command context alone, and they are command-only because calling them from a lifecycle handler
 * can deadlock the runtime. So a host that wants a child to navigate sends a prompt that is one slash command, and
 * that is what these two are. Nothing here decides when to send one, which entry it names, or what the host does with
 * the answer: this file registers two handlers and gets out of the way.
 *
 * What it deliberately does not do: no tool, no hook, no UI, no `withSession` callback, no state of its own and no
 * second attempt at anything. A session replacement invalidates the context the handler was called with, so a handler
 * that did work after it would be working through a context that is no longer the session's.
 */

/** The name the loader lists this extension under, which is also what fixes the path it reports. */
export const CONTROL_EXTENSION_NAME = "pi-fusion";

/**
 * The path this extension is reported under once it is loaded. The resource loader spells a named factory
 * `<inline:name>` and uses that same string as the resolved path and as the source path of everything it registers,
 * so this constant is what the bootstrap's resource check admits and what its command check compares against. It is
 * the loader's own metadata about a factory the bootstrap passed in this same process — not a proof of identity for
 * arbitrary code, and nothing here treats it as one.
 */
export const CONTROL_EXTENSION_PATH = `<inline:${CONTROL_EXTENSION_NAME}>`;

/** The command that moves the child's session to an entry of its tree. */
export const NAVIGATE_COMMAND = "pi-fusion-navigate";

/** The command that forks the child's session at an entry, with that entry kept. */
export const FORK_COMMAND = "pi-fusion-fork";

/** Both of them, in the order they are registered, frozen so a caller reads the list rather than edits it. */
export const CONTROL_COMMANDS = Object.freeze([NAVIGATE_COMMAND, FORK_COMMAND]);

/**
 * What a command called with anything but one json string fails with, and all it says. The host composes the argument
 * as `JSON.stringify(id)`, so a failure here is the two installs disagreeing rather than a user typing something:
 * nothing of what arrived is repeated, because an entry id is this session's own content.
 */
export const CONTROL_INVALID_ARGUMENT = "this control command takes exactly one json string naming an entry of this session, and it was called with something else; nothing was navigated or forked, and what arrived is not repeated here";

/** What a session operation the runtime reported as cancelled fails with. Where the session is now is the host's to read back. */
export const CONTROL_CANCELLED = "the session operation reported itself cancelled, so this command did not do what it was asked; nothing here retries it, and where the session stands now is read back rather than assumed";

/**
 * What an operation that answered with something other than whether it was cancelled fails with. It is neither a
 * success nor a cancellation: whether anything happened is unknown to this handler, so it says that rather than
 * picking one of the two.
 */
export const CONTROL_UNANSWERED = "the session operation answered with something other than whether it was cancelled, so whether it happened is unknown here; nothing here treats it as done";

/**
 * The one entry id a handler was given. Pi's own parser splits the command line at its first space and hands the rest
 * over exactly as it was, so the argument is a json document and this is its decoding: a parse failure, a value that
 * is not a string and a string that is blank once trimmed are each the same fixed refusal, and a string that is not
 * blank is returned exactly as it was decoded. Nothing is trimmed, normalized or matched against a shape an id is
 * expected to have — which entries a session holds is the session's own business, not this file's.
 */
function entryId(args) {
	let decoded;
	try {
		decoded = JSON.parse(args);
	} catch {
		throw new Error(CONTROL_INVALID_ARGUMENT);
	}
	if (typeof decoded !== "string" || decoded.trim() === "") throw new Error(CONTROL_INVALID_ARGUMENT);
	return decoded;
}

/**
 * What an operation answered, checked before this handler returns. The public operations answer `{ cancelled }`, and
 * the two things a handler may report are a completed operation and a cancelled one; anything else is neither, and a
 * handler that returned on it would tell the host the operation went through. An error the operation itself threw is
 * not touched: it passes out of the handler exactly as it was, because what failed is the runtime's to say.
 */
function settled(result) {
	if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.cancelled !== "boolean") throw new Error(CONTROL_UNANSWERED);
	if (result.cancelled) throw new Error(CONTROL_CANCELLED);
}

/**
 * The extension as the loader takes one: a name, so it is listed and reported under a path this build knows, and a
 * factory that registers the two commands in its body and returns. Built fresh on every call, so nothing is shared
 * between two children of one host process.
 *
 * Both handlers pass the entry id through unchanged and name the one option that decides what the operation means:
 * navigation summarizes nothing, because a summary would be a model request a host did not ask for, and a fork keeps
 * the entry it was given rather than the one before it.
 */
export function controlExtension() {
	return {
		name: CONTROL_EXTENSION_NAME,
		factory: (pi) => {
			pi.registerCommand(NAVIGATE_COMMAND, {
				description: "Move this session to an entry of its tree",
				handler: async (args, ctx) => {
					settled(await ctx.navigateTree(entryId(args), { summarize: false }));
				},
			});
			pi.registerCommand(FORK_COMMAND, {
				description: "Fork this session at an entry of its tree",
				handler: async (args, ctx) => {
					settled(await ctx.fork(entryId(args), { position: "at" }));
				},
			});
		},
	};
}
