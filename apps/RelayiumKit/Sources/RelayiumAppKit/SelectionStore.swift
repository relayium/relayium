import Foundation
import RelayiumKit

/// Decode one `NSItemProvider` payload into a file URL.
///
/// `loadItem(forTypeIdentifier: "public.file-url")` does not promise a
/// representation. Depending on the source app and the OS version it hands back
/// `Data` (a bookmark-free URL byte encoding), a bridged `URL`/`NSURL`, or a
/// URL *string*. The drop zone used to accept only `Data` and drop everything
/// else on the floor — a drag from an app that vends `NSURL` simply did nothing,
/// with no error and nothing staged, which reads as "the app ignored me".
///
/// Lives here rather than in the SwiftUI file so it can be tested under `swift
/// test` without AppKit or a live drag.
///
/// Non-file URLs are rejected: dragging a link out of a browser must not become
/// a file send. So is a bare POSIX path string — `public.file-url` means a URL,
/// and treating an arbitrary string as a path would accept something no drop
/// source actually promised.
public func droppedFileURL(from item: Any?) -> URL? {
    let decoded: URL?
    switch item {
    case let value as URL:
        decoded = value
    case let value as NSURL:
        decoded = value as URL
    case let value as Data:
        decoded = URL(dataRepresentation: value, relativeTo: nil)
    case let value as NSData:
        decoded = URL(dataRepresentation: value as Data, relativeTo: nil)
    case let value as String:
        decoded = URL(string: value)
    case let value as NSString:
        decoded = URL(string: value as String)
    default:
        decoded = nil
    }
    guard let url = decoded, url.isFileURL, !url.path.isEmpty else { return nil }
    // Rebuilt from the path so every representation of the same item yields the
    // same value. A directory dragged as `NSURL` arrives with a trailing slash
    // and the same directory dragged as `Data` does not, and this is a
    // de-duplication key — two spellings of one folder must not both be staged.
    // Nothing is lost: whether the item is a directory is read from disk, never
    // from the URL's own hint.
    return URL(fileURLWithPath: url.path).standardizedFileURL
}

/// What the user has chosen to send, and everything the panes need to render
/// about it.
///
/// Three panes used to keep their own `@State private var picked: [URL]` and
/// their own idea of what a picker or a drop meant. This is that state, once,
/// with the decisions in a type `swift test` can reach — the views are left with
/// nothing to decide beyond which button to draw.
@MainActor
public final class SelectionStore: ObservableObject {
    /// Roots exactly as chosen, in the order chosen. Kept so the pane can show
    /// them and so a re-expansion (after a drop appends) starts from the truth.
    @Published public private(set) var roots: [URL] = []
    /// The expanded file list, computed once per change rather than again at
    /// send time — the send path then only has to open what is already listed.
    @Published public private(set) var selection: FileSelection?
    /// Copy for the last failed expansion, already run through `ErrorCopy`.
    @Published public private(set) var error: String?
    /// Bumped once per change, so a view can react to "the selection is
    /// different now" without comparing file lists — two different selections
    /// can have the same count, and a view that watched the count would miss it.
    @Published public private(set) var revision = 0

    private let expand: ([URL]) throws -> FileSelection

    public init(expand: @escaping ([URL]) throws -> FileSelection = { try expandSelection($0) }) {
        self.expand = expand
    }

    public var isEmpty: Bool { selection?.files.isEmpty ?? true }
    public var fileCount: Int { selection?.files.count ?? 0 }
    public var folderCount: Int {
        guard let selection else { return 0 }
        return Set(selection.files.compactMap { file -> String? in
            guard file.isNested else { return nil }
            return file.relativePath.split(separator: "/").first.map(String.init)
        }).count
    }

    /// One line describing the selection, or nil when nothing is chosen.
    ///
    /// Includes the empty-folder count when there is one. That is the truthful
    /// half of "folders are supported now": a folder with nothing in it cannot
    /// be represented by either wire format, and a user who selected one has to
    /// be told before they send, not left to discover a missing folder later.
    public var summary: String? {
        guard let selection, !selection.files.isEmpty else { return nil }
        let n = selection.files.count
        var text = "\(n) file\(n == 1 ? "" : "s") ready"
        let folders = folderCount
        if folders > 0 { text += " in \(folders) folder\(folders == 1 ? "" : "s")" }
        let skipped = selection.emptyDirectories.count
        if skipped > 0 {
            text += " · \(skipped) empty folder\(skipped == 1 ? "" : "s") can't be sent"
        }
        return text
    }

    /// A picker result replaces the selection, because that is what the panel
    /// showed the user: everything they had highlighted when they pressed Open.
    public func replace(with urls: [URL]) {
        roots = urls
        reload()
    }

    /// A drop APPENDS, because a drop zone that silently discarded what was
    /// already staged would lose a folder the user dropped ten seconds earlier
    /// with no way to notice. Duplicate roots are dropped by
    /// `expandSelection`, so dropping the same folder twice is a no-op rather
    /// than a guaranteed duplicate-path refusal on the far side.
    public func add(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        // De-duplicated against what is already staged AND within the incoming
        // batch: one drag can carry the same item more than once, and filtering
        // only against `roots` would let the duplicates in together and leave
        // the pane counting a folder twice.
        var seen = Set(roots.map(\.standardizedFileURL.path))
        for url in urls where seen.insert(url.standardizedFileURL.path).inserted {
            roots.append(url)
        }
        reload()
    }

    public func clear() {
        roots = []
        selection = nil
        error = nil
        revision += 1
    }

    private func reload() {
        defer { revision += 1 }
        guard !roots.isEmpty else {
            selection = nil
            error = nil
            return
        }
        do {
            selection = try expand(roots)
            error = nil
        } catch {
            // The roots are kept. The user can see what they chose and remove
            // the offending item rather than starting over.
            selection = nil
            self.error = ErrorCopy.message(for: error)
        }
    }
}
