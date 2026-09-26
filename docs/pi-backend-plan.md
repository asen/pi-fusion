# Plan: a Pi backend for Fusion

Status: implementation proposal; no runtime changes made. Agreed scope: generic Fusion tools with Claude compatibility, supporting `plan`, `implement`, and `ask` on Pi, with `ultracode` remaining Claude-only. A Pi-only `security` role is a full coding role and occupies the single active file-changing run slot.

## Outcome

The host can run a child through either Claude Code or Pi, with the same handles, background work, questions, controls, dashboard, and durable continuation. Pi uses the user's working provider configuration, including DeepSeek; Fusion does not implement a provider API client.

Backend and role are independent. A backend chooses the execution harness; a role chooses the task contract, available tools, and model in its backend binding. The Pi backend is provider-neutral and contains no DeepSeek-specific defaults or routing. Backend selection follows the requested backend, the continued run, or the role's supported backends; a child's refusal never triggers automatic backend switching.

## Role capabilities and backend support

Define roles separately from backend implementations, with explicit supported backends, required tool capabilities, `canChangeFiles`, and `reviewable` metadata. Keep these definitions in code and behavior contracts in Markdown; a user-configurable role system is outside this change.

| Role | Supported backends | Can change files | Eligible for change review |
| --- | --- | --- | --- |
| `plan` | Claude, Pi | yes | no |
| `implement` | Claude, Pi | yes | yes |
| `ask` | Claude, Pi | no | no |
| `ultracode` | Claude | yes | yes |
| `security` | Pi | yes | yes |

The existing plan role retains its file-changing classification. Backend-specific bindings supply the concrete tools, model defaults, and effort settings. Reject unsupported role/backend combinations before starting a process. For a new run without an explicit backend, select the sole supported backend when there is one: security selects Pi and ultracode selects Claude. Roles supported by both retain Claude as the default. An explicit incompatible backend fails instead of being replaced.

The `security` role can investigate, write reproductions and tests, implement fixes, and run verification within the task's scope. Give it the Pi coding tools and `contracts/security.md`, with a report covering findings, evidence, changed files, verification, and unresolved issues. Its Pi binding selects the user's configured DeepSeek provider/model id. Other roles can select entirely different providers and models through the same Pi backend.

Security work follows the requested outcome. An investigation task produces findings and may write reproductions or tests to verify them; it does not automatically repair application code. A task requesting investigation and fixes also authorizes remediation within that scope. Keep this distinction in the contract and task brief rather than adding another mode parameter. The role occupies the file-changing slot in either case. When the intended outcome is ambiguous, use the existing question mechanism before expanding into remediation.

Use role capabilities for scheduling, changed-file snapshots, review eligibility, and UI behavior instead of checks such as `role !== "ask"` or a hard-coded implement/ultracode pair. A running or waiting security child blocks every other file-changing child across both backends; ask children can still coexist. Apply the same questions, continuation, cancellation, background, and history behavior as other coding roles.

## Public interface

- Add `fusion` and `fusion_control` as the primary tools. Keep `/fusion` as the user command.
- `fusion` retains the current task, context, role, continue, fresh, background, mode, model, and effort parameters, and adds optional `backend: "claude" | "pi"`. New calls infer a role's sole supported backend, or default to Claude when both are supported. Continuations inherit their recorded backend.
- Pi model values use `provider/model-id`. Resolve them against Pi's configured model registry; fail clearly when a model or credentials are unavailable, without falling back to another provider.
- Each role's backend binding owns its model and effort defaults. For Pi, an explicit call override wins, followed by the recorded selection on continuation, followed by the role's defaults for a new run. There is no shared Pi model default. Preserve existing Claude model-selection behavior for compatibility.
- Keep `claude` as a wrapper selecting the Claude backend, with its existing parameter schema. Reject continuation of a Pi handle through this wrapper. Keep `claude_control` as a compatibility alias of the shared control tool; handles identify the backend.
- Host routing guidance uses the new tools. Existing integrations can continue using the old names.
- Continuing a handle inherits its backend and role. An explicit conflicting backend or role fails before launching a child. Persist the resolved Pi model and effort so continuation after a host restart does not silently select another model.
- Track the implicit latest plan separately per backend. A Pi plan must never silently continue a Claude plan. Handoffs stay on the originating backend.
- Validate role, tools, and effort against the selected backend. Pi's available thinking levels are model-dependent; do not silently translate Claude effort settings into unsupported Pi settings.

Example, using the model configured for the security role:

```json
{"role":"security","task":"Inspect this project's authentication flow, reproduce confirmed issues, and implement fixes."}
```

## Execution architecture

Extract a small backend interface from `extensions/fusion.ts`. Keep the shared lifecycle in Fusion: handle allocation, scheduling, questions, notifications, reviews, snapshots, history, budgets, and rendering. Backend modules own launch options, protocol translation, session operations, and backend-specific errors.

Suggested files:

- `extensions/backends/types.ts`: backend identity, session references, capabilities, normalized progress and completion types.
- `extensions/backends/claude.ts`: existing SDK options, questions bridge, and stream handling, initially moved without behavior changes.
- `extensions/backends/pi.ts`: RPC transport, model validation, events, usage, questions, and session control.
- `extensions/backends/pi-child.ts`: explicitly loaded Pi extension exposing `ask_orchestrator` and internal session-navigation commands.
- `extensions/process-tree.ts`: shared process launch and descendant termination, preserving current cancellation behavior.

Run Pi in a separate process with `--mode rpc`. Prefer the CLI entry point from the installed `@earendil-works/pi-coding-agent` package, with an executable override for alternate installations and test fakes. Check the required protocol capabilities and establish a minimum supported Pi version instead of assuming the wildcard peer dependency guarantees them.

Use LF-delimited JSON framing, correlated command ids, bounded diagnostics, and explicit handling of malformed output and unexpected exit. A successful prompt response acknowledges acceptance; it does not mean the task succeeded. Finish only after `agent_settled`, inspect the final outcome, collect usage and checkpoint, then shut down the child. Handle retries, compaction, and queued steering without prematurely completing the run.

Retain process-tree termination for cancellation and host shutdown. If using Pi's graceful abort, clear queued messages first so abort cannot restart work. Reject pending requests and unblock pending questions when the child exits or is cancelled.

## Child configuration and questions

Reuse the user's Pi credentials and model configuration. Each role's Pi binding declares explicit extension and skill lists. Disable automatic extension and skill discovery from global settings, project directories, and packages; load only those lists plus the required Fusion child bridge. Empty lists mean no optional extensions or skills. Provider extensions required by a role must be listed explicitly too. Validate configured resources before starting work and report missing resources without silently loading alternatives.

Prevent the Fusion host extension from registering recursively in a child, including indirect package loading, using a child marker and an early guard in the host extension. Reject an explicit attempt to include the Fusion host extension in a role's resources. The child bridge is separate and does not expose tools for starting Fusion children. Contracts also prohibit launching nested Fusion sessions; the resource controls and registration guard are not a sandbox against arbitrary Bash execution.

Disable automatic prompt-template discovery as well; configurable child prompt templates are outside the initial scope. Preserve project context instructions. Do not edit the user's existing Pi configuration or copy credentials into Fusion records. Reviews load the ask/review role's explicitly selected resources, not the source coding role's tools or skills; any provider extension needed for the selected reviewer model must be available in that configuration.

The child bridge registers `ask_orchestrator`, implemented through a blocking RPC UI input request. The parent maps its request id to the existing question queue and replies through `extension_ui_response`. Reuse exactly-once answer arbitration between host and user, foreground-to-background transition, and cancellation behavior. Other supported extension dialogs must receive a defined response or an explicit error, never silently hang.

Contracts need backend-neutral language: use host/child vocabulary, remove the fixed three-model framing, and describe tools by capability or provide backend-specific instructions. Pi does not inherently provide Claude's `WebSearch` and `WebFetch`; advertise only tools actually configured. The existing `ask` role remains non-mutating by contract, including Bash. This is not a filesystem sandbox.

## Durable sessions and branching

Use backend-tagged session references. Claude keeps its session id and assistant checkpoint. Pi records its session file, session id, and durable entry checkpoint after the successful call has settled, including relevant compaction entries. Missing backend fields in old records mean Claude.

The child's session navigation must restore the recorded checkpoint before sending another prompt. The stock RPC `fork` command branches from a user message and is insufficient for Fusion's completed-call checkpoint semantics. Prototype the bridge's command-context `navigateTree` and `fork` with position `at`, without summary generation, before building the rest of the adapter.

Required semantics:

- Normal continuation reads exactly the recorded context, including after a host restart.
- Host `/tree` restores the older child checkpoint and excludes later child turns.
- A forked host creates a separate child session from the recorded checkpoint on first use. Neither host subsequently writes the other's child transcript.
- A failed continuation leaves the last successful checkpoint authoritative. Failed new runs retain their allocated handles. Preserve the existing failed-fork recovery behavior.
- Missing sessions or checkpoints cause an actionable error, never continuation from whatever context happens to remain.
- Keep `/tree` blocked until every active run has finished recording and delivering its result, across both backends.

Use supported Pi session APIs rather than hand-editing JSONL transcripts. Add migration tests for existing host entries and history files. Child transcripts remain durable independently of the optional Fusion history mirror.

## Shared behavior and visibility

- Enforce the single active file-changing run rule across both backends using role capabilities, including `security`; `ask` runs may coexist.
- Add backend and resolved provider/model to cards, status, dashboard, history, and resume instructions. A Pi run must never suggest `claude --resume`.
- Keep accounting per call: normalize Pi usage into running call totals, avoiding recounting earlier turns when continuing a session. Include retry and compaction usage where reported. Distinguish unavailable price estimates from genuinely zero cost and explain incomplete budget estimates.
- Use Pi's actual context usage/window for context caps and handoffs instead of Claude defaults.
- Preserve current Claude review defaults for existing roles. Security changes use a fresh Pi `ask` run with `mode: "review"`, a read-only review contract, and the security run's resolved model, including any explicit model override. Include successful security runs with changed files in the existing opt-in automatic review behavior. Manual `/fusion review` and automatic review use the same reviewer-selection policy.
- Preserve dashboard DOM and CSS restrictions.

Proposed new configuration: `PI_FUSION_PI_BIN`, role-specific `PI_FUSION_PI_<ROLE>_MODEL` and `PI_FUSION_PI_<ROLE>_EFFORT` values, and explicit extension and skill lists in each role's Pi binding. For example, `PI_FUSION_PI_SECURITY_MODEL` configures the security role's DeepSeek provider/model id. These configure role bindings, not provider behavior in the backend. Existing Claude variables keep their meaning. Require a model from the call, continued run, or role configuration; do not guess the user's DeepSeek model id or use Pi's last interactive model selection.

Keep reviewer selection separate from execution, as a per-source-role policy resolving a reviewer backend, model, and supported effort settings. Initially, security selects Pi and inherits the source run's resolved model; existing roles retain their current reviewer defaults. A review is a new run with its own context and the review contract, never a continuation of the coding child. Inheriting the model does not inherit coding tools or permissions. Record the resolved reviewer backend/model on the review run.

Plan the internal policy to accept an explicit reviewer model later, but defer new reviewer-model configuration variables, command options, and UI controls. A future override should require only selection/configuration changes, not another execution path or changes to review prompts and lifecycle. Existing explicit `fusion` calls with `role: "ask"`, `mode: "review"`, and a model remain available.

## Implementation sequence

1. Prove checkpoint restoration, exact-position fork, blocking questions, and settled completion against installed Pi 0.85.1 using a deterministic local model fixture. Resolve any protocol gap before committing to the adapter shape.
2. Extract the backend boundary and process-tree helper while keeping all Claude behavior and tests passing.
3. Add tagged records, generic tools, compatibility wrappers, explicit role capabilities and backend bindings, backend-aware routing, and per-backend plan selection. Keep the legacy Claude schema limited to its existing roles.
4. Implement the Pi transport and bridge, then wire continuation, questions, steering, cancellation, and background reports into the shared lifecycle.
5. Add the security contract and Pi binding; complete usage, context caps, capability-based reviews, history, and dashboard integration. Update contracts and documentation alongside each behavior change.
6. Run the full deterministic suite and typecheck, then perform a user-configured DeepSeek smoke run as an explicit live validation step.

## Acceptance and verification

Add `test/fake-pi.mjs`, following the fake-Claude pattern, for deterministic protocol tests without paid API calls. Cover success, streamed tools, two questions, competing answers, steering, cancellation with a Bash descendant, protocol errors, provider errors, retry/compaction before settled completion, and premature process exit.

Exercise the shared lifecycle against both backends: foreground/background transitions, global writer exclusion, shutdown, failed continuation, host restart, `/tree`, host fork, context handoff, and history restore. Test usage across multiple calls and partial failures for double counting.

Verify security runs occupy the writer slot while running or waiting, can coexist with ask runs, record changed files, and qualify for manual and opt-in automatic reviews. Cover rejection of security on Claude and ultracode on Pi, and restoration of security records after a host restart. Role capabilities must preserve existing plan, implement, ask, and ultracode behavior.

Verify omitted backend selects Pi for security, Claude for ultracode, and Claude for roles supported by both. A continued Pi run keeps Pi when backend is omitted. Explicit incompatible selections fail before launch; the legacy Claude wrapper never infers Pi.

Verify manual and automatic security reviews start fresh Pi ask sessions with the source run's resolved model and read-only review tools, including after history restore or a change to role defaults. Existing roles must retain their current reviewer selection. Review runs must not themselves trigger automatic reviews.

Verify different Pi roles resolve different configured providers/models through the same backend, explicit overrides take precedence, and continuation preserves its recorded model after role defaults change. Missing role model configuration must fail clearly without selecting another model.

Verify each Pi role loads only its declared extensions and skills plus the child bridge, even when global or project configuration contains additional resources. Cover empty lists, missing resources, explicitly listed provider extensions, and attempts to load the Fusion host extension directly or indirectly. Confirm the child never registers Fusion delegation tools and that reviews use their own resource lists.

The fake alone cannot prove Pi session semantics: retain integration tests using real Pi session APIs and a local deterministic model fixture for checkpoints, forks, and bridge behavior. Verify old entries remain Claude runs and compatibility tool schemas still work. Check backend labels and resume instructions in cards and the dashboard.

Run `npm run typecheck` and `npm test`. Browser tests retain their existing Chrome availability behavior. Live validation should verify the user's actual configured DeepSeek model, continuation, one question/answer exchange, steering, and cancellation; it must not be part of the default test suite.

Documentation changes belong in `README.md`, `CONTEXT.md`, and the matching configuration, routing, runs, questions, reviews, dashboard, and development pages. This proposal does not describe functionality already shipped.
