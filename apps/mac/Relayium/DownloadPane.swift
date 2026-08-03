import SwiftUI
import RelayiumAppKit
import RelayiumKit

struct DownloadPane: View {
    @ObservedObject var model: CloudDownloadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.downloadHeading)).font(.headline)
            HStack {
                TextField(L10n.t(.downloadLinkPlaceholder), text: $model.linkText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.resolve() }
                Button(L10n.t(.downloadOpen)) { model.resolve() }
                    .disabled(model.linkText.isEmpty)
            }
            switch model.state {
            case .idle:
                EmptyView()
            case .resolving:
                ProgressView().controlSize(.small)
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
                    Text(L10n.t(.downloadBurnNotice))
                        .font(.caption).foregroundStyle(.orange)
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
                Button(L10n.t(.commonCancel)) { model.cancel() }
            case .done(let urls):
                Text(DownloadPresentation.savedSummary(fileCount: urls.count))
                    .font(.subheadline.weight(.semibold))
                if let payload = model.received {
                    ReceivedResultView(payload: payload)
                }
            case .failed(let message):
                Text(message).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
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
