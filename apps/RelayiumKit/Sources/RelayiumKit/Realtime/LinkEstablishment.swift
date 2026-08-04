import Foundation

/// Whether THIS build can rebuild a link's transport under an authentication
/// that already exists.
///
/// A plain constant, for the same reason `LINK_BUILD_SUPPORT` is one: the
/// answer is a property of the code that shipped, not of a room, a peer or a
/// runtime flag, and a reader deciding whether recovery exists must not have to
/// infer it from what a driver happens to implement today.
///
/// It is false, and what it is false ABOUT has moved twice. A replacement
/// CONNECTION exists — `WebRTCLinkReplacementTransport` rebuilds both lanes under
/// one already-authenticated `LinkIdentity`, authenticating its own signalling
/// with that link's `resumeAuth` key. A COORDINATOR now exists too:
/// `LinkRecoveryCoordinator` turns a terminal transport into one bounded gap,
/// verifies an inbound resume offer before allocating anything, drives or awaits
/// the rebuild in the inherited role, and publishes the winner atomically under
/// the same identity. What does not exist is everything else a link would have
/// to rely on:
///
///  - no durable file checkpoints and no RESUME_REQ/RESUME_START, so a rebuilt
///    lane resumes a connection, not a transfer;
///  - no file- or text-lane integration: nothing implements the coordinator's
///    suspend-and-reattach hooks, and a text lane whose codecs proved unsafe to
///    reuse still has no policy;
///  - no END acknowledgement timing and no ICE restart;
///  - no lifecycle or UI integration — the coordinator drives `LinkAdmission`'s
///    interrupt/replace transitions and nothing above them — and
///    `LINK_BUILD_SUPPORT` is still false, so no peer is ever told this build
///    speaks `link/1`;
///  - no native↔Web evidence for any of it.
///
/// A caller deciding whether recovery exists must read this constant, not infer
/// it from the existence of a driver. The invariant the replacement driver rests
/// on is separate and is enforced structurally: it never derives session keys
/// and never constructs a `LinkCodecs`, it is handed the one its link already
/// owns (`LinkEstablishment.init(resuming:)`), and `authenticated` refusing a
/// second identity is the backstop underneath that.
public let LINK_TRANSPORT_REPLACEMENT_SUPPORTED = false

/// One of the exact two lanes of a `link/1` transport.
///
/// A closed type rather than a label string, so "which lane" is decided once,
/// at the boundary where a peer-supplied label is turned into something this
/// code will act on. Everything above it selects a lane by case and can never
/// name a third one.
public enum LinkLane: Equatable, Sendable, CaseIterable {
    case file
    case text

    public var label: String {
        switch self {
        case .file: return LINK_FILE_CHANNEL
        case .text: return LINK_TEXT_CHANNEL
        }
    }

    /// Nil for every label outside the exact pair — including the legacy `data`
    /// label, which must never be adopted as a link lane.
    public init?(label: String) {
        switch label {
        case LINK_FILE_CHANNEL: self = .file
        case LINK_TEXT_CHANNEL: self = .text
        default: return nil
        }
    }
}

/// Why a candidate link/1 transport failed, or refused an operation.
///
/// Every case is terminal for the transport except `notReady`/`laneUnavailable`
/// /`sendFailed`, which refuse one send without ending anything: a caller that
/// asked too early, or asked for a lane whose channel is gone, has made a
/// mistake this transport can survive.
public enum LinkTransportError: Error, Equatable {
    /// A channel arrived on a label outside the exact pair. Terminal for the
    /// whole candidate link — see `LinkEstablishment.collect`.
    case unexpectedLane(String)
    /// A second channel on a label already held. Never replaces the first.
    case duplicateLane(String)
    /// A lane went `closing`/`closed` before the transport was published.
    case laneClosedBeforeReady(String)
    /// A published lane closed. This slice has no recovery, so it is terminal.
    case laneClosed(String)
    /// The peer spoke before consumers existed, past the bounded capture. A
    /// dropped admitted frame is exactly what the receiver codecs cannot
    /// tolerate, so this fails closed rather than truncating.
    case captureOverflow
    /// The peer's first SDP did not confirm exact `link/1`.
    case unsupportedPeer
    /// An SDP on the link generation carried no commit, so its handshake could
    /// never be verified.
    case missingPeerCommit
    /// The peer answered our establishment with `busy` on the link generation.
    case peerBusy
    /// The `RTCPeerConnection` reached `.failed`.
    case peerConnectionFailed
    /// A local step (channel creation, offer/answer) could not be performed.
    case notReady
    /// The lane exists in the protocol but this transport has no open channel
    /// for it.
    case laneUnavailable(LinkLane)
    /// The channel refused the frame (SCTP send queue full, or shutting down).
    case sendFailed(LinkLane)
    /// ICE candidates piled up past `LINK_PENDING_CANDIDATE_MAX` while waiting
    /// for the description they belong to. Terminal, because the alternative is
    /// dropping candidates — and the earliest ones are the host candidates a LAN
    /// link depends on.
    case pendingCandidateOverflow(LinkCandidateDirection)
    /// An establishment deadline expired before the transport was published.
    /// Which one is the difference between "the peer stopped answering" and
    /// "the lanes are up but the peer never disclosed its key" — see
    /// `LinkTimeout`.
    case establishmentTimeout(LinkTimeout)
    /// The transport is closed.
    case closed
}

/// One reliable ordered DataChannel, as everything above the WebRTC layer needs
/// to see it.
///
/// The seam exists because the whole of `LinkEstablishment` below — arrival
/// order, the readiness barrier, exact-label admission, capture and replay,
/// send readiness — is decidable without a live peer, and none of it is
/// testable against a real `RTCDataChannel`, which cannot be opened without two
/// negotiating endpoints. `WebRTCLinkTransport` adapts the real channel to this
/// protocol; tests substitute a fake.
public protocol LinkLaneChannel: AnyObject {
    var laneLabel: String { get }
    /// Exactly `RTCDataChannelState.open`. Connecting is not open.
    var laneIsOpen: Bool { get }
    /// `closing` or `closed`. A lane that reaches this before publication fails
    /// the link closed.
    var laneIsTerminal: Bool { get }
    var laneBufferedAmount: UInt64 { get }
    @discardableResult func laneSend(_ bytes: [UInt8]) -> Bool
    func laneClose()
}

/// The orchestration of ONE initial `link/1` transport: which channels are
/// admitted, when the transport may be published, what happens to frames that
/// arrive before a consumer exists, and whether a send is allowed.
///
/// ## Why this is a separate object
///
/// `RealtimeConnection` records the cost of the alternative: it is
/// "INTEGRATION-TESTED, NOT UNIT-TESTED" because its orchestration is welded to
/// `RTCPeerConnection`, so every ordering question it answers can only be
/// exercised by two live peers. The questions this class answers are exactly
/// the ones that go wrong in ways a live test is worst at reproducing — the
/// text lane opening first, a duplicate label, a peer that speaks before the
/// consumer is attached, a lane that closes one instant before the barrier
/// would have lifted. Keeping them here makes them ordinary unit tests.
///
/// ## The publication barrier
///
/// Nothing is published until BOTH exact lanes are collected, BOTH are open,
/// and the peer's reveal has been verified into a `LinkIdentity`. A link whose
/// text lane never opened is not a degraded link; a link whose SAS is not yet
/// derived has nothing to say. Publication happens at most once.
///
/// ## Thread safety
///
/// Deliberately none of its own: the owner serializes. `WebRTCLinkTransport`
/// calls every method from its private serial queue, which is also the queue
/// its client callbacks fire on, so the whole publish-then-replay sequence is
/// indivisible with respect to newly arriving frames. `LinkFrameCapture` keeps
/// its own lock because WebRTC delivers on its own threads; this class sees
/// only what the owner has already serialized.
///
/// ## Establishment and replacement share this object
///
/// An initial establishment derives its identity and hands it over through
/// `authenticated`; a transport replacement is handed one at construction
/// (`init(resuming:)`) and never calls `authenticated` at all. Everything else —
/// the exact lane set, the barrier, capture and replay, send readiness — is
/// identical, and deliberately so: those questions have one answer per link, not
/// one per way of reaching it.
///
/// What stays constant either way is that a link has exactly ONE identity.
/// `authenticated` refuses a second, which for a replacement means it cannot
/// acquire a second `LinkCodecs` even if something above it produced one. What
/// this object still does not decide is whether a replacement may be used at
/// all — see `LINK_TRANSPORT_REPLACEMENT_SUPPORTED`.
public final class LinkEstablishment {

    /// What one event means for the transport as a whole.
    public enum Step: Equatable {
        case none
        /// The barrier has lifted. The owner must call `publish()` exactly once
        /// and replay what it returns.
        case publish
        /// Terminal. The owner must report this and close.
        case fail(LinkTransportError)
    }

    /// What one inbound frame means.
    public enum Inbound: Equatable {
        /// Held until publication, in per-lane FIFO order.
        case captured
        /// Hand it to the consumer on this exact lane, now.
        case deliver(LinkLane)
        /// Not from a lane this transport holds, or the transport is closed.
        case ignore
        /// Terminal — the bounded capture overflowed.
        case fail(LinkTransportError)
    }

    private var channels: [String: LinkLaneChannel] = [:]
    private var admitted = LinkChannelSet()
    private let capture: LinkFrameCapture
    private var _identity: LinkIdentity?
    private var _isPublished = false
    private var _isClosed = false

    /// - Parameter resuming: the authenticated identity this transport is being
    ///   rebuilt UNDER, for an authenticated replacement; nil for an initial
    ///   establishment, which derives its own.
    ///
    ///   Handing it in at construction rather than through `authenticated` is
    ///   what makes the replacement invariant structural. A replacement must not
    ///   be able to produce an identity — that would mean a second `LinkCodecs`,
    ///   and two AEAD sequences counting from zero under one pair of session
    ///   keys — and with the identity already present, `authenticated`'s
    ///   existing "first one wins" rule refuses any later one without needing a
    ///   second guard. The barrier is then waiting on the lanes alone, which is
    ///   exactly what a rebuild is still waiting for.
    public init(resuming identity: LinkIdentity? = nil,
                capture: LinkFrameCapture = LinkFrameCapture()) {
        self._identity = identity
        self.capture = capture
    }

    /// The link's authenticated identity, once its reveal has been verified.
    /// It owns the one `LinkCodecs` for the link's whole lifetime.
    public var identity: LinkIdentity? { _identity }
    public var isPublished: Bool { _isPublished }
    public var isClosed: Bool { _isClosed }
    /// Both exact lanes admitted. Not the same as ready: they may be connecting.
    public var hasBothLanes: Bool { admitted.isComplete }

    /// Exactly the lanes whose channels are open RIGHT NOW.
    ///
    /// Exposed because a lane opening is one of the establishment milestones a
    /// deadline may be extended for, and the owner must not have to keep its own
    /// second map of channel states alongside this one — two answers to "is the
    /// text lane open" is how a watchdog ends up re-arming on a lane that has
    /// since closed.
    public var openLanes: Set<LinkLane> {
        Set(LinkLane.allCases.filter { channels[$0.label]?.laneIsOpen == true })
    }

    // MARK: - channel collection

    /// Admit one channel — created locally by the initiator, or opened remotely
    /// and handed over by the responder's `didOpen`.
    ///
    /// A duplicate or unexpected label fails the ENTIRE candidate link rather
    /// than closing just that channel, which is a deliberate divergence from
    /// `web/src/lib/webrtc-core.ts` (it drops the offending channel and keeps
    /// waiting). The web can afford that because its own peer opens exactly the
    /// labels it declares; on this side the same event means the peer is not
    /// speaking `link/1` as this build understands it, and the honest answer to
    /// that is to stop rather than to build a link on a wire whose two ends
    /// disagree. The rejected channel is closed here, so the caller cannot
    /// forget to; it is never stored, so the first channel on a label can never
    /// be silently replaced.
    public func collect(_ channel: LinkLaneChannel) -> Step {
        guard !_isClosed else {
            channel.laneClose()
            return .none
        }
        switch admitted.admit(label: channel.laneLabel) {
        case .unexpected:
            channel.laneClose()
            return .fail(.unexpectedLane(channel.laneLabel))
        case .duplicate:
            channel.laneClose()
            return .fail(.duplicateLane(channel.laneLabel))
        case .accepted:
            break
        }
        channels[channel.laneLabel] = channel
        // A channel handed over already dying is not a lane. Checked here as
        // well as in `laneStateChanged` because a responder can be given a
        // channel whose peer has already gone, and that transition produces no
        // further state callback.
        if channel.laneIsTerminal {
            return .fail(.laneClosedBeforeReady(channel.laneLabel))
        }
        return readyStep()
    }

    /// One collected channel changed state.
    ///
    /// Addressed by LABEL, not by object, so the caller does not have to
    /// maintain a second identity map alongside the one this class already
    /// holds — and so a state callback arriving for a channel this class
    /// rejected cannot be answered on behalf of the one it kept.
    public func laneStateChanged(label: String) -> Step {
        guard !_isClosed, let channel = channels[label] else { return .none }
        if channel.laneIsTerminal {
            return .fail(_isPublished ? .laneClosed(label) : .laneClosedBeforeReady(label))
        }
        return readyStep()
    }

    // MARK: - authentication

    /// The peer's reveal verified: this link now has an identity, and with it
    /// the one `LinkCodecs` it will use for its whole life.
    ///
    /// A second identity is REFUSED rather than replacing the first. Two
    /// identities would mean two `LinkCodecs`, which means two AEAD sequences
    /// counting from zero under one pair of session keys. There is no legitimate
    /// producer of a second one on an initial establishment — a duplicate
    /// reveal is already suppressed a layer up — so this is the backstop, not
    /// the mechanism.
    public func authenticated(_ identity: LinkIdentity) -> Step {
        guard !_isClosed, _identity == nil else { return .none }
        _identity = identity
        return readyStep()
    }

    private func readyStep() -> Step {
        guard !_isClosed, !_isPublished, _identity != nil, admitted.isComplete else {
            return .none
        }
        for lane in LinkLane.allCases {
            guard let channel = channels[lane.label], channel.laneIsOpen else { return .none }
        }
        return .publish
    }

    /// Publish the transport, then deliver everything the peer said before a
    /// consumer existed, per-lane FIFO. Returns false — doing nothing — unless
    /// the barrier is actually lifted, so a caller cannot publish twice or
    /// publish early.
    ///
    /// ## Why this takes the callbacks instead of returning the frames
    ///
    /// Because "publish, then replay, with nothing in between" and "stop the
    /// instant the consumer says stop" are the same invariant, and a caller
    /// handed an array cannot honour the second one. A consumer's natural
    /// attachment point is `ready` — it is where the identity its lane
    /// consumers need first exists — and a consumer that inspects the identity
    /// and closes there must not then have the whole backlog pushed at it.
    /// `frame` has the same property: closing from inside a replayed frame
    /// stops the next one rather than the one after the last.
    ///
    /// The closedness consulted is THIS object's, which is what makes the rule
    /// testable without a transport: an owner tears this down as the first step
    /// of its own teardown, so `close()` reaching here is exactly the signal
    /// that the consumer is gone.
    @discardableResult
    public func publish(ready: (LinkIdentity) -> Void,
                        frame: (LinkLane, [UInt8]) -> Void) -> Bool {
        guard case .publish = readyStep(), let identity = _identity else { return false }
        _isPublished = true
        // Taken BEFORE `ready` runs: from this point `inbound` answers
        // `.deliver`, and a frame arriving during the replay must not be able to
        // reach the capture the replay is draining.
        let captured = capture.take()
        ready(identity)
        for bytes in captured.file {
            guard !_isClosed else { return true }
            frame(.file, bytes)
        }
        for bytes in captured.text {
            guard !_isClosed else { return true }
            frame(.text, bytes)
        }
        return true
    }

    // MARK: - inbound frames

    /// One frame off a lane.
    ///
    /// Before publication it is captured under a bound that covers both lanes
    /// together; overflow is terminal, never silent truncation. After
    /// publication it goes straight to the consumer.
    public func inbound(label: String, frame: [UInt8]) -> Inbound {
        guard !_isClosed, let lane = LinkLane(label: label), channels[label] != nil else {
            return .ignore
        }
        if _isPublished { return .deliver(lane) }
        capture.capture(label: label, frame: frame)
        if capture.overflowed { return .fail(.captureOverflow) }
        return .captured
    }

    // MARK: - outbound

    /// Send raw bytes on ONE exact lane.
    ///
    /// Deliberately raw: what a lane carries is decided by `LinkTextLane` and by
    /// the file lane's own policy, and neither belongs in a transport. This
    /// refuses before publication — the codecs a frame would come from do not
    /// exist yet, and a frame sent before the peer's reveal is verified would be
    /// a frame sent to an unauthenticated peer.
    public func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        guard !_isClosed else { throw LinkTransportError.closed }
        guard _isPublished else { throw LinkTransportError.notReady }
        guard let channel = channels[lane.label], channel.laneIsOpen else {
            throw LinkTransportError.laneUnavailable(lane)
        }
        guard channel.laneSend(bytes) else { throw LinkTransportError.sendFailed(lane) }
    }

    /// Bytes still queued on one lane. Zero for a lane with no channel, which is
    /// the truthful answer: nothing of ours is waiting on it.
    public func bufferedAmount(on lane: LinkLane) -> UInt64 {
        channels[lane.label]?.laneBufferedAmount ?? 0
    }

    // MARK: - teardown

    /// Idempotent. Returns true only for the call that actually closed, so the
    /// owner can fire its own close callback exactly once without keeping a
    /// second flag that can drift out of step with this one.
    @discardableResult
    public func close() -> Bool {
        guard !_isClosed else { return false }
        _isClosed = true
        for channel in channels.values { channel.laneClose() }
        channels.removeAll()
        // Release the identity, and with it the link's one `LinkCodecs` and the
        // session keys inside it. The consumer was handed its own reference at
        // publication and owns it from there; holding a second one here would
        // keep key material alive for the lifetime of a transport object that
        // has nothing left to do, and would let a caller read an identity off a
        // transport it has already closed.
        _identity = nil
        // Drop anything captured but never delivered: it belongs to codecs that
        // are going away with this transport, and holding peer-supplied bytes
        // past the point they can be used is only a way to hold memory.
        _ = capture.take()
        return true
    }
}
