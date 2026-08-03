# macOS productization — desktop shell and app icon — Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for
> tracking. Tasks 1–8 are Claude's and are executed **serially in one worktree
> by the implementing session itself** — they share files, a localization
> catalog and a build, so they are not independent and must not be fanned out to
> parallel agents. Task 9 is Codex's and is not Claude's to run.

**Source design:** `docs/superpowers/specs/2026-08-03-macos-productization-shell-and-icon-design.md`

**Topology (binding):** Claude–Codex **collaboration mode**. Codex framed this
task and owns acceptance. Claude authors this plan, the design and the
implementation, runs every local gate, and self-reviews the actual diff. Codex
then performs the independent review, the validation pass, **one** final English
delivery commit, the push to `main`, the CI verification, and the download and
verification of the signed engineering DMG (Task 9).

- **Claude does not commit. Claude does not push. Claude does not open a PR.**
- Every Claude task ends by producing **evidence** — commands run and their
  observed output — and leaves the changes in the working tree.
- The working tree is therefore **intentionally dirty** at handoff, containing
  exactly the intended files and nothing else. A clean tree at handoff would
  mean the work was committed, which is a topology violation.
- Nothing in this plan may claim Codex has accepted the work. Acceptance is
  Codex's statement to make, after Task 9.

**Goal:** Give the macOS app a real app icon and a desktop shell whose sidebar names all five destinations at once, so every capability that works without an account is reachable without one — with no change to wire, transport, crypto, signing, Sparkle, entitlements, version or any server/web/ops surface.

**Architecture:** Every decision that is not layout moves into pure, testable types in `RelayiumAppKit` (`AppDestination`/`AppRouting`, `AccountGate`, `TransferPresence`); the SwiftUI layer becomes a unique `Window("Relayium", id: "main")` hosting a `NavigationSplitView` shell plus five destination views built from one seven-component vocabulary. The icon's artwork is a tracked SVG in the app's own tree (`apps/mac/Brand/AppIcon.svg`) rendered by an app-local script (`apps/mac/tools/render-app-icon.swift`) into a real `Assets.xcassets`, which reaches the bundle through the existing `PBXFileSystemSynchronizedRootGroup` with no `.pbxproj` edit. **`apps/RelayiumKit/Package.swift` is not touched.**

**Tech Stack:** Swift 5.9 / SwiftPM (`apps/RelayiumKit`), SwiftUI + AppKit on macOS 13, XCTest, CoreGraphics + ImageIO via a single-file `swift` script for rasterization, `xcodebuild`/`actool`/`assetutil`/`plutil` for validation, Node for `check-release-readiness.mjs`.

**THIS SLICE IS NOT A PUBLIC LAUNCH.** It produces an **engineering build**. Under `PROJECT-GOVERNANCE.md` § "Native product launch definition" macOS stays unlaunched: `apps/mac/release-readiness.json` keeps `"approved": false`, no version is bumped, no notarization is submitted, no public download surface changes. Any commit message, README line, readiness string or report that calls this result launched, complete, shipped or publicly available is a **blocking truthfulness regression**. See "Remaining blockers before public launch" at the end.

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **macOS 13.0 floor.** Only APIs available in macOS 13.0. Forbidden, by name: `ContentUnavailableView`, `onChange(of:initial:)`, `@Observable`, `.symbolEffect`, `.containerRelativeFrame`, `.inspector`, `NavigationStack`-only macOS-14 modifiers. Use `.task(id:)` where the code wants `onChange`.
2. **No anonymous capability acquires an account dependency.** Anonymous stored-link receive, pairing-code *join*, nearby send and nearby receive must reach the transport with no `Authorization` header and no session object. Structural rule: the shell never reads `session.state`; the nearby and stored-receive destination files contain neither `AccountSession` nor `bearerToken`.
3. **Model lifetimes do not move.** Every `@StateObject` in `RelayiumApp` stays app-scoped, constructed in the same order, against the same shared `VerificationPreference`, `LanDiscoveryModel`, `InboundRoom`. `quitGuard.isTransferRunning`/`cancelTransfers`, `notifications.start()` and `lanDiscovery.startResident()` keep firing exactly once from the window scene's `.task`.
4. **Menu-bar residency untouched.** `MenuBarExtra`, `MenuBarView`, its pause/resume and its `openWindow(id: "main")` return path are behaviorally unchanged. `MenuBarView.swift:53` keeps `openWindow(id: "main")` **verbatim**.
5. **One unique window.** The main scene is `Window("Relayium", id: "main")` (macOS 13.0), never a `WindowGroup`. `openWindow(id:)` against a `Window` orders the existing unique window forward; against a `WindowGroup` it creates another window, and two windows render the same model twice — two Cancel buttons for one transfer — no matter how app-scoped the state is. `TransferQuitGuard` implements `applicationShouldTerminateAfterLastWindowClosed(_:) -> false` so closing that window keeps the process, the menu bar, the room socket and any running transfer alive. No file under `apps/mac/Relayium` may contain `WindowGroup`; there is no ⌘N and no File ▸ New Window.
6. **Nine languages, always.** Every new key lands in all nine `apps/RelayiumKit/Sources/RelayiumAppKit/Resources/<lang>.lproj/Localizable.strings` (`en, zh-Hans, ja, ko, de, fr, ar, es, pt`) **in the same task that adds the `L10nKey` case**, or `LocalizationIntegrityTests` fails. Every key removed from `L10nKey` is removed from all nine catalogs in the same task. No new user-facing English literal in Swift (`LocalizationSourceGuardTests`); documented exceptions use `// nonlocalized: <reason>`.
7. **Leading/trailing only.** Never `.leading`/`.trailing` spelled as left/right,
   never view-level direction overrides, never `HStack` ordering that assumes
   LTR. The two macOS scene roots may share one direction derived from
   `L10n.current`; real-app QA showed the package catalog alone did not set it.
8. **No new capability claim.** No new entitlement, no `Info.plist` key other than `CFBundleIconName`, no `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` change, no Sparkle feed/key change, no `.github/workflows/macos.yml` change, no `apps/mac/scripts/*` behavior change, no web-runtime change, `release-readiness.json` stays `"approved": false`.
9. **The shared package gains no icon tooling.** `apps/RelayiumKit/Package.swift` is **not modified**, and no `AppIconArtwork` or `AppIconGen` target is added to it. The artwork source and its renderer are app-local: `apps/mac/Brand/AppIcon.svg` and `apps/mac/tools/`.
10. **No fixed font sizes except `SecurityCodeText.swift`.** Exactly one file in `apps/mac/Relayium` may contain `.system(size:`.
11. **No dead controls.** No `.disabled(token.isEmpty)`-style greyed control. Unavailable ⇒ state the reason and offer the action that resolves it.
12. **No invented capability copy.** Every new sentence must be backed by this tree's behavior.
13. **No predicted figure reaches a public document.** `apps/README.md`, the root `README.md` and `release-readiness.json` carry **observed** numbers only. A workflow that was not measured is written down as not measured, with the reason. The design's hypothesis table is internal and is never copied into the repository's public surfaces.
14. **Nothing is described as launched.** Invariant 13 of the design; enforced by `MacSurfaceGuardTests.testNoLaunchClaimInDocs` (Task 7).
15. **Claude never commits and never pushes.** There is no `git add`, no `git commit`, no `git push` and no PR in Tasks 1–8. Each task ends with its gate output as evidence and leaves the change in the working tree. The tree is deliberately dirty at handoff, holding exactly the intended files. Task 9 — Codex's single English delivery commit, the push to `main`, the CI wait and the signed-DMG verification — is the only place any of that happens.

**Copy ledger (binding).** 29 keys added, 5 removed, `tab.account` and `tab.receive` **survive** (`apps/ios/Relayium` renders them).

| # | key | added in |
|---|---|---|
| 1–2 | `nav.sectionDirect`, `nav.sectionLinks` | Task 3 |
| 3–12 | `nav.nearby`, `nav.nearbySubtitle`, `nav.pairingCode`, `nav.pairingCodeSubtitle`, `nav.storedSend`, `nav.storedSendSubtitle`, `nav.storedReceive`, `nav.storedReceiveSubtitle`, `nav.account`, `nav.accountSubtitle` | Task 3 |
| 13–15 | `nav.a11ySections`, `nav.a11yLiveSession`, `nav.residency` | Task 3 |
| 16–21 | `gate.sendLinkTitle`, `gate.sendLinkBody`, `gate.createCodeTitle`, `gate.createCodeBody`, `gate.signIn`, `gate.createAccount` | Task 4 |
| 22–24 | `nearby.noAccountNeeded`, `direct.joinNoAccountNeeded`, `download.noAccountNeeded` | Tasks 5, 5, 6 |
| 25–27 | `presence.busyTitle`, `presence.busyBody`, `presence.showIt` | Task 5 |
| 28–29 | `download.idleHint`, `storedSend.idleTitle` | Task 6 |

Removed in **Task 7**: `content.haveLink`, `content.nearbyOrCode`, `tab.direct`, `tab.link`, `text.signInToCreate`.

---

## Proposed file manifest

**Create — `apps/RelayiumKit` (pure, tested):**

| path | responsibility |
|---|---|
| `Sources/RelayiumAppKit/AppDestination.swift` | `AppDestination`, `AppRouting`, `AppNavigationModel` |
| `Sources/RelayiumAppKit/AccountGate.swift` | `AccountAccess`, `AccountGate`, `AccountGate.from(_:bearer:)` |
| `Sources/RelayiumAppKit/TransferPresence.swift` | `TransferMode`, `TransferPresence` |
| `Tests/RelayiumKitTests/AppRoutingTests.swift` | routing/navigation seam |
| `Tests/RelayiumKitTests/AccountGateTests.swift` | total gate mapping |
| `Tests/RelayiumKitTests/TransferPresenceTests.swift` | single-session ownership |
| `Tests/RelayiumKitTests/AnonymousCapabilityTests.swift` | transport-level no-`Authorization` proof |
| `Tests/RelayiumKitTests/AppIconArtworkTests.swift` | source parity: `apps/mac/Brand/AppIcon.svg` == both web mark files (reads files; imports no new module) |
| `Tests/RelayiumKitTests/AppIconAssetTests.swift` | catalog completeness + PNG structure |
| `Tests/RelayiumKitTests/MacSurfaceGuardTests.swift` | source-property guards, including the window-scene guards |

**Create — `apps/mac/` (outside the synchronized root, so none of it ships in the bundle):**

| path | responsibility |
|---|---|
| `Brand/AppIcon.svg` | the canonical derived artwork on the macOS 1024/824/100 canvas |
| `tools/render-app-icon.swift` | single-file `swift` script: reads the SVG, writes 7 PNGs + `Contents.json` |
| `tools/README.md` | the one command, and that it is run by hand — never by a test or a build phase |

**Create — `apps/mac/Relayium`:**

| path | responsibility |
|---|---|
| `Assets.xcassets/Contents.json` | catalog root |
| `Assets.xcassets/AppIcon.appiconset/Contents.json` + 7 PNGs | the icon |
| `Assets.xcassets/AccentColor.colorset/Contents.json` | `#6d28d9` light / `#7c3aed` dark |
| `Shell/AppShellView.swift` | `NavigationSplitView`, destination switch, deep-link + incoming routing |
| `Shell/SidebarView.swift` | five rows, two sections, residency footer |
| `Components/DestinationScaffold.swift` | title/subtitle/measure/scroll/navigationTitle |
| `Components/SectionCard.swift` | the app's only container chrome |
| `Components/EmptyStateView.swift` | symbol + title + body + optional action |
| `Components/InlineMessage.swift` | `.info`/`.warning`/`.failure` |
| `Components/CapabilityGateView.swift` | renders a non-`.allowed` `AccountGate` |
| `Components/SecurityCodeText.swift` | the only `.system(size:` file |
| `Components/StatusBadge.swift` | dot + symbol + label |
| `Destinations/NearbyDestination.swift` | roster, staging, live nearby session |
| `Destinations/PairingCodeDestination.swift` | mint (gated) + join (anonymous) |
| `Destinations/StoredSendDestination.swift` | gated upload |
| `Destinations/StoredReceiveDestination.swift` | anonymous resolve + download |
| `Destinations/AccountDestination.swift` | the whole `session.state` switch |

**Modify** (note the absence of `apps/RelayiumKit/Package.swift`, `.github/workflows/*`, `apps/mac/scripts/*`, `apps/mac/Relayium.xcodeproj/project.pbxproj` and anything under `web/`, `server/` or `relayium-ops/`): `apps/mac/Relayium/RelayiumApp.swift` (the scene becomes a unique `Window`; `TransferQuitGuard` gains `applicationShouldTerminateAfterLastWindowClosed`); `apps/mac/Relayium/Info.plist`; `apps/mac/Relayium/UploadPane.swift`, `DownloadPane.swift`, `NearbyPane.swift`, `DirectPane.swift`, `RealtimeTextPane.swift`, `AccountView.swift`, `RealtimeFileSessionView.swift`, `RealtimeTextSessionView.swift`; `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift`; nine `Localizable.strings`; `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift`; `apps/README.md`; `README.md`; `apps/mac/release-readiness.json`.

**Delete:** `apps/mac/Relayium/ContentView.swift`, `apps/mac/Relayium/DirectHubPane.swift` (both replaced; the disclosure groups and the root `session.state` switch leave with them).

---

## Task 1: Navigation and routing presentation seam

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/AppDestination.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/NearbyReceive.swift:8-11` (add `CaseIterable, Sendable` to `NearbyReceiveKind`)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AppRoutingTests.swift`

**Interfaces — Produces:**
```swift
public enum AppDestination: String, CaseIterable, Hashable, Sendable {
    case nearby, pairingCode, storedSend, storedReceive, account
}
public enum AppRouting {
    public static func destination(for link: AppDeepLink) -> AppDestination
    public static func destination(forIncoming kind: NearbyReceiveKind) -> AppDestination
}
@MainActor public final class AppNavigationModel: ObservableObject {
    @Published public var selection: AppDestination   // starts .nearby
    public init(selection: AppDestination = .nearby)
    public func select(_ d: AppDestination)
    public private(set) var selectionWrites: Int      // test-observable counter
}
```

**Behavioral invariants:**
- `.download` → `.storedReceive`; `.realtime` → `.pairingCode`; `.file`/`.text` → `.nearby`.
- Both mapping functions are `switch` statements with **no `default`**, so a new case is a compile error.
- `select(_:)` performs exactly one assignment and mutates nothing else. Neither routing entry point reads the other's state, cancels a session, or clears pending work.
- Selection is app-scoped so that it survives the unique window's view tree being torn down and rebuilt: close and reopen, and the selection is still what the user, a deep link or an incoming session last set. It is **not** a defence against a second window — there is no second window (constraint 5).

- [ ] **Step 1: Write the failing test**

`apps/RelayiumKit/Tests/RelayiumKitTests/AppRoutingTests.swift`:
```swift
import XCTest
@testable import RelayiumAppKit

final class AppRoutingTests: XCTestCase {
    func testExactlyFiveDistinctDestinations() {
        XCTAssertEqual(AppDestination.allCases.count, 5)
        XCTAssertEqual(Set(AppDestination.allCases.map(\.rawValue)).count, 5)
    }
    func testDownloadLinkGoesToStoredReceive() {
        let url = URL(string: "https://relayium.com/d/abc#k=zzz")!
        XCTAssertEqual(AppRouting.destination(for: .download(url)), .storedReceive)
    }
    func testRealtimeLinkGoesToPairingCodeWithAndWithoutACode() {
        XCTAssertEqual(AppRouting.destination(for: .realtime(code: "123456")), .pairingCode)
        XCTAssertEqual(AppRouting.destination(for: .realtime(code: nil)), .pairingCode)
    }
    func testEveryIncomingKindGoesToNearby() {
        XCTAssertEqual(NearbyReceiveKind.allCases.count, 2)
        for kind in NearbyReceiveKind.allCases {
            XCTAssertEqual(AppRouting.destination(forIncoming: kind), .nearby)
        }
    }
    @MainActor func testSelectIsASingleAssignment() {
        let nav = AppNavigationModel()
        XCTAssertEqual(nav.selection, .nearby)
        nav.select(.storedReceive)
        XCTAssertEqual(nav.selection, .storedReceive)
        XCTAssertEqual(nav.selectionWrites, 1)
        nav.select(.storedReceive)                      // same value, still one write
        XCTAssertEqual(nav.selectionWrites, 2)
        XCTAssertEqual(nav.selection, .storedReceive)
    }
    @MainActor func testLaterEventWinsAndNeitherClearsTheOther() {
        let nav = AppNavigationModel()
        nav.select(AppRouting.destination(forIncoming: .file))
        nav.select(AppRouting.destination(for: .realtime(code: "123456")))
        XCTAssertEqual(nav.selection, .pairingCode)
        XCTAssertEqual(nav.selectionWrites, 2)
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter AppRoutingTests`
Expected: FAIL — `cannot find 'AppDestination' in scope`, `type 'NearbyReceiveKind' does not conform to 'CaseIterable'`.

- [ ] **Step 3: Add `CaseIterable, Sendable` to `NearbyReceiveKind`**

In `Sources/RelayiumAppKit/NearbyReceive.swift`, change the declaration to `public enum NearbyReceiveKind: Equatable, CaseIterable, Sendable {`. Nothing else in that file changes.

- [ ] **Step 4: Write `AppDestination.swift`**

Three declarations only, matching the Interfaces block above. `AppRouting.destination(for:)` is a `switch link` over `.download`/`.realtime` with no `default`; `destination(forIncoming:)` is a `switch kind` over `.file`/`.text` with no `default`, both returning literals. `AppNavigationModel.select` is `selection = d; selectionWrites += 1` and nothing else. Document in a comment that the absence of `default` is the exhaustiveness proof.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `cd apps/RelayiumKit && swift test --filter AppRoutingTests`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite to prove `CaseIterable` broke nothing**

Run: `cd apps/RelayiumKit && swift test 2>&1 | tail -5`
Expected: `0 failures`, 1 skipped (`TokenStoreTests` keychain round trip).

- [ ] **Step 7: Record evidence — do not commit**

Record the two `swift test` outputs (the filtered run and the full-suite tail)
in the task log. Leave the three files in the working tree. **No `git add`, no
`git commit`** (constraint 15).

---

## Task 2: App icon — canonical artwork, an app-local renderer, and validation

**Files:**
- Create: `apps/mac/Brand/AppIcon.svg`
- Create: `apps/mac/tools/render-app-icon.swift`, `apps/mac/tools/README.md`
- Create: `apps/mac/Relayium/Assets.xcassets/Contents.json`
- Create: `apps/mac/Relayium/Assets.xcassets/AppIcon.appiconset/Contents.json` + `icon_16.png`, `icon_32.png`, `icon_64.png`, `icon_128.png`, `icon_256.png`, `icon_512.png`, `icon_1024.png`
- Create: `apps/mac/Relayium/Assets.xcassets/AccentColor.colorset/Contents.json`
- Modify: `apps/mac/Relayium/Info.plist` (add `CFBundleIconName`)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AppIconArtworkTests.swift`, `AppIconAssetTests.swift`
- **Not modified, deliberately:** `apps/RelayiumKit/Package.swift`. No `AppIconArtwork` target, no `AppIconGen` target, no test-target dependency change (constraint 9). What is forbidden is an *icon* target, not `executableTarget` as a construct: the manifest already declares the `RealtimeE2E` and `NearbyReceiveE2E` manual harnesses, and this slice leaves both exactly as they are. The tests below read files from the repository — the pattern `IOSSurfaceGuardTests` already uses — so they need no new module.

**Why app-local.** `apps/RelayiumKit` is the *shared* package behind both the macOS and the iOS app. A macOS icon renderer in that graph would be built by every consumer of the package and would put platform art tooling into a cross-platform library. The artwork and its renderer therefore live under `apps/mac/`, and outside `apps/mac/Relayium/` so that the `PBXFileSystemSynchronizedRootGroup` does **not** copy them into the shipped bundle.

**Interfaces — Produces:**

`apps/mac/Brand/AppIcon.svg`, the single place the icon's artwork is written down:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <!-- Derived from web/public/favicon.svg and web/src/lib/Logo.svelte, which
       carry byte-identical artwork. Two deliberate deviations, both recorded in
       the design: the corner radius follows Apple's macOS grid (185.4/1024 =
       22.5% of the 824 body) rather than the web mark's rx=15 on 64, and no
       drop shadow is baked into the alpha channel. -->
  <defs>
    <linearGradient id="body" x1="100" y1="100" x2="924" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#a94bff"/>
      <stop offset="1" stop-color="#635bff"/>
    </linearGradient>
    <linearGradient id="sheen" x1="100" y1="100" x2="100" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".55" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185.4" fill="url(#body)"/>
  <rect x="100" y="100" width="824" height="824" rx="185.4" fill="url(#sheen)"/>
  <g transform="translate(100 100) scale(12.875)">
    <path d="M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5"
          stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
```

The glyph `d`, the four gradient stops, the stroke width and the round cap/join are **copied unchanged** from the web mark; `scale(12.875)` is `824/64`, so the 64-unit artboard lands exactly on the body.

`apps/mac/tools/render-app-icon.swift`, run by hand:

```
xcrun swift apps/mac/tools/render-app-icon.swift apps/mac/Relayium/Assets.xcassets/AppIcon.appiconset
```

**Behavioral invariants:**
- The mac SVG's glyph and gradients **equal** what `web/public/favicon.svg` and `web/src/lib/Logo.svelte` carry. Drift in any of the three fails `AppIconArtworkTests`.
- Corner radius follows Apple's grid (22.5 % of the body), not the SVG's `rx=15`. No baked drop shadow.
- 10 catalog slots over 7 distinct PNGs (32/256/512 each referenced twice). macOS requires an asset for **every** size rather than deriving them from one large image — <https://developer.apple.com/documentation/xcode/configuring-your-app-icon/>.
- The catalog lives inside the `PBXFileSystemSynchronizedRootGroup` at `apps/mac/Relayium/`, so **no `.pbxproj` edit**; `Brand/` and `tools/` live outside it, so they are not bundled.
- `CFBundleIconName` is written by hand, not left to `actool`'s partial-plist merge.
- Regeneration is an explicit command, never a test or build side effect. Tests assert **structure** (dimensions, alpha topology, colour family at named sample points), never bytes: CoreGraphics rasterization is a system service and may legitimately change across macOS releases.
- `apps/RelayiumKit/Package.swift` is byte-identical before and after this task.

- [ ] **Step 1: Write the failing artwork-parity test**

`Tests/RelayiumKitTests/AppIconArtworkTests.swift` — a **source-parity** test. It imports no new module; it reads three artwork files plus the package manifest.
```swift
import XCTest

final class AppIconArtworkTests: XCTestCase {
    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }
    private func text(_ p: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent(p), encoding: .utf8)
    }
    private let macSVG = "apps/mac/Brand/AppIcon.svg"
    private let webSources = ["web/public/favicon.svg", "web/src/lib/Logo.svelte"]
    private let glyph = "M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5"

    func testTheGlyphIsIdenticalInAllThreeArtworkSources() throws {
        XCTAssertEqual(glyph.filter { $0 == "M" }.count, 4, "four subpaths")
        for file in [macSVG] + webSources {
            XCTAssertTrue(try text(file).contains(glyph), "\(file) no longer carries the glyph")
        }
    }
    func testGradientStopsAndStrokeAreIdenticalInAllThreeSources() throws {
        for file in [macSVG] + webSources {
            let t = try text(file)
            for needle in ["#a94bff", "#635bff", "stop-opacity=\".22\"", "offset=\".55\"",
                           "stroke-width=\"5.5\"", "stroke-linecap=\"round\"",
                           "stroke-linejoin=\"round\""] {
                XCTAssertTrue(t.contains(needle), "\(file) missing \(needle)")
            }
        }
    }
    /// The two deviations the design records, and no others: Apple's canvas and
    /// corner radius, and no shadow anywhere in the file.
    func testTheMacCanvasFollowsApplesGridAndBakesNoShadow() throws {
        let t = try text(macSVG)
        for needle in ["viewBox=\"0 0 1024 1024\"", "x=\"100\"", "y=\"100\"",
                       "width=\"824\"", "height=\"824\"", "rx=\"185.4\"",
                       "scale(12.875)"] {                       // 824/64
            XCTAssertTrue(t.contains(needle), "the mac canvas lost \(needle)")
        }
        XCTAssertFalse(t.contains("rx=\"15\""), "the web corner radius must not survive")
        for banned in ["feDropShadow", "filter=", "feGaussianBlur"] {
            XCTAssertFalse(t.contains(banned), "no shadow may be baked into the alpha channel")
        }
    }
    /// Constraint 9: the shared package must not learn about icons. The ban is
    /// on the *icon* targets by name — not on `executableTarget` as such, which
    /// `Package.swift` already uses legitimately for the `RealtimeE2E` and
    /// `NearbyReceiveE2E` manual harnesses. Those two must survive untouched, so
    /// the second assertion pins the executable set to exactly them: an added
    /// icon executable fails whatever it is called, and a *removed* harness
    /// fails too.
    func testTheSharedPackageHasNoIconTargets() throws {
        let manifest = try text("apps/RelayiumKit/Package.swift")
        for banned in ["AppIconArtwork", "AppIconGen"] {
            XCTAssertFalse(manifest.contains(banned), "Package.swift gained \(banned)")
        }
        let executables = manifest.components(separatedBy: ".executableTarget")
            .dropFirst()                                   // text before the first one
            .compactMap { chunk -> String? in
                guard let open = chunk.range(of: "name: \"") else { return nil }
                return String(chunk[open.upperBound...].prefix { $0 != "\"" })
            }
        XCTAssertEqual(executables.sorted(), ["NearbyReceiveE2E", "RealtimeE2E"],
                       "the executable targets are exactly the two pre-existing E2E harnesses")
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter AppIconArtworkTests`
Expected: FAIL — `apps/mac/Brand/AppIcon.svg` does not exist.
`testTheSharedPackageHasNoIconTargets`, by contrast, must **pass** on this first run: it describes the manifest as it already stands. If it fails here, either `Package.swift` already carries an icon name, or its executable targets are no longer exactly `RealtimeE2E` and `NearbyReceiveE2E` — in both cases stop and report rather than editing the manifest, which this slice does not touch (constraint 9).

- [ ] **Step 3: Write `apps/mac/Brand/AppIcon.svg`**

Exactly the file in the Interfaces block, including its comment. Nothing else in this step — no Swift, no `Package.swift`.

- [ ] **Step 4: Run and confirm the artwork test passes**

Run: `cd apps/RelayiumKit && swift test --filter AppIconArtworkTests`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing asset test**

`Tests/RelayiumKitTests/AppIconAssetTests.swift` — assert, against `apps/mac/Relayium/Assets.xcassets`. The expected slot table is a literal **in the test**, since there is no artwork module to import:
```swift
import XCTest

final class AppIconAssetTests: XCTestCase {
    // repoRoot as in AppIconArtworkTests.
    private var catalog: URL { repoRoot.appendingPathComponent("apps/mac/Relayium/Assets.xcassets") }
    private var iconSet: URL { catalog.appendingPathComponent("AppIcon.appiconset") }
    /// macOS needs an asset per size — Apple, "Configuring your app icon".
    /// 10 slots over 7 distinct pixel sizes; 32/256/512 are referenced twice.
    private let slots = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1),
                         (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
    private let pixelSizes = [16, 32, 64, 128, 256, 512, 1024]
    private struct Entry: Decodable { let size, scale, idiom: String; let filename: String? }
    private struct Manifest: Decodable { let images: [Entry] }
    private func manifest() throws -> Manifest {
        try JSONDecoder().decode(Manifest.self,
            from: Data(contentsOf: iconSet.appendingPathComponent("Contents.json")))
    }

    func testTenMacSlotsMatchingTheSlotTable() throws {
        let images = try manifest().images
        XCTAssertEqual(images.count, 10)
        XCTAssertTrue(images.allSatisfy { $0.idiom == "mac" })
        XCTAssertEqual(images.map { "\($0.size)@\($0.scale)" }.sorted(),
                       slots.map { "\($0.0)x\($0.0)@\($0.1)x" }.sorted())
        XCTAssertEqual(Set(slots.map { $0.0 * $0.1 }).sorted(), pixelSizes)
    }
    func testEveryFilenameExistsAndSevenAreDistinct() throws {
        let names = try manifest().images.compactMap(\.filename)
        XCTAssertEqual(names.count, 10)
        XCTAssertEqual(Set(names).count, 7)
        for n in Set(names) {
            XCTAssertTrue(FileManager.default.fileExists(atPath: iconSet.appendingPathComponent(n).path), n)
        }
    }
    /// IHDR read directly — width, height, bit depth, colour type. No decoder.
    func testEachPNGHeaderMatchesItsSlot() throws {
        for e in try manifest().images {
            let want = Int(e.size.split(separator: "x")[0])! * Int(e.scale.dropLast())!
            let d = try Data(contentsOf: iconSet.appendingPathComponent(e.filename!))
            func be32(_ o: Int) -> Int { d[o...o+3].reduce(0) { $0 << 8 | Int($1) } }
            XCTAssertEqual(Array(d[1...3]), Array("PNG".utf8))
            XCTAssertEqual(be32(16), want, e.filename!)
            XCTAssertEqual(be32(20), want, e.filename!)
            XCTAssertEqual(d[24], 8, "8-bit depth")
            XCTAssertEqual(d[25], 6, "RGBA colour type")
        }
    }
    /// Alpha topology and colour family at named sample points — never bytes,
    /// because a pixel-exact comparison across macOS rasterizers is fragile.
    func testSquircleTopologyAndColourFamily() throws {
        // rgba(of:) — CGImageSourceCreateWithURL, drawn into an RGBA8
        // premultiplied-last CGContext; at(x,y) is the index math over it.
        let at = try rgba(of: "icon_1024.png")
        XCTAssertEqual(at(4, 4).a, 0, "corner outside the squircle is transparent")
        XCTAssertEqual(at(512, 512).a, 255, "body centre opaque")
        XCTAssertEqual(at(512, 104).a, 255, "straight top edge of the body opaque")
        let c = at(512, 512)
        XCTAssertGreaterThan(c.r, c.g); XCTAssertGreaterThan(c.b, c.g)   // purple family
        let g = at(512, 400)                                             // upper arrow shaft
        XCTAssertTrue(g.r > 200 && g.g > 200 && g.b > 200, "glyph is white")
    }
    func testAccentColorSetAndIconNameAreDeclared() throws {
        let accent = try String(contentsOf:
            catalog.appendingPathComponent("AccentColor.colorset/Contents.json"), encoding: .utf8)
        XCTAssertTrue(accent.contains("0x6D"), "light accent #6d28d9")
        XCTAssertTrue(accent.contains("0x7C"), "dark accent #7c3aed")
        XCTAssertTrue(accent.contains("luminosity"), "a dark appearance variant must be declared")
        let plist = try String(contentsOf:
            repoRoot.appendingPathComponent("apps/mac/Relayium/Info.plist"), encoding: .utf8)
        XCTAssertTrue(plist.contains("<key>CFBundleIconName</key>"))
        XCTAssertTrue(plist.contains("<string>AppIcon</string>"))
    }
    /// The catalog must ship; the artwork source and the renderer must not.
    func testOnlyTheCatalogSitsInsideTheSynchronizedRoot() {
        let fm = FileManager.default
        XCTAssertTrue(catalog.path.hasSuffix("/apps/mac/Relayium/Assets.xcassets"))
        XCTAssertTrue(fm.fileExists(atPath: repoRoot.appendingPathComponent("apps/mac/Brand/AppIcon.svg").path))
        for shipped in ["apps/mac/Relayium/AppIcon.svg", "apps/mac/Relayium/Brand",
                        "apps/mac/Relayium/tools"] {
            XCTAssertFalse(fm.fileExists(atPath: repoRoot.appendingPathComponent(shipped).path),
                           "\(shipped) would be copied into the bundle")
        }
    }
}
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter AppIconAssetTests`
Expected: FAIL — the catalog does not exist; `Contents.json` unreadable.

- [ ] **Step 7: Write the renderer**

`apps/mac/tools/render-app-icon.swift`, a single-file script run by `xcrun swift`, importing only `Foundation`, `CoreGraphics` and `ImageIO` — all system frameworks, all present on any machine that can build this app. It:

1. reads `apps/mac/Brand/AppIcon.svg` (resolved relative to the script's own `#filePath`, so the command works from any directory) and extracts the glyph `d`, the four gradient stops, the stroke width, the body rect and the corner radius **from that file** — it must not carry a second copy of the artwork;
2. for each of the seven pixel sizes, builds a `CGContext` of that edge in sRGB RGBA8, scales the 1024 canvas by `edge/1024`, clips to the rounded-rect body, draws the body linear gradient corner to corner, then the sheen gradient top→bottom over it, then strokes the glyph white with `.round` cap and join. No shadow;
3. writes each PNG with `CGImageDestination` into the directory given as `argv[1]`, plus a `Contents.json` built from the ten-slot table;
4. prints one line per file written.

Include a minimal SVG-subset path parser covering exactly the commands this `d` uses — `M`, `h`, `H`, `l`, and implicit `L` after an `M` — and make it `fatalError` on anything else rather than silently skipping, so a future artwork change cannot render a partial glyph.

`apps/mac/tools/README.md` records the single command, that the seven PNGs are tracked in git as the reviewed artifact, and that **nothing in CI, in `xcodebuild` or in `swift test` runs this script** — regeneration is a human action, so an SVG edit that is never re-rendered is caught by review, not by a build (design Risk 7).

- [ ] **Step 8: Generate the assets**

```bash
xcrun swift apps/mac/tools/render-app-icon.swift \
  apps/mac/Relayium/Assets.xcassets/AppIcon.appiconset
```
Expected: 7 PNGs + `Contents.json` written; the command prints one line per file.

Hand-write `apps/mac/Relayium/Assets.xcassets/Contents.json` (`{"info":{"author":"xcode","version":1}}`) and `AccentColor.colorset/Contents.json` with a universal `any` entry `#6d28d9` and a `luminosity: dark` appearance entry `#7c3aed`, both `sRGB`, components as `"0x6D"/"0x28"/"0xD9"` and `"0x7C"/"0x3A"/"0xED"`, alpha `1.000`.

- [ ] **Step 9: Add `CFBundleIconName` to `Info.plist`**

Insert immediately after `CFBundleIdentifier`, with a comment saying why it is hand-written (a silent `actool` partial-plist merge failure is indistinguishable from a missing icon):
```xml
<key>CFBundleIconName</key>
<string>AppIcon</string>
```

- [ ] **Step 10: Run the asset test and confirm it passes**

Run: `cd apps/RelayiumKit && swift test --filter AppIconAssetTests`
Expected: PASS, 6 tests.

- [ ] **Step 11: Prove the icon reaches a built product**

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/rlm-dd build | tail -3
APP=/tmp/rlm-dd/Build/Products/Debug/Relayium.app
test -f "$APP/Contents/Resources/Assets.car" && echo "Assets.car OK"
plutil -extract CFBundleIconName raw "$APP/Contents/Info.plist"
assetutil --info "$APP/Contents/Resources/Assets.car" | grep -c '"Name" : "AppIcon"'
test ! -e "$APP/Contents/Resources/AppIcon.svg" && echo "artwork source not bundled"
```
Expected: `BUILD SUCCEEDED`; `Assets.car OK`; `AppIcon`; a non-zero count; `artwork source not bundled`.

**If `Assets.car` is absent:** the synchronized-group assumption failed (design Risk 2). Fallback, and only then: add an explicit `PBXFileReference` + `PBXBuildFile` for `Assets.xcassets` into the Resources build phase of `apps/mac/Relayium.xcodeproj/project.pbxproj`, re-run, and **report the deviation in this task's evidence** so Codex reviews a `.pbxproj` edit this plan did not authorize.

- [ ] **Step 12: Record evidence — do not commit**

Record both filtered test runs, the renderer's file list, and the five build-product checks. Confirm in the evidence that `git diff --stat -- apps/RelayiumKit/Package.swift` prints **nothing**. Leave everything in the working tree; no `git add`, no `git commit` (constraint 15).

---

## Task 3: Component vocabulary and the always-visible sidebar

**Files:**
- Create: `apps/mac/Relayium/Components/{DestinationScaffold,SectionCard,EmptyStateView,InlineMessage,SecurityCodeText,StatusBadge}.swift`
- Create: `apps/mac/Relayium/Shell/AppShellView.swift`, `apps/mac/Relayium/Shell/SidebarView.swift`
- Modify: `apps/mac/Relayium/RelayiumApp.swift` — `WindowGroup(id: "main")` → `Window("Relayium", id: "main")`; `TransferQuitGuard` gains `applicationShouldTerminateAfterLastWindowClosed(_:) -> false`; `ContentView()` → `AppShellView()`; `.environmentObject(navigation)`; `@StateObject private var navigation = AppNavigationModel()`; `.defaultSize(width: 1040, height: 700)`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift` + nine `Localizable.strings` (keys 1–15)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/MacSurfaceGuardTests.swift` (created here, extended in Tasks 5 and 7)

**Interfaces — Consumes:** `AppDestination`, `AppNavigationModel` (Task 1).
**Produces:** `DestinationScaffold(title:subtitle:content:)`, `SectionCard(title:content:)`, `EmptyStateView(symbol:title:body:actionTitle:action:)`, `InlineMessage(kind:text:)` with `enum InlineMessage.Kind { case info, warning, failure }`, `SecurityCodeText(code:style:)` with `enum SecurityCodeText.Style { case pairing, verification }`, `StatusBadge(symbol:tint:label:)`, `AppShellView`, `SidebarView`.

**Behavioral invariants:**
- The main scene is `Window("Relayium", id: "main")`. `WindowGroup` disappears from the tree and may not come back: two `WindowGroup` windows would render the same models twice, giving one live transfer two Cancel buttons, and no amount of app-scoped state prevents that. `Window` is macOS 13.0, so the floor is unaffected.
- `MenuBarView.swift:53` keeps `openWindow(id: "main")` **unchanged**; against a unique `Window` it orders the existing window forward instead of creating one.
- `TransferQuitGuard.applicationShouldTerminateAfterLastWindowClosed(_:)` returns `false`, with a comment saying why: the menu bar is the residency surface, the room socket and any running transfer outlive the window, and terminating on window close would kill them. Quit stays ⌘Q, still governed by `applicationShouldTerminate`.
- `AppShellView` renders the `NavigationSplitView` **unconditionally** and contains no `session.state`, no `AccountSession`, no `DisclosureGroup`.
- All five rows are visible at all times, in two sections plus a standalone Account row; each row carries a compact subtitle that may wrap to avoid truncation. Symbols, exactly: Nearby `dot.radiowaves.left.and.right`, Pairing code `number`, Send a link `link.badge.plus`, Open a link `arrow.down.doc`, Account `person.crop.circle`.
- The primary action of every destination carries `.keyboardShortcut(.defaultAction)`; existing `confirmationDialog` roles are unchanged.
- `SecurityCodeText` is the only file under `apps/mac/Relayium` containing `.system(size:` — 34pt `.pairing`, 26pt `.verification`, both monospaced semibold — and sets an accessibility label of the digits separated by spaces (`// nonlocalized: digits`).
- Sidebar: `.navigationSplitViewColumnWidth(min: 208, ideal: 224, max: 288)`. Window: `.frame(minWidth: 860, minHeight: 560)`; default 1040×700.
- `DestinationScaffold` owns the padding, the default 720pt leading-aligned
  reading measure and `.navigationTitle`; Nearby and Account opt out at the
  destination level, then constrain only prose/forms locally so their structured
  rosters and lists can use the remaining width.
- Sidebar footer is **read-only** residency (`StatusBadge` + `nav.residency`); pause/resume stays in Nearby and the menu bar.
- Every `SectionCard` is `.accessibilityElement(children: .contain)` with its title as label. `InlineMessage` and `StatusBadge` always pair colour with an SF Symbol.

- [ ] **Step 1: Write the failing guard test**

`Tests/RelayiumKitTests/MacSurfaceGuardTests.swift` — model the file loader on `IOSSurfaceGuardTests.sources(under:atLeast:)` (whole-line comments stripped, `atLeast:` floor so a rename cannot silently disarm the guard), then:
```swift
final class MacSurfaceGuardTests: XCTestCase {
    private var macRoot: URL { appsRoot.appendingPathComponent("mac/Relayium") }

    func testShellNeverReadsTheSession() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        for s in ["session.state", "AccountSession", "SessionState", "bearerToken"] {
            XCTAssertFalse(shell.contains(s), "the shell must not know about the account: \(s)")
        }
    }
    func testNoDisclosureGroupAndNoMacOS14API() throws {
        let banned = ["DisclosureGroup", "ContentUnavailableView", "onChange(of:initial:)",
                      "@Observable", ".symbolEffect", ".containerRelativeFrame", ".inspector"]
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            for s in banned { XCTAssertFalse(text.contains(s), "\(name) contains \(s)") }
        }
    }
    func testExactlyOneFileCarriesAFixedFontSize() throws {
        XCTAssertEqual(try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains(".system(size:") }.map(\.name),
                       ["Components/SecurityCodeText.swift"])
    }
    func testTheFiveDestinationFilesExist() {
        for f in ["NearbyDestination", "PairingCodeDestination", "StoredSendDestination",
                  "StoredReceiveDestination", "AccountDestination"] {
            XCTAssertTrue(FileManager.default.fileExists(
                atPath: macRoot.appendingPathComponent("Destinations/\(f).swift").path), f)
        }
    }
    /// Constraint 5. `WindowGroup` anywhere means a second window is reachable,
    /// and a second window renders the same live session twice.
    func testNoFileCanCreateASecondWindow() throws {
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            XCTAssertFalse(text.contains("WindowGroup"), "\(name) can open a second window")
        }
    }
    func testTheMainSceneIsUniqueAndSurvivesItsWindowClosing() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("Window(\"Relayium\", id: \"main\")"),
                      "the main scene must be the unique Window scene")
        XCTAssertTrue(app.contains("func applicationShouldTerminateAfterLastWindowClosed"),
                      "closing the unique window must not end the process")
        XCTAssertTrue(app.contains("MenuBarExtra"), "residency stays")
    }
    /// The menu bar is the only way back once the window is closed.
    func testTheMenuBarStillReopensTheSameWindow() throws {
        XCTAssertTrue(try source(named: "MenuBarView.swift").contains("openWindow(id: \"main\")"))
    }
}
```

The `applicationShouldTerminateAfterLastWindowClosed` assertion is a source guard, not a behavioural one: whether the process actually survives is manual-matrix rows in Task 8, and the plan says so rather than implying the test proves it.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter MacSurfaceGuardTests`
Expected: FAIL — `Shell/AppShellView.swift` not found; `DisclosureGroup` present in `ContentView.swift`; no destination files.

- [ ] **Step 3: Add keys 1–15 to `L10nKey` and all nine catalogs**

Add the fifteen cases (`navSectionDirect` … `navResidency`) in a `// MARK: - Navigation` block, each with a doc comment. Then add the same fifteen keys to all nine `Localizable.strings`, translated. English values:
`Direct` / `Links` / `Nearby` / `Devices on this network, no account needed` / `Pairing code` / `Connect across networks with six digits` / `Send a link` / `Store an encrypted file and share the link` / `Open a link` / `Receive a file somebody sent you` / `Account` / `Plan, devices and stored files` / `Relayium destinations` / `A transfer is running here` / `Receiving`.

- [ ] **Step 4: Run localization integrity**

Run: `cd apps/RelayiumKit && swift test --filter "LocalizationIntegrityTests|LocalizationSourceGuardTests"`
Expected: PASS. A missing translation fails here — fix before continuing.

- [ ] **Step 5: Write the six components**

One small `struct View` per file, no behavior beyond layout. `DestinationScaffold` is a `ScrollView` containing a `VStack(alignment: .leading, spacing: 20)` whose first children are the title (`.font(.largeTitle)`) and optional subtitle (`.font(.body).foregroundStyle(.secondary)`), body content below, `.frame(maxWidth: 720, alignment: .leading)`, `.padding(24)`, `.navigationTitle(title)`. `SectionCard` wraps content in a `VStack` on `Color(nsColor: .controlBackgroundColor)` with `.clipShape(RoundedRectangle(cornerRadius: 10))`.

- [ ] **Step 6: Write `SidebarView` and `AppShellView`**

`SidebarView` is a `List(selection:)` bound to `navigation.selection`, `Section(L10n.t(.navSectionDirect))` with the two direct rows, `Section(L10n.t(.navSectionLinks))` with the two link rows, then a plain Account row; each row is a `Label` plus a subtitle `Text(...).font(.caption).foregroundStyle(.secondary)` with `.accessibilityHint(subtitle)`; footer is the residency `StatusBadge`. `AppShellView` is `NavigationSplitView { SidebarView() } detail: { switch navigation.selection { … } }` with a placeholder `EmptyStateView` per destination for now, `.frame(minWidth: 860, minHeight: 560)`.

- [ ] **Step 7: Create the five destination files as thin placeholders**

Each is a `DestinationScaffold` with its title/subtitle and an `EmptyStateView`. They are filled in by Tasks 4–6. This is what lets the guard test go green now rather than at the end of the batch.

- [ ] **Step 8: Make the scene unique and rewire `RelayiumApp`**

Two changes in `apps/mac/Relayium/RelayiumApp.swift`, in this order so each can be built on its own:

1. **The scene.** `WindowGroup(id: "main") {` → `Window("Relayium", id: "main") {`, with a comment naming why: `openWindow(id:)` against a `Window` orders the one window forward, while against a `WindowGroup` it makes another, and two windows would render one live transfer with two Cancel buttons. Add to `TransferQuitGuard`:
```swift
/// The menu bar — not the window — is what makes this Mac reachable. The room
/// socket, an in-flight transfer and `MenuBarExtra` all outlive the window, so
/// closing it must not end the process. Quit is still ⌘Q, still guarded by
/// `applicationShouldTerminate` above.
func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
```
2. **The root.** Add `@StateObject private var navigation = AppNavigationModel()`; replace `ContentView()` with `AppShellView()`; add `.environmentObject(navigation)` to the chain; change `.defaultSize(width: 1040, height: 700)`. **Do not touch** the `.task` blocks, the quit-guard closure wiring, `onOpenURL`, the `init()` construction order or the `MenuBarExtra`.

Delete `apps/mac/Relayium/ContentView.swift` and `apps/mac/Relayium/DirectHubPane.swift` — the routing they carried moves to Task 6, the mode picker to Task 5.

- [ ] **Step 9: Run the guard test and build**

```bash
cd apps/RelayiumKit && swift test --filter MacSurfaceGuardTests
cd - && xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build | tail -3
```
Expected: PASS, 7 tests; `BUILD SUCCEEDED`.

- [ ] **Step 10: Launch it once and look at the window behaviour**

The first point in the batch where the shell exists, so the window claims are cheap to check now and expensive to debug later. Open the built `Relayium.app`, then record what was observed:

- File menu has **no** New Window item; ⌘N does nothing.
- The Window menu never lists two Relayium windows.
- Close the window: the process is still running (`pgrep -x Relayium`) and the menu-bar item is still there.
- Menu bar ▸ open Relayium: the same window comes back, with the sidebar selection it had.

A failure here is a finding to report, not something to work around by restoring `WindowGroup`.

- [ ] **Step 11: Record evidence — do not commit**

Record the guard-test output, the build result and the four observations from Step 10. Leave the changes in the working tree; no `git add`, no `git commit` (constraint 15).

---

## Task 4: Account surface and truthful per-feature gating

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/AccountGate.swift`
- Create: `apps/mac/Relayium/Components/CapabilityGateView.swift`
- Modify: `apps/mac/Relayium/Destinations/AccountDestination.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift` + nine catalogs (keys 16–21)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountGateTests.swift`

**Interfaces — Produces:**
```swift
public struct AccountAccess: Equatable, Sendable { public let token: String; public let retentionSecs: Int64 }
public enum AccountGate: Equatable {
    case allowed(AccountAccess)
    case loading
    case signInRequired
    case unavailable(message: String)
    case verifyEmail(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
    public static func from(_ state: SessionState, bearer: String?) -> AccountGate
}
```
`CapabilityGateView(gate:title:body:onSignIn:)` renders every case except `.allowed` (which it asserts it is never handed).

**Behavioral invariants (the mapping is total over `SessionState`):**

| state | gate | remedy |
|---|---|---|
| `.restoring`, `.authenticating` | `.loading` | spinner + `account.restoring` |
| `.loggedOut`, `.failed` | `.signInRequired` | **Sign in** selects `.account`; Create account opens `AppEnvironment.accountWebURL` |
| `.unavailable(m)` | `.unavailable(m)` | Try again → `session.refresh()` |
| `.emailUnverified(e)` | `.verifyEmail(e)` | Open Relayium |
| `.pendingDeletion(p,t)` | `.pendingDeletion(p,t)` | Reactivate → `AppEnvironment.reactivateWebURL(token:)` |
| `.ready` + non-empty bearer | `.allowed(token, usage.plan.retentionSecs)` | — |
| `.ready` + nil/empty bearer | `.unavailable(L10n.t(.accountBearerInvalid))` | Try again |

- `.ready` with a broken bearer **must never** produce `.signInRequired` — the user *is* signed in.
- `.restoring` **must never** produce `.signInRequired` — a gate that says "sign in" during a 600 ms keychain read is a lie the user acts on.
- `AccountDestination` is the **only** destination file allowed to switch on `session.state`.

- [ ] **Step 1: Write the failing test**

`Tests/RelayiumKitTests/AccountGateTests.swift`:
```swift
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

final class AccountGateTests: XCTestCase {
    /// `.ready` with a `UsageResponse` whose `plan.retentionSecs` is the parameter.
    /// Copy the `NativeUser`/`UsageResponse` construction verbatim from
    /// `AccountSessionTests` rather than inventing a second fixture shape.
    private func ready(retention: Int64 = 86_400) -> SessionState

    func testLoadingStatesNeverAskForSignIn() {
        XCTAssertEqual(AccountGate.from(.restoring, bearer: nil), .loading)
        XCTAssertEqual(AccountGate.from(.authenticating, bearer: nil), .loading)
    }
    func testLoggedOutAndFailedAskForSignIn() {
        XCTAssertEqual(AccountGate.from(.loggedOut, bearer: nil), .signInRequired)
        XCTAssertEqual(AccountGate.from(.failed(message: "bad password"), bearer: nil), .signInRequired)
    }
    func testUnavailableEmailAndDeletionPassThrough() {
        XCTAssertEqual(AccountGate.from(.unavailable(message: "offline"), bearer: "t"),
                       .unavailable(message: "offline"))
        XCTAssertEqual(AccountGate.from(.emailUnverified(email: "a@b.c"), bearer: nil),
                       .verifyEmail(email: "a@b.c"))
        XCTAssertEqual(AccountGate.from(.pendingDeletion(purgeAfter: 9, reactivateToken: "r"), bearer: nil),
                       .pendingDeletion(purgeAfter: 9, reactivateToken: "r"))
    }
    func testReadyWithATokenIsAllowedAndCarriesRetention() {
        XCTAssertEqual(AccountGate.from(ready(retention: 1_209_600), bearer: "tok"),
                       .allowed(AccountAccess(token: "tok", retentionSecs: 1_209_600)))
    }
    /// The row worth naming: signed in, momentarily unreadable bearer.
    func testReadyWithoutATokenIsNeverSignInRequired() {
        for bearer in [nil, ""] as [String?] {
            let gate = AccountGate.from(ready(), bearer: bearer)
            XCTAssertEqual(gate, .unavailable(message: L10n.t(.accountBearerInvalid, language: .en)))
            XCTAssertNotEqual(gate, .signInRequired)
        }
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter AccountGateTests`
Expected: FAIL — `cannot find 'AccountGate' in scope`.

- [ ] **Step 3: Write `AccountGate.swift`**

A `switch state` with no `default`; the `.ready` arm inspects `bearer` and branches to `.allowed` or `.unavailable(L10n.t(.accountBearerInvalid))`. Document the `.ready`-without-bearer arm in a comment naming why `.signInRequired` would be a lie.

- [ ] **Step 4: Run and confirm it passes**

Run: `cd apps/RelayiumKit && swift test --filter AccountGateTests`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add keys 16–21 and translate**

English: `gate.sendLinkTitle` = `Sending a link needs an account`; `gate.sendLinkBody` = `A link stores the encrypted file on Relayium's servers until it expires, so it is billed to an account. Relayium never receives the key. Opening a link somebody sent you needs no account.`; `gate.createCodeTitle` = `Creating a code needs an account`; `gate.createCodeBody` = `Creating a code reserves relay capacity that is billed to the account that created it. Joining a code somebody else created needs no account.`; `gate.signIn` = `Sign in`; `gate.createAccount` = `Create an account`. Add to all nine catalogs. The load-bearing final clause ("needs no account") must survive translation in all nine.

- [ ] **Step 6: Write `CapabilityGateView` and fill in `AccountDestination`**

`CapabilityGateView` renders a `SectionCard` containing an `EmptyStateView` whose action is the gate's remedy: `.signInRequired` → **Sign in** (calls `onSignIn`, which the caller wires to `navigation.select(.account)`) plus a link button to `AppEnvironment.accountWebURL`; `.loading` → `ProgressView` + `L10n.t(.accountRestoring)`; `.unavailable` → `InlineMessage(.failure, message)` + Try again; `.verifyEmail` → Open Relayium; `.pendingDeletion` → Reactivate with the tokenised URL.

`AccountDestination` moves the whole `session.state` switch out of the deleted `ContentView`: `.loggedOut/.authenticating/.failed` render `LoginView` in **one** `VStack` branch (preserving its `@State` across all three transitions — keep the original comment), `.restoring` a spinner, `.unavailable` the retry pair, `.emailUnverified`/`.pendingDeletion` the notice views, `.ready` the existing `AccountView(user:usage:)` inside `DestinationScaffold`.

- [ ] **Step 7: Build and run the whole suite**

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -5
cd - && xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build | tail -3
```
Expected: `0 failures`, 1 skipped; `BUILD SUCCEEDED`.

- [ ] **Step 8: Record evidence — do not commit**

Record the full-suite tail and the build result. Leave the changes in the working
tree; no `git add`, no `git commit` (constraint 15).

---

## Task 5: Nearby and pairing-code destinations with one live-session owner

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/TransferPresence.swift`
- Modify: `apps/mac/Relayium/Destinations/NearbyDestination.swift`, `Destinations/PairingCodeDestination.swift`
- Modify: `apps/mac/Relayium/NearbyPane.swift` (drop `@Binding var sessionActive`, read presence), `DirectPane.swift` and `RealtimeTextPane.swift` (take `AccountGate` instead of `token: String`), `RealtimeFileSessionView.swift`, `RealtimeTextSessionView.swift` (use `SecurityCodeText`)
- Modify: `apps/mac/Relayium/RelayiumApp.swift` (`@StateObject private var presence = TransferPresence()` + `.environmentObject(presence)`)
- Modify: `L10nKey.swift` + nine catalogs (keys 22, 23, 25–27)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/TransferPresenceTests.swift`; extend `MacSurfaceGuardTests`

**Interfaces — Consumes:** `AppDestination` (Task 1), `AccountGate` (Task 4).
**Produces:**
```swift
public enum TransferMode: Equatable, CaseIterable, Sendable { case files, text }
@MainActor public final class TransferPresence: ObservableObject {
    @Published public private(set) var owner: AppDestination?
    @Published public var mode: TransferMode
    public init(mode: TransferMode = .files)
    @discardableResult public func claim(_ destination: AppDestination, mode: TransferMode) -> Bool
    public func release(_ destination: AppDestination)
    public func releaseAll()
    public func rendersSession(_ destination: AppDestination) -> Bool
}
```

**Behavioral invariants:**
- A claim by the current owner is idempotent and returns `true`; a claim by a different destination while one is held is **refused** (`false`) and does not change `owner` or `mode`.
- `release(d)` only clears when `d` is the owner. `releaseAll()` always clears.
- `rendersSession` is true for **exactly one** destination whenever `owner != nil`, and false for all five when it is `nil`.
- An incoming nearby session claims `.nearby` and sets `mode` from `AppRouting`'s kind (`.file` → `.files`, `.text` → `.text`).
- The non-owning destination shows `presence.busyTitle`/`presence.busyBody` with a **Show it** button that selects the owner — never a second copy of the session with its own Cancel.
- Presence answers exactly one question — *which of the two direct destinations presents the live session inside the unique window* — and is not, and cannot be, a defence against a second window; constraint 5 is what makes a second window impossible. Presence is app-scoped so it survives the window's view tree; the reveal is `.task(id: nearbyReceive.activeKind)`, never `onChange`, so a window closed and reopened mid-receive still lands on it.
- The files/text choice stays a **mode within** these two destinations, not a sixth destination.
- `NearbyDestination` contains no `AccountSession` and no `bearerToken`; `PairingCodeDestination` reads the gate for the **create** half only — the join field and its Join button are rendered and enabled identically signed out.
- Nearby's four states are all designed, not implicit: empty = empty roster / no staged files; loading = joining the room and re-scanning; failure = the reconnecting banner, `receive.lastFailure` and the staging error; active = the live file or text session. Pairing code's failure state renders `.failed`'s message inline, and its loading state is `direct.creatingCode`.

- [ ] **Step 1: Write the failing test**

`Tests/RelayiumKitTests/TransferPresenceTests.swift`:
```swift
@MainActor
final class TransferPresenceTests: XCTestCase {
    func testNobodyRendersASessionWhenIdle() {
        let p = TransferPresence()
        XCTAssertNil(p.owner)
        for d in AppDestination.allCases { XCTAssertFalse(p.rendersSession(d)) }
    }
    func testClaimIsIdempotentForTheOwner() {
        let p = TransferPresence()
        XCTAssertTrue(p.claim(.nearby, mode: .files))
        XCTAssertTrue(p.claim(.nearby, mode: .files))
        XCTAssertEqual(p.owner, .nearby)
    }
    func testASecondDestinationIsRefusedAndChangesNothing() {
        let p = TransferPresence()
        p.claim(.nearby, mode: .text)
        XCTAssertFalse(p.claim(.pairingCode, mode: .files))
        XCTAssertEqual(p.owner, .nearby)
        XCTAssertEqual(p.mode, .text)
    }
    func testExactlyOneDestinationRendersTheSession() {
        let p = TransferPresence()
        p.claim(.pairingCode, mode: .files)
        XCTAssertEqual(AppDestination.allCases.filter { p.rendersSession($0) }, [.pairingCode])
    }
    func testOnlyTheOwnerCanReleaseAndReleaseAllAlwaysClears() {
        let p = TransferPresence()
        p.claim(.nearby, mode: .files)
        p.release(.pairingCode)
        XCTAssertEqual(p.owner, .nearby, "a non-owner must not be able to clear the session")
        p.release(.nearby)
        XCTAssertNil(p.owner)
        p.claim(.pairingCode, mode: .text); p.releaseAll()
        XCTAssertNil(p.owner)
    }
    func testIncomingClaimsNearbyAndSetsTheModeFromItsKind() {
        for (kind, mode) in [(NearbyReceiveKind.file, TransferMode.files), (.text, .text)] {
            let p = TransferPresence()
            XCTAssertTrue(p.claim(AppRouting.destination(forIncoming: kind), mode: mode))
            XCTAssertEqual(p.owner, .nearby)
            XCTAssertEqual(p.mode, mode)
        }
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter TransferPresenceTests`
Expected: FAIL — `cannot find 'TransferPresence' in scope`.

- [ ] **Step 3: Write `TransferPresence.swift`**

`claim` returns `owner == nil || owner == destination`, assigning only in that case. `rendersSession(d)` is `owner == d`. Comment that this stops the *rendering* from forking; the models already refuse a second session.

- [ ] **Step 4: Run and confirm it passes**

Run: `cd apps/RelayiumKit && swift test --filter TransferPresenceTests`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add keys 22, 23, 25–27 and translate**

English: `nearby.noAccountNeeded` = `Sending and receiving on this network needs no account.`; `direct.joinNoAccountNeeded` = `Joining a code somebody else created needs no account.`; `presence.busyTitle` = `A transfer is already running`; `presence.busyBody` = `Nearby and Pairing code share one session, so it is shown where it started.`; `presence.showIt` = `Show it`. All nine catalogs.

- [ ] **Step 6: Rewrite the two destinations**

`NearbyDestination`: `DestinationScaffold` → a mode `Picker` (segmented, `L10n.t(.hubTransferType)`, disabled while busy) → `SectionCard` with `NearbyPane` (roster + staging) → the verification toggle card (moved verbatim from the deleted `DirectHubPane.verificationSetting`) → `InlineMessage(.info, L10n.t(.nearbyNoAccountNeeded))`. Empty roster renders `EmptyStateView(symbol: "dot.radiowaves.left.and.right", title: L10n.t(.nearbyEmptyRoster), …)`. A live session renders `RealtimeFileSessionView`/`RealtimeTextSessionView` **only when** `presence.rendersSession(.nearby)`; otherwise the busy card. `.task(id: receive.activeKind)` claims `.nearby` and sets the mode.

`PairingCodeDestination`: a create `SectionCard` whose content is `CapabilityGateView(gate: gate, title: L10n.t(.gateCreateCodeTitle), body: L10n.t(.gateCreateCodeBody), onSignIn: { navigation.select(.account) })` when the gate is not `.allowed`, and the mint control (`mintCode(token:)` with the `.allowed` token) when it is; a **join** `SectionCard` that never consults the gate, with the code field, `SecurityCodeText` for a minted code, the QR, and `InlineMessage(.info, L10n.t(.directJoinNoAccountNeeded))`. A live session renders only when `presence.rendersSession(.pairingCode)`.

Change `DirectPane`/`RealtimeTextPane` from `let token: String` to `let gate: AccountGate`, deleting `.disabled(token.isEmpty)` (`UploadPane.swift:26`'s pattern) and `RealtimeTextPane`'s hand-rolled `if token.isEmpty` hint. `NearbyPane` drops `@Binding var sessionActive` and calls `presence.claim/.release`.

- [ ] **Step 7: Consolidate the four fixed font sizes**

Replace the `.system(size:` sites at `DirectPane.swift:92`, `RealtimeTextPane.swift:84`, `RealtimeFileSessionView.swift:52`, `RealtimeTextSessionView.swift:53` with `SecurityCodeText(code:style:)`.

- [ ] **Step 8: Extend `MacSurfaceGuardTests`**

```swift
func testAnonymousDestinationsHoldNoAccountReference() throws {
    for f in ["Destinations/NearbyDestination.swift", "Destinations/StoredReceiveDestination.swift"] {
        let text = try source(named: f)
        for symbol in ["AccountSession", "bearerToken", "session.state", "AccountGate"] {
            XCTAssertFalse(text.contains(symbol), "\(f) must not depend on an account: \(symbol)")
        }
    }
}
```
(`StoredReceiveDestination` is still a placeholder here and passes trivially; Task 6 keeps it passing.)

- [ ] **Step 9: Run the suite and build**

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -5
cd - && xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build | tail -3
```
Expected: `0 failures`, 1 skipped; `BUILD SUCCEEDED`.

- [ ] **Step 10: Record evidence — do not commit**

Record the full-suite tail, the build result and the extended guard test's output.
Leave the changes in the working tree; no `git add`, no `git commit`
(constraint 15).

---

## Task 6: Stored send, stored receive, and deep-link/incoming routing

**Files:**
- Modify: `apps/mac/Relayium/Destinations/StoredSendDestination.swift`, `Destinations/StoredReceiveDestination.swift`
- Modify: `apps/mac/Relayium/UploadPane.swift` (take `AccountGate`; drop `.disabled(token.isEmpty)`), `DownloadPane.swift` (designed empty/loading/failure states replacing `EmptyView()` at `DownloadPane.swift:19-20`)
- Modify: `apps/mac/Relayium/Shell/AppShellView.swift` (deep-link + incoming routing)
- Modify: `L10nKey.swift` + nine catalogs (keys 24, 28, 29)
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AnonymousCapabilityTests.swift`

**Interfaces — Consumes:** `AppRouting`, `AppNavigationModel`, `AccountGate`, `AccountAccess`, `TransferPresence`, `DestinationScaffold`, `SectionCard`, `EmptyStateView`, `InlineMessage`, `CapabilityGateView`.

**Behavioral invariants:**
- `https://relayium.com/d/<id>#k=…` → `.storedReceive`, `downloadModel.linkText` set, `resolve()` called.
- `https://relayium.com/cross-network#c=<code>` → `.pairingCode`, and **both** `realtimeModel.updateJoinCode` and `realtimeTextModel.updateJoinCode` are called, because a code does not reveal files-vs-text.
- An unsolicited nearby session selects `.nearby` via `.task(id: nearbyReceive.activeKind)`. If it started while the unique window was closed, the arrival is reported by the existing notification and the menu bar — this slice does not claim the app raises a closed window by itself — and reopening lands on `.nearby` with the session on screen, because the models and the selection are app-scoped and the reveal is `.task(id:)` rather than `onChange`.
- Each handler performs exactly **one** `navigation.select(...)` derived from `AppRouting`; neither reads the other's state, cancels a session, or clears the other's pending work. Every field-population side effect is idempotent. A pairing-code deep link arriving while a nearby session is live changes only the selection.
- `StoredSendDestination` applies `uploadModel.applyRetentionCap(access.retentionSecs)` from `.allowed` via `.task(id:)` (never `onChange(of:initial:)`).
- `StoredReceiveDestination` contains **no** `AccountSession`, `bearerToken` or `AccountGate`.
- Anonymous proof is transport-level: no `Authorization` header, no credential in the URL, on stored-link **resolve and download**, the nearby ICE fetch, and a pairing-code join.

- [ ] **Step 1: Write the failing anonymous-capability test**

`Tests/RelayiumKitTests/AnonymousCapabilityTests.swift`, built on the existing `StubURLProtocol` and `FakeWebSocketChannel` helpers in `Tests/RelayiumKitTests/Support/`:
```swift
final class AnonymousCapabilityTests: XCTestCase {
    /// Every request the stub saw, so a header cannot hide in a request the
    /// assertion forgot to look at.
    private func assertNoCredential(_ requests: [URLRequest], count: Int,
                                    file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(requests.count, count, "unaccounted requests", file: file, line: line)
        for r in requests {
            XCTAssertNil(r.value(forHTTPHeaderField: "Authorization"), file: file, line: line)
            XCTAssertNil(r.url?.user, file: file, line: line)
            XCTAssertNil(r.url?.password, file: file, line: line)
            XCTAssertFalse(r.url?.query?.contains("token") ?? false, file: file, line: line)
        }
    }

    /// Built through AppEnvironment with NO session object in scope at all.
    func testStoredLinkResolveAndDownloadCarryNoCredential() async throws {
        StubURLProtocol.reset()                     // stubs GET /api/d/<id> meta + blob
        let model = AppEnvironment.makeDownloadModel(baseURL: stubBaseURL)
        model.linkText = "https://relayium.com/d/abc#k=<fixture key>"
        model.resolve(); try await settle(model)
        model.download(into: FileManager.default.temporaryDirectory)
        try await settle(model)
        XCTAssertNotNil(model.received)
        assertNoCredential(StubURLProtocol.observed, count: 2)   // meta + blob, all of them
    }

    func testNearbyICEFetchCarriesNoCredentialAndDropsTURN() async throws {
        StubURLProtocol.reset()
        let servers = try await ICEClient(baseURL: stubBaseURL, session: stubSession).fetch()
        assertNoCredential(StubURLProtocol.observed, count: 1)
        XCTAssertFalse(nearbyICEServers(servers).contains {
            $0.urlStrings.contains { $0.hasPrefix("turn:") || $0.hasPrefix("turns:") }
        }, "the nearby path must never relay")
    }

    func testPairingCodeJoinConsultsNoAccount() async throws {
        StubURLProtocol.reset()
        let channel = FakeWebSocketChannel()
        let model = makeRealtimeModel(channel: channel, baseURL: stubBaseURL)  // no token
        await model.join(code: "123456")
        XCTAssertTrue(channel.isOpen, "the signaling channel must open with no account")
        XCTAssertEqual(model.state, .connecting)
        assertNoCredential(StubURLProtocol.observed, count: 1)   // the ICE fetch, nothing else
    }
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/RelayiumKit && swift test --filter AnonymousCapabilityTests`
Expected: FAIL — the test bodies are unimplemented / the stub records nothing yet.

- [ ] **Step 3: Add request observation to the test support layer**

Give `Tests/RelayiumKitTests/Support/StubURLProtocol.swift` a static `observed: [URLRequest]` that every intercepted request appends to, plus `reset()`; stub `GET /api/d/<id>` meta, the blob route (fixture bytes), and `GET /api/ice`. Add `settle(_:)` — poll the model's `state` off `.idle`/`.resolving` with a bounded timeout. **No production change should be needed.** If one is, that is a finding: record it and stop rather than weakening an assertion to fit.

If the expected request counts (2 and 1) do not match reality, correct the count to the observed number **and name each request in a comment** — the point of the count is that no request escapes the assertion, not that it is a particular number.

- [ ] **Step 4: Run and confirm it passes**

Run: `cd apps/RelayiumKit && swift test --filter AnonymousCapabilityTests`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add keys 24, 28, 29 and translate**

English: `download.noAccountNeeded` = `Opening a link somebody sent you needs no account.`; `download.idleHint` = `Paste a Relayium link. The key stays in the link and never reaches Relayium's servers.`; `storedSend.idleTitle` = `Nothing chosen yet`. All nine catalogs.

- [ ] **Step 6: Fill in the two destinations**

`StoredSendDestination`: `DestinationScaffold` → `CapabilityGateView` when the gate is not `.allowed`; when it is, a selection `SectionCard` (`FileDropZone` + `NSOpenPanel`, `EmptyStateView(storedSend.idleTitle, upload.dropHint)` when empty), a TTL/burn card, an uploading card with percent + Cancel, a failure card (`InlineMessage(.failure)` + Try again), and the link-ready card with its key notice. `.task(id: access.retentionSecs) { uploadModel.applyRetentionCap(access.retentionSecs) }`.

`StoredReceiveDestination`: `DestinationScaffold` → a paste `SectionCard` with `EmptyStateView` carrying `download.idleHint` when nothing is pasted, `ProgressView` while resolving, the manifest card, the download progress card, `ReceivedResultView` when saved (reveal-in-Finder and drag-out preserved), `InlineMessage(.failure)` for a bad link, and `InlineMessage(.info, L10n.t(.downloadNoAccountNeeded))` at the foot. No account symbol anywhere in the file.

- [ ] **Step 7: Add routing to `AppShellView`**

```swift
.onReceive(deepLinks.$pending.compactMap { $0 }) { link in
    navigation.select(AppRouting.destination(for: link))   // the ONLY selection write
    switch link {
    case .download(let url):
        downloadModel.linkText = url.absoluteString
        downloadModel.resolve()
    case .realtime(let code):
        // A code does not reveal files-vs-text, so populate both models.
        if let code { realtimeModel.updateJoinCode(code); realtimeTextModel.updateJoinCode(code) }
    }
    deepLinks.consume()
}
.task(id: nearbyReceive.activeKind) {
    guard let kind = nearbyReceive.activeKind else { return }
    navigation.select(AppRouting.destination(forIncoming: kind))
    presence.claim(.nearby, mode: kind == .file ? .files : .text)
}
```
Nothing else is mutated by either handler.

**The closed-window case (design Risk 5).** Both handlers live in the window's
content, so a URL arriving while the unique window is closed depends on SwiftUI
reopening the scene to deliver it. Task 8's manual rows exercise deep links with
the window **open and closed** precisely to find out. If a closed-window deep
link does not reach `onOpenURL`, the bounded fallback is the pattern this file
already uses for the quit guard — the window scene's existing `.task` hands
`TransferQuitGuard` a closure, and `application(_:open:)` calls it to bring the
unique window forward before forwarding the URL to the app-scoped
`AppDeepLinkRouter`. Restoring `WindowGroup` is **not** an acceptable remedy: it
trades an edge case for a rendering defect on the main path. If the fallback is
needed, implement it and report it as a plan deviation in the evidence.

- [ ] **Step 8: Run the suite and build**

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -5
cd - && xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build | tail -3
```
Expected: `0 failures`, 1 skipped; `BUILD SUCCEEDED`.

- [ ] **Step 9: Record evidence — do not commit**

Record the full-suite tail and the build result. Leave the changes in the working
tree; no `git add`, no `git commit` (constraint 15).

---

## Task 7: Copy removals, source guards, truthful docs and the Native-versus-Web method

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift` (remove 5 cases)
- Modify: nine `Localizable.strings` (remove the same 5 keys from each)
- Modify: `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift`
- Modify: `apps/RelayiumKit/Tests/RelayiumKitTests/MacSurfaceGuardTests.swift`
- Modify: `apps/README.md` (§ Localization, § Manual acceptance; the `380pt` line at `apps/README.md:302`), root `README.md`, `apps/mac/release-readiness.json`

**Behavioral invariants:**
- `content.haveLink`, `content.nearbyOrCode`, `tab.direct`, `tab.link`, `text.signInToCreate` leave the enum **and** all nine catalogs in one commit. `tab.account` and `tab.receive` **stay** — `RootView` and `AccountTab` in `apps/ios/Relayium` render them, and `LocalizationIntegrityTests` fails in both directions.
- The two gate bodies and the three "no account needed" lines render translated in all nine languages and keep their load-bearing final clause.
- The five destination names are non-empty and pairwise distinct in all nine.
- Every documentation string that asserts a 380 pt minimum width is corrected to 860×560.
- No doc, readiness string or report calls this result launched/complete/shipped/publicly available; the same rule binds Codex's delivery commit message in Task 9.
- **No predicted or projected figure appears in any repository document.** This task writes the benchmark *method* and nothing numeric; Task 8 appends observations only.
- `release-readiness.json` stays `"approved": false` and no capability's `implemented` flips.

- [ ] **Step 1: Write the failing copy and truthfulness tests**

Extend `LocalizedCopyTests`:
```swift
func testGateBodiesKeepTheirLoadBearingClauseInEveryLanguage() {
    for lang in AppLanguage.allCases {
        for key in [L10nKey.gateSendLinkBody, .gateCreateCodeBody,
                    .nearbyNoAccountNeeded, .directJoinNoAccountNeeded, .downloadNoAccountNeeded] {
            let s = L10n.t(key, language: lang)
            XCTAssertFalse(s.isEmpty, "\(lang) \(key)")
            if lang != .en { XCTAssertNotEqual(s, L10n.t(key, language: .en), "\(lang) \(key) untranslated") }
        }
        // The clause the whole slice turns on, asserted per language against the
        // known translation of "no account" (table in the test file).
        XCTAssertTrue(L10n.t(.gateCreateCodeBody, language: lang)
            .contains(noAccountPhrase[lang]!), "\(lang) drops the anonymous half")
    }
}

func testDestinationNamesAreDistinctInEveryLanguage() {
    for lang in AppLanguage.allCases {
        let names = [L10nKey.navNearby, .navPairingCode, .navStoredSend, .navStoredReceive, .navAccount]
            .map { L10n.t($0, language: lang) }
        XCTAssertFalse(names.contains(where: \.isEmpty), "\(lang)")
        XCTAssertEqual(Set(names).count, 5, "\(lang) reuses a destination name")
    }
}
```
Extend `MacSurfaceGuardTests`:
```swift
func testNoLaunchClaimInDocs() throws {
    let claims = ["now launched", "publicly available", "generally available",
                  "production release", "the macOS app is complete", "ready for launch"]
    for path in ["README.md", "apps/README.md", "apps/mac/release-readiness.json"] {
        let text = try String(contentsOf: repoRoot.appendingPathComponent(path), encoding: .utf8).lowercased()
        for claim in claims { XCTAssertFalse(text.contains(claim), "\(path) claims launch: \(claim)") }
    }
    let json = try String(contentsOf: repoRoot.appendingPathComponent("apps/mac/release-readiness.json"),
                          encoding: .utf8)
    XCTAssertTrue(json.contains("\"approved\": false"))
}

func testNoDocumentAssertsTheOldMinimumWidth() throws {
    for path in ["README.md", "apps/README.md", "apps/mac/release-readiness.json"] {
        let text = try String(contentsOf: repoRoot.appendingPathComponent(path), encoding: .utf8)
        XCTAssertFalse(text.contains("380pt"), "\(path) still asserts the old floor")
    }
}

/// Constraint 13. A repository document may carry a number only if somebody
/// watched it happen; a hypothesis belongs in the design, not in the tree.
func testNoDocumentPublishesAPredictedFigure() throws {
    for path in ["README.md", "apps/README.md", "apps/mac/release-readiness.json"] {
        let text = try String(contentsOf: repoRoot.appendingPathComponent(path),
                              encoding: .utf8).lowercased()
        for word in ["predicted", "projected", "estimated", "expected count"] {
            XCTAssertFalse(text.contains(word), "\(path) publishes an unobserved figure: \(word)")
        }
    }
}
```

- [ ] **Step 2: Run and confirm they fail**

Run: `cd apps/RelayiumKit && swift test --filter "LocalizedCopyTests|MacSurfaceGuardTests"`
Expected: FAIL — `apps/README.md:302` and two `release-readiness.json` evidence strings still say `380pt`.

- [ ] **Step 3: Remove the five dead keys**

Delete the five `L10nKey` cases and their entries from all nine catalogs. Run `swift test --filter LocalizationIntegrityTests` — it fails on a catalog key nothing references *and* on a referenced key no catalog defines, so it is the check that the removal was symmetric.

- [ ] **Step 4: Correct the documentation**

- `apps/README.md:302` and the § Manual acceptance prose: `380pt minimum width` → `860×560 minimum window`.
- `apps/README.md § macOS app`: describe the five-destination sidebar, the anonymous destinations, the icon, and state plainly that the result is an **engineering build**, not a launch.
- Root `README.md`: correct any macOS description that implies a tabbed, sign-in-first app; add no download or availability claim.
- `apps/mac/release-readiness.json`: keep `"approved": false`; correct the two evidence strings that assert `380pt`; add no new capability id and flip no `implemented`.

- [ ] **Step 5: Add the Native-versus-Web *method* to `apps/README.md` — and no figures**

A new `### Native versus Web` subsection under § macOS app containing the
**method only**:

> Count user actions — clicks, keystroke runs (one field entry = one), drags,
> panel confirmations, window switches — from *app or browser at rest* to *task
> complete*, three times per workflow: today's Web client at `relayium.com`, the
> macOS build at baseline `6bd7c61b`, and this build. Record signed-out
> reachability and the native mechanism carrying the difference.

Then a single line: *Results are recorded below once measured.* **Write no
numbers in this step** (constraint 13). Task 8 measures the three clients and
appends only what it observed; any workflow it could not measure is written down
as not measured, with the reason. The design document holds a pre-measurement
hypothesis table for the reviewer's benefit; it is internal, it stays in the
design, and copying any of its figures into `apps/README.md` is a truthfulness
regression, not a shortcut.

State explicitly, in the same subsection, what this slice does **not** claim to beat the Web at: large or slow transfers (no background `URLSession` — a transfer dies with the app, which the quit guard warns about rather than fixes), any workflow starting outside the app (no Share extension, Services entry, Dock drop target or Quick Action), and resumable transfer.

- [ ] **Step 6: Run the suite and the readiness gates**

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -5
cd - && node apps/mac/scripts/check-release-readiness.mjs
bash apps/mac/scripts/test-release-readiness.sh
```
Expected: `0 failures`, 1 skipped; `macOS release readiness valid; N blocker(s) remain` (still unapproved); the shell test passes.

- [ ] **Step 7: Record evidence — do not commit**

Record the suite tail and both readiness outputs, plus a grep proving no figure
from the design's hypothesis table reached `apps/README.md`. Leave the changes in
the working tree; no `git add`, no `git commit` (constraint 15).

---

## Task 8: Full validation, and handoff to Codex

**Files:** no source change expected. Any fix this task forces is made in the working tree, re-runs every gate below from the top, and is called out in the handoff — it does not get "its own commit", because Claude makes no commits (constraint 15).

**Behavioral invariants:**
- Every number recorded in `apps/README.md` in this task is one that was **observed** on this tree. A gate that was not run is reported as not run, never as passing.
- Every manual row is reported as exactly one of **run** (with what was seen), **failed** (with what was seen), or **unavailable** (with the missing hardware, peer, account or credential named). "Unavailable" is a legitimate, reportable outcome; a silently dropped row is not.
- Nothing here assumes a second Mac, a non-Retina display, a peer device, a real account, a live `#k=` link, network reachability to `relayium.com`, or Apple credentials. Each is checked for, and its absence is recorded.
- At the end of this task the working tree is **dirty on purpose**, containing exactly the intended files. Claude reports; Codex commits.

**Execution record (2026-08-03).** Written after the pass, against what was
actually observed. Full evidence is in `apps/README.md` §
"Slice evidence (2026-08-03)".

| step | status |
|---|---|
| 1 Full Swift suite | **done** — `Executed 845 tests, with 1 test skipped and 0 failures` after the QA fixes |
| 2 Universal build + `lipo` | **done** — `BUILD SUCCEEDED`; `universal OK` |
| 3 Icon/plist on the product | **done** — `Assets.car OK`; `AppIcon`; all seven pixel sizes, after correcting the plan's grep window (see deviation 1) |
| 4 Localization on the product | **done** — 9 `.lproj`; the nine-element `CFBundleLocalizations` array |
| 5 Sandbox on a signed Debug build | **done** — `app-sandbox` present; entitlement plist byte-identical to a `6bd7c61b` build |
| 5b iOS builds | **done** — both `BUILD SUCCEEDED`; the product scheme is `RelayiumKit`, as the plan assumed |
| 6 Readiness and repository gates | **done** — readiness valid and still unapproved; `git diff --check` silent; scope-breach diff empty |
| 7 Signed CI / DMG | **not run — Codex's (Task 9)**, as the plan requires |
| 8 Visual and manual matrix | **done** — all 27 rows recorded: 13 run, 1 failed (20), 13 unavailable; rows 4, 5 and 12 were re-run after fixes |
| 9 Six-workflow benchmark | **not completed** — no workflow was carried to completion on any client, so every cell is recorded as not measured with its reason. Decision 3's revisit therefore did **not** fire |
| 10 Screenshots | **partial** — the five destinations in `en`/`ar` and light/dark at 1040×700, plus the floor, full screen, deep-link, restoring and paused states, in `/tmp/rlm-task8-shots-xlcooQ`. The two gates, the busy card and a live session were **not** captured: they need a signed-out app or a peer |
| 11 Record evidence in the tree | **done** — one `### Slice evidence (2026-08-03)` subsection in `apps/README.md` |
| 12 Self-review and handoff | **done** — no commit, no push |

**Deviations from this plan.**

1. **A wrong gate command, corrected.** Step 3's `assetutil --info … | grep -A2
   '"Name" : "AppIcon"'` cannot work: `PixelWidth` is four lines below the match,
   so the literal command prints nothing. Widening the window returns all seven
   sizes. The artifact was correct throughout.
2. **Two files outside the manifest, on purpose.**
   `Sources/RelayiumAppKit/RealtimeSessionModel.swift` and
   `Tests/RelayiumKitTests/RealtimeSessionModelTests.swift` carry a data-loss fix
   found by runtime QA in this pass — a late transport `onError`/`onClose`
   callback discarding an already-completed receive — plus its regression tests.
3. **One more file outside the manifest.** `apps/mac/Relayium/LoginView.swift`
   moves its two failure messages onto the slice's `InlineMessage` component, so
   they pair colour with a symbol. Not listed in the manifest; in scope for the
   component vocabulary.
4. **Two untracked documents outside Step 6's exactness list.** This plan and its
   design spec are new files under `docs/superpowers/`, which is a tracked
   convention in this repository (170 files) but is not enumerated in Step 6.
   Codex decides whether they join the delivery commit.
5. **Step 20's command does not route on this machine.** The plan's literal
   `open 'https://relayium.com/…'` reaches the default browser, not the app. The
   row is recorded as failed on the documented command, with the direct
   `open -a <app> <url>` result recorded beside it.
6. **The absolute direction-override ban was too broad.** A normal Arabic launch
   proved that `CFBundleLocalizations` plus package-backed catalogs selected the
   right copy but left the macOS scene LTR. Both scene roots now share exactly
   one direction derived from `L10n.current`; no destination or component forces
   its own direction. The regular `AppleLanguages = [ar]` path was re-run and
   observed mirrored, with the pairing digits still LTR.

- [ ] **Step 1: Full Swift suite**

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -8
```
Expected: `Executed N tests, with 0 failures`, 1 skipped (`TokenStoreTests` opt-in keychain round trip). Record `N`.

- [ ] **Step 2: Unsigned universal build + architecture check**

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/rlm-universal build | tail -3
APP=/tmp/rlm-universal/Build/Products/Debug/Relayium.app
lipo "$APP/Contents/MacOS/Relayium" -verify_arch arm64 x86_64 && echo "universal OK"
```
Expected: `BUILD SUCCEEDED`; `universal OK`.

- [ ] **Step 3: Icon and plist validation on the built product**

```bash
test -f "$APP/Contents/Resources/Assets.car" && echo "Assets.car OK"
plutil -extract CFBundleIconName raw "$APP/Contents/Info.plist"
assetutil --info "$APP/Contents/Resources/Assets.car" \
  | grep -A2 '"Name" : "AppIcon"' | grep -Eo '"PixelWidth" : [0-9]+' | sort -u
```
Expected: `Assets.car OK`; `AppIcon`; all seven of 16, 32, 64, 128, 256, 512, 1024.

- [ ] **Step 4: Localization validation on the built product**

```bash
ls "$APP/Contents/Resources/RelayiumKit_RelayiumAppKit.bundle/Contents/Resources" | grep -c lproj
plutil -extract CFBundleLocalizations json -o - "$APP/Contents/Info.plist"
```
Expected: `9`; the nine-element array `en, zh-Hans, ja, ko, de, fr, ar, es, pt`.

- [ ] **Step 5: Sandbox check on a plain Debug build**

`CODE_SIGNING_ALLOWED=NO` skips entitlements, so this needs its own build:
```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -derivedDataPath /tmp/rlm-signed build | tail -3
codesign -d --entitlements - /tmp/rlm-signed/Build/Products/Debug/Relayium.app 2>&1 | grep app-sandbox
```
Expected: `BUILD SUCCEEDED`; a line containing `com.apple.security.app-sandbox`. The entitlement set must be **identical** to the pre-slice one — diff it against `apps/mac/Relayium/Relayium.entitlements` and confirm no key was added.

- [ ] **Step 5b: iOS builds, because this slice edits shared code**

`L10nKey` and the nine catalogs live in `RelayiumAppKit`, which the iOS app
compiles against: five keys are removed and twenty-nine added, and
`RelayiumAppKit` view/model code is touched. macOS-only gates cannot see an iOS
break, and CI's `ios-build` job would find it only after the delivery commit.
Both of these run locally, before handoff:

```bash
# 1. The shared package, built for a generic iOS device.
cd apps/RelayiumKit && xcodebuild -list          # name the product scheme it prints
xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/rlm-kit-ios build | tail -3
cd -

# 2. The iOS app, unsigned — the same invocation as CI's ios-build job.
xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/rlm-dd-ios CODE_SIGNING_ALLOWED=NO build | tail -3
```
Expected: `BUILD SUCCEEDED` twice. If `xcodebuild -list` prints a different
product scheme name, use the printed one and **record which was used**. If the
iOS SDK is not installed on this machine, that is an *unavailable* gate: say so
explicitly in the handoff and flag that CI's `ios-build` job is then the first
thing that exercises iOS.

- [ ] **Step 6: Readiness and repository gates**

```bash
node apps/mac/scripts/check-release-readiness.mjs
bash apps/mac/scripts/test-release-readiness.sh
git diff --check
git status --porcelain
git diff --stat main -- server/ web/ relayium-ops/ .github/ apps/mac/scripts/ apps/ios/ \
  apps/mac/Relayium.xcodeproj/project.pbxproj
```
Expected: readiness valid and **still unapproved**; the shell test passes; `git diff --check` silent; and the last command prints **nothing** — no server, web, ops, CI, packaging-script, iOS-app or project-file change. A non-empty result is a scope breach and must be reverted before this task can be reported complete.

`git status --porcelain` is expected to be **non-empty**, and that is the correct
outcome: Claude does not commit, so the work is in the working tree at handoff.
What is checked is not cleanliness but *exactness* — the listed paths must be
precisely the intended set and nothing else:

- `apps/mac/Brand/AppIcon.svg`; `apps/mac/tools/render-app-icon.swift`; `apps/mac/tools/README.md`
- `apps/mac/Relayium/Assets.xcassets/**` (catalog root, `AppIcon.appiconset` + 7 PNGs, `AccentColor.colorset`)
- `apps/mac/Relayium/Info.plist`; `apps/mac/Relayium/RelayiumApp.swift`
- `apps/mac/Relayium/Shell/**`, `Components/**`, `Destinations/**`
- the modified panes: `UploadPane.swift`, `DownloadPane.swift`, `NearbyPane.swift`, `DirectPane.swift`, `RealtimeTextPane.swift`, `AccountView.swift`, `RealtimeFileSessionView.swift`, `RealtimeTextSessionView.swift`
- deletions: `apps/mac/Relayium/ContentView.swift`, `apps/mac/Relayium/DirectHubPane.swift`
- `apps/RelayiumKit/Sources/RelayiumAppKit/{AppDestination,AccountGate,TransferPresence}.swift`, `NearbyReceive.swift`, `Localization/L10nKey.swift`, nine `Localizable.strings`
- the new and extended tests under `apps/RelayiumKit/Tests/RelayiumKitTests/`
- `apps/README.md`, `README.md`, `apps/mac/release-readiness.json`

Anything outside that list — and in particular any change to
`apps/RelayiumKit/Package.swift`, `.github/**`, `apps/mac/scripts/**`, `web/**`,
`server/**`, `relayium-ops/**` or `project.pbxproj` — is a scope breach. Record
the full `git status --porcelain` output in the handoff so Codex commits a
reviewed set rather than a surprise.

- [ ] **Step 7: Signed CI / DMG — Codex's, not Claude's**

`.github/workflows/macos.yml` is unchanged and must keep passing unmodified: the `signed-build` job's strict `codesign --verify`, its entitlement dump, `apps/mac/scripts/resign-sparkle.sh`, and `apps/mac/scripts/package-dmg.sh` with its mounted-app signature check. `Assets.car` is an ordinary sealed resource under `Contents/Resources`; it adds no new signing surface. **No notarization is submitted and no appcast changes.** Claude cannot run any of this: the signed build exists only after the delivery commit is on `main`, and the signing secrets are not available locally. Record it as *what Task 9 must verify*, never as evidence produced here.

- [ ] **Step 8: Visual and manual matrix (by hand, on the Debug build from Step 5)**

macOS has no simulator; a driven local build is the equivalent. **Record a result
for every row**, choosing exactly one of:

- **run** — it was exercised; write what was seen;
- **failed** — it was exercised and did not meet the expectation; write what was seen;
- **unavailable** — it could not be exercised; name the missing thing (second display, peer device, account, live link, network, credential) and do **not** infer the outcome.

The **needs** column names what a row depends on beyond this Mac and this build.
None of those dependencies is assumed to exist.

| # | check | expected | needs |
|---|---|---|---|
| 1 | Dock, Finder, ⌘-Tab, About box, Get Info | the mark at 16/32/128/512, never the generic placeholder | — |
| 2 | icon at 16 pt on a Retina and a non-Retina display, side by side | the glyph still reads; the body is not muddy | a non-Retina display — likely **unavailable** |
| 3 | icon in the Dock beside system icons | not flat — if it is, record design Decision 1's revisit as fired; do not change the renderer in this slice | — |
| 4 | window at the 860×560 floor | sidebar + 720 pt measure fit; nothing truncates | — |
| 5 | window at 1040×700 default, and full screen | content stays leading-aligned at 720 pt; the roster takes the rest | — |
| 6 | File menu and ⌘N | **no** New Window item; ⌘N does nothing | — |
| 7 | menu bar ▸ open Relayium, twice, with the window already open | the same window comes forward; the Window menu never lists two | — |
| 8 | close the window, then reopen from the menu bar | the process stayed alive (`pgrep -x Relayium`), residency kept reporting, and the same window returns with its selection | — |
| 9 | close the window **while a transfer is running** | the transfer keeps running; the menu bar still reports it | a running transfer (peer or link) |
| 10 | `defaults write com.relayium.mac AppleLanguages -array en` | every screen reads | — |
| 11 | … `-array zh-Hans` | no truncation, no English leak | — |
| 12 | … `-array ar` | sidebar on the trailing edge, content mirrored, pairing code still LTR in its bidi isolate | — |
| 13 | signed out (empty keychain): all five destinations reachable | no sign-in wall anywhere in the shell | — |
| 14 | signed out: nearby send **and** receive | both complete | a second device on this network |
| 15 | signed out: join a pairing code | joins | a peer that minted a code (needs an account) |
| 16 | signed out: open a `#k=` link | resolves, downloads, reveals in Finder | a live stored link + network |
| 17 | signed out: the two gates | each states its reason and its remedy is live; no greyed button | — |
| 18 | during `.restoring` (relaunch with a stored token) | a spinner, **never** "sign in" | a real account signed in once |
| 19 | signed in: stored send, account, devices, stored files | behaviour unchanged from `6bd7c61b` | a real account |
| 20 | `open 'https://relayium.com/cross-network#c=123456'`, window **open** and **closed** | lands on Pairing code with both models populated; if the closed-window case does not route, apply Task 6's bounded fallback and report the deviation | — |
| 21 | a real `#k=` link, window open and closed | lands on Open a link, resolved | a live stored link |
| 22 | pairing-code deep link **while a nearby session is live** | selection moves; the live session keeps running and stays rendered by Nearby | a peer device |
| 23 | close the window mid-receive, reopen | lands on Nearby with the session on screen | a peer device |
| 24 | VoiceOver over the sidebar and one live session | sections announced; codes read digit by digit | (live-session half needs a peer) |
| 25 | Increase Contrast on; Reduce Transparency on | all text legible; no meaning carried by colour alone | — |
| 26 | menu bar: status, pause, resume, "open Relayium" | unchanged | — |
| 27 | quit during a transfer | the quit guard still warns | a running transfer |

Rows 14–16, 18–19 and 21–24 are the ones most likely to be unavailable. If they
are, the handoff says so by number — an unavailable row is reported, never
quietly rewritten as passing and never dropped from the table.

- [ ] **Step 9: Measure the six-workflow benchmark — observations only**

Count each workflow by hand against **three** clients, in this order:

1. today's Web client at `relayium.com` in a browser;
2. the **baseline** macOS build at `6bd7c61b` — build it from a scratch worktree
   (`git worktree add /tmp/rlm-baseline 6bd7c61b`) so the current tree is not
   disturbed, and record the derived-data path used;
3. this build.

Then write the observed counts — and only those — into the `### Native versus
Web` subsection Task 7 created. Rules:

- A cell is filled **only** if somebody counted it on a running client. Anything
  else is written `not measured — <reason>` (no peer device, no account, no live
  link, no network, baseline would not build).
- The design's hypothesis figures are **not** copied in, not as a second column,
  not in parentheses, not as "predicted N / measured M". If an observation
  contradicts the hypothesis, note that in the handoff to Codex; the repository
  records what happened, not what was guessed.
- If a workflow is unmeasurable in all three clients, keep the row and mark all
  three cells `not measured`, so the gap is visible rather than absent.
- If the measured counts show receive-a-link is the dominant workflow, record
  design Decision 3's revisit trigger as **fired** — do not change the default
  destination in this slice.

- [ ] **Step 10: Screenshots**

Fresh screenshots of every state that carries a claim — the five destinations, both gates, the busy card, an empty roster, a live session, and the sidebar — at the 1040×700 default, in `en` and `ar`, in light and dark. Store outside the repository unless the owner asks otherwise; reference them in the handoff, not in `README.md`.

- [ ] **Step 11: Record the evidence in the tree — do not commit**

Add one `### Slice evidence (2026-08-03)` subsection to `apps/README.md` § Manual acceptance: the test count from Step 1, the outcomes of Steps 2–6 including Step 5b's two iOS builds, the manual matrix result with **every** failed and **every** unavailable row named by number and reason, and the observed benchmark cells. State plainly which gates were **not** run and why: no signed Release build, no notarization, no CI run, no native-speaker review, no automated UI test of any SwiftUI surface, plus anything Step 5b or the matrix reported unavailable.

No `git add`, no `git commit` (constraint 15). The file change joins the rest of the working tree.

- [ ] **Step 12: Self-review the actual diff, then hand off to Codex**

Read `git diff` and `git diff --stat` end to end — the real diff, not the plan's
description of it — and check it against the Global Constraints. Then hand Codex:

1. what was built, task by task;
2. every gate with its **observed** output, including the ones that failed or
   were unavailable;
3. the complete `git status --porcelain`, with a statement that the tree is
   intentionally dirty and that these are exactly the intended files;
4. every manual row that was **unavailable**, by number, with the missing
   hardware/account/peer/credential named;
5. every design revisit trigger that fired;
6. any deviation from this plan (a `.pbxproj` fallback, a deep-link fallback, a
   corrected request count, a differing iOS scheme name);
7. the screenshots' location.

Then **stop**. Do not commit, do not push, do not open a PR, do not flip
`approved`, and do not state or imply that Codex has accepted anything. Task 9 is
Codex's.

---

## Task 9 (Codex): review, delivery, and the signed engineering DMG

**Owner: Codex.** Claude does not execute this task and must not pre-run any part
of it. It exists in this plan so that the delivery path is written down and
reviewable, not so that it can be borrowed.

- [ ] **Step 1: Independent review**

Review the actual diff against the design's invariants and this plan's Global
Constraints — not against Claude's summary of them. Blocking findings under
`PROJECT-GOVERNANCE.md` § Quality include any truthfulness regression: a launch
claim, an unobserved figure in a repository document, a manual row reported as
passing that was actually unavailable.

- [ ] **Step 2: Re-run the local gates**

Independently re-run Task 8's Steps 1–6 (full Swift suite; unsigned universal
build + `lipo`; icon/plist on the product; localization on the product; sandbox
entitlements; both iOS builds; readiness scripts; the scope-breach `git diff
--stat`). A gate Claude reported as passing that does not reproduce here is a
blocking finding.

- [ ] **Step 3: One commit**

**One** commit, message in English, conventional prefix, describing the slice as
an engineering correction and **never** as a launch. It contains exactly the
files Claude handed over. No second commit for the evidence; no fixup chain.

- [ ] **Step 4: Push to `main`**

Per `PROJECT-GOVERNANCE.md` § Git and GitHub — internal development does not use
pull requests, and internal branches merge directly into local `main` and push
after implementation and independent review pass.

- [ ] **Step 5: Wait for the required GitHub workflows**

The push touches `apps/**`, so `.github/workflows/macos.yml` runs `test`,
`ios-build` and `signed-build`. Wait for each to complete and record its
conclusion for **this exact SHA**:

```bash
SHA=$(git rev-parse HEAD)
gh run list --commit "$SHA" --workflow macos.yml
gh run watch <run-id>
```
A red run is a blocking finding and stops delivery here.

- [ ] **Step 6: Download the signed DMG for that exact SHA**

`signed-build` uploads `relayium-macos-<sha>` containing `Relayium.dmg` and
`Relayium.dmg.sha256`.

```bash
gh run download <run-id> --name "relayium-macos-$SHA" --dir /tmp/rlm-dmg
cd /tmp/rlm-dmg && shasum -a 256 -c Relayium.dmg.sha256
```
The artifact name must carry the same SHA that was just pushed. An artifact from
any other run is not this build.

- [ ] **Step 7: Verify the artifact**

Mount it and check, recording each observed result:

```bash
hdiutil attach /tmp/rlm-dmg/Relayium.dmg -mountpoint /tmp/rlm-mnt -nobrowse
APP=/tmp/rlm-mnt/Relayium.app
codesign --verify --deep --strict --verbose=2 "$APP"      # signature
codesign -dvvv "$APP" 2>&1 | grep -E 'Authority|TeamIdentifier'
lipo "$APP/Contents/MacOS/Relayium" -verify_arch arm64 x86_64   # architectures
plutil -extract CFBundleIconName raw "$APP/Contents/Info.plist" # icon declared
assetutil --info "$APP/Contents/Resources/Assets.car" \
  | grep -Eo '"PixelWidth" : [0-9]+' | sort -u                  # seven sizes present
spctl -a -vvv -t exec "$APP"                                    # Gatekeeper
stapler validate "$APP" || true                                 # notarization ticket
hdiutil detach /tmp/rlm-mnt
```

Also open the mounted app once and confirm the icon renders in Finder and the
Dock rather than the generic placeholder.

**The expected Gatekeeper result is a rejection**, and that is correct: this
slice submits nothing to Apple, so the DMG is **signed but not notarized** and
`stapler validate` finds no ticket. Record that outcome as observed. Reporting it
as a pass, or submitting for notarization to make it pass, are both out of scope.

- [ ] **Step 8: Hand the build to the owner, labelled**

Give the owner the DMG together with: the SHA it was built from, the workflow run
it came from, the checksum result, the signature/architecture/icon results, the
explicit statement that it is **signed but not notarized**, and every unavailable
manual row and unmeasured benchmark cell from Claude's handoff.

Label it, in the owner's own words, an **engineering test build** — not a
release, not a launch, not a beta. Do **not** submit notarization, do **not**
publish a GitHub Release, do **not** touch the appcast, and do **not** flip
`apps/mac/release-readiness.json`'s `approved`. Those are separate,
owner-directed decisions.

---

## Remaining blockers before public launch

This slice is **not** a public launch. Against the five `PROJECT-GOVERNANCE.md` criteria, after it lands:

| criterion | moved by this slice | still blocking launch |
|---|---|---|
| Product completeness | five named destinations with designed empty/loading/failure/active states; every anonymous capability reachable signed out | no background transfer (a transfer dies with the app), no resumable transfer, no Settings scene, no in-app account deletion, no device naming, no Quick Look of received files, no update UI beyond the Sparkle menu item |
| Designed UI quality | native hierarchy, one component vocabulary, semantic type, a11y, light/dark, RTL, nine languages | no native-speaker review of the eight non-English languages; no automated UI test of any SwiftUI surface (design Decision 6); icon reviewed only by hand |
| A reason to install | the six-workflow benchmark, to the extent it could actually be measured | entry points *outside* the app — Share extension, Services, Dock drop target, Quick Action — are the largest untaken native advantage and are out of scope here; every workflow that could not be exercised stays unmeasured and is recorded as such |
| Release completeness | unchanged: signing, notarization, DMG and appcast machinery exist and stay untouched; CI produces one **signed, unnotarized** DMG that Codex verifies and hands to the owner as an engineering test build | no release approval (`approved: false`), no version bump, no notarization submission, no published release, no public download-surface change, no upgrade-path test from the currently installed build |
| Comparative evidence | hands-on visual/product QA with fresh screenshots plus whatever of the benchmark was measurable | the owner has not seen this build; owner installed-build feedback is part of acceptance and cannot be produced by this batch |

Four design decisions carry live revisit triggers. None of them may be acted on inside this slice; record which fired and hand it to the owner.

- **Decision 1 — no icon drop shadow.** Fires if visual-matrix row 3 reads flat beside system icons. Remedy: one named shadow constant in `apps/mac/tools/render-app-icon.swift`, and a re-render.
- **Decision 2 — `AccentColor` overrides the system accent.** Fires on an owner or user report. Remedy: delete the colorset and the two `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` lines that name it.
- **Decision 4 — read-only sidebar footer.** Fires if the by-hand pass finds residency unclear without a control beside it. Remedy: a pause/resume control in the footer.
- **Decision 5 — 860×560 window minimum.** Fires if visual-matrix row 4 shows the sidebar plus a 720 pt measure does not fit; in that case the **floor moves, not the measure**.

Decision 3 (default destination `.nearby`) fires only on the measured benchmark showing receive-a-link dominant — see Task 8, Step 9. Decision 6 (no UI test target) fires only when a launch-blocking UI regression escapes the by-hand pass.
