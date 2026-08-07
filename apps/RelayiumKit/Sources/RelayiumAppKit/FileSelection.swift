import Foundation
import RelayiumKit

/// Turning what a user picked or dropped — files, folders, or a mix — into the
/// flat, ordered file list every send path actually transmits.
///
/// One implementation, three callers (pairing code, nearby, cloud). The bound it
/// enforces is a security bound, not a convenience: MAX_FILES, the per-path byte
/// limit and the symlink policy all have to hold BEFORE a connection is opened
/// or an upload is started, and a rule that lives in three panes is a rule that
/// holds in one of them.

/// One file to send, with the relative path it will be reconstructed under.
public struct SelectedFile: Equatable {
    /// Absolute location on this device.
    public let url: URL
    /// Forward-slash path relative to the PARENT of the selected root, so a
    /// selected folder's own name survives the trip: selecting `~/Pictures/trip`
    /// yields `trip/day1/a.jpg`. A bare selected file yields just `a.jpg`.
    ///
    /// This is exactly the convention the web derives from `entry.fullPath`
    /// (`web/src/lib/drag.ts` `walkEntry`) and the Go CLI derives from
    /// `filepath.Rel(parent, p)` (`internal/cloud/transfer.go` `walkUploadPaths`).
    public let relativePath: String
    /// Size observed when the user chose the file. This is the native analogue
    /// of the browser's `File.size`: presentation and the eventual manifest use
    /// one selection snapshot, including for a real zero-byte file.
    public let byteCount: Int64?

    public init(url: URL, relativePath: String, byteCount: Int64? = nil) {
        self.url = url
        self.relativePath = relativePath
        self.byteCount = byteCount
    }

    /// The leaf name — what goes in `FileMeta.name` / a flat manifest entry.
    public var name: String {
        relativePath.split(separator: "/").last.map(String.init) ?? relativePath
    }

    /// Inside a folder, rather than picked on its own. Mirrors the web's rule
    /// (`path` is set only when the relative path actually nests).
    public var isNested: Bool { relativePath.contains("/") }
}

/// The result of expanding a selection: what will be sent, plus what could not
/// be represented at all.
public struct FileSelection: Equatable {
    public let files: [SelectedFile]
    /// Relative paths of directories that hold no files anywhere beneath them.
    ///
    /// Neither wire format has an entry for a directory — the realtime manifest
    /// and the stored manifest are both lists of files with sizes — so an empty
    /// folder cannot be sent at all. It is reported rather than silently dropped:
    /// the user chose it, and a transfer that quietly arrives without it is a
    /// transfer that lied about what it moved.
    public let emptyDirectories: [String]

    public init(files: [SelectedFile], emptyDirectories: [String]) {
        self.files = files
        self.emptyDirectories = emptyDirectories
    }

    public var isEmpty: Bool { files.isEmpty }
}

public enum FileSelectionError: Error, Equatable {
    /// Nothing selected, or every selected folder was empty.
    case noFiles
    /// More than `MAX_FILES` files beneath the selection.
    case tooManyFiles
    /// A selected item could not be read or described.
    case unreadable(String)
    /// A symbolic link was found. Neither following it (which sends a different
    /// tree, possibly from outside the selection) nor skipping it (which sends
    /// an incomplete tree without saying so) is honest, so the selection is
    /// refused and named.
    case symbolicLink(String)
    /// A relative path exceeds `MANIFEST_MAX_NAME_BYTES`.
    case pathTooLong(String)
}

/// Files beneath `roots`, in a stable deterministic order, with hierarchy kept.
///
/// Order: roots in the order the user gave them; within a directory, entries
/// sorted by their UTF-8 bytes — locale-independent on purpose, so the same tree
/// produces the same manifest on every machine and the interop fixtures stay
/// meaningful. Directories are recursed at the position they sort into, so a
/// tree's files come out in a single depth-first sequence.
///
/// Symlinks are refused, not followed and not skipped — see
/// `FileSelectionError.symbolicLink`. That also removes the cycle question
/// entirely: without symlinks there is no way to build a directory loop on APFS.
///
/// Hidden files (`.DS_Store` and friends) ARE included, matching the Go CLI's
/// `filepath.WalkDir`. Excluding them would mean the tree that arrives is not
/// the tree that was selected, which is the same silent-divergence problem the
/// symlink rule refuses.
public func expandSelection(_ roots: [URL],
                            fileManager: FileManager = .default) throws -> FileSelection {
    var files: [SelectedFile] = []
    var empties: [String] = []
    // Roots are de-duplicated by standardized path: dropping the same folder
    // twice must not send it twice (which would then collide on receive).
    var seenRoots = Set<String>()

    for root in roots {
        let standardized = root.standardizedFileURL
        guard seenRoots.insert(standardized.path).inserted else { continue }
        let name = standardized.lastPathComponent
        guard !name.isEmpty, name != "/" else {
            throw FileSelectionError.unreadable(standardized.path)
        }
        switch try classify(standardized, fileManager: fileManager) {
        case .symlink:
            throw FileSelectionError.symbolicLink(name)
        case let .file(byteCount):
            try append(SelectedFile(url: standardized, relativePath: name,
                                    byteCount: byteCount), to: &files)
        case .directory:
            let before = files.count
            try walk(standardized, prefix: name, into: &files,
                     empties: &empties, fileManager: fileManager)
            if files.count == before { empties.append(name) }
        }
    }

    guard !files.isEmpty else { throw FileSelectionError.noFiles }
    return FileSelection(files: files, emptyDirectories: empties)
}

// MARK: - internals

private enum Kind { case file(Int64), directory, symlink }

/// lstat semantics: `attributesOfItem` does NOT resolve a final symlink, which
/// is what makes the symlink refusal meaningful.
private func classify(_ url: URL, fileManager: FileManager) throws -> Kind {
    let attrs: [FileAttributeKey: Any]
    do { attrs = try fileManager.attributesOfItem(atPath: url.path) }
    catch { throw FileSelectionError.unreadable(url.lastPathComponent) }
    switch attrs[.type] as? FileAttributeType {
    case .typeSymbolicLink?: return .symlink
    case .typeDirectory?: return .directory
    case .typeRegular?:
        guard let number = attrs[.size] as? NSNumber, number.int64Value >= 0 else {
            throw FileSelectionError.unreadable(url.lastPathComponent)
        }
        return .file(number.int64Value)
    default:
        // Sockets, FIFOs, devices: not something a transfer can carry, and a
        // FIFO in particular would block the reader forever.
        throw FileSelectionError.unreadable(url.lastPathComponent)
    }
}

private func walk(_ directory: URL, prefix: String,
                  into files: inout [SelectedFile],
                  empties: inout [String],
                  fileManager: FileManager) throws {
    let children: [URL]
    do {
        children = try fileManager.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil, options: [])
    } catch {
        throw FileSelectionError.unreadable(prefix)
    }
    // Deterministic and locale-independent. `localizedStandardCompare` would
    // reorder the same tree between two machines with different locales.
    let sorted = children.sorted {
        Array($0.lastPathComponent.utf8).lexicographicallyPrecedes(Array($1.lastPathComponent.utf8))
    }
    for child in sorted {
        let name = child.lastPathComponent
        let relative = "\(prefix)/\(name)"
        switch try classify(child, fileManager: fileManager) {
        case .symlink:
            throw FileSelectionError.symbolicLink(relative)
        case let .file(byteCount):
            try append(SelectedFile(url: child, relativePath: relative,
                                    byteCount: byteCount), to: &files)
        case .directory:
            let before = files.count
            try walk(child, prefix: relative, into: &files,
                     empties: &empties, fileManager: fileManager)
            if files.count == before { empties.append(relative) }
        }
    }
}

/// The two bounds that must hold before anything is opened: the file count and
/// the per-path byte limit that `validateRealtimeFiles` /
/// `validateManifestFiles` apply on the wire.
///
/// Extracted rather than inlined because it is the half of `expandSelection` a
/// real filesystem cannot fully exercise: Darwin caps a path at `PATH_MAX`
/// (1024) and a component at 255 bytes, so a relative path long enough to trip
/// `pathTooLong` is not constructible under a temp directory — only under a very
/// short root. The rule still has to be right, so it is checked here directly.
func checkSelectionBounds(relativePath: String, countSoFar: Int) throws {
    guard relativePath.utf8.count <= MANIFEST_MAX_NAME_BYTES else {
        throw FileSelectionError.pathTooLong(relativePath)
    }
    guard countSoFar < MAX_FILES else { throw FileSelectionError.tooManyFiles }
}

/// Applies `checkSelectionBounds` as the list grows, so a pathological tree is
/// refused early rather than walked to the end first.
private func append(_ file: SelectedFile, to files: inout [SelectedFile]) throws {
    try checkSelectionBounds(relativePath: file.relativePath, countSoFar: files.count)
    files.append(file)
}
