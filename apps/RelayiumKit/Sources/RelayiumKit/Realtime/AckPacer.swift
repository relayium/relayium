import Foundation

/// Receiver-side ack pacing: mirrors `web/src/lib/transfer-session.svelte.ts`'s
/// `lastAckSent` bookkeeping — acks the cumulative durable byte total at least
/// every `FLOW_ACK_INTERVAL` bytes, rather than on every write.
public struct AckPacer {
    private let interval: Int
    private var lastAck = 0

    public init(interval: Int = FLOW_ACK_INTERVAL) {
        self.interval = interval
    }

    /// Returns the cumulative durable total to ACK when it has advanced by at least
    /// `interval` since the last ACK; otherwise nil.
    public mutating func onWritten(total: Int) -> Int? {
        guard total - lastAck >= interval else { return nil }
        lastAck = total
        return total
    }
}
