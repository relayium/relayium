import Foundation
import WebRTC

/// The live PeerConnection seams one renewal epoch needs.
///
/// A protocol rather than a concrete transport, for the reason the rest of this
/// layer separates policy from I/O: every rule in `RelayRenewEngine` has to be
/// drivable without a peer, a socket or an `RTCPeerConnection`, and a
/// controller that named `WebRTCLinkTransport` directly would make the wiring
/// itself — which effect reaches which call, in what order, and what happens
/// when one fails — observable only from a two-peer run.
///
/// `WebRTCLinkTransport` satisfies every member already; the conformance adds
/// no code.
/// The three things a live transport reports INTO renewal.
///
/// One value installed through one method, rather than three settable
/// properties. Three bare properties were the previous shape, and nothing ever
/// assigned them: the controller was constructed, the engine was tested by
/// calling its inputs directly, and in the real app an authenticated renewal
/// signal, a gathered candidate and a selected-pair change all arrived at a nil
/// optional and went nowhere. Making installation a PROTOCOL REQUIREMENT is
/// what turns "somebody must remember to wire this" into something a
/// conformance cannot omit.
public struct RelayRenewTransportInputs {
    /// One inbound renewal envelope, recognised by exact shape and NOT yet
    /// authenticated.
    public let signal: (RelayRenewEnvelope) -> Void
    /// One locally gathered candidate while an epoch owns the connection's ICE:
    /// `(candidate, sdpMid, sdpMLineIndex)`.
    public let localCandidate: (String, String?, UInt32?) -> Void
    /// The selected pair changed: `(localCandidate, remoteCandidate)`, raw.
    public let selectedCandidatePair: (String, String) -> Void

    public init(signal: @escaping (RelayRenewEnvelope) -> Void,
                localCandidate: @escaping (String, String?, UInt32?) -> Void,
                selectedCandidatePair: @escaping (String, String) -> Void) {
        self.signal = signal
        self.localCandidate = localCandidate
        self.selectedCandidatePair = selectedCandidatePair
    }
}

public protocol RelayRenewLinkTransport: AnyObject {
    /// Subscribe to this transport's renewal inputs, or unsubscribe with nil.
    ///
    /// Queue-safe by contract: a conformer stores the value on the same serial
    /// queue it delivers from, so an install never races a delivery, and an
    /// uninstall means no LATER event is delivered — which is what lets a
    /// controller fence a replaced transport instead of hoping it goes quiet.
    func installRenewalInputs(_ inputs: RelayRenewTransportInputs?)
    /// The pin taken from the description actually applied at epoch 0, or nil
    /// when none has been.
    var renewalBaselinePin: RelayRenewSDPPin? { get }
    /// A renewal epoch owns this connection's ICE, or no longer does.
    func setRenewalEpochInFlight(_ inFlight: Bool)
    /// A renewal signal from this peer has verified. Monotonic.
    func noteRenewalAuthenticated()
    func sendRenewalSignal(_ signal: JSONValue)
    func renewalApplyConfiguration(_ servers: [RTCIceServer],
                                   completion: @escaping (Bool) -> Void)
    func renewalCreateOffer(completion: @escaping (String?) -> Void)
    func renewalCreateAnswer(completion: @escaping (String?) -> Void)
    func renewalApplyRemoteDescription(sdp: String,
                                       type: RelayRenewSDPType,
                                       completion: @escaping (Bool) -> Void)
    func renewalAddRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: UInt32?)
}

extension WebRTCLinkTransport: RelayRenewLinkTransport {}
extension WebRTCLinkReplacementTransport: RelayRenewLinkTransport {}

/// The text lane's two renewal seams: the front demux inbound, and a control
/// frame outbound that never touches the conversation.
public protocol RelayRenewLanes: AnyObject {
    var renewDemux: RelayRenewProbeDemux! { get }
    func sendRenewalControlFrame(_ bytes: [UInt8]) -> Bool
}

extension LinkLaneOwner: RelayRenewLanes {}

/// Asks the hub for one round. The reply arrives asynchronously through
/// `RelayRenewController.receive(grant:)`.
public protocol RelayRenewRounds: AnyObject {
    func sendRenewRequest(round: UInt32, rid: UInt32)
}

extension SignalingClient: RelayRenewRounds {}

/// Wires `RelayRenewEngine` to one live link: its transport, its lanes, its
/// room socket, a clock and the activity record that decides whether to ask at
/// all.
///
/// ## What it is and is not responsible for
///
/// Every RULE is the engine's. This object performs effects, serialises them,
/// owns the timers, and reports the one outcome that matters — commit — back
/// to the surface that holds the deadline. It makes no policy decision of its
/// own, which is why the whole of spec §4, §5, §6 and §9 is testable without
/// any of the objects named here.
///
/// ## Serialisation
///
/// One private serial queue. The engine is not thread-safe and does not need to
/// be: inbound signals arrive on the transport's queue, frames on WebRTC's
/// delivery threads, grants on the socket's, timers on the scheduler's, and
/// every one of them hops here first. That also makes the HMAC verification
/// serialised — one at a time — which spec §3.5 and §6.4 both require.
///
/// The queue is a LEAF with respect to every object below it: an effect is
/// dispatched from it into a transport's own queue or a lane driver's lock, and
/// nothing those call comes back synchronously.
///
/// ## Lifetime
///
/// `close()` is terminal and idempotent. It cancels every timer, clears the
/// demux handler, releases the transport's epoch flag and stops the engine, so
/// no late callback — a `setConfiguration` completion, an in-flight
/// `createOffer`, a retransmit, a grant for a round nobody is waiting for —
/// can resurrect anything.
public final class RelayRenewController {
    private let queue = LinkTransportQueue(label: "im.relayium.RelayRenewController")
    private let engine: RelayRenewEngine
    private weak var transport: RelayRenewLinkTransport?
    private weak var lanes: RelayRenewLanes?
    private weak var rounds: RelayRenewRounds?
    private let scheduler: LinkRecoveryScheduler
    /// Turns one received configuration into the servers this connection should
    /// use, applying the room's existing relay selection. Injected because that
    /// is the app layer's policy, not a transport's.
    private let resolveServers: (ICEConfig) -> [RTCIceServer]

    /// §6.5 commit, and the only callback that may move a deadline. Carries the
    /// configuration actually received for the round, because the new deadline
    /// is derived from that and from nothing else.
    private let onCommit: (UInt32, ICEConfig) -> Void
    /// One epoch ended without committing. The OLD deadline stands; this is for
    /// logging and for a surface that wants to stop showing "renewing".
    /// A same-round repair completed. NOT a deadline event: the credential is
    /// the one this side was already bounded by. Diagnostic only.
    private let onRecommit: (UInt32) -> Void
    private let onEpochEnded: (UInt32, RelayRenewAbortReason) -> Void
    /// The peer does not implement renewal. The UI must not claim otherwise.
    private let onPeerUnsupported: () -> Void

    /// Which transport attachment is current. Every subscription closure
    /// captures the value it was installed under and drops its event if this
    /// has moved on: `installRenewalInputs(nil)` stops LATER deliveries, and
    /// this fences the ones already hopping between queues when a `link:§8`
    /// rebuild replaced the transport. Read and written only on `queue`.
    private var attachment = 0
    private var timers: [RelayRenewTimer: LinkRecoveryTimer] = [:]
    /// The margin window is open: user data may now re-trigger an attempt.
    private var marginOpen = false
    private var closed = false

    /// Work a peer has asked for that has not been done yet.
    ///
    /// Counted on the CALLING thread, before the closure is enqueued, and
    /// released after that closure has run. That ordering is the whole point:
    /// an earlier version incremented and decremented inside the serial queue,
    /// where the count could never exceed one and therefore bounded nothing at
    /// all — a peer could queue an unbounded number of closures, each holding
    /// an envelope, against a queue draining one at a time.
    ///
    /// The bound is on signals and frames together, because both are HMAC work
    /// a peer chose to ask for. Exceeding it drops the frame in silence, which
    /// is the same answer every other malformed or unverifiable input gets.
    private let admissionLock = NSLock()
    private var pendingPeerWork = 0
    private static let maxPendingPeerWork = 32

    public init(selfId: String,
                peerId: String,
                role: Role,
                resumeAuthKey: [UInt8],
                transport: RelayRenewLinkTransport,
                lanes: RelayRenewLanes,
                rounds: RelayRenewRounds,
                scheduler: LinkRecoveryScheduler = LinkDispatchRecoveryScheduler(),
                activity: RelayRenewActivityClock,
                resolveServers: @escaping (ICEConfig) -> [RTCIceServer],
                grantIsLive: @escaping () -> Bool,
                peerAnnouncedRenewal: @escaping () -> Bool,
                now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 },
                makeNonce: @escaping () -> [UInt8] = { randomRenewNonce() },
                onCommit: @escaping (UInt32, ICEConfig) -> Void,
                onRecommit: @escaping (UInt32) -> Void = { _ in },
                onEpochEnded: @escaping (UInt32, RelayRenewAbortReason) -> Void = { _, _ in },
                onPeerUnsupported: @escaping () -> Void = {}) {
        self.engine = RelayRenewEngine(
            selfId: selfId,
            peerId: peerId,
            role: role,
            baseline: transport.renewalBaselinePin,
            sign: { signResume(key: resumeAuthKey, payload: $0) },
            verify: { verifyResume(key: resumeAuthKey, payload: $0, mac: $1) },
            makeNonce: makeNonce,
            // Asked, not passed: a peer's `prepare` makes this side spend an
            // issuance too, so consenting to one is gated on this side's own
            // reading of its own link. See `RelayRenewEngine.userDataIsRecent`.
            userDataIsRecent: { activity.isActive(at: now()) },
            grantIsLive: grantIsLive,
            peerAnnouncedRenewal: peerAnnouncedRenewal)
        self.transport = transport
        self.lanes = lanes
        self.rounds = rounds
        self.scheduler = scheduler
        self.resolveServers = resolveServers
        self.onCommit = onCommit
        self.onRecommit = onRecommit
        self.onEpochEnded = onEpochEnded
        self.onPeerUnsupported = onPeerUnsupported

        // The demux handler is installed as the last act of construction, for
        // the reason the file driver installs its route last: a frame can
        // arrive on the very next line, and a controller that is not yet a
        // complete object cannot answer for one.
        install(on: lanes)
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            self.subscribe(to: transport)
        }
    }

    /// Subscribe to one transport's three renewal inputs, fenced by attachment.
    ///
    /// This is the half of the composition that did not exist: the lane demux
    /// was installed, and the three transport inputs were never subscribed to
    /// by anything, so in the real app no authenticated signal, no gathered
    /// candidate and no selected-pair change ever reached the engine. Always
    /// called on `queue`.
    private func subscribe(to transport: RelayRenewLinkTransport) {
        attachment += 1
        let mine = attachment
        transport.installRenewalInputs(RelayRenewTransportInputs(
            signal: { [weak self] envelope in
                self?.receive(envelope, attachment: mine)
            },
            localCandidate: { [weak self] sdp, mid, index in
                guard let self else { return }
                self.queue.later {
                    guard !self.closed, self.attachment == mine else { return }
                    self.run(self.engine.localCandidate(sdp: sdp, sdpMid: mid,
                                                        sdpMLineIndex: index))
                }
            },
            selectedCandidatePair: { [weak self] local, remote in
                guard let self else { return }
                self.queue.later {
                    guard !self.closed, self.attachment == mine else { return }
                    self.run(self.engine.selectedLocalCandidate(sdp: local, remote: remote))
                }
            }))
    }

    /// Install the demux handler, bounded by the same admission gate as
    /// signalling: an inbound control frame is HMAC work a peer chose to ask
    /// for, exactly like an inbound envelope.
    private func install(on lanes: RelayRenewLanes) {
        lanes.renewDemux.install { [weak self] frame in
            guard let self, self.admitPeerWork() else { return }
            self.queue.later {
                defer { self.releasePeerWork() }
                guard !self.closed else { return }
                self.run(self.engine.probeFrameReceived(frame))
            }
        }
    }

    /// Claim one unit of peer-driven work, or refuse it. Called BEFORE the
    /// closure is enqueued.
    private func admitPeerWork() -> Bool {
        admissionLock.lock(); defer { admissionLock.unlock() }
        guard pendingPeerWork < Self.maxPendingPeerWork else { return false }
        pendingPeerWork += 1
        return true
    }

    private func releasePeerWork() {
        admissionLock.lock(); defer { admissionLock.unlock() }
        pendingPeerWork -= 1
    }

    // MARK: - inputs

    /// The renewal margin opened for this link's current deadline.
    public func marginOpened() {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            self.marginOpen = true
            self.run(self.engine.evaluate())
        }
    }

    /// Authenticated user-lane traffic moved. Re-evaluates INSIDE the margin
    /// and nowhere else.
    ///
    /// This is the second half of the activity rule and the half that is easy
    /// to miss: the margin is a window, and a transfer that starts partway
    /// through it is a link being used. It is deliberately driven from the
    /// activity clock's own call sites rather than from a UI event.
    public func userDataMoved() {
        queue.later { [weak self] in
            guard let self, !self.closed, self.marginOpen else { return }
            self.run(self.engine.evaluate())
        }
    }

    /// One inbound renewal envelope, recognised by shape and NOT yet
    /// authenticated.
    private func receive(_ envelope: RelayRenewEnvelope, attachment mine: Int) {
        guard admitPeerWork() else { return }
        queue.later { [weak self] in
            guard let self else { return }
            defer { self.releasePeerWork() }
            // A signal delivered by a transport that has since been replaced is
            // dropped BEFORE any HMAC is spent on it.
            guard !self.closed, self.attachment == mine else { return }
            let before = self.engine.suppressesUnsignedLinkSDP
            let effects = self.engine.receive(envelope)
            if !before, self.engine.suppressesUnsignedLinkSDP {
                // Monotonic and authenticated: from here this connection
                // refuses unsigned `link`-generation SDP for the rest of its
                // life.
                self.transport?.noteRenewalAuthenticated()
            }
            self.run(effects)
        }
    }

    /// One `ice-grant` reply from the hub.
    public func receive(grant: RelayRenewGrant) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            self.run(self.engine.receive(grant: grant))
        }
    }

    /// A `link:§8` authenticated rebuild published a new transport. The epoch
    /// counter survives it; the pin baseline does not.
    public func transportRebuilt(_ transport: RelayRenewLinkTransport, lanes: RelayRenewLanes) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            // Unsubscribe the transport being replaced FIRST, so nothing it
            // still has in flight can be mistaken for the new one's.
            self.transport?.installRenewalInputs(nil)
            self.transport?.setRenewalEpochInFlight(false)
            self.transport = transport
            self.lanes = lanes
            self.install(on: lanes)
            self.subscribe(to: transport)
            self.run(self.engine.transportRebuilt(baseline: transport.renewalBaselinePin))
        }
    }

    /// Terminal and idempotent.
    public func close() {
        queue.nowOrLater { [weak self] in
            guard let self, !self.closed else { return }
            let effects = self.engine.close()
            self.closed = true
            self.run(effects)
            for timer in self.timers.values { timer.cancel() }
            self.timers = [:]
            self.lanes?.renewDemux?.clear()
            self.attachment += 1
            self.transport?.installRenewalInputs(nil)
            self.transport?.setRenewalEpochInFlight(false)
        }
    }

    // MARK: - performing effects

    private func run(_ effects: [RelayRenewEffect]) {
        // No early return for an empty list: the flag below has to follow the
        // engine even when a step produced no effect — the post-commit window
        // closing is exactly that, and it is what hands local candidates back
        // to the ordinary path.
        // The epoch flag is derived from the engine's own answer rather than
        // set case by case, so every exit — commit, abort, timeout, adoption of
        // a higher epoch, close — releases it. Setting it in each branch is how
        // a link ends up with ordinary candidate trickle silenced for good.
        defer { transport?.setRenewalEpochInFlight(engine.ownsLocalCandidates) }
        for effect in effects {
            switch effect {
            case let .sendSignal(signal):
                transport?.sendRenewalSignal(signal)
            case let .requestRound(round, rid):
                rounds?.sendRenewRequest(round: round, rid: rid)
            case let .applyConfiguration(config, epoch):
                let servers = resolveServers(config)
                transport?.renewalApplyConfiguration(servers) { [weak self] ok in
                    guard let self else { return }
                    self.queue.later {
                        guard !self.closed else { return }
                        self.run(self.engine.configurationApplied(epoch: epoch, ok: ok))
                    }
                }
            case let .createOffer(epoch):
                transport?.renewalCreateOffer { [weak self] sdp in
                    self?.localDescription(epoch: epoch, type: .offer, sdp: sdp)
                }
            case let .createAnswer(epoch):
                transport?.renewalCreateAnswer { [weak self] sdp in
                    self?.localDescription(epoch: epoch, type: .answer, sdp: sdp)
                }
            case let .applyRemoteDescription(sdp, type, epoch):
                transport?.renewalApplyRemoteDescription(sdp: sdp, type: type) { [weak self] ok in
                    guard let self else { return }
                    self.queue.later {
                        guard !self.closed else { return }
                        self.run(self.engine.remoteDescriptionApplied(epoch: epoch, ok: ok))
                    }
                }
            case let .addRemoteCandidate(candidate, mid, index):
                transport?.renewalAddRemoteCandidate(candidate: candidate,
                                                     sdpMid: mid,
                                                     sdpMLineIndex: index)
            case let .sendProbeFrame(frame):
                // Outside the text send queue, by construction. A refusal here
                // is not a lane failure: the epoch simply runs out of time and
                // the old deadline stands.
                _ = lanes?.sendRenewalControlFrame(frame)
            case let .armTimer(timer, delay):
                arm(timer, after: delay)
            case let .cancelTimer(timer):
                timers.removeValue(forKey: timer)?.cancel()
            case let .commit(round, config):
                // The margin for the OLD deadline is spent. A fresh one opens
                // when the surface arms the deadline this configuration states.
                marginOpen = false
                onCommit(round, config)
            case let .recommitted(round):
                // Deliberately does NOT touch `marginOpen` or any deadline.
                onRecommit(round)
            case let .epochEnded(epoch, reason):
                onEpochEnded(epoch, reason)
            case .peerUnsupported:
                onPeerUnsupported()
            }
        }
    }

    private func localDescription(epoch: UInt32, type: RelayRenewSDPType, sdp: String?) {
        queue.later { [weak self] in
            guard let self, !self.closed else { return }
            guard let sdp else {
                // A description this side could not produce or apply is a dead
                // epoch, and reporting it as such is what stops the attempt
                // sitting on the hard cap for a further minute.
                self.run(self.engine.timerFired(.epochHardCap(epoch: epoch)))
                return
            }
            self.run(self.engine.localDescriptionApplied(epoch: epoch, type: type, sdp: sdp))
        }
    }

    private func arm(_ timer: RelayRenewTimer, after delay: TimeInterval) {
        timers.removeValue(forKey: timer)?.cancel()
        timers[timer] = scheduler.schedule(after: delay) { [weak self] in
            guard let self else { return }
            self.queue.later {
                guard !self.closed else { return }
                // Consumed before it runs: a one-shot wake-up that stayed in
                // the table could be cancelled by a later epoch and appear to
                // have been taken back when it had already fired.
                guard self.timers.removeValue(forKey: timer) != nil else { return }
                self.run(self.engine.timerFired(timer))
            }
        }
    }
}

/// A fresh 16-byte probe nonce.
///
/// `SecRandomCopyBytes` rather than a pseudo-random generator, and a failure is
/// an empty array rather than a fallback: a nonce this side cannot prove is
/// fresh is not a nonce, and a predictable one would let an observer pre-compute
/// nothing useful but would still weaken the one freshness guarantee the probe
/// rests on. An empty array makes `relayRenewProbeFrame` return nil, the probe
/// is not sent, the epoch times out, and the old deadline stands.
public func randomRenewNonce() -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: RENEW_PROBE_NONCE_BYTES)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        return []
    }
    return bytes
}
