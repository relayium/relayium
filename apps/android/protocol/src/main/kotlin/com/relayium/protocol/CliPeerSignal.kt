package com.relayium.protocol

/**
 * Recognising the relayium CLI on the other end of a pairing code.
 *
 * Pairing codes share ONE namespace with the CLI, so a code printed by
 * `relayium send` can be typed into this app, and the CLI can join a code this
 * app minted. The two transports cannot interoperate — the CLI moves bytes over
 * a direct pinned-TLS connection and this client over WebRTC — so the pairing is
 * refused. That refusal is correct; what was wrong is what it SAID. The CLI
 * announces no capabilities and never offers, so it fell through to
 * `error_legacy_no_offer` — "one device has to create a code instead" — after
 * 35 seconds, which actively misdirects: the CLI is precisely the side that DID
 * create the code.
 *
 * The discriminator is a TOP-LEVEL `kind` string, and the choice is
 * load-bearing:
 *
 *  - The CLI's handshake frames are `{"kind":"commit",…}` and
 *    `{"kind":"reveal",…}` (`server/internal/rzvous/handshake.go`, `hsMsg`).
 *  - No app or web peer emits a top-level `kind`. The payloads on this socket
 *    are `{caps}`, `{relayRtt}`, `{rename}`, `{link,…}` and the SDP/ICE
 *    envelope, none of which carries the field.
 *  - `commit` would NOT work as the discriminator, and this is the reason the
 *    check has to happen before [Signal.fromJson] is acted on: `commit` is a
 *    legitimate field on an app's offer, the CLI's commit frame carries one
 *    too, and a shape-permissive read of it starts a handshake that can never
 *    finish.
 */
object CliPeerSignal {

    /**
     * Whether this signal payload came from the relayium CLI's handshake.
     *
     * Pure, so the port in every other client and the tests can exercise the
     * discriminator without a socket, a room or a peer.
     */
    fun isHandshake(raw: Json?): Boolean {
        val obj = raw as? Json.Obj ?: return false
        return obj["kind"] is Json.Str
    }
}
