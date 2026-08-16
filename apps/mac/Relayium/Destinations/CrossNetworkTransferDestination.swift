import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **Cross-network Transfer — the other device is anywhere.**
///
/// One destination, one connection method: a six-digit pairing code. The two
/// devices do **not** have to be on the same network, which is the entire reason
/// this is a separate destination from LAN Transfer rather than a second card
/// under it — it is the only question a user has before they choose, and a
/// merged screen could not answer it in a row title.
///
/// ## The account asymmetry, unchanged
///
/// **Minting** a code needs an account, because the code's owner is billed for
/// whatever is relayed through it. **Joining** somebody else's code needs
/// nothing at all. So the gate wraps the create controls and only those — the
/// join field and its two verbs are rendered and enabled identically signed out,
/// and `MacSurfaceGuardTests` checks that as a source property.
///
/// ## What it shares with LAN Transfer: nothing
///
/// It used to share every session model. It shares none of them now: this
/// destination draws its own `TransferModule` — its own legacy pair, its own
/// `link/1` owner bound to the pairing room and no other, and its own
/// `TransferPresence`. A same-network session no longer disables a single
/// control here, and a code minted here no longer disables a single control
/// there. See `TransferModule` for why that sharing had to end rather than be
/// arbitrated more carefully.
///
/// Which pane this screen draws, and whether it may start anything, are still
/// `TransferSurfacePresentation`'s answers from THIS module's ownership: a
/// module has one session and its second start still has to be refused.
struct CrossNetworkTransferDestination: View {
    /// This screen's module. There is deliberately no way from here to the
    /// Nearby one, and observing it redraws this screen for its own events only.
    @ObservedObject var module: TransferModule

    @EnvironmentObject private var verification: VerificationPreference
    /// Held for the create half only. Joining is account-free.
    @EnvironmentObject private var session: AccountSession
    /// Read for ONE thing: where a regeneration goes when the credential it was
    /// about to spend has gone away. The same route `CrossNetworkConnectPane`
    /// takes for the same reason, and nothing on this screen navigates for any
    /// other purpose.
    @EnvironmentObject private var navigation: AppNavigationModel

    private let route = AppDestination.pairingCode

    private var presence: TransferPresence { module.presence }
    private var fileModel: RealtimeSessionModel { module.files }
    private var textModel: RealtimeTextSessionModel { module.text }
    /// The unified `link/1`. A pairing room makes the same capability decision a
    /// same-network room does, after its peer appears.
    private var link: LinkWorkspaceModel { module.link }

    private var pane: TransferSurfacePane { module.pane }

    private var sessionLocked: Bool { !module.acceptsNewSession }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navCrossNetwork),
                            surface: .crossNetworkTransfer,
                            purpose: L10n.t(.navCrossNetworkSubtitle),
                            contentMaxWidth: nil) {
            switch pane {
            case .link:
                TransferLinkPane(link: link)
            case .legacySession:
                // The one surface that can mint a replacement code, because it
                // is the one that holds the account gate. See
                // `TransferSessionPane.regenerate`.
                TransferSessionPane(module: module, regenerate: regeneratePairingCode)
            case .connect:
                CrossNetworkConnectPane(module: module,
                                        gate: gate,
                                        accessNow: { accessNow },
                                        sessionLocked: sessionLocked)
                VerificationSetting(locked: sessionLocked, preference: verification)
            }
            // Outside the `switch`, for the reason `LanTransferDestination`
            // records: help present only on the idle pane is absent exactly when
            // somebody is watching something they do not understand.
            HelpCard(surface: .crossNetworkTransfer)
        }
    }

    /// **Mint a fresh code in place of an expired one**, without letting go of
    /// this module's surface on the way.
    ///
    /// The account is re-read at activation time for the reason `createCode`
    /// does it: rendering an expired code and pressing the button under it are
    /// different turns, and a sign-out can land between them. A user whose
    /// credential went away is taken to the one screen that explains why rather
    /// than watching a button do nothing.
    ///
    /// **It cannot disturb the Nearby module**, and that is a property of the
    /// composition rather than of this function: everything it touches is
    /// reached through `module`, the two modules share no presence, no room, no
    /// socket and no session model, and there is no reference to the other one
    /// anywhere in this file.
    private func regeneratePairingCode() {
        guard let access = accessNow else {
            navigation.selectAccount(intent: .signIn)
            return
        }
        Task { await PairingCodeStart(module: module).regenerate(token: access.token) }
    }

    /// The gate controls what is rendered.
    ///
    /// **Scoped to the OFFLINE acceptance launch.** A loopback built-App run now
    /// composes the real transfer models against a real server, so handing it a
    /// fabricated bearer would render an allowed Create whose only outcome is an
    /// authentication failure — a fixture contradicting the run it is in. See
    /// `UITestMode.usesOfflineTransfer`.
    private var gate: AccountGate {
        #if DEBUG
        if UITestMode.usesOfflineTransfer {
            return .allowed(AccountAccess(token: "ui-test", retentionSecs: 86_400))
        }
        #endif
        return AccountGate.from(session.state, bearer: session.bearerToken)
    }

    /// What an activation may spend. SwiftUI can deliver a click from the
    /// previous render after the account has changed, so child actions ask the
    /// live session again instead of spending the access a Button captured.
    private var accessNow: AccountAccess? {
        #if DEBUG
        if UITestMode.usesOfflineTransfer {
            return AccountAccess(token: "ui-test", retentionSecs: 86_400) // nonlocalized: fixture
        }
        #endif
        guard case let .allowed(access) = AccountGate.from(session.state,
                                                           bearer: session.bearerToken)
        else { return nil }
        return access
    }
}
