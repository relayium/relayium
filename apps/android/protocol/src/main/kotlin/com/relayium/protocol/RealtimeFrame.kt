package com.relayium.protocol

/**
 * The file lane's byte layout: `[kind: 1][seq: uint32 BE][payload]`.
 *
 * Authoritative prose: `docs/protocol/relayium-realtime-wire-v1.md` for the
 * bytes, `docs/protocol/relayium-link-v1.md` section 6 for what `link/1` adds.
 * Golden bytes: `apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json`.
 */
object RealtimeFrame {

    // ── kinds ───────────────────────────────────────────────────────────────

    /** Last (or only) piece of one logical chunk. */
    const val KIND_CHUNK = 1
    /** Plaintext, pre-`link/1` DONE. Recognised so it can be REFUSED, never parsed. */
    const val KIND_DONE_LEGACY = 2
    /** Plaintext, pre-`link/1` manifest. Same. */
    const val KIND_BATCH_LEGACY = 3
    /** Plaintext, sender to receiver: where a resumed stream picks up. */
    const val KIND_RESUME_START = 4
    /** Plaintext, receiver to sender: the last durably-written point. */
    const val KIND_RESUME_REQ = 5
    /** Plaintext, receiver to sender: cumulative durably-written bytes. */
    const val KIND_ACK = 6
    /** Last (or only) piece of the sealed manifest. */
    const val KIND_BATCH_ENC = 7
    /** The per-file chained digest, sealed. */
    const val KIND_DONE_ENC = 8
    /** One message. Lives on the TEXT lane; on the file lane it is unroutable. */
    const val KIND_TEXT_ENC = 9
    /** A non-final piece of a logical chunk. */
    const val KIND_CHUNK_PART = 10
    /** A non-final piece of the manifest. */
    const val KIND_BATCH_PART = 11
    /**
     * The pre-upload key handoff. This client does not announce `preupload/1`,
     * so it can never legally receive one, and it is classified UNROUTABLE —
     * exactly as the Apple clients do. Named so that classification is a
     * decision rather than a default.
     */
    const val KIND_STORED_KEYS = 12

    // ── control bytes ───────────────────────────────────────────────────────

    /** Receiver to sender: this batch is consented to. Shared with the text lane. */
    const val CTRL_ACCEPT = 0xfe
    /** Receiver to sender: refused, or an accepted batch stopped. Shared. */
    const val CTRL_REJECT = 0xff
    /** Receiver to sender: the whole batch arrived AND verified. */
    const val CTRL_COMPLETE = 0xfd
    /** Receiver to sender: the lane is occupied. Requeue, not a refusal. */
    const val CTRL_BUSY = 0xf9
    /** Sender to receiver: an ordered barrier retiring exactly this batch. */
    const val CTRL_BATCH_ABORT = 0xf8

    val ACCEPT = byteArrayOf(CTRL_ACCEPT.toByte())
    val REJECT = byteArrayOf(CTRL_REJECT.toByte())
    val COMPLETE = byteArrayOf(CTRL_COMPLETE.toByte())
    val BUSY = byteArrayOf(CTRL_BUSY.toByte())
    val BATCH_ABORT = byteArrayOf(CTRL_BATCH_ABORT.toByte())

    // ── sizes ───────────────────────────────────────────────────────────────

    const val HEADER_BYTES = 5
    /** 5-byte header + 16-byte GCM tag. */
    const val OVERHEAD = HEADER_BYTES + Crypto.AEAD_TAG_BYTES

    /**
     * The **logical** chunk: the unit the integrity chain hashes, the unit the
     * receiver writes and checkpoints, and therefore the unit a resume point
     * must land on. A constant of the wire; it does not vary with the connection.
     */
    const val CHUNK_SIZE = 192 * 1024

    /** The manifest ceiling, compared against the CIPHERTEXT length. */
    const val MANIFEST_MAX_BYTES = 200 * 1024

    /** Below this a connection is not worth using; a named error, not a crawl. */
    const val MIN_PIECE_BYTES = 4096

    /** RFC 8841's default: what a peer advertising nothing can accept. */
    const val CONSERVATIVE_MAX_FRAME_BYTES = 65_536

    /** The sender's lead over the receiver's latest durable ACK. */
    const val FLOW_WINDOW_BYTES = 8L * 1024 * 1024
    /** The receiver ACKs at least this often. */
    const val FLOW_ACK_INTERVAL_BYTES = 512L * 1024

    /** The wire sequence is uint32. */
    const val MAX_SEQ = 0xffff_ffffL

    /** An ACK frame is exactly this long, and 13 bytes is part of what an ACK IS. */
    const val ACK_FRAME_BYTES = HEADER_BYTES + 8

    // ── framing ─────────────────────────────────────────────────────────────

    fun frame(kind: Int, seq: Long, payload: ByteArray): ByteArray {
        require(seq in 0..MAX_SEQ) { "seq $seq does not fit the uint32 wire field" }
        val out = ByteArray(HEADER_BYTES + payload.size)
        out[0] = kind.toByte()
        Bytes.writeUInt32(out, 1, seq)
        payload.copyInto(out, HEADER_BYTES)
        return out
    }

    fun kindOf(frame: ByteArray): Int = if (frame.isEmpty()) -1 else frame[0].toInt() and 0xff

    fun seqOf(frame: ByteArray): Long {
        require(frame.size >= HEADER_BYTES) { "frame is shorter than its header" }
        return Bytes.readUInt32(frame, 1)
    }

    fun payloadOf(frame: ByteArray): ByteArray {
        require(frame.size >= HEADER_BYTES) { "frame is shorter than its header" }
        return frame.copyOfRange(HEADER_BYTES, frame.size)
    }

    /**
     * The plaintext one DataChannel message may carry on THIS connection.
     *
     * Capped at [CHUNK_SIZE]: a larger allowance buys nothing, because the hash
     * chain and the checkpoint grid are defined in that unit. Against a real
     * browser the negotiated ceiling is routinely 65 536, giving 65 515 — so
     * every logical chunk fragments, and PART framing is required from the first
     * build rather than being a later optimisation.
     */
    fun piecePlainBytes(maxFrameBytes: Int): Int {
        val usable = minOf(maxFrameBytes - OVERHEAD, CHUNK_SIZE)
        require(usable >= MIN_PIECE_BYTES) {
            "relayium: this connection's maximum message size ($maxFrameBytes) is too small to send files"
        }
        return usable
    }

    // ── flow control ────────────────────────────────────────────────────────

    /**
     * `[0x06][uint32 BE 0][Float64 BE bytesWritten]`, exactly 13 bytes.
     *
     * The value is a DURABILITY claim: `n` cumulative bytes of this batch have
     * reached the file descriptor, not a buffer. See `relayium-link-v1.md`
     * section 9.1.
     */
    fun ackFrame(bytesWritten: Long): ByteArray {
        require(bytesWritten >= 0) { "an ACK counts bytes, never a negative" }
        val payload = ByteArray(8)
        Bytes.writeFloat64(payload, 0, bytesWritten.toDouble())
        return frame(KIND_ACK, 0, payload)
    }

    /** Decode an ACK, or null. Length and kind both, because a kind-6 frame of
     *  another length is NOT an ACK and must not fall through anywhere else. */
    fun parseAck(frame: ByteArray): Long? {
        if (frame.size != ACK_FRAME_BYTES || kindOf(frame) != KIND_ACK) return null
        val value = Bytes.readFloat64(frame, HEADER_BYTES)
        if (!value.isFinite() || value < 0 || value > MAX_SAFE_INTEGER) return null
        val asLong = value.toLong()
        return if (asLong.toDouble() == value) asLong else null
    }

    /**
     * Advance a batch-local cumulative ACK only within bytes this attempt has
     * actually emitted.
     *
     * ACK carries no batch identifier; this clamp is what stands in for one. A
     * delayed, duplicated or forged cumulative value cannot open a later batch's
     * whole window.
     */
    fun advanceAck(acked: Long, sent: Long, candidate: Long): Long =
        if (candidate > acked && candidate <= sent) candidate else acked

    /** JavaScript's exact-integer ceiling; the browser's ACK cannot exceed it. */
    private const val MAX_SAFE_INTEGER = 9007199254740991.0

    // ── resume control ──────────────────────────────────────────────────────

    data class ResumePoint(val index: Int, val offset: Long)

    /** `{"index":n,"offset":n}` in that key order, plaintext, consuming no seq. */
    fun resumeRequestFrame(point: ResumePoint): ByteArray = frame(
        KIND_RESUME_REQ,
        0,
        Json.stringify(
            Json.obj("index" to Json.of(point.index.toLong()), "offset" to Json.of(point.offset)),
        ).toByteArray(Charsets.UTF_8),
    )

    /** `{"index":n,"offset":n,"seq":n}` in that key order — the Web's
     *  `{...point, seq}` spread order, which is what a byte comparison sees. */
    fun resumeStartFrame(point: ResumePoint, seq: Long): ByteArray = frame(
        KIND_RESUME_START,
        0,
        Json.stringify(
            Json.obj(
                "index" to Json.of(point.index.toLong()),
                "offset" to Json.of(point.offset),
                "seq" to Json.of(seq),
            ),
        ).toByteArray(Charsets.UTF_8),
    )

    /**
     * Decode a resume request, or null for "this is not a sane resume point".
     *
     * The shape is pinned HERE, at the parse boundary, because the sender feeds
     * these two numbers straight into a file slice: a negative offset makes it
     * read from the END of the file, and a huge index makes it skip every file
     * and idle silently. Non-negative integers only; the RANGE check needs the
     * manifest and belongs to the caller.
     */
    fun parseResumeRequest(frame: ByteArray): ResumePoint? {
        if (frame.size < HEADER_BYTES || kindOf(frame) != KIND_RESUME_REQ) return null
        val body = Json.parseOrNull(String(payloadOf(frame), Charsets.UTF_8)) as? Json.Obj ?: return null
        val index = nonNegativeInt(body["index"]) ?: return null
        val offset = nonNegativeLong(body["offset"]) ?: return null
        return ResumePoint(index, offset)
    }

    data class ResumeStart(val point: ResumePoint, val seq: Long)

    /**
     * Decode a resume announcement, or null.
     *
     * `seq` is additionally bounded by [MAX_SEQ]. `relayium-link-v1.md` section
     * 12.1: the wire field is a uint32, so a `seq` at or above 2^32 can never
     * match a real frame's on-wire value. The shipped Web receiver accepts one
     * and then stalls until a watchdog; this refuses it outright, which is a
     * strict subset of what the Web accepts and therefore cannot break interop.
     */
    fun parseResumeStart(frame: ByteArray): ResumeStart? {
        if (frame.size < HEADER_BYTES || kindOf(frame) != KIND_RESUME_START) return null
        val body = Json.parseOrNull(String(payloadOf(frame), Charsets.UTF_8)) as? Json.Obj ?: return null
        val index = nonNegativeInt(body["index"]) ?: return null
        val offset = nonNegativeLong(body["offset"]) ?: return null
        val seq = nonNegativeLong(body["seq"]) ?: return null
        if (seq > MAX_SEQ) return null
        return ResumeStart(ResumePoint(index, offset), seq)
    }

    private fun nonNegativeLong(value: Json?): Long? {
        val n = (value as? Json.Num)?.value ?: return null
        if (!n.isFinite() || n < 0 || n > MAX_SAFE_INTEGER) return null
        val asLong = n.toLong()
        return if (asLong.toDouble() == n) asLong else null
    }

    private fun nonNegativeInt(value: Json?): Int? {
        val n = nonNegativeLong(value) ?: return null
        return if (n <= Int.MAX_VALUE) n.toInt() else null
    }

    /**
     * Is this a point the sender can actually restart from?
     *
     * The chain hash is defined only at [CHUNK_SIZE] boundaries and at the exact
     * end of a file. An unaligned point can only come from a peer that is not
     * following this protocol or from a relay-injected frame, and honouring one
     * would make the sender skip the bytes between the request and the next
     * boundary.
     */
    fun resumePointAligned(point: ResumePoint, sizes: List<Long>): Boolean {
        val size = sizes.getOrNull(point.index) ?: return false
        return point.offset == size || point.offset % CHUNK_SIZE == 0L
    }

    /** Does the point name a file in this batch, at an offset inside it? */
    fun resumePointInRange(point: ResumePoint, sizes: List<Long>): Boolean {
        val size = sizes.getOrNull(point.index) ?: return false
        return point.offset <= size
    }
}
