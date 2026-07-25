import XCTest
@testable import RelayiumKit

final class SignalEnvelopeTests: XCTestCase {
    private let dec = JSONDecoder()
    private let enc = JSONEncoder()

    func testDecodeWelcome() throws {
        let e = try dec.decode(Envelope.self, from: Data(#"{"type":"welcome","name":"peerA","ip":"1.2.3.4"}"#.utf8))
        XCTAssertEqual(e.type, "welcome"); XCTAssertEqual(e.name, "peerA"); XCTAssertEqual(e.ip, "1.2.3.4")
    }
    func testDecodePeers() throws {
        let e = try dec.decode(Envelope.self, from: Data(#"{"type":"peers","peers":[{"id":"a","name":"Mac"},{"id":"b","name":"Phone"}]}"#.utf8))
        XCTAssertEqual(e.peers?.map(\.id), ["a", "b"])
        XCTAssertEqual(e.peers?.map(\.name), ["Mac", "Phone"])
    }
    func testDecodeSignalWithOpaqueData() throws {
        let e = try dec.decode(Envelope.self, from: Data(#"{"type":"signal","from":"a","data":{"kind":"offer","sdp":"v=0"}}"#.utf8))
        XCTAssertEqual(e.type, "signal"); XCTAssertEqual(e.from, "a")
        guard case let .object(o)? = e.data, case let .string(k)? = o["kind"] else { return XCTFail("data not object") }
        XCTAssertEqual(k, "offer")
    }
    func testEncodeJoinOmitsEmptyFields() throws {
        let e = Envelope(type: "join", name: "Mac")
        let s = String(data: try enc.encode(e), encoding: .utf8)!
        // only type + name present; no from/to/ip/peers/data keys
        XCTAssertTrue(s.contains("\"type\":\"join\""))
        XCTAssertTrue(s.contains("\"name\":\"Mac\""))
        XCTAssertFalse(s.contains("\"from\""))
        XCTAssertFalse(s.contains("\"data\""))
        XCTAssertFalse(s.contains("\"peers\""))
    }
    func testEncodeSignalRoundTrips() throws {
        let e = Envelope(type: "signal", to: "b", data: .object(["kind": .string("ice"), "n": .number(3)]))
        let back = try dec.decode(Envelope.self, from: try enc.encode(e))
        XCTAssertEqual(back, e)
    }
}
