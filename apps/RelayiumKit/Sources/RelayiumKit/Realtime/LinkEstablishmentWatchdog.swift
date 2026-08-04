import Foundation

/// The total time one `link/1` establishment may take, from the first thing it
/// does to a published transport. Never re-armed by anything.
///
/// Byte-for-byte the deployed web client's `SETUP_HARD_CAP_MS`
/// (`web/src/lib/webrtc-core.ts`), and deliberately so: two peers that disagree
/// about how long they are willing to wait produce a link where one side has
/// already given up and the other is still holding a PeerConnection open.
public let LINK_SETUP_HARD_CAP_SECONDS: TimeInterval = 90

/// How long an establishment may go without a single piece of genuine progress
/// WHILE IT IS STILL BUILDING ITS TRANSPORT.
///
/// It covers exactly the phase it can speak about — SDP, ICE and DCEP — and is
/// retired the instant both lanes are open, because from there the only thing
/// outstanding travels over the signalling socket and `LINK_KEY_REVEAL_TIMEOUT_
/// SECONDS` is the deadline that describes it. Leaving both armed would be a
/// race between two windows for the same wait, and with the shipped values —
/// both 30 s — the transport deadline always won: `.keyReveal` could not be
/// reported in production at all, so every two-lane link that lost its peer's
/// reveal blamed "the peer stopped answering" for a connection that was open
/// and healthy.
///
/// The web's `NO_PROGRESS_TIMEOUT_MS`, and it exists because one flat deadline
/// is wrong in both directions. ICE can sit in `checking` forever without ever
/// reaching `failed` — no reachable path, a blocked TURN — so there has to be a
/// backstop; but a flat 30 s cuts off exactly the connections that are working,
/// because a phone radio waking from idle plus two TURN Allocates (the first of
/// which always eats a 401 challenge) plus hole punching legitimately exceeds
/// it.
public let LINK_NO_PROGRESS_TIMEOUT_SECONDS: TimeInterval = 30

/// How long a link with both lanes open may wait for the peer's key reveal.
///
/// The web's `KEY_REVEAL_TIMEOUT_MS`, measured from the moment the lanes open
/// rather than from the start, for the reason that file records: a reveal
/// travels over the signalling socket, not over the DataChannel, so the lanes
/// can be open and healthy while the reveal never comes — the socket dropped
/// after the answer, or the peer's process was frozen by the OS, which is what
/// backgrounding a phone does. Once the lanes are open exactly one signalling
/// message is still owed, and 30 s is both enough for it and short enough that
/// a user is not left in front of a progress bar with no end.
public let LINK_KEY_REVEAL_TIMEOUT_SECONDS: TimeInterval = 30

/// How many remote candidates may count as progress.
///
/// The web's `MAX_CANDIDATE_PROGRESS`, and the whole reason the milestone set
/// below is closed. Candidates are the one input a peer — or anything rewriting
/// the signalling — can produce without limit, so treating each one as a fresh
/// extension would turn the no-progress deadline into a ticket a hostile peer
/// renews forever. A real exchange has single-digit candidates. Ones beyond
/// this are still added to the PeerConnection; they simply stop buying time.
public let LINK_MAX_CANDIDATE_PROGRESS = 6

/// Which deadline expired. Distinguished because they mean genuinely different
/// things to whatever reports them: `setup` is "this took too long overall",
/// `noProgress` is "the peer stopped answering", `keyReveal` is "the lanes are
/// up but the peer never disclosed its key".
public enum LinkTimeout: Equatable, Sendable {
    case setup
    case noProgress
    case keyReveal
}

/// The exact, finite set of events that may extend an establishment's patience.
///
/// Closed on purpose, and closed as a TYPE rather than by convention: the whole
/// hazard the no-progress deadline has to survive is a peer that produces an
/// unlimited stream of something and calls it progress. Each case here is
/// either produced at most once by the protocol itself (a peer sends one offer
/// or one answer; a lane opens once; a reveal verifies once — the layers above
/// enforce all three) or is explicitly counted, which is what
/// `LINK_MAX_CANDIDATE_PROGRESS` does for the one case that is peer-driven.
///
/// The consequence is a bound that can be stated twice over. The TYPE admits
/// five one-shot cases, because it has to describe both sides of a link:
/// `remoteOffer` and `remoteAnswer` are alternatives, not a pair. One real
/// establishment observes at most FOUR of them, because `linkRole` fixes the
/// role — a responder is offered to, an initiator is answered, never both. So
/// the type's bound is `5 + LINK_MAX_CANDIDATE_PROGRESS` re-arms and a running
/// establishment's is `4 + LINK_MAX_CANDIDATE_PROGRESS`, with the hard cap
/// bounding the total regardless.
public enum LinkMilestone: Hashable, Sendable {
    /// The peer's offer was applied. Only a responder ever sees this, once.
    case remoteOffer
    /// The peer's answer was applied. Only an initiator ever sees this, once.
    case remoteAnswer
    /// One remote candidate the PeerConnection actually accepted. The only
    /// counted case.
    case remoteCandidate
    /// One exact lane reached `open`.
    case laneOpened(LinkLane)
    /// The peer's reveal verified. Also retires the key-reveal deadline, which
    /// is the thing it was waiting for.
    case authenticated
}

/// The three deadlines, injectable so the decision logic can be tested at
/// millisecond scale instead of at ninety seconds.
public struct LinkDeadlines: Equatable, Sendable {
    public var setupHardCap: TimeInterval
    public var noProgress: TimeInterval
    public var keyReveal: TimeInterval
    public var maxCandidateProgress: Int

    public init(setupHardCap: TimeInterval = LINK_SETUP_HARD_CAP_SECONDS,
                noProgress: TimeInterval = LINK_NO_PROGRESS_TIMEOUT_SECONDS,
                keyReveal: TimeInterval = LINK_KEY_REVEAL_TIMEOUT_SECONDS,
                maxCandidateProgress: Int = LINK_MAX_CANDIDATE_PROGRESS) {
        self.setupHardCap = setupHardCap
        self.noProgress = noProgress
        self.keyReveal = keyReveal
        self.maxCandidateProgress = maxCandidateProgress
    }
}

/// When an unfinished `link/1` establishment must give up, and why.
///
/// ## Why it is a value type with no clock
///
/// Every question here — which deadline is next, whether one has passed, what
/// may extend which — is arithmetic over a set of milestones, and none of it
/// needs a timer, a queue or a PeerConnection. Handing it the current time on
/// every call is what makes "a candidate flood cannot outlast the hard cap" an
/// ordinary assertion rather than a ninety-second integration test that nobody
/// will run. `WebRTCLinkTransport` owns the one `DispatchWorkItem` that turns
/// `deadline` into an actual wake-up; this owns the decision.
///
/// ## The shape, and why it is three deadlines rather than one
///
///  - **The hard cap** starts with the establishment, is never re-armed by
///    anything, and bounds the total. It is what makes "always a verdict within
///    ninety seconds" true no matter what the peer does.
///  - **The no-progress deadline** re-arms, but only on `LinkMilestone` — see
///    that type for why the set is closed.
///  - **The key-reveal deadline** arms once both lanes are open while no
///    identity exists, because that is the exact state in which a connection is
///    healthy and still going nowhere.
///
/// The last two are consecutive, never concurrent: both lanes open ENDS the
/// transport phase, so the no-progress deadline is retired at the same instant
/// its replacement arms. An establishment therefore always has exactly one
/// inner deadline (or, once it is authenticated and waiting only to publish,
/// none) plus the cap. Two overlapping windows for the same wait would make the
/// reported reason an accident of which was configured shorter — see
/// `LINK_NO_PROGRESS_TIMEOUT_SECONDS` for what that cost in production.
///
/// `expiry` consults them outermost-first, so when two have passed the reported
/// reason is the outer one — the truthful answer to "why did this end" is the
/// bound that could not be extended, not the one that happened to be re-armed
/// most recently.
///
/// ## Expiry is final
///
/// Once a deadline has passed, `note` changes nothing and says so. The hazard
/// is ordinary scheduling rather than a hostile peer: the owner's wake-up is a
/// `DispatchWorkItem`, and one queued behind a long client callback or a
/// suspended device runs late, so an event can be served after the bound it was
/// racing has already gone. Letting that event re-arm would hand an
/// establishment that had already failed a fresh window.
public struct LinkEstablishmentWatchdog {

    /// What one `note` did.
    ///
    /// Three outcomes rather than a Bool, because the owner has to be able to
    /// tell "reschedule" from "do nothing" from "give up", and the last one is
    /// not a shade of the second: a milestone that arrives after a deadline has
    /// already passed is an establishment that must end, not one that has
    /// nothing to reschedule. Returning false for it would let the owner carry
    /// on driving an expired establishment.
    public enum Progress: Equatable, Sendable {
        /// A deadline moved. The owner must reschedule its one wake-up.
        case rearmed
        /// Nothing moved: a repeat, a candidate past its budget, a disarmed
        /// watchdog, or a milestone with no deadline left to extend.
        case unchanged
        /// A deadline had ALREADY passed when this arrived, and nothing was
        /// changed. Terminal — the owner must fail with this reason.
        case expired(LinkTimeout)
    }

    private let deadlines: LinkDeadlines
    /// Absolute, and `let`: nothing in this type can move it.
    private let hardCapAt: TimeInterval
    /// Optional because the transport phase ENDS: nil once both lanes are open,
    /// and never re-armed after that.
    private var noProgressAt: TimeInterval?
    private var keyRevealAt: TimeInterval?
    private var seen: Set<LinkMilestone> = []
    private var candidateProgress = 0
    private var identityPresent = false
    private var disarmed = false

    /// - Parameter identityPresent: whether this establishment ALREADY has its
    ///   identity, which is true for exactly one thing: an authenticated
    ///   transport replacement, whose keys, SAS and codecs existed before its
    ///   `RTCPeerConnection` did.
    ///
    ///   It suppresses the key-reveal window outright rather than merely making
    ///   it unlikely. That window describes one specific wait — "the lanes are
    ///   up and healthy but the peer has not disclosed its key" — and a rebuild
    ///   is never in it: there is no reveal owed in either direction. Arming it
    ///   would put a rebuild on a deadline for a message nobody is going to
    ///   send, and would report `.keyReveal` as the reason a link ended when
    ///   nothing was ever waiting on a reveal. `.authenticated` is seeded into
    ///   `seen` for the same reason, so a milestone that somehow arrived anyway
    ///   is the repeat it actually is and buys no extension.
    public init(start: TimeInterval,
                deadlines: LinkDeadlines = LinkDeadlines(),
                identityPresent: Bool = false) {
        self.deadlines = deadlines
        self.hardCapAt = start + deadlines.setupHardCap
        self.noProgressAt = start + deadlines.noProgress
        self.identityPresent = identityPresent
        if identityPresent { seen.insert(.authenticated) }
    }

    public var isArmed: Bool { !disarmed }

    /// The earliest armed deadline, or nil once disarmed. This is what the owner
    /// schedules a wake-up for; it must reschedule whenever `note` reports
    /// `.rearmed`.
    public var deadline: TimeInterval? {
        guard !disarmed else { return nil }
        var next = hardCapAt
        if let noProgressAt { next = min(next, noProgressAt) }
        if let keyRevealAt { next = min(next, keyRevealAt) }
        return next
    }

    /// Which deadline has passed at `now`, if any. Nil is the answer a wake-up
    /// that fired early — or that was overtaken by a re-arm — must get.
    public func expiry(at now: TimeInterval) -> LinkTimeout? {
        guard !disarmed else { return nil }
        if now >= hardCapAt { return .setup }
        if let noProgressAt, now >= noProgressAt { return .noProgress }
        if let keyRevealAt, now >= keyRevealAt { return .keyReveal }
        return nil
    }

    /// Record one milestone.
    ///
    /// Reports `.rearmed` only when this actually changed a deadline, so the
    /// owner reschedules its single wake-up exactly when there is something to
    /// reschedule — and so a repeated or over-budget milestone costs nothing.
    @discardableResult
    public mutating func note(_ milestone: LinkMilestone, at now: TimeInterval) -> Progress {
        guard !disarmed else { return .unchanged }
        // Before anything is recorded, and deliberately not after: an event
        // served late is not progress, it is the proof that this establishment
        // has already lost. Nothing below runs for it, so no deadline moves and
        // no reveal window is armed on the way out.
        if let passed = expiry(at: now) { return .expired(passed) }
        switch milestone {
        case .remoteCandidate:
            // Counted, not remembered: every accepted candidate is genuinely a
            // distinct event, so the only thing that can bound them is a budget.
            guard candidateProgress < deadlines.maxCandidateProgress else { return .unchanged }
            candidateProgress += 1
        default:
            // Identity IS the key, so nothing a peer can repeat — the same lane
            // reported open twice, a re-offer — buys a second extension.
            guard seen.insert(milestone).inserted else { return .unchanged }
        }
        var moved = false
        if milestone == .authenticated {
            identityPresent = true
            // The reveal arrived: there is nothing left for that window to
            // protect, whichever order it and the lanes came in.
            if keyRevealAt != nil {
                keyRevealAt = nil
                moved = true
            }
        }
        if lanesOpen {
            // Both lanes open ends the transport phase. What is still owed
            // travels over the signalling socket, not over the DataChannel, so
            // the deadline that describes the wait is the reveal window — and
            // it replaces the no-progress one rather than racing it.
            if noProgressAt != nil {
                noProgressAt = nil
                moved = true
            }
            if !identityPresent, keyRevealAt == nil {
                keyRevealAt = now + deadlines.keyReveal
                moved = true
            }
        } else {
            // The no-progress deadline, and ONLY it. Pushing it past the hard
            // cap is harmless: `deadline` takes the minimum and `expiry` checks
            // the cap first, so the cap still bounds the total.
            noProgressAt = now + deadlines.noProgress
            moved = true
        }
        // A milestone with nothing left to move — a candidate arriving after
        // both lanes are open and the reveal window is already running — is
        // genuine, and still buys no time and no wake-up.
        return moved ? .rearmed : .unchanged
    }

    /// Both exact lanes reported open. The end of the transport phase.
    private var lanesOpen: Bool {
        seen.contains(.laneOpened(.file)) && seen.contains(.laneOpened(.text))
    }

    /// Publication, failure or teardown: nothing here applies any more.
    /// Idempotent, and permanent — a disarmed watchdog never re-arms, so a
    /// wake-up already in flight cannot resurrect one.
    public mutating func disarm() {
        disarmed = true
        noProgressAt = nil
        keyRevealAt = nil
    }
}
