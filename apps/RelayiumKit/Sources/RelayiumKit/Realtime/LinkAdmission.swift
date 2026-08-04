import Foundation

/// Where the one link is in its lifecycle.
///
/// One link at a time is the whole admission rule. A second link would mean two
/// authenticated peers sharing one workspace surface, two SAS values the user
/// is asked to compare, and no answer to "which peer did that file come from".
public enum LinkPhase: Equatable, Sendable {
    case idle
    /// This side asked the smaller-id peer to offer, and is waiting.
    case requesting(peerId: String)
    /// A transport is being built, in either role.
    case connecting(peerId: String)
    case open(peerId: String)
    /// Authenticated, with no transport under it while a rebuild is attempted.
    case interrupted(peerId: String)
    case failed
}

/// What the driver must do with one inbound signal.
public enum LinkAdmissionDecision: Equatable, Sendable {
    /// Not this router's business, or already handled. Send nothing.
    case ignore
    /// Tell the peer we cannot take it, on the link generation.
    case busy
    /// Build a link with this peer in this role.
    case establish(role: Role)
    /// An attempt with this exact peer is already running. Deliberately its own
    /// case rather than `ignore`: same-peer idempotence is a property worth
    /// being able to observe, and it is what stops a crossing request from
    /// spawning a second PeerConnection into the same pair of lanes.
    case alreadyInFlight
    /// Our own outstanding request was refused.
    case requestRefused
    /// An authenticated rebuild offer for the interrupted link. The tag is NOT
    /// verified here — see `LinkAdmission.route`.
    case resumeOffer
    /// An authenticated departure. The tag is not verified here either; the
    /// budget that bounds how much verification work a flood can buy is.
    case leave(auth: String)
}

/// What local intent resolves to.
public enum LinkIntent: Equatable, Sendable {
    case existing
    case joinInFlight
    /// A held link whose transport is being rebuilt. Intent raised mid-gap must
    /// join that rebuild rather than attach to the dead transport the link still
    /// points at.
    case recovering
    case establish(role: Role)
    /// Ask the smaller-id peer to offer.
    case request
    case unsupported
    case busy
}

/// One-link admission and inbound signal routing for `link/1`.
///
/// ## Why this is a pure object
///
/// Every clause below is a way two peers deadlock, build competing transports,
/// or answer somebody who has no business being answered — and none of it can
/// be exercised against a live `RTCPeerConnection` in a unit test. Keeping the
/// decisions here, and only the mechanics above, is what makes glare, late
/// offers, replayed leaves and stale rebuilds testable at all.
///
/// ## What it does NOT decide
///
/// It never verifies a tag. `resumeOffer` and `leave` are routing decisions:
/// they say "this is worth spending a verification on", and the driver — which
/// holds the session keys — does the spending. That split is deliberate. It
/// keeps every cheap check (shape, peer, phase, role, budget) ahead of the
/// expensive one, so a forged or replayed signal cannot buy HMAC work.
///
/// ## The security claim, stated honestly
///
/// A forged capability or a forged link signal can at worst DENY SERVICE. It
/// cannot activate a different room or generation, and it cannot deliver
/// plaintext: the session keys are derived through commit/reveal above this
/// layer, so there is no downgrade path for a routing decision to reach.
///
/// Thread-safe by lock rather than by actor isolation, for the reason
/// `InboundGate` records: the decision has to be made in the same instant the
/// signal is seen, on the socket's delivery queue. Hopping to the main actor
/// first would let two signals in one burst both find the gate open.
public final class LinkAdmission: @unchecked Sendable {
    private let lock = NSLock()
    private let selfId: () -> String
    private let supportsLink: (String) -> Bool
    private let canAcceptLink: (String) -> Bool

    private var _phase: LinkPhase = .idle
    /// The role that produced the current link's keys. Both sides keep the
    /// deterministic offerer/responder split their first connection produced, so
    /// a rebuild cannot turn two peers into two offerers.
    private var establishedRole: Role?
    private var replacingTransport = false
    /// Peers whose request from this side timed out. One late offer from each is
    /// consumed and answered explicitly, rather than black-holing that peer for
    /// the rest of the session.
    private var timedOutPeers: Set<String> = []
    /// HMACs spent on inbound leave signals for the CURRENT authenticated link.
    /// A transport replacement is the same authentication step and deliberately
    /// does not refill it.
    private var leaveAttempts = 0

    public init(selfId: @escaping () -> String,
                supportsLink: @escaping (String) -> Bool,
                canAcceptLink: @escaping (String) -> Bool = { _ in true }) {
        self.selfId = selfId
        self.supportsLink = supportsLink
        self.canAcceptLink = canAcceptLink
    }

    public var phase: LinkPhase {
        lock.lock(); defer { lock.unlock() }
        return _phase
    }

    /// The peer this admission is bound to in ANY lifecycle phase, or "".
    ///
    /// A server-confirmed departure uses this broader view to cancel an
    /// establishment in flight as well as an established link, so that is one
    /// check rather than four that can drift apart.
    public var boundPeerId: String {
        lock.lock(); defer { lock.unlock() }
        return peerIdLocked
    }

    private var peerIdLocked: String {
        switch _phase {
        case .idle, .failed: return ""
        case let .requesting(peerId), let .connecting(peerId),
             let .open(peerId), let .interrupted(peerId):
            return peerId
        }
    }

    // MARK: - local intent

    public func ensure(peerId: String) -> LinkIntent {
        guard supportsLink(peerId) else { return .unsupported }
        // Read BEFORE the lock, unconditionally. `selfId` is owner-supplied and
        // may read this admission back — asking `phase` what it is currently
        // doing is the obvious implementation — and `NSLock` is not recursive,
        // so evaluating it in the idle branch below would self-deadlock the
        // caller. Paying for it on every call is the price of that being
        // impossible rather than merely unlikely; it is a stored identity, not
        // work. See the same rule on `route`'s two establishment paths.
        let mine = selfId()
        lock.lock(); defer { lock.unlock() }
        switch _phase {
        case let .open(held):
            return held == peerId ? .existing : .busy
        case let .interrupted(held):
            return held == peerId ? .recovering : .busy
        case let .connecting(held), let .requesting(held):
            return held == peerId ? .joinInFlight : .busy
        case .idle, .failed:
            // A larger-id peer must NEVER offer. Two offers into one pair of
            // lanes is the failure the deterministic role rule exists to remove.
            return linkRole(selfId: mine, peerId: peerId) == .initiator
                ? .establish(role: .initiator)
                : .request
        }
    }

    // MARK: - routing

    public func route(from: String, signal: JSONValue) -> LinkAdmissionDecision {
        // A refusal of our own outstanding request. Checked first because it is
        // the cheapest and cannot be confused with anything else.
        if isLinkBusy(signal) {
            lock.lock(); defer { lock.unlock() }
            guard case let .requesting(peerId) = _phase, peerId == from else { return .ignore }
            _phase = .failed
            return .requestRefused
        }

        // An authenticated departure, recognised by exact shape BEFORE anything
        // cryptographic runs — so a message that merely claims to be one cannot
        // also smuggle SDP, ICE, a commit or a caps list past the handlers that
        // share this generation.
        if let auth = parsedLinkLeaveAuth(signal) {
            lock.lock(); defer { lock.unlock() }
            guard peerIdLocked == from else { return .ignore }
            switch _phase {
            case .open, .interrupted: break
            default: return .ignore
            }
            guard leaveAttempts < LINK_LEAVE_MAX_ATTEMPTS else { return .ignore }
            leaveAttempts += 1
            return .leave(auth: auth)
        }

        // A rebuild offer for an interrupted link. Deliberately ahead of the
        // establishment clauses: it shares the `resume` generation with a legacy
        // one-shot file resume, and the only thing that separates the two is the
        // tag each verifies under.
        if signalGeneration(signal) == .resume, parseSDP(signal)?.type == "offer" {
            lock.lock(); defer { lock.unlock() }
            guard case let .interrupted(peerId) = _phase, peerId == from else { return .ignore }
            // The responder answers the initiator's authenticated offer; the
            // initiator drives its own rebuild. Consuming an inbound one on the
            // initiator side would put two PeerConnections into the same lanes.
            guard establishedRole == .responder else { return .ignore }
            guard !replacingTransport else { return .ignore }
            // No tag at all is not worth a verification.
            guard case let .object(fields) = signal, case .string? = fields["auth"] else {
                return .ignore
            }
            return .resumeOffer
        }

        if isLinkRequest(signal) {
            // Capability first, so a peer that never announced `link/1` cannot be
            // dialled by a relay that forged a request on its behalf.
            guard supportsLink(from) else { return .ignore }
            // A request that reached the wrong side is dropped in silence.
            guard linkRole(selfId: selfId(), peerId: from) == .initiator else { return .ignore }
            guard canAcceptLink(from) else { return .busy }
            lock.lock(); defer { lock.unlock() }
            switch _phase {
            case .open, .interrupted:
                return .busy
            case let .connecting(peerId), let .requesting(peerId):
                return peerId == from ? .alreadyInFlight : .busy
            case .idle, .failed:
                return .establish(role: .initiator)
            }
        }

        if isLinkOffer(signal) {
            guard supportsLink(from) else { return .ignore }
            guard linkRole(selfId: selfId(), peerId: from) == .responder else { return .ignore }
            // Consume ONE late offer from a timed-out attempt and tell its sender
            // explicitly to retry, instead of leaving that peer unreachable for
            // the rest of the session. Its own critical section, so the closure
            // below runs with nothing held — and ahead of that closure so a mark
            // that ALREADY existed is answered without consulting the owner at
            // all. Its answer could not change the outcome, and spending a call
            // on it would put an owner-visible side effect on a path that is
            // purely bookkeeping.
            lock.lock()
            let wasTimedOut = timedOutPeers.remove(from) != nil
            lock.unlock()
            if wasTimedOut { return .busy }
            // Deliberately OUTSIDE the lock, exactly as the request path above
            // already evaluates it. `canAcceptLink` is owner-supplied and may
            // read this admission back — a session model asking `phase` what it
            // is currently doing is the obvious implementation — and `NSLock` is
            // not recursive, so calling it while held is a self-deadlock on the
            // signalling delivery queue.
            guard canAcceptLink(from) else { return .busy }
            lock.lock(); defer { lock.unlock() }
            // The predicate above is arbitrary owner code running with nothing
            // held, so the world it returns into is not the world it was called
            // in. A `canAcceptLink` that gives up on its own outstanding request
            // — `didRequestTimeOut`, from a session model deciding it cannot
            // take this peer — creates a timeout mark AFTER the consumption
            // above already looked. Deciding the phase without re-reading it
            // would answer `establish` on an attempt this side has just
            // abandoned AND leave the mark standing, so the peer's next, genuine
            // offer is the one refused. The mark is consumed and answered here,
            // in the same critical section as the phase it belongs to.
            if timedOutPeers.remove(from) != nil { return .busy }
            switch _phase {
            case .open, .interrupted:
                return .busy
            case let .connecting(peerId):
                return peerId == from ? .alreadyInFlight : .busy
            case let .requesting(peerId):
                // Our request crossed the peer's offer: adopt the offer. That is
                // the convergence the whole request mechanism exists to produce.
                return peerId == from ? .establish(role: .responder) : .busy
            case .idle, .failed:
                return .establish(role: .responder)
            }
        }

        return .ignore
    }

    // MARK: - lifecycle, driven by the transport owner

    public func didBeginRequesting(peerId: String) {
        lock.lock()
        timedOutPeers.remove(peerId)
        _phase = .requesting(peerId: peerId)
        lock.unlock()
    }

    public func didRequestTimeOut(peerId: String) {
        lock.lock()
        guard case let .requesting(held) = _phase, held == peerId else {
            lock.unlock()
            return
        }
        timedOutPeers.insert(peerId)
        _phase = .failed
        lock.unlock()
    }

    public func didBeginEstablishing(peerId: String, role: Role) {
        lock.lock()
        establishedRole = role
        _phase = .connecting(peerId: peerId)
        lock.unlock()
    }

    /// A NEW authenticated link. Refills the leave budget, because this is a
    /// different authentication step whose peer deserves its one genuine leave.
    public func didOpen(peerId: String) {
        lock.lock()
        _phase = .open(peerId: peerId)
        leaveAttempts = 0
        replacingTransport = false
        lock.unlock()
    }

    public func didInterrupt() {
        lock.lock()
        if case let .open(peerId) = _phase { _phase = .interrupted(peerId: peerId) }
        lock.unlock()
    }

    public func didBeginReplacingTransport() {
        lock.lock()
        replacingTransport = true
        lock.unlock()
    }

    /// The SAME authentication step on a new transport. Deliberately does not
    /// refill the leave budget: a peer that has already spent it must not earn a
    /// fresh one by dropping the connection.
    public func didReplaceTransport(peerId: String) {
        lock.lock()
        _phase = .open(peerId: peerId)
        replacingTransport = false
        lock.unlock()
    }

    public func didFail() {
        lock.lock()
        _phase = .failed
        replacingTransport = false
        lock.unlock()
    }

    public func didClose() {
        lock.lock()
        _phase = .idle
        establishedRole = nil
        replacingTransport = false
        leaveAttempts = 0
        timedOutPeers.removeAll()
        lock.unlock()
    }
}
