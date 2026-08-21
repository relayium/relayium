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
that are already live, and merging it can reintroduce a bug that was already
fixed), or **ahead** of it (so the hotfix is built on commits nobody reviewed and
that no gate has judged). Both produce a plausible-looking branch and a green
board.

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
| **Central server + web** | `relayium-ops/deploy/auto-deploy.sh`, run by a **5-minute cron** tracking this repository's **`origin/main`** | **YES.** Within about five minutes of the merge, in production, with no further action and no separate promotion decision. |
| **CLI / node release tags** | `.github/workflows/auto-release.yml` cuts a **weekly, green-gated tag**; `release.yml` builds and signs what that tag names | **No.** Merging cuts no tag. An urgent CLI/node fix reaches users only when a tag is cut for it. |
| **Node fleet** | **Operator promotion**, which already exists — a node moves version on an operator decision | **No.** A merge changes nothing on the fleet until an operator promotes. |
| **Native macOS / iOS** | Their own signing, notarization, packaging and store/update-feed pipelines | **No.** No merge publishes a native artifact. **Server and web fixes do not justify shipping a native client.** |

### The current caveat, stated plainly

> For the central server and web there is **no promotion step**. **Merge is
> deploy.** The moment the hotfix branch merges to `main`, the next cron tick
> serves it to real users. There is no window in which the code is "on `main` but
> not live", and no separate decision to make between *reviewed* and *serving*.

Two consequences, both of which change how you work:

1. **Merge is the production change.** Do not merge until §8 is complete and you
   are ready for it to be live. "Merge now, decide later" does not exist on this
   channel.
2. **Time the merge.** You are choosing the deploy moment when you choose the
   merge moment. Be present and able to verify (§9) for the following minutes.

**When the promotion pointer exists** — it is designed and reviewed under a
separate `relayium-ops` lease, ops-first and fail-closed
(`docs/ARCHITECTURE-RESILIENCE.md` §7) — this step becomes a **deliberate,
separately recorded promotion**: merge lands the code, then a promotion moves the
pointer to that exact already-merged, already-green SHA. Until that lands, this
section's caveat is the truth, and this runbook must not be read as if the
promotion step already exists.

---

## 4. Fix narrowly, with a reproducer

- **A failing test first.** It must fail on the base SHA from §1 and pass after
  the change. A hotfix without a reproducer is a guess with a deploy attached,
  and under §3 the deploy is automatic.
- **The reproducer is committed with the fix**, in the lane that owns the code.
  It is what stops the same defect from returning in three months.
- **Narrow the diff.** Fix the defect. Do not reformat, rename, tidy adjacent
  code, or bundle the improvement you noticed on the way past. Everything that is
  not the fix widens the blast radius of an automatic deploy and lengthens the
  review that is standing between you and it.
- If the fix cannot be narrow, it is not a hotfix — it is a change that needs the
  normal lane.

---

## 5. Run the owning lane, plus the always-required contract gate

Run the lane that **owns the code you changed**, and the compatibility gate that
**everything** must pass. Not the full cross-platform suite: a paused lane must
not be woken to ship a server fix, and a 45-minute macOS job is not evidence
about a Go change.

| You changed | Run |
| --- | --- |
| `server/**` | the Go lane (`go.yml`) — build, vet, unit and race checks — plus your reproducer |
| `web/**` | the web lane (`web.yml`) |
| Wire formats or stored formats | **every** implementation, plus the wire-vector fixtures regenerated to a zero diff |
| `apps/RelayiumKit/**` | **both** Apple workflows — it is shared, and it fans out on purpose |
| A platform root under `apps/` | that root's single heavy owner workflow, and only that one |

**`compat / wire-vectors` is required regardless of what you changed.** It is
unfiltered by design — it runs on every pull request and every `main` push — and
it is a **required status check on `main`**, bound to GitHub Actions
`app_id` 15368. It is the one check no change and no future platform can route
around. See `docs/CI-PLATFORM-BOUNDARY.md`.

Evidence must come from a **hosted run on the real trigger**. A local pass is a
useful signal, not acceptance evidence.

---

## 6. Do not weaken a gate to make a hotfix fit

Under time pressure the cheapest-looking move is to make the gate agree with you.
None of the following is permitted in a hotfix, and each is asserted
mechanically by `scripts/test/ci-event-policy-test.mjs`:

- adding a `paths:` filter to `compat.yml`, on either event;
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

---

## 9. Verify in production, and know your way back before you merge

**A merge is not completion. A green board is not completion.** Since the merge
deploys the central server and web automatically (§3), verification starts within
minutes of it.

Write the rollback **before** merging. If you cannot state it, do not merge.

**After the merge, on the central server/web channel:**

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

**Rollback**, chosen in advance:

- **Revert the commit on `main`** — the next cron tick deploys the reverted
  state. This is the default. It is only a rollback if reverting is genuinely
  safe for the data the change touched: a schema or data migration is **not**
  reversible by reverting code, which is why §11 requires expand-contract.
- **Take the affected path down** — where reverting is unsafe but the feature can
  be disabled.
- **Once the promotion pointer exists**, rollback becomes moving the pointer back
  to a known-good **older** SHA. Note that this path also has to interact
  correctly with the deploy failure marker; that is part of the separate ops
  design, not something to improvise mid-incident.

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
- [ ] **Understood that merging deploys central server/web in ~5 minutes** — §3
- [ ] Reproducer fails on the base SHA and passes after the fix — §4
- [ ] Diff is narrow: the fix, its test, nothing else — §4
- [ ] Owning lane green on a **hosted** run — §5
- [ ] `compat / wire-vectors` green — §5
- [ ] No gate weakened, skipped, filtered or escaped — §6
- [ ] Every frozen and paused tree byte-for-byte untouched — §7
- [ ] Independent review of the **diff and evidence**; findings disposed — §8
- [ ] **If money-moving: all three gates, plus an adversarial loss-path test** — §8
- [ ] Rollback written down **before** the merge — §9
- [ ] Deployed version confirmed equal to the merged SHA — §9
- [ ] Defect confirmed gone on the deployed surface; nothing adjacent regressed — §9
- [ ] Paused-lane rebase need recorded for the lane's own claim — §10
- [ ] Hotfix worktree removed cleanly; claim closed with the delivered SHA — §1, §2

## See also

* `docs/ARCHITECTURE-RESILIENCE.md` — §5 coordination matrix, §6 sequence, §7
  channels and the future promotion pointer
* `docs/CI-PLATFORM-BOUNDARY.md` — which workflow owns which platform
* `scripts/test/ci-event-policy-test.mjs` — the executable form of §6
