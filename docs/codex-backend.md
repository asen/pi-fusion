# The Codex backend

**Status: registered, experimental, and natively unqualified (stage 1).** The host registers this build's Codex backend by default beside Claude and Pi: `extensions/backends/codex.ts` composes a run and `codex-outcome.ts` maps its evidence. Nothing routes there unless a call names `backend: "codex"` or your settings put `implement` or `ask` on it; builtin routes no role to Codex. No real Codex app-server, provider, model or platform has been measured with it (see [Evidence](#evidence)), so treat every run as a trial of your own install.

## What stage 1 runs

| | Codex |
| --- | --- |
| Roles | `implement` (`workspace-write` sandbox) and `ask`, both modes (`read-only`), approval policy `never` |
| Unavailable | `plan`, `ultracode`, `security`, the `fresh` parameter; each is refused before anything starts |
| Sessions | Fresh threads only. A `continue` is refused: a Codex record has no trusted checkpoint and is kept for reading, and the backend refuses any resume or fork mapping before a contract read, binary lookup or spawn |
| Questions and steers | None: no `ask_orchestrator`, and the input is closed from the start. A control `message` or `/fusion steer` to a running Codex run is refused at once; `wait`, `status` and `cancel` work as for any run |
| Reviews | A manual or automatic review runs on Codex when the session's **ask** role is configured there, as a fresh read-only thread; it inherits nothing from the reviewed run, and disabled ask refuses manual review and skips automatic review quietly |
| Writer slot | `implement` holds the single file-changing slot across Claude, Pi and Codex, like any coding run; `ask` runs beside it |
| Follow-up | A new run carrying the report as context. The stats line, status and dashboard name `codex resume <thread id>`, from the accepted thread only, as an intended manual recovery hint for opening the thread in Codex yourself. It is based on Codex's source and documentation; whether the CLI reopens a thread the app-server created has not been measured natively ([Stages](#stages-and-native-qualification-gates)). An id a shell would not read as one plain word is single-quoted, and one starting with `-` follows `--` |

Loading the extension constructs the backend and does nothing else: no binary is looked for, no contract, configuration or home is read, and nothing starts. A machine without `codex` loads Fusion, Claude and Pi as before, and a Codex run there fails with the launch's own sentence about the missing binary.

## The host's own install

A run uses the host's `codex`: `PI_FUSION_CODEX_BIN` (an absolute path) or the first executable `codex` on the inherited `PATH`, located when the run starts ([configuration](configuration.md)). The child gets the host's environment copied unchanged and runs in the host's working directory. It therefore uses the user's own Codex home (`CODEX_HOME`, else `~/.codex`), configuration, profiles and login: Fusion copies, writes and checks no auth or configuration file, and needs no API key of its own. It adds no Codex SDK or npm dependency and downloads or installs no binary; `npm install` is unchanged. The home is predicted only so the handshake can compare it with the one the child reports.

Lookup and launch follow POSIX rules only. Linux x64 is the intended native qualification target; macOS runs the same code and is unqualified. On Windows a Codex run is refused when it starts, because a `codex` on `PATH` there is a `.cmd` shim that needs a shell; loading the extension is unaffected.

The sandbox **mode** is named per thread and checked at start. Everything else about that mode — writable roots, network access, shell environment policy and any other policy the user's configuration sets for `workspace-write` or `read-only` — is inherited and neither set nor checked.

That network setting concerns the commands the child runs. Codex's hosted web search, when the user's configuration enables it, is Codex's own provider-side tool and is inherited the same way: Fusion neither enables nor disables it, and the addendum tells the child to name its sources or say which fact it could not check. Neither has been measured natively.

**The request names no cwd (open native question Q2).** Neither thread/start nor turn/start names a working directory. Read in the 0.160.0 source, naming one can make Codex record a trust entry for an untrusted writable project in the user's configuration; leaving it out avoids that, and the reported cwd is checked against the launch's realpath instead. Whether that holds natively, and how a real app-server treats a project it does not trust when no cwd is named, is unmeasured (Q2). A fallback that names the cwd, and so may write a trust entry into the user's Codex configuration, is not implemented and would need the user's explicit consent first.

## Evidence

Keep these three apart:

| Kind | What it covers |
| --- | --- |
| Source inspection | Every app-server shape (initialize, thread/start, turn/start, thread/read, notifications, approvals) as read in Codex **0.160.0**'s app-server protocol source. That includes the reading that `developerInstructions`, `Thread.model` and `Thread.reasoningEffort` are stable fields there. A later version may change any of it. |
| Deterministic fake | `test/codex-backend.test.ts` drives the composition against `test/fake-codex.mjs`, a builtins-only node program that speaks literal JSON-RPC. It is launched by path through an injected launch, with no Codex binary, home, auth, `PATH` lookup or model. One lifecycle case registers this build's backend in a test host over the same fake, for a delegated run and an independently configured reviewer; host controls, records and presentation are otherwise tested with in-memory doubles. A pass shows that this host's sequencing, checks and mapping behave as written against those literals. |
| Native measurement | **None.** No real app-server, provider, paid model request, platform or version has been qualified. Linux x64 is the intended qualification target; macOS and Windows are not. |

## Stages and native qualification gates

Stage 1 is what this build ships. Later stages are planned, not shipped, and each sits behind a manual native qualification gate that the user agrees to before any paid run:

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Fresh `implement` and `ask` on the app-server's stable methods | Shipped and experimental; its native gate has not been run |
| 2 | Verified continuation and fork from a trusted turn checkpoint, `plan` on Codex, and steers | Not shipped: resume, fork, `plan` and steers are refused today |
| 3 | Questions through Codex's experimental question surfaces, which 0.160.0 gates behind its experimental API (source-read) | Not shipped: a Codex child has no question tool |

The stage 1 native harness is the next planned step. It is **not in this repository yet**, so there is no command to run. As planned, it stays under `test/spikes/` outside the default test glob and runs one agreed case group at a time in the foreground against the user's own install, login and configuration, which can mean paid requests. It records the Codex version, platform, Node version, selected and skipped cases, exit status and full output. Its cases are to settle the open native questions above and below, such as Q2 (no named cwd) and Q14 (cache write vs input), and to observe sandbox behavior under the host's current Codex policy as it stands, with no configuration override and no assumption that network or outside-cwd access is denied. A later, manual and non-gating check can also record whether `codex resume <thread id>` from the host's CLI reopens a thread the app-server created; until then that hint is unmeasured. A fallback that names the cwd is considered only if Q2 fails, and only with the user's consent, because it may write a trust entry. Until a gate passes, nothing here claims native qualification, cost or context-window guarantees.

## One call

```text
cancelled? -> nothing read, located or started
contract + codex-no-questions addendum  (unreadable: thrown, before any lookup)
codexLaunch: host cwd, inherited env, binary located now (failure: thrown as is)
spawn -> initialize (client pi-fusion, this package's version) -> initialized
  home check: reported Codex home == predicted home (canonical)
thread/start  { model?, modelProvider?, sandbox, approvalPolicy: never, developerInstructions }
  checks: thread id, cwd == launch cwd (canonical), sandbox tag == role mode,
          approval policy confirmed exactly as never, named model/provider exact
turn/start    { threadId, input: [text], effort? }
  turn.done (the admitted turn's own end) -> completed? no terminal error?
thread/read   (barrier: notifications sent before its answer, late usage included, are applied first)
  checks: final agent message of this turn, usage, idle status, cwd, selection
one shutdown -> outcome mapping
```

Requests never name a `cwd`, config map, base instructions, dynamic tools or an effort on thread/start. Turn/start names no model, provider, cwd or sandbox policy: the model is bound to the thread. Naming a cwd could make Codex record a trust entry in the user's configuration. Leaving it out avoids that, and the reported cwd is checked against the launch's realpath instead. Fusion writes no trust entry, configuration or auth file.

A resume or fork is refused when the session is mapped, before any contract read, binary lookup or spawn. A Codex child has no question tool and takes no steer: its control is closed (`push` refuses), and a question or other unsupported server request fails the run. Approval requests are declined, and the run lists them as denied tools. With approval policy `never`, none is expected.

## Selection

The model and effort come from the call, then the session's configuration, then `PI_FUSION_CODEX_<ROLE>_MODEL`/`_EFFORT`; with none of them the host's own Codex configuration chooses, and the run is shown as `host default`, then `host default -> <model>` once the child reports it. The label is never sent as a model.

The **configured selection** is the thread's own: the model and provider from thread/start, confirmed by the post-turn thread/read.

- A model the readback leaves `null` keeps the start answer's model, with a note. A non-null model that differs fails the run. The provider must match.
- A **named effort** must read back exactly. If the readback has `null` or no effort, the run fails.
- An **unnamed effort** is the readback's. If that is null, the start answer's is used with a note. If both are null, no effort is recorded, with a note.
- `model/rerouted` is **per-turn telemetry**, never the selection. An explicit-model run that Codex rerouted fails. A host-default run is accepted with a note quoting from/to/reason, and its recorded selection stays the configured model.

Notes are appended to the report as `Note: …` lines.

## Success, failure and cleanup

A run succeeds only when all of these hold:

- the admitted turn completed with no terminal error
- the turn has a non-empty final agent message
- the turn reported usage before the readback answered
- the thread reads back idle, with a verifiable selection
- the child's one shutdown was clean: no transport failure, an actual clean exit, and no cleanup concern

A retryable error notice is not an end. Failed, self-interrupted, crashed, timed-out (turn/start is never retried) and unsupported-request turns fail. A cancellation interrupts the turn when one is known, then stops the child within bounds.

A cancellation that lands during or after the readback still fails the run as aborted. A selection already verified is kept on that outcome as diagnostic data, not as success: success is `failed()` on the run and the host's `recordDecision`, never the presence of a selection.

A verified success whose shutdown was not clean is demoted. It keeps its thread and verified selection, and the cleanup concerns appear once, in the run's `cleanupNotice`. The composition calls the child's shutdown exactly once. A transport that already finalized itself returns that same report.

## Records and usage

- The outcome reference is `{ backend: "codex", sessionId: <thread id> }` with **no checkpoint**. The record is kept for reading, and a follow-up is a new run. `codex resume <id>` is named as an intended manual hint for opening the thread, not a natively measured one. A scalar `sessionId` is set as a diagnostic, and the host's writer does not record it for Codex.
- `modelId` and the selection are the configured model, provider and effort.
- Tokens are the fresh thread's final cumulative **total**: input (which already includes cached input), output, cache read (= cached input, shown and never added again) and cache write as reported. Context is the latest response's input, and the window appears only when the child reports one. With no window, no share is shown or guessed.
- **Cache write vs input is unqualified (Q14).** Whether Codex's cache-write tokens are part of `inputTokens` is not settled by the 0.160.0 source and has not been measured natively. Fusion uses Codex's `inputTokens` unchanged and reports cache write beside it, with no sum, subtraction or clamp. No lifecycle, budget or context-cap behavior may rely on that relationship until Q14 is measured.
- Usage covers the **parent thread only**. A subagent's threads are not included, and nothing claims they are. Codex reports no cost, so the cost is **unknown**: no USD figure or estimate is produced.
- In the host, a Codex run's tokens count toward the session ledger and its dollar estimate leaves it out: no Codex run shows a cost, and `/fusion status`, the widget and the dashboard header add `cost unknown for N codex runs, not in the estimate`. With `PI_FUSION_BUDGET_WARN_USD` or `PI_FUSION_BUDGET_LIMIT_USD` set, the first Codex run admitted in an extension instance says once that Codex spend is outside the estimate. No budget refusal or estimate is specific to Codex; the existing limit refuses Codex runs exactly as any other once the priced Claude/Pi estimate reaches it.
- A context share is shown only when the child reports a window; with a null window no share is guessed.
- The host records the tagged thread reference and the verified selection only. The outcome's scalar `sessionId`, and any flat checkpoint, model or effort, are diagnostics the host never writes for a Codex run; `recordDecision` decides what is kept. A cancelled or failed run that already verified its selection stays a failure: it may be kept for reading with that selection, never read as a success.

## Inheritance, not isolation

The child runs the host's `codex` (`PI_FUSION_CODEX_BIN` or `PATH`) with the host's environment copied unchanged. It therefore uses the user's Codex home, configuration, auth, MCP servers, multi-agent features (subagents) and any remote-control settings. Fusion predicts the home only to compare it, and isolates nothing: an MCP server or remote-control setting the user enabled is live in a delegated run, and a subagent's work and spend are outside what Fusion reports. The sandbox is the per-thread mode Codex reports for the role, checked at start. There is no historical sandbox record or comparison, so a later continuation guard against one does not exist.

The live display filters the transport's notifications to the primary thread and its admitted turn. A subagent's or a foreign turn's final text, usage or tool calls never reach the report or the monitor.
