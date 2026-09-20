package com.relayium.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * This port against the FROZEN `relay-renew/1` vectors.
 *
 * Every value asserted here is read from
 * `apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json`, which is
 * generated from the reference implementation and is read-only to this module.
 * Nothing is retyped: a constant repeated in Kotlin and in the fixture is two
 * things to keep in sync, which is the exact drift the shared file exists to
 * prevent.
 *
 * Three properties are worth naming, because they are what a port most easily
 * gets wrong and a green board would otherwise hide:
 *
 *  - the SIGNED bytes, not the parsed values. Key order, integer rendering and
 *    `JSON.stringify` escaping are the contract, so every payload is asserted
 *    as a string AND as its UTF-8 bytes, including the peer id carrying U+007F,
 *    the C1 range, U+2028, U+2029 and an astral character.
 *  - the REFUSALS. A parser that accepts everything the fixture accepts is only
 *    half conforming; the reject table is where a lenient read becomes an
 *    unauthenticated renegotiation against a live PeerConnection.
 *  - the exact 59-byte frame, byte for byte, in both directions.
 */
class RelayRenewVectorTest {

    private val vectors = Fixtures.relayRenew

    private val from = Fixtures.str(vectors, "peers", "from")
    private val to = Fixtures.str(vectors, "peers", "to")

    private val keys: Crypto.SessionKeys = Crypto.SessionKeys(
        sendKey = ByteArray(32),
        recvKey = ByteArray(32),
        resumeAuthKey = Bytes.unhex(Fixtures.str(vectors, "resumeAuthKeyHex")),
        textSendKey = ByteArray(32),
        textRecvKey = ByteArray(32),
    )

    // ── constants ───────────────────────────────────────────────────────────

    @Test
    fun `constants match the frozen wire`() {
        val c = Fixtures.obj(vectors, "constants")
        assertEquals(Fixtures.str(vectors, "capability"), RelayRenewWire.CAPABILITY)
        assertEquals(Fixtures.num(c, "probeKind"), RelayRenewProbe.KIND.toLong())
        assertEquals(Fixtures.num(c, "probeVersion"), RelayRenewProbe.VERSION.toLong())
        assertEquals(Fixtures.num(c, "probeTypeProbe"), RelayRenewProbe.TYPE_PROBE.toLong())
        assertEquals(Fixtures.num(c, "probeTypeAck"), RelayRenewProbe.TYPE_ACK.toLong())
        assertEquals(Fixtures.num(c, "probeFrameBytes"), RelayRenewProbe.FRAME_BYTES.toLong())
        assertEquals(Fixtures.num(c, "nonceBytes"), RelayRenewProbe.NONCE_BYTES.toLong())
        assertEquals(Fixtures.num(c, "tagBytes"), RelayRenewProbe.TAG_BYTES.toLong())
        assertEquals(Fixtures.num(c, "authLength"), RelayRenewWire.AUTH_LENGTH.toLong())
        assertEquals(Fixtures.num(c, "maxEpochsPerRound"), RelayRenewWire.MAX_EPOCHS_PER_ROUND.toLong())
        assertEquals(
            Fixtures.num(c, "maxProbeVerifications"),
            RelayRenewWire.MAX_PROBE_VERIFICATIONS.toLong(),
        )
        assertEquals(Fixtures.num(c, "maxHeldCandidates"), RelayRenewWire.MAX_HELD_CANDIDATES.toLong())
        assertEquals(Fixtures.num(c, "probeRetryMs"), RelayRenewWire.PROBE_RETRY_MS)
        assertEquals(Fixtures.num(c, "probeMaxSends"), RelayRenewWire.PROBE_MAX_SENDS.toLong())
        assertEquals(Fixtures.num(c, "prepareToReadyMs"), RelayRenewWire.PREPARE_TO_READY_MS)
        assertEquals(Fixtures.num(c, "readyToAnswerMs"), RelayRenewWire.READY_TO_ANSWER_MS)
        assertEquals(Fixtures.num(c, "iceProbeMs"), RelayRenewWire.ICE_PROBE_MS)
        assertEquals(Fixtures.num(c, "epochHardCapMs"), RelayRenewWire.EPOCH_HARD_CAP_MS)
        assertEquals(Fixtures.num(c, "prepareSilenceMs"), RelayRenewWire.PREPARE_SILENCE_MS)
    }

    // ── the signed payloads ─────────────────────────────────────────────────

    /** The signed bytes, the UTF-8 encoding of those bytes, and the tag. */
    private fun assertPayload(entry: Json.Obj, message: RelayRenewWire.Message) {
        val case = Fixtures.str(entry, "case")
        val expected = Fixtures.str(entry, "payload")
        val f = Fixtures.str(entry, "from")
        val t = Fixtures.str(entry, "to")
        val rendered = RelayRenewWire.payload(f, t, message)
        assertEquals(expected, rendered, case)
        assertEquals(
            Fixtures.str(entry, "payloadUtf8Hex"),
            Bytes.hex(rendered.toByteArray(Charsets.UTF_8)),
            "$case: utf-8 bytes",
        )
        assertEquals(Fixtures.str(entry, "tag"), Crypto.signAuth(keys, rendered), "$case: tag")
        assertTrue(Crypto.verifyAuth(keys, rendered, Fixtures.str(entry, "tag")), "$case: verify")
    }

    @Test
    fun `prepare payloads`() {
        for (item in Fixtures.arr(vectors, "payloads", "prepare")) {
            val entry = item as Json.Obj
            assertPayload(entry, RelayRenewWire.Message.Prepare(Fixtures.num(entry, "epoch")))
        }
    }

    @Test
    fun `ready payloads`() {
        for (item in Fixtures.arr(vectors, "payloads", "ready")) {
            val entry = item as Json.Obj
            assertPayload(
                entry,
                RelayRenewWire.Message.Ready(
                    Fixtures.num(entry, "epoch"),
                    Fixtures.num(entry, "round"),
                ),
            )
        }
    }

    @Test
    fun `sdp payloads`() {
        for (item in Fixtures.arr(vectors, "payloads", "sdp")) {
            val entry = item as Json.Obj
            assertPayload(
                entry,
                RelayRenewWire.Message.Sdp(
                    epoch = Fixtures.num(entry, "epoch"),
                    round = Fixtures.num(entry, "round"),
                    sdpType = Fixtures.str(entry, "sdpType"),
                    sdp = Fixtures.str(entry, "sdp"),
                ),
            )
        }
    }

    @Test
    fun `ice payloads, including the explicit nulls`() {
        var sawNull = false
        for (item in Fixtures.arr(vectors, "payloads", "ice")) {
            val entry = item as Json.Obj
            val mid = Fixtures.optionalString(entry["sdpMid"])
            val index = (entry["sdpMLineIndex"] as? Json.Num)?.value?.toLong()
            if (mid == null && index == null) sawNull = true
            assertPayload(
                entry,
                RelayRenewWire.Message.Ice(
                    epoch = Fixtures.num(entry, "epoch"),
                    round = Fixtures.num(entry, "round"),
                    candidate = Fixtures.str(entry, "candidate"),
                    sdpMid = mid,
                    sdpMLineIndex = index,
                    usernameFragment = Fixtures.str(entry, "usernameFragment"),
                ),
            )
        }
        // The nullable-but-not-omittable case is the one an encoder gets wrong,
        // so a fixture that stopped carrying it must fail here rather than
        // quietly stop testing it.
        assertTrue(sawNull, "the ice vectors must include a null sdpMid/sdpMLineIndex case")
    }

    @Test
    fun `abort payloads`() {
        for (item in Fixtures.arr(vectors, "payloads", "abort")) {
            val entry = item as Json.Obj
            val reason = assertNotNull(
                RelayRenewWire.AbortReason.of(Fixtures.str(entry, "reason")),
                "the reason enum must be complete",
            )
            assertPayload(entry, RelayRenewWire.Message.Abort(Fixtures.num(entry, "epoch"), reason))
        }
    }

    // ── the control frame ───────────────────────────────────────────────────

    @Test
    fun `probe frames, byte for byte, in both directions`() {
        for (item in Fixtures.arr(vectors, "probeFrames")) {
            val entry = item as Json.Obj
            val case = Fixtures.str(entry, "case")
            val type = Fixtures.num(entry, "type").toInt()
            val epoch = Fixtures.num(entry, "epoch")
            val round = Fixtures.num(entry, "round")
            val nonce = Bytes.unhex(Fixtures.str(entry, "nonceHex"))
            assertEquals(Fixtures.str(entry, "nonceBase64"), Bytes.base64(nonce), "$case: nonce b64")

            val payload = RelayRenewProbe.payload(
                type, from, to, epoch, round, Fixtures.str(entry, "nonceBase64"),
            )
            assertEquals(Fixtures.str(entry, "payload"), payload, "$case: payload")
            assertEquals(
                Fixtures.str(entry, "payloadUtf8Hex"),
                Bytes.hex(payload.toByteArray(Charsets.UTF_8)),
                "$case: payload bytes",
            )

            // The tag rides the frame RAW; the module's only HMAC primitive
            // speaks base64, so the two are the same 32 bytes either way round.
            val tagHex = Fixtures.str(entry, "tagHex")
            val tag = Bytes.unhex(tagHex)
            assertEquals(tagHex, Bytes.hex(Bytes.unhex(tagHex)), "$case: fixture tag is hex")
            assertEquals(Bytes.base64(tag), Crypto.signAuth(keys, payload), "$case: tag")

            val encoded = RelayRenewProbe.encode(type, epoch, round, nonce, tag)
            assertEquals(Fixtures.str(entry, "frameHex"), Bytes.hex(encoded), "$case: frame")
            assertEquals(RelayRenewProbe.FRAME_BYTES, encoded.size, "$case: frame length")

            val decoded = assertNotNull(RelayRenewProbe.decode(encoded), "$case: decode")
            assertEquals(type, decoded.type, "$case: type")
            assertEquals(epoch, decoded.epoch, "$case: epoch")
            assertEquals(round, decoded.round, "$case: round")
            assertEquals(Bytes.hex(nonce), Bytes.hex(decoded.nonce), "$case: nonce")
            assertEquals(tagHex, Bytes.hex(decoded.tag), "$case: tag bytes")
            assertTrue(RelayRenewProbe.isControlFrame(encoded), "$case: demuxed")
        }
    }

    @Test
    fun `a control frame of any other length, kind or version is refused`() {
        val good = Bytes.unhex(
            Fixtures.str(Fixtures.arr(vectors, "probeFrames")[0] as Json.Obj, "frameHex"),
        )
        assertNotNull(RelayRenewProbe.decode(good))
        assertNull(RelayRenewProbe.decode(good.copyOf(good.size - 1)), "58 bytes")
        assertNull(RelayRenewProbe.decode(good + byteArrayOf(0)), "60 bytes")
        assertNull(RelayRenewProbe.decode(ByteArray(0)), "empty")
        assertNull(
            RelayRenewProbe.decode(good.copyOf().also { it[1] = 2 }),
            "version 2",
        )
        assertNull(
            RelayRenewProbe.decode(good.copyOf().also { it[2] = 3 }),
            "an unknown type",
        )
        val wrongKind = good.copyOf().also { it[0] = 9 }
        assertNull(RelayRenewProbe.decode(wrongKind), "kind 9")
        // …and a wrong-kind frame is NOT consumed by the demux: it is the text
        // lane's, and swallowing it here would strand that lane's sequence.
        assertFalse(RelayRenewProbe.isControlFrame(wrongKind))
        // A malformed frame that DOES claim this kind is still consumed. It must
        // never reach the text session's rate budget or its idle clock.
        assertTrue(RelayRenewProbe.isControlFrame(good.copyOf(good.size - 1)))
    }

    // ── the envelope ────────────────────────────────────────────────────────

    @Test
    fun `accepted envelopes parse and re-render`() {
        val accepted = Fixtures.arr(vectors, "envelopes", "accept")
        assertTrue(accepted.isNotEmpty())
        for (item in accepted) {
            val entry = item as Json.Obj
            val case = Fixtures.str(entry, "case")
            val json = Fixtures.obj(entry, "json")
            val parsed = assertNotNull(RelayRenewWire.parseEnvelope(json), "$case: parse")
            assertEquals(Fixtures.str(json, "auth"), parsed.auth, "$case: auth")
            // Re-rendering must reproduce the fixture's own object exactly —
            // key set, key order and value types.
            assertEquals(
                Json.stringify(json),
                Json.stringify(RelayRenewWire.envelopeJson(parsed.message, parsed.auth)),
                "$case: re-render",
            )
        }
    }

    @Test
    fun `every rejected envelope is refused`() {
        val rejected = Fixtures.arr(vectors, "envelopes", "reject")
        assertTrue(rejected.isNotEmpty())
        for (item in rejected) {
            val entry = item as Json.Obj
            val case = Fixtures.str(entry, "case")
            val json = Fixtures.obj(entry, "json")
            assertNull(RelayRenewWire.parseEnvelope(json), "$case: ${Fixtures.str(entry, "why")}")
        }
    }

    @Test
    fun `a hoisted sdp or ice is not a renewal envelope, and is not routed as one`() {
        // The two most dangerous rejects deserve their own assertion: the
        // reason nesting exists at all is that `establish()` filters by
        // GENERATION, not by kind, so a top-level `sdp` on the link generation
        // would be applied by the ordinary handler as a real, unauthenticated
        // renegotiation against a live PeerConnection.
        for (item in Fixtures.arr(vectors, "envelopes", "reject")) {
            val entry = item as Json.Obj
            val case = Fixtures.str(entry, "case")
            if (!case.contains("hoisted")) continue
            val json = Fixtures.obj(entry, "json")
            assertNull(RelayRenewWire.parseEnvelope(json), case)
            // …and the SHAPE gate refuses it too, so the router never hands it
            // to the renewal controller in the first place.
            assertFalse(RelayRenewWire.isRenewEnvelope(json), "$case: shape")
            // The ordinary link parser still sees exactly what it always saw.
            assertNotNull(Signal.fromJson(json), "$case: still an ordinary signal")
        }
    }

    @Test
    fun `a leave signal stays inert here, and a renewal envelope stays inert there`() {
        val leave = Fixtures.arr(vectors, "envelopes", "reject")
            .map { it as Json.Obj }
            .first { Fixtures.str(it, "case") == "a leave signal" }
        val leaveJson = Fixtures.obj(leave, "json")
        assertFalse(RelayRenewWire.isRenewEnvelope(leaveJson))
        assertNull(RelayRenewWire.parseEnvelope(leaveJson))

        // The other direction. A renewal envelope reaching the LEAVE allow-list
        // and the ordinary signal reader must do nothing at all: no commitment,
        // no SDP, no candidate, no busy, no leave, no caps. That is what makes
        // it safe on a socket an establishment is also reading.
        val renewJson = Fixtures.obj(
            Fixtures.arr(vectors, "envelopes", "accept")[0] as Json.Obj,
            "json",
        )
        assertNull(LinkProtocol.parseLeaveAuth(renewJson))
        val signal = assertNotNull(Signal.fromJson(renewJson))
        assertEquals(Signal.Generation.LINK, signal.generation)
        assertNull(signal.sdpType)
        assertNull(signal.sdp)
        assertNull(signal.candidate)
        assertNull(signal.commit)
        assertNull(signal.revealKey)
        assertNull(signal.caps)
        assertFalse(signal.busy)
        assertFalse(signal.leave)
        assertFalse(signal.linkRequest)
    }

    // ── the server exchange ─────────────────────────────────────────────────

    @Test
    fun `the round request carries exactly round and rid`() {
        val request = Fixtures.obj(vectors, "server", "request", "envelope")
        assertEquals("ice-renew", Fixtures.str(request, "type"))
        val data = Fixtures.obj(request, "data")
        val built = RelayRenewWire.renewRequestData(
            Fixtures.num(data, "round"),
            Fixtures.num(data, "rid"),
        )
        assertEquals(Json.stringify(data), Json.stringify(built))
    }

    @Test
    fun `accepted grants parse`() {
        for (item in Fixtures.arr(vectors, "server", "grants", "accept")) {
            val entry = item as Json.Obj
            val case = Fixtures.str(entry, "case")
            val json = Fixtures.obj(entry, "json")
            val grant = assertNotNull(RelayRenewWire.parseGrant(json), "$case: parse")
            assertEquals(Fixtures.str(json, "status"), grant.status.wire, "$case: status")
            assertEquals(Fixtures.num(json, "round"), grant.round, "$case: round")
            assertEquals(Fixtures.num(json, "rid"), grant.rid, "$case: rid")
            assertEquals(
                Fixtures.optionalString(json["relayDenied"]).orEmpty(),
                grant.relayDenied,
                "$case: relayDenied",
            )
            assertEquals(
                Fixtures.optionalString(json["reason"]).orEmpty(),
                grant.reason,
                "$case: reason",
            )
        }
    }

    @Test
    fun `rejected grants are refused`() {
        for (item in Fixtures.arr(vectors, "server", "grants", "reject")) {
            val entry = item as Json.Obj
            val json = entry["json"]
            assertNull(
                RelayRenewWire.parseGrant(json),
                "${Fixtures.str(entry, "case")}: ${Fixtures.str(entry, "why")}",
            )
        }
    }

    // ── the pin and the ufrag binding ───────────────────────────────────────

    @Test
    fun `sdp pinning`() {
        val cases = Fixtures.arr(vectors, "sdpPin").map { it as Json.Obj }
        val baselineEntry = cases.first { Fixtures.str(it, "case") == "baseline" }
        val baseline = RelayRenewSdp.pin(Fixtures.str(baselineEntry, "sdp"))

        val expected = Fixtures.obj(baselineEntry, "pin")
        assertEquals(
            Fixtures.arr(expected, "fingerprints").map { Fixtures.string(it) },
            baseline.fingerprints,
        )
        assertEquals(Fixtures.arr(expected, "mids").map { Fixtures.string(it) }, baseline.mids)
        assertEquals(Fixtures.str(expected, "setup"), baseline.setup)

        for (entry in cases) {
            val case = Fixtures.str(entry, "case")
            val sdp = Fixtures.str(entry, "sdp")
            assertEquals(Fixtures.str(entry, "ufrag"), RelayRenewSdp.iceUfrag(sdp), "$case: ufrag")
            val asOffer = Fixtures.optionalBool(entry["matchesBaselineAsOffer"]) ?: continue
            val asAnswer = Fixtures.optionalBool(entry["matchesBaselineAsAnswer"])
                ?: error("$case states an offer expectation but no answer one")
            val pin = RelayRenewSdp.pin(sdp)
            assertEquals(
                asOffer,
                RelayRenewSdp.pinMatches(baseline, pin, isAnswer = false),
                "$case: as offer",
            )
            assertEquals(
                asAnswer,
                RelayRenewSdp.pinMatches(baseline, pin, isAnswer = true),
                "$case: as answer",
            )
        }
    }

    @Test
    fun `a candidate names its own generation`() {
        for (item in Fixtures.arr(vectors, "candidateUfrag")) {
            val entry = item as Json.Obj
            assertEquals(
                Fixtures.str(entry, "ufrag"),
                RelayRenewSdp.candidateUfrag(Fixtures.str(entry, "candidate")),
                Fixtures.str(entry, "case"),
            )
        }
    }

    @Test
    fun `an inbound candidate's two ufrag sources must agree`() {
        for (item in Fixtures.arr(vectors, "inboundCandidateUfrag")) {
            val entry = item as Json.Obj
            assertEquals(
                Fixtures.str(entry, "ufrag"),
                RelayRenewSdp.inboundCandidateUfrag(
                    Fixtures.str(entry, "candidate"),
                    Fixtures.str(entry, "usernameFragment"),
                ),
                Fixtures.str(entry, "case"),
            )
        }
    }
}
