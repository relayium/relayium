package com.relayium.protocol.legacy

import com.relayium.protocol.Bytes
import com.relayium.protocol.Crypto
import com.relayium.protocol.FileLaneSession
import com.relayium.protocol.FileMeta
import com.relayium.protocol.Fixtures
import com.relayium.protocol.Json
import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.LinkSession
import com.relayium.protocol.RealtimeFrame
import com.relayium.protocol.RealtimeSender
import com.relayium.protocol.Signal
import com.relayium.protocol.TextLaneSession
import com.relayium.protocol.TextWire
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The SHIPPED pre-`link/1` wire, against the top-level blocks of
 * `realtime-wire-vectors.json` — which are the legacy ones. The `link` block is
 * the newer wire and is asserted by `LinkVectorTest`.
 *
 * Every table here is READ from the fixture rather than restated, so a
 * disagreement with the Apple and Web clients fails as a mismatch instead of
 * being encoded twice and drifting.
 */
class LegacyVectorTest {

    private val v = Fixtures.wire

    private fun keys(hexKey: String): Crypto.SessionKeys {
        val raw = Bytes.unhex(hexKey)
        return Crypto.SessionKeys(
            sendKey = raw.copyOf(), recvKey = raw.copyOf(), resumeAuthKey = ByteArray(32),
            textSendKey = raw.copyOf(), textRecvKey = raw.copyOf(),
        )
    }

    // ── the control set ─────────────────────────────────────────────────────

    @Test
    fun `the legacy control set is exactly the three fixture bytes`() {
        val controls = Fixtures.obj(v, "controlHex")
        assertEquals(setOf("accept", "reject", "complete"), controls.keys)
        val byName = mapOf(
            "accept" to LegacyProtocol.Control.ACCEPT,
            "reject" to LegacyProtocol.Control.REJECT,
            "complete" to LegacyProtocol.Control.COMPLETE,
        )
        for ((name, control) in byName) {
            val frame = Bytes.unhex(Fixtures.string(controls[name]))
            assertEquals("one byte", 1, frame.size)
            assertEquals(name, control, LegacyProtocol.control(frame))
        }
    }

    @Test
    fun `the link-only control bytes are not legacy controls`() {
        // `RealtimeControl(rawValue:)` on the Apple side has three cases, so a
        // peer receiving one of these would feed it to its AEAD receiver and
        // fail the whole connection. Recognising them here would be a dialect.
        for (byte in listOf(RealtimeFrame.CTRL_BUSY, RealtimeFrame.CTRL_BATCH_ABORT)) {
            assertNull(LegacyProtocol.control(byteArrayOf(byte.toByte())))
        }
    }

    @Test
    fun `a longer frame beginning with a control byte is not consent`() {
        val two = byteArrayOf(RealtimeFrame.CTRL_ACCEPT.toByte(), 0)
        assertNull(LegacyProtocol.control(two))
        assertNull(LegacyProtocol.control(ByteArray(0)))
    }

    // ── capability promotion ────────────────────────────────────────────────

    @Test
    fun `every promotion row resolves the way the fixture says`() {
        for (entry in Fixtures.arr(v, "capability", "promotion")) {
            val row = entry as Json.Obj
            val caps = (row["caps"] as Json.Arr).items.map { Fixtures.string(it) }
            val session = LinkSession("aaaaaaaa")
            session.recordPeerCaps("peer", Json.obj("caps" to Json.arr(caps.map(Json::of))))

            val link = Fixtures.bool(row["link"])
            assertEquals("link for $caps", link, session.peerSupportsLink("peer"))

            // "Resolves immediately" is a POSITIVE statement about the peer:
            // exactly the two capabilities this client can act on the instant it
            // hears them. Everything else is indistinguishable from a peer that
            // has not spoken yet, and must wait out the settle window.
            val immediate = Fixtures.bool(row["resolvesImmediately"])
            assertEquals(
                "resolvesImmediately for $caps",
                immediate,
                session.peerSupportsLink("peer") || session.peerSupportsText("peer"),
            )

            val expectedLane = Fixtures.optionalString(row["legacyLane"])
            if (expectedLane != null) {
                assertFalse("a legacy row cannot also be a link", link)
                val lane = LegacyLane.mode(
                    peerAnnouncesText = session.peerSupportsText("peer"),
                    hasArmedBatch = false,
                )
                assertEquals("legacyLane for $caps", expectedLane, lane.name.lowercase())
            }
        }
    }

    @Test
    fun `the legacy lane table is the shared rule`() {
        for (entry in Fixtures.arr(v, "capability", "legacyLane")) {
            val row = entry as Json.Obj
            val text = Fixtures.bool(row["peerAnnouncesText"])
            val armed = Fixtures.bool(row["hasArmedBatch"])
            assertEquals(
                "peerAnnouncesText=$text hasArmedBatch=$armed",
                Fixtures.string(row["lane"]),
                LegacyLane.mode(text, armed).name.lowercase(),
            )
        }
    }

    @Test
    fun `a revoking snapshot withdraws both wires`() {
        val revocation = Fixtures.obj(v, "capability", "revocation")
        val session = LinkSession("aaaaaaaa")
        for (stage in listOf("first", "then")) {
            val caps = Fixtures.arr(revocation, stage, "caps").map { Fixtures.string(it) }
            session.recordPeerCaps("peer", Json.obj("caps" to Json.arr(caps.map(Json::of))))
        }
        assertEquals(Fixtures.bool(revocation["link"]), session.peerSupportsLink("peer"))
        assertEquals(Fixtures.bool(revocation["text"]), session.peerSupportsText("peer"))
    }

    // ── signal shapes ───────────────────────────────────────────────────────

    private fun roundTrip(signal: Signal): Signal =
        Signal.fromJson(Json.parse(Json.stringify(signal.toJson())))!!

    @Test
    fun `a file offer is byte-identical to what an untagged peer sends`() {
        val json = Json.stringify(LegacyProtocol.offer("v=0\r\n", "Y29tbWl0", LegacyProtocol.Lane.FILES).toJson())
        // No `caps`, no `link`, no `text`: `Mode.file.localCapabilities` is
        // empty and `addingCaps` adds no field at all, which is what keeps this
        // readable by every already-deployed peer.
        assertEquals("""{"sdp":{"type":"offer","sdp":"v=0\r\n"},"commit":"Y29tbWl0"}""", json)
        assertEquals(Signal.Generation.FILE, roundTrip(LegacyProtocol.offer("v=0\r\n", "Y29tbWl0", LegacyProtocol.Lane.FILES)).generation)
    }

    @Test
    fun `a text offer and answer both carry exact text slash 1`() {
        // `RealtimeConnection.handleSignal` re-checks the capability on EVERY
        // SDP until the peer key is delivered, so an answer without it fails an
        // initiator that had already offered.
        for (signal in listOf(
            LegacyProtocol.offer("v=0\r\n", "Y29tbWl0", LegacyProtocol.Lane.TEXT),
            LegacyProtocol.answer("v=0\r\n", "Y29tbWl0", LegacyProtocol.Lane.TEXT),
        )) {
            val parsed = roundTrip(signal)
            assertEquals(Signal.Generation.TEXT, parsed.generation)
            assertEquals(listOf(LegacyProtocol.TEXT_CAPABILITY), parsed.caps)
            assertTrue(parsed.text)
        }
    }

    @Test
    fun `candidates and reveals carry the generation tag and no capabilities`() {
        val candidate = roundTrip(LegacyProtocol.candidate("cand", "0", 0, LegacyProtocol.Lane.TEXT))
        assertEquals(Signal.Generation.TEXT, candidate.generation)
        assertNull(candidate.caps)
        val reveal = roundTrip(LegacyProtocol.reveal("a", "b", LegacyProtocol.Lane.FILES))
        assertEquals(Signal.Generation.FILE, reveal.generation)
        assertNull(reveal.caps)
        assertEquals("a", reveal.revealKey)
    }

    // ── inbound offer routing ───────────────────────────────────────────────

    @Test
    fun `only a real offer of a shipped generation opens a responder session`() {
        val commit = "Y29tbWl0"
        assertEquals(
            LegacyProtocol.Lane.FILES,
            LegacyProtocol.inboundOfferLane(LegacyProtocol.offer("v=0", commit, LegacyProtocol.Lane.FILES)),
        )
        assertEquals(
            LegacyProtocol.Lane.TEXT,
            LegacyProtocol.inboundOfferLane(LegacyProtocol.offer("v=0", commit, LegacyProtocol.Lane.TEXT)),
        )
        // A text offer without the exact capability fails CLOSED. Silence is
        // the truthful answer to a dialect this side cannot speak.
        assertNull(
            LegacyProtocol.inboundOfferLane(
                Signal(sdpType = "offer", sdp = "v=0", commit = commit, text = true),
            ),
        )
        assertNull(
            LegacyProtocol.inboundOfferLane(
                Signal(sdpType = "offer", sdp = "v=0", commit = commit, text = true, caps = listOf("text/2")),
            ),
        )
        // An answer, a link offer, a resume offer and a bare candidate are each
        // something other than a new session.
        assertNull(LegacyProtocol.inboundOfferLane(LegacyProtocol.answer("v=0", commit, LegacyProtocol.Lane.FILES)))
        assertNull(LegacyProtocol.inboundOfferLane(Signal.offer("v=0", commit, listOf("link/1"))))
        assertNull(
            LegacyProtocol.inboundOfferLane(Signal(sdpType = "offer", sdp = "v=0", resume = true)),
        )
        assertNull(LegacyProtocol.inboundOfferLane(Signal(candidate = "cand")))
    }

    // ── the wire profile ────────────────────────────────────────────────────

    @Test
    fun `a profile answers only its own generation`() {
        val link = WireProfile.Link(LinkProtocol.Role.INITIATOR)
        val files = WireProfile.Legacy(LinkProtocol.Role.INITIATOR, LegacyProtocol.Lane.FILES)
        val text = WireProfile.Legacy(LinkProtocol.Role.RESPONDER, LegacyProtocol.Lane.TEXT)
        assertEquals(Signal.Generation.LINK, link.generation)
        assertEquals(Signal.Generation.FILE, files.generation)
        assertEquals(Signal.Generation.TEXT, text.generation)

        // A `link`-tagged busy must be INERT on a legacy connection: accepting
        // it closes a live session, and the relay chooses every tag it sees.
        val linkBusy = Signal.busy()
        assertTrue(link.accepts(linkBusy))
        assertFalse(files.accepts(linkBusy))
        assertFalse(text.accepts(linkBusy))
        // And the reverse: an untagged frame is not a link frame.
        val untaggedCommit = Signal(commit = "Y29tbWl0")
        assertFalse(link.accepts(untaggedCommit))
        assertTrue(files.accepts(untaggedCommit))
        assertFalse(text.accepts(untaggedCommit))
    }

    @Test
    fun `a legacy initiator never answers an offer and a responder never applies an answer`() {
        val initiator = WireProfile.Legacy(LinkProtocol.Role.INITIATOR, LegacyProtocol.Lane.FILES)
        val responder = WireProfile.Legacy(LinkProtocol.Role.RESPONDER, LegacyProtocol.Lane.FILES)
        assertTrue(initiator.acceptsSdp("answer"))
        assertFalse(initiator.acceptsSdp("offer"))
        assertTrue(responder.acceptsSdp("offer"))
        assertFalse(responder.acceptsSdp("answer"))
        // `link/1` has the sorted-id tiebreak and is unchanged.
        val link = WireProfile.Link(LinkProtocol.Role.INITIATOR)
        assertTrue(link.acceptsSdp("offer"))
        assertTrue(link.acceptsSdp("answer"))
    }

    @Test
    fun `a legacy wire has one channel and exactly one lane on it`() {
        val files = WireProfile.Legacy(LinkProtocol.Role.INITIATOR, LegacyProtocol.Lane.FILES)
        val text = WireProfile.Legacy(LinkProtocol.Role.INITIATOR, LegacyProtocol.Lane.TEXT)
        assertEquals(listOf("data"), files.channels)
        assertEquals(listOf("data"), text.channels)
        assertEquals("data", files.fileChannel)
        assertNull(files.textChannel)
        assertNull(text.fileChannel)
        assertEquals("data", text.textChannel)
        // Unchanged: the link tuple, in primary-first order.
        val link = WireProfile.Link(LinkProtocol.Role.RESPONDER)
        assertEquals(LinkProtocol.CHANNEL_LABELS, link.channels)
    }

    // ── the file lane without a barrier ─────────────────────────────────────

    private fun legacyFileLane(k: Crypto.SessionKeys) =
        FileLaneSession(k, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, barrier = false)

    private fun sends(actions: List<FileLaneSession.Action>) =
        actions.filterIsInstance<FileLaneSession.Action.Send>().map { it.frame }

    @Test
    fun `a legacy cancel emits no barrier the peer could not read`() {
        val k = keys(Fixtures.str(v, "sessionKeyHex"))
        val lane = legacyFileLane(k)
        lane.startBatch(listOf(FileMeta(name = "a.bin", size = 4)))
        lane.onFrame(RealtimeFrame.ACCEPT)
        val actions = lane.cancelOutgoing()
        assertEquals("no frame at all goes out", emptyList<ByteArray>(), sends(actions))
        assertTrue(actions.any { it is FileLaneSession.Action.Fail })
        assertEquals(FileLaneSession.SendState.IDLE, lane.sendState)

        // `link/1` still emits it, unchanged.
        val linkLane = FileLaneSession(keys(Fixtures.str(v, "sessionKeyHex")), RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        linkLane.startBatch(listOf(FileMeta(name = "a.bin", size = 4)))
        linkLane.onFrame(RealtimeFrame.ACCEPT)
        assertEquals(
            listOf(RealtimeFrame.CTRL_BATCH_ABORT),
            sends(linkLane.cancelOutgoing()).map { it[0].toInt() and 0xff },
        )
    }

    @Test
    fun `a legacy peer rejection ends the batch without a barrier`() {
        val k = keys(Fixtures.str(v, "sessionKeyHex"))
        val lane = legacyFileLane(k)
        lane.startBatch(listOf(FileMeta(name = "a.bin", size = 4)))
        val actions = lane.onFrame(RealtimeFrame.REJECT)
        assertEquals(emptyList<ByteArray>(), sends(actions))
        assertEquals(
            FileLaneSession.Failure(
                FileLaneSession.Failure.Reason.PEER_REJECTED,
                FileLaneSession.Failure.Scope.SEND,
            ),
            (actions.single { it is FileLaneSession.Action.Fail } as FileLaneSession.Action.Fail).failure,
        )
    }

    @Test
    fun `a legacy receiver cancel retires the batch instead of draining`() {
        val k = keys(Fixtures.str(v, "sessionKeyHex"))
        val lane = legacyFileLane(k)
        lane.attachReceiver()
        val peer = RealtimeSender()
        val files = listOf(FileMeta(name = "a.bin", size = 4))
        for (frame in peer.batchFrames(files, k, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) lane.onFrame(frame)
        lane.acceptIncoming().let { assertEquals(1, sends(it).size) }
        val actions = lane.cancelIncoming()
        // The REJECT still goes out — a sender still waiting for consent DOES
        // stop on it — but there is no drain, because the shipped sender never
        // answers with a barrier this side could wait for.
        assertEquals(listOf(RealtimeFrame.CTRL_REJECT), sends(actions).map { it[0].toInt() and 0xff })
        assertEquals(FileLaneSession.ReceiveState.IDLE, lane.receiveState)

        val linkLane = FileLaneSession(keys(Fixtures.str(v, "sessionKeyHex")), RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        linkLane.attachReceiver()
        val linkPeer = RealtimeSender()
        for (frame in linkPeer.batchFrames(files, k, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)) linkLane.onFrame(frame)
        linkLane.acceptIncoming()
        linkLane.cancelIncoming()
        assertEquals(FileLaneSession.ReceiveState.DRAINING, linkLane.receiveState)
    }

    @Test
    fun `a link-only control byte fails a legacy lane closed`() {
        val k = keys(Fixtures.str(v, "sessionKeyHex"))
        for (byte in listOf(RealtimeFrame.CTRL_BUSY, RealtimeFrame.CTRL_BATCH_ABORT)) {
            val lane = legacyFileLane(k)
            val actions = lane.onFrame(byteArrayOf(byte.toByte()))
            val fail = actions.single { it is FileLaneSession.Action.Fail } as FileLaneSession.Action.Fail
            assertEquals(FileLaneSession.Failure.Reason.UNROUTABLE_FRAME, fail.failure.reason)
            assertEquals(FileLaneSession.Failure.Scope.LANE, fail.failure.scope)
        }
    }

    @Test
    fun `the shared control bytes still work on a legacy lane`() {
        val k = keys(Fixtures.str(v, "sessionKeyHex"))
        val lane = legacyFileLane(k)
        lane.startBatch(listOf(FileMeta(name = "a.bin", size = 4)))
        lane.onFrame(RealtimeFrame.ACCEPT)
        assertEquals(FileLaneSession.SendState.SENDING, lane.sendState)
        lane.sendChunk(ByteArray(4))
        lane.sendDone(Crypto.chainStart())
        lane.finishSending()
        assertTrue(lane.onFrame(RealtimeFrame.COMPLETE).any { it is FileLaneSession.Action.SendComplete })
    }

    // ── the message lane's codec is the SAME codec ──────────────────────────

    @Test
    fun `the legacy message lane reproduces the committed frames byte for byte`() {
        // The lifecycle differs from `link/1`; the CODEC does not. Same kind,
        // same derived key, same per-direction counter from 0 — so the frozen
        // frames must come out of this lane unchanged.
        val textKeyRaw = Bytes.unhex(Fixtures.str(v, "text", "keyHex"))
        val k = Crypto.SessionKeys(
            sendKey = ByteArray(32), recvKey = ByteArray(32), resumeAuthKey = ByteArray(32),
            textSendKey = textKeyRaw.copyOf(), textRecvKey = textKeyRaw.copyOf(),
        )
        val lane = LegacyTextLane(k, RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES, LinkProtocol.Role.RESPONDER)
        lane.attachReceiver()
        lane.accept()
        val frames = Fixtures.arr(v, "text", "frames").map { it as Json.Obj }
        frames.forEachIndexed { i, entry ->
            val body = Fixtures.string(entry["body"])
            val expected = Fixtures.string(entry["frameHex"])
            val sent = lane.send(body).filterIsInstance<TextLaneSession.Action.Send>().single()
            assertEquals("frame $i must reproduce byte for byte", expected, Bytes.hex(sent.frame))
            // And the same bytes open back, on the receive counter.
            val received = lane.onFrame(Bytes.unhex(expected))
            assertEquals(
                listOf(TextLaneSession.Action.Received(body)),
                received,
            )
        }
        assertEquals(frames.size.toLong(), lane.sendSeq)
        assertEquals(frames.size.toLong(), lane.recvSeq)
        assertEquals(TextWire.KIND.toLong(), Fixtures.num(v, "text", "kind"))
    }
}
