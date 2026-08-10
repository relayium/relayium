import Foundation

/// Which of the three panes a transfer destination draws.
public enum TransferSurfacePane: String, Equatable, Sendable {
    /// The connection method and the staged batch — before there is a peer.
    case connect
    /// The shipped legacy wire's session: one lane, one exit.
    case legacySession
    /// A real `link/1`: one connection carrying messages and files at once.
    case link
}

/// The rules a macOS transfer destination follows about a session it may or may
/// not own — as pure functions, so both destinations obey one copy of them and
/// `swift test` can drive the answers rather than a UI test having to.
///
/// **Why this exists at all.** macOS has two transfer destinations again — LAN
/// Transfer and Cross-network Transfer — and they share every model underneath:
/// one `RealtimeSessionModel`, one `RealtimeTextSessionModel`, one
/// `LinkWorkspaceModel`, arbitrated by one `TransferPresence`. Two screens over
/// one set of models is exactly the shape that produces the two failures this
/// type refuses by construction:
///
///  1. **One session rendered twice.** If both destinations drew whatever the
///     models happened to hold, a transfer started from a pairing code would
///     appear on the LAN screen too — one transfer with two Cancel buttons.
///     `pane(...)` therefore keys on the OWNER, not on model state: a session is
///     visible on its owning route and nowhere else.
///  2. **A second session started over the first.** Switching to the other
///     transfer destination shows connect controls, and those controls must
///     refuse while anything is live or retained anywhere — including a
///     `.completed` receive that is holding its result, and including the
///     synchronous window after a claim in which no model has published busy
///     state yet. `acceptsNewSession(...)` is that refusal.
public enum TransferSurfacePresentation {

    /// What `route`'s destination draws.
    ///
    /// Ownership alone decides, and deliberately so. `linkHasSession` only picks
    /// WHICH session pane the owner draws — the unified link pane for a peer
    /// that announced exact `link/1`, the legacy pane for everything else — and
    /// can never put a session on a route that does not own it.
    ///
    /// A claim with no model state yet still returns `.legacySession`: ownership
    /// is taken synchronously before either model can publish, and the pane
    /// draws nothing for `.idle`. Returning `.connect` in that window would show
    /// a Create button over a session that is starting.
    public static func pane(route: AppDestination,
                            owner: AppDestination?,
                            linkHasSession: Bool) -> TransferSurfacePane {
        guard owner == route else { return .connect }
        return linkHasSession ? .link : .legacySession
    }

    /// Whether `route`'s connect controls may start something.
    ///
    /// `sessionIsLiveOrRetained` is the models' own answer — any non-idle legacy
    /// state, or a link that still holds a session — and it is asked in addition
    /// to ownership rather than instead of it, because the two go stale in
    /// opposite directions: ownership exists before any model publishes, and a
    /// retained terminal state can outlive a release the user has not yet made.
    ///
    /// Note what this does NOT do: it never asks whether the owner is *this*
    /// route. A destination that owns the session is drawing that session, not
    /// its connect controls, and a rule that let the owner start a second one
    /// would be the same bug from the other side.
    public static func acceptsNewSession(owner: AppDestination?,
                                         sessionIsLiveOrRetained: Bool) -> Bool {
        owner == nil && !sessionIsLiveOrRetained
    }
}
