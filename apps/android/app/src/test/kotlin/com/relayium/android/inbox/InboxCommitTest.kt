package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxManifestKind
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Publication, and the crash windows it has to converge through.
 *
 * A crash is simulated by performing the steps up to a point and then building a
 * FRESH store and reloading the journal from disk — what a restarted process
 * actually sees. Nothing here relies on in-memory state surviving.
 *
 * Two earlier designs failed here and their failures are kept as regressions:
 *
 *  * hard links, which are denied under the app's own uid on the AOSP 36
 *    emulator this was measured on;
 *  * a durable claim followed by an exclusive create, where a crash between the
 *    claim and the create made the USER'S file look like ours and truncated it,
 *    and where a same-sized file was accepted as a finished delivery.
 *
 * What replaces both: build in staging, prove identity with a sealed receipt and
 * per-file digests, publish with one atomic rename.
 */
class InboxCommitTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val taskId = InboxFixtures.TASK_ID

    private val received: File get() = File(folder.root, "received")
    private val published: File get() = File(received, "Delivery")
    private val staging: File get() = File(folder.root, "staging")

    /** A fresh store over the same directory: what a restarted process sees. */
    private fun journals() =
        InboxJournalStore(File(folder.root, "journals"), account, secrets, files)

    private fun entry(index: Int, name: String, size: Long) =
        InboxPlanEntry(index, name, size, File(published, name).path)

    private fun journal(vararg plan: InboxPlanEntry) = InboxJournal(
        taskId = taskId,
        storedFileId = InboxFixtures.STORED_ID,
        targetKeyId = InboxFixtures.KEY_ID,
        senderDeviceId = InboxFixtures.OTHER_DEVICE_ID,
        kind = InboxManifestKind.FILE,
        root = received.path,
        taskDirectory = published.path,
        plan = plan.toList(),
        plannedAt = 1_700_000_000,
    )

    /** Write the staged tree a verified delivery would have produced, and return
     *  the digests its writer would have computed on the way. */
    private fun stage(vararg contents: Pair<String, String>): Map<String, String> {
        staging.mkdirs()
        return contents.associate { (name, text) ->
            val file = File(staging, name)
            file.parentFile?.mkdirs()
            file.writeText(text)
            name to InboxCommit.digestOf(file)
        }
    }

    private fun now() = 1_700_000_500L

    private fun reload() = runBlocking { requireNotNull(journals().load(taskId)) }

    private suspend fun publish(
        journal: InboxJournal,
        digests: Map<String, String>,
        store: InboxJournalStore = journals(),
    ) = InboxCommit.publish(journal, staging, store, secrets, files, account, digests, ::now)

    // ── the ordinary path ───────────────────────────────────────────────────

    @Test
    fun `a delivery is published as one directory and the journal completes`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5), entry(1, "b/c.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha", "b/c.txt" to "bravo")

        val done = publish(plan, digests, store)
        assertTrue(done.isCompleted)
        assertEquals("alpha", File(published, "a.txt").readText())
        assertEquals("bravo", File(published, "b/c.txt").readText())
        // Publication is atomic, so it is all destinations or none.
        assertEquals(2, done.committed.size)
        assertFalse("staging is gone once it becomes the published directory", staging.exists())
        // The container root holds exactly this delivery's directory.
        assertEquals(listOf("Delivery"), received.list().orEmpty().toList())
    }

    @Test
    fun `nothing is visible in the container before the rename`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        stage("a.txt" to "alpha")
        // Before publish, the delivery exists only in staging.
        assertFalse(received.exists())
        assertFalse(reload().isCompleted)
    }

    // ── the crash windows ───────────────────────────────────────────────────

    /**
     * A crash before the rename leaves only staging.
     *
     * It is discarded and re-downloaded: no plaintext partial is trusted after a
     * crash, and nothing was ever visible to the user.
     */
    @Test
    fun `a crash before publication leaves the container untouched`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        stage("a.txt" to "alp")            // torn staging write

        InboxCommit.prepareStaging(staging, files)
        assertEquals(0, staging.list().orEmpty().size)
        assertFalse(received.exists())
        assertFalse(reload().isCompleted)

        // The re-download completes normally.
        val digests = stage("a.txt" to "alpha")
        assertTrue(publish(reload(), digests).isCompleted)
        assertEquals("alpha", File(published, "a.txt").readText())
    }

    /**
     * A crash between the rename and the journal write: the directory is
     * published but the record does not say so.
     *
     * The next run proves the directory is ours — sealed receipt, matching
     * identity, matching digests — and records it WITHOUT re-delivering.
     */
    @Test
    fun `a published directory whose record was lost is recognised, not redelivered`() =
        runBlocking {
            val store = journals()
            val plan = journal(entry(0, "a.txt", 5))
            store.save(plan, now())
            val digests = stage("a.txt" to "alpha")
            publish(plan, digests, store)

            // Roll the journal back to the pre-record state, as a crash would.
            val rolledBack = plan.copy(committed = emptyList(), isCompleted = false)
            journals().save(rolledBack, now())
            assertFalse(reload().isCompleted)

            val done = publish(reload(), emptyMap())
            assertTrue(done.isCompleted)
            assertEquals("alpha", File(published, "a.txt").readText())
            assertEquals(listOf("Delivery"), received.list().orEmpty().toList())
        }

    /** Publishing again once the record says completed is a no-op. */
    @Test
    fun `publishing a completed journal does nothing`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        val done = publish(plan, digests, store)
        assertEquals(done, publish(done, emptyMap()))
    }

    // ── ownership is proved, never inferred ─────────────────────────────────

    /**
     * REGRESSION for the claim design: a directory at the published name that
     * this delivery cannot prove is its own must never be touched.
     *
     * The claim design would have truncated the user's file here, because it
     * read "we recorded an intent to create this" as "we created this".
     */
    @Test
    fun `a directory this delivery cannot prove is its own is never overwritten`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "keepme.txt", 6))
        store.save(plan, now())
        val digests = stage("keepme.txt" to "alpha!")
        published.mkdirs()
        File(published, "keepme.txt").writeText("theirs")

        val e = try {
            publish(plan, digests, store)
            null
        } catch (thrown: InboxCommitException) {
            thrown
        }
        assertEquals(InboxCommitException.Reason.NAME_CONFLICT, e?.reason)
        assertEquals("the user's bytes are untouched", "theirs", File(published, "keepme.txt").readText())
        assertFalse(reload().isCompleted)
        assertTrue("the verified staged bytes are kept", File(staging, "keepme.txt").exists())
    }

    /**
     * REGRESSION for the claim design's second defect: a same-SIZED file is not
     * a delivered one.
     *
     * The old reconcile accepted length alone and marked the task saved, which
     * both reported a delivery that never happened and discarded the verified
     * staged bytes that would have made it real.
     */
    @Test
    fun `a same-sized wrong file is not accepted as a delivery`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        published.mkdirs()
        File(published, "a.txt").writeText("WRONG")     // same length, different bytes

        assertFalse(
            InboxCommit.verifyPublished(published, plan, secrets, account),
        )
        val e = try {
            publish(plan, digests, store)
            null
        } catch (thrown: InboxCommitException) {
            thrown
        }
        assertEquals(InboxCommitException.Reason.NAME_CONFLICT, e?.reason)
        assertEquals("WRONG", File(published, "a.txt").readText())
        assertFalse(reload().isCompleted)
        assertTrue("the verified staged bytes are kept", File(staging, "a.txt").exists())
    }

    /** A receipt sealed for a DIFFERENT account does not open here, so a restored
     *  directory from another account cannot be adopted. */
    @Test
    fun `a receipt from another account does not prove ownership`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        publish(plan, digests, store)

        val other = InboxAccountId("9999888877776666555544443333bbbb")
        assertFalse(InboxCommit.verifyPublished(published, plan, secrets, other))
    }

    /** …and a receipt whose identity fields name another delivery is likewise
     *  not proof, even under the right account. */
    @Test
    fun `a receipt naming another delivery does not prove ownership`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        publish(plan, digests, store)

        val impostor = plan.copy(storedFileId = InboxFixtures.OTHER_DEVICE_ID)
        assertFalse(InboxCommit.verifyPublished(published, impostor, secrets, account))
    }

    /** A published directory missing its receipt entirely is not ours. */
    @Test
    fun `a directory with no receipt is not ours`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        publish(plan, digests, store)
        assertTrue(File(published, InboxCommit.RECEIPT_NAME).delete())

        assertFalse(InboxCommit.verifyPublished(published, plan, secrets, account))
    }

    /** A file added to a published directory afterwards breaks the proof, so a
     *  tampered directory is never re-adopted as a completed delivery. */
    @Test
    fun `a tampered published directory is not ours`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        publish(plan, digests, store)
        File(published, "a.txt").writeText("edited")

        assertFalse(InboxCommit.verifyPublished(published, plan, secrets, account))
    }

    // ── durability on every path to a saved report ──────────────────────────

    /**
     * A previous attempt renamed the directory into place and then died before
     * its container fsync.
     *
     * The retry finds a directory that verifies — and must NOT record `saved`
     * on the strength of that alone: the entry naming it may still be only in
     * the page cache, so a crash now would lose a delivery this device had
     * already reported. Durability is therefore re-established on the recovery
     * path too, before the record.
     */
    @Test
    fun `a retry after a failed container fsync re-syncs before recording`() = runBlocking {
        val barriers = SyncFailingDurableFiles(files)
        val store = InboxJournalStore(File(folder.root, "journals"), account, secrets, barriers)
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")

        // The first attempt: rename lands, the container sync refuses.
        received.mkdirs()
        barriers.failSyncs.add(received.absolutePath)
        val failed = try {
            InboxCommit.publish(plan, staging, store, secrets, barriers, account, digests, ::now)
            null
        } catch (e: InboxCommitException) {
            e
        }
        assertNotNull("the first attempt must fail loudly", failed)
        assertTrue("the rename itself landed", published.isDirectory)
        assertFalse("nothing may be recorded", reload().isCompleted)

        // The retry, with the barrier working again.
        barriers.failSyncs.clear()
        barriers.syncedDirectories.clear()
        val done = InboxCommit.publish(
            reload(), staging, store, secrets, barriers, account, emptyMap(), ::now,
        )
        assertTrue(done.isCompleted)
        assertTrue(
            "the container entry must be made durable before the record",
            barriers.syncedDirectories.contains(received.absolutePath),
        )
        assertTrue(barriers.syncedDirectories.contains(published.absolutePath))
    }

    /**
     * A rename mutates TWO directories: the destination gains an entry and the
     * SOURCE parent loses one.
     *
     * Leaving the source side unsynced means a crash can resurrect a staging
     * entry for a delivery already reported as saved — so a refusal there must
     * stop the record, exactly as the destination side does.
     */
    @Test
    fun `a failed source-parent sync stops the record until a retry succeeds`() = runBlocking {
        val barriers = SyncFailingDurableFiles(files)
        val store = InboxJournalStore(File(folder.root, "journals"), account, secrets, barriers)
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val digests = stage("a.txt" to "alpha")
        val sourceParent = requireNotNull(staging.parentFile)

        barriers.failSyncs.add(sourceParent.absolutePath)
        val failed = try {
            InboxCommit.publish(plan, staging, store, secrets, barriers, account, digests, ::now)
            null
        } catch (e: InboxCommitException) {
            e
        }
        assertNotNull("the source-parent sync must not be skipped", failed)
        assertFalse("nothing may be recorded", reload().isCompleted)

        barriers.failSyncs.clear()
        barriers.syncedDirectories.clear()
        val done = InboxCommit.publish(
            reload(), staging, store, secrets, barriers, account, emptyMap(), ::now,
        )
        assertTrue(done.isCompleted)
        assertTrue(
            "the source parent is synced on the recovery path too",
            barriers.syncedDirectories.contains(sourceParent.absolutePath),
        )
        assertEquals("alpha", File(published, "a.txt").readText())
    }

    /** Every directory the rename touched is made durable before the record. */
    @Test
    fun `publication syncs the published directory and both parents`() = runBlocking {
        val barriers = SyncFailingDurableFiles(files)
        val store = InboxJournalStore(File(folder.root, "journals"), account, secrets, barriers)
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        val sourceParent = requireNotNull(staging.parentFile)
        val digests = stage("a.txt" to "alpha")
        barriers.syncedDirectories.clear()

        InboxCommit.publish(plan, staging, store, secrets, barriers, account, digests, ::now)
        assertTrue(barriers.syncedDirectories.contains(published.absolutePath))
        assertTrue(barriers.syncedDirectories.contains(received.absolutePath))
        assertTrue(barriers.syncedDirectories.contains(sourceParent.absolutePath))
    }

    // ── rename is not no-overwrite ──────────────────────────────────────────

    /**
     * `rename(2)` silently REPLACES an empty directory at the destination.
     *
     * So an empty foreign directory at the published name must be refused
     * explicitly rather than left to the rename, which would delete it and
     * publish over it.
     */
    @Test
    fun `an empty foreign directory at the published name is refused, not replaced`() =
        runBlocking {
            val store = journals()
            val plan = journal(entry(0, "a.txt", 5))
            store.save(plan, now())
            val digests = stage("a.txt" to "alpha")
            published.mkdirs()          // empty, and not ours

            val e = try {
                publish(plan, digests, store)
                null
            } catch (thrown: InboxCommitException) {
                thrown
            }
            assertEquals(InboxCommitException.Reason.NAME_CONFLICT, e?.reason)
            assertTrue("the foreign directory survives", published.isDirectory)
            assertEquals(0, published.list().orEmpty().size)
            assertTrue("the verified staged bytes are kept", File(staging, "a.txt").exists())
            assertFalse(reload().isCompleted)
        }

    // ── the receipt itself ──────────────────────────────────────────────────

    @Test
    fun `publication refuses to proceed without a digest for every planned file`() =
        runBlocking {
            val store = journals()
            val plan = journal(entry(0, "a.txt", 5), entry(1, "b.txt", 5))
            store.save(plan, now())
            val digests = stage("a.txt" to "alpha", "b.txt" to "bravo")

            val e = try {
                publish(plan, digests - "b.txt", store)
                null
            } catch (thrown: InboxCommitException) {
                thrown
            }
            assertEquals(InboxCommitException.Reason.STORAGE, e?.reason)
            assertFalse("nothing may be published", received.exists())
        }

    /**
     * The receipt is sealed under a label binding THIS account and THIS task.
     *
     * Asserted through the seam rather than by inspecting the bytes: the test
     * double does not encrypt, so a byte-level check would prove a property of
     * the fake instead of one of the design. What matters here is the binding —
     * a receipt lifted into another account's or another task's directory does
     * not open, which is what stops one delivery's proof from vouching for
     * another.
     */
    @Test
    fun `the receipt opens only under this account and this task`() = runBlocking {
        val store = journals()
        val plan = journal(entry(0, "a.txt", 5))
        store.save(plan, now())
        publish(plan, stage("a.txt" to "alpha"), store)
        val sealed = File(published, InboxCommit.RECEIPT_NAME).readBytes()

        assertNotNull(
            secrets.open("relayium/inbox/delivery/${account.value}/$taskId", sealed),
        )
        for (wrong in listOf(
            "relayium/inbox/delivery/${account.value}/${InboxFixtures.STORED_ID}",
            "relayium/inbox/delivery/9999888877776666555544443333bbbb/$taskId",
            "relayium/inbox/journal/${account.value}/$taskId",
        )) {
            val opened = try {
                secrets.open(wrong, sealed)
                true
            } catch (_: com.relayium.android.cloud.SecretBoxException) {
                false
            }
            assertFalse("opened under '$wrong'", opened)
        }
    }

    // ── staging hygiene ─────────────────────────────────────────────────────

    @Test
    fun `preparing staging discards an earlier attempt's bytes`() = runBlocking {
        stage("a.txt" to "unverified leftovers")
        File(staging, "nested").mkdirs()
        File(staging, "nested/deep").writeText("also stale")

        InboxCommit.prepareStaging(staging, files)
        assertTrue(staging.isDirectory)
        assertEquals(0, staging.list().orEmpty().size)
    }

    @Test
    fun `cleaning staging removes the whole tree`() = runBlocking {
        stage("a.txt" to "x")
        File(staging, "a/b").mkdirs()
        InboxCommit.cleanStaging(staging)
        assertFalse(staging.exists())
    }
}
