import Foundation

/// One file's manifest entry. Mirrors transfer.ts's `FileMeta`: `path` is only
/// present for files inside a dropped folder (relative path within it).
public struct FileMeta: Codable, Equatable {
    public var name: String
    public var size: Int
    public var path: String?
    public init(name: String, size: Int, path: String? = nil) {
        self.name = name; self.size = size; self.path = path
    }
}

/// Sender side of the RealtimeWire protocol: turns a file list into a sealed
/// BATCH frame, and file bytes into sealed CHUNK/DONE frames. Byte-pinned to
/// transfer.ts's `Sender` class against `realtime-wire-vectors.json`.
public final class RealtimeSender {
    private let sessionKey: [UInt8]

    /// AES-GCM nonce counter. GLOBAL across the whole transfer: it only ever
    /// increases, so no nonce is reused under the session key. The manifest
    /// consumes seq 0; the first data chunk consumes seq 1. Mirrors
    /// transfer.ts's `Sender.seq` exactly (see its comment on why a shared
    /// monotonic counter, rather than a manifest-reserved seq, is the only
    /// safe scheme).
    private var seq: UInt32 = 0

    public init(sessionKey: [UInt8]) {
        self.sessionKey = sessionKey
    }

    /// Seals `{files:[...]}` with the session key and wraps it in a BATCH_ENC
    /// frame. Throws if the sealed manifest would exceed `MANIFEST_MAX_BYTES`
    /// (the DataChannel single-frame limit), matching transfer.ts's guard —
    /// compared against ciphertext length (plaintext + 16-byte GCM tag), not
    /// plaintext length, so a borderline manifest can't slip past the check
    /// here only to blow up on `seal`.
    public func batchFrame(_ files: [FileMeta]) throws -> [UInt8] {
        let payload = try manifestJSON(files)
        if payload.count + 16 > MANIFEST_MAX_BYTES {
            throw RealtimeSenderError.manifestTooLarge
        }
        let s = seq
        seq += 1
        return realtimeFrame(kind: RealtimeKind.batchEnc, seq: s, payload: seal(key: sessionKey, seq: UInt64(s), plaintext: payload))
    }

    /// Encrypted chunk frames for every file, each followed by its integrity
    /// (DONE) frame. Full `CHUNK_SIZE` slicing is implemented even though the
    /// golden vectors only exercise single-chunk files.
    public func dataFrames(_ files: [(meta: FileMeta, data: [UInt8])]) -> [[UInt8]] {
        var frames: [[UInt8]] = []
        for (_, data) in files {
            var hash = [UInt8](repeating: 0, count: 32)
            var offset = 0
            while offset < data.count {
                let end = min(offset + CHUNK_SIZE, data.count)
                let chunk = Array(data[offset..<end])
                hash = chainHash(hash, chunk)
                let s = seq
                seq += 1
                frames.append(realtimeFrame(kind: RealtimeKind.chunk, seq: s, payload: seal(key: sessionKey, seq: UInt64(s), plaintext: chunk)))
                offset = end
            }
            // DONE also goes through encryption, so it likewise consumes a
            // seq. It carries the whole file's SHA-256.
            let donePlaintext = Array("{\"sha256\":\"\(hash.hexEncodedString)\"}".utf8)
            let ds = seq
            seq += 1
            frames.append(realtimeFrame(kind: RealtimeKind.doneEnc, seq: ds, payload: seal(key: sessionKey, seq: UInt64(ds), plaintext: donePlaintext)))
        }
        return frames
    }
}

public enum RealtimeSenderError: Error, Equatable {
    case manifestTooLarge
}

private extension Array where Element == UInt8 {
    var hexEncodedString: String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8](); out.reserveCapacity(count * 2)
        for b in self {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0f)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}

/// Compact JSON matching JS `JSON.stringify({files:[{name,size,path?},…]})`
/// byte-for-byte: no spaces, fixed key order name/size/path, `path` omitted
/// entirely when nil, no slash escaping.
///
/// Hand-written, NOT `JSONEncoder` — see `StoredManifest.swift`'s
/// `manifestJSON` for why: `JSONEncoder` on Darwin routes keyed-container
/// output through `JSONSerialization`, whose key order is not stable across
/// calls, which breaks byte-for-byte interop with the web/CLI golden frames.
private func manifestJSON(_ files: [FileMeta]) throws -> [UInt8] {
    var out = "{\"files\":["
    for (i, f) in files.enumerated() {
        if i > 0 { out += "," }
        out += "{\"name\":\""
        out += escapeJSONString(f.name)
        out += "\",\"size\":"
        out += String(f.size)
        if let path = f.path {
            out += ",\"path\":\""
            out += escapeJSONString(path)
            out += "\""
        }
        out += "}"
    }
    out += "]}"
    return Array(out.utf8)
}

/// Escapes a string exactly like JavaScript's `JSON.stringify` does — see
/// `StoredManifest.swift`'s copy of this function for the full rationale.
private func escapeJSONString(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"":
            out.append("\\"); out.append("\"")
        case "\\":
            out.append("\\"); out.append("\\")
        case "\u{08}":
            out.append("\\"); out.append("b")
        case "\u{09}":
            out.append("\\"); out.append("t")
        case "\u{0A}":
            out.append("\\"); out.append("n")
        case "\u{0C}":
            out.append("\\"); out.append("f")
        case "\u{0D}":
            out.append("\\"); out.append("r")
        default:
            if scalar.value < 0x20 {
                let hex = String(scalar.value, radix: 16)
                out.append("\\"); out.append("u")
                for _ in 0..<(4 - hex.count) { out.append("0") }
                out.append(contentsOf: hex.unicodeScalars)
            } else {
                out.append(scalar)
            }
        }
    }
    return String(out)
}
