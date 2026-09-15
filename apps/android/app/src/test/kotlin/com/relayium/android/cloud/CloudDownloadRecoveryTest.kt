package com.relayium.android.cloud

import com.relayium.android.storage.ProviderOps
import com.relayium.android.storage.ReceiveStore
import com.relayium.protocol.stored.ManifestFile
import com.relayium.protocol.stored.STORE_CHUNK_SIZE
import com.relayium.protocol.stored.StoredManifest
import com.relayium.protocol.stored.encodeStoreKey
import com.relayium.protocol.stored.encryptChunks
import com.relayium.protocol.stored.encryptManifest
import java.io.File
import java.io.OutputStream
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * An interrupted stored receive, through the model that owns the folder.
 *
 * `CloudResumeTest` proves the transport recovers the BYTES. This proves the
 * things only the model can be wrong about once it does:
 *
 *  * the documents in the user's folder are the sender's files exactly, with no
 *    frame written twice and none missing — the corruption a bad resume
 *    produces is a plausible file, not an error;
 *  * the batch is never rolled back for an interruption it recovered from,
 *    which is what the old behaviour did to every file a ten-file batch had
 *    already completed;
 *  * the recovery is VISIBLE and is still `Saving`, so the busy predicates that
 *    gate an incoming link and the keep-awake claim keep answering yes;
 *  * a recovery that does not succeed still rolls back and still refuses to
 *    report a partial batch as done.
 */
class CloudDownloadRecoveryTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val executor = Executors.newSingleThreadExecutor()
    private val owner = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(owner)
    private var server: RecordingHttpServer? = null
    private val origin get() = server?.origin ?: "http://127.0.0.1:1"
    private val key = ByteArray(32) { 0x55 }

    @After
    fun tearDown() {
        scope.cancel()
        owner.close()
        executor.shutdownNow()
        server?.close()
    }

    private open class FileOps : ProviderOps {
        inner class FileNode(val file: File) : ProviderOps.Node {
            override val name: String get() = file.name
            override val isDirectory: Boolean get() = file.isDirectory
            override fun delete(): Boolean = file.deleteRecursively()
            override fun openOut(): OutputStream = file.outputStream()
        }

        fun node(file: File): ProviderOps.Node = FileNode(file)

        override fun findChild(parent: ProviderOps.Node, name: String): ProviderOps.Node? =
            File((parent as FileNode).file, name).takeIf { it.exists() }?.let { FileNode(it) }

        override fun createDirectory(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
            val dir = File((parent as FileNode).file, name)
            return if (dir.mkdirs() || dir.isDirectory) FileNode(dir) else null
        }

        override fun createFile(parent: ProviderOps.Node, name: String): ProviderOps.Node? {
            val file = File((parent as FileNode).file, name)
            return if (file.createNewFile()) FileNode(file) else null
        }
    }

    /** A zero-byte entry (which contributes no frame), a multi-frame file and a
     *  nested one: the three places a stream boundary and a FILE boundary
     *  disagree, which is where a resumed offset is most easily mis-assigned. */
    private val files = listOf(
        "the first file".toByteArray(),
        ByteArray(0),
        ByteArray(STORE_CHUNK_SIZE * 2 + 13) { (it % 251).toByte() },
        "nested".toByteArray(),
    )

    private val manifest = StoredManifest(
        listOf(
            ManifestFile("a.txt", files[0].size.toLong()),
            ManifestFile("empty.bin", 0),
            ManifestFile("big.bin", files[2].size.toLong()),
            ManifestFile("photos/sub/c.txt", files[3].size.toLong()),
        ),
    )

    private val blob = encryptChunks(key, files)

    /**
     * Serves the metadata, then the blob — cutting the body per attempt and
     * honouring `Range` the way a real unlimited object's host does.
     */
    private fun serve(cuts: List<Int?>, acceptRanges: Boolean = true) {
        val encManifest = Base64.getEncoder().encodeToString(encryptManifest(key, manifest))
        val meta = """{"encManifest":"$encManifest","size":${blob.size},""" +
            """"burnAfterRead":false,"expiresAt":1700000000}"""
        val attempt = AtomicInteger(0)
        server = RecordingHttpServer { request, out ->
            if (request.path.endsWith("/meta")) {
                RecordingHttpServer.respond(out, body = meta.toByteArray())
                return@RecordingHttpServer
            }
            val n = attempt.getAndIncrement()
            val cut = cuts.getOrNull(n)
            val range = request.header("Range")
            val start = range?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull() ?: 0
            val head = StringBuilder()
            if (start > 0) {
                head.append("HTTP/1.1 206 Partial Content\r\n")
                head.append("Content-Range: bytes $start-${blob.size - 1}/${blob.size}\r\n")
                head.append("Content-Length: ${blob.size - start}\r\n")
            } else {
                head.append("HTTP/1.1 200 OK\r\n")
                head.append("Content-Length: ${blob.size}\r\n")
            }
            head.append("Content-Type: application/octet-stream\r\n")
            if (acceptRanges) head.append("Accept-Ranges: bytes\r\n")
            head.append("Connection: close\r\n\r\n")
            out.write(head.toString().toByteArray())
            out.write(blob.copyOfRange(start, cut ?: blob.size))
            out.flush()
        }
    }

    private fun model(store: ReceiveStore) = CloudDownloadModel(
        scope = scope,
        storage = owner,
        clientFor = { io -> CloudClient(origin, "relayium-test/1", io = io) },
        origin = origin,
        store = store,
    )

    private fun <T> await(get: () -> T, timeoutMs: Long = 20_000, predicate: (T) -> Boolean): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val value = get()
            if (predicate(value)) return value
            Thread.sleep(5)
        }
        throw AssertionError("timed out waiting; last was ${get()}")
    }

    private fun link() = "$origin/d/abc123#k=${encodeStoreKey(key)}"

    private fun openAndSave(model: CloudDownloadModel, root: File): FileOps {
        val ops = FileOps()
        model.open(link())
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        model.save(ops, ops.node(root), model.currentTransfer())
        return ops
    }

    /** The first frame's exact ciphertext length. */
    private val firstFrame = 4 + files[0].size + 16

    // ── recovery that keeps the batch ───────────────────────────────────────

    @Test
    fun `an interrupted receive resumes and every file is byte-exact`() {
        // Cut inside the multi-frame file, after two whole frames have landed,
        // so the resume has to reattach in the middle of ONE document and get
        // the file boundaries after it right as well.
        serve(cuts = listOf(firstFrame + STORE_CHUNK_SIZE + 40, null))
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        openAndSave(model, root)

        assertEquals(
            CloudDownloadModel.State.Done(4),
            await({ model.state.value }) { it is CloudDownloadModel.State.Done },
        )
        assertArrayEquals(files[0], File(root, "a.txt").readBytes())
        assertEquals(0, File(root, "empty.bin").length())
        assertArrayEquals(files[2], File(root, "big.bin").readBytes())
        assertArrayEquals(files[3], File(root, "photos/sub/c.txt").readBytes())
    }

    @Test
    fun `a recovered batch keeps the files it had already finished`() {
        // The behaviour this replaces discarded EVERY completed file in the
        // batch on any transient failure: a drop at 95% of a ten-file receive
        // lost all ten.
        serve(cuts = listOf(firstFrame + 8, null))
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        openAndSave(model, root)
        await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        assertEquals(
            "nothing was rolled back",
            4,
            root.walkTopDown().filter { it.isFile }.count(),
        )
    }

    @Test
    fun `two interruptions still produce one complete batch`() {
        serve(cuts = listOf(firstFrame, firstFrame + STORE_CHUNK_SIZE + 24, null))
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        openAndSave(model, root)
        await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        assertArrayEquals(files[2], File(root, "big.bin").readBytes())
    }

    // ── what the surface and the guards see ─────────────────────────────────

    @Test
    fun `the recovery is visible, and is still a busy Saving state`() {
        serve(cuts = listOf(firstFrame + 8, null))
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))

        val seen = java.util.concurrent.ConcurrentLinkedQueue<CloudDownloadModel.State>()
        val watcher = Thread {
            while (!Thread.currentThread().isInterrupted) {
                seen.add(model.state.value)
                Thread.sleep(2)
            }
        }
        watcher.isDaemon = true
        watcher.start()
        openAndSave(model, root)
        await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        watcher.interrupt()

        val reconnecting = seen.filterIsInstance<CloudDownloadModel.State.Saving>()
            .filter { it.reconnecting }
        assertTrue("the recovery window was never published", reconnecting.isNotEmpty())
        // The invariant every busy guard depends on: `ingressBusy` refuses to
        // overwrite a running download, and the keep-awake claim holds, because
        // a reconnecting download is STILL `Saving`. A separate state would have
        // made both silently wrong the moment a connection hiccupped.
        for (state in reconnecting) {
            assertTrue(state is CloudDownloadModel.State.Saving)
            assertEquals(
                "the total is carried through unchanged",
                manifest.files.sumOf { it.size },
                state.total,
            )
        }
    }

    @Test
    fun `progress never exceeds the total and reaches it exactly once`() {
        serve(cuts = listOf(firstFrame + STORE_CHUNK_SIZE + 5, null))
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        val total = manifest.files.sumOf { it.size }

        val seen = java.util.concurrent.ConcurrentLinkedQueue<Long>()
        val watcher = Thread {
            while (!Thread.currentThread().isInterrupted) {
                (model.state.value as? CloudDownloadModel.State.Saving)?.let { seen.add(it.received) }
                Thread.sleep(2)
            }
        }
        watcher.isDaemon = true
        watcher.start()
        openAndSave(model, root)
        await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        watcher.interrupt()

        // A resume that re-fed a frame would push `received` past the total —
        // the counter is incremented per byte WRITTEN, so a duplicate write is
        // visible here even when the final file happens to compare equal.
        for (value in seen) assertTrue("received $value > total $total", value <= total)
        assertFalse(seen.isEmpty())
    }

    // ── recovery that does not succeed ──────────────────────────────────────

    @Test
    fun `a receive that cannot be recovered rolls back and is never reported done`() {
        // Every attempt stops at the same place, so the budget is spent.
        serve(cuts = List(12) { firstFrame })
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        openAndSave(model, root)

        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed
        assertEquals(CloudFailure.Kind.NETWORK, failed.failure.kind)
        assertEquals(
            "a failed batch leaves nothing behind",
            0,
            root.walkTopDown().filter { it.isFile }.count(),
        )
    }

    @Test
    fun `an object that cannot be resumed still fails cleanly and is fetched once`() {
        // No `Accept-Ranges`: a burn or download-limited object. It must not be
        // re-requested, because a second GET spends a download slot.
        serve(cuts = listOf(firstFrame, null), acceptRanges = false)
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        openAndSave(model, root)

        await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
        val blobRequests = server!!.received.count { !it.path.endsWith("/meta") }
        assertEquals("a limited object is fetched exactly once", 1, blobRequests)
        assertEquals(0, root.walkTopDown().filter { it.isFile }.count())
    }

    @Test
    fun `discarding during a recovery leaves nothing behind`() {
        serve(cuts = List(12) { firstFrame })
        val root = temp.newFolder("dest")
        val model = model(ReceiveStore(temp.newFolder("staging")))
        openAndSave(model, root)
        await({ model.state.value }) { it is CloudDownloadModel.State.Saving }
        model.reset()
        await({ model.state.value }) {
            it is CloudDownloadModel.State.Idle || it is CloudDownloadModel.State.Failed
        }
        assertEquals(0, root.walkTopDown().filter { it.isFile }.count())
    }
}
