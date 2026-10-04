# Questions a child asks

Every delegated child gets `ask_orchestrator(question)`; on Codex it goes through Codex's experimental API and is tested only against a fake so far ([below](#on-codex)). It asks for a small decision missing from its brief, such as a name or choice between options. The tool call stays open, retaining the child's context, until an answer arrives. Wider scope or an unresolved design decision instead belongs in an implementer's **Escalation** report, which ends the run.

```text
child asks -> run waiting -> host or user supplies one answer
                               |
                     child sees tool result and continues

cancellation / fatal Pi dialog failure -> child stopped, run ends
```

## Waiting and answering

A foreground delegation returns early with the handle/question and becomes background work. A background run announces its question unless a host control `wait` is collecting it; that wait returns the question instead. Waiting still occupies the file-changing slot when the role has one, so another coding run cannot start beside it.

The host uses a control `message` action, asking you first when the decision is yours. Generated hints use `fusion_control` for a `fusion` delegation or `claude_control` for `claude`; either control can answer every run. Further queued questions are answered in order, and an answer reply can carry the next question.

You can answer directly:

```text
/fusion answer run-3 Use the existing public name
/fusion answer run-3
/fusion answer
```

No text opens an editor titled with the question. An empty user-editor answer sends nothing and leaves the run waiting. No handle chooses the sole waiting run; when several wait, supply one.

A user answer notifies the host as a follow-up **without starting a turn**. The host reads it with its next response. A newly exposed queued question is still announced separately so that the answer notification cannot hide it.

## Exactly one answer wins

Each question has an id. Whoever answers first wins; the second attempt sends nothing and names who answered and what they supplied.

If your answer lands while the host is composing a control `message`, that message returns `The user already answered run-3's question with: ...` rather than accidentally steering the child. The host may explicitly resend if still appropriate; it then becomes a steer, or an answer if another question is now open. There is no automatic resend.

Control `status` and `wait` report `answered by the user: <text>` until the child asks its next question. Ordinary editor instructions go to the host, not directly to the waiting child. Use `/fusion answer` for an answer and `/fusion steer` for a running child with no open question.

## On Claude Code

The question tool is an in-process MCP server served by the Agent SDK. Fixed-tool roles keep strict MCP configuration with only this server; ultracode gets it beside the user's servers. Its name is allowed even outside `bypassPermissions`.

Ultracode's native `AskUserQuestion` also follows this flow through a `PreToolUse` hook. With unattended `permissionPrompts: "none"`, the SDK does not call `canUseTool`, so that is not the bridge. The hook joins questions/options into one numbered request, then supplies the original input with an answer map. One answer line per question maps separately; otherwise all questions receive the whole answer.

The MCP tool timeout is `2147483647` ms and hook timeout `2147483` seconds, about 24.8 days; these avoid ordinary short timeouts, not a literally infinite wall-clock limit. The hook otherwise defaults to ten minutes. These limits were read from Claude Code 2.1.273, not measured against its real binary; deterministic tests drive the control requests through the fake binary.

## On the pi backend

Pi's tool opens one blocking `ctx.ui.input` dialog with its call signal and no timeout, routed to the same host question flow. Text, including an empty string returned by an internal callback, is an answer; a dialog returning no answer fails the tool call.

Native UI requests contain no extension-origin identity. While questions are enabled, every eligible blocking input dialog inside the child is routed this way; Fusion cannot distinguish its own tool from other trusted code opening the same dialog shape. Unsupported methods, active timeouts, invalid/duplicate requests, and closed routing are refused rather than guessed at. All shipped delegated Pi runs have questions enabled; internal callers without a callback do not.

A Pi dialog outcome other than an admitted answer is fatal: the run stops its child and reports fixed wording with the dialog end/admission, not the question, answer, or foreign error. A cancelled run remains cancellation—cancellation outranks a simultaneous fatal question—and the recorded dialog outcome remains evidence beside it.

Manual Linux cases have measured an answered native question with a steer admitted while held, and a question held into cancellation, using a scripted loopback model. They do not qualify real providers or every version/platform. See [Pi backend evidence](pi-backend.md#evidence-and-limits); the default suite's routing doubles prove host arbitration, not native dialogs.

## On Codex

**Experimental: stage 3, implemented and tested only against the deterministic fake. Its native gate G3 has not run, so no Codex question has been measured natively.** The shapes are read from Codex 0.160.0's source.

Every delegated Codex run has a question callback, and that callback is the whole opt-in; there is no separate setting. The run's connection declares `capabilities: { experimentalApi: true }` at `initialize`. That opts the **entire connection** into Codex's experimental API, not only the question tool: running a role on Codex is your consent to it. Only a fresh thread's `thread/start` registers a tool: `ask_orchestrator`, its one dynamic tool, with the same description the Claude and Pi tools carry and one required string `question`. A fresh run's developer instructions are its role contract alone, which tells it to ask.

A resumed or forked thread gets no tool registration. 0.160.0's stable `thread/resume` and `thread/fork` take none, and Codex restores a thread's dynamic tools from its own history (source-read). A continued thread therefore has the tool only if the thread was first started with it. A thread first started without it has none, and that includes every record written before stage 3 (all G1- and G2-era threads). Nothing can add the tool to such a thread. A continuation's instructions are therefore its role contract followed by `contracts/codex-continued-questions.md`, one fallback paragraph. It says that if `ask_orchestrator` is not among the child's tools, the child must not ask in its output or go on as if answered. Instead it stops and reports the question, its options and its recommendation under **Escalation** (`implement`), **Open questions** (`plan`, `ask` answer) or **Notes** (`ask` review).

An older record stays continuable exactly as before; it is not upgraded. Nothing forks it into a new thread or guesses a reference for one. If such a run needs to ask, start a new run without `continue` (a plan call takes `fresh: true`) that carries its report: that fresh thread registers the tool.

A question arrives as the child's `item/tool/call` request. It is hosted only when it names `ask_orchestrator` with no namespace, comes from this run's own running turn, and carries a non-empty `question`. A request that arrives before the `turn/start` answer has named its turn is held until that answer names it. The question then goes into the host flow above, and the tool result is the answer as its one text item. Several questions at once each go to the host's ordinary queue.

Some calls are refused with `success: false` and a fixed text, and the run goes on:

- another thread's call (a subagent's)
- a call from another turn or from an ended one
- a namespaced call
- a call with an empty question

A call for any other tool still fails the run, like every other unsupported server request.

Cancelling a waiting run aborts the question's own signal. Inside the run's single owned shutdown, its call gets one `success: false` reply ahead of the turn interrupt. A turn that ends while a question waits ends that question the same way. A lost answer is never resent and a question is never retried. The backend does not keep or log the answer text.

A Codex run with no callback is an internal case; none ships. It declares no capability and registers no tool. It keeps `contracts/codex-no-questions.md` after its contract, which tells the child to stop when it cannot go on without a decision and to report the question, its options and its recommendation under **Escalation** (`implement`), **Open questions** (`plan`, `ask` answer) or **Notes** (`ask` review). A question call its restored tool still makes gets `success: false` and a fixed text telling the model to report the gap. The run is not failed for it.

A control `message` while a question waits is the answer. With no question open, a message or `/fusion steer` is a steer (unqualified natively): queued until the turn is admitted and sent to it once, and the turn taking it does not show the child read it ([Codex steers](codex-backend.md#steers)).
