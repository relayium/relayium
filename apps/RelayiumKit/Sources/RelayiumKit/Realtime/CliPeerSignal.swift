import Foundation

/// Recognising the relayium CLI on the other end of a pairing code.
///
/// Pairing codes share ONE namespace with the CLI, so a code printed by
/// `relayium send` can be typed into this app, and the CLI can join a code this
/// app minted. The two transports cannot interoperate — the CLI moves bytes
/// over a direct pinned-TLS connection and this client over WebRTC — so the
/// pairing is refused. That refusal is correct; what was wrong is that it was
/// indistinguishable from meeting an out-of-date app, and said so in copy
/// written for that other cause.
///
/// The discriminator is a TOP-LEVEL `kind` string, and the choice is
/// load-bearing:
///
///  - The CLI's handshake frames are `{"kind":"commit",…}` and
///    `{"kind":"reveal",…}` (`server/internal/rzvous/handshake.go`, `hsMsg`).
///  - No app or web peer emits a top-level `kind`. The payloads on this socket
///    are `{caps}`, `{relayRtt}`, `{rename}`, `{link,…}` and the SDP/ICE
///    envelope, none of which carries the field.
///  - `commit` would NOT work as the discriminator. It is a legitimate field on
///    an app's offer/answer, and keying on it is exactly the mistake
///    `LinkHandshakeMessage`'s shape-permissive decoding makes possible: a CLI
///    frame carrying `commit` reads as an app commit.
public enum CliPeerSignal {
    /// Whether this signal payload came from the relayium CLI's handshake.
    ///
    /// Pure, so the port in every other client and the tests can exercise the
    /// discriminator without a socket, a room or a peer.
    public static func isHandshake(_ signal: JSONValue) -> Bool {
        guard case let .object(fields) = signal else { return false }
        guard case .string? = fields["kind"] else { return false }
        return true
    }
}
