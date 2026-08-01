import Foundation

public let MANIFEST_MAX_SAFE_INTEGER = 9_007_199_254_740_991
public let MANIFEST_MAX_NAME_BYTES = 1024

public enum ManifestValidationError: Error, Equatable {
    case invalidFileCount
    case invalidName(index: Int)
    case invalidSize(index: Int)
    case totalOverflow
}

private func validateEntries(_ entries: [(name: String, size: Int, path: String?)]) throws -> Int {
    guard !entries.isEmpty, entries.count <= MAX_FILES else {
        throw ManifestValidationError.invalidFileCount
    }
    var total = 0
    for (index, entry) in entries.enumerated() {
        guard !entry.name.isEmpty, entry.name.utf8.count <= MANIFEST_MAX_NAME_BYTES,
              entry.path.map({ $0.utf8.count <= MANIFEST_MAX_NAME_BYTES }) ?? true else {
            throw ManifestValidationError.invalidName(index: index)
        }
        guard entry.size >= 0, entry.size <= MANIFEST_MAX_SAFE_INTEGER else {
            throw ManifestValidationError.invalidSize(index: index)
        }
        let (next, overflow) = total.addingReportingOverflow(entry.size)
        guard !overflow, next <= MANIFEST_MAX_SAFE_INTEGER else {
            throw ManifestValidationError.totalOverflow
        }
        total = next
    }
    return total
}

@discardableResult
public func validateManifestFiles(_ files: [ManifestFile]) throws -> Int {
    try validateEntries(files.map { ($0.name, $0.size, nil) })
}

@discardableResult
public func validateRealtimeFiles(_ files: [FileMeta]) throws -> Int {
    try validateEntries(files.map { ($0.name, $0.size, $0.path) })
}
