import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit

/// The one drop target and the one file picker the app has.
///
/// Every send surface used to grow its own: the cloud pane had a drop zone that
/// filtered directories out, and the two realtime panes had a picker with
/// `canChooseDirectories = false` and no drop at all. Three implementations of
/// "what may a user hand us" is three places for the folder rule, the busy rule
/// and the append rule to be different.
///
/// Sandbox note: the URLs that arrive here — from `NSOpenPanel` or from a drag
/// pasteboard — are issued a sandbox extension by the OS when the user hands
/// them over, and that extension lasts for the life of this process. That is why
/// staging can enumerate a folder now and open its files afterwards.
/// `startAccessingSecurityScopedResource` is for URLs restored from a
/// security-scoped BOOKMARK, which this app does not use; calling it here would
/// return false and prove nothing.
///
/// Readability is not merely checked, it is HELD: `FileURLSource` opens each
/// selected file when the batch is staged and keeps that descriptor until the
/// batch is released, reading through it rather than reopening the path. So a
/// selection this Mac cannot read fails before a connection is opened, and the
/// bytes that go out are the ones the user approved even if the paths are
/// rearranged while the transfer waits for a peer.
struct FileDropZone<Label: View>: View {
    /// Where the drop lands. Appends, so a second drop adds to the selection.
    let store: SelectionStore
    /// Drops and clicks are ignored while a transfer owns the selection. The
    /// zone still renders — a target that vanishes mid-drag is worse than one
    /// that declines.
    /// A live read rather than the value from the render that accepted a drop.
    /// Resolving item providers is asynchronous; a transfer may start before
    /// their URLs return.
    let isBusy: () -> Bool
    @ViewBuilder let label: () -> Label

    @State private var isTargeted = false

    var body: some View {
        RoundedRectangle(cornerRadius: 10)
            .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
            .foregroundStyle(isTargeted && !isBusy() ? Color.accentColor : Color.secondary)
            .frame(minHeight: 96)
            .overlay(label().padding(8))
            .contentShape(Rectangle())
            .onTapGesture { if !isBusy() { chooseFilesOrFolders(into: store) } }
            .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
                guard !isBusy() else { return false }
                Task { @MainActor in
                    let urls = await droppedFileURLs(providers)
                    // The drop was admitted before the provider load. Recheck
                    // after that suspension so a session started in between
                    // cannot mutate the selection it now owns.
                    guard !isBusy() else { return }
                    // Staging only. A drop must never start a transfer by
                    // itself: on the nearby pane the peer is chosen separately,
                    // and a drop that dialled whoever happened to be selected is
                    // how files go to the wrong device.
                    store.add(urls)
                }
                return true
            }
            .accessibilityLabel(L10n.t(.dropA11yLabel))
            .accessibilityHint(L10n.t(.dropA11yHint))
    }
}

/// Resolve a drag's providers to file URLs, in the order they were dropped.
///
/// Order matters because it becomes manifest order, and a set of promises
/// resolved concurrently would produce a different manifest for the same drop
/// each time.
/// The decoding itself is `droppedFileURL(from:)` in RelayiumAppKit, which
/// accepts every representation `public.file-url` is actually vended as —
/// `Data`, `URL`, `NSURL`, a URL string — and is unit-tested there. This
/// function is only the async plumbing around it.
@MainActor
func droppedFileURLs(_ providers: [NSItemProvider]) async -> [URL] {
    var urls: [URL] = []
    for provider in providers {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier)
        guard let url = droppedFileURL(from: item) else { continue }
        urls.append(url)
    }
    return urls
}

/// The picker, in the only configuration the app uses: files AND folders, any
/// number of them.
@MainActor
func chooseFilesOrFolders(into store: SelectionStore) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseFiles = true
    panel.canChooseDirectories = true
    panel.prompt = L10n.t(.pickerPrompt)
    // A picker REPLACES: what the panel showed when the user pressed Choose is
    // exactly what they meant to send. A drop appends, because there is no such
    // moment of confirmation for a drag.
    if panel.runModal() == .OK { store.replace(with: panel.urls) }
}
