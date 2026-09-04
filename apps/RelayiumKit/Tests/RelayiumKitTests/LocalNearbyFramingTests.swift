import XCTest
@testable import RelayiumLocalPeerKit

final class LocalNearbyFramingTests: XCTestCase {
    func testEverySplitReassemblesOneFrame() throws {
        let frame = try XCTUnwrap(LocalPeerFraming.encode("{\"type\":\"signal\"}"))
        for split in 0...frame.count {
            var reader = LocalPeerFraming.Reader()
            let first = try reader.append(frame.prefix(split))
            let second = try reader.append(frame.suffix(from: split))
            XCTAssertEqual(first + second, ["{\"type\":\"signal\"}"])
            XCTAssertEqual(reader.pendingBytes, 0)
        }
    }

    func testCoalescedFramesDrainInOrder() throws {
        var reader = LocalPeerFraming.Reader()
        let bytes = try XCTUnwrap(LocalPeerFraming.encode("one"))
            + XCTUnwrap(LocalPeerFraming.encode("two"))
        XCTAssertEqual(try reader.append(bytes), ["one", "two"])
        XCTAssertEqual(reader.pendingBytes, 0)
    }

    func testEmptyAndOversizedHeadersFailBeforeRetainingBody() {
        var empty = LocalPeerFraming.Reader()
        XCTAssertThrowsError(try empty.append(Data([0, 0, 0, 0]))) {
            XCTAssertEqual($0 as? LocalPeerFramingError, .emptyFrame)
        }

        var oversized = LocalPeerFraming.Reader()
        let declared = LocalPeerFraming.maximumFrameBytes + 1
        let header = Data([
            UInt8((declared >> 24) & 0xff), UInt8((declared >> 16) & 0xff),
            UInt8((declared >> 8) & 0xff), UInt8(declared & 0xff),
        ])
        XCTAssertThrowsError(try oversized.append(header + Data(repeating: 7, count: 1_000_000))) {
            XCTAssertEqual($0 as? LocalPeerFramingError, .frameTooLarge(declared: declared))
        }
        XCTAssertEqual(oversized.pendingBytes, LocalPeerFraming.headerBytes)
    }

    func testInvalidUTF8Fails() {
        var reader = LocalPeerFraming.Reader()
        XCTAssertThrowsError(try reader.append(Data([0, 0, 0, 1, 0xff]))) {
            XCTAssertEqual($0 as? LocalPeerFramingError, .notUTF8)
        }
    }

    func testEncoderEnforcesTheSameBounds() {
        XCTAssertNil(LocalPeerFraming.encode(""))
        XCTAssertNotNil(LocalPeerFraming.encode(String(repeating: "a", count: LocalPeerFraming.maximumFrameBytes)))
        XCTAssertNil(LocalPeerFraming.encode(String(repeating: "a", count: LocalPeerFraming.maximumFrameBytes + 1)))
    }
}
