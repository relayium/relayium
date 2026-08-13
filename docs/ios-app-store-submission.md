# iOS App Store and TestFlight submission

This is the release operator's source of truth for Relayium's iOS App Store
record. It records verified code and local signing facts separately from App
Store Connect and production mutations that still require an explicit release
step.

Nothing in this document authorizes creating paid products, changing production
configuration, uploading a build, adding testers, submitting for review, or
releasing a version.

## App record and candidate

| Field | Value |
| --- | --- |
| App Store Connect name | relayium |
| Apple ID | `6791918822` |
| Bundle ID | `com.relayium.app` |
| Share extension bundle | `com.relayium.app.share` |
| Team | `7PVYUG4YQS` |
| Candidate version | `1.0` |
| Candidate build | `1` |

App Store Connect was inspected read-only on 2026-08-13 and contained no iOS
TestFlight builds, so build `1` was not consumed at that time.

A local signed archive and non-uploading App Store export pass with the intended
distribution identities and profiles. The retained candidate artifacts are:

- archive: `/tmp/Relayium-iOS-subscriptions-e4dd73d7.xcarchive`;
- IPA: `/tmp/Relayium-iOS-subscriptions-e4dd73d7-export/Relayium.ipa`;
- IPA SHA-256:
  `45be4bbf6ac8f14482276804e42a624af6c9ba185159b621e403996378df8bbc`.

These artifacts are local acceptance evidence, not permission to upload. Any
shipping source or build-setting change after the archive requires a new
exact-source archive and checksum before delivery. A release-record-only edit
to this document does not change the archived product.

## Subscription activation boundary

The app owns one process-scoped StoreKit model, loads products only from the
authenticated Relayium catalog, submits Apple's signed transaction to Relayium,
and finishes it only after the server accepts the entitlement. Account exposes
purchase, restore, Apple subscription management, Privacy Policy and Terms; it
contains no web checkout. The Share extension does not link StoreKit.

The iOS App Store record and the macOS App Store record use separate bundle IDs
and subscription groups. Relayium therefore records Apple's signed bundle ID as
the subscription source scope. A live subscription can change tier in the app
that sold it, but another Relayium app is blocked from creating a second Apple
charge. A lapsed subscription may move to the other app. Migrated rows with no
known scope fail closed and self-repair from a verified same-app event.

Before uploading a TestFlight build:

1. Create the iOS subscription group and its monthly/yearly Plus, Pro and Max
   products in App Store Connect. Product identifiers must be unique to
   `com.relayium.app`; do not reuse the `com.relayium.mac.*` identifiers.
2. Add exact `(bundle ID, product ID) -> (plan, cycle)` rows to Relayium's
   `apple_products` catalog and read them back as live.
3. Add `com.relayium.app` and Apple ID `6791918822` to the production verifier's
   closed app set while retaining both signed Sandbox and Production
   environments and the existing macOS identity.
4. Configure the iOS App Store Server Notifications V2 Sandbox and Production
   URLs, then verify Apple's signed TEST notification reaches Relayium.
5. Confirm App Privacy and subscription metadata match the code and public
   policy. The app manifest declares linked Email Address, User ID and Purchase
   History for App Functionality, with no tracking.

The server must be ready before TestFlight: otherwise every signed-in Account
screen receives `unknown_bundle`, and a charged transaction cannot be accepted.

## TestFlight acceptance

Upload only the exact candidate whose hosted Go, Swift, iOS Release build and UI
gates are green. France availability is owner-confirmed. Relayium implements
industry-standard encryption outside Apple's operating system, so complete the
French ANSSI declaration workflow truthfully and attach an Apple-approved
encryption declaration to this build. Confirm in App Store Connect whether the
macOS declaration can be assigned to the separate iOS app record; do not assume
cross-app reuse and do not answer “No” merely to clear the form.

Internal TestFlight acceptance must cover:

- sign in and display of all six localized StoreKit offers;
- one Sandbox purchase and immediate Relayium plan refresh;
- restore after sign-out/sign-in or reinstall;
- renewal, expiry/refund and notification convergence;
- Manage Subscription, Privacy Policy and Terms destinations;
- the same-account cross-app guard, proving a live macOS Apple subscription
  cannot start an iOS purchase and vice versa;
- Share extension handoff, Universal Links and the primary text/file workflows
  on a real device.

Sandbox purchases do not charge real money. Do not add the build to App Review
or public release until the owner has accepted these results. Public release
must remain a separate explicit decision.
