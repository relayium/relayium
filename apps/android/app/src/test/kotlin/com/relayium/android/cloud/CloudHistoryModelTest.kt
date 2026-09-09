package com.relayium.android.cloud

import com.relayium.android.account.AccountClient
import com.relayium.android.account.AccountSession
import com.relayium.android.account.AccountState
import com.relayium.android.account.FakeTransport
import com.relayium.android.account.FlakyTokenStore
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The account's stored files, against a real HTTP server, a real
 * [AccountSession] and a real key store.
 *
 * The questions are the ones the two sources of truth create: server rows are
 * facts, local keys are not, and neither may be reported as the other.
 */
class CloudHistoryModelTest {

    private val executor = Executors.newSingleThreadExecutor()
    private val owner = executor.asCoroutineDispatcher()
    private val ioExecutor = Executors.newCachedThreadPool()
    private val io = ioExecutor.asCoroutineDispatcher()
    private val scope = CoroutineScope(owner)
    private val origin = "https://relayium.com"
    private val root = File(System.getProperty("java.io.tmpdir"), "history-${System.nanoTime()}")
    private val box = FakeSecretBox()
    private val barriers = ScriptedDurableFiles()
    private val keys = StoredLinkKeyStore(root, box, barriers)

    @After
    fun tearDown() {
        scope.cancel()
        owner.close()
        io.close()
        executor.shutdownNow()
        ioExecutor.shutdownNow()
        root.deleteRecursively()
    }

    private fun session(): AccountSession {
        val transport = FakeTransport()
            .answer("api/auth/native/login", 200, com.relayium.android.account.loginBody())
            .answer("api/me", 200, com.relayium.android.account.meBody())
            .answer("api/me/usage", 200, com.relayium.android.account.usageBody())
            .answer("api/auth/logout", 200, "")
        return AccountSession(scope, owner, owner, AccountClient(transport), FlakyTokenStore(), "Pixel")
    }

    private fun <T> await(get: () -> T, timeoutMs: Long = 10_000, predicate: (T) -> Boolean): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val value = get()
            if (predicate(value)) return value
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting; last was ${get()}")
    }

    private fun signIn(session: AccountSession): String {
        session.signIn("a@example.invalid", "pw")
        await({ session.state.value }) { it is AccountState.Ready }
        return session.authority()!!.accountId
    }

    private val objectA = "aaaa0000000000000000000000000000"
    private val objectB = "bbbb0000000000000000000000000000"

    private fun listBody(vararg rows: String) = """{"files":[${rows.joinToString(",")}]}"""

    private fun row(
        id: String,
        size: Long = 1_234,
        createdAt: Long = 1_700_000_000,
        expiresAt: Long = 1_800_000_000,
        burn: Boolean = false,
        downloaded: Boolean = false,
        count: Long = 0,
    ) = """{"id":"$id","size":$size,"createdAt":$createdAt,"expiresAt":$expiresAt,""" +
        """"burnAfterRead":$burn,"downloaded":$downloaded,"downloadCount":$count}"""

    private fun model(server: RecordingHttpServer, session: AccountSession) = CloudHistoryModel(
        scope = scope,
        owner = owner,
        io = io,
        client = CloudClient(server.origin, "relayium-test/1"),
        session = session,
        origin = origin,
        keys = keys,
        now = { 1_700_000_100L },
    )

    @Test
    fun `server facts are read as the server writes them, links only where the key is here`() {
        val body = listBody(
            row(objectA, size = 9_001, burn = true, downloaded = true, count = 3),
            row(objectB),
        )
        RecordingHttpServer { _, out -> RecordingHttpServer.respond(out, body = body.toByteArray()) }
            .use { server ->
                val session = session()
                val account = signIn(session)
                keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)

                val model = model(server, session)
                model.refresh()
                val ready = await({ model.state.value }) { it is CloudHistoryModel.State.Ready }
                    as CloudHistoryModel.State.Ready

                val a = ready.entries.first { it.id == objectA }
                assertEquals(9_001L, a.size)
                // `downloaded` is a BOOLEAN the server derives from a timestamp
                // column, and the two dates are Unix seconds.
                assertTrue(a.downloaded)
                assertEquals(3L, a.downloadCount)
                assertTrue(a.burnAfterRead)
                assertEquals(1_700_000_000L, a.createdAt)
                assertEquals("$origin/d/$objectA#k=${"A".repeat(43)}", a.link)

                // The object with no key on this device is real, listed and
                // deletable — it simply has no link that can be rebuilt HERE.
                val b = ready.entries.first { it.id == objectB }
                assertNull(b.link)
                assertFalse(b.keyUnreadable)
            }
    }

    @Test
    fun `an unreadable key is stated, not reported as a key this device never had`() {
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = listBody(row(objectA)).toByteArray())
        }.use { server ->
            val session = session()
            val account = signIn(session)
            keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)
            box.openFails = true

            val model = model(server, session)
            model.refresh()
            val ready = await({ model.state.value }) { it is CloudHistoryModel.State.Ready }
                as CloudHistoryModel.State.Ready
            val entry = ready.entries.single()
            assertNull(entry.link)
            assertTrue(entry.keyUnreadable)
        }
    }

    @Test
    fun `an oversized list is refused rather than shown partially`() {
        val rows = (0 until CloudClient.MAX_HISTORY_ROWS + 1).map { row("id%027d".format(it)) }
        RecordingHttpServer { _, out ->
            RecordingHttpServer.respond(out, body = listBody(*rows.toTypedArray()).toByteArray())
        }.use { server ->
            val session = session()
            signIn(session)
            val model = model(server, session)
            model.refresh()
            val failed = await({ model.state.value }) { it is CloudHistoryModel.State.Failed }
                as CloudHistoryModel.State.Failed
            assertEquals(CloudFailure.Kind.HISTORY_TOO_LARGE, failed.failure.kind)
        }
    }

    @Test
    fun `history and delete carry the bearer on the redirect-refusing client`() {
        val seen = AtomicReference<RecordingHttpServer.Received?>(null)
        RecordingHttpServer { request, out ->
            if (request.method == "DELETE") {
                seen.set(request)
                RecordingHttpServer.respond(out, body = """{"status":"ok"}""".toByteArray())
            } else {
                RecordingHttpServer.respond(out, body = listBody(row(objectA)).toByteArray())
            }
        }.use { server ->
            val session = session()
            val account = signIn(session)
            keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)
            val model = model(server, session)
            model.refresh()
            await({ model.state.value }) { it is CloudHistoryModel.State.Ready }

            model.delete(objectA)
            await({ model.notice.value }) { it != null }
            assertEquals(CloudHistoryModel.Notice.DELETED, model.notice.value)
            assertNotNull(seen.get()!!.header("Authorization"))
            // The row goes at once, so the list never offers a delete over an
            // object this device has just removed.
            val ready = model.state.value as CloudHistoryModel.State.Ready
            assertTrue(ready.entries.isEmpty())
            // And the local key with it.
            assertNull(keys.record(account, objectA))
        }
    }

    @Test
    fun `a 404 delete is never reported as a deletion this device performed`() {
        RecordingHttpServer { request, out ->
            if (request.method == "DELETE") {
                RecordingHttpServer.respond(out, status = "404 Not Found", body = ByteArray(0))
            } else {
                RecordingHttpServer.respond(out, body = listBody(row(objectA)).toByteArray())
            }
        }.use { server ->
            val session = session()
            val account = signIn(session)
            keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)
            val model = model(server, session)
            model.refresh()
            await({ model.state.value }) { it is CloudHistoryModel.State.Ready }

            model.delete(objectA)
            await({ model.notice.value }) { it != null }
            // Missing, owned by somebody else, or not a share: the server
            // deliberately does not say, so neither does this.
            assertEquals(CloudHistoryModel.Notice.ALREADY_GONE, model.notice.value)
        }
    }

    @Test
    fun `a server failure on delete keeps the row and says what happened`() {
        RecordingHttpServer { request, out ->
            if (request.method == "DELETE") {
                RecordingHttpServer.respond(out, status = "500 Server Error", body = ByteArray(0))
            } else {
                RecordingHttpServer.respond(out, body = listBody(row(objectA)).toByteArray())
            }
        }.use { server ->
            val session = session()
            val account = signIn(session)
            keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)
            val model = model(server, session)
            model.refresh()
            await({ model.state.value }) { it is CloudHistoryModel.State.Ready }

            model.delete(objectA)
            val failed = await({ model.state.value }) { it is CloudHistoryModel.State.Failed }
                as CloudHistoryModel.State.Failed
            assertEquals(CloudFailure.Kind.SERVER, failed.failure.kind)
            assertNull(model.notice.value)
            assertNull(model.deleting.value)
            // The key is untouched: nothing was deleted.
            assertNotNull(keys.record(account, objectA))
        }
    }

    @Test
    fun `a list that lands after the account left is not shown`() {
        val gate = Object()
        RecordingHttpServer { _, out ->
            synchronized(gate) { gate.wait(5_000) }
            RecordingHttpServer.respond(out, body = listBody(row(objectA)).toByteArray())
        }.use { server ->
            val session = session()
            signIn(session)
            val model = model(server, session)
            model.refresh()
            await({ model.state.value }) { it is CloudHistoryModel.State.Loading }

            session.signOut()
            await({ session.state.value }) { it is AccountState.SignedOut }
            model.accountChanged()
            synchronized(gate) { gate.notifyAll() }

            // One account's files must never appear under another's session, so
            // a superseded answer writes nothing at all.
            Thread.sleep(300)
            assertTrue(model.state.value is CloudHistoryModel.State.Idle)
        }
    }

    @Test
    fun `an account change during a delete's local cleanup publishes nothing`() {
        RecordingHttpServer { request, out ->
            val body = if (request.method == "DELETE") """{"status":"ok"}""" else listBody(row(objectA))
            RecordingHttpServer.respond(out, body = body.toByteArray())
        }.use { server ->
            val session = session()
            val account = signIn(session)
            keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)
            val model = model(server, session)
            model.refresh()
            await({ model.state.value }) { it is CloudHistoryModel.State.Ready }

            // The barrier is the LOCAL CLEANUP, not the request.
            //
            // This test used to answer the DELETE and then hold the server
            // thread, which holds nothing: the client already had its response,
            // so the whole delete could finish before the first observation and
            // the busy marker this test is about was read after it was cleared.
            // `StoredLinkKeyStore.remove` syncs the account's directory after
            // unlinking the key, so parking exactly that sync stops the delete
            // where the title says it does — inside the local cleanup, with the
            // server's work already done and nothing left to undo.
            val idle = scope.coroutineContext.job.children.toSet()
            barriers.syncGate = File(root, account)
            try {
                model.delete(objectA)
                await({ barriers.gateEntries }) { it > 0 }
                // The delete's own coroutine, identified while it is the only
                // thing this scope has started since. Joining it is the finish
                // line; a counter incremented INSIDE the parked sync is not,
                // because it runs before the continuation is even dispatched.
                val deleting = (scope.coroutineContext.job.children.toSet() - idle).single()

                // Held there, and still observably busy. An observation delayed
                // after `delete` returns finds the same thing, which is what the
                // server-side gate could not promise.
                assertEquals(objectA, model.deleting.value)

                session.signOut()
                await({ session.state.value }) { it is AccountState.SignedOut }
                model.accountChanged()
                await({ model.state.value }) { it is CloudHistoryModel.State.Idle }
                assertNull(model.deleting.value)

                barriers.releaseGate()
                runBlocking { withTimeout(10_000) { deleting.join() } }

                // The server acted and nothing undoes that. What must not happen
                // is an outcome about one account's files appearing under the
                // next account's cleared screen — and the delete is now over, so
                // this is its final answer rather than a snapshot of its middle.
                assertTrue(model.state.value is CloudHistoryModel.State.Idle)
                assertNull(model.notice.value)
                assertNull(model.deleting.value)

                // ...and the cleanup really ran. Silence has to mean "did the
                // work and reported nothing", not "never got there".
                assertNull(keys.record(account, objectA))
            } finally {
                // A failed assertion must not leave a NonCancellable io block
                // parked on a barrier this test owns.
                barriers.releaseGate()
            }
        }
    }

    /**
     * The positive control for the barrier above.
     *
     * Same parked cleanup, same release, same join, and the ONLY difference is
     * that the account stays. If this did not publish, the silence asserted
     * above would be evidence about the barrier rather than about the account
     * change.
     */
    @Test
    fun `the same parked cleanup publishes normally when the account stays`() {
        RecordingHttpServer { request, out ->
            val body = if (request.method == "DELETE") """{"status":"ok"}""" else listBody(row(objectA))
            RecordingHttpServer.respond(out, body = body.toByteArray())
        }.use { server ->
            val session = session()
            val account = signIn(session)
            keys.save(account, objectA, "A".repeat(43), 1_800_000_000, 1)
            val model = model(server, session)
            model.refresh()
            await({ model.state.value }) { it is CloudHistoryModel.State.Ready }

            val idle = scope.coroutineContext.job.children.toSet()
            barriers.syncGate = File(root, account)
            try {
                model.delete(objectA)
                await({ barriers.gateEntries }) { it > 0 }
                val deleting = (scope.coroutineContext.job.children.toSet() - idle).single()
                assertEquals(objectA, model.deleting.value)
                assertNull(model.notice.value)

                barriers.releaseGate()
                runBlocking { withTimeout(10_000) { deleting.join() } }

                // Terminal, so every one of these is the delete's final answer.
                assertEquals(CloudHistoryModel.Notice.DELETED, model.notice.value)
                assertNull(model.deleting.value)
                assertNull(keys.record(account, objectA))
                val ready = model.state.value as CloudHistoryModel.State.Ready
                assertTrue(ready.entries.none { it.id == objectA })
            } finally {
                barriers.releaseGate()
            }
        }
    }
}
