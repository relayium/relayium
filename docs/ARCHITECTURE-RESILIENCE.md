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
| Merge to `main` *was* deploy for the central server and web — **closed 2026-08-21** | At the audit point the central deploy, `relayium-ops/deploy/auto-deploy.sh`, ran on a **5-minute cron tracking the product repository's `origin/main`**, so a merged commit reached the production host with no separate promotion decision. It now deploys the commit `relayium-ops/deploy/production-pin` names, and a merge moves nothing (§7). | **No** — and the way it was actually closed is the proof. The fix landed entirely inside `relayium-ops`, with no repository boundary moved. Each repo would still be tracked by a cron on its own `main`: this is a release-pipeline property, not a repository-layout property. |
| Incomplete language-neutral contract coverage | `compat / wire-vectors` regenerates four fixtures — `realtime-wire-vectors.json`, `store-wire-vectors.json` and, since 2026-08-22, `crypto-vectors.json` and `device-inbox-manifest-v3-vectors.json`. The realtime fixture now also owns the capability handshake: exact Web/native announcements, retry/settle timing, promotion, legacy lane, revocation, downgrade, role and proven-link behavior are independently asserted by TypeScript and Swift. **Now open instead:** error contracts, which still have no fixture and no gate. | **Made worse.** Today a contract change and both implementations land in one commit that one gate judges. Across repos the same change becomes N commits, N reviews and a version-skew window. |
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

**Recorded gap — the implicit product contract, now declared.** `relayium-ops`
depended on the product repository through an **undeclared, unversioned
interface**: product repository paths and layout, build/readiness signalling, and
product API health endpoints. Nothing generated, versioned or gated it, so a
product-side rename or a readiness/health-shape change could break deployment
with a green product board on both sides.

That interface is now explicit on both sides — `contracts/ops-deploy-v1.json`
with its product readers here, and an immutable vendored copy, unconditional
enforcement and a promotion-time drift refusal in `relayium-ops` (§9, item 7).
**It still must not be described as "already satisfies the split triggers."** The
same person merges both sides, the contract covers the deploy interface rather
than the whole coupling, and there is no cross-version compatibility automation.
What changed is that the coupling is written down and checked; the reason the
boundary exists is still isolation, not a versioned package relationship.

**One asymmetry belongs in the record.** The ops repository's current
private-repository plan does not expose branch-protection setup or read-back
through the API, so `relayium-ops` cannot show the settings evidence §2 records
for product `main`. Its merges rely instead on serialized single-writer process
and terminal exact-head and exact-main run evidence. That is a real mechanism and
it is what its deliveries are evidenced against — it is not an enforced required
check, and it is not presented as one.

---

## 2. Correction: `main` protection is present, not absent

Several audit statements say `main` is unprotected. **They are stale.**
Protection was enabled on 2026-08-21, after PR #6 merged as `24a29ec6`, and the
required set has since been edited twice:

- `main` protection is **enabled**, verified by re-reading the settings after
  every write: **strict** required status checks, **exactly one context**, bound
  to **GitHub Actions `app_id` 15368**; `enforce_admins` false; force pushes
  false; deletions false; no required reviews; no push restrictions.
- **That one context is now `merge-gate`, not `wire-vectors`.** The original
  single context was the bare `wire-vectors`; protection edit A added
  `merge-gate` beside it, and **protection edit B narrowed the set to
  `merge-gate` alone**, read back after the write as `strict: true` with exactly
  that one context. The two-step order is why no required context was ever left
  reported by nothing. `docs/CI-PLATFORM-BOUNDARY.md` carries the staged
  migration and its current position.
- **The wire-vector contract still reaches the merge button, through the
  aggregate.** `merge-gate.yml` calls `compat.yml` **unconditionally** — no
  `if:`, no `with:`, and no `paths:` on the lane itself — and cannot go green
  unless that lane succeeds. `compat.yml` no longer has a direct `pull_request:`
  entry point of its own. What moved is which name protection names, not whether
  the contract blocks a merge.
- **The bare `wire-vectors` check run did not stop mattering; its consumer
  changed.** `compat.yml` keeps its permanent `push: branches: [main]` trigger,
  so every `main` commit still carries a directly-triggered `wire-vectors` check
  run, and `relayium-ops` `deploy/promote.sh` refuses to promote a commit that
  lacks one (§7). It is a deployment/promotion check consumed across the
  repository boundary — it is **not** a PR-required branch-protection context any
  more.
- The two names are different runs rather than one rendering. `wire-vectors` is
  what the check-runs API returns for the direct `push: main` run, and it is the
  name `promote.sh` matches; `compat / wire-vectors` is how the **called** lane
  renders on a pull request, prefixed by the caller's job id. Neither is a
  required context; `merge-gate` is. The `app_id` binding is what prevents a
  differently-owned check of the same job name from satisfying the rule.
- **`app_id` covers one substitution; job-name uniqueness covers the other.**
  The binding refuses a **differently owned** check — another App, or an external
  service posting a status — that reports the required context for a gate
  that never ran. It cannot refuse a **second job of the same name in this
  repository**: that is the same app, `app_id` 15368, reporting the same
  context, so an unrelated green lane could satisfy the single requirement.
  Branch protection cannot see that, and a settings read-back cannot detect it.
  It is enforced in source instead —
  `scripts/test/ci-event-policy-test.mjs` §6j asserts that `compat.yml` declares
  the `wire-vectors` job **and** that no other workflow file on disk declares
  one, scanning every workflow rather than only the parsed set, with mutation
  evidence for both directions. Since protection edit B that assertion guards the
  name `promote.sh` matches on a `main` commit (§7) rather than the name branch
  protection requires. The assertion pins the **name**; it is not, and must not
  be read as, evidence that the context is required.
- The wire-vector contract is therefore **required at merge time by repository
  configuration** — through `merge-gate`, which cannot report green without its
  `compat` lane — not merely fail-closed by workflow design. `OA-021` is
  complete.

**Any statement to the contrary is superseded, wherever it appears.** The two
statements that were still live in the tree — the "outstanding operational
requirement" paragraph in `docs/CI-PLATFORM-BOUNDARY.md` and the matching
`.github/workflows/compat.yml` header — **are corrected by this P0 pass** (§9,
delivered item 3). They previously instructed readers to describe a
now-required check as not required.

**Both halves of that evidence have since been observed.** A real merge box
showed the required check reporting `isRequired: true` (PR #25), and a
never-merged red probe — PR #38, exact head `33e4e3b5`, run `32660811500` — was
read at `mergeStateStatus: BLOCKED` while `merge-gate` was red, then closed
unmerged. That probe ran under the two-context set protection edit A left.

**Both of those have since been delivered and observed, so nothing here is
pending any more.** Removing compat's direct pull-request entry landed as PR #40,
head `6c4b8e3d`, whose sole `merge-gate` run `32668325620` was green 45/45 with
**no separate direct compat run** — the absence is the positive result, because
there is now exactly one compat run per pull request and the aggregate judges it.
PR #40 merged as `91768dc0`. The second red probe then ran against the shipped
sole-context protection: PR #41, head `cedec269`, aggregate run `32670589874`
red, `mergeStateStatus: BLOCKED`, protection read back `strict: true` with the
sole context `merge-gate`, closed unmerged with its refs deleted. §9 item 9
carries the lane detail.

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
- crypto vectors and key-derivation fixtures — **gated today**; `crypto-vectors.json`
  had two authors and therefore no zero-diff gate until the text-key derivation was
  folded into `gen-crypto-vectors.mjs` (2026-08-22), which made the generator its
  single author and put the fixture in `check-wire-vectors.mjs` (§1).
  `web/src/lib/text-vectors.test.ts` is not a second author: it independently
  recomputes the committed text keys through the shipped Web `crypto.ts`, which is
  the half the zero-diff gate cannot do;
- device-inbox manifest fixtures, per protocol version — **gated today** for v3
  (2026-08-22). This one is a **hybrid**, and the distinction is the point: most of
  `device-inbox-manifest-v3-vectors.json` is judgement no generator can produce —
  55 documents that must be refused and the named clause for each, the boundary
  declarations, and the accept vectors' item lists and case names — while
  `accept[].canonical`, `accept[].kind` and `accept[].total` are a pure function of
  the protocol. `web/scripts/gen-device-inbox-manifest-vectors.mjs` owns exactly
  those three fields, derives them from a hand transcription of
  `docs/protocol/relayium-device-inbox-v3.md` that imports no Go, TypeScript or
  Swift manifest code, and carries every other value through untouched — it
  derives, corrects and overwrites none of them. It does not copy bytes, though:
  it parses the fixture and reserializes all of it, so indentation, key order,
  JSON escaping and the U+2028/U+2029 pass are the generator's output form. Byte
  identity between the tracked file and a regenerated one is the **fixed point**
  of that reserialization — reached by normalizing the fixture into that form
  first (`db0864d5`) — and it is what `check-wire-vectors.mjs` measures when it
  requires the tracked bytes back unchanged. The generator's independence is
  load-bearing: one that called a shipped encoder would assert `x == x` and stay
  green through the escaping divergence these vectors exist to catch. The
  admission also widened the table's own rule from "the generator is the fixture's
  only author" to "the only author of the fields it owns", which is what the gate
  actually needs;
- **capability contract — COMPLETE; error contract — TARGET STATE.** Capability
  negotiation is generated as the `capability` block of
  `realtime-wire-vectors.json`, held to the zero-diff gate, and independently
  asserted by Web and Swift. Error contracts still have no generated fixture or
  zero-diff coverage.

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
6. **Understand what merging actually does.** Merging to `main` no longer
   deploys the central server and web — production serves the commit
   `relayium-ops/deploy/production-pin` names, so there is an explicit promotion
   step and it belongs to the operator (§7). A merged fix nobody promoted is not
   live, and during an incident that is the failure to plan for.
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

## 7. Release architecture: what merging actually does, per channel

The single most misread area of this architecture, so it is stated per channel
rather than as one sentence.

### The four delivery channels are different

| Channel | What ships it today | Is merge deploy? |
| --- | --- | --- |
| **Central server + web** | `relayium-ops/deploy/auto-deploy.sh`, run by a **5-minute cron** | **No, since the 2026-08-21 promotion-pin cutover.** The cron deploys the commit `relayium-ops/deploy/production-pin` names; a merge changes nothing until an operator promotes. See "What production serves, and how to confirm it" below. |
| **CLI / node tags** | `.github/workflows/auto-release.yml` cuts a **weekly, green-gated tag**; `release.yml` builds and signs what that tag names | **No.** Merging does not cut a tag, and a tag is a deliberate, scheduled, gate-checked act. |
| **Node fleet** | **Operator promotion, which already exists.** A fleet node moves to a new version on an operator decision, not on a merge. | **No — already solved.** This channel is the model, not the problem. |
| **Native releases** (macOS/iOS) | Their own signing, notarization, packaging and store/update-feed pipelines | **No.** No merge publishes a native artifact. |

**`auto-release.yml` is not the central deploy path.** It is a weekly green-gated
tag cutter for the CLI/node release line. Attributing the central production
deploy to it — as earlier drafts of this review did — points every promotion
conversation at the wrong repository.

### What production serves, and how to confirm it

Production serves the pinned commit. What this repository cannot answer from its
own contents is the pin's **current value**, because the mechanism and the pin
both live in `relayium-ops`. **Do not infer that from this document.** Confirm
it:

- **Ask the operator who owns production.** This is the fastest and most
  reliable answer, and the only one available to someone without ops access.
- **If you have read access to `relayium-ops`:** `deploy/production-pin` on its
  `main` names the commit the cron deploys.
- **If you have read access to the deploy log** (`operator only`): a tick logs
  `up to date (pinned <sha>)` or
  `promoting <old> -> <new> (promotion instance <ops-sha>)`.

### The gap, and how it was closed

Only the **first row** had the problem: for the central server and web there was
no separate decision between *"this code is correct"* and *"this code is now
serving users."* Every merge was therefore implicitly a production change, which
made ordinary review carry production risk it was never scoped for.

**Merge now lands code; a promotion deploys it.**
`relayium-ops/deploy/production-pin` is a committed file naming exactly one
already-merged, already-green product commit; the cron deploys that and nothing
else. Promotion is a commit to `relayium-ops` made with its `deploy/promote.sh`
from an operator workstation, which verifies the target is a full immutable SHA,
is an ancestor of `origin/main`, has a completed/successful hosted GitHub Actions
wire-vector run, and carries a deploy contract matching the copy `relayium-ops`
has vendored — all before it writes anything. Two decisions, two records.

**The cutover is delivered, and was measured rather than assumed.** It ran on
2026-08-21 under a product merge freeze, seeded with the commit production was
already serving so that the switch itself promoted nothing; the pin path was then
observed deciding on a live cron tick, with the service's process and start
timestamp unchanged across it — no build, no release swap, no restart.

The promotion gate reads that run from the **check-runs API**, so it matches the
API name `wire-vectors` — the name `compat.yml`'s permanent `push: branches:
[main]` trigger reports on a `main` commit, which is why that trigger is
permanent. Branch protection no longer requires that name: since protection edit
B the sole required context is `merge-gate`, which reaches the same contract
through its unconditional `compat` lane (§2). So the bare check run is a
promotion signal consumed here, not a pull-request gate, and
`compat / wire-vectors` is how that lane renders when the aggregate calls it, not
a second check; §3 covers why that distinction is load-bearing and what enforces
the job-name uniqueness both rely on.

> **Hard boundary, unchanged.** The promotion pointer is **ops-first**: the
> authoritative change is to `relayium-ops/deploy/auto-deploy.sh`, not to
> anything in this repository. It was designed, implemented, reviewed and
> delivered under **separate `relayium-ops` leases**
> (`docs/superpowers/specs/2026-08-21-product-promotion-pin-design.md` in that
> repository). Nothing in this document authorises a `relayium-ops`, fleet,
> deploy or production change, and no product code changed for it.

Constraints the delivered ops-side mechanism satisfies:

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

6. **Merge/deploy separation for the central server and web — COMPLETE
   (2026-08-21).** Delivered in `relayium-ops` under its own leases
   (`deploy/production-pin`, `deploy/promote.sh`, the pin gate in
   `deploy/auto-deploy.sh`), ops-first and fail-closed, and **cut over**:
   production tracks the committed pin, and merging to product `main` deploys
   nothing (§7). No product code was involved, and nothing in this repository
   changed for it beyond this document and `docs/HOTFIX-RUNBOOK.md`. What the
   cutover moved is where the risk sits: a stale or unpushed pin now means
   production stays where it is, which is the intended failure direction and
   makes the promotion step part of the incident path.
7. **Declare the `relayium-ops` ↔ product contract — COMPLETE (2026-08-23).**
   The product paths, build inputs, readiness signalling and health endpoints
   that ops depends on are now an explicit, checked interface (§1). Phase A
   published `contracts/ops-deploy-v1.json` and its product readers — PR #27
   merged as `761a7646`, with the ops consumer's row activated on `main` by the
   later merge `a98368f7`. The `relayium-ops` half then landed in serialized
   phases: the reader and roster activation, then immutable vendored provenance
   with unconditional enforcement (ops PR #5, source
   `3d3ff9c23b99134eeb0f458a33e690be6c201b44`, merged
   `d4737c8417aeea45f2b61b695b40a176988f30a1`, exact-head and exact-main hosted
   shell and contract-provenance green), then a promotion-time compatibility
   gate (ops PR #6, source `5d67842e935c5f2b77dddc061ceee381cd033001`, merged
   `f323ae41f7f21a76bce5ea99aba099a1c29d39c1`, exact-head run `32639687517` and
   exact-main run `32639778863` each passing exactly `shell` and
   `contract-provenance`). Promotion now fails closed on contract drift or
   unknowable evidence **before** any hosted-check call or pin write, and
   pre-contract commits stay promotable only within strict canonical pin
   history, which is what bounds rollback compatibility across the boundary.
   That gate work changed the operator-side preflight only: **no promotion and
   no deployment were performed as part of it.**
8. **Finish crypto and device-inbox conformance fixtures — COMPLETE
   (2026-08-22).** The crypto half: text-key derivation now happens in
   `gen-crypto-vectors.mjs`, giving `crypto-vectors.json` a single author, and the
   fixture is registered in `web/scripts/check-wire-vectors.mjs` under the same
   zero-diff gate as the realtime and stored wires. The device-inbox half: the v3
   manifest fixture is registered under that same gate on the hybrid terms
   described in §4, with `gen-device-inbox-manifest-vectors.mjs` as the sole author
   of its derived fields, and `scripts/test/native-web-pairing-gate-test.mjs` now
   pins that registration by name — in code, not in prose — so it cannot be
   dropped from the table silently. **Nothing about the device-inbox conformance
   fixtures remains open.** Capability negotiation subsequently joined the
   realtime fixture; error contracts remain the open half of item 12.
9. **Observe required-check enforcement on a real pull request** (§2).
   **CLOSED — every half is now closed by observation rather than derivation.**

   **The "shown as required" half is closed.** `ACTIVE-WORK.md` records PR #25
   merging with the then-required bare `wire-vectors` check reporting
   `isRequired: true` — a real merge box, not a settings read-back. Recorded here
   because nothing else did.

   **The "red actually blocks" half is closed too, and by observation rather
   than by derivation from the settings.** A never-merged red probe — PR #38,
   exact head `33e4e3b5`, run `32660811500` — was observed at
   `mergeStateStatus: BLOCKED` with `merge-gate` red, and was then closed
   unmerged. It ran under the two-context set protection edit A left, which
   cannot separate the aggregate's authority from the bare `wire-vectors`
   requirement — so a **second** probe was run against the shipped
   sole-`merge-gate` protection and it is what actually closes this half. PR #41,
   exact head `cedec269c3d6d3d34f69e058bf89815a553fe405`, aggregate run
   `32670589874`, conclusion `failure`: one deterministic invalid health
   `successBody` selected the `ops-contract` lane, and `ops-contract /
   go-contract`, `repo-hygiene / ops-deploy-contract-policy` and the top-level
   `merge-gate` all went red while `compat / wire-vectors` and every other
   applicable `repo-hygiene` job stayed green and the `web`, `go`, `macos`,
   `ios`, `swift-package`, `native-web-pairing` and `contracts` lanes skipped.
   GitHub reported `mergeStateStatus: BLOCKED` while protection read back
   `strict: true` with the sole context `merge-gate`; the probe was closed
   unmerged (`mergedAt: null`) and its refs and worktree deleted. The second red,
   from the always-on declarative consumer, is the designed behaviour of a
   contract with two independent readers, not an unrelated failure. Either
   observation means an intentionally red pull
   request observed at `mergeStateStatus: BLOCKED`, with the head commit's
   check-runs enumerated directly — never `statusCheckRollup`, which is
   presentation state and was once misread as "all checks successful" on a pull
   request that had a failed job, and never `gh pr checks` alone, which labels an
   in-progress job `pending 0`. It must be proved at the API level and **not** by
   attempting a merge: with `enforce_admins: false` the owner still has an
   explicit bypass, which is a separate and deliberate property of the current
   settings.

   **The aggregate-gate half is delivered, and both protection edits are
   made.** `.github/workflows/merge-gate.yml` now runs unfiltered on
   every pull request, calls each lane as a reusable workflow, and reports one
   always-present job — `merge-gate` — that enforces a two-way rule: `select`
   must have succeeded, the `needs` key set must equal a hardcoded roster
   compared in both directions, every unconditional lane must be `success`, and
   every conditional lane must be `success` when selected and `skipped` when not.
   Which lanes a change selects is read from the lanes' own `push.paths` by
   `scripts/ci/select-lanes.mjs`, cross-validated against
   `scripts/test/ci-event-policy-test.mjs` through the shared 28-row fixture
   `scripts/test/fixtures/ci-path-selection.mjs`, and fails closed to "every
   lane" on every error path.

   **What is now true: `merge-gate` is the only context `main` requires.**
   Protection edit A made the required set `{wire-vectors, merge-gate}` and
   protection edit B narrowed it to `{merge-gate}`, each written and then read
   back as `strict: true` with exactly those contexts. `compat.yml` was folded in
   as an unconditional called lane first — PR #39, head `9d6ba08c`, aggregate run
   `32665499037` — so the rename of its check never left a required context
   reported by nothing. Its direct `pull_request:` entry was then removed in
   PR #40, head `6c4b8e3d`, merged as `91768dc0`, while `push: branches: [main]`,
   `workflow_dispatch:` and `workflow_call:` stay permanently: that `push: main`
   run is the bare `wire-vectors` check `promote.sh` reads (§7), a promotion
   signal rather than a pull-request context. The staged migration is complete
   and recorded in `docs/CI-PLATFORM-BOUNDARY.md`.

   **This item is closed.** Both outstanding pieces of evidence were produced.
   PR #40's sole `merge-gate` run `32668325620` was green 45/45 with **no
   separate direct compat run** — compat now reports exactly once per pull
   request and the aggregate judges that single called lane. PR #41 then supplied
   the second red probe against the sole-`merge-gate` protection, described
   above. Nothing about required-check enforcement remains derived from a
   settings read-back.

   **One cost this creates, and it is the owner's to price rather than inherit:**
   `strict: true` plus a required aggregate means every merge to `main`
   invalidates every open pull request and forces a full re-selection, up to a
   60-minute `signed-build` and a 75-minute `ios-build`. Because GitHub evaluates
   path filters against the cumulative three-dot diff, that invalidation is
   sticky per pull request rather than per commit. It plausibly fires the merge
   queue's already-recorded revisit trigger. See `docs/CI-PLATFORM-BOUNDARY.md`.

   **Deliberately deferred, with reasons:** a `pull_request_target` gate-integrity
   workflow (required before external contributions, not before foundation
   completion — a pull request is judged by its own head copy of the gate, and
   the in-repo control-file rule stops only the accidental version of that);
   `enforce_admins: true` (it is the migration's rollback path); CODEOWNERS and
   required reviews (they deadlock a single-owner repository); and a merge queue.
10. **A one-dirty-home rule plus archive classification** for the checkouts
    counted in §1. One home per line of work; everything else is classified
    **active**, **frozen-historical** or **archivable**, and archived
    deliberately. Covers the two frozen trees in §3 — classify and archive,
    never merge.

### P2 — scale-readiness, before Android/Windows arrive

11. **Narrow the Swift dependency graph** along real seams only (§4).
12. **Build the remaining error contract fixture.** The capability half is
    complete in `realtime-wire-vectors.json`; errors are now the only open member
    of this category.
13. **Per-platform client minimum-version policy — macOS COMPLETE, other future
    platforms pending.** macOS uses a revisioned, audited server policy bounded
    to verified release metadata plus client anti-replay, cache and embedded-floor
    enforcement. A future platform must add its own explicit floor before a
    server contract can retire its fallback.
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
