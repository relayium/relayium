# Architecture and resilience review

Whether the current repository, CI and release architecture holds for a product
that ships **Web, a Go server plus CLI/node, macOS, iOS, Android and Windows** —
and what has to change so a server hotfix can ship while platform work is paused.

**Scope and baseline.** Written 2026-08-21 as a documentation-only review, then
corrected and landed under the bounded architecture-resilience P0 pass. The
review was authored on the lineage whose local/PR head was `8a35616f`; that
lineage was **merged remotely as `24a29ec6`**, and `24a29ec6` has since been
**fetched locally and verified** as the base of this P0 pass. The two SHAs are
therefore one line of work observed at two points — a local/PR head and its
hosted merge commit — not two competing states.

This document decides direction and records triggers. Beyond the corrections and
the CI-policy changes explicitly enumerated in §9 as delivered, it implements
nothing, changes no production state, and is not authority to start any of the
work it lists. **Ops promotion work is explicitly out of scope** — see §7.

**Counts in this document are point-in-time observations**, taken at the
2026-08-21 audit point and labelled as such. They are evidence for a decision,
not standing figures, and they are expected to be re-measured rather than cited
forward.

---

## 1. Verdict: keep the modular monorepo

**`relayium` stays one product monorepo. `relayium-ops` stays a separate private
production control plane. Do not split now.**

The monorepo is not what is hurting. Four things are, and every one of them
survives a split unchanged or gets worse:

| Real problem | Evidence | Does splitting fix it? |
| --- | --- | --- |
| Mixed-scope, long-lived dirty worktrees | At the 2026-08-21 audit point: **16 registered checkouts in total, 10 of them dirty**. `ios-device-inbox` 144 dirty paths, `ios-0.2.0-alignment` 108, primary checkout 23. | **No.** The same uncommitted work would be spread across more checkouts, in more repos, with no home rule and no archive policy. |
| Merge to `main` *is* deploy for the central server and web | The central deploy is `relayium-ops/deploy/auto-deploy.sh`, run by a **5-minute cron that tracks the product repository's `origin/main`**. A merged `main` commit therefore reaches the central production host without any separate promotion decision. | **No.** Each repo would still be tracked by a cron on its own `main`. This is a release-pipeline property, not a repository-layout property. |
| Incomplete language-neutral contract coverage | `compat / wire-vectors` regenerates exactly two fixtures — `realtime-wire-vectors.json` and `store-wire-vectors.json`. `crypto-vectors.json` has **two authors** (`gen-crypto-vectors.mjs` plus a `textKeys` block pasted from `text-vectors.test.ts`) so it has **no zero-diff gate**. Device-inbox v3 has fixtures on both sides but no regeneration gate. | **Made worse.** Today a contract change and both implementations land in one commit that one gate judges. Across repos the same change becomes N commits, N reviews and a version-skew window. |
| Large shared Apple `RelayiumKit` fan-out | 8 source modules; `RelayiumStoreKit → RelayiumAppKit → {RelayiumKit, RelayiumShareKit}`, and any `apps/RelayiumKit/**` change fans out to **both** Apple workflows | **No.** A separate `RelayiumKit` repo converts a compile error into a published-version bump plus a dependency-update PR in two consumers — more steps for the same coupling. |

For a small, effectively single-owner team the monorepo's central property is
that **a protocol change and every implementation of it land in one atomic
commit that one gate judges**. Splitting trades that for cross-repo version
negotiation the team has no automation to absorb. Android and Windows arriving
later does not change this: they add platform roots under `apps/`, which the
current CI boundary rules already accept — one root, one heavy owner, contract
checks unfiltered.

### When multi-repo becomes correct

Not on a date and not on repository size. Split a component out **only when all
five hold at once**, and split that one component only:

1. **Independent team/ownership** — a person or team owns it and is not the same
   person merging its consumers.
2. **Independent release cadence** — it genuinely ships on its own schedule, and
   being forced onto the monorepo's cadence is an observed cost, not a theory.
3. **A stable versioned contract/package boundary** — a published, semver'd
   interface that has held still long enough to be worth versioning.
4. **Automation for compatibility and dependency updates** — automated
   cross-version compatibility testing and automated consumer dependency bumps
   exist *before* the split, not as a follow-up.
5. **No need for frequent atomic cross-component commits** — measured over recent
   history, not asserted.

**Absolute rule, no exceptions: never manually copy protocol definitions between
repositories.** A hand-copied wire definition is a silent divergence with a green
board on both sides. If a boundary cannot be expressed as a generated, gated,
versioned artifact, it is not ready to be a repository boundary.

### Why `relayium-ops` is separate — and what that does *not* claim

`relayium-ops` stays a separate repository for **trust, credential and
operations isolation**: it holds production credentials, fleet and deploy
control, and a different trust level from product source, and product
contributors must not need access to it to change the product.

**That is the whole reason, and it is sufficient on its own.** This review does
**not** claim `relayium-ops` satisfies all five generic split triggers above.
Read against those triggers honestly, it does not: it has neither independent
ownership in practice (the same person merges both sides), nor a stable
versioned contract boundary, nor cross-version compatibility automation.

**Recorded gap — the implicit product contract.** `relayium-ops` depends on the
product repository through an **undeclared, unversioned interface**: product
repository paths and layout, build/readiness signalling, and product API health
endpoints. Nothing generates, versions or gates that interface, so a product-side
rename or a readiness/health-shape change can break deployment with a green
product board on both sides. This is an **accepted current exception**, not a
solved problem: the isolation benefit is judged to outweigh it today, the
coupling is small and operator-observed, and closing it is P1 work (§9), not a
reason to merge the repositories. It must not be described as "already satisfies
the split triggers", because a future reader would then treat the boundary as
safer than it is.

---

## 2. Correction: `main` protection is present, not absent

Several audit statements say `main` is unprotected. **They are stale.** As of
2026-08-21, after PR #6 merged as `24a29ec6`:

- `main` protection is **enabled**, verified by re-reading the settings after the
  write: **strict** required status checks, **exactly one context**, bound to
  **GitHub Actions `app_id` 15368**; `enforce_admins` false; force pushes false;
  deletions false; no required reviews; no push restrictions.
- The API context reads `wire-vectors` while the merge box renders
  `compat / wire-vectors`. **This is a rendering difference, not a substituted
  check.** The `app_id` binding is what prevents a differently-owned check of the
  same job name from satisfying the rule.
- **`app_id` covers one substitution; job-name uniqueness covers the other.**
  The binding refuses a **differently owned** check — another App, or an external
  service posting a status — that reports the context `wire-vectors` for a gate
  that never ran. It cannot refuse a **second job of the same name in this
  repository**: that is the same app, `app_id` 15368, reporting the same
  context, so an unrelated green lane could satisfy the single requirement.
  Branch protection cannot see that, and a settings read-back cannot detect it.
  It is enforced in source instead —
  `scripts/test/ci-event-policy-test.mjs` §6j asserts that `compat.yml` declares
  the `wire-vectors` job **and** that no other workflow file on disk declares
  one, scanning every workflow rather than only the parsed set, with mutation
  evidence for both directions. The assertion pins the **name**; it is not, and
  must not be read as, evidence that the context is required.
- The wire-vector contract is therefore **required at merge time by repository
  configuration**, not merely fail-closed by workflow design. `OA-021` is
  complete.

**Any statement to the contrary is superseded, wherever it appears.** The two
statements that were still live in the tree — the "outstanding operational
requirement" paragraph in `docs/CI-PLATFORM-BOUNDARY.md` and the matching
`.github/workflows/compat.yml` header — **are corrected by this P0 pass** (§9,
delivered item 3). They previously instructed readers to describe a
now-required check as not required.

**Still not observed, and deliberately not claimed: a real pull request showing
the check as required in its merge box, and a merge actually blocked while that
check is red.** Protection is verified by **settings read-back only**. This is
tracked as an open evidence item, and both corrected texts say so in place:
confirm it on the next real pull request rather than asserting it now.

---

## 3. The two frozen dirty server changes are not competing implementations

`ios-device-inbox` and `mac-login-item-consent` both carry uncommitted server
changes. This has repeatedly read as two rival in-flight implementations of the
same work. **It is not.**

- The **`ios-device-inbox` copy was the retained source** of the pair-room
  retention fix. **Provenance:** this is not an inference from the diffs — it is
  recorded in the workspace `ACTIVE-WORK.md` entry
  **`Pair-room retention release-isolation lease (2026-08-20)`**, which names
  `relayium/.worktrees/ios-device-inbox` (`work/ios-device-inbox`, HEAD
  `f49cc524`) as the source of the transfer, isolates delivery into
  `.worktrees/fix-pairroom-retention` from fetched `origin/main` `46a59e7c`, and
  records that `ios-device-inbox` is read-only and left byte-for-byte unchanged
  under that claim. That fix was delivered on its own as **`10609840`**, followed
  by **`1595551c`**. Its value is already on `main`.
- The **`mac-login-item-consent` copy is an older historical draft** of the same
  area. It was never the retained source and is not a competing candidate.

**Both stay frozen. Neither may be merged.** Their content is history and context,
not a delivery queue. Cleanup and archival of these trees is a **separate,
separately-leased task** — not something to fold into any hotfix, release or
restructuring work, and not something to do by deleting a worktree because it
looked stale.

---

## 4. Target boundaries

Two categories, and the line between them is the only architectural boundary that
must never blur.

**Language-neutral, versioned, gated — shared by every platform:**

- wire formats (realtime, stored, signaling, handshake, text) and their test
  vectors — **gated today** for the realtime and stored wires;
- crypto vectors and key-derivation fixtures — **partially covered**;
  `crypto-vectors.json` has two authors and therefore no zero-diff gate (§1);
- device-inbox manifest fixtures, per protocol version — fixtures exist on both
  sides, **no regeneration gate**;
- **capability and error contracts — TARGET STATE, not current state.** No
  generated fixture and no zero-diff gate exists for these today. They are listed
  here because this is where they belong once built, and a reader must not take
  their presence in this list as coverage that exists.

The gated members of this category are **generated fixtures with a zero-diff
gate**, expressed once and asserted by every implementation independently. The
gate must stay **unfiltered**: a path filter is exactly how a new platform root
inherits an exemption from the compatibility contract without anyone deciding to
grant it.

**Platform-owned — never shared, never abstracted into a cross-platform layer:**

- UI, storage, background execution, share/extension surfaces;
- packaging, signing, notarization, store submission, release channels.

**`RelayiumKit` is refactored only along real dependency seams.** Today
`RelayiumStoreKit → RelayiumAppKit → {RelayiumKit, RelayiumShareKit}`, plus
`RelayiumPeerKit` and three E2E harness targets. Narrowing that graph is
legitimate when a module genuinely does not depend on another. It is **not**
legitimate to narrow a CI path filter to make the fan-out *look* smaller while
the compile-time dependency remains: that is lying in CI filters, and it produces
a green board for a change that was never built against its real consumer.
Filters follow the dependency graph; they never lead it.

---

## 5. Decision matrix — what can hotfix independently, and what is coordinated

The first column answers exactly one question: **"can this ship without waking a
paused platform lane?"** It is a *platform-coordination* answer. It is never a
statement about review depth, and it never speaks to the financial gates.

| Change class | Platform-independent? | Coordination required | Why |
| --- | --- | --- | --- |
| **Server data/storage** (internal logic, queries, retention, non-contract behavior) | **Yes** | Owning-lane Go tests + the required compatibility check | No client-visible contract moves. Must not block paused iOS authoring. |
| **Auth / billing / entitlement, with NO client-visible contract change** | **Yes — platform-independent** | Owning-lane tests + required compatibility check, **plus the three financial gates, which are separate and unconditional** | Platform-independence and financial review are different axes. Nothing about the client contract moving or not moving touches the money gates below. |
| **Auth / billing / entitlement that DOES change the client contract** | **No — coordinated** | Every implementation + the unfiltered contract gate + **the three financial gates** | Now it is both a contract change and a money-moving change, and it carries both obligations. |
| **Web-only** (UI, routing, styling, client-only behavior) | **Yes** | Web lane checks + unfiltered wire gate | Deploys with the web artifact; no native client release. |
| **CLI/node-only** (flags, output, local behavior) | **Yes** | Go lane checks + unfiltered wire gate | Ships on the node release cadence, independent of platform clients. |
| **Platform shell** (macOS/iOS/Android/Windows app code above the shared kit) | **Yes, within its own lane** | That platform's heavy owner workflow only | One root, one heavy owner. An iOS-only diff must not start macOS runners, and vice versa. Paused platforms stay paused. |
| **`RelayiumKit` (shared Apple)** | **No — coordinated** | Fan-out to **both** Apple workflows; paused platform work must be rebased/reconciled | Genuinely shared Apple code. Both consumers must build. May force a rebase of frozen platform work. |
| **Wire / DB schema / ops** | **No — coordinated** | Unfiltered contract gate + every implementation + expand-contract migration + ops review | The one class where atomicity is the whole reason for the monorepo. A DB change is expand-contract, never in-place. Ops changes reach production on their own path and get their own validation and rollback. |

### The financial gates are not a matrix cell

Any change that can **charge, refund, credit, debit, renew, cancel, upgrade,
downgrade, price, tax, invoice, grant paid entitlement or revoke paid
entitlement** takes **three independent gates**: one named implementation author,
a second model reviewing the complete diff and executable evidence, and an
independent read-only review by the strongest available model — plus at least one
adversarial test exercising a double-charge, early-grant, stale-revoke,
duplicate-refund or lost-credit path.

**These gates are unconditional and separate from everything in the table
above.** A **Yes** in the "platform-independent" column is not a waiver, a
reduction, or an argument that the change is small. Urgency, hotfix status, diff
size, an internal-only channel, a lack of current users, and the absence of a
client-visible contract change waive **nothing**. Only the owner may change that
standing policy, and a one-off release instruction is not a waiver.

**Reading the matrix:** rows marked **Yes** must not be blocked by paused iOS
work. Rows marked **No** are explicitly coordinated dependencies — they are
allowed, they are just never quiet.

---

## 6. Hotfix while iOS is paused — the required sequence

A server or web defect must be fixable at any time without unfreezing paused
platform work, and without disturbing a single dirty worktree.

**`docs/HOTFIX-RUNBOOK.md` is the executable procedure.** What follows is the
architectural shape it implements; where the two differ, the runbook is the
operative document.

1. **A fresh, clean worktree branched from FETCHED, REMOTE-VERIFIED
   `origin/main` — never from a local `main`.** Fetch first, then confirm the
   local branch point equals the fetched remote head, and record that SHA. A
   local `main` can be arbitrarily stale or can carry unpushed commits; a hotfix
   built on one either omits fixes that are already live or ships code that was
   never reviewed. Never reuse a dirty tree and never "just fix it here": a
   hotfix authored inside a candidate worktree entangles frozen work with a
   production change.
2. **Bounded hotfix lease** in `ACTIVE-WORK.md`: exact writable paths, the
   verified start SHA, executor, topology, run policy. Disjoint from every frozen
   tree by construction.
3. **Narrow change plus a reproducer.** A failing test that fails before and
   passes after. A hotfix without a reproducer is a guess with a deploy attached.
4. **Owning-lane tests plus the required compatibility check.** Not the full
   cross-platform suite — the lane that owns the code, and the unfiltered
   wire-vector gate that everything must pass.
5. **Independent review before merge.** Under collaboration mode this is Codex's
   acceptance pass on the actual diff and executable evidence. Money-moving work
   takes all three financial gates regardless of urgency (§5).
6. **Understand what merging actually does.** Today, merging to `main` is what
   deploys the central server and web — see §7. There is no promotion step to
   perform yet, and that is precisely the gap this review asks to close.
7. **Production verification and a stated rollback.** Confirm the deployed
   version, service/log state and observable behavior. A push is not completion.
8. **Paused work is preserved and reconciled later.** Frozen worktrees are not
   rebased during the hotfix. If the hotfix touched shared protocol,
   `RelayiumKit` or schema, record that the paused work now needs a rebase; that
   reconciliation happens when the platform lane resumes, under its own lease.

**Server / web / CLI-only fixes must not block iOS authoring, and paused iOS work
must not block them.** Shared protocol, `RelayiumKit` and schema fixes are the
declared exception: they are coordinated dependencies and may require a rebase of
paused work.

---

## 7. Release architecture: what "merge is deploy" actually means

The single most misread area of this architecture, so it is stated per channel
rather than as one sentence.

### The four delivery channels are different

| Channel | What ships it today | Is merge deploy? |
| --- | --- | --- |
| **Central server + web** | `relayium-ops/deploy/auto-deploy.sh`, run by a **5-minute cron** | **Depends on which mode the ops repository is in — check, do not assume.** Before the promotion-pin cutover the cron tracks this repository's `origin/main` and **merge is deploy**. After it, the cron deploys the commit `relayium-ops/deploy/production-pin` names and **merge deploys nothing**. See "Which mode is production in?" below. |
| **CLI / node tags** | `.github/workflows/auto-release.yml` cuts a **weekly, green-gated tag**; `release.yml` builds and signs what that tag names | **No.** Merging does not cut a tag, and a tag is a deliberate, scheduled, gate-checked act. |
| **Node fleet** | **Operator promotion, which already exists.** A fleet node moves to a new version on an operator decision, not on a merge. | **No — already solved.** This channel is the model, not the problem. |
| **Native releases** (macOS/iOS) | Their own signing, notarization, packaging and store/update-feed pipelines | **No.** No merge publishes a native artifact. |

**`auto-release.yml` is not the central deploy path.** It is a weekly green-gated
tag cutter for the CLI/node release line. Attributing the central production
deploy to it — as earlier drafts of this review did — points every promotion
conversation at the wrong repository.

### Which mode is production in?

This repository cannot answer that from its own contents, because the mechanism
lives entirely in `relayium-ops`. **Do not infer it from this document.** Check:

- **Ask the operator who owns production.** This is the fastest and most
  reliable answer, and the only one available to someone without ops access.
- **If you have read access to `relayium-ops`:** the file
  `deploy/production-pin` exists on its `main`, and `deploy/auto-deploy.sh`
  reads it. Both present ⇒ pin-aware.
- **If you have read access to the deploy log** (`operator only`): a pin-aware
  tick logs `up to date (pinned <sha>)` or
  `promoting <old> -> <new> (promotion instance <ops-sha>)`. The pre-cutover
  script logs `up to date (<sha>)` and `deploying <old> -> <new>` — no
  parenthesised `pinned`, and no promotion instance.

**Both modes are described below.** Neither is presented as the current truth,
because which one is live is an ops-repository fact with its own delivery
schedule.

### The gap, and how it is closed

Only the **first row** has the problem: for the central server and web there is
no separate decision between *"this code is correct"* and *"this code is now
serving users."* Every merge is therefore implicitly a production change, which
makes ordinary review carry production risk it was never scoped for.

**Before the cutover — merge is deploy.** The moment a branch merges to `main`,
the next cron tick serves it to real users. There is no window in which code is
on `main` but not live.

**After the cutover — merge lands code; a promotion deploys it.**
`relayium-ops/deploy/production-pin` is a committed file naming exactly one
already-merged, already-green product commit; the cron deploys that and nothing
else. Promotion is a commit to `relayium-ops` made with its `deploy/promote.sh`
from an operator workstation, which verifies the target is a full immutable SHA,
is an ancestor of `origin/main`, and has a completed/successful hosted GitHub
Actions wire-vector run before it will write anything. Two decisions, two
records.

The promotion gate reads that run from the **check-runs API**, so it matches the
API name `wire-vectors` — the same name, and for the same reason, that branch
protection's required context uses above. `compat / wire-vectors` is the merge
box's rendering of it, not a second check; §3 covers why that distinction is
load-bearing and what enforces the job-name uniqueness both rely on.

> **Hard boundary, unchanged.** The promotion pointer is **ops-first**: the
> authoritative change is to `relayium-ops/deploy/auto-deploy.sh`, not to
> anything in this repository. It is designed, implemented and reviewed under a
> **separate `relayium-ops` lease**
> (`docs/superpowers/specs/2026-08-21-product-promotion-pin-design.md` in that
> repository). Nothing in this document authorises a `relayium-ops`, fleet,
> deploy or production change, and no product code changes for it.

Constraints the ops-side design satisfies:

- **Fail-closed.** If the pointer is missing, unreadable, malformed, or names a
  commit the host cannot verify, auto-deploy **must not deploy anything** and
  must not silently fall back to tracking `origin/main`. A promotion mechanism
  that degrades into the current behaviour on error is not a promotion mechanism.
- **Immutable commit/artifact semantics only.** Promote a specific SHA or
  artifact digest. **Do not create a permanent release branch** — a long-lived
  release branch accumulates divergent code, cherry-picks and its own merge
  history, which is a second `main` with worse hygiene.
- **Rollback to an OLDER SHA must be a first-class, supported move, not an
  accident.** The pointer will legitimately be moved *backwards*. Any logic that
  assumes forward-only movement — "deploy if the pointer is newer than what is
  running", fast-forward-only checks, monotonic version comparisons — silently
  refuses the one operation rollback depends on. Moving the pointer back to a
  known-good older SHA must deploy that older SHA.
- **It must compose with the existing failure marker.** Auto-deploy already
  records a failed-deploy state (`FAILED_MARKER`) that stops it from repeating a
  broken deploy on every cron tick. The promotion design must define exactly how
  a pointer move interacts with that marker — in particular, whether a
  deliberate rollback to a known-good older SHA is permitted to clear it, and by
  whom. If it cannot, the marker turns the rollback path into a manual
  intervention at the worst possible moment. **The precise current semantics of
  that marker must be re-read from the ops script under the ops lease** and not
  assumed from this paragraph.
- **Retain everything that already works:** current SHA/readiness signalling and
  the automatic rollback path stay. This adds a decision point; it does not
  replace a working safety mechanism.
- **A promotion is auditable:** who promoted what, from which green run, and what
  the previous pointer was — so rollback is "move the pointer back", not
  "reconstruct the last good state".

One consequence is worth stating here rather than only in the ops repository,
because it changes what a product author should expect: **a rollback to an older
commit rebuilds from scratch.** The selective-build fast path keys on which paths
differ, not on which direction they differ in, so rolling back across a `web/` or
`server/` change costs a full build — and, if the older release's schema needs an
index migration on start, that too.

---

## 8. Availability and change safety

- **Incremental and backward-compatible, one reversible step at a time.**
- **Expand-contract for every DB and protocol change.** Add the new shape, write
  both, migrate readers, then remove the old shape in a later release. Never an
  in-place rename or a breaking migration.
- **No big-bang repository split**, ever — see §1.
- **No client release unless a client-visible contract actually changed.** Server
  and web fixes do not justify shipping native clients.
- **The existing single-host SQLite deployment is a real availability limit** and
  is stated as such. Multi-instance/HA is a **later, separately proven project**
  with its own design, evidence and rollback story. It is explicitly **not**
  bundled into CI or repository restructuring, and no work in this review depends
  on it.

---

## 9. Roadmap

### P0 — delivered by the architecture-resilience P0 pass (five items)

All five items below are **complete**; the count and the enumeration match.

1. **A formal hotfix runbook** implementing §6 end to end, executable rather than
   remembered — `docs/HOTFIX-RUNBOOK.md`.
2. **Correct the deploy, promotion and coordination facts** in this document:
   the central deploy path (§7), the auth/billing platform-independence answer
   with the financial gates held separate and unconditional (§5), the honest
   reason `relayium-ops` is separate plus its recorded contract gap (§1), and the
   fetched-`origin/main` hotfix base (§6).
3. **Correct the two stale merge-required statements** named in §2 —
   `docs/CI-PLATFORM-BOUNDARY.md` and the `.github/workflows/compat.yml` header —
   which instructed readers to describe a now-required check as not required.
4. **Finite `timeout-minutes` on every `ios.yml` and `release.yml` job.** Both
   previously had none, so a wedged run could hold a paid macOS slot or the
   release lane until GitHub's 6-hour default.
5. **Remove the `[macos-only]` commit-message escape from `ios.yml`.** A commit
   message could skip the iOS build, and an escape hatch in a gate is not a gate.
   Items 4 and 5 are additionally asserted in
   `scripts/test/ci-event-policy-test.mjs`, so neither can be quietly reverted.

### P1 — close the structural gaps

6. **Merge/deploy separation for the central server and web** (§7):
   **designed and implemented in `relayium-ops` under its own lease**
   (`deploy/production-pin`, `deploy/promote.sh`, the pin gate in
   `deploy/auto-deploy.sh`), ops-first and fail-closed. **Awaiting independent
   acceptance review and delivery in that repository; not yet cut over.** No
   product code is involved, and nothing in this repository changed for it
   beyond this document and `docs/HOTFIX-RUNBOOK.md`.
7. **Declare the `relayium-ops` ↔ product contract** (§1): make the product
   paths, readiness signalling and health endpoints that ops depends on an
   explicit, checked interface rather than an implicit one.
8. **Finish crypto and device-inbox conformance fixtures.** Fold text-key
   derivation into `gen-crypto-vectors.mjs` so `crypto-vectors.json` has a single
   author, then bring it and the device-inbox v3 manifest fixtures under the same
   zero-diff gate as the realtime and stored wires.
9. **Observe required-check enforcement on a real pull request** (§2): a merge
   box showing the check as required, and a merge actually blocked while it is
   red. Until then, protection is settings read-back only.
10. **A one-dirty-home rule plus archive classification** for the checkouts
    counted in §1. One home per line of work; everything else is classified
    **active**, **frozen-historical** or **archivable**, and archived
    deliberately. Covers the two frozen trees in §3 — classify and archive,
    never merge.

### P2 — scale-readiness, before Android/Windows arrive

11. **Narrow the Swift dependency graph** along real seams only (§4).
12. **Build the capability and error contract fixtures** that §4 lists as target
    state, and put them under the same zero-diff gate.
13. **A per-platform client minimum-version policy**, so server-side contract
    evolution has a stated floor per platform instead of an implicit one.
14. **Versioned web artifact and iOS release automation**, so promotion in §7 has
    something immutable to point at.

### P3 — reassess only on triggers

15. **Multi-repo:** reassess only when all five §1 triggers hold for a specific
    component.
16. **HA / multi-instance:** reassess only as its own proven project (§8).

---

## 10. Non-goals

Explicitly **not** proposed, not implied, and not authorised by this review:

- no immediate repository split;
- no microservices decomposition of the Go server;
- no shared cross-platform UI framework;
- no Android or Windows technology selection — that is a later decision with its
  own evidence;
- **no `relayium-ops` change, no promotion-pointer implementation, no fleet or
  deploy change, and no production change of any kind;**
- no change to release semantics or to any product build command;
- no iOS development. **iOS remains PAUSED.** The `ios.yml` changes in P0 are CI
  policy — timeouts and an escape hatch — and are not iOS product work.

---

## 11. Acceptance criteria for future architecture changes

Any change proposed by this review is accepted only against all five:

1. **No behavior or availability regression.** Demonstrated by executable
   evidence, not by inspection of the diff.
2. **Backwards compatibility.** Expand-contract for schema and protocol; older
   clients keep working across the change, or the change ships behind a stated
   minimum-version policy.
3. **Rollback.** A written, tested path back, with the exact command or pointer
   move. "Revert the commit" is only a rollback if reverting is actually safe for
   the data it touched.
4. **Independent CI and release evidence.** Green from a hosted run on the real
   trigger, not from a local run — and for release work, evidence from each gate
   separately (sign, notarize, staple, assess) rather than one aggregate claim.
5. **Precise ownership.** Exactly one owner per boundary — one heavy workflow per
   platform root, one writer per lease scope, one authoritative status per
   requirement. Two owners means a check nobody runs; zero means a platform that
   quietly stopped being built.

**Not waivable by any of the above:** the three-gate policy for money-moving
changes (§5), and the promise that Relayium cannot read plaintext user files or
user-held keys.

## See also

* `docs/HOTFIX-RUNBOOK.md` — the executable form of §6
* `docs/CI-PLATFORM-BOUNDARY.md` — which workflow owns which platform
* `scripts/test/ci-event-policy-test.mjs` — the executable half of §4 and §9
