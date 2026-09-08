package com.relayium.android.cloud

import com.relayium.android.account.AccountClient
import com.relayium.android.account.AccountSession
import com.relayium.android.account.AccountState
import com.relayium.android.account.FakeTransport
import com.relayium.android.account.FlakyTokenStore
import com.relayium.protocol.stored.BytesSource
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.StoreDecryptor
import com.relayium.protocol.stored.cipherSize
import com.relayium.protocol.stored.decodeStoreKey
import com.relayium.protocol.stored.decryptManifestRaw
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Recoverable uploads, driven through the production composition.
 *
 * The real [CloudUploadModel], the real [CloudClient], the real
 * [PendingUploadStore] over a real directory, and a real [AccountSession] — the
 * only substitutions are the sealing box, the write barriers and the server,
 * and each of those exists so a NAMED failure can be made to happen. Nothing
 * here reimplements the upload loop; if these pass, that loop is what passed.
 *
 * The staging threshold is lowered so the cases are seconds rather than minutes.
 * It is the model's own parameter, and the surface reads the same value, so a
 * test threshold cannot make the app promise recovery it would not give.
 */
class CloudRecoveryTest {

    private val executor = Executors.newSingleThreadExecutor()
    private val owner = executor.asCoroutineDispatcher()
    private val ioExecutor = Executors.newCachedThreadPool()
    private val io = ioExecutor.asCoroutineDispatcher()
    private val scope = CoroutineScope(owner)
    private val origin = "https://relayium.com"
    private val root = File(System.getProperty("java.io.tmpdir"), "recovery-${System.nanoTime()}")
    private val box = FakeSecretBox()
    private val linkBox = FakeSecretBox()
    private val barriers = ScriptedDurableFiles()

    @After
    fun tearDown() {
        scope.cancel()
        owner.close()
        io.close()
        executor.shutdownNow()
        ioExecutor.shutdownNow()
        root.deleteRecursively()
    }

    // ── the composition under test ──────────────────────────────────────────

    private class Account(val transport: FakeTransport, val session: AccountSession)

    private fun account(): Account {
        val transport = FakeTransport()
            .answer("api/auth/native/login", 200, com.relayium.android.account.loginBody())
            .answer("api/me", 200, com.relayium.android.account.meBody())
            .answer("api/me/usage", 200, com.relayium.android.account.usageBody())
            .answer("api/auth/logout", 200, "")
        return Account(
            transport,
            AccountSession(scope, owner, owner, AccountClient(transport), FlakyTokenStore(), "Pixel"),
        )
    }

    private fun pendingStore() = PendingUploadStore(File(root, "pending"), box, barriers)

    private fun linkKeys() = StoredLinkKeyStore(File(root, "link-keys"), linkBox, barriers)

    private fun model(
        server: ResumableUploadServer,
        account: Account,
        pending: PendingUploadStore = pendingStore(),
        keys: StoredLinkKeyStore = linkKeys(),
        threshold: Long = 32,
        open: (CloudSelection) -> PlaintextSource? = { BytesSource(it.name, bytesFor(it)) },
    ) = CloudUploadModel(
        scope = scope,
        owner = owner,
        io = io,
        client = CloudClient(server.origin, "relayium-test/1"),
        session = account.session,
        origin = origin,
        open = open,
        pending = pending,
        linkKeys = keys,
        now = { 1_700_000_000L },
        resumableMinBytes = threshold,
    )

    /** Deterministic plaintext, so the bytes that come off the server can be
     *  compared against what the user chose. */
    private fun bytesFor(selection: CloudSelection) =
        ByteArray(selection.size.toInt()) { (it * 31 + selection.name.length).toByte() }

    private val selection = listOf(
        CloudSelection("content://x/1", "big.bin", 400_000),
        CloudSelection("content://x/2", "small.bin", 1_024),
    )

    private fun <T> await(get: () -> T, timeoutMs: Long = 20_000, predicate: (T) -> Boolean): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val value = get()
            if (predicate(value)) return value
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting; last was ${get()}")
    }

    /**
     * The account observer the ViewModel installs.
     *
     * Wired explicitly by the tests that are ABOUT it, so the rest do not depend
     * on an eventual observer to be correct: every post-await admission inside
     * the model has to stand on its own.
     */
    private fun observeAccount(account: Account, model: CloudUploadModel) {
        scope.launch { account.session.state.collect { model.accountChanged() } }
    }

    private fun signIn(account: Account) {
        account.session.signIn("a@example.invalid", "pw")
        await({ account.session.state.value }) { it is AccountState.Ready }
    }

    private fun startUpload(model: CloudUploadModel, files: List<CloudSelection> = selection) {
        model.select(files, model.beginSelection())
        await({ model.state.value }) { it is CloudUploadModel.State.Selected }
        model.upload()
    }

    /** Decrypt what the server actually holds and hand back each file's
     *  plaintext, which is the only proof that a resumed stream is intact. */
    private fun decode(server: ResumableUploadServer, key: ByteArray): List<ByteArray> {
        val header = server.header
        val length = ((header[0].toInt() and 0xff) shl 24) or ((header[1].toInt() and 0xff) shl 16) or
            ((header[2].toInt() and 0xff) shl 8) or (header[3].toInt() and 0xff)
        val manifest = decryptManifestRaw(key, header.copyOfRange(4, 4 + length))
        val decryptor = StoreDecryptor(key)
        val plaintext = ByteArrayOutputStream()
        for (chunk in decryptor.push(server.payload())) plaintext.write(chunk)
        decryptor.end(manifest.files.sumOf { it.size })
        val all = plaintext.toByteArray()
        var offset = 0
        return manifest.files.map { file ->
            all.copyOfRange(offset, offset + file.size.toInt()).also { offset += file.size.toInt() }
        }
    }

    private fun keyOf(link: String): ByteArray = decodeStoreKey(link.substringAfter("#k="))

    // ── the cases ───────────────────────────────────────────────────────────

    @Test
    fun `a staged upload sends the header separately and counts payload offsets from zero`() {
        ResumableUploadServer().use { server ->
            val account = account()
            signIn(account)
            val model = model(server, account)
            startUpload(model)
            val ready = await({ model.state.value }) { it is CloudUploadModel.State.Ready }
                as CloudUploadModel.State.Ready

            val expected = cipherSize(selection.map { it.size })
            assertEquals(expected, server.committed.toLong())
            // The init body is the header and is stored apart from the blob, so
            // the first PATCH starts at zero and the total is the payload alone.
            assertTrue(server.header.isNotEmpty())
            assertTrue(server.ranges.first().startsWith("bytes 0-"))
            for (range in server.ranges) {
                assertEquals(expected, range.substringAfter('/').toLong())
            }
            val files = decode(server, keyOf(ready.link))
            assertArrayEquals(bytesFor(selection[0]), files[0])
            assertArrayEquals(bytesFor(selection[1]), files[1])
        }
    }

    @Test
    fun `a silently capped append is replayed from the offset the server reports`() {
        // Every append commits at most 20 KiB whatever the client sent, exactly
        // as the real server caps one.
        ResumableUploadServer(chunkSize = 128 * 1024, appendCap = 20_000).use { server ->
            val account = account()
            signIn(account)
            val model = model(server, account)
            startUpload(model)
            val ready = await({ model.state.value }) { it is CloudUploadModel.State.Ready }
                as CloudUploadModel.State.Ready

            assertEquals(cipherSize(selection.map { it.size }), server.committed.toLong())
            assertTrue("expected several appends, saw ${server.ranges.size}", server.ranges.size > 5)
            // Byte-identical despite the partial commits: the spool is immutable
            // and the replay is the same ciphertext, never a re-encryption.
            assertArrayEquals(bytesFor(selection[0]), decode(server, keyOf(ready.link))[0])
        }
    }

    @Test
    fun `an offset outside the declared stream is refused rather than acted on`() {
        ResumableUploadServer().use { server ->
            server.impossibleOffset = true
            val account = account()
            signIn(account)
            val model = model(server, account)
            startUpload(model)
            val state = await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }
                as CloudUploadModel.State.Interrupted
            assertEquals(CloudFailure.Kind.MALFORMED, state.failure?.kind)
            assertEquals(0, server.finalizeCount)
        }
    }

    @Test
    fun `a server that never advances is reported instead of retried forever`() {
        ResumableUploadServer().use { server ->
            server.stalled = true
            val account = account()
            signIn(account)
            val model = model(server, account)
            startUpload(model)
            val state = await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }
                as CloudUploadModel.State.Interrupted
            assertEquals(CloudFailure.Kind.NO_PROGRESS, state.failure?.kind)
            assertEquals(0, server.finalizeCount)
            // Bounded: the guard fires after a fixed number of answers, not
            // after an unbounded spin.
            assertTrue(server.ranges.size <= CloudUploadModel.MAX_STALLED_APPENDS + 2)
        }
    }

    @Test
    fun `an upload interrupted by process death resumes in a new model from the server's offset`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            val account = account()
            signIn(account)
            val store = pendingStore()
            val keys = linkKeys()
            // The interruption is decided by the SERVER, so it happens at a
            // known offset rather than in a race with the test's own thread.
            server.refuseAppendsAfter = 100_000
            val first = model(server, account, store, keys)
            startUpload(first)
            await({ first.state.value }) { it is CloudUploadModel.State.Interrupted }
            server.refuseAppendsAfter = Long.MAX_VALUE
            val committedBefore = server.committed
            val initsBefore = server.initCount

            // A NEW model over a NEW store instance, exactly as the next process
            // builds them. Nothing is carried over but the files on disk.
            val next = model(server, account, pendingStore(), linkKeys())
            next.recoverPendingJob()
            val offered = await({ next.state.value }) { it is CloudUploadModel.State.Interrupted }
                as CloudUploadModel.State.Interrupted
            assertTrue(offered.resumable)
            assertEquals(selection.size, offered.files)

            next.resumePending()
            val ready = await({ next.state.value }) { it is CloudUploadModel.State.Ready }
                as CloudUploadModel.State.Ready

            // The same session continued, and the stream is byte-perfect.
            assertEquals(initsBefore, server.initCount)
            assertTrue(server.committed > committedBefore)
            assertEquals(cipherSize(selection.map { it.size }), server.committed.toLong())
            assertArrayEquals(bytesFor(selection[0]), decode(server, keyOf(ready.link))[0])
        }
    }

    @Test
    fun `a session reaped before any finalize may be replaced, and only then`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            val account = account()
            signIn(account)
            val store = pendingStore()
            server.refuseAppendsAfter = 100_000
            val first = model(server, account, store, linkKeys())
            startUpload(first)
            await({ first.state.value }) { it is CloudUploadModel.State.Interrupted }
            server.refuseAppendsAfter = Long.MAX_VALUE

            // The idle reaper got there first, so the status probe 404s for the
            // whole resume. No finalize was ever requested, which is the only
            // thing that makes replacing the session safe.
            server.sessionReaped = true
            val next = model(server, account, pendingStore(), linkKeys())
            next.recoverPendingJob()
            await({ next.state.value }) { it is CloudUploadModel.State.Interrupted }
            next.resumePending()
            await({ next.state.value }) { it is CloudUploadModel.State.Ready }
            assertEquals(2, server.initCount)
            assertEquals(cipherSize(selection.map { it.size }), server.committed.toLong())
        }
    }

    @Test
    fun `a finalize whose answer is a conflict becomes uncertainty and never a second session`() {
        ResumableUploadServer().use { server ->
            server.finalizeConflicts = true
            val account = account()
            signIn(account)
            val model = model(server, account)
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Uncertain }

            assertEquals(1, server.initCount)
            assertEquals(1, server.finalizeCount)

            // Retrying re-asks the SAME session. It must not open a new one, and
            // it must not send the bytes again.
            val committed = server.committed
            model.resumePending()
            await({ server.finalizeCount }) { it == 2 }
            await({ model.state.value }) { it is CloudUploadModel.State.Uncertain }
            assertEquals(1, server.initCount)
            assertEquals(committed, server.committed)

            // And a fresh process makes the same choice from disk alone.
            val next = model(server, account, pendingStore(), linkKeys())
            next.recoverPendingJob()
            await({ next.state.value }) { it is CloudUploadModel.State.Uncertain }
            assertEquals(1, server.initCount)
        }
    }

    @Test
    fun `a finalize that succeeds after a lost answer publishes once`() {
        ResumableUploadServer().use { server ->
            server.finalizeConflicts = true
            val account = account()
            signIn(account)
            val store = pendingStore()
            val model = model(server, account, store, linkKeys())
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Uncertain }

            // The first attempt's answer was lost rather than refused: the retry
            // is what learns the object exists.
            server.finalizeConflicts = false
            val next = model(server, account, pendingStore(), linkKeys())
            next.recoverPendingJob()
            await({ next.state.value }) { it is CloudUploadModel.State.Uncertain }
            next.resumePending()
            val ready = await({ next.state.value }) { it is CloudUploadModel.State.Ready }
                as CloudUploadModel.State.Ready
            assertTrue(ready.link.startsWith("$origin/d/obj"))
            assertEquals(1, server.initCount)
        }
    }

    @Test
    fun `a published object whose key could not be filed keeps its job and says so`() {
        ResumableUploadServer().use { server ->
            val account = account()
            signIn(account)
            val store = pendingStore()
            linkBox.sealFails = true
            val model = model(server, account, store, linkKeys())
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Ready }
            assertEquals(CloudUploadModel.Notice.LINK_KEY_NOT_SAVED, model.notice.value)

            // The job is NOT removed: its directory holds the only copy of the
            // key to an object the account is already paying for.
            val kept = pendingStore().pending("user0000000000000000000000000000")
                ?: pendingStore().pending(account.session.authority()!!.accountId)
            assertNotNull(kept)
            assertNotNull(kept!!.finalizedStoredId)
            assertFalse(kept.linkKeyCommitted)
        }
    }

    @Test
    fun `a finished upload files its key so the file list can rebuild the link`() {
        ResumableUploadServer().use { server ->
            val account = account()
            signIn(account)
            val keys = linkKeys()
            val model = model(server, account, pendingStore(), keys)
            startUpload(model)
            val ready = await({ model.state.value }) { it is CloudUploadModel.State.Ready }
                as CloudUploadModel.State.Ready

            val accountId = account.session.authority()!!.accountId
            val record = keys.record(accountId, "obj00000000000000000000000000000")
            assertNotNull(record)
            assertEquals(ready.link.substringAfter("#k="), record!!.keyB64url)
            // And the job is gone, because everything it held is now held twice.
            assertNull(pendingStore().pending(accountId))
        }
    }

    @Test
    fun `a small selection keeps the single-shot path and still files its key`() {
        ResumableUploadServer().use { server ->
            val account = account()
            signIn(account)
            val keys = linkKeys()
            // The production threshold, so this asserts the real routing rule.
            val model = model(
                server, account, pendingStore(), keys,
                threshold = CloudUploadModel.RESUMABLE_MIN_BYTES,
            )
            startUpload(model, listOf(CloudSelection("content://x/1", "tiny.bin", 64)))
            await({ model.state.value }) { it is CloudUploadModel.State.Ready }

            // Nothing was staged and no resumable session was opened.
            assertEquals(0, server.initCount)
            assertEquals(1, server.singleShotCount)
            val accountId = account.session.authority()!!.accountId
            assertNull(pendingStore().pending(accountId))
            // The link is still filed, so the file list can rebuild it.
            assertNotNull(keys.record(accountId, "obj00000000000000000000000000000"))
        }
    }

    @Test
    fun `staging cancelled part-way leaves nothing behind`() {
        ResumableUploadServer().use { server ->
            val account = account()
            signIn(account)
            val store = pendingStore()
            val gate = Object()
            val model = model(server, account, store, linkKeys(), open = { pick ->
                object : PlaintextSource {
                    override val name = pick.name
                    override val size = pick.size
                    private var served = 0L
                    override fun read(max: Int): ByteArray {
                        // Block after the first chunk, so cancellation lands
                        // while a provider read is outstanding — the case a
                        // watcher, not a status check, has to unblock.
                        if (served > 0) synchronized(gate) { gate.wait(4_000) }
                        val n = minOf(max.toLong(), size - served).toInt()
                        served += n
                        return ByteArray(n)
                    }
                }
            })
            startUpload(model, listOf(CloudSelection("content://x/1", "big.bin", 4_000_000)))
            await({ model.state.value }) { it is CloudUploadModel.State.Staging }
            model.reset()
            synchronized(gate) { gate.notifyAll() }

            await({ model.state.value }) { it is CloudUploadModel.State.Idle }
            // The abandon unwinds on the IO dispatcher after the state has
            // already returned to Idle, so the assertion waits for the bytes
            // rather than for the screen.
            await({ File(root, "pending").listFiles()?.size ?: 0 }) { it == 0 }
            assertNull(store.pending(account.session.authority()!!.accountId))
            assertEquals(0, server.initCount)
        }
    }

    @Test
    fun `an account that leaves takes its staged job off the screen without deleting it`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            val account = account()
            signIn(account)
            val store = pendingStore()
            server.refuseAppendsAfter = 100_000
            val model = model(server, account, store, linkKeys())
            observeAccount(account, model)
            startUpload(model)
            val offered = await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }
            assertNotNull(offered)
            val accountId = account.session.authority()!!.accountId

            account.session.signOut()
            await({ model.state.value }) { it is CloudUploadModel.State.Idle }

            // Hidden, not shredded: signing out is not a destructive act, and
            // the same account signing back in finds its upload where it was.
            assertNotNull(pendingStore().pending(accountId))
        }
    }

    @Test
    fun `a staged job whose key this device cannot read offers only a discard`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            val account = account()
            signIn(account)
            server.refuseAppendsAfter = 100_000
            val model = model(server, account, pendingStore(), linkKeys())
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }

            box.openFails = true
            val next = model(server, account, pendingStore(), linkKeys())
            next.recoverPendingJob()
            // Unreadable records are counted as device data rather than silently
            // deleted, so the job is not offered and the device state is stated.
            await({ next.strandedDeviceData.value }) { it }
        }
    }

    @Test
    fun `a spool altered after staging refuses to send and offers only a discard`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            val account = account()
            signIn(account)
            server.refuseAppendsAfter = 100_000
            val model = model(server, account, pendingStore(), linkKeys())
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }
            server.refuseAppendsAfter = Long.MAX_VALUE

            // Something altered the staged ciphertext. Re-encrypting the user's
            // current files under the same key and frame sequence is the one
            // repair that must never happen, so there is no repair.
            val accountId = account.session.authority()!!.accountId
            val plan = pendingStore().pending(accountId)!!
            val spool = File(File(File(root, "pending"), plan.jobId), PendingUploadStore.SPOOL)
            val bytes = spool.readBytes()
            bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0xff).toByte()
            spool.writeBytes(bytes)

            val committedBefore = server.committed
            val next = model(server, account, pendingStore(), linkKeys())
            next.recoverPendingJob()
            await({ next.state.value }) { it is CloudUploadModel.State.Interrupted }
            next.resumePending()
            val refused = await({ next.state.value }) {
                it is CloudUploadModel.State.Interrupted &&
                    it.failure?.kind == CloudFailure.Kind.SPOOL_UNUSABLE
            } as CloudUploadModel.State.Interrupted

            assertFalse(refused.resumable)
            assertEquals(committedBefore, server.committed)
            assertEquals(0, server.finalizeCount)
        }
    }

    @Test
    fun `an account that leaves during the key write is not shown the link`() {
        ResumableUploadServer().use { server ->
            val account = account()
            signIn(account)
            val model = model(
                server, account, pendingStore(), linkKeys(),
                // The production threshold, so this is the accepted single-shot
                // path: one request, then the newly-added key write.
                threshold = CloudUploadModel.RESUMABLE_MIN_BYTES,
            )
            observeAccount(account, model)

            // The barrier sits inside the ONE await this path gained: filing the
            // finished object's key. Everything before it was already fenced;
            // an admission taken before an await does not authorise what happens
            // after it.
            linkBox.sealGate = "relayium/stored-link-key/"
            startUpload(model, listOf(CloudSelection("content://x/1", "tiny.bin", 64)))
            await({ linkBox.sealGateEntries }) { it > 0 }
            assertEquals(1, server.singleShotCount)

            // The account leaves while the key is being written.
            account.session.signOut()
            await({ account.session.state.value }) {
                it is com.relayium.android.account.AccountState.SignedOut
            }
            linkBox.releaseSeal()

            // The object exists and the key stays written under the account that
            // paid for it — neither is undone. What must not happen is the link
            // appearing under a session that is no longer there.
            await({ model.state.value }) { it !is CloudUploadModel.State.Uploading }
            Thread.sleep(300)
            assertFalse(
                "a link may not be presented after its account left, ${'$'}{model.state.value}",
                model.state.value is CloudUploadModel.State.Ready,
            )
        }
    }

    @Test
    fun `a discard whose tombstone cannot be written deletes nothing and offers the job again`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            server.refuseAppendsAfter = 100_000
            val account = account()
            signIn(account)
            val store = pendingStore()
            val model = model(server, account, store, linkKeys())
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }
            val accountId = account.session.authority()!!.accountId
            val before = pendingStore().pending(accountId)
            assertNotNull(before)

            // The device cannot record the decision.
            box.sealFails = true
            model.discardPending()
            // The NOTICE is what moves here: the screen was already showing this
            // job, so waiting on the state alone would match the value it had
            // before the discard was even attempted.
            await({ model.notice.value }) { it == CloudUploadModel.Notice.CLEANUP_FAILED }
            val restored = model.state.value as CloudUploadModel.State.Interrupted

            // Nothing was deleted, the job is offered again, and the failure is
            // stated rather than looking like a discard that worked.
            assertTrue(restored.resumable)
            box.sealFails = false
            val after = pendingStore().pending(accountId)
            assertNotNull(after)
            assertEquals(before!!.jobId, after!!.jobId)
            assertFalse(after.retired)
        }
    }

    @Test
    fun `a discarded job is not resurrected by the writer that was still unwinding`() {
        ResumableUploadServer(chunkSize = 40_000).use { server ->
            val account = account()
            signIn(account)
            val store = pendingStore()
            server.refuseAppendsAfter = 100_000
            val model = model(server, account, store, linkKeys())
            startUpload(model)
            await({ model.state.value }) { it is CloudUploadModel.State.Interrupted }
            val accountId = account.session.authority()!!.accountId
            val plan = pendingStore().pending(accountId)!!

            model.discardPending()
            await({ model.state.value }) { it is CloudUploadModel.State.Idle }
            await({ File(root, "pending").listFiles()?.size ?: 0 }) { it == 0 }

            // The store itself is what refuses: a plan whose file is gone is not
            // rewritten from a caller's stale copy, so a coroutine that was
            // still unwinding cannot put the directory back.
            val stale = runCatching { store.setSession(plan, "later00000000000000000000000000", 8192) }
            assertTrue("a removed job must not be rewritten", stale.isFailure)
            assertEquals(0, File(root, "pending").listFiles()?.size ?: 0)
            assertNull(pendingStore().pending(accountId))
        }
    }
}
