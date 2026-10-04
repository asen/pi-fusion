# Development

## Commands

```bash
npm install
npm run typecheck
npm test
node --test test/control.test.ts
node --test --test-name-pattern="continue" test/control.test.ts
```

The suite uses Node's native TypeScript stripping and a 60-second per-test timeout. Typecheck is the only static check; there is no linter or formatter. `npm install` also installs the Claude Agent SDK's bundled binary (about 200 MB), but tests do not run that binary.

Editing conventions and invariants live in [AGENTS.md](../AGENTS.md); vocabulary lives in [CONTEXT.md](../CONTEXT.md). Keep user-facing changes in the owning topic page. The code, not historical plans or measurement counts, defines current behavior.

## Module map

```text
fusion.ts                     host lifecycle and registration
  +-- roles/profiles/store    capabilities and session configuration
  +-- backends/types.ts       SDK-neutral boundary
  |     +-- claude.ts         Claude SDK and stream/questions
  |     +-- pi-backend.ts     Pi composition (see below)
  +-- process-tree.ts         launch and descendant cleanup
  +-- cards/dashboard        terminal and browser monitoring
  +-- changes/history/budget snapshots, persistence, accounting
  +-- handoff/review          prompts and eligibility
```

| Module under `extensions/` | Responsibility |
| --- | --- |
| `fusion.ts` | Tools/command, mode, configuration application, admission, handles, branch records, questions, controls, reviews, and host lifecycle handlers |
| `roles.ts` | Supported backends, writer-slot and review eligibility per role |
| `profiles.ts`, `profile-store.ts` | Captured legacy defaults, settings validation/copies, global profiles file and queued atomic replacement |
| `backends/types.ts` | Session references/intents, selection, request/outcome/event/callback shapes; imports nothing |
| `backends/claude.ts` | Claude SDK options, input/question bridges, stream loop; SDK concerns stay here |
| `backends/pi-binding.ts` | Pure Pi role/model/effort binding, contracts, and tool/resource lists |
| `backends/codex-binding.ts` | Pure Codex role/model/provider/effort binding, contracts and no-questions addendum, sandbox and approval policy; imports only `types.ts`, and no Codex backend is registered |
| `backends/pi-storage.ts`, `pi-launch.ts` | Owned layout/catalog publication, call input, environment, launch options, and lazy host agent/package accessors |
| `backends/pi-bootstrap.mjs` | Child-only public SDK construction, strict input/resource/session checks, in-memory settings, and native RPC serving |
| `backends/pi-sdk-resolve.mjs`, `pi-bootstrap-protocol.mjs` | Child resolve preload; separately, import-free startup constants shared with transport |
| `backends/pi-control-extension.mjs`, `pi-session-restore.ts` | Child navigation/fork commands and host restore/readback sequence |
| `backends/pi-question-tool.mjs`, `pi-question-routing.ts` | Blocking child input tool and host dialog arbitration |
| `backends/pi-helper-retry.mjs` | One bounded retry around public search tools, not an SDK patch |
| `backends/pi-transport.ts` | Native RPC framing/correlation, bounded writer/dialogs, readiness/turn lifecycle, and shutdown |
| `backends/pi-prepare.ts`, `pi-task.ts` | Preparation identity/selection/usage baseline; one task's evidence, steers, readbacks, and single stop |
| `backends/pi-outcome.ts`, `pi-backend.ts` | Pure diagnostics/disposition/demotion/progress mapping; composition and finalization |
| `process-tree.ts` | SDK-independent process launching and legacy/owned descendant cleanup |
| `cards.ts`, `dashboard.ts`, `dashboard/` | Terminal rendering/widget; bounded store, read-only HTTP server, plain DOM page |
| `changes.ts`, `history.ts`, `budget.ts` | Git snapshots; opt-in host run history; running-total cost ledger |
| `handoff.ts`, `review.ts` | Plan cap/model-change handoff; independent review eligibility and quoted prompt data |

Role behavior belongs in `contracts/*.md`. Review **selection** belongs in `fusion.ts`: every review uses the session's configured `ask` backend/model/effort, not the reviewed role's backend or model. Architecture, storage, and runtime limitations are in [Pi backend](pi-backend.md).

## Test strategy

`npm test` starts **no real Claude/Pi child and no paid inference**. It tests policy/protocols with fakes and doubles. A fake subprocess is still a process; it is not a native backend session.

| Layer | Fixture / tests | What a pass establishes |
| --- | --- | --- |
| Claude backend | `fake-claude.mjs`, `child.test.ts`, backend tests | Real SDK objects speaking stream-json to a fake binary |
| Host lifecycle | `fake-pi-backend.ts`, `lifecycle.test.ts`, controls/session/routing/records tests | Admission, writer slot, records, continuations, questions, reviews, and cross-backend policy |
| Pi native protocol | `fake-pi.mjs`, `pi-transport.test.ts`, `pi-backend-transport.test.ts` | Host framing, request/event order, composition, and process cleanup against literal RPC replies |
| Pi helper stages | Binding/storage/launch/bootstrap/restore/question/prepare/task/outcome/backend tests | Validation, sequencing, gates, accounting, and mapping against scripted doubles or fenced fake subprocesses |
| Codex binding | `codex-binding.test.ts`, routing/lifecycle/profiles Codex cases | Pure parameter/selection/contract binding; host routing, display, and review through an in-memory own `codex` double, never a Codex app-server |
| Configuration/mode | `profiles.test.ts` | Settings/store/commands, off-by-default, reminder, refresh/rollback, and allow-list preservation against a modeled host |
| Presentation/persistence | Cards, dashboard, browser, history, changes, budget, review tests | Bounded/safe rendering and storage, Git snapshots, cost ledger, and review prompts/eligibility |

Extension test hosts register `tripwires()`, the Pi and Codex tripwires together, in place of production Pi and any production Codex. Every tripwire entry point records a reach and throws; a file-level check catches accidental routing even when the extension turns that throw into a report. An injected backend uses `{ ...tripwires(), pi: own }`; a case about a left-out backend overrides its key with `undefined`. Codex roles now bind, so a call routed to a registered Codex backend reaches it: a case must override `codex` with `undefined` (as this build stands) or with an in-memory own double, never let it reach the tripwire. The two `productionDefaults()` hosts only test Pi missing-model binding refusals and never ask the registered backend to run. They still register the Codex tripwire, because a Codex role with no model uses the host default and no missing-model refusal would stop it, and they refuse to start while a Pi or Codex selection variable or `PI_FUSION_CODEX_BIN` is set. `test/backends.test.ts` audits that every registration names `tripwires()` or `productionDefaults()`, never both, and that `productionDefaults()` keeps the Codex tripwire. Every host injects a memory profile store, so it reads/writes no user `profiles.json`.

Activate Fusion through the registered mode tool, not a default-on test option. Security tests must explicitly enable that role. Add scenarios to `fake-claude.mjs` rather than mocking the SDK; `FAKE_CLAUDE_SCENARIO` selects one, `PI_FUSION_CLAUDE_BIN` selects the fake, and `FAKE_CLAUDE_LOG` records its stdin.

A terminal state can precede a run's final Git snapshot and branch entry. Wait for the run's own end (`control wait`) before asserting persistence, not merely for `status: done`.

`test/backends.test.ts` and related static checks use the TypeScript parser/scanner to pin registration, SDK import boundaries, and loader order. They are source checks, not evidence that a real install or default start binding was exercised. The bootstrap suite's two unfenced calls inspect public exports and `getAgentDir()` only; neither constructs a session/model runtime. Its SDK fence is a resolution rule, not a sandbox.

The dashboard browser test looks for `PI_FUSION_CHROME`, usual platform paths, then Chromium on `PATH`, and skips if absent. Static dashboard checks prohibit inline script/style/event attributes, HTML injection APIs, `eval`, `new Function`, CSS `url()` and `@import`. Build DOM nodes individually.

## Manual harnesses

These stay under `test/spikes/`, outside the default test glob. Run them only as an explicitly agreed qualification step, one at a time in the foreground. This documentation cleanup does **not** rerun them.

Use direct Node, not `npx`, with dependencies already installed. Record Node/Pi versions, selected cases, exit status, stdout/stderr, skipped cases, and the kept fixture root. A short success excerpt is not a substitute for reading the complete selected run's footer and evidence. Use a sanitized controller environment as well as each harness's own synthesized child environment; do not supply real credentials or reuse a real profile.

### Session lifecycle

```bash
node test/spikes/pi-session-lifecycle.mjs --list                  # catalogue only; exits 2
node test/spikes/pi-session-lifecycle.mjs --case production --keep
node test/spikes/pi-session-lifecycle.mjs --case row3-fork-at --keep
node test/spikes/pi-session-lifecycle.mjs --case=stage-b --keep
node test/spikes/pi-session-lifecycle.mjs --keep                   # all cases
```

`stage-a` and `stage-b` use generated public-SDK bootstraps and a **simulated** host record ledger. `production` drives `createPiBackend` through storage, bootstrap, transport, restore, questions, task, outcome, and cleanup. Its wrapped start passes the launch unchanged to `startPiChild`; it does not exercise `fusion.ts` routing or the default start binding.

Production launches require the composed environment to carry exactly `PI_OFFLINE=1`, root-contained writable/input paths, and no composed catalog base URL. A scripted loopback service is the only model endpoint configured; there is no fetch guard/egress boundary in this group. PID files are fixture assertion/emergency-cleanup oracles, never inputs to production discovery. The detached case is Linux-only. Launch-to-handoff and descendant-to-pid-file windows remain limitations, not isolation guarantees.

Exit 0 means every selected case passed, 1 means failed/unproven, and 2 means no case ran (including `--list`, unmatched/missing selectors, or unknown arguments). Both `--case value` and `--case=value` are accepted. `--keep` retains the fixture root for inspection.

### Configuration, resources, auth, and helpers

```bash
node test/spikes/pi-config-writes.mjs --stage impl --keep
# Read the implementation result before starting a separate historical run:
node test/spikes/pi-config-writes.mjs --stage historical --keep
node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep
```

Stages are `impl`, `historical`, or `all` (default). `--case` selects a case/group; `--pi <absolute CLI path>` adds an installed-CLI comparison where the historical cases support it. The implementation stage drives storage/input/launch/bootstrap through `pi-storage-caller.mjs`, **not production transport**. P5 covers explicit resources and preflight controls, P6 fixture OAuth rotation/failure, and P7 catalog/helper acquisition and bounded-retry behavior.

`pi-fetch-guard.mjs` wraps only `globalThis.fetch` in preloaded fixture processes, refuses unowned origins, and prevents automatic redirects. It covers no raw socket, other client, or subprocess. P7's `pi-helper-interposer.mjs` loads **after** that guard and maps exact release/asset URLs to owned loopback listeners; it is not a proxy or sandbox. P5's SDK fence and generated `npm`/`git` shims are narrow controls, not filesystem/network confinement.

A native retry notice proves the wrapper matched its failure branch, not an independently counted number of underlying executions or an exact failing syscall. The at-most-two bound comes from wrapper source and fake tests. A recovered call is not relabelled first-attempt success; helper acceptance remains scoped to Linux x64/Node 24.18.0/Pi 0.85.1.

### Credential store and profile guidance

```bash
node test/spikes/pi-auth.mjs --keep
node test/spikes/pi-auth.mjs --case A3 --keep
node test/spikes/pi-auth.mjs --case A1,A5 --keep
node test/spikes/pi-auth.mjs --package /absolute/path/to/another/pi-package --keep
node test/spikes/pi-auth.mjs --case C1 --keep
node test/spikes/pi-profile-guidance.mjs
```

Auth uses `pi-auth-driver.mjs` and a loopback token service with literal dummy credentials. It constructs a public model runtime/credential store, not a session, model request, RPC client, or registered backend. `--case` accepts comma-separated names/groups; skew legs are **NOT RUN** unless `--package` names another installed Pi package. C1 is a separate fake-package leakage control, not native SDK evidence. The driver's observation code does not read shared credential bytes; the controller snapshots them only before/after all drivers have exited.

Profile guidance constructs a real host session under a throwaway root and tests mode/profile changes through slash commands without inference. Mode tools are invoked directly, outside an agent loop: this measures resulting tools/prompts, not a model choosing or obeying them. It starts no child and configures no provider.

### Sanitized controller example (Unix)

Replace both absolute paths before running. This preserves `PATH` deliberately, clears other inherited variables, owns normal home/temp/cache/Git paths, keeps full logs, and runs one selected harness directly:

```bash
env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  /bin/bash --noprofile --norc -c '
    umask 077
    root="$(mktemp -d)" || exit 1
    mkdir -p "$root"/{home,tmp,config,cache,data,state,appdata,localappdata,agent,work,logs,git-template,git-hooks}
    : > "$root/gitconfig"
    export HOME="$root/home" USERPROFILE="$root/home"
    export TMPDIR="$root/tmp" TMP="$root/tmp" TEMP="$root/tmp"
    export XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache"
    export XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/state"
    export APPDATA="$root/appdata" LOCALAPPDATA="$root/localappdata"
    export PI_CODING_AGENT_DIR="$root/agent" PI_OFFLINE=1
    export JITI_FS_CACHE="$root/cache/jiti" NODE_COMPILE_CACHE="$root/cache/node"
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$root/gitconfig"
    export GIT_TEMPLATE_DIR="$root/git-template" GIT_TERMINAL_PROMPT=0
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0="$root/git-hooks"
    cd "$root/work" || exit 1
    /absolute/path/to/node /absolute/path/to/pi-fusion/test/spikes/pi-session-lifecycle.mjs \
      --case production --keep > "$root/logs/stdout" 2> "$root/logs/stderr"
    status=$?
    printf "root=%s exit=%s\n" "$root" "$status"
    exit "$status"
  '
```

Use a fresh sanitized setup for another qualification stage. Retargeting customary paths and disabling inherited Git configuration do not disable repository-local configuration or confine every filesystem write. Harness cleanup is bounded and owned, not a universal process kill. Inspect retained fixtures only within the agreed scope.

## Evidence discipline

Keep three labels distinct: **source inspection**, **deterministic fake/double test**, and **manual native measurement**. Document versions/platforms and skipped cases; do not promote one into another or into a guarantee for future Pi versions. The [backend evidence table](pi-backend.md#evidence-and-limits) records current qualification boundaries, including no native security-role, macOS, Windows, live-provider, or paid-inference qualification.

Historical plans and detailed rounds are retained in Git history. Earlier deviations and possible outside-root effects remain unknown where recorded. Removing obsolete prose authorizes no investigation or cleanup of those artifacts, real profiles, caches, or processes, and no upstream issue submission. The declined helper proposal was never submitted and no SDK source was modified.
