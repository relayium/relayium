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
- Cancellation reports `userCancelled`, releases only the matching arm, and a
  second purchase can obtain a fresh arm.
- Pending, thrown, successful, lost-response, crash, restore, live-update, and
  unfinished-transaction paths finish only a server-accepted transaction.
- Duplicate and out-of-order transaction/notification delivery is idempotent.
- Refund, revoke, expiry, billing retry, grace period, renewal, upgrade,
  downgrade, cross-grade, and Production-over-Sandbox ordering converge from
  signed provider state.
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
- The evidence-bound legacy recovery command is deployed before enabling the
  new version, but is never used as an automatic retry mechanism.
- Rollback keeps transaction intake, notifications, restoration, and
  reconciliation online even if new purchase dispatch is paused. After build 23
  reaches any tester, do not roll the server back to a version that rejects
  `continuationProtocol`; pause new dispatch or roll forward instead.

## Renewal intent and current transaction authority

Apple's signed renewal information describes the upcoming renewal and may carry an `appAccountToken` different from the current transaction. Relayium therefore uses only the verified current transaction token for current account ownership.

A verified current transaction, refund, expiry, or revocation remains authoritative when optional renewal information is missing or cannot be interpreted. Valid renewal information may extend a bounded Apple-signed billing grace period or update presentation fields, but it cannot independently grant ownership. Missing renewal information never creates a zero or fabricated renewal record; a matching durable verified projection may be retained until a newer readable projection or its bounded grace expires.

Released clients remain compatible because request and response fields are unchanged. The correction is server-side and does not require a new macOS binary.
