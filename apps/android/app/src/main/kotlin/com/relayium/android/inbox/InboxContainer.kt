package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Where a received file lands: a fixed, account-scoped directory inside the
 * app's OWN storage.
 *
 * ## Why not a folder the user picked
 *
 * The macOS receiver writes into a directory chosen in an open panel and holds
 * it through a security-scoped bookmark. Android has no equivalent for an
 * unattended writer: a `DocumentFile` tree is not a POSIX filesystem — there is
 * no hard link, no directory fsync, and no way to create a file exclusively —
 * so the commit ordering this feature depends on could not be expressed against
 * one at all. Treating a SAF tree as if it were a filesystem is how a delivery
 * ends up half-written under a name nobody chose.
 *
 * So the destination is app-owned and fixed, the commit happens there, and
 * exporting to a user-chosen location is a SEPARATE, explicit action on a file
 * that is already durably saved. An interrupted export cannot then fabricate a
 * delivery failure or duplicate anything.
 *
 * The cost is stated rather than hidden: clearing the app's data removes the
 * received copies, and the UI has to say so.
 *
 * ## Why the probe is a real write
 *
 * `receiveDirReady` is reported to central, and central uses it to decide
 * whether a sender is told their file will land. Inspecting permission bits
 * would answer a different question from the one being asked — a directory can
 * be present and writable-looking and still be full, or be occupied by
 * something that is not a directory. So the probe creates a file, syncs, and
 * removes it.
 */

/** Whether this device can write a delivery right now. */
sealed interface InboxDirectoryState {

    data class Ready(val directory: File) : InboxDirectoryState

    data class Unavailable(val problem: Problem) : InboxDirectoryState {

        /**
         * Closed, and each member maps to the task error code central
         * understands — the receiver reports one of these rather than inventing
         * a category, and a person gets a different remedy for each.
         */
        enum class Problem {
            /** Something that is not a directory occupies the name. Whatever it
             *  is belongs to the user, so it is refused rather than removed. */
            NOT_A_DIRECTORY,

            /** The directory could not be created or written. */
            PERMISSION_DENIED,

            /** The volume is full. */
            DISK_FULL,
        }
    }

    val directoryOrNull: File?
        get() = (this as? Ready)?.directory

    /** What the heartbeat reports to central. */
    val canReceive: Boolean get() = this is Ready
}

/**
 * Serialises every mutation of one account's received container.
 *
 * Publication checks a name and then renames onto it, and `rename(2)` REPLACES
 * an empty directory — so the check is only meaningful while nothing else of
 * ours can create that name in between. The container is app-owned, so this
 * app's own writers are the only ones, and this is what orders them.
 *
 * Deliberately shared rather than private to the publisher. Deletion, cleanup
 * and any later path that mutates a published directory must take the SAME
 * lock, or the ordering argument covers only half the writers — and a delete
 * racing a publication is exactly the kind of thing it exists to prevent.
 */
object InboxContainerLock {

    private val locks = HashMap<String, Mutex>()

    /** Run [body] as the sole mutator of this account's container. */
    suspend fun <T> withContainer(account: InboxAccountId, body: suspend () -> T): T =
        lockFor(account).withLock { body() }

    private fun lockFor(account: InboxAccountId): Mutex =
        synchronized(locks) { locks.getOrPut(account.value) { Mutex() } }
}

/**
 * The app-owned received container, one directory per account.
 *
 * Account-scoped for the same reason the key history is: two accounts can be
 * signed in on one device in sequence, and one account's received files must not
 * appear under the next.
 */
class InboxContainer(
    /**
     * The app-private root these directories live under.
     *
     * The composing layer passes `noBackupFilesDir`. Nothing here reads that
     * decision back, so it is stated rather than enforced: received files,
     * journals and messages are the user's own content and this feature's
     * plaintext-derived records, and neither belongs in a cloud backup or a
     * device transfer. The manifest already excludes every domain for both;
     * placing the stores under the no-backup root means that protection does
     * not rest on a manifest rule alone.
     */
    root: File,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val base = File(root, DIRECTORY)

    /** `<files>/inbox/<account>/received`. Not created by this call. */
    fun directory(account: InboxAccountId): File =
        File(File(base, account.value), RECEIVED)

    /**
     * The per-task staging area, INSIDE the received directory.
     *
     * On the same filesystem by construction, which is what lets publication be
     * a single `rename`. A staging area on another filesystem would make that
     * rename fail — or, worse, degrade into a copy — and reintroduce the
     * partially-visible window this design removes.
     */
    fun staging(account: InboxAccountId, taskId: String): File =
        File(File(directory(account), STAGING), InboxId.checked(taskId, "taskId"))

    /** Where this account's journals live. Outside the received directory, so a
     *  manifest can never name a path that collides with one. */
    fun journals(account: InboxAccountId): File =
        File(File(base, account.value), JOURNALS)

    /** Where received messages live. Never the received directory: a message is
     *  not a file delivery and must not be findable as one. */
    fun messages(account: InboxAccountId): File =
        File(File(base, account.value), MESSAGES)

    /**
     * Create the directory if needed and prove it is writable RIGHT NOW.
     *
     * Called immediately before each heartbeat, so a container that has become
     * unusable stops advertising itself rather than being discovered by a
     * delivery that is already in flight.
     */
    suspend fun probe(account: InboxAccountId): InboxDirectoryState = withContext(io) {
        val directory = directory(account)
        if (directory.exists() && !directory.isDirectory) {
            return@withContext InboxDirectoryState.Unavailable(
                InboxDirectoryState.Unavailable.Problem.NOT_A_DIRECTORY,
            )
        }
        val probe = File(directory, PROBE)
        try {
            files.createDirectories(directory)
            // A real create-and-remove. `canWrite` answers a question about
            // permission bits, and the question being asked is whether a
            // delivery can be written.
            probe.delete()
            probe.outputStream().use { it.write(PROBE_BYTES) }
            files.syncDirectory(directory)
            InboxDirectoryState.Ready(directory)
        } catch (e: IOException) {
            InboxDirectoryState.Unavailable(classify(e))
        } finally {
            probe.delete()
        }
    }

    private fun classify(e: IOException): InboxDirectoryState.Unavailable.Problem {
        val message = e.message.orEmpty().lowercase()
        return when {
            message.contains("space left") || message.contains("enospc") ->
                InboxDirectoryState.Unavailable.Problem.DISK_FULL
            else -> InboxDirectoryState.Unavailable.Problem.PERMISSION_DENIED
        }
    }

    companion object {
        const val DIRECTORY = "inbox"
        const val RECEIVED = "received"
        const val JOURNALS = "journals"
        const val MESSAGES = "messages"

        /**
         * The per-task staging directory name, and a name a manifest may never
         * use.
         *
         * A delivery landing inside it would land ON its own staged source: the
         * commit would link the file to itself and then unlink it, reporting
         * `saved` with nothing on disk.
         */
        const val STAGING = ".relayium-incoming"

        /**
         * The write-probe file, and likewise a name a manifest may never use — the
         * next probe deletes a stale one, assuming it left it behind.
         */
        const val PROBE = ".relayium-probe"

        private val PROBE_BYTES = ByteArray(1)
    }
}
