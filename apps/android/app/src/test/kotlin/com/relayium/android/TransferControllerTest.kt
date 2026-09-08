package com.relayium.android

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.android.transport.IceConfig
import com.relayium.android.transport.LinkTransport
import com.relayium.android.transport.SignalingClient
import com.relayium.android.transport.SignalingHandle
import com.relayium.android.transport.TransportHandle
import com.relayium.protocol.Crypto
import com.relayium.protocol.Envelope
import com.relayium.protocol.FileMeta
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.PairCode
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.RealtimeSender
import com.relayium.protocol.Signal
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextSessionLimits
import com.relayium.protocol.TextWire
import com.relayium.protocol.legacy.LegacyProtocol
import com.relayium.protocol.legacy.WireProfile
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The controller's ownership, fencing and failure behaviour on the JVM, through
 * the SAME seams the app wires to OkHttp/WebRTC/SAF — with the protocol layer
 * fully real: real keys, real sealed frames from a real peer-side sender.
 *
 * Fakes here record interactions and inject failures; none of them fakes a
 * SUCCESS the assertion depends on.
 */
class TransferControllerTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val controllers = ArrayList<TransferController>()

    @After
    fun tearDown() {
        controllers.forEach { it.shutdown() }
        scope.cancel()
    }

    // ── harness ─────────────────────────────────────────────────────────────

    private class FakeSignaling : SignalingHandle {
        lateinit var events: SignalingClient.Events
        val sent = ConcurrentLinkedQueue<Pair<String, Json>>()
        override fun connect() = Unit
        override fun sendSignal(to: String, data: Json) { sent.add(to to data) }
        override fun close() = Unit
    }

    private class FakeTransport(
        val profile: WireProfile,
        val events: LinkTransport.Events,
    ) : TransportHandle {
        val fileFrames = ConcurrentLinkedQueue<ByteArray>()
        val textFrames = ConcurrentLinkedQueue<ByteArray>()
        val signals = ConcurrentLinkedQueue<Json>()
        @Volatile var acceptFile = true
        @Volatile var acceptText = true
        @Volatile var textBuffered = 0L
        @Volatile var closedReason: String? = null
        override fun start() = Unit
        override fun onSignal(raw: Json) { signals.add(raw) }
        override fun sendFile(frame: ByteArray) = if (acceptFile) { fileFrames.add(frame); true } else false
        override fun sendText(frame: ByteArray) = if (acceptText) { textFrames.add(frame); true } else false
        override fun fileBufferedAmount() = 0L
        override fun textBufferedAmount() = textBuffered
        override fun leaveAndClose(leave: Signal?) { closedReason = "local-leave" }
        override fun close(reason: String) { closedReason = reason }
    }

    /** A real-filesystem ProviderOps, same as the store test's. */
    private class FileOps : ProviderOps {
        inner class FileNode(val file: File) : ProviderOps.Node {
            override val name: String get() = file.name
            override val isDirectory: Boolean get() = file.isDirectory
            override fun delete(): Boolean = file.delete()
            override fun openOut(): OutputStream = file.outputStream()
        }
        fun node(file: File): ProviderOps.Node = FileNode(file)
        override fun findChild(parent: ProviderOps.Node, name: String) =
            File((parent as FileNode).file, name).takeIf { it.exists() }?.let { FileNode(it) }
        override fun createDirectory(parent: ProviderOps.Node, name: String) =
            File((parent as FileNode).file, name).takeIf { it.mkdir() }?.let { FileNode(it) }
        override fun createFile(parent: ProviderOps.Node, name: String) =
            File((parent as FileNode).file, name).takeIf { it.createNewFile() }?.let { FileNode(it) }
    }

    private class Rig(
        val controller: TransferController,
        val signaling: FakeSignaling,
        val transports: ConcurrentLinkedQueue<FakeTransport>,
        val ops: FileOps,
        val treeDir: File,
    ) {
        val transport: FakeTransport get() = transports.peek() ?: error("no transport was created")
    }

    private fun rig(
        selfId: String = "aaaaaaaa",
        timeouts: TransferController.Timeouts = quietTimeouts(),
        store: ReceiveStore? = null,
        intent: TransferController.Intent = TransferController.Intent.JOINER,
    ): Rig {
        val signaling = FakeSignaling()
        val transports = ConcurrentLinkedQueue<FakeTransport>()
        val ops = FileOps()
        val treeDir = temp.newFolder("tree-${System.nanoTime()}")
        val deps = TransferController.Deps(
            fetchIce = { IceConfig.Result(emptyList(), "") },
            signals = { _, events -> signaling.also { it.events = events } },
            transports = { profile, _, _, _, events ->
                FakeTransport(profile, events).also(transports::add)
            },
            store = store ?: ReceiveStore(temp.newFolder("staging-${System.nanoTime()}")),
            providerOps = ops,
            timeouts = timeouts,
        )
        val controller = TransferController(scope, "test-device", deps)
        controllers.add(controller)
        controller.join(PairCode("123456"), intent)
        awaitTrue("signaling wired") { runCatching { signaling.events }.isSuccess }
        signaling.events.onSelfId(selfId, "")
        return Rig(controller, signaling, transports, ops, treeDir)
    }

    /** Drive a real incoming batch to the folder prompt and return the peer
     *  sender so a test can keep feeding its content frames. */
    private fun promptIncoming(
        rig: Rig,
        remote: Crypto.SessionKeys,
        files: List<FileMeta>,
    ): RealtimeSender {
        val peerSender = RealtimeSender()
        for (frame in peerSender.batchFrames(files, remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("prompted") { rig.controller.state.value.awaitingFolder }
        return peerSender
    }

    private fun controlFrames(rig: Rig, ctrl: Int): Int =
        rig.transport.fileFrames.count { it.size == 1 && (it[0].toInt() and 0xff) == ctrl }

    /** Long everywhere a test does not exercise that deadline. */
    private fun quietTimeouts() = TransferController.Timeouts(
        helloRetryMs = 60_000, settleMs = 60_000, requestRetryMs = 60_000,
        requestDeadlineMs = 60_000, consentMs = 60_000, textEndAckMs = 60_000,
        abortBarrierMs = 60_000, textIdleMs = 600_000,
    )

    private fun awaitTrue(what: String, timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for: $what")
    }

    private fun mirroredKeys(): Pair<Crypto.SessionKeys, Crypto.SessionKeys> {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey) to
            Crypto.deriveSession(Crypto.Role.RESPONDER, b, a.publicKey)
    }

    private fun capsHello(): Json = Json.obj(
        "caps" to Json.arr(listOf(Json.of("link/1"))),
    )

    /** Peer announces, transport is created, link comes ready with REAL keys.
     *  Returns the PEER side of the mirrored pair. */
    private fun connect(rig: Rig, peer: String = "bbbbbbbb"): Crypto.SessionKeys {
        rig.signaling.events.onPeers(listOf(Envelope.Peer(peer, "peer")))
        rig.signaling.events.onSignal(peer, capsHello())
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        val (local, remote) = mirroredKeys()
        rig.transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("connected") { rig.controller.state.value.phase == TransferController.Phase.CONNECTED }
        return remote
    }

    // ── R10: caps piggyback and admission ───────────────────────────────────

    @Test
    fun `an offer carrying caps establishes AND its SDP reaches the transport`() {
        // We are the larger id, so the peer offers. Its FIRST frame is a real
        // conforming offer: sdp + commit + caps in one signal, no prior hello.
        val rig = rig(selfId = "zzzzzzzz")
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        val offer = Signal.offer("v=0\r\n", "Y29tbWl0", listOf("link/1")).toJson()
        rig.signaling.events.onSignal("bbbbbbbb", offer)
        awaitTrue("the offer created a transport") { rig.transports.isNotEmpty() }
        awaitTrue("and the SAME signal was routed into it, sdp intact") {
            rig.transport.signals.any { Signal.fromJson(it)?.sdpType == "offer" }
        }
    }

    @Test
    fun `a link request from a peer that never announced does not establish`() {
        val rig = rig(selfId = "aaaaaaaa") // smaller id: we would be the offerer
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.signaling.events.onSignal("bbbbbbbb", Signal.linkRequest().toJson())
        Thread.sleep(200)
        assertTrue(
            "the offer-only proof exception must not stretch to requests",
            rig.transports.isEmpty(),
        )
    }

    @Test
    fun `an unrelated peer cannot spend the leave budget`() {
        val rig = rig(selfId = "aaaaaaaa")
        val remote = connect(rig)
        // An attacker floods well past the eight-HMAC budget with well-SHAPED
        // leaves. If any of them reached the budget, the genuine one below
        // would be ignored.
        repeat(2 * LinkProtocol.LEAVE_MAX_ATTEMPTS) {
            rig.signaling.events.onSignal(
                "cccccccc",
                Signal.leave("!".repeat(LinkProtocol.AUTH_TAG_LENGTH)).toJson(),
            )
        }
        Thread.sleep(150)
        assertEquals(
            "forged leaves from a stranger must not end the session",
            TransferController.Phase.CONNECTED, rig.controller.state.value.phase,
        )
        // The GENUINE peer's leave, signed over the correct direction tuple
        // with the real resume-auth key, still works.
        val tag = Crypto.signAuth(remote, LinkProtocol.linkLeavePayload("bbbbbbbb", "aaaaaaaa"))
        rig.signaling.events.onSignal("bbbbbbbb", Signal.leave(tag).toJson())
        awaitTrue("the genuine leave ends the session") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED
        }
    }

    // ── R4.2/R13: the end-barrier lease at the adapter ──────────────────────

    private fun openText(rig: Rig, remote: Crypto.SessionKeys) {
        rig.transport.events.onTextFrame(TextWire.REQUEST)
        awaitTrue("incoming request") {
            rig.controller.state.value.textState == TextLaneSession.State.INCOMING_REQUEST
        }
        rig.controller.acceptText()
        awaitTrue("open") { rig.controller.state.value.textState == TextLaneSession.State.OPEN }
    }

    @Test
    fun `the END timeout poisons text visibly and file transfer survives`() {
        val rig = rig(timeouts = quietTimeouts().copy(textEndAckMs = 100))
        val remote = connect(rig)
        openText(rig, remote)
        rig.controller.endText()
        awaitTrue("the lease expired and the lane poisoned") {
            rig.controller.state.value.textState == TextLaneSession.State.FAILED
        }
        val state = rig.controller.state.value
        assertFalse(state.textCanRequest)
        assertEquals("the failure is visible", "error_text_failed", state.errorKey)
        // A LATE peer END cannot unpoison it.
        rig.transport.events.onTextFrame(TextWire.END)
        Thread.sleep(100)
        assertEquals(TextLaneSession.State.FAILED, rig.controller.state.value.textState)
        // The file lane still works: a batch starts and its manifest is sent.
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("f.bin", 3)) {
                    ByteArrayInputStream(byteArrayOf(1, 2, 3))
                },
            ),
        )
        awaitTrue("the manifest went out on the surviving file lane") {
            rig.transport.fileFrames.isNotEmpty()
        }
    }

    @Test
    fun `a settled barrier retires its timer, which cannot poison a later conversation`() {
        val rig = rig(timeouts = quietTimeouts().copy(textEndAckMs = 250))
        val remote = connect(rig)
        openText(rig, remote)
        rig.controller.endText()
        // The peer's END settles the barrier well inside the lease.
        Thread.sleep(50)
        rig.transport.events.onTextFrame(TextWire.END)
        awaitTrue("reopenable after the settled barrier") {
            rig.controller.state.value.textCanRequest
        }
        // A NEW conversation opens; the OLD timer's deadline passes; it must
        // not fire into this conversation.
        openText(rig, remote)
        Thread.sleep(400)
        assertEquals(
            "the retired timer stayed retired",
            TextLaneSession.State.OPEN, rig.controller.state.value.textState,
        )
    }

    // ── R15b: the enqueue outcome the draft owner depends on ────────────────

    @Test
    fun `sendText reports its enqueue outcome truthfully at every refusal`() {
        val rig = rig()
        val remote = connect(rig)
        // A lane that is not OPEN refuses, and SAYS it refused — the caller's
        // draft must survive this.
        val early = ArrayList<Boolean>()
        rig.controller.sendText("before the lane opened") { early.add(it) }
        awaitTrue("closed-lane outcome") { early.size == 1 }
        assertFalse("a closed lane must not report success", early[0])
        openText(rig, remote)
        // A full send buffer refuses BEFORE burning a nonce, surfaces the
        // busy error, and reports failure. No false sent row.
        rig.transport.textBuffered = TextSessionLimits.SEND_BUFFER_MAX + 1L
        val full = ArrayList<Boolean>()
        rig.controller.sendText("the retried draft") { full.add(it) }
        awaitTrue("buffer-full outcome") { full.size == 1 }
        assertFalse("a refused enqueue must not report success", full[0])
        assertEquals("error_text_buffer_full", rig.controller.state.value.errorKey)
        assertTrue("no message may pretend it was sent", rig.controller.state.value.messages.isEmpty())
        // The buffer drains; retrying the SAME preserved draft succeeds and
        // only then does the outcome say so and the row appear.
        rig.transport.textBuffered = 0
        val retried = ArrayList<Boolean>()
        rig.controller.sendText("the retried draft") { retried.add(it) }
        awaitTrue("successful outcome") { retried.size == 1 }
        assertTrue("a delivered enqueue reports success", retried[0])
        assertEquals(1, rig.controller.state.value.messages.size)
        assertEquals("the retried draft", rig.controller.state.value.messages[0].body)
    }

    @Test
    fun `a failed transport enqueue reports failure so the draft survives`() {
        val rig = rig()
        val remote = connect(rig)
        openText(rig, remote)
        rig.transport.acceptText = false
        val outcomes = ArrayList<Boolean>()
        rig.controller.sendText("this never entered the channel") { outcomes.add(it) }
        awaitTrue("outcome delivered") { outcomes.size == 1 }
        assertFalse("a poisoned enqueue must not report success", outcomes[0])
        assertTrue(rig.controller.state.value.messages.isEmpty())
    }

    @Test
    fun `a failed text enqueue poisons the lane and shows no false sent message`() {
        val rig = rig()
        val remote = connect(rig)
        openText(rig, remote)
        rig.transport.acceptText = false
        rig.controller.sendText("this never entered the channel")
        awaitTrue("the lane poisoned") {
            rig.controller.state.value.textState == TextLaneSession.State.FAILED
        }
        assertTrue(
            "no message may pretend it was sent",
            rig.controller.state.value.messages.isEmpty(),
        )
    }

    @Test
    fun `a failed file enqueue ends the session truthfully`() {
        val rig = rig()
        connect(rig)
        rig.transport.acceptFile = false
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("f.bin", 1)) {
                    ByteArrayInputStream(byteArrayOf(9))
                },
            ),
        )
        awaitTrue("a consumed nonce that never entered the channel ends the link") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED &&
                rig.controller.state.value.errorKey == "error_connection_lost"
        }
    }

    // ── R12: batch generation and stale results ─────────────────────────────

    @Test
    fun `a cancelled pump's delayed read can never enter the next batch`() {
        val rig = rig()
        connect(rig)

        val blocked = CountDownLatch(1)
        val oldSource = TransferController.OutgoingSource(FileMeta("old.bin", 4)) {
            object : InputStream() {
                private var fed = 0
                override fun read(): Int = throw UnsupportedOperationException()
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    // The provider stalls mid-file, exactly like a slow SAF
                    // document, and only answers after the batch was cancelled.
                    blocked.await(10, TimeUnit.SECONDS)
                    return if (fed == 0) { fed = 4; b[off] = 1; b[off + 1] = 1; b[off + 2] = 1; b[off + 3] = 1; 4 } else -1
                }
            }
        }
        rig.controller.sendFiles(listOf(oldSource))
        awaitTrue("old manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        Thread.sleep(100) // the old pump is now blocked inside its read

        rig.controller.cancelSend()
        awaitTrue("the cancel barrier went out") {
            rig.transport.fileFrames.any { it.size == 1 && (it[0].toInt() and 0xff) == RealtimeFrame.CTRL_BATCH_ABORT }
        }

        // A fresh batch on the SAME link.
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("new.bin", 2)) {
                    ByteArrayInputStream(byteArrayOf(7, 7))
                },
            ),
        )
        awaitTrue("new manifest out") {
            rig.transport.fileFrames.count { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_BATCH_ENC } == 2
        }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        awaitTrue("the new batch streamed to its DONE") {
            rig.transport.fileFrames.any { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_DONE_ENC }
        }
        val framesBeforeRelease = rig.transport.fileFrames.size

        // NOW the old provider read completes. Its pump is fenced by batch
        // generation and must emit nothing.
        blocked.countDown()
        Thread.sleep(300)
        assertEquals(
            "a delayed old read must not write into the new batch",
            framesBeforeRelease, rig.transport.fileFrames.size,
        )
    }

    @Test
    fun `a stale folder-picker answer for a retired prompt is ignored`() {
        val rig = rig()
        val remote = connect(rig)
        // A real incoming manifest produces the prompt.
        val peerSender = RealtimeSender()
        for (frame in peerSender.batchFrames(
            listOf(FileMeta("in.bin", 3)), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("prompted") { rig.controller.state.value.awaitingFolder }
        val currentPrompt = rig.controller.state.value.promptId
        // The picker answers for a DIFFERENT (older) prompt.
        rig.controller.acceptIncoming(currentPrompt - 1, rig.ops.node(rig.treeDir))
        Thread.sleep(150)
        assertTrue("the stale answer changed nothing", rig.controller.state.value.awaitingFolder)
        assertNull(rig.controller.state.value.errorKey)
        // The CURRENT answer still works and the receive completes end to end.
        rig.controller.acceptIncoming(currentPrompt, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in peerSender.chunkFrames(byteArrayOf(1, 2, 3), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        rig.transport.events.onFileFrame(
            peerSender.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), byteArrayOf(1, 2, 3)), remote),
        )
        awaitTrue("saved through the real store and real provider ops") {
            rig.controller.state.value.savedBatch &&
                File(rig.treeDir, "in.bin").takeIf { it.exists() }?.readBytes()
                    ?.contentEquals(byteArrayOf(1, 2, 3)) == true
        }
        awaitTrue("and COMPLETE went back") {
            rig.transport.fileFrames.any { it.size == 1 && (it[0].toInt() and 0xff) == RealtimeFrame.CTRL_COMPLETE }
        }
    }

    // ── R15a: accepted-but-quiet is a live, cancellable receive ─────────────

    @Test
    fun `an accepted receive with no bytes yet is still cancellable`() {
        val rig = rig()
        val remote = connect(rig)
        val peerSender = RealtimeSender()
        // A zero-byte file first: no CHUNK will ever arrive for it, so the
        // progress field stays empty for as long as the sender stalls — the
        // exact shape the UI must keep treating as a live receive with a
        // working cancel, not a blank between the prompt and the first byte.
        for (frame in peerSender.batchFrames(
            listOf(FileMeta("empty.bin", 0), FileMeta("later.bin", 3)),
            remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("prompted") { rig.controller.state.value.awaitingFolder }
        rig.controller.acceptIncoming(
            rig.controller.state.value.promptId, rig.ops.node(rig.treeDir),
        )
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        val accepted = rig.controller.state.value
        assertTrue("the accepted batch stays visible", accepted.incoming.isNotEmpty())
        assertNull("no byte has arrived, so there is no progress row", accepted.receiveProgress)
        // The user cancels HERE — before the first byte. The receive retires,
        // the peer is told, and the link itself survives for a fresh attempt.
        rig.controller.cancelReceive()
        awaitTrue("the cancel emptied the incoming batch") {
            rig.controller.state.value.incoming.isEmpty()
        }
        awaitTrue("and a REJECT told the peer") {
            controlFrames(rig, RealtimeFrame.CTRL_REJECT) >= 1
        }
        assertEquals(TransferController.Phase.CONNECTED, rig.controller.state.value.phase)
    }

    @Test
    fun `a file-lane protocol failure leaves the text conversation usable`() {
        val rig = rig()
        val remote = connect(rig)
        openText(rig, remote)
        // An unroutable frame kills the FILE lane terminally.
        rig.transport.events.onFileFrame(byteArrayOf(13, 0, 0, 0, 0, 1))
        awaitTrue("file lane down, link alive") {
            rig.controller.state.value.fileLaneDown &&
                rig.controller.state.value.phase == TransferController.Phase.CONNECTED
        }
        // Text still flows in both directions on its independent codecs.
        val peerText = TextWire.Sender()
        rig.transport.events.onTextFrame(peerText.frame("still here", remote))
        awaitTrue("inbound text still works") {
            rig.controller.state.value.messages.any { it.body == "still here" && it.fromPeer }
        }
        rig.controller.sendText("and outbound")
        awaitTrue("outbound text still works") {
            rig.transport.textFrames.any { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_TEXT_ENC }
        }
        // But a new batch is refused while the lane is down.
        rig.controller.sendFiles(
            listOf(TransferController.OutgoingSource(FileMeta("x", 1)) { ByteArrayInputStream(byteArrayOf(1)) }),
        )
        Thread.sleep(150)
        assertTrue(
            "no manifest may go out on a dead lane",
            rig.transport.fileFrames.none { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_BATCH_ENC },
        )
    }

    // ── R12.1: async storage ownership ──────────────────────────────────────

    /**
     * A store whose [discard] reports a leftover — but only while ARMED.
     *
     * `ReceiveStore.begin` runs a defensive discard, and a controller teardown
     * runs one too, so an UNCONDITIONAL leftover fires on those incidental
     * discards as well as the one a test means to exercise. That is what made
     * the leftover-warning test flaky: the begin-time warning could satisfy the
     * "surfaced" wait before the cancel ever ran, and a still-in-flight
     * incidental discard could re-latch the warning just after the dismiss —
     * so the "dismissed" wait would never see it clear. Arming scopes the
     * injected failure to the exact discard under test (the cancel, then the
     * explicit next join), leaving every incidental discard a real, clean one.
     */
    private class LeftoverStore(root: File) : ReceiveStore(root) {
        val armed = java.util.concurrent.atomic.AtomicBoolean(false)
        override fun discard(): Outcome {
            val real = super.discard()
            if (!armed.get()) return real
            // The real store latches this whenever a discard leaves anything
            // behind; the injected failure keeps that contract.
            unresolvedCleanup = true
            return Outcome.Failed(Outcome.Reason.EXPORT_FAILED, cleanupComplete = false)
        }
    }

    /** A store whose [begin] blocks until [gate] opens, modelling a slow SAF
     *  document tree the picker just handed over. */
    private class GatedBeginStore(root: File, val gate: CountDownLatch) : ReceiveStore(root) {
        override fun begin(files: List<FileMeta>, ops: ProviderOps, root: ProviderOps.Node): Outcome {
            gate.await(10, TimeUnit.SECONDS)
            return super.begin(files, ops, root)
        }
    }

    /** A store whose [write] blocks forever, so queued plaintext accumulates and
     *  the bound must fire. */
    private class StuckWriteStore(root: File, val entered: CountDownLatch) : ReceiveStore(root) {
        override fun write(index: Int, bytes: ByteArray): Outcome {
            entered.countDown()
            Thread.sleep(60_000)
            return Outcome.Ok
        }
    }

    @Test
    fun `a cancel's leftover warning survives the receiveGen bump it races`() {
        // DiscardIncoming then Fail(RECEIVE): the failure bumps receiveGen before
        // discard completes, so a receiveGen-fenced warning would always vanish.
        val staging = temp.newFolder("staging-leftover")
        val store = LeftoverStore(staging)
        val rig = rig(store = store)
        val remote = connect(rig)
        val sender = promptIncoming(rig, remote, listOf(FileMeta("in.bin", 3)))
        // Accept BEFORE arming: begin's own defensive discard must NOT inject a
        // warning, or it would satisfy the "surfaced" wait below before the
        // cancel this test is about ever runs.
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        assertFalse(
            "no incidental discard may have surfaced a warning before the cancel",
            rig.controller.state.value.cleanupIncomplete,
        )
        // One real chunk arrives, then the user cancels the receive. Arm the
        // fault so ONLY the cancel's discard leaves a leftover.
        for (frame in sender.chunkFrames(byteArrayOf(1, 2, 3), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        store.armed.set(true)
        rig.controller.cancelReceive()
        awaitTrue("the leftover warning is surfaced despite the generation bump") {
            rig.controller.state.value.cleanupIncomplete
        }
        // The cancel's discard has now completed and surfaced. Disarm so no
        // further incidental discard can re-latch the warning and race the
        // dismiss; only the user's explicit acknowledgment clears it.
        store.armed.set(false)
        rig.controller.dismissCleanupWarning()
        awaitTrue("dismissed") { !rig.controller.state.value.cleanupIncomplete }
        // …and a FRESH link never erases an unacknowledged one: re-arm so the
        // join's own teardown discard fails again in this store, and the
        // warning it latches must land in the NEW session's state.
        store.armed.set(true)
        rig.controller.join(PairCode("654321"), TransferController.Intent.JOINER)
        awaitTrue("the leftover warning survives into the new session") {
            rig.controller.state.value.cleanupIncomplete &&
                rig.controller.state.value.phase == TransferController.Phase.CONNECTING
        }
    }

    @Test
    fun `a reject while begin is still running cannot later accept the batch`() {
        val gate = CountDownLatch(1)
        val staging = temp.newFolder("staging-gated")
        val rig = rig(store = GatedBeginStore(staging, gate))
        val remote = connect(rig)
        promptIncoming(rig, remote, listOf(FileMeta("in.bin", 3)))
        // Accept: begin is enqueued but blocks in the store, so awaitingFolder
        // stays set (the completion that clears it cannot run yet).
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        Thread.sleep(150) // let the blocked begin reach the store
        // The user rejects while begin is still in flight.
        rig.controller.rejectIncoming()
        awaitTrue("a REJECT went out") { controlFrames(rig, RealtimeFrame.CTRL_REJECT) >= 1 }
        // Now begin completes successfully — and must NOT resurrect the batch.
        gate.countDown()
        Thread.sleep(300)
        assertEquals(
            "a late successful begin must not send ACCEPT for a rejected batch",
            0, controlFrames(rig, RealtimeFrame.CTRL_ACCEPT),
        )
    }

    @Test
    fun `a peer that ignores ACKs cannot grow the storage queue without bound`() {
        val entered = CountDownLatch(1)
        val staging = temp.newFolder("staging-stuck")
        val rig = rig(store = StuckWriteStore(staging, entered))
        val remote = connect(rig)
        // A file large enough that its content exceeds the queued-byte ceiling.
        val fileSize = 3L * RealtimeFrame.FLOW_WINDOW_BYTES
        val sender = promptIncoming(rig, remote, listOf(FileMeta("big.bin", fileSize)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        // Feed chunks well past the ceiling; the first write blocks, the rest
        // queue, and the bound must cancel the receive truthfully.
        val chunk = ByteArray(RealtimeFrame.CHUNK_SIZE) { 7 }
        var fed = 0L
        while (fed < fileSize && rig.controller.state.value.errorKey == null) {
            for (frame in sender.chunkFrames(chunk, remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
                rig.transport.events.onFileFrame(frame)
            }
            fed += chunk.size
            if (fed > 4L * RealtimeFrame.FLOW_WINDOW_BYTES) break
        }
        awaitTrue("the queue bound cancelled the receive") {
            rig.controller.state.value.errorKey == "error_save_failed"
        }
        assertTrue("it cancelled before the whole file was queued", fed < fileSize)
    }

    @Test
    fun `cancelling the send closes a stream blocked inside its read`() {
        val rig = rig()
        connect(rig)
        val closed = CountDownLatch(1)
        val reading = CountDownLatch(1)
        val blockedSource = TransferController.OutgoingSource(FileMeta("blocked.bin", 8)) {
            object : InputStream() {
                override fun read(): Int = throw UnsupportedOperationException()
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    reading.countDown()
                    // Blocks until the descriptor is closed out from under it.
                    closed.await(10, TimeUnit.SECONDS)
                    throw java.io.IOException("closed")
                }
                override fun close() { closed.countDown() }
            }
        }
        rig.controller.sendFiles(listOf(blockedSource))
        awaitTrue("manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue("the pump reached its blocking read", reading.await(5, TimeUnit.SECONDS))
        rig.controller.cancelSend()
        assertTrue(
            "cancel must close the owned stream, unblocking the read",
            closed.await(5, TimeUnit.SECONDS),
        )
    }

    @Test
    fun `shutdown tears the transport down even as the storage executor stops`() {
        val rig = rig()
        connect(rig)
        val transport = rig.transport
        rig.controller.shutdown()
        awaitTrue("the transport was closed during shutdown, not skipped by a throw") {
            transport.closedReason != null
        }
    }

    /** A store whose [write] parks the storage thread inside the provider until
     *  [release] opens, counting every [discard] so a test can prove the queued
     *  final cleanup DRAINED after shutdown rather than being dropped. */
    private class ParkedWriteStore(
        root: File,
        val entered: CountDownLatch,
        val release: CountDownLatch,
    ) : ReceiveStore(root) {
        val discards = java.util.concurrent.atomic.AtomicInteger()
        override fun write(index: Int, bytes: ByteArray): Outcome {
            entered.countDown()
            release.await(30, TimeUnit.SECONDS)
            return super.write(index, bytes)
        }
        override fun discard(): Outcome {
            discards.incrementAndGet()
            return super.discard()
        }
    }

    @Test
    fun `shutdown never blocks its caller on a storage drain`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val store = ParkedWriteStore(temp.newFolder("staging-parked"), entered, release)
        val rig = rig(store = store)
        val remote = connect(rig)
        val sender = promptIncoming(rig, remote, listOf(FileMeta("in.bin", 3)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in sender.chunkFrames(byteArrayOf(1, 2, 3), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        assertTrue("the storage thread is parked inside the provider", entered.await(5, TimeUnit.SECONDS))
        val discardsBefore = store.discards.get()
        val transport = rig.transport

        // The caller (MAIN, in the app) must come back at once; the old
        // teardown awaited the storage drain for up to five seconds per owner.
        val begun = System.nanoTime()
        rig.controller.shutdown()
        val callerMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begun)
        assertEquals("the provider write is still parked", 1, release.count)
        assertTrue("shutdown() must not await the storage drain (took ${callerMs}ms)", callerMs < 2_000)

        // Transport and signalling teardown must not depend on that drain.
        awaitTrue("the transport was torn down while storage stayed parked") {
            transport.closedReason != null
        }
        assertEquals("and storage was STILL parked when it died", 1, release.count)

        // When the provider finally answers, the queued cleanup drains — its
        // outcome was never made moot by a prematurely stopped executor.
        release.countDown()
        assertTrue("both owners terminate", rig.controller.awaitShutdown(5_000))
        assertTrue(
            "the queued final discard ran after shutdown",
            store.discards.get() > discardsBefore,
        )
    }

    // Root-authored regression (foundation-closure-independent), retained
    // verbatim: a cancel that lands while open() is still running must not
    // leak the descriptor the open eventually returns.
    @Test
    fun `independent cancel during open closes the acquired stream`() {
        val rig = rig()
        connect(rig)
        val opening = CountDownLatch(1)
        val releaseOpen = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val source = TransferController.OutgoingSource(FileMeta("late.bin", 1)) {
            opening.countDown()
            releaseOpen.await(5, TimeUnit.SECONDS)
            object : InputStream() {
                override fun read(): Int = -1
                override fun close() { closed.countDown() }
            }
        }
        rig.controller.sendFiles(listOf(source))
        awaitTrue("manifest") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue(opening.await(5, TimeUnit.SECONDS))
        rig.controller.cancelSend()
        awaitTrue("cancel applied") { rig.controller.state.value.outgoing.isEmpty() }
        releaseOpen.countDown()
        assertTrue("cancelled open must close its late descriptor without another user action", closed.await(2, TimeUnit.SECONDS))
    }

    @Test
    fun `a retired pump's late open cannot disturb the next pump's stream`() {
        val rig = rig()
        connect(rig)
        val oldOpening = CountDownLatch(1)
        val oldRelease = CountDownLatch(1)
        val oldClosed = CountDownLatch(1)
        val oldSource = TransferController.OutgoingSource(FileMeta("old.bin", 1)) {
            oldOpening.countDown()
            oldRelease.await(10, TimeUnit.SECONDS)
            object : InputStream() {
                override fun read(): Int = -1
                override fun close() { oldClosed.countDown() }
            }
        }
        rig.controller.sendFiles(listOf(oldSource))
        awaitTrue("old manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue(oldOpening.await(5, TimeUnit.SECONDS))
        rig.controller.cancelSend()
        awaitTrue("the cancel barrier went out") {
            controlFrames(rig, RealtimeFrame.CTRL_BATCH_ABORT) >= 1
        }

        // A NEW batch starts while the OLD open is still in flight.
        val newClosed = CountDownLatch(1)
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("new.bin", 2)) {
                    object : ByteArrayInputStream(byteArrayOf(7, 7)) {
                        override fun close() { newClosed.countDown(); super.close() }
                    }
                },
            ),
        )
        awaitTrue("new manifest out") {
            rig.transport.fileFrames.count { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_BATCH_ENC } == 2
        }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)

        // NOW the old open returns, racing the new pump's ownership. Its lease
        // was retired, so the OLD descriptor closes itself…
        oldRelease.countDown()
        assertTrue("the late old open closed its own result", oldClosed.await(5, TimeUnit.SECONDS))
        // …and the NEW pump keeps its stream: the batch streams to its DONE,
        // which a stolen or misclosed descriptor could never produce.
        awaitTrue("the new batch streamed to its DONE") {
            rig.transport.fileFrames.any { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_DONE_ENC }
        }
        assertTrue(
            "the new stream was closed by its own pump when done",
            newClosed.await(5, TimeUnit.SECONDS),
        )
    }

    /** The peer stopping an accepted batch (REJECT mid-stream) must surrender
     *  the pump's blocked descriptor exactly as a local cancel does. */
    @Test
    fun `a peer reject closes a stream blocked inside its read`() {
        val rig = rig()
        connect(rig)
        val closed = CountDownLatch(1)
        val reading = CountDownLatch(1)
        rig.controller.sendFiles(listOf(blockedReadSource(reading, closed)))
        awaitTrue("manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue("the pump reached its blocking read", reading.await(5, TimeUnit.SECONDS))
        rig.transport.events.onFileFrame(RealtimeFrame.REJECT)
        assertTrue("the peer's stop closed the owned stream", closed.await(5, TimeUnit.SECONDS))
    }

    /** A fatal LANE failure — here a malformed frame poisoning the codecs —
     *  is a stop cause like any other: the pump's stream closes. */
    @Test
    fun `a lane failure closes a stream blocked inside its read`() {
        val rig = rig()
        connect(rig)
        val closed = CountDownLatch(1)
        val reading = CountDownLatch(1)
        rig.controller.sendFiles(listOf(blockedReadSource(reading, closed)))
        awaitTrue("manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue("the pump reached its blocking read", reading.await(5, TimeUnit.SECONDS))
        // An undecryptable content frame is a protocol violation on the lane.
        rig.transport.events.onFileFrame(ByteArray(64) { 0x42 })
        awaitTrue("the lane failed") { rig.controller.state.value.fileLaneDown }
        assertTrue("the lane failure closed the owned stream", closed.await(5, TimeUnit.SECONDS))
    }

    @Test
    fun `shutdown closes a stream blocked inside its read`() {
        val rig = rig()
        connect(rig)
        val closed = CountDownLatch(1)
        val reading = CountDownLatch(1)
        rig.controller.sendFiles(listOf(blockedReadSource(reading, closed)))
        awaitTrue("manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue("the pump reached its blocking read", reading.await(5, TimeUnit.SECONDS))
        rig.controller.shutdown()
        assertTrue("teardown closed the owned stream", closed.await(5, TimeUnit.SECONDS))
    }

    /** "Sent" derives from the peer's verified COMPLETE and nothing weaker:
     *  cancel also empties outgoing/progress, and must never read as success. */
    @Test
    fun `sentBatch is set by SendComplete and not by a cancel that clears the same fields`() {
        val rig = rig()
        connect(rig)
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("ok.bin", 2)) {
                    ByteArrayInputStream(byteArrayOf(5, 5))
                },
            ),
        )
        awaitTrue("manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        awaitTrue("streamed to DONE") {
            rig.transport.fileFrames.any { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_DONE_ENC }
        }
        assertFalse("DONE alone is not sent", rig.controller.state.value.sentBatch)
        rig.transport.events.onFileFrame(RealtimeFrame.COMPLETE)
        awaitTrue("the peer's COMPLETE is what makes it sent") {
            rig.controller.state.value.sentBatch
        }

        // A second batch resets the claim, and cancelling it must not restore it.
        val reading = CountDownLatch(1)
        val closed = CountDownLatch(1)
        rig.controller.sendFiles(listOf(blockedReadSource(reading, closed)))
        awaitTrue("second manifest") {
            rig.transport.fileFrames.count { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_BATCH_ENC } == 2
        }
        assertFalse("a new batch clears the previous claim", rig.controller.state.value.sentBatch)
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue(reading.await(5, TimeUnit.SECONDS))
        rig.controller.cancelSend()
        awaitTrue("cancel cleared the batch") { rig.controller.state.value.outgoing.isEmpty() }
        assertFalse(
            "empty outgoing/progress after a cancel must not read as sent",
            rig.controller.state.value.sentBatch,
        )
    }

    /**
     * R20: the counter is the only DURABLE per-batch completion edge.
     *
     * The interop acceptance once started a second batch asynchronously and
     * then waited on `sentBatch && outgoing.isEmpty()` — both still true from
     * the FIRST batch while the new one's metadata IO and admission were in
     * flight — so the observer advanced past a batch that had not begun and
     * tore the session down mid-transfer. This drives the real controller
     * through that exact window: between batch 1's COMPLETE and batch 2's
     * admission the flags lie, and the counter does not. A tiny batch can
     * also START and FINISH between two polls of any transient field; the
     * counter's +1 is an edge no polling cadence can miss.
     */
    @Test
    fun `sentBatchCount advances once per verified COMPLETE and never on a cancel`() {
        val rig = rig()
        connect(rig)
        assertEquals(0, rig.controller.state.value.sentBatchCount)

        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("one.bin", 2)) {
                    ByteArrayInputStream(byteArrayOf(1, 1))
                },
            ),
        )
        awaitTrue("manifest out") { rig.transport.fileFrames.size == 1 }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        awaitTrue("streamed to DONE") {
            rig.transport.fileFrames.any { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_DONE_ENC }
        }
        assertEquals(
            "DONE alone is not a completed batch",
            0, rig.controller.state.value.sentBatchCount,
        )
        rig.transport.events.onFileFrame(RealtimeFrame.COMPLETE)
        awaitTrue("the peer's verified COMPLETE advances the counter") {
            rig.controller.state.value.sentBatchCount == 1
        }

        // THE WINDOW: exactly what an observer polling before the second
        // batch's admission sees. The boolean pair cannot distinguish it from
        // "the second batch completed"; the counter can.
        val window = rig.controller.state.value
        assertTrue(
            "the stale flags read as complete-and-idle in the window",
            window.sentBatch && window.outgoing.isEmpty(),
        )
        assertEquals("the counter still says one batch", 1, window.sentBatchCount)

        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("two.bin", 2)) {
                    ByteArrayInputStream(byteArrayOf(2, 2))
                },
            ),
        )
        awaitTrue("second manifest") {
            rig.transport.fileFrames.count { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_BATCH_ENC } == 2
        }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        awaitTrue("second DONE") {
            rig.transport.fileFrames.count { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_DONE_ENC } == 2
        }
        assertEquals(
            "still one completed batch until the peer confirms the second",
            1, rig.controller.state.value.sentBatchCount,
        )
        rig.transport.events.onFileFrame(RealtimeFrame.COMPLETE)
        awaitTrue("two verified COMPLETEs, two counts") {
            rig.controller.state.value.sentBatchCount == 2
        }

        // A cancelled batch retires without ever counting.
        val reading = CountDownLatch(1)
        val closed = CountDownLatch(1)
        rig.controller.sendFiles(listOf(blockedReadSource(reading, closed)))
        awaitTrue("third manifest") {
            rig.transport.fileFrames.count { RealtimeFrame.kindOf(it) == RealtimeFrame.KIND_BATCH_ENC } == 3
        }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        assertTrue(reading.await(5, TimeUnit.SECONDS))
        rig.controller.cancelSend()
        awaitTrue("the cancel retired the batch") {
            rig.controller.state.value.outgoing.isEmpty()
        }
        assertEquals(
            "a cancel is not a completion",
            2, rig.controller.state.value.sentBatchCount,
        )
    }

    /** The inbound twin: one count per SAVED-AND-VERIFIED batch, none for a
     *  cancelled receive — so a fresh-batch observer on the same link owns an
     *  edge that `savedBatch` (reset only when the NEXT prompt arrives) does
     *  not provide. */
    @Test
    fun `savedBatchCount advances once per completed receive and never on a cancel`() {
        val rig = rig()
        val remote = connect(rig)
        assertEquals(0, rig.controller.state.value.savedBatchCount)

        // Batch 1 completes end to end through the real store.
        val peerSender = promptIncoming(rig, remote, listOf(FileMeta("in1.bin", 3)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in peerSender.chunkFrames(byteArrayOf(1, 2, 3), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        rig.transport.events.onFileFrame(
            peerSender.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), byteArrayOf(1, 2, 3)), remote),
        )
        awaitTrue("one saved batch, one count") {
            rig.controller.state.value.savedBatchCount == 1
        }

        // Batch 2, SAME link, later global sequence: the counter is the edge.
        for (frame in peerSender.batchFrames(
            listOf(FileMeta("in2.bin", 2)), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("second prompt") { rig.controller.state.value.awaitingFolder }
        assertEquals("a prompt is not a save", 1, rig.controller.state.value.savedBatchCount)
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("second accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in peerSender.chunkFrames(byteArrayOf(4, 5), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        rig.transport.events.onFileFrame(
            peerSender.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), byteArrayOf(4, 5)), remote),
        )
        awaitTrue("two saved batches, two counts") {
            rig.controller.state.value.savedBatchCount == 2
        }

        // Batch 3 is cancelled after acceptance: retired, never counted.
        for (frame in peerSender.batchFrames(
            listOf(FileMeta("in3.bin", 4)), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("third prompt") { rig.controller.state.value.awaitingFolder }
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("third accepted") { !rig.controller.state.value.awaitingFolder }
        rig.controller.cancelReceive()
        awaitTrue("the cancel emptied the incoming batch") {
            rig.controller.state.value.incoming.isEmpty()
        }
        assertEquals(
            "a cancelled receive is not a saved batch",
            2, rig.controller.state.value.savedBatchCount,
        )
    }

    /**
     * R22: cancelling AT THE PROMPT retires the prompt itself.
     *
     * `cancelIncoming` at PROMPT funnels into the same DiscardIncoming action
     * as every other retiring path, and that action used to clear the file
     * list but not `awaitingFolder` — leaving a prompt flag standing over an
     * EMPTY batch. The next observer then consumed the stale prompt (old
     * promptId, no files) before the real next offer arrived, which is how
     * the acceptance's receive-retry silently waited out its timeout.
     */
    @Test
    fun `a cancel at the prompt clears the prompt, not only the batch`() {
        val rig = rig()
        val remote = connect(rig)
        promptIncoming(rig, remote, listOf(FileMeta("cancelled.bin", 16)))
        rig.controller.cancelReceive()
        awaitTrue("the cancelled prompt's batch is gone") {
            rig.controller.state.value.incoming.isEmpty()
        }
        assertFalse(
            "a cancelled prompt must not keep advertising a folder request",
            rig.controller.state.value.awaitingFolder,
        )
        awaitTrue("and the peer was told") { controlFrames(rig, RealtimeFrame.CTRL_REJECT) >= 1 }
    }

    /**
     * R22, the racing shape the instrumentation actually creates: the cancel
     * lands while the folder-picker BEGIN is still resolving on the storage
     * thread. The late begin must not ACCEPT the cancelled batch, the stale
     * prompt must be gone, and the NEXT offer must arrive as a fresh prompt —
     * new id, real files — and complete end to end.
     */
    @Test
    fun `a cancel during a pending begin retires it and the next offer completes`() {
        val gate = CountDownLatch(1)
        val staging = temp.newFolder("staging-cancel-pending")
        val rig = rig(store = GatedBeginStore(staging, gate))
        val remote = connect(rig)
        val peer = promptIncoming(rig, remote, listOf(FileMeta("a.bin", 3)))
        val firstPrompt = rig.controller.state.value.promptId

        // Accept: begin blocks inside the store, so the prompt is still
        // formally unanswered when the user cancels.
        rig.controller.acceptIncoming(firstPrompt, rig.ops.node(rig.treeDir))
        Thread.sleep(150) // the blocked begin has reached the store
        rig.controller.cancelReceive()
        awaitTrue("the cancel retired the batch") {
            rig.controller.state.value.incoming.isEmpty()
        }
        assertFalse(
            "no stale folder request may survive the cancel",
            rig.controller.state.value.awaitingFolder,
        )

        // The blocked begin NOW completes successfully — for a batch that no
        // longer exists. It must be inert.
        gate.countDown()
        Thread.sleep(300)
        assertEquals(
            "a late begin must not ACCEPT a cancelled batch",
            0, controlFrames(rig, RealtimeFrame.CTRL_ACCEPT),
        )

        // The peer retires its side with the ordered barrier and offers a NEW
        // batch on the same link.
        peer.batchAborted()
        rig.transport.events.onFileFrame(RealtimeFrame.BATCH_ABORT)
        for (frame in peer.batchFrames(
            listOf(FileMeta("b.bin", 2)), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("the next offer is a FRESH prompt, not the stale one") {
            val s = rig.controller.state.value
            s.awaitingFolder && s.promptId > firstPrompt && s.incoming.map { it.name } == listOf("b.bin")
        }
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in peer.chunkFrames(byteArrayOf(4, 5), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        rig.transport.events.onFileFrame(
            peer.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), byteArrayOf(4, 5)), remote),
        )
        awaitTrue("the fresh offer completed end to end") {
            rig.controller.state.value.savedBatchCount == 1 &&
                File(rig.treeDir, "b.bin").takeIf { it.exists() }?.readBytes()
                    ?.contentEquals(byteArrayOf(4, 5)) == true
        }
    }

    /**
     * R20: a cancelled receive is followed by a fresh receive on the SAME
     * link, and THAT completes — the receive-retry the acceptance drives.
     *
     * The whole cancel exchange has to land first: this side sends REJECT and
     * DRAINS, the peer answers the ordered BATCH_ABORT, and only then does the
     * next batch's manifest arrive. A receiver left in DRAINING, or with a
     * stranded generation or an unreset chain, would prompt the next batch and
     * never save it — exactly the emulator symptom this reproduces without the
     * emulator.
     */
    @Test
    fun `a fresh receive after a cancelled one completes on the same link`() {
        val rig = rig()
        val remote = connect(rig)

        // Batch A: prompt, accept, one chunk so the receiver is really RECEIVING.
        val peer = promptIncoming(rig, remote, listOf(FileMeta("a.bin", 3)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("A accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in peer.chunkFrames(byteArrayOf(1, 2, 3), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }

        // The user cancels. REJECT goes out and the receiver drains.
        rig.controller.cancelReceive()
        awaitTrue("the cancel emptied the incoming batch") {
            rig.controller.state.value.incoming.isEmpty()
        }
        awaitTrue("a REJECT told the peer") { controlFrames(rig, RealtimeFrame.CTRL_REJECT) >= 1 }

        // The peer answers the ordered barrier, exactly as the Web sender does
        // when it sees the REJECT: it retires its batch and the sequence
        // continues across it.
        peer.batchAborted()
        rig.transport.events.onFileFrame(RealtimeFrame.BATCH_ABORT)
        assertEquals(
            "a cancelled receive is not a save",
            0, rig.controller.state.value.savedBatchCount,
        )

        // Batch B on the SAME link, later in the one global sequence: it must
        // prompt, accept and SAVE.
        for (frame in peer.batchFrames(
            listOf(FileMeta("b.bin", 2)), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES,
        )) {
            rig.transport.events.onFileFrame(frame)
        }
        awaitTrue("B prompted") { rig.controller.state.value.awaitingFolder }
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("B accepted") { !rig.controller.state.value.awaitingFolder }
        for (frame in peer.chunkFrames(byteArrayOf(4, 5), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) {
            rig.transport.events.onFileFrame(frame)
        }
        rig.transport.events.onFileFrame(
            peer.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), byteArrayOf(4, 5)), remote),
        )
        awaitTrue("the fresh receive after the cancel saved and verified") {
            rig.controller.state.value.savedBatchCount == 1 &&
                File(rig.treeDir, "b.bin").takeIf { it.exists() }?.readBytes()
                    ?.contentEquals(byteArrayOf(4, 5)) == true
        }
        awaitTrue("and COMPLETE went back for B") {
            controlFrames(rig, RealtimeFrame.CTRL_COMPLETE) >= 1
        }
    }

    /**
     * R14: the picker fence is enforced at the EFFECT boundary — inside the
     * session executor, against the controller's own link identity — not by a
     * UI comparing tokens somewhere earlier. The scenario is the real one: a
     * picker result held across the end of one link and the establishment of
     * ANOTHER, both in the same CONNECTED phase, released only after the new
     * peer exists.
     */
    @Test
    fun `a picker result from an old link cannot send to a new same-phase peer`() {
        val rig = rig()
        connect(rig)
        val oldLink = rig.controller.state.value.linkId

        // The user is inside the system picker; meanwhile the link dies and a
        // NEW join connects to a DIFFERENT peer, reaching the same phase.
        rig.controller.disconnect()
        awaitTrue("old link ended") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED
        }
        val oldEvents = rig.signaling.events
        rig.controller.join(PairCode("222222"), TransferController.Intent.JOINER)
        awaitTrue("the new join wired fresh signalling") { rig.signaling.events !== oldEvents }
        rig.signaling.events.onSelfId("aaaaaaaa", "")
        rig.signaling.events.onPeers(listOf(Envelope.Peer("cccccccc", "peer")))
        rig.signaling.events.onSignal("cccccccc", capsHello())
        awaitTrue("a second transport for the new peer") { rig.transports.size == 2 }
        val (local, _) = mirroredKeys()
        rig.transports.last().events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("the new link is CONNECTED — same phase as the old one") {
            rig.controller.state.value.phase == TransferController.Phase.CONNECTED
        }
        val newLink = rig.controller.state.value.linkId
        assertTrue("distinct sessions have distinct identities", newLink != oldLink)
        val newTransport = rig.transports.last()
        val framesBefore = newTransport.fileFrames.size

        // NOW the old pick lands, carrying the identity it was launched under.
        val opened = CountDownLatch(1)
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("held.bin", 2)) {
                    opened.countDown()
                    ByteArrayInputStream(byteArrayOf(9, 9))
                },
            ),
            expectedLink = oldLink,
        )
        Thread.sleep(300)
        assertEquals(
            "no manifest may reach the new peer for an old link's pick",
            framesBefore, newTransport.fileFrames.size,
        )
        assertTrue("the old pick's source was never even opened", opened.count == 1L)
        assertTrue(
            "and the new link shows no outgoing batch or error from it",
            rig.controller.state.value.outgoing.isEmpty() &&
                rig.controller.state.value.errorKey == null,
        )

        // The SAME sources under the CURRENT identity do send: the fence
        // gates identity, not the feature.
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("fresh.bin", 2)) {
                    ByteArrayInputStream(byteArrayOf(9, 9))
                },
            ),
            expectedLink = newLink,
        )
        awaitTrue("the current link's pick sends its manifest") {
            newTransport.fileFrames.size > framesBefore
        }
    }

    /**
     * R15.1: the SAME exact-peer boundary as the picker fence above, for TEXT.
     *
     * A draft is composed against one rendered connection. The tap that sends
     * it crosses onto the session executor, and a join can complete in that
     * window — so a body typed for the old peer must not be sealed for the new
     * one. The lane is deliberately OPEN on the new link here: a refusal that
     * only happened because no text lane existed would prove nothing.
     */
    @Test
    fun `a draft typed for an old link cannot be sent to a new same-phase peer`() {
        val rig = rig()
        val oldRemote = connect(rig)
        openText(rig, oldRemote)
        val oldLink = rig.controller.state.value.linkId

        rig.controller.disconnect()
        awaitTrue("old link ended") {
            rig.controller.state.value.phase == TransferController.Phase.ENDED
        }
        val oldEvents = rig.signaling.events
        rig.controller.join(PairCode("222222"), TransferController.Intent.JOINER)
        awaitTrue("the new join wired fresh signalling") { rig.signaling.events !== oldEvents }
        rig.signaling.events.onSelfId("aaaaaaaa", "")
        rig.signaling.events.onPeers(listOf(Envelope.Peer("cccccccc", "peer")))
        rig.signaling.events.onSignal("cccccccc", capsHello())
        awaitTrue("a second transport for the new peer") { rig.transports.size == 2 }
        val (local, _) = mirroredKeys()
        rig.transports.last().events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("the new link is CONNECTED — same phase as the old one") {
            rig.controller.state.value.phase == TransferController.Phase.CONNECTED
        }
        val newLink = rig.controller.state.value.linkId
        assertTrue("distinct sessions have distinct identities", newLink != oldLink)
        // The new peer's text lane is OPEN, so nothing but the fence can refuse.
        // Driven through the NEW transport — `rig.transport` is the first one.
        val newTransport = rig.transports.last()
        newTransport.events.onTextFrame(TextWire.REQUEST)
        awaitTrue("the new peer's text request") {
            rig.controller.state.value.textState == TextLaneSession.State.INCOMING_REQUEST
        }
        rig.controller.acceptText()
        awaitTrue("the new peer's text lane is open") {
            rig.controller.state.value.textState == TextLaneSession.State.OPEN
        }
        val framesBefore = newTransport.textFrames.size

        val stale = ArrayList<Boolean>()
        rig.controller.sendText("for the old peer only", expectedLink = oldLink) { stale.add(it) }
        awaitTrue("the stale send reported an outcome") { stale.size == 1 }
        assertFalse("an old link's draft must not report success", stale[0])
        assertEquals(
            "no text frame may reach the new peer for an old link's draft",
            framesBefore, newTransport.textFrames.size,
        )
        assertTrue(
            "and no message row may claim it was sent",
            rig.controller.state.value.messages.isEmpty(),
        )

        // The fence gates IDENTITY, not the feature: the same body under the
        // current link goes out and only then reports success.
        val fresh = ArrayList<Boolean>()
        rig.controller.sendText("for the old peer only", expectedLink = newLink) { fresh.add(it) }
        awaitTrue("the current link's draft reports an outcome") { fresh.size == 1 }
        assertTrue("the current link's draft is delivered", fresh[0])
        assertTrue(
            "and its frame really went out",
            newTransport.textFrames.size > framesBefore,
        )
        assertEquals(1, rig.controller.state.value.messages.size)
    }

    /**
     * A cancelled outgoing batch is OVER, and the state says so.
     *
     * Two failures in one: the card would otherwise keep offering Cancel for a
     * batch that no longer exists, and — the one the interop acceptance needs
     * — there would be no observable edge between "cancelled" and "ready for
     * another batch". `sentBatch` is already false BEFORE a cancel, so a retry
     * that waited on it would be waiting on nothing and would then race the
     * retirement it meant to follow.
     */
    @Test
    fun `a cancelled send clears the batch and leaves the lane ready for a fresh one`() {
        val rig = rig()
        connect(rig)
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("first.bin", 3)) {
                    ByteArrayInputStream(byteArrayOf(1, 2, 3))
                },
            ),
        )
        awaitTrue("the batch started") { rig.controller.state.value.outgoing.isNotEmpty() }
        val framesBefore = rig.transport.fileFrames.size

        rig.controller.cancelSend()
        awaitTrue("the cancelled batch is no longer active") {
            val s = rig.controller.state.value
            s.outgoing.isEmpty() && s.sendProgress == null && !s.sentBatch
        }
        assertTrue(
            "the peer was told, so this is a real cancel and not just a cleared list",
            rig.transport.fileFrames.size > framesBefore,
        )

        // And the lane really is ready: a fresh batch starts and its manifest
        // goes out. A cancel that left the lane unusable would be a worse bug
        // than the stuck card.
        val afterCancel = rig.transport.fileFrames.size
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("second.bin", 2)) {
                    ByteArrayInputStream(byteArrayOf(9, 9))
                },
            ),
        )
        awaitTrue("the fresh batch's manifest went out") {
            rig.transport.fileFrames.size > afterCancel
        }
        assertEquals(
            listOf("second.bin"),
            rig.controller.state.value.outgoing.map { it.name },
        )
    }

    // ── the shipped legacy wire ─────────────────────────────────────────────

    /** Short settle, so the "waits for the window" rows resolve in a test. */
    private fun settlingTimeouts(settleMs: Long = 60, deadlineMs: Long = 60_000) =
        quietTimeouts().copy(settleMs = settleMs, requestDeadlineMs = deadlineMs)

    private fun hello(vararg caps: String): Json =
        Json.obj("caps" to Json.arr(caps.map(Json::of)))

    private fun legacyProfile(rig: Rig): WireProfile.Legacy =
        rig.transport.profile as WireProfile.Legacy

    /** Drive a legacy connection to CONNECTED and return the PEER's keys. */
    private fun readyLegacy(rig: Rig): Crypto.SessionKeys {
        val (local, remote) = mirroredKeys()
        rig.transport.events.onReady(local, "705955", RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        awaitTrue("connected") { rig.controller.state.value.phase == TransferController.Phase.CONNECTED }
        return remote
    }

    @Test
    fun `a minter offers the message generation the instant the peer names it`() {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 60_000), intent = TransferController.Intent.MINTER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.signaling.events.onSignal("bbbbbbbb", hello("text/1"))
        // No settle wait: `text/1` is a positive statement about the peer.
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        val profile = legacyProfile(rig)
        assertEquals(LegacyProtocol.Lane.TEXT, profile.lane)
        assertEquals("the minter offers", LinkProtocol.Role.INITIATOR, profile.role)
    }

    @Test
    fun `a minter waits out the window before answering silence with files`() {
        val rig = rig(timeouts = settlingTimeouts(), intent = TransferController.Intent.MINTER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        // A peer that has said nothing is indistinguishable from one that has
        // not said it YET, so nothing may be decided here.
        Thread.sleep(20)
        assertTrue("no transport before the window closes", rig.transports.isEmpty())
        awaitTrue("transport after the window") { rig.transports.isNotEmpty() }
        val profile = legacyProfile(rig)
        assertEquals(LegacyProtocol.Lane.FILES, profile.lane)
        assertEquals(LinkProtocol.Role.INITIATOR, profile.role)
    }

    @Test
    fun `a capability that is not this wire resolves to files, not to a hang`() {
        // The fixture's `link/2` / `LINK/1` / `text/2` rows: announced, but not
        // anything this client can act on.
        for (cap in listOf("link/2", "LINK/1", "text/2")) {
            val rig = rig(timeouts = settlingTimeouts(), intent = TransferController.Intent.MINTER)
            rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
            rig.signaling.events.onSignal("bbbbbbbb", hello(cap))
            awaitTrue("transport for $cap") { rig.transports.isNotEmpty() }
            assertEquals(cap, LegacyProtocol.Lane.FILES, legacyProfile(rig).lane)
        }
    }

    @Test
    fun `a joiner never offers and adopts the generation of the offer it receives`() {
        val rig = rig(timeouts = settlingTimeouts(), intent = TransferController.Intent.JOINER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        val offer = LegacyProtocol.offer("v=0\r\n", "Y29tbWl0", LegacyProtocol.Lane.FILES).toJson()
        rig.signaling.events.onSignal("bbbbbbbb", offer)
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        val profile = legacyProfile(rig)
        assertEquals(LegacyProtocol.Lane.FILES, profile.lane)
        assertEquals("the joiner answers", LinkProtocol.Role.RESPONDER, profile.role)
        // And the offer that created it is handed on, not dropped: rebuilding
        // the session without it would strand a peer that already offered.
        awaitTrue("offer forwarded") { rig.transport.signals.isNotEmpty() }
        assertEquals(Json.stringify(offer), Json.stringify(rig.transport.signals.peek()))
    }

    @Test
    fun `a joiner adopts a message offer only when it carries exact text slash 1`() {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 60_000, deadlineMs = 60), intent = TransferController.Intent.JOINER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        // `text:true` with no capability: the peer cannot decode kind 9, so
        // answering would build a connection that can never carry a message.
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            Signal(sdpType = "offer", sdp = "v=0", commit = "Y29tbWl0", text = true).toJson(),
        )
        Thread.sleep(20)
        assertTrue("no session for a dialect this side cannot speak", rig.transports.isEmpty())

        val ok = rig(timeouts = settlingTimeouts(), intent = TransferController.Intent.JOINER)
        ok.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        ok.signaling.events.onSignal(
            "bbbbbbbb",
            LegacyProtocol.offer("v=0", "Y29tbWl0", LegacyProtocol.Lane.TEXT).toJson(),
        )
        awaitTrue("transport created") { ok.transports.isNotEmpty() }
        assertEquals(LegacyProtocol.Lane.TEXT, legacyProfile(ok).lane)
    }

    @Test
    fun `a joiner that is never offered to says so instead of connecting forever`() {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 30, deadlineMs = 60), intent = TransferController.Intent.JOINER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        awaitTrue("truthful end") {
            rig.controller.state.value.errorKey == "error_legacy_no_offer"
        }
        assertEquals(TransferController.Phase.ENDED, rig.controller.state.value.phase)
    }

    @Test
    fun `a minter does not answer an inbound legacy offer as well as making one`() {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 60_000), intent = TransferController.Intent.MINTER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            LegacyProtocol.offer("v=0", "Y29tbWl0", LegacyProtocol.Lane.FILES).toJson(),
        )
        Thread.sleep(30)
        // Two offers into one connection is exactly what the explicit intent
        // exists to prevent.
        assertTrue(rig.transports.isEmpty())
    }

    @Test
    fun `a legacy offer cannot replace a peer that announced the link`() {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 60_000), intent = TransferController.Intent.JOINER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.signaling.events.onSignal("bbbbbbbb", capsHello())
        awaitTrue("link transport") { rig.transports.isNotEmpty() }
        assertTrue(rig.transport.profile is WireProfile.Link)
        val before = rig.transports.size
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            LegacyProtocol.offer("v=0", "Y29tbWl0", LegacyProtocol.Lane.FILES).toJson(),
        )
        Thread.sleep(30)
        assertEquals("no second, older connection", before, rig.transports.size)
        assertNull(rig.transport.closedReason)
    }

    // ── generation fencing on ONE live controller ───────────────────────────

    @Test
    fun `link signals cannot reach or close a live legacy connection`() {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 60_000), intent = TransferController.Intent.JOINER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.signaling.events.onSignal(
            "bbbbbbbb",
            LegacyProtocol.offer("v=0", "Y29tbWl0", LegacyProtocol.Lane.FILES).toJson(),
        )
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        awaitTrue("offer forwarded") { rig.transport.signals.size == 1 }
        readyLegacy(rig)

        // Every `link/1` frame the relay could choose, from the SAME peer this
        // session is established with. On the older wire a `busy` would close
        // it, a `commit` would fail it as a replacement and a reveal would be
        // checked against a commitment it never made.
        for (signal in listOf(
            Signal.busy(),
            Signal.offer("v=0", "b3RoZXI=", LinkProtocol.ADVERTISED_CAPS),
            Signal.answer("v=0", "b3RoZXI=", LinkProtocol.ADVERTISED_CAPS),
            Signal.reveal("a", "b"),
            Signal.candidate("cand", "0", 0),
        )) {
            rig.signaling.events.onSignal("bbbbbbbb", signal.toJson())
        }
        Thread.sleep(40)
        assertEquals("only the legacy offer ever reached the transport", 1, rig.transport.signals.size)
        assertNull("and nothing closed it", rig.transport.closedReason)
        assertEquals(TransferController.Phase.CONNECTED, rig.controller.state.value.phase)
    }

    // ── terminal message states close a connection that carries nothing else ─

    /** A connected legacy MESSAGE session, in the initiator role. */
    private fun legacyTextRig(): Pair<Rig, Crypto.SessionKeys> {
        val rig = rig(timeouts = settlingTimeouts(settleMs = 60_000), intent = TransferController.Intent.MINTER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        rig.signaling.events.onSignal("bbbbbbbb", hello("text/1"))
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        val remote = readyLegacy(rig)
        assertEquals(TransferController.Wire.LEGACY_TEXT, rig.controller.state.value.wire)
        assertEquals(TextLaneSession.State.REQUESTED, rig.controller.state.value.textState)
        return rig to remote
    }

    @Test
    fun `a peer refusal ends a message-only connection and says why`() {
        val (rig, _) = legacyTextRig()
        rig.transport.events.onTextFrame(TextWire.REJECT)
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        val state = rig.controller.state.value
        assertEquals("error_text_refused", state.errorKey)
        // The final conversation state the user is left looking at is the real
        // one, not the state before the refusal.
        assertEquals(TextLaneSession.State.ENDED, state.textState)
        awaitTrue("closed") { rig.transport.closedReason != null }
    }

    @Test
    fun `an unauthenticated message frame ends a message-only connection`() {
        val (rig, remote) = legacyTextRig()
        rig.transport.events.onTextFrame(TextWire.ACCEPT)
        awaitTrue("open") { rig.controller.state.value.textState == TextLaneSession.State.OPEN }
        val frame = TextWire.Sender().frame("hello", remote)
        frame[frame.size - 1] = (frame[frame.size - 1].toInt() xor 0x01).toByte()
        rig.transport.events.onTextFrame(frame)
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        assertEquals("error_text_failed", rig.controller.state.value.errorKey)
        assertEquals(TextLaneSession.State.FAILED, rig.controller.state.value.textState)
        awaitTrue("closed") { rig.transport.closedReason != null }
    }

    @Test
    fun `a refused enqueue ends a message-only connection instead of leaving a dead composer`() {
        val (rig, _) = legacyTextRig()
        rig.transport.events.onTextFrame(TextWire.ACCEPT)
        awaitTrue("open") { rig.controller.state.value.textState == TextLaneSession.State.OPEN }
        rig.transport.acceptText = false
        rig.controller.sendText("hi", expectedLink = rig.controller.state.value.linkId)
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        assertEquals(TextLaneSession.State.FAILED, rig.controller.state.value.textState)
        assertTrue("no false sent message", rig.controller.state.value.messages.isEmpty())
    }

    @Test
    fun `ending a legacy conversation ends the connection carrying it`() {
        val (rig, _) = legacyTextRig()
        rig.transport.events.onTextFrame(TextWire.ACCEPT)
        awaitTrue("open") { rig.controller.state.value.textState == TextLaneSession.State.OPEN }
        rig.controller.endText()
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        awaitTrue("closed") { rig.transport.closedReason != null }
        // No `link/1` leave is sent to a peer that could neither read nor
        // verify one.
        assertFalse(
            rig.signaling.sent.any { (_, data) -> (data as Json.Obj)["leave"] != null },
        )
    }

    // ── files on the older wire ─────────────────────────────────────────────

    private fun legacyFilesRig(): Pair<Rig, Crypto.SessionKeys> {
        val rig = rig(timeouts = settlingTimeouts(), intent = TransferController.Intent.MINTER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        val remote = readyLegacy(rig)
        assertEquals(TransferController.Wire.LEGACY_FILES, rig.controller.state.value.wire)
        return rig to remote
    }

    @Test
    fun `cancelling a legacy receive disconnects, because the sender would not stop`() {
        val (rig, remote) = legacyFilesRig()
        promptIncoming(rig, remote, listOf(FileMeta("a.bin", 4)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { controlFrames(rig, RealtimeFrame.CTRL_ACCEPT) == 1 }
        rig.controller.cancelReceive()
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        // The REJECT still goes out — a sender still waiting for consent does
        // stop on it — but no `0xf8` barrier, which this wire has no byte for.
        assertEquals(1, controlFrames(rig, RealtimeFrame.CTRL_REJECT))
        assertEquals(0, controlFrames(rig, RealtimeFrame.CTRL_BATCH_ABORT))
        awaitTrue("closed") { rig.transport.closedReason != null }
    }

    @Test
    fun `a legacy connection tells the UI exactly which lane it has`() {
        val (files, _) = legacyFilesRig()
        files.controller.state.value.let {
            assertTrue(it.canSendFiles)
            assertFalse("no message lane exists on this connection", it.canSendMessages)
            assertTrue(it.cancelDisconnects)
        }
        val (text, _) = legacyTextRig()
        text.controller.state.value.let {
            assertFalse(it.canSendFiles)
            assertTrue(it.canSendMessages)
            assertTrue(it.cancelDisconnects)
        }
    }

    @Test
    fun `a link session still carries both lanes and cancels without disconnecting`() {
        val rig = rig()
        connect(rig)
        rig.controller.state.value.let {
            assertEquals(TransferController.Wire.LINK, it.wire)
            assertTrue(it.canSendFiles)
            assertTrue(it.canSendMessages)
            assertFalse(it.cancelDisconnects)
        }
    }

    // ── failures that are not a button, on a wire with no barrier ───────────

    /** A store whose WRITE fails, which is how a full or revoked destination
     *  actually surfaces. */
    private class FailingWriteStore(root: File) : ReceiveStore(root) {
        override fun write(index: Int, bytes: ByteArray): Outcome =
            Outcome.Failed(Outcome.Reason.WRITE_FAILED, cleanupComplete = true)
    }

    /** A store whose EXPORT fails — the batch verified, and committing it into
     *  the user's folder did not. */
    private class FailingExportStore(root: File) : ReceiveStore(root) {
        override fun export(index: Int): Outcome =
            Outcome.Failed(Outcome.Reason.EXPORT_FAILED, cleanupComplete = true)
    }

    private fun legacyFilesRigWith(store: ReceiveStore): Pair<Rig, Crypto.SessionKeys> {
        val rig = rig(timeouts = settlingTimeouts(), store = store, intent = TransferController.Intent.MINTER)
        rig.signaling.events.onPeers(listOf(Envelope.Peer("bbbbbbbb", "peer")))
        awaitTrue("transport created") { rig.transports.isNotEmpty() }
        val remote = readyLegacy(rig)
        assertEquals(TransferController.Wire.LEGACY_FILES, rig.controller.state.value.wire)
        return rig to remote
    }

    @Test
    fun `a failed write ends a legacy connection the sender would otherwise keep filling`() {
        // NOT a cancel button: a failed write reaches the lane through
        // `onWrite`, which calls `cancelIncoming` directly. On the older wire
        // the peer has no barrier to learn from, so it would go on streaming.
        val (rig, remote) = legacyFilesRigWith(FailingWriteStore(temp.newFolder("failwrite-${System.nanoTime()}")))
        val sender = promptIncoming(rig, remote, listOf(FileMeta("a.bin", 4)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { controlFrames(rig, RealtimeFrame.CTRL_ACCEPT) == 1 }
        rig.transport.events.onFileFrame(
            sender.chunkFrames(ByteArray(4), remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES).single(),
        )
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        assertEquals("error_save_failed", rig.controller.state.value.errorKey)
        awaitTrue("closed") { rig.transport.closedReason != null }
        assertEquals("and no byte this wire lacks", 0, controlFrames(rig, RealtimeFrame.CTRL_BATCH_ABORT))
    }

    @Test
    fun `a failed export ends a legacy connection instead of claiming completion`() {
        val (rig, remote) = legacyFilesRigWith(FailingExportStore(temp.newFolder("failexport-${System.nanoTime()}")))
        val sender = promptIncoming(rig, remote, listOf(FileMeta("a.bin", 4)))
        rig.controller.acceptIncoming(rig.controller.state.value.promptId, rig.ops.node(rig.treeDir))
        awaitTrue("accepted") { controlFrames(rig, RealtimeFrame.CTRL_ACCEPT) == 1 }
        val body = ByteArray(4) { it.toByte() }
        rig.transport.events.onFileFrame(
            sender.chunkFrames(body, remote, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES).single(),
        )
        rig.transport.events.onFileFrame(
            sender.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), body), remote),
        )
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        awaitTrue("closed") { rig.transport.closedReason != null }
        assertEquals("no false COMPLETE", 0, controlFrames(rig, RealtimeFrame.CTRL_COMPLETE))
        assertFalse(rig.controller.state.value.savedBatch)
    }

    @Test
    fun `a source that cannot be read ends a legacy connection mid-batch`() {
        val (rig, _) = legacyFilesRig()
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("broken.bin", 8)) {
                    object : InputStream() {
                        override fun read(): Int = throw java.io.IOException("gone")
                        override fun read(b: ByteArray, off: Int, len: Int): Int =
                            throw java.io.IOException("gone")
                    }
                },
            ),
            expectedLink = rig.controller.state.value.linkId,
        )
        // The receiver has to accept before the pump reads anything.
        awaitTrue("manifest out") { rig.transport.fileFrames.isNotEmpty() }
        rig.transport.events.onFileFrame(RealtimeFrame.ACCEPT)
        awaitTrue("ended") { rig.controller.state.value.phase == TransferController.Phase.ENDED }
        assertEquals("error_transfer_failed", rig.controller.state.value.errorKey)
        awaitTrue("closed") { rig.transport.closedReason != null }
    }

    @Test
    fun `a peer that declines a legacy batch leaves the connection usable`() {
        // The distinguishing case: the peer said so IN BAND and completed the
        // exchange, so nothing is in flight and neither side is stranded. A
        // decline must not read as a fault that ends the session.
        val (rig, _) = legacyFilesRig()
        rig.controller.sendFiles(
            listOf(
                TransferController.OutgoingSource(FileMeta("a.bin", 4)) { ByteArrayInputStream(ByteArray(4)) },
            ),
            expectedLink = rig.controller.state.value.linkId,
        )
        awaitTrue("manifest out") { rig.transport.fileFrames.isNotEmpty() }
        rig.transport.events.onFileFrame(RealtimeFrame.REJECT)
        awaitTrue("batch retired") { rig.controller.state.value.outgoing.isEmpty() }
        Thread.sleep(40)
        assertEquals(TransferController.Phase.CONNECTED, rig.controller.state.value.phase)
        assertNull(rig.transport.closedReason)
        assertEquals("and no barrier byte", 0, controlFrames(rig, RealtimeFrame.CTRL_BATCH_ABORT))
    }

    @Test
    fun `declining an incoming legacy batch at the prompt keeps the connection`() {
        val (rig, remote) = legacyFilesRig()
        promptIncoming(rig, remote, listOf(FileMeta("a.bin", 4)))
        rig.controller.rejectIncoming()
        awaitTrue("declined") { controlFrames(rig, RealtimeFrame.CTRL_REJECT) == 1 }
        Thread.sleep(40)
        // A sender still waiting for consent DOES stop on this byte, so the
        // exchange is complete and the connection is still good.
        assertEquals(TransferController.Phase.CONNECTED, rig.controller.state.value.phase)
        assertNull(rig.transport.closedReason)
    }

    @Test
    fun `a link file-lane failure still leaves the link and its text lane alive`() {
        // The same failure class on `link/1`, unchanged: the lane is terminal,
        // the connection is not.
        val rig = rig()
        connect(rig)
        rig.transport.events.onFileFrame(byteArrayOf(0x7f, 0, 0, 0, 0))
        awaitTrue("file lane down") { rig.controller.state.value.fileLaneDown }
        assertEquals(TransferController.Phase.CONNECTED, rig.controller.state.value.phase)
        assertNull(rig.transport.closedReason)
    }

    private fun blockedReadSource(reading: CountDownLatch, closed: CountDownLatch) =
        TransferController.OutgoingSource(FileMeta("blocked.bin", 8)) {
            object : InputStream() {
                override fun read(): Int = throw UnsupportedOperationException()
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    reading.countDown()
                    // Blocks until the descriptor is closed out from under it.
                    closed.await(10, TimeUnit.SECONDS)
                    throw java.io.IOException("closed")
                }
                override fun close() { closed.countDown() }
            }
        }
}
