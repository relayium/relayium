import XCTest
@testable import RelayiumKit

final class RelayRttMessageTests: XCTestCase {
    /// The exact shape App.svelte sends: {"relayRtt": {"<id>": <ms>}}.
    func testEncodesTheShapeTheWebSends() {
        let v = RelayRttMessage.encode(["n1": 42, "n3": 190])
        guard case let .object(root) = v, case let .object(map)? = root["relayRtt"] else {
            return XCTFail("got \(v)")
        }
        XCTAssertEqual(map.count, 2)
        XCTAssertEqual(map["n1"], .number(42))
        XCTAssertEqual(map["n3"], .number(190))
    }

    func testRoundTrips() {
        let original = ["n1": 42, "n3": 190]
        XCTAssertEqual(RelayRttMessage.decode(RelayRttMessage.encode(original)), original)
    }

    /// The signal channel carries other traffic — SDP, ICE candidates, renames.
    /// Anything that is not a relayRtt map must decode to nil rather than an
    /// empty map, or an unrelated message would look like "the peer measured
    /// nothing" and wipe a good map.
    func testUnrelatedSignalsDecodeToNil() {
        XCTAssertNil(RelayRttMessage.decode(.object(["rename": .string("Mac")])))
        XCTAssertNil(RelayRttMessage.decode(.string("hello")))
        XCTAssertNil(RelayRttMessage.decode(.null))
    }

    /// A peer on a future build may send ids we cannot interpret; take the
    /// numbers and ignore the rest rather than rejecting the whole map.
    func testSkipsNonNumericEntries() {
        let v = JSONValue.object(["relayRtt": .object(["n1": .number(10), "bad": .string("x")])])
        XCTAssertEqual(RelayRttMessage.decode(v), ["n1": 10])
    }
}
