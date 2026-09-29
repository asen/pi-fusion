import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

/**
 * The child process a backend's transport runs on, and the descendant termination that cancelling a run needs. No
 * backend's SDK types reach this module: a backend translates its own launch shape into the ones below.
 *
 * Two cleanups live here. The one the Claude backend has always used signals the child's group and every group a
 * scan happens to find, remembers bare pids, and returns as soon as the child closes. The other is the portable
 * best-effort cleanup a caller opts into by passing an `OwnedCleanup`: it observes the tree while it is still
 * observable, proves a descendant's identity against a fresh process table before every signal, skips what it
 * cannot prove, bounds every wait against one deadline and reports what it did. Nothing in the opt-in path runs for
 * a caller that does not ask for it, so the Claude lifecycle and its signalling stay exactly what they were.
 */

/** How long a killed process tree has to exit on SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 5_000;
/** How long a child that has been told to shut down has to close on its own before it is killed. */
const EXIT_GRACE_MS = 2_000;
/** How long the root has to exit after it was forced, before the cleanup reports it unstoppable. */
const STOP_GRACE_MS = 2_000;
/** How long a forced leftover descendant has to go before the cleanup verifies the survivors one last time. */
const LEFTOVER_GRACE_MS = 1_000;
/** How long the child's pipes have to close after it exited, before a descendant holding them is reported instead. */
const PIPE_GRACE_MS = 1_000;
/** How long one read of the process table has to answer before discovery counts as unavailable. */
const TABLE_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<undefined> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		timer.unref();
	});

/**
 * The opt-in cleanup's own bounded wait. Its timer stays referenced until it fires or is cleared, because a caller
 * awaiting a shutdown is the only thing left running once the child is gone: an unreferenced timer would let a
 * standalone process exit with the cleanup half done. Bounded and cleared is what keeps it from leaking.
 */
const rest = (ms: number): Promise<undefined> =>
	new Promise((resolve) => {
		setTimeout(() => resolve(undefined), Math.max(0, ms));
	});

/** The result of a wait that ran out of time, kept distinct from any value the work itself could resolve to. */
const TIMED_OUT = Symbol("timed out");

/**
 * Races work against a bound. A reader that never answers, or answers after the bound, cannot hold a cleanup up or
 * reach it late: the caller sees `TIMED_OUT` and the late value is dropped where it cannot be merged or signalled.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
	let timer: NodeJS.Timeout | undefined;
	const bound = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
	});
	try {
		const answered = work.catch((): typeof TIMED_OUT => TIMED_OUT);
		return await Promise.race([answered, bound]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** What a child process is launched with. Kept free of any backend's own types, so both backends pass their own. */
export interface LaunchOptions {
	command: string;
	args: string[];
	cwd?: string;
	env: { [key: string]: string | undefined };
}

/**
 * The launched process as its caller drives it: the shape a backend's transport takes over the process it spawns.
 * `stderr` is present only for a tree whose caller asked for the streaming mode: it is the child's own raw pipe, and
 * reading it — the decoding, the framing and whatever bound its diagnostics are kept under — is that caller's.
 *
 * What the caller takes over is the reading alone; the pipe's lifetime stays this module's. An owned cleanup destroys
 * the stdio it still holds once its pipe grace is up, and a destroyed pipe arrives as a `close` with no `end` before
 * it. So a caller consumes continuously, from the spawn through the shutdown, and treats whichever of the two it gets
 * as the last it will ever see: draining only once the shutdown is over is how the bytes are lost.
 */
export interface LaunchedProcess {
	stdin: Writable;
	stdout: Readable;
	stderr?: Readable;
	readonly killed: boolean;
	readonly exitCode: number | null;
	readonly signalCode?: NodeJS.Signals | null;
	kill(signal: NodeJS.Signals): boolean;
	on(event: "exit" | "error", listener: (...args: any[]) => void): void;
	once(event: "exit" | "error", listener: (...args: any[]) => void): void;
	off(event: "exit" | "error", listener: (...args: any[]) => void): void;
}

/**
 * One row of the platform's process table, as much of a process's identity as a portable reader can see. `started`
 * is the platform's own birth stamp, kept as the platform wrote it, so it fingerprints a pid: a pid whose stamp
 * changed is another process. Windows has no process groups and no state column, so `pgid` is 0 and `state` empty.
 */
export interface ObservedProcess {
	pid: number;
	ppid: number;
	pgid: number;
	state: string;
	started: string;
}

/**
 * The two platform facilities the opt-in cleanup uses. A narrow seam, so a test can drive the real reader and the
 * real sends and still fault-inject one of them; production is `productionFacilities`.
 */
export interface ProcessFacilities {
	/**
	 * The whole process table, or undefined when the platform would not answer: unavailable, never a guess. The
	 * budget is what the caller has left for this read, so a reader that runs a subprocess can cap it there instead
	 * of leaving it running behind a wait that has already given up on it.
	 */
	table(budgetMs?: number): Promise<ObservedProcess[] | undefined>;
	/** Sends one signal to one target: a pid, or a negative process group. Throws what the platform throws. */
	signal(target: number, signal: NodeJS.Signals): void;
}

/**
 * What a caller opts into, and the only way any of it runs. The graces are what each phase of a shutdown waits, and
 * `deadlineMs` bounds the whole of it however the phases go; the facilities are a test seam, not a user knob, which
 * is why no environment variable or configuration reaches them.
 */
export interface OwnedCleanup {
	exitGraceMs?: number;
	stopGraceMs?: number;
	leftoverGraceMs?: number;
	pipeGraceMs?: number;
	tableTimeoutMs?: number;
	deadlineMs?: number;
	facilities?: ProcessFacilities;
}

interface OwnedSettings extends Required<Omit<OwnedCleanup, "facilities">> {
	facilities: ProcessFacilities;
}

/**
 * Who reads the child's stderr, and the whole of the second opt-in. `collect`, the default, is what this module has
 * always done: the pipe is decoded as utf8 into `ChildTree.stderr` and no handle exposes it. `stream` hands the raw
 * pipe to the caller and reads nothing itself, because a transport that frames its own diagnostics has to own every
 * byte and the bound it keeps them under. Reading is all it hands over, and `LaunchedProcess.stderr` says what that
 * leaves here. An internal seam like the facilities are: no user, environment variable or tool argument reaches it.
 */
export interface LaunchIo {
	stderr?: "collect" | "stream";
}

/**
 * What one cleanup did, truthfully. `terminated` is a descendant this signalled and then verified gone or dead;
 * `leftovers` is one verified still alive, the diagnostic warning the policy allows; `skipped` is one whose identity
 * could not be proved at a later send or check, which may well have taken an earlier verified signal. A root that
 * could not be stopped is `unstoppable`, an error rather than a clean success, and a process nothing ever discovered
 * is in none of the lists.
 */
export interface CleanupReport {
	root: "unspawned" | "exited" | "stopped" | "unstoppable";
	exit: ExitOutcome;
	stdio: "closed" | "held";
	discovery: "ok" | "unavailable";
	terminated: ObservedProcess[];
	leftovers: ObservedProcess[];
	skipped: ObservedProcess[];
	deadlineHit: boolean;
}

/** The root as a signal target: enough of a `ChildProcess` to send through its own handle while it is unreaped. */
export interface SignalHandle {
	pid?: number | undefined;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill(signal: NodeJS.Signals): boolean;
}

const execFileAsync = promisify(execFile);
const TABLE_BUFFER = 16 * 1024 * 1024;

/** Windows has no `ps`. CIM answers the same three columns, the birth stamp as the file time its own API returns. */
const WINDOWS_TABLE_COMMAND =
	"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Created';Expression={ if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' } }} | ConvertTo-Csv -NoTypeInformation";

/**
 * Reads the platform's process table. A command that fails, times out, or answers something this cannot parse into
 * a single row is unavailable rather than an empty tree, because an empty tree would read as "no descendants" and
 * licence a blind signal. The timeout is the subprocess's own cap, forced rather than requested, so a read nobody is
 * waiting for any more stops costing something; the handle still closes asynchronously after that signal.
 */
export async function readProcessTable(timeoutMs: number = TABLE_TIMEOUT_MS): Promise<ObservedProcess[] | undefined> {
	try {
		if (process.platform === "win32") {
			const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_COMMAND], {
				encoding: "utf8",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: TABLE_BUFFER,
				windowsHide: true,
			});
			const rows = parseWindowsProcessTable(stdout);
			return rows.length ? rows : undefined;
		}
		const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
			encoding: "utf8",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			maxBuffer: TABLE_BUFFER,
			env: { ...process.env, LC_ALL: "C" },
		});
		const rows = parseUnixProcessTable(stdout);
		return rows.length ? rows : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Production facilities. The root's own per-pid send goes through the handle that spawned it where one is given, so
 * node still owns the pid it is waiting on; every other target is a pid or a group only `process.kill` can reach.
 */
export function productionFacilities(root?: () => SignalHandle | undefined, timeoutMs: number = TABLE_TIMEOUT_MS): ProcessFacilities {
	return {
		// Whichever is shorter: the reader's own ceiling, or what the caller says is left of its deadline.
		table: (budgetMs?: number) => readProcessTable(budgetMs === undefined ? timeoutMs : Math.min(timeoutMs, budgetMs)),
		signal: (target: number, signal: NodeJS.Signals) => {
			const handle = root?.();
			if (handle?.pid !== undefined && target === handle.pid) {
				// A handle that refuses the signal delivered nothing, and a send that did nothing is not a send.
				if (!handle.kill(signal)) throw new Error(`process ${target} did not take ${signal}`);
				return;
			}
			process.kill(target, signal);
		},
	};
}

/** `ps` reports a reaped-but-unwaited process as a zombie. It is dead: it takes no signal and is no leftover. */
export const isDeadState = (state: string): boolean => state.startsWith("Z");

/** A birth stamp the platform writes as a number orders two rows; `ps`'s own date string does not, and says so. */
const bornBefore = (child: ObservedProcess, parent: ObservedProcess): boolean => {
	const born = Number(child.started);
	const parentBorn = Number(parent.started);
	if (!child.started || !parent.started || !Number.isFinite(born) || !Number.isFinite(parentBorn)) return false;
	return born < parentBorn;
};

/**
 * Walks a table from a root pid. A parent row has to be in the table for its edge to count, and a child older than
 * its own parent is left out: Windows reuses a pid and leaves the stale number in a live process's parent field, so
 * an unrelated process would otherwise be walked in as a descendant.
 */
export function descendantsFrom(table: ObservedProcess[], root: number): ObservedProcess[] {
	const byPid = new Map<number, ObservedProcess>();
	const byParent = new Map<number, ObservedProcess[]>();
	for (const row of table) {
		byPid.set(row.pid, row);
		byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
	}
	const found: ObservedProcess[] = [];
	const seen = new Set<number>([root]);
	const queue = [root];
	while (queue.length) {
		const parentPid = queue.shift()!;
		const parent = byPid.get(parentPid);
		if (!parent) continue;
		for (const child of byParent.get(parentPid) ?? []) {
			if (child.pid <= 1 || child.pid === parentPid || seen.has(child.pid)) continue;
			if (bornBefore(child, parent)) continue;
			seen.add(child.pid);
			found.push(child);
			queue.push(child.pid);
		}
	}
	return found;
}

/** Reads `ps -A -o pid=,ppid=,pgid=,stat=,lstart=`: three numbers, the state, and the rest of the line as the stamp. */
export function parseUnixProcessTable(text: string): ObservedProcess[] {
	const rows: ObservedProcess[] = [];
	for (const line of text.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5) continue;
		const [pidText, ppidText, pgidText, state, ...started] = fields;
		const pid = Number(pidText);
		const ppid = Number(ppidText);
		const pgid = Number(pgidText);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(pgid) || pgid < 0) continue;
		if (!/^[A-Za-z]/.test(state)) continue;
		rows.push({ pid, ppid, pgid, state, started: started.join(" ") });
	}
	return rows;
}

/** One CSV record as PowerShell writes it: every field quoted, a quote inside a field doubled. */
function parseCsvRow(line: string): string[] {
	const fields: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quoted) {
			if (char !== '"') field += char;
			else if (line[index + 1] === '"') {
				field += '"';
				index++;
			} else quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === ",") {
			fields.push(field);
			field = "";
		} else field += char;
	}
	fields.push(field);
	return fields;
}

/**
 * Reads the CIM table. A row whose creation stamp is empty stays in the table but carries no identity, so the
 * cleanup can see it and still refuse to signal it: a protected process this host may not read is not a target.
 */
export function parseWindowsProcessTable(text: string): ObservedProcess[] {
	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#TYPE"));
	if (!lines.length) return [];
	const header = parseCsvRow(lines[0]).map((name) => name.trim().toLowerCase());
	const pidAt = header.indexOf("processid");
	const ppidAt = header.indexOf("parentprocessid");
	const startedAt = header.indexOf("created");
	if (pidAt === -1 || ppidAt === -1 || startedAt === -1) return [];
	const rows: ObservedProcess[] = [];
	for (const line of lines.slice(1)) {
		const fields = parseCsvRow(line);
		const pid = Number(fields[pidAt]?.trim());
		const ppidText = fields[ppidAt]?.trim() ?? "";
		const ppid = ppidText === "" ? 0 : Number(ppidText);
		if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
		rows.push({ pid, ppid, pgid: 0, state: "", started: fields[startedAt]?.trim() ?? "" });
	}
	return rows;
}

export interface ExitOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
}

function descendantsOf(root: number): { pids: number[]; groups: number[] } {
	let table: string;
	try {
		table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5_000 });
	} catch {
		return { pids: [], groups: [] };
	}
	const children = new Map<number, number[]>();
	const groupOf = new Map<number, number>();
	for (const line of table.split("\n")) {
		const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
		if (!pid || !ppid) continue;
		groupOf.set(pid, pgid ?? 0);
		children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const pids: number[] = [];
	const queue = [root];
	while (queue.length) {
		for (const child of children.get(queue.shift()!) ?? []) {
			pids.push(child);
			queue.push(child);
		}
	}
	const groups = [...new Set(pids.map((pid) => groupOf.get(pid)).filter((group): group is number => !!group && group !== root))];
	return { pids, groups };
}
/**
 * Spawns a child process for a backend's transport and owns its process tree. A backend's own shutdown, when it
 * has one, signals the child alone: Claude Code's SDK sends SIGTERM 2 s after an abort and SIGKILL 5 s after that.
 * This sends SIGTERM at once to the child's process group and to the groups of every descendant, then SIGKILL
 * after the grace period, so a Bash command the child started dies with it.
 *
 * A caller that passes an `OwnedCleanup` gets the portable best-effort cleanup instead: `observe` and `shutdown`,
 * and identity-proved signalling under `kill`, `spawn().kill` and `exited`. A caller that passes nothing gets what
 * it always got, down to the signals and their order, and `observe` and `shutdown` refuse it.
 *
 * The two opt-ins are independent and neither implies the other: an `OwnedCleanup` decides how the tree is ended, a
 * `LaunchIo` decides who reads the child's stderr, and a caller takes either, both or neither. A caller that takes
 * neither is the Claude lifecycle, which is why both default to exactly what this module did before they existed.
 */
export class ChildTree {
	command = "";
	stderr = "";
	spawnError?: Error;
	private proc?: ChildProcess;
	private closed?: Promise<ExitOutcome>;
	/*
	 * The root's exit and its close are two events, and the opt-in cleanup needs both: a descendant that inherited
	 * the child's pipes holds the close open long after the child is gone, and a dead root would read as unstoppable.
	 */
	private ended?: Promise<ExitOutcome>;
	private exitSeen?: ExitOutcome;
	private killTimer?: NodeJS.Timeout;
	/*
	 * Descendants can sit in their own process groups. They are remembered across calls because once the child is
	 * dead they are re-parented and a later scan from the child's pid no longer finds them.
	 */
	private readonly known = { pids: new Set<number>(), groups: new Set<number>() };
	private readonly sent = new Set<NodeJS.Signals>();
	private readonly killGraceMs: number;
	private readonly owned?: OwnedSettings;
	/* Who reads stderr, fixed at construction: the pipe is set up the moment the child is spawned, once and for all. */
	private readonly streamStderr: boolean;
	/* What production discovery found, each at the identity it was first seen with, so a changed identity shows up. */
	private readonly targets = new Map<number, ObservedProcess>();
	private readonly signalled = new Map<number, { term?: number; kill?: number }>();
	private readonly unproved = new Map<number, ObservedProcess>();
	private rootIdentity?: ObservedProcess;
	private rootSignalled = false;
	private discoveryFailed = false;
	private deadline = Number.POSITIVE_INFINITY;
	private deadlineHit = false;
	private reported = false;
	private finished?: Promise<CleanupReport>;
	private killRequestedAt?: number;
	/* A bounded diagnostic, not a report field: how often node said it could not deliver a signal, and what it said. */
	private readonly signalFailures: { count: number; last?: string } = { count: 0 };

	constructor(killGraceMs: number, cleanup?: OwnedCleanup, io?: LaunchIo) {
		this.killGraceMs = killGraceMs;
		this.streamStderr = io?.stderr === "stream";
		if (!cleanup) return;
		const exitGraceMs = cleanup.exitGraceMs ?? EXIT_GRACE_MS;
		const stopGraceMs = cleanup.stopGraceMs ?? STOP_GRACE_MS;
		const leftoverGraceMs = cleanup.leftoverGraceMs ?? LEFTOVER_GRACE_MS;
		const pipeGraceMs = cleanup.pipeGraceMs ?? PIPE_GRACE_MS;
		const tableTimeoutMs = cleanup.tableTimeoutMs ?? TABLE_TIMEOUT_MS;
		this.owned = {
			exitGraceMs,
			stopGraceMs,
			leftoverGraceMs,
			pipeGraceMs,
			tableTimeoutMs,
			deadlineMs: cleanup.deadlineMs ?? exitGraceMs + stopGraceMs + leftoverGraceMs + pipeGraceMs + tableTimeoutMs + killGraceMs,
			facilities: cleanup.facilities ?? productionFacilities(() => this.proc, tableTimeoutMs),
		};
	}

	spawn(options: LaunchOptions): LaunchedProcess {
		this.command = options.command;
		const proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		this.proc = proc;
		proc.stdin?.on("error", () => {});
		// In the streaming mode nothing here touches the pipe: an encoding or a `data` listener installed by this tree
		// would decode the caller's bytes for it and consume the stream before the caller ever asked for it.
		if (!this.streamStderr) {
			proc.stderr?.setEncoding("utf8");
			proc.stderr?.on("data", (data: string) => {
				this.stderr += data;
			});
		}
		if (this.owned) {
			/*
			 * The opt-in cleanup waits on the exit itself, and only on that. A close waits for pipes a descendant may
			 * hold open, and node emits `error` for a signal it could not deliver as much as for a spawn that never
			 * happened: taking either for an exit would read a live root as cleanly gone and call off its escalation.
			 * The error listener stays attached, because a second `error` with none left is a crash, and it tells the
			 * two apart by the pid: a root that never got one never started.
			 */
			this.closed = new Promise<ExitOutcome>((resolve) => {
				proc.on("error", (err) => {
					const error = err instanceof Error ? err : new Error(String(err));
					if (proc.pid === undefined) {
						this.spawnError ??= error;
						resolve({ code: null, signal: null });
						return;
					}
					this.signalFailures.count += 1;
					this.signalFailures.last = error.message;
				});
				proc.once("close", (code, signal) => resolve({ code, signal }));
			});
			this.ended = new Promise<ExitOutcome>((resolve) => {
				proc.once("exit", (code, signal) => {
					this.exitSeen = { code, signal };
					resolve(this.exitSeen);
				});
			});
			return this.handleOf(proc);
		}
		this.closed = new Promise<ExitOutcome>((resolve) => {
			proc.once("error", (err) => {
				this.spawnError = err instanceof Error ? err : new Error(String(err));
				resolve({ code: null, signal: null });
			});
			proc.once("close", (code, signal) => resolve({ code, signal }));
		});
		return this.handleOf(proc);
	}

	/**
	 * The launched process as its caller drives it. The same handle whichever cleanup this tree was given, and the
	 * same one on either spawn path; `stderr` is on it only in the streaming mode, so a collecting caller's handle
	 * carries no such key at all and nothing downstream can read one off it by accident.
	 */
	private handleOf(proc: ChildProcess): LaunchedProcess {
		const handle: LaunchedProcess = {
			stdin: proc.stdin!,
			stdout: proc.stdout!,
			get killed() {
				return proc.killed;
			},
			get exitCode() {
				return proc.exitCode;
			},
			get signalCode() {
				return proc.signalCode;
			},
			kill: (signal: NodeJS.Signals) => {
				this.signalTree(signal);
				return true;
			},
			on: (event: "exit" | "error", listener: (...args: any[]) => void) => {
				proc.on(event, listener);
			},
			once: (event: "exit" | "error", listener: (...args: any[]) => void) => {
				proc.once(event, listener);
			},
			off: (event: "exit" | "error", listener: (...args: any[]) => void) => {
				proc.off(event, listener);
			},
		};
		if (this.streamStderr) handle.stderr = proc.stderr!;
		return handle;
	}

	get spawned(): boolean {
		return this.proc !== undefined;
	}

	/**
	 * What the platform refused for this tree, for a caller that wants to say so: node reports a signal it could not
	 * deliver as an `error` on the child, which is no exit and no spawn failure. The count and the last message are
	 * all that is kept, and nothing in the cleanup's own report is decided from them.
	 */
	get refusedSignals(): { count: number; last?: string } {
		return { ...this.signalFailures };
	}

	/** The root's pid while it has one, so a caller can name the tree it handed over without reaching for the handle. */
	get pid(): number | undefined {
		return this.proc?.pid;
	}

	/** True when the child died of a signal this sent, so of our own shutdown and not of anything that happened to it. */
	stoppedBy(exit: ExitOutcome): boolean {
		return exit.signal !== null && this.sent.has(exit.signal);
	}

	kill(): void {
		if (this.owned) {
			this.killRequestedAt ??= Date.now();
			void this.proveAndSignal("SIGTERM");
			if (this.killTimer || this.reported) return;
			// The escalation a shutdown absorbs: it cancels this timer and finishes the grace itself.
			this.killTimer = setTimeout(() => void this.proveAndSignal("SIGKILL"), this.killGraceMs);
			this.killTimer.unref();
			return;
		}
		this.signalTree("SIGTERM");
		if (this.killTimer) return;
		// Runs even after the child has closed: its descendants may still be shutting down.
		this.killTimer = setTimeout(() => this.signalTree("SIGKILL"), this.killGraceMs);
		this.killTimer.unref();
	}

	/** Waits for the child to close, giving it a moment to exit on its own before killing it. */
	async exited(): Promise<ExitOutcome> {
		if (!this.proc || !this.closed) return { code: null, signal: null };
		if (this.owned) return (await this.shutdown()).exit;
		const outcome = await Promise.race([this.closed, sleep(EXIT_GRACE_MS)]);
		if (outcome) return outcome;
		this.kill();
		return this.closed;
	}

	/**
	 * What production discovery can see of the run's descendants right now, remembered for the cleanup: a group a
	 * descendant left, and a grandchild whose own parent dies later, are only ever visible while the tree still is.
	 * Nothing samples in the background; a caller observes when it has a reason to.
	 */
	async observe(): Promise<ObservedProcess[]> {
		this.requireOwned("observe");
		if (!this.proc?.pid) return [];
		return (await this.survey()).found;
	}

	/**
	 * Ends the child and cleans up what it left, within one deadline. Called more than once it is the same shutdown:
	 * the report is decided once, and nothing signals or merges a snapshot after it.
	 */
	async shutdown(): Promise<CleanupReport> {
		const owned = this.requireOwned("shutdown");
		return (this.finished ??= this.runShutdown(owned));
	}

	private async runShutdown(owned: OwnedSettings): Promise<CleanupReport> {
		this.deadline = Date.now() + owned.deadlineMs;
		this.clearKillTimer();
		// A root with no pid never started. A post-spawn `error`, a kill the platform refused among them, is not that.
		if (!this.proc || this.proc.pid === undefined) return this.finalize("unspawned", { code: null, signal: null }, "closed", undefined);
		const proc = this.proc;

		// A. Clean up while the tree is observable, then let the child end on its own: its own exit is the good one.
		const opening = await this.survey();
		this.signalDescendants("SIGTERM", opening.table);
		try {
			proc.stdin?.end();
		} catch {}
		const killGraceLeft = this.killRequestedAt === undefined ? undefined : Math.max(0, this.killGraceMs - (Date.now() - this.killRequestedAt));
		let exit = await this.awaitEnd(killGraceLeft ?? owned.exitGraceMs);
		let root: CleanupReport["root"];

		// B. It did not end: stop the root itself, then force it. A root nothing could stop is not a clean success.
		if (exit) root = this.rootSignalled ? "stopped" : "exited";
		else {
			const stopping = await this.survey();
			this.signalRoot("SIGTERM", stopping.table);
			this.signalDescendants("SIGTERM", stopping.table);
			exit = await this.awaitEnd(this.killGraceMs);
			if (!exit) {
				const forcing = await this.survey();
				this.signalRoot("SIGKILL", forcing.table);
				this.signalDescendants("SIGKILL", forcing.table);
				exit = await this.awaitEnd(owned.stopGraceMs);
			}
			// It may still have ended on its own while all this was going out, and a send that failed stopped nothing.
			root = exit ? (this.rootSignalled ? "stopped" : "exited") : "unstoppable";
		}

		// C. What is left of the owned descendants, each verified again, forced only after its own grace, then listed.
		const last = await this.cleanUpLeftovers(owned);

		// The exit may land while the leftovers are being cleaned up. What the root did by the end is what is reported.
		if (!exit && this.exitSeen) {
			exit = this.exitSeen;
			root = this.rootSignalled ? "stopped" : "exited";
		}

		// D. The pipes: past the grace a descendant is holding them, and our own ends are ours to drop. A root still
		// running holds them itself, and its close, which an `error` can resolve on its own, says nothing about them.
		let stdio: "closed" | "held" = "closed";
		if (this.exitSeen === undefined || !(await this.awaitClose(owned.pipeGraceMs))) {
			stdio = "held";
			this.destroyStreams();
		}
		return this.finalize(root, exit ?? { code: null, signal: null }, stdio, last);
	}

	/**
	 * Escalates only against a fresh identity and only once the terminate grace has passed, then verifies once more.
	 * Whatever the last verification could prove is what the report lists; past the deadline it proves nothing and
	 * says so rather than reaching for a remembered pid.
	 */
	private async cleanUpLeftovers(owned: OwnedSettings): Promise<Map<number, ObservedProcess> | undefined> {
		const surveyed = await this.survey();
		if (!surveyed.table) return undefined;
		let grace = 0;
		for (const [pid, target] of this.targets) {
			if (this.verify(target, surveyed.table) !== "alive") continue;
			const sentAt = this.signalled.get(pid)?.term;
			if (sentAt !== undefined) grace = Math.max(grace, this.killGraceMs - (Date.now() - sentAt));
		}
		if (grace > 0) await this.pause(grace);
		const before = await this.survey();
		if (!before.table) return undefined;
		let forced = false;
		for (const [pid, target] of [...this.targets]) {
			const state = this.verify(target, before.table);
			if (state === "changed") {
				this.forget(pid, target);
				continue;
			}
			if (state !== "alive") continue;
			const sends = this.signalled.get(pid);
			if (sends?.term === undefined) {
				this.send(pid, "SIGTERM");
				continue;
			}
			if (sends.kill === undefined && this.send(pid, "SIGKILL")) forced = true;
		}
		if (forced) await this.pause(owned.leftoverGraceMs);
		return (await this.survey()).table;
	}

	/** Reads the table, bounded by its own timeout and by whatever is left of the deadline. */
	private async readTable(owned: OwnedSettings): Promise<ObservedProcess[] | undefined> {
		const budget = Math.min(owned.tableTimeoutMs, this.remaining());
		if (budget <= 0) {
			this.noteBound();
			this.discoveryFailed = true;
			return undefined;
		}
		let rows: ObservedProcess[] | typeof TIMED_OUT | undefined;
		try {
			rows = await within(owned.facilities.table(budget), budget);
		} catch {
			rows = undefined;
		}
		if (rows === TIMED_OUT) {
			this.noteBound();
			this.discoveryFailed = true;
			return undefined;
		}
		// A read that lands after the report, or after the deadline, is a late reader: nothing merges its rows.
		if (!rows) {
			this.discoveryFailed = true;
			return undefined;
		}
		if (this.reported) return undefined;
		if (this.remaining() <= 0) {
			this.noteBound();
			this.discoveryFailed = true;
			return undefined;
		}
		return rows;
	}

	/**
	 * One fresh view: the table by pid, and the descendants a walk from the root finds. A walk whose root exited
	 * while the read was in flight is discarded, because the pids under a dead root are re-parented or re-used.
	 */
	private async survey(): Promise<{ table?: Map<number, ObservedProcess>; found: ObservedProcess[] }> {
		const owned = this.owned!;
		const rows = await this.readTable(owned);
		if (!rows) return { found: [] };
		const table = new Map(rows.map((row) => [row.pid, row] as const));
		const pid = this.proc?.pid;
		if (pid === undefined) return { table, found: [] };
		const row = table.get(pid);
		if (!row || !this.alive() || !this.rootIs(row)) return { table, found: [] };
		this.rootIdentity ??= row;
		const found = descendantsFrom(rows, pid);
		for (const descendant of found) {
			if (this.unproved.has(descendant.pid)) continue;
			if (!this.targets.has(descendant.pid)) this.targets.set(descendant.pid, descendant);
		}
		return { table, found };
	}

	/** True while node still holds the root's pid: past its exit the number may belong to something else. */
	private alive(): boolean {
		return this.proc !== undefined && this.exitSeen === undefined && this.proc.exitCode === null && this.proc.signalCode === null;
	}

	private rootIs(row: ObservedProcess): boolean {
		return !this.rootIdentity || (row.pid === this.rootIdentity.pid && row.started === this.rootIdentity.started);
	}

	/** Whether a remembered descendant is still the process it was, and whether it is still worth a signal. */
	private verify(target: ObservedProcess, table: Map<number, ObservedProcess>): "alive" | "gone" | "dead" | "changed" {
		const row = table.get(target.pid);
		if (!row) return "gone";
		if (!row.started || row.started !== target.started || row.pgid !== target.pgid) return "changed";
		return isDeadState(row.state) ? "dead" : "alive";
	}

	private forget(pid: number, target: ObservedProcess): void {
		this.targets.delete(pid);
		this.unproved.set(pid, target);
	}

	/**
	 * Signals every remembered descendant a fresh table still proves, per pid, and per group for one that left the
	 * root's. Without a table nothing here may be signalled at all: a remembered pid on its own is not ownership.
	 */
	private signalDescendants(signal: NodeJS.Signals, table?: Map<number, ObservedProcess>): void {
		if (!table) return;
		const groups = new Set<number>();
		for (const [pid, target] of [...this.targets]) {
			const state = this.verify(target, table);
			if (state === "changed") {
				this.forget(pid, target);
				continue;
			}
			if (state !== "alive") continue;
			this.send(pid, signal);
			const row = table.get(pid)!;
			if (!this.rootGroups(table).has(row.pgid) && this.anchored(row.pgid, table)) groups.add(row.pgid);
		}
		for (const group of groups) this.send(-group, signal);
	}

	/**
	 * Signals the root, and its group only while the root is what is being stopped: the group holds the ordinary
	 * children too, and a shutdown that has not decided to stop the root has no business ending them through it.
	 */
	private signalRoot(signal: NodeJS.Signals, table?: Map<number, ObservedProcess>): void {
		const pid = this.proc?.pid;
		if (pid === undefined || !this.alive()) return;
		if (this.send(pid, signal)) {
			this.sent.add(signal);
			this.rootSignalled = true;
		}
		const row = table?.get(pid);
		if (!row || !this.rootIs(row) || isDeadState(row.state) || !this.anchored(row.pgid, table!)) return;
		if (this.send(-row.pgid, signal)) {
			this.sent.add(signal);
			this.rootSignalled = true;
		}
	}

	/**
	 * The groups that are the root's own, so a descendant-only send never reaches through one. The identity taken
	 * when the root was first seen counts as much as its current row: once the root exits its row is gone, and a
	 * group number that is no longer in the table is exactly the one a stale send would go to.
	 */
	private rootGroups(table: Map<number, ObservedProcess>): Set<number> {
		const groups = new Set<number>();
		const pid = this.proc?.pid;
		if (pid !== undefined) {
			groups.add(pid);
			const row = table.get(pid);
			if (row) groups.add(row.pgid);
		}
		if (this.rootIdentity) groups.add(this.rootIdentity.pgid);
		return groups;
	}

	/**
	 * A group may be signalled only through a live process of this run that is in it right now. A remembered
	 * negative pid, the host's own group, the host itself, and the kernel's groups are never targets.
	 */
	private anchored(pgid: number, table: Map<number, ObservedProcess>): boolean {
		if (process.platform === "win32") return false;
		if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === table.get(process.pid)?.pgid) return false;
		const rootPid = this.proc?.pid;
		for (const row of table.values()) {
			if (row.pgid !== pgid || isDeadState(row.state) || !row.started) continue;
			if (row.pid === rootPid && this.alive() && this.rootIs(row)) return true;
			const target = this.targets.get(row.pid);
			if (target && target.started === row.started && target.pgid === row.pgid) return true;
		}
		return false;
	}

	/** One send, fenced against the report. A target the platform says is gone was not signalled by us. */
	private send(target: number, signal: NodeJS.Signals): boolean {
		if (this.reported) return false;
		const isRoot = target > 0 && target === this.proc?.pid;
		if (isRoot && !this.alive()) return false;
		// Past the deadline the root's own termination is all that may still go out: no group, no remembered pid.
		if (!isRoot && this.remaining() <= 0) {
			this.noteBound();
			return false;
		}
		try {
			this.owned!.facilities.signal(target, signal);
		} catch {
			return false;
		}
		if (target > 0) {
			const sends = this.signalled.get(target) ?? {};
			if (signal === "SIGKILL") sends.kill ??= Date.now();
			else sends.term ??= Date.now();
			this.signalled.set(target, sends);
		}
		return true;
	}

	/** The opt-in tree signal: prove first, then send to the root and to what discovery can still account for. */
	private async proveAndSignal(signal: NodeJS.Signals): Promise<void> {
		if (this.reported) return;
		const surveyed = await this.survey();
		if (this.reported) return;
		this.signalRoot(signal, surveyed.table);
		this.signalDescendants(signal, surveyed.table);
	}

	private remaining(): number {
		return this.deadline - Date.now();
	}

	/**
	 * Records a wait or a read that stopped short only when the whole deadline is what stopped it. A phase a caller
	 * gave no grace of its own, or a kill grace already spent, bounds itself: neither is the deadline running out.
	 */
	private noteBound(): void {
		if (this.remaining() <= 0) this.deadlineHit = true;
	}

	private async pause(ms: number): Promise<void> {
		const budget = Math.min(ms, this.remaining());
		if (budget <= 0) {
			this.noteBound();
			return;
		}
		await rest(budget);
	}

	/** Waits for the root's exit, never longer than the deadline allows. */
	private async awaitEnd(ms: number): Promise<ExitOutcome | undefined> {
		if (!this.ended) return undefined;
		const budget = Math.min(ms, this.remaining());
		if (budget <= 0) {
			this.noteBound();
			return this.exitSeen;
		}
		const result = await within(this.ended, budget);
		if (result !== TIMED_OUT) return result;
		this.noteBound();
		return undefined;
	}

	private async awaitClose(ms: number): Promise<boolean> {
		const budget = Math.min(ms, this.remaining());
		if (budget <= 0) {
			this.noteBound();
			return false;
		}
		const result = await within(this.closed!, budget);
		if (result === TIMED_OUT) this.noteBound();
		return result !== TIMED_OUT;
	}

	private destroyStreams(): void {
		for (const stream of [this.proc?.stdin, this.proc?.stdout, this.proc?.stderr]) {
			try {
				stream?.destroy();
			} catch {}
		}
	}

	/**
	 * Closes the cleanup: the fence goes up, the timers go, and the lists are what the last verification proved.
	 * A descendant this signalled and then saw gone or dead is terminated; one still alive is a leftover; one whose
	 * identity no longer holds, or that nothing could verify at the end, is skipped, earlier signal and all.
	 */
	private finalize(root: CleanupReport["root"], exit: ExitOutcome, stdio: CleanupReport["stdio"], table?: Map<number, ObservedProcess>): CleanupReport {
		this.reported = true;
		this.clearKillTimer();
		if (this.remaining() <= 0) this.deadlineHit = true;
		const terminated: ObservedProcess[] = [];
		const leftovers: ObservedProcess[] = [];
		const skipped = [...this.unproved.values()];
		for (const [pid, target] of this.targets) {
			const state = table ? this.verify(target, table) : "changed";
			if (state === "alive") leftovers.push(target);
			else if (state === "changed") skipped.push(target);
			else if (this.signalled.has(pid)) terminated.push(target);
		}
		return {
			root,
			exit,
			stdio,
			discovery: this.discoveryFailed ? "unavailable" : "ok",
			terminated,
			leftovers,
			skipped,
			deadlineHit: this.deadlineHit,
		};
	}

	private clearKillTimer(): void {
		if (!this.killTimer) return;
		clearTimeout(this.killTimer);
		this.killTimer = undefined;
	}

	private requireOwned(what: string): OwnedSettings {
		if (!this.owned) throw new Error(`${what} needs an owned cleanup: pass one to ChildTree to opt in to descendant discovery and cleanup`);
		return this.owned;
	}

	private signalTree(signal: NodeJS.Signals): void {
		if (this.owned) {
			void this.proveAndSignal(signal);
			return;
		}
		const pid = this.proc?.pid;
		if (!pid) return;
		this.sent.add(signal);
		if (process.platform === "win32") {
			try {
				this.proc?.kill(signal);
			} catch {}
			return;
		}
		const found = descendantsOf(pid);
		for (const descendant of found.pids) this.known.pids.add(descendant);
		for (const group of found.groups) this.known.groups.add(group);
		const targets = [-pid, ...[...this.known.groups].map((group) => -group), ...this.known.pids];
		for (const target of targets) {
			try {
				process.kill(target, signal);
			} catch {}
		}
	}
}
