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
                ProgressView("Creating a text code…").controlSize(.small)
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
                Text("Start a text session").font(.headline)
                Text("Both devices stay online. Messages are end-to-end encrypted and kept only in this session's memory.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Create a text code") {
                    Task {
                        await model.mintCode(token: token)
                        guard case let .showingCode(code, _) = model.state else { return }
                        await model.join(code: code, role: .initiator)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(token.isEmpty)
                if token.isEmpty {
                    Text("Sign in to create a code. Joining someone else's code does not require an account.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Join a text session").font(.headline)
                HStack {
                    TextField("Code", text: $model.joinCode)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                    Button("Join") {
                        Task { await model.join(code: model.joinCode) }
                    }
                    .disabled(!model.canJoin)
                }
                Text("A pairing code does not reveal its type. Choose Text here only when the sender started a text session.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Give this text code to the other device")
                .font(.subheadline.weight(.semibold))
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted(date: .omitted, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.secondary)
            QRCodeView(url: "\(AppEnvironment.productionBaseURL.absoluteString)/cross-network#c=\(code)")
            ProgressView("Waiting for the other device…").controlSize(.small)
            Button("Cancel") { model.end() }
        }
    }
}
