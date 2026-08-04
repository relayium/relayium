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
///     R3-D reaches eight more — the device list, the stored-file list and the
///     link rebuild — and corrects those the same way. **Eight** remain, seven
///     blocked behind a feature this app does not have and one rendered by
///     nothing on either platform, so rendering any of them has to be a decision
///     rather than an oversight.
///  4. **A feature quietly unwired.** Launch restore is not decoration: without
///     it a signed-in user meets the sign-in form every launch.
///
/// Much of it scans source text rather than behavior on purpose: these are
/// absences, and an absence has no runtime to observe.
///
/// R3-D adds the other direction, and it is the larger half of this file now.
/// The account-management surface is the first iOS screen whose defects are all
/// *presence* defects — a management model built twice, a stale credential
/// carried into a revoke, a sign-out that clears rows after the network call
/// instead of before, a `#k=` link offered for a key this device does not hold.
/// None of those is visible in a screenshot and none is reachable from a package
/// test, because SwiftUI owns the view. So the decisions live in
/// `AccountManagementModel` and `AccountPresentation`, where
/// `AccountManagementModelTests` and `AccountManagementPresentationTests` drive
/// them for real, and what is asserted HERE is only the wiring that connects the
/// two — which is exactly the part a re-layout drops silently.
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
        //
        // `AccountManagementModel` LEFT this list in R3-D, for the same reason
        // `CloudUploadModel` left it in R3-C: this is the slice that renders it.
        // What replaces the ban is not nothing — the positive wiring invariants
        // further down say the model is app-scoped, built from the ONE key
        // store, injected once, and reachable only from the ready account
        // surface, which is the harder claim.
        //
        // `UIPasteboard` deliberately stays. R3-D is the first slice with a
        // rebuilt `#k=` link to hand somewhere, and the honest hand-off is the
        // share sheet the user opened, not a clipboard write behind their back.
        let deferred = [
            "BrowserLoginModel",
            "RealtimeSessionModel",
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

    /// The eight keys whose wording still names a platform, each grouped with
    /// the slice that will first render it.
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
    ///
    /// **R3-D takes eight more off this list by the same route.** The device
    /// list, the stored-file list and the link rebuild are what this slice
    /// renders, so `account.thisMac`, `account.revokeThisMac`,
    /// `account.keyNotOnThisMac`, `account.keyLookupFailed`,
    /// `account.keyCleanupWarning`, `error.storedLinkKey.invalidKey`,
    /// `error.storedKey.keychain.read` and `error.storedKey.keychain.remove`
    /// were corrected in place in all nine catalogs to wording that is true on
    /// both platforms. `LocalizedCopyTests`'
    /// `testNothingTheAccountManagementSurfaceRendersNamesAPlatform` and
    /// `testEverySentenceAboutThisDeviceStillNamesADevice` carry that claim from
    /// here on, and they carry the half a ban cannot: that each sentence still
    /// names the device it is about instead of merely dropping the noun.
    ///
    /// Seven of the remaining eight are still blocked behind a feature this app
    /// does not have, so rendering one has to be a decision rather than an
    /// oversight. The eighth is rendered by nothing on either platform.
    func testNoPlatformNamingCopyKeyIsRenderedOnIOS() throws {
        let platformNaming: [L10nKey] = [
            // R3-E / R3-F: realtime, nearby, notifications.
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText, .verifyExplainEncryption,
            .errorNearbyNoAnswer,
            // Rendered by nothing on either platform yet.
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 8)
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
    ///
    /// `AccountManagementModel` joins the ban in R3-D. It is injected into the
    /// environment at the app scope, which puts it structurally within reach of
    /// every tab — and an `@EnvironmentObject` the receive tab merely DECLARED
    /// would crash it outright in any build where the object was not installed.
    /// Anonymous receive stays independent of the account by not naming it.
    func testTheReceiveFlowIsIndependentOfTheSession() throws {
        let all = try sources()
        let receive = try XCTUnwrap(all.first { $0.name == "ReceiveView.swift" })
        for symbol in ["AccountSession", "bearerToken", "AccountManagementModel",
                       "AccountScope"] {
            XCTAssertFalse(receive.text.contains(symbol),
                           "ReceiveView must not depend on \(symbol)")
        }
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertFalse(root.text.contains("session.state"),
                       "the shell must not switch on session state — that would gate the receive tab")
    }

    /// A failure a second tap would fix must offer that tap.
    ///
    /// This view rendered a sentence and nothing else for every failure,
    /// including a dropped connection — leaving the user to re-derive that
    /// re-opening the link is what repeats the work, and no affordance at all
    /// once the transfer itself had started. The decision is the shared model's
    /// (`CloudDownloadRecoveryTests`), so what belongs here is the same
    /// conditional the macOS pane renders, from the same API, and nothing that
    /// reads a message or a status to second-guess it.
    func testTheReceiveViewOffersRetryOnlyWhereTheModelSaysItHelps() throws {
        let receive = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" })
        XCTAssertTrue(receive.text.contains("model.canRetry"),
                      "the retry affordance must be conditional on the model's recovery")
        XCTAssertTrue(receive.text.contains("model.retry()"),
                      "the retry must go through the model's guarded entry point")
        XCTAssertTrue(receive.text.contains(".commonTryAgain"),
                      "both platforms render the same shared label")
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

        // No hand-off to the website, and no sign-out on the way.
        XCTAssertFalse(summary.text.contains("openURL(AppEnvironment.accountWebURL"),
                       "account deletion must not leave the app")
        // Zero, now that both sign-out paths belong to the coordinator. A
        // deletion request that ended the session would assert a deletion the
        // server has not performed and take away the credential the user needs
        // if they change their mind before opening the emailed link.
        XCTAssertEqual(summary.text.components(separatedBy: "session.logOut()").count - 1, 0,
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

    /// The bearer is read at the moment of use, and only by the two surfaces
    /// that spend it.
    ///
    /// It is not `@Published` on purpose — a credential has no business in the
    /// view-update surface — so the send button's ENABLEMENT comes from
    /// `session.state` and its ACTION re-reads the token. The upload model does
    /// capture it for the life of one authenticated upload task; that is what an
    /// authenticated upload IS, and it is not this guard's business. What this
    /// guard forbids is a holder anywhere ELSE in the view layer.
    ///
    /// R3-D adds the second reader, and it is a different shape from the first:
    /// `AccountSummaryView` recomputes an `AccountScope` on every render rather
    /// than storing one, so a result can be checked against the account and
    /// credential on screen when it ARRIVES. Storing it is the defect that shape
    /// exists to prevent, so the read is asserted to be a computed property.
    func testTheBearerIsReadOnlyWhereItIsSpent() throws {
        let all = try sources()
        let readers = all.filter { $0.text.contains("bearerToken") }.map(\.name).sorted()
        XCTAssertEqual(readers, ["AccountSummaryView.swift", "SendView.swift"],
                       "a third view-layer holder of the credential")
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("private var scope: AccountScope {"),
                      "the scope must be recomputed per render, not stored")
        XCTAssertTrue(summary.text.contains(
            "AccountScope(accountId: user.id, token: session.bearerToken ?? \"\")"),
            "the scope must pair THIS render's account with the live credential")
        // Two reads, and the second is the reason this is not "exactly one":
        // `refresh()` has to ask the session what it holds AFTER the refresh
        // moved it, because a refresh can rotate the credential or end the
        // session entirely. Re-reading the computed `scope` there would hand
        // `AccountRefreshDecision` the value it is supposed to check.
        XCTAssertEqual(summary.text.components(separatedBy: "session.bearerToken").count - 1, 2,
                       "the credential is read to build the scope and to re-check it after a refresh")
        XCTAssertTrue(summary.text.contains("bearer: session.bearerToken"),
                      "the refresh decision must see the LIVE credential, not the rendered scope")
        XCTAssertFalse(summary.text.contains("@State private var scope"),
                       "a stored scope would outlive the credential it names")
    }

    // MARK: - R3-D: device and stored-file management

    /// One key store, shared by the upload that WRITES a `#k=` key and the
    /// management model that READS it back.
    ///
    /// Two stores would still address the same keychain items, so this would not
    /// fail at runtime — it would drift the moment either construction gained an
    /// argument the other did not, and the symptom would be an upload whose link
    /// the Account tab cannot rebuild. The key exists nowhere else: not on the
    /// server, not in the manifest, only in the link and in this store.
    func testOneStoredLinkKeyStoreIsSharedByUploadAndManagement() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })
        XCTAssertEqual(app.text.components(separatedBy: "makeStoredLinkKeyStore()").count - 1, 1,
                       "a second key store would be a second source of truth for the keys")
        XCTAssertTrue(app.text.contains("AppEnvironment.makeUploadModel(keyStore: keys)"),
                      "the upload model must take the shared store")
        XCTAssertTrue(app.text.contains("AppEnvironment.makeAccountManagementModel(keyStore: keys)"),
                      "and the management model must take the SAME one")
    }

    /// The management model is app-scoped and injected once.
    ///
    /// View-scoped would be the natural-looking mistake and the wrong one: a
    /// SwiftUI `TabView` mounts its tabs lazily and can tear an off-screen one
    /// down, so a revoke in flight — the operation that can end this app's own
    /// session — would be cancelled by the user switching tabs, and
    /// `needsSignOut` would be raised on an object that no longer exists.
    func testTheManagementModelIsAppScopedAndInjectedOnce() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("@StateObject private var management: AccountManagementModel"),
                      "the model belongs to the App, not to a view")
        XCTAssertTrue(app.text.contains(".environmentObject(management)"),
                      "and has to reach the view tree")
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "makeAccountManagementModel").count - 1 }
                          .reduce(0, +), 1,
                       "a second construction would be a second model, with its own rows")
        XCTAssertEqual(all.map { $0.text.components(separatedBy: ".environmentObject(management)").count - 1 }
                          .reduce(0, +), 1)
    }

    /// Management is rendered by the ready account surface and by nothing else.
    ///
    /// The tab is a router over session states; the summary is the one state
    /// that HAS an account whose devices and files exist. A second holder would
    /// be a screen able to render a revoke button outside `.ready` — with a
    /// scope built from a user that is no longer signed in.
    func testOnlyTheReadyAccountSurfaceRendersManagement() throws {
        let all = try sources()
        let holders = all.filter { $0.text.contains("AccountManagementModel") }
            .map(\.name).sorted()
        XCTAssertEqual(holders, ["AccountSummaryView.swift", "RelayiumApp.swift"])
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains(
            "@EnvironmentObject private var management: AccountManagementModel"))
        let tab = try XCTUnwrap(all.first { $0.name == "AccountTab.swift" })
        XCTAssertFalse(tab.text.contains("management"),
                       "the router must not reach into the account's rows")
        XCTAssertTrue(tab.text.contains("AccountSummaryView(user: user, usage: usage)"),
                      "and the summary must stay the `.ready` arm")
    }

    /// Every call into the model carries the scope, and the load is KEYED on it.
    ///
    /// `.task(id:)` is what makes signing in as somebody else reload instead of
    /// leaving the previous account's devices — each with a revoke button — under
    /// the new account's name. A bare `.task` would run once per view identity
    /// and never again.
    func testEveryManagementCallCarriesTheScopeAndTheLoadIsKeyedOnIt() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        for wired in [".task(id: scope) { await management.load(scope) }",
                      "management.revoke(device, scope: scope)",
                      "management.delete(file, scope: scope)",
                      "management.clear(scope:"] {
            XCTAssertTrue(summary.text.contains(wired), "AccountSummaryView lost \(wired)")
        }
        // No call may reach the model without one. A scope-less overload does
        // not exist, so this catches the shape rather than the symbol: a bare
        // `management.load()` would not compile, but `management.load(stale)`
        // built from something other than the render-time scope would.
        XCTAssertFalse(summary.text.contains("management.load(AccountScope("),
                       "a call must not mint its own scope beside the render-time one")
    }

    /// Refresh goes through the shared decision, and acts on BOTH of its answers.
    ///
    /// The naive version — refresh the session, then reload with the scope the
    /// view recomputes — is wrong in two ways that only appear once refreshing
    /// can change the session: an expired bearer pairs the old account id with an
    /// empty token, and a second sign-in pairs it with a stranger's credential.
    /// Which outcome it is belongs in `AccountRefreshDecision`, where
    /// `AccountManagementModelTests` drives it; this asserts the view carries it
    /// out rather than re-deriving it.
    func testRefreshDefersToTheSharedDecisionAndHandlesBothOutcomes() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("AccountRefreshDecision.next(previous: previous,"),
                      "the decision must not be re-derived in the view")
        XCTAssertTrue(summary.text.contains("case .reload(let current): await management.load(current)"),
                      "a still-ready same account reloads under its CURRENT bearer")
        XCTAssertTrue(summary.text.contains("case .clear(let stale):    management.clear(scope: stale)"),
                      "anything else lets the rows go rather than fetching more of them")
        guard let refresh = summary.text.range(of: "await session.refresh()"),
              let decide = summary.text.range(of: "AccountRefreshDecision.next(previous:") else {
            return XCTFail("AccountSummaryView no longer refreshes through the decision")
        }
        XCTAssertTrue(refresh.upperBound < decide.lowerBound,
                      "the decision must read the session AFTER the refresh moved it")
    }

    /// The explicit Sign out button goes through the same coordinator the
    /// self-revoke does.
    ///
    /// Not tidiness: it is what makes "one revocation at a time" enforceable.
    /// With the view calling `session.logOut()` itself, a Sign out tapped while a
    /// self-revoke's sign-out was already running would be a second revocation of
    /// a credential that is already gone, and its failure would be reported over
    /// the first one's success. It still carries the scope, because a press
    /// naming an account the model has moved on from must not wipe the current
    /// one's rows.
    ///
    /// The claim that the rows go BEFORE the network call moved with the code:
    /// `AccountSignOutCoordinatorTests` drives it against a held-open logout,
    /// which is a stronger check than the source ordering this used to read.
    func testTheExplicitSignOutGoesThroughTheOneCoordinator() throws {
        let all = try sources()
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains(
            "@EnvironmentObject private var signOut: AccountSignOutCoordinator"))
        XCTAssertTrue(summary.text.contains("signOut.signOut(scope: scope)"),
                      "the button must hand the SCOPED sign-out to the coordinator")
        XCTAssertEqual(summary.text.components(separatedBy: "signOut.signOut(").count - 1, 1,
                       "a second call site would be one that skipped the serialization")
        // Nowhere in the app may reach the session's sign-out directly except
        // the two account-router screens that hold no rows and have no scope to
        // give: `.unavailable` and check-email, both of which are signed-OUT
        // states by the time they are on screen.
        let direct = all.filter { $0.text.contains("session.logOut()") }.map(\.name).sorted()
        XCTAssertEqual(direct, ["AccountTab.swift"],
                       "a signed-in surface signs out around the coordinator")
    }

    /// A Refresh already in flight must not put the rows and reconstructed links
    /// back after a sign-out cleared them.
    ///
    /// `AccountSession.logOut()` deliberately keeps `.ready` on screen until its
    /// network revocation finishes. A superseded Refresh therefore returns to a
    /// still-ready old account and `AccountRefreshDecision` would legitimately
    /// choose `.reload` — recreating every `#k=` link for the length of the
    /// sign-out timeout, which is exactly the interval the pre-call clear exists
    /// to avoid.
    ///
    /// The gate reads the COORDINATOR, not this view's `@State`. That is the
    /// review's finding applied to the gate as well as to the observer: the
    /// account view can be torn down and rebuilt mid-sign-out — a tab switch away
    /// and back — and a fresh `@State` would come back `false` and reopen the
    /// gate while the revocation was still running.
    func testLeavingTheAccountPreventsAnOlderRefreshFromRehydratingItsRows() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertFalse(summary.text.contains("@State private var isLeavingAccount"),
                       "a view-scoped leave flag does not survive the view it lives on")
        guard let refreshStart = summary.text.range(of: "private func refresh() {") else {
            return XCTFail("AccountSummaryView no longer has one refresh seam")
        }
        let refresh = summary.text[refreshStart.lowerBound...]
        guard let sessionRefresh = refresh.range(of: "await session.refresh()"),
              let leaveGuard = refresh.range(of: "guard !signOut.isSigningOut else {") else {
            return XCTFail("refresh no longer refuses to reload an account being left")
        }
        XCTAssertTrue(sessionRefresh.upperBound < leaveGuard.lowerBound,
                      "the leave signal must be checked when the suspended refresh returns")
        XCTAssertTrue(refresh[leaveGuard.lowerBound...].contains("management.clear(scope: previous)"),
                      "a late refresh must leave the old scope deactivated")
    }

    /// **No view owns the self-revoke hand-off.**
    ///
    /// This is the defect the R3-D review found, and it is a lifecycle one, so
    /// nothing about it is visible in the account screen's own behaviour. The
    /// hand-off used to be a `.task(id: management.needsSignOut)` on this view.
    /// A user who taps Revoke on the current device and immediately switches
    /// tabs takes that view down before the response lands: the app-scoped model
    /// still records the signal truthfully, but nothing consumes it, so the
    /// other tabs go on offering to spend a bearer the server has already
    /// revoked until the user happens to return to the Account tab.
    ///
    /// The account screen may still START a revoke. It may not be what NOTICES
    /// one succeeded — so it names none of the machinery, and a re-layout cannot
    /// reintroduce a view-scoped observer without failing here.
    func testNoViewOwnsTheSelfRevokeHandOff() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        for viewScoped in ["needsSignOut", "acknowledgeSignOut", "consumeSelfRevoke",
                           "session.logOut()"] {
            XCTAssertFalse(summary.text.contains(viewScoped),
                           "the account view owns \(viewScoped) again — a tab switch would "
                           + "strand a revoked credential")
        }
        // Two `.task`s used to live here. Only the scope-keyed load may now.
        XCTAssertEqual(summary.text.components(separatedBy: ".task(").count - 1, 1,
                       "the only task on this view is the scope-keyed load")
    }

    /// The observer is app-scoped and subscribes BEFORE any view exists.
    ///
    /// Stronger than "an always-mounted root": it does not depend on a view
    /// hierarchy at all, which is the same reason `SendSelectionModel.observe`
    /// is called from `init` rather than from a `.task`. `AccountSession` is
    /// never handed to the coordinator directly — it takes a closure, so
    /// `AccountSignOutCoordinatorTests` can hold a logout open and look at the
    /// app while the call is in flight.
    func testTheSelfRevokeObserverIsAppScopedAndStartedBeforeAnyView() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("@StateObject private var signOut: AccountSignOutCoordinator"),
                      "the observer belongs to the App, not to a view")
        // The locals are named apart from the properties, the way this file
        // already names `account`, `uploads` and `sending`: a `@StateObject`'s
        // property cannot be read inside `init`, so the wiring necessarily runs
        // against locals.
        XCTAssertTrue(app.text.contains(".observe(managing.$needsSignOut)"),
                      "it has to be subscribed to the signal")
        XCTAssertTrue(app.text.contains(".environmentObject(signOut)"))
        // Subscribed inside `init`, so no view's lifetime gates it.
        guard let initRange = app.text.range(of: "init() {"),
              let body = app.text.range(of: "var body: some Scene"),
              let observe = app.text.range(of: ".observe(managing.$needsSignOut)") else {
            return XCTFail("RelayiumApp no longer has the shape this checks")
        }
        XCTAssertTrue(initRange.upperBound < observe.lowerBound
                      && observe.upperBound < body.lowerBound,
                      "the subscription must be made in init, before any view is built")
        // Constructed exactly once, and known to exactly the three files that
        // need it: the app that owns it, the shell that blocks on it, and the
        // account screen that hands it an explicit sign-out.
        XCTAssertEqual(app.text.components(separatedBy: "AccountSignOutCoordinator(").count - 1, 1,
                       "a second coordinator would be a second logout path")
        XCTAssertEqual(all.filter { $0.text.contains("AccountSignOutCoordinator") }
                          .map(\.name).sorted(),
                       ["AccountSummaryView.swift", "RelayiumApp.swift", "RootView.swift"])
        for (name, text) in all where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("$needsSignOut"),
                           "\(name) starts a second observer")
        }
    }

    /// While the network logout is finishing, every tab is blocked and says so.
    ///
    /// The bearer is already dead server-side by then, so an action started in
    /// another tab would fail against the server and report it as the user's
    /// problem. Blocked AND labelled: a frozen tab bar with no explanation reads
    /// as the app having hung, and a bare spinner reads as nothing at all to
    /// VoiceOver.
    ///
    /// It is a transient operation, not an account gate. The shell still never
    /// reads `session.state` and never sees the account's rows, so anonymous
    /// receive stays structurally independent of whether anyone is signed in.
    func testEveryTabIsBlockedAndLabelledWhileTheLogoutFinishes() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("@EnvironmentObject private var signOut: AccountSignOutCoordinator"))
        XCTAssertTrue(root.text.contains(".disabled(signOut.isSigningOut)"),
                      "a tab must not act with a credential the server has revoked")
        XCTAssertTrue(root.text.contains("ProgressView { Text(L10n.t(.accountSigningOut)) }"),
                      "the block has to say what it is waiting for")
        // The shell learns exactly one thing, and it is not who is signed in.
        for accountish in ["session.state", "AccountManagementModel", "management",
                           "bearerToken", "AccountScope"] {
            XCTAssertFalse(root.text.contains(accountish),
                           "the shell reads \(accountish) — that would gate the receive tab")
        }
    }

    /// Both row actions are destructive and both ask first, through the system's
    /// own dialog — which is what makes them dismissible, readable at every
    /// Dynamic Type size and announced the way the platform's users expect.
    ///
    /// The revoke message is not fixed text: revoking the credential in your hand
    /// signs this app out, and revoking another one does not. The decision lives
    /// in `AccountPresentation.revokeConsequence`, where a test drives it.
    func testBothRowActionsConfirmBeforeActingAndSayWhatTheyCost() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertEqual(summary.text.components(separatedBy: "confirmationDialog(").count - 1, 3,
                       "revoke, delete-file and delete-account are three confirmations")
        guard let revokeDialog = summary.text.range(of: ".confirmationDialog(\n            L10n.t(.accountRevokeTitle"),
              let fileDialog = summary.text.range(of: ".confirmationDialog(\n            L10n.t(.accountDeleteFileTitle)"),
              let accountDialog = summary.text.range(of: ".confirmationDialog(\n            L10n.t(.accountDeleteAccountConfirmTitle)") else {
            return XCTFail("one of the three destructive confirmations is no longer attached")
        }
        XCTAssertTrue(summary.text[revokeDialog.lowerBound..<fileDialog.lowerBound]
            .contains("Button(L10n.t(.commonRevoke), role: .destructive)"),
                      "the confirmed revoke action must carry the destructive role")
        XCTAssertTrue(summary.text[fileDialog.lowerBound..<accountDialog.lowerBound]
            .contains("Button(L10n.t(.commonDelete), role: .destructive)"),
                      "the confirmed stored-file delete must carry the destructive role")
        XCTAssertTrue(summary.text.contains(
            "AccountPresentation.revokeConsequence(current: deviceToRevoke?.current == true)"),
            "the consequence must come from the tested seam, not from an inline ternary")
        // The list buttons must OPEN a dialog rather than act. A direct call
        // would be a one-tap revoke of the credential the user is holding.
        XCTAssertEqual(summary.text.components(separatedBy: "management.revoke(").count - 1, 1)
        XCTAssertEqual(summary.text.components(separatedBy: "management.delete(").count - 1, 1)
        for opener in ["deviceToRevoke = device", "fileToDelete = row.file"] {
            XCTAssertTrue(summary.text.contains(opener), "the row button must open \(opener)")
        }
    }

    /// The rebuilt link leaves through the share sheet the user opened, and the
    /// three key states are decided in the tested seam.
    ///
    /// A `#k=` fragment IS the plaintext. Writing one to `UIPasteboard` on the
    /// app's own initiative would hand it to every app on the device and raise
    /// iOS's own paste notification besides — which is why the pasteboard stays
    /// on the deferred-symbol list rather than becoming this slice's affordance.
    func testTheRebuiltLinkGoesOutThroughTheSystemShareSheetOnly() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("AccountPresentation.link(for: row.link)"),
                      "which of the three states a row is in belongs in the tested seam")
        XCTAssertTrue(summary.text.contains("ShareLink(item: link)"),
                      "the link must leave through the platform's hand-off")
        XCTAssertEqual(summary.text.components(separatedBy: "ShareLink(").count - 1, 1,
                       "one share affordance, in the one arm that has a link")
        // Both unavailable states are rendered, and rendered differently: one is
        // permanent from this device, the other may be one unlock away.
        for arm in ["case .unavailable(let explanation):", "case .lookupFailed(let explanation):"] {
            XCTAssertTrue(summary.text.contains(arm), "the row no longer distinguishes \(arm)")
        }
    }

    /// Failure and warning states carry a symbol and readable text, never colour
    /// alone, and every progress indicator is labelled.
    ///
    /// A bare `ProgressView()` says nothing to VoiceOver and nothing to anybody
    /// on a screen with two lists loading at once. Red on its own says nothing
    /// under a colour filter, in Increase Contrast, or to a reader who cannot
    /// distinguish it.
    func testEveryManagementStateIsReadableWithoutColourOrSight() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertFalse(summary.text.contains("ProgressView()\n"),
                       "an unlabelled spinner reads as nothing")
        for labelled in ["ProgressView { Text(L10n.t(.accountLoadingDevices)) }",
                         "ProgressView { Text(L10n.t(.accountLoadingFiles)) }"] {
            XCTAssertTrue(summary.text.contains(labelled), "missing \(labelled)")
        }
        for state in [".accountNoDevices", ".accountNoFiles"] {
            XCTAssertTrue(summary.text.contains(state), "the empty state \(state) is not rendered")
        }
        // Red is named ONCE in the file, and the one place that names it draws a
        // symbol in the same expression. Counting symbols against reds would
        // pass on a file with four symbols somewhere and a bare red line
        // somewhere else; this cannot, because there is nowhere else to put one.
        let reds = summary.text.components(separatedBy: "foregroundStyle(.red)").count - 1
        XCTAssertEqual(reds, 1, "every failure on this screen goes through one helper")
        let helper = try XCTUnwrap(
            summary.text.range(of: "private func failureLine(_ text: String) -> some View {"))
        let redUse = try XCTUnwrap(summary.text.range(of: "foregroundStyle(.red)"))
        XCTAssertTrue(helper.upperBound < redUse.lowerBound,
                      "the one red is not the helper's")
        XCTAssertTrue(summary.text[helper.upperBound..<redUse.lowerBound]
            .contains("systemImage: \"exclamationmark.triangle\""),
                      "the helper states a failure in colour with no symbol beside it")
        // The row actions are named for the row they belong to, which is the
        // only thing telling two same-named devices apart without sight.
        for label in ["AccountPresentation.revokeActionLabel(for: device)",
                      "AccountPresentation.shareActionLabel(fileId: row.file.id)",
                      "AccountPresentation.deleteActionLabel(fileId: row.file.id)"] {
            XCTAssertTrue(summary.text.contains(label), "missing accessibility label: \(label)")
        }
    }

    /// The cleanup warning is dismissible, and it is not a row error.
    ///
    /// It is raised after a delete the server CONFIRMED, so calling it a failure
    /// would send the user to retry an operation that already succeeded — and the
    /// row it would attach to is gone. What is left is a statement about what is
    /// still on this device, with nothing to retry and a way to put it away.
    func testTheCleanupWarningIsANonBlockingDismissibleNotice() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("management.keyCleanupWarning"))
        XCTAssertTrue(summary.text.contains("management.dismissKeyCleanupWarning()"),
                      "a warning with no way to dismiss it is a permanent one")
        XCTAssertTrue(summary.text.contains("management.loadError"),
                      "a whole-list failure is distinct from a per-row one")
        XCTAssertTrue(summary.text.contains("management.error(forRow: device.id)"))
        XCTAssertTrue(summary.text.contains("management.error(forRow: row.id)"))
        // Only the row in flight is disabled: a slow revoke on one device must
        // not freeze the rest of the list.
        XCTAssertTrue(summary.text.contains("management.isBusy(row: device.id)"))
        XCTAssertTrue(summary.text.contains("management.isBusy(row: row.id)"))
        XCTAssertFalse(summary.text.contains(".disabled(management.isLoading)"),
                       "loading must not disable rows that are not being changed")
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
