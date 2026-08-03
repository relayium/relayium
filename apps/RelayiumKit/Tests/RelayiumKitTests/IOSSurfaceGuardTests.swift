import XCTest
@testable import RelayiumAppKit

/// What the iOS app is NOT allowed to contain.
///
/// Three failure modes, all of which look fine in a diff:
///
///  1. **A credential in a log.** One `print` in a view that renders a token is
///     a line nobody re-reads and no behavioral test can see.
///  2. **A dead control for a deferred feature.** A disabled "Sign in with
///     Apple", an empty device list, a greyed Send tab: each is a promise the
///     app cannot keep, and each reads as progress in review.
///  3. **Copy that names the wrong platform.** R3-B recorded nineteen such
///     catalog strings. Re-deriving the set for R3-C found **twenty-two**: the
///     R3-B count enumerated the keys saying *Mac* plus the one saying *macOS*,
///     and there were three more of the latter — `error.storedKey.keychain.save`,
///     `.read` and `.remove`. Recording the miscount is part of fixing it.
///     R3-C reaches five of the twenty-two and corrects those five in place, in
///     all nine catalogs, to device-neutral wording that stays true on macOS.
///     **Seventeen** remain, each blocked behind a feature this app does not
///     have — so rendering one has to be a decision rather than an oversight.
///  4. **A feature quietly unwired.** Launch restore is not decoration: without
///     it a signed-in user meets the sign-in form every launch.
///
/// It scans source text rather than behavior on purpose: these are absences,
/// and an absence has no runtime to observe.
final class IOSSurfaceGuardTests: XCTestCase {

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var iosRoot: URL { appsRoot.appendingPathComponent("ios/Relayium") }

    /// The view-model layer, which is where a credential actually passes
    /// through: `AccountSession` holds the bearer, and `ErrorCopy` formats
    /// failures around it.
    private var appKitRoot: URL {
        appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit")
    }

    /// Each source's CODE, with whole-line comments dropped.
    ///
    /// Load-bearing, not tidiness: these files explain what they deliberately do
    /// NOT do, so `RelayiumApp` says "no `onOpenURL`" and `ReceiveView` says the
    /// app never reads `UIPasteboard`. Scanning raw text would fail this guard on
    /// the very comments that document the absence it is checking for.
    ///
    /// Whole-line only — a trailing `//` is not stripped, so a deferred symbol
    /// named in a trailing comment still fails. That is the wanted direction:
    /// this guard may miss nothing, and may only be too strict in a case that is
    /// trivially fixed by moving the comment to its own line.
    private func sources() throws -> [(name: String, text: String)] {
        try sources(under: iosRoot, atLeast: 8)
    }

    /// The app's own `Info.plist`, read as a plist rather than as text, so what
    /// is asserted is what the app actually declares.
    private func infoPlist() throws -> [String: Any] {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
    }

    private func sources(under root: URL, atLeast minimum: Int) throws
        -> [(name: String, text: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        // A rename that moved the sources out from under this guard is exactly
        // when it stops protecting anything.
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

    /// Both roots, because the credential passes through both: the app renders
    /// the session, and `AccountSession`/`ErrorCopy` hold and format it.
    func testNothingInTheAppOrViewModelLayerLogs() throws {
        let scanned = try sources(under: iosRoot, atLeast: 8)
            + sources(under: appKitRoot, atLeast: 40)
        for (name, text) in scanned {
            for call in ["print(", "NSLog(", "os_log(", "debugPrint(", "dump("] {
                XCTAssertFalse(text.contains(call),
                               "\(name) contains \(call) — a credential must never reach a log")
            }
        }
    }

    func testNoDeferredFeatureIsReferenced() throws {
        // A later slice owns this. A reference means either a dead control or a
        // capability claimed before it works.
        //
        // `CloudUploadModel` LEFT this list in R3-C, deliberately: this is the
        // slice that ships it. Everything else stays.
        let deferred = [
            "SignInWithAppleButton", "AuthenticationServices", "BrowserLoginModel",
            "AccountManagementModel", "RealtimeSessionModel",
            "RealtimeTextSessionModel", "LanDiscoveryModel", "NearbyReceiveModel",
            "UIPasteboard", "onOpenURL", "UNUserNotificationCenter", "StoreKit",
            "NSWorkspace",
        ]
        // This is the wrong way to do THIS slice's work. Each of these compiles,
        // reads plausibly, and breaks a documented invariant:
        //
        //  - `URLSessionConfiguration.background` would claim a resume this app
        //    does not have and the copy explicitly denies;
        //  - `DataRepresentation` / `Data.self` would load a picked video into
        //    memory instead of copying a file;
        //  - `startAccessingSecurityScopedResource` in a view would put the
        //    start/stop balance somewhere no test can count it, and somewhere
        //    SwiftUI decides the lifetime;
        //  - `SelectionStore` would have the view read the nested store rather
        //    than the model's forwarded state — which does not publish through a
        //    stored property, so the view would silently stop redrawing;
        //  - `TaskLocal` would be the ambient import context the two-step photo
        //    flow exists to avoid.
        let wrongApproach = [
            "URLSessionConfiguration.background", "DataRepresentation", "Data.self",
            "startAccessingSecurityScopedResource", "SelectionStore", "TaskLocal",
        ]
        for (name, text) in try sources() {
            for symbol in deferred + wrongApproach {
                XCTAssertFalse(text.contains(symbol), "\(name) references \(symbol)")
            }
        }
    }

    /// The seventeen keys whose wording still names a platform, each grouped
    /// with the slice that will first render it.
    ///
    /// Five left this list in R3-C because this slice renders them, so they were
    /// corrected in place in all nine catalogs instead: `upload.keyKept`,
    /// `error.storedKey.badId.save`, `error.storedKey.badKey.save`,
    /// `error.plaintext.tooManyOpenFiles`, and `error.storedKey.keychain.save`
    /// — the last of which was never on this list at all, which is the miscount
    /// recorded in this file's header.
    ///
    /// `error.storedLinkKey.invalidKey` moved from R3-C to R3-D on reachability
    /// grounds rather than by inheritance from the roadmap:
    /// `ErrorCopy.storedLinkKeyMessage` routes `.invalidKey` to
    /// `errorStoredKeyBadKeySave` on `.save` and to this key only on `.read`,
    /// and sending never reads a stored key.
    ///
    /// Guarded by NAME, so it cannot see the ones `ErrorCopy` reaches
    /// indirectly — which is why `error.manifest.duplicatePath`, the one an iOS
    /// receive can already hit, was corrected in the catalogs instead of listed
    /// here, and why the five above had to be corrected the same way.
    func testNoPlatformNamingCopyKeyIsRenderedOnIOS() throws {
        let platformNaming: [L10nKey] = [
            // R3-D: device and stored-file management, and rebuilding a link
            // from a stored key.
            .accountThisMac, .accountRevokeThisMac, .accountKeyNotOnThisMac,
            .accountKeyLookupFailed, .accountKeyCleanupWarning, .accountBearerInvalid,
            .errorStoredLinkKeyInvalidKey,
            .errorStoredKeyKeychainRead, .errorStoredKeyKeychainRemove,
            // R3-E / R3-F: realtime, nearby, notifications.
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText, .verifyExplainEncryption,
            .errorNearbyNoAnswer,
            // Rendered by nothing on either platform yet.
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 17)
        for (name, text) in try sources() {
            for key in platformNaming {
                XCTAssertFalse(text.contains(".\(key)"),
                               "\(name) renders \(key.rawValue), whose wording names a platform")
            }
        }
    }

    /// Launch restore is wired, and wired in ONE place — the shell — so a
    /// second `.task` cannot start a competing cold start from inside a tab.
    ///
    /// This says nothing about how often SwiftUI runs that task, which is not
    /// something a source scan or an `Info.plist` can decide. `AccountSession`
    /// is App-scoped and `restore()` is re-entrant; `AccountSessionTests` owns
    /// proving that, and this owns proving the feature exists at all.
    func testLaunchRestoreIsWiredExactlyOnceInTheShell() throws {
        let all = try sources()
        let callSites = all
            .map { $0.text.components(separatedBy: "session.restore()").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(callSites, 1, "launch restore must have exactly one call site")
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("session.restore()"),
                      "the one call site belongs in the shell, not in a tab")
    }

    /// The receive flow must not acquire an account dependency: it is the one
    /// thing this app could already do, and it works signed out.
    func testTheReceiveFlowIsIndependentOfTheSession() throws {
        let all = try sources()
        let receive = try XCTUnwrap(all.first { $0.name == "ReceiveView.swift" })
        for symbol in ["AccountSession", "bearerToken"] {
            XCTAssertFalse(receive.text.contains(symbol),
                           "ReceiveView must not depend on \(symbol)")
        }
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertFalse(root.text.contains("session.state"),
                       "the shell must not switch on session state — that would gate the receive tab")
    }

    /// One call site is what keeps the typed email and password alive across
    /// .loggedOut → .authenticating → .failed.
    func testTheSignInFormHasExactlyOneCallSite() throws {
        let uses = try sources()
            .filter { $0.name != "SignInView.swift" }
            .map { $0.text.components(separatedBy: "SignInView(").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(uses, 1,
                       "a second call site would give the form a second structural identity")
    }

    // MARK: - registration happens in the app

    /// The form creates the account itself.
    ///
    /// It used to open relayium.com, and the whole point of this slice is that
    /// it no longer does: `AppEnvironment.accountWebURL` is the "just send them
    /// to the website" hand-off, and no iOS surface may reach for it now that
    /// signing in, creating an account and asking for another verification email
    /// all happen here.
    ///
    /// Two hand-offs survive and are deliberately NOT banned: `plansWebURL`
    /// (billing, which stays on the web) and `reactivateWebURL` (a frozen
    /// account cannot sign in, so the token in that link is the only way back).
    func testNoIOSSurfaceOpensTheWebsiteForAccountWork() throws {
        for (name, text) in try sources() {
            XCTAssertFalse(text.contains("accountWebURL"),
                           "\(name) sends the user to the website for account work")
            XCTAssertFalse(text.contains("productionBaseURL"),
                           "\(name) opens relayium.com directly")
        }
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("session.register(email:"),
                      "the form must create the account through the session, in the app")
        XCTAssertTrue(form.text.contains("mode == .register ? .emailAddress : .username"),
                      "registration should expose an email field while sign-in stays a credential username")
        for webbish in ["openURL", "UIApplication.shared.open", "SFSafariViewController"] {
            XCTAssertFalse(form.text.contains(webbish),
                           "the sign-in/create form must not open anything: \(webbish)")
        }
    }

    /// The mode lives in the form and nowhere else.
    ///
    /// A second holder — a tab, the shell, a router — would be a second source
    /// of truth for which half is showing, and the one SwiftUI would win with is
    /// whichever rebuilt last. That is the same failure the single call site
    /// above exists to prevent, one level up.
    func testOnlyTheFormOwnsWhichHalfIsShowing() throws {
        for (name, text) in try sources() where name != "SignInView.swift" {
            XCTAssertFalse(text.contains("AuthMode"), "\(name) must not decide the form's mode")
        }
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("@State private var mode: AuthMode"),
                      "the mode is the form's own state")
    }

    /// The check-email screen can act and can leave.
    ///
    /// It is the state a fresh registration lands in, and before this slice its
    /// only action was a link to relayium.com. Both controls are one `Button`
    /// each — exactly the kind of wiring a later re-layout drops silently.
    func testTheCheckEmailScreenCanResendAndGoBack() throws {
        let tab = try XCTUnwrap(try sources().first { $0.name == "AccountTab.swift" })
        XCTAssertTrue(tab.text.contains("session.resendVerification(email: email)"),
                      "the check-email screen must be able to ask for another email")
        XCTAssertTrue(tab.text.contains("L10n.t(.contentBackToSignIn)"),
                      "and must offer the way back, which is a sign-out")
        XCTAssertTrue(tab.text.contains("if isResending {"),
                      "the resend button must be replaced while a request is in flight, "
                      + "so a second press cannot start a second request")
    }

    /// Empty is the claim: this app needs no capability, and an entitlement is
    /// a claim to the OS that lands with the feature requiring it. The nil
    /// keychain access group is the same decision, from the other side.
    func testTheEntitlementsFileIsStillEmpty() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertTrue(plist.isEmpty, "iOS R3-C claims no capability: \(plist.keys.sorted())")
    }

    /// The bearer is read at the moment of use and nowhere else.
    ///
    /// It is not `@Published` on purpose — a credential has no business in the
    /// view-update surface — so the send button's ENABLEMENT comes from
    /// `session.state` and its ACTION re-reads the token. The upload model does
    /// capture it for the life of one authenticated upload task; that is what an
    /// authenticated upload IS, and it is not this guard's business. What this
    /// guard forbids is a SECOND holder in the view layer.
    func testTheBearerIsReadInExactlyOnePlaceOnce() throws {
        let all = try sources()
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "bearerToken").count - 1 }
                          .reduce(0, +), 1)
        let owner = try XCTUnwrap(all.first { $0.text.contains("bearerToken") })
        XCTAssertEqual(owner.name, "SendView.swift")
    }

    /// Account-owned work is app-scoped. SwiftUI mounts a `TabView`'s tabs
    /// lazily and can tear down an off-screen one, so a view that owned the
    /// account context would silently stop isolating the moment the user was
    /// looking elsewhere — and an authenticated upload would keep running under
    /// an account that is gone.
    func testTheAccountContextIsNotDrivenByAView() throws {
        let all = try sources()
        let view = try XCTUnwrap(all.first { $0.name == "SendView.swift" })
        for symbol in ["SendAccountContext", "applyAccountContext", "accountContextChanged"] {
            XCTAssertFalse(view.text.contains(symbol),
                           "SendView must not drive the account: \(symbol)")
        }
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains(".observe("),
                      "the session observation belongs to the app scope")
    }

    /// A sign-out that lands between the button being enabled and the button
    /// being tapped.
    ///
    /// The enablement comes from `session.state`, which is a redraw behind; the
    /// action re-reads the token. So the refusal has to be in the ACTION, and
    /// `start(token:)` must be reachable only through it — otherwise the app
    /// starts an authenticated upload with an empty bearer and reports whatever
    /// the server says about it.
    ///
    /// A source guard because there is no view to drive: what it pins is that
    /// the read, the refusal and the start are one statement in one place.
    func testTheSendActionRefusesRatherThanStartingWithAnEmptyBearer() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        XCTAssertTrue(view.text.contains(
            "guard let token = session.bearerToken, !token.isEmpty else {"),
            "the bearer must be checked at the moment it is read")
        XCTAssertTrue(view.text.contains("upload.fail(L10n.t(.errorCloudUnauthorized))"),
                      "a missing bearer is an honest refusal, not an empty request")
        XCTAssertEqual(view.text.components(separatedBy: "upload.start(token:").count - 1, 1,
                       "a second start would be one that skipped the guard")
    }

    /// The Photos binding is reusable, and that is a behaviour with no runtime a
    /// package test can observe: `PhotosPicker` keeps whatever was chosen, so
    /// choosing the SAME two photos again is no change and therefore no import —
    /// the app appears to ignore the user.
    ///
    /// The fix is three ordered statements: capture, reset, import FROM THE
    /// CAPTURE. Importing from the binding after resetting it would import
    /// nothing at all, which is why the order is guarded and not just the parts.
    func testThePhotosBindingIsCapturedResetAndImportedFromTheCapture() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        let capture = try XCTUnwrap(view.text.range(of: "let captured = items"))
        let reset = try XCTUnwrap(view.text.range(of: "picked = []"))
        let importFromCapture = try XCTUnwrap(view.text.range(of: "captured[index]"))
        XCTAssertTrue(capture.lowerBound < reset.lowerBound,
                      "the reset must not beat the capture, or nothing is imported")
        XCTAssertTrue(reset.lowerBound < importFromCapture.lowerBound,
                      "the binding must be reset before the import, or the same items never re-fire")
        // The decision itself lives in `PhotoPickerChange`, where it is tested:
        // an empty change is OUR OWN reset and must not become
        // `importPhotos(count: 0)`, which would clear a selection the user never
        // asked to clear.
        XCTAssertTrue(view.text.contains("PhotoPickerChange.decide(itemCount:"),
                      "the empty-change decision belongs in the tested seam")
    }

    /// `PhotosPicker` returns only what the user chose, out of process. That is
    /// exactly why it needs no library permission — declaring one would ask for
    /// access this app never takes. Same rule as the empty entitlements file.
    ///
    /// `UIBackgroundModes` is the other half: foreground-only is what the copy
    /// says, and a background mode here would make that copy a lie.
    func testTheInfoPlistClaimsNoPhotoLibraryAccessAndNoBackgroundMode() throws {
        let plist = try infoPlist()
        XCTAssertNil(plist["NSPhotoLibraryUsageDescription"])
        XCTAssertNil(plist["NSPhotoLibraryAddUsageDescription"])
        XCTAssertNil(plist["UIBackgroundModes"])
        XCTAssertEqual(plist["CFBundleLocalizations"] as? [String],
                       ["en", "zh-Hans", "ja", "ko", "de", "fr", "ar", "es", "pt"])
    }
}
