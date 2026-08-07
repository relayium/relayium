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
        let pane = try source(named: "NearbyPane.swift")
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

    func testRealtimeFileDetailsSurviveTransferAndCompletion() throws {
        let view = try source(named: "RealtimeFileSessionView.swift")
        XCTAssertGreaterThanOrEqual(view.components(separatedBy: "fileList").count - 1, 3,
                                    "the manifest must render while active and after completion")
        XCTAssertTrue(view.contains("model.sessionFiles"))
        XCTAssertTrue(view.contains("L10n.bytes(Int64(file.size))"),
                      "file identity without size does not meet the send confirmation standard")
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
        for required in ["safeDisplayName(file.relativePath)", "L10n.bytes(bytes)",
                         "ScrollView", ".frame(maxHeight: 200)"] {
            XCTAssertTrue(component.contains(required), "pending-file list lost \(required)")
        }
        for pane in ["NearbyPane.swift", "DirectPane.swift", "UploadPane.swift"] {
            XCTAssertTrue(try source(named: pane).contains("PendingFileList(files:"),
                          "\(pane) regressed to a count-only selection")
        }
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
        for f in ["Destinations/NearbyDestination.swift",
                  "Destinations/StoredReceiveDestination.swift"] {
            let text = try source(named: f)
            for symbol in ["AccountSession", "bearerToken", "session.state", "AccountGate"] {
                XCTAssertFalse(text.contains(symbol), "\(f) must not depend on an account: \(symbol)")
            }
        }
    }

    /// Every pairing-code terminal surface can be dismissed, and only those.
    ///
    /// A terminal state is deliberately NOT `.idle` — a completed transfer's
    /// result, a message transcript and a failure all keep their place on screen
    /// instead of blinking past. Both direct destinations reconcile presence on
    /// "both models are `.idle`", so a terminal surface with no way out holds the
    /// claim for as long as the user leaves it there, and the other destination
    /// stays on its "shown elsewhere" card with no way back. The wiring that
    /// closes that is one Button per surface, which is exactly the kind of thing
    /// a later refactor drops without any test noticing.
    ///
    /// Bounded to the terminal branch on both sides rather than merely present
    /// in the file: a Done offered on `.connecting` or `.open` would abandon a
    /// live session on a button whose label promises the opposite.
    func testEveryPairingCodeTerminalSurfaceCarriesExactlyOneDone() throws {
        let surfaces = [
            (file: "DirectPane.swift",
             begins: "if case let .failed(message) = model.state {",
             ends: Optional<String>.none,
             dismisses: "Button(L10n.t(.commonDone)) { model.cancel() }"),
            (file: "RealtimeTextPane.swift",
             begins: "case .failed, .ended, .refused, .unsupported:",
             ends: Optional("case .minting:"),
             dismisses: "Button(L10n.t(.commonDone)) { model.reset() }"),
        ]
        for surface in surfaces {
            let text = try source(named: surface.file)
            XCTAssertEqual(text.components(separatedBy: ".commonDone").count - 1, 1,
                           "\(surface.file) must carry exactly one Done")
            XCTAssertTrue(text.contains(surface.dismisses),
                          "\(surface.file) must dismiss with \(surface.dismisses)")
            guard let done = text.range(of: ".commonDone"),
                  let begins = text.range(of: surface.begins) else {
                return XCTFail("\(surface.file) no longer has the branch this guards")
            }
            XCTAssertTrue(done.lowerBound > begins.upperBound,
                          "\(surface.file)'s Done is before its terminal branch")
            if let marker = surface.ends {
                guard let ends = text.range(of: marker) else {
                    return XCTFail("\(surface.file) no longer has \(marker)")
                }
                XCTAssertTrue(done.upperBound < ends.lowerBound,
                              "\(surface.file)'s Done escaped into a live state")
            }
        }
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
        XCTAssertEqual(occurrences(of: "sectionHeader(.navSection", in: sidebar), 2,
                       "both transfer groups need the named accessibility header")
        for kept in [".accessibilityElement(children: .ignore)",
                     ".accessibilityLabel(title)",
                     ".accessibilityAddTraits(.isHeader)"] {
            XCTAssertTrue(sidebar.contains(kept), "the section header lost \(kept)")
        }
    }

    /// Lists and rosters use the available detail-column width; forms and prose
    /// retain the 720pt reading measure. This is an opt-in on exactly the two
    /// destinations with wide structured data, so making every screen stretch
    /// cannot happen as an accidental scaffold edit.
    func testOnlyStructuredDataDestinationsOptOutOfTheReadingMeasure() throws {
        for file in ["Destinations/NearbyDestination.swift",
                     "Destinations/AccountDestination.swift"] {
            XCTAssertTrue(try source(named: file).contains("contentMaxWidth: nil"),
                          "\(file) must let its roster/list use the detail column")
        }
        for file in ["Destinations/PairingCodeDestination.swift",
                     "Destinations/StoredSendDestination.swift",
                     "Destinations/StoredReceiveDestination.swift"] {
            XCTAssertFalse(try source(named: file).contains("contentMaxWidth: nil"),
                           "\(file) should keep the prose/form reading measure")
        }
        let nearby = try source(named: "NearbyPane.swift")
        XCTAssertTrue(nearby.contains(".frame(maxWidth: .infinity, alignment: .leading)"),
                      "the nearby roster's container must accept the available width")
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
        XCTAssertTrue(upload.contains("case .picked:\n            if case let .allowed(access) = gate"),
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
        XCTAssertTrue(login.contains("SignInPresentation.problem(in: draft)"),
                      "the substantive checks run before a request goes out")
        for (name, text) in try sources(under: macRoot, atLeast: 20)
        where name != "LoginView.swift" && name != "Components/CapabilityGateView.swift" {
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
        XCTAssertTrue(gate.contains("Button(L10n.t(.gateOpenAccount)) { onAccount(.signIn) }"),
                      "an unverified address is finished on the Account destination, "
                      + "which owns the resend action — not on a website")
        for caller in ["UploadPane.swift", "DirectPane.swift", "RealtimeTextPane.swift"] {
            XCTAssertTrue(try source(named: caller)
                .contains("onAccount: { navigation.selectAccount(intent: $0) }"),
                          "\(caller) must pass the gate's requested half through to navigation")
        }
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
                       "realtime: files, realtimeText: text)",
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
        let panes: [(file: String, destination: String)] = [
            ("NearbyPane.swift", ".nearby"),
            ("DirectPane.swift", ".pairingCode"),
            ("UploadPane.swift", ".storedSend"),
        ]
        for pane in panes {
            let text = try source(named: pane.file)
            XCTAssertTrue(text.contains("fileOpenRouting.batch(for: \(pane.destination), busy:"),
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
        XCTAssertTrue(sidebar.contains("presence.announcesRunningTransfer(destination,"),
                      "the live marker must be derived through TransferPresence")
        XCTAssertTrue(sidebar.contains("fileModel.isBusy || textModel.isBusy"),
                      "activity must come from the session models, not from a cached flag")
        XCTAssertFalse(sidebar.contains("destination == .nearby"),
                       "the marker must not be hard-coded to one destination")
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
    func testNearbysTwoPrimaryActionsCarryTheKeyboardDefault() throws {
        let nearby = try source(named: "NearbyPane.swift")
        // Exactly two, and they are mutually exclusive branches of `switch mode`,
        // so only one is ever on screen.
        XCTAssertEqual(occurrences(of: ".keyboardShortcut(.defaultAction)", in: nearby), 2,
                       "nearby has exactly two primaries: Send, and Start message")
        assertDefaultAction(attachesTo: "Button(L10n.t(.commonSend))", in: nearby,
                            named: "NearbyPane.swift")
        assertDefaultAction(attachesTo: "Button(L10n.t(.nearbyStartMessageSession))", in: nearby,
                            named: "NearbyPane.swift")
    }

    /// Create and join sit on one screen, so only one of them can be the keyboard
    /// default — two would be undefined, and SwiftUI would pick one of them
    /// without saying which.
    ///
    /// **Join wins, in both modes.** Its precondition is a single field whose
    /// completion is unambiguous: six digits are in, or they are not, and
    /// `canJoin` says so, so the default is inert until Return means exactly one
    /// thing. Create's precondition is an account *and* a staged selection, and
    /// it sits beside the field a user is typing a code into — making it the
    /// default would fire the wrong half on the keystroke that ends the other
    /// one. Prominence stays with each card's own primary; the keyboard default
    /// is the narrower claim and belongs to the half that can honour it.
    func testJoinIsTheOnlyKeyboardDefaultOnThePairingCodeDestination() throws {
        for file in ["DirectPane.swift", "RealtimeTextPane.swift"] {
            let text = try source(named: file)
            XCTAssertEqual(occurrences(of: ".keyboardShortcut(.defaultAction)", in: text), 1,
                           "\(file) must not offer two competing default buttons")
            assertDefaultAction(attachesTo: "Button(L10n.t(.commonJoin))", in: text, named: file)
            XCTAssertTrue(text.contains(".disabled(!model.canJoin)"),
                          "\(file): the default action must stay inert until six digits are in")
            XCTAssertTrue(text.contains("model.updateJoinCode($0)"),
                          "\(file): six-digit normalization — including a leading 1 — must survive")
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
    /// definition": this slice produces an engineering build. Signed, notarized
    /// and green is still "in development" until the product is ready, so a
    /// document that reads as an announcement is a truthfulness regression even
    /// when every technical gate passed.
    ///
    /// Phrases, not the word "launch". A bare-word ban would fail on
    /// `apps/README.md`'s "Launch the built app after a build", on this plan's
    /// own launch-gap register, and on every honest sentence about what is still
    /// missing — a guard that has to be disabled to write the truth protects
    /// nothing. Each entry below is a claim that cannot be made truthfully about
    /// this tree in any context.
    func testNoLaunchClaimInDocs() throws {
        let claims = ["now launched", "publicly available", "generally available",
                      "production release", "the macos app is complete",
                      "ready for launch", "available for download",
                      "available on the mac app store", "has launched",
                      "is now live", "download it at"]
        for path in claimSurfaces {
            let text = try claimSurfaceText(path).lowercased()
            for claim in claims {
                XCTAssertFalse(text.contains(claim), "\(path) claims launch: \(claim)")
            }
        }
        XCTAssertTrue(try claimSurfaceText("apps/mac/release-readiness.json")
            .contains("\"approved\": false"),
                      "the readiness manifest must stay unapproved")
    }

    /// The other direction, and the one a ban list cannot give: the status has to
    /// be stated, not merely left unclaimed. A reader who never reaches the
    /// blocker list should still not close `apps/README.md` believing the macOS
    /// app shipped.
    func testTheDocsStateTheEngineeringBuildStatusOutright() throws {
        XCTAssertTrue(try claimSurfaceText("apps/README.md").contains("engineering build"),
                      "apps/README.md must say what this result is")
        XCTAssertTrue(try claimSurfaceText("README.md").contains("engineering build"),
                      "the root README must say what this result is")
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
        XCTAssertTrue(flattened(try claimSurfaceText("apps/README.md"))
            .contains("The macOS build in this directory is not publicly distributed"),
                      "apps/README.md must say precisely what is not distributed")

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
}
