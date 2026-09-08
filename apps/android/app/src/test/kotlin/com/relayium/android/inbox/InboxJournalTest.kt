package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxManifestKind
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
 * The journal, and the records it must refuse.
 *
 * `isCompleted` is the SOLE basis on which `saved` is reported to central, so
 * every invariant below is ultimately about one question: can a record exist
 * that would make this device claim a delivery that did not happen? The
 * validation runs on the way in as well as the way out — a journal this build
 * would refuse on reload must never reach storage, or the next launch turns a
 * recoverable delivery into an unreadable one.
 */
class InboxJournalTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val taskId = InboxFixtures.TASK_ID

    private val root: File get() = File(folder.root, "received")

    /** The directory this delivery publishes, inside the container. */
    private val taskDirectory: File get() = File(root, "Delivery")

    private fun store(
        directory: File = File(folder.root, "journals"),
        forAccount: InboxAccountId = account,
    ) = InboxJournalStore(directory, forAccount, secrets, files)

    private fun entry(index: Int, name: String, size: Long = 4) =
        InboxPlanEntry(index, name, size, File(taskDirectory, name).path)

    private fun journal(
        vararg plan: InboxPlanEntry,
        kind: InboxManifestKind = InboxManifestKind.FILE,
        committed: List<String> = emptyList(),
        isCompleted: Boolean = false,
        isSavedReported: Boolean = false,
        planRoot: String = root.path,
        directory: String = taskDirectory.path,
        task: String = taskId,
    ) = InboxJournal(
        taskId = task,
        storedFileId = InboxFixtures.STORED_ID,
        targetKeyId = InboxFixtures.KEY_ID,
        senderDeviceId = InboxFixtures.OTHER_DEVICE_ID,
        kind = kind,
        root = planRoot,
        plan = plan.toList(),
        taskDirectory = directory,
        plannedAt = 1_700_000_000,
        committed = committed,
        isCompleted = isCompleted,
        isSavedReported = isSavedReported,
    )

    private fun refused(journal: InboxJournal, why: String) = runBlocking {
        val e = try {
            store().save(journal, 1_700_000_100)
            null
        } catch (thrown: InboxJournalException) {
            thrown
        }
        assertEquals(why, InboxJournalReason.UNREADABLE, e?.reason)
    }

    // ── round trip ──────────────────────────────────────────────────────────

    @Test
    fun `a journal this store wrote reads back exactly`() = runBlocking {
        val saved = store().save(journal(entry(0, "a.txt"), entry(1, "b/c.txt")), 1_700_000_100)
        val loaded = requireNotNull(store().load(taskId))
        assertEquals(saved.plan, loaded.plan)
        assertEquals(InboxManifestKind.FILE, loaded.kind)
        assertEquals(1_700_000_100L, loaded.updatedAt)
        assertFalse(loaded.isCompleted)
    }

    /** Absent is the normal first-delivery case, and the ONLY case that may read
     *  as "this device has never started this task". */
    @Test
    fun `an absent journal is a first delivery`() = runBlocking {
        assertNull(store().load(taskId))
    }

    @Test
    fun `an altered journal is refused rather than parsed`() = runBlocking {
        store().save(journal(entry(0, "a.txt")), 1_700_000_100)
        val file = File(File(folder.root, "journals"), "$taskId.json")
        file.writeBytes(file.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
        val e = try {
            store().load(taskId)
            null
        } catch (thrown: InboxJournalException) {
            thrown
        }
        assertEquals(InboxJournalReason.UNREADABLE, e?.reason)
    }

    /** The label binds the account, so one account's in-flight delivery is not
     *  resumable under the next. */
    @Test
    fun `a journal is not readable under another account`() = runBlocking {
        val directory = File(folder.root, "journals")
        store(directory).save(journal(entry(0, "a.txt")), 1_700_000_100)
        val other = InboxAccountId("9999888877776666555544443333bbbb")
        val e = try {
            store(directory, other).load(taskId)
            null
        } catch (thrown: InboxJournalException) {
            thrown
        }
        assertEquals(InboxJournalReason.UNREADABLE, e?.reason)
    }

    // ── records that must never reach storage ───────────────────────────────

    /**
     * The vacuous-completeness case.
     *
     * `committed.containsAll(plan)` is TRUE for an empty plan, so a file journal
     * with no destinations and `isCompleted` would pass a containment check —
     * and `saved` is reported from nothing but `isCompleted`. The rule is
     * therefore an equality, and an empty file plan is refused outright.
     */
    @Test
    fun `a completed file journal with no plan is refused`() {
        refused(
            journal(isCompleted = true),
            "an empty plan can never be a completed delivery",
        )
        refused(journal(), "a file delivery always names a destination")
    }

    /**
     * Publication is one atomic rename, so a delivery is published entirely or
     * not at all. A record showing some destinations live and others not
     * describes a state this build cannot produce — and `saved` is reported from
     * `isCompleted` alone.
     */
    @Test
    fun `completion is all or nothing`() {
        val a = entry(0, "a.txt")
        val b = entry(1, "b.txt")
        refused(
            journal(a, b, committed = listOf(a.destination), isCompleted = true),
            "completed while one destination is missing",
        )
        refused(
            journal(a, b, committed = listOf(a.destination, b.destination)),
            "every destination committed but not marked completed",
        )
        refused(
            journal(a, b, committed = listOf(a.destination)),
            "a partial commit cannot exist",
        )
    }

    @Test
    fun `a committed destination outside the plan is refused`() {
        refused(
            journal(entry(0, "a.txt"), committed = listOf(File(taskDirectory, "elsewhere.txt").path)),
            "a destination this delivery may not create",
        )
    }

    /**
     * Every destination lives inside the directory this delivery publishes, so a
     * planned path can never name something in the container root that the user
     * might own.
     */
    @Test
    fun `destinations must sit inside this delivery's own directory`() {
        refused(
            journal(InboxPlanEntry(0, "a.txt", 4, File(root, "a.txt").path)),
            "a destination in the container root",
        )
        refused(
            journal(entry(0, "a.txt"), directory = File(folder.root, "elsewhere").path),
            "a published directory outside the container",
        )
    }

    @Test
    fun `a reported save implies a completed commit`() {
        refused(
            journal(entry(0, "a.txt"), isSavedReported = true),
            "saved reported for an unfinished delivery",
        )
    }

    /** Indices are the staged file NAMES: a duplicate makes two entries read one
     *  staged file, a gap reads one that was never written. */
    @Test
    fun `plan indices must be exactly zero to n minus one`() {
        refused(
            journal(entry(1, "a.txt"), entry(0, "b.txt")),
            "out of order indices",
        )
        refused(
            journal(entry(0, "a.txt"), entry(0, "b.txt")),
            "duplicate indices",
        )
        refused(
            journal(entry(0, "a.txt"), entry(2, "b.txt")),
            "a gap in the indices",
        )
    }

    @Test
    fun `duplicate destinations are refused`() {
        refused(
            journal(entry(0, "a.txt"), entry(1, "a.txt")),
            "two entries naming one destination",
        )
    }

    /** A destination outside the root this plan was computed against is one the
     *  delivery may not create, whatever the record says. */
    @Test
    fun `a destination outside the plan root is refused`() {
        val escaping = InboxPlanEntry(0, "a.txt", 4, File(folder.root, "elsewhere/a.txt").path)
        refused(journal(escaping), "a destination outside the received root")
        val traversing = InboxPlanEntry(0, "a.txt", 4, File(root, "../a.txt").path)
        refused(journal(traversing), "a traversing destination")
    }

    /**
     * The confinement bypass this ties shut.
     *
     * Publication and verification address files by NAME —
     * `File(staging, name)`, `File(published, name)` — while ownership was being
     * checked on `destination` alone. A sealed record whose destination looked
     * confined could therefore still carry a name that escapes it, and the
     * record is local state a restore or a tamper can supply.
     */
    @Test
    fun `a plan name that escapes its directory is refused however the destination looks`() {
        for (name in listOf("../escape.txt", "/etc/passwd", "a/../../out.txt", "a\\b.txt")) {
            refused(
                journal(InboxPlanEntry(0, name, 4, File(taskDirectory, "safe.txt").path)),
                "an escaping name behind a confined destination: '$name'",
            )
        }
    }

    /** A name this component owns would be replaced by the receipt at
     *  publication time, corrupting a delivery that verified correctly. */
    @Test
    fun `a plan naming the delivery receipt is refused`() {
        refused(
            journal(
                InboxPlanEntry(
                    0, InboxCommit.RECEIPT_NAME, 4,
                    File(taskDirectory, InboxCommit.RECEIPT_NAME).path,
                ),
            ),
            "a plan entry named like the receipt",
        )
    }

    /** The destination must be exactly what the name resolves to, so the two
     *  cannot describe different files. */
    @Test
    fun `a destination that is not where the name resolves is refused`() {
        refused(
            journal(InboxPlanEntry(0, "a.txt", 4, File(taskDirectory, "b.txt").path)),
            "the name and the destination disagree",
        )
    }

    /** Two entries with one logical name would leave the receipt's digest map
     *  describing only one of them. */
    @Test
    fun `two entries with one logical name are refused`() {
        refused(
            journal(
                InboxPlanEntry(0, "A.txt", 4, File(taskDirectory, "A.txt").path),
                InboxPlanEntry(1, "a.txt", 4, File(taskDirectory, "a.txt").path),
            ),
            "one logical name twice",
        )
    }

    /** `messageBytes` is what a receipt renders, so it must describe a message
     *  this build could actually have committed. */
    @Test
    fun `a message length must be real and belong to a message`() {
        refused(
            journal(entry(0, "a.txt")).copy(messageBytes = 12),
            "a file delivery carrying a message length",
        )
        refused(
            journal(kind = InboxManifestKind.TEXT, directory = "").copy(messageBytes = 12),
            "a message length before the commit wrote one",
        )
        refused(
            journal(
                kind = InboxManifestKind.TEXT, committed = listOf(taskId),
                isCompleted = true, directory = "",
            ).copy(messageBytes = 0),
            "a completed message of no length",
        )
        refused(
            journal(
                kind = InboxManifestKind.TEXT, committed = listOf(taskId),
                isCompleted = true, directory = "",
            ).copy(messageBytes = com.relayium.protocol.inbox.InboxManifest.MAX_TEXT_BYTES + 1),
            "a completed message beyond the protocol bound",
        )
    }

    @Test
    fun `a message journal has no destinations and a file journal is not a message`() {
        refused(
            journal(entry(0, "a.txt"), kind = InboxManifestKind.TEXT, directory = ""),
            "a message with a file plan",
        )
        refused(
            journal(kind = InboxManifestKind.TEXT, isCompleted = true, directory = ""),
            "a completed message that committed nothing",
        )
        refused(
            journal(kind = InboxManifestKind.TEXT, directory = taskDirectory.path),
            "a message publishes no directory",
        )
        // …and the shape a message actually takes is accepted.
        runBlocking {
            val saved = store().save(
                journal(
                    kind = InboxManifestKind.TEXT,
                    committed = listOf(taskId),
                    isCompleted = true,
                    directory = "",
                ).copy(messageBytes = 12),
                1_700_000_100,
            )
            assertTrue(saved.isCompleted)
            assertEquals(12L, requireNotNull(store().load(taskId)).messageBytes)
        }
    }

    // ── recording a commit ──────────────────────────────────────────────────

    @Test
    fun `publication records every destination at once and only once`() = runBlocking {
        val a = entry(0, "a.txt")
        val b = entry(1, "b.txt")
        val store = store()
        store.save(journal(a, b), 1_700_000_100)

        val published = store.recordPublished(taskId, 1_700_000_300)
        assertTrue(published.isCompleted)
        assertEquals(
            listOf(a.destination, b.destination).sorted(),
            published.committed.sorted(),
        )
        assertEquals(1_700_000_300L, published.completedAt)

        // A repeat is a no-op and must not re-date the completion: a result list
        // that re-dated an old delivery on every relaunch would be lying about
        // when the user's files arrived.
        val repeated = store.recordPublished(taskId, 1_700_000_400)
        assertEquals(1_700_000_300L, repeated.completedAt)
    }

    // ── retention ───────────────────────────────────────────────────────────

    /**
     * Retention outlives central's own terminal-row window on purpose: a
     * duplicate delivery attempt for a task this device already saved must still
     * be recognisable from local evidence alone.
     */
    @Test
    fun `only completed reported journals older than the retention window are pruned`() =
        runBlocking {
            val store = store()
            val a = entry(0, "a.txt")
            store.save(
                journal(a, committed = listOf(a.destination), isCompleted = true),
                1_700_000_100,
            )
            store.markSavedReported(taskId, 1_700_000_100)

            val recent = 1_700_000_100L + InboxJournalStore.RETENTION_SECONDS - 1
            store.prune(recent)
            assertNotNull("still inside the window", store.load(taskId))

            val later = 1_700_000_100L + InboxJournalStore.RETENTION_SECONDS + 1
            store.prune(later)
            assertNull(store.load(taskId))
        }

    /** An unfinished journal is the only record of an in-flight destination
     *  plan; pruning it early turns a resumable crash into an ambiguous
     *  directory. */
    @Test
    fun `an unfinished journal is never pruned`() = runBlocking {
        val store = store()
        store.save(journal(entry(0, "a.txt")), 1_700_000_100)
        store.prune(1_700_000_100L + InboxJournalStore.RETENTION_SECONDS * 10)
        assertNotNull(store.load(taskId))
    }

    /** A completed journal whose `saved` never reached central is likewise kept:
     *  it is what the retry replays from. */
    @Test
    fun `a completed but unreported journal is never pruned`() = runBlocking {
        val store = store()
        val a = entry(0, "a.txt")
        store.save(journal(a, committed = listOf(a.destination), isCompleted = true), 1_700_000_100)
        store.prune(1_700_000_100L + InboxJournalStore.RETENTION_SECONDS * 10)
        assertNotNull(store.load(taskId))
    }
}
