import Foundation

/// One bounded wake-up an epoch depends on (spec §7.2, §9).
public enum RelayRenewTimer: Hashable, Sendable {
    case prepareToReady(epoch: UInt32)
    case readyToAnswer(epoch: UInt32)
    case iceProbe(epoch: UInt32)
    /// The whole epoch. NEVER re-armed — that is what makes 60 s a hard cap
    /// rather than a cadence.
    case epochHardCap(epoch: UInt32)
    /// Two `prepare`s this far apart with no reply means the peer does not
    /// implement renewal.
    case prepareSilence(epoch: UInt32)
    case probeRetry(epoch: UInt32)
    /// How long a committed epoch keeps answering the peer (spec §6.6).
    case postCommitAck(epoch: UInt32)
    /// The pause between a failed epoch and the next (spec §7.2).
    case retryBackoff(epoch: UInt32)

    public var epoch: UInt32 {
        switch self {
        case let .prepareToReady(e), let .readyToAnswer(e), let .iceProbe(e),
             let .epochHardCap(e), let .prepareSilence(e), let .probeRetry(e),
             let .postCommitAck(e), let .retryBackoff(e):
            return e
        }
    }
}

/// Everything the engine asks its driver to do. It performs no I/O itself.
///
/// An effect list rather than direct calls, for the reason `LinkTextSession`
/// gives: the ORDER is a decision this object makes and nothing downstream may
/// reorder, and a state machine whose every transition is an inspectable value
/// is one a test can drive without a peer, a socket or a PeerConnection.
/// Deliberately NOT `Sendable`: two cases carry `ICEConfig` and `JSONValue`,
/// which are not, and an effect never crosses a concurrency domain on its own —
/// `RelayRenewController` produces and performs every one of them on a single
/// serial queue. Claiming the conformance would be claiming a property the
/// carried types do not have.
public enum RelayRenewEffect: Equatable {
    /// A signed renewal envelope for the peer, on the `link` generation.
    case sendSignal(JSONValue)
    /// Ask the server for one round.
    case requestRound(round: UInt32, rid: UInt32)
    /// `setConfiguration` on the LIVE PeerConnection. Applying it is not a
    /// migration and commits nothing.
    case applyConfiguration(ICEConfig, epoch: UInt32)
    /// Produce an ICE-restart offer and set it locally.
    case createOffer(epoch: UInt32)
    /// Produce an answer to the applied remote offer and set it locally.
    case createAnswer(epoch: UInt32)
    case applyRemoteDescription(sdp: String, type: RelayRenewSDPType, epoch: UInt32)
    case addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: UInt32?)
    /// Put one 59-byte control frame on the text lane, OUTSIDE the text send
    /// queue.
    case sendProbeFrame([UInt8])
    case armTimer(RelayRenewTimer, after: TimeInterval)
    case cancelTimer(RelayRenewTimer)
    /// §6.5 commit, and the ONLY effect that may move a deadline. Carries the
    /// configuration actually received for `round`, because the new deadline is
    /// derived from that and from nothing else.
    case commit(round: UInt32, config: ICEConfig)
    /// A same-round REPAIR completed (reconcile-2 R4): this side had already
    /// committed `round`, and has now re-proved the path so the peer could
    /// commit it too. It MUST NOT advance or re-arm this side's deadline or its
    /// margin anchor — the credential is the one it was already bounded by.
    case recommitted(round: UInt32)
    /// This epoch is over and the OLD deadline stands. Diagnostic.
    case epochEnded(epoch: UInt32, reason: RelayRenewAbortReason)
    /// The peer does not implement renewal, for the remainder of this link. The
    /// UI must not claim a renewal happened.
    case peerUnsupported
}

/// One acknowledgement this side has already computed, kept so a peer's bounded
/// retransmits can be answered without a second HMAC — and, crucially, after
/// this side has already committed.
///
/// ## Why it outlives the attempt
///
/// Commit is LOCAL. This side commits the moment its own observation holds and
/// its own nonce is acked; the peer is still waiting for the ack to ITS probe.
/// An engine that dropped its attempt on commit would answer nothing after
/// that point, and the peer would retransmit five times into silence and then
/// keep its old deadline — a link where one end renewed and the other did not.
/// The cache is what makes the two ends converge.
///
/// ## Why it is keyed on nonce AND tag
///
/// Spec §6.4 allows reusing a verification for "an exact duplicate of an
/// already-verified frame". A nonce alone is not that: the nonce travels in
/// clear inside a frame anyone on the path can observe, so matching on it
/// alone would let an observer buy an unbounded number of ack SENDS with
/// forged tags, outside the per-epoch HMAC budget entirely. Comparing the tag
/// too makes "exact duplicate" mean what it says.
///
/// ## Why the replays are bounded
///
/// A genuine peer sends one nonce at most `RENEW_PROBE_MAX_SENDS` times, so
/// that is exactly how many replays are useful and the budget is spent rather
/// than refilled.
private struct RelayRenewAckCache {
    let epoch: UInt32
    let round: UInt32
    let nonce: [UInt8]
    /// The tag of the frame that was ACTUALLY verified. A frame carrying this
    /// nonce and any other tag is not a duplicate; it is a forgery, and it goes
    /// through the ordinary budgeted path.
    let tag: [UInt8]
    let ack: [UInt8]
    var replaysLeft: Int

    func matches(_ frame: RelayRenewProbeFrame) -> Bool {
        frame.type == .probe && frame.epoch == epoch && frame.round == round
            && frame.nonce == nonce && frame.tag == tag
    }
}

/// A committed epoch, retained so the two ends converge (spec §6.6).
///
/// Commit is LOCAL: this side commits when the peer's ack for ITS nonce
/// arrives, and the peer commits when this side's ack reaches it. Between those
/// two instants the peer is still retransmitting. A client that tore its epoch
/// down on its own commit would drop those retransmits, and the peer would time
/// out and keep an expiring deadline while this side believed the migration was
/// shared — a split neither end reports.
///
/// It keeps exactly three abilities, and no others. It MUST NOT be able to
/// start a negotiation, move a deadline again, or be promoted back into an
/// attempt — which is why this is a separate type rather than an attempt with a
/// flag set.
private struct RelayRenewCommitted {
    let epoch: UInt32
    let round: UInt32
    /// The local generation this migration landed on. Later trickle candidates
    /// still belong to it and must keep travelling signed.
    let localUfrag: String?
    /// The ack already computed, replayed for an exact duplicate.
    var ackCache: RelayRenewAckCache?
    /// HMACs spent on the peer's probes by this EPOCH, carried over from the
    /// attempt rather than restarted (reconcile-2 R5, Fable clarification 3).
    /// The budget is one per epoch, before AND after commit: a committed epoch
    /// that opened a fresh allowance would make the real total 8 + 8, which is
    /// exactly what "not 8+8" rules out. A probe first seen after commit is
    /// legitimate and spends what is LEFT of the probe reservation.
    var probeVerifications: Int
}

/// One migration attempt on one PeerConnection.
private struct RelayRenewAttempt {
    let epoch: UInt32
    var round: UInt32?
    var config: ICEConfig?
    /// The server request this epoch is waiting on, or nil when it is waiting
    /// on none. A reply is accepted ONLY when it carries this rid and this
    /// round: that is the fence that stops a late `R+1` answer overwriting or
    /// aborting an epoch that has meanwhile adopted its installed round.
    var requestRid: UInt32?
    var requestedRound: UInt32?
    /// A stale resynchronisation is allowed once per epoch.
    var resynchronised = false
    /// This epoch obtained a configuration — granted, or adopted in a repair —
    /// and therefore counts against the round's MIGRATION budget. An epoch that
    /// died before that point was never a migration; it spends the separate
    /// pre-grant budget instead.
    var obtainedConfig = false
    /// A same-round repair: commits with `recommitted`, never `commit`.
    var isRepair = false
    /// HMACs spent on the peer's ACKs to this side's own nonce.
    var ackVerifications = 0
    /// HMACs spent on this epoch's signalling, in TWO pools. Candidates are by
    /// far the most numerous genuine signal, so they get their own; were it one
    /// pool, a burst of junk shaped like candidates would spend it and the one
    /// description that completes the epoch would be refused unverified.
    var controlVerifications = 0
    var candidateVerifications = 0
    var configApplied = false
    var sentReady = false
    /// The round the PEER said it was ready on. Both must hold the same R
    /// before an offer.
    var peerReadyRound: UInt32?
    var localUfrag: String?
    var remoteUfrag: String?
    var remoteApplied = false
    var offerSent = false
    var answerSent = false
    /// Inbound candidates that arrived before the remote description they
    /// belong to, keyed by the ufrag they NAME. Bounded across all keys.
    var held: [(candidate: String, mid: String?, index: UInt32?, ufrag: String)] = []
    var probeVerifications = 0
    /// The selected local candidate belongs to this epoch's ufrag generation.
    var observationHeld = false
    /// Created ONLY once observation holds, which is what makes "the ack
    /// arrived after observation held" structural rather than a timestamp
    /// comparison: there is no nonce to ack before then.
    var ownNonce: [UInt8]?
    var ownNonceSends = 0
    /// A verified probe that arrived before observation held. Single slot,
    /// latest nonce wins.
    var pendingRemoteProbe: RelayRenewProbeFrame?
    /// The ack this side has already computed, so a duplicate probe gets the
    /// SAME answer idempotently rather than spending another HMAC.
    var ackCache: RelayRenewAckCache?
    /// A selected-candidate report that arrived before this epoch's local
    /// description had been applied.
    ///
    /// Single slot, latest wins. `didChangeLocalCandidate` and
    /// `setLocalDescription`'s completion are independent asynchronous events
    /// on the SDK's own threads, and the pair can genuinely change first — an
    /// engine that discarded that report would then wait for a second pair
    /// change that a settled connection has no reason to produce, and the
    /// epoch would hang to its hard cap for no reason. Retaining the CANDIDATE
    /// STRING rather than a conclusion is what keeps this safe: it still names
    /// its own generation when it is re-examined, so nothing is guessed from
    /// whatever description happens to be current by then.
    var pendingSelectedCandidate: (local: String, remote: String)?
    var committed = false
}

/// The `relay-renew/1` state machine: pure, synchronous, and the single place
/// every rule in `docs/protocol/relay-renew-v1.md` is enforced.
///
/// ## What it deliberately does not do
///
/// No timers, no sockets, no PeerConnection, no randomness and no clock of its
/// own. Time arrives as `timerFired`, entropy arrives through `makeNonce`, and
/// crypto arrives through `sign`/`verify` — so every bound in spec §9 is an
/// ordinary unit test rather than a decision only a two-peer run over an hour
/// could observe.
///
/// ## The one invariant everything else serves
///
/// **A deadline moves only on §6.5 commit.** Not on a WS reply, not on
/// `setConfiguration`, not on an open DataChannel, not on a `connected` state,
/// not on an old selected candidate. Every failure path — abort, timeout,
/// denial, a failed pin, an unbindable candidate, a spent budget — emits
/// `epochEnded` and NOTHING else, and the old deadline stands exactly as it was.
public final class RelayRenewEngine {
    // MARK: - identity

    private let selfId: String
    private let peerId: String
    /// The link's ESTABLISHED initiator sends the offer, always. A migration
    /// must not be able to turn two peers into two offerers, and the role is
    /// the one `LinkIdentity` preserved across a `link:§8` rebuild.
    private let role: Role
    private let sign: (String) -> String
    private let verify: (String, String) -> Bool
    private let makeNonce: () -> [UInt8]
    /// The INDEPENDENT `lastUserDataAt` answer, asked rather than passed in.
    ///
    /// Asked, because consenting to a renewal is not only something this side
    /// STARTS. A peer's `prepare` makes this side request a round and apply a
    /// credential too, and an implementation that gated only its own trigger
    /// would let either peer keep the other's idle link renewing forever —
    /// exactly the outcome spec §7 exists to prevent, arriving from the side
    /// that was behaving.
    private let userDataIsRecent: () -> Bool
    /// Whether this side still holds a live, unexpired grant.
    ///
    /// Separate from activity because it answers a different question, and
    /// deliberately NOT a margin check: the two peers' initial expiries may
    /// legitimately differ, so a peer whose credential dies sooner is entitled
    /// to ask before this side's own margin has opened. What this side is not
    /// entitled to do is renew a bound it no longer has.
    private let grantIsLive: () -> Bool
    /// Whether the peer ANNOUNCED `relay-renew/1` on the roster.
    ///
    /// Gates only what this side STARTS. It is an unsigned hint and never a
    /// security input: an authenticated inbound `prepare` is honoured without
    /// it, and a peer that never announced is simply never asked, so an older
    /// client gets exactly today's behaviour — no renewal frames, no claim, and
    /// the truthful original deadline.
    private let peerAnnouncedRenewal: () -> Bool

    // MARK: - link-level state

    /// Monotonic, never reused, and deliberately NOT reset across a `link:§8`
    /// rebuild: a rebuilt transport inherits the counter, so an aborted epoch's
    /// signed messages can never be replayed into a later attempt.
    private var epochCounter: UInt32 = 0
    /// The round this side has INSTALLED — committed, with its deadline moved.
    /// Starts at 0, the link's original grant, so the first renewal asks for 1.
    ///
    /// Deliberately not "the last round the server issued". A side that was
    /// granted R but never committed it must ask for R again — the server
    /// replays its cached result, charging nothing — and a counter advanced at
    /// grant time would make it ask for R+1 alone, a round the server can never
    /// issue because its peer, which DID commit R, is not asking for it.
    private var installedRound: UInt32 = 0
    /// The configuration of `installedRound`, kept so a same-round repair can
    /// adopt exactly what is already applied rather than anything a peer names.
    private var installedConfig: ICEConfig?
    private var ridCounter: UInt32 = 0
    private var attempt: RelayRenewAttempt?
    private var baseline: RelayRenewSDPPin?
    /// Epochs that OBTAINED a configuration for each round — granted, or
    /// adopted in a repair. At most `RENEW_MAX_EPOCHS_PER_ROUND` per round, and
    /// never reset by committing that round: a repair is a migration of the
    /// same credential and spends the same budget.
    private var migrationEpochs: [UInt32: Int] = [:]
    /// Epochs that died BEFORE obtaining a configuration, since the last
    /// commit: `unavailable`, `rate`, server silence. A separate budget, so
    /// three transient refusals cannot permanently abandon a renewal whose
    /// margin still has minutes left — and still a bound, so a server that
    /// never answers is not asked forever.
    private var preGrantFailures = 0
    /// Failed verifications of a `prepare` while no attempt is in flight. Any
    /// such frame costs an HMAC, so a flood is bounded; one genuine signal
    /// refills it.
    private var idleVerificationFailures = 0
    /// `denied` is terminal for that round.
    private var deniedRounds: Set<UInt32> = []
    /// Set by the FIRST verified renewal signal from the peer, and never
    /// cleared. Monotonic and authenticated, and deliberately independent of
    /// the unsigned `caps` hint.
    private var sawVerifiedPeerSignal = false
    private var peerUnsupported = false
    private var prepareSends = 0
    private var closed = false
    /// The epoch this side has already committed, retained for
    /// `RENEW_POST_COMMIT_ACK_MS` so the peer's bounded retransmits still
    /// converge. Replaced by the next epoch and dropped on close.
    private var committed: RelayRenewCommitted?
    /// The epoch whose failure started the current backoff, or nil when none is
    /// running. A failed epoch waits `RENEW_RETRY_BACKOFF_MS` before another is
    /// spent (spec §7.2).
    private var backoffUntilEpoch: UInt32?

    public init(selfId: String,
                peerId: String,
                role: Role,
                baseline: RelayRenewSDPPin?,
                sign: @escaping (String) -> String,
                verify: @escaping (String, String) -> Bool,
                makeNonce: @escaping () -> [UInt8],
                userDataIsRecent: @escaping () -> Bool,
                grantIsLive: @escaping () -> Bool = { true },
                peerAnnouncedRenewal: @escaping () -> Bool = { true }) {
        self.selfId = selfId
        self.peerId = peerId
        self.role = role
        self.baseline = baseline
        self.sign = sign
        self.verify = verify
        self.makeNonce = makeNonce
        self.userDataIsRecent = userDataIsRecent
        self.grantIsLive = grantIsLive
        self.peerAnnouncedRenewal = peerAnnouncedRenewal
    }

    // MARK: - observable state, for the surfaces that need it

    /// Once this link has verified ANY renewal signal from its peer it refuses
    /// unsigned `link`-generation SDP for the remainder of this PeerConnection,
    /// and it suppresses the existing unauthenticated ICE restart while an
    /// epoch is in flight — two offers on one connection is glare neither side
    /// can resolve.
    public var suppressesUnsignedLinkSDP: Bool { sawVerifiedPeerSignal }
    /// An epoch is in flight right now.
    public var isAttempting: Bool { attempt != nil }
    /// Whether renewal currently owns this connection's LOCAL candidates: an
    /// epoch in flight, or a committed one still inside its retention window,
    /// whose later trickle must keep travelling signed (spec §6.6). This — not
    /// `isAttempting` — is what the transport's diversion flag follows;
    /// following `isAttempting` would hand post-commit candidates straight back
    /// to the unauthenticated path the moment the migration succeeded.
    public var ownsLocalCandidates: Bool { attempt != nil || committed != nil }
    public var currentEpoch: UInt32? { attempt?.epoch }
    public var currentInstalledRound: UInt32 { installedRound }
    public var peerIsUnsupported: Bool { peerUnsupported }

    // MARK: - starting an attempt

    /// The renewal margin opened, or more user data arrived inside it.
    ///
    /// Both are the SAME entry point on purpose. The margin is a window rather
    /// than an instant, so a transfer that starts two minutes into it is a link
    /// being used; a client that consulted its activity clock only at the
    /// window's opening would refuse to renew exactly that link.
    ///
    /// - Parameter userDataIsRecent: the INDEPENDENT `lastUserDataAt` answer —
    ///   never a UI active flag, a pending consent, a keepalive or renewal's
    ///   own control traffic. See `RelayRenewActivityClock`.
    public func evaluate() -> [RelayRenewEffect] {
        guard !closed, !peerUnsupported, attempt == nil else { return [] }
        // A failed epoch waits (spec §7.2). This is the gate that stops the
        // trigger's own cadence burning all three of a round's epochs in
        // seconds: `userDataMoved()` fires on every progress notice, so a
        // transfer that is genuinely moving is also the fastest way to spend
        // the budget.
        guard backoffUntilEpoch == nil else { return [] }
        // Unsolicited initiation needs the peer's roster announcement. A peer
        // that never said `relay-renew/1` is never sent a renewal frame.
        guard peerAnnouncedRenewal() else { return [] }
        guard mayRenewNow() else { return [] }
        let wanted = installedRound &+ 1
        guard !deniedRounds.contains(wanted) else { return [] }
        guard (migrationEpochs[wanted] ?? 0) < RENEW_MAX_EPOCHS_PER_ROUND else { return [] }
        guard preGrantFailures < RENEW_MAX_PREGRANT_ATTEMPTS else { return [] }
        return beginEpoch()
    }

    /// Whether this side may take part in a renewal AT ALL, right now.
    ///
    /// Two independent conditions, and both are this side's own: recent
    /// authenticated user-lane traffic, and a grant that has not lapsed. The
    /// margin is deliberately NOT one of them — see `grantIsLive`.
    private func mayRenewNow() -> Bool {
        grantIsLive() && userDataIsRecent()
    }

    /// Start a fresh, higher epoch. A failed attempt NEVER retries under its
    /// own number: a new epoch is what makes the aborted attempt's signed
    /// messages unreplayable into the retry.
    private func beginEpoch(adopting adopted: UInt32? = nil) -> [RelayRenewEffect] {
        let epoch: UInt32
        if let adopted {
            epoch = adopted
            // The counter tracks the highest epoch this link has SEEN, not just
            // the ones it minted, so a later local attempt cannot collide with
            // one the peer already used.
            epochCounter = Swift.max(epochCounter, adopted)
        } else {
            guard epochCounter < UInt32.max else { return [] }
            epochCounter &+= 1
            epoch = epochCounter
        }
        let wanted = installedRound &+ 1
        attempt = RelayRenewAttempt(epoch: epoch)
        // A new epoch retires the previous round's committed state: its peer
        // has either converged or given up, and keeping it would answer frames
        // this link no longer has any reason to answer.
        let retired = committed?.epoch
        committed = nil
        prepareSends = 0

        var effects: [RelayRenewEffect] = []
        if let retired { effects.append(.cancelTimer(.postCommitAck(epoch: retired))) }
        effects.append(contentsOf: sendMessage(.prepare(epoch: epoch)))
        prepareSends = 1
        effects.append(.armTimer(.epochHardCap(epoch: epoch), after: RENEW_EPOCH_HARD_CAP_MS))
        effects.append(.armTimer(.prepareToReady(epoch: epoch), after: RENEW_PREPARE_TO_READY_MS))
        effects.append(.armTimer(.prepareSilence(epoch: epoch), after: RENEW_PREPARE_SILENCE_MS))
        // Both original peers must ask before the server issues, so this side
        // asks as soon as it has an epoch rather than waiting for the peer.
        effects.append(contentsOf: request(round: wanted))
        return effects
    }

    /// Ask the server for one round, remembering exactly which request this
    /// epoch is now waiting on.
    private func request(round: UInt32) -> [RelayRenewEffect] {
        ridCounter &+= 1
        attempt?.requestRid = ridCounter
        attempt?.requestedRound = round
        return [.requestRound(round: round, rid: ridCounter)]
    }

    // MARK: - peer signals

    /// One inbound renewal envelope.
    ///
    /// The envelope's SHAPE was already checked by `parsedRelayRenewEnvelope`;
    /// what happens here is the rest of spec §3.5's order, and the order is the
    /// point. The capability, the current link and the epoch this side can act
    /// on are all decided BEFORE the tag is verified, so a flood cannot buy
    /// HMACs by sending epochs nobody would have acted on anyway.
    public func receive(_ envelope: RelayRenewEnvelope) -> [RelayRenewEffect] {
        guard !closed else { return [] }
        let message = envelope.message
        guard epochIsActionable(message) else { return [] }
        // Only now, and one at a time. `verify` is the caller's serialised
        // primitive.
        // Spec §3.5 step 4: the budget, before the tag. Two pools, because a
        // signal either belongs to an epoch or is trying to start one.
        if let current = attempt {
            if case .ice = message {
                guard current.candidateVerifications < RENEW_MAX_CANDIDATE_VERIFICATIONS else {
                    return []
                }
                attempt?.candidateVerifications += 1
            } else {
                guard current.controlVerifications < RENEW_MAX_CONTROL_VERIFICATIONS else {
                    return []
                }
                attempt?.controlVerifications += 1
            }
        } else {
            guard idleVerificationFailures < RENEW_MAX_PROBE_VERIFICATIONS else { return [] }
        }
        let payload = relayRenewPayload(message, from: peerId, to: selfId)
        guard verify(payload, envelope.auth) else {
            if attempt == nil { idleVerificationFailures += 1 }
            return []
        }
        idleVerificationFailures = 0
        // Authenticated, monotonic, and never cleared: from here this link
        // refuses unsigned `link`-generation SDP for the rest of this
        // PeerConnection.
        sawVerifiedPeerSignal = true
        // A peer that answers is a peer that implements renewal, whatever the
        // silence timer was about to conclude.
        peerUnsupported = false

        switch message {
        case let .prepare(epoch):
            return handlePrepare(epoch: epoch)
        case let .ready(epoch, round):
            return handlePeerReady(epoch: epoch, round: round)
        case let .sdp(epoch, round, sdpType, sdp):
            return handleRemoteSDP(epoch: epoch, round: round, type: sdpType, sdp: sdp)
        case let .ice(epoch, round, candidate, mid, index, ufrag):
            return handleRemoteCandidate(epoch: epoch, round: round, candidate: candidate,
                                         mid: mid, index: index, ufrag: ufrag)
        case let .abort(epoch, reason):
            guard attempt?.epoch == epoch else { return [] }
            return endEpoch(reason: reason, notifyPeer: false)
        }
    }

    /// Whether this side could act on the message's epoch at all, before any
    /// HMAC is spent.
    private func epochIsActionable(_ message: RelayRenewMessage) -> Bool {
        if case let .prepare(epoch) = message {
            // A prepare is how an attempt STARTS, so it is actionable without
            // one in flight — but only at an epoch above the current one.
            // Equal coalesces, which is also actionable.
            if let attempt { return epoch >= attempt.epoch }
            return epoch > epochCounter
        }
        guard let attempt else { return false }
        guard message.epoch == attempt.epoch else { return false }
        // A candidate that could only be HELD, arriving when the hold is full,
        // is dropped before it costs an HMAC: verifying it could not change
        // what happens to it.
        if case .ice = message, !attempt.remoteApplied,
           attempt.held.count >= RENEW_MAX_HELD_CANDIDATES { return false }
        // The budget is a per-epoch cap on HMACs, and it covers signals as well
        // as probes: both are work a peer can ask this side to do.
        return true
    }

    private func handlePrepare(epoch: UInt32) -> [RelayRenewEffect] {
        // An honest responder decides for ITSELF whether this link is being
        // used. A valid signed `prepare` proves the peer holds `resumeAuth`;
        // it proves nothing about whether anybody is moving data here, and a
        // side that took the peer's word for it would request a round, spend
        // an issuance and apply a credential on a link that should be closing.
        //
        // Checked before an attempt is started AND before a higher epoch is
        // adopted, because both are the same act of consent.
        guard mayRenewNow() else { return [] }
        // Deliberately NOT gated on `backoffUntilEpoch`. The backoff bounds how
        // fast this side SPENDS the round's epoch budget on its own initiative;
        // a peer that has waited its own backoff and asks is a peer this side
        // should answer, and the three-epochs-per-round cap still bounds the
        // total either way.
        if let current = attempt {
            if epoch == current.epoch {
                // Two peers preparing simultaneously at the same epoch coalesce
                // into ONE attempt. Nothing restarts, nothing is re-armed.
                return []
            }
            guard epoch > current.epoch else { return [] }
            // A higher VALID authenticated prepare wins; both ends converge on
            // the larger. The old epoch is voided and its old deadline stands.
            //
            // Supersession is NOT free (root W9/D5). Whatever the superseded
            // epoch already spent stays spent — a granted configuration was
            // charged to its round when it was accepted — and one that had not
            // yet obtained a configuration is charged to the pre-grant budget
            // here. Otherwise a stream of signed higher prepares would let each
            // epoch make its server request and then vanish uncounted, and the
            // bound on requests would be no bound at all.
            if !current.obtainedConfig { preGrantFailures += 1 }
            var effects = endEpoch(reason: .closed, notifyPeer: false, startsBackoff: false)
            effects.append(contentsOf: joinEpoch(epoch))
            return effects
        }
        guard !peerUnsupported else { return [] }
        return joinEpoch(epoch)
    }

    /// Join the peer's epoch, or refuse it out loud.
    ///
    /// The same two budgets that bound what this side STARTS bound what it
    /// joins: the pre-grant allowance, and the migration allowance of the round
    /// it would have to ask for. When either is spent this side cannot take
    /// part, and it says so with a signed `abort` rather than with silence —
    /// silence is what an older client produces, and a peer that heard nothing
    /// twice would conclude this build does not implement renewal at all. The
    /// epoch is still recorded as seen, so the same signed prepare can never be
    /// acted on again.
    ///
    /// Deliberately NOT gated on this side's own retry backoff. Two honest
    /// peers start their backoffs a network delay apart, so the peer's next
    /// prepare routinely lands just inside this side's; refusing it there
    /// would turn a 60-second pause into a missed renewal. The budgets are
    /// what bound a peer that does not pause.
    private func joinEpoch(_ epoch: UInt32) -> [RelayRenewEffect] {
        let wanted = installedRound &+ 1
        let repairable = installedRound > 0 && installedConfig != nil
            && (migrationEpochs[installedRound] ?? 0) < RENEW_MAX_EPOCHS_PER_ROUND
        let canMigrate = (migrationEpochs[wanted] ?? 0) < RENEW_MAX_EPOCHS_PER_ROUND
            && !deniedRounds.contains(wanted)
        guard preGrantFailures < RENEW_MAX_PREGRANT_ATTEMPTS, canMigrate || repairable else {
            epochCounter = Swift.max(epochCounter, epoch)
            return sendMessage(.abort(epoch: epoch, reason: .unavailable))
        }
        return beginEpoch(adopting: epoch)
    }

    private func handlePeerReady(epoch: UInt32, round: UInt32) -> [RelayRenewEffect] {
        guard var current = attempt, current.epoch == epoch else { return [] }
        current.peerReadyRound = round
        attempt = current
        if let repair = adoptInstalledRoundIfRepairing(peerRound: round) { return repair }
        return maybeOffer()
    }

    /// Same-round repair (reconcile-2 R4).
    ///
    /// The situation: this side COMMITTED round R; the peer did not — its ack
    /// was lost, or its window closed first. The peer starts a higher epoch and
    /// fetches the cached R. This side, having installed R, asked for R+1 —
    /// alone, so the server can never issue it. Left there, the peer can never
    /// reach R and the two ends die at different deadlines.
    ///
    /// So on a VALID SIGNED `ready(E, R)` naming exactly the round this side
    /// has installed, while this side is still waiting on R+1, it adopts the
    /// configuration it ALREADY HAS and answers `ready(E, R)`: same
    /// PeerConnection, a fresh ICE restart, a fresh probe. No server issuance
    /// is needed or made.
    ///
    /// What it refuses, each for its own reason:
    ///  - a round BELOW the installed one — that credential is behind us;
    ///  - any round this side holds no installed configuration for — it adopts
    ///    its own applied configuration, never one a peer merely names;
    ///  - a lapsed grant — there is nothing left to repair toward;
    ///  - a fourth epoch on that round — a repair spends the same budget.
    private func adoptInstalledRoundIfRepairing(peerRound: UInt32) -> [RelayRenewEffect]? {
        guard var current = attempt, current.round == nil else { return nil }
        guard installedRound > 0, peerRound == installedRound,
              let config = installedConfig else { return nil }
        guard grantIsLive() else { return nil }
        guard spendMigrationEpoch(on: peerRound) else {
            return endEpoch(reason: .unavailable, notifyPeer: true)
        }
        let epoch = current.epoch
        // Invalidate the in-flight R+1 request: whatever it eventually answers
        // — granted, denied, unavailable — must not touch this epoch.
        current.requestRid = nil
        current.requestedRound = nil
        current.round = peerRound
        current.config = config
        current.obtainedConfig = true
        current.isRepair = true
        // Already applied to this PeerConnection: it is the installed round.
        current.configApplied = true
        current.sentReady = true
        attempt = current
        var effects: [RelayRenewEffect] = [.cancelTimer(.prepareToReady(epoch: epoch)),
                                           .cancelTimer(.prepareSilence(epoch: epoch))]
        effects.append(contentsOf: sendMessage(.ready(epoch: epoch, round: peerRound)))
        effects.append(contentsOf: maybeOffer())
        return effects
    }

    // MARK: - the server exchange

    /// One `ice-grant` reply.
    ///
    /// A `granted` is applied and nothing else: applying a configuration is not
    /// a migration, and this path may not touch a deadline.
    public func receive(grant: RelayRenewGrant) -> [RelayRenewEffect] {
        guard !closed, var current = attempt else { return [] }
        // THE FENCE. A reply is this epoch's business only if it answers the
        // request this epoch is still waiting on. Without it a late answer to
        // an abandoned request — above all the `R+1` a repairing side asked for
        // before it adopted its installed round — could overwrite or abort an
        // epoch that has moved on.
        guard let rid = current.requestRid, grant.rid == rid else { return [] }

        if grant.status == .stale {
            // `round` is the server's CURRENT issued round. Anything else
            // carries the REQUESTED round back.
            let serverCurrent = grant.round
            guard serverCurrent > 0 else {
                // Nothing has ever been issued, so there is no cache to fetch.
                // Never ask for round 0, never spin: the epoch ends and the old
                // deadline stands.
                return endEpoch(reason: .unavailable, notifyPeer: true)
            }
            // A current round this side has not installed may be retrieved —
            // ONCE per epoch, so a server pinned at a stale answer cannot make
            // two clients trade re-asks forever.
            guard serverCurrent > installedRound, !current.resynchronised,
                  current.round == nil else { return [] }
            current.resynchronised = true
            attempt = current
            return request(round: serverCurrent)
        }

        guard grant.round == current.requestedRound else { return [] }
        switch grant.status {
        case .granted:
            guard let config = grant.config, current.round == nil else {
                return endEpoch(reason: .unavailable, notifyPeer: true)
            }
            // The migration budget is spent HERE, by an epoch that actually
            // obtained a credential — not by one that merely asked.
            guard spendMigrationEpoch(on: grant.round) else {
                return endEpoch(reason: .unavailable, notifyPeer: true)
            }
            current.requestRid = nil
            current.round = grant.round
            current.config = config
            current.obtainedConfig = true
            attempt = current
            return [.applyConfiguration(config, epoch: current.epoch)]
        case .denied:
            // TERMINAL for this round. It mints no configuration, and the link
            // keeps the deadline it has.
            deniedRounds.insert(grant.round)
            return endEpoch(reason: .denied, notifyPeer: true)
        case .unavailable:
            // Includes `reason: rate`. Does not advance issuance.
            //
            // When a same-round repair is still possible the epoch is NOT ended
            // (spec §6.7). This side asked for R+1 because it has already
            // installed R; the peer, which never committed R, is about to say
            // `ready(E, R)`. Ending here would throw away the one epoch that
            // repair needs — and it is precisely the committed side that the
            // issuance floor refuses, because it renewed moments ago. The epoch
            // stays alive with no configuration and no request outstanding,
            // bounded by the timers it already has.
            if installedRound > 0, installedConfig != nil, current.round == nil, grantIsLive() {
                current.requestRid = nil
                attempt = current
                return []
            }
            // Otherwise a PRE-GRANT failure: the retry is a later epoch, after
            // the backoff, and only while the old deadline allows one.
            return endEpoch(reason: .unavailable, notifyPeer: true)
        case .stale:
            return []
        }
    }

    /// Count one epoch that obtained a configuration for `round`, or refuse a
    /// fourth. Never reset by committing the round: a same-round repair is a
    /// migration of the same credential.
    private func spendMigrationEpoch(on round: UInt32) -> Bool {
        let spent = migrationEpochs[round] ?? 0
        guard spent < RENEW_MAX_EPOCHS_PER_ROUND else { return false }
        migrationEpochs[round] = spent + 1
        // Rounds below the installed one can never be migrated to again.
        migrationEpochs = migrationEpochs.filter { $0.key >= installedRound }
        return true
    }

    /// `setConfiguration` returned. Success means "this side holds round R's
    /// configuration", which is exactly what `ready` announces — and exactly
    /// what commit is NOT.
    public func configurationApplied(epoch: UInt32, ok: Bool) -> [RelayRenewEffect] {
        guard !closed, var current = attempt, current.epoch == epoch else { return [] }
        guard ok, let round = current.round else {
            return endEpoch(reason: .unavailable, notifyPeer: true)
        }
        current.configApplied = true
        current.sentReady = true
        attempt = current
        var effects: [RelayRenewEffect] = []
        effects.append(.cancelTimer(.prepareToReady(epoch: epoch)))
        effects.append(.cancelTimer(.prepareSilence(epoch: epoch)))
        effects.append(contentsOf: sendMessage(.ready(epoch: epoch, round: round)))
        effects.append(contentsOf: maybeOffer())
        return effects
    }

    /// Both sides hold the same round, so the established initiator offers.
    private func maybeOffer() -> [RelayRenewEffect] {
        guard var current = attempt, !current.offerSent else { return [] }
        guard current.sentReady, let round = current.round else { return [] }
        guard current.peerReadyRound == round else { return [] }
        guard role == .initiator else {
            // The responder waits, but its 15 s answer bound starts here too:
            // an offer that never arrives must not leave it holding an epoch
            // until the hard cap.
            return [.armTimer(.readyToAnswer(epoch: current.epoch), after: RENEW_READY_TO_ANSWER_MS)]
        }
        current.offerSent = true
        attempt = current
        return [.armTimer(.readyToAnswer(epoch: current.epoch), after: RENEW_READY_TO_ANSWER_MS),
                .createOffer(epoch: current.epoch)]
    }

    // MARK: - descriptions

    /// A local description for this epoch was applied, naming the local
    /// generation every local candidate will be measured against.
    public func localDescriptionApplied(epoch: UInt32,
                                        type: RelayRenewSDPType,
                                        sdp: String) -> [RelayRenewEffect] {
        guard !closed, var current = attempt, current.epoch == epoch else { return [] }
        let ufrag = relayRenewICEUfrag(sdp: sdp)
        guard !ufrag.isEmpty else {
            // Without a local ufrag no local candidate can be attributed to
            // this epoch, so observation could never hold and the attempt could
            // only ever time out. Ending it now keeps the old deadline sooner.
            return endEpoch(reason: .sdp, notifyPeer: true)
        }
        current.localUfrag = ufrag
        let held = current.pendingSelectedCandidate
        current.pendingSelectedCandidate = nil
        attempt = current
        guard let round = current.round else { return [] }
        var effects = sendMessage(.sdp(epoch: epoch, round: round, sdpType: type, sdp: sdp))
        if type == .answer {
            effects.append(.cancelTimer(.readyToAnswer(epoch: epoch)))
            effects.append(.armTimer(.iceProbe(epoch: epoch), after: RENEW_ICE_PROBE_MS))
        }
        // The retained report is re-examined against the generation that is
        // only now known. It still names its OWN generation, so this decides
        // nothing from whatever description happens to be current — it simply
        // asks the question that could not be answered when it arrived.
        if let held {
            effects.append(contentsOf: selectedLocalCandidate(sdp: held.local, remote: held.remote))
        }
        return effects
    }

    private func handleRemoteSDP(epoch: UInt32,
                                 round: UInt32,
                                 type: RelayRenewSDPType,
                                 sdp: String) -> [RelayRenewEffect] {
        guard var current = attempt, current.epoch == epoch else { return [] }
        guard current.round == round else { return [] }
        // One remote description per epoch. A second is not a correction, it is
        // a second negotiation on a live connection.
        guard !current.remoteApplied else { return [] }
        // The offerer is fixed by the link's established role, so an "offer"
        // from the responder — or an "answer" this side never asked for — is
        // refused before it reaches `setRemoteDescription`.
        let expected: RelayRenewSDPType = role == .initiator ? .answer : .offer
        guard type == expected else { return [] }
        if type == .answer { guard current.offerSent else { return [] } }
        // The pin. Every remote description at `epoch >= 1` must leave the DTLS
        // peer, the media shape and the answering role exactly as epoch 0's
        // applied description had them.
        guard let baseline else { return [] }
        guard baseline.admits(relayRenewPin(sdp: sdp), as: type) else {
            return endEpoch(reason: .sdp, notifyPeer: true)
        }
        let ufrag = relayRenewICEUfrag(sdp: sdp)
        guard !ufrag.isEmpty else { return endEpoch(reason: .sdp, notifyPeer: true) }
        current.remoteUfrag = ufrag
        attempt = current
        return [.applyRemoteDescription(sdp: sdp, type: type, epoch: epoch)]
    }

    /// `setRemoteDescription` returned. Held candidates for THIS generation may
    /// now follow it, in the order they arrived.
    public func remoteDescriptionApplied(epoch: UInt32, ok: Bool) -> [RelayRenewEffect] {
        guard !closed, var current = attempt, current.epoch == epoch else { return [] }
        guard ok else { return endEpoch(reason: .sdp, notifyPeer: true) }
        current.remoteApplied = true
        let ufrag = current.remoteUfrag ?? ""
        let heldSelection = current.pendingSelectedCandidate
        current.pendingSelectedCandidate = nil
        let releasable = current.held.filter { $0.ufrag == ufrag }
        // Everything else is a generation this epoch will never apply. Dropping
        // it here rather than holding it is what keeps the bound a bound.
        current.held = []
        var effects: [RelayRenewEffect] = releasable.map {
            .addRemoteCandidate(candidate: $0.candidate, sdpMid: $0.mid, sdpMLineIndex: $0.index)
        }
        if role == .responder {
            current.answerSent = true
            attempt = current
            effects.append(.createAnswer(epoch: epoch))
            // The responder's own local description has not been applied yet,
            // so any retained selection stays retained for that moment.
            if let heldSelection { attempt?.pendingSelectedCandidate = heldSelection }
            return effects
        }
        attempt = current
        effects.append(.cancelTimer(.readyToAnswer(epoch: epoch)))
        effects.append(.armTimer(.iceProbe(epoch: epoch), after: RENEW_ICE_PROBE_MS))
        // Both descriptions are applied now, so a selection that arrived early
        // can finally be answered.
        if let heldSelection {
            effects.append(contentsOf: selectedLocalCandidate(sdp: heldSelection.local,
                                                              remote: heldSelection.remote))
        }
        return effects
    }

    /// Re-pin after a `link:§8` authenticated transport rebuild. The epoch
    /// counter deliberately survives; the baseline deliberately does not.
    public func transportRebuilt(baseline: RelayRenewSDPPin?) -> [RelayRenewEffect] {
        guard !closed else { return [] }
        self.baseline = baseline
        guard attempt != nil else { return [] }
        // An epoch in flight belonged to a PeerConnection that is gone. Its
        // timers, queues and pending verifications go with it.
        return endEpoch(reason: .closed, notifyPeer: false)
    }

    // MARK: - candidates

    /// One locally gathered candidate.
    ///
    /// Labelled by the generation the CANDIDATE names, never by whatever epoch
    /// happens to be current: gathering is asynchronous and a restart can land
    /// between it and delivery. A candidate whose ufrag cannot be parsed is
    /// DROPPED, not sent — Apple's `RTCIceCandidate` exposes no
    /// `usernameFragment`, so the string extension is the only source here.
    public func localCandidate(sdp: String,
                               sdpMid: String?,
                               sdpMLineIndex: UInt32?) -> [RelayRenewEffect] {
        guard !closed else { return [] }
        let ufrag = relayRenewCandidateUfrag(candidate: sdp)
        guard !ufrag.isEmpty else { return [] }

        if let current = attempt, let localUfrag = current.localUfrag, let round = current.round {
            guard ufrag == localUfrag else { return [] }
            return sendMessage(.ice(epoch: current.epoch, round: round, candidate: sdp,
                                    sdpMid: sdpMid, sdpMLineIndex: sdpMLineIndex,
                                    usernameFragment: ufrag))
        }
        // After a commit, gathering does not stop. Every later candidate still
        // belongs to the generation the migration landed on, so it keeps
        // travelling SIGNED under the committed epoch and round (spec §6.6).
        // Letting it fall back to the ordinary unauthenticated path would put a
        // candidate for the new generation on a channel that carries no epoch
        // at all, which is the one thing the ufrag binding exists to prevent.
        if let held = committed, let localUfrag = held.localUfrag, ufrag == localUfrag {
            return sendMessage(.ice(epoch: held.epoch, round: held.round, candidate: sdp,
                                    sdpMid: sdpMid, sdpMLineIndex: sdpMLineIndex,
                                    usernameFragment: ufrag))
        }
        return []
    }

    private func handleRemoteCandidate(epoch: UInt32,
                                       round: UInt32,
                                       candidate: String,
                                       mid: String?,
                                       index: UInt32?,
                                       ufrag: String) -> [RelayRenewEffect] {
        guard var current = attempt, current.epoch == epoch, current.round == round else {
            return []
        }
        // Reconcile the field against the string's own extension. A candidate
        // that names two generations has named none this side may act on.
        let named = relayRenewInboundCandidateUfrag(candidate: candidate, usernameFragment: ufrag)
        guard !named.isEmpty else { return [] }
        if current.remoteApplied {
            guard named == current.remoteUfrag else { return [] }
            return [.addRemoteCandidate(candidate: candidate, sdpMid: mid, sdpMLineIndex: index)]
        }
        // The description it belongs to has not been applied yet. Hold it,
        // keyed by the generation it names, bounded.
        guard current.held.count < RENEW_MAX_HELD_CANDIDATES else { return [] }
        current.held.append((candidate: candidate, mid: mid, index: index, ufrag: named))
        attempt = current
        return []
    }

    // MARK: - observation and the probe

    /// The selected local candidate changed.
    ///
    /// Observation holds only when that candidate belongs to THIS epoch's ufrag
    /// generation — not when "the port changed", and not when a DataChannel is
    /// open. A `prflx` candidate, or any candidate whose generation cannot be
    /// determined, means observation has NOT held; the epoch then times out and
    /// the old deadline is kept.
    public func selectedLocalCandidate(sdp: String, remote: String = "") -> [RelayRenewEffect] {
        guard !closed, var current = attempt, !current.observationHeld else { return [] }
        // BOTH descriptions, not just this side's (spec §10). With only the
        // local one applied the connection can still be pairing this epoch's
        // new local candidate against the PREVIOUS generation's remote one —
        // a selection that is real, is this epoch's ufrag, and proves nothing
        // about the path the peer will actually use.
        guard let localUfrag = current.localUfrag, current.remoteApplied else {
            // Retained rather than dropped: `didChangeLocalCandidate` and the
            // two `set*Description` completions are independent asynchronous
            // events, the SDK may genuinely order them this way, and a settled
            // connection has no reason to produce a SECOND pair change for this
            // side to notice instead. The CANDIDATE STRING is what is kept, so
            // nothing is inferred from whatever description is current when it
            // is re-examined.
            current.pendingSelectedCandidate = (local: sdp, remote: remote)
            attempt = current
            return []
        }
        let ufrag = relayRenewCandidateUfrag(candidate: sdp)
        guard !ufrag.isEmpty, ufrag == localUfrag else { return [] }
        // Where the SDK's REMOTE candidate also names its generation, it has to
        // be this epoch's too (reconcile-2 R6): a new local candidate paired
        // against the peer's PREVIOUS generation is a real selection, carries
        // this epoch's local ufrag, and is not the migrated path. Where it
        // names none — a peer-reflexive remote carries no extension — nothing
        // is invented about it: the dual-endpoint proof stands on its own,
        // because the peer acks only after ITS OWN local observation held.
        let remoteUfrag = relayRenewCandidateUfrag(candidate: remote)
        if !remoteUfrag.isEmpty {
            guard remoteUfrag == current.remoteUfrag else { return [] }
        }
        guard let round = current.round else { return [] }
        current.observationHeld = true

        var effects: [RelayRenewEffect] = []
        // This side's own probe. The nonce is minted HERE and nowhere else,
        // which is what makes "the ack arrived after observation held"
        // structural: before this line there is no nonce for a peer to ack.
        let nonce = makeNonce()
        current.ownNonce = nonce
        current.ownNonceSends = 1
        attempt = current
        if let frame = probeFrame(type: .probe, epoch: current.epoch, round: round, nonce: nonce) {
            effects.append(.sendProbeFrame(frame))
            effects.append(.armTimer(.probeRetry(epoch: current.epoch), after: RENEW_PROBE_RETRY_MS))
        }
        // A probe that arrived while observation had not held is acked now,
        // from its single slot.
        if let pending = attempt?.pendingRemoteProbe {
            attempt?.pendingRemoteProbe = nil
            effects.append(contentsOf: ackProbe(pending))
        }
        return effects
    }

    /// One inbound control frame, already structurally parsed.
    ///
    /// Spec §6.4's verification order continues here, cheapest first: the
    /// epoch and round must match the in-flight attempt, the per-epoch budget
    /// must not be spent, and only then is an HMAC computed. An exact duplicate
    /// of an already-acked probe reuses the cached ack rather than buying a
    /// second verification.
    public func probeFrameReceived(_ frame: RelayRenewProbeFrame) -> [RelayRenewEffect] {
        guard !closed else { return [] }
        // The committed epoch, answering so the two ends converge (spec §6.6).
        // It grants nothing, moves no deadline and starts nothing.
        if committed != nil, let effects = answerFromCommitted(frame) { return effects }
        guard var current = attempt else { return [] }
        guard frame.epoch == current.epoch, frame.round == current.round else { return [] }
        if var cached = current.ackCache, cached.matches(frame) {
            // Idempotent, and bounded: the same EXACT frame gets the same ack
            // and spends no HMAC. A frame carrying this nonce with any other
            // tag does not match and falls through to the budgeted path below.
            guard cached.replaysLeft > 0 else { return [] }
            cached.replaysLeft -= 1
            current.ackCache = cached
            attempt = current
            return [.sendProbeFrame(cached.ack)]
        }
        // ONE budget of `RENEW_MAX_PROBE_VERIFICATIONS` per epoch, reserved in
        // two halves (reconcile-2 R5). Unreserved, eight forged PROBES would
        // spend every HMAC this epoch has, and the one genuine ACK that would
        // have committed it would then be refused unverified — a relay could
        // veto every renewal for the price of eight junk frames.
        switch frame.type {
        case .probe:
            guard current.probeVerifications < RENEW_PROBE_VERIFICATION_RESERVE else { return [] }
            current.probeVerifications += 1
        case .ack:
            // An exact precheck BEFORE the HMAC: an ack is only ever useful if
            // it names this side's own live nonce, so anything else is dropped
            // for free and cannot touch the ack reservation at all.
            guard let own = current.ownNonce, own == frame.nonce else { return [] }
            guard current.ackVerifications < RENEW_ACK_VERIFICATION_RESERVE else { return [] }
            current.ackVerifications += 1
        }
        attempt = current
        let payload = relayRenewProbePayload(type: frame.type,
                                             from: peerId,
                                             to: selfId,
                                             epoch: frame.epoch,
                                             round: frame.round,
                                             nonce: frame.nonce)
        guard verify(payload, Data(frame.tag).base64EncodedString()) else { return [] }

        switch frame.type {
        case .probe:
            guard attempt?.observationHeld == true else {
                // Retained in a SINGLE slot, latest nonce wins, and acked once
                // observation holds. A queue here would be a buffer a peer
                // controls.
                attempt?.pendingRemoteProbe = frame
                return []
            }
            return ackProbe(frame)
        case .ack:
            return commitIfAcked(frame)
        }
    }

    /// The three conditions of §6.5, and nothing else, move a deadline.
    private func commitIfAcked(_ frame: RelayRenewProbeFrame) -> [RelayRenewEffect] {
        guard var current = attempt, !current.committed else { return [] }
        // Observation held: the nonce only exists because it did.
        guard let nonce = current.ownNonce, nonce == frame.nonce else { return [] }
        guard let round = current.round, let config = current.config else { return [] }
        current.committed = true
        let epoch = current.epoch
        // The epoch outlives the attempt, with exactly the three abilities
        // spec §6.6 allows. Without this the peer retransmits five times into
        // silence and keeps its old deadline while this side renewed — a link
        // whose two ends disagree about when it dies.
        committed = RelayRenewCommitted(epoch: epoch,
                                        round: round,
                                        localUfrag: current.localUfrag,
                                        ackCache: current.ackCache,
                                        // The SAME epoch's counter, carried
                                        // over — never a fresh allowance.
                                        probeVerifications: current.probeVerifications)
        attempt = nil
        // A commit is a success, so nothing is backing off, and the pre-grant
        // budget is whole again. The MIGRATION budget of this round is
        // deliberately NOT reset: a later repair of it spends the same three.
        backoffUntilEpoch = nil
        preGrantFailures = 0
        installedRound = Swift.max(installedRound, round)
        installedConfig = config
        // A repair re-proved a credential this side was ALREADY bounded by. It
        // moves no deadline and re-arms no margin; only a fresh round does.
        let outcome: RelayRenewEffect = current.isRepair
            ? .recommitted(round: round)
            : .commit(round: round, config: config)
        return [.cancelTimer(.probeRetry(epoch: epoch)),
                .cancelTimer(.iceProbe(epoch: epoch)),
                .cancelTimer(.epochHardCap(epoch: epoch)),
                .armTimer(.postCommitAck(epoch: epoch), after: RENEW_POST_COMMIT_ACK_MS),
                outcome]
    }

    /// What a COMMITTED epoch does with one inbound frame, or nil when the
    /// frame is not its business.
    ///
    /// Two abilities, and the boundary between them is the HMAC:
    ///
    ///  - an **exact duplicate** of a frame already verified replays the cached
    ///    ack and spends nothing;
    ///  - a nonce this side has NOT seen — every earlier ack lost, and the peer
    ///    now probing with a fresh one — is verified under a bounded budget of
    ///    its own and acked.
    ///
    /// An `ack` reaching here is ignored: this side has already committed, and
    /// §6.6 forbids moving a deadline again.
    private func answerFromCommitted(_ frame: RelayRenewProbeFrame) -> [RelayRenewEffect]? {
        guard var held = committed else { return nil }
        guard frame.epoch == held.epoch, frame.round == held.round else { return nil }
        guard frame.type == .probe else { return [] }

        if var cached = held.ackCache, cached.matches(frame) {
            guard cached.replaysLeft > 0 else { return [] }
            cached.replaysLeft -= 1
            held.ackCache = cached
            committed = held
            return [.sendProbeFrame(cached.ack)]
        }
        guard held.probeVerifications < RENEW_PROBE_VERIFICATION_RESERVE else { return [] }
        held.probeVerifications += 1
        committed = held
        let payload = relayRenewProbePayload(type: .probe, from: peerId, to: selfId,
                                             epoch: frame.epoch, round: frame.round,
                                             nonce: frame.nonce)
        guard verify(payload, Data(frame.tag).base64EncodedString()) else { return [] }
        guard let ack = probeFrame(type: .ack, epoch: frame.epoch, round: frame.round,
                                   nonce: frame.nonce) else { return [] }
        held.ackCache = RelayRenewAckCache(epoch: frame.epoch, round: frame.round,
                                           nonce: frame.nonce, tag: frame.tag,
                                           ack: ack, replaysLeft: RENEW_PROBE_MAX_SENDS)
        committed = held
        return [.sendProbeFrame(ack)]
    }

    private func ackProbe(_ frame: RelayRenewProbeFrame) -> [RelayRenewEffect] {
        guard var current = attempt else { return [] }
        guard let ack = probeFrame(type: .ack,
                                   epoch: frame.epoch,
                                   round: frame.round,
                                   nonce: frame.nonce) else { return [] }
        current.ackCache = RelayRenewAckCache(epoch: frame.epoch,
                                              round: frame.round,
                                              nonce: frame.nonce,
                                              tag: frame.tag,
                                              ack: ack,
                                              replaysLeft: RENEW_PROBE_MAX_SENDS)
        attempt = current
        return [.sendProbeFrame(ack)]
    }

    private func probeFrame(type: RelayRenewProbeType,
                            epoch: UInt32,
                            round: UInt32,
                            nonce: [UInt8]) -> [UInt8]? {
        let payload = relayRenewProbePayload(type: type,
                                             from: selfId,
                                             to: peerId,
                                             epoch: epoch,
                                             round: round,
                                             nonce: nonce)
        guard let tag = Data(base64Encoded: sign(payload)), tag.count == RENEW_PROBE_TAG_BYTES
        else { return nil }
        return relayRenewProbeFrame(type: type, epoch: epoch, round: round,
                                    nonce: nonce, tag: Array(tag))
    }

    // MARK: - time

    public func timerFired(_ timer: RelayRenewTimer) -> [RelayRenewEffect] {
        guard !closed else { return [] }
        switch timer {
        case let .postCommitAck(epoch):
            // The peer's own ICE+probe window cannot outlive this, so there is
            // nobody left to converge with. Dropped rather than kept, because a
            // cache nobody can use is a cache a replay can still spend.
            if committed?.epoch == epoch { committed = nil }
            return []
        case let .retryBackoff(epoch):
            guard backoffUntilEpoch == epoch else { return [] }
            backoffUntilEpoch = nil
            // Deliberately does NOT start an attempt by itself. The next
            // trigger — the margin, or the next user data inside it — decides,
            // and it re-reads the activity clock when it does.
            return []
        default:
            break
        }
        guard let current = attempt, current.epoch == timer.epoch else { return [] }
        switch timer {
        case .prepareSilence:
            // Two prepares about ten seconds apart with no reply. The UI must
            // not claim a renewal happened, and this link stops trying.
            guard !sawVerifiedPeerSignal else { return [] }
            if prepareSends < 2 {
                prepareSends += 1
                var effects = sendMessage(.prepare(epoch: current.epoch))
                effects.append(.armTimer(.prepareSilence(epoch: current.epoch),
                                         after: RENEW_PREPARE_SILENCE_MS))
                return effects
            }
            peerUnsupported = true
            var effects = endEpoch(reason: .timeout, notifyPeer: false)
            effects.append(.peerUnsupported)
            return effects
        case .probeRetry:
            guard let nonce = current.ownNonce, let round = current.round else { return [] }
            guard current.ownNonceSends < RENEW_PROBE_MAX_SENDS else { return [] }
            attempt?.ownNonceSends += 1
            guard let frame = probeFrame(type: .probe, epoch: current.epoch,
                                         round: round, nonce: nonce) else { return [] }
            return [.sendProbeFrame(frame),
                    .armTimer(.probeRetry(epoch: current.epoch), after: RENEW_PROBE_RETRY_MS)]
        case .prepareToReady, .readyToAnswer, .iceProbe, .epochHardCap:
            return endEpoch(reason: .timeout, notifyPeer: true)
        case .postCommitAck, .retryBackoff:
            // Handled above, before the attempt is consulted: neither belongs
            // to one.
            return []
        }
    }

    // MARK: - ending

    /// Void the current epoch. The OLD deadline stands, always, and every
    /// timer, queue and pending verification that belonged to the epoch goes
    /// with it.
    /// - Parameter startsBackoff: whether this ending should make the next
    ///   LOCAL attempt wait. A peer-driven adoption and a close do not: the
    ///   first is replacing this epoch immediately under a higher number, and
    ///   the second has nothing left to wait for.
    private func endEpoch(reason: RelayRenewAbortReason,
                          notifyPeer: Bool,
                          startsBackoff: Bool = true) -> [RelayRenewEffect] {
        guard let current = attempt else { return [] }
        let epoch = current.epoch
        attempt = nil
        var effects: [RelayRenewEffect] = []
        if notifyPeer {
            effects.append(contentsOf: sendMessage(.abort(epoch: epoch, reason: reason)))
        }
        effects.append(.cancelTimer(.prepareToReady(epoch: epoch)))
        effects.append(.cancelTimer(.readyToAnswer(epoch: epoch)))
        effects.append(.cancelTimer(.iceProbe(epoch: epoch)))
        effects.append(.cancelTimer(.epochHardCap(epoch: epoch)))
        effects.append(.cancelTimer(.prepareSilence(epoch: epoch)))
        effects.append(.cancelTimer(.probeRetry(epoch: epoch)))
        effects.append(.epochEnded(epoch: epoch, reason: reason))
        if startsBackoff {
            if !current.obtainedConfig { preGrantFailures += 1 }
            backoffUntilEpoch = epoch
            effects.append(.armTimer(.retryBackoff(epoch: epoch), after: RENEW_RETRY_BACKOFF_MS))
        }
        return effects
    }

    /// The link, the room or the transport is gone. Terminal: no later input is
    /// accepted, so a late callback cannot resurrect a listener or a timer.
    public func close() -> [RelayRenewEffect] {
        guard !closed else { return [] }
        var effects = endEpoch(reason: .closed, notifyPeer: false, startsBackoff: false)
        closed = true
        if let epoch = committed?.epoch {
            effects.append(.cancelTimer(.postCommitAck(epoch: epoch)))
        }
        committed = nil
        if let epoch = backoffUntilEpoch {
            effects.append(.cancelTimer(.retryBackoff(epoch: epoch)))
        }
        backoffUntilEpoch = nil
        effects = effects.filter { if case .sendSignal = $0 { return false } else { return true } }
        return effects
    }

    // MARK: - outbound

    private func sendMessage(_ message: RelayRenewMessage) -> [RelayRenewEffect] {
        let payload = relayRenewPayload(message, from: selfId, to: peerId)
        return [.sendSignal(relayRenewSignal(message, auth: sign(payload)))]
    }
}
