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
 * The conversation ledger.
 *
 * The invariant everything turns on is "delete stays deleted". A received row is
 * rebuilt from a journal that deliberately OUTLIVES the user's history — it is
 * what stops a duplicate delivery — so a deletion that only removed the row
 * would be undone by the next reconstruction, and the user would watch dismissed
 * deliveries reappear.
 */
class InboxConversationStoreTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val other = InboxAccountId("9999888877776666555544443333bbbb")

    private fun store(
        forAccount: InboxAccountId = account,
        maxEntries: Int = InboxConversationStore.MAX_ENTRIES,
        maxTombstones: Int = InboxConversationStore.MAX_TOMBSTONES,
    ) = InboxConversationStore(
        File(folder.root, "conversations"), forAccount, secrets, files,
        maxEntries = maxEntries, maxTombstones = maxTombstones,
    )

    private fun received(id: String, at: Long = 1_700_000_100, peer: String = InboxFixtures.OTHER_DEVICE_ID) =
        InboxConversationEntry(
            id = id, peerDeviceId = peer,
            direction = InboxConversationEntry.Direction.RECEIVED,
            kind = InboxConversationEntry.Kind.FILES,
            names = listOf("a.txt"), byteCount = 5, at = at,
            directory = "/received/Delivery",
        )

    private fun now() = 1_700_000_500L

    // ── both directions ─────────────────────────────────────────────────────

    @Test
    fun `both directions are recorded and grouped by peer`() = runBlocking {
        val store = store()
        store.record(received(InboxFixtures.TASK_ID), now())
        store.record(
            InboxConversationEntry(
                id = InboxFixtures.STORED_ID, peerDeviceId = InboxFixtures.OTHER_DEVICE_ID,
                direction = InboxConversationEntry.Direction.SENT,
                kind = InboxConversationEntry.Kind.MESSAGE,
                names = emptyList(), byteCount = 12, at = 1_700_000_200,
                sentState = InboxConversationEntry.SentState.CREATED,
            ),
            now(),
        )
        val conversation = store.conversations().single()
        assertEquals(InboxFixtures.OTHER_DEVICE_ID, conversation.peerDeviceId)
        assertEquals(2, conversation.entries.size)
        assertEquals("newest first", InboxFixtures.STORED_ID, conversation.entries.first().id)
        assertEquals(1, conversation.unreadCount)
    }

    @Test
    fun `a repeat keeps the read mark and the original arrival time`() = runBlocking {
        val store = store()
        store.record(received(InboxFixtures.TASK_ID, at = 1_700_000_100), now())
        store.markRead(setOf(InboxFixtures.TASK_ID), 1_700_000_300)

        // The same receipt, replayed with a later timestamp.
        store.record(received(InboxFixtures.TASK_ID, at = 1_700_009_999), now())
        val entry = store.entries().single()
        assertEquals("a relaunch must not re-date a delivery", 1_700_000_100L, entry.at)
        assertEquals(1_700_000_300L, entry.readAt)
        assertFalse(entry.isUnread)
    }

    /** Exactly what was on screen: an entry that arrived while the screen was
     *  open was never shown, and marking it read would hide it. */
    @Test
    fun `only the observed entries are marked read`() = runBlocking {
        val store = store()
        store.record(received(InboxFixtures.TASK_ID), now())
        store.record(received(InboxFixtures.STORED_ID), now())
        store.markRead(setOf(InboxFixtures.TASK_ID), now())

        val byId = store.entries().associateBy { it.id }
        assertFalse(requireNotNull(byId[InboxFixtures.TASK_ID]).isUnread)
        assertTrue(requireNotNull(byId[InboxFixtures.STORED_ID]).isUnread)
    }

    // ── delete stays deleted ────────────────────────────────────────────────

    /**
     * The central invariant. The receipt that rebuilt this row still exists —
     * it must, because it is what stops a duplicate delivery — so recording it
     * again is exactly what happens on the next refresh.
     */
    @Test
    fun `a deleted entry does not come back when its receipt is replayed`() = runBlocking {
        val store = store()
        store.record(received(InboxFixtures.TASK_ID), now())
        store.delete(setOf(InboxFixtures.TASK_ID), now())
        assertTrue(store.entries().isEmpty())

        val readmitted = store.record(received(InboxFixtures.TASK_ID), now())
        assertFalse("reconstruction must be refused", readmitted)
        assertTrue(store.entries().isEmpty())
        assertTrue(store.isDeleted(InboxFixtures.TASK_ID))
    }

    /** …and across a restart, because the tombstone is durable. */
    @Test
    fun `a tombstone survives a restart`() = runBlocking {
        store().record(received(InboxFixtures.TASK_ID), now())
        store().delete(setOf(InboxFixtures.TASK_ID), now())

        val restarted = store()
        assertFalse(restarted.record(received(InboxFixtures.TASK_ID), now()))
        assertTrue(restarted.entries().isEmpty())
    }

    /**
     * A tombstone never expires, however old the delivery was.
     *
     * Elapsed time is not proof that the source is gone. A journal is pruned
     * only when it is completed AND reported AND the receive engine actually
     * runs a pass — so a device that was offline, had receiving off, or whose
     * `saved` report never landed keeps its journal indefinitely. Send jobs are
     * worse: nothing prunes them at all. An age-expired tombstone would let a
     * receipt far older than any horizon resurrect a row the user deleted.
     */
    @Test
    fun `an old tombstone still refuses an old receipt after a restart`() = runBlocking {
        val ancient = 1_000L
        store().record(received(InboxFixtures.TASK_ID, at = ancient), ancient)
        store().delete(setOf(InboxFixtures.TASK_ID), ancient)

        // Far beyond any plausible retention window, and with unrelated activity
        // in between so the record has been rewritten since.
        val muchLater = ancient + InboxJournalStore.RETENTION_SECONDS * 12
        val restarted = store()
        restarted.record(received(InboxFixtures.STORED_ID, at = muchLater), muchLater)

        assertTrue("the deletion must not expire", restarted.isDeleted(InboxFixtures.TASK_ID))
        assertFalse(
            "an old receipt must still be refused",
            restarted.record(received(InboxFixtures.TASK_ID, at = ancient), muchLater),
        )
        assertTrue(restarted.entries().none { it.id == InboxFixtures.TASK_ID })
    }

    /**
     * An old entry is likewise never dropped for age.
     *
     * The files and the message it describes are still on disk; removing the row
     * would hide a delivery the user never dismissed, which is a disappearing
     * history rather than compaction.
     */
    @Test
    fun `an old entry is not expired out of the history`() = runBlocking {
        val ancient = 1_000L
        val store = store()
        store.record(received(InboxFixtures.TASK_ID, at = ancient), ancient)
        val muchLater = ancient + InboxJournalStore.RETENTION_SECONDS * 12
        store.record(received(InboxFixtures.STORED_ID, at = muchLater), muchLater)

        assertEquals(2, store.entries().size)
        assertNotNull(store.entries().firstOrNull { it.id == InboxFixtures.TASK_ID })
    }

    /**
     * The bound REFUSES rather than dropping a tombstone whose source could
     * still rebuild its row.
     *
     * Silently evicting one would make "delete" stop meaning delete for a caller
     * that was told it had worked — the row would return on the next refresh.
     */
    @Test
    fun `exceeding the tombstone bound fails instead of dropping one`() = runBlocking {
        val store = store(maxTombstones = 2)
        val ids = (1..3).map { "tomb%030d".format(it) }
        for (id in ids.take(2)) {
            store.record(received(id), now())
            store.delete(setOf(id), now())
        }
        store.record(received(ids[2]), now())

        val e = try {
            store.delete(setOf(ids[2]), now())
            null
        } catch (thrown: InboxConversationException) {
            thrown
        }
        assertEquals(InboxConversationReason.FULL, e?.reason)
        // The earlier deletions still hold — nothing was traded away for this
        // one, and the row that could not be deleted is still visible rather
        // than silently gone.
        for (id in ids.take(2)) assertTrue(store.isDeleted(id))
        assertFalse(store.isDeleted(ids[2]))
        assertNotNull(store.entries().firstOrNull { it.id == ids[2] })
    }

    /**
     * The capacity probe, at the real bound: delete one id, then bulk-delete
     * more than the ledger can hold.
     *
     * The second operation may be refused — that is an honest answer — but the
     * FIRST deletion's authority must survive it untouched. Trading an existing
     * tombstone for a new one is what makes "delete" stop meaning delete: the
     * old row returns on the next reconstruction, for a user who was told it was
     * gone and never asked for it back.
     */
    @Test
    fun `a bulk deletion beyond capacity never trades away an existing tombstone`() = runBlocking {
        val store = store()
        val old = InboxFixtures.TASK_ID
        store.record(received(old), now())
        store.delete(setOf(old), now())
        assertTrue(store.isDeleted(old))

        // One call, past the bound.
        val many = (1..InboxConversationStore.MAX_TOMBSTONES + 1)
            .mapTo(LinkedHashSet()) { "bulk%026d".format(it) }
        val e = try {
            store.delete(many, now())
            null
        } catch (thrown: InboxConversationException) {
            thrown
        }
        assertEquals(InboxConversationReason.FULL, e?.reason)

        // The prior authority is intact, in the store and across a restart.
        assertTrue("the earlier deletion must still hold", store.isDeleted(old))
        assertFalse("its receipt must still be refused", store.record(received(old), now()))
        assertTrue(store.entries().none { it.id == old })
        val restarted = store()
        assertTrue(restarted.isDeleted(old))
        assertFalse(restarted.record(received(old), now()))
    }

    /**
     * The entry bound refuses too, rather than evicting.
     *
     * An evicted row whose source still exists would be rebuilt on the next
     * refresh — oscillation, not a limit — and one whose source is gone was
     * still a delivery the user never dismissed.
     */
    @Test
    fun `exceeding the entry bound fails instead of dropping a row`() = runBlocking {
        val store = store(maxEntries = 2)
        store.record(received("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", at = 1_000), 1_000)
        store.record(received("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", at = 1_010), 1_010)

        val e = try {
            store.record(received("cccccccccccccccccccccccccccccccc", at = 1_020), 1_020)
            null
        } catch (thrown: InboxConversationException) {
            thrown
        }
        assertEquals(InboxConversationReason.FULL, e?.reason)
        assertEquals("both existing rows survive", 2, store.entries().size)
    }

    // ── scope and durability ────────────────────────────────────────────────

    /** Deletion is LOCAL: it says nothing to central, and nothing here can
     *  cancel a task or clear an inbox. */
    @Test
    fun `deletion touches only this ledger`() = runBlocking {
        val store = store()
        store.record(received(InboxFixtures.TASK_ID), now())
        store.delete(setOf(InboxFixtures.TASK_ID), now())
        // The store has no transport and no way to reach one: the type takes
        // none. This asserts the shape rather than a behaviour, which is the
        // point — there is no path from here to central.
        assertTrue(store.entries().isEmpty())
    }

    @Test
    fun `one account's history is not readable under another`() = runBlocking {
        store().record(received(InboxFixtures.TASK_ID), now())
        val e = try {
            store(other).entries()
            null
        } catch (thrown: InboxConversationException) {
            thrown
        }
        assertEquals(InboxConversationReason.UNREADABLE, e?.reason)
    }

    @Test
    fun `an altered ledger is refused rather than parsed`() = runBlocking {
        store().record(received(InboxFixtures.TASK_ID), now())
        val file = File(File(folder.root, "conversations"), "conversations.json")
        file.writeBytes(file.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
        val e = try {
            store().entries()
            null
        } catch (thrown: InboxConversationException) {
            thrown
        }
        assertEquals(InboxConversationReason.UNREADABLE, e?.reason)
    }

    /** Names are the user's own content and must not reach a diagnostic. */
    @Test
    fun `an entry redacts its names`() {
        val entry = received(InboxFixtures.TASK_ID).copy(names = listOf("tax-return.pdf"))
        assertFalse(entry.toString().contains("tax-return"))
    }

    @Test
    fun `a sent entry's state can be advanced without disturbing the row`() = runBlocking {
        val store = store()
        val sent = InboxConversationEntry(
            id = InboxFixtures.STORED_ID, peerDeviceId = InboxFixtures.OTHER_DEVICE_ID,
            direction = InboxConversationEntry.Direction.SENT,
            kind = InboxConversationEntry.Kind.FILES,
            names = listOf("a.txt"), byteCount = 5, at = 1_700_000_100,
            sentState = InboxConversationEntry.SentState.STAGED,
        )
        store.record(sent, now())
        store.updateSent(InboxFixtures.STORED_ID, InboxConversationEntry.SentState.SAVED, now())
        val entry = store.entries().single()
        assertEquals(InboxConversationEntry.SentState.SAVED, entry.sentState)
        assertEquals(1_700_000_100L, entry.at)
        assertEquals(listOf("a.txt"), entry.names)
    }

    /** A received row is not a sent one; advancing its state must be a no-op
     *  rather than inventing a sender state for a delivery this device got. */
    @Test
    fun `a received entry has no sent state to advance`() = runBlocking {
        val store = store()
        store.record(received(InboxFixtures.TASK_ID), now())
        store.updateSent(InboxFixtures.TASK_ID, InboxConversationEntry.SentState.SAVED, now())
        assertNull(store.entries().single().sentState)
    }
}
