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
  notifications and links no notification framework. The entitlements and the
  privacy manifest are unchanged by this feature. One purpose string has since
  been added to the app — `NSLocalNetworkUsageDescription` — but it belongs to
  the peer-to-peer transfer lanes rather than to Device Inbox; see *Local
  Network access* below.
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

## Local Network access: a resolved functional prerequisite

**Status: declared in source; physical revalidation on iOS/iPadOS 26 is still
outstanding.** This is a functional and review-relevant prerequisite, not a
blocker of the same class as the camera item below — the declaration exists, and
what remains is observing it work on a device.

### What is declared, and why it is owed

`apps/ios/Relayium/Info.plist` declares `NSLocalNetworkUsageDescription`,
localized in the app bundle's own `en.lproj/InfoPlist.strings` and
`zh-Hans.lproj/InfoPlist.strings`. The English text in `Info.plist` is the
fallback and is identical to the English catalog.

The requirement comes from the transfer, not from device discovery, and the
distinction matters for both App Review answers and support copy:

- **Discovery is a server question.** The nearby roster comes from Relayium's
  own code-less rendezvous room over the same HTTPS/WebSocket origin as the rest
  of the app, grouped by the public address the server observes. There is no
  Bonjour, no mDNS and no subnet scan. `NSBonjourServices`, the multicast
  entitlement and the wifi-info entitlement are therefore absent and stay
  absent.
- **The transfer is not.** Every realtime lane builds its peer connection with
  `iceTransportPolicy = .all`, so between two devices on one network the
  selected candidate pair is routinely a unicast socket to the peer's address on
  that subnet. iOS 14 and later gate that behind Local Network access, and iOS
  grants it only to an app that has declared why it wants it:
  <https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy>

### Why the omission was a silent failure rather than a smaller permission set

Retained physical runs `0af36138` and `56e78dbf` recorded both faces of the
previous state, in which the key was absent:

- on **iOS/iPadOS 26** the system withheld the permission prompt entirely and
  the local path simply never connected — no alert, no actionable error;
- on **iPadOS 18** the omission was masked and the same build appeared correct.

A build that passes on an older OS is therefore not evidence for this item.

### The copy, and the bound on it

The purpose string describes files and messages going directly to the device the
user selected. It deliberately does **not** claim that Relayium scans, browses
or lists the network, because it does not, and it uses no transport vocabulary
(`WebRTC`, `ICE`, `STUN`) in a sentence a person has to act on. If the copy is
revised, keep both bounds: an overclaiming purpose string is its own review
risk, and `IOSLocalNetworkPermissionTests` enforces the wording bounds,
the two-language coverage and the fallback match.

### Physical revalidation gate — outstanding

No automated test may accept a system privacy alert, and none does. The
following must be observed by hand on a **physical iOS/iPadOS 26 device**, on
the exact candidate, before that candidate is treated as functionally complete:

1. On a device that has not already granted this app Local Network access, the
   first eligible transfer attempt to a selected nearby device presents the
   Local Network prompt, and the alert renders the app's own sentence. Reach
   that state by using a device where the permission has not yet been decided —
   **do not** uninstall or reinstall the app, clear its data, reset privacy
   settings, sign out, or change any device setting to force the prompt. If
   every available device has already decided the permission, record that and
   leave this item outstanding rather than mutating device or account state.
2. Allowing it completes a real file transfer and a real text transfer between
   two devices on the same network.
3. Denying it at that prompt degrades honestly rather than hanging: the user is
   told the transfer could not reach the device, and the app remains usable.
   Denial at the prompt is the observation this item requires; revoking the
   permission afterwards in *Settings ▸ Privacy & Security ▸ Local Network* is an
   optional extra check at the owner's discretion, not a prerequisite.
4. The prompt is presented in Simplified Chinese on a device set to that
   language, with the translated sentence.
5. The same build is re-checked on an iPadOS 18 device only as a
   non-regression; a pass there is not evidence for items 1–4.

Record the run tag and outcome here when it is done. Until then this record
claims the declaration is correct **in source only**.

### Review-facing answers

- The app requires Local Network access to transfer to a device on the same
  network; it is requested at the first such transfer, not at launch.
- It is not used for discovery, advertising, or enumerating other hosts.
- Refusing it does not disable the app's account and cloud surfaces. Sign-in,
  the Account and plan screens, and creating, uploading to and downloading from
  a stored link all run over ordinary HTTPS to Relayium's servers and never
  address the local network, so they are unaffected by a denial.
- **Not claimed here:** what the peer-to-peer surfaces do after a denial. Nearby,
  pairing-code cross-network transfer and Device Inbox all build the same
  realtime lane, so their behaviour depends on whether that lane can settle on a
  relayed candidate. `RealtimeConnectionFactory` does select
  `iceTransportPolicy = .relay` for a cross-network code room once TURN
  credentials are present, and a relayed pair would not need local-network
  access — but that fallback has **not** been observed after an actual denial.
  It is a separate observation owed by item 3 of the physical gate above, not an
  answer this record may give yet.

## Protected-resource declaration: an open upload blocker

**Status: open, unresolved in `0.3.0 (5)`.** Nothing below is a fix, and no fix
may be improvised at upload time.

Apple's protected-resource guidance is explicit that App Review rejects an app
whose *code* references a protected API without the matching purpose string,
and that an API reached through a third-party SDK counts as the app's own:
<https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources>

What this project actually contains, verified locally on 2026-09-02:

- `apps/ios/Relayium/Info.plist` and `apps/ios/RelayiumShare/Info.plist` declare
  **no** `NSCameraUsageDescription`. The app plist's only purpose string is
  `NSLocalNetworkUsageDescription`, and its two `InfoPlist.strings` catalogs
  declare that key alone;
  `IOSLocalNetworkPermissionTests.testNoCameraPurposeStringHasAppearedWhileThatBlockerIsStillOpen`
  fails if a camera string appears in any of the four files before this blocker
  is resolved.
- No product Swift source implements a camera feature. The app uses WebRTC
  **data channels only** — no capture, no call, no QR scanner.
- The built app nevertheless embeds
  `Relayium.app/Frameworks/WebRTC.framework/WebRTC`, whose undefined-symbol
  table references the camera-capture classes `AVCaptureSession`,
  `AVCaptureDeviceInput`, `AVCaptureVideoDataOutput`,
  `AVCaptureDeviceDiscoverySession`, `AVCaptureVideoPreviewLayer` and
  `AVCaptureDeviceRotationCoordinator`, plus capture constants such as
  `AVCaptureDeviceTypeBuiltInWideAngleCamera`. The app's own binary references
  none of them. Verified on the latest retained physical run,
  `.relayium-device-inbox/671dc604/dd/Build/Products/Debug-iphoneos/Relayium.app`:

  ```sh
  nm -u "<Relayium.app>/Frameworks/WebRTC.framework/WebRTC" \
    | grep -E 'AVCapture'
  ```

  That artifact is a **Debug** device build. The same check has since been run
  against an **unsigned local Release** generic-device build of `0.3.0` (Xcode
  26.6, `iphoneos26.5`, `CODE_SIGNING_ALLOWED=NO`) and reports the **same 15
  undefined `AVCapture*` symbols**, so the condition is not a Debug artifact.
  That build is neither signed nor archived and was not retained, so this record
  still does **not** claim it is byte-identical to a release candidate. Re-run
  the command above against the signed release candidate before upload and
  record the result; treat the blocker as present until that recheck says
  otherwise.

- This is not a hypothetical. **`0.1.0` build 3 was rejected by exactly this
  check for a missing `NSCameraUsageDescription`**, and build 4 replaced it. The
  same static condition is present again in the current source.

**Scope: this blocker is about the camera only.** The same framework also
references `AVAudioSession` symbols, but audio-session linkage alone does not
establish that `NSMicrophoneUsageDescription` is required — an app may
configure a session category without ever requesting record permission. That
observation is **not conclusive** and is deliberately excluded from the claim
above. If a microphone purpose string is ever asserted to be owed, establish it
from Apple's own validation or review output, not from symbol linkage.

**Do not add a purpose string the product cannot justify.** A string describing
a camera feature Relayium does not have is a false statement to Apple and to
the user, and it would contradict both the App Privacy answers and the shipped
binary. Only two resolutions are honest, and each requires its own approved
product/dependency batch outside this document's authority:

1. **Make the reference real.** Re-author an actual camera feature the product
   wants — a pairing-code/QR scanner is the plausible one — and ship a truthful
   `NSCameraUsageDescription`, localized in English and Simplified Chinese,
   describing that specific use.
2. **Remove the reference.** Ship a WebRTC binary that contains no
   media-capture APIs — a data-channel-only build or an equivalently scoped
   dependency — so no purpose string is owed.

**First-upload readback trigger.** The first candidate upload is the first
place this record can observe Apple's own verdict. Read that upload's
validation output and any App Review message *for this issue specifically*,
before triaging anything else, and record the exact wording here. A silent pass
is also a result worth recording — but it does not retire the requirement,
because this record has already failed the check once.

## App Store metadata and App Review information

This section is the maintained **draft source** for the external fields. It
reports no current App Store Connect state: this document has observed none of
these fields, and the read-back rule above applies to them exactly as it does
to build numbers. Reconcile every value against a live read-only inspection at
submission time.

Apple's authoritative list of required and editable properties:
<https://developer.apple.com/help/app-store-connect/reference/app-information/required-localizable-and-editable-properties>

### Localization scope

Maintain exactly **English (primary) and Simplified Chinese**. That is the
shipped `CFBundleLocalizations` set and the workspace's supported-language
policy. Adding a storefront locale the app does not speak advertises support
that does not exist.

### Fields to draft before submission

| Field | What the draft must be based on |
| --- | --- |
| App name, subtitle | The shipped product, not an aspiration. The record's name is `relayium`. |
| Promotional text, description, keywords | Only behavior `0.3.0` actually ships. The *Device Inbox* section above is the authority on its limits. |
| Support URL (required), Marketing URL | Public `https://relayium.com` pages only, and the URL must resolve at submission. The site builds `/support/` (English) and `/zh/support/`; confirm the exact address in the deployed site rather than from this list. |
| Privacy Policy URL | `https://relayium.com/privacy/` — the exact URL Account opens (`AppEnvironment.privacyWebURL`). Terms are `https://relayium.com/terms/`. |
| Primary category | The bundle declares `public.app-category.utilities`; keep the storefront category consistent with it. |
| Copyright, version, What's New | The version is **this record's** `0.3.0`; a macOS version never sets it. |

**Honesty constraints on the copy.** Do not describe background receiving, push
notifications or automatic sync — the receiver is foreground-only and the app
registers for no notifications. Do not describe Relayium as a backup service.
Do not put prices in the description; the storefront renders the real StoreKit
prices, and a hard-coded one goes stale or wrong per storefront.

### Age rating

Required before submission; answer the questionnaire truthfully rather than
defaulting every question to "none":
<https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating/>

Relayium transports arbitrary user-supplied content between a user's own
devices and through user-shared links. Whether that constitutes user-generated
content for Apple's purposes is a real answer the owner must give, together
with the moderation reality — Relayium's server sees ciphertext and cannot
inspect content — not a convenient one.

### App Privacy

A privacy policy URL and complete data-practice answers are required:
<https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/>

The answers must match the binary. The built app's merged privacy manifest
declares **linked Email Address, User ID and Purchase History, all for App
Functionality, with tracking false and no tracking domains**. Message and file
bodies are end-to-end encrypted and decrypted only on the device; the server
sees ciphertext. If an App Privacy answer and the manifest ever disagree, one
of them is wrong — fix the disagreement, do not pick the easier form.

### App Review information

Field reference:
<https://developer.apple.com/documentation/appstoreconnectapi/app-store-review-details>

These are owner-only values. **Never write them into this file, the repository,
a screenshot, a log or a commit message.** The placeholders stay; the owner
enters the real values directly in App Store Connect.

| Field | Value |
| --- | --- |
| Contact first name, last name, phone, email | `<owner-provided at submission>` |
| Sign-in required | **Yes.** Account, subscriptions and Device Inbox are all account-gated. |
| Demo account username, password | `<owner-provided review-only account>` — created for review, not a personal account |
| Notes | The reviewer-facing text drafted below |

The notes must state, in plain language:

- **A demo account is required**, and which surfaces it unlocks.
- **Device Inbox needs two devices signed in to the same account.** With one
  device a reviewer can enrol it and see the empty state, but cannot observe a
  delivery. Say this explicitly, or the surface reads as broken. Offer a
  review-only attachment showing the two-device flow (see *Screenshots*).
- **Receiving is foreground-only.** Relayium must be open on the receiving
  device; nothing arrives while it is backgrounded, and **no notification is
  delivered at any point**. This is shipped behavior, not a defect.
- **Receiving is off by default** and is an explicit per-account opt-in inside
  the app.
- Where received files land: *Files ▸ On My iPhone ▸ Relayium ▸ Received*.
- Subscriptions are sold through StoreKit and validated by Relayium's server; a
  Sandbox account is not charged.

### TestFlight test information

Distributing to external testers requires a beta app description and a beta
feedback email before the build can go out:
<https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information>

- **Beta app description:** what this build is, plus the same foreground-only,
  no-notification and account-gated statements as above. A tester who does not
  know the receiver is foreground-only will file it as a bug.
- **What to Test:** the exact surfaces this build changes. For a `0.3.0`
  candidate that is Device Inbox across two devices, the five-destination shell
  on iPhone and on compact- and full-width iPad, and the subscription screens.
  "Test the app" is not an acceptable handoff — the same rule the workspace
  applies to owner candidates.
- **Beta feedback email:** `<owner-provided>`; not recorded here.

## Screenshots

Specifications and upload rules:

- <https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/>
- <https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots>

This record targets iPhone **and** iPad, so both sets are required.

| Set | Accepted portrait sizes, pixels |
| --- | --- |
| iPhone 6.9" — the highest-resolution iPhone size | `1320 × 2868`, `1290 × 2796`, or `1260 × 2736` |
| iPad 13" | `2064 × 2752` or `2048 × 2732` |

Hard rules:

- **One to ten** screenshots per set, per localization.
- **No alpha channel.** Flatten before upload; an alpha channel is rejected.
- The pixel size must be exactly one of the accepted values above.

Capture discipline:

- **Capture only from a signed release-candidate build** — the same exact build
  that will be uploaded. The UI-test fixtures in
  `apps/ios/Relayium/UITestSubscriptions.swift` are compiled `#if DEBUG` and
  invent display prices such as `US$4.99`, so a Debug capture can put a price
  Apple never sold into a public storefront asset. **Never screenshot a
  `--relayium-ui-testing` launch**, and never retouch a real screen into one.
- **Real StoreKit products at real prices**, loaded from the authenticated
  Relayium catalog. That means the subscription products in the *Subscription
  activation boundary* section must exist first; a subscription screen showing
  an empty or fixture offer list is not shippable metadata.
- **Stage neutral content rather than redacting afterwards.** Nothing sensitive
  or ephemeral may reach a public asset: the account email address, device
  names, pairing codes, share links or their `#k=` fragments, IP addresses,
  server hostnames, real file names, or any notification content.

Suggested shot list — each must show what the app really does, in both sets and
both localizations:

1. **Device Inbox** — a per-device conversation with both directions visible.
2. **Device Inbox, foreground-only** — the surface stating that limit, so the
   storefront tells the truth before install rather than after.
3. **Send** — choosing content for one of the account's own devices.
4. **LAN Transfer** — a local transfer in progress.
5. **Cross-network Transfer** — the encrypted cross-network path.
6. **Account** — sign-in state and the real subscription offers.

Keep the two asset channels separate:

- **Storefront screenshots** are public marketing assets, per localization, and
  everything above applies to them.
- **App Review attachments** are private to the review, optional, and never
  appear on the storefront. They are the right place to demonstrate a
  two-device Device Inbox delivery a single-device reviewer cannot reproduce.
  They do not satisfy the storefront requirement.

## France availability and the ANSSI encryption declaration

France availability is owner-confirmed, and Relayium implements
industry-standard encryption outside Apple's operating system, so the French
declaration workflow applies and must be completed truthfully rather than
answered away.

The part of it that reaches this repository is the outcome. If the approved
declaration comes with an Apple compliance code, that code belongs in
`apps/ios/Relayium/Info.plist` — and in `apps/ios/RelayiumShare/Info.plist` if
it applies to the extension — alongside `ITSAppUsesNonExemptEncryption`, as
`ITSEncryptionExportComplianceCode`.

Those plists are guarded on purpose.
`IOSDistributionSigningTests.testNeitherBundleDeclaresExportCompliance`
(`apps/RelayiumKit/Tests/RelayiumKitTests/IOSDistributionSigningTests.swift`)
asserts that **neither** bundle declares `ITSAppUsesNonExemptEncryption`, so
that a legal statement is made once per upload by a human in App Store Connect
instead of silently by a build setting. Adding the key will fail that test —
by design, not by accident.

Handoff, only once the owner holds an approved declaration:

1. It is a **separately leased batch**. Plist, entitlement and Xcode project
   paths are not writable under the current Device Inbox lease.
2. That batch changes both sides in one delivery: the plist keys **and** the
   guard. Its replacement must assert the exact approved values, not merely
   drop the assertion.
3. Record the approval reference and the resulting keys here.
4. Do not answer the export-compliance question "No" to clear the form, and do
   not assume the macOS record's declaration transfers to this separate iOS
   record — confirm that in App Store Connect first.

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
- **Local Network access, on a physical iOS/iPadOS 26 device**: the five checks
  under *Local Network access* above, run on a device that has not already
  granted this app Local Network access — without uninstalling, clearing app
  data, resetting privacy settings or signing out to force the prompt. An
  iPadOS 18 pass does not satisfy this item — that OS masked the omission the
  declaration fixes;
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

The two-device items above have physical harnesses; run them rather than
improvising an equivalent by hand:

| Harness | Evidence root |
| --- | --- |
| `scripts/ios-device-pair-acceptance.sh` | `.relayium-device-pair/<run-tag>/` |
| `scripts/ios-device-inbox-acceptance.sh` | `.relayium-device-inbox/<run-tag>/` |

Both keep their run directory whatever the outcome, because a pass is evidence
too. Each run therefore leaves build and per-device logs, `.xcresult` bundles
and a DerivedData tree, and the roots reach multiple gigabytes. They are
intentional local physical evidence, are ignored at the repository root by
`.gitignore`, and must not be committed or cleaned as though they were build
scratch. Cite the exact run tag when reporting a physical result.

Sandbox purchases do not charge real money. Do not add the build to App Review
or public release until the owner has accepted these results. Public release
must remain a separate explicit decision.
