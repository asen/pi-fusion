/** Types for the pure half of the manual Codex qualification harness, so `test/codex-harness.test.ts` can import it. */

export declare const EXIT: Readonly<{ pass: 0; failure: 1; none: 2 }>;

export interface HarnessCase {
	id: string;
	model: boolean;
	fake: boolean;
	needs?: string;
	title: string;
}
export declare const CASES: readonly HarnessCase[];
export declare const GROUPS: Readonly<Record<string, string[]>>;

export interface HarnessArgs {
	run: boolean;
	fake: boolean;
	list: boolean;
	help: boolean;
	keep: boolean;
	unknown: string[];
	problems: string[];
	case?: string;
	model?: string;
	effort?: string;
	unsupportedEffort?: string;
	nullEffortModel?: string;
	outsideDir?: string;
}
export declare function isToken(value: unknown): boolean;
export declare function parseArgs(args: string[]): HarnessArgs;
export declare function selectCases(spec: string | undefined): { cases: HarnessCase[]; error?: undefined } | { error: string; cases?: undefined };
export declare const WARNING: string;
export declare const USAGE: string;

export declare function canonicalPath(file: string): string;
export declare function within(child: string, root: string): boolean;

/** The reported sandbox as the production reader keeps it; absent diagnostic fields are unknown. */
export interface ReportedSandbox {
	type: string;
	networkAccess?: boolean;
	writableRoots?: string[];
	excludeTmpdirEnvVar?: boolean;
	excludeSlashTmp?: boolean;
}
export type WriteGrants =
	| { kind: "unknown"; reason: string }
	| { kind: "none" }
	| { kind: "all" }
	| { kind: "grants"; grants: { root: string; source: string }[]; unknown: { scope: string | null; reason: string }[] };
export declare function writeGrants(sandbox: ReportedSandbox | undefined, context: { cwd: string; tmpdirEnv?: string; slashTmp?: string; canonical?: (file: string) => string }): WriteGrants;

export type Expectation = { applicable: true; expected: "permit" | "deny" | "reach" | "blocked"; reason: string } | { applicable: false; reason: string };
export declare function expectWrite(granted: WriteGrants, target: string, canonical?: (file: string) => string): Expectation;
export declare function expectNetwork(sandbox: ReportedSandbox | undefined): Expectation;

export declare const PROBE_EXIT: Readonly<{ ok: 0; denied: 10; other: 11; usage: 12 }>;
export interface ProbeItem {
	status?: string;
	exitCode: number | null;
}
export declare function shellWords(text: string): string[] | undefined;
export declare function sameProbeCommand(recorded: unknown, expected: string): boolean;
export interface ProbeMatch {
	items: ProbeItem[];
	unrecognised: number;
}
export declare function probeItems(notifications: { method: string; params: unknown }[], expected: string, token: string, scope: { threadId?: string; turnId?: string }): ProbeMatch;
export interface Observation {
	observed: "not-run" | "declined" | "permit" | "deny" | "reach" | "blocked" | "inconclusive";
	detail: string;
}
export declare function classifyWrite(match: ProbeMatch, state: { exists: boolean; content?: string }, token: string): Observation;
export declare function classifyNetwork(match: ProbeMatch, hits: number): Observation;

export type Status = "pass" | "fail" | "skip" | "unproven";
export declare function probeVerdict(expectation: Expectation, observation: Observation): { status: Status; why: string };
export interface LoopbackControl {
	ok: boolean;
	exit: number | null;
	hits: number;
}
export declare function networkVerdict(expectation: Expectation, observation: Observation, controls: { before?: LoopbackControl; after?: LoopbackControl } | undefined): { status: Status; why: string };
export declare const Q5_NO_DENIAL: string;
export declare function q5Verdict(probes: { name: string; observation: Observation; verdict: { status: Status; why: string } }[], context: { sandboxType: string | undefined; approvals: number }): { status: Status; why: string };
export interface OutsideCandidate {
	label: string;
	parent: string | undefined;
}
export declare function pickOutside(candidates: OutsideCandidate[], context: { granted: WriteGrants; codexHome?: string; usable: (parent: string) => boolean; canonical?: (file: string) => string }): { chosen?: OutsideCandidate & { parent: string }; reasons: string[] };

/** The role fields the backend's thread/start body is composed from. */
export interface BodyRole {
	model?: string;
	provider?: string;
	sandboxMode: string;
	approvalPolicy: string;
	contract: string;
	addendum: string;
}
export declare function composeInstructions(role: BodyRole, read: (name: string) => string): string;
export declare function threadParams(role: BodyRole, instructions: string): { model?: string; modelProvider?: string; sandbox: string; approvalPolicy: string; developerInstructions: string };
export declare function caseStatus(primary: Status[], guards: Status[]): Status;
export declare function readPidText(text: string | undefined): number | undefined;
export declare function startTimeOf(stat: string | undefined): string | undefined;
export interface ProbeProc {
	list(): number[] | undefined;
	read(pid: number): { argv: string[]; start: string | undefined } | undefined;
}
export interface ProbeIdentity {
	pid: number;
	start: string;
}
export declare function identifyProbe(argv: string[], pidFileText: string | undefined, proc: ProbeProc): { identity: ProbeIdentity; how: string; why?: undefined } | { why: string; identity?: undefined; how?: undefined };
export declare function probeAfter(identity: ProbeIdentity, proc: ProbeProc): "gone" | "alive" | "unknown";
export declare function forcedExitNotice(root: string, outside: string[]): string;
export declare function combine(statuses: Status[]): Status;
export declare function exitCode(statuses: Status[]): 0 | 1 | 2;

export declare function fileDigest(file: string): string;
export declare function topLevelWebSearch(text: string): string;
export declare function versionFromUserAgent(userAgent: string | undefined): string | undefined;
