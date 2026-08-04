import Foundation

public enum RealtimeKind {
    public static let chunk: UInt8 = 1
    public static let doneLegacy: UInt8 = 2
    public static let batchLegacy: UInt8 = 3
    public static let resumeStart: UInt8 = 4
    public static let resumeReq: UInt8 = 5
    public static let ack: UInt8 = 6
    public static let batchEnc: UInt8 = 7
    public static let doneEnc: UInt8 = 8
    /// One ephemeral message, sealed under the message stream's own key with its
    /// own per-direction counter. Distinct from every file kind above so a stray
    /// frame can never be read as a chunk. See docs/protocol/relayium-text-v1.md.
    public static let text: UInt8 = 9
    /// Transport fragmentation. A logical `CHUNK_SIZE` chunk (or a manifest) that
    /// does not fit one transport message goes out as PART…PART terminated by the
    /// ordinary `chunk`/`batchEnc` kind. Each piece is sealed separately and burns
    /// its own nonce; the receiver reassembles the plaintext before hashing or
    /// parsing, so the hash chain, the checkpoint grid and the resume contract are
    /// all still expressed in `CHUNK_SIZE` regardless of how the bytes travelled.
    ///
    /// The values are deliberately above 9: a build that predates fragmentation
    /// parses 1...9 and throws `unknownKind` on everything else, so a mixed-version
    /// pair fails loudly instead of writing a fragment as if it were a whole chunk.
    public static let chunkPart: UInt8 = 10
    public static let batchPart: UInt8 = 11
}

public enum RealtimeControl: UInt8 { case accept = 0xfe, reject = 0xff, complete = 0xfd }

public let CHUNK_SIZE = 192 * 1024
public let MAX_FILES = 1000
public let MANIFEST_MAX_BYTES = 200 * 1024
/// One message, one frame, no chunking. Mirrors the web's TEXT_MAX_BYTES.
public let TEXT_MAX_BYTES = 64 * 1024
public let CHUNK_OVERHEAD = 5 + 16
public let FLOW_WINDOW = 8 << 20
public let FLOW_ACK_INTERVAL = 512 * 1024

/// Below this a connection is not worth transferring over: the per-message
/// overhead and the number of seal/send round trips would dominate, and no real
/// SCTP implementation negotiates anything this small. Failing here is a named,
/// visible error rather than a transfer that crawls. Mirrors transfer.ts's
/// `MIN_PIECE_BYTES`.
public let MIN_PIECE_BYTES = 4096

/// The plaintext one transport message may carry, given this connection's
/// negotiated maximum frame size.
///
/// Capped at `CHUNK_SIZE`: a bigger allowance buys nothing, because `CHUNK_SIZE`
/// is the fixed **logical** unit the hash chain and the checkpoint grid are
/// defined in. `.infinity` (both ends declared no limit) therefore lands on
/// exactly the unfragmented behaviour that predates this function.
///
/// `Double`, not `Int`, for the same reason the web takes a `number`: the
/// negotiated limit is legitimately `Infinity`, and a peer or a platform API can
/// hand over a value no `Int` can hold. Every comparison happens in floating
/// point and the conversion happens only after the clamp — `Int(1e308)` and
/// `Int(Double.nan)` both trap, and trapping on a number a remote peer chose
/// would be a remotely triggerable crash.
public func piecePlainBytes(maxFrameBytes: Double) throws -> Int {
    // NaN would make every comparison below false; naming it here keeps the
    // refusal explicit rather than incidental.
    guard !maxFrameBytes.isNaN else { throw RealtimeSenderError.frameSizeTooSmall }
    let usable = Swift.min(maxFrameBytes.rounded(.down) - Double(CHUNK_OVERHEAD), Double(CHUNK_SIZE))
    guard usable >= Double(MIN_PIECE_BYTES) else { throw RealtimeSenderError.frameSizeTooSmall }
    return Int(usable)   // clamped to CHUNK_SIZE above, so this cannot overflow
}

/// Convenience for callers that already hold an integer limit.
public func piecePlainBytes(maxFrameBytes: Int) throws -> Int {
    try piecePlainBytes(maxFrameBytes: Double(maxFrameBytes))
}

/// How many transport pieces one logical unit may be cut into before a receiver
/// stops buffering.
///
/// Derived, not chosen: the smallest piece any conforming sender may use is
/// `MIN_PIECE_BYTES`, so the largest logical unit — a `MANIFEST_MAX_BYTES`
/// manifest — is at most 50 pieces, and a `CHUNK_SIZE` chunk at most 48. The
/// headroom above that is slack for a future limit change, not tolerance for a
/// peer that fragments absurdly.
///
/// It exists because the byte bound alone is not a bound: a peer can send
/// unlimited ZERO-length pieces, which never advance the byte counter while each
/// one costs the receiver an array slot. This is a deliberate hardening beyond
/// the current web receiver, and it is strictly compatible — it accepts every
/// stream a conforming web sender can produce.
public let MAX_PIECES_PER_LOGICAL_UNIT = 64

/// The default per-frame allowance: exactly one whole logical chunk, which is
/// what every current desktop connection can carry and what the golden vectors
/// were generated at.
public let DEFAULT_MAX_FRAME_BYTES = Double(CHUNK_SIZE + CHUNK_OVERHEAD)

/// Does this frame carry file bytes? Progress and flow-control credit are
/// counted with it, so a fragmented chunk is accounted exactly like an
/// unfragmented one instead of counting only its final piece.
public func isChunkFrame(_ frame: [UInt8]) -> Bool {
    guard let kind = frame.first else { return false }
    return kind == RealtimeKind.chunk || kind == RealtimeKind.chunkPart
}

private func u32be(_ n: UInt32) -> [UInt8] { [UInt8(n>>24 & 0xff),UInt8(n>>16 & 0xff),UInt8(n>>8 & 0xff),UInt8(n & 0xff)] }

public func realtimeFrame(kind: UInt8, seq: UInt32, payload: [UInt8]) -> [UInt8] {
    [kind] + u32be(seq) + payload
}

public func ackFrame(_ bytesWritten: Double) -> [UInt8] {
    var be = bytesWritten.bitPattern.bigEndian
    let bytes = withUnsafeBytes(of: &be) { Array($0) }   // Float64 BE
    return realtimeFrame(kind: RealtimeKind.ack, seq: 0, payload: bytes)
}

public func parseAck(_ buf: [UInt8]) -> Double? {
    guard buf.count == 13, buf[0] == RealtimeKind.ack else { return nil }
    let be = buf[5..<13].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    return Double(bitPattern: be)
}

public func parseControl(_ buf: [UInt8]) -> RealtimeControl? {
    guard buf.count == 1 else { return nil }
    return RealtimeControl(rawValue: buf[0])
}
