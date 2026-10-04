# pi-fusion vocabulary

Use these terms consistently in code, tool messages, and documentation. Behavioral detail belongs in the linked topic pages, not in competing definitions here.

## Language

**Host**:
The Pi model that talks with the user and decides which work to hand off. No particular model/provider is required.
_Avoid_: orchestrator, main model, parent

**Child**:
A headless coding session doing work the host handed off: Claude Code or Pi, according to its backend.
_Avoid_: subagent, worker, delegate

**Backend**:
The implementation that runs a child: `claude`, `pi`, or `codex`. Claude and Pi are registered; this build names Codex in settings and records but runs no Codex child yet, so a call routed there is refused as unavailable before anything starts. Fresh calls use the role's configured backend unless explicitly overridden; continuations stay on their recorded backend. A backend owns its session shape, binding, and protocol; the host owns handles, records, and scheduling. See [Profiles](docs/profiles.md).
_Avoid_: adapter, provider, harness, runtime (as synonyms for backend)

**Role**:
The job a child does: `plan`, `implement`, `ultracode`, `ask`, or `security`. Role metadata defines supported backends, tools, contract, and writer/review eligibility; session settings choose enabled state, backend, model, and effort. `ultracode` is Claude-only. `security` is Pi-only, disabled in `builtin`, and used only for an explicit security request once enabled. Codex supports `implement` and `ask` only.
_Avoid_: agent type, tool, persona

**Run**:
One piece of work from delegation to report or failure. Continuing a handle adds a turn to the recorded child session, through a new backend invocation.
_Avoid_: job, task, call (as synonyms for run)

**Handle**:
The short name used to refer to a run, such as `run-3`. It is not the child's session identity.
_Avoid_: session id, run id, ticket

**Background run**:
A run that goes on after the host's delegation call returns, so the host can keep talking with the user.
_Avoid_: async run, detached run

**Question**:
A request for a small decision a child sends while it works. It is not an escalation that ends the run.
_Avoid_: escalation, prompt, elicitation

**Waiting**:
The state of a run with an open question; its child waits for an answer and retains the active file-changing slot when applicable.
_Avoid_: blocked, paused, suspended

**Answer**:
The text supplied to a question through a control tool's `message` action or `/fusion answer`. Exactly one answer wins; a later attempt is told who answered first.
_Avoid_: reply, response, decision (as synonyms for answer)

**Handoff**:
An implicit `plan` continuation replaced by a fresh run on the same backend because of the context cap or an explicitly changed model. It carries the last agreed report, not the old transcript. A cap handoff preserves the planner's model; Pi also preserves its recorded thinking level unless overridden, while Claude uses the call's effort or that backend's fresh-run defaults. Explicit `continue` is warned, never handed off. See [The context cap](docs/runs.md#the-context-cap).
_Avoid_: rollover, compaction, reset

**Escalation**:
The part of an `implement` report saying the task needs wider scope or an unresolved design decision. The run ends rather than waiting or widening its brief.
_Avoid_: question, blocker

**Steer**:
Text sent to a running child with no open question. Acceptance for delivery does not prove model consumption or action; a late steer can remain unread. Ordinary editor text targets the host. See [Background controls](docs/runs.md#background-runs).
_Avoid_: interrupt, nudge, follow-up

**Review run**:
A fresh background `ask` run in review mode, linked to the ended `implement`, `ultracode`, or `security` run it reviews. It uses this session's configured **ask** backend, model, and effort, inheriting nothing from the reviewed run. `/fusion review` starts one manually; `PI_FUSION_AUTO_REVIEW` can start one automatically. See [Independent reviews](docs/reviews.md).
_Avoid_: self-review, verification, QA run

**History**:
The opt-in disk record of a durable host Pi session's runs, used by later processes for reports, usage, and dashboard restoration. Continuation authority remains the custom entries on the host's current branch.
_Avoid_: log, cache, transcript
