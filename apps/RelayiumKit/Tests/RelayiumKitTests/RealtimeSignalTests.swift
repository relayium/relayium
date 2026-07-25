import XCTest
@testable import RelayiumKit

final class RealtimeSignalTests: XCTestCase {
    func testSDPWithCommitRoundTrips() {
        let j = sdpSignal(kind: "offer", sdp: "v=0...", commit: "Q29t")
        XCTAssertEqual(parseSDP(j)?.type, "offer")
        XCTAssertEqual(parseSDP(j)?.sdp, "v=0...")
        XCTAssertEqual(peerCommit(from: j), "Q29t")   // commit rides the SDP signal
    }
    func testICERoundTrips() {
        let j = iceSignal("candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0)
        let c = parseICE(j)
        XCTAssertEqual(c?.candidate, "candidate:1 1 udp ...")
        XCTAssertEqual(c?.sdpMid, "0"); XCTAssertEqual(c?.sdpMLineIndex, 0)
    }
    func testBusy() { XCTAssertTrue(parseBusy(busySignal())); XCTAssertFalse(parseBusy(sdpSignal(kind:"offer",sdp:"x",commit:nil))) }
}
