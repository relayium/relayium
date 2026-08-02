import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

/// Peer-to-peer transfer: mint a code or join one, optionally compare the
/// phrase, send. Holds no decisions — every state it renders is covered by
/// RealtimeSessionModelTests, including whether `.verifying` is reached at all.
struct DirectPane: View {
    @ObservedObject var model: RealtimeSessionModel
    let token: String

    @State private var picked: [URL] = []
    @State private var stagingError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.state {
            case .idle, .failed:
                start
            case .minting:
                ProgressView("Creating a code…").controlSize(.small)
            case let .showingCode(code, expiresAt):
                showing(code: code, expiresAt: expiresAt)
            case .joining, .connecting, .verifying, .transferring, .completed:
                // Shared with the nearby pane: everything past "a peer has been
                // reached" is identical whether the peer came from a code or
                // from the same-network roster.
                RealtimeFileSessionView(model: model)
            }

            if case let .failed(message) = model.state {
                Text(message)
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let stagingError {
                Text(stagingError)
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - start

    private var start: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Send").font(.headline)
                Text(picked.isEmpty ? "Choose files, then create a code for the other device."
                                    : "\(picked.count) file\(picked.count == 1 ? "" : "s") ready.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Choose Files…") { chooseFiles() }
                    Button("Create a code") { Task { await mintAndWait() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(picked.isEmpty)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Receive").font(.headline)
                HStack {
                    TextField("Code", text: $model.joinCode)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                    Button("Join") { Task { await model.join(code: model.joinCode) } }
                        .disabled(!model.canJoin)
                }
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Give this code to the other device").font(.subheadline.weight(.semibold))
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted(date: .omitted, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            QRCodeView(url: "\(AppEnvironment.productionBaseURL.absoluteString)/cross-network#c=\(code)")
            Text("Or scan this on a phone.").font(.caption).foregroundStyle(.secondary)
            ProgressView("Waiting for the other device…").controlSize(.small)
            Button("Cancel") { model.cancel() }
        }
    }

    // MARK: - actions

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false      // folder recursion is out of scope
        if panel.runModal() == .OK {
            picked = panel.urls
            stagingError = nil
        }
    }

    private func mintAndWait() async {
        await model.mintCode(token: token)
        guard case let .showingCode(code, _) = model.state else { return }
        stageAndJoin(code: code)
    }

    private func stageAndJoin(code: String) {
        let staged: (sources: [PlaintextSource], metas: [FileMeta])
        do {
            staged = try stageRealtimeFiles(picked)
        } catch {
            stagingError = ErrorCopy.message(for: error)
            model.cancel()
            return
        }
        stagingError = nil
        model.stageSend(sources: staged.sources, metas: staged.metas)
        Task { await model.join(code: code, role: .initiator) }
    }
}
