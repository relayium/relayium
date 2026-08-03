import XCTest

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
    /// SwiftUI scene to mirror itself. Both scene roots therefore derive one
    /// direction from the same language resolver as the copy layer. Keeping the
    /// override at the roots — and exactly there — preserves semantic
    /// leading/trailing layout throughout the destination tree without a set of
    /// per-screen exceptions that will drift.
    func testBothMacSceneRootsUseTheResolvedLanguageDirection() throws {
        let app = try source(named: "RelayiumApp.swift")
        XCTAssertTrue(app.contains("L10n.current.isRightToLeft"),
                      "layout direction must come from the localized copy resolver")
        XCTAssertEqual(occurrences(of: ".environment(\\.layoutDirection, appLayoutDirection)",
                                   in: app), 2,
                       "the window and menu-bar roots must share one derived direction")
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
        XCTAssertEqual(occurrences(of: "SectionCard(", in: account), 3,
                       "profile/plan/usage, devices and stored files are three deliberate cards")
        XCTAssertGreaterThanOrEqual(occurrences(of: "InlineMessage(", in: account), 5,
                                    "row errors, the load error, the cleanup warning and the "
                                    + "stale-figures notice all carry a symbol")
        for kept in [".task(id: scope)", ".task(id: management.needsSignOut)",
                     "confirmationDialog", "management.isBusy(row: device.id)",
                     "management.isBusy(row: row.id)", "management.revoke(device, scope: scope)",
                     "management.delete(file, scope: scope)", "management.clear(scope:",
                     "management.acknowledgeSignOut()", "management.dismissKeyCleanupWarning()",
                     "AccountRefreshDecision.next", "NSPasteboard.general.setString",
                     "session.logOut()", "session.refresh()", "AccountScope(accountId: user.id"] {
            XCTAssertTrue(account.contains(kept), "AccountView lost \(kept)")
        }
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
