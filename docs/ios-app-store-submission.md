# iOS App Store and TestFlight submission

This is the release operator's source of truth for Relayium's iOS App Store
record. It records verified code and local signing facts separately from App
Store Connect and production mutations that still require an explicit release
step.

Nothing in this document authorizes creating paid products, changing production
configuration, uploading a build, adding testers, submitting for review, or
releasing a version.

## App record

Relayium's iOS App Store record is **separate from the macOS one**. It has its
own Apple ID, its own bundle IDs and its own build-number sequence; nothing
about a macOS version, build number or release constrains it.

| Field | Value |
| --- | --- |
| App Store Connect name | relayium |
| Apple ID | `6791918822` |
| Bundle ID | `com.relayium.app` |
| Share extension bundle | `com.relayium.app.share` |
| Team | `7PVYUG4YQS` |

## Development baseline

| Field | Value |
| --- | --- |
| Marketing version in the project source | `0.3.0` |
| Build in the project source | `5` |

`0.3.0 (5)` is the **development baseline** of the iOS line restarted on
2026-09-01. It is what `apps/ios/Relayium.xcodeproj` builds; it is not an
uploaded build, not a TestFlight candidate and not a release.

### What the version history actually is

- `1.2.10 (2)` was a **never-delivered native candidate** from 2026-08-18 that
  deliberately synchronized the then-current macOS and iOS marketing versions.
  It was never uploaded to this record. **It is not the iOS release floor**, and
  a later iOS marketing version does not have to exceed it. App Store Connect
  requires the *build* number to increase within a record; the marketing version
  is not constrained that way.
- Historical `0.1.0` **build 4 was uploaded** to this record, after build 3 was
  rejected by a purpose-string check. Build `5` is therefore the next build
  above the highest one this record is known to have accepted.
- A local signed archive and non-uploading App Store export of historical
  build `1` passed with the intended distribution identities and profiles. The
  retained historical artifacts are:
  - archive: `/tmp/Relayium-iOS-subscriptions-e4dd73d7.xcarchive`;
  - IPA: `/tmp/Relayium-iOS-subscriptions-e4dd73d7-export/Relayium.ipa`;
  - IPA SHA-256:
    `45be4bbf6ac8f14482276804e42a624af6c9ba185159b621e403996378df8bbc`.

  These are historical acceptance evidence for a build that is several versions
  behind. They are not the `0.3.0 (5)` baseline and not permission to upload.

### A fresh App Store Connect read-back is required before any archive or upload

**Nothing in this document reports current App Store Connect state.** The last
read-only inspection recorded here was 2026-08-13, and the build history above
is reconstructed from this project's own records rather than from a current
query. Build `5` has **not** been verified against the record remotely, and the
claim that it is the next free build number is therefore a local expectation,
not an observed fact.

Before archiving or uploading, re-inspect the record read-only and confirm, at
minimum:

1. the highest build number the record has accepted for every marketing version,
   including builds in `Invalid`, `Processing` or expired-TestFlight states,
   which still consume a number;
2. that the intended `(marketing version, build)` pair is free and increases the
   build number within the record;
3. the current App Store and TestFlight status of the app.

If the read-back contradicts the baseline above, correct the project source and
this document before building — do not upload against these numbers and do not
record a remote fact this file has not observed.

## Device Inbox: what this app now does, and what it deliberately does not

`0.3.0` adds the receive half of Device Inbox. The app enrols this device with
the account, receives files and messages sent from the account's own other
devices, and shows a per-device conversation of what has been received and sent.
The five browseable surfaces are LAN Transfer, Cross-network Transfer, Send,
Device Inbox and Account. Opening a stored link is no longer one of them: it is
presented over whichever surface the user was on, reached from a verified
Universal Link or an Account stored-file row, exactly as before.

Three facts are review-relevant and must be answered truthfully rather than
inferred from the feature's name:

- **The receiver is foreground-only.** It runs while Relayium is open and stops
  when the app leaves the foreground. This is enforced in
  `InboxController.foreground(_:)`, not merely described, and the surface states
  it unconditionally (`inbox.iosForegroundOnly`).
- **No new capability was added to ship it.** The app declares no
  `UIBackgroundModes`, uses no background `URLSession`, registers for no remote
  notifications and links no notification framework. The entitlements, privacy
  manifest and purpose strings are unchanged by this feature.
- **Received files land in `Documents/Received`** — the same directory a stored
  link's download writes into, published to the Files app by the existing
  `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` keys. There is
  no folder picker and no new file-system reach. Receiving is off by default and
  is an explicit per-account consent inside the app.

None of this changes the App Privacy declaration: the message and file bodies
are end-to-end encrypted, are decrypted only on this device, and are stored
inside the app's own container. Relayium's server sees ciphertext.

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

There is no candidate yet. `0.3.0 (5)` is a development baseline, and promoting
it to a candidate requires the App Store Connect read-back above plus a new
exact-source archive and checksum. Upload only the exact candidate whose hosted
Go, Swift, iOS Release build and UI gates are green. Every hosted iOS job
selects exactly Xcode major 26 with an iphoneos SDK of at least 26 before it
compiles anything, fails closed when no such toolchain is installed, and prints
the selected versions into its own log. That keeps the runner image's default
Xcode 16.4 and any unvalidated newer preview out of the builds this checklist
depends on. It covers the toolchain only: it signs, archives and uploads
nothing, so the App Store Connect read-back above, an exact-source archive and
TestFlight build availability remain separate gates a green iOS lane does not
satisfy. France availability is
owner-confirmed. Relayium implements industry-standard encryption outside
Apple's operating system, so complete the French ANSSI declaration workflow
truthfully and attach an Apple-approved encryption declaration to this build.
Confirm in App Store Connect whether the macOS declaration can be assigned to
the separate iOS app record; do not assume cross-app reuse and do not answer
“No” merely to clear the form.

Internal TestFlight acceptance must cover:

- sign in and display of all six localized StoreKit offers;
- one Sandbox purchase and immediate Relayium plan refresh;
- restore after sign-out/sign-in or reinstall;
- renewal, expiry/refund and notification convergence;
- Manage Subscription, Privacy Policy and Terms destinations;
- the same-account cross-app guard, proving a live macOS Apple subscription
  cannot start an iOS purchase and vice versa;
- Share extension handoff, Universal Links and the primary text/file workflows
  on a real device;
- **Device Inbox, on two real devices signed in to one account**: turning
  receiving on, receiving a file and a message from the other device, the
  per-device conversation showing both directions, and sending a file and a
  message back from that conversation. Verify the received bytes appear under
  *Relayium ▸ Received* in the Files app, and compare a digest against the
  sender's;
- **the foreground-only boundary, observed rather than assumed**: send to a
  device whose Relayium is closed, confirm nothing arrives, then open the app and
  confirm it does. Confirm no notification is delivered at any point;
- **local history deletion is not a recall**: delete a conversation entry while a
  delivery to that device is still running, and confirm the delivery completes on
  the receiver while the row stays gone on the sender after relaunch;
- **the adaptive shell**: five tabs on iPhone and on a compact-width iPad
  (Slide Over and a narrow Split View), the sidebar and detail column at full
  width, and the same five destinations in both — plus a stored link opening over
  the surface the user was on and returning to it when dismissed.

Sandbox purchases do not charge real money. Do not add the build to App Review
or public release until the owner has accepted these results. Public release
must remain a separate explicit decision.
