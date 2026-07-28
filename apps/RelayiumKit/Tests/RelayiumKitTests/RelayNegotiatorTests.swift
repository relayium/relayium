import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private func pool(_ ids: [String]) -> [RelayEntry] {
    ids.map { RelayEntry(id: $0, iceServers: [ICEServerConfig(urls: ["turn:\($0):3478"])]) }
}

final class RelayNegotiatorTests: XCTestCase {
    private func negotiator(_ ids: [String],
                            mine: [String: Int]) -> (RelayNegotiator, FakeWebSocketChannel) {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(ids), measure: { _ in mine })
        return (n, ch)
    }

    func testConvergesOnTheRelayBothPeersLike() async {
        let (n, _) = negotiator(["n1", "n3"], mine: ["n1": 200, "n3": 40])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 30, "n3": 50]))
        let chosen = await n.waitForChoice(deadline: 1.0)
        // n1: max(200,30)=200; n3: max(40,50)=50 → n3.
        XCTAssertEqual(chosen?.id, "n3")
    }

    /// The fallback that keeps this feature from ever being the reason a
    /// transfer fails: a peer on an older build never sends a map.
    func testAPeerThatNeverAnswersLeavesNoChoice() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        let chosen = await n.waitForChoice(deadline: 0.2)
        XCTAssertNil(chosen)
    }

    func testAnEmptyPoolIsSkippedEntirely() async {
        let (n, ch) = negotiator([], mine: [:])
        n.start()
        let chosen = await n.waitForChoice(deadline: 0.2)
        XCTAssertNil(chosen)
        XCTAssertTrue(ch.sent.filter { $0.contains("relayRtt") }.isEmpty,
                      "nothing to advertise, so nothing should be sent")
    }

    /// Broadcast on measure-done and on peer-join, never in reply — that is
    /// what stops two peers echoing maps at each other forever.
    func testNeverRepliesToAReceivedMap() async {
        let (n, ch) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        _ = await n.waitForChoice(deadline: 0.3)   // let the measurement land
        let afterMeasure = ch.sent.filter { $0.contains("relayRtt") }.count
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        XCTAssertEqual(ch.sent.filter { $0.contains("relayRtt") }.count, afterMeasure,
                       "receiving a map must not send one back")
    }

    /// An unrelated signal must not be mistaken for an empty measurement.
    func testAnUnrelatedSignalDoesNotClobberTheMap() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        n.handleSignal(from: "peer", data: .object(["rename": .string("Phone")]))
        let chosen = await n.waitForChoice(deadline: 0.5)
        XCTAssertEqual(chosen?.id, "n1")
    }
}
