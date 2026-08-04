import Foundation

/// A resume checkpoint: the receiver has durably written `offset` bytes of file
/// `index`; the sender continues from there. Mirrors transfer.ts's `ResumePoint`.
public struct ResumePoint: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let index: Int
    public let offset: Int
    public init(index: Int, offset: Int) {
        self.index = index
        self.offset = offset
    }
    public var description: String { "ResumePoint(index: \(index), offset: \(offset))" }
}

/// Receiver -> sender: the last point the receiver durably has. Plaintext, seq 0,
/// consuming no nonce — it has to be readable while the two ends' counters are
/// still unaligned.
///
/// The bytes are canonical: `{"index":…,"offset":…}` in exactly that key order,
/// matching `JSON.stringify({ index, offset })`. Key order is part of the wire
/// here only because the fixtures pin it; nothing parses positionally.
public func resumeReqFrame(index: Int, offset: Int) -> [UInt8] {
    realtimeFrame(kind: RealtimeKind.resumeReq, seq: 0,
                  payload: Array("{\"index\":\(index),\"offset\":\(offset)}".utf8))
}

/// Decode a resume request; `nil` if the frame is not one **or is not a sane
/// resume point**.
///
/// 续传通道没有对端认证：重连的 offer 和这条请求都可以由信令层的中间人注入。内容仍然
/// 安全（密钥没有重新协商，攻击者解不开也伪造不了密文），但这里的两个数字会被发送端
/// 直接拿去切文件：巨大的 index 会跳过所有文件让传输静默空转；**负的 offset 会从文件
/// 尾部倒着切**，发出去的是文件末尾的字节，而不是接收端要的那一段。所以在解析这一层
/// 就把形状卡死：非负 JSON 安全整数，其余一律当作"这不是一条续传请求"。
///
/// 上界——index 是否落在 manifest 内、offset 是否超出该文件大小、是否落在分块网格
/// 上——由调用方用 `resumePointInRange` / `resumePointAligned` 校验，因为只有它知道
/// 这次传输有哪些文件。
public func parseResumeReq(_ buf: [UInt8]) -> ResumePoint? {
    guard isResumeReq(buf), buf.count >= 5 else { return nil }
    guard
        let obj = try? JSONSerialization.jsonObject(with: Data(buf[5...])) as? [String: Any],
        let index = safeIndex(obj["index"]),
        let offset = safeIndex(obj["offset"])
    else { return nil }
    return ResumePoint(index: index, offset: offset)
}

/// True for the receiver->sender resume-request frame kind, **including
/// malformed payloads**.
///
/// This is the distinction `parseResumeReq` alone cannot make. A lane needs both
/// answers: a frame that is not a resume request at all is somebody else's frame
/// and gets routed onward, while a resume request whose payload does not parse
/// is malformed control on an unauthenticated channel — the safe response there
/// is to fail closed, not to pass the bytes into the protected receiver stream.
public func isResumeReq(_ buf: [UInt8]) -> Bool {
    buf.first == RealtimeKind.resumeReq
}

/// Does this point land inside the batch actually being sent (the file exists and
/// the offset does not run past its end)?
public func resumePointInRange(_ p: ResumePoint, _ sizes: [Int]) -> Bool {
    p.index >= 0 && p.index < sizes.count && p.offset >= 0 && p.offset <= sizes[p.index]
}

/// Is this a resume point the sender can actually restart from?
///
/// The chain hash is `h = SHA-256(h || chunk)` over `CHUNK_SIZE` pieces, so it is
/// defined only at chunk boundaries and at the exact end of a file. A receiver
/// that follows the protocol only ever checkpoints there, because it only writes
/// a chunk once the whole chunk has arrived. An unaligned point can come only
/// from a peer that is not following the protocol or from a frame injected by the
/// signalling relay — and honouring one would make the sender skip the bytes
/// between the request and the next boundary. Refuse instead.
public func resumePointAligned(_ p: ResumePoint, _ sizes: [Int]) -> Bool {
    guard p.index >= 0, p.index < sizes.count else { return false }
    let size = sizes[p.index]
    return p.offset == size || (p.offset >= 0 && p.offset % CHUNK_SIZE == 0)
}

/// Non-negative safe integer, mirroring transfer.ts's `isIndex` exactly:
/// `typeof n === "number" && Number.isSafeInteger(n) && n >= 0`. That caps at
/// 2^53-1 (`Number.MAX_SAFE_INTEGER`) — NOT `Int.max`: a JS peer can never
/// legitimately produce a value above it (numbers stop being exact integers
/// there), so accepting up to `Int.max` would let through values the real
/// protocol can never emit. Also rejects missing/non-numeric/negative/fractional
/// values, and `Bool`, which bridges to `NSNumber` too and would otherwise read
/// as 0 or 1.
func safeIndex(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber else { return nil }
    if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
    let d = n.doubleValue
    guard d.rounded(.towardZero) == d, d >= 0, d <= 9_007_199_254_740_991 else { return nil }
    return n.intValue
}
