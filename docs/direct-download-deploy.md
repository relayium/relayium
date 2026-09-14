# Direct stored downloads: current state and upgrade preconditions

**Status: fleet-direct stored downloads are withdrawn. BYO own-node direct
downloads are unchanged.** This page is the operator-facing record of what the
server does today, and of what an operator must settle *before* upgrading a
deployment that once enabled fleet-direct.

The design that introduced fleet-direct is `docs/design-decentralized-stored-downloads.md`.
It describes the intended end state; this page describes what actually ships.

## What the server does now

| Where the blob lives | Data path | Billing |
|---|---|---|
| Fleet (operator-run) storage node | **Always proxied through central**, regardless of `-direct-download` | Metered to the file owner, for the bytes central actually wrote |
| The owner's own (BYO) node, client sent `X-Relayium-Direct-Download: 1` | 302 straight to that node | **Free** — the owner's disk, the owner's bandwidth, no central egress |
| The owner's own (BYO) node, no opt-in header | Proxied through central | Metered, for the bytes central actually wrote |
| Burn / limited-download files, anywhere | Always proxied | Metered, for the bytes central actually wrote |

`-direct-download` / `RELAYIUM_DIRECT_DOWNLOAD` defaults to **off** and now
gates only the BYO own-node opt-in route above. Turning it on does not restore
fleet-direct. There is no configuration that restores it.

`POST /api/nodes/download-receipt` still exists and still authenticates exactly
as before — `401` for an unknown bearer, `403` for a BYO node token — so a node
built against the old protocol gets a definite answer rather than a routing
fault. A caller that authenticates as fleet receives a stable `410 Gone` for
every payload. The handler performs no accounting, receipt, or entitlement
write. It does still stamp the presented credential's last-used timestamp,
which is how every other node route treats a token; that is auth metadata and
moves no balance.

## Why it was withdrawn

Fleet-direct took central out of the data path, which left it unable to observe
the egress it was paying for. It compensated by charging the whole file size the
moment it answered with a redirect, and by accepting a later receipt from the
node saying how many bytes it had really served, so the difference could be
credited back. Two things were wrong with that:

- **The pre-charge billed for bytes nobody received.** A request that got the
  redirect and never followed it still cost the file's owner the full file size.
  Repeating it drained the owner's monthly traffic — and paused their shares —
  without a single byte being transferred.
- **The credit was bound to nothing.** Central kept no record of which redirects
  it had issued, and a receipt was not attributed to the node that served the
  bytes. An invented nonce was indistinguishable from a real one, so any holder
  of a fleet credential could push another account's real usage negative, without
  bound — only the per-receipt amount was capped, never the number of receipts.

Central proxying already meters the bytes it actually wrote, in the period it
wrote them, counting one download per request. Routing fleet blobs back through
it removes both defects by construction rather than by validation.

This is a reversible containment of an optional optimization, not a decision
that stored downloads must be centralized forever. See "Restoring it" below.
The cost of the containment is the one the optimization existed to avoid:
fleet-hosted downloads consume central egress again.

## Upgrading from a version that accepted receipts

There are **two separate liabilities**, and only one of them depends on the
flag. Read both before upgrading.

**A. Over-billing from issued redirects — only if the flag was on.** If
`RELAYIUM_DIRECT_DOWNLOAD=true` (or `-direct-download`) was ever set, redirects
were issued and every one of them pre-charged its file's full size, whether or
not the client followed it. If the flag was never set, no redirect was ever
issued and there is no legitimate pre-charge to reconcile.

**B. Unauthorized credits from unissued receipts — regardless of the flag.**
`POST /api/nodes/download-receipt` was mounted whenever a fleet node token was
configured, and it never consulted the flag. Any holder of a fleet credential
could post an invented nonce and drive an account's usage down. **Turning the
flag off never closed this**, so a deployment that never enabled fleet-direct
can still have been credited without authorization. Inspect for suspected
unauthorized credits either way.

Work out whether the flag was on from evidence you actually hold — deployment
history, unit files, environment files, orchestration config, configuration
management, shell history. **Do not infer it from the database.** In particular:

- **Zero rows in `download_receipts` does not prove no liability.** The table
  only ever recorded receipts that *arrived*. A redirect that was issued and
  pre-charged, whose node never sent a receipt — because it crashed, lost the
  network, or was restarted — leaves a pre-charge and no row at all. A deployment
  can hold outstanding over-charges and still show an empty table. It does not
  rule out liability B either: a forged receipt did write a row, but rows are
  pruned after 24 hours, so anything older than that has already gone.
- **Zero negative counters does not prove no liability either.** A negative
  counter is the trace of a credit that *was* applied. Over-charges that were
  never credited back leave nothing negative to find.
- **The 2-minute redirect token TTL does not bound the drain window.** It bounds
  how long a client has to *start* the download, not how long a transfer already
  in flight runs. A large file can still be streaming well after the token that
  authorized it expired.
- **Rows expire.** `download_receipts` rows are pruned after 24 hours by the
  ordinary GC (`receiptRetention` in `account/gc.go`). This change adds no purge,
  but it cannot hold that history open either. **Capture whatever receipt
  evidence you intend to rely on before normal retention removes it** — ideally
  before you stop the old binary, and in any case within 24 hours of the last
  receipt you care about.

Because of all four points, silence is not consent and an empty table is not a
release. Before upgrading:

1. **Stop issuing new legacy URLs** — set `RELAYIUM_DIRECT_DOWNLOAD=false` and
   restart, so no further redirect is signed or pre-charged. This stops
   liability A accruing. It does **not** stop liability B: while the old binary
   is still running, the receipt endpoint remains exploitable by anyone holding
   a fleet credential. Keep that path reachable only from storage nodes you
   already trust for the rest of the maintenance window, and keep the window
   short.
2. **Confirm in-flight transfers have actually ended** — observe your nodes'
   active transfers drain to zero, or stop them deliberately and record the
   bytes each had served. Elapsed time is not proof: as above, the 2-minute
   token TTL bounds when a download may *start*, not how long one already
   running may continue, and "longer than our biggest file usually takes" is the
   same reasoning in a different unit.
3. **Preserve evidence while it still exists** — snapshot `download_receipts`,
   per-user monthly download totals, and lifetime download counters, before
   upgrading and before 24-hour retention prunes rows.
4. **Reconcile from records that can actually identify an obligation.** The
   snapshot in step 3 is **preservation, not reconciliation evidence**:
   `download_receipts` holds only `(nonce, at)`, and `usage_monthly` /
   `user_stats` hold only running totals. Neither records which object a receipt
   named, how many bytes it claimed, or which pre-charge it settled, so neither
   can tell a legitimate credit from a forged one, or reconstruct what an
   account was over-billed. Use whatever issuance, access, and node-side
   transfer records you hold — web/CDN access logs showing which redirects were
   served and followed, node egress logs, node-side receipt logs — to establish
   which accounts are actually affected and by how much.
5. **Hold ambiguous liability rather than resolving it by guess.** Where the
   records cannot establish what an account is owed, leave it open and say so.
   Do not issue a refund or credit the evidence does not support: a fabricated
   correction is another unbound adjustment, which is the defect this change
   exists to remove. Once the new binary is running, a late receipt gets `410`
   and settles nothing, so every correction is a deliberate act either way.

Useful starting queries (read-only):

```sql
-- Receipts that arrived, and when. An empty result does NOT mean no liability.
SELECT COUNT(*), MIN(at), MAX(at) FROM download_receipts;

-- Credits that were applied. A negative value is always a defect trace, but it
-- cannot say which defect: a forged credit and a legitimate credit booked into
-- the wrong month look identical here.
SELECT user_id, period, download_bytes FROM usage_monthly WHERE download_bytes < 0;
SELECT user_id, downloads_total, download_bytes FROM user_stats
 WHERE downloads_total < 0 OR download_bytes < 0;

-- Fleet nodes that could have been redirect targets, including offline and
-- uninstalled ones. Not proof of issuance, but it scopes the question.
SELECT id, removed_at, last_seen_at FROM nodes
 WHERE owner_type = 'fleet' AND download_url != '';
```

**Correcting historical balances is the operator's decision, not the upgrade's.**
This release rewrites no balance, purges no receipt history, and invents no
grant. If reconciliation shows an account was over-charged, the adjustment is a
deliberate operator action taken with the evidence in hand. Under Relayium's own
governance a change that moves money requires its own review; treat a correction
on your deployment with the same seriousness.

A non-zero, unresolved liability is a reason to hold the upgrade, not a footnote
to record and move past.

## Restoring it

Fleet-direct can return, but not as it was. Because central would again be
outside the data path, restoring it requires all of:

- **Durable, bounded issued grants.** Every redirect is recorded before it is
  served — nonce, object, node, owner, amount, period, state — so a receipt has
  something to be checked against and an unissued one is recognisable as such.
- **Authenticated node ownership.** The reporting node proves it is the node the
  grant names. A shared fleet credential cannot settle another node's grant.
- **Durable retry and reconciliation.** Node-side receipts survive a crash and
  retry until acknowledged; unsettled grants are reconciled rather than being
  written off on a timer. Expiry is not evidence that nothing was transferred.
- **Atomic, idempotent, actual-byte settlement.** One transition per grant, in
  one transaction, for the bytes actually served, in the grant's own period,
  counting one download. A failed settlement is retryable and consumes no state.

Until a design meeting all four has been implemented and independently
reviewed, fleet stored downloads stay proxied. There is no target date.
