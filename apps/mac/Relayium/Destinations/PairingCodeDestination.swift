import SwiftUI
import RelayiumAppKit

/// Transfer across networks with six digits.
///
/// The destination is **half** gated, and the halves are not a style choice:
/// minting a code reserves relay capacity billed to whoever created it, while
/// joining a code somebody else created reserves nothing and reaches the
/// transport with no credential at all. So the create card renders a gate when
/// there is no account, and the join field beside it is rendered and enabled
/// exactly as it is when signed in.
struct PairingCodeDestination: View {
    @EnvironmentObject private var navigation: AppNavigationModel
    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var fileModel: RealtimeSessionModel
    @EnvironmentObject private var textModel: RealtimeTextSessionModel

    private var busy: Bool { fileModel.isBusy || textModel.isBusy }

    private var gate: AccountGate {
        #if DEBUG
        if UITestMode.isActive {
            return .allowed(AccountAccess(token: "ui-test", retentionSecs: 86_400))
        }
        #endif
        return AccountGate.from(session.state, bearer: session.bearerToken)
    }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navPairingCode),
                            subtitle: L10n.t(.navPairingCodeSubtitle)) {
            if let owner = presence.owner, owner != .pairingCode {
                busyElsewhere(owner)
            } else {
                modePicker
                switch presence.mode {
                case .files: DirectPane(model: fileModel, gate: gate)
                case .text:  RealtimeTextPane(model: textModel, gate: gate)
                }
            }
        }
    }

    /// The same one question the nearby destination asks, reading and writing
    /// the same answer: a pairing code does not reveal whether the sender chose
    /// files or text, so somebody has to say, and saying it twice would be two
    /// answers to one question.
    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Picker(L10n.t(.hubTransferType), selection: Binding(
                get: { presence.mode },
                set: { presence.selectMode($0) }
            )) {
                Text(L10n.t(.hubFiles)).tag(TransferMode.files)
                Text(L10n.t(.hubText)).tag(TransferMode.text)
            }
            .pickerStyle(.segmented)
            .disabled(busy || presence.owner != nil)
            .accessibilityHint(L10n.t(.directModeMatchHint))
            Text(L10n.t(.directModeMatchHint))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing-mode-match-hint")
        }
    }

    /// Nearby is presenting the session. Both destinations drive the same two
    /// models, so the alternative is one transfer rendered twice with a Cancel
    /// button each.
    private func busyElsewhere(_ owner: AppDestination) -> some View {
        EmptyStateView(symbol: "arrow.left.arrow.right.circle",
                       title: L10n.t(.presenceBusyTitle),
                       body: L10n.t(.presenceBusyBody),
                       actionTitle: L10n.t(.presenceShowIt)) {
            navigation.select(owner)
        }
    }
}
