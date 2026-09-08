package com.relayium.android.cloud

import com.relayium.android.account.AccountClient
import com.relayium.android.account.AccountSession
import com.relayium.android.account.FakeTransport
import com.relayium.android.account.FlakyTokenStore
import com.relayium.protocol.stored.BytesSource
import com.relayium.protocol.stored.PlaintextSource
import com.relayium.protocol.stored.decodeStoreKey
import com.relayium.protocol.stored.decryptManifestRaw
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The upload model's fences, against a real HTTP server and a real
 * [AccountSession].
 *
 * Real dispatchers rather than virtual time, deliberately: the assertions here
 * are about an answer that lands after the account moved, and the round trip
 * that has to land is a socket write on an IO thread. A virtual clock cannot
 * advance it, and a fake client would not exercise the thing that matters —
 * that the link is composed from THIS app's origin and the server's own expiry,
 * and is withheld entirely when the account is no longer the one that paid for
 * the upload.
 */
class CloudUploadModelTest {

    private val executor = Executors.newSingleThreadExecutor()
    private val owner = executor.asCoroutineDispatcher()
    private val ioExecutor = Executors.newCachedThreadPool()
    private val io = ioExecutor.asCoroutineDispatcher()
    private val scope = CoroutineScope(owner)
    private val origin = "https://relayium.com"

    @After
    fun tearDown() {
        scope.cancel()
        owner.close()
        io.close()
        executor.shutdownNow()
        ioExecutor.shutdownNow()
    }

    private class Account(val transport: FakeTransport, val session: AccountSession)

    private fun account(scope: CoroutineScope, owner: kotlinx.coroutines.CoroutineDispatcher): Account {
        val transport = FakeTransport()
            .answer("api/auth/native/login", 200, com.relayium.android.account.loginBody())
            .answer("api/me", 200, com.relayium.android.account.meBody())
            .answer("api/me/usage", 200, com.relayium.android.account.usageBody())
            .answer("api/auth/logout", 200, "")
        val session = AccountSession(scope, owner, owner, AccountClient(transport), FlakyTokenStore(), "Pixel")
        return Account(transport, session)
    }

    private fun model(
        server: RecordingHttpServer,
        account: Account,
        open: (CloudSelection) -> PlaintextSource? = { BytesSource(it.name, ByteArray(it.size.toInt())) },
    ) = CloudUploadModel(
        scope = scope,
        owner = owner,
        io = io,
        client = CloudClient(server.origin, "relayium-test/1"),
        session = account.session,
        origin = origin,
        open = open,
    )

    /** Wait for a state the test is actually about, rather than sleeping. */
    private fun <T> await(get: () -> T, timeoutMs: Long = 5_000, predicate: (T) -> Boolean): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val value = get()
            if (predicate(value)) return value
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting; last was ${get()}")
    }

    private fun signIn(account: Account) {
        account.session.signIn("a@example.invalid", "pw")
        await({ account.session.state.value }) { it is com.relayium.android.account.AccountState.Ready }
    }

    private fun uploadServer(id: String = "abc123", expiresAt: Long = 1_700_000_000) =
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"$id","expiresAt":$expiresAt}""".toByteArray())
        }

    private val selection = listOf(
        CloudSelection("content://x/1", "hello.txt", 11),
        CloudSelection("content://x/2", "b.txt", 3),
    )

    @Test
    fun `a finished upload yields a link on this app's own origin and the server's expiry`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val ready = await({ model.state.value }) { it is CloudUploadModel.State.Ready }
                    as CloudUploadModel.State.Ready

            // The origin is THIS app's, never anything the server said, and the
            // expiry is the server's own answer rather than the requested TTL.
            assertTrue(ready.link.startsWith("$origin/d/abc123#k="))
            assertEquals(1_700_000_000L, ready.expiresAt)
            assertEquals(2, ready.files)

            // The link really opens the object: its key decrypts the manifest
            // the server was actually sent.
            val key = decodeStoreKey(ready.link.substringAfter("#k="))
            val body = server.received.single().body
            val length = ((body[0].toInt() and 0xff) shl 24) or ((body[1].toInt() and 0xff) shl 16) or
                ((body[2].toInt() and 0xff) shl 8) or (body[3].toInt() and 0xff)
            val manifest = decryptManifestRaw(key, body.copyOfRange(4, 4 + length))
            assertEquals(listOf("hello.txt", "b.txt"), manifest.files.map { it.name })
        }
    }

    @Test
    fun `each upload uses a fresh key`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            val keys = (1..2).map {
                model.select(selection, model.beginSelection())
                await({ model.state.value }) { s -> s is CloudUploadModel.State.Selected }
                model.upload()
                val ready = await({ model.state.value }) { s -> s is CloudUploadModel.State.Ready }
                        as CloudUploadModel.State.Ready
                ready.link.substringAfter("#k=").also { model.reset() }
            }
            assertFalse("a reused key would reuse a nonce across different files", keys[0] == keys[1])
        }
    }

    @Test
    fun `retention and burn-after-read reach the server as chosen`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.chooseRetention(CloudRetention.TWO_WEEKS)
            model.chooseBurnAfterRead(true)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            await({ model.state.value }) { it is CloudUploadModel.State.Ready }
            assertEquals("burnAfterRead=1&ttl=1209600", server.received.single().query)
        }
    }

    @Test
    fun `an upload with no session never reaches the network`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            val model = model(server, account)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            assertEquals(CloudFailure.Kind.NOT_SIGNED_IN, failed.failure.kind)
            assertTrue(server.received.isEmpty())
        }
    }

    @Test
    fun `an upload that outlived its account is never presented under another`() {
        // The object was created and METERED against the signed-in account. By
        // the time the answer lands the session has gone, so showing the link
        // would attach one account's file to whoever is here now.
        val gate = java.util.concurrent.CountDownLatch(1)
        RecordingHttpServer { _, out ->
            gate.await(10, java.util.concurrent.TimeUnit.SECONDS)
            RecordingHttpServer.respond(out, body = """{"id":"abc123","expiresAt":1}""".toByteArray())
        }.use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            await({ model.state.value }) { it is CloudUploadModel.State.Uploading }

            account.session.signOut()
            await({ account.session.state.value }) {
                it !is com.relayium.android.account.AccountState.Ready
            }
            gate.countDown()

            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            assertEquals(CloudFailure.Kind.STALE_ACCOUNT, failed.failure.kind)
        }
    }

    @Test
    fun `a selection the wire would refuse fails before anything is uploaded`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.select(listOf(CloudSelection("content://x/1", "", 4)), model.beginSelection())
            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            assertEquals(CloudFailure.Kind.MALFORMED, failed.failure.kind)
            assertTrue(server.received.isEmpty())
        }
    }

    @Test
    fun `a document that cannot be opened fails without a partial upload`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account, open = { null })
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            await({ model.state.value }) { it is CloudUploadModel.State.Failed }
            assertTrue(server.received.isEmpty())
        }
    }

    @Test
    fun `a server refusal is reported as itself`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, status = "429 Too Many Requests", body = "daily quota exceeded".toByteArray())
        }.use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            assertEquals(CloudFailure.Kind.DAILY_QUOTA, failed.failure.kind)
        }
    }

    @Test
    fun `a finished upload does not print its link`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val ready = await({ model.state.value }) { it is CloudUploadModel.State.Ready }
                    as CloudUploadModel.State.Ready
            val printed = ready.toString()
            assertFalse("the fragment carries the key", printed.contains("#k="))
            assertFalse(printed.contains(ready.link.substringAfter("#k=")))
        }
    }

    @Test
    fun `uploaded bytes are exactly the chosen documents`() {
        val contents = mapOf(
            "hello.txt" to "hello world".toByteArray(),
            "b.txt" to "xyz".toByteArray(),
        )
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account, open = { BytesSource(it.name, contents.getValue(it.name)) })
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val ready = await({ model.state.value }) { it is CloudUploadModel.State.Ready }
                    as CloudUploadModel.State.Ready

            val key = decodeStoreKey(ready.link.substringAfter("#k="))
            val body = server.received.single().body
            val length = ((body[0].toInt() and 0xff) shl 24) or ((body[1].toInt() and 0xff) shl 16) or
                ((body[2].toInt() and 0xff) shl 8) or (body[3].toInt() and 0xff)
            val decryptor = com.relayium.protocol.stored.StoreDecryptor(key)
            val chunks = decryptor.push(body.copyOfRange(4 + length, body.size))
            decryptor.end(14)
            assertArrayEquals(
                contents.getValue("hello.txt") + contents.getValue("b.txt"),
                chunks.reduce { a, b -> a + b },
            )
        }
    }

    @Test
    fun `a document opened after the upload was abandoned is still closed`() {
        // The cancellation-delivery leak: `withContext` refuses to hand a result
        // to a cancelled caller, so a source that finished opening after a reset
        // is dropped on the floor — descriptor and all — unless ownership of the
        // list is established OUTSIDE that block.
        val opening = java.util.concurrent.CountDownLatch(1)
        val entered = java.util.concurrent.CountDownLatch(1)
        val closed = java.util.concurrent.atomic.AtomicInteger(0)
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account, open = {
                entered.countDown()
                opening.await(10, java.util.concurrent.TimeUnit.SECONDS)
                object : PlaintextSource {
                    override val name = it.name
                    override val size = it.size
                    override fun read(max: Int) = ByteArray(0)
                    override fun close() {
                        closed.incrementAndGet()
                    }
                }
            })
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            assertTrue("the provider open must have started", entered.await(5, java.util.concurrent.TimeUnit.SECONDS))

            model.reset()
            await({ model.state.value }) { it is CloudUploadModel.State.Idle }
            // Only now does the provider hand back a live source.
            opening.countDown()

            await({ closed.get() }, timeoutMs = 5_000) { it >= 1 }
            assertTrue("an abandoned upload must not leak a descriptor", closed.get() >= 1)
            assertTrue(server.received.isEmpty())
        }
    }

    @Test
    fun `cancelling closes a source whose own read is blocked`() {
        // The reader sits INSIDE `read` — a remote document provider is another
        // process — so the upload's own `finally` cannot run until that read
        // returns. Only closing the source from another thread unblocks it, and
        // this test requires the cancellation to complete BEFORE the fixture
        // releases the read, so a close that merely happened afterwards fails.
        val blocked = java.util.concurrent.CountDownLatch(1)
        val reading = java.util.concurrent.CountDownLatch(1)
        val closed = java.util.concurrent.CountDownLatch(1)
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"a","expiresAt":1}""".toByteArray())
        }.use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account, open = { selection ->
                object : PlaintextSource {
                    override val name = selection.name
                    override val size = selection.size
                    override fun read(max: Int): ByteArray {
                        reading.countDown()
                        // Released only by close(), exactly like a provider
                        // stream whose read ends when the stream is closed.
                        blocked.await(10, java.util.concurrent.TimeUnit.SECONDS)
                        return ByteArray(0)
                    }

                    override fun close() {
                        closed.countDown()
                        blocked.countDown()
                    }
                }
            })
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            assertTrue("the read must be blocked", reading.await(5, java.util.concurrent.TimeUnit.SECONDS))

            model.reset()
            assertTrue(
                "cancelling must close a source whose read is blocked",
                closed.await(5, java.util.concurrent.TimeUnit.SECONDS),
            )
        }
    }

    @Test
    fun `a file that fails while uploading is not reported as a network problem`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"a","expiresAt":1}""".toByteArray())
        }.use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account, open = { selection ->
                object : PlaintextSource {
                    override val name = selection.name
                    override val size = selection.size
                    override fun read(max: Int): ByteArray =
                        throw java.io.IOException("the provider gave up")
                }
            })
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            // The user's action is to check the file, not their connection.
            assertEquals(CloudFailure.Kind.SOURCE_FAILED, failed.failure.kind)
        }
    }

    @Test
    fun `a file that shrank against its manifest fails the upload`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = """{"id":"a","expiresAt":1}""".toByteArray())
        }.use { server ->
            val account = account(scope, owner)
            signIn(account)
            // Declares 11 bytes in the manifest, delivers 4.
            val model = model(server, account, open = { selection ->
                BytesSource(selection.name, ByteArray(4))
            })
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            assertEquals(CloudFailure.Kind.SOURCE_FAILED, failed.failure.kind)
        }
    }

    @Test
    fun `a slow picker result never lands on top of a newer one`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            val stale = model.beginSelection()
            val fresh = model.beginSelection()

            val newer = listOf(CloudSelection("content://x/9", "newer.txt", 5))
            model.select(newer, fresh)
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }

            // The first pick's metadata query finally finishes, long after the
            // user picked something else.
            model.select(selection, stale)
            Thread.sleep(100)
            val current = model.state.value as CloudUploadModel.State.Selected
            assertEquals(listOf("newer.txt"), current.files.map { it.name })

            // A stale FAILURE must not clobber the newer selection either.
            model.selectionUnreadable(stale)
            Thread.sleep(100)
            assertTrue(model.state.value is CloudUploadModel.State.Selected)
        }
    }

    @Test
    fun `an undescribable pick is reported rather than silently dropped`() {
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.selectionUnreadable(model.beginSelection())
            val failed = await({ model.state.value }) { it is CloudUploadModel.State.Failed }
                    as CloudUploadModel.State.Failed
            assertEquals(CloudFailure.Kind.UNREADABLE_SELECTION, failed.failure.kind)
        }
    }

    @Test
    fun `a shown link is withdrawn when the account changes`() {
        // The link is a capability for ONE account's files. The in-flight fence
        // cannot help here: the upload already succeeded.
        uploadServer().use { server ->
            val account = account(scope, owner)
            signIn(account)
            val model = model(server, account)
            model.select(selection, model.beginSelection())
            await({ model.state.value }) { it is CloudUploadModel.State.Selected }
            model.upload()
            await({ model.state.value }) { it is CloudUploadModel.State.Ready }

            account.session.signOut()
            await({ account.session.state.value }) {
                it !is com.relayium.android.account.AccountState.Ready
            }
            model.accountChanged()
            await({ model.state.value }) { it is CloudUploadModel.State.Idle }
        }
    }

}
