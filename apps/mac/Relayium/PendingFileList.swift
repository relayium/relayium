import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// The concrete answer to “what am I about to send?”. The summary above this
/// view answers how much; this bounded list preserves every name and size
/// without letting a thousand-file folder consume the whole window.
struct PendingFileList: View {
    private let files: [FileMeta]

    init(files: [SelectedFile]) {
        self.files = files.map {
            FileMeta(name: $0.name, size: Int(max($0.byteCount ?? 0, 0)),
                     path: $0.isNested ? $0.relativePath : nil)
        }
    }

    init(sessionFiles: [FileMeta]) {
        files = sessionFiles
    }

    var body: some View {
        if !files.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(displayName(file))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                            Text(L10n.bytes(Int64(file.size)))
                                .foregroundStyle(.secondary)
                                .fixedSize()
                        }
                        .font(.caption)
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(10)
            }
            .frame(maxHeight: 200)
            .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .contain)
        }
    }

    private func displayName(_ file: FileMeta) -> String {
        let safe = safeDisplayName(file.path ?? file.name)
        return safe.isEmpty ? "download" : safe
    }
}
