# Spike: what a Pi child writes outside its own directory

The Pi backend proposal says the child must "not edit the user's existing Pi configuration"
([docs/pi-backend-plan.md](pi-backend-plan.md)) but does not say how that is enforced. This spike measured it:
several ways of starting a Pi child were run against a disposable fake user profile and a disposable project, and
every file each one touched was recorded. It changes no runtime code, and it does not pick an architecture; it is
an options report, written so the choice can be made against measurements instead of assumptions.

Findings are marked **measured** (this spike ran it), **source** (read in the installed Pi, not executed here) or
**untested** (neither). Nothing here is a sandboxing claim: every option leaves the child able to run tools,
extensions and credential helpers that write wherever the user can write. What is compared is the writing an
ordinary Pi bootstrap does on its own, before the child does anything.

## Reproducing

```bash
node test/spikes/pi-config-writes.mjs                      # all cases
node test/spikes/pi-config-writes.mjs --case C --keep      # one case, keep the temp root
node test/spikes/pi-config-writes.mjs --pi "$(which pi)"   # add a comparison against another installation
node test/spikes/pi-config-writes.mjs --stage historical   # only the cases in this section
```

The harness has since gained a second stage, which drives the production bootstrap and storage instead of comparing
ways of starting a child: it is `--stage impl`, and it is reported on its own under
[Implementation stage](#implementation-stage-the-production-bootstrap-and-storage-against-real-children) below. The
cases in this section are `--stage historical`, and nothing about them changed.

The harness is a manual one: it spawns real Pi processes, so it stays out of `npm test`, whose glob is
`test/*.test.ts`. It exits 1 when a case breaks a guarantee it is supposed to keep, and 2 when `--case` names
nothing. `--case` selects that case together with the checks that depend on it: `--case B2` also runs the
`B2-auth-read` step that supplies its key, and `--case B5` also runs the `B5-after` startup that measures the
consequence.

Every child runs in one disposable temp root, with `HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`TMPDIR`, the XDG directories, `NODE_COMPILE_CACHE` and `JITI_FS_CACHE` inside it; the harness refuses to launch
when any of those resolves outside the root. The child environment is built from scratch, so no real provider
variable reaches it. Every run sets `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1`. The only model endpoint is a
loopback fixture server that answers one deterministic completion, reached through fake providers with a dummy
key; no credential value is printed, only compared in memory. The one child that is not a Pi session is the
export probe, a read-only `import` of the package that starts nothing; it runs in a temp working directory whose
`node_modules` is a symlink to the repository's, so the bare specifier resolves the way a Fusion child's would.

Each case gets its own seeded copy of a realistic user profile — `settings.json`, `models.json`, `auth.json` with
an `api_key` credential, `trust.json`, `AGENTS.md`, a discoverable extension, a skill, a prompt template and a
local-path package with a marker extension — plus its own project with `.pi/settings.json`, a project extension,
an `AGENTS.md` sentinel and a legacy `.pi/commands` directory. Two cases instead seed the legacy profile shape
(`oauth.json`, `settings.apiKeys`, `commands/`, no `auth.json`). Before and after every phase the harness hashes
every file in the watched directories and reports what was created, modified or removed.

The CLI cases start the child the way the backend proposal describes: `--mode rpc -ne -ns -np --no-themes
-e <bridge> --tools read --session-dir <temp> --model <provider>/<model>`, where the bridge is a generated
stand-in for the Fusion child bridge that reports what the child's command context offers.

The RPC phases are the same in every RPC case: startup, `get_available_models`, `get_commands`, `set_model`,
`set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry`, a bridge
command, one fixture prompt to `agent_settled`, and exit. Each case asserts its own slice of the fixture server's
request log: at least one request, all of them `POST .../chat/completions`, for the model the case selected, with
the seeded credential. The exit phase requires exit code 0 and no signal.

Settings are persisted through an async write queue, so nothing is judged by one quick read. A phase diff is taken
only once three reads in a row agree, and each of the four persisting setters additionally polls the settings file
it is expected to reach, for up to four seconds, before the case records whether the value arrived. An empty diff
therefore means "no write appeared inside that window", not "no write can ever appear".

## What was measured

Pi 0.85.1, the repository's dependency, through `dist/bundle/cli.js`. The system also has Pi 0.87.1 installed
globally; the one comparison run against it (`--pi`) behaved identically in case A and is labelled as such below.
Nothing in this document uses 0.87.1 documentation as evidence about 0.85.1.

Eleven cases ran. Eight of them are full RPC cases — A, B1, B2, B3, B4, B5, B-provider and C — and all eight
reached `agent_settled` with the fixture answer and reported `fork`, `navigateTree`, `newSession` and
`switchSession` as functions on the child's command context. The other three run no prompt: A-migrate and B5-after
start the CLI and stop it again to measure startup alone, and B2-auth-read runs `pi auth print-api-key`.

| Case | Child start | Writes in the user profile | Writes in the project | Writes in the child's own directory |
| --- | --- | --- | --- | --- |
| A | stock CLI, agent directory = the user's | `models-store.json`; `settings.json` rewritten by four setters | `.pi/commands` renamed to `.pi/prompts` | (same directory) |
| A-migrate | stock CLI startup, legacy profile | `auth.json` created, `oauth.json` renamed, `settings.json` rewritten, `commands/` renamed, `models-store.json` | `.pi/commands` renamed | (same directory) |
| B1 | private directory, `--api-key` | none | `.pi/commands` renamed | empty `auth.json`, `models-store.json`, `settings.json` |
| B2 | private directory, key from `$VAR` | none | `.pi/commands` renamed | empty `auth.json`, `models-store.json`, `settings.json` |
| B3 | private directory, `auth.json` symlinked | none | `.pi/commands` renamed | `models-store.json`, `settings.json` |
| B4 | private directory, `auth.json` and `models.json` symlinked | none | `.pi/commands` renamed | `models-store.json`, `settings.json` |
| B5 | private directory, symlink to a *missing* user `auth.json` | `auth.json` created as `{}` | `.pi/commands` renamed | `models-store.json`, `settings.json` |
| B5-after | the user's next startup on that profile | legacy auth migration no longer runs | — | — |
| B-provider | private directory, model from a provider extension | none | `.pi/commands` renamed | empty `auth.json`, `models-store.json`, `settings.json` |
| B2-auth-read | `pi auth print-api-key` on the user profile | `models-store.json` | — | — |
| C | public SDK bootstrap | none | none | `models-store.json` |

## Findings

**The stock CLI rewrites the user's `settings.json` from RPC.** Measured: `set_steering_mode`,
`set_follow_up_mode`, `set_auto_compaction` and `set_auto_retry` each rewrote the file, turning the seeded
`steeringMode: "all"` and `followUpMode: "all"` into `"one-at-a-time"` and flipping `compaction.enabled` and
`retry.enabled` to `false`; each value was polled for and found. Source: `AgentSession.setSteeringMode`,
`setFollowUpMode`, `setAutoCompactionEnabled` and `setAutoRetryEnabled` all call the matching `SettingsManager`
setter, which persists to the global scope. The review finding is real, and it is not a corner case: these are the
controls the backend wants for every run. `set_model` and `set_thinking_level` are the exception — measured: no
write; source: `AgentSession` persists those only with `options.persist`, which RPC never passes.

**The CLI also migrates the project, whatever agent directory it was given.** Measured: in every CLI case,
including all the private-directory ones, startup renamed the project's `.pi/commands` to `.pi/prompts` and
reported it on stderr. It happened with `defaultProjectTrust: "never"` in the child's own settings and with the
bridge reporting `projectTrusted: false`, so project trust does not gate it. Source: `runMigrations(cwd)` runs
before the session exists and calls `migrateCommandsToPrompts` on both the agent directory and `<cwd>/.pi`.
Measured on the other side: case C, which never goes through the CLI, left the project untouched. Measured in the
comparison run: Pi 0.87.1 migrates the project the same way. This is the
discriminator between the two private-directory approaches: a private agent directory protects the user's global
profile, and does nothing at all for their project configuration.

**Startup writes even when nothing is configured.** Measured: every CLI case created `models-store.json` in the
agent directory, and `pi auth print-api-key` created it in the user profile too. Source: `ModelRuntime.create`
defaults its catalog store to `dirname(modelsPath)/models-store.json`, and the locked file backend creates the
file before taking its lock. The same backend creates an empty `auth.json` on first credential read, which is why
B1, B2 and B-provider end up with a two-byte `{}` there. In every configuration tested here the child needed a
writable directory for the file-backed catalog store, and for the file-backed credential store whenever one was
used; case C shows both can be pointed away from the user's profile, and the SDK's `credentials` option can
replace the file-backed store altogether. This spike did not look for a configuration that writes nothing at all.

**A symlink to an auth file that does not exist writes into the user's profile — and costs them a migration.**
Measured in B5: with the child's `auth.json` symlinked to a user `auth.json` that had not been created yet, and the
credential supplied from the child's environment instead, startup created that user file as `{}` with mode 600.
Measured in B5-after: the user's next Pi startup on that profile then skipped the legacy auth migration —
`oauth.json` was still there, unrenamed, and `settings.apiKeys` unmigrated — where A-migrate, the same profile
without the stray file, migrated it. Source: `migrateAuthToAuthJson` returns early when `auth.json` exists. The
safe policy is narrow and easy to state: link to or read from a user auth file only when it already exists, and
otherwise give the child its own `auth.json` or hand it explicit credentials. Source, same code path, untested for
that specific entry point: `ModelRuntime.create({ authPath })` uses the same file backend, so pointing the SDK
bootstrap at a missing user file carries the identical risk. The SDK path does not cure auth-file creation; it
just made a different choice about where the path points.

**Migrations rewrite a legacy profile before anything else runs.** Measured in A-migrate on a profile seeded with
`oauth.json`, `settings.apiKeys` and `commands/`: startup created `auth.json`, renamed `oauth.json` to
`oauth.json.migrated`, removed `apiKeys` from `settings.json` and renamed `commands/` to `prompts/`. A Fusion child
pointed at the user's agent directory would perform the user's migration for them, at a moment the user did not
choose.

**The explicit-resource flags do keep discovery out.** Measured with `-ne -ns -np --no-themes -e <bridge>`:
`get_commands` returned only the built-in `llama` command and the bridge's own command, with no trace of the
seeded user extension, project extension, skill, prompt template or the local-path package's marker extension.
Source: with `noExtensions` the resource loader uses the CLI list alone. Two caveats. Source: package *resolution*
still runs, and a missing npm or git package would be installed — `PI_OFFLINE` is what stops it, not the resource
flags (not executed here). Source and measured: the CLI always adds Pi's built-in extensions, so `llama` is present
in every CLI case and absent in case C.

**A provider extension works as a role's explicit resource, on both paths.** Measured in B-provider: a child with
*no* `models.json` at all, given one `-e provider-ext.ts` that calls `pi.registerProvider` with the loopback model
and `apiKey: "$SPIKE_FIXTURE_KEY"`, listed `fixture-ext/fixture-model` in `get_available_models`, selected it and
settled a prompt against it. Measured in C: the same extension in the SDK bootstrap's explicit extension list also
reached `get_available_models`, alongside the provider from the user's `models.json`. So "the role lists the
provider extension it needs" holds for both options, and neither needs a provider entry in a copied `models.json`.

**Context files follow the agent directory, not the flags.** Measured: the project `AGENTS.md` sentinel was in the
system prompt in every case, including the ones where the project was not trusted; the user-level `AGENTS.md`
sentinel appeared only in case A, where the agent directory was the user's. So a private child directory drops the
user's global instructions and keeps the project's, which is what the plan asks for.

**`--api-key` never lands on disk, but it lands in the process table.** Measured: with `--api-key`, the child's own
`auth.json` stayed `{}` and held no copy of the credential. Source: `setRuntimeApiKey` only adds an in-memory
overlay in `RuntimeCredentials`. The cost is that the key is an argv element for the lifetime of the run.

**A symlinked existing `auth.json` shares the credential without copying it.** Measured in B3 and B4: the user's
`auth.json` was byte-identical after every phase, and the child never wrote through the link. That holds for
`api_key` credentials. Source: for OAuth, `resolveStoredOAuth` in pi-ai refreshes an expiring token inside
`credentials.modify`, which writes the rotated credential back through the store — through the symlink, into the
user's file. Untested: no safe deterministic OAuth fixture exists here. This is the same on both options: an SDK
bootstrap reading the user's `auth.json` rotates it too. It is intentional behaviour, not a leak, and whether it
is wanted (one token for host and child) or must be avoided (the child needs its own login) is a decision.

**The `pi auth print-api-key` helper writes while reading.** Measured: `pi auth print-api-key --provider fixture`
returned the seeded credential and exited 0, and created `models-store.json` in the user profile while doing it —
that helper builds a `ModelRuntime` with the default catalog store path, beside the user's `models.json`. This is
a property of that CLI helper's defaults, not of reading a credential: case C reads the user's `auth.json` in
place with the catalog store redirected into the child's directory and writes nothing in the profile. What does
follow from any design that resolves the key and hands it to the child through the environment, however it reads
it, is a copy of the credential in Fusion's memory and in the child's environment.

**The public SDK bootstrap works.** Measured: a runtime built only from the package's public entry point —
`SettingsManager.inMemory`, `ModelRuntime.create({ authPath, modelsPath, modelsStorePath })`, `SessionManager.create`,
`createAgentSessionServices`, `createAgentSessionFromServices`, `createAgentSessionRuntime` and `runRpcMode` —
served the full RPC phase sequence, settled a prompt, exposed the bridge's command context, registered an explicit
provider extension, and left both the user profile and the project byte-identical, including through all four
setters, which had no file to write. Measured: `AuthStorage` is not a public export in 0.85.1
(`typeof pkg.AuthStorage === "undefined"`) and the deep import `@earendil-works/pi-coding-agent/dist/core/auth-storage.js`
fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` — this is a naming detail, not an obstacle: `ModelRuntime.create`'s
public `authPath` and `credentials` options cover both reuse of a file and an in-memory store. Measured, minor: the
package publishes no `require` condition, so `require.resolve("@earendil-works/pi-coding-agent")` fails and the
entry has to be resolved as ESM.

## The options

The table compares what each option writes on its own during the measured sequence — startup, the RPC setters, one
prompt, exit. It excludes two things that are equal on all three and are not bootstrap behaviour: an explicitly
shared OAuth credential, which the child refreshes and rotates in the user's file by design, and whatever the
child's tools, extensions and any `!command` credential helper in `models.json` choose to write.

| | A: stock CLI on the user's directory | B: stock CLI on a private child directory | C: public SDK bootstrap |
| --- | --- | --- | --- |
| User's global profile | rewritten settings, new catalog cache, migrations | unchanged (measured, with an existing auth target or the safe missing-auth policy below) | unchanged (measured, same caveat for an existing `authPath`) |
| User's project configuration | `.pi/commands` migrated | `.pi/commands` migrated (measured) | untouched (measured) |
| Credential reuse | inherited directly | `--api-key`, `$VAR`, or a symlink to an existing `auth.json` | any path, including reading the user's `auth.json` in place |
| Model configuration reuse | inherited directly | a copied or symlinked `models.json`, or a provider extension | the user's `models.json` read in place, cache redirected, or a provider extension |
| Provider extensions | discovered, or listed explicitly | listed explicitly, works with no `models.json` at all (measured) | listed explicitly, registered by the SDK path (measured) |
| Resource control | flags work (measured) | flags work (measured) | resource lists are constructor options, no flags to get wrong |
| Exposure to Pi internals | CLI only | CLI only | six public constructors that the `*` peer dependency does not pin |
| What Fusion must build | spawning | a private directory, kept in step with the user's configuration | a bootstrap module, plus whatever the CLI did that Fusion now has to do: built-in extensions, model resolution, project trust |

## Choosing between them

The decision turns on which promise Fusion wants to make. Both promises below are about automatic writes: what a
Pi child does to the user's configuration on its own, during startup and the RPC settings commands. Neither is a
sandboxing claim, and neither covers an explicitly approved shared OAuth credential being refreshed in the user's
file, or anything the child's tools, extensions or credential helpers do.

If the promise is **"a Fusion child's own startup and settings commands never change the user's global Pi
profile"**, option B is enough and is the cheapest: measured, a private agent directory with the user's
`models.json` and `auth.json` symlinked in (B4) left the profile byte-identical through startup, all four setters,
a prompt and exit, while reusing the user's provider configuration and credential without copying either. It keeps
Fusion on the CLI and RPC surface the plan already chose. Its writable boundary is the Fusion-owned child directory
(`settings.json`, `models-store.json`, lock files), the session directory — and the user's project, because the
CLI migrates a legacy `.pi/commands` there during startup, trust or no trust.

If the promise extends to the project — **"neither the global profile nor the project configuration is mutated by
the child's own bootstrap"** — option C is the strongest option demonstrated here, and the only one of the three
that kept the project byte-identical. The price is that Fusion owns runtime construction against six public
constructors the wildcard peer dependency does not pin, and inherits the CLI's remaining jobs, starting with
built-in extensions, which the SDK path does not add.

A middle path exists on paper: keep option B and refuse to start when the project still has a pre-migration
layout, so the child never performs the rename. That was not implemented or tested here, and "which layouts a
future Pi version will migrate" is not something this spike can settle, so it should be treated as an idea, not a
mitigation that is known to hold.

Whichever is chosen, the auth rule from B5 applies: use or link a user auth file only when it already exists.
Otherwise the bootstrap creates it, and an empty `auth.json` silently disables the user's own legacy migration.

## Decisions still needed

- Which promise Fusion makes: global profile only, or global and project. That choice, not the mechanics, picks
  the option.
- Whether OAuth rotation through a shared `auth.json` is wanted or must be avoided. A rotation fixture is needed
  before either is more than a reading of the source.
- Whether the child directory is per host session, per role or per run, and when Fusion recreates it. Symlinks
  make this cheap, but the session directory and the catalog cache accumulate.
- What happens when the user has no `auth.json` yet, or on a platform without symlinks: the child's own auth file,
  explicit credentials, or a refusal.
- Whether the child's role bindings pass Pi's built-in extensions, and which ones; the CLI adds them, the SDK path
  does not.
- Whether the `ask` and review roles keep the project's `AGENTS.md` (they do today, trust or no trust) and drop the
  user's (they do once the agent directory is private).
- Whether Fusion sets `PI_OFFLINE` for children. It is the only thing that stops a configured package from being
  installed at child startup, and it also disables catalog refreshes.

## Verification

Run on 2026-09-26 against Pi 0.85.1 unless noted.

- `node test/spikes/pi-config-writes.mjs` — 11/11 cases kept their guarantees; 8 fixture model requests, one per
  RPC case, each asserted inside its own case; no leaked processes; temp root removed.
- `node test/spikes/pi-config-writes.mjs --case B5` — the dangling-symlink hazard and its consequence, both
  measured.
- `node test/spikes/pi-config-writes.mjs --case nope` — exits 2, so a mistyped case name cannot pass as success.
- `node test/spikes/pi-config-writes.mjs --pi ~/.local/bin/pi --case A-alt` — Pi 0.87.1 produced the same case-A
  diffs as 0.85.1, project migration included.
- `npm run typecheck` — clean.
- `npm test` — 325/325. Two earlier runs that day each showed one unrelated flake (a headless-Chrome click in
  `browser.test.ts`, a socket error code in `extension.test.ts`); both passed on re-run. This revision adds no file
  to the test glob.

---

# Implementation stage: the production bootstrap and storage against real children

Everything above is the research stage: it compared ways of starting a child before any Pi code existed in Fusion,
and it is unchanged. This section is a second, separate stage of the same harness, run after step 4 task 2a landed
`extensions/backends/pi-storage.ts`, `extensions/backends/pi-launch.ts` and `extensions/backends/pi-bootstrap.mjs`.
It measures those modules, through their own interfaces, against real SDK children. Nothing here relabels a
research-stage finding, and the 0.87.1 stock-CLI comparison above stays what it was: a stock-CLI comparison that says
nothing about the bootstrap.

What this stage is not: there is no transport, no bridge, no registered backend, no `security` role, no provider
client and no production environment override in it. The caller that prepares a call and launches a child is
`test/spikes/pi-storage-caller.mjs`, a fixture controller standing in for the Pi transport of step 4 task 6, which has
since been begun in source and which nothing measured here exercises or qualifies.
So a Fusion host record, a history file, a dashboard entry, a question, a steer, a cancellation and a `/tree`
interaction are all **unverified here** — this stage measures a child's own startup, storage and refusals.

## Reproducing

```bash
node test/spikes/pi-config-writes.mjs --stage impl          # the implementation-stage cases only
node test/spikes/pi-config-writes.mjs --stage historical    # the research-stage cases above, unchanged
node test/spikes/pi-config-writes.mjs --stage impl --case P2 --keep    # one group, temp root kept
```

`--case` selects an implementation-stage **group**, because the cases in a group share fixtures: `G` (the harness's
own fetch guard), `P1` (startup and probes), `P2` (durable sessions and every refusal), `P3` (the persistent
catalog), `P4` (independent initialization and concurrency). A mistyped stage or case name exits 2, so it cannot
pass for a clean run.

One group was added after this section was written: `P5`, the child configuration, prompt and resource group of step
4 task 3, reported in its own section at the end of this file. `--stage impl` now runs the 25 cases of this section
and that group's 26. Everything this section reports is unchanged by it — the same cases, the same selectors and the
same request counts — and the 25 were re-measured together with it. `--keep` keeps the whole disposable root: every call spec, every controller observation file,
every guarded-fetch log and a `report.json` of all results. The one thing `--keep` does not keep is a call
directory, because disposing of it is what the case measures; what it held is recorded before it goes.

Two supporting fixture scripts live beside the harness and are reached only by it — the default test glob is
`test/*.test.ts`, so `npm test` loads neither:

- `test/spikes/pi-fetch-guard.mjs`, a `NODE_OPTIONS=--import` preload for the fixture processes and the children
  they launch. What it guarantees, exactly: for a call through `globalThis.fetch` in a process it was loaded into, the
  request goes to one of the exact loopback origins this fixture owns, and **no redirect is ever followed
  automatically** — an automatic redirect is refused at request time with `redirect: "error"`, and only an explicit
  `manual` caller is left to handle a 3xx itself, which brings any request it then makes back through the guard.
  Reading `response.url` after the fact would have been too late: an allowed loopback origin answering
  `302 Location: https://elsewhere` would already have been followed. **It guards `globalThis.fetch` in the processes
  this preload reaches, and nothing else**: a raw socket, a native binding, another runtime's client, a subprocess of
  the Pi child, or code that captured the platform's `fetch` before the preload ran is outside it.

  Its presence is a prerequisite rather than a detail, so every negative request claim in this section rests on it: a
  case fails unless the log is readable, unless an `installed` record exists for **both** the controller and its child
  (`<caller>` and `<caller>/child`), unless every installed guard claims redirect protection, and unless no process
  reported having no global `fetch` to wrap. Three cases measure the guard itself — `G-fetch-guard`,
  `G-fetch-redirect` and `G-guard-required` — and the mutations behind two of them are reported separately below.
- `test/spikes/pi-storage-caller.mjs`, the controller. Per call it runs `piRole`, `prepareCallStorage`,
  `bootstrapInput`, `writeCallInput` and `piLaunch` — the production helpers, not a reimplementation — spawns the bootstrap with the
  launch options they produced, inherits its stdio so the harness drives the real child, records what the helpers
  resolved and what the call directory held, and calls the call-bound `dispose()`. Its other modes are a barrier
  waiter, a fetch-guard probe, and a disposable-storage `ModelRuntime` used only to read which exact builtin model
  the installed SDK offers.

## What was measured

Run on 2026-09-27 on Linux (`Linux 7.0.0-34-generic x86_64`), node v24.18.0, against the repository's Pi **0.85.1**,
and repeated unchanged in the verification sequence that finished just after midnight on 2026-09-28.
**These measurements are Linux-only.** They qualify no other platform, and macOS and Windows runtime behaviour is
not claimed anywhere in this section.

`node test/spikes/pi-config-writes.mjs --stage impl` — **25 of 25 cases kept their guarantees**, in about two and a
half minutes, with exactly 1 model request in the whole run (the one deliberate loopback task in
`P2-durable-create`) and **no request to any origin this fixture does not own**. Requests to an origin outside the
allow-list happen only in the guard's own controls: two are refused before anything is sent, and one deliberate
mutation run reaches a fixture-owned listener on purpose, which is what shows the control is not vacuous.
`node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests, unchanged from
the research-stage report above.

The SDK version is labelled from two sources, neither of them a version gate: the child's own diagnostic line
(`{"event":"pi-fusion-bootstrap","stage":"sdk","sdk":"0.85.1"}`) and the resolved package metadata (`0.85.1` from
the installed `package.json`). The harness compares them and reports both; a package that carried no `VERSION` would
be reported as `unknown` and is **not** treated as an incompatibility.

| Case | What it does | Outcome |
| --- | --- | --- |
| `P0-builtin-probe` | reads the installed SDK's builtin catalog in a process with disposable storage and no network | `VERSION` 0.85.1, `CURRENT_SESSION_VERSION` 3, 40 providers, chose `deepseek/deepseek-v4-flash`, 0 fetches |
| `G-fetch-guard` | the guard's positive and negative control | owned origin 200, unowned origin rejected unsent, 0 requests at the unowned server |
| `G-fetch-redirect` | an allowed loopback origin answers 302 to a loopback origin that is not allowed | the redirect is refused at request time, the forbidden listener sees 0 requests |
| `G-guard-required` | two real children, one launched without the preload | a missing child guard and a deleted log each make a zero-request claim fail |
| `G-managed-filter` | the harness's managed-root predicate against 7 legitimate paths and 10 look-alikes | every legitimate path accepted, every look-alike caught |
| `P1-bootstrap` | production startup and the three non-task probes, no prompt | exact model and level, absolute session path, managed writes only, 0 model requests |
| `P2-durable-create` | one loopback-model task, then close | 1168-byte transcript, 5 entries, version 3, header id = reported session id |
| `P2-durable-reopen` | the recorded absolute path reopened in a new process | same id and file, 2 messages, recorded answer back, transcript byte-identical |
| `P2-private-auth-control` | healthy startup with no user auth file | the private auth path is created by the SDK inside the call directory |
| `P2-refuse-*` (10) | the production preflight against 10 broken transcripts | exit 78, session stage, source bytes untouched, no private auth created |
| `P2-refuse-models` | a malformed user models file holding a credential marker | exit 78, models stage, fixed wording, marker absent from stderr |
| `P3-catalog-cold` | no user models file, loopback catalog refresh | 10 persisted provider entries, canary model in the child, private paths only |
| `P3-catalog-warm` | a second process on the same store | 0 catalog requests, byte-identical store, canary still available |
| `P4-control` | one initializer alone, same catalog fixture | 10 provider entries, all with models: the control the concurrent case is compared against |
| `P4-stale-publisher` | a staged publisher loses to one that has already populated the cache | the winner's bytes survive, the loser reads them before its child starts |
| `P4-concurrent` | two independent initializers, two overlapping children, then one caller closed while the other child serves | one catalog directory, nothing lost or truncated against the control; the second child still answered `get_state` after the first caller's disposal, whose own snapshot still held the second call's exact generated directory |

## Findings

**The production bootstrap starts, serves RPC and answers the three probes in the shapes the adapter reads.**
Measured in `P1-bootstrap`: the four diagnostic stages arrived in order and with no error — `input`, then
`sdk:0.85.1`, `runtime:0.85.1`, `serving:0.85.1` — and the child then answered `get_state` with the exact pair the
call named (`fixture/fixture-model`) and the exact level it named (`medium`), `get_available_models` with an array
holding that pair, and `get_available_thinking_levels` with `["off","minimal","low","medium","high"]`, every one of
them a level the bootstrap's own list knows. No prompt was submitted and the loopback model server recorded **0**
requests. There is no ready protocol, no capability handshake and no use of `get_commands` as introspection: the
three probes are read for their shapes and nothing else is asked of the child.

**A child reports a usable absolute session path inside the project's own durable session directory.** Measured:
`get_state.sessionFile` was absolute and under
`<host-agent-dir>/pi-fusion/children/sessions/project-<digest>/`, the directory existed and was writable, and the
file itself appears with the session's first entry rather than at startup — which is why `P1` asserts the path and
its directory, and `P2` asserts the file. The inherited `PI_CODING_AGENT_SESSION_DIR` deliberately pointed at a
decoy directory in every implementation-stage case, and it stayed empty in all of them: the child takes its session
directory from the call input, not from the environment it inherited.

**Managed writes only, with the user's own files and the project untouched.** Measured in every case: the user
profile compared byte for byte outside the one subtree Fusion owns (`<host-agent-dir>/pi-fusion`, exempted and
inspected separately) was unchanged, the disposable project was unchanged — its legacy `.pi/commands` was still
there, because the bootstrap runs none of the CLI's migrations — and everything the runs created inside the managed
root was under `children/catalog`, `children/sessions` or `calls`. The child's `PI_CODING_AGENT_DIR` was the
Fusion-owned `children` directory in every case and never the host's own agent directory. After each call the
`calls` directory was empty again: `dispose()` removed that call's directory and nothing above it.

**A call with the user's own `auth.json` writes nothing private; a call without one creates its private auth file
and never the user's.** Measured in `P1` (a seeded profile with `models.json` and `auth.json`): `sharedAuth` was
true, the models path was the user's own file, and the call directory held `bootstrap.json` and the call's own
`cache/jiti` and `cache/node` directories, which are where its child's compiler caches go, and nothing else. Measured in
`P2-private-auth-control` (the same profile with both files removed): the call selected its private
`<call-dir>/auth.json`, the SDK created it there, the user's missing `auth.json` and `models.json` were still
missing afterwards, and the per-call `models.json` path — the one that has to stay absent for the shared catalog
store to be used — was never created. That control is what makes the refusals below evidence rather than a vacuous
check: the private auth file is a file this configuration does normally produce.

**Durable persistence holds across processes, and reopening rewrites nothing.** Measured in `P2-durable-create`:
one real child ran one deterministic loopback task to `agent_settled`, recorded a 1168-byte transcript of 5 entries
whose header carried version 3 and the session id the child reported, and the file ended with a newline. The
controller then exited and was shown gone. Measured in `P2-durable-reopen`, in a new process, with
`PI_FUSION_HISTORY` absent from the environment the controller and the child ran in: the child reopened that
absolute path, reported the same session id and the same file, reported 2 messages, and `get_last_assistant_text`
returned the answer the first run had recorded. The transcript's sha was **identical** before and after the reopen —
asserted, not merely recorded, because this case submits no prompt, so a gained entry or a repair on the way in would
be a finding — and the bytes the first run wrote were still the file's prefix, so opening a current-version, correctly
framed transcript neither migrated nor repaired it. No prompt was submitted
on the reopened session and no model request was made. This is plain persistence; the trusted checkpoint,
navigation and fork semantics are task 7's and are not measured here.

**The preflight refuses every broken transcript at the session stage, leaves the bytes alone, and never reaches the
model runtime.** Measured, one real child each, all ten with exit code 78, `stage: "session"`, the source bytes
byte-identical afterwards (or the missing file still missing), 0 model requests, 0 guarded fetches, and a call
directory holding `bootstrap.json` and its own compiler caches, and nothing else, on a configuration whose auth path
*was* the private one — so the absence
of `auth.json` there is what shows the preflight ran before `ModelRuntime.create`:

| Transcript | Diagnostic |
| --- | --- |
| missing | `the recorded session file could not be read (ENOENT); it was not opened and nothing was written` |
| empty | `the recorded session file is empty, so it holds no session to continue` |
| header line removed | `the recorded session file does not begin with a session header` |
| malformed line prepended | `... has a line that is not json: line 1. Pi would skip that line ...` |
| malformed line appended | `... has a line that is not json: line 6. Pi would skip that line ...` |
| final newline stripped | `... does not end with a newline: line 5 is unterminated. Pi would write that newline into the file ...` |
| header version 2 | `... is version 2 and this Pi writes version 3; opening it would migrate the file in place ...` |
| header version 4 | `... is version 4 and this Pi writes version 3 ...` |
| right file, other id | `... holds a different session id than the call expects ...` |
| right file, unknown checkpoint | `the checkpoint this run restores is not an entry of the recorded session file` |

No diagnostic repeated the transcript's path, which is asserted in every one of these cases: the host knows which
session it asked for, and an identity belongs in the run's outcome.

**A malformed models file refuses startup without echoing what is in it.** Measured in `P2-refuse-models`: a
profile whose `models.json` was truncated mid-value, with `SPIKE-MARKER-DUMMY-CREDENTIAL-do-not-echo` standing in
for an API key in the fragment. The child exited 78 at `stage: "models"`, the diagnostic was exactly the
bootstrap's fixed `MODELS_REFUSED` wording followed by the models path the call was configured with, the marker did
**not** appear anywhere on stderr, and the malformed file was not rewritten. This is the conservative
aggregate-error policy working as designed on a real SDK: `ModelRuntime`'s error is one text that can quote the
file, so Fusion says what went wrong in its own words and names only the path the host already passed in.

**A persistent shared catalog, with the user's missing files still missing and the per-call models path still
absent.** Measured in `P3-catalog-cold`, on a profile with no `models.json` and no `auth.json`: the child was given
the private absent models path and its private auth path, ten builtin providers were made available by dummy
api-key variables in its environment, and the catalog refresh went to a loopback fixture. It made **10** catalog
requests, one per configured provider, all of them `GET /api/models/providers/<id>` on this fixture's own port, and
the shared store at `children/catalog/models-store.json` came out with **10 provider entries**, each holding the
fixture's canary model together with a `checkedAt`, a `lastModified` and an `etag`. The child listed
`deepseek/spike-canary-remote` in `get_available_models`, so the persisted overlay reached the runtime. The user's
`models.json` and `auth.json` were still absent, the per-call `models.json` was never created, and a stray
`models.json` seeded in the stable child agent directory was neither read (no `spike-stray/*` model anywhere) nor
rewritten. This case's network was **controlled fixture input** when it was measured: `allowModelNetwork` was turned
on by the fixture on top of a production composition that set it to `false`, and `catalogBaseUrl` points at loopback.
Both were recorded in the run as `controlledOverrides`. `PI_OFFLINE` was deleted from the copied fixture environment
rather than set to an empty string, because Pi enables its own model network exactly when the variable is absent.

> Since step 4 task 5's first subtask, the permission half of that sentence is production's own: composition now sets
> `allowModelNetwork` **true** explicitly, so this case overrides nothing and its `controlledOverrides` hold the
> loopback `catalogBaseUrl` alone. What reaches the wire is unchanged and so is every count above: the request still
> goes to this fixture's loopback catalog, because the base url and the deleted `PI_OFFLINE` are the case's own, and
> the refusal in `test/spikes/pi-storage-caller.mjs` now stops any child that would be online without a fixture
> catalog to go to. The numbers in this section were measured at the earlier revision and are kept as they were.

**The persisted catalog is warm for the next process.** Measured in `P3-catalog-warm`, a second child in a new
process on the same managed root: the loopback catalog server recorded **0** requests and the guarded fetch log
recorded **0** allowed requests for it, the store's bytes were identical to the cold run's, and the canary model was
still in `get_available_models` — restored from the persisted entry rather than from an empty file that merely
exists. What makes it warm is the freshness stamp the cold run persisted; an entry older than Pi's refresh interval
would be revalidated instead.

**A publisher that loses the rename keeps the winner's populated cache, and loses nothing.** Measured in
`P4-stale-publisher`, deterministically, with two independent initializer processes against one initially empty
managed root: the first was held inside the production initializer's own `onStaged` window — internal test
infrastructure, and the only way to reach that window — on a loopback barrier, while the second initializer
published the catalog directory *and* populated it for real, 10 provider entries from 10 catalog requests, sha
`268ad01875836a3d`. The barrier was then released, the held publisher's rename lost, and it read the store
**after** its failed publication and **before** its own child was launched: sha `268ad01875836a3d`, all ten
provider entries, each with its model. Its own staging directory was gone, the child agent directory held exactly
one `catalog` directory, the `calls` directory was empty once both callers had exited, and the final store was the
winner's file byte for byte. The loser's child then made **0** catalog requests and still came up with the canary
model, which is the same fact from the other side: it ran on the cache the winner had populated.

**Two real children overlapping in the shared catalog both come out with usable data, and nothing is lost.**
Measured in `P4-concurrent`, again two independent initializer processes into one initially empty managed root, each
child configured with its own loopback catalog port so a request's arrival attributes it to one caller: a response
barrier held the gated request until both children had one in flight — the two arrivals landed 18 ms apart and
neither was answered until both had arrived — and both children then listed the canary model. Afterwards, with both
writers exited, the raw store parsed as valid JSON with **10** provider entries, all with models, and nothing
missing or truncated against the `P4-control` single-child run. Which of the two initializers publishes is a real
race and this case does not fix it; in the recorded run the first published and the second found the directory
already there. The store was read raw only after the writers were gone, so a legitimate locked write in progress is
never mistaken for corruption.

**One measurement for task 7 to carry: Pi answers a thinking level of its own when the model has none.** Measured
in `P2-private-auth-control`, `P3` and `P4`, whose model is the builtin `deepseek/deepseek-v4-flash`: the call asked
for `medium` and `get_state` reported `high`, with
`get_available_thinking_levels` returning `["off","low","high","max"]` for that model. The bootstrap passes the
level the call names and asserts nothing about what comes back; the strict read-back that decides what to do about a
level a model does not offer is step 4 task 7's, and this is the evidence it starts from. Where the level was one
the model offers (`P1`, `P2` on the loopback fixture model), the exact requested level came back.

## Mutation evidence for the harness's own controls

These are not results of the cases above: they are deliberate weakenings, run to show that the controls would notice.
Each is recorded in the run's own observations under a `mutation…` key, and each is read against the unmutated control
beside it.

| Mutation | What the control should do | Measured |
| --- | --- | --- |
| A copy of the guard with its redirect protection reverted to `follow` (`mutated-guard-follows-redirects.mjs`, written into the disposable root) | the redirect control must stop holding | the 302 was followed, the loopback origin that is not on the allow-list received 1 request, and the log recorded redirect mode `follow` instead of `error` |
| A real child launched with its `NODE_OPTIONS` preload removed | the log check must fail for that call | it failed with *no guard was installed in `["G-guard-no-preload/child"]`*, while the same call with the preload passed |
| The control call's guarded-fetch log deleted before it is read | the log check must fail | it failed with *the guarded-fetch log … could not be read, so this case holds no evidence about what was requested*, plus the two identity checks |
| Ten path names a prefix test would accept (`children/catalogue`, `children/sessionsX/y`, `calls-elsewhere/z`, `children/catalog-old/…`, `children/models.json`, `children/bin/rg`, `helpers`, …) | the managed-root filter must flag every one | all ten were flagged, and all seven paths a call legitimately writes were accepted |

The mutated guard copy is only ever reachable from the disposable root and only under a name beginning with
`mutated-guard`; the harness refuses any other substitute for its own guard file.

## Limitations

- **Linux only, one machine, one Pi.** Node v24.18.0 and Pi 0.85.1. No claim is made about macOS or Windows, and
  none about another Pi version: the research-stage 0.87.1 comparison covered the stock CLI, not the bootstrap.
- **Fixture-simulated caller behaviour.** `piRole`, `prepareCallStorage`, `bootstrapInput`, `writeCallInput`, `piLaunch` and
  the bootstrap are production; the process that calls them, the RPC framing this harness speaks and every
  handshake are the harness's. Fusion's own transport, records, history, dashboard, questions, steering,
  cancellation and process cleanup are **not** exercised, and no Pi backend is registered. That last clause is true of
  this dated round and of this harness, which registers nothing; it is **superseded as a statement about the build** by
  task 8.3, where `extensions/fusion.ts` registers the Pi backend. Nothing this round measured changes with it.
- **Injected network behaviour.** Every model and catalog response came from a loopback HTTP fixture, including the
  canary model and the `last-modified`/`etag` validators that make the cache warm. That says what the installed SDK
  does with those fields, not what the real catalog service returns. No live or paid provider request and no real
  download endpoint was reached in any case.
- **The fetch guard's reach.** It wraps `globalThis.fetch` in the processes the harness preloads it into, refuses any
  origin outside the allow-list, and never lets a redirect be followed automatically — that, and no more, is what the
  negative request claims here rest on. It is not a sandbox: a raw socket, a native client, another runtime, a
  subprocess of the child, or code holding a reference to the platform's `fetch` from before the preload ran could
  still reach the network, and nothing here proves they did not.
- **Availability came from dummy keys.** Ten builtin providers were made available by dummy api-key environment
  variables so the shared store would hold several entries and a loss would be visible. No provider was contacted.
- **Concurrency is bounded evidence, not a proof.** Two deliberate interleavings were measured — a staged publisher
  that loses, and two children inside the catalog refresh at once. Neither rules out an interleaving nobody staged,
  and neither is a stress result.

## Verification

Run in this order on 2026-09-27/28, one at a time, with no two runs overlapping. Every result is from the code as it
stands; nothing was retried and no assertion was relaxed to reach it.

- `node test/spikes/pi-config-writes.mjs --stage impl` — 25 of 25 implementation-stage cases kept their guarantees:
  1 builtin-catalog probe, 4 harness controls (the fetch guard's allow-list, its redirect refusal, its presence as a
  prerequisite, and the managed-root filter), 1 startup-and-probes case, 14 in the durable-session group (create,
  reopen, the private-auth control, ten transcript refusals and the models refusal), 2 catalog cases and 3
  independent-initialization cases. 24 real bootstrap children, 1 model request in total, and no request to any origin
  this fixture does not own; the only requests outside the allow-list are the guard's own controls — two refused
  unsent, one reaching a fixture-owned listener under the deliberate mutation recorded above.
- `node test/spikes/pi-config-writes.mjs --stage historical` — 11 of 11, 8 fixture model requests, byte-identical
  guarantees to the research-stage report above: the implementation-stage additions changed none of them.
- `node test/spikes/pi-config-writes.mjs --case nope` — exits 2, and `--stage bogus` exits 2, so a mistyped selector
  cannot pass for a clean run.
- `node --check` on all three spike scripts — clean.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P1 --keep` — the root is kept with the call spec, the
  controller's observations, the guarded-fetch log, the seeded profile and a `report.json` of every case.
- `npm run typecheck` — clean.
- `node --test test/pi-bootstrap.test.ts test/pi-storage.test.ts test/backends.test.ts test/process-tree.test.ts` —
  102 of 102 passing, none skipped.
- `npm test` — 530 of 530 passing on the first attempt, none skipped, the browser case included.
- `git diff --check` — clean, and no trailing whitespace in any file this section touched.

Re-run independently of the implementer, on the same code and with its own logs kept: `--stage impl` 25 of 25 with one
model request (`/tmp/pi-fusion-step4-task2b-impl-independent.log`), `--stage historical` 11 of 11 with eight fixture
model requests (`/tmp/pi-fusion-step4-task2b-historical-independent.log`), and the default suite twice. The first suite
run was **529 of 530** (`/tmp/pi-fusion-step4-task2b-suite.log`): one failure, the already-recorded intermittent
headless-Chrome timeline click — `TypeError: Cannot read properties of undefined (reading 'click')` from
`test/browser.test.ts:1169` — which touches nothing in this section and is not fixed here. One unchanged confirmation
run then passed 530 of 530 (`/tmp/pi-fusion-step4-task2b-confirmation.log`). The implementer's own runs had passed 530
of 530 first time, so that flake is recorded as intermittent rather than as a result either way.

# Task 3 stage: child configuration, prompt and resources against real children

This is the third report in this file and it does not restate either of the two above. The research stage compared
ways of starting a child; the implementation stage measured task 2's bootstrap, storage and preflight through the
default composition, in which every role names no resource at all. This section measures step 4 **task 3** — the
child's configuration, its prompt composition and its resource rules — against real SDK children, by naming
resources, which nothing above ever did.

It is one added group in the same harness, `P5`, run by the same controller through the same production helpers.
`node test/spikes/pi-config-writes.mjs --stage impl` is now the **superset**: it runs the 25 implementation-stage
cases reported above and this group's 26, 51 in all. The 25 above are unchanged — the same selectors, the same
guarantees and the same request-count expectations — and they were re-measured as part of the verification below.
The research-stage report and its `--stage historical` run are untouched.

What this stage is not, as of this stage: no transport, no bridge, no registered backend, no host record, no history
file and no dashboard entry was part of it. `test/spikes/pi-storage-caller.mjs` is the fixture controller that stood in
for task 6's transport here; a standalone transport has since been written in source, and nothing measured in this stage
exercises or qualifies it. Every model answer came from a loopback fixture. Nothing was installed or downloaded from outside this
fixture: the traffic in this group is loopback traffic to listeners the fixture owns, which is still networking, and
what the cases assert is that only the expected loopback requests were made and nothing left those origins. The three
counted in this section are model requests to the loopback model server; the guard's log is what says no other origin
was reached, and it covers `globalThis.fetch` in the processes it was preloaded into and nothing more.

## Reproducing

```bash
node test/spikes/pi-config-writes.mjs --stage impl --case P5         # this group alone, plus the builtin probe
node test/spikes/pi-config-writes.mjs --stage impl                   # the 25 cases above and this group's 26
node test/spikes/pi-config-writes.mjs --stage impl --case P5 --keep  # the same, temp root kept
```

Two things this group adds to the harness, both of them fixture-side and neither of them production's:

- **A caller patch for resources.** The controller passes a call's `resources.extensions` and `resources.skills`
  through the production composer, which is the internal parameter `bootstrapInput` already takes. For the values the
  composer refuses on purpose — an `npm:`, `git:`, `github:`, `https:` or `file:` entry, which a child has to refuse
  for itself — and for the tool list a fixture extension's own tool has to be on, a labelled post-composition patch
  writes `extensions`, `skills` or `tools` into the composed input and records each as `rawInput:<field>` beside the
  other controlled overrides. It accepts those three fields and refuses any other. No production caller has anything
  like it, and no user-facing parameter, variable or file reaches it.
- **Two protections for the input-refusal cases.** This repository's test-only module fence
  (`test/sdk-fence.mjs`, the same file `test/pi-bootstrap.test.ts` uses) is preloaded with node's own `--import`
  beside the fetch guard, so a preflight that stopped refusing a specifier would find no backend SDK to import and no
  package manager behind it. A correct refusal happens before the SDK is imported, so the fence never fires. What
  carries the claim is not that silence. Each case asserts that the `NODE_OPTIONS` **composed for the launch** carried
  that fence's file url and that the controller did not drop the child's preload — this Pi reports nothing about the
  options its own process was started under, so that half is the environment the call was launched with rather than
  the child's account of itself — together with the guard's own record of installing itself **inside** the child,
  which is the one piece of it the child process produced. On top of those: the child completed no stage at all, its
  diagnostic carried no SDK version, and the fence's refusal marker is absent from its stderr. An uninstalled fence is
  silent too, which is why the installation is asserted first. Alongside it, runtime-generated `npm` and `git` shims stand at the front of the
  child's `PATH`: each logs what it was asked to do and exits 86 without running anything, and `npm_config_registry`
  names a loopback listener this fixture owns. `P5-shim-control` invokes them on purpose, through `PATH`, to show they
  are live; every refusal case then requires that log to exist and to hold no attempt at all.

  Their reach is narrow and is not a sandbox. The fence is a module-resolution rule in the processes it is preloaded
  into. The shims cover the two commands a package install resolves through `PATH` and nothing else: not arbitrary
  code a resource could run, not a subprocess, not a socket. The fetch guard's own limits are unchanged and stated in
  the implementation-stage section above.

## What was measured

Run on 2026-09-28 on Linux (`Linux 7.0.0-34-generic x86_64`), node v24.18.0, against the repository's Pi **0.85.1**,
through the production bootstrap and never the stock CLI. **These measurements are Linux-only** and qualify no other
platform.

`node test/spikes/pi-config-writes.mjs --stage impl --case P5` — **27 of 27 cases kept their guarantees** (26 P5
cases and the builtin-catalog probe the stage always runs first), with 3 model requests in the whole group and no
request to any origin this fixture does not own.

| Case | What it does | Outcome |
| --- | --- | --- |
| `P5-shim-control` | invokes the generated `npm` and `git` shims through `PATH` | both resolved to the shims, both exited 86, both logged, the loopback registry saw 0 requests |
| `P5-suppression` | seeded profile, seeded stable child directory, seeded project, one named extension | only `spike-probe-report` in the commands, only `fixture/fixture-model` available, 4812-byte prompt holding the base prompt, the contract, the project's and an ancestor's instructions and none of the six seeded sentinels |
| `P5-resources-explicit` | an extension, a provider extension and a skill directory, all named | `fixture-ext/fixture-model` selected exactly, `skill:spike-explicit-skill` and the extension command present, the skill's description in the prompt, 1596 files in the call's own compiler caches, the resource source untouched |
| `P5-resources-symlink` | the same shapes reached only through symlink aliases | both loaded, coverage held, commands and prompt as in the case above |
| `P5-input-npm`, `-git`, `-github` | `npm:`, `git:` and `github:` entries | exit 78, `input` stage, *starts with a uri scheme*, no stage reported, the fence in the launch environment and not fired, the preload not dropped, no installer attempt |
| `P5-input-https`, `-file-url` | an `https:` url and a `file:` url | exit 78, `input` stage, *is a url* |
| `P5-input-missing` | an extension path that is not there | exit 78, *is not on this machine* |
| `P5-input-skill-suffix` | a regular skill file not ending in `.md` | exit 78, *does not end in .md* |
| `P5-input-unreadable-file` | an extension file with mode 000 | exit 78, *cannot be read by this child (EACCES)*, mode restored |
| `P5-input-unsearchable-dir` | a skill directory with no search permission | exit 78, *cannot be read and searched by this child (EACCES)*, mode restored |
| `P5-sdk-empty-skill-dir` | a skills entry that is an empty directory | exit 78, `resources` stage, *skills[0] loaded nothing* |
| `P5-sdk-broken-extension` | a local extension whose module body throws | exit 78, `resources` stage, *failed to load*, the failure's own marker absent from stderr |
| `P5-sdk-missing-tool` | a tool list naming a tool nothing registers | exit 78, `runtime` stage, the missing name said |
| `P5-sdk-late-tool` | a tool registered in `session_start` | exit 78, `runtime` stage, the missing name said |
| `P5-package-prompts-themes` | a package bundling a prompt template and a theme | exit 78, `resources` stage, *a role on this backend selects none* |
| `P5-package-skill-undeclared` | a package bundling a skill the call did not select | exit 78, `resources` stage, *skills this call did not name* |
| `P5-package-skill-selected` | the same bundled skill, selected through `skills[]` | started, `p5-package-command` and `skill:spike-pkg-skill` present, the user's own configured package absent |
| `P5-self-file`, `P5-self-package-root` | this install's `extensions/fusion.ts`, and the repository root whose manifest names it | exit 78, `resources` stage, *the child loaded this host's own extension*, child marker `pi` |
| `P5-self-directory` | the directory that holds it | exit 78, `resources` stage, refused as an extension that *failed to load* rather than as self-inclusion (see below) |
| `P5-indirect-recursion` | a local extension that imports Fusion and calls it with a wrapper of the real api | zero property reads and zero calls recorded, no throw, marker `pi`, the fixture's own command present and no `fusion` command |
| `P5-project-write` | a scripted model answers with one `bash` tool call, then text | exactly `node_modules` and `node_modules/spike-marker.txt` created in the project, marker content exact, 2 model requests |
| `P5-counts` | the group's own accounting | 24 bootstrap invocations = 9 pre-SDK refusals + 15 SDK loads; 15 = 9 post-SDK refusals + 6 serving children; 6 answered RPC; 3 loopback requests; 0 skipped |

## Findings

**The inherited configuration reaches no child, and the two things that should reach it do.** Measured in
`P5-suppression`, against a profile and a stable child agent directory seeded with a `SYSTEM.md`, an
`APPEND_SYSTEM.md`, a global `AGENTS.md`, an extension, a provider extension, a skill, a prompt template and a local
package in settings — in **both** places, not only in the user's own profile. The child's own system prompt, read
through the supported command context's `getSystemPrompt()` rather than inferred, held Pi's base prompt, this role's
contract, the project's `AGENTS.md` sentinel and an ordinary ancestor's, and none of the six override sentinels. Its
commands were exactly one: the command the single named extension registered. Its available models were exactly
`fixture/fixture-model` from the user's own `models.json`; the provider extension seeded in the child agent directory
registered nothing. Every seeded file was byte-identical afterwards.

**A named extension, provider extension and skill load, and the role's tool list can require the factory's own
tool.** Measured in `P5-resources-explicit`: the child selected `fixture-ext/fixture-model`, a model that exists only
because the call named a provider extension; `skill:spike-explicit-skill` was in its commands and the skill's
description was in its own system prompt; and the call's tool list carried `spike_probe`, which the production tool
check requires on the session the moment it exists. The one task prompt shows what the child offered a provider:
`bash edit find grep ls read spike_probe write`, with the fixture tool's schema carrying its one declared parameter.
That is corroboration for a registration in the factory body, not a tool list: the allow list decides what is active,
and a model request only shows what was sent.

**A symlinked resource loads, and the production coverage check holds for it.** Measured in
`P5-resources-symlink`, with only the aliases named and the originals never in the same selection. Pi 0.85.1 resolves
an explicit resource path without `realpath`, so a loaded resource keeps the spelling of the entry it came from, and
the lexical coverage check in `extensions/backends/pi-bootstrap.mjs` answers for a link exactly as it answers for a
file. This closes the symlink question task 3 owed; nothing in production was changed for it.

**Every refusable input form is refused before the SDK is imported.** Measured in the nine `P5-input-*` cases: each
exited 78 with a diagnostic from the `input` stage, none reported a single completed stage, none carried `sdk`
metadata, none reached the model server, none left a transcript, and none echoed the value it was handed. The test
fence was in the environment each was launched with, the controller dropped no preload, the child's own guard record
was there, and the fence never fired in any of them — which together with the absent stages and the absent version is
what says the refusal happened before the import rather than instead of it. The installer log in each case existed
and was empty.

**The loader's own results refuse a call a thrown error would not.** Measured in the four `P5-sdk-*` cases and the
three `P5-package-*` cases: an empty skills directory, a local extension that failed to load, a package's bundled
prompt template and theme, and a package's bundled skill the call did not select each refused a child that the SDK
itself would have started. Selecting that same bundled skill through the call's own `skills[]` started it, with the
package's extension command and skill command both present — so the rule is a selection rule and not a refusal of
packages. Two refusals came after the session was constructed (`runtime` stage, the tool checks); in both, no
transcript file appeared in the durable session directory, which is the observable form of that claim — an in-memory
session manager may well have existed.

**This host's own extension is refused as a resource, and a marked child registers nothing when it is imported
anyway.** `P5-self-file` and `P5-self-package-root` refuse at the `resources` stage with the self-inclusion wording,
with the child marker `pi` on the process. `P5-self-directory` is the measured difference and is recorded rather than
smoothed over: an explicit extensions entry goes through this Pi's package manager, which reads a directory by its
`pi` manifest or by the conventional `extensions/`, `skills/`, `prompts/` and `themes/` directories inside it, and
hands a directory those rules find nothing in to the module loader as it is. `extensions/` in this repository is such
a directory, so this host's module is never loaded from it and the call is refused as an extension that failed to
load. The refusal, the stage, the exit code, the absent transcript and the absent model request are the same; only
which of the two refusals arrives differs. The production comparison is unchanged and remains correct where the
loader loads: a file, a package root that resolves to it and a link to either are one finding.

`P5-indirect-recursion` covers the other direction, which no resource check can: a local fixture extension imported
`extensions/fusion.ts` and called it with an instrumented `Proxy` over the **real** `ExtensionAPI` it had been
handed. The wrapper recorded zero property reads and zero calls, and the call did not throw — the marker guard
returns before the host extension touches the api at all — while the fixture's own command was registered on the
original api and appeared in `get_commands`, where no `fusion` command did. Pi 0.85.1 answers no RPC command with the
session's tool names and `get_state` carries no tool field, so there is no tool list to read back here and none is
invented; the host-side positive control for registration is the default suite's own, against a fake api, and Fusion
is never run unmarked in a real child.

**A child's own task writes where a task writes.** `P5-project-write` scripted the loopback model to answer with one
`bash` tool call and then with text: the child created exactly `node_modules/spike-marker.txt` and its parent
directory in the disposable project, with the exact content the command wrote, and the user's profile outside the
Fusion-owned subtree was unchanged. Two model requests, both to the loopback fixture. This is shell execution a
scripted model asked for, and it is **not** a dependency installation: the script holds one tool call and one final
text, the one tool call wrote the marker file, and no installation was requested by any part of it. This case ran
with the ordinary copied `PATH` and **no** installer shim in front of it — the shims belong to the refusal cases and
their control — so it says what was asked for and nothing about what an installer would have done.

## Counts

Kept apart on purpose, because a refused call is not a session and a fenced refusal is not an SDK measurement:

| Count | P5 |
| --- | --- |
| Bootstrap invocations (real child processes) | 24 |
| Refused at the input stage, before the SDK was imported | 9 |
| Children that loaded the SDK and reported its version | 15 |
| Of those, refused before serving | 9 |
| Of those, reached `serving` and answered RPC | 6 |
| Loopback model requests | 3 (one in `P5-resources-explicit`, two in `P5-project-write`) |
| Cases skipped | 0 |

Four cases skip themselves where they would say nothing, in three categories: `P5-shim-control` on Windows, because
its shims are POSIX shell scripts; the two permission cases on Windows, where these file modes are not what they are
here, and wherever the process has no `getuid` or runs as root, where a mode of 000 is still readable; and the
symlink case when the platform or the filesystem cannot create a link. On this Linux machine none of the four
skipped, so the counts above are the whole group. Nothing here qualifies the Windows behaviour of any of them: a case
that skips itself is reported as skipped and measures nothing.

## Limitations

- **Linux only, one machine, one Pi**: node v24.18.0, Pi 0.85.1, `Linux 7.0.0-34-generic`. Nothing here qualifies
  macOS or Windows. Four cases are platform-dependent and skip themselves elsewhere — the shim control, the two
  permission cases and the symlink case — so what they report is a Linux measurement and says nothing about the
  controls or the refusals on another platform.
- **Fixture resources, fixture model.** Every extension, skill, package and theme a case names as a resource is
  generated into that case's own root at runtime, and the one theme is a copy of the installed build's own
  `dark.json` under a fixture name. The deliberate exceptions are this repository's own modules, which the
  self-inclusion cases name (`extensions/fusion.ts`, `extensions/`, the repository root) and which the indirect case
  imports — naming them is the point of those cases. Every model and catalog answer came from a loopback listener,
  and every endpoint any fixture names is a loopback service this fixture owns, the registry variable the shims carry
  included. No package was installed. What the negative half rests on is the reach stated below: within
  `globalThis.fetch` in the preloaded processes, no origin outside the allow-list was reached, and within `npm` and
  `git` resolved through `PATH` in the cases that shim them, nothing was invoked. A registry, git host or download
  endpoint reached another way — a raw socket, a native client, a subprocess — is outside what was observed, and this
  section does not claim otherwise.
- **Project context discovery reaches beyond the fixture root, by design.** A child reads the project's own
  instruction files and its ordinary ancestors' — that is required production behaviour and the positive control in
  `P5-suppression` depends on it — and the walk does not stop at the disposable case root: an `AGENTS.md` at the
  temporary directory's level, or at the filesystem root, would be read if one were there. None was inspected and no
  claim is made about whether any existed; the disposable `HOME`, agent directory and profile retarget where a child
  writes and which configuration it loads, and are not a read sandbox.
- **The controls' reach.** The fetch guard wraps `globalThis.fetch` in the processes it is preloaded into; the SDK
  fence is a module-resolution rule in those processes; the shims cover `npm` and `git` resolved through `PATH`. None
  of the three is a sandbox, and a raw socket, a native client, a subprocess or arbitrary code a resource runs is
  outside all of them.
- **Tool activity is not readable over RPC here.** Pi 0.85.1 has no tool-list command and no tool field on
  `get_state`, so `P5-indirect-recursion` and the tool cases rest on the wrapper's own record, the commands list and
  the production tool check's refusal. A model request's tool schemas corroborate a registration and cannot disprove
  one, because the allow list can keep a registered tool out of a request.
- **Still no Fusion lifecycle.** No host record, history file, dashboard entry, question, steer or cancellation is
  exercised, and the Pi backend is not registered.

## Verification

Run in this order on 2026-09-28, one at a time, with no two runs overlapping and no other suite running beside them.

- `node --check test/spikes/pi-config-writes.mjs` and `node --check test/spikes/pi-storage-caller.mjs` — clean.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P5` — 27 of 27, 3 model requests, 24 real children.
- `node test/spikes/pi-config-writes.mjs --stage impl` — **51 of 51**: the 25 cases of the implementation-stage
  section above, unchanged, and this group's 26. 4 model requests in the whole run (the one deliberate task in
  `P2-durable-create` and P5's three), and no request to any origin this fixture does not own outside the guard's own
  controls.
- `node test/spikes/pi-config-writes.mjs --stage historical` — 11 of 11, 8 fixture model requests, unchanged.
- `node test/spikes/pi-config-writes.mjs --case nope`, `--stage bogus`, `--stage impl --case P6` and
  `--stage historical --case P5` — each exits 2, so a mistyped or out-of-stage selector cannot pass for a clean run.
  `P6` was an unknown selector when that was measured; the task 4 section below adds that group, and the same check
  is re-run there with `P7` as the unknown one.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P5 --keep` — the root is kept with every call spec, every
  controller observation file, every guarded-fetch log, every installer log, the generated shims and a `report.json`
  of all 27 results; the call directories inside it are gone, because disposing of them is what the cases measure.
  Runs without `--keep` removed their own roots and nothing else.
- `npm run typecheck` — clean.
- `npm test` — 563 of 563 passing on the first attempt, none skipped, the browser case included. The suite starts no
  real child of any backend, and nothing in this group is reachable from it.
- `git diff --check` — clean.

After an independent review of this group, five bounded fixes landed in the harness and in this section: the
project-write case's own note (it runs with the ordinary copied `PATH` and no shim, so what it shows is that no
installation was requested), the network wording above, the fixture-provenance and context-discovery limits, the
fence-installation assertion in every input-refusal case, and the wrapper's property record asserted in both places
it is read. They touch assertions and prose inside `P5` only, and nothing in the 25 cases above, in production or in
the suite. Re-run afterwards: `node --check` on both spike scripts — clean; and
`node test/spikes/pi-config-writes.mjs --stage impl --case P5` — **27 of 27** again, 24 real children, 3 loopback
model requests, 0 skipped, with all nine input-refusal cases recording the fence in their launch environment and not
fired. That run used a freshly created verification root holding its own `HOME`, `TMPDIR` and `XDG` directories and a
minimal environment of `PATH` and those alone. Two roots are involved and only one of them goes: the harness's own
spike root, with every case directory under it, is created inside that `TMPDIR` and removed on exit, while the outer
verification root and the run's log inside it are retained. The other commands in the list above were measured before
those fixes and were not re-run for them.

The host then verified that revision independently and sequentially, in the same kind of sanitized environment with
its own `HOME`, temporary, `XDG` and cache directories, keeping its logs under
`/tmp/pi-fusion-step4-task3c-host-sDRhOL/{typecheck,impl,historical,suite,suite-confirmation}.log`. It ran the local
compiler and the test runner directly rather than through the package scripts — `node
node_modules/typescript/bin/tsc -p …` and `node --test test/*.test.ts` — both from the repository's own working
directory, while the manual-harness runs were the ones whose working directory was inside the owned verification
root. The typecheck passed; `--stage impl` was **51 of 51** with 4 model requests; `--stage historical` was **11 of
11** with 8 fixture model requests; and whitespace was clean. The full suite ran **562 of 563** the first time, with
one failure — *the log stays in place when its entry count gains a digit*, the known headless-Chrome `undefined.click`
in `test/browser.test.ts` — and one allowed unchanged confirmation run then passed **563 of 563**.
That first failure is recorded here rather than replaced by the confirmation, and it touches nothing in this section.
Those host results were measured on the revision described above and **precede** the last `P5`-only assertion and
documentation round below; they are not a measurement of it.

That last round, from a narrow re-review, is three changes and nothing else: the skip documentation above, which had
missed the shim control's own Windows skip; two additions to what every input-refusal case requires — that the
controller reported dropping no preload, beside the fence url in the environment composed for the launch, which is
what that observation is rather than anything the child reported about itself; and the scoping of the contact
sentence in the limits to what the guard and the shims can observe. Re-run for it, and for nothing above it:
`node --check` on both spike scripts — clean; `node test/spikes/pi-config-writes.mjs --stage impl --case P5` —
**27 of 27**, 24 real children, 3 loopback model requests, 0 skipped, with all nine input-refusal cases recording
`fenceInLaunchEnvironment: true`, `childPreloadDropped: false` and `fenceFired: false`; and `git diff --check`
clean. Again from a freshly created owned verification root holding its own `HOME`, `TMPDIR` and `XDG` tree under a
minimal environment, with the harness's nested spike root removed on exit and the outer root and its log retained.
Nothing in the typecheck, `--stage impl`, `--stage historical` or suite lines above was re-run for it, and none of
those numbers is claimed for this round. The host also reran that last assertion revision independently:
**27 of 27**, 24 bootstrap invocations (9 pre-SDK refusals, 15 SDK loads; 9 refused, 6 serving), 3 requests, 0 skips,
all nine fence, no-drop and no-fire checks passing, whitespace clean, logged at
`/tmp/pi-fusion-step4-task3c-host-sDRhOL/p5-final.log`; no suite or typecheck was re-run on that `P5`-only revision.

# Task 4 stage: the shared credential file on real children

This is the fourth report in this file and it replaces none of the three above. The research stage compared ways of
starting a child; the implementation stage measured task 2's bootstrap, storage and preflight; the task 3 stage
measured the child's configuration, prompt and resources. This section measures the part of step 4 **task 4** that
needs a real child: what the production bootstrap does with the user's own `auth.json` when the model it was given is
reached through OAuth.

The **store half** of task 4 was measured separately and keeps its own provenance:
[docs/pi-auth-spike.md](pi-auth-spike.md) drove the public `ModelRuntime` credential path directly, with no session,
no prompt and no bootstrap in it. Nothing here restates or replaces that report, and the two are not interchangeable —
one measures the credential store, this one measures a child.

It is one added group in the same harness, `P6`, run by the same controller through the same production helpers.
`node test/spikes/pi-config-writes.mjs --stage impl` is now the **superset** of all three implementation reports: the
25 cases of the implementation stage, the 26 of task 3 and this group's 3, **54** in all. The 51 above are unchanged —
the same selectors, the same guarantees and the same request-count expectations — and they were re-measured as part of
the verification below. The research-stage report and its `--stage historical` run are untouched.

What this stage is not, as of this stage: no transport, no bridge, no registered backend, no host record, no history
file and no dashboard entry was part of it. `test/spikes/pi-storage-caller.mjs` is the fixture controller that stood in
for task 6's transport here, and Pi is disabled in production. A standalone transport has since been written in source,
and nothing measured in this stage exercises or qualifies it. Every model answer came from the loopback fixture and every token
came from a loopback listener this harness owns; no live provider, no real OAuth endpoint and no real profile is
anywhere in it.

## Reproducing

```bash
node test/spikes/pi-config-writes.mjs --stage impl --case P6         # this group alone, plus the builtin probe
node test/spikes/pi-config-writes.mjs --stage impl                   # the 51 cases above and this group's 3
node test/spikes/pi-config-writes.mjs --stage impl --case P6 --keep  # the same, temp root kept
```

What this group adds to the harness, all of it fixture-side:

- **A fixture OAuth provider, reached the ordinary way.** A generated extension registers the provider
  `fixture-oauth` with one exact model at the loopback model server and the three public callbacks a provider with
  OAuth support has — `login`, `refreshToken` and `getApiKey`. The call names it in `resources.extensions`, which the production composer already takes, so the
  provider reaches the child as an ordinary named resource: nothing here registers a provider on a runtime, hands the
  child a key, sets an `apiKey` field or puts a credential in the environment, and the only credential the provider
  can run on is the one the shared file holds. `login` throws — this measures the store on a child, not a login flow.
  `refreshToken` posts the current dummy refresh label to the harness's own endpoint with the signal the SDK supplies,
  refuses with a fixed sentence of its own and the status the fixture itself answered, and re-emits every field of the
  current credential, which is why the provider-specific extra field survives a rotation. `getApiKey` returns the
  access label, which is what a model request then carries.
- **A token endpoint of the harness's own**, one per case: the auth spike's own minter narrowed to what these three
  cases need — no gates, no marks, no held responses. It mints the next dummy generation, or refuses before minting
  for the whole of the case that measures a failed refresh, and it records every request by the generation it carried
  and answers any other path 404 as an unexpected one. It is a credential minter and not an OAuth server: no
  authorization code, no client, no discovery and no provider api is in it.
- **A credential vocabulary instead of a header.** The loopback model server records what a request's
  `Authorization` header *was* only as this fixture's own label: the seeded api-key credential, the generation of a
  literal `DUMMY-access-<n>` label, or none at all. Anything else is `unrecognized` and carries nothing of the value,
  so a header this fixture never issued fails a case rather than being logged. The cases above keep their own
  expectations exactly; this is a field beside the ones they already read.
- **An exact allowance in the shared postcondition.** `checkManagedCall` takes a `profileModified` list, empty for
  every case above. A case that expects the authorized rotation names `auth.json` and still has to come out with the
  modified set exactly that, nothing created and nothing removed. The transient adjacent `auth.json.lock` is **not**
  on that list and is asserted on its own: a lock still there when the diff is taken is a created path and fails, and
  each case also requires it to be gone once every writer has exited.

Every credential in this group is a literal `DUMMY-` label and there is no real refresh-token family in it. Each case
seeds one file, in place, at mode 0600, over the one the profile fixture wrote; the family is never cloned and never
reseeded inside a case. Besides the selected entry, the two well-formed seeds carry four unrelated ones — the api-key
credential the seeded `models.json` provider is reached through, one for another provider, one under `meta` standing
for something a newer runtime may write beside the credentials, and one for a provider nothing here registers — and
both cases require all four back JSON for JSON, because the authorized write is one entry's and not the file's. The
third seed is the malformed one, which is one truncated entry holding a marker and nothing else, and what that case
requires back is its own bytes.

**Who reads the shared file.** Inside the child the SDK's own credential store reads and rotates it through its own
api, which is the behavior under measurement; nothing asks the child or the controller to read it. This harness reads
its bytes only while no caller and no child of that case is running — the seed before the case starts, every byte,
entry and mode assertion after every process of it has exited.

## What was measured

Run on 2026-09-28 on Linux (`Linux 7.0.0-34-generic x86_64`), node v24.18.0, against the repository's Pi **0.85.1**,
through the production bootstrap and never the stock CLI. **These measurements are Linux-only** and qualify no other
platform. Nothing here was measured against 0.87.1: the auth spike's skew leg compared that build on the public
`ModelRuntime` credential path alone, and it does not qualify the bootstrap at that version.

`node test/spikes/pi-config-writes.mjs --stage impl --case P6` — **4 of 4 cases kept their guarantees** (the 3 P6
cases and the builtin-catalog probe the stage always runs first, which this group does not need but which the stage
runs before every group and which is counted honestly here), with **3** real children, **1** model request, **5**
token requests and **1** minted credential in the whole group, and no request to any origin this fixture does not own.

| Case | What it does | Outcome |
| --- | --- | --- |
| `P6-oauth-rotation` | one child on a credential expiring inside the refresh window, one ordinary prompt | `fixture-oauth/fixture-model` selected exactly, 1 token request carrying generation 1, generation 2 minted, 1 model request carrying only generation 2, the file rotated once, profile diff exactly `~auth.json` |
| `P6-oauth-refresh-fails` | the same, with the endpoint refusing 500 before it ever mints | 4 attempts (1 and 3 announced auto-retries of 3), every one carrying generation 1, 0 model requests, the file byte-identical, the child still answering `get_state` afterwards |
| `P6-refuse-malformed-auth` | a malformed credential file, everything else healthy | exit 78 at the `models` stage with the fixed `MODELS_REFUSED` wording, before any prompt, model request or token request, the file byte-identical |

## Findings

**A rotation on a real child writes back once, and the credential the model sees is the one that rotation minted.**
Measured in `P6-oauth-rotation`. The storage selected the user's own file — `sharedAuth` true and `authPath` exactly
the seeded path — and the child came up on the exact pair the call named, with `fixture-oauth/fixture-model` and
`fixture/fixture-model` both available and the OAuth one selected. One token request, carrying the seeded generation
1, answered with generation 2. The one model request the prompt produced carried **only** `DUMMY-access-2`: not the
seeded credential, not the api-key credential the seeded `models.json` provider is reached through, and nothing else
at all — a header this fixture did not issue would have failed the case as `unrecognized`. The prompt was answered by the loopback fixture and the child exited 0. Afterwards the user's
own file held generation 2 as access and as refresh, the minted expiry about forty minutes out, the
provider-specific extra field still there, its four unrelated entries JSON for JSON, mode still 0600 — and the
generic profile diff was exactly one modified `auth.json`, with the project unchanged, the inherited decoy session
directory untouched, the managed root holding only the catalog, the sessions and the calls directory, the call
directory holding the call input and its own compiler caches and then disposed of, the calls directory empty and no
`auth.json.lock` beside the credential file. Guarded traffic was exactly one `/token` and one `/v1/chat/completions`.

**The refresh happens for the work, not for the startup.** In both cases that reach the endpoint, **zero** token
requests were made before the prompt went out: startup, the three non-task probes and the model and thinking-level
reads are all on the other side of the first attempt. That is measured by the harness's own clock, which is also the
clock the token endpoint records with.

**A refresh that cannot mint fails the task, four attempts in, and leaves the child and the file as they were.**
Measured in `P6-oauth-refresh-fails`, with the production retry settings exactly as the bootstrap composes them —
`retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 }` — and with no retry, no attempt and no bound of this
harness's own added to them. The endpoint answered 500 to everything. This Pi asked the provider's callback **four**
times: the task's own attempt and three announced `auto_retry_start` events of `maxAttempts` 3, about 2s, 4s and 8s
apart. Every one carried the seeded generation 1, so no partial rotation happened between them. Three `agent_end`
events said `willRetry: true` and the fourth said false, and `agent_settled` followed — which is why neither the
prompt's acknowledgement nor an `agent_end` is what this case waits for. No model request was made at all. The
credential file was byte-identical afterwards, its entries and its 0600 mode intact, with no lock beside it and the
call directory disposed of; the child exited 0 and answered a non-task `get_state` after its failed task, still
reporting `fixture-oauth/fixture-model`.

What that failure looked like, recorded as evidence rather than copied, and **required** rather than only recorded: the
RPC events the child emitted carried the SDK's own `OAuth refresh failed for` text and this fixture's own refusal
sentence, and **no** dummy credential label. All three are assertions of the case, so a change in any of them is a
finding this section has to be corrected for. What they pin is one fixture on one build and **not** a redaction claim:
a child's own task output and the SDK's own stderr are not filtered by the bootstrap, nothing here intercepts them, and
the one thing this repository does fix is the wording of the startup diagnostic Fusion itself writes.

**A malformed credential file refuses the call at startup, and the refusal says nothing about it.** Measured in
`P6-refuse-malformed-auth`, with the models file, the named resource and the exact model all the ones the rotation
case runs on. The file was readable, so the storage selected it and `sharedAuth` was true. The child completed
`input` and `sdk`, then refused from the **`models`** stage with exit 78 and the bootstrap's fixed `MODELS_REFUSED`
wording, whose one path is the models file the host composed. The diagnostic carried the four keys it may carry —
`event`, `stage`, `sdk`, `error` — and named neither the marker that stood in for a credential, nor the credential
file's path, nor its name; the marker is absent from the child's stderr as well. There was no prompt, no model
request and no token request, no transcript in the durable session directory, the file was byte-identical, no lock
was left and the call directory was disposed of. The auth spike measured the aggregate `getError()` behind this and
said the bootstrap *would* refuse such a configuration by the rule it already applies — a read of that code. This is
that refusal, on a child; the two findings stay distinct.

## Counts

Kept apart on purpose, because a refused call is not a session:

| Count | P6 |
| --- | --- |
| Bootstrap invocations (real child processes) | 3 |
| Refused at the input stage, before the SDK was imported | 0 |
| Children that loaded the SDK and reported its version | 3 |
| Of those, refused before serving | 1 |
| Of those, reached `serving` and answered RPC | 2 |
| Loopback model requests | 1 (in `P6-oauth-rotation`) |
| Token requests | 5 (1 in `P6-oauth-rotation`, 4 in `P6-oauth-refresh-fails`, 0 in the refusal) |
| Credentials minted | 1 |
| Cases skipped | 0 |

## Limitations

- **Linux only, one machine, one Pi**: node v24.18.0, Pi 0.85.1, `Linux 7.0.0-34-generic`. Nothing here qualifies
  macOS or Windows, and nothing here qualifies the bootstrap at another build.
- **One provider, one shape of credential, one file.** The provider is a fixture whose credentials are `DUMMY-`
  labels and whose endpoint is a loopback listener; there is no real OAuth flow, no authorization code, no provider
  api and no login anywhere in it. A provider that behaves differently — one whose callback drops fields, one that
  rotates remotely before answering, one that answers a credential the store refuses — is not measured here.
- **The attempt count is a measurement of this build.** Four attempts is what Pi 0.85.1 did with the bootstrap's own
  retry settings for a refresh that always fails. It is recorded and required so a change is a finding; it is not a
  policy of Fusion's and not a promise about another build.
- **A failure after a remote rotation is not measured.** The failing case refuses before a token was ever minted, the
  same boundary the auth spike's `A4` names.
- **Two children on one credential file are not measured here.** The overlap case is the auth spike's, on the store
  half; these three cases run one after another, each on a file of its own.
- **Not atomic, and races are not closed.** The store writes the file in place, the storage resolves the user's path
  before the call directory exists, and no case crashes a writer or replaces a file mid-call. Durability and external
  replacement are as untested here as they are there.
- **The controls' reach is unchanged.** The fetch guard wraps `globalThis.fetch` in the processes it is preloaded
  into — the controller and the child — and nothing else: not a raw socket, not a native client, not a subprocess, not
  arbitrary code a resource runs. It is not a sandbox.
- **Still no Fusion lifecycle.** No host record, history file, dashboard entry, question, steer or cancellation is
  exercised, and the Pi backend is not registered.

## Verification

Run in this order on 2026-09-28, one at a time, with no two runs overlapping and no other suite running beside them.
Every harness run had its own owned root holding its `HOME`, `TMPDIR` and `XDG` directories and a working directory
inside it, under an environment of `PATH` and those alone: no inherited `NODE_OPTIONS`, provider key, `PI_*` variable
or profile path reached any of them. The harness's own spike root is created inside that `TMPDIR` and removed on exit
except where `--keep` is named; the outer root and its logs are retained.

- `node --check test/spikes/pi-config-writes.mjs` and `node --check test/spikes/pi-storage-caller.mjs` — clean.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P6` — **4 of 4**, 3 real children, 1 model request, 5
  token requests, 1 mint, 0 skipped.
- `node test/spikes/pi-config-writes.mjs --stage impl` — **54 of 54**: the 25 implementation-stage cases, task 3's 26
  and this group's 3, all unchanged in their own expectations. 5 model requests in the whole run (the deliberate task
  in `P2-durable-create`, P5's three and P6's one), and no request to any origin this fixture does not own outside the
  guard's own controls.
- `node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests, unchanged.
- `node test/spikes/pi-auth.mjs --package <0.87.1 install>` — the store half re-run untouched beside this work:
  **10 of 10** cases and **1 of 1** control, 14 real SDK driver processes, 6 mints, 5 loopback control calls, 0
  skipped, 0.85.1 and 0.87.1.
- `node test/spikes/pi-config-writes.mjs --case nope`, `--stage bogus`, `--stage impl --case P7` and
  `--stage historical --case P6` — each exits 2, so a mistyped or out-of-stage selector still cannot pass for a clean
  run. `--pi` is unchanged and still historical-only: it names another installed Pi's CLI, which nothing in this
  stage invokes.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P6 --keep` — the root is kept with every call spec, every
  controller observation file, every guarded-fetch log, the generated OAuth extensions and a `report.json` of all 4
  results. Inside it every case's calls directory is empty, no `auth.json.lock` is beside any credential file, the
  rotated file holds generation 2 with its four unrelated entries, and the two other files are exactly as seeded.
  Runs without `--keep` removed their own roots and nothing else.
- `npm run typecheck` (as `node node_modules/typescript/bin/tsc -p .`) — clean.
- `npm test` (as `node --test test/*.test.ts`) — **566 of 566** passing on the first attempt, none skipped, the
  browser case included, so no confirmation run was needed. The suite starts no real child of any backend, and
  nothing in this group is reachable from it.
- `git diff --check` — clean.

After an independent source-only review of this group, three small fixes landed in the harness and in this section and
in nothing else: the failed refresh's error surface, which was an observation and is now three assertions beside that
case's attempt count, its zero model requests and its liveness check; the callback count in the provider fixture's own
comment, which is a display name and three callbacks; and the historical framing of two paragraphs in
[docs/pi-backend-plan.md](pi-backend-plan.md), where a review limit written before this evidence existed now says so
instead of reading as current. No production file, no case selector and none of the 51 cases above was touched. Re-run
for it, and for nothing above it: `node --check test/spikes/pi-config-writes.mjs` — clean;
`node test/spikes/pi-config-writes.mjs --stage impl --case P6` — **4 of 4** again, 3 real children, 1 model request, 5
token requests, 1 mint, 0 skipped, with the three error-surface assertions passing; and `git diff --check` — clean.
Again from a freshly created owned root with its own `HOME`, `TMPDIR` and `XDG` tree under a minimal environment. The
`--stage impl`, `--stage historical`, auth-harness, selector, `--keep`, typecheck and suite lines above were measured
before those fixes and were not re-run for them; the host's own independent run of the whole manual groups and the
suite is what will cover them.

The host then confirmed that revision independently and sequentially, and this is the record of its run rather than the
implementer's. Its root is `/tmp/pi-fusion-step4-task4c-host-xQ0bnd`, with
`{typecheck,impl,historical,auth,suite,whitespace}.log` in it. The local compiler and the test runner were invoked
directly rather than through the package scripts — `node node_modules/typescript/bin/tsc -p .` and
`node --test test/*.test.ts` — from the repository's own working directory, while the manual harness runs had their
working directory inside that owned root. Every one of them ran under `env -i` with an owned `HOME`, temporary, `XDG`
and AppData tree and a `PATH`, so no provider key, `PI_*` variable or `NODE_OPTIONS` of the machine reached any of them.

- typecheck — clean.
- `--stage impl` — **54 of 54**, 5 model requests: the 25 implementation-stage cases, task 3's 26 and this group's 3.
- `--stage historical` — **11 of 11**, 8 fixture model requests.
- `node test/spikes/pi-auth.mjs` with the alternate build — **10 of 10** cases and **1 of 1** fake-package control, 14
  real SDK driver processes, 6 token mints, 5 loopback control calls, 0 skipped.
- the full suite — **566 of 566** on the first attempt, 0 skipped.
- whitespace — clean.

Inside its `--stage impl` run this group came out as it does above: `P6-oauth-refresh-fails` asserted and observed
`{carriesDummyMarker: false, namesTheFixtureEndpointRefusal: true, oauthPrefix: true}` with 4 failed refresh attempts,
and the group's counts are unchanged at 3 bootstrap invocations, 3 SDK loads, 2 serving children, 1 startup refusal and
1 model request. The implementer's runs above and the review round before this one stay as the earlier measurements they
were; this confirmation is added beside them and replaces none of them.

# Task 5 note: the online catalog permission and the child's `PATH`

This is a note rather than a stage: step 4 task 5's first subtask changed what Fusion composes, and it added **no new
case group**. There is no `P7` yet, and nothing below is a measurement of a real child reusing a helper.

What changed in production. `piPaths` now also names `<host-agent-dir>/bin`, the directory Pi fills with the helpers
it downloads, as `hostBinDir` — read-only input metadata, computed from the host agent directory the layout is already
given: nothing stats it, creates it or requires it to be there, and `prepareCallStorage` leaves it alone.
`childEnvironment` appends it to the **child's** `PATH`, under every spelling the environment carries that variable
under and with the target platform's delimiter, exactly concatenated: the inherited value is not trimmed, split,
deduplicated or normalised, and a value that already ends in a delimiter keeps the empty entry it makes. The host's
own environment is copied and never changed. And `bootstrapInput` now sets `allowModelNetwork` **true** explicitly,
rather than the `false` this foundation composed while the policy was undecided.

The two accepted exceptions, which are one exported answer. `hostBinPlacement(env, hostBinDir, platform)` is a pure
function returning `appended`, `no-path` or `unrepresentable`, and `childEnvironment` reads it rather than repeating
the rule. `no-path` is an environment with no non-empty spelling of `PATH`: an absent one stays absent and an empty
one stays empty, because filling either with a single directory would replace whatever that means to the platform's
own lookup with one directory of Fusion's choosing. `unrepresentable` is a bin whose own absolute path holds the
character that platform splits a search path on — `:` on POSIX and `;` on Windows, so a drive letter's colon is not
one — which a `PATH` entry simply cannot carry: appending it would add two entries with one of them relative. Reuse
of the host's helpers is an optimization, so that is a **skipped append and not a refused call**, with every spelling
left byte for byte what it was and every other launch setting composed as usual; a relative bin still fails the
absolute guard it always did. Nothing quotes, escapes, diagnoses or invents a second directory for it, and no knob
was added. **In both cases the child reuses no host helper and none is claimed for it.** Whatever else a child's own
helper lookup then does — its agent directory's own bin, its `PATH`, a download — stays the SDK's behavior and is not
qualified here.

Permission is not eligibility, and this distinction is **read from 0.85.1's source, not measured**. Setting
`allowModelNetwork` true says a refresh is allowed; whether one happens is Pi's. In that source `ModelRuntime` asks
whether `PI_OFFLINE` is **present at all**, so a user who has it set to anything — `1`, `0`, an empty string — would
have no catalog refresh whatever this field says, while the helper and package paths parse the same variable as `1`,
`true` or `yes`. The `P7` matrix that would put those values in front of a real child **has not been run**, so
nothing here guarantees that every startup network failure is harmless, and that a per-provider catalog failure
leaves an already available model usable stays something later fixtures have to **measure**. Fusion neither coerces,
forces nor clears the variable, and no `modelRefreshTimeoutMs` was added: that value is a signal that can change what
a child finds available, and the SDK already bounds an attempt.

What the harness changed, and what it did not. `test/spikes/pi-storage-caller.mjs` no longer has an
`allowModelNetwork` override at all — normal composition is what turns the permission on — and it now records the
composed permission, the storage's `hostBinDir`, the production classifier's answer for that call, the child's whole
`PATH`, and its own search path read **once before** `piLaunch` and once after it, so the pair is two independent
readings rather than the same one twice. `checkManagedCall`, which every implementation-stage call goes through, now
**asserts** those: a representable non-empty original, an `appended` answer, a child `PATH` that is exactly the
original plus one delimiter plus the bin, and a caller `PATH` unchanged across the launch. That is an assertion about
the launch options; it is not evidence that any child executed a helper out of that directory. It also gained one
fixture-only check production has no equivalent of: when `PI_OFFLINE` is absent **and** the composed input names no `catalogBaseUrl`, it
refuses to launch, so an online composition can never point this harness at the real catalog. In
`test/spikes/pi-config-writes.mjs` the `P1` composition pin now expects `true`, and the two catalog cases dropped a
key that had become redundant; the four places that delete `PI_OFFLINE` are unchanged and are still the two catalog
cases, which name a loopback catalog this fixture owns, and the two fetch-probe controls, which start no child at
all. The `P0` builtin probe still authors `allowModelNetwork: false` for its own disposable runtime, and the
research-stage fixtures are untouched.

What this note does **not** qualify: helper reuse, a helper download, a fallback served from a fixture, two children
falling back at once, or `PI_OFFLINE` at representative values against a real child. Those are the `P7` measurements
task 5 still owes, and they need a real child on a real platform. The evidence here is source portability — the
naming rule, the delimiter and all three placement answers are composed for either platform and read as logic in the
suite — plus a Linux runtime fact about the **launch options** a real child was started with: in every
implementation-stage call the recorded `childPath` is the caller's own search path with that case's profile `bin`
appended after exactly one delimiter, and the caller's own is unchanged across the launch. Windows is not qualified
by any of it, and neither is what a child does with that path once it has it.

## Verification

Run on 2026-09-28 on Linux, node v24.18.0, against the repository's Pi **0.85.1**, one at a time with no two runs
overlapping. Every run had its own owned root holding `HOME`, `TMPDIR`, the `XDG` directories and the logs, under
`env -i` with a `PATH` and those alone: no inherited `NODE_OPTIONS`, `NODE_PATH`, provider key, `PI_*` variable or
profile path reached any of them. The compiler and the test runner ran from the repository's working directory; the
manual harnesses ran from a working directory inside that root.

- typecheck — clean.
- `node --test test/pi-storage.test.ts test/pi-bootstrap.test.ts` — **90 of 90**, 0 skipped.
- `node --test test/*.test.ts` — **568 of 569**, 0 skipped. The one failure is `test/browser.test.ts`'s file-level
  teardown hook — `ENOTEMPTY` from `rmSync` of the Chrome profile directory while Chrome was still exiting — after all
  45 of its own subtests passed. That file imports `extensions/dashboard.ts` alone and nothing this subtask touched.
  It is reported as it happened rather than re-run.
- `node test/spikes/pi-config-writes.mjs --stage impl --keep` — **54 of 54**, 5 fixture model requests, P5's counters
  unchanged at 24 bootstrap invocations and 3 model requests and P6's at 3 invocations, 3 SDK loads, 2 serving
  children, 1 startup refusal and 1 model request. In the kept root all 63 logs are readable, every case's guard
  reports itself installed for both the controller and its child, every allowed request went to a `127.0.0.1` fixture
  port, and the only blocked request is the `G` control's own deliberate one. No origin was added to any allow-list.
- `node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests.
- `node test/spikes/pi-auth.mjs` — **9 of 9** cases and **1 of 1** control, 11 real SDK driver processes, 3 mints, 5
  loopback control calls, **1 skipped**: `A8-skew` is NOT RUN without `--package`, and nothing is qualified across
  versions by this line.
- `node test/spikes/pi-auth.mjs --package <0.87.1 install>` — **10 of 10** cases and **1 of 1** control, 14 real SDK
  driver processes, 6 mints, 5 loopback control calls, 0 skipped, 0.85.1 and 0.87.1.
- The caller's new refusal, with an owned spec of its own and no backend spawned: `PI_OFFLINE` absent and no
  `catalogBaseUrl` refused the call after composition — the recorded input carries `allowModelNetwork: true`, so the
  check is not vacuous — with no input file written, no launch options composed, no child process and the call
  directory disposed of.
- `git diff --check` — clean.

### Re-verified after the placement correction

An independent review of the above found two things: an absolute `hostBinDir` may legitimately contain the target
platform's path delimiter, which exact concatenation would have turned into two entries with one of them relative;
and the manual harness observed the launched `PATH` without asserting it. Both are corrected as described in this
section — `hostBinPlacement` and the `checkManagedCall` assertions — and re-verified on 2026-09-28 from a **new**
owned root, sequentially, under `env -i` with the same isolation as above.

- typecheck — clean.
- `node --test test/pi-storage.test.ts test/pi-bootstrap.test.ts` — **92 of 92**, 0 skipped (the two new pure cases
  above the 90 reported earlier).
- `node --check` on both changed manual files — clean.
- `node test/spikes/pi-config-writes.mjs --stage impl --keep` — **54 of 54**, 5 fixture model requests, unchanged.
  In the kept root all **51** calls that launched a child recorded `hostBinPlacement: "appended"`, a `childPath`
  equal to that call's own `callerPathBefore` plus one delimiter plus its `hostBinDir`, and a `callerPathAfter` equal
  to its `callerPathBefore` — read back independently of the harness's own assertions.
- `node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests, unchanged.
- `git diff --check` and a trailing-whitespace scan of every touched file — clean.

The full suite was **not** re-run for this correction, and the `568 of 569` line above — with its
`test/browser.test.ts` teardown `ENOTEMPTY` — stays the measurement it was, of the revision before it. The auth
harness was not re-run either: nothing in this correction reaches it.

### Independent host verification of this subtask

**Measured by the host rather than by the implementer, sequentially, and recorded here as its own run.** Its root is
`/tmp/pi-fusion-step4-task5a-host-IivheW`, with `{typecheck,focused,suite,suite-confirmation,impl,historical,auth,whitespace}.log`
in it. Every command ran under `env -i` with an owned `HOME`, temporary, `XDG` and AppData tree and a copied `PATH`, so
no inherited `NODE_OPTIONS`, provider key or `PI_*` variable reached any of them; the compiler and the default test
runner ran from the repository's own working directory, and the manual harnesses from a working directory inside that
owned root.

- typecheck — clean.
- `node --test test/pi-storage.test.ts test/pi-bootstrap.test.ts` — **92 of 92**, 0 skipped.
- the full suite — **569 of 570** on the first attempt, 0 skipped. Its one failure is the known browser case `the log
  stays in place when its entry count gains a digit`, which failed on an `undefined.click`. That is a **different**
  failure from the implementer's `568 of 569` above, whose one failure was `test/browser.test.ts`'s teardown hook
  removing the Chrome profile directory with `ENOTEMPTY`; both stay recorded as the measurements they were, and neither
  is restated as the other.
- one confirmation run of the suite, on the **unchanged** revision — **570 of 570**, 0 skipped. It was run once and is
  not a retry loop: the first run's failure is reported above rather than replaced by it.
- `node test/spikes/pi-config-writes.mjs --stage impl` — **54 of 54**, 5 fixture model requests.
- `node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests.
- `node test/spikes/pi-auth.mjs --package <0.87.1 install>` — **10 of 10** cases and **1 of 1** control, 14 real SDK
  driver processes, 6 token mints, 5 loopback control calls, 0 skipped.
- whitespace — clean.

Beside that run, the independent review of this subtask reported **Ready** in its follow-up round, which read the
revision through read-only tools alone. Two earlier rounds are **not** described that way and are not relabelled here:
the initial source review ran a `true` through its shell tool and a preparatory round ran a skipped `echo`, which are
tooling violations of a read-only round rather than executable verification of anything, and no probe of this
subtask's outside effects was authorized in either of them.

# Task 5 stage: helper precedence and the catalog matrix on real children

This is the fifth report in this file and it replaces none of the four above, the task 5 note included: that note is what
the composition half of task 5 changed and how it is asserted as **launch options**, and it stays exactly what it was.
This section is the first half of what that note said it did not qualify — what a real child does with the search path
the launch composed, and what `PI_OFFLINE` and a model catalog endpoint do to a real child's startup. It is the group
that note called `P7` and said had not been run. **Part of it is now run**; the rest of it is not, and is named below.

It is one added group in the same harness, run by the same controller through the same production helpers.
`node test/spikes/pi-config-writes.mjs --stage impl` is now the superset of four implementation reports: the 25 cases of
the implementation stage, the 26 of task 3, the 3 of task 4 and this group's 11, **65** in all. The 54 above are
unchanged — the same selectors, the same guarantees and the same request-count expectations — and they were re-measured
as part of the verification below. The research-stage report and its `--stage historical` run are untouched.

What this stage measures, in two halves:

- **Helper precedence.** Pi's `grep` and `find` tools run `rg` and `fd`, and its lookup for one of them tries the child
  agent directory's own `bin` first and an ordinary `PATH` search second. Those two tools already belong to every
  ordinary Pi role in this build, so a scripted model asks for one of each and the public `tool_execution_end` events
  say which program answered. Three cases put generated fixtures in the three places a lookup can find one: the child
  agent directory's `bin`, an ordinary owned `PATH` entry, and the host agent directory's `bin` that the production
  launch appends for the child alone.
- **The catalog matrix.** `PI_OFFLINE` unset, `1`, `0` and empty against four cold children; a warm second child on the
  first one's own stable directory; an endpoint that answers 503 to everything; and one that accepts and never answers.

What is **not** in it, and what no line here claims: a helper **download**, a fallback served from a fixture or an
intercepted endpoint, an interposer of any kind, and two children falling back at once into one shared bin. Those are
the rest of task 5's obligations, they are **not started**, and nothing below qualifies them. Task 5 is **not
complete** and Pi stays unregistered and refused.

## Reproducing

```bash
node test/spikes/pi-config-writes.mjs --stage impl --case P7         # this group alone, plus the builtin probe
node test/spikes/pi-config-writes.mjs --stage impl                   # the 54 cases above and this group's 11
node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep  # the same, temp root kept
```

What this group adds to the harness, all of it fixture-side:

- **An owned search path, constructed rather than copied.** Every other group runs its children with this machine's own
  `PATH`. These eleven build one: `node` from this process's own `process.execPath`, and `tar` and `gzip` resolved once
  by an ordinary search-path lookup, reached through symlinks in one owned directory that holds nothing else. No
  command comes from a profile configuration, there is no `npx`, no installer and no CLI version check in it, and the
  **installer shims of the `P5` group are deliberately not on it**: these cases are positives about a lookup, not
  refusals about an install. `implEnv` refuses to launch when an explicitly constructed `PATH` carries an entry outside
  the disposable root; the ordinary copied path the other groups use is left exactly as it was.
- **Generated helper fixtures.** Each one is a `#!/bin/sh` program of a few lines that answers `--version`, appends one
  tab-separated line per invocation to an owned log — the place it lives in, the tool it stands for, its own absolute
  path, its `$0`, the search path it saw and the arguments it was given — and prints the one line its caller parses: a
  ripgrep `--json` match event, or one relative path the way fd prints them. They are **not** ripgrep and **not** fd,
  they open no file and search nothing, and no case here asserts anything about search semantics. The absolute
  `/bin/sh` interpreter is deliberate: a script's interpreter is a path the kernel reads and cannot be looked up on
  `PATH`, so it cannot come from the owned directory, and the platform's own shell is the one thing these fixtures
  rely on.
- **A helper log that reaches a child as a file.** `childEnv` creates a directory for every value holding a separator,
  so the log variable is passed through `rawExtra` and assigned after that guard rather than being mistaken for a
  directory; its path is still required to be inside the disposable root.
- **Two failing catalog listeners of its own**, beside the healthy one the cases above use: one that answers 503 to
  everything, and one that accepts a connection and never answers until it is closed. Closing either destroys only the
  sockets it accepted itself; no client, server or socket of anything else is touched, and there is no sleep, timer or
  `modelRefreshTimeoutMs` anywhere in this group.
- **An exact helper allowance in the shared postcondition.** `checkManagedCall` now takes a `helperArtifacts` list,
  **empty in every case that exists today and not exercised by any of them**: each entry is an exact managed-relative
  path that has to be in the created set and is exempted from the stray filter on its own. It is a list of paths and
  never a prefix, a subtree or a wildcard, and neither `MANAGED_WRITEABLE` nor its self-check was widened for it — a
  helper path no case named is still a stray. Exact includes the spelling a diff uses, so a download that creates the
  directory as well as the program in it will have to name `children/bin/` and `children/bin/rg` as two separate
  entries. It is the seam a later download case needs and nothing more; the seeded cases here use the existing
  `seededManaged` list plus their own byte-and-mode comparisons.
- **Its own counters.** A P7 child is counted in this group's set alone, so no total of P5's or P6's absorbs one, and
  the fixture control case runs no child and is in none of them. The counters line also names every case that did not
  run, with its reason, so a skipped case cannot disappear into a count of cases that passed.
- **Each precedence case is tied to the layout the production helpers resolved.** The three places a case seeds are
  computed by the case, and each one is then compared with what this call's own helpers answered: the host helper bin
  against `launch.hostBinDir`, and the child's bin against `bin` inside the `storage.agentDir` the preparation made.
  Without that the ordinary-`PATH` case could pass on a layout that had moved — a trace with no host-bin line reads the
  same whether the host's bin lost the race or was never a directory that child would have looked in at all.
- **A refusal for the raw pass-through.** `implEnv` assigns `rawExtra` last, so a value there could silently replace a
  variable the composition itself decides. Naming `PATH`, `NODE_OPTIONS`, `PI_SPIKE_CALLER`, `PI_SPIKE_FETCH_LOG` or
  `PI_SPIKE_ALLOWED_ORIGINS` now refuses the launch before anything is composed, compared case-insensitively so a
  differently spelled variable is not a way around it. Every other name still passes through — the package cases'
  `npm_config_registry` and this group's helper log among them — and `PI_SPIKE_*` as a family is deliberately **not**
  forbidden, because a later interposer will need explicit keys of its own. It is a check on one fixture's own input; it
  is not a sandbox and says nothing about what a child can reach.
- **Honest NOT RUN reporting for the whole harness.** One classifier decides what a result is: a case with failures
  **failed** whatever else it says, a case that recorded a reason string is **NOT RUN**, anything else **held**. A
  skipped case is never given the wording of one that kept its guarantees and is counted as neither a pass nor a
  failure, and a run with nothing skipped prints the sentence it always printed, word for word. `P5-counts` records a
  `skipped` **array** of other cases' names, which is an observation about them rather than a refusal of its own, so it
  still holds — the string is what makes a skip. No case's own guarantees changed, and the real skips the `P5` group
  can report on another platform became honest with it.

## What was measured

Run on 2026-09-28 on Linux (`Linux 7.0.0-34-generic x86_64`), node v24.18.0, against the repository's Pi **0.85.1**,
through the production bootstrap and never the stock CLI. **These measurements are Linux-only** and qualify no other
platform: the group declares itself qualified on linux x64 and linux arm64 alone, and on any other platform, or without
`tar` and `gzip` on the machine's own path, all eleven cases are reported **NOT RUN** with that reason rather than as
passes. On the machine above there were **0 skips**.

`node test/spikes/pi-config-writes.mjs --stage impl --case P7` — **12 of 12 cases kept their guarantees** (the 11 P7
cases and the builtin-catalog probe the stage always runs first, which this group does not need but which is counted
honestly here), with **10** real children, **16** loopback model requests, and no request to any origin this fixture
does not own.

| Case | What it does | Outcome |
| --- | --- | --- |
| `P7-helper-fixture-control` | no child: reads the constructed path, invokes the generated fixtures itself, and checks two rules of the harness | the owned directory holds exactly `gzip`, `node`, `tar`, each a symlink to the utility the lookup resolved; `rg`, `fd` and `fdfind` all fail `ENOENT` on that path; all 6 fixtures answer `--version` 0, print exactly what their caller parses, and record 12 trace lines; with the log variable taken away one refuses with exit 91 and writes nothing; all 8 reserved-name compositions refuse and the helper log passes through as itself; the four synthetic results classify and print as held, NOT RUN, failed and held |
| `P7-helper-child-bin-wins` | `rg` and `fd` in `children/bin` and different ones on an ordinary owned `PATH` entry | both tool results say `childbin`, the trace is two invocations and no version probe, and the `PATH` fixtures are byte-identical and appear nowhere in it |
| `P7-helper-host-bin-reuse` | `rg` and `fd` in `<host-agent-dir>/bin` only, no child bin, helper-free `PATH` | both tool results say `hostbin`, the trace is a `--version` probe and an invocation per tool, no `children/bin` was created, and the profile's bin is byte- and mode-identical |
| `P7-helper-path-before-host-bin` | different fixtures on the ordinary `PATH` entry and in the host's appended bin | both tool results say `pathbin`, the host's kind appears nowhere in the trace, and both sets are byte-identical afterwards |
| `P7-offline-unset-refreshes` | `PI_OFFLINE` absent, one loopback catalog | the 10 builtin providers this fixture configures a dummy key for asked once each, all 10 canary models available in the child, every entry persisted with both freshness stamps and an etag |
| `P7-catalog-warm-second-child` | a second child on the unset case's own stable directory | 0 catalog requests, the persisted store byte-identical, and all 10 canary models still available |
| `P7-offline-one-no-refresh` | `PI_OFFLINE=1` | 0 catalog requests, no canary model anywhere, an empty store, and the listener answering 200 to the harness's own control call |
| `P7-offline-zero-no-refresh` | `PI_OFFLINE=0` | the same: 0 requests, although the helper and package paths of this build read that value as false |
| `P7-offline-empty-no-refresh` | `PI_OFFLINE=""` | the same: 0 requests, and the child observed the empty string rather than an absent variable |
| `P7-catalog-unavailable` | a listener answering 503 to everything | exactly 3 attempts per provider, 30 in all, back to back; the model selected and answered; every entry persisted with a `checkedAt` and **no** `lastModified` |
| `P7-catalog-hanging` | a listener that accepts and never answers | 3 accepted attempts per provider; the first probe answered 12029ms after the first arrival in the `p7e` run this section reports, inside the 20000ms allowance; the already available fixture model answered an ordinary prompt afterwards |

## Findings

**A child's own agent-directory bin wins, an ordinary `PATH` entry comes next, and the host's appended bin is last.**
Measured in the three precedence cases, each with a different program in each place and each read off the child's own
tool results rather than off a final answer. In `P7-helper-child-bin-wins` both results were the child-bin fixture's
exact output — `childbin-match.txt:1: childbin` and `childbin-find.txt` — with `isError` false, while the `PATH`
fixtures were never started at all: the trace is two invocations and nothing else, because a hit inside the child agent
directory is returned without the `--version` probe a `PATH` lookup makes first. In `P7-helper-host-bin-reuse` the
child agent directory had no bin, the constructed path was helper-free, and the child resolved both helpers through the
appended host bin: a `--version` probe and an invocation for each, both naming the host fixture, and no `children/bin`
was created anywhere. **That is the measurement task 5 names as its acceptance** — a real child resolving a host helper
through its own `PATH` — and it is now made rather than proposed. In `P7-helper-path-before-host-bin` both fixtures
existed and the ordinary entry won: the host's kind appears in no line of the trace, and its files are byte- and
mode-identical afterwards. In all three the `$0` each program recorded is its own absolute path, because a shebang
program is started with the path the kernel resolved whichever way the lookup answered; what tells the two lookups
apart is the version probe, not `$0`.

**`PI_OFFLINE` is read as presence and not as truth, and that is now measured rather than read.** The task 5 note read
from 0.85.1's source that `ModelRuntime` asks whether the variable is set at all. Against a real child: absent is the
only one of the four values that refreshes. `1`, `0` and an empty string each left the child with **zero** catalog
requests while the same dummy provider keys, the same loopback listener and the same composed `allowModelNetwork: true`
were in place, and each of those three cases had the listener answer 200 to one control call the harness made itself,
so the zero is about the variable rather than about a dead port. None of the three children offered a canary model,
which only a refresh could have put there, and none of them persisted a catalog entry. What that settles for Fusion is
what the note hoped: a user who has `PI_OFFLINE` set to anything has a child with no catalog refresh, so composing the
permission cannot turn a user's offline setting into a startup network call.

**A cold refresh asks once per provider and persists a cache a later child trusts.** With the variable absent, ten
builtin providers asked for their catalog exactly once each — one for each of the ten api-key variables
`DUMMY_PROVIDER_KEYS` sets, which is this fixture's own configuration read back rather than a surprise; the four-name
`BUILTIN_KEY_VARIABLE` beside it is a different thing, the map a case picks an exact builtin model from — and each entry
came back with models, a `checkedAt`, a `lastModified` and an etag. The child then offered all ten canary models, which exist only in this fixture's own
answer. The second child on that same stable directory made **no** request at all, left the persisted bytes identical
and still offered all ten: the four-hour window in the installed source is what that rests on, and it is the same
behavior the `P3` pair measured for the catalog directory, now measured beside the offline matrix.

**A catalog that fails is bounded, leaves the model usable, and makes no warm claim.** Against the 503 listener the SDK
made exactly **3** attempts per provider — its own two retries on a retryable status, with no harness retry and no
backoff between them, arriving back to back — and 30 arrivals in all. The child selected the fixture model, answered an
ordinary prompt and exited 0, so **a per-provider catalog failure leaves an already available model usable**, which the
plan listed as an open measurement. What it persists matters as much: each entry has a `checkedAt` and **no**
`lastModified`, which in the installed source is exactly the state that does not satisfy the warm window, so a later
child may ask again. No warm-and-quiet claim follows a failure, and this section makes none.

**A hanging catalog is bounded by the SDK's own attempt timeout.** Against the listener that accepts and never answers,
each provider's request was accepted 3 times, and the child's first non-task probe answered **12029ms** after the first
arrival in the `p7e` run this section reports — and **12043ms** in the host's own final reproduction of it, with 12036ms,
12032ms and 12036ms in the three earlier revisions recorded below, each a measurement of its own run. That is three
bounded 4000ms attempts plus startup, inside this case's 20000ms allowance, measured from the first arrival at the
listener rather than from the launch. The already available fixture model then answered an ordinary
prompt. Nothing here shortened, timed out or retried anything of its own: there is no sleep and no
`modelRefreshTimeoutMs` in the group, and the allowance is a bound on the measurement rather than on the child.

## Counts

Kept apart from every other group's, and the fixture control case runs no child and is in none of them:

| Count | P7 |
| --- | --- |
| Bootstrap invocations (real child processes) | 10 |
| Refused at the input stage, before the SDK was imported | 0 |
| Children that loaded the SDK and reported its version | 10 |
| Of those, reached `serving` and answered RPC | 10 |
| Loopback model requests | 16 (3 in each precedence case, 1 in each of the 7 catalog cases) |
| Catalog arrivals | 10 healthy, 0 in each of the three set-variable cases and the warm case, 30 at the 503 listener, 30 at the hanging one |
| Generated helper programs | 16 (6 in the fixture control case, then 4, 2 and 4 in the three precedence cases) |
| Cases skipped | 0 |

## Limitations

- **Linux only, one machine, one Pi**: node v24.18.0, Pi 0.85.1, `Linux 7.0.0-34-generic x86_64`. The group declares
  itself qualified on linux x64 and arm64 and reports every case NOT RUN elsewhere; nothing here qualifies macOS or
  Windows, and nothing here qualifies the bootstrap at another build.
- **No download, no fallback, no concurrency.** Nothing here downloads, unpacks or installs a helper, and nothing here
  runs two children at once. The fixtures are seeded, the precedence cases run with `PI_OFFLINE=1` so no download is
  even possible in them, and the rest of task 5 owes all three.
- **The fixtures are not the helpers.** They are shell programs that print one parseable line; they implement no
  search, read no file and are not ripgrep or fd. A case that claims a program ran claims nothing about what a real
  helper would have found, and the grep call these cases make carries no `context`, which is the shape that prints the
  matched line the tool was handed rather than reading the file.
- **The attempt counts and the timing are measurements of this build.** Three attempts, no backoff and about 12s are what
  Pi 0.85.1 did with the bootstrap's own composition here. They are recorded and required so a change is a finding;
  they are not policy of Fusion's and not a promise about another build or a slower machine.
- **Which providers refresh is this fixture's own configuration.** The ten that asked are the ten `DUMMY_PROVIDER_KEYS`
  configures. What is not measured here is a provider this fixture configures no credential for, and a real user's own
  provider set is neither this one nor bounded by it.
- **The controls' reach is unchanged.** The fetch guard wraps `globalThis.fetch` in the processes it is preloaded into —
  the controller and the child — and nothing else: not a raw socket, not a native client, not a subprocess, and not the
  helper programs these cases invoke, which make no request and are not watched by it. It is not a sandbox. The fixture
  control case has no guard at all, because it starts no process that could make a request, and it claims nothing about
  requests.
- **Still no Fusion lifecycle.** No transport, bridge, host record, history file, dashboard entry, question, steer or
  cancellation is exercised, and the Pi backend is not registered.

## Verification

Run on 2026-09-28, one at a time, with no two runs overlapping and no other suite running beside them. Every run was
under `env -i` with an owned `HOME`, temporary, `XDG` and AppData tree and a copied `PATH` and those alone — no inherited
`NODE_OPTIONS`, `NODE_PATH`, provider key or `PI_*` variable reached any of them — from a working directory inside that
owned root. The harness's own spike root is created inside that `TMPDIR` and removed on exit except under `--keep`.

**The revision this section reports** is the one an independent source review's bounded corrections landed in: the ten
dummy provider keys read correctly instead of rationalised, each precedence case tied to the layout the production
helpers resolved, honest NOT RUN reporting with its own synthetic validation, the reserved-name refusal for the raw
pass-through, and the exact-spelling note on the unused helper allowance. Its root is
`/tmp/pi-fusion-step4-task5-p7e-72LbIJ`, with `{harness-syntax,caller-syntax,p7,impl,historical,whitespace}.log` in it.

- `node --check` on `test/spikes/pi-config-writes.mjs` and on `test/spikes/pi-storage-caller.mjs` — clean. The
  controller was **not** changed by this stage or by these corrections: `callSpec`'s existing `controlled.catalogBaseUrl`
  is what the catalog cases pass, and the caller's own fixture refusal for an online call that names no catalog is what
  they satisfy.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep` — **12 of 12**, 10 real children, 16 model
  requests, **0 NOT RUN**, with the group's counters `{bootstrapInvocations: 10, preSdkRefusals: 0, sdkLoaded: 10,
  serving: 10, rpcAnswered: 10, refusalsAfterSdk: 0, loopbackModelRequests: 16}` and its NOT RUN list empty. All eight
  reserved-name compositions refused, the helper log passed through as itself and is not a directory, the four synthetic
  results classified as held, NOT RUN, failed and held, and the two synthetic headlines came out
  `2/4 cases kept their guarantees, 1 NOT RUN and counted as neither: synthetic-not-run` and
  `2/2 cases kept their guarantees`. The hanging case's first probe answered 12029ms after its first arrival.
- `node test/spikes/pi-config-writes.mjs --stage impl` — **65 of 65**: the 25 implementation-stage cases, task 3's 26,
  task 4's 3 and this group's 11, all unchanged in their own expectations. 21 fixture model requests in the whole run
  (the 5 the run above this stage made, plus this group's 16), P5's counters unchanged at 24 bootstrap invocations and 3
  model requests with an empty skipped list, and P6's unchanged at 3 invocations, 3 SDK loads, 2 serving children, 1
  startup refusal and 1 model request.
- `node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests, unchanged.
- `git diff --check` and a trailing-whitespace scan of every changed file — clean.
- Not re-run for these corrections, and named rather than implied: the selector checks below, which return before the
  headline this round changed and whose code path these corrections do not touch; and the auth harness, which nothing
  here reaches.
- The default suite was **not** run for this stage or for these corrections, and is not claimed by either: these files
  are manual-harness-only, the default glob does not reach them, and no production file, test file or suite fixture was
  touched. The host's own verification of the composition half, recorded earlier in this file, stays the suite
  measurement it was.

### How this stage's runs went, in order

Kept as they happened, because a harness bug found and fixed is not a first-attempt pass:

- **First run — 10 of 12**, root `/tmp/pi-fusion-step4-task5a-p7-gE1EHZ`. Both `PATH`-resolving precedence cases failed
  on an expectation of this harness's own: they required `$0` to be the bare name the lookup answered with, and a
  shebang program is started with the path the kernel resolved, so `$0` is absolute either way. That was a wrong
  expectation rather than anything the production code did; the assertion is now the stronger one — `$0` names the
  winner's own program in all three cases — and the version probe is what tells the two lookups apart.
- **Three green runs of polish revisions**, roots `/tmp/pi-fusion-step4-task5a-p7b-BlQIqz`,
  `/tmp/pi-fusion-step4-task5a-p7c-RVWmxm` and `/tmp/pi-fusion-step4-task5a-p7d-8A8NEK`: the corrected expectation, then
  the case table reordered to the order the group runs in, then a stale comment, an unused accessor and a redundant
  fallback removed. Each came out **12 of 12**, **65 of 65**, **11 of 11** with the same counters, with the hanging
  case's first probe answering 12036ms, 12032ms and 12036ms after its first arrival; the `p7b` and `p7d` roots also hold
  the four selector checks — `--case nope`, `--stage bogus`, `--stage historical --case P7` and `--case P7x` each exit 2,
  so a mistyped or out-of-stage selector still cannot pass for a clean run, while `--stage impl --case P7` now selects
  this group where the task 4 section above records it exiting 2. That line was a measurement of a revision in which no
  such group existed and it stays what it was.
- **The host's own independent reproduction of the `p7d` revision**, before the review corrections above and recorded as
  that revision rather than as verification of them: root `/tmp/pi-fusion-step4-task5-p7a-host-ub6HwI` with
  `{harness-syntax,caller-syntax,p7,impl,historical,whitespace}.log`, under the same `env -i` owned-tree discipline and
  with its manual working directory inside that root. **12 of 12**, 10 children, 16 model requests, 0 skips, the first
  probe 12022ms after the first hanging request; `--stage impl` **65 of 65** with 21 requests; `--stage historical`
  **11 of 11** with 8; whitespace clean.
- **This revision**, measured above.
- **The host's own final verification of this revision**, the corrected `p7e` one, from its own owned root
  `/tmp/pi-fusion-step4-task5-p7a-final-host-YnB35H` with `{harness-syntax,p7,impl,historical,whitespace}.log` in it,
  under `env -i` with an owned `HOME`, temporary, `XDG` and AppData tree, a copied `PATH` and a manual working directory
  inside that root: `node --check` clean on the harness, `--stage impl --case P7 --keep` **12 of 12** — the 11 cases and
  the builtin probe — with **10** children that loaded the SDK, reached `serving` and answered RPC, **16** loopback model
  requests, **0 NOT RUN**, and the hanging case's first probe answering **12043ms** after its first arrival;
  `--stage impl` **65 of 65** with 21 requests; `--stage historical` **11 of 11** with 8; whitespace clean. This is the
  measurement the host confirmed the first half of the group on, and it is what the download half below was built on top
  of.

In the kept root every case's call spec, controller observation file, guarded-fetch log, helper log and generated
fixture is readable, and `report.json` holds all 12 results. Inside it every case's calls directory is empty, the
seeded helper programs are byte- and mode-identical to what the generator wrote, and the only directories named `bin`
anywhere under it are the three the precedence cases seeded themselves.

# Task 5 download stage: a real child downloading a helper, through an interposed release endpoint

This is the sixth report in this file and it replaces none of the five above. The section before it measured the first
half of the `P7` group — helper precedence and the catalog matrix — and said in as many words what it did not measure: a
helper **download**, a fallback served from a fixture, an interposer of any kind, and two children falling back at once
into one shared bin. This section is the first three of those four. The concurrency case is **still not started**, task
5 is **still not complete**, and Pi stays unregistered and refused.

It is the same group in the same harness, run by the same controller through the same production helpers.
`node test/spikes/pi-config-writes.mjs --stage impl` is now the superset of five implementation reports: the 25 cases of
the implementation stage, the 26 of task 3, the 3 of task 4 and this group's **18**, **72** in all. The 54 above and the
group's first 11 are unchanged — the same selectors, the same guarantees, the same counters and the same request-count
expectations — and they were re-measured as part of the verification below.

What the six new children measure, and what does the measuring:

- **Pi's own download path, unchanged.** `grep` and `find` call the SDK's `ensureTool`, which — when neither a program
  in the child agent directory's `bin` nor one on `PATH` answers — resolves `https://github.com/<repo>/releases/latest`
  with `redirect: "manual"`, reads the tag out of the `location` header, downloads one asset on the same origin, unpacks
  it with the platform's `tar`, renames the program into that `bin` and `chmod`s it to 0755. **Nothing in this harness
  imports `ensureTool`, stubs it, patches the SDK, adds a provider client, writes a downloader of its own or overrides
  anything in production.** The one thing the fixture changes is where two exact urls per helper go.
- **A narrow helper-fetch interposer**, `test/spikes/pi-helper-interposer.mjs`: a second `--import` preload loaded
  **after** `pi-fetch-guard.mjs` and never instead of it. It captures the already guarded `fetch`, rewrites an **exact
  list of urls** — the two `releases/latest` pages and the two asset urls, byte for byte, built for this platform's own
  musl asset names — to the same pathname at one loopback origin the harness owns, and passes everything else through
  unchanged. Its three environment values are `PI_SPIKE_HELPER_ORIGIN`, `PI_SPIKE_HELPER_URLS` and
  `PI_SPIKE_INTERPOSER_LOG`, all of them fixture-only and all three now refused as raw pass-through names by `implEnv`
  beside the guard's own. **The existing guard is unchanged**, in behavior and in bytes.
- **Two fixture release archives, built here.** For each helper, one `#!/bin/sh` program of the same generated kind the
  precedence cases use, carrying the token `downloaded`, staged at **0600** and then archived with the machine's own
  `tar` and `gzip` reached through this group's owned utility directory. Each archive holds exactly one member, at the
  path the SDK looks for first: `<asset-without-.tar.gz>/<tool>`. The archive is extracted once by the harness before any
  child runs, and the member comes back out at 0600 — which is what makes a 0755 program in a child's bin afterwards the
  SDK's own `chmod` rather than something `tar` did.
- **A loopback release listener** that answers exactly those four paths — a 302 with a **relative** `location` naming
  `/…/releases/tag/<fixture tag>` for a `releases/latest`, and one archive for an asset — and 404s anything else,
  recorded. The fixture version is `99.0.0-spike`, which exists nowhere but here.
- **The exact allowlist is built for the platform, with no live lookup.** The repositories, the tag prefixes and the
  asset-name templates are read from the installed `tools-manager.js` and written out here for linux x64 and linux
  arm64; there is no request to a real release endpoint anywhere in this harness, and every attempt at one is refused by
  the guard before it is sent.

## Reproducing

```bash
node test/spikes/pi-config-writes.mjs --stage impl --case P7         # the whole group, 18 cases plus the builtin probe
node test/spikes/pi-config-writes.mjs --stage impl                   # the 54 cases above and this group's 18
node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep  # the same, temp root kept
```

## What was measured

Run on 2026-09-28 on Linux (`Linux 7.0.0-34-generic x86_64`), node v24.18.0, against the repository's Pi **0.85.1**,
through the production bootstrap and never the stock CLI. **These measurements are Linux-only.** The group still
declares itself qualified on linux x64 and linux arm64 alone and reports all **18** cases NOT RUN, by name and with the
reason, on any other platform or without `tar` and `gzip` on the machine's own path. On the machine above there were
**0 skips**.

`node test/spikes/pi-config-writes.mjs --stage impl --case P7` — **19 of 19 cases kept their guarantees** (the 18 P7
cases and the builtin-catalog probe the stage always runs first), with **16** real children, **29** loopback model
requests, and no request to any origin this fixture does not own.

| Case | What it does | Outcome |
| --- | --- | --- |
| `P7-helper-interposer-control` | no child: two probe runs and the preload's own configuration checks | with the interposer, both `releases/latest` urls reach this fixture's listener and answer **302** with exactly `/BurntSushi/ripgrep/releases/tag/99.0.0-spike` and `/sharkdp/fd/releases/tag/v99.0.0-spike`, while an unrelated `github.com` release page and an unlisted rg asset are refused by the guard with **0** contact at the listener; the guard's log holds the two loopback requests and the interposer's the two original urls; both archives hold exactly one member and extract at 0600 byte-identically; with the preload omitted and the guard kept, the same rg url is refused, nothing is installed and nothing is mapped; all **8** malformed configurations exit non-zero without installing |
| `P7-helper-rg-download-fallback` | `PI_OFFLINE` absent, no `rg`, `fd` or `fdfind` anywhere | 2 release requests (the page, then the asset), one invocation and **no** version probe, the grep result exactly `downloaded-match.txt:1: downloaded`, `children/bin/rg` byte-identical to the archived program at mode **755**, the bin holding exactly `rg`, and the managed diff creating exactly `children/bin` and `children/bin/rg` |
| `P7-helper-fd-download-fallback` | the same profile and the same stable bin, `fd` and `fdfind` both absent | fd's own 2 release requests, the find result exactly `downloaded-find.txt`, the bin holding exactly `fd` and `rg`, the rg from the case before byte- and mode-identical, and the managed diff creating exactly `children/bin/fd` |
| `P7-helper-download-reuse` | a third child on that bin with `PI_OFFLINE=1` | **0** release requests and **0** mapped urls, both helpers invoked from `children/bin` with no version probe, both byte- and mode-identical afterwards, and the managed diff holding nothing but this child's own transcript |
| `P7-helper-offline-one-refuses` | `PI_OFFLINE=1`, fresh profile, nothing to find | the grep call comes back `isError` with exactly `ripgrep (rg) is not available and could not be downloaded`, the child answered an ordinary prompt afterwards and exited 0, and there is **no** helper log line, **no** release request and **no** `children/bin` at all |
| `P7-helper-offline-zero-downloads` | `PI_OFFLINE=0`, fresh profile | the child observed the string `"0"`, downloaded rg through the two mapped urls and answered the grep call with it |
| `P7-helper-offline-empty-downloads` | `PI_OFFLINE=""`, fresh profile | the child observed the empty string, downloaded rg the same way and answered the same |

## Findings

**A real Pi child with no helper anywhere downloads one, installs it in its own bin and uses it — and that whole path is
the SDK's.** In `P7-helper-rg-download-fallback` the child agent directory had no `bin`, the constructed search path
resolved none of `rg`, `fd` or `fdfind`, and the host agent directory's appended bin did not exist. The child asked for
`https://github.com/BurntSushi/ripgrep/releases/latest` with `redirect: "manual"`, read the tag `99.0.0-spike` out of the
relative `location` this fixture answered with, asked for
`…/releases/download/99.0.0-spike/ripgrep-99.0.0-spike-x86_64-unknown-linux-musl.tar.gz`, unpacked it with the owned
`tar`, and left `children/bin/rg` byte-identical to the program the archive carried, at mode **755** from the **0600** it
was archived at. Then it ran it: the `grep` tool result was exactly `downloaded-match.txt:1: downloaded`, with `isError`
false, and the helper's own log line names the program in that bin as its `$0`. The two accounts of the traffic agree —
the interposer's log holds the two original `github.com` urls, the guard's holds the two loopback requests that actually
went out — and the guard blocked nothing in the whole case.

**The install is exactly two paths, and it cleans up after itself.** The managed diff of that call created exactly
`children/bin` and `children/bin/rg`, named as two separate allowances in the shared postcondition, with the stray filter
otherwise untouched: `MANAGED_WRITEABLE` was not widened, and its self-check still catches `children/bin/rg` as a stray
where no case names it. The bin held exactly `rg` afterwards — the downloaded archive and the unique `extract_tmp_…`
directory the SDK makes beside it are both gone, removed by its own cleanup — and the user's own profile, the project and
the inherited session directory were all untouched.

**A second helper installs beside the first without disturbing it, and a third child reuses both with no request at
all.** `P7-helper-fd-download-fallback` ran on the same profile and the same stable bin, with nothing copied, re-seeded
or pre-warmed between the two children: it downloaded fd through fd's own two urls, created exactly `children/bin/fd`,
and left the rg beside it byte- and mode-identical. `P7-helper-download-reuse` then ran a third child on that bin with
`PI_OFFLINE=1`, invoked both tools, and made **no** release request and mapped **no** url: `ensureTool` returns a program
in the child bin before it probes anything, so neither helper was even asked for its version, and no retry hid an earlier
failure. Both files were unchanged afterwards.

**`PI_OFFLINE` is read as truth by the helper path, which is a different rule from the model runtime's.** The first half
of this group measured the runtime: any value of the variable, `0` and an empty string included, leaves a child with no
catalog refresh, because it asks whether the variable is **present**. The helper path parses it: `1`, `true` and `yes`
are true and everything else is false. Measured against three real children on three fresh profiles: with `PI_OFFLINE=1`
the child had no helper and no download, and its `grep` call came back as the tool's own error — exactly
`ripgrep (rg) is not available and could not be downloaded` — as a **tool result**, with the child answering an ordinary
prompt afterwards and exiting 0, rather than as a refused startup. With `PI_OFFLINE=0` and with `PI_OFFLINE=""` the same
child downloaded rg and the same grep call worked, each having observed the exact string it was given. What that settles
for Fusion: a user who sets `PI_OFFLINE=0` to mean "not offline" gets a child that downloads helpers and still refreshes
no catalog, and the two halves of that sentence come from two different readings of one variable in one build. **The
false-looking values are measured for `rg` alone.** `fd` goes through the same `isOfflineModeEnabled` in the same
function in the same source — that is a read of the source, not a second measurement, and this section claims it as one.

**The interposer is narrow, and that is measured rather than asserted.** Its own control case runs before the first
download child. With the preload in place, the two mapped release pages reached the fixture listener and nothing else
did: an unrelated `github.com` release page and an rg asset url no case listed were both refused by the guard before a
request went out, with the listener recording **0** contact for them. With the preload left out — and the guard kept, as
it always is — the same rg url was refused too, nothing was installed and nothing was mapped, which is what makes the
installation and mapping checks of every download case non-vacuous: they are the same checks in both runs. The preload
also refuses its own configuration rather than quietly installing nothing: an absent or non-loopback origin, an origin
carrying a path, an absent, malformed, whole-origin or repeated url list, and a missing log each made it throw before the
program it was loaded into ran, and the first seven recorded one refusal apiece.

## Counts

Kept apart from every other group's. The two control cases run no child and are in none of them:

| Count | P7, both halves |
| --- | --- |
| Bootstrap invocations (real child processes) | 16 (10 in the first half, 6 here) |
| Refused at the input stage, before the SDK was imported | 0 |
| Children that loaded the SDK and reported its version | 16 |
| Of those, reached `serving` and answered RPC | 16 |
| Loopback model requests | 29 (16 in the first half; here 2 + 2 + 3 + 2 + 2 + 2 = 13) |
| Requests at the fixture release listener | 10 (2 in the control, then 2, 2, 0, 0, 2, 2) |
| Urls mapped by the interposer | 10, all of them one of the 4 the map names; 0 in the two offline-true cases and 0 in the omission run |
| Requests blocked by the guard | 3, all of them in the control case: the 2 unmapped `github.com` urls of its first run, and the 1 mapped-list url its second run deliberately had nothing to map it |
| Generated helper programs | 18 (16 in the first half, plus the 2 staged into the release archives) |
| Cases skipped | 0 |

## Limitations

- **Linux only, one machine, one Pi**: node v24.18.0, Pi 0.85.1, `Linux 7.0.0-34-generic x86_64`. The asset names, the
  `tar` extraction and the 0755 install are that platform's; nothing here qualifies macOS or Windows, where the SDK uses
  a `.zip` and a different extraction path entirely, and nothing here qualifies another Pi build.
- **The downloaded program is not ripgrep and not fd.** It is the same generated `#!/bin/sh` fixture the precedence
  cases use, with its own token, so every claim here is about which program the child installed and started and about
  the bytes it moved — never about search semantics, a real binary's own behavior, or what a real release archive holds.
- **The interposer is not a proxy, a sandbox or a network boundary.** It rewrites an exact url list in the processes its
  preload reaches, and the guard is what still refuses an origin. A raw socket, a subprocess, another client or code that
  captured `fetch` before either preload ran is outside both of them. Both are manual-harness-only: the default test
  glob does not reach them, and nothing in the production bootstrap, launch options or storage layout knows they exist.
- **No real release endpoint is qualified.** What a child does against the actual `github.com` — its TLS, its redirect
  chain, its rate limits, its asset layout or a real archive's contents — is measured nowhere in this file, and a
  successful download here says nothing about one there.
- **No concurrency in this stage.** Two children falling back into one shared bin at the same time is measured in the
  section after this one, not here: nothing in the six cases above says what two simultaneous downloads into one
  `children/bin` do, and each of them had that directory to itself.
- **The catalog is beside the point in this half, and was not asked.** The two children that run with `PI_OFFLINE`
  absent name a loopback catalog base url, as every online call in this harness must, but no builtin provider has a
  credential in these cases, so the listener was never contacted: the fetch log of each records the model server and the
  release listener alone. The catalog matrix in the first half is where that behavior is measured.
- **Still no Fusion lifecycle.** No transport, bridge, host record, history file, dashboard entry, question, steer or
  cancellation is exercised, and the Pi backend is not registered.

## Verification

Run on 2026-09-28, one at a time, with no two runs overlapping and no other suite running beside them, each under
`env -i` with an owned `HOME`, temporary, `XDG` and AppData tree and a minimal `PATH` — node's own directory, `/usr/bin`
and `/bin`, and no inherited `NODE_OPTIONS`, `NODE_PATH`, provider key or `PI_*` variable — from a working directory
inside that owned root. Root: `/tmp/pi-fusion-step4-task5-p7b-aPoFFu`, with
`{harness-syntax,p7,impl,historical,whitespace}.log` and the kept spike root in it.

- `node --check` on `test/spikes/pi-config-writes.mjs`, `test/spikes/pi-helper-interposer.mjs` and
  `test/spikes/pi-storage-caller.mjs` — clean. `test/spikes/pi-fetch-guard.mjs` was **not** changed by this stage.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep` — **19 of 19** on the first attempt, 16 real
  children, 29 model requests, **0 NOT RUN**, with the group's counters `{bootstrapInvocations: 16, preSdkRefusals: 0,
  sdkLoaded: 16, serving: 16, rpcAnswered: 16, refusalsAfterSdk: 0, loopbackModelRequests: 29}` and its NOT RUN list
  empty. The hanging case's first probe answered 12028ms after its first arrival in this run.
- `node test/spikes/pi-config-writes.mjs --stage impl` — **72 of 72**: the 25 implementation-stage cases, task 3's 26,
  task 4's 3 and this group's 18. 34 fixture model requests in the whole run (the 5 above this group, plus its 29),
  P5's counters unchanged at 24 bootstrap invocations and 3 model requests with an empty skipped list, and P6's
  unchanged at 3 invocations, 3 SDK loads, 2 serving children, 1 startup refusal and 1 model request.
- `node test/spikes/pi-config-writes.mjs --stage historical` — **11 of 11**, 8 fixture model requests, unchanged.
- `git diff --check` and a trailing-whitespace scan of all three changed files — clean.
- The default suite was **not** run for this stage and is not claimed by it: these files are manual-harness-only, the
  default glob (`test/*.test.ts`) does not reach them, and no production file, test file or suite fixture was touched.
  The auth harness was not re-run either; nothing here reaches it.
- No selector check, polish re-run or repeat of a green run was made, and no run in this stage was retried.

In the kept root every case's call spec, controller observation file, guarded-fetch log, **interposer log**, helper log,
generated fixture and built archive is readable, and `report.json` holds all 19 results. Inside it every case's calls
directory is empty, the two release archives and their staged and verification extractions are intact, and the only
`bin` directories under it are the three the precedence cases seeded, the one the download sequence installed two
programs into, and the two the `PI_OFFLINE=0` and `PI_OFFLINE=""` children installed one into — with none at all in the
profile of the case that was offline.

### Independent host reproduction of the revision above

Run by the host on its own, from its own owned root `/tmp/pi-fusion-step4-task5-p7b-host-9qG1Io` with
`{harness-syntax,interposer-syntax,caller-syntax,p7,impl,historical,whitespace}.log` in it, under the same `env -i`
discipline — owned `HOME`, temporary, `XDG` and AppData tree, and a manual working directory inside that root. It is a
reproduction of **the revision measured above**, before the bounded hardening recorded below, and it is not a
verification of those later checks.

Everything passed: `node --check` clean on the harness, the interposer and the controller; `--stage impl --case P7`
**19 of 19** with **16** children that loaded the SDK, reached `serving` and answered RPC, **29** loopback model
requests and **0 NOT RUN**; `--stage impl` **72 of 72** with **34** requests; `--stage historical` **11 of 11** with 8;
whitespace clean. The host observed each download claim for itself: `children/bin/rg` at mode 755 from the 0600 it was
archived at with a matching SHA, fd installed beside it with the rg preserved, the reuse child making zero requests, and
`PI_OFFLINE=1` producing the tool's own error where `0` and an empty string both downloaded.

An independent source review of that revision then reported **Ready** with low hardening items, which the correction
below closes. That review ran a shell `true` contrary to its read-tool-only brief; its findings are still source reads
and not executable verification, no outside effect of this subtask was inspected, and nothing in it is counted as a run.

### Re-verified after the checker hardening

Three bounded corrections to this stage's own reader and one comment, none of them touching production, the fetch guard,
the release fixtures or any case's own guarantees:

- **An unreadable interposer log now fails before any branch, the omission control's included.** The check was after
  the `expectInstalled: false` early return, so the one case that claims "nothing was mapped" was the one case a missing
  log could have passed. It is now the first thing the reader asserts, so an omission has to be a log this harness
  created empty and can still read rather than a file that is not there.
- **The expected mapping is attributed to the process the claim is about.** A download case is a claim about the
  **child**; the controller is preloaded too, so a run whose child mapped nothing while its controller mapped everything
  would have satisfied a whole-log comparison. The exact expected url list is now required of `<caller>/child`, and the
  controller is required to have mapped nothing at all. A control with no child of its own is read under the caller's own
  identity, where there is only one process anything could be attributed to.
- **Both rules have negative controls of their own**, inside the existing interposer control case rather than as cases of
  their own, and kept separate from the eight startup refusals: the reader is handed a log that is not there — read the
  omission way, `expectInstalled: false` included — and a log in which both processes installed correctly but every
  mapped url is the controller's, and it has to report failures for each. Both logs are written by that case inside the
  disposable root; no log a real call produced is touched, and neither control starts a process, a backend or a request.
- The interposer's own comment now says what its rewrite covers: the two calls it exists for are bodiless GETs, and a
  mapped call arriving as a `Request` that could not be rebuilt without losing what it carried is **refused** rather than
  sent — a refusal, not a promise of lossless rewriting of an arbitrary streamed body. It also says why its log records
  `wraps` and its unusable events, since the reader requires both.

The group is still **18** cases and **16** children: the two new controls are checks inside the control case that already
existed, counted nowhere. Verified once, sequentially, from a new owned root under the same `env -i` discipline —
`/tmp/pi-fusion-step4-task5-p7c-YQvOpG` with `{harness-syntax,p7,impl,historical,whitespace}.log`:

- `node --check` on `test/spikes/pi-config-writes.mjs` and `test/spikes/pi-helper-interposer.mjs` — clean.
  `test/spikes/pi-storage-caller.mjs` and `test/spikes/pi-fetch-guard.mjs` were not changed by this correction.
- `--stage impl --case P7 --keep` — **19 of 19**, 16 children, 29 model requests, 0 NOT RUN, the same counters; the
  checker's missing-log control reported its failure with the log observed as `missing`, and the misattribution control
  reported its failures with the child's own mapped list empty.
- `--stage impl` — **72 of 72** with 34 requests, P5's and P6's counters unchanged.
- `--stage historical` — **11 of 11** with 8.
- `git diff --check` and a trailing-whitespace scan — clean.
- No default suite, typecheck, auth harness or browser run: this correction touches manual-only files that the default
  glob does not reach. No run was retried and no green run was repeated.

### Independent host verification of this stage, final

The host verified this stage on its own after the correction above, sequentially and from its own owned root under the
same `env -i` discipline — owned `HOME`, temporary, `XDG` and AppData tree, a copied `PATH` and a manual working
directory inside that root — at `/tmp/pi-fusion-step4-task5-p7b-final-host-j99ZmT` with
`{harness-syntax,interposer-syntax,p7,impl,historical,whitespace}.log` in it. It is **the host's own measurement of the
revision above**, not of the stage that follows:

- `node --check` on the harness and on the interposer — clean.
- `--stage impl --case P7` — **19 of 19** (18 cases and the builtin probe), **16** children that loaded the SDK, reached
  `serving` and answered RPC, **29** loopback model requests, **0 NOT RUN**.
- `--stage impl` — **72 of 72** with **34** requests. `--stage historical` — **11 of 11** with **8**.
- A trailing-whitespace scan — clean.

The earlier host root `/tmp/pi-fusion-step4-task5-p7b-host-9qG1Io` and the implementer's
`/tmp/pi-fusion-step4-task5-p7c-YQvOpG` stay the measurements they were; this is a third, of the corrected revision. The
default suite was not re-run for any of them and is not claimed by them: these are manual-only files the default glob
does not reach, and its own standing measurement is the **570 of 570** confirmation recorded in the plan.

# Task 5 concurrency stage: two children, one shared bin, and one first use each

This is the seventh report in this file and it replaces none of the six above. Every section before it left the same
sentence standing: what two children falling back **at once** into one shared `children/bin` do is not measured. This
section measures it, once per helper, and what it found is a **failure of the SDK's own first-use download under
concurrency** rather than a passing case. Task 5 is **not complete**, nothing here qualifies the helper path for two
children, and Pi stays unregistered and refused.

The risk was already written down as a source read: `downloadTool` in the installed `utils/tools-manager.js` gives each
process a **unique extraction directory** — `extract_tmp_<tool>_<pid>_<now>_<random>` — and still downloads to one
**fixed shared pathname**, `join(TOOLS_DIR, assetName)`, which it removes in its own `finally`. Two children of one
Fusion host share one `TOOLS_DIR`, so that name is shared between them. This stage turns that read into a measurement.

## What the two cases are

`P7-helper-concurrent-rg` and `P7-helper-concurrent-fd`, each with a profile, a project, a shared `children/bin` and a
pair of listeners of its own. Each pairs **two real children on one prepared stable location**: an `implement` child
(**A**) and an `ask` child (**B**), deliberately two different roles, because a shared bin is shared across roles too
and both roles run Pi's `grep` and `find` in this build. Each child has:

- its own loopback **release listener**, so every request is attributed by the listener it arrived at rather than by a
  header this harness would have had to invent, with the other child's origin **not** on its allow list;
- the same interposer and the same unchanged guard as every download case above, offering the same exact four urls;
- **identical archive bytes**, the ones this group builds once from the harmless 0600 helper fixture — nothing is copied
  into a child's or the host's bin, and no helper is seeded anywhere;
- `PI_OFFLINE="0"`, preserved exactly: false to the helper path, so a download is permitted, and present to the model
  runtime, so no catalog refresh is possible and neither case names a catalog listener at all;
- a **unique model-script sentinel**, with exactly one target tool call and one final text in it. There is no follow-up
  step and no second tool call anywhere, so nothing a child does after its first use can rescue that first use.

Both children are constructed and readied **one at a time** — nothing here measures two sessions or two credential
stores being built at once — and only then are both prompts sent. Every request either child makes for a helper is held
by its own listener until this case answers it, so the order two downloads reach one bin in is the case's own:

1. **Both release pages have to arrive before either is answered**, and both 302s are released together. That is what
   says both children looked a helper up, found none under any name, and asked — before either could have installed one.
2. **Both asset requests have to arrive before either is answered.** Both children are inside the same first use by
   then, and both have created the one shared bin, which the installer makes before it downloads.
3. An `fs.watch` observer is installed **on that bin alone**, with an immediate read as well as one per event, and only
   then is **B** sent valid `200` headers with the **full** `Content-Length` and a short nonzero **prefix** of the body.
   The shared archive is required to reach exactly that many bytes before anything else happens.
4. Only then is **A**'s complete body sent, and **A**'s own first `tool_execution_end` is waited for.
5. **B**'s remainder is released last, and **B**'s own first `tool_execution_end` is waited for.

All of it is ordinary HTTP response timing at listeners this harness owns: no lock, no patched SDK, no edit to a file
under a child, no simulated tool error, no poll sleep and no stress loop. Every bound has an unconditional release of
every held response behind it, so a missed handshake ends the case rather than leaving a child or a socket hanging, and
a bound this harness missed is reported as **that** rather than as a helper failure.

**The acceptance is both first uses succeeding.** One child succeeding while the other comes back with the tool's own
unavailable error **fails** the case, whatever the bin holds afterwards. The reuse subphase — a third, fresh, offline
child proving byte-identical reuse with zero release requests — runs only if both did succeed; it ran in neither case
and is reported as NOT RUN rather than left looking like a pass.

## Findings

**Both cases failed, and they failed the same way: the second child's first use of the helper came back as the tool's
own unavailable error while the first child's succeeded.** The intended interleaving was reached in both, so this is a
measured outcome and not a missed harness bound.

| Case | A (`implement`) | B (`ask`) |
| --- | --- | --- |
| `P7-helper-concurrent-rg` | `grep` answered exactly `downloaded-match.txt:1: downloaded`, `isError` false | `grep` answered exactly `ripgrep (rg) is not available and could not be downloaded`, `isError` **true** |
| `P7-helper-concurrent-fd` | `find` answered exactly `downloaded-find.txt`, `isError` false | `find` answered exactly `fd is not available and could not be downloaded`, `isError` **true** |

**What the shared pathname did, observed at this case's own handshakes.** In `P7-helper-concurrent-rg` the archive is
605 bytes and the held prefix 201. The bin existed and was **empty** when both asset requests had arrived; the archive
did not exist at all before the first byte; it reached exactly **201** bytes on B's prefix; and at A's first
`tool_execution_end` it was **gone**, with the bin holding exactly `rg`. The observer's own event list — best-effort,
and never what a claim rests on, since events can coalesce — recorded one inode going `0 → 201 → 0 → 605 → unlinked`
under one name, a sequence the interleaving makes B creating it and writing its prefix and A truncating it, writing the
whole body and removing it, and which these readings on their own do not attribute to either child: nothing in them
names a writer. Both children's `extract_tmp_rg_<pid>_…` directories appear in that list, and the two pids in them are
exactly the two child pids the controllers recorded (`1491375` and `1491413`). `P7-helper-concurrent-fd` is the same
shape: 548 bytes, a 182-byte prefix, one inode `0 → 182 → 0 → 548 → unlinked`, and `extract_tmp_fd_1491439` and
`extract_tmp_fd_1491458` beside its own recorded pids.

**What B's own evidence shows, and what it does not attribute.** B's own release listener saw exactly its helper's
release page and its asset and nothing else; its interposer mapped exactly those two urls **from the child**; the guard
blocked nothing; and its child exited **0**, having made its 2 model requests and returned the scripted final text. Its
helper log is **empty**: the program in the bin was never started by it. What follows from that is that B reached the
download and came back with the tool's own unavailable message, with the one shared pathname interfered with in between
— the interference is observed, and it is the finding.

**Which SDK operation failed is not directly observed, and this stage does not claim one.** Extraction from a pathname
another child had already removed is the candidate the installed source supports, and it is a candidate: a stream or
pipeline failure, an extraction, a lookup of the extracted binary and a publication into the bin can all collapse into
the same generic "could not be downloaded" text, because `grep` and `find` call `ensureTool` with no `onStatus` callback,
so whatever reason it had surfaces nowhere a tool result could carry it. Nothing here instruments the SDK, reads an open
descriptor or traces a syscall. The helper's own state is claimed only where it was read: at A's first
`tool_execution_end` the archive was gone and the bin held exactly `rg`, and at the end of the case the program was there
byte-identical at 0755 — the bin was not observed continuously between those two points, and no claim is made about what
it held throughout B's failure. The inode transitions above are this harness's own per-process readings of one pathname
at the moments it read them; they are evidence that the name was interfered with and not an attribution of which child
performed which operation on it.

**What did hold, in both cases.** The installed program is byte-identical to the archived one at mode **755** from the
0600 it was archived at; the bin holds exactly the one helper afterwards, with no archive and no extraction directory
left behind by either child; the only paths the managed diff created outside the catalog, the sessions and the calls
directory are exactly `children/bin` and `children/bin/<tool>`, each named as its own allowance, with
`MANAGED_WRITEABLE` untouched and no widening for either case; the user's profile, the project and the inherited session
directory are unchanged; one caller's disposal left the other's call directory alone, and the calls directory was empty
once both had exited; and every model request in each case's window carried one of the two sentinels.

## Counts

| Count | This stage |
| --- | --- |
| Selected results of `--stage impl --case P7` | **21** — the group's 20 cases and the builtin probe |
| Cases that kept their guarantees | **19**; the two concurrent cases **failed**, with 4 failures apiece |
| Cases NOT RUN | 0 |
| Bootstrap invocations in the group | 20 — the 16 above, plus 2 per concurrent case |
| Children that loaded the SDK and reached `serving` | 20 |
| Children that answered RPC | **20 in fact**. The group's own `rpcAnswered` counter says **18**, because a concurrent case passes its child's own first-use outcome as that flag and both held children's first uses failed; both of them answered every probe, accepted their prompt, settled and returned their scripted final text, which their own observations record. A task tool error is not a startup refusal and is not counted as one: `preSdkRefusals` and `refusalsAfterSdk` are both 0 |
| Loopback model requests in the group | 37 — the 29 above, plus 4 per concurrent case |
| Requests at the two per-case listeners | 2 per child: exactly one release page and one asset each, and no other path |
| Urls mapped by the interposer | 2 per child, both of them the child's own, and none by a controller |
| Requests blocked by the guard | 0 in both cases |
| Reuse subphases run | **0 of 2**, both NOT RUN because their case's acceptance was not met |

## Limitations

- **Linux only, one machine, one Pi, one interleaving.** node v24.18.0, Pi **0.85.1**, `Linux 7.0.0-34-generic x86_64`.
  What is measured is the one deterministic order these cases construct. Nothing here says what other schedulings do,
  what another platform's extraction path does — Windows uses a `.zip` and a different one entirely — or what another
  Pi build does, and no frequency, probability or "usually" is claimed for any of it.
- **It is not a diagnosis of the SDK's code by execution.** The operation named from the installed source is a candidate
  and not an observation: the same generic tool text covers a stream or pipeline failure, an extraction, a lookup of the
  extracted binary and a publication into the bin, and `grep` and `find` pass no `onStatus` callback, so no reason
  reaches a tool result. Nothing here instruments the SDK, reads an open descriptor or traces a syscall.
- **The recorded event list of this run carried no timestamps.** The observer read a time for every event, and the
  observations exported from that run did not include it, so the order in that list cannot be placed against the
  handshakes by time. The assertions this stage's own findings rest on are the state reads at the handshakes.
- **Waiting for a `tool_execution_end` answers with the first event of that type a child has already produced.** In this
  run nothing asserted that the held child had produced none before its remainder was released, so that wait could in
  principle have answered with an earlier one. Both children's recorded execution counts are 1, which is what rules that
  out here, and it is a read of the result rather than a bound the run enforced.
- **The downloaded program is still not ripgrep and not fd**, and no search semantics are measured anywhere.
- **The guard and the interposer are unchanged**, in behavior and in bytes, and are still not a proxy, a sandbox or a
  network boundary. No real release endpoint was contacted, and each child reached only the model server and its own
  listener.
- **Still no Fusion lifecycle.** No transport, bridge, host record, history file, dashboard entry, question, steer or
  cancellation is exercised, and the Pi backend is not registered.

## What this blocks

Two children of one host cannot be relied on to obtain a helper on their first use in this build: the loser of the race
is told its tool is unavailable, and the source has `ensureTool` looking the bin up once, before the download, with no
second look at the bin the winner has just filled. That is the acceptance this stage exists for and it is **not** met. No workaround, retry, preseed, lock or serialization
was added anywhere in this stage — the harness measures, and a repair is a decision for the plan rather than for a
manual fixture. Until that decision is made, task 5 stays incomplete and the concurrent-download path stays unqualified.

## Verification

One qualification run, by hand on 2026-09-28, with nothing else running beside it, under `env -i` with an owned `HOME`,
temporary, `XDG`, AppData and cache tree, a minimal `PATH` — node's own directory, `/usr/bin` and `/bin`, and no
inherited `NODE_OPTIONS`, `NODE_PATH`, provider key or `PI_*` variable — from a manual working directory inside that
owned root. Root: `/tmp/pi-fusion-step4-task5-p7c-impl-KiWr6M`, with `p7.log`, `fixture-self-check.log` and the kept
spike root in it.

- `node --check` on `test/spikes/pi-config-writes.mjs` and `test/spikes/pi-helper-interposer.mjs` — clean. The
  interposer, the fetch guard and the controller were **not changed** by this stage; the harness is the one file it
  touches.
- **The separate fixture self-check is not verification of anything, and the record of it is corrected here.** Before the
  qualification run a throwaway script outside the repository copied the gate, the paired listener and the bin observer
  and drove a miniature of `downloadTool`'s own steps. It **threw** at a probe-only `stat` that was not inside a `try`,
  so it did not complete; it likely left a watcher behind, and which live handle that was is **unknown**. It is not a
  successful check of the fixtures, it verifies nothing, and it is no part of the harness this stage measures with —
  `caseP7Concurrent` neither imports nor invokes it. The kept root and `fixture-self-check.log` stay named here as
  provenance of what was attempted, not as a result.
- **What was then done about that script, and what is not known about it.** The implementer ran
  `pkill -f fixture-self-check.mjs` from the repository working directory with the inherited environment, with no
  recorded pid, no `ChildProcess` handle, no ownership check and no known set of matching processes; the task recorded an
  exit of 144. Which processes that actually signalled, what process and listener state it left, and what it affected
  outside this stage are **unknown**, and the earlier claim that nothing was outstanding is **retracted**. A later
  compound command containing `pkill`, `sleep`, `cat` and `rm` was **denied and never performed**, so nothing is claimed
  to have been deleted by it and no inspection of effects established that anything was safe. `/tmp/p7c-work`, the
  script's scratch location, is a **non-unique path outside the owned run root**: it was used, it is not owned, and it is
  not to be inspected, removed or represented as safe. No further investigation of any of this is authorized.
- `node test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep` — **19 of 21**, with the two concurrent cases
  failing their acceptance and **0 NOT RUN**. Group counters:
  `{bootstrapInvocations: 20, preSdkRefusals: 0, sdkLoaded: 20, serving: 20, rpcAnswered: 18, refusalsAfterSdk: 0,
  loopbackModelRequests: 37}`, read with the `rpcAnswered` note in the counts above.
- `git diff --check` and a trailing-whitespace scan of the one changed file — clean.
- **Nothing was re-run.** The single qualification run reached the intended interleaving and measured a first-use
  failure, so no second qualification, no `--stage impl` and no `--stage historical` run was made in this stage: a green
  run is not something to chase after a measured failure. The **72 of 72** and **11 of 11** whole-stage totals are the
  host's measurements of the **72-case revision before this one** and stay that. With this stage's two new cases the
  implementation selection is **74 cases**; no whole-stage run of that selection has been made, and no pass count for it
  is claimed or projected here. The default suite, the typecheck, the auth harness and the browser test were not run and
  are not claimed: this stage touches one manual-only file the default glob does not reach.

In the kept spike root both concurrent cases' call specs, controller observation files, guarded-fetch logs, interposer
logs, helper logs and `report.json` are readable, each case's calls directory is empty, and each shared bin holds
exactly its one downloaded helper.

## Source-only corrections after this stage's independent review

An independent source review of the stage above — source reads, with no run of the harness of its own — reported the
measurement itself as source-ready and the documentation around it as overstated, and it named the corrections below.
**They are corrections in the source and in this page**: no `node --check`, no test, no real SDK or Pi child, and no
qualification run was performed for them, so nothing here is a new measurement and no count above changes.

**What was executed in these rounds, against the instructions they were given.** Two tool-discipline deviations belong in
this record, and neither is verification of anything:

- The implementation round that made the corrections below was instructed to use Read, Grep, Glob, Edit and Write only,
  and it **did issue one shell command**, reading one region of the harness through a shell instead of a read tool:
  `sed -n '7110,7195p' /home/asen/projects/ai/pi-fusion/test/spikes/pi-config-writes.mjs | grep -n "result.check"`. Its
  reported output was **no matches**. The working directory and environment that command carried are **not recorded** here
  and are not reconstructed. That round is therefore **not** strictly read-tool-only, and the command is **not** isolated
  executable verification of the corrections or of anything else. No effect of it was investigated, so nothing is claimed
  about what it did or did not touch.
- A separate SDK source-reading round was instructed to use Read, Grep and Glob only, and it **issued `echo skip`** before
  using source-reading tools. No test and no SDK execution was reported in that round.

Both are deviations of their own rounds and are **separate** from the fixture self-check and the `pkill -f` incident
recorded under *Verification* above, whose record — including its retraction and its unknowns — stands unchanged.

What was corrected in `test/spikes/pi-config-writes.mjs`, all of it inside this half's own cases and none of it in
production, in a shared helper, in the fetch guard, in the interposer, in the storage caller or in any earlier `P7` case:

- **The interleaving is asserted rather than recorded and stepped over.** A local `sequence(ok, message)` throws, and
  every ordering in that block goes through it — the two accepted prompts and the existing shared-bin check included, so
  no `result.check` is left inside it. Two new orderings join them: the shared archive has to be absent or empty before
  any body is released, and exactly one tool execution from the completed child with none from the held one has to hold
  immediately before the held remainder goes out. The catch now tells a bound this harness set and did not reach apart
  from an ordering it asserted and did not get, records which of the two stopped it, and reads neither as a helper
  failure; `interleavingReached` still derives from that one flag alone, the unconditional release of every held response
  is unchanged, and **no deadline or timing constant was touched**. The watcher's exported events now carry each event's
  own offset from the prompts, taken from the time the observer already recorded — no poll and no sleep was added.
- **The RPC accounting no longer borrows a tool outcome.** Each concurrent call tracks the four operations `p5Run`'s own
  drive performs — the probes, the accepted prompt, the settlement and the last-text read — each flag set only once that
  operation resolved, and `answered()` is their conjunction. The pair and the reuse subphase are counted with that, so
  `rpcAnswered` now means what it means everywhere else: the drive completed, whatever its checks or its helper tool then
  reported. **The measured counters above stay as measured**: the raw `rpcAnswered: 18` and the 19-of-21 result are that
  run's artifacts and are not relabelled, the 20 RPC-answering children stay the evidence-based reading of them, and this
  correction of the derivation has **not** been run, so it produced no new figure. `p5Run`, `p7ConcurrentCount`, `P5` and
  `P6` were not touched.
- **Cleanup happens on every path out of a case.** A caller's `close()` is memoized, the case keeps the callers it
  created — the reuse child included — and one outer `try`/`catch`/`finally` wraps the body from the pair's first
  snapshot through the reuse subphase. An unexpected error is recorded against the phase it stopped in instead of being
  thrown out of the case, so the result already reached is not lost, and the `finally` releases both listeners' held
  responses, closes the observer, closes every created caller independently and then both listeners independently,
  recording each cleanup rejection. The ordered A-then-B closes stay where they were on the normal path. No new timeout
  policy, retry, process search, signal or cleanup framework went in: every close is the bounded one those helpers
  already had.
- **The reuse subphase is read like the pair.** It takes its own settled snapshot before its start and after its close,
  records a diff phase of its own, goes through `checkManagedCall` with no helper allowance at all — the bin and the
  program in it predate that snapshot — and through `p7ConcurrentEnvironment` with `PI_OFFLINE="1"`; it now also reads
  its last assistant text and requires the scripted answer in it, and the shared calls directory has to be empty once it
  has exited. A failed first use is still followed by no third child.
- **The comments say what is observed and what is a candidate.** The header of this half and the inline comment at the
  unlink point now state that interference at the shared pathname is observed while the failing SDK operation is not, and
  the observer's own comment says its size and inode readings are this process's own at the moments it read them rather
  than an attribution of which child did what.

The route agreed with the user after that review: **these source corrections, and an ownership or publication fix carried
upstream to the SDK**, rather than serialization, retrying, preseeding or any other coordination on Fusion's side. The
acceptance stays strict — **both** first invocations succeed — the Pi backend stays disabled, and task 5 stays blocked
until a build carrying that fix is actually qualified against these cases. No SDK change is part of this correction.
**That route was afterwards declined; the section below is what replaced it, and it is the current policy.**

## After those corrections: the approved route changed to a bounded Fusion-side retry

Everything above stays as measured and as recorded. This section is later than all of it and is where the current policy
lives: the upstream route the previous section names was **rejected by the user**, who would not have Pi's source
modified for this, and who explicitly accepted a small **Fusion-only retry** for this cold-cache edge case and then
approved its implementation. No SDK patch, dependency change, lock, warmup, preseed, sleep or new setting is being
added anywhere, and the SDK checkout is **left unmodified**: the earlier authorized clone was **read for its source
only**, as the provenance list below records, and nothing was edited, built or installed from it. The proposal for the
declined route is kept as history in [docs/pi-helper-download-upstream.md](pi-helper-download-upstream.md).

### What is implemented

- `extensions/backends/pi-helper-retry.mjs` and `extensions/backends/pi-helper-retry.d.mts` wrap the **public builtin
  `grep` and `find` definitions only**. One model-issued tool call therefore makes **at most two underlying builtin
  attempts**.
- The retry happens **once, immediately**, and only for an `Error` whose message is the relevant **exact native
  helper-unavailable sentence** — the same two sentences the concurrency cases above measured. An unknown or reworded
  message, a non-`Error` thrown value and any unrelated failure pass through unchanged. This is **text-only
  compatibility**, not a root-cause classifier: those builtins take no status callback and collapse every acquisition
  failure into one sentence, so a build that reworded it would turn the retry off rather than make it misfire.
- One **fixed, credential-free tool update** announces the retry, carrying nothing from the caught error. Cancellation
  is checked **before** that notice and **again** before the second attempt, and a notice callback that throws
  propagates unchanged and prevents the retry. Nothing replays a task, a prompt or a session.
- A second attempt **re-enters the full native helper-acquisition path**; the SDK's own fetch retries are unchanged
  inside each attempt. It may cheaply reuse an install another attempt had completed, and it may equally download
  again, contend with an attempt that has not finished, or fail for offline, network, permission or any other
  persistent reason. It is **bounded best effort**, not a repair of the race and not a guarantee.
- `extensions/backends/pi-bootstrap.mjs` builds those definitions through the public `createGrepToolDefinition` and
  `createFindToolDefinition` and passes them as `customTools` under **unchanged names and schemas**, behind the fixed
  safe SDK-compatibility refusals it already uses for foreign accessors. The metadata fields on a wrapper are copied
  from the factory's own definition; **no claim is made that the SDK's registry-origin label for such a tool is
  unchanged**.
- The automatic retry applies **only when a call's `extensions` list is empty**. Any named extension resource opts that
  call out entirely, which preserves an arbitrary override including one registered late, since a refresh applies an
  extension's registrations first and the custom tools last. This is **not** a claim that every possible call is
  covered: this build's role presets name no resources, and an internal explicit resource addition stays supported and
  simply gets no wrapper.

### Status, and what the next gate is

**Read every "not run" and "unqualified" statement in this subsection as the state at the time it was written, before the
first host verification.** That verification has since happened and is the *First host verification of the bounded
retry* section at the end of this page; the gate descriptions here stand as what it was run against, and nothing in this
subsection is itself a measurement.

- The module, the bootstrap integration and their fake tests have passed **independent source review**. At the time of
  writing they had **not** been run, typechecked, syntax-checked or qualified against real children in this revision.
  Nothing in this section is a measurement.
- **The two `P7` concurrent cases are now adapted to that policy in source, and that is all.** At the time of writing
  they had **not** been run, **not** syntax-checked and **not** qualified against real children in this revision, and no
  count above or below changes because of them. A source review of that adaptation confirmed the gate, the one scripted call and two model
  requests, all three `extensions: []` reads, the reuse gating, the repeat-release controls, the cleanup and the earlier
  corrections, and it named three bounded items: the event reader was reading speculative alternate field names, which is
  settled by source instead — the installed public `AgentEvent` union declares `toolCallId`, `toolName`, `args` and
  `partialResult` for a `tool_execution_update` and `toolCallId`, `toolName`, `result` and `isError` for a
  `tool_execution_end`, `AgentSessionEvent` extends it, RPC mode streams those events as they occur, the session emits
  those names and an `RpcChild` stores each parsed message verbatim — so the reader now reads
  `partialResult.content` and `toolCallId` alone and **fails a named check** on any update that is not that shape, for
  every child and including the ones expected to carry no notice; plus two wording corrections. **All three are applied and
  have been independently source-re-reviewed**, narrowly and through read-only tools, and reported **source-ready with no
  residual issues**. That re-review covered the named adaptation and those three corrections alone — it is neither a global
  diff audit nor a full audit of this harness — and it made no runtime claim: these cases are still **unrun**, still **not**
  syntax- or type-checked and still **unqualified** against real children, and nothing here says any case ran. The gate they now carry is **one model-issued tool call per child, both succeeding** — the fast child A
  with **no** retry notice, the held child B with **exactly one** — with the wrapper's source and its fake tests bounding
  a call to at most two underlying builtin attempts, and per-child model traffic and tool events ruling out a second
  model-scripted rescue call. The original interleaving, its deadlines, its response bytes, its no-arrival bounds, its
  release controls, its guard coverage and its shared-archive observation stay exactly as they were; no case was added,
  renamed or removed, and the stage's selection is unchanged.
- What a run of them will have to produce, per child, as the adapted source now requires it: the fixed
  `HELPER_RETRY_NOTICE` imported from the production module and looked for **byte for byte** in the documented
  `partialResult.content` of each child's own native `tool_execution_update` events, with every update recorded — its
  tool, its correlation id, its text blocks, its own keys and its shape against those declared fields — rather than
  reduced to a boolean, and a shape that is not the declared one failing a named check instead of reading as no notice;
  **zero** such notices for A and **exactly one** for B, each attributed to that
  case's helper tool and to the one scripted tool-call id and positioned before that call's own final
  `tool_execution_end`; exactly **two** model requests per child answering exactly one helper call and one final text, so
  an `exhausted` third request or a second tool call fails the case; one non-error tool execution per child with the
  downloaded program's exact result text; no repeat release request at either listener, since the recovery this gate
  accepts is the one that finds the helper the other child published, and a second download attempt is answered `409` by
  the unchanged listener and recorded as a repeat; the helper path, invocation provenance, installed bytes and 0755 mode,
  managed-write and shared-storage checks unchanged; and `observations.input.extensions` **exactly `[]`** for A, B and
  the conditional reuse child, read from the input the controller recorded rather than from any override — this build's
  roles name no resources, and no fixture patch was added to make that true. The third fresh offline reuse child stays
  gated on the pair and stays reported as NOT RUN when the pair does not meet its gate; when it runs it must answer with
  the installed helper, carry **no** notice and make **no** download request.
- What such a run would and would not establish. One notice in B's stream says the production wrapper reached its
  matching-acquisition-failure branch before it recovered, so **B's first underlying attempt failed** — that failure stays
  visible and is never relabelled as a first-attempt success. It is **not** an observation of the failing syscall, the
  operation or the root cause, and the native stream does not count both attempts independently: one tool call ends one
  tool execution either way, and the at-most-two bound is the wrapper's own source and its fake tests. B's required notice
  is also the case's own positive delivery control for A's zero — both children run the same build, the same tool and the
  same composition in one case, so a run in which B carries its notice is what makes A's zero readable as "A needed no
  recovery" rather than "no notice would have been seen anyway". That is the control and no more: it establishes no
  general event-delivery property, and the declared-shape check is what keeps an unreadable update from standing in for an
  absent one. The pipeline itself still awaits runtime qualification; what is settled from source is the field names.
- The **19 of 21** result, the raw `rpcAnswered: 18` counter and the evidence-based reading of 20 answering children
  remain the **pre-policy** measurement, of a first-underlying-attempt gate that was **failed**. That gate is never
  relabelled as passed.
- The **72 of 72** implementation and **11 of 11** historical totals stay prior-revision evidence. The implementation
  selection was **74 cases** before this adaptation, and **no new pass count and no whole-stage count is claimed**. Pi
  remains disabled and unregistered, and task 5 remains incomplete until an authorized verification demonstrates the new
  policy.

### Provenance of the rounds that produced this

- **The first review of the retry module (run-64) issued a shell `true`** against a brief that named Read, Grep and
  Glob only, and it later **retracted** its own "ran nothing" statement. No test, no typecheck and no SDK probe was run
  in it; its findings are source reads, and that round is **not** described as strictly named-read-tools-only. Its
  follow-up rounds used Read and Grep only, and the implementation rounds for this retry used source tools only. This is
  a deviation of its own round and is **separate** from the `echo`, `sed` and `pkill -f` deviations recorded above,
  whose record stands unchanged.
- **A clone incident, recorded here because it was disclosed and belongs in this report.** The public repository was
  cloned at `/tmp/pi-fusion-sdk-upstream-YEpjS6/checkout`, commit
  `fd889a2741891ee45116cb6131052d7fad220886`, and it was **read for its source only**. The clone and the metadata `git` calls used an owned sanitized
  environment, but the setup step first wrote `echo "$ROOT" > /tmp/pi-fusion-sdk-upstream-root-pointer.txt`, **outside
  the owned root**, and then ran `rm -f /tmp/pi-fusion-sdk-upstream-root-pointer.txt; command -v git`. There was **no
  exclusive creation and no proof of prior absence or ownership** of that pointer path: the redirect could have
  truncated an existing file or followed a symlink. What that file previously held, what it may have pointed at and what
  else was affected are **unknown**; the `rm` status was not separately captured, and **no deletion or safety claim is
  established**. The initial claims that all artifacts were under the owned root and that the round held only its own
  path are **retracted**. No investigation of effects and no cleanup followed. The setup step's working directory and
  environment were **reported or inherited rather than independently measured**, and they are not the sanitized
  environment the `git` calls used. **This record authorizes nothing further about either path**: no access, no
  inspection, no investigation of effects and no cleanup of the pointer path or of the checkout is authorized by it, and
  neither is to be read, removed or represented as safe on the strength of anything written here.
- **Source reading of that exact checkout** found the same shapes this stage's findings describe: one shared archive
  pathname and a rename before the `chmod`. That checkout's package metadata says **0.87.1**, and **correspondence to a
  release tag was not verified**. It is **source evidence, not runtime qualification of 0.87.1**. No SDK source was
  edited and nothing was installed from it, and this reading **does not reopen the rejected SDK route**.

## First host verification of the bounded retry (2026-09-29)

This is the **first execution** of the bounded Fusion-side retry policy, of its fake tests and of the two adapted `P7`
concurrent cases. It is later than every section above and replaces none of them: the **pre-policy 19 of 21** result, its
raw `rpcAnswered: 18` counter with the evidence-based reading of 20 answering children, its two **NOT RUN** reuse
subphases, the earlier **72 of 72** implementation and **11 of 11** historical whole-stage totals, and every tooling
deviation and unknown effect recorded above all stand exactly as written. **That earlier gate — the first *underlying*
attempt succeeding for both children — was failed, and this run does not relabel it as passed.** What this run
demonstrates is the different, current gate: one model-issued tool call per child, both succeeding, the fast child with
no retry notice and the held child with exactly one.

### Before it: a preparation round's tooling deviation, separate from the run

One development round (**run-65**) preceded and is **separate from** the host execution recorded below. It **belongs to
this work's preparation history and to the overall development provenance**; what it is not is one of the sanitized host
check commands, and it provides **no executable verification** of anything.

- Its brief was **Read, Grep and Glob only, and no network**. It made **four `WebFetch` calls**, in this order:
  `https://nodejs.org/docs/latest-v24.x/api/cli.html#--test`, `https://nodejs.org/docs/latest-v24.x/api/test.html`,
  `https://nodejs.org/docs/latest-v24.x/api/os.html#ostmpdir` and `https://www.typescriptlang.org/tsconfig/#include`.
  All four returned page summaries; the first did **not** contain the requested `--test` section. According to the tool
  reports **no redirect target was reported or followed**. These urls are recorded as provenance and are **not to be
  fetched** on the strength of anything written here.
- It **sent its prompts and the fetched page content through `WebFetch`'s normal summarization process**. Its own
  clarification **corrected an earlier three-call account and retracted its compliance claim**: that round is **not**
  permitted-tools-only and **cannot be described as no-network**.
- It ran **no shell command, no test, no typecheck and no SDK probe**. A follow-up round made **zero tool calls** and
  supplied this provenance.
- **External effects were not investigated.** Nothing here says there were no tool caches or other effects, and nothing
  here makes the wider development round loopback-only.

### What the host ran, and from where

Three commands, **sequentially, with no failures and no rerun of any of them**. Fresh exclusively created root
`/tmp/pi-fusion-helper-retry-verify-cqbRpv` at `umask 077`, working directory `ROOT/work`, every log in `ROOT/logs`:
`setup.log`, `status.log`, `typecheck.log`, `suite.log`, `p7.log`, with `status.log` holding `typecheck=0`, `suite=0`,
`p7=0`.

- `/usr/bin/env -i` with the machine's `PATH` **copied**, `LANG` and `LC_ALL` **explicitly set to `C.UTF-8`** rather than
  copied, and owned `HOME`, `USERPROFILE`, `TMPDIR`, `TMP`, `TEMP`, `XDG` config, cache, data and state, `APPDATA` and
  `LOCALAPPDATA`, plus an owned empty git config file, template directory and hooks directory, so **no global or system
  git configuration was inherited**. Repository-local git configuration was **not** disabled, and no blanket "no git
  configuration" claim is made.
- Node directly: `/home/asen/.nvm/versions/node/v24.18.0/bin/node`.
- `/home/asen/projects/ai/pi-fusion/node_modules/typescript/bin/tsc -p
  /home/asen/projects/ai/pi-fusion/tsconfig.json`, the repository's own local compiler.
- `node --test` over the **shell-expanded absolute** `/home/asen/projects/ai/pi-fusion/test/*.test.ts` list, with **no**
  global concurrency change and **no** browser timing change.
- `/home/asen/projects/ai/pi-fusion/test/spikes/pi-config-writes.mjs --stage impl --case P7 --keep`.
- Every path above is absolute because the working directory was `ROOT/work` and **not** the repository: nothing in this
  run was invoked from the repository's own working directory.
- **Nothing was installed**, no source was edited during execution, and there was no standalone syntax or whitespace
  check, no browser confirmation, no further stage and **no second `P7` run**.

### Results

| What | Result |
| --- | --- |
| Typecheck | **Clean** — empty `typecheck.log`, exit 0 |
| Default suite | **596 of 596**, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`, `duration_ms 52809.6` (~52.8s). The browser test was **included and passed on the first attempt**, and this total includes the new retry and bootstrap fake tests |
| `--stage impl --case P7 --keep` | **21 of 21**, `NOT RUN: []`, counters `{bootstrapInvocations: 22, preSdkRefusals: 0, sdkLoaded: 22, serving: 22, rpcAnswered: 22, refusalsAfterSdk: 0, loopbackModelRequests: 41}` |

The `P7` figure is the **P7 selection plus the mandatory builtin control**, not the whole **74-case** implementation
selection. All 22 counted children were bootstrap invocations that loaded the SDK, reached `serving` and answered RPC;
the public-exports read and the builtin probe are **not** additional bootstrap children in those counters. Kept fixture
root: `/tmp/pi-fusion-helper-retry-verify-cqbRpv/tmp/pi-config-spike-rfzXh9`, with `report.json` in it. Platform: Linux
x64, node v24.18.0, repository SDK **0.85.1** — **no** Windows, macOS or alternate-SDK runtime claim.

### The decisive concurrency and reuse evidence

**Both cases reached the controlled interleaving** (`interleavingReached: true`), with the shared archive **absent**
before any body was released and the **exact held prefix** observed: `P7-helper-concurrent-rg` at **200 of 600** bytes,
`P7-helper-concurrent-fd` at **181 of 545**. Immediately before the held remainder went out, the asserted ordering held
in both — **A one final tool end, B zero**. The holds were **18ms** and **20ms**, with latest-release gaps of **10ms**
and **6ms**. These are that run's timings at this harness's own listeners; nothing here infers an **exact failing
syscall**, and the bin was **not** observed continuously — no stronger continuous state observation than the reads at the
handshakes is claimed.

Per pair, both children made **one** model-issued helper call, **two** model requests and **one** helper invocation, and
both returned the expected successful output (`downloaded-match.txt:1: downloaded` for `grep`, `downloaded-find.txt` for
`find`), `isError` false. **A carried 0 retry notices and B exactly 1**, matching the fixed production notice —
`The search helper was not available on the first attempt, so this tool call is being retried once.` — attributed to that
case's own helper tool and its one scripted tool-call id, in a valid `partialResult`/`toolCallId`/`toolName` shape, at
**update index 10 before the final end at index 11**, with **no invalid updates** and **no repeat release request** at
either listener. Every recorded `observations.input.extensions` was **exactly `[]`** — for A, for B and for the reuse
child.

What that does and does not establish: **B's first underlying attempt failed and its second succeeded**, so that failure
stays visible. The stream observes the **notice and the final result**, not both underlying attempts — one call ends one
tool execution either way — so the **at-most-two bound is now backed by the wrapper's source *and* by executed fake
tests** rather than by a count this stream can make. **Root-cause attribution remains bounded**: the notice says the
wrapper matched that exact sentence, not which operation failed.

What else held in both cases: the installed helper was **byte-identical to the fixture** at mode **0755**, the shared
archive was **absent** at the settled end, and each calls directory was **empty**. **Both conditional third-child reuse
phases ran and passed** — a fresh `PI_OFFLINE=1` child each, with **zero** retry notices, **zero** downloads, the helper
unchanged, and the managed-write and snapshot checks holding. The fixture guard and interposer recorded only
**harness-owned loopback origins**; the existing caveat is retained unchanged — that is **global-`fetch` coverage inside
the processes preloaded into**, and **not** a universal network or filesystem sandbox.

### Scope limits, and what task 5 still owes

**Read this subsection's outstanding-work list as of that round.** The full implementation selection and the historical
baseline it names as not rerun have since been run, in the round recorded in the section below; what that round did and
did not settle — and why it is **not** a clean-compliance qualification — is written there rather than here.

- This is the **first** run of these three commands and an **evidence review of it, by reading the logs only**. It is
  **not** a second execution, **not** a global audit and **not** task 5's closeout. **Independent execution
  reproduction** and the **remaining acceptance work** are still owed.
- **Not rerun here:** the full **74-case** implementation selection, `--stage historical`, and the auth harness. **No**
  standalone syntax or whitespace check was run.
- The earlier **72 of 72** and **11 of 11** whole-stage totals stay prior-revision evidence; **no new whole-stage pass
  count is claimed**, and the implementation selection is still **74 cases**.
- **Task 5 is not complete.** Pi stays **disabled and unregistered** in production, and nothing from this run was staged
  or committed.

## Full-stage and historical round, and its provenance failure (run-67)

Chronologically after the round above. The user authorized **one full implementation harness run followed by one
historical baseline**; the implement delegate (**run-67**) performed both, **sequentially and once each**, and **both
passed**. The **two harness processes themselves** were launched sanitized. **The round around them was not**: its setup,
its log handling and several checks it was never asked to make ran in the **inherited session shell**. So this round is
**not** to be called fully isolated or compliant, and **task 5 is not closed on it**. **No rerun, no investigation and no
cleanup is authorized**, and **task 6 has not started**.

### What was run, and what it reported

Fresh root `/tmp/pi-fusion-task5-full-verify-zyyvkz`, with `logs/stage1-impl.{out,err,exit}`,
`logs/stage2-historical.{out,exit}` and `logs/metadata.txt` in it. The two kept harness roots are recorded and were
**not opened**: `ROOT/tmp/pi-config-spike-oP8RA0` (implementation) and `ROOT/tmp/pi-config-spike-kj6Rgp` (historical).

The harness processes ran under `/usr/bin/env -i` with owned `HOME`, `TMP`, `XDG` and AppData directories, an owned git
global config, template and hooks, direct node **v24.18.0** and a working directory of `ROOT/work`. The root was reported
as an exclusive `mktemp` creation with `chmod 700` run on it. **No `umask` is claimed for this round**: the previous
round's `umask 077` is **not** retrofitted onto it, and the round's own inherited environment and umask were not
recorded.

| Stage | Result |
| --- | --- |
| `--stage impl` | **74 of 74**, `stage1_exit=0`, **0** actual NOT RUN or failure verdicts, **46** fixture model requests |
| `--stage historical` | **11 of 11**, `stage2_exit=0`, **0** actual NOT RUN or failure verdicts, **8** model requests |

Where those figures are read from: `stage1-impl.out` lines 1659 and 1661 (`fixture model requests: 46`, `74/74 cases kept
their guarantees`), `stage2-historical.out` lines 263 and 265 (`8`, `11/11 cases kept their guarantees`), and the two
`.exit` files.

Group slices from that one implementation stage, **not** additional stage totals:

- **P7**, read from `stage1-impl.err`: `{bootstrapInvocations: 22, preSdkRefusals: 0, sdkLoaded: 22, serving: 22,
  rpcAnswered: 22, refusalsAfterSdk: 0, loopbackModelRequests: 41}`, `NOT RUN: []` — no startup refusal of either kind.
- **P6**, from the same stderr: `{bootstrapInvocations: 3, preSdkRefusals: 0, sdkLoaded: 3, serving: 2, rpcAnswered: 2,
  refusalsAfterSdk: 1, loopbackModelRequests: 1}`.
- **P5**, **as the round reported it** rather than as a counter re-read from these logs: 24 bootstrap invocations, 9
  pre-SDK refusals, 15 loaded, 6 serving and answering, 9 post-SDK refusals, 3 model requests, and no skipped or failed
  case.

The synthetic `NOT RUN` text inside the `P7` fixture-control case's own reporting observations is that case's control over
the harness's reporting rules and **is not** an actual skipped verdict.

### The P7 recovery, executed a second time

The bounded retry was **functionally reproduced for both `rg` and `fd`**: the interleaving was reached; **A one final
tool end and B zero** immediately before the held remainder; **A no notice and B exactly one** valid, correctly
attributed notice at **update index 10 before the final end at 11**; **one** model-issued call and **two** model requests
per child; the correct non-error output; and **no invalid updates**. **Both third-child offline reuse phases reported
`run: true`**, with zero notices, zero downloads, `input.extensions` `[]` and unchanged helpers.

What the parent independently read: the two exit files, the two stage footers, the stderr counters and the A/B notice and
result records. **No new independent review of the whole round has happened.** This is a **second actual `P7`
execution** rather than another source review, and it is **not** a clean-compliance qualification round. The
**at-most-two-attempts bound is still the wrapper's own source plus the previously executed fake tests**, not an RPC
attempt count; the platform limit is **Linux, Pi 0.85.1** alone; and the guard's coverage stays **global `fetch` in the
processes preloaded into**, not a network or filesystem sandbox.

### Provenance deviations and retractions

All of this is from **run-67's own tool context**, as reported and retracted by it. **Nothing here was investigated, and
no investigation is authorized.**

1. **The sanitized scope covered the harness processes and not the round.** Root creation, the owned directory and config
   creation, `metadata.txt` and every log extraction ran in the **inherited session shell**, not under `env -i`. The
   working directory was **inferred** from the session's repository working directory except where it explicitly `cd`-ed,
   and was **not printed per call**. The full inherited environment and the umask were **not recorded**.
2. **Unapproved extra availability, version and git checks.** `command -v tar gzip git sh ps node`; `command -v rg fd
   fdfind`; `type -a rg`; `ls -l` on the real Node executable; `node --version`; `git rev-parse HEAD` and
   `--abbrev-ref HEAD`; `git status --porcelain`, sorted, md5-summed and counted **over the listing and not over file
   bytes**; and `git stash list`. One further `/usr/bin/env -i PATH="$PATH" sh -c 'command -v rg; command -v fd; echo
   done'` was sanitized but was **still outside the requested checks**. **The other commands are not called sanitized or
   harmless.**
3. **The required read tools were not used.** Every file and log read went through Bash `sed`, `grep`, `awk` or `cat`.
   Waiting was `timeout 590 tail -n +1 -F` on the owned exit files piped to `grep`, and the two harnesses were started as
   **tool background tasks**. There was **no scripted stage gate**: the round read exit, summary, case, failure and NOT
   RUN data and then launched the historical stage.
4. **Three outside-root output artifacts were reported by the tooling.** They are recorded here as provenance and are
   **not to be read, removed, or claimed as prior-owned or exclusively created**:
   `/home/asen/.claude/projects/-home-asen-projects-ai-pi-fusion/cb19673a-e201-416f-ba07-72b6ffa5c90c/tool-results/b5lgrtw8y.txt`,
   `/tmp/claude-1000/-home-asen-projects-ai-pi-fusion/cb19673a-e201-416f-ba07-72b6ffa5c90c/tasks/b4pe2q447.output` and
   `/tmp/claude-1000/-home-asen-projects-ai-pi-fusion/cb19673a-e201-416f-ba07-72b6ffa5c90c/tasks/b0t1u3xd1.output`. The
   first came from `R=/tmp/pi-fusion-task5-full-verify-zyyvkz; sed -n '1523,1660p' "$R/logs/stage1-impl.out"`, which the
   tool reported as **38.3 KB and persisted**; the other two were reported for the two background stage launches. Their
   existence, state, ownership and prior contents are **not independently inspected**, and **no cleanup occurred**.
5. **Retracted claims.** "Everything written went under the owned root", "the working tree is byte-identical in
   composition", "no file was created, modified or deleted outside the root by my commands" and the unqualified "no real
   user profile was read" are all **withdrawn**. Matching **36** `git status` entries and no stashes is a comparison of a
   **listing**, not of **file bytes**. Inherited `git` could consult the real global or system configuration, `git
   status` can refresh index metadata, and the inherited `node --version` was not stripped of preload or cache knobs.
   **Effects are unknown in either direction** — nothing here asserts that effects happened, and nothing here asserts
   that there were none.
6. **What the round's own tool use was.** The delegate used **Bash only** in the execution round; its two clarification
   follow-ups made **zero tool calls** and are where these claims were retracted. The round is **not** relabelled
   Read/Grep-only or wholly isolated. **No intentional source edit and no SDK patch was reported**, and that is not a
   global byte-identity or no-effects claim either.

### What this round settles, and what it does not

- **Both full-stage invocations did run and did pass**, once each, and the `P7` recovery behavior was reproduced a second
  time. Those measurements stand on their own and are kept here whatever the scope failure.
- **The requested fully sanitized verification workflow was not completed as instructed**, so at the time of this round
  **task 5 stayed open, pending the user's decision on remediation**, and this round is not the clean qualification task 5's
  acceptance was waiting for. **That decision has since been taken**: the user authorized a rerun of just these two
  stages, directly in the host and fully sanitized, which is the section below. Everything recorded above — the passing
  stage results as well as every violation, retraction and unknown effect — stands unchanged.
- **Nothing here authorizes anything further**: no rerun, no inspection of the git index, a real profile, a cache, those
  three artifact paths or any process, no cleanup, no start of task 6, and no staging or commit. **Pi stays disabled and
  unregistered.**
- The rounds before this one are **separate and intact**: the first host round's **596 of 596** and `P7` **21 of 21**,
  and the pre-policy **19 of 21** failure with its raw `rpcAnswered: 18` counter and its two NOT RUN reuse subphases,
  are unchanged and are replaced by nothing here.
- `logs/metadata.txt` may be read as a record, but it documents **inherited-environment setup and probes** and is **not**
  evidence that the setup was sanitized.

## Authorized sanitized direct host rerun, and task 5's closeout (2026-09-29)

The last section chronologically, and the remediation the user decided on after the round above. **Just the two stages
were rerun — the full implementation selection and the historical baseline — directly in the host, with the setup as well
as the execution sanitized, owned logs and no execution delegation.** The host did exactly those two stages, **once each,
sequentially**, reading stage 1's exit status and its `74/74` footer before starting the historical stage. No Node,
utility, version, `git`, status or stash probe was made; no background task, no source edit during execution, no further
test, typecheck, syntax or whitespace check, and **no investigation or cleanup of anything the earlier rounds left
behind**.

### Provenance

Root: `/tmp/pi-fusion-task5-host-recheck-JACaDC`, created exclusively by `/usr/bin/mktemp -d` at `umask 077`. Logs:
`logs/setup.log`, `logs/status.log`, `logs/implementation.{out,err}` and `logs/historical.{out,err}`. `setup.log` records
the root, the Node executable, the working directory, the `PATH`, `setup=env-i`, `locale=C.UTF-8` and `umask=077`;
`status.log` records `implementation=0` and `historical=0`.

- **The whole setup command**, not only the harness, began
  `/usr/bin/env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 /bin/bash --noprofile --norc -c …`. **`PATH` alone was
  deliberately copied**; `LANG` and `LC_ALL` were **literals**.
- Owned `HOME`, `USERPROFILE`, `TMPDIR`, `TMP`, `TEMP`, `XDG` config, cache, data and state, `APPDATA` and
  `LOCALAPPDATA`, with an empty `gitconfig` and empty template and hooks directories: `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=ROOT/gitconfig`, `GIT_TEMPLATE_DIR=ROOT/git-template`, `GIT_TERMINAL_PROMPT=0` and
  `GIT_CONFIG_COUNT=1` with `core.hooksPath=ROOT/git-hooks`. That disables **inherited global and system git
  configuration for these host commands**; it is **not** a disabling of repository-local configuration and **not** a
  universal filesystem sandbox.
- Node directly at `/home/asen/.nvm/versions/node/v24.18.0/bin/node`, working directory `ROOT/work`, **no `npx` and no
  `npm`**.
- The harness by absolute path: `/home/asen/projects/ai/pi-fusion/test/spikes/pi-config-writes.mjs --stage impl --keep`,
  then `--stage historical --keep` in a **separate fresh `env -i` shell** with the same owned environment.
- Both stages' stdout and stderr were redirected into the owned logs; only short root, exit and log-path messages came
  back through the command tool, and **no log-output spill artifact was reported**. That is a statement about what was
  reported, and **not** a universal no-external-effects claim.

### Results

| Stage | Result |
| --- | --- |
| `--stage impl --keep` | **74 of 74**, exit **0**, **46** fixture model requests — `implementation.out` is 1662 lines, footer at 1659 and 1661 |
| `--stage historical --keep` | **11 of 11**, exit **0**, **8** model requests — `historical.out` is 266 lines, footer at 263 and 265 |

`implementation.out`'s header identifies node **v24.18.0**, Pi **0.85.1** as the repository dependency, and the kept
fixture root `ROOT/tmp/pi-config-spike-xmSqfq`; the historical stage's kept fixture root is
`ROOT/tmp/pi-config-spike-NkTygH`. Group slices of the implementation stage, from `implementation.err` and **not** extra
totals: **P6** `{bootstrapInvocations: 3, preSdkRefusals: 0, sdkLoaded: 3, serving: 2, rpcAnswered: 2,
refusalsAfterSdk: 1, loopbackModelRequests: 1}`, and **P7** `{bootstrapInvocations: 22, preSdkRefusals: 0, sdkLoaded: 22,
serving: 22, rpcAnswered: 22, refusalsAfterSdk: 0, loopbackModelRequests: 41}` with `NOT RUN: []` — no startup refusal of
either kind in that group.

### The P7 evidence this rerun read

Both concurrent cases: the shared archive **absent** before any body, the **exact held prefix** observed,
`interleavingReached: true`, and the asserted **A one final tool end and B zero** immediately before the held remainder.
**This run's** hold and latest-gap values are **22ms / 8ms** for `rg` and **19ms / 12ms** for `fd`; the previous round's
timings and archive sizes are not reused, and sizes are not recorded here.

Per child, read as fields rather than as an inferred pass: **exactly one** model-issued helper call, **two** model
requests, **one** helper invocation and the expected non-error output, with `input.extensions` `[]` and **0** repeat
arrivals. **A carried 0 notices. B carried exactly 1**, in the valid public update shape, on the expected helper tool and
call id, at **update index 10 before the final end at index 11**, with `invalidUpdates` `[]`.

**Both conditional third-child reuse phases ran**: offline caller and child both `1`, `input.extensions` `[]`, **0**
notices, `invalidUpdates` `[]`, the correct output, **no** release request and **no** interposer mapping, unchanged byte
and mode fingerprints, `stillInstalled` matching `expectedSha` at **0755**, and `callsDirectoryAfterReuse` `[]`.

Unchanged limits: the RPC stream still does **not** independently count both underlying attempts and does **not**
identify an exact failing syscall, so **the at-most-two bound stays the source-reviewed wrapper plus the previously
executed fake tests**. **Linux x64, node v24.18.0 and repository SDK 0.85.1 only.** The fetch guard's coverage is
**global `fetch` in the processes preloaded into** — no sandbox claim, and no claim that all descendants were terminated.

### Review attribution

**No new independent review of this rerun was performed.** The host read its own fresh logs: the two exit statuses, the
two stage footers, the stderr counters and the A/B notice, result and reuse fields. There was **no delegate review of
this round**, and **no global diff or byte audit** of anything. The earlier reviews keep their own attribution: the
**source reviews** of the retry module, the bootstrap integration, the fake tests and the `P7` adaptation, and the
**read-only log review** of the first host round, are separate rounds and are not restated as covering this one.

### What this closes, and what it does not

- **Task 5's approved helpers, network and bounded-retry acceptance is complete within the measured scope**: the source
  reviews, then the first host round's typecheck, **596 of 596** default tests and `P7` **21 of 21**, then run-67's
  full-stage functional reproduction, and now this authorized sanitized direct host verification of both stages. The
  scope is **Linux and Pi 0.85.1** and nothing wider.
- **This addresses the verification-workflow gap alone.** It **does not** investigate and **does not** resolve the
  earlier rounds' possible outside effects, and it **authorizes no cleanup and no access** to the previously reported
  outside-root artifacts, to a real profile, to the git index, to a cache or to any process. Those records stand as
  written, with their effects **unknown in either direction**.
- **The pre-policy 19 of 21 remains a failure** of its own first-underlying-attempt gate and is **not** retroactively
  passed. Every earlier measurement, deviation and retraction on this page is preserved.
- **Not rerun here**, and still the earlier measurements they were: the **default suite** — **596 of 596** from the first
  host round — the **auth harness**, and any standalone syntax or whitespace check.
- **Pi stays disabled and unregistered.** **Tasks 6 to 8 remain pending**, no task 6 work, SDK change, staging or commit
  is performed or authorized by this record, and this is **not** production Pi enablement.
