# Configuration


| Variable | Default |
| --- | --- |
| `PI_FUSION_PLAN_MODEL` | `fable` (a Claude Code model alias or id) |
| `PI_FUSION_IMPLEMENT_MODEL` | `opus` |
| `PI_FUSION_IMPLEMENT_EFFORT` | `high` |
| `PI_FUSION_ULTRACODE_MODEL` | `fable` |
| `PI_FUSION_ULTRACODE_PERMISSION_MODE` | `bypassPermissions` |
| `PI_FUSION_ASK_MODEL` | `opus` |
| `PI_FUSION_ASK_EFFORT` | `high` |
| `PI_FUSION_PI_<ROLE>_MODEL` | unset; the `pi` backend's model for role `plan`, `implement`, `ask` or `security`, as `provider/model-id`. A `pi` call that names no `model` of its own needs it; see [The pi backend's variables](#the-pi-backends-variables) |
| `PI_FUSION_PI_<ROLE>_EFFORT` | unset; that role's thinking level on the `pi` backend, for the same four roles. Optional, and a child given none keeps its own default |
| `PI_FUSION_ULTRACODE_WORKFLOW_SIZE` | unset; `small`, `medium`, `large` or `unrestricted` sets Claude Code's `workflowSizeGuideline` for the child |
| `PI_FUSION_CLAUDE_BIN` | unset; the Claude Code binary bundled with the SDK. Set it to run another `claude` executable, for example the one on `PATH` |
| `PI_FUSION_DASHBOARD_OPEN` | unset; `0` stops `/fusion dashboard` from opening the browser and only shows the URL |
| `PI_FUSION_WIDGET` | unset; `0` stops the widget over the editor that names the active runs |
| `PI_FUSION_BUDGET_WARN_USD` | unset; one amount or a comma-separated list, such as `5,20`: the user is warned once at each amount the session's estimated cost reaches |
| `PI_FUSION_BUDGET_LIMIT_USD` | unset; one amount: at or over it no new run starts, no run is continued and no review starts. It cancels nothing |
| `PI_FUSION_PLAN_CONTEXT_PCT` | `35`; the share of its context window, in percent, at which a plan run is handed off to a fresh one instead of continued, and at which a `continue` of any run says so in its result. `0` turns both off |
| `PI_FUSION_AUTO_REVIEW` | unset; `1` starts an independent review of every `implement`, `ultracode` or `security` run a delegation tool started that ends `done` with changed files |
| `PI_FUSION_HISTORY` | unset; `1` keeps the runs of each Pi session that has a session file on disk, prompts and reports included, so a later Pi process on the same session can show them |
| `PI_FUSION_HISTORY_DIR` | unset; the directory those files go in. The default is `pi-fusion/history` under `PI_CODING_AGENT_DIR`, which is `~/.pi/agent` |

Each variable applies to the role in its name. The role variables are the legacy defaults: they make up the built-in configuration, and they are what a call naming the other backend than a role's configured one runs on. They are read once, when the extension instance starts, so changing one in the shell afterwards does nothing until Pi starts a new instance. A [profile](profiles.md) replaces them for a session: it states every role's backend, model and effort itself and never falls back on a variable. A call's `model` or `effort` parameter wins over both for that call, and a run keeps the model and effort it started with for later calls that name none.

## The pi backend's variables

`PI_FUSION_PI_PLAN_MODEL`, `PI_FUSION_PI_IMPLEMENT_MODEL`, `PI_FUSION_PI_ASK_MODEL` and `PI_FUSION_PI_SECURITY_MODEL`, and the matching `PI_FUSION_PI_<ROLE>_EFFORT`, say what a role runs as on the `pi` backend. The backend needs no variable to be available, because this build registers it; what it has no default for is the model, so these are how a `pi` call gets one without naming `model` itself. Role `security` runs on `pi` alone, so `PI_FUSION_PI_SECURITY_MODEL` is the only variable that gives that role a model at all.

There is no default model and none is guessed, so each role takes its model from the call's `model` parameter, or from the selection the run it continues actually ran with, or from the session's setting for that role — that role's `PI_FUSION_PI_<ROLE>_MODEL` in the built-in configuration — in that order; without one of the three the call is refused and says so, before a handle is taken, a child starts or an entry is written. A model is a provider and a model id split at the first slash, such as `deepseek/deepseek-chat` — the id after that slash is opaque and may hold slashes of its own, as `openrouter/deepseek/deepseek-chat` does. The thinking level is optional in the same three places: a first call that names none leaves the child its own default, and the child reports back what that was. A call that names an empty model or an empty level is refused rather than falling through to a recorded or configured value.

A review is an ordinary `ask` run on the session's `ask` settings, so on `pi` it takes the `ask` role's model and level like any other; nothing of the run it reviews is inherited. See [Independent reviews](reviews.md#which-backend-reviews-a-run).

What a run ends with is what gets kept. A settled call records the model and level the child actually ran with, and a continuation repeats that recorded selection rather than resolving one again, so changing a variable or a profile afterwards does not move a running thread to another model; a call's own `model` or `effort` still wins for that call, and the fields it does not name stay as they were recorded. The levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; whether a given model offers one of them is the backend's check against the child, not this host's, and a level the child clamped to something else fails the call instead of becoming a selection a continuation would repeat.

The two budget variables are not role variables, and neither are `PI_FUSION_WIDGET`, `PI_FUSION_PLAN_CONTEXT_PCT`, `PI_FUSION_AUTO_REVIEW`, `PI_FUSION_HISTORY` and `PI_FUSION_HISTORY_DIR`. The budget variables and `PI_FUSION_PLAN_CONTEXT_PCT` are read when Pi loads the extension; see [Session usage and budget](#session-usage-and-budget) and [the context cap](runs.md#the-context-cap).

Role `plan` runs at effort `xhigh` on the `claude` backend in the built-in configuration unless a call passes `effort`; there is no variable for it, and a profile can set another. On `pi` no role has a model default — not one of the four, `security` included — and the thinking level is optional: a `pi` call takes its model from `model` or `PI_FUSION_PI_<ROLE>_MODEL` and is refused without one, and a call that names no level leaves the child its own. Role `ultracode` always runs at effort `ultracode`, which is Claude Code's `xhigh` tier plus the standing Workflow opt-in. Passing `xhigh` itself would keep the reasoning level but drop the workflows. The workflow agents' model and effort (Opus 5, xhigh) live in the implementer contract, not in a variable.

The role contracts are the Markdown files under `contracts/`, passed to each child as an appended system prompt. Edit them to change how a role behaves.

The `implement` and `ultracode` contracts' "do not commit" is an instruction in those contracts, not an enforced restriction.

## Where the pi backend writes

A Pi child's storage lives in a `pi-fusion` subtree inside the host's own agent directory — what `PI_CODING_AGENT_DIR` names, or `~/.pi/agent`:

- `pi-fusion/children/` is the one child agent directory every Pi call shares: the model catalog cache, the helpers Pi downloads, and this project's durable session directory, which is what a resume or a fork of a Pi run continues from.
- `pi-fusion/calls/<role>-<random>/` is one call's own directory: the input file its child is launched with and the compiler caches that child writes. It goes when the call ends, unless stopping the child left something to look at, and then it is kept.

The user's own `models.json` and `auth.json` in the host agent directory are the child's inputs. Fusion creates neither for a user who has none, copies no credential and writes no provider configuration of its own. That is not a read-only claim about the auth path: an `auth.json` that already exists is the file the child is handed, and Pi's own credential store may refresh it and write that one file back in place, and create and remove a transient `auth.json.lock` beside it, around a read as much as around a refresh. That shared write is authorized. A user with no auth file gets a private path inside that call's own directory instead, which goes when the directory does.

`PI_CODING_AGENT_DIR` moves the host agent directory and this whole subtree with it; beyond that one root no variable relocates any of these paths. Nothing collects what a kept call directory leaves behind: there is no garbage collector and no cleanup command, so a directory that stayed is yours to look at and delete — once the cleanup concern that kept it is resolved and nothing of that call is still running, because the directory was kept precisely because this host could not see the end of that child. Which one belongs to which run is read from its role name and the time it was made, against the run in `/fusion status`, the history or the dashboard; no path is ever put in a message.

The child's environment is the host's, copied as it is: provider keys, `PI_OFFLINE` exactly as the user set it, and everything else this Pi process carries. The host agent directory's own `bin` is appended to the child's `PATH`, and to the child's alone, so a helper Pi has already downloaded is found rather than fetched again.

A child may use the network — the model requests it makes, a refresh of the shared model catalog, which is permitted rather than required, and a helper download Pi decides it needs. None of that is sandboxed, proxied or limited by this extension.

There is no switch for the backend itself: no variable, file or flag turns `pi` on or off, and nothing falls back to another backend when a Pi call fails.

## Session usage and budget

The extension adds up what the delegation calls of this Pi session have spent. Each call reports its own running total, and the newest total replaces the one before it, so an update while a child works never counts twice; a continued run is another call and adds its own. `/fusion status` always ends with the totals, whether or not a budget variable is set:

```
session usage: est. $0.2500 · in 12.3k out 4.5k tokens · workflow agents 0 tokens · 3 calls
```

The dashboard header shows the same totals, and the control tools and the delegation tools carry them in their result details, whether the call returns a report, a background handle or an open question. The cost is the Agent SDK's estimate at list prices, which is not a charge under a subscription, and it updates when a child turn ends, so it lags the work in flight.

What a finished call counts with is the total its outcome returned, because that is what the run ended up spending; a backend is not required to repeat that total as one last progress update, and a run whose backend broke instead of returning keeps the last total its child did report. A run that ended badly still counts: a failure, a cancellation and an outcome this host refused to record all spent what they spent. The same figures go into the result details, the stats line and the on-disk history, so the live total, a saved run and a restored session agree.

`PI_FUSION_BUDGET_WARN_USD` takes one amount or a comma-separated list, such as `5,20`. Each amount warns once: when the estimate reaches it, the user gets a notice with the total and the threshold, and that threshold stays quiet for the rest of the Pi process. A warning changes nothing else.

`PI_FUSION_BUDGET_LIMIT_USD` takes one amount. At or over it a delegation call refuses a new run and a `continue`, and a review is refused the same way, whether `/fusion review` or `PI_FUSION_AUTO_REVIEW` asked for it. The message names the estimate and the limit. No run is ever cancelled for cost, and the extension still passes no `maxBudgetUsd` and no `maxTurns` to a child, so a run that is already going spends what it needs; because the estimate lags, a session can end over its limit. Raise or unset the variable and restart Pi to start runs again.

Both variables are read when Pi loads the extension. Changing them in the shell afterwards does nothing until Pi restarts. A variable that is set and names no dollar amount turns its control off, and the first delegation, control or `/fusion` call of the process says so once, for example `fusion: PI_FUSION_BUDGET_LIMIT_USD=1,000 is not a dollar amount; no limit is set`.

The built-in configuration enables every role except `security`; a session turns a role off or on through its [settings](profiles.md), and no variable does. Which backends can run a role is code, not configuration: `ultracode` runs on `claude` alone and `security` on `pi` alone, and `PI_FUSION_PI_SECURITY_MODEL` gives that role a model rather than enabling it.
