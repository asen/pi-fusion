/**
 * The host's tool list as a fake ExtensionAPI models it, and the one way a test host turns Fusion on. Fusion starts off
 * in every extension instance, so a host whose case delegates turns it on the way a user's request does, through the
 * registered `fusion_activate` tool, and never through an option production does not have.
 */

/** What Pi activates for an extension loaded with no allow list: its own builtins beside every tool registered. */
export const STARTING_TOOLS = ["read", "bash", "fusion", "fusion_control", "claude", "claude_control", "fusion_activate", "fusion_deactivate"];

/**
 * The three accessors Fusion reads the host's tool list through, over a list the case can read and change. `offered` is
 * what the registry holds, which a host allow list would narrow; a name it does not hold is dropped, as Pi drops it.
 */
export function toolList(offered: () => Iterable<string>, active: string[] = [...STARTING_TOOLS]) {
	return {
		activeTools: active,
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			const known = new Set(offered());
			active.splice(0, active.length, ...names.filter((name) => known.has(name) || !name.startsWith("fusion") && !name.startsWith("claude")));
		},
		getAllTools: () => [...offered()].map((name) => ({ name })),
	};
}

/**
 * Turns Fusion on through its activation tool. The switch is synchronous inside the tool, so the host is on when this
 * returns, before any await; a refusal fails the case through the returned promise and the check right here.
 */
export function turnOn(tool: { execute: (id: string, params: any, signal: undefined, onUpdate: undefined, ctx: any) => Promise<object> } | undefined, ctx: unknown = {}): Promise<unknown> {
	if (!tool) throw new Error("fusion_activate is not registered");
	const result = tool.execute("activate", {}, undefined, undefined, ctx);
	result.catch(() => {});
	return result.then((done) => {
		const details = (done as { details?: { enabled?: unknown } }).details;
		if (details?.enabled !== true) throw new Error(`fusion did not turn on: ${JSON.stringify(details)}`);
	});
}
