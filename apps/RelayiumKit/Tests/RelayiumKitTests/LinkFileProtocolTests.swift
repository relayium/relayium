import XCTest
@testable import RelayiumKit

/// The `link/1` file lane's one-byte lifecycle vocabulary and its frame demux.
///
/// Byte-pinned to `web/src/lib/transfer.ts`, which is the deployed peer. A
/// disagreement here is not a style difference: it is a native client that
/// answers a browser's consent prompt with a byte the browser reads as
/// something else, or reads an encrypted frame as consent.
final class LinkFileProtocolTests: XCTestCase {

    // ── the exact bytes ─────────────────────────────────────────────────────

    func testLifecycleBytesMatchTheWeb() {
        // transfer.ts: CTRL_ACCEPT 0xfe, CTRL_REJECT 0xff, CTRL_COMPLETE 0xfd,
        // CTRL_BUSY 0xf9, CTRL_BATCH_ABORT 0xf8.
        XCTAssertEqual(RealtimeControl.accept.rawValue, 0xfe)
        XCTAssertEqual(RealtimeControl.reject.rawValue, 0xff)
        XCTAssertEqual(RealtimeControl.complete.rawValue, 0xfd)
        XCTAssertEqual(LINK_FILE_BUSY, 0xf9)
        XCTAssertEqual(LINK_FILE_BATCH_ABORT, 0xf8)
    }

    func testEveryLifecycleByteParsesToItsOwnKind() {
        XCTAssertEqual(linkFileLifecycleKind([0xfe]), .accept)
        XCTAssertEqual(linkFileLifecycleKind([0xff]), .reject)
        XCTAssertEqual(linkFileLifecycleKind([0xfd]), .complete)
        XCTAssertEqual(linkFileLifecycleKind([0xf9]), .busy)
        XCTAssertEqual(linkFileLifecycleKind([0xf8]), .batchAbort)
    }

    /// The whole point of the parser. A protected frame's first byte is never one
    /// of these, but a MALFORMED or truncated one can be anything — and reading a
    /// longer frame as consent is how a peer gets a file accepted without a user.
    func testLongerFramesNeverParseAsControls() {
        for byte in [RealtimeControl.accept.rawValue, RealtimeControl.reject.rawValue,
                     RealtimeControl.complete.rawValue, LINK_FILE_BUSY, LINK_FILE_BATCH_ABORT] {
            XCTAssertNil(linkFileLifecycleKind([byte, 0]))
            XCTAssertNil(linkFileLifecycleKind([byte] + [UInt8](repeating: 0, count: 64)))
            XCTAssertNil(linkFileLifecycleKind([0, byte]))
        }
        XCTAssertNil(linkFileLifecycleKind([]))
    }

    func testUnknownSingleBytesAreNotControls() {
        // The text lane owns 0xfa/0xfb; nothing else is a file lifecycle byte.
        for byte in [UInt8(0x00), 0x01, 0x09, 0x0b, 0xf7, 0xfa, 0xfb, 0xfc] {
            XCTAssertNil(linkFileLifecycleKind([byte]), "0x\(String(byte, radix: 16)) is not a file control")
        }
    }

    /// The file lane and the text lane share ACCEPT/REJECT and nothing else. The
    /// DataChannel label is what scopes them, so the two parsers must not start
    /// answering for each other's private bytes.
    func testFileAndTextLifecycleVocabulariesOverlapOnlyOnAcceptAndReject() {
        XCTAssertEqual(linkTextLifecycleKind([LINK_TEXT_REQUEST]), .request)
        XCTAssertNil(linkFileLifecycleKind([LINK_TEXT_REQUEST]))
        XCTAssertEqual(linkTextLifecycleKind([LINK_TEXT_END]), .end)
        XCTAssertNil(linkFileLifecycleKind([LINK_TEXT_END]))
        XCTAssertNil(linkTextLifecycleKind([LINK_FILE_BUSY]))
        XCTAssertNil(linkTextLifecycleKind([LINK_FILE_BATCH_ABORT]))
        XCTAssertNil(linkTextLifecycleKind([RealtimeControl.complete.rawValue]))
    }

    // ── the demux ───────────────────────────────────────────────────────────

    func testDemuxRoutesEachFrameClassExactlyOnce() {
        XCTAssertEqual(linkFileFrameClass([LINK_FILE_BATCH_ABORT]), .lifecycle(.batchAbort))
        XCTAssertEqual(linkFileFrameClass(ackFrame(4096)), .ack)
        XCTAssertEqual(linkFileFrameClass(resumeReqFrame(index: 1, offset: 0)), .resumeRequest)
        XCTAssertEqual(linkFileFrameClass(realtimeFrame(kind: RealtimeKind.resumeStart, seq: 0,
                                                        payload: Array(#"{"index":0,"offset":0,"seq":7}"#.utf8))),
                       .resumeStart)
        for kind in [RealtimeKind.batchEnc, RealtimeKind.batchPart,
                     RealtimeKind.chunk, RealtimeKind.chunkPart, RealtimeKind.doneEnc] {
            XCTAssertEqual(linkFileFrameClass(realtimeFrame(kind: kind, seq: 3,
                                                            payload: [UInt8](repeating: 0, count: 16))),
                           .protected, "kind \(kind) carries a nonce and must be fed in order")
        }
    }

    /// A kind-5 frame whose payload does not parse is still a resume request, and
    /// the lane must be able to see that. Routing it onward as protected input
    /// would hand plaintext control bytes to an AEAD receiver.
    func testMalformedResumeRequestStaysAResumeRequest() {
        let malformed = realtimeFrame(kind: RealtimeKind.resumeReq, seq: 0, payload: Array("not json".utf8))
        XCTAssertEqual(linkFileFrameClass(malformed), .resumeRequest)
        XCTAssertNil(parseResumeReq(malformed))
    }

    /// An ACK is exactly 13 bytes. A kind-6 frame of any other length is not one,
    /// and must not fall through into the protected stream either.
    func testShortOrLongAckFramesAreUnroutable() {
        XCTAssertEqual(linkFileFrameClass([RealtimeKind.ack, 0, 0, 0, 0]), .unroutable)
        XCTAssertEqual(linkFileFrameClass(ackFrame(1) + [0]), .unroutable)
        XCTAssertEqual(linkFileFrameClass([]), .unroutable)
        XCTAssertEqual(linkFileFrameClass([RealtimeKind.text, 0, 0, 0, 0]), .unroutable,
                       "a text frame on the file channel is not a file frame")
    }

    /// The classes have to partition the space, or a frame gets both counted as
    /// flow control and fed to the receiver.
    func testEveryFirstByteHasExactlyOneClass() {
        for byte in UInt8.min...UInt8.max {
            let single = linkFileFrameClass([byte])
            if let control = linkFileLifecycleKind([byte]) {
                XCTAssertEqual(single, .lifecycle(control))
            } else {
                XCTAssertEqual(single, .unroutable, "0x\(String(byte, radix: 16)) alone is not a frame")
            }
            // A framed (5-byte header) message is never a one-byte control.
            let framed = linkFileFrameClass(realtimeFrame(kind: byte, seq: 0,
                                                          payload: [UInt8](repeating: 0, count: 16)))
            if case .lifecycle = framed {
                XCTFail("0x\(String(byte, radix: 16)) framed must never read as consent")
            }
        }
    }
}
