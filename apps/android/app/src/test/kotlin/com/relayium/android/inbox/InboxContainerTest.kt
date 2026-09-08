package com.relayium.android.inbox

import com.relayium.android.cloud.FakeSecretBox
import com.relayium.android.cloud.ScriptedDurableFiles
import com.relayium.protocol.inbox.InboxManifest
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
 * The app-owned received container, and the message store beside it.
 *
 * `receiveDirReady` is reported to central and decides whether a sender is told
 * their file will land, so the probe has to answer the question actually being
 * asked — "can a delivery be written here right now" — rather than a question
 * about permission bits.
 */
class InboxContainerTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val secrets = FakeSecretBox()
    private val files = ScriptedDurableFiles()
    private val account = InboxAccountId("0000111122223333444455556666aaaa")
    private val other = InboxAccountId("9999888877776666555544443333bbbb")

    private fun container() = InboxContainer(folder.root, files)

    // ── the container ───────────────────────────────────────────────────────

    @Test
    fun `each account gets its own received directory`() {
        val container = container()
        assertFalse(container.directory(account).path == container.directory(other).path)
        assertTrue(container.directory(account).path.contains(account.value))
        // The staging area sits INSIDE the received directory, which is what
        // makes the commit a same-filesystem link rather than a copy.
        assertTrue(
            container.staging(account, InboxFixtures.TASK_ID).path
                .startsWith(container.directory(account).path),
        )
        // Journals and messages sit OUTSIDE it, so a manifest name can never
        // collide with one.
        assertFalse(
            container.journals(account).path.startsWith(container.directory(account).path),
        )
        assertFalse(
            container.messages(account).path.startsWith(container.directory(account).path),
        )
    }

    /** A real create-and-remove, not an inspection. */
    @Test
    fun `the probe creates the directory and reports it ready`() = runBlocking {
        val state = container().probe(account)
        assertTrue(state is InboxDirectoryState.Ready)
        assertTrue(state.canReceive)
        assertTrue(container().directory(account).isDirectory)
        // The probe file must not survive: the next delivery would otherwise see
        // an entry nobody delivered.
        assertFalse(File(container().directory(account), InboxContainer.PROBE).exists())
    }

    @Test
    fun `the probe is idempotent`() = runBlocking {
        assertTrue(container().probe(account).canReceive)
        assertTrue(container().probe(account).canReceive)
    }

    /**
     * Something that is not a directory occupying the name belongs to the user,
     * so it is refused rather than removed — and central is told this device
     * cannot receive, which is the truthful answer.
     */
    @Test
    fun `a file occupying the directory name is refused, not replaced`() = runBlocking {
        val directory = container().directory(account)
        directory.parentFile?.mkdirs()
        directory.writeText("not a directory")

        val state = container().probe(account)
        assertEquals(
            InboxDirectoryState.Unavailable.Problem.NOT_A_DIRECTORY,
            (state as InboxDirectoryState.Unavailable).problem,
        )
        assertFalse(state.canReceive)
        assertNull(state.directoryOrNull)
        assertEquals("not a directory", directory.readText())
    }

    /**
     * A container whose directory cannot be created at all.
     *
     * Reached here by putting a regular FILE where a parent directory has to go,
     * which is a real shape a restore or a stray write can leave behind. The
     * answer central needs is simply "this device cannot receive"; it must not
     * be an exception escaping into a heartbeat.
     */
    @Test
    fun `a container whose directory cannot be created reports unavailable`() = runBlocking {
        val blocked = File(folder.root, "blocked")
        blocked.parentFile?.mkdirs()
        blocked.writeText("a file where a directory must go")

        val state = InboxContainer(blocked, files).probe(account)
        assertFalse(state.canReceive)
        assertTrue(state is InboxDirectoryState.Unavailable)
        assertEquals("a file where a directory must go", blocked.readText())
    }

    // ── the message store ───────────────────────────────────────────────────

    private fun messages(forAccount: InboxAccountId = account) =
        InboxMessageStore(File(folder.root, "messages"), forAccount, secrets, files)

    /**
     * A message is committed HERE, not as a file in the received directory.
     *
     * `inbox.text.v1` is a promise to the sender that this receiver presents
     * text as text; a build that wrote `.txt` files and announced it would be
     * making that promise falsely.
     */
    @Test
    fun `a message round-trips and never touches the received directory`() = runBlocking {
        val store = messages()
        store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "hello 世界", 1_700_000_100)
        val read = requireNotNull(store.read(InboxFixtures.TASK_ID))
        assertEquals("hello 世界", read.text)
        assertEquals(InboxFixtures.OTHER_DEVICE_ID, read.senderDeviceId)
        assertFalse(container().directory(account).exists())
    }

    /** The body is the user's own content and must not reach a diagnostic. */
    @Test
    fun `a message redacts its body`() {
        val message = InboxMessage(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "secret", 1)
        assertFalse(message.toString().contains("secret"))
    }

    /**
     * Keyed by task id, so a crash between committing the message and
     * journalling it costs a re-download that rewrites the SAME record at the
     * SAME name. The window produces a duplicate of nothing.
     */
    @Test
    fun `committing the same task twice replaces rather than duplicates`() = runBlocking {
        val store = messages()
        store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "first", 1_700_000_100)
        store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "first", 1_700_000_200)
        assertEquals(1, store.all().size)
        assertEquals("first", requireNotNull(store.read(InboxFixtures.TASK_ID)).text)
    }

    @Test
    fun `text outside the protocol bounds is refused`() = runBlocking {
        val store = messages()
        val e = try {
            store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "", 1_700_000_100)
            null
        } catch (thrown: InboxMessageException) {
            thrown
        }
        assertEquals(InboxMessageReason.MALFORMED_TEXT, e?.reason)
        assertFalse(InboxMessageStore.isAcceptable(""))
        assertFalse(
            InboxMessageStore.isAcceptable("a".repeat(InboxManifest.MAX_TEXT_BYTES.toInt() + 1)),
        )
        assertTrue(InboxMessageStore.isAcceptable("a"))
    }

    /** A record moved between accounts must fail to open rather than being shown
     *  under the wrong conversation. */
    @Test
    fun `a message is not readable under another account`() = runBlocking {
        messages().commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "mine", 1_700_000_100)
        val e = try {
            messages(other).read(InboxFixtures.TASK_ID)
            null
        } catch (thrown: InboxMessageException) {
            thrown
        }
        assertEquals(InboxMessageReason.UNREADABLE, e?.reason)
    }

    /** Removal is the user's decision, never a timer's: a message IS the
     *  delivery, not bookkeeping about one. */
    @Test
    fun `a message is removed only when asked`() = runBlocking {
        val store = messages()
        store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "keep me", 1_700_000_100)
        assertTrue(store.delete(InboxFixtures.TASK_ID))
        assertNull(store.read(InboxFixtures.TASK_ID))
        assertFalse("deleting twice is not an error", store.delete(InboxFixtures.TASK_ID))
    }

    @Test
    fun `an unreadable record does not hide the others`() = runBlocking {
        val store = messages()
        store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "good", 1_700_000_100)
        store.commit(InboxFixtures.STORED_ID, InboxFixtures.OTHER_DEVICE_ID, "also good", 1_700_000_200)
        val broken = File(File(folder.root, "messages"), "${InboxFixtures.TASK_ID}.json")
        broken.writeBytes(broken.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })

        val all = store.all()
        assertEquals(1, all.size)
        assertEquals("also good", all.single().text)
        assertNotNull(store.read(InboxFixtures.STORED_ID))
    }

    @Test
    fun `messages are listed newest first`() = runBlocking {
        val store = messages()
        store.commit(InboxFixtures.TASK_ID, InboxFixtures.OTHER_DEVICE_ID, "older", 1_700_000_100)
        store.commit(InboxFixtures.STORED_ID, InboxFixtures.OTHER_DEVICE_ID, "newer", 1_700_000_900)
        assertEquals(listOf("newer", "older"), store.all().map { it.text })
    }
}
