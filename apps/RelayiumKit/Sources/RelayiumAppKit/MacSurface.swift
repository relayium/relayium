import Foundation

/// What the macOS window actually renders — one case per screen the shell can
/// draw, and one list saying which of them the user may browse to.
///
/// `AppDestination` is the ROUTING vocabulary both platforms share and is
/// deliberately left alone here: iOS renders its own tabs from it, and changing
/// the enum to suit one platform's shell would be a redesign of the other's.
/// What macOS needs is a second, narrower answer — *which screen draws this
/// destination, and is that screen something the sidebar offers* — and those two
/// questions are what this type exists for.
///
/// ## The two transfer screens are two destinations again
///
/// They were briefly one row called Workspace, on the argument that a pairing
/// code and same-network discovery are "two ways to reach one peer, not two
/// products". The owner's answer is that they are two products to the person
/// using them: one requires being on the same network and the other explicitly
/// does not, which is the first thing somebody needs to know and the one thing a
/// merged row could not say without a paragraph. So `lanTransfer` and
/// `crossNetworkTransfer` are two rows, two screens, and one connection method
/// each — while `TransferPresence` still arbitrates a single live session
/// between the routes underneath them, exactly as before.
///
/// `String`-backed and `CaseIterable` for the same reasons `AppDestination` is:
/// a stable, loggable name that UI automation can address, and one list the
/// sidebar and the shell both enumerate rather than two that can drift.
public enum MacSurface: String, CaseIterable, Hashable, Sendable {
    /// Same-network discovery and direct transfer. No account, no code.
    case lanTransfer
    /// Pairing code. The devices do **not need** to share a network.
    case crossNetworkTransfer
    case storedSend
    /// Opening a stored link somebody sent. **Not browseable** — see
    /// `browseable` below.
    case storedReceive
    case deviceInbox
    case account

    /// The five rows the sidebar lists, in the order it lists them.
    ///
    /// **`storedReceive` is deliberately absent, and its absence is a product
    /// decision rather than an oversight.** Opening a stored link is something
    /// the OS hands this app — a `relayium.com` download link the user followed
    /// somewhere else — not somewhere a person sets out to go. It kept a sidebar
    /// row that answered "what do I do here?" with "paste a link you already
    /// have", and every route that actually delivers one (`AppDeepLink`,
    /// `AccountView`'s stored-file rows) selects `.storedReceive` directly and
    /// still renders it. So the screen stays reachable and stops being browseable.
    ///
    /// Written as the ordered list the sidebar renders rather than as a
    /// predicate over `allCases`, so "which rows, in which order" is one
    /// statement in one place. `isBrowseable` is derived from it, never the
    /// other way round.
    public static let browseable: [MacSurface] = [
        .lanTransfer, .crossNetworkTransfer, .storedSend, .deviceInbox, .account,
    ]

    /// Whether the sidebar offers this surface at all.
    public var isBrowseable: Bool { Self.browseable.contains(self) }

    /// The SF Symbol that stands for this surface, named ONCE.
    ///
    /// The sidebar row and the destination's own header draw the same glyph, and
    /// they draw it from here rather than each holding a literal: a row and the
    /// screen it opens marked with two different symbols is a screen that does
    /// not look like the thing the user clicked. Nonlocalized by nature — these
    /// are system symbol names, not copy.
    ///
    /// `storedReceive` has no sidebar row and still has a symbol, because
    /// arriving from a link is still arriving somewhere that should say what it
    /// is.
    // nonlocalized: SF Symbol names
    public var symbol: String {
        switch self {
        case .lanTransfer:          return "dot.radiowaves.left.and.right"
        case .crossNetworkTransfer: return "number.circle"
        case .storedSend:           return "link.badge.plus"
        case .storedReceive:        return "arrow.down.circle"
        case .deviceInbox:          return "tray.and.arrow.down"
        case .account:              return "person.crop.circle"
        }
    }

    /// The destination a click on this row selects.
    ///
    /// One route each now: the two transfer surfaces no longer share a canonical
    /// route, because they no longer share a screen. A pairing-code deep link
    /// still selects `.pairingCode` and arrives at `crossNetworkTransfer`; an
    /// unsolicited same-network session still selects `.nearby` and arrives at
    /// `lanTransfer`.
    public var route: AppDestination {
        switch self {
        case .lanTransfer:          return .nearby
        case .crossNetworkTransfer: return .pairingCode
        case .storedSend:           return .storedSend
        case .storedReceive:        return .storedReceive
        case .deviceInbox:          return .deviceInbox
        case .account:              return .account
        }
    }
}

public extension AppDestination {
    /// The two routes that share one transfer staging context on macOS.
    ///
    /// They remain separate screens and connection methods. The set exists only
    /// for OS-opened file batches: a batch dragged to the Dock must remain
    /// available if the user changes from LAN to pairing code before adopting
    /// it, just as the app-scoped `SelectionStore` does after adoption.
    static let macTransferRoutes: Set<AppDestination> = [.nearby, .pairingCode]

    /// Which macOS surface draws this destination.
    ///
    /// **No `default`**, exactly as `AppRouting`'s switches have none: a seventh
    /// destination has to state which macOS screen renders it rather than
    /// inheriting an answer, and the compiler is what asks.
    var macSurface: MacSurface {
        switch self {
        case .nearby:        return .lanTransfer
        case .pairingCode:   return .crossNetworkTransfer
        case .storedSend:    return .storedSend
        case .storedReceive: return .storedReceive
        case .deviceInbox:   return .deviceInbox
        case .account:       return .account
        }
    }
}
