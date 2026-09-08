package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.stored.PlaintextSource
import java.io.Closeable
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One adopted account's Inbox, assembled once and pinned.
 *
 * Every field here is bound to ONE account and ONE bearer, including the two
 * transports and the directories the stores write to. That is the point of the
 * type: an account switch replaces the whole bundle rather than reassigning
 * parts of it, so there is no window in which a store from one account is
 * reachable through a transport authenticated as another.
 *
 * [deviceId] is central's answer to "which row is Current", never the first row
 * of a list — see [InboxServiceFactory].
 */
class InboxServices(
    val account: InboxAccountId,
    val deviceId: String,
    val deviceName: String,
    val device: InboxDeviceTransport,
    val sender: InboxSenderTransport,
    val keys: InboxKeyStoring,
    val container: InboxContainer,
    val journals: InboxJournalStore,
    val messages: InboxMessageStore,
    /** What this device SENT, so its own history can show it. Keyed by job id,
     *  never by task id: it is the sender's record, not a copy of a delivery. */
    val outgoing: InboxOutgoingTextStore,
    val conversations: InboxConversationStore,
    val sendStore: InboxSendStore,
    val preparer: InboxSendPreparer,
    val coordinator: InboxSendCoordinator,
    val policies: InboxPolicyStore,
    val sources: InboxSourceOpener,
    /**
     * Free space for the receive preflight, or null when it cannot be
     * determined.
     *
     * Null is NOT zero: an unknown answer must let a delivery proceed and be
     * decided by the write itself, while a zero would report `disk_full` for a
     * device that has plenty of room.
     */
    val freeBytes: () -> Long?,
    /** Builds a receive pass bound to this account. The scheduling inputs are
     *  the runtime's, so they are supplied per worker rather than pinned here. */
    val engine: (
        policy: () -> InboxAutoAccept,
        onPending: (List<InboxTaskRow>) -> Unit,
        onDelivered: suspend (InboxJournal) -> Unit,
    ) -> InboxReceiveEngine,
)

/**
 * Builds an account's services from a verified bearer.
 *
 * The implementation must resolve the CURRENT device row from central and pin
 * it: a native client cannot assume its device id, and picking a row would mean
 * enrolling, keying and claiming under an identity the protocol never named.
 */
fun interface InboxServiceFactory {
    suspend fun open(account: InboxAccountId, bearer: String): InboxServices
}

/**
 * A reference to something the user chose to send, before it is opened.
 *
 * Carries what the manifest commits to — the name and the size — so a staging
 * decision can be made, and refused, without holding a descriptor open.
 */
data class InboxSourceRef(val uri: String, val name: String, val size: Long) {
    /** No URI: it can carry a grant and a provider path. */
    override fun toString(): String = "InboxSourceRef($name, $size bytes)"
}

/** A chosen source could not be opened. Carries the INDEX, never the name. */
class InboxSourceException(val index: Int) :
    RuntimeException("relayium inbox: source $index could not be opened")

/**
 * Opens what the user chose, for exactly as long as the caller needs it.
 *
 * A block rather than a returned list, because [InboxSendPreparer] deliberately
 * does not close what it reads: somebody has to own those descriptors across a
 * cancellation, and splitting the lifetime between an opener and a preparer is
 * how a provider read ends up blocked on a stream nobody will close. Here the
 * streams are opened, used and closed inside one scope — so cancelling the
 * caller closes them under a blocked read, which is what unblocks it.
 */
interface InboxSourceOpener {
    suspend fun <T> withSources(
        refs: List<InboxSourceRef>,
        body: suspend (List<PlaintextSource>) -> T,
    ): T
}

/**
 * Owns the descriptors of one staging, and closes them the instant the caller is
 * cancelled.
 *
 * This is the part a `finally` cannot do. A `finally` runs when the block
 * RETURNS — and the block is exactly what is stuck, blocked inside a provider
 * read in another process. Closing from a completion handler instead runs
 * CONCURRENTLY with that blocked read, and closing the descriptor is what
 * actually ends it.
 *
 * [add] closes a resource it cannot accept rather than returning it, so a
 * descriptor opened after the lease closed — the race where a cancellation lands
 * mid-`openFileDescriptor` — is never leaked to a caller that will not close it.
 */
class InboxSourceLease {

    private val open = ArrayList<Closeable>()
    private var closed = false

    /** Take ownership. False means the lease had already closed and [resource]
     *  has been closed with it. */
    fun add(resource: Closeable): Boolean {
        synchronized(this) {
            if (!closed) {
                open.add(resource)
                return true
            }
        }
        closeQuietly(resource)
        return false
    }

    /** Close everything owned, once. Safe from any thread, including while a
     *  read is blocked on one of these descriptors. */
    fun closeAll() {
        val ending = synchronized(this) {
            if (closed) return
            closed = true
            val copy = ArrayList(open)
            open.clear()
            copy
        }
        for (resource in ending) closeQuietly(resource)
    }

    private fun closeQuietly(resource: Closeable) {
        try {
            resource.close()
        } catch (e: IOException) {
            // A descriptor that will not close is the platform's problem; the
            // remaining ones still must.
        } catch (e: RuntimeException) {
            // Same, for a provider that throws something else on close.
        }
    }
}

/**
 * The lifetime half of [InboxSourceOpener], with the platform half injected.
 *
 * Split so the ownership rules — register before handing back, close on
 * cancellation concurrently with a blocked read, refuse a resource opened after
 * the lease closed — are testable against a real blocking descriptor on the JVM
 * rather than only against a `ContentResolver`.
 */
class InboxLeasedSources(
    /**
     * Where the closing watcher runs.
     *
     * NOT the dispatcher doing the reading. The whole point is to close a
     * descriptor while a thread is blocked on it, so the closer must be able to
     * run on a thread the read is not occupying. First, so [open] stays the
     * trailing lambda.
     */
    private val watchOn: CoroutineDispatcher = Dispatchers.Default,
    private val open: suspend (InboxSourceRef, InboxSourceLease) -> PlaintextSource?,
) : InboxSourceOpener {

    override suspend fun <T> withSources(
        refs: List<InboxSourceRef>,
        body: suspend (List<PlaintextSource>) -> T,
    ): T = coroutineScope {
        val lease = InboxSourceLease()
        // A CHILD coroutine, not a completion handler. `invokeOnCompletion`
        // fires when the job COMPLETES — and a job blocked inside a provider
        // read cannot complete, so the close it was supposed to perform would
        // wait for the very thing it exists to interrupt. Cancellation, by
        // contrast, reaches children at the moment it is requested: this
        // watcher is resumed on another dispatcher and closes the descriptors
        // out from under the blocked read, which is what ends it.
        val watcher = launch(watchOn, start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                lease.closeAll()
            }
        }
        try {
            val sources = ArrayList<PlaintextSource>(refs.size)
            for ((index, ref) in refs.withIndex()) {
                currentCoroutineContext().ensureActive()
                sources.add(open(ref, lease) ?: throw InboxSourceException(index))
            }
            body(sources)
        } finally {
            watcher.cancel()
            lease.closeAll()
        }
    }
}

/**
 * This device's receive policy for one account, durable and default OFF.
 *
 * Not sealed, and deliberately: it holds a choice from a closed three-value set
 * and no user content. What it must do is fail CLOSED — a policy file that
 * cannot be read means OFF, never the last value someone remembers, because the
 * failure mode of guessing is a device that receives on a permission its owner
 * may have withdrawn.
 */
class InboxPolicyStore(
    val directory: File,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val file get() = File(directory, FILE_NAME)

    suspend fun read(): InboxAutoAccept = withContext(io) {
        val raw = try {
            if (!file.isFile || file.length() > MAX_BYTES) return@withContext InboxAutoAccept.OFF
            file.readText(Charsets.UTF_8).trim()
        } catch (e: IOException) {
            return@withContext InboxAutoAccept.OFF
        }
        InboxAutoAccept.entries.firstOrNull { it.wire == raw } ?: InboxAutoAccept.OFF
    }

    /** Durable before the caller acts on it: a policy that reached central but
     *  not this disk would come back as OFF on the next launch and stop a device
     *  its owner had switched on. */
    suspend fun write(policy: InboxAutoAccept) = withContext(io) {
        files.createDirectories(directory)
        files.writeAtomically(file, policy.wire.toByteArray(Charsets.UTF_8))
    }

    private companion object {
        const val FILE_NAME = "receive-policy"
        const val MAX_BYTES = 64L
    }
}
