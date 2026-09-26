import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * The child process a backend's transport runs on, and the descendant termination that cancelling a run needs. No
 * backend's SDK types reach this module: a backend translates its own launch shape into the ones below.
 */

/** How long a killed process tree has to exit on SIGTERM before it is sent SIGKILL. */
export const KILL_GRACE_MS = 5_000;
/** How long a child that has been told to shut down has to close on its own before it is killed. */
const EXIT_GRACE_MS = 2_000;

const sleep = (ms: number): Promise<undefined> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		timer.unref();
	});

/** What a child process is launched with. Kept free of any backend's own types, so both backends pass their own. */
export interface LaunchOptions {
	command: string;
	args: string[];
	cwd?: string;
	env: { [key: string]: string | undefined };
}

/** The launched process as its caller drives it: the shape a backend's transport takes over the process it spawns. */
export interface LaunchedProcess {
	stdin: Writable;
	stdout: Readable;
	readonly killed: boolean;
	readonly exitCode: number | null;
	readonly signalCode?: NodeJS.Signals | null;
	kill(signal: NodeJS.Signals): boolean;
	on(event: "exit" | "error", listener: (...args: any[]) => void): void;
	once(event: "exit" | "error", listener: (...args: any[]) => void): void;
	off(event: "exit" | "error", listener: (...args: any[]) => void): void;
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

export interface ExitOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * Spawns a child process for a backend's transport and owns its process tree. A backend's own shutdown, when it
 * has one, signals the child alone: Claude Code's SDK sends SIGTERM 2 s after an abort and SIGKILL 5 s after that.
 * This sends SIGTERM at once to the child's process group and to the groups of every descendant, then SIGKILL
 * after the grace period, so a Bash command the child started dies with it.
 */
export class ChildTree {
	command = "";
	stderr = "";
	spawnError?: Error;
	private proc?: ChildProcess;
	private closed?: Promise<ExitOutcome>;
	private killTimer?: NodeJS.Timeout;
	/*
	 * Descendants can sit in their own process groups. They are remembered across calls because once the child is
	 * dead they are re-parented and a later scan from the child's pid no longer finds them.
	 */
	private readonly known = { pids: new Set<number>(), groups: new Set<number>() };
	private readonly sent = new Set<NodeJS.Signals>();
	private readonly killGraceMs: number;

	constructor(killGraceMs: number) {
		this.killGraceMs = killGraceMs;
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
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (data: string) => {
			this.stderr += data;
		});
		this.closed = new Promise<ExitOutcome>((resolve) => {
			proc.once("error", (err) => {
				this.spawnError = err instanceof Error ? err : new Error(String(err));
				resolve({ code: null, signal: null });
			});
			proc.once("close", (code, signal) => resolve({ code, signal }));
		});
		return {
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
	}

	get spawned(): boolean {
		return this.proc !== undefined;
	}

	/** True when the child died of a signal this sent, so of our own shutdown and not of anything that happened to it. */
	stoppedBy(exit: ExitOutcome): boolean {
		return exit.signal !== null && this.sent.has(exit.signal);
	}

	kill(): void {
		this.signalTree("SIGTERM");
		if (this.killTimer) return;
		// Runs even after the child has closed: its descendants may still be shutting down.
		this.killTimer = setTimeout(() => this.signalTree("SIGKILL"), this.killGraceMs);
		this.killTimer.unref();
	}

	/** Waits for the child to close, giving it a moment to exit on its own before killing it. */
	async exited(): Promise<ExitOutcome> {
		if (!this.proc || !this.closed) return { code: null, signal: null };
		const outcome = await Promise.race([this.closed, sleep(EXIT_GRACE_MS)]);
		if (outcome) return outcome;
		this.kill();
		return this.closed;
	}

	private signalTree(signal: NodeJS.Signals): void {
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
