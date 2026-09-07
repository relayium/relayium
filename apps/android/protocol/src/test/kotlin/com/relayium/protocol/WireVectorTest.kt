package com.relayium.protocol

import java.security.MessageDigest
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The file and text wires against `realtime-wire-vectors.json`.
 *
 * Every byte here was produced by the shipped Web implementation. Where a whole
 * frame stream would be megabytes of hex the fixture pins it as (kind, seq,
 * length) per frame plus one SHA-256 over the exact concatenation, so a single
 * wrong byte — a wrong nonce, a wrong kind, a re-sent chunk, a rewound sequence
 * — fails the digest exactly as it would fail a hex comparison.
 */
class WireVectorTest {

    private val v = Fixtures.wire

    private fun sessionKeys(hexKey: String): Crypto.SessionKeys {
        // Only the file-lane keys matter for these vectors, and both directions
        // use the same key because the fixture is one side talking to itself.
        val raw = Bytes.unhex(hexKey)
        return Crypto.SessionKeys(
            sendKey = raw.copyOf(),
            recvKey = raw.copyOf(),
            resumeAuthKey = ByteArray(32),
            textSendKey = raw.copyOf(),
            textRecvKey = raw.copyOf(),
        )
    }

    /**
     * The generator's xorshift, so a body is described by (size, seed) rather
     * than by megabytes of hex.
     *
     * The middle step is an ARITHMETIC shift. JavaScript's `x >> 17` converts
     * through ToInt32 and sign-extends, and Kotlin's `Int` holds exactly those
     * 32 bits, so `shr` reproduces it and `ushr` does not — which is a one
     * character difference that produces a completely different file and is
     * caught only by a digest like the ones below. The `>>> 0` normalisations
     * around it are JavaScript housekeeping with no Kotlin equivalent needed.
     */
    private fun content(n: Int, seed: Int): ByteArray {
        val out = ByteArray(n)
        var x = if (seed == 0) 1 else seed
        for (i in 0 until n) {
            x = x xor (x shl 13)
            x = x xor (x shr 17)
            x = x xor (x shl 5)
            out[i] = (x and 0xff).toByte()
        }
        return out
    }

    private fun sha256(bytes: ByteArray) = Bytes.hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    // ── the single-chunk frame stream ───────────────────────────────────────

    @Test
    fun `the committed frame stream reproduces byte for byte`() {
        val keys = sessionKeys(Fixtures.str(v, "sessionKeyHex"))
        val sender = RealtimeSender()
        val manifestFiles = Fixtures.arr(v, "manifest", "files").map { entry ->
            val o = entry as Json.Obj
            FileMeta(
                Fixtures.string(o["name"]),
                Fixtures.number(o["size"]),
                Fixtures.optionalString(o["path"]),
            )
        }
        val expected = Fixtures.arr(v, "framesHex").map { Fixtures.string(it) }

        val produced = ArrayList<String>()
        // The manifest fits one message at the default ceiling.
        produced += sender.batchFrames(keys.let { manifestFiles }, keys, RealtimeFrame.CHUNK_SIZE + RealtimeFrame.OVERHEAD)
            .map { Bytes.hex(it) }
        val bodies = Fixtures.arr(v, "files").map { Bytes.unhex(Fixtures.string((it as Json.Obj)["dataHex"])) }
        for (body in bodies) {
            produced += sender.chunkFrames(body, keys, RealtimeFrame.CHUNK_SIZE + RealtimeFrame.OVERHEAD)
                .map { Bytes.hex(it) }
            produced += Bytes.hex(sender.doneFrame(Crypto.chainAdvance(Crypto.chainStart(), body), keys))
        }
        assertEquals(expected, produced)
        assertEquals(Fixtures.str(v, "batchFrameHex"), produced.first())
        assertEquals(Fixtures.str(v, "frameStreamHex"), produced.joinToString(""))
    }

    @Test
    fun `a receiver reads the committed stream back to the committed values`() {
        val keys = sessionKeys(Fixtures.str(v, "sessionKeyHex"))
        val receiver = RealtimeReceiver()
        val frames = Fixtures.arr(v, "framesHex").map { Bytes.unhex(Fixtures.string(it)) }
        val sanitized = Fixtures.arr(v, "sanitizedNames").map { it as Json.Obj }
        val doneHashes = Fixtures.arr(v, "doneHashes").map { Fixtures.string(it) }

        var files: List<FileMeta>? = null
        val chunks = ArrayList<ByteArray>()
        var doneCount = 0
        for (frame in frames) {
            when (val out = receiver.feed(frame, keys)) {
                is RealtimeReceiver.Output.Batch -> files = out.files
                is RealtimeReceiver.Output.Chunk -> chunks.add(out.plaintext)
                is RealtimeReceiver.Output.Done -> {
                    assertTrue("file $doneCount must verify against its chained digest", out.verified)
                    doneCount++
                }
                is RealtimeReceiver.Output.Buffered -> {}
            }
        }
        assertNotNull(files)
        assertEquals(doneHashes.size, doneCount)
        // The manifest is sanitised at this single decode entry point, so what
        // the caller receives is already safe to display and to write.
        assertEquals(
            sanitized.map { Fixtures.string(it["name"]) },
            files!!.map { it.name },
        )
        assertEquals(
            sanitized.map { Fixtures.optionalString(it["path"]) },
            files.map { it.path },
        )
        // And the digests the fixture pins are the ones this chain produces.
        val bodies = Fixtures.arr(v, "files").map { Bytes.unhex(Fixtures.string((it as Json.Obj)["dataHex"])) }
        bodies.forEachIndexed { i, body ->
            assertEquals(doneHashes[i], Bytes.hex(Crypto.chainAdvance(Crypto.chainStart(), body)))
        }
        bodies.forEachIndexed { i, body -> assertTrue(body.contentEquals(chunks[i])) }
    }

    @Test
    fun `the control bytes and the ACK frame are the committed ones`() {
        assertEquals(Fixtures.str(v, "controlHex", "accept"), RealtimeFrame.CTRL_ACCEPT.toString(16))
        assertEquals(Fixtures.str(v, "controlHex", "reject"), RealtimeFrame.CTRL_REJECT.toString(16))
        assertEquals(Fixtures.str(v, "controlHex", "complete"), RealtimeFrame.CTRL_COMPLETE.toString(16))
        val ackHex = Fixtures.str(v, "ackHex")
        assertEquals(ackHex, Bytes.hex(RealtimeFrame.ackFrame(1_048_576)))
        assertEquals(1_048_576L, RealtimeFrame.parseAck(Bytes.unhex(ackHex)))
        assertEquals(RealtimeFrame.ACK_FRAME_BYTES, Bytes.unhex(ackHex).size)
    }

    @Test
    fun `the frame kinds and limits are the committed ones`() {
        assertEquals(RealtimeFrame.KIND_CHUNK.toLong(), Fixtures.num(v, "kinds", "chunk"))
        assertEquals(RealtimeFrame.KIND_CHUNK_PART.toLong(), Fixtures.num(v, "kinds", "chunkPart"))
        assertEquals(RealtimeFrame.KIND_BATCH_ENC.toLong(), Fixtures.num(v, "kinds", "batchEnc"))
        assertEquals(RealtimeFrame.KIND_BATCH_PART.toLong(), Fixtures.num(v, "kinds", "batchPart"))
        assertEquals(RealtimeFrame.KIND_RESUME_START.toLong(), Fixtures.num(v, "kinds", "resumeStart"))
        assertEquals(RealtimeFrame.KIND_RESUME_REQ.toLong(), Fixtures.num(v, "kinds", "resumeReq"))
        assertEquals(RealtimeFrame.KIND_DONE_ENC.toLong(), Fixtures.num(v, "kinds", "doneEnc"))
        assertEquals(RealtimeFrame.CHUNK_SIZE.toLong(), Fixtures.num(v, "limits", "chunkSize"))
        assertEquals(RealtimeFrame.OVERHEAD.toLong(), Fixtures.num(v, "limits", "chunkOverhead"))
        assertEquals(RealtimeFrame.MIN_PIECE_BYTES.toLong(), Fixtures.num(v, "limits", "minPieceBytes"))
    }

    // ── the text lane ───────────────────────────────────────────────────────

    @Test
    fun `the committed text frames reproduce and open`() {
        val textKeyRaw = Bytes.unhex(Fixtures.str(v, "text", "keyHex"))
        val keys = Crypto.SessionKeys(
            sendKey = ByteArray(32), recvKey = ByteArray(32), resumeAuthKey = ByteArray(32),
            textSendKey = textKeyRaw.copyOf(), textRecvKey = textKeyRaw.copyOf(),
        )
        assertEquals(RealtimeFrame.KIND_TEXT_ENC.toLong(), Fixtures.num(v, "text", "kind"))
        assertEquals(TextWire.MAX_BYTES.toLong(), Fixtures.num(v, "text", "maxBytes"))

        val sender = TextWire.Sender()
        val receiver = TextWire.Receiver()
        val frames = Fixtures.arr(v, "text", "frames").map { it as Json.Obj }
        frames.forEachIndexed { i, entry ->
            val body = Fixtures.string(entry["body"])
            val expected = Fixtures.string(entry["frameHex"])
            assertEquals("frame $i", i.toLong(), Fixtures.number(entry["seq"]))
            assertEquals("frame $i must reproduce byte for byte", expected, Bytes.hex(sender.frame(body, keys)))
            // And it opens back to exactly the same string, including the
            // combining mark that must not be normalised away.
            assertEquals(body, receiver.feed(Bytes.unhex(expected), keys))
        }
        assertEquals("the per-direction counter starts at 0 and advances by one", 3L, receiver.nextExpectedSeq)
    }

    // ── fragmentation ───────────────────────────────────────────────────────

    @Test
    fun `a 64 KiB ceiling fragments exactly as the fixture pins`() {
        val frag = Fixtures.obj(v, "fragmentation")
        val keys = sessionKeys(Fixtures.str(frag, "keyHex"))
        val maxFrame = Fixtures.num(frag, "maxFrameBytes").toInt()
        assertEquals(
            "the fixture's piece size must be what this module computes",
            Fixtures.num(frag, "pieceBytes"), RealtimeFrame.piecePlainBytes(maxFrame).toLong(),
        )

        val metas = Fixtures.arr(frag, "manifest", "files").map { entry ->
            val o = entry as Json.Obj
            FileMeta(Fixtures.string(o["name"]), Fixtures.number(o["size"]))
        }
        val bodies = Fixtures.arr(frag, "bodies").map { entry ->
            val o = entry as Json.Obj
            val size = Fixtures.number(o["size"]).toInt()
            val seed = Fixtures.number(o["seed"]).toInt()
            val body = if (size == 0) ByteArray(0) else content(size, seed)
            assertEquals("the body's own digest", Fixtures.string(o["sha256"]), sha256(body))
            body
        }

        val sender = RealtimeSender()
        val batch = sender.batchFrames(metas, keys, maxFrame)
        assertEquals(
            Fixtures.arr(frag, "batchFramesHex").map { Fixtures.string(it) },
            batch.map { Bytes.hex(it) },
        )

        // Every data frame, in order, digested over the exact concatenation.
        val data = ArrayList<ByteArray>()
        val doneHashes = Fixtures.arr(frag, "doneHashes").map { Fixtures.string(it) }
        bodies.forEachIndexed { i, body ->
            var chain = Crypto.chainStart()
            var offset = 0
            while (offset < body.size) {
                val chunk = body.copyOfRange(offset, minOf(offset + RealtimeFrame.CHUNK_SIZE, body.size))
                chain = Crypto.chainAdvance(chain, chunk)
                data += sender.chunkFrames(chunk, keys, maxFrame)
                offset += RealtimeFrame.CHUNK_SIZE
            }
            assertEquals("file $i chained digest", doneHashes[i], Bytes.hex(chain))
            data += sender.doneFrame(chain, keys)
        }

        val expectedFrames = Fixtures.arr(frag, "dataFrames", "frames").map { it as Json.Obj }
        assertEquals(
            "frame count",
            Fixtures.num(frag, "dataFrames", "count"), data.size.toLong(),
        )
        data.forEachIndexed { i, frame ->
            val e = expectedFrames[i]
            assertEquals("frame $i kind", Fixtures.number(e["kind"]), RealtimeFrame.kindOf(frame).toLong())
            assertEquals("frame $i seq", Fixtures.number(e["seq"]), RealtimeFrame.seqOf(frame))
            assertEquals("frame $i length", Fixtures.number(e["length"]), frame.size.toLong())
        }
        assertEquals(
            "one digest over the exact concatenated stream",
            Fixtures.str(frag, "dataFrames", "streamSha256"),
            sha256(data.fold(ByteArray(0)) { acc, f -> acc + f }),
        )
    }

    @Test
    fun `a receiver reassembles the fragmented stream into the committed logical chunks`() {
        val frag = Fixtures.obj(v, "fragmentation")
        val keys = sessionKeys(Fixtures.str(frag, "keyHex"))
        val maxFrame = Fixtures.num(frag, "maxFrameBytes").toInt()
        val metas = Fixtures.arr(frag, "manifest", "files").map { entry ->
            val o = entry as Json.Obj
            FileMeta(Fixtures.string(o["name"]), Fixtures.number(o["size"]))
        }
        val bodies = Fixtures.arr(frag, "bodies").map { entry ->
            val o = entry as Json.Obj
            val size = Fixtures.number(o["size"]).toInt()
            if (size == 0) ByteArray(0) else content(size, Fixtures.number(o["seed"]).toInt())
        }
        val sender = RealtimeSender()
        val receiver = RealtimeReceiver()
        val all = ArrayList<ByteArray>()
        all += sender.batchFrames(metas, keys, maxFrame)
        bodies.forEach { body ->
            var chain = Crypto.chainStart()
            var offset = 0
            while (offset < body.size) {
                val chunk = body.copyOfRange(offset, minOf(offset + RealtimeFrame.CHUNK_SIZE, body.size))
                chain = Crypto.chainAdvance(chain, chunk)
                all += sender.chunkFrames(chunk, keys, maxFrame)
                offset += RealtimeFrame.CHUNK_SIZE
            }
            all += sender.doneFrame(chain, keys)
        }

        val received = ArrayList<Int>()
        var verified = 0
        for (frame in all) {
            when (val out = receiver.feed(frame, keys)) {
                is RealtimeReceiver.Output.Chunk -> received += out.plaintext.size
                is RealtimeReceiver.Output.Done -> { assertTrue(out.verified); verified++ }
                else -> {}
            }
        }
        assertEquals(
            "the LOGICAL chunks the receiver must reassemble, whatever carried them",
            Fixtures.arr(frag, "logicalChunkLengths").map { Fixtures.number(it).toInt() },
            received,
        )
        assertEquals(bodies.size, verified)
    }

    // ── resume frames are recognised and refused ────────────────────────────

    @Test
    fun `the committed resume frames parse to the committed points`() {
        val resume = Fixtures.obj(v, "resume")
        val req = RealtimeFrame.parseResumeRequest(Bytes.unhex(Fixtures.str(resume, "reqFrameHex")))
        assertNotNull(req)
        assertEquals(Fixtures.num(resume, "reqPoint", "index"), req!!.index.toLong())
        assertEquals(Fixtures.num(resume, "reqPoint", "offset"), req.offset)
        assertEquals(
            "and it re-encodes byte for byte",
            Fixtures.str(resume, "reqFrameHex"), Bytes.hex(RealtimeFrame.resumeRequestFrame(req)),
        )

        val start = RealtimeFrame.parseResumeStart(Bytes.unhex(Fixtures.str(resume, "startFrameHex")))
        assertNotNull(start)
        assertEquals(Fixtures.num(resume, "startPoint", "index"), start!!.point.index.toLong())
        assertEquals(Fixtures.num(resume, "startPoint", "offset"), start.point.offset)
        assertEquals(Fixtures.num(resume, "startPoint", "seq"), start.seq)
        assertEquals(
            Fixtures.str(resume, "startFrameHex"),
            Bytes.hex(RealtimeFrame.resumeStartFrame(start.point, start.seq)),
        )
    }

    @Test
    fun `resume frames are classified as control and never routed to the AEAD`() {
        val resume = Fixtures.obj(v, "resume")
        assertEquals(
            LinkProtocol.FileFrameClass.ResumeRequest,
            LinkProtocol.fileFrameClass(Bytes.unhex(Fixtures.str(resume, "reqFrameHex"))),
        )
        assertEquals(
            LinkProtocol.FileFrameClass.ResumeStart,
            LinkProtocol.fileFrameClass(Bytes.unhex(Fixtures.str(resume, "startFrameHex"))),
        )
    }

    @Test
    fun `the durable-resume fixture's first attempt reproduces before the resume`() {
        // Android defers transport resume, so the RESUMED half of this fixture
        // is not something this client can produce. Its FIRST attempt is, and it
        // is a desktop-class ceiling — no PART frames at all — which is the
        // other side of the fragmentation vector above.
        val dur = Fixtures.obj(v, "durableResume")
        val keys = sessionKeys(Fixtures.str(dur, "keyHex"))
        val maxFrame = Fixtures.num(dur, "firstMaxFrameBytes").toInt()
        val meta = Fixtures.arr(dur, "manifest", "files").map { entry ->
            val o = entry as Json.Obj
            FileMeta(Fixtures.string(o["name"]), Fixtures.number(o["size"]))
        }
        val body = content(Fixtures.num(dur, "body", "size").toInt(), Fixtures.num(dur, "body", "seed").toInt())
        assertEquals(Fixtures.str(dur, "body", "sha256"), sha256(body))

        val sender = RealtimeSender()
        assertEquals(
            Fixtures.arr(dur, "batchFramesHex").map { Fixtures.string(it) },
            sender.batchFrames(meta, keys, maxFrame).map { Bytes.hex(it) },
        )
        val emitted = ArrayList<ByteArray>()
        var chain = Crypto.chainStart()
        var offset = 0
        while (offset < body.size) {
            val chunk = body.copyOfRange(offset, minOf(offset + RealtimeFrame.CHUNK_SIZE, body.size))
            chain = Crypto.chainAdvance(chain, chunk)
            emitted += sender.chunkFrames(chunk, keys, maxFrame)
            offset += RealtimeFrame.CHUNK_SIZE
        }
        emitted += sender.doneFrame(chain, keys)
        assertEquals(Fixtures.str(dur, "doneHashHex"), Bytes.hex(chain))

        val delivered = Fixtures.arr(dur, "deliveredFrames", "frames").map { it as Json.Obj }
        val lost = Fixtures.arr(dur, "lostFrames", "frames").map { it as Json.Obj }
        val expected = delivered + lost
        assertEquals("delivered plus lost is the whole first attempt", expected.size, emitted.size)
        emitted.forEachIndexed { i, frame ->
            assertEquals("frame $i kind", Fixtures.number(expected[i]["kind"]), RealtimeFrame.kindOf(frame).toLong())
            assertEquals("frame $i seq", Fixtures.number(expected[i]["seq"]), RealtimeFrame.seqOf(frame))
            assertEquals("frame $i length", Fixtures.number(expected[i]["length"]), frame.size.toLong())
        }
        assertEquals(
            "the chain at the receiver's durable checkpoint",
            Fixtures.str(dur, "chainAtCheckpointHex"),
            Bytes.hex(
                (0 until Fixtures.num(dur, "checkpoint", "offset") / RealtimeFrame.CHUNK_SIZE).fold(
                    Crypto.chainStart(),
                ) { acc, i ->
                    val from = (i * RealtimeFrame.CHUNK_SIZE).toInt()
                    Crypto.chainAdvance(acc, body.copyOfRange(from, from + RealtimeFrame.CHUNK_SIZE))
                },
            ),
        )
        assertEquals(
            Fixtures.str(dur, "resumeReqHex"),
            Bytes.hex(
                RealtimeFrame.resumeRequestFrame(
                    RealtimeFrame.ResumePoint(
                        Fixtures.num(dur, "checkpoint", "index").toInt(),
                        Fixtures.num(dur, "checkpoint", "offset"),
                    ),
                ),
            ),
        )
    }

    // ── shape refusals at the parse boundary ────────────────────────────────

    @Test
    fun `a resume request with an unsafe shape is not a resume request`() {
        fun req(body: String) = RealtimeFrame.frame(
            RealtimeFrame.KIND_RESUME_REQ, 0, body.toByteArray(Charsets.UTF_8),
        )
        // A negative offset would make the sender slice a file from its END.
        assertNull(RealtimeFrame.parseResumeRequest(req("""{"index":0,"offset":-1}""")))
        assertNull(RealtimeFrame.parseResumeRequest(req("""{"index":-1,"offset":0}""")))
        assertNull(RealtimeFrame.parseResumeRequest(req("""{"index":0,"offset":1.5}""")))
        assertNull(RealtimeFrame.parseResumeRequest(req("""{"index":0}""")))
        assertNull(RealtimeFrame.parseResumeRequest(req("not json")))
        assertNull(RealtimeFrame.parseResumeRequest(req("")))
        // But it is still CLASSIFIED as a resume request, so the lane fails
        // closed on it rather than routing the bytes into the protected stream.
        assertEquals(
            LinkProtocol.FileFrameClass.ResumeRequest,
            LinkProtocol.fileFrameClass(req("not json")),
        )
    }

    @Test
    fun `a resume announcement at or above 2^32 is refused`() {
        fun start(seq: String) = RealtimeFrame.frame(
            RealtimeFrame.KIND_RESUME_START, 0,
            """{"index":0,"offset":0,"seq":$seq}""".toByteArray(Charsets.UTF_8),
        )
        assertNotNull(RealtimeFrame.parseResumeStart(start("4294967295")))
        // The wire field is a uint32, so this can never match a real frame's
        // on-wire value. The Web accepts it and then stalls; refusing outright
        // is a strict subset of what the Web accepts and cannot break interop.
        assertNull(RealtimeFrame.parseResumeStart(start("4294967296")))
        assertNull(RealtimeFrame.parseResumeStart(start("-1")))
    }

    @Test
    fun `a receive sequence never moves backwards on a resume`() {
        val keys = sessionKeys("77".repeat(32))
        val receiver = RealtimeReceiver()
        val sender = RealtimeSender()
        receiver.feed(sender.batchFrames(listOf(FileMeta("a", 0)), keys, 65_536).single(), keys)
        val at = receiver.nextExpectedSeq
        receiver.resumeAt(Crypto.chainStart(), at + 10) // forward is allowed
        val failure = runCatching { receiver.resumeAt(Crypto.chainStart(), at) }.exceptionOrNull()
        assertTrue(
            "rewinding would make an old ciphertext valid again under the same key and number",
            failure is RealtimeException,
        )
        assertFalse(RealtimeFrame.MAX_SEQ + 1 <= RealtimeFrame.MAX_SEQ)
    }
}
