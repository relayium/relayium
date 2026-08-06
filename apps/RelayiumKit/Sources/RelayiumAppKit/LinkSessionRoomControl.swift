import Foundation
import RelayiumKit

// MARK: - the room's seam onto one link

/// The three things a ROOM owner tells one live `link/1`, as
/// `LinkSessionRuntime` already answers them.
///
/// Exactly that runtime's existing public shape for those three verbs, and that
/// is the point: this seam exists so a room owner's forwarding can be exercised
/// without two negotiating endpoints, not so a second dialect can grow beside
/// the runtime.
///
/// ## Why these three, and only these three
///
/// `LinkSessionCommands` is the SCREEN's vocabulary — open a conversation, send
/// a message, queue a batch — and it deliberately excludes every verb below.
/// Its header says so, and permanently: an inbound resume offer, a peer that
/// left the roster and intent raised mid-gap are signalling and room facts, and
/// routing them through a presentation object would put admission policy in the
/// layer that must not have any.
///
/// But they still have to be REACHABLE by something. `LinkSessionRuntime` is
/// held privately by `LinkSessionAttempt`, so before this seam existed the three
/// verbs had exactly one caller — nobody — and the room coordinator that is
/// supposed to make them was unimplementable without either widening the command
/// seam or handing a second owner the runtime. This is the third option: a
/// handle that reaches those three and nothing else.
///
/// ## What is deliberately NOT here
///
/// `start`, `stop` and every lane command. Lifetime belongs to
/// `LinkSessionAttempt` — one attempt, one owner, one retirement — and a second
/// object able to stop the runtime would be a second thing able to end, or to
/// fail to end, one link.
protocol LinkSessionRecoveryControl: AnyObject {
    /// Hand the link a `link/1` signal the room routed first — the candidates and
    /// the answer that chase an offer the room consumed.
    ///
    /// Taken before publication AND after it: ICE is trickled, so a peer
    /// legitimately keeps sending candidates once the lanes are open, and the
    /// transport running the link is the right thing to hand them to. Inert only
    /// before the link starts and after it has ended — see
    /// `LinkSessionRuntime.receive`.
    func receive(from: String, signal: JSONValue)
    /// Hand the link an inbound `resume` offer. Verified inside, against this
    /// link's own resume key, and dropped in silence if it does not pass.
    func receiveResumeOffer(from: String, signal: JSONValue)
    /// The peer left the room, or announced an authenticated departure. Ignored
    /// unless it is the peer this link belongs to.
    func peerDeparted(_ peerId: String)
    /// Hand the link an authenticated departure. `to` is the room envelope's
    /// local recipient id and must be forwarded unchanged.
    func receiveLeave(from: String, to: String, auth: String)
    /// Join the one recovery outcome for this link, so intent raised mid-gap
    /// lands on the rebuilt link rather than on the transport that is gone.
    @discardableResult
    func joinRecovery(peerId: String,
                      _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin
}

extension LinkSessionRuntime: LinkSessionRecoveryControl {}

/// A room owner's handle on ONE assembled link's three recovery verbs.
///
/// ## What it is for
///
/// `LinkSessionFactory` answers with an attempt, and an attempt is a screen's
/// worth of a link: it forwards commands and it retires. A room owner needs one
/// more thing from the same assembly — to route a signal that belongs to the
/// link rather than to the conversation — and it must get it without becoming a
/// second owner of the session. This is that, and it is deliberately nothing
/// else.
///
/// ## The invariants it exists to make structural
///
/// **1. It cannot extend a session's life.** The runtime is held WEAKLY. The
/// attempt is the only strong owner, so an assembly whose attempt has been
/// released is over even if a coordinator is still holding this handle — and a
/// coordinator that forgets to drop one leaks a control object, never a live
/// link, a PeerConnection or a TURN allocation.
///
/// **2. A dead handle is inert, not an error.** Every verb below is a no-op once
/// the runtime is gone, and `joinRecovery` answers `.unavailable` — which is the
/// same answer that runtime gives for a link that has not published yet or has
/// no gap to join. A room owner therefore has one behaviour to reason about
/// rather than two, and a late signal arriving for a retired attempt cannot be
/// told apart from one arriving a moment after the link ended, because those are
/// the same thing.
///
/// **3. It decides nothing.** No verification, no answer, no admission call, no
/// peer comparison, no timer. Every one of those already lives in the layer that
/// owns it: `LinkRecoveryCoordinator` verifies the tag before it allocates
/// anything, ignores a departure that is not its peer's, and owns the window. A
/// copy here would be a second policy that can silently diverge from the
/// authoritative one.
///
/// ## What it is not
///
/// Unreachable from production, exactly as everything else below this line is:
/// it is INTERNAL to `RelayiumAppKit`, only `LinkSessionFactory` constructs one,
/// `LINK_BUILD_SUPPORT` and `LINK_TRANSPORT_REPLACEMENT_SUPPORTED` are both still
/// false, and no view, app target or `AppEnvironment` names it. It is the seam a
/// room coordinator will need; it is not that coordinator, and it routes nothing
/// on its own.
@MainActor
final class LinkSessionRoomControl {

    /// The link, for as long as its attempt holds it — see invariant 1.
    ///
    /// Main-actor isolated rather than merely `weak`: a weak reference read from
    /// two threads is a data race whatever it points at, and the room owner that
    /// will use this is a main-actor object already.
    private weak var runtime: (any LinkSessionRecoveryControl)?

    /// - Parameter runtime: the link this handle reaches, held weakly.
    ///
    ///   Optional because a handle that holds nothing is this type's ordinary
    ///   terminal state — see invariant 2 — so `nil` needs no separate meaning
    ///   and no separate behaviour. `LinkSessionFactory` never passes one:
    ///   `LinkSessionAttempt` calls its builder exactly once and synchronously,
    ///   so the runtime exists by the time the assembly is made.
    init(runtime: (any LinkSessionRecoveryControl)?) {
        self.runtime = runtime
    }

    /// Whether the link this handle was made for still exists.
    ///
    /// Instrumentation for an owner deciding whether to keep routing to it, and
    /// deliberately not a guard any verb below reads: between this answer and
    /// the call that follows it the attempt may have been retired, so every verb
    /// resolves the reference itself.
    var isLive: Bool { runtime != nil }

    /// Hand the link a signal the room routed first.
    func receive(from: String, signal: JSONValue) {
        runtime?.receive(from: from, signal: signal)
    }

    /// Hand the link an inbound `resume` offer.
    func receiveResumeOffer(from: String, signal: JSONValue) {
        runtime?.receiveResumeOffer(from: from, signal: signal)
    }

    /// Hand the link an authenticated departure. `to` is the room envelope's
    /// local recipient id and is forwarded unchanged.
    func receiveLeave(from: String, to: String, auth: String) {
        runtime?.receiveLeave(from: from, to: to, auth: auth)
    }

    /// The peer left the room, or announced an authenticated departure.
    func peerDeparted(_ peerId: String) {
        runtime?.peerDeparted(peerId)
    }

    /// Join the one recovery outcome for this link.
    ///
    /// `.unavailable` for a link that is gone, which is the runtime's own answer
    /// for a link that has no gap to join — see invariant 2.
    @discardableResult
    func joinRecovery(peerId: String,
                      _ complete: @escaping (Result<LinkIdentity, Error>) -> Void)
    -> LinkRecoveryJoin {
        guard let runtime else { return .unavailable }
        return runtime.joinRecovery(peerId: peerId, complete)
    }
}

/// ONE assembled `link/1`, as `LinkSessionFactory` hands it over: the screen's
/// owner and the room's handle on the same link.
///
/// They are two objects rather than one because they have two lifetimes and two
/// vocabularies. `attempt` is the sole strong owner — retiring it ends the link
/// — and `control` is a weak handle that cannot keep anything alive. Returning
/// them together is what stops a caller from assembling a link and then having
/// to find its recovery seam somewhere else, which is the shape that would
/// invite a second owner.
@MainActor
struct LinkSessionAssembly {
    /// The one owner of this link's runtime, bridge and both projections.
    let attempt: LinkSessionAttempt
    /// The room's seam onto the same link. Holds it weakly — see
    /// `LinkSessionRoomControl`.
    let control: LinkSessionRoomControl
}
