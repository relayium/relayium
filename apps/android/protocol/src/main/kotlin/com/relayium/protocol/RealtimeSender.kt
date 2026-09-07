package com.relayium.protocol

/**
 * The file lane's sending half: one GLOBAL sequence counter, transport
 * fragmentation, and the per-file integrity chain.
 *
 * ## The counter is the whole safety argument
 *
 * `seq` is the AES-GCM nonce. It is global across the whole link — the manifest,
 * every chunk piece and every per-file DONE share it — and it ONLY EVER
 * INCREASES. Never per batch, never reset by a cancel, never rewound by a
 * resume. A piece that is sealed and then lost simply burns its number.
 *
 * Sharing one counter is the only safe shape: any scheme that reserved a special
 * number for the manifest would need a separate invariant guaranteeing no chunk
 * ever reaches it, and one more invariant is one more place a nonce can quietly
 * be reused.
 *
 * This class is pure: it produces frames and never touches a socket, so the
 * ordering rules above are testable without a transport.
 */
class RealtimeSender {

    private var seq = 0L

    /** The number the NEXT frame will carry. A resume announcement quotes it. */
    val nextSeq: Long get() = seq

    /**
     * The sealed manifest, fragmented if it does not fit one message.
     *
     * The ceiling is compared against the CIPHERTEXT length: GCM appends a
     * 16-byte tag, so comparing the plaintext would let a critical manifest pass
     * the check and then fail inside the channel's own send.
     */
    fun batchFrames(
        files: List<FileMeta>,
        keys: Crypto.SessionKeys,
        maxFrameBytes: Int,
    ): List<ByteArray> {
        val payload = ManifestCodec.encode(files)
        require(payload.size + Crypto.AEAD_TAG_BYTES <= RealtimeFrame.MANIFEST_MAX_BYTES) {
            "relayium: manifest too large"
        }
        return pieces(
            payload,
            keys,
            RealtimeFrame.piecePlainBytes(maxFrameBytes),
            RealtimeFrame.KIND_BATCH_PART,
            RealtimeFrame.KIND_BATCH_ENC,
        )
    }

    /**
     * Cut one plaintext into sealed frames of at most `pieceBytes` payload, the
     * last carrying `finalKind`.
     *
     * An EMPTY plaintext still yields exactly one (final) frame, and a plaintext
     * that divides evenly yields NO trailing empty frame. Both are wire
     * behaviours a port gets wrong, and both are pinned by the fragmentation
     * fixture (whose second body is zero bytes).
     */
    private fun pieces(
        plain: ByteArray,
        keys: Crypto.SessionKeys,
        pieceBytes: Int,
        partKind: Int,
        finalKind: Int,
    ): List<ByteArray> {
        val out = ArrayList<ByteArray>()
        var offset = 0
        while (true) {
            val end = minOf(offset + pieceBytes, plain.size)
            val last = end >= plain.size
            val s = takeSeq()
            val slice = plain.copyOfRange(offset, end)
            out.add(RealtimeFrame.frame(if (last) finalKind else partKind, s, Crypto.sealFile(keys, s, slice)))
            if (last) return out
            offset = end
        }
    }

    /**
     * One logical chunk's frames.
     *
     * The caller hashes and supplies whole [RealtimeFrame.CHUNK_SIZE] chunks;
     * this method only decides how they are carried. That separation is what
     * keeps the hash chain, the checkpoint grid and the resume contract
     * expressed in CHUNK_SIZE no matter what the connection negotiated.
     */
    fun chunkFrames(chunk: ByteArray, keys: Crypto.SessionKeys, maxFrameBytes: Int): List<ByteArray> =
        pieces(
            chunk,
            keys,
            RealtimeFrame.piecePlainBytes(maxFrameBytes),
            RealtimeFrame.KIND_CHUNK_PART,
            RealtimeFrame.KIND_CHUNK,
        )

    /** The per-file integrity frame. Sealed, and it consumes a number like
     *  everything else. */
    fun doneFrame(chain: ByteArray, keys: Crypto.SessionKeys): ByteArray {
        val s = takeSeq()
        return RealtimeFrame.frame(
            RealtimeFrame.KIND_DONE_ENC,
            s,
            Crypto.sealFile(keys, s, ManifestCodec.encodeDone(Bytes.hex(chain))),
        )
    }

    /**
     * A batch was retired by an ordered BATCH_ABORT barrier.
     *
     * Deliberately does NOTHING to the counter. A cancel is not a key event: the
     * link is still the same link with the same keys, so its nonce space
     * continues across the barrier and the next batch starts at the next unused
     * number. Resetting here would reuse nonces under a key that has already
     * sealed frames at them.
     *
     * It exists as a named no-op rather than as an absence so the invariant is
     * something a test can call and assert, instead of something a reader has to
     * notice is missing.
     */
    fun batchAborted() {
        // Intentionally empty. See the doc comment.
    }

    private fun takeSeq(): Long {
        if (seq > RealtimeFrame.MAX_SEQ) {
            // The wire field is a uint32. Wrapping would reuse a nonce under a
            // key that has already sealed a frame at that number, so the link
            // ends instead. Unreachable in practice: at 192 KiB per chunk this
            // is roughly 800 TB on one link.
            throw SequenceExhaustedException()
        }
        return seq++
    }
}

/** The link's sequence space is spent. Terminal, and never recoverable by
 *  restarting a counter. */
class SequenceExhaustedException : RuntimeException(
    "relayium: this link's frame sequence is exhausted; start a new session",
)

/**
 * The file lane's receiving half.
 *
 * Enforces `seq == expected` on every protected frame, reassembles fragmented
 * logical units before anything hashes or parses them, and bounds what a peer
 * can make it buffer before consent.
 */
class RealtimeReceiver {

    private var expectedSeq = 0L
    private var chain = Crypto.chainStart()
    private val parts = ArrayList<ByteArray>()
    private var partBytes = 0
    private var partKind = 0

    val nextExpectedSeq: Long get() = expectedSeq

    /** A copy of the current file's running chain, for a durable checkpoint. */
    fun snapshotChain(): ByteArray = chain.copyOf()

    /**
     * An ordered BATCH_ABORT has authenticated every frame it followed.
     *
     * Resets ONLY the per-file integrity accumulator and any partial fragment.
     * The global sequence deliberately continues — see [RealtimeSender.batchAborted].
     */
    fun batchAborted() {
        chain = Crypto.chainStart()
        dropParts()
    }

    /**
     * Realign to a peer's announced resume point.
     *
     * FORWARD ONLY. Moving the receive sequence backwards would make an old
     * ciphertext valid again under the same key and number, which is the one
     * thing a resume must never buy. Frames that were emitted and lost simply
     * burn their numbers.
     */
    fun resumeAt(chainSnapshot: ByteArray, seq: Long) {
        if (seq < expectedSeq) {
            throw RealtimeException("relayium: resume sequence moved backwards")
        }
        if (seq > RealtimeFrame.MAX_SEQ) {
            throw RealtimeException("relayium: resume sequence is not representable on the wire")
        }
        chain = chainSnapshot.copyOf()
        expectedSeq = seq
        // Pieces of a chunk the old transport cut in half are worthless: the
        // sender restarts from a whole-chunk boundary.
        dropParts()
    }

    /** What one accepted frame produced. Exactly one field is non-null. */
    sealed interface Output {
        /** A non-final piece was buffered; nothing to act on yet. */
        data object Buffered : Output
        data class Batch(val files: List<FileMeta>) : Output
        data class Chunk(val plaintext: ByteArray) : Output {
            override fun equals(other: Any?) = other is Chunk && plaintext.contentEquals(other.plaintext)
            override fun hashCode() = plaintext.contentHashCode()
        }
        data class Done(val verified: Boolean) : Output
    }

    /**
     * Feed one PROTECTED frame, in wire order.
     *
     * The caller has already classified it ([LinkProtocol.fileFrameClass]) and
     * must not hand anything else here. Plaintext control frames — ACK, resume,
     * the one-byte lifecycle bytes — are the lane owner's business and are never
     * fed to the AEAD.
     */
    fun feed(frame: ByteArray, keys: Crypto.SessionKeys): Output {
        if (frame.size < RealtimeFrame.HEADER_BYTES) throw RealtimeException("relayium: truncated frame")
        val kind = RealtimeFrame.kindOf(frame)
        val seq = RealtimeFrame.seqOf(frame)
        val payload = RealtimeFrame.payloadOf(frame)

        if (kind == RealtimeFrame.KIND_BATCH_LEGACY || kind == RealtimeFrame.KIND_DONE_LEGACY) {
            // NOT parsed, and deliberately not tolerated. A fallback to the
            // plaintext manifest would be a downgrade path a signalling relay
            // could steer a peer onto, and once it exists it never leaves.
            throw RealtimeException(
                "relayium: peer is running an older version of the protocol",
            )
        }

        return when (kind) {
            RealtimeFrame.KIND_CHUNK_PART, RealtimeFrame.KIND_BATCH_PART -> {
                requireSeq(seq, "partial frame")
                val piece = openOrFail(keys, seq, payload)
                expectedSeq++
                addPart(
                    kind,
                    piece,
                    if (kind == RealtimeFrame.KIND_CHUNK_PART) {
                        RealtimeFrame.CHUNK_SIZE
                    } else {
                        RealtimeFrame.MANIFEST_MAX_BYTES
                    },
                )
                Output.Buffered
            }

            RealtimeFrame.KIND_BATCH_ENC -> {
                requireSeq(seq, "manifest")
                val tail = openOrFail(keys, seq, payload)
                expectedSeq++
                val plain = joinParts(RealtimeFrame.KIND_BATCH_PART, tail, RealtimeFrame.MANIFEST_MAX_BYTES)
                Output.Batch(ManifestCodec.decode(plain))
            }

            RealtimeFrame.KIND_CHUNK -> {
                requireSeq(seq, "chunk")
                val tail = openOrFail(keys, seq, payload)
                expectedSeq++
                // The WHOLE logical chunk, however many messages carried it, so
                // the chain hash and the caller's write both see the CHUNK_SIZE
                // unit.
                val plain = joinParts(RealtimeFrame.KIND_CHUNK_PART, tail, RealtimeFrame.CHUNK_SIZE)
                chain = Crypto.chainAdvance(chain, plain)
                Output.Chunk(plain)
            }

            RealtimeFrame.KIND_DONE_ENC -> {
                requireSeq(seq, "done")
                val plain = openOrFail(keys, seq, payload)
                expectedSeq++
                // A file cannot end in the middle of a chunk. Leftover pieces
                // mean the two sides' framing disagrees; hashing a short chunk
                // would produce a mismatch reported as corruption.
                if (partBytes > 0) throw RealtimeException("relayium: file ended mid-chunk")
                val claimed = ManifestCodec.decodeDone(plain)
                val actual = Bytes.hex(chain)
                chain = Crypto.chainStart()
                Output.Done(claimed != null && claimed == actual)
            }

            else -> throw RealtimeException("relayium: unknown frame kind $kind")
        }
    }

    private fun requireSeq(seq: Long, what: String) {
        if (seq != expectedSeq) throw RealtimeException("relayium: out-of-order $what")
    }

    private fun openOrFail(keys: Crypto.SessionKeys, seq: Long, payload: ByteArray): ByteArray = try {
        Crypto.openFile(keys, seq, payload)
    } catch (e: java.security.GeneralSecurityException) {
        throw RealtimeException("relayium: frame failed authentication")
    }

    /**
     * Buffer one non-final piece.
     *
     * Three separate bounds, because plaintext bytes alone do not bound
     * anything: a peer can authenticate an unlimited number of ZERO-LENGTH
     * partial frames, every one of which is retained while the byte counter
     * stays at zero.
     *
     * - An empty non-final piece is REFUSED. `RealtimeSender.pieces` cannot emit
     *   one: a non-final piece is always exactly `pieceBytes`, which
     *   `piecePlainBytes` floors at [RealtimeFrame.MIN_PIECE_BYTES]. So an empty
     *   one is not a small frame, it is a frame no conforming sender produces.
     * - The COUNT is bounded independently of the size, at the protocol floor
     *   rather than at this connection's piece size — the receiver does not know
     *   what the sender negotiated.
     * - The byte total is bounded as before.
     */
    private fun addPart(kind: Int, plain: ByteArray, limit: Int) {
        if (partKind != 0 && partKind != kind) {
            throw RealtimeException("relayium: interleaved partial frames")
        }
        if (plain.isEmpty()) {
            throw RealtimeException("relayium: empty non-final fragment")
        }
        if (parts.size + 1 > maxParts(limit)) {
            throw RealtimeException("relayium: too many fragments for one logical unit")
        }
        if (partBytes.toLong() + plain.size > limit) {
            throw RealtimeException("relayium: oversized fragmented frame")
        }
        partKind = kind
        parts.add(plain)
        partBytes += plain.size
    }

    /** The most non-final pieces a conforming sender can cut one logical unit
     *  into, at the protocol's minimum piece size. */
    private fun maxParts(limit: Int): Int = limit / RealtimeFrame.MIN_PIECE_BYTES

    /**
     * Join the buffered pieces with the terminating frame's plaintext.
     *
     * The limit is checked BEFORE the "nothing buffered" shortcut, because it
     * bounds the LOGICAL UNIT rather than the fragmentation. A peer that skips
     * the PART kinds entirely and sends one authenticated oversized terminal
     * frame is the cheapest way to hand a receiver an arbitrarily large
     * plaintext to hash or JSON-parse before any consent — which is the whole
     * thing the part accumulator exists to prevent.
     */
    private fun joinParts(kind: Int, tail: ByteArray, limit: Int): ByteArray {
        if (partKind != 0 && partKind != kind) {
            throw RealtimeException("relayium: interleaved partial frames")
        }
        if (partBytes.toLong() + tail.size > limit) {
            throw RealtimeException("relayium: oversized frame")
        }
        // dropParts() on EVERY path, including the nothing-buffered one. The
        // shortcut used to return before it, so a partial state that carried a
        // kind but no bytes survived into the next logical unit.
        if (partBytes == 0) {
            dropParts()
            return tail
        }
        val out = ByteArray(partBytes + tail.size)
        var at = 0
        for (part in parts) {
            part.copyInto(out, at)
            at += part.size
        }
        tail.copyInto(out, at)
        dropParts()
        return out
    }

    private fun dropParts() {
        parts.clear()
        partBytes = 0
        partKind = 0
    }
}

/** A file-lane protocol failure. Every one of these fails the LANE; none is
 *  recoverable by skipping the frame, because the peer counted it. */
class RealtimeException(message: String) : RuntimeException(message)
