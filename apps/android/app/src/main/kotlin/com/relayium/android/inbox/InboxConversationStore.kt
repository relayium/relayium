package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.android.cloud.SecretBoxException
import com.relayium.protocol.Json
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * What this account has actually exchanged with its other devices, in both
 * directions.
 *
 * ## Why deletion is a tombstone and not a delete
 *
 * A received entry is derived from a durable receipt — the journal that proves a
 * delivery landed. That journal has to OUTLIVE the user's history, because it is
 * also what stops the same task being delivered a second time. So "delete this
 * from my history" cannot mean "forget the delivery": the next status refresh,
 * the next replay of a `saved` report, or the next relaunch would rebuild the
 * entry from the receipt and the user would watch it come back.
 *
 * A tombstone is the durable record of the user's decision. Reconstruction
 * consults it, so a deleted entry stays deleted while the receipt that prevents
 * a duplicate delivery stays exactly where it is.
 *
 * ## Why deletion is LOCAL
 *
 * Removing a row here does not cancel a task, decline a delivery or clear an
 * inbox. Those are decisions about what central holds, and hiding one behind a
 * history gesture would mean a user tidying their view silently revoked a
 * transfer. Accepting and declining are separate, explicit, and act on exactly
 * the task the user was shown.
 */
data class InboxConversationEntry(
    /** Stable identity: the task for a received entry, the job for a sent one. */
    val id: String,
    val peerDeviceId: String,
    val direction: Direction,
    val kind: Kind,
    /** Relative names as delivered. Plaintext-derived and LOCAL: never logged,
     *  never sent to central. */
    val names: List<String>,
    val byteCount: Long,
    val at: Long,
    /** Null until the user has seen it. Received entries only. */
    val readAt: Long? = null,
    /** Where a received file delivery was published, for open/share/export. */
    val directory: String? = null,
    val sentState: SentState? = null,
) {
    enum class Direction { RECEIVED, SENT }

    enum class Kind { FILES, MESSAGE }

    /**
     * What a sent delivery is doing, in the sender's own terms.
     *
     * Deliberately no member for a stop REASON: a reason is live state that
     * belongs to the job, and freezing one into history would make an old row
     * assert something that may no longer be true.
     */
    enum class SentState { STAGED, SENDING, CREATED, SAVED, STOPPED }

    val isUnread: Boolean get() = direction == Direction.RECEIVED && readAt == null

    /** No names, no bytes: this reaches failure text. */
    override fun toString(): String =
        "InboxConversationEntry(id=$id, $direction/$kind, files=${names.size})"
}

/** One peer device's exchange, newest first. */
data class InboxConversation(
    val peerDeviceId: String,
    val entries: List<InboxConversationEntry>,
) {
    val unreadCount: Int get() = entries.count { it.isUnread }
    val lastActivity: Long get() = entries.firstOrNull()?.at ?: 0
}

enum class InboxConversationReason {
    UNREADABLE,
    STORAGE,

    /**
     * The ledger cannot take another entry or deletion without dropping a
     * record it is not safe to drop.
     *
     * Reported rather than resolved by silently evicting. A dropped tombstone
     * whose source can still reconstruct its row means "delete" stops meaning
     * delete — the row returns on the next refresh — and a caller that was told
     * the deletion succeeded has been lied to.
     */
    FULL,
}

class InboxConversationException(
    val reason: InboxConversationReason,
    cause: Throwable? = null,
) : RuntimeException("relayium inbox conversations: $reason", cause)

/**
 * One account's conversation history, sealed at rest.
 *
 * Account-scoped like every other store here: an account switch must hide one
 * account's exchange entirely and preserve the other's, rather than filtering a
 * shared list and hoping every reader remembered to.
 */
class InboxConversationStore(
    val directory: File,
    private val account: InboxAccountId,
    private val secrets: SecretBox,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val maxEntries: Int = MAX_ENTRIES,
    private val maxTombstones: Int = MAX_TOMBSTONES,
) {

    private val lock = Mutex()

    /**
     * Record an entry, unless the user has deleted it.
     *
     * Returns false when a tombstone refused it — which is the ordinary case for
     * a replayed receipt, not an error. Callers use it to avoid announcing a
     * delivery the user has already dismissed.
     */
    suspend fun record(entry: InboxConversationEntry, nowSeconds: Long): Boolean =
        lock.withLock {
            val state = read()
            if (state.tombstones.containsKey(entry.id)) return@withLock false
            val existing = state.entries.firstOrNull { it.id == entry.id }
            // A repeat keeps the read mark and the original timestamp: a history
            // that re-dated an old delivery on every relaunch would be lying
            // about when the user's files arrived.
            val merged = if (existing == null) {
                entry
            } else {
                entry.copy(readAt = existing.readAt, at = existing.at)
            }
            write(
                state.copy(
                    entries = state.entries.filterNot { it.id == entry.id } + merged,
                ),
                nowSeconds,
            )
            true
        }

    /** Update a sent entry's state without disturbing anything else about it. */
    suspend fun updateSent(id: String, sentState: InboxConversationEntry.SentState, nowSeconds: Long) =
        lock.withLock {
            val state = read()
            val existing = state.entries.firstOrNull { it.id == id } ?: return@withLock
            if (existing.direction != InboxConversationEntry.Direction.SENT) return@withLock
            write(
                state.copy(
                    entries = state.entries.map {
                        if (it.id == id) it.copy(sentState = sentState) else it
                    },
                ),
                nowSeconds,
            )
            Unit
        }

    /**
     * Mark exactly the entries the user was shown as read.
     *
     * Observed ids, not "everything from this peer": an entry that arrived while
     * the screen was open was never on it, and marking it read would hide a
     * delivery nobody saw.
     */
    suspend fun markRead(observedIds: Set<String>, nowSeconds: Long) = lock.withLock {
        val state = read()
        val changed = state.entries.map {
            if (it.id in observedIds && it.isUnread) it.copy(readAt = nowSeconds) else it
        }
        if (changed != state.entries) write(state.copy(entries = changed), nowSeconds)
        Unit
    }

    /**
     * Delete entries from the user's history, durably and locally.
     *
     * The tombstone is what makes it stick: the receipts these rows were built
     * from outlive the history on purpose, because they are also what stops a
     * duplicate delivery. Without a tombstone the next reconstruction would
     * bring every deleted row back.
     *
     * Nothing here touches central. See the type comment.
     */
    suspend fun delete(ids: Set<String>, nowSeconds: Long) = lock.withLock {
        if (ids.isEmpty()) return@withLock
        val state = read()
        write(
            state.copy(
                entries = state.entries.filterNot { it.id in ids },
                tombstones = state.tombstones + ids.associateWith { nowSeconds },
            ),
            nowSeconds,
        )
        Unit
    }

    /** Whether the user has deleted this entry. */
    suspend fun isDeleted(id: String): Boolean = lock.withLock { read().tombstones.containsKey(id) }

    /** Every conversation, most recently active first. */
    suspend fun conversations(): List<InboxConversation> = lock.withLock {
        read().entries
            .groupBy { it.peerDeviceId }
            .map { (peer, entries) -> InboxConversation(peer, entries.sortedByDescending { it.at }) }
            .sortedByDescending { it.lastActivity }
    }

    suspend fun entries(): List<InboxConversationEntry> =
        lock.withLock { read().entries.sortedByDescending { it.at } }

    // ── storage ─────────────────────────────────────────────────────────────

    /** Tombstones carry WHEN they were made, because that is what decides when
     *  their source can no longer reconstruct what they suppress. */
    private data class State(
        val entries: List<InboxConversationEntry> = emptyList(),
        val tombstones: Map<String, Long> = emptyMap(),
    )

    private val file get() = File(directory, FILE_NAME)

    private fun label() = "$LABEL_PREFIX/${account.value}"

    private suspend fun read(): State = withContext(io) {
        if (!file.exists()) return@withContext State()
        val sealed = try {
            if (file.length() > MAX_BYTES) {
                throw InboxConversationException(InboxConversationReason.UNREADABLE)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxConversationException(InboxConversationReason.STORAGE, e)
        }
        val plaintext = try {
            secrets.open(label(), sealed)
        } catch (e: SecretBoxException) {
            throw InboxConversationException(InboxConversationReason.UNREADABLE, e)
        }
        try {
            decode(String(plaintext, Charsets.UTF_8))
        } finally {
            plaintext.fill(0)
        }
    }

    private suspend fun write(state: State, nowSeconds: Long): State = withContext(io) {
        val bounded = bounded(state)
        val plaintext = encode(bounded, nowSeconds).toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxConversationException(InboxConversationReason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(file, sealed)
        } catch (e: IOException) {
            throw InboxConversationException(InboxConversationReason.STORAGE, e)
        }
        bounded
    }

    /**
     * Bound the ledger without ever forgetting anything.
     *
     * Nothing is evicted here, and that is the design rather than a missing
     * feature. Two things make age-based compaction unsound:
     *
     *  * **Elapsed time is not proof the source is gone.** A received row is
     *    rebuilt from its journal, and journals are pruned only when they are
     *    completed AND reported AND the receive engine actually runs a pass. A
     *    device that was offline, or had receiving switched off, or whose
     *    `saved` report never landed, keeps its journal indefinitely — so an
     *    evicted tombstone could be resurrected by a receipt far older than any
     *    horizon. Send jobs are worse: nothing prunes them at all.
     *  * **Entries are not a cache.** The files and messages a row describes are
     *    still on disk; dropping the row would hide a delivery the user never
     *    dismissed, which is not compaction but a disappearing history.
     *
     * So the bound is a refusal. Exceeding it fails as
     * [InboxConversationReason.FULL] — a state a surface can show and a person
     * can act on — rather than silently trading away a record whose absence
     * would be wrong.
     */
    private fun bounded(state: State): State {
        if (state.tombstones.size > maxTombstones || state.entries.size > maxEntries) {
            throw InboxConversationException(InboxConversationReason.FULL)
        }
        return state.copy(entries = state.entries.sortedByDescending { it.at })
    }

    private fun encode(state: State, nowSeconds: Long): String = Json.stringify(
        Json.obj(
            "version" to Json.of(VERSION),
            "updatedAt" to Json.of(nowSeconds),
            "tombstones" to Json.arr(
                state.tombstones.map { (id, at) ->
                    Json.obj("id" to Json.of(id), "at" to Json.of(at))
                },
            ),
            "entries" to Json.arr(
                state.entries.map {
                    Json.obj(
                        "id" to Json.of(it.id),
                        "peerDeviceId" to Json.of(it.peerDeviceId),
                        "direction" to Json.of(it.direction.name),
                        "kind" to Json.of(it.kind.name),
                        "names" to Json.arr(it.names.map { name -> Json.of(name) }),
                        "byteCount" to Json.of(it.byteCount),
                        "at" to Json.of(it.at),
                        "readAt" to Json.of(it.readAt ?: 0L),
                        "directory" to Json.of(it.directory.orEmpty()),
                        "sentState" to Json.of(it.sentState?.name.orEmpty()),
                    )
                },
            ),
        ),
    )

    private fun decode(text: String): State {
        val root = Json.parseOrNull(text) as? Json.Obj ?: unreadable()
        if ((root["version"] as? Json.Num)?.value != VERSION.toDouble()) unreadable()
        val tombstones = ((root["tombstones"] as? Json.Arr)?.items ?: unreadable())
            .associate { row ->
                val entry = row as? Json.Obj ?: unreadable()
                val at = (entry["at"] as? Json.Num)?.value ?: unreadable()
                if (!at.isFinite() || at != Math.floor(at) || at < 0) unreadable()
                ((entry["id"] as? Json.Str)?.value ?: unreadable()) to at.toLong()
            }
        val entries = ((root["entries"] as? Json.Arr)?.items ?: unreadable()).map { row ->
            val entry = row as? Json.Obj ?: unreadable()
            fun str(key: String) = (entry[key] as? Json.Str)?.value ?: unreadable()
            fun whole(key: String): Long {
                val value = (entry[key] as? Json.Num)?.value ?: unreadable()
                if (!value.isFinite() || value != Math.floor(value) || value < 0) unreadable()
                return value.toLong()
            }
            val readAt = whole("readAt")
            InboxConversationEntry(
                id = InboxId.checked(str("id"), "id"),
                peerDeviceId = str("peerDeviceId"),
                direction = enumValueOf(str("direction")),
                kind = enumValueOf(str("kind")),
                names = ((entry["names"] as? Json.Arr)?.items ?: unreadable())
                    .map { (it as? Json.Str)?.value ?: unreadable() },
                byteCount = whole("byteCount"),
                at = whole("at"),
                readAt = readAt.takeIf { it > 0 },
                directory = str("directory").ifEmpty { null },
                sentState = str("sentState").ifEmpty { null }
                    ?.let { runCatching { enumValueOf<InboxConversationEntry.SentState>(it) }.getOrNull() },
            )
        }
        // A row that is also tombstoned is a record this build could not have
        // written: recording refuses a tombstoned id, and deletion removes the
        // row it tombstones.
        if (entries.any { it.id in tombstones }) unreadable()
        return State(entries, tombstones)
    }

    private fun unreadable(): Nothing =
        throw InboxConversationException(InboxConversationReason.UNREADABLE)

    private inline fun <reified T : Enum<T>> enumValueOf(name: String): T =
        runCatching { java.lang.Enum.valueOf(T::class.java, name) }.getOrNull() ?: unreadable()

    companion object {
        const val LABEL_PREFIX = "relayium/inbox/conversations"

        private const val FILE_NAME = "conversations.json"
        private const val VERSION = 1
        private const val MAX_BYTES = 8L * 1024 * 1024

        /**
         * Bounds one account's record.
         *
         * A refusal, never an eviction: see [bounded]. Generous against real
         * use, and reaching it is a state to surface rather than to resolve by
         * forgetting.
         */
        const val MAX_ENTRIES = 2000

        /** Tombstones are far smaller than what they suppress, so the bound is
         *  correspondingly larger — and it too refuses rather than drops. A
         *  dropped tombstone is a deletion undone. */
        const val MAX_TOMBSTONES = 10_000
    }
}
