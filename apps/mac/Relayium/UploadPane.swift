import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

struct UploadPane: View {
    @ObservedObject var model: CloudUploadModel
    let token: String

    private let ttlLabels: [Int: String] = [
        3600: "1 hour", 86400: "1 day", 259200: "3 days",
        604800: "7 days", 1209600: "14 days",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Send files").font(.headline)
            switch model.state {
            case .idle:
                dropZone(hint: "Drag files here, or click to choose")
            case .picked(let urls):
                dropZone(hint: "\(urls.count) file\(urls.count == 1 ? "" : "s") ready")
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
                Button("Try again") { model.reset() }
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
        RoundedRectangle(cornerRadius: 10)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
            .foregroundStyle(.secondary)
            .frame(height: 110)
            .overlay(Text(hint).foregroundStyle(.secondary))
            .contentShape(Rectangle())
            .onTapGesture { chooseFiles() }
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                Task { @MainActor in
                    var urls: [URL] = []
                    for p in providers {
                        guard let item = try? await p.loadItem(forTypeIdentifier: UTType.fileURL.identifier),
                              let data = item as? Data,
                              let url = URL(dataRepresentation: data, relativeTo: nil) else { continue }
                        // Directories are out of scope this round: the manifest is
                        // a flat file list, and recursing raises collision and
                        // symlink questions that belong to their own round.
                        var isDir: ObjCBool = false
                        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
                           !isDir.boolValue {
                            urls.append(url)
                        }
                    }
                    if !urls.isEmpty { model.pick(urls) }
                }
                return true
            }
    }

    private func chooseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false      // folder recursion is out of scope
        panel.canChooseFiles = true
        if panel.runModal() == .OK { model.pick(panel.urls) }
    }
}
