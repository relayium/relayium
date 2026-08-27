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
    private var sessionObservation: AnyCancellable?
    /// `nil` when no destination is presenting a session. Private setter: the
    /// only ways in are `claim`, `release` and `releaseAll`, so "a non-owner
    /// cannot clear the session" is enforced rather than agreed.
    @Published public private(set) var owner: AppDestination?

    /// The safe, peer-supplied label snapshotted when a Nearby session is
    /// admitted. It is presentation context, never identity or a routing key.
    /// Keeping it here gives the live and terminal session the same lifetime as
    /// the surface that replaced the roster where the label was first shown.
    @Published public private(set) var sessionPeerLabel: String?

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

    /// Keep ownership for every live and retained terminal state, then release
    /// it on the one authoritative transition back to both models being idle.
    /// This observer is app-scoped: a window or tab may disappear while the
    /// session ends, and a replacement view must not infer lifecycle from its
    /// initial idle render.
    public func observeSessions(fileModel: RealtimeSessionModel,
                                textModel: RealtimeTextSessionModel) {
        observeSessionLiveness(Publishers.CombineLatest(fileModel.$state, textModel.$state)
            .map { file, text in file != .idle || text != .idle }
            .eraseToAnyPublisher())
    }

    /// The ONE liveness subscription, whichever overload above supplied it.
    /// Shared rather than duplicated per platform, so "exactly one thing
    /// releases the surface" is structural.
    func observeSessionLiveness(_ liveness: AnyPublisher<Bool, Never>) {
        sessionObservation = liveness
            .removeDuplicates()
            .sink { [weak self] hasLiveSession in
                if !hasLiveSession { self?.releaseAll() }
            }
    }

    // The link-aware overload used to be `#if os(macOS)`, because iOS composed
    // no link and a third liveness source for a product it did not build would
    // have been a claim it could not honour. iOS composes one now, so the
    // overload is shared — and it MUST be, for the reason the body records: a
    // link uses neither legacy model, so an iOS link observed by the two-model
    // overload would have its surface released the instant it started.

    /// The same observation with the unified link included.
    ///
    /// A THIRD publisher rather than a separate observer, and that is the whole
    /// point: this object keeps exactly one liveness subscription, and a second
    /// one would let a link's claim be released the instant both legacy models
    /// reported idle — which they always are while a link is running, because a
    /// link uses neither of them.
    ///
    /// `hasSession` rather than "is open": a link that ended keeps its
    /// transcript, its committed batches and its terminal reason on screen, so
    /// ownership must survive the transport exactly as a `.completed` legacy
    /// receive's does. `dismiss()` is what gives it up.
    public func observeSessions(fileModel: RealtimeSessionModel,
                                textModel: RealtimeTextSessionModel,
                                link: LinkWorkspaceModel) {
        let legacy = Publishers.CombineLatest(fileModel.$state, textModel.$state)
        observeSessionLiveness(Publishers.CombineLatest(legacy, link.$connection)
            // `TransferModule.retainsWork`, and not a second spelling of it.
            // This observer was already correct while the pairing surface
            // released ownership from a single lane, so the two answers
            // disagreed exactly where it mattered: a creator whose legacy code
            // model was retired by the `link/1` handoff. One rule, asked from
            // both places.
            .map { legacy, connection in
                TransferModule.retainsWork(files: legacy.0, text: legacy.1,
                                           link: connection)
            }
            .eraseToAnyPublisher())
    }

    /// **The macOS composition's liveness: one `link/1`, and the code that is
    /// waiting for a peer to bring one.**
    ///
    /// A THIRD overload rather than a nil-legacy variant of the two above,
    /// because those two are the paused iOS implementation's and must keep
    /// answering exactly what they answer today. This one is added, not
    /// substituted: neither existing overload changes, and nothing iOS
    /// subscribes to is reachable from here.
    ///
    /// It still installs the ONE subscription `observeSessionLiveness` owns, so
    /// "exactly one thing releases the surface" survives the macOS contraction
    /// unchanged — a second observer would let a link's claim be dropped by
    /// whichever publisher reported idle first.
    ///
    /// **The code is a liveness source and the link is not enough on its own.**
    /// A creator sits with six digits on screen while `connection` is
    /// `.watching` — work this module holds with nothing drawn for it — and,
    /// before the room is even joined, in `.minting` while `connection` is still
    /// `.idle`. A link-only publisher would report idle through both and release
    /// the surface under a code the user is reading out loud. That is the same
    /// rule `TransferModule.retainsWork(code:link:)` states for every
    /// surface-local release, asked here from the one app-scoped place, so the
    /// observer and the views cannot disagree — which is exactly how they
    /// disagreed before the rule was written down once.
    public func observeSessions(code: PairingCodeModel, link: LinkWorkspaceModel) {
        observeSessionLiveness(Publishers.CombineLatest(code.$state, link.$connection)
            .map { TransferModule.retainsWork(code: $0, link: $1) }
            .eraseToAnyPublisher())
    }

    /// Take, or keep, the right to present the session.
    ///
    /// Idempotent for the owner and refused for anyone else. The refusal leaves
    /// `owner` and `mode` exactly as they were: a second destination must not be
    /// able to repoint a running session's mode out from under the surface that
    /// is drawing it.
    @discardableResult
    public func claim(_ destination: AppDestination,
                      mode: TransferMode,
                      peerLabel: String? = nil) -> Bool {
        guard claim(destination, peerLabel: peerLabel) else { return false }
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
    public func claim(_ destination: AppDestination, peerLabel: String? = nil) -> Bool {
        guard owner == nil || owner == destination else { return false }
        if owner == nil {
            // Set context before publishing ownership: a view that switches to
            // its session surface on the owner edge must never render the first
            // frame without the peer this claim already knows about.
            sessionPeerLabel = peerLabel
            owner = destination
        } else if peerLabel != nil {
            sessionPeerLabel = peerLabel
        }
        return true
    }

    /// Take ownership for a brand-new session.
    ///
    /// Unlike `claim`, this is deliberately not idempotent. SwiftUI can deliver
    /// a second activation before the first action's asynchronous model start
    /// publishes busy state. Reusing the reconstruction claim there would let
    /// two creates, joins or connections enter the same shared model.
    @discardableResult
    public func beginSession(_ destination: AppDestination,
                             mode: TransferMode,
                             peerLabel: String? = nil) -> Bool {
        guard owner == nil else { return false }
        return claim(destination, mode: mode, peerLabel: peerLabel)
    }

    /// The same new-session boundary for iOS, where mode has one separate
    /// authority in `DirectModeSelection`.
    @discardableResult
    public func beginSession(_ destination: AppDestination,
                             peerLabel: String? = nil) -> Bool {
        guard owner == nil else { return false }
        return claim(destination, peerLabel: peerLabel)
    }

    /// Only the owner can let go. A release from anywhere else is ignored rather
    /// than trusted, so a destination returning to idle cannot blank the surface
    /// that is presenting somebody else's live session.
    public func release(_ destination: AppDestination) {
        guard owner == destination else { return }
        owner = nil
        sessionPeerLabel = nil
    }

    /// Unconditional. For the paths that end every session at once — the quit
    /// guard's cancel, a teardown — where there is no destination to ask.
    public func releaseAll() {
        owner = nil
        sessionPeerLabel = nil
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
