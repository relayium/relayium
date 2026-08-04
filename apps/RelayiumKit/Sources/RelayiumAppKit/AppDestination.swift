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

    /// Everything an unsolicited session must settle **synchronously**, in one
    /// call, before its responder is built.
    ///
    /// `NearbyReceiveModel` admits an offer on the socket's own delivery queue
    /// and then builds the responder across an `await`. Three separate writes in
    /// a closure at the call site would be three chances for a later edit to
    /// reorder one of them past that await — and any of them landing late is a
    /// live session on a surface nobody is looking at, with the picker that
    /// would fix it already locked because a model is busy.
    ///
    /// The three answers are one decision, so they are one function:
    ///
    ///  - **who draws it** — refused if any surface already owns a session,
    ///    including Nearby itself. The latter closes the small window after an
    ///    outbound tap has claimed Nearby but before its async model has become
    ///    busy. Nothing at all moves on refusal, because a half-applied claim
    ///    would navigate away from a transfer to a tab that will not draw one;
    ///  - **which half of the picker** — the session's own kind, not the user's
    ///    choice, which is why `DirectModeSelection.adopt` is unconditional;
    ///  - **which tab** — last, so the shell arrives at a surface that is
    ///    already configured.
    ///
    /// iOS's shell is the caller. macOS reconciles the same facts from its
    /// nearby destination's `task(id:)`, because its window can be closed and
    /// rebuilt while a session runs — a case a one-shot call cannot cover.
    @MainActor
    @discardableResult
    public static func claimIncoming(_ kind: NearbyReceiveKind,
                                     presence: TransferPresence,
                                     modes: DirectModeSelection,
                                     navigation: AppNavigationModel) -> Bool {
        let destination = destination(forIncoming: kind)
        // This is deliberately stricter than `TransferPresence.claim`, whose
        // idempotence is useful to a surface reconciling a session it already
        // owns. An inbound offer is always a *new* session. If Nearby has only
        // just claimed an outbound tap, the two realtime models may still be
        // idle until that tap's Task begins; admitting the offer in that gap
        // would let two attempts overwrite the same model.
        guard presence.owner == nil, presence.claim(destination) else { return false }
        modes.adopt(forIncoming: kind)
        navigation.select(destination)
        return true
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

    /// Which half of the account form the Account destination should open on.
    ///
    /// The whole reason it exists: a capability gate's **Create an account**
    /// used to open relayium.com, and routing it to the Account destination
    /// without this would land the user on a sign-in form — a button that names
    /// one thing and produces another. The form reads this on arrival and is
    /// otherwise free to change mode on its own; nothing here reaches back into
    /// the form's typed fields.
    @Published public private(set) var accountIntent: AuthMode = .signIn

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

    /// Open the account surface on a named half of the form.
    ///
    /// Still exactly one selection write: the intent is set first so the form
    /// cannot render once on the wrong mode and then swap under the user.
    public func selectAccount(intent: AuthMode) {
        accountIntent = intent
        select(.account)
    }

    /// Keep the remembered account-form half in step with a mode change that
    /// happened *inside* the form, without manufacturing a navigation event.
    ///
    /// This is load-bearing when a create-account route is followed by the
    /// user's own “Back to sign in”: a later remount must not replay the old
    /// `.register` intent and undo that choice.
    public func rememberAccountIntent(_ intent: AuthMode) {
        accountIntent = intent
    }
}
