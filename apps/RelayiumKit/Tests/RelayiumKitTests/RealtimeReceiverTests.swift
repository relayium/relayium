import XCTest
@testable import RelayiumKit

final class RealtimeReceiverTests: XCTestCase {
    func testFeedRoundTripsWebFrameStream() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let r = RealtimeReceiver(sessionKey: v.hex("sessionKeyHex"))
        var stream = v.hex("frameStreamHex")
        // walk frames: [kind][4 seq][payload]; payload len differs per frame, so
        // decode by feeding whole frames — the vector is a concatenation, so split
        // on the known boundaries the generator recorded, OR feed frame-by-frame
        // using the per-frame lengths the test reconstructs from the fixture.
        let frames = v.realtimeFrameList()   // [[UInt8]] individual frames (added to fixture/helper)
        var events: [RealtimeEvent] = []
        for f in frames { events.append(try r.feed(f)) }
        // batch, chunk(f0), done(f0 ok), chunk(f1), done(f1 ok)
        guard case let .batch(files) = events[0] else { return XCTFail() }
        XCTAssertEqual(files.map(\.name), ["a.txt","b/c.txt"])
        XCTAssertEqual(events[1], .chunk(v.realtimeFileDatas()[0]))
        XCTAssertEqual(events[2], .done(ok: true))
        XCTAssertEqual(events[4], .done(ok: true))
        _ = stream
    }
    func testLegacyKindThrows() {
        let r = RealtimeReceiver(sessionKey: [UInt8](repeating: 0x55, count: 32))
        XCTAssertThrowsError(try r.feed([3, 0,0,0,0])) { XCTAssertEqual($0 as? RealtimeError, .legacyPeer) }
    }
    func testOutOfOrderThrows() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let r = RealtimeReceiver(sessionKey: v.hex("sessionKeyHex"))
        // a CHUNK where a BATCH (seq 0) was expected → out of order
        XCTAssertThrowsError(try r.feed(v.realtimeFrameList()[1])) { XCTAssertEqual($0 as? RealtimeError, .outOfOrder) }
    }
    func testTamperThrows() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let r = RealtimeReceiver(sessionKey: v.hex("sessionKeyHex"))
        var batch = v.realtimeFrameList()[0]; batch[batch.count-1] ^= 0x01   // flip a tag byte
        XCTAssertThrowsError(try r.feed(batch)) { XCTAssertEqual($0 as? RealtimeError, .tamper) }
    }
}
