import Foundation

/// A plaintext byte source read strictly forward. Files are read through this
/// rather than loaded, which is the difference between a bounded upload and a
/// file-sized one.
public protocol PlaintextSource {
    var name: String { get }
    var size: Int { get }
    /// Returns up to `max` bytes, or fewer at end of input. Empty means done.
    mutating func read(_ max: Int) throws -> [UInt8]
}

public struct DataSource: PlaintextSource {
    public let name: String
    private let bytes: [UInt8]
    private var off = 0
    public var size: Int { bytes.count }
    public init(name: String, bytes: [UInt8]) { self.name = name; self.bytes = bytes }
    public mutating func read(_ max: Int) throws -> [UInt8] {
        guard off < bytes.count else { return [] }
        let end = min(off + max, bytes.count)
        defer { off = end }
        return Array(bytes[off..<end])
    }
}

public struct FileURLSource: PlaintextSource {
    public let name: String
    public let size: Int
    private let handle: FileHandle

    public init(url: URL) throws {
        self.name = url.lastPathComponent
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        self.size = (attrs[.size] as? Int) ?? 0
        self.handle = try FileHandle(forReadingFrom: url)
    }

    public mutating func read(_ max: Int) throws -> [UInt8] {
        guard let d = try handle.read(upToCount: max) else { return [] }
        return [UInt8](d)
    }
}

/// Yields the same framed ciphertext stream as `encryptChunks`, one frame at a
/// time. `seq` is global across files and starts at 1, because 0 is the
/// manifest — the same rule the batch encoder and the web both follow.
public final class ChunkEncryptor {
    private let key: [UInt8]
    private var sources: [PlaintextSource]
    private var index = 0
    private var seq: UInt64 = 1

    public init(key: [UInt8], sources: [PlaintextSource]) {
        self.key = key
        self.sources = sources
    }

    /// The next frame, or nil once every source is exhausted.
    public func next() throws -> [UInt8]? {
        while index < sources.count {
            let pt = try sources[index].read(STORE_CHUNK_SIZE)
            if pt.isEmpty { index += 1; continue }
            let f = frame(seal(key: key, seq: seq, plaintext: pt))
            seq += 1
            return f
        }
        return nil
    }
}
