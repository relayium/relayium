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
///     link rebuild — and corrects those the same way. R3-E reaches a ninth,
///     `verify.explainEncryption`, because this is the slice that renders the
///     advanced-verification setting. **Seven** remain, six blocked behind the
///     nearby/notification feature this app does not have and one rendered by
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
        try sources(under: iosRoot, atLeast: 12)
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
        let scanned = try sources(under: iosRoot, atLeast: 12)
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
        // `RealtimeSessionModel` and `RealtimeTextSessionModel` LEFT this list in
        // R3-E, for the same reason `CloudUploadModel` left it in R3-C: this is
        // the slice that renders them. What replaces the ban is the whole R3-E
        // section below — app-scoped construction through the code-only
        // factories, a gated create beside an ungated join, a resolved receive
        // destination, and a foreground-only lifecycle. Those are harder claims
        // than an absence.
        //
        // `UIPasteboard` also left it, and it is the one that needed the most
        // care: R3-E has per-message Copy, which is a pasteboard WRITE the user
        // asked for. The ban is replaced by
        // `testThePasteboardIsWrittenOnlyInsideAnExplicitCopyActionAndNeverRead`,
        // which allows exactly that one write and still forbids every read.
        //
        // The nearby half stays banned, and gained `InboundRoom` and the two
        // factory names: iOS has no local-network entitlement, no roster and no
        // listener, so any of these appearing would be a capability claimed in
        // the file every reviewer opens first.
        let deferred = [
            "BrowserLoginModel",
            "LanDiscoveryModel", "NearbyReceiveModel", "InboundRoom",
            "makeLanDiscoveryModel", "makeNearbyReceiveModel",
            "connectNearby", "acceptNearby", "NearbyError",
            "onOpenURL", "UNUserNotificationCenter", "StoreKit",
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
        // **R3-E takes a ninth off by the same route.** This slice renders the
        // advanced-verification setting, so `verify.explainEncryption` — which
        // said keys are generated *on this Mac* — was corrected in place in all
        // nine catalogs to the device noun each language uses. It is the one
        // sentence on that setting that states what the preference does NOT
        // change, so weakening it was not an option; only the platform noun
        // moved. `LocalizedCopyTests.testTheVerificationExplanationNamesNoPlatformAndKeepsItsEncryptionClaims`
        // carries the claim from here on, and it carries the half a ban cannot:
        // that the four encryption facts are all still in the sentence.
        let platformNaming: [L10nKey] = [
            // R3-F: nearby and notifications. iOS has neither.
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText,
            .errorNearbyNoAnswer,
            // Rendered by nothing on either platform yet.
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 7)
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
        // `DirectView` joins the list in R3-E, and it is the only one of the
        // three that reads the credential WITHOUT spending it: it builds an
        // `AccountGate`, whose `.allowed` arm carries the token to the one
        // action that needs one — minting a code, which is billed to whoever
        // created it. Joining a code is beside it in the same view and reaches
        // the transport with no credential at all.
        XCTAssertEqual(readers, ["AccountSummaryView.swift", "DirectView.swift",
                                 "SendView.swift"],
                       "a fourth view-layer holder of the credential")
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

    // MARK: - R3-E: the Direct tab

    private func direct() throws -> (name: String, text: String) {
        try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" })
    }

    /// Four tabs, and the shell still learns nothing about the account.
    ///
    /// Direct is the second tab with a half that needs one, and it is the first
    /// where the two halves sit side by side on one screen. So the temptation is
    /// sharper than it was in R3-C: a `session.state` switch up here would be
    /// the natural way to draw "create" and "join" differently, and it would
    /// take the anonymous receive tab with it.
    func testTheShellGainedTheDirectTabAndStillReadsNoSessionState() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("case receive, send, direct, account"),
                      "the tab set is not the four this slice ships")
        XCTAssertTrue(root.text.contains("L10n.t(.tabDirect)"))
        XCTAssertTrue(root.text.contains(".tag(Tab.direct)"))
        for accountish in ["session.state", "AccountGate", "bearerToken"] {
            XCTAssertFalse(root.text.contains(accountish),
                           "the shell reads \(accountish) — that would gate the receive tab")
        }
    }

    /// Both realtime models are app-scoped, built once, from the CODE-ONLY
    /// factories.
    ///
    /// Two claims, and the second is the one a diff hides. App-scoped, because a
    /// `TabView` tears an off-screen tab down and a live DataChannel must not go
    /// with it — the user checking their plan mid-transfer is exactly that.
    /// Code-only, because the nearby factories take a `LanDiscoveryModel` and an
    /// `InboundRoom`, and constructing those here would open a room socket
    /// nothing reads and claim a local-network capability this app has no
    /// entitlement for.
    func testTheRealtimeModelsAreAppScopedAndBuiltFromTheCodeOnlyFactories() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        for scoped in ["@StateObject private var direct: RealtimeSessionModel",
                       "@StateObject private var directText: RealtimeTextSessionModel",
                       "@StateObject private var verification: VerificationPreference",
                       "@StateObject private var directSelection: DirectSendSelection",
                       "@StateObject private var directModes: DirectModeSelection",
                       "@StateObject private var foreground: ForegroundSessionCoordinator"] {
            XCTAssertTrue(app.text.contains(scoped), "missing app-scoped owner: \(scoped)")
        }
        XCTAssertTrue(app.text.contains("AppEnvironment.makeRealtimeModel(verification: verifying)"),
                      "the file model must come from the code-only factory")
        XCTAssertTrue(app.text.contains("AppEnvironment.makeRealtimeTextModel(verification: verifying)"),
                      "the text model must come from the code-only factory")
        for once in ["makeRealtimeModel(", "makeRealtimeTextModel(", "VerificationPreference(",
                     "DirectSendSelection(", "DirectModeSelection(",
                     "ForegroundSessionCoordinator("] {
            XCTAssertEqual(all.map { $0.text.components(separatedBy: once).count - 1 }.reduce(0, +), 1,
                           "\(once) is constructed more than once — a second owner")
        }
        // ONE preference object, shared by both models and by the control that
        // flips it. Two would be a toggle that moves a setting neither session
        // reads.
        XCTAssertTrue(app.text.contains(".environmentObject(verification)"))
    }

    /// Creating a code is gated; joining one is not, and is not merely enabled —
    /// it is rendered outside the gate entirely.
    ///
    /// This is the asymmetry the whole destination exists to express, and it is
    /// a server-side fact rather than a UI preference: minting reserves relay
    /// capacity billed to the account that created it, and joining reserves
    /// nothing and presents no credential. A gate around both halves would take
    /// away a capability that works signed out.
    func testCreatingACodeIsGatedAndJoiningIsRenderedOutsideTheGate() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("AccountGate.from(session.state, bearer: session.bearerToken)"),
                      "the gate must be built from the shared, tested mapping")
        XCTAssertTrue(view.text.contains("case let .allowed(access)"),
                      "only the allowed arm may carry a token")
        // The credential is read ONCE, to build the gate, and the only thing
        // that ever sees it afterwards is the gate's `.allowed` payload on its
        // way to the two mints. A second `session.bearerToken` would be a read
        // that skipped the mapping — which is how an empty-string bearer used to
        // reach the transport.
        XCTAssertEqual(view.text.components(separatedBy: "session.bearerToken").count - 1, 1,
                       "the credential must be read once, to build the gate")
        for action in ["await createAndSend()", "await createTextSession()"] {
            XCTAssertTrue(view.text.contains(action),
                          "the button must call \(action) without capturing a credential")
        }
        XCTAssertEqual(
            view.text.components(separatedBy:
                "guard case let .allowed(access) = gate else { return }").count - 1,
            2,
            "both create actions must re-read the live gate at the instant of use")
        XCTAssertEqual(view.text.components(separatedBy:
            "mintCode(token: access.token)").count - 1, 2,
            "both mints must spend the token from that live gate read")
        guard let joinCard = view.text.range(of: "private func joinCard("),
              let fileJoin = view.text.range(of: "private func joinToReceiveFiles()"),
              let fileCreate = view.text.range(of: "private func createAndSend()"),
              let textJoin = view.text.range(of: "private func joinTextSession()"),
              let textCreate = view.text.range(of: "private func createTextSession()") else {
            return XCTFail("DirectView no longer has a join half of its own")
        }
        // Isolate the shared join card and both receive actions. The two create
        // actions follow them in the same source file and MUST read the live
        // gate, so scanning to EOF would mistake the intended asymmetry for a
        // join dependency.
        let join = String(view.text[joinCard.lowerBound..<fileJoin.lowerBound])
            + String(view.text[fileJoin.lowerBound..<fileCreate.lowerBound])
            + String(view.text[textJoin.lowerBound..<textCreate.lowerBound])
        for gated in ["AccountGate", "access.token", "session.state"] {
            XCTAssertFalse(join.contains(gated),
                           "the join half reads \(gated) — joining needs no account")
        }
        XCTAssertTrue(view.text.contains("L10n.t(.directJoinNoAccountNeeded)"),
                      "and it has to say so, rather than leaving it to be discovered")
    }

    /// AccountGate exists to keep unlike failures unlike. Direct must not turn
    /// them all back into the same “open account” card.
    func testTheDirectCreateGateRendersEveryAccountStateTruthfully() throws {
        let view = try direct()
        let start = try XCTUnwrap(view.text.range(of: "private var capabilityGate:"))
        let end = try XCTUnwrap(view.text.range(of: "private var openAccountButton:"))
        let gate = view.text[start.lowerBound..<end.lowerBound]
        for state in ["case .allowed:", "case .loading:", "case .signInRequired:",
                      "case let .unavailable(message):", "case let .verifyEmail(email):",
                      "case let .pendingDeletion(purgeAfter, _):"] {
            XCTAssertTrue(gate.contains(state), "Direct flattens AccountGate's \(state)")
        }
        for truth in [".accountRestoring", ".gateCreateCodeTitle", ".gateCreateCodeBody",
                      "failureLine(message)", "await session.refresh()",
                      ".contentCheckEmailTitle", ".contentCheckEmailBody",
                      ".contentPendingDeletionTitle", ".contentPendingDeletionBody"] {
            XCTAssertTrue(gate.contains(truth), "Direct does not render \(truth)")
        }
        XCTAssertTrue(view.text.contains("if showsAnonymousNote"),
                      "the anonymous-join explanation is duplicated for gated users")
        XCTAssertTrue(view.text.contains("case .signInRequired: return false"),
                      "the ordinary sign-in card repeats the anonymous-join explanation")
        XCTAssertTrue(view.text.contains(
            "case .allowed, .loading, .unavailable, .verifyEmail, .pendingDeletion: return true"),
            "an unrelated account problem hides that joining still needs no account")
    }

    /// The join field is a six-digit numeric one-time code, normalized on every
    /// change.
    ///
    /// Each clause is a real failure: the default keyboard makes a user hunt for
    /// the number row, no `oneTimeCode` content type means iOS never offers the
    /// code from a message, and normalizing anywhere but on every change is what
    /// used to eat a leading `1` — `normalizedPairingCode` keeps digits and
    /// caps at six, so a code beginning with 1 is only typeable if the filter
    /// runs on the raw text rather than on a parsed number.
    func testTheJoinFieldIsANumericOneTimeCodeNormalisedOnEveryChange() throws {
        let view = try direct()
        // ONE field, shared by both modes. Two would be two places for the
        // keyboard type, the content type and the normalization to drift, and
        // the drift is silent: a field that works and one that eats a leading
        // digit look identical in a screenshot.
        for wired in [".keyboardType(.numberPad)", ".textContentType(.oneTimeCode)"] {
            XCTAssertEqual(view.text.components(separatedBy: wired).count - 1, 1,
                           "the one join field must carry \(wired), exactly once")
        }
        // But each MODEL normalizes its own text, so both are wired to it.
        XCTAssertEqual(view.text.components(separatedBy: "updateJoinCode(").count - 1, 2,
                       "both models must normalize on every change")
        XCTAssertFalse(view.text.contains("Int("),
                       "a code is a string; an Int round trip would destroy 004291")
    }

    /// The code the user reads off this screen is monospaced, selectable, and
    /// spoken one digit at a time.
    ///
    /// A six-digit code read as a NUMBER is "four hundred eighty-three thousand
    /// nine hundred twenty", which nobody can type into the other device — which
    /// is the entire task this screen exists for.
    func testTheDisplayedCodeIsMonospacedAndSpokenAsDigits() throws {
        let code = try XCTUnwrap(try sources().first { $0.name == "PairingCodeText.swift" })
        XCTAssertTrue(code.text.contains("design: .monospaced"),
                      "a proportional font makes a transcribed code ambiguous")
        XCTAssertTrue(code.text.contains(".accessibilityLabel(spokenCode)"))
        XCTAssertTrue(code.text.contains("joined(separator: \" \")"),
                      "the digits must be separated so VoiceOver reads them one at a time")
        XCTAssertTrue(code.text.contains("L10n.token(code)"),
                      "the code must be bidi-isolated so Arabic does not reverse it")
    }

    /// The Files/Text choice goes through the locked selection, never a raw
    /// binding.
    ///
    /// `$modes.mode` would be a `Picker` writing straight into the model, and a
    /// `.disabled` modifier is a courtesy rather than the mechanism — SwiftUI
    /// still owns the binding behind a disabled control. The refusal has to be
    /// in `DirectModeSelection.select`, where `DirectModeSelectionTests` drives
    /// it against every state of both models.
    func testTheModeChoiceGoesThroughTheLockedSelectionAndNotARawBinding() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("modes.select("),
                      "the mode must change through the guarded entry point")
        XCTAssertTrue(view.text.contains("DirectModeSelection.isLocked(file: file.state, text: text.state)"),
                      "the lock must be derived from the two live model states")
        XCTAssertFalse(view.text.contains("$modes.mode"),
                       "a raw binding lets a rebuild move the mode under a running session")
    }

    /// A terminal session is still owned until Done, so it cannot also expose
    /// the controls that replace it with a new one.
    ///
    /// `DirectModeSelection` already locks the Files/Text picker for these
    /// states. That is not enough by itself: if Create or Join remains in the
    /// terminal switch arm, the user can replace the model while its result,
    /// partial receive or memory-only transcript is still on screen. Pin the
    /// view wiring at the state boundary where that regression occurs.
    func testTerminalDirectSessionsExposeOnlyDoneBeforeAnotherSessionCanStart() throws {
        let view = try direct()

        let filesStart = try XCTUnwrap(view.text.range(of: "private var filesMode:"))
        let filesEnd = try XCTUnwrap(view.text.range(of: "private var createFiles:"))
        let files = view.text[filesStart.lowerBound..<filesEnd.lowerBound]
        let fileIdleStart = try XCTUnwrap(files.range(of: "case .idle:"))
        let fileFailedStart = try XCTUnwrap(files.range(of: "case let .failed(message):"))
        let fileMintingStart = try XCTUnwrap(files.range(of: "case .minting:"))
        let fileIdle = files[fileIdleStart.lowerBound..<fileFailedStart.lowerBound]
        let fileFailed = files[fileFailedStart.lowerBound..<fileMintingStart.lowerBound]
        XCTAssertTrue(fileIdle.contains("createFiles"))
        XCTAssertTrue(fileIdle.contains("joinCard("))
        XCTAssertTrue(fileFailed.contains("L10n.t(.commonDone)"))
        XCTAssertFalse(fileFailed.contains("createFiles"),
                       "a failed file session can be replaced before cleanup")
        XCTAssertFalse(fileFailed.contains("joinCard("),
                       "a failed file session can join before cleanup")

        let textStart = try XCTUnwrap(view.text.range(of: "private var textMode:"))
        let textEnd = try XCTUnwrap(view.text.range(of: "private var createText:"))
        let text = view.text[textStart.lowerBound..<textEnd.lowerBound]
        let textIdleStart = try XCTUnwrap(text.range(of: "case .idle:"))
        let textTerminalStart = try XCTUnwrap(
            text.range(of: "case .failed, .ended, .refused, .unsupported:"))
        let textMintingStart = try XCTUnwrap(text.range(of: "case .minting:"))
        let textIdle = text[textIdleStart.lowerBound..<textTerminalStart.lowerBound]
        let textTerminal = text[textTerminalStart.lowerBound..<textMintingStart.lowerBound]
        XCTAssertTrue(textIdle.contains("createText"))
        XCTAssertTrue(textIdle.contains("joinCard("))
        XCTAssertTrue(textTerminal.contains("DirectTextSessionView(model: text)"))
        XCTAssertTrue(textTerminal.contains("L10n.t(.commonDone)"))
        XCTAssertFalse(textTerminal.contains("createText"),
                       "a terminal transcript can be replaced before Done")
        XCTAssertFalse(textTerminal.contains("joinCard("),
                       "a terminal transcript can join another session before Done")
    }

    /// The receive folder is resolved BEFORE a connection is opened, and a
    /// failure to resolve it connects nothing.
    ///
    /// The order is the whole point. `RealtimeSessionModel.saveDirectory`
    /// defaults to Downloads — which on iOS is a directory in nobody's
    /// container — so a join that ran before the destination was set would
    /// connect, handshake, accept a manifest and only then discover it has
    /// nowhere to write, with the peer already sending. And the fallback is the
    /// other half: quietly writing to `temporaryDirectory` would put the user's
    /// files somewhere iOS deletes without warning and the Files app never
    /// shows.
    func testTheReceiveDestinationIsResolvedBeforeJoiningAndNeverFallsBack() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("try ReceiveDestination.directory()"),
                      "the destination must come from the shared, container-aware seam")
        XCTAssertTrue(view.text.contains("ReceiveDestinationCopy.message(for: error, in: .appFolder)"),
                      "a failure must render the iOS Files-app recovery, not the picker advice")
        // The RESPONDER join specifically, named exactly: the initiator join
        // elsewhere in this file sends rather than receives and has no
        // destination to resolve, so matching "any join" would pass on the
        // wrong one.
        guard let resolve = view.text.range(of: "try ReceiveDestination.directory()"),
              let install = view.text.range(of: "file.saveDirectory = destination"),
              let joinCall = view.text.range(of: "await file.join(code: file.joinCode)") else {
            return XCTFail("DirectView no longer resolves a destination before joining")
        }
        XCTAssertTrue(resolve.upperBound < install.lowerBound,
                      "the resolved destination was never installed on the model")
        XCTAssertTrue(install.upperBound < joinCall.lowerBound,
                      "the join must sit after the destination is set, not beside it")
        for fallback in ["temporaryDirectory", "downloadsDirectory", ".cachesDirectory"] {
            for (name, text) in try sources() {
                XCTAssertFalse(text.contains(fallback),
                               "\(name) writes received files to \(fallback)")
            }
        }
    }

    /// File preparation is not a session. If it fails, the explanation for an
    /// earlier background interruption must remain until the user dismisses it
    /// or a real new attempt starts.
    func testDirectFileCreatePreparesAndRechecksTheAccountBeforeStartingASession() throws {
        let view = try direct()
        let start = try XCTUnwrap(view.text.range(of: "private func createAndSend()"))
        let end = try XCTUnwrap(view.text.range(of: "private func joinTextSession()"))
        let action = view.text[start.lowerBound..<end.lowerBound]
        let prepare = try XCTUnwrap(action.range(of: "selection.stageForSend()"))
        let account = try XCTUnwrap(action.range(of:
            "guard case let .allowed(access) = gate else { return }"))
        let session = try XCTUnwrap(action.range(of: "foreground.sessionStarting()"))
        let stage = try XCTUnwrap(action.range(of: "file.stageSend("))
        XCTAssertTrue(prepare.lowerBound < account.lowerBound)
        XCTAssertTrue(account.lowerBound < session.lowerBound)
        XCTAssertTrue(session.lowerBound < stage.lowerBound,
                      "the interruption notice must clear only once a real session starts")
    }

    /// The share affordance is built from `model.received`, which is non-nil
    /// only in `.completed` — which the model reaches only after
    /// `ManifestWriter.finish()` returned. Nothing here can offer a file that is
    /// still being written, and a folder receive shares its CONTAINER so the
    /// hierarchy survives *Save to Files*.
    func testTheReceivedResultIsShareableOnlyAfterTheWriterFinished() throws {
        let session = try XCTUnwrap(
            try sources().first { $0.name == "DirectFileSessionView.swift" })
        XCTAssertTrue(session.text.contains("if let payload = model.received"),
                      "the result must come from the model's post-finish payload")
        XCTAssertTrue(session.text.contains("ShareLink(items: payload.dragURLs)"),
                      "a foldered receive must share its container as one item")
        XCTAssertFalse(session.text.contains("ShareLink(items: urls)"),
                       "sharing the flat file list would flatten the folder at the destination")
    }

    /// **The pasteboard is written once, by a button the user pressed, and is
    /// never read.**
    ///
    /// This replaces the blanket ban `UIPasteboard` carried through four slices.
    /// A text session has to offer Copy — a message the user cannot get out of
    /// the app is a message they have to retype — and the honest shape of that
    /// is one write inside one action. Reading is a different thing entirely: an
    /// app that inspects the clipboard is doing what this product promises not
    /// to, and iOS raises its own paste notification for it besides.
    func testThePasteboardIsWrittenOnlyInsideAnExplicitCopyActionAndNeverRead() throws {
        let all = try sources()
        let holders = all.filter { $0.text.contains("UIPasteboard") }.map(\.name).sorted()
        XCTAssertEqual(holders, ["DirectTextSessionView.swift"],
                       "the pasteboard is reachable from somewhere other than Copy")
        let view = try XCTUnwrap(all.first { $0.name == "DirectTextSessionView.swift" })
        XCTAssertEqual(view.text.components(separatedBy: "UIPasteboard").count - 1, 1,
                       "one mention, so there is one thing to review")
        XCTAssertTrue(view.text.contains("UIPasteboard.general.string = message.body"),
                      "the one use must be a write of the message the button belongs to")
        // Every read API, by name. `.string =` above is an assignment; these are
        // the forms that take something OUT.
        for reader in ["UIPasteboard.general.string)", "UIPasteboard.general.hasStrings",
                       "UIPasteboard.general.items", "UIPasteboard.general.strings",
                       "UIPasteboard.general.url", "UIPasteboard.general.changeCount",
                       "detectPatterns", "value(forPasteboardType"] {
            XCTAssertFalse(view.text.contains(reader), "the app inspects the clipboard: \(reader)")
        }
        XCTAssertTrue(view.text.contains("Button(L10n.t(.commonCopy))"),
                      "the write must belong to a Copy button, per message")
        XCTAssertTrue(view.text.contains("L10n.t(.textClipboardNotice)"),
                      "and the screen must say what a copy costs")
    }

    /// **`.inactive` is not `.background`,** and this is where that gets got
    /// wrong.
    ///
    /// SwiftUI reports `.inactive` while a document picker, a share sheet or the
    /// app switcher is up — which is to say, at the exact moment the user is
    /// choosing the files they are about to send. A mapping that folded it into
    /// `.background` would cancel the session on the way into the picker, every
    /// time, and would read as the picker being broken. The decision itself is
    /// `ForegroundSessionCoordinator`'s, where a test drives it; this pins the
    /// one line that feeds it.
    func testTheScenePhaseObserverDistinguishesInactiveFromBackground() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("@Environment(\\.scenePhase) private var scenePhase"))
        XCTAssertTrue(app.text.contains("case .background: return .background"))
        XCTAssertTrue(app.text.contains("case .inactive: return .inactive"),
                      "a picker or a share sheet must not end the session")
        XCTAssertTrue(app.text.contains("foreground.phaseChanged(to: lifecycle(phase))"))
        // Exactly one observer, at the app scope: a second in a view would fire
        // only while that view was mounted, which is precisely when it is not.
        // Three occurrences, all in `RelayiumApp`: twice on the `@Environment`
        // declaration (the key path and the property name) and once in the
        // `onChange` that reads it. A fourth would be a second reader.
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "scenePhase").count - 1 }
                          .reduce(0, +), 3,
                       "the scene phase is declared and read in exactly one place")
        for (name, text) in all where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("phaseChanged("),
                           "\(name) is a second lifecycle observer")
        }
    }

    /// The advanced-verification setting is on screen, and it is the shared
    /// preference object rather than a local toggle.
    ///
    /// Default OFF is `VerificationPreference`'s own decision and
    /// `VerificationPreference`'s tests prove it. What this pins is that the
    /// setting is REACHABLE — a security control that only exists on macOS is a
    /// control iOS users cannot turn on — and that flipping it moves the object
    /// both models read, rather than a `@State` nothing consults.
    func testTheVerificationSettingIsVisibleAndIsTheSharedPreference() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("Toggle(L10n.t(.verifyToggle), isOn: $verification.requiresSASConfirmation)"),
                      "the toggle must write the shared preference")
        for explanation in [".verifyExplainWhat", ".verifyExplainEncryption"] {
            XCTAssertTrue(view.text.contains(explanation),
                          "the setting must say what it does and does not change: \(explanation)")
        }
        XCTAssertFalse(view.text.contains("@State private var requiresSAS"),
                       "a view-local copy would be a setting no session reads")
    }

    /// Direct says what it is for, and hands the large-file case to the tab that
    /// can actually carry it.
    ///
    /// A peer-to-peer transfer that needs both apps open is genuinely worse than
    /// the stored one for a large file, and a user who discovers that ninety
    /// seconds in has been misled by omission. The route out is a tab selection,
    /// which is why it arrives as a closure — the same shape `SendView` already
    /// uses for the account, and the reason `RootView` can stay ignorant.
    func testDirectPositionsItselfAndRoutesLargeFilesToTheStoredSendTab() throws {
        let view = try direct()
        for copy in [".navPairingCodeSubtitle", ".directLargeFilesTitle",
                     ".directLargeFilesBody", ".directOpenSend", ".directKeepBothOpen"] {
            XCTAssertTrue(view.text.contains(copy), "the positioning copy \(copy) is not rendered")
        }
        XCTAssertTrue(view.text.contains("onOpenSend"),
                      "the large-file route must be a tab selection handed down")
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("onOpenSend: { self.selection = .send }"),
                      "and the shell must be the thing that performs it")
    }

    /// Progress is labelled and failure is never colour alone — the same two
    /// rules R3-D's account surface holds, on the two new session screens.
    func testTheDirectSessionScreensAreReadableWithoutColourOrSight() throws {
        let all = try sources()
        for name in ["DirectView.swift", "DirectFileSessionView.swift",
                     "DirectTextSessionView.swift"] {
            let view = try XCTUnwrap(all.first { $0.name == name })
            XCTAssertFalse(view.text.contains("ProgressView()\n"),
                           "\(name) has an unlabelled spinner, which reads as nothing")
            XCTAssertFalse(view.text.contains("foregroundStyle(.red)"),
                           "\(name) states a failure in colour")
        }
        let session = try XCTUnwrap(all.first { $0.name == "DirectFileSessionView.swift" })
        XCTAssertTrue(session.text.contains("L10n.percent(done: done, total: total)"),
                      "a progress bar with no figure beside it says nothing to VoiceOver")
    }

    /// No AppKit, anywhere. It compiles on macOS and not on iOS, so a copied
    /// `NSPasteboard` line from the Mac panes is a build failure rather than a
    /// silent one — but the guard is here because the Mac views this slice is
    /// modelled on are full of them, and the copy is the obvious way to write it.
    func testNoIOSSurfaceReachesForAppKit() throws {
        for (name, text) in try sources() {
            for appKitism in ["import AppKit", "NSPasteboard", "NSOpenPanel", "NSAlert",
                              "NSApplication", "NSWindow"] {
                XCTAssertFalse(text.contains(appKitism), "\(name) reaches for \(appKitism)")
            }
        }
    }
}
