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
 * Receiving a stored transfer, end to end, against a real server and a real
 * destination tree.
 *
 * The provider is `java.io.File`-backed with the SHIPPED provider's semantics —
 * an auto-renaming create, no atomic empty-only directory delete — so the
 * ownership rules the receive store enforces are executed here rather than
 * asserted about a wrapper nothing off-device can run.
 */
class CloudDownloadModelTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val executor = Executors.newSingleThreadExecutor()
    private val owner = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(owner)
    private val origin get() = server?.origin ?: "http://127.0.0.1:1"
    private var server: RecordingHttpServer? = null
    private val key = ByteArray(32) { 0x55 }

    @After
    fun tearDown() {
        scope.cancel()
        owner.close()
        executor.shutdownNow()
        server?.close()
    }

    /** A real-directory provider with the shipped SAF semantics. */
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

    /** Two distinct objects, so "which transfer is open" is observable. */
    private fun serveTwo(
        first: Pair<StoredManifest, ByteArray>,
        second: Pair<StoredManifest, ByteArray>,
    ) {
        fun meta(m: StoredManifest, blob: ByteArray): String {
            val enc = Base64.getEncoder().encodeToString(encryptManifest(key, m))
            return """{"encManifest":"$enc","size":${blob.size},""" +
                """"burnAfterRead":false,"expiresAt":1700000000}"""
        }
        server = RecordingHttpServer { request, out ->
            val which = if (request.path.contains("second00")) second else first
            if (request.path.endsWith("/meta")) {
                RecordingHttpServer.respond(out, body = meta(which.first, which.second).toByteArray())
            } else {
                RecordingHttpServer.respond(
                    out, contentType = "application/octet-stream", body = which.second,
                )
            }
        }
    }

    private fun serve(manifest: StoredManifest, blob: ByteArray, burn: Boolean = false) {
        val encManifest = Base64.getEncoder().encodeToString(encryptManifest(key, manifest))
        val meta = """{"encManifest":"$encManifest","size":${blob.size},""" +
            """"burnAfterRead":$burn,"expiresAt":1700000000}"""
        server = RecordingHttpServer { request, out ->
            if (request.path.endsWith("/meta")) {
                RecordingHttpServer.respond(out, body = meta.toByteArray())
            } else {
                RecordingHttpServer.respond(
                    out,
                    contentType = "application/octet-stream",
                    body = blob,
                )
            }
        }
    }

    /** The store thread is the model's own, and the transport is built on it —
     *  the same wiring the ViewModel uses, so the ownership rules under test
     *  are the shipped ones. */
    private fun model(store: ReceiveStore) = CloudDownloadModel(
        scope = scope,
        storage = owner,
        clientFor = { io -> CloudClient(origin, "relayium-test/1", io = io) },
        origin = origin,
        store = store,
    )

    private fun <T> await(get: () -> T, timeoutMs: Long = 10_000, predicate: (T) -> Boolean): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val value = get()
            if (predicate(value)) return value
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting; last was ${get()}")
    }

    private fun link(id: String = "abc123") = "$origin/d/$id#k=${encodeStoreKey(key)}"

    private fun store() = ReceiveStore(temp.newFolder("staging"))

    // ── the whole flow ──────────────────────────────────────────────────────

    @Test
    fun `a stored transfer lands in the chosen folder with exact bytes`() {
        // A zero-byte file (which contributes NO frame), a file larger than one
        // chunk, and a file inside a folder — the three cases where the stream
        // and the file boundaries disagree.
        val big = ByteArray(STORE_CHUNK_SIZE + 7) { (it % 251).toByte() }
        val files = listOf(
            "hello world".toByteArray(),
            ByteArray(0),
            big,
            "nested".toByteArray(),
        )
        val manifest = StoredManifest(
            listOf(
                ManifestFile("a.txt", 11),
                ManifestFile("empty.bin", 0),
                ManifestFile("big.bin", big.size.toLong()),
                ManifestFile("photos/sub/c.txt", 6),
            ),
        )
        serve(manifest, encryptChunks(key, files))

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link())
        val ready = await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
                as CloudDownloadModel.State.Ready
        assertEquals(listOf("a.txt", "empty.bin", "big.bin", "photos/sub/c.txt"), ready.names)
        assertEquals(11L + 0 + big.size + 6, ready.totalBytes)

        model.save(ops, ops.node(root), model.currentTransfer())
        val done = await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        assertEquals(CloudDownloadModel.State.Done(4), done)

        assertArrayEquals(files[0], File(root, "a.txt").readBytes())
        assertEquals(0, File(root, "empty.bin").length())
        assertArrayEquals(big, File(root, "big.bin").readBytes())
        assertArrayEquals(files[3], File(root, "photos/sub/c.txt").readBytes())
    }

    @Test
    fun `a burn-after-read object says so before it is saved`() {
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 1)))
        serve(manifest, encryptChunks(key, listOf(byteArrayOf(1))), burn = true)
        val model = model(store())
        model.open(link())
        val ready = await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
                as CloudDownloadModel.State.Ready
        assertTrue(ready.burnAfterRead)
        assertEquals(1_700_000_000L, ready.expiresAt)
    }

    // ── refusals decided before a folder is even asked for ──────────────────

    @Test
    fun `an unsafe name is refused before any folder is chosen`() {
        val manifest = StoredManifest(listOf(ManifestFile("../escape.txt", 1)))
        serve(manifest, encryptChunks(key, listOf(byteArrayOf(1))))
        val model = model(store())
        model.open(link())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed
        assertEquals(CloudFailure.Kind.UNSAFE_NAME, failed.failure.kind)
    }

    @Test
    fun `two entries that would collide are refused before the first write`() {
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 1), ManifestFile("a.txt", 1)))
        serve(manifest, encryptChunks(key, listOf(byteArrayOf(1), byteArrayOf(2))))
        val model = model(store())
        model.open(link())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed
        assertEquals(CloudFailure.Kind.NAME_COLLISION, failed.failure.kind)
    }

    @Test
    fun `a link this app cannot open never reaches the network`() {
        serve(StoredManifest(listOf(ManifestFile("a.txt", 1))), encryptChunks(key, listOf(byteArrayOf(1))))
        val model = model(store())
        for (bad in listOf(
            "https://evil.example/d/abc123#k=${encodeStoreKey(key)}",
            "$origin/d/abc123",
            "not a link",
            "$origin/d/../secrets#k=${encodeStoreKey(key)}",
        )) {
            model.open(bad)
            val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                    as CloudDownloadModel.State.Failed
            assertEquals(bad, CloudFailure.Kind.LINK_INVALID, failed.failure.kind)
        }
        assertTrue(server!!.received.isEmpty())
    }

    @Test
    fun `an object that is gone reads as gone`() {
        server = RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, status = "404 Not Found", body = "not found".toByteArray())
        }
        val model = model(store())
        model.open(link())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed
        assertEquals(CloudFailure.Kind.NOT_FOUND, failed.failure.kind)
    }

    // ── failures part-way through a save ────────────────────────────────────

    @Test
    fun `a damaged stream leaves nothing behind in the user's folder`() {
        val files = listOf("hello world".toByteArray(), "second".toByteArray())
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 11), ManifestFile("b.txt", 6)))
        val blob = encryptChunks(key, files)
        // Alter the SECOND file's frame, so the first has already been exported
        // by the time authentication fails.
        blob[blob.size - 1] = (blob[blob.size - 1].toInt() xor 0x01).toByte()
        serve(manifest, blob)

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link())
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        model.save(ops, ops.node(root), model.currentTransfer())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed

        assertEquals(CloudFailure.Kind.DAMAGED, failed.failure.kind)
        // The first file WAS exported before the failure. Rollback removes what
        // this batch created rather than leaving a half-delivered transfer.
        assertFalse("a.txt must not survive a failed batch", File(root, "a.txt").exists())
        assertEquals(0, root.listFiles()!!.size)
    }

    @Test
    fun `a truncated stream is refused against the manifest total`() {
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 11), ManifestFile("b.txt", 6)))
        val blob = encryptChunks(key, listOf("hello world".toByteArray(), "second".toByteArray()))
        // Cut on a frame boundary: every delivered frame authenticates.
        serve(manifest, blob.copyOfRange(0, 4 + 11 + 16))

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link())
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        model.save(ops, ops.node(root), model.currentTransfer())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed
        assertEquals(CloudFailure.Kind.DAMAGED, failed.failure.kind)
        assertEquals(0, root.listFiles()!!.size)
    }

    @Test
    fun `an existing document is never overwritten`() {
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 11)))
        serve(manifest, encryptChunks(key, listOf("hello world".toByteArray())))

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val existing = File(root, "a.txt")
        existing.writeText("the user's own file")

        val model = model(store())
        model.open(link())
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        model.save(ops, ops.node(root), model.currentTransfer())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed

        assertEquals(CloudFailure.Kind.NAME_TAKEN, failed.failure.kind)
        assertEquals("the user's own file", existing.readText())
    }

    @Test
    fun `a folder that will not open is an actionable failure`() {
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 11)))
        serve(manifest, encryptChunks(key, listOf("hello world".toByteArray())))
        val model = model(store())
        model.open(link())
        val ready = await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        // Backing out of the picker is not a failure: nothing was attempted.
        model.destinationUnavailable(model.currentTransfer())
        val failed = await({ model.state.value }) { it is CloudDownloadModel.State.Failed }
                as CloudDownloadModel.State.Failed
        assertEquals(CloudFailure.Kind.DESTINATION_UNAVAILABLE, failed.failure.kind)
        assertEquals(ready, ready)
    }

    @Test
    fun `a folder chosen for one link never receives another`() {
        // The folder picker is a round trip through another process, followed by
        // a provider resolve. In between, the user can open a different link.
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 11)))
        serve(manifest, encryptChunks(key, listOf("hello world".toByteArray())))

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link("first000"))
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        val chosenFor = model.currentTransfer()

        // A second link is opened while the folder picker is still up.
        model.open(link("second00"))
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }

        // The folder finally resolves — for the transfer that is no longer open.
        model.save(ops, ops.node(root), chosenFor)
        Thread.sleep(300)
        assertEquals(0, root.listFiles()!!.size)
        assertTrue(model.state.value is CloudDownloadModel.State.Ready)

        // The folder chosen for the CURRENT transfer does save.
        model.save(ops, ops.node(root), model.currentTransfer())
        await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        assertArrayEquals("hello world".toByteArray(), File(root, "a.txt").readBytes())
    }

    @Test
    fun `a stale folder result cannot outrun a newly opened link`() {
        // The ordering that matters: `open` is ADMITTED on the caller's thread
        // and does its work on the storage thread. If a folder result for the
        // PREVIOUS transfer arrives after `open(B)` was admitted but before it
        // ran, the state is still Ready(A) and — unless the token was
        // invalidated at admission — the stale save passes both checks, cancels
        // the queued open(B), and writes A into the folder the user chose while
        // B was already on screen.
        serveTwo(
            StoredManifest(listOf(ManifestFile("a.txt", 11))) to
                encryptChunks(key, listOf("hello world".toByteArray())),
            StoredManifest(listOf(ManifestFile("b.txt", 6))) to
                encryptChunks(key, listOf("second".toByteArray())),
        )

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link("first000"))
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        val chosenForA = model.currentTransfer()

        // Hold the storage thread so `open(B)` is admitted but has not run.
        val held = java.util.concurrent.CountDownLatch(1)
        val entered = java.util.concurrent.CountDownLatch(1)
        executor.execute {
            entered.countDown()
            held.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }
        assertTrue("the storage thread must be held", entered.await(5, java.util.concurrent.TimeUnit.SECONDS))

        model.open(link("second00"))
        // The folder picked for A returns now, while B's open is still queued.
        model.save(ops, ops.node(root), chosenForA)
        held.countDown()

        // B's open must survive — observed by the SECOND object's own manifest
        // being what is on screen, not merely by "some Ready" — and A must not
        // have been saved into the folder the user chose after moving on.
        val settled = await({ model.state.value }, timeoutMs = 10_000) {
            it is CloudDownloadModel.State.Ready && it.names == listOf("b.txt")
        }
        assertEquals(listOf("b.txt"), (settled as CloudDownloadModel.State.Ready).names)
        assertEquals("a superseded transfer must not be saved", 0, root.listFiles()!!.size)
    }

    @Test
    fun `a stale folder result cannot outrun a reset`() {
        val manifest = StoredManifest(listOf(ManifestFile("a.txt", 11)))
        serve(manifest, encryptChunks(key, listOf("hello world".toByteArray())))

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link("first000"))
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        val chosenForA = model.currentTransfer()

        val held = java.util.concurrent.CountDownLatch(1)
        val entered = java.util.concurrent.CountDownLatch(1)
        executor.execute {
            entered.countDown()
            held.await(10, java.util.concurrent.TimeUnit.SECONDS)
        }
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))

        model.reset()
        model.save(ops, ops.node(root), chosenForA)
        held.countDown()

        await({ model.state.value }) { it is CloudDownloadModel.State.Idle }
        assertEquals("an abandoned transfer must not be saved", 0, root.listFiles()!!.size)
    }

    @Test
    fun `progress is reported and never exceeds the total`() {
        val big = ByteArray(STORE_CHUNK_SIZE * 2) { 3 }
        val manifest = StoredManifest(listOf(ManifestFile("big.bin", big.size.toLong())))
        serve(manifest, encryptChunks(key, listOf(big)))

        val ops = FileOps()
        val root = temp.newFolder("dest")
        val model = model(store())
        model.open(link())
        await({ model.state.value }) { it is CloudDownloadModel.State.Ready }
        model.save(ops, ops.node(root), model.currentTransfer())
        await({ model.state.value }) { it is CloudDownloadModel.State.Done }
        assertArrayEquals(big, File(root, "big.bin").readBytes())
    }
}
