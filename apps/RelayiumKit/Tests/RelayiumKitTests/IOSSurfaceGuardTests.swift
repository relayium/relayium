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
///  3. **Copy that names the wrong platform.** Nineteen catalog strings name a
///     platform — eighteen say Mac, and `error.keychain.signIn` says macOS.
///     Each is correct on macOS and false here, and each is blocked behind a
///     feature this app does not have — so rendering one has to be a decision
///     rather than an oversight.
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
        try sources(under: iosRoot, atLeast: 5)
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
        let scanned = try sources(under: iosRoot, atLeast: 5)
            + sources(under: appKitRoot, atLeast: 20)
        for (name, text) in scanned {
            for call in ["print(", "NSLog(", "os_log(", "debugPrint(", "dump("] {
                XCTAssertFalse(text.contains(call),
                               "\(name) contains \(call) — a credential must never reach a log")
            }
        }
    }

    func testNoDeferredFeatureIsReferenced() throws {
        // Each belongs to a later R3 slice. A reference means either a dead
        // control or a capability claimed before it works.
        let deferred = [
            "SignInWithAppleButton", "AuthenticationServices", "BrowserLoginModel",
            "AccountManagementModel", "CloudUploadModel", "RealtimeSessionModel",
            "RealtimeTextSessionModel", "LanDiscoveryModel", "NearbyReceiveModel",
            "UIPasteboard", "onOpenURL", "UNUserNotificationCenter", "StoreKit",
            "NSWorkspace",
        ]
        for (name, text) in try sources() {
            for symbol in deferred {
                XCTAssertFalse(text.contains(symbol), "\(name) references \(symbol)")
            }
        }
    }

    /// The nineteen keys whose wording names a platform: eighteen that say Mac,
    /// and `error.keychain.signIn`, which says macOS. The last one is on this
    /// list precisely because the design identifies it as iOS-wrong — a guarded
    /// list that left it out would be the one place that identification stopped
    /// counting.
    ///
    /// Guarded by NAME, so it cannot see the ones `ErrorCopy` reaches
    /// indirectly — which is why `error.manifest.duplicatePath`, the one an iOS
    /// receive can already hit, was corrected in the catalogs instead of listed
    /// here.
    func testNoPlatformNamingCopyKeyIsRenderedOnIOS() throws {
        let platformNaming: [L10nKey] = [
            .accountThisMac, .accountRevokeThisMac, .accountKeyNotOnThisMac,
            .accountKeyLookupFailed, .accountKeyCleanupWarning, .accountBearerInvalid,
            .uploadKeyKept, .errorStoredKeyBadIdSave, .errorStoredKeyBadKeySave,
            .errorStoredLinkKeyInvalidKey, .errorPlaintextTooManyOpenFiles,
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText, .verifyExplainEncryption,
            .errorNearbyNoAnswer,
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 19)
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

    /// Empty is the claim: this app needs no capability, and an entitlement is
    /// a claim to the OS that lands with the feature requiring it. The nil
    /// keychain access group is the same decision, from the other side.
    func testTheEntitlementsFileIsStillEmpty() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertTrue(plist.isEmpty, "iOS R3-B claims no capability: \(plist.keys.sorted())")
    }
}
