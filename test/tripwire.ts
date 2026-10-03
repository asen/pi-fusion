import assert from "node:assert/strict";
import { after } from "node:test";
import { PI_ROLE_NAMES, piEffortVariable, piModelVariable } from "../extensions/backends/pi-binding.ts";
import type { HostBackend, SessionIntent } from "../extensions/backends/types.ts";
import type { FusionOptions } from "../extensions/fusion.ts";
import { memoryProfileStore } from "../extensions/profile-store.ts";

/**
 * The pi backend the test hosts register in place of the one this build registers by default — all of them but the
 * two `productionDefaults()` registrations, which take this build's own and reach no method of it: each deletes every
 * variable a pi role could resolve a model from first, so the registration is refused while one is still set and the
 * explicit pi call is then refused by the binding for having no model, before a session, a control or a run is asked
 * for. Nothing in the suite
 * is about running a real Pi child: a case that reached the production backend would compose storage, write a call
 * input and launch a harness instead of failing in a way a test can read. So every entry point of this one records
 * that it was reached and refuses, and the hook at the bottom is what says none of them was — for the whole file, and
 * not for the one case that happened to notice.
 *
 * A host that injects a pi backend of its own puts it over this one, which is why `piTripwire()` is spread first:
 * `{ ...piTripwire(), ...ownBackends }`. A case that wants this build's own registration instead says so with
 * `productionDefaults()`, which is the one other thing a registration call may name.
 */

/** What every entry point refuses with, and all it says: reaching one is the suite's own mistake, not a run's. */
export const PI_TRIPWIRE = "the suite reached the pi backend tripwire";

/** Each entry point a case reached, in order. An empty list is the only acceptable value, and the hook below says so. */
const reaches: string[] = [];

/** The backends a host registers to keep the production pi backend out of it, ready to spread over its own. */
export function piTripwire(): { pi: HostBackend } {
	return {
		pi: {
			name: "pi",
			control: (): never => {
				reaches.push("control");
				throw new Error(PI_TRIPWIRE);
			},
			session: (intent: SessionIntent): never => {
				reaches.push(`session ${intent.kind}`);
				throw new Error(PI_TRIPWIRE);
			},
			run: async (): Promise<never> => {
				reaches.push("run");
				throw new Error(PI_TRIPWIRE);
			},
		},
	};
}

/**
 * Every variable a pi role could take a selection from, which a production-default registration has to clear: the
 * roles are the binding's own exported list rather than a copy of it, and each role's two variable names come from
 * the binding's own helpers. A role this build binds on Pi later is therefore guarded here the day it is added,
 * instead of leaving a registration that takes the defaults with a model it could still resolve.
 */
export const PI_SELECTION_VARIABLES = PI_ROLE_NAMES.flatMap((role) => [piModelVariable(role), piEffortVariable(role)]);

/**
 * The options a registration that is about this build's own backends passes, which is the marker that says so: the
 * two cases that read the production pi registration name this, every other registration names `piTripwire`, and
 * `test/backends.test.ts` reads both out of the source. It is not cosmetic — a production-default registration is
 * only safe while no pi role can resolve a model, because the binding's refusal is the one thing between such a case
 * and a real child, so a variable still set here fails the call that asked for the defaults rather than the run.
 */
export function productionDefaults(): FusionOptions {
	const set = PI_SELECTION_VARIABLES.filter((name) => process.env[name] !== undefined);
	if (set.length) throw new Error(`a production-default registration must leave a pi role no model to resolve, and ${set.join(", ")} is still set`);
	// The production backends, and never the user's own profiles file: no registration of the suite reads or writes it.
	return { profiles: memoryProfileStore() };
}

/**
 * Registered at module level, when a file imports this, rather than inside any case: a case that swallowed what an
 * entry point threw — a tool whose error becomes a returned message, a run whose failure becomes a report — would
 * otherwise pass while having reached a backend that in production is a real Pi child. The reach is recorded before
 * the throw for the same reason, and this hook fails the whole file on it whichever case did it.
 */
after(() => {
	assert.deepEqual(reaches, [], "a case reached the pi backend tripwire, which in production is a real pi child");
});
