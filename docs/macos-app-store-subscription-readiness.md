# macOS App Store subscription readiness

This checklist is a release gate for a Mac App Store build that can charge a
customer. Unit tests prove Relayium's policy and ordering; Apple Sandbox and App
Store Connect prove provider behavior and configuration. Neither substitutes
for the other.

## App Store Connect blockers

- All six products belong to the one Relayium macOS subscription group.
- Service levels are ranked Max, Pro, Plus, with monthly and yearly products at
  the same level inside each tier.
- Family Sharing is off. Relayium does not grant `FAMILY_SHARED` transactions,
  and Apple does not allow Family Sharing to be disabled after it is enabled.
- App Store Promotion, offer codes, promotional offers, and win-back offers stay
  off until Relayium has an explicit account-linking design for a first purchase
  made outside the app without a server-minted `appAccountToken`.
- Production and Sandbox App Store Server Notifications V2 point to the intended
  endpoints and the send-test-notification result is observed successfully.
- Every product is cleared for sale only in supported storefronts. Mainland
  China and France remain unavailable under the standing distribution policy.
- Agreements, banking, tax, prices, localizations, review screenshot, privacy,
  Terms of Use, and review notes are complete for the version being submitted.

## Automated acceptance

- A production App Store model with no durable continuation capability refuses
  before catalog dispatch or StoreKit purchase.
- Cancellation reports `userCancelled` whether StoreKit returns
  `PurchaseResult.userCancelled` or the macOS purchase API throws the exact
  typed `StoreKitError.userCancelled`. Only those explicit Apple cancellation
  signals release the matching arm; every other thrown or unknown result stays
  locked, and a second purchase can obtain a fresh arm only after cancellation.
- Pending, thrown, successful, lost-response, crash, restore, live-update, and
  unfinished-transaction paths finish only a server-accepted transaction.
- Duplicate and out-of-order transaction/notification delivery is idempotent.
- Refund, revoke, expiry, billing retry, grace period, renewal, upgrade,
  downgrade, cross-grade, and Production-over-Sandbox ordering converge from
  signed provider state.
- Everything the store can fail at without charging anybody — the product
  lookup above all — happens BEFORE the purchase dispatch that arms a sheet.
  A lookup that throws or resolves nothing arms nothing, persists no
  continuation capability, reports no outcome, and leaves the same model able
  to buy the same product on the next attempt. Only a failure after that
  authorization is ambiguous, and only that one locks.
- One purchase attempt yields at most one attribution token. `appAccountToken`
  is attribution and not an idempotency key — Apple does not deduplicate
  purchases by it — so a repeat authorization request is refused rather than
  answered from the arm that already exists. The count that has to stay bounded
  is issued tokens, not server dispatches: a single dispatch can otherwise hand
  out two permissions to open a sheet, against one arm the app reports exactly
  one outcome for.
- StoreKit remains absent from the Developer ID target and linked only by App
  Store targets.

## Sandbox and TestFlight matrix

Use dedicated Relayium accounts that are never used for real Production
subscriptions. Record the Relayium account, Sandbox Apple Account, build,
product, expected transition, observed transaction environment, and final
server entitlement for every case.

1. Open a purchase sheet, cancel, retry the same product, and cancel again.
2. Complete Plus Monthly, terminate during settlement, relaunch, and confirm the
   unfinished transaction converges without a second charge.
3. Upgrade Plus Monthly to Pro Monthly and confirm the upgrade is immediate.
4. Change Pro Monthly to Plus Yearly and confirm Apple's scheduled behavior and
   Relayium's renewal projection agree.
5. Change a monthly product to the same tier's yearly product and back.
6. Restore on a fresh installation while signed into the original Relayium
   account, then attempt restore under a different Relayium account and confirm
   it is refused without rebinding ownership.
7. Exercise Ask to Buy pending, approval, and rejection.
8. Exercise interrupted purchase, failed renewal, billing retry, grace period,
   recovery, expiry, refund, refund reversal, and revoke.
9. Complete or renew outside the running app and confirm launch processing.
10. Confirm Manage Subscription opens Apple's interface and no Relayium UI
    claims a plan until `/api/me` reports the server-applied entitlement.

## Production readiness

- For a client/server purchase-protocol change, deploy and verify the compatible
  server before distributing the new TestFlight build. For macOS 1.3.5, confirm
  production accepts `continuationProtocol=attempt-id-v2` before enabling build
  23 for testers. An older server rejects that unknown field before arming a
  sheet, so the failure is financially safe but leaves purchase unavailable
  until the server upgrade completes.
- The global Apple purchase pause is tested and reachable by the operator.
- Alerts cover notification verification failure, pending/unattributed
  notifications, catalog mismatch, reconciliation failure, billing incidents,
  and legacy recovery actions.
- The evidence-bound Apple attempt recovery command is deployed before enabling
  the new version, but is never used as an automatic retry mechanism. A
  `locked_failed_continuation` recovery is restricted to owner-controlled
  pre-1.3.6 internal test accounts with directly observed cancellation and uses
  the separately reviewed operator runbook.
- Rollback keeps transaction intake, notifications, restoration, and
  reconciliation online even if new purchase dispatch is paused. After build 23
  reaches any tester, do not roll the server back to a version that rejects
  `continuationProtocol`; pause new dispatch or roll forward instead.

## macOS 1.3.6 historical gate and public outcome

Build 24 corrects the macOS thrown-cancellation shape and may be distributed to
internal TestFlight testers after the server and client gates pass. Before that
candidate is considered accepted, run a fixed-binary Sandbox test on a clean
Relayium account: cancel one purchase, verify the UI returns to an idle state,
then select the same product again and verify a second StoreKit sheet opens.

This acceptance passed on 2026-08-25 with the development-signed App Store build
24: Plus Monthly opened, explicit Cancel returned all subscription controls to
idle, the same Plus Monthly selection opened a second Sandbox sheet, and the
second Cancel again returned to idle. Each server outcome response was
`resumable: true`; no transaction was completed and the account remained Free.

The owner subsequently released 1.3.6 publicly on 2026-08-26. Apple's public
lookup reports it live from 2026-08-26 01:15:37 UTC. Two availability risks
survived that publication:

- **Open.** An already-locked local Keychain continuation must be able to
  reconcile an operator-resolved server attempt without broad or automatic
  capability deletion. No protocol for this is designed yet.
- **Repaired in source, unreleased (2026-08-28).** A product lookup or other
  provably pre-sheet failure must not be recorded as an ambiguous post-sheet
  failure that permanently locks the attempt. The attribution token was a
  parameter of the store seam, so it had already been minted — and a sheet
  already armed — before the adapter asked Apple whether the product exists.
  It is now minted by a callback the adapter invokes after its own product
  lookup and immediately before it charges, so every provably pre-sheet failure
  lands before the arm and no adapter-owned fallible prerequisite remains
  between authorization and the StoreKit purchase call. `Product.products`
  resolves first, the authorization callback is the next statement, and the
  charge is the one immediately after it. That path into StoreKit is not
  suspension-free on macOS — it crosses to MainActor and looks up the
  confirmation window — but neither hop can throw and a missing window falls
  back to the unbound purchase overload, so nothing on the ambiguous side of
  the arm can fail before Apple's own call does.
  StoreKit's own purchase call is deliberately fallible and stays on the
  ambiguous side: it may throw with a charge already made, so it still reports
  `failed` and still locks. **No public build carries this.** It is authored on
  `fix/apple-preflight-before-arm` and is
  unmerged, unreleased and not submitted; the App Store behavior described
  above is still what 1.3.6 through 1.3.8 ship.

The repair changes no Apple outcome vocabulary, HTTP route, server path,
catalog capability, authority rule or provider configuration: it moves *when*
the existing dispatch is requested, and nothing else.

Moving the request into a callback makes the callback itself the money boundary,
so it is bound to exactly one attempt. Each callback captures the identity of
the authorization it was minted for; the model refuses any call whose captured
identity is not the authorization currently open, and re-checks that identity
after the arm request returns. An adapter that retains a callback past its own
purchase therefore cannot be handed a later attempt's token; one that asks a
second time for an attempt already armed is refused without a token, because
returning the token it already holds would be issuing a second permission to
charge rather than merely repeating an answer; and one that abandons a callback
while its arm is still in flight receives no token at all and reports no
outcome. Reporting one would be unsound: the capability is
persisted before the initial request, so a purchase starting after the
abandoning one ends replays that exact prepared arm and the server answers both
idempotently with the same arm and token. The replaying purchase is then the
legitimate waiter and may already be opening a sheet, so an abandoned callback
that released the arm could cancel *that* sheet and let a later attempt re-arm
over a chargeable purchase. "My attempt stopped waiting" does not prove the arm
is unused. The arm is therefore left authoritative: a live replaying waiter
alone obtains the token and reports what it actually observes, and with no such
waiter the capability stays `armed`, so the next purchase refuses pending
reconciliation or the operator procedure rather than arming a second sheet.
That is an availability loss confined to an adapter that broke the callback
contract, and it is the only side of the choice that cannot spend money.
None of these properties is trusted to adapter behavior. Ambiguity itself is not
relaxed — a throw after authorization still reports `failed` and still locks,
a refused repeat request is one such throw and locks the same way, and affected
accounts still use only the evidence-gated operator procedure.
These remain availability risks, not duplicate-charge relaxations. The 1.3.7
transfer-performance release carries the already-public purchase behavior
forward unchanged; it does not treat publication as evidence that either risk
was fixed. Cancellation of the App Store credential dialog during Restore
Purchases is a separate UI-only truthfulness issue: it arms no purchase and
changes no billing state.

## macOS 1.3.8 Finder drag-and-drop release

Build 26 adds Finder drag-and-drop as an additional file-selection input on
Cross-network Transfer and the Device Inbox. **No subscription product, price,
entitlement, purchase transition, StoreKit code path or provider configuration
changes in this release**, and the subscription source was read-only for the
whole of it: a drag reaches the same `SelectionStore` the existing file pickers
write to and cannot send, choose a peer or a device, or bypass any plan,
account, size, count or sandbox gate. The already-public purchase behavior and
the ambiguous-outcome lock described above are carried forward unchanged.

The owner-deferred macOS purchase-sheet defect — Apple's sheet showing the
subscription and its price with no actionable confirmation control — is **not**
addressed by this release and remains open for a separate money-moving change
under the three-gate policy.

## macOS 1.3.7 transfer-performance release

Build 25 contains wire-neutral transfer changes only. It keeps macOS 13 as the
deployment target, preserves the encrypted transfer format, nonce and chained
hash ordering, and remains compatible with earlier released clients. Acceptance
requires a long-running large-file send and resumable stored download plus one
mixed-version transfer before public release. No subscription product, price,
entitlement, purchase transition or provider configuration changes in this
release.

## Renewal intent and current transaction authority

Apple's signed renewal information describes the upcoming renewal and may carry an `appAccountToken` different from the current transaction. Relayium therefore uses only the verified current transaction token for current account ownership.

A verified current transaction, refund, expiry, or revocation remains authoritative when optional renewal information is missing or cannot be interpreted. Valid renewal information may extend a bounded Apple-signed billing grace period or update presentation fields, but it cannot independently grant ownership. Missing renewal information never creates a zero or fabricated renewal record; a matching durable verified projection may be retained until a newer readable projection or its bounded grace expires.

Released clients remain compatible because request and response fields are unchanged. The correction is server-side and does not require a new macOS binary.
