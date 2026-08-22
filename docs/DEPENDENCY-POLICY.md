# Dependency policy

How this repository decides what third-party code it is allowed to fetch, which
of those decisions are enforced automatically, and which are still a human's
job. It covers GitHub Actions, the Swift packages behind the macOS and iOS
apps, the Node major that CI runs, and the web lockfile.

The Go module graph is governed by `server/go.mod` and `server/go.sum`, which
the toolchain already verifies by hash on every build; it is deliberately not
duplicated here.

## The three layers

Dependency safety is three separate questions that fail in three different
ways, and conflating them is what produces gates people learn to ignore.

**Layer 1 — specificity and internal consistency. Deterministic, offline,
blocking.** Is every reference as specific as its ecosystem allows, and do the
tracked files that record those references agree with each other? This layer
needs no network, no credentials and no external service; it compares the
repository to itself, so it is stable enough to block a merge and cheap enough to
run on every push. `scripts/test/dependency-pinning-test.mjs` is this layer, and
it is wired into the `dependency-pinning` job of
`.github/workflows/repo-hygiene.yml`.

The rules are **not all the same strength**, and flattening them into one
"everything is pinned" claim is how a gate ends up trusted for more than it
proves:

| Reference | What it is | Strength |
| --- | --- | --- |
| `uses: owner/repo@<40-hex>` | a Git object name | **Identity.** One immutable commit. |
| `Package.resolved` `revision` | a Git object name | **Identity.** One immutable commit. |
| `integrity: sha512-…` | a content hash | **Identity of the bytes**, verified by npm at install time. |
| `exact: "0.11.0"` / `kind = exactVersion` | a version *constraint* | **Constraint.** The resolver cannot choose another release, but the tag behind that version lives in somebody else's repository and can in principle be repointed. The commit is named by `Package.resolved`, not by this. |
| `node-version: 24` | a major *selector* | **Mutable.** `setup-node` resolves the major to whichever matching release is available — from the hosted tool cache or by downloading one — so the exact minor and patch can move without any edit here. |

`actions/checkout@v6`, `from: "0.11.0"` and `lts/*` are weaker still — plain
names whose meaning upstream decides later — and are rejected outright.

What this makes rule 4 is a **consistency** rule, not a pinning one: it enforces
that every workflow names the *same* numeric Node major, so no lane silently
tests a runtime no other lane does. It does not, and cannot, claim that what was
reviewed is what runs.

**Layer 2 — vulnerability awareness. Network-dependent.**
Does any pinned version have a published advisory?

*Current reality, unchanged by the layer-1 gate:* two checks answer this today
and **both block a pull request**. `govulncheck` runs in the `go` job of
`.github/workflows/go.yml` (`go run golang.org/x/vuln/cmd/govulncheck@v1.6.0
./...`) and `npm audit --audit-level=high` runs in the `web` job of
`.github/workflows/web.yml`. A new upstream advisory can therefore turn a pull
request red without that pull request having changed anything.

*Intended architecture, not yet implemented:* this question cannot honestly be
answered offline — the answer changes without the repository changing, and a
check whose verdict depends on a third-party database updated an hour ago is a
check that fails on unrelated work. The end state is a scheduled lane that
reports, where a finding is triaged like any other defect (severity,
reachability, whether the affected code path is actually built) and becomes work
rather than an automatic merge block. Adding layer 1 does not move either
existing check; that move is recorded as deferred work below, because it changes
what blocks a merge and needs its own decision.

**Layer 3 — freshness. Expressed as reviewed update pull requests.**
Being behind the latest release is not a failure and must never be one. A gate
that fails for lag turns "upgrade deliberately" into "upgrade to make CI green",
which is how an unreviewed upstream change reaches a signing lane. Freshness is
instead expressed as update pull requests that a human reads: the diff, the
upstream changelog, and the tests are the evidence, and declining or deferring
an update is a legitimate outcome that leaves the tree green.

*Current reality:* `.github/dependabot.yml` is tracked, and it configures
**version updates for exactly two ecosystems** — `gomod` at `/server` and `npm`
at `/web`. Both are weekly and bounded: distinct weekdays at distinct off-hour
times in `Asia/Dubai`, so the two batches never arrive together or mid-workday,
and `open-pull-requests-limit: 3` each, so the queue has a ceiling a human can
drain. Minor and patch updates are grouped (one group for Go, which has no
production/development split in `go.mod`; a production group and a development
group for npm, because a bump that ships to users and a bump that moves the
build toolchain are not the same review). Majors are **not** ignored anywhere —
there is no `ignore:` block in the file — so a major still opens as its own
pull request, visible on its own, under the same cap.

Every one of those pull requests is a **reviewed** pull request. Nothing
auto-merges: auto-merge is a repository/workflow setting rather than a key in
that file, and it is deliberately not enabled anywhere. `swift` and
`github-actions` are deliberately **unconfigured** — see deferred items 5 and 1.
`scripts/test/dependabot-policy-test.mjs` asserts this shape, in the
`dependabot-policy` job of `.github/workflows/repo-hygiene.yml`.

*Not covered by that file:* **security** alerts and automated security fixes are
a different mechanism, and they are live repository settings rather than tree
state. They are not enabled by anything in this commit and cannot be. That
remains open work: Codex enables them and reads the resulting state back after
this merges. Until that read-back exists, this document claims nothing about
whether this repository is being told about advisories out of band.

Layer 1 exists so that layers 2 and 3 are meaningful. You cannot ask "does this
version have an advisory" or "is this version current" about a reference that
does not name a version.

## What the layer-1 gate proves today

`node scripts/test/dependency-pinning-test.mjs` runs in well under a second,
reads only tracked files, and enforces:

1. **Actions are pinned to commits.** Every non-local `uses:` in
   `.github/workflows/*.yml` is `owner/repo[/path]@<40 lowercase hex>` with a
   trailing `# vX.Y.Z` comment. `./…` references are exempt — they move with the
   commit under test. Any other form (`docker://`, a bare action name, a tag, an
   unparseable value) is reported by file and line rather than skipped.
   One **action+commit** must always carry the same version comment, and one
   action at one commented version must always be the same commit — a partially
   applied bump is a failure. Two different MAJORS of one action at two different
   commits are explicitly allowed. Comment consistency is keyed by action+SHA
   rather than by the bare SHA on purpose: a Git object name is unique inside one
   repository, not across GitHub, so two unrelated action repositories may
   legitimately contain the same commit id and describe it as different releases.
2. **Swift declarations name one version.** Every external
   `.package(url:)` in `apps/RelayiumKit/Package.swift` uses `exact:`; `from:`,
   `branch:`, `revision:`, `.upToNextMajor`, `.upToNextMinor` and explicit
   ranges are rejected. Every `XCRemoteSwiftPackageReference` in
   `apps/mac/…/project.pbxproj` and `apps/ios/…/project.pbxproj` uses
   `kind = exactVersion` with a concrete version. This is the *constraint* half
   only — see the strength table above — and is worth something because rule 3
   holds the revision that makes it concrete.
3. **Swift resolutions agree.** All three tracked `Package.resolved` files parse;
   every pin has a non-empty identity, a 40-lowercase-hex revision and a
   concrete version; and any identity appearing in more than one file resolves
   to the *same* revision and version everywhere. The files are **not** required
   to be identical or to carry the same JSON `version` — Sparkle is a macOS-only
   dependency and legitimately appears in one of them. The 40-hex revision is the
   immutable evidence behind rule 2's version constraints; what rules 2 and 3
   together establish is that the *tracked* declarations and the *tracked*
   resolutions are consistent and specific, not that a build consumed them
   unchanged.
4. **One Node major, consistently.** Every `node-version:` across every workflow
   is the same bare numeric major. Expressions, `x` wildcards, ranges, `lts/*`
   aliases and `node-version-file:` are rejected in this wave rather than
   interpreted — not because a bare major is immutable (it is not; `setup-node`
   still resolves the major to some available matching release, so the minor and
   patch can move) but because those forms
   cannot be compared lane-to-lane. The property enforced is that every lane
   moves together.
5. **The web lockfile is a lockfile.** `web/package-lock.json` is
   `lockfileVersion` >= 3 with a non-empty `packages` map; every non-root,
   non-link entry resolves to `https://registry.npmjs.org/` and carries a
   non-empty `integrity` hash. Another host, a `git+`/`file:` reference, a
   malformed URL, a missing `resolved` or a v1-style top-level `dependencies`
   map is a failure.

Every rule is a function over an in-memory model of the repository, and the same
invocation that checks the real tree also runs a set of mutations against copies
of it — each breaking exactly one rule and requiring that rule's specific
complaint back, plus an unmutated positive control and refutation cases for
shapes that are legitimate (a second action major at its own commit; two
different actions carrying the same commit id under different version comments;
Sparkle existing in one resolution file only). There is no opt-in flag for the self-check,
because a flag is something a CI configuration can be missing. A mutation whose
anchor has gone stale throws and is reported as a failure, so a harness that has
quietly stopped mutating anything cannot report green.

## What the layer-1 gate does NOT prove

Stated plainly, because a pinning gate is easy to over-read:

- **Not that a SHA is the release its comment names.** The `# v6.0.2` comment is
  checked for shape and internal consistency, never for truth — confirming it
  requires resolving the tag upstream. A wrong comment on a real commit passes.
- **Not that any pinned version is current, supported, or free of advisories.**
  Nothing here reaches a vulnerability database. That is layer 2.
- **Not that `registry.npmjs.org` is the rightful owner of a package name, nor
  that any tarball is safe.** The lockfile check proves the *host* is the public
  npm registry and that an `integrity` hash is *present* — it says nothing about
  typosquatting, a compromised maintainer account, or postinstall behaviour.
  Whether the hash matches the bytes is npm's job at install time, not this
  gate's.
- **Not that a pinned commit is a commit that still exists, or that upstream has
  not force-pushed around it.** Offline, an unreachable pin looks identical to a
  reachable one.
- **Not that any build actually consumed these files unchanged.** No lane passes
  `-onlyUsePackageVersionsFromResolvedFile` or otherwise disables automatic
  SwiftPM resolution, so `xcodebuild` may resolve — and rewrite `Package.resolved`
  — during a run. On the npm side this gate does not itself inspect any install
  command; every Web dependency install in `.github/workflows/` is `npm ci`
  today, and `scripts/test/ci-event-policy-test.mjs` already enforces the
  `npm ci --ignore-scripts --omit=dev` form for the compat lane, so the
  outstanding reproducibility gap here is chiefly Swift/Xcode automatic
  resolution. Rules 2, 3 and 5 establish that the *tracked* declarations and
  resolutions are specific and mutually consistent, which is a precondition for
  a reproducible build, not a demonstration of one. Deferred item 7 below.
- **Not that the Node runtime is fixed.** `node-version: 24` selects a major;
  `setup-node` supplies whichever 24.x it resolves to that day from the tool
  cache or a downloaded release. Rule 4 proves the lanes agree with each other,
  nothing more.
- **Not anything about the Go module graph, Xcode/Swift toolchain versions,
  Homebrew or system packages on runners, container images, or the runner images
  themselves.**
- **Not anything about live GitHub configuration.** Branch protection, required
  status checks, and whether Dependabot alerts or updates are switched on are
  repository settings, not tracked files. This gate cannot see them, and a green
  `dependency-pinning` job says nothing about whether it is *required* to be
  green before a merge. The same is true of the newer `dependabot-policy` job:
  it runs on every pull request, and it is **not** a required check.

  A live settings read on 2026-08-23 recorded that `main`'s protection requires
  **only the wire-vector check**, and that no repository ruleset is configured.
  That is a point-in-time observation of something outside this tree — it can
  change without any commit, and re-reading it is deferred item 3. Its practical
  consequence is the one that matters here: **a green tick on a Dependabot pull
  request does not mean the checks that would catch the update ran and passed.**
  Every such pull request still needs a deliberate Codex/owner review and an
  explicit wait for all the relevant checks, not just the required one.

## Deferred work

Recorded so it is not reconstructed later. Each item states its revisit trigger.

1. **Reconcile action major-version divergence.** `actions/upload-artifact` is
   currently pinned at two different majors in this tree — `native-web-pairing.yml`
   and `ios.yml` on one, the remaining workflows on another. The gate permits
   this deliberately, because collapsing them is a behavioural change (artifact
   layout and download semantics differ across that action's majors) and must be
   done with compatibility evidence from the jobs that consume the artifacts, not
   as a pinning cleanup. This is also why `github-actions` is absent from
   `.github/dependabot.yml` while item 4 ships Go and npm: an update bot would
   "resolve" the divergence by bumping one side, which is the outcome this item
   exists to prevent. The `dependabot-policy` gate fails if that ecosystem is
   added. *Trigger:* the next time either lane's artifact handling
   is touched, or the next deliberate bump of that action.
   Status: `recorded`.
2. **Select an exact GoReleaser binary version before enforcing one.**
   `release.yml` passes `version: '~> v2'` to `goreleaser/goreleaser-action`.
   The *action* is SHA-pinned; the *GoReleaser binary it downloads* is a floating
   range, so the signed CLI release is built by a tool version chosen at run time.
   Pinning it is the right end state, but the exact version has to be chosen and
   proven against a real release build first — a wrong pin breaks the only lane
   that publishes the CLI. This gate does not yet check the `version:` input.
   *Trigger:* before the next CLI release, or when the release lane is next
   modified. Status: `recorded`.
3. **Verify live branch protection and Dependabot settings.** Partly answered,
   and the remainder is live-setting work rather than a code task.
   `.github/dependabot.yml` is now tracked (see layer 3), so the *version
   update* half is no longer unknown. What is still outside this tree:
   * A live read on 2026-08-23 found that `main`'s protection requires **only
     the wire-vector check** and that **no ruleset** is configured. Neither
     `repo-hygiene / dependency-pinning` nor the new
     `repo-hygiene / dependabot-policy` is a required check. Both run on every
     pull request; neither blocks a merge today. Whether to require them is a
     separate decision, because making a check required changes what a red
     result means for unrelated work.
   * Whether **Dependabot security alerts and automated security fixes** are
     switched on is still unknown and unaffected by this commit. Codex enables
     them and reads the resulting state back **after** this merges; until that
     read-back, do not treat advisory notification as covered.
   *Trigger:* the read-back above, and any later change to `main`'s protection.
   Status: `in progress`.
4. **Add isolated ecosystem update automation.** Delivered for **Go and npm
   only**, with the shape described under layer 3 and asserted by
   `scripts/test/dependabot-policy-test.mjs`. The original entry proposed
   "Actions, then npm"; the order was inverted deliberately, because item 1's
   `upload-artifact` major divergence is exactly the thing a bot must not be the
   one to resolve, so `github-actions` is the ecosystem that stays out rather
   than the one that goes first.

   The precondition this item placed on item 3 is satisfied in the sense that
   mattered — the merge policy is now *known* rather than assumed — but it is
   known to be **weak**: only the wire-vector check is required. That does not
   make these pull requests unreviewed, because nothing auto-merges and each one
   is read; it does mean the review cannot lean on a green tick. Every
   Dependabot pull request needs the relevant checks watched explicitly.

   Note what "relevant" means here. The Apple lanes stay out on their own path
   filters — `macos.yml` on `apps/mac/**` plus `apps/RelayiumKit/**`, `ios.yml`
   on `apps/ios/**` plus `apps/RelayiumKit/**`, neither of which a
   `server/go.mod` or `web/package.json` change touches. But a Go or npm update is **not** a one-job pull request:
   `compat.yml` has no path filter at all and runs on everything,
   `native-web-pairing.yml` filters on `web/**` and `server/**` and so runs on
   both of these ecosystems, and `repo-hygiene.yml` has no path filter either.
   That is correct behaviour — a web or server dependency can break exactly the
   cross-client agreement those lanes exist to catch — and it is the reason the
   cap is 3 and the weekdays are separated.

   Remaining scope, tracked as its own work: `github-actions` (item 1) and
   `swift` (item 5). *Trigger:* those items' own triggers. Status: `completed`
   for Go and npm on 2026-08-23; the other two ecosystems are separately
   deferred below.
5. **Swift update automation stays deferred while iOS is paused.** The Swift
   packages here are the crypto and transport under the native apps; bumping
   either requires the vector tests and a real build to mean anything, and the
   iOS lane is not currently in a state to provide that evidence. Manual, exact,
   reviewed bumps remain the policy, and `.github/dependabot.yml` deliberately
   contains no `swift` entry — the `dependabot-policy` gate fails if one is
   added, so this stays a decision rather than a drift. *Trigger:* iOS work
   resuming. Status: `deferred`.
6. **Evaluate scheduled Swift/Actions vulnerability coverage that needs no
   secrets.** Layer 2 for the npm graph has an obvious shape; for SwiftPM and for
   GitHub Actions it does not, and the candidates must be assessed for whether
   they can run without credentials, without pushing this repository's dependency
   graph to a third party, and on a schedule rather than per-commit. Nothing has
   been selected. *Trigger:* item 4 has now landed for Go and npm, so this
   trigger is live; or a published advisory affecting a pinned Swift package.
   Status: `recorded`.

7. **Make builds consume the resolved files, then prove it.** SwiftPM automatic
   resolution is not disabled in any lane, so a build may resolve and rewrite
   `Package.resolved` rather than obey it. The end state is
   `-onlyUsePackageVersionsFromResolvedFile` on the `xcodebuild` invocations
   (`-disableAutomaticPackageResolution` is the other half of the same lever),
   plus a check that the file is unchanged after a build. The npm side is not
   the same hole: every Web install in `.github/workflows/` is already `npm ci`,
   and `ci-event-policy-test.mjs` enforces that form for the compat lane — what
   remains open there is only whether that coverage should become a centralized
   check over *every* workflow, should a future lane install outside it.
   These change how existing lanes fail and must be proven against a real macOS
   build, which this offline gate cannot do. *Trigger:* the next macOS or iOS
   build-lane change, or iOS work resuming. Status: `recorded`.
8. **Decide whether `govulncheck` and `npm audit` move to a scheduled lane.**
   Both block a pull request today (see layer 2). Moving them to a scheduled,
   reporting-first lane is the architecture this document argues for, but it
   removes a merge block and is therefore a policy decision with its own
   evidence, not a side effect of adding layer 1. Nothing has been moved.
   *Trigger:* the first time either check fails a pull request that changed no
   dependency. Status: `recorded`.

## Changing a pin

1. Edit the reference to its new value — full commit SHA plus an accurate
   `# vX.Y.Z` comment for an action, `exact:` for a Swift package, the
   `Package.resolved` entries for a Swift resolution (all files that carry that
   identity, together), `npm install` for the lockfile.
2. Read what changed upstream. The pin is the point at which that reading
   happens; skipping it turns a pinned dependency into an unpinned one with
   extra steps.
3. Run `node scripts/test/dependency-pinning-test.mjs`, then the lane that
   actually exercises the dependency.
4. If the update is behind schedule but not yet safe to take, leave it — layer 3
   is a review queue, not a deadline, and nothing here fails for lag.
