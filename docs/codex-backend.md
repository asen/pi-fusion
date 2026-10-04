# The Codex backend

**Status: registered, experimental, and natively unqualified (stage 1).** The host registers this build's Codex backend by default beside Claude and Pi: `extensions/backends/codex.ts` composes a run and `codex-outcome.ts` maps its evidence. Nothing routes there unless a call names `backend: "codex"` or your settings put `implement` or `ask` on it; builtin routes no role to Codex. Some stage 1 cases have passed on one Linux x64 host with app-server 0.160, but its native gate has not (see [Evidence](#evidence)), so treat every run as a trial of your own install.

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

The sandbox **mode** is named per thread and checked at start. Everything else about that mode — writable roots, network access, shell environment policy and any other policy the user's configuration sets for `workspace-write` or `read-only` — is inherited and neither set nor checked. Fusion trusts the user's Codex sandbox and permissions as it trusts Claude's and Pi's: it does not re-audit that boundary, and nothing here claims one. The thread/start reader still keeps the reported writable roots, network flag and temp exclusions; nothing reads them.

That network setting concerns the commands the child runs. Codex's hosted web search, when the user's configuration enables it, is Codex's own provider-side tool and is inherited the same way: Fusion neither enables nor disables it, and the addendum tells the child to name its sources or say which fact it could not check. The harness only observes it: the item types recorded by the native Q4 run so far include no hosted search item, which is not evidence that search is disabled.

**The request names no cwd (Q2, Q9).** Neither thread/start nor turn/start names a working directory. Read in the 0.160.0 source, naming one can make Codex record a trust entry for an untrusted writable project in the user's configuration; leaving it out avoids that, and the reported cwd is checked against the launch's realpath instead. On the one measured host, Q2 and Q9 passed: the reported cwd bound by realpath with no request cwd, and an untrusted fixture cwd started with `config.toml` bytes unchanged and the sandbox mode kept ([Evidence](#evidence)). A fallback that names the cwd, and so may write a trust entry into the user's Codex configuration, is not implemented and would need the user's explicit consent first.

## Evidence

Keep these three apart:

| Kind | What it covers |
| --- | --- |
| Source inspection | Every app-server shape (initialize, thread/start, turn/start, thread/read, notifications, approvals) as read in Codex **0.160.0**'s app-server protocol source. That includes the reading that `developerInstructions`, `Thread.model` and `Thread.reasoningEffort` are stable fields there. A later version may change any of it. |
| Deterministic fake | `test/codex-backend.test.ts` drives the composition against `test/fake-codex.mjs`, a builtins-only node program that speaks literal JSON-RPC. It is launched by path through an injected launch, with no Codex binary, home, auth, `PATH` lookup or model. One lifecycle case registers this build's backend in a test host over the same fake, for a delegated run and an independently configured reviewer; host controls, records and presentation are otherwise tested with in-memory doubles. A pass shows that this host's sequencing, checks and mapping behave as written against those literals. |
| Native measurement | **Partial; G1 not passed.** The [stage 1 harness](#the-stage-1-harness-g1-not-yet-passed), as of commit `c2f2477`, measured Q1, Q2, Q3, Q4, Q7 and Q9 on one Linux x64 host; Q6 is pending. Nothing is qualified until G1 passes. Linux x64 with app-server 0.160 is the experimental scope; macOS and Windows are not measured. A `--fake` run of the harness is a deterministic fake, not a measurement. |

## Stages and native qualification gates

Stage 1 is what this build ships. Later stages are planned, not shipped, and each sits behind a manual native qualification gate that the user agrees to before any paid run:

| Stage | Scope | State |
| --- | --- | --- |
| 1 | Fresh `implement` and `ask` on the app-server's stable methods | Shipped and experimental; its native gate (G1) has not passed: Q6 is pending |
| 2 | Verified continuation and fork from a trusted turn checkpoint, `plan` on Codex, and steers | Not shipped: resume, fork, `plan` and steers are refused today |
| 3 | Questions through Codex's experimental question surfaces, which 0.160.0 gates behind its experimental API (source-read) | Not shipped: a Codex child has no question tool |

### The stage 1 harness (G1 not yet passed)

`test/spikes/codex-app-server.mjs` is the stage 1 manual qualification harness. It sits outside the default test glob and runs one agreed case group at a time in the foreground. Running a native case needs the user's own explicit agreement, because it uses the host's `codex`, environment, Codex home, configuration, login, MCP servers, remote-control and multi-agent settings exactly as production does. Turns are provider requests on that login and quota, with a cost Codex does not report (USD unknown), and every thread may leave rollouts, logs or state in the existing Codex home.

```bash
node test/spikes/codex-app-server.mjs --list                      # catalogue only; exits 2
node test/spikes/codex-app-server.mjs --run --case model-free     # Q1, Q2, Q7, Q9: no turn
node test/spikes/codex-app-server.mjs --run --case Q6 --keep      # one model case
node test/spikes/codex-app-server.mjs --run --case Q2 --model <id>
node test/spikes/codex-app-server.mjs --run --fake --case Q1,Q2,Q4,Q6,Q7,Q9   # NOT NATIVE
```

Nothing runs without `--run` and an explicit `--case` (`all` is a deliberate value, never a default). Configuration, shutdown, approval and preflight checks are guards: they can fail a case or leave it unproven, never pass it. A case whose own measurement was skipped, for a missing option or under `--fake`, stays a skip with that reason, and a run with no measured pass exits 2. A second interrupt exits at once, printing the fixture root it leaves behind as uncertain; it cleans up and claims nothing. `--help`, `--list`, an unknown or malformed argument, a missing `--run` or a missing or unmatched `--case` exit 2 before any production module loads: no `PATH` lookup, no Codex home or configuration read, no child. Exit 0 means every selected case passed (annotated skips allowed), 1 that one failed or is unproven, 2 that none ran.

**G1** needs Q1, Q2, Q3, Q4, Q6, Q7 and Q9 to PASS natively. Q3b is optional named-effort evidence and does not block it. The harness does not re-audit the sandbox: that boundary is the user's own configuration, trusted as Claude's and Pi's are.

| Case | Model call | What it records | Native result |
| --- | --- | --- | --- |
| Q1 | no | initialize: reported Codex home against the prediction, user agent, platform, Node; a version parsed from the user agent is reported, not independently verified | PASS |
| Q2 | no | thread/start and thread/read with no request cwd, launched through a symlink: host default for implement and both ask modes, and an explicit model with `--model`; cwd bound by realpath, or the case halts before any turn | PASS; the `--model` given was the host default's own model, so the explicit leg was a named round trip, not a switch to another model |
| Q3 | yes | implement edits a fixture and writes a nonce sent only in developer instructions; checked by fixture state, unchanged `HEAD` and `git status`, never by the reply. The prompt never asks for a commit. The developer instructions are the shipped contract and addendum with the harness's nonce block appended, so they are not byte for byte what production sends | PASS |
| Q3b | yes | optional: a named `--effort` that differs from the configured default reads back exactly; skipped without one | not run |
| Q4 | yes | read-only ask answers from a fixture file: production success, `readOnly` reported, files, `HEAD` and status unchanged. The prompt attempts no write, so this is not a write-denial test. Hosted search items in the turn are counted for the log only, never gating | PASS; its recorded item types included no hosted search item (from the item-type summary, before the search line was added) |
| Q6 | yes | cancellation of a running command: the prompt asks the model to run `sleep 60` once. The harness cancels through the production signal when the first `commandExecution` item starts in the primary thread and admitted turn (under `--fake`, at turn admission). PASS needs the production verdict `aborted` and the child's actual exit report saying the host requested the stop, with the clean-shutdown guard holding. No started command is UNPROVEN. The harness sends no signal and surveys no process: production's owned cleanup is what the guard reads | PENDING |
| Q7 | no | under the production owned shutdown (SIGTERM to observed descendants first, then stdin end), the root exits by itself, with and without an open thread: status 0, no root signal. This is that shutdown's outcome, not a proof that ending stdin alone stops the process tree | PASS |
| Q9 | no | an untrusted fixture cwd with no request cwd: `config.toml` bytes unchanged, no trust entry naming the fixture, sandbox and approval kept | PASS |

The native results above were measured with the harness as of commit `c2f2477`, before the probe-diagnostics commit `5af04e5` and before the cases were trimmed to this list; the case definitions they ran under match the rows above except where a row says otherwise. They come from one Linux x64 host running Node 24.18, with the child's user agent reporting app-server 0.160 (reported, not independently verified), under the user's own host-default selection. They are manual measurements of that install, not a qualification of the backend, a cost or context-window figure, or a lifecycle guarantee. An earlier sandbox-probe case, Q5, ran once natively and was UNPROVEN. Its scratch log is kept; its fixtures were removed after a clean owned shutdown, as the log records. That result is evidence neither of success nor of a backend failure, and Q5 is no longer a case or part of G1.

Every case hashes `config.toml` in the predicted home before and after and fails on a change. The harness writes, copies or prints no configuration, credential or environment; beyond the hash it only checks whether `config.toml` names Q9's fixture path, as a yes or no. Selection comes only from its flags, and no model or effort catalogue is guessed. The fixture root is removed only after every child the harness was handed is proved over: a clean actual exit, no leftovers, discovery ok, and closed pipes. Any concern, including a missing exit report, keeps and names it, whichever branch the case left by. `--fake` drives `test/fake-codex.mjs` by path through the production transport and backend; its output is labelled NOT NATIVE and qualifies nothing.

A fallback that names the cwd is considered only if Q2 fails, and only with the user's consent, because it may write a trust entry. Stages 2 and 3 (Q10 onward) are not implemented; Q14 (cache write vs input) stays a later native gate before any lifecycle or cap behavior relies on it. Whether `codex resume <thread id>` reopens an app-server thread remains a manual, non-gating follow-up. Until a gate passes, nothing here claims native qualification, cost or context-window guarantees.

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
