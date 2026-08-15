import Foundation
import RelayiumKit

/// The batch every acceptance run offers, derived from one run tag.
///
/// **A mixed batch, not one file.** A loose file beside a two-level folder with
/// an empty leaf is what forces the receiving side to build a container, rebuild
/// nested paths inside it, and get a zero-byte file right — three behaviours a
/// single-file transfer cannot distinguish from a receiver that simply writes
/// whatever it is handed under whatever name.
///
/// **Distinct bytes per file, none of them repeating.** Every file's content is
/// derived from its own index, so a receiver that split the chunk stream one
/// byte off produces the right names and the right sizes with different digests
/// — which is exactly the failure a names-and-sizes check cannot see. A batch of
/// zero-filled files would make that failure invisible.
public enum AcceptanceBatch {

    public static func make(runTag: String) -> [(meta: FileMeta, bytes: [UInt8])] {
        let tree = "tree-\(runTag)"
        return [
            entry(name: "note-\(runTag).txt", path: nil, seed: 1, size: 74),
            entry(name: "a.bin", path: "\(tree)/day1/a.bin", seed: 2, size: 3),
            // Zero bytes, deliberately, and not last: an empty file in the
            // middle of a stream is the one a length-driven splitter skips,
            // after which every remaining file carries its neighbour's bytes
            // under its own name.
            entry(name: "empty.bin", path: "\(tree)/day1/empty/empty.bin", seed: 3, size: 0),
            entry(name: "c.bin", path: "\(tree)/day2/c.bin", seed: 4, size: 5),
            // Larger than one DataChannel message, so the run crosses at least
            // one chunk boundary rather than fitting in a single frame.
            entry(name: "bulk.bin", path: "\(tree)/day2/bulk.bin", seed: 5, size: 96_000),
        ]
    }

    private static func entry(name: String, path: String?, seed: UInt64, size: Int)
        -> (meta: FileMeta, bytes: [UInt8]) {
        let bytes = deterministicBytes(seed: seed, count: size)
        return (FileMeta(name: name, size: bytes.count, path: path), bytes)
    }

    /// A fixed 64-bit LCG rather than `Data.random`.
    ///
    /// Reproducible, so a failing run can be re-derived from its tag and its
    /// digests re-checked by hand; and non-repeating, so no two files and no two
    /// offsets inside one file carry the same bytes.
    static func deterministicBytes(seed: UInt64, count: Int) -> [UInt8] {
        var state = seed &* 0x9E37_79B9_7F4A_7C15 &+ 0x1234_5678_9ABC_DEF
        var out = [UInt8]()
        out.reserveCapacity(count)
        for _ in 0..<count {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            out.append(UInt8(truncatingIfNeeded: state >> 33))
        }
        return out
    }

    /// The receipts the SENDING side can state before anything is sent.
    public static func receipts(for batch: [(meta: FileMeta, bytes: [UInt8])]) -> [FileReceipt] {
        batch.map { FileReceipt.forSource($0.meta, bytes: $0.bytes) }
    }
}
