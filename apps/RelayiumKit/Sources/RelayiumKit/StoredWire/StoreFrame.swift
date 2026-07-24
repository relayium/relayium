import Foundation

public let STORE_CHUNK_SIZE = 192 * 1024
public let FRAME_OVERHEAD = 4 + 16
public let MAX_FRAME_CT = 192 * 1024 + 16 + 256

private func u32be(_ n: Int) -> [UInt8] {
    [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
}
private func readU32be(_ b: [UInt8], _ off: Int) -> Int {
    (Int(b[off]) << 24) | (Int(b[off+1]) << 16) | (Int(b[off+2]) << 8) | Int(b[off+3])
}

/// length-prefixed frame: uint32BE(len(ct)) || ct.
public func frame(_ ct: [UInt8]) -> [UInt8] { u32be(ct.count) + ct }

/// Σ size + FRAME_OVERHEAD * ceil(size / STORE_CHUNK_SIZE), per file.
public func cipherSizeFor(_ sizes: [Int]) -> Int {
    sizes.reduce(0) { $0 + $1 + FRAME_OVERHEAD * Int(ceil(Double($1) / Double(STORE_CHUNK_SIZE))) }
}

/// Encrypt every file's chunks as framed AES-GCM frames; seq is global across
/// files starting at 1 (0 is the manifest). No separator between files.
public func encryptChunks(key: [UInt8], files: [[UInt8]]) -> [UInt8] {
    var out: [UInt8] = []; var seq: UInt64 = 1
    for file in files {
        var off = 0
        // A zero-length file yields no frames (matches the web: the off<size loop
        // never runs), so an empty file contributes nothing to the stream.
        while off < file.count {
            let end = min(off + STORE_CHUNK_SIZE, file.count)
            out += frame(seal(key: key, seq: seq, plaintext: Array(file[off..<end])))
            seq += 1; off = end
        }
    }
    return out
}

/// Reassembles length-prefixed frames across arbitrary byte-stream boundaries and
/// returns decrypted plaintext chunks in order. Throws on tamper/oversize.
public final class StoreDecryptor {
    private let key: [UInt8]
    private var seq: UInt64 = 1
    private var buf: [UInt8] = []
    public private(set) var decryptedBytes: Int = 0
    public init(key: [UInt8]) { self.key = key }

    public func push(_ data: [UInt8]) throws -> [[UInt8]] {
        buf += data
        var out: [[UInt8]] = []
        var off = 0
        while off + 4 <= buf.count {
            let len = readU32be(buf, off)
            if len > MAX_FRAME_CT { throw StoredWireError.frameTooLarge }
            if off + 4 + len > buf.count { break }              // frame incomplete
            let ct = Array(buf[(off+4)..<(off+4+len)])
            guard let pt = open(key: key, seq: seq, ciphertext: ct) else {
                throw StoredWireError.truncatedStream            // auth failure = tamper
            }
            seq += 1; off += 4 + len; decryptedBytes += pt.count
            out.append(pt)
        }
        buf = off < buf.count ? Array(buf[off...]) : []
        return out
    }

    /// Reject a dangling partial frame; when an expected total is known, assert it
    /// matches (a stream truncated on a frame boundary is otherwise a clean end).
    public func end(expectedBytes: Int?) throws {
        if !buf.isEmpty { throw StoredWireError.truncatedStream }
        if let e = expectedBytes, decryptedBytes != e { throw StoredWireError.lengthMismatch }
    }
}
