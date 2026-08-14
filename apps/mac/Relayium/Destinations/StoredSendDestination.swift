import SwiftUI
import RelayiumAppKit

/// Store an encrypted file on Relayium's servers and share the link.
///
/// The one destination that is gated **whole** rather than in halves, and the
/// only one for which that is honest: the ciphertext occupies storage until the
/// link expires, and somebody is billed for it. Relayium still never receives
/// the key — it rides in the link's fragment — which is why the gate's body says
/// so, and why the opposite direction (opening a link somebody sent you) is a
/// separate destination that asks for nothing.
struct StoredSendDestination: View {
    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var model: CloudUploadModel

    /// Computed here as well as inside the pane so the retention cap below has
    /// the plan's number to apply. `AccountGate.from` is pure and total, so
    /// two call sites cannot disagree.
    private var gate: AccountGate {
        AccountGate.from(session.state, bearer: session.bearerToken)
    }

    /// The plan's retention ceiling, or nil while there is no account to have
    /// one. Nil is not zero: `applyRetentionCap(0)` means "unknown, offer
    /// everything", which is the right answer signed out but the wrong one to
    /// apply on the way *out* of a signed-in session.
    private var retentionSecs: Int64? {
        guard case let .allowed(access) = gate else { return nil }
        return access.retentionSecs
    }

    var body: some View {
        DestinationScaffold(title: L10n.t(.navStoredSend),
                            symbol: MacSurface.storedSend.symbol,
                            purpose: L10n.t(.navStoredSendSubtitle)) {
            UploadPane(model: model, gate: gate)
            // Below the pane in every state it can be in — including the account
            // gate, where a reader who cannot yet use the feature is the one most
            // likely to want to know what it does.
            HelpCard(surface: .storedSend)
        }
        // `task(id:)` rather than `onChange(of:initial:)`, which is macOS 14 —
        // and rather than a bare `onAppear`, which would miss the usage payload
        // arriving after the destination is already on screen. Keyed on the
        // value, so it applies exactly once per distinct cap however many times
        // the view is rebuilt, and re-applies when a plan change moves it.
        .task(id: retentionSecs) {
            guard let retentionSecs else { return }
            model.applyRetentionCap(retentionSecs)
        }
    }
}
