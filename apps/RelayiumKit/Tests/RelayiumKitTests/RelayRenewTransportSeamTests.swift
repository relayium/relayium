import WebRTC
import XCTest
@testable import RelayiumKit

/// The renewal input subscription on the REAL transports — a real
/// `RTCPeerConnection`, the real signalling slot, the real private queue.
///
/// `RelayRenewRouteTests` proves production SUBSCRIBES. This proves the other
/// half: that the two shipping transports actually DELIVER through whatever was
/// subscribed, on the path a real frame takes — socket → interceptor chain →
/// per-connection slot → `handleLocked` → the subscription — and that they stop
/// when told to. A double cannot show that; only the object the app links can.
final class RelayRenewTransportSeamTests: XCTestCase {
    private let peer = "peer-b"
    private let selfId = "peer-a"

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _signals: [RelayRenewEnvelope] = []
        private var _candidates: [String] = []
        var signals: [RelayRenewEnvelope] { lock.lock(); defer { lock.unlock() }; return _signals }
        var candidates: [String] { lock.lock(); defer { lock.unlock() }; return _candidates }
        var inputs: RelayRenewTransportInputs {
            RelayRenewTransportInputs(
                signal: { [weak self] e in
                    guard let self else { return }
                    self.lock.lock(); self._signals.append(e); self.lock.unlock()
                },
                localCandidate: { [weak self] sdp, _, _ in
                    guard let self else { return }
                    self.lock.lock(); self._candidates.append(sdp); self.lock.unlock()
                },
                selectedCandidatePair: { _, _ in })
        }
    }

    private func initial(role: Role = .initiator)
        -> (FakeWebSocketChannel, WebRTCLinkTransport) {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let transport = WebRTCLinkTransport(signaling: signaling, peerId: peer, role: role,
                                            iceServers: [])
        retained.append(signaling)
        return (channel, transport)
    }

    private func replacement() -> (FakeWebSocketChannel, WebRTCLinkReplacementTransport) {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let identity = LinkIdentity(peerId: peer, role: .initiator, sas: "424242",
                                    codecs: LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                                       recvKey: [UInt8](repeating: 2, count: 32)))
        let transport = WebRTCLinkReplacementTransport(signaling: signaling, identity: identity,
                                                       iceServers: [])
        retained.append(signaling)
        return (channel, transport)
    }

    private var retained: [SignalingClient] = []
    override func tearDown() { retained = []; super.tearDown() }

    private func envelope(_ message: RelayRenewMessage = .prepare(epoch: 1)) -> JSONValue {
        relayRenewSignal(message, auth: String(repeating: "A", count: RENEW_AUTH_LENGTH))
    }

    private func fire(_ channel: FakeWebSocketChannel, from: String, _ data: JSONValue) {
        channel.fire(Envelope(type: SignalType.signal, from: from, data: data))
    }

    // MARK: - the initial transport

    func testTheRealInitialTransportDeliversARenewalEnvelopeToItsSubscriber() {
        let (channel, transport) = initial()
        let recorder = Recorder()
        transport.installRenewalInputs(recorder.inputs)
        _ = transport.bufferedAmount(on: .file)   // drain the install

        fire(channel, from: peer, envelope(.ready(epoch: 4, round: 2)))
        _ = transport.bufferedAmount(on: .file)

        XCTAssertEqual(recorder.signals.map(\.message), [.ready(epoch: 4, round: 2)])
        XCTAssertFalse(transport.isClosed, "and the establishment was not disturbed by it")
        transport.close()
    }

    func testAStrangersOrMalformedEnvelopeIsNeverDelivered() {
        let (channel, transport) = initial()
        let recorder = Recorder()
        transport.installRenewalInputs(recorder.inputs)
        _ = transport.bufferedAmount(on: .file)

        fire(channel, from: "somebody-else", envelope())
        // Shaped like renewal, junk inside: claimed and dropped, never handed on.
        fire(channel, from: peer, .object(["link": .bool(true),
                                           "renew": .object(["type": .string("nonsense")]),
                                           "auth": .string(String(repeating: "A", count: 44))]))
        _ = transport.bufferedAmount(on: .file)

        XCTAssertTrue(recorder.signals.isEmpty)
        XCTAssertFalse(transport.isClosed, "junk shaped like renewal must not fail the link")
        transport.close()
    }

    func testUnsubscribingAndClosingBothStopDelivery() {
        let (channel, transport) = initial()
        let recorder = Recorder()
        transport.installRenewalInputs(recorder.inputs)
        transport.installRenewalInputs(nil)
        _ = transport.bufferedAmount(on: .file)
        fire(channel, from: peer, envelope())
        _ = transport.bufferedAmount(on: .file)
        XCTAssertTrue(recorder.signals.isEmpty, "an uninstall means no LATER delivery")

        transport.installRenewalInputs(recorder.inputs)
        transport.close()
        transport.installRenewalInputs(recorder.inputs)   // refused: it is closed
        fire(channel, from: peer, envelope())
        _ = transport.isClosed
        XCTAssertTrue(recorder.signals.isEmpty, "a closed transport holds no path into a controller")
    }

    // MARK: - the rebuilt transport

    func testTheRealReplacementTransportDeliversToo() {
        let (channel, transport) = replacement()
        let recorder = Recorder()
        transport.installRenewalInputs(recorder.inputs)
        _ = transport.bufferedAmount(on: .file)

        fire(channel, from: peer, envelope(.prepare(epoch: 9)))
        _ = transport.bufferedAmount(on: .file)

        XCTAssertEqual(recorder.signals.map(\.message), [.prepare(epoch: 9)],
                       "a renewal envelope must be claimed BEFORE the resume policy")
        XCTAssertFalse(transport.isClosed)
        transport.close()
    }

    // MARK: - the real SDK

    /// `setConfiguration`, an ICE-restart offer and the candidate diversion on
    /// a real `RTCPeerConnection`. This also checks spec §11 gap 2 on THIS
    /// SDK build: the ` ufrag <x>` extension a gathered candidate carries is the
    /// restarted offer's own `a=ice-ufrag`.
    func testTheRealSDKRestartsICEAndDivertsItsCandidatesToTheSubscriber() throws {
        let (_, transport) = initial(role: .initiator)
        let recorder = Recorder()
        transport.installRenewalInputs(recorder.inputs)
        transport.start()   // opens both lanes, so the offer has an m-line

        let configured = expectation(description: "setConfiguration")
        transport.renewalApplyConfiguration([RTCIceServer(urlStrings: ["stun:127.0.0.1:1"])]) {
            XCTAssertTrue($0, "the live connection must accept a fresh configuration")
            configured.fulfill()
        }
        wait(for: [configured], timeout: 10)

        transport.setRenewalEpochInFlight(true)
        let offered = expectation(description: "restart offer")
        var offer: String?
        transport.renewalCreateOffer { offer = $0; offered.fulfill() }
        wait(for: [offered], timeout: 10)
        let sdp = try XCTUnwrap(offer, "the SDK must produce a restart offer")
        let ufrag = relayRenewICEUfrag(sdp: sdp)
        XCTAssertFalse(ufrag.isEmpty, "the applied local description names its generation")
        XCTAssertFalse(relayRenewPin(sdp: sdp).fingerprints.isEmpty)

        // Host candidates gather without any server. Poll until one names the
        // RESTARTED generation.
        let deadline = Date().addingTimeInterval(5)
        func restarted() -> [String] {
            recorder.candidates.filter { relayRenewCandidateUfrag(candidate: $0) == ufrag }
        }
        while restarted().isEmpty, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        transport.close()
        guard !recorder.candidates.isEmpty else {
            throw XCTSkip("this environment gathered no host candidate; nothing to check")
        }
        // Spec §11 gap 2, on THIS SDK build: every candidate string names a
        // generation through the ` ufrag <x>` extension.
        for candidate in recorder.candidates {
            XCTAssertFalse(relayRenewCandidateUfrag(candidate: candidate).isEmpty,
                           "SDK 150 candidate strings must carry the ufrag extension")
        }
        XCTAssertFalse(restarted().isEmpty,
                       "the restart must gather candidates under its OWN generation")
        // And this run usually shows the hazard spec §5.2 describes for real:
        // candidates of the PREVIOUS generation (the establishment offer's)
        // are still being delivered after the restart. They arrive here through
        // the same diversion, which is why the engine labels every candidate by
        // the ufrag it names and never by "the epoch that is current".
        let stale = recorder.candidates.filter {
            relayRenewCandidateUfrag(candidate: $0) != ufrag
        }
        if !stale.isEmpty {
            let engine = RelayRenewEngine(
                selfId: selfId, peerId: peer, role: .initiator,
                baseline: relayRenewPin(sdp: sdp),
                sign: { _ in String(repeating: "A", count: 44) }, verify: { _, _ in true },
                makeNonce: { [UInt8](repeating: 1, count: 16) },
                userDataIsRecent: { true })
            _ = engine.evaluate()
            _ = engine.receive(grant: RelayRenewGrant(
                status: .granted, round: 1, rid: 1,
                config: ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:r:1"],
                                                               username: "1790000000:a",
                                                               credential: "b")])))
            _ = engine.configurationApplied(epoch: 1, ok: true)
            _ = engine.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp)
            XCTAssertTrue(engine.localCandidate(sdp: stale[0], sdpMid: "0",
                                                sdpMLineIndex: 0).isEmpty,
                          "a previous generation's REAL candidate is never sent as this epoch's")
        }
    }
}
