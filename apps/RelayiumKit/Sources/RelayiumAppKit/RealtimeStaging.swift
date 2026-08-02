import Foundation
import RelayiumKit

public enum RealtimeStagingError: Error, Equatable {
    /// Outside 1...MAX_FILES.
    case fileCount
    /// A chosen file could not be opened or described.
    case unreadable
}

/// Turns an expanded selection into the (sources, metas) pair a realtime session
/// sends, or throws before anything is staged.
///
/// Shared by the pairing-code pane and the nearby pane: both stage the same
/// way, and the bounds this enforces — at most `MAX_FILES`, a manifest that
/// fits in one BATCH frame, every file readable and describable BEFORE a
/// connection is opened — are the kind of check that silently drifts apart when
/// it lives in two view files.
///
/// `FileMeta.path` is populated exactly as the web populates it: the leaf name
/// in `name`, the folder-relative path (including the top-level folder) in
/// `path`, and `path` omitted entirely for a file that was picked on its own.
/// See `web/src/lib/mixed-file-session.svelte.ts` — `{ name: file.name, size,
/// path }` — and `web/src/lib/drag.ts`'s `walkEntry`, which sets `path` only
/// when the relative path actually nests.
public func stageRealtimeFiles(_ files: [SelectedFile])
    throws -> (sources: [PlaintextSource], metas: [FileMeta]) {
    guard !files.isEmpty, files.count <= MAX_FILES else {
        throw RealtimeStagingError.fileCount
    }
    // Staging pins one descriptor per file for the life of the batch — that is
    // what stops the bytes on the wire from being swapped between consent and
    // transmission (see `FileURLSource`). Raise the soft limit first; whether
    // the selection actually fits is answered by the opens, not predicted.
    raiseDescriptorBudget(for: files.count)
    var sources: [PlaintextSource] = []
    var metas: [FileMeta] = []
    do {
        for file in files {
            let source = try FileURLSource(url: file.url)
            sources.append(source)
            metas.append(FileMeta(name: source.name,
                                  size: source.size,
                                  path: file.isNested ? file.relativePath : nil))
        }
        _ = try validateRealtimeFiles(metas)
    } catch let e as PlaintextSourceError {
        // Running out of descriptors is its own answer with its own remedy
        // ("send fewer at once"); flattening it into "couldn't open every file"
        // would send the user looking for a broken file that does not exist.
        throw e
    } catch {
        throw RealtimeStagingError.unreadable
    }
    // Separate from the loop's blanket `unreadable`: a manifest that does not
    // fit in one frame is a real, distinguishable answer ("too many files or
    // paths too long"), and finding it out here rather than in `batchFrame`
    // means no connection was opened to discover it.
    try validateRealtimeManifestSize(metas)
    return (sources, metas)
}

/// The cloud/stored equivalent: sources whose `name` carries the hierarchy.
///
/// The stored manifest has no `path` field — it is frozen, and its ciphertext is
/// pinned by golden vectors shared with the web and the CLI. It does not need
/// one: the Go CLI has encoded folder uploads as a forward-slash relative path
/// inside `ManifestFile.name` since `walkUploadPaths` was written, and its
/// download side reads them back with `safeJoin` + nested `MkdirAll`. Emitting
/// the same shape means native folder uploads are consumable by an unmodified
/// CLI and by the web's directory/ZIP sinks, and old flat manifests keep
/// working unchanged — a new optional field would have done neither.
public func stageCloudFiles(_ files: [SelectedFile]) throws -> [PlaintextSource] {
    guard !files.isEmpty, files.count <= MAX_FILES else {
        throw RealtimeStagingError.fileCount
    }
    raiseDescriptorBudget(for: files.count)
    do {
        return try files.map { try FileURLSource(url: $0.url, name: $0.relativePath) }
    } catch let e as PlaintextSourceError {
        throw e
    } catch {
        throw RealtimeStagingError.unreadable
    }
}
