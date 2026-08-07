import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// Every file the current selection will send, kept in a bounded nested scroll
/// so a large folder remains inspectable without pushing the Send action away.
struct PendingFileList: View {
    let files: [SelectedFile]

    var body: some View {
        if !files.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(displayName(file))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                            if let bytes = file.byteCount {
                                Text(L10n.bytes(bytes))
                                    .foregroundStyle(.secondary)
                                    .fixedSize()
                            }
                        }
                        .font(.footnote)
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(12)
            }
            .frame(maxHeight: 220)
            .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .contain)
        }
    }

    private func displayName(_ file: SelectedFile) -> String {
        let safe = safeDisplayName(file.relativePath)
        return safe.isEmpty ? "download" : safe
    }
}
