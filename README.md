# pi-fusion

A [Pi](https://pi.dev) extension that gives the host model a delegation tool, `fusion`, which hands a job to a headless coding session, and `fusion_control`, which manages the sessions that run in the background. One model orchestrates, others do the thinking and the work.

`claude` and `claude_control` are the same two tools under their older names, kept for compatibility: `claude` is `fusion` with the backend forced to Claude Code, its schema unchanged, and the two control tools are one executor, so every run is reachable through either name.

## Backends

A **backend** is the harness a child runs in, and this build registers two.

`claude` runs every role but `security` as a headless Claude Code session, and it is what a call that leaves `backend` unset gets for each of those. `pi` runs `plan`, `implement`, `ask` and `security` as a headless Pi session on the user's own Pi provider configuration. `ultracode` is Claude's alone and `security` is Pi's alone, so a call that names `security` goes to `pi` whether or not it names a backend, and naming `claude` for it is refused before anything starts, with `role security does not run on the claude backend; use one of pi`.

The `pi` backend has no model of its own and guesses none, so a call that names it needs a provider and a model id:

```json
{ "role": "implement", "task": "…", "backend": "pi", "model": "deepseek/deepseek-chat" }
```

The same call without `model` runs once `PI_FUSION_PI_IMPLEMENT_MODEL=deepseek/deepseek-chat` is set; a call with neither is refused before a handle is taken, a child starts or an entry is written. See [Configuration](docs/configuration.md#the-pi-backends-variables).

## Roles

The `role` parameter of `fusion` picks the job. The table is the `claude` backend's binding.

| Role | Model and effort | Tools given to the child | Purpose |
| --- | --- | --- | --- |
| `plan` | `fable`, xhigh | Read, Bash, Edit, Write, Grep, Glob | Challenge a plan and return an agreed, numbered task list. |
| `implement` | `opus`, high | Read, Bash, Edit, Write, Grep, Glob | Implement one clear, bounded task. |
| `ultracode` | `fable`, ultracode | Claude Code's own, plus Workflow, Agent and the user's MCP servers | Complex, uncertain or high-risk work, or a whole agreed plan. |
| `ask` | `opus`, high | Read, Bash, Grep, Glob, WebSearch, WebFetch | Answer a question about the code, or review a change with `mode: "review"`. Changes no files. |

On the `pi` backend the purposes are the same, because both backends run the same contracts under `contracts/`, and the tools are Pi's own: `plan`, `implement` and `security` get read, bash, edit, write, grep, find and ls, and `ask` gets read, bash, grep, find and ls, with no web tool. Every child of either backend also gets `ask_orchestrator`. A Pi role has no model default, so a `pi` call needs one; its effort is optional, and a call that names none leaves the child its own. See [Backends](#backends).

## Parameters

`role` and `task` carry the job; the rest are optional.

| Parameter | Applies to | Meaning |
| --- | --- | --- |
| `role` | all | Required unless `continue` is set. |
| `task` | all | The brief, or the follow-up message for a continued run. |
| `context` | all | Appended to the task under `## Context`. |
| `continue` | all | A run's handle. Sends the task to that run as a follow-up. |
| `background` | all | `true` returns the handle at once and lets the run go on. |
| `fresh` | `plan` | Start a new plan run. Not allowed with `continue`. |
| `mode` | `ask` | `answer` (default) sends `contracts/ask-answer.md`, `review` sends `contracts/ask-review.md`. |
| `model` | `implement`, `ask` on `claude`; every role on `pi` | Replaces the role's model for one call: a Claude Code alias or id, or a Pi provider and model id split at the first slash. No `pi` role has a model of its own, so there a `model` replaces nothing and is one of the three places the required one comes from. |
| `effort` | `plan`, `implement`, `ask`, and `security` on `pi` | `low`, `medium`, `high`, `xhigh` or `max`; the `pi` backend adds `off` and `minimal`. Optional on `pi`, where a call that names none leaves the child its own default. |
| `backend` | all, `fusion` only | The harness the child runs in: `claude`, which an unset `backend` gets, or `pi`. A role the named backend does not run is refused before anything starts. A continued run stays on the backend its record names. |

`ultracode` takes neither `model` nor `effort`, because any other effort turns its workflows off. A parameter the role does not take fails the call before a child starts, with an error such as `effort is not allowed for role ultracode`. The `claude` tool takes the same parameters apart from `backend`, which it does not have: it is this delegation with the Claude backend forced, so it never infers another one from a call or a record, and it refuses to continue a run recorded on another backend and names the tool that can. All four tools are registered `executionMode: "sequential"`, so their calls run one at a time: Pi runs every tool call in a turn sequentially as soon as one of them is sequential.

The `security` role runs on `pi` and nowhere else. It investigates one scoped security concern, area or change, with the same tools role `implement` gets on Pi and `contracts/security.md` appended to its system prompt: it confirms a finding where it can, gives each one a severity and says whether it is confirmed or inferred, and never puts a secret in its report by value. Its task says whether fixes are authorized — a task that does not say reports findings and changes no application code, and one that authorizes a fix gets the smallest change that closes the finding, verified. The guidelines tell the host to use the role only when the user asks for a security investigation, audit or fix, and never on its own judgement that some work looks security-sensitive; for that it uses `implement`, `ultracode` or `ask` with `mode: "review"` as before.

`security` is a file-changing role, so it takes the single active writer slot, `waiting` included, and `ask` runs are the only ones that can run beside it. Questions, steering, background work, cancellation, `continue`, the context-cap warning, the history and the dashboard treat it like any other coding role, and a continuation stays on `pi` with the selection that run actually ran with. It takes `model` and `effort` and neither `mode` nor `fresh`, and it has no model default: a `security` call needs a provider and model id in `model` or in `PI_FUSION_PI_SECURITY_MODEL` and is refused without one, before a handle is taken or a child starts. `PI_FUSION_PI_SECURITY_EFFORT` is its optional thinking level. The compatibility `claude` tool does not advertise the role at all, so it refuses the name with `unknown role security; use one of plan, implement, ultracode, ask`, and it refuses to continue a `security` run the way it refuses any run recorded on `pi`.

## How a child runs

A **Claude child** is a headless Claude Code session in the host's working directory, started through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). The SDK bundles its own Claude Code binary, so nothing has to be on `PATH`. The child uses the Claude Code login on this machine and that subscription, loads the user's settings, plugins and the project's CLAUDE.md, and leaves a normal session behind, so `claude --resume <session id>` opens any child's transcript. Each tool result ends with a stats line naming the handle, the role, the model and that command.

`plan`, `implement` and `ask` children get the tools listed above plus `ask_orchestrator`, and no other MCP servers whatever the configuration says. An `ultracode` child is a full Claude Code session. The role contracts under `contracts/` are appended to the system prompt. The `ask` child has no Edit or Write, and its contract forbids changing files through Bash; that is an instruction to the model, not enforcement.

A **Pi child** is a separate node process this extension launches in the host's working directory, as the command `node` resolved on `PATH`. It builds a Pi session out of the installed Pi package's public SDK and is spoken to over Pi's native RPC protocol, on the provider configuration the user already has: the host's environment is copied to it, provider keys and `PI_OFFLINE` included, and the host agent directory's own `bin` is appended to the child's `PATH` so a helper Pi has already downloaded is not fetched again. Fusion keeps the child's own storage under the host agent directory, writes no provider configuration of its own and creates neither a `models.json` nor an `auth.json` for a user who has none. An `auth.json` that does exist is handed to the child as it is, and Pi's own credential store may refresh and write that one file back in place and create and remove a transient lock beside it, so the user's auth path is not read-only. A child may reach the network for its model requests, a catalog refresh and a helper download, and nothing here sandboxes it. See [where the pi backend writes](docs/configuration.md#where-the-pi-backend-writes). A Pi child's transcript is a Pi session file, which the run's stats line names once the run's outcome has been accepted.

While a child runs, the status line shows `<handle> <role> · <seconds> · <n> tool calls · <activity>` for each active run. Esc aborts a foreground call, and what that does is its backend's. For a Claude child the extension sends SIGTERM to the child's process group and every descendant, then SIGKILL 5 s later, so a Bash command the child started dies with it. A Pi child is first asked to clear its queue and abort, then stopped with its descendants under one bounded cleanup; when that cleanup leaves something to look at, the run is failed rather than reported done, that call's own storage directory is kept, and the result carries one fixed sentence saying so — never a path and never anything the child wrote.

## Routing

The host model is the orchestrator. Its guidelines ask two questions: is the design unresolved, and which implementer role fits the complexity and risk. That leaves three routes: straight to `implement`; `plan` first, then `implement` task by task; or `ultracode`, with or without `plan`.

Your explicit choice wins. Ask for Opus and the host uses `implement`, ask for Fable or ultracode and it uses `ultracode`, and ask for or skip planning as you like. The host names a backend only when you ask for one. For an independent review, the host calls `ask` with `mode: "review"`. Role `security` is yours to ask for: ask for a security investigation, audit or fix and the host uses it, on `pi`, and it picks that role on no judgement of its own. See [Routing](docs/routing.md).

## The Pi backend: evidence and limits

One manual harness drives this composition against real Pi children, with a scripted loopback endpoint as the only model it configures. Its current group of five cases passes on Linux with Node 24 and Pi 0.85.1: a continuation from a trusted checkpoint, a checkpoint on a user message refused, a question answered through the host, a question still open when the run was cancelled, and a mid-turn cancellation whose detached descendant the cleanup reported as terminated. It is run by hand and is not part of `npm test`, and no live provider, paid inference, macOS run or Windows run stands behind it.

Three things are refused rather than guessed at. A recorded session without an absolute file and a checkpoint this host trusts. A continuation whose recorded model and level it cannot repeat exactly. And a thinking level the child clamped instead of accepting. Beyond them, a continuation goes on only once the child reads back as the recorded session, in the recorded file, standing at the recorded checkpoint, and there is no fallback and no repair: a continuation that cannot establish all three is refused rather than continued on a leaf no one has observed. Each costs one refusal and a new run. What the harness has not driven is a checkpoint that is a custom message or a session label, a reconstruction that appends a missing thinking-level entry, a fork whose session file is not on disk when the host looks, and the leaf a user-target navigation actually leaves behind; an instance of one of those that fails those readbacks is refused, and whether one could satisfy them is unmeasured. The moment between launching a child and being handed it is outside the descendant cleanup, which is the known gap it is.

What the `security` role itself rests on is thinner, and separate from the above. Where its calls route, the writer slot it takes, its continuation on `pi`, and the Pi reviewer a finished `security` run gets are covered by the deterministic suite against a scripted in-memory backend that starts no process. No real Pi child has run that role, and no live provider, paid inference or native `security` run stands behind it.

There is no runtime switch for any of this: no variable, file or flag turns the `pi` backend off, and nothing falls back to another backend when a Pi call fails. Taking the backend back out is a code change — remove the `pi` entry from the backend registration in `extensions/fusion.ts`.

## Requirements

- Pi 0.85.1 or newer.
- `npm install` in this directory. It installs `@anthropic-ai/claude-agent-sdk` and the Claude Code binary for this platform, about 200 MB. The pinned SDK bundles Claude Code 2.1.273.
- Claude Code logged in on this machine to a Max, Team or Enterprise plan, for Fable and 1M-context Opus.
- ChatGPT subscription login in Pi for `openai-codex/gpt-6-astra`.
- For `backend: "pi"`, `node` on `PATH`: a Pi child is launched as the command `node`, so a `PATH` without it fails the call with the backend's own fixed startup refusal, which does not name the cause.
- For `backend: "pi"`, a provider already configured and authenticated in Pi, and a model id for each role that runs there. Fusion implements no provider API client, installs nothing and creates neither a `models.json` nor an `auth.json` the user does not have: a provider the user's own Pi cannot reach is one a child cannot reach either. An existing `auth.json` is passed through and may be rotated in place by Pi's own credential store; see [where the pi backend writes](docs/configuration.md#where-the-pi-backend-writes).

Anthropic's [help center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the Agent SDK draws from the subscription's usage limits. Every child counts against them.

## Install

```bash
npm install
pi install ~/eng/pi-fusion
pi --model openai-codex/gpt-6-astra --thinking high
```

Pi activates every extension tool at startup, so `fusion`, `fusion_control`, `claude` and `claude_control` sit next to Pi's built-ins. To pin the list down, pass `--tools read,grep,find,ls,bash,fusion,fusion_control`. `--tools` is a strict allowlist: leaving `fusion` out leaves the host with no delegation, and leaving `fusion_control` out leaves background runs unmanaged. Keep `claude` and `claude_control` in the list as well if you want the compatibility names; the extension's own messages name the primary pair.

The guidelines tell the host to delegate every implementation task and not to edit files itself. That is an instruction, not enforcement: the host still has bash. To enforce it, drop bash from the tool list. The cost is that the host can no longer run git itself.

## Documentation

- [Runs, handles and background work](docs/runs.md) — handles, `continue`, resumes and forks, backend-tagged records, the context cap, `fusion_control`, and runs an earlier Pi process left behind.
- [Questions](docs/questions.md) — how a child asks the host or the user for a decision and waits for the answer.
- [The /fusion command and the terminal UI](docs/fusion-command.md) — the user's own controls, the run cards and the widget.
- [Independent reviews](docs/reviews.md) — `/fusion review` and `PI_FUSION_AUTO_REVIEW`.
- [Monitoring dashboard](docs/dashboard.md) — the local read-only web page.
- [The ultracode role](docs/ultracode.md) — what the workflow opt-in does and what it costs.
- [Configuration](docs/configuration.md) — every environment variable, and the session cost estimate with its warnings and limit.
- [The Pi backend plan](docs/pi-backend-plan.md) — the design record the second backend was built from, with the evidence behind each decision. It is a working document whose step 5 status paragraph is its current status.
- [Development](docs/development.md) — the test suite, the three fakes, and the tripwire that stands in for the registered Pi backend.

The role contracts are the Markdown files under `contracts/`. Edit them to change how a role behaves.
