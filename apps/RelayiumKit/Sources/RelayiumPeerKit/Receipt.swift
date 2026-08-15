import CryptoKit
import Foundation
import RelayiumKit

/// What actually landed, in the only three terms that can distinguish a real
/// transfer from a plausible one: the name, the byte count, and the digest.
///
/// **The digest is the point.** A receipt of names and sizes passes for a
/// receiver that wrote the right number of zero bytes into the right number of
/// files, and passes for one that split a multi-file stream one byte off in a
/// way that happens to preserve every length. A per-file SHA-256 compared
/// against the sender's own digest of the bytes it read does not.
public struct FileReceipt: Codable, Equatable, Sendable {
    /// The manifest name, as it arrived.
    public var name: String
    /// The manifest path, for a batch that carries a folder. Nil is a loose
    /// file, and the two are not interchangeable: a receiver that flattened a
    /// tree would otherwise produce an identical receipt.
    public var path: String?
    public var size: Int
    /// Lowercase hex, so it can be compared against `shasum -a 256` output by a
    /// person reading a log without decoding anything.
    public var sha256: String

    public init(name: String, path: String? = nil, size: Int, sha256: String) {
        self.name = name
        self.path = path
        self.size = size
        self.sha256 = sha256
    }
}

public func sha256Hex(_ bytes: [UInt8]) -> String {
    SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
}

public func sha256Hex(contentsOf url: URL) -> String? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

extension FileReceipt {
    /// The receipt a SENDER can write, from the bytes it is about to hand over.
    ///
    /// Produced from the same array the `DataSource` reads, so the comparison at
    /// the end is between two independent walks of the same intent rather than
    /// one value copied into two places.
    public static func forSource(_ meta: FileMeta, bytes: [UInt8]) -> FileReceipt {
        FileReceipt(name: meta.name, path: meta.path,
                    size: bytes.count, sha256: sha256Hex(bytes))
    }
}

/// Splits one manifest plus one flat chunk stream back into per-file receipts.
///
/// `RealtimeConnection.onFileChunk` delivers the batch as an undifferentiated
/// byte stream, and the boundaries live in the manifest that preceded it. Both
/// existing harnesses side-stepped this — `RealtimeE2E` compares one file's
/// worth of bytes, and `NearbyReceiveE2E` lets the app's own writer do the
/// splitting and then reads the files back off disk. A plain peer that has to
/// report per-file digests needs the split itself, and it is exactly the place
/// an off-by-one hides: every length still adds up, every name is still right,
/// and only the digests move.
public struct BatchAccumulator {
    private var metas: [FileMeta] = []
    private var buffer: [UInt8] = []
    private var complete: [FileReceipt] = []

    public init() {}

    public var expectedFiles: [FileMeta] { metas }
    public var receipts: [FileReceipt] { complete }
    /// Bytes that arrived past the end of the last declared file. Always zero
    /// for a correct sender, and reported rather than discarded: a stream that
    /// overruns its own manifest is a defect, not a rounding error.
    public var trailingBytes: Int { buffer.count }

    public mutating func expect(_ files: [FileMeta]) {
        metas = files
    }

    public mutating func append(_ chunk: [UInt8]) {
        buffer += chunk
        drain()
    }

    /// Closes out every file whose bytes are already present. A zero-byte file
    /// is completed here too, which is why the loop is a `while` over a
    /// condition rather than a check that the buffer is non-empty: an empty
    /// leading file would otherwise never be emitted and every later file would
    /// be attributed to the wrong name.
    private mutating func drain() {
        while complete.count < metas.count {
            let meta = metas[complete.count]
            guard buffer.count >= meta.size else { return }
            let bytes = Array(buffer.prefix(meta.size))
            buffer.removeFirst(meta.size)
            complete.append(FileReceipt(name: meta.name, path: meta.path,
                                        size: bytes.count, sha256: sha256Hex(bytes)))
        }
    }

    /// Whether every declared file arrived and nothing arrived past them.
    public var isSatisfied: Bool {
        complete.count == metas.count && buffer.isEmpty && !metas.isEmpty
    }
}
