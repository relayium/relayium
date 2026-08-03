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

    @StateObject private var selection = SelectionStore()
    @State private var stagingError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch model.state {
            case .idle, .failed:
                start
            case .minting:
                ProgressView(L10n.t(.directCreatingCode)).controlSize(.small)
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
                Text(L10n.t(.directSendHeading)).font(.headline)
                FileDropZone(store: selection, isBusy: model.isBusy) {
                    Text(selection.summary ?? L10n.t(.directDropHint))
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let message = selection.error {
                    Text(message).font(.callout).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button(L10n.t(.commonChooseFilesOrFolders)) { chooseFilesOrFolders(into: selection) }
                    if !selection.isEmpty {
                        Button(L10n.t(.commonClear)) { selection.clear() }.buttonStyle(.link)
                    }
                    Button(L10n.t(.directCreateCode)) { Task { await mintAndWait() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(selection.isEmpty)
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.t(.directReceiveHeading)).font(.headline)
                HStack {
                    TextField(L10n.t(.commonCode), text: $model.joinCode)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 140)
                        .onChange(of: model.joinCode) { model.updateJoinCode($0) }
                    Button(L10n.t(.commonJoin)) { Task { await model.join(code: model.joinCode) } }
                        .disabled(!model.canJoin)
                }
            }
        }
    }

    private func showing(code: String, expiresAt: Int64) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.directGiveCode)).font(.subheadline.weight(.semibold))
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .none, timeStyle: .short),
            ]))
                .font(.caption).foregroundStyle(.secondary)
            QRCodeView(url: "\(AppEnvironment.productionBaseURL.absoluteString)/cross-network#c=\(code)")
            Text(L10n.t(.directScanOnPhone)).font(.caption).foregroundStyle(.secondary)
            ProgressView(L10n.t(.directWaitingForDevice)).controlSize(.small)
            Button(L10n.t(.commonCancel)) { model.cancel() }
        }
    }

    // MARK: - actions

    private func mintAndWait() async {
        await model.mintCode(token: token)
        guard case let .showingCode(code, _) = model.state else { return }
        stageAndJoin(code: code)
    }

    private func stageAndJoin(code: String) {
        guard let expanded = selection.selection else {
            stagingError = selection.error ?? L10n.t(.directChooseFilesFirst)
            model.cancel()
            return
        }
        let staged: (sources: [PlaintextSource], metas: [FileMeta])
        do {
            staged = try stageRealtimeFiles(expanded.files)
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
