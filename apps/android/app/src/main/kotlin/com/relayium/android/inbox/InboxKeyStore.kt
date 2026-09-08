package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.android.cloud.SecretBoxException
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxDeviceKeyPair
import com.relayium.protocol.inbox.InboxKeyException
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * This device's X25519 private-key history, bound to ONE account.
 *
 * ## Why a history and not a key
 *
 * Central binds a task to the key it was sealed to at creation, so a rotation
 * does not invalidate work already queued: the superseded key is still the only
 * thing that can open those tasks. Keeping only "the current key" would silently
 * strand every task queued before the last rotation, so nothing here ever
 * removes a superseded record — only [destroy] deletes, and it deletes a whole
 * account at once. Records are held under CENTRAL's key id, so a claim naming
 * `TargetKeyID` resolves to the right private key with no guessing.
 *
 * ## Why the record is written before the key is published
 *
 * [append] returns only once the private key is durable. If registration then
 * fails, or its response is lost, the worst case is an unpublished local key —
 * recoverable, and [InboxEnrolment] recovers it by asking central which id it
 * gave the key we already hold. The reverse order's worst case is a published
 * public key whose private half never reached storage, which makes every task
 * sealed to it permanently undecryptable, by anybody, forever.
 *
 * ## Why it is account-bound at the level of the type
 *
 * Two accounts can be signed in on one device in sequence, and an async
 * operation started under one can land under the next. Every operation here
 * names its account, so a sign-out, an account switch or a late task cannot read
 * one account's keys under another's session — and a [destroy] for one account
 * cannot reach the other's history.
 *
 * ## What is at rest, and under which identity
 *
 * The history is sealed with [SecretBox] under an alias and a label that are
 * this feature's OWN. Sharing the cloud upload alias would conflate two
 * different secrets under one keystore key, so an invalidation or a wipe aimed
 * at one would silently take the other with it — and a record sealed for one
 * purpose could be unsealed under the other. The label additionally binds the
 * account, so a record moved between account files fails to open rather than
 * decrypting into the wrong history.
 */

/**
 * A checked account identifier.
 *
 * A type rather than a `String` because this value becomes both a file name and
 * part of a keystore AAD label. A raw string could name a different account's
 * history, or a path outside the store's own directory.
 */
class InboxAccountId(raw: String) {
    val value: String = InboxId.checked(raw, "accountId")

    override fun equals(other: Any?): Boolean =
        other is InboxAccountId && other.value == value

    override fun hashCode(): Int = value.hashCode()

    override fun toString(): String = "InboxAccountId($value)"
}

/**
 * One generation of this device's key material, as callers may see it.
 *
 * There is deliberately no private-key field. The private half never leaves this
 * store except inside an [InboxDeviceKeyPair], which copies it and can be
 * destroyed by whoever asked — so no caller can accidentally hold, log or
 * serialise the one value that must not travel.
 */
data class InboxKeyRecord(
    /** Central's id for this key. EMPTY between [InboxKeyStoring.append] and the
     *  registration response — the window [InboxKeyStoring.bind] closes. */
    val keyId: String,
    val generation: Long,
    val algorithm: String,
    val publicKey: String,
    val createdAt: Long,
) {
    /** Whether central has acknowledged this key. */
    val isPublished: Boolean get() = keyId.isNotEmpty()
}

/** Why a key-history operation did not happen. Closed, and no value is carried. */
enum class InboxKeyStoreReason {
    /** The stored history is unreadable or a version this build does not
     *  understand. Refused rather than parsed optimistically: guessing at a
     *  format could mean writing a file a newer build treats as authoritative
     *  while it is missing keys. */
    UNREADABLE_HISTORY,

    /** A public key already in this account's history was appended again.
     *  Re-registering an existing key is a downgrade, not a rotation. */
    KEY_ALREADY_PRESENT,

    /** A server key id would end up bound to two different local keys, which
     *  would make "which private key opens this task" ambiguous. */
    KEY_ID_ALREADY_BOUND,

    /** [InboxKeyStoring.bind] named a public key this account does not hold. */
    NO_SUCH_LOCAL_KEY,

    /**
     * A record central has already acknowledged was asked to take a DIFFERENT
     * server id or generation.
     *
     * Refused rather than applied: the old id is what every task already queued
     * to this key names in its `TargetKeyID`, so overwriting the binding would
     * make those deliveries unresolvable while the private half sits right
     * there. An identical rebinding is still a no-op.
     */
    KEY_ALREADY_PUBLISHED,

    /** The keystore or the filesystem refused. */
    STORAGE,
}

class InboxKeyStoreException(val reason: InboxKeyStoreReason, cause: Throwable? = null) :
    RuntimeException("relayium inbox key store: $reason", cause)

/** The operations the enrolment and receive paths need from a key history. */
interface InboxKeyStoring {

    /** Oldest first. Public metadata only. */
    suspend fun load(account: InboxAccountId): List<InboxKeyRecord>

    /** Durably record a newly generated key BEFORE it is published. */
    suspend fun append(
        keyPair: InboxDeviceKeyPair,
        account: InboxAccountId,
        nowSeconds: Long,
    ): InboxKeyRecord

    /** Record the id and generation central assigned to an already-durable key. */
    suspend fun bind(
        publicKey: String,
        keyId: String,
        generation: Long,
        account: InboxAccountId,
    )

    /**
     * Resolve the private key a task names, or null when this account does not
     * hold it.
     *
     * The caller owns the returned pair and should destroy it when done.
     */
    suspend fun keyPair(keyId: String, account: InboxAccountId): InboxDeviceKeyPair?

    suspend fun record(publicKey: String, account: InboxAccountId): InboxKeyRecord?

    /** The record central bound to [keyId], or null. Public metadata only, so a
     *  caller can check what it holds without materialising a private key. */
    suspend fun recordForKeyId(keyId: String, account: InboxAccountId): InboxKeyRecord?

    /**
     * Move an UNREADABLE history aside so a fresh one can be started, and report
     * whether there was one.
     *
     * Preserves rather than deletes: the bytes may still hold private keys that
     * a restored keystore could open, and every task already queued to them
     * names those keys. Only an explicit, confirmed repair calls this — nothing
     * on an ordinary path may reach it, because "I cannot read this" is not
     * evidence that it is worthless.
     */
    suspend fun quarantineUnreadable(account: InboxAccountId): Boolean

    /**
     * Can this device seal a NEW history and read it straight back?
     *
     * Asked BEFORE any repair that discards the old one. Renaming a history does
     * nothing for a keystore key that is permanently invalidated: the old
     * records stay unreadable and the replacement cannot be written either, so a
     * repair that went ahead would destroy the only copy of the private halves
     * and still leave the device unable to receive. A false answer means the
     * honest report is "not repairable here", not a quieter failure.
     */
    suspend fun canStoreNewHistory(account: InboxAccountId): Boolean

    /** The newest record, published or not. */
    suspend fun latest(account: InboxAccountId): InboxKeyRecord?

    /** Destroy ONE account's history. */
    suspend fun destroy(account: InboxAccountId)
}

/**
 * The on-device history: one sealed file per account.
 *
 * Serialised whole and replaced atomically rather than appended to. A history is
 * a handful of small records, and "the file is the previous history or the next
 * one, never a blend" is worth more here than an append optimisation: a torn
 * record is a private key that cannot be read, which is the failure this whole
 * type exists to avoid.
 */
class InboxKeyStore(
    /** App-private, and expected to be `noBackupFilesDir` — see
     *  [InboxContainer]. A private key that travelled in a device transfer
     *  would outlive the Keystore entry that makes it readable, leaving a
     *  record nothing can open. */
    root: File,
    private val secrets: SecretBox,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : InboxKeyStoring {

    private val directory = File(root, DIRECTORY)

    /**
     * Serialises read-modify-write across coroutines.
     *
     * Every mutation below reads the whole history, changes one record and
     * writes it back, so two concurrent appends without this would lose one key
     * — and a lost key is an undecryptable delivery rather than a retryable
     * error.
     */
    private val lock = Mutex()

    override suspend fun load(account: InboxAccountId): List<InboxKeyRecord> =
        lock.withLock { read(account).map { it.public } }

    override suspend fun append(
        keyPair: InboxDeviceKeyPair,
        account: InboxAccountId,
        nowSeconds: Long,
    ): InboxKeyRecord = lock.withLock {
        val publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        val history = read(account)
        if (history.any { it.public.publicKey == publicKey }) {
            throw InboxKeyStoreException(InboxKeyStoreReason.KEY_ALREADY_PRESENT)
        }
        val privateKey = keyPair.privateKeyCopy()
        val stored = try {
            Stored(
                public = InboxKeyRecord(
                    keyId = "", generation = 0,
                    algorithm = InboxProtocol.KEY_ALGORITHM,
                    publicKey = publicKey, createdAt = nowSeconds,
                ),
                privateKey = InboxKeyMaterial.encode(privateKey),
            )
        } finally {
            // The scalar's time in this heap is bounded to the encode above; the
            // encoded text is what the sealed record holds.
            privateKey.fill(0)
        }
        // Returns only once the bytes are on the storage device. Everything
        // about the publish ordering rests on that.
        write(account, history + stored)
        stored.public
    }

    override suspend fun bind(
        publicKey: String,
        keyId: String,
        generation: Long,
        account: InboxAccountId,
    ) = lock.withLock {
        val checked = InboxId.checked(keyId, "keyId")
        require(generation > 0) { "a key generation is 1-based" }
        val history = read(account)
        val index = history.indexOfFirst { it.public.publicKey == publicKey }
        if (index < 0) throw InboxKeyStoreException(InboxKeyStoreReason.NO_SUCH_LOCAL_KEY)
        // One server id, one local key. Two would make "which private key opens
        // this task" ambiguous, and the wrong answer is an unopenable delivery.
        if (history.any { it.public.keyId == checked && it.public.publicKey != publicKey }) {
            throw InboxKeyStoreException(InboxKeyStoreReason.KEY_ID_ALREADY_BOUND)
        }
        val existing = history[index]
        if (existing.public.keyId == checked && existing.public.generation == generation) {
            return@withLock // already recorded; a repeated bind is a no-op
        }
        // Anything else applied to an already-published record would drop the id
        // under which tasks are already queued to this exact key.
        if (existing.public.isPublished) {
            throw InboxKeyStoreException(InboxKeyStoreReason.KEY_ALREADY_PUBLISHED)
        }
        val updated = history.toMutableList()
        updated[index] = existing.copy(
            public = existing.public.copy(keyId = checked, generation = generation),
        )
        write(account, updated)
    }

    override suspend fun keyPair(keyId: String, account: InboxAccountId): InboxDeviceKeyPair? =
        lock.withLock {
            if (keyId.isEmpty()) return@withLock null
            val stored = read(account).firstOrNull { it.public.keyId == keyId }
                ?: return@withLock null
            stored.keyPair()
        }

    override suspend fun record(publicKey: String, account: InboxAccountId): InboxKeyRecord? =
        lock.withLock { read(account).firstOrNull { it.public.publicKey == publicKey }?.public }

    override suspend fun recordForKeyId(keyId: String, account: InboxAccountId): InboxKeyRecord? =
        lock.withLock {
            if (keyId.isEmpty()) return@withLock null
            read(account).firstOrNull { it.public.keyId == keyId }?.public
        }

    override suspend fun latest(account: InboxAccountId): InboxKeyRecord? =
        lock.withLock { read(account).lastOrNull()?.public }

    override suspend fun canStoreNewHistory(account: InboxAccountId): Boolean {
        // A round trip, not just a seal: an invalidated key can still be usable
        // for one direction on some platforms, and what the repair needs is that
        // a record written now can be READ BACK later.
        val probe = "probe".toByteArray(Charsets.UTF_8)
        return try {
            val label = "${label(account)}/probe"
            secrets.open(label, secrets.seal(label, probe)).contentEquals(probe)
        } catch (_: SecretBoxException) {
            false
        }
    }

    override suspend fun quarantineUnreadable(account: InboxAccountId): Boolean =
        lock.withLock {
            val file = file(account)
            if (!withContext(io) { file.exists() }) return@withLock false
            // ONLY an unreadable history may be moved aside. Catching more
            // broadly would let a cancelled coroutine or a transient I/O error
            // stand in as proof that a perfectly good key history is worthless —
            // and the action taken on that "proof" destroys it.
            try {
                read(account)
                // It reads. Quarantine is a repair for an unreadable file, and
                // applying it here would abandon live keys for no reason.
                throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE)
            } catch (e: InboxKeyStoreException) {
                if (e.reason != InboxKeyStoreReason.UNREADABLE_HISTORY) throw e
            }
            // The read above blocked. Re-check the caller's authority before the
            // one irreversible step, so a repair the user cancelled meanwhile
            // does not still move their history.
            currentCoroutineContext().ensureActive()
            withContext(io) {
                var ordinal = 0
                var target: File
                do {
                    target = File(directory, "${account.value}.unreadable.$ordinal")
                    ordinal += 1
                } while (target.exists() && ordinal < MAX_QUARANTINE)
                if (target.exists() || !file.renameTo(target)) {
                    throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE)
                }
                // A rename is a DIRECTORY write. Swallowing its sync would mean
                // a crash could leave the old history back under its live name
                // while a new one was already published against it.
                try {
                    files.syncDirectory(directory)
                } catch (e: IOException) {
                    throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE, e)
                }
                true
            }
        }

    /**
     * Destroy ONE account's history.
     *
     * EXPLICIT only. Signing out is not this: a superseded private key is what
     * opens tasks already queued to it, and destroying the history because a
     * session ended would strand deliveries the user has not seen yet. Only a
     * deliberate "remove this device's inbox keys" reaches here.
     *
     * The directory sync is PROPAGATED rather than swallowed. A removal that
     * reported success on a refused sync would let a surface tell the user their
     * keys are gone while the file is still recoverable — the same truthful
     * contract quarantine and message deletion already keep.
     */
    override suspend fun destroy(account: InboxAccountId) = lock.withLock {
        withContext(io) {
            val file = file(account)
            if (file.exists() && !file.delete()) {
                throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE)
            }
            if (directory.isDirectory) {
                try {
                    files.syncDirectory(directory)
                } catch (e: IOException) {
                    throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE, e)
                }
            }
            Unit
        }
    }

    // ── storage ─────────────────────────────────────────────────────────────

    /** One record as it is persisted: the public metadata plus the private half. */
    private data class Stored(val public: InboxKeyRecord, val privateKey: String) {
        fun keyPair(): InboxDeviceKeyPair {
            val secret = try {
                InboxKeyMaterial.decode(privateKey, InboxProtocol.SECRET_KEY_BYTES)
            } catch (e: InboxKeyException) {
                throw InboxKeyStoreException(InboxKeyStoreReason.UNREADABLE_HISTORY, e)
            }
            return try {
                InboxDeviceKeyPair(
                    InboxKeyMaterial.decode(public.publicKey, InboxProtocol.PUBLIC_KEY_BYTES),
                    secret,
                )
            } catch (e: InboxKeyException) {
                throw InboxKeyStoreException(InboxKeyStoreReason.UNREADABLE_HISTORY, e)
            } finally {
                secret.fill(0)
            }
        }
    }

    private fun file(account: InboxAccountId) = File(directory, "${account.value}.json")

    /** The AAD label. Account-bound, so a record file moved between accounts
     *  fails to open rather than decrypting into the wrong history. */
    private fun label(account: InboxAccountId) = "$LABEL_PREFIX/${account.value}"

    private suspend fun read(account: InboxAccountId): List<Stored> = withContext(io) {
        val file = file(account)
        // Absent is the normal first-run case and is NOT a failure; unreadable
        // is, and the two must not be collapsed — the second would silently
        // present as "this device has never had a key" and invite a rotation
        // over ciphertext that is already queued to the key we cannot read.
        if (!file.exists()) return@withContext emptyList()
        val sealed = try {
            if (file.length() > MAX_HISTORY_BYTES) {
                throw InboxKeyStoreException(InboxKeyStoreReason.UNREADABLE_HISTORY)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE, e)
        }
        val plaintext = try {
            secrets.open(label(account), sealed)
        } catch (e: SecretBoxException) {
            throw InboxKeyStoreException(InboxKeyStoreReason.UNREADABLE_HISTORY, e)
        }
        try {
            decode(String(plaintext, Charsets.UTF_8))
        } finally {
            // Bounds how long the encoded private keys sit in a heap that may be
            // swapped or captured in a crash dump — the same reason the write
            // path wipes its own buffer.
            plaintext.fill(0)
        }
    }

    private suspend fun write(account: InboxAccountId, history: List<Stored>) = withContext(io) {
        val plaintext = encode(history).toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(account), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        // Checked BEFORE the replacement, not after: a history large enough to
        // be refused on reload would otherwise be written over a good one, and
        // the next read would call it unreadable — losing keys that were fine a
        // moment ago.
        if (sealed.size > MAX_HISTORY_BYTES) {
            throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(file(account), sealed)
        } catch (e: IOException) {
            throw InboxKeyStoreException(InboxKeyStoreReason.STORAGE, e)
        }
    }

    private fun encode(history: List<Stored>): String = Json.stringify(
        Json.obj(
            "version" to Json.of(VERSION),
            "keys" to Json.arr(
                history.map {
                    Json.obj(
                        "keyId" to Json.of(it.public.keyId),
                        "generation" to Json.of(it.public.generation),
                        "algorithm" to Json.of(it.public.algorithm),
                        "publicKey" to Json.of(it.public.publicKey),
                        "privateKey" to Json.of(it.privateKey),
                        "createdAt" to Json.of(it.public.createdAt),
                    )
                },
            ),
        ),
    )

    /**
     * Parse a history, refusing anything this build would not have written.
     *
     * Every check here answers a way the file could be wrong that a lenient
     * reader would turn into a WORSE outcome than a refusal:
     *
     *  * a non-integral or out-of-range number — `1.9` read through `toInt()` is
     *    a version 1 this file is not;
     *  * an unsupported algorithm, or key material of the wrong length — a
     *    record that cannot open anything, presented as if it could;
     *  * a published record with no generation, or an unpublished one carrying
     *    an id — the two halves of "central acknowledged this" disagreeing;
     *  * a duplicate key id or public key — "which private key opens this task"
     *    with two answers;
     *  * a private half that does not belong to the public half. That one is
     *    checked by actually sealing to the public key and opening it with the
     *    pair, because a mismatched record is exactly the shape that looks fine
     *    until a real delivery cannot be decrypted.
     */
    private fun decode(text: String): List<Stored> {
        val root = Json.parseOrNull(text) as? Json.Obj ?: unreadable()
        if (whole(root, "version") != VERSION.toLong()) unreadable()
        val rows = (root["keys"] as? Json.Arr)?.items ?: unreadable()
        if (rows.size > MAX_RECORDS) unreadable()
        val out = ArrayList<Stored>(rows.size)
        val seenIds = HashSet<String>()
        val seenPublic = HashSet<String>()
        for (row in rows) {
            val entry = row as? Json.Obj ?: unreadable()
            val keyId = text(entry, "keyId")
            val generation = whole(entry, "generation")
            val algorithm = text(entry, "algorithm")
            val publicKey = text(entry, "publicKey")
            val privateKey = text(entry, "privateKey")

            // Nothing but the one algorithm this protocol version defines. A
            // record naming another cannot be used, and keeping it readable
            // would mean presenting it as a candidate.
            if (algorithm != InboxProtocol.KEY_ALGORITHM) unreadable()
            // Published and unpublished are two complete shapes; a half of
            // either is a record whose meaning is not decidable.
            if (keyId.isEmpty()) {
                if (generation != 0L) unreadable()
            } else {
                if (!InboxId.isValid(keyId) || generation <= 0) unreadable()
                if (!seenIds.add(keyId)) unreadable()
            }
            if (!seenPublic.add(publicKey)) unreadable()

            val stored = Stored(
                public = InboxKeyRecord(
                    keyId = keyId, generation = generation, algorithm = algorithm,
                    publicKey = publicKey, createdAt = whole(entry, "createdAt"),
                ),
                privateKey = privateKey,
            )
            // Lengths, encoding and low-order refusal, then the material match.
            val pair = stored.keyPair()
            try {
                if (!opensItsOwnSeal(publicKey, pair)) unreadable()
            } finally {
                pair.destroy()
            }
            out.add(stored)
        }
        return out
    }

    /**
     * Does this private half actually belong to this public half?
     *
     * Answered by a real seal and open rather than by re-deriving the public key,
     * because the scalar multiplication that would do so is not on this module's
     * classpath — and because a round trip proves the thing that is actually
     * needed: that a content key sealed to the published key can be recovered
     * here.
     */
    private fun opensItsOwnSeal(publicKey: String, pair: InboxDeviceKeyPair): Boolean = try {
        val probe = ByteArray(InboxProtocol.CONTENT_KEY_BYTES) { (it + 1).toByte() }
        val sealed = InboxKeyMaterial.sealContentKey(
            InboxProtocol.KEY_ALGORITHM, publicKey, probe,
        )
        val opened = InboxKeyMaterial.unsealContentKey(
            InboxProtocol.KEY_ALGORITHM, sealed, pair,
        )
        try {
            opened.contentEquals(probe)
        } finally {
            opened.fill(0)
        }
    } catch (_: InboxKeyException) {
        false
    }

    private fun unreadable(): Nothing =
        throw InboxKeyStoreException(InboxKeyStoreReason.UNREADABLE_HISTORY)

    private fun text(entry: Json.Obj, key: String): String =
        (entry[key] as? Json.Str)?.value ?: unreadable()

    /** Exactly integral, non-negative, and inside JSON's lossless range. */
    private fun whole(entry: Json.Obj, key: String): Long {
        val value = (entry[key] as? Json.Num)?.value ?: unreadable()
        if (!value.isFinite() || value != Math.floor(value) ||
            value < 0 || value > MAX_SAFE_INTEGER.toDouble()
        ) {
            unreadable()
        }
        return value.toLong()
    }

    companion object {
        /** Under the app's own files directory, beside the cloud store rather
         *  than inside it: the two have different lifetimes and different
         *  destroy semantics. */
        const val DIRECTORY = "inbox-keys"

        /** This feature's OWN keystore alias. Deliberately not the pending-upload
         *  one: two secrets under one key means an invalidation aimed at either
         *  silently takes both. */
        const val ALIAS = "com.relayium.android.inbox.keys.v1"

        /** The AAD prefix; the account is appended. */
        const val LABEL_PREFIX = "relayium/inbox/keys"

        private const val VERSION = 1

        /** A history is a handful of 32-byte keys. Anything near this is not one,
         *  and reading it into the heap is not something a corrupt or hostile
         *  file gets to ask for. */
        private const val MAX_HISTORY_BYTES = 256L * 1024

        /** A device rotates rarely; a file claiming thousands of records is not
         *  a history this build wrote. */
        private const val MAX_RECORDS = 256

        /** Bounds quarantine file accumulation. */
        private const val MAX_QUARANTINE = 64

        /** The largest integer a JSON double carries exactly. */
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
}
