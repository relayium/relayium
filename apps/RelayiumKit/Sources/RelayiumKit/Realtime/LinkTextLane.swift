import Foundation

/// Conversation limits, matching `web/src/lib/text-session.svelte.ts` so the
/// two ends of a link agree about what a flood is.
///
/// ONE pair of numbers for TWO independent buckets, exactly as the web spends
/// `TEXT_BURST`/`TEXT_PER_SEC` on both: lifecycle controls are limited per
/// transport generation, authenticated text frames are limited per conversation.
/// Separate buckets because their failures cost different things — see
/// `LinkTextLane`.
public let LINK_TEXT_BURST = 20
public let LINK_TEXT_PER_SEC = 5.0
public let LINK_TEXT_SESSION_MAX_MESSAGES = 500
public let LINK_TEXT_SESSION_MAX_BYTES = 4 << 20
/// A consent prompt is conversation state, not link activity. It needs a
/// bounded exit even though pending consent keeps the link's idle lease alive.
public let LINK_TEXT_CONSENT_TIMEOUT_MS = 600_000
/// END acknowledgement is an ordering barrier, not an unbounded lease.
public let LINK_TEXT_END_ACK_TIMEOUT_MS = 30_000

public enum LinkTextStatus: Equatable, Sendable {
    case idle
    /// This side asked; the peer has not answered.
    case waitingAccept
    /// The peer asked; this side has not answered.
    case incomingRequest
    case open
    /// A conversation that existed and does not any more. Not an error: the
    /// transcript stays, and the lane can be reopened.
    case ended
    case refused
    /// Terminal for this lane only. The file lane and the peer link are
    /// deliberately untouched.
    case failed
}

/// What the driver must do, in order, as a result of one event.
public enum LinkTextEffect: Equatable, Sendable {
    case sendControl(UInt8)
    case armConsentTimeout
    case cancelConsentTimeout
    case armEndAckTimeout
    case cancelEndAckTimeout
    /// Hand this frame to the link's text receiver. `discard` means authenticate
    /// it — the sequence must be consumed — but never render it.
    case feedProtected(discard: Bool)
    /// This lane's codecs can no longer be proven safe to reuse.
    case poisonCodecs
    case closeLane
}

public struct LinkTextGapOutcome: Equatable, Sendable {
    /// Did this lane have work worth holding the whole link — and the
    /// initiator's ICE/TURN allocations — open for?
    public let needsRecovery: Bool
    /// What the driver must do, in order, because of this gap.
    ///
    /// A gap is a state transition like any other, and it ends conversations,
    /// disarms timers and can prove the lane unrecoverable. Returning only the
    /// recovery answer left every one of those effects unexpressed: the driver
    /// was told a gap had happened and nothing about what it had to do, so an
    /// armed consent prompt would fire into a lane that no longer had a
    /// conversation, and a lane the gap PROVED unrecoverable was never poisoned
    /// or closed. There is no production driver yet, which is exactly why this
    /// is the moment to widen the type rather than to work around it.
    public let effects: [LinkTextEffect]

    public init(needsRecovery: Bool, effects: [LinkTextEffect] = []) {
        self.needsRecovery = needsRecovery
        self.effects = effects
    }
}

/// A token bucket, clock-injected, shaped exactly after the web's
/// `createRateBucket`.
///
/// Whole tokens only: a fractional allowance would let a peer sustain slightly
/// above the configured rate forever. A clock that goes BACKWARDS mints nothing
/// and does not move the mark either — `Date` does jump, on an NTP correction or
/// a laptop waking, and the answer is to ignore the jump rather than to trust it.
struct LinkTextRateBucket {
    private var tokens: Double
    private var last: TimeInterval

    init(now: TimeInterval) {
        self.tokens = Double(LINK_TEXT_BURST)
        self.last = now
    }

    mutating func take(at instant: TimeInterval) -> Bool {
        if instant > last {
            tokens = min(Double(LINK_TEXT_BURST), tokens + (instant - last) * LINK_TEXT_PER_SEC)
            last = instant
        }
        guard tokens >= 1 else { return false }
        tokens -= 1
        return true
    }
}

/// ONE conversation's protected-frame budget: its own rate bucket, plus the
/// message and byte caps.
///
/// A class, and that is the whole point of it. The web captures this object at
/// the instant a local END opens a drain (`inboundDrain = budget`), so frames
/// that are authenticated only to be discarded keep spending the conversation
/// they actually belong to. Starting a later consent window replaces the lane's
/// current budget with a NEW object, which is what makes it impossible for a
/// later conversation to retroactively refill a drain that is still running —
/// the drain is holding the old object, not a field somebody can reset.
final class LinkTextConversationBudget {
    private var bucket: LinkTextRateBucket
    private(set) var count = 0
    private(set) var bytes = 0

    init(now: TimeInterval) {
        self.bucket = LinkTextRateBucket(now: now)
    }

    /// Spend one protected frame against this conversation. False means the
    /// frame is over the rate, the message cap or the byte cap — all three of
    /// which the caller must treat identically, because the frame has not been
    /// fed and the receiver sequence can no longer be proven.
    func admit(byteCount: Int, at instant: TimeInterval) -> Bool {
        guard bucket.take(at: instant) else { return false }
        // Subtraction rather than `bytes + byteCount`: the framed length is
        // peer-controlled, and an addition near `Int.max` wraps into a value
        // that passes the cap. `bytes` stays inside `0...LINK_TEXT_SESSION_MAX_BYTES`
        // precisely because this guard is what admits it.
        guard count < LINK_TEXT_SESSION_MAX_MESSAGES,
              byteCount <= LINK_TEXT_SESSION_MAX_BYTES - bytes else { return false }
        count += 1
        bytes += byteCount
        return true
    }
}

/// One reusable text conversation lane on a long-lived authenticated link.
///
/// ## The invariant
///
/// The link owns exactly one `RealtimeTextSender` and one
/// `RealtimeTextReceiver` for its whole life. Ending a conversation therefore
/// must NEVER reset an AEAD sequence — a restart reuses an AES-GCM nonce under
/// the same key. Everything in this file exists to keep that true while two
/// humans press buttons in an arbitrary order and the network drops underneath
/// them.
///
/// ## Why the lifecycle is this fussy
///
/// A local END cannot identify the peer's last already-in-flight message. Those
/// frames were sealed under sequence numbers this side must still consume, or
/// the receiver spends the rest of the link expecting a sequence the peer has
/// already used. So END is an ordering BARRIER, not a hangup: after it, frames
/// keep being authenticated and are simply never shown, until the peer's own
/// ordered marker closes the window.
///
/// When that barrier cannot be established — the acknowledgement never arrives,
/// or a protected frame was handed to `send()` and never left the buffer — the
/// sequence is genuinely unknowable, and the only honest answer is to poison
/// THIS lane. The file lane is independent and survives all of it.
///
/// ## Two buckets, because a flood costs two different things
///
/// Lifecycle controls consume no AEAD sequence, so flooding them may close this
/// channel GENERATION while leaving codecs a replacement transport can still
/// reuse. A protected frame is the opposite: it has already been admitted in
/// wire order, so refusing to feed it leaves the receiver expecting a sequence
/// the peer has already spent, and the only honest answer is to poison these
/// codecs. The two therefore get independent buckets on independent lifetimes —
/// the lifecycle bucket per transport generation, the protected-frame bucket per
/// conversation — and neither ever reaches the file lane.
///
/// Pure and synchronous by design: none of this is reachable through a live
/// `RTCDataChannel` in a test, and all of it is where the bugs are. Pinned
/// against `web/src/lib/mixed-text-session.svelte.ts`.
public final class LinkTextLane {
    public private(set) var status: LinkTextStatus = .idle
    /// How many conversations this lane has opened. Observable so a test can
    /// state the reuse claim directly.
    public private(set) var conversationCount = 0
    public private(set) var codecsPoisoned = false

    private let role: Role
    private let now: () -> TimeInterval

    /// A local END opened a drain: authenticate what follows, render none of it,
    /// until the peer's ordered marker arrives. Holds the ENDED conversation's
    /// budget, so discarded frames keep spending what they were always spending.
    private var inboundDrain: LinkTextConversationBudget?
    /// Our request timed out or was crossed by an END. An ACCEPT that arrives
    /// after it is still an ordered barrier for the attempt it belongs to, so it
    /// converts into a discard-only drain rather than reopening anything —
    /// carrying that attempt's budget across with it.
    private var lateAcceptBudget: LinkTextConversationBudget?
    private var awaitingEndAck = false
    /// A protected frame has been handed to the transport since the last time
    /// the buffer was observed empty.
    private var protectedSendPending = false
    private var suspended = false
    private var recoveryIntent = false

    /// Whether the driver is currently holding a timer this lane armed.
    ///
    /// Kept separately from the states that imply them, because "the barrier is
    /// outstanding" and "a timer for that barrier is armed" are the same thing
    /// everywhere EXCEPT inside the callback that is firing — which is exactly
    /// the case a cancellation must not be emitted for.
    private var consentArmed = false
    private var endAckArmed = false

    /// The lifecycle bucket. Token bucket rather than a plain counter so a long,
    /// legitimate session of open/end cycles is not eventually refused. Scoped
    /// to the transport generation: a replacement channel starts full.
    private var lifecycle: LinkTextRateBucket
    /// The CURRENT conversation's protected-frame budget. Replaced — never
    /// reset — at each consent window, so a drain holding the previous object
    /// is unaffected by it.
    private var budget: LinkTextConversationBudget

    public init(role: Role, now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.role = role
        self.now = now
        let started = now()
        self.lifecycle = LinkTextRateBucket(now: started)
        self.budget = LinkTextConversationBudget(now: started)
    }

    /// Plaintext may cross this lane in either direction only while a
    /// conversation both sides consented to is open.
    public var maySendProtected: Bool { status == .open }

    public var isActive: Bool {
        awaitingEndAck || status == .waitingAccept || status == .incomingRequest || status == .open
    }

    // MARK: - local intent

    public func localOpen() -> [LinkTextEffect] {
        guard !codecsPoisoned else { return [] }
        // The web's `openWith` gates on `active()`, and `active()` includes
        // `awaitingEndAck`. The status is already `ended` while an END barrier
        // is outstanding, so without this a reopen would emit a REQUEST that the
        // peer's still-pending acknowledgement of the PREVIOUS conversation can
        // cancel, and would arm a second consent window underneath a barrier
        // that has not closed. Relying on the late acknowledgement being inert
        // is not the same property: the acknowledgement is not late, it is
        // exactly on time for a conversation this side has not finished ending.
        guard !awaitingEndAck else { return [] }
        switch status {
        case .idle, .ended, .refused:
            break
        case .waitingAccept, .incomingRequest, .open, .failed:
            return []
        }
        status = .waitingAccept
        return [.sendControl(LINK_TEXT_REQUEST)] + beginConsent()
    }

    public func localAccept() -> [LinkTextEffect] {
        guard status == .incomingRequest, !codecsPoisoned else { return [] }
        // The protected-receive path becomes active BEFORE ACCEPT reaches the
        // peer, so a message sent the instant it lands is never orphaned.
        inboundDrain = nil
        lateAcceptBudget = nil
        let cancelled = cancelConsent()
        openConversation()
        return cancelled + [.sendControl(RealtimeControl.accept.rawValue)]
    }

    public func localReject() -> [LinkTextEffect] {
        guard status == .incomingRequest, !codecsPoisoned else { return [] }
        status = .refused
        return cancelConsent() + [.sendControl(RealtimeControl.reject.rawValue)]
    }

    public func localEnd() -> [LinkTextEffect] {
        guard !codecsPoisoned else { return [] }
        return startLocalEnd()
    }

    // MARK: - timers

    public func consentTimedOut() -> [LinkTextEffect] {
        guard status == .waitingAccept || status == .incomingRequest else { return [] }
        // The timer has already fired, so it is no longer armed. Recording that
        // first is what stops the transition below from telling the driver to
        // cancel the very callback it is running inside.
        consentArmed = false
        return startLocalEnd()
    }

    public func endAckTimedOut() -> [LinkTextEffect] {
        guard awaitingEndAck, !codecsPoisoned else { return [] }
        // Same rule for the other timer: `failLane` cancels whatever is still
        // armed, and this one no longer is.
        endAckArmed = false
        // Reopening with an unknown number of unobserved old frames would reuse a
        // receiver sequence unsafely.
        return failLane(poison: true)
    }

    // MARK: - inbound

    public func inboundControl(_ byte: UInt8) -> [LinkTextEffect] {
        guard let kind = linkTextLifecycleKind([byte]) else { return [] }
        return inboundControl(kind)
    }

    public func inboundControl(_ kind: LinkTextControl) -> [LinkTextEffect] {
        guard !codecsPoisoned, status != .failed else { return [] }
        guard lifecycle.take(at: now()) else {
            // A flood is a channel-generation problem, not a codec problem.
            return failLane(poison: false)
        }
        switch kind {
        case .request: return inboundRequest()
        case .accept: return inboundAccept()
        case .reject: return inboundReject()
        case .end: return inboundEnd()
        }
    }

    /// One protected (kind-9) frame arrived. `byteCount` is the framed length,
    /// which is what the per-conversation budget is measured in.
    public func inboundProtectedFrame(byteCount: Int) -> [LinkTextEffect] {
        guard !codecsPoisoned, status != .failed else { return [] }
        if status == .open {
            // Over the rate, over 500 messages or over 4 MiB are ONE outcome,
            // and it is the poisoning one. The frame was admitted in wire order
            // and is not being fed, so the receiver is left expecting a sequence
            // the peer has already spent — which no replacement transport can
            // repair. The file lane is independent and survives it.
            guard budget.admit(byteCount: byteCount, at: now()) else {
                return failLane(poison: true)
            }
            return [.feedProtected(discard: false)]
        }
        if let drain = inboundDrain, status == .ended {
            // Sent before the peer observed our END. Feed it so the link-scoped
            // receive sequence stays continuous, but never render it and never
            // let it reach a later consent decision.
            //
            // Charged to the ENDED conversation's own budget, which is the whole
            // reason that budget is a captured object: a peer cannot buy a fresh
            // rate, message or byte allowance by making this side end, and a
            // later conversation cannot refill a drain that is still running.
            guard drain.admit(byteCount: byteCount, at: now()) else {
                return failLane(poison: true)
            }
            return [.feedProtected(discard: true)]
        }
        // A later conversation's acceptance cannot authorize content sent before
        // it, and dropping the frame would desynchronise the link-scoped nonce.
        // So this is a hard text-lane failure — and only a text-lane one.
        return failLane(poison: true)
    }

    /// A protected frame has been handed to the transport. Paired with the
    /// buffered-byte reading at a gap: `send()` only enqueues, so bytes still
    /// buffered when the transport dies mean the sender nonce may have advanced
    /// without the peer ever seeing the frame.
    public func didSendProtected() {
        protectedSendPending = true
    }

    /// The transport's send buffer was observed empty, so everything handed to
    /// it has left.
    public func didFlushSendBuffer() {
        protectedSendPending = false
    }

    /// End this lane from the owner above it, and hand back what that requires.
    ///
    /// This lane sees a frame's LENGTH and its consent state; it has no keys, so
    /// the failures that depend on content are invisible to it. "The receiver
    /// refused this frame" and "a frame this side sealed never left the buffer"
    /// are both violations only the owner can detect, and both leave the same
    /// question unanswerable — which nonces the peer has consumed. Routing them
    /// through here rather than letting an owner keep its own terminal flag is
    /// what keeps ONE terminal path: the timers are disarmed, the drains are
    /// dropped, and the codecs cannot be poisoned without the lane being closed.
    ///
    /// Idempotent, and scoped to THIS lane: nothing here reaches the file lane,
    /// the transport or the peer link.
    @discardableResult
    public func failClosed() -> [LinkTextEffect] {
        guard !codecsPoisoned else { return [] }
        return failLane(poison: true)
    }

    // MARK: - transport gaps

    /// Enter a transport gap. Idempotent: a channel `onclose` and the peer
    /// connection's own terminal callback are ONE gap, however many times they
    /// report it.
    @discardableResult
    public func transportGap(bufferedBytes: Int = 0) -> LinkTextGapOutcome {
        guard !suspended else { return LinkTextGapOutcome(needsRecovery: false) }
        suspended = true
        // Sampled before anything below moves the status to ended or failed.
        recoveryIntent = recoveryIntent || isActive
        if protectedSendPending, bufferedBytes > 0 {
            // `failLane`'s effects are the POINT of this branch, not a detail of
            // it: poisoning the codecs and closing the lane are things only the
            // driver can do, and dropping them told it a gap had happened and
            // nothing about the lane the gap had just proven unrecoverable.
            let effects = failLane(poison: true)
            return LinkTextGapOutcome(needsRecovery: recoveryIntent, effects: effects)
        }
        // A lane whose codecs are already poisoned is already terminal, and
        // `failLane` disarmed its timers on the way there. The web's `suspend`
        // guards `markTransportInterrupted` the same way.
        guard !codecsPoisoned else {
            return LinkTextGapOutcome(needsRecovery: recoveryIntent)
        }
        // A consent prompt belongs to a transport that no longer exists, exactly
        // as the web's `markTransportInterrupted` finishes it before it looks at
        // anything else.
        var effects = cancelConsent()
        if isActive {
            // End the interrupted conversation VISIBLY. Nothing is replayed:
            // consent was given on a transport that no longer exists.
            effects += cancelEndAck()
            awaitingEndAck = false
            inboundDrain = nil
            lateAcceptBudget = nil
            status = .ended
        }
        return LinkTextGapOutcome(needsRecovery: recoveryIntent, effects: effects)
    }

    /// A replacement transport answers the question the gap recorded. Same
    /// authenticated link, same codecs, new channel.
    ///
    /// Returns effects for the same reason `transportGap` does: the web's
    /// `attach` finishes BOTH timers, and a driver that attached a replacement
    /// without routing the gap first would otherwise keep a consent prompt armed
    /// over a conversation this attachment has already declared ended.
    public func didAttachReplacementTransport() -> [LinkTextEffect] {
        let cancelled = cancelConsent() + cancelEndAck()
        suspended = false
        recoveryIntent = false
        protectedSendPending = false
        awaitingEndAck = false
        inboundDrain = nil
        lateAcceptBudget = nil
        // Both buckets start full on a new channel: the lifecycle bucket is
        // scoped to the transport generation, and there is no conversation left
        // for the previous budget to belong to. One clock reading for both, so
        // the two cannot be marked at instants a real `Date` put microseconds
        // apart.
        let attachedAt = now()
        lifecycle = LinkTextRateBucket(now: attachedAt)
        budget = LinkTextConversationBudget(now: attachedAt)
        guard !codecsPoisoned else {
            status = .failed
            return cancelled
        }
        if status != .idle, status != .refused { status = .ended }
        return cancelled
    }

    // MARK: - inbound lifecycle handling

    private func inboundRequest() -> [LinkTextEffect] {
        // REQUEST is ordered after every protected frame the peer sent for its
        // previous conversation, so it closes any local-END drain window — and
        // with it the END barrier that window was waiting on, exactly as the
        // web's `receiveRequest` clears `awaitingEndAck` and `finishEndAck()`
        // together.
        //
        // The cancellation is emitted ONLY when a timer is actually armed, which
        // `cancelEndAck` is the single place that decides. Emitting it
        // unconditionally would tell the driver to cancel one it never armed,
        // which is the kind of approximate effect this state machine exists to
        // avoid. The barrier state is cleared either way: it is over regardless
        // of whether its timer had already fired.
        inboundDrain = nil
        lateAcceptBudget = nil
        let prefix = cancelEndAck()
        awaitingEndAck = false

        // The cancellation leads, so a barrier being torn down can never follow
        // the arming of the prompt that replaces it.
        switch status {
        case .waitingAccept:
            // Both users asked at once. The smaller peer keeps its outbound
            // request; the larger peer converts its own intent into the one
            // incoming consent prompt. This converges without a second link and
            // without a duplicate conversation.
            if role == .initiator {
                return prefix + [.sendControl(RealtimeControl.reject.rawValue)]
            }
            status = .incomingRequest
            return prefix + beginConsent()
        case .incomingRequest:
            return prefix                               // duplicate REQUEST
        case .open:
            return prefix + [.sendControl(RealtimeControl.reject.rawValue)]
        case .idle, .ended, .refused:
            status = .incomingRequest
            return prefix + beginConsent()
        case .failed:
            return prefix
        }
    }

    private func inboundAccept() -> [LinkTextEffect] {
        if status == .waitingAccept {
            inboundDrain = nil
            lateAcceptBudget = nil
            let cancelled = cancelConsent()
            openConversation()
            return cancelled
        }
        if status == .ended, let late = lateAcceptBudget {
            // ACCEPT was sent before the peer observed our timeout, or before a
            // crossing END from an older attempt. It is an ordered barrier:
            // authenticate later frames only to drain that attempt — against the
            // budget that attempt was already spending.
            inboundDrain = late
            lateAcceptBudget = nil
        }
        return []
    }

    private func inboundReject() -> [LinkTextEffect] {
        if awaitingEndAck {
            // REJECT was emitted before the peer observed our END. On an ordered
            // channel it is still a complete barrier for that conversation.
            return closeEndAck()
        }
        if status == .waitingAccept {
            inboundDrain = nil
            lateAcceptBudget = nil
            status = .refused
            return cancelConsent()
        }
        return []
    }

    private func inboundEnd() -> [LinkTextEffect] {
        if awaitingEndAck { return closeEndAck() }
        if status == .ended, inboundDrain != nil || lateAcceptBudget != nil {
            // A late ACCEPT may have crossed the END that closed our outbound
            // request. This later ordered END is the safe drain barrier.
            inboundDrain = nil
            lateAcceptBudget = nil
            return []
        }
        switch status {
        case .waitingAccept, .incomingRequest, .open:
            let cancelled = cancelConsent()
            // An END can belong to the peer's immediately preceding request
            // while our own REQUEST is already in flight. Preserve a
            // discard-only budget so a crossing ACCEPT or protected frame can
            // neither poison nor leak into a later conversation before our
            // symmetric END reaches the peer. It is THIS attempt's budget, so
            // whatever it has already spent stays spent.
            lateAcceptBudget = status == .waitingAccept ? budget : nil
            inboundDrain = nil
            status = .ended
            // The symmetric END is the ordered drain barrier for the side that
            // did not end first. `awaitingEndAck` stays false, which is what
            // stops an acknowledgement loop.
            return cancelled + [.sendControl(LINK_TEXT_END)]
        default:
            return []
        }
    }

    private func closeEndAck() -> [LinkTextEffect] {
        awaitingEndAck = false
        inboundDrain = nil
        lateAcceptBudget = nil
        status = .ended
        return cancelConsent() + cancelEndAck()
    }

    // MARK: - shared transitions

    private func startLocalEnd() -> [LinkTextEffect] {
        // The status is decided BEFORE any timer is touched: a call that ends
        // nothing must also cancel nothing.
        switch status {
        case .waitingAccept, .incomingRequest, .open: break
        default: return []
        }
        var effects = cancelConsent()
        if status == .incomingRequest {
            // No ACCEPT was sent, so the peer could never enter its protected
            // send state. REJECT is the complete ordered barrier and — unlike
            // END — cannot produce a stale acknowledgement that would cancel an
            // immediately reopened outbound request.
            status = .ended
            effects.append(.sendControl(RealtimeControl.reject.rawValue))
            return effects
        }
        // The drain carries this conversation's budget, so the frames still in
        // flight are charged to the conversation that authorised them.
        if status == .open { inboundDrain = budget } else { lateAcceptBudget = budget }
        awaitingEndAck = true
        endAckArmed = true
        status = .ended
        effects.append(.sendControl(LINK_TEXT_END))
        effects.append(.armEndAckTimeout)
        return effects
    }

    private func openConversation() {
        status = .open
        conversationCount += 1
    }

    /// Open a consent window: a fresh conversation budget and a bounded exit.
    ///
    /// The cancellation leads the arming, because the web's `beginConversation`
    /// is literally a `clearTimeout` followed by a `setTimeout` — a prompt that
    /// replaces an outstanding one must not leave the driver holding two.
    ///
    /// The budget is REPLACED rather than reset, which is what keeps a drain
    /// holding the previous object unaffected by a later conversation.
    private func beginConsent() -> [LinkTextEffect] {
        let cancelled = cancelConsent()
        budget = LinkTextConversationBudget(now: now())
        consentArmed = true
        return cancelled + [.armConsentTimeout]
    }

    /// The cancellation for a timer that is genuinely armed, and nothing at all
    /// otherwise. A driver told to cancel a timer it never armed — or one that
    /// is firing right now — is being handed an approximate effect list, which
    /// is the class of mistake this state machine exists to remove.
    private func cancelConsent() -> [LinkTextEffect] {
        guard consentArmed else { return [] }
        consentArmed = false
        return [.cancelConsentTimeout]
    }

    private func cancelEndAck() -> [LinkTextEffect] {
        guard endAckArmed else { return [] }
        endAckArmed = false
        return [.cancelEndAckTimeout]
    }

    private func failLane(poison: Bool) -> [LinkTextEffect] {
        // The web's `markFailed` finishes BOTH timers, and so must this: a lane
        // that is terminal has no conversation left for a consent prompt to
        // resolve and no barrier left for an END acknowledgement to close, so a
        // timer left armed here fires a callback into a lane that is over.
        var effects = cancelConsent() + cancelEndAck()
        awaitingEndAck = false
        inboundDrain = nil
        lateAcceptBudget = nil
        // A lane that is over has nothing a replacement transport could restore,
        // so it withdraws its claim on the link's recovery window rather than
        // spending it — and the initiator's ICE/TURN allocations with it.
        recoveryIntent = false
        status = .failed
        guard poison else {
            effects.append(.closeLane)
            return effects
        }
        codecsPoisoned = true
        effects.append(.poisonCodecs)
        effects.append(.closeLane)
        return effects
    }
}
