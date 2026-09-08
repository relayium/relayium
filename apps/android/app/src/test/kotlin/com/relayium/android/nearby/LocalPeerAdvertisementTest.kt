package com.relayium.android.nearby

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The discovery record, against the EXACT rules the shipped Apple parser
 * applies.
 *
 * Every refusal below is one an iOS peer also makes. A record this build
 * accepted and iOS did not — or the reverse — is a device that appears on one
 * platform and is invisible on the other, which is the failure mode a second
 * implementation introduces and nothing else in this repository can see.
 */
class LocalPeerAdvertisementTest {

    private val id = "fc42a167e38d401b915d70642c68de10"

    private fun txt(
        i: String = id,
        n: String = "Pixel 9",
        c: String = "text/1,link/1",
    ) = mapOf("i" to i, "n" to n, "c" to c)

    @Test
    fun `a conforming record round-trips`() {
        val ad = LocalPeerAdvertisement(id, "Pixel 9", listOf("text/1", "link/1"))
        assertEquals(txt(), ad.txtRecord)
        assertEquals(ad, LocalPeerAdvertisement.parse(ad.serviceInstanceName, ad.txtRecord))
    }

    @Test
    fun `a minted identity is exactly what the validator accepts`() {
        repeat(64) {
            val minted = LocalPeerAdvertisement.mintIdentity()
            assertEquals(LocalPeerAdvertisement.IDENTITY_LENGTH, minted.length)
            assertTrue(minted, LocalPeerAdvertisement.isValidIdentity(minted))
        }
    }

    @Test
    fun `identities are lower-case hex of exactly the right length`() {
        assertFalse("upper case", LocalPeerAdvertisement.isValidIdentity(id.uppercase()))
        assertFalse("one short", LocalPeerAdvertisement.isValidIdentity(id.dropLast(1)))
        assertFalse("one long", LocalPeerAdvertisement.isValidIdentity(id + "a"))
        assertFalse("not hex", LocalPeerAdvertisement.isValidIdentity("g" + id.drop(1)))
        assertFalse("empty", LocalPeerAdvertisement.isValidIdentity(""))
    }

    /**
     * The rename refusal, which is what makes a colliding advertisement a
     * FAILURE rather than a quiet half-success: Bonjour renames the instance and
     * leaves the TXT alone, so `i` and the instance name disagree and no peer
     * will read the record.
     */
    @Test
    fun `an instance name that disagrees with the identity is refused whole`() {
        assertNull(LocalPeerAdvertisement.parse("$id (2)", txt()))
        assertNull(LocalPeerAdvertisement.parse(id, txt(i = "0".repeat(32))))
    }

    @Test
    fun `an unknown key makes the whole record incompatible`() {
        assertNull(LocalPeerAdvertisement.parse(id, txt() + ("x" to "1")))
        assertNull(LocalPeerAdvertisement.parse(id, txt() - "c"))
        assertNull(LocalPeerAdvertisement.parse(id, txt() - "n"))
    }

    @Test
    fun `a name must be present and inside the byte bound`() {
        assertNull("empty", LocalPeerAdvertisement.parse(id, txt(n = "")))
        val sixtyFour = "a".repeat(LocalPeerAdvertisement.MAX_NAME_BYTES)
        assertNotNull("exactly the bound", LocalPeerAdvertisement.parse(id, txt(n = sixtyFour)))
        assertNull("one byte over", LocalPeerAdvertisement.parse(id, txt(n = sixtyFour + "a")))
        // BYTES, not characters: 22 CJK characters are 66 UTF-8 bytes.
        assertNull("over in bytes but not in characters",
            LocalPeerAdvertisement.parse(id, txt(n = "中".repeat(22))))
    }

    @Test
    fun `capability lists are bounded, printable, separator-free and duplicate-free`() {
        assertNull("empty field", LocalPeerAdvertisement.parseCapabilities(""))
        assertNull("trailing separator", LocalPeerAdvertisement.parseCapabilities("link/1,"))
        assertNull("doubled separator", LocalPeerAdvertisement.parseCapabilities("link/1,,text/1"))
        assertNull("duplicate", LocalPeerAdvertisement.parseCapabilities("link/1,link/1"))
        assertNull("a space is not printable-ASCII here",
            LocalPeerAdvertisement.parseCapabilities("link/1,a b"))
        assertNull("too many",
            LocalPeerAdvertisement.parseCapabilities((1..9).joinToString(",") { "c$it" }))
        assertNull("token too long",
            LocalPeerAdvertisement.parseCapabilities("x".repeat(LocalPeerAdvertisement.MAX_CAPABILITY_BYTES + 1)))
        assertEquals(
            listOf("text/1", "link/1"),
            LocalPeerAdvertisement.parseCapabilities("text/1,link/1"),
        )
        assertEquals(
            "exactly the bound is fine",
            8,
            LocalPeerAdvertisement.parseCapabilities((1..8).joinToString(",") { "c$it" })?.size,
        )
    }

    /** A capability is compared for EXACT equality wherever it is read, so a
     *  case variant is a different token and never a match. */
    @Test
    fun `capability matching is exact`() {
        val parsed = LocalPeerAdvertisement.parse(id, txt(c = "LINK/1"))
        assertEquals(listOf("LINK/1"), parsed?.capabilities)
        assertFalse(parsed!!.capabilities.contains("link/1"))
    }

    @Test
    fun `a device name too long to advertise is trimmed on a code point boundary`() {
        val long = "中".repeat(40) // 120 UTF-8 bytes
        val trimmed = LocalPeerAdvertisement.sanitizeName(long)
        assertTrue(trimmed.toByteArray(Charsets.UTF_8).size <= LocalPeerAdvertisement.MAX_NAME_BYTES)
        assertEquals("no character was cut in half", trimmed, String(trimmed.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
        assertNotNull("and the result is advertisable", LocalPeerAdvertisement.parse(id, txt(n = trimmed)))
    }

    @Test
    fun `a blank device name becomes something a peer can parse`() {
        assertEquals(LocalPeerAdvertisement.FALLBACK_NAME, LocalPeerAdvertisement.sanitizeName("   "))
        assertNotNull(
            LocalPeerAdvertisement.parse(id, txt(n = LocalPeerAdvertisement.sanitizeName(""))),
        )
    }
}
