package com.relayium.protocol

/**
 * The 59-byte data-path control frame that proves a migration actually moved
 * the media path — `relay-renew-v1.md` section 6.1.
 *
 * ```
 * [0x0d][ver=1][type][epoch u32BE][round u32BE][nonce 16B][tag 32B]
 * ```
 *
 * ## Why a dedicated kind and not the text codec
 *
 * `0x0d` is outside every kind already in use — file lane 1–8, text 9,
 * pre-upload 12 and the lifecycle bytes — and `relayium-link-v1.md` section 7.3
 * already requires a text-lane frame whose first byte is not `0x09` to be
 * SILENTLY IGNORED. That is what makes this frame safe to send to a peer that
 * has never heard of renewal.
 *
 * Routing a handshake through ordinary kind-9 content would instead be a hard
 * failure on all three clients whenever the conversation is not open — this
 * module's own [TextLaneSession] answers `CONTENT_BEFORE_ACTIVATION` — and it
 * would consume the strictly increasing AEAD `seq`. This frame consumes no
 * sequence and changes no file or text semantics.
 *
 * ## What the tag does and does not prove
 *
 * The HMAC authenticates key possession and freshness. It does NOT authenticate
 * the route. The path evidence is local observation of the selected candidate's
 * generation, plus the peer's own observation, which is the only thing that
 * makes it send an ack. Nothing in this file may be read as route proof.
 */
object RelayRenewProbe {

    /** The registered first byte. Outside every kind in use. */
    const val KIND = 13

    const val VERSION = 1
    const val TYPE_PROBE = 1
    const val TYPE_ACK = 2

    const val NONCE_BYTES = 16
    const val TAG_BYTES = 32

    /** The EXACT length. A frame of any other length is a reject. */
    const val FRAME_BYTES = 2 + 1 + 4 + 4 + NONCE_BYTES + TAG_BYTES

    private const val OFFSET_TYPE = 2
    private const val OFFSET_EPOCH = 3
    private const val OFFSET_ROUND = 7
    private const val OFFSET_NONCE = 11
    private const val OFFSET_TAG = OFFSET_NONCE + NONCE_BYTES

    /**
     * Whether this text-lane frame belongs to the renewal demux, by FIRST BYTE
     * alone.
     *
     * Deliberately not "is a valid probe". The demux has to consume every frame
     * that claims this kind, including a malformed one: passing a 58-byte
     * `0x0d` frame through to the text session would spend one of its inbound
     * rate-budget tokens and reset the ten-minute idle clock, which is exactly
     * what section 6.2 forbids. Validity is [decode]'s job, and its answer is
     * "drop", not "forward".
     */
    fun isControlFrame(frame: ByteArray): Boolean =
        frame.isNotEmpty() && (frame[0].toInt() and 0xff) == KIND

    /** One decoded control frame. The tag is NOT verified here. */
    data class Frame(
        val type: Int,
        val epoch: Long,
        val round: Long,
        val nonce: ByteArray,
        val tag: ByteArray,
    ) {
        val isProbe: Boolean get() = type == TYPE_PROBE

        override fun equals(other: Any?) = other is Frame &&
            other.type == type && other.epoch == epoch && other.round == round &&
            other.nonce.contentEquals(nonce) && other.tag.contentEquals(tag)

        override fun hashCode(): Int {
            var result = type
            result = 31 * result + epoch.hashCode()
            result = 31 * result + round.hashCode()
            result = 31 * result + nonce.contentHashCode()
            result = 31 * result + tag.contentHashCode()
            return result
        }
    }

    /**
     * Read a control frame, or null.
     *
     * Cheap bounds first, exactly in the order section 6.4 states: length, kind
     * byte, version, type. Nothing here allocates on a frame it will refuse
     * beyond the two field copies, and nothing here spends an HMAC.
     */
    fun decode(frame: ByteArray): Frame? {
        if (frame.size != FRAME_BYTES) return null
        if ((frame[0].toInt() and 0xff) != KIND) return null
        if ((frame[1].toInt() and 0xff) != VERSION) return null
        val type = frame[OFFSET_TYPE].toInt() and 0xff
        if (type != TYPE_PROBE && type != TYPE_ACK) return null
        return Frame(
            type = type,
            epoch = Bytes.readUInt32(frame, OFFSET_EPOCH),
            round = Bytes.readUInt32(frame, OFFSET_ROUND),
            nonce = frame.copyOfRange(OFFSET_NONCE, OFFSET_NONCE + NONCE_BYTES),
            tag = frame.copyOfRange(OFFSET_TAG, FRAME_BYTES),
        )
    }

    /** Build one control frame. */
    fun encode(type: Int, epoch: Long, round: Long, nonce: ByteArray, tag: ByteArray): ByteArray {
        require(type == TYPE_PROBE || type == TYPE_ACK) { "type is probe or ack" }
        require(RelayRenewWire.isUint32(epoch) && RelayRenewWire.isUint32(round)) {
            "epoch and round are uint32"
        }
        require(nonce.size == NONCE_BYTES) { "the nonce is $NONCE_BYTES bytes" }
        require(tag.size == TAG_BYTES) { "the tag is $TAG_BYTES raw bytes" }
        val out = ByteArray(FRAME_BYTES)
        out[0] = KIND.toByte()
        out[1] = VERSION.toByte()
        out[OFFSET_TYPE] = type.toByte()
        Bytes.writeUInt32(out, OFFSET_EPOCH, epoch)
        Bytes.writeUInt32(out, OFFSET_ROUND, round)
        nonce.copyInto(out, OFFSET_NONCE)
        tag.copyInto(out, OFFSET_TAG)
        return out
    }

    // ── signing, and why it lives here ──────────────────────────────────────
    //
    // The tag rides the frame RAW while this module's only HMAC primitive
    // speaks standard padded base64, and the raw/encoded conversion belongs
    // beside the frame rather than in every caller. It also keeps the byte
    // helpers — which are internal to this module — out of the app layer, so
    // the engine that drives a `PeerConnection` handles no key material and no
    // encoding of its own.

    /** A freshly signed probe or ack frame, or null if the key is unusable. */
    fun sign(
        keys: Crypto.SessionKeys,
        type: Int,
        from: String,
        to: String,
        epoch: Long,
        round: Long,
        nonce: ByteArray,
    ): ByteArray? {
        if (nonce.size != NONCE_BYTES) return null
        val tag = Bytes.unbase64OrNull(
            Crypto.signAuth(keys, payload(type, from, to, epoch, round, Bytes.base64(nonce))),
        ) ?: return null
        return encode(type, epoch, round, nonce, tag)
    }

    /**
     * Whether a decoded frame's tag is this link's, for the direction stated.
     *
     * [from] is the SENDER and [to] this client, so a relay reflecting a probe
     * back at its sender verifies the reversed tuple and fails — the same
     * property a link leave's payload has, and for the same reason.
     */
    fun verify(keys: Crypto.SessionKeys, frame: Frame, from: String, to: String): Boolean {
        val payload = payload(
            frame.type, from, to, frame.epoch, frame.round, Bytes.base64(frame.nonce),
        )
        return Crypto.verifyAuth(keys, payload, Bytes.base64(frame.tag))
    }

    /** A nonce's canonical key, for the bounded already-acked map. */
    fun nonceKey(nonce: ByteArray): String = Bytes.base64(nonce)

    /** Constant-time nonce comparison, for matching an ack to this side's own. */
    fun nonceEquals(a: ByteArray, b: ByteArray): Boolean = Bytes.constantTimeEquals(a, b)

    /**
     * The EXACT bytes a probe or ack tag covers.
     *
     * The domain-separating `kind` is what makes a probe and its ack different
     * strings, so an observed probe cannot be replayed back as its own ack; the
     * `from`/`to` tuple closes reflection for the same reason a leave's does;
     * and the per-attempt random nonce closes replay across attempts. The nonce
     * is carried as STANDARD PADDED base64, the same encoding the rest of this
     * protocol's tags and keys use.
     */
    fun payload(
        type: Int,
        from: String,
        to: String,
        epoch: Long,
        round: Long,
        nonceBase64: String,
    ): String {
        require(type == TYPE_PROBE || type == TYPE_ACK) { "type is probe or ack" }
        return Json.stringify(
            Json.obj(
                "kind" to Json.of(if (type == TYPE_PROBE) "link-renew-probe" else "link-renew-ack"),
                "from" to Json.of(from),
                "to" to Json.of(to),
                "epoch" to Json.of(epoch),
                "round" to Json.of(round),
                "nonce" to Json.of(nonceBase64),
            ),
        )
    }
}
