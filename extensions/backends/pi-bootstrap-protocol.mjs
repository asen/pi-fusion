/**
 * The two facts both ends of a Pi child's wire agree on, and nothing else: the exit code a startup refusal uses, and
 * the marker a bootstrap diagnostic carries. They are a protocol between `./pi-bootstrap.mjs`, which writes them in
 * the child, and `./pi-transport.ts`, which reads them in the host, so they live in one file both of them may have.
 *
 * It imports nothing, holds nothing but these two literals and runs nothing at load, and what that buys is one thing
 * exactly: the host no longer depends on the child's entry module and never evaluates it, so an install missing that
 * program gets `fusion()`'s own fixed existence refusal instead of a module-resolution error of the host's before the
 * loader could name it. It is no claim about what the split keeps out of this process — the host imports
 * `./pi-control-extension.mjs` and `./pi-question-tool.mjs` anyway, through `./pi-session-restore.ts` and
 * `./pi-launch.ts`, so beyond those the only module this spares the host is the child-only `./pi-helper-retry.mjs`,
 * and the public SDK is loaded inside the child's own program when that program runs. Plain ESM for the same reason
 * the bootstrap is: node runs that file directly, with no loader and no TypeScript step.
 */

/** What the process exits with when it could not start at all: a configuration failure, in sysexits terms. */
export const STARTUP_EXIT_CODE = 78;

/** How a diagnostic line says who wrote it, so a transport reading stderr can tell it from a child's own output. */
export const DIAGNOSTIC_EVENT = "pi-fusion-bootstrap";
