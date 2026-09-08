package com.relayium.android.ingress

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What another app is allowed to make this one hold a reference to.
 *
 * Everything here is an intent a hostile app can send today: the action is
 * public, the extras are its own, and the only thing standing between a crafted
 * URI and this app's own storage is this file.
 */
class ShareAdmissionTest {

    /** What the debug build actually declares, plus its package. */
    private val own = setOf("com.relayium.android.debug", "com.relayium.android.debug.testdocs")

    private fun uri(
        raw: String,
        scheme: String? = "content",
        authority: String? = "media",
        encodedAuthority: String? = authority,
    ) = IncomingUri(raw, scheme, authority, encodedAuthority)

    private fun admit(vararg uris: IncomingUri, granted: Boolean = true) =
        ShareAdmission.admit(uris.toList(), granted, own)

    private fun admitted(vararg uris: IncomingUri): AdmittedShare {
        val outcome = ShareAdmission.admit(uris.toList(), true, own)
        assertTrue("expected admitted, got $outcome", outcome is IngressOutcome.Accepted)
        return ((outcome as IngressOutcome.Accepted).request as IngressRequest.StageFiles).share
    }

    private fun refused(outcome: IngressOutcome): IngressRefusal {
        assertTrue("expected refused, got $outcome", outcome is IngressOutcome.Refused)
        return (outcome as IngressOutcome.Refused).reason
    }

    @Test
    fun `granted content uris are kept, in the order the sender named them`() {
        val share = admitted(
            uri("content://media/external/images/1"),
            uri("content://media/external/images/2"),
        )
        assertEquals(2, share.items.size)
        assertEquals("content://media/external/images/1", share.items[0].key)
        assertTrue(share.skipped.isEmpty())
    }

    @Test
    fun `nothing is admitted without a read grant`() {
        // The flag is how the sender says "you may read this". Without it, the
        // only URIs that would still open are providers left readable to
        // everyone — access that came from a misconfiguration rather than from
        // the user.
        val outcome = admit(uri("content://media/external/images/1"), granted = false)
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
    }

    @Test
    fun `a file uri is refused, whatever it points at`() {
        // No grant and no owner: it is a path evaluated with THIS app's
        // identity, so a sender could name this app's own private files.
        for (path in listOf(
            "file:///data/data/com.relayium.android/files/token",
            "file:///sdcard/Download/holiday.jpg",
            "file:///proc/self/environ",
        )) {
            val outcome = admit(uri(path, scheme = "file", authority = ""))
            assertEquals(path, IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
        }
    }

    @Test
    fun `schemes that are not content are refused`() {
        for (scheme in listOf("http", "https", "android.resource", "ftp", "javascript", null)) {
            val outcome = admit(uri("$scheme://whatever/1", scheme = scheme))
            assertEquals("$scheme", IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
        }
    }

    @Test
    fun `a uri naming this app's own provider is refused`() {
        // Resolved under this app's own uid, where a grant is not consulted at
        // all: a stranger's intent, this app's rights, this app's private data.
        val outcome = admit(
            uri("content://com.relayium.android.debug.testdocs/document/secret",
                authority = "com.relayium.android.debug.testdocs"),
        )
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
    }

    @Test
    fun `a user-qualified authority cannot smuggle this app's own provider back in`() {
        // `getAuthorityWithoutUserId` strips through the LAST `@` before the
        // provider is looked up, so this string is not equal to the authority
        // it resolves to. A comparison on the raw authority alone reads
        // "0@com.relayium.android.debug.testdocs", finds no match, and admits a
        // URI that routes straight back into this app's own provider.
        for (authority in listOf(
            "0@com.relayium.android.debug.testdocs",
            "10@com.relayium.android.debug.testdocs",
            "0@com.relayium.android.debug",
            "media@com.relayium.android.debug.testdocs",
            "0@media@com.relayium.android.debug.testdocs",
        )) {
            val outcome = admit(uri("content://$authority/document/secret", authority = authority))
            assertEquals(authority, IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
        }
    }

    @Test
    fun `a percent-escaped user prefix is refused in whichever spelling carries it`() {
        // `Uri.getAuthority()` resolves escapes and `getEncodedAuthority()`
        // does not, so the two can disagree about whether an `@` is present.
        // Both are checked rather than this file having an opinion about which
        // one the framework routes on.
        val outcome = admit(
            uri(
                "content://0%40com.relayium.android.debug.testdocs/document/secret",
                authority = "0@com.relayium.android.debug.testdocs",
                encodedAuthority = "0%40com.relayium.android.debug.testdocs",
            ),
        )
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
    }

    @Test
    fun `a user-qualified authority is refused even when it is not this app's`() {
        // Another user's provider is not this app's business either, and it has
        // no permission that would let it read one.
        val outcome = admit(uri("content://0@media/external/images/1", authority = "0@media"))
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
    }

    @Test
    fun `case is not a way past the own-provider rule`() {
        val outcome = admit(
            uri("content://COM.Relayium.Android.Debug.TestDocs/document/secret",
                authority = "COM.Relayium.Android.Debug.TestDocs"),
        )
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
    }

    @Test
    fun `the package namespace is refused as a whole label, and no further`() {
        // Anything under this app's package name is refused whether or not the
        // declared set has caught up with the manifest...
        val inside = admit(
            uri("content://com.relayium.android.debug.newprovider/1",
                authority = "com.relayium.android.debug.newprovider"),
        )
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(inside))
        // ...and a different package that merely starts with the same letters
        // belongs to somebody else and is admitted.
        val outside = admitted(
            uri("content://com.relayium.androidx.other/1", authority = "com.relayium.androidx.other"),
        )
        assertEquals(1, outside.items.size)
    }

    @Test
    fun `a uri with no authority names no provider`() {
        val outcome = admit(uri("content:///document/1", authority = "", encodedAuthority = ""))
        assertEquals(IngressRefusal.NOTHING_SHAREABLE, refused(outcome))
    }

    @Test
    fun `the same item named twice is sent once, and the drop is counted`() {
        // EXTRA_STREAM and ClipData describe the same items on many senders,
        // which is exactly how a file gets sent — and charged — twice.
        val share = admitted(
            uri("content://media/external/images/1"),
            uri("content://media/external/images/1"),
            uri("content://media/external/images/2"),
            uri("content://media/external/images/1"),
        )
        assertEquals(2, share.items.size)
        assertEquals(2, share.skipped[ShareItemRefusal.DUPLICATE])
    }

    @Test
    fun `a share larger than one batch is refused rather than truncated`() {
        // Silently sending 1000 of 1500 files is the failure that is discovered
        // after the transfer, by the person who needed the other 500.
        val many = (0..ShareAdmission.MAX_ITEMS).map { uri("content://media/external/images/$it") }
        val outcome = ShareAdmission.admit(many, true, own)
        assertEquals(IngressRefusal.TOO_MANY_ITEMS, refused(outcome))
    }

    @Test
    fun `a share of exactly one batch is admitted`() {
        val many = (1..ShareAdmission.MAX_ITEMS).map { uri("content://media/external/images/$it") }
        val outcome = ShareAdmission.admit(many, true, own)
        assertTrue(outcome is IngressOutcome.Accepted)
    }

    @Test
    fun `a mixed share keeps what it can and counts what it dropped by reason`() {
        val share = admitted(
            uri("content://media/external/images/1"),
            uri("file:///sdcard/x.jpg", scheme = "file", authority = ""),
            uri("content://com.relayium.android.debug.testdocs/1",
                authority = "com.relayium.android.debug.testdocs"),
            uri("content://0@media/2", authority = "0@media"),
            uri("content://media/external/images/1"),
            uri("content://media/external/images/3"),
        )
        assertEquals(2, share.items.size)
        assertEquals(1, share.skipped[ShareItemRefusal.UNSUPPORTED_SCHEME])
        assertEquals(1, share.skipped[ShareItemRefusal.OWN_PROVIDER])
        assertEquals(1, share.skipped[ShareItemRefusal.USER_QUALIFIED_AUTHORITY])
        assertEquals(1, share.skipped[ShareItemRefusal.DUPLICATE])
    }

    @Test
    fun `an empty share is empty rather than nothing-shareable`() {
        assertEquals(IngressRefusal.EMPTY, refused(ShareAdmission.admit(emptyList(), true, own)))
    }

    @Test
    fun `a redacted uri says nothing about itself`() {
        // This value reaches exception text and crash reports, and every field
        // in it is a string the sender chose.
        val printed = uri("content://media/external/images/1").toString()
        assertTrue(printed, !printed.contains("media"))
        assertTrue(printed, !printed.contains("content"))
    }
}
