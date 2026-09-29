#!/usr/bin/env node
/*
 * Manual-harness-only fetch guard, loaded with `--import` into a fixture process and into the Pi child it launches.
 * It exists so a measurement against a real SDK child cannot reach a live endpoint by accident: every `fetch` is
 * recorded, the ones whose origin is not an exact loopback origin this fixture owns are rejected before a request
 * goes out, and the log is what the spike reports its request counts from.
 *
 * What it guarantees, exactly: for a call through `globalThis.fetch` in this process, the first request goes to an
 * exact loopback origin this fixture owns, and no redirect is ever followed automatically. The second half matters as
 * much as the first, because an allowed loopback origin answering `302 Location: https://elsewhere` would otherwise
 * have the platform's own fetch follow it with no call back through here: reading `response.url` afterwards would
 * learn about it only after contact. So an automatic redirect is refused at request time — `redirect: "error"` unless
 * the caller explicitly asked for `manual`, which returns the 3xx rather than following it — and a redirected
 * response the platform refuses never reaches the network beyond the origin this fixture owns.
 *
 * What it does not do, and what the spike must not claim it does: it wraps `globalThis.fetch` in the processes this
 * preload reaches, and nothing else. A raw socket, a subprocess of the child, another runtime's HTTP client, a native
 * binding, or code that captured the platform's `fetch` before this preload ran is outside it. It is a harness preload
 * reached through NODE_OPTIONS in a disposable fixture environment; nothing in the production bootstrap, the launch
 * options or the storage layout knows it exists.
 */
import { appendFileSync } from "node:fs";

const label = process.env.PI_SPIKE_CALLER ?? "unlabelled";
const logFile = process.env.PI_SPIKE_FETCH_LOG;
const allowed = new Set(
	(process.env.PI_SPIKE_ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean),
);

/** One line per attempt: who, where, and whether it was let through. No header, body or credential is ever recorded. */
const record = (entry) => {
	if (!logFile) return;
	try {
		appendFileSync(logFile, `${JSON.stringify({ caller: label, at: Date.now(), ...entry })}\n`);
	} catch {
		// A log that cannot be written must not change what the guard does about the request itself.
	}
};

const target = (input) => {
	try {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		return { origin: url.origin, path: url.pathname };
	} catch {
		return { origin: "unparsed", path: "" };
	}
};

const inner = globalThis.fetch;
if (typeof inner !== "function") {
	record({ event: "no-global-fetch" });
} else {
	globalThis.fetch = function guardedFetch(input, init) {
		const { origin, path } = target(input);
		const method = init?.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET");
		if (!allowed.has(origin)) {
			record({ event: "blocked", origin, path, method });
			return Promise.reject(new Error(`spike fetch guard: ${origin} is not one of this fixture's loopback origins, so the request was not sent`));
		}
		// A `manual` caller handles the 3xx itself and any request it then makes comes back through here; anything else,
		// including a `Request` that carries its own `follow`, is downgraded to `error` so nothing is followed unseen.
		const asked = init?.redirect ?? (typeof input === "object" && input !== null && "redirect" in input ? input.redirect : undefined);
		const redirect = asked === "manual" ? "manual" : "error";
		record({ event: "allowed", origin, path, method, redirect });
		const request = typeof input === "object" && input !== null && "url" in input && redirect !== input.redirect ? new Request(input, { redirect }) : input;
		return inner.call(this, request, { ...init, redirect });
	};
}
record({ event: "installed", origins: [...allowed], redirects: "never followed automatically" });
