import XCTest
import RelayiumKit
@testable import RelayiumAppKit

/// The four pure decisions the send screen rests on, mapped case by case.
///
/// They live in the package for the reason `SignInPresentation` does: a product
/// rule inside a SwiftUI `switch` is a rule no test can read, and "who is
/// allowed to send" is not a rule to leave unreadable.
final class SendPresentationTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(type, from: try Data(contentsOf: url))
    }

    private func readyState() throws -> SessionState {
        let me = try fixture("me", as: MeResponse.self)
        let usage = try fixture("me-usage", as: UsageResponse.self)
        return .ready(user: me.user, usage: usage)
    }

    func testOnlyAReadyAccountCanSend() throws {
        XCTAssertEqual(SendAvailability.state(for: try readyState()), .ready)
        XCTAssertEqual(SendAvailability.state(for: .restoring), .checking)
        XCTAssertEqual(SendAvailability.state(for: .authenticating), .checking)
        XCTAssertEqual(SendAvailability.state(for: .loggedOut), .needsAccount)
        XCTAssertEqual(SendAvailability.state(for: .failed(message: "no")), .needsAccount)
        XCTAssertEqual(SendAvailability.state(for: .emailUnverified(email: "a@b.co")),
                       .needsAccount)
        XCTAssertEqual(SendAvailability.state(for: .pendingDeletion(purgeAfter: 1,
                                                                   reactivateToken: "t")),
                       .needsAccount)
        // Distinct on purpose: this user IS signed in, and "you need an account"
        // would be a false sentence with a useless remedy.
        XCTAssertEqual(SendAvailability.state(for: .unavailable(message: "down")),
                       .accountUnavailable)
    }

    /// The id, not the email: an email can change and would then read as an
    /// account switch that never happened.
    func testOnlyAReadyAccountHasAContext() throws {
        let context = SendAccountContext.context(for: try readyState())
        XCTAssertEqual(context.userId, try fixture("me", as: MeResponse.self).user.id)
        XCTAssertGreaterThan(context.retentionSecs, 0)
        for state in [SessionState.restoring, .loggedOut, .authenticating,
                      .failed(message: "x"), .unavailable(message: "x"),
                      .emailUnverified(email: "a@b.co"),
                      .pendingDeletion(purgeAfter: 1, reactivateToken: "t")] {
            XCTAssertEqual(SendAccountContext.context(for: state), .none, "\(state)")
        }
    }

    /// The retention the plan actually grants, carried verbatim — the send
    /// screen narrows the TTL list from it, so inventing a value here would
    /// offer a retention the server will truncate.
    func testTheContextCarriesThePlansRetention() throws {
        let usage = try fixture("me-usage", as: UsageResponse.self)
        XCTAssertEqual(SendAccountContext.context(for: try readyState()).retentionSecs,
                       usage.plan.retentionSecs)
    }

    /// An empty picker change is OUR OWN programmatic reset, or nothing chosen.
    /// Treating it as an import of zero items would clear a selection the user
    /// never asked to clear.
    func testAnEmptyPickerChangeIsIgnoredRatherThanImportedAsZero() {
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: 0), .ignore)
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: 1), .importItems(count: 1))
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: PHOTO_IMPORT_MAX),
                       .importItems(count: PHOTO_IMPORT_MAX))
    }

    /// A negative count cannot come from an array's `count`, but the seam is
    /// public and "not a positive number of items" is one rule, not two.
    func testANonPositiveCountIsNeverAnImport() {
        XCTAssertEqual(PhotoPickerChange.decide(itemCount: -1), .ignore)
    }

    /// The pair exists so a size gate cannot outlive the retention it arrived
    /// with — `.unknown` is what every transition out of a ready account applies.
    func testUnknownCapsAreBothUnknown() {
        XCTAssertEqual(UploadCaps.unknown, UploadCaps(retentionSecs: 0, maxFileSize: 0))
        XCTAssertEqual(SendAccountContext.none.userId, nil)
        XCTAssertEqual(SendAccountContext.none.retentionSecs, 0)
    }
}
