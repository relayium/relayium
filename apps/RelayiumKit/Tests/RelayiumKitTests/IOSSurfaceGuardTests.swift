import XCTest
@testable import RelayiumAppKit

/// What the iOS app is NOT allowed to contain.
///
/// Three failure modes, all of which look fine in a diff:
///
///  1. **A credential in a log.** One `print` in a view that renders a token is
///     a line nobody re-reads and no behavioral test can see.
///  2. **A dead control for a deferred feature.** An empty device list, a
///     greyed Send tab, a button for something unwired: each is a promise the
///     app cannot keep, and each reads as progress in review. "Sign in with
///     Apple" was the example here through three slices; it left the list by
///     being BUILT, which is why the Apple assertions below are positive ones
///     about the system control rather than a ban on naming it.
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
        // slice that ships it. `SignInWithAppleButton` and
        // `AuthenticationServices` left it in THIS slice, for the same reason —
        // the app now presents the real system control. What replaces the ban
        // is not nothing: `testTheAppleButtonIsTheSystemControlWiredToTheSession`
        // and `testOnlyTheFormImportsAuthenticationServices` below say what the
        // Apple surface must be, which is the harder claim. Everything else stays.
        let deferred = [
            "BrowserLoginModel",
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
    ///
    /// A sixth left this list in the account-deletion slice, by the same route:
    /// `account.bearerInvalid` is what `AccountSession` renders when a deletion
    /// request comes back 401, and `AccountSession` runs on both platforms — so
    /// listing it here would have banned a sentence the shared layer now
    /// produces anyway. It was corrected in place in all nine catalogs instead
    /// ("this Mac" → the language's own device noun), and
    /// `LocalizedCopyTests.testTheRevokedCredentialSentenceNamesNoPlatform`
    /// carries the claim from here on — which is the stronger guard, since it
    /// reads the copy rather than the call sites.
    func testNoPlatformNamingCopyKeyIsRenderedOnIOS() throws {
        let platformNaming: [L10nKey] = [
            // R3-D: device and stored-file management, and rebuilding a link
            // from a stored key.
            .accountThisMac, .accountRevokeThisMac, .accountKeyNotOnThisMac,
            .accountKeyLookupFailed, .accountKeyCleanupWarning,
            .errorStoredLinkKeyInvalidKey,
            .errorStoredKeyKeychainRead, .errorStoredKeyKeychainRemove,
            // R3-E / R3-F: realtime, nearby, notifications.
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText, .verifyExplainEncryption,
            .errorNearbyNoAnswer,
            // Rendered by nothing on either platform yet.
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 16)
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

    /// The signed-in account can end itself, in the app, in two steps.
    ///
    /// Same claim as `MacSurfaceGuardTests`'s, on the surface `AccountTab`
    /// renders for `.ready` — and each clause is a way it could look finished
    /// and not be: a button wired straight to the session would be a one-tap
    /// account deletion, an `openURL` would be the browser hand-off this slice
    /// exists to replace, and a sign-out on success would assert a deletion the
    /// server has not performed and take away the credential the user needs if
    /// they change their mind before opening the link.
    func testTheAccountSurfaceCanEndTheAccountNativelyAndOnlyAfterConfirming() throws {
        let all = try sources()
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains(
            "Button(L10n.t(.accountDeleteAccount), role: .destructive)"),
            "the delete control must carry the destructive role")
        XCTAssertTrue(summary.text.contains("confirmingAccountDeletion = true"),
                      "and must open a confirmation rather than act")
        XCTAssertTrue(summary.text.contains("confirmationDialog("),
                      "the confirmation must be the system's, not a hand-drawn sheet")
        XCTAssertTrue(summary.text.contains(
            "Button(L10n.t(.accountDeleteAccountConfirmAction), role: .destructive)"),
            "the confirmation's action is the destructive one")
        XCTAssertTrue(summary.text.contains("session.requestAccountDeletion()"),
                      "the request must go through the session")

        // Exactly one call site across the whole app: a second would be one
        // that skipped the confirmation.
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "session.requestAccountDeletion()").count - 1 }
                          .reduce(0, +), 1)

        guard let confirmAction = summary.text.range(of: ".accountDeleteAccountConfirmAction"),
              let requests = summary.text.range(of: "session.requestAccountDeletion()") else {
            return XCTFail("AccountSummaryView no longer has the two-step delete")
        }
        XCTAssertTrue(confirmAction.upperBound < requests.lowerBound,
                      "the request must sit inside the confirmation's destructive button")

        // No hand-off to the website, and no sign-out on the way. The one
        // sign-out here is the Sign out button that was already on the screen.
        XCTAssertFalse(summary.text.contains("openURL(AppEnvironment.accountWebURL"),
                       "account deletion must not leave the app")
        XCTAssertEqual(summary.text.components(separatedBy: "session.logOut()").count - 1, 1,
                       "requesting a deletion must not sign the user out")
    }

    // MARK: - native Sign in with Apple

    /// The Apple control is the SYSTEM one, and its result goes to the session.
    ///
    /// Each clause is a way the feature could look finished and not be: a
    /// custom-drawn button (a guideline violation and an impersonation), a
    /// request without the nonce (nothing binds the token to this attempt), a
    /// request without the scopes (a first authorization that cannot create an
    /// account), and a completion that never reaches `logInWithApple` (a button
    /// that dismisses a sheet and does nothing).
    func testTheAppleButtonIsTheSystemControlWiredToTheSession() throws {
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("SignInWithAppleButton("),
                      "the Apple control must be the system button, not a lookalike")
        XCTAssertTrue(form.text.contains("mode == .register ? .signUp : .signIn"),
                      "the system button's label must follow the form's mode")
        XCTAssertTrue(form.text.contains("request.nonce = attempt.nonce"),
                      "the request must carry this attempt's nonce")
        XCTAssertTrue(form.text.contains("request.state = attempt.state"),
                      "the request must carry an opaque attempt identity")
        XCTAssertTrue(form.text.contains("request.requestedScopes = [.fullName, .email]"),
                      "a first authorization needs the name and email Apple only sends once")
        XCTAssertTrue(form.text.contains("session.logInWithApple(idToken:"),
                      "the credential must be exchanged through the session")
        // The nonce belongs to ONE attempt: consumed on completion, and a
        // completion with nothing pending is refused rather than sent with a
        // freshly minted nonce the token could never match.
        XCTAssertTrue(form.text.contains("guard let attempt = appleAttempt else { return }"),
                      "a stale or superseded completion must be refused")
        XCTAssertTrue(form.text.contains("attempt.matches(returnedState: credential.state)"),
                      "a completion must belong to the attempt whose nonce is still held")
        XCTAssertTrue(form.text.contains("appleAttempt = nil"),
                      "the attempt must be consumed, so one authorization cannot land twice")
        // Cancelling asks for nothing to happen — including no error sentence.
        XCTAssertTrue(form.text.contains("== .canceled { return }"),
                      "a user cancellation must be silent")
    }

    /// `AuthenticationServices` belongs to the form and nowhere else.
    ///
    /// A second importer would be a second place an Apple authorization can
    /// start, and the nonce that binds one attempt is `SignInView`'s own state:
    /// an authorization begun anywhere else could not be checked against it.
    func testOnlyTheFormImportsAuthenticationServices() throws {
        for (name, text) in try sources() where name != "SignInView.swift" {
            for symbol in ["AuthenticationServices", "SignInWithAppleButton",
                           "ASAuthorizationAppleID", "ASAuthorizationController"] {
                XCTAssertFalse(text.contains(symbol), "\(name) starts its own Apple authorization: \(symbol)")
            }
        }
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("import AuthenticationServices"))
    }

    /// One entitlement, and it is the one this slice earned.
    ///
    /// Empty used to be the claim. It is now exactly `applesignin`, because the
    /// app presents an `ASAuthorizationAppleIDRequest` — and still nothing else,
    /// because every other capability belongs to a feature that does not exist
    /// yet. The nil keychain access group is the same decision, from the other
    /// side: the bearer lives in this app's own default group.
    func testTheEntitlementsFileClaimsOnlyAppleSignIn() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertEqual(plist.keys.sorted(), ["com.apple.developer.applesignin"],
                       "iOS claims a capability it does not use: \(plist.keys.sorted())")
        XCTAssertEqual(plist["com.apple.developer.applesignin"] as? [String], ["Default"])
        XCTAssertNil(plist["keychain-access-groups"],
                     "the bearer lives in this app's own default keychain group")
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
