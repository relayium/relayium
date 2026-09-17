# iOS alignment with macOS 1.4.0

Status: private engineering candidate, not a release. This records what the
iOS app changed to read as the same product as macOS 1.4.0, what it
deliberately did not copy, and how the change is verified.

## What changed

- **Surfaces.** Page, card, card edge and status-head colours are named asset
  sets (`RelayiumPage`, `RelayiumCard`, `RelayiumCardBorder`,
  `RelayiumHeroTint`, `RelayiumHeroBase`) with Light, Dark and both Increase
  Contrast variants. Light is a white card with a fine edge on a neutral page;
  Dark is a lifted neutral card on a near-black page. `Palette` falls back to
  the previous system roles when a bundle (the Share extension) does not ship
  the sets.
- **Shape.** Cards use the Mac's 11pt continuous corner and a 0.75pt inner
  edge; the status head uses 14pt, 16pt insets and a violet-to-card wash with
  opaque stops.
- **Status head (`StatusHero`).** One per destination, carrying the state as
  its title (never the page name again) and the controls that change it below,
  full width. The brand radar is static (no animation branch, Reduce Motion
  safe), filled while the reported thing is running and quiet otherwise, and
  moves above the text at accessibility sizes. Used by Device Inbox, Nearby
  receiving, Cross-network, and the device conversation header. Sign-in uses
  the same radar mark.
- **Group captions** are footnote, semibold, uppercase via `textCase`, in the
  supporting role.
- **Cross-network naming.** The tab and navigation title use the existing
  `nav.crossNetworkShort` key ("Cross-network" / "跨网络") instead of "Pairing".
- **Share a link.** The route rail and purpose sit above the card, and are also
  shown above the account gate when signed out.
- **Device Inbox Check now.** Mirrors macOS: `inbox.checkNow()` on the shared
  `InboxController`, visible only when `canCheckNow` and
  `InboxManualCheckPresentation.offersCheck` allow (or while checking),
  disabled and labelled Checking… until the pass that answers it returns, with
  the shared result sentence beside it. No view state of its own.

## Invariants kept

- Phone tab bar and iPad sidebar navigation, destination order, and every
  existing action, gate, error and the foreground-only receiving sentence.
- Check now never calls `retryNow()` (which restarts the generation and would
  cancel a delivery in flight), never accepts or declines under Ask, and never
  claims an arrival; arrivals are the status line's.
- No shared production controller, transport, crypto, storage, billing or
  localization change. Touch targets stay at the 44pt floor.
- Prose roles (`SupportingLabel`, `WarningLabel`) are measured at ≥ 4.5:1 on
  every new surface in the matching appearance.

## Test fixture

`UITestInbox.swift` is compiled only in DEBUG and reached only through
`UITestMode.makeInboxController()`, which is `nil` in Release. It replaces
the transport alone; the real controller, loop, enrolment, key store, sealed
box, manifest decryption, container commit and journal run. The automatic
schedule is one hour, so every pass after launch is one a test requested, and
each requested pass is held for four seconds so Checking… is observable under
XCUITest's query latency. Launch arguments: `--relayium-ui-testing-inbox-check`
(first check empty, second check delivers three files) and
`--relayium-ui-testing-inbox-ask` (two held deliveries).

## Verification

- `swift test --filter IOS` in `apps/RelayiumKit`: iOS source guards, including
  `IOSSupportingTextGuardTests.testTheMacAlignedSurfacesKeepEveryProseRoleReadable`.
- `xcodebuild build-for-testing` for the iOS simulator, unsigned.
- `RelayiumUITests/DeviceInboxCheckNowUITests`: Checking → Nothing new → a
  second tap coalesced → Check now → delivered and Check complete; and Ask
  holding its deliveries after a check.
- `RelayiumUITests/ReferenceLayoutCaptureTests`: EN/zh, Light/Dark and
  accessibility-size captures of every destination, phone and iPad.

## Hosted UI gate corrections (2026-09-17)

The first hosted iOS run of this work (workflow run `35186364950`, iPhone 16
Pro, iOS 18.5 simulator, Xcode 26.3) failed three UI tests. Both causes were
diagnosed from that run's result bundle and screen recording before anything
was changed.

- **Cross-network title clipped at accessibility sizes: a real defect, fixed
  in `DirectView`.** Both system accessibility audits (Light and Dark)
  reported `Text clipped` on the `Cross-network` navigation title. Frames from
  the run's recording show the audit scaling the type and the large title
  going from full width to `Cross-netw…`. The unchanged source reproduced it
  locally without the audit: the AX-XXXL capture on the iPhone 17 Pro
  simulator (iOS 26.5) rendered `Cross-netwo…`. A large title is a single line
  that grows with Dynamic Type, and `Cross-network` is the widest destination
  name. The screen now uses an inline title at accessibility sizes, which shows
  the whole word, and keeps the large title otherwise. The audit's
  classifications and assertions are unchanged, and the hosted iOS 18.5 audit
  remains the required proof.
- **The stored-link sheet at AX-XXXL: a test-driving defect, fixed in
  `ReferenceLayoutCaptureTests`.** The run's activity trail shows `Done`
  stopped resolving right after the capture's two swipes back down, before
  any upward swipe. A downward swipe at the top of a sheet drags the sheet
  itself, so the capture dismissed the sheet, and the reach loop then failed
  looking for a control that was gone. The locally passing run found `Done`
  immediately. The presented sheet is now captured without the swipe back
  (`Done` is pinned in the page's top inset and stays on screen from the
  scrolled position). A new assertion fails if the capture's own scrolling
  dismisses the sheet. The reach check and the dismissal assertion are
  unchanged.

Validation status, on the owned iOS 26.5 simulators (iPhone 17 Pro phone, iPad
Pro 11-inch pad), recorded under `root-resume/ui-gate-fix`:

- `root-phone.xcresult`: passed 12 of 12, none skipped. That is the whole
  `ReferenceLayoutCaptureTests` class (10) plus the Light and Dark system
  accessibility audits (2).
- `root-pad.xcresult`: the AX-XXXL capture passed, 1 of 1.
- `root-swift-ios.log`: 343 tests, 0 failures.
- `root-web-tests.log`: 82 tests, 0 failures.
- The AX-XXXL screenshots from both the phone and the pad were reviewed.

Still pending and required: a hosted rerun on iOS 18.5, the runtime where the
audit failures were found, which is not installed here. Nothing here claims
TestFlight delivery.
