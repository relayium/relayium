package com.relayium.android.ingress

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Holding somebody else's document, and letting go of it.
 *
 * A staged share is a lease on data this app does not own, reachable through a
 * grant that can disappear at any moment. So the cases worth writing are the
 * ones where it does disappear — revoked, cancelled, replaced, or dispatched
 * into an account it was never staged for.
 */
class ShareStagingTest {

    /**
     * U+202E RIGHT-TO-LEFT OVERRIDE, built from its code point.
     *
     * Typed literally it would make THIS FILE a Trojan-source vector, visually
     * reordering the code after it — the exact attack the sanitiser under test
     * defends a file list against. `Filename.kt` builds its own set the same
     * way and for the same reason.
     */
    private val rlo = 0x202E.toChar()

    /** A stream that says whether anybody closed it. */
    private class Tracked(bytes: ByteArray = ByteArray(4)) : InputStream() {
        private val inner = ByteArrayInputStream(bytes)
        var closed = false
            private set

        override fun read(): Int = inner.read()
        override fun close() {
            closed = true
            inner.close()
        }
    }

    /** A provider under this test's control. */
    private class FakeAccess : ContentAccess {
        val opened = ArrayList<Tracked>()
        var descriptions: Map<String, ProviderDescription?> = emptyMap()
        var describeThrows = false
        var failWith: Exception? = null

        /** Runs INSIDE `describe`, before the answer is handed back. */
        var duringDescribe: (() -> Unit)? = null

        /** Runs INSIDE `open`, before the stream is handed back. */
        var duringOpen: (() -> Unit)? = null

        override fun describe(uri: IncomingUri): ProviderDescription? {
            if (describeThrows) throw SecurityException("provider says no")
            duringDescribe?.invoke()
            return descriptions[uri.key]
        }

        override fun open(uri: IncomingUri): InputStream {
            failWith?.let { throw it }
            duringOpen?.invoke()
            return Tracked().also { opened += it }
        }
    }

    private val access = FakeAccess()
    private val staging = ShareStaging(access)

    private fun uri(raw: String) = IncomingUri(raw, "content", "media", "media")

    private fun share(vararg raw: String) = AdmittedShare(raw.map(::uri), emptyMap())

    @Test
    fun `staging opens nothing`() {
        staging.stage(share("content://media/1", "content://media/2"), generation = 1)
        // Receiving an intent costs a list of references. A hostile app firing
        // share intents must not be able to make this app read files.
        assertTrue(access.opened.isEmpty())
    }

    @Test
    fun `an item is opened only when it is asked for`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        val stream = staged.open(uri("content://media/1"))
        assertEquals(1, access.opened.size)
        stream.close()
    }

    @Test
    fun `an item that was never staged cannot be opened through a staged share`() {
        // Otherwise this object is an open-anything primitive, and the
        // admission rules apply only to callers that remember them.
        val staged = staging.stage(share("content://media/1"), generation = 1)
        val error = assertThrows(ShareUnavailableException::class.java) {
            staged.open(uri("content://com.relayium.android/files/token"))
        }
        assertEquals(ShareUnavailable.NOT_STAGED, error.reason)
        assertTrue(access.opened.isEmpty())
    }

    @Test
    fun `a revoked grant is a readable refusal, not a crash`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        // What the system actually throws when a grant has lapsed.
        access.failWith = SecurityException("Permission Denial: opening provider")
        val error = assertThrows(ShareUnavailableException::class.java) {
            staged.open(uri("content://media/1"))
        }
        assertEquals(ShareUnavailable.GRANT_LOST, error.reason)
    }

    @Test
    fun `a deleted document and a dead provider are the same event to the reader`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.failWith = IOException("No such file or directory")
        assertEquals(
            ShareUnavailable.GRANT_LOST,
            assertThrows(ShareUnavailableException::class.java) {
                staged.open(uri("content://media/1"))
            }.reason,
        )
    }

    @Test
    fun `cancelling closes every stream that was handed out`() {
        val staged = staging.stage(share("content://media/1", "content://media/2"), generation = 1)
        staged.open(uri("content://media/1"))
        staged.open(uri("content://media/2"))
        assertTrue(access.opened.none { it.closed })

        staging.cancel()

        // In the same call, rather than left to a collector with no deadline.
        assertTrue(access.opened.all { it.closed })
        assertTrue(staged.isReleased)
    }

    @Test
    fun `a cancelled share refuses to open anything more`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        staging.cancel()
        assertEquals(
            ShareUnavailable.RELEASED,
            assertThrows(ShareUnavailableException::class.java) {
                staged.open(uri("content://media/1"))
            }.reason,
        )
        assertTrue(access.opened.isEmpty())
    }

    @Test
    fun `a cancel that lands mid-open leaves no descriptor behind`() {
        // Cancellation comes from the main thread and reads happen on IO, so
        // this race is not hypothetical. The provider call is made outside the
        // lock — it can block — which is exactly the window a release can win.
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.duringOpen = { staged.release() }

        val error = assertThrows(ShareUnavailableException::class.java) {
            staged.open(uri("content://media/1"))
        }
        assertEquals(ShareUnavailable.RELEASED, error.reason)
        // The stream existed by the time release ran, so the opening call is
        // the one that has to close it.
        assertEquals(1, access.opened.size)
        assertTrue(access.opened.single().closed)
    }

    @Test
    fun `replacing a share releases the one it replaced`() {
        val first = staging.stage(share("content://media/1"), generation = 1)
        first.open(uri("content://media/1"))
        val second = staging.stage(share("content://media/2"), generation = 1)

        assertTrue(first.isReleased)
        assertTrue(access.opened.single().closed)
        assertFalse(second.isReleased)
        assertSame(second, staging.current(1))
    }

    @Test
    fun `releasing twice is not an error, because two paths can both be right`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        staged.release()
        staged.release()
        staging.cancel()
        assertTrue(staged.isReleased)
    }

    @Test
    fun `a share staged under another account is not shown to this one`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        assertNull(staging.current(generation = 2))
        // And it is let go rather than merely hidden: nobody will ask for it
        // again, which is exactly when a grant should be dropped.
        assertTrue(staged.isReleased)
        assertNull(staging.current(generation = 1))
    }

    @Test
    fun `a dispatch is fenced by the account it was staged under`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        assertNull(staging.take(staged.id, generation = 2))
        assertTrue(staged.isReleased)
    }

    @Test
    fun `a dispatch is fenced by the share the user was looking at`() {
        val first = staging.stage(share("content://media/1"), generation = 1)
        val second = staging.stage(share("content://media/2"), generation = 1)

        // A tap rendered against the first share, arriving after the second one
        // replaced it, must not send the second.
        assertNull(staging.take(first.id, generation = 1))
        // And the current share is untouched by that stale tap.
        assertFalse(second.isReleased)
        assertSame(second, staging.current(1))
    }

    @Test
    fun `a dispatched share is handed over exactly once`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        assertSame(staged, staging.take(staged.id, generation = 1))
        // A second tap cannot send it again.
        assertNull(staging.take(staged.id, generation = 1))
        assertNull(staging.current(1))
        // Ownership moved: taking does NOT release, because the caller is now
        // reading from it.
        assertFalse(staged.isReleased)
    }

    @Test
    fun `there is nothing to take when nothing is staged`() {
        assertNull(staging.take(1, generation = 1))
        assertNull(staging.current(1))
        staging.cancel()
    }

    // ── provider-supplied metadata ──────────────────────────────────────────

    @Test
    fun `a name that lies about itself is made safe before it is shown`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        // Rendered as "evilexe.png" in every list that draws it.
        val disguised = "evil" + rlo + "gnp.exe"
        access.descriptions = mapOf("content://media/1" to ProviderDescription(disguised, 12))
        val item = staged.describe(uri("content://media/1"))!!
        assertEquals("evilgnp.exe", item.displayName)
        assertEquals(12L, item.size)
    }

    @Test
    fun `a name that could be a path is one name`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.descriptions = mapOf(
            "content://media/1" to ProviderDescription("../../data/data/com.relayium.android/x", 1),
        )
        val name = staged.describe(uri("content://media/1"))!!.displayName
        assertNotNull(name)
        assertFalse(name!!, name.contains('/'))
        assertFalse(name, name.contains('\\'))
    }

    @Test
    fun `control characters cannot hide the rest of a name`() {
        // A newline splits a name across lines in some views and truncates it
        // in others; a NUL ends it in anything that reaches C. Written as
        // escapes, for the reason `rlo` is built from its code point.
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.descriptions = mapOf(
            "content://media/1" to ProviderDescription("holiday.jpg\u0000\n\u0007.exe", 1),
        )
        assertEquals("holiday.jpg.exe", staged.describe(uri("content://media/1"))!!.displayName)
    }

    @Test
    fun `an unusable name is unknown rather than invented`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        val unusable = listOf(
            "", "   ", ".", "..", " " + rlo,
            "x".repeat(SharedItemMetadata.MAX_NAME_BYTES + 1),
        )
        for (raw in unusable) {
            access.descriptions = mapOf("content://media/1" to ProviderDescription(raw, 1))
            assertNull(raw, staged.describe(uri("content://media/1"))!!.displayName)
        }
        access.descriptions = mapOf("content://media/1" to ProviderDescription(null, 1))
        assertNull(staged.describe(uri("content://media/1"))!!.displayName)
    }

    @Test
    fun `a name is refused rather than cut short`() {
        // Truncating UTF-8 is how a name becomes invalid mid-character, and a
        // shortened name is a different claim about the file than the one the
        // provider made.
        val staged = staging.stage(share("content://media/1"), generation = 1)
        val multiByte = "文".repeat(SharedItemMetadata.MAX_NAME_BYTES / 3 + 1)
        access.descriptions = mapOf("content://media/1" to ProviderDescription(multiByte, 1))
        assertNull(staged.describe(uri("content://media/1"))!!.displayName)
    }

    @Test
    fun `an unusable size is unknown, and zero is a size`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        for (raw in listOf(-1L, Long.MIN_VALUE, Long.MAX_VALUE)) {
            access.descriptions = mapOf("content://media/1" to ProviderDescription("a.txt", raw))
            assertNull("$raw", staged.describe(uri("content://media/1"))!!.size)
        }
        // A zero-byte file is a real thing to send and must stay
        // distinguishable from "the provider would not say".
        access.descriptions = mapOf("content://media/1" to ProviderDescription("a.txt", 0))
        assertEquals(0L, staged.describe(uri("content://media/1"))!!.size)
    }

    @Test
    fun `a provider that throws while describing does not take down the list`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.describeThrows = true
        val item = staged.describe(uri("content://media/1"))
        // Still staged, so still something to render — the PROVIDER is what
        // would not answer.
        assertNotNull(item)
        assertNull(item!!.displayName)
        assertNull(item.size)
    }

    @Test
    fun `describing something that is not staged asks the provider nothing`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.describeThrows = true
        // Would throw if it reached the provider.
        assertNull(staged.describe(uri("content://media/999")))
    }

    @Test
    fun `a cancelled share asks the provider nothing more`() {
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.descriptions = mapOf("content://media/1" to ProviderDescription("a.txt", 1))
        access.describeThrows = true
        staging.cancel()
        // Would throw if it reached the provider: a cancelled share reading
        // somebody's documents is this app carrying on after the user stopped
        // it. Null, not an unknown item — there is nothing to render at all.
        assertNull(staged.describe(uri("content://media/1")))
    }

    @Test
    fun `a description that arrives after a cancel does not repopulate anything`() {
        // The provider call is slow and a cancel lands inside it. Without the
        // check on the way OUT, this answer would be rendered on a surface the
        // share is no longer behind.
        val staged = staging.stage(share("content://media/1"), generation = 1)
        access.descriptions = mapOf("content://media/1" to ProviderDescription("secret.pdf", 9))
        access.duringDescribe = { staging.cancel() }
        assertNull(staged.describe(uri("content://media/1")))
    }
}
