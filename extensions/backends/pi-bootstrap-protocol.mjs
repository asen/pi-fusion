/**
 * The facts both ends of a Pi child's wire agree on, and nothing else: the exit code a startup refusal uses, the
 * marker a bootstrap diagnostic carries, and the fixed words a compaction line may say. They are a protocol between
 * `./pi-bootstrap.mjs`, which writes them in the child, and `./pi-transport.ts`, which reads them in the host, so they
 * live in one file both of them may have.
 *
 * It imports nothing, holds nothing but these literals and runs nothing at load, and what that buys is one thing
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

/**
 * What a compaction line, `{ event: DIAGNOSTIC_EVENT, compaction }`, may say about a call's requested compaction, and
 * all it may say: `applied` set the earlier reserve, `native` found Pi's own reserve already at least as early, and the
 * rest are why nothing was set — a virtual model whose requests route to other windows, a model with no usable
 * window, a settings api that is missing or answered something else, and a target at or below what compaction keeps.
 * A word, never prose, so nothing the child or its SDK says reaches the host through it.
 */
export const COMPACTION_CODES = ["applied", "native", "virtual", "window", "api", "low"];
