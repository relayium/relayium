import XCTest
import RelayiumKit
@testable import RelayiumAppKit

/// The form is ONE view across "typing", "signing in" and "that was wrong",
/// because its email and password are `@State` and each branch of a SwiftUI
/// `switch` is a distinct structural identity — a second branch blanks both
/// fields on every wrong password. Making that one `if let` in the view means
/// the decision lives here, where these assertions can reach it.
final class SignInPresentationTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(type, from: try Data(contentsOf: url))
    }

    private func readyState() throws -> SessionState {
        let me = try fixture("me", as: MeResponse.self)
        let usage = try fixture("me-usage", as: UsageResponse.self)
        return .ready(user: me.user, usage: usage)
    }

    func testTheFormOwnsExactlyThreeStates() throws {
        XCTAssertNotNil(SignInPresentation.form(for: .loggedOut))
        XCTAssertNotNil(SignInPresentation.form(for: .authenticating))
        XCTAssertNotNil(SignInPresentation.form(for: .failed(message: "nope")))

        XCTAssertNil(SignInPresentation.form(for: .restoring))
        XCTAssertNil(SignInPresentation.form(for: .emailUnverified(email: "a@b.co")))
        XCTAssertNil(SignInPresentation.form(for: .pendingDeletion(purgeAfter: 1,
                                                                  reactivateToken: "t")))
        XCTAssertNil(SignInPresentation.form(for: .unavailable(message: "down")))
        XCTAssertNil(SignInPresentation.form(for: try readyState()))
    }

    func testOnlyAnInFlightAttemptIsBusy() {
        XCTAssertEqual(SignInPresentation.form(for: .authenticating)?.isBusy, true)
        XCTAssertEqual(SignInPresentation.form(for: .loggedOut)?.isBusy, false)
        XCTAssertEqual(SignInPresentation.form(for: .failed(message: "nope"))?.isBusy, false)
    }

    // The message is the rejection the session carries, verbatim — the form does
    // not invent, translate or summarise it.
    func testOnlyARejectedAttemptCarriesAMessage() {
        XCTAssertEqual(SignInPresentation.form(for: .failed(message: "wrong password"))?.errorMessage,
                       "wrong password")
        XCTAssertNil(SignInPresentation.form(for: .loggedOut)?.errorMessage)
        XCTAssertNil(SignInPresentation.form(for: .authenticating)?.errorMessage)
    }

    // A busy form must never also be showing the previous attempt's rejection:
    // the fields are disabled and a request is in flight, so the error is about
    // something that is no longer happening.
    func testABusyFormShowsNoStaleRejection() {
        let busy = SignInPresentation.form(for: .authenticating)
        XCTAssertEqual(busy?.isBusy, true)
        XCTAssertNil(busy?.errorMessage)
    }
}
