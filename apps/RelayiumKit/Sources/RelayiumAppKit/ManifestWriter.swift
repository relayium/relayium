import Foundation
import RelayiumKit

/// Where received files land on disk, shared by both transports.
///
/// The cloud download and the realtime receive have the identical problem:
/// chunks arrive with no file boundaries, the manifest's sizes are the only
/// thing that splits them, and the names come from the other side. Two copies of
/// that would be two path-traversal boundaries, and drift would eventually leave
/// the bug in only one of them.

public enum DownloadDestinationError: Error, Equatable {
    case directoryExists(name: String)
    case unsafeName(String)
}

/// One entry of an incoming transfer, in the only two fields the writer needs.
/// Neither transport's manifest type leaks into the other through this.
public struct WritableFile: Equatable {
    public let name: String
    public let size: Int
    public init(name: String, size: Int) { self.name = name; self.size = size }
}

/// A multi-file transfer gets its own directory so it cannot scatter into an
/// existing folder or overwrite by name collision. An existing directory is
/// refused rather than merged: we cannot tell a leftover partial download from
/// files the user put there.
public func destinationDirectory(parent: URL, id: String) throws -> URL {
    let dir = parent.appendingPathComponent("relayium-\(id)")
    if FileManager.default.fileExists(atPath: dir.path) {
        throw DownloadDestinationError.directoryExists(name: dir.lastPathComponent)
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
    return dir
}

/// Reduce a manifest name to a single path component.
///
/// `sanitizeNames` handles the characters — bidi and C0/C1 controls — and is
/// documented as a *display* sanitizer that deliberately does not do path
/// safety ("add per-segment path sanitize here if StoredManifest gains a path
/// field"). The manifest is attacker-controlled and this is the side that joins
/// it onto a real path, so the path reduction belongs here rather than as a
/// second copy of the character rules.
func safePathComponent(_ name: String) -> String {
    let last = name.split(separator: "/").last.map(String.init) ?? ""
    if last.isEmpty || last == "." || last == ".." { return "unnamed" }
    return last
}

/// Splits an incoming chunk stream back into the manifest's files. Chunks do
/// not carry file boundaries; the manifest's sizes are the only thing that does.
final class ManifestWriter {
    private let directory: URL
    private let files: [ManifestFile]
    private var index = 0
    private var writtenInCurrent = 0
    private var handle: FileHandle?
    private(set) var urls: [URL] = []

    init(directory: URL, files: [WritableFile]) throws {
        self.directory = directory
        self.files = sanitizeNames(files.map { ManifestFile(name: $0.name, size: $0.size) })
        try openCurrent()
    }

    convenience init(directory: URL, manifest: StoredManifest) throws {
        try self.init(directory: directory,
                      files: manifest.files.map { WritableFile(name: $0.name, size: $0.size) })
    }

    private func openCurrent() throws {
        // Zero-length files still get created: they are in the manifest, so
        // their absence would read as a failed download.
        while index < files.count {
            let url = directory.appendingPathComponent(safePathComponent(files[index].name))
            // Defence in depth: after reduction the file must sit directly in the
            // destination. If it does not, refuse rather than write anywhere else.
            guard url.deletingLastPathComponent().standardized.path == directory.standardized.path else {
                throw DownloadDestinationError.unsafeName(files[index].name)
            }
            FileManager.default.createFile(atPath: url.path, contents: nil)
            urls.append(url)
            writtenInCurrent = 0
            if files[index].size > 0 {
                handle = try FileHandle(forWritingTo: url)
                return
            }
            index += 1        // empty file: created, nothing to write, move on
        }
        handle = nil
    }

    func write(_ bytes: [UInt8]) throws {
        var off = 0
        while off < bytes.count, index < files.count {
            let remaining = files[index].size - writtenInCurrent
            let take = min(remaining, bytes.count - off)
            if take > 0 {
                try handle?.write(contentsOf: Data(bytes[off..<(off + take)]))
                writtenInCurrent += take
                off += take
            }
            if writtenInCurrent >= files[index].size {
                try handle?.close()
                handle = nil
                index += 1
                try openCurrent()
            }
        }
    }

    func finish() throws -> [URL] {
        try handle?.close()
        handle = nil
        return urls
    }

    func discard() {
        try? handle?.close()
        handle = nil
        for u in urls { try? FileManager.default.removeItem(at: u) }
        urls = []
    }
}
