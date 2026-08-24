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

- The global Apple purchase pause is tested and reachable by the operator.
- Alerts cover notification verification failure, pending/unattributed
  notifications, catalog mismatch, reconciliation failure, billing incidents,
  and legacy recovery actions.
- The evidence-bound legacy recovery command is deployed before enabling the
  new version, but is never used as an automatic retry mechanism.
- Rollback keeps transaction intake, notifications, restoration, and
  reconciliation online even if new purchase dispatch is paused.
