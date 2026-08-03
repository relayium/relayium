import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Opening a stored link: paste it, see what is in it, save it.
///
/// **Nothing here consults the account.** A stored link is downloaded with no
/// credential of any kind — `AnonymousCapabilityTests` proves that at the
/// transport, request by request — and this file holds no session object so it
/// cannot start.
///
/// Every state is designed. `.idle` used to render `EmptyView()`: a link field
/// above a blank rectangle, saying nothing about what to paste or why the key
/// never leaves the client. `.resolving` was a bare spinner with no label,
/// `.downloading` a progress bar with no figure, and `.failed` a red line with
/// no way out.
struct DownloadPane: View {
    @ObservedObject var model: CloudDownloadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                TextField(L10n.t(.downloadLinkPlaceholder), text: $model.linkText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.resolve() }
                // The one greyed control this surface keeps, and the exception
                // the rule allows: what is missing is the field immediately
                // beside it, and supplying it is one paste away — unlike an
                // account, which is why that gets a gate instead of a grey.
                Button(L10n.t(.downloadOpen)) { model.resolve() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.linkText.isEmpty)
            }
            switch model.state {
            case .idle:
                // The hint IS the state: it names the one action and the reason
                // this destination needs nothing else — the key rides in the
                // fragment, which never reaches a server.
                EmptyStateView(symbol: "link", title: L10n.t(.downloadIdleHint))
            case .resolving:
                ProgressView(L10n.t(.downloadResolving)).controlSize(.small)
            case .ready(let manifest, let expiresAt, let burn):
                let total = manifest.files.reduce(0) { $0 + $1.size }
                Text(DownloadPresentation.manifestSummary(fileCount: manifest.files.count,
                                                          totalBytes: Int64(total)))
                    .font(.subheadline.weight(.semibold))
                // By index, not by name: a folder upload keeps its hierarchy in
                // `name`, so two entries can share a leaf and duplicate ids
                // would silently drop a row from the list the user is deciding
                // on.
                ForEach(Array(manifest.files.enumerated()), id: \.offset) { _, f in
                    Text(safeDisplayName(f.name))
                        .font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                if burn {
                    // Stated before it costs something, not as a footnote after.
                    InlineMessage(.warning, L10n.t(.downloadBurnNotice))
                }
                Text(L10n.t(.commonExpires, [
                    L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                              dateStyle: .medium, timeStyle: .short),
                ]))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n.t(.downloadSave)) { chooseDestination() }
                    .buttonStyle(.borderedProminent)
            case .downloading(let received, let total):
                ProgressView(value: total > 0 ? Double(received) / Double(total) : 0)
                Text(L10n.percent(done: received, total: total) ?? L10n.t(.downloadInProgress))
                    .font(.caption).foregroundStyle(.secondary)
                Button(L10n.t(.commonCancel)) { model.cancel() }
            case .done(let urls):
                Text(DownloadPresentation.savedSummary(fileCount: urls.count))
                    .font(.subheadline.weight(.semibold))
                if let payload = model.received {
                    ReceivedResultView(payload: payload)
                }
            case .failed(let message):
                InlineMessage(.failure, message)
                // Resolving again is the whole retry: it re-parses whatever is
                // in the field, so a corrected link works without any other
                // step, and an unchanged bad one says the same thing again
                // rather than appearing to have done something.
                Button(L10n.t(.commonTryAgain)) { model.resolve() }
            }
        }
    }

    private func chooseDestination() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.prompt = L10n.t(.downloadSavePanelPrompt)
        if panel.runModal() == .OK, let dir = panel.url { model.download(into: dir) }
    }
}
