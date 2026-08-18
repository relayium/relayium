import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// What the macOS app is NOT allowed to contain.
///
/// Modelled on `IOSSurfaceGuardTests`: these are *absences*, and an absence has
/// no runtime to observe. Four of them decide whether the round's central claims
/// are true at all:
///
///  1. **The shell must not know about the account.** Every capability that
///     works signed out — anonymous stored-link receive, pairing-code join, both
///     directions of nearby — is reachable only if the split view renders
///     unconditionally. A single `session.state` read in the shell reinstates the
///     sign-in wall this round removes.
///  2. **One window.** `openWindow(id:)` against a `WindowGroup` creates another
///     window, and two windows render the same app-scoped models twice — one
///     live transfer with two Cancel buttons. App scope does not fix that;
///     scene uniqueness does.
///  3. **macOS 13.0 floor.** The named macOS-14 APIs compile on this machine's
///     SDK and fail at runtime on the deployment target, which no test in this
///     package would otherwise see.
///  4. **One fixed font size.** The pairing code and the SAS are transcribed by
///     hand across a room; everything else is semantic type. Counting the files
///     is what keeps that a rule rather than an intention.
final class MacSurfaceGuardTests: XCTestCase {
    func testNearbyOffStateOffersOneTruthfulRecovery() throws {
        let nearby = try source(named: lanConnect)
        XCTAssertTrue(nearby.contains("switch receive.state"))
        XCTAssertTrue(nearby.contains("case .off:"))
        XCTAssertTrue(nearby.contains("case .connecting, .ready, .reconnecting, .active:"))
        XCTAssertTrue(nearby.contains("receive.state == .paused || receive.state == .off"))
        // **The recovery is named for what it does.** The one control offered
        // beside an `off` listener calls `discovery.start()`, which opens the
        // room socket and is therefore what makes this Mac reachable — not a
        // rescan of a roster nothing is listening for. Asserted as the pairing
        // of the label with the call, because the defect was precisely that the
        // two had drifted: `nearby.lookAgain` named a search and performed a
        // subscription. That key still exists and is still correct — on iOS,
        // where the control it labels really does refresh a live roster.
        XCTAssertTrue(nearby.contains(
            "Button(L10n.t(.nearbyStartReceiving)) { discovery.start() }"),
            "the off-state recovery does not name the receiving it starts")
        XCTAssertFalse(nearby.contains("nearbyLookAgain"),
                       "the LAN pane calls its start action a search again")
        // The sentence naming where an incoming file lands is the same claim as
        // the explanation above it, so it follows the same rendered state. Left
        // on the pause flag it kept promising a Downloads delivery to a listener
        // that is off — a smaller version of the contradiction this test exists
        // for. Scope this to the sentence's own condition: the roster's
        // separate `else if !discovery.isPaused` is a different question, and a
        // whole-file search for that text would fail on it.
        let delivery = try XCTUnwrap(nearby.range(of: "nearbySavedToDownloads"))
        let condition = String(nearby[..<delivery.lowerBound].suffix(220))
        XCTAssertTrue(condition.contains("if !(receive.state == .paused || receive.state == .off) {"),
                      "the delivery sentence is not gated on the rendered state")
        XCTAssertFalse(condition.contains("discovery.isPaused"),
                       "the delivery sentence is still gated on the pause flag")
        // Found by the fixture the moment the device list stopped being empty:
        // macOS rendered a bare "Revoke" on every row while iOS had named the
        // credential since R3-D. From 1.1.3 the label also mirrors the address
        // this platform's row displays — the two must not drift apart, or the
        // button describes a row that is not on screen.
        // Whitespace-normalised, so wrapping the call over two lines is not a
        // product change this guard reports as one.
        let accountView = try source(named: "AccountView.swift")
            .components(separatedBy: .whitespacesAndNewlines).joined()
        XCTAssertTrue(accountView.contains(
            "AccountPresentation.revokeActionLabel(for:device,showsAddress:true)"),
            "macOS revoke reads as the same word on every device row")
        XCTAssertTrue(try source(named: "AccountView.swift").contains(
            "AccountPresentation.revokeConsequence(") ,
            "macOS re-derives the revoke consequence instead of asking the tested seam")
        XCTAssertFalse(try source(named: "AccountView.swift").contains(
            "? .accountRevokeThisMac : .accountRevokeOther"),
            "the revoke consequence rule exists twice and can drift")
        XCTAssertEqual(try source(named: "AccountView.swift").components(
            separatedBy: "AccountPresentation.deleteActionLabel(fileId: row.file.id)").count - 1, 3,
            "a stored-file Delete arm reads as the same word on every row")
        XCTAssertTrue(try source(named: "AccountView.swift").contains(
            #"storedFile.keyAbsent.\(row.file.id)"#),
            "the key-absent explanation has no stable per-row identity")

        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("testStoppedNearbyDiscoveryAsksForActionWithoutPretendingToWork"))
        XCTAssertTrue(ui.contains("window.buttons[\"Pause receiving\"].exists"))
        XCTAssertTrue(ui.contains("window.buttons[\"Resume receiving\"].exists"))
        XCTAssertTrue(ui.contains("window.buttons[\"Start receiving\"].waitForExistence"),
                      "no runtime check presses the renamed off-state recovery")
        XCTAssertFalse(ui.contains("window.buttons[\"Look again\"].waitForExistence"),
                       "a runtime check still expects the old search-shaped label")
    }

    /// **The screens claim an encrypted path, never a direct one.**
    ///
    /// `PathRailPresentation` has refused to name the middle of a live transfer
    /// since it was written — there is no `.direct` stop, because at the moment
    /// the rail is drawn the client cannot distinguish a peer-to-peer connection
    /// from a TURN-relayed one. The copy around it did not follow: the LAN
    /// sidebar caption sold the destination as *direct*, its help answer said
    /// the files "travel straight between them", and both staging hints promised
    /// to send *straight to that device*. So the rail said the client could not
    /// know and the sentence beside it said it did.
    ///
    /// Checked as rendered strings in every language rather than as source, so a
    /// translation that keeps the promise the English dropped fails too. The
    /// positive half matters as much: dropping the false claim must not drop the
    /// true ones — same network, no account, both sides online, encrypted.
    func testNoLanCopyPromisesARouteTheClientCannotObserve() throws {
        // Per language, in the form each one actually uses to promise a
        // straight-through path. Written down by hand: the point is that
        // somebody read every translation.
        let directClaim: [AppLanguage: [String]] = [
            .en: ["direct", "straight between", "straight to"],
            .de: ["direkt"],
            .fr: ["directement", "en direct"],
            .es: ["directo", "directamente"],
            .pt: ["direto", "diretamente"],
            .zh: ["直连", "直接"],
            .ja: ["直接"],
            .ko: ["직접", "바로"],
            .ar: ["مباشر"],
        ]
        let promises: [L10nKey] = [.navLanTransferSubtitle, .helpLanBoundary,
                                   .nearbySelectionSendHint, .nearbyAddFilesHint,
                                   .workspaceAddFilesHint]
        for language in AppLanguage.allCases {
            let forbidden = try XCTUnwrap(directClaim[language])
            for key in promises {
                let text = L10n.t(key, language: language).lowercased()
                for claim in forbidden {
                    XCTAssertFalse(text.contains(claim.lowercased()),
                                   "\(key.rawValue) [\(language.rawValue)] promises a route "
                                   + "this build cannot observe (\(claim)): \(text)")
                }
            }
        }

        // The truthful half is still there. LocalizedCopyTests already pins the
        // network and both-online tokens per language, in
        // `testSidebarSubtitlesKeepTheDecisiveLimitation`; what belongs here is
        // the help topic's BOUNDARY — the answer this used to name, under the
        // heading somebody actually looks under to ask what the servers see.
        let answer = L10n.t(.helpLanBoundary, language: .en)
        for kept in ["encrypted end to end", "never has the key", "relay"] {
            XCTAssertTrue(answer.localizedCaseInsensitiveContains(kept),
                          "the corrected LAN answer dropped \(kept): \(answer)")
        }

        // And the rail it now agrees with still names no route either.
        let words = PathRailPresentation.lan(language: .en)
            .map(\.title).joined(separator: " ").lowercased()
        for guess in ["direct", "relay", "peer"] {
            XCTAssertFalse(words.contains(guess),
                           "the LAN rail started guessing a route: \(guess)")
        }
    }

    /// The macOS transfer files, named once so a rename is one edit rather than
    /// forty.
    ///
    /// Two destinations, one connect pane each, and three files they share: the
    /// legacy session pane, the unified `link/1` pane and the staging section.
    /// The invariants the one merged Workspace carried did not go anywhere, so
    /// most of the guards below are the same assertions pointed at these — split
    /// between the two connect panes where the control they check now lives on
    /// exactly one of them.
    private let lanDestination = "Destinations/LanTransferDestination.swift"
    private let crossDestination = "Destinations/CrossNetworkTransferDestination.swift"
    private let lanConnect = "Transfer/LanConnectPane.swift"
    private let crossConnect = "Transfer/CrossNetworkConnectPane.swift"
    private let transferSession = "Transfer/TransferSessionPane.swift"
    private let transferStaging = "Transfer/TransferStagingSection.swift"

    /// The surfaces that no longer exist. Asserted as absences, because a
    /// half-finished revert — the new files plus one of the old ones still
    /// compiled in — is exactly the state that reintroduces a sidebar row nobody
    /// would notice in a diff. The last four are this batch's: the merged
    /// Workspace, and the Device Inbox settings tab that is now a destination.
    private let retiredSurfaces = ["NearbyPane.swift", "DirectPane.swift",
                                   "RealtimeTextPane.swift",
                                   "Destinations/NearbyDestination.swift",
                                   "Destinations/PairingCodeDestination.swift",
                                   "Destinations/WorkspaceDestination.swift",
                                   "Workspace/WorkspaceConnectPane.swift",
                                   "Workspace/WorkspaceSessionPane.swift",
                                   "Workspace/WorkspaceLinkPane.swift",
                                   "Settings/DeviceInboxSettingsView.swift"]

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var macRoot: URL { appsRoot.appendingPathComponent("mac/Relayium") }

    /// The shared app layer. macOS's two transfer modules are composed from
    /// types that live here, so a guard about the module boundary has to be able
    /// to read them.
    private var appKitRoot: URL {
        appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit")
    }

    private func appKitSource(named name: String) throws -> String {
        try String(contentsOf: appKitRoot.appendingPathComponent(name), encoding: .utf8)
    }

    /// One declaration, bounded by the start of the next one.
    ///
    /// A fixed prefix length is what made the first version of the module-split
    /// guard read the NEXT factory's closures and report a refusal that was
    /// there — so the bound is the next `@MainActor` or `static func` at the
    /// same indentation, which is where a declaration in these files actually
    /// ends.
    private func declaration(of name: String, in source: String) throws -> String {
        let after = try XCTUnwrap(source.components(separatedBy: "func \(name)").dropFirst().first,
                                  "\(name) is not declared in this source")
        for boundary in ["\n    @MainActor", "\n    public static func", "\n    static func",
                         "\n    public func", "\n    /// "] {
            if let end = after.range(of: boundary) {
                return String(after[..<end.lowerBound])
            }
        }
        return after
    }

    /// The repository's own root, one level above `apps`.
    private var repoRoot: URL { appsRoot.deletingLastPathComponent() }

    /// The three documents this round is allowed to make claims in. Each is a
    /// surface a reader takes as a statement about what the product IS, so each
    /// is held to the same rule.
    private let claimSurfaces = ["README.md", "apps/README.md",
                                 "apps/mac/release-readiness.json"]

    private func claimSurfaceText(_ path: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent(path), encoding: .utf8)
    }

    /// The shape `web/native-releases.json` is required to have. Decoded with
    /// `JSONDecoder` rather than read as untyped Foundation objects, because
    /// only strong decoding makes `publishedMacVersion()`'s validation true: a
    /// `build` of `1.5` bridges to an `NSNumber` and truncates to a perfectly
    /// plausible `1`, and a `build` of `true` bridges to an `NSNumber` worth
    /// `1` as well — both would pass a positive-integer check while the
    /// manifest holds no build at all. `JSONDecoder` rejects a fractional or
    /// boolean `build` outright, and rejects a non-boolean `available`, so a
    /// malformed manifest fails there instead of quietly certifying a release.
    private struct ReleaseManifest: Decodable {
        var macos: MacRelease?
    }

    private struct MacRelease: Decodable {
        var available: Bool
        var version: String?
        var build: Int?
        var downloadUrl: String?
    }

    /// The macOS version that is actually published, read from
    /// `web/native-releases.json` rather than written down again — the one
    /// source of truth both
    /// `testTheDocsNameTheMacOSReleaseAReaderCanActuallyFetch` and
    /// `testNoClaimSurfaceOverstatesWhatIsDistributed` resolve the documented
    /// tag and status from. A guard that hard-codes the version outlives the
    /// release it was written for and then pins the document to a stale one,
    /// which is the failure this whole section exists to catch.
    ///
    /// Deliberately NOT the project's `MARKETING_VERSION`. A release moves in
    /// two stages: Xcode's version and build advance first, on a release
    /// branch, and the manifest, the appcast and the documents follow only once
    /// the DMG is notarized and published. In between, the Xcode version names
    /// a release that exists nowhere — so deriving a documented tag from it
    /// would demand the READMEs advertise a download no reader can fetch, which
    /// is the precise thing these tests were written to prevent. The project's
    /// own version is guarded by `BundleVersionTests`, which is where it
    /// belongs.
    ///
    /// Validated, not merely read. A manifest that is unavailable, carries no
    /// version, carries a build that is not a positive integer, or points at an
    /// asset other than the immutable `macos-v<version>/Relayium.dmg` is not a
    /// record of a published release, and a tag derived from it would put a
    /// broken link in the README with every assertion below still green. The
    /// type-level half of that validation lives in `ReleaseManifest`.
    private func publishedMacVersion() throws -> String {
        let manifest = try Data(contentsOf: repoRoot.appendingPathComponent("web/native-releases.json"))
        let root = try JSONDecoder().decode(ReleaseManifest.self, from: manifest)
        let macos = try XCTUnwrap(root.macos,
                                  "web/native-releases.json names no macOS release")
        XCTAssertTrue(macos.available,
                      "the macOS manifest does not offer a published download")
        let version = try XCTUnwrap(macos.version,
                                    "the macOS manifest carries no version")
        XCTAssertFalse(version.isEmpty, "the macOS manifest carries an empty version")
        let build = try XCTUnwrap(macos.build,
                                  "the macOS manifest carries no build")
        XCTAssertGreaterThan(build, 0, "the macOS manifest carries a non-positive build")
        XCTAssertEqual(macos.downloadUrl,
                       "https://github.com/relayium/relayium/releases/download/"
                       + "macos-v\(version)/Relayium.dmg",
                       "the macOS manifest does not point at the immutable DMG for its own version")
        return version
    }

    func testNearbyProgressNamesRealReconnectWorkAndNeverDecoratesLookAgain() throws {
        let pane = try source(named: lanConnect)
        XCTAssertFalse(pane.contains("ProgressView()"),
                       "an unlabelled spinner says neither what is running nor whether anything is")
        XCTAssertTrue(pane.contains("if case .reconnecting = discovery.state"),
                      "only the state with a scheduled retry may show progress")
        XCTAssertTrue(pane.contains("ProgressView { Text(L10n.t(.nearbyReconnecting)) }"),
                      "VoiceOver and sighted users need the same reconnecting state")
    }

    func testEveryMacProgressIndicatorNamesItsWork() throws {
        let all = try sources(under: macRoot, atLeast: 30)
        let bare = all.filter { $0.text.contains("ProgressView()") }.map(\.name)
        XCTAssertTrue(bare.isEmpty, "unlabelled progress indicators in \(bare)")

        let file = try source(named: "RealtimeFileSessionView.swift")
        XCTAssertTrue(file.contains("Text(L10n.t(.sessionTransferProgress))"),
                      "file progress reports a number without naming the work")
        let text = try source(named: "RealtimeTextSessionView.swift")
        XCTAssertTrue(text.contains("ProgressView { Text(L10n.t(.textWaitingAccept)) }"),
                      "the peer-accept wait is unnamed")
    }

    func testMacUITestNavigationCannotMistakePageHeadingsForSidebarRows() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        XCTAssertTrue(shell.contains(
            ".accessibilityIdentifier(\"destination-\\(navigation.selection.macSurface.rawValue)\")"),
            "the detail surface has no stable runtime identity")
        let sidebar = try source(named: "Shell/SidebarView.swift")
        XCTAssertTrue(sidebar.contains(
            ".accessibilityIdentifier(\"sidebar-\\(surface.rawValue)\")"),
            "sidebar task identity depends on the OS-specific List container")

        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("app.windows.allElementsBoundByIndex.max") &&
                      ui.contains("$0.frame.width * $0.frame.height"),
                      "runtime checks can mistake an auxiliary window for the product shell")
        XCTAssertTrue(ui.contains(
            "window.descendants(matching: .any)[\"sidebar-\\(id)\"].firstMatch"),
            "destination clicks do not use the stable sidebar task identity")
        XCTAssertTrue(ui.contains("-AppleLanguages") && ui.contains("(en)"),
                      "runtime copy assertions depend on the runner's preferred language")
        XCTAssertTrue(ui.contains("-SUEnableAutomaticChecks") && ui.contains("NO"),
                      "Sparkle's first-launch consent can cover the product window")
        XCTAssertTrue(ui.contains("app.statusItems.firstMatch") &&
                      ui.contains("app.typeKey(\"o\", modifierFlags: [])"),
                      "a restored closed-window state has no real recovery path in the suite")
        let menu = try source(named: "MenuBarView.swift")
        XCTAssertTrue(menu.contains(".keyboardShortcut(\"o\", modifiers: [])"),
                      "menu-bar recovery has no language-independent keyboard action")
        XCTAssertTrue(ui.contains("$0.frame.midX < dividingX"),
                      "macOS 15 has no spatial fallback when List drops row identifiers")
        XCTAssertTrue(ui.contains("label == %@ OR value == %@"),
                      "macOS 15 combined Text values have no navigation fallback")
        XCTAssertFalse(ui.contains("window.descendants(matching: .any)[destination]"),
                       "a page heading can still make a sidebar click ambiguous")
        XCTAssertTrue(ui.contains(
            "NSPredicate(format: \"title == %@\", destination)"),
            "the destination smoke test does not observe the rendered detail surface")
    }

    /// **Same-network residency is reported once, by the surface that can act
    /// on it.**
    ///
    /// It began under every sidebar row, through `safeAreaInset`, which put
    /// "can this Mac be reached on this network right now" on Cross-network
    /// Transfer — the one destination whose entire premise is that no shared
    /// network exists — and on Stored Send, Device Inbox and Account, none of
    /// which it describes either. Scoping the footer to LAN Transfer fixed that
    /// and exposed the remaining defect: on the only screen it could still
    /// appear on, the LAN pane states the identical
    /// `NearbyStatusPresentation.text(for:)` string, with Pause and Resume
    /// beside it. Two renderings of one sentence, one column apart, and the
    /// sidebar's was the copy nobody could act on.
    ///
    /// So the footer is gone and the fact is not. This is asserted from both
    /// ends, because either alone would pass a regression: the sidebar must not
    /// read the receive model at all, and the LAN pane must still report it.
    func testResidencyIsReportedOnceByThePaneThatCanActOnIt() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        for gone in ["NearbyReceiveModel", "receive.state", "safeAreaInset",
                     "sidebar-lan-residency", "navResidency"] {
            XCTAssertFalse(sidebar.contains(gone),
                           "the sidebar residency footer is back: \(gone)")
        }

        // …and the one surface that owns the fact still states it, next to the
        // controls that change it. Removing the duplicate must not have removed
        // the answer.
        let connect = try source(named: lanConnect)
        XCTAssertTrue(connect.contains("NearbyStatusPresentation.text(for: receive.state)"),
                      "the LAN pane no longer says whether this Mac can be reached")
        for control in ["L10n.t(.nearbyPauseReceiving)", "L10n.t(.nearbyResumeReceiving)",
                        "L10n.t(.nearbyStartReceiving)"] {
            XCTAssertTrue(connect.contains(control),
                          "the LAN pane lost a residency control: \(control)")
        }

        // Two render sites in the whole app, and they are two different places
        // rather than two copies: the LAN pane inside the window, and the menu
        // bar, which is the surface a user reads with the window closed and the
        // one route back to the pane. A third — or a second inside the window —
        // is the duplication this batch removed.
        let renderers = try sources(under: macRoot, atLeast: 30)
            .filter { $0.text.contains("NearbyStatusPresentation.text(for: receive.state)") }
            .map(\.name)
        XCTAssertEqual(renderers, ["MenuBarView.swift", lanConnect],
                       "same-network residency is rendered on more than one window surface")

        // The key the footer rendered is retired rather than left translated in
        // nine catalogs for nothing.
        XCTAssertFalse(L10nKey.allCases.contains { $0.rawValue == "nav.residency" },
                       "the retired sidebar-footer heading is still a live key")

        // And a runtime check observes both halves. An absence alone would pass
        // for a residency that vanished from the product entirely, so the same
        // test has to find the sentence on the LAN pane.
        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        let runtime = try XCTUnwrap(ui.components(
            separatedBy: "func testResidencyIsStatedOnTheLanPaneAndNotInTheSidebar()")
            .dropFirst().first?.components(separatedBy: "\n    /// ").first,
            "no runtime check observes where residency is drawn")
        XCTAssertTrue(runtime.contains("\"sidebar-lan-residency\""),
                      "the runtime check cannot name the footer it asserts is gone")
        XCTAssertTrue(runtime.contains("\"Nearby receiving: off\""),
                      "the runtime check does not confirm the LAN pane kept the fact")
        XCTAssertTrue(runtime.contains("NSPredicate(format: \"title == %@\", destination)"),
                      "the absence is asserted before the destination is on screen")
        XCTAssertTrue(runtime.contains("\"Cross-network Transfer\""),
                      "the sibling destination is not among the checked absences")
    }

    func testMacRuntimeSuiteIsAHostedProductGate() throws {
        let workflowURL = repoRoot.appendingPathComponent(".github/workflows/macos.yml")
        let workflow = try String(contentsOf: workflowURL, encoding: .utf8)
        XCTAssertTrue(workflow.contains("Run macOS product-flow UI smoke"),
                      "CI compiles macOS but never launches its product flows")
        let uiJob = try XCTUnwrap(workflow.range(of: "  ui-smoke:"))
        let signedJob = try XCTUnwrap(workflow.range(of: "  signed-build:"))
        let notarizeJob = try XCTUnwrap(workflow.range(of: "  notarize-stage:"))
        let publishJob = try XCTUnwrap(workflow.range(of: "  publish:"))
        let runtimeStep = try XCTUnwrap(workflow.range(of:
            "      - name: Run macOS product-flow UI smoke (${{ matrix.shard }})"))
        XCTAssertGreaterThan(runtimeStep.lowerBound, uiJob.lowerBound)
        XCTAssertLessThan(runtimeStep.lowerBound, signedJob.lowerBound)
        XCTAssertTrue(workflow.contains("Install UI provisioning profiles"),
                      "the UI app needs its certificate and profiles")
        XCTAssertTrue(workflow.contains("needs: [test, contract]"),
                      "signed packaging must wait for cheap contract gates")
        XCTAssertTrue(workflow.contains("needs: [ui-smoke, signed-build]"),
                      "notarization must wait for every mandatory UI shard and package")
        XCTAssertTrue(workflow.contains("needs: notarize-stage"),
                      "publication bypasses the notarized candidate")
        XCTAssertLessThan(signedJob.lowerBound, notarizeJob.lowerBound)
        XCTAssertLessThan(notarizeJob.lowerBound, publishJob.lowerBound)
        let downloadedTool = try XCTUnwrap(workflow.range(
            of: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
            range: notarizeJob.lowerBound..<publishJob.lowerBound))
        let checksumAtArtifactRoot = try XCTUnwrap(workflow.range(
            of: "(cd \"$RUNNER_TEMP\" && shasum -a 256 -c Relayium.dmg.sha256)",
            range: notarizeJob.lowerBound..<publishJob.lowerBound))
        let mountedArtifact = try XCTUnwrap(workflow.range(
            of: "hdiutil attach \"$RUNNER_TEMP/Relayium.dmg\"",
            range: notarizeJob.lowerBound..<publishJob.lowerBound))
        let restoredTool = try XCTUnwrap(workflow.range(
            of: "chmod 0755 \"$RUNNER_TEMP/release-tools/generate_appcast\"",
            range: notarizeJob.lowerBound..<publishJob.lowerBound))
        let executableGuard = try XCTUnwrap(workflow.range(
            of: "test -x \"$RUNNER_TEMP/release-tools/generate_appcast\"",
            range: notarizeJob.lowerBound..<publishJob.lowerBound))
        let firstToolInvocation = try XCTUnwrap(workflow.range(
            of: "| \"$tools/generate_appcast\"",
                range: notarizeJob.lowerBound..<publishJob.lowerBound))
        XCTAssertLessThan(downloadedTool.lowerBound, checksumAtArtifactRoot.lowerBound)
        XCTAssertLessThan(checksumAtArtifactRoot.lowerBound, mountedArtifact.lowerBound)
        XCTAssertLessThan(downloadedTool.lowerBound, restoredTool.lowerBound)
        XCTAssertLessThan(restoredTool.lowerBound, executableGuard.lowerBound)
        XCTAssertLessThan(executableGuard.lowerBound, firstToolInvocation.lowerBound)
        XCTAssertTrue(workflow.contains("permissions:\n  contents: read"))
        XCTAssertTrue(workflow.contains("signedDmgSha256")
            && workflow.contains("Finalize notarized package provenance"))
        XCTAssertTrue(workflow.contains(
            "(cd \"$RUNNER_TEMP\" && shasum -a 256 Relayium.dmg > Relayium.dmg.sha256)"),
            "the notarized artifact checksum must name a portable basename")
        XCTAssertFalse(workflow.contains(
            "shasum -a 256 \"$RUNNER_TEMP/Relayium.dmg\" > \"$RUNNER_TEMP/Relayium.dmg.sha256\""),
            "a runner-absolute checksum cannot be verified by the publish runner")
        XCTAssertTrue(workflow.contains(
            "release=\"$RUNNER_TEMP/release\"\n          cd \"$release\"\n          shasum -a 256 -c Relayium.dmg.sha256"),
            "publication must verify the portable checksum from its artifact root")
        for testClass in ["AppShellUITests", "DeviceInboxUITests",
                          "SubscriptionUITests", "LocalSessionUITests"] {
            XCTAssertTrue(workflow.contains("RelayiumUITests/\(testClass)"),
                          "the hosted shards omit \(testClass)")
        }
        XCTAssertTrue(workflow.contains(
            "xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium"))
        XCTAssertTrue(workflow.contains("-destination 'platform=macOS'"))
        XCTAssertTrue(workflow.contains("only+=(\"-only-testing:$class\")"))
        XCTAssertTrue(workflow.contains("timeout: 30") && workflow.contains("timeout: 35"),
                      "a hosted desktop failure can occupy the runner indefinitely")
    }

    func testRealtimeFileDetailsSurviveTransferAndCompletion() throws {
        let view = try source(named: "RealtimeFileSessionView.swift")
        XCTAssertGreaterThanOrEqual(view.components(separatedBy: "fileList").count - 1, 3,
                                    "the manifest must render while active and after completion")
        XCTAssertTrue(view.contains("model.sessionFiles"))
        XCTAssertTrue(view.contains("L10n.bytes(Int64(file.size))"),
                      "file identity without size does not meet the send confirmation standard")
        XCTAssertTrue(view.contains(
            "FileTransferCompletionPresentation.title(received: model.received != nil)"),
            "completion does not tell the user whether files were sent or received")
    }

    /// Each source's CODE, with whole-line comments dropped — the same loader
    /// `IOSSurfaceGuardTests` uses, and for the same reason: these files explain
    /// what they deliberately do NOT do, so scanning raw text would fail this
    /// guard on the very comments documenting the absence it checks for.
    ///
    /// `atLeast:` is not decoration. A rename that moved the sources out from
    /// under this guard is exactly when it silently stops protecting anything.
    private func sources(under root: URL, atLeast minimum: Int) throws
        -> [(name: String, text: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        XCTAssertGreaterThanOrEqual(names.count, minimum,
                                    "found \(names.count) sources at \(root.path)")
        return try names.map { name in
            (name, codeOnly(try String(contentsOf: root.appendingPathComponent(name),
                                       encoding: .utf8)))
        }
    }

    /// One source with its whole-line comments dropped.
    ///
    /// Extracted so a guard can point at a file OUTSIDE `apps/mac/Relayium` —
    /// the shared package's address enumeration, for one — and still get the
    /// property every guard here depends on: these files explain what they
    /// deliberately do NOT do, so raw text fails on the very sentence promising
    /// the absence being checked for.
    private func codeOnly(_ raw: String) -> String {
        raw
            .components(separatedBy: "\n")
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                    && !trimmed.hasPrefix("/*")
            }
            .joined(separator: "\n")
    }

    /// One named source, by its path relative to `apps/mac/Relayium`.
    private func source(named name: String) throws -> String {
        let all = try sources(under: macRoot, atLeast: 20)
        return try XCTUnwrap(all.first { $0.name == name }?.text,
                             "\(name) does not exist under \(macRoot.path)")
    }

    /// The same file with its comments intact — the only way to assert that a
    /// comment which has stopped being true is gone.
    private func rawSource(named name: String) throws -> String {
        try String(contentsOf: macRoot.appendingPathComponent(name), encoding: .utf8)
    }

    /// A count-only staging surface is not an acceptable description of the
    /// user's own files. All three macOS send destinations must render the same
    /// bounded, sanitized name-and-size list.
    func testEverySendPaneShowsThePendingFileNamesAndSizes() throws {
        let component = try source(named: "PendingFileList.swift")
        for required in ["FileIdentityPresentation.name(for: file)",
                         "L10n.bytes(Int64(file.size))",
                         "ScrollView", ".frame(maxHeight: 200)"] {
            XCTAssertTrue(component.contains(required), "pending-file list lost \(required)")
        }
        for pane in [transferStaging, "UploadPane.swift"] {
            XCTAssertTrue(try source(named: pane).contains("PendingFileList(files:"),
                          "\(pane) regressed to a count-only selection")
        }
        XCTAssertGreaterThanOrEqual(try source(named: "UploadPane.swift").components(
            separatedBy: "PendingFileList(sessionFiles: model.sessionFiles)").count - 1, 3,
            "stored upload lost file identities in a running or terminal state")
    }

    func testEveryMacFileListUsesTheSharedSafeLocalizedIdentity() throws {
        for name in ["PendingFileList.swift", "RealtimeFileSessionView.swift",
                     "DownloadPane.swift"] {
            let text = try source(named: name)
            XCTAssertTrue(text.contains("FileIdentityPresentation.name(for:"),
                          "\(name) does not use the shared file identity")
            XCTAssertFalse(text.contains("safeDisplayName("),
                           "\(name) can render an empty sanitized name")
            XCTAssertFalse(text.contains("\"download\""),
                           "\(name) leaks an English fallback into other languages")
        }
    }

    func testStoredReceivePreviewDoesNotTruncateFileIdentity() throws {
        let source = try source(named: "DownloadPane.swift")
        let preview = try XCTUnwrap(source.components(
            separatedBy: "case .ready").dropFirst().first?
            .components(separatedBy: "case .downloading").first)
        XCTAssertTrue(preview.contains("FileIdentityPresentation.name(for: f)"))
        XCTAssertTrue(preview.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(preview.contains(".lineLimit(1)"),
                       "the pre-save file identity is visually truncated")
    }

    /// Creating a code removes the picker, but it must not remove the sender's
    /// answer to “what am I about to send?” during minting or while the peer joins.
    func testFilePairingKeepsTheStagedFileNamesAndSizesVisibleUntilDone() throws {
        let pane = try source(named: transferSession)
        let minting = try XCTUnwrap(pane.components(
            separatedBy: "case .minting:").dropFirst().first?
            .components(separatedBy: "case let .showingCode").first)
        let showing = try XCTUnwrap(pane.components(
            separatedBy: "case let .showingCode(code, expiresAt):").dropFirst().first?
            .components(separatedBy: "case .failed(let message):").first)
        for phase in [minting, showing] {
            XCTAssertTrue(phase.contains("PendingFileList(sessionFiles: fileModel.sessionFiles)"),
                          "code creation hides the files it is waiting to send")
        }
        // **There is no batch to expand before minting any more**, and that is
        // the connect-first change rather than a weakening of the old refusal.
        // The pane has no picker, so a code is minted for a connection and the
        // manifest the states above keep visible belongs to a send made inside
        // the session. What must stay true is that the create path never reads a
        // selection: a `stage()` here would be pre-connect staging restored.
        let connect = try source(named: crossConnect)
        // The mint moved into `PairingCodeStart`, which is what stops the
        // expired-code surface growing a second copy of it — but the create
        // action must still reach one, and the mint must still be the file
        // model's, because that is the model whose `showingCode` and expiry the
        // surface renders.
        guard let create = connect.range(of: "private func createCode() {"),
              connect.range(of: "await mintAndWatch(token: access.token)",
                            range: create.lowerBound..<connect.endIndex) != nil,
              connect.contains("PairingCodeStart(module: module).createAndWatch(token: token)")
        else {
            return XCTFail("the create action lost its mint")
        }
        let starter = try source(named: "Transfer/PairingCodeStart.swift")
        XCTAssertTrue(starter.contains("await fileModel.mintCode(token: token)"),
                      "the shared pairing start no longer mints on the file model")
        XCTAssertFalse(connect.contains("selection"),
                       "the pairing create path reads a staged selection again")
        XCTAssertFalse(connect.contains("stageRealtimeFiles("),
                       "the pairing screen expands a batch before there is a peer")

        let session = try source(named: "RealtimeFileSessionView.swift")
        let connecting = try XCTUnwrap(session.components(
            separatedBy: "case .joining, .connecting:").dropFirst().first?
            .components(separatedBy: "case let .verifying").first)
        let verifying = try XCTUnwrap(session.components(
            separatedBy: "private func verifying(").dropFirst().first?
            .components(separatedBy: "private func transferring").first)
        for phase in [connecting, verifying] {
            XCTAssertTrue(phase.contains("fileList"),
                          "a connection phase hides the staged file identity")
        }
    }

    /// Clearing a staged selection changes the pending send task; it is not a
    /// navigation destination. Keep all three macOS entry points aligned with
    /// the ordinary Button semantics already used on iOS.
    func testEverySendPanePresentsClearAsAnActionButton() throws {
        for pane in [transferStaging, "UploadPane.swift"] {
            let source = try source(named: pane)
            let clear = try XCTUnwrap(source.components(
                separatedBy: "Button(L10n.t(.commonClear)) { selection.clear() }").dropFirst().first,
                "\(pane) lost its staged-selection Clear action")
                .components(separatedBy: "}").first ?? ""
            XCTAssertTrue(clear.contains(".buttonStyle(.bordered)"),
                          "\(pane) does not present Clear as a secondary action")
            XCTAssertFalse(clear.contains(".buttonStyle(.link)"),
                           "\(pane) presents a task mutation as navigation")
        }
    }

    /// A terminal pairing task still owns cleanup and, for text, the only local
    /// transcript. It must not expose a second Create/Join path until Done has
    /// returned the model to idle. iOS already enforces this same boundary.
    /// A terminal task still owns its dead connection, its partial receive and,
    /// for text, the only local transcript. It must not expose a second
    /// create/join path until the user has crossed the cleanup boundary.
    ///
    /// Both transfer destinations make that STRUCTURAL rather than per-state:
    /// the connect controls live in a different view, and each destination
    /// renders exactly one pane. So the assertions are (1) the session pane
    /// names no connect control at all, and (2) each destination's `switch` over
    /// `TransferSurfacePane` is the whole reason it cannot.
    func testPairingTerminalStatesExposeOnlyTheirCleanupBoundary() throws {
        let session = try source(named: transferSession)
        for connectControl in ["createControls", "joinControls", "roster", "deviceRow",
                               "normalizedJoinCode", "CapabilityGateView"] {
            XCTAssertFalse(session.contains(connectControl),
                           "the live/terminal session surface exposes \(connectControl)")
        }
        XCTAssertTrue(session.contains("Button(L10n.t(.workspaceLeaveSession)) { leaveOrConfirm() }"),
                      "a retained terminal session has no explicit cleanup boundary")
        XCTAssertFalse(session.contains("buttonStyle(.link)"),
                       "a task mutation is presented as navigation")

        for (name, connectPane) in [(lanDestination, "LanConnectPane("),
                                    (crossDestination, "CrossNetworkConnectPane(")] {
            let destination = try source(named: name)
            XCTAssertTrue(destination.contains("switch pane {")
                          && destination.contains("case .connect:")
                          && destination.contains("case .legacySession:")
                          && destination.contains("case .link:"),
                          "\(name) no longer chooses exactly one pane")
            // The Cross-network one additionally hands in the regeneration
            // action, because it is the surface that holds the account gate a
            // replacement code has to be minted against.
            XCTAssertTrue(destination.contains("TransferSessionPane(module: module)")
                          || destination.contains(
                            "TransferSessionPane(module: module, regenerate: regeneratePairingCode)"),
                          "\(name) draws a session pane it did not hand its own module")
            XCTAssertTrue(destination.contains(connectPane),
                          "\(name) must render both phases of the one task")
            XCTAssertTrue(destination.contains("private var pane: TransferSurfacePane { module.pane }"),
                          "\(name) decides which pane to draw without asking its module")
        }
        // And the module still keys the answer on OWNERSHIP rather than on model
        // state, which is what stops a session appearing on a route that does
        // not own it.
        XCTAssertTrue(try appKitSource(named: "TransferModule.swift")
            .contains("TransferSurfacePresentation.pane(route: route,"),
                      "the module chose a pane without asking ownership")

        let fileSession = try source(named: "RealtimeFileSessionView.swift")
        let completed = try XCTUnwrap(fileSession.components(
            separatedBy: "case .completed:").dropFirst().first)
        XCTAssertTrue(completed.contains("Button(L10n.t(.commonDone), action: onDone)"))
        XCTAssertFalse(completed.components(separatedBy: "private func verifying").first?.contains(
            "buttonStyle(.link)") ?? true)
    }

    /// One exit, one confirmation. The Workspace has a single leave control for
    /// both lanes, so the local-transcript question is asked once rather than
    /// once per pane — which is also why the confirmation's destructive button is
    /// now the leave verb rather than Done.
    func testPairingDoneCannotDiscardAnyLocalTextWithoutConfirmation() throws {
        let source = try source(named: transferSession)
        XCTAssertTrue(source.contains("@State private var confirmingLocalTextLeave = false"))
        XCTAssertTrue(source.contains("if mode == .text, textModel.hasLocalContent"))
        XCTAssertTrue(source.contains(
            "Button(L10n.t(.workspaceLeaveSession), role: .destructive) { leaveSession() }"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmTitle)"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmBody)"))
        XCTAssertEqual(occurrences(of: "confirmationDialog(", in: source), 1,
                       "two confirmations for one exit is two answers to one question")
    }

    func testNearbyFileFailureKeepsTheManifestIdentityUntilBack() throws {
        let session = try source(named: "RealtimeFileSessionView.swift")
        let failed = try XCTUnwrap(session.components(
            separatedBy: "case .failed:").dropFirst().first?
            .components(separatedBy: "case .joining").first)
        XCTAssertTrue(failed.contains("fileList"),
                      "a failed transfer hides which files failed")

        let pane = try source(named: transferSession)
        let lane = try XCTUnwrap(pane.components(
            separatedBy: "case .failed(let message):").dropFirst().first?
            .components(separatedBy: "case .joining, .connecting").first)
        XCTAssertLessThan(try XCTUnwrap(lane.range(of: "InlineMessage(.failure")).lowerBound,
                          try XCTUnwrap(lane.range(of: "RealtimeFileSessionView")).lowerBound,
                          "a long file list pushes the failure reason below the fold")
    }

    func testFileCompletionClearsOnlyTheBatchThatWasActuallySent() throws {
        let session = try source(named: "RealtimeFileSessionView.swift")
        XCTAssertTrue(session.contains("let onDone: () -> Void"))
        XCTAssertTrue(session.contains("Button(L10n.t(.commonDone), action: onDone)"))

        // One pane, one rule, for both routes — which is the point of the merge:
        // the pairing half and the same-network half used to answer this
        // separately, and separately is how two answers drift.
        let pane = try source(named: transferSession)
        XCTAssertTrue(pane.contains(
            "RealtimeFileSessionView(model: fileModel, onDone: finishCompletedFileTransfer)"))
        // **Nothing app-scoped is left to clear.** The rule this used to state —
        // which finished task keeps the staged batch — existed because one
        // `SelectionStore` outlived every session and both exits had to decide
        // what to do with it. There is no such store: a connect-first send
        // expands its batch inside `send(directories:)` and it dies with the
        // call. A `selection.clear()` reappearing here would mean an app-scoped
        // staging context had come back with it.
        XCTAssertEqual(occurrences(of: "selection.clear()", in: pane), 0,
                       "the session pane clears an app-scoped staged batch again")
        XCTAssertFalse(pane.contains("@ObservedObject var selection"),
                       "the session pane holds an app-scoped selection again")
        XCTAssertFalse(pane.contains("preservesFailedFiles"),
                       "a staged-batch retention rule survived the store it was about")
    }

    /// Minting is a locked network wait: the idle controls are gone until the
    /// request settles, so both pairing modes need an explicit way back.
    ///
    /// **It is `module.cancelPairingCode()` in both, and it must be.** Ending
    /// only the lane that renders the digits — which is what each of these
    /// buttons used to do — left `LinkWorkspaceModel` in `.watching(code:)` with
    /// its pairing socket open and nothing on screen pointing at it.
    /// `watchPairingCode` refuses a second room while one is held, so the next
    /// code that process minted was never watched and fell back to the legacy
    /// wire. See `TransferModule.cancelPairingCode`.
    func testPairingMintingCanBeCancelledInBothModes() throws {
        let pane = try source(named: transferSession)
        let fileMinting = try XCTUnwrap(pane.components(separatedBy: "case .minting:")
            .dropFirst().first?.components(separatedBy: "case let .showingCode").first)
        XCTAssertTrue(
            fileMinting.contains("Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }"))
        XCTAssertTrue(fileMinting.contains(".buttonStyle(.bordered)"))

        let textMinting = try XCTUnwrap(pane.components(separatedBy: "case .minting:")
            .dropFirst().dropFirst().first?.components(separatedBy: "case let .showingCode").first)
        XCTAssertTrue(
            textMinting.contains("Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }"))
        XCTAssertTrue(textMinting.contains(".buttonStyle(.bordered)"))
    }

    /// **Every creator-side code exit is the SAME operation, and no surface
    /// releases ownership from one lane's idea of idle.**
    ///
    /// Two separate creator paths reached `owner == nil` while the module still
    /// held work, and both of them were a view looking at one lane:
    ///
    ///  1. `onPairingLinkActivated` retires the legacy model that was rendering
    ///     a creator's code once the room resolves to `link/1`. That lane going
    ///     `.idle` is the handoff, not the end — but the pane released on it, so
    ///     the connect screen was drawn with `transfer.busyElsewhere` over a live
    ///     link that then had no exit anywhere in the window.
    ///  2. A code Cancel that ended only the lane left the watched pairing room
    ///     alive, which the next mint could not replace.
    ///
    /// So the pane may not spell either operation itself. `releaseOwner()` and
    /// the local `cancelPairingWatch()` are gone; what is left is the module's
    /// own `releaseSurfaceIfIdle()` and `cancelPairingCode()`, whose rule is
    /// `TransferModule.retainsWork` and is asserted directly in
    /// `TransferModuleTests`.
    func testEveryPairingCodeExitGoesThroughTheOneModuleOperation() throws {
        let pane = try source(named: transferSession)

        XCTAssertFalse(pane.contains("private func releaseOwner()"),
                       "the pane released ownership without asking whether the whole "
                       + "module was idle, which is how a link/1 handoff lost its surface")
        XCTAssertFalse(pane.contains("presence.release("),
                       "the pane releases this module's surface directly again, "
                       + "bypassing TransferModule.retainsWork")
        XCTAssertFalse(pane.contains("presence.releaseAll()"),
                       "the pane gives up a surface it may not own")
        XCTAssertFalse(pane.contains("private func cancelPairingWatch()"),
                       "a second, joiner-only spelling of the code cancel came back")

        // Every Cancel that ends a code — minting, the shown code, the expired
        // code beneath it, and the joiner's wait — names the one operation.
        XCTAssertEqual(occurrences(of: "module.cancelPairingCode()", in: pane), 5,
                       "a pairing-code exit stopped using the shared cancel, or a new "
                       + "one appeared without it")
        // The expired-code branch has no cancel of its own: it is handed the
        // same closure the live handoff is, so the two cannot diverge.
        let expired = try XCTUnwrap(pane.components(separatedBy: "private func expiredCode(")
            .dropFirst().first?
            .components(separatedBy: "private var waitingOnJoinedCode").first)
        XCTAssertTrue(expired.contains("Button(L10n.t(.commonCancel), action: cancel)"),
                      "the expired code grew a cancel that is not the handoff's")
        XCTAssertFalse(expired.contains("fileModel.") || expired.contains("textModel."),
                       "the expired code reaches a model directly instead of the "
                       + "operation that also ends the watched room")
    }

    // MARK: - the mode picker is gone

    /// **No macOS surface may ask "files or text?" before there is a peer.**
    ///
    /// The segmented picker was the single most damaging thing left on this
    /// screen: it made a user who only wanted to say something choose a
    /// transport mode first, it sat above every other control on two
    /// destinations, and it was disabled the instant a session was claimed — so
    /// its only lasting effect was to be in the way. Each connect action now
    /// states its own kind, and `TransferPresence.mode` is written by those
    /// actions rather than by a control the user has to interpret.
    ///
    /// Asserted as an absence across every macOS source, because a picker
    /// reintroduced on one card is exactly the regression a screenshot review
    /// would call a nice touch.
    func testNoSegmentedModePickerSurvivesAnywhereOnMacOS() throws {
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            XCTAssertFalse(text.contains("pickerStyle(.segmented)"),
                           "\(name) reintroduced a segmented mode picker")
            for retired in ["hubTransferType", "hubFiles", "hubText", "hubTransferTypeHint",
                            "directModeMatchHint", "presenceBusyTitle", "presenceBusyBody",
                            "presenceShowIt"] {
                XCTAssertFalse(text.contains(retired),
                               "\(name) still renders separate-mode copy: \(retired)")
            }
        }
        // `selectMode` was the picker's setter. A mode is now decided by the verb
        // that starts a session, through `beginSession(_:mode:)`, which takes
        // ownership in the same synchronous step — so a second caller would be a
        // second authority able to repoint an intent nobody restated.
        //
        // Exactly ONE site survives, and it is not a control: `RelayiumApp` hands
        // `AppDeepLinkCoordinator` a `selectRealtimeMode` closure, because that
        // coordinator is shared with iOS, where the mode still has a picker
        // (`DirectModeSelection`). On macOS the write is inert by construction —
        // the coordinator refuses to apply a link while anything is claimed, and
        // the next `beginSession` sets the mode itself — so it is kept as the
        // shared seam rather than special-cased per platform. Naming the file
        // here is what stops that argument from being quietly extended to a view.
        let modeWriters = try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains("selectMode(") }.map(\.name).sorted()
        XCTAssertEqual(modeWriters, ["RelayiumApp.swift"],
                       "a macOS surface writes the transfer mode outside a session claim")
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertEqual(occurrences(of: "selectMode(", in: app), 1)
        // The DIRECT module's presence, because `AppRouting` sends a realtime
        // link to `.pairingCode`. Handed the Nearby module's, the coordinator
        // would apply a pairing link's mode to a same-network session.
        XCTAssertTrue(app.contains(
            "selectRealtimeMode: { mode in directModule.presence.selectMode(mode) }"),
                      "the one surviving mode write is no longer the shared deep-link seam")
    }

    /// The verification setting is the one control that still has to lock at
    /// claim time rather than at busy time: the models read it when the SAS
    /// arrives, and ownership is taken synchronously before either model can
    /// publish a non-idle state.
    ///
    /// The lock is computed from the destination's OWN module now. That is the
    /// second half of the same requirement: it must still close the
    /// claim-before-busy window, and it must no longer be closed by the other
    /// module's session — a user holding a same-network connection could not
    /// change the verification default before a pairing code they had not
    /// started.
    func testDirectChoicesLockAtClaimBeforeTheModelsBecomeBusy() throws {
        for name in [lanDestination, crossDestination] {
            let destination = try source(named: name)
            XCTAssertTrue(destination.contains(
                "private var sessionLocked: Bool { !module.acceptsNewSession }"),
                "\(name)'s lock reads busy flags that lag the synchronous claim")
            XCTAssertFalse(destination.contains("TransferSurfacePresentation.acceptsNewSession("),
                           "\(name) re-derives the lock instead of asking its own module")
            XCTAssertTrue(destination.contains(
                "VerificationSetting(locked: sessionLocked, preference: verification)"),
                "\(name) does not lock the verification default with the session")
        }
        // And the module's own answer is still the claim-aware one: ownership
        // AND the models' retained state, exactly as the two destinations
        // computed it before they shared it.
        let module = try appKitSource(named: "TransferModule.swift")
        XCTAssertTrue(module.contains(
            "TransferSurfacePresentation.acceptsNewSession(\n            owner: presence.owner, sessionIsLiveOrRetained: sessionIsLiveOrRetained)"),
            "the module's lock dropped the synchronous claim it exists to cover")
        // The setting's own file re-checks the lock in the setter as well as
        // disabling the control: a click delivered from the previous render can
        // land after a claim, and `.disabled` alone would not stop it.
        let setting = try source(named: "Components/VerificationSetting.swift")
        XCTAssertTrue(setting.contains(
            "set: { if !locked { preference.requiresSASConfirmation = $0 } }"),
            "verification can change after claim but before handshake state appears")
        XCTAssertTrue(setting.contains(".disabled(locked)"))
    }

    func testSessionOwnershipCleanupIsAppScopedAndNeverRunsFromInitialViewIdle() throws {
        // The liveness subscription moved into `TransferModule`, which is where
        // it belongs now that each module has its own presence — one place, one
        // copy, applied identically to both. The link is still the THIRD source
        // in the SAME subscription: a separate observer would release the
        // surface the instant a link started, because a link uses neither legacy
        // model and both read idle for its whole life.
        let module = try appKitSource(named: "TransferModule.swift")
        XCTAssertTrue(module.contains(
            "presence.observeSessions(fileModel: files, textModel: text, link: link)"))
        XCTAssertFalse(module.contains(
            "presence.observeSessions(fileModel: files, textModel: text)\n"),
            "a second liveness subscription would race the first")
        // And the scene no longer wires one itself, which is what stops a third
        // app-scoped presence appearing beside the two modules'.
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertFalse(app.contains(".observeSessions("),
                       "the scene wires a liveness subscription the modules already own")
        XCTAssertEqual(occurrences(of: "TransferModule(route:", in: app), 2,
                       "macOS composes exactly two independent transfer modules")
        for name in [lanDestination, crossDestination, lanConnect, crossConnect,
                     transferSession] {
            let destination = try source(named: name)
            XCTAssertFalse(destination.contains("presence.releaseAll()"),
                           "\(name) can erase a fresh claim from its initial idle task")
            XCTAssertFalse(destination.contains("cancelEverything()"),
                           "\(name) can end the other module's session as well as its own")
        }
        // Only the owner may let go, and the release must name ITS OWN route
        // rather than whatever the presence object currently holds — a stale
        // view rebuilt on the other transfer screen would otherwise blank a live
        // session.
        //
        // **That release now lives on the module**, guarded by `retainsWork`,
        // and the pane delegates to it. It had to move: the pane released on the
        // idle edge of the ONE lane it was drawing, so the `link/1` handoff —
        // which retires a creator's code model precisely because a link has
        // taken over — gave the surface up under a live link. The route is still
        // the module's own, which is the same guarantee with one fewer thing for
        // a caller to get wrong.
        XCTAssertTrue(module.contains("guard !retainsWork else { return false }")
                      && module.contains("presence.release(route)"),
                      "the module releases a route it may not own, or releases it "
                      + "without asking whether anything still holds work")
        XCTAssertFalse(module.contains("presence.release(presence.owner)"),
                       "the module releases whichever route happens to own the session")
        let session = try source(named: transferSession)
        XCTAssertTrue(session.contains("private var route: AppDestination { module.route }"),
                      "the session pane lost the route its own claims are checked against")
        XCTAssertTrue(session.contains("module.releaseSurfaceIfIdle()"),
                      "the session pane no longer releases through the module's rule")
    }

    /// **The two modules share no session object at all**, which is what makes
    /// "a connection survives navigating to the other screen" a property of the
    /// composition rather than a behaviour somebody has to preserve.
    ///
    /// Three separate claims, and each one has a failure it prevents:
    ///
    ///  * each module is built with its OWN presence, so neither can lock,
    ///    release or refuse the other's session;
    ///  * the Nearby module's models carry no code path and the Direct module's
    ///    carry no roster path, so neither screen can start the other's kind of
    ///    session even if a later edit asked it to;
    ///  * only the Direct link watches a pairing code, and only the Nearby link
    ///    observes the room — one model registered for both is what let the LAN
    ///    roster's churn cancel a pairing request in flight.
    func testTheTwoTransferModulesShareNoSessionState() throws {
        let app = try source(named: "RelayiumApp.swift")
        // Composed from the module-specific factories, never the general ones.
        for factory in ["makeNearbyRealtimeModel(", "makeNearbyRealtimeTextModel(",
                        "makeNearbyLinkWorkspaceModel(", "makeDirectRealtimeModel(",
                        "makeDirectRealtimeTextModel(", "makeDirectLinkWorkspaceModel("] {
            XCTAssertTrue(app.contains(factory),
                          "the scene stopped composing modules through \(factory)")
        }
        for shared in ["AppEnvironment.makeRealtimeModel(", "AppEnvironment.makeRealtimeTextModel(",
                       "AppEnvironment.makeLinkWorkspaceModel("] {
            XCTAssertFalse(app.contains(shared),
                           "the scene rebuilt a model both modules would share: \(shared)")
        }
        // No app-scoped presence, and no app-scoped session model, beside them.
        XCTAssertFalse(app.contains("@StateObject private var presence: TransferPresence"),
                       "a shared presence would arbitrate the two modules again")
        // **And neither module is HANDED one.** `TransferModule`'s `presence`
        // parameter exists so a test can pre-claim a surface; passing the same
        // instance to both here is the one edit that restores the shipped defect
        // while leaving every other assertion in this file green. It was checked
        // by mutation: with one shared presence, the two built-App paths in
        // `AppShellUITests` fail on "a same-network session disabled the Direct
        // screen's Create", and nothing in this file did.
        for construction in app.components(separatedBy: "TransferModule(route:").dropFirst() {
            XCTAssertFalse(String(construction.prefix(240)).contains("presence:"),
                           "a module is built with a presence somebody else may also hold")
        }
        for retired in ["@StateObject private var realtimeModel",
                        "@StateObject private var realtimeTextModel",
                        "@StateObject private var linkWorkspace"] {
            XCTAssertFalse(app.contains(retired),
                           "a shared session model survived the module split: \(retired)")
        }
        // The environment carries the container, so a destination is HANDED one
        // module rather than reaching for whichever is in scope.
        XCTAssertTrue(app.contains(".environmentObject(transferModules)"))
        let shell = try source(named: "Shell/AppShellView.swift")
        XCTAssertTrue(shell.contains("LanTransferDestination(module: modules.nearby)")
                      && shell.contains(
                        "CrossNetworkTransferDestination(module: modules.direct)"),
                      "the shell no longer hands each destination exactly one module")
        // The Nearby module's own factories refuse the code path, and the
        // Direct module's refuse the roster path. Read from the factory file,
        // because that is where the refusal actually is.
        let environment = try appKitSource(named: "AppEnvironment.swift")
        for nearbyFactory in ["makeNearbyRealtimeModel", "makeNearbyRealtimeTextModel"] {
            let body = try declaration(of: nearbyFactory, in: environment)
            XCTAssertTrue(body.contains("makeConnection: { _, _, _ in throw NearbyError.notScanning }"),
                          "\(nearbyFactory) can join or mint a pairing code")
            XCTAssertFalse(body.contains("makeRoomConnection:"),
                           "\(nearbyFactory) can adopt a pairing room")
        }
        for directFactory in ["makeDirectRealtimeModel", "makeDirectRealtimeTextModel"] {
            let body = try declaration(of: directFactory, in: environment)
            XCTAssertFalse(body.contains("makeNearbyConnection:"),
                           "\(directFactory) can dial a same-network roster peer")
            XCTAssertFalse(body.contains("makeInboundConnection:"),
                           "\(directFactory) can answer an unsolicited same-network offer")
        }
        // One room each. The direct link is not a room observer; the nearby link
        // has no pairing socket to open.
        XCTAssertFalse(try declaration(of: "makeDirectLinkWorkspaceModel", in: environment)
            .contains("addRoomObserver"),
                       "the pairing module observes the same-network roster again")
        XCTAssertFalse(try declaration(of: "makeNearbyLinkWorkspaceModel", in: environment)
            .contains("connectPairingSocket"),
                       "the same-network module can open a pairing code's socket")
        // Only the DIRECT module is wired to the pairing fallback and the code
        // handoff; only the NEARBY module answers an unsolicited link.
        XCTAssertTrue(app.contains("directLink.adoptLegacyRoom =")
                      && app.contains("directLink.onLegacyFallbackBatch =")
                      && app.contains("directLink.onPairingLinkActivated ="),
                      "the pairing fallback reaches a module other than Direct")
        XCTAssertTrue(app.contains("nearbyLink.shouldAcceptLink ="),
                      "an unsolicited same-network link is admitted by the wrong module")
        XCTAssertTrue(app.contains("presence: nearbyModule.presence, navigation: routing)"),
                      "an inbound same-network offer is admitted against the wrong presence")
    }

    /// Quit is the ONE action that means every module, and the only caller of
    /// `TransferModules.cancelEverything`.
    ///
    /// The distinction is the owner's requirement: a Cancel on one screen must
    /// end that screen's connection and nothing else, while ⌘Q must warn about —
    /// and then end — whatever either module holds. Two verbs, and the wide one
    /// is reachable from exactly one place.
    func testOnlyTheQuitGuardCanEndBothModulesAtOnce() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertEqual(occurrences(of: "transferModules.cancelEverything()", in: app), 1,
                       "the app-wide teardown gained a second caller")
        XCTAssertTrue(app.contains("quitGuard.cancelTransfers = {")
                      && app.contains("quitGuard.isTransferRunning = {")
                      && app.contains("|| transferModules.isBusy")
                      && app.contains("quitGuard.hasLocalText = { transferModules.hasLocalText }"),
                      "the quit guard asks or ends only one of the two modules")
        for (name, text) in try sources(under: macRoot, atLeast: 20)
        where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("cancelEverything()"),
                           "\(name) can end both modules at once")
        }
    }

    func testInboundNearbyOfferPassesOwnershipAdmissionBeforeBuildingResponder() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("receive.shouldAcceptSession = { kind, peerID in"),
                      "macOS can build an inbound responder during an outbound claim-before-busy gap")
        XCTAssertTrue(app.contains(
            "peerLabel: nearby.label(forPeerID: peerID)"),
                      "inbound admission must use the same atomic claim-before-navigation route")
    }

    func testAReopenedWindowReconcilesRatherThanReadmittingTheLiveSession() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        XCTAssertTrue(shell.contains("AppRouting.reconcileIncoming(kind,"),
                      "window reconstruction cannot use strict new-offer admission")
        XCTAssertFalse(shell.contains("AppRouting.claimIncoming(kind,"),
                       "the shell must not make an existing session look like a new offer")
    }

    func testNearbySessionKeepsItsPeerVisibleAfterTheRosterDisappears() throws {
        let pane = try source(named: transferSession)
        XCTAssertTrue(pane.contains("presence.sessionPeerLabel"))
        XCTAssertTrue(pane.contains("L10n.t(.nearbySessionWith"))
        XCTAssertTrue(pane.contains("L10n.t(.nearbySessionPeerDisclaimer)"),
                      "a peer-supplied label must not be presented as verified identity")
        // A pairing-code session has no roster label to snapshot. It says how the
        // peer was reached rather than leaving the header blank or, worse,
        // inventing a name for somebody nobody named.
        XCTAssertTrue(pane.contains("L10n.t(.workspaceSessionWithCode)"),
                      "a code-reached session renders no header at all")
        XCTAssertEqual(occurrences(of: ".accessibilityIdentifier(\"transfer-session-peer\")",
                                   in: pane), 2,
                       "both header shapes need the same stable runtime identity")
    }

    /// Before a text peer connects there is no transcript or result to retain.
    /// Cancel should match the file flow and return directly to the start screen.
    func testTextConnectingCancelDoesNotCreateAnEmptyTerminalTask() throws {
        let source = try source(named: "RealtimeTextSessionView.swift")
        let connecting = try XCTUnwrap(source.components(
            separatedBy: "case .joining, .connecting:").dropFirst().first?
            .components(separatedBy: "case let .verifying").first)
        XCTAssertTrue(connecting.contains("Button(L10n.t(.commonCancel)) { model.reset() }"))
        XCTAssertFalse(connecting.contains("model.end()"),
                       "Cancel creates an empty Session ended task that still needs Done")
    }

    /// Mismatch, refusal and ending all terminate the live relationship. Their
    /// macOS controls must carry the same destructive semantics as iOS, while
    /// Match and Accept remain the only prominent affirmative choices.
    func testTextSessionTerminationActionsAreVisiblyDestructive() throws {
        let session = try source(named: "RealtimeTextSessionView.swift")
        for action in [".sessionTheyDontMatch", ".commonReject"] {
            XCTAssertEqual(occurrences(of: "Button(L10n.t(\(action)), role: .destructive)",
                                       in: session), 1,
                           "\(action) lost its destructive role")
        }
        XCTAssertEqual(occurrences(of:
            "Button(L10n.t(.commonEndSession), role: .destructive)", in: session), 3,
            "waiting, open and draft-confirmation termination must be destructive")
        XCTAssertEqual(occurrences(of: ".buttonStyle(.bordered)", in: session), 4,
                       "each destructive session action needs an explicit task-button shape")
        XCTAssertEqual(occurrences(of: ".buttonStyle(.borderedProminent)", in: session), 3,
                       "only Match, Accept and the open-session Send action are prominent")
    }

    func testEndingAnOpenTextSessionCannotSilentlyDiscardADraft() throws {
        let source = try source(named: "RealtimeTextSessionView.swift")
        XCTAssertTrue(source.contains("@State private var confirmingDraftDiscard = false"))
        XCTAssertTrue(source.contains("if model.draft.isEmpty"))
        XCTAssertTrue(source.contains(
            "Button(L10n.t(.commonEndSession), role: .destructive) { endOrConfirmDraftDiscard() }"))
        XCTAssertEqual(occurrences(of: "model.discardDraftAndEnd()", in: source), 1)
        let waiting = try XCTUnwrap(source.components(separatedBy: "private func waiting(")
            .dropFirst().first?.components(separatedBy: "private func incomingRequest").first)
        XCTAssertTrue(waiting.contains("model.end()"))
        XCTAssertFalse(waiting.contains("model.discardDraftAndEnd()"))
        let confirmation = try XCTUnwrap(source.components(
            separatedBy: "L10n.t(.textDiscardDraftConfirmTitle)").dropFirst().first)
        XCTAssertTrue(confirmation.contains("model.discardDraftAndEnd()"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardDraftConfirmTitle)"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardDraftConfirmBody)"))
        XCTAssertTrue(source.contains("terminalMessage\n                retainedDraft"))
        XCTAssertTrue(source.contains("Text(model.draft)"))
        XCTAssertTrue(source.contains(".textSelection(.enabled)"))
        XCTAssertTrue(source.contains("@State private var copiedDraft = false"))
        XCTAssertTrue(source.contains("copyText(model.draft)"))
        XCTAssertTrue(source.contains("copiedDraft ? .commonCopied : .commonCopy"))
    }

    func testFileMismatchAndMidTransferCancelStateTheirDestructiveCost() throws {
        let session = try source(named: "RealtimeFileSessionView.swift")
        XCTAssertTrue(session.contains(
            "Button(L10n.t(.sessionTheyDontMatch), role: .destructive) { model.rejectSAS() }"))
        XCTAssertTrue(session.contains(
            "Button(L10n.t(.commonCancel), role: .destructive) { model.cancel() }"))
        XCTAssertEqual(occurrences(of:
            "Button(L10n.t(.commonCancel)) { model.cancel() }", in: session), 1,
            "only pre-transfer connection Cancel should remain neutral")
    }

    func testClearingTheOnlyLocalTextHistoryRequiresDestructiveConfirmation() throws {
        let session = try source(named: "RealtimeTextSessionView.swift")
        XCTAssertEqual(occurrences(of: "confirmingHistoryClear = true", in: session), 2,
                       "open and terminal history must enter the same confirmation")
        XCTAssertEqual(occurrences(of: "model.clearHistory()", in: session), 1,
                       "history may only be erased by the confirmation action")
        XCTAssertTrue(session.contains(
            "Button(L10n.t(.textClearHistory), role: .destructive) { model.clearHistory() }"))
        XCTAssertTrue(session.contains("L10n.t(.textClearHistoryConfirmTitle)"))
        XCTAssertTrue(session.contains("L10n.t(.textClearHistoryConfirmBody)"))
    }

    /// Waiting on a code the peer never joined is not a session to END — there is
    /// no transcript and no connection. Cancelling returns straight to the
    /// connect phase, in both lanes, through each model's own reset/cancel.
    func testTextCodeWaitingCancelReturnsDirectlyToThePairingEntry() throws {
        let source = try source(named: transferSession)
        let text = try XCTUnwrap(source.components(
            separatedBy: "private var textLane:").dropFirst().first?
            .components(separatedBy: "private func codeHandoff").first)
        XCTAssertTrue(text.contains("cancel: { module.cancelPairingCode() }"),
                      "the text handoff lost its direct way back")
        XCTAssertFalse(text.contains("textModel.end()"),
                       "Cancel creates an empty Session ended task that still needs Done")
        let files = try XCTUnwrap(source.components(
            separatedBy: "private var fileLane:").dropFirst().first?
            .components(separatedBy: "private var textLane").first)
        XCTAssertTrue(files.contains("cancel: { module.cancelPairingCode() }"),
                      "the file handoff lost its direct way back")
    }

    func testGeneratedCodeCancelIsPresentedAsATaskButton() throws {
        let source = try source(named: "QRCode.swift")
        let handoff = try XCTUnwrap(source.components(
            separatedBy: "struct PairingCodeHandoffView:").dropFirst().first)
        let cancel = try XCTUnwrap(handoff.components(
            separatedBy: "Button(L10n.t(.commonCancel), action: cancel)").dropFirst().first?
            .components(separatedBy: "}").first)
        XCTAssertTrue(cancel.contains(".buttonStyle(.bordered)"))
    }

    /// One handoff builder for both lanes now, so the expiry scope cannot be
    /// stated correctly in one and ambiguously in the other.
    func testPairingExpiryIsNamedAsCodeExpiryNotTransferExpiry() throws {
        let source = try source(named: transferSession)
        let handoff = try XCTUnwrap(source.components(
            separatedBy: "private func codeHandoff(").dropFirst().first?
            .components(separatedBy: "// MARK: - what this connection carries").first)
        XCTAssertTrue(handoff.contains("L10n.t(.pairingCodeExpiryNote)"),
                      "the expiry scope is ambiguous")
        XCTAssertTrue(handoff.contains(
            ".accessibilityIdentifier(\"pairing-code-expiry-note\")"))
        // **A live countdown, not a static clock time.** `common.expires` printed
        // the deadline once — true, and useless to somebody reading six digits
        // down a phone, because nothing on screen said whether the code they were
        // still dictating was worth anything.
        XCTAssertTrue(handoff.contains("L10n.t(.pairingCodeExpiresIn,"),
                      "the pairing code lost its countdown")
        XCTAssertFalse(handoff.contains("L10n.t(.commonExpires,"),
                       "the pairing code is back to a static deadline")
        // And the countdown, the withdrawal of the handoff and the expired
        // notice are all ONE answer, so they cannot disagree about the instant
        // the code dies.
        XCTAssertTrue(handoff.contains("PairingCodeExpiry.presentation(expiresAt: expiresAt,"),
                      "the surface decides expiry itself instead of asking the one rule")
        XCTAssertTrue(handoff.contains("if deadline.isUsable {"),
                      "the join handoff is offered without asking whether the code works")
    }

    /// **The join link is the code and nothing else.**
    ///
    /// It used to carry `?mode=file` or `?mode=text`, so a recipient opening it
    /// landed in the lane the sender had chosen. There is no such choice to
    /// preserve: one Create action mints one code, and a hint naming a lane the
    /// sender never picked would be the removed question smuggled back into a
    /// URL. This is now byte-identical to the web's own `#c=<code>`.
    ///
    /// PARSING a mode is untouched, and deliberately: links already passed on
    /// have to keep working. That is `AppDeepLinkTests`' half.
    func testPairingHandoffCarriesTheCodeAndNoLaneHint() throws {
        let pane = try source(named: transferSession)
        XCTAssertTrue(pane.contains("transferPairingJoinURL(code: code)"),
                      "the handoff link is built with something other than the bare code")
        XCTAssertFalse(pane.contains("transferPairingJoinURL(code: code, mode:"),
                       "the handoff link still names a lane the sender never chose")
        // No macOS surface emits one at all — the parser keeps its `mode`
        // parameter for inbound links, and this is what stops a second caller
        // quietly using it to send one.
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            XCTAssertFalse(text.contains("PairingJoinURL(code:") && text.contains("mode:")
                           && text.contains("PairingJoinURL(code: code, mode:"),
                           "\(name) emits a lane hint in a join link")
        }
    }

    func testPairingHandoffShowsTheWholeCurrentLink() throws {
        let source = try source(named: "QRCode.swift")
        let link = try XCTUnwrap(source.components(
            separatedBy: "struct PairingJoinLinkView:").dropFirst().first?
            .components(separatedBy: "struct PairingCodeHandoffView:").first)
        XCTAssertTrue(link.contains("Text(url.absoluteString)"))
        XCTAssertTrue(link.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(link.contains(".lineLimit(1)"),
                       "the capability link is still visually truncated")
        XCTAssertTrue(link.contains(".onChange(of: url) { _ in copied = false }"),
                      "copy feedback can survive onto a replacement link")
    }

    func testStoredTransferProgressNamesTheTaskAndCurrentValue() throws {
        let upload = try source(named: "UploadPane.swift")
        let uploading = try XCTUnwrap(upload.components(
            separatedBy: "private func uploadingCard").dropFirst().first?
            .components(separatedBy: "// MARK: - terminal").first)
        XCTAssertTrue(uploading.contains(".accessibilityLabel(L10n.t(.uploadHeading))"))
        XCTAssertTrue(uploading.contains(".accessibilityValue("))
        XCTAssertTrue(uploading.contains("L10n.percent(done: sent, total: total)"))

        let download = try source(named: "DownloadPane.swift")
        let downloading = try XCTUnwrap(download.components(
            separatedBy: "case .downloading").dropFirst().first?
            .components(separatedBy: "case .done").first)
        XCTAssertTrue(downloading.contains(
            ".accessibilityLabel(L10n.t(.downloadInProgress))"))
        XCTAssertTrue(downloading.contains(".accessibilityValue("))
        XCTAssertTrue(downloading.contains("L10n.percent(done: received, total: total)"))
    }

    func testAccountMetersDoNotAnnounceBarePercentages() throws {
        let source = try source(named: "AccountView.swift")
        let meter = try XCTUnwrap(source.components(
            separatedBy: "private func meter(").dropFirst().first)
        XCTAssertTrue(meter.contains("Text(title)"))
        XCTAssertTrue(meter.contains("L10n.t(.accountMeterOf"))
        XCTAssertTrue(meter.contains("ProgressView(value: fraction)"))
        XCTAssertTrue(meter.contains(".accessibilityElement(children: .combine)"),
                      "the percentage is detached from the quota it measures")
    }

    /// iOS already locks both controls while resolving/downloading. macOS must
    /// not leave a second Open path live over a task whose writer and Cancel
    /// handle the shared model still owns.
    func testStoredReceiveCannotOpenAnotherLinkWhileBusy() throws {
        let source = try source(named: "DownloadPane.swift")
        XCTAssertTrue(source.contains(".disabled(model.isBusy)"),
                      "the link field stays editable over a live download")
        XCTAssertTrue(source.contains(".disabled(model.linkText.isEmpty || model.isBusy)"),
                      "Open can replace a live download")
        let resolving = try XCTUnwrap(source.components(separatedBy: "case .resolving:")
            .dropFirst().first?.components(separatedBy: "case .ready").first)
        XCTAssertTrue(resolving.contains("Button(L10n.t(.commonCancel)) { model.cancel() }"),
                      "a stalled manifest resolution has no user exit")
        XCTAssertTrue(resolving.contains(".buttonStyle(.bordered)"),
                      "Cancel is not presented as a task action")
    }

    func testStoredReceiveLinkKeepsItsPurposeAfterInput() throws {
        let source = try source(named: "DownloadPane.swift")
        XCTAssertTrue(source.contains(
            ".accessibilityLabel(L10n.t(.downloadLinkPlaceholder))"),
            "the link field loses its purpose when its placeholder disappears")
        XCTAssertTrue(source.contains(".accessibilityIdentifier(\"receive.link\")"),
                      "runtime acceptance has no stable receive-link control")

        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("testMalformedStoredLinkExplainsHowToRecover"))
        XCTAssertTrue(ui.contains("window.textFields[\"receive.link\"]"))
        XCTAssertTrue(ui.contains("That doesn't look like a Relayium link."))
    }

    /// Completion owns one result until Done; a second input must not compete
    /// with it. macOS also needs a first-class system handoff for received files,
    /// in addition to Finder reveal and drag-out.
    func testStoredReceiveCompletesWithShareAndAnExplicitDoneBoundary() throws {
        let pane = try source(named: "DownloadPane.swift")
        XCTAssertTrue(pane.contains("if !model.isComplete"),
                      "the old link field remains live over a completed result")
        let done = try XCTUnwrap(pane.components(separatedBy: "case .done").dropFirst().first)
            .components(separatedBy: "case .failed").first ?? ""
        XCTAssertTrue(done.contains("Button(L10n.t(.commonDone)) { model.dismissResult() }"))
        XCTAssertTrue(done.contains(".buttonStyle(.bordered)"))

        let result = try source(named: "ReceivedResultView.swift")
        XCTAssertTrue(result.contains("ShareLink(items: payload.dragURLs)"),
                      "received files have no macOS system Share action")
        XCTAssertFalse(result.contains("ShareLink(items: payload.revealURLs)"),
                       "sharing must preserve the container semantics used by drag-out")
    }

    /// A generated stored link is a handoff result, not merely selectable text.
    /// macOS must provide the platform share sheet like iOS does, acknowledge a
    /// deliberate copy, and present the state-changing next-task boundary as a
    /// Button rather than an accessibility Link.
    func testStoredSendResultHasCompleteHandoffAndButtonSemantics() throws {
        let source = try source(named: "UploadPane.swift")
        let terminal = try XCTUnwrap(source.components(
            separatedBy: "private func linkReadyCard").dropFirst().first)
            .components(separatedBy: "private func failureCard").first ?? ""

        XCTAssertTrue(terminal.contains("ShareLink(item: link)"),
                      "the generated link has no system Share action")
        XCTAssertTrue(terminal.contains("copiedLink = link"),
                      "Copy gives no visible acknowledgement")
        XCTAssertTrue(terminal.contains("copiedLink == link"),
                      "copy acknowledgement can leak into a later result")
        XCTAssertTrue(terminal.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(terminal.contains(".lineLimit(1)"),
                       "the stored capability result is visually truncated")
        XCTAssertTrue(terminal.contains("Button(L10n.t(.uploadSendAnother))"))
        XCTAssertFalse(terminal.contains("buttonStyle(.link)"),
                       "Send another is exposed as a navigation Link")
    }

    /// Leaving Nearby tears down the active task and drops local state. The
    /// visible control and its accessibility role must describe a Button, as
    /// the equivalent iOS surface already does, rather than harmless navigation.
    func testNearbyBackToDevicesKeepsTaskBoundaryButtonSemantics() throws {
        let source = try source(named: transferSession)
        let exit = try XCTUnwrap(source.components(
            separatedBy: "private var exit: some View").dropFirst().first)
            .components(separatedBy: "// MARK: - actions").first ?? ""

        XCTAssertTrue(exit.contains(".buttonStyle(.bordered)"))
        XCTAssertFalse(exit.contains(".buttonStyle(.link)"),
                       "Leave this session is exposed as a navigation Link")
        XCTAssertTrue(exit.contains("if hasRetainedSession && !modelBusy"),
                      "a claimed owner made the terminal exit permanently unreachable")
        XCTAssertTrue(exit.contains(".accessibilityIdentifier(\"transfer-leave-session\")"),
                      "the one exit has no stable runtime identity")
        // Exactly one exit for the whole surface. Two — one per lane, as the two
        // panes this replaced had — is what let "Back to devices" and "Done"
        // disagree about what a finished task keeps.
        XCTAssertEqual(occurrences(of: "L10n.t(.workspaceLeaveSession)", in: source), 2,
                       "the exit exists once, plus its confirmation")
    }

    func testNearbyLocalTextCannotBeDiscardedByAnUnconfirmedExit() throws {
        let source = try source(named: transferSession)
        XCTAssertTrue(source.contains("@State private var confirmingLocalTextLeave = false"))
        XCTAssertTrue(source.contains("if mode == .text, textModel.hasLocalContent"))
        XCTAssertTrue(source.contains(
            "Button(L10n.t(.workspaceLeaveSession), role: .destructive) { leaveSession() }"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmTitle)"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmBody)"))
    }

    /// Copying ephemeral text changes the system clipboard, but previously gave
    /// no success signal. Feedback must follow the exact row and disappear when
    /// its history entry does, without retaining another plaintext body in view
    /// state.
    func testTextCopyAcknowledgesTheExactMessageWithoutRetainingPlaintext() throws {
        let source = try source(named: "RealtimeTextSessionView.swift")
        XCTAssertTrue(source.contains("@State private var copiedMessageID: Int?"))
        XCTAssertTrue(source.contains("copiedMessageID = message.id"))
        XCTAssertTrue(source.contains("copiedMessageID == message.id ? .commonCopied : .commonCopy"))
        XCTAssertTrue(source.contains("!history.contains(where: { $0.id == copiedMessageID })"))
        XCTAssertTrue(source.contains("ShareLink(item: message.body)"))
        XCTAssertTrue(source.contains("TextMessagePresentation.copyActionLabel("))
        XCTAssertTrue(source.contains("TextMessagePresentation.shareActionLabel("))
        XCTAssertFalse(source.contains("@State private var copiedMessage:"),
                       "the view retains a second copy of ephemeral plaintext")
    }

    /// A stored recovery link contains its decryption key. The macOS Account
    /// row must offer the platform handoff already present on iOS, while an
    /// optional explicit clipboard action acknowledges the exact row without
    /// retaining a second copy of that credential.
    func testAccountStoredLinkHasShareAndRowScopedCopyAcknowledgement() throws {
        let source = try source(named: "AccountView.swift")
        XCTAssertTrue(source.contains("@State private var copiedStoredFileID: String?"))
        XCTAssertTrue(source.contains("ShareLink(item: link)"))
        XCTAssertTrue(source.contains("deepLinkRouting.deliverStoredLink(link)"))
        XCTAssertTrue(source.contains("AccountPresentation.openActionLabel("))
        XCTAssertTrue(source.contains(
            "AccountPresentation.shareActionLabel(fileId: row.file.id)"))
        XCTAssertTrue(source.contains("copiedStoredFileID = row.id"))
        XCTAssertTrue(source.contains("AccountPresentation.copyActionLabel("))
        XCTAssertTrue(source.contains(
            "copiedStoredFileID == row.id\n                                     ? .commonCopied : .accountCopyLink"))
        XCTAssertTrue(source.contains(".onChange(of: scope)"))
        XCTAssertTrue(source.contains(".onChange(of: management.files)"))
        XCTAssertTrue(source.contains("AccountPresentation.retainedCopiedFileID("))
        XCTAssertFalse(source.contains("@State private var copiedStoredLink:"),
                       "the view retains a second copy of a recovery credential")
    }

    // MARK: - help, below the controls, on every browseable destination

    /// **Every browseable screen ends with help; the hidden one does not.**
    ///
    /// The owner's report was that a destination states what it is, hands over
    /// the controls and stops. Three assertions carry the repair, and each has a
    /// way of looking done and not being: help rendered inside a `switch` arm is
    /// absent from the states a confused reader is most likely to be in, help
    /// that is not last is help above the thing it explains, and help on the
    /// deep-link-only screen is a tutorial for getting somewhere nobody browses.
    func testEveryBrowseableDestinationEndsWithHelpAndTheHiddenOneDoesNot() throws {
        // The four scaffold destinations render the card.
        for (surface, file) in [
            (MacSurface.lanTransfer, lanDestination),
            (.crossNetworkTransfer, crossDestination),
            (.storedSend, "Destinations/StoredSendDestination.swift"),
            (.account, "Destinations/AccountDestination.swift"),
        ] {
            let text = try source(named: file)
            XCTAssertTrue(text.contains("HelpCard(surface: .\(surface.rawValue))"),
                          "\(file) offers no help below its controls")
            // Below, not above: the controls are what the screen is for.
            guard let scaffold = text.range(of: "DestinationScaffold(title:"),
                  let help = text.range(of: "HelpCard(surface:") else {
                return XCTFail("\(file) no longer has the shape this guards")
            }
            XCTAssertLessThan(scaffold.upperBound, help.lowerBound)
        }
        // Both transfer destinations render it OUTSIDE the pane `switch`, so it
        // survives a live session rather than existing only on the idle screen.
        for file in [lanDestination, crossDestination] {
            let text = try source(named: file)
            guard let connect = text.range(of: "case .connect:"),
                  let help = text.range(of: "HelpCard(surface:") else {
                return XCTFail("\(file) no longer has the shape this guards")
            }
            XCTAssertLessThan(connect.lowerBound, help.lowerBound,
                              "\(file) renders help inside one pane arm only")
        }
        // The Account screen's is outside its `session.state` switch, so the
        // sign-in form gets it too — the reader with the most questions.
        let account = try source(named: "Destinations/AccountDestination.swift")
        guard let ready = account.range(of: "case let .ready(user, usage):"),
              let accountHelp = account.range(of: "HelpCard(surface:") else {
            return XCTFail("AccountDestination no longer has the shape this guards")
        }
        XCTAssertLessThan(ready.lowerBound, accountHelp.lowerBound)

        // The hidden one, asserted as an absence.
        XCTAssertFalse(try source(named: "Destinations/StoredReceiveDestination.swift")
            .contains("Help"),
            "the deep-link-only screen grew a tutorial for reaching it")

        // No destination reprints its own name in the help block, which would
        // put back the page heading this app removed.
        let help = try source(named: "Components/HelpSection.swift")
        for heading in ["navLanTransfer", "navCrossNetwork", "navStoredSend",
                        "navAccount", "inboxTitle"] {
            XCTAssertFalse(help.contains(heading),
                           "the help block reprints a destination heading: \(heading)")
        }
    }

    /// The Device Inbox's help is a `Form` section, it is the LAST one, and it
    /// is outside the account/status branch — so all three branches end with it.
    ///
    /// It must also not arrive with a scroll view: this surface is the one
    /// destination that supplies its own (`scrolls: false`), because a grouped
    /// `Form` already is one, and nesting a second swallows the gesture.
    func testTheDeviceInboxHelpIsItsLastFormSectionInEveryBranch() throws {
        let surface = try source(named: "DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(surface.contains("HelpFormSection(surface: .deviceInbox)"),
                      "the Device Inbox offers no help")
        XCTAssertFalse(surface.contains("HelpCard("),
                       "a card inside a grouped Form draws a box inside a box")
        guard let lastBranch = surface.range(of: "accountSection(gate)"),
              let help = surface.range(of: "HelpFormSection(surface:"),
              let style = surface.range(of: ".formStyle(.grouped)") else {
            return XCTFail("the Device Inbox surface no longer has the shape this guards")
        }
        XCTAssertLessThan(lastBranch.upperBound, help.lowerBound,
                          "help is inside the account branch, so two branches lack it")
        XCTAssertLessThan(help.upperBound, style.lowerBound,
                          "help is not the last section of the Form")
        // No second scroll view, on the surface or on its host.
        for file in ["DeviceInbox/DeviceInboxSurface.swift",
                     "Destinations/DeviceInboxDestination.swift"] {
            XCTAssertFalse(try source(named: file).contains("ScrollView"),
                           "\(file) nests a scroll view around a Form")
        }
        XCTAssertTrue(try source(named: "Destinations/DeviceInboxDestination.swift")
            .contains("scrolls: false"),
            "the Device Inbox stopped supplying its own scrolling")
    }

    /// **Help is a control, and it is the size of a control.**
    ///
    /// It was a `DisclosureGroup`, whose macOS affordance is a triangle roughly
    /// twelve points square beside grey caption text: the smallest target on the
    /// screen, aimed at the reader who understands the screen least, and
    /// indistinguishable from the prose around it in either appearance. Five
    /// properties replace it, and every one of them has a way of silently
    /// regressing:
    ///
    ///  1. It is a `Button`, so it takes a focus ring under Full Keyboard
    ///     Access, hovers, and is spoken as a button rather than as text.
    ///  2. The whole ROW is the target, at least `Metrics.hitTarget` tall, with
    ///     the frame on the LABEL so the border the style draws is the size of
    ///     the target rather than of the words inside it.
    ///  3. It starts collapsed, which is what keeps help from crowding a 560pt
    ///     window.
    ///  4. The collapsed row still answers something — `topic.purpose`, what the
    ///     screen is for — so a reader who needs only that never opens anything.
    ///  5. Opened, it is complete: the numbered path from one, the boundary, the
    ///     destination, the failure with its recovery, and the guide link where
    ///     one exists.
    func testHelpIsAFullRowButtonAndStartsCollapsed() throws {
        let help = try source(named: "Components/HelpSection.swift")
        XCTAssertTrue(help.contains("@State private var expanded = false"),
                      "help no longer starts collapsed, or is no longer collapsible")
        XCTAssertTrue(help.contains("Button {\n            expanded.toggle()\n        } label: {"),
                      "help is not a button the reader can press anywhere on")
        XCTAssertTrue(help.contains(".buttonStyle(.bordered)"),
                      "the help control has no chrome, so it does not read as a control")
        XCTAssertTrue(help.contains(
            ".frame(maxWidth: .infinity, minHeight: Metrics.hitTarget, alignment: .leading)"),
            "the help control is not a full row at the minimum hit height")
        XCTAssertTrue(help.contains(".contentShape(Rectangle())"),
                      "only the drawn glyphs of the help row are clickable")
        // The state and the action are separate things to assistive technology,
        // and the chevron that shows the first is hidden from it.
        XCTAssertTrue(help.contains(
            ".accessibilityValue(L10n.t(expanded ? .helpExpandedValue : .helpCollapsedValue))"),
            "the help control does not say whether it is open")
        XCTAssertTrue(help.contains(
            ".accessibilityHint(L10n.t(expanded ? .helpCollapseHint : .helpExpandHint))"),
            "the help control does not say what pressing it does")
        XCTAssertEqual(occurrences(of: ".accessibilityIdentifier(\"destination-help\")", in: help), 1)
        // The collapsed row carries the purpose, not step one: a reader who has
        // not worked out what the screen IS cannot use its first step.
        XCTAssertTrue(help.contains("Text(L10n.t(topic.purpose))"),
                      "the collapsed row answers nothing")
        XCTAssertFalse(help.contains("destination-help-first-step"),
                       "the collapsed row is back to a numbered fragment")
        // Opened, it is complete. Each of these is one of the six answers, and
        // any of them could be silently dropped by an edit to the layout.
        for required in ["ForEach(Array(topic.steps.enumerated()), id: \\.offset)",
                         "block(heading: .helpBoundaryHeading, body: topic.boundary)",
                         "block(heading: .helpWhereHeading, body: topic.destination)",
                         "prose(topic.failure)",
                         "prose(topic.recovery)",
                         "L10n.t(.helpGuideLink)",
                         "L10n.t(.formatHelpStep, [L10n.number(number), L10n.t(key)])"] {
            XCTAssertTrue(help.contains(required),
                          "the opened help block lost \(required)")
        }
        // Both shapes render the same body, so the Form surface cannot drift
        // into a second, permanently open version.
        XCTAssertEqual(occurrences(of: "HelpBlock(topic: topic", in: help), 2,
                       "the card and the Form section no longer share one help body")
    }

    /// **One affordance, five destinations, and it survives the smallest window
    /// the app supports.**
    ///
    /// The complaint the button replaces was not that help was missing — it was
    /// on every screen — but that on every screen it was the same hard-to-hit,
    /// hard-to-see label. So consistency is the property worth guarding: exactly
    /// one help view type, reached one way, with no destination growing a
    /// variant of its own.
    ///
    /// The minimum-size half is the part a screenshot review would miss. At
    /// 560pt the purpose line wraps to two or three lines in the longer locales,
    /// and a row that truncated it instead would leave the collapsed state
    /// saying nothing at all — which is the whole of what it says.
    func testTheHelpAffordanceIsTheSameOnEveryDestinationAndSurvivesTheMinimumWindow() throws {
        let help = try source(named: "Components/HelpSection.swift")

        // Every browseable destination reaches help through one of exactly two
        // containers, and both wrap the same block. Nothing else in the app may
        // build a help view of its own.
        let builders = try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains("HelpBlock(") }.map(\.name)
        XCTAssertEqual(builders, ["Components/HelpSection.swift"],
                       "a destination builds its own help block")
        let hosts = try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains("HelpCard(surface:") || $0.text.contains("HelpFormSection(surface:") }
            .map(\.name).sorted()
        XCTAssertEqual(hosts, ["Destinations/AccountDestination.swift",
                               "Destinations/CrossNetworkTransferDestination.swift",
                               "Destinations/LanTransferDestination.swift",
                               "Destinations/StoredSendDestination.swift",
                               "DeviceInbox/DeviceInboxSurface.swift"],
                       "the five browseable destinations no longer offer the same help")

        // Wrapping, not truncating: the collapsed row's one sentence has to
        // survive the narrowest supported detail column and the longest locale.
        guard let purpose = help.range(of: "Text(L10n.t(topic.purpose))") else {
            return XCTFail("the collapsed row lost its purpose line")
        }
        let styling = String(help[purpose.upperBound...].prefix(400))
        XCTAssertTrue(styling.contains(".fixedSize(horizontal: false, vertical: true)"),
                      "the collapsed help row truncates the only thing it says")
        XCTAssertTrue(styling.contains(".multilineTextAlignment(.leading)"),
                      "a wrapped help row centres its second line")
        XCTAssertFalse(help.contains(".lineLimit("),
                       "the help row caps its own lines rather than wrapping")
        // And the block is held to the reading measure rather than to the
        // window, so a wide window does not set six answers at a thousand points.
        XCTAssertTrue(help.contains(".frame(maxWidth: Metrics.readingMeasure, alignment: .leading)"))

        // No colour of its own beyond the one accent role the app already
        // spends: light mode, dark mode and Increase Contrast are the system's
        // answers, and a hex value here would answer none of them.
        for invented in ["Color(red:", "Color(white:", "#colorLiteral", ".opacity(0."] {
            XCTAssertFalse(help.contains(invented),
                           "the help affordance invented a colour: \(invented)")
        }
        XCTAssertTrue(help.contains("Palette.action"),
                      "the help symbol is not the app's one action colour")
    }

    // MARK: - the path a transfer takes

    /// **The rail may not say more than the model knows, and it may not say it
    /// with motion.**
    ///
    /// A route diagram is the easiest thing in a UI to make dishonest: a
    /// completed-looking step costs nothing to draw and is read as fact. So the
    /// rules live in the tested seam (`PathRailPresentationTests` holds the
    /// mapping itself) and this guards the view around it:
    ///
    ///  - every stop it draws comes from `PathRailPresentation`. A surface that
    ///    built a `PathStop` inline would be a rail with no test behind it;
    ///  - it never animates. Not "less under Reduce Motion" — never, so its
    ///    meaning survives a still screen, a screenshot and a motion-sensitive
    ///    reader identically, and there is no reduced-motion branch that could
    ///    be wrong;
    ///  - it draws a rule rather than an arrow, so it mirrors in Arabic with the
    ///    `HStack` instead of pointing the wrong way;
    ///  - a tick appears only for `.reached`, and the state a rail claims is
    ///    also said in words — `common.done`, an existing string — rather than
    ///    in a private vocabulary for VoiceOver.
    func testThePathRailIsFactualStillAndMirrorSafe() throws {
        let rail = try source(named: "Components/PathRail.swift")
        for banned in ["withAnimation", ".animation(", "chevron.right", "arrow.right",
                       "accessibilityReduceMotion"] {
            XCTAssertFalse(rail.contains(banned), "the path rail contains \(banned)")
        }
        XCTAssertTrue(rail.contains("stop.progress == .reached"),
                      "the rail no longer distinguishes a finished step")
        XCTAssertTrue(rail.contains("Image(systemName: \"checkmark\")"),
                      "completion is carried by colour alone")
        XCTAssertTrue(rail.contains("stop.progress == .reached ? L10n.t(.commonDone) : \"\""),
                      "the rail states a step's completion to the eye and not to VoiceOver")
        XCTAssertTrue(rail.contains(".accessibilityLabel(PathRailPresentation.routeLabel())"),
                      "the rail's stops read as loose fragments")
        // A stop says what it IS as well as what it says. Collapsing the column
        // into one element leaves it with words and no role — the system audit
        // reported `Unknown role` on all three stops of every rail — so the role
        // is stated. Descriptive text: no action, no value to change, nothing to
        // focus.
        XCTAssertTrue(rail.contains(".accessibilityAddTraits(.isStaticText)"),
                      "a rail stop has words and no role, so VoiceOver reads it without "
                      + "being able to say what it read")

        // Exactly four surfaces draw one, each through the seam. Keeping LAN in
        // this set makes the path signature visible on every transfer surface;
        // its presentation is a route with nil progress, not a fabricated task.
        let railUsers = try sources(under: macRoot, atLeast: 30)
            .filter { $0.text.contains("PathRail(stops:") }.map(\.name).sorted()
        XCTAssertEqual(railUsers, ["DeviceInbox/DeviceInboxSurface.swift",
                                   "Transfer/CrossNetworkConnectPane.swift",
                                   "Transfer/LanConnectPane.swift",
                                   "UploadPane.swift"])
        for (name, text) in try sources(under: macRoot, atLeast: 30)
            where name != "Components/PathRail.swift" {
            XCTAssertFalse(text.contains("PathStop("),
                           "\(name) builds a path stop outside the tested seam")
        }
    }

    /// **Two levels of container, and no third.**
    ///
    /// `SectionCard` is the only chrome; `OpenSection` is a titled group with no
    /// background, nested inside it. A card inside a card is the box-in-a-box
    /// this round removed, and it is exactly what a well-meaning edit produces
    /// when a group inside a card needs a name.
    func testHierarchyIsTwoLevelsAndNeverACardInsideACard() throws {
        let card = try source(named: "Components/SectionCard.swift")
        XCTAssertTrue(card.contains("Palette.cardBackground"),
                      "the one card background is written as a literal again")
        let open = try source(named: "Components/OpenSection.swift")
        XCTAssertFalse(open.contains("background("),
                       "the second level grew chrome of its own, so it is a card")
        XCTAssertTrue(open.contains(".accessibilityElement(children: .contain)")
                      && open.contains(".accessibilityLabel(title)"),
                      "an open section is not a named group in the accessibility outline")
        // The staged batch is the group this replaced a hand-placed divider and
        // floating heading with, on both transfer screens.
        XCTAssertTrue(try source(named: transferStaging)
            .contains("OpenSection(title: L10n.t(.workspaceStagingHeading))"),
            "staging went back to a heading floating above a rule")
        // Stored send is one card and one task: choosing, the expiry options and
        // Send were two peer cards of equal weight, which read as two things to
        // do rather than three steps of one.
        let upload = try source(named: "UploadPane.swift")
        XCTAssertTrue(upload.contains("OpenSection(title: L10n.t(.uploadExpiresAfter))"),
                      "the expiry options are a peer card again")
        XCTAssertFalse(upload.contains("optionsCard"),
                       "the second stored-send card is back")
        // Nobody nests the chrome. `SectionCard` may appear many times per file;
        // what must not appear is one inside another's content.
        for (name, text) in try sources(under: macRoot, atLeast: 30) {
            XCTAssertFalse(text.contains("SectionCard(title: L10n.t(.uploadHeading)) {\n            SectionCard"),
                           "\(name) nests a card inside a card")
        }
    }

    // MARK: - what this Mac is on the network

    /// **The LAN receive surface says what this Mac is called and where it is,
    /// and says what neither fact means.**
    ///
    /// Four things have to hold together or the section is worse than nothing.
    /// The name must come from the SOCKET — the live system name is what a user
    /// who renamed their Mac sees, and no other device sees it. The addresses
    /// must be gated on actually listening and cleared otherwise, or they
    /// describe a network this Mac may have left. Neither may be persisted or
    /// logged: an address inventory is a fingerprint of somebody's home network.
    /// And both need the disclaimer that rooms are grouped by the path the
    /// service observes, because the inference that they are not is irresistible.
    func testTheLanReceiveSurfaceNamesThisMacAndItsAddressesTruthfully() throws {
        let pane = try source(named: lanConnect)

        // The socket's answer, not the system's.
        XCTAssertTrue(pane.contains("if let announced = discovery.announcedName, isListening {"),
                      "the announced name is rendered without a socket or without listening")
        // **The name is the card's primary line, rendered as itself.** It used
        // to be interpolated into a `.caption` sentence at the end of the
        // receive-status block, in the same grey as the disclaimers below it —
        // the one fact somebody reads this screen out loud for was the smallest
        // type on it. It is now a `.title3` in its own card, with the sentence
        // demoted to the caption underneath.
        XCTAssertTrue(pane.contains("Text(L10n.token(announced))\n"
                                    + "                .font(.title3.weight(.semibold))"),
                      "the announced name is no longer the identity card's primary line")
        XCTAssertTrue(pane.contains("L10n.t(.nearbyAnnouncedNameCaption)"),
                      "the announced name is shown with nothing saying what it is")
        XCTAssertTrue(pane.contains("SectionCard(title: L10n.t(.nearbyThisMacHeading))"),
                      "identity is filed back inside the receive status")
        // It is the FIRST thing under the route rail, above the card that holds
        // the roster: a first-viewport answer or it is not an answer.
        guard let rail = pane.range(of: "PathRail(stops: PathRailPresentation.lan())"),
              let identity = pane.range(of: "thisMac", range: rail.upperBound..<pane.endIndex),
              let roster = pane.range(of: "sameNetwork", range: identity.upperBound..<pane.endIndex)
        else {
            return XCTFail("the LAN pane no longer has the shape this guards")
        }
        XCTAssertLessThan(identity.upperBound, roster.lowerBound)
        // The two states a card with no name has to distinguish, because their
        // remedies are opposite: waiting, and not started.
        for state in ["nearbyIdentityAnnouncing", "nearbyIdentityNotListening"] {
            XCTAssertTrue(pane.contains(state),
                          "the identity card goes blank rather than saying \(state)")
        }
        XCTAssertTrue(pane.contains("case .connecting, .reconnecting: return true"),
                      "a Mac on its way into the room is reported as not listening at all")
        // **Independent of the receive-status sentence.** The two answer
        // different questions — who this Mac IS, and whether it is listening —
        // and filing the first under the second is what made the identity four
        // grey caption lines below a failure notice.
        guard let receiving = pane.range(of: "private var receiving: some View"),
              let identityBlock = pane.range(of: "private var identity: some View") else {
            return XCTFail("the LAN pane no longer has the shape this guards")
        }
        let receivingBody = String(pane[receiving.upperBound..<identityBlock.lowerBound])
        for moved in ["announcedName", "localAddresses", "nearbyAddressesPrivacyNote"] {
            XCTAssertFalse(receivingBody.contains(moved),
                           "the receive-status block still owns the identity: \(moved)")
        }
        // Off is still allowed to answer the owner's first question: the
        // configured name is shown as what the NEXT join will use, never as a
        // claim about what peers currently see. Once a socket exists, the
        // announced snapshot above remains authoritative.
        XCTAssertTrue(pane.contains("Text(L10n.token(AppEnvironment.deviceName()))"),
                      "the device name disappears exactly when receiving is off")
        XCTAssertTrue(pane.contains("L10n.t(.nearbyConfiguredNameCaption)"),
                      "the configured name is presented as if peers already see it")
        XCTAssertTrue(pane.contains(".accessibilityIdentifier(\"lan-configured-name\")"))
        for live in ["Host.current", "ProcessInfo"] {
            XCTAssertFalse(pane.contains(live),
                           "the surface bypasses the shared device-name rule: \(live)")
        }

        // Read while listening, emptied otherwise. The clearing half is the one
        // that keeps a stale list off a paused or stopped screen.
        XCTAssertTrue(pane.contains(
            "guard isListening, discovery.announcedName != nil else {\n            localAddresses = []"),
            "the address list is not cleared when the socket stops listening")
        XCTAssertTrue(pane.contains("while !Task.isCancelled"),
                      "addresses are read only once and can go stale without a reconnect")
        XCTAssertTrue(pane.contains("let next = LocalAddressInventory.current()"),
                      "the listening surface never refreshes its local addresses")
        XCTAssertTrue(pane.contains("if next != localAddresses {"),
                      "an unchanged address list invalidates the whole pane on every refresh")
        XCTAssertTrue(pane.contains("@State private var localAddresses: [LocalNetworkAddress] = []"),
                      "the address inventory must be view state and nothing longer-lived")
        XCTAssertTrue(pane.contains("case .off, .paused, .connecting, .reconnecting: return false"),
                      "a Mac with no socket must make no claim about being reachable")

        // Nowhere else in the app touches the inventory at all.
        let readers = try sources(under: macRoot, atLeast: 30)
            .filter { $0.text.contains("LocalAddressInventory") }.map(\.name)
        XCTAssertEqual(readers, [lanConnect],
                       "a second surface reads this Mac's addresses")

        // Never stored, never logged, never sent.
        for sink in ["UserDefaults", "NSLog", "os_log", "Logger(", "print(",
                     "FileManager.default.createFile", "URLRequest"] {
            XCTAssertFalse(pane.contains(sink),
                           "the address inventory could reach \(sink)")
        }
        // Comments stripped, for the reason the loader above exists: this file
        // documents the sinks it deliberately never reaches, and scanning its
        // raw text would fail this guard on the sentence promising the absence.
        let inventory = codeOnly(try String(
            contentsOf: appsRoot.appendingPathComponent(
                "RelayiumKit/Sources/RelayiumAppKit/LocalNetworkAddresses.swift"),
            encoding: .utf8))
        for sink in ["UserDefaults", "NSLog", "os_log", "Logger(", "print(", "URLSession"] {
            XCTAssertFalse(inventory.contains(sink),
                           "the address enumeration could reach \(sink)")
        }

        // Both disclaimers, and the empty case that is a real answer.
        for note in ["nearbyAddressesPrivacyNote", "nearbyAddressesNotGroupingNote",
                     "nearbyNoLocalAddresses"] {
            XCTAssertTrue(pane.contains(note), "the section is missing \(note)")
        }
        XCTAssertTrue(pane.contains(".accessibilityLabel(L10n.t(.nearbyA11yThisMac))"),
                      "the section is an unnamed group to VoiceOver")
        XCTAssertTrue(pane.contains(".accessibilityIdentifier(\"lan-announced-name\")"))
    }

    // MARK: - the stored link, as a command

    /// The completed stored send shows the equivalent `relayium down`, quoted,
    /// with its own copy acknowledgement and the two warnings a reader cannot
    /// see for themselves.
    ///
    /// The quoting is asserted to be DELEGATED rather than correct here —
    /// `StoredLinkCommandPresentationTests` holds it against the web's own
    /// cases. What this guards is that the view did not compose the command
    /// itself, which is exactly how the two clients would drift.
    func testTheStoredSendResultShowsTheEquivalentQuotedCommand() throws {
        let upload = try source(named: "UploadPane.swift")
        let terminal = try XCTUnwrap(upload.components(
            separatedBy: "private func cliCommand(link: String)").dropFirst().first)
            .components(separatedBy: "private func failureCard").first ?? ""

        XCTAssertTrue(terminal.contains("StoredLinkCommandPresentation.downCommand(link: link)"),
                      "the command is composed in the view instead of the tested seam")
        for (name, text) in try sources(under: macRoot, atLeast: 30) {
            XCTAssertFalse(text.contains("relayium down"),
                           "\(name) writes the command as a literal")
        }

        // Monospaced, selectable, and left-to-right through the app's own
        // isolate rather than by overriding a scene's layout direction.
        XCTAssertTrue(terminal.contains("Text(L10n.token(command))"),
                      "the command is not isolated, so Arabic would reorder it")
        XCTAssertTrue(terminal.contains(".font(.system(.body, design: .monospaced))"))
        XCTAssertTrue(terminal.contains(".textSelection(.enabled)"))
        XCTAssertFalse(terminal.contains(".lineLimit(1)"),
                       "the command is visually truncated")

        // Its OWN copy confirmation. One shared flag would acknowledge whichever
        // of the two was copied last beside both buttons.
        XCTAssertTrue(terminal.contains("copiedCommand = command"))
        XCTAssertTrue(terminal.contains("copiedCommand == command"))
        XCTAssertFalse(terminal.contains("copiedLink"),
                       "the command's copy state is the link's")
        XCTAssertTrue(upload.contains("@State private var copiedCommand: String?"))
        // Both acknowledgements are dropped when the next upload starts.
        XCTAssertTrue(upload.contains("copiedLink = nil\n                copiedCommand = nil"),
                      "a later result inherits this one's copy acknowledgement")

        // The two things the reader cannot see, and the documentation link.
        XCTAssertTrue(terminal.contains("InlineMessage(.warning, L10n.t(.storedSendCliWarning))"),
                      "nothing states why the quotes matter or that shells keep a history")
        XCTAssertTrue(terminal.contains("Link(L10n.t(.storedSendCliDocs), "
                                        + "destination: AppEnvironment.cliWebURL)"))
    }

    private func occurrences(of needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    /// Whitespace runs collapsed to one space, so a phrase can be asserted
    /// against a document whose line wrapping is nobody's contract.
    private func flattened(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    func testShellNeverReadsTheSession() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        for s in ["session.state", "AccountSession", "SessionState", "bearerToken",
                  "AccountManagementModel", "AccountScope"] {
            XCTAssertFalse(shell.contains(s), "the shell must not know about the account: \(s)")
        }
    }

    // MARK: - leaving the account outlives the screen that asked to

    /// **No view owns the self-revoke hand-off.**
    ///
    /// Revoking the current device cascades this app's own bearer server-side,
    /// and the app used to notice by way of a `.task(id: management.needsSignOut)`
    /// on this view. That is a view's lifetime, and on macOS a view's lifetime is
    /// shorter than the operation in two ordinary ways: selecting another
    /// sidebar destination replaces `AccountView`, and closing the unique window
    /// takes the whole split view down while the process keeps running behind
    /// the `MenuBarExtra`. Either one lands the response with nobody to consume
    /// it, and the app goes on treating a revoked bearer as live until somebody
    /// navigates back to Account.
    ///
    /// This view may still START a revoke. It may not be what notices one
    /// succeeded, so it names none of the machinery.
    func testNoViewOwnsTheSelfRevokeHandOff() throws {
        let account = try source(named: "AccountView.swift")
        for viewScoped in ["needsSignOut", "acknowledgeSignOut", "consumeSelfRevoke",
                           "session.logOut()"] {
            XCTAssertFalse(account.contains(viewScoped),
                           "AccountView owns \(viewScoped) again — leaving this destination "
                           + "would strand a revoked credential")
        }
        // One `.task(id:)` survives on this view, and it is the scope-keyed load.
        XCTAssertEqual(occurrences(of: ".task(id:", in: account), 1,
                       "the only task on this view is the scope-keyed load")
        XCTAssertTrue(account.contains(".task(id: scope)"))
    }

    /// The observer is app-scoped and subscribes before any view exists — which
    /// on macOS also means before any WINDOW exists, and that is the point:
    /// `applicationShouldTerminateAfterLastWindowClosed` is false here, so the
    /// process outlives its window and a window-scoped observer would be absent
    /// for exactly the interval this defect occupies.
    func testTheSelfRevokeObserverIsAppScopedAndStartedBeforeAnyView() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("@StateObject private var signOut: AccountSignOutCoordinator"),
                      "the observer belongs to the App, not to a window or a view")
        XCTAssertTrue(app.contains(".observe(management.$needsSignOut)"),
                      "it has to be subscribed to the signal")
        XCTAssertTrue(app.contains(".environmentObject(signOut)"))
        guard let initRange = app.range(of: "init() {"),
              let body = app.range(of: "var body: some Scene"),
              let observe = app.range(of: ".observe(management.$needsSignOut)") else {
            return XCTFail("RelayiumApp no longer has the shape this checks")
        }
        XCTAssertTrue(initRange.upperBound < observe.lowerBound
                      && observe.upperBound < body.lowerBound,
                      "the subscription must be made in init, before any scene is built")
        XCTAssertEqual(occurrences(of: "AccountSignOutCoordinator(", in: app), 1,
                       "a second coordinator would be a second logout path")
        for (name, text) in try sources(under: macRoot, atLeast: 20)
        where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("$needsSignOut"), "\(name) starts a second observer")
        }
    }

    /// While the revocation is running the window is blocked and says so.
    ///
    /// By then the bearer is either already dead (a self-revoke) or being killed
    /// (an explicit sign-out), so an upload started from another destination
    /// would be spent against a credential that is going away. Blocked AND
    /// labelled: a split view that stops responding with no explanation reads as
    /// the app having hung, and a bare `ProgressView()` reads as nothing at all
    /// to VoiceOver.
    ///
    /// It is a transient operation, not an account gate — it goes up when a
    /// revocation starts and comes down when it ends, so the shell still renders
    /// unconditionally and every signed-out capability keeps its structure.
    func testTheShellBlocksAndLabelsWindowActionsWhileTheLogoutFinishes() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        XCTAssertTrue(shell.contains("@EnvironmentObject private var signOut: AccountSignOutCoordinator"))
        XCTAssertTrue(shell.contains(".disabled(signOut.isSigningOut)"),
                      "a destination must not act with a credential the server is revoking")
        XCTAssertTrue(shell.contains("ProgressView { Text(L10n.t(.accountSigningOut)) }"),
                      "the block has to say what it is waiting for")
        // The split view still renders unconditionally: the block is a modifier
        // on it, never a branch around it.
        XCTAssertFalse(shell.contains("if signOut.isSigningOut {\n            NavigationSplitView"),
                       "the shell must not swap its structure for a sign-out")
    }

    /// The explicit Sign out button goes through the same coordinator, so "one
    /// revocation at a time" is enforceable rather than hoped for.
    func testTheExplicitSignOutGoesThroughTheOneCoordinator() throws {
        let account = try source(named: "AccountView.swift")
        XCTAssertTrue(account.contains(
            "@EnvironmentObject private var signOut: AccountSignOutCoordinator"))
        XCTAssertTrue(account.contains("signOut.signOut(scope: scope)"),
                      "the button must hand the SCOPED sign-out to the coordinator")
        XCTAssertEqual(occurrences(of: "signOut.signOut(", in: account), 1,
                       "a second call site would be one that skipped the serialization")
        let direct = try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains("session.logOut()") }.map(\.name).sorted()
        XCTAssertEqual(direct, ["Destinations/AccountDestination.swift"],
                       "a signed-in surface signs out around the coordinator")
    }

    /// A Refresh already in flight must not put the rows and reconstructed links
    /// back after a sign-out cleared them.
    ///
    /// `AccountSession.logOut()` deliberately keeps `.ready` on screen until its
    /// revocation finishes, so a superseded Refresh returns to a still-ready
    /// account and `AccountRefreshDecision` would legitimately choose `.reload` —
    /// recreating every `#k=` link for the length of the sign-out timeout. The
    /// gate reads the coordinator rather than view state, so it survives this
    /// destination being replaced and reselected mid-sign-out.
    func testLeavingTheAccountPreventsAnOlderRefreshFromRehydratingItsRows() throws {
        let account = try source(named: "AccountView.swift")
        guard let refreshStart = account.range(of: "private func refresh() {") else {
            return XCTFail("AccountView no longer has one refresh seam")
        }
        let refresh = account[refreshStart.lowerBound...]
        guard let sessionRefresh = refresh.range(of: "await session.refresh()"),
              let leaveGuard = refresh.range(of: "guard !signOut.isSigningOut else {") else {
            return XCTFail("refresh no longer refuses to reload an account being left")
        }
        XCTAssertTrue(sessionRefresh.upperBound < leaveGuard.lowerBound,
                      "the leave signal must be checked when the suspended refresh returns")
        XCTAssertTrue(refresh[leaveGuard.lowerBound...].contains("management.clear(scope: previous)"),
                      "a late refresh must leave the old scope deactivated")
    }

    func testNoMacOS14APIAndOnlyHelpMayCollapse() throws {
        let banned = ["ContentUnavailableView", "onChange(of:initial:)",
                      "@Observable", ".symbolEffect", ".containerRelativeFrame", ".inspector"]
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            for s in banned { XCTAssertFalse(text.contains(s), "\(name) contains \(s)") }
        }
        // **`DisclosureGroup` is banned outright again, including in help.**
        //
        // It was banned because the root view once hid every signed-out
        // CAPABILITY inside two collapsed groups and nobody found them. Help
        // held the one exception, on the argument that hiding the third
        // paragraph about a feature is not hiding the feature — which was true,
        // and left the app's quietest reader aiming at its smallest target. A
        // `Button` collapses the same paragraph with an affordance the control
        // never had, so the exception has nothing left to buy.
        let collapsers = try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains("DisclosureGroup") }.map(\.name).sorted()
        XCTAssertEqual(collapsers, [],
                       "a macOS surface hides something behind a bare disclosure triangle")
    }

    func testExactlyOneFileCarriesAFixedFontSize() throws {
        XCTAssertEqual(try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains(".system(size:") }.map(\.name),
                       ["Components/SecurityCodeText.swift"])
    }

    /// **The one string in the app a person reads across a room now follows
    /// their text size — and still cannot wrap.**
    ///
    /// The pairing code and the SAS were 34 and 26 points flat, so raising the
    /// system text size grew every label around the code and left the code
    /// itself alone. `@ScaledMetric` keeps the ratio and the monospaced grid
    /// while tracking the setting.
    ///
    /// The negative half is the safety one. These are transcribed by hand onto
    /// another device: a code broken across two lines, or scaled down to fit its
    /// container, is a code somebody copies wrongly. `lineLimit(1)` plus a
    /// HORIZONTAL `fixedSize` is what lays it out at its full width whatever the
    /// container offers, and `minimumScaleFactor` is the modifier that would
    /// quietly undo it.
    func testTheTranscribedCodesScaleAndStillCannotWrapOrShrink() throws {
        let code = try source(named: "Components/SecurityCodeText.swift")
        XCTAssertTrue(code.contains("@ScaledMetric(relativeTo: .largeTitle) private var pairingSize"),
                      "the pairing code ignores the user's text size")
        XCTAssertTrue(code.contains("@ScaledMetric(relativeTo: .title) private var verificationSize"),
                      "the verification phrase ignores the user's text size")
        XCTAssertTrue(code.contains(".font(.system(size: scaledSize, weight: .semibold, design: .monospaced))"),
                      "the rendered size is not the scaled one")
        XCTAssertTrue(code.contains(".lineLimit(1)"),
                      "a transcribed code may not wrap")
        XCTAssertTrue(code.contains(".fixedSize(horizontal: true, vertical: false)"),
                      "a container can still compress the code it is offered")
        XCTAssertFalse(code.contains("minimumScaleFactor"),
                       "a shrunk code is a mis-transcribed code")
        // And no second copy of the two bases, which is how the scaled and
        // unscaled sizes would drift apart.
        XCTAssertFalse(code.contains("case .pairing: return 34"),
                       "the unscaled sizes exist twice")
    }

    func testTheDisplayedCodeIsSelectableAndSpokenAsDigits() throws {
        let code = try source(named: "Components/SecurityCodeText.swift")
        XCTAssertTrue(code.contains("design: .monospaced"))
        XCTAssertTrue(code.contains(".textSelection(.enabled)"))
        XCTAssertEqual(code.components(separatedBy: ".accessibilityElement(children: .ignore)").count - 1, 2,
                       "selectable AppKit text must collapse into one labelled automation element")
        XCTAssertTrue(code.contains(".accessibilityLabel(spokenCode)"))
        XCTAssertTrue(code.contains("joined(separator: \" \")"),
                      "VoiceOver must read pairing-code digits one at a time")
        XCTAssertTrue(code.contains("L10n.token(code)"),
                      "the displayed code must stay isolated in RTL copy")
        XCTAssertEqual(code.components(separatedBy: "pairing-code-value").count - 1, 1)
        XCTAssertEqual(code.components(separatedBy: "verification-code-value").count - 1, 1)
        XCTAssertFalse(try source(named: "Transfer/TransferLinkPane.swift")
            .contains("link-sas"),
                       "a caller wrapper split the verification identifier from its label")
    }

    /// The acceptance substitution mirrors the product's TWO link owners.
    ///
    /// A single acceptance model registered for both rooms would quietly restore
    /// the shared graph the product no longer has — and it would do it only in
    /// the build the suite runs against, which is the worst place for a
    /// composition difference to live.
    func testUITestPairingRoomsUseTheOfflineLinkFixture() throws {
        let mode = try source(named: "UITestMode.swift")
        XCTAssertTrue(mode.contains("static func makeNearbyLinkWorkspaceModel")
                      && mode.contains("static func makeDirectLinkWorkspaceModel"),
                      "acceptance composes one link owner for two rooms")
        XCTAssertFalse(mode.contains("static func makeLinkWorkspaceModel("),
                       "the shared acceptance link fixture survived the module split")
        for fixture in ["makeNearbyLinkWorkspaceModel", "makeDirectLinkWorkspaceModel"] {
            XCTAssertTrue(try declaration(of: fixture, in: mode)
                .contains("iceClient: UITestWaitingICEClient()"),
                          "\(fixture) still reaches the production ICE client")
        }
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("UITestMode.makeNearbyLinkWorkspaceModel(")
                      && app.contains("UITestMode.makeDirectLinkWorkspaceModel("),
                      "UI acceptance still reaches the production pairing ICE client")
    }

    /// **The offline fixtures apply to the OFFLINE launch, and to no other.**
    ///
    /// This is the guard for a defect that cost a whole acceptance round. The
    /// three transfer substitutions were selected on `UITestMode.isActive`, which
    /// is true for the loopback built-App run as well — so that run was handed a
    /// pairing socket factory that is a `preconditionFailure` and an ICE client
    /// that sleeps for five minutes. `LinkWorkspaceModel.watchPairingCode` reads
    /// ICE before it opens the room, so the app published `.watching` and never
    /// opened a socket at all. Two native ends then waited for each other for the
    /// full budget, and the measurement — "neither side promotes" — was written up
    /// as a defect in the pairing wire rather than in the harness.
    ///
    /// So the predicate is asserted here by name. `usesOfflineTransfer` is the
    /// exact complement of `allowsResidency`: an acceptance launch that resolved a
    /// loopback origin composes `AppEnvironment`'s real models, and every launch
    /// that did not keeps the fixtures it always had.
    func testTheOfflineTransferFixturesNeverReachALoopbackAcceptanceLaunch() throws {
        let mode = try source(named: "UITestMode.swift")
        XCTAssertTrue(mode.contains("static let usesOfflineTransfer = isActive && !allowsResidency"),
                      "the offline fixtures are not scoped to the offline launch")
        let app = try source(named: "RelayiumApp.swift")
        // Every substitution that would otherwise silently replace the real
        // transfer graph in a built-App run.
        for substitution in ["let nearbyText = UITestMode.usesOfflineTransfer",
                             "let directText = UITestMode.usesOfflineTransfer",
                             "let nearbyLink = UITestMode.usesOfflineTransfer",
                             "let directLink = UITestMode.usesOfflineTransfer"] {
            XCTAssertTrue(app.contains(substitution),
                          "a transfer model is substituted for every acceptance launch, "
                          + "including the loopback one: \(substitution)")
        }
        // And none of them is selected on `isActive` any more, which is the exact
        // edit that reintroduces the defect.
        for restored in ["let nearbyText = UITestMode.isActive",
                         "let directText = UITestMode.isActive",
                         "let nearbyLink = UITestMode.isActive",
                         "let directLink = UITestMode.isActive"] {
            XCTAssertFalse(app.contains(restored),
                           "a transfer model went back to substituting on isActive: \(restored)")
        }
        // The per-fixture flags keep their OWN guards — they are only ever passed
        // by the offline suite, and folding them into the predicate above would
        // make a loopback launch unable to drive a deterministic terminal state.
        XCTAssertTrue(mode.contains("guard showsGeneratedFileCode else { return nil }")
                      && mode.contains("guard showsTerminalNearby else { return nil }"),
                      "a per-fixture launch flag lost its own guard")
    }

    /// One destination file per `MacSurface` — six, because the hidden one still
    /// has a screen — and every retired surface gone rather than merely
    /// unreferenced.
    ///
    /// The absence half is the load-bearing one. A revert that left
    /// `WorkspaceDestination.swift` on disk would compile — the project group is
    /// filesystem-synchronized — and would put the merged row back the moment
    /// anybody added a `row(.workspace,` line, with no diff against this file to
    /// explain it.
    func testEverySurfaceHasItsDestinationFileAndNoRetiredOneSurvives() {
        for surface in MacSurface.allCases {
            let name = surface.rawValue.prefix(1).uppercased() + surface.rawValue.dropFirst()
            XCTAssertTrue(FileManager.default.fileExists(
                atPath: macRoot.appendingPathComponent("Destinations/\(name)Destination.swift").path),
                          "no destination file for \(surface.rawValue)")
        }
        for retired in retiredSurfaces {
            XCTAssertFalse(FileManager.default.fileExists(
                atPath: macRoot.appendingPathComponent(retired).path),
                           "\(retired) survived the Workspace merge")
        }
    }

    /// **Every destination has a sidebar row, and every sidebar row a destination.**
    ///
    /// The two lists are written in two files — the shell's `switch` and the
    /// sidebar's `row(_:)` calls — and the failure mode is silent in both
    /// directions: a case the sidebar never names is a screen with no way in
    /// (which is the entire reason the Device Inbox needed this round), and a row
    /// with no arm is a compile error only because the `switch` has no `default`.
    /// Checked against `AppDestination.allCases` so neither list can be the one
    /// that is right.
    /// Checked against `MacSurface.browseable` for the rows and
    /// `MacSurface.allCases` for the arms, and the difference between those two
    /// lists IS this batch: every surface must be renderable, and exactly one of
    /// them — Open a link — must not be browseable.
    ///
    /// The count assertion is what makes the inventory stick. A sixth row, under
    /// any name, fails here rather than shipping.
    func testEveryDestinationIsBothASidebarRowAndAShellArm() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        let shell = try source(named: "Shell/AppShellView.swift")
        for surface in MacSurface.allCases {
            XCTAssertTrue(shell.contains("case .\(surface.rawValue):"),
                          "the shell renders nothing for \(surface.rawValue)")
            let hasRow = sidebar.contains("row(.\(surface.rawValue),")
            XCTAssertEqual(hasRow, surface.isBrowseable,
                           "\(surface.rawValue) has a sidebar row it should not, or lacks one")
        }
        XCTAssertEqual(occurrences(of: "row(.", in: sidebar), MacSurface.browseable.count,
                       "the sidebar renders a row for something it should not offer")
        XCTAssertEqual(MacSurface.browseable.count, 5)
        XCTAssertEqual(MacSurface.allCases.count, 6)
        XCTAssertFalse(sidebar.contains("row(.storedReceive,"),
                       "Open a link is an ordinary sidebar row again")
        // Every destination reaches a surface, and no two share one. Derived
        // from the enum rather than restated, so a seventh destination cannot be
        // added without answering the question.
        XCTAssertEqual(Set(AppDestination.allCases.map(\.macSurface)),
                       Set(MacSurface.allCases),
                       "a macOS surface exists that no destination can reach")
        XCTAssertEqual(Set(AppDestination.allCases.map(\.macSurface)).count,
                       AppDestination.allCases.count,
                       "two destinations were merged into one macOS screen")
        for surface in MacSurface.allCases {
            XCTAssertEqual(surface.route.macSurface, surface,
                           "\(surface.rawValue)'s row selects a route that draws something else")
        }
        // The shell must switch on the SURFACE. Switching on the destination
        // again is how a pairing-code deep link gets its own screen back.
        XCTAssertTrue(shell.contains("switch navigation.selection.macSurface {"))
        XCTAssertTrue(shell.contains(
            ".accessibilityIdentifier(\"destination-\\(navigation.selection.macSurface.rawValue)\")"),
            "the detail surface's runtime identity must name the one screen it is")
    }

    /// The section heading the query guard below scopes itself by. The rest of
    /// `AppShellUITests` still carries the legacy `.any` descendant queries this
    /// batch did not touch, so that guard reads from this heading to the end of
    /// the file rather than the file as a whole.
    private static let macAuditSectionMark = "// MARK: - what VoiceOver would meet"

    /// **The macOS accessibility gate audits everything, and buys its green with
    /// evidence rather than with a smaller audit.**
    ///
    /// This is the guard that makes the discipline in `WORK-QUEUE.md` Q9
    /// enforceable from a suite that runs everywhere, because the audit itself
    /// only runs where UI automation is authorized. The failure it exists to
    /// prevent is the cheap one: an audit type quietly subtracted, or an
    /// exclusion widened until it covers the product's own elements, either of
    /// which leaves a green gate that checks nothing.
    ///
    ///  - the audited set is `.all.subtracting(.contrast)`, the same rule the
    ///    iOS half states, and `contrast` is the ONLY subtraction anywhere in the
    ///    suite. Written as a subtraction rather than a list so it keeps covering
    ///    whatever Apple adds next;
    ///  - the exclusions name the framework containers the 2026-08-15 probe and
    ///    the owner's 2026-08-16 audit run matched — AppKit's menu bar, the
    ///    `Group`/`SplitGroup` wrappers around a whole window half, the wrapper
    ///    `List` draws around a group heading, its 14-wide disclosure control, and
    ///    the Touch Bar the product never declares — and nothing else. Each is
    ///    bounded to the shape its evidence describes, and the wrapper rule is
    ///    bounded to a heading this gate has already proved has words;
    ///  - the product's own group headings are asserted to HAVE a description
    ///    before the audit runs. That ordering is what makes the report decisive:
    ///    a finding still landing on a heading's row afterwards cannot be the
    ///    heading, so it is the framework's wrapper by elimination rather than by
    ///    a second reading of the pixels.
    ///  - and it addresses elements through typed collections. The `.any`
    ///    window-wide descendant query is the shape that times out on macOS, and
    ///    the audit is the one test in that suite nobody can smoke-test on this
    ///    workstation, so the timeout would land on the owner's single run.
    func testTheMacAccessibilityAuditDropsNoCheckToGoGreen() throws {
        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)

        XCTAssertTrue(ui.contains("func testEveryDestinationPassesTheSystemAccessibilityAudit()"),
                      "macOS has no system accessibility gate")
        XCTAssertTrue(ui.contains("XCUIAccessibilityAuditType.all.subtracting(.contrast)"),
                      "the macOS gate no longer audits everything except the measured "
                      + "contrast exception")
        XCTAssertEqual(occurrences(of: ".subtracting(", in: ui), 1,
                       "a second audit type was subtracted; a framework-owned finding is "
                       + "excluded by name with its evidence, never by dropping a check")
        for dropped in [".elementDetection", ".sufficientElementDescription",
                        ".hitRegion", ".parentChild", ".action"] {
            XCTAssertFalse(ui.contains(dropped),
                           "the macOS gate names \(dropped), which it only ever would to "
                           + "narrow what it audits")
        }
        XCTAssertFalse(ui.contains("XCUIAccessibilityAuditType(["),
                       "the audited set is a literal list again, which is how the two "
                       + "platforms' rules fork and how a check goes missing without a "
                       + "reason being written down")
        // The exclusions, by the two kinds the probe matched and no more. A
        // `statusItem` is product code — the resident menu-bar extra — and an
        // unlabelled one is a real defect, so the menu-bar rule must stay on
        // AppKit's own menu types.
        XCTAssertTrue(ui.contains("element.elementType == .menuBar")
                      && ui.contains("[XCUIElement.ElementType.group, .splitGroup]"),
                      "the framework-owned exclusion no longer names the containers the "
                      + "2026-08-15 probe actually matched")
        XCTAssertFalse(ui.contains("== .statusItem"),
                       "the exclusion reaches the product's own menu-bar extra")
        XCTAssertTrue(ui.contains("element.frame.height >= window.height / 2"),
                      "the exclusion is no longer bounded to containers that wrap a whole "
                      + "window half, so it can swallow an element the product draws")
        // **The three the owner's 2026-08-16 run added, each bounded to something
        // the product does not draw.** The exclusion list is where a gate goes
        // quietly green, so every rule in it is pinned to the shape its evidence
        // describes rather than to its kind alone.
        XCTAssertTrue(ui.contains("element.elementType == .touchBar"),
                      "the Touch Bar the product never declares is no longer excluded by "
                      + "name, or is excluded by something broader than its own type")
        // The shape the first correction shipped, asserted GONE. `<= 16` on both
        // sides is an upper bound with nothing underneath it, so every unnamed
        // group smaller than a disclosure triangle left the audit with it. What
        // replaces it is checked from both sides further down, once the section
        // has been stripped of its comments.
        XCTAssertFalse(ui.contains("element.frame.width <= 16"),
                       "the disclosure control is excluded by an upper bound alone again, "
                       + "which admits every smaller unnamed group with it")
        XCTAssertTrue(ui.contains("element.identifier.isEmpty")
                      && ui.contains("element.label.isEmpty"),
                      "the last exclusions no longer require an unnamed, unlabelled "
                      + "container, so they can dispose of an element the product annotates")
        // **The wrapper exclusion is licensed by the headings, and that is what
        // stops it becoming the quiet way to pass an empty one.** It may only
        // retire a container that ENCLOSES a heading this run has already proved
        // is identified and has words; a heading that lost its label leaves
        // `headers`, and the wrapper around it is reported in the same run.
        XCTAssertTrue(ui.contains("around headers: [String: CGRect]")
                      && ui.contains("headers.first(where: { encloses(element.frame, $0.value) })"),
                      "the List header wrapper is excluded without being tied to a heading "
                      + "the product identifies and labels, which is an exclusion by "
                      + "geometry alone")
        // Read BEFORE the audit, which is what makes a later finding on that
        // geometry attributable — and reported rather than asserted on the spot,
        // so one run of a suite that stops at its first failure answers both
        // halves of the question instead of the first half twice.
        guard let labelled = ui.range(of: "guard !Self.words(of: header).isEmpty else {"),
              let recorded = ui.range(of: "headers[id] = header.frame") else {
            return XCTFail("the gate audits the shell without first proving the product's "
                           + "own group headings have anything to read")
        }
        XCTAssertTrue(labelled.upperBound < recorded.lowerBound,
                      "a heading enters `headers` before it is proved to have words, so an "
                      + "empty heading would license the exclusion of the wrapper around it")
        // And "has words" means what VoiceOver would read, not one of the two
        // places macOS puts it. The 2026-08-15 probe found five identified
        // sidebar rows whose words were in `value` with `label` empty; a heading
        // read only through `label` would be reported as an empty heading on the
        // strength of which attribute the framework chose.
        XCTAssertTrue(ui.contains("element.label.isEmpty ? (element.value as? String ?? \"\") "
                                  + ": element.label"),
                      "the gate proves a heading has words through one attribute only, so the "
                      + "half of the tree that carries its words in `value` reads as empty")
        XCTAssertTrue(ui.contains("XCTAssertTrue(problems.isEmpty && found.isEmpty,"),
                      "a heading with nothing to read would no longer fail the gate")
        // **The query shape, which nothing else in this workspace can catch.**
        //
        // `window.descendants(matching: .any)[…]` asks for every descendant of
        // the window and then filters; it is what times out on macOS, and
        // batches 94, 102 and 115 each spent a round trip on it before
        // `WORKFLOW-LEARNINGS.md` (2026-08-15) recorded the rule. The rest of
        // this suite still carries the legacy uses, which run in the owner's own
        // terminal and are not this batch's scope — so the guard is scoped to
        // the audit section instead of to the file, and it is that section that
        // may never reintroduce the shape. It matters more here than anywhere
        // else in the file: this is the one test no one can smoke-test on this
        // workstation, so a timeout in it costs the owner the whole run.
        guard let mark = ui.range(of: Self.macAuditSectionMark) else {
            return XCTFail("the macOS audit section lost the heading the query guard "
                           + "scopes itself by, so nothing checks its queries any more")
        }
        // Comment lines are dropped first. That section names the forbidden
        // shape on purpose — it is where the reason lives — and a guard that
        // cannot tell a rule from its explanation is one people satisfy by
        // deleting the explanation.
        let audit = String(ui[mark.lowerBound...])
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        XCTAssertTrue(audit.contains("func testEveryDestinationPassesTheSystemAccessibilityAudit()"),
                      "the macOS audit no longer sits under its own section heading, so the "
                      + "guard below is reading some other code")
        XCTAssertFalse(audit.contains("descendants(matching: .any)"),
                       "the macOS accessibility gate addresses an element through a "
                       + "window-wide `.any` descendant query — the shape recorded as timing "
                       + "out on macOS, in the one test that cannot be smoke-tested here")
        // Four typed collections, not two. The 2026-08-16 run spent itself
        // discovering that the heading was in neither of the two the gate then
        // asked, so the set now covers every role a heading can hold on this
        // platform and the failure names which one answered. Each remains an
        // identifier lookup against an already-typed query — the cost the `.any`
        // rule above exists to avoid is the untyped scan, not the count.
        for collection in ["window.staticTexts", "window.otherElements",
                           "window.groups", "window.cells"] {
            XCTAssertTrue(audit.contains(collection),
                          "the gate no longer asks \(collection), one of the typed "
                          + "collections a heading can land in, so a run can answer which "
                          + "query was wrong instead of what VoiceOver would meet")
        }
        XCTAssertTrue(audit.contains("collections.map(\\.name).joined(separator: \", \")"),
                      "a heading found in none of the collections no longer reports which "
                      + "ones were asked, which is the fact the next run would need")
        // **The two assumptions the owner's 2026-08-16 run disproved, asserted
        // gone.** That run reported `sidebar-sectionDirect` present in
        // `staticTexts` and then reported all three headings — that one included
        // — as nowhere in it, and left the proven 19-point wrappers attributed to
        // no identified heading. Both halves of that contradiction are now
        // guarded, because both are cheap to reintroduce and each costs a whole
        // owner-run to discover again.
        //
        // First: one heading's collection is not the other two's. The heading
        // trait can promote one heading to `AXHeading` without promoting its
        // siblings, so nothing entitles a run to resolve a collection once and
        // then read every identifier out of it.
        XCTAssertFalse(audit.contains("collections.first(where:")
                       || audit.contains("Self.sectionHeaderIDs[0]"),
                       "the gate resolves one collection from one heading and reads the rest "
                       + "out of it again — the shared-collection assumption the 2026-08-16 "
                       + "run disproved, which reports every heading missing the moment two "
                       + "of them hold different roles")
        XCTAssertTrue(audit.contains("for id in Self.sectionHeaderIDs {")
                      && audit.contains("Self.resolveHeading(id, across: collections, "
                                        + "until: deadline)"),
                      "the three headings are no longer resolved independently, each across "
                      + "every typed collection")
        XCTAssertTrue(audit.contains("for collection in collections {"),
                      "the per-heading resolver no longer sweeps the whole collection list, "
                      + "so a heading can be reported missing from a query never asked")
        // Second: a query that has already answered may not be asked again.
        // `.firstMatch` on a resolved subscript builds a second element against a
        // narrower snapshot, and it answered `false` for the exact identifier
        // that had just answered `true`.
        //
        // The token is banned outright in this section rather than only on a
        // resolved element: a source guard cannot tell `element.firstMatch` from
        // the legitimate `query.firstMatch`, and this section has no use for
        // either — every element here comes from an identifier subscript. The
        // rest of the suite keeps its own uses; the guard is scoped to the audit.
        XCTAssertFalse(audit.contains(".firstMatch"),
                       "the audit re-asks an element that already resolved by appending "
                       + "`.firstMatch` — the contradictory second lookup that lost every "
                       + "confirmed heading on 2026-08-16")
        XCTAssertTrue(audit.contains("let header = hit.element"),
                      "the element the collection returned is no longer the element read, so "
                      + "the frame, the type and the words can come from a different lookup "
                      + "than the one that proved the heading exists")
        // And the wait stays bounded and stays a query. A `sleep` would make the
        // cost unconditional; an unbounded retry would spend the owner's run on
        // the sidebar rather than on the audit.
        XCTAssertTrue(audit.contains("private static let headingResolutionBudget: TimeInterval")
                      && audit.contains("until deadline: Date"),
                      "the heading resolution lost its bounded budget, so a sidebar that never "
                      + "renders costs the owner's run instead of failing it")
        for stall in ["Thread.sleep", "usleep(", "sleep("] {
            XCTAssertFalse(audit.contains(stall),
                           "the audit waits by \(stall) rather than by re-querying, which "
                           + "spends the time whether or not the tree has settled")
        }
        // The report has to name where each heading was found, per heading. That
        // is the fact the 2026-08-16 run could not produce and the reason it
        // could not be diagnosed without a second run.
        XCTAssertTrue(audit.contains("\\(hit.name)/\\(Self.name(for: header.elementType))"),
                      "a resolved heading no longer reports the collection and the element "
                      + "type it was found as, so a failure cannot say which query answered")
        XCTAssertTrue(audit.contains("NSPredicate(format: \"title == %@\""),
                      "the gate waits for a destination through the accessibility tree again "
                      + "rather than on the window title its scaffold sets")
        // **Every excluded container is matched from BOTH sides of its measured
        // geometry.** Read from the comment-stripped section on purpose: this is
        // the block that decides what leaves the audit, so it may not be
        // satisfied by prose describing a bound the code no longer applies.
        //
        // The failure being prevented is one an upper bound cannot: a rule
        // written for one measured framework container quietly becoming a rule
        // about size, which covers whatever the product authors next in that
        // range. Enclosing a proven heading is a property a container of any
        // size has — a future product-authored group holding a heading and its
        // rows encloses exactly the same heading — so the wrapper rule carries
        // the 19-point row height as well, and the disclosure rule carries a
        // bounded width and a bounded height rather than a bare ceiling.
        //
        // The disclosure height is the one length two supported runtimes read
        // differently: 14 on the owner's Xcode 17 / macOS 26, 16 on GitHub's
        // Xcode 16.4 / macOS 15.5, both at the same 14-point width and both
        // reported on all five destinations. So the height is pinned as a span
        // whose two endpoints are those two observations and the width stays a
        // single measurement. Every one of those four numbers is asserted
        // literally below, which is what makes both directions of mutation red:
        // widening an endpoint, and dropping one so the span collapses back to
        // a value one of the two runtimes contradicts.
        //
        // Sizes, not positions: nothing here reads the `(778,360,…)` origins the
        // frames were measured at, and the wrapper's 208-point width is left
        // free because that one is the sidebar's current width and moves when
        // the split is dragged. Resize independence is kept where the evidence
        // supports it and spent only where the shape is genuinely fixed.
        XCTAssertTrue(audit.contains("private static let headingRowHeight: CGFloat = 19"),
                      "the List header wrapper's measured 19-point row height is gone, so "
                      + "the wrapper rule is back to matching a container of any size")
        XCTAssertTrue(audit.contains("private static let disclosureWidth: CGFloat = 14"),
                      "the disclosure control's measured 14-point width is gone, or is no "
                      + "longer a single measurement — both runtimes read this one the same, "
                      + "so nothing entitles it to a span")
        XCTAssertTrue(audit.contains("private static let disclosureHeightLow: CGFloat = 14"),
                      "the disclosure height's lower endpoint is not the 14 points the "
                      + "owner's Xcode 17 / macOS 26 run measured; lower it and unnamed "
                      + "groups smaller than a disclosure triangle leave the audit with it, "
                      + "raise it and that run's own reading stops being accepted")
        XCTAssertTrue(audit.contains("private static let disclosureHeightHigh: CGFloat = 16"),
                      "the disclosure height's upper endpoint is not the 16 points GitHub's "
                      + "Xcode 16.4 / macOS 15.5 run measured; raise it and the span covers "
                      + "heights nothing has ever observed, lower it and CI's own reading "
                      + "stops being accepted")
        XCTAssertTrue(audit.contains("private static let geometrySlack: CGFloat = 1"),
                      "the rounding slack is no longer one point; widen it and both "
                      + "measured bounds stop being bounds")
        // The lower bound and the upper bound, named separately, because each is
        // its own reverse mutation and deleting either leaves a rule that reads
        // as measured while matching an open range.
        XCTAssertTrue(audit.contains("value >= measured - geometrySlack"),
                      "the measured-geometry match lost its lower bound, so every smaller "
                      + "unnamed container is excluded along with the one that was measured")
        XCTAssertTrue(audit.contains("value <= measured + geometrySlack"),
                      "the measured-geometry match lost its upper bound, so every larger "
                      + "unnamed container is excluded along with the one that was measured")
        // The two-reading span carries the identical pair. A span is the shape
        // that most easily decays into an open range, so it gets the same two
        // assertions rather than being trusted because it has a name.
        XCTAssertTrue(audit.contains("value >= low - geometrySlack"),
                      "the two-reading span lost its lower bound, so every unnamed container "
                      + "shorter than the smaller of the two observations leaves the audit "
                      + "with the disclosure control")
        XCTAssertTrue(audit.contains("value <= high + geometrySlack"),
                      "the two-reading span lost its upper bound, so it reaches the 19-point "
                      + "heading rows and every unnamed container above them")
        // And each rule is bound to the geometry its own evidence measured.
        XCTAssertTrue(audit.contains("measures(element.frame.height, Self.headingRowHeight)"),
                      "the List header wrapper is excluded on enclosure alone again — a "
                      + "property any enclosing container has, including a product-authored "
                      + "group holding a heading and its rows")
        XCTAssertTrue(audit.contains("measures(element.frame.width, Self.disclosureWidth)"),
                      "the disclosure control's width is no longer matched against the single "
                      + "measurement both runtimes agreed on, so the rule is free in the one "
                      + "dimension that never varied")
        XCTAssertTrue(audit.contains("measures(element.frame.height,")
                      && audit.contains("from: Self.disclosureHeightLow,")
                      && audit.contains("through: Self.disclosureHeightHigh)"),
                      "the disclosure control's height is no longer matched against both "
                      + "endpoints of the two runtime readings, so the rule is about one "
                      + "runtime's shape and either rejects the other or is free in that "
                      + "dimension")
        // And the span stays where its evidence is. A second call site would be
        // a single measurement quietly turned into a band by reusing the name.
        XCTAssertEqual(occurrences(of: "through: Self.", in: audit), 1,
                       "a second geometry is matched as a span; only the disclosure height "
                       + "has two runtime readings behind it, and every other length in this "
                       + "section was measured once")
        XCTAssertFalse(audit.contains("Self.disclosureSide"),
                       "the single-side disclosure constant is back, which is the shape that "
                       + "rejected CI's own 14x16 reading of the same framework control")
        XCTAssertFalse(audit.contains("element.frame.origin")
                       || audit.contains("== 778") || audit.contains("== 208"),
                       "an exclusion matches a screen coordinate or the sidebar's current "
                       + "width, so a resized window or a different display turns it into a "
                       + "silent pass")
        // The suite's three ids are the three the sidebar derives from its keys.
        let sidebar = try source(named: "Shell/SidebarView.swift")
        XCTAssertTrue(sidebar.contains("key.rawValue.split(separator: \".\").last"),
                      "the heading identity is no longer derived from the key that supplies "
                      + "its words, so the two can drift")
        for key in ["sectionDirect", "sectionLinks", "sectionDevice"] {
            XCTAssertTrue(ui.contains("\"sidebar-\(key)\""),
                          "the gate does not check the group heading \(key) the sidebar draws")
        }
    }

    /// Constraint 5. `WindowGroup` anywhere means a second window is reachable,
    /// and a second window renders the same live session twice.
    func testNoFileCanCreateASecondWindow() throws {
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            XCTAssertFalse(text.contains("WindowGroup"), "\(name) can open a second window")
        }
    }

    /// A source guard, not a behavioural one: whether the process actually
    /// survives its last window closing is a by-hand row in the acceptance
    /// matrix. What this can prove is that the declaration is present at all.
    func testTheMainSceneIsUniqueAndSurvivesItsWindowClosing() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("Window(\"Relayium\", id: \"main\")"),
                      "the main scene must be the unique Window scene")
        XCTAssertTrue(app.contains("func applicationShouldTerminateAfterLastWindowClosed"),
                      "closing the unique window must not end the process")
        XCTAssertTrue(app.contains("MenuBarExtra"), "residency stays")
    }

    /// The three capabilities that work with no account have to be able to
    /// reach the transport without one, and the surest way to keep that true is
    /// for their surfaces not to hold the account at all. An `AccountGate` is
    /// banned here as well as the session itself: a destination that computes a
    /// gate has a reason to render one, and neither of these has a half that
    /// needs an account.
    func testAnonymousDestinationsHoldNoAccountReference() throws {
        // LAN Transfer joins this list with the split, and that is one of the
        // things the split buys: same-network transfer in both directions needs
        // no account, and now the whole destination that offers it holds no
        // account reference at all. Minting a code — the one direct action that
        // spends an account — moved to the other screen with its gate.
        for name in ["Destinations/StoredReceiveDestination.swift",
                     lanDestination, lanConnect] {
            let text = try source(named: name)
            for symbol in ["AccountSession", "bearerToken", "session.state", "AccountGate"] {
                XCTAssertFalse(text.contains(symbol),
                               "\(name) must not depend on an account: \(symbol)")
            }
        }
    }

    /// **Exactly one account-backed half, on the destination that spends the
    /// account.**
    ///
    /// Cross-network Transfer holds `AccountSession` because minting a pairing
    /// code reserves relay capacity billed to whoever created it. Joining a code
    /// somebody else created reaches the transport with no credential at all, so
    /// the gate must wrap the create controls and nothing else.
    ///
    /// That is checked positionally rather than by presence, because "the file
    /// contains a gate" is true of the correct and the broken version alike. The
    /// gate has to sit above the join controls, and the join controls have to
    /// sit outside it.
    func testTheCrossNetworkScreenGatesOnlyTheHalfThatSpendsAnAccount() throws {
        let connect = try source(named: crossConnect)
        XCTAssertEqual(occurrences(of: "CapabilityGateView(", in: connect), 1,
                       "a second gate on this surface is a second account wall")
        guard let gate = connect.range(of: "CapabilityGateView(gate: gate,"),
              let join = connect.range(of: "private var joinControls: some View") else {
            return XCTFail("the connect pane no longer has the shape this guards")
        }
        XCTAssertLessThan(gate.upperBound, join.lowerBound,
                          "joining somebody else's code must not sit behind the account gate")
        // The gate wraps the create half only — `if case .allowed` selects
        // between the create controls and the gate, and nothing else.
        XCTAssertTrue(connect.contains("if case .allowed = gate {\n                    createControls\n                } else {"),
                      "the account gate no longer selects exactly the create controls")
        // The join field may not consult the account at all.
        guard let start = connect.range(of: "private var joinControls: some View") else {
            return XCTFail("the connect pane lost its join controls")
        }
        // Bounded at the NEXT declaration rather than by a character count. The
        // pane is shorter now that the staging section is gone, so a fixed
        // window runs past the join controls into `createCode`, whose whole job
        // is to re-read the account.
        let after = connect[start.upperBound...]
        let body = after[..<(after.range(of: "\n    private ")?.lowerBound ?? after.endIndex)]
        for symbol in ["gate", "accessNow", "session.state", "bearerToken"] {
            XCTAssertFalse(body.contains(symbol),
                           "the join controls consult the account: \(symbol)")
        }
        // And the LAN screen has no gate at all — there is nothing on it that
        // spends an account.
        XCTAssertFalse(try source(named: lanConnect).contains("CapabilityGateView("),
                       "the same-network screen grew an account wall")
    }

    /// Every terminal surface can be dismissed, and the exit is unreachable
    /// while work is running.
    ///
    /// A terminal state is deliberately NOT `.idle` — a completed transfer's
    /// result, a message transcript and a failure all keep their place on screen
    /// instead of blinking past. Presence is reconciled on "both models are
    /// `.idle`", so a terminal surface with no way out holds the claim for as
    /// long as the user leaves it there. The wiring that closes that is one
    /// visible Button, which is exactly the kind of thing a later refactor drops
    /// without any test noticing.
    ///
    /// Bounded rather than merely present: an exit offered mid-transfer would
    /// abandon a live session on a button whose label promises tidying up, which
    /// is why it is gated on `!modelBusy` and why the mid-transfer Cancel stays
    /// the destructive control inside `RealtimeFileSessionView`.
    func testEveryPairingCodeTerminalSurfaceCarriesExactlyOneDone() throws {
        let pane = try source(named: transferSession)
        guard let exit = pane.range(of: "private var exit: some View"),
              let gated = pane.range(of: "if hasRetainedSession && !modelBusy {",
                                     range: exit.lowerBound..<pane.endIndex),
              let button = pane.range(of: "Button(L10n.t(.workspaceLeaveSession)) { leaveOrConfirm() }",
                                      range: gated.lowerBound..<pane.endIndex) else {
            return XCTFail("the session pane no longer has one gated exit")
        }
        XCTAssertLessThan(gated.upperBound, button.lowerBound)
        // The session pane offers no Done of its own: the only Done left belongs
        // to a COMPLETED file transfer, and it is the shared session view's.
        XCTAssertFalse(pane.contains(".commonDone"),
                       "a second dismissal verb competes with the one exit")
        let fileSession = try source(named: "RealtimeFileSessionView.swift")
        XCTAssertEqual(occurrences(of: ".commonDone", in: fileSession), 1)
    }

    /// The menu bar is the only way back once the window is closed.
    func testTheMenuBarStillReopensTheSameWindow() throws {
        XCTAssertTrue(try source(named: "MenuBarView.swift").contains("openWindow(id: \"main\")"))
    }

    /// Package-backed catalogs select the Arabic copy but do not tell a macOS
    /// SwiftUI scene to mirror itself. Every scene root therefore derives one
    /// direction from the same language resolver as the copy layer. Keeping the
    /// override at the roots — and exactly there — preserves semantic
    /// leading/trailing layout throughout the destination tree without a set of
    /// per-screen exceptions that will drift.
    ///
    /// The count is the number of scene roots, and it moved from two to three
    /// when the `Settings` scene arrived. That is the point of asserting a count
    /// rather than a presence: a new scene is a new bundle-level layout
    /// decision, and the one that gets forgotten is the Arabic screen laid out
    /// left to right.
    func testEveryMacSceneRootUsesTheResolvedLanguageDirection() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("L10n.current.isRightToLeft"),
                      "layout direction must come from the localized copy resolver")
        XCTAssertEqual(occurrences(of: ".environment(\\.layoutDirection, appLayoutDirection)",
                                   in: app), 3,
                       "the window, settings and menu-bar roots must share one derived direction")
        for (name, text) in try sources(under: macRoot, atLeast: 20)
            where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("\\.layoutDirection"),
                           "\(name) must use semantic layout, not force its own direction")
        }
    }

    /// **The row's sentence moved to the destination; it did not disappear.**
    ///
    /// Every row printed its full explanatory sentence, up to three wrapped
    /// lines, five rows over — which at the supported 208×560 floor spent most
    /// of the sidebar on prose about screens the reader was not looking at, and
    /// in the longest locales did not fit at all. The sentence is now rendered
    /// once, by `DetailHeader`, on the destination that is actually open.
    ///
    /// So this guard is the OPPOSITE of the one it replaces, and both halves are
    /// load-bearing:
    ///
    ///  - the sidebar draws no caption, so the compaction cannot silently
    ///    regress by someone re-adding a visible subtitle;
    ///  - and every row still passes the complete sentence to
    ///    `accessibilityHint` **and** to `help`, so a VoiceOver user hears
    ///    exactly what they heard before and a pointer user can still read it
    ///    before choosing a row. Dropping either turns a compaction into a
    ///    removal.
    ///
    /// Section labels are explicit because the AX outline does not infer useful
    /// names from the custom section headers reliably.
    func testSidebarMovesItsCaptionsWithoutLosingThem() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        XCTAssertFalse(sidebar.contains("Text(subtitle)"),
                       "the sidebar prints the destination sentences again, five rows deep")
        XCTAssertTrue(sidebar.contains(".help(subtitle)"),
                      "the sentence is unreachable to a pointer user")
        XCTAssertTrue(sidebar.contains(".accessibilityHint(subtitle)"),
                      "the sentence is unreachable to VoiceOver")
        // The row and the screen it opens draw the same glyph, from the one
        // place that names it — a row and a header marked differently is a
        // screen that does not look like the thing that was clicked.
        XCTAssertTrue(sidebar.contains("Label(title, systemImage: surface.symbol)"),
                      "the sidebar names its own symbols again, so a row can drift from its screen")
        for (name, text) in try sources(under: macRoot, atLeast: 30) {
            XCTAssertFalse(text.contains("systemImage: \"dot.radiowaves.left.and.right\""),
                           "\(name) hard-codes a destination symbol MacSurface already names")
        }
        // Three now: the two transfer groups and the one this Mac is itself the
        // destination for. A group without the named header is a heading macOS
        // promotes to `AXHeading` and then leaves empty.
        XCTAssertEqual(occurrences(of: "sectionHeader(.navSection", in: sidebar), 3,
                       "every sidebar group needs the named accessibility header")
        XCTAssertTrue(sidebar.contains("sectionHeader(.navSectionDevice)"),
                      "the Device Inbox row sits in an unnamed group")
        // The row's title is the feature's one name. A `nav.deviceInbox` key of
        // its own is how the sidebar, the menu bar, the settings tab and the
        // destination heading end up calling one capability four things.
        XCTAssertTrue(sidebar.contains("title: L10n.t(.inboxTitle)"),
                      "the Device Inbox row invented a second name for the feature")
        XCTAssertTrue(sidebar.contains("subtitle: L10n.t(.navDeviceInboxSubtitle)"),
                      "the Device Inbox row has no subtitle, so it has no accessibility hint")
        // Every row still passes one, because the hint and the tooltip are
        // rendered from it — a row that stopped passing a subtitle would lose
        // the sentence for VoiceOver as well as for the eye.
        XCTAssertEqual(occurrences(of: "subtitle: L10n.t(", in: sidebar),
                       MacSurface.browseable.count,
                       "a sidebar row lost the sentence its hint and tooltip are made of")
        // And the same five sentences reach the screens they belong to. This is
        // the other end of the move: a header that dropped its `purpose:` would
        // delete the explanation from the product rather than relocate it.
        for (file, key) in [(lanDestination, ".navLanTransferSubtitle"),
                            (crossDestination, ".navCrossNetworkSubtitle"),
                            ("Destinations/StoredSendDestination.swift", ".navStoredSendSubtitle"),
                            ("Destinations/DeviceInboxDestination.swift", ".navDeviceInboxSubtitle"),
                            ("Destinations/AccountDestination.swift", ".navAccountSubtitle")] {
            XCTAssertTrue(try source(named: file).contains("purpose: L10n.t(\(key))"),
                          "\(file) no longer explains itself; the sentence exists nowhere visible")
        }
        for kept in [".accessibilityLabel(title)",
                     ".accessibilityAddTraits(.isHeader)",
                     // The runtime identity, so the audit gate can tell the
                     // product's own heading element apart from whatever `List`
                     // wraps it in — see the Q9 note in `SidebarView`.
                     ".accessibilityIdentifier(\"sidebar-\\(id)\")"] {
            XCTAssertTrue(sidebar.contains(kept), "the section header lost \(kept)")
        }
        // **On the text itself, and on nothing synthesized around it.** The three
        // modifiers above were applied first to a single-child `HStack` and then
        // to a `Text` — both times behind
        // `.accessibilityElement(children: .ignore)`, which replaces the view's
        // own accessibility element with a roleless synthesized one that a `List`
        // section header does not surface. The owner's 2026-08-16 audit run
        // measured the result: no element carrying any of the three
        // `sidebar-section…` identities existed in the running tree at all, so
        // the label and the heading trait were not reaching VoiceOver either.
        // Both shapes are asserted gone, in the header alone: `PathRail` and the
        // sidebar rows build one element out of several views and legitimately
        // need that modifier.
        guard let header = sidebar.range(of: "private func sectionHeader("),
              let next = sidebar.range(of: "private func row(", range: header.upperBound..<sidebar.endIndex) else {
            return XCTFail("the sidebar has no section header for the accessibility guard to read")
        }
        let sectionHeader = String(sidebar[header.lowerBound..<next.lowerBound])
        XCTAssertFalse(sectionHeader.contains("HStack"),
                       "the section header wraps its text in a stack again, so the label and "
                       + "the heading trait are back on something the text's own size")
        XCTAssertFalse(sectionHeader.contains(".accessibilityElement("),
                       "the section header synthesizes an accessibility element again; the "
                       + "2026-08-16 audit run proved a List header does not surface one, so "
                       + "the label, the trait and the identity written after it reach nothing")
        XCTAssertTrue(sectionHeader.contains("return Text(title)")
                      && sectionHeader.contains(".frame(maxWidth: .infinity, alignment: .leading)"),
                      "the section header no longer fills the row it is the heading for")
        // Two transfer rows, each with its own name and its own sentence. The
        // cross-network subtitle is the one that has to carry the distinction
        // between them, because "which of these two do I want" is answered by
        // whether the devices share a network.
        XCTAssertTrue(sidebar.contains("title: L10n.t(.navLanTransfer)"))
        XCTAssertTrue(sidebar.contains("subtitle: L10n.t(.navLanTransferSubtitle)"))
        XCTAssertTrue(sidebar.contains("title: L10n.t(.navCrossNetwork)"))
        XCTAssertTrue(sidebar.contains("subtitle: L10n.t(.navCrossNetworkSubtitle)"))
        for retired in ["navWorkspace", "navWorkspaceSubtitle", "navStoredReceiveSubtitle"] {
            XCTAssertFalse(sidebar.contains(retired),
                           "the sidebar still names a row this batch removed: \(retired)")
        }
    }

    // MARK: - the destination's name is said once, and it is not a banner

    /// **A destination heading is allowed, and it names the destination only
    /// where the sidebar does not.**
    ///
    /// The rule before this one banned a heading outright, and its reason was
    /// sound: every screen opened with a `largeTitle` and a caption copied
    /// verbatim from the sidebar row that had just been clicked, which told a
    /// reader looking at the highlighted row nothing and cost three lines of a
    /// 560pt window six times over. Removing it was right; leaving the sentences
    /// behind in a 208pt sidebar was not, and at the supported floor in the
    /// longest locales the sidebar stopped fitting.
    ///
    /// So the sentence moved to the detail column — and arrived with the title
    /// still attached, which is the defect the second audit found. A
    /// `navigationTitle` on the detail column of a `NavigationSplitView` IS the
    /// window's title, so the name was on screen three times at once: the
    /// highlighted row, the title bar directly above the content, and a heading
    /// between them.
    ///
    /// This guard is that correction, stated as a rule rather than as five
    /// screens:
    ///
    ///  - `navigationTitle` stays. It is what names the window for Mission
    ///    Control, window menus and VoiceOver's window chrome, and removing it
    ///    to fix the repetition would have been the wrong end.
    ///  - `DetailHeader` prints the title only for a surface the sidebar does
    ///    NOT offer, and `MacSurface.isBrowseable` is the one list that decides
    ///    — so the header cannot drift from which rows actually exist.
    ///  - The purpose sentence survives on every destination that has one. The
    ///    whole point is to compact the chrome, not to delete the explanation.
    ///  - Nothing in the app sets a display-sized font. `.largeTitle` is checked
    ///    as a FONT rather than as a substring, because
    ///    `@ScaledMetric(relativeTo: .largeTitle)` — how the pairing code scales
    ///    — names the same text style for a legitimate reason.
    ///  - `SectionCard` and `OpenSection` titles are untouched. They say what a
    ///    PART of a screen is, which neither the sidebar nor this header claims.
    func testTheDestinationNameIsSaidByTheChromeAndNotRepeatedInTheContent() throws {
        let scaffold = try source(named: "Components/DestinationScaffold.swift")
        XCTAssertTrue(scaffold.contains(".navigationTitle(title)"),
                      "the window lost its title")
        XCTAssertTrue(scaffold.contains("DetailHeader(symbol: surface.symbol,"),
                      "the scaffold no longer renders the one destination header")
        // The decisive line: whether the header names the destination is read
        // from the sidebar's own list, never passed per screen.
        XCTAssertTrue(scaffold.contains("namesDestination: !surface.isBrowseable"),
                      "the header no longer derives its title rule from MacSurface.browseable")
        XCTAssertFalse(scaffold.contains("Text(title)"),
                       "the scaffold draws the name itself instead of through DetailHeader")

        let header = try source(named: "Components/DetailHeader.swift")
        XCTAssertTrue(header.contains("if namesDestination {"),
                      "the header prints its title unconditionally again")
        XCTAssertTrue(header.contains(".font(.title3.weight(.semibold))"),
                      "the destination header is no longer a label-sized heading")
        XCTAssertTrue(header.contains(".accessibilityAddTraits(.isHeader)"),
                      "the header is not a heading in the accessibility outline")
        XCTAssertTrue(header.contains(".accessibilityIdentifier(\"destination-header\")")
                      && header.contains(".accessibilityIdentifier(\"destination-purpose\")"),
                      "the header has no stable runtime identity to assert against")

        // Exactly one surface is not offered by the sidebar, so exactly one
        // screen may still print its own name. Derived from `browseable` rather
        // than spelled out, so adding a row cannot silently leave a second
        // screen titling itself.
        XCTAssertEqual(MacSurface.allCases.filter { !$0.isBrowseable }, [.storedReceive],
                       "the set of screens allowed to name themselves changed")

        for surface in MacSurface.allCases {
            let name = surface.rawValue.prefix(1).uppercased() + surface.rawValue.dropFirst()
            let file = "Destinations/\(name)Destination.swift"
            let text = try source(named: file)
            XCTAssertTrue(text.contains("DestinationScaffold(title: L10n.t("),
                          "\(file) no longer names the window")
            XCTAssertTrue(text.contains("surface: .\(surface.rawValue)"),
                          "\(file) does not identify the surface it draws")
            XCTAssertFalse(text.contains("symbol:"),
                           "\(file) names its own symbol instead of taking MacSurface's")
            XCTAssertFalse(text.contains("subtitle:"),
                           "\(file) passes an introductory subtitle again")
        }

        // Compacting the chrome must not have deleted the explanation: every
        // destination the sidebar offers still hands its sentence to the header,
        // and the one it does not offer still has no sentence to hand.
        for (file, key) in [(lanDestination, ".navLanTransferSubtitle"),
                            (crossDestination, ".navCrossNetworkSubtitle"),
                            ("Destinations/StoredSendDestination.swift", ".navStoredSendSubtitle"),
                            ("Destinations/DeviceInboxDestination.swift", ".navDeviceInboxSubtitle"),
                            ("Destinations/AccountDestination.swift", ".navAccountSubtitle")] {
            XCTAssertTrue(try source(named: file).contains("purpose: L10n.t(\(key))"),
                          "\(file) stopped explaining itself when it stopped titling itself")
        }
        XCTAssertFalse(try source(named: "Destinations/StoredReceiveDestination.swift")
            .contains("purpose:"),
            "the deep-link-only screen invented a sidebar sentence it has no row for")

        // And nothing anywhere in the app sets a display-sized font of its own.
        // Comments are stripped by the loader, so the sentences explaining this
        // rule do not satisfy it.
        for (name, text) in try sources(under: macRoot, atLeast: 30) {
            XCTAssertFalse(text.contains("font(.largeTitle"),
                           "\(name) draws a page heading of its own")
        }
    }

    // MARK: - Settings is not a second home for a destination

    /// **The Device Inbox tab is gone; the Device Inbox is not.**
    ///
    /// It had a settings tab because Settings was once its only full surface.
    /// It has been a first-class destination and a menu-bar route since the
    /// shell round, and keeping the tab meant one capability with two complete
    /// screens reached by two different verbs — the exact drift the shared
    /// `DeviceInboxSurface` exists to prevent, reintroduced at the host level.
    ///
    /// Every assertion here has a matching negative: removing the tab must not
    /// remove the feature, its resident behaviour or its way back into the
    /// window.
    func testSettingsLostTheDeviceInboxTabAndNothingElseLostTheDeviceInbox() throws {
        let settings = try source(named: "Settings/SettingsView.swift")
        // ONE `.tabItem` here now, and that is not a lost tab. This file is
        // shared source compiled into both macOS products, so the Updates pane
        // moved behind the distribution seam: the direct build's
        // `AppUpdatesSettingsTab` carries its own `.tabItem`, and the App Store
        // build's is an `EmptyView` because the App Store updates that product.
        // The count is still asserted so a THIRD tab appearing here is a
        // failure rather than something nobody notices.
        XCTAssertEqual(occurrences(of: ".tabItem {", in: settings), 1,
                       "the shared settings window no longer has exactly the General tab")
        XCTAssertTrue(settings.contains("GeneralSettingsView()")
                      && settings.contains("AppUpdatesSettingsTab(updates: updates)"))
        XCTAssertFalse(settings.contains("import Sparkle"),
                       "shared settings source must not import the direct build's updater")
        // And the pane itself still exists, in the target that has an updater.
        let directUpdates = try source(named: "Distribution/DirectDistribution.swift")
        XCTAssertTrue(directUpdates.contains("struct UpdateSettingsView: View"),
                      "the Updates pane is gone from the build that has an updater")
        XCTAssertFalse(settings.contains("DeviceInboxSettingsView"),
                       "the Device Inbox settings tab is back")
        XCTAssertFalse(settings.contains("inboxTitle"),
                       "a settings tab still names the Device Inbox")
        // General keeps the one residency control, exactly once — as the shared
        // component rather than as its own copy of it. The Device Inbox
        // destination offers the same control, and the two used to be written
        // separately; see `testTheResidencyControlIsOneComponentOnBothSurfaces`.
        XCTAssertEqual(occurrences(of: "LoginItemSetting()", in: settings), 1,
                       "the Open at Login control was removed or duplicated")
        XCTAssertFalse(settings.contains("L10n.t(.settingsOpenAtLogin)"),
                       "the settings pane renders the residency control itself again")

        // The destination and the menu-bar route are both still there.
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: macRoot.appendingPathComponent(
                "Destinations/DeviceInboxDestination.swift").path),
            "the Device Inbox destination went with its settings tab")
        let menu = try source(named: "MenuBarView.swift")
        XCTAssertTrue(menu.contains("navigation.select(.deviceInbox)")
                      && menu.contains("openWindow(id: \"main\")"),
                      "the menu bar lost its route into the Device Inbox")
        XCTAssertTrue(menu.contains("InboxStatusPresentation.text(for: inbox.state)"),
                      "the menu bar lost the resident status line")

        // Exactly one host renders the shared surface now.
        let hosts = try sources(under: macRoot, atLeast: 30)
            .filter { $0.text.contains("DeviceInboxSurface {") }.map(\.name)
        XCTAssertEqual(hosts, ["Destinations/DeviceInboxDestination.swift"],
                       "the shared Device Inbox surface has more than one host again")

        // …and the settings scene no longer carries what only that tab read.
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertEqual(occurrences(of: ".environmentObject(inbox)", in: app), 2,
                       "the main window and the menu bar are the two inbox hosts")
        guard let settingsScene = app.range(of: "Settings {"),
              let menuScene = app.range(of: "MenuBarExtra(") else {
            return XCTFail("RelayiumApp no longer has the shape this checks")
        }
        let sceneBody = String(app[settingsScene.upperBound..<menuScene.lowerBound])
        for absent in [".environmentObject(inbox)", ".environmentObject(session)",
                       ".environmentObject(navigation)"] {
            XCTAssertFalse(sceneBody.contains(absent),
                           "the settings scene still injects \(absent) for a tab it no longer has")
        }
    }

    /// Lists and rosters use the available detail-column width; forms and prose
    /// retain the 720pt reading measure. This is an opt-in on exactly the two
    /// destinations with wide structured data, so making every screen stretch
    /// cannot happen as an accidental scaffold edit.
    func testOnlyStructuredDataDestinationsOptOutOfTheReadingMeasure() throws {
        for file in [lanDestination, crossDestination,
                     "Destinations/AccountDestination.swift",
                     // A grouped `Form` of controls, not prose.
                     "Destinations/DeviceInboxDestination.swift"] {
            XCTAssertTrue(try source(named: file).contains("contentMaxWidth: nil"),
                          "\(file) must let its roster/list use the detail column")
        }
        // Exactly one destination supplies its own scrolling, and it is the one
        // whose content is a `Form` — which is already a scroll view. A second
        // opt-out is a screen whose content silently stops scrolling at all.
        let optedOut = try ["LanTransfer", "CrossNetworkTransfer", "StoredSend",
                            "StoredReceive", "DeviceInbox", "Account"]
            .filter { try source(named: "Destinations/\($0)Destination.swift")
                .contains("scrolls: false") }
        XCTAssertEqual(optedOut, ["DeviceInbox"],
                       "a destination opted out of the scaffold's scroll view")
        for file in ["Destinations/StoredSendDestination.swift",
                     "Destinations/StoredReceiveDestination.swift"] {
            XCTAssertFalse(try source(named: file).contains("contentMaxWidth: nil"),
                           "\(file) should keep the prose/form reading measure")
        }
        // LAN Transfer opts its ROSTER out and constrains its prose locally:
        // the destination takes the width, and every paragraph on it is still
        // capped at the reading measure.
        let connect = try source(named: lanConnect)
        XCTAssertTrue(connect.contains(".frame(maxWidth: .infinity, alignment: .leading)"),
                      "the roster's container must accept the available width")
        XCTAssertGreaterThanOrEqual(
            occurrences(of: ".frame(maxWidth: Metrics.readingMeasure, alignment: .leading)", in: connect), 4,
            "prose on a full-width destination must keep the reading measure")
    }

    /// Signing out from Account must not hide an in-flight upload's Cancel or
    /// the only copy of a completed link. Account state is allowed to gate the
    /// two preflight states only; all running and terminal states are rendered
    /// directly from the transfer model.
    func testUploadAccountGateCannotHideRunningOrTerminalState() throws {
        let upload = try source(named: "UploadPane.swift")
        guard let switchStart = upload.range(of: "switch model.state"),
              let running = upload.range(of: "case let .uploading", range: switchStart.upperBound..<upload.endIndex),
              let done = upload.range(of: "case let .done", range: running.upperBound..<upload.endIndex),
              let failed = upload.range(of: "case let .failed", range: done.upperBound..<upload.endIndex) else {
            return XCTFail("UploadPane must switch explicitly over running and terminal states")
        }
        for branch in [running, done, failed] {
            let end = upload[branch.upperBound...].firstIndex(of: "\n") ?? upload.endIndex
            XCTAssertFalse(upload[branch.lowerBound..<end].contains("gate"),
                           "a running or terminal upload branch must not consult the account gate")
        }
        XCTAssertTrue(upload.contains("case .idle:\n            if case .allowed = gate"),
                      "only idle preflight should expose an account gate")
        XCTAssertTrue(upload.contains("case .picked:\n            if case .allowed = gate"),
                      "only picked preflight should require the upload token")
    }

    /// The receive pane's Try Again is the model's decision, not the view's.
    ///
    /// It used to be unconditional and hard-wired to `resolve()`: the same
    /// button for a 404, a burnt link and a dropped connection, and after a
    /// failure halfway through the transfer it walked the user back to a
    /// confirmation card they had already accepted instead of repeating the
    /// download. Which failures are worth repeating — and what repeating them
    /// means — is decided from the typed error in `CloudDownloadModel`, where
    /// `CloudDownloadRecoveryTests` can hold it. A view that reads a message or
    /// a status to make that call would put the policy somewhere no test
    /// reaches and make it wrong in eight languages.
    func testTheDownloadPaneOffersRetryOnlyWhereTheModelSaysItHelps() throws {
        let pane = try source(named: "DownloadPane.swift")
        XCTAssertTrue(pane.contains("if model.canRetry"),
                      "the retry affordance must be conditional on the model's recovery")
        XCTAssertTrue(pane.contains("model.retry()"),
                      "the retry must go through the model's guarded entry point")
        XCTAssertFalse(pane.contains("Button(L10n.t(.commonTryAgain)) { model.resolve() }"),
                       "a failed transfer must not be retried by re-resolving the link")
    }

    // MARK: - registration happens in the app

    /// No macOS surface opens the website to do account work.
    ///
    /// `AppEnvironment.accountWebURL` was the "send them to relayium.com"
    /// hand-off, and three surfaces used it: the sign-in form's *Create an
    /// account*, the capability gate's, and both check-email screens. All four
    /// are native now, so a reference here is a regression to the flow this
    /// slice replaced.
    ///
    /// Two hand-offs survive and are deliberately allowed: `plansWebURL`
    /// (billing stays on the web) and `reactivateWebURL` (a frozen account
    /// cannot sign in, so the token in that link is the only way back).
    func testNoMacSurfaceOpensTheWebsiteForAccountWork() throws {
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            XCTAssertFalse(text.contains("accountWebURL"),
                           "\(name) sends the user to the website for account work")
        }
    }

    /// The form creates the account itself, and owns which half is showing.
    func testTheFormRegistersNativelyAndOwnsItsMode() throws {
        let login = try source(named: "LoginView.swift")
        XCTAssertTrue(login.contains("session.register(email:"),
                      "the form must create the account through the session, in the app")
        XCTAssertTrue(login.contains("@State private var mode: AuthMode"),
                      "the mode is the form's own state")
        XCTAssertTrue(login.contains("SignInPresentation.problem(in: submitted)"),
                      "the substantive checks run before a request goes out")
        for (label, id) in [
            (".loginDisplayName", "account.name"),
            (".loginEmail", "account.email"),
            (".loginPassword", "account.password"),
            (".loginConfirmPassword", "account.confirmPassword"),
        ] {
            XCTAssertTrue(login.contains(".accessibilityLabel(L10n.t(\(label)))"))
            XCTAssertTrue(login.contains(".accessibilityIdentifier(\"\(id)\")"))
        }
        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("testRegistrationProblemKeepsTheDraftCorrectable"))
        XCTAssertTrue(ui.contains("window.secureTextFields[\"account.confirmPassword\"]"))
        XCTAssertTrue(ui.contains("Use at least 8 characters for your password."))
        XCTAssertTrue(login.contains(".accessibilityIdentifier(\"account.switchMode\")"))
        XCTAssertTrue(ui.contains("[\"account.switchMode\"].firstMatch"),
                      "macOS 15 may not expose a link-style Button as a button")
        // `DeviceInbox/DeviceInboxSurface.swift` joins the two exemptions for the
        // reason they exist: it FORWARDS the half a gate asked for, exactly as
        // `CapabilityGateView` does, and the type annotation on that closure is
        // the only reason it names `AuthMode` at all. The three send panes stay
        // outside the exemption because they forward with `$0` and never need
        // the type — this one is a stored property, which does.
        //
        // The exemption is bounded rather than granted: the mode must never
        // become the surface's own state, and it must never be branched on.
        // Deciding the form's mode is what this guard forbids; carrying somebody
        // else's request through is not the same thing.
        let shared = try source(named: "DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(shared.contains("let onAccount: (AuthMode) -> Void"),
                      "the shared surface no longer forwards the requested half")
        // Per LINE, not per file. Written as two whole-file `contains` calls,
        // this said "the surface has some `@State` and mentions `AuthMode`
        // somewhere" — which became true, and stayed failing, the moment the
        // surface grew a `@State private var copiedMessageID` for the Copy
        // button on a received message. That state is not a mode and never was.
        // What the guard means is that no state DECLARATION is of the form's
        // mode, and this is that sentence.
        let holdsTheMode = shared.components(separatedBy: "\n")
            .contains { $0.contains("@State") && $0.contains("AuthMode") }
        XCTAssertFalse(holdsTheMode,
                       "the shared Device Inbox surface holds the form's mode itself")
        XCTAssertFalse(shared.contains("switch mode"),
                       "the shared Device Inbox surface branches on the form's mode")
        for (name, text) in try sources(under: macRoot, atLeast: 20)
        where name != "LoginView.swift" && name != "Components/CapabilityGateView.swift"
            && name != "DeviceInbox/DeviceInboxSurface.swift" {
            XCTAssertFalse(text.contains("AuthMode"),
                           "\(name) must not decide the form's mode")
        }
    }

    /// A capability gate's **Create an account** routes into the app.
    ///
    /// Both halves matter. Opening a website would be the old flow; selecting
    /// the Account destination without naming the create-account half would be a
    /// button that says one thing and produces a sign-in form — the same defect
    /// as the greyed control `CapabilityGateView` exists to replace.
    func testTheCapabilityGatesCreateAccountSelectsTheNativeForm() throws {
        let gate = try source(named: "Components/CapabilityGateView.swift")
        XCTAssertTrue(gate.contains("Button(L10n.t(.gateCreateAccount)) { onAccount(.register) }"),
                      "Create an account must open the native form on its create half")
        XCTAssertTrue(gate.contains(".accessibilityIdentifier(\"account.create\")"))
        // `exit(_:action:)` rather than a bare `Button`: the control is drawn at
        // the weight its gate's scope earns (see
        // `testOnlyAWholeSurfaceGateDrawsItsSignInAsThePrimaryAction`). What
        // this guard is about is unchanged and still asserted — where it goes.
        XCTAssertTrue(gate.contains("exit(L10n.t(.gateOpenAccount)) { onAccount(.signIn) }"),
                      "an unverified address is finished on the Account destination, "
                      + "which owns the resend action — not on a website")
        XCTAssertFalse(gate.contains("NSWorkspace.shared.open(AppEnvironment.webURL"),
                       "a gate finishes an account step on a website again")
        for caller in ["UploadPane.swift", crossConnect] {
            XCTAssertTrue(try source(named: caller)
                .contains("onAccount: { navigation.selectAccount(intent: $0) }"),
                          "\(caller) must pass the gate's requested half through to navigation")
        }
        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("testStoredSendAccountRemediesOpenThePromisedForm"),
                      "the account remedy must be proven through the running app")
        XCTAssertTrue(ui.contains("window.buttons[\"Sign in\"]"))
        XCTAssertTrue(ui.contains("[\"account.create\"].firstMatch"))
        XCTAssertTrue(ui.contains("window.staticTexts[\"Welcome back\"]"))
        XCTAssertTrue(ui.contains("window.staticTexts[\"Create your Relayium account\"]"))
    }

    /// The check-email screen can act and can leave, exactly as on iOS.
    func testTheCheckEmailScreenCanResendAndGoBack() throws {
        let account = try source(named: "Destinations/AccountDestination.swift")
        XCTAssertTrue(account.contains("session.resendVerification(email: email)"),
                      "the check-email screen must be able to ask for another email")
        XCTAssertTrue(account.contains("L10n.t(.contentBackToSignIn)"),
                      "and must offer the way back, which is a sign-out")
        XCTAssertTrue(account.contains("navigation.rememberAccountIntent(.signIn)"),
                      "Back to sign in must not replay an older register route")
        XCTAssertTrue(account.contains("if isResending {"),
                      "the resend button must be replaced while a request is in flight, "
                      + "so a second press cannot start a second request")
    }

    /// The browser device flow may not impersonate native Sign in with Apple.
    ///
    /// It opens relayium.com in an `ASWebAuthenticationSession` sheet and polls
    /// `/api/cli/device/*`. Whatever the user picks over there — Apple, a
    /// password, anything else — is the browser's business, and no Apple-ID API
    /// and no `com.apple.developer.applesignin` entitlement exists in this app.
    /// So a button labelled for Apple was a claim about a mechanism that is not
    /// here. The action stays; only the claim goes.
    ///
    /// The ban is on the Apple-ID vocabulary specifically, NOT on the
    /// `AuthenticationServices` framework: `BrowserSignIn.swift` imports it for
    /// the web sheet, which is a different API for a different thing, and
    /// banning the import would force the sheet to be rewritten to satisfy a
    /// test rather than a requirement.
    func testTheBrowserFallbackDoesNotClaimToBeNativeApple() throws {
        let login = try rawSource(named: "LoginView.swift")
        XCTAssertTrue(login.contains("L10n.t(.loginBrowserSignIn)"),
                      "the browser fallback must be labelled for what it does")
        XCTAssertTrue(login.contains("startBrowserLogin()"),
                      "and must still work — this renames a claim, it does not remove a feature")
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            for appleism in ["SignInWithAppleButton", "ASAuthorizationAppleID",
                             "ASAuthorizationController", "signInWithApple"] {
                XCTAssertFalse(text.contains(appleism),
                               "\(name) claims native Apple sign-in: \(appleism)")
            }
        }
        XCTAssertTrue(try source(named: "BrowserSignIn.swift")
            .contains("ASWebAuthenticationSession"),
                      "the sheet is a web session, which is what the label now says")
        let entitlements = try String(
            contentsOf: macRoot.appendingPathComponent("Relayium.entitlements"), encoding: .utf8)
        XCTAssertFalse(entitlements.contains("applesignin"),
                       "this slice adds no Apple entitlement")
    }

    /// iOS gaining native Sign in with Apple does not give macOS one.
    ///
    /// The iOS slice ships a real `SignInWithAppleButton`, an Apple entitlement
    /// and a hardened server exchange. None of it crosses: the shipped evidence
    /// is that a Developer ID (outside the Mac App Store) distribution cannot
    /// carry `com.apple.developer.applesignin`, so a Mac build with that button
    /// would either fail to sign or fail at the first authorization. Until a
    /// Mac App Store track exists, the honest macOS control is the browser
    /// sign-in it already has, labelled as one.
    ///
    /// The shared layer is exempt on purpose: `AccountSession.logInWithApple`
    /// and `AppleSignIn.swift` are platform-free value logic, and the thing
    /// that would make macOS claim the feature is the AppKit-level control and
    /// the entitlement — which is what this asserts the absence of.
    func testMacDidNotInheritTheIOSNativeAppleSignIn() throws {
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            for symbol in ["SignInWithAppleButton", "ASAuthorizationAppleID",
                           "logInWithApple", "AppleSignInAttempt"] {
                XCTAssertFalse(text.contains(symbol),
                               "\(name) adopts native Apple sign-in on macOS: \(symbol)")
            }
        }
        let entitlements = try String(
            contentsOf: macRoot.appendingPathComponent("Relayium.entitlements"), encoding: .utf8)
        XCTAssertFalse(entitlements.contains("applesignin"),
                       "the Developer ID macOS build cannot carry this entitlement")
    }

    // MARK: - Universal Link hand-off

    /// The hand-off is wired once, at the scene root, and consumed once, in the
    /// shell — and the view layer decides nothing about the link.
    ///
    /// Modelled on `IOSSurfaceGuardTests`' equivalent, because this platform now
    /// runs the same policy object. Each clause is a way this could look finished
    /// and not be. A second `onOpenURL` would be a second entry point with its own
    /// idea of what a link may overwrite. A second coordinator would be a second
    /// answer to the same question, built from models nothing else observes. And
    /// a handler that read `isBusy` here would be the shared policy re-derived in
    /// SwiftUI, where no test can reach it — `AppDeepLinkCoordinatorTests` owns
    /// that decision against real models.
    func testTheUniversalLinkHandOffIsWiredOnceAndDecidesNothingInTheViewLayer() throws {
        let all = try sources(under: macRoot, atLeast: 20)
        let app = try source(named: "RelayiumApp.swift")
        let shell = try source(named: "Shell/AppShellView.swift")

        XCTAssertEqual(all.map { occurrences(of: ".onOpenURL", in: $0.text) }.reduce(0, +), 1,
                       "a second onOpenURL would be a second entry point for a link")
        // The modifier now carries BOTH hand-offs — see the opened-files guard
        // below for why every `file://` URL arrives here too — but the link half
        // is unchanged: tried first, unparsed, and by the router rather than by
        // anything in this file.
        XCTAssertTrue(app.contains(".onOpenURL { url in"),
                      "the OS hand-off belongs at the scene root")
        XCTAssertTrue(app.contains("guard !deepLinks.open(url) else { return }"),
                      "a link must still reach the router unparsed, and must still win outright")

        // Both objects are the App's, so a retained link outlives not just the
        // window's view tree but the window itself — which on this platform is an
        // ordinary running state, because the MenuBarExtra keeps the process up.
        for scoped in ["@StateObject private var deepLinks = AppDeepLinkRouter()",
                       "@StateObject private var deepLinkRouting: AppDeepLinkCoordinator"] {
            XCTAssertTrue(app.contains(scoped), "RelayiumApp lost \(scoped)")
        }
        XCTAssertEqual(occurrences(of: "AppDeepLinkCoordinator(", in: app), 1,
                       "a second coordinator would be a second answer to what a link may touch")
        // Built from the app-scoped models, not from its own: the four locals
        // named here are the same ones the four `@StateObject`s below wrap, so a
        // coordinator watching a private copy of `CloudDownloadModel` — which
        // would never see the download the user is actually running — is a
        // failure rather than something a reviewer has to notice.
        //
        // And it is the DIRECT module's realtime models and presence, because
        // `AppRouting.destination(for:)` sends a realtime link to
        // `.pairingCode`. Given the Nearby module's, the coordinator would
        // refuse to apply a pairing link because a same-network transfer was
        // running — cross-module interference in the one place a link arrives.
        for wiring in ["navigation: routing, download: downloads,",
                       "realtime: directFiles, realtimeText: directText,",
                       "presence: directModule.presence,",
                       "selectRealtimeMode: { mode in directModule.presence.selectMode(mode) }",
                       "_transferModules = StateObject(wrappedValue: modules)",
                       "_navigation = StateObject(wrappedValue: routing)",
                       "_downloadModel = StateObject(wrappedValue: downloads)"] {
            XCTAssertTrue(app.contains(wiring),
                          "the coordinator must share the app's models: \(wiring)")
        }
        // The models it was handed are the very ones the Direct module was built
        // from — not a private pair that would never see the session the user is
        // actually in.
        XCTAssertTrue(app.contains(
            "let directModule = TransferModule(route: .pairingCode, files: directFiles,"),
                      "the coordinator watches models the Direct module does not own")
        // One injection, and it is the unique window's. The MenuBarExtra root
        // deliberately does not get it: nothing there subscribes, and a second
        // injection point is how a second subscriber starts.
        XCTAssertEqual(occurrences(of: ".environmentObject(deepLinkRouting)", in: app), 1,
                       "the coordinator is injected into the one window that renders links")

        // One subscription, in the shell, and it does exactly two things.
        XCTAssertEqual(all.map { occurrences(of: "deepLinks.$pending", in: $0.text) }.reduce(0, +), 1,
                       "a second subscription would apply every link twice")
        XCTAssertTrue(shell.contains(".onReceive(deepLinks.$pending.compactMap { $0 }) { link in"))
        XCTAssertEqual(all.map { occurrences(of: "deepLinkRouting.deliver(", in: $0.text) }
                          .reduce(0, +), 1,
                       "a second deliver would navigate twice for one link")
        XCTAssertTrue(shell.contains("deepLinkRouting.deliver(link)"),
                      "the shell must hand the link to the shared coordinator")
        // Deferred by one turn (the `@Published` willSet ordering) AND by
        // expected link, so a second link landing inside that gap is not thrown
        // away by the first one's consume. The window being closable makes the
        // deferral's other half concrete here: `Published` replays its current
        // value to the subscription this shell rebuilds on every reopen.
        XCTAssertEqual(all.map { occurrences(of: "deepLinks.consume", in: $0.text) }.reduce(0, +), 1,
                       "the link is consumed in exactly one place")
        XCTAssertTrue(shell.contains("Task { @MainActor in deepLinks.consume(link) }"),
                      "the consume must be deferred and must name the link it acted on")
        XCTAssertFalse(shell.contains("deepLinks.consume()"),
                       "an unqualified consume can discard a newer link")
    }

    /// A link fills a field and selects a destination. It never joins, never
    /// downloads, and — the defect this replaced — never overwrites live work.
    ///
    /// The shell is where that went wrong, because it used to hold every model a
    /// link touches and applied each one unconditionally: a `/d/` link tapped
    /// during a download re-`resolve()`d it, and a pairing link tapped during a
    /// live session swapped the code out from under it. Neither is visible in a
    /// screenshot. Banning the models themselves, not just the calls, is what
    /// keeps the policy from growing back — a view with `CloudDownloadModel` to
    /// hand has a way to re-derive the decision `AppDeepLinkCoordinator` owns.
    func testTheMacLinkPathAppliesNothingItself() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        for reaching in ["AppRouting.destination(for: link)", "linkText", "resolve()",
                         "updateJoinCode", "isBusy", ".download(into:",
                         "CloudDownloadModel", "RealtimeSessionModel",
                         "RealtimeTextSessionModel"] {
            XCTAssertFalse(shell.contains(reaching),
                           "the shell applies a link itself: \(reaching)")
        }
        // The scene root hands the URL over unparsed and applies nothing either.
        let app = try source(named: "RelayiumApp.swift")
        for reaching in ["AppRouting.destination(for: link)", "linkText", "updateJoinCode",
                         ".download(into:"] {
            XCTAssertFalse(app.contains(reaching),
                           "RelayiumApp applies a link itself: \(reaching)")
        }
    }

    /// The comments that said macOS still applies links inline. Each described
    /// this tree accurately until the coordinator was adopted and then became a
    /// claim that the thing it points at does not exist — the kind of stale
    /// comment a reader trusts, and here one that would send them looking for a
    /// follow-up that is done.
    func testNothingStillCallsTheMacLinkPathInline() throws {
        XCTAssertFalse(try rawSource(named: "Shell/AppShellView.swift")
            .contains("The ONE selection write"),
                       "the shell no longer makes the selection write; the comment must go")
        let coordinator = try String(
            contentsOf: appsRoot.appendingPathComponent(
                "RelayiumKit/Sources/RelayiumAppKit/AppDeepLinkCoordinator.swift"),
            encoding: .utf8)
        XCTAssertFalse(coordinator.contains("macOS still applies a link inline"),
                       "macOS drives this object now; the deferral note must go")
        XCTAssertFalse(try claimSurfaceText("apps/README.md")
            .contains("**macOS still applies links inline**"),
                       "apps/README.md still records the adoption as a follow-up")
    }

    // MARK: - files the OS opened with this app

    /// Finder's Open With, and a drop on the Dock icon. Wired once, at the
    /// delegate, and every decision about it lives outside the view layer —
    /// exactly the shape the link hand-off above is held to.
    func testTheOpenedFileHandOffIsWiredOnceAndDecidesNothingInTheViewLayer() throws {
        let all = try sources(under: macRoot, atLeast: 20)
        let app = try source(named: "RelayiumApp.swift")
        let shell = try source(named: "Shell/AppShellView.swift")

        // **Where an opened file actually arrives, measured rather than assumed.**
        // SwiftUI's own app delegate consumes an AppKit open, republishes each
        // URL — `file://` included — through the scene's `onOpenURL`, and only
        // then calls the adaptor delegate with an EMPTIED array. A probe on this
        // tree logged `onOpenURL file:///…/qa-sample.txt` one millisecond before
        // `application(_:open:) got 0 urls`.
        //
        // The first version of this feature routed files from the delegate and
        // shipped nothing: every opened file reached `deepLinks.open`, failed to
        // parse as an https link, and was discarded in silence. This assertion
        // is the one that would have caught it.
        XCTAssertTrue(app.contains("fileOpens.open([url])"),
                      "opened files must be routed from onOpenURL; the delegate's array is empty")

        // The delegate keeps exactly one job, and it is the one the scene cannot
        // do: this app is menu-bar resident with a closable window, so Open With
        // against a closed window would otherwise stage files into a window
        // nobody can see.
        XCTAssertEqual(all.map { occurrences(of: "func application(", in: $0.text) }.reduce(0, +), 1,
                       "a second AppKit open callback would be a second entry point")
        XCTAssertTrue(app.contains("func application(_ application: NSApplication, open urls: [URL])"))
        // TWO occurrences: the definition and exactly one call. Asserting mere
        // presence passed while the call site was deleted — the definition line
        // contains the same spelling — so the count is what makes this guard
        // load-bearing rather than decorative.
        XCTAssertEqual(occurrences(of: "showTheMainWindow()", in: app), 2,
                       "an open with the window closed must bring it back, from exactly one place")
        // Ordered front, never created. A `WindowGroup` would make a second
        // window here, which is the one thing the whole shell design prevents.
        XCTAssertTrue(app.contains("window.makeKeyAndOrderFront(nil)"))
        XCTAssertFalse(app.contains("NSWindow("), "the delegate must not build a window")

        // The fallback stays wired rather than becoming a comment: if a future
        // macOS stops emptying that array, the files must have somewhere to go.
        // The failure it guards is silent, which is exactly why it is not left
        // to a reader to notice.
        XCTAssertTrue(app.contains("var didOpenFiles: (([URL]) -> Void)?"))
        XCTAssertTrue(app.contains("quitGuard.didOpenFiles = { fileOpens.open($0) }"),
                      "the delegate fallback must reach the same app-scoped router")

        // Both objects are the App's, so a batch outlives the window's view tree
        // and the window itself — the ordinary resident state on this platform.
        for scoped in ["@StateObject private var fileOpens = AppFileOpenRouter()",
                       "@StateObject private var fileOpenRouting: AppFileOpenCoordinator"] {
            XCTAssertTrue(app.contains(scoped), "RelayiumApp lost \(scoped)")
        }
        XCTAssertEqual(occurrences(of: "AppFileOpenCoordinator(", in: app), 1,
                       "a second coordinator would be a second answer to where files go")
        // The SAME navigation model the link coordinator gets. Two navigation
        // models would let an opened file and a tapped link disagree about
        // where the user is.
        XCTAssertTrue(app.contains("AppFileOpenCoordinator(navigation: routing)"),
                      "the coordinator must share the app's navigation model")

        // One subscription, in the shell, doing exactly what the link one does.
        XCTAssertEqual(all.map { occurrences(of: "fileOpens.$pending", in: $0.text) }.reduce(0, +), 1,
                       "a second subscription would route every batch twice")
        XCTAssertTrue(shell.contains(".onReceive(fileOpens.$pending.compactMap { $0 }) { urls in"))
        XCTAssertTrue(shell.contains("fileOpenRouting.deliver(urls)"))
        // Deferred AND expected, for the `@Published` willSet ordering and the
        // second-batch race the link path's consume documents.
        XCTAssertTrue(shell.contains("Task { @MainActor in fileOpens.consume(urls) }"),
                      "the consume must be deferred and must name the batch it acted on")
        XCTAssertFalse(shell.contains("fileOpens.consume()"),
                       "an unqualified consume can discard a newer batch")
    }

    func testQuitGuardIncludesTheOnlyLocalTextHistory() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("final class AppQuitGuard"))
        XCTAssertTrue(app.contains("var hasLocalText: (() -> Bool)?"))
        XCTAssertTrue(app.contains("quitGuard.hasLocalText = {"))
        // BOTH modules. Either one can be holding the only copy of typed text,
        // and a guard that asked one of them would let ⌘Q discard the other's
        // without ever mentioning it.
        XCTAssertTrue(app.contains("quitGuard.hasLocalText = { transferModules.hasLocalText }"))
        XCTAssertTrue(try appKitSource(named: "TransferModule.swift")
            .contains("public var hasLocalText: Bool { text.hasLocalContent }"))
        XCTAssertTrue(try appKitSource(named: "TransferModule.swift")
            .contains("public var hasLocalText: Bool { all.contains { $0.hasLocalText } }"),
                      "the app-wide answer ignores one of the two modules")
        XCTAssertTrue(app.contains("QuitPresentation.risk("))
        XCTAssertTrue(app.contains("QuitPresentation.prompt(for: risk)"))
        XCTAssertFalse(app.contains("L10n.t(.quitCancelAndQuit)"))
        XCTAssertFalse(app.contains("L10n.t(.quitKeepTransferring)"))
    }

    /// The shell forwards; it does not stage. A shell holding a `SelectionStore`
    /// has a way to re-derive the routing and busy rules the coordinator owns,
    /// which is how the link path grew its inline version in the first place.
    func testTheOpenedFilePathAppliesNothingItself() throws {
        let shell = try source(named: "Shell/AppShellView.swift")
        for reaching in ["AppRouting.destination(forOpenedFiles", "SelectionStore",
                         "selection.add(", "expandSelection", "fileOpenRouting.batch("] {
            XCTAssertFalse(shell.contains(reaching),
                           "the shell stages opened files itself: \(reaching)")
        }
        let app = try source(named: "RelayiumApp.swift")
        for reaching in ["AppRouting.destination(forOpenedFiles", "selection.add(",
                         "transferSelection.add(", "transferSelection.replace("] {
            XCTAssertFalse(app.contains(reaching),
                           "RelayiumApp stages opened files itself: \(reaching)")
        }
        // **And it no longer owns a staged selection at all.**
        //
        // It used to own exactly one, app-scoped, so a batch survived the window
        // closing and the user switching between the two transfer destinations.
        // Both destinations are connect-first: they establish the session before
        // anything is chosen, so nothing writes that store and nothing reads it.
        // Zero mentions rather than one is what makes the absence structural —
        // an environment that does not carry a shared staging context cannot
        // have one reached for by a later edit.
        XCTAssertEqual(occurrences(of: "SelectionStore", in: app), 0,
                       "the app owns an app-scoped staged batch again")
        XCTAssertFalse(app.contains("transferSelection"),
                       "the shared pre-connect staging context is back in the environment")
    }

    /// **Exactly ONE pane adopts an OS-opened batch, and it is not a transfer
    /// screen.**
    ///
    /// There were three. The two real-time transfer panes took a batch from a
    /// shared route set into an app-scoped selection, which was the whole point
    /// while they staged before connecting. They do not: a session is
    /// established first, so an adopted batch would have nowhere to sit and no
    /// control on the screen that could have produced it — pre-connect staging
    /// arriving through the Dock instead of through a button.
    ///
    /// The negative half is the load-bearing one, and it is now two negatives: a
    /// pane that read `staged` directly would be a second copy of the busy rule,
    /// and a transfer pane that adopted at all would be the removed side door.
    func testOnlyStoredSendAdoptsOpenedFilesAndNobodyReDerivesTheRule() throws {
        let panes = ["UploadPane.swift"]
        for (file, route) in [(lanConnect, "AppDestination.nearby"),
                              (crossConnect, "AppDestination.pairingCode")] {
            XCTAssertTrue(try source(named: file).contains("private let route = \(route)"),
                          "\(file) does not name the one route it claims for")
        }
        for pane in panes {
            let text = try source(named: pane)
            XCTAssertTrue(text.contains("selection.add(batch.urls)"),
                          "\(pane) must append rather than replace what the user already picked")
            XCTAssertTrue(text.contains("fileOpenRouting.consume(batch)"),
                          "\(pane) must consume the batch it staged")
            // Keyed on BOTH facts. Keyed on the batch alone, one that arrived
            // mid-transfer is never republished and therefore never lands.
            XCTAssertTrue(text.contains("FileOpenAdoption(staged: fileOpenRouting.staged, busy:"),
                          "\(pane) must re-ask adoption when either the batch or busy changes")
        }
        // Named individually, because these two are the removal: neither pane
        // may mention the coordinator at all, in any form.
        for pane in [lanConnect, crossConnect] {
            let text = try source(named: pane)
            XCTAssertFalse(text.contains("fileOpenRouting"),
                           "\(pane) reaches the opened-file coordinator again")
            XCTAssertFalse(text.contains("AppFileOpenCoordinator"),
                           "\(pane) holds the opened-file coordinator again")
            XCTAssertFalse(text.contains("FileOpenAdoption"),
                           "\(pane) re-arms opened-file adoption")
        }
        // And the widened ask is gone with them, everywhere.
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            XCTAssertFalse(text.contains("forAnyOf:"),
                           "\(name) asks for a shared staging context that no longer exists")
            XCTAssertFalse(text.contains("macTransferRoutes"),
                           "\(name) names a shared transfer staging context again")
        }
        XCTAssertTrue(try source(named: "UploadPane.swift").contains(
            "fileOpenRouting.batch(for: .storedSend, busy: model.isBusy)"),
            "Stored Send must adopt exactly its own destination")

        // Nobody else touches the coordinator's state, and nobody reads `staged`
        // to decide for themselves.
        let all = try sources(under: macRoot, atLeast: 20)
        let adopters = all.filter { $0.text.contains("fileOpenRouting.batch(") }
        XCTAssertEqual(Set(adopters.map(\.name)), Set(panes),
                       "exactly one send pane may adopt opened files")
        for file in all where !panes.contains(file.name) {
            XCTAssertFalse(file.text.contains("fileOpenRouting.consume("),
                           "\(file.name) consumes a batch it did not stage")
        }
    }

    /// Both transfer screens claim a surface before their async start moves a
    /// realtime model to busy. Open With/Dock Drop must treat that ownership as
    /// busy too, and key the task on the combined answer so release retries it.
    ///
    /// The combined answer is `sessionLocked`, computed once per destination
    /// from `TransferSurfacePresentation.acceptsNewSession` — which reads ANY
    /// owner, not only this screen's, because a claim on the other transfer
    /// destination is equally a reason not to mutate a selection behind the user.
    func testRealtimeOpenedFilesWaitForClaimedSessionOwnershipToClear() throws {
        for name in [lanDestination, crossDestination] {
            let destination = try source(named: name)
            XCTAssertTrue(destination.contains("!module.acceptsNewSession"),
                          "\(name)'s lock ignores ownership and reads busy flags alone")
            XCTAssertFalse(destination.contains("presence.rendersSession("),
                           "adoption must stop for every claim, not only this one's")
        }
        // The module's own answer is the ownership-aware one, and it is asked
        // about THIS module: `owner` here can only ever be this module's route
        // or nobody, so a session on the other destination cannot lock a screen
        // it is not on.
        XCTAssertTrue(try appKitSource(named: "TransferModule.swift")
            .contains("owner: presence.owner, sessionIsLiveOrRetained: sessionIsLiveOrRetained"),
                      "the module's lock ignores ownership and reads busy flags alone")
        for name in [lanConnect, crossConnect] {
            let connect = try source(named: name)
            XCTAssertTrue(connect.contains("let sessionLocked: Bool"),
                          "\(name) re-derives the lock instead of taking the tested answer")
            // A screen whose every control is disabled has to say why. What it
            // is waiting on is this screen's own retained session — a transfer
            // that is open in Relayium and has to be finished or left — and a
            // greyed control with no stated reason is the dead end this app's
            // rules forbid.
            XCTAssertTrue(connect.contains("if sessionLocked {")
                          && connect.contains("InlineMessage(.info, L10n.t(.transferBusyElsewhere))"),
                          "\(name) disables every control without saying why")
            // And it can no longer reach the other module to ask about it.
            XCTAssertFalse(connect.contains("modules."),
                           "\(name) reads the other transfer module")
            // What this pair used to also assert — that adoption is re-armed on
            // `sessionLocked` — is gone with adoption itself. The lock is now
            // load-bearing only for the connect controls, which is the one thing
            // left on these screens that can start anything.
            XCTAssertFalse(connect.contains("fileOpenRouting"),
                           "\(name) re-arms opened-file adoption behind the session lock")
        }
    }

    /// Item-provider resolution suspends after AppKit accepts a drop. A live
    /// session may start during that wait, so admission at drop time alone does
    /// not authorize the later selection mutation.
    func testDelayedDropsRecheckLiveOwnershipBeforeChangingSelection() throws {
        let zone = try source(named: "FileDropZone.swift")
        XCTAssertTrue(zone.contains("let isBusy: () -> Bool"))
        guard let resolve = zone.range(of: "let urls = await droppedFileURLs(providers)"),
              let recheck = zone.range(of: "guard !isBusy() else { return }",
                                       range: resolve.lowerBound..<zone.endIndex),
              let add = zone.range(of: "store.add(urls)",
                                   range: recheck.lowerBound..<zone.endIndex) else {
            return XCTFail("the drop target lost its post-suspension admission check")
        }
        XCTAssertTrue(resolve.lowerBound < recheck.lowerBound && recheck.lowerBound < add.lowerBound)

        // `TransferStagingSection` is DORMANT — no macOS screen constructs it —
        // and it is kept whole so a re-enable of pre-staging restores these rules
        // rather than rediscovering them. Asserted as source, because a dormant
        // file has no runtime.
        let staging = try source(named: transferStaging)
        XCTAssertTrue(staging.contains("FileDropZone(store: selection, isBusy: isBusy)"))
        XCTAssertTrue(staging.contains("let isBusy: () -> Bool"),
                      "the staging section snapshots busy at render instead of re-reading it")
        XCTAssertEqual(occurrences(of: "FileDropZone(", in: staging), 1,
                       "one staging section, one drop target — two would be two selections")
        XCTAssertEqual(occurrences(of: ".disabled(isBusy())", in: staging), 2,
                       "choose and clear must both obey the same live session lock")
        XCTAssertTrue(try rawSource(named: transferStaging)
            .contains("## Dormant: nothing on macOS constructs this"),
            "the dormant staging section no longer says that it is dormant")
        XCTAssertTrue(try sources(under: macRoot, atLeast: 20)
            .filter { $0.text.contains("TransferStagingSection(") }
            .allSatisfy { $0.name == transferStaging },
            "a macOS screen constructs the dormant pre-connect staging section")
        XCTAssertTrue(try source(named: "UploadPane.swift").contains(
            "FileDropZone(store: selection, isBusy: { model.isBusy })"))
    }

    /// Claim refusal is a real concurrency result, not an impossible branch:
    /// an inbound offer can win between the last render and an outbound click.
    /// Every macOS start path must stop before touching its shared model.
    ///
    /// **Three outbound starts now, three claims.** The LAN screen had two verbs
    /// and four starts — a link and a legacy path for each of `Send a message`
    /// and `Send files`. Connect-first leaves one verb, so it has one link start
    /// and one legacy start, and the legacy one carries whichever mode
    /// `LegacyLane.mode` answered rather than whichever button was pressed. That
    /// the kind is written by the claim, from the peer's announcement, is the
    /// whole removal: there is no moment at which an intent exists without
    /// ownership behind it, and no moment at which a lane exists without evidence
    /// behind it.
    func testEveryOutboundRealtimeStartRequiresItsSurfaceClaim() throws {
        let lan = try source(named: lanConnect)
        let cross = try source(named: crossConnect)
        // Each claim names `route` — the file's own destination, declared once —
        // rather than a literal, so a start path cannot claim the other screen's
        // route while rendering on this one.
        let lanClaims = [
            "guard presence.beginSession(route, mode: mode, peerLabel: live.label) else { return }",
        ]
        let crossClaims = [
            // Two paths — create and connect — and both take `.files`
            // PROVISIONALLY rather than as a kind the user chose: the file model
            // is the one that holds a minted code, and `adoptLegacyRoom` moves
            // the surface if the room resolves to a legacy text peer.
            "guard presence.beginSession(route, mode: .files) else { return }",
        ]
        // The ONE unified-link start. It takes the mode-less claim, because a
        // link has no files-or-text mode to arbitrate — and it RELEASES the claim
        // when the link refuses, which the mode-carrying legacy path does not
        // need because its model publishes a failure state instead.
        XCTAssertEqual(occurrences(
            of: "guard presence.beginSession(route, peerLabel: live.label) else { return }",
            in: lan), 1,
            "the link start must claim the surface before connecting")
        XCTAssertEqual(occurrences(of: "presence.release(route)", in: lan), 1,
                       "a refused link must hand the surface back rather than strand it")
        for claim in lanClaims {
            XCTAssertEqual(occurrences(of: claim, in: lan), 1,
                           "\(lanConnect) can start a shared model after losing ownership: "
                           + claim)
        }
        // The claim's mode is the resolver's answer, read once, before the claim
        // — never a literal, which is how a lane chosen by a button comes back.
        let flatLan = lan.components(separatedBy: .whitespacesAndNewlines).joined()
        guard let resolve = flatLan.range(
                of: "letmode=LegacyLane.mode(peerAnnouncesText:live.announcesLegacyText,"
                    + "hasArmedBatch:false)"),
              let claim = flatLan.range(
                of: lanClaims[0].components(separatedBy: .whitespacesAndNewlines).joined(),
                range: resolve.upperBound..<flatLan.endIndex) else {
            return XCTFail("the LAN legacy start no longer resolves its lane from evidence")
        }
        XCTAssertLessThan(resolve.lowerBound, claim.lowerBound)
        XCTAssertFalse(lan.contains("mode: .text"),
                       "the same-network screen names a lane at connect time again")
        XCTAssertFalse(lan.contains("mode: .files"),
                       "the same-network screen names a lane at connect time again")
        // Every start is behind one. A bare `Task { await` that no claim
        // precedes is the regression this counts.
        XCTAssertEqual(occurrences(of: "presence.beginSession(", in: lan),
                       lanClaims.count + 1,
                       "a LAN start path exists with no ownership claim, or the reverse")
        XCTAssertEqual(occurrences(of: "presence.beginSession(", in: cross), 2,
                       "a pairing start path exists with no ownership claim, or the reverse")
        XCTAssertEqual(occurrences(of: crossClaims[0], in: cross), 2,
                       "\(crossConnect) can start a shared model after losing ownership")
        // Neither screen may claim the other's route.
        XCTAssertFalse(lan.contains("beginSession(.pairingCode"),
                       "the same-network screen claims the pairing-code route")
        XCTAssertFalse(cross.contains("beginSession(.nearby"),
                       "the pairing-code screen claims the same-network route")
    }

    /// One Connect verb, and the snapshot rule it inherited unchanged.
    ///
    /// The code is read once, validated, and then only the local `code` is used.
    /// The field stays editable until the asynchronous start publishes state, so
    /// reading it again inside the `Task` would turn one valid click into a
    /// different or incomplete code.
    func testPairingJoinSnapshotsAValidatedCodeBeforeClaimAndTask() throws {
        let source = try source(named: crossConnect)
        XCTAssertTrue(source.contains("let code = fileModel.joinCode"))
        XCTAssertTrue(source.contains("guard fileModel.canJoin else { return }"))
        // The join itself runs inside `watch`'s fallback closure — the room is
        // watched for a `link/1` peer first. That closure lives in
        // `PairingCodeStart` now, shared with the expired-code surface's mint,
        // so the snapshot is read HERE and spent THERE.
        XCTAssertTrue(source.contains("PairingCodeStart(module: module).joinAndWatch(code: code)"),
                      "the join no longer goes through the one watched-room path")
        // `self.source`, because the local binding above shadows the method.
        XCTAssertTrue(try self.source(named: "Transfer/PairingCodeStart.swift")
            .contains("await fileModel.join(code: code)"),
                      "the legacy fallback lost its join")
        for model in ["fileModel", "textModel"] {
            XCTAssertFalse(source.contains("\(model).join(code: \(model).joinCode)"),
                           "the join reads mutable input after taking ownership")
        }
        // And there is exactly ONE of them. A second join verb would be the
        // removed kind-question wearing a different label.
        XCTAssertEqual(occurrences(of: "private func join()", in: source), 1)
        XCTAssertFalse(source.contains("func join(mode:"),
                       "joining asks which kind again")
    }

    /// **One field, both models.** The two join verbs share a code, so the
    /// binding writes both models in the one state transition. Writing only one
    /// would leave the two buttons disagreeing about which code this device is
    /// about to join — the same class of drift the old two-pane split had, moved
    /// one level down and made unrepresentable instead.
    func testPairingJoinNormalizesAtomicallyInBothModes() throws {
        let source = try source(named: crossConnect)
        XCTAssertTrue(source.contains("private var normalizedJoinCode: Binding<String>"))
        XCTAssertTrue(source.contains("fileModel.updateJoinCode($0)"))
        XCTAssertTrue(source.contains("textModel.updateJoinCode($0)"))
        XCTAssertTrue(source.contains("text: normalizedJoinCode"))
        XCTAssertTrue(source.contains(".accessibilityIdentifier(\"pairing.joinCode\")"))
        XCTAssertEqual(occurrences(of: "TextField(L10n.t(.commonCode)", in: source), 1,
                       "one code, one field: two would be two answers to one question")
        for stale in [".onChange(of: fileModel.joinCode)", ".onChange(of: textModel.joinCode)"] {
            XCTAssertFalse(source.contains(stale),
                           "the join field can overwrite fast input with an older partial value")
        }
        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("testCrossNetworkJoinKeepsACompleteCodeActionable"))
        XCTAssertTrue(ui.contains("window.textFields[\"pairing.joinCode\"]"))
    }

    func testAccountSubmitSnapshotsTheWholeFormBeforeStartingAsyncWork() throws {
        let login = try source(named: "LoginView.swift")
        XCTAssertTrue(login.contains("let submitted = draft"))
        for field in ["submitted.email", "submitted.password", "submitted.displayName"] {
            XCTAssertTrue(login.contains(field), "account submission lost \(field)")
        }
        XCTAssertTrue(login.contains("SignInPresentation.problem(in: submitted)"))
        XCTAssertFalse(login.contains("session.logIn(email: draft.email"))
        XCTAssertFalse(login.contains("session.register(email: draft.email"))
    }

    /// Everything a Create must settle SYNCHRONOUSLY, in order: expand and open
    /// the batch the user picked (a useless code for an unreadable selection is
    /// worse than a refusal), re-read live access, claim ownership, and only
    /// then start async work.
    ///
    /// One `createCode()` — no argument, because there is nothing left to ask —
    /// so the ordering is stated once instead of twice with a chance to disagree.
    func testPairingCreateSettlesIntentBeforeStartingAsyncMint() throws {
        let connect = try source(named: crossConnect)
        XCTAssertTrue(connect.contains(
            "Button(L10n.t(.workspaceCreatePairingCode)) { createCode() }"))
        // The account is re-read and the surface is claimed, both SYNCHRONOUSLY,
        // before the asynchronous mint starts. There is no staging step between
        // them any more — that is the connect-first removal, and its absence is
        // asserted below rather than merely unmentioned.
        guard let create = connect.range(of: "private func createCode() {"),
              let access = connect.range(of: "guard let access = accessNow() else {",
                                         range: create.lowerBound..<connect.endIndex),
              let claim = connect.range(of:
                "guard presence.beginSession(route, mode: .files) else { return }",
                range: access.lowerBound..<connect.endIndex),
              let task = connect.range(
                of: "Task { await mintAndWatch(token: access.token) }",
                range: claim.lowerBound..<connect.endIndex) else {
            return XCTFail("code creation lost its synchronous intent boundary")
        }
        XCTAssertLessThan(claim.lowerBound, task.lowerBound)
        // A code needs nothing staged, and that is now structural: there is no
        // selection on this screen to be conditional on, and no disabled state
        // that could depend on one.
        XCTAssertFalse(connect.contains("if !selection.isEmpty {"),
                       "creating a code reads a staged batch again")
        XCTAssertFalse(connect.contains(".disabled(selection.isEmpty"),
                       "the create action is gated on a staged batch again")
        XCTAssertTrue(connect.contains(".disabled(sessionLocked)"),
                      "the create action lost the one lock that may stop it")
    }

    /// Account gating is presentation, not authorization. A button from the
    /// preceding render may still be delivered after sign-out or credential
    /// replacement, so every authenticated macOS start re-reads live access.
    func testAuthenticatedMacStartsDoNotSpendRenderTimeCredentials() throws {
        let destination = try source(named: crossDestination)
        XCTAssertTrue(destination.contains("AccountGate.from(session.state,"))
        XCTAssertEqual(occurrences(of: "accessNow: { accessNow }", in: destination), 1,
                       "one surface, one live-access seam")

        let connect = try source(named: crossConnect)
        XCTAssertTrue(connect.contains("let accessNow: () -> AccountAccess?"))
        XCTAssertTrue(connect.contains("guard let access = accessNow() else {"))
        XCTAssertFalse(connect.contains("AccountGate.from("),
                       "the pane must render the gate it was handed, not compute a second one")

        let upload = try source(named: "UploadPane.swift")
        XCTAssertTrue(upload.contains("@EnvironmentObject private var session: AccountSession"))
        XCTAssertTrue(upload.contains(
            "guard let token = session.bearerToken, !token.isEmpty,"))
        XCTAssertTrue(upload.contains(
            "case .allowed = AccountGate.from(session.state, bearer: token) else"))
        XCTAssertEqual(occurrences(of: "model.start(token:", in: upload), 1)
    }

    func testStalePairingCreateRoutesToTheAccountRemedy() throws {
        let pane = try source(named: crossConnect)
        let staleGate = try XCTUnwrap(pane.components(
            separatedBy: "guard let access = accessNow() else {").dropFirst().first?
            .components(separatedBy: "return").first)
        XCTAssertTrue(staleGate.contains("navigation.selectAccount(intent: .signIn)"),
                      "the pairing screen silently swallowed a stale Create activation")
    }

    /// The document-type declaration that makes the app a Dock drop target and a
    /// Finder "Open With" entry — and the one line that keeps it from becoming
    /// the Mac's default handler for every file on disk.
    ///
    /// `LSHandlerRank` = `Alternate` is not boilerplate, and it is asserted from
    /// a measurement. This entry shipped at `None`, and on 2026-08-07 the owner
    /// installed the notarized 1.0 build and found that Finder's Open With menu
    /// did not list Relayium at all; the installed plist named `None` as the
    /// cause. `None` excludes the app from the menu rather than reserving it for
    /// an explicit choice, so the earlier version of this guard asserted the
    /// wrong string for the right reason.
    ///
    /// `Alternate` is the rank that makes Relayium an explicit secondary
    /// candidate. `Owner` is rejected below: the declared types are
    /// `public.data` and `public.folder` deliberately, because "send this" is not
    /// a format question, and at `Owner` that breadth would offer Launch Services
    /// a default handler for everything — a utility that opened the user's
    /// documents instead of their editor is a support incident. Nothing at
    /// runtime would reveal either regression; it is a plist string.
    func testTheAppIsOfferedForEveryFileWithoutClaimingToOwnAnyType() throws {
        let plist = try String(contentsOf: macRoot.appendingPathComponent("Info.plist"),
                               encoding: .utf8)
        let flat = flattened(plist)
        XCTAssertTrue(plist.contains("<key>CFBundleDocumentTypes</key>"),
                      "without a document type there is no Dock drop target and no Open With")
        for type in ["public.data", "public.folder"] {
            XCTAssertTrue(plist.contains("<string>\(type)</string>"),
                          "\(type) is missing; that half of what a user can send is unreachable")
        }
        XCTAssertTrue(flat.contains("<key>LSHandlerRank</key> <string>Alternate</string>"),
                      "Alternate is what puts Relayium in Finder's Open With as a secondary candidate")
        XCTAssertFalse(flat.contains("<key>LSHandlerRank</key> <string>None</string>"),
                       "None was measured on the installed 1.0 build to exclude Relayium from Open With")
        XCTAssertFalse(flat.contains("<key>LSHandlerRank</key> <string>Owner</string>"),
                       "Owner would claim the default handler for every file and folder on the Mac")
        XCTAssertFalse(plist.contains("<string>Editor</string>"),
                       "Relayium never writes back to what it is given")
        XCTAssertTrue(flat.contains("<key>CFBundleTypeRole</key> <string>Viewer</string>"),
                      "Viewer is the other half of not owning these types")
    }

    // MARK: - the Share extension is a second TARGET, and a second process

    private var macShareRoot: URL { appsRoot.appendingPathComponent("mac/RelayiumShare") }

    /// The extension stages files and stops. Every symbol below is an absence,
    /// and an absence has no runtime to observe — so it is asserted here.
    ///
    /// The entitlements enforce the same thing from the other side: with no
    /// network entitlement at all a request added here would be refused by the
    /// sandbox. Both halves exist because either alone can be edited away.
    func testTheMacShareExtensionCarriesNoAccountNetworkOrCrypto() throws {
        let sources = try sources(under: macShareRoot, atLeast: 2)
        for forbidden in ["URLSession", "URLRequest", "AccountSession", "bearerToken",
                          "TokenStore", "Keychain", "CloudUploader", "SecItem",
                          "RealtimeSessionModel", "AppEnvironment"] {
            for file in sources {
                XCTAssertFalse(file.text.contains(forbidden),
                               "\(file.name) reaches for \(forbidden); the extension only stages")
            }
        }
    }

    /// A Share extension may not open its containing app, and there is no
    /// half-measure that counts as not doing it.
    func testTheMacShareExtensionNeverTriesToOpenTheApp() throws {
        for file in try sources(under: macShareRoot, atLeast: 2) {
            for attempt in ["extensionContext?.open", "NSWorkspace", "NSApplication.shared",
                            "NSApp", "openURL", "NSPasteboard", "relayium://"] {
                XCTAssertFalse(file.text.contains(attempt),
                               "\(file.name) tries to reach the app: \(attempt)")
            }
        }
    }

    /// Exactly two entitlements, and the App Group is the macOS one.
    ///
    /// iOS's `group.com.relayium.app` is **not** authorized by the macOS
    /// profiles, and Apple documents the macOS form as team-prefixed. A mismatch
    /// is the failure that looks like everything working: the sheet stages a
    /// draft into one container and the app lists an empty one.
    func testTheMacShareEntitlementsAreExactlyTheSandboxAndOneGroup() throws {
        let data = try Data(contentsOf: macShareRoot
            .appendingPathComponent("RelayiumShare.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertEqual(plist.keys.sorted(),
                       ["com.apple.security.app-sandbox",
                        "com.apple.security.application-groups"],
                       "the extension claims a capability it does not use: \(plist.keys.sorted())")
        XCTAssertEqual(plist["com.apple.security.app-sandbox"] as? Bool, true)
        XCTAssertEqual(plist["com.apple.security.application-groups"] as? [String],
                       [AppGroup.macOSIdentifier])
        XCTAssertEqual(AppGroup.macOSIdentifier, "7PVYUG4YQS.com.relayium.shared")
        XCTAssertNotEqual(AppGroup.macOSIdentifier, AppGroup.iOSIdentifier,
                          "iOS's group is not authorized by the macOS profiles")
    }

    /// The containing app must be in the same group, or the extension writes
    /// into a container the app cannot read — a runtime failure with no
    /// build-time symptom.
    func testTheAppJoinsTheSameGroupAsItsExtension() throws {
        let data = try Data(contentsOf: macRoot.appendingPathComponent("Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertEqual(plist["com.apple.security.application-groups"] as? [String],
                       [AppGroup.macOSIdentifier])
    }

    /// The activation rule decides where this appears. A `TRUEPREDICATE` would
    /// offer Relayium for a selected sentence, a URL and a contact — none of
    /// which it can stage.
    func testTheMacShareExtensionOffersItselfOnlyWhereItWorks() throws {
        let data = try Data(contentsOf: macShareRoot.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        let ext = try XCTUnwrap(plist["NSExtension"] as? [String: Any])
        XCTAssertEqual(ext["NSExtensionPointIdentifier"] as? String, "com.apple.share-services")
        // A principal class, not a storyboard: a storyboard puts this surface in
        // a file no test can read and no localization guard can scan.
        XCTAssertEqual(ext["NSExtensionPrincipalClass"] as? String,
                       "$(PRODUCT_MODULE_NAME).ShareViewController")
        XCTAssertNil(ext["NSExtensionMainStoryboard"])
        let attributes = try XCTUnwrap(ext["NSExtensionAttributes"] as? [String: Any])
        let rule = try XCTUnwrap(attributes["NSExtensionActivationRule"] as? [String: Any],
                                 "a dictionary rule, never TRUEPREDICATE")
        // The aggregate is what makes the total the same bound as the per-type
        // maxima; without it a mixed share satisfies all three and delivers 3x.
        for key in ["NSExtensionActivationSupportsAttachmentsWithMaxCount",
                    "NSExtensionActivationSupportsFileWithMaxCount",
                    "NSExtensionActivationSupportsImageWithMaxCount",
                    "NSExtensionActivationSupportsMovieWithMaxCount"] {
            XCTAssertEqual(rule[key] as? Int, SHARED_DRAFT_MAX_FILES,
                           "\(key) must be the manifest bound the product enforces")
        }
        for absent in ["NSExtensionActivationSupportsText",
                       "NSExtensionActivationSupportsWebURLWithMaxCount",
                       "NSExtensionActivationSupportsWebPageWithMaxCount"] {
            XCTAssertNil(rule[absent],
                         "sharing a link or a paragraph would produce a file nobody asked for")
        }
        // `installd`'s equivalent on macOS is less loud, but the Share menu shows
        // this string and `CFBundleName` is the target name, not the product.
        XCTAssertEqual(plist["CFBundleDisplayName"] as? String, "Relayium")
        XCTAssertEqual(plist["CFBundleLocalizations"] as? [String],
                       ["en", "zh-Hans", "ja", "ko", "de", "fr", "ar", "es", "pt"],
                       "an appex has its own bundle, so it needs its own localization list")
    }

    /// The app collects staged drafts through the SAME router an Open With uses.
    /// Two routes into the send flow are two places the rules can disagree.
    func testStagedDraftsEnterThroughTheOpenedFilesRouter() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("SharedDraftInbox(store: AppEnvironment.makeSharedDraftStore())"))
        XCTAssertEqual(occurrences(of: "fileOpens.open(sharedDrafts.collect())", in: app), 2,
                       "collected on first appearance AND on every return to active")
        XCTAssertTrue(app.contains(".onChange(of: scenePhase) { phase in"),
                      "sharing while the app is already running never re-runs a task")
    }

    // MARK: - the settings scene

    /// ⌘, exists, is a real `Settings` scene, and owns nothing it should not.
    func testSettingsIsASceneAndTheSystemTouchIsOneFile() throws {
        let all = try sources(under: macRoot, atLeast: 20)
        let app = try source(named: "RelayiumApp.swift")

        // A `Settings` scene, not a window opened from a hand-rolled menu item:
        // only the scene gets the standard app-menu placement and ⌘,.
        XCTAssertEqual(occurrences(of: "Settings {", in: app), 1,
                       "there is exactly one settings scene")
        XCTAssertTrue(app.contains("SettingsView(updates: updates)"),
                      "the settings scene must drive the app's one updater, not a second")
        // And the scene builds exactly one of them, through the seam, so
        // neither product can end up with a second updater object.
        XCTAssertEqual(occurrences(of: "AppUpdates()", in: app), 1,
                       "the scene owns more than one update mechanism")
        XCTAssertFalse(app.contains("import Sparkle"),
                       "shared scene source must not import the direct build's updater")
        // Same resolved direction as the other two scene roots. The catalogs
        // live in a package bundle, so SwiftUI does not mirror Arabic on its own
        // — a settings window left out of this is the one Arabic screen laid out
        // left to right.
        XCTAssertEqual(occurrences(of: ".environment(\\.layoutDirection, appLayoutDirection)",
                                   in: app), 3,
                       "every macOS scene root must set the resolved layout direction")

        // `SMAppService` acts on `Bundle.main`, so exactly one file may touch it
        // and that file holds no decisions — otherwise a package test, or a
        // second call site, registers whoever's Mac runs it as a login item.
        let touching = all.filter { $0.text.contains("SMAppService") }
        XCTAssertEqual(touching.map(\.name), ["Settings/SystemLoginItem.swift"],
                       "SMAppService belongs to one adapter")
        let adapter = try source(named: "Settings/SystemLoginItem.swift")
        // All four statuses answered by name. `@unknown default` is required by
        // the compiler for a non-frozen enum and is the only default allowed;
        // a plain `default` would silently map a future status to something.
        for status in ["case .enabled", "case .notRegistered", "case .requiresApproval",
                       "case .notFound", "@unknown default"] {
            XCTAssertTrue(adapter.contains(status), "SystemLoginItem stopped answering \(status)")
        }
        XCTAssertFalse(adapter.contains("@Published"),
                       "the adapter holds no state; the preference does")
    }

    /// The residency control reports the system, and states every case it
    /// cannot show as a switch.
    ///
    /// It moved out of `SettingsView` this batch: the Device Inbox destination
    /// offers the same control, its copy was a bare `Toggle` greyed out on one
    /// state with no explanation at all, and two renderings of one control is
    /// how the two surfaces started telling the user different things.
    func testTheLoginSettingReportsTheSystemAndExplainsEveryStateItCannotShow() throws {
        let control = try source(named: "Components/LoginItemSetting.swift")

        // Bound to what macOS says, never to what was requested. A switch built
        // from the requested value snaps to on for a registration macOS is still
        // holding for approval — the app asserting a residency it lacks.
        XCTAssertTrue(control.contains("get: { loginItem.state == .on }"),
                      "the switch must read the system's answer")
        XCTAssertFalse(control.contains("@State private var opensAtLogin"),
                       "a mirrored boolean would drift from the system")

        // Every state that is not a plain on/off says what it is and what
        // resolves it, and each names its own remedy. `unavailable` is gone and
        // is TWO states now: the system reporting no record for a bundle in
        // Applications, which an explicit registration can fix, and a bundle
        // macOS will not manage at all, which only relocation fixes. Reporting
        // them as one told a user whose app was already in Applications to move
        // it there, with no other action on the screen.
        for state in ["case .needsApproval", "case .unconfirmed",
                      "case .unmanagedLocation"] {
            XCTAssertTrue(control.contains(state), "the residency control ignores \(state)")
        }
        for copy in ["settingsLoginNeedsApproval", "settingsLoginUnconfirmed",
                     "settingsLoginUnmanagedLocation", "settingsLoginNotRegistered",
                     "settingsLoginTryRegistration", "settingsLoginStillUnconfirmed",
                     "settingsLoginRefused", "settingsOpenLoginItems"] {
            XCTAssertTrue(control.contains(copy), "\(copy) is never rendered")
        }

        // **No dead disabled toggle.** The two states with no working switch do
        // not render one at all — a greyed switch showing "off" reads as a
        // setting somebody turned off, which is worse than merely dead. They
        // render a non-interactive status line and their own action instead.
        XCTAssertTrue(control.contains("if loginItem.offersToggle {"),
                      "the switch is rendered without asking whether it can work")
        XCTAssertFalse(control.contains(".disabled("),
                       "a disabled residency control is the dead end this replaced")
        XCTAssertTrue(control.contains("StatusBadge(symbol:"),
                      "the states with no switch have no state indicator either")

        // The registration attempt is EXPLICIT, offered only where it can work,
        // and its unconfirmed outcome is reported rather than smoothed over.
        XCTAssertTrue(control.contains("Button(L10n.t(.settingsLoginTryRegistration)) "
                                       + "{ loginItem.attemptRegistration() }"),
                      "the unconfirmed state has no way forward")
        XCTAssertTrue(control.contains("if loginItem.lastRegistrationUnconfirmed {"),
                      "a registration that stayed unconfirmed says nothing")
        let unmanaged = try XCTUnwrap(control.components(separatedBy: "case .unmanagedLocation:")
            .dropFirst().first?.components(separatedBy: "case .on, .off:").first)
        XCTAssertFalse(unmanaged.contains("attemptRegistration"),
                       "a bundle macOS will not manage is offered a button that always fails")

        // The user can change this in System Settings while the app runs and
        // nothing notifies it, so both hosts re-ask when they appear.
        for host in ["Settings/SettingsView.swift",
                     "DeviceInbox/DeviceInboxSurface.swift"] {
            XCTAssertTrue(try source(named: host).contains("loginItem.refresh()"),
                          "\(host) must re-read the system when it appears")
        }
    }

    /// **One residency control, rendered by both surfaces that offer it.**
    ///
    /// The Device Inbox destination's copy was a `Toggle` with
    /// `.disabled(state == .unavailable)` and a caption — the same dead switch
    /// the settings pane had already learned to explain, kept alive by being
    /// written twice. Whatever the component shows for a state, both now show.
    func testTheResidencyControlIsOneComponentOnBothSurfaces() throws {
        let hosts = try sources(under: macRoot, atLeast: 30)
            .filter { $0.text.contains("LoginItemSetting()") }.map(\.name).sorted()
        XCTAssertEqual(hosts, ["DeviceInbox/DeviceInboxSurface.swift",
                               "Settings/SettingsView.swift"],
                       "the residency control has gained or lost a host")
        // Neither host may render any part of it itself. `settingsOpenAtLogin`
        // is the label, and a host naming it is a host with its own switch.
        for host in hosts {
            let text = try source(named: host)
            for reimplemented in ["settingsOpenAtLogin", "loginItem.set(",
                                 "loginItem.state ==", "loginItem.attemptRegistration",
                                 "settingsOpenLoginItems"] {
                XCTAssertFalse(text.contains(reimplemented),
                               "\(host) renders \(reimplemented) instead of sharing the control")
            }
        }
        // And the component is the only place that decides any of it.
        let owners = try sources(under: macRoot, atLeast: 30)
            .filter { $0.text.contains("loginItem.set(") }.map(\.name)
        XCTAssertEqual(owners, ["Components/LoginItemSetting.swift"],
                       "a second surface writes the login-item registration")
    }

    /// The updates pane says what the old lone menu item could not, and reads
    /// every one of those facts from the thing that owns it.
    ///
    /// It reads `Distribution/DirectDistribution.swift`, which is where the pane
    /// lives now: the settings window became shared source when the App Store
    /// target started compiling it, and Sparkle is the direct build's alone.
    func testTheUpdatesPaneReadsSparkleAndTheBundleRatherThanRestatingThem() throws {
        let settings = try source(named: "Distribution/DirectDistribution.swift")
        XCTAssertTrue(settings.contains("updater.automaticallyChecksForUpdates = $0"),
                      "the toggle must write through to Sparkle")
        XCTAssertTrue(settings.contains("lastCheck = updater.lastUpdateCheckDate"),
                      "the timestamp must be read back from Sparkle, not stamped locally")
        XCTAssertTrue(settings.contains("settingsNeverChecked"),
                      "a fresh install has never checked, and a blank line reads as a bug")

        // Read from the bundle. A literal here survives a version bump and then
        // tells every bug reporter the wrong number.
        for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
            XCTAssertTrue(settings.contains(key), "the version row must read \(key)")
        }
        XCTAssertFalse(settings.contains("\"1.0\""),
                       "the displayed version must not be hard-coded")
    }

    // MARK: - the sidebar's live-session marker

    /// The marker has to answer "is the running session presented *here*", and
    /// only `TransferPresence` knows that.
    ///
    /// `NearbyReceiveModel.activeKind` answers a different question — "is an
    /// unsolicited nearby receive in progress" — and gets three cases wrong: a
    /// pairing-code session is never marked at all, an outbound nearby send is
    /// never marked because nothing arrived, and a nearby receive that has ended
    /// while its result is still on screen keeps the marker after presence has
    /// let go. Deriving it from `rendersSession(_:)` makes the sidebar mark
    /// whichever destination is actually drawing the session, which is the same
    /// fact the two direct destinations use to decide who draws it.
    /// The marker needs BOTH facts, and each from the object that owns it.
    ///
    /// Ownership decides which row draws the session and outlives the transfer,
    /// because a `.completed` receive keeps its result view. Whether bytes are
    /// moving is the models' answer. Marking on ownership alone left
    /// `nav.a11yLiveSession` — "A transfer is running here" — on a row whose
    /// transfer had finished; marking on the models alone would mark both direct
    /// rows at once.
    ///
    /// The negative half is the load-bearing one: `announcesRunningTransfer`
    /// takes the busy fact as a parameter precisely so no second copy of it can
    /// exist, and a stored flag on `TransferPresence` is the regression this
    /// guard exists to catch.
    func testTheSidebarMarksOnlyARunningSessionOnTheRowThatOwnsIt() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        XCTAssertTrue(sidebar.contains("presence.announcesRunningTransfer("),
                      "the live marker must be derived through TransferPresence")
        XCTAssertTrue(sidebar.contains("sessionIsBusy: module.isBusy"),
                      "activity must come from the session models, not from a cached flag")
        XCTAssertTrue(try appKitSource(named: "TransferModule.swift")
            .contains("public var isBusy: Bool { files.isBusy || text.isBusy }"),
                      "the module caches activity instead of asking its models")
        // One route per row again, and BOTH facts come from that row's own
        // module — so the marked row is the one the session is actually on, and
        // two rows can be marked at once because two modules really can be
        // running at once.
        XCTAssertTrue(sidebar.contains(
            "guard let module = modules.module(for: surface.route) else { return false }"),
            "the live marker is no longer derived from the row's own module")
        XCTAssertTrue(sidebar.contains(
            "module.presence.announcesRunningTransfer(surface.route,"),
            "the live marker is no longer derived from the row's own route")
        XCTAssertFalse(sidebar.contains("macWorkspaceRoutes"),
                       "a row still asks about a route it does not render")
        XCTAssertFalse(sidebar.contains("surface == .storedSend"),
                       "the marker must not be hard-coded to one surface")
        XCTAssertFalse(sidebar.contains("receive.activeKind"),
                       "NearbyReceiveModel keeps residency and loses the session marker")
        // The sidebar no longer reads `NearbyReceiveModel` at all: residency is
        // reported once, by the LAN pane that also owns Pause and Resume. See
        // `testResidencyIsReportedOnceByThePaneThatCanActOnIt`. The negative is
        // asserted here too so the two facts cannot be re-merged from this end.
        XCTAssertFalse(sidebar.contains("receive.state"),
                       "the sidebar is reading same-network residency again")

        let presence = try String(
            contentsOf: appsRoot.appendingPathComponent(
                "RelayiumKit/Sources/RelayiumAppKit/TransferPresence.swift"), encoding: .utf8)
        for duplicated in ["isTransferring", "setTransferring", "var isBusy"] {
            XCTAssertFalse(presence.contains(duplicated),
                           "TransferPresence must stay ownership-only: \(duplicated) duplicates "
                           + "a fact RealtimeSessionModel already owns")
        }
    }

    /// Colour is never the only carrier — the round's accessibility rule, and the
    /// sidebar row is the one place it would be easiest to break, because a tint
    /// on a `Label` looks like enough on the screen of whoever wrote it.
    func testTheLiveSessionMarkerIsASymbolAndKeepsItsLocalizedLabel() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        XCTAssertTrue(sidebar.contains("Image(systemName: liveSessionSymbol)"),
                      "a live row must be marked by a symbol, not by colour alone")
        XCTAssertTrue(sidebar.contains("navA11yLiveSession"),
                      "the localized accessibility label must survive")
        XCTAssertTrue(sidebar.contains(".accessibilityHint(subtitle)"),
                      "the row's hint is still its subtitle")
    }

    /// The comment that said presence was still to come. It described the tree
    /// for exactly one task and then became a claim that the thing it points at
    /// does not exist — which is the kind of stale comment a reader trusts.
    func testTheSidebarNoLongerCallsPresenceFutureWork() throws {
        let raw = try rawSource(named: "Shell/SidebarView.swift")
        XCTAssertFalse(raw.contains("arrives with `TransferPresence`"),
                       "TransferPresence is in the tree; the comment saying it is not must go")
    }

    // MARK: - keyboard defaults

    /// Design § Accessibility: "Primary action per destination carries
    /// `.keyboardShortcut(.defaultAction)`." Four primaries had no keyboard path
    /// at all, so Return did nothing on the two destinations a keyboard user
    /// reaches first.
    /// **One verb on a chosen device, and it has no precondition at all.**
    ///
    /// It replaced the message-first pair — `Send a message` prominent, `Send
    /// files` bordered and disabled until something was staged — which between
    /// them asked what to send and which of two things the connection could be,
    /// both before there was a peer. Connect-first has neither question, so
    /// there is nothing left to order and nothing left to disable: the one thing
    /// this screen can do is open a connection to the device the user picked.
    ///
    /// The negatives are the load-bearing half. Either retired verb reappearing
    /// is pre-connect intent, and `selection` appearing at all is pre-connect
    /// staging.
    func testTheLanScreenOffersOneConnectVerbWithNoPrecondition() throws {
        let connect = try source(named: lanConnect)
        let connectAction = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceConnectToDevice)) { connect(to: device) }"))
        let styling = String(connect[connectAction.upperBound...].prefix(200))
        XCTAssertTrue(styling.contains(".buttonStyle(.borderedProminent)"),
                      "the one verb on a chosen device is not the prominent one")
        XCTAssertTrue(styling.contains(".disabled(sessionLocked)"),
                      "the connect verb ignores the one lock that may stop it")
        XCTAssertFalse(styling.contains("selection"),
                       "the connect verb requires something staged")
        XCTAssertEqual(occurrences(of: "Button(L10n.t(", in: connect
            .components(separatedBy: "private func actions(for device: NearbyDevice)")
            .dropFirst().first ?? ""), 1,
            "the chosen-device section grew a second verb")

        // The pair it replaced, by name, in copy and in behaviour.
        for retired in ["workspaceSendMessage", "workspaceSendFiles", "workspaceAddFilesHint",
                        "nearbySelectionSendHint", "startMessage(", "sendFiles("] {
            XCTAssertFalse(connect.contains(retired),
                           "the LAN screen offers a pre-connect intent again: \(retired)")
        }
        // And no staged selection anywhere on it — not a store, not a summary,
        // not an expansion.
        for staging in ["selection", "SelectionStore", "stageRealtimeFiles(", "stageSend("] {
            XCTAssertFalse(connect.contains(staging),
                           "the LAN screen stages before connecting again: \(staging)")
        }

        // **Removing the question did not turn into answering it here.**
        //
        // The pre-connect pair let the user pick the legacy generation; the one
        // verb has to get that answer from somewhere, and the only honest source
        // is the peer's own announcement, which the roster already holds. A
        // screen that hard-coded `.files` instead would compile, pass every
        // other assertion in this file, and hand a legacy TEXT peer a file
        // offer it never answers — the exact silent failure `LegacyLane` was
        // extracted to prevent. So the call is pinned whole: this surface asks
        // `LegacyLane.mode`, with THIS device's announcement, and with no armed
        // batch, because a connect-first screen has nothing that could arm one.
        XCTAssertTrue(connect.components(separatedBy: .whitespacesAndNewlines).joined()
            .contains("LegacyLane.mode(peerAnnouncesText:live.announcesLegacyText,hasArmedBatch:false)"),
            "the LAN screen decides the legacy lane without asking the peer")
        // And it acts on the answer rather than computing and discarding it: the
        // claim and both starts are keyed on the same `mode`.
        XCTAssertTrue(connect.contains("presence.beginSession(route, mode: mode, peerLabel: live.label)"),
                      "the claimed session mode is not the one the peer's announcement chose")

        // Every verb carries a stable runtime identity, and the two screens'
        // identities are DISJOINT — which is how the UI suite proves that each
        // connection method is on its own destination rather than both on one.
        let cross = try source(named: crossConnect)
        for identifier in ["lan-connect-device"] {
            XCTAssertTrue(connect.contains(".accessibilityIdentifier(\"\(identifier)\")"),
                          "the LAN screen lost its \(identifier) control")
            XCTAssertFalse(cross.contains(identifier),
                           "the pairing screen offers a same-network control: \(identifier)")
        }
        for identifier in ["cross-network-create-code", "cross-network-join-code",
                           "cross-network-explain"] {
            XCTAssertTrue(cross.contains(".accessibilityIdentifier(\"\(identifier)\")"),
                          "the pairing screen lost its \(identifier) control")
            XCTAssertFalse(connect.contains(identifier),
                           "the LAN screen offers a pairing control: \(identifier)")
        }
        // **And the four it replaced are gone by name.** An identifier is the
        // one part of a removed product choice that survives a visual review:
        // a UI test, a screenshot script or a later edit can reintroduce
        // "create a code for messages" without a single word of copy changing.
        for retired in ["cross-network-create-message-code", "cross-network-create-file-code",
                        "cross-network-join-messages", "cross-network-join-files",
                        "cross-network-join-kind-hint"] {
            XCTAssertFalse(cross.contains(retired),
                           "the pairing screen still exposes a kind choice: \(retired)")
        }
        // The dormant staging section keeps its identifiers so a re-enable
        // restores the runtime handles rather than inventing new ones — and
        // neither live screen may carry them.
        let staging = try source(named: transferStaging)
        for identifier in ["transfer-choose-files", "transfer-staging-optional"] {
            XCTAssertTrue(staging.contains(".accessibilityIdentifier(\"\(identifier)\")"),
                          "the dormant staging section lost its \(identifier) control")
            XCTAssertFalse(connect.contains(identifier),
                           "the LAN screen exposes pre-connect staging: \(identifier)")
            XCTAssertFalse(cross.contains(identifier),
                           "the pairing screen exposes pre-connect staging: \(identifier)")
        }
        // Neither screen names the other's connection method at all. This is the
        // owner's correction stated as a source property: one destination, one
        // connection method, and no second way of connecting beside it.
        for banned in ["workspacePairingHeading", "createControls", "joinControls",
                       "pairing.joinCode"] {
            XCTAssertFalse(connect.contains(banned),
                           "the LAN screen still offers the pairing method: \(banned)")
        }
        for banned in ["workspaceSameNetworkHeading", "discovery.", "roster", "deviceRow"] {
            XCTAssertFalse(cross.contains(banned),
                           "the pairing screen still offers same-network discovery: \(banned)")
        }

        // **The pairing screen has no message-or-files lead, because it has no
        // message-or-files question.** Create comes before Connect, which is the
        // only ordering claim left on it: one action, then the other.
        let create = try XCTUnwrap(cross.range(
            of: "Button(L10n.t(.workspaceCreatePairingCode)) { createCode() }"))
        let connectVerb = try XCTUnwrap(cross.range(
            of: "Button(L10n.t(.workspaceConnectWithCode)) { join() }"))
        XCTAssertLessThan(create.lowerBound, connectVerb.lowerBound)
        XCTAssertEqual(occurrences(of: "createCode()", in: cross), 2,
                       "one Create action, called from exactly one control")
        XCTAssertEqual(occurrences(of: "{ join() }", in: cross), 1,
                       "one Connect action, called from exactly one control")
    }

    /// **Exactly one create action and one join action, and no residue of the
    /// four they replaced.**
    ///
    /// The removed distinction is the kind of thing that comes back a piece at a
    /// time — a hint sentence, an accessibility identifier, a `mode:` argument —
    /// so this asserts the absence of every name it had, in the copy, in the
    /// source and in the link the screen hands over.
    func testTheCrossNetworkScreenOffersOneCreateAndOneJoinAndNoKindChoice() throws {
        let cross = try source(named: crossConnect)

        // One of each control, by identifier.
        for identifier in ["cross-network-create-code", "cross-network-join-code"] {
            XCTAssertEqual(occurrences(of: ".accessibilityIdentifier(\"\(identifier)\")",
                                       in: cross), 1,
                           "the pairing screen offers \(identifier) more than once")
        }
        // And exactly two `Button(`s in total on the connect surface: create and
        // connect. A third is either a kind choice returning or a control that
        // belongs on a different screen.
        XCTAssertEqual(occurrences(of: "Button(L10n.t(", in: cross), 2,
                       "the pairing screen grew a third action")

        // No retired copy anywhere in the app, not merely on this screen: these
        // keys are gone from `L10nKey`, so a reference would not compile — what
        // this catches is a NEW string reintroducing the same product idea.
        for (name, text) in try sources(under: macRoot, atLeast: 20) {
            for retired in ["createMessageCode", "createFileCode", "joinMessages",
                            "joinFiles", "joinKindHint"] {
                XCTAssertFalse(text.contains(retired),
                               "\(name) reintroduces a pairing-code kind choice: \(retired)")
            }
        }

        // The model takes no kind either. `watchPairingCode` lost its `mode:`
        // parameter, which is what makes "the screen cannot ask" structural
        // rather than a convention this file describes. The call itself lives in
        // `PairingCodeStart` — one implementation for the connect surface's mint
        // and join AND for the expired surface's replacement mint, because three
        // copies is how they would come to disagree about the legacy role.
        let starter = try source(named: "Transfer/PairingCodeStart.swift")
        for pairing in [cross, starter] {
            XCTAssertFalse(pairing.contains("mode: .text"),
                           "the pairing path still names a lane at connect time")
            XCTAssertFalse(pairing.contains("watchPairingCode(code, legacyRole: legacyRole, mode:"),
                           "the room is still watched for one kind")
        }
        XCTAssertTrue(starter.contains("link.watchPairingCode(code,"))
        XCTAssertEqual(occurrences(of: "watchPairingCode(", in: starter), 1,
                       "the shared pairing start watches a room from two places")
        XCTAssertFalse(cross.contains("watchPairingCode("),
                       "the connect surface kept its own copy of the watch")

        // **And nothing that could hold work before there is a peer.**
        //
        // Pairing is ONE workspace, not a Files lane and a Text lane, and a
        // workspace with no connection in it has nothing to offer. The staging
        // section is the exact shape the owner ruled out — a "Files and folders"
        // group beside the two code actions, which reads as a third choice about
        // what kind of thing this code is for.
        for staging in ["TransferStagingSection", "workspaceStagingHeading",
                        "FileDropZone(", "PendingFileList(", "SelectionStore",
                        "selection", "stageRealtimeFiles(", "stageSend("] {
            XCTAssertFalse(cross.contains(staging),
                           "the pairing screen stages before connecting again: \(staging)")
        }
        // The room is watched with an EMPTY batch, by construction rather than
        // by a nil that a caller chose to pass — there is no other batch it
        // could be handed.
        XCTAssertTrue(starter.components(separatedBy: .whitespacesAndNewlines).joined()
            .contains("link.watchPairingCode(code,legacyRole:legacyRole,files:[],sources:[])"),
            "the pairing screen arms a batch before the room has a peer")
        // …and the shared starter stages nothing either, which is the same ban
        // one file further along the path it now owns.
        for staging in ["FileDropZone(", "PendingFileList(", "SelectionStore",
                        "selection", "stageRealtimeFiles(", "stageSend("] {
            XCTAssertFalse(starter.contains(staging),
                           "the shared pairing start stages before connecting: \(staging)")
        }
    }

    // MARK: - connect-first

    /// **The owner's contract for the two real-time surfaces, as one test.**
    ///
    /// A session is established before any file, folder or message exists. Every
    /// clause below is an ABSENCE, and an absence has no runtime to observe — so
    /// it is asserted against the source of both screens at once, because the
    /// rule is the pair's rather than either one's.
    ///
    /// The four things that must not be reachable before a connection:
    ///
    ///  1. a file or folder picker, in any form;
    ///  2. a drop target;
    ///  3. a message composer;
    ///  4. any store that could hold what those produced.
    func testNeitherRealTimeScreenCanStageOrComposeBeforeConnecting() throws {
        for name in [lanConnect, crossConnect] {
            let pane = try source(named: name)
            for forbidden in ["TransferStagingSection", "FileDropZone(", "PendingFileList(",
                              "NSOpenPanel(", "chooseFilesOrFolders(", "chooseForLinkSend(",
                              "TextEditor(", "SelectionStore", "selection",
                              "stageRealtimeFiles(", "stageSend(", "sendNow("] {
                XCTAssertFalse(pane.contains(forbidden),
                               "\(name) can stage or compose before connecting: \(forbidden)")
            }
        }
        // And the destinations that host them hold no staged batch to hand down.
        for name in [lanDestination, crossDestination] {
            XCTAssertFalse(try source(named: name).contains("SelectionStore"),
                           "\(name) still injects a pre-connect staging context")
        }
    }

    /// **Pairing's pre-connect UI is exactly two user choices**, and the owner
    /// named both the two that stay and the shapes that must not come back.
    ///
    /// Counting the controls is what makes this a rule rather than a reading:
    /// two `Button`s on the whole connect surface, one text field, and no third
    /// anything. A "Files and folders" group beside them is the exact thing
    /// ruled out — it reads as a third choice about what kind of thing this code
    /// is for, which is the lane question in a different costume.
    func testThePairingScreenOffersCreateAndEnterCodeAndNothingElse() throws {
        let cross = try source(named: crossConnect)
        XCTAssertEqual(occurrences(of: "Button(L10n.t(", in: cross), 2,
                       "the pairing screen grew a third pre-connect action")
        XCTAssertEqual(occurrences(of: "TextField(", in: cross), 1,
                       "the pairing screen grew a second field")
        XCTAssertTrue(cross.contains("Button(L10n.t(.workspaceCreatePairingCode)) { createCode() }"),
                      "the pairing screen lost Create a pairing code")
        // ONE join action behind the field, and it is inert until the code is
        // complete — six digits are in, or they are not.
        XCTAssertEqual(occurrences(of: "{ join() }", in: cross), 1,
                       "entering a code enables more than one action")
        XCTAssertTrue(cross.contains(".disabled(!fileModel.canJoin || sessionLocked)"),
                      "the join action is live before a complete code is entered")
        // Every lane-shaped heading and verb the owner ruled out, by the copy key
        // that would render it. Checked across the whole macOS target rather than
        // this file, because the way one comes back is a new screen that renders
        // it, not this file growing a line. `transferStaging` is exempt: it is
        // dormant, constructed by nobody, and kept for a future re-enable.
        for (name, text) in try sources(under: macRoot, atLeast: 20) where name != transferStaging {
            for laneShaped in ["workspaceStagingHeading", "workspaceStagingOptional",
                               "workspaceDropHint", "workspaceSendMessage",
                               "workspaceSendFiles", "workspaceAddFilesHint"] {
                XCTAssertFalse(text.contains(laneShaped),
                               "\(name) renders a pre-connect lane choice: \(laneShaped)")
            }
        }
    }

    /// **And after it connects, both kinds of work are reachable.**
    ///
    /// The removal is only honest if the workspace it hands off to can do what
    /// the removed controls promised. Two panes can be on the far side of a
    /// connection and each is checked for what it actually offers:
    ///
    ///  - `TransferLinkPane`, for a peer that announced exact `link/1`: a
    ///    composer AND file/folder sends, on one verified connection.
    ///  - `TransferSessionPane`, for a legacy peer: the lane the wire really
    ///    gave, with the honest note about the other — and, on the file lane, a
    ///    send that a connect-first session could not otherwise ever make.
    func testAConnectedWorkspaceOffersTheWorkTheConnectScreenNoLongerDoes() throws {
        let link = try source(named: "Transfer/TransferLinkPane.swift")
        XCTAssertTrue(link.contains("Button(L10n.t(.linkSend)) { sendDraft() }"),
                      "the unified workspace lost its composer's send")
        XCTAssertTrue(link.contains("accessibilityIdentifier(\"link-composer\")"),
                      "the unified workspace lost its composer")
        XCTAssertTrue(link.contains("Button(L10n.t(.linkSendFile)) { pick(directories: false) }")
                      && link.contains("Button(L10n.t(.linkSendFolder)) { pick(directories: true) }"),
                      "the unified workspace lost a file or folder send")

        // The legacy file lane's own send. Without it a connect-first session
        // against a legacy file peer is an open, verified connection the user
        // cannot put anything on — a dead end this change would have created.
        let session = try source(named: transferSession)
        XCTAssertTrue(session.contains("if fileModel.canSendNow {"),
                      "the legacy file lane offers a send that would be swallowed, or none")
        XCTAssertTrue(session.contains(
            "fileModel.sendNow(sources: staged.sources, metas: staged.metas)"),
            "the legacy file lane's send does not reach the model")
        for identifier in ["transfer-session-send-file", "transfer-session-send-folder"] {
            XCTAssertTrue(session.contains(".accessibilityIdentifier(\"\(identifier)\")"),
                          "the legacy file lane lost its \(identifier) control")
        }
        // The gate is the MODEL's answer, never a second copy of it: a pane that
        // re-derived "is this connection ready" would be the copy that
        // contradicts the model on the frame that matters.
        XCTAssertFalse(session.contains("sasConfirmed"),
                       "the session pane re-derives the model's send readiness")
        XCTAssertEqual(occurrences(of: "canSendNow", in: session), 1,
                       "the post-connect send gate is asked in more than one place")
    }

    /// **The one route out of a file-only legacy lane, and the order it has to
    /// take.**
    ///
    /// `workspace.filesOnlyNote` tells the user a message needs a session of its
    /// own and that leaving this one is how to start it. On a connect-first
    /// pairing surface that instruction could not be followed: the code was
    /// consumed by the file lane and macOS mints one nowhere else, so re-pairing
    /// reproduced the same file lane every time. The route lives beside the
    /// sentence that promises it, and only where the promise can be kept — a
    /// legacy fallback that still holds its rendezvous.
    ///
    /// Four properties, and every one of them has a way to be wrong that looks
    /// fine on screen:
    ///
    ///  1. It is offered ONLY on the file lane of a handed-over pairing room. A
    ///     same-network legacy session has no code to re-enter, and a button
    ///     there would be one that always fails.
    ///  2. The surface is CLAIMED before either lane moves. `TransferPresence`
    ///     gives the surface up the moment every model reads idle, and
    ///     `observeSurfaceIdle` turns that into closing the very room this route
    ///     is about to re-enter.
    ///  3. The old room is RELEASED before the new one is joined. Joining first
    ///     puts two sockets from this process into one two-peer code room and
    ///     spends the address's join budget twice.
    ///  4. It does not restore a pre-pair mode question. The route is reached
    ///     from inside a connected session, never before one.
    func testTheFileOnlyLegacyLaneOffersAMessageSessionOverTheSameCode() throws {
        let session = try source(named: transferSession)

        XCTAssertTrue(session.contains("if mode == .files, let handed = link.handedOverPairing {"),
                      "the message route is offered where its rendezvous may not exist")
        XCTAssertTrue(session.contains(".accessibilityIdentifier(\"transfer-start-message-session\")"),
                      "the message route lost its control")
        XCTAssertTrue(session.contains("L10n.t(.workspaceStartMessageSession)")
                      && session.contains("L10n.t(.workspaceStartMessageSessionHint)"),
                      "the message route lost its label or the sentence that makes it followable")

        let body = session
            .components(separatedBy: "private func startMessageSession(")
            .dropFirst().first ?? ""
        XCTAssertFalse(body.isEmpty, "startMessageSession is gone")
        let claim = body.range(of: "presence.claim(route, mode: .text)")
        let cancel = body.range(of: "fileModel.cancel()")
        let release = body.range(of: "link.releaseHandedOverPairingRoom()")
        let join = body.range(of: "await textModel.join(code: handed.code, role: handed.role)")
        XCTAssertNotNil(claim); XCTAssertNotNil(cancel)
        XCTAssertNotNil(release); XCTAssertNotNil(join)
        if let claim, let cancel, let release, let join {
            XCTAssertLessThan(claim.lowerBound, cancel.lowerBound,
                              "the surface is released mid-route, which closes the room it needs")
            XCTAssertLessThan(cancel.lowerBound, release.lowerBound,
                              "the room is closed under a connection still built on it")
            XCTAssertLessThan(release.lowerBound, join.lowerBound,
                              "two sockets from this process would sit in one code room")
        }

        // The role is the fallback's, not a fresh guess: both ends answering is
        // a session neither dials.
        XCTAssertTrue(body.contains("role: handed.role"),
                      "the message session re-derives a role the room already decided")
        // And nothing here reintroduces a question before there is a peer.
        XCTAssertFalse(session.contains("DirectModeSelection"),
                       "the pre-pair mode picker came back to the session pane")
    }

    /// **A send that lost the race to the picker has to be said out loud.**
    ///
    /// `chooseForLinkSend` is a modal system panel and the session runs
    /// underneath it, so between the press and the files coming back the peer
    /// can start its own transfer or the connection can end. `sendNow` rechecks
    /// and refuses — correctly, because queueing the batch would be the
    /// pre-connect staging this change removed — and the pane it returns to has
    /// already swapped the send controls for progress. So the refusal is the
    /// user's chosen files disappearing unless the pane says otherwise.
    ///
    /// Three things are guarded, and each one alone would let that silence back:
    /// the model's answer is READ, both refusal reasons reach copy of their own,
    /// and the message renders OUTSIDE the `canSendNow` arm — inside it, the
    /// branch the refusal itself flips would take the sentence off screen with
    /// the buttons.
    func testASendRefusedAfterThePickerClosedIsReportedRatherThanSwallowed() throws {
        let session = try source(named: transferSession)
        XCTAssertTrue(session.contains(
            "switch fileModel.sendNow(sources: staged.sources, metas: staged.metas) {"),
            "the pane drops the model's send result, so a raced send is silent again")
        for arm in ["case .sent:",
                    "case .refused(.transferInFlight):",
                    "case .refused(.sessionNotReady):",
                    "case .refused(.invalidFileList):"] {
            XCTAssertTrue(session.contains(arm),
                          "the pane does not dispose \(arm) — a refusal reaches no copy")
        }
        XCTAssertTrue(session.contains("sendError = L10n.t(.workspaceSendRefusedBusy)"),
                      "a session that was already transferring refuses with no sentence")
        XCTAssertTrue(session.contains("sendError = L10n.t(.workspaceSendRefusedUnavailable)"),
                      "a session that ended under the picker refuses with no sentence")
        XCTAssertTrue(session.contains(".accessibilityIdentifier(\"transfer-session-send-error\")"),
                      "the refusal is not reachable to VoiceOver or to a UI test")

        // Rendered once, in the live-session arm, above the `fileSend` the
        // refusal removes — not inside it.
        XCTAssertEqual(occurrences(of: "if let sendError {", in: session), 1,
                       "the refusal message is drawn in more than one place")
        guard let gate = session.range(of: "if fileModel.canSendNow {"),
              let render = session.range(of: "if let sendError {"),
              let fileSendDeclaration = session.range(of: "private var fileSend: some View") else {
            return XCTFail("the session pane no longer has the shape this guards")
        }
        XCTAssertLessThan(gate.lowerBound, render.lowerBound)
        XCTAssertLessThan(render.upperBound, fileSendDeclaration.lowerBound,
                          "the refusal renders inside the arm that a refusal removes")
    }

    /// **Never claim that one legacy connection carries both lanes.**
    ///
    /// The surface is unified; a legacy session is not. Once capability
    /// negotiation has selected that session pane, it names the lane the
    /// connection does NOT have. The connect phase cannot make that claim for a
    /// pairing code whose peer is not known yet.
    func testTheTransferScreensStateTheOneLaneLimitOnlyAfterCapabilityIsKnown() throws {
        let connect = try source(named: crossConnect)
        XCTAssertFalse(connect.contains("one-connection-note"),
                       "the connect phase guesses a pairing peer's capability")

        let session = try source(named: transferSession)
        XCTAssertTrue(session.contains(
            "L10n.t(mode == .text ? .workspaceMessagesOnlyNote : .workspaceFilesOnlyNote)"),
            "a live session no longer names the lane it does not have")
        XCTAssertTrue(session.contains(".accessibilityIdentifier(\"transfer-lane-note\")"))
        XCTAssertTrue(session.contains("if peerCapabilityIsKnown { laneNote }"),
                      "the lane warning is shown before a pairing peer is classified")
        XCTAssertTrue(session.contains("case .idle, .minting, .showingCode, .failed:"),
                      "a no-peer failure is described as a classified legacy connection")
        XCTAssertTrue(session.contains("transfer-waiting-pairing-peer"))
        XCTAssertTrue(session.contains("transfer-cancel-pairing-watch"))
        guard let laneNote = session.range(of: "private var laneNote: some View"),
              let body = session.range(of: "var body: some View"),
              let exit = session.range(of: "\n            exit", range: body.lowerBound..<laneNote.lowerBound),
              let laneContent = session.range(of: "switch mode", range: body.lowerBound..<laneNote.lowerBound),
              let gatedLaneNote = session.range(
                of: "if peerCapabilityIsKnown { laneNote }",
                range: body.lowerBound..<laneNote.lowerBound
              ) else {
            return XCTFail("the session pane no longer has the shape this guards")
        }
        XCTAssertLessThan(body.lowerBound, laneNote.lowerBound)
        XCTAssertLessThan(exit.lowerBound, laneContent.lowerBound,
                          "the exit must remain reachable above long lane content")
        XCTAssertLessThan(laneContent.lowerBound, gatedLaneNote.lowerBound,
                          "the capability-gated note must sit outside either transfer lane")
    }

    /// **The connect phase says the right thing about the DEVICE, not about the
    /// screen.**
    ///
    /// A pairing-code peer is not known on the connect phase, so that section
    /// makes neither claim. A same-network device carries whichever its own
    /// announcement earns, so its note is a branch on `device.supportsLink`.
    ///
    /// The failure this prevents is the tempting one: a single note above both
    /// sections, which is necessarily a stale claim about one of them.
    func testTheConnectPhaseStatesTheRightLimitPerDevice() throws {
        let connect = try source(named: lanConnect)

        // Per device, branching on the peer's own announcement.
        XCTAssertTrue(connect.contains("""
            InlineMessage(.info, L10n.t(device.supportsLink
                                        ? .linkOneConnectionNote
                                        : .workspaceOneConnectionNote))
"""), "the device actions no longer state what THAT device's connection carries")
        XCTAssertTrue(connect.contains(
            ".accessibilityIdentifier(\"lan-device-connection-note\")"))

        // A pairing code has no peer yet, so neither connection-shape claim is
        // made on that screen until negotiation selects a session pane.
        let cross = try source(named: crossConnect)
        XCTAssertFalse(cross.contains("workspaceOneConnectionNote"),
                       "pairing-code setup guessed a legacy peer")
        XCTAssertFalse(cross.contains("linkOneConnectionNote"),
                       "pairing-code setup guessed a link-capable peer")
    }

    /// Create and join sit on one screen, so only one control can be the keyboard
    /// default — two would be undefined, and SwiftUI would pick one of them
    /// without saying which.
    ///
    /// **Join takes it, and the message verb within join.** Its precondition is a
    /// single field whose completion is unambiguous: six digits are in, or they
    /// are not, and `canJoin` says so, so the default is inert until Return means
    /// exactly one thing. Create's precondition is an account, and the
    /// same-network verbs need a chosen device — both sit beside the field a user
    /// is typing a code into, and either as the default would fire on the
    /// keystroke that ends the other one. Prominence still belongs to each card's
    /// own primary; the keyboard default is the narrower claim.
    func testJoinIsTheOnlyKeyboardDefaultOnTheTransferScreens() throws {
        let text = try source(named: crossConnect)
        XCTAssertEqual(occurrences(of: ".keyboardShortcut(.defaultAction)", in: text), 1,
                       "the pairing screen must not offer two competing default buttons")
        assertDefaultAction(attachesTo: "Button(L10n.t(.workspaceConnectWithCode))",
                            in: text, named: crossConnect)
        XCTAssertFalse(try source(named: lanConnect).contains(".keyboardShortcut(.defaultAction)"),
                       "the same-network screen competes for the window's default action")
        XCTAssertTrue(text.contains(".disabled(!fileModel.canJoin || sessionLocked)"),
                      "the default action must stay inert until six digits are in")
        XCTAssertTrue(text.contains("fileModel.updateJoinCode($0)")
                      && text.contains("textModel.updateJoinCode($0)"),
                      "six-digit normalization — including a leading 1 — must survive")
        // And exactly one on this surface's other file: the session pane must
        // not inherit a default from the phase that started it, because Return
        // over a transfer in flight has nothing safe to mean.
        for name in [lanDestination, crossDestination, transferSession] {
            XCTAssertFalse(try source(named: name).contains(".keyboardShortcut(.defaultAction)"),
                           "\(name) competes for the window's default action")
        }
    }

    /// A live session must not inherit a default button from the surface that
    /// started it: Return over a transfer in flight has nothing safe to mean.
    func testTheSharedSessionViewsClaimNoKeyboardDefault() throws {
        for file in ["RealtimeFileSessionView.swift", "RealtimeTextSessionView.swift"] {
            XCTAssertFalse(try source(named: file).contains(".keyboardShortcut(.defaultAction)"),
                           "\(file) must not claim the window's default action")
        }
    }

    // MARK: - the composer

    /// **Return writes a newline; ⌘Return sends. Both composers, one contract.**
    ///
    /// The link's composer was a one-line `TextField` growing to four, with
    /// `.defaultAction` on Send — so Return, the key that starts a paragraph
    /// everywhere else a message is written, delivered the message instead. The
    /// only way to find that out was to lose one.
    ///
    /// Four properties carry the repair, and each fails in a different way:
    ///
    ///  1. It is a `TextEditor`. A `TextField` handles Return itself, so no
    ///     amount of shortcut wiring makes it a place to write a paragraph.
    ///  2. Send carries `.keyboardShortcut(.return, modifiers: .command)` and
    ///     NOT `.defaultAction`. `.defaultAction` IS plain Return; one modifier
    ///     less and the newline is gone again.
    ///  3. The height is bounded at both ends — big enough to write in, capped
    ///     so a long draft scrolls inside it rather than pushing the transcript
    ///     and the exit out of a 560pt window.
    ///  4. The binding is stated on screen. A shortcut nobody is told about is a
    ///     shortcut for whoever wrote it, and both composers say it with the
    ///     SAME key, so a user cannot learn it on one screen and doubt it on the
    ///     other.
    func testBothComposersTakeReturnAsANewlineAndSendOnCommandReturn() throws {
        let link = try source(named: "Transfer/TransferLinkPane.swift")
        let legacy = try source(named: "RealtimeTextSessionView.swift")

        // 1. A real editor, with a bounded, writable height.
        XCTAssertTrue(link.contains("TextEditor(text: $draft)"),
                      "the link composer is a one-line field again")
        XCTAssertTrue(link.contains(".frame(minHeight: Metrics.composerMinHeight,\n"
                                    + "                           maxHeight: Metrics.composerMaxHeight)"),
                      "the link composer has no practical minimum or no bounded growth")
        XCTAssertTrue(legacy.contains(".frame(minHeight: Metrics.composerMinHeight,\n"
                                      + "                       maxHeight: Metrics.composerMaxHeight)"),
                      "the legacy composer is still shorter or grows without a bound")
        XCTAssertFalse(link.contains("axis: .vertical") || link.contains(".lineLimit(1...4)"),
                       "the link composer is a growing text field rather than an editor")

        // 2. ⌘Return sends, on both, and plain Return belongs to neither Send.
        for (name, text) in [("TransferLinkPane", link), ("RealtimeTextSessionView", legacy)] {
            XCTAssertTrue(text.contains(".keyboardShortcut(.return, modifiers: .command)"),
                          "\(name) does not send on ⌘Return")
            XCTAssertFalse(text.contains(".keyboardShortcut(.defaultAction)"),
                           "\(name) took plain Return away from its editor")
            // 4. …and says so.
            XCTAssertTrue(text.contains("L10n.t(.composerShortcutHint)"),
                          "\(name) leaves its keyboard contract to be discovered")
        }

        // Whitespace-only stays refused, and the trim is what makes internal
        // newlines survive: it strips the ends, never the middle.
        XCTAssertTrue(link.contains("draft.trimmingCharacters(in: .whitespacesAndNewlines)"))
        XCTAssertTrue(link.contains(".disabled(!link.canCompose || trimmedDraft.isEmpty)"),
                      "a whitespace-only draft can be sent")
        XCTAssertTrue(link.contains("guard !body.isEmpty else { return }"),
                      "the send action does not re-check the trimmed draft")

        // A draft handed back is restored EXACTLY, and only over an empty field:
        // overwriting something the user has since typed would lose the newer of
        // the two.
        XCTAssertTrue(link.contains("guard let returned = link.takeReturnedDraft() else { return }"))
        XCTAssertTrue(link.contains("guard trimmedDraft.isEmpty else { return }"))
        XCTAssertTrue(link.contains("draft = returned"),
                      "a returned draft is transformed on its way back to the field")
        XCTAssertTrue(link.contains(".task(id: link.returnedDraft) { restoreReturnedDraft() }"),
                      "the hand-back is a view-on-appear side effect again")

        // The placeholder is decoration; the editor carries the name. A
        // placeholder doing double duty disappears from VoiceOver the moment
        // somebody types.
        XCTAssertTrue(link.contains(".accessibilityLabel(L10n.t(.linkComposerLabel))"))
        XCTAssertTrue(link.contains("Text(L10n.t(.linkComposerPlaceholder))"))
        guard let placeholder = link.range(of: "Text(L10n.t(.linkComposerPlaceholder))") else {
            return XCTFail("the composer lost its placeholder")
        }
        let placeholderStyling = String(link[placeholder.upperBound...].prefix(400))
        XCTAssertTrue(placeholderStyling.contains(".accessibilityHidden(true)"),
                      "the placeholder is read as a second name for the editor")
        XCTAssertTrue(placeholderStyling.contains(".allowsHitTesting(false)"),
                      "the placeholder swallows clicks aimed at the editor under it")
    }

    private func assertDefaultAction(attachesTo anchor: String,
                                     in text: String,
                                     named name: String,
                                     file: StaticString = #filePath,
                                     line: UInt = #line) {
        guard let button = text.range(of: anchor) else {
            return XCTFail("\(name) no longer has \(anchor)", file: file, line: line)
        }
        let rest = text[button.upperBound...]
        guard let shortcut = rest.range(of: ".keyboardShortcut(.defaultAction)") else {
            return XCTFail("\(name): \(anchor) has no keyboard default", file: file, line: line)
        }
        XCTAssertFalse(rest[..<shortcut.lowerBound].contains("Button("),
                       "\(name): the keyboard default after \(anchor) belongs to a later button",
                       file: file, line: line)
    }

    // MARK: - the corrections the second audit asked for

    /// **A card has a visible edge, and it is the system's own separator.**
    ///
    /// The card was fill-only: `controlBackgroundColor` on
    /// `windowBackgroundColor`. In Dark appearance those two are far enough
    /// apart to read as a container; in Light they are near enough that a screen
    /// of stacked cards read as one column with headings in it, which is the
    /// audit's Light-appearance finding.
    ///
    /// What this pins is the shape of the fix as much as its presence. The
    /// boundary is a one-pixel `strokeBorder` in a named `Palette` role that
    /// resolves to `separatorColor` — so it answers Light, Dark and Increase
    /// Contrast the way the rest of the app does, and Dark is not restyled to
    /// fix Light. The alternatives are checked as absences because each is a
    /// plausible next edit and each would break something else: a hex value
    /// answers no appearance, a gradient or material is decoration this app's
    /// two-level vocabulary has no room for, and a shadow under every card costs
    /// offscreen rendering for a cue a line already gives.
    func testThePrimaryCardHasAnAdaptiveBoundaryAndNoInventedColour() throws {
        let card = try source(named: "Components/SectionCard.swift")
        XCTAssertTrue(card.contains(".background(Palette.cardBackground)"),
                      "the card lost its adaptive system fill")
        XCTAssertTrue(card.contains(".strokeBorder(Palette.cardBorder, lineWidth: 1)"),
                      "the card has no boundary, so Light appearance flattens it again")
        XCTAssertTrue(card.contains("RoundedRectangle(cornerRadius: Metrics.corner)"),
                      "the boundary does not follow the card's own corner")
        for invented in ["Color(red:", "Color(hue:", "#colorLiteral", "LinearGradient",
                         "RadialGradient", ".ultraThinMaterial", ".regularMaterial",
                         ".shadow("] {
            XCTAssertFalse(card.contains(invented),
                           "the card grew chrome the design vocabulary does not have: \(invented)")
        }

        // The role is a token, and the token is the system's. A literal here
        // would be a colour that answers neither appearance nor Increase
        // Contrast — the exact reason `DesignTokens` holds no colours of its own.
        let tokens = try source(named: "Components/DesignTokens.swift")
        XCTAssertTrue(tokens.contains(
            "static var cardBorder: Color { Color(nsColor: .separatorColor) }"),
            "the card boundary is no longer an adaptive system colour")
        XCTAssertFalse(tokens.contains("Color(red:") || tokens.contains("#colorLiteral"),
                       "DesignTokens named a colour of its own")

        // And the second level stays chrome-free: a bordered `OpenSection` would
        // be the box-in-a-box this vocabulary exists to prevent, and Help — the
        // quietest thing on a screen — must not acquire the cards' weight.
        for quiet in ["Components/OpenSection.swift", "Components/HelpSection.swift"] {
            let text = try source(named: quiet)
            XCTAssertFalse(text.contains("Palette.cardBorder") || text.contains("SectionCard("),
                           "\(quiet) took the primary card's chrome")
        }
    }

    /// **The Device Inbox says each thing once.**
    ///
    /// Three duplications on one screen, all of them the same mistake — a label
    /// repeated at a level that had already stated it:
    ///
    ///  1. The first `Form` section was headed `inbox.title`, printing *Device
    ///     Inbox* under a window title and a highlighted sidebar row that had
    ///     both just said it. The signed-out branch did the same.
    ///  2. The policy `Picker` carried its own `inbox.policyHeading` title two
    ///     lines under a section header rendering that identical string.
    ///  3. The path rail hung the receive folder off its last stop, a short
    ///     scroll above the folder section that owns the fact and the buttons
    ///     that change it.
    ///
    /// Each fix has a matching negative, because each could be "fixed" by
    /// deleting the information instead of the repetition: the picker keeps its
    /// accessibility label (`labelsHidden`, not a `Picker("")`), the folder
    /// section keeps the folder, and both headers keep an identifier the runtime
    /// suite addresses them by.
    func testTheDeviceInboxDoesNotRepeatItsOwnNameOrItsSectionsLabels() throws {
        let surface = try source(named: "DeviceInbox/DeviceInboxSurface.swift")

        // 1. No section calls itself after the whole destination.
        XCTAssertFalse(surface.contains("L10n.t(.inboxTitle)"),
                       "a Device Inbox section still repeats the destination's name")
        XCTAssertTrue(surface.contains("Text(L10n.t(.inboxStatusHeading))"),
                      "the status section lost its own heading")
        let signedOutHeader = "Text(L10n.t(.navAccount))\n"
            + "                .accessibilityIdentifier(\"inbox-signed-out\")"
        XCTAssertTrue(surface.contains(signedOutHeader),
                      "the signed-out header lost its leaf identifier or its own name")

        // 2. The picker's label is hidden, not removed — a picker with no label
        //    at all reads as "radio group" and nothing else.
        XCTAssertTrue(surface.contains("Picker(L10n.t(.inboxPolicyHeading), selection:"),
                      "the policy picker lost the accessibility label it is named by")
        XCTAssertTrue(surface.contains(".labelsHidden()"),
                      "the policy picker prints its title under a header saying the same word")
        let policyHeader = "Text(L10n.t(.inboxPolicyHeading))\n"
            + "                .accessibilityIdentifier(\"inbox-policy\")"
        XCTAssertTrue(surface.contains(policyHeader),
                      "the policy section header lost its name or its identifier")

        // 3. The rail states the route; the folder section states the folder.
        XCTAssertTrue(surface.contains("PathRailPresentation.deviceInbox()"),
                      "the rail is being handed the folder to restate again")
        XCTAssertTrue(surface.contains("Text(InboxFolderPresentation.description(inbox.folder))")
                      && surface.contains(".accessibilityIdentifier(\"inbox-folder\")"),
                      "removing the duplicate removed the folder itself")
        XCTAssertEqual(occurrences(of: "InboxFolderPresentation.description", in: surface), 1,
                       "the receive folder is rendered in two places on one screen")
    }

    /// **Every way a file arrives adds to the selection; only Clear removes.**
    ///
    /// The drop zone appended and the picker replaced, so a user who dropped a
    /// folder and then reached for **Choose Files or Folders…** to add one more
    /// file silently lost the folder — no message, no undo, and nothing on
    /// screen that had said the button was destructive. `NSOpenPanel` cannot
    /// show what is already staged, so it cannot be the confirmation that a
    /// replacement needs.
    ///
    /// `SelectionStore.replace` survives and is not the regression: iOS stages
    /// through it, and it swaps the security-scoped access set and the roots
    /// together. What is asserted is that no macOS entry point for a
    /// user-supplied file calls it.
    func testEveryStagingEntryPointAppendsAndOnlyClearDiscards() throws {
        let zone = try source(named: "FileDropZone.swift")
        XCTAssertTrue(zone.contains("if panel.runModal() == .OK { store.add(panel.urls) }"),
                      "the picker discards a batch it never showed the user")
        XCTAssertFalse(zone.contains("store.replace("),
                       "a user-supplied file still replaces the staged selection")
        XCTAssertTrue(zone.contains("store.add(urls)"),
                      "the drop stopped appending")

        // The OS-opened batch takes the same route on the one pane that adopts.
        // The two transfer panes are absent from this list on purpose: they
        // adopt nothing, and `testOnlyStoredSendAdoptsOpenedFilesAndNobodyReDerivesTheRule`
        // is what holds them to it.
        let text = try source(named: "UploadPane.swift")
        XCTAssertTrue(text.contains("selection.add(batch.urls)"),
                      "Stored Send adopts an opened batch by replacing the selection")
        XCTAssertFalse(text.contains("selection.replace("),
                       "Stored Send discards the staged selection")
        // A post-connect send expands its own batch and never touches an
        // app-scoped store, so `replace` on a local one is correct there and is
        // the only place either transfer surface may use it.
        for (pane, owner) in [(transferSession, "TransferSessionPane"),
                              ("Transfer/TransferLinkPane.swift", "TransferLinkPane")] {
            let source = try source(named: pane)
            XCTAssertTrue(source.contains("let store = SelectionStore()")
                          && source.contains("store.replace(with: urls)"),
                          "\(owner)'s send no longer expands through a local store")
            XCTAssertFalse(source.contains("selection.replace("),
                           "\(owner) writes an app-scoped selection")
        }

        // And the one destructive control is still on screen and still named.
        XCTAssertTrue(try source(named: transferStaging).contains(
            "Button(L10n.t(.commonClear)) { selection.clear() }"),
            "the explicit way to discard a batch is gone, so append is a trap")
    }

    /// **A gate that IS the screen offers a primary exit; a gate beside working
    /// controls does not.**
    ///
    /// Signed out, Send a link and the Device Inbox render nothing but their
    /// gate — so the sign-in button is the only thing on screen to press and is
    /// drawn as the primary action. The Cross-network screen gates only the half
    /// that spends an account: joining a code sits right beside it and needs
    /// nothing, so a prominent Sign in there would outrank the control the
    /// reader can actually use. The asymmetry is the point, so both directions
    /// are asserted.
    ///
    /// Prominence is a STYLE and not a keyboard default — `defaultAction` is
    /// guarded separately, and a gate claiming Return would take it from the
    /// forms this view renders inside.
    func testOnlyAWholeSurfaceGateDrawsItsSignInAsThePrimaryAction() throws {
        for whole in ["UploadPane.swift", "DeviceInbox/DeviceInboxSurface.swift"] {
            XCTAssertTrue(try source(named: whole).contains("isWholeSurface: true"),
                          "\(whole) is gated entire but offers no visible exit")
        }
        XCTAssertFalse(try source(named: crossConnect).contains("isWholeSurface"),
                       "the half-gated pairing screen outranks the join controls beside it")

        let gate = try source(named: "Components/CapabilityGateView.swift")
        XCTAssertTrue(gate.contains("actionIsProminent: isWholeSurface"),
                      "the gate no longer passes its own scope to the action")
        XCTAssertFalse(gate.contains(".keyboardShortcut("),
                       "the gate claims the window's default action")
        // Every branch, not only the signed-out one. An unverified or frozen
        // reader gets the same screenful of explanation and the same single way
        // out of it, so a bare `Button(` in one of those arms is a whole-surface
        // gate with an incidental-looking exit.
        XCTAssertFalse(gate.contains("Button(L10n.t(.commonTryAgain))")
                       || gate.contains("Button(L10n.t(.gateOpenAccount))")
                       || gate.contains("Button(L10n.t(.contentReactivate))"),
                       "a gated branch draws its exit without asking its own scope")
        XCTAssertEqual(occurrences(of: "exit(L10n.t(", in: gate), 3,
                       "the gate has a branch whose exit does not follow its scope")

        let empty = try source(named: "Components/EmptyStateView.swift")
        XCTAssertTrue(empty.contains("actionIsProminent: Bool = false"),
                      "an empty state is prominent by default, so every one of them shouts")
        XCTAssertTrue(empty.contains(".buttonStyle(.borderedProminent)"),
                      "the primary exit is drawn as an ordinary bordered button")
    }

    /// **The empty roster's address is a link, and the address is not typed
    /// anywhere it could disagree with the destination.**
    ///
    /// The state a first-time user sees most says "open relayium.com on the
    /// other device". It shipped as four words inside a grey sentence: nothing
    /// to click, nothing for the eye to stop on, and no way to act on it except
    /// to retype it by hand onto the device that is missing from the roster.
    ///
    /// Three separate things are guarded here, because each fails silently on
    /// its own:
    ///
    ///  1. **It is a `Link`.** Not a `Button` in accent colour, which looks
    ///     identical and has none of the behaviour a link is chosen for — the
    ///     contextual menu that copies the address, keyboard activation, and
    ///     `openURL` deciding where it goes.
    ///  2. **The visible address and the destination come from one value.** A
    ///     hard-coded `"relayium.com"` beside the origin constant is a screen
    ///     that can print one host and open another, and neither half looks
    ///     wrong alone.
    ///  3. **The prose no longer names the address.** Rendering the shared
    ///     one-sentence form here would put the host on the card twice — once
    ///     as dead text that looks clickable, once as the control.
    ///
    /// The pair is `transferBaseURL`/`transferHost` rather than the pinned
    /// production constants, and the difference is the same promise one step
    /// further out: this card's whole message is "the other device is not in
    /// this room yet — go to this address and join it". The address that makes
    /// that true is the hub this build is actually in a room on. In Release the
    /// two values are the same URL, so nothing about the shipped card moves;
    /// what the seam removes is the Debug state where the card names the
    /// production host while the roster below it is a local server's.
    func testTheEmptyRosterMakesTheAddressARealLinkFromOneSource() throws {
        let pane = try source(named: lanConnect)
        XCTAssertTrue(pane.contains("title: L10n.t(.nearbyEmptyRosterTitle)")
                      && pane.contains("body: L10n.t(.nearbyEmptyRosterOpen)"),
                      "the empty roster stopped rendering the split copy the link belongs to")
        XCTAssertFalse(pane.contains("L10n.t(.nearbyEmptyRoster)"),
                       "the Mac renders the sentence that names the address in prose, "
                       + "so relayium.com is on the card twice")
        XCTAssertTrue(pane.contains("url: AppEnvironment.transferBaseURL"),
                      "the empty roster's link points somewhere other than the origin "
                      + "this build's roster comes from")
        XCTAssertTrue(pane.contains("title: L10n.token(AppEnvironment.transferHost)"),
                      "the visible address is no longer derived from the destination")
        XCTAssertFalse(pane.contains("AppEnvironment.productionBaseURL")
                       || pane.contains("AppEnvironment.productionHost"),
                       "the card pins one half to production, so a local build prints "
                       + "relayium.com beside a roster it is not the room for")
        XCTAssertTrue(pane.contains("accessibilityHint: L10n.t(.nearbyEmptyRosterOpenHint)"),
                      "the link's only label is the bare address, with no hint saying what "
                      + "activating it does")
        XCTAssertTrue(pane.contains("identifier: \"lan-empty-roster-site\""),
                      "the link is unaddressable from a UI test")

        let empty = try source(named: "Components/EmptyStateView.swift")
        XCTAssertTrue(empty.contains("Link(link.title, destination: link.url)"),
                      "the empty state's address is not a native link any more")
        XCTAssertFalse(empty.contains("Button(link.title"),
                       "the address is a button dressed as a link: no copy menu, "
                       + "no link semantics")
        XCTAssertTrue(empty.contains(".accessibilityHint(link.accessibilityHint)")
                      && empty.contains(".accessibilityIdentifier(link.identifier)"),
                      "the link lost its hint or its identifier")
        // Exactly the two prose lines. A third would mean the link became
        // selectable too, which takes the drag its own activation and copy menu
        // need; zero means the sentences went back to being unselectable.
        XCTAssertEqual(occurrences(of: ".textSelection(.enabled)", in: empty), 2,
                       "the empty state's sentences are not exactly the selectable part")

        // And nowhere in the app is the host written as a string. This is the
        // guard that keeps 2. true for every future surface, not only this one.
        for (name, text) in try sources(under: macRoot, atLeast: 30) {
            XCTAssertFalse(text.contains("\"relayium.com\""),
                           "\(name) hard-codes the product host beside a URL that owns it")
        }
    }

    /// macOS cannot resume a stored upload after the app closes, so its running
    /// surface must not reuse iOS's durable-resume explanation.
    func testMacUploadShowsItsOwnForegroundOnlyWarning() throws {
        let upload = try source(named: "UploadPane.swift")
        XCTAssertTrue(upload.contains("Text(L10n.t(.uploadMacKeepOpen))"),
                      "the Mac upload does not warn that closing stops it")
        XCTAssertFalse(upload.contains("Text(L10n.t(.uploadKeepOpen))"),
                       "the Mac promises iOS-only upload recovery")
    }

    // MARK: - the component vocabulary, everywhere

    /// The account surface was the one signed-in screen the round left on its
    /// pre-round layout: a flat column grouped by `Divider()`, with three
    /// headings that were `Text(...).font(.headline)` — the exact pattern the
    /// component vocabulary exists to replace. Rebuilt on `SectionCard` and
    /// `InlineMessage` like the other four destinations.
    ///
    /// The kept-behaviour list below is the point of the guard. A re-layout is
    /// the change most likely to drop a confirmation dialog, a row-local busy
    /// flag or a `.task(id:)` by accident, and none of that is observable from a
    /// screenshot.
    func testTheAccountSurfaceIsBuiltFromTheComponentVocabulary() throws {
        let account = try source(named: "AccountView.swift")
        XCTAssertFalse(account.contains("Divider()"),
                       "divider-based grouping is what SectionCard replaces")
        XCTAssertEqual(occurrences(of: "SectionCard(", in: account), 4,
                       "profile/plan/usage, devices, stored files and deleting the account "
                       + "are four deliberate cards")
        XCTAssertGreaterThanOrEqual(occurrences(of: "InlineMessage(", in: account), 5,
                                    "row errors, the load error, the cleanup warning and the "
                                    + "stale-figures notice all carry a symbol")
        // `.task(id: management.needsSignOut)`, `acknowledgeSignOut()` and
        // `session.logOut()` deliberately LEFT this list: noticing a successful
        // self-revoke is no longer this view's job, because a view's lifetime is
        // shorter than the operation. What replaces them is not nothing —
        // `testNoViewOwnsTheSelfRevokeHandOff` and
        // `testTheExplicitSignOutGoesThroughTheOneCoordinator` say where the
        // hand-off went, which is the harder claim.
        for kept in [".task(id: scope)", "signOut.signOut(scope: scope)",
                     "confirmationDialog", "management.isBusy(row: device.id)",
                     "management.isBusy(row: row.id)", "management.revoke(device, scope: scope)",
                     "management.delete(file, scope: scope)", "management.clear(scope:",
                     "management.dismissKeyCleanupWarning()",
                     "AccountRefreshDecision.next", "NSPasteboard.general.setString",
                     "session.refresh()", "AccountScope(accountId: user.id"] {
            XCTAssertTrue(account.contains(kept), "AccountView lost \(kept)")
        }
    }

    /// The list and its destructive confirmation must name the same device.
    /// `AccountPresentation.deviceName` trims whitespace and supplies the
    /// localized fallback; using raw `device.name` in either place produces a
    /// blank row or a dialog titled `Revoke “”?` for a value the server accepts.
    func testTheDeviceRowAndRevokeDialogShareTheDeviceNameFallback() throws {
        let account = try source(named: "AccountView.swift")
        XCTAssertTrue(account.contains("Text(AccountPresentation.deviceName(device))"),
                      "the row bypasses the shared whitespace-aware fallback")
        XCTAssertTrue(account.contains(
            "deviceToRevoke.map { AccountPresentation.deviceName($0) } ?? \"\""),
                      "the destructive dialog does not name the device the row displayed")
    }

    /// Ending the account is reachable from the account screen, and it is two
    /// steps: a destructive control that opens a confirmation, and a
    /// confirmation whose action asks the SERVER for an email.
    ///
    /// Every clause is a way this could look finished and not be. A button that
    /// called `requestAccountDeletion()` directly would be a one-tap account
    /// deletion with no confirmation. A confirmation whose action opened a URL
    /// would be the browser hand-off this slice exists to replace. And a
    /// success path that signed the user out would assert a deletion that has
    /// not happened — the credential stays valid until the emailed link is
    /// confirmed and the server revokes it, which is what leaves a way back.
    func testTheAccountSurfaceCanEndTheAccountNativelyAndOnlyAfterConfirming() throws {
        let account = try source(named: "AccountView.swift")
        XCTAssertTrue(account.contains("Button(L10n.t(.accountDeleteAccount), role: .destructive)"),
                      "the delete control must carry the destructive role")
        XCTAssertTrue(account.contains("confirmingAccountDeletion = true"),
                      "and must open a confirmation rather than act")
        XCTAssertTrue(account.contains("L10n.t(.accountDeleteAccountConfirmTitle)"),
                      "the confirmation must be the system dialog, titled")
        XCTAssertTrue(account.contains("Button(L10n.t(.accountDeleteAccountConfirmAction), role: .destructive)"),
                      "the confirmation's action is the destructive one")
        XCTAssertTrue(account.contains("session.requestAccountDeletion()"),
                      "the request must go through the session")
        XCTAssertEqual(occurrences(of: "session.requestAccountDeletion()", in: account), 1,
                       "a second call site would be one that skipped the confirmation")

        // The one call to the session must sit inside the confirmation's
        // action. Source order, not render order — the dialog is a modifier on
        // `body` and the card is a computed property further down the file, so
        // only the local ordering inside the dialog is a real claim.
        guard let requests = account.range(of: "session.requestAccountDeletion()"),
              let confirmAction = account.range(of: ".accountDeleteAccountConfirmAction") else {
            return XCTFail("AccountView no longer has the two-step delete")
        }
        XCTAssertTrue(confirmAction.upperBound < requests.lowerBound,
                      "the request must sit inside the confirmation's destructive button")

        // And it adds no sign-out. Zero, now that both sign-out paths belong to
        // the coordinator: a deletion request that ended the session would
        // assert a deletion the server has not performed and take away the
        // credential the user needs if they change their mind before opening
        // the emailed link.
        XCTAssertEqual(occurrences(of: "session.logOut()", in: account), 0,
                       "requesting a deletion must not sign the user out")
    }

    /// Two files may name the failure colour, and it is the one that always draws
    /// a symbol beside it. Everywhere else, red on its own is the whole message —
    /// which is no message at all under a colour filter, in Increase Contrast, or
    /// to a reader who cannot distinguish it. Counting the files is what keeps
    /// that a rule rather than an intention, exactly as for `.system(size:`.
    func testExactlyOneFileNamesTheFailureColour() throws {
        XCTAssertEqual(try sources(under: macRoot, atLeast: 20)
            .filter { namesTheFailureColour($0.text) }.map(\.name),
                       ["Components/InlineMessage.swift", "DeviceInbox/DeviceInboxSurface.swift"])
    }

    /// `.red` as a colour, not as the first four characters of `.reduce`.
    private func namesTheFailureColour(_ text: String) -> Bool {
        var searched = text.startIndex..<text.endIndex
        while let hit = text.range(of: ".red", range: searched) {
            let next = hit.upperBound
            if next == text.endIndex || !(text[next].isLetter || text[next].isNumber) {
                return true
            }
            searched = next..<text.endIndex
        }
        return false
    }

    // MARK: - what the repository's own documents may claim

    /// Constraint 14, and `PROJECT-GOVERNANCE.md` § "Native product launch
    /// definition". This guard has now passed through all three of its states,
    /// and the third is the one it is in:
    ///
    ///  1. Before approval it banned every distribution claim, because signed,
    ///     notarized and green is still "in development".
    ///  2. After the owner approved 1.0 it kept banning them, because approval
    ///     is permission to publish and there was still nothing to download.
    ///  3. The current immutable GitHub Release uses the macOS target's exact
    ///     marketing version.
    ///     at this exact commit, with a Developer ID-signed, Apple-notarized,
    ///     stapled `Relayium.dmg` and its SHA-256 attached. A reader can now go
    ///     and fetch it, so "available for download" is a FACT about macOS, and
    ///     a ban on saying it would make these documents lie in the other
    ///     direction.
    ///
    /// What survives every state is the set of claims that were never true and
    /// are not true now. Relayium has no Mac App Store listing — the macOS app
    /// is a Developer ID download — and the iOS app is published nowhere at all.
    /// Those are the two ways this repository could still overstate itself, so
    /// those are what stays banned.
    ///
    /// Phrases, not bare words. `apps/README.md` legitimately explains why
    /// `apps/` is Apache-2.0 ("so these clients can ship through the App Store")
    /// and that native Apple sign-in on the Mac "waits for a Mac App Store
    /// track". Banning "app store" would fail on both, and a guard that has to
    /// be disabled to write the truth protects nothing.
    ///
    /// And a substring cannot tell a claim from its DENIAL. The first version of
    /// this list banned "through the mac app store" and immediately failed on
    /// *"It is not distributed through the Mac App Store"* — the truest sentence
    /// in the file. Only unambiguously affirmative spellings are banned here;
    /// the real protection against the opposite mistake is
    /// `testTheDocsDenyAMacAppStoreListing` below, which REQUIRES the denial to
    /// be present. A document cannot start claiming an App Store listing without
    /// deleting a sentence that is asserted somewhere else.
    func testNoClaimSurfaceClaimsAnAppStoreOrAPublicIOSRelease() throws {
        let claims = ["available on the mac app store", "listed on the mac app store",
                      "get it on the mac app store", "download it from the mac app store",
                      "ships through the mac app store", "published to the mac app store",
                      "the ios app is publicly available", "download the ios app",
                      "the ios app has launched", "the ios app is now live",
                      "ios app is available for download"]
        for path in claimSurfaces {
            let text = try claimSurfaceText(path).lowercased()
            for claim in claims {
                XCTAssertFalse(text.contains(claim), "\(path) claims distribution: \(claim)")
            }
        }
    }

    /// The denial, required rather than merely permitted — see above for why the
    /// ban list alone cannot carry this.
    ///
    /// Relayium distributes macOS as a Developer ID download. Saying so is not
    /// pedantry: Gatekeeper, the update mechanism, the entitlements the app may
    /// hold and what a reader should be suspicious of all differ between the two
    /// channels, and a reader who assumes App Store review stood behind this
    /// download has been misled by omission.
    func testTheDocsDenyAMacAppStoreListing() throws {
        for path in ["README.md", "apps/README.md"] {
            XCTAssertTrue(flattened(try claimSurfaceText(path)).lowercased()
                .contains("no mac app store listing"),
                          "\(path) must say plainly that there is no Mac App Store listing")
        }
    }

    /// The positive half, and the reason the ban list above could be relaxed
    /// without the documents quietly going vague instead.
    ///
    /// A reader has to be able to check this. So the claim surfaces must name
    /// the exact immutable tag for the PUBLISHED version, which resolves to one
    /// GitHub Release and one DMG, rather than say "released" and leave the
    /// reader to find out where. They must also say what the artifact IS
    /// (Developer ID-signed and Apple-notarized), because "there is a download"
    /// and "the download is one Gatekeeper will run" are different promises.
    ///
    /// The version comes from `web/native-releases.json`, which is the record
    /// of what is published, and not from the project's `MARKETING_VERSION`,
    /// which advances a commit or more before publication — see
    /// `publishedMacVersion()`. A tag derived from Xcode would be a tag that
    /// 404s for the whole window between preparing a release and shipping it,
    /// and this test would be demanding the READMEs print it.
    ///
    /// Still deliberately not asserted here: anything about relayium.com. The
    /// manifest is read for the one fact it owns — which version is published —
    /// and nothing is claimed about whether the `/apps` page renders it, which
    /// is a separate fact with its own dual-state tests.
    func testTheDocsNameTheMacOSReleaseAReaderCanActuallyFetch() throws {
        let version = try publishedMacVersion()
        let tag = "macos-v\(version)"
        for path in ["README.md", "apps/README.md"] {
            let text = try claimSurfaceText(path)
            XCTAssertTrue(text.contains(tag),
                          "\(path) must name the exact release tag a reader can fetch")
            let lowered = flattened(text).lowercased()
            XCTAssertTrue(lowered.contains("developer id-signed"),
                          "\(path) must say what the published artifact is signed with")
            XCTAssertTrue(lowered.contains("notarized"),
                          "\(path) must say the published artifact is notarized")
        }
    }

    /// The other half of what used to be one test, and the half that inverted.
    ///
    /// `apps/mac/release-readiness.json` records the OWNER's decision, not CI's
    /// opinion of the tree, and the release job gates on it through
    /// `check-release-readiness.mjs --require-approved`. Pinning it to
    /// `"approved": false` made the manifest unable to express the one state the
    /// release path exists to consume: the formal 1.0 run was cancelled before
    /// publishing anything because this assertion failed on an approval the
    /// owner had actually given.
    ///
    /// Asserted positively rather than by deleting the old check, so that an
    /// accidental revert of the approval commit fails here loudly instead of
    /// reaching the release job as a silent "not approved".
    ///
    /// This says nothing about distribution. Approval is permission to publish;
    /// `testNoPublicDistributionClaimInDocsBeforeTheReleaseExists` above still
    /// forbids every claim surface from describing the Release as something a
    /// reader can already download, until it is published.
    func testTheReadinessManifestRecordsTheOwnersApproval() throws {
        XCTAssertTrue(try claimSurfaceText("apps/mac/release-readiness.json")
            .contains("\"approved\": true"),
                      "the readiness manifest must record the owner's 1.0 approval")
    }

    /// The other direction, and the one a ban list cannot give: the status has to
    /// be stated, not merely left unclaimed. A reader who never reaches the
    /// blocker list should still not close `apps/README.md` believing everything
    /// in it shipped.
    ///
    /// Retargeted at iOS when macOS 1.0 shipped. Before that, "contains the
    /// words engineering build" was a fair proxy for the whole directory,
    /// because both apps were one. Now the phrase is still present in both files
    /// — in the macOS slice history, which is dated — so the old assertion would
    /// have stayed green while saying nothing about the app it was written for.
    /// Bind it to the sentence that is actually load-bearing: iOS is not
    /// published, said in the same breath as the word.
    func testTheDocsStateTheIOSEngineeringBuildStatusOutright() throws {
        let apps = flattened(try claimSurfaceText("apps/README.md"))
        XCTAssertTrue(apps.contains("The iOS app and its share extension are engineering builds and are published nowhere."),
                      "apps/README.md must say outright that iOS is unpublished")
        XCTAssertTrue(apps.contains("**In development and not public**"),
                      "the iOS section must keep its own status line")

        let root = flattened(try claimSurfaceText("README.md"))
        XCTAssertTrue(root.contains("The iOS app runs its transfer, nearby and account workflows in the foreground and is **not public**"),
                      "the root README must say outright that iOS is unpublished")
    }

    /// Decision 5 moved the window floor from 380 pt to 860×560, and three
    /// sentences across two documents asserted the old one — including one that
    /// tells the next person which width to check truncation at.
    func testNoDocumentAssertsTheOldMinimumWidth() throws {
        for path in claimSurfaces {
            let text = try claimSurfaceText(path)
            for spelling in ["380pt", "380 pt", "380-pt"] {
                XCTAssertFalse(text.contains(spelling),
                               "\(path) still asserts the old floor: \(spelling)")
            }
        }
    }

    /// **No document still describes the merged Workspace or a browseable Open
    /// a link.**
    ///
    /// A stale sentence in a README is not a cosmetic problem here: these three
    /// documents are what a reader takes as the statement of what the product
    /// IS, and each of them named the sidebar row by row. A description of a
    /// screen that no longer exists is worse than no description, because it is
    /// the version a reader will go looking for and fail to find.
    ///
    /// Asserted in both directions — the old names gone AND the new ones present
    /// — because deleting the sentence would pass a test that only checked for
    /// absence, and would leave the documents silent about the change the owner
    /// asked for.
    func testNoDocumentStillDescribesTheMergedWorkspaceOrABrowseableOpenLink() throws {
        for path in claimSurfaces {
            let text = flattened(try claimSurfaceText(path))
            for stale in ["Workspace — one peer", "Workspace is one row",
                          "one Workspace", "Workspace, Send a link",
                          "a live Workspace", "sidebar names all five destinations"] {
                XCTAssertFalse(text.contains(stale),
                               "\(path) still describes the merged Workspace: \(stale)")
            }
        }
        // The detailed native README describes the sidebar. The root README is
        // deliberately a concise availability table and links into docs.
        let apps = flattened(try claimSurfaceText("apps/README.md"))
        XCTAssertTrue(apps.contains("LAN Transfer"),
                      "apps/README.md does not name the same-network destination")
        XCTAssertTrue(apps.contains("Cross-network Transfer"),
                      "apps/README.md does not name the pairing-code destination")
        XCTAssertFalse(apps.contains("Open a link, Device Inbox"),
                       "apps/README.md still lists Open a link as a sidebar row")
        XCTAssertTrue(apps.contains("five destinations"),
                      "apps/README.md no longer counts the browseable rows")
        XCTAssertTrue(apps.localizedCaseInsensitiveContains("deep link"),
                      "apps/README.md does not say how Open a link is reached")
    }

    /// Wording that overstates what is distributed, without ever using a word the
    /// launch-claim ban would catch.
    ///
    /// This is the quieter half of constraint 14, and each phrase below was true
    /// of a different tree than this one:
    ///
    ///  - *"Nothing in this directory is publicly distributed"* is broader than
    ///    the sentence needs to be and broader than the round can support —
    ///    `apps/` also holds the shared package and the iOS app, whose status is
    ///    stated separately. What this round establishes is about the macOS
    ///    build, so that is what the sentence may say.
    ///  - *"the public macOS UI ships"* and *"the shipped app"* describe an
    ///    artifact that reached users. This one reached CI.
    ///  - the readiness manifest's *"the whole public macOS UI"* and *"nine
    ///    shipped `.lproj`* carry the same implication into the document a
    ///    reviewer reads as the record of what is true.
    ///  - the readiness manifest's *"a live shipped-bundle receive"* names the
    ///    artifact the observation was made against, and names it wrongly.
    ///    Current-tree QA names the signed Debug app it actually exercised and
    ///    keeps the signed-Release caveat. Nothing was shipped.
    ///
    /// Deliberately narrow: exact stale phrases, and positive assertions that the
    /// corrected sentences are actually there rather than merely deleted — for
    /// the readiness manifest, that both the current-tree observation and its
    /// caveat survived the rewording. It adds no launch claim and leaves
    /// `approved` and every capability flag to the tests that already own them.
    func testNoClaimSurfaceOverstatesWhatIsDistributed() throws {
        let stale: [(path: String, phrase: String)] = [
            ("apps/README.md", "Nothing in this directory is publicly distributed"),
            ("apps/README.md", "public macOS UI ships"),
            ("apps/README.md", "the shipped app"),
            ("apps/README.md", "nine shipped `.lproj`"),
            ("apps/mac/release-readiness.json", "whole public macOS UI"),
            ("apps/mac/release-readiness.json", "nine shipped .lproj"),
            ("apps/mac/release-readiness.json", "a live shipped-bundle receive"),
        ]
        for (path, phrase) in stale {
            XCTAssertFalse(flattened(try claimSurfaceText(path)).contains(phrase),
                           "\(path) still carries stale wording: \(phrase)")
        }
        // Superseded by the release itself. This used to require the sentence
        // *"The macOS build in this directory is not publicly distributed"*,
        // which was the precise thing to say while it was true and is now the
        // one sentence in this file that would be false. What the narrowness was
        // FOR survives: the statement has to be about a named thing rather than
        // about `apps/` as a whole, because the two apps in it are no longer in
        // the same state. So the requirement moves rather than disappearing —
        // macOS says what it published, iOS says it published nothing, and
        // neither sentence is allowed to speak for the other.
        //
        // The version is DERIVED, not written down here. This assertion pinned
        // the literal `1.0` and stayed green through 1.1 to 1.2.3 while the
        // sentence it guards described a release five versions old — the exact
        // staleness the surrounding tests exist to prevent, reproduced by the
        // guard itself. Reading the published manifest means the status
        // sentence has to move with the product or fail here.
        //
        // From `web/native-releases.json` rather than `MARKETING_VERSION`,
        // because the sentence says "released as", and Xcode's version says
        // what is being BUILT. On a release branch those differ by design, and
        // this test is the one that would otherwise force `apps/README.md` to
        // claim a release as distributed before it was notarized and published
        // — precisely the overstatement the rest of the test forbids.
        let apps = flattened(try claimSurfaceText("apps/README.md"))
        let version = try publishedMacVersion()
        XCTAssertTrue(apps.contains("**Status: released as \(version).**"),
                      "apps/README.md must state the macOS status precisely")
        XCTAssertTrue(apps.contains("The iOS app and its share extension are engineering builds and are published nowhere."),
                      "apps/README.md must scope that status to macOS and say what iOS is")

        let readiness = flattened(try claimSurfaceText("apps/mac/release-readiness.json"))
        XCTAssertTrue(readiness.contains("Current-tree signed Debug QA repeated a live receive"),
                      "the readiness manifest must name the artifact it actually observed")
        for kept in ["NearbyReceiveE2E --send-to against the running Relayium.app",
                     "the file still existed 55 seconds after completion",
                     "A signed Release build has never been exercised this way"] {
            XCTAssertTrue(readiness.contains(kept),
                          "rewording dropped observed evidence or its caveat: \(kept)")
        }
    }

    /// Constraint 13. A repository document may carry a number only if somebody
    /// watched it happen; a hypothesis belongs in the design, not in the tree.
    ///
    /// Bound to a figure rather than to the word. "Estimated" and "projected"
    /// are ordinary English — a caveat may legitimately say a cost is hard to
    /// estimate — and what constraint 13 actually forbids is a NUMBER nobody
    /// observed. So a hit needs the word and a digit within the same clause, and
    /// the failure message prints the passage so the reader can judge it.
    func testNoDocumentPublishesAPredictedFigure() throws {
        for path in claimSurfaces {
            for passage in try unobservedFigures(in: claimSurfaceText(path)) {
                XCTFail("\(path) publishes an unobserved figure: …\(passage)…")
            }
        }
    }

    /// Passages where a prediction word sits within 60 characters of a digit.
    private func unobservedFigures(in text: String) -> [String] {
        let lowered = text.lowercased()
        let words = ["predicted", "projected", "estimated", "extrapolated",
                     "expected count", "should come out at", "we expect around"]
        var passages: [String] = []
        for word in words {
            var searched = lowered.startIndex..<lowered.endIndex
            while let hit = lowered.range(of: word, range: searched) {
                let before = lowered.index(hit.lowerBound, offsetBy: -60,
                                           limitedBy: lowered.startIndex) ?? lowered.startIndex
                let after = lowered.index(hit.upperBound, offsetBy: 60,
                                          limitedBy: lowered.endIndex) ?? lowered.endIndex
                let window = lowered[before..<after]
                if window.contains(where: \.isNumber) { passages.append(String(window)) }
                searched = hit.upperBound..<lowered.endIndex
            }
        }
        return passages
    }
    /// A UI-test launch must resolve its own keychain item, never the one the
    /// installed product wrote. Without this the suite inherits whatever account
    /// state the workstation is in, and its signed-out assertions become a
    /// statement about the machine.
    func testUITestLaunchesUseAnIsolatedKeychainIdentity() throws {
        let mode = try source(named: "UITestMode.swift")
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(mode.contains("isolatedKeychainConfiguration"),
                      "the UI-test launch has no keychain identity of its own")
        XCTAssertTrue(mode.contains("try? store.clear()"),
                      "an isolated launch inherits the previous path's account")
        XCTAssertTrue(app.contains("tokenStore: UITestMode.makeTokenStore()"),
                      "the app does not hand the isolated store to its session")
        let halves = mode.components(separatedBy: "#else")
        XCTAssertEqual(halves.count, 2)
        XCTAssertFalse(try XCTUnwrap(halves.last).contains("isolatedKeychainConfiguration"),
                       "a shipped build can be pointed at a test keychain identity")
    }

    /// The macOS half of the signed-in acceptance account, and the one assertion
    /// that keeps the two platforms from drifting apart.
    ///
    /// The transport is duplicated per app on purpose — a URLProtocol that
    /// fabricates account responses does not belong in a shipping library — so
    /// the modelled endpoint set is asserted to be identical instead. A platform
    /// that quietly stopped modelling `/api/files` would render an empty stored
    /// list that looked like a real empty account.
    func testTheSignedInAcceptanceAccountMatchesTheOtherPlatform() throws {
        let mac = try source(named: "UITestMode.swift")
        let iosURL = appsRoot.appendingPathComponent("ios/Relayium/UITestMode.swift")
        let ios = try String(contentsOf: iosURL, encoding: .utf8)

        for endpoint in ["/api/me", "/api/me/usage", "/api/devices", "/api/files"] {
            XCTAssertTrue(mac.contains("\"\(endpoint)\""), "macOS stopped modelling \(endpoint)")
            XCTAssertTrue(ios.contains("\"\(endpoint)\""), "iOS stopped modelling \(endpoint)")
        }
        // The stored-link keys are the consequential half of the isolation: the
        // product store resolves the installed app's keychain identity, and the
        // delete path calls `remove` on it.
        for required in ["static func makeStoredLinkKeyStore() -> StoredLinkKeyStore?",
                         "InMemoryStoredLinkKeyStore()"] {
            XCTAssertTrue(mac.contains(required), "macOS lost \(required)")
            XCTAssertTrue(ios.contains(required), "iOS lost \(required)")
        }
        for app in [try source(named: "RelayiumApp.swift"),
                    try String(contentsOf: appsRoot.appendingPathComponent(
                        "ios/Relayium/RelayiumApp.swift"), encoding: .utf8)] {
            XCTAssertTrue(app.contains("UITestMode.makeStoredLinkKeyStore()"),
                          "an acceptance launch still reaches the product's stored-link keys")
        }
        for required in ["final class UITestAccountTransport: URLProtocol",
                         "guard (try? JSONDecoder().decode(type, from: data)) != nil",
                         "didFailWithError: URLError(.unsupportedURL)",
                         "if isSignedIn { return makeSignedInTokenStore() }"] {
            XCTAssertTrue(mac.contains(required), "macOS lost \(required)")
            XCTAssertTrue(ios.contains(required), "iOS lost \(required)")
        }
        let halves = mac.components(separatedBy: "#else")
        XCTAssertEqual(halves.count, 2, "UITestMode lost its Debug/Release split")
        XCTAssertFalse(try XCTUnwrap(halves.last).contains("--relayium-ui-testing"),
                       "a shipped build can be told it already holds an account")

        // BOTH factories, on both platforms. The account session and the
        // management model build separate clients, so wiring only the first one
        // left devices and stored files going to the real network — a fixture
        // that looked complete and rendered an empty list instead.
        let macApp = try source(named: "RelayiumApp.swift")
        let iosApp = try String(
            contentsOf: appsRoot.appendingPathComponent("ios/Relayium/RelayiumApp.swift"),
            encoding: .utf8)
        // Named rather than counted: every factory that BUILDS a client which
        // talks to the account API must receive the acceptance transport, and a
        // fourth one added without it should fail here rather than silently
        // reach the network. Wiring only the first left devices and stored files
        // on the real network once already.
        for app in [macApp, iosApp] {
            for factory in ["makeSession(", "makeAccountManagementModel(",
                            "makeUploadModel(", "makeDownloadModel("] {
                guard let call = app.range(of: factory) else {
                    return XCTFail("\(factory) is gone — this guard is stale")
                }
                let window = String(app[call.lowerBound...].prefix(320))
                XCTAssertTrue(window.contains("transport: UITestMode.makeAccountTransport()"),
                              "\(factory) still reaches the network under acceptance")
            }
        }

        let uiURL = macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/AppShellUITests.swift")
        let ui = try String(contentsOf: uiURL, encoding: .utf8)
        XCTAssertTrue(ui.contains("testASignedInLaunchRendersItsAccountAndUngatesStoredSend"),
                      "no runtime path drives a signed-in macOS launch")
    }

    // MARK: - growing records are read newest first
    //
    // Four macOS lists only ever grow — the unified transcript, the unified
    // transfer list, and the legacy text history in both its live and its
    // retained form. Each of them put the entry the user is waiting for at the
    // BOTTOM, under everything already dealt with, and moved the controls below
    // it down every time another arrived.
    //
    // The reversal is a MODEL accessor in every case, never a view-local
    // `.reversed()`: `TransferNotifications` notifies on `history.last`, the
    // retention cap truncates from the front, and `LinkFilePresentationModel`
    // resolves batch ids by index — so the stored arrays must not move, and a
    // second surface reversing for itself is how two views come to disagree.
    // `RealtimeTextSessionModelTests`, `LinkSessionPresentationTextTests` and
    // `LinkSessionPresentationFileTests` hold the accessors themselves.

    func testEveryGrowingMacOSRecordIsRenderedNewestFirstThroughItsModel() throws {
        let link = try source(named: "Transfer/TransferLinkPane.swift")
        let legacy = try source(named: "RealtimeTextSessionView.swift")

        // The unified transcript and the unified transfer list.
        XCTAssertTrue(link.contains("ForEach(model.textMessagesNewestFirst)"),
                      "the unified transcript renders oldest first again")
        XCTAssertTrue(link.contains("ForEach(model.batchesNewestFirst)"),
                      "the unified transfer list renders oldest first again")
        XCTAssertFalse(link.contains("ForEach(model.textMessages)")
                       || link.contains("ForEach(model.batches)"),
                       "a unified list reads the stored order directly")

        // The legacy text history, in BOTH of its two renderings. Counting is
        // what makes this a rule rather than an intention: the live list and the
        // retained one are separate `ForEach`es and fixing one is the shape this
        // guard exists to catch.
        XCTAssertEqual(occurrences(of: "ForEach(model.historyNewestFirst)", in: legacy), 2,
                       "the live and retained histories do not both read newest first")
        XCTAssertFalse(legacy.contains("ForEach(model.history)"),
                       "a legacy history list reads the stored order directly")

        // Nothing reverses for itself. A view-local reversal is a second answer
        // to a question the model already answers.
        for (name, text) in [("TransferLinkPane", link), ("RealtimeTextSessionView", legacy)] {
            XCTAssertFalse(text.contains(".reversed()"),
                           "\(name) reverses a list in the view layer")
        }

        // …and the comments that said otherwise are gone, checked against the
        // sources WITH their comments intact.
        let rawLink = try rawSource(named: "Transfer/TransferLinkPane.swift")
        XCTAssertFalse(rawLink.contains("The conversation, oldest first."),
                       "the unified transcript still documents the old order")
        XCTAssertFalse(rawLink.contains("Every batch this link knows about, in the order it became known."),
                       "the unified transfer list still documents the old order")
    }

    /// **A message you cannot get out of an ephemeral session is a message you
    /// have to retype.**
    ///
    /// The unified transcript offered selectable text and nothing else, while
    /// the legacy row beside it has had an explicit Copy with a "Copied"
    /// acknowledgement since the ephemeral-text batch. Four properties carry the
    /// repair, and each of them has a way of looking done and not being:
    ///
    ///  1. The verbatim, selectable body stays. Copy is an addition, not a
    ///     replacement — peer-supplied text must still never be parsed.
    ///  2. The acknowledgement is bound to a row ID, never to a body. Holding
    ///     the plaintext in view state is a second copy of an ephemeral message.
    ///  3. It is dropped when its row goes, because the same link can clear and
    ///     reopen a conversation.
    ///  4. The accessible name keeps the direction after the visible label has
    ///     changed to "Copied", through the SAME presentation function the
    ///     legacy row uses.
    func testTheUnifiedTranscriptRowHasAnExplicitCopyWithRowScopedFeedback() throws {
        let link = try source(named: "Transfer/TransferLinkPane.swift")

        // 1. Selection and verbatim rendering are untouched.
        XCTAssertTrue(link.contains("Text(verbatim: message.body)"),
                      "the unified transcript renders peer text as markup")
        XCTAssertTrue(link.contains(".textSelection(.enabled)"),
                      "the explicit Copy replaced selectable text instead of joining it")

        // 2 & 3. Row-scoped, id-keyed, and retired with its row.
        XCTAssertTrue(link.contains("@State private var copiedMessageID: Int?"))
        XCTAssertTrue(link.contains("copiedMessageID = message.id"))
        XCTAssertTrue(link.contains("copiedMessageID == message.id ? .commonCopied : .commonCopy"))
        XCTAssertTrue(link.contains("!messages.contains(where: { $0.id == copiedMessageID })"),
                      "an acknowledgement outlives the row it belongs to")
        XCTAssertFalse(link.contains("@State private var copiedMessage:"),
                       "the view retains a second copy of ephemeral plaintext")

        // 4. The direction survives the label change, through the shared copy.
        XCTAssertTrue(link.contains("TextMessagePresentation.copyActionLabel("),
                      "the unified Copy has no direction-aware accessible name")
        XCTAssertTrue(link.contains("outgoing: message.direction == .outgoing"))

        // The clipboard write is the view layer's. `RelayiumAppKit` renders
        // nothing and must not acquire an AppKit pasteboard.
        XCTAssertTrue(link.contains("NSPasteboard.general.clearContents()")
                      && link.contains("NSPasteboard.general.setString(text, forType: .string)"),
                      "the unified Copy does not actually write the clipboard")
        for module in ["RelayiumAppKit", "RelayiumKit"] {
            let root = appsRoot.appendingPathComponent("RelayiumKit/Sources/\(module)")
            for file in try sources(under: root, atLeast: 5) {
                XCTAssertFalse(file.text.contains("NSPasteboard"),
                               "\(module)/\(file.name) reaches the pasteboard")
            }
        }
    }

    /// **The pane that does not observe a model must not decide when that
    /// model's list is empty.**
    ///
    /// `TransferLinkPane` observes `LinkWorkspaceModel` only. A nested
    /// `ObservableObject` publishing does not invalidate a view that merely
    /// holds a reference to it, so a mount condition here reading
    /// `text.textMessages` or `files.batches` was evaluated when the LINK last
    /// changed and never again: on a stable link the peer's messages and
    /// batches landed in models whose only observers — `LinkTranscriptView` and
    /// `LinkTransferListView` — had never been mounted, and the surfaces stayed
    /// blank until some unrelated link change rebuilt this body and everything
    /// appeared at once.
    ///
    /// So the mount is unconditional on content: the child observes, therefore
    /// the child decides what empty looks like. The transcript's answer is an
    /// empty `ForEach`; the transfer list has a visible heading and so keeps a
    /// real suppression — but inside the observing view, with BOTH halves of
    /// that one decision on the same side of the observation boundary.
    func testTheLinkPaneMountsItsNestedListsWithoutReadingTheirContents() throws {
        let link = try source(named: "Transfer/TransferLinkPane.swift")
        let transcriptView = try XCTUnwrap(link.range(of: "struct LinkTranscriptView"),
                                           "the transcript view moved out of the pane's file")
        let listView = try XCTUnwrap(link.range(of: "struct LinkTransferListView"),
                                     "the transfer list view moved out of the pane's file")
        let parent = String(link[..<transcriptView.lowerBound])
        let list = String(link[listView.lowerBound...])

        // The parent mounts on existence alone…
        XCTAssertTrue(parent.contains("if let text = link.textModel {")
                      && parent.contains("LinkTranscriptView(model: text)"),
                      "the transcript is no longer mounted whenever the conversation exists")
        XCTAssertTrue(parent.contains("if let files = link.fileModel {")
                      && parent.contains("LinkTransferListView(model: files, link: link)"),
                      "the transfer list is no longer mounted whenever the file model exists")

        // …and never reads what it does not observe. Naming the members at all
        // is the regression, not just `.isEmpty`: any read from here is a value
        // captured once and never refreshed.
        XCTAssertFalse(parent.contains("textMessages"),
                       "the pane reads a message list it does not observe")
        XCTAssertFalse(parent.contains("batches"),
                       "the pane reads a batch list it does not observe")

        // The one surviving suppression lives with its observer, and only there.
        XCTAssertTrue(list.contains("if !model.batches.isEmpty || !link.armedFiles.isEmpty"),
                      "the transfer list lost the empty suppression that belongs to it")
        XCTAssertEqual(occurrences(of: "if !model.batches.isEmpty || !link.armedFiles.isEmpty",
                                   in: link), 1,
                       "the batch suppression is decided in more than one place")
    }

}
