import Foundation

/// Errors from the realtime text wire. Associated values contain lengths or
/// sequence numbers only; message bodies must never enter logs or UI errors.
public enum RealtimeTextError: Error, Equatable {
    case invalidKey
    case messageTooLarge(bytes: Int, limit: Int)
    case sequenceExhausted
    case malformedFrame
    case wrongKind
    case outOfOrder(expected: UInt32, actual: UInt32)
    case authenticationFailed
    case invalidUTF8(bytes: Int)
}

/// Stateful producer for one direction of an ephemeral text session.
///
/// A dedicated instance owns a dedicated text key's nonce sequence. Calls must
/// be serialized by the session model: producing frames concurrently could send
/// their distinct sequence numbers out of order even though nonce reuse cannot
/// occur.
public final class RealtimeTextSender {
    private var nextSequence: UInt64 = 0

    public init() {}

    /// Encodes one exact Swift string as a single kind-9 frame.
    ///
    /// Validation happens before the sequence is consumed, so a refused
    /// oversized message does not create an unrecoverable gap.
    public func frame(body: String, key: [UInt8]) throws -> [UInt8] {
        guard key.count == 32 else { throw RealtimeTextError.invalidKey }
        let plaintext = Array(body.utf8)
        guard plaintext.count <= TEXT_MAX_BYTES else {
            throw RealtimeTextError.messageTooLarge(bytes: plaintext.count, limit: TEXT_MAX_BYTES)
        }
        guard nextSequence <= UInt64(UInt32.max) else {
            throw RealtimeTextError.sequenceExhausted
        }

        let sequence = UInt32(nextSequence)
        let ciphertext = seal(key: key, seq: nextSequence, plaintext: plaintext)
        nextSequence += 1
        return realtimeFrame(kind: RealtimeKind.text, seq: sequence, payload: ciphertext)
    }
}

/// Stateful consumer for one direction of an ephemeral text session.
public final class RealtimeTextReceiver {
    private var expectedSequence: UInt64 = 0

    public init() {}

    /// Authenticates and strictly decodes one kind-9 frame.
    ///
    /// The expected sequence advances only after authentication and UTF-8
    /// validation both succeed. The ordered reliable channel makes any gap or
    /// repeat a hard protocol error rather than a recoverable network event.
    public func receive(frame: [UInt8], key: [UInt8]) throws -> String {
        guard key.count == 32 else { throw RealtimeTextError.invalidKey }
        guard frame.count >= 5 + 16 else { throw RealtimeTextError.malformedFrame }
        guard frame[0] == RealtimeKind.text else { throw RealtimeTextError.wrongKind }

        let actual = (UInt32(frame[1]) << 24)
            | (UInt32(frame[2]) << 16)
            | (UInt32(frame[3]) << 8)
            | UInt32(frame[4])
        guard expectedSequence <= UInt64(UInt32.max) else {
            throw RealtimeTextError.sequenceExhausted
        }
        let expected = UInt32(expectedSequence)
        guard actual == expected else {
            throw RealtimeTextError.outOfOrder(expected: expected, actual: actual)
        }
        guard let plaintext = open(
            key: key,
            seq: expectedSequence,
            ciphertext: Array(frame.dropFirst(5))
        ) else {
            throw RealtimeTextError.authenticationFailed
        }
        guard let body = String(bytes: plaintext, encoding: .utf8) else {
            throw RealtimeTextError.invalidUTF8(bytes: plaintext.count)
        }

        expectedSequence += 1
        return body
    }
}
