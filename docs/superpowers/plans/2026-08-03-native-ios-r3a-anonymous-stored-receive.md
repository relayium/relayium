# Native iOS R3-A — anonymous stored receive — Implementation Plan

Date: 2026-08-03

**Goal:** Paste an encrypted Relayium stored link into a native iOS app, see what
it contains before spending it, save the files into an app-owned folder Files can
browse, and share the finished result through the system share sheet.

**Architecture:** Three layers, the same split R1 established. `RelayiumKit`
(protocol/crypto/cloud) and `RelayiumAppKit` (`@MainActor` view models, nine
`.lproj` catalogs) are reused unchanged except for one new destination helper,
one iOS-facing error-copy helper, and ten new copy keys. The iOS app target
holds views only — no transport rule, no path rule, no business rule.

**Tech stack:** Swift 5.9 / SwiftPM local package, SwiftUI lifecycle, iOS 16
minimum, XCTest.

**Spec:** `docs/superpowers/specs/2026-08-03-native-ios-r3a-anonymous-stored-receive-design.md`

## Global constraints

- **Do not touch the wire.** No change to stored-wire framing, crypto, link-key
  handling, server APIs, or any server/web code.
- **Do not log or persist secrets.** No link, fragment key, filename, or
  plaintext outside the received files themselves. No analytics.
- **Expose a result only after `ManifestWriter.finish()`.** Render the share
  affordance from `model.received`, never from a URL assembled in the view.
- **Never overwrite, merge into, or delete what is already there.** For the two
  flat shapes a taken name is a refusal; a received *folder* whose name is taken
  steps aside to `<name> (2)` instead, atomically. Both outcomes leave the
  preexisting item with its bytes under its own name, which is the actual
  invariant. Do not add an iOS-specific merge, replace, or "uniquify the flat
  file" path, and do not turn the folder step-aside into a refusal to make the
  rule sound simpler than it is.
- **Warn before the network call.** The burn-after-read notice belongs in
  `.ready`, above the download action.
- **Never read `UIPasteboard` implicitly.** A `TextField` the user pastes into is
  the whole input mechanism.
- **Capabilities follow features, not the other way round.** No Associated
  Domains, local network, background modes, Sign in with Apple, or push in this
  slice. Do not invent signing or provisioning.
- **No availability claim.** `apps/mac/release-readiness.json` stays
  `approved: false`; the web `/apps` page is untouched.

## File structure

| File | Responsibility |
|---|---|
| `apps/RelayiumKit/Sources/RelayiumAppKit/ReceiveDestination.swift` | **new** — the app-owned received-files directory, testable without UIKit |
| `apps/RelayiumKit/Sources/RelayiumAppKit/ReceiveDestinationCopy.swift` | **new** — the five destination errors whose shared wording assumes a folder picker, re-worded for a destination that has none; defers to `ErrorCopy` for everything else |
| `apps/RelayiumKit/Sources/RelayiumAppKit/CloudDownloadModel.swift` | injectable error copy, defaulting to `ErrorCopy` so macOS does not move |
| `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift` | the iOS build's download model gets the iOS copy |
| `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift` | ten new keys |
| `apps/RelayiumKit/Sources/RelayiumAppKit/Resources/*.lproj/Localizable.strings` | those ten keys, in all nine languages |
| `apps/ios/Relayium.xcodeproj/project.pbxproj` | **new** — checked-in project, local `../RelayiumKit` dependency |
| `apps/ios/Relayium.xcodeproj/xcshareddata/xcschemes/Relayium.xcscheme` | **new** — shared scheme |
| `apps/ios/Relayium/RelayiumApp.swift` | **new** — `@main`, app-scoped model |
| `apps/ios/Relayium/ReceiveView.swift` | **new** — the whole flow, one screen |
| `apps/ios/Relayium/Info.plist` | **new** — nine localizations, Files exposure |
| `apps/ios/Relayium/Relayium.entitlements` | **new** — deliberately empty |
| `apps/RelayiumKit/Tests/RelayiumKitTests/ReceiveDestinationTests.swift` | **new** |
| `apps/RelayiumKit/Tests/RelayiumKitTests/ReceiveDestinationCopyTests.swift` | **new** — all five re-worded errors and the three deliberately shared ones, in all nine languages |
| `apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift` | adversarial second-receive cases for the two refusing shapes |
| `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizationIntegrityTests.swift` | iOS `CFBundleLocalizations` |
| `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizationSourceGuardTests.swift` | scan the iOS sources |
| `.github/workflows/macos.yml` | `ios-build` job |
| `README.md` | truthful delivery status |

## Tasks

### 1. Shared destination helper

- [x] Add `ReceiveDestination` to `RelayiumAppKit`: `documentsDirectory(_:)`
      (the `FileManager` lookup the app uses) and `directory(inDocuments:
      fileManager:)` (pure, testable on macOS) returning
      `<documents>/Received`, created on demand.
- [x] Refuse rather than repair when a non-directory occupies the name.
- [x] Tests: creates on demand, idempotent on a second call, refuses a file at
      the name, stays inside the documents directory it was given.

### 2. Copy

- [x] Add `common.share`, `download.receive`, `download.resolving`,
      `download.inProgress`, `download.savedLocation` to `L10nKey`.
- [x] Translate all five into all nine catalogs. Four take no placeholder;
      `download.savedLocation` takes `%@`, the Files-app route the payload
      landed at (`Relayium/Received`), supplied by
      `ReceiveDestinationCopy.savedLocation()` from the same constants the
      destination failures use and isolated through `L10n.token`. The route is
      interpolated rather than written into each translation because the
      receive folder is one level below the app's own folder, and a spelled-out
      sentence was free to stop at `Relayium`.
- [x] Add the five `.filesApp` error keys in all nine catalogs:
      `error.destination.fileExists.filesApp` and
      `.directoryExists.filesApp` (`%1$@` the colliding name, `%2$@` the
      Files-app folder), `.unsafeName.filesApp` (`%@` the unsafe path),
      `.notPermitted.filesApp` (`%@` the receive folder) and
      `.systemError.filesApp` (`%1$@` the receive folder, `%2$@` the errno). The
      shared `error.destination.*` keys are NOT edited — macOS's wording stays
      put.
- [x] `ReceiveDestinationCopy` maps exactly the five `DownloadDestinationError`
      cases whose shared wording assumes a picker — the two collisions,
      `unsafeName`, and `systemError` for EACCES/EPERM and for any other errno —
      and defers everything else to `ErrorCopy`, including `systemError(ENOSPC)`,
      `incomplete` and `exceedsManifest`, whose advice is genuinely
      platform-neutral. Every interpolation (name, folder path, errno) goes
      through `L10n.token`. `CloudDownloadModel` takes the formatter as an init
      parameter defaulting to `ErrorCopy`, and `AppEnvironment` passes the iOS
      one under `#if os(iOS)` so no iOS surface can get the picker wording.
- [x] `ReceiveView` uses `.appFolder` in the one `catch` that can only mean
      something is occupying the receive folder's own name.

### 3. Xcode project

- [x] `apps/ios/Relayium.xcodeproj`, object version 77, one `Relayium` app
      target, file-system-synchronized `Relayium` group with `Info.plist` as a
      membership exception.
- [x] iOS 16 minimum, `com.relayium.app`, `TARGETED_DEVICE_FAMILY = "1,2"`,
      SwiftUI lifecycle, `XCLocalSwiftPackageReference "../RelayiumKit"` and the
      single `RelayiumKit` product. No second package manager, no generator.
- [x] Shared scheme named `Relayium`.
- [x] No `DEVELOPMENT_TEAM`, no provisioning profile, no asset-catalog settings.

### 4. App sources

- [x] `RelayiumApp.swift`: `@main`, one app-scoped `@StateObject
      CloudDownloadModel` from `AppEnvironment.makeDownloadModel()`.
- [x] `ReceiveView.swift`: the six states, Dynamic Type and RTL by construction,
      `ShareLink` over `model.received.dragURLs` in `.done` only.
- [x] `Info.plist`: nine `CFBundleLocalizations`, `UIFileSharingEnabled`,
      `LSSupportsOpeningDocumentsInPlace`, `UILaunchScreen`, iPhone + iPad
      orientations.
- [x] `Relayium.entitlements`: empty, with the reason written down.
- [x] No `onOpenURL`: without Associated Domains or a registered scheme nothing
      can deliver a URL, so wiring it would be dead code claiming a capability.

### 5. Guards

- [x] `LocalizationSourceGuardTests` scans `apps/ios/Relayium`; per-root counts
      asserted so a rename cannot silently empty one; global count raised.
- [x] `LocalizationIntegrityTests` asserts the iOS `Info.plist` declares the same
      nine, mirroring the macOS assertion.
- [x] Adversarial: a second receive into a taken single-file name and into a
      taken `relayium-<id>` container both fail, leave the existing bytes
      unchanged, and leave `model.received` nil. Only these two shapes fail —
      the nested-folder shape steps aside to `<name> (2)` and is covered by
      `FolderReceiveTests`; do not assert a refusal there.
- [x] The failure a user actually sees on iOS never names a folder picker and
      never claims a folder they chose: asserted directly in
      `ReceiveDestinationCopyTests` for all five re-worded cases in all nine
      languages — both shared picker wordings absent, placeholders all
      substituted, Arabic isolating name, folder path and errno — with `ENOSPC`,
      `incomplete` and `exceedsManifest` pinned to the shared copy, and end to
      end through a model built with the iOS copy.

### 6. CI and status

- [x] `ios-build` job in `.github/workflows/macos.yml`: generic iOS Simulator,
      `CODE_SIGNING_ALLOWED=NO`, no secrets, no distribution, reusing the
      already-pinned checkout SHA.
- [x] README delivery status: iOS development has started with this anonymous
      stored-link receive foundation; it is not public and the rest of R3
      remains. `/apps` availability and macOS release approval untouched.

## Acceptance

1. `cd apps/RelayiumKit && swift test` — full suite plus the new tests pass; only
   the documented opt-in real-Keychain test may skip.
2. `xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator'
   … CODE_SIGNING_ALLOWED=NO build` — succeeds.
3. `xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium
   -destination 'generic/platform=iOS Simulator' … CODE_SIGNING_ALLOWED=NO
   build` — succeeds, no missing resource/localization/package errors.
4. `plutil -lint` on the iOS `Info.plist`, entitlements, and the nine catalogs —
   all OK.
5. `apps/mac/scripts/test-release-readiness.sh` — passes, manifest still
   `approved: false`.
6. `git diff --check` clean; `git status --short --untracked-files=all` shows
   only intended files plus the untouched `output/`.
7. Boot a simulator, install the unsigned Debug build, launch it, confirm it
   stays running.

## Outstanding manual validation

Recorded rather than claimed:

- an end-to-end receive against a real link (needs a live upload);
- the `Received` folder appearing under *On My iPhone ▸ Relayium* in Files;
- *Save to Files* accepting a **directory** item from the share sheet on device;
- VoiceOver and the largest Dynamic Type sizes.

Done: simulator install/launch/stay-running, and Arabic rendered right-to-left.
