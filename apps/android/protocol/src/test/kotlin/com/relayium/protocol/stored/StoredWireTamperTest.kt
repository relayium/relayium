package com.relayium.protocol.stored

import com.relayium.protocol.FileMeta
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What `stored/1` REFUSES.
 *
 * Per-frame authentication is not whole-file verification, and most of this file
 * is about that gap: an attacker who can cut a stream on a frame boundary
 * delivers only frames that authenticate perfectly, and an attacker who can
 * append delivers a file plus something extra. Neither is caught by GCM. The
 * manifest total and the dangling-tail check are what catch them, so both are
 * exercised here against streams built by the real encoder.
 */
class StoredWireTamperTest {

    private val key = ByteArray(32) { 0x55 }
    private val other = ByteArray(32) { 0x11 }

    private fun refusal(body: () -> Unit): StoredWireException.Reason =
        try {
            body()
            throw AssertionError("expected the stored wire to refuse this")
        } catch (e: StoredWireException) {
            e.reason
        }

    private fun stream(vararg files: ByteArray) = encryptChunks(key, files.toList())

    private fun feed(bytes: ByteArray, key: ByteArray = this.key, expected: Long? = null) {
        val decryptor = StoreDecryptor(key)
        decryptor.push(bytes)
        decryptor.end(expected)
    }

    // ── the stream ──────────────────────────────────────────────────────────

    @Test
    fun `an altered ciphertext byte fails authentication`() {
        val bytes = stream("hello world".toByteArray())
        bytes[8] = (bytes[8].toInt() xor 0x01).toByte()
        assertEquals(StoredWireException.Reason.TRUNCATED_STREAM, refusal { feed(bytes) })
    }

    @Test
    fun `an altered tag byte fails authentication`() {
        val bytes = stream("hello world".toByteArray())
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x01).toByte()
        assertEquals(StoredWireException.Reason.TRUNCATED_STREAM, refusal { feed(bytes) })
    }

    @Test
    fun `an oversize length prefix is refused before allocating`() {
        val bytes = stream("hello world".toByteArray())
        writeU32be(bytes, 0, MAX_FRAME_CT + 1)
        assertEquals(StoredWireException.Reason.FRAME_TOO_LARGE, refusal { feed(bytes) })
    }

    @Test
    fun `a length prefix with the high bit set is refused, not read as negative`() {
        // The prefix is attacker-controlled and 32 bits wide. Read as a signed
        // Int this is -1, which would sail under a `length > MAX` check and then
        // index out of the buffer.
        val bytes = stream("hello world".toByteArray())
        for (i in 0..3) bytes[i] = 0xff.toByte()
        assertEquals(StoredWireException.Reason.FRAME_TOO_LARGE, refusal { feed(bytes) })
    }

    @Test
    fun `truncation on a frame boundary is caught only by the expected total`() {
        val bytes = stream(ByteArray(STORE_CHUNK_SIZE) { 7 }, "tail".toByteArray())
        val firstFrame = 4 + STORE_CHUNK_SIZE + 16
        val cut = bytes.copyOfRange(0, firstFrame)
        // Every delivered frame authenticates, and the stream ends cleanly on a
        // frame edge. Without the manifest's total this is indistinguishable
        // from a complete file.
        feed(cut, expected = null)
        assertEquals(
            StoredWireException.Reason.LENGTH_MISMATCH,
            refusal { feed(cut, expected = STORE_CHUNK_SIZE + 4L) },
        )
    }

    @Test
    fun `truncation inside a frame is a dangling tail`() {
        val bytes = stream("hello world".toByteArray())
        val cut = bytes.copyOfRange(0, bytes.size - 3)
        assertEquals(StoredWireException.Reason.TRUNCATED_STREAM, refusal { feed(cut) })
    }

    @Test
    fun `trailing bytes after a complete file are refused`() {
        val bytes = stream("hello world".toByteArray()) + byteArrayOf(0, 0, 0)
        assertEquals(
            StoredWireException.Reason.TRUNCATED_STREAM,
            refusal { feed(bytes, expected = 11) },
        )
    }

    @Test
    fun `a wrong key never yields plaintext`() {
        val bytes = stream("hello world".toByteArray())
        assertEquals(StoredWireException.Reason.TRUNCATED_STREAM, refusal { feed(bytes, key = other) })
    }

    @Test
    fun `reordered frames fail because the nonce is the position`() {
        val a = ByteArray(STORE_CHUNK_SIZE) { 1 }
        val b = ByteArray(STORE_CHUNK_SIZE) { 2 }
        val bytes = stream(a, b)
        val frameSize = 4 + STORE_CHUNK_SIZE + 16
        val swapped = bytes.copyOfRange(frameSize, frameSize * 2) + bytes.copyOfRange(0, frameSize)
        assertEquals(StoredWireException.Reason.TRUNCATED_STREAM, refusal { feed(swapped) })
    }

    // ── chunk boundaries ────────────────────────────────────────────────────

    @Test
    fun `a zero-byte file yields no frame and consumes no sequence number`() {
        assertEquals(0L, cipherSize(listOf(0L)))
        assertEquals(0, encryptChunks(key, listOf(ByteArray(0))).size)
        // The sequence numbers of the file AFTER an empty one must not shift:
        // a stream with a leading empty file is byte-identical to one without.
        assertTrue(
            encryptChunks(key, listOf(ByteArray(0), "x".toByteArray()))
                .contentEquals(encryptChunks(key, listOf("x".toByteArray()))),
        )
    }

    @Test
    fun `an exact chunk boundary is one frame, one more byte is two`() {
        assertEquals(
            (4 + STORE_CHUNK_SIZE + 16).toLong(),
            cipherSize(listOf(STORE_CHUNK_SIZE.toLong())),
        )
        assertEquals(
            (4 + STORE_CHUNK_SIZE + 16 + 4 + 1 + 16).toLong(),
            cipherSize(listOf(STORE_CHUNK_SIZE + 1L)),
        )
        val bytes = encryptChunks(key, listOf(ByteArray(STORE_CHUNK_SIZE + 1) { 9 }))
        assertEquals(cipherSize(listOf(STORE_CHUNK_SIZE + 1L)), bytes.size.toLong())
        val decryptor = StoreDecryptor(key)
        val chunks = decryptor.push(bytes)
        decryptor.end(STORE_CHUNK_SIZE + 1L)
        assertEquals(listOf(STORE_CHUNK_SIZE, 1), chunks.map { it.size })
    }

    // ── the source contract ─────────────────────────────────────────────────

    /** A source whose content disagrees with the size the manifest committed to. */
    private class Drifting(override val size: Long, private val actual: Int) : PlaintextSource {
        override val name = "drift"
        private var sent = 0
        override fun read(max: Int): ByteArray {
            if (sent >= actual) return ByteArray(0)
            val n = minOf(max, actual - sent)
            sent += n
            return ByteArray(n)
        }
    }

    @Test
    fun `a source that shrank under us fails the upload`() {
        val encryptor = ChunkEncryptor(key, listOf(Drifting(size = 10, actual = 4)))
        assertEquals(
            StoredWireException.Reason.LENGTH_MISMATCH,
            refusal { while (encryptor.next() != null) Unit },
        )
    }

    @Test
    fun `a source that grew under us fails the upload`() {
        val encryptor = ChunkEncryptor(key, listOf(Drifting(size = 4, actual = 10)))
        assertEquals(
            StoredWireException.Reason.LENGTH_MISMATCH,
            refusal { while (encryptor.next() != null) Unit },
        )
    }

    // ── the key ─────────────────────────────────────────────────────────────

    @Test
    fun `a key with a character outside the alphabet is refused`() {
        for (bad in listOf("VVVV+VVV", "VVVV/VVV", "VVVVVVV=", "VVVV VVV", "VVVV\nVVV")) {
            assertEquals(StoredWireException.Reason.INVALID_KEY, refusal { decodeStoreKey(bad) })
        }
    }

    @Test
    fun `a key of any length but 43 is refused before it is decoded`() {
        val valid = encodeStoreKey(key)
        assertEquals(STORE_KEY_TEXT_LENGTH, valid.length)
        // A dropped character, an extra one, nothing at all — and a megabyte of
        // "key" from a clipboard, which must cost one length comparison rather
        // than a scan and a decode.
        for (bad in listOf(valid.dropLast(1), valid + "A", "", "VVVV", "V".repeat(1_000_000))) {
            assertEquals(StoredWireException.Reason.INVALID_KEY, refusal { decodeStoreKey(bad) })
        }
    }

    @Test
    fun `a generated key is 32 bytes and round-trips`() {
        val fresh = generateStoreKey()
        assertEquals(STORE_KEY_BYTES, fresh.size)
        assertTrue(decodeStoreKey(encodeStoreKey(fresh)).contentEquals(fresh))
    }

    @Test
    fun `cipherSize refuses sizes it could only answer by wrapping`() {
        // The answer becomes a Content-Length. A set of sizes that overflowed
        // into a small plausible number would declare a body length the request
        // then contradicts, so this refuses instead of wrapping.
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            refusal { cipherSize(listOf(Long.MAX_VALUE, Long.MAX_VALUE)) },
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            refusal { cipherSize(listOf(-1L)) },
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            refusal { cipherSize(listOf(MANIFEST_MAX_SAFE_INTEGER, MANIFEST_MAX_SAFE_INTEGER)) },
        )
    }

    @Test
    fun `a manifest that is not valid UTF-8 is refused, never substituted`() {
        // 0xFF is not a UTF-8 sequence. Decoded leniently it becomes U+FFFD and
        // the name silently changes into one path validation would approve.
        val bytes = """{"files":[{"name":"a""".toByteArray(Charsets.UTF_8) +
            byteArrayOf(0xff.toByte()) +
            """.txt","size":1}]}""".toByteArray(Charsets.UTF_8)
        val sealed = com.relayium.protocol.Crypto.seal(storeKeySpec(key), 0L, bytes)
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            refusal { decryptManifestRaw(key, sealed) },
        )
    }

    // ── the manifest ────────────────────────────────────────────────────────

    private fun manifestRefusal(files: List<ManifestFile>) =
        refusal { validateManifestFiles(files) }

    @Test
    fun `an unusable manifest is refused on both sides of the wire`() {
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal(emptyList()),
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal(listOf(ManifestFile("", 1))),
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal(listOf(ManifestFile("a".repeat(1025), 1))),
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal(listOf(ManifestFile("a", -1))),
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal(listOf(ManifestFile("a", MANIFEST_MAX_SAFE_INTEGER + 1))),
        )
        // Two sizes that are each individually legal and together are not.
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal(
                listOf(
                    ManifestFile("a", MANIFEST_MAX_SAFE_INTEGER),
                    ManifestFile("b", 1),
                ),
            ),
        )
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            manifestRefusal((0..1000).map { ManifestFile("f$it", 1) }),
        )
    }

    @Test
    fun `a manifest that is not the shape we agreed is refused`() {
        fun sealed(json: String) = com.relayium.protocol.Crypto.seal(
            storeKeySpec(key), 0L, json.toByteArray(Charsets.UTF_8),
        )
        for (bad in listOf(
            "not json",
            "[]",
            """{"files":{}}""",
            """{"files":[{"name":"a"}]}""",
            """{"files":[{"size":1}]}""",
            """{"files":[{"name":"a","size":"1"}]}""",
            """{"files":[{"name":"a","size":1.5}]}""",
            """{"files":[{"name":"a","size":-1}]}""",
        )) {
            val reason = refusal { decryptManifestRaw(key, sealed(bad)) }
            assertEquals(bad, StoredWireException.Reason.INVALID_MANIFEST, reason)
        }
    }

    @Test
    fun `a manifest sealed under another key is never parsed`() {
        val ciphertext = encryptManifest(other, StoredManifest(listOf(ManifestFile("a.txt", 1))))
        assertEquals(
            StoredWireException.Reason.TRUNCATED_STREAM,
            refusal { decryptManifestRaw(key, ciphertext) },
        )
    }

    // ── destinations ────────────────────────────────────────────────────────

    @Test
    fun `a folder manifest resolves to a path and a leaf`() {
        val metas = StoredManifest(listOf(ManifestFile("photos/sub/a.jpg", 3))).asFileMetas()
        assertEquals(listOf(FileMeta("a.jpg", 3, "photos/sub/a.jpg")), metas)
        assertTrue(StoredDestinations.plan(metas) is StoredDestinations.Accept)
    }

    @Test
    fun `a flat manifest carries no path at all`() {
        assertNull(StoredManifest(listOf(ManifestFile("a.jpg", 3))).asFileMetas()[0].path)
    }

    @Test
    fun `an unsafe name is refused before any folder is chosen`() {
        for (name in listOf("../escape.txt", "/etc/passwd", "a\\b.txt", "sub/../x.txt", "con.txt")) {
            val plan = StoredDestinations.plan(StoredManifest(listOf(ManifestFile(name, 1))).asFileMetas())
            assertEquals(name, StoredDestinations.Refuse(StoredDestinations.Reason.UNSAFE_NAME, 0), plan)
        }
    }

    @Test
    fun `two entries that would land on one document are refused up front`() {
        val plan = StoredDestinations.plan(
            StoredManifest(listOf(ManifestFile("a.txt", 1), ManifestFile("a.txt", 2))).asFileMetas(),
        )
        assertEquals(StoredDestinations.Refuse(StoredDestinations.Reason.COLLISION, 1), plan)
    }

    @Test
    fun `a collision manufactured by sanitising is refused too`() {
        // Sanitising is not injective: a name carrying a bidi control cleans to
        // one that another entry already owns. Caught before the first write,
        // where the receive store's no-overwrite rule would otherwise leave a
        // half-delivered batch in the user's folder.
        val plan = StoredDestinations.plan(
            StoredManifest(
                listOf(ManifestFile("ab.txt", 1), ManifestFile("a‮b.txt", 2)),
            ).asFileMetas(),
        )
        assertEquals(StoredDestinations.Refuse(StoredDestinations.Reason.COLLISION, 1), plan)
    }

    @Test
    fun `distinct folders keep same-named files apart`() {
        val plan = StoredDestinations.plan(
            StoredManifest(
                listOf(ManifestFile("a/x.txt", 1), ManifestFile("b/x.txt", 2)),
            ).asFileMetas(),
        )
        assertTrue(plan is StoredDestinations.Accept)
    }
}
