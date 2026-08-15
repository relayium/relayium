import Combine
import Foundation

/// The six routing destinations the app can put on screen. macOS maps them to
/// five browseable sidebar rows plus one hidden deep-link destination through
/// `MacSurface`; this is the only vocabulary the shell needs to decide what to
/// render, which keeps the shell itself ignorant of the account (design
/// invariant: the shell never reads `session.state`).
///
/// `String`-backed so a destination has a stable, loggable name; `CaseIterable`
/// so the sidebar and the tests enumerate the same set rather than two lists
/// that can drift apart.
///
/// **`deviceInbox` is macOS-only, and the iOS tab bar deliberately has no tag for
/// it.** The enum is shared so the two shells route from one vocabulary rather
/// than two that can drift, but iOS has no resident receiver to put behind a tab
/// — `IOSSurfaceGuardTests` therefore refuses any reference to it anywhere under
/// `apps/ios`, because a `TabView` selection with no matching `.tag` renders
/// nothing at all.
public enum AppDestination: String, CaseIterable, Hashable, Sendable {
    case nearby, pairingCode, storedSend, storedReceive, deviceInbox, account
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
        case .realtime, .realtimeWithMode: return .pairingCode
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

    /// Reconcile a macOS inbound-session publication with the surface that may
    /// present it.
    ///
    /// NearbyReceiveModel and the pairing-code panes share the same realtime
    /// session models. An outbound pairing-code session therefore makes those
    /// models busy too; even if a stale or incorrect inbound publication
    /// arrives, it must not move the window away from the surface that already
    /// owns the session. Claim first, navigate only after that claim succeeds.
    ///
    /// This overload keeps macOS's one TransferPresence.mode authority. iOS
    /// uses the overload below because its picker state lives in
    /// DirectModeSelection.
    @MainActor
    @discardableResult
    public static func claimIncoming(_ kind: NearbyReceiveKind,
                                     peerLabel: String? = nil,
                                     presence: TransferPresence,
                                     navigation: AppNavigationModel) -> Bool {
        let destination = destination(forIncoming: kind)
        let mode: TransferMode = kind == .file ? .files : .text
        guard presence.beginSession(destination, mode: mode,
                                    peerLabel: peerLabel) else { return false }
        navigation.select(destination)
        return true
    }

    /// Put an already-published macOS inbound session back on screen.
    ///
    /// This is reconstruction, not admission: a closed unique window can be
    /// reopened while the app-scoped receive model and ownership are still
    /// live. The owner's idempotent `claim` is required here, while a different
    /// owner is still refused without moving navigation.
    @MainActor
    @discardableResult
    public static func reconcileIncoming(_ kind: NearbyReceiveKind,
                                         presence: TransferPresence,
                                         navigation: AppNavigationModel) -> Bool {
        let destination = destination(forIncoming: kind)
        let mode: TransferMode = kind == .file ? .files : .text
        guard presence.claim(destination, mode: mode) else { return false }
        navigation.select(destination)
        return true
    }

    /// Files the OS opened with this app — a Finder **Open With**, or a drop on
    /// the Dock icon.
    ///
    /// It used to read where the user already is, because a file is not itself a
    /// request to go anywhere and a send destination the user had chosen was
    /// worth keeping. Every destination is now listed together, still with **no
    /// `default`**, so a sixth has to state its answer rather than inherit one —
    /// and the answer for all of them is the same, because there is exactly one
    /// macOS surface left that can hold a batch.
    ///
    /// **What changed is the real-time screens, not this rule.** `.nearby` and
    /// `.pairingCode` establish a session before anything is chosen: no drop
    /// zone, no picker, no staged batch. A Finder **Open With** routed to either
    /// of them would navigate the user to a screen with nowhere for the files to
    /// go — which is worse than the sign-in wall the old comment here weighed
    /// against, because a wall names an action and a screen that ignores you
    /// does not. `deviceInbox` and `account` never staged anything either.
    ///
    /// So the batch goes where a batch can actually live. `LanConnectPane` and
    /// `CrossNetworkConnectPane` no longer adopt anything, and this is the other
    /// half of that: nothing addressed to a transfer route, rather than something
    /// addressed to a route that will silently drop it.
    public static func destination(forOpenedFiles current: AppDestination) -> AppDestination {
        // **Stored Send, from wherever the user was.**
        //
        // It used to be "stay put if you are already on a screen that stages",
        // and the two real-time transfer screens were two of those. They are not
        // any more: Nearby and Pairing establish a session before anything is
        // chosen, so neither has a batch a Finder open or a Dock drop could land
        // in, and routing one there would navigate the user to a screen that
        // visibly does nothing with the files they just handed the app.
        //
        // Stored Send is the one macOS destination whose product IS "choose
        // files, then decide where they go", so it is where they go. The cost is
        // named rather than hidden: it is the account-gated surface, and a
        // signed-out Dock drop now lands on a gate that says so instead of on a
        // free screen that could stage. That is the honest trade for removing
        // pre-connect staging, and the gate at least names an action.
        switch current {
        case .nearby, .pairingCode, .storedSend,
             .storedReceive, .deviceInbox, .account: return .storedSend
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
    /// iOS and macOS both call this from pre-responder admission. A rebuilt
    /// macOS view reconciles the already-live publication separately; it must
    /// not make new-session admission idempotent.
    @MainActor
    @discardableResult
    public static func claimIncoming(_ kind: NearbyReceiveKind,
                                     peerLabel: String? = nil,
                                     presence: TransferPresence,
                                     modes: DirectModeSelection,
                                     navigation: AppNavigationModel) -> Bool {
        let destination = destination(forIncoming: kind)
        guard presence.beginSession(destination, peerLabel: peerLabel) else { return false }
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
