package com.relayium.android.integration

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * What this app is willing to hand another app, and for how long.
 *
 * The adversarial cases are the two an independent review named: a revocation
 * interleaving with an open — where "resolve, then open" hands out the previous
 * session's file after the account has changed — and grants from ordinary
 * SUCCESSFUL shares accumulating for the life of the process because nothing
 * ever asks about them again.
 */
class SharedFileGrantsTest {

    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var root: File

    @Before
    fun setUp() {
        root = folder.newFolder("no-backup")
        SharedFileGrants.revokeAll()
        SharedFileGrants.useRoot(root)
    }

    private fun receivedFile(name: String, bytes: Int = 3): File {
        val directory = File(root, "inbox/received").apply { mkdirs() }
        return File(directory, name).apply { writeBytes(ByteArray(bytes)) }
    }

    @Test
    fun `a received file is offered and can be read repeatedly`() {
        val file = receivedFile("photo.jpg")
        val tokens = SharedFileGrants.offer(listOf(file), "a:1", nowMillis = 0L)
        assertEquals(1, tokens.size)

        // Real consumers query, then query again, then open, then re-open after
        // their own recreation. A grant retired on first touch would work in a
        // test and fail in front of a user, mid-attach.
        assertNotNull(SharedFileGrants.resolve(tokens[0], 1_000L))
        assertNotNull(SharedFileGrants.resolve(tokens[0], 2_000L))
        assertEquals("photo.jpg", SharedFileGrants.openGrant(tokens[0], 3_000L) { it.displayName })
        assertEquals("photo.jpg", SharedFileGrants.openGrant(tokens[0], 4_000L) { it.displayName })
    }

    @Test
    fun `the grant reports the name and size and nothing else`() {
        val file = receivedFile("report.pdf", bytes = 11)
        val token = SharedFileGrants.offer(listOf(file), "a:1", 0L).single()
        val grant = SharedFileGrants.resolve(token, 0L)!!
        assertEquals("report.pdf", grant.displayName)
        assertEquals(11L, grant.size)
        // The value reaches a log; the path is the user's own directory names.
        assertFalse(grant.toString(), grant.toString().contains("report.pdf"))
        assertFalse(grant.toString(), grant.toString().contains(root.path))
    }

    @Test
    fun `a file outside the root is never offered`() {
        val outside = folder.newFile("elsewhere.txt")
        assertTrue(SharedFileGrants.offer(listOf(outside), "a:1", 0L).isEmpty())
    }

    @Test
    fun `a sibling directory with the root as a name prefix is not inside it`() {
        // `/tmp/no-backup-evil` must not count as inside `/tmp/no-backup`. The
        // separator is what makes the prefix comparison a containment check.
        val sibling = File(root.parentFile, root.name + "-evil").apply { mkdirs() }
        val trap = File(sibling, "stolen.txt").apply { writeBytes(ByteArray(1)) }
        assertTrue(SharedFileGrants.offer(listOf(trap), "a:1", 0L).isEmpty())
    }

    @Test
    fun `a path that escapes the root through dot dot is never offered`() {
        val outside = folder.newFile("secret.txt")
        val escaping = File(root, "inbox/../../${outside.name}")
        assertTrue(SharedFileGrants.offer(listOf(escaping), "a:1", 0L).isEmpty())
    }

    @Test
    fun `a file that no longer exists is skipped rather than offered`() {
        val file = receivedFile("gone.bin")
        val present = receivedFile("here.bin")
        file.delete()
        // A shorter list is the honest answer for a delivery whose files the
        // user moved or deleted underneath the app.
        assertEquals(1, SharedFileGrants.offer(listOf(file, present), "a:1", 0L).size)
    }

    @Test
    fun `an account change revokes every grant the previous session minted`() {
        val token = SharedFileGrants.offer(listOf(receivedFile("a.txt")), "a:1", 0L).single()
        SharedFileGrants.revokeExcept("b:2")
        assertNull(SharedFileGrants.resolve(token, 1L))
        assertNull(SharedFileGrants.openGrant(token, 1L) { it.displayName })
    }

    @Test
    fun `a re-login as the same account revokes the previous session's grants`() {
        val token = SharedFileGrants.offer(listOf(receivedFile("a.txt")), "a:1", 0L).single()
        // Same id, new generation. The bytes are the same bytes, which is
        // exactly why the check cannot be about the file.
        SharedFileGrants.revokeExcept("a:2")
        assertNull(SharedFileGrants.resolve(token, 1L))
    }

    @Test
    fun `a grant stops resolving when its lifetime runs out`() {
        val token = SharedFileGrants.offer(listOf(receivedFile("a.txt")), "a:1", 0L).single()
        assertNotNull(SharedFileGrants.resolve(token, SharedFileGrants.LIFETIME_MILLIS - 1))
        assertNull(SharedFileGrants.resolve(token, SharedFileGrants.LIFETIME_MILLIS))
        assertNull(SharedFileGrants.openGrant(token, SharedFileGrants.LIFETIME_MILLIS) { it })
    }

    @Test
    fun `grants from ordinary successful shares do not accumulate`() {
        // The failure this closes: a consumer read the file, never came back,
        // and nothing ever resolves that token again. An expiry that only ran
        // when a token happened to be looked up would keep exactly the entries
        // nothing was watching, for the life of the process.
        repeat(20) { index ->
            SharedFileGrants.offer(listOf(receivedFile("old-$index.txt")), "a:1", nowMillis = 0L)
        }
        assertEquals(20, SharedFileGrants.outstanding())

        // A later share, long after those expired. Nothing asked about the old
        // ones — this call is what must retire them.
        val later = SharedFileGrants.LIFETIME_MILLIS + 1
        SharedFileGrants.offer(listOf(receivedFile("new.txt")), "a:1", nowMillis = later)
        assertEquals(1, SharedFileGrants.outstanding())
    }

    @Test
    fun `an expired grant is retired even under the same authority`() {
        val token = SharedFileGrants.offer(listOf(receivedFile("a.txt")), "a:1", 0L).single()
        SharedFileGrants.offer(
            listOf(receivedFile("b.txt")),
            "a:1",
            SharedFileGrants.LIFETIME_MILLIS + 1,
        )
        // Still the same session — the lifetime is what ended this one.
        assertNull(SharedFileGrants.resolve(token, SharedFileGrants.LIFETIME_MILLIS + 1))
        assertEquals(1, SharedFileGrants.outstanding())
    }

    @Test
    fun `a revocation cannot interleave between validating a grant and opening it`() {
        // The adversarial ordering: a revocation runs to completion in the
        // window between the check and the open. With "resolve, then open" the
        // descriptor is still produced — the previous session's file, handed
        // out after the app decided that session was over.
        val token = SharedFileGrants.offer(listOf(receivedFile("a.txt")), "a:1", 0L).single()

        val insideOpen = CountDownLatch(1)
        val revokeReturned = CountDownLatch(1)
        val opened = AtomicBoolean(false)

        val revoker = Thread {
            // Wait until the open callback is genuinely running, then try to
            // revoke from underneath it.
            insideOpen.await(5, TimeUnit.SECONDS)
            SharedFileGrants.revokeExcept("b:2")
            revokeReturned.countDown()
        }
        revoker.start()

        val result = SharedFileGrants.openGrant(token, 1L) { grant ->
            opened.set(true)
            insideOpen.countDown()
            // The revocation is now trying to run. It must NOT be able to
            // complete while this operation holds the registry: an FD created
            // here has already been authorised, and the revocation's job is to
            // stop the NEXT one.
            assertFalse(
                "a revocation completed inside the open operation",
                revokeReturned.await(200, TimeUnit.MILLISECONDS),
            )
            grant.displayName
        }
        revoker.join(5_000)

        assertTrue(opened.get())
        assertEquals("a.txt", result)
        // …and once the operation is over, the revocation takes effect: the
        // next open is refused.
        assertNull(SharedFileGrants.openGrant(token, 2L) { it.displayName })
    }

    @Test
    fun `a revocation that wins the race prevents the open entirely`() {
        val token = SharedFileGrants.offer(listOf(receivedFile("a.txt")), "a:1", 0L).single()
        SharedFileGrants.revokeExcept("b:2")

        val invoked = AtomicBoolean(false)
        val result = SharedFileGrants.openGrant(token, 1L) { invoked.set(true) }
        // Not "opened and then discarded" — never opened. There is no ordering
        // in which a revoked grant produces a descriptor.
        assertFalse(invoked.get())
        assertNull(result)
    }

    @Test
    fun `nothing can be offered before the root is known`() {
        SharedFileGrants.revokeAll()
        val file = receivedFile("a.txt")
        // A registry with no root would accept any file the caller named. The
        // production host sets it at construction; this asserts the fence
        // rather than the ordering.
        SharedFileGrants.useRoot(File(root, "does-not-exist-yet"))
        assertTrue(SharedFileGrants.offer(listOf(file), "a:1", 0L).isEmpty())
    }
}
