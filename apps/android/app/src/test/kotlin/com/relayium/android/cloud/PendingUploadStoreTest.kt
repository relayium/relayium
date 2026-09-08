package com.relayium.android.cloud

import com.relayium.protocol.Json
import com.relayium.protocol.stored.STORE_KEY_BYTES
import java.io.File
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The durable half of a recoverable upload: what survives a process death, what
 * is refused, and what is never deleted.
 *
 * Every case drives the production [PendingUploadStore] against a real temporary
 * directory. The two injected seams are the sealing box and the write barriers,
 * and both exist to make a NAMED failure happen — an invalidated key, a plan
 * write that does not land — rather than to skip anything. The platform
 * barriers are the default everywhere else and are exercised on the device.
 */
class PendingUploadStoreTest {

    private val root = File(System.getProperty("java.io.tmpdir"), "pending-${System.nanoTime()}")
    private val box = FakeSecretBox()
    private val barriers = ScriptedDurableFiles()
    private val account = "account0000000000000000000000000"
    private val key = ByteArray(STORE_KEY_BYTES) { it.toByte() }

    private fun store() = PendingUploadStore(root, box, barriers)

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    private fun stage(
        store: PendingUploadStore = store(),
        owner: String = account,
        payload: ByteArray = ByteArray(64) { it.toByte() },
    ): PendingUploadPlan {
        val staging = store.begin()
        staging.writeHeader(byteArrayOf(0, 0, 0, 2, 7, 7))
        staging.appendPayload(payload)
        return staging.commit(
            accountId = owner,
            files = listOf(PendingUploadFile("a.bin", payload.size.toLong())),
            burnAfterRead = false,
            ttlSeconds = 3600,
            createdAt = 1_700_000_000,
            key = key,
        )
    }

    @Test
    fun `the plan is written last, so a staging that dies part-way is not a job`() {
        val store = store()
        val staging = store.begin()
        staging.writeHeader(byteArrayOf(0, 0, 0, 1, 9))
        staging.appendPayload(ByteArray(8))
        staging.close()   // the process ended here: bytes, no plan

        assertNull(store.pending(account))
        // Read by a FRESH store, because that is what the next launch does.
        assertEquals(0, PendingUploadStore(root, box, barriers).sweep().unreadable)
        assertEquals(0, root.listFiles()?.size ?: 0)
    }

    @Test
    fun `the content key lands before the plan, so a plan on disk always has one`() {
        barriers.writes.clear()
        stage()
        val order = barriers.writes.toList()
        assertTrue("saw $order", order.indexOf("key.bin") < order.indexOf("plan.bin"))
    }

    @Test
    fun `a plan that could not be written leaves no resumable job`() {
        val store = store()
        barriers.failWrites.add("plan.bin")
        val staging = store.begin()
        staging.writeHeader(byteArrayOf(0, 0, 0, 1, 9))
        staging.appendPayload(ByteArray(8))
        val failed = runCatching {
            staging.commit(account, listOf(PendingUploadFile("a", 8)), false, 3600, 1, key)
        }
        assertTrue(failed.isFailure)
        // The key is on disk and the plan is not. Nothing may present that as an
        // upload the user can continue.
        assertNull(store.pending(account))
    }

    @Test
    fun `a sealed record does not open in another job's slot`() {
        val store = store()
        val first = stage(store)
        val second = stage(store)
        val donor = File(File(root, first.jobId), PendingUploadStore.KEY)
        val victim = File(File(root, second.jobId), PendingUploadStore.KEY)
        donor.copyTo(victim, overwrite = true)

        // Not "no key here" — a stated failure, because the two need different
        // answers and adopting the record would hand this job another's key.
        val failure = runCatching { store.key(second) }.exceptionOrNull()
        assertTrue(failure is PendingUploadException)
        assertEquals(
            PendingUploadException.Reason.PROTECTION,
            (failure as PendingUploadException).reason,
        )
    }

    @Test
    fun `one account never sees another's staged job`() {
        val store = store()
        stage(store, owner = "other0000000000000000000000000000")
        assertNull(store.pending(account))
        assertNotNull(store.pending("other0000000000000000000000000000"))
    }

    @Test
    fun `a finalized job survives the sweep until its key is filed`() {
        val store = store()
        var plan = stage(store)
        plan = store.markFinalizeAttempted(plan)
        plan = store.markFinalized(plan, "obj00000000000000000000000000000", 1_800_000_000)

        // The next launch: the object exists on the server and its key exists
        // only here, so sweeping it would strand paid storage forever.
        assertEquals(0, PendingUploadStore(root, box, barriers).sweep().unreadable)
        val recovered = PendingUploadStore(root, box, barriers).pending(account)
        assertNotNull(recovered)
        assertEquals("obj00000000000000000000000000000", recovered!!.finalizedStoredId)
        assertArrayEquals(key, PendingUploadStore(root, box, barriers).key(recovered))

        // Once filed, it is leftovers.
        PendingUploadStore(root, box, barriers).markLinkKeyCommitted(recovered)
        PendingUploadStore(root, box, barriers).sweep()
        assertNull(PendingUploadStore(root, box, barriers).pending(account))
    }

    @Test
    fun `the finalize attempt marker survives a process death`() {
        val store = store()
        val plan = stage(store)
        store.markFinalizeAttempted(plan)

        val next = PendingUploadStore(root, box, barriers).pending(account)
        assertNotNull(next)
        assertTrue(next!!.finalizeAttempted)
        assertNull(next.finalizedStoredId)
    }

    @Test
    fun `a truncated spool stays discoverable and is refused before it is sent`() {
        val store = store()
        val plan = stage(store)
        val spool = File(File(root, plan.jobId), PendingUploadStore.SPOOL)
        spool.writeBytes(ByteArray(8))

        // Still offered — hiding it would leave bytes nothing could name or
        // remove — but the length says it cannot be continued...
        val found = PendingUploadStore(root, box, barriers).pending(account)
        assertNotNull(found)
        assertTrue(store.spoolLength(found!!) != found.payloadTotal)
        // ...and the identity check refuses rather than restaging.
        val failure = runCatching { store.verifySpool(found) }.exceptionOrNull()
        assertEquals(
            PendingUploadException.Reason.SPOOL_INVALID,
            (failure as PendingUploadException).reason,
        )
    }

    @Test
    fun `a spool altered in place is refused even at the right length`() {
        val store = store()
        val plan = stage(store)
        val spool = File(File(root, plan.jobId), PendingUploadStore.SPOOL)
        val bytes = spool.readBytes()
        bytes[7] = (bytes[7].toInt() xor 0xff).toByte()
        spool.writeBytes(bytes)

        assertEquals(plan.payloadTotal, store.spoolLength(plan))
        val failure = runCatching { store.verifySpool(plan) }.exceptionOrNull()
        assertEquals(
            PendingUploadException.Reason.SPOOL_INVALID,
            (failure as PendingUploadException).reason,
        )
    }

    @Test
    fun `a replay may not ask for bytes outside the staged stream`() {
        val store = store()
        val plan = stage(store)
        store.openPayload(plan).use { reader ->
            val buffer = ByteArray(16)
            reader.read(0, buffer, 16)
            val failure = runCatching {
                reader.read(plan.payloadTotal - 4, buffer, 16)
            }.exceptionOrNull()
            assertTrue(failure is PendingUploadException)
        }
    }

    @Test
    fun `an unreadable job is counted rather than deleted, and removed only on demand`() {
        val store = store()
        stage(store)
        box.openFails = true

        val swept = PendingUploadStore(root, box, barriers).sweep()
        assertEquals(1, swept.unreadable)
        assertEquals(1, root.listFiles()?.size ?: 0)

        // The explicit device-data action, and nothing else, removes it.
        assertTrue(PendingUploadStore(root, box, barriers).purgeUnreadableDeviceData())
        assertEquals(0, root.listFiles()?.size ?: 0)
    }

    @Test
    fun `a live staging is never swept`() {
        val store = store()
        val staging = store.begin()
        staging.writeHeader(byteArrayOf(0, 0, 0, 1, 4))
        staging.appendPayload(ByteArray(32))

        // The launch sweep runs while the copy is still going: the directory has
        // no plan yet and is otherwise indistinguishable from a half-copy.
        assertEquals(0, store.sweep().unreadable)
        val plan = staging.commit(account, listOf(PendingUploadFile("a", 32)), false, 60, 1, key)
        assertEquals(plan.jobId, store.pending(account)?.jobId)
    }

    @Test
    fun `a plan whose version does not fit an Int is refused rather than aliased`() {
        val store = store()
        val plan = stage(store)
        // 2^32 + 1 truncates to 1 — this build's own version — so a narrowing
        // that happened before the range check would accept it.
        writePlanJson(plan.jobId) { it["version"] = Json.Num(4_294_967_297.0) }
        assertNull(PendingUploadStore(root, box, barriers).pending(account))
    }

    @Test
    fun `a plan from a future build is refused, never guessed at`() {
        val store = store()
        val plan = stage(store)
        writePlanJson(plan.jobId) { it["version"] = Json.of(PendingUploadStore.PLAN_VERSION + 1) }
        assertNull(PendingUploadStore(root, box, barriers).pending(account))
    }

    @Test
    fun `a plan claiming a filed key with no object is refused`() {
        val store = store()
        val plan = stage(store)
        writePlanJson(plan.jobId) { it["linkKeyCommitted"] = Json.of(true) }
        assertNull(PendingUploadStore(root, box, barriers).pending(account))
    }

    /** Re-seal this job's plan with one field changed, exactly as the store
     *  writes it, so the decoder is what is under test. */
    private fun writePlanJson(jobId: String, change: (LinkedHashMap<String, Json>) -> Unit) {
        val file = File(File(root, jobId), PendingUploadStore.PLAN)
        val label = PendingUploadStore.planLabel(jobId)
        val text = String(box.open(label, file.readBytes()), Charsets.UTF_8)
        val obj = Json.parse(text) as Json.Obj
        val entries = LinkedHashMap(obj.entries)
        change(entries)
        file.writeBytes(
            box.seal(label, Json.stringify(Json.Obj(entries)).toByteArray(Charsets.UTF_8)),
        )
    }

    @Test
    fun `a discard leaves a tombstone before it deletes, and the sweep finishes it`() {
        val store = store()
        val plan = stage(store)
        val retired = store.markRetired(plan)
        assertTrue(retired.retired)
        // The process ended between the tombstone and the removal.
        assertNull(PendingUploadStore(root, box, barriers).pending(account))
        PendingUploadStore(root, box, barriers).sweep()
        assertEquals(0, root.listFiles()?.size ?: 0)
    }

    @Test
    fun `a stored-link key is account-scoped and does not open under another account`() {
        val keys = StoredLinkKeyStore(File(root, "link-keys"), box, barriers)
        val id = "obj00000000000000000000000000000"
        val encoded = "A".repeat(43)
        keys.save(account, id, encoded, 1_800_000_000, 1_700_000_000)

        assertEquals(encoded, keys.record(account, id)?.keyB64url)
        assertNull(keys.record("other0000000000000000000000000000", id))

        // Moved into the other account's directory, it is a refusal rather than
        // a key that account can use.
        val other = File(File(root, "link-keys"), "other0000000000000000000000000000")
        other.mkdirs()
        File(File(File(root, "link-keys"), account), "$id.bin").copyTo(File(other, "$id.bin"))
        assertTrue(
            runCatching { keys.record("other0000000000000000000000000000", id) }.isFailure,
        )
    }

    @Test
    fun `pruning drops only keys whose object is absent AND already expired`() {
        val keys = StoredLinkKeyStore(File(root, "link-keys"), box, barriers)
        val listed = "listed000000000000000000000000000"
        val expired = "expired00000000000000000000000000"
        val unlisted = "unlisted0000000000000000000000000"
        keys.save(account, listed, "A".repeat(43), 2_000_000_000, 1)
        keys.save(account, expired, "B".repeat(43), 1_000, 1)
        keys.save(account, unlisted, "C".repeat(43), 2_000_000_000, 1)

        // A complete, successful listing that contains only the first.
        keys.prune(account, setOf(listed), now = 1_700_000_000)

        assertNotNull(keys.record(account, listed))
        assertNull(keys.record(account, expired))
        // Absent from the list but not yet expired: the list does not filter
        // expired or burned rows, so absence alone is not evidence of removal.
        assertNotNull(keys.record(account, unlisted))
    }

    @Test
    fun `a malformed stored-link record is a stated failure, not a missing key`() {
        val keys = StoredLinkKeyStore(File(root, "link-keys"), box, barriers)
        val id = "obj00000000000000000000000000000"
        keys.save(account, id, "A".repeat(43), 1_800_000_000, 1)
        val file = File(File(File(root, "link-keys"), account), "$id.bin")
        val label = "relayium/stored-link-key/$account/$id"
        file.writeBytes(box.seal(label, """{"key":"short","savedAt":1}""".toByteArray()))

        assertTrue(runCatching { keys.record(account, id) }.isFailure)
        assertFalse(File(root, "link-keys").listFiles().isNullOrEmpty())
    }
}
