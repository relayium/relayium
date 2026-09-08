package com.relayium.protocol.stored

import com.relayium.protocol.Bytes
import com.relayium.protocol.Fixtures
import com.relayium.protocol.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `stored/1` against `store-wire-vectors.json` — the same golden file the Web
 * generates and the Swift port asserts on.
 *
 * These bytes are the interoperability contract. A manifest that serialises one
 * space differently, a nonce derived from the wrong counter, a zero-byte file
 * that wrongly consumes a sequence number: each produces a stream that this
 * client would happily round-trip with itself and no other client could read.
 * The fixture is what makes that impossible to ship, so it runs before anything
 * opens a socket.
 */
class StoredWireVectorTest {

    private val v = StoredFixtures.vectors

    private val key: ByteArray get() = Bytes.unhex(Fixtures.str(v, "keyHex"))

    /** The manifest exactly as the fixture declares it: an OBJECT, whose entry
     *  order is the order the compact JSON must preserve. */
    private fun fixtureManifest(): StoredManifest {
        val entries = Fixtures.arr(v, "manifest", "json", "files").map { item ->
            val entry = item as Json.Obj
            ManifestFile(Fixtures.string(entry["name"]), Fixtures.number(entry["size"]))
        }
        return StoredManifest(entries)
    }

    private fun fixtureFiles(): List<ByteArray> =
        Fixtures.arr(v, "files").map { Bytes.unhex(Fixtures.string((it as Json.Obj)["dataHex"])) }

    @Test
    fun `key encodes and decodes as unpadded base64url`() {
        assertEquals(Fixtures.str(v, "keyB64url"), encodeStoreKey(key))
        assertArrayEquals(key, decodeStoreKey(Fixtures.str(v, "keyB64url")))
    }

    @Test
    fun `manifest ciphertext matches the golden bytes`() {
        // Byte-for-byte, not merely "decrypts back": the tag covers the exact
        // serialisation, so this is the assertion that pins key order and
        // spacing. A round-trip through this client alone would pass either way.
        assertEquals(
            Fixtures.str(v, "manifest", "ctHex"),
            Bytes.hex(encryptManifest(key, fixtureManifest())),
        )
    }

    @Test
    fun `manifest decrypts to the same entries, raw`() {
        val decoded = decryptManifestRaw(key, Bytes.unhex(Fixtures.str(v, "manifest", "ctHex")))
        assertEquals(fixtureManifest(), decoded)
    }

    @Test
    fun `display names strip bidi controls`() {
        val names = decryptManifestRaw(key, Bytes.unhex(Fixtures.str(v, "manifest", "ctHex")))
            .displayNames()
        assertEquals(
            Fixtures.arr(v, "manifest", "sanitizedNames").map { Fixtures.string(it) },
            names,
        )
        assertEquals(Fixtures.str(v, "sanitize", "out"), names[1])
    }

    @Test
    fun `the framed stream matches the golden bytes`() {
        assertEquals(Fixtures.str(v, "streamHex"), Bytes.hex(encryptChunks(key, fixtureFiles())))
    }

    @Test
    fun `cipherSize predicts the exact wire length`() {
        val sizes = fixtureManifest().files.map { it.size }
        assertEquals(Fixtures.num(v, "cipherSize"), cipherSize(sizes))
        assertEquals(
            Fixtures.num(v, "cipherSize").toInt(),
            encryptChunks(key, fixtureFiles()).size,
        )
    }

    @Test
    fun `the stream decrypts back to every file, across arbitrary boundaries`() {
        val stream = Bytes.unhex(Fixtures.str(v, "streamHex"))
        // Fed ONE BYTE AT A TIME, which is the property that matters: the wire
        // splits frames wherever it likes and the decoder may not depend on a
        // read landing on a frame edge.
        val decryptor = StoreDecryptor(key)
        val chunks = ArrayList<ByteArray>()
        for (byte in stream) chunks += decryptor.push(byteArrayOf(byte))
        decryptor.end(Fixtures.num(v, "plaintextBytes"))
        assertArrayEquals(
            fixtureFiles().reduce { a, b -> a + b },
            chunks.reduce { a, b -> a + b },
        )
        assertEquals(Fixtures.num(v, "cipherSize"), decryptor.consumedCipher)
    }
}
