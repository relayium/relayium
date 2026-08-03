import AppKit
import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Pairing-code half of an ephemeral text session: mint a code, or join one.
/// Everything from "a peer has been reached" onwards is
/// `RealtimeTextSessionView`, shared with the nearby pane.
struct RealtimeTextPane: View {
    @ObservedObject var model: RealtimeTextSessionModel
    let token: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.state {
            case .idle:
                start
            case .failed, .ended, .refused, .unsupported:
                RealtimeTextSessionView(model: model)
                Divider()
                start
            case .minting:
                ProgressView(L10n.t(.textCreatingCode)).controlSize(.small)
            case let .showingCode(code, expiresAt):
                showing(code: code, expiresAt: expiresAt)
            case .joining, .connecting, .verifying, .waitingAccept,
                 .incomingRequest, .open:
                RealtimeTextSessionView(model: model)
            }
        }
    }

    private var start: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.t(.textStartHeading)).font(.headline)
                Text(L10n.t(.textStartBody))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(L10n.t(.textCreateCode)) {
                    Task {
                        await model.mintCode(token: token)
                        guard case let .showingCode(code, _) = model.state else { return }
                        await model.join(code: code, role: .initiator)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(token.isEmpty)
                if token.isEmpty {
                    Text(L10n.t(.textSignInToCreate))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.t(.textJoinHeading)).font(.headline)
                HStack {
                    TextField(L10n.t(.commonCode), text: $model.joinCode)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                    Button(L10n.t(.commonJoin)) {
                        Task { await model.join(code: model.joinCode) }
                    }
                    .disabled(!model.canJoin)
                }
                Text(L10n.t(.textJoinHint))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.textGiveCode))
                .font(.subheadline.weight(.semibold))
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .none, timeStyle: .short),
            ]))
                .font(.caption)
                .foregroundStyle(.secondary)
            QRCodeView(url: "\(AppEnvironment.productionBaseURL.absoluteString)/cross-network#c=\(code)")
            ProgressView(L10n.t(.directWaitingForDevice)).controlSize(.small)
            Button(L10n.t(.commonCancel)) { model.end() }
        }
    }
}
