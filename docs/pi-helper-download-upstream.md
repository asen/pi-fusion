# Proposal: per-attempt ownership for the SDK's helper download, carried upstream

> **Status: historical, unsubmitted, and superseded.** This page is a proposal that was **never submitted** anywhere,
> for a route the user afterwards **declined**: Pi's own source is not to be modified for this. What replaced it is a
> bounded **Fusion-side retry**, described as current policy under decision 5 and the task 5 status in
> [docs/pi-backend-plan.md](pi-backend-plan.md) and in the section after the source-only corrections in
> [docs/pi-config-write-spike.md](pi-config-write-spike.md). **No SDK source was modified**, then or since, and nothing
> below is being pursued.
>
> **Read the body as of when it was written**, which was **before** the later authorized clone and source reading of the
> public repository. Its statements that no checkout, clone, fetch or remote read was made are true of **that round**
> and are **not** claims about today: a clone and a source reading did happen afterwards, and both — including the
> pointer-file deviation in that round's setup, what is unknown about it, and the unverified correspondence of that
> checkout's `0.87.1` metadata to a release tag — are recorded in
> [docs/pi-config-write-spike.md](pi-config-write-spike.md) rather than rewritten into the old references below. That
> reading found the same shapes this page describes, and it reopens nothing: the SDK route stays declined.

Step 4 task 5 in [docs/pi-backend-plan.md](pi-backend-plan.md) owes a measurement that two children of one host can
both obtain a search helper on their first use of it. That measurement was made, by the concurrency half of the `P7`
group reported in [docs/pi-config-write-spike.md](pi-config-write-spike.md), and **it failed**: one child installs the
helper and the other comes back with the tool's own unavailable error. The repair route the user approved is not
Fusion-side coordination but a change to the SDK's own download path — unique per-attempt ownership, and executable
permissions set before publication rather than after it. This page is that proposal, written for a later authorized
upstream checkout.

**Nothing in this page was executed.** It is written from reads of the installed package's source and of this
repository's own harness and reports. No command below was run to produce it, no patch exists, no checkout was made and
no publication happened.

## 1. Scope and source provenance

What this targets is the **installed** `@earendil-works/pi-coding-agent` **0.85.1**, the version this repository
depends on, and nothing else. No version allowlist, floor or ceiling is proposed, and no other build is characterized.

Provenance, read from the installed package alone:

- `node_modules/@earendil-works/pi-coding-agent/package.json` gives `"version": "0.85.1"` and a repository of
  `git+https://github.com/earendil-works/pi.git` with `"directory": "packages/coding-agent"`.
- `node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js.map` gives
  `"sources": ["../../src/utils/tools-manager.ts"]`, which resolves against that directory to
  `packages/coding-agent/src/utils/tools-manager.ts`. That map also carries the module's `sourcesContent`, so the
  TypeScript this proposal is about is readable without a checkout.

**No upstream checkout, clone, fetch or remote read of any kind was made.** Every line reference below is to the
installed `dist` file (and, where noted, to its map's embedded source), which is the only copy this round could read.
Consequently **no claim is made that this defect is still present on current upstream `main`**, on any newer release,
or on any branch: the current upstream status is **unknown here** and has to be established in an authorized checkout
before an issue or a patch is filed.

Two further provenance limits, kept rather than smoothed over:

- Earlier rounds of this work recorded **tooling deviations** of their own, and they are documented in the *Source-only
  corrections* and *Verification* sections of [docs/pi-config-write-spike.md](pi-config-write-spike.md). Those rounds
  are therefore **not** described as strictly read-tool-only, here or there, and none of those commands is verification
  of anything.
- The harness and report corrections that the review of the concurrency stage asked for are **in the source and
  unexecuted**: they have passed an independent Read/Grep-only review, and no syntax check, test, real child or
  qualification run has been performed for them. The harness is **not** re-verified, and nothing below reads as if it
  were.

## 2. Defect and measured motivation

### What the installed source does

All references are `node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js`, 0.85.1.

- `TOOLS_DIR` is the one managed bin for the process, `getBinDir()` (`:9`). Fusion's children share one stable child
  agent directory, so two children of one host share that directory.
- `downloadTool` puts the archive at a **fixed, shared pathname** inside it: `join(TOOLS_DIR, assetName)` (`:244`).
  `assetName` is derived from the tool, the platform, the architecture and the **resolved version** (`:235`–`:237`), so
  any two attempts that resolve the **same asset** for that helper — same version, same platform, same architecture —
  compute the **same** pathname. Two attempts that resolved different versions would compute different names; the
  consequence below is scoped to the same-asset case, which is what the measurement exercised.
- `downloadFile` writes that pathname with `createWriteStream(dest)` (`:131`) piped from the response body (`:132`).
  No flag is passed, so it is `createWriteStream`'s **default** open behavior — write, creating or truncating — that
  overwrites an existing file at that name rather than failing on it. The SDK sets no explicit truncating flag.
- The **extraction** directory, by contrast, is already per-attempt: `extract_tmp_<binaryName>_<pid>_<time>_<random>`
  under `TOOLS_DIR` (`:251`), with a comment saying concurrent `fd` and `rg` downloads are why. So the extraction
  directory was made unique and the archive pathname was not.
- Binary discovery looks at two direct candidates — the versioned subdirectory and the extraction root (`:267`) — and
  otherwise walks the extraction directory for an **exact file name** (`:270`, `findBinaryRecursively` at `:134`).
- Publication is `renameSync(extractedBinary, binaryPath)` at `:273`, and the executable bit is set **afterwards** by
  `chmodSync(binaryPath, 0o755)` at `:280`.
- The `finally` block removes **both** the shared archive pathname and the attempt's extraction directory:
  `rmSync(archivePath, { force: true })` (`:285`) and `rmSync(extractDir, { recursive: true, force: true })` (`:286`).

Two consequences follow from those lines alone:

1. **Shared archive ownership.** Two callers sharing `TOOLS_DIR` and resolving the same asset share one archive
   pathname. One attempt's stream can overwrite the other's bytes at that name, and one attempt's `finally` can unlink
   the other attempt's archive while that other attempt is still downloading into it or extracting from it. Nothing in
   this path establishes who owns that name.
2. **A potential publication window of its own.** `getToolPath` reports the helper as present purely by `existsSync` on
   the final binary path (`:80`–`:83`), and `ensureTool` calls it (`:301`). Because `renameSync` at `:273` publishes the
   binary at that observable name **before** `chmodSync` at `:280` is applied, an observer — including another attempt's
   own `getToolPath` — can see a final binary whose mode is still whatever the extracted payload carried. Whether that
   mode is non-executable **depends on the archive**: it is a real window only for a payload that lacks the execute
   bits, and a release asset whose program is already executable would pass through no such state. This is
   **source-identified and conditional**, not something the harness measured and not a claim about every release binary.
   The archives in the fixture cases deliberately held programs at mode **0600**, which is why the installed 0755 is
   attributable to `chmodSync` there; **real upstream asset modes were not inspected** anywhere in this work.

Related, and deliberately **not** proposed as part of the fix: `ensureTool` looks the bin up once, before the download
(`:301`), and never again after a failed download (`:321`–`:341`).

### What was measured

The two cases are `P7-helper-concurrent-rg` and `P7-helper-concurrent-fd`, in
`test/spikes/pi-config-writes.mjs` (`caseP7Concurrent`), reported in
[docs/pi-config-write-spike.md](pi-config-write-spike.md).

The one qualification run that included these two cases — earlier `P7` revisions, without them, had passed — reported
**19 of 21** selected cases keeping their guarantees, with **0 NOT RUN**, and **both** concurrent cases failing the
strict acceptance that **both** children's **first** use of the helper succeeds. In each case:

- the child whose body completed first downloaded, installed and ran the helper, answering its tool call with the exact
  expected text;
- the other child's first use came back as the SDK's own generic error — `ripgrep (rg) is not available and could not
  be downloaded`, and `fd is not available and could not be downloaded` — with `isError` true;
- the helper left in the shared bin at the end of the case was **byte-identical** to the archived program and
  **executable** at mode 755, with no archive and no extraction directory beside it;
- the failing child's own evidence was otherwise clean: its two mapped urls at its own listener, nothing blocked by the
  fetch guard, an exit of 0, its model requests made and its scripted final text returned, and an **empty** helper log,
  so it never started the program in the bin.

What the **0 NOT RUN** figure is, exactly: it is the run's case/platform-skip metric — no case of the selection was
skipped for the platform it ran on — and it is **not** evidence that every conditional step inside a case ran. It was
not. Each concurrent case's third-child **reuse** subphase is conditional on its case's acceptance being met, so both of
them were **skipped** after the first-use failure and are reported in
[docs/pi-config-write-spike.md](pi-config-write-spike.md) as **0 of 2** run. Nothing about byte-identical reuse of a
concurrently installed helper was measured.

Two limits of that measurement are load-bearing and are preserved here:

- **The exact failing SDK operation was not directly observed.** Extraction from a pathname another attempt had already
  removed is the candidate the source supports; it is a candidate and not an observation. Nothing there instrumented
  the SDK, held a descriptor or traced a syscall.
- **The generic error hides which internal failure it was.** `grep` and `find` call `ensureTool` with **no** `onStatus`
  callback (`dist/core/tools/grep.js:52`, `dist/core/tools/find.js:119`), and the tool rejects with one fixed sentence
  (`grep.js:54`, `find.js:125`). A stream or pipeline failure, an extraction failure, a failed lookup of the extracted
  binary and a failed publication therefore all collapse into the same text.

The state readings the harness took are per-process readings of one pathname at the moments it read them. They are
evidence that the shared name was interfered with; they attribute no operation to either child.

## 3. Proposed change, explicitly untested

A design sketch for the upstream module, **not** an applied patch and **not** a general concurrency guarantee:

1. **One per-attempt work directory under `TOOLS_DIR`**, allocated **atomically** with a genuine unique-directory
   facility — Node's `mkdtempSync` is the obvious one — rather than by composing a name out of pid, time and random
   characters as `:251` does today. A composed name is a guess at uniqueness; `mkdtempSync` is a creation that either
   owns the directory or throws.
2. **The archive lives at the root of that attempt directory**, so the pathname an attempt downloads to is one that
   attempt **exclusively owns** by virtue of having allocated the directory. `join(TOOLS_DIR, assetName)` at `:244`
   disappears as a shared name. The property being relied on is **exclusive allocation**, not secrecy or
   unguessability: every other correctly behaving attempt writes inside its own allocated directory, and nothing here is
   a security boundary or a guarantee against a process that deliberately writes into another attempt's directory.
3. **Extraction goes into a separate subdirectory** of the attempt directory, so the archive file and the extracted
   tree do not share one directory.
4. **Binary discovery stays rooted at that extraction subdirectory**, keeping the existing two direct candidates and
   the exact-name recursive walk (`:267`–`:270`) as they are, only anchored at the new subdirectory. The lookup rules
   themselves are not being redesigned.
5. **Executable permissions are set on the extracted binary before it is renamed** to the stable destination, inverting
   today's `:273`-then-`:280` order. Publication then makes an already-executable file visible at the observable name,
   which closes the potential window described in §2 for the observer `getToolPath` actually is. That window is
   **conditional** — it exists only where the extracted payload does not already carry the execute bits, and real
   upstream asset modes were not inspected here — so this step removes a possible state rather than a demonstrated one,
   and it is worth making for being order-independent of what an archive happens to contain.
6. **Cleanup removes only the attempt's own directory** — one recursive removal of a directory this attempt created —
   and **never** a shared archive pathname. The `rmSync(archivePath, …)` at `:285` has no counterpart in the proposal.

Keeping the attempt directory **under `TOOLS_DIR`** matters: the final `rename` stays within one filesystem, which a
temporary directory elsewhere (a system temp root, say) would not guarantee.

What this is explicitly **not**:

- **Untested.** No patch was written, applied, compiled or run; no child, real or fake, has exercised this layout.
- **Not a universal concurrency guarantee.** It removes one shared mutable name and one potential publication window.
  It does not claim that every interleaving of every number of attempts now succeeds.
- **Platform behavior is preserved and unqualified.** The existing platform branches — the `.tar.gz` and `.zip` paths,
  the Windows `tar.exe` and `Expand-Archive` fallbacks, the Unix-only `chmod` — are kept as they are. Windows
  replacement and executable-lock semantics, and platform runtime behavior generally, are **not** qualified by this
  proposal at all: a rename over an open or locked destination on Windows behaves differently from POSIX, and nothing
  here measures it.

What is deliberately **excluded** from the proposal, each of which would be a different change with a different
justification:

- no `onStatus` propagation from `grep` or `find`, and no change to the tool-facing error text;
- no re-check of the bin after a failed download, and no second `getToolPath` call in `ensureTool`;
- no **new** failed-attempt retry, and no re-entry of `ensureTool` after a failure — the existing `fetchWithRetry` calls
  in `getLatestVersion` (`:100`) and `downloadFile` (`:124`) are left exactly as they are, since the proposal touches
  neither; what is excluded is a new retry **around a failed install attempt** or a second pass through `ensureTool`;
- no lock file, mutex, advisory locking or serialization;
- no Fusion-side coordination, queueing or single-writer extension;
- no pre-seeding of the bin;
- no provider or download client, and no runtime override, environment variable or configuration knob;
- no public API redesign — `ensureTool`, `getToolPath` and their signatures stay as they are.

## 4. Draft upstream issue

A draft, for review here. **Not submitted, and not to be submitted without separate authorization.**

> **Title:** helper download uses a shared archive pathname in the managed bin, so two concurrent first uses can lose
> one of them
>
> **Version:** observed against the published `@earendil-works/pi-coding-agent` 0.85.1. Source module identified from
> that build's own source map as `packages/coding-agent/src/utils/tools-manager.ts`. I have not checked whether current
> `main` still behaves this way; please read this as a report about 0.85.1 only.
>
> **What the source does.** In `downloadTool`, the extraction directory is already per-attempt and unique, with a
> comment noting that concurrent `fd` and `rg` downloads race otherwise. The **archive** pathname is not: it is
> `join(TOOLS_DIR, assetName)`, which any two callers sharing the managed bin compute identically whenever they resolve
> the same asset for that helper — the same version, platform and architecture. The download uses
> `createWriteStream`'s default write mode, so it overwrites an existing file at that name instead of failing on it, and
> the `finally` block removes that name unconditionally, so one attempt's cleanup can unlink an archive another attempt
> is still reading, and one attempt's stream can overwrite another's bytes. Separately, the extracted binary is
> `rename`d to its final path **before** `chmod 0o755` is applied to it, and `getToolPath` reports a helper as present by
> `existsSync` on exactly that final path — so for an archive whose payload lacks the execute bits there is a window in
> which the published binary is visible and not yet executable. Whether your release assets are affected by that second
> point depends on the modes inside them, which I have not inspected; the archives in my own fixtures were deliberately
> non-executable, so I am reporting the ordering rather than claiming every release binary passes through such a state.
>
> **What I measured.** Two agent processes sharing one managed bin, each on its **first** use of the same helper, with
> the two downloads deliberately overlapped: the first attempt installed a byte-correct, executable helper and its tool
> call succeeded, while the second attempt's tool call returned the generic
> `ripgrep (rg) is not available and could not be downloaded` (and the `fd` equivalent). The second process was
> otherwise healthy — it exited 0, made its requests, and never executed the helper. The helper in the bin at the end
> of the run was correct; what failed was the second process's first use.
>
> **What I did not establish.** I did not observe **which** operation inside `downloadTool` failed. Extraction from a
> pathname the other attempt had already removed is the candidate the source supports, and it is a candidate. The
> reason is unrecoverable from the outside because `grep` and `find` call `ensureTool` with no `onStatus` callback and
> reject with one fixed sentence, so a stream failure, an extraction failure, a failed binary lookup and a failed
> publication are indistinguishable at the tool result.
>
> **Suggested direction.** Give each attempt one atomically created directory under the managed bin (`mkdtempSync`),
> put the archive at its root and extract into a subdirectory of it, keep binary discovery rooted at that extraction
> subdirectory, set the executable bit before the rename that publishes the binary, and in cleanup remove only that
> attempt's own directory rather than a shared archive pathname. What that relies on is exclusive allocation of the
> directory, not an unguessable name: it is not a security boundary and says nothing about a process that writes into
> another attempt's directory on purpose. Staying under the managed bin keeps the final rename on one filesystem. I have
> not tested this, and I am not claiming it makes every interleaving safe; Windows replacement and executable-lock
> semantics in particular are unqualified by anything I ran.
>
> **Reproducer, such as it is.** The overlap is driven by a downstream project's own fixture harness:
> `node test/spikes/pi-config-writes.mjs --stage impl --case P7`, cases `P7-helper-concurrent-rg` and
> `P7-helper-concurrent-fd`. It uses that project's disposable fixtures — its own loopback release listeners, its own
> generated archives and throwaway profiles — and is **not yet a standalone upstream reproducer**. A minimal one that
> depends on nothing but this package would need to be written.
>
> **Where a test would live** has to be decided in a real checkout: the published tarball ships `dist`, `docs` and
> `examples` along with a few top-level files, and no upstream source or test tree at all, so the repository's test
> layout cannot be read from it. The package's own
> scripts identify **vitest** (`"test": "vitest --run"`, with `vitest` as a dev dependency), which says what the runner
> is and not where a case for this module belongs.

The draft above intentionally contains no temporary-root path, no profile detail, no credential or credential-shaped
value, no process id and no claim about upstream `main`.

## 5. Qualification limits and next work

**The current harness is a failing-version reproducer, not an acceptance harness for the changed layout.** This is the
most important limit on this page, and it follows from the harness's own code in `test/spikes/pi-config-writes.mjs`:

- `caseP7Concurrent` (line 7063) computes the **old fixed archive path** itself, as
  `path.join(where.childBin, archive.asset)` (line 7068), and carries it through the case as
  `observations.archiveBytes.sharedPath` (line 7080).
- The observer is installed on the shared bin as `p7WatchBin(where.childBin, archivePath)` (line 7171). `p7WatchBin`
  (line 6870) puts a **non-recursive** `fs.watch` on that one directory (line 6879). Its archive-state reading and its
  prefix predicate use **only** that one fixed pathname, through `p7ArchiveState` (line 6851), whose single
  `fs.statSync` (line 6853) is the whole of it. It does read one more thing: `entries()` (line 6885) takes a
  **one-level** `readdirSync` listing of the bin, which is how the case records the names present there — including
  today's `extract_tmp_…` directories. That listing is names at one level only; it does not open, stat or inspect an
  archive **inside** a subdirectory, and no recursive read of the bin exists anywhere in the observer.
- The interleaving then **waits for that exact pathname to reach the held child's prefix size** —
  `watch.observer.reaches(prefix.length, P7_CONCURRENT_PREFIX_DEADLINE_MS)` (line 7181, deadline at line 6681) — after
  releasing the held child's headers and prefix (lines 7179–7180) and **before** releasing the other child's full body
  (lines 7188–7189). The sequence assertion just above it (lines 7175–7178) likewise requires that exact pathname to be
  absent or empty first.
- At the end of the case the same pathname is read again and required to be gone: `sharedArchiveAtEnd` at line 7356 and
  its check at line 7357.

An SDK fixed as proposed in §3 writes its archive inside a per-attempt directory whose name the harness has no way to
derive from the asset name in advance. The `statSync` at line 6853 would then never see the prefix, the wait at line 7181
would run out at its deadline, and the case would be reported in the harness's own terms as "a bound this harness set and
did not reach" — a **failure**, of the harness's own sequencing rather than of the helpers, on a build where both helpers
may well work. It is not a skip and is not counted as one. The one-level listing at line 6885 would show the new
directory's **name**, and neither it nor the non-recursive watch on the bin would show the bytes written inside it. So
these two cases stay the **recorded reproducer of the failing version** and are **not** an unchanged acceptance harness
for a changed private layout.

**What future qualification needs**, and what it must not do:

- An **owned-attempt-aware observer**: one that discovers the attempt directory each child actually created under the
  shared bin and observes the archive inside it, instead of a pathname the harness derives from the asset name. It has
  to positively establish that the held child's **prefix** is on disk **before** the other child's body is released, so
  the interleaving the case exists for is still constructed and not merely hoped for.
- Everything the current cases already guarantee has to survive that adaptation: both children's **first** successful
  invocations as the acceptance, every bound and deadline, per-child attribution through each child's own listener, and
  the unconditional release and cleanup of every held response and listener.
- What it must **not** contain: no rescue call, no repeated or retried tool invocation after a failed one, no
  pre-seeding of the bin, no relaxed timing and no relaxed acceptance. The acceptance stays each child's **first** tool
  invocation succeeding, so one child succeeding while the other returns the unavailable error stays a failure.
- **This observer adaptation is not implemented here.** No harness change is part of this task.

Beyond the harness: the proposed SDK change, and every platform and runtime claim about it, still needs **actual
testing** in an authorized checkout and in isolated owned environments. Until a build carrying such a fix is qualified
against these cases, **task 5 remains blocked and the Pi backend remains disabled, unregistered and refused in
production.**

## 6. Boundaries and authorization still needed

What has **not** happened, and is not authorized by this page:

- no patch to any file under `node_modules`, and no patch to a global or otherwise installed copy of the SDK;
- no dependency change, version bump, pin, resolution override or `overrides` entry in this repository;
- no automatic SDK override, shim, monkey patch or load-time interception at runtime;
- no package, provider client or download implementation of Fusion's own;
- no clone, fetch, branch, commit, push, issue, pull request or any other remote or published action.

What is still required before implementation or qualification can begin:

1. **An authorized upstream checkout path**, or explicit permission to clone the repository, so the real
   `packages/coding-agent/src/utils/tools-manager.ts` can be read and changed and the current upstream status
   established.
2. **Dependency installation** in that checkout, if building or running its tests needs it.
3. **Isolated executable verification** in owned environments: building the changed package, and running the
   concurrency cases against a child that uses it, with the observer adaptation of §5 in place.

**Remote publication — filing the issue, opening a pull request, or sending the §4 draft anywhere — is gated
separately** and is not covered by an approval to implement or to test locally.
