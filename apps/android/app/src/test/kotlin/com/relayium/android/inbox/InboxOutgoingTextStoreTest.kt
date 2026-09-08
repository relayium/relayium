package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The sender's own copy of what it wrote.
 *
 * What is asserted here is mostly what the store REFUSES: a second, different
 * text under a job id that already has one, a record moved into another job's or
 * another account's slot, and a body that outlives the row the user deleted.
 */
class InboxOutgoingTextStoreTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val other = InboxAccountId("9999888877776666555544443333bbbb")
    private val jobId = "job00000000000000000000000001"
    private val target = InboxFixtures.OTHER_DEVICE_ID

    private fun store(
        directory: File = folder.root,
        account: InboxAccountId = this.account,
    ) = InboxOutgoingTextStore(directory, account, secrets, files)

    @Test
    fun `a committed message reads back exactly`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "the meeting moved to four", 1_700_000_500)
        val read = store.read(jobId)
        assertEquals("the meeting moved to four", read?.text)
        assertEquals(target, read?.targetDeviceId)
        assertEquals(1_700_000_500L, read?.stagedAt)
    }

    /**
     * The identical repeat is idempotent and keeps the ORIGINAL timestamp.
     *
     * A retried staging, or a repaired crash window, must not re-date the user's
     * own history.
     */
    @Test
    fun `an identical repeat is idempotent and does not re-date`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "same", 1_700_000_500)
        val again = store.commit(jobId, target, "same", 1_700_009_999)
        assertEquals(1_700_000_500L, again.stagedAt)
        assertEquals(1_700_000_500L, store.read(jobId)?.stagedAt)
    }

    /**
     * A job's identity is immutable, so a DIFFERENT text under the same id is
     * refused.
     *
     * The bytes are already sealed into that job's manifest and spool. Replacing
     * the body would leave this history asserting one message while the
     * recipient receives another.
     */
    @Test
    fun `a different text under the same job is refused`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "original", 1_700_000_500)
        val failure = runCatching { store.commit(jobId, target, "rewritten", 1_700_000_600) }
        assertEquals(
            InboxOutgoingTextReason.JOB_IMMUTABLE,
            (failure.exceptionOrNull() as? InboxOutgoingTextException)?.reason,
        )
        assertEquals("original", store.read(jobId)?.text)
    }

    /** The same refusal for a job re-pointed at another device. */
    @Test
    fun `the same job cannot be re-aimed at another device`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "original", 1_700_000_500)
        val failure = runCatching {
            store.commit(jobId, InboxFixtures.DEVICE_ID, "original", 1_700_000_600)
        }
        assertEquals(
            InboxOutgoingTextReason.JOB_IMMUTABLE,
            (failure.exceptionOrNull() as? InboxOutgoingTextException)?.reason,
        )
        assertEquals(target, store.read(jobId)?.targetDeviceId)
    }

    /**
     * A record moved into another job's slot does not open.
     *
     * The label binds the account AND the job exactly as the device's AES-GCM
     * additional data does, so a file renamed on disk fails rather than being
     * presented under the wrong delivery.
     */
    @Test
    fun `a record moved to another job id does not open`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "mine", 1_700_000_500)
        val from = File(folder.root, "$jobId.json")
        val to = File(folder.root, "job00000000000000000000000002.json")
        assertTrue(from.renameTo(to))

        val failure = runCatching { store.read("job00000000000000000000000002") }
        assertEquals(
            InboxOutgoingTextReason.UNREADABLE,
            (failure.exceptionOrNull() as? InboxOutgoingTextException)?.reason,
        )
    }

    /** Another account cannot open this account's record. */
    @Test
    fun `another account cannot open these records`() = runBlocking {
        store().commit(jobId, target, "mine", 1_700_000_500)
        val failure = runCatching { store(account = other).read(jobId) }
        assertEquals(
            InboxOutgoingTextReason.UNREADABLE,
            (failure.exceptionOrNull() as? InboxOutgoingTextException)?.reason,
        )
    }

    /** Deleting removes the body, and a later commit for the same job is a new
     *  record rather than a resurrection of the old one. */
    @Test
    fun `deleting removes the body`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "delete me", 1_700_000_500)
        assertTrue(store.delete(jobId))
        assertNull(store.read(jobId))
        assertFalse("deleting twice is not an error", store.delete(jobId))
    }

    /** An id this store could never have written names no record. */
    @Test
    fun `an unusable job id is refused rather than composing a path`() = runBlocking {
        val store = store()
        val failure = runCatching { store.commit("../escape", target, "x", 1_700_000_500) }
        assertEquals(
            InboxOutgoingTextReason.INVALID_JOB_ID,
            (failure.exceptionOrNull() as? InboxOutgoingTextException)?.reason,
        )
    }

    /** An empty message is not a message, and is refused before anything is
     *  written. */
    @Test
    fun `an empty message is refused`() = runBlocking {
        val store = store()
        val failure = runCatching { store.commit(jobId, target, "", 1_700_000_500) }
        assertEquals(
            InboxOutgoingTextReason.MALFORMED_TEXT,
            (failure.exceptionOrNull() as? InboxOutgoingTextException)?.reason,
        )
        assertNull(store.read(jobId))
    }

    /** One unreadable record does not hide the rest. */
    @Test
    fun `listing skips an unreadable record`() = runBlocking {
        val store = store()
        store.commit(jobId, target, "first", 1_700_000_500)
        store.commit("job00000000000000000000000002", target, "second", 1_700_000_600)
        File(folder.root, "$jobId.json").writeBytes(byteArrayOf(1, 2, 3))

        val all = store.all()
        assertEquals(1, all.size)
        assertEquals("second", all.single().text)
        assertNotNull(store.read("job00000000000000000000000002"))
    }
}
