import Foundation

/// What the macOS window actually renders — one case per sidebar row.
///
/// `AppDestination` is the ROUTING vocabulary both platforms share, and it is
/// deliberately left alone here: iOS renders `.nearby` and `.pairingCode` as two
/// separate tabs, and changing the enum to suit one platform's shell would be a
/// redesign of the other's. What macOS needed instead is a second, narrower
/// answer — *which screen draws this destination* — and on macOS the two direct
/// routes draw the same screen.
///
/// So this type exists for exactly one reason: **`nearby` and `pairingCode` are
/// two ways to reach one peer, not two products.** They always drove the same
/// `RealtimeSessionModel` and `RealtimeTextSessionModel`, took turns owning the
/// one `TransferPresence`, and each spent half its screen explaining that the
/// session was somewhere else. Collapsing them at the *surface* layer removes
/// that explanation entirely without touching a routing decision, a deep link,
/// an incoming-session claim or the iOS tab bar.
///
/// `String`-backed and `CaseIterable` for the same reasons `AppDestination` is:
/// a stable, loggable name that UI automation can address, and one list the
/// sidebar and the shell both enumerate rather than two that can drift.
public enum MacSurface: String, CaseIterable, Hashable, Sendable {
    /// Same-network discovery and pairing-code create/join, in one place, with
    /// one live session between them.
    case workspace
    case storedSend
    case storedReceive
    case deviceInbox
    case account

    /// The destination a click on this row selects.
    ///
    /// The Workspace's canonical route is `.nearby`, and that is not arbitrary:
    /// it is the one route that needs no account and no code, so a selection
    /// made by the sidebar, by a Dock drop or by a fresh launch lands on the
    /// half of the surface that always works. A pairing-code deep link still
    /// selects `.pairingCode` and still arrives here — see `macSurface` — so
    /// nothing about link routing depends on this choice.
    public var route: AppDestination {
        switch self {
        case .workspace:      return .nearby
        case .storedSend:     return .storedSend
        case .storedReceive:  return .storedReceive
        case .deviceInbox:    return .deviceInbox
        case .account:        return .account
        }
    }
}

public extension AppDestination {
    /// Which macOS surface draws this destination.
    ///
    /// **No `default`**, exactly as `AppRouting`'s switches have none: a seventh
    /// destination has to state which macOS screen renders it rather than
    /// inheriting an answer, and the compiler is what asks.
    var macSurface: MacSurface {
        switch self {
        case .nearby, .pairingCode: return .workspace
        case .storedSend:           return .storedSend
        case .storedReceive:        return .storedReceive
        case .deviceInbox:          return .deviceInbox
        case .account:              return .account
        }
    }

    /// The two routes that macOS renders as one Workspace.
    ///
    /// Kept as a named set rather than open-coded at each call site so "is this
    /// the Workspace's session" is one predicate. `TransferPresence` still owns
    /// exactly one of the two at a time — that arbitration is unchanged and
    /// still load-bearing for iOS — and on macOS the Workspace draws the session
    /// whichever of them holds it.
    static let macWorkspaceRoutes: Set<AppDestination> = [.nearby, .pairingCode]
}
