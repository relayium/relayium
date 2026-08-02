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
    let token: String
    @State private var mode: Mode = .files
    /// True while the nearby pane is showing a live session. The pairing-code
    /// section is hidden then: both drive the SAME model, so leaving it up
    /// would render one session twice, each with its own Cancel.
    @State private var nearbySession = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Transfer type", selection: $mode) {
                Text("Files").tag(Mode.files)
                Text("Text").tag(Mode.text)
            }
            .pickerStyle(.segmented)
            .disabled(fileModel.isBusy || textModel.isBusy || nearbySession)
            .accessibilityHint("Choose what this session will transfer.")

            NearbyPane(discovery: discovery,
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
    }

    /// Placed here rather than inside either pane: it applies to both kinds of
    /// session, and a setting that only appears on the tab you are not looking
    /// at is a setting nobody finds. Locked while a session is live, because
    /// the models read it when the SAS arrives — flipping it mid-handshake
    /// would make the gate depend on timing.
    private var verificationSetting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Compare verification codes with the other device",
                   isOn: $verification.requiresSASConfirmation)
                .disabled(fileModel.isBusy || textModel.isBusy)
            Text("Off by default. When on, both devices show the same six-digit verification code (SAS) before anything moves; comparing it out loud detects a substituted signalling endpoint. It is not the pairing code you typed in, and it only detects anything if someone actually compares the two.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("This changes what is shown and what stops for confirmation — never the encryption. Keys are generated on this Mac and never sent to Relayium, the relay carries only ciphertext, and a tampered handshake always fails.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
