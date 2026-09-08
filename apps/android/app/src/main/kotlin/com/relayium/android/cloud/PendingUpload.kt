package com.relayium.android.cloud

import com.relayium.protocol.Json
import com.relayium.protocol.ManifestCodec
import com.relayium.protocol.stored.MANIFEST_MAX_SAFE_INTEGER
import com.relayium.protocol.stored.STORE_KEY_BYTES
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** One file inside a staged job, as the manifest describes it. */
data class PendingUploadFile(val name: String, val size: Long)

/**
 * Everything needed to finish an upload in a process that has never seen the
 * user's files — and nothing else.
 *
 * The **bearer is never here**: it belongs to a session, not to a job, and is
 * read at the moment of use. The **content key is never here** either; it is
 * sealed separately under this job's own label, so the metadata on disk cannot
 * decrypt the ciphertext beside it.
 *
 * The plan itself is stored sealed, because [files] carries the user's
 * filenames and sizes.
 *
 * ## The fields the recovery rules turn on
 *
 * [payloadTotal], [spoolSha256] and [headerSha256] are this job's IDENTITY. The
 * spool is written once and never rewritten, so a resume replays exactly the
 * bytes the first attempt sent — the alternative, re-encrypting the user's
 * current files, would seal DIFFERENT plaintext under the same key and sequence
 * numbers, which destroys the integrity of every frame already uploaded.
 *
 * [finalizeAttempted] is written and synced BEFORE finalize is requested, and it
 * is what makes a lost response safe: a session that may have been finalized can
 * be retried, but it can never be replaced by a fresh one. [finalizedStoredId]
 * is written the moment the server answers, before anything is cleaned up, so a
 * crash during tidy-up cannot resurrect a job that has already published.
 */
data class PendingUploadPlan(
    val version: Int,
    val jobId: String,
    val accountId: String,
    val files: List<PendingUploadFile>,
    val burnAfterRead: Boolean,
    val ttlSeconds: Int,
    val createdAt: Long,
    /** The framed ciphertext this job must deliver: `cipherSize(sizes)`. The
     *  init header is NOT part of it — the server stores that separately, and
     *  every resumable offset counts payload bytes from zero. */
    val payloadTotal: Long,
    val headerSha256: String,
    val spoolSha256: String,
    val uploadId: String? = null,
    val uploadChunkSize: Int? = null,
    val finalizeAttempted: Boolean = false,
    val finalizedStoredId: String? = null,
    val finalizedExpiresAt: Long = 0,
    /**
     * Whether this object's key has been durably filed under the account's
     * stored-link keys.
     *
     * The last step of a successful upload, and the one that licenses cleanup.
     * A job removed before it is set would take the only copy of the key with
     * it: the object is on the server, the account is billed for it, and no
     * device could ever rebuild its link again. So a finalized job survives
     * until this is true, and recovery finishes the filing instead of offering
     * an upload.
     */
    val linkKeyCommitted: Boolean = false,
    val retired: Boolean = false,
) {
    val totalBytes: Long get() = files.sumOf { it.size }

    /** No names and no hashes: this value reaches failure text and test output,
     *  and the names are the user's. */
    override fun toString(): String =
        "PendingUploadPlan(job=$jobId, files=${files.size}, payload=$payloadTotal, " +
            "session=${uploadId != null}, finalizeAttempted=$finalizeAttempted, " +
            "finalized=${finalizedStoredId != null}, keyCommitted=$linkKeyCommitted, " +
            "retired=$retired)"
}

/** A pending job that could not be staged, resumed or described. */
class PendingUploadException(val reason: Reason, message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    enum class Reason {
        /** The selection is empty, too large, or carries a name or size this
         *  app will not stage. */
        UNUSABLE_SELECTION,

        /** Not enough room on this device to spool the ciphertext. */
        NO_SPACE,

        /** A read, a write or a rename failed. */
        STORAGE,

        /** A plan or a content key could not be sealed or unsealed. */
        PROTECTION,

        /** The staged ciphertext is missing, the wrong length, or no longer
         *  hashes to what the plan committed to. */
        SPOOL_INVALID,
    }
}

/**
 * The staged ciphertext and the plan that describes it.
 *
 * ## The order is the correctness
 *
 * Within one job directory:
 *
 *  1. `header.bin` and `spool.bin` are written, and hashed as they are written;
 *  2. `key.bin` — the sealed content key — is written and synced;
 *  3. `plan.bin` is written LAST.
 *
 * So a directory with no plan is a staging that died part-way and is swept, and
 * a directory WITH one is complete by construction: its bytes exist, its hashes
 * are recorded, and its content key is already on disk. Nothing here can produce
 * a resumable job whose key is missing.
 *
 * It lives under `noBackupFilesDir`, which is the platform's own statement that
 * a path is excluded from backup and from device-to-device transfer. That
 * matters twice over: these are copies of ciphertext the user is sending, and
 * the keystore key that opens the plan and the content key is not backed up
 * either — so a restored copy would be an inert blob that still looked like a
 * resumable upload.
 */
class PendingUploadStore(
    private val root: File,
    private val box: SecretBox,
    /** The durable-write barriers. Platform by default; substituted only to
     *  fail a chosen barrier in a test, never to skip one. */
    private val durable: DurableFiles = DurableFiles.Platform,
) {

    /**
     * One writer at a time.
     *
     * Staging, the launch sweep, session updates and deletion all touch the same
     * directories from different dispatchers. The dangerous pair is the sweep
     * and a live staging pass: a job's plan is written LAST, so a staging in
     * progress looks exactly like the half-copy the sweep exists to remove. The
     * lock serialises the metadata operations and [live] keeps the sweep off a
     * directory that is still being written — the spool copy itself is long and
     * deliberately runs outside the lock.
     */
    private val lock = ReentrantLock()

    /** Job ids currently being staged. Never swept. */
    private val live = HashSet<String>()

    /** What a sweep could not explain, so a caller can say so rather than
     *  quietly leaving bytes on the user's device forever. */
    data class SweepResult(val unreadable: Int)

    // ── staging ─────────────────────────────────────────────────────────────

    /**
     * A job being written. Bytes first, plan last; [commit] is what makes it a
     * job at all and [abandon] removes everything it created.
     *
     * NOT thread-safe and not meant to be: one staging pass belongs to one
     * upload, on one dispatcher.
     */
    inner class Staging internal constructor(val jobId: String) : Closeable {

        private val directory = File(root, jobId)
        private val headerDigest = MessageDigest.getInstance("SHA-256")
        private val spoolDigest = MessageDigest.getInstance("SHA-256")
        private var spool: FileOutputStream? = null
        private var headerHash: String? = null

        /** Framed ciphertext bytes written so far, for staging progress. */
        var staged: Long = 0L
            private set

        internal fun open() {
            // Durably linked in every parent before a byte lands in it: the
            // spool's own sync says nothing about the entry that names it.
            storage { durable.createDirectories(directory) }
            // Registered only once the directory exists, and only after that:
            // a name held in `live` for a directory that was never created would
            // be a sweep exclusion protecting nothing.
            lock.withLock { live.add(jobId) }
            spool = storage { FileOutputStream(File(directory, SPOOL)) }
        }

        /** `uint32BE(len) || encManifest`, written once. */
        fun writeHeader(header: ByteArray) {
            storage { durable.writeAtomically(File(directory, HEADER), header) }
            headerDigest.update(header)
            headerHash = hex(headerDigest.digest())
        }

        /** One framed chunk of ciphertext, appended in stream order. */
        fun appendPayload(frame: ByteArray) {
            val out = spool ?: throw PendingUploadException(
                PendingUploadException.Reason.STORAGE,
                "the spool is not open",
            )
            storage {
                out.write(frame)
            }
            spoolDigest.update(frame)
            staged += frame.size
        }

        /**
         * Make this a job: flush and sync the spool, seal the content key, then
         * write the plan.
         *
         * [key] is copied into the sealed record and is not retained here.
         */
        fun commit(
            accountId: String,
            files: List<PendingUploadFile>,
            burnAfterRead: Boolean,
            ttlSeconds: Int,
            createdAt: Long,
            key: ByteArray,
        ): PendingUploadPlan {
            require(key.size == STORE_KEY_BYTES) { "a content key is 32 bytes" }
            val header = headerHash ?: throw PendingUploadException(
                PendingUploadException.Reason.STORAGE,
                "no header was staged",
            )
            storage {
                spool?.let { out ->
                    durable.syncStream(out)
                    out.close()
                }
                spool = null
                durable.syncDirectory(directory)
            }
            val plan = PendingUploadPlan(
                version = PLAN_VERSION,
                jobId = jobId,
                accountId = accountId,
                files = files,
                burnAfterRead = burnAfterRead,
                ttlSeconds = ttlSeconds,
                createdAt = createdAt,
                payloadTotal = staged,
                headerSha256 = header,
                spoolSha256 = hex(spoolDigest.digest()),
            )
            if (!valid(plan, jobId)) {
                throw PendingUploadException(
                    PendingUploadException.Reason.UNUSABLE_SELECTION,
                    "the staged job does not describe a usable upload",
                )
            }
            // The key BEFORE the plan, so a plan on disk always has one. The
            // reverse order would produce exactly the state recovery cannot act
            // on: an offer to resume an upload nothing can decrypt.
            lock.withLock {
                storage { durable.writeAtomically(File(directory, KEY), box.seal(keyLabel(jobId), key)) }
                storage { durable.writeAtomically(File(directory, PLAN), sealPlan(plan)) }
                live.remove(jobId)
            }
            return plan
        }

        /** Remove everything this staging created. Used for a cancellation and
         *  for a failure; a half-written job is bytes with nothing to describe
         *  them and must not wait for a sweep. */
        fun abandon() {
            close()
            lock.withLock { deleteRecursively(directory) }
        }

        override fun close() {
            runCatching { spool?.close() }
            spool = null
            lock.withLock { live.remove(jobId) }
        }
    }

    /** Start staging a new job. Its directory is protected from the sweep for
     *  as long as the returned [Staging] is open. */
    fun begin(): Staging {
        storage { durable.createDirectories(root) }
        val staging = Staging(newJobId())
        return try {
            staging.open()
            staging
        } catch (e: Throwable) {
            // A staging that could not be opened owns a directory nothing else
            // will ever name — and, until `abandon`, a sweep exclusion for it.
            staging.abandon()
            throw e
        }
    }

    /**
     * Free bytes where the spool goes, for the admission check a staging pass
     * makes before it copies anything.
     *
     * `usableSpace` rather than `StorageManager.getAllocatableBytes`, and the
     * difference is deliberate. The allocatable figure includes cache the system
     * COULD clear, and acting on it means asking the platform to evict other
     * apps' cached data to make room for a copy of a file that is about to be
     * uploaded and then deleted. This check is not a reservation: it is an early
     * refusal, and under-reporting sends it in the safe direction — an upload
     * that would have just fitted is refused before any bytes are copied, rather
     * than failing part-way through with a half-written spool. A disk that fills
     * DURING staging is still handled, as [PendingUploadException.Reason.NO_SPACE].
     *
     * Keeping it here also keeps this store free of a `Context`, which is what
     * lets every rule above run under a plain JVM test.
     */
    @Suppress("UsableSpace")
    fun usableSpace(): Long = runCatching {
        if (!root.isDirectory) durable.createDirectories(root)
        root.usableSpace
    }.getOrDefault(0L)

    // ── reading ─────────────────────────────────────────────────────────────

    /**
     * The newest job this account still has work outstanding on.
     *
     * Ownership is checked HERE rather than by the caller. Only a RETIRED job is
     * excluded — it is the user's own tombstone. A finalized one is deliberately
     * still returned until its key has been filed (`linkKeyCommitted`), because
     * that filing is the outstanding work.
     *
     * A job whose spool is missing or the wrong length is returned too, and that
     * is the point: filtering it out would make an unusable upload invisible and
     * therefore undiscardable, leaving its bytes on the device with nothing able
     * to name them. The caller classifies it with [spoolLength] and offers a
     * discard. The spool's HASH is not read here — that is a pass over the whole
     * file and belongs to the moment a resume is asked for (see [verifySpool]),
     * not to every account state change.
     */
    fun pending(accountId: String): PendingUploadPlan? = lock.withLock {
        plans()
            .filter { it.accountId == accountId && !it.retired && !it.linkKeyCommitted }
            .maxByOrNull { it.createdAt }
    }

    /** The spool's size on disk, for telling a resumable job from one whose
     *  bytes are gone without reading the whole file. */
    fun spoolLength(plan: PendingUploadPlan): Long = spoolFile(plan).length()

    /** Every readable plan, newest first. Unreadable directories are skipped
     *  rather than guessed at. */
    private fun plans(): List<PendingUploadPlan> {
        val entries = root.listFiles()?.filter { it.isDirectory } ?: emptyList()
        return entries.mapNotNull { entry ->
            val sealed = File(entry, PLAN).takeIf { it.isFile } ?: return@mapNotNull null
            val plan = runCatching { openPlan(sealed, entry.name) }.getOrNull() ?: return@mapNotNull null
            plan.takeIf { valid(it, entry.name) }
        }.sortedByDescending { it.createdAt }
    }

    /**
     * This job's content key, or null when the record is simply not there.
     *
     * Null means ABSENT. A record that exists and cannot be unwrapped throws,
     * because the two are different facts: the first is an upload that can never
     * be finished and must be retired, the second is a device whose key store
     * this app cannot use right now and whose job must be left alone.
     */
    fun key(plan: PendingUploadPlan): ByteArray? {
        val file = File(File(root, plan.jobId), KEY)
        if (!file.isFile) return null
        val sealed = readBounded(file, MAX_KEY_RECORD_BYTES)
        val raw = try {
            box.open(keyLabel(plan.jobId), sealed)
        } catch (e: SecretBoxException) {
            throw PendingUploadException(
                PendingUploadException.Reason.PROTECTION,
                "the content key for this upload could not be read",
                e,
            )
        }
        if (raw.size != STORE_KEY_BYTES) {
            throw PendingUploadException(
                PendingUploadException.Reason.PROTECTION,
                "the stored content key is not a content key",
            )
        }
        return raw
    }

    /** The init header, verified against the hash the plan committed to. */
    fun header(plan: PendingUploadPlan): ByteArray {
        val bytes = readBounded(File(File(root, plan.jobId), HEADER), MAX_HEADER_BYTES)
        if (hex(MessageDigest.getInstance("SHA-256").digest(bytes)) != plan.headerSha256) {
            throw PendingUploadException(
                PendingUploadException.Reason.SPOOL_INVALID,
                "the staged manifest header is not the one this job recorded",
            )
        }
        return bytes
    }

    /**
     * Prove the spool is byte-for-byte what this job staged.
     *
     * Run before a resume sends anything, never as a repair: a mismatch means
     * these are not the bytes the server already holds a prefix of, and
     * re-staging under the same key would reuse nonces over different plaintext.
     * The only safe answers are to refuse and to offer a discard.
     */
    fun verifySpool(plan: PendingUploadPlan) {
        val file = spoolFile(plan)
        if (!file.isFile || file.length() != plan.payloadTotal) {
            throw PendingUploadException(
                PendingUploadException.Reason.SPOOL_INVALID,
                "the staged ciphertext is missing or the wrong length",
            )
        }
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(VERIFY_BUFFER_BYTES)
        storage {
            file.inputStream().use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
            }
        }
        if (hex(digest.digest()) != plan.spoolSha256) {
            throw PendingUploadException(
                PendingUploadException.Reason.SPOOL_INVALID,
                "the staged ciphertext is not the ciphertext this job recorded",
            )
        }
    }

    /** Random access over the spool, for replaying an exact byte range. */
    fun openPayload(plan: PendingUploadPlan): PayloadReader =
        storage { PayloadReader(RandomAccessFile(spoolFile(plan), "r"), plan.payloadTotal) }

    class PayloadReader internal constructor(
        private val file: RandomAccessFile,
        private val total: Long,
    ) : Closeable {
        /** Fill [into] with [length] bytes starting at [offset]. Refuses a range
         *  outside the spool rather than returning a short read: every caller is
         *  composing a `Content-Range` from it. */
        fun read(offset: Long, into: ByteArray, length: Int) {
            require(length >= 0 && length <= into.size) { "length outside the buffer" }
            if (offset < 0 || length.toLong() > total - offset) {
                throw PendingUploadException(
                    PendingUploadException.Reason.SPOOL_INVALID,
                    "a replay was asked for bytes this job never staged",
                )
            }
            file.seek(offset)
            file.readFully(into, 0, length)
        }

        override fun close() {
            runCatching { file.close() }
        }
    }

    // ── mutation ────────────────────────────────────────────────────────────

    /** Record the server session these bytes are being fed to, before the first
     *  PATCH. A session recorded afterwards is a session a crash can orphan. */
    fun setSession(plan: PendingUploadPlan, uploadId: String, chunkSize: Int): PendingUploadPlan {
        val id = StoredObjectId.accepted(uploadId) ?: throw PendingUploadException(
            PendingUploadException.Reason.UNUSABLE_SELECTION,
            "the server issued an upload id this app will not use in a path",
        )
        require(validChunkSize(chunkSize)) { "chunk size outside the accepted range" }
        return update(plan) { it.copy(uploadId = id, uploadChunkSize = chunkSize) }
    }

    /**
     * Record that finalize is ABOUT to be requested.
     *
     * The whole no-duplicate-publication rule rests on this write landing first.
     * Once it is on disk, a lost response, a crash or a reaped session can be
     * answered by retrying finalize on the SAME session — and can never be
     * answered by opening a new one, because the object may already exist.
     */
    fun markFinalizeAttempted(plan: PendingUploadPlan): PendingUploadPlan =
        update(plan) { it.copy(finalizeAttempted = true) }

    /** Record the object the server created, BEFORE any cleanup runs. */
    fun markFinalized(plan: PendingUploadPlan, storedId: String, expiresAt: Long): PendingUploadPlan {
        val id = StoredObjectId.accepted(storedId) ?: throw PendingUploadException(
            PendingUploadException.Reason.UNUSABLE_SELECTION,
            "the server named the finished object with an id this app will not use",
        )
        return update(plan) { it.copy(finalizedStoredId = id, finalizedExpiresAt = expiresAt) }
    }

    /**
     * Record that the object's key is durably filed under the account.
     *
     * The one marker that licenses removing this job. Everything before it is
     * recoverable; after it, the job directory holds nothing that is not also
     * held elsewhere.
     */
    fun markLinkKeyCommitted(plan: PendingUploadPlan): PendingUploadPlan =
        update(plan) { it.copy(linkKeyCommitted = true) }

    /** Persist the user's destructive choice before removing anything, so an
     *  interrupted discard finishes as a discard on the next launch rather than
     *  coming back as an offer to resume. */
    fun markRetired(plan: PendingUploadPlan): PendingUploadPlan =
        update(plan) { it.copy(retired = true) }

    private fun update(
        plan: PendingUploadPlan,
        change: (PendingUploadPlan) -> PendingUploadPlan,
    ): PendingUploadPlan = lock.withLock {
        val directory = File(root, plan.jobId)
        val sealed = File(directory, PLAN)
        // A job that is no longer on disk is NOT rewritten from the caller's
        // copy. Writing one back would resurrect a directory a discard had
        // already removed — the exact way a coroutine still unwinding after its
        // job was cancelled can undo the user's deletion.
        if (!sealed.isFile) {
            throw PendingUploadException(
                PendingUploadException.Reason.STORAGE,
                "this upload is no longer on this device",
            )
        }
        // Re-read rather than trusting the caller's copy: another turn may have
        // recorded a session or an attempt marker in between, and writing a
        // stale snapshot back would erase it.
        val current = openPlan(sealed, plan.jobId)
        val updated = change(current)
        if (!valid(updated, plan.jobId)) {
            throw PendingUploadException(
                PendingUploadException.Reason.UNUSABLE_SELECTION,
                "the change would leave a plan this build could not act on",
            )
        }
        storage { durable.writeAtomically(sealed, sealPlan(updated)) }
        updated
    }

    // ── removal ─────────────────────────────────────────────────────────────

    /** Remove one job's directory, and say whether nothing is left. Only ever a
     *  path this store created. */
    fun purge(plan: PendingUploadPlan): Boolean = purge(plan.jobId)

    fun purge(jobId: String): Boolean = lock.withLock {
        val checked = StoredObjectId.accepted(jobId) ?: return false
        val directory = File(root, checked)
        if (!directory.exists()) return true
        deleteRecursively(directory)
        val gone = !directory.exists()
        if (gone) runCatching { durable.syncDirectory(root) }
        gone
    }

    /**
     * Remove what nothing can act on any more: directories with no plan (a
     * staging that died part-way), plans this build cannot act on, retired jobs,
     * and finished jobs whose key is already filed.
     *
     * Two exclusions carry weight.
     *
     * A FINALIZED job whose `linkKeyCommitted` is not set is kept. Its object is
     * on the server and its key exists only here; sweeping it would leave the
     * account paying for ciphertext no device can ever open.
     *
     * A plan that exists and cannot be UNWRAPPED is left alone and counted. It
     * is the user's staged bytes, and deleting them because this app's own key
     * store answered badly is not a decision a background sweep gets to make —
     * see [purgeUnreadableDeviceData].
     *
     * Directories being staged right now are skipped: their plan is written last
     * and they are otherwise indistinguishable from a half-copy.
     */
    fun sweep(): SweepResult = lock.withLock {
        val entries = root.listFiles()?.filter { it.isDirectory } ?: return SweepResult(0)
        var unreadable = 0
        for (entry in entries) {
            if (entry.name in live) continue
            val sealed = File(entry, PLAN)
            if (!sealed.isFile) {
                deleteRecursively(entry)
                continue
            }
            val plan = try {
                openPlan(sealed, entry.name)
            } catch (_: PendingUploadException) {
                unreadable += 1
                continue
            }
            val finished = plan.retired || plan.linkKeyCommitted
            if (finished || !valid(plan, entry.name)) deleteRecursively(entry)
        }
        runCatching { durable.syncDirectory(root) }
        SweepResult(unreadable)
    }

    /**
     * Remove interrupted-upload data this device can no longer read.
     *
     * Deliberately NOT account-scoped, and named for it: an unreadable plan has
     * no readable account, so nothing can say whose it is. It is therefore
     * offered as an explicit destructive action about THIS DEVICE's leftover
     * data — never folded into signing out, switching account, or discarding one
     * account's pending upload, each of which would silently delete another
     * account's bytes.
     *
     * Only records this store wrote, and only ones that cannot be opened: a job
     * that unwraps normally is never touched here.
     */
    fun purgeUnreadableDeviceData(): Boolean = lock.withLock {
        val entries = root.listFiles()?.filter { it.isDirectory } ?: return true
        var complete = true
        for (entry in entries) {
            if (entry.name in live) continue
            val sealed = File(entry, PLAN)
            if (!sealed.isFile) continue
            runCatching { openPlan(sealed, entry.name) }.onFailure {
                deleteRecursively(entry)
                if (entry.exists()) complete = false
            }
        }
        runCatching { durable.syncDirectory(root) }
        complete
    }

    // ── plan codec ──────────────────────────────────────────────────────────

    private fun sealPlan(plan: PendingUploadPlan): ByteArray = try {
        box.seal(planLabel(plan.jobId), encode(plan).toByteArray(Charsets.UTF_8))
    } catch (e: SecretBoxException) {
        throw PendingUploadException(
            PendingUploadException.Reason.PROTECTION,
            "this upload's details could not be protected on this device",
            e,
        )
    }

    private fun openPlan(file: File, jobId: String): PendingUploadPlan {
        val sealed = readBounded(file, MAX_PLAN_RECORD_BYTES)
        val raw = try {
            box.open(planLabel(jobId), sealed)
        } catch (e: SecretBoxException) {
            throw PendingUploadException(
                PendingUploadException.Reason.PROTECTION,
                "this upload's details could not be read on this device",
                e,
            )
        }
        return decode(String(raw, Charsets.UTF_8)) ?: throw PendingUploadException(
            PendingUploadException.Reason.UNUSABLE_SELECTION,
            "this upload's details are not in a shape this build can act on",
        )
    }

    private fun encode(plan: PendingUploadPlan): String {
        val entries = LinkedHashMap<String, Json>()
        entries["version"] = Json.of(plan.version)
        entries["jobId"] = Json.of(plan.jobId)
        entries["accountId"] = Json.of(plan.accountId)
        entries["files"] = Json.arr(
            plan.files.map { Json.obj("name" to Json.of(it.name), "size" to Json.of(it.size)) },
        )
        entries["burnAfterRead"] = Json.of(plan.burnAfterRead)
        entries["ttlSeconds"] = Json.of(plan.ttlSeconds)
        entries["createdAt"] = Json.of(plan.createdAt)
        entries["payloadTotal"] = Json.of(plan.payloadTotal)
        entries["headerSha256"] = Json.of(plan.headerSha256)
        entries["spoolSha256"] = Json.of(plan.spoolSha256)
        plan.uploadId?.let { entries["uploadId"] = Json.of(it) }
        plan.uploadChunkSize?.let { entries["uploadChunkSize"] = Json.of(it) }
        entries["finalizeAttempted"] = Json.of(plan.finalizeAttempted)
        plan.finalizedStoredId?.let { entries["finalizedStoredId"] = Json.of(it) }
        entries["finalizedExpiresAt"] = Json.of(plan.finalizedExpiresAt)
        entries["linkKeyCommitted"] = Json.of(plan.linkKeyCommitted)
        entries["retired"] = Json.of(plan.retired)
        return Json.stringify(Json.Obj(entries))
    }

    /**
     * Strict, field by field. A plan is executable state — it decides which
     * bytes are replayed at which offset and whether an object may be published
     * a second time — so an absent or wrong-typed field is a refusal, never a
     * default.
     */
    private fun decode(text: String): PendingUploadPlan? {
        val obj = Json.parseOrNull(text) as? Json.Obj ?: return null
        val version = obj.int("version") ?: return null
        // A plan written by a FUTURE build is refused rather than guessed at: a
        // mis-read plan resumes from the wrong offset, and the failure mode of
        // that is a blob nobody can open.
        if (version != PLAN_VERSION) return null
        val files = (obj["files"] as? Json.Arr)?.items ?: return null
        val decoded = ArrayList<PendingUploadFile>(files.size)
        for (item in files) {
            val entry = item as? Json.Obj ?: return null
            val name = (entry["name"] as? Json.Str)?.value ?: return null
            val size = entry.whole("size") ?: return null
            decoded.add(PendingUploadFile(name, size))
        }
        return PendingUploadPlan(
            version = version,
            jobId = (obj["jobId"] as? Json.Str)?.value ?: return null,
            accountId = (obj["accountId"] as? Json.Str)?.value ?: return null,
            files = decoded,
            burnAfterRead = (obj["burnAfterRead"] as? Json.Bool)?.value ?: return null,
            ttlSeconds = obj.int("ttlSeconds") ?: return null,
            createdAt = obj.whole("createdAt") ?: return null,
            payloadTotal = obj.whole("payloadTotal") ?: return null,
            headerSha256 = (obj["headerSha256"] as? Json.Str)?.value ?: return null,
            spoolSha256 = (obj["spoolSha256"] as? Json.Str)?.value ?: return null,
            uploadId = obj["uploadId"]?.let { (it as? Json.Str)?.value ?: return null },
            uploadChunkSize = obj["uploadChunkSize"]?.let { obj.int("uploadChunkSize") ?: return null },
            finalizeAttempted = (obj["finalizeAttempted"] as? Json.Bool)?.value ?: return null,
            finalizedStoredId = obj["finalizedStoredId"]?.let { (it as? Json.Str)?.value ?: return null },
            finalizedExpiresAt = obj.whole("finalizedExpiresAt") ?: return null,
            linkKeyCommitted = (obj["linkKeyCommitted"] as? Json.Bool)?.value ?: return null,
            retired = (obj["retired"] as? Json.Bool)?.value ?: return null,
        )
    }

    /**
     * Every value that can influence a path, an allocation or a byte offset,
     * checked before a decoded plan becomes executable state.
     */
    private fun valid(plan: PendingUploadPlan, directoryName: String): Boolean {
        if (plan.version != PLAN_VERSION) return false
        if (plan.jobId != directoryName) return false
        if (StoredObjectId.accepted(plan.jobId) != plan.jobId) return false
        if (StoredObjectId.accepted(plan.accountId) != plan.accountId) return false
        if (plan.files.isEmpty() || plan.files.size > ManifestCodec.MAX_FILES) return false
        if (plan.ttlSeconds <= 0) return false
        if (plan.createdAt < 0) return false
        if (plan.payloadTotal < 0 || plan.payloadTotal > MANIFEST_MAX_SAFE_INTEGER) return false
        if (!isSha256(plan.headerSha256) || !isSha256(plan.spoolSha256)) return false
        var total = 0L
        for (file in plan.files) {
            if (file.name.isEmpty()) return false
            if (file.name.toByteArray(Charsets.UTF_8).size > ManifestCodec.MAX_NAME_BYTES) return false
            if (file.size < 0 || file.size > MANIFEST_MAX_SAFE_INTEGER) return false
            total += file.size
            if (total > MANIFEST_MAX_SAFE_INTEGER) return false
        }
        // A session id and its chunk size arrive together or not at all: a
        // recorded session with no chunk size would make a later process guess
        // PATCH boundaries the server issued, and the current default is not
        // necessarily the one this session was opened with.
        val id = plan.uploadId
        val chunk = plan.uploadChunkSize
        if ((id == null) != (chunk == null)) return false
        if (id != null && StoredObjectId.accepted(id) != id) return false
        if (chunk != null && !validChunkSize(chunk)) return false
        val finalized = plan.finalizedStoredId
        if (finalized != null && StoredObjectId.accepted(finalized) != finalized) return false
        // An object cannot exist without an attempt having been made. A plan
        // claiming otherwise is not one this build wrote.
        if (finalized != null && !plan.finalizeAttempted) return false
        // A key cannot be filed for an object that does not exist, and this is
        // the marker that licenses deleting the job — so a plan claiming it
        // without a finalized id is refused rather than acted on.
        if (plan.linkKeyCommitted && finalized == null) return false
        if (plan.finalizedExpiresAt < 0) return false
        return true
    }

    // ── plumbing ────────────────────────────────────────────────────────────

    private fun spoolFile(plan: PendingUploadPlan) = File(File(root, plan.jobId), SPOOL)

    private fun readBounded(file: File, limit: Long): ByteArray {
        if (!file.isFile) {
            throw PendingUploadException(
                PendingUploadException.Reason.STORAGE,
                "a record this upload needs is not on this device",
            )
        }
        // Sized from the CEILING rather than from the file, which is the length
        // something else may have written into this app's data directory.
        if (file.length() > limit) {
            throw PendingUploadException(
                PendingUploadException.Reason.STORAGE,
                "a record is larger than this build will read",
            )
        }
        return storage { file.readBytes() }
    }

    private fun deleteRecursively(target: File) {
        // Depth-first over ORDINARY entries only. Nothing here descends through
        // a link, so a symlink planted in the app's data directory has the LINK
        // removed and never what it points at.
        val children = if (isRealDirectory(target)) target.listFiles() else null
        if (children != null) for (child in children) deleteRecursively(child)
        target.delete()
    }

    /**
     * Whether this entry is a directory in its own right.
     *
     * The question is about THIS entry, not about its path: comparing a
     * canonical path with an absolute one answers "is any ancestor a link",
     * which is true on an ordinary Android device — `/data/user/0` is a link to
     * `/data/data` — and would stop the app from ever clearing its own job
     * directories. `Files.isSymbolicLink` reads the entry itself.
     *
     * Fails CLOSED: if the question cannot be answered, the entry is not
     * descended into and only the entry itself is removed.
     */
    private fun isRealDirectory(file: File): Boolean =
        file.isDirectory &&
            !runCatching { java.nio.file.Files.isSymbolicLink(file.toPath()) }.getOrDefault(true)

    /** Turn a filesystem failure into this feature's own classified one, with
     *  a full disk told apart from everything else because the user's next
     *  action differs. */
    private inline fun <T> storage(body: () -> T): T = try {
        body()
    } catch (e: IOException) {
        val full = e.message?.contains("No space left", ignoreCase = true) == true ||
            usableSpace() < LOW_SPACE_BYTES
        throw PendingUploadException(
            if (full) PendingUploadException.Reason.NO_SPACE else PendingUploadException.Reason.STORAGE,
            "the staged upload could not be written to this device",
            e,
        )
    }

    private fun newJobId(): String {
        val raw = ByteArray(16)
        SecureRandom().nextBytes(raw)
        return hex(raw)
    }

    companion object {
        /** Bumped only if the plan's meaning changes. An unknown version is
         *  refused, never guessed at. */
        const val PLAN_VERSION = 1

        internal const val PLAN = "plan.bin"
        internal const val KEY = "key.bin"
        internal const val HEADER = "header.bin"
        internal const val SPOOL = "spool.bin"

        /** The server issues 8 MiB today. This ceiling is a REFUSAL bound, not
         *  an allocation target: an init response naming a larger chunk would
         *  otherwise turn one JSON number into a multi-gigabyte buffer. */
        const val MAX_CHUNK_SIZE = 64 * 1024 * 1024

        /** What the protocol uses when a server reports 0. */
        const val DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

        private const val VERIFY_BUFFER_BYTES = 1024 * 1024
        private const val LOW_SPACE_BYTES = 8L * 1024 * 1024

        /** A sealed plan holds at most [ManifestCodec.MAX_FILES] names of at
         *  most [ManifestCodec.MAX_NAME_BYTES]; this sits well above that and
         *  well below anything that would matter to read. */
        private const val MAX_PLAN_RECORD_BYTES = 8L * 1024 * 1024
        private const val MAX_KEY_RECORD_BYTES = 4L * 1024

        /** A length prefix plus an encrypted manifest, which is bounded by the
         *  same name and count limits as the plan. */
        private const val MAX_HEADER_BYTES = 8L * 1024 * 1024

        fun validChunkSize(size: Int): Boolean = size > 0 && size <= MAX_CHUNK_SIZE

        internal fun planLabel(jobId: String) = "relayium/pending-upload/plan/$jobId"
        internal fun keyLabel(jobId: String) = "relayium/pending-upload/key/$jobId"

        private val HEX = "0123456789abcdef".toCharArray()

        internal fun hex(bytes: ByteArray): String {
            val out = CharArray(bytes.size * 2)
            for (i in bytes.indices) {
                val v = bytes[i].toInt() and 0xff
                out[i * 2] = HEX[v ushr 4]
                out[i * 2 + 1] = HEX[v and 0x0f]
            }
            return String(out)
        }

        private fun isSha256(value: String): Boolean =
            value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }
    }
}

/**
 * A whole, non-negative number that FITS IN AN INT, or null.
 *
 * The range check happens before the narrowing, which is the whole point:
 * `4294967297L.toInt()` is `1`, so a version, a TTL or a chunk size read as a
 * Long and then truncated could alias a value this build accepts. Refusing is
 * the only answer — these fields decide which codec runs and how large a buffer
 * is reserved.
 */
private fun Json.Obj.int(key: String): Int? {
    val value = whole(key) ?: return null
    if (value > Int.MAX_VALUE.toLong()) return null
    return value.toInt()
}

/** A whole, non-negative number, or null. Strict for the reason the transport's
 *  own copy is: JSON numbers are doubles, and `toLong()` would turn `1.9` into a
 *  byte offset. */
private fun Json.Obj.whole(key: String): Long? {
    val value = (this[key] as? Json.Num)?.value ?: return null
    if (value.isNaN() || value != Math.floor(value)) return null
    if (value < 0 || value > MANIFEST_MAX_SAFE_INTEGER.toDouble()) return null
    return value.toLong()
}
