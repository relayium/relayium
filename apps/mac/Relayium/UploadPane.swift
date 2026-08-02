import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

struct UploadPane: View {
    @ObservedObject var model: CloudUploadModel
    let token: String

    /// The pane owns the selection; the model owns what is being uploaded. They
    /// are kept in step through `model.pick`, so the model still refuses an
    /// oversized file and still has something to return to after a cancel.
    @StateObject private var selection = SelectionStore()

    private let ttlLabels: [Int: String] = [
        3600: "1 hour", 86400: "1 day", 259200: "3 days",
        604800: "7 days", 1209600: "14 days",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Send files").font(.headline)
            switch model.state {
            case .idle:
                dropZone(hint: "Drop files or folders here, or click to choose")
            case .picked:
                dropZone(hint: selection.summary ?? "Ready")
                Button("Clear") { selection.clear() }.buttonStyle(.link)
                options
                Button("Send") { model.start(token: token) }
                    .buttonStyle(.borderedProminent)
                    .disabled(token.isEmpty)
            case .uploading(let sent, let total):
                ProgressView(value: total > 0 ? Double(sent) / Double(total) : 0)
                Text(total > 0 ? "\(sent * 100 / total)%" : "Starting…")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Cancel") { model.cancel() }
            case .done(let link, let expiresAt):
                Text("Link ready").font(.subheadline.weight(.semibold))
                // The key lives only in this link. Say so here, on the screen
                // where the link appears — not in a tooltip found later.
                Text("This link is the only copy of the key. If it is lost, the files cannot be recovered.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Text(link).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(link, forType: .string)
                    }
                }
                Text("Expires \(Date(timeIntervalSince1970: TimeInterval(expiresAt)).formatted())")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Send another") { model.reset() }.buttonStyle(.link)
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again") { model.reset() }
            }
        }
        // The store owns "what the user chose"; the model owns "what is being
        // uploaded". Pushing on every revision keeps them one fact rather than
        // two — including the empty case, which has to reach `clearSelection`
        // and not `reset` (reset deliberately restores the last selection).
        .onChange(of: selection.revision) { _ in
            if let expanded = selection.selection {
                model.pick(expanded)
            } else if let message = selection.error {
                model.fail(message)
            } else {
                model.clearSelection()
            }
        }
    }

    private var options: some View {
        HStack(spacing: 16) {
            Picker("Expires after", selection: $model.ttl) {
                ForEach(model.ttlChoices, id: \.self) { secs in
                    Text(ttlLabels[secs] ?? "\(secs)s").tag(secs)
                }
            }
            .frame(maxWidth: 220)
            Toggle("Delete after first download", isOn: $model.burnAfterRead)
        }
    }

    private func dropZone(hint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            FileDropZone(store: selection, isBusy: model.isBusy) {
                Text(hint)
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Choose Files or Folders…") { chooseFilesOrFolders(into: selection) }
        }
    }
}
