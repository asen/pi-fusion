/**
 * What `pi-bootstrap-protocol.mjs` exports, declared so a TypeScript caller and a test can use it without the module
 * itself needing a loader: the file stays plain ESM, and this is the only place these two are typed. They keep the
 * loose types the host has always read them as, a number and a string rather than the literals, so no caller narrows
 * on a value that belongs to the protocol rather than to the code reading it.
 */

/** What the process exits with when it could not start at all: a configuration failure, in sysexits terms. */
export declare const STARTUP_EXIT_CODE: number;

/** How a diagnostic line says who wrote it, so a transport reading stderr can tell it from a child's own output. */
export declare const DIAGNOSTIC_EVENT: string;
