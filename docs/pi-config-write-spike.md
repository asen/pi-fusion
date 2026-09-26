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
```

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
