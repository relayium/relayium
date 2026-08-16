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
/// ## What it shares with Cross-network Transfer: nothing
///
/// **Not a staged batch.** There is nothing to stage on either screen before a
/// connection exists, so the app-scoped `SelectionStore` the two destinations
/// used to share is gone rather than merely unused: a store no surface writes
/// cannot be reached by a later edit either.
///
/// **And not the session, any more.** For several rounds the two screens drove
/// one `RealtimeSessionModel`, one `RealtimeTextSessionModel`, one
/// `LinkWorkspaceModel` and one `TransferPresence`, and that sharing had three
/// consequences the owner asked to have removed: a same-network session
/// disabled every control on the Cross-network screen, one `link/1` owner routed
/// two rooms so the LAN roster's churn cancelled pairing requests in flight, and
/// "Cancel" could not mean *this* screen because there was only one session to
/// cancel. Each destination now draws its own `TransferModule`; see that type
/// for the whole argument.
///
/// What survives is the arbitration *inside* one module. Which pane this screen
/// draws, and whether its connect controls may start anything, are still
/// `TransferSurfacePresentation`'s answers rather than this file's — the module
/// has one session, and its second start still has to be refused.
struct LanTransferDestination: View {
    /// This screen's module: its own session models, its own `link/1`, its own
    /// ownership. There is deliberately no way from here to the other one, and
    /// observing it redraws this screen for its own events only.
    @ObservedObject var module: TransferModule

    @EnvironmentObject private var verification: VerificationPreference
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @EnvironmentObject private var receive: NearbyReceiveModel

    /// **No account, anywhere in this file.** Same-network transfer in both
    /// directions needs none, so this destination holds no `AccountSession`, no
    /// bearer and no gate — `MacSurfaceGuardTests` checks that by name, because
    /// an account reference here is how a capability that works signed out ends
    /// up behind a sign-in form that does not gate it. Minting a pairing code is
    /// the one user action that spends an account, and it lives on the
    /// Cross-network destination.
    private let route = AppDestination.nearby

    private var presence: TransferPresence { module.presence }
    private var fileModel: RealtimeSessionModel { module.files }
    private var textModel: RealtimeTextSessionModel { module.text }
    /// The unified `link/1`, for peers that announced it.
    private var link: LinkWorkspaceModel { module.link }

    private var pane: TransferSurfacePane { module.pane }

    /// Locked the moment anything is claimed, live or retained **in this
    /// module** — and by nothing on the other destination. The models read the
    /// verification preference when the SAS arrives, so flipping it
    /// mid-handshake would make the gate depend on timing.
    private var sessionLocked: Bool { !module.acceptsNewSession }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navLanTransfer),
                            surface: .lanTransfer,
                            purpose: L10n.t(.navLanTransferSubtitle),
                            contentMaxWidth: nil) {
            switch pane {
            case .link:
                TransferLinkPane(link: link)
            case .legacySession:
                TransferSessionPane(module: module)
            case .connect:
                LanConnectPane(module: module,
                               discovery: discovery,
                               receive: receive,
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
