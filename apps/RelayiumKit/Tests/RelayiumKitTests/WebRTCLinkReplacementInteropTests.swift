import Foundation
import XCTest
import WebRTC
@testable import RelayiumKit

/// TWO real `WebRTCLinkReplacementTransport`s rebuilding ONE authenticated
/// `link/1` identity across a bridged signalling room.
///
/// ## Why this suite exists
///
/// Everything else about the replacement driver is decided by objects that need
/// no peer — `LinkResumePolicy`, `LinkEstablishment`, `LinkCandidateGate`,
/// `LinkDeadlineClock` — and the few decisions that live inside the WebRTC layer
/// were pinned by a source guard. A source guard is an honest second-best: it
/// proves a line of code is still written the way it was, not that two endpoints
/// ever agreed on anything.
///
/// The central production property of the whole feature is not a line of code.
/// It is that two peers holding mirrored session keys, and NOTHING else — no
/// commit, no reveal, no SAS comparison — can rebuild both lanes of a link they
/// already authenticated, and that the transport they end up with carries the
/// exact `LinkCodecs` object each side started with. Publication needs two open
/// `RTCDataChannel`s, which needs a real offer, a real answer, real ICE and real
/// DCEP, so that property was previously unevidenced. Two local
/// `RTCPeerConnection`s can exercise it, so it should not stay a claim.
///
/// ## What the bridge is, and what it is not
///
/// `SignalingBridge` is a deterministic in-memory stand-in for the hub: it
/// decodes what one side put on its socket, records it, and re-delivers it to
/// the other with the correct `from`. It is deliberately dumb — it never
/// inspects, reorders or drops a payload — because the point is that the two
/// drivers agree, not that a clever harness made them.
///
/// It is also the vantage point for the security half of this suite. The bridge
/// sees exactly what a signalling relay sees, so asserting on its transcript is
/// asserting on what an attacker is handed: every actionable signal on the
/// `resume` generation, authentic under the mirrored key, and carrying none of
/// the commit/reveal/capability fields that would describe a trust step a
/// rebuild did not perform.
///
/// ## What it still does not prove
///
/// Interoperability with the deployed web client. Both ends here are this
/// build's own driver, so an assumption both copies share — a field name, a
/// signing order, a generation ranking — would satisfy both of them. Only a
/// native↔Web run closes that, and none has been made. `LINK_BUILD_SUPPORT`
/// and `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` therefore both remain false.
final class WebRTCLinkReplacementInteropTests: XCTestCase {

    // MARK: - the bridged signalling room

    /// One signal as the relay saw it: who sent it, who it was addressed to, and
    /// the exact bytes.
    private struct BridgedSignal {
        let from: String
        let to: String
        let data: JSONValue
        let text: String
    }

    /// One endpoint's socket. Everything it is asked to send goes to the bridge
    /// tagged with the peer id the hub would have assigned it.
    private final class BridgeChannel: WebSocketChannel {
        var onOpen: (() -> Void)?
        var onText: ((String) -> Void)?
        var onClose: (() -> Void)?

        let peerId: String
        /// Weak so the bridge, which holds both channels, owns the graph.
        weak var bridge: SignalingBridge?

        private let lock = NSLock()
        private var _open = false

        init(peerId: String) { self.peerId = peerId }

        var isOpen: Bool { lock.withLock { _open } }

        func send(_ text: String) {
            guard isOpen else { return }
            bridge?.route(from: peerId, text: text)
        }

        func close() {
            lock.withLock { _open = false }
            onClose?()
        }

        func open() {
            lock.withLock { _open = true }
            onOpen?()
        }

        /// Always called on the bridge's serial queue, which is what makes
        /// delivery order deterministic.
        func deliver(_ text: String) { onText?(text) }
    }

    /// The hub, in memory: routes `signal` envelopes between two endpoints and
    /// keeps the complete transcript.
    ///
    /// Delivery is asynchronous on ONE serial queue. Asynchronous because a
    /// synchronous hand-off would run the far side's inbound handling inside the
    /// near side's send — re-entering a WebRTC completion from a transport queue
    /// that is already busy — and serial because per-side ordering is a property
    /// the drivers rely on: a candidate must not overtake the description it
    /// belongs to. Each transport sends from its own serial queue, so enqueueing
    /// in call order preserves that.
    private final class SignalingBridge {
        private let queue = DispatchQueue(label: "im.relayium.SignalingBridgeTests")
        private let lock = NSLock()
        private var _transcript: [BridgedSignal] = []
        private var endpoints: [String: BridgeChannel] = [:]

        /// Every `signal` envelope either side put on its socket, in send order.
        var transcript: [BridgedSignal] { lock.withLock { _transcript } }

        func channel(for peerId: String) -> BridgeChannel {
            let channel = BridgeChannel(peerId: peerId)
            channel.bridge = self
            lock.withLock { endpoints[peerId] = channel }
            return channel
        }

        func route(from: String, text: String) {
            guard let raw = text.data(using: .utf8),
                  let envelope = try? JSONDecoder().decode(Envelope.self, from: raw) else { return }
            // `join` is the client announcing itself to a hub that does not exist
            // here. Nothing routes it, and it is not part of the transcript the
            // security assertions read.
            guard envelope.type == SignalType.signal,
                  let to = envelope.to,
                  let data = envelope.data else { return }
            // Recorded on the SEND side, so a signal is in the transcript whether
            // or not the far end was still there to receive it.
            lock.withLock {
                _transcript.append(BridgedSignal(from: from, to: to, data: data, text: text))
            }
            queue.async { [weak self] in
                guard let self else { return }
                let destination = self.lock.withLock { self.endpoints[to] }
                guard let destination else { return }
                // The hub rewrites `to` into `from`; that attribution is the only
                // thing the receiving policy is given, and it is exactly what a
                // relay controls.
                let inbound = Envelope(type: SignalType.signal, from: from, data: data)
                guard let encoded = try? JSONEncoder().encode(inbound),
                      let text = String(data: encoded, encoding: .utf8) else { return }
                destination.deliver(text)
            }
        }
    }

    // MARK: - one side

    /// Thread-safe capture of one driver's client callbacks.
    ///
    /// Every one of them fires on that transport's own private queue, so the
    /// test may only read them through a lock — and the expectations are handed
    /// in at construction rather than assigned later, so nothing is written from
    /// the test thread while a callback is reading it.
    private final class Recorder {
        private let lock = NSLock()
        private var _identity: LinkIdentity?
        private var _errors: [Error] = []
        private var _closes = 0
        private var _frames: [LinkLane: [[UInt8]]] = [:]

        let readyExpectation: XCTestExpectation
        let framesExpectation: XCTestExpectation
        let closedExpectation: XCTestExpectation

        init(ready: XCTestExpectation, frames: XCTestExpectation, closed: XCTestExpectation) {
            self.readyExpectation = ready
            self.framesExpectation = frames
            self.closedExpectation = closed
        }

        func attach(to transport: WebRTCLinkReplacementTransport) {
            transport.onReady = { [weak self] identity in
                guard let self else { return }
                self.lock.withLock { self._identity = identity }
                self.readyExpectation.fulfill()
            }
            transport.onFrame = { [weak self] lane, bytes in
                guard let self else { return }
                self.lock.withLock { self._frames[lane, default: []].append(bytes) }
                self.framesExpectation.fulfill()
            }
            transport.onError = { [weak self] error in
                guard let self else { return }
                self.lock.withLock { self._errors.append(error) }
            }
            transport.onClose = { [weak self] in
                guard let self else { return }
                self.lock.withLock { self._closes += 1 }
                self.closedExpectation.fulfill()
            }
        }

        var identity: LinkIdentity? { lock.withLock { _identity } }
        var errors: [Error] { lock.withLock { _errors } }
        var closes: Int { lock.withLock { _closes } }
        func received(on lane: LinkLane) -> [[UInt8]] { lock.withLock { _frames[lane] ?? [] } }
    }

    private final class Endpoint {
        let peerId: String
        let identity: LinkIdentity
        let signaling: SignalingClient
        let transport: WebRTCLinkReplacementTransport
        let recorder: Recorder

        init(peerId: String,
             identity: LinkIdentity,
             signaling: SignalingClient,
             transport: WebRTCLinkReplacementTransport,
             recorder: Recorder) {
            self.peerId = peerId
            self.identity = identity
            self.signaling = signaling
            self.transport = transport
            self.recorder = recorder
        }
    }

    // MARK: - harness

    private let sas = "482913"
    private let generation = 7

    /// The two mirrored halves of one link's session secrets. Each side's send
    /// key is the other's receive key, which is what makes `deriveResumeAuth`
    /// — deliberately sorted — produce ONE shared signalling key from two
    /// different `LinkCodecs` objects.
    private var keyAtoB: [UInt8] { [UInt8](repeating: 0x11, count: 32) }
    private var keyBtoA: [UInt8] { [UInt8](repeating: 0x22, count: 32) }

    private func endpoint(peerId: String,
                          peer: String,
                          role: Role,
                          codecs: LinkCodecs,
                          bridge: SignalingBridge) -> Endpoint {
        let channel = bridge.channel(for: peerId)
        let signaling = SignalingClient(channel: channel, name: peerId)
        channel.open()
        let identity = LinkIdentity(peerId: peer,
                                    role: role,
                                    sas: sas,
                                    codecs: codecs,
                                    authenticationGeneration: generation)
        let transport = WebRTCLinkReplacementTransport(
            signaling: signaling,
            identity: identity,
            // No STUN and no TURN: host candidates only, so this suite never
            // touches the network and cannot be made to pass or fail by one.
            iceServers: [],
            // The deployed web client's own deadlines. Generous, and finite:
            // a rebuild that never completes fails this test rather than
            // hanging it.
            deadlines: LinkDeadlines())
        let recorder = Recorder(
            ready: expectation(description: "\(peerId) published its rebuilt transport"),
            frames: {
                let frames = expectation(description: "\(peerId) received both lanes' frames")
                frames.expectedFulfillmentCount = 2
                return frames
            }(),
            closed: expectation(description: "\(peerId) closed"))
        recorder.attach(to: transport)
        return Endpoint(peerId: peerId,
                        identity: identity,
                        signaling: signaling,
                        transport: transport,
                        recorder: recorder)
    }

    /// Waits for a condition the runtime gives no callback for — here,
    /// deallocation. Polls rather than sleeping a fixed span, so the common case
    /// costs one iteration and the assertion still has a finite bound.
    private func poll(timeout: TimeInterval = 10,
                      until condition: @escaping () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        return condition()
    }

    private func settle(_ seconds: TimeInterval = 0.5) {
        let settled = expectation(description: "settled")
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { settled.fulfill() }
        wait(for: [settled], timeout: seconds + 5)
    }

    /// The ONE failure a bounded two-sided cleanup may legitimately produce: a
    /// side whose peer closed first saw a published lane of its own go
    /// terminal, on one of the exact two labels.
    ///
    /// Deliberately an exact list rather than a predicate over the error's
    /// shape. `laneClosed` is the only outcome that can be attributed to a
    /// cleanup this test itself performed; `peerConnectionFailed`,
    /// `laneClosedBeforeReady`, an establishment timeout or a candidate
    /// overflow all describe something else, and a cleanup assertion that let
    /// them through would be the assertion this suite exists to make.
    private let toleratedDuringCleanup: [LinkTransportError] = [
        .laneClosed(LinkLane.file.label),
        .laneClosed(LinkLane.text.label),
    ]

    /// Everything a recorder holds that the cleanup above cannot account for,
    /// rendered so a failure names what actually arrived. An error that is not
    /// a `LinkTransportError` at all is never tolerated.
    private func unexpectedDuringCleanup(_ errors: [Error]) -> [String] {
        errors
            .filter { error in
                guard let link = error as? LinkTransportError else { return true }
                return !toleratedDuringCleanup.contains(link)
            }
            .map { String(describing: $0) }
    }

    private func fields(_ signal: JSONValue) -> [String: JSONValue] {
        guard case let .object(o) = signal else { return [:] }
        return o
    }

    // MARK: - the run

    /// Two drivers, one identity, both lanes, both directions — and a transcript
    /// a signalling relay could not have produced.
    ///
    /// Deliberately ONE test rather than several. Every assertion below is about
    /// the same single negotiation, and splitting them would mean paying for a
    /// real ICE handshake once per property while making each property's
    /// evidence a different connection from the others'. The one property that
    /// is NOT about this negotiation has its own run below: what a peer sees
    /// when its counterpart closes cannot be observed here, because here both
    /// sides close.
    func testTwoRealDriversRebuildOneAuthenticatedLinkOverABridgedRoom() throws {
        let bridge = SignalingBridge()
        // Mirrored, and each side keeps its OWN object: the identity assertions
        // below are `===` against these exact instances, which is the whole
        // invariant — a rebuild that constructed a second `LinkCodecs` would
        // restart AEAD sequences under keys that have already used them.
        let codecsA = LinkCodecs(sendKey: keyAtoB, recvKey: keyBtoA)
        let codecsB = LinkCodecs(sendKey: keyBtoA, recvKey: keyAtoB)
        XCTAssertEqual(codecsA.resumeAuthKey, codecsB.resumeAuthKey,
                       "mirrored secrets must derive ONE shared signalling key")
        XCTAssertFalse(codecsA === codecsB)

        weak var releasedA: WebRTCLinkReplacementTransport?
        weak var releasedB: WebRTCLinkReplacementTransport?

        do {
            // Roles are INHERITED from the identities, never recomputed here —
            // the split the first connection settled is what stops a rebuild
            // turning two peers into two offerers.
            let a = endpoint(peerId: "a", peer: "b", role: .initiator,
                             codecs: codecsA, bridge: bridge)
            let b = endpoint(peerId: "b", peer: "a", role: .responder,
                             codecs: codecsB, bridge: bridge)

            // MARK: both sides publish

            a.transport.start()
            b.transport.start()
            wait(for: [a.recorder.readyExpectation, b.recorder.readyExpectation], timeout: 60)

            for side in [a, b] {
                let published = try XCTUnwrap(side.recorder.identity,
                                              "\(side.peerId) never published")
                XCTAssertEqual(published.peerId, side.identity.peerId)
                XCTAssertEqual(published.role, side.identity.role)
                XCTAssertEqual(published.sas, sas,
                               "the six digits belong to the authentication this rebuild inherited")
                XCTAssertEqual(published.authenticationGeneration, generation,
                               "a rebuild is the same authentication, so it must not advance")
                XCTAssertTrue(published.codecs === side.identity.codecs,
                              "\(side.peerId) published a different LinkCodecs than it was handed")
                XCTAssertTrue(side.recorder.errors.isEmpty,
                              "\(side.peerId) reported \(side.recorder.errors)")
                XCTAssertEqual(side.recorder.closes, 0, "\(side.peerId) closed before it was told to")
                XCTAssertFalse(side.transport.isClosed)
            }
            XCTAssertEqual(a.recorder.identity?.role, .initiator)
            XCTAssertEqual(b.recorder.identity?.role, .responder)

            // MARK: both lanes actually carry bytes, in both directions

            // Distinct on purpose, and binary rather than text: a lane that
            // crossed with another, or a byte the SCTP path mangled, has to
            // show up as a comparison failure rather than as a plausible string.
            let fileFromA: [UInt8] = [0x00, 0xff, 0x10, 0x00, 0x7f, 0x80, 0x01]
            let textFromA: [UInt8] = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x02]
            let fileFromB: [UInt8] = [0x13, 0x37, 0xc0, 0xde, 0xff, 0x00, 0x03]
            let textFromB: [UInt8] = [0xca, 0xfe, 0xba, 0xbe, 0x00, 0xff, 0x04]

            try a.transport.send(fileFromA, on: .file)
            try a.transport.send(textFromA, on: .text)
            try b.transport.send(fileFromB, on: .file)
            try b.transport.send(textFromB, on: .text)

            wait(for: [a.recorder.framesExpectation, b.recorder.framesExpectation], timeout: 30)

            XCTAssertEqual(b.recorder.received(on: .file), [fileFromA])
            XCTAssertEqual(b.recorder.received(on: .text), [textFromA])
            XCTAssertEqual(a.recorder.received(on: .file), [fileFromB])
            XCTAssertEqual(a.recorder.received(on: .text), [textFromB])

            for side in [a, b] {
                XCTAssertTrue(side.recorder.errors.isEmpty,
                              "\(side.peerId) reported \(side.recorder.errors)")
                XCTAssertEqual(side.recorder.closes, 0)
            }

            // MARK: bounded cleanup

            // Two `close()` calls back to back from the test thread do NOT put
            // the two teardowns in that order. Each lands on its own
            // transport's queue, and A's teardown is meanwhile travelling to B
            // over a real SCTP association — so whether B closes itself or is
            // closed out from under it by A is a race, and it is one either
            // side can lose. A published lane going terminal is a failure by
            // design and must stay one, because the identical event on the wire
            // is a peer that crashed. So exactly that outcome is tolerated
            // below, and nothing else. It is not asserted away:
            // `testClosingOneSideEndsTheOtherWithExactlyOneLaneClose` forces
            // the order and asserts it.
            a.transport.close()
            b.transport.close()
            wait(for: [a.recorder.closedExpectation, b.recorder.closedExpectation], timeout: 15)

            for side in [a, b] {
                XCTAssertTrue(side.transport.isClosed)
                XCTAssertEqual(side.recorder.closes, 1, "\(side.peerId) closed more than once")
                XCTAssertLessThanOrEqual(side.recorder.errors.count, 1,
                                         "\(side.peerId) reported more than one failure: \(side.recorder.errors)")
                XCTAssertEqual(unexpectedDuringCleanup(side.recorder.errors), [],
                               "\(side.peerId) reported something a cleanup cannot explain")
                XCTAssertNil(side.signaling.onSignal,
                             "\(side.peerId) kept the signalling slot after closing")
                XCTAssertThrowsError(try side.transport.send([1], on: .file)) {
                    XCTAssertEqual($0 as? LinkTransportError, .closed)
                }
                XCTAssertEqual(side.transport.bufferedAmount(on: .file), 0)
                XCTAssertEqual(side.transport.bufferedAmount(on: .text), 0)
            }

            // MARK: what the relay saw

            // Read AFTER both sides have closed, so it is the COMPLETE
            // transcript. Candidates trickle for as long as gathering runs, so a
            // snapshot taken while the link was live would both miss some of
            // what a relay eventually sees and make "nothing followed the close"
            // a race against the last candidate rather than an assertion.
            let transcript = bridge.transcript
            XCTAssertFalse(transcript.isEmpty)
            for signal in transcript {
                let mirroredKey = signal.from == "a"
                    ? codecsB.resumeAuthKey   // verified by the side that RECEIVED it
                    : codecsA.resumeAuthKey
                XCTAssertEqual(signal.to, signal.from == "a" ? "b" : "a",
                               "a rebuild speaks only to its own peer")
                XCTAssertTrue(parseSDP(signal.data) != nil || parseICE(signal.data) != nil,
                              "nothing but SDP and ICE leaves a rebuild: \(signal.data)")
                XCTAssertEqual(signalGeneration(signal.data), .resume,
                               "\(signal.data) is not tagged as a rebuild")
                XCTAssertTrue(resumeSignalIsAuthentic(signal.data, key: mirroredKey),
                              "\(signal.data) does not verify under the receiving side's key")
                XCTAssertNil(peerCommit(from: signal.data), "a replacement commits to nothing")
                XCTAssertNil(peerReveal(from: signal.data), "and discloses nothing")
                XCTAssertEqual(peerCaps(from: signal.data), [],
                               "and announces no capability")
                XCTAssertFalse(fields(signal.data).keys.contains("link"))
                XCTAssertFalse(fields(signal.data).keys.contains("text"))
                XCTAssertFalse(signal.text.contains(sas),
                               "the SAS never reaches the room a relay is watching")
            }
            XCTAssertEqual(transcript.filter { parseSDP($0.data)?.type == "offer" }.count, 1,
                           "exactly one offer, and only from the inherited initiator")
            XCTAssertEqual(transcript.filter { parseSDP($0.data)?.type == "answer" }.count, 1)
            XCTAssertEqual(transcript.first(where: { parseSDP($0.data)?.type == "offer" })?.from, "a")
            XCTAssertEqual(transcript.first(where: { parseSDP($0.data)?.type == "answer" })?.from, "b")
            XCTAssertFalse(transcript.filter { parseICE($0.data) != nil }.isEmpty,
                           "host candidates were trickled, so the gates were exercised")
            for side in ["a", "b"] {
                let signals = transcript.filter { $0.from == side }
                let firstSDP = signals.firstIndex { parseSDP($0.data) != nil }
                let firstICE = signals.firstIndex { parseICE($0.data) != nil }
                if let firstICE, let firstSDP {
                    XCTAssertGreaterThan(firstICE, firstSDP,
                                         "\(side) put a candidate ahead of its own description")
                }
            }

            settle()
            XCTAssertEqual(bridge.transcript.count, transcript.count,
                           "a closed rebuild says nothing more to the room")

            releasedA = a.transport
            releasedB = b.transport
        }

        // The last strong references are gone with the scope above. A transport
        // that survived it would be one whose timer, delegate or signalling
        // handler still held it — the exact shape of leak a driver that both
        // owns a PeerConnection and installs a callback into a longer-lived
        // client is prone to.
        XCTAssertTrue(poll { releasedA == nil && releasedB == nil },
                      "a closed replacement transport must not outlive its owner")
    }

    /// What the side that did NOT close sees — the exact outcome the bounded
    /// cleanup above is allowed to tolerate, forced into a fixed order so it is
    /// asserted rather than assumed.
    ///
    /// Closing A is polite, and local. B is given no way to know that: what
    /// reaches it is a published lane going `closed`, which is byte for byte
    /// what a peer that crashed, was killed or lost its network produces. This
    /// slice therefore ends the transport (`LinkEstablishment.laneStateChanged`
    /// after publication), and it must keep doing so — a link consumer that is
    /// not told holds a transport it believes is live, on codecs whose AEAD
    /// sequence has nowhere left to go. That fail-closed behaviour is the
    /// reason the cleanup above cannot demand two error-free recorders, so it
    /// is pinned here rather than worked around there.
    ///
    /// A second full negotiation is the price of asking a question the combined
    /// run genuinely cannot answer: that one closes BOTH sides, so the outcome
    /// of leaving one open is not observable in it.
    func testClosingOneSideEndsTheOtherWithExactlyOneLaneClose() throws {
        let bridge = SignalingBridge()
        let codecsA = LinkCodecs(sendKey: keyAtoB, recvKey: keyBtoA)
        let codecsB = LinkCodecs(sendKey: keyBtoA, recvKey: keyAtoB)
        let a = endpoint(peerId: "a", peer: "b", role: .initiator,
                         codecs: codecsA, bridge: bridge)
        let b = endpoint(peerId: "b", peer: "a", role: .responder,
                         codecs: codecsB, bridge: bridge)

        a.transport.start()
        b.transport.start()
        wait(for: [a.recorder.readyExpectation, b.recorder.readyExpectation], timeout: 60)

        // Both lanes carry a frame each way first, so what is lost below is a
        // pair of lanes that were demonstrably live rather than merely
        // published.
        try a.transport.send([0x01], on: .file)
        try a.transport.send([0x02], on: .text)
        try b.transport.send([0x03], on: .file)
        try b.transport.send([0x04], on: .text)
        wait(for: [a.recorder.framesExpectation, b.recorder.framesExpectation], timeout: 30)

        for side in [a, b] {
            XCTAssertTrue(side.recorder.errors.isEmpty,
                          "\(side.peerId) reported \(side.recorder.errors) before anything closed")
            XCTAssertEqual(side.recorder.closes, 0)
        }

        // ONLY A. B is never told to close, so nothing here is racing its own
        // local teardown and the outcome below is the peer's alone.
        a.transport.close()
        wait(for: [a.recorder.closedExpectation, b.recorder.closedExpectation], timeout: 30)

        // The side that closed itself reports no failure: an explicit close is
        // not one.
        XCTAssertTrue(a.recorder.errors.isEmpty,
                      "an explicit close is not a failure: \(a.recorder.errors)")
        XCTAssertEqual(a.recorder.closes, 1, "a closed more than once")
        XCTAssertTrue(a.transport.isClosed)

        // The side it left behind is told exactly once, and told precisely
        // this: whichever of the two exact lanes reached the state callback
        // first. Which one that is is genuinely undecided — both have been
        // observed — so the assertion is on the pair, not on a winner.
        XCTAssertEqual(b.recorder.errors.count, 1,
                       "the peer of a close is told once: \(b.recorder.errors)")
        let reported = try XCTUnwrap(b.recorder.errors.first as? LinkTransportError,
                                     "b reported \(b.recorder.errors), which is not a LinkTransportError")
        XCTAssertTrue(toleratedDuringCleanup.contains(reported),
                      "\(reported) is not the remote lane close a cleanup can race")

        // And it ends as completely as a side that closed itself: one close
        // callback, closed state, the signalling slot given back, and no send
        // accepted afterwards.
        XCTAssertEqual(b.recorder.closes, 1, "b closed more than once")
        XCTAssertTrue(b.transport.isClosed)
        XCTAssertNil(b.signaling.onSignal, "b kept the signalling slot after its peer left")
        XCTAssertThrowsError(try b.transport.send([1], on: .file)) {
            XCTAssertEqual($0 as? LinkTransportError, .closed)
        }
        XCTAssertEqual(b.transport.bufferedAmount(on: .file), 0)
        XCTAssertEqual(b.transport.bufferedAmount(on: .text), 0)
    }

    /// Neither constant moves on the strength of a native↔native run. Both ends
    /// here are this build's own driver, so a shared assumption would satisfy
    /// both of them; the deployed web is still unevidenced, and nothing above
    /// this driver — the atomic swap, retry orchestration, durable file
    /// recovery — exists at all.
    func testATwoEndedRunDoesNotFlipEitherSupportConstant() {
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
    }
}
