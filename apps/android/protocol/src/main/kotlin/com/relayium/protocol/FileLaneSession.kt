package com.relayium.protocol

/**
 * The file lane's state machine, as a PURE function of the frames and the local
 * events it is given.
 *
 * ## Why this is pure
 *
 * Every rule worth getting right here is a rule about ORDER: consent before
 * content, handler before ACCEPT, durable bytes before ACK, verification before
 * COMPLETE, a barrier that retires one batch and not the link. None of them
 * needs a socket, a file descriptor or a coroutine to be true, and all of them
 * are unreasonably hard to test through a real WebRTC connection.
 *
 * So the transport hands frames in and performs the [Action]s that come out, and
 * the whole ordering contract is exercised by ordinary unit tests on a runner
 * with no Android SDK.
 *
 * ## One instance per LINK, not per batch
 *
 * It owns the link's [RealtimeSender] and [RealtimeReceiver], and therefore the
 * global sequence counter. A new batch, or a cancelled one, reuses this object;
 * constructing a second would restart a counter under a key that has already
 * sealed frames at those numbers.
 */
class FileLaneSession(
    private val keys: Crypto.SessionKeys,
    private val maxFrameBytes: Int,
    private val sender: RealtimeSender = RealtimeSender(),
    private val receiver: RealtimeReceiver = RealtimeReceiver(),
) {

    companion object {
        /** The bounded wait for the sender's BATCH_ABORT after a receiver-side
         *  cancel, re-armed by each drained frame. */
        const val ABORT_BARRIER_TIMEOUT_MS = 30_000L
    }

    // ── what the transport must do ──────────────────────────────────────────

    sealed interface Action {
        /** Put these exact bytes on the file lane, in this order. */
        data class Send(val frame: ByteArray) : Action {
            override fun equals(other: Any?) = other is Send && frame.contentEquals(other.frame)
            override fun hashCode() = frame.contentHashCode()
        }
        /** Ask the user about an incoming batch. Names are already sanitised. */
        data class Prompt(val files: List<FileMeta>) : Action
        /** Write this plaintext at this file/offset, DURABLY, then report back
         *  through [onDurableBytes]. */
        data class Write(val fileIndex: Int, val offset: Long, val plaintext: ByteArray) : Action {
            override fun equals(other: Any?) =
                other is Write && other.fileIndex == fileIndex && other.offset == offset &&
                    plaintext.contentEquals(other.plaintext)
            override fun hashCode() = (fileIndex * 31 + offset.hashCode()) * 31 + plaintext.contentHashCode()
        }
        /** This file's chained digest verified. Safe to export from staging. */
        data class FileVerified(val fileIndex: Int) : Action
        /** This file's digest did NOT verify. Discard its staging; never export. */
        data class FileCorrupt(val fileIndex: Int) : Action
        /** The whole incoming batch is verified and exported. */
        data object ReceiveComplete : Action
        /** The whole outgoing batch was acknowledged complete by the peer. */
        data object SendComplete : Action
        /** Discard everything staged for the current incoming batch. */
        data object DiscardIncoming : Action
        /** A failure, scoped by [Failure.Scope]: SEND and RECEIVE retire one
         *  direction's batch, LANE ends this lane. The TEXT lane survives all
         *  of them. */
        data class Fail(val failure: Failure) : Action
    }

    data class Failure(val reason: Reason, val scope: Scope) {
        enum class Reason {
            UNROUTABLE_FRAME,
            CONTENT_BEFORE_CONSENT,
            PROTOCOL,
            LEGACY_PEER,
            RESUME_UNSUPPORTED,
            PEER_REJECTED,
            PEER_BUSY,
            LOCAL_CANCEL,
            INTEGRITY,
            SEQUENCE_EXHAUSTED,
        }

        /**
         * What a failure retires. Cancellation is DIRECTION-SPECIFIC: a
         * cancelled outgoing batch must not reset an incoming batch mid-write,
         * and the reverse — a boolean that reset both sides was how one
         * direction's cancel silently corrupted the other's state.
         */
        enum class Scope {
            /** Retires the outgoing batch. Receive side untouched. */
            SEND,
            /** Retires the incoming batch. Send side untouched. */
            RECEIVE,
            /** Terminal for the whole lane. The TEXT lane still survives. */
            LANE,
        }
    }

    // ── outbound ────────────────────────────────────────────────────────────

    enum class SendState { IDLE, WAITING_ACCEPT, SENDING, FINISHING, DONE, FAILED }

    var sendState: SendState = SendState.IDLE
        private set

    private var outgoing: List<FileMeta> = emptyList()
    private var acked = 0L
    private var sentBytes = 0L

    /**
     * Bytes the sender may still put on the wire before an ACK must arrive.
     *
     * `sentBytes` and `acked` are both CONTENT PLAINTEXT bytes, and they have to
     * be: the receiver ACKs bytes it durably wrote, which never include the
     * 5-byte header or the 16-byte tag. Counting sealed frame sizes here would
     * make the window shrink by 21 bytes per piece with no ACK that could ever
     * return them, so a long transfer stalls — at a 64 KiB ceiling that is one
     * lost byte of window per ~3 KB sent.
     *
     * This is the same accounting `mixed-file-session.svelte.ts` does
     * (`sentBytes += data.byteLength - CHUNK_OVERHEAD`, and only for chunk
     * frames). The manifest and DONE are deliberately outside it on both sides.
     *
     * SCTP `bufferedAmount` backpressure is a SEPARATE bound the transport
     * applies; it is about the socket, not about the peer's disk.
     */
    val sendCredit: Long get() = RealtimeFrame.FLOW_WINDOW_BYTES - (sentBytes - acked)

    /** Content plaintext bytes emitted for the current batch. */
    val sentContentBytes: Long get() = sentBytes

    /** The peer's latest durable acknowledgement for the current batch. */
    val ackedContentBytes: Long get() = acked

    /**
     * Begin one outgoing batch: the sealed manifest, and nothing else.
     *
     * Content waits for the peer's answer. That is the consent gate seen from
     * this side, and it is why a sender never speculatively streams.
     */
    fun startBatch(files: List<FileMeta>): List<Action> {
        // IDLE or DONE. A COMPLETED batch is a terminal state of the BATCH, not
        // of the link: the same lane carries the next one, on the same keys and
        // the same never-rewound sequence. Requiring IDLE made one successful
        // transfer permanently retire a working link, and the only way out
        // would have been a second session — i.e. reset counters under a key
        // that has already sealed frames at those numbers.
        check(sendState == SendState.IDLE || sendState == SendState.DONE) {
            "a batch is already in flight"
        }
        require(files.isNotEmpty()) { "a batch with no files is not a batch" }
        outgoing = files
        // Per-BATCH accounting resets; the sequence counter deliberately does
        // not. ACK is batch-local cumulative, which is what `advanceAck`'s
        // clamp against `sentBytes` depends on.
        acked = 0
        sentBytes = 0
        val frames = try {
            sender.batchFrames(files, keys, maxFrameBytes)
        } catch (e: SequenceExhaustedException) {
            return fail(Failure(Failure.Reason.SEQUENCE_EXHAUSTED, Failure.Scope.LANE))
        }
        sendState = SendState.WAITING_ACCEPT
        return frames.map { Action.Send(it) }
    }

    /**
     * Hand one whole logical chunk to the wire.
     *
     * The caller streams [RealtimeFrame.CHUNK_SIZE] chunks and does the hashing;
     * this fragments them for the negotiated message size. Refuses while the
     * flow window is closed rather than queuing without bound.
     */
    fun sendChunk(chunk: ByteArray): List<Action> {
        check(sendState == SendState.SENDING) { "not sending" }
        require(chunk.size <= RealtimeFrame.CHUNK_SIZE) { "a logical chunk is at most CHUNK_SIZE" }
        val frames = try {
            sender.chunkFrames(chunk, keys, maxFrameBytes)
        } catch (e: SequenceExhaustedException) {
            return fail(Failure(Failure.Reason.SEQUENCE_EXHAUSTED, Failure.Scope.LANE))
        }
        // The pieces' plaintexts concatenate to exactly this chunk, so summing
        // `frame.size - OVERHEAD` per piece and adding `chunk.size` are the same
        // number. The sum is written out because it is what the Web does per
        // frame, and a fragmented send must not drift from an unfragmented one.
        sentBytes += frames.sumOf { (it.size - RealtimeFrame.OVERHEAD).toLong() }
        return frames.map { Action.Send(it) }
    }

    fun sendDone(chain: ByteArray): List<Action> {
        check(sendState == SendState.SENDING) { "not sending" }
        val frame = try {
            sender.doneFrame(chain, keys)
        } catch (e: SequenceExhaustedException) {
            return fail(Failure(Failure.Reason.SEQUENCE_EXHAUSTED, Failure.Scope.LANE))
        }
        // DONE carries no content, so it does not spend window — the receiver
        // never ACKs bytes for it either.
        return listOf(Action.Send(frame))
    }

    /** Every file's frames are out; wait for the peer's COMPLETE. */
    fun finishSending(): List<Action> {
        check(sendState == SendState.SENDING) { "not sending" }
        sendState = SendState.FINISHING
        return emptyList()
    }

    /**
     * Cancel the outgoing batch.
     *
     * Emits the ordered `0xf8` barrier and NOTHING else. It is not a
     * disconnection: the sequence continues, the text lane is untouched, and the
     * next batch may start on this same link. Closing the peer connection here
     * is the legacy behaviour `link/1` replaced, and it destroys the
     * conversation along with the transfer nobody wanted.
     */
    fun cancelOutgoing(): List<Action> {
        if (sendState == SendState.IDLE || sendState == SendState.DONE || sendState == SendState.FAILED) {
            return emptyList()
        }
        sender.batchAborted()
        sendState = SendState.IDLE
        return listOf(
            Action.Send(RealtimeFrame.BATCH_ABORT),
            Action.Fail(Failure(Failure.Reason.LOCAL_CANCEL, Failure.Scope.SEND)),
        )
    }

    // ── inbound ─────────────────────────────────────────────────────────────

    enum class ReceiveState {
        IDLE, PROMPT, RECEIVING, VERIFYING, DONE, FAILED,
        /**
         * This side cancelled an ACCEPTED batch and is waiting for the sender's
         * ordered BATCH_ABORT. Frames the sender sealed before it saw the
         * REJECT consumed sequence numbers, so they are still authenticated —
         * and discarded, never written. Dropping them instead would strand the
         * receive sequence for the rest of the link.
         */
        DRAINING,
    }

    var receiveState: ReceiveState = ReceiveState.IDLE
        private set

    private var incoming: List<FileMeta> = emptyList()
    private var fileIndex = 0
    private var fileOffset = 0L
    /** Content plaintext bytes accepted for the current incoming batch. */
    private var batchWritten = 0L
    /** Content bytes authenticated-and-discarded while DRAINING, bounded. */
    private var drainedBytes = 0L
    private var lastAckSent = 0L
    private var durableBytes = 0L
    private var verified = 0

    /**
     * Whether the lane owner has attached its receive handler.
     *
     * ACCEPT may not be sent until this is true. A DataChannel message
     * dispatched with no listener is dropped and there is no replay, so
     * answering first loses whatever the peer sends the instant it sees the
     * answer. [acceptIncoming] refuses rather than emitting an early ACCEPT.
     */
    var receiverAttached: Boolean = false
        private set

    /** Content plaintext bytes this side has accepted for the current incoming
     *  batch. Compared against the manifest total by the storage layer. */
    val receivedContentBytes: Long get() = batchWritten

    /** The files of the incoming batch currently being prompted or received. */
    val incomingFiles: List<FileMeta> get() = incoming

    /** The files of the outgoing batch currently in flight. */
    val outgoingFiles: List<FileMeta> get() = outgoing

    fun attachReceiver() {
        receiverAttached = true
    }

    /** Accept the prompted batch. */
    fun acceptIncoming(): List<Action> {
        check(receiveState == ReceiveState.PROMPT) { "no batch is waiting for an answer" }
        check(receiverAttached) {
            "attach the receive handler BEFORE sending ACCEPT: a frame dispatched with no listener is lost"
        }
        receiveState = ReceiveState.RECEIVING
        fileIndex = 0
        fileOffset = 0
        batchWritten = 0
        lastAckSent = 0
        durableBytes = 0
        verified = 0
        return listOf(Action.Send(RealtimeFrame.ACCEPT))
    }

    fun rejectIncoming(): List<Action> {
        check(receiveState == ReceiveState.PROMPT) { "no batch is waiting for an answer" }
        receiveState = ReceiveState.IDLE
        incoming = emptyList()
        return listOf(Action.Send(RealtimeFrame.REJECT), Action.DiscardIncoming)
    }

    /** The lane is occupied by another batch. Requeue, not a refusal. */
    fun busyIncoming(): List<Action> {
        check(receiveState == ReceiveState.PROMPT) { "no batch is waiting for an answer" }
        receiveState = ReceiveState.IDLE
        incoming = emptyList()
        return listOf(Action.Send(RealtimeFrame.BUSY), Action.DiscardIncoming)
    }

    /**
     * Cancel the INCOMING batch, from whichever phase it is in.
     *
     * At the prompt this is an ordinary decline. After ACCEPT it is the
     * receiver's half of the Web's cancel exchange: send REJECT, discard what
     * was staged, and DRAIN — the sender stops when it sees the REJECT and
     * answers with the ordered BATCH_ABORT, but every frame it sealed before
     * that consumed a sequence number and must still be authenticated on its
     * way to the bin. The codecs are untouched; the file lane and the text
     * lane stay usable; the next batch may start once the barrier lands.
     *
     * The adapter arms [ABORT_BARRIER_TIMEOUT_MS] for the missing-barrier case,
     * re-armed by each drained frame, and calls [abortBarrierTimedOut] on
     * expiry.
     */
    fun cancelIncoming(): List<Action> = when (receiveState) {
        ReceiveState.PROMPT -> rejectIncoming()
        ReceiveState.RECEIVING, ReceiveState.VERIFYING -> {
            receiveState = ReceiveState.DRAINING
            drainedBytes = 0
            listOf(
                Action.Send(RealtimeFrame.REJECT),
                Action.DiscardIncoming,
                Action.Fail(Failure(Failure.Reason.LOCAL_CANCEL, Failure.Scope.RECEIVE)),
            )
        }
        else -> emptyList()
    }

    /**
     * The sender's BATCH_ABORT never arrived inside the bounded wait.
     *
     * A conforming sender answers a REJECT with the barrier promptly; one that
     * does not is either gone or not following the protocol, and this side
     * cannot re-align without the barrier. Truthful lane failure, fresh session.
     */
    fun abortBarrierTimedOut(): List<Action> {
        if (receiveState != ReceiveState.DRAINING) return emptyList()
        return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
    }

    /**
     * The storage layer reports cumulative DURABLE bytes for this batch.
     *
     * "Durable" means flushed to the file descriptor, not appended to a buffer.
     * An ACK is a durability claim (`relayium-link-v1.md` section 9.1): a sink
     * that acknowledges buffered bytes breaks the sender's pacing contract, and
     * the sender then declares itself finished while this side is still writing.
     */
    fun onDurableBytes(cumulative: Long): List<Action> {
        if (receiveState != ReceiveState.RECEIVING && receiveState != ReceiveState.VERIFYING) {
            return emptyList()
        }
        if (cumulative <= durableBytes) return emptyList()
        durableBytes = cumulative
        if (durableBytes - lastAckSent < RealtimeFrame.FLOW_ACK_INTERVAL_BYTES) return emptyList()
        lastAckSent = durableBytes
        return listOf(Action.Send(RealtimeFrame.ackFrame(durableBytes)))
    }

    /**
     * Every file of the accepted batch is verified AND exported to the user's
     * destination.
     *
     * COMPLETE goes out only from here. Sending it when the last chunk arrived —
     * or when the last digest matched but the export had not closed — would make
     * the byte a claim this side cannot support.
     */
    fun onBatchExported(): List<Action> {
        check(receiveState == ReceiveState.VERIFYING) { "the batch is not fully verified yet" }
        receiveState = ReceiveState.DONE
        return listOf(Action.Send(RealtimeFrame.COMPLETE), Action.ReceiveComplete)
    }

    // ── the demux ───────────────────────────────────────────────────────────

    /**
     * One inbound frame, classified and routed.
     *
     * This is the ONLY entry point for bytes off the file lane, and its first
     * act is [LinkProtocol.fileFrameClass] — a total partition. There is no
     * "ignore what we do not recognise" branch: on an ordered channel an
     * unroutable frame is either corruption or a peer speaking a protocol this
     * build does not have, and skipping one the peer COUNTED strands the
     * receiver's sequence for the rest of the link.
     */
    fun onFrame(frame: ByteArray): List<Action> {
        return when (val cls = LinkProtocol.fileFrameClass(frame)) {
            is LinkProtocol.FileFrameClass.Lifecycle -> onLifecycle(cls.control)
            is LinkProtocol.FileFrameClass.Ack -> onAck(frame)
            is LinkProtocol.FileFrameClass.ResumeRequest,
            is LinkProtocol.FileFrameClass.ResumeStart,
            -> onResume()
            is LinkProtocol.FileFrameClass.Protected -> onProtected(frame)
            is LinkProtocol.FileFrameClass.Unroutable ->
                fail(Failure(Failure.Reason.UNROUTABLE_FRAME, Failure.Scope.LANE))
        }
    }

    private fun onLifecycle(control: LinkProtocol.FileControl): List<Action> = when (control) {
        LinkProtocol.FileControl.ACCEPT -> {
            if (sendState == SendState.WAITING_ACCEPT) {
                sendState = SendState.SENDING
                emptyList()
            } else {
                emptyList()
            }
        }
        // Every non-accept outcome of an outgoing batch ends with the ordered
        // BATCH_ABORT barrier, matching the Web's sending loop. The barrier is
        // what lets the receiver retire the batch uniformly — decline, stop and
        // cancel all look the same on its side — and serialisation guarantees
        // it enters the channel AFTER every frame whose nonce was consumed.
        LinkProtocol.FileControl.REJECT -> {
            if (sendState != SendState.IDLE && sendState != SendState.DONE &&
                sendState != SendState.FAILED
            ) {
                sendState = SendState.IDLE
                sender.batchAborted()
                listOf(
                    Action.Send(RealtimeFrame.BATCH_ABORT),
                    Action.Fail(Failure(Failure.Reason.PEER_REJECTED, Failure.Scope.SEND)),
                )
            } else {
                emptyList()
            }
        }
        LinkProtocol.FileControl.BUSY -> {
            if (sendState == SendState.WAITING_ACCEPT) {
                sendState = SendState.IDLE
                sender.batchAborted()
                listOf(
                    Action.Send(RealtimeFrame.BATCH_ABORT),
                    Action.Fail(Failure(Failure.Reason.PEER_BUSY, Failure.Scope.SEND)),
                )
            } else {
                emptyList()
            }
        }
        LinkProtocol.FileControl.COMPLETE -> {
            if (sendState == SendState.FINISHING) {
                sendState = SendState.DONE
                listOf(Action.SendComplete)
            } else {
                emptyList()
            }
        }
        // The ordered barrier. It retires the INCOMING batch and leaves
        // everything else — the sequence, the lane, the text lane — usable.
        LinkProtocol.FileControl.BATCH_ABORT -> {
            receiver.batchAborted()
            // A drain this side started with cancelIncoming already discarded
            // and reported; the barrier just closes it silently.
            val quiet = receiveState == ReceiveState.DRAINING ||
                receiveState == ReceiveState.IDLE || receiveState == ReceiveState.DONE
            receiveState = ReceiveState.IDLE
            incoming = emptyList()
            if (quiet) {
                emptyList()
            } else {
                listOf(
                    Action.DiscardIncoming,
                    Action.Fail(Failure(Failure.Reason.LOCAL_CANCEL, Failure.Scope.RECEIVE)),
                )
            }
        }
    }

    private fun onAck(frame: ByteArray): List<Action> {
        val value = RealtimeFrame.parseAck(frame) ?: return emptyList()
        acked = RealtimeFrame.advanceAck(acked, sentBytes, value)
        return emptyList()
    }

    /**
     * Transport resume is DEFERRED in this stage, and refused honestly.
     *
     * Recognised — so it never reaches the AEAD receiver and never realigns a
     * sequence — and then failed closed with a terminal state the UI can explain
     * and the user can retry from with a fresh session. It never reuses or
     * resets a key or a counter, and it never accepts an unauthenticated rebuild.
     *
     * A client that refuses recovery is not speaking a partial dialect: every
     * byte it emits is `link/1`, and its peer's rebuild attempts simply go
     * unanswered, which is exactly what a peer that walked away looks like.
     */
    private fun onResume(): List<Action> =
        fail(Failure(Failure.Reason.RESUME_UNSUPPORTED, Failure.Scope.LANE))

    private fun onProtected(frame: ByteArray): List<Action> {
        val kind = RealtimeFrame.kindOf(frame)
        // The encrypted manifest IS the consent prompt, so it is always fed in
        // wire order. File CONTENT is different: decrypting a chunk before the
        // user has answered would violate the product rule even if nothing were
        // written, so the lane fails without feeding and abandons its nonce
        // state together with the channel.
        val isContent = kind == RealtimeFrame.KIND_CHUNK ||
            kind == RealtimeFrame.KIND_CHUNK_PART ||
            kind == RealtimeFrame.KIND_DONE_ENC
        val contentOk = receiveState == ReceiveState.RECEIVING ||
            receiveState == ReceiveState.VERIFYING ||
            receiveState == ReceiveState.DRAINING
        if (isContent && !contentOk) {
            return fail(Failure(Failure.Reason.CONTENT_BEFORE_CONSENT, Failure.Scope.LANE))
        }
        val output = try {
            receiver.feed(frame, keys)
        } catch (e: RealtimeException) {
            val reason = if (e.message?.contains("older version") == true) {
                Failure.Reason.LEGACY_PEER
            } else {
                Failure.Reason.PROTOCOL
            }
            return fail(Failure(reason, Failure.Scope.LANE))
        } catch (e: ManifestException) {
            return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
        }
        return when (output) {
            is RealtimeReceiver.Output.Buffered -> emptyList()
            is RealtimeReceiver.Output.Batch -> onBatch(output.files)
            is RealtimeReceiver.Output.Chunk -> onChunk(output.plaintext)
            is RealtimeReceiver.Output.Done -> onDone(output.verified)
        }
    }

    private fun onBatch(files: List<FileMeta>): List<Action> {
        // IDLE or DONE, for the same reason startBatch accepts both: a
        // completed incoming batch retires, and the next manifest arrives on
        // the same lane with the same receive sequence.
        if (receiveState != ReceiveState.IDLE && receiveState != ReceiveState.DONE) {
            // A second manifest while one batch is live is not something this
            // protocol has; the lane cannot hold two.
            return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
        }
        // Every path is decided BEFORE consent is asked for, so the user is
        // never shown a batch that will be refused after they approve it.
        for (file in files) {
            val verdict = Filename.resolveRelativePath(file.path, file.name)
            if (verdict is Filename.PathVerdict.Refuse) {
                return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
            }
        }
        incoming = files
        receiveState = ReceiveState.PROMPT
        return listOf(Action.Prompt(files))
    }

    private fun onChunk(plaintext: ByteArray): List<Action> {
        if (receiveState == ReceiveState.DRAINING) {
            // Authenticated in sequence, never written. The bound is the
            // batch's own declared size plus one flow window: a sender that
            // keeps producing past everything it could have had in flight when
            // the REJECT reached it is not draining, it is ignoring the cancel.
            drainedBytes += plaintext.size
            val declared = incoming.sumOf { it.size }
            if (drainedBytes > declared + RealtimeFrame.FLOW_WINDOW_BYTES) {
                return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
            }
            return emptyList()
        }
        if (receiveState != ReceiveState.RECEIVING) {
            return fail(Failure(Failure.Reason.CONTENT_BEFORE_CONSENT, Failure.Scope.LANE))
        }
        val meta = incoming.getOrNull(fileIndex)
            ?: return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
        // A peer that sends more bytes than its own manifest declared is not
        // merely wrong, it is trying to make this side allocate past what the
        // user consented to.
        if (fileOffset + plaintext.size > meta.size) {
            return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
        }
        val action = Action.Write(fileIndex, fileOffset, plaintext)
        fileOffset += plaintext.size
        batchWritten += plaintext.size
        return listOf(action)
    }

    private fun onDone(ok: Boolean): List<Action> {
        // A DONE in a drain is just the sender finishing a file this side no
        // longer wants. The receiver already advanced its chain and sequence;
        // its verdict is discarded with everything else.
        if (receiveState == ReceiveState.DRAINING) return emptyList()
        if (receiveState != ReceiveState.RECEIVING) {
            return fail(Failure(Failure.Reason.CONTENT_BEFORE_CONSENT, Failure.Scope.LANE))
        }
        val meta = incoming.getOrNull(fileIndex)
            ?: return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
        // A DONE before the declared size arrived means the two sides disagree
        // about the file, whatever the digest says.
        if (fileOffset != meta.size) {
            return fail(Failure(Failure.Reason.PROTOCOL, Failure.Scope.LANE))
        }
        if (!ok) {
            val index = fileIndex
            receiveState = ReceiveState.FAILED
            return listOf(
                Action.FileCorrupt(index),
                Action.DiscardIncoming,
                Action.Fail(Failure(Failure.Reason.INTEGRITY, Failure.Scope.LANE)),
            )
        }
        val out = ArrayList<Action>()
        out.add(Action.FileVerified(fileIndex))
        verified++
        fileIndex++
        fileOffset = 0
        if (verified == incoming.size) {
            // Verified is not exported. The caller commits staging into the
            // user's destination and calls onBatchExported(), which is the only
            // place COMPLETE comes from.
            receiveState = ReceiveState.VERIFYING
        }
        return out
    }

    private fun fail(failure: Failure): List<Action> {
        when (failure.scope) {
            Failure.Scope.SEND ->
                if (sendState != SendState.DONE) sendState = SendState.IDLE
            Failure.Scope.RECEIVE ->
                if (receiveState != ReceiveState.DONE) receiveState = ReceiveState.IDLE
            Failure.Scope.LANE -> {
                sendState = SendState.FAILED
                receiveState = ReceiveState.FAILED
            }
        }
        return listOf(Action.Fail(failure))
    }
}
