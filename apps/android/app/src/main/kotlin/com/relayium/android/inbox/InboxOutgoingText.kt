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
 * The text this device SENT, kept so its own history can show it.
 *
 * ## Why this exists at all
 *
 * A sent delivery leaves nothing readable behind. The ciphertext spool is
 * released once the job is over, the manifest is sealed to a content key that is
 * destroyed after staging, and the conversation entry records a kind and a byte
 * count. Without this store the sender's own history would say "a message,
 * 41 bytes" — which is not history, and is not what the iOS surface shows.
 *
 * So one small sealed record is written at STAGING, next to the job it belongs
 * to and before anything is sent: what the user wrote is durable from the moment
 * they asked for it, not from the moment a server acknowledged it.
 *
 * ## What it is not
 *
 * It is not a second copy of the delivery, and it is not a cache of the wire. It
 * is keyed by JOB id — the sender's own durable identity — so it can never be
 * confused with a received message, which is keyed by task id in
 * [InboxMessageStore]. The two stores live in different directories under
 * different label prefixes for exactly that reason.
 *
 * ## Deletion
 *
 * Removing an entry from the history removes this record with it. That is not
 * optional tidiness: the conversation ledger's tombstone stops the ROW coming
 * back, and a body left behind would be plaintext the user believes they
 * deleted, sitting on disk with nothing left to display it. Nothing here expires
 * on a timer; it is the user's own content, and only the user removes it.
 */
data class InboxOutgoingText(
    val jobId: String,
    val targetDeviceId: String,
    val text: String,
    val stagedAt: Long,
) {
    /** The BODY never reaches a diagnostic: it is the user's own content. */
    override fun toString(): String =
        "InboxOutgoingText(job=$jobId, bytes=${text.toByteArray(Charsets.UTF_8).size})"
}

enum class InboxOutgoingTextReason {
    INVALID_JOB_ID,
    UNREADABLE,
    STORAGE,
    MALFORMED_TEXT,

    /**
     * A record already exists for this job and says something DIFFERENT.
     *
     * A job's identity is immutable: its idempotency key, its sealed manifest
     * and its framed ciphertext were all fixed at preparation, and central
     * converges a repeat onto the delivery those bytes describe. A second text
     * under the same id is therefore either a different delivery wearing the
     * wrong name or a caller confusing two jobs — and quietly replacing the
     * body would leave the history asserting one message while the recipient
     * receives another.
     */
    JOB_IMMUTABLE,
}

class InboxOutgoingTextException(
    val reason: InboxOutgoingTextReason,
    cause: Throwable? = null,
) : RuntimeException("relayium inbox outgoing text: $reason", cause)

/** One account's sent messages, sealed at rest under the account AND the job. */
class InboxOutgoingTextStore(
    val directory: File,
    private val account: InboxAccountId,
    private val secrets: SecretBox,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val lock = Mutex()

    /**
     * Record what was sent, under an identity that cannot change.
     *
     * A job's text is fixed at preparation — the same bytes are already sealed
     * into its manifest and its spool — so a second, DIFFERENT text under the
     * same id is a caller confusing two deliveries, and is refused
     * ([InboxOutgoingTextReason.JOB_IMMUTABLE]) rather than allowed to make this
     * history assert one message while the recipient receives another. The
     * identical repeat is the ordinary case and is idempotent: it keeps the
     * original record, timestamp included.
     */
    suspend fun commit(
        jobId: String,
        targetDeviceId: String,
        text: String,
        stagedAtSeconds: Long,
    ): InboxOutgoingText = lock.withLock {
        if (!InboxMessageStore.isAcceptable(text)) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.MALFORMED_TEXT)
        }
        val id = InboxId.checkedJob(jobId)
        val target = InboxId.checkedJob(targetDeviceId)
        // An UNREADABLE existing record is propagated rather than overwritten:
        // it is evidence about a job this store already knows, and replacing it
        // on a guess is how one delivery's body ends up filed under another's.
        val existing = readLocked(id)
        if (existing != null) {
            // An identical replay is the ordinary case — a retried staging, a
            // repaired crash window — and is idempotent, keeping the ORIGINAL
            // timestamp so a repeat cannot re-date the user's own history.
            if (existing.text == text && existing.targetDeviceId == target) {
                return@withLock existing
            }
            throw InboxOutgoingTextException(InboxOutgoingTextReason.JOB_IMMUTABLE)
        }
        val record = InboxOutgoingText(id, target, text, stagedAtSeconds)
        write(record)
        record
    }

    suspend fun read(jobId: String): InboxOutgoingText? = lock.withLock { readLocked(jobId) }

    /** Every readable record, newest first. An unreadable one is skipped rather
     *  than failing the list: one bad file must not hide the rest. */
    suspend fun all(): List<InboxOutgoingText> = lock.withLock {
        withContext(io) { directory.list().orEmpty() }
            .filter { it.endsWith(SUFFIX) }
            .mapNotNull { name ->
                val jobId = name.removeSuffix(SUFFIX)
                try {
                    readLocked(jobId)
                } catch (e: InboxOutgoingTextException) {
                    null
                }
            }
            .sortedByDescending { it.stagedAt }
    }

    /** Remove one record. The user's decision, never a timer's. */
    suspend fun delete(jobId: String): Boolean = lock.withLock {
        withContext(io) {
            val file = try {
                file(jobId)
            } catch (e: InboxOutgoingTextException) {
                // An id this store could never have written cannot name a
                // record, so there is nothing to remove and nothing to report.
                return@withContext false
            }
            val existed = file.exists()
            if (existed && !file.delete()) {
                throw InboxOutgoingTextException(InboxOutgoingTextReason.STORAGE)
            }
            if (existed && directory.isDirectory) {
                try {
                    files.syncDirectory(directory)
                } catch (e: IOException) {
                    throw InboxOutgoingTextException(InboxOutgoingTextReason.STORAGE, e)
                }
            }
            existed
        }
    }

    // ── storage ─────────────────────────────────────────────────────────────

    private fun file(jobId: String): File =
        File(directory, InboxId.checkedJob(jobId) + SUFFIX)

    /** Binds the account AND the job, so a record moved between either fails to
     *  open rather than being presented under the wrong delivery. */
    private fun label(jobId: String) = "$LABEL_PREFIX/${account.value}/$jobId"

    private suspend fun readLocked(jobId: String): InboxOutgoingText? = withContext(io) {
        val file = file(jobId)
        if (!file.exists()) return@withContext null
        val sealed = try {
            if (file.length() > MAX_RECORD_BYTES) {
                throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.STORAGE, e)
        }
        val plaintext = try {
            secrets.open(label(jobId), sealed)
        } catch (e: SecretBoxException) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE, e)
        }
        try {
            decode(String(plaintext, Charsets.UTF_8), jobId)
        } finally {
            plaintext.fill(0)
        }
    }

    private suspend fun write(record: InboxOutgoingText) = withContext(io) {
        val plaintext = encode(record).toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(record.jobId), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(file(record.jobId), sealed)
        } catch (e: IOException) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.STORAGE, e)
        }
    }

    private fun encode(record: InboxOutgoingText): String = Json.stringify(
        Json.obj(
            "version" to Json.of(VERSION),
            "jobId" to Json.of(record.jobId),
            "targetDeviceId" to Json.of(record.targetDeviceId),
            "text" to Json.of(record.text),
            "stagedAt" to Json.of(record.stagedAt),
        ),
    )

    private fun decode(text: String, jobId: String): InboxOutgoingText {
        val root = Json.parseOrNull(text) as? Json.Obj
            ?: throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        fun str(key: String) = (root[key] as? Json.Str)?.value
            ?: throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        val version = (root["version"] as? Json.Num)?.value
        if (version == null || version != VERSION.toDouble()) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        }
        // The file name is the job id; a record naming another job was moved,
        // and presenting it here would attribute one delivery's text to another.
        if (str("jobId") != jobId) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        }
        val body = str("text")
        if (!InboxMessageStore.isAcceptable(body)) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        }
        val stagedAt = (root["stagedAt"] as? Json.Num)?.value
            ?: throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        if (!stagedAt.isFinite() || stagedAt != Math.floor(stagedAt) || stagedAt < 0) {
            throw InboxOutgoingTextException(InboxOutgoingTextReason.UNREADABLE)
        }
        return InboxOutgoingText(jobId, str("targetDeviceId"), body, stagedAt.toLong())
    }

    companion object {
        /** Distinct from the received store's prefix, so neither can open the
         *  other's records even inside one account. */
        const val LABEL_PREFIX = "relayium/inbox/outgoing-text"

        private const val SUFFIX = ".json"
        private const val VERSION = 1

        /** The protocol bounds a message at 64 KiB; the record adds only its
         *  small envelope. */
        private const val MAX_RECORD_BYTES = 1L * 1024 * 1024
    }
}

/** The id check, reported in this store's own vocabulary. */
private fun InboxId.checkedJob(id: String): String = try {
    checked(id, "jobId")
} catch (e: InboxWireException) {
    throw InboxOutgoingTextException(InboxOutgoingTextReason.INVALID_JOB_ID, e)
}
