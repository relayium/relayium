import XCTest
@testable import RelayiumKit

/// The SDP/ICE ordering rule, on both sides of the wire, with no WebRTC under
/// it.
///
/// Both orderings are unreproducible in a live test by construction — the race
/// is between a delegate callback and a completion block, and it resolves
/// differently on every run — which is exactly why the decision lives in a value
/// type that can simply be asked.
final class LinkCandidateGateTests: XCTestCase {

    private func gate(limit: Int = LINK_PENDING_CANDIDATE_MAX) -> LinkCandidateGate<String> {
        LinkCandidateGate<String>(limit: limit)
    }

    // MARK: - holding

    /// The whole point: a candidate offered before the description it belongs to
    /// has been dealt with does not go anywhere yet.
    func testCandidatesBeforeTheDescriptionAreHeldRatherThanSent() {
        var gate = self.gate()
        XCTAssertFalse(gate.isOpen)
        XCTAssertEqual(gate.admit("host-1"), .hold)
        XCTAssertEqual(gate.admit("host-2"), .hold)
        XCTAssertEqual(gate.pendingCount, 2)
    }

    /// Released in gathering order. The ICE agent ranks candidates in the order
    /// it produced them, and reordering them across the gate would present a
    /// peer with a priority order neither side computed.
    func testTheBacklogIsReleasedFIFO() {
        var gate = self.gate()
        for candidate in ["host-1", "host-2", "srflx-1", "relay-1"] {
            XCTAssertEqual(gate.admit(candidate), .hold)
        }
        XCTAssertEqual(gate.open(), ["host-1", "host-2", "srflx-1", "relay-1"])
        XCTAssertTrue(gate.isOpen)
        XCTAssertEqual(gate.pendingCount, 0)
    }

    func testCandidatesAfterTheDescriptionPassStraightThrough() {
        var gate = self.gate()
        _ = gate.open()
        XCTAssertEqual(gate.admit("srflx-1"), .send)
        XCTAssertEqual(gate.admit("relay-1"), .send)
        XCTAssertEqual(gate.pendingCount, 0, "nothing is held once the gate is open")
    }

    /// An establishment applies exactly one initial description per direction,
    /// but a second flush must not be able to replay a backlog that has already
    /// gone to the peer.
    func testASecondOpenReleasesNothing() {
        var gate = self.gate()
        _ = gate.admit("host-1")
        XCTAssertEqual(gate.open(), ["host-1"])
        XCTAssertEqual(gate.open(), [])
    }

    // MARK: - the bound

    /// Fail closed, never truncate. Dropping the earliest candidates would drop
    /// the host candidates a LAN link depends on.
    func testOverflowIsReportedRatherThanDroppingCandidates() {
        var gate = self.gate(limit: 3)
        for candidate in ["a", "b", "c"] {
            XCTAssertEqual(gate.admit(candidate), .hold)
        }
        XCTAssertEqual(gate.admit("d"), .overflow)
        XCTAssertEqual(gate.admit("e"), .overflow, "and it stays refused")
        XCTAssertEqual(gate.open(), ["a", "b", "c"],
                       "the ones already held are intact, not shuffled or evicted")
    }

    /// An open gate holds nothing, so it can never overflow — a peer trickling
    /// candidates for the life of a connection is not a resource question.
    func testAnOpenGateNeverOverflows() {
        var gate = self.gate(limit: 2)
        _ = gate.open()
        for index in 0..<1_000 {
            XCTAssertEqual(gate.admit("candidate-\(index)"), .send)
        }
    }

    /// The production bound is a fixed number, documented, and comfortably above
    /// the worst realistic gathering round.
    func testTheProductionBoundIsFixedAndRealistic() {
        XCTAssertEqual(LINK_PENDING_CANDIDATE_MAX, 64)
        var gate = LinkCandidateGate<String>()
        for index in 0..<LINK_PENDING_CANDIDATE_MAX {
            XCTAssertEqual(gate.admit("candidate-\(index)"), .hold)
        }
        XCTAssertEqual(gate.admit("one-too-many"), .overflow)
    }

    // MARK: - teardown

    func testDiscardDropsTheBacklogWithoutOpeningTheGate() {
        var gate = self.gate()
        _ = gate.admit("host-1")
        gate.discard()
        XCTAssertEqual(gate.pendingCount, 0)
        XCTAssertFalse(gate.isOpen)
        XCTAssertEqual(gate.open(), [], "nothing survives teardown to be sent later")
    }
}
