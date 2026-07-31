import SwiftUI
import RelayiumAppKit

/// Explicit intent selection: pairing codes do not encode whether the user
/// means files or text, so the native app must never guess.
struct DirectHubPane: View {
    private enum Mode: Hashable { case files, text }

    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    let token: String
    @State private var mode: Mode = .files

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("Transfer type", selection: $mode) {
                Text("Files").tag(Mode.files)
                Text("Text").tag(Mode.text)
            }
            .pickerStyle(.segmented)
            .disabled(fileModel.isBusy || textModel.isBusy)
            .accessibilityHint("Choose what this pairing code session will transfer.")

            switch mode {
            case .files:
                DirectPane(model: fileModel, token: token)
            case .text:
                RealtimeTextPane(model: textModel, token: token)
            }
        }
    }
}
