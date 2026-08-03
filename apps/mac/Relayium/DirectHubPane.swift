import SwiftUI
import RelayiumAppKit

/// Explicit intent selection: neither a pairing code nor a roster entry encodes
/// whether the user means files or text, so the native app must never guess.
struct DirectHubPane: View {
    private enum Mode: Hashable { case files, text }

    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    @EnvironmentObject private var verification: VerificationPreference
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @EnvironmentObject private var receive: NearbyReceiveModel
    let token: String
    @State private var mode: Mode = .files
    /// True while the nearby pane is showing a live session. The pairing-code
    /// section is hidden then: both drive the SAME model, so leaving it up
    /// would render one session twice, each with its own Cancel.
    @State private var nearbySession = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker(L10n.t(.hubTransferType), selection: $mode) {
                Text(L10n.t(.hubFiles)).tag(Mode.files)
                Text(L10n.t(.hubText)).tag(Mode.text)
            }
            .pickerStyle(.segmented)
            .disabled(fileModel.isBusy || textModel.isBusy || nearbySession)
            .accessibilityHint(L10n.t(.hubTransferTypeHint))

            NearbyPane(discovery: discovery,
                       receive: receive,
                       fileModel: fileModel,
                       textModel: textModel,
                       intent: mode == .files ? .files : .text,
                       sessionActive: $nearbySession)

            if !nearbySession {
                Divider()
                switch mode {
                case .files:
                    DirectPane(model: fileModel, token: token)
                case .text:
                    RealtimeTextPane(model: textModel, token: token)
                }
            }

            Divider()
            verificationSetting
        }
        // A session nobody asked for decides its own kind, so the picker has to
        // follow it rather than the other way round. `task(id:)` rather than
        // `onChange`, because this window may have been closed when the session
        // started and rebuilt — with `mode` back at its default — while it is
        // still running.
        .task(id: receive.activeKind) { followIncoming() }
    }

    /// Puts an incoming session on screen in the surface that can render it.
    /// Without this, a file transfer arriving while the picker sat on Text shows
    /// the text pane's idle state and the transfer is invisible — and switching
    /// the picker by hand would be blocked, because it is disabled while busy.
    private func followIncoming() {
        guard let kind = receive.activeKind else { return }
        mode = (kind == .file) ? .files : .text
        // The pairing-code section is hidden while this is true: both drive the
        // SAME models, and leaving it up would render one session twice.
        nearbySession = true
    }

    /// Placed here rather than inside either pane: it applies to both kinds of
    /// session, and a setting that only appears on the tab you are not looking
    /// at is a setting nobody finds. Locked while a session is live, because
    /// the models read it when the SAS arrives — flipping it mid-handshake
    /// would make the gate depend on timing.
    private var verificationSetting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(L10n.t(.verifyToggle),
                   isOn: $verification.requiresSASConfirmation)
                .disabled(fileModel.isBusy || textModel.isBusy)
            Text(L10n.t(.verifyExplainWhat))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.t(.verifyExplainEncryption))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
