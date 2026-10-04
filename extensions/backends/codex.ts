import { readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OwnedCleanup } from "../process-tree.ts";
import type { CodexRole } from "./codex-binding.ts";
import { type CodexLaunch, type CodexLaunchRequest, codexLaunch } from "./codex-launch.ts";
import {
	CODEX_FRESH_ONLY,
	type CodexEnding,
	type CodexRun,
	type CodexSession,
	type CodexStage,
	type CodexVerdict,
	CWD_READ_MISMATCH,
	codexFeed,
	codexSession,
	finishCodexRun,
	HOME_MISMATCH,
	NO_FINAL,
	NO_USAGE,
	newCodexRun,
	RUN_ABORTED,
	RUN_UNVERIFIED,
	TERMINAL_ERROR,
	threadStartProblem,
	turnFailure,
	verifySelection,
} from "./codex-outcome.ts";
import type { CodexThreadStart } from "./codex-protocol.ts";
import { type CodexBounds, type CodexChild, type CodexChildOptions, type CodexClientInfo, CODEX_CLIENT_INFO, CodexTransportError, type CodexTurnEvidence, startCodexChild } from "./codex-transport.ts";
import { type Backend, type ChildControl, type ChildEvent, failed, type RunRequest } from "./types.ts";

/**
 * One fresh Codex call composed out of the parts that already exist: the role binding, the launch, the transport and
 * the outcome mapping. It decides the order and owns the child between its start and its one shutdown; every
 * judgement of evidence is `codex-outcome.ts`'s, and every wire and process concern the transport's.
 *
 * **Experimental and unqualified.** Every shape this reads is a source reading of Codex 0.160.0's app-server, exercised
 * here only against `test/fake-codex.mjs`. Nothing registers this backend in this build: `createCodexBackend` is a
 * factory nobody in the host calls yet, so importing this module starts, locates and reads nothing.
 *
 * **The order.** A cancelled signal ends the call before anything is read. Then the contract and its addendum, the
 * launch — the host's own cwd and inherited environment, the binary located only now — and the client's version, and
 * only then a child: spawn, `initialize`, `initialized`. The home the child reports must be the one the launch predicted.
 * One `thread/start` names the role's sandbox mode, approval `never`, the role's instructions and only the model and
 * provider the call named; its answer must name a thread, this run's working directory, the requested sandbox and a
 * model and provider, the named ones exactly. One `turn/start` carries the prompt and only an effort the call named.
 * The turn's own scoped end is what ends it; a `thread/read` after it is the barrier late usage lands before, and its
 * answer is where the configured selection is verified. Then the child's one shutdown, and the mapping.
 *
 * **One stop.** The composition calls `shutdown` exactly once on the child it was handed, on every path after the start
 * resolved; a cancellation or a transport failure that already finalized the child makes that call the same memoized
 * finalization rather than a second one. Nothing above the mapping writes a cleanup sentence of its own.
 *
 * **What it never does.** No request names a cwd, a configuration map, base instructions, dynamic tools, or an effort
 * on thread/start; no turn/start names a model, provider, cwd or sandbox policy. Fusion writes no trust entry,
 * configuration or auth file: what the child inherits — the host's Codex home, configuration, MCP servers, multi-agent
 * features — is the host's, and nothing here isolates a run from it.
 */

/** Contracts sit beside the extension, two directories up, where the other backends read theirs from. */
export const CODEX_CONTRACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts");

/** This package's own manifest, read for the client version the handshake names, and only when a run asks for it. */
const PACKAGE_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

/** What a caller is told when this install's own contract file could not be read. The value is kept as the cause. */
export const CONTRACT_UNREADABLE = "the codex backend could not read the contract for this role";

/** The version a handshake names when this package's manifest cannot be read: a fallback, never a load failure. */
export const CODEX_CLIENT_VERSION_UNKNOWN = "unknown";

/**
 * The client this build says it is: the transport's name and title with this package's own version, read from its
 * manifest when a run is about to start. A manifest that cannot be read gives the fixed fallback rather than failing.
 */
export function codexClientInfo(manifest: string = PACKAGE_JSON): CodexClientInfo {
	let version = CODEX_CLIENT_VERSION_UNKNOWN;
	try {
		const data = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
		if (typeof data.version === "string" && data.version.trim() !== "") version = data.version.trim();
	} catch {}
	return { name: CODEX_CLIENT_INFO.name, version, ...(CODEX_CLIENT_INFO.title === undefined ? {} : { title: CODEX_CLIENT_INFO.title }) };
}

/** Where one call stopped, for a test and nothing else. */
export type CodexCallStage = "aborted-before-start" | "contract" | "launch" | "start-rejected" | "startup" | CodexStage | "done";

/**
 * What one call did, handed to `onCall` and never to a user, a record or a card. `shutdowns` counts this composition's
 * own calls of the child's shutdown, which is exactly one on every path where a child was handed over.
 */
export interface CodexCallReport {
	stage: CodexCallStage;
	launchCalled: boolean;
	startCalled: boolean;
	startResolved: boolean;
	shutdowns: number;
	thrown?: { error: unknown };
}

/**
 * The seams one backend is built with, all internal: production leaves them unset and gets the contract files, the
 * real launch over this process's environment, the transport's own start and this package's version. Each default is
 * reached only when a run is requested.
 */
export interface CodexBackendDeps {
	readContract?: (name: string) => string;
	env?: NodeJS.ProcessEnv;
	launch?: (request: CodexLaunchRequest) => CodexLaunch;
	start?: (options: CodexChildOptions) => Promise<CodexChild>;
	cleanup?: OwnedCleanup;
	bounds?: Partial<CodexBounds>;
	clientInfo?: () => CodexClientInfo;
	now?: () => number;
	onCall?: (report: CodexCallReport) => void;
}

const readRoleContract = (name: string): string => readFileSync(path.join(CODEX_CONTRACTS_DIR, name), "utf8");

/** A realpath where there is something to resolve and otherwise the normalized path: both sides of a compare go through it. */
const canonical = (file: string): string => {
	try {
		return realpathSync.native(file);
	} catch {
		return path.normalize(file);
	}
};

/** A Codex child takes no steer: its input is closed from the start, and pushing to it is refused. */
const closedControl = (): ChildControl => ({ open: false, push: () => false, end: () => {} });

/** What driving the child settled, before its one shutdown. */
interface Driven {
	verdict: CodexVerdict;
	thread?: string;
	evidence?: CodexTurnEvidence;
}

async function runCodexCall(request: RunRequest<CodexRole, CodexSession, ChildControl>, deps: CodexBackendDeps): Promise<CodexRun> {
	const now = deps.now ?? Date.now;
	const started = now();
	const role = request.role;
	const run = newCodexRun(role);
	const report: CodexCallReport = { stage: "aborted-before-start", launchCalled: false, startCalled: false, startResolved: false, shutdowns: 0 };
	const cancelled = (): boolean => request.signal?.aborted === true;

	const progress = (): void => {
		try {
			request.onProgress(run);
		} catch {}
	};
	const emit = (event: ChildEvent): void => {
		try {
			request.onEvent?.(event);
		} catch {}
	};
	const feed = codexFeed(run, { progress, event: emit });

	/** The one way a call with a run to report ends: the mapping, its own terminal event and one last progress. */
	const finalize = (ending: CodexEnding): CodexRun => {
		feed.end();
		const final = finishCodexRun(run, ending, now() - started);
		emit({ type: "turn_result", ok: !failed(final), ...(final.errorMessage === undefined ? {} : { message: final.errorMessage }) });
		progress();
		return final;
	};

	try {
		// Refused before anything is read or located: a fresh thread is the only session this build runs.
		if (request.session !== undefined && request.session.kind !== "new") throw new Error(CODEX_FRESH_ONLY);
		if (cancelled()) return finalize({ kind: "none" });

		let instructions: string;
		try {
			const read = deps.readContract ?? readRoleContract;
			instructions = `${read(role.contract).trimEnd()}\n\n${read(role.addendum).trim()}\n`;
		} catch (error) {
			report.stage = "contract";
			report.thrown = { error };
			throw new Error(CONTRACT_UNREADABLE, { cause: error });
		}

		let prepared: CodexLaunch;
		try {
			report.launchCalled = true;
			prepared = (deps.launch ?? codexLaunch)({ cwd: request.cwd, env: deps.env ?? process.env });
		} catch (error) {
			report.stage = "launch";
			report.thrown = { error };
			// Exactly as it came: the launch composes its own actionable sentence about the binary, the cwd or the home.
			throw error;
		}
		const clientInfo = (deps.clientInfo ?? codexClientInfo)();

		let child: CodexChild;
		try {
			report.startCalled = true;
			child = await (deps.start ?? startCodexChild)({
				launch: prepared.launch,
				clientInfo,
				onNotification: (notification) => feed.onNotification(notification),
				...(request.signal === undefined ? {} : { signal: request.signal }),
				...(request.killGraceMs === undefined ? {} : { killGraceMs: request.killGraceMs }),
				...(deps.cleanup === undefined ? {} : { cleanup: deps.cleanup }),
				...(deps.bounds === undefined ? {} : { bounds: deps.bounds }),
			});
		} catch (error) {
			report.thrown = { error };
			if (error instanceof CodexTransportError && error.finalExit !== undefined) {
				// The transport finished the child it never handed over and says how; nothing is stopped again from here.
				report.stage = "startup";
				const aborted = error.kind === "aborted" || cancelled();
				return finalize({ kind: "ended", verdict: { ok: false, stage: "startup", message: aborted ? RUN_ABORTED : error.message, aborted }, exit: error.finalExit, unverified: false });
			}
			// A start seam that threw without a report: a child may exist this host was never handed, so nothing is
			// stopped for it and nothing is claimed about it.
			report.stage = "start-rejected";
			return finalize({ kind: "ended", verdict: { ok: false, stage: "startup", message: RUN_UNVERIFIED, aborted: cancelled() }, unverified: true });
		}
		report.startResolved = true;

		let driven: Driven;
		try {
			driven = await drive(child, role, prepared, instructions, request, feed, run, { progress, emit, cancelled, report });
		} catch (error) {
			// Nothing in `drive` is meant to throw; a value that does is reported as what it is and the child still stopped once.
			report.thrown = { error };
			driven = { verdict: { ok: false, stage: report.stage === "done" ? "verify" : (report.stage as CodexStage), message: RUN_UNVERIFIED, aborted: cancelled() } };
		}

		let exit;
		let unverified = false;
		try {
			report.shutdowns += 1;
			exit = await child.shutdown(cancelled() ? "aborted" : "host");
		} catch (error) {
			report.thrown ??= { error };
			unverified = true;
		}
		return finalize({ kind: "ended", verdict: driven.verdict, ...(driven.thread === undefined ? {} : { thread: driven.thread }), ...(driven.evidence === undefined ? {} : { evidence: driven.evidence }), ...(exit === undefined ? {} : { exit }), unverified });
	} finally {
		feed.end();
		try {
			deps.onCall?.(report);
		} catch {}
	}
}

interface DriveContext {
	progress(): void;
	emit(event: ChildEvent): void;
	cancelled(): boolean;
	report: CodexCallReport;
}

/** A failure from a stage's own call: the transport's sentence, and a cancellation named as one whichever layer saw it. */
const failedWith = (stage: CodexStage, error: unknown, cancelled: boolean, evidence?: CodexTurnEvidence): Driven => {
	const kind = error instanceof CodexTransportError ? error.kind : undefined;
	const aborted = cancelled || kind === "aborted";
	const message = aborted ? RUN_ABORTED : error instanceof CodexTransportError ? error.message : RUN_UNVERIFIED;
	return { verdict: { ok: false, stage, message, aborted }, ...(evidence === undefined ? {} : { evidence }) };
};

/**
 * The handshake check, the thread, the turn and the readback, on a child the caller owns and stops. It returns what it
 * settled and never stops the child itself.
 */
async function drive(child: CodexChild, role: CodexRole, prepared: CodexLaunch, instructions: string, request: RunRequest<CodexRole, CodexSession, ChildControl>, feed: ReturnType<typeof codexFeed>, run: CodexRun, context: DriveContext): Promise<Driven> {
	const { report } = context;
	report.stage = "startup";
	if (canonical(child.initialize.codexHome) !== canonical(prepared.expectedCodexHome)) return { verdict: { ok: false, stage: "startup", message: HOME_MISMATCH, aborted: false } };

	report.stage = "thread";
	let start: CodexThreadStart;
	try {
		start = await child.startThread({
			...(role.model === undefined ? {} : { model: role.model }),
			...(role.provider === undefined ? {} : { modelProvider: role.provider }),
			sandbox: role.sandboxMode,
			approvalPolicy: role.approvalPolicy,
			developerInstructions: instructions,
		});
	} catch (error) {
		return failedWith("thread", error, context.cancelled());
	}
	const problem = threadStartProblem(role, start, canonical(start.cwd), canonical(prepared.expectedCwd));
	if (problem !== undefined) return { verdict: { ok: false, stage: "thread", message: problem, aborted: false } };
	const thread = start.threadId;
	feed.thread(thread);
	run.session = { backend: "codex", sessionId: thread };
	run.sessionId = thread;
	run.modelId = start.model;
	run.activity = "waiting for model";
	context.emit({ type: "init", sessionId: thread });
	context.progress();

	report.stage = "turn";
	let turn;
	try {
		turn = await child.startTurn({ threadId: thread, text: request.prompt, ...(role.effort === undefined ? {} : { effort: role.effort }) });
	} catch (error) {
		return { ...failedWith("turn", error, context.cancelled()), thread };
	}
	feed.turn(turn.turnId);
	const result = await turn.done;
	if (result.outcome !== "completed") {
		const { message, aborted } = turnFailure(result, context.cancelled());
		return { verdict: { ok: false, stage: "turn", message, aborted }, thread, evidence: turn.snapshot() };
	}
	if (result.terminalErrors > 0) return { verdict: { ok: false, stage: "turn", message: TERMINAL_ERROR, aborted: false }, thread, evidence: turn.snapshot() };

	report.stage = "verify";
	run.activity = "verifying";
	context.progress();
	let read;
	try {
		// The barrier: the child's notifications ahead of this answer, late usage among them, are applied before it.
		read = await child.readThread(thread);
	} catch (error) {
		return { ...failedWith("verify", error, context.cancelled(), turn.snapshot()), thread };
	}
	const evidence = turn.snapshot();
	const fail = (message: string): Driven => ({ verdict: { ok: false, stage: "verify", message, aborted: false }, thread, evidence });
	const final = evidence.finalMessage;
	if (final === undefined || final.text.trim() === "") return fail(NO_FINAL);
	if (evidence.usage === undefined) return fail(NO_USAGE);
	if (canonical(read.cwd) !== canonical(prepared.expectedCwd)) return fail(CWD_READ_MISMATCH);
	const verified = verifySelection(role, start, read, evidence);
	if (!verified.ok) return fail(verified.message);
	report.stage = "done";
	return { verdict: { ok: true, text: final.text, cut: final.cut, selection: verified.selection, notes: verified.notes }, thread, evidence };
}

/**
 * A Codex backend over these seams. A factory rather than an instance, because a module-level one would be a backend
 * nobody decided to build; constructing one reads, locates and starts nothing.
 */
export function createCodexBackend(deps: CodexBackendDeps = {}): Backend<CodexRole, CodexSession, ChildControl> {
	return {
		name: "codex",
		control: closedControl,
		session: codexSession,
		run: (request) => runCodexCall(request, deps),
	};
}
