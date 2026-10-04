# The Codex backend (runtime layer)

**Status: experimental, unqualified, and not registered.** This page covers the fresh-run Codex runtime layer: `extensions/backends/codex.ts`, which composes the run, and `codex-outcome.ts`, which maps its evidence. The host does not construct or register it yet, so a call routed to `codex` is still refused as unavailable before anything starts (see [Runs](runs.md)). Host registration is the next slice. Until then this page describes code that only the test suite runs.

## Evidence

Keep these three apart:

| Kind | What it covers |
| --- | --- |
| Source inspection | Every app-server shape (initialize, thread/start, turn/start, thread/read, notifications, approvals) as read in Codex **0.160.0**'s app-server protocol source. That includes the reading that `developerInstructions`, `Thread.model` and `Thread.reasoningEffort` are stable fields there. A later version may change any of it. |
| Deterministic fake | `test/codex-backend.test.ts` drives the composition against `test/fake-codex.mjs`, a builtins-only node program that speaks literal JSON-RPC. It is launched by path through an injected launch, with no Codex binary, home, auth, `PATH` lookup or model. A pass shows that this host's sequencing, checks and mapping behave as written against those literals. |
| Native measurement | **None.** No real app-server, provider, paid model request, platform or version has been qualified. Linux x64 is the intended qualification target. |

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

- The outcome reference is `{ backend: "codex", sessionId: <thread id> }` with **no checkpoint**. The record is kept for reading, and a follow-up is a new run (`codex resume <id>` opens the thread). A scalar `sessionId` is set as a diagnostic, and the host's writer does not record it for Codex.
- `modelId` and the selection are the configured model, provider and effort.
- Tokens are the fresh thread's final cumulative **total**: input (which already includes cached input), output, cache read (= cached input, shown and never added again) and cache write as reported. Context is the latest response's input, and the window appears only when the child reports one. With no window, no share is shown or guessed.
- **Cache write vs input is unqualified (Q14).** Whether Codex's cache-write tokens are part of `inputTokens` is not settled by the 0.160.0 source and has not been measured natively. Fusion uses Codex's `inputTokens` unchanged and reports cache write beside it, with no sum, subtraction or clamp. No lifecycle, budget or context-cap behavior may rely on that relationship until Q14 is measured.
- Usage covers the **parent thread only**. A subagent's threads are not included, and nothing claims they are. Codex reports no cost, so the cost is **unknown**: no USD figure or estimate is produced.

## Inheritance, not isolation

The child runs the host's `codex` (`PI_FUSION_CODEX_BIN` or `PATH`) with the host's environment copied unchanged. It therefore uses the user's Codex home, configuration, auth, MCP servers, multi-agent features and any remote-control settings. Fusion predicts the home only to compare it, and isolates nothing. The sandbox is the per-thread mode Codex reports for the role, checked at start. There is no historical sandbox record or comparison, so a later continuation guard against one does not exist.

The live display filters the transport's notifications to the primary thread and its admitted turn. A subagent's or a foreign turn's final text, usage or tool calls never reach the report or the monitor.
