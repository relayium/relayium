package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.stored.BytesSource
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.STORE_CHUNK_SIZE
import com.relayium.protocol.stored.StoreDecryptor
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Staging a delivery, against real crypto.
 *
 * The point of this file is that what preparation writes is exactly what a
 * RECEIVER will later open: the sealed manifest is opened with the stored
 * content key, and the spool is decrypted with the protocol's own framed
 * decryptor and compared byte for byte. A test that only checked the record
 * would prove the fields were populated, not that the delivery is openable.
 */
class InboxSendPreparerTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val store by lazy {
        InboxSendStore(File(folder.root, "send"), account, secrets, files)
    }

    private var ordinal = 0
    private fun now() = 1_700_000_500L
    private fun nextId(): String = "job%030d".format(++ordinal)

    private fun preparer() = InboxSendPreparer(store, ::now, ::nextId)

    /**
     * Open what was staged exactly as a receiver would: the sealed manifest with
     * the stored content key, then the framed spool through the protocol's own
     * decryptor, including its completeness proof.
     */
    private suspend fun decrypted(job: InboxSendJob): ByteArray {
        val key = requireNotNull(store.contentKey(job.jobId)) { "the content key must be durable" }
        val manifest = InboxManifest.open(key, requireNotNull(store.encManifest(job.jobId)))
        val decryptor = StoreDecryptor(key)
        val out = java.io.ByteArrayOutputStream()
        store.spool(job.jobId).inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                decryptor.push(buffer.copyOf(read)).forEach { out.write(it) }
            }
        }
        // The same check the receiver makes, so a short or padded stream fails
        // here rather than producing plausible bytes.
        decryptor.end(manifest.items.sumOf { it.size })
        return out.toByteArray()
    }

    // ── files ───────────────────────────────────────────────────────────────

    /**
     * Nested unicode names, a zero-length file, and a payload spanning several
     * frames — the three shapes that break a naive encoder.
     */
    @Test
    fun `a staged file delivery is exactly what a receiver will open`() = runBlocking {
        val small = "alpha".toByteArray()
        val empty = ByteArray(0)
        val large = ByteArray(STORE_CHUNK_SIZE * 2 + 1234) { (it % 251).toByte() }
        val sources = listOf<PlaintextSource>(
            BytesSource("文档/报告 🎉.txt", small),
            BytesSource("empty.bin", empty),
            BytesSource("nested/deep/large.bin", large),
        )

        val job = preparer().stageFiles(InboxFixtures.OTHER_DEVICE_ID, sources)

        // The record describes what was staged.
        assertEquals(InboxManifestKind.FILE, job.kind)
        assertEquals(
            listOf("文档/报告 🎉.txt", "empty.bin", "nested/deep/large.bin"),
            job.files.map { it.first },
        )
        assertEquals(small.size + empty.size + large.size.toLong(), job.totalBytes)
        assertTrue("the payload identity must be bound", job.isPrepared)
        assertTrue(store.spoolMatches(job))

        // …and the sealed manifest opens with the stored key, naming the same
        // files and sizes.
        val key = requireNotNull(store.contentKey(job.jobId))
        val manifest = InboxManifest.open(key, requireNotNull(store.encManifest(job.jobId)))
        assertEquals(
            sources.map { it.name to it.size },
            manifest.items.map { requireNotNull(it.name) to it.size },
        )

        // …and the ciphertext decrypts to exactly the bytes that were staged, in
        // manifest order, across frame boundaries.
        val expected = java.io.ByteArrayOutputStream().apply {
            write(small); write(empty); write(large)
        }.toByteArray()
        assertArrayEquals(expected, decrypted(job))
    }

    /** Each send is its own job, so a second staging cannot disturb the first. */
    @Test
    fun `two stagings are independent jobs`() = runBlocking {
        val first = preparer().stageFiles(
            InboxFixtures.OTHER_DEVICE_ID, listOf(BytesSource("a.txt", "one".toByteArray())),
        )
        val second = preparer().stageFiles(
            InboxFixtures.OTHER_DEVICE_ID, listOf(BytesSource("a.txt", "two".toByteArray())),
        )
        assertFalse(first.jobId == second.jobId)
        assertFalse(first.idempotencyKey == second.idempotencyKey)
        assertArrayEquals("one".toByteArray(), decrypted(first))
        assertArrayEquals("two".toByteArray(), decrypted(second))
    }

    // ── text ────────────────────────────────────────────────────────────────

    /**
     * A real text record end to end: the manifest says `text`, so the receiver
     * commits it to its message store rather than writing a `.txt` file.
     */
    @Test
    fun `a staged message is text, not a disguised file`() = runBlocking {
        val text = "hello 世界 🎉"
        val job = preparer().stageText(InboxFixtures.OTHER_DEVICE_ID, text)

        assertEquals(InboxManifestKind.TEXT, job.kind)
        assertTrue("a message names no files", job.files.isEmpty())
        val key = requireNotNull(store.contentKey(job.jobId))
        val manifest = InboxManifest.open(key, requireNotNull(store.encManifest(job.jobId)))
        assertEquals(InboxManifestKind.TEXT, manifest.items.single().kind)
        assertNull("a message entry has no name", manifest.items.single().name)
        assertArrayEquals(text.toByteArray(Charsets.UTF_8), decrypted(job))
    }

    @Test
    fun `an empty or oversized message is refused before anything is staged`() = runBlocking {
        for (bad in listOf("", "a".repeat(InboxManifest.MAX_TEXT_BYTES.toInt() + 1))) {
            val refused = try {
                preparer().stageText(InboxFixtures.OTHER_DEVICE_ID, bad)
                false
            } catch (_: IllegalArgumentException) {
                true
            }
            assertTrue("'${bad.length}' must be refused", refused)
        }
        assertTrue("nothing may be staged", store.all().isEmpty())
    }

    // ── sources that do not deliver what they declared ──────────────────────

    /**
     * A source that yields fewer bytes than it declared is caught at STAGING.
     *
     * The manifest is built from the declaration, so a short source would
     * otherwise produce a spool that cannot satisfy it — and the failure would
     * surface on the recipient's device, after an upload the user paid for. The
     * framed encoder refuses at encode time instead, and what matters here is
     * the state that leaves behind: nothing prepared, so nothing uploadable.
     */
    @Test
    fun `a source that under-delivers is refused at staging and leaves nothing uploadable`() =
        runBlocking {
            val refused = try {
                preparer().stageFiles(
                    InboxFixtures.OTHER_DEVICE_ID,
                    listOf(ShortSource("a.bin", declared = 100, actual = "short".toByteArray())),
                )
                false
            } catch (_: com.relayium.protocol.stored.StoredWireException) {
                true
            }
            assertTrue("a declaration the source cannot meet must not stage", refused)
            val staged = store.all()
            assertTrue("nothing may be prepared", staged.none { it.isPrepared })
            for (record in staged) assertFalse(store.spoolMatches(record))
        }

    /** …and the same for a source that yields MORE than it declared: the
     *  manifest is the contract, and a stream that exceeds it is not it. */
    @Test
    fun `a source that over-delivers is refused at staging`() = runBlocking {
        val refused = try {
            preparer().stageFiles(
                InboxFixtures.OTHER_DEVICE_ID,
                listOf(ShortSource("a.bin", declared = 2, actual = "much longer".toByteArray())),
            )
            false
        } catch (_: com.relayium.protocol.stored.StoredWireException) {
            true
        }
        assertTrue(refused)
        assertTrue(store.all().none { it.isPrepared })
    }

    // ── cancellation ────────────────────────────────────────────────────────

    /**
     * A cancelled preparation leaves at most an UNPREPARED job.
     *
     * Nothing partial can be sent: the uploader refuses a job whose payload
     * identity is not bound, so an interrupted staging costs a retry rather than
     * publishing a fragment.
     */
    @Test
    fun `a cancelled preparation leaves nothing uploadable`() = runBlocking {
        val job = try {
            preparer().stageFiles(
                InboxFixtures.OTHER_DEVICE_ID,
                listOf(CancellingSource("a.bin", 4096)),
            )
            null
        } catch (_: CancellationException) {
            null
        }
        assertNull(job)
        val staged = store.all()
        // Either no record at all, or one that is not prepared — never one that
        // claims a payload identity it does not have.
        assertTrue(staged.none { it.isPrepared })
        for (record in staged) {
            assertFalse("an unprepared job must not match a spool", store.spoolMatches(record))
        }
    }

    // ── sources ─────────────────────────────────────────────────────────────

    /** Declares one size and yields another. */
    private class ShortSource(
        override val name: String,
        private val declared: Long,
        private val actual: ByteArray,
    ) : PlaintextSource {
        private var offset = 0
        override val size: Long get() = declared
        override fun read(max: Int): ByteArray {
            if (offset >= actual.size) return ByteArray(0)
            val end = minOf(offset + max, actual.size)
            return actual.copyOfRange(offset, end).also { offset = end }
        }
    }

    /** Fails partway, as a revoked content-URI grant would. */
    private class CancellingSource(
        override val name: String,
        override val size: Long,
    ) : PlaintextSource {
        private var served = false
        override fun read(max: Int): ByteArray {
            if (served) throw CancellationException("the test cancelled the staging")
            served = true
            return ByteArray(minOf(max, 512))
        }
    }
}
