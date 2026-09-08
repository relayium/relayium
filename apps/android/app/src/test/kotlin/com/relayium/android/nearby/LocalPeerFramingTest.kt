package com.relayium.android.nearby

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The signalling framing, at every boundary a TCP stream can actually produce.
 *
 * A stream delivers arbitrary splits, so "it worked on the emulator" samples one
 * arbitrary chunking and says nothing about the rest. These drive the splits
 * directly.
 */
class LocalPeerFramingTest {

    private fun frames(reader: LocalPeerFraming.Reader, bytes: ByteArray, chunk: Int): List<String> {
        val out = ArrayList<String>()
        var offset = 0
        while (offset < bytes.size) {
            val take = minOf(chunk, bytes.size - offset)
            out += reader.append(bytes.copyOfRange(offset, offset + take))
            offset += take
        }
        return out
    }

    @Test
    fun `a frame survives every chunk size from one byte upwards`() {
        val text = """{"type":"signal","from":"a","to":"b","data":{"caps":["link/1"]}}"""
        val encoded = LocalPeerFraming.encode(text)!!
        for (chunk in 1..encoded.size) {
            assertEquals(
                "chunked $chunk byte(s) at a time",
                listOf(text),
                frames(LocalPeerFraming.Reader(), encoded, chunk),
            )
        }
    }

    @Test
    fun `several frames inside one read come back in wire order`() {
        val texts = listOf("""{"a":1}""", """{"b":2}""", """{"c":3}""")
        val stream = texts.map { LocalPeerFraming.encode(it)!! }
            .reduce { acc, next -> acc + next }
        assertEquals(texts, LocalPeerFraming.Reader().append(stream))
    }

    @Test
    fun `a header split across reads is not a new frame`() {
        val text = """{"x":1}"""
        val encoded = LocalPeerFraming.encode(text)!!
        val reader = LocalPeerFraming.Reader()
        assertEquals(emptyList<String>(), reader.append(encoded.copyOfRange(0, 2)))
        assertEquals(2, reader.pendingBytes)
        assertEquals(listOf(text), reader.append(encoded.copyOfRange(2, encoded.size)))
        assertEquals("the reader is empty again", 0, reader.pendingBytes)
    }

    /** The declared length is the ONLY thing that says where a frame ends, so a
     *  zero declaration is not an empty frame — it is a stream that can never be
     *  resynchronised, and continuing to read it would misalign everything after. */
    @Test
    fun `a zero-length declaration fails the stream`() {
        val reader = LocalPeerFraming.Reader()
        assertThrows(LocalPeerFraming.Empty::class.java) {
            reader.append(byteArrayOf(0, 0, 0, 0, 1, 2))
        }
    }

    @Test
    fun `an oversized declaration is refused before a byte of it is buffered`() {
        val reader = LocalPeerFraming.Reader()
        val declared = LocalPeerFraming.MAX_FRAME_BYTES + 1
        val header = byteArrayOf(
            (declared ushr 24).toByte(), (declared ushr 16).toByte(),
            (declared ushr 8).toByte(), declared.toByte(),
        )
        val thrown = assertThrows(LocalPeerFraming.TooLarge::class.java) { reader.append(header) }
        assertEquals(declared, thrown.declared)
        // The four header bytes are all this reader ever held: the refusal
        // happens on the length, before the declared body is allocated. The
        // reader is dead after this — the caller drops the connection, because a
        // length-prefixed stream has nothing to resynchronise to.
        assertEquals(LocalPeerFraming.HEADER_BYTES, reader.pendingBytes)
    }

    @Test
    fun `the largest legal frame is accepted`() {
        val body = "x".repeat(LocalPeerFraming.MAX_FRAME_BYTES)
        val encoded = LocalPeerFraming.encode(body)!!
        assertEquals(
            LocalPeerFraming.HEADER_BYTES + LocalPeerFraming.MAX_FRAME_BYTES,
            encoded.size,
        )
        assertEquals(listOf(body), LocalPeerFraming.Reader().append(encoded))
    }

    @Test
    fun `encoding refuses what the reader would refuse`() {
        assertNull("an empty frame", LocalPeerFraming.encode(""))
        assertNull("one byte too many", LocalPeerFraming.encode("x".repeat(LocalPeerFraming.MAX_FRAME_BYTES + 1)))
    }

    /**
     * Strict, not lenient.
     *
     * The platform decoder REPLACES a malformed sequence with U+FFFD, which
     * would turn a corrupt frame into a valid-looking string that then fails to
     * parse as JSON — a different and more confusing failure than the truthful
     * one, and one that lets a corrupted stream keep running.
     */
    @Test
    fun `a body that is not UTF-8 fails the stream rather than being repaired`() {
        val body = byteArrayOf(0xC3.toByte(), 0x28) // a truncated two-byte sequence
        val framed = byteArrayOf(0, 0, 0, body.size.toByte()) + body
        assertThrows(LocalPeerFraming.NotUtf8::class.java) {
            LocalPeerFraming.Reader().append(framed)
        }
    }

    @Test
    fun `multi-byte characters survive a split through the middle of one`() {
        val text = "中文 🚀 nested"
        val encoded = LocalPeerFraming.encode(text)!!
        for (chunk in 1..encoded.size) {
            assertEquals(listOf(text), frames(LocalPeerFraming.Reader(), encoded, chunk))
        }
    }

    @Test
    fun `the reader holds no more than one frame's worth while it waits`() {
        val encoded = LocalPeerFraming.encode("y".repeat(1024))!!
        val reader = LocalPeerFraming.Reader()
        reader.append(encoded.copyOfRange(0, encoded.size - 1))
        assertTrue(
            "pending bytes stay inside the declared frame",
            reader.pendingBytes <= LocalPeerFraming.MAX_FRAME_BYTES + LocalPeerFraming.HEADER_BYTES,
        )
    }
}
