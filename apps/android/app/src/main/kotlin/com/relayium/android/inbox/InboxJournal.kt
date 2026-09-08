package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.android.cloud.SecretBoxException
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestKind
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The per-task crash journal.
 *
 * ## What it is for
 *
 * Central knows a task's state; only this device knows what it did to its own
 * storage. Between "the ciphertext verified" and "every file is committed" there
 * are as many crash windows as there are files, and afterwards the directory
 * alone cannot answer "did I create that, or did the user?". The journal is the
 * record that makes each window recoverable without ever overwriting and without
 * ever reporting a false `saved`.
 *
 * ## The ordering contract, which the receiver depends on
 *
 *  1. the plan is journalled DURABLY before the first destination exists;
 *  2. each destination is linked, its directory is synced, and only THEN is it
 *     appended to [committed] and the journal made durable;
 *  3. the staged source is removed only after the journal records the commit, so
 *     the evidence outlives the ambiguity;
 *  4. [isCompleted] is set only when every planned destination is committed.
 *     `saved` is reported only from [isCompleted], so a lost report retries into
 *     an idempotent no-op rather than a second delivery.
 *
 * ## Why it is sealed at rest
 *
 * It holds manifest file names and absolute destinations — the user's own
 * plaintext. App-private storage already keeps other apps out; sealing it under
 * this feature's own key means a backup or an offline image of the data
 * directory does not hand those names to a reader either. Nothing in it is ever
 * logged or sent to central.
 */
data class InboxJournal(
    val taskId: String,
    val storedFileId: String,
    val targetKeyId: String,
    /** The authenticated sending device, once the claim named one. */
    val senderDeviceId: String,
    val kind: InboxManifestKind,
    /**
     * The receive directory the plan was computed against.
     *
     * A task journalled for one directory must never be resumed into another:
     * the planned destinations would be meaningless there. For a MESSAGE this is
     * the message store's directory, which does not move with the container.
     */
    val root: String,
    /** The complete, ordered set of destinations this task may create. Fixed at
     *  planning time and never recomputed for a resumed task. */
    val plan: List<InboxPlanEntry>,
    /**
     * The directory this delivery will publish, chosen ONCE and journalled
     * before anything is created.
     *
     * A whole directory rather than individual files, because publication is a
     * single atomic `rename` of something this delivery exclusively built. That
     * is what removes the ownership question entirely: nothing is ever created,
     * truncated or deleted at a path the user might already own.
     *
     * Empty for a message, which publishes nothing into the container.
     */
    val taskDirectory: String,
    val plannedAt: Long,
    /**
     * Destinations durably in place.
     *
     * All-or-nothing for a file delivery: the rename either happened or it did
     * not, so this is either empty or every planned destination. For a message
     * it is the task id.
     */
    val committed: List<String> = emptyList(),
    /** Every planned destination is committed. The ONLY basis on which `saved`
     *  is reported. */
    val isCompleted: Boolean = false,
    /** Central acknowledged the commit, so a receipt is not retried forever
     *  after the task has left the queue. */
    val isSavedReported: Boolean = false,
    /** The declared UTF-8 length of a committed message. A COUNT: the message
     *  itself lives in the message store and never here. */
    val messageBytes: Long = 0,
    val completedAt: Long = 0,
    val updatedAt: Long = 0,
) {
    fun hasCommitted(destination: String): Boolean = committed.contains(destination)

    /** No names, no paths: this reaches failure text. */
    override fun toString(): String =
        "InboxJournal(task=$taskId, files=${plan.size}, completed=$isCompleted)"
}

enum class InboxJournalReason {
    /** A task id that could not safely become a file name. */
    INVALID_TASK_ID,

    /** The stored journal is unreadable, altered, or a version this build does
     *  not understand. Refused rather than parsed optimistically. */
    UNREADABLE,

    /** A destination that is not in this journal's plan. */
    INVALID_DESTINATION,

    /** The filesystem or the keystore refused. */
    STORAGE,
}

class InboxJournalException(val reason: InboxJournalReason, cause: Throwable? = null) :
    RuntimeException("relayium inbox journal: $reason", cause)

/**
 * The per-task journals for ONE account.
 *
 * Account-scoped for the same reason the key history is: a journal holds
 * plaintext file names and absolute destinations, and an account switch must not
 * make one account's in-flight delivery visible to — or resumable by — the next.
 */
class InboxJournalStore(
    val directory: File,
    private val account: InboxAccountId,
    private val secrets: SecretBox,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val lock = Mutex()

    /**
     * The journal for [taskId], or null when this device has never started it —
     * the normal first-delivery case.
     *
     * "Not there" and "there and unreadable" are deliberately different answers:
     * only the first is a first delivery, and treating the second as one would
     * re-download and re-commit a task that may already be on disk.
     */
    suspend fun load(taskId: String): InboxJournal? = lock.withLock { read(taskId) }

    /** Replace the journal and return only once it is DURABLE.
     *
     *  Every caller depends on that: the whole recovery argument is that the
     *  record reaches storage before the action it describes becomes
     *  irreversible. */
    suspend fun save(journal: InboxJournal, nowSeconds: Long): InboxJournal =
        lock.withLock { write(journal.copy(updatedAt = nowSeconds)) }

    /**
     * Record one destination as durably in place, and complete the journal when
     * that was the last one.
     *
     * Kept here rather than in the commit loop so the "is this the last one"
     * decision and the write that depends on it cannot drift apart.
     */
    /**
     * Record that this delivery's directory is durably published.
     *
     * Whole-delivery rather than per-file: the publication is one atomic rename,
     * so there is no state in which some destinations are live and others are
     * not. That removes the partial-commit window rather than journalling
     * through it.
     */
    suspend fun recordPublished(taskId: String, nowSeconds: Long): InboxJournal =
        lock.withLock {
            val journal = read(taskId) ?: throw InboxJournalException(InboxJournalReason.UNREADABLE)
            if (journal.isCompleted) return@withLock journal
            write(
                journal.copy(
                    committed = journal.plan.map { it.destination },
                    isCompleted = true,
                    completedAt = nowSeconds,
                    updatedAt = nowSeconds,
                ),
            )
        }

    /** The message counterpart: a message publishes no directory. */
    suspend fun recordMessageCommitted(taskId: String, bytes: Long, nowSeconds: Long): InboxJournal =
        lock.withLock {
            val journal = read(taskId) ?: throw InboxJournalException(InboxJournalReason.UNREADABLE)
            if (journal.isCompleted) return@withLock journal
            write(
                journal.copy(
                    committed = listOf(taskId),
                    messageBytes = bytes,
                    isCompleted = true,
                    completedAt = nowSeconds,
                    updatedAt = nowSeconds,
                ),
            )
        }

    suspend fun markSavedReported(taskId: String, nowSeconds: Long) = lock.withLock {
        val journal = read(taskId) ?: return@withLock
        if (!journal.isCompleted || journal.isSavedReported) return@withLock
        write(journal.copy(isSavedReported = true, updatedAt = nowSeconds))
        Unit
    }

    suspend fun remove(taskId: String) = lock.withLock {
        withContext(io) {
            val file = file(taskId)
            if (file.exists() && !file.delete()) {
                throw InboxJournalException(InboxJournalReason.STORAGE)
            }
            if (directory.isDirectory) {
                try {
                    files.syncDirectory(directory)
                } catch (e: IOException) {
                    throw InboxJournalException(InboxJournalReason.STORAGE, e)
                }
            }
            Unit
        }
    }

    /**
     * Delete journals whose work finished longer ago than [RETENTION_SECONDS].
     *
     * Only COMPLETED, reported journals are eligible: an unfinished one is the
     * only record of an in-flight task's destination plan, and deleting it early
     * would turn a resumable crash into an ambiguous directory. An unreadable
     * journal is left alone too — it may still be the record that stops a
     * duplicate delivery.
     */
    suspend fun prune(nowSeconds: Long) = lock.withLock {
        val names = withContext(io) { directory.list().orEmpty() }
        val cutoff = nowSeconds - RETENTION_SECONDS
        for (name in names) {
            if (!name.endsWith(SUFFIX)) continue
            val id = name.removeSuffix(SUFFIX)
            val journal = try {
                read(id)
            } catch (_: InboxJournalException) {
                continue
            } ?: continue
            if (journal.isCompleted && journal.isSavedReported && journal.updatedAt < cutoff) {
                withContext(io) { file(id).delete() }
            }
        }
        runCatching { withContext(io) { files.syncDirectory(directory) } }
        Unit
    }

    /** Every readable journal, for history reconstruction. Unreadable entries
     *  are skipped rather than failing the whole read: one bad file must not
     *  hide every delivery this device has made. */
    suspend fun all(): List<InboxJournal> = lock.withLock {
        withContext(io) { directory.list().orEmpty() }
            .filter { it.endsWith(SUFFIX) }
            .mapNotNull { name ->
                try {
                    read(name.removeSuffix(SUFFIX))
                } catch (_: InboxJournalException) {
                    null
                }
            }
    }

    // ── storage ─────────────────────────────────────────────────────────────

    private fun file(taskId: String): File =
        File(directory, InboxId.checked(taskId, "taskId") + SUFFIX)

    /** Binds the account AND the task, so a journal file moved between either
     *  fails to open rather than resuming the wrong delivery. */
    private fun label(taskId: String) = "$LABEL_PREFIX/${account.value}/$taskId"

    private suspend fun read(taskId: String): InboxJournal? = withContext(io) {
        val file = try {
            file(taskId)
        } catch (e: InboxWireException) {
            throw InboxJournalException(InboxJournalReason.INVALID_TASK_ID, e)
        }
        if (!file.exists()) return@withContext null
        val sealed = try {
            if (file.length() > MAX_JOURNAL_BYTES) {
                throw InboxJournalException(InboxJournalReason.UNREADABLE)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxJournalException(InboxJournalReason.STORAGE, e)
        }
        val plaintext = try {
            secrets.open(label(taskId), sealed)
        } catch (e: SecretBoxException) {
            throw InboxJournalException(InboxJournalReason.UNREADABLE, e)
        }
        try {
            decode(String(plaintext, Charsets.UTF_8), taskId)
        } finally {
            plaintext.fill(0)
        }
    }

    private suspend fun write(journal: InboxJournal): InboxJournal = withContext(io) {
        validate(journal)
        val plaintext = encode(journal).toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(journal.taskId), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxJournalException(InboxJournalReason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        if (sealed.size > MAX_JOURNAL_BYTES) {
            throw InboxJournalException(InboxJournalReason.STORAGE)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(file(journal.taskId), sealed)
        } catch (e: IOException) {
            throw InboxJournalException(InboxJournalReason.STORAGE, e)
        }
        journal
    }

    private fun encode(journal: InboxJournal): String = Json.stringify(
        Json.obj(
            "version" to Json.of(VERSION),
            "taskId" to Json.of(journal.taskId),
            "storedFileId" to Json.of(journal.storedFileId),
            "targetKeyId" to Json.of(journal.targetKeyId),
            "senderDeviceId" to Json.of(journal.senderDeviceId),
            "kind" to Json.of(journal.kind.wire),
            "root" to Json.of(journal.root),
            "plan" to Json.arr(
                journal.plan.map {
                    Json.obj(
                        "index" to Json.of(it.index),
                        "name" to Json.of(it.name),
                        "size" to Json.of(it.size),
                        "destination" to Json.of(it.destination),
                    )
                },
            ),
            "plannedAt" to Json.of(journal.plannedAt),
            "taskDirectory" to Json.of(journal.taskDirectory),
            "committed" to Json.arr(journal.committed.map { Json.of(it) }),
            "isCompleted" to Json.of(journal.isCompleted),
            "isSavedReported" to Json.of(journal.isSavedReported),
            "messageBytes" to Json.of(journal.messageBytes),
            "completedAt" to Json.of(journal.completedAt),
            "updatedAt" to Json.of(journal.updatedAt),
        ),
    )

    private fun decode(text: String, taskId: String): InboxJournal {
        val root = Json.parseOrNull(text) as? Json.Obj ?: unreadable()
        if (whole(root, "version") != VERSION.toLong()) unreadable()
        // The file name is the task id, and the record says which task it is.
        // A disagreement means a file was moved, so it is refused rather than
        // resumed under the name it happens to sit under.
        if (str(root, "taskId") != taskId) unreadable()
        val kind = InboxManifestKind.fromWire(str(root, "kind")) ?: unreadable()
        val planned = (root["plan"] as? Json.Arr)?.items ?: unreadable()
        val plan = planned.map { row ->
            val entry = row as? Json.Obj ?: unreadable()
            InboxPlanEntry(
                // Bounded before the narrowing conversion: `toInt()` wraps, and a
                // wrapped index names a different staged file.
                index = whole(entry, "index", max = MAX_PLAN_ENTRIES.toLong()).toInt(),
                name = str(entry, "name"),
                size = whole(entry, "size"),
                destination = str(entry, "destination"),
            )
        }
        val committed = ((root["committed"] as? Json.Arr)?.items ?: unreadable())
            .map { (it as? Json.Str)?.value ?: unreadable() }
        val decoded = InboxJournal(
            taskId = taskId,
            storedFileId = str(root, "storedFileId"),
            targetKeyId = str(root, "targetKeyId"),
            senderDeviceId = str(root, "senderDeviceId"),
            kind = kind,
            root = str(root, "root"),
            plan = plan,
            plannedAt = whole(root, "plannedAt"),
            taskDirectory = str(root, "taskDirectory"),
            committed = committed,
            isCompleted = bool(root, "isCompleted"),
            isSavedReported = bool(root, "isSavedReported"),
            messageBytes = whole(root, "messageBytes"),
            completedAt = whole(root, "completedAt"),
            updatedAt = whole(root, "updatedAt"),
        )
        // The same authority the write path used. A record that reached storage
        // some other way — an older build, a partial restore — is refused here.
        validate(decoded)
        return decoded
    }

    /**
     * Every invariant a journal must satisfy, checked on the way IN and on the
     * way OUT.
     *
     * One authority rather than two, and applied to writes as well as reads: a
     * record this build would refuse on reload must never reach storage in the
     * first place. The alternative is the worst of both — a journal that is
     * written happily and then, on the next launch, reads as unreadable, which
     * is exactly the state that stops a duplicate delivery from being
     * recognised.
     *
     * The completeness rule is stated as an EQUALITY rather than a containment.
     * `committed.containsAll(plan)` is vacuously true for an empty plan, so a
     * FILE journal with no plan and `isCompleted` would pass — and `saved` is
     * reported from nothing but `isCompleted`.
     */
    private fun validate(journal: InboxJournal) {
        if (!InboxId.isValid(journal.taskId)) unreadable()
        for (id in listOf(journal.storedFileId, journal.targetKeyId, journal.senderDeviceId)) {
            if (id.isNotEmpty() && !InboxId.isValid(id)) unreadable()
        }
        if (journal.root.isEmpty()) unreadable()
        if (journal.plannedAt < 0 || journal.updatedAt < 0 ||
            journal.completedAt < 0 || journal.messageBytes < 0
        ) {
            unreadable()
        }
        if (journal.isSavedReported && !journal.isCompleted) unreadable()

        when (journal.kind) {
            InboxManifestKind.TEXT -> {
                // A message has no destination in the container by design.
                if (journal.plan.isNotEmpty()) unreadable()
                if (journal.taskDirectory.isNotEmpty()) unreadable()
                if (journal.committed.isNotEmpty() &&
                    journal.committed != listOf(journal.taskId)
                ) {
                    unreadable()
                }
                if (journal.isCompleted && journal.committed.isEmpty()) unreadable()
                // A completed message has a real length, inside the protocol's
                // own bounds: `messageBytes` is what a receipt renders, and a
                // zero or oversized count would describe a message this build
                // could not have committed.
                if (journal.isCompleted) {
                    if (journal.messageBytes < InboxManifest.MIN_TEXT_BYTES ||
                        journal.messageBytes > InboxManifest.MAX_TEXT_BYTES
                    ) {
                        unreadable()
                    }
                } else if (journal.messageBytes != 0L) {
                    // The count is written by the commit; carrying one before
                    // that describes a delivery that has not happened.
                    unreadable()
                }
            }
            InboxManifestKind.FILE -> {
                // A file delivery always names at least one destination; the
                // manifest codec refuses an empty one, so a journal with none is
                // not a record this build wrote.
                if (journal.plan.isEmpty() || journal.plan.size > MAX_PLAN_ENTRIES) unreadable()
                // The published directory is part of the plan's identity: a
                // record without one names no place this delivery may create.
                if (!isUnder(journal.root, journal.taskDirectory)) unreadable()
                // Indices are the staged file names, so they must be exactly
                // 0..n-1 — a duplicate would make two entries read one staged
                // file, and a gap would read one that was never written.
                if (journal.plan.mapIndexed { i, e -> e.index == i }.any { !it }) unreadable()
                val destinations = LinkedHashSet<String>()
                val names = LinkedHashSet<String>()
                for (entry in journal.plan) {
                    if (entry.size < 0 || entry.size > MAX_SAFE_INTEGER) unreadable()
                    // The NAME is validated, not merely the destination.
                    //
                    // Publication and verification address files by `name`
                    // (`File(staging, name)`, `File(published, name)`), while
                    // ownership was being checked on `destination` alone — so a
                    // tampered record whose destination looked confined could
                    // still carry a name that escapes it. The two are tied
                    // together here: the name passes the same rule the planner
                    // applied — which already refuses traversal, absolute paths
                    // and this component's own reserved entries — and the
                    // destination must be exactly what that name resolves to.
                    if (InboxDestinationPlan.checkedRelativePath(entry.name) != entry.name) {
                        unreadable()
                    }
                    if (File(journal.taskDirectory, entry.name).path != entry.destination) {
                        unreadable()
                    }
                    // Checked directly as well, so neither rule depends on the
                    // other being right.
                    if (!isUnder(journal.taskDirectory, entry.destination)) unreadable()
                    if (!destinations.add(entry.destination)) unreadable()
                    // Two entries with one logical name would leave the receipt's
                    // digest map describing only one of them.
                    if (!names.add(entry.name.lowercase(java.util.Locale.ROOT))) unreadable()
                }
                if (journal.committed.size != journal.committed.distinct().size) unreadable()
                // A file delivery has no message length.
                if (journal.messageBytes != 0L) unreadable()
                // All-or-nothing: the rename either published every destination
                // or none. Anything between describes a state this build cannot
                // produce, and `saved` is reported from `isCompleted` alone.
                if (journal.isCompleted && journal.committed.toSet() != destinations) unreadable()
                if (!journal.isCompleted && journal.committed.isNotEmpty()) unreadable()
            }
        }
    }

    /** Whether [path] sits inside [root], with no traversal component. */
    private fun isUnder(root: String, path: String): Boolean {
        if (path.split(File.separatorChar).any { it == ".." }) return false
        val base = if (root.endsWith(File.separatorChar)) root else root + File.separatorChar
        return path.startsWith(base) && path.length > base.length
    }

    private fun unreadable(): Nothing = throw InboxJournalException(InboxJournalReason.UNREADABLE)

    private fun str(source: Json.Obj, key: String): String =
        (source[key] as? Json.Str)?.value ?: unreadable()

    private fun bool(source: Json.Obj, key: String): Boolean =
        (source[key] as? Json.Bool)?.value ?: unreadable()

    private fun whole(source: Json.Obj, key: String, max: Long = MAX_SAFE_INTEGER): Long {
        val value = (source[key] as? Json.Num)?.value ?: unreadable()
        if (!value.isFinite() || value != Math.floor(value) ||
            value < 0 || value > max.toDouble()
        ) {
            unreadable()
        }
        return value.toLong()
    }

    companion object {
        const val LABEL_PREFIX = "relayium/inbox/journal"

        private const val SUFFIX = ".json"
        private const val VERSION = 1

        /**
         * How long a finished receipt is kept.
         *
         * Deliberately OUTLIVES central's own terminal-row retention (7 days), so
         * a duplicate delivery attempt for a task this device already saved is
         * still recognised from local evidence alone.
         */
        const val RETENTION_SECONDS: Long = 30L * 24 * 60 * 60

        private const val MAX_JOURNAL_BYTES = 4L * 1024 * 1024

        /** The manifest's own bound on entries per delivery. */
        private const val MAX_PLAN_ENTRIES = 1000
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
}
