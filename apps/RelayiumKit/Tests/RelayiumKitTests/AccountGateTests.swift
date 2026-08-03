import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The mapping from "what the account is doing" to "what this feature may say
/// about it", proved total over `SessionState`.
///
/// Two rows are the reason this type exists at all, and both are lies the old
/// shell told:
///
///  * `.ready` with an unreadable bearer must never render "sign in". The user
///    *is* signed in; the credential is what broke, and `account.bearerInvalid`
///    already says the true thing.
///  * `.restoring` must never render "sign in" either. A gate that asks for a
///    password during a 600 ms keychain read is a lie the user acts on.
///
/// Every assertion that involves copy names its language, so none of them can
/// pass or fail because of the machine the tests run on.
final class AccountGateTests: XCTestCase {

    /// `.ready` built from the same server-frozen fixtures `AccountSessionTests`
    /// and `AccountManagementModelTests` use, rather than a second hand-made
    /// shape that might not be reachable — with `retentionSecs` as the knob,
    /// because that value is what `.allowed` has to carry.
    private func ready(retention: Int64 = 86_400) throws -> SessionState {
        let meURL = try XCTUnwrap(Bundle.module.url(forResource: "me", withExtension: "json"))
        let user = try JSONDecoder().decode(MeResponse.self, from: Data(contentsOf: meURL)).user
        let usageURL = try XCTUnwrap(Bundle.module.url(forResource: "me-usage",
                                                       withExtension: "json"))
        var usage = try JSONDecoder().decode(UsageResponse.self,
                                             from: Data(contentsOf: usageURL))
        usage.plan.retentionSecs = retention
        return .ready(user: user, usage: usage)
    }

    func testLoadingStatesNeverAskForSignIn() {
        XCTAssertEqual(AccountGate.from(.restoring, bearer: nil), .loading)
        XCTAssertEqual(AccountGate.from(.authenticating, bearer: nil), .loading)
    }

    func testLoggedOutAndFailedAskForSignIn() {
        XCTAssertEqual(AccountGate.from(.loggedOut, bearer: nil), .signInRequired)
        XCTAssertEqual(AccountGate.from(.failed(message: "bad password"), bearer: nil),
                       .signInRequired)
    }

    /// A registration in flight is NOT `.loading`.
    ///
    /// `.loading` means "the app is working out who you are, hold on", and a
    /// capability that says that here would be waiting for an account that
    /// cannot arrive: registering ends on the check-email screen at best, never
    /// on a session this feature could use.
    func testARegistrationInFlightStillNeedsAnAccount() {
        XCTAssertEqual(AccountGate.from(.registering, bearer: nil), .signInRequired)
        XCTAssertNotEqual(AccountGate.from(.registering, bearer: nil), .loading)
    }

    func testUnavailableEmailAndDeletionPassThrough() {
        XCTAssertEqual(AccountGate.from(.unavailable(message: "offline"), bearer: "t"),
                       .unavailable(message: "offline"))
        XCTAssertEqual(AccountGate.from(.emailUnverified(email: "a@b.c"), bearer: nil),
                       .verifyEmail(email: "a@b.c"))
        XCTAssertEqual(AccountGate.from(.pendingDeletion(purgeAfter: 9, reactivateToken: "r"),
                                        bearer: nil),
                       .pendingDeletion(purgeAfter: 9, reactivateToken: "r"))
    }

    func testReadyWithATokenIsAllowedAndCarriesRetention() throws {
        XCTAssertEqual(AccountGate.from(try ready(retention: 1_209_600), bearer: "tok"),
                       .allowed(AccountAccess(token: "tok", retentionSecs: 1_209_600)))
    }

    /// The row worth naming: signed in, momentarily unreadable bearer.
    func testReadyWithoutATokenIsNeverSignInRequired() throws {
        for bearer in [nil, ""] as [String?] {
            let gate = AccountGate.from(try ready(), bearer: bearer, language: .en)
            XCTAssertEqual(gate, .unavailable(message: L10n.t(.accountBearerInvalid,
                                                             language: .en)))
            XCTAssertNotEqual(gate, .signInRequired)
        }
    }
}
