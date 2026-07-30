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
