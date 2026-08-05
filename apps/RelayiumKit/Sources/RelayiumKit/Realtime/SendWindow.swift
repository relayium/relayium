import Foundation

/// Advance a batch-local cumulative ACK only within bytes THIS attempt actually
/// emitted. Mirrors `transfer.ts`'s `advanceAck` exactly.
///
/// The clamp is the whole control. A flow-control ACK carries no batch id and no
/// attempt id, so a delayed one from a batch that already ended — or a forged one
/// from a signalling relay — is indistinguishable by content. Bounding it above
/// by `sent` means the worst such a frame can do is acknowledge bytes that were
/// genuinely sent, which buys an attacker nothing the peer had not already
/// granted; bounding it below by `acked` keeps it monotonic.
///
/// Total over `Int`: every comparison is an ordering, never an arithmetic
/// operation, so `Int.max` and `Int.min` are ordinary out-of-range values rather
/// than an overflow.
public func advanceAck(acked: Int, sent: Int, candidate: Int) -> Int {
    candidate > acked && candidate <= sent ? candidate : acked
}

/// The cumulative byte total an ACK frame carries, or nil when the frame is not
/// an ACK or its value is not one a conforming peer could have produced.
///
/// The value arrives as a raw IEEE double chosen by the peer, and its only use
/// is arithmetic. `Int(Double)` TRAPS outside `Int`'s range and on NaN, so the
/// conversion must be unreachable until the shape is proven — a trap the peer
/// picks the moment for is a remotely triggerable crash, not a validation error.
///
/// The ceiling is `Number.MAX_SAFE_INTEGER`, not `Int.max`, for the reason
/// `safeIndex` records: above it a JavaScript peer cannot count exactly, so a
/// larger value is not a big transfer — it is a value the real protocol can
/// never emit.
public func linkFileAckTotal(_ frame: [UInt8]) -> Int? {
    guard let raw = parseAck(frame) else { return nil }
    return safeAckTotal(raw)
}

/// The non-negative safe-integer gate `linkFileAckTotal` applies, on a value a
/// caller already holds.
func safeAckTotal(_ raw: Double) -> Int? {
    guard raw.isFinite, raw >= 0, raw <= 9_007_199_254_740_991,
          raw.rounded(.towardZero) == raw else { return nil }
    return Int(raw)
}

/// The file plaintext one outbound frame carries: its own bytes less the header
/// and AEAD tag, and zero for every kind that is not a chunk.
///
/// ONE definition, so the send window's credit and a lane's file cursor can never
/// disagree about how far a frame moved the transfer — the receiver's durable ACK
/// is measured against both. A frame with no room for its own tag carries no
/// plaintext rather than a negative amount, and zero is a refusal a caller can
/// see: no conforming producer emits a chunk with nothing under its tag.
public func chunkPlaintextBytes(_ frame: [UInt8]) -> Int {
    guard isChunkFrame(frame), frame.count >= CHUNK_OVERHEAD else { return 0 }
    return frame.count - CHUNK_OVERHEAD
}

/// Sender-side credit-window accounting: mirrors the flow-control logic in
/// `web/src/lib/transfer-session.svelte.ts` and
/// `web/src/lib/mixed-file-session.svelte.ts`, keeping the sender at most
/// `window` bytes ahead of the receiver's cumulative durable ACK.
///
/// Both cursors are BATCH-cumulative and both rebase together on a resumed
/// attempt (see `rebase`), so a replacement transport opens exactly one fresh
/// window measured from the durable checkpoint rather than inheriting a
/// half-spent one from the attempt that died.
///
/// Every mutation is checked arithmetic. The inputs are a peer's ACK value and a
/// transport's frame length; a wrap here does not merely mis-count, it makes
/// `inFlight` negative and opens the window forever.
public struct SendWindow {
    private let window: Int
    private var sent = 0
    private var acked = 0

    public init(window: Int = FLOW_WINDOW) {
        self.window = window
    }

    /// Restart both cumulative cursors at a resumed attempt's durable batch
    /// offset.
    ///
    /// Both, and to the same value: the ACK the receiver will send next is
    /// measured from this same offset, so leaving `sent` where the dead attempt
    /// left it would count bytes the resumed attempt never emits, and leaving
    /// `acked` behind would let a delayed ACK from the old attempt be replayed as
    /// credit against the new one.
    ///
    /// A negative base is not a checkpoint. Refused rather than clamped, so a
    /// caller's arithmetic bug cannot quietly hand the window a full reset.
    public mutating func rebase(to base: Int) {
        guard base >= 0 else { return }
        sent = base
        acked = base
    }

    /// Record plaintext bytes handed to the transport.
    ///
    /// Saturates rather than wraps. Saturation fails CLOSED — `inFlight` pins at
    /// `Int.max`, `maySend` stays false and the sender stops — which is the
    /// correct answer to a number that large however it was arrived at.
    public mutating func recordSent(_ n: Int) {
        guard n > 0 else { return }
        let (sum, overflow) = sent.addingReportingOverflow(n)
        sent = overflow ? Int.max : sum
    }

    /// Record one outbound frame, counting only the file plaintext it carries.
    ///
    /// `chunk` and `chunkPart` are the only kinds that carry file bytes. The
    /// manifest and the per-file DONE consume nonces and transport bytes but are
    /// not transfer progress, and counting them would make the sender's cursor
    /// disagree with the receiver's durable total — which is the number the ACK
    /// clamp is measured against.
    ///
    /// A frame with no room for its own AEAD tag is not counted at all: the
    /// subtraction would go negative and hand the window free credit.
    @discardableResult
    public mutating func recordSentFrame(_ frame: [UInt8]) -> Int {
        let plaintext = chunkPlaintextBytes(frame)
        recordSent(plaintext)
        return plaintext
    }

    /// Apply one ACK value straight off the wire. True when it moved the window.
    ///
    /// `Double` because that is what the frame carries. Validated before it is an
    /// `Int` at all, then clamped by `advanceAck`, so NaN, either infinity, a
    /// negative, a fraction and anything past `Number.MAX_SAFE_INTEGER` all buy
    /// exactly nothing rather than trapping the process.
    @discardableResult
    public mutating func recordAck(_ candidate: Double) -> Bool {
        guard let value = safeAckTotal(candidate) else { return false }
        let next = advanceAck(acked: acked, sent: sent, candidate: value)
        guard next != acked else { return false }
        acked = next
        return true
    }

    /// The cumulative batch total THIS attempt has emitted — the number every
    /// ACK is clamped to, and the one a resumed attempt restarts from.
    public var sentTotal: Int { sent }

    /// Bytes emitted and not yet acknowledged. Non-negative by construction:
    /// `advanceAck` never lets `acked` pass `sent`, and `rebase` moves both.
    public var inFlight: Int { sent - acked }

    public var maySend: Bool { inFlight <= window }
}
