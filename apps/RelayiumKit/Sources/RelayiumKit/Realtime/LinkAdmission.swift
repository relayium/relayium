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

/// How an outstanding request ended, and therefore what it leaves behind.
///
/// The two endings differ in exactly one observable way, and it is the one that
/// matters to the peer: a request that TIMED OUT leaves a one-shot late-offer
/// mark, because this side stopped waiting while the peer may still be about to
/// offer, and that peer is owed an explicit `busy` rather than silence. A
/// request this side CANCELLED — the peer left the roster, the room detached,
/// the physical device went away — leaves nothing, because there is no late
/// offer to answer: either the peer is gone, or, if it comes back and offers, it
/// is offering into a room this side never abandoned mid-handshake and must be
/// admitted normally.
///
/// Getting that backwards is not a cosmetic difference. A cancellation that left
/// a mark would refuse the returning peer's first genuine offer, and a timeout
/// that left none would black-hole a peer whose offer is already in flight.
public enum LinkRequestEnding: Equatable, Sendable {
    /// This side gave up waiting. Ends `.failed`, and leaves one late offer from
    /// this peer to be consumed and answered `busy`.
    case timedOut
    /// This side withdrew the ask, and the peer is owed nothing. Ends `.idle`,
    /// and leaves no mark.
    case cancelled
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

    // MARK: - claiming what a decision authorised

    /// Take the room for an establishment with this peer, in one critical
    /// section with the phase test that justifies it.
    ///
    /// ## Why this exists beside `route` and `ensure`
    ///
    /// Those two ANSWER; they deliberately do not act. `route` reads the phase
    /// and says `establish(role:)`, and the caller then has to build something —
    /// which it cannot do while holding this object's lock, and in the app's case
    /// cannot even do on this thread. Between the answer and the claim the phase
    /// is unguarded, and the failure that lives in that window is not theoretical:
    /// two offers delivered in ONE socket burst are both routed against an idle
    /// room, both told `establish`, and the second is then either a second
    /// PeerConnection into the same pair of lanes or a peer silently dropped
    /// instead of being told the room is taken.
    ///
    /// So this is the second half of the decision, and it is the half that is
    /// atomic. It answers false when the room has since been taken by somebody
    /// else, which is exactly when the caller owes that peer a `busy`.
    ///
    /// It is idempotent for the peer already being established with, so a caller
    /// that re-claims — a crossing offer adopted while this side's own request is
    /// outstanding — is not told it lost.
    ///
    /// It does NOT decide the role: that is `linkRole`'s and arrives already
    /// computed, exactly as `didBeginEstablishing` takes it.
    ///
    /// **A reclaim never rewrites the role, and that is the sharp edge here.**
    /// The idempotent path exists for a duplicate — a replayed offer, a crossing
    /// signal, a peer that sent twice — and a duplicate can carry the OPPOSITE
    /// role, either because it was forged or because it arrived from a routing
    /// decision taken against a different self id. `establishedRole` is what
    /// `route` reads to decide who drives a rebuild: only the responder consumes
    /// an inbound authenticated resume offer, because the initiator drives its
    /// own. So a reclaim that flipped this field would leave both peers
    /// consuming, or both driving, the next rebuild — two PeerConnections into
    /// one pair of lanes, or none — and it would do it long after the reclaim,
    /// during a recovery nobody would connect to a duplicate signal. The role is
    /// therefore written only where a NEW establishment begins, and an
    /// already-connecting peer keeps the one its first claim settled.
    public func admitEstablishment(peerId: String, role: Role) -> Bool {
        lock.lock(); defer { lock.unlock() }
        switch _phase {
        case .idle, .failed:
            // A new establishment: this claim is what settles the role.
            establishedRole = role
        case let .requesting(held):
            // Our own ask, superseded by an establishment with the same peer.
            // Still new — nothing has settled a role yet.
            guard held == peerId else { return false }
            establishedRole = role
        case let .connecting(held):
            // The attempt we already have. Idempotent, and deliberately silent
            // about `role`: see above.
            guard held == peerId else { return false }
        case .open, .interrupted:
            return false
        }
        // The mark is consumed by the establishment it would have refused: this
        // side is no longer waiting on that peer, so its next offer is genuine.
        timedOutPeers.remove(peerId)
        _phase = .connecting(peerId: peerId)
        return true
    }

    /// Take the room for an outstanding ask to this peer, on the same terms.
    ///
    /// `didBeginRequesting` below assigns unconditionally, which is right for the
    /// owner that already knows it holds the room. A router acting on `ensure`'s
    /// answer does not: an inbound offer may have been admitted between the
    /// answer and the ask, and overwriting `.connecting` with `.requesting` would
    /// leave this side asking a peer to offer while a link to a different one was
    /// already being built.
    public func admitRequest(peerId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        switch _phase {
        case .idle, .failed:
            break
        case let .requesting(held):
            guard held == peerId else { return false }
        case .connecting, .open, .interrupted:
            return false
        }
        timedOutPeers.remove(peerId)
        _phase = .requesting(peerId: peerId)
        return true
    }

    // MARK: - ending exactly the request a claim took

    /// End THIS peer's outstanding ask, and nothing else.
    ///
    /// ## Why this exists beside `didRequestTimeOut`
    ///
    /// The lifecycle call below announces; this one answers. A router that armed
    /// a timeout, or that is tearing an ask down because the peer disappeared,
    /// has to know whether its call is the one that actually ended the request:
    /// only the caller that changed the state may go on to tell the user the ask
    /// failed, release its own slot, or send anything. Fired against a request
    /// that has already become an establishment, an open link, or somebody
    /// else's ask, this is inert and says so — which is what stops a timer that
    /// fired one instant too late from cancelling a link that had just connected.
    ///
    /// ## Why there is no request token here
    ///
    /// The obvious alternative is to hand out a token per ask and require it
    /// back. It would be redundant: the router already serialises install and
    /// cancel in ONE outer critical section under its own epoch plus an opaque
    /// token, so by the time a call reaches this object the "is this still my
    /// request" question has been answered by the only lock that can see the
    /// router's own timer. A second identity here would be a second thing to
    /// keep in step with the first, and the peer-and-phase test below is already
    /// exact for everything this object can observe.
    ///
    /// Deliberately callback-free and fully contained by this lock. Nothing
    /// owner-supplied is evaluated, so unlike `route` and `ensure` there is no
    /// re-entrancy hazard: a caller may hold its own lock across this call.
    ///
    /// - Returns: true only if this call is the one that ended the request.
    @discardableResult
    public func endRequest(peerId: String, as ending: LinkRequestEnding) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard case let .requesting(held) = _phase, held == peerId else { return false }
        switch ending {
        case .timedOut:
            timedOutPeers.insert(peerId)
            _phase = .failed
        case .cancelled:
            // Defensive, and cheap: the postcondition of a cancellation is that
            // this peer carries no mark, not merely that this call added none.
            // Nothing can currently leave a mark standing on the peer of a live
            // ask — both entry points clear it — and the router is not asked to
            // depend on that staying true.
            timedOutPeers.remove(peerId)
            _phase = .idle
        }
        return true
    }

    /// Forget one peer's stale late-offer mark, without touching the room.
    ///
    /// A mark is a debt owed to a peer that may still be about to offer. When
    /// the roster or a physical departure proves that peer is gone, the debt is
    /// gone with it, and keeping it would spend the peer's ONE late offer on a
    /// session it no longer has — so the next time it appears, its first genuine
    /// offer is the one refused.
    ///
    /// Deliberately narrower than `didClose`, which drops every mark along with
    /// the room. One peer leaving says nothing about another peer's outstanding
    /// late offer, and nothing at all about the phase — this side may be
    /// mid-ask, connecting, or open with somebody else while it runs.
    ///
    /// - Returns: true if a mark was actually forgotten.
    @discardableResult
    public func forgetRequestTimeout(peerId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return timedOutPeers.remove(peerId) != nil
    }

    // MARK: - lifecycle, driven by the transport owner

    public func didBeginRequesting(peerId: String) {
        lock.lock()
        timedOutPeers.remove(peerId)
        _phase = .requesting(peerId: peerId)
        lock.unlock()
    }

    /// The owner announcing that its own wait ran out. Unchanged in behaviour,
    /// and now one word of `endRequest` — a caller that needs to know whether it
    /// was the one that ended the request calls that directly.
    public func didRequestTimeOut(peerId: String) {
        endRequest(peerId: peerId, as: .timedOut)
    }

    /// The transport owner announces that IT has begun an establishment.
    ///
    /// Deliberately unconditional, and deliberately unlike `admitEstablishment`
    /// above, which preserves the role of a peer already being connected to. The
    /// two have different callers and therefore different rules: this one is the
    /// owner stating what it has decided and started, and the only thing that can
    /// reach it is code that already holds the room. `admitEstablishment` is the
    /// one that turns an UNTRUSTED signal into a claim, so it is the one that has
    /// to survive a duplicate or replayed claim carrying the opposite role.
    ///
    /// An owner that called this twice for one peer with two roles would be
    /// announcing something contradictory about its own establishment, and
    /// believing it is the right answer — nothing else can tell the owner what it
    /// is doing. Today there is exactly one caller, `LinkRoomSession.begin`, and
    /// it makes the call once per establishment behind its own single-slot guard.
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

    /// A rebuild attempt ended without publishing. The one rebuild slot comes
    /// back; the link stays interrupted.
    ///
    /// Deliberately symmetric with `didBeginReplacingTransport` rather than
    /// folded into `didFail`. An attempt failing is not the link failing — the
    /// recovery window is still open and the peer may still be trying — and
    /// without a way back the slot would be one-shot for the whole gap: a
    /// responder whose first attempt lost its ICE race would ignore every later
    /// offer and sit out the rest of its window holding a link it could have
    /// rebuilt.
    public func didEndReplacingTransport() {
        lock.lock()
        replacingTransport = false
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
