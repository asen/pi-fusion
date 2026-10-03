# pi-fusion

A Pi extension in which the host model hands work to headless coding sessions and manages them while they work.

## Language

**Host**:
The Pi model that talks with the user and decides which work to hand off.
_Avoid_: orchestrator, main model, parent

**Child**:
A headless coding session that does work the host handed off: a Claude Code session, or a Pi session when the call names the `pi` backend.
_Avoid_: subagent, worker, delegate

**Backend**:
The harness a child runs in, named in every record and route: `claude` and `pi`, both registered in this build. A call that names no backend runs on `claude`, which runs every role but `security`; `pi` runs `plan`, `implement`, `ask` and `security`, on the user's own Pi provider configuration, and a `security` call goes there whether or not it names a backend, because no other backend runs that role. A fresh Pi run is one a call asked for by name, and a continuation stays on the backend its record names, `pi` included, whether or not the call names one. A backend owns its own session shape, model binding and stream; the host owns handles, records and scheduling.
_Avoid_: adapter, provider, harness, runtime

**Role**:
The job a child does: `plan`, `implement`, `ultracode`, `ask` or `security`. A role fixes the child's contract, tools and default model and effort, says which backends may run it, whether it takes the file-changing slot and whether a review reads it. `ultracode` runs on `claude` alone and `security` on `pi` alone; the user asks for `security`, and the host never picks it on its own judgement.
_Avoid_: agent type, tool, persona

**Run**:
One piece of work a child does for the host, from the host's call to the child's report or failure. Continuing a run adds a turn to the same child session.
_Avoid_: job, task, call

**Handle**:
The short name the host uses to refer to a run, such as `run-3`.
_Avoid_: session id, run id, ticket

**Background run**:
A run that goes on after the host's tool call returns, so the host can keep talking with the user.
_Avoid_: async run, detached run

**Question**:
A request for a decision that a child sends to the host while it works.
_Avoid_: escalation, prompt, elicitation

**Waiting**:
The state of a run whose child has an open question and does no work until it gets an answer.
_Avoid_: blocked, paused, suspended

**Answer**:
The reply a question gets, from the host through `fusion_control message` or from the user through `/fusion answer`. A question takes one answer; whoever is second is told who answered first.
_Avoid_: reply, response, decision

**Handoff**:
A `plan` call that starts a fresh run on the same backend, carrying the replaced run's last report, rather than continue the last plan run, for one of two reasons: that run's context has passed its cap, or the call names a model other than the one it runs on. The fresh run is a new run in every other way: its own handle, its own session and its own binding — a Claude run carries its own chosen model onto the fresh run a cap hands off to, while a Pi run's fresh binding reads the call and its variables again. A `continue` call names its run and is warned instead, never handed off.
_Avoid_: rollover, compaction, reset

**Escalation**:
The part of an `implement` report that says the task needs a wider scope or a design decision. The run ends; it does not wait.
_Avoid_: question, blocker

**Steer**:
A message from the host to a running child when the child has no open question. The child reads it at its next model turn.
_Avoid_: interrupt, nudge, follow-up

**Review run**:
A background `ask` run that reviews the working-tree change of an ended `implement`, `ultracode` or `security` run. The user starts one with `/fusion review`, or the extension starts it with `PI_FUSION_AUTO_REVIEW`. It gets its own handle and links to the run it reviews. Which backend it runs on is the reviewed run's role's: an `implement` or `ultracode` run keeps the Claude reviewer it has always had, and a `security` run is reviewed on `pi` with the model that run itself ran with.
_Avoid_: self-review, verification, QA run

**History**:
The opt-in on-disk record of a Pi session's runs that a later Pi process on the same session reads: the earlier processes' runs, what they spent and their dashboard entries.
_Avoid_: log, cache, transcript
