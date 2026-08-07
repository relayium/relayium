import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// The concrete answer to “what am I about to send?”. The summary above this
/// view answers how much; this bounded list preserves every name and size
/// without letting a thousand-file folder consume the whole window.
struct PendingFileList: View {
    let files: [SelectedFile]

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
                            if let bytes = file.byteCount {
                                Text(L10n.bytes(bytes))
                                    .foregroundStyle(.secondary)
                                    .fixedSize()
                            }
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

    private func displayName(_ file: SelectedFile) -> String {
        let safe = safeDisplayName(file.relativePath)
        return safe.isEmpty ? "download" : safe
    }
}
