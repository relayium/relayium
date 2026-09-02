import Combine
import Foundation

/// What the iOS app actually renders — one case per screen the shell can draw,
/// and one list saying which of them the user may browse to.
///
/// This is the iOS counterpart of `MacSurface`, and it exists for the same
/// reason: `AppDestination` is the ROUTING vocabulary both platforms share, and
/// bending it to suit one shell would be a redesign of the other's. What each
/// platform needs on top of it is a narrower answer — *which screen draws this
/// destination, and is that screen something the shell offers* — and that answer
/// is genuinely different on the two platforms even where the destinations are
/// the same.
///
/// ## Why iOS grew one
///
/// Until 0.3.0 iOS had five tabs and no `deviceInbox` at all: `AppDestination`
/// carried a sixth case the iOS tab bar had no `.tag` for, and
/// `IOSSurfaceGuardTests` banned the word from `apps/ios` outright, because a
/// `TabView` handed a selection with no matching tag renders an empty screen.
/// That ban was a true statement about a shell that could not draw the
/// destination. It is false now — iOS receives — so the guard it justified has
/// been replaced by the positive one: every browseable surface is reachable, and
/// the one non-browseable surface is presented rather than selected.
///
/// ## The five rows, and the one that is not a row
///
/// `storedReceive` is deliberately absent from `browseable`, exactly as it is on
/// macOS and for the same product reason: opening a stored link is something the
/// OS hands this app — a verified `relayium.com` Universal Link, or a stored-file
/// row inside Account — not somewhere a person sets out to go. It kept a primary
/// tab whose answer to "what do I do here?" was "paste a link you already have",
/// while the destination that people DO set out for — this device as a place
/// their other devices can send to — had no row at all.
///
/// So the tab bar and the sidebar list the same five, and the stored-link screen
/// is presented OVER whichever of them the user was on. Nothing about its
/// reachability changed: `AppDeepLinkCoordinator` and `AccountView`'s stored-file
/// rows still select `.storedReceive`, and the shell still draws it.
///
/// `String`-backed and `CaseIterable` for the reasons `MacSurface` is: a stable,
/// loggable name UI automation can address, and one list the shell and the tests
/// both enumerate rather than two that can drift.
public enum IOSSurface: String, CaseIterable, Hashable, Sendable {
    /// Same-network discovery, then an end-to-end encrypted transfer. No
    /// account, no code — and deliberately no claim that the path is direct
    /// rather than relayed, because the client cannot tell.
    case lanTransfer
    /// Pairing code. The devices do **not need** to share a network.
    case crossNetworkTransfer
    /// A stored link anybody can open. **Only** that, since 0.3.0: sending to
    /// one of the account's own devices used to be the other half of this
    /// screen, behind a segmented control, and it now starts from the Device
    /// Inbox conversation with that device — see `deviceInbox`.
    case storedSend
    /// Opening a stored link somebody sent. **Not browseable** — see
    /// `browseable` below.
    case storedReceive
    /// This device as a destination: what the account's other devices have sent
    /// here, what this one has sent them, and the composer for the next thing.
    case deviceInbox
    case account

    /// The five rows both shells list, in the order they list them.
    ///
    /// Written as the ordered list rather than as a predicate over `allCases`,
    /// so "which rows, in which order" is one statement in one place.
    /// `isBrowseable` is derived from it, never the other way round.
    ///
    /// The order is the product's, not the enum's: the two account-free live
    /// transfers first, because they are what the app can do for somebody who
    /// has never signed in; then the two account-backed halves of sending and
    /// receiving; then the account itself.
    public static let browseable: [IOSSurface] = [
        .lanTransfer, .crossNetworkTransfer, .storedSend, .deviceInbox, .account,
    ]

    /// Whether the shell offers this surface as a tab or a sidebar row at all.
    public var isBrowseable: Bool { Self.browseable.contains(self) }

    /// The SF Symbol that stands for this surface, named ONCE.
    ///
    /// The tab item, the sidebar row and the screen's own header draw the same
    /// glyph from here rather than each holding a literal: a row and the screen
    /// it opens marked with two different symbols is a screen that does not look
    /// like the thing the user tapped. Nonlocalized by nature — these are system
    /// symbol names, not copy.
    ///
    /// Every one of them exists on iOS 16.0, which is this app's floor. A symbol
    /// introduced later draws nothing at all rather than failing to build, which
    /// is the failure mode `DeviceTargetPicker`'s comment already records for
    /// `laptopcomputer.slash`.
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

    /// The destination selecting this row produces.
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
    /// Which iOS surface draws this destination.
    ///
    /// **No `default`**, exactly as `AppRouting`'s switches and
    /// `AppDestination.macSurface` have none: a seventh destination has to state
    /// which iOS screen renders it rather than inheriting an answer, and the
    /// compiler is what asks. That is the whole protection against the empty-tab
    /// defect the old `deviceInbox` ban was written for.
    var iosSurface: IOSSurface {
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

/// Which surface the shell is drawing, and which one — if any — is presented
/// over it.
///
/// Two fields rather than one, because the iOS shell genuinely has two layers
/// and the second is not a replacement for the first. A stored link arriving
/// while the user is mid-way through choosing files to send must not silently
/// throw that screen away: it is put on top, and dismissing it puts the user
/// back exactly where they were rather than on whichever tab is first.
public struct IOSShellPlacement: Equatable, Sendable {
    /// The browseable surface underneath. Never a non-browseable one — that is
    /// the invariant that keeps the tab bar's selection taggable.
    public let background: IOSSurface
    /// Presented over `background`, or nil.
    public let presented: IOSSurface?

    public init(background: IOSSurface, presented: IOSSurface? = nil) {
        self.background = background
        self.presented = presented
    }

    /// The destination the tab bar and sidebar bind their selection to.
    ///
    /// Always a browseable surface's route, which is what makes a `TabView`
    /// selection with no matching `.tag` unreachable by construction rather
    /// than by a source ban.
    public var backgroundRoute: AppDestination { background.route }
}

/// The iOS shell's two-layer placement, derived from the one app-scoped
/// selection.
///
/// ## Why this is an object subscribed in `init`, not `@State` in the shell
///
/// The same reason `AppNavigationModel` itself is app-scoped: the selection can
/// move from outside the view tree — a Universal Link on a cold launch, an
/// unsolicited nearby session admitted on a socket's queue — and SwiftUI may
/// rebuild or tear down the shell at any time. A `@State` remembering "where the
/// user was before the link" would be reset by exactly the rebuild that a
/// presented sheet causes, and dismissing it would drop the user on the first
/// tab instead of back where they were.
///
/// ## Why it does not write the selection back
///
/// It only ever READS `AppNavigationModel`. Dismissing the presented surface is
/// the shell's action and goes through `navigation.select(...)` like every other
/// navigation event, so there is still exactly one authority for where the user
/// is, and this holds no second copy that could disagree with it.
@MainActor
public final class IOSShellModel: ObservableObject {
    @Published public private(set) var placement: IOSShellPlacement
    private var cancellables: Set<AnyCancellable> = []
    private var started = false

    /// Starts on the destination `AppNavigationModel` starts on, resolved
    /// through the same rule every later change goes through — so a shell built
    /// while a link is already pending cannot begin in a state `apply` would
    /// never produce.
    public init(initial: AppDestination = .nearby) {
        let surface = initial.iosSurface
        placement = surface.isBrowseable
            ? IOSShellPlacement(background: surface)
            : IOSShellPlacement(background: .lanTransfer, presented: surface)
    }

    /// Subscribe. Idempotent, and separate from `init` for the reason
    /// `InboxSessionBridge.observe` is: a `@StateObject` takes its initial value
    /// as an autoclosure, so an object nobody reads is never built.
    public func observe(_ selections: Published<AppDestination>.Publisher) {
        guard !started else { return }
        started = true
        selections
            .sink { [weak self] destination in self?.apply(destination) }
            .store(in: &cancellables)
    }

    /// The rule, as one method so a test can drive it over every destination
    /// without a view.
    ///
    /// A browseable destination replaces the background AND clears anything
    /// presented — because selecting a tab is the user leaving the link screen,
    /// and a sheet that survived it would be a modal the tab bar cannot dismiss.
    ///
    /// A non-browseable one is layered on top and leaves the background exactly
    /// where it was. Selecting it twice is idempotent for the same reason: the
    /// background is only ever written by a browseable selection.
    public func apply(_ destination: AppDestination) {
        let surface = destination.iosSurface
        if surface.isBrowseable {
            placement = IOSShellPlacement(background: surface)
        } else {
            placement = IOSShellPlacement(background: placement.background,
                                          presented: surface)
        }
    }
}
