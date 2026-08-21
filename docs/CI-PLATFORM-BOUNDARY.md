# CI platform boundary

Which workflow owns which platform, what "shared" is allowed to mean, and what
has to exist before a new platform may claim a directory under `apps/`.

This document is the prose. `scripts/test/ci-event-policy-test.mjs` is the
enforcement, and where the two disagree the test is right — see
[CI architecture is executable policy, not prose](#ci-architecture-is-executable-policy-not-prose).

## Platform roots

A **platform root** is one directory under `apps/` holding one platform's app
source. Every root has exactly **one heavy owner**: the single workflow that
builds, tests, signs and releases it.

| Root                | Heavy owner            | Runner     |
| ------------------- | ---------------------- | ---------- |
| `apps/mac/`         | `.github/workflows/macos.yml` | `macos-15` |
| `apps/ios/`         | `.github/workflows/ios.yml`   | `macos-15` |
| `apps/RelayiumKit/` | *shared — see below*   | —          |

Path filters in GitHub Actions are per-**workflow**, never per-job. No
arrangement of jobs, `if:` conditions or matrices inside one file can make two
platforms start on different trees. That is why macOS and iOS are two files: the
split had to be a **file** split to be real at all, and it is the reason the rule
below is stated as a property of filters rather than of jobs.

**Rules.**

1. One root, one heavy owner. Two owners is a second platform runner charged on
   every commit for no new evidence; zero owners is a platform that quietly
   stopped being built.
2. A heavy owner's filter must match its own root, and must match **no other
   platform root**. `apps/**` violates this by construction, which is exactly
   what it did before the macOS/iOS split: every iOS-only change started the
   macOS signing lane, and every macOS-only change started an iOS runner.
3. Non-owning workflows may watch a root only when files under it are genuine
   **inputs** to what they run — something the run reads, compiles or serves.
   "The workflow is about that platform" is not the test; `apps/mac/` fails it
   for the pairing acceptance, which speaks for the macOS app without reading a
   file from it. See [native-web-pairing](#the-one-cross-client-exception).

## Apple-shared vs truly cross-platform

These are different contracts and they get different mechanisms.

**Apple-shared** is `apps/RelayiumKit/`: one Swift package, linking WebRTC and
Sodium through SwiftPM, that **both** native apps compile against. A change there
can break either app alone, so it is deliberately listed in `macos.yml`'s filter
**and** in `ios.yml`'s, and it fans out to exactly those two. Nothing outside
macOS and iOS compiles it, so a future Android or Windows workflow watching it
would burn a runner on every Apple change and prove nothing.

**Truly cross-platform** is a *contract* two independent implementations must
agree on — today, the cross-language wire vectors. Those are not shared source;
they are a claim about bytes that Swift, TypeScript and any future client must
all keep. A contract like that gets a fast, always-on gate
([below](#fast-compatibility-gates-vs-heavy-builds)), never a per-platform build.

The distinction matters because the cheap mistake is to treat Apple-shared code
as cross-platform — adding it to every platform's filter — and the expensive one
is to treat a cross-platform contract as one platform's business, which is how a
new client ships against a wire nobody re-checked.

## Fast compatibility gates vs heavy builds

Two kinds of CI work, two sets of rules:

|                | Fast compatibility gate        | Heavy platform build                 |
| -------------- | ------------------------------ | ------------------------------------ |
| Example        | `compat.yml`                   | `macos.yml`, `ios.yml`, `native-web-pairing.yml` |
| Runner         | `ubuntu-latest`                | `macos-15` (and any future platform runner) |
| Path filter    | **none** — always runs         | narrow, and names its real inputs    |
| Duration       | seconds                        | minutes to tens of minutes           |
| May skip?      | never                          | when no owned tree changed           |

`compat.yml` carries `npm run test:vectors`: it regenerates
`apps/RelayiumKit/Tests/Fixtures/*-wire-vectors.json` from the Web
implementation and requires zero diff. If the Web wire moves and the fixtures do
not, every Swift vector suite keeps passing **against the old wire**, and the two
implementations have diverged with a green board.

That check used to be the first step of `native-web-pairing.yml`, which was wrong
twice over. It waited behind a macOS runner, a Go toolchain, an `npm ci` and a
Chrome install for an answer that needs a checkout and Node; and, worse, it sat
**behind that workflow's path filter**. A contract check that only runs when one
platform's trees change is a contract check the next platform bypasses simply by
existing. So `compat.yml` has no `paths:` at all, on either event, and it is
fail-closed: finite timeout, no `if:`, no `continue-on-error`, no retry, no
placeholder job.

#### Always-run and fail-closed is one half; the required status is the other

Everything in the paragraph above is a property of the workflow **file**, and it
is enforced there and asserted by `scripts/test/ci-event-policy-test.mjs`. It
means the gate *starts* on every pull request and every `main` push and *reports
red* when the cross-language contract breaks.

By itself that does not make a red result **block** a merge. That is a GitHub
**branch protection** rule on `main`; it lives in repository settings rather than
in this repository's source, and **no test here can see it** — which is why this
paragraph, and not an assertion, is where its state is recorded. The status
context is:

```
compat / wire-vectors
```

— the workflow's `name:` and the job key, joined the way GitHub renders a check.

**That context is now required on `main`.** As of **2026-08-21**, after PR #6
merged as `24a29ec6`, `main` protection is enabled and was verified by re-reading
the settings after the write: **strict** required status checks, **exactly one
required context**, bound to GitHub Actions **`app_id` 15368**; `enforce_admins`
false; force pushes and deletions disabled; no required reviews; no push
restrictions. The API reports the context as `wire-vectors` while the merge box
renders `compat / wire-vectors` — a **rendering difference, not a substituted
check**. The `app_id` binding is what stops a differently-owned check with the
same job name from satisfying the rule.

**What `app_id` covers, and what covers the rest.** The binding answers exactly
one substitution: a **differently owned** check — another GitHub App, or an
external service posting a commit status — publishing the context
`wire-vectors` and satisfying the requirement on behalf of a gate that never
ran. It cannot answer the **same-repository** case, because there the impostor
is not differently owned. A job key `wire-vectors` declared in a second workflow
in this repository is GitHub Actions, it is `app_id` 15368, and it reports the
same context name; which run the merge box reconciles the single requirement
against is not something this repository controls. A cheap unrelated lane could
then stand in for the contract gate, and it would report **green**, not missing.

That half is enforced in source, not in settings: **`scripts/test/ci-event-policy-test.mjs`
§6j asserts that `compat.yml` declares a job named `wire-vectors` and that no
other workflow file declares one.** It scans **every** `.github/workflows/*.yml`
file on disk rather than the list of workflows this policy parses, because
`release.yml`, `auto-release.yml` and anything added tomorrow can declare a job
name just as well as a governed workflow can. Both directions are asserted: the
positive half fails loudly if the job is renamed or `compat.yml` is gone, so
"nothing else declares it" can never pass in a tree where nothing declares it at
all. Renaming this job silently un-requires the gate, which is why the name is
pinned by a test.

The two are complementary and neither is optional: **`app_id` blocks a
differently-owned check of the same name; executable job-name uniqueness blocks
a same-repository, same-app GitHub Actions collision.** Neither is evidence
about the other, and the assertion is about the **name** — it is not evidence
that the context is required, which remains a settings property recorded in the
paragraph above.

So `compat.yml` **may** now be described as merge-required, because it is. Any
statement in this repository or its history that calls it an outstanding
operational requirement is **stale and superseded**.

**One piece of evidence is still missing, and is deliberately not claimed:** the
enforcement is verified by **settings read-back only**. No real pull request has
yet been observed showing the check as required in its merge box, and **no merge
has been observed blocked while the check is red**. That observation is tracked
as an open item (`docs/ARCHITECTURE-RESILIENCE.md` §9, P1) and should be closed
on the next real pull request rather than assumed from the settings.

**What belongs in the fast lane:** a check that is seconds long, needs no
platform runner, and asserts that two independent implementations of one wire
still agree. **What does not:** anything that builds or signs a platform
artifact, anything needing a macOS or Windows runner, and anything slow enough
that always-on would be expensive.

### The one cross-client exception

`native-web-pairing.yml` is not a platform owner. It is the only hosted job where
the macOS native client and a real browser have to agree with each other — a real
server, a real pairing code, the macOS link workspace in one process and a real
headless Chrome on the real built bundle in another, in both role assignments.

It therefore watches several trees it does not own, and every one of them is a
real input — something the run reads, compiles or serves:
`apps/RelayiumKit/**` (the Swift half it compiles: `swift build --product
LocalTransferPeer`), `web/**` (the bundle it `vite build`s and serves),
`server/**` (the real hub it starts), and the two scripts it actually sources —
`scripts/native-web-pairing-acceptance.sh` and `scripts/lib/local-acceptance.sh`,
named one file at a time.

It does **not** watch `apps/ios/**`. Nothing under that root is an input to the
run, so an iOS-only change would start a 45-minute macOS runner that builds
nothing it touched.

It does **not** watch `apps/mac/**` either, and that one is worth stating
plainly because it reads as a surprise: this is the *macOS* native-to-browser
acceptance, and the macOS app's own root does not start it. The reason is the
input test in rule 3. The script builds exactly two trees — `server` and
`apps/RelayiumKit` — and serves the Web bundle; no file under `apps/mac/` is
read, compiled or served by the run. The macOS app target is SwiftUI views over
`RelayiumAppKit`, which lives *inside* `apps/RelayiumKit/`, so the logic this
acceptance exercises does start it. A change to `apps/mac/` alone therefore
starts `macos.yml` — plus the two unfiltered always-on workflows, `compat.yml`
and `repo-hygiene.yml` — and no pairing runner.

Bare `apps/**` and bare `scripts/**` are both gone for the same reason, and
neither may come back: they would silently adopt a future Android or Windows
root, or a future Android or Windows script, into a macOS runner the day
somebody created it.

## Adding a platform: Android, Windows, anything next

A platform root and the workflow that owns it are created **in the same commit**.

* A root with no workflow is source nothing compiles, tests or signs. The board
  is green only because nobody asked.
* A workflow with no root is a placeholder that reports a green check for a
  platform that does not exist — worse than an absent check, because it reads as
  coverage.
* A workflow that only `echo`es is the same failure wearing a build's clothes.
  It must contain a real build or test command for its own root.

So the commit that first adds `apps/android/` must also add
`.github/workflows/android.yml` with a filter naming `apps/android/**` and a job
that really builds it — and must add the root and its owner to `PLATFORM_OWNERS`
in `scripts/test/ci-event-policy-test.mjs`, which is what binds it to the
trigger, concurrency and duplicate-run policy. `apps/android` and `apps/windows`
are already named there as *future* roots, so the absence-or-completeness rule is
live today: create either one alone and CI says so.

A new platform does **not** get `apps/RelayiumKit/**` in its filter (that package
is Apple-shared), and does **not** get its own copy of the wire-vector gate
(`compat.yml` already covers it, unfiltered, which is the point).

### Independent version, signing, release and store pipelines

Platform ownership is not only about which runner starts. Each platform keeps its
**own** version numbering, signing identity and material, release artifacts,
update feed and store submission path, and they are not shared or derived from
one another:

* macOS: Developer ID signing, Apple notarization and stapling, Gatekeeper
  assessment, the DMG, the Sparkle appcast, and an immutable GitHub Release.
* iOS: its own build numbering and App Store Connect / TestFlight path.
* The Go server and CLI: `.goreleaser.yaml`, its own tags, its own signed
  checksums.
* A future platform: its own equivalents, decided when it is added.

A shared version number or a shared release job would re-couple platforms that
the file split exists to keep separate — a macOS notarization failure must not be
able to block an iOS submission, and one platform's release cadence must not
force another's.

### Windows today is not a Windows app

Windows already has real, shipped support, and it is **not** a native app:

* the Go CLI and server cross-compile for `windows/amd64` and `windows/arm64`
  via `.goreleaser.yaml`, published as signed-checksum release archives;
* `web/src/lib/temp-downloader.ts` generates the PowerShell **temporary
  downloader** for the download page — verify the ECDSA release signature, check
  the archive's SHA-256 against that signed list, run the official CLI from a
  temp directory, delete it on every path;
* `web.yml` has a `windows-temporary-downloader` job on `windows-latest` that
  actually executes that script.

None of that is a platform root. `apps/windows/` does not exist, no native
Windows app is built or signed, and the rules above are what will apply on the
day one is. Do not read the existing Windows support as an owned platform root,
and do not read the absence of `windows.yml` as missing coverage for what ships
today.

## Concurrency, and never building the same commit twice

Every governed workflow uses the same rule, and
`scripts/test/ci-event-policy-test.mjs` asserts it verbatim:

```yaml
on:
  push:
    branches: [main]          # main only
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

* **`push` is restricted to `main`.** Without it, a branch with an open pull
  request runs every workflow twice per commit against an identical tree — both
  green, and the duplicate is only visible if you count the runs. On a heavy
  platform build that is a doubled macOS bill for no new evidence.
* **The group key is the PR number**, so pushing three times to a branch leaves
  one live run instead of three. Every non-PR event falls back to
  `github.run_id`, which is unique per run, so nothing outside a pull request can
  cancel anything.
* **`github.ref` is the wrong fallback.** It puts every `main` run in one group,
  and GitHub cancels an older *pending* run in a group even with
  `cancel-in-progress: false`. Two quick merges would drop the first commit's
  verification, and `main` would show a *cancelled* check — which reads as
  "someone stopped it" rather than "this is untested".
* **`github.workflow` is part of the key**, so `macos.yml` and `ios.yml` never
  share a group, and a future platform's runs cannot cancel another platform's.

A new platform workflow copies this block unchanged.

## CI architecture is executable policy, not prose

Every rule in this document leaves the YAML **valid** when broken. `actionlint`
is happy with all of it:

* a filter widened back to `apps/**`;
* `apps/RelayiumKit/**` dropped from one of the two Apple filters;
* `continue-on-error: true` on the compatibility gate;
* a placeholder platform workflow whose only step is `echo`;
* the wire-vector command deleted, or duplicated into a second workflow;
* the concurrency group moved back to `github.ref`.

The next signal after any of those is a cross-client regression reaching a user,
or a bill. So the boundary is asserted in code, on every pull request and every
`main` push, by `scripts/test/ci-event-policy-test.mjs` (run from
`repo-hygiene.yml`, which has no path filter of its own):

* platform roots discovered by **reading `apps/` from disk**, so a new root
  cannot be added without the policy noticing;
* path filters **compiled to regular expressions and evaluated against real file
  paths**, so "too broad" and "too narrow" fail the same way — a list comparison
  only ever catches the edit somebody already thought about;
* a **mutation suite** that breaks each property in a copy of the parsed
  workflows and requires the matching complaint by its own wording, because a
  policy check that cannot fail is the most expensive kind of green — including
  cases that assert an **absence**, so a marker appearing only in a `run:`
  block's shell comment cannot make a workflow look like a platform's owner;
* a **self-host check**: the policy asserts that `repo-hygiene.yml` still has an
  unfiltered, non-skippable, non-advisory job actually running
  `node scripts/test/ci-event-policy-test.mjs`, and mutations prove that
  deleting, softening or skipping it is reported. Everything above is worth
  exactly what its execution is worth, and deleting one step is the cheapest way
  to silence all of it while the board stays green.

  One gap is stated rather than asserted: `repo-hygiene.yml`'s jobs declare no
  `timeout-minutes` and inherit GitHub's six-hour default, so the self-host check
  does not require a declared bound. Adding `timeout-minutes: 10` to the
  `ci-event-policy` job and the matching assertion is a one-line follow-up.

Change the boundary and you change that file in the same commit. If this document
and the test disagree, the test is the boundary and this document is stale — fix
the document.

## See also

* `.github/workflows/compat.yml` — the always-on gate
* `.github/workflows/macos.yml`, `.github/workflows/ios.yml` — the heavy owners
* `.github/workflows/native-web-pairing.yml` — the cross-client acceptance
* `.github/workflows/repo-hygiene.yml` — the unfiltered host that runs the two
  guards below on every pull request and every `main` push
* `scripts/test/ci-event-policy-test.mjs` — trigger, concurrency, race-lane and
  platform-boundary policy, and the self-host check on its own execution
* `scripts/test/native-web-pairing-gate-test.mjs` — that the acceptance and the
  wire-vector gate are wired at all
* `docs/MACOS-RELEASE-POLICY.md` — the macOS release pipeline in detail
