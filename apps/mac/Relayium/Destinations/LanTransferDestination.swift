import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **LAN Transfer — the other device is on this network.**
///
/// One destination, one connection method: find the device in the roster and
/// open an end-to-end encrypted connection to it. No account and no code, which
/// is the part the user actually needs before choosing between this screen and
/// the next one.
///
/// **It does not promise a direct path, because this client cannot see one.**
/// Depending on network conditions, a same-network connection may run between
/// the devices or over a TURN relay — and nothing available here distinguishes
/// the two, which is exactly why `PathRailPresentation.lan` has no `.direct`
/// stop and why the copy on this screen says encrypted rather than direct. What
/// is true either way is that Relayium never holds the key.
///
/// ## Why this is a destination again
///
/// It was briefly half of one merged Workspace row, on the argument that a
/// pairing code and same-network discovery are two ways to reach one peer rather
/// than two products. Underneath, that is true and still is: both drive the same
/// `RealtimeSessionModel`, `RealtimeTextSessionModel` and `LinkWorkspaceModel`,
/// and `TransferPresence` still hands the one live session to exactly one of
/// them. On screen it was not: the two methods have different preconditions —
/// this one requires the same network and no account, the other requires an
/// account to mint a code and explicitly does NOT require a shared network — and
/// a merged screen had to state both, so it stated neither first. Splitting the
/// surface is what lets each screen show only its own method.
///
/// ## What is shared, and where it is decided
///
/// The staged batch is app-scoped (`SelectionStore` in the environment), so
/// files picked here are still picked if the user decides to use a code
/// instead — the split must not make somebody stage twice.
///
/// The session is shared too, and that is the delicate half. Which pane this
/// screen draws, and whether its connect controls may start anything, are
/// `TransferSurfacePresentation`'s answers rather than this file's: a session
/// belonging to the pairing-code route must not be drawn here, and must not be
/// startable over.
struct LanTransferDestination: View {
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var verification: VerificationPreference
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @EnvironmentObject private var receive: NearbyReceiveModel
    @EnvironmentObject private var fileModel: RealtimeSessionModel
    @EnvironmentObject private var textModel: RealtimeTextSessionModel
    /// The unified `link/1`, for peers that announced it.
    @EnvironmentObject private var link: LinkWorkspaceModel
    /// One staged batch for both transfer destinations, app-scoped so it
    /// survives this screen being replaced — by the session it starts, or by the
    /// user switching to the other connection method.
    @EnvironmentObject private var selection: SelectionStore

    /// **No account, anywhere in this file.** Same-network transfer in both
    /// directions needs none, so this destination holds no `AccountSession`, no
    /// bearer and no gate — `MacSurfaceGuardTests` checks that by name, because
    /// an account reference here is how a capability that works signed out ends
    /// up behind a sign-in form that does not gate it. Minting a pairing code is
    /// the one user action that spends an account, and it lives on the
    /// Cross-network destination.
    private let route = AppDestination.nearby

    private var sessionIsLiveOrRetained: Bool {
        fileModel.state != .idle || textModel.state != .idle || link.hasSession
    }

    private var pane: TransferSurfacePane {
        TransferSurfacePresentation.pane(route: route,
                                         owner: presence.owner,
                                         linkHasSession: link.hasSession)
    }

    /// Locked the moment anything is claimed, live or retained — including on
    /// the other transfer destination. The models read the verification
    /// preference when the SAS arrives, so flipping it mid-handshake would make
    /// the gate depend on timing.
    private var sessionLocked: Bool {
        !TransferSurfacePresentation.acceptsNewSession(
            owner: presence.owner, sessionIsLiveOrRetained: sessionIsLiveOrRetained)
    }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navLanTransfer),
                            surface: .lanTransfer,
                            purpose: L10n.t(.navLanTransferSubtitle),
                            contentMaxWidth: nil) {
            switch pane {
            case .link:
                TransferLinkPane(link: link)
            case .legacySession:
                TransferSessionPane(route: route,
                                    fileModel: fileModel,
                                    textModel: textModel,
                                    selection: selection)
            case .connect:
                LanConnectPane(discovery: discovery,
                               receive: receive,
                               fileModel: fileModel,
                               textModel: textModel,
                               link: link,
                               selection: selection,
                               sessionLocked: sessionLocked)
                VerificationSetting(locked: sessionLocked, preference: verification)
            }
            // Below the controls, on every pane, and never in place of them.
            // Rendered outside the `switch` deliberately: help that appeared only
            // on the idle screen would be absent exactly when a user is watching
            // something they do not understand happen.
            HelpCard(surface: .lanTransfer)
        }
        // A session nobody asked for decides its own kind, so the mode follows
        // it. `task(id:)` rather than `onChange`, because this window may have
        // been closed when the session started and rebuilt — with the mode back
        // at its default — while it is still running.
        //
        // Only this destination does it: an unsolicited same-network session
        // routes to `.nearby` (`AppRouting.destination(forIncoming:)`), and the
        // Cross-network screen claiming one would be a second surface admitting
        // a session it does not route.
        .task(id: receive.activeKind) { followIncoming() }
    }

    /// Puts an incoming session on screen in the mode that can render it.
    /// Without this, a file transfer arriving while the mode sat on text shows
    /// the text lane's idle state and the transfer is invisible.
    private func followIncoming() {
        guard let kind = receive.activeKind else { return }
        presence.claim(AppRouting.destination(forIncoming: kind),
                       mode: kind == .file ? .files : .text)
    }
}
