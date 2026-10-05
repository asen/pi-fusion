/*
 * A plain node process tree for the process-tree tests: a root that spawns whatever topology a test describes, down
 * to a grandchild in its own process group. It speaks no protocol and needs no backend, and it writes its own pid to
 * a file purely so a test has an oracle to assert against and an emergency cleanup of its own. Nothing in
 * extensions/process-tree.ts is ever handed one of those pids: the cleanup has to find the tree for itself.
 *
 * Environment:
 *   FIXTURE_DIR        where pid and marker files go, one per role
 *   FIXTURE_ROLE       this process's role, which names its files
 *   FIXTURE_SPAWN      JSON: [{ role, mode: "same-group" | "detached" | "inherit", env, spawn }]
 *   FIXTURE_IGNORE_EOF stay alive when stdin ends, so only a signal ends this
 *   FIXTURE_EOF_WAIT   on stdin end, wait for this marker file before exiting 0
 *   FIXTURE_IGNORE_TERM install a SIGTERM handler that does nothing, so only SIGKILL ends this
 *   FIXTURE_TERM_MARK  on SIGTERM, write "<role>.term" and exit 0
 *   FIXTURE_ZOMBIE     spawn a child that exits at once, then block the loop forever so it is never reaped
 *   FIXTURE_STDERR     write this one line to stderr, and wait for that write, before stdin is read at all
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const dir = process.env.FIXTURE_DIR;
const role = process.env.FIXTURE_ROLE ?? "root";
const marker = (name) => path.join(dir, name);
const write = (name, value) => fs.writeFileSync(marker(name), String(value));

if (process.env.FIXTURE_IGNORE_TERM) process.on("SIGTERM", () => {});
if (process.env.FIXTURE_TERM_MARK) {
	process.on("SIGTERM", () => {
		write(`${role}.term`, process.pid);
		process.exit(0);
	});
}

write(`${role}.pid`, process.pid);

/** The environment a child starts from: this process's, with every fixture flag dropped and only the child's set. */
function childEnv(child) {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("FIXTURE_")) env[key] = value;
	return { ...env, FIXTURE_DIR: dir, FIXTURE_ROLE: child.role, FIXTURE_SPAWN: JSON.stringify(child.spawn ?? []), ...(child.env ?? {}) };
}

for (const child of JSON.parse(process.env.FIXTURE_SPAWN ?? "[]")) {
	// "inherit" keeps this process's stdout and stderr pipes open in the child, which is how a pipe outlives its root.
	const stdio = child.mode === "inherit" ? ["ignore", "inherit", "inherit"] : "ignore";
	const proc = spawn(process.execPath, [self], {
		env: childEnv(child),
		stdio,
		detached: child.mode === "detached",
	});
	proc.unref();
}

if (process.env.FIXTURE_ZOMBIE) {
	const doomed = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	write("zombie.pid", doomed.pid);
	write(`${role}.ready`, process.pid);
	// A blocked loop never reaps, so the child stays a zombie in the process table for as long as this lives.
	const lock = new Int32Array(new SharedArrayBuffer(4));
	for (;;) Atomics.wait(lock, 0, 0, 10_000);
}

/*
 * The line goes out before this process can read its own stdin, and this waits for the write itself to finish: stderr
 * on a pipe is asynchronous, so a root that took its EOF first could exit with the line still queued and leave its
 * reader an empty pipe. That is what lets the stderr tests end stdin at once instead of waiting for a marker. Only
 * this branch awaits anything, and only those tests set it, so every other mode starts exactly as it always did.
 */
if (process.env.FIXTURE_STDERR) await new Promise((resolve) => process.stderr.write(`${process.env.FIXTURE_STDERR}\n`, resolve));

/* Only the root is given a stdin pipe; every other role is spawned with none, and a null stdin ends at once. */
if (role === "root") {
	process.stdin.on("end", () => {
		if (process.env.FIXTURE_IGNORE_EOF) return;
		const waitFor = process.env.FIXTURE_EOF_WAIT;
		if (!waitFor) process.exit(0);
		// Exits on its own, but only once the marker is there: without it this root is still running when its grace ends.
		const until = Date.now() + 10_000;
		const poll = setInterval(() => {
			if (fs.existsSync(marker(waitFor))) process.exit(0);
			if (Date.now() > until) process.exit(7);
		}, 10);
		poll.unref();
	});
	process.stdin.resume();
}
// Nothing here ends on its own: a test's own cleanup or the code under test is what ends it.
setInterval(() => {}, 60_000);
write(`${role}.ready`, process.pid);
