import XCTest
@testable import RelayiumKit

final class RelayChoiceTests: XCTestCase {
    /// tok: max(30,200)=200; la: max(180,40)=180 → la wins on the better
    /// worst-case leg, even though tok is far faster for one side.
    func testMinimisesTheWorseOfTheTwoRTTs() {
        XCTAssertEqual(RelayChoice.pick(mine: ["tok": 30, "la": 180],
                                        theirs: ["tok": 200, "la": 40]), "la")
    }

    func testOnlyConsidersRelaysBothPeersMeasured() {
        // sg is fastest for me but the peer never measured it → ineligible.
        XCTAssertEqual(RelayChoice.pick(mine: ["sg": 10, "tok": 90],
                                        theirs: ["tok": 95]), "tok")
        XCTAssertNil(RelayChoice.pick(mine: ["sg": 10], theirs: ["tok": 95]))
        XCTAssertNil(RelayChoice.pick(mine: [:], theirs: [:]))
    }

    func testBreaksTiesBySumThenById() {
        // Both have max 100; tok sum=150 < la sum=200 → tok.
        XCTAssertEqual(RelayChoice.pick(mine: ["tok": 100, "la": 100],
                                        theirs: ["tok": 50, "la": 100]), "tok")
        // Identical worst-case AND sum → lowest id, the same on both sides.
        XCTAssertEqual(RelayChoice.pick(mine: ["b": 100, "a": 100],
                                        theirs: ["b": 100, "a": 100]), "a")
    }

    /// The property the whole design rests on: both peers feed the same two
    /// maps in opposite order and must reach the same relay, with no round of
    /// negotiation. Swift dictionaries iterate in an unspecified order, so this
    /// also pins that the result does not depend on iteration order.
    func testIsSymmetricOverManyInputs() {
        var rng = SystemRandomNumberGenerator()
        let ids = ["a", "b", "c", "d", "e", "f"]
        for _ in 0..<500 {
            var mine: [String: Int] = [:], theirs: [String: Int] = [:]
            for id in ids {
                if Bool.random(using: &rng) { mine[id] = Int.random(in: 1...300, using: &rng) }
                if Bool.random(using: &rng) { theirs[id] = Int.random(in: 1...300, using: &rng) }
            }
            XCTAssertEqual(RelayChoice.pick(mine: mine, theirs: theirs),
                           RelayChoice.pick(mine: theirs, theirs: mine),
                           "asymmetric for mine=\(mine) theirs=\(theirs)")
        }
    }
}
