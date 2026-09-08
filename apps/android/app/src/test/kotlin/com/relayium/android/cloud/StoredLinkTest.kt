package com.relayium.android.cloud

import com.relayium.protocol.stored.encodeStoreKey
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Reading a link somebody else wrote, and refusing the ones this app cannot
 *  honestly open. */
class StoredLinkTest {

    private val origin = "https://relayium.com"
    private val key = ByteArray(32) { 0x55 }
    private val encoded = encodeStoreKey(key)

    @Test
    fun `a well-formed link on this app's own origin is read`() {
        val link = parseStoredLink("$origin/d/abc123#k=$encoded", origin)
        assertNotNull(link)
        assertEquals("abc123", link!!.id)
        assertArrayEquals(key, link.key)
    }

    @Test
    fun `surrounding whitespace from a paste is tolerated`() {
        assertNotNull(parseStoredLink("  $origin/d/abc123#k=$encoded\n", origin))
    }

    @Test
    fun `a link on another origin is refused rather than retargeted`() {
        // The id would be fetched from the CONFIGURED backend whatever the link
        // said, so accepting a foreign host would silently point someone else's
        // link at this server — and teach the user that any host works here.
        for (other in listOf(
            "https://evil.example/d/abc123#k=$encoded",
            "http://relayium.com/d/abc123#k=$encoded",
            "https://relayium.com.evil.example/d/abc123#k=$encoded",
            "https://relayium.com:8443/d/abc123#k=$encoded",
        )) {
            assertNull(other, parseStoredLink(other, origin))
        }
    }

    @Test
    fun `a credential-bearing link is refused even on the right host`() {
        assertNull(parseStoredLink("https://user:pass@relayium.com/d/abc123#k=$encoded", origin))
    }

    @Test
    fun `only the exact recipient route is accepted`() {
        for (bad in listOf(
            "$origin/abc123#k=$encoded",
            "$origin/d/abc123/extra#k=$encoded",
            "$origin/d/#k=$encoded",
            "$origin/d/abc123/#k=$encoded",
            "$origin/x/abc123#k=$encoded",
            "$origin/d/abc123?spy=1#k=$encoded",
        )) {
            assertNull(bad, parseStoredLink(bad, origin))
        }
    }

    @Test
    fun `an identifier that is not one is refused`() {
        for (bad in listOf("..", "a%2Fb", "a.b", "a b")) {
            assertNull(bad, parseStoredLink("$origin/d/$bad#k=$encoded", origin))
        }
    }

    @Test
    fun `a link with no usable key is refused before any request could be made`() {
        for (bad in listOf(
            "$origin/d/abc123",
            "$origin/d/abc123#",
            "$origin/d/abc123#k=",
            "$origin/d/abc123#key=$encoded",
            "$origin/d/abc123#k=${encoded.dropLast(1)}",
            "$origin/d/abc123#k=$encoded=",
            "$origin/d/abc123#k=${encoded.dropLast(1)}+",
        )) {
            assertNull(bad, parseStoredLink(bad, origin))
        }
    }

    @Test
    fun `a pasted string is bounded before it is parsed`() {
        assertNull(parseStoredLink("$origin/d/abc123#k=$encoded" + "A".repeat(4096), origin))
    }

    @Test
    fun `a link round-trips through the address the user is shown`() {
        val built = buildDownloadLink(origin, "abc123", encoded)
        assertEquals("$origin/d/abc123#k=$encoded", built)
        assertArrayEquals(key, parseStoredLink(built, origin)!!.key)
    }

    @Test
    fun `an unvalidated identifier cannot become a StoredLink at all`() {
        assertNull(StoredLink.of("../escape", key))
        assertNull(StoredLink.of("abc123", ByteArray(31)))
        assertNotNull(StoredLink.of("abc123", key))
    }

    @Test
    fun `the key never appears in diagnostics`() {
        // This value reaches UI state, coroutine failure text and test output.
        // A synthesised data-class toString would print the key, which IS the
        // file — a disclosure with no attacker required.
        val text = StoredLink.of("abc123", key)!!.toString()
        assertFalse(text.contains(encoded))
        assertFalse(text.contains("85")) // the byte value, however it were rendered
        assertEquals("StoredLink(id=abc123, key=<redacted>)", text)
    }

    @Test
    fun `an upload plan does not print its key or its file names either`() {
        val plan = StoredUploadPlan(
            key = key,
            manifest = com.relayium.protocol.stored.StoredManifest(
                listOf(com.relayium.protocol.stored.ManifestFile("secret-holiday-photo.jpg", 1)),
            ),
            sources = listOf(com.relayium.protocol.stored.BytesSource("secret-holiday-photo.jpg", ByteArray(1))),
            burnAfterRead = false,
            ttlSeconds = 3600,
        )
        val text = plan.toString()
        assertFalse(text.contains(encoded))
        assertFalse(text.contains("secret-holiday-photo"))
    }
}
