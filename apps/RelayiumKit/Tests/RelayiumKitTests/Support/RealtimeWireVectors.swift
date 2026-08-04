import Foundation
import XCTest
import CryptoKit
@testable import RelayiumKit

/// Reading side of the fragmentation/resume sections of
/// `realtime-wire-vectors.json`, plus the two helpers those sections are
/// expressed in.
///
/// Those sections describe multi-megabyte transfers, so they do NOT store hex.
/// A body is `(size, seed)` pinned by SHA-256, and a frame stream is
/// `(kind, seq, length)` per frame pinned by one SHA-256 over the exact
/// concatenated bytes. That is the same byte pin a hex blob would be — a wrong
/// nonce, a wrong kind byte, a re-sent chunk or a rewound seq all change the
/// digest — without putting 7 MB of hex in Git on every regeneration. See the
/// generator's comment for the full reasoning.
enum WireVectors {
    /// The generator's `content(n, seed)`: xorshift32, deliberately not
    /// all-zero, so a broken reassembly cannot pass a byte comparison.
    ///
    /// This is a port, and a port can be wrong — every caller checks the result
    /// against the fixture's SHA-256 before using it, so a divergence fails here
    /// rather than silently making a wire assertion meaningless.
    /// The middle step is `x ^= x >> 17` in JavaScript, where `>>` is the
    /// ARITHMETIC shift on the ToInt32 value — so for any `x` with its top bit
    /// set, JS shifts in ones where Swift's `UInt32 >>` shifts in zeros. The two
    /// diverge on roughly half the states, which is why this reproduces the sign
    /// extension explicitly rather than reading like the JS it came from.
    static func content(_ n: Int, seed: UInt32) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: n)
        var x: UInt32 = seed == 0 ? 1 : seed
        for i in 0..<n {
            x ^= x << 13
            x ^= UInt32(bitPattern: Int32(bitPattern: x) >> 17)
            x ^= x << 5
            out[i] = UInt8(x & 0xff)
        }
        return out
    }

    static func sha256Hex(_ bytes: [UInt8]) -> String {
        Array(SHA256.hash(data: Data(bytes))).hexString
    }
}

/// One body of a fixture scenario: regenerated locally, verified against the
/// digest the Web generator recorded.
struct WireBody {
    let size: Int
    let bytes: [UInt8]
}

/// One frame stream description from the fixture.
struct WireFrameStream {
    let count: Int
    let kinds: [UInt8]
    let seqs: [UInt32]
    let lengths: [Int]
    let streamSha256: String

    /// The load-bearing assertion: `frames` must BE the bytes the Web sender
    /// produced. Structure is checked first so a failure names what diverged
    /// before the digest reports only that something did.
    func assertMatches(_ frames: [[UInt8]], _ label: String,
                       file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(frames.count, count, "\(label): frame count", file: file, line: line)
        XCTAssertEqual(frames.map { $0[0] }, kinds, "\(label): frame kinds", file: file, line: line)
        XCTAssertEqual(frames.map { seqOf($0) }, seqs, "\(label): frame seqs", file: file, line: line)
        XCTAssertEqual(frames.map(\.count), lengths, "\(label): frame lengths", file: file, line: line)
        XCTAssertEqual(WireVectors.sha256Hex(frames.flatMap { $0 }), streamSha256,
                       "\(label): concatenated frame bytes differ from the Web-generated stream",
                       file: file, line: line)
    }

    private func seqOf(_ f: [UInt8]) -> UInt32 {
        (UInt32(f[1]) << 24) | (UInt32(f[2]) << 16) | (UInt32(f[3]) << 8) | UInt32(f[4])
    }
}

extension Vectors {
    /// Dot-path lookup returning a JSON object.
    func dict(_ path: String) -> [String: Any] {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return node as! [String: Any]
    }

    /// Dot-path lookup returning a JSON array of objects.
    func objects(_ path: String) -> [[String: Any]] {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return (node as! [Any]).map { $0 as! [String: Any] }
    }

    /// Dot-path lookup returning decoded hex bytes for each element.
    func hexArray(_ path: String) -> [[UInt8]] { strArray(path).map(\.hexBytes) }

    /// `{files:[{name,size,path?}]}` under any path.
    func fileMetas(_ path: String) -> [FileMeta] {
        (dict(path)["files"] as! [Any]).map { e in
            let d = e as! [String: Any]
            return FileMeta(name: d["name"] as! String, size: d["size"] as! Int, path: d["path"] as? String)
        }
    }

    /// A `(size, seed, sha256)` body, regenerated and digest-checked.
    func body(_ path: String, file: StaticString = #filePath, line: UInt = #line) -> WireBody {
        bodyFrom(dict(path), file: file, line: line)
    }

    func bodies(_ path: String, file: StaticString = #filePath, line: UInt = #line) -> [WireBody] {
        objects(path).map { bodyFrom($0, file: file, line: line) }
    }

    private func bodyFrom(_ d: [String: Any], file: StaticString, line: UInt) -> WireBody {
        let size = d["size"] as! Int
        let bytes = WireVectors.content(size, seed: UInt32(d["seed"] as! Int))
        if let want = d["sha256"] as? String {
            XCTAssertEqual(WireVectors.sha256Hex(bytes), want,
                           "the Swift port of the generator's xorshift content() diverged",
                           file: file, line: line)
        }
        return WireBody(size: size, bytes: bytes)
    }

    func frameStream(_ path: String) -> WireFrameStream { frameStreamFrom(dict(path)) }

    func frameStreamFrom(_ d: [String: Any]) -> WireFrameStream {
        let frames = (d["frames"] as! [Any]).map { $0 as! [String: Any] }
        return WireFrameStream(
            count: d["count"] as! Int,
            kinds: frames.map { UInt8($0["kind"] as! Int) },
            seqs: frames.map { UInt32($0["seq"] as! Int) },
            lengths: frames.map { $0["length"] as! Int },
            streamSha256: d["streamSha256"] as! String
        )
    }

    /// A `{index, offset}` (optionally `seq`) point.
    func point(_ path: String) -> ResumePoint {
        pointFrom(dict(path))
    }

    func pointFrom(_ d: [String: Any]) -> ResumePoint {
        ResumePoint(index: d["index"] as! Int, offset: d["offset"] as! Int)
    }
}
