import Foundation

/// One file's manifest entry. Mirrors transfer.ts's `FileMeta`: `path` is only
/// present for files inside a dropped folder (relative path within it).
///
/// `Sendable` because it is one: three value-type fields and no reference among
/// them. It rides inside lane and session effects, which a driver may carry
/// across queues, and without the conformance those effect types could not be
/// `Sendable` either.
public struct FileMeta: Codable, Equatable, Sendable {
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
    /// Set once the last usable value has been handed out. The counter is 32 bits
    /// on the wire: wrapping it would reuse a nonce under a key that is still
    /// live, and `seq += 1` past `UInt32.max` traps. Neither is acceptable, so
    /// exhaustion is a refusal — see `reserveSequence`.
    private var sequenceExhausted = false

    public init(sessionKey: [UInt8]) {
        self.sessionKey = sessionKey
    }

    /// Test-only entry point for the wrap boundary and for resumed-batch fixtures
    /// that start from a non-zero counter.
    ///
    /// Internal, and it must stay internal: production continues a transfer by
    /// keeping the SAME sender instance alive across a rebuilt transport. A
    /// second sender constructed under the same session key is a nonce rewind —
    /// a break of the encryption rather than a bug in it — and this initializer
    /// is the only shape in which that mistake would compile.
    init(sessionKey: [UInt8], startingSequence: UInt32) {
        self.sessionKey = sessionKey
        self.seq = startingSequence
    }

    /// The nonce the next protected frame will carry. A resumed stream announces
    /// it, and tests assert it never moves backwards.
    public var nextSequence: UInt32 { seq }

    /// Reserve the next nonce, or fail closed.
    ///
    /// Reserved **before** the frame it belongs to is built, let alone exposed:
    /// an abandoned or failed emission must leave the counter past everything it
    /// produced, because the alternative — reclaiming the value — is exactly how
    /// a nonce gets used twice.
    private func reserveSequence() throws -> UInt32 {
        guard !sequenceExhausted else { throw RealtimeSenderError.sequenceExhausted }
        let s = seq
        if s == UInt32.max {
            sequenceExhausted = true   // s itself is still usable; nothing after it is
        } else {
            seq = s + 1
        }
        return s
    }

    /// Seals `{files:[...]}` with the session key and wraps it in a BATCH_ENC
    /// frame. Throws if the sealed manifest would exceed `MANIFEST_MAX_BYTES`
    /// (the DataChannel single-frame limit), matching transfer.ts's guard —
    /// compared against ciphertext length (plaintext + 16-byte GCM tag), not
    /// plaintext length, so a borderline manifest can't slip past the check
    /// here only to blow up on `seal`.
    ///
    /// Deliberately still ONE frame, never fragmented. `MANIFEST_MAX_BYTES`
    /// (200 KiB) is larger than `CHUNK_SIZE` (192 KiB), so routing this through
    /// `batchFrames` at the default allowance would start refusing manifests
    /// between the two — legal folder sends that this call has always carried.
    /// Callers that know their connection's real ceiling use `batchFrames`.
    public func batchFrame(_ files: [FileMeta]) throws -> [UInt8] {
        try piece(try validatedManifestPayload(files), kind: RealtimeKind.batchEnc)
    }

    /// The sealed manifest, fragmented to whatever this connection can carry.
    ///
    /// It **consumes a seq per frame** (sharing the one monotonic counter with
    /// the data chunks), so the first data chunk starts after it. A shared
    /// counter is the only safe scheme here: any "reserve a special seq for the
    /// manifest" arrangement needs a separate guarantee that the reserved value
    /// is never reached by a chunk, and a resume continues the counter from an
    /// arbitrary point — one more invariant is one more place a nonce can
    /// quietly be used twice.
    public func batchFrames(_ files: [FileMeta],
                            maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES) throws -> [[UInt8]] {
        let payload = try validatedManifestPayload(files)
        // Before any nonce is reserved: a connection too small to transfer over
        // must not leave a hole in the sequence behind it.
        let pieceBytes = try piecePlainBytes(maxFrameBytes: maxFrameBytes)
        return try pieces(payload, pieceBytes: pieceBytes,
                          partKind: RealtimeKind.batchPart, finalKind: RealtimeKind.batchEnc)
    }

    /// The manifest plaintext, having passed both protocol gates.
    ///
    /// The size ceiling is compared against CIPHERTEXT length: AES-GCM adds a
    /// 16-byte tag, and comparing plaintext would let a borderline manifest pass
    /// this check and then blow up on `seal`.
    private func validatedManifestPayload(_ files: [FileMeta]) throws -> [UInt8] {
        do { try validateRealtimeFiles(files) }
        catch { throw RealtimeSenderError.invalidManifest }
        let payload = try manifestJSON(files)
        if payload.count + 16 > MANIFEST_MAX_BYTES {
            throw RealtimeSenderError.manifestTooLarge
        }
        return payload
    }

    /// Encrypted chunk frames for every file, each followed by its integrity
    /// (DONE) frame.
    ///
    /// With `resume` set, files before `resume.index` are skipped (already
    /// delivered) and file `resume.index` streams from `resume.offset` — but its
    /// chain hash is still computed from byte 0, so the per-file DONE remains a
    /// hash of the whole file and the receiver's restored chain lines up.
    public func dataFrames(_ files: [(meta: FileMeta, data: [UInt8])],
                           resume: ResumePoint? = nil,
                           maxFrameBytes: Double = DEFAULT_MAX_FRAME_BYTES) throws -> [[UInt8]] {
        let pieceBytes = try piecePlainBytes(maxFrameBytes: maxFrameBytes)
        let sizes = files.map(\.meta.size)
        if let resume, !(resumePointInRange(resume, sizes) && resumePointAligned(resume, sizes)) {
            throw RealtimeSenderError.resumePointRejected
        }
        var frames: [[UInt8]] = []
        for (fi, file) in files.enumerated() {
            if let resume, fi < resume.index { continue }   // delivered before the drop
            let from = (resume != nil && fi == resume!.index) ? resume!.offset : 0
            var hash = [UInt8](repeating: 0, count: 32)
            var offset = 0
            while offset < file.data.count {
                let end = min(offset + CHUNK_SIZE, file.data.count)
                let chunk = Array(file.data[offset..<end])
                // Hashed whole and from byte 0 even when it is not sent: the
                // chain is defined over CHUNK_SIZE pieces, so it stays identical
                // however the connection fragments them — which is what lets a
                // resumed connection negotiate a different message size and
                // still agree on the file hash.
                hash = chainHash(hash, chunk)
                if offset >= from {
                    frames += try pieces(chunk, pieceBytes: pieceBytes,
                                         partKind: RealtimeKind.chunkPart, finalKind: RealtimeKind.chunk)
                }
                offset = end
            }
            frames.append(try nextDoneFrame(hash: hash))
        }
        return frames
    }

    /// Announce where a resumed stream picks up. `nextSequence` is the nonce the
    /// first resumed chunk will carry — send this immediately before the resumed
    /// frames.
    ///
    /// Plaintext and seq 0 on the wire, consuming no nonce: the receiver has to
    /// be able to read it while the two counters are still unaligned. That also
    /// means a signalling relay can inject one, which is why the receiving side
    /// only surfaces it and never acts on it by itself.
    public func resumeStartFrame(_ point: ResumePoint) throws -> [UInt8] {
        guard !sequenceExhausted else { throw RealtimeSenderError.sequenceExhausted }
        let json = "{\"index\":\(point.index),\"offset\":\(point.offset),\"seq\":\(seq)}"
        return realtimeFrame(kind: RealtimeKind.resumeStart, seq: 0, payload: Array(json.utf8))
    }

    /// Cut one plaintext into sealed frames of at most `pieceBytes` payload, the
    /// last one carrying `finalKind`. An empty plaintext still yields exactly one
    /// (final) frame, and a plaintext that divides evenly yields no trailing
    /// empty frame. Mirrors transfer.ts's `Sender.pieces`.
    private func pieces(_ plain: [UInt8], pieceBytes: Int,
                        partKind: UInt8, finalKind: UInt8) throws -> [[UInt8]] {
        var out: [[UInt8]] = []
        var off = 0
        while true {
            let end = min(off + pieceBytes, plain.count)
            let last = end >= plain.count
            out.append(try piece(Array(plain[off..<end]), kind: last ? finalKind : partKind))
            if last { return out }
            off = end
        }
    }

    /// One sealed piece, consuming the next seq.
    private func piece(_ plain: [UInt8], kind: UInt8) throws -> [UInt8] {
        let s = try reserveSequence()
        return realtimeFrame(kind: kind, seq: s,
                             payload: seal(key: sessionKey, seq: UInt64(s), plaintext: plain))
    }

    /// One piece of a logical chunk, for a caller that is streaming rather than
    /// materialising a whole file.
    ///
    /// Internal because the only supported callers are `dataFrames` and
    /// `RealtimeFrameProducer`, and both must share *this instance's* counter:
    /// seq is global and monotonic across a transfer, so a second sender under
    /// the same session key would restart the GCM nonce at 0.
    func nextChunkPieceFrame(_ plain: [UInt8], isFinal: Bool) throws -> [UInt8] {
        try piece(plain, kind: isFinal ? RealtimeKind.chunk : RealtimeKind.chunkPart)
    }

    /// One whole (unfragmented) CHUNK frame, consuming the next seq.
    func nextChunkFrame(_ chunk: [UInt8]) throws -> [UInt8] {
        try nextChunkPieceFrame(chunk, isFinal: true)
    }

    /// The DONE frame carrying a finished file's chained SHA-256. It is
    /// encrypted like any other frame — sending that hash in plaintext would give
    /// anyone inside the DTLS session the ability to confirm "this is file X"
    /// without decrypting anything — so it consumes a seq too.
    func nextDoneFrame(hash: [UInt8]) throws -> [UInt8] {
        let plaintext = Array("{\"sha256\":\"\(hash.hexEncodedString)\"}".utf8)
        let s = try reserveSequence()
        return realtimeFrame(kind: RealtimeKind.doneEnc, seq: s,
                             payload: seal(key: sessionKey, seq: UInt64(s), plaintext: plaintext))
    }
}

/// Byte size of the sealed BATCH frame payload `files` would produce.
///
/// Public so staging can apply `MANIFEST_MAX_BYTES` BEFORE a connection is
/// opened. `batchFrame` enforces the same bound, but it runs after signalling,
/// after the handshake and after the peer has been dialled — for a folder send,
/// where the manifest carries a relative path per file, that is far too late to
/// tell the user their selection does not fit.
public func realtimeManifestSealedSize(_ files: [FileMeta]) throws -> Int {
    try manifestJSON(files).count + 16   // + AES-GCM tag, as batchFrame compares
}

/// Throws `manifestTooLarge` when `files` cannot be sent as one BATCH frame.
public func validateRealtimeManifestSize(_ files: [FileMeta]) throws {
    if try realtimeManifestSealedSize(files) > MANIFEST_MAX_BYTES {
        throw RealtimeSenderError.manifestTooLarge
    }
}

public enum RealtimeSenderError: Error, Equatable {
    case invalidManifest
    case manifestTooLarge
    /// A source ran out before the manifest said it should. Sending anyway
    /// would ship a DONE hash covering fewer bytes than the receiver expects,
    /// failing at the very end of a transfer that looked fine throughout.
    case sourceShorterThanDeclared(name: String)
    /// A file grew after selection. Its extra bytes are not covered by the
    /// manifest the receiver approved and must not be sent under that consent.
    case sourceLongerThanDeclared(name: String)
    /// This connection's negotiated maximum message size cannot carry a usable
    /// piece (see `MIN_PIECE_BYTES`), or is not a number at all.
    case frameSizeTooSmall
    /// The peer asked to resume from a point that is not in this batch or not on
    /// the chunk grid. Honouring it would skip or duplicate file bytes, and the
    /// request arrives on an unauthenticated plaintext channel.
    case resumePointRejected
    /// The 32-bit nonce sequence has no values left. Refused rather than wrapped:
    /// wrapping would reuse a nonce under a session key that is still live.
    case sequenceExhausted
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
