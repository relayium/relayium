package com.relayium.android.nearby

/**
 * Four-byte big-endian length framing, for SIGNALLING JSON only.
 *
 * File and message bodies never travel here: they stay on the encrypted WebRTC
 * data channels. What crosses this framing is one `signal` envelope at a time,
 * which is why the ceiling is small and why an oversized declaration is a hard
 * failure rather than something to grow a buffer for.
 *
 * Port of `LocalPeerFraming.swift`, bound for bound. A TCP stream delivers
 * arbitrary splits, so the reader is INCREMENTAL: a header split across two
 * reads, a body split across ten, and several frames inside one read all have
 * to work, and each of those is a case the owning test drives directly rather
 * than trusting the loop to be obviously right.
 */
object LocalPeerFraming {

    /** 64 KiB. A declaration above it is refused before a byte is buffered. */
    const val MAX_FRAME_BYTES = 64 * 1024
    const val HEADER_BYTES = 4

    /** A frame this side could not put on the wire. Never thrown at a peer. */
    class TooLarge(val declared: Int) : Exception("frame declares $declared bytes")
    class Empty : Exception("a zero-length frame is not a frame")
    class NotUtf8 : Exception("frame body is not valid UTF-8")

    /**
     * Encode one signalling frame, or null when the text cannot legally be one.
     *
     * Null rather than an exception: the caller is a send path that must drop a
     * frame it cannot represent, not tear the connection down over its own
     * oversized payload.
     */
    fun encode(text: String): ByteArray? {
        val body = text.toByteArray(Charsets.UTF_8)
        if (body.isEmpty() || body.size > MAX_FRAME_BYTES) return null
        val out = ByteArray(HEADER_BYTES + body.size)
        val length = body.size
        out[0] = ((length ushr 24) and 0xff).toByte()
        out[1] = ((length ushr 16) and 0xff).toByte()
        out[2] = ((length ushr 8) and 0xff).toByte()
        out[3] = (length and 0xff).toByte()
        body.copyInto(out, HEADER_BYTES)
        return out
    }

    /**
     * The incremental reader. NOT thread-safe: it belongs to one connection and
     * is driven from that connection's owner thread.
     *
     * ## Strict UTF-8
     *
     * `String(bytes, UTF_8)` REPLACES malformed sequences with U+FFFD, which
     * would turn a corrupted or hostile frame into a valid-looking string that
     * then fails to parse as JSON — a different, more confusing failure than the
     * truthful one. The decoder is therefore configured to REPORT, so a body
     * that is not UTF-8 fails the connection, exactly as the Apple reader's
     * `String(data:encoding:)` returning nil does.
     */
    class Reader {
        private val header = ByteArray(HEADER_BYTES)
        private var headerFilled = 0
        private var body: ByteArray? = null
        private var bodyFilled = 0

        /** Bytes this reader is currently holding for an incomplete frame.
         *  Bounded by construction: the header is 4 and the body can never be
         *  allocated larger than [MAX_FRAME_BYTES]. */
        val pendingBytes: Int get() = headerFilled + bodyFilled

        /**
         * Feed [count] bytes from [chunk] and return every COMPLETE frame in it,
         * in wire order.
         *
         * Throws on a malformed stream — an empty declaration, an oversized one,
         * or a body that is not UTF-8 — and the caller drops the connection.
         * There is no recovery: the stream is a length-prefixed sequence, so
         * one bad length means every following byte is misaligned.
         */
        fun append(chunk: ByteArray, count: Int = chunk.size): List<String> {
            val frames = ArrayList<String>()
            var cursor = 0
            while (cursor < count) {
                if (body == null) {
                    val needed = HEADER_BYTES - headerFilled
                    val take = minOf(needed, count - cursor)
                    chunk.copyInto(header, headerFilled, cursor, cursor + take)
                    headerFilled += take
                    cursor += take
                    if (headerFilled < HEADER_BYTES) continue
                    var declared = 0
                    for (b in header) declared = (declared shl 8) or (b.toInt() and 0xff)
                    if (declared <= 0) throw Empty()
                    if (declared > MAX_FRAME_BYTES) throw TooLarge(declared)
                    body = ByteArray(declared)
                    bodyFilled = 0
                }
                val target = body ?: continue
                val needed = target.size - bodyFilled
                val take = minOf(needed, count - cursor)
                chunk.copyInto(target, bodyFilled, cursor, cursor + take)
                bodyFilled += take
                cursor += take
                if (bodyFilled < target.size) continue
                frames.add(decodeStrict(target))
                body = null
                bodyFilled = 0
                headerFilled = 0
            }
            return frames
        }

        private fun decodeStrict(bytes: ByteArray): String = strictUtf8(bytes) ?: throw NotUtf8()
    }

    /**
     * Decode bytes as UTF-8, or answer null.
     *
     * `String(bytes, UTF_8)` REPLACES a malformed sequence with U+FFFD, which
     * silently admits input the contract refuses — a frame body that is not
     * UTF-8, or a TXT value carrying one. A replacement character is not a
     * lenient reading of a name; it is a different name, and it would be
     * compared, displayed and matched as though the peer had sent it.
     *
     * Shared rather than duplicated, because the framing and the discovery
     * record make the same promise and a second copy is how one of them stops
     * keeping it.
     */
    fun strictUtf8(bytes: ByteArray): String? {
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return try {
            decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (_: java.nio.charset.CharacterCodingException) {
            null
        }
    }
}
