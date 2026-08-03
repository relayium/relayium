import Combine
import Foundation

/// The five places the app can put on screen. One case per sidebar row, and the
/// only vocabulary the shell needs in order to decide what to render — which is
/// what keeps the shell itself ignorant of the account (design invariant: the
/// shell never reads `session.state`).
///
/// `String`-backed so a destination has a stable, loggable name; `CaseIterable`
/// so the sidebar and the tests enumerate the same set rather than two lists
/// that can drift apart.
public enum AppDestination: String, CaseIterable, Hashable, Sendable {
    case nearby, pairingCode, storedSend, storedReceive, account
}

/// Event → destination. Both entry points are pure functions of their own
/// input: nothing here reads a model, cancels a session or clears pending work,
/// which is what makes "the later event wins" a contract rather than a race.
public enum AppRouting {
    /// A `relayium://` or `https://relayium.com/...` link the user opened.
    ///
    /// The `switch` deliberately carries **no `default`**: that absence is the
    /// exhaustiveness proof. Adding a case to `AppDeepLink` then fails to
    /// compile here, instead of silently routing the new link to whatever the
    /// default happened to be.
    public static func destination(for link: AppDeepLink) -> AppDestination {
        switch link {
        case .download: return .storedReceive
        case .realtime: return .pairingCode
        }
    }

    /// An unsolicited nearby session that arrived while the user was somewhere
    /// else. Both kinds are handled by the Nearby destination, so both route
    /// there — and, as above, with **no `default`**, so a third kind of inbound
    /// session is a compile error rather than a screen that never opens.
    public static func destination(forIncoming kind: NearbyReceiveKind) -> AppDestination {
        switch kind {
        case .file: return .nearby
        case .text: return .nearby
        }
    }
}

/// Which destination is on screen, held at app scope rather than in the
/// window's view tree.
///
/// The window is closable while the process keeps running, so its view tree is
/// torn down and rebuilt; app scope is what makes the selection survive that.
/// It is *not* a defence against a second window — there is no second window,
/// because the main scene is a unique `Window`, not a `WindowGroup`.
@MainActor public final class AppNavigationModel: ObservableObject {
    @Published public var selection: AppDestination

    /// How many times `select(_:)` has been called. Test-observable, so the
    /// "exactly one assignment, nothing else touched" contract above is
    /// something a test can check rather than something a comment claims.
    public private(set) var selectionWrites: Int = 0

    public init(selection: AppDestination = .nearby) {
        self.selection = selection
    }

    /// One assignment, one counter bump, and nothing else — no session
    /// teardown, no field clearing, no read of any other model.
    public func select(_ d: AppDestination) {
        selection = d
        selectionWrites += 1
    }
}
