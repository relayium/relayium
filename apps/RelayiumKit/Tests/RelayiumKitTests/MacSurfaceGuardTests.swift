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
        let nearby = try source(named: workspaceConnect)
        XCTAssertTrue(nearby.contains("switch receive.state"))
        XCTAssertTrue(nearby.contains("case .off:"))
        XCTAssertTrue(nearby.contains("case .connecting, .ready, .reconnecting, .active:"))
        XCTAssertTrue(nearby.contains("receive.state == .paused || receive.state == .off"))
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
        // credential since R3-D.
        XCTAssertTrue(try source(named: "AccountView.swift").contains(
            "AccountPresentation.revokeActionLabel(for: device)"),
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
    }

    /// The three macOS files this round created, named once so a rename is one
    /// edit rather than forty. The Workspace replaced `NearbyPane`, `DirectPane`,
    /// `RealtimeTextPane`, `NearbyDestination` and `PairingCodeDestination`; the
    /// invariants those five carried did not go anywhere, so most of the guards
    /// below are the same assertions pointed at these.
    private let workspaceDestination = "Destinations/WorkspaceDestination.swift"
    private let workspaceConnect = "Workspace/WorkspaceConnectPane.swift"
    private let workspaceSession = "Workspace/WorkspaceSessionPane.swift"

    /// The five surfaces that no longer exist. Asserted as absences, because a
    /// half-finished revert — the new files plus one of the old ones still
    /// compiled in — is exactly the state that reintroduces the second sidebar
    /// row nobody would notice in a diff.
    private let retiredSurfaces = ["NearbyPane.swift", "DirectPane.swift",
                                   "RealtimeTextPane.swift",
                                   "Destinations/NearbyDestination.swift",
                                   "Destinations/PairingCodeDestination.swift"]

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var macRoot: URL { appsRoot.appendingPathComponent("mac/Relayium") }

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

    func testNearbyProgressNamesRealReconnectWorkAndNeverDecoratesLookAgain() throws {
        let pane = try source(named: workspaceConnect)
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

    func testMacRuntimeSuiteIsAHostedProductGate() throws {
        let workflowURL = repoRoot.appendingPathComponent(".github/workflows/macos.yml")
        let workflow = try String(contentsOf: workflowURL, encoding: .utf8)
        XCTAssertTrue(workflow.contains("Run macOS product-flow UI smoke"),
                      "CI compiles macOS but never launches its product flows")
        let signedJob = try XCTUnwrap(workflow.range(of: "  signed-build:"))
        let runtimeStep = try XCTUnwrap(workflow.range(of:
            "      - name: Run macOS product-flow UI smoke"))
        XCTAssertGreaterThan(runtimeStep.lowerBound, signedJob.lowerBound,
                             "the UI app needs the signed job's certificate and profiles")
        XCTAssertTrue(workflow.contains(
            "xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium"))
        XCTAssertTrue(workflow.contains("-destination 'platform=macOS'"))
        XCTAssertTrue(workflow.contains("-only-testing:RelayiumUITests test"))
        XCTAssertTrue(workflow.contains("timeout-minutes: 25"),
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
            let raw = try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
            let code = raw
                .components(separatedBy: "\n")
                .filter { line in
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                        && !trimmed.hasPrefix("/*")
                }
                .joined(separator: "\n")
            return (name, code)
        }
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
        for pane in [workspaceConnect, "UploadPane.swift"] {
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
        let pane = try source(named: workspaceSession)
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
        // The manifest must exist before the minting screen replaces the picker,
        // and the staging step now lives on the connect pane — which is exactly
        // where the picker it replaces lives.
        let connect = try source(named: workspaceConnect)
        guard let stage = connect.range(
                of: "fileModel.stageSend(sources: staged.sources, metas: staged.metas)"),
              let mint = connect.range(of: "await fileModel.mintCode(token: token)") else {
            return XCTFail("the file-code action lost staging or minting")
        }
        XCTAssertLessThan(stage.lowerBound, mint.lowerBound,
                          "the manifest must exist before the minting screen replaces the picker")

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
        for pane in [workspaceConnect, "UploadPane.swift"] {
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
    /// The Workspace makes that STRUCTURAL rather than per-state: the connect
    /// controls live in a different view, and the destination renders exactly one
    /// of the two panes. So the assertions are (1) the session pane names no
    /// connect control at all, and (2) the destination's branch is the whole
    /// reason it cannot.
    func testPairingTerminalStatesExposeOnlyTheirCleanupBoundary() throws {
        let session = try source(named: workspaceSession)
        for connectControl in ["createControls", "joinControls", "roster", "deviceRow",
                               "normalizedJoinCode", "CapabilityGateView"] {
            XCTAssertFalse(session.contains(connectControl),
                           "the live/terminal session surface exposes \(connectControl)")
        }
        XCTAssertTrue(session.contains("Button(L10n.t(.workspaceLeaveSession)) { leaveOrConfirm() }"),
                      "a retained terminal session has no explicit cleanup boundary")
        XCTAssertFalse(session.contains("buttonStyle(.link)"),
                       "a task mutation is presented as navigation")

        let destination = try source(named: workspaceDestination)
        XCTAssertTrue(destination.contains("if ownsSession || hasRetainedSession {"),
                      "the destination no longer chooses exactly one pane")
        XCTAssertTrue(destination.contains("WorkspaceSessionPane(")
                      && destination.contains("WorkspaceConnectPane("),
                      "the destination must render both phases of the one task")

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
        let source = try source(named: workspaceSession)
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

        let pane = try source(named: workspaceSession)
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
        let pane = try source(named: workspaceSession)
        XCTAssertTrue(pane.contains(
            "RealtimeFileSessionView(model: fileModel, onDone: finishCompletedFileTransfer)"))
        XCTAssertTrue(pane.contains("if fileModel.received == nil { selection.clear() }"))
        XCTAssertTrue(pane.contains("if mode == .files, case .failed = fileModel.state"),
                      "a failed outbound batch should return to connecting ready to retry")
        XCTAssertTrue(pane.contains("if !preservesFailedFiles { selection.clear() }"))
        XCTAssertEqual(occurrences(of: "selection.clear()", in: pane), 2,
                       "a third clear site is a third answer to what a finished task keeps")
    }

    /// Minting is a locked network wait: the idle controls are gone until the
    /// request settles, so both pairing modes need an explicit way back.
    func testPairingMintingCanBeCancelledInBothModes() throws {
        let pane = try source(named: workspaceSession)
        let fileMinting = try XCTUnwrap(pane.components(separatedBy: "case .minting:")
            .dropFirst().first?.components(separatedBy: "case let .showingCode").first)
        XCTAssertTrue(fileMinting.contains("Button(L10n.t(.commonCancel)) { fileModel.cancel() }"))
        XCTAssertTrue(fileMinting.contains(".buttonStyle(.bordered)"))

        let textMinting = try XCTUnwrap(pane.components(separatedBy: "case .minting:")
            .dropFirst().dropFirst().first?.components(separatedBy: "case let .showingCode").first)
        XCTAssertTrue(textMinting.contains("Button(L10n.t(.commonCancel)) { textModel.reset() }"))
        XCTAssertTrue(textMinting.contains(".buttonStyle(.bordered)"))
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
        XCTAssertTrue(app.contains("selectRealtimeMode: { mode in presenting.selectMode(mode) }"),
                      "the one surviving mode write is no longer the shared deep-link seam")
    }

    /// The verification setting is the one control that still has to lock at
    /// claim time rather than at busy time: the models read it when the SAS
    /// arrives, and ownership is taken synchronously before either model can
    /// publish a non-idle state.
    func testDirectChoicesLockAtClaimBeforeTheModelsBecomeBusy() throws {
        let destination = try source(named: workspaceDestination)
        XCTAssertTrue(destination.contains(
            "presence.owner != nil || hasRetainedSession"),
            "the lock reads busy flags that lag the synchronous claim")
        XCTAssertTrue(destination.contains(
            "set: { if !sessionLocked { verification.requiresSASConfirmation = $0 } }"),
            "verification can change after claim but before handshake state appears")
        XCTAssertTrue(destination.contains(".disabled(sessionLocked)"))
    }

    func testSessionOwnershipCleanupIsAppScopedAndNeverRunsFromInitialViewIdle() throws {
        let app = try source(named: "RelayiumApp.swift")
        // The link is the THIRD liveness source, in the SAME subscription. A
        // separate observer would release the surface the instant a link
        // started: a link uses neither legacy model, so both read idle for its
        // whole life.
        XCTAssertTrue(app.contains(
            "presenting.observeSessions(fileModel: files, textModel: text, link: unified)"))
        XCTAssertFalse(app.contains(
            "presenting.observeSessions(fileModel: files, textModel: text)\n"),
            "a second liveness subscription would race the first")
        for name in [workspaceDestination, workspaceConnect, workspaceSession] {
            let destination = try source(named: name)
            XCTAssertFalse(destination.contains("presence.releaseAll()"),
                           "\(name) can erase a fresh claim from its initial idle task")
        }
        // Only the owner may let go, and with two routes drawing one surface the
        // owner has to be ASKED rather than assumed.
        let session = try source(named: workspaceSession)
        XCTAssertTrue(session.contains("guard let owner = presence.owner,")
                      && session.contains("AppDestination.macWorkspaceRoutes.contains(owner)")
                      && session.contains("presence.release(owner)"),
                      "the Workspace releases a route it may not own")
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
        let pane = try source(named: workspaceSession)
        XCTAssertTrue(pane.contains("presence.sessionPeerLabel"))
        XCTAssertTrue(pane.contains("L10n.t(.nearbySessionWith"))
        XCTAssertTrue(pane.contains("L10n.t(.nearbySessionPeerDisclaimer)"),
                      "a peer-supplied label must not be presented as verified identity")
        // A pairing-code session has no roster label to snapshot. It says how the
        // peer was reached rather than leaving the header blank or, worse,
        // inventing a name for somebody nobody named.
        XCTAssertTrue(pane.contains("L10n.t(.workspaceSessionWithCode)"),
                      "a code-reached session renders no header at all")
        XCTAssertEqual(occurrences(of: ".accessibilityIdentifier(\"workspace-session-peer\")",
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
        let source = try source(named: workspaceSession)
        let text = try XCTUnwrap(source.components(
            separatedBy: "private var textLane:").dropFirst().first?
            .components(separatedBy: "private func codeHandoff").first)
        XCTAssertTrue(text.contains("cancel: { textModel.reset() }"),
                      "the text handoff lost its direct way back")
        XCTAssertFalse(text.contains("textModel.end()"),
                       "Cancel creates an empty Session ended task that still needs Done")
        let files = try XCTUnwrap(source.components(
            separatedBy: "private var fileLane:").dropFirst().first?
            .components(separatedBy: "private var textLane").first)
        XCTAssertTrue(files.contains("cancel: { fileModel.cancel() }"),
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
        let source = try source(named: workspaceSession)
        let handoff = try XCTUnwrap(source.components(
            separatedBy: "private func codeHandoff(").dropFirst().first?
            .components(separatedBy: "// MARK: - what this connection carries").first)
        XCTAssertTrue(handoff.contains("L10n.t(.pairingCodeExpiryNote)"),
                      "the expiry scope is ambiguous")
        XCTAssertTrue(handoff.contains(
            ".accessibilityIdentifier(\"pairing-code-expiry-note\")"))
        XCTAssertTrue(handoff.contains("L10n.t(.commonExpires,"))
    }

    /// The join link a code hands over still carries the kind the code was
    /// minted for. That is the one thing that makes a link-driven join
    /// unambiguous where a typed code cannot be.
    func testPairingHandoffPreservesTheModeThatCreatedTheCode() throws {
        let pane = try source(named: workspaceSession)
        XCTAssertTrue(pane.contains("productionPairingJoinURL(code: code, mode: mode)"),
                      "the handoff link must carry the lane it was minted for")
        XCTAssertTrue(pane.contains("mode: .files,") && pane.contains("mode: .text,"),
                      "both lanes must reach the shared handoff with their own kind")
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
        let source = try source(named: workspaceSession)
        let exit = try XCTUnwrap(source.components(
            separatedBy: "private var exit: some View").dropFirst().first)
            .components(separatedBy: "// MARK: - actions").first ?? ""

        XCTAssertTrue(exit.contains(".buttonStyle(.bordered)"))
        XCTAssertFalse(exit.contains(".buttonStyle(.link)"),
                       "Leave this session is exposed as a navigation Link")
        XCTAssertTrue(exit.contains("if hasRetainedSession && !modelBusy"),
                      "a claimed owner made the terminal exit permanently unreachable")
        XCTAssertTrue(exit.contains(".accessibilityIdentifier(\"workspace-leave-session\")"),
                      "the one exit has no stable runtime identity")
        // Exactly one exit for the whole surface. Two — one per lane, as the two
        // panes this replaced had — is what let "Back to devices" and "Done"
        // disagree about what a finished task keeps.
        XCTAssertEqual(occurrences(of: "L10n.t(.workspaceLeaveSession)", in: source), 2,
                       "the exit exists once, plus its confirmation")
    }

    func testNearbyLocalTextCannotBeDiscardedByAnUnconfirmedExit() throws {
        let source = try source(named: workspaceSession)
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
        XCTAssertFalse(try source(named: "Workspace/WorkspaceLinkPane.swift")
            .contains("link-sas"),
                       "a caller wrapper split the verification identifier from its label")
    }

    func testUITestPairingRoomsUseTheOfflineLinkFixture() throws {
        let mode = try source(named: "UITestMode.swift")
        XCTAssertTrue(mode.contains("static func makeLinkWorkspaceModel"))
        XCTAssertTrue(mode.contains("iceClient: UITestWaitingICEClient()"))
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("UITestMode.makeLinkWorkspaceModel("),
                      "UI acceptance still reaches the production pairing ICE client")
    }

    /// Five destination files, one per `MacSurface`, and the five the Workspace
    /// replaced are gone rather than merely unreferenced.
    ///
    /// The absence half is the load-bearing one. A revert that left
    /// `NearbyDestination.swift` on disk would compile — the project group is
    /// filesystem-synchronized — and would put the second row back in the
    /// sidebar the moment anybody added a `row(.nearby,` line, with no diff
    /// against this file to explain it.
    func testTheFiveDestinationFilesExist() {
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
    /// Checked against `MacSurface.allCases` rather than `AppDestination`, and
    /// that substitution IS this round: `.nearby` and `.pairingCode` are two
    /// routes into one screen, so the sidebar owes the user one row for them and
    /// the shell owes one arm.
    ///
    /// The count assertion is what makes the merge stick. Adding a second direct
    /// row back — under any name — fails here rather than shipping.
    func testEveryDestinationIsBothASidebarRowAndAShellArm() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        let shell = try source(named: "Shell/AppShellView.swift")
        for surface in MacSurface.allCases {
            XCTAssertTrue(sidebar.contains("row(.\(surface.rawValue),"),
                          "the sidebar has no row for \(surface.rawValue)")
            XCTAssertTrue(shell.contains("case .\(surface.rawValue):"),
                          "the shell renders nothing for \(surface.rawValue)")
        }
        XCTAssertEqual(occurrences(of: "row(.", in: sidebar), MacSurface.allCases.count,
                       "the sidebar renders a row for something that is not a macOS surface")
        XCTAssertEqual(MacSurface.allCases.count, 5)
        // Every destination reaches a surface, and the two direct routes reach
        // the same one. Derived from the enum rather than restated, so a seventh
        // destination cannot be added without answering the question.
        XCTAssertEqual(Set(AppDestination.macWorkspaceRoutes.map(\.macSurface)), [.workspace])
        XCTAssertEqual(Set(AppDestination.allCases.map(\.macSurface)),
                       Set(MacSurface.allCases),
                       "a macOS surface exists that no destination can reach")
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
        let text = try source(named: "Destinations/StoredReceiveDestination.swift")
        for symbol in ["AccountSession", "bearerToken", "session.state", "AccountGate"] {
            XCTAssertFalse(text.contains(symbol),
                           "StoredReceiveDestination must not depend on an account: \(symbol)")
        }
    }

    /// **The Workspace has an account-backed half now, and exactly one.**
    ///
    /// It holds `AccountSession` because minting a pairing code reserves relay
    /// capacity billed to whoever created it. Everything else on the surface —
    /// both directions of same-network transfer, and joining a code somebody
    /// else created — reaches the transport with no credential at all, so the
    /// gate must wrap the create controls and nothing else.
    ///
    /// That is checked positionally rather than by presence, because "the file
    /// contains a gate" is true of the correct and the broken version alike. The
    /// gate has to sit inside the pairing card, after the roster, and the join
    /// controls have to sit outside it.
    func testTheWorkspaceGatesOnlyTheHalfThatSpendsAnAccount() throws {
        let connect = try source(named: workspaceConnect)
        XCTAssertEqual(occurrences(of: "CapabilityGateView(", in: connect), 1,
                       "a second gate on this surface is a second account wall")
        guard let sameNetwork = connect.range(of: "private var sameNetwork: some View"),
              let gate = connect.range(of: "CapabilityGateView(gate: gate,"),
              let join = connect.range(of: "private var joinControls: some View") else {
            return XCTFail("the connect pane no longer has the shape this guards")
        }
        XCTAssertLessThan(sameNetwork.lowerBound, gate.lowerBound,
                          "same-network transfer must not sit behind the account gate")
        XCTAssertLessThan(gate.upperBound, join.lowerBound,
                          "joining somebody else's code must not sit behind the account gate")
        // The gate wraps the create half only — `if case .allowed` selects
        // between the create controls and the gate, and nothing else.
        XCTAssertTrue(connect.contains("if case .allowed = gate {\n                    createControls\n                } else {"),
                      "the account gate no longer selects exactly the create controls")
        // Neither the roster nor the join field may consult the account at all.
        for anonymous in ["private var receiving: some View",
                          "private var roster: some View",
                          "private var joinControls: some View"] {
            guard let start = connect.range(of: anonymous) else {
                return XCTFail("the connect pane lost \(anonymous)")
            }
            let body = connect[start.upperBound...].prefix(1200)
            for symbol in ["gate", "accessNow", "session.state", "bearerToken"] {
                XCTAssertFalse(body.contains(symbol),
                               "\(anonymous) consults the account: \(symbol)")
            }
        }
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
        let pane = try source(named: workspaceSession)
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

    /// Sidebar captions are product navigation, not decorative metadata. macOS
    /// List rows otherwise inherit a single-line limit and silently replace the
    /// end of the promise with an ellipsis at the supported window floor.
    /// Section labels are explicit because the AX outline does not infer useful
    /// names from the custom section headers reliably.
    func testSidebarKeepsVisibleSubtitlesAndNamedSections() throws {
        let sidebar = try source(named: "Shell/SidebarView.swift")
        XCTAssertTrue(sidebar.contains(".lineLimit(3)"),
                      "sidebar subtitles must be visible rather than one-line ellipses")
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
        for kept in [".accessibilityElement(children: .ignore)",
                     ".accessibilityLabel(title)",
                     ".accessibilityAddTraits(.isHeader)"] {
            XCTAssertTrue(sidebar.contains(kept), "the section header lost \(kept)")
        }
        // The merged row keeps a title and a subtitle like every other one, and
        // the subtitle has to name BOTH ways of reaching a peer — it is the only
        // place the sidebar can still say that a pairing code lives here.
        XCTAssertTrue(sidebar.contains("title: L10n.t(.navWorkspace)"))
        XCTAssertTrue(sidebar.contains("subtitle: L10n.t(.navWorkspaceSubtitle)"))
        for retired in ["navNearby", "navNearbySubtitle", "navPairingCode",
                        "navPairingCodeSubtitle"] {
            XCTAssertFalse(sidebar.contains(retired),
                           "the sidebar still names a row this round merged: \(retired)")
        }
    }

    /// Lists and rosters use the available detail-column width; forms and prose
    /// retain the 720pt reading measure. This is an opt-in on exactly the two
    /// destinations with wide structured data, so making every screen stretch
    /// cannot happen as an accidental scaffold edit.
    func testOnlyStructuredDataDestinationsOptOutOfTheReadingMeasure() throws {
        for file in [workspaceDestination,
                     "Destinations/AccountDestination.swift",
                     // A grouped `Form` of controls, not prose.
                     "Destinations/DeviceInboxDestination.swift"] {
            XCTAssertTrue(try source(named: file).contains("contentMaxWidth: nil"),
                          "\(file) must let its roster/list use the detail column")
        }
        // Exactly one destination supplies its own scrolling, and it is the one
        // whose content is a `Form` — which is already a scroll view. A second
        // opt-out is a screen whose content silently stops scrolling at all.
        let optedOut = try ["Workspace", "StoredSend", "StoredReceive",
                            "DeviceInbox", "Account"]
            .filter { try source(named: "Destinations/\($0)Destination.swift")
                .contains("scrolls: false") }
        XCTAssertEqual(optedOut, ["DeviceInbox"],
                       "a destination opted out of the scaffold's scroll view")
        for file in ["Destinations/StoredSendDestination.swift",
                     "Destinations/StoredReceiveDestination.swift"] {
            XCTAssertFalse(try source(named: file).contains("contentMaxWidth: nil"),
                           "\(file) should keep the prose/form reading measure")
        }
        // The Workspace opts its ROSTER out and constrains its prose locally:
        // the destination takes the width, and every paragraph on it is still
        // capped at the reading measure.
        let connect = try source(named: workspaceConnect)
        XCTAssertTrue(connect.contains(".frame(maxWidth: .infinity, alignment: .leading)"),
                      "the roster's container must accept the available width")
        XCTAssertGreaterThanOrEqual(
            occurrences(of: ".frame(maxWidth: 720, alignment: .leading)", in: connect), 4,
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
        XCTAssertFalse(shared.contains("@State") && shared.contains("AuthMode"),
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
        XCTAssertTrue(gate.contains("Button(L10n.t(.gateOpenAccount)) { onAccount(.signIn) }"),
                      "an unverified address is finished on the Account destination, "
                      + "which owns the resend action — not on a website")
        for caller in ["UploadPane.swift", workspaceConnect] {
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
        for wiring in ["navigation: routing, download: downloads,",
                       "realtime: files, realtimeText: text, presence: presenting,",
                       "selectRealtimeMode: { mode in presenting.selectMode(mode) }",
                       "_presence = StateObject(wrappedValue: presenting)",
                       "_navigation = StateObject(wrappedValue: routing)",
                       "_downloadModel = StateObject(wrappedValue: downloads)",
                       "_realtimeModel = StateObject(wrappedValue: files)",
                       "_realtimeTextModel = StateObject(wrappedValue: text)"] {
            XCTAssertTrue(app.contains(wiring),
                          "the coordinator must share the app's models: \(wiring)")
        }
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
        XCTAssertTrue(app.contains("realtimeTextModel.hasLocalContent"))
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
        for reaching in ["AppRouting.destination(forOpenedFiles", "SelectionStore",
                         "selection.add("] {
            XCTAssertFalse(app.contains(reaching),
                           "RelayiumApp stages opened files itself: \(reaching)")
        }
    }

    /// Exactly the three panes that can send files adopt a batch, each for its
    /// own destination, and none of them re-derives when it may.
    ///
    /// The negative half is the load-bearing one. A pane that read `staged`
    /// directly would be a second copy of the busy rule — and the copy that
    /// contradicts the disabled drop zone beside it.
    func testOnlyTheThreeSendPanesAdoptOpenedFilesAndNoneReDerivesTheRule() throws {
        // Two panes now, and the Workspace's ask is the SET of its own routes.
        // `AppRouting.destination(forOpenedFiles:)` still addresses a batch to
        // `.nearby` or `.pairingCode` — untouched, and iOS-shared — so a Dock
        // drop that lands while a pairing-code deep link owns the selection is
        // still addressed to a route this one screen renders.
        let panes: [(file: String, destination: String)] = [
            (workspaceConnect, "forAnyOf: AppDestination.macWorkspaceRoutes"),
            ("UploadPane.swift", "for: .storedSend"),
        ]
        for pane in panes {
            let text = try source(named: pane.file)
            XCTAssertTrue(text.contains("fileOpenRouting.batch(\(pane.destination),"),
                          "\(pane.file) must ask the coordinator for its own destination's batch")
            XCTAssertTrue(text.contains("selection.add(batch.urls)"),
                          "\(pane.file) must append rather than replace what the user already picked")
            XCTAssertTrue(text.contains("fileOpenRouting.consume(batch)"),
                          "\(pane.file) must consume the batch it staged")
            // Keyed on BOTH facts. Keyed on the batch alone, one that arrived
            // mid-transfer is never republished and therefore never lands.
            XCTAssertTrue(text.contains("FileOpenAdoption(staged: fileOpenRouting.staged, busy:"),
                          "\(pane.file) must re-ask adoption when either the batch or busy changes")
        }

        // Nobody else touches the coordinator's state, and nobody reads `staged`
        // to decide for themselves.
        let all = try sources(under: macRoot, atLeast: 20)
        let adopters = all.filter { $0.text.contains("fileOpenRouting.batch(") }
        XCTAssertEqual(Set(adopters.map(\.name)), Set(panes.map(\.file)),
                       "exactly the three send panes may adopt opened files")
        for file in all where !panes.map(\.file).contains(file.name) {
            XCTAssertFalse(file.text.contains("fileOpenRouting.consume("),
                           "\(file.name) consumes a batch it did not stage")
        }
        // Three destinations, three panes, no two claiming the same one.
        XCTAssertEqual(Set(panes.map(\.destination)).count, panes.count)
    }

    /// Nearby and Pairing claim a surface before their async start moves a
    /// realtime model to busy. Open With/Dock Drop must treat that ownership as
    /// busy too, and key the task on the combined answer so release retries it.
    func testRealtimeOpenedFilesWaitForClaimedSessionOwnershipToClear() throws {
        let connect = try source(named: workspaceConnect)
        XCTAssertTrue(connect.contains(
            "private var fileAdoptionBusy: Bool { presence.owner != nil || modelBusy }"))
        XCTAssertTrue(connect.contains(
            "FileOpenAdoption(staged: fileOpenRouting.staged, busy: fileAdoptionBusy)"))
        XCTAssertTrue(connect.contains(
            "fileOpenRouting.batch(forAnyOf: AppDestination.macWorkspaceRoutes,"))
        XCTAssertTrue(connect.contains("busy: fileAdoptionBusy)"))
        // `presence.owner` is ANY owner, not just this surface's: a stored-send
        // claim is still a reason not to mutate a selection behind the user.
        XCTAssertFalse(connect.contains("presence.rendersSession("),
                       "adoption must stop for every claim, not only this one's")
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

        let connect = try source(named: workspaceConnect)
        XCTAssertTrue(connect.contains(
            "FileDropZone(store: selection, isBusy: { fileAdoptionBusy })"))
        XCTAssertEqual(occurrences(of: "FileDropZone(", in: connect), 1,
                       "one surface, one drop target — two would be two selections")
        XCTAssertTrue(try source(named: "UploadPane.swift").contains(
            "FileDropZone(store: selection, isBusy: { model.isBusy })"))
    }

    /// Claim refusal is a real concurrency result, not an impossible branch:
    /// an inbound offer can win between the last render and an outbound click.
    /// Every macOS start path must stop before touching its shared model.
    /// Five outbound starts, five claims — one per verb, each naming its own
    /// route AND its own kind. That the kind is now written by the claim rather
    /// than read from a picker is the whole mode-picker removal: there is no
    /// moment at which an intent exists without ownership behind it.
    func testEveryOutboundRealtimeStartRequiresItsSurfaceClaim() throws {
        let connect = try source(named: workspaceConnect)
        let claims = [
            "guard presence.beginSession(.nearby, mode: .text, peerLabel: live.label) else { return }",
            "guard presence.beginSession(.nearby, mode: .files, peerLabel: live.label) else { return }",
            "guard presence.beginSession(.pairingCode, mode: mode) else { return }",
            "guard presence.beginSession(.pairingCode, mode: .files) else { return }",
            "guard presence.beginSession(.pairingCode, mode: .text) else { return }",
        ]
        // The two unified-link starts. They take the mode-less claim, because a
        // link has no files-or-text mode to arbitrate — and each RELEASES the
        // claim when the link refuses, which the mode-carrying legacy paths do
        // not need because their models publish a failure state instead.
        let linkClaims = [
            "guard presence.beginSession(.nearby, peerLabel: live.label) else { return }",
        ]
        for claim in linkClaims {
            XCTAssertEqual(occurrences(of: claim, in: connect), 2,
                           "both link starts claim the surface before connecting")
        }
        XCTAssertEqual(occurrences(of: "presence.release(.nearby)", in: connect), 2,
                       "a refused link must hand the surface back rather than strand it")
        for claim in claims {
            XCTAssertEqual(occurrences(of: claim, in: connect), 1,
                           "the Workspace can start a shared model after losing ownership: \(claim)")
        }
        // Every start is behind one. A bare `Task { await` that no claim
        // precedes is the regression this counts.
        XCTAssertEqual(occurrences(of: "presence.beginSession(", in: connect),
                       claims.count + 2,
                       "a start path exists with no ownership claim, or a claim with no start")
    }

    func testPairingJoinSnapshotsAValidatedCodeBeforeClaimAndTask() throws {
        let source = try source(named: workspaceConnect)
        for model in ["fileModel", "textModel"] {
            XCTAssertTrue(source.contains("let code = \(model).joinCode"))
            XCTAssertTrue(source.contains("guard \(model).canJoin else { return }"))
            // The join itself now runs inside `watch`'s fallback closure — the
            // room is watched for a `link/1` peer first — but the SNAPSHOT rule
            // is unchanged and is what this guards: the code is read once,
            // validated, and then only the local `code` is used.
            XCTAssertTrue(source.contains("await \(model).join(code: code)"))
            XCTAssertFalse(source.contains("\(model).join(code: \(model).joinCode)"),
                           "the join reads mutable input after taking ownership")
        }
    }

    /// **One field, both models.** The two join verbs share a code, so the
    /// binding writes both models in the one state transition. Writing only one
    /// would leave the two buttons disagreeing about which code this device is
    /// about to join — the same class of drift the old two-pane split had, moved
    /// one level down and made unrepresentable instead.
    func testPairingJoinNormalizesAtomicallyInBothModes() throws {
        let source = try source(named: workspaceConnect)
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
        XCTAssertTrue(ui.contains("testWorkspaceJoinKeepsACompleteCodeActionableForBothVerbs"))
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
    /// the batch (a useless code for an unreadable selection is worse than a
    /// refusal), re-read live access, claim ownership, and only then start async
    /// work. One `createCode(mode:)` now, so the ordering is stated once instead
    /// of twice with a chance to disagree.
    func testPairingCreateSettlesIntentBeforeStartingAsyncMint() throws {
        let connect = try source(named: workspaceConnect)
        XCTAssertTrue(connect.contains(
            "Button(L10n.t(.workspaceCreateMessageCode)) { createCode(mode: .text) }"))
        XCTAssertTrue(connect.contains(
            "Button(L10n.t(.workspaceCreateFileCode)) { createCode(mode: .files) }"))
        guard let create = connect.range(of: "private func createCode(mode: TransferMode) {"),
              let staged = connect.range(of: "guard let ready = stage() else { return }",
                                         range: create.lowerBound..<connect.endIndex),
              let access = connect.range(of: "guard let access = accessNow() else {",
                                         range: staged.lowerBound..<connect.endIndex),
              let claim = connect.range(of:
                "guard presence.beginSession(.pairingCode, mode: mode) else { return }",
                range: access.lowerBound..<connect.endIndex),
              let task = connect.range(
                of: "Task { await mintAndWatch(mode: .files, token: access.token, staged: staged) }",
                range: claim.lowerBound..<connect.endIndex),
              let textTask = connect.range(
                of: "Task { await mintAndWatch(mode: .text, token: access.token, staged: nil) }",
                range: claim.lowerBound..<connect.endIndex) else {
            return XCTFail("code creation lost its synchronous intent boundary")
        }
        XCTAssertLessThan(task.lowerBound, textTask.lowerBound)
        // A message code needs nothing staged, and that asymmetry has to be
        // visible in the source rather than only in the disabled state: only the
        // files arm expands a selection.
        XCTAssertTrue(connect.contains("if mode == .files {"),
                      "creating a message code must not require a staged batch")
    }

    /// Account gating is presentation, not authorization. A button from the
    /// preceding render may still be delivered after sign-out or credential
    /// replacement, so every authenticated macOS start re-reads live access.
    func testAuthenticatedMacStartsDoNotSpendRenderTimeCredentials() throws {
        let destination = try source(named: workspaceDestination)
        XCTAssertTrue(destination.contains("AccountGate.from(session.state,"))
        XCTAssertEqual(occurrences(of: "accessNow: { accessNow }", in: destination), 1,
                       "one surface, one live-access seam")

        let connect = try source(named: workspaceConnect)
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
        let pane = try source(named: workspaceConnect)
        let staleGate = try XCTUnwrap(pane.components(
            separatedBy: "guard let access = accessNow() else {").dropFirst().first?
            .components(separatedBy: "return").first)
        XCTAssertTrue(staleGate.contains("navigation.selectAccount(intent: .signIn)"),
                      "the Workspace silently swallowed a stale Create activation")
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
        XCTAssertTrue(app.contains("SettingsView(updater: updaterController.updater)"),
                      "the settings scene must drive the app's one updater, not a second")
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

    /// The settings surface reports the system, and states every case it cannot
    /// show as a switch.
    func testTheLoginSettingReportsTheSystemAndExplainsEveryStateItCannotShow() throws {
        let settings = try source(named: "Settings/SettingsView.swift")

        // Bound to what macOS says, never to what was requested. A switch built
        // from the requested value snaps to on for a registration macOS is still
        // holding for approval — the app asserting a residency it lacks.
        XCTAssertTrue(settings.contains("get: { loginItem.state == .on }"),
                      "the switch must read the system's answer")
        XCTAssertFalse(settings.contains("@State private var opensAtLogin"),
                       "a mirrored boolean would drift from the system")

        // Every state that is not a plain on/off says what it is and what
        // resolves it. A greyed switch with no sentence beside it is the dead
        // control this app's design rules forbid.
        for state in ["case .needsApproval", "case .unavailable"] {
            XCTAssertTrue(settings.contains(state), "the settings pane ignores \(state)")
        }
        for copy in ["settingsLoginNeedsApproval", "settingsLoginUnavailable",
                     "settingsLoginRefused", "settingsOpenLoginItems"] {
            XCTAssertTrue(settings.contains(copy), "\(copy) is never rendered")
        }
        // The user can change this in System Settings while the app runs and
        // nothing notifies it, so the pane re-asks on appear.
        XCTAssertTrue(settings.contains("loginItem.refresh()"),
                      "the pane must re-read the system when it appears")
    }

    /// The updates pane says what the old lone menu item could not, and reads
    /// every one of those facts from the thing that owns it.
    func testTheUpdatesPaneReadsSparkleAndTheBundleRatherThanRestatingThem() throws {
        let settings = try source(named: "Settings/SettingsView.swift")
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
        XCTAssertTrue(sidebar.contains("fileModel.isBusy || textModel.isBusy"),
                      "activity must come from the session models, not from a cached flag")
        // The Workspace row asks about BOTH of its routes: `TransferPresence`
        // still arbitrates per route, so a pairing-code session would go
        // unmarked if the row only asked about the one its click selects.
        XCTAssertTrue(sidebar.contains(
            "AppDestination.macWorkspaceRoutes.contains {"),
            "the Workspace row can miss a session owned by its other route")
        XCTAssertFalse(sidebar.contains("surface == .storedSend"),
                       "the marker must not be hard-coded to one surface")
        XCTAssertFalse(sidebar.contains("receive.activeKind"),
                       "NearbyReceiveModel keeps residency and loses the session marker")
        XCTAssertTrue(sidebar.contains("NearbyStatusPresentation.text(for: receive.state)"),
                      "residency is still NearbyReceiveModel's to report")

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
    /// **Message-first, and it is visible in the source rather than only in a
    /// screenshot.** On a chosen device the prominent verb is the one with no
    /// precondition at all; the file verb sits beside it, bordered, disabled
    /// until something is staged. The pairing card mirrors that: the message
    /// code is prominent, the file code is not.
    func testTheWorkspaceLeadsWithTheMessageIntentAndKeepsFileActionsBesideIt() throws {
        let connect = try source(named: workspaceConnect)
        let messageAction = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceSendMessage)) { startMessage(with: device) }"))
        let fileAction = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceSendFiles)) { sendFiles(to: device) }"))
        XCTAssertLessThan(messageAction.lowerBound, fileAction.lowerBound,
                          "the file action is offered before the default message intent")
        let messageStyling = String(connect[messageAction.upperBound..<fileAction.lowerBound])
        XCTAssertTrue(messageStyling.contains(".buttonStyle(.borderedProminent)"),
                      "the default intent is not the prominent one")
        XCTAssertFalse(messageStyling.contains(".disabled(selection.isEmpty"),
                       "the message intent must not require a staged selection")
        XCTAssertTrue(connect.contains(".disabled(selection.isEmpty || modelBusy)"),
                      "the file action must state its own precondition")

        // Both verbs, and both connection methods, carry stable runtime
        // identities — this is what the UI suite proves ONE screen offers.
        for identifier in ["workspace-send-message", "workspace-send-files",
                           "workspace-create-message-code", "workspace-create-file-code",
                           "workspace-join-messages", "workspace-join-files",
                           "workspace-choose-files", "workspace-staging-optional"] {
            XCTAssertTrue(connect.contains(".accessibilityIdentifier(\"\(identifier)\")"),
                          "the Workspace lost its \(identifier) control")
        }

        // The pairing card leads with messages too.
        let createMessage = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceCreateMessageCode)) { createCode(mode: .text) }"))
        let createFile = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceCreateFileCode)) { createCode(mode: .files) }"))
        XCTAssertLessThan(createMessage.lowerBound, createFile.lowerBound)
        let joinMessages = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceJoinMessages)) { join(mode: .text) }"))
        let joinFiles = try XCTUnwrap(connect.range(
            of: "Button(L10n.t(.workspaceJoinFiles)) { join(mode: .files) }"))
        XCTAssertLessThan(joinMessages.lowerBound, joinFiles.lowerBound)
    }

    /// **Never claim that one legacy connection carries both lanes.**
    ///
    /// The surface is unified; a legacy session is not. Once capability
    /// negotiation has selected that session pane, it names the lane the
    /// connection does NOT have. The connect phase cannot make that claim for a
    /// pairing code whose peer is not known yet.
    func testTheWorkspaceStatesTheOneLaneLimitOnlyAfterCapabilityIsKnown() throws {
        let connect = try source(named: workspaceConnect)
        XCTAssertFalse(connect.contains(".accessibilityIdentifier(\"workspace-one-connection-note\")"),
                       "the connect phase guesses a pairing peer's capability")

        let session = try source(named: workspaceSession)
        XCTAssertTrue(session.contains(
            "L10n.t(mode == .text ? .workspaceMessagesOnlyNote : .workspaceFilesOnlyNote)"),
            "a live session no longer names the lane it does not have")
        XCTAssertTrue(session.contains(".accessibilityIdentifier(\"workspace-lane-note\")"))
        XCTAssertTrue(session.contains("if peerCapabilityIsKnown { laneNote }"),
                      "the lane warning is shown before a pairing peer is classified")
        XCTAssertTrue(session.contains("case .idle, .minting, .showingCode, .failed:"),
                      "a no-peer failure is described as a classified legacy connection")
        XCTAssertTrue(session.contains("workspace-waiting-pairing-peer"))
        XCTAssertTrue(session.contains("workspace-cancel-pairing-watch"))
        guard let laneNote = session.range(of: "private var laneNote: some View"),
              let body = session.range(of: "var body: some View") else {
            return XCTFail("the session pane no longer has the shape this guards")
        }
        XCTAssertLessThan(body.lowerBound, laneNote.lowerBound)
        XCTAssertTrue(session.contains("if peerCapabilityIsKnown { laneNote }\n            exit"),
                      "the lane note must sit with the exit rather than inside one lane")
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
        let connect = try source(named: workspaceConnect)

        // Per device, branching on the peer's own announcement.
        XCTAssertTrue(connect.contains("""
            InlineMessage(.info, L10n.t(device.supportsLink
                                        ? .linkOneConnectionNote
                                        : .workspaceOneConnectionNote))
"""), "the device actions no longer state what THAT device's connection carries")
        XCTAssertTrue(connect.contains(
            ".accessibilityIdentifier(\"workspace-device-connection-note\")"))

        // A pairing code has no peer yet, so neither connection-shape claim is
        // made until negotiation selects a session pane.
        guard let pairing = connect.range(of: "private var pairingCode: some View"),
              let create = connect.range(of: "private var createControls: some View") else {
            return XCTFail("the connect pane no longer has the shape this guards")
        }
        let pairingBody = String(connect[pairing.lowerBound..<create.lowerBound])
        XCTAssertFalse(pairingBody.contains("workspaceOneConnectionNote"),
                       "pairing-code setup guessed a legacy peer")
        XCTAssertFalse(pairingBody.contains("linkOneConnectionNote"),
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
    func testJoinIsTheOnlyKeyboardDefaultOnTheWorkspace() throws {
        let text = try source(named: workspaceConnect)
        XCTAssertEqual(occurrences(of: ".keyboardShortcut(.defaultAction)", in: text), 1,
                       "the Workspace must not offer two competing default buttons")
        assertDefaultAction(attachesTo: "Button(L10n.t(.workspaceJoinMessages))",
                            in: text, named: workspaceConnect)
        XCTAssertTrue(text.contains(".disabled(!textModel.canJoin)"),
                      "the default action must stay inert until six digits are in")
        XCTAssertTrue(text.contains("fileModel.updateJoinCode($0)")
                      && text.contains("textModel.updateJoinCode($0)"),
                      "six-digit normalization — including a leading 1 — must survive")
        // And exactly one on this surface's other file: the session pane must
        // not inherit a default from the phase that started it, because Return
        // over a transfer in flight has nothing safe to mean.
        for name in [workspaceDestination, workspaceSession] {
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

    /// One file may name the failure colour, and it is the one that always draws
    /// a symbol beside it. Everywhere else, red on its own is the whole message —
    /// which is no message at all under a colour filter, in Increase Contrast, or
    /// to a reader who cannot distinguish it. Counting the files is what keeps
    /// that a rule rather than an intention, exactly as for `.system(size:`.
    func testExactlyOneFileNamesTheFailureColour() throws {
        XCTAssertEqual(try sources(under: macRoot, atLeast: 20)
            .filter { namesTheFailureColour($0.text) }.map(\.name),
                       ["Components/InlineMessage.swift"])
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
    ///  3. On 2026-08-10 the immutable GitHub Release `macos-v1.0` was published
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
    /// the exact immutable tag — `macos-v1.0`, which resolves to one GitHub
    /// Release and one DMG — rather than say "released" and leave the reader to
    /// find out where. They must also say what the artifact IS (Developer
    /// ID-signed and Apple-notarized), because "there is a download" and "the
    /// download is one Gatekeeper will run" are different promises.
    ///
    /// Deliberately not asserted here: anything about relayium.com. Whether the
    /// `/apps` page offers the download is a different fact, owned by
    /// `web/native-releases.json` and its own dual-state tests, and a Swift
    /// guard that conflated the two would go red every time the site and the
    /// release moved in separate commits — which is exactly how they move.
    func testTheDocsNameTheMacOSReleaseAReaderCanActuallyFetch() throws {
        for path in ["README.md", "apps/README.md"] {
            let text = try claimSurfaceText(path)
            XCTAssertTrue(text.contains("macos-v1.0"),
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
        let apps = flattened(try claimSurfaceText("apps/README.md"))
        XCTAssertTrue(apps.contains("**Status: released as 1.0.**"),
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

}
