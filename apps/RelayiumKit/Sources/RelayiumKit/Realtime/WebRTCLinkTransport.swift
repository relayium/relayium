import Foundation
import os
import WebRTC

/// Adapts one `RTCDataChannel` to the `LinkLaneChannel` seam.
///
/// A wrapper rather than a conformance on `RTCDataChannel` itself: a retroactive
/// public conformance on an imported class would make every `RTCDataChannel` in
/// the process a link lane as far as the type system is concerned, including the
/// legacy `data` channel `RealtimeConnection` opens — which is the one thing the
/// exact-label rule exists to prevent anybody from doing by accident.
final class RTCLinkLane: LinkLaneChannel {
    let channel: RTCDataChannel

    init(_ channel: RTCDataChannel) { self.channel = channel }

    var laneLabel: String { channel.label }
    var laneIsOpen: Bool { channel.readyState == .open }
    var laneIsTerminal: Bool {
        channel.readyState == .closing || channel.readyState == .closed
    }
    var laneBufferedAmount: UInt64 { channel.bufferedAmount }

    @discardableResult
    func laneSend(_ bytes: [UInt8]) -> Bool {
        channel.sendData(RTCDataBuffer(data: Data(bytes), isBinary: true))
    }

    func laneClose() { channel.close() }
}

/// A production WebRTC driver for ONE initial `link/1` establishment.
///
/// One `RTCPeerConnection` and one commit/reveal handshake produce one link
/// identity carrying two reliable ordered lanes: `relayium` (files) and
/// `relayium-text` (messages). The initiator creates both channels before it
/// makes its offer, so one negotiation carries both; the responder collects
/// exactly those two by label, in whatever order DCEP delivers them.
///
/// ## Where the logic actually lives
///
/// Almost nowhere in this file. Admission and the deterministic role are
/// `LinkAdmission`'s; which signals may be acted on is `LinkSignalPolicy`'s;
/// the channel set, the publication barrier, pre-attachment capture and send
/// readiness are `LinkEstablishment`'s; SDP/ICE ordering is
/// `LinkCandidateGate`'s; when an unfinished establishment must give up is
/// `LinkEstablishmentWatchdog`'s; the re-entrancy rules of the private queue are
/// `LinkTransportQueue`'s; the wire vocabulary is `LinkProtocol`'s; the codecs
/// are `LinkCodecs`'. This class is the part that genuinely cannot be
/// unit-tested — SDP, ICE and DCEP against a live peer — and it is kept as close
/// to mechanical as that split allows. That is deliberate: `RealtimeConnection`
/// welded the same decisions to WebRTC and is, by its own header,
/// integration-tested only.
///
/// ## Threading
///
/// Every WebRTC delegate callback, every inbound signal and every public call
/// serializes on this transport's private serial queue. **Every client callback
/// (`onSAS`, `onReady`, `onFrame`, `onError`, `onClose`) fires on that queue** —
/// never on a WebRTC-internal thread and never assumed to be the main thread.
/// Hop to your own queue before touching UI. Calling `send`, `bufferedAmount`,
/// `isClosed` or `close` from inside a callback is safe: `LinkTransportQueue`
/// detects that the caller is already on the queue and runs inline rather than
/// deadlocking or deferring.
///
/// `close()` from a callback takes effect BEFORE that callback returns. That is
/// not a convenience: a consumer that closes from `onSAS` must not then have its
/// reveal sent for it, and one that closes from `onReady` must not then be
/// handed the captured backlog.
///
/// ## Ordering against the peer
///
/// Local candidates are held until the offer or answer they belong to has
/// actually been sent, and remote candidates are held until the description
/// they need has actually been applied — both FIFO, both bounded, both failing
/// closed on overflow. Neither ordering is optional; see `LinkCandidateGate`
/// for what each one costs when it is left to chance.
///
/// ## Deadlines
///
/// An establishment that stops making progress ends by itself. Three deadlines,
/// matching the deployed web client: a 90 s hard cap that nothing re-arms, a
/// 30 s no-progress deadline re-armed only by the closed `LinkMilestone` set,
/// and a 30 s key-reveal deadline that takes over — replacing the no-progress
/// one, never racing it — once both lanes are open while no identity exists.
/// All three are decided by `LinkEstablishmentWatchdog`; this class only owns
/// the single `DispatchWorkItem` that wakes it. Every guard below that can
/// refuse to make progress is therefore bounded by the hard cap rather than
/// silent — a candidate transport can no longer sit inert forever waiting for
/// an owner that never calls `close()`.
///
/// The clock belongs to this establishment, so only this establishment's own
/// work starts it: `start()`, or the first inbound signal `LinkSignalPolicy`
/// will actually act on. Everything else in a room — a stranger's signal,
/// another generation, admission's own vocabulary — is inert here and leaves an
/// unstarted transport unstarted.
///
/// Every event is checked against the deadline BEFORE it is allowed to count as
/// progress, because a queued work item is not a promise about time: a client
/// callback that ran long, or a device that suspended, can deliver an event
/// after the bound it was racing has gone. Such an event fails the transport
/// closed rather than re-arming it.
///
/// "Event" includes the far side of every suspension point, not just the arrival
/// of a signal: an asynchronous WebRTC completion and the return of a client
/// callback are both places where the queue is handed back after an unbounded
/// amount of time, and the wake-up cannot run while the queue is held. So the
/// clock is re-read after `onSAS`, after `pc.offer`/`pc.answer` and after each
/// `setLocalDescription`, and nothing that would continue an establishment —
/// applying or sending a description, opening a candidate gate, disclosing a
/// reveal, publishing — runs on the other side of an expired one.
///
/// ## Attaching lane consumers
///
/// Frames the peer sends before publication are captured under
/// `LINK_CAPTURE_MAX_BYTES` and replayed per-lane FIFO at publication. The
/// replay runs immediately AFTER `onReady` returns and before this queue does
/// anything else, so both attachment points are safe: setting `onFrame` before
/// `start()`, or setting it from inside `onReady` — which is the natural place
/// for an owner that only builds its lane consumers once it has the identity
/// those consumers need. Attaching later than that misses the backlog.
///
/// ## What this slice is NOT, and what remains gated
///
/// This is establishment only. It is a reusable driver a later checkpoint
/// integrates; it is not wired to anything today and claims nothing about the
/// workflows above it. Still open, and each one a separate piece of work:
///
///  - **Admission/factory integration.** Nothing constructs this class. The
///    Nearby UI, the session factory and `LinkAdmission`'s lifecycle callbacks
///    (`didBeginEstablishing`/`didOpen`/`didFail`) are still unwired, and
///    `LINK_BUILD_SUPPORT` remains false so no peer is ever told this build
///    speaks `link/1`.
///  - **Authenticated replacement and durable active-file recovery.** Not
///    implemented, and refused rather than half-done: the `resume` generation is
///    ignored and `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` is false. A dropped
///    lane here ends the transport; it does not hold an authentication open.
///  - **Poisoned-lane replacement closure.** `LinkTextLane` can prove its
///    codecs unsafe to reuse; deciding what a link does about that — and how a
///    replacement transport inherits it — is not answered here.
///  - **END acknowledgement timing.** The lane's ordering barrier and its
///    timeout are the lane's; this transport neither drives nor observes them.
///  - **Workspace UI and iOS lifecycle.** No presentation, no background/
///    foreground handling, no lease behaviour when the app is suspended. The
///    deadlines above are measured on the uptime clock, which does not advance
///    while the device is asleep; what a suspended app should do about a
///    half-built link is part of that unwritten lifecycle work.
///  - **Live evidence.** No native↔native and no native↔Web run has been made
///    against this driver. Nothing in this repository yet demonstrates
///    interoperability for `link/1`; the unit tests cover the orchestration
///    seams, not the wire.
public final class WebRTCLinkTransport: NSObject {
    private static let log = Logger(subsystem: "com.relayium", category: "link")

    // MARK: - client callbacks (all fire on `queue`)

    /// The six digits both users compare, the instant the peer's reveal is
    /// verified — before the transport is published, exactly as the legacy
    /// connection does, so a user can start comparing while the lanes finish
    /// opening.
    public var onSAS: ((String) -> Void)?
    /// Both exact lanes are open and the link is authenticated. Fires at most
    /// once, and carries the identity that owns the link's one `LinkCodecs`.
    public var onReady: ((LinkIdentity) -> Void)?
    /// One raw frame off one exact lane. Deliberately raw: what the bytes mean
    /// is `LinkTextLane`'s and the file lane's policy, not a transport's.
    public var onFrame: ((LinkLane, [UInt8]) -> Void)?
    /// Fires at most once, and only for a failure. By the time it runs this
    /// transport is already closed: teardown happens first, so the callback
    /// cannot send, cannot be re-entered, and cannot nest `onClose` inside
    /// itself.
    public var onError: ((Error) -> Void)?
    /// Fires at most once, whatever ended the transport, and always last.
    public var onClose: (() -> Void)?

    // MARK: - wiring

    private let signaling: SignalingClient
    private let peerId: String
    private let role: Role
    private let authenticationGeneration: Int
    private let handshake: HandshakeState
    private let policy: LinkSignalPolicy
    private let establishment: LinkEstablishment
    private let deadlines: LinkDeadlines
    /// Monotonic, and injectable so the deadline wiring can be exercised at
    /// millisecond scale. `systemUptime` rather than a wall clock: a user
    /// changing the date must not be able to expire a live establishment, and it
    /// is the same clock `DispatchQueue.asyncAfter` schedules against.
    private let now: () -> TimeInterval

    private let queue: LinkTransportQueue

    private let factory: RTCPeerConnectionFactory
    private var pc: RTCPeerConnection?
    /// Every channel this transport has ever set a delegate on, including ones
    /// `LinkEstablishment` rejected. Teardown walks this list, so a rejected
    /// channel cannot keep calling back into a closed transport.
    private var delegatedChannels: [RTCDataChannel] = []

    // MARK: - state guarded by `queue`

    private var started = false
    private var revealSent = false
    private var closed = false
    /// Which installation of the signalling slot is ours. Written in `init`
    /// before any other thread can reach this object, and cleared by teardown —
    /// it is a value type carrying no reference back to the client, which is
    /// exactly why `deinit` may still read it.
    private var signalToken: SignalHandlerToken?

    private var localCandidates = LinkCandidateGate<RTCIceCandidate>()
    private var remoteCandidates = LinkCandidateGate<RTCIceCandidate>()

    private var watchdog: LinkEstablishmentWatchdog?
    private var watchdogTimer: DispatchWorkItem?
    /// Which scheduling of the wake-up is current. A work item that was already
    /// dispatched when a milestone rescheduled it cannot be cancelled any more,
    /// so it has to be able to recognise that it is stale.
    private var watchdogGeneration = 0

    /// - Parameters:
    ///   - role: the deterministic role `LinkAdmission` decided (`linkRole`'s
    ///     smaller-id-offers rule). Never a preference of this transport's: two
    ///     initiators put two offers into one pair of lanes.
    ///   - authenticationGeneration: the owner's identity for THIS
    ///     authentication step, so a stale async result can never be accepted by
    ///     a later link to the same peer.
    ///   - deadlines: the three establishment deadlines. Defaults are the
    ///     deployed web client's; overriding them is for tests.
    public init(signaling: SignalingClient,
                peerId: String,
                role: Role,
                iceServers: [RTCIceServer],
                iceTransportPolicy: RTCIceTransportPolicy = .all,
                authenticationGeneration: Int = 0,
                capture: LinkFrameCapture = LinkFrameCapture(),
                deadlines: LinkDeadlines = LinkDeadlines(),
                now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.signaling = signaling
        self.peerId = peerId
        self.role = role
        self.authenticationGeneration = authenticationGeneration
        self.handshake = HandshakeState(role: role)
        self.policy = LinkSignalPolicy(peerId: peerId, role: role)
        self.establishment = LinkEstablishment(capture: capture)
        self.deadlines = deadlines
        self.now = now
        self.queue = LinkTransportQueue(label: "im.relayium.WebRTCLinkTransport")
        ensureRTCSSL()
        self.factory = RTCPeerConnectionFactory()
        super.init()

        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        config.iceTransportPolicy = iceTransportPolicy
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        self.pc = factory.peerConnection(with: config, constraints: constraints, delegate: self)

        // Claimed with a token rather than by assigning `onSignal`, for the
        // hazard `SignalHandlerToken` documents: two connections overlap on one
        // socket routinely, and a closing older one must not be able to erase a
        // NEWER one's handler — the new session would then wait forever for an
        // answer nobody routes to it.
        self.signalToken = signaling.installSignalHandler { [weak self] from, data in
            guard let self else { return }
            self.queue.later { self.handleLocked(from: from, signal: data) }
        }
    }

    // MARK: - start

    /// Initiator: opens both lanes and offers. Responder: nothing but the
    /// deadlines — its lanes arrive through `didOpen` once the initiator's offer
    /// has been answered.
    ///
    /// Idempotent: a second call does nothing rather than opening a second pair
    /// of channels into the same connection.
    public func start() {
        queue.later { [weak self] in self?.startLocked() }
    }

    /// Hand this transport a signal that was routed elsewhere first — the offer
    /// `LinkAdmission` consumed to decide this establishment should exist at
    /// all, and the candidates that chased it.
    ///
    /// Safe to call for a signal the installed handler will also deliver: the
    /// policy applies exactly one remote offer and one remote answer, so the
    /// duplicate is dropped whole rather than reaching `setRemoteDescription` a
    /// second time.
    public func receive(from: String, signal: JSONValue) {
        queue.later { [weak self] in self?.handleLocked(from: from, signal: signal) }
    }

    private func startLocked() {
        guard !closed, !started else { return }
        started = true
        // ONE reading for this whole decision. Two would let the deadline a
        // milestone is measured from differ from the one it was checked
        // against, which is exactly the gap a late event lives in.
        let now = self.now()
        // Before the first thing that can go wrong, so that even a transport
        // whose PeerConnection never existed reports rather than lingers.
        armWatchdogLocked(at: now)
        // A nil `pc` means `RTCPeerConnectionFactory` refused to build one. It
        // is not a reason to sit still: without this the transport would be
        // started, silent, and waiting for a peer it has nothing to talk to.
        guard let pc else {
            failLocked(LinkTransportError.notReady)
            return
        }
        guard role == .initiator else { return }

        // BOTH lanes before the offer, so one negotiation carries both and the
        // responder is never asked to wait for a second round of DCEP it has no
        // reason to expect. Reliable and ordered: `maxRetransmits` and
        // `maxPacketLifeTime` are deliberately left unset, which is what makes
        // the channel reliable — an AEAD sequence cannot tolerate a hole.
        for label in LINK_CHANNEL_LABELS {
            let config = RTCDataChannelConfiguration()
            config.isOrdered = true
            guard let channel = pc.dataChannel(forLabel: label, configuration: config) else {
                failLocked(LinkTransportError.notReady)
                return
            }
            collectLocked(channel, at: now)
            guard !closed else { return }
        }

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc.offer(for: constraints) { [weak self] sdp, error in
            guard let self else { return }
            self.queue.later {
                guard !self.closed else { return }
                guard let sdp, error == nil else {
                    self.failLocked(error ?? LinkTransportError.notReady)
                    return
                }
                // A fresh event boundary. Producing an offer is asynchronous, so
                // this block is a separate queue item and the deadline may have
                // gone while it was in flight — and the wake-up that would have
                // reported it cannot run while this queue is busy. An expired
                // establishment applies no local description.
                guard !self.expiredLocked(at: self.now()) else { return }
                pc.setLocalDescription(sdp) { [weak self] error in
                    guard let self else { return }
                    self.queue.later {
                        guard !self.closed else { return }
                        if let error {
                            self.failLocked(error)
                            return
                        }
                        // The same boundary, at the point it costs the most:
                        // past this line the offer is on the wire and the local
                        // candidate gate is open, which is an establishment
                        // continuing after its bound.
                        guard !self.expiredLocked(at: self.now()) else { return }
                        self.sendLocked(linkSDPSignal(kind: "offer",
                                                      sdp: sdp.sdp,
                                                      commit: self.handshake.selfCommitBase64,
                                                      caps: [LINK_CAPABILITY]))
                        self.localDescriptionSentLocked()
                    }
                }
            }
        }
    }

    private func createAndSendAnswerLocked() {
        guard !closed else { return }
        guard let pc else {
            failLocked(LinkTransportError.notReady)
            return
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc.answer(for: constraints) { [weak self] sdp, error in
            guard let self else { return }
            self.queue.later {
                guard !self.closed else { return }
                guard let sdp, error == nil else {
                    self.failLocked(error ?? LinkTransportError.notReady)
                    return
                }
                // The same fresh boundary as the offer path: an answer produced
                // after this establishment's deadline is not an answer, and the
                // queue it comes back on is the one the wake-up was waiting for.
                guard !self.expiredLocked(at: self.now()) else { return }
                pc.setLocalDescription(sdp) { [weak self] error in
                    guard let self else { return }
                    self.queue.later {
                        guard !self.closed else { return }
                        if let error {
                            self.failLocked(error)
                            return
                        }
                        // And again where it decides whether anything leaves:
                        // the answer below and the gate after it must not
                        // continue an establishment that is out of time.
                        guard !self.expiredLocked(at: self.now()) else { return }
                        // The peer's commit is already on file — the policy
                        // ordered `recordPeerCommit` ahead of the offer that
                        // brought us here — so sending ours now cannot be a
                        // commitment chosen after seeing theirs.
                        self.sendLocked(linkSDPSignal(kind: "answer",
                                                      sdp: sdp.sdp,
                                                      commit: self.handshake.selfCommitBase64,
                                                      caps: [LINK_CAPABILITY]))
                        self.localDescriptionSentLocked()
                    }
                }
            }
        }
    }

    // MARK: - local ICE ordering (always on `queue`)

    /// The offer or the answer is on the wire. Everything gathered while it was
    /// being produced may now follow it, in the order it was gathered.
    ///
    /// One call site per role, and the gate is idempotent, so exactly one
    /// initial description opens it either way.
    private func localDescriptionSentLocked() {
        for candidate in localCandidates.open() { sendCandidateLocked(candidate) }
    }

    private func localCandidateLocked(_ candidate: RTCIceCandidate) {
        guard !closed else { return }
        // The same boundary every other event goes through, so "every event
        // boundary is checked" is true rather than nearly true. Free after
        // publication — the barrier disarms the watchdog, so `expiry` is nil and
        // trickling continues untouched — and before it, emitting a candidate
        // for a link that is already out of time only asks a peer that has
        // given up to keep gathering.
        guard !expiredLocked(at: now()) else { return }
        switch localCandidates.admit(candidate) {
        case .send:
            sendCandidateLocked(candidate)
        case .hold:
            break
        case .overflow:
            failLocked(LinkTransportError.pendingCandidateOverflow(.local))
        }
    }

    private func sendCandidateLocked(_ candidate: RTCIceCandidate) {
        sendLocked(taggedSignal(
            iceSignal(candidate.sdp,
                      sdpMid: candidate.sdpMid,
                      sdpMLineIndex: candidate.sdpMLineIndex),
            generation: .link
        ))
    }

    // MARK: - signals (always on `queue`)

    private func handleLocked(from: String, signal: JSONValue) {
        guard !closed else { return }
        // The plan decides whether this signal is this establishment's business
        // AT ALL, and it is therefore computed before anything else happens.
        // A room is a broadcast surface: a stranger's signal, a generation that
        // is not ours, admission's own request/leave vocabulary and a roster
        // caps hello all arrive here and are all inert. Arming ahead of this
        // filter put every transport in the room on a deadline that traffic
        // between two OTHER peers had started, and then killed it.
        let plan = policy.plan(from: from, signal: signal)
        guard !plan.isEmpty else { return }
        let now = self.now()
        // A responder can be handed the offer that created it before anybody
        // calls `start()`. Arming here as well is what keeps that path bounded.
        armWatchdogLocked(at: now)
        // The signal is ours, but it may have reached this queue after the
        // deadline it was racing. Acting on it would extend an establishment
        // that has already exceeded its bound.
        guard !expiredLocked(at: now) else { return }
        guard pc != nil else {
            failLocked(LinkTransportError.notReady)
            return
        }
        for action in plan {
            guard !closed else { return }
            switch action {
            case let .recordPeerCommit(commit):
                // A commit that will not decode is not worth failing on by
                // itself: the reveal it belongs to cannot verify against
                // anything, and `verifyPeerReveal` fails the link there with the
                // reason that actually applies.
                try? handshake.recordPeerCommit(commit)
            case let .applyRemoteOffer(sdp):
                setRemoteLocked(RTCSessionDescription(type: .offer, sdp: sdp),
                                milestone: .remoteOffer) { [weak self] in
                    self?.createAndSendAnswerLocked()
                }
            case let .applyRemoteAnswer(sdp):
                setRemoteLocked(RTCSessionDescription(type: .answer, sdp: sdp),
                                milestone: .remoteAnswer) { [weak self] in
                    // The initiator now holds the responder's commit, so it is
                    // safe to disclose the real key.
                    self?.sendRevealLocked()
                }
            case let .addRemoteCandidate(candidate, sdpMid, sdpMLineIndex):
                // The policy has already refused everything from a peer whose
                // `link/1` is unconfirmed, so nothing reaching here — including
                // nothing that will be counted as progress — comes from an
                // unconfirmed peer.
                remoteCandidateLocked(RTCIceCandidate(sdp: candidate,
                                                      sdpMLineIndex: sdpMLineIndex ?? 0,
                                                      sdpMid: sdpMid))
            case let .verifyPeerReveal(reveal):
                verifyRevealLocked(reveal, at: now)
            case let .fail(error):
                failLocked(error)
                return
            }
        }
    }

    /// Apply one remote description, then release the candidates that were
    /// waiting for it, then continue.
    ///
    /// The order is the point. `setRemoteDescription` is asynchronous, so a
    /// candidate handed to `add` while it is still in flight is refused for a
    /// reason indistinguishable from a malformed one — which is precisely why
    /// the previous shape of this code could discard that error and lose the
    /// early candidates in silence.
    private func setRemoteLocked(_ description: RTCSessionDescription,
                                 milestone: LinkMilestone,
                                 then next: @escaping () -> Void) {
        guard let pc else {
            failLocked(LinkTransportError.notReady)
            return
        }
        pc.setRemoteDescription(description) { [weak self] error in
            guard let self else { return }
            self.queue.later {
                guard !self.closed else { return }
                if let error {
                    self.failLocked(error)
                    return
                }
                // A fresh event boundary: `setRemoteDescription` is
                // asynchronous, so this block is a separate queue item and the
                // deadline may have passed while it was in flight.
                let now = self.now()
                guard !self.expiredLocked(at: now) else { return }
                // The peer answered or offered: the strongest evidence there is
                // that somebody is on the other end.
                self.noteLocked(milestone, at: now)
                guard !self.closed else { return }
                for candidate in self.remoteCandidates.open() {
                    self.addRemoteCandidateLocked(candidate)
                }
                guard !self.closed else { return }
                next()
            }
        }
    }

    private func remoteCandidateLocked(_ candidate: RTCIceCandidate) {
        switch remoteCandidates.admit(candidate) {
        case .send:
            addRemoteCandidateLocked(candidate)
        case .hold:
            break
        case .overflow:
            failLocked(LinkTransportError.pendingCandidateOverflow(.remote))
        }
    }

    private func addRemoteCandidateLocked(_ candidate: RTCIceCandidate) {
        guard let pc else { return }
        pc.add(candidate) { [weak self] error in
            guard let self else { return }
            self.queue.later {
                guard !self.closed else { return }
                if error != nil {
                    // No longer the "arrived before the remote description"
                    // case — the gate above makes that unreachable — so this is
                    // a candidate the PeerConnection genuinely could not use.
                    // Still non-fatal, exactly as `webrtc-core.ts` treats it:
                    // one unusable candidate is not a reason to end a link that
                    // may already have a working pair. It buys no time, though.
                    Self.log.notice("link discarded an unusable remote candidate")
                    return
                }
                let now = self.now()
                guard !self.expiredLocked(at: now) else { return }
                self.noteLocked(.remoteCandidate, at: now)
            }
        }
    }

    private func verifyRevealLocked(_ reveal: Reveal, at now: TimeInterval) {
        do {
            let result = try handshake.verifyPeerReveal(reveal)
            // The link's ONE set of codecs, constructed exactly here and never
            // again: `LinkIdentity` owns them for the link's whole lifetime, so
            // a later batch or a reopened conversation continues their AEAD
            // sequences instead of restarting them.
            let identity = LinkIdentity(
                peerId: peerId,
                role: role,
                sas: result.sas,
                codecs: LinkCodecs(sendKey: result.keys.send, recvKey: result.keys.recv),
                authenticationGeneration: authenticationGeneration
            )
            let step = establishment.authenticated(identity)
            noteLocked(.authenticated, at: now)
            // `note` can end the transport — a reveal served after the
            // establishment's deadline fails closed there — and an ended
            // establishment authenticates nobody: no SAS to compare, no reveal
            // of ours in answer, no publication.
            guard !closed else { return }
            onSAS?(result.sas)
            // A consumer is entitled to close from `onSAS`, and that close has
            // already happened by the time this line runs — so neither the
            // reveal below nor the publication after it may be spoken for it.
            guard !closed else { return }
            // `onSAS` is the consumer's own code, it runs on this queue, and it
            // may take as long as it likes — showing six digits and waiting is
            // exactly what it is for. The `now` this method was handed was read
            // before it ran, and the wake-up that would have reported a crossed
            // deadline could not run while the callback held the queue. So the
            // boundary is read AFTER the callback, and read once: an
            // establishment that lost its no-progress, key-reveal or hard cap
            // window in there must not send its reveal and must not reach
            // `apply`, which would disarm the very watchdog it has outlived.
            let afterSAS = self.now()
            guard !expiredLocked(at: afterSAS) else { return }
            // The responder learns the peer key from this reveal and only now
            // discloses its own; the initiator already revealed on the answer.
            if role == .responder { sendRevealLocked() }
            apply(step)
        } catch {
            // A commit mismatch means the key was chosen after seeing ours, or
            // was tampered with in flight. Fail hard rather than publishing
            // lanes, which would defeat the SAS entirely.
            failLocked(error)
        }
    }

    private func sendRevealLocked() {
        guard !closed, !revealSent else { return }
        revealSent = true
        sendLocked(taggedSignal(revealField(handshake.reveal()), generation: .link))
    }

    private func sendLocked(_ data: JSONValue) {
        guard !closed else { return }
        signaling.sendSignal(to: peerId, data: data)
    }

    // MARK: - deadlines (always on `queue`)

    /// Idempotent: whichever of `start()` and the first signal this
    /// establishment will actually act on happens first starts the clock, and
    /// the second one does not restart it.
    private func armWatchdogLocked(at now: TimeInterval) {
        guard !closed, watchdog == nil else { return }
        watchdog = LinkEstablishmentWatchdog(start: now, deadlines: deadlines)
        rescheduleWatchdogLocked(at: now)
    }

    /// Whether a deadline had ALREADY passed when this event reached the queue,
    /// having failed the transport if so.
    ///
    /// The single boundary check every event goes through before it is allowed
    /// to count as progress. A `DispatchWorkItem` is not a promise about time:
    /// the wake-up can be queued behind a client callback that ran long, or
    /// behind a device that suspended, so an event can be served after the
    /// bound it was racing is gone. Failing closed here is what keeps the bound
    /// a bound — and it is why the callers below must re-check `closed` rather
    /// than carrying on.
    private func expiredLocked(at now: TimeInterval) -> Bool {
        guard !closed, let timeout = watchdog?.expiry(at: now) else { return false }
        failLocked(LinkTransportError.establishmentTimeout(timeout))
        return true
    }

    private func noteLocked(_ milestone: LinkMilestone, at now: TimeInterval) {
        guard !closed, watchdog != nil else { return }
        // Only a milestone that actually moved a deadline is worth a new
        // wake-up; a repeated one, or one past the candidate budget, is not.
        // And a milestone the watchdog reports as late is not progress at all —
        // `expired` is a verdict, not a shade of "nothing to do", so it ends the
        // transport rather than being dropped.
        switch watchdog!.note(milestone, at: now) {
        case .rearmed:
            rescheduleWatchdogLocked(at: now)
        case .unchanged:
            break
        case let .expired(timeout):
            failLocked(LinkTransportError.establishmentTimeout(timeout))
        }
    }

    /// Every lane that is open right now, reported as a milestone. Repeats are
    /// free — the watchdog keys on identity — so this can be called from any
    /// state change without tracking which lane it was about.
    private func noteOpenLanesLocked(at now: TimeInterval) {
        for lane in establishment.openLanes {
            guard !closed else { return }
            noteLocked(.laneOpened(lane), at: now)
        }
    }

    private func rescheduleWatchdogLocked(at now: TimeInterval) {
        watchdogTimer?.cancel()
        watchdogTimer = nil
        guard !closed, let deadline = watchdog?.deadline else { return }
        watchdogGeneration += 1
        let generation = watchdogGeneration
        watchdogTimer = queue.after(deadline - now) { [weak self] in
            self?.watchdogFiredLocked(generation: generation)
        }
    }

    private func watchdogFiredLocked(generation: Int) {
        // Three ways this wake-up can be stale, and `cancel()` only covers the
        // ones that had not started yet: the transport closed, a milestone
        // rescheduled after this item was already dispatched, or the deadline
        // simply moved out from under it.
        guard !closed, generation == watchdogGeneration, watchdog != nil else { return }
        let now = self.now()
        guard !expiredLocked(at: now) else { return }
        rescheduleWatchdogLocked(at: now)
    }

    private func disarmWatchdogLocked() {
        watchdog?.disarm()
        watchdogTimer?.cancel()
        watchdogTimer = nil
    }

    // MARK: - channels (always on `queue`)

    private func collectLocked(_ channel: RTCDataChannel, at now: TimeInterval) {
        guard !closed else {
            channel.close()
            return
        }
        channel.delegate = self
        delegatedChannels.append(channel)
        let step = establishment.collect(RTCLinkLane(channel))
        noteOpenLanesLocked(at: now)
        // A lane that opened late cannot publish a link whose deadline has
        // already passed.
        guard !closed else { return }
        apply(step)
    }

    private func apply(_ step: LinkEstablishment.Step) {
        switch step {
        case .none:
            break
        case .publish:
            // The establishment is complete HERE — at the barrier — not when
            // the client's callbacks return. Disarming afterwards was a bet
            // that no time can pass on a serial queue, and that is false in the
            // one direction that matters: the queue is occupied by `onReady`
            // and the replay, which are the consumer's own code and may take as
            // long as they like, while the deadline they race is a clock. A
            // link that was finished and authenticated could be torn down
            // underneath a consumer that merely paused to build its lane
            // consumers.
            disarmWatchdogLocked()
            publishLocked()
        case let .fail(error):
            failLocked(error)
        }
    }

    /// Publish once, then replay — in that order and with nothing between them.
    ///
    /// Both halves belong to `LinkEstablishment.publish`, which is what makes
    /// them one indivisible operation: the replay runs on `queue` while the
    /// queue is inside this call, so a frame arriving now waits behind it and
    /// cannot overtake the ones the peer sent first, and a consumer that closes
    /// from `onReady` or from a replayed frame stops the rest of the backlog on
    /// the spot. That is the whole reason capture exists: an SCTP stream can
    /// deliver before its sibling has finished DCEP, and a lane that lost the
    /// peer's first frame is a lane whose receiver sequence can never be proven
    /// again.
    private func publishLocked() {
        guard !closed else { return }
        establishment.publish(
            ready: { [weak self] identity in
                guard let self else { return }
                Self.log.notice("link published role=\(String(describing: self.role), privacy: .public)")
                self.onReady?(identity)
            },
            frame: { [weak self] lane, bytes in self?.onFrame?(lane, bytes) })
    }

    // MARK: - send

    /// Send raw bytes on ONE exact lane. Throws `LinkTransportError.notReady`
    /// before publication, `.laneUnavailable` for a lane with no open channel,
    /// and `.closed` once the transport has ended.
    ///
    /// Safe from any thread, including from inside a callback — see
    /// `LinkTransportQueue`.
    public func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        try queue.sync { try establishment.send(bytes, on: lane) }
    }

    /// Bytes still queued on one lane, for a caller doing its own flow control.
    public func bufferedAmount(on lane: LinkLane) -> UInt64 {
        queue.sync { establishment.bufferedAmount(on: lane) }
    }

    /// Whether this transport has ended.
    ///
    /// Readable from inside `onError`, `onClose` and every other callback, and
    /// true in all of them: teardown precedes the callbacks, so a consumer never
    /// observes a transport that is about to be gone as if it were live.
    public var isClosed: Bool {
        queue.sync { closed }
    }

    // MARK: - close

    /// Idempotent, and safe from any thread including from inside a callback.
    ///
    /// **Inline when called from a callback**, which is the only way the
    /// guarantee that matters can hold: a consumer closing from `onSAS` must
    /// stop the reveal that would otherwise be sent for it as soon as the
    /// callback returns, and one closing from `onReady` or a replayed `onFrame`
    /// must stop the rest of the backlog. Scheduling the close behind the
    /// current callback would deliver it after exactly the work it was meant to
    /// prevent.
    ///
    /// **Asynchronous from outside**, deliberately: `RTCPeerConnection.close()`
    /// joins WebRTC's internal threads, and a user pressing cancel should not
    /// block the main thread on that. Ordering is unaffected — a `send` issued
    /// afterwards from the same thread queues behind this and is correctly
    /// refused.
    public func close() {
        queue.nowOrLater { [weak self] in self?.terminateLocked(nil) }
    }

    private func failLocked(_ error: Error) {
        terminateLocked(error)
    }

    /// The ONE terminal path, and the order inside it is the contract.
    ///
    /// Closed state and teardown happen FIRST, so by the time any client
    /// callback runs the transport is genuinely gone: a send from `onError`
    /// refuses with `.closed` rather than succeeding, `isClosed` is true, and a
    /// `close()` from either callback is a no-op instead of nesting `onClose`
    /// inside `onError`. Each callback fires at most once, neither is re-entered
    /// and neither is nested in the other — which the old shape could not
    /// promise, because it ran `onError` while `closed` was still false and only
    /// then tore down.
    ///
    /// An explicit close passes no error and therefore emits only `onClose`.
    private func terminateLocked(_ error: Error?) {
        guard !closed else { return }
        closed = true
        teardownLocked()
        if let error {
            Self.log.error("link failed error=\(String(describing: error), privacy: .public)")
            onError?(error)
        }
        onClose?()
    }

    /// Releases everything this transport holds. Safe to run from `deinit`:
    /// it touches no queue.
    private func teardownLocked() {
        disarmWatchdogLocked()
        localCandidates.discard()
        remoteCandidates.discard()
        // Releases the identity, and with it the link's one `LinkCodecs`.
        establishment.close()
        // Delegates first: a channel that keeps calling back after this point
        // would be calling into a transport that has already told its client it
        // is gone.
        for channel in delegatedChannels {
            channel.delegate = nil
            channel.close()
        }
        delegatedChannels = []
        pc?.delegate = nil
        pc?.close()
        pc = nil
        // Give the slot back, but only if it is still ours — a transport that
        // closes after a newer one claimed the socket must leave that newer
        // handler alone, which is what the token comparison inside
        // `removeSignalHandler` decides. Cleared afterwards so a second teardown
        // cannot revisit a slot somebody else may own by then.
        if let signalToken {
            signaling.removeSignalHandler(signalToken)
            self.signalToken = nil
        }
    }

    /// Safety net for a caller that drops its last reference without closing.
    ///
    /// Deliberately does NOT hop onto `queue`, for the two reasons
    /// `RealtimeConnection.deinit` records: `queue.async { [weak self] … }` forms
    /// a new weak reference during deallocation, which traps on an `NSObject`
    /// subclass, and `queue.sync` deadlocks if the last release happened on the
    /// queue itself. By the time `deinit` runs no strong reference can remain,
    /// so nothing else can be mutating this state.
    deinit {
        teardownLocked()
    }
}

// MARK: - RTCPeerConnectionDelegate

extension WebRTCLinkTransport: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    /// Local candidates are trickled as they are gathered, which starts inside
    /// `setLocalDescription` — before the completion block that sends the SDP
    /// they belong to. They are therefore held by `localCandidates` until that
    /// send has actually happened, and released FIFO afterwards.
    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        queue.later { [weak self] in self?.localCandidateLocked(candidate) }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            let now = self.now()
            guard !self.expiredLocked(at: now) else { return }
            self.collectLocked(dataChannel, at: now)
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        queue.later { [weak self] in
            guard let self else { return }
            switch newState {
            case .failed:
                self.failLocked(LinkTransportError.peerConnectionFailed)
            case .closed:
                self.terminateLocked(nil)
            default:
                break
            }
        }
    }
}

// MARK: - RTCDataChannelDelegate

extension WebRTCLinkTransport: RTCDataChannelDelegate {
    public func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            let now = self.now()
            guard !self.expiredLocked(at: now) else { return }
            let step = self.establishment.laneStateChanged(label: dataChannel.label)
            // A lane reaching `open` is progress, and — once both have — the
            // end of the transport phase and the moment the key-reveal deadline
            // takes over from the no-progress one.
            self.noteOpenLanesLocked(at: now)
            guard !self.closed else { return }
            self.apply(step)
        }
    }

    public func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            // Before publication this is a frame being captured for a link whose
            // time has gone; the capture would be replayed by a publication that
            // must never happen. After publication the watchdog is disarmed, so
            // this costs a comparison and changes nothing — delivery to the
            // consumer is untouched.
            guard !self.expiredLocked(at: self.now()) else { return }
            let frame = [UInt8](buffer.data)
            switch self.establishment.inbound(label: dataChannel.label, frame: frame) {
            case .captured, .ignore:
                break
            case let .deliver(lane):
                self.onFrame?(lane, frame)
            case let .fail(error):
                self.failLocked(error)
            }
        }
    }
}
