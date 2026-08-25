# Apple purchase cancellation recovery — versioned client/server design

Status: active correction, not delivered. Codex is the sole source author under
the current ACTIVE-WORK money-moving lease. The historical server batch below
had earlier reviews, but the present cross-install and macOS 1.3.5 bytes require
fresh gates: Codex author review is complete; independent Opus and mandatory
Fable 5 acceptance are pending. No commit, deployment or TestFlight upload is
claimed by this record. Historical dispositions remain in §10 and do not accept
the current diff.

## 1. The defect

`handleApplePurchaseDispatch` permanently creates a `dispatched` attempt (and
its `apple_billing_subjects` attribution row) **before** StoreKit is invoked. A
genuine `.userCancelled` creates no transaction at all, so:

- the attempt never resolves — nothing ever arrives to resolve it;
- every later dispatch returns `409 purchase_reconciliation_required`, forever;
- restore finds no transaction, because none was ever created;
- the account is permanently unable to buy, having been charged nothing.

Apple signs transactions. Apple does **not** sign the absence of one. No
provider artifact proves a cancellation, and no provider artifact establishes a
complete pending horizon, so this design contains **no automatic time-based
expiry**. An attempt is released by evidence, never by a clock.

Three further resolution defects were found by reading the current source, and
each independently strands a dispatch forever:

| # | Site | Defect |
|---|---|---|
| R1 | `sqlite_apple_renewal.go` | `immediatePurchase` requires `ev.AppleDispatchPurchase`, which is set only when `tx.TransactionReason == "PURCHASE"`. A **restore after a renewal** carries `RENEWAL` and applies entitlement while leaving the dispatch pending forever. |
| R2 | `sqlite_apple_renewal.go` | The product is read from `ev.AppleDispatchProductID`, a field **only** the authenticated transaction handler ever sets. The notification path leaves it empty, so a delivery could never match however exactly the product agreed. (Matching the product at all is correct and is retained — see §4.) |
| R3 | `sqlite_apple_renewal.go` | The whole resolution block sits inside `if result.Applied`. A **stale or already-accounted** submission (equal or older event clock) can never resolve the attempt it belongs to. |
| R4 | `billing_apple_notification.go` | The notification path never sets the dispatch fields at all, so a **notification-first** delivery applies entitlement and leaves the dispatch pending forever. |

R1–R4 are fixed here by replacing the reason/product/`Applied` shape test with an
ownership-convergence rule (§4).

## 2. Trust boundary

Restated, because every rule below follows from it:

- `appAccountToken` is **attribution only**, never retry authority. Two devices
  signed into two different Apple IDs can both be charged under one opaque
  token, so possession of it can never re-arm a sheet.
- **Account authentication alone never re-arms an armed or ambiguous sheet.**
  After the exact current arm has durably reported `userCancelled`, the sheet no
  longer exists and no transaction can emerge from it. At that boundary only,
  an authenticated app instance may bind its own already-persisted capability
  in the same atomic transition that opens the next arm.
- The client's cancellation report is a **capability-authored assertion**, not
  signed provider proof. It is trusted only to release a dispatch the same
  capability holder armed, and never to grant, finish, or price anything.
- **Residual risk, recorded honestly:** the Apple ID behind a new arm is not
  detectable by this design. StoreKit does not expose the signed-in Apple ID,
  and no server-side artifact distinguishes it. After an explicit cancellation,
  the same Relayium account may therefore continue on another installation and
  another Apple ID. The exposure remains bounded to one arm: the takeover
  atomically invalidates the previous capability before authorizing the new
  sheet, and an armed or ambiguous sheet cannot be taken over.

## 3. The continuation capability

### Arming

An initial **new-protocol** dispatch binds, in the attempt's own row and in one
transaction with the attempt's creation:

- a **high-entropy continuation secret** — 32 bytes from `crypto/rand`. The
  server stores only `sha256(secret)` in `continuation_verifier` and returns the
  raw value **exactly once**, in the arming 200. It is never returned again, never
  echoed, never logged, and never written to any other column or table.
- the **attempt id** it belongs to,
- the **current authority generation** (`epoch`),
- an **explicit app-instance id**, supplied by the client and stored verbatim.
- an **arm identity** (`armRequestId`), supplied by the client and stored
  verbatim in `arm_request_id`. Every new-protocol dispatch must carry one —
  **the initial arm as much as a resume**.

The arm identity is what makes a later outcome report a statement about a
particular **sheet** rather than about a particular **client**. The secret, the
instance and the attempt id are all stable across resumes, so on their own they
cannot distinguish a live report from a duplicate of one issued an arm earlier.
Binding the initial arm too is not decorative: a nameless first sheet's
cancellation report could still be replayed across a later resume.

Each arm identity is **spent once, ever** — not merely once against the arm that
happens to be open. A client mints a fresh one per logical arm; re-presenting any
identity this attempt has **ever** used fails closed rather than silently arming
again. Every spent id, the initial arm's included, is recorded durably in
`apple_purchase_arm_ids`, because comparing only against the current arm lets an
id from two or more arms ago be resurrected. See *Global arm-identity non-reuse*
in §3.

A request that carries no `appInstanceId` is a **legacy request** and is a strict
one-shot client: it binds no capability and its retry still receives
`409 purchase_reconciliation_required`, byte-for-byte the old behavior. This is
the asymmetric compatibility retained for pre-continuation clients: the new
server accepts their strict one-shot requests without changing their safety.
Continuation clients from macOS 1.3.1 through the internal 1.3.4 candidate do
not send `attempt-id-v2`; after this server deploys they cannot start a fresh
purchase until upgraded to 1.3.5. That deterministic refusal occurs before a
billing authority, attempt, subject, or arm identity is created.

### Reporting the outcome

`POST /api/billing/apple/purchase-outcome` (authenticated) accepts **only** the
exact capability: same user, same bundle, same attempt, same generation, same
instance id, a secret whose SHA-256 equals the stored verifier under
`crypto/subtle.ConstantTimeCompare`, and the **`armRequestId` of the arm that is
currently open**. It records the StoreKit outcome.

The arm identity is checked in the same uniform predicate as every other
capability fact, and again as a **write-time SQL predicate** on the update, so a
resume committing between the read and the write makes the report affect zero
rows instead of the two racing on isolation behaviour. A report naming **any**
previous arm is stale by construction, moves no state, and is refused with the
same answer as a wrong secret.

- `userCancelled` → `continuation_state='cancelled'` — **resumable**.
- `pending`, `failed`, `success` → `continuation_state='locked'` — **never
  resumable**, even with a perfectly valid capability. `locked` is terminal and
  a later report can never move it back.
- **No report at all** (crash, process death, lost network) leaves `armed`,
  which is also not resumable. Silence is not a cancellation.

Every capability failure answers one uniform `403 continuation_invalid`, so the
endpoint is not an oracle for which specific fact was wrong.

### Resuming

Resume is **not** a second endpoint. It is the same `purchase-dispatch` call
carrying the capability plus a **fresh** client-generated `armRequestId`. It:

- requires the same user / bundle / attempt / generation. The existing
  instance/secret may resume directly; after explicit cancellation only, another
  instance may present a fresh secret it persisted before the request, and the
  CAS replaces the instance and verifier together with the arm;
- is a single atomic CAS from `cancelled` back to `armed` that **also replaces
  `arm_request_id` in the same statement**. From the instant it commits, every
  outcome still naming a previous arm is stale and cannot move the row. This
  atomic takeover is the correction's load-bearing step;
- **emits no fresh attempt and no fresh attribution token while the account's
  unresolved cancelled attempt still exists** — that takeover returns the same
  `attemptId` and `appAccountToken`. A device can also hold a stale local
  cancelled capability after another installation has completed and resolved
  that attempt. In that later session there is no unresolved row to resume, so
  dispatch correctly creates a replacement attempt. The response `attemptId`
  and `appAccountToken` are authoritative; the client must persist the returned
  attempt id before StoreKit opens and report the outcome against it;
- **also repoints `product_id` at the product actually being authorized**, in
  that same statement. See *Cross-product resume* below;
- **never re-returns the raw secret**; both a same-install resume and a
  cross-install takeover use a secret the client already holds, which is exactly
  what makes a lost response replayable without a second logical arm;
- **requires `continuationProtocol=attempt-id-v2` for cross-install takeover and
  for creating any fresh continuation attempt**. Earlier clients may still read
  an exact replay and resume the same unresolved attempt with the same
  capability, but they are refused before a path that can return a replacement
  attempt id they would ignore. This makes rollout order fail-safe rather than
  relying on adoption of 1.3.5. In particular, a first purchase from those
  continuation clients is refused before `AcquireBillingAuthority`, so it
  cannot leave an empty Apple authority that later blocks Stripe;
- is **idempotent for a lost resume response**: repeating the same
  `armRequestId` **with the same `productId`** reads the same success back. A
  **different** `armRequestId` against an already-armed attempt is refused with
  `409 purchase_outcome_required`, so two honest-client sheets can never be
  concurrently authorized;
- **reserves the new `armRequestId` against every id this attempt has ever
  spent**, in the same transaction and before the CAS. An id may be armed
  exactly once, ever. See *Global arm-identity non-reuse* below.

Current clients persist a fresh `continuationSecret` **before** the initial
request. Repeating the same initial arm, product, instance and secret after a
lost response is therefore an exact replay rather than a second logical arm.
The older compatibility shape that omits the secret asks the server to mint it
in the response; losing that response remains unrecoverable, and such a client
cannot perform a cross-install takeover because it has no client-held secret to
present.

Wrong secret, wrong instance, wrong or prior arm identity, cross-app, cross-user,
stale generation, resolved attempt, replayed-with-a-spent-id and a locked attempt
all **fail closed**.

#### The schedule this closes

Without the arm identity, `(attempt, instance, secret)` authenticate the caller
but not the cycle:

```
arm A            -> armed
report A cancel  -> cancelled        (a duplicate stays in flight)
resume R1        -> armed            (sheet R1 is open and MAY CHARGE)
stale A cancel   -> accepted! armed -> cancelled
resume R2        -> a SECOND sheet, concurrent with R1
```

Two concurrently authorized sheets is a double-charge path. Binding the report to
the current arm makes the stale step a uniform refusal, and `resume R2` then
correctly reports `purchase_outcome_required` instead.

#### Global arm-identity non-reuse

Binding the report to the **current** arm is necessary and was **not
sufficient**. The first implementation spent an id with `arm_request_id<>?`,
which compares against the arm that is open now and nothing else. An id from
**two or more arms ago** compares unequal, so it was accepted again — and that
re-opens the same double-sheet path over a wider history:

```
arm A = X        -> armed
report A cancel  -> cancelled        (a duplicate of A stays in flight)
resume B = Y     -> armed
report B cancel  -> cancelled
resume C = X     -> ACCEPTED (X <> current Y): sheet C is open and MAY CHARGE
stale A cancel   -> names X, which is once again CURRENT: armed -> cancelled
resume D = Z     -> a SECOND sheet, concurrent with C
```

This was initially dispositioned LOW on the reasoning that only the genuine
capability holder can drive it. That reasoning is **rejected**: `armRequestId` is
**client-generated**, so the server may not assume it is never reused, by
accident or on purpose. A financial invariant cannot rest on client hygiene.

**The correction.** Every id a new-protocol attempt has ever spent — the
**initial arm included** — is persisted in `apple_purchase_arm_ids`
`(attempt_id, user_id, arm_request_id, armed_at)` with `PRIMARY KEY
(attempt_id, arm_request_id)`. A resume may use an id only if it has **never**
appeared for that attempt.

- **The insert IS the check.** Reserving an id is an `INSERT OR IGNORE` against
  that primary key, so asking "was this ever spent?" and claiming it are one
  atomic act, in the same transaction as the `cancelled -> armed` and
  `arm_request_id` replacement. A `SELECT`-then-`INSERT` would leave a window two
  concurrent resumes could both pass. Reading the answer from `RowsAffected`
  rather than from a driver error string keeps the fail-closed path off SQLite's
  constraint-violation text.
- **Exact and unbounded for the attempt.** Deliberately not a last-N window,
  which would let the N+1th-oldest id return. Durability is a real requirement,
  not a formality: the guarantee has to survive restarts, so it is stored, not
  held in memory.
- **Refusal shape.** A reused id answers the uniform capability refusal
  (`403 continuation_invalid`) — not `500` (the request is well-formed and is
  being correctly refused) and not `purchase_outcome_required` (which would
  assert an open sheet and would single out the arm id as the interesting fact).
- **Ordering against an open sheet.** While the attempt is `armed`, any
  non-current id still answers `409 purchase_outcome_required` and the history is
  **not** consulted to reach that answer. This is deliberate and is not an
  exception to the uniform-refusal rule: in the `armed` state nothing can arm, so
  a historical id and an id the server has never seen **must** be
  indistinguishable. Answering `403` for the historical one would *add* an oracle
  that reveals whether an id was ever spent. The reuse refusal belongs to the
  `cancelled` path, which is where an arm decision is actually made.
- **Exact current-arm replay is unaffected.** The `armed` + `armMatches` replay
  returns before any reservation, so a lost response re-sent verbatim stays
  `200`, arms nothing, leaves `resume_count` unchanged and spends no new history.
- **Refusals burn nothing.** A refused resume commits no transaction, so both the
  backfill and the failed reservation roll back and the caller may retry with a
  genuinely fresh id. Under concurrent distinct fresh ids, the loser's id is
  likewise not consumed.
- **`arm_request_id<>?` is retained** in the CAS as defence in depth. It is now
  redundant for every reachable input, and it must never again be the only thing
  spending an id.

**Old/new binary compatibility.** The change is additive and rolling-safe in both
directions. `apple_purchase_arm_ids` is a **new table** created with `CREATE
TABLE IF NOT EXISTS`; an older binary neither reads nor writes it, so old and new
binaries can share one database file and can be deployed or rolled back in either
order. No existing column, index or `CHECK` is altered, and
`billing_purchase_attempts` is untouched by this correction. A row armed by a
binary that predates the table simply has no history: the resume path
**backfills that row's current `arm_request_id` before reserving the new one**,
so the invariant heals on first use instead of requiring a data migration. A
rollback to the older binary loses only the new refusal, returning that database
to exactly the behaviour it had before — it cannot corrupt the ledger, because
the history table is write-only evidence with no financial column.

**No secret or provider material.** Arm ids are opaque, bounded, printable
client-authored strings. The capability secret exists at rest only as the
SHA-256 in `continuation_verifier`, and no JWS, attribution token or subscription
identity is stored here.

**Hard purge.** The rows are `DELETE`d by `user_id`. An arm id names one StoreKit
sheet on one app install, so it is device/capability material, not evidence of a
charge: `applyAuthorizedAppleLifecycle` locates the attempt by
`user_id/epoch/provider/state` and reads only its id and `product_id`, none of
which lives here. The **financial attempt ledger and the `appAccountToken`
tombstones are preserved**, exactly as before, so a late Ask-to-Buy approval or
renewal is still attributable. That asymmetry is why the table carries **no
`REFERENCES`** to `billing_purchase_attempts` — an FK would make it impossible.
Deleting the history cannot reopen the reuse hole, because the same purge scrubs
the attempt to `continuation_state=''`, which `capabilityMatches`, `armMatches`
and the resume predicate each refuse independently; no id can be spent against
that row again.

#### Cross-product resume

A cancelled sheet is **not a promise to buy the same thing next**. The honest
path is Pro Monthly -> `.userCancelled` -> the user picks Plus Monthly and
resumes. The first implementation ignored `productId` on resume, so the attempt
kept naming the abandoned product.

That was a **money-side contract defect, not a cosmetic one**. Convergence
(section 4) is EXACT on product, so a Plus purchase against a Pro-labelled
attempt **charges and grants correctly and then never resolves**:
`/transaction` answers `409 purchase_reconciliation_required` forever, StoreKit
redelivers indefinitely, and the authority generation never advances. **A wedged
account after a real charge is strictly worse than the zero-charge deadlock this
whole design exists to remove.**

**What makes accepting a new product safe.** The handler has already gated the
exact `productId` through the catalog (`AppleProductPlan`), per-account
eligibility (`appleCatalogEligibility`) and `manage-with-Apple` *before* the
store is reached. What arrives at the resume is therefore a product this account
may currently buy. The store does not re-derive that judgement; it records it.

**Why it moves in the same statement.** `product_id` is set in the *same* CAS as
`continuation_state`, `arm_request_id` and `resume_count`. The product and the
arm identity are one fact — "this is the sheet that is open" — and any window in
which they disagree is a window in which a delayed report for the old product
could resolve the new sheet.

**The guard stays load-bearing in the other direction.** Moving the product does
**not** make the old product resolvable. A delayed verified transaction for the
abandoned product still fails the exact-product comparison, leaves the attempt
`dispatched`/`armed` on the new product, and — critically — does **not** advance
the authority epoch or intent. Advancing is what would free the account to arm a
third sheet, and a late Pro charge proves nothing about an open Plus sheet.

**Replay is bound to the product too.** Repeating the **current** arm id with the
**same** product is still the idempotent lost-response read. The same id with a
**different** product is not a replay at all — it asks to repoint a sheet that is
already open — and is refused with **`409 purchase_outcome_required`**, changing
no product, arm, history or `resume_count`.

That refusal code is a deliberate choice over the uniform capability code, on
two grounds. It is **truthful**: a sheet really is open, and the honest next step
really is to report what StoreKit did, after which a fresh id may re-arm on any
eligible product. And it **avoids an oracle**: `armed` already answers
`purchase_outcome_required` for every non-replayable shape, so answering
`403 continuation_invalid` here would let a caller learn whether an id it holds
is the CURRENT arm merely by naming a wrong product — reintroducing exactly the
leak the non-current-id answer was already chosen to avoid. It would also tell an
honest client its capability is bad, and a client that discards its capability
can never resume, re-creating the permanent deadlock. The same code is returned
whether the state is observed at read time or after losing the CAS, so which
path ran is not observable either.

**Concurrency.** Concurrent resumes or cross-install takeovers naming different
fresh ids, products and capabilities authorize **at most one** sheet; the
persisted product, app instance and verifier are the winner's request; and the
losers commit nothing, so their ids stay unspent and remain usable after the
winner's sheet is itself cancelled.

## 4. Resolution by ownership convergence

R1–R4 are fixed by deleting three conditions that proved nothing about ownership,
and by keeping the two that do.

**Kept, because both are load-bearing:**

1. the attribution token in the verified payload is the one **this** attempt
   minted (`subject.AttemptID == attemptID`). An older token bound to an earlier
   attempt must never release a newer one;
2. the delivered product **is** the dispatched product. This is the deferred
   subscription-group case: a renewal of the *current* product, or an unrelated
   subscription's renewal, proves nothing about a dispatch that may still be an
   open sheet or an Ask-to-Buy approval. Releasing on it would re-arm the account
   while a real charge is still in flight — a genuine double-charge path.

An earlier draft of this design replaced both with "any verified fact for the
same bundle". That was wrong, and the existing
`TestAppleRenewalTargetNeverResolvesAnUnprovenDeferredPurchase`,
`TestAppleUnrelatedRenewalCannotResolveDeferredPurchase`,
`TestAppleRenewalAndOldTokenCannotResolveANewerPurchaseAttempt` and
`TestAuthorizedAppleLifecycleProductMismatchAppliesFactWithoutResolvingAttempt`
caught it. Those four tests encode a real financial invariant and were **not**
weakened; they pass unchanged.

**Removed, because none of them was evidence of anything:**

- `transactionReason == "PURCHASE"`, which made a **restore after a renewal**
  (carrying `RENEWAL`) unable to resolve the dispatch it belonged to (R1);
- reading the product from `ev.AppleDispatchProductID` instead of
  `ev.BillingProductID`. Every Apple path sets `BillingProductID` from the
  verified transaction in `appleSourceEvent`, so the same question is now asked
  of a **notification-first** delivery and of an intake call (R2, R4);
- the enclosing `if result.Applied`, which meant an **already-accounted stale**
  submission or a **duplicate JWS** resolved nothing — when "there was nothing
  left to apply" is itself the evidence that this account already owns the
  subscription (R3).

Resolution remains idempotent: it is a CAS on `state='dispatched'`, so a second
arrival affects zero rows and changes nothing.

A Sandbox transaction never reaches this decision on a Production authority — the
environment guards return first — so a zero-charge test transaction can never
release a real dispatch.

**Residual.** A restore whose current product has since changed (the customer
upgraded through Apple's own UI after the dispatch) still will not resolve the
attempt, because the product no longer matches. That is the conservative
direction and is consistent with the deferred-change invariant above; the
continuation capability is what recovers the customer in that case.

## 5. Second distinct paid subscription

When a second, distinct, live Apple subscription reaches one account,
`applySourceTx` already returns `ErrAppleSubscriptionConflict` and the whole
transaction rolls back: **entitlement is unchanged and the attempt is left
unfinished**, and the endpoint answers `409 apple_subscription_conflict` so no
client may finish the transaction.

What was missing is durable evidence. A row is now written to a new
`apple_billing_incidents` table in its **own** transaction after the rollback —
the rollback is what makes a separate write necessary. It records only
non-secret facts already stored elsewhere in this schema (user id, bundle,
environment, the two subscription identities, the attempt id) and **never** a
secret, a JWS, or a raw token. Repeated deliveries increment `observations`
rather than flooding the table.

**This is not a claim that Relayium reversed or prevented Apple's charge.** It
did not. Refusing a second entitlement prevents a duplicate *Relayium
entitlement*; the customer may still have been charged by Apple, and the
incident row exists precisely so an operator can find that and act on it.

## 6. State representation — chosen, and why not the literal one

The lease describes a resumable *state*. The obvious encoding is a new
`billing_purchase_attempts.state` value such as `cancel_reported`.

**Rejected.** That column carries
`CHECK(state IN ('prepared','dispatched','resolved'))`. SQLite cannot alter a
CHECK constraint, so a new state value requires a full table rebuild — the least
rolling-deploy-compatible change available, on the one table that gates money,
and it would additionally have to preserve the partial unique index
`idx_billing_purchase_attempt_unresolved` that enforces one unresolved attempt
per generation.

**Chosen instead:** `state` keeps its exact current vocabulary and meaning, and
the continuation lifecycle lives in a new additive column `continuation_state`
(`''` legacy / `armed` / `cancelled` / `locked`). Consequences:

- every existing query, index and CHECK is untouched, so the migration is pure
  `ALTER TABLE ... ADD COLUMN` with defaults and is rolling-deploy safe in both
  directions;
- an attempt is `dispatched` for its whole unresolved life, so the partial
  unique index still enforces one unresolved attempt per generation — including
  across a resume, which creates no row;
- `''` is exactly the legacy client, so strict one-shot behavior is the
  *default* rather than something the new code must remember to apply.

The invariants are unchanged; only their encoding is. This is the deviation the
lease's "safer simpler representation" clause anticipates.

## 7. Rejected alternatives

1. **Re-arm from account identity + the same `appAccountToken`** (Fable's first
   proposal, withdrawn after Codex's challenge). Two devices on two different
   Apple IDs share one opaque attribution token, so this hands charge authority
   to a device that never held it.
2. **A 24/48-hour automatic expiry of a pending attempt.** No authoritative
   Apple documentation or provider evidence establishes a complete pending
   horizon — Ask-to-Buy and billing retry can exceed any figure guessed here.
   An ambiguous attempt stays fail-closed.
3. **Rotating the continuation secret on every resume.** It would make a lost
   resume response unrecoverable, forcing exactly the second logical arm this
   design exists to prevent.
4. **Comparing the verifier in SQL** (`WHERE continuation_verifier = ?`). Not
   constant-time, and it turns the row lookup itself into an oracle. The row is
   read by attempt id and user id; the verifier is compared in Go.
5. **Resolving the attempt on any verified fact for the same bundle.** Written,
   tested, and rejected on the evidence. Resolution also advances the authority
   generation, which re-arms the account for a *new* dispatch, so a rule this
   broad releases a dispatch that may still be an open sheet or a pending
   Ask-to-Buy approval — a double-charge path. Resolution is tied to the
   attempt's own attribution token **and** its own product (§4).
6. **A separate resume endpoint.** A second endpoint would have to re-derive
   every dispatch precondition (purchases-enabled, catalog, eligibility,
   manage-with-Apple) or silently skip them. Resuming through the existing
   dispatch call keeps one gate.
7. **Binding the outcome to the capability alone** — the original shape, and the
   defect Codex found. `(attempt, instance, secret)` are stable across every
   resume, so they identify a client but never a cycle; a duplicate cancellation
   from an earlier arm authenticates perfectly and re-opens a second sheet. The
   arm identity was added precisely because no subset of the capability can
   answer *which sheet*.
8. **A server-minted arm identity returned at arming.** It would be correct, but
   it makes the identity part of the response that can be lost — a client that
   loses the arming 200 could then neither resume nor report. A client-generated
   id is already known to the client before the request, so a lost response
   costs it nothing it did not already have.
9. **Expiring an arm identity, or releasing an arm after a timeout.** Rejected
   for the same reason as alternative 2: nothing here may be released by a clock.
   A stale arm is refused because a *newer arm exists*, which is evidence, not
   because time passed.
10. **Overloading `appAccountToken` or the app-instance id as the arm identity.**
   Both are deliberately stable for the life of the attempt — the token is the
   attribution subject late Apple facts resolve against, and the instance id is
   what the capability binds to. Making either change per arm would break
   attribution recovery and the capability binding respectively.
11. **Spending an arm identity by comparison against the current arm only**
   (`arm_request_id<>?`) — the shipped shape of the first correction, and the
   blocking defect Codex found after Fable dispositioned it LOW/APPROVE. It
   refuses a replay of the current id and nothing else, so an id from two or more
   arms ago is accepted again and the double-sheet path returns over a wider
   history (§3, *Global arm-identity non-reuse*). The LOW disposition rested on
   only the genuine capability holder being able to drive it; that is not a
   mitigation, because the id is client-generated and the server may not assume
   a client never reuses one, accidentally or maliciously.
12. **A bounded last-N window of recent arm identities**, or an in-memory set.
   Cheaper, and wrong in both directions: a window lets the N+1th-oldest id
   return, and an in-memory set loses the guarantee at every restart — which is
   exactly when a delayed duplicate report is most likely still in flight.
   Non-reuse has to be exact, per attempt, and durable, so it is a persisted
   primary key. The cost is bounded by arms per attempt, which the protocol
   already bounds by requiring an explicit cancellation before each one.
13. **A foreign key from the arm-id history to `billing_purchase_attempts`.**
   It would look tidier and would make the required purge asymmetry impossible:
   the attempt ledger and its tombstones survive a hard purge on purpose, while
   the arm history is device-capability material that must be deleted by it.

## 8. Residual risks

Recorded honestly rather than designed away, each with what would make it
actionable.

1. **Apple-ID switch across arms.** StoreKit does not expose the signed-in Apple
   ID and no server-side artifact distinguishes it. After an exact cancellation,
   the next arm may be opened on the same or another installation under another
   Apple ID. It is bounded to one sheet because takeover is permitted only from
   `cancelled` and atomically invalidates the previous capability; it cannot
   create a second concurrent authority. Revisit if Apple ever exposes
   a signed account-identity fact.

2. **A Sandbox transaction can resolve a dispatch on an environment-unbound
   legacy authority.** Reachable only when `billing_authorities.apple_environment`
   is still `''` while `subscription_sources` already holds a Production row — a
   pre-environment-column account. Considered and accepted: the transaction
   carries that dispatch's own freshly minted token, so the dispatch's sheet
   *did* produce a Sandbox transaction and no Production charge is in flight from
   it. Revisit if production evidence shows a Sandbox transaction releasing a
   dispatch that later produced a Production charge.

3. **A restore whose product has since changed does not resolve the attempt.**
   If the customer upgraded through Apple's own UI after the dispatch, the
   product no longer matches and the attempt stays pending. This is the
   deliberate conservative direction (§4); the continuation capability is the
   recovery path. Revisit if support sees this shape in the field.

4. **`SourceEvent.AppleDispatchPurchase` and `.AppleDispatchProductID` are now
   written by nothing and read by nothing.** They remain declared because
   `entitlement.go` is outside this lease's writable scope. Follow-up: remove
   both fields in a lease that may write it.

5. **No client can present a capability yet.** This batch is server-only. Until
   macOS `1.3.1` ships the client half, the recovery path exists but is
   unreachable by real users, and **the currently stuck production account is not
   repaired by this change** — that remains a separate, owner-audited operation
   requiring provider evidence.

6. **A lost INITIAL dispatch response is unrecoverable only for the older
   server-minted-secret compatibility shape.** Current clients persist their own
   secret before dispatch and replay the initial request exactly. A client that
   omitted the secret and never received the response holds no capability, so
   its account keeps one unresolved attempt until an Apple fact resolves it or
   an operator does. The server never re-issues that secret and nothing is
   released by a clock; there is **no TTL and no automatic expiry** anywhere in
   this design. Revisit only with an artifact that proves
   device identity independently of the secret, never by widening who may resume.

7. **The read-time and write-time arm checks absorb each other.** The outcome
   path enforces the arm identity twice — once as `armMatches` in the uniform
   capability predicate, once as an `arm_request_id=?` predicate on the update.
   Removing **both** breaks the adversarial schedule immediately; removing
   **either one alone** is not observable in any schedule the test harness can
   produce, because the survivor refuses first. Both are kept deliberately: the
   read-time check keeps the uniform-refusal answer in one place, and the
   write-time predicate closes the read-then-write window regardless of SQLite
   journal mode or isolation. Recorded so a later reader does not delete one as
   dead code on the strength of a green suite. The same is true of the two
   emptiness guards inside `armMatches`, and of the store-side shape check on
   `armRequestId` in the outcome path, which `armMatches` absorbs.

   **Mutation controls, run and recorded.** Four guards were individually
   disabled and the suite re-run:

   | mutation | detector |
   |---|---|
   | resume-path reservation refusal (`!fresh`) removed | `TestAnArmIdentityFromAnyEarlierArmCanNeverBeReused` — reuse of X returns 200 |
   | initial-arm reservation removed | same test — history is empty after the initial arm |
   | rolling-upgrade backfill removed | `TestAnAttemptArmedBeforeTheHistoryExistedHealsOnFirstResume` |
   | hard-purge `DELETE` removed | `TestHardPurgeRemovesTheArmIdentityHistoryAndKeepsTheLedger` |

   Two of those detectors had to be **added after the first mutation run
   found nothing**, which is the substantive finding of this exercise. The
   resume backfill writes the attempt's current arm id, so it **masks** a
   missing initial-arm reservation in every end-to-end schedule, and
   conversely no end-to-end schedule can produce the pre-history row the
   backfill exists for. Each guard hid the other. They are now pinned by direct
   **state** assertions on `apple_purchase_arm_ids` rather than by behaviour
   alone; a purely behavioural suite cannot tell these two apart.

   **Extended by the global-non-reuse correction.** The resume path now has a
   third layer: the durable reservation, which is the only one that refuses an id
   from *two or more* arms ago, and which is therefore **fully observable** —
   deleting the `reserveAppleArmIDTx` call in `resumeAppleAttemptTx` makes
   `TestAnArmIdentityFromAnyEarlierArmCanNeverBeReused` fail, and
   `TestDeletingTheArmHistoryGuardReopensTheDoubleSheetPath` bypasses that guard
   at the database to demonstrate the money-loss schedule it holds shut. The CAS
   predicate `arm_request_id<>?` has, by contrast, become **unobservable**:
   the reservation refuses the current id first, so deleting the predicate alone
   fails no test. It is kept for the same reason as the pair above, and with a
   sharper warning — it was once the *only* thing spending an id, and that is
   precisely how the two-arms-ago hole existed. It must never be load-bearing
   again, and it must not be deleted as dead code on the strength of a green
   suite.

8. **Incident evidence is removed by hard account purge.** The row is
   user-attributed, so it goes with `subscription_sources` to avoid orphaning a
   purged account's billing identity. The operational log line written when the
   incident is recorded survives, and the `apple_billing_subjects` tombstones
   still quarantine late Apple facts. Revisit if an operator ever needs the
   structured row after a purge.

9. **BLOCKING FOR THE CLIENT, NOT FOR THIS SERVER BATCH: `permitsFinish`
   redelivers forever on a resolved-but-unapplied acceptance.** Raised by the
   Fable 5 third-gate review.

   `AppleSubmission.permitsFinish`
   (`apps/RelayiumKit/Sources/RelayiumAppKit/AppleSubscriptionModel.swift`)
   currently reads:

   ```swift
   return result.applied && (!result.dispatchPending || result.dispatchResolved)
   ```

   §4 deliberately resolves the dispatch **outside** the `result.Applied`
   branch, because "there was nothing left to apply" is itself the evidence that
   this account already owns the subscription. For a stale or already-accounted
   verified fact the server therefore now answers the exact triplet

   ```
   applied=false, dispatchPending=false, dispatchResolved=true
   ```

   — **all three fields**, not merely `applied=false, dispatchResolved=true`.
   `dispatchPending` is `false`, not `true`, because `sqlite_apple_renewal.go`
   sets `result.PurchaseAttemptPending = false` inside the same `resolveAttempt`
   block that sets `PurchaseAttemptResolved = true`, and
   `billing_apple_transaction.go` maps that pair straight onto the wire fields.
   The `dispatchPending=true, dispatchResolved=true` combination is theoretical
   and is never produced by this path, so a client fix verified only against it
   would not be verified against production. Against the real answer the current
   client's `applied` conjunct is false, so it never finishes the transaction and
   StoreKit redelivers it **indefinitely**.

   **Why this is not a server-first deployment blocker.** Existing shipped
   clients *already* do not finish these same stale accepted facts: before this
   change `applied=false` produced `permitsFinish == false` on its own, and
   `dispatchResolved` could not rescue it. The server change strictly improves
   the observable state by resolving the dispatch, and it introduces no new
   redelivery that was not already happening. Deploying the server ahead of the
   client is therefore safe.

   **It is nevertheless MANDATORY before the new continuation protocol is
   exposed in macOS `1.3.1`.** Once a client can arm, cancel and resume, this
   shape stops being a rare stale-fact edge and becomes an ordinary outcome of
   the recovery path the release exists to ship. Shipping the protocol without
   the client fix would hand users a permanently redelivering transaction.

   The requirement, its status and its release gate are recorded as a live
   requirement in the workspace `DECISION-LOG.md`
   (2026-08-22, Fable third-gate correction). **No Swift was changed in this
   lease** — the server lease had no writable client path, and the fix belongs
   with the rest of the client half.

10. **Hard purge scrubs continuation material but deliberately retains the
    attempt's `user_id`.** `ArchiveAndPurgeUser` now clears
    `continuation_verifier`, `app_instance_id`, `arm_request_id`,
    `client_outcome`, `outcome_at` and `resume_count`, sets
    `continuation_state` to the empty legacy value, and **deletes the account's
    `apple_purchase_arm_ids` rows outright** — that table holds only capability
    material, so unlike the attempt row it has no financial column to preserve. The rest of the row —
    `state`, `product_id`, `epoch`, `apple_account_token` and `user_id` — is
    financial evidence and stays: a late Ask-to-Buy approval or renewal is
    resolved against exactly those columns (§4), and deleting them would not
    make the late fact disappear, only make it unattributable, which is the
    failure the `apple_billing_subjects` tombstones exist to prevent.

    So a hard-purged account still leaves one row carrying its former user id.
    That is the same deliberate trade the tombstones already make, and it is
    narrower: no device identity, no capability, no client-reported outcome
    survives. The empty continuation state is the fail-closed choice and not
    merely the schema default — `capabilityMatches` requires a non-empty app
    instance id **and** a 32-byte verifier, `armMatches` requires a non-empty
    stored arm id, and the resume predicate matches only `armed`/`cancelled`, so
    a scrubbed row is refused by each of those independently rather than by the
    state column alone. Revisit if the retention model ever requires the
    financial ledger to be anonymized rather than merely scrubbed; that needs a
    replacement attribution key for late Apple facts, and is a separate design.

11. **The concurrency test's `cancelled` branch is not currently reachable, and
    is not the detector for its own defect.** In
    `TestResumeRacingAStaleReportNeverAuthorizesTwoSheets` the invariant was
    tightened after the Fable review — `cancelled` must retain arm A and `armed`
    must carry `arm-R1`, where the loose form previously tolerated
    `cancelled` + `arm-R1`, which is precisely the defect end state.

    Measured rather than assumed: over 72 instrumented iterations the race
    resolved to `armed`/`arm-R1` **72 times and to `cancelled` zero times**. The
    resume performs strictly more work than the outcome report, so the report
    effectively always commits first. Putting the defect back (removing both arm
    guards) therefore does **not** fail this test in either the loose or the
    tightened form. The real detectors are deterministic and do fail:
    `TestStaleCancellationFromAPreviousArmCannotOpenASecondSheet`,
    `TestOutcomeRefusesEveryNonCurrentArmIdentityUniformly` and
    `TestStoreOutcomeRequiresTheCurrentArmIdentity`. The tightening is kept
    because an assertion that documents the defect end state as acceptable is
    wrong regardless of whether it currently fires; it is recorded here so no
    later reader treats this race test as the arm-binding guard's proof. Forcing
    the resume to lose deliberately would need a fault seam that exists only for
    the test, which §7's reasoning rejects. Revisit if a non-invasive way to
    order the two commits appears.

12. **The arm-id history grows one row per arm, and nothing but a hard purge
    removes it.** New with the global-non-reuse correction. Each row is bounded
    (`armRequestId` is capped at 128 printable bytes) and each additional row
    costs a client a full authenticated dispatch *and* an explicit
    `.userCancelled` report, so this is not a cheap amplification — but it is
    unbounded per attempt, and it is the first per-account storage in this design
    that a client can grow deliberately. Before the correction an arm/cancel loop
    only incremented `resume_count` and wrote no rows. Deliberately **not**
    bounded by a window or a TTL here: a last-N window would let the N+1th-oldest
    id return, and expiry would release an arm by clock, both of which are the
    defect this closes. Revisit with a per-attempt arm ceiling or dispatch rate
    limit — either of which is a refusal, not an expiry — if telemetry ever shows
    an account accumulating arms rather than converging.

    The rows are deliberately **not** touched by `PurgeTransientUserData`, which
    already touches no billing table: an account inside the deletion grace window
    can still be reactivated, and it must come back with its unresolved attempt
    and that attempt's non-reuse guarantee intact.

13. **After a cross-product resume, a genuine charge for the ABANDONED product no
    longer resolves the attempt.** New with the cross-product correction, and it
    is the correct behaviour rather than a regression: the attempt now names the
    sheet that is actually open, so a late Pro transaction after a resume to Plus
    grants Pro entitlement and leaves the Plus dispatch unresolved, which parks
    the account on `409 purchase_reconciliation_required` until the Plus sheet is
    itself reported or delivered. That state means what it says — the customer may
    genuinely have two charges in flight across two products — and releasing the
    dispatch on the old product would free the account to arm a third sheet while
    the second could still charge. Before the correction the same schedule
    resolved on the *wrong* product and silently stranded the *real* purchase, so
    this trades a silent mis-resolution for an honest, operator-visible conflict.
    Revisit only with a reconciliation path that inspects both products, never by
    relaxing the exact-product comparison.

14. **The unresolved-attempt lookup in `ArmAppleBillingPurchase` is not filtered
    by provider.** Carried, not introduced, by this correction; raised as Fable
    L-5. `SELECT ... FROM billing_purchase_attempts WHERE user_id=? AND epoch=?
    AND state IN ('prepared','dispatched')` omits `provider=?`, unlike the
    convergence lookup in `applyAuthorizedAppleLifecycle`, which includes it. It
    is currently unreachable — a billing authority binds one account to one
    provider for a generation, so no Stripe attempt can share an Apple
    authority's epoch — and every downstream guard (`external_scope`,
    `continuation_state`, `capabilityMatches`) refuses a foreign row anyway.
    **Deliberately deferred**: adding the predicate is a one-token change to a
    money-gating query that this correction's tests do not exercise, and it
    belongs in a lease that can prove it in isolation. Revisit if an account is
    ever allowed two concurrent provider authorities.

15. **A stolen Relayium bearer can park a cancelled attempt at `armed`.** The
    attacker must already control the authenticated account session; after an
    explicit cancellation it can take over with a valid fresh secret and then
    remain silent. This moves no money and grants no entitlement, but prevents
    later purchase dispatches until an authoritative StoreKit fact or outcome
    resolves the arm. Revisit with a session-bound reauthentication requirement
    if production abuse evidence appears; never release it by timeout.

16. **Cancellation takeover deliberately stops proving continuity with the old
    device capability.** In `cancelled`, the safety fact is the exact current-arm
    `.userCancelled` report: no transaction and no sheet remain. A new
    installation may therefore replace the old instance/verifier with any fresh,
    valid client-held secret. `armed`, silence, pending, failed, success, locked,
    legacy and stale-arm states retain the strict old capability check.

17. **A dishonest or buggy cancellation report widens the affected Apple-ID
    set.** The protocol trusts the native StoreKit `.userCancelled` outcome. A
    forged cancellation already allowed the same installation to obtain another
    sheet; cross-install takeover could let a second Apple ID obtain it. The
    server still authorizes at most one sheet at a time and refuses a second
    Relayium entitlement, but cannot reverse a second Apple charge. Revisit only
    if provider evidence exposes an Apple-signed cancellation fact.

18. **A stale local capability can receive a replacement attempt.** After
    another installation resolves the original, a later dispatch has no
    unresolved row to resume and creates a new financial identity. macOS 1.3.3
    and the internal 1.3.4 candidate ignored the response `attemptId`, reported
    the new sheet against the resolved old attempt, and left the replacement
    permanently armed. macOS 1.3.5 adopts and persists every authoritative
    dispatch id before opening StoreKit. The server also requires its
    `attempt-id-v2` marker before takeover or fresh continuation creation, so an
    older installed client is refused before it can create that terminal state.
    The regression test reports a cancellation against a deliberately changed
    id; reverting the adoption recreates the account-wide lockout.

19. **An honest second installation can be dispossessed after takeover.** If B
    takes over A's cancelled attempt and then disappears without reporting an
    outcome, the server correctly stays `armed`; neither A nor another device
    may infer that B's sheet cannot charge. This has the same zero-charge
    availability shape as residual 15 without requiring a stolen bearer. It is
    intentionally not released by time. Revisit only with an authoritative
    StoreKit outcome or provider fact, not another client assertion.

20. **A lost cancellation response can be followed by another installation's
    takeover.** A then owes a replay for an arm that B has atomically replaced.
    The server's uniform `403 continuation_invalid` is definitive proof that
    A's exact arm is no longer authoritative. macOS 1.3.5 retires that local
    capability only when its persisted bytes still match the rejected report,
    clears the matching non-secret outcome journal, and permits a fresh bounded
    planning pass. Network failures and changed local capabilities remain owed
    and fail closed; no timeout or inferred cancellation is introduced. If the
    outcome existed only in the journal because its Keychain write failed, the
    stored capability may differ solely by the absent outcome field; that exact
    shape is also retired after the 403, while any different stored outcome or
    any other changed byte remains owed.

21. **An old-client dispatch can race deletion of its existing authority.** The
    handler's preflight refusal is intentionally fail-closed when no authority
    exists. If it observes an authority and an operator or account-deletion path
    removes that row before acquisition, the old request can recreate an empty
    Apple authority before the store-level protocol fence refuses its arm. This
    requires a 1.3.1-through-internal-1.3.4 client racing an administrative
    mutation on the same account, moves no money, and is recoverable through the
    existing evidence-bound operator tooling. Do not weaken the store fence to
    avoid it; revisit with an atomic acquire-and-arm API if the race is observed.

22. **Local capability validation and a server 403 share the public
    `continuationRejected` error.** A persisted compatibility capability with no
    raw secret can fail locally before an outcome request reaches the server.
    The retirement guard still requires the exact persisted arm and recorded
    outcome, so this cannot widen purchase authority or erase a changed value;
    such a capability cannot authenticate an outcome in any case. A future
    client may split local-unavailable from server-rejected errors for sharper
    diagnostics without changing the protocol.

## 9. Out of scope for this batch

No phase-2 Apple-to-Stripe authority release. No direct or manual mutation of a
stuck production account, no clearing of purchase ledgers, and no provider-side
subscription mutation. This correction includes the narrowly required macOS
1.3.5 client adoption of an authoritative replacement `attemptId`; unrelated
macOS and Sign in with Apple work remains outside the batch. The client fix is
in shared RelayiumKit and will therefore be present in the next iOS candidate,
but iOS development and versioning remain paused; no iOS release is produced by
this batch.

Deployment may precede client adoption without creating a double-charge path or
durable billing identity. The explicit availability tradeoff is that macOS
1.3.1 through the internal 1.3.4 candidate cannot initiate a new Apple purchase
after the server deploys; they receive a deterministic capability refusal and
must upgrade to 1.3.5. Exact replay and same-capability resume of an already
existing attempt remain supported.

## 10. Review dispositions

Historical Fable findings on the earlier server batch, with their dispositions.
Numbered §10 rather than inserted before *Out of scope* so existing §9
references remain valid. These dispositions do not accept the current
cross-install/client diff.

- **F-1 — FIXED.** Closed by two halves that are jointly, not individually,
  sufficient: the **atomic product update** (the `cancelled -> armed` CAS
  repoints `product_id` in the same statement as the arm-identity replacement,
  `resume_count` and the outcome reset, leaving no window in which the open sheet
  and the recorded product disagree) and **product-bound replay** (a replay must
  match the product as well as the arm). Each half has its own mutation control:
  removing the product update fails the convergence test; removing the replay
  product match fails the mismatch test.

- **L-1 — SUPERSEDED BY CLIENT-PERSISTED SECRETS.** The earlier server-minted
  shape made only resume responses replayable. Current clients persist a secret
  before the initial request, so both initial and resume responses are exact
  replays. The compatibility shape that omits the secret remains unrecoverable
  if its first response is lost. See residual 6.

- **L-2 — LOW, ACCEPTED as intentional fail-closed behaviour. No source change.**
  *Finding:* the legacy `/transaction` response contract changed from
  `200 applied=false` to `409` when an unapplied, unconverged fact still has an
  unresolved attempt. *Disposition:* deliberate, not accidental. **Existing
  clients have no behavioural regression**, because `AppleSubmission.permitsFinish`
  already requires `applied=true` — both the old and the new response are
  *unfinished/reconciling*, so a conforming client takes the same branch under
  either, and the `409` additionally refuses to look successful to anything that
  reads only the status line. Recorded here so a later reader does not mistake
  the contract change for an accidental regression and "restore" the `200`.

- **L-3 — NIT, ACCEPTED. No source change.** *Finding:*
  `recordAppleSecondSubscriptionIncident` reads `existing_external_id` after
  explicitly rolling back the outer transaction and before writing the incident
  in its own transaction, leaving a tiny race in which that evidence field may
  reflect a newer source. *Disposition:* the race is real and bounded to
  **diagnostic incident evidence** — `existing_external_id` feeds no entitlement,
  authority, attempt, charge or refusal decision, so a value read a moment later
  cannot move money or change access. The structure producing the race is
  **load-bearing**: the explicit rollback *before* opening the incident's own
  transaction is what avoids self-deadlock under `MaxOpenConns(1)`, and holding
  the outer transaction open to freeze the snapshot would deadlock the writer
  against itself. **Revisit** if production incident evidence shows an
  inconsistent `existing_external_id`, or if operator reconciliation requires a
  transactionally frozen snapshot.

- **L-4 — NIT, ACCEPTED; the claim wording is CONFIRMED already correct. No
  source change.** *Finding:* repository-wide `gofmt` reports pre-existing drift
  in `account/p2_fixes_test.go`, `relayaddr_test.go` and `turn_dedup_test.go`.
  *Disposition:* every `gofmt` claim for this batch is scoped to
  **touched/diff files**, never to the repository, in this record, the workspace
  logs and each lease close-out. The three files are **untouched committed
  files** — none appears in this batch's 8 modified + 3 untracked paths — so
  reformatting them would smuggle an unrelated change into a money-moving diff.
  They stay out of scope. Confirmed rather than corrected: no record claimed
  repository-wide cleanliness.

- **L-5 — DEFERRED, recorded as residual 14** with its existing revisit trigger
  (an account ever allowed two concurrent provider authorities). Unchanged.

**The deliberate `409` departure — accepted by Codex.** For "current arm id,
different product" this design answers `409 purchase_outcome_required` rather
than the briefed `403 continuation_invalid`. **Codex accepts it**: every
non-replayable request made while a sheet is armed receives the same
outcome-required answer, so the endpoint stays **non-oracular** — a caller learns
nothing about whether the id it named is current, historical or never seen —
while the request **mutates nothing**. Fable's final review must still inspect
this; Codex's acceptance is gate 2.
