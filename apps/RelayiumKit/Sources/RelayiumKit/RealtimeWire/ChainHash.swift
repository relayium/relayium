import Foundation
import CryptoKit

/// Chained integrity hash: h = SHA-256(prev || chunk). Mirrors transfer.ts's
/// `chainHash`: O(1) memory, one running chain per file, verified against the
/// per-file DONE frame's `sha256` field.
public func chainHash(_ prev: [UInt8], _ chunk: [UInt8]) -> [UInt8] {
    var buf = prev
    buf.append(contentsOf: chunk)
    return Array(SHA256.hash(data: Data(buf)))
}
