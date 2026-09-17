# iOS alignment with macOS 1.4.0

Status: delivered to internal TestFlight only as `0.3.2 (8)` from `9880648a`
(see `docs/ios-app-store-submission.md`); not a public release. This records what the
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

- **Cross-network title clipped at accessibility sizes: a real defect. The
  Cross-network screen now always uses an inline title.** Both system
  accessibility audits (Light and Dark) reported `Text clipped` on the
  `Cross-network` navigation title. Frames from the run's recording show the
  audit scaling the type and the large title going from full width to
  `Cross-netw…`. The unchanged source reproduced it locally without the audit:
  the AX-XXXL capture on the iPhone 17 Pro simulator (iOS 26.5) rendered
  `Cross-netwo…`. A large title is one line that grows with Dynamic Type, and
  `Cross-network` is the widest destination name.

  The first correction, inline only at accessibility sizes, failed the next
  hosted run (`35192603745`, commit `ed14a73d`, iOS 18.5). The Cross-network
  screen then had new Light contrast findings on the three route labels and
  the mode explanation, an empty "potentially inaccessible" element, and a
  Dark contrast finding on `Scan a QR code`. The run's recordings and a
  recorded local run established why:
  - When the audit scaled the type, the bar switched to inline and the page
    moved up 52 pt. It did not switch back when the size returned. That was
    recorded on iOS 26.5 with the other branch as `.automatic` and again as
    `.large`: hero top 180 pt before the audit, 128 pt after it, at the same
    ordinary text size. So the conditional also left real users stuck inline
    after changing their text size.
  - At the reported frames, the pre-jump pixels measure 1.03–3.67:1 for three
    of the route and explanation labels and 1.31:1 for the Dark button. The
    stable post-jump pixels at those same frames measure 19–21:1 for the route
    labels, about 4.5:1 for the explanation and 4.6:1 for the button. Those
    are video estimates, not exact colour values.
  - The frame positions match the post-jump layout, and the low ratios match
    the pre-jump pixels. The likely explanation is that the audit measured
    pixels from before the jump at frames from after it, not a colour defect.
    That is an inference consistent with the recordings. How the system audit
    samples internally cannot be observed.

  One mode removes the jump. In a recorded local audit with the title always
  inline, the page stays at 128 pt throughout, and the title reads in full at
  every size on phone and iPad. No audit classification or assertion was
  changed. The remaining risk is that this screen now differs from the other
  destinations, which keep large titles.
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

Validation status for the always-inline correction, on the owned iOS 26.5
simulators (recorded under `root-resume/ui-gate-fix`):

- The Light and Dark system accessibility audits pass on the phone, each
  screen-recorded. The Cross-network page stays at 128 pt through the whole
  audit.
- On the phone, `testEnglishLightCapturesEverySurface` and
  `testTheLargestTextSizeCapturesEverySurface` pass.
- On the pad, `testTheLargestTextSizeCapturesEverySurface` passes.

The root's independent checks then passed on the same owned simulators:
`root-inline-phone.xcresult` passed 4 of 4 (Light audit, Dark audit, English
normal capture, AX-XXXL capture), and `root-inline-pad.xcresult` passed the
AX-XXXL capture, 1 of 1. The logs sit beside those bundles, and the before and
after phone screenshots at normal and AX-XXXL sizes were inspected. Local
iOS 26.5 results are not iOS 18.5 evidence: the earlier conditional passed
these same local audits.

The required hosted rerun then passed on the final source. Workflow run
`35199174983`, commit `9880648a`, completed with all four iOS jobs `success`:
`ios-build`, `ios-ui-smoke`, `ios-ipad-shell` and `ios-transfer-acceptance`.
`ios-ui-smoke` ran `RelayiumUITests` on an iPhone 16 Pro, iOS 18.5 simulator,
with Xcode 26.3, and reported `Executed 71 tests, with 17 tests skipped and 0
failures (0 unexpected)`, then `TEST SUCCEEDED`: 54 passed, 17 skipped. The 17
skips are the existing platform- and device-specific cases, not waivers added
by this work: 6 `AdaptiveShellUITests` that need a regular-width shell (the
iPad job's lane), 6 `DevicePairUITests` and 2 `DeviceInboxAcceptanceUITests`
that need a second physical device, and 3 `LocalSessionUITests` that need the
local acceptance harness. The Light and Dark system accessibility audits, the
largest-text-size reach test and every `ReferenceLayoutCaptureTests` case,
including `testTheLargestTextSizeCapturesEverySurface`, passed there. The
dedicated iPad shell and transfer-acceptance jobs passed; their per-test counts
are not in the retained UI log, so none are claimed here. Root evidence:
`root-resume/9880648a-hosted-ui.log` and `root-resume/9880648a-hosted-ios-final.json`.
