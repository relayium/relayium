import Foundation

/// Sender-side credit-window accounting: mirrors the flow-control logic in
/// `web/src/lib/transfer-session.svelte.ts`, keeping the sender at most
/// `window` bytes ahead of the receiver's cumulative ACK.
public struct SendWindow {
    private let window: Int
    private var sent = 0
    private var acked = 0

    public init(window: Int = FLOW_WINDOW) {
        self.window = window
    }

    public mutating func recordSent(_ n: Int) {
        sent += n
    }

    /// `ackedTotal` is the receiver's cumulative ACK; only advances the
    /// window if it is larger than what we've already recorded (monotonic).
    public mutating func recordAck(_ ackedTotal: Int) {
        if ackedTotal > acked {
            acked = ackedTotal
        }
    }

    public var inFlight: Int { sent - acked }

    public var maySend: Bool { inFlight <= window }
}
