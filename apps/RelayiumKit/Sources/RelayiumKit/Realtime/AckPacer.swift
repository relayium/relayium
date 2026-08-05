import Foundation

/// Receiver-side ack pacing: mirrors `web/src/lib/transfer-session.svelte.ts`'s
/// and `mixed-file-session.svelte.ts`'s `lastAckSent` bookkeeping — acks the
/// cumulative durable byte total at least every `FLOW_ACK_INTERVAL` bytes,
/// rather than on every write.
public struct AckPacer {
    private let interval: Int
    private var lastAck = 0

    public init(interval: Int = FLOW_ACK_INTERVAL) {
        self.interval = interval
    }

    /// Restart the interval at a resumed attempt's durable batch offset.
    ///
    /// The sender rebases its own window to the same number (`SendWindow.rebase`),
    /// so without this the receiver's first resumed ACK would be measured from a
    /// mark the sender no longer shares: either a total already past the mark,
    /// acknowledging bytes this attempt never sent and being clamped away, or one
    /// far behind it, leaving the sender to stall for a whole interval it has
    /// already crossed.
    ///
    /// A negative base is not a checkpoint and is refused.
    public mutating func rebase(to base: Int) {
        guard base >= 0 else { return }
        lastAck = base
    }

    /// Returns the cumulative durable total to ACK when it has advanced by at
    /// least `interval` since the last ACK; otherwise nil.
    ///
    /// A total that moves BACKWARDS is refused outright rather than differenced.
    /// The cumulative ACK is monotonic by contract, so a smaller number is either
    /// a caller bug or a stale generation's write completing late — and
    /// subtracting it would both emit a rewound ACK the sender must then clamp
    /// away, and leave `lastAck` behind, silently changing the pacing interval.
    /// Refusing here is also what keeps the subtraction below in range: both
    /// operands are non-negative and ordered.
    public mutating func onWritten(total: Int) -> Int? {
        guard total >= lastAck else { return nil }
        guard total - lastAck >= interval else { return nil }
        lastAck = total
        return total
    }
}
