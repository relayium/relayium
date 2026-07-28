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

    /// `JSONValue.number` is an unconstrained `Double` arriving from the
    /// signalling server, which is untrusted by design. `Int(_: Double)` traps
    /// outside `Int`'s range, so before this guard a peer sending
    /// `{"relayRtt":{"huge":1e30}}` aborted the process — a one-line remote
    /// crash. Out-of-range entries are dropped exactly like non-numeric ones,
    /// so the rest of an otherwise usable map still survives.
    func testDropsOutOfRangeNumbersInsteadOfTrapping() {
        let v = JSONValue.object(["relayRtt": .object([
            "n1": .number(10),
            "huge": .number(1e30),
            "negativeHuge": .number(-1e30),
            "nan": .number(Double.nan),
            "inf": .number(Double.infinity),
            "negative": .number(-1),
            "justOver": .number(Double(RelayRttMessage.maxRttMs) + 1),
        ])])
        XCTAssertEqual(RelayRttMessage.decode(v), ["n1": 10])
    }

    /// The bound itself is inclusive — a genuinely awful but honest RTT is
    /// still a measurement, and dropping it would silently make that relay
    /// ineligible rather than merely last.
    func testKeepsValuesUpToTheBound() {
        let v = JSONValue.object(["relayRtt": .object([
            "slow": .number(Double(RelayRttMessage.maxRttMs)),
            "zero": .number(0),
        ])])
        XCTAssertEqual(RelayRttMessage.decode(v), ["slow": RelayRttMessage.maxRttMs, "zero": 0])
    }

    /// The bound is what makes `RelayChoice.pick`'s `m + t` provably safe: two
    /// decoded values can never sum past `Int.max`.
    func testTheBoundKeepsPickFromOverflowing() {
        let worst = RelayRttMessage.maxRttMs
        XCTAssertEqual(RelayChoice.pick(mine: ["a": worst], theirs: ["a": worst]), "a")
    }
}
