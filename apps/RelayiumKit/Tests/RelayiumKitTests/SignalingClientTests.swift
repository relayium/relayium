import XCTest
@testable import RelayiumKit

final class SignalingClientTests: XCTestCase {
    func testJoinsOnOpen() {
        let ch = FakeWebSocketChannel()
        let c = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        XCTAssertEqual(ch.sent.count, 1)
        let e = try! JSONDecoder().decode(Envelope.self, from: Data(ch.sent[0].utf8))
        XCTAssertEqual(e.type, "join"); XCTAssertEqual(e.name, "Mac")
        withExtendedLifetime(c) {}
    }
    func testNoRetainCycle() {
        weak var weakClient: SignalingClient?
        do {
            let ch = FakeWebSocketChannel()
            let c = SignalingClient(channel: ch, name: "Mac")
            weakClient = c
            ch.fireOpen()
            withExtendedLifetime(c) {}
        }
        XCTAssertNil(weakClient, "SignalingClient must deinit when its owner drops it (no channel↔client cycle)")
    }
    func testWelcomeDeliversSelfIdAndIp() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var selfId = ""; var ip = ""
        c.onSelfId = { selfId = $0; ip = $1 }
        ch.fireOpen()
        ch.fireText(#"{"type":"welcome","name":"peerA","ip":"9.9.9.9"}"#)
        XCTAssertEqual(selfId, "peerA"); XCTAssertEqual(ip, "9.9.9.9")
    }
    func testPeersDelivered() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var got: [Peer] = []; c.onPeers = { got = $0 }
        ch.fireOpen()
        ch.fireText(#"{"type":"peers","peers":[{"id":"a","name":"A"}]}"#)
        XCTAssertEqual(got, [Peer(id: "a", name: "A")])
    }
    func testSignalDeliversFromAndData() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var from = ""; var data: JSONValue?
        c.onSignal = { from = $0; data = $1 }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{"kind":"offer"}}"#)
        XCTAssertEqual(from, "b")
        guard case let .object(o)? = data, case .string("offer")? = o["kind"] else { return XCTFail() }
    }
    func testSendSignalWrapsToAndData() throws {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        ch.sent.removeAll()   // drop the join frame
        c.sendSignal(to: "b", data: .object(["kind": .string("ice")]))
        let e = try JSONDecoder().decode(Envelope.self, from: Data(ch.sent[0].utf8))
        XCTAssertEqual(e.type, "signal"); XCTAssertEqual(e.to, "b")
        guard case let .object(o)? = e.data, case .string("ice")? = o["kind"] else { return XCTFail() }
        XCTAssertNil(e.from)   // client never sets from
    }
    func testMalformedInboundIsIgnored() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var signalled = false; c.onSignal = { _, _ in signalled = true }
        ch.fireOpen()
        ch.fireText("not json"); ch.fireText("[]"); ch.fireText(#"{"type":123}"#)
        XCTAssertFalse(signalled)   // no crash, no dispatch
    }
    func testCloseFires() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var closed = false; c.onClose = { closed = true }
        ch.fireOpen(); ch.fireRemoteClose()
        XCTAssertTrue(closed)
    }
}
