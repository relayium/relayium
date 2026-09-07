package com.relayium.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `link` block of `realtime-wire-vectors.json`, consumed by the REAL
 * classifier and the real state machine.
 *
 * `docs/protocol/relayium-link-v1.md` section 6.1 says a routing answer for one
 * frame in isolation is not evidence about a receive path, so this suite does
 * both: it drives every classification row through [LinkProtocol.fileFrameClass]
 * — Kotlin's total classifier, not a composition written here — and then drives
 * the same rows through [FileLaneSession.onFrame], which is the demux the app
 * actually runs, across the consent gate.
 */
class LinkVectorTest {

    private val link = Fixtures.obj(Fixtures.wire, "link")

    private fun keys(): Crypto.SessionKeys {
        val a = Crypto.generateKeyPair()
        val b = Crypto.generateKeyPair()
        return Crypto.deriveSession(Crypto.Role.INITIATOR, a, b.publicKey)
    }

    // ── identity ────────────────────────────────────────────────────────────

    @Test
    fun `the capability, lane tuple and bounds are the committed ones`() {
        assertEquals(Fixtures.str(link, "capability"), LinkProtocol.CAPABILITY)
        assertEquals(
            Fixtures.arr(link, "channelLabels").map { Fixtures.string(it) },
            LinkProtocol.CHANNEL_LABELS,
        )
        assertEquals(Fixtures.num(link, "captureMaxBytes"), LinkProtocol.CAPTURE_MAX_BYTES.toLong())
        assertEquals(Fixtures.num(link, "authTagLength"), LinkProtocol.AUTH_TAG_LENGTH.toLong())
        assertEquals(Fixtures.num(link, "heldSignalMax"), LinkProtocol.HELD_SIGNAL_MAX.toLong())
        assertEquals(
            Fixtures.num(link, "maxCandidateProgress"),
            LinkProtocol.MAX_CANDIDATE_PROGRESS.toLong(),
        )
        assertEquals(Fixtures.num(link, "leave", "maxAttempts"), LinkProtocol.LEAVE_MAX_ATTEMPTS.toLong())
    }

    @Test
    fun `this client announces exactly link slash 1`() {
        // Not `text/1`: this client does not implement the retired single-lane
        // transport. Not `preupload/1`: kind 12 has its own derived key and an
        // unannounced kind is a hard error, so claiming it would kill transfers.
        assertEquals(listOf("link/1"), LinkProtocol.ADVERTISED_CAPS)
    }

    @Test
    fun `every announced capability has a handler and every handler is announced`() {
        // The truthful-capability rule, stated so it fails if either half drifts.
        val session = LinkSession("self")
        session.recordPeerCaps("peer", Json.obj("caps" to Json.arr(listOf(Json.of("link/1")))))
        assertTrue(session.peerSupportsLink("peer"))
        // Kind 12 is the only capability-gated frame, and it is classified
        // unroutable precisely because this client does not announce it.
        assertFalse(LinkProtocol.ADVERTISED_CAPS.contains("preupload/1"))
        assertEquals(
            LinkProtocol.FileFrameClass.Unroutable,
            LinkProtocol.fileFrameClass(RealtimeFrame.frame(RealtimeFrame.KIND_STORED_KEYS, 0, ByteArray(32))),
        )
    }

    @Test
    fun `the deadlines are the committed ones`() {
        val d = Fixtures.obj(link, "deadlines")
        assertEquals(Fixtures.num(d, "noProgressMs"), LinkProtocol.NO_PROGRESS_TIMEOUT_MS)
        assertEquals(Fixtures.num(d, "setupHardCapMs"), LinkProtocol.SETUP_HARD_CAP_MS)
        assertEquals(Fixtures.num(d, "keyRevealMs"), LinkProtocol.KEY_REVEAL_TIMEOUT_MS)
        assertEquals(Fixtures.num(d, "linkAuthMs"), LinkProtocol.LINK_AUTH_TIMEOUT_MS)
        assertEquals(Fixtures.num(d, "linkRequestMs"), LinkProtocol.LINK_REQUEST_TIMEOUT_MS)
        assertEquals(Fixtures.num(d, "linkRequestRetryMs"), LinkProtocol.LINK_REQUEST_RETRY_MS)
    }

    @Test
    fun `the flow and text-session bounds are the committed ones`() {
        assertEquals(Fixtures.num(link, "flow", "windowBytes"), RealtimeFrame.FLOW_WINDOW_BYTES)
        assertEquals(Fixtures.num(link, "flow", "ackIntervalBytes"), RealtimeFrame.FLOW_ACK_INTERVAL_BYTES)
        val t = Fixtures.obj(link, "textSession")
        assertEquals(Fixtures.num(t, "maxMessages"), TextSessionLimits.MAX_MESSAGES.toLong())
        assertEquals(Fixtures.num(t, "maxBytes"), TextSessionLimits.MAX_BYTES.toLong())
        assertEquals(Fixtures.num(t, "burst"), TextSessionLimits.BURST.toLong())
        assertEquals(Fixtures.num(t, "perSecond"), TextSessionLimits.PER_SECOND.toLong())
        assertEquals(Fixtures.num(t, "sendBufferMax"), TextSessionLimits.SEND_BUFFER_MAX.toLong())
        assertEquals(Fixtures.num(t, "idleMs"), TextSessionLimits.IDLE_MS)
        assertEquals(Fixtures.num(t, "historyMax"), TextSessionLimits.HISTORY_MAX.toLong())
    }

    // ── deterministic role ──────────────────────────────────────────────────

    @Test
    fun `the committed role table holds, in both orders`() {
        for (entry in Fixtures.arr(Fixtures.wire, "capability", "role")) {
            val o = entry as Json.Obj
            val self = Fixtures.string(o["self"])
            val peer = Fixtures.string(o["peer"])
            val expected = when (Fixtures.string(o["role"])) {
                "initiator" -> LinkProtocol.Role.INITIATOR
                else -> LinkProtocol.Role.RESPONDER
            }
            assertEquals("$self vs $peer", expected, LinkProtocol.linkRole(self, peer))
        }
    }

    @Test
    fun `the role is total and antisymmetric`() {
        for (entry in Fixtures.arr(Fixtures.wire, "capability", "role")) {
            val o = entry as Json.Obj
            val self = Fixtures.string(o["self"])
            val peer = Fixtures.string(o["peer"])
            assertNotEquals(LinkProtocol.linkRole(self, peer), LinkProtocol.linkRole(peer, self))
        }
        assertEquals(LinkProtocol.Role.RESPONDER, LinkProtocol.linkRole("same", "same"))
    }

    // ── the frame partition, through the real classifier AND the real demux ──

    @Test
    fun `every committed frame classifies exactly as the fixture says`() {
        for (row in Fixtures.arr(link, "frameClass")) {
            val o = row as Json.Obj
            val label = Fixtures.string(o["label"])
            val frame = Bytes.unhex(Fixtures.string(o["frameHex"]))
            val expected = Fixtures.string(o["class"])
            val actual = when (LinkProtocol.fileFrameClass(frame)) {
                is LinkProtocol.FileFrameClass.Lifecycle -> "lifecycle"
                is LinkProtocol.FileFrameClass.Ack -> "ack"
                is LinkProtocol.FileFrameClass.ResumeRequest -> "resumeRequest"
                is LinkProtocol.FileFrameClass.ResumeStart -> "resumeStart"
                is LinkProtocol.FileFrameClass.Protected -> "protected"
                is LinkProtocol.FileFrameClass.Unroutable -> "unroutable"
            }
            assertEquals(label, expected, actual)
            Fixtures.optionalString(o["control"])?.let { control ->
                val kind = (LinkProtocol.fileFrameClass(frame) as LinkProtocol.FileFrameClass.Lifecycle).control
                assertEquals(label, control, kind.name.lowercase().toCamel())
            }
        }
    }

    @Test
    fun `the committed rows cover every class`() {
        val seen = Fixtures.arr(link, "frameClass").map { Fixtures.string((it as Json.Obj)["class"]) }.toSet()
        assertEquals(
            setOf("ack", "lifecycle", "protected", "resumeRequest", "resumeStart", "unroutable"),
            seen,
        )
    }

    @Test
    fun `an unroutable frame fails the real receive path, never gets skipped`() {
        // The classifier's answer is not the point on its own — this drives the
        // demux the app runs. Skipping a frame the peer COUNTED would strand the
        // receive sequence for the rest of the link.
        for (row in Fixtures.arr(link, "frameClass")) {
            val o = row as Json.Obj
            if (Fixtures.string(o["class"]) != "unroutable") continue
            val session = FileLaneSession(keys(), RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
            val actions = session.onFrame(Bytes.unhex(Fixtures.string(o["frameHex"])))
            assertTrue(
                "${Fixtures.string(o["label"])} must fail the lane",
                actions.any {
                    it is FileLaneSession.Action.Fail &&
                        it.failure.reason == FileLaneSession.Failure.Reason.UNROUTABLE_FRAME
                },
            )
            assertEquals(FileLaneSession.SendState.FAILED, session.sendState)
        }
    }

    @Test
    fun `protected content before consent fails the real receive path`() {
        val session = FileLaneSession(keys(), RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        // A well-formed CHUNK arriving with no accepted batch. It must not even
        // be decrypted: the lane fails and abandons its nonce state with the
        // channel.
        val actions = session.onFrame(RealtimeFrame.frame(RealtimeFrame.KIND_CHUNK, 0, ByteArray(32)))
        assertTrue(
            actions.any {
                it is FileLaneSession.Action.Fail &&
                    it.failure.reason == FileLaneSession.Failure.Reason.CONTENT_BEFORE_CONSENT
            },
        )
    }

    @Test
    fun `a legacy frame is reported as an older peer, never parsed`() {
        val session = FileLaneSession(keys(), RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
        // Kind 3 is classified PROTECTED on purpose, so the receiver is the one
        // place that turns it into a loud version mismatch.
        val frame = RealtimeFrame.frame(RealtimeFrame.KIND_BATCH_LEGACY, 0, ByteArray(16))
        assertEquals(LinkProtocol.FileFrameClass.Protected, LinkProtocol.fileFrameClass(frame))
        val actions = session.onFrame(frame)
        assertTrue(
            actions.any {
                it is FileLaneSession.Action.Fail &&
                    it.failure.reason == FileLaneSession.Failure.Reason.LEGACY_PEER
            },
        )
    }

    @Test
    fun `a resume frame is refused truthfully and fails closed`() {
        for (kind in listOf(RealtimeFrame.KIND_RESUME_START, RealtimeFrame.KIND_RESUME_REQ)) {
            val session = FileLaneSession(keys(), RealtimeFrame.CONSERVATIVE_MAX_FRAME_BYTES)
            val actions = session.onFrame(RealtimeFrame.frame(kind, 0, "{}".toByteArray()))
            assertTrue(
                "kind $kind must fail closed as unsupported, not realign anything",
                actions.any {
                    it is FileLaneSession.Action.Fail &&
                        it.failure.reason == FileLaneSession.Failure.Reason.RESUME_UNSUPPORTED
                },
            )
            assertEquals(FileLaneSession.ReceiveState.FAILED, session.receiveState)
        }
    }

    // ── lifecycle bytes ─────────────────────────────────────────────────────

    @Test
    fun `the committed lifecycle rows hold on both lanes`() {
        for (row in Fixtures.arr(link, "lifecycle", "file")) {
            val o = row as Json.Obj
            val frame = Bytes.unhex(Fixtures.string(o["frameHex"]))
            val expected = Fixtures.optionalString(o["kind"])
            val actual = LinkProtocol.fileLifecycleKind(frame)?.name?.lowercase()?.toCamel()
            assertEquals(Fixtures.string(o["frameHex"]), expected, actual)
        }
        for (row in Fixtures.arr(link, "lifecycle", "text")) {
            val o = row as Json.Obj
            val frame = Bytes.unhex(Fixtures.string(o["frameHex"]))
            val expected = Fixtures.optionalString(o["kind"])
            val actual = TextWire.lifecycleKind(frame)?.name?.lowercase()
            assertEquals(Fixtures.string(o["frameHex"]), expected, actual)
        }
        for (row in Fixtures.arr(link, "lifecycle", "textFrame")) {
            val o = row as Json.Obj
            assertEquals(
                Fixtures.string(o["frameHex"]),
                Fixtures.bool(o["isTextFrame"]),
                TextWire.isTextFrame(Bytes.unhex(Fixtures.string(o["frameHex"]))),
            )
        }
    }

    @Test
    fun `the committed control bytes are the ones this module emits`() {
        val c = Fixtures.obj(link, "controlHex")
        assertEquals(Fixtures.string(c["accept"]), Bytes.hex(RealtimeFrame.ACCEPT))
        assertEquals(Fixtures.string(c["reject"]), Bytes.hex(RealtimeFrame.REJECT))
        assertEquals(Fixtures.string(c["complete"]), Bytes.hex(RealtimeFrame.COMPLETE))
        assertEquals(Fixtures.string(c["busy"]), Bytes.hex(RealtimeFrame.BUSY))
        assertEquals(Fixtures.string(c["batchAbort"]), Bytes.hex(RealtimeFrame.BATCH_ABORT))
        assertEquals(Fixtures.string(c["textRequest"]), Bytes.hex(TextWire.REQUEST))
        assertEquals(Fixtures.string(c["textEnd"]), Bytes.hex(TextWire.END))
    }

    // ── the MAC'd payloads ──────────────────────────────────────────────────

    @Test
    fun `authPayload renders the committed bytes for every committed signal`() {
        for (row in Fixtures.arr(link, "authPayload")) {
            val o = row as Json.Obj
            val label = Fixtures.string(o["label"])
            val signal = Signal.fromJson(o["signal"])!!
            val rendered = LinkProtocol.authPayload(signal)
            assertEquals(
                label,
                Fixtures.string(o["payloadUtf8Hex"]),
                Bytes.hex(rendered.toByteArray(Charsets.UTF_8)),
            )
            Fixtures.optionalString(o["payloadAscii"])?.let { assertEquals(label, it, rendered) }
            assertTrue("$label: the field list is fixed and ordered", rendered.startsWith("""{"sdpType":"""))
        }
    }

    @Test
    fun `linkLeavePayload renders the committed bytes, including the escaping cases`() {
        var sawSurrogate = false
        for (row in Fixtures.arr(link, "linkLeavePayload")) {
            val o = row as Json.Obj
            val label = Fixtures.string(o["label"])
            val from = Fixtures.fromUtf16(o["fromUtf16"])
            val to = Fixtures.fromUtf16(o["toUtf16"])
            if (Fixtures.optionalBool(o["swiftRepresentable"]) == false) sawSurrogate = true
            val rendered = LinkProtocol.linkLeavePayload(from, to)
            assertEquals(
                label,
                Fixtures.string(o["payloadUtf8Hex"]),
                Bytes.hex(rendered.toByteArray(Charsets.UTF_8)),
            )
            Fixtures.optionalString(o["payloadAscii"])?.let { assertEquals(label, it, rendered) }
        }
        assertTrue(
            "the unpaired-surrogate row must actually be exercised; Kotlin can hold one where Swift cannot",
            sawSurrogate,
        )
    }

    @Test
    fun `a leave payload is unreachable from an auth payload and reverses`() {
        assertTrue(LinkProtocol.linkLeavePayload("a", "b").startsWith("""{"kind":"link-leave""""))
        assertTrue(LinkProtocol.authPayload(Signal()).startsWith("""{"sdpType":"""))
        assertNotEquals(LinkProtocol.linkLeavePayload("a", "b"), LinkProtocol.linkLeavePayload("b", "a"))
    }

    @Test
    fun `caps and unknown fields are outside the auth payload`() {
        val signal = Signal(
            sdpType = "offer", sdp = "v=0\r\n",
            caps = listOf("link/1", "preupload/1"), commit = "Zm9v", link = true,
        )
        val rendered = LinkProtocol.authPayload(signal)
        for (absent in listOf("caps", "link/1", "preupload/1", "commit", "Zm9v")) {
            assertFalse("`$absent` must not be covered by a resume tag", rendered.contains(absent))
        }
    }

    @Test
    fun `sdpMLineIndex zero renders as zero and absent renders as null`() {
        assertTrue(
            LinkProtocol.authPayload(Signal(candidate = "c", sdpMLineIndex = 0))
                .contains(""""sdpMLineIndex":0"""),
        )
        assertTrue(
            LinkProtocol.authPayload(Signal(candidate = "c")).contains(""""sdpMLineIndex":null"""),
        )
    }

    // ── the authenticated leave ─────────────────────────────────────────────

    @Test
    fun `the committed leave tag reproduces and verifies in one direction only`() {
        val leave = Fixtures.obj(link, "leave")
        val raw = Bytes.unhex(Fixtures.string(leave["keyHex"]))
        val keys = Crypto.SessionKeys(
            sendKey = ByteArray(32), recvKey = ByteArray(32),
            resumeAuthKey = raw, textSendKey = ByteArray(32), textRecvKey = ByteArray(32),
        )
        val from = Fixtures.string(leave["from"])
        val to = Fixtures.string(leave["to"])
        val payload = LinkProtocol.linkLeavePayload(from, to)
        assertEquals(Fixtures.string(leave["payload"]), payload)
        assertEquals(Fixtures.string(leave["tag"]), Crypto.signAuth(keys, payload))
        assertEquals(Fixtures.number(leave["tagLength"]), LinkProtocol.AUTH_TAG_LENGTH.toLong())
        assertTrue(Crypto.verifyAuth(keys, payload, Fixtures.string(leave["tag"])))
        // A relay reflecting the leave back at its sender presents the reversed
        // tuple, and that must not verify.
        assertFalse(Crypto.verifyAuth(keys, payload, Fixtures.string(leave["reversedTag"])))
        assertFalse(
            Crypto.verifyAuth(keys, LinkProtocol.linkLeavePayload(to, from), Fixtures.string(leave["tag"])),
        )
    }

    @Test
    fun `the committed leave shapes are accepted or refused exactly`() {
        for (row in Fixtures.arr(link, "leave", "shapes")) {
            val o = row as Json.Obj
            val label = Fixtures.string(o["label"])
            val accepted = LinkProtocol.parseLeaveAuth(o["signal"]) != null
            assertEquals(label, Fixtures.bool(o["accepted"]), accepted)
        }
    }

    @Test
    fun `a non-object leave is refused without a throw`() {
        assertNull(LinkProtocol.parseLeaveAuth(null))
        assertNull(LinkProtocol.parseLeaveAuth(Json.Null))
        assertNull(LinkProtocol.parseLeaveAuth(Json.of("leave")))
        assertNull(LinkProtocol.parseLeaveAuth(Json.arr(listOf(Json.of("x")))))
    }

    @Test
    fun `the leave budget is spent by shape and bounded per authenticated link`() {
        val session = LinkSession("self")
        val keys = keys()
        val forged = Json.obj(
            "link" to Json.of(true), "leave" to Json.of(true), "auth" to Json.of("!".repeat(44)),
        )
        repeat(LinkProtocol.LEAVE_MAX_ATTEMPTS) {
            assertFalse(session.acceptLeave("peer", forged, keys))
        }
        assertEquals(LinkProtocol.LEAVE_MAX_ATTEMPTS, session.leaveAttemptsSpent)
        // Past the budget, no further HMAC is spent — even for a GENUINE tag.
        val genuine = Json.obj(
            "link" to Json.of(true), "leave" to Json.of(true),
            "auth" to Json.of(Crypto.signAuth(keys, LinkProtocol.linkLeavePayload("peer", "self"))),
        )
        assertFalse("the budget is a hard ceiling", session.acceptLeave("peer", genuine, keys))
        assertEquals(LinkProtocol.LEAVE_MAX_ATTEMPTS, session.leaveAttemptsSpent)
        // A malformed SHAPE never spends budget at all.
        val fresh = LinkSession("self")
        repeat(100) { fresh.acceptLeave("peer", Json.obj("link" to Json.of(true)), keys) }
        assertEquals(0, fresh.leaveAttemptsSpent)
    }

    @Test
    fun `a genuine leave verifies in the right direction`() {
        val session = LinkSession("self")
        val keys = keys()
        val tag = Crypto.signAuth(keys, LinkProtocol.linkLeavePayload("peer", "self"))
        assertTrue(
            session.acceptLeave(
                "peer",
                Json.obj("link" to Json.of(true), "leave" to Json.of(true), "auth" to Json.of(tag)),
                keys,
            ),
        )
    }

    // ── signalling ──────────────────────────────────────────────────────────

    @Test
    fun `the committed generation table holds`() {
        for (row in Fixtures.arr(link, "signals", "generation")) {
            val o = row as Json.Obj
            val signal = Signal.fromJson(o["signal"])!!
            assertEquals(
                Json.stringify(o["signal"]!!),
                Fixtures.string(o["generation"]).uppercase(),
                signal.generation.name,
            )
        }
    }

    @Test
    fun `the committed offer and request recognisers hold`() {
        for (row in Fixtures.arr(link, "signals", "isLinkOffer")) {
            val o = row as Json.Obj
            assertEquals(
                Json.stringify(o["signal"]!!),
                Fixtures.bool(o["expected"]),
                Signal.fromJson(o["signal"])!!.isLinkOffer,
            )
        }
        for (row in Fixtures.arr(link, "signals", "isLinkRequest")) {
            val o = row as Json.Obj
            assertEquals(
                Json.stringify(o["signal"]!!),
                Fixtures.bool(o["expected"]),
                Signal.fromJson(o["signal"])!!.isLinkRequest,
            )
        }
    }

    @Test
    fun `the three content-free frames round-trip`() {
        assertEquals(Fixtures.obj(link, "signals", "request"), Signal.linkRequest().toJson())
        assertEquals(Fixtures.obj(link, "signals", "busy"), Signal.busy().toJson())
        val leaveTag = Fixtures.str(link, "leave", "tag")
        assertEquals(Fixtures.obj(link, "signals", "leave"), Signal.leave(leaveTag).toJson())
        assertTrue(LinkProtocol.parseLeaveAuth(Signal.leave(leaveTag).toJson()) == leaveTag)
    }

    // ── bounds ──────────────────────────────────────────────────────────────

    @Test
    fun `the committed bound tables hold`() {
        for (row in Fixtures.arr(link, "bounds", "piecePlainBytes")) {
            val o = row as Json.Obj
            val max = Fixtures.number(o["maxFrameBytes"]).toInt()
            val expected = o["pieceBytes"]
            if (expected is Json.Null) {
                assertTrue(
                    "piecePlainBytes($max) must be refused",
                    runCatching { RealtimeFrame.piecePlainBytes(max) }.isFailure,
                )
            } else {
                assertEquals("piecePlainBytes($max)", Fixtures.number(expected), RealtimeFrame.piecePlainBytes(max).toLong())
            }
        }
        for (row in Fixtures.arr(link, "bounds", "textPlainLimit")) {
            val o = row as Json.Obj
            val max = Fixtures.number(o["maxFrameBytes"]).toInt()
            assertEquals("textPlainLimit($max)", Fixtures.number(o["limit"]), TextWire.plainLimit(max).toLong())
        }
        for (row in Fixtures.arr(link, "bounds", "advanceAck")) {
            val o = row as Json.Obj
            assertEquals(
                Fixtures.number(o["result"]),
                RealtimeFrame.advanceAck(
                    Fixtures.number(o["acked"]), Fixtures.number(o["sent"]), Fixtures.number(o["candidate"]),
                ),
            )
        }
        for (row in Fixtures.arr(link, "bounds", "resumePoint")) {
            val o = row as Json.Obj
            val sizes = (o["sizes"] as Json.Arr).items.map { Fixtures.number(it) }
            val p = o["point"] as Json.Obj
            val point = RealtimeFrame.ResumePoint(
                Fixtures.number(p["index"]).toInt(), Fixtures.number(p["offset"]),
            )
            assertEquals("aligned $point", Fixtures.bool(o["aligned"]), RealtimeFrame.resumePointAligned(point, sizes))
            assertEquals("inRange $point", Fixtures.bool(o["inRange"]), RealtimeFrame.resumePointInRange(point, sizes))
        }
    }

    @Test
    fun `the committed manifest bounds hold against the real validator`() {
        for (row in Fixtures.arr(link, "bounds", "manifestFileCount")) {
            val o = row as Json.Obj
            val count = Fixtures.number(o["count"]).toInt()
            val files = (0 until count).map { FileMeta("f$it", 0) }
            val ok = runCatching { ManifestCodec.decode(ManifestCodec.encode(files)) }.isSuccess
            // An empty list cannot even be encoded into a manifest shape the
            // decoder accepts, which is the same refusal from the other side.
            assertEquals("count=$count", Fixtures.bool(o["accepted"]), ok)
        }
        for (row in Fixtures.arr(link, "bounds", "manifestNameBytes")) {
            val o = row as Json.Obj
            val n = Fixtures.number(o["nameBytes"]).toInt()
            val files = listOf(FileMeta("a".repeat(n), 0))
            val ok = runCatching { ManifestCodec.decode(ManifestCodec.encode(files)) }.isSuccess
            assertEquals("nameBytes=$n", Fixtures.bool(o["accepted"]), ok)
        }
        for (row in Fixtures.arr(link, "bounds", "manifestCiphertext")) {
            val o = row as Json.Obj
            val target = Fixtures.number(o["payloadBytes"]).toInt()
            val base = ManifestCodec.encode(listOf(FileMeta("", 0))).size
            val files = listOf(FileMeta("a".repeat(target - base), 0))
            assertEquals("the crafted manifest must be exactly $target bytes", target, ManifestCodec.encode(files).size)
            val ok = runCatching {
                RealtimeSender().batchFrames(files, keys(), RealtimeFrame.CHUNK_SIZE + RealtimeFrame.OVERHEAD)
            }.isSuccess
            assertEquals("payloadBytes=$target", Fixtures.bool(o["accepted"]), ok)
        }
    }

    /** `BATCH_ABORT` -> `batchAbort`, so an enum name matches the fixture's. */
    private fun String.toCamel(): String =
        split('_').mapIndexed { i, part -> if (i == 0) part else part.replaceFirstChar(Char::uppercase) }
            .joinToString("")
}
