package com.relayium.android.ingress

/**
 * What a scanned QR code is allowed to do, decided without a camera anywhere in
 * sight.
 *
 * This is the policy half of a scanner and deliberately all of what this slice
 * contains: it is pure, it has no dependency on a camera API or a decoder, and
 * it can therefore be driven by ordinary host tests against exactly the
 * payloads a hostile sticker would carry. The capture surface is separate work,
 * and this file does not presume its shape.
 *
 * The rules mirror `PairingScanPolicy` on iOS, which is the same product
 * decision meeting the same threat — a QR code is unauthenticated input from
 * anybody who can print, with none of the domain verification an OS-delivered
 * link at least has:
 *
 *  1. **Bounded first.** A QR code can carry a few kilobytes; nothing this app
 *    accepts is longer than a short URL. The bound is applied before parsing,
 *    so a wall of junk costs a comparison rather than a parse.
 *  2. **The same link policy as everything else.** [IngressLinkPolicy] decides,
 *     so no second origin list exists here to drift from it.
 *  3. **A pairing code, or nothing.** A `/cross-network` link with no code
 *     means "open the join screen" — which is where the user already is while
 *     scanning, so as a scan it is nothing. A `/d/` stored link is a different
 *     feature on a different screen, and silently redirecting a scanner into it
 *     is exactly the surprise a printed code must not be able to cause.
 *
 * **It prefills; it does not join.** The return value is an
 * [IngressRequest.PrefillCode] — the vocabulary has no case that could start a
 * connection — and the lane hint rides along for the same reason it does on a
 * tapped link: it is information the code carried, it selects nothing on its
 * own, and the user still taps.
 */
object ScanPolicy {

    /**
     * Measured in UTF-8 BYTES, not characters.
     *
     * A decoder hands back a string built from the symbol's bytes, and the
     * ceiling worth enforcing is the one on what was actually encoded. Counting
     * characters would let a payload of multi-byte code points be several times
     * the size the number suggests — the same reason [com.relayium.protocol.TextWire]
     * measures a message in bytes.
     */
    const val MAX_PAYLOAD_BYTES = 512

    /**
     * The code to prefill, or null for everything else.
     *
     * Null is the answer for a malformed URL, a foreign host, a five-digit
     * code, a stored link, plain text and a wall of junk alike, and null
     * changes nothing on screen. A scanner that reported WHY would be reading
     * the reasons aloud from an adversary's payload; the honest scanner state
     * is "that is not a Relayium code", which the surface says on its own.
     */
    fun result(payload: String, trustedOrigin: String): IngressRequest.PrefillCode? {
        if (payload.isEmpty()) return null
        // Cheap reject first: a payload longer than the bound in CHARACTERS is
        // longer in bytes too, so the encode only runs for plausible sizes.
        if (payload.length > MAX_PAYLOAD_BYTES) return null
        if (payload.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD_BYTES) return null
        val outcome = IngressLinkPolicy.read(payload, trustedOrigin)
        val request = (outcome as? IngressOutcome.Accepted)?.request
        return request as? IngressRequest.PrefillCode
    }
}
