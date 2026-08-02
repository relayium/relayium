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
    func testDeinitClosesChannel() {
        let ch = FakeWebSocketChannel()
        do {
            let c = SignalingClient(channel: ch, name: "Mac")
            withExtendedLifetime(c) {}
        }
        XCTAssertTrue(ch.closed, "SignalingClient.deinit must close its channel (breaks the real session↔channel retain cycle)")
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
    // MARK: - listeners alongside the single slot

    /// The whole reason listeners exist: a live `RealtimeConnection` claims
    /// `onSignal`, and background receive has to keep hearing offers anyway. If
    /// registering a listener were the same slot, starting one session would end
    /// the app's ability to be reached until it restarted.
    func testAListenerSurvivesAConnectionClaimingTheSingleSlot() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var heard: [String] = []
        let sub = c.addSignalListener { _, _ in heard.append("listener") }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{"n":1}}"#)

        // A connection takes the slot, mid-life, exactly as RealtimeConnection's
        // initialiser does.
        c.onSignal = { _, _ in heard.append("connection") }
        ch.fireText(#"{"type":"signal","from":"b","data":{"n":2}}"#)
        // …and gives it back on close, as closeLocked does.
        c.onSignal = nil
        ch.fireText(#"{"type":"signal","from":"b","data":{"n":3}}"#)

        XCTAssertEqual(heard, ["listener", "listener", "connection", "listener"])
        sub.cancel()
    }

    /// Listeners run BEFORE the per-connection slot, and that order is what lets
    /// a router hold a live frame back until it has replayed the ones it
    /// buffered. Reversing it would let a live candidate reach a connection
    /// ahead of the offer it answers.
    func testListenersRunBeforeThePerConnectionSlot() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var order: [String] = []
        let sub = c.addSignalListener { _, _ in order.append("listener") }
        c.onSignal = { _, _ in order.append("slot") }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(order, ["listener", "slot"])
        sub.cancel()
    }

    func testCancellingAListenerStopsItAndLeavesTheOthersAlone() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var first = 0, second = 0
        let a = c.addSignalListener { _, _ in first += 1 }
        let b = c.addSignalListener { _, _ in second += 1 }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)

        a.cancel()
        a.cancel()   // idempotent: stop and a socket drop both reach for it
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)

        XCTAssertEqual(first, 1, "a cancelled listener must stop hearing signals")
        XCTAssertEqual(second, 2)
        b.cancel()
    }

    /// A subscription outliving its client must not resurrect or crash it.
    func testCancellingAfterTheClientIsGoneIsHarmless() {
        var subscription: SignalSubscription?
        do {
            let ch = FakeWebSocketChannel()
            let c = SignalingClient(channel: ch, name: "Mac")
            subscription = c.addSignalListener { _, _ in }
            withExtendedLifetime(c) {}
        }
        subscription?.cancel()
    }

    /// The point of an interceptor: a frame it claims does not go on to the
    /// per-connection slot. Without this a router cannot buffer a frame without
    /// the live connection also acting on it.
    func testAConsumedFrameNeverReachesThePerConnectionSlot() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var slot = 0
        var claim = false
        let sub = c.addSignalInterceptor { _, _ in claim ? .consume : .pass }
        c.onSignal = { _, _ in slot += 1 }
        ch.fireOpen()

        ch.fireText(#"{"type":"signal","from":"b","data":{"n":1}}"#)
        XCTAssertEqual(slot, 1, "a passed frame still reaches the connection")

        claim = true
        ch.fireText(#"{"type":"signal","from":"b","data":{"n":2}}"#)
        XCTAssertEqual(slot, 1, "a consumed frame stops at the interceptor")
        sub.cancel()
    }

    /// Claiming stops the chain, not just the slot: a later interceptor must not
    /// re-route a frame an earlier one took responsibility for.
    func testConsumingAlsoStopsLaterInterceptors() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var second = 0
        let a = c.addSignalInterceptor { _, _ in .consume }
        let b = c.addSignalInterceptor { _, _ in second += 1; return .pass }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(second, 0)
        a.cancel(); b.cancel()
    }

    /// The stale-close hazard. Two connections overlap on one socket; the older
    /// one's `close`/`deinit` lands after the newer one installed itself. It
    /// must not be able to clear a slot it no longer owns — the new session
    /// would otherwise go permanently deaf with nothing logged.
    func testAStaleOwnerCannotClearTheCurrentSlot() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var heard: [String] = []
        let stale = c.installSignalHandler { _, _ in heard.append("old") }
        let current = c.installSignalHandler { _, _ in heard.append("new") }
        ch.fireOpen()

        c.removeSignalHandler(stale)      // the old connection finally closes
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(heard, ["new"], "the live handler has to survive a stale close")

        // …and the current owner can still stand down.
        c.removeSignalHandler(current)
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(heard, ["new"])
    }

    /// Assigning the slot directly is still last-writer-wins, and still
    /// invalidates the previous owner's token — otherwise the factory's
    /// temporary handler and a connection built over it could each think they
    /// own the slot.
    func testAssigningTheSlotInvalidatesTheEarlierToken() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var heard = 0
        let superseded = c.installSignalHandler { _, _ in }
        c.onSignal = { _, _ in heard += 1 }
        ch.fireOpen()

        c.removeSignalHandler(superseded)
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(heard, 1, "a token superseded by a direct assignment owns nothing")
    }

    /// RAII: a subscription nobody holds is a listener nobody can stop. Dropping
    /// it has to unregister it, or a replaced router keeps interpreting frames
    /// on behalf of an owner that is gone.
    func testDroppingASubscriptionUnregistersIt() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var heard = 0
        var subscription: SignalSubscription? = c.addSignalListener { _, _ in heard += 1 }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(heard, 1)

        subscription = nil
        _ = subscription
        ch.fireText(#"{"type":"signal","from":"b","data":{}}"#)
        XCTAssertEqual(heard, 1, "a dropped subscription must stop hearing signals")
    }

    /// Listeners hear only what the single slot hears: a malformed frame is
    /// dropped before dispatch, not handed to every subscriber to re-validate.
    func testListenersDoNotSeeMalformedFrames() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var count = 0
        let sub = c.addSignalListener { _, _ in count += 1 }
        ch.fireOpen()
        ch.fireText("not json")
        ch.fireText(#"{"type":"signal","from":"b"}"#)       // no data
        ch.fireText(#"{"type":"signal","data":{}}"#)         // no from
        XCTAssertEqual(count, 0)
        sub.cancel()
    }

    func testCloseFires() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var closed = false; c.onClose = { closed = true }
        ch.fireOpen(); ch.fireRemoteClose()
        XCTAssertTrue(closed)
    }
}
