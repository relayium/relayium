import XCTest
@testable import RelayiumKit

final class RealtimeReceiverTests: XCTestCase {
    func testFeedRoundTripsWebFrameStream() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let r = RealtimeReceiver(sessionKey: v.hex("sessionKeyHex"))
        // walk frames: [kind][4 seq][payload]; payload len differs per frame, so
        // decode by feeding whole frames — the vector is a concatenation, so split
        // on the known boundaries the generator recorded, OR feed frame-by-frame
        // using the per-frame lengths the test reconstructs from the fixture.
        let frames = v.realtimeFrameList()   // [[UInt8]] individual frames (added to fixture/helper)
        var events: [RealtimeEvent] = []
        for f in frames { events.append(try r.feed(f)) }
        // batch, chunk(f0), done(f0 ok), chunk(f1), done(f1 ok)
        guard case let .batch(files) = events[0] else { return XCTFail() }
        // The raw manifest's 2nd file embeds a bidi control (U+202E) and a C0
        // control (U+0007) in both its name and its path (see
        // gen-realtime-wire-vectors.mjs) — the sealed BATCH frame therefore
        // carries them verbatim (RealtimeSenderTests byte-pins that same raw
        // manifest), but `feed`'s decode is the one place that must strip
        // them before they reach a confirmation card. Assert against the
        // fixture's `sanitizedNames` (computed with the same strip logic as
        // web/src/lib/filename.ts) AND explicitly assert the raw control
        // chars are gone, so this would fail if sanitizeFileMeta were ever
        // reduced to a no-op.
        let expected = v.realtimeSanitizedNames()
        XCTAssertEqual(files.map(\.name), expected.map(\.name))
        XCTAssertEqual(files.map(\.path), expected.map(\.path))
        XCTAssertEqual(files[1].name, "bc.txt")
        XCTAssertEqual(files[1].path, "subdir/c.txt")
        for s in [files[1].name, files[1].path ?? ""] {
            XCTAssertFalse(s.unicodeScalars.contains(Unicode.Scalar(0x202e)!), "bidi control (U+202E) leaked through sanitize")
            XCTAssertFalse(s.unicodeScalars.contains(Unicode.Scalar(0x07)!), "C0 control (U+0007) leaked through sanitize")
        }
        XCTAssertEqual(events[1], .chunk(v.realtimeFileDatas()[0]))
        XCTAssertEqual(events[2], .done(ok: true))
        XCTAssertEqual(events[4], .done(ok: true))
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
    func testResumeStartValid() {
        let r = RealtimeReceiver(sessionKey: [UInt8](repeating: 0x55, count: 32))
        let json = Array(#"{"index":1,"offset":2048,"seq":7}"#.utf8)
        let frame = [UInt8(4), 0,0,0,0] + json
        XCTAssertEqual(try r.feed(frame), .resume(index: 1, offset: 2048, seq: 7))
    }
    func testResumeStartHugeSeqThrowsMalformed() {
        let r = RealtimeReceiver(sessionKey: [UInt8](repeating: 0x55, count: 32))
        // plaintext RESUME_START (kind 4): frame = [4][0,0,0,0][ {"index":0,"offset":0,"seq":5000000000} ]
        let json = Array(#"{"index":0,"offset":0,"seq":5000000000}"#.utf8)
        let frame = [UInt8(4), 0,0,0,0] + json
        XCTAssertThrowsError(try r.feed(frame)) { XCTAssertEqual($0 as? RealtimeError, .malformed) }
    }

    func testRejectsChunksBeyondDeclaredSizeAndShortDone() throws {
        let key = [UInt8](repeating: 0x44, count: 32)

        let tooLongSender = RealtimeSender(sessionKey: key)
        let tooLongReceiver = RealtimeReceiver(sessionKey: key)
        _ = try tooLongReceiver.feed(tooLongSender.batchFrame([FileMeta(name: "a", size: 1)]))
        XCTAssertThrowsError(try tooLongReceiver.feed(tooLongSender.nextChunkFrame([1, 2]))) {
            XCTAssertEqual($0 as? RealtimeError, .lengthMismatch)
        }

        let shortSender = RealtimeSender(sessionKey: key)
        let shortReceiver = RealtimeReceiver(sessionKey: key)
        _ = try shortReceiver.feed(shortSender.batchFrame([FileMeta(name: "a", size: 2)]))
        _ = try shortReceiver.feed(shortSender.nextChunkFrame([1]))
        XCTAssertThrowsError(try shortReceiver.feed(shortSender.nextDoneFrame(hash: chainHash([UInt8](repeating: 0, count: 32), [1])))) {
            XCTAssertEqual($0 as? RealtimeError, .lengthMismatch)
        }
    }
}
