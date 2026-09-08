package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.android.cloud.SecretBoxException
import com.relayium.protocol.Json
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/**
 * Publishing a verified delivery into the account's received container.
 *
 * ## Two designs that did not survive, and why
 *
 * **Hard links.** `Files.createLink` fails with `AccessDenied` under the app's
 * own uid on the AOSP 36 EMULATOR this was measured on, both across directories
 * and within one, while ordinary writes and fsyncs succeed there. That is
 * evidence from one tested configuration — not a statement about every Android
 * build, and not physical-device evidence — which is exactly why it is
 * disqualifying: a commit path whose availability varies by configuration is not
 * one this feature may report `saved` from, and it passed every JVM test while
 * failing on the first real Android environment it was tried in.
 *
 * **A durable claim, then an exclusive create.** The idea was to write down
 * authorship before the file existed. It is not sound, and the counterexample is
 * concrete: record the claim, die before the create, and the next run finds a
 * file at that destination and a claim saying it is ours — when the create never
 * happened and the file is the USER'S. It would then be truncated. An intent to
 * create is not proof of creation, and no ordering makes it one. Nor is size:
 * accepting a same-sized file as a finished delivery reports `saved` for
 * whatever happened to be there.
 *
 * ## What is sound: build elsewhere, publish atomically, prove identity
 *
 * The delivery is assembled in a staging directory this task exclusively owns,
 * under a name no manifest can produce. Nothing appears in the user's view until
 * every byte is authenticated, written and fsynced. Then ONE `rename` moves the
 * finished directory to its published name, so there is no partially-published
 * state to reason about.
 *
 * Ownership is never inferred. A published directory carries a sealed receipt
 * naming this account, this task, and a SHA-256 per file. On resume, a directory
 * already at that name is accepted only if the receipt opens under this
 * account's key AND every file matches its recorded digest. Name, size, and an
 * intention to create prove nothing and are never consulted.
 *
 * ## The ordering
 *
 *  1. plan the published directory name ONCE, journal it durably;
 *  2. stage every file, fsync each one;
 *  3. write the sealed receipt into staging, fsync the staged tree;
 *  4. `rename(staging, published)` — atomic;
 *  5. fsync the container directory;
 *  6. record the publication in the journal;
 *  7. report `saved`.
 *
 * A crash before 4 leaves only staging, which is discarded and re-downloaded: no
 * plaintext partial is ever trusted after a crash. A crash between 4 and 6
 * leaves a published directory whose receipt verifies, so the next run records
 * it and reports without re-delivering.
 *
 * ## What the platform actually provides here
 *
 * Measured on an AOSP 36 emulator under the app's own uid: a staged nested tree
 * with file and directory fsyncs, a `renameTo` into the received container, and
 * an exact read-back all succeed. A rename onto a NON-EMPTY directory is
 * refused by the platform. Physical-device behaviour is not claimed from this.
 *
 * A rename onto an EMPTY directory REPLACES it. So no-overwrite is not a
 * property of `renameTo` and is never claimed as one: it comes from the
 * serialization and the explicit refusal in [publish], and from the container
 * being this app's own.
 */
object InboxCommit {

    /** The sealed proof of authorship inside a published directory. */
    const val RECEIPT_NAME = ".relayium-delivery"

    /** What a published directory has to prove about itself. */
    data class Receipt(
        val taskId: String,
        val storedFileId: String,
        val targetKeyId: String,
        val senderDeviceId: String,
        /** Relative name to lowercase hex SHA-256. */
        val digests: Map<String, String>,
    )

    /**
     * Publish a staged, fully verified delivery.
     *
     * [digests] is what the staging writer computed as it wrote each file, so
     * the ordinary path costs no extra read. They are recomputed only when a
     * resume has to prove that an existing directory is ours.
     */
    suspend fun publish(
        journal: InboxJournal,
        staging: File,
        journals: InboxJournalStore,
        secrets: SecretBox,
        files: DurableFiles,
        account: InboxAccountId,
        digests: Map<String, String>,
        nowSeconds: () -> Long,
        io: CoroutineDispatcher = Dispatchers.IO,
    ): InboxJournal = InboxContainerLock.withContainer(account) {
        if (journal.isCompleted) return@withContainer journal
        val published = File(journal.taskDirectory)

        // Something already at the published name is either this delivery's own
        // completed work or something else entirely. The sealed receipt and the
        // digests decide, and nothing else is permitted to.
        if (withContext(io) { published.exists() }) {
            if (!verifyPublished(published, journal, secrets, account, io)) {
                throw InboxCommitException(InboxCommitException.Reason.NAME_CONFLICT)
            }
            // Durability is re-established BEFORE the record, on every path.
            // A previous attempt may have renamed and then died before its
            // container fsync; recording `saved` here without repeating it would
            // report a delivery whose directory entry is still only in the page
            // cache.
            // Both directories the rename touched, on the recovery path too: a
            // previous attempt may have died between the rename and either
            // fsync, and recording `saved` without repeating them would report a
            // delivery whose entries are still only in the page cache.
            withContext(io) { syncPublished(published, staging, files) }
            return@withContainer journals.recordPublished(journal.taskId, nowSeconds())
        }

        currentCoroutineContext().ensureActive()
        withContext(io) {
            writeReceipt(staging, journal, digests, secrets, account, files)
            // The staged tree and its receipt must be durable BEFORE the rename
            // makes them visible: a rename that outran its own contents would
            // publish a directory whose files a crash could still lose.
            syncTree(staging, files)
            published.parentFile?.let { files.createDirectories(it) }
            // `rename(2)` is NOT no-overwrite: it silently replaces an EMPTY
            // directory at the destination. The refusal therefore rests on two
            // things that are checked rather than hoped for:
            //
            //  * this whole sequence holds the per-account container lock above,
            //    and the container is app-owned, so no other writer of ours can
            //    create that name between the check and the rename;
            //  * the name is re-checked immediately before the call, under that
            //    lock, and anything present is refused rather than replaced.
            if (published.exists()) {
                throw InboxCommitException(InboxCommitException.Reason.NAME_CONFLICT)
            }
            val sourceParent = staging.parentFile
            if (!staging.renameTo(published)) {
                throw InboxCommitException(InboxCommitException.Reason.STORAGE)
            }
            syncPublished(published, staging, files, sourceParent)
            // The tree just moved is ours by construction, but the receipt is
            // read back to prove it: a rename that landed somewhere unexpected
            // must not be recorded as this delivery. Read HERE, on the IO
            // dispatcher, because it opens and reads a file.
            if (readReceipt(published, journal.taskId, secrets, account) == null) {
                throw InboxCommitException(InboxCommitException.Reason.NAME_CONFLICT)
            }
        }
        journals.recordPublished(journal.taskId, nowSeconds())
    }

    /**
     * Make everything the rename touched durable.
     *
     * THREE directories, not one, and all of them on every path that can lead to
     * a `saved` report:
     *
     *  * the published directory's own entries;
     *  * the destination parent, which GAINED the entry naming it;
     *  * the SOURCE parent, which LOST the staging entry. A rename mutates both
     *    directories, so leaving the source side unsynced means a crash can
     *    resurrect a staging entry for a delivery already reported as saved.
     *
     * A retry after a crashed fsync repeats all of them rather than assuming the
     * earlier attempt finished.
     */
    private fun syncPublished(
        published: File,
        staging: File,
        files: DurableFiles,
        sourceParent: File? = staging.parentFile,
    ) {
        try {
            files.syncDirectory(published)
            published.parentFile?.let { files.syncDirectory(it) }
            // Skipped only when it is the directory already synced above.
            sourceParent?.takeIf { it.isDirectory && it != published.parentFile }
                ?.let { files.syncDirectory(it) }
        } catch (e: IOException) {
            throw InboxCommitException(classify(e), e)
        }
    }

    /**
     * Recover a delivery that was already published but whose journal never
     * recorded it — BEFORE anything expensive or destructive is attempted.
     *
     * The window is the one between the rename and the journal write, and what
     * makes it matter is what a caller would otherwise do first: measure free
     * space, wipe staging, and re-download. A delivery that is already on disk
     * can legitimately fail all three — the volume that had room for it once may
     * not have room for a second copy, and the ciphertext object may be gone —
     * so a recovery gated behind them would turn a completed delivery into
     * `disk_full` or a dead download, and the files would sit there
     * unacknowledged forever.
     *
     * Returns the completed journal, or null when there is nothing published to
     * recover. A directory that is present and cannot prove it is ours is
     * refused HERE rather than after a pointless download: the answer is already
     * determined, and it will not become ours later.
     */
    suspend fun recoverPublished(
        journal: InboxJournal,
        staging: File,
        journals: InboxJournalStore,
        secrets: SecretBox,
        files: DurableFiles,
        account: InboxAccountId,
        nowSeconds: () -> Long,
        io: CoroutineDispatcher = Dispatchers.IO,
    ): InboxJournal? = InboxContainerLock.withContainer(account) {
        if (journal.isCompleted) return@withContainer journal
        val published = File(journal.taskDirectory)
        if (!withContext(io) { published.exists() }) return@withContainer null
        if (!verifyPublished(published, journal, secrets, account, io)) {
            throw InboxCommitException(InboxCommitException.Reason.NAME_CONFLICT)
        }
        // The earlier attempt may have died before either fsync, so both are
        // repeated before the record: `saved` must never rest on an entry that
        // is still only in the page cache.
        withContext(io) { syncPublished(published, staging, files) }
        journals.recordPublished(journal.taskId, nowSeconds())
    }

    /**
     * Whether an existing published directory is provably this delivery's.
     *
     * Every part of the proof is authenticated: the receipt opens only under
     * this account's key and this task's label, its identity fields must match
     * the claim central handed us, and every file must hash to what the receipt
     * recorded. A same-named directory of the user's own files — even
     * same-sized ones — satisfies none of it.
     */
    suspend fun verifyPublished(
        published: File,
        journal: InboxJournal,
        secrets: SecretBox,
        account: InboxAccountId,
        io: CoroutineDispatcher = Dispatchers.IO,
    ): Boolean = withContext(io) {
        val receipt = readReceipt(published, journal.taskId, secrets, account)
            ?: return@withContext false
        if (receipt.taskId != journal.taskId ||
            receipt.storedFileId != journal.storedFileId ||
            receipt.targetKeyId != journal.targetKeyId ||
            receipt.senderDeviceId != journal.senderDeviceId
        ) {
            return@withContext false
        }
        if (receipt.digests.keys != journal.plan.mapTo(HashSet()) { it.name }) {
            return@withContext false
        }
        for (entry in journal.plan) {
            val file = File(published, entry.name)
            if (!file.isFile || file.length() != entry.size) return@withContext false
            if (digestOf(file) != receipt.digests[entry.name]) return@withContext false
        }
        true
    }

    /** Create the per-task staging directory, empty. */
    suspend fun prepareStaging(
        staging: File,
        files: DurableFiles,
        io: CoroutineDispatcher = Dispatchers.IO,
    ): File = withContext(io) {
        deleteTree(staging)
        files.createDirectories(staging)
        staging
    }

    suspend fun cleanStaging(
        staging: File,
        io: CoroutineDispatcher = Dispatchers.IO,
    ) = withContext(io) {
        deleteTree(staging)
    }

    /** Lowercase hex SHA-256 of a file, streamed. */
    fun digestOf(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // ── the receipt ─────────────────────────────────────────────────────────

    private fun label(account: InboxAccountId, taskId: String) =
        "$LABEL_PREFIX/${account.value}/$taskId"

    private fun writeReceipt(
        staging: File,
        journal: InboxJournal,
        digests: Map<String, String>,
        secrets: SecretBox,
        account: InboxAccountId,
        files: DurableFiles,
    ) {
        if (journal.plan.any { digests[it.name] == null }) {
            throw InboxCommitException(InboxCommitException.Reason.STORAGE)
        }
        val document = Json.stringify(
            Json.obj(
                "version" to Json.of(VERSION),
                "taskId" to Json.of(journal.taskId),
                "storedFileId" to Json.of(journal.storedFileId),
                "targetKeyId" to Json.of(journal.targetKeyId),
                "senderDeviceId" to Json.of(journal.senderDeviceId),
                "files" to Json.arr(
                    journal.plan.map {
                        Json.obj(
                            "name" to Json.of(it.name),
                            "size" to Json.of(it.size),
                            "sha256" to Json.of(digests.getValue(it.name)),
                        )
                    },
                ),
            ),
        )
        val plaintext = document.toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(account, journal.taskId), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxCommitException(InboxCommitException.Reason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        try {
            files.writeAtomically(File(staging, RECEIPT_NAME), sealed)
        } catch (e: IOException) {
            throw InboxCommitException(classify(e), e)
        }
    }

    private fun readReceipt(
        published: File,
        taskId: String,
        secrets: SecretBox,
        account: InboxAccountId,
    ): Receipt? {
        val file = File(published, RECEIPT_NAME)
        if (!file.isFile || file.length() > MAX_RECEIPT_BYTES) return null
        val plaintext = try {
            secrets.open(label(account, taskId), file.readBytes())
        } catch (_: SecretBoxException) {
            return null
        } catch (_: IOException) {
            return null
        }
        try {
            val root = Json.parseOrNull(String(plaintext, Charsets.UTF_8)) as? Json.Obj
                ?: return null
            if ((root["version"] as? Json.Num)?.value != VERSION.toDouble()) return null
            val rows = (root["files"] as? Json.Arr)?.items ?: return null
            val digests = HashMap<String, String>(rows.size)
            for (row in rows) {
                val entry = row as? Json.Obj ?: return null
                val name = (entry["name"] as? Json.Str)?.value ?: return null
                val sha = (entry["sha256"] as? Json.Str)?.value ?: return null
                digests[name] = sha
            }
            return Receipt(
                taskId = (root["taskId"] as? Json.Str)?.value ?: return null,
                storedFileId = (root["storedFileId"] as? Json.Str)?.value ?: return null,
                targetKeyId = (root["targetKeyId"] as? Json.Str)?.value ?: return null,
                senderDeviceId = (root["senderDeviceId"] as? Json.Str)?.value ?: return null,
                digests = digests,
            )
        } finally {
            plaintext.fill(0)
        }
    }

    // ── durability helpers ──────────────────────────────────────────────────

    /** fsync every file in the tree, then every directory, deepest first. */
    private fun syncTree(root: File, files: DurableFiles) {
        try {
            root.walkBottomUp().forEach { entry ->
                if (entry.isDirectory) {
                    files.syncDirectory(entry)
                } else if (entry.isFile) {
                    FileOutputStream(entry, true).use { files.syncStream(it) }
                }
            }
        } catch (e: IOException) {
            throw InboxCommitException(classify(e), e)
        }
    }

    private fun classify(e: IOException): InboxCommitException.Reason {
        val message = e.message.orEmpty().lowercase()
        return when {
            message.contains("space left") || message.contains("enospc") ->
                InboxCommitException.Reason.DISK_FULL
            message.contains("permission") || message.contains("denied") ||
                message.contains("eacces") ->
                InboxCommitException.Reason.PERMISSION_DENIED
            else -> InboxCommitException.Reason.STORAGE
        }
    }

    private fun deleteTree(target: File) {
        if (!target.exists()) return
        if (target.isDirectory && !java.nio.file.Files.isSymbolicLink(target.toPath())) {
            target.listFiles().orEmpty().forEach { deleteTree(it) }
        }
        target.delete()
    }

    private const val LABEL_PREFIX = "relayium/inbox/delivery"
    private const val VERSION = 1
    private const val MAX_RECEIPT_BYTES = 4L * 1024 * 1024
}

/** Why a publication did not happen. Each maps to a task error code central knows. */
class InboxCommitException(val reason: Reason, cause: Throwable? = null) :
    RuntimeException("relayium inbox commit: $reason", cause) {

    enum class Reason {
        /**
         * Something is already at the published name and cannot prove it is this
         * delivery's.
         *
         * Never replaced and never removed: what makes a directory ours is a
         * sealed receipt and matching digests, and this one has neither.
         */
        NAME_CONFLICT,
        DISK_FULL,
        PERMISSION_DENIED,
        STORAGE,
    }
}
