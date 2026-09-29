#!/usr/bin/env node
/*
 * Manual-harness-only helper-fetch interposer, loaded with `--import` into a fixture process and into the Pi child it
 * launches, **after** `pi-fetch-guard.mjs` and never instead of it. It exists so one measurement can be made that the
 * guard alone makes impossible: what a real Pi child does when it has no `rg` or `fd` and downloads one. The SDK asks
 * `https://github.com/<repo>/releases/latest` and then a release asset on the same origin, and the guard rejects both
 * because that origin is not one this fixture owns — correctly, and that is what must stay true for every other url.
 *
 * So this preload maps an **exact list of urls**, and nothing else, to the same pathname at one loopback origin the
 * harness owns:
 *
 *   PI_SPIKE_HELPER_ORIGIN   the harness's own `http://127.0.0.1:<port>` listener. A real origin is refused here.
 *   PI_SPIKE_HELPER_URLS     the exact urls to map, comma separated. Not a prefix, a host, a pattern or a domain.
 *   PI_SPIKE_INTERPOSER_LOG  this preload's own log, separate from the guard's.
 *
 * What it guarantees, exactly. It captures the already guarded `fetch` and calls it, so a mapped request is still the
 * guard's to allow, log and refuse a redirect for: the actual traffic in the guard's log is loopback traffic, and the
 * original url a case's child asked for is in this log instead. A url that is not in the list byte for byte reaches
 * the guard unchanged, which is what blocks an unrelated `github.com` url and an asset no case listed. There is no
 * allow-list of hosts or domains anywhere in it, the method, headers, signal and redirect mode of a call are passed
 * through untouched — `redirect: "manual"` stays manual, so the 302 the fixture answers with is returned rather than
 * followed — and a configuration it cannot validate throws instead of letting a request through unwatched.
 *
 * What the rewrite covers, exactly, and what it does not promise. The two calls it exists for are the SDK's own helper
 * lookup and download, and both are **bodiless GETs**: a url and an init carrying headers, a signal and a redirect
 * mode. Those reach the guard with the url replaced and nothing else changed. A mapped call that arrives as a `Request`
 * instead is rebuilt around the new url, and a rebuild that would lose what the original carried **refuses the call**
 * rather than sending a weakened one — that is a refusal, not lossless rewriting of an arbitrary request, and nothing
 * here supports or claims to support a streamed body or a `duplex` half. No such call exists on the path this measures.
 *
 * Two things its own log records so a reader can check them rather than assume them: `wraps`, the name of the function
 * it captured, which is `guardedFetch` exactly when it was loaded after the guard — the harness requires that, so an
 * interposer loaded first, which would have sent a mapped request the guard never saw, fails instead of passing; and a
 * `refused`, `no-global-fetch` or `unmappable-request` line, any of which makes a case's mapping claim unusable.
 *
 * What it does not do, and what the spike must not claim it does: it wraps `globalThis.fetch` in the processes this
 * preload reaches and nothing else — not a raw socket, not a subprocess, not another client, not code that captured
 * `fetch` before it ran. It is not a proxy, not a sandbox and not a network boundary; the guard is what refuses an
 * origin, and this only rewrites urls before the guard sees them. Nothing in the production bootstrap, the launch
 * options or the storage layout knows it exists, and no header, body or credential is ever recorded.
 */
import { appendFileSync } from "node:fs";

const label = process.env.PI_SPIKE_CALLER ?? "unlabelled";
const logFile = process.env.PI_SPIKE_INTERPOSER_LOG;

/** One line per event: who, and which url. No header, body or credential is ever recorded. */
const record = (entry) => {
	if (!logFile) return;
	try {
		appendFileSync(logFile, `${JSON.stringify({ caller: label, at: Date.now(), ...entry })}\n`);
	} catch {
		// A log that cannot be written must not change what the interposer does about the request itself.
	}
};

/**
 * A configuration this preload cannot validate is fatal rather than ignored: installing nothing would leave a case
 * measuring a child that quietly reached the guard's refusal, and reading that as a download that did not happen.
 */
const refuse = (reason) => {
	record({ event: "refused", reason });
	throw new Error(`spike helper interposer: ${reason}`);
};

if (!logFile) throw new Error("spike helper interposer: PI_SPIKE_INTERPOSER_LOG is not set, so nothing here could be evidence");

/** The loopback listener this fixture owns, and only ever that: a real origin is what this preload exists to avoid. */
const helperOrigin = (() => {
	const value = process.env.PI_SPIKE_HELPER_ORIGIN;
	if (!value) refuse("PI_SPIKE_HELPER_ORIGIN is not set");
	let url;
	try {
		url = new URL(value);
	} catch {
		return refuse(`PI_SPIKE_HELPER_ORIGIN ${JSON.stringify(value)} is not a url`);
	}
	if (url.protocol !== "http:") refuse(`PI_SPIKE_HELPER_ORIGIN ${JSON.stringify(value)} is not http, and this fixture's own listener is`);
	if (!["127.0.0.1", "[::1]"].includes(url.hostname)) refuse(`PI_SPIKE_HELPER_ORIGIN ${JSON.stringify(value)} is not a loopback host, and only the harness's own listener may be mapped to`);
	if (!url.port) refuse(`PI_SPIKE_HELPER_ORIGIN ${JSON.stringify(value)} names no port, so it is not one listener this harness started`);
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") refuse(`PI_SPIKE_HELPER_ORIGIN ${JSON.stringify(value)} carries a path, a query or a fragment, and an origin is none of those`);
	if (url.origin !== value) refuse(`PI_SPIKE_HELPER_ORIGIN ${JSON.stringify(value)} is not exactly its own origin ${JSON.stringify(url.origin)}`);
	return url.origin;
})();

/** The exact urls, each mapped to the same pathname at that origin. A malformed or repeated entry refuses the call. */
const mappings = (() => {
	const raw = process.env.PI_SPIKE_HELPER_URLS;
	if (!raw) refuse("PI_SPIKE_HELPER_URLS is not set, so there is nothing to map and no reason to install");
	const map = new Map();
	for (const entry of raw.split(",")) {
		const value = entry.trim();
		if (!value) refuse(`PI_SPIKE_HELPER_URLS holds an empty entry: ${JSON.stringify(raw)}`);
		let url;
		try {
			url = new URL(value);
		} catch {
			return refuse(`PI_SPIKE_HELPER_URLS entry ${JSON.stringify(value)} is not an absolute url`);
		}
		if (!["http:", "https:"].includes(url.protocol)) refuse(`PI_SPIKE_HELPER_URLS entry ${JSON.stringify(value)} is not http or https`);
		if (url.pathname === "/" || url.pathname === "") refuse(`PI_SPIKE_HELPER_URLS entry ${JSON.stringify(value)} names no path, and a whole origin is never mapped here`);
		if (url.search !== "" || url.hash !== "") refuse(`PI_SPIKE_HELPER_URLS entry ${JSON.stringify(value)} carries a query or a fragment, and the mapping is by pathname alone`);
		if (url.href !== value) refuse(`PI_SPIKE_HELPER_URLS entry ${JSON.stringify(value)} is not its own normalized form ${JSON.stringify(url.href)}, so an exact match could not be asserted`);
		if (map.has(url.href)) refuse(`PI_SPIKE_HELPER_URLS names ${JSON.stringify(url.href)} twice`);
		map.set(url.href, `${helperOrigin}${url.pathname}`);
	}
	return map;
})();

/** The url a call names, normalized the way the map's keys are, or undefined for something this cannot read. */
const href = (input) => {
	try {
		if (typeof input === "string") return new URL(input).href;
		if (input instanceof URL) return input.href;
		if (input !== null && typeof input === "object" && typeof input.url === "string") return new URL(input.url).href;
	} catch {
		return undefined;
	}
	return undefined;
};

const inner = globalThis.fetch;
if (typeof inner !== "function") {
	record({ event: "no-global-fetch" });
} else {
	globalThis.fetch = function interposedFetch(input, init) {
		const original = href(input);
		const mapped = original === undefined ? undefined : mappings.get(original);
		if (mapped === undefined) {
			// Everything else goes on to the guard exactly as it was, which is what refuses an origin this fixture does
			// not own. Recorded by origin and path alone, so an unmapped attempt is evidence rather than a silence.
			let where = { origin: "unparsed", path: "" };
			try {
				const url = new URL(original ?? "");
				where = { origin: url.origin, path: url.pathname };
			} catch {
				// An input this preload cannot read is passed through unchanged and recorded as such.
			}
			record({ event: "unmapped", ...where });
			return inner.call(this, input, init);
		}
		const method = init?.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET");
		const asked = init?.redirect ?? (typeof input === "object" && input !== null && "redirect" in input ? input.redirect : undefined);
		// The original url, which the guard will never see: what it records for this request is the loopback traffic.
		record({ event: "mapped", original, to: mapped, method, redirect: asked ?? null });
		if (typeof input === "string" || input instanceof URL) return inner.call(this, mapped, init);
		// A `Request` carries its own method, headers, signal, redirect mode and body, so it is rebuilt around the new
		// url rather than reduced to one: a clone that cannot be made refuses the call instead of dropping any of them.
		let request;
		try {
			request = new Request(mapped, input);
		} catch (error) {
			record({ event: "unmappable-request", original, to: mapped });
			return Promise.reject(new Error(`spike helper interposer: ${original} could not be rewritten as a Request without losing what it carried: ${error?.message ?? String(error)}`));
		}
		return inner.call(this, request, init);
	};
}
// `wraps` is the name of the function this preload captured, which is how a case reads that it was loaded **after** the
// guard rather than instead of it: the guard's own wrapper is `guardedFetch`, and the platform's is `fetch`.
record({ event: "installed", origin: helperOrigin, mapped: [...mappings.keys()], wraps: typeof inner === "function" ? inner.name : null });
