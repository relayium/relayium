import Foundation
import os
import WebRTC

/// A production WebRTC driver that rebuilds BOTH lanes of ONE existing,
/// already-authenticated `link/1` identity.
///
/// `WebRTCLinkTransport`'s sibling, and the difference between them is exactly
/// one thing that must never be decided at a call site by accident: where the
/// identity comes from. That driver derives session keys from its own
/// commit/reveal and constructs the link's one `LinkCodecs`. This one is HANDED
/// that identity and constructs nothing — no `HandshakeState`, no key pair, no
/// codecs, no SAS. It emits no commit, no reveal and no capability field,
/// because every one of those describes a trust step it did not perform.
///
/// The reason that split is worth two drivers rather than a flag is the
/// invariant underneath it: a link owns exactly one `(content key, direction)`
/// AEAD sequence for its whole life. A rebuild that could construct a second
/// `LinkCodecs` would restart those sequences under keys that have already used
/// them — catastrophic for the file lane's AES-GCM — so "this path cannot
/// produce an identity" has to be a property of the code, not a branch that
/// happens not to be taken.
///
/// ## What proves who is on the other end
///
/// Nothing in the transport. There is no handshake here, and the signalling
/// relay sees every SDP in the clear, so without a tag it could simply offer its
/// own replacement transport and take over half the session. Every outbound
/// offer, answer and candidate is tagged `resume` and signed with this link's
/// `resumeAuth` key, and every inbound one must verify under it before it can
/// record progress, apply a description, add a candidate, open a candidate gate
/// or produce an answer. Producing that tag is equivalent to holding the keys
/// the user compared as a SAS on the first connection.
///
/// Anything that does not verify — missing tag, malformed tag, another session's
/// key, a genuine tag over bytes rewritten in flight, the right tag from the
/// wrong peer — is dropped in SILENCE by `LinkResumePolicy`, never answered and
/// never fatal, so the genuine peer can still arrive. An attempt that never
/// hears one is ended by its deadlines instead.
///
/// ## Where the logic actually lives
///
/// Almost nowhere in this file, and in the SAME places `WebRTCLinkTransport`
/// puts it: which signals may be acted on is `LinkResumePolicy`'s; the exact
/// bytes on the wire are `LinkResumeSignal`'s; the channel set, the publication
/// barrier, pre-attachment capture and send readiness are `LinkEstablishment`'s;
/// SDP/ICE ordering is `LinkCandidateGate`'s; when to give up is
/// `LinkEstablishmentWatchdog`'s, woken by `LinkDeadlineClock`; the re-entrancy
/// rules of the private queue are `LinkTransportQueue`'s. What is left here is
/// the part that genuinely cannot be unit-tested — SDP, ICE and DCEP against a
/// live peer.
///
/// ## Threading
///
/// Identical to `WebRTCLinkTransport`'s, and for the same reasons. Every WebRTC
/// delegate callback, every inbound signal and every public call serializes on
/// this transport's private serial queue, and **every client callback
/// (`onReady`, `onFrame`, `onError`, `onClose`) fires on that queue** — never on
/// a WebRTC-internal thread and never assumed to be the main thread. Calling
/// `send`, `bufferedAmount`, `isClosed` or `close` from inside a callback is
/// safe, and `close()` from a callback takes effect BEFORE that callback
/// returns: a consumer that closes from `onReady` must not then be handed the
/// captured backlog.
///
/// ## Deadlines
///
/// Two, not three. The 90 s hard cap and the 30 s no-progress deadline are the
/// deployed web client's and mean the same thing here. The key-reveal window is
/// suppressed outright rather than left unreachable: it describes "the lanes are
/// up but the peer has not disclosed its key", and a rebuild is never in that
/// state — its keys existed before its PeerConnection did. Every asynchronous
/// completion and every event boundary re-reads the clock before it continues,
/// because a queued work item is not a promise about time: a late SDP, channel
/// or candidate completion must not revive or publish a transport that has
/// already lost its bound.
///
/// ## What this is NOT, and what remains gated
///
/// This is one replacement CONNECTION. It is not recovery, nothing constructs
/// it, and `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` remains false. Still open, and
/// each one a separate piece of work:
///
///  - **The atomic swap.** Nothing decides which of an old and a new transport
///    owns the lanes, publishes one over the other, or closes the loser. This
///    driver publishes its own transport and knows nothing about any other.
///  - **Retry orchestration.** No recovery window, no 90-second retry loop, and
///    nothing that keeps a dropped link current long enough to rebuild it.
///  - **ICE restart.** ABSENT ON PURPOSE, and the absence is a gate rather than
///    an oversight — see "Renegotiation" below before adding one.
///  - **Durable file recovery.** No checkpoints and no RESUME_REQ/RESUME_START,
///    so a rebuilt lane resumes a connection, not a transfer.
///  - **Poisoned text-lane policy and END acknowledgement timing.** Untouched;
///    a rebuild inherits whatever the lane's own state was.
///  - **Admission, factory, lifecycle and UI.** Unwired, and `LINK_BUILD_SUPPORT`
///    is still false, so no peer is ever told this build speaks `link/1`.
///  - **Live evidence.** Native↔native is covered:
///    `WebRTCLinkReplacementInteropTests` runs two of these drivers against each
///    other over two real `RTCPeerConnection`s and a bridged signalling room,
///    and proves both lanes carry bytes in both directions under the exact
///    inherited codecs. Native↔Web is NOT: both ends there are this build's own
///    driver, so any assumption the two copies share would satisfy both of them.
///
/// ## Renegotiation, and why there is none
///
/// This driver negotiates EXACTLY ONCE. It never calls `createOffer` with
/// `iceRestart`, and it does nothing on `.disconnected` — the `default: break`
/// in its connection-state handler is that decision, not an unhandled case.
///
/// That is a deliberate divergence from `webrtc-core.ts`, whose `tryIceRestart`
/// fires one restart offer as initiator when the state reaches `disconnected`,
/// and which `connectResumeLink` inherits — so a genuine web peer CAN send a
/// second `resume` offer that this side will drop in silence. That drop does not
/// corrupt the established lanes, but it also does not recover them: ICE may
/// return from `disconnected` on its own, and otherwise the peer connection must
/// progress to `failed` before this driver closes. The establishment deadlines
/// are already disarmed after publication, so they are deliberately not claimed
/// as a bound here. What is not safe is bolting a restart on without first
/// building what it needs, because three separate
/// pieces of state here are one-shot by construction:
///
///  - `LinkResumePolicy` applies at most one remote offer and one remote answer
///    for this transport's whole life. A second description is refused BEFORE
///    the tag is checked, so a restart offer is indistinguishable there from a
///    duplicate or a replay — which is exactly what that slot is defending.
///  - Both `LinkCandidateGate`s are already OPEN by then. Their contract is
///    "hold candidates until the description they belong to has been applied /
///    sent", and an open gate passes everything straight through — so a
///    restarted negotiation's candidates would reach `pc.add` before its new
///    remote description, and this side's own would leave before its new local
///    one, which is the precise race the gates exist to prevent.
///  - `LinkEstablishment` has already published. Its barrier lifts once, and
///    the lanes it published must survive a renegotiation untouched: a restart
///    reuses the same SCTP association and the same `LinkCodecs`, so anything
///    that could re-collect or re-open a channel here would be a second producer
///    on an AEAD sequence that is already running.
///
/// A correct restart therefore needs a per-negotiation SDP/candidate gate — one
/// generation counter that reopens both candidate gates and admits one more
/// description per negotiation, on both sides, with the tag still mandatory —
/// and it needs to leave the published lanes alone while doing it. That is its
/// own piece of work. Until it exists this stays a remaining gate: do not enable
/// a restart path here on the assumption that web's `disconnected -> one ICE
/// restart` behaviour is present, because it is not.
public final class WebRTCLinkReplacementTransport: NSObject {
    private static let log = Logger(subsystem: "com.relayium", category: "link")

    // MARK: - client callbacks (all fire on `queue`)

    /// Both exact lanes are open again under the identity this transport was
    /// given. Fires at most once, and carries THAT identity — the same object
    /// graph, so the link's one set of nonce-bearing codecs continues rather
    /// than restarting.
    ///
    /// There is deliberately no `onSAS` counterpart. The six digits belong to
    /// the authentication this rebuild inherited; announcing them again would
    /// tell a user to re-verify something that never changed.
    public var onReady: ((LinkIdentity) -> Void)?
    /// One raw frame off one exact lane.
    public var onFrame: ((LinkLane, [UInt8]) -> Void)?
    /// Fires at most once, and only for a failure. By the time it runs this
    /// transport is already closed: teardown happens first.
    public var onError: ((Error) -> Void)?
    /// Fires at most once, whatever ended the transport, and always last.
    public var onClose: (() -> Void)?

    // MARK: - wiring

    private let signaling: SignalingClient
    private let peerId: String
    private let role: Role
    /// The key every outbound signal is signed with, read once from the identity
    /// this transport was handed.
    ///
    /// One read site, and it is the identity's: deriving it here — or accepting
    /// it as a separate parameter — would make it possible to sign a rebuild
    /// with a key that does not belong to the codecs it is reusing, which is
    /// the one thing the tag is supposed to make impossible.
    private let signingKey: [UInt8]
    private let policy: LinkResumePolicy
    private let establishment: LinkEstablishment
    /// Monotonic, and injectable so the deadline wiring can be exercised at
    /// millisecond scale. `systemUptime` rather than a wall clock: a user
    /// changing the date must not be able to expire a live rebuild.
    private let now: () -> TimeInterval

    private let queue: LinkTransportQueue
    /// Told its identity already exists, which is what retires the key-reveal
    /// window. Shared with `WebRTCLinkTransport`.
    private let clock: LinkDeadlineClock

    private let factory: RTCPeerConnectionFactory
    private var pc: RTCPeerConnection?
    /// Every channel this transport has ever set a delegate on, including ones
    /// `LinkEstablishment` rejected. Teardown walks this list, so a rejected
    /// channel cannot keep calling back into a closed transport.
    private var delegatedChannels: [RTCDataChannel] = []

    // MARK: - state guarded by `queue`

    private var started = false
    private var closed = false
    /// Which installation of the signalling slot is ours. Written in `init`
    /// before any other thread can reach this object, and cleared by teardown.
    private var signalToken: SignalHandlerToken?

    private var localCandidates = LinkCandidateGate<RTCIceCandidate>()
    private var remoteCandidates = LinkCandidateGate<RTCIceCandidate>()

    /// - Parameters:
    ///   - identity: the authenticated link this transport is being rebuilt
    ///     under. Its peer, its deterministic role, its SAS, its authentication
    ///     generation and — above all — its `LinkCodecs` object are carried
    ///     through unchanged; the role in particular is never recomputed, or a
    ///     rebuild could turn two peers into two offerers.
    ///   - deadlines: defaults are the deployed web client's. `keyReveal` is
    ///     accepted and ignored: a rebuild has no reveal phase.
    public init(signaling: SignalingClient,
                identity: LinkIdentity,
                iceServers: [RTCIceServer],
                iceTransportPolicy: RTCIceTransportPolicy = .all,
                capture: LinkFrameCapture = LinkFrameCapture(),
                deadlines: LinkDeadlines = LinkDeadlines(),
                now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.signaling = signaling
        self.peerId = identity.peerId
        self.role = identity.role
        // Read ONCE, from the identity, and shared with the policy: the key that
        // signs this side's signalling has to be the same one that verifies the
        // peer's, and both have to be the key belonging to the codecs this
        // rebuild is reusing.
        let signingKey = identity.codecs.resumeAuthKey
        self.signingKey = signingKey
        self.policy = LinkResumePolicy(peerId: identity.peerId,
                                       role: identity.role,
                                       resumeAuthKey: signingKey)
        // The identity goes in at construction, so this transport has no way to
        // produce one and the barrier is waiting on the lanes alone.
        self.establishment = LinkEstablishment(resuming: identity, capture: capture)
        self.now = now
        let queue = LinkTransportQueue(label: "im.relayium.WebRTCLinkReplacementTransport")
        self.queue = queue
        self.clock = LinkDeadlineClock(queue: queue,
                                       deadlines: deadlines,
                                       identityPresent: true)
        ensureRTCSSL()
        self.factory = RTCPeerConnectionFactory()
        super.init()

        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        config.iceTransportPolicy = iceTransportPolicy
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        self.pc = factory.peerConnection(with: config, constraints: constraints, delegate: self)

        // Claimed with a token rather than by assigning `onSignal`: the dying
        // transport this one replaces may still be closing, and a stale close
        // must not be able to erase this handler.
        self.signalToken = signaling.installSignalHandler { [weak self] from, data in
            guard let self else { return }
            self.queue.later { self.handleLocked(from: from, signal: data) }
        }
    }

    // MARK: - start

    /// Original initiator: opens both lanes and offers. Original responder:
    /// nothing but the deadlines — its lanes arrive through `didOpen` once the
    /// initiator's offer has been answered.
    ///
    /// Idempotent: a second call does nothing rather than opening a second pair
    /// of channels into the same connection.
    public func start() {
        queue.later { [weak self] in self?.startLocked() }
    }

    /// Hand this transport a signal that was routed elsewhere first — the resume
    /// offer whose tag an owner verified before deciding this rebuild should
    /// exist at all.
    ///
    /// Safe to call for a signal the installed handler will also deliver: the
    /// policy applies exactly one remote offer and one remote answer, so the
    /// duplicate is dropped whole. The tag is checked again here regardless;
    /// verification is cheap and this object never trusts a caller's word for
    /// who sent something.
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
        guard let pc else {
            failLocked(LinkTransportError.notReady)
            return
        }
        guard role == .initiator else { return }

        // BOTH lanes before the offer, so one negotiation carries both. Reliable
        // and ordered: `maxRetransmits` and `maxPacketLifeTime` are deliberately
        // left unset, which is what makes the channel reliable — and a rebuilt
        // lane feeds an AEAD sequence that has already been proven once, so a
        // hole in it is not recoverable.
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
                // reported it cannot run while this queue is busy.
                guard !self.expiredLocked(at: self.now()) else { return }
                pc.setLocalDescription(sdp) { [weak self] error in
                    guard let self else { return }
                    self.queue.later {
                        guard !self.closed else { return }
                        if let error {
                            self.failLocked(error)
                            return
                        }
                        // The same boundary at the point it costs the most: past
                        // this line the offer is on the wire and the local
                        // candidate gate is open.
                        guard !self.expiredLocked(at: self.now()) else { return }
                        self.sendLocked(resumeSDPSignal(kind: "offer",
                                                        sdp: sdp.sdp,
                                                        key: self.signingKey))
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
                guard !self.expiredLocked(at: self.now()) else { return }
                pc.setLocalDescription(sdp) { [weak self] error in
                    guard let self else { return }
                    self.queue.later {
                        guard !self.closed else { return }
                        if let error {
                            self.failLocked(error)
                            return
                        }
                        guard !self.expiredLocked(at: self.now()) else { return }
                        // An answer is produced ONLY for an offer the policy
                        // verified, so this side never answers a peer it cannot
                        // attribute the offer to.
                        self.sendLocked(resumeSDPSignal(kind: "answer",
                                                        sdp: sdp.sdp,
                                                        key: self.signingKey))
                        self.localDescriptionSentLocked()
                    }
                }
            }
        }
    }

    // MARK: - local ICE ordering (always on `queue`)

    /// The offer or the answer is on the wire. Everything gathered while it was
    /// being produced may now follow it, in the order it was gathered.
    private func localDescriptionSentLocked() {
        for candidate in localCandidates.open() { sendCandidateLocked(candidate) }
    }

    private func localCandidateLocked(_ candidate: RTCIceCandidate) {
        guard !closed else { return }
        // The same boundary every other event goes through. Free after
        // publication — the barrier disarms the clock — and before it, emitting
        // a candidate for a rebuild that is out of time only asks a peer that
        // has given up to keep gathering.
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
        sendLocked(resumeICESignal(candidate.sdp,
                                   sdpMid: candidate.sdpMid,
                                   sdpMLineIndex: candidate.sdpMLineIndex,
                                   key: signingKey))
    }

    // MARK: - signals (always on `queue`)

    private func handleLocked(from: String, signal: JSONValue) {
        guard !closed else { return }
        // The plan decides whether this signal is this rebuild's business AT ALL
        // — which includes verifying its tag — and it is therefore computed
        // before anything else happens. Arming ahead of that filter would let a
        // signalling relay put every replacement in the room on a deadline it
        // started, and then kill them with it.
        let plan = policy.plan(from: from, signal: signal)
        guard !plan.isEmpty else { return }
        let now = self.now()
        // An owner can hand over the offer that created this transport before
        // anybody calls `start()`. Arming here as well is what keeps that path
        // bounded.
        armWatchdogLocked(at: now)
        // The signal is ours and provably from the peer, but it may have reached
        // this queue after the deadline it was racing.
        guard !expiredLocked(at: now) else { return }
        guard pc != nil else {
            failLocked(LinkTransportError.notReady)
            return
        }
        for action in plan {
            guard !closed else { return }
            switch action {
            case let .applyRemoteOffer(sdp):
                setRemoteLocked(RTCSessionDescription(type: .offer, sdp: sdp),
                                milestone: .remoteOffer) { [weak self] in
                    self?.createAndSendAnswerLocked()
                }
            case let .applyRemoteAnswer(sdp):
                // Nothing follows an answer on this path. An establishment would
                // disclose its key here; a rebuild has none to disclose, and the
                // lanes are the only thing still outstanding.
                setRemoteLocked(RTCSessionDescription(type: .answer, sdp: sdp),
                                milestone: .remoteAnswer)
            case let .addRemoteCandidate(candidate, sdpMid, sdpMLineIndex):
                remoteCandidateLocked(RTCIceCandidate(sdp: candidate,
                                                      sdpMLineIndex: sdpMLineIndex ?? 0,
                                                      sdpMid: sdpMid))
            case .recordPeerCommit, .verifyPeerReveal, .fail:
                // Unreachable: `LinkResumePolicy` cannot emit any of these, which
                // is what makes "a rebuild feeds no handshake and is ended by no
                // stranger" structural. Kept explicit rather than defaulted so
                // adding an action to the shared vocabulary is a decision here
                // and not a silent no-op.
                Self.log.error("link rebuild ignored an action its policy cannot produce")
            }
        }
    }

    /// Apply one remote description, then release the candidates that were
    /// waiting for it, then continue.
    ///
    /// The order is the point, and on this path it is also the authentication
    /// boundary: the gate is opened by an APPLIED description, and a description
    /// is only applied for a signal whose tag verified. A candidate handed to
    /// `add` before that has no verified description to belong to.
    private func setRemoteLocked(_ description: RTCSessionDescription,
                                 milestone: LinkMilestone,
                                 then next: (() -> Void)? = nil) {
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
                // A fresh event boundary: `setRemoteDescription` is asynchronous,
                // so this block is a separate queue item.
                let now = self.now()
                guard !self.expiredLocked(at: now) else { return }
                // The peer answered or offered, under this link's own key: the
                // strongest evidence there is that the genuine peer is there.
                self.noteLocked(milestone, at: now)
                guard !self.closed else { return }
                for candidate in self.remoteCandidates.open() {
                    self.addRemoteCandidateLocked(candidate)
                }
                guard !self.closed else { return }
                next?()
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
                    // Not the "arrived before the remote description" case — the
                    // gate makes that unreachable — so this is a candidate the
                    // PeerConnection genuinely could not use. Non-fatal, exactly
                    // as `webrtc-core.ts` treats it. It buys no time, though.
                    Self.log.notice("link rebuild discarded an unusable remote candidate")
                    return
                }
                let now = self.now()
                guard !self.expiredLocked(at: now) else { return }
                self.noteLocked(.remoteCandidate, at: now)
            }
        }
    }

    private func sendLocked(_ data: JSONValue) {
        guard !closed else { return }
        signaling.sendSignal(to: peerId, data: data)
    }

    // MARK: - deadlines (always on `queue`)

    /// Idempotent: whichever of `start()` and the first signal this rebuild will
    /// actually act on happens first starts the clock.
    private func armWatchdogLocked(at now: TimeInterval) {
        guard !closed else { return }
        clock.arm(at: now) { [weak self] in self?.watchdogFiredLocked() }
    }

    /// Whether a deadline had ALREADY passed when this event reached the queue,
    /// having failed the transport if so.
    ///
    /// The single boundary check every event goes through before it is allowed
    /// to count as progress. A `DispatchWorkItem` is not a promise about time:
    /// the wake-up can be queued behind a client callback that ran long, or
    /// behind a device that suspended. Callers must re-check `closed` rather
    /// than carrying on.
    private func expiredLocked(at now: TimeInterval) -> Bool {
        guard !closed, let timeout = clock.expiry(at: now) else { return false }
        failLocked(LinkTransportError.establishmentTimeout(timeout))
        return true
    }

    private func noteLocked(_ milestone: LinkMilestone, at now: TimeInterval) {
        guard !closed else { return }
        // A milestone the watchdog judged LATE is not progress — it is the proof
        // this rebuild already lost — so it ends the transport rather than being
        // dropped.
        if let timeout = clock.note(milestone, at: now) {
            failLocked(LinkTransportError.establishmentTimeout(timeout))
        }
    }

    /// Every lane that is open right now, reported as a milestone. Repeats are
    /// free — the watchdog keys on identity.
    private func noteOpenLanesLocked(at now: TimeInterval) {
        for lane in establishment.openLanes {
            guard !closed else { return }
            noteLocked(.laneOpened(lane), at: now)
        }
    }

    private func watchdogFiredLocked() {
        guard !closed else { return }
        let now = self.now()
        guard !expiredLocked(at: now) else { return }
        clock.reschedule(at: now)
    }

    private func disarmWatchdogLocked() {
        clock.disarm()
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
        // A lane that opened late cannot publish a rebuild whose deadline has
        // already passed.
        guard !closed else { return }
        apply(step)
    }

    private func apply(_ step: LinkEstablishment.Step) {
        switch step {
        case .none:
            break
        case .publish:
            // The rebuild is complete HERE — at the barrier — not when the
            // client's callbacks return. The queue is then occupied by `onReady`
            // and the replay, which are the consumer's own code and may take as
            // long as they like, while the deadline they race is a clock.
            disarmWatchdogLocked()
            publishLocked()
        case let .fail(error):
            failLocked(error)
        }
    }

    /// Publish once, then replay — in that order and with nothing between them.
    ///
    /// The replay matters more on a rebuild than on a first connection: those
    /// frames belong to receiver codecs that already exist and whose sequence
    /// must stay continuous, so a frame lost between "the channel was collected"
    /// and "the lane owns it" is not a missed message but a lane that can never
    /// be used again.
    private func publishLocked() {
        guard !closed else { return }
        establishment.publish(
            ready: { [weak self] identity in
                guard let self else { return }
                Self.log.notice("link rebuilt role=\(String(describing: self.role), privacy: .public)")
                self.onReady?(identity)
            },
            frame: { [weak self] lane, bytes in self?.onFrame?(lane, bytes) })
    }

    // MARK: - send

    /// Send raw bytes on ONE exact lane. Throws `LinkTransportError.notReady`
    /// before publication, `.laneUnavailable` for a lane with no open channel,
    /// and `.closed` once the transport has ended.
    ///
    /// Safe from any thread, including from inside a callback.
    public func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        try queue.sync { try establishment.send(bytes, on: lane) }
    }

    /// Bytes still queued on one lane, for a caller doing its own flow control.
    public func bufferedAmount(on lane: LinkLane) -> UInt64 {
        queue.sync { establishment.bufferedAmount(on: lane) }
    }

    /// Whether this transport has ended. True inside `onError` and `onClose`:
    /// teardown precedes the callbacks.
    public var isClosed: Bool {
        queue.sync { closed }
    }

    // MARK: - close

    /// Idempotent, and safe from any thread including from inside a callback.
    ///
    /// **Inline when called from a callback**, so a consumer that closes from
    /// `onReady` or a replayed `onFrame` stops the rest of the backlog on the
    /// spot. **Asynchronous from outside**, because `RTCPeerConnection.close()`
    /// joins WebRTC's internal threads and a user pressing cancel should not
    /// block on that; ordering is unaffected, since anything that thread issues
    /// afterwards queues behind it.
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
    /// refuses with `.closed`, `isClosed` is true, and a `close()` from either
    /// callback is a no-op instead of nesting `onClose` inside `onError`.
    ///
    /// An explicit close passes no error and therefore emits only `onClose`.
    private func terminateLocked(_ error: Error?) {
        guard !closed else { return }
        closed = true
        teardownLocked()
        if let error {
            Self.log.error("link rebuild failed error=\(String(describing: error), privacy: .public)")
            onError?(error)
        }
        onClose?()
    }

    /// Releases everything this transport holds. Safe to run from `deinit`: it
    /// touches no queue.
    private func teardownLocked() {
        disarmWatchdogLocked()
        localCandidates.discard()
        remoteCandidates.discard()
        // Releases this transport's reference to the identity, and with it the
        // link's `LinkCodecs`. The link itself is not this object's to end — a
        // rebuild that failed leaves the authentication exactly as it found it —
        // but a closed transport must not keep key material alive, and a
        // consumer must not be able to read an identity off a transport it has
        // already closed.
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
        // Give the slot back, but only if it is still ours — this transport may
        // itself have been superseded by a newer one.
        if let signalToken {
            signaling.removeSignalHandler(signalToken)
            self.signalToken = nil
        }
    }

    /// Safety net for a caller that drops its last reference without closing.
    ///
    /// Deliberately does NOT hop onto `queue`: `queue.async { [weak self] … }`
    /// forms a new weak reference during deallocation, which traps on an
    /// `NSObject` subclass, and `queue.sync` deadlocks if the last release
    /// happened on the queue itself. By the time `deinit` runs no strong
    /// reference can remain, so nothing else can be mutating this state.
    deinit {
        teardownLocked()
    }
}

// MARK: - RTCPeerConnectionDelegate

extension WebRTCLinkReplacementTransport: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    /// Local candidates are trickled as they are gathered, which starts inside
    /// `setLocalDescription` — before the completion block that sends the SDP
    /// they belong to. They are therefore held until that send has actually
    /// happened, and released FIFO afterwards.
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
                // Including `.disconnected`, and that is the decision rather
                // than an unhandled case. It is where `webrtc-core.ts` fires its
                // one ICE restart, and where a later editor would reach for the
                // same thing — but this transport's remote-description slot is
                // one-shot and both candidate gates are already open, so a
                // second negotiation cannot be accepted safely until a
                // per-negotiation gate exists. See this type's "Renegotiation"
                // section; a transient disconnect is left to ICE's own recovery,
                // and a terminal one to the later `.failed` state. Establishment
                // deadlines no longer apply after the lanes were published.
                break
            }
        }
    }
}

// MARK: - RTCDataChannelDelegate

extension WebRTCLinkReplacementTransport: RTCDataChannelDelegate {
    public func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            let now = self.now()
            guard !self.expiredLocked(at: now) else { return }
            let step = self.establishment.laneStateChanged(label: dataChannel.label)
            self.noteOpenLanesLocked(at: now)
            guard !self.closed else { return }
            self.apply(step)
        }
    }

    public func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            // Before publication this is a frame being captured for a rebuild
            // whose time has gone; the capture would be replayed by a
            // publication that must never happen. After publication the clock is
            // disarmed, so this costs a comparison and changes nothing.
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
