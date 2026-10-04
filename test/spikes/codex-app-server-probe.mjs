import * as fs from "node:fs";
import * as http from "node:http";

/*
 * The one program `codex-app-server.mjs` asks a Codex child to run: a bounded, exact probe the harness wrote the
 * command line for, copied into the case's own probe directory before the turn. Node builtins only. It evaluates
 * nothing it is given; its arguments are a verb, a path or loopback url the harness chose, and the harness's token.
 *
 *   write <absolute target> <token>   create the target exclusively with the token; never overwrites
 *   net <http://127.0.0.1:port/token> one GET to the controller's own loopback listener, bounded
 *   sleep <absolute pid file> <s>     write this pid to a new file, then wait up to s seconds (cancellation probe)
 *
 * Exit 0 done; 10 refused by the operating system (EACCES, EPERM, EROFS); 11 any other failure; 12 usage.
 */

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);
const [verb, first, second] = process.argv.slice(2);
const done = (code, report) => {
	process.stdout.write(`${JSON.stringify({ probe: verb, ...report })}\n`);
	process.exitCode = code;
};
const failed = (error) => done(error && DENIED.has(error.code) ? 10 : 11, { ok: false, code: error && typeof error.code === "string" ? error.code : "unknown" });

if (verb === "write" && first && second) {
	try {
		fs.writeFileSync(first, `${second}\n`, { flag: "wx", mode: 0o600 });
		done(0, { ok: true });
	} catch (error) {
		failed(error);
	}
} else if (verb === "net" && first && /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9-]+$/.test(first)) {
	const request = http.get(first, { timeout: 5_000 }, (response) => {
		response.resume();
		response.on("end", () => done(response.statusCode === 200 ? 0 : 11, { ok: response.statusCode === 200, status: response.statusCode }));
	});
	request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
	request.on("error", failed);
} else if (verb === "sleep" && first && Number(second) > 0 && Number(second) <= 600) {
	try {
		fs.writeFileSync(first, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
		setTimeout(() => done(0, { ok: true, slept: Number(second) }), Number(second) * 1_000);
	} catch (error) {
		failed(error);
	}
} else done(12, { ok: false, code: "usage" });
