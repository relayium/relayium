package com.relayium.android.scan

import com.relayium.android.account.PairCodeExpiry
import com.relayium.protocol.JoinInput
import com.relayium.protocol.PairCode

/**
 * The QR code this device SHOWS, so the other one can point a camera at it
 * instead of a person reading six digits aloud.
 *
 * ## It is the same link the web shows, character for character
 *
 * `origin + "/cross-network#c=" + code`, which is what `CodePairing.svelte`
 * builds and encodes, and what `pairingJoinURL` builds on Apple. That is not a
 * detail: a code minted here is scanned by a browser, and a link this app
 * produced in its own shape would be a code that works between two Androids
 * and nowhere else. The construction goes through [JoinInput]'s own constants
 * rather than a literal, and [payload] is verified by decoding its own output
 * back through the app's scan policy in the tests.
 *
 * No `mode` parameter, and the reason is what this client DOES with one rather
 * than a claim that it has no lanes. It does: a session with a shipped Apple
 * peer is a legacy file connection or a legacy message connection, separately,
 * while its own `link/1` session carries both. But which one is established is
 * NEGOTIATED — `LegacyLane.mode` reads what the peer announced and whether a
 * batch is already armed — so a hint written into this link would not change
 * what this device offers or accepts. Emitting one would state a choice that
 * nothing here makes. A hint arriving from an Apple client is still read; see
 * [com.relayium.android.ingress.IngressTransferMode].
 *
 * ## An expired code never becomes a QR code
 *
 * A pairing code dies on the server at `expiresAt`, and a square on the screen
 * says nothing about time. Someone photographs it, walks to the other device
 * and scans a code that was already refused — and the failure surfaces there,
 * as "this code is invalid", on the device that did nothing wrong. So the
 * question is asked HERE, through [PairCodeExpiry], which is the same answer
 * the countdown and the share controls read; the surface cannot show a
 * countdown at zero beside a scannable code.
 */
object PairingQr {

    /**
     * The link to encode, or null when there is nothing honest to show.
     *
     * @param code the minted code, or null when nothing has been minted.
     * @param expiresAt the epoch second the MINT returned; `0` when the server
     *   named no deadline, which [PairCodeExpiry] treats as usable.
     * @param now this device's epoch second.
     */
    fun payload(origin: String, code: PairCode?, expiresAt: Long, now: Long): String? {
        val digits = code?.digits ?: return null
        if (!PairCodeExpiry.presentation(expiresAt, now).usable) return null
        return origin.trimEnd('/') + JoinInput.CROSS_PATH + "#c=" + digits
    }

    /** The grid to draw, or null when there is no usable code to draw one for. */
    fun matrix(origin: String, code: PairCode?, expiresAt: Long, now: Long): QrMatrix? =
        payload(origin, code, expiresAt, now)?.let { QrCodec.encode(it) }
}
