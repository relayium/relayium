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

// ── capability piggyback ─────────────────────────────────────────────────────
extension RealtimeSignalTests {
    func testCapsFieldRoundTrips() {
        XCTAssertEqual(peerCaps(from: capsField(["text/1"])), ["text/1"])
        XCTAssertEqual(peerCaps(from: capsField(["future/9", "text/1"])), ["future/9", "text/1"])
    }

    // Absent is not an error: every already-deployed peer sends no caps at all.
    func testAbsentCapsIsEmptyNotAFailure() {
        XCTAssertEqual(peerCaps(from: sdpSignal(kind: "offer", sdp: "v=0", commit: "Yw==")), [])
        XCTAssertEqual(peerCaps(from: busySignal()), [])
        XCTAssertEqual(peerCaps(from: .object([:])), [])
        XCTAssertEqual(peerCaps(from: .null), [])
    }

    // Peer-authored input: a malformed caps field must not throw and must not
    // grant anything.
    func testMalformedCapsIsIgnored() {
        XCTAssertEqual(peerCaps(from: .object(["caps": .string("text/1")])), [])
        XCTAssertEqual(peerCaps(from: .object(["caps": .number(1)])), [])
        XCTAssertEqual(peerCaps(from: .object(["caps": .array([.number(1), .null])])), [])
        // Non-string entries are dropped, the string ones survive.
        XCTAssertEqual(peerCaps(from: .object(["caps": .array([.number(1), .string("text/1")])])), ["text/1"])
    }

    // caps rides ALONGSIDE the commit, the way sdpExtra merges it, so adding it
    // cannot disturb the commit-reveal fields.
    func testCapsDoesNotDisturbTheSdpOrCommit() {
        guard case var .object(o) = sdpSignal(kind: "offer", sdp: "v=0\r\n", commit: "Yw==") else {
            return XCTFail("sdpSignal did not produce an object")
        }
        if case let .object(c) = capsField(["text/1"]) { o.merge(c) { a, _ in a } }
        let merged = JSONValue.object(o)
        XCTAssertEqual(peerCommit(from: merged), "Yw==")
        XCTAssertEqual(parseSDP(merged)?.sdp, "v=0\r\n")
        XCTAssertEqual(peerCaps(from: merged), ["text/1"])
    }
}
