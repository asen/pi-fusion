# Spike: what the credential store does with a call's auth file

Step 4's auth decision in [docs/pi-backend-plan.md](pi-backend-plan.md) says a Pi child reads the user's existing
`auth.json` in place, that the rotating write back to it is the one authorized write, that no auth file is ever
created for a user who has none, and that a credential written by one runtime version stays readable and rotatable by
the other. Those are decisions; this is the measurement they owed for the **store half**. It runs real SDK code
against a throwaway profile with literal dummy credentials and a loopback token endpoint — never a real profile,
never a live provider, never a paid call.

Findings are marked **measured** (this harness ran it), **source** (read in the installed SDK, not executed here) or
**untested** (neither). Nothing here is a sandboxing claim, a version rule or an auth implementation: what the harness
adds is a fixture provider whose credentials are `DUMMY-` labels, and what it measures is the public
`ModelRuntime` credential path a production call would run on.

Two different things happen at the user's auth path, and the report keeps them apart. One is the **rotating
credential write** into `auth.json` itself, which is the write step 4 authorizes and which only a refresh performs.
The other is the **transient adjacent `auth.json.lock`**, which the credential store creates and removes around its
access to that one file — for a **read** as much as for a refresh — and which is the SDK's own managed shared access,
not a locking scheme, a credential store or a write policy of Fusion's. Because both paths are expected to change
during a case, both are excluded from the generic "the user's profile did not change" diff, and both are asserted on
their own terms instead: the file by its bytes, its selected entry's labels, its three unrelated entries and its 0600
mode, and the lock by having to be gone once every writer has exited.

Measured on Linux, node v24.18.0, `@earendil-works/pi-coding-agent` 0.85.1 (the repository's own dependency) and
0.87.1 (a separately installed build, whose public entry the skew case imports and executes in one leg), on
2026-09-28. **10 of 10 cases kept their guarantees**: 14 real SDK driver processes, 6 token mints, 5 loopback control
calls (2 gates, 3 marks). Beside them **1 of 1 control held**, in 1 process that runs no SDK at all: it is counted
apart throughout, and it is evidence about this harness rather than about any build, credential or version.

The original ten-case run on the same day, before an independent review of this harness was addressed, is the
**pre-review** run; the numbers above are from the re-run afterwards, whose case results are identical and which adds
the control.

## Reproducing

```bash
node test/spikes/pi-auth.mjs                                   # every case except the skew legs
node test/spikes/pi-auth.mjs --case A3 --keep                  # one case or group, keep its fixture root
node test/spikes/pi-auth.mjs --case A1,A5 --keep               # several, by case name or group
node test/spikes/pi-auth.mjs --package <dir>                   # add the skew case against another installed build
node test/spikes/pi-auth.mjs --case C1                         # the fake-package control alone, no SDK involved
```

The harness is manual: it starts real SDK processes, so it stays out of `npm test`, whose glob is `test/*.test.ts`.
It exits 1 when a case or a control breaks a guarantee, and 2 when a flag that takes a value has none or has another
flag in its place, when `--case` names a case and a group that do not exist, or when `--package` does not name a
readable installation of this package. Argument mistakes are refused before any package file is opened and before a
fixture root exists. `--keep` preserves that run's fixture root with
every driver's spec, its observations, the fetch guard's log and a `report.json`; an ordinary run removes its own
root and nothing else. Without `--package` the skew case is reported as **skipped — NOT RUN**, never as qualified.

Two files make it up. `test/spikes/pi-auth.mjs` is the controller: it builds the fixture root, seeds the shared
credential file, runs the loopback service that mints the dummy tokens and holds the gates, and asserts. `test/spikes/pi-auth-driver.mjs`
is the SDK process: one per caller, it asks the production `prepareCallStorage` and `bootstrapInput` which auth,
models and catalog paths the call runs on, hands `ModelRuntime.create` the same option set
`extensions/backends/pi-bootstrap.mjs` hands it, registers one fixture OAuth provider and calls
`hasConfiguredAuth` and `getAuth`. Neither file is imported by a test, and neither touches production code.

### What the fixture is, exactly

Every credential value anywhere in this spike is a literal `DUMMY-` label, and there is no real refresh-token family
in it. The provider's `login` throws: this measures the store, not a login flow. Its `refreshToken` posts the current
dummy refresh label to a loopback endpoint the harness owns, with the signal the SDK supplies, and returns the
current credential with a minted access label, refresh label and expiry over it. Its `getApiKey` returns the access
label. Each driver runs in an environment synthesized from nothing but an ordinary `PATH` — no provider key, Pi
variable, profile path, `NODE_OPTIONS`, `NODE_PATH` or compile-cache setting of the machine reaches it — with an
owned `HOME`, `TMPDIR`, XDG, AppData, cache and default-agent directory, all under that run's own fixture root.
`test/spikes/pi-fetch-guard.mjs` is preloaded into every driver, and a case only claims "no request was made" once
the log is readable and the guard is proved to have been installed in every process the claim is about; each case
also asserts the **exact** allowed traffic by path. The guard wraps `globalThis.fetch` in the processes it is
preloaded into and nothing else: it is not a sandbox, not a socket boundary and says nothing about a subprocess.

**Who reads the shared credential file, precisely.** Inside a driver process, the SDK's own credential store reads
that file and rotates it through the public API — that is the behavior under measurement, and a spike in which
nothing read it would measure nothing. What the driver does not do is read its bytes with **its own observation
code**: no probe there opens a user's `auth.json` before the runtime is created, after it or after a resolution, so
nothing a driver records is taken from that file's content. The only credential file a driver's probes read is the
private one inside its own call directory, which exists precisely because the user had none, and that read is guarded
by a containment check that refuses a path outside the call directory rather than opening it. The adjacent lock is
looked at by its metadata alone. The controller does read the shared file — that is where every byte and entry
assertion comes from — and it does so only while no driver is running: before a case's writers start, or after every
one of them has exited.

The shared file is one file — in the cases that have one. A1, A2, A3, A4, A6, A7 and A8 each work on a single seeded
file, and none of them copies the credential family, reseeds it between legs or gives a second caller a file of its
own. A5 is the opposite case: there is no shared file at all and the call falls back to a private per-call path. Of
the cases that do have one, only A1, A3, A4 and A8 rotate it; A2, A6 and A7 must leave their file byte-identical.

Besides the selected entry, a seeded file carries three unrelated ones — an ordinary api-key credential for another
provider, an entry under the key `meta` standing for something a newer runtime may write beside the credentials, and
an entry for a provider nothing here registers — all with dummy values and valid generic credential shapes. Every
case that has a shared file requires all three back JSON for JSON. The file is seeded mode 0600, and the controller
reads its raw bytes only while no driver is running — before that case's writers start, or after every one of them
has exited.

## What the production helpers selected

**Measured.** In every case the driver called the production `prepareCallStorage` and `bootstrapInput` and used what
they returned; no path in this spike is guessed or composed by the fixture. Where the user had a readable
`auth.json`, `sharedAuth` was true and the selected path was the user's own file. Where the user had none, and where
the path was a symlink to an absent target, `sharedAuth` was false and the selected path was inside that call's own
directory. `ModelRuntime.create` was given exactly the four options the bootstrap gives it — the selected auth path,
the models path, the catalog store path and, when this was measured, `allowModelNetwork: false` — and in every case
the models path it was given was this call's private one and did **not** exist, which is the absent-but-non-null path
the layout depends on. That last pair is asserted for every driver rather than merely recorded: the models path
handed to the runtime has to be the storage's own `privateModelsPath`, and it has to be absent.

> Since step 4 task 5's first subtask the composed permission is **true**, and this spike follows production rather
> than authoring a value of its own, so each driver is now constructed with `allowModelNetwork: true`. Nothing it
> measures moved with it: the drivers' synthesized environment has always carried `PI_OFFLINE=1`, and this build's
> runtime acts on that permission only when the variable is absent. The controller now requires **both** halves for
> every driver — the composed `allowModelNetwork: true` and an observed `process.env.PI_OFFLINE === "1"`, read in the
> driver process itself — so no case can pass on one of them alone, and the skew legs are held to the same pair. Every
> credential, token, lock, aggregate, disposal and models-path assertion is unchanged, and no case makes a catalog
> request. The measurements below were taken at the earlier revision, when the composed value was `false`, and are
> kept as they were.
No model request, session, transcript or RPC exists anywhere in this half: a driver that failed or was refused is
not a session, because none of these processes ever constructs one.

Two gates apply to every case rather than to the one that cares about them. `ModelRuntime.getError()` is read where
the production bootstrap reads it and again after the provider is registered and availability has settled, and both
readings have to be *usable* — an accessor that is missing, throws or answers a shape the bootstrap does not read is a
compatibility finding and never passes for "no error". A healthy configuration has to report an **empty** aggregate at
both points, which is what production requires before it runs a call; the one case that opts out is A6, whose
configuration is broken on purpose and which asserts its own non-empty aggregate instead. And every driver has to have
disposed of its own call directory, with the managed calls directory asserted empty in every case once every writer
has exited.

## The cases

### A1-rotate — a rotation writes back to the user's own file

**Measured.** Seed expiring inside the ordinary five-minute refresh window. Exactly **one** token request, carrying
the seeded refresh label 1. `getAuth` returned the minted label 2. The user's own file was rewritten: access and
refresh at label 2, the minted expiry about forty minutes ahead, the provider-specific extra field still there, the
three unrelated entries JSON-equal, mode still 0600, and no `auth.json.lock` beside it once the caller had exited.
Guarded traffic: one request, to `/token`.

### A2-fresh — a credential outside the window is used as it is

**Measured.** Seed expiring an hour ahead. **Zero** token requests and zero refresh-callback invocations, and the
file byte-identical to the seed — not merely equivalent JSON. `getAuth` returned the seeded label 1.

### A3-overlap — two callers, one file, one refresh

**Measured, with explicit synchronization.** Both callers finish SDK creation, provider registration and the initial
availability refresh **before** either asks for auth, so the store's own startup locks are not what they contend on:
caller A is started and parks at a ready gate, caller B is then started and parks at its own, and only then is A
released. A's token response is held at the endpoint; B is released while that lock is held, records the adjacent
lock, invokes `getAuth` **without** awaiting it, publishes an in-flight marker, and only then awaits. The held
response is let go once B's marker has arrived and while neither caller has published a done marker. The whole
interleaving is bounded from the **first held token request** at 10s, below the SDK's own 15s OAuth refresh timeout,
rather than by a sleep.

What it found: B saw the adjacent `auth.json.lock` present (a directory) before it asked; B's in-flight marker
arrived 18ms after the held request; no done marker existed before the release; **one** token request served **two**
callers; both resolved the same minted label 2; B's refresh callback never ran; the file was rotated exactly once, to
label 2, with the extra field and the unrelated entries intact; and no lock survived either exit. Guarded traffic was
exactly one `/token`, two `/gate` and three `/mark` calls.

### A4-fail-then-reuse — a refresh that fails before a token is minted

**Measured.** The endpoint answered 500 before it had ever minted. The first caller's `getAuth` rejected with a
`ModelsError` whose code is `oauth` and whose message starts with `OAuth refresh failed for`; the message was 79
characters, carried a cause, and did **not** contain the dummy credential marker. The source file was byte-identical
afterwards and no lock was left behind. A fresh later caller on the same file and the same family then succeeded,
minting label 2 and writing it back. Two token requests in total, both carrying the seeded label 1.

This measures a **callback failure before a successful token return**. A response lost after a real provider had
already rotated the family is a different thing and is **untested** here.

### A5-missing and A5-dangling — no auth file to read

**Measured.** With no user `auth.json` at all, and with the path a symlink to an absent owned target, the selection
was the same: `sharedAuth` false and a private path inside the call's own directory. That path did not exist before
the runtime was created; the SDK created it as a 2-byte `{}` at mode 0600; and it was gone with the call directory
once `dispose` ran, leaving the managed calls directory empty. The user's path stayed absent in the first case, and
in the second the link was still a link to the same target and the target still did not exist. Zero token requests,
and `getAuth` resolved to nothing at all.

What this measures is the **selection**: the storage resolves the user's file before the call directory exists, so an
external replacement between that read and the call is a race it does not claim to close, and this is not atomic
protection against one.

### A6-malformed — a malformed shared file

**Measured.** A malformed file carrying a dummy credential label was left byte-identical and produced zero token
requests. `ModelRuntime.getError()` reported a 99-character string both after create and after the provider was
registered; `hasConfiguredAuth` was false; and `getAuth` rejected with a `ModelsError` whose code is `auth` and whose
message starts with `Credential store read failed for` (125 characters, with a cause). By the rule the production
bootstrap already applies to a non-empty aggregate, such a configuration **would** be refused — that is a **source**
statement about the bootstrap's own code. No bootstrap ran here and no refusal was measured: this driver measured the
aggregate, not the refusal. Neither the
aggregate error nor the rejection contained the dummy marker in this case — but both are SDK text built around a file
that holds credentials, which is exactly why the bootstrap repeats none of it. This introduces no auth-only
classifier: the public surface has none, and this spike adds none.

A detail worth keeping: the store's constructor reads the file under a synchronous lock and **swallows** a parse
failure, preserving its last in-memory snapshot (**source**), while the asynchronous read that `getAuth` performs
surfaces it (**measured**). The two paths do not report the same way.

### A7-partial-oauth and A7-unknown-type — shapes the store hands back as they are

**Measured, and reported as measured.** With the selected entry `{type: "oauth"}` and no access, refresh or expires,
`hasConfiguredAuth` was true and `getAuth` resolved with source `OAuth` and **no** api key at all. With an unknown
`{type: "mystery"}` entry, `hasConfiguredAuth` was false and `getAuth` resolved to nothing. Both preserved the source
bytes, ran no provider callback and produced zero token requests. Neither result is a claim that such an entry is
valid credentials, and the zero-request assertion is written so a future non-zero count is a finding to report rather
than an assertion to relax.

### A8-skew — one family, two installed builds

**Measured, manual only (`--package`).** One shared file, rotated 0.85.1 → 0.87.1 → 0.85.1 with **no** reseeding and
no copying of the family between legs. Real rotations were forced through the public `minOAuthValidityMs`: the seed
expired ten minutes out, and the legs asked for 20, 60 and 180 minutes of remaining validity against minted lifetimes
of 40, 120 and 360 minutes. Each leg's endpoint request carried the **previous** leg's minted refresh label (1, 2,
3); each leg's result and the file advanced exactly once (2, 3, 4); the provider-specific extra field, the newer
`meta` entry, the unknown-provider entry and the 0600 mode survived every leg; three token requests in total; and
nothing was written outside the managed paths inside the owned profile and home.

The alternate build's own metadata is read to identify it, and its public entry is then **imported and executed** in
that leg's driver — that is what makes the leg a measurement of it rather than of a manifest. Its CLI is never
invoked and nothing is installed, and the production bootstrap still imports the SDK installed beside it. What is
compared is the **public `ModelRuntime` credential path alone**: this is not full bootstrap compatibility with that
build, and nothing here says its session, prompt or tool surface is compatible. Version and read-path checks are
**measured API compatibility**, not a production version allowlist and not a silent downgrade.

## The fake-package control (C1), which is not a case

**Measured, and about this harness rather than about any SDK.** The report above rests on a driver that records a
foreign failure as evidence and never repeats its text, so that property has a control of its own. `--case C1` points
the driver at an owned **fake** package generated inside the run's own root — its name matches the SDK's so the
driver's identity check is exercised, its version says `0.0.0-fixture-fake`, and its public entry throws from
`ModelRuntime.create` an error quoting a dummy access label, with a cause quoting a dummy refresh label, an error name
and an error code nothing here allowlists, and a stack. The repository's own test-only module fence
(`test/sdk-fence.mjs`) is preloaded beside the fetch guard, so an import of the real SDK by name would be refused
while it is still a specifier; the fake entry probes that itself and recorded the refusal
(`ERR_PI_FUSION_TEST_FENCE`) in the run.

What it found: the driver exited 1 without constructing a runtime; the failure was recorded as evidence with
`containsDummyMarker: true`, `hasCause: true`, `hasStack: true`, and the unknown name and code reported as
`other` rather than echoed; the fixture's own descriptive-text path was not taken for a foreign error; and the dummy
marker, the fake's wording, its name, its code and a stack frame appeared in **none** of the driver's stdout, its
stderr or its observations file. It also disposed of its call directory although its construction had failed.

What it is not: no SDK, no credential, no version and no bootstrap behavior is measured by it, and its process is
counted apart from the real SDK drivers and the auth cases throughout. It covers what this driver writes; it is not a
claim that anything intercepts arbitrary output an SDK might write to its own stderr from inside a process.

## Two things about the lock that are easy to get wrong

**A transient `auth.json.lock` beside the user's file is not a sign of a write.** The store takes the same adjacent
lock for a **read**: its constructor reloads under a synchronous lock, and a later read whose file revision has
changed reloads under the asynchronous one (**source**, and the directory was observed in A3). It is inherent
SDK-managed shared access to one file, and a lock appearing next to a user's `auth.json` while a child is starting
says nothing about the file being rewritten.

**The synchronous initial read lock and the asynchronous `getAuth` lock are different locks with different
behavior.** The constructor's is `lockSync` with a short bounded busy retry; the one `getAuth` uses is the
asynchronous lock with backoff, a stale bound and a compromise callback (**source**). The refresh callback runs
inside `modify`, so it is held under the **asynchronous** lock for the whole duration of the provider's token
exchange — which is why A3 starts both callers before either asks, and why its bound starts at the first held request
and sits below the SDK's own refresh timeout.

## Limits

- **Not atomic.** The store writes with `writeFileSync`, so a crash mid-write can truncate the shared file. No case
  here crashes a writer, and this spike makes no durability claim.
- **Lock compromise and stale timing are untested.** The stale bound, the compromise callback and a lock left behind
  by a killed process are **source** only; nothing here holds a lock past its stale window.
- **External deletion or replacement is a race, not a guarantee.** The selection reads the user's path before the
  call directory exists; a file appearing, vanishing or being replaced in between is not covered, and A5 measures the
  selection rather than protection.
- **Provider-specific extra fields depend on the callback.** The SDK's extension-oauth adapter stores what the
  callback returns with `type` added, so the extra field survives because this fixture's callback re-emits it — not
  because anything preserves it implicitly. A provider callback that dropped it would drop it.
- **Failures after a remote rotation are not measured.** A4 is a failure before a token was ever minted.
- **Linux only, one machine, node v24.18.0.** No real user profile, no live provider, no real OAuth endpoint, no
  registry and no download anywhere in it. The fetch guard is a preload over `globalThis.fetch`, not a sandbox, not a
  socket boundary and not a statement about a subprocess.
- **The leakage control covers this driver's own reporting.** It shows that a foreign constructor error does not
  reach the record or the streams. It says nothing about output a real SDK writes directly to its own stderr, which
  nothing here intercepts, and nothing about a real build.
- **This is a direct `ModelRuntime` store driver, not production-bootstrap integration.** There is no session, no
  model request, no RPC, no transport, no host record, no history file and no dashboard entry in any of it. What this
  half measures stays exactly that; the bootstrap's own OAuth path is measured separately and is reported under
  *Task 4 stage* in [docs/pi-config-write-spike.md](pi-config-write-spike.md), and neither report stands in for the
  other.

## What the real bootstrap then did with the same file

**Measured, elsewhere, and reported there.** This page is the store half and stays it. The other half of task 4's
evidence — the production bootstrap as a real child, on a shared credential file, through RPC — is the `P6` group of
the configuration-write spike and is reported under *Task 4 stage* in
[docs/pi-config-write-spike.md](pi-config-write-spike.md). Three cases, Linux and Pi 0.85.1 only, with a fixture OAuth
provider the call names as an ordinary resource and a loopback token endpoint: a rotation that writes the user's own
file back once and reaches the model with **only** the credential that rotation minted; a refresh that can never mint,
which this build attempted four times (the task's own attempt and three announced auto-retries), made no model request
for, left the file byte-identical after and left the child answering a non-task operation; and a malformed file, which
the bootstrap refuses at its `models` stage with exit 78 and its own fixed wording, naming neither the file nor what it
held. In both cases that reach the endpoint, no token request was made before the prompt: this build refreshes a
credential to run work, not to start a child.

Two things that page settles which this one could only read from the source. The malformed-file refusal is now
**measured** rather than inferred from the aggregate `A6` read — the two findings stay distinct, and `A6` is still the
measurement of the aggregate itself. And the rotating write and the transient adjacent lock are asserted there on the
same terms they are here, on a real child: the profile diff is exactly one modified `auth.json`, and the lock has to be
gone once every writer has exited.

What it does not add: no transport, no bridge, no registered backend, no host record, no history file, no dashboard
entry, no live provider and no real profile. It does not qualify any build other than 0.85.1, and the skew leg below
stays what it is — a comparison on the public `ModelRuntime` credential path alone, which says nothing about full
bootstrap compatibility at 0.87.1.

## Independent host reproduction of this half

**Measured by the host, not by the implementer of this harness, and recorded as its own verification.** The revision
this page reports was re-run independently and sequentially in a sanitized environment with its own `HOME`, temporary,
`XDG`, cache and profile directories: `node test/spikes/pi-auth.mjs --package <0.87.1 install>` came out **10 of 10**
cases and **1 of 1** control, with 14 real SDK driver processes, 6 token mints, 5 loopback control calls and 0 skips,
across 0.85.1 and 0.87.1; `node --check` on the controller and the driver was clean; and whitespace was clean. Its logs
are at `/tmp/pi-fusion-step4-task4b-host-juXLKj/{auth,controller-syntax,driver-syntax,whitespace}.log`. The same
harness was re-run untouched beside the `P6` work above, with the same results.

## Re-run under the task 5 composed permission

**Measured on 2026-09-28**, after step 4 task 5's first subtask flipped the composed `allowModelNetwork` to `true` and
this harness's own expectation with it. Both runs were sequential, from a working directory inside an owned root with
its own `HOME`, `TMPDIR` and `XDG` tree, under `env -i` with a `PATH` and those alone.

- `node test/spikes/pi-auth.mjs` — **9 of 9** cases and **1 of 1** control, 11 real SDK driver processes, 3 token
  mints, 5 loopback control calls, and **1 skipped**: `A8-skew` is NOT RUN without `--package`, so that line qualifies
  nothing across versions.
- `node test/spikes/pi-auth.mjs --package <0.87.1 install>` — **10 of 10** cases and **1 of 1** control, 14 real SDK
  driver processes, 6 token mints, 5 loopback control calls, 0 skipped, across 0.85.1 and 0.87.1.

What that re-run adds and what it does not. It adds the pair described above: every driver was constructed with the
composed `allowModelNetwork: true` and observed `PI_OFFLINE=1` in its own process, and no case made a catalog request.
It adds nothing about the network itself — no refresh was attempted, no catalog endpoint was reached, and a store
driver still builds no `AgentSession` and sends no model request. `C1` stays what it is: fenced, fake-package only, and
counted apart from the cases.

The host then re-ran the alternate-install leg of that pair independently, beside its own verification of the same
subtask, with the same result: **10 of 10** cases and **1 of 1** control, 14 real SDK driver processes, 6 token mints, 5
loopback control calls and 0 skips, across 0.85.1 and 0.87.1. Its log is
`/tmp/pi-fusion-step4-task5a-host-IivheW/auth.log`. Nothing in this harness changed for it, and the run without
`--package` was not repeated there, so the `A8-skew` skip line above stays the implementer's measurement.
