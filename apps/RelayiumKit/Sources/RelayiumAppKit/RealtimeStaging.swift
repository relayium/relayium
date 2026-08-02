import Foundation
import RelayiumKit

public enum RealtimeStagingError: Error, Equatable {
    /// Outside 1...MAX_FILES.
    case fileCount
    /// A chosen file could not be opened or described.
    case unreadable
}

/// Turns picked file URLs into the (sources, metas) pair a realtime session
/// sends, or throws before anything is staged.
///
/// Shared by the pairing-code pane and the nearby pane: both stage the same
/// way, and the bound this enforces — at most `MAX_FILES`, every file readable
/// and describable BEFORE a connection is opened — is the kind of check that
/// silently drifts apart when it lives in two view files.
public func stageRealtimeFiles(_ urls: [URL])
    throws -> (sources: [PlaintextSource], metas: [FileMeta]) {
    guard !urls.isEmpty, urls.count <= MAX_FILES else {
        throw RealtimeStagingError.fileCount
    }
    var sources: [PlaintextSource] = []
    var metas: [FileMeta] = []
    do {
        for url in urls {
            let source = try FileURLSource(url: url)
            sources.append(source)
            metas.append(FileMeta(name: source.name, size: source.size))
        }
        _ = try validateRealtimeFiles(metas)
    } catch {
        throw RealtimeStagingError.unreadable
    }
    return (sources, metas)
}
