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

## Building the candidate: `scripts/ios-app-store-candidate.sh`

The archive, the App Store export, the checksum and the built-candidate
readbacks this document requires are one command.
`scripts/ios-app-store-candidate.sh` performs them in order, refuses before
`xcodebuild archive` when any precondition is unmet, and writes every artifact
and log under one directory it creates.

**It does not upload, and it reserves no build number.** It runs no `altool`,
no `notarytool`, no Transporter and no App Store Connect API call; its export
is `destination = export`, not `upload`. It solicits, stores and transmits no
App Store Connect credential — no API key, no issuer ID, no app-specific
password, no session — and takes no option that would carry one.

It does read the keychain, and saying otherwise would be false: `xcodebuild`
and `codesign` sign the archive and the export with the Apple Distribution
identity and private key already installed in the operator's login keychain,
and macOS may prompt for access to it. That is a local read of an
identity the operator already holds, performed by Apple's own tools on this
machine. It is not a provider credential this script holds, and signing locally
mutates nothing in the developer account: `-allowProvisioningUpdates` is absent,
so no profile or device registration is created or modified either.

The boundary, precisely: nothing about running this script makes a build number
unavailable, causes anything to appear in App Store Connect, or reaches a
tester. Uploading the artifact it produces is a separate step under a separate
authorization, and this document authorizes neither.

It also never deletes: the artifact root must not already exist, so no path an
operator names is written into, emptied or removed by any outcome — including a
failure, which preserves everything it had produced up to that point.

### The App Store Connect read-back is an attested input, not a checkbox

The script cannot see App Store Connect and does not pretend to. The operator
performs the read-only inspection described above and then **attests** to it in
three values the script cross-checks against each other and against the project:

| Option | What it must be |
| --- | --- |
| `--marketing-version` | the marketing version observed for the candidate |
| `--readback-highest-build` | the highest build number the record shows **consumed**, in any state — including `Invalid`, `Processing` and expired TestFlight builds |
| `--build` | the next free build, which must equal `--readback-highest-build` + 1 |
| `--readback-observed-at` | the UTC instant of that inspection, `YYYY-MM-DDTHH:MM:SSZ` |

**These are an operator attestation plus a consistency check — not proof that
the read-back happened.** Nothing local observes App Store Connect, so somebody
who guesses a highest build and adds one satisfies the cross-check exactly as
well as somebody who read the record. Do not read a passing run as evidence that
the record was inspected.

What the shape does buy is worth having, and it is a different thing: the claim
has to be stated as a specific number rather than ticked, it is recorded in the
manifest as the operator's claim, and an off-by-one, a transposition or a number
carried over from the last candidate is caught here instead of at upload. Both
numbers must be canonical decimal — `--build` as `[1-9][0-9]*` and
`--readback-highest-build` as `0` or `[1-9][0-9]*` — so a leading zero is
refused with exit `2` rather than being read as octal. The cross-check itself
compares decimal strings and computes `highest + 1` one digit at a time, never
with shell arithmetic: `$(( ))` is fixed-width and wraps silently, so a
canonical but very long build number would otherwise compare equal to its
remainder modulo 2^64. There is no length limit to keep in step with Apple's.
The timestamp must be in the past and no more than 12 hours old, so a read-back
from a previous working day cannot authorize today's build number.
Only the operator's own discipline puts a real observation behind any of it.

Both numbers must additionally equal what `apps/ios/Relayium.xcodeproj` already
declares for **both** the app and the Share extension. The script never edits
the project and sets `manageAppVersionAndBuildNumber` to `false`, so the export
cannot renumber the build either. If the read-back says the project's build is
already consumed, bump the project in its own reviewed change first — that is a
source edit with a diff, not something a build script does on the way past.

### Usage

```sh
scripts/ios-app-store-candidate.sh \
  --marketing-version 0.3.0 \
  --build 5 \
  --readback-highest-build 4 \
  --readback-observed-at 2026-09-02T11:30:00Z \
  --artifact-root ~/relayium-candidates/ios-0.3.0-5-<short8-sha>
```

The values above match the baseline this document records — project `0.3.0 (5)`,
with build `4` the highest this record is known to have accepted. **They are an
example of the shape, not a licence to skip the read-back**: supply what the
record actually shows on the day.

The artifact root must be absolute, must not already exist, must sit outside
this repository and at least two levels deep, must not be a system or home
directory, and its name must end with `-<short8 sha>` of the commit being
built. Keeping candidates under the private workspace
`test-builds/ios/<version>-<short-sha>/` satisfies all of that.

Beyond the read-back, the script refuses to archive unless:

- the selected Xcode is exactly major 26 and the iphoneos SDK is 26 or newer —
  Apple's current upload floor, checked separately because what Apple validates
  is the SDK the binary was linked against;
- the worktree is clean, `HEAD` is a commit, the branch has an upstream, and
  `HEAD` equals it — a candidate names a commit somebody else can fetch;
- both targets declare team `7PVYUG4YQS`, bundle IDs `com.relayium.app` and
  `com.relayium.app.share`, `CODE_SIGN_STYLE = Manual` for Release, and the
  exact profiles `Relayium iOS App Store` and
  `Relayium Share Extension App Store`.

`-allowProvisioningUpdates` is deliberately absent and must stay absent: it
authorizes Xcode to create or modify provisioning profiles in the developer
account, which is a provider mutation. A missing or expired profile is meant to
be a failed archive an operator investigates.

Exit status distinguishes the three outcomes: `2` a refused precondition
(nothing was built), `3` a failed archive or export (logs preserved), `4` a
candidate that built but failed verification (everything preserved).

### What it leaves behind

Under the artifact root:

| Path | What it is |
| --- | --- |
| `ExportOptions.plist` | generated for this run — `destination = export`, `method = app-store-connect`, team `7PVYUG4YQS`, manual signing, both bundle-to-profile mappings, `manageAppVersionAndBuildNumber = false` |
| `Relayium.xcarchive` | the signed archive |
| `export/Relayium.ipa` | the exported App Store IPA |
| `verify/` | the unpacked payload, both bundles' entitlements, and the `AVCapture` symbol lists |
| `logs/` | the complete archive and export logs, the `codesign` output, and `-showBuildSettings` for both targets |
| `candidate-manifest.txt` | the human-readable manifest |
| `candidate-manifest.plist`, `candidate-manifest.json` | the same facts machine-readably |

The manifest records the full commit, branch and upstream, the marketing
version and build, the attested read-back values and their age at build time
(labelled there as the operator's claim rather than an observation), the Xcode
version and build and the iphoneos SDK, the pinned release graph, and SHA-256
for the IPA, the archived app binary and the generated export options. It
contains no credential and no secret.

### What the verification proves

Every check runs against the **archive** and the **exported IPA payload**, not
against source, because signing, thinning and packaging sit between the two:

- app and Share bundle identifiers, marketing version and build;
- exactly one `.appex` anywhere in the payload, and it is the Share extension;
- a distribution signature and team `7PVYUG4YQS` on both bundles, with
  `get-task-allow` absent;
- the app's three entitlements — Sign in with Apple, `applinks:relayium.com`,
  App Group `group.com.relayium.app` — and the extension's one, **including the
  absences**: the extension carries no Sign in with Apple, no associated
  domains and no keychain access group;
- a valid, non-tracking privacy manifest in both bundles of **both** the archive
  and the exported payload — four files, because the export re-signs and
  repackages what the archive produced — each declaring **exactly** its own
  required-reason graph and nothing else. The app's four are
  `NSPrivacyAccessedAPICategoryUserDefaults` `CA92.1`,
  `NSPrivacyAccessedAPICategoryFileTimestamp` `DDA9.1`,
  `NSPrivacyAccessedAPICategorySystemBootTime` `35F9.1` and
  `NSPrivacyAccessedAPICategoryDiskSpace` `E174.1`; the Share extension declares
  the file-timestamp one alone, because it links only `RelayiumShareKit`. Exact
  in both directions: a category the source does not justify is as false a
  public statement as a missing one, and the extension silently shipping the
  **app's** manifest is present, valid and wrong;
- `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` in the built
  app `Info.plist`, the camera string localized in the app bundle's own
  `en.lproj` and `zh-Hans.lproj`, and **no** camera declaration and **no**
  `.lproj` at all in the extension;
- `AVCapture` undefined symbols in the app's own binary and in the embedded
  `WebRTC.framework` — the readback *Validation outstanding* below owes against
  a signed candidate rather than an unsigned local build.

### What it is not

It is not a launch, not a submission and not proof of the physical gates. It
signs and packages; it does not accept a system privacy alert, exercise a
two-device transfer, or observe App Store Connect.

Its verification half also requires a real signed artifact, which bounds what
`scripts/test/ios-app-store-candidate-test.sh` can cover. That suite
mutation-tests every policy rule and executes the refusal ladder, the generated
export options and — against stubs that compile, link and sign nothing — the
exact `xcodebuild archive` and `xcodebuild -exportArchive` invocations,
including that neither carries `-allowProvisioningUpdates`. It reaches the
export by letting the stub create the empty `.xcarchive` the script asked for,
then fails the export; it never fabricates a signed export and therefore
deliberately stops before the post-export checks.

One post-export check is the exception, and deliberately so: the privacy-manifest
comparison needs no signature, so the suite lifts the script's own graph reader
and its checker out of the file and drives them against manifests it builds —
proving that a missing category, a wrong or extra reason code, an over-declared
category, a duplicated category or reason, an extension carrying the app's
manifest, an unreadable manifest and an absent one each raise a finding, and that
the manifests this repository ships raise none. Everything else past the export —
the signatures, the entitlements, the purpose strings, the symbol readbacks — is
exercised only by the operator run, and recorded here.

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
  notifications, requests no notification authorization, and schedules and
  delivers no notification. State it that way rather than as a claim about
  binary linkage: `RelayiumAppKit` carries `canImport(UserNotifications)`
  source, so whether the framework is linked into the iOS binary is not settled
  until an `otool -L` readback of a built product says so. The entitlements are
  unchanged by this feature. One purpose string has since been added to the
  app — `NSLocalNetworkUsageDescription` — but it belongs to the peer-to-peer
  transfer lanes rather than to Device Inbox; see *Local Network access* below.

  The **privacy manifest** did change, and the earlier claim here that it had
  not was wrong. Device Inbox refuses a delivery that will not fit before
  writing anything, and `InboxSpace.freeBytes` performs that preflight with
  `statfs` (`InboxFailure.swift`). Apple's required-reason list places `statfs`
  under `NSPrivacyAccessedAPICategoryDiskSpace`, so the app's manifest declares
  reason `E174.1` — checking that there is sufficient disk space to write files.
  E174.1 permits that use provided nothing derived from the reading is sent off
  device, and nothing is: the byte count is compared against the delivery's size
  and the comparison's Bool is all the rest of the app sees. This is a
  required-reason API declaration, not a data-collection one, so it changes no
  App Privacy answer. The Share extension does **not** declare it — `InboxSpace`
  lives in `RelayiumAppKit`, which that target does not link — and neither macOS
  manifest declares it either, because Apple's required-reason rule names
  iOS/iPadOS/tvOS/visionOS/watchOS and not macOS.
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
outstanding.** This is a functional and review-relevant prerequisite, and the
declaration exists — what remains is observing it work on a device. The camera
item below is now in the same posture rather than the blocking one it held
through `0.3.0 (5)`: both keys are declared and truthful in source, and both owe
physical prompt evidence on a candidate.

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

## Protected-resource declaration: resolved in source, validation outstanding

**Status: the declaration is implemented and truthful in source; it has not yet
been validated on a built candidate, and the physical prompt-scan evidence is
still owed.** This is no longer an open upload blocker of the class it was
through `0.3.0 (5)`, and it is not yet a closed item either.

Apple's protected-resource guidance is explicit that App Review rejects an app
whose *code* references a protected API without the matching purpose string,
and that an API reached through a third-party SDK counts as the app's own:
<https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources>

### What the blocker was

Through `0.3.0 (5)` the condition was a mismatch, and the mismatch pointed the
wrong way:

- `apps/ios/Relayium/Info.plist` declared **no** `NSCameraUsageDescription`;
- no product Swift source implemented a camera feature — the app used WebRTC
  **data channels only**, with no capture, no call and no QR scanner;
- the built app nevertheless embedded
  `Relayium.app/Frameworks/WebRTC.framework/WebRTC`, whose undefined-symbol
  table references the camera-capture classes `AVCaptureSession`,
  `AVCaptureDeviceInput`, `AVCaptureVideoDataOutput`,
  `AVCaptureDeviceDiscoverySession`, `AVCaptureVideoPreviewLayer` and
  `AVCaptureDeviceRotationCoordinator`, plus capture constants such as
  `AVCaptureDeviceTypeBuiltInWideAngleCamera`.

That is not a hypothetical: **`0.1.0` build 3 was rejected by exactly this check
for a missing `NSCameraUsageDescription`**, and build 4 replaced it.

The record named two honest resolutions and refused a third — adding a purpose
string for a feature that did not exist, which would have been a false statement
to Apple and to the user and would have contradicted the App Privacy answers.
Resolution 1 was **make the reference real**; resolution 2 was ship a
data-channel-only WebRTC binary.

### What was done: resolution 1

The product now has a camera feature, and the declaration follows it rather
than the other way round.

- `apps/ios/Relayium/PairingScannerView.swift` reads the pairing QR code the
  other device already displays — the same
  `https://relayium.com/cross-network#c=NNNNNN` link `transferPairingJoinURL`
  builds — and fills the six-digit Receive field with it.
- It is clean-room `AVFoundation`: an `AVCaptureMetadataOutput` restricted to
  `.qr`, an `AVCaptureDeviceInput` on the wide-angle camera and an
  `AVCaptureVideoPreviewLayer`. **Not `VisionKit`** — `DataScannerViewController`
  requires an A12, and this app's `IPHONEOS_DEPLOYMENT_TARGET` is 16.0. The
  oldest hardware that floor admits is the iPad (5th generation), an A9; the
  iPad (6th generation) and the iPad (7th generation) are A10. `VisionKit`
  would not fail to build on any of them — it would return
  `isSupported == false` at runtime, on the devices least able to type six
  digits quickly. The iPad (7th generation) is the oldest device in this
  project's own physical fleet, which is why the scan check below names it; it
  is **not** the platform floor, and lowering the argument to A10 would
  understate how much hardware `VisionKit` excludes.
- No photo output, no movie output, no sample-buffer delegate, no
  `AVAudioSession`, and no frame written to disk, logged, or sent anywhere.
  That is what lets the purpose string say nothing is recorded or saved.
- The camera is requested **after an explicit tap**. The app's single
  `AVCaptureDevice.requestAccess(for: .video)` sits inside
  `PairingScannerModel.begin()`, reached only from the scanner sheet, which only
  the "Scan a QR code" control on the Receive card presents. Nothing at launch
  and nothing on entering the tab touches the camera.
- **A scan fills a field; it never joins.** The payload goes through
  `PairingScanPolicy`, which is a funnel into the existing `parseAppDeepLink` —
  the same gate the Universal Link handler uses — and accepts only a validated
  `relayium.com` realtime link carrying a complete six-digit code. Download
  links, custom schemes, foreign hosts, userinfo, non-443 ports, malformed URLs,
  code-less links and junk are refused without changing what is already typed.
  A validated mode hint selects the segmented control the user can immediately
  change. There is no path from the scanner to `join`.
- Every refusal — denied, restricted, no camera, failed to start — keeps manual
  six-digit entry and paste usable, and says so in its own sentence. Only
  `denied` offers Settings, because it is the only one a person can change
  there.
- **The camera cannot outlive the sheet that asked for it.** Both asynchronous
  steps — the system permission alert and the capture-graph build — resume at a
  point where the screen may be gone, and neither can be cancelled from outside:
  `AVCaptureDevice.requestAccess` ignores the cancellation of the `.task` that
  started it. So each step carries the *activation* (`ScannerActivation`, a
  monotonic id taken in `begin()`) it started under and compares it against the
  mounted one before it may publish a phase, adopt the delegate, start capture or
  deliver a result. `end()` clears the mounted activation, which makes dismissal
  permanent for everything already in flight; `suspend()` records that the scene
  left the foreground rather than merely acting on it, so an answer that lands
  behind the app switcher cannot start the camera there; and every start is
  funnelled through one gate that re-proves all four preconditions. The metadata
  delegate stamps each decision, under the same lock that takes the one-shot
  latch, with the activation whose camera read the frame, so a code read
  microseconds before dismissal is dropped rather than filling the join field
  afterwards.
- **Proving a start and performing one happen at two different instants, and
  the proof is carried between them.** All four preconditions above are
  main-actor state, and `startRunning` blocks for long enough that it must not
  run on the main thread — so the gate proves them and then *enqueues* the start
  on a serial `sessionQueue`. `end()` and `suspend()` also run on the main actor,
  so both can land entirely inside that gap: the gate passes, the sheet goes
  away, and the block that was already queued starts a camera nothing is showing.
  The serial queue orders their `stopRunning` behind it, so the symptom is a
  camera that turns on off-screen and goes off again a whole `startRunning`
  later, not one that stays on — which is why every ordering assertion about the
  gate was true while the defect was live. `CaptureRunPermit` closes it:
  `startSession` stamps the permit with the exact activation *before* enqueueing,
  the queued block re-reads it under a lock one statement *before*
  `startRunning`, and `stopSession` — the single place any stop is scheduled, so
  dismissal, the app switcher and delivery all reach it — revokes the permit
  synchronously on the main actor *before* it schedules that stop. The
  comparison is against the exact activation rather than "some permit exists", so
  a reopened sheet's permit cannot authorize the previous sheet's queued start.
  The lock is held for one field access and never across `startRunning`, so the
  main thread is never blocked behind the camera.
- **Switching the camera off and being able to say so are also two different
  instants.** `stopRunning` blocks for the same reason `startRunning` does, so
  `stopSession` revokes the permit synchronously and then *enqueues* the stop —
  which means "capture stopped, then the caller was told" was, until this was
  corrected, only "a stop was scheduled, then the caller was told". The accepted
  result dismissed the sheet with the `stopRunning` still sitting in the queue
  behind whatever configure or start was already there, so the camera was
  switched off *during* the dismissal rather than before it. `stopSession` now
  takes a completion that is the last statement *inside* the queued block: it
  runs after the stop has been performed, or after the queue has observed the
  session was already stopped — the same fact about the camera, and one that must
  not swallow the result — and hops to the main actor from there. It is a hop and
  not a `sessionQueue.sync`, because waiting would block the main thread behind
  `stopRunning`. `handle` commits `hasDelivered` *before* that wait, so no second
  decision can begin a second delivery and no start can be scheduled underneath
  it, and the completion re-proves its activation before calling the caller —
  the hop costs a main-actor turn, and a Cancel or a swipe inside it would
  otherwise fill the join field from a sheet the user had already dismissed. The
  residual is the same bounded one named below: a `startRunning` already underway
  keeps the camera on until it returns, and FIFO puts this stop directly behind
  it, so the completion runs after the stop rather than after the start.
- **The one case this cannot cover**, stated rather than implied: if
  `startRunning` has already *begun* executing when the main actor revokes, the
  permit was read truthfully and AVFoundation offers no way to abort a start in
  progress. That window is bounded rather than open-ended, and the revoke order
  is what bounds it: a recheck that returned true proves the revoke had not
  landed, which proves the stop following it had not been enqueued, so FIFO puts
  that stop directly behind the start and the camera is off again as soon as
  `startRunning` returns. Closing even that would mean holding the lock across
  the blocking call and taking it on the main actor, trading a bounded window for
  a hang. The residual is inherent to a blocking, non-cancellable start;
  everything before the call is covered.

`NSCameraUsageDescription` is declared in `apps/ios/Relayium/Info.plist` as the
English fallback and localized in that bundle's `en.lproj/InfoPlist.strings` and
`zh-Hans.lproj/InfoPlist.strings`. It is declared in the **main app only**; the
Share extension declares none of it and has no `.lproj` folder, because it
copies what the user shared into the App Group and opens no camera — and iOS
attributes an extension's prompt to the host app.

### What now enforces it

`IOSLocalNetworkPermissionTests.testNoCameraPurposeStringHasAppearedWhileThatBlockerIsStillOpen`
was written to be deleted by the batch that resolved this, and this is that
batch. It is replaced by:

- `IOSLocalNetworkPermissionTests.testTheCameraDeclarationIsTheAppsAloneAndTheExtensionStillDeclaresNothing`
  and `…testEachCatalogDeclaresExactlyTheDeclaredPurposeKeys`, which pin the
  declared key set and the app/extension boundary;
- `IOSPairingScannerTests`, which drives the link gate adversarially against
  every payload class a printed code can carry, and pins the single
  tap-gated request, the QR-metadata-only capture graph, the teardown on every
  exit, the copy bounds in both languages, and the absence of any path from a
  scan to a session.
- Two of those, `…testEveryStepThatResumesAfterAnAwaitProvesItStillOwnsTheMountedSheet`
  and `…testDismissalIsPermanentAndNothingStartsOrDeliversOutsideItsActivation`,
  are the lifecycle half. They are ORDERING assertions over the extracted body of
  each function rather than presence ones, because a guard that has drifted below
  the thing it gates reads exactly like a guard that works. Each was checked by
  mutation: deleting the post-`requestAccess` proof, moving it below what it
  gates, restoring the old `guard phase == .running` in `suspend()`, and removing
  the proof in `handle` each fail the suite with the sentence describing that
  defect.
- The enqueue-time/execution-time separation has three guards of its own, because
  ordering assertions alone cannot see the difference between a permit stamped
  with an activation and a boolean that says somebody may start:
  `…testTheQueuedStartIsStampedBeforeItIsEnqueuedAndReprovedBeforeItRuns` states
  the invariants as a predicate over the scanner's source;
  `…testRemovingTheExecutionTimeRecheckOrRevokingAfterTheStopIsScheduledFails`
  feeds that predicate four mutations of the real file — the recheck deleted, the
  recheck hoisted above `sessionQueue.async` where the gate already ran, the
  revoke moved inside the enqueued block, and the permit reduced to `granted !=
  nil` — and requires it to complain about each; and
  `…testTheRunPermitRefusesAStartInvalidatedBetweenItsEnqueueAndItsExecution`
  lifts `CaptureRunPermit` out of the iOS target (which this package cannot
  import), compiles it alone with `swiftc`, and drives the race itself against a
  suspended serial queue standing in for `sessionQueue`. Two of those mutations
  were additionally applied to `PairingScannerView.swift` itself and the suite
  failed with the sentence naming the defect.
- The stop side has the same pair, because the same class of claim was made about
  it: `…testTheAcceptedResultIsDeliveredOnlyAfterTheQueueHasStoppedTheSession`
  states, as a predicate over the source, that the hand-off is committed before
  the wait, that `onResult` is reached only from inside `stopSession`'s
  completion, that the completion is the queued block's last act (pinned by its
  indentation, since textual order cannot say what is nested inside the block),
  that the completion re-proves its activation, and that neither an
  already-stopped session nor a `sessionQueue.sync` is allowed to reappear.
  `…testDeliveringBeforeTheQueuedStopHasRunFails` feeds that predicate six
  mutations of the real file — the pre-fix `stopSession()` then `onResult(result)`
  two-liner, the announcement hoisted above the stop, the announcement lifted out
  of the queued block, the completion's activation re-proof deleted, the
  `guard session.isRunning else { return }` early return restored so an
  already-stopped session drops the result, and the queue hop traded for a
  blocking `sync` — and requires it to complain about each.

### Validation outstanding

Two things this record does **not** yet claim, and neither may be improvised at
upload time.

1. **Built-candidate symbol and declaration validation.** The unsigned local
   Release generic-device build of this batch (Xcode 26.6, `iphoneos26.5`,
   `CODE_SIGNING_ALLOWED=NO`, `BUILD SUCCEEDED`) was inspected for both its
   *declarations* and its *symbols*. Declarations: the built
   `Relayium.app/Info.plist` carries both purpose strings verbatim
   (`NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`), the built
   `en.lproj` and `zh-Hans.lproj` `InfoPlist.strings` catalogs both reach the
   bundle carrying the exact localized camera sentence, and the built
   `RelayiumShare.appex` carries no `NSCameraUsageDescription` and no `*.lproj`
   directory at all.

   Symbols: the readback **was** re-run for this batch, against
   `Build/Products/Release-iphoneos/Relayium.app`, with these results:

   ```sh
   xcrun nm -u "<Relayium.app>/Relayium" | grep -E 'AVCapture'                      # 8 symbols
   _AVCaptureDeviceTypeBuiltInWideAngleCamera
   _AVCaptureSessionPreset1280x720
   _OBJC_CLASS_$_AVCaptureDevice
   _OBJC_CLASS_$_AVCaptureDeviceInput
   _OBJC_CLASS_$_AVCaptureMetadataOutput
   _OBJC_CLASS_$_AVCaptureOutput
   _OBJC_CLASS_$_AVCaptureSession
   _OBJC_CLASS_$_AVCaptureVideoPreviewLayer

   xcrun nm -u "<Relayium.app>/Frameworks/WebRTC.framework/WebRTC" | grep -E 'AVCapture'   # 15 symbols
   ```

   That is the line this batch was meant to change: the app's **own** binary now
   references capture APIs directly — not only the embedded WebRTC framework —
   which is precisely why the declaration is owed rather than invented. The
   eight symbols are exactly the surface `PairingScannerView` uses: a session, a
   wide-angle device and its input, a metadata output, a preview layer and the
   720p preset.

   **This is an unsigned local build, not a signed release candidate.** The
   readback above therefore closes the source-and-local-build question only.
   Re-run both commands against the signed release candidate before upload and
   record that output here as well; a signing, thinning or bitcode-stripping
   step is exactly the kind of thing that can move a symbol table, so do not
   carry this result forward as if it were the candidate's.

   `scripts/ios-app-store-candidate.sh` re-runs both readbacks itself, against
   the exported IPA payload, and writes the symbol lists to
   `verify/avcapture-app.txt` and `verify/avcapture-webrtc.txt` with the counts
   in the manifest. Copy that run's output into this item when the candidate is
   built; until then this remains outstanding, because no candidate has been
   built.

2. **Physical prompt-and-scan evidence.** No automated test may accept a system
   privacy alert, and none does. On a physical device, on the exact candidate,
   observe and record:

   1. On a device that has not already decided camera access for this app,
      tapping "Scan a QR code" on the Receive card presents the camera prompt,
      and the alert renders the app's own sentence. Reach that state by using a
      device where the permission has not yet been decided — **do not**
      uninstall or reinstall the app, clear its data, reset privacy settings, or
      change any device setting to force the prompt. If every available device
      has already decided it, record that and leave this item outstanding rather
      than mutating device or account state.
   2. Allowing it, then pointing the camera at another device's pairing QR code,
      fills the six-digit field, applies the mode when the link carries one, and
      does **not** start a transfer. Pressing Join then completes a real
      transfer.
   3. Denying it at that prompt leaves the scanner sheet explaining the denial
      and the six-digit field typeable and joinable, with no hang and no
      dead control.
   4. The prompt is presented in Simplified Chinese on a device set to that
      language, with the translated sentence.
   5. On the iPad (7th generation) — the oldest device in this project's fleet,
      an A10 — the scanner opens and reads a code. That is the case `VisionKit`
      would have failed at runtime. It is the oldest hardware **available** to
      test on, not the oldest the iOS 16.0 floor supports: that is the iPad
      (5th generation), an A9, which this fleet does not have. Record this item
      against the A10 and leave the A9 as untested rather than implied.

   Record the run tag and outcome here when done. Until then this record claims
   the declaration is correct **in source and in an unsigned local build only**.

**Scope: this section is about the camera only.** The same framework also
references `AVAudioSession` symbols, but audio-session linkage alone does not
establish that `NSMicrophoneUsageDescription` is required — an app may
configure a session category without ever requesting record permission. That
observation is **not conclusive** and is deliberately excluded from the claim
above; the microphone key stays absent. If one is ever asserted to be owed,
establish it from Apple's own validation or review output, not from symbol
linkage, and re-author the feature first exactly as this section did.

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
exact-source archive and checksum — which is what
`scripts/ios-app-store-candidate.sh` produces, and which running that script
does **not** by itself authorize uploading. Upload only the exact candidate
whose hosted Go, Swift, iOS Release build and UI gates are green. Every hosted iOS job
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
  sender's. `scripts/ios-device-inbox-acceptance.sh` covers **one direction of
  this item and no more**: one run is one delivery, sender to receiver, and the
  digest it compares is read out of the receiving device's app container with
  `devicectl device copy from` rather than seen in the Files app. The reverse
  direction is a second run started deliberately with the roles exchanged, and
  the Files app appearance is an operator observation the harness cannot make;
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

Two of the items above have physical harnesses, and each covers part of its
item rather than all of it. Run the harness where one exists rather than
improvising an equivalent by hand, and record the rest as operator observation
against the same run tag:

| Harness | Covers | Does **not** cover | Evidence root |
| --- | --- | --- | --- |
| `scripts/ios-device-pair-acceptance.sh` | the Nearby and pairing-code file and text transfers, in both directions (each flow is re-run with the roles exchanged), the two independently derived short-authentication strings compared equal, and the received bytes hashed against a constant this script holds — once live and once after the receipt is dismissed | the pairing code's expiry, join link or QR handoff; a second batch on one link; a file sent from inside a live Nearby workspace; a legacy `0.1.0` peer | `.relayium-device-pair/<run-tag>/` |
| `scripts/ios-device-inbox-acceptance.sh` | ONE Device Inbox delivery, sender to receiver: a run-unique message and a deterministic file asserted on both surfaces, and the receiving device's container bytes hashed against a digest this script holds | the reverse direction; background or closed-app receipt; Files app visibility; delivery to an offline device that returns; a Web, macOS or CLI sender | `.relayium-device-inbox/<run-tag>/` |

The three items with **no** harness at all stay operator evidence, and no run
of either script above may be cited for them:

- the **foreground-only boundary**. The inbox harness deliberately keeps the
  receiving app on screen for the whole run, so it establishes nothing about a
  closed app either way;
- **local history deletion is not a recall**. Nothing in either script deletes
  a conversation entry mid-delivery;
- **the adaptive shell** on real hardware. Its regular-width half is executed
  on a hosted iPad simulator by `ios.yml`'s `ios-ipad-shell` job, which is
  simulator evidence for the layout and not device evidence for the item.

Both harnesses keep their run directory whatever the outcome, because a pass is
evidence too. Each run therefore leaves build and per-device logs, `.xcresult` bundles
and a DerivedData tree, and the roots reach multiple gigabytes. They are
intentional local physical evidence, are ignored at the repository root by
`.gitignore`, and must not be committed or cleaned as though they were build
scratch. Cite the exact run tag when reporting a physical result.

Sandbox purchases do not charge real money. Do not add the build to App Review
or public release until the owner has accepted these results. Public release
must remain a separate explicit decision.
