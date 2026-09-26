# Spike: what a Pi child can promise about session lifecycle

The Pi backend proposal makes its session semantics conditional on a measurement: "the session semantics in this
document stay proposals until it reports" ([docs/pi-backend-plan.md](pi-backend-plan.md), implementation step 1).
This is that report, and the second half of a pair. [docs/pi-config-write-spike.md](pi-config-write-spike.md)
chose the child's execution shape, the public SDK bootstrap, by measuring what each way of starting a Pi child
writes outside its own directory. This spike takes that same bootstrap and measures what a child built from it can
promise: a durable checkpoint, an older checkpoint, a fork at an exact position, what survives each shape of
failure, what a navigation or a fork an extension cancelled leaves behind, a question that holds its child until
one answer arrives, a cancellation, the recovery work a run has to finish before it is done, and strict model
selection. It changes no runtime code and proposes no product
behaviour. No Pi backend exists in `extensions/fusion.ts`, and nothing here claims one does.

Findings are marked **measured** (this spike ran it against Pi 0.85.1), **source** (read in the installed Pi, not
executed here) or **untested** (neither). One more label has no counterpart in the configuration-write spike:
**simulated Fusion policy**. The record rules of `extensions/fusion.ts` (`nextSession`, `recordRun`, fixed by
`test/session.test.ts`) have no Pi implementation, so an in-harness ledger re-implements them and prints every
decision it makes as a simulation. Only the Pi side is measured: what a restore contains, what a fork contains,
what goes out on the wire, what a failure leaves behind, what a cancellation reaches. Where the two disagree this
page says so, and in one place they do.

## Reproducing

```bash
node test/spikes/pi-session-lifecycle.mjs                        # all ten cases
node test/spikes/pi-session-lifecycle.mjs --list                 # the catalogue; exit 2, because it runs no case
node test/spikes/pi-session-lifecycle.mjs --case row3-fork-at    # one case
node test/spikes/pi-session-lifecycle.mjs --case=stage-b --keep  # one group, keep the temp root
node test/spikes/pi-session-lifecycle.mjs --case row4-cancelled-operations   # the cancellation case
```

The harness is a manual one: it spawns real Pi processes, so it stays out of `npm test`, whose glob is
`test/*.test.ts`. It exits 0 only when every selected case is a measured pass, 1 when a case failed or is
unproven, and 2 whenever no case ran at all: an unmatched `--case`, a `--case` with no value, an unrecognised
argument, or `--list`. `--case row3-fork-at` and `--case=row3-fork-at` are the same argument, and an argument the
harness does not recognise is refused rather than ignored, because a silently ignored `--case=nope` would run all
ten cases and exit 0 for a command line that named nothing. A full run takes about 51 seconds.

The Pi under test is pinned to the repository's dependency, 0.85.1, resolved through the package's public entry
point (`import.meta.resolve`), and the harness prints the version it resolved on every run. It never runs
`dist/bundle/cli.js`. Node was v24.18.0. Nothing here is evidence about any other Pi version.

Every child is the public SDK bootstrap, generated into a disposable temp root that also holds `HOME`,
`USERPROFILE`, the child's own agent directory (`PI_CODING_AGENT_DIR`, one per case, seeded with an `AGENTS.md`
sentinel), the fake user profile that `models.json` is read from, the fake project that is the child's cwd, the
session directory, `TMPDIR`, the XDG directories and both compile caches. The environment is built from scratch
(`PATH`, `NO_COLOR`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and a dummy
`SPIKE_FIXTURE_KEY`), so no real provider variable reaches a child. Settings are in memory, the key arrives as an
environment variable, and `authPath` points inside the child's own agent directory, so the fake profile's
`settings.json` and `auth.json` are decoys that nothing reads.

Two kinds of path are checked against the root before anything launches: every environment variable that names
one, and every path field of the bootstrap configuration (`cwd`, `agentDir`, `sessionDir`, `authPath`,
`modelsPath`, `modelsStorePath`). A path outside the root is a refusal, not a warning. Because every path a case
builds is derived from the root, that refusal branch is unreachable from a passing case, so the harness measures
it on every run before the first case: a containment self-test requires a path in `os.tmpdir()` to be refused and
a path inside the root to be accepted, and refuses to launch otherwise.

The only model endpoint is a scripted loopback OpenAI-completions server on `127.0.0.1`. Each phase installs an
ordered script; a request with no script left gets a 500 and is recorded, and every phase asserts that it saw no
such request, so no case can pass because a request went missing. The fixture's recorded payloads are the primary
evidence for every claim about what goes out. The bridge can also log an in-child view of the outgoing payload
through `before_provider_request` when `PI_SPIKE_LOG_PROVIDER_REQUESTS=1`, which is supplemental only and is off
in every run reported here.

The cancellation case needs an extension that refuses a session operation, so the same generated bridge registers
`session_before_tree` and `session_before_fork` handlers that answer `{ cancel: true }`, but only for the hooks
named in `PI_SPIKE_CANCEL_HOOKS`. A child that names neither, which is every other case and the cancellation
case's own positive control, registers no handler for them at all, which is what Pi's `hasHandlers()` fast path
checks, so the control runs against an absent hook rather than a passive one. That variable is the harness's own
switch, set per child and never a path, and each firing is notified before the hook answers, so "the hook ran" is
evidence in the stream rather than something inferred from the operation's result.

What the harness does not do is sandbox anything. It guarantees, and measures rather than asserts, that the fake
user profile and the fake project are byte-identical after every case, and that the `AGENTS.md` sentinel in every
agent directory a child was actually pointed at still has its original bytes. Those guards run in the runner's
`finally`, so a case that threw is checked too, and a second self-test on every run modifies a sentinel of the
harness's own and requires the guard to report it. The agent directories themselves cannot be required
byte-identical, and that is measured rather than assumed: Pi writes `auth.json` and `models-store.json` into
whichever one it is given. Nothing here constrains what a child's tools can write, and this page makes no
sandboxing claim.

Cleanup is bounded and runs on success, on failure, on the global 10-minute deadline and on `SIGINT`, `SIGTERM`
or `SIGHUP`: the fixture sockets close, every pid the harness recorded is killed by group and by pid, and the
temp root is removed unless `--keep` was given. Only pids the harness started and whose `/proc` start time still
matches are signalled, so a reaped and recycled pid cannot be mistaken for one of its own. Row 6's descendants
report their own pids through files; each pid is registered the moment its own file is readable, and cleanup then
sweeps those files as a last resort, terminating any live pid they name whose `/proc` environment still mentions
this run's temp root. One window remains and cannot be closed from outside: a descendant exists for a moment
before it writes the file that names it.

## The case matrix

Pi 0.85.1 on node v24.18.0, Linux, 2026-09-26. Ten cases cover the eight acceptance rows; row 2 has two, because
a compacted run's checkpoint behaves differently from an ordinary one, and row 4 has two, because an operation an
extension cancelled is refused in a different way from one that failed. Every result below is taken from the full
run this page's Verification section records, not from any earlier report.

| Row | Harness case | Result | Primary evidence |
| --- | --- | --- | --- |
| 1 completed-call durable checkpoint | `row1-durable-checkpoint` | measured pass | HTTP payload role sequence, JSONL tree, preflight exit codes, a read-only `open()` probe |
| 2 older checkpoint after later turns | `row2-older-checkpoint` | measured pass | HTTP payload, JSONL sibling branch, leaf read-back |
| 2 checkpoint at a compaction | `row2-compaction-checkpoint` | measured pass | event order, HTTP payloads restored both ways, JSONL tree |
| 3 exact-position fork | `row3-fork-at` | measured pass | JSONL entry ids and header, file hashes before and after, HTTP payloads |
| 4 failed continuation and the other failure shapes | `row4-failures` | measured pass | JSONL tree, HTTP payload roles, `extension_error` events, RPC state read-back |
| 4 a cancelled navigation and a cancelled fork | `row4-cancelled-operations` | measured pass | hook-firing notifications, `cancelled` in the command results, request counts in a quiet window, session-directory snapshots, a positive control with no hook |
| 5 questions that hold their child | `row5-questions` | measured pass | request counts inside measured windows, `tool_call_id` correlation, message positions |
| 6 cancellation | `row6-cancellation` | measured pass | `clear_queue` payload, request counts, recorded pids and their liveness |
| 7 retry and automatic compaction before settled completion | `row7-retry-compaction` | measured pass | event order, after a quiet window in the retry, overflow and queued-work phases, request counts, summary request shape, stats deltas |
| 8 strict model and thinking checks | `row8-model-thinking` | measured pass | RPC responses and read-backs for four rejected selections, `model_change` and `thinking_level_change` entries, system content sentinels |

Ten of ten are measured passes, and the harness prints `10/10 selected rows are measured passes`. Several claims
*inside* those rows are not measurements, and a passing row must not be read as covering them:

| Row | Claim | Status | Reason |
| --- | --- | --- | --- |
| 1, 2, 3, 4 | every record decision the ledger makes | simulated Fusion policy | no Pi backend exists; the ledger re-implements `nextSession` and `recordRun` and labels each line |
| 2 | `/tree` stays refused while a run is unfinished | unproven | there is no host in the harness; only the record *selection* a `/tree` move makes can be simulated, and its effect on the child measured |
| 3 | a forked host gets its own child session on first use | simulated Fusion policy | the fork's measured half is its content; the first-use rule needs a host |
| 3 | the fork id the record should carry | measured incompatible | Pi allocates the id itself, see row 3 below |
| 4 | what a record with no checkpoint should mean for Fusion | measured; the Fusion rule is user-approved policy | Pi's behaviour is measured here; the rule that a Pi record with no trusted checkpoint fails closed is approved product policy, recorded in the plan, and not implemented |
| 4 | the guard that refuses to submit a task after a cancelled operation | simulated Fusion policy | the guard is a harness function; what is measured is that Pi reported the cancellation and that no request and no durable write followed |
| 6 | Pi's own `SIGTERM` and `SIGHUP` cleanup path | source | `killTrackedDetachedChildren` is registered by `runRpcMode` for those signals and is itself a group kill; not exercised here |
| 7 | manual compaction | not used | manual compact is no evidence about automatic ordering, so the case drives the automatic threshold and overflow paths instead |
| all | anything a real provider does | unproven | a loopback fixture cannot show it, see the gaps section |

## What each row proved

Entry ids and session ids below are from the recorded run. They, and the session-file hashes a case compares,
change on every run, because a session file carries both; the shapes do not, and no claim rests on a particular
value. The seeded sentinel hashes in the verification section are the exception: that content is fixed.

### Row 1: a completed call's checkpoint survives the child process

**A checkpoint is the leaf at settle, and the leaf is not persisted.** Measured, evidence: RPC state read-back
plus the JSONL tree. The first call settled at leaf `cdbca3ac` and the second at `650282f8`; a third call failed
and left `0df53dc4`, an assistant entry with no content. A new child process reopening that file reported its leaf
as `0df53dc4`, the file's last line, not the recorded `650282f8`. Restoration is therefore not optional and not
free: an adapter has to re-establish the checkpoint with `navigateTree` on every start, and the postcondition the
plan asks for, leaf equals the recorded checkpoint, is the only thing that proves it happened.

**The restored call sends exactly the recorded context.** Measured, evidence: the fixture's received payload. After
restoring `650282f8`, the outgoing roles were `["system","user","assistant","user","assistant","user"]`, carrying
both earlier turns and the new prompt, with the abandoned prompt and the provider's error text both absent.

**`SessionManager.open` on a path that does not exist starts a different session instead of failing.** Measured,
evidence: a read-only probe through the public API, which reported `threw false`, `entryCount 0`, a brand new
session id bound to the missing path and no file created. A checkpoint id that is absent from an existing file
fails differently: `navigateTree` throws inside a live session and surfaces as its own `extension_error` (measured,
row 4), so that one is detectable where the missing file is silent. The bootstrap preflights both and exits 3 with
`SPIKE_PREFLIGHT_REFUSED`, measured for a missing file and for an unknown id. Any adapter needs the same
fail-closed step; opening and hoping silently gives the child an empty context.

**Session statistics sum the whole file, so accounting has to be a delta.** Measured, evidence: `get_session_stats`
read after the restore and before the prompt, against the usage the fixture sent. Each call's delta was
`{"input":120,"output":8,"total":128}` while the absolute total after two calls was 256. Source for the rest of
the claim, and the reason a delta is the only per-call number: `getSessionStats` loops over every entry the
session manager holds, not over the current branch, and adds the usage of every assistant message, tool result
and compaction entry it finds, so entries on an abandoned branch and a failed attempt's own entry are counted
too. This run cannot measure that half, because the fixture's error responses carry no usage at all. Cost was
`0.000136` with the price table printed beside it from the case's `models.json`, so a zero would read as "no
price", not as "free".

### Row 2: an older checkpoint, and a checkpoint that is a compaction

**Restoring an older checkpoint excludes the later turn and keeps it.** Measured, evidence: the fixture payload
plus the JSONL tree. With T1 at `7d848080` and T2 at `836dca2e`, a restart that restored T1 sent
`["system","user","assistant","user"]`, carrying T1's turn and neither T2's prompt nor T2's answer; the durable
file then held T2 and T3 as two children of `7d848080`. A host `/tree` move that selects an earlier record is
therefore expressible on Pi: simulated Fusion policy for the selection, measured for the effect. Labelled
comparison, measured: `SessionManager.branch()` called in the bootstrap before the session is built reaches the
same leaf, which is not the mechanism the plan intends to use.

**A compacted call's checkpoint is the compaction entry, not the last assistant message.** Measured, evidence:
event order, the JSONL tree and two restores of the same file. Automatic compaction appended a `compaction` entry
(`80c1fb05`) as a child of the last assistant message (`ce216250`) and left it as the leaf, so a checkpoint
recorded as "the last assistant message" is that entry's *ancestor*. Restoring the compaction entry sent the
summary plus the retained tail; restoring the assistant message instead dropped the compaction off the branch and
rebuilt the full pre-compaction history, so the first turn was back in the payload and the compaction was undone.
The printed tree shows it: the compaction entry and the pre-compaction continuation are siblings under
`ce216250`, while the post-compaction continuation hangs off the compaction entry. (The phase label in the
harness output, "both continuations as siblings", is looser than the tree it prints.)

**A compaction entry is not self-contained in 0.85.1.** Measured: the persisted entry carries `firstKeptEntryId`
and no `retainedTail`, so the tail is read from the branch the checkpoint sits on. Consequence, measured: the
restored payload was the summary plus the entries from `firstKeptEntryId` onwards.

### Row 3: a fork at an exact position

**A fork contains exactly the checkpoint's ancestry, and the two files never touch again.** Measured, evidence:
JSONL entry ids, the fork header, file hashes and both payloads. The fork file's entries were the same ids as the
checkpoint's ancestry, entry for entry (`["007326bc","38c3f0b2","45915740","84655ec7"]`), with the same contents
re-parented, and its header's `parentSession` named the parent file. The parent's hash was unchanged while the
fork took a turn, and the fork's hash was identical before and after the parent took its own turn, which is the
assertion the case makes on both files. Neither side's payload ever carried the other's prompt.

**The fork's id is Pi's to choose, and the current record rule assumes it is the host's.** Measured by asking:
the bridge passed the id the simulated policy had allocated into `ctx.fork(entryId, { position: "at", id })` and
read back what Pi created. It asked for `a7fe67dc-4634-443f-99ef-b6f5a312570f` and got
`01a0de4b-bef2-745b-bb0f-428bb79bc827`; the option is not read. Source: `core/session-manager.js`
`createBranchedSession(leafId)` calls `createSessionId()` itself and takes no id, `agent-session-runtime`'s
`fork()` reads only `position` and `withSession`, and the command context's `fork()` forwards them unchanged,
while `extensions/fusion.ts` `nextSession` returns `{ kind: "fork", id: randomUUID(), ... }`. This is the one point
where the record rule cannot transfer unchanged: for a Pi child the record has to carry the id the child reports,
which also means a fork has no identity until the fork call returns.

### Row 4: the four failure shapes

**A failed continuation leaves an error entry on the branch and moves the leaf.** Measured, evidence: the JSONL
tree and the recovery payload. Restoring the last good checkpoint excluded both the failed prompt and the
provider's error text from the next payload. Simulated Fusion policy: recording nothing for a failed resume is
what keeps that checkpoint authoritative.

**A failed new call does persist, and reopening it whole replays the failed prompt.** Measured, evidence: the
JSONL tree, the child's context entries and the payload. The file existed and held four entries, ending in an
assistant entry with `stopReason "error"` and no content. Reopening that session whole and prompting again sent
`["system","user","user"]`: the failed prompt was replayed, the error entry was on the restored branch but not in
the request, and the result was two consecutive user messages. So "resume the whole session" is not a neutral
fallback for a Pi child. The harness asserts all three facts, so a Pi that changed any of them would report a
failure rather than a pass.

**Error entries stay in Pi's context and are dropped by this provider adapter, not by Pi.** Measured twice: in the
failed new call above, and in row 7's retry, where the successful assistant entry was written as a *child* of the
error entry, putting the error on the branch of the new leaf. Both payloads omitted it. Source:
`convertMessages` in `pi-ai/dist/api/openai-completions.js` skips an assistant message with no content and no tool
calls. That is adapter-specific and must not be generalised: the hazard Fusion inherits is a payload with two
consecutive user messages, and on another provider's adapter it could be a replayed error message instead.

**A fork that was created and whose first continuation failed is recoverable.** Measured: recording the fork's id
with the fork-at checkpoint made the next call resume the fork, and its payload carried the ancestry and not the
failed prompt. This is a different case from an invalid fork target, where no session is created at all.

**An invalid target fails the command, not the session.** Measured, evidence: `extension_error` events beside the
prompt response, and a state read-back. `navigateTree` answered `Entry zzzzzzzz not found` and `fork` answered
`Invalid entry ID for forking`, each as an `extension_error` whose `extensionPath` was `command:...` and whose
`event` was `command`, while the prompt that carried them answered `success: true`. Session id, file, leaf and entry
count were all unchanged and no provider request went out. Simulated Fusion policy: the harness sends no task
prompt after a refused restore or fork, which is why the request count stayed where it was. This is the plan's
"verify by postcondition" rule, measured: a failed navigation and a successful prompt sit side by side in the
stream.

### Row 4, cancellation variant: an operation an extension refused

The case is `row4-cancelled-operations`. Two turns settle first, so S1 (`cf7aae49`) is a real earlier checkpoint and
S2 (`5ad00358`) is the leaf, and the durable state before anything is refused is one file of seven lines, sha
`f64e3c60c92ba0f7`. The armed child then has both cancel hooks registered; the positive control at the end has
neither.

**A cancelled navigation and a cancelled fork are ordinary results, not errors.** Measured, evidence: the hook's own
notification, the command's result and the event stream. `session_before_tree` fired exactly once, reporting
`targetId cf7aae49` and `oldLeafId 5ad00358`, and `navigateTree` returned `{ cancelled: true }`; `session_before_fork`
fired exactly once, reporting the same entry id and `position "at"`, and `fork` returned `{ cancelled: true }`. In
both cases the prompt that carried the bridge command still answered `success: true` and no `extension_error` was
emitted at all. That is the difference from row 4's invalid targets, which arrive as `extension_error` events: a host
that only watches for errors, or only reads the prompt acknowledgement, sees nothing wrong here.

**A cancelled fork leaves no fork.** Measured, evidence: the state read-back and a session-directory snapshot. The
child stayed on the source session id `01a0defc-86fb-74f1-aaf4-416f97ffd3e5` and the source session file, the
session directory held the same one path before and after, and its bytes were unchanged. Source, and the reason:
`agent-session-runtime.js` `fork()` answers the cancel before it even looks the entry up and before any session
replacement, so nothing is created and nothing is torn down.

**A postcondition that holds is not evidence that an operation ran.** Measured: navigating to the entry that is
already the leaf answered `{ cancelled: false }` with zero hook firings, because `agent-session.js` `navigateTree`
returns early for a target equal to the current leaf, before the event is emitted. So "the leaf is the target" can be
true of an operation that was cancelled, of one that never happened, and of one that succeeded. The guard in this
case therefore treats `cancelled: true` as a refusal on its own, before it compares anything, and a cancel hook
cannot be relied on to observe every navigation either. Both phases assert which refusal they got, not merely that
one happened, because in this case the postconditions disagree too: with the guard's `cancelled` check deleted or
moved after the postcondition comparison, the refusal is still a refusal and only that assertion fails.

**Nothing followed either refusal: no request, no durable write, no record change.** Measured, evidence: the
fixture's request log across a stated window, the state read-back, the session-directory snapshot and a marker
search. The provider request count was 2 before the cancelled navigation, 2 after it, 2 after the cancelled fork and
still 2 after a 1500 ms quiet window. The child's session id, session file, leaf and entry count (6) were identical
to the read-back taken before the two operations, and the session directory was unchanged both while the child was
still running and after it exited. The ledger's record was identical, field for field, to the one taken before. The `ROW4C-BLOCKED-TASK` marker, which is the task the guard was
supposed to refuse to submit, appears in no recorded payload and in no file under the session directory. The two
bridge commands that carried the refused operations persist nothing of their own, which is what the unchanged line
count and the unchanged file bytes show, so the claim here is the strong one and not a marker-only one.

**The guard is exercised, not described, and a positive control shows it is not simply refusing everything.**
Measured for the control half: with no hook registered, the same guard on the same targets accepted the navigation to
`cf7aae49` and let its task reach the fixture with roles `["system","user","assistant","user"]` carrying
`ROW4C-NAV-CONTROL`, then accepted a fork at `cf7aae49`, which created `01a0defc-9136-711b-8097-e3f19f7b02c4` on its
own file, and let that fork's task reach the fixture too. Simulated Fusion policy, and labelled as such in the
output: the guard itself, the refusal-to-submit rule, and the ledger lines. The ledger kept its prior record through
both refusals, a resume that recorded nothing and a cancellation with no session id to record, so the record after
the case still names the source session at checkpoint `5ad00358`.

**What this case does not do.** It does not implement or test a Fusion adapter, and it is no evidence that Fusion
handles a cancelled navigation or fork correctly; there is no Fusion code in it. The measured half is Pi's: the hooks
ran, the operations reported themselves cancelled, the session and its transcript were untouched, no fork was
created and no provider request went out. Everything about what a host should then record or refuse to send is the
in-harness guard and ledger.

### Row 5: a question that holds its child

**The question genuinely holds the provider while the run is waiting, and exactly one answer is ever taken.**
Measured, evidence: request counts inside stated windows and `tool_call_id` correlation. With the dialog open, no
provider request arrived in a 2000 ms window (one request before, two after the answer), and the answer came back as
the tool result correlated to `call_row5_a1`. A second `extension_ui_response` with the same id, sent during the run
and again after the run settled, produced no response, no error, no event within 2000 ms, no second tool result and no
extra request. Source: `modes/rpc/rpc-mode.js` deletes the pending dialog on first use and returns silently for an id
it no longer has, so absence inside a stated window is the only available proof, and it holds. Two questions in a row
each held the child in turn, and their answers reached the next turn in order.

**A steer queued during a question lands after the tool result.** Measured: the steer was accepted while the
question waited, produced no request in the 2000 ms before the answer, and then appeared as an ordinary user
message at position 4 of 5, directly after the tool result at position 3 and last before the next assistant turn.

**This is the child protocol only.** Which side supplies the answer, host or user, is Fusion's arbitration and is
not modelled here.

### Row 6: cancellation

**Abort needs `clear_queue` first, or it restarts the run.** Measured, evidence: the `clear_queue` payload and
request counts. `clear_queue` returned the queued steer, abort answered success, and no further provider request
arrived in 2500 ms. The counterexample is measured in the same case: with a steer and a follow-up still queued,
the same abort was followed by exactly one further request carrying both of them after the cancelled tool result.

**A host must treat its own abort as the cancelled question's answer.** Measured: the tool reported
`{"outcome":"cancelled","aborted":true}`, nothing was written back on stdout for that dialog id, and the durable
tool result read `ask_orchestrator: cancelled or aborted before an answer arrived`. Source: the dialog promise's
`onAbort` resolves an `input` to `undefined`. Pi will not tell the host that the dialog is gone.

**Neither abort nor a clean shutdown reaches a descendant that left the process group.** Measured both ways,
evidence: recorded pids. A bash tool call started a shell and a `setsid` grandchild; 500 ms after Pi's abort the
liveness was `{"piChild":true,"shell":false,"grandchild":true}`, and after closing the child's stdin, a clean exit
with code 0, it was `{"shell":false,"grandchild":true}` again. Source: `utils/shell.js` `killProcessTree` is a
process-group `SIGKILL` with a per-pid `SIGKILL` fallback, no `SIGTERM` and no grace, and
`killTrackedDetachedChildren` is the same group kill, reachable in RPC mode only from Pi's own `SIGTERM` and
`SIGHUP` handlers (untested here). Measured requirement: an explicit per-pid and per-group `SIGTERM` from the
harness cleared the surviving grandchild in both phases, with the `SIGKILL` fallback available and not needed in
this run; the shell was already gone each time, killed with its group. A host that cancels a run has to record
descendant pids itself.

**The aborted bash call leaves a tool result that names the abort.** Measured: `Command aborted` in the durable
transcript.

### Row 7: what has to finish before a call is done

**`agent_settled` is the terminal event, and it waits for recovery work.** Measured, evidence: event order, with
the retry, overflow and queued-work phases each asserted after a 1500 ms quiet window so that "last" is a claim
about an interval and not about the moment an await resolved; the threshold-compaction ordering below rests on the
event order alone.

- A transient 500 with retry enabled: `agent_end{willRetry:true}`,
  `auto_retry_start{attempt:1,maxAttempts:2,delayMs:50}`, a second turn, `auto_retry_end{success:true}`, `agent_end`,
  `agent_settled`. Two requests; the retried request's roles were `["system","user"]` and carried none of the error
  text.
- Automatic threshold compaction: `agent_end`, `compaction_start{reason:"threshold"}`, `compaction_end{aborted:false}`
  with a result, then `agent_settled`. One summary request, recognised by the summarizer system prompt and by having no
  `tools` key at all; `tokensBefore 30005`, `estimatedTokensAfter 138`.
- Automatic overflow compaction: `compaction_start{reason:"overflow"}`, `compaction_end{willRetry:true}`, four requests
  (turn, overflow error, summary, retry) and one settle. The retried turn started from the summary, kept the prompt that
  overflowed and dropped the summarised turn.
- Work queued while the first turn was still streaming: the follow-up ran its own turn, and exactly one `agent_settled`
  was emitted for the pair, after it. `agent_end` is not terminal; a run that stops there stops early.

**The post-compaction checkpoint restores across a process restart.** Measured: after a restart and a
`navigateTree` to the compaction entry, the outgoing payload was the summary, then the retained turn, then the new
prompt, roles `["system","user","user","assistant","user"]`, with the summarised turn absent and the summary the
one the fixture had written.

**Context usage is unknown right after a compaction, and says so.** Measured: `contextUsage` was
`{"tokens":null,"contextWindow":40000,"percent":null}` immediately after the compaction, which the case asserts,
and it read back null again after the restart and the checkpoint restore, which the case prints without asserting.
When the nulls end is not measured here: source, `getContextUsage` trusts only an assistant usage recorded after
the latest compaction entry, so the value stays unknown until an assistant turn answers on the compacted context.
The case takes such a turn and never reads the usage again. The plan's rule, never read a missing value as the
last known one and never start a handoff on it, has a measurement behind it now; when the value comes back is a
source claim the adapter should confirm the first time it runs against a real model.

**Usage has to be counted from a baseline, and compaction is inside the call.** Measured: the threshold turn's
delta was `{"input":30120,"output":13,"total":30133}` against fixture usage of 30000+5 for the turn and 120+8 for
the summary, so `get_session_stats` adds the compaction entry's own usage. A baseline taken after the restore or
fork and before the task prompt is the only per-call number, and by the same summation an earlier call, an
abandoned branch and a failed attempt's own entry count towards the total as well (source).

**A context window at or below pi-ai's safety margin asks the provider for one output token.** Measured with a
4000-token window: the outgoing `max_tokens` was 1. Source: `pi-ai`'s `clampMaxTokensToContext` computes
`contextWindow - estimated context - 4096` and floors at 1. The child therefore asks the provider for a single
output token, so any response longer than that risks being truncated at the provider; the fixture ignores
`max_tokens`, so the live behaviour is untested. What is source-backed is the consequence for compaction: Pi
refuses a length-stopped summary (`core/compaction/compaction.js` lines 429-435, `getSummarizationFailure`:
"generation hit the token cap and the summary is incomplete"), so a window at or below the margin would make
automatic compaction fail wherever the provider honours the limit. The compaction phases deliberately run at 40000 so
the clamp cannot be mistaken for compaction behaviour, and the summary request is asserted to ask for more than
one token (it asked for 4096).

### Row 8: strict model and thinking selection

**Model selection is strict and never reaches the provider when it fails.** Measured, evidence: RPC responses and
the request log. A typo (`fixture-modl`), a wrong-case id, a glob-shaped id (`fixture-*`) and a synthetic provider
were each refused with `Model not found: ...`, and the fixture saw zero requests. The glob is the one worth
naming, because Pi does resolve patterns elsewhere: source, RPC's `set_model` finds the model by exact provider
and id in the available snapshot and resolves nothing, while `core/model-resolver.js` holds the loose paths, the
`--model` argument's substring match and its synthesis of a model carrying the requested id and another model's
prices, and the configured model scope's `minimatch`, which would match `fixture-*` against this very model. A
bootstrap child takes none of them, so a model named by pattern fails instead of drifting to a neighbour.

**The thinking level's response is not its read-back.** Measured: the model offered
`["off","minimal","low","medium","high"]`; `set_thinking_level xhigh` answered `success: true` and read back as
`high`. The response proves nothing, so the read-back is mandatory, and the clamp is silent.

**`set_model` resets the thinking level, so a role must select its model before its effort.** Measured: after the
clamp had left the level at `high`, selecting the model put it back to the settings default `off`, and the durable
`thinking_level_change` entries read `["off","high","off","medium"]`, ending at the selected `medium` and never
containing `xhigh`. Source: `AgentSession.setModel` computes a level for the new model and calls
`setThinkingLevel` unconditionally. The `model_change` entries name the exact selection.

**Context files follow the agent directory the child is given.** Measured, and measured as a difference rather
than as an absence: the project's `AGENTS.md` sentinel and the child's own agent directory sentinel were both in
the system content, the fake user profile's was not, and a control child pointed at a byte-identical copy of that
same file did carry it. Source: `core/resource-loader.js` `loadProjectContextFiles` reads the agent directory and
the ancestors of the cwd, so the fake profile stays out of the prompt because nothing names it, not because Pi
ignores a user-level context file. This agrees with the configuration-write spike.

## Constraints the results impose on an adapter

Each row below is a requirement the measurements force, not a design preference. The label says what kind of
evidence stands behind it.

| Requirement | Why | Evidence |
| --- | --- | --- |
| Preflight the session file and the checkpoint id before building a session, and fail closed | `open()` on a missing path starts a new session bound to it, and an absent checkpoint id makes `navigateTree` throw inside a live session | measured (probe, two refusals at exit 3) |
| Restore on every start, then verify the leaf, before any prompt | the leaf is not persisted; a reopened session sits at the file's last line, which after a failure is the abandoned entry | measured |
| Record the checkpoint as the leaf at settle, compaction entries included | a compacted call's leaf is the compaction entry, and its parent, the last assistant message, silently undoes the compaction when restored | measured both ways in one file |
| Take the fork's session id from the child, and treat a fork as having no identity until the call returns | `fork()` ignores a supplied id; `createBranchedSession` generates one | measured by asking, source for the reason |
| Read the event stream as first class: a prompt's `success` is an acceptance, and a failed navigation arrives as `extension_error` | an invalid target answered `success: true` on the prompt and reported the failure as its own event | measured |
| Accept a navigation or a fork only on a non-cancelled result *and* verified postconditions, and submit no task otherwise | a cancelled hook makes both return `{ cancelled: true }` with a successful prompt and no `extension_error`, and a navigation to the current leaf answers `{ cancelled: false }` without reaching the hook, so neither the result alone nor the postcondition alone is enough | measured, both directions, with a positive control |
| Treat a cancellation before a fork exists as recording nothing | the child keeps the source session id and file and no branched transcript is created, so the prior durable reference is still the only one there is | measured for the Pi half, simulated Fusion policy for the record |
| Finish a call only on `agent_settled`, after retry, compaction and queued work | `agent_end` is emitted before a retry, before a compaction and between queued turns | measured; a 1500 ms quiet window for the retry, overflow and queued-work phases |
| Send `clear_queue` before `abort` | abort with a steer and a follow-up queued produced one further provider request carrying both | measured, with the counterexample in the same case |
| Treat a host abort as the cancelled question's answer and release the question | nothing is written back for the pending dialog id; the tool's result names the cancellation | measured, source for the `onAbort` reason |
| Record a run's descendant pids and terminate them per pid | neither abort nor a clean shutdown reached a `setsid` grandchild; Pi's kill is a process-group `SIGKILL` | measured on both exit paths, source for the kill |
| Select the model before the effort, and read both back | `set_model` resets the thinking level to the settings default, and an unsupported level clamps while answering success | measured, including the durable entries |
| Take the usage baseline after the restore or fork and before the task prompt | statistics sum every entry the session holds, not the current branch, so an earlier call, an abandoned branch, a failed attempt and the compaction's own summary call are all in the total | measured for successive calls and for the compaction summary, source for the branch-wide summation |
| Treat a null `contextUsage` as unknown: no stale share, no handoff | it was null immediately after compaction and read back null again across a restart and a restore | measured, source for when the value returns |
| Require a real `contextWindow` on any model entry a role selects | at 4000 the outgoing `max_tokens` was 1, so the child asks for a single output token; a provider that honours it truncates anything longer, and Pi refuses a length-stopped compaction summary | measured for the clamp, source for the refused summary, untested against a real provider |
| Name the question tool in the run's tool list | the bridge registers `ask_orchestrator`, and the session's allowed tool names are what decide whether it exists for a run | measured that listing it works, source that the list filters |
| Decide what to do with a branch that ends in an error entry before resuming it | the entry stays in Pi's context; this provider adapter drops it and leaves two consecutive user messages | measured twice, source for the converter |
| Declare compaction settings in each role's binding | `reserveTokens` and `keepRecentTokens` decide when compaction fires and where the cut lands, and the case had to set both to place it | measured |

## What a loopback fixture cannot prove

- **No real provider was contacted.** Every response, error, usage number and delay was scripted on `127.0.0.1`.
  Rate limits, real overflow classification on a live model, real token counting, streaming under load, tool-call
  formats other than the one scripted here, and the actual behaviour of a provider that receives two consecutive
  user messages are all untested. The configured DeepSeek smoke run the plan keeps as a separate step is still the
  only thing that can show them.
- **One provider adapter.** Everything about what reaches the wire went through `openai-completions`. The dropped
  error entry is that adapter's behaviour, not Pi's.
- **One Pi version and one platform.** Pi 0.85.1 on Linux, node v24.18.0. The `setsid` half of row 6 marks itself
  unproven where `/usr/bin/setsid` is absent, and the two checks that decide whether a pid may be signalled read
  as "not ours" off Linux, where the pid-file sweep therefore finds nothing.
- **Every ledger line is simulated Fusion policy.** A row passes on what Pi did, never on what the simulation
  decided. The restore-or-fork-then-task guard in the cancellation case is the same kind of stand-in: it is a
  harness function, so the case is evidence about Pi's cancellation and about what did not follow it, and no
  evidence at all that a Fusion adapter would refuse the same way.
- **The `/tree` refusal is not exercisable.** Fusion refuses `/tree` while any run is unfinished. There is no host
  here, so the spike can simulate the record selection a `/tree` move makes and measure its effect on the child,
  and nothing about the refusal.
- **The known integration gap is untouched.** A child launch that throws before the run callback leaves only an
  in-memory high-water mark. That is a Fusion-side gap recorded in the plan, not something this harness can close.
- **Question arbitration is out of scope.** The spike proves the child protocol: one answer is taken and later
  ones are dropped. Which side supplies it is Fusion's arbitration.
- **No sandbox claim.** The byte-identity guarantee covers the fake user profile, the fake project and the
  sentinels inside the agent directories this harness created, over the operations these cases perform.
- **The window before a descendant reports its pid.** A process exists for a moment before it writes the file that
  names it. Nothing outside the process can close that window.

## Open design decisions

These are decisions, not missing measurements, unless the entry says otherwise.

The first three have since been decided by the user, as product policy rather than as anything this spike measured.
They are recorded under "Recovery and identity transport" in [docs/pi-backend-plan.md](pi-backend-plan.md), no Pi
backend implements them, and no measurement on this page changed. The entries after them are still open.

- **What a record with no checkpoint means for a Pi child.** The measurement is in: reopening a failed new call's
  session whole replays the failed prompt and produces two consecutive user messages. **Settled, user-approved
  policy:** a Pi record naming a session with no trusted checkpoint fails closed; the session reference and its
  transcript are kept for diagnostics, and the next call for that handle is refused with guidance to start a new
  run under a new handle. The Claude backend's whole-session resume is not carried over.
- **How the child-reported fork id reaches the record.** Who allocates it is measured and settled: Pi does, and
  the record carries what the child reports rather than the child being made to accept an id. A fork has no
  identity until the fork call returns, so the record cannot be pre-allocated the way `nextSession` allocates one
  today. **Settled, user-approved policy:** the identity travels in the structured outcome a run returns, failure
  and cancellation outcomes included, and the host writes the record from it during finalization.
- **Whether a branch that ends in an error entry may be resumed at all**, given that the payload hazard is
  adapter-specific. **Settled, user-approved policy:** only a trusted checkpoint is restored, so an error entry
  later in the file does not make the session unusable, while the failed tip and a record with no trusted
  checkpoint are never resumed.
- **The OAuth write policy.** Carried over from the configuration-write spike and untouched here: a shared
  `auth.json` has its token rotated in place by the credential store (source, no fixture exists). Whether Fusion
  shares a credential that can rotate, requires the child to hold its own, or refuses the case is pending, and no
  policy for it is approved.
- **The `PI_FUSION_PI_BIN` override design.** The plan removed it with the CLI entry point and says the
  deterministic tests still need a way to name a child process of their own. Nothing here settles it: this harness
  generates its own bootstrap file and points node at it, which is a spike convenience and not a proposal.
  Pending.
- **Project trust and the rest of the system prompt.** The bootstrap's child trusts the project unless Fusion says
  otherwise, and this spike measured only the context files (project and agent directory in, fake profile out).
  What else the CLI contributed that the bootstrap does not, and which built-in extensions a role passes, are still
  pending, and the trust value a binding declares is a decision against that default.
- **Which context window and compaction settings each role's binding declares**, given that a small window clamps
  `max_tokens` to 1, so the child asks for a single output token and automatic compaction fails wherever the
  provider honours it, and that the cut point depends on `keepRecentTokens`.
- **Who records a run's descendant pids, and when they are terminated**, since Pi's own cleanup stops at the
  process-group boundary and its graceful path is a group kill too.
- **Whether the child directory and the session directory are per host session, per role or per run**, carried
  over from the configuration-write spike. Both accumulate; this harness gave every case its own and deleted them.

## Go or no-go for implementation step 2

**Go.** Implementation step 1 of the plan is complete: the configuration-write spike chose the execution shape and
this spike measured the session semantics that step's gate named. Every case is a measured pass, no case failed
and the harness marked none unproven: nine of nine when this go was written, and ten of ten since the cancellation
case was added to the same matrix. What stays outside measurement is named in the matrix above and in the two
sections that follow it, and none of it is a Pi session semantic the adapter would have to guess at. The
conditions attached to that go are these.

1. Step 2 extracts the backend boundary and the process-tree helper and touches no Pi code. It must keep every
   Claude behaviour and the deterministic suite green; this spike adds no file to the `test/*.test.ts` glob.
2. The process-tree helper is the one part of step 2 the measurements constrain directly. It has to carry the
   descendant requirement: record a run's descendant pids and terminate them per pid as well as per group, because
   neither a Pi abort nor a clean child shutdown reaches a descendant that left the group.
3. The backend interface step 2 extracts has to be able to express, without a Claude-shaped assumption: a
   checkpoint that is any durable entry rather than an assistant message; a session id that the child chooses when
   it forks; a restore-and-verify step before any prompt; a terminal event that is not the end of the output; and a
   per-call usage baseline. All five are measured requirements above, and a boundary that cannot express them would
   have to be reopened in step 4.
4. Two record-rule questions must be settled before step 3 writes tagged records, not after: how a fork id the
   child reports reaches `nextSession` and the tagged record, given that a fork has no identity until the call
   returns, and what a record with no checkpoint means for a Pi child. Both are named in the decisions above, and
   both have since been answered by user-approved policy in the plan; this condition is met on the policy side,
   and step 3 still has to implement and verify it.
5. The gate is against Pi 0.85.1. Re-run this harness against whatever Pi version Fusion ships with and require
   every case to pass, which is 10/10 in the current matrix and was 9/9 when this go was given; a different
   version is outside what was measured, and the plan's startup capability check is what turns that into an
   actionable error rather than a surprise.

No-go conditions: a harness run in which any case fails on the Pi version being targeted, or a decision to
build the adapter on a checkpoint rule other than "the leaf at settle", which the compaction measurement rules out.

What is still gated after step 2, and where it is gated, because nothing on this page closes any of it. The plan
carries an explicit acceptance gate on step 3 and another on step 4, and these measurements feed both. Step 3's
gate covered the recovery for a failed first call that has an identity and no checkpoint, the path a
child-reported session identity travels into the record, and, from the cancellation case, that a cancelled
operation records nothing and leaves the prior durable reference authoritative; its policy is now settled in the
plan, and its implementation and verification are not. Step 4's gate settles the descendant ownership strategy,
identity-safe late signals, cleanup after a normal exit as well as an abort, the
`clear_queue`-before-`abort` shutdown ordering, and the guard this harness only simulates: a Pi adapter has to
refuse a cancelled navigation or fork itself, before any task prompt, and no Fusion code does that today.

## Verification

Run on 2026-09-26 against Pi 0.85.1 on node v24.18.0, Linux. Every command ran in the foreground, one after
another, never concurrently with `npm test`, and no command was backgrounded. The numbers below are the final
sequential verification of this page; where a bullet reports an earlier run it says so.

- `node test/spikes/pi-session-lifecycle.mjs --case row4-cancelled-operations`, the case this revision adds, run
  before the full harness: exit 0, `1/1 selected rows are measured passes`.
- The same case against two deliberate mutations of its own guard, to show the cancellation assertions bite rather
  than riding on a postcondition that also disagreed: with the guard's `cancelled` check deleted, exit 1 with
  exactly two failures, both "the guard refused ... for another reason than its cancellation"; with that check
  moved after the postcondition comparison instead, exit 1 with the same two failures and no others. The check was
  restored and the case re-run to exit 0 with `1/1 selected rows are measured passes`; neither mutation is in the
  harness.
- `node test/spikes/pi-session-lifecycle.mjs` (all ten cases): exit 0, `10/10 selected rows are measured passes`,
  440 lines of output, 51 s wall clock, no `FAIL` line, no case marked unproven, no leaked process and no temp
  root left behind. The row values quoted on this page are from that run, and an independent full rerun of the ten
  cases also exited 0 with `10/10 selected rows are measured passes` in 440 lines and 51 s.
- The earlier revision's numbers, kept as the record of the nine-case matrix: `node
  test/spikes/pi-session-lifecycle.mjs` exited 0 with `9/9 selected rows are measured passes`, 394 lines of output
  and 48 s wall clock, and an independent full rerun also exited 0 with all nine cases measured passes;
  `--case row7-retry-compaction`, the one case that revision's text touched, exited 0 with
  `1/1 selected rows are measured passes` and no assertion changed.
- An earlier run measured the value this page stopped quoting:
  `--case row3-fork-at` twice, each exit 0 with `1/1 selected rows are measured passes`, printing
  `fork file sha before/after the original's turn: 9db79a8056762950 / 9db79a8056762950` and then
  `43aa6c8d2bb8c951 / 43aa6c8d2bb8c951`. Equal within a run, different between runs, because a session file
  carries its own ids and timestamps, which is why row 3's claim is the equality and never a particular hash.
- Both self-tests printed before the first case, which is what makes two safety claims measurements rather than
  assertions: the containment guard refused a path in `os.tmpdir()` and accepted one inside the root, and the
  sentinel guard reported a deliberately modified file (`4a7ed79667172211 -> 4eef38fc68b7f333`).
- `--list`: exit 2 after printing ten cases and two groups, with `row4-cancelled-operations` in `stage-a`. The
  rest of the exit-code contract is unchanged by this revision and was measured in the same way earlier:
  `--case nope` exit 2 with `no case or group is named nope`; `--case=nope` exit 2 with the same line; `--case`
  and `--case --keep` exit 2 with `--case needs a case or group name`; `--bogus` exit 2 with
  `unrecognised argument(s): --bogus`.
- Row 6's conditional unproven branch did not fire: `/usr/bin/setsid` is present on this machine, so the
  detached-descendant half is measured rather than skipped, and Pi's abort still fails to reach the grandchild.
- `npm run typecheck`: exit 0, clean. The harness is an `.mjs` file outside the `include` globs, so it is not
  typechecked, by design.
- `npm test`, two runs, both exit 0: 333 tests, 333 pass, 0 fail, 0 skipped, so the browser cases ran, and neither
  run hit the click flake below. Nothing under `extensions/` and nothing in the `test/*.test.ts` glob changed in
  this revision; the harness and this page are outside both.
- The earlier revision's `npm test`, kept as the record of the flakes it hit, when the suite held 325 tests. Three
  runs. Run 1: exit 1, 325 tests, 324 pass, 1 fail, 0 skipped; the failure was
  `test/browser.test.ts` "a run's tasks are drawn on a timeline of the run", reporting
  `the page threw: TypeError: Cannot read properties of undefined (reading 'click')`. Run 2: exit 1, 324 of 325,
  0 skipped, with a different browser case, "the log stays in place when its entry count gains a digit", failing
  on the same click `TypeError`. `node --test test/browser.test.ts` on its own: exit 0, 27 of 27. Run 3: exit 0,
  325 of 325, 0 skipped. That click is the headless-Chrome flake the configuration-write spike already recorded,
  and nothing in the `test/*.test.ts` glob and nothing under `extensions/` changed in this work, so it is neither a
  pass nor a regression but a flake, recorded as one.
- An earlier run, before this revision, hit the other flake that spike recorded: `test/extension.test.ts`
  "/fusion dashboard stop closes the server" asserted the socket error code `ECONNREFUSED` and got
  `UND_ERR_SOCKET`, and passed on the next run. It did not recur in the three runs above.
- The browser tests **ran** rather than skipping: Chrome is installed at `/usr/bin/google-chrome`, and the suite
  reported `skipped 0` in every run with `test/browser.test.ts`'s own cases in the output, which is also where the
  click flake landed.
- No leaked process after any command. `pgrep -af` for `pi-session-lifecycle`, `pi-config-writes`, `bootstrap`,
  `fake-claude` and `dist/bundle/cli.js`, and `pgrep -af sleep`, matched nothing but the invoking shell. Listing
  the temp roots, both the `pi-session-spike-` prefix and the `outside-the-root` one the containment self-test
  names, found nothing. No headless Chrome and no process holding a `--user-data-dir` under `/tmp` survived the
  suite, and nothing had to be killed.
- What isolation is actually claimed, and all of it: every environment variable a child gets and every path the
  bootstrap configuration names are inside the temp root, because anything outside it is refused, which the
  containment self-test measures on every run; and the fake user profile, the fake project and the agent-directory
  sentinels are byte-identical after every case. Nothing here monitors the whole home directory, and this page
  makes no claim stronger than that.
