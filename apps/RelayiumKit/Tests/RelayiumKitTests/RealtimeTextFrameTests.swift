import XCTest
@testable import RelayiumKit

final class RealtimeTextFrameTests: XCTestCase {
    private let key = [UInt8](repeating: 0x42, count: 32)

    func testSenderMatchesBrowserVectorsAndReceiverOpensThemInOrder() throws {
        let vectors = try Vectors.load("realtime-wire-vectors")
        let fixtureKey = vectors.hex("text.keyHex")
        let text = vectors.json["text"] as! [String: Any]
        let cases = text["frames"] as! [[String: Any]]
        let sender = RealtimeTextSender()
        let receiver = RealtimeTextReceiver()

        for item in cases {
            let body = item["body"] as! String
            let expectedFrame = (item["frameHex"] as! String).hexBytes
            XCTAssertEqual(try sender.frame(body: body, key: fixtureKey), expectedFrame)
            XCTAssertEqual(try receiver.receive(frame: expectedFrame, key: fixtureKey), body)
        }
    }

    func testPreservesExactValidUTF8Bodies() throws {
        let bodies = [
            "",
            " \t\r\n ",
            "first\n\n\tsecond\r\n",
            "before\u{0}after",
            "你好 مرحبا 🌍 e\u{301}",
        ]
        let sender = RealtimeTextSender()
        let receiver = RealtimeTextReceiver()

        for body in bodies {
            let frame = try sender.frame(body: body, key: key)
            let received = try receiver.receive(frame: frame, key: key)
            XCTAssertEqual(Array(received.utf8), Array(body.utf8))
        }
    }

    func testLimitIsUTF8BytesAndOversizeDoesNotConsumeSequence() throws {
        let sender = RealtimeTextSender()
        let receiver = RealtimeTextReceiver()
        let exactly = String(repeating: "你", count: TEXT_MAX_BYTES / 3)
            + String(repeating: "a", count: TEXT_MAX_BYTES % 3)
        XCTAssertEqual(exactly.utf8.count, TEXT_MAX_BYTES)
        let first = try sender.frame(body: exactly, key: key)
        XCTAssertEqual(try receiver.receive(frame: first, key: key), exactly)

        let freshSender = RealtimeTextSender()
        XCTAssertThrowsError(
            try freshSender.frame(body: String(repeating: "你", count: TEXT_MAX_BYTES / 3 + 1), key: key)
        ) { error in
            XCTAssertEqual(
                error as? RealtimeTextError,
                .messageTooLarge(bytes: 65_538, limit: TEXT_MAX_BYTES)
            )
        }
        let afterRejection = try freshSender.frame(body: "still zero", key: key)
        XCTAssertEqual(Array(afterRejection[1...4]), [0, 0, 0, 0])
    }

    func testRejectsMalformedWrongKindGapAndRepeatWithoutAdvancing() throws {
        let sender = RealtimeTextSender()
        let receiver = RealtimeTextReceiver()
        XCTAssertThrowsError(try receiver.receive(frame: [9, 0, 0], key: key)) {
            XCTAssertEqual($0 as? RealtimeTextError, .malformedFrame)
        }
        XCTAssertThrowsError(
            try receiver.receive(frame: realtimeFrame(kind: RealtimeKind.chunk, seq: 0, payload: [UInt8](repeating: 0, count: 16)), key: key)
        ) {
            XCTAssertEqual($0 as? RealtimeTextError, .wrongKind)
        }

        let zero = try sender.frame(body: "zero", key: key)
        let one = try sender.frame(body: "one", key: key)
        XCTAssertThrowsError(try receiver.receive(frame: one, key: key)) {
            XCTAssertEqual($0 as? RealtimeTextError, .outOfOrder(expected: 0, actual: 1))
        }
        XCTAssertEqual(try receiver.receive(frame: zero, key: key), "zero")
        XCTAssertThrowsError(try receiver.receive(frame: zero, key: key)) {
            XCTAssertEqual($0 as? RealtimeTextError, .outOfOrder(expected: 1, actual: 0))
        }
        XCTAssertEqual(try receiver.receive(frame: one, key: key), "one")
    }

    func testTamperAndWrongKeyFailWithoutAdvancing() throws {
        let sender = RealtimeTextSender()
        let valid = try sender.frame(body: "body must not enter errors", key: key)
        var tampered = valid
        tampered[tampered.count - 1] ^= 1

        let receiver = RealtimeTextReceiver()
        XCTAssertThrowsError(try receiver.receive(frame: tampered, key: key)) {
            XCTAssertEqual($0 as? RealtimeTextError, .authenticationFailed)
            XCTAssertFalse(String(describing: $0).contains("body must not enter errors"))
        }
        XCTAssertThrowsError(
            try receiver.receive(frame: valid, key: [UInt8](repeating: 0x24, count: 32))
        ) {
            XCTAssertEqual($0 as? RealtimeTextError, .authenticationFailed)
        }
        XCTAssertEqual(try receiver.receive(frame: valid, key: key), "body must not enter errors")
    }

    func testInvalidUTF8FailsWithoutAdvancing() throws {
        let invalid = realtimeFrame(
            kind: RealtimeKind.text,
            seq: 0,
            payload: seal(key: key, seq: 0, plaintext: [0x80])
        )
        let valid = realtimeFrame(
            kind: RealtimeKind.text,
            seq: 0,
            payload: seal(key: key, seq: 0, plaintext: Array("valid".utf8))
        )
        let receiver = RealtimeTextReceiver()
        XCTAssertThrowsError(try receiver.receive(frame: invalid, key: key)) {
            XCTAssertEqual($0 as? RealtimeTextError, .invalidUTF8(bytes: 1))
        }
        XCTAssertEqual(try receiver.receive(frame: valid, key: key), "valid")
    }

    func testReceiverRejectsOversizeBeforeOpenAndDoesNotAdvance() throws {
        let oversizedPlaintext = [UInt8](repeating: 0x61, count: TEXT_MAX_BYTES + 1)
        let oversized = realtimeFrame(
            kind: RealtimeKind.text,
            seq: 0,
            payload: seal(key: key, seq: 0, plaintext: oversizedPlaintext)
        )
        let valid = realtimeFrame(
            kind: RealtimeKind.text,
            seq: 0,
            payload: seal(key: key, seq: 0, plaintext: Array("valid".utf8))
        )
        let receiver = RealtimeTextReceiver()
        XCTAssertThrowsError(try receiver.receive(frame: oversized, key: key)) {
            XCTAssertEqual(
                $0 as? RealtimeTextError,
                .messageTooLarge(bytes: TEXT_MAX_BYTES + 1, limit: TEXT_MAX_BYTES)
            )
        }
        XCTAssertEqual(try receiver.receive(frame: valid, key: key), "valid")
    }

    func testInvalidKeyFailsSafelyWithoutConsumingSequence() throws {
        let sender = RealtimeTextSender()
        XCTAssertThrowsError(try sender.frame(body: "secret", key: [])) {
            XCTAssertEqual($0 as? RealtimeTextError, .invalidKey)
        }
        let frame = try sender.frame(body: "first", key: key)
        XCTAssertEqual(Array(frame[1...4]), [0, 0, 0, 0])

        let receiver = RealtimeTextReceiver()
        XCTAssertThrowsError(try receiver.receive(frame: frame, key: [])) {
            XCTAssertEqual($0 as? RealtimeTextError, .invalidKey)
        }
        XCTAssertEqual(try receiver.receive(frame: frame, key: key), "first")
    }

    func testTransportRefusalDoesNotConsumeSequence() throws {
        let sender = RealtimeTextSender()
        var refused: [UInt8] = []
        let queued = try sender.enqueueFrame(body: "not queued", key: key) { frame in
            refused = frame
            return false
        }
        XCTAssertFalse(queued)
        XCTAssertEqual(Array(refused[1...4]), [0, 0, 0, 0])

        let next = try sender.frame(body: "still zero", key: key)
        XCTAssertEqual(Array(next[1...4]), [0, 0, 0, 0])
        XCTAssertEqual(
            try RealtimeTextReceiver().receive(frame: next, key: key),
            "still zero"
        )
    }
}
