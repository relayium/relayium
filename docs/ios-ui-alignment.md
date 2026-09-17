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
