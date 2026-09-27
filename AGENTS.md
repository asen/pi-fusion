# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # also fetches the Claude Code binary bundled with the Agent SDK (~200 MB)
npm run typecheck      # tsc -p . (noEmit); the only static check, there is no linter or formatter
npm test               # node --test "test/*.test.ts"
node --test test/control.test.ts                      # one file
node --test --test-name-pattern="continue" test/control.test.ts   # one test
```

`test/browser.test.ts` drives the dashboard in headless Chrome. It looks at `PI_FUSION_CHROME`, then the usual install paths for the platform, then any Chromium name on `PATH`, and skips itself when it finds none.

## Architecture

A single Pi extension. `extensions/fusion.ts` default-exports `fusion(pi: ExtensionAPI, options?: FusionOptions)`, which registers the `fusion` and `fusion_control` tools, the compatibility `claude` and `claude_control` pair, the `/fusion` command, a renderer for `pi-fusion-run` messages, and the `session_shutdown` and `session_before_tree` handlers. Everything else is a module it imports.

Each delegation call starts a **child**: a headless coding session in the host's working directory. Which harness runs it is the **backend**: `claude`, run through `@anthropic-ai/claude-agent-sdk`, is the only one this build runs. `pi` is a name records, routing, role capabilities and the `backend` parameter all know, and every call routed there is refused before a handle is taken or a child starts; `FusionOptions.backends` is how a test injects one, and nothing reads a backend from the user; a backend must be registered under its own name, and a registration whose key and `name` disagree is refused at load, before a session could be mapped or a run tagged with the wrong one. The role (`plan`, `implement`, `ultracode`, `ask`, and `security`, which no backend runs here) fixes the child's model, effort, tool list, permission mode and contract; `ROLES` in `fusion.ts` holds the Claude table, `extensions/roles.ts` holds the capabilities every backend shares, and each role's behavior is prose in `contracts/*.md`, appended to the child's system prompt. Change how a role behaves by editing its contract, not the code. The extension throws at load if a contract file is missing.

The SDK lives behind a backend boundary. `fusion.ts` owns the run lifecycle and imports no SDK: it asks `claudeBackend` in `extensions/backends/claude.ts` to run a child and reads the run back through the records in `extensions/backends/types.ts`. Those types name no SDK, and the role and session shapes a backend takes stay its own, through their generic parameters. Keep it that way: SDK options, the questions bridge and stream handling belong in the backend, and process launching and descendant killing in `extensions/process-tree.ts`, which takes its own launch shape so no SDK type reaches it.

A record is tagged with the backend that wrote it, and each backend's identity is its own. A Claude entry keeps the flat `sessionId` and `checkpoint` it always had. A Pi entry keeps a structured `session` reference — session id, session file and, when one is trusted, a checkpoint — and the `selection` the child actually ran with, because a Pi continuation repeats that selection rather than resolving a model again. An entry with no backend is a Claude run, which is what everything written before the tags is. A record this host cannot read keeps its handle and is refused rather than continued.

Run state lives in two places, and the difference matters:

- **In memory**, for this Pi process: `LiveRun` records in `fusion.ts` and the dashboard's `RunStore`. They die with the process unless `PI_FUSION_HISTORY=1` mirrors them to disk through `history.ts`.
- **In the host session transcript**, as `pi-fusion` custom entries appended with `pi.appendEntry`. Each carries the handle, role, Claude Code session id and a checkpoint (the uuid of the child's last assistant message). `runRecords(branch)` reads the last entry per handle on the host's current branch, which is why resuming, `/tree` and forking a host session carry the runs with them. A forked host resumes the recorded session with `--fork-session` on first use.

Module map:

| File | Holds |
| --- | --- |
| `extensions/fusion.ts` | Claude roles, handles, tagged records, routing, questions, scheduling, the four tools, `/fusion`, run lifecycle |
| `extensions/roles.ts` | what a role is apart from a harness: which backends may run it, whether it changes files, whether a review reads it |
| `extensions/backends/types.ts` | the backend boundary: session references and intents, selections, the run record, its events, the question callback, the steer queue, the run request and the host's erased view of a backend |
| `extensions/backends/claude.ts` | the Claude Code backend: its role and session shapes, SDK options, the questions bridge, the stream loop |
| `extensions/backends/pi-binding.ts` | what a Pi role would run as: the model and thinking level a call resolves to. A binding, not an adapter: it starts nothing |
| `extensions/process-tree.ts` | spawning a child process and killing it with its descendants, process groups included |
| `extensions/budget.ts` | the session cost ledger; each call reports a running total that replaces the one before it, never a delta |
| `extensions/cards.ts` | TUI cards and the run widget, built on `@earendil-works/pi-tui` |
| `extensions/changes.ts` | git snapshots before and after a run, to list the files it changed |
| `extensions/dashboard.ts` | the run store and the local HTTP server; the page is `extensions/dashboard/{index.html,app.js,app.css}` |
| `extensions/handoff.ts` | the context cap that hands a full `plan` run off to a fresh one |
| `extensions/history.ts` | the opt-in on-disk record of a Pi session's runs |
| `extensions/review.ts` | which runs can be reviewed, and the prompt an independent review gets |

Invariants worth knowing before changing run handling: at most one run that can change files is active at a time, across backends (`ask` runs may run alongside); a question blocks its child until exactly one answer arrives, from the host or the user; `/tree` is refused while any run is unfinished, because a late report or entry would land on the wrong branch; what a finished run records is decided from its outcome alone, by `recordDecision`, and an outcome naming a session the run cannot have had fails the run and writes nothing at all.

The dashboard page is deliberately plain: no framework, no inline script or style, no `innerHTML`, `eval` or `new Function`, no `url()` or `@import` in the CSS. `test/dashboard.test.ts` asserts all of that statically, so keep DOM building node by node.

## Tests

The suite never runs a real child of any backend, and never a paid one. Two fakes do that work, and they are not interchangeable: `test/fake-claude.mjs` for the Claude backend's protocol, and `test/fake-pi-backend.ts` for the shared lifecycle.

`test/fake-pi-backend.ts` is a scripted in-memory backend injected through `fusion(api, { backends })`. It runs no process, speaks no protocol and reads no configuration: a script says what each run reports, and the start it captures gives the test the role and intent the host handed over, a steer channel, a question channel, a gate that holds a pending run and an abort response. `test/lifecycle.test.ts` drives the registered tools, the host branch, the history and the controls against it, for both a `pi`-named and a `claude`-named backend. It proves what Fusion does with a backend's answers and nothing about Pi itself; Pi's own session semantics stay `test/spikes/pi-session-lifecycle.mjs`'s to measure against a real child.

The suite never runs the real Claude Code binary. `test/fake-claude.mjs` speaks the SDK's side of the stream-json protocol: it answers the `initialize` control request, reads the prompt from the `user` line, then plays the scenario named by `FAKE_CLAUDE_SCENARIO` (`ok`, `read`, `question`, `two-questions`, `steer`, `error`, `denied`, `wind-down`, `big-context` and others in that file). Tests point the SDK at it with `PI_FUSION_CLAUDE_BIN`. Set `FAKE_CLAUDE_LOG` to a path to see what the SDK writes to the fake's stdin. Add a scenario there rather than mocking the SDK.

## Conventions

- TypeScript with `allowImportingTsExtensions`: relative imports carry the `.ts` extension (`./review.ts`).
- Tabs for indentation, semicolons, long lines. Comments are `/** ... */` above a declaration and say why it is the way it is, not what the code does.
- `CONTEXT.md` fixes the vocabulary: host, child, role, run, handle, question, waiting, answer, handoff, escalation, steer, review run, history. Each term lists the words to avoid. Use these words in code, prose and tool messages.
- User-facing behavior is documented in `README.md` (overview) and `docs/*.md` (one page per topic). A change that alters what a tool, a variable or the dashboard does belongs in the matching page in the same commit.

## Commit Messages
- Keep messages short and concise. Prefer a single-line subject up to ~150 characters describing the change in the imperative ("add X", "fix Y"). Add a brief body only when the *why* isn't obvious from the diff.
- Do **not** add `Co-Authored-By` or any AI/Claude contribution trailers to commit messages.