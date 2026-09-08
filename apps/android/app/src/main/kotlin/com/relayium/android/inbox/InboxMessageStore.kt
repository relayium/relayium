package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.android.cloud.SecretBoxException
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxManifest
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Received messages, as messages.
 *
 * ## Why this is not a `.txt` file in the received directory
 *
 * `inbox.text.v1` is a promise to the SENDER that this receiver presents a text
 * delivery as text. A build that wrote messages into the receive folder as files
 * and announced the token would be making that promise falsely — and the whole
 * value of the token is that its absence is truthful. So a message is committed
 * here, keyed by task id, and read back by a surface that shows it.
 *
 * The practical consequence is the one the protocol intends: a message does not
 * depend on the receive directory at all. A container that is missing, full or
 * unwritable has nothing to do with whether a message can land, which is why the
 * receiver classifies kind BEFORE it consults the container.
 *
 * ## Retention
 *
 * A journal is bookkeeping ABOUT a delivery and expires once it can no longer
 * prevent a duplicate. A message IS the delivery — the user's own content — so
 * nothing here expires on a timer. It is removed when the user deletes it, or
 * when the account's data is destroyed.
 */
data class InboxMessage(
    val taskId: String,
    val senderDeviceId: String,
    val text: String,
    val receivedAt: Long,
) {
    /** The BODY never reaches a diagnostic: it is the user's own content. */
    override fun toString(): String =
        "InboxMessage(task=$taskId, bytes=${text.toByteArray(Charsets.UTF_8).size})"
}

enum class InboxMessageReason { INVALID_TASK_ID, UNREADABLE, STORAGE, MALFORMED_TEXT }

class InboxMessageException(val reason: InboxMessageReason, cause: Throwable? = null) :
    RuntimeException("relayium inbox message: $reason", cause)

/** One account's received messages, sealed at rest. */
class InboxMessageStore(
    val directory: File,
    private val account: InboxAccountId,
    private val secrets: SecretBox,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val lock = Mutex()

    /**
     * Commit one message, replacing any record under the same task id.
     *
     * Replacement is what makes this idempotent across a re-delivery: the store
     * is keyed by task id, so a crash between committing here and journalling it
     * costs a re-download that rewrites the SAME record at the SAME name. The
     * window produces a duplicate of nothing.
     */
    suspend fun commit(
        taskId: String,
        senderDeviceId: String,
        text: String,
        receivedAtSeconds: Long,
    ): InboxMessage = lock.withLock {
        if (!isAcceptable(text)) {
            throw InboxMessageException(InboxMessageReason.MALFORMED_TEXT)
        }
        val message = InboxMessage(taskId, senderDeviceId, text, receivedAtSeconds)
        write(message)
        message
    }

    suspend fun read(taskId: String): InboxMessage? = lock.withLock { readLocked(taskId) }

    /** Every readable message, newest first. An unreadable record is skipped
     *  rather than failing the list: one bad file must not hide the rest. */
    suspend fun all(): List<InboxMessage> = lock.withLock {
        withContext(io) { directory.list().orEmpty() }
            .filter { it.endsWith(SUFFIX) }
            .mapNotNull { name ->
                try {
                    readLocked(name.removeSuffix(SUFFIX))
                } catch (_: InboxMessageException) {
                    null
                }
            }
            .sortedByDescending { it.receivedAt }
    }

    /** Remove one message. The user's decision, never a timer's. */
    suspend fun delete(taskId: String): Boolean = lock.withLock {
        withContext(io) {
            val file = file(taskId)
            val existed = file.exists()
            if (existed && !file.delete()) {
                throw InboxMessageException(InboxMessageReason.STORAGE)
            }
            if (existed && directory.isDirectory) {
                try {
                    files.syncDirectory(directory)
                } catch (e: IOException) {
                    throw InboxMessageException(InboxMessageReason.STORAGE, e)
                }
            }
            existed
        }
    }

    // ── storage ─────────────────────────────────────────────────────────────

    private fun file(taskId: String): File = try {
        File(directory, InboxId.checked(taskId, "taskId") + SUFFIX)
    } catch (e: InboxWireException) {
        throw InboxMessageException(InboxMessageReason.INVALID_TASK_ID, e)
    }

    /** Binds the account AND the task, so a record moved between either fails to
     *  open rather than being presented under the wrong conversation. */
    private fun label(taskId: String) = "$LABEL_PREFIX/${account.value}/$taskId"

    private suspend fun readLocked(taskId: String): InboxMessage? = withContext(io) {
        val file = file(taskId)
        if (!file.exists()) return@withContext null
        val sealed = try {
            if (file.length() > MAX_RECORD_BYTES) {
                throw InboxMessageException(InboxMessageReason.UNREADABLE)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxMessageException(InboxMessageReason.STORAGE, e)
        }
        val plaintext = try {
            secrets.open(label(taskId), sealed)
        } catch (e: SecretBoxException) {
            throw InboxMessageException(InboxMessageReason.UNREADABLE, e)
        }
        try {
            decode(String(plaintext, Charsets.UTF_8), taskId)
        } finally {
            plaintext.fill(0)
        }
    }

    private suspend fun write(message: InboxMessage) = withContext(io) {
        val plaintext = encode(message).toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(message.taskId), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxMessageException(InboxMessageReason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(file(message.taskId), sealed)
        } catch (e: IOException) {
            throw InboxMessageException(InboxMessageReason.STORAGE, e)
        }
    }

    private fun encode(message: InboxMessage): String = Json.stringify(
        Json.obj(
            "version" to Json.of(VERSION),
            "taskId" to Json.of(message.taskId),
            "senderDeviceId" to Json.of(message.senderDeviceId),
            "text" to Json.of(message.text),
            "receivedAt" to Json.of(message.receivedAt),
        ),
    )

    private fun decode(text: String, taskId: String): InboxMessage {
        val root = Json.parseOrNull(text) as? Json.Obj
            ?: throw InboxMessageException(InboxMessageReason.UNREADABLE)
        fun str(key: String) = (root[key] as? Json.Str)?.value
            ?: throw InboxMessageException(InboxMessageReason.UNREADABLE)
        val version = (root["version"] as? Json.Num)?.value
        if (version == null || version != VERSION.toDouble()) {
            throw InboxMessageException(InboxMessageReason.UNREADABLE)
        }
        // The file name is the task id; a record naming another task was moved,
        // and presenting it here would attribute one conversation's message to
        // another.
        if (str("taskId") != taskId) throw InboxMessageException(InboxMessageReason.UNREADABLE)
        val body = str("text")
        if (!isAcceptable(body)) throw InboxMessageException(InboxMessageReason.UNREADABLE)
        val receivedAt = (root["receivedAt"] as? Json.Num)?.value
            ?: throw InboxMessageException(InboxMessageReason.UNREADABLE)
        if (!receivedAt.isFinite() || receivedAt != Math.floor(receivedAt) || receivedAt < 0) {
            throw InboxMessageException(InboxMessageReason.UNREADABLE)
        }
        return InboxMessage(taskId, str("senderDeviceId"), body, receivedAt.toLong())
    }

    companion object {
        const val LABEL_PREFIX = "relayium/inbox/message"

        private const val SUFFIX = ".json"
        private const val VERSION = 1

        /** The protocol bounds a message at 64 KiB; the record adds only its
         *  small envelope, and JSON escaping cannot inflate it far. */
        private const val MAX_RECORD_BYTES = 1L * 1024 * 1024

        /**
         * What may be stored as a message.
         *
         * Bounded by the protocol's own text limits, and non-empty. Nothing is
         * repaired: a body that is not exactly what the sender wrote is not the
         * message, and showing a mended one would put words on screen that
         * nobody sent.
         */
        fun isAcceptable(text: String): Boolean {
            val bytes = text.toByteArray(Charsets.UTF_8).size.toLong()
            return bytes >= InboxManifest.MIN_TEXT_BYTES && bytes <= InboxManifest.MAX_TEXT_BYTES
        }
    }
}
