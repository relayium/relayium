package com.relayium.protocol.inbox

import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.StoredWireException
import com.relayium.protocol.stored.decryptManifestRaw
import com.relayium.protocol.stored.encryptManifest
import kotlin.test.assertFailsWith
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The strictness the frozen vectors cannot express in a JSON string: raw bytes
 * that are not UTF-8, a name with no UTF-8 spelling at all, the exact byte
 * measurement of the name bound, and the sealed frame this document travels in.
 *
 * Every case here would be invisible to a suite that only fed the codec strings.
 */
class InboxManifestStrictnessTest {

    private val contentKey = ByteArray(32) { it.toByte() }

    private fun document(name: String) =
        """{"v":3,"items":[{"kind":"file","name":"$name","size":1}]}"""

    // ── bytes, not text ─────────────────────────────────────────────────────

    @Test
    fun `a name that is not valid UTF-8 is refused rather than repaired`() {
        // U+FFFD substitution would turn a name the sender never wrote into one
        // the rules below then approve, and a receiver would create it.
        val prefix = """{"v":3,"items":[{"kind":"file","name":"a""".toByteArray(Charsets.UTF_8)
        val suffix = """.txt","size":1}]}""".toByteArray(Charsets.UTF_8)
        for (bad in listOf(byteArrayOf(0xFF.toByte()), byteArrayOf(0xC0.toByte(), 0xAF.toByte()))) {
            val thrown = assertFailsWith<InboxManifestException> {
                InboxManifest.decode(prefix + bad + suffix)
            }
            assertEquals(InboxManifestReason.MALFORMED, thrown.reason)
        }
    }

    @Test
    fun `a lone surrogate has no canonical byte sequence and is refused`() {
        // It cannot arrive from UTF-8 input; it can only arrive as a `\udXXX`
        // escape. Accepting it would leave a document whose canonical form
        // depends on how each encoder substitutes for an unpaired half.
        val thrown = assertFailsWith<InboxManifestException> {
            InboxManifest.decode(document("a\\ud800b.txt").toByteArray(Charsets.UTF_8))
        }
        assertEquals(InboxManifestReason.NAME, thrown.reason)
        assertFalse(InboxManifest.isAcceptableName("a\uD800b.txt"))
        assertTrue(InboxManifest.isAcceptableName("a😀b.txt"))
    }

    @Test
    fun `the name bound is measured in UTF-8 bytes, not characters`() {
        // 512 two-byte characters is exactly the ceiling; 513 is one character
        // over a limit a UTF-16 length check would have called half spent.
        assertTrue(InboxManifest.isAcceptableName("é".repeat(512)))
        assertFalse(InboxManifest.isAcceptableName("é".repeat(513)))
    }

    // ── the constructors validate ───────────────────────────────────────────

    @Test
    fun `the built manifests are validated and the raw constructor is not`() {
        assertEquals(3L, InboxManifest.files(listOf("a.txt" to 1L, "b/c.txt" to 2L)).totalSize)
        assertEquals(InboxManifestKind.TEXT, InboxManifest.text(11).kind)
        assertFailsWith<InboxManifestException> { InboxManifest.files(listOf("../a" to 1L)) }
        assertFailsWith<InboxManifestException> { InboxManifest.text(0) }
        // The raw constructor accepts anything; encode is where it is caught, so
        // no caller can assemble a value and skip the bounds by accident.
        val unvalidated = InboxManifestV3(listOf(InboxManifestItem.file("../a", 1)))
        assertEquals(
            InboxManifestReason.NAME,
            assertFailsWith<InboxManifestException> { InboxManifest.encode(unvalidated) }.reason,
        )
    }

    @Test
    fun `a refusal carries the reason and never the offending name`() {
        val secret = "wages-2026-confidential.pdf"
        val thrown = assertFailsWith<InboxManifestException> {
            InboxManifest.files(listOf("../$secret" to 1L))
        }
        assertFalse(thrown.message!!.contains(secret))
        assertEquals(InboxManifestReason.NAME, thrown.reason)
    }

    // ── the sealed frame ────────────────────────────────────────────────────

    @Test
    fun `frame 0 round-trips through the stored AEAD unit`() {
        val manifest = InboxManifest.files(listOf("trip/day 1/IMG_0001.jpg" to 4096L))
        val sealed = InboxManifest.seal(contentKey, manifest)
        assertEquals(manifest, InboxManifest.open(contentKey, sealed))
        assertArrayEquals(InboxManifest.encode(manifest), InboxManifest.encode(InboxManifest.open(contentKey, sealed)))
    }

    @Test
    fun `a tampered or wrongly-keyed frame 0 fails as transport, not as a document`() {
        // The distinction matters to the caller: an AEAD refusal may be worth
        // retrying, a document refusal never is — the seal opened, so every later
        // attempt reads exactly the same bytes.
        val sealed = InboxManifest.seal(contentKey, InboxManifest.text(11))
        val tampered = sealed.copyOf().also { it[3] = (it[3].toInt() xor 1).toByte() }
        assertEquals(
            StoredWireException.Reason.TRUNCATED_STREAM,
            assertFailsWith<StoredWireException> { InboxManifest.open(contentKey, tampered) }.reason,
        )
        val otherKey = ByteArray(32) { (it + 1).toByte() }
        assertEquals(
            StoredWireException.Reason.TRUNCATED_STREAM,
            assertFailsWith<StoredWireException> { InboxManifest.open(otherKey, sealed) }.reason,
        )
    }

    // ── the two manifests stay separate ─────────────────────────────────────

    @Test
    fun `a v1 stored manifest is refused as a version, never read as a nameless file`() {
        // The shared Stored-Wire manifest occupies the same frame, under the same
        // key, at the same sequence number. Reading one with the other codec is
        // the drift this refusal exists to make impossible.
        val storedFrame = encryptManifest(contentKey, StoredManifest(listOf(ManifestFile("a.txt", 1))))
        assertEquals(
            InboxManifestReason.VERSION,
            assertFailsWith<InboxManifestException> { InboxManifest.open(contentKey, storedFrame) }.reason,
        )
        val inboxFrame = InboxManifest.seal(contentKey, InboxManifest.text(11))
        assertEquals(
            StoredWireException.Reason.INVALID_MANIFEST,
            assertFailsWith<StoredWireException> { decryptManifestRaw(contentKey, inboxFrame) }.reason,
        )
    }
}
