import SwiftUI
import RelayiumAppKit
import RelayiumKit

struct DownloadPane: View {
    @ObservedObject var model: CloudDownloadModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Receive files").font(.headline)
            HStack {
                TextField("Paste a relayium.com/d/… link", text: $model.linkText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.resolve() }
                Button("Open") { model.resolve() }
                    .disabled(model.linkText.isEmpty)
            }
            switch model.state {
            case .idle:
                EmptyView()
            case .resolving:
                ProgressView().controlSize(.small)
            case .ready(let manifest, let expiresAt, let burn):
                let total = manifest.files.reduce(0) { $0 + $1.size }
                Text("\(manifest.files.count) file\(manifest.files.count == 1 ? "" : "s") · \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file))")
                    .font(.subheadline.weight(.semibold))
                ForEach(manifest.files, id: \.name) { f in
                    Text(safeDisplayName(f.name)).font(.caption).foregroundStyle(.secondary)
                }
                if burn {
                    // Stated before it costs something, not as a footnote after.
                    Text("This link is delete-after-download. Saving these files uses it up — nobody else can download them afterwards.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted())")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Save…") { chooseDestination() }
                    .buttonStyle(.borderedProminent)
            case .downloading(let received, let total):
                ProgressView(value: total > 0 ? Double(received) / Double(total) : 0)
                Button("Cancel") { model.cancel() }
            case .done(let urls):
                Text("Saved \(urls.count) file\(urls.count == 1 ? "" : "s")")
                    .font(.subheadline.weight(.semibold))
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting(urls)
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
        panel.prompt = "Save Here"
        if panel.runModal() == .OK, let dir = panel.url { model.download(into: dir) }
    }
}
