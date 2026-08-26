import XCTest
@testable import RelayiumAppKit

/// **Which macOS build may contain native Sign in with Apple, and which must
/// contain browser sign-in.**
///
/// Both claims are about what a binary CONTAINS, and an absence has no runtime
/// to observe — so these read the sources and the project file that decide it,
/// the way `StoreKitLinkageTests` does for Sparkle and StoreKit.
///
/// The four claims:
///
///  1. **Browser sign-in is in every distribution.** It is not removed, not
///     renamed to Apple, and not replaced by the native control. A Mac App Store
///     user gets both.
///  2. **The Mac App Store build has the real system control**, wired to the
///     existing hardened nonce/state/token exchange and to
///     `AccountSession.logInWithApple` — not to a second, weaker one.
///  3. **The Developer ID build has neither the entitlement nor a call path.**
///     Not "the control is hidden": the target does not compile the file that
///     contains it, so there is no reachable `ASAuthorizationController` at all.
///  4. **The distinction is a compile/sign configuration**, decided by target
///     file membership and per-target entitlements files — never by a receipt
///     check, a bundle-path sniff or any other runtime heuristic.
final class MacAppleSignInGuardTests: XCTestCase {

    private var macRoot: URL {
        get throws { try RepoRoot.directory("apps/mac") }
    }

    /// A source under `apps/`, which must exist.
    private func read(_ relativePath: String) throws -> String {
        try RepoRoot.text("apps/" + relativePath)
    }

    /// Source with whole-line comments removed.
    ///
    /// The same loader the other guards use, and for the same reason: these
    /// files explain at length what they deliberately do NOT do, so a raw scan
    /// would fail on the very prose documenting the absence being checked.
    /// Trailing comments are NOT stripped, so a banned symbol after code on one
    /// line still fails.
    private func code(_ relativePath: String) throws -> String {
        try read(relativePath).components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private var projectText: String { (try? read("mac/Relayium.xcodeproj/project.pbxproj")) ?? "" }

    // MARK: - 1. browser sign-in survives everywhere

    /// **The browser device flow is unconditional.**
    ///
    /// `LoginView` is shared source compiled into BOTH targets, so a browser
    /// button that is present and ungated there is present in every macOS
    /// distribution. Asserted together with the absence of any distribution
    /// conditional around it: a `#if`, or a channel test, would make "every
    /// distribution" untrue without removing the line.
    func testBrowserSignInIsPresentInEveryDistribution() throws {
        let login = try code("mac/Relayium/LoginView.swift")
        XCTAssertTrue(login.contains("Button(L10n.t(.loginBrowserSignIn)) { startBrowserLogin() }"),
                      "the browser sign-in control is gone from the shared form")
        XCTAssertFalse(login.contains("#if"),
                       "the shared sign-in form gained a compile-time distribution branch")
        XCTAssertFalse(login.contains("AppDistribution.channel"),
                       "the sign-in form gates a control on the distribution channel")
        // It is still named for the browser rather than for Apple. Naming it
        // "Sign in with Apple" would claim a mechanism the direct build does not
        // implement, and would read as a replacement in the build that does.
        XCTAssertTrue(login.contains("loginBrowserSignIn"))
        // The native section is rendered as a SEAM, and the shared file carries
        // no Apple-authorization code of its own.
        XCTAssertTrue(login.contains("AppleSignInSection(mode: mode, isBusy: form.isBusy)"))
        for banned in ["import AuthenticationServices", "ASAuthorization",
                       "SignInWithAppleButton", "logInWithApple"] {
            XCTAssertFalse(login.contains(banned),
                           "shared LoginView.swift contains \(banned)")
        }
    }

    // MARK: - 2. the Mac App Store build's control

    /// The App Store seam declares the real system control and routes it through
    /// the EXISTING hardened exchange rather than a second one.
    func testTheAppStoreBuildUsesTheSystemControlAndTheHardenedExchange() throws {
        let mas = try code("mac/Relayium/Distribution/AppStoreDistribution.swift")
        XCTAssertTrue(mas.contains("import AuthenticationServices"))
        XCTAssertTrue(mas.contains("SignInWithAppleButton("),
                      "the App Store build does not use Apple's own system control")
        // The nonce is RAW, per-attempt, and from the shared audited generator.
        XCTAssertTrue(mas.contains("AppleSignInAttempt.fresh()"))
        XCTAssertTrue(mas.contains("request.nonce = fresh.nonce"))
        XCTAssertFalse(mas.contains("sha256"), "the nonce is hashed, which the server never matches")
        // OAuth state correlates the callback to the attempt still held.
        XCTAssertTrue(mas.contains("request.state = fresh.state"))
        XCTAssertTrue(mas.contains("attempt.matches(returnedState: credential.state)"),
                      "a completion is consumed without correlating it to its attempt")
        // Both credential fields are read through the shared reader, and the
        // exchange is the session's existing one.
        XCTAssertTrue(mas.contains("AppleSignInCredential.read("))
        XCTAssertTrue(mas.contains("session.logInWithApple(idToken: fields.idToken,"),
                      "the App Store build does not use AccountSession.logInWithApple")
        XCTAssertTrue(mas.contains("requestedScopes = [.fullName, .email]"))
        // Truthful failure handling: a cancellation says nothing, everything
        // else is reported, and neither invents an account.
        XCTAssertTrue(mas.contains("if (error as? ASAuthorizationError)?.code == .canceled { return }"),
                      "a cancelled Apple authorization raises an error sentence")
        XCTAssertTrue(mas.contains("session.reportAppleSignInFailure(AppleSignInError.authorizationFailed)"))
        XCTAssertTrue(mas.contains("session.reportAppleSignInFailure(AppleSignInError.unexpectedCredential)"))
    }

    /// The entitlement is on the Mac App Store build, spelled correctly, with
    /// the ordinary `Default` value.
    func testTheAppStoreEntitlementsCarryAppleSignInCorrectly() throws {
        let mas = try read("mac/RelayiumAppStore/Relayium.entitlements")
        XCTAssertTrue(mas.contains("<key>com.apple.developer.applesignin</key>"),
                      "the Mac App Store build cannot present Sign in with Apple")
        // The value is an ARRAY containing exactly `Default`. A wrong shape here
        // is a signing failure, and `Shared` would claim a cross-app Apple ID
        // relationship this product does not have.
        let key = try XCTUnwrap(mas.range(of: "<key>com.apple.developer.applesignin</key>"))
        let value = String(mas[key.upperBound...].prefix(120))
        XCTAssertTrue(value.contains("<array>"), "the entitlement value is not an array")
        XCTAssertTrue(value.contains("<string>Default</string>"))
        XCTAssertFalse(value.contains("<string>Shared</string>"))
        // The rest of the MAS entitlements are unchanged in the ways other
        // guards depend on: still sandboxed, still no Sparkle exception.
        //
        // The Sparkle check is on the KEY, not on the text: this file's own
        // header explains at length why the Mach-lookup exception is absent, so
        // a substring scan would fail on the prose documenting the absence it is
        // checking — the same trap the comment-stripping loader exists for, in a
        // file that is XML rather than Swift.
        XCTAssertTrue(mas.contains("<key>com.apple.security.app-sandbox</key>"))
        XCTAssertFalse(
            mas.contains("<key>com.apple.security.temporary-exception.mach-lookup.global-name</key>"),
            "the Mac App Store build claims Sparkle's sandbox exception")
    }

    // MARK: - 3. the Developer ID build has neither

    /// **No entitlement in the direct build**, and none in the Share extensions
    /// or the engineering candidate either — an entitlement claimed by a profile
    /// that does not grant it fails to sign.
    func testTheDirectBuildCarriesNoAppleSignInEntitlement() throws {
        for path in ["mac/Relayium/Relayium.entitlements",
                     "mac/RelayiumShare/RelayiumShare.entitlements",
                     "mac/Engineering/Relayium.entitlements",
                     "mac/Engineering/RelayiumShare.entitlements"] {
            XCTAssertFalse(try read(path).contains("applesignin"),
                           "\(path) claims the Apple sign-in entitlement")
        }
    }

    /// **No call path.** Every macOS source the direct target compiles is free
    /// of Apple-ID authorization symbols — which, given the membership exception
    /// below, is every macOS source except `AppStoreDistribution.swift`.
    ///
    /// **The banned list is symbols, NOT `import AuthenticationServices`**, and
    /// the distinction is load-bearing rather than pedantic. That one framework
    /// holds two unrelated things: `ASWebAuthenticationSession`, which is the
    /// BROWSER sign-in sheet every distribution needs and which
    /// `BrowserSignIn.swift` legitimately imports, and the `ASAuthorizationAppleID`
    /// family, which is the Apple-ID flow only the entitled build may reach.
    /// Banning the import would have forced the browser flow out of the direct
    /// build to satisfy a guard — removing the very capability claim 1 exists to
    /// protect — so what is banned is the Apple-ID surface itself.
    func testTheDirectBuildHasNoAppleAuthorizationCallPath() throws {
        let names = try FileManager.default.subpathsOfDirectory(atPath: try macRoot.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        XCTAssertGreaterThan(names.count, 30, "the scan found almost nothing")
        var offenders: [String] = []
        for name in names where name != "Relayium/Distribution/AppStoreDistribution.swift" {
            let source = try code("mac/\(name)")
            for banned in ["ASAuthorizationAppleID", "ASAuthorizationController",
                           "SignInWithAppleButton", "ASAuthorizationError",
                           "logInWithApple"] where source.contains(banned) {
                offenders.append("\(name): \(banned)")
            }
        }
        XCTAssertEqual(offenders, [],
                       "the direct target compiles Apple-ID authorization code: \(offenders)")
        // The other half of the same claim: the browser sheet IS still compiled
        // by this target, and still uses the web-authentication half of that
        // framework. A guard that only forbade things could be satisfied by
        // deleting browser sign-in, which is the outcome it must prevent.
        let browser = try code("mac/Relayium/BrowserSignIn.swift")
        XCTAssertTrue(browser.contains("ASWebAuthenticationSession"),
                      "the browser sign-in sheet is gone from the direct build")
        XCTAssertFalse(browser.contains("ASAuthorizationAppleID"),
                       "the browser sheet reaches the Apple-ID flow")
        // And the direct build's own seam really is empty rather than a hidden
        // control: it renders nothing and imports nothing.
        let direct = try code("mac/Relayium/Distribution/DirectDistribution.swift")
        XCTAssertTrue(direct.contains("struct AppleSignInSection: View"))
        XCTAssertTrue(direct.contains("var body: some View { EmptyView() }"))
        XCTAssertFalse(direct.contains("AuthenticationServices"))
    }

    // MARK: - 4. the distinction is a build configuration

    /// **Decided by target membership, not at runtime.**
    ///
    /// The seam name is declared exactly once per target, each in the file the
    /// OTHER target excludes. That is what makes the absence structural: the
    /// direct target cannot reach the control however the shared sources change.
    func testTheTrackDistinctionIsFileMembershipRatherThanARuntimeCheck() throws {
        let project = projectText
        XCTAssertFalse(project.isEmpty, "the macOS project file could not be read")
        // The exclusions that carry the seam, per target.
        for (target, excluded) in [("Relayium", "Distribution/AppStoreDistribution.swift"),
                                   ("RelayiumAppStore", "Distribution/DirectDistribution.swift")] {
            XCTAssertTrue(project.contains("in \"\(target)\" target */ = {"))
            XCTAssertTrue(project.contains(excluded),
                          "\(target) does not exclude \(excluded)")
        }
        // Exactly one declaration of the seam type per target.
        let names = try FileManager.default.subpathsOfDirectory(atPath: try macRoot.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        let declaring = try names.filter {
            try code("mac/\($0)").contains("struct AppleSignInSection: View")
        }.sorted()
        XCTAssertEqual(declaring, ["Relayium/Distribution/AppStoreDistribution.swift",
                                   "Relayium/Distribution/DirectDistribution.swift"],
                       "AppleSignInSection is not declared exactly once per target: \(declaring)")
        // Per-target entitlements files, which is the other half of the
        // configuration-level separation.
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS = RelayiumAppStore/Relayium.entitlements;"))
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS = Relayium/Relayium.entitlements;"))
    }

    /// **No runtime heuristic decides it.** A receipt probe or a bundle-path
    /// sniff would be fragile — an App Store receipt is absent in a TestFlight
    /// or first-launch state, and a sandbox path can be reproduced — and either
    /// would move a signing fact into a branch that can be wrong.
    func testNoReceiptOrPathHeuristicSelectsTheAppleSignInSurface() throws {
        for path in ["mac/Relayium/Distribution/AppStoreDistribution.swift",
                     "mac/Relayium/Distribution/DirectDistribution.swift",
                     "mac/Relayium/LoginView.swift"] {
            let source = try code(path)
            for banned in ["appStoreReceiptURL", "receipt", "MAS_RECEIPT",
                           "bundlePath.contains", "sandboxed"] {
                XCTAssertFalse(source.lowercased().contains(banned.lowercased()),
                               "\(path) selects a surface on the runtime heuristic \(banned)")
            }
        }
    }

    // MARK: - the continuation capability is actually wired in

    /// **The purchase-continuation client is CONSTRUCTED, not merely written.**
    ///
    /// This guard exists because the gap it closes really happened during this
    /// change: the whole state machine, its store and its tests were complete
    /// and green while `makeSubscriptionModel` still built a model with neither
    /// half — so the shipping app was a legacy one-shot client and the recovery
    /// path was unreachable by any user. Every unit test passed throughout,
    /// because a legacy model is a supported configuration.
    ///
    /// So the assertion is on the CALL SITE that decides which configuration the
    /// product ships, which is the one thing no behavioural test covers.
    func testTheAppStoreBuildActuallyWiresTheContinuationCapability() throws {
        let mas = try code("mac/Relayium/Distribution/AppStoreDistribution.swift")
        XCTAssertTrue(mas.contains("AppEnvironment.makeApplePurchaseContinuation()"),
                      "the App Store build never builds a continuation capability")
        XCTAssertTrue(mas.contains("continuation: continuation?.repository"),
                      "the purchase model is built without its capability store")
        XCTAssertTrue(mas.contains("appInstanceID: continuation?.appInstanceID"),
                      "the purchase model is built without its app-instance identity")
        XCTAssertTrue(mas.contains("purchaseDispatchPolicy: .durableContinuationRequired"),
                      "the App Store build can silently fall back to legacy purchase dispatch")
        // The direct build has no purchase model at all, so it must not acquire
        // a capability either — there is nothing for it to arm.
        let direct = try code("mac/Relayium/Distribution/DirectDistribution.swift")
        XCTAssertFalse(direct.contains("makeApplePurchaseContinuation"),
                       "the direct build acquires a purchase capability it can never use")
    }

    // MARK: - version

    /// This release is 1.3.7, and the App Store review fixes it carries forward
    /// are still in place.
    func testTheReleaseIsVersionOnePointThreePointSeven() throws {
        let project = projectText
        XCTAssertTrue(project.contains("MARKETING_VERSION = 1.3.7;"))
        XCTAssertFalse(project.contains("MARKETING_VERSION = 1.3.6;"),
                       "a target was left on the previous version")
        // **The App Store review fixes must not come back.** The app is named
        // `Relayium`, never "… for Mac", and the login item is never registered
        // without consent — `LoginItemPreference` owns that gate.
        XCTAssertFalse(project.contains("for Mac"), "the app name reintroduces \"for Mac\"")
        for path in ["mac/RelayiumAppStore/Info.plist", "mac/Relayium/Info.plist"] {
            XCTAssertFalse(try read(path).contains("for Mac"),
                           "\(path) reintroduces an app name containing \"for Mac\"")
        }
        XCTAssertTrue(project.contains("PRODUCT_NAME = Relayium;"))
    }
}
