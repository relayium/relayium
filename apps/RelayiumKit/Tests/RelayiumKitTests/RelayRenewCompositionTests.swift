import XCTest
import WebRTC
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - doubles

/// An initial transport that also answers renewal's five seams, so a real
/// `LinkSessionRuntime` can compose a real renewal against it.
private final class RenewInitialTransport: LinkRoutableInitialTransport,
                                           RelayRenewLinkTransport, @unchecked Sendable {
    private let slots = NSLock()
    private let state = NSLock()

    var onSAS: ((String) -> Void)?
    var onReady: ((LinkIdentity) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set { slots.lock(); defer { slots.unlock() }; _onFrame = newValue }
    }
    var negotiatedMaxMessageBytes: Double = DEFAULT_MAX_FRAME_BYTES

    private var _sent: [(lane: LinkLane, bytes: [UInt8])] = []
    private var _closed = false

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock(); defer { state.unlock() }
        guard !_closed else { throw LinkTransportError.closed }
        _sent.append((lane, bytes))
    }
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }
    func close() { state.lock(); _closed = true; state.unlock() }
    func start() {}
    func receive(from: String, signal: JSONValue) {}

    func sent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == lane }.map(\.bytes)
    }
    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }
    func publish(_ identity: LinkIdentity) {
        onSAS?("424242")
        onReady?(identity)
    }
    func die() { close(); onClose?() }

    // ── renewal ─────────────────────────────────────────────────────────────
    var renewalBaselinePin: RelayRenewSDPPin?
    private(set) var epochInFlight = false
    private(set) var authenticatedNoted = false
    private(set) var renewalSignals: [JSONValue] = []

    private(set) var inputs: RelayRenewTransportInputs?
    private(set) var inputInstalls = 0
    func installRenewalInputs(_ inputs: RelayRenewTransportInputs?) {
        state.lock(); self.inputs = inputs; if inputs != nil { inputInstalls += 1 }; state.unlock()
    }
    func setRenewalEpochInFlight(_ inFlight: Bool) { epochInFlight = inFlight }
    func noteRenewalAuthenticated() { authenticatedNoted = true }
    func sendRenewalSignal(_ signal: JSONValue) {
        state.lock(); renewalSignals.append(signal); state.unlock()
    }
    func renewalApplyConfiguration(_ servers: [RTCIceServer],
                                   completion: @escaping (Bool) -> Void) { completion(true) }
    func renewalCreateOffer(completion: @escaping (String?) -> Void) { completion(nil) }
    func renewalCreateAnswer(completion: @escaping (String?) -> Void) { completion(nil) }
    func renewalApplyRemoteDescription(sdp: String, type: RelayRenewSDPType,
                                       completion: @escaping (Bool) -> Void) { completion(true) }
    func renewalAddRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: UInt32?) {}
}

/// A replacement transport that answers the same seams, so a `link:§8` rebuild
/// can be composed too.
private final class RenewReplacementTransport: LinkReplacementTransport, LinkLiveTransport,
                                               RelayRenewLinkTransport, @unchecked Sendable {
    private let slots = NSLock()
    var onReady: ((LinkIdentity) -> Void)?
    var onError: ((Error) -> Void)?
    var onClose: (() -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set { slots.lock(); defer { slots.unlock() }; _onFrame = newValue }
    }
    var negotiatedMaxMessageBytes: Double = DEFAULT_MAX_FRAME_BYTES
    private var _closed = false

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        if _closed { throw LinkTransportError.closed }
    }
    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { _closed }
    func close() { _closed = true }
    func start() {}
    func receive(from: String, signal: JSONValue) {}
    func publish(_ identity: LinkIdentity) { onReady?(identity) }

    var renewalBaselinePin: RelayRenewSDPPin?
    private(set) var inputs: RelayRenewTransportInputs?
    func installRenewalInputs(_ inputs: RelayRenewTransportInputs?) { self.inputs = inputs }
    func setRenewalEpochInFlight(_ inFlight: Bool) {}
    func noteRenewalAuthenticated() {}
    func sendRenewalSignal(_ signal: JSONValue) {}
    func renewalApplyConfiguration(_ servers: [RTCIceServer],
                                   completion: @escaping (Bool) -> Void) { completion(true) }
    func renewalCreateOffer(completion: @escaping (String?) -> Void) { completion(nil) }
    func renewalCreateAnswer(completion: @escaping (String?) -> Void) { completion(nil) }
    func renewalApplyRemoteDescription(sdp: String, type: RelayRenewSDPType,
                                       completion: @escaping (Bool) -> Void) { completion(true) }
    func renewalAddRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: UInt32?) {}
}

/// Everything the seam was told, in order, from whatever thread told it.
private final class SeamRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _published: [(RelayRenewLinkTransport, RelayRenewLanes, LinkIdentity)] = []
    private var _userData: [RelayRenewUserData] = []
    private var _ended: [LinkIdentity] = []

    var published: [(RelayRenewLinkTransport, RelayRenewLanes, LinkIdentity)] {
        lock.lock(); defer { lock.unlock() }; return _published
    }
    var userData: [RelayRenewUserData] {
        lock.lock(); defer { lock.unlock() }; return _userData
    }
    var ended: [LinkIdentity] { lock.lock(); defer { lock.unlock() }; return _ended }

    func seam() -> LinkRenewalSeam {
        LinkRenewalSeam(
            published: { [weak self] transport, lanes, identity in
                guard let self else { return }
                self.lock.lock(); self._published.append((transport, lanes, identity))
                self.lock.unlock()
            },
            userData: { [weak self] kind in
                guard let self else { return }
                self.lock.lock(); self._userData.append(kind); self.lock.unlock()
            },
            ended: { [weak self] identity in
                guard let self else { return }
                self.lock.lock(); self._ended.append(identity); self.lock.unlock()
            })
    }
}

private final class CompositionScheduler: LinkRecoveryScheduler, @unchecked Sendable {
    private final class Handle: LinkRecoveryTimer {
        var cancelled = false
        let body: () -> Void
        init(_ body: @escaping () -> Void) { self.body = body }
        func cancel() { cancelled = true }
    }
    private let lock = NSLock()
    private var handles: [Handle] = []
    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        let handle = Handle(body)
        lock.lock(); handles.append(handle); lock.unlock()
        return handle
    }
    func fireAll() {
        lock.lock()
        let live = handles.filter { !$0.cancelled }
        handles.removeAll()
        lock.unlock()
        for handle in live { handle.body() }
    }
}

/// The renewal composition, exercised through the REAL `LinkSessionRuntime`,
/// the REAL `LinkLaneOwner` and the REAL frame routing.
///
/// This suite exists because the previous checkpoint's hooks compiled, were
/// tested in isolation, and were never called by anything: `attachRenewal` and
/// `noteLinkUserData` each had exactly one definition and no caller under
/// `Sources`, so no actual app would ever have renewed. Every test here
/// therefore asserts on a callback that a production object made, not on a
/// function this test called.
final class RelayRenewCompositionTests: XCTestCase {
    private var dir: URL!
    private let sendKey = [UInt8](repeating: 0x11, count: 32)
    private let recvKey = [UInt8](repeating: 0x22, count: 32)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("renew-composition-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private struct Rig {
        let runtime: LinkSessionRuntime
        let transport: RenewInitialTransport
        let identity: LinkIdentity
        let codecs: LinkCodecs
        let peer: RealtimeSender
        let seam: SeamRecorder
        let scheduler: CompositionScheduler
        let replacement: RenewReplacementTransport
    }

    private func rig(role: Role = .initiator) -> Rig {
        let codecs = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: role, sas: "424242",
                                    codecs: codecs, authenticationGeneration: 2)
        let transport = RenewInitialTransport()
        let seam = SeamRecorder()
        let scheduler = CompositionScheduler()
        let replacement = RenewReplacementTransport()
        let admission = LinkAdmission(selfId: { "peer-a" }, supportsLink: { _ in true })
        admission.didBeginEstablishing(peerId: identity.peerId, role: role)
        let runtime = LinkSessionRuntime(
            establishing: transport,
            receiveDirectory: dir,
            scheduler: scheduler,
            replacementFactory: { _ in replacement },
            admission: admission,
            holdsRecoveryWindow: true,
            renewal: seam.seam(),
            onEvent: { _ in })
        return Rig(runtime: runtime, transport: transport, identity: identity, codecs: codecs,
                   peer: RealtimeSender(sessionKey: recvKey), seam: seam,
                   scheduler: scheduler, replacement: replacement)
    }

    private func opened(_ r: Rig) {
        r.runtime.start()
        r.transport.publish(r.identity)
        r.runtime.settle()
    }

    // MARK: - A1: the composition actually happens

    /// Publishing a link hands renewal the REAL transport, the REAL lane owner
    /// and the authenticated identity.
    ///
    /// The identity check is the one that matters: `resumeAuthKey` is reached
    /// through `identity.codecs`, and a composition that handed over anything
    /// but the link's own codecs would sign renewal with a key the peer cannot
    /// verify.
    func testPublishingALinkComposesRenewalWithTheLiveTransportAndLanes() throws {
        let r = rig()
        XCTAssertTrue(r.seam.published.isEmpty, "nothing is composed before publication")

        opened(r)

        XCTAssertEqual(r.seam.published.count, 1, "exactly one composition per published link")
        let (transport, lanes, identity) = try XCTUnwrap(r.seam.published.first)
        XCTAssertTrue(transport === r.transport, "the LIVE transport, not a copy")
        XCTAssertTrue(identity.codecs === r.codecs, "the link's own codecs, so its own key")
        XCTAssertEqual(identity.peerId, "peer-b")
        XCTAssertEqual(identity.role, .initiator)
        XCTAssertNotNil(lanes.renewDemux, "the text lane's front demux is installed")
    }

    /// The lane owner handed over is the one actually routing this link's
    /// frames — provable by sending a control frame through the transport and
    /// seeing it arrive at that owner's demux.
    func testTheComposedLanesAreTheOnesRoutingThisLinksFrames() throws {
        let r = rig()
        opened(r)
        let (_, lanes, _) = try XCTUnwrap(r.seam.published.first)

        let seen = LockedBox<RelayRenewProbeFrame?>(nil)
        lanes.renewDemux.install { seen.value = $0 }

        let frame = try XCTUnwrap(relayRenewProbeFrame(
            type: .probe, epoch: 7, round: 3,
            nonce: [UInt8](repeating: 0xAB, count: 16),
            tag: [UInt8](repeating: 0xCD, count: 32)))
        r.transport.deliver(.text, frame)
        r.runtime.settle()

        let received = try XCTUnwrap(seen.value, "the control frame must reach the composed demux")
        XCTAssertEqual(received.epoch, 7)
        XCTAssertEqual(received.round, 3)
    }

    /// A `link:§8` rebuild composes again, under the SAME authentication.
    ///
    /// Same-authentication is what lets the room keep ONE controller and one
    /// epoch counter across the rebuild — see
    /// `LinkWorkspaceModel.isSameAuthentication`. A rebuild reported as a new
    /// authentication would reset that counter to zero and make an aborted
    /// epoch's signed messages replayable into the next attempt.
    func testARebuildComposesAgainUnderTheSameAuthentication() throws {
        let r = rig()
        opened(r)
        XCTAssertEqual(r.seam.published.count, 1)

        // Give the link something worth holding, then lose the transport.
        for frame in try r.peer.batchFrames([FileMeta(name: "held.bin", size: 2 * CHUNK_SIZE)]) {
            r.transport.deliver(.file, frame)
        }
        r.runtime.settle()
        r.runtime.acceptInboundBatch()
        r.runtime.settle()
        r.transport.die()
        r.runtime.settle()
        r.replacement.publish(r.identity.replacingTransport())
        r.runtime.settle()

        XCTAssertEqual(r.seam.published.count, 2, "a rebuild is composed too")
        let rebuilt = try XCTUnwrap(r.seam.published.last)
        XCTAssertTrue(rebuilt.0 === r.replacement, "and it carries the REBUILT transport")
        XCTAssertTrue(rebuilt.2.codecs === r.codecs,
                      "the same LinkCodecs object — the same authentication")
        XCTAssertEqual(rebuilt.2.authenticationGeneration,
                       r.identity.authenticationGeneration)
    }

    /// The link ending reaches renewal exactly once, and before the lanes go.
    func testTheLinkEndingReachesRenewalOnce() {
        let r = rig()
        opened(r)
        r.runtime.stop()
        r.runtime.settle()
        XCTAssertEqual(r.seam.ended.count, 1)
        XCTAssertEqual(r.seam.ended.first?.peerId, "peer-b")

        r.runtime.stop()
        r.runtime.settle()
        XCTAssertEqual(r.seam.ended.count, 1, "idempotent")
    }

    /// An unpublished link never composes and never reports an end for one.
    func testAnUnpublishedLinkComposesNothing() {
        let r = rig()
        r.runtime.start()
        r.runtime.stop()
        r.runtime.settle()
        XCTAssertTrue(r.seam.published.isEmpty)
        XCTAssertTrue(r.seam.ended.isEmpty)
    }

    // MARK: - A1: the user-data hook is actually invoked

    /// Real inbound file bytes move the renewal clock, through the production
    /// lane event — not through a test calling `record` directly.
    func testRealInboundFileProgressReportsUserData() throws {
        let r = rig()
        opened(r)
        XCTAssertTrue(r.seam.userData.isEmpty)

        // The manifest and the bytes describe the SAME file: a receiver that
        // was promised one size and handed another fails the batch, and this
        // test would then be asserting about a failure rather than progress.
        let data = [UInt8](repeating: 7, count: 1024)
        let meta = FileMeta(name: "a.bin", size: data.count)
        for frame in try r.peer.batchFrames([meta]) {
            r.transport.deliver(.file, frame)
        }
        r.runtime.settle()
        XCTAssertTrue(r.seam.userData.isEmpty,
                      "an OFFER is a pending consent, and a pending consent is not activity")

        r.runtime.acceptInboundBatch()
        r.runtime.settle()
        for frame in try r.peer.dataFrames([(meta: meta, data: data)]) {
            r.transport.deliver(.file, frame)
        }
        r.runtime.settle()
        XCTAssertTrue(r.seam.userData.contains(.fileBytes),
                      "actual bytes arriving are activity")
    }

    /// A received text message moves the clock; the conversation lifecycle
    /// around it does not.
    func testRealTextTrafficReportsUserDataButLifecycleDoesNot() throws {
        let r = rig()
        opened(r)

        // REQUEST/ACCEPT are one-byte lifecycle controls. They open a
        // conversation; they are not somebody using it.
        r.transport.deliver(.text, [LINK_TEXT_REQUEST])
        r.runtime.settle()
        XCTAssertTrue(r.seam.userData.isEmpty, "a conversation request is not activity")

        try r.runtime.acceptTextConversation()
        r.runtime.settle()
        XCTAssertTrue(r.seam.userData.isEmpty, "nor is consenting to one")

        let sender = RealtimeTextSender()
        let frame = try sender.frame(body: "hello", key: deriveTextKey(sessionKey: recvKey))
        r.transport.deliver(.text, frame)
        r.runtime.settle()
        XCTAssertEqual(r.seam.userData, [.textReceived], "a message is")
    }

    /// Sending a message moves the clock — and only when the lane took it.
    ///
    /// There is no lane EVENT for a successful send, which is exactly why this
    /// is reported from the command path; a composition that waited for an
    /// event would never count outbound text at all.
    func testSendingTextReportsUserDataOnlyWhenItWasAccepted() throws {
        let r = rig()
        opened(r)
        r.transport.deliver(.text, [LINK_TEXT_REQUEST])
        r.runtime.settle()
        try r.runtime.acceptTextConversation()
        r.runtime.settle()

        try r.runtime.sendText("hello")
        r.runtime.settle()
        XCTAssertEqual(r.seam.userData, [.textSent])

        // A refused send moves nothing: queued-but-unsent work is not activity.
        r.runtime.stop()
        r.runtime.settle()
        XCTAssertThrowsError(try r.runtime.sendText("after the end"))
        XCTAssertEqual(r.seam.userData, [.textSent], "a refusal is not activity")
    }

    /// Renewal's own control frames are consumed by the front demux and never
    /// reach the text lane, so they can never be counted as activity.
    ///
    /// This is invariant 2 of the activity policy, proved against the real
    /// routing rather than argued: the frame goes in through the transport and
    /// the seam records nothing.
    func testRenewalControlFramesAreNeverUserActivity() throws {
        let r = rig()
        opened(r)
        r.transport.deliver(.text, [LINK_TEXT_REQUEST])
        r.runtime.settle()
        try r.runtime.acceptTextConversation()
        r.runtime.settle()

        let frame = try XCTUnwrap(relayRenewProbeFrame(
            type: .probe, epoch: 1, round: 1,
            nonce: [UInt8](repeating: 0xAB, count: 16),
            tag: [UInt8](repeating: 0xCD, count: 32)))
        for _ in 0..<50 { r.transport.deliver(.text, frame) }
        r.runtime.settle()

        XCTAssertTrue(r.seam.userData.isEmpty,
                      "a probe must never reset the ten-minute idle clock")
    }

    /// The demux is a TRUE front cut: a claimed frame does not also reach the
    /// text session, so it cannot poison the codec or spend a budget.
    ///
    /// Proved by continuing to use the conversation afterwards — a text lane
    /// that had admitted fifty unroutable frames would have failed closed, and
    /// this message would not arrive.
    func testAClaimedControlFrameDoesNotDisturbTheTextLane() throws {
        let r = rig()
        opened(r)
        r.transport.deliver(.text, [LINK_TEXT_REQUEST])
        r.runtime.settle()
        try r.runtime.acceptTextConversation()
        r.runtime.settle()

        let control = try XCTUnwrap(relayRenewProbeFrame(
            type: .ack, epoch: 9, round: 9,
            nonce: [UInt8](repeating: 0x01, count: 16),
            tag: [UInt8](repeating: 0x02, count: 32)))
        for _ in 0..<50 { r.transport.deliver(.text, control) }
        r.runtime.settle()

        let sender = RealtimeTextSender()
        let frame = try sender.frame(body: "still here", key: deriveTextKey(sessionKey: recvKey))
        r.transport.deliver(.text, frame)
        r.runtime.settle()
        XCTAssertEqual(r.seam.userData, [.textReceived],
                       "the conversation survived the control traffic intact")
    }

    /// A composition with no renewal seam behaves exactly as it always did.
    ///
    /// This is what keeps the headless acceptance hosts and every unrelated
    /// test honest: renewal is additive, and a build that does not compose it
    /// must not change behaviour.
    func testACompositionWithoutRenewalIsUnchanged() throws {
        let codecs = LinkCodecs(sendKey: sendKey, recvKey: recvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "424242",
                                    codecs: codecs, authenticationGeneration: 2)
        let transport = RenewInitialTransport()
        let admission = LinkAdmission(selfId: { "peer-a" }, supportsLink: { _ in true })
        admission.didBeginEstablishing(peerId: identity.peerId, role: .initiator)
        let runtime = LinkSessionRuntime(
            establishing: transport,
            receiveDirectory: dir,
            scheduler: CompositionScheduler(),
            replacementFactory: { _ in RenewReplacementTransport() },
            admission: admission,
            onEvent: { _ in })
        runtime.start()
        transport.publish(identity)
        runtime.settle()
        transport.deliver(.text, [LINK_TEXT_REQUEST])
        runtime.settle()
        try runtime.acceptTextConversation()
        runtime.settle()
        XCTAssertNoThrow(try runtime.sendText("hello"))
        runtime.stop()
    }
}

private extension LinkSessionRuntime {
    /// Barrier: returns once every step both lanes dispatched off their own
    /// locks has run. `LinkLaneOwner`'s own test barrier, reached through the
    /// runtime so a test does not have to hold the owner.
    func settle() { owner?.settle() }
}
