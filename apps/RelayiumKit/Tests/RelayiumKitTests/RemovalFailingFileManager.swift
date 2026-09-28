import Foundation

/// A `FileManager` whose `removeItem` throws, once per armed path, the way a
/// real I/O failure would. Everything else is the default manager.
/// Shared by the protected-root and shared-root key-hygiene tests.
final class RemovalFailingFileManager: FileManager, @unchecked Sendable {
    private let lock = NSLock()
    private var armed: [String: Int] = [:]
    private(set) var failures = 0

    func failNextRemoval(of url: URL, times: Int = 1) {
        lock.lock(); defer { lock.unlock() }
        armed[url.standardizedFileURL.path, default: 0] += times
    }

    override func removeItem(at url: URL) throws {
        lock.lock()
        let key = url.standardizedFileURL.path
        if let n = armed[key], n > 0 {
            armed[key] = n - 1
            failures += 1
            lock.unlock()
            throw CocoaError(.fileWriteUnknown)
        }
        lock.unlock()
        try super.removeItem(at: url)
    }
}
