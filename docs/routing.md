# Routing

This guidance applies only while Fusion is **on**. Asking for a role, model, or backend without asking for Fusion does not activate it. See [Turning Fusion on and off](fusion-command.md#turning-fusion-on-and-off).

## The host policy

How the host orchestrates — whether to delegate or work directly, when to plan, which review to run, when to stop and what to report — is the **host policy**: plain Markdown, not code. The shipped [`contracts/host.md`](../contracts/host.md) can be replaced whole by user `<agent dir>/pi-fusion/host.md`, with trusted-project `<cwd>/.pi/pi-fusion/host.md` taking priority; see [The host policy file](configuration.md#the-host-policy-file) for loading once per instance, the invalid-override warning and fallback, and what `/fusion config` shows. It is instruction to the host model, not a permission: Fusion neither enforces it nor checks compliance.

```text
fusion / claude guidelines (only while Fusion is on)
  +-- mode scope line
  +-- host policy: role-neutral lead + selected Markdown, unchanged
  +-- generated: enabled roles, backends, models, refusals
  +-- fixed operating rules
```

Both delegation tools carry the policy as the same single guideline, so a prompt with both tools active holds it once; while Fusion is off neither tool, and so no policy, is in the prompt. The generated guidance beside it states availability and these fixed rules, which no policy changes:

- Fusion mode scope and task-scoped deactivation.
- Disabled roles, unsupported backends and invalid parameters refuse before admission.
- `security` and `ultracode` run only on an explicit user request; a security task changes application code only when it authorizes fixes.
- An explicit backend, model or workflow is used or refused, never silently substituted.
- Questions get one answer; child text in notices is quoted data.
- Continuations keep their recorded identity; both control tools manage every run.
- One file-changing run at a time, waiting included; `ask` may run beside it.
- Host writes, where the policy or user allows them, never overlap an unfinished file-changing run, including one waiting or finishing.

These are instructions to the host model, not an interception boundary on host tools.

## Choosing a role

What each enabled role is for, as the guidance states it:

```text
plan       goal + proposed plan -> agreed numbered tasks; Route section is a recommendation
implement  one clear, bounded task -> report, or Escalation that ends the run
ultracode  explicit ultracode request only; Claude-only; self-reviewed
ask        question (mode answer) or independent review (mode review); read-only
security   explicit security request only, once enabled/configured; Pi-only
```

Which of these the host uses for a request, and whether it works directly instead, is the policy's. Do not expect `ultracode` merely because work looks difficult: only an explicit user request authorizes it, even if a plan recommends it.

Security is **disabled in `builtin`**. Enable it through [settings or a profile](profiles.md) and configure a Pi model. Even then, the host uses it only when you ask for a security investigation, audit, or fix, not because other work looks security-sensitive. A task without fix authorization reports findings and changes no application code; an authorized fix should be the smallest verified change that closes the finding. Findings carry severity and confirmed/inferred evidence; secrets and personal data are named by location, never reported by value. Security has coding tools and takes the single file-changing slot; its contract is not an access-control boundary.

Disabled roles contribute no descriptions, guidance, snippets or task briefs. One short guideline per tool names its disabled roles and says fresh calls and continuations refuse; parameter help lists only enabled roles. The role schema keeps every supported role so its enum is never empty. Enabling one is your choice, through `/fusion config` or a profile. When no enabled role implements changes, the guidance says so as a fact and leaves what follows to the policy. Disabling `ask` leaves no independent reviewer. Your request cannot bypass a disabled setting.

## Selecting a backend and model

Unless you name overrides, the host leaves `backend`, `model`, and `effort` unset and uses the session's configured settings.

```text
builtin
  +-- plan / implement / ultracode / ask -> Claude
  +-- security                          -> Pi, disabled
  +-- no role                           -> Codex

Codex opt-in -> backend: "codex", or role settings/profile
```

Security needs separate activation and a Pi model; once enabled, its calls need no backend override. Ultracode is Claude-only. Codex supports `plan`, `implement`, and `ask` through your own install and defaults. Questions opt the whole connection into Codex's `experimentalApi`; see [Codex behavior](codex-backend.md) and [qualification limits](codex-backend.md#evidence).

An explicit other-backend override uses that backend's captured legacy defaults, not the configured backend's model/effort. Pi requires an exact `provider/model-id` and guesses none. Unsupported role/backend combinations refuse before admission, once the enabled-role check permits routing.

`claude` is a forced-Claude compatibility tool. Guidance recommends `fusion` for Pi- and Codex-configured roles unless you explicitly request Claude Code. A continuation stays on its recorded backend/selection; a Pi or Codex run always needs `fusion`. Switching profiles does not move recorded threads.

Implicit `plan` calls continue the latest plan on the routed backend, or hand off for its context cap or an explicitly changed model. An unreadable latest record refuses instead of falling back to another plan. See [Runs](runs.md) and [Profiles](profiles.md) for parameters and precedence.

## Briefs, escalation, and review

Children do not see the host conversation. Each brief must state the goal, settled decisions, constraints, acceptance criteria, and verification in readable prose. Tasks and context must preserve spaces between words, not concatenate them to shorten prompts.

An `implement` report's **Escalation** means the task needs broader scope or an unresolved design decision. The run ends; it does not wait or widen the task. What happens next is the host policy's.

Host review, **self-review** (such as ultracode's agents under its own briefing) and independent review are distinct; see [Kinds of review](reviews.md#kinds-of-review). Independent review is a fresh `ask` run with `mode: "review"`, using the session's `ask` settings, not the model/backend of the implementation.

The shipped [`contracts/host.md`](../contracts/host.md) asks for a fresh independent child review after each implementation step when a reviewer is enabled and can start, with findings addressed before the next step or a commit; a completed review of the same change that was already started, such as an automatic one, counts. Without one, the host reviews the change itself and says no independent child review ran. A replacement policy can say otherwise; the generated guidance decides none of this.

Each run's stats line names its resume command or transcript file; what the host reports is the policy's. Children are instructed not to commit; the host commits only on request.

A backend this build does not run refuses with what happened and names no other route.

Routing lives in tool guidelines, the host policy and contracts. It is model guidance, not enforced isolation: the host and shell-equipped children can still change files.
