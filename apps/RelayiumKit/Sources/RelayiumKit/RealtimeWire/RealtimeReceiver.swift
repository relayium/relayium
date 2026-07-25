import Foundation

/// What `RealtimeReceiver.feed` hands back for each frame it dispatches.
/// Mirrors transfer.ts's `Receiver.feed` return shape (`{batch?,chunk?,done?,resume?}`),
/// as a proper enum since only one case is ever populated per frame.
public enum RealtimeEvent: Equatable {
    case batch([FileMeta])
    case chunk([UInt8])
    case done(ok: Bool)
    case resume(index: Int, offset: Int, seq: UInt32)
}

public enum RealtimeError: Error, Equatable {
    case outOfOrder
    case tamper
    case legacyPeer
    case unknownKind(UInt8)
    case malformed
}

/// Receive side of the RealtimeWire protocol: dispatches on frame kind,
/// decrypts BATCH/CHUNK/DONE against the running seq counter, verifies the
/// chained per-file hash, and surfaces resume announcements. Byte-pinned to
/// transfer.ts's `Receiver` class — feeding the web-produced `framesHex`
/// stream round-trips to the same manifest/bytes/DONE-ok the sender started
/// from, which is the interop proof for this direction.
public final class RealtimeReceiver {
    private let sessionKey: [UInt8]

    /// Same monotonic seq discipline as `RealtimeSender`: every encrypted
    /// frame (BATCH/CHUNK/DONE) consumes the next seq in order, so a
    /// mismatch means either a dropped/reordered frame or an injected one.
    private var expectedSeq: UInt32 = 0

    /// Running per-file chain hash, reset after each DONE (a batch can carry
    /// more than one file, each with its own chain).
    private var hash = [UInt8](repeating: 0, count: 32)

    public init(sessionKey: [UInt8]) {
        self.sessionKey = sessionKey
    }

    public func feed(_ encoded: [UInt8]) throws -> RealtimeEvent {
        guard encoded.count >= 5 else { throw RealtimeError.malformed }
        let kind = encoded[0]
        let seq = beU32(encoded)
        let payload = Array(encoded[5...])

        switch kind {
        case RealtimeKind.batchEnc, RealtimeKind.chunk, RealtimeKind.doneEnc:
            guard seq == expectedSeq else { throw RealtimeError.outOfOrder }
            guard let plain = open(key: sessionKey, seq: UInt64(seq), ciphertext: payload) else {
                throw RealtimeError.tamper
            }
            expectedSeq += 1
            switch kind {
            case RealtimeKind.batchEnc:
                guard let decoded = try? JSONDecoder().decode(BatchPayload.self, from: Data(plain)) else {
                    throw RealtimeError.malformed
                }
                // 文件名由发送端任意构造，接收方的确认卡片正是用户做信任决策的地方：
                // 在这个唯一入口把双向控制符洗掉。
                return .batch(decoded.files.map(sanitizeFileMeta))
            case RealtimeKind.chunk:
                hash = chainHash(hash, plain)
                return .chunk(plain)
            default: // doneEnc
                guard let done = try? JSONDecoder().decode(DonePayload.self, from: Data(plain)) else {
                    throw RealtimeError.malformed
                }
                let ok = done.sha256 == hexEncoded(hash)
                hash = [UInt8](repeating: 0, count: 32) // reset chain for the next file in the batch
                return .done(ok: ok)
            }

        case RealtimeKind.resumeStart:
            // Plaintext, not decrypted: a mid-signaling attacker can inject this
            // frame, and its `seq` becomes the nonce counter's new starting
            // point — a malformed/NaN-ish value would make every subsequent
            // comparison false and stall the transfer, so validate the shape
            // strictly rather than trust it.
            guard
                let obj = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
                let index = safeIndex(obj["index"]),
                let offset = safeIndex(obj["offset"]),
                let rseq = safeIndex(obj["seq"]),
                let seq32 = UInt32(exactly: rseq)
            else { throw RealtimeError.malformed }
            return .resume(index: index, offset: offset, seq: seq32)

        case RealtimeKind.batchLegacy, RealtimeKind.doneLegacy:
            // Peer is running a pre-encrypted-manifest version. No plaintext
            // fallback: that fallback, once present, never goes away and is a
            // permanent downgrade path for a MITM. Fail closed instead.
            throw RealtimeError.legacyPeer

        default:
            throw RealtimeError.unknownKind(kind)
        }
    }
}

private func beU32(_ b: [UInt8]) -> UInt32 {
    (UInt32(b[1]) << 24) | (UInt32(b[2]) << 16) | (UInt32(b[3]) << 8) | UInt32(b[4])
}

private func hexEncoded(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8](); out.reserveCapacity(bytes.count * 2)
    for b in bytes {
        out.append(digits[Int(b >> 4)])
        out.append(digits[Int(b & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
}

/// Non-negative safe integer, mirroring transfer.ts's `isIndex` exactly:
/// `typeof n === "number" && Number.isSafeInteger(n) && n >= 0`. That caps at
/// 2^53-1 (9007199254740991, `Number.MAX_SAFE_INTEGER`) — NOT `Int.max`
/// (2^63-1): a JS sender can never legitimately produce a value above 2^53-1
/// (it stops being an exact integer past that), so accepting up to `Int.max`
/// here would let a malformed/attacker-supplied value through that the real
/// protocol can never emit. Also rejects missing/non-numeric/negative/
/// non-integer values (JSONSerialization never hands back NaN/Infinity for a
/// well-formed JSON number, but a string like `"nope"` in the `seq` field
/// must still be rejected, not coerced).
private func safeIndex(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber else { return nil }
    // Exclude booleans, which bridge to NSNumber too.
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
    let d = n.doubleValue
    guard d.rounded(.towardZero) == d, d >= 0, d <= 9_007_199_254_740_991 else { return nil }
    return n.intValue
}

private struct BatchPayload: Decodable {
    let files: [FileMeta]
}

private struct DonePayload: Decodable {
    let sha256: String
}

/// Sanitize one manifest entry's display name and — since `FileMeta` carries
/// a folder-relative `path` that `sanitizeNames`/`ManifestFile` don't have —
/// sanitize it per path segment too, so a bidi/control-character payload
/// can't hide in a folder name either. Mirrors web/src/lib/filename.ts's
/// generic `sanitizeNames<T>` (name + per-`/`-segment path); R1-B's Swift
/// `sanitizeNames` only covers `ManifestFile`, which has no path field.
private func sanitizeFileMeta(_ f: FileMeta) -> FileMeta {
    let name = safeDisplayName(f.name)
    let path = f.path.map { p in
        p.split(separator: "/", omittingEmptySubsequences: false)
            .map { safeDisplayName(String($0)) }
            .joined(separator: "/")
    }
    return FileMeta(name: name, size: f.size, path: path)
}
