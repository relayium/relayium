import Combine
import Foundation

/// What a direct session carries. A *mode within* the two direct destinations,
/// deliberately not a sixth destination: neither a pairing code nor a roster
/// entry encodes whether the user means files or text, so the app must ask —
/// but asking twice, once per destination, would be two answers to one question.
public enum TransferMode: Equatable, CaseIterable, Sendable {
    case files, text
}

/// Which destination presents the live session.
///
/// It answers exactly one question — **which of the two direct destinations
/// renders the running session inside the unique window** — and it is worth
/// stating that narrowly, because it is easy to over-claim for. It is *not*, and
/// cannot be, a defence against a second window rendering the same models twice:
/// that is what the main scene being a unique `Window` rather than a
/// `WindowGroup` achieves.
///
/// Nearby and Pairing code drive the SAME `RealtimeSessionModel` and
/// `RealtimeTextSessionModel`. Rendered side by side they would show one session
/// twice, each copy with its own Cancel. The models already refuse to start a
/// second session; this only stops the *rendering* from forking. That is why a
/// refused claim is not an error anybody has to handle — it means "somebody else
/// is already showing it", and the caller's answer is to say so and offer to go
/// there.
///
/// App-scoped, like the models it speaks for: the unique window is closable
/// while the process keeps running, so ownership has to survive the view tree
/// being torn down and rebuilt.
///
/// R3-F gave iOS the same two-surface shape — a Nearby tab beside the Direct
/// one — so this arbitrates there too. What differs is only the mode: iOS holds
/// files-or-text in `DirectModeSelection`, where its own lock lives, and claims
/// through the `claim(_:)` overload below so no second copy of that answer
/// exists. `mode` is macOS's.
@MainActor
public final class TransferPresence: ObservableObject {
    /// `nil` when no destination is presenting a session. Private setter: the
    /// only ways in are `claim`, `release` and `releaseAll`, so "a non-owner
    /// cannot clear the session" is enforced rather than agreed.
    @Published public private(set) var owner: AppDestination?

    /// Files or text. User changes go through `selectMode`, while a claim sets
    /// it when a session decides its own kind — an unsolicited incoming one,
    /// which nobody chose a mode for.
    @Published public private(set) var mode: TransferMode

    public init(mode: TransferMode = .files) {
        self.mode = mode
    }

    /// Change the user's Files/Text choice only while no session owns either
    /// direct surface. Ownership is taken synchronously before either model can
    /// publish a non-idle state, so model busy flags alone leave a short window
    /// in which a picker could hide the session that is about to appear.
    public func selectMode(_ mode: TransferMode) {
        guard owner == nil else { return }
        self.mode = mode
    }

    /// Ownership boundaries for coordinators that must not prepare a second
    /// session in the synchronous claim-before-model-start window.
    var ownershipChanges: AnyPublisher<Bool, Never> {
        $owner.map { $0 != nil }.removeDuplicates().eraseToAnyPublisher()
    }

    /// Take, or keep, the right to present the session.
    ///
    /// Idempotent for the owner and refused for anyone else. The refusal leaves
    /// `owner` and `mode` exactly as they were: a second destination must not be
    /// able to repoint a running session's mode out from under the surface that
    /// is drawing it.
    @discardableResult
    public func claim(_ destination: AppDestination, mode: TransferMode) -> Bool {
        guard claim(destination) else { return false }
        self.mode = mode
        return true
    }

    /// Take, or keep, the right to present the session — and answer nothing
    /// else.
    ///
    /// The same arbitration as above, minus the mode. iOS keeps the
    /// files-or-text answer in `DirectModeSelection`, which is where its R3-E
    /// lock lives; writing a second copy of that answer here would be two
    /// values free to disagree, and the disagreement shows up as the owning tab
    /// rendering the wrong half of a session it does own. macOS has no such
    /// second holder, so it keeps using the overload above.
    ///
    /// Refusal still changes nothing at all, which is the part that has to hold
    /// on both: a losing claim that had already moved something would be a
    /// half-applied claim.
    @discardableResult
    public func claim(_ destination: AppDestination) -> Bool {
        guard owner == nil || owner == destination else { return false }
        owner = destination
        return true
    }

    /// Only the owner can let go. A release from anywhere else is ignored rather
    /// than trusted, so a destination returning to idle cannot blank the surface
    /// that is presenting somebody else's live session.
    public func release(_ destination: AppDestination) {
        guard owner == destination else { return }
        owner = nil
    }

    /// Unconditional. For the paths that end every session at once — the quit
    /// guard's cancel, a teardown — where there is no destination to ask.
    public func releaseAll() {
        owner = nil
    }

    /// True for exactly one destination while a session is owned, and for none
    /// when it is not.
    public func rendersSession(_ destination: AppDestination) -> Bool {
        owner == destination
    }

    /// Whether `destination`'s row should be marked as carrying a transfer that
    /// is actually running.
    ///
    /// Two different questions meet here, and conflating them is what made the
    /// sidebar lie. *Which surface draws the session* is this object's business
    /// and outlives the transfer — a `.completed` receive keeps its result view,
    /// its Reveal in Finder and its drag-out promise, so ownership must not be
    /// given up when bytes stop moving. *Whether bytes are moving* belongs to
    /// `RealtimeSessionModel.isBusy` / `RealtimeTextSessionModel.isBusy`, which
    /// already track it exactly.
    ///
    /// So the activity fact arrives as a parameter and is never stored. A cached
    /// copy here would be a second answer to a question the models already
    /// answer, free to drift out of step with them — and the drift would show up
    /// as `nav.a11yLiveSession`, "A transfer is running here", read out over a
    /// transfer that finished.
    public func announcesRunningTransfer(_ destination: AppDestination,
                                         sessionIsBusy: Bool) -> Bool {
        rendersSession(destination) && sessionIsBusy
    }
}
