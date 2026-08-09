import XCTest
@testable import RelayiumAppKit

/// Which of the three Device Inbox branches renders, decided once for both hosts.
///
/// The two facts this combines are normally the same answer one turn apart, and
/// the tests that matter are the ones where they are not — because each of those
/// disagreements, rendered the obvious way, produces a screen that either offers
/// controls the controller refuses or asserts and draws nothing.
final class DeviceInboxEntryTests: XCTestCase {

    // nonlocalized: a bearer no server would accept
    private let access = AccountAccess(token: "test-bearer", retentionSecs: 604_800)

    // MARK: - the ordinary answers

    func testAReceiverThatAdoptedAnAccountRendersTheWholeSurface() {
        XCTAssertEqual(DeviceInboxEntry.entry(gate: .allowed(access), isSignedIn: true),
                       .surface)
    }

    func testNoAccountRendersTheGateThatCarriesTheActions() {
        XCTAssertEqual(DeviceInboxEntry.entry(gate: .signInRequired, isSignedIn: false),
                       .account(.signInRequired))
    }

    /// Every reason an account is unavailable reaches the gate, not a single
    /// "sign in" sentence. `CapabilityGateView` answers each with the one action
    /// that resolves it, and the pane this replaced answered all five the same
    /// way — telling a user whose address was merely unverified to sign in, which
    /// they had already done.
    func testEveryUnavailableReasonKeepsItsOwnGate() {
        let gates: [AccountGate] = [
            .loading,
            .signInRequired,
            .unavailable(message: "offline"),          // nonlocalized: a test fixture
            .verifyEmail(email: "a@example.com"),      // nonlocalized: a test fixture
            .pendingDeletion(purgeAfter: 1, reactivateToken: "t"),  // nonlocalized: fixture
        ]
        for gate in gates {
            XCTAssertEqual(DeviceInboxEntry.entry(gate: gate, isSignedIn: false),
                           .account(gate),
                           "\(gate) was collapsed into another branch")
        }
    }

    // MARK: - the two disagreements

    /// **An account the receiver could not adopt.**
    ///
    /// `InboxController.session(_:)` fails closed on an account id this build
    /// will not use as a keychain item name: it stops the loop, drops the
    /// generation and sets `.failed(.identity)` while the session beside it stays
    /// perfectly `ready`. Rendering the full surface there would offer a folder
    /// chooser and a policy picker whose setters return immediately — the
    /// dead-control defect this app has already shipped once — and rendering the
    /// gate would hand `CapabilityGateView` an `.allowed` it asserts on and draws
    /// nothing for. It is therefore its own branch.
    func testAnAllowedAccountTheReceiverHasNotAdoptedIsStatusOnly() {
        XCTAssertEqual(DeviceInboxEntry.entry(gate: .allowed(access), isSignedIn: false),
                       .statusOnly)
    }

    /// The receiver's own answer wins wherever it is positive, including while
    /// the session is still catching up. It is the object that holds the
    /// generation the grant, the policy and every claim are scoped to, so a
    /// running receiver is a fact about the thing being rendered rather than an
    /// inference from the session beside it.
    func testARunningReceiverIsNeverHiddenBehindALaggingSession() {
        for gate in [AccountGate.loading, .signInRequired,
                     .verifyEmail(email: "a@example.com")] {  // nonlocalized: a fixture
            XCTAssertEqual(DeviceInboxEntry.entry(gate: gate, isSignedIn: true), .surface,
                           "a running receiver was replaced by a sign-in gate for \(gate)")
        }
    }

    // MARK: - totality

    /// No input produces no answer, and no gate silently inherits another's
    /// branch. The pairing is small enough to enumerate, so it is enumerated.
    func testTheMappingIsTotalAndAgreesWithItself() {
        let gates: [AccountGate] = [
            .allowed(access), .loading, .signInRequired,
            .unavailable(message: "x"),                // nonlocalized: a test fixture
            .verifyEmail(email: "a@example.com"),      // nonlocalized: a test fixture
            .pendingDeletion(purgeAfter: 0, reactivateToken: ""),
        ]
        for gate in gates {
            XCTAssertEqual(DeviceInboxEntry.entry(gate: gate, isSignedIn: true), .surface)
            // Twice, so the function is proven to depend on nothing but its
            // arguments — it is read from a SwiftUI `body`, where it runs on
            // every redraw.
            XCTAssertEqual(DeviceInboxEntry.entry(gate: gate, isSignedIn: false),
                           DeviceInboxEntry.entry(gate: gate, isSignedIn: false))
        }
        XCTAssertNotEqual(DeviceInboxEntry.statusOnly, .surface)
        XCTAssertNotEqual(DeviceInboxEntry.statusOnly, .account(.signInRequired))
    }
}
