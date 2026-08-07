import SwiftUI
import RelayiumAppKit

/// What a finished transfer offers: reveal, system share, and drag out.
///
/// Shared by the realtime session view and the cloud download pane so "the
/// transfer is over, here is what you got" looks and behaves the same however
/// the bytes arrived.
///
/// Drag-out is a real file promise, not a preview: each row's item provider is
/// built with `NSItemProvider(contentsOf:)` over a URL that exists and is closed
/// — `receivedPayload` is only ever built from a writer that has already
/// returned from `finish()`. Finder, Mail and every other `public.file-url`
/// consumer therefore get a complete file (or, for a folder transfer, the one
/// directory that holds the whole tree, so the hierarchy survives the drag).
struct ReceivedResultView: View {
    let payload: ReceivedPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(payload.dragURLs, id: \.self) { url in
                HStack(spacing: 6) {
                    Image(systemName: isDirectory(url) ? "folder" : "doc")
                        .foregroundStyle(.secondary)
                    Text(url.lastPathComponent)
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .contentShape(Rectangle())
                .onDrag { NSItemProvider(contentsOf: url) ?? NSItemProvider() }
                .accessibilityLabel(url.lastPathComponent)
                .accessibilityHint(L10n.t(.receivedA11yDragHint))
            }
            HStack {
                Button(L10n.t(.receivedRevealInFinder)) {
                    NSWorkspace.shared.activateFileViewerSelecting(payload.revealURLs)
                }
                ShareLink(items: payload.dragURLs) {
                    Label(L10n.t(.commonShare), systemImage: "square.and.arrow.up")
                }
            }
            .buttonStyle(.bordered)
            Text(L10n.t(.receivedDragHint))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
    }
}
