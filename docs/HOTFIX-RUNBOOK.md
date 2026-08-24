# Hotfix runbook

How to ship an urgent fix **while a platform lane is paused**, without
unfreezing that lane and without disturbing a single dirty worktree.

This is the executable form of §6 of `docs/ARCHITECTURE-RESILIENCE.md`. Where
the two differ, this document is operative.

**Read §1 and §2 before typing anything.** Most of the damage available here
comes from two moves: branching a hotfix off a stale local `main`, and doing the
work inside a worktree that already holds somebody else's uncommitted change.

---

## 0. What this runbook is for, and what it is not for

**Use it when** a defect is live, reachable by users, and waiting for the normal
cadence is worse than the risk of an out-of-cadence change.

**Do not use it** to skip review, to ship a feature quickly, or to bypass any
gate in §8. A hotfix is a **narrower** change than normal work, held to the
**same or stronger** evidence. Urgency shortens the scope, never the gates.

### Severity and trigger

Classify before you branch, and write the classification into the work claim
(§2). The class decides the channel (§3) and the verification (§9), not how much
review you skip.

| Class | Trigger | Response |
| --- | --- | --- |
| **S1 — live harm** | Data loss or corruption; a privacy or security exposure; wrong billing state; the service is down or unusable for real users. | Hotfix now. |
| **S2 — live and degrading** | A core workflow is broken or failing for a substantial share of users, with no reasonable workaround. | Hotfix now. |
| **S3 — live but contained** | Real defect, narrow blast radius, an acceptable workaround exists. | Normal cadence unless it is trivially and safely fixable. |
| **S4 — not live** | Only reproducible in a branch, a preview or an unreleased build. | **Not a hotfix.** It has not reached users; fix it in the normal lane. |

**S1 involving money, entitlement, credentials or user data is still not a
waiver of anything in §8.** It raises the priority of the review, not the
question of whether one happens.

---

## 1. Branch from FETCHED, REMOTE-VERIFIED `origin/main` — never from local `main`

This is the step most often done wrong, and the one whose failure is least
visible afterwards.

A local `main` can be **behind** the remote (so the hotfix silently omits fixes
that are already merged, and possibly already promoted — and merging it can
reintroduce a bug that was already fixed), or **ahead** of it (so the hotfix is
built on commits nobody reviewed and that no gate has judged). Both produce a
plausible-looking branch and a green board.

So: fetch, verify that the base you are about to use *is* the remote head, and
record the SHA.

```sh
# 1. Update remote-tracking refs. This writes only refs/remotes/*; it changes no
#    branch, no index and no working tree, in this or any other worktree.
git fetch origin main

# 2. Read the two heads and compare them BY HAND. Do not skip this because the
#    fetch printed nothing — "Already up to date" tells you about the fetch, not
#    about your local branch.
git rev-parse origin/main   # <- the base you will use
git rev-parse main          # <- FYI only; it is allowed to differ

# 3. Record the first value. That SHA is the hotfix base and goes in the work
#    claim (§2), the review request and the checkpoint.
```

If `main` and `origin/main` differ, **that is fine and expected** — you are not
going to use the local one. Do **not** "fix" the difference by resetting,
rebasing, pulling or force-updating the local branch: local `main` may be
carrying somebody's unpushed work, and this runbook has no mandate to touch it.

Now create the hotfix worktree **from the remote SHA**, on a new branch.

**First establish the roots**, so the target path cannot depend on which
directory you happen to be standing in. Every path below is derived from them.

```sh
# Read-only: both of these only print. `--git-common-dir` resolves to the MAIN
# checkout's .git even when the current directory is a linked worktree, which is
# why it is used instead of `--show-toplevel` — run that inside a worktree and it
# answers with that worktree rather than the checkout you meant.
REPO_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
WORKTREE_ROOT="$REPO_ROOT/.worktrees"

echo "$REPO_ROOT"      # MUST be the product checkout, i.e. .../relayium/relayium
echo "$WORKTREE_ROOT"  # every hotfix tree lives directly under here
```

**Check that first line before continuing.** `.worktrees/` lives **inside** the
product checkout (`$REPO_ROOT/.worktrees`), not beside it. A relative
`../.worktrees` resolves to a different directory depending on where it is typed
— from the checkout root it lands one level **above** the repository — and that
is the ambiguity these two variables remove. If `$REPO_ROOT` is not the product
checkout, stop: you are in the wrong repository, and every command below would
be too.

```sh
git -C "$REPO_ROOT" worktree add -b hotfix/<short-slug> \
  "$WORKTREE_ROOT/hotfix-<short-slug>" <SHA-from-step-2>
```

`git worktree add` creates a **new directory and a new branch**. It does not
modify, move, clean or check out anything in any existing worktree. Every frozen
and dirty tree is untouched by construction.

> **Never** run `git reset --hard`, `git clean -fd`, `git checkout -f`,
> `git stash` or a branch-switching `git checkout`/`git switch` inside an
> existing worktree as part of a hotfix. Those are the commands that destroy
> other people's uncommitted work, and none of them is necessary here.

### One dirty home

**One line of work, one working tree, and it is the only tree that line of work
is edited in.**

- A hotfix gets a **fresh tree of its own**, created as above and deleted when it
  is delivered.
- Never author a hotfix inside a candidate, feature or frozen worktree, even if
  the file you need is already open there. Doing so entangles a production change
  with unrelated uncommitted work, and the entanglement is discovered at merge
  time, under time pressure.
- Never "borrow" a paused lane's tree because it is convenient. Paused means
  paused — see §10.
- Before starting, confirm your target directory does not already exist and is
  not registered. Both checks are read-only and safe to run at any time:

  ```sh
  git -C "$REPO_ROOT" worktree list
  [ -e "$WORKTREE_ROOT/hotfix-<short-slug>" ] && echo "EXISTS - choose another slug" || echo "free"
  ```

When the hotfix is delivered and the branch is merged, remove the tree
deliberately:

In a new shell, re-establish `REPO_ROOT` and `WORKTREE_ROOT` with the same two
lines above — the removal must name the same root the tree was created under,
not whatever `../.worktrees` resolves to from here.

```sh
git -C "$REPO_ROOT" worktree list                                 # read-only; confirm the path and that it is yours
git -C "$WORKTREE_ROOT/hotfix-<short-slug>" status --porcelain    # MUST be empty before removal
git -C "$REPO_ROOT" worktree remove "$WORKTREE_ROOT/hotfix-<short-slug>"
```

`git worktree remove` **refuses** to remove a tree with uncommitted changes
unless forced. That refusal is a safety feature. If it fires, stop and find out
what is in there — do **not** add `--force`.

---

## 2. Claim a bounded scope before editing

Before the first edit, write a **bounded work claim** into the maintainer's
work-claim register (`ACTIVE-WORK.md`, kept outside this repository). It records:

- the **severity class** and the trigger (§0);
- the **exact writable paths** — enumerated, not a glob over a directory;
- the **verified base SHA** from §1, and the worktree path;
- who is executing, under which topology and run policy;
- explicitly, that every frozen and paused tree is out of scope.

Then check the claim against every other claim that is still active. If the path
sets **overlap**, stop and reconcile ownership first; two writers in one scope is
how a fix and an unrelated change get delivered as one unreviewed commit.

A hotfix scope that cannot be enumerated is not yet understood well enough to be
hotfixed.

---

## 3. Know what your merge will actually do

**These four channels behave differently, and confusing them is what turns a
hotfix into an incident.** Read this before you decide the fix is finished.

| Channel | What ships it | Does merging to `main` deploy it? |
| --- | --- | --- |
| **Central server + web** | `relayium-ops/deploy/auto-deploy.sh`, run by a **5-minute cron** | **No — and this is the part people still get wrong.** Since the 2026-08-21 cutover the cron deploys the commit `relayium-ops/deploy/production-pin` names. Merging moves production not at all; an operator promotion does. See §3.1. |
| **CLI / node release tags** | `.github/workflows/auto-release.yml` cuts a **weekly, green-gated tag**; `release.yml` builds and signs what that tag names | **No.** Merging cuts no tag. An urgent CLI/node fix reaches users only when a tag is cut for it. |
| **Node fleet** | **Operator promotion**, which already exists — a node moves version on an operator decision | **No.** A merge changes nothing on the fleet until an operator promotes. |
| **Native macOS / iOS** | Their own signing, notarization, packaging and store/update-feed pipelines | **No.** No merge publishes a native artifact. **Server and web fixes do not justify shipping a native client.** |

### 3.1 Central production serves a committed pin, not `main`

> Merging to `main` deploys **nothing**. Central production serves exactly the
> commit named by `relayium-ops/deploy/production-pin`, and that file changes
> only when someone commits a promotion to `relayium-ops`.

That is the delivered behaviour, cut over on **2026-08-21**: the mechanism was
observed deciding on a live cron tick, and production has tracked the pin rather
than product `origin/main` since. The mechanism lives entirely in `relayium-ops`
(design: `docs/superpowers/specs/2026-08-21-product-promotion-pin-design.md` in
that repository), so nothing in this repository changes it — and nothing in this
repository can read the pin's current **value** for you, which is what an
incident actually needs.

**Confirm that value, in whichever way you have access for:**

- **Ask the operator who owns production.** Fastest, most reliable, and the only
  option if you have no ops access.
- **Read access to `relayium-ops`:** `deploy/production-pin` on its `main` names
  the commit production serves.
- **Read access to the deploy log** (operator only): a pin-aware tick logs
  `up to date (pinned <sha>)` or
  `promoting <old> -> <new> (promotion instance <ops-sha>)`.

**If you cannot confirm it, assume your fix is not live.** That is the safe
direction: expecting a deploy that has not happened costs you a check, while
believing a merged fix is serving users when the pin still names the broken
commit is how an incident gets declared over while it is still running.

> **Reading records from before the cutover.** Until 2026-08-21 this channel had
> no promotion step and merge *was* deploy, so an older checkpoint, incident note
> or review comment may describe a merge as the production change. That was true
> then and is not true now; it is not an alternative mode to check for.

Three consequences:

1. **Your hotfix is not live when it merges.** The most dangerous failure mode
   here is not a bad deploy — it is merging a fix during an S1, watching the
   board go green, and believing the incident is over while production is still
   running the broken commit. **The merge is half the job.**
2. **There is a second, explicit step, and it belongs to the operator.**
   Promotion runs from an operator workstation, not from this repository and not
   from the production host:

   ```bash
   # In a relayium-ops clone, on main:
   deploy/promote.sh <the-full-40-hex-sha-you-merged> \
     --reason "S1 <incident>: <what this fixes>"
   ```

   It refuses anything that is not a full immutable SHA, is not an ancestor of
   `origin/main`, or does not have a completed/successful hosted wire-vector
   run — the `wire-vectors` run that `compat.yml`'s permanent `push: main`
   trigger puts on that `main` commit (§5). Use `--dry-run` first if you want to
   see the decision without writing anything.
   The host converges on its next 5-minute tick; `promote.sh` performs no
   production access itself.

   If it refuses with `required check 'compat / wire-vectors' is absent`, the
   run is probably fine and `PROMOTE_REQUIRED_CHECK` is wrong. `promote.sh`
   matches the **check-runs API** name, which is the bare job id
   `wire-vectors`; the slash-joined form is how the **called** lane renders on a
   pull request, prefixed by the caller's job id, and is not what the API returns
   for the direct `push: main` run promotion reads.
   Do not reach for `--allow-unverified-checks` to get past that message —
   overriding a green gate because it was asked the wrong question puts an
   unproven commit into production during an incident.

   It also refuses on **deploy-contract drift**, before it calls any hosted
   check and before it writes the pin: the target commit's
   `contracts/ops-deploy-v1.json` must match the copy `relayium-ops` has
   vendored, and evidence it cannot read is treated as a refusal rather than as
   an absence. Commits from before that contract existed remain promotable only
   where the committed pin history proves they were once pinned — so ordinary
   rollback still works, and `--allow-unverified-checks` does **not** waive this
   gate. If it fires during an incident, the answer is a promotable commit, not
   an override.
3. **Record the promotion, not just the merge.** The merge SHA and the promotion
   commit are two different records of two different decisions. A checkpoint
   that names only the merge does not say when users actually got the fix.

**If you are not the operator, you cannot complete a central hotfix alone.** Hand
the merged SHA over explicitly and get confirmation that it was promoted — do
not treat the merge as the handoff and walk away.

---

## 4. Fix narrowly, with a reproducer

- **A failing test first.** It must fail on the base SHA from §1 and pass after
  the change. A hotfix without a reproducer is a guess, and under §3 a promotion
  is what puts that guess in front of users.
- **The reproducer is committed with the fix**, in the lane that owns the code.
  It is what stops the same defect from returning in three months.
- **Narrow the diff.** Fix the defect. Do not reformat, rename, tidy adjacent
  code, or bundle the improvement you noticed on the way past. Everything that is
  not the fix widens the blast radius of the promotion and lengthens the review
  that is standing between you and it.
- If the fix cannot be narrow, it is not a hotfix — it is a change that needs the
  normal lane.

---

## 5. Wait for every lane the change selects, through `merge-gate`

You do not choose which lanes run, and you may not merge on a subset of them.
The selector reads each lane's own `push.paths` against the whole pull request's
three-dot diff, `merge-gate` requires every selected lane to succeed, and
`merge-gate` is the sole required context on `main`. So the rule during an
incident is: **read the gate's lane/selected/result table and wait for the whole
of it.** The table below is what to expect, not a menu.

Not the full cross-platform suite either — the point of path selection is that a
paused lane is not woken to ship a server fix. But "fewer lanes than everything"
is the selector's decision, not yours.

| You changed | What that selects |
| --- | --- |
| `server/**` | the Go lane (`go.yml`) — build, vet, unit and race checks — **and `native-web-pairing.yml`, which is a `macos-15` runner**, because the acceptance starts the real hub from `server/`. Plus your reproducer |
| `web/**` | the web lane (`web.yml`) — **and `native-web-pairing.yml`**, which `vite build`s and serves the bundle |
| Wire formats or stored formats | **every** implementation, plus the wire-vector fixtures regenerated to a zero diff |
| `apps/RelayiumKit/**` (outside `Tests/`) | **both** Apple workflows, `swift-package.yml` and `native-web-pairing.yml` — it is shared, and it fans out on purpose |
| A platform root under `apps/` | that root's single heavy owner workflow, and only that one |
| Anything at all | `repo-hygiene` and `compat`, unconditionally — see below |

**A server hotfix is not a `go.yml`-only event, and treating it as one is how a
responder merges early.** `native-web-pairing.yml` names `server/**` in its
filter because the run starts the real hub, so an urgent server fix legitimately
selects a paid macOS lane that can take tens of minutes. That is the honest
price of the change set. If it is genuinely intolerable for a given incident,
the answer is a narrower diff or an owner decision recorded at the time — never
merging while a selected lane is still running, and never reading a subset of
green checks as the gate. The full ownership matrix is in
`docs/CI-PLATFORM-BOUNDARY.md`.

**The compat lane is required regardless of what you changed.** It is unfiltered
by design — no `paths:` filter on any event — and it reaches every pull request
through `merge-gate`, which calls it **unconditionally** and cannot report green
unless it succeeds; it has no direct `pull_request:` trigger of its own any more.
On `main` it still runs directly on `push: branches: [main]`, and that run is the
bare `wire-vectors` check `promote.sh` reads (§3.1) — a promotion check, not a
pull-request context. The required status check on `main` is now `merge-gate`
alone, bound to GitHub Actions `app_id` 15368. Compat is still the one gate no
change and no future platform can route around. See
`docs/CI-PLATFORM-BOUNDARY.md`.

**Where to look for the lanes above: `merge-gate`, not the lane's own name.**
Every lane in the table is now a **reusable workflow** called by
`.github/workflows/merge-gate.yml` — `compat.yml` included — and none of them has
a `pull_request:` trigger of its own any more. On a pull request you will not
find a top-level `go`, `web` or `compat` run; you will find one `merge-gate` run
whose check names are prefixed by the caller job id — `go / test`,
`macos / signed-build`, `ops-contract / go-contract`,
`compat / wire-vectors`. The aggregate's own job, `merge-gate`, prints a
lane/selected/result table and is red if any selected lane failed **or** if any
unselected lane ran. On `main` the lanes still run directly under their own
names, because every lane keeps its `push: branches: [main]` trigger — which is
also what `promote.sh` reads, and why that trigger must never be removed.

**`merge-gate` is the required context, and a red lane really does block.**
Protection edit B narrowed `main` to exactly `merge-gate`, written and then read
back as `strict: true`. That a red lane inside `merge-gate` stops a merge is an
observation twice over: the never-merged red probe PR #38 under edit A's
two-context set, and — under the configuration that actually ships — the
never-merged red probe PR #41, head `cedec269`, aggregate run `32670589874`,
read at `mergeStateStatus: BLOCKED` while protection reported the sole context
`merge-gate`. Both were closed unmerged.

**Read the gate's lane table anyway.** Not because the button is untrustworthy,
but because the table is the only place that tells you *which* lanes your change
set selected and whether every one of them is terminal. Under time pressure the
failure mode is merging while a selected lane is still in progress, and a merge
box cannot warn you about that the way the table can. `docs/CI-PLATFORM-BOUNDARY.md`
carries the completed protection migration.

Evidence must come from a **hosted run on the real trigger**. A local pass is a
useful signal, not acceptance evidence.

---

## 6. Do not weaken a gate to make a hotfix fit

Under time pressure the cheapest-looking move is to make the gate agree with you.
None of the following is permitted in a hotfix, and each is asserted
mechanically by `scripts/test/ci-event-policy-test.mjs`:

- adding a `paths:` filter to `compat.yml`, on any event;
- adding a `paths:` filter to `merge-gate.yml`, or a `push:` trigger — a required
  context that sometimes does not report blocks every pull request that does not
  select it, and routing `main` through the gate would stop the lanes from
  reporting the check runs `promote.sh` reads on the `main` commit;
- **removing a lane's `push: branches: [main]` trigger.** It looks like tidy-up
  once the gate owns pull requests. It wedges every production promotion with
  `required check absent`, mid-incident;
- widening a lane's caller condition in `merge-gate.yml` to a constant, or adding
  `failure`, `cancelled` or `true:skipped` to the aggregate's accepted results —
  the last one passes a lane that was selected and then skipped by a broken
  condition, which is exactly the fail-open shape the gate exists to close;
- adding `secrets: inherit` to any caller job;
- adding a job-level `if:`, a `continue-on-error:`, a retry, or a `|| true` to a
  gate;
- **reintroducing a commit-message escape** such as the former `[macos-only]`
  marker, which allowed a commit message to skip the iOS build. An escape hatch
  in a gate is not a gate;
- removing a job's `timeout-minutes`, or raising it to a number that is the
  6-hour default wearing a disguise;
- narrowing a path filter so a change stops reaching the workflow that would have
  caught it.

If a gate is genuinely wrong, that is its own change, with its own review — not a
line in a hotfix diff.

---

## 7. Never touch a frozen tree to make room

Frozen and paused worktrees hold uncommitted work that is **history and context,
not a delivery queue**. During a hotfix they are read-only, and they are not
rebased, cleaned, merged, reset or deleted — not even the one that "looks stale".

If you believe a frozen tree must change to deliver the hotfix, the hotfix is
scoped wrongly. Re-scope it. Archival of those trees is separate, deliberate work
under its own claim.

---

## 8. Review before merge — and the gates that urgency does not move

**Merging is deploying (§3). Everything in this section happens first.**

- **An independent review of the actual diff and the actual executable
  evidence.** Not the author's summary of them. The reviewer reads the change,
  the failure path, and the hosted run.
- **Every concrete finding is disposed explicitly** — fixed, or rejected with a
  recorded reason. A generic approval does not close a specific finding.
- **The commit message is in English**, states the defect, the fix and the
  reproducer, and does not carry any skip or escape marker.

### The three financial gates are unconditional

If the change can **charge, refund, credit, debit, renew, cancel, upgrade,
downgrade, price, tax, invoice, grant paid entitlement or revoke paid
entitlement** — or can otherwise cause a material monetary loss — it takes
**three independent gates**:

1. one named model or person is the **sole implementation author**;
2. a **second** independently reviews the complete diff and the executable
   evidence;
3. the **strongest available** performs a further independent read-only review.

Plus **at least one adversarial test** exercising a double-charge, early-grant,
stale-revoke, duplicate-refund or lost-credit path.

> **No hotfix waives these.** Not urgency, not a one-line diff, not an
> internal-only channel, not a low user count, not S1 severity, and not a
> reviewer's belief that the extra pass is unnecessary. **Hotfix status is
> explicitly not a waiver.** Only the owner may change this standing policy, and
> a one-off instruction to release is not a change to it.

A money-moving change that cannot obtain all three gates **is not shipped**,
however urgent. Mitigate another way — disable the affected path, take the
feature down — rather than shipping an ungated financial change.

> **"Shipped" means promoted, not merged.** All three gates must pass before the
> **promotion**, which is the step that actually exposes the change to customers.
> Merging a money-moving fix and promoting it later does not split the
> requirement across the two steps: the gates attach to the customer-visible
> change. `deploy/promote.sh`'s `--allow-unverified-checks` override waives the
> hosted check-evidence gate **only**, says so in the commit it writes, and
> waives none of these three.

---

## 9. Verify in production, and know your way back before you merge

**A merge is not completion. A green board is not completion.** The merge
deploys nothing (§3.1); verification starts within minutes of the **promotion**,
which is a separate step you must not skip or assume happened.

Write the rollback **before** merging. If you cannot state it, do not merge.

**Before anything below:** confirm the promotion was actually made, by reading
the `deploy/production-pin` value on `relayium-ops`'s `main` and checking it
equals the SHA you merged. A promotion that was intended, requested or promised
is not a promotion. If the pin still names the old commit, the fix is not live no
matter how green this repository looks.

**After the promotion, on the central server/web channel:**

1. **Confirm the deployed version is the SHA you merged.** Not "a newer one" —
   that exact one. Until the running version matches, the deploy has not happened
   yet and nothing below means anything.
2. **Confirm the service is healthy**, by whatever read-only health surface the
   channel provides. Read-only checks only: a hotfix is not a licence for
   production mutations.
3. **Confirm the defect is actually gone**, on the real deployed surface, using
   the reproducer from §4.
4. **Confirm nothing adjacent regressed** — error rates and the workflows nearest
   the change.
5. **Watch through at least one full cron interval** (five minutes) plus real
   traffic. A deploy that succeeded and a deploy that is *working* are different
   claims.

**If the deployed version never becomes the pinned SHA:** the host may have tried
the promotion, failed verification, and rolled itself back — in which case it
quarantines that attempt and will **not** retry it on its own. That is
deliberate, not a stuck deploy: retrying a known-broken commit every five
minutes would restart the service every five minutes. Escalate to the operator,
who can see the failure marker and the deploy log and decide between promoting a
different commit and a deliberate `deploy/promote.sh --retry`. **Do not improvise
on the host.**

**Rollback**, chosen in advance:

- **Move the pin back to a known-good older SHA.** This is the default, it is a
  first-class supported operation, and it does **not** require a revert commit on
  `main`:

  ```bash
  # In a relayium-ops clone, on main:
  deploy/promote.sh --rollback --reason "S1 <incident>: <what broke>"
  # or, naming the target explicitly:
  deploy/promote.sh --rollback --to <older-full-sha> --reason "..."
  ```

  Two things to expect. **It is usually slower than it sounds:** the host
  rebuilds the older commit from scratch, because the selective-build fast path
  keys on which paths differ, not on which direction. And **reverting on `main`
  does nothing on its own** — a revert is code that is merged but not promoted,
  so it changes production only when someone promotes it.
- **Take the affected path down**, where re-pinning is unsafe but the feature can
  be disabled.

> **Moving the pin backwards restores *code*, not *data*.** A schema or data
> migration is no more reversible by re-pinning than it is by reverting, which is
> why §11 requires expand-contract.

**Production operations, deploys and credentialed actions belong to the operator
who owns them.** If verification shows the deploy did not happen, is stuck, or
left a failed-deploy state behind, escalate to that operator rather than
intervening on the host.

**On the other channels:** a CLI/node fix is not delivered until a tag is cut and
its release build is green; a fleet fix is not delivered until an operator
promotes; a native fix is not delivered until its own release pipeline has run
every gate (sign, notarize, staple, assess) with evidence from each separately.

---

## 10. Reconcile the paused lane afterwards — later, and under its own claim

Paused work is **preserved during the hotfix, and reconciled after it**, when the
lane resumes.

- **Do not rebase, merge or update any frozen tree as part of the hotfix.** Not
  as a courtesy, not to keep it current.
- If the hotfix touched **shared protocol, `RelayiumKit`, a wire format or a
  schema**, the paused work will need a rebase. **Record that** — the hotfix SHA,
  what it changed, and which paused lane is affected — so the resuming lane finds
  a note rather than a merge conflict with no explanation.
- That reconciliation happens **when the lane resumes, under the lane's own
  claim**, by whoever owns it. It is not part of the hotfix and is not the
  hotfix author's decision to make.

**Server, web and CLI-only fixes must not block paused platform authoring, and
paused platform work must not block them.** Shared protocol, `RelayiumKit` and
schema changes are the declared exception: they are coordinated dependencies, and
a hotfix that touches them is one that knowingly creates rebase work for a paused
lane.

---

## 11. Checklist

Copy this into the work claim and close each item with evidence.

- [ ] Severity classified (S1/S2) and the trigger recorded — §0
- [ ] `git fetch origin main` run; `origin/main` SHA read and **recorded** — §1
- [ ] Hotfix worktree created **from that SHA**, on a new branch — §1
- [ ] No existing worktree reset, cleaned, stashed or switched — §1
- [ ] Bounded claim written: exact paths, base SHA, executor — §2
- [ ] No path overlap with any other active claim — §2
- [ ] **Understood that merging deploys nothing centrally** — production serves
      the pinned commit until someone promotes — §3.1
- [ ] Reproducer fails on the base SHA and passes after the fix — §4
- [ ] Diff is narrow: the fix, its test, nothing else — §4
- [ ] **Every** lane the change set selected green and **terminal** on a hosted
      run — for a `server/**` or `web/**` fix that includes the `macos-15`
      `native-web-pairing` lane, not the Go or web lane alone — §5
- [ ] `compat / wire-vectors` green — §5
- [ ] `merge-gate` green, and its lane table read: every lane the change set
      selected succeeded, every unselected lane skipped — §5
- [ ] No gate weakened, skipped, filtered or escaped — §6
- [ ] Every frozen and paused tree byte-for-byte untouched — §7
- [ ] Independent review of the **diff and evidence**; findings disposed — §8
- [ ] **If money-moving: all three gates, plus an adversarial loss-path test** — §8
- [ ] Rollback written down **before** the merge — moving the pin back to a
      named known-good SHA — §9
- [ ] The merged SHA promoted via `relayium-ops` `deploy/promote.sh`, and the
      promotion commit recorded alongside the merge SHA — §3.1
- [ ] `deploy/production-pin` on `relayium-ops` `main` read back and confirmed
      equal to the merged SHA — §9
- [ ] Deployed version confirmed equal to the merged SHA — §9
- [ ] Defect confirmed gone on the deployed surface; nothing adjacent regressed — §9
- [ ] Paused-lane rebase need recorded for the lane's own claim — §10
- [ ] Hotfix worktree removed cleanly; claim closed with the delivered SHA — §1, §2

## See also

* `docs/ARCHITECTURE-RESILIENCE.md` — §5 coordination matrix, §6 sequence, §7
  channels and the promotion pin (including "What production serves, and how to
  confirm it")
* `relayium-ops` `docs/superpowers/specs/2026-08-21-product-promotion-pin-design.md`
  — the promotion-pin design, cutover sequence and rollback semantics. Private
  repository; ask the operator if you cannot read it.
* `relayium-ops` `README.md` and `docs/DEPLOYMENT.md` — the operator-facing
  promotion, rollback and retry commands.
* `docs/CI-PLATFORM-BOUNDARY.md` — which workflow owns which platform
* `scripts/test/ci-event-policy-test.mjs` — the executable form of §6
