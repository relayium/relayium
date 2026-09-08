package com.relayium.android.cloud

import com.relayium.protocol.Json
import com.relayium.protocol.stored.MANIFEST_MAX_SAFE_INTEGER
import com.relayium.protocol.stored.STORE_KEY_TEXT_LENGTH
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The keys of stored objects this installation uploaded.
 *
 * A stored link is `origin/d/<id>#k=<key>`. The server holds the ciphertext and
 * the id; the key exists only in that fragment and is never sent. So "show me my
 * files and let me copy their links again" is answerable only for objects whose
 * key this device kept — and for everything else the honest answer is that the
 * object is real and its link cannot be rebuilt HERE. It is never that the file
 * is missing.
 *
 * Records are sealed under a label naming the account and the object, so a
 * record copied into another account's directory does not decrypt. They are
 * account-scoped on disk as well, which is what makes signing out able to hide
 * one account's keys without touching another's.
 */
class StoredLinkKeyStore(
    private val root: File,
    private val box: SecretBox,
    /** The durable-write barriers. Platform by default; substituted only to
     *  fail a chosen barrier in a test, never to skip one. */
    private val durable: DurableFiles = DurableFiles.Platform,
) {

    /** A key and the two dates the pruning rule needs. */
    data class Record(val keyB64url: String, val expiresAt: Long, val savedAt: Long)

    private val lock = ReentrantLock()

    /** File it, replacing whatever was there. Throws on failure — a silently
     *  dropped key is a link nobody can ever rebuild. */
    fun save(accountId: String, id: String, keyB64url: String, expiresAt: Long, savedAt: Long) {
        val file = fileFor(accountId, id)
        if (!validKey(keyB64url)) {
            throw PendingUploadException(
                PendingUploadException.Reason.UNUSABLE_SELECTION,
                "that is not a key a link can carry",
            )
        }
        val body = Json.stringify(
            Json.obj(
                "key" to Json.of(keyB64url),
                "expiresAt" to Json.of(expiresAt),
                "savedAt" to Json.of(savedAt),
            ),
        ).toByteArray(Charsets.UTF_8)
        lock.withLock {
            protect {
                // The account directory and every level above it, durably linked
                // in their own parents first: this write is what licenses
                // deleting the pending job that holds the only other copy.
                durable.createDirectories(file.parentFile ?: root)
                durable.writeAtomically(file, box.seal(label(accountId, id), body))
            }
        }
    }

    /**
     * The record for one object, or null when this installation simply does not
     * have it.
     *
     * Null means ABSENT. A record that exists and cannot be read throws: the
     * user's next step differs, and answering "not on this device" for a key
     * store that is merely unavailable would be a claim this code cannot check.
     */
    fun record(accountId: String, id: String): Record? = lock.withLock {
        val file = fileFor(accountId, id)
        if (!file.isFile) return null
        if (file.length() > MAX_RECORD_BYTES) {
            throw PendingUploadException(
                PendingUploadException.Reason.STORAGE,
                "a stored-link record is larger than this build will read",
            )
        }
        val raw = protect { box.open(label(accountId, id), file.readBytes()) }
        val obj = Json.parseOrNull(String(raw, Charsets.UTF_8)) as? Json.Obj
            ?: throw PendingUploadException(
                PendingUploadException.Reason.PROTECTION,
                "a stored-link record is not in a shape this build can read",
            )
        val key = (obj["key"] as? Json.Str)?.value
        // Validated on the way OUT as well as in. What `save` wrote is not the
        // only thing a read can return — an older format or an altered file can
        // put other bytes here — and this string is interpolated straight into a
        // `#k=` fragment.
        if (key == null || !validKey(key)) {
            throw PendingUploadException(
                PendingUploadException.Reason.PROTECTION,
                "a stored-link record does not hold a usable key",
            )
        }
        // Strict, not defaulted. `expiresAt` is what the pruning rule decides
        // on, and reading a malformed one as 0 would make every unlisted key
        // look permanently expired and delete it.
        Record(
            keyB64url = key,
            expiresAt = obj.whole("expiresAt") ?: malformedRecord(),
            savedAt = obj.whole("savedAt") ?: malformedRecord(),
        )
    }

    /** Remove one key. True when nothing is left behind. */
    fun remove(accountId: String, id: String): Boolean = lock.withLock {
        val file = fileFor(accountId, id)
        if (!file.exists()) return true
        val gone = file.delete() && !file.exists()
        if (gone) runCatching { durable.syncDirectory(file.parentFile ?: root) }
        gone
    }

    /**
     * Drop keys for objects that are demonstrably gone.
     *
     * [serverIds] must be a COMPLETE, successful listing for this account. A
     * partial, failed or stale list is not evidence of absence, and pruning from
     * one would delete the key to an object that is still there.
     *
     * Even then, absence alone is not enough: the server's list does not filter
     * expired or burned rows, so a row can survive its own expiry until the
     * collector removes it, and a burned object disappears from the list the
     * moment it is read. A key is therefore dropped only when the object is
     * absent from the list AND the expiry this device recorded has passed —
     * which is the point after which no link built from it could work anyway.
     * Everything else is kept, and a key with no matching row simply does not
     * produce a row: local keys never invent server facts.
     */
    fun prune(accountId: String, serverIds: Set<String>, now: Long): Boolean = lock.withLock {
        val directory = directoryFor(accountId)
        val entries = directory.listFiles()?.filter { it.isFile } ?: return true
        var complete = true
        for (entry in entries) {
            val id = entry.name.removeSuffix(SUFFIX)
            if (entry.name == id) continue
            if (id in serverIds) continue
            val expiry = runCatching { record(accountId, id)?.expiresAt }.getOrNull() ?: continue
            if (expiry <= 0L || expiry > now) continue
            if (!entry.delete()) complete = false
        }
        runCatching { durable.syncDirectory(directory) }
        complete
    }

    private fun fileFor(accountId: String, id: String): File {
        val account = StoredObjectId.accepted(accountId)
        val safe = StoredObjectId.accepted(id)
        if (account == null || safe == null) {
            throw PendingUploadException(
                PendingUploadException.Reason.UNUSABLE_SELECTION,
                "a stored-link record was named with something this app will not use in a path",
            )
        }
        return File(File(root, account), "$safe$SUFFIX")
    }

    private fun directoryFor(accountId: String): File {
        val account = StoredObjectId.accepted(accountId)
            ?: throw PendingUploadException(
                PendingUploadException.Reason.UNUSABLE_SELECTION,
                "that is not an account id this app will use in a path",
            )
        return File(root, account)
    }

    private inline fun <T> protect(body: () -> T): T = try {
        body()
    } catch (e: SecretBoxException) {
        throw PendingUploadException(
            PendingUploadException.Reason.PROTECTION,
            "a stored-link key could not be protected on this device",
            e,
        )
    } catch (e: java.io.IOException) {
        throw PendingUploadException(
            PendingUploadException.Reason.STORAGE,
            "a stored-link key could not be written to this device",
            e,
        )
    }

    private fun malformedRecord(): Nothing = throw PendingUploadException(
        PendingUploadException.Reason.PROTECTION,
        "a stored-link record does not hold the dates this build needs",
    )

    private companion object {
        const val SUFFIX = ".bin"
        const val MAX_RECORD_BYTES = 4L * 1024

        fun label(accountId: String, id: String) = "relayium/stored-link-key/$accountId/$id"

        /** The exact alphabet and length a `#k=` fragment carries, so a key that
         *  could not survive a round trip through a link is refused where it is
         *  stored rather than where someone tries to use it. */
        fun validKey(text: String): Boolean =
            text.length == STORE_KEY_TEXT_LENGTH &&
                text.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
    }
}

/** A whole, non-negative number, or null — the same strictness the plan codec
 *  and the transport apply, for the same reason. */
private fun Json.Obj.whole(key: String): Long? {
    val value = (this[key] as? Json.Num)?.value ?: return null
    if (value.isNaN() || value != Math.floor(value)) return null
    if (value < 0 || value > MANIFEST_MAX_SAFE_INTEGER.toDouble()) return null
    return value.toLong()
}
