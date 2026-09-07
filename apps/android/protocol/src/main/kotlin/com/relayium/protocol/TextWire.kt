package com.relayium.protocol

/**
 * The text lane's codec and lifecycle bytes.
 *
 * Authoritative prose: `docs/protocol/relayium-text-v1.md` for the frame,
 * `docs/protocol/relayium-link-v1.md` section 7 for what `link/1` adds.
 */
object TextWire {

    const val KIND = RealtimeFrame.KIND_TEXT_ENC

    /** 5-byte header + 16-byte GCM tag. A frame shorter than this has no room
     *  for a tag and is therefore not a frame. */
    const val FRAME_OVERHEAD = RealtimeFrame.OVERHEAD

    /**
     * One message, one frame, NO chunking — the product cap, measured on the
     * plaintext in UTF-8 BYTES, never characters.
     *
     * A character count would let a Chinese or emoji message be refused AFTER
     * the composer told the user it fit.
     */
    const val MAX_BYTES = 64 * 1024

    // Lifecycle. ACCEPT/REJECT are the SHARED bytes from the file protocol; the
    // DataChannel label is what scopes their meaning to a conversation.
    const val CTRL_REQUEST = 0xfa
    const val CTRL_END = 0xfb

    val REQUEST = byteArrayOf(CTRL_REQUEST.toByte())
    val END = byteArrayOf(CTRL_END.toByte())
    val ACCEPT = RealtimeFrame.ACCEPT
    val REJECT = RealtimeFrame.REJECT

    enum class Lifecycle { REQUEST, ACCEPT, REJECT, END }

    /**
     * A lifecycle control is EXACTLY one byte.
     *
     * `0xfd` COMPLETE belongs to the file protocol and has no meaning here; so
     * do `0xf9` BUSY and `0xf8` BATCH_ABORT. A longer frame that merely starts
     * with one of these values is a protected or malformed frame and must never
     * be read as consent.
     */
    fun lifecycleKind(frame: ByteArray): Lifecycle? {
        if (frame.size != 1) return null
        return when (frame[0].toInt() and 0xff) {
            CTRL_REQUEST -> Lifecycle.REQUEST
            RealtimeFrame.CTRL_ACCEPT -> Lifecycle.ACCEPT
            RealtimeFrame.CTRL_REJECT -> Lifecycle.REJECT
            CTRL_END -> Lifecycle.END
            else -> null
        }
    }

    /** Cheap discriminator, structurally disjoint from every one-byte control
     *  and from every file-lane kind. */
    fun isTextFrame(frame: ByteArray): Boolean =
        frame.size >= FRAME_OVERHEAD && (frame[0].toInt() and 0xff) == KIND

    /**
     * The plaintext one message may carry on THIS connection: the product cap,
     * lowered to whatever the sealed frame must fit in.
     *
     * The file lane fragments when a chunk does not fit; text deliberately does
     * not, so the only correct answer for an outsized message is to refuse it —
     * BEFORE sealing, so no nonce is burned and the conversation survives.
     * Handing an oversize message to a DataChannel instead kills the channel and
     * takes the whole session with it.
     */
    fun plainLimit(maxFrameBytes: Int): Int =
        maxOf(0, minOf(maxFrameBytes - FRAME_OVERHEAD, MAX_BYTES))

    fun byteLength(body: String): Int = body.toByteArray(Charsets.UTF_8).size

    /**
     * One direction of the message stream, under the DERIVED text key rather
     * than the file key.
     *
     * The separate key is what lets this counter exist at all: the file lane's
     * nonce safety rests on having exactly one producer, and messages are a
     * second one, driven by UI events.
     */
    class Sender {
        private var seq = 0L

        /** For a caller that must prove no message was silently dropped. */
        val nextSeq: Long get() = seq

        /**
         * Seal one message, or throw.
         *
         * CHECK FIRST, then take the sequence number. Unlike the file lane —
         * where a suspended generator may never resume, so a piece must burn its
         * number before yielding — this function is atomic: it either returns a
         * frame or throws, with no suspension point in between. So a REFUSED
         * message burns no sequence number and the conversation survives it.
         *
         * Callers must serialise calls on one Sender: the number is taken
         * synchronously, but two concurrent calls could complete their seals out
         * of order and put the larger number on the wire first, which the peer
         * rejects as out-of-order.
         */
        fun frame(body: String, keys: Crypto.SessionKeys): ByteArray {
            val payload = body.toByteArray(Charsets.UTF_8)
            if (payload.size > MAX_BYTES) {
                // The LENGTH, never the content: this message reaches logs.
                throw TextWireException("relayium: message too large (${payload.size} > $MAX_BYTES bytes)")
            }
            val s = seq++
            return RealtimeFrame.frame(KIND, s, Crypto.sealText(keys, s, payload))
        }
    }

    /** The other direction. Its own counter, from 0, never rewound. */
    class Receiver {
        private var expectedSeq = 0L

        val nextExpectedSeq: Long get() = expectedSeq

        /**
         * Open one message frame, or throw.
         *
         * Every rejection is a HARD failure. The channel is reliable and
         * ordered, so a gap, a repeat or a bad tag is not a network event — it
         * is tampering or a bug.
         *
         * `expectedSeq` advances only AFTER the AEAD verifies, so a rejected
         * frame leaves this receiver still expecting the same number and a
         * genuine frame at that number still opens.
         */
        fun feed(frame: ByteArray, keys: Crypto.SessionKeys): String {
            if (frame.size < FRAME_OVERHEAD) throw TextWireException("relayium: malformed message frame")
            if ((frame[0].toInt() and 0xff) != KIND) throw TextWireException("relayium: not a message frame")
            val seq = RealtimeFrame.seqOf(frame)
            if (seq != expectedSeq) throw TextWireException("relayium: out-of-order message")
            // The sequence number is IN the nonce, so a rewritten header is an
            // authentication failure too, not just a mismatch.
            val plain = try {
                Crypto.openText(keys, seq, RealtimeFrame.payloadOf(frame))
            } catch (e: java.security.GeneralSecurityException) {
                throw TextWireException("relayium: message failed authentication")
            }
            expectedSeq++
            return try {
                decodeUtf8Strict(plain)
            } catch (e: CharacterCodingException) {
                // Invalid UTF-8 is a hard error, never U+FFFD: silent corruption
                // reported as success is worse than a refusal.
                throw TextWireException("relayium: message is not valid UTF-8 (${plain.size} bytes)")
            }
        }
    }
}

class TextWireException(message: String) : RuntimeException(message)

/**
 * Receiver-enforced session bounds. They bound resource use rather than defining
 * the wire, and they are the same numbers the Web enforces.
 */
object TextSessionLimits {
    const val MAX_MESSAGES = 500
    const val MAX_BYTES = 4 * 1024 * 1024
    const val BURST = 20
    const val PER_SECOND = 5
    const val SEND_BUFFER_MAX = 1024 * 1024
    const val IDLE_MS = 600_000L
    /** How many messages the UI keeps. Memory only; nothing touches disk. */
    const val HISTORY_MAX = 200
}
