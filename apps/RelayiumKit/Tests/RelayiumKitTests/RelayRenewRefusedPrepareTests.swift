import XCTest
@testable import RelayiumKit

/// G34-N13: an authenticated `prepare` this side REFUSES has still spent its
/// epoch.
///
/// The refusal verified the peer's tag and routed the epoch, so the exact
/// signed envelope, replayed after the refusing condition clears, must start
/// nothing: no attempt, no server round. The idle refusal stays silent, as it
/// was; a strictly newer legitimate prepare still works. Every envelope is
/// signed with the real `signResume` over the real payload.
final class RelayRenewRefusedPrepareTests: XCTestCase {
    private let alice = "peer-a1b2c3"
    private let bob = "peer-d4e5f6"
    private let key = [UInt8](repeating: 0x2e, count: 32)

    private final class Conditions {
        var userData = true
        var liveGrant = true
    }
    private var conditions = Conditions()

    override func setUp() {
        super.setUp()
        conditions = Conditions()
    }

    private func sdp(ufrag: String) -> String {
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
            + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
            + "a=ice-ufrag:\(ufrag)\r\na=fingerprint:sha-256 AB:CD:EF:01\r\n"
            + "a=setup:actpass\r\na=mid:0\r\n"
    }

    private func engine() -> RelayRenewEngine {
        let conditions = self.conditions
        return RelayRenewEngine(selfId: alice,
                                peerId: bob,
                                role: .initiator,
                                baseline: relayRenewPin(sdp: sdp(ufrag: "AAAA")),
                                sign: { signResume(key: self.key, payload: $0) },
                                verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
                                makeNonce: { [UInt8](repeating: 0x11, count: 16) },
                                userDataIsRecent: { conditions.userData },
                                grantIsLive: { conditions.liveGrant })
    }

    private func signed(_ message: RelayRenewMessage, key: [UInt8]? = nil) -> RelayRenewEnvelope {
        RelayRenewEnvelope(message: message,
                           auth: signResume(key: key ?? self.key,
                                            payload: relayRenewPayload(message, from: bob, to: alice)))
    }

    private func rounds(_ effects: [RelayRenewEffect]) -> [UInt32] {
        effects.compactMap { if case let .requestRound(round, _) = $0 { return round } else { return nil } }
    }

    private func signals(_ effects: [RelayRenewEffect]) -> [RelayRenewMessage] {
        effects.compactMap {
            guard case let .sendSignal(json) = $0 else { return nil }
            return parsedRelayRenewEnvelope(json)?.message
        }
    }

    private func refuseThenReplay(gate: (Conditions) -> Void, clear: (Conditions) -> Void,
                                  file: StaticString = #filePath, line: UInt = #line) {
        let e = engine()
        let prepare = signed(.prepare(epoch: 1))
        gate(conditions)
        XCTAssertTrue(e.receive(prepare).isEmpty, "the refusal stays silent", file: file, line: line)
        XCTAssertFalse(e.isAttempting, file: file, line: line)

        clear(conditions)
        let replay = e.receive(prepare)   // the exact same signed envelope
        XCTAssertTrue(rounds(replay).isEmpty, "a replayed refused prepare asked the server for a round",
                      file: file, line: line)
        XCTAssertTrue(replay.isEmpty, file: file, line: line)
        XCTAssertFalse(e.isAttempting, "a replayed refused prepare started an epoch", file: file, line: line)

        // A fresh, strictly newer legitimate prepare is accepted.
        let fresh = e.receive(signed(.prepare(epoch: 2)))
        XCTAssertEqual(rounds(fresh), [1], file: file, line: line)
        XCTAssertEqual(e.currentEpoch, 2, file: file, line: line)
        XCTAssertEqual(signals(fresh).first, .prepare(epoch: 2), file: file, line: line)
    }

    func testAPrepareRefusedWhileIdleIsNotReplayableOnceActive() {
        refuseThenReplay(gate: { $0.userData = false }, clear: { $0.userData = true })
    }

    func testAPrepareRefusedWithoutALiveGrantIsNotReplayableOnceLive() {
        refuseThenReplay(gate: { $0.liveGrant = false }, clear: { $0.liveGrant = true })
    }

    /// Refused while an attempt runs: the higher epoch is spent, so its replay
    /// cannot supersede the attempt. Equal still coalesces; newer still wins.
    func testAHigherPrepareRefusedDuringAnAttemptCannotSupersedeItLater() {
        let e = engine()
        XCTAssertEqual(rounds(e.evaluate()), [1])
        XCTAssertEqual(e.currentEpoch, 1)

        let higher = signed(.prepare(epoch: 2))
        conditions.userData = false
        XCTAssertTrue(e.receive(higher).isEmpty)
        XCTAssertEqual(e.currentEpoch, 1)

        conditions.userData = true
        XCTAssertTrue(e.receive(higher).isEmpty, "the replayed refused prepare superseded the attempt")
        XCTAssertEqual(e.currentEpoch, 1)

        XCTAssertTrue(e.receive(signed(.prepare(epoch: 1))).isEmpty, "equal coalesces")
        XCTAssertEqual(e.currentEpoch, 1)

        let newer = e.receive(signed(.prepare(epoch: 3)))
        XCTAssertEqual(rounds(newer), [1])
        XCTAssertEqual(e.currentEpoch, 3)
    }

    /// Forged or corrupted prepares never spend an epoch.
    func testAnUnauthenticatedPrepareDoesNotSpendItsEpoch() {
        let e = engine()
        conditions.userData = false
        let genuine = signed(.prepare(epoch: 1))
        let forgeries = [
            RelayRenewEnvelope(message: .prepare(epoch: 1), auth: String(repeating: "A", count: 44)),
            signed(.prepare(epoch: 1), key: [UInt8](repeating: 0x2f, count: 32)),
            RelayRenewEnvelope(message: .prepare(epoch: 1), auth: signed(.prepare(epoch: 2)).auth),
        ]
        for forged in forgeries {
            XCTAssertTrue(e.receive(forged).isEmpty)
        }
        conditions.userData = true
        XCTAssertEqual(rounds(e.receive(genuine)), [1], "the genuine prepare must still work")
        XCTAssertEqual(e.currentEpoch, 1)
    }

    /// The budget refusal (already recorded before G34-N13): its abort is
    /// unchanged and its replay is inert.
    func testABudgetRefusedPrepareStaysSpent() {
        let e = engine()
        var refused: RelayRenewEnvelope?
        for epoch in UInt32(1)...UInt32(30) {
            let envelope = signed(.prepare(epoch: epoch))
            let effects = e.receive(envelope)
            if rounds(effects).isEmpty, signals(effects) == [.abort(epoch: epoch, reason: .unavailable)] {
                refused = envelope
                break
            }
        }
        guard let refused else { return XCTFail("the pre-grant budget never refused") }
        XCTAssertTrue(e.receive(refused).isEmpty)
        XCTAssertFalse(e.isAttempting)
    }
}
