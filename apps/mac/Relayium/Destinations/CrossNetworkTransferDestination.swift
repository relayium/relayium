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
/// ## What it shares with LAN Transfer
///
/// The staged batch (app-scoped, so nobody stages twice after changing their
/// mind about how to connect) and every session model. Which pane this screen
/// draws, and whether it may start anything, are decided by
/// `TransferSurfacePresentation` from ownership rather than from model state, so
/// a same-network session cannot appear here and cannot be started over.
struct CrossNetworkTransferDestination: View {
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var verification: VerificationPreference
    @EnvironmentObject private var fileModel: RealtimeSessionModel
    @EnvironmentObject private var textModel: RealtimeTextSessionModel
    /// The unified `link/1`. A pairing room makes the same capability decision a
    /// same-network room does, after its peer appears.
    @EnvironmentObject private var link: LinkWorkspaceModel
    @EnvironmentObject private var selection: SelectionStore
    /// Held for the create half only. Joining is account-free.
    @EnvironmentObject private var session: AccountSession

    private let route = AppDestination.pairingCode

    private var sessionIsLiveOrRetained: Bool {
        fileModel.state != .idle || textModel.state != .idle || link.hasSession
    }

    private var pane: TransferSurfacePane {
        TransferSurfacePresentation.pane(route: route,
                                         owner: presence.owner,
                                         linkHasSession: link.hasSession)
    }

    private var sessionLocked: Bool {
        !TransferSurfacePresentation.acceptsNewSession(
            owner: presence.owner, sessionIsLiveOrRetained: sessionIsLiveOrRetained)
    }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navCrossNetwork),
                            symbol: MacSurface.crossNetworkTransfer.symbol,
                            purpose: L10n.t(.navCrossNetworkSubtitle),
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
                CrossNetworkConnectPane(fileModel: fileModel,
                                        textModel: textModel,
                                        link: link,
                                        selection: selection,
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

    /// The gate controls what is rendered.
    private var gate: AccountGate {
        #if DEBUG
        if UITestMode.isActive {
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
        if UITestMode.isActive {
            return AccountAccess(token: "ui-test", retentionSecs: 86_400) // nonlocalized: fixture
        }
        #endif
        guard case let .allowed(access) = AccountGate.from(session.state,
                                                           bearer: session.bearerToken)
        else { return nil }
        return access
    }
}
