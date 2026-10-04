# Questions a child asks

Every delegated Claude or Pi child gets `ask_orchestrator(question)`; a Codex child gets none ([below](#on-codex)). It asks for a small decision missing from its brief, such as a name or choice between options. The tool call stays open, retaining the child's context, until an answer arrives. Wider scope or an unresolved design decision instead belongs in an implementer's **Escalation** report, which ends the run.

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

A Codex child has no question tool and takes no steer: nothing is sent to it while it runs. Its role contract is followed by `contracts/codex-no-questions.md`, which tells it to stop when it cannot go on without a decision and report the question, its options, and its recommendation under **Escalation** (`implement`), **Open questions** (`ask` answer), or **Notes** (`ask` review). The host's guidance asks for briefs that settle every decision and for follow-ups as new runs carrying the report, not continuations. A control `message` or `/fusion steer` to a running Codex run is refused at once, sending nothing, with a pointer to `wait` and `cancel`; it does not wait for the run to end.
