package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.android.cloud.SecretBoxException
import com.relayium.protocol.Json
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxProtocol
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * One outgoing delivery, durable before anything about it becomes visible to
 * central.
 *
 * ## Why the request identity is written down first
 *
 * Central converges a repeated create on `(account, idempotencyKey)` — but only
 * when the repeat is the SAME request. A sealed box is randomized, so re-sealing
 * the same content key to the same device produces different bytes, and central
 * answers that with `idempotency_key_conflict` rather than converging. It is not
 * a retry at all; it is a second, contradictory description of one delivery.
 *
 * So the whole request identity — the idempotency key, the stored object, the
 * target key and generation, and the EXACT wrapped box — is durable before the
 * first create leaves this process. A retry in another process then reproduces
 * the request byte for byte instead of inventing an equivalent one.
 *
 * ## Definitive versus ambiguous
 *
 * The one line everything here is organised around:
 *
 *  * a DEFINITIVE non-success means central's transaction rolled back and no
 *    task can own this ciphertext. A `device_task` object is invisible — no
 *    link, no file-list row, no control — so leaving it behind is storage the
 *    account pays for and cannot see. It may be released;
 *  * an AMBIGUOUS outcome — the request never arrived, or its answer was lost —
 *    means a delivery MAY be live. Nothing is released, because the mistake in
 *    that direction destroys a real transfer of the user's file. The spool, the
 *    content key, the object and above all the idempotency key are kept, and the
 *    next attempt converges on the same task instead of queueing a second one.
 */
data class InboxSendJob(
    val jobId: String,
    val targetDeviceId: String,
    /** Minted once, and never again for this job. */
    val idempotencyKey: String,
    val kind: InboxManifestKind,
    /** Relative name to declared size, in manifest order. Empty for a message. */
    val files: List<Pair<String, Long>>,
    val totalBytes: Long,
    /**
     * The prepared ciphertext's own identity: its exact length and SHA-256.
     *
     * Bound when the spool is written, and checked before any of it is
     * uploaded. Length alone is not enough — a spool truncated to a frame
     * boundary is still a well-formed prefix, and uploading it would publish a
     * smaller object that finalizes cleanly and that the recipient can never
     * reconcile with the manifest. Zero and empty mean "not prepared yet".
     */
    val ciphertextBytes: Long = 0,
    val ciphertextSha256: String = "",
    /** The resumable upload session, once one exists. */
    val uploadId: String? = null,
    /**
     * Set once finalize has been ATTEMPTED, whatever it answered.
     *
     * A finalize whose answer was lost may have published the object, so a job
     * carrying this must never open a new session or re-upload: it would create
     * a second object the account pays for and cannot see.
     */
    val finalizeAttempted: Boolean = false,
    /**
     * A single-shot publish for an EMPTY payload has been attempted.
     *
     * Its own flag, and deliberately not [finalizeAttempted] or a null
     * [storedFileId]: those describe the resumable route, where a lost answer
     * can be resolved by re-asking the session for its offset. The single-shot
     * route has no session and no offset — one POST either created an object or
     * did not, and a lost answer cannot tell which.
     *
     * So this is written BEFORE the request leaves. If the answer never
     * arrives, the job stays uncertain forever rather than being retried: a
     * second POST cannot be told apart from the first by anything the server
     * has, and would publish a hidden duplicate object nothing on this device
     * can name, still billed and still occupying storage until its TTL.
     */
    val emptyPublishAttempted: Boolean = false,
    /** The object central created, once its identity is known. */
    val storedFileId: String? = null,
    val targetKeyId: String? = null,
    val targetKeyGeneration: Long = 0,
    /** The EXACT sealed box the create must carry, byte for byte, on every
     *  attempt. */
    val wrappedKey: String? = null,
    /**
     * A create attempt ended without a definite answer.
     *
     * Set BEFORE a create is sent and cleared only by an answer that proves
     * nothing was created. While it is set, a task under this idempotency key
     * MAY exist — and that forbids re-sealing: a create carrying a different box
     * under the same key is answered `idempotency_key_conflict`, and that
     * conflict would be with THIS job's own earlier task. Releasing its object
     * would then destroy a live delivery.
     */
    val unresolvedCreate: Boolean = false,
    /**
     * A reseal has already been spent.
     *
     * Exactly one is allowed, and only after a DEFINITIVE `stale_target_key`
     * refusal — which proves the create rolled back, so the retry is a first
     * binding rather than a rebinding. A second one means the target is rotating
     * faster than this send can follow, and continuing would be a loop.
     */
    val targetKeyResealed: Boolean = false,
    /** The task central created, once its identity is known. */
    val taskId: String? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
) {
    /**
     * The spool has been written and its identity recorded.
     *
     * The IDENTITY is what says a preparation happened, not the byte count. A
     * delivery whose only file is empty produces a spool of zero bytes — the
     * frame encoder emits nothing for an exhausted source, correctly — and its
     * SHA-256 is still a real, fixed 64-hex value. Requiring `> 0` here made
     * that job permanently unpreparable: it staged, failed its own record
     * validation, and the send surfaced no job and no history at all.
     *
     * An unprepared job has no hash, so the two are still distinguishable.
     */
    val isPrepared: Boolean get() = ciphertextSha256.isNotEmpty()

    /** Everything a create needs is durable. */
    val isCreatable: Boolean
        get() = storedFileId != null && wrappedKey != null &&
            targetKeyId != null && targetKeyGeneration > 0

    /** No names, no key material: this reaches failure text. */
    override fun toString(): String =
        "InboxSendJob(job=$jobId, target=$targetDeviceId, files=${files.size})"
}

enum class InboxSendStoreReason { INVALID_JOB_ID, UNREADABLE, STORAGE }

class InboxSendStoreException(val reason: InboxSendStoreReason, cause: Throwable? = null) :
    RuntimeException("relayium inbox send store: $reason", cause)

/**
 * One account's outgoing jobs, sealed at rest beside their ciphertext spools.
 *
 * The spool holds the framed ciphertext this job will upload. It is retained
 * across an ambiguous outcome for the same reason the idempotency key is: the
 * bytes may be the last copy Relayium holds of what the user asked to send, and
 * discarding them on a guess is the one mistake with no recovery.
 */
class InboxSendStore(
    val directory: File,
    private val account: InboxAccountId,
    private val secrets: SecretBox,
    private val files: DurableFiles = DurableFiles.Platform,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    private val lock = Mutex()

    /**
     * Which store this is, for the operation lock above it.
     *
     * Account AND directory, so two coordinators built over the same durable
     * state serialize against each other — and two accounts, or two test
     * temporary directories, do not.
     */
    val identity: String get() = "${account.value}@${directory.absolutePath}"

    suspend fun load(jobId: String): InboxSendJob? = lock.withLock { read(jobId) }

    /** Every readable job, oldest first. An unreadable one is skipped rather
     *  than failing the list: one bad record must not hide the rest. */
    suspend fun all(): List<InboxSendJob> = lock.withLock {
        withContext(io) { directory.list().orEmpty() }
            .filter { it.endsWith(SUFFIX) }
            .mapNotNull { name ->
                try {
                    read(name.removeSuffix(SUFFIX))
                } catch (_: InboxSendStoreException) {
                    null
                }
            }
            .sortedBy { it.createdAt }
    }

    /** Make a job durable. Returns only once it is on the storage device. */
    suspend fun save(job: InboxSendJob, nowSeconds: Long): InboxSendJob =
        lock.withLock { write(job.copy(updatedAt = nowSeconds)) }

    /** Where this job's framed ciphertext lives. */
    fun spool(jobId: String): File =
        File(directory, InboxId.checked(jobId, "jobId") + SPOOL_SUFFIX)

    /**
     * Write this job's framed ciphertext and bind its identity.
     *
     * Takes the per-job operation lock, so it must be called BEFORE a delivery
     * begins and never from inside one — preparation is the immutable handoff a
     * send starts from, not a step within it.
     *
     * The digest is computed AS the bytes are written, so preparation costs one
     * pass and the uploader has something to check against that was never
     * derived from the file it is checking. Returns the job with its identity
     * recorded — durably, before anything can be uploaded.
     */
    suspend fun prepareSpool(
        job: InboxSendJob,
        nowSeconds: Long,
        write: suspend (java.io.OutputStream) -> Unit,
    ): InboxSendJob = InboxSendOperations.withJob(this, job.jobId) {
        // Under the SAME per-job lock every send operation takes, because this
        // truncates the spool. Without it a duplicate or stale prepare could
        // rewrite the bytes an upload is midway through — between its digest
        // check and its final append — and publish an object that matches
        // neither identity.
        val existing = load(job.jobId)
        // The prepared identity is IMMUTABLE once it exists. A job that has been
        // prepared, has a session, or has published an object is a handoff that
        // later steps have already acted on; re-writing its payload underneath
        // them is not a fresh send. A fresh send is a new job id.
        if (existing != null &&
            (existing.isPrepared || existing.uploadId != null || existing.storedFileId != null)
        ) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE)
        }
        writeSpool(job, nowSeconds, write)
    }

    private suspend fun writeSpool(
        job: InboxSendJob,
        nowSeconds: Long,
        write: suspend (java.io.OutputStream) -> Unit,
    ): InboxSendJob {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        var written = 0L
        withContext(io) {
            try {
                files.createDirectories(directory)
                java.io.FileOutputStream(spool(job.jobId)).use { out ->
                    val counting = object : java.io.OutputStream() {
                        override fun write(b: Int) {
                            out.write(b)
                            digest.update(b.toByte())
                            written += 1
                        }

                        override fun write(b: ByteArray, off: Int, len: Int) {
                            out.write(b, off, len)
                            digest.update(b, off, len)
                            written += len
                        }
                    }
                    write(counting)
                    out.flush()
                    // Durable before the identity that describes it is recorded,
                    // so a record can never name bytes that are not there.
                    files.syncStream(out)
                }
                files.syncDirectory(directory)
            } catch (e: IOException) {
                throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
            }
        }
        return save(
            job.copy(
                ciphertextBytes = written,
                ciphertextSha256 = digest.digest().joinToString("") { "%02x".format(it) },
            ),
            nowSeconds,
        )
    }

    /**
     * Whether the spool on disk is still exactly what was prepared.
     *
     * Length AND content. A spool truncated at a frame boundary is a valid
     * prefix, so a length check alone would let a smaller object be published
     * that finalizes cleanly and that the recipient can never reconcile with the
     * manifest it was promised.
     */
    suspend fun spoolMatches(job: InboxSendJob): Boolean = withContext(io) {
        if (!job.isPrepared) return@withContext false
        val spool = spool(job.jobId)
        if (!spool.isFile || spool.length() != job.ciphertextBytes) return@withContext false
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        try {
            spool.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
        } catch (e: IOException) {
            return@withContext false
        }
        digest.digest().joinToString("") { "%02x".format(it) } == job.ciphertextSha256
    }

    /**
     * The content key this job's ciphertext was encrypted under.
     *
     * A file of its OWN, beside the record and the spool rather than inside
     * either. The record is read on every status refresh and the spool is the
     * bulk payload; the key is neither, and giving it a separate sealed file
     * with its own label means a corrupt or truncated record does not take the
     * key with it, and reading a job's state does not bring the key into memory.
     *
     * It must survive a restart: without it the staged ciphertext cannot be
     * described to the recipient at all, and the delivery is lost even though
     * the bytes are still there.
     */
    suspend fun saveContentKey(jobId: String, key: ByteArray) =
        lock.withLock { writeSide(jobId, KEY_SUFFIX, KEY_LABEL, key) }

    suspend fun contentKey(jobId: String): ByteArray? =
        lock.withLock { readSide(jobId, KEY_SUFFIX, KEY_LABEL) }

    /** The sealed manifest this job will publish as its object's header. */
    suspend fun saveEncManifest(jobId: String, manifest: ByteArray) =
        lock.withLock { writeSide(jobId, MANIFEST_SUFFIX, MANIFEST_LABEL, manifest) }

    suspend fun encManifest(jobId: String): ByteArray? =
        lock.withLock { readSide(jobId, MANIFEST_SUFFIX, MANIFEST_LABEL) }

    private fun sideFile(jobId: String, suffix: String) =
        File(directory, InboxId.checked(jobId, "jobId") + suffix)

    private suspend fun writeSide(
        jobId: String,
        suffix: String,
        labelPrefix: String,
        bytes: ByteArray,
    ) = withContext(io) {
        val sealed = try {
            secrets.seal("$labelPrefix/${account.value}/$jobId", bytes)
        } catch (e: SecretBoxException) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(sideFile(jobId, suffix), sealed)
        } catch (e: IOException) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
        }
    }

    private suspend fun readSide(
        jobId: String,
        suffix: String,
        labelPrefix: String,
    ): ByteArray? = withContext(io) {
        val file = sideFile(jobId, suffix)
        if (!file.exists()) return@withContext null
        val sealed = try {
            if (file.length() > MAX_RECORD_BYTES) {
                throw InboxSendStoreException(InboxSendStoreReason.UNREADABLE)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
        }
        try {
            secrets.open("$labelPrefix/${account.value}/$jobId", sealed)
        } catch (e: SecretBoxException) {
            throw InboxSendStoreException(InboxSendStoreReason.UNREADABLE, e)
        }
    }

    /**
     * Remove a job and its spool.
     *
     * Called ONLY after a definitive outcome — a delivery that provably exists,
     * or one that provably does not. An ambiguous job is never passed here.
     */
    suspend fun release(jobId: String) = lock.withLock {
        withContext(io) {
            // Every piece of this job, including the side records: leaving the
            // content key behind would keep a secret for a delivery that no
            // longer exists.
            for (part in listOf(
                file(jobId), spool(jobId),
                sideFile(jobId, KEY_SUFFIX), sideFile(jobId, MANIFEST_SUFFIX),
            )) {
                if (part.exists() && !part.delete()) {
                    throw InboxSendStoreException(InboxSendStoreReason.STORAGE)
                }
            }
            if (directory.isDirectory) {
                try {
                    files.syncDirectory(directory)
                } catch (e: IOException) {
                    throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
                }
            }
            Unit
        }
    }

    // ── storage ─────────────────────────────────────────────────────────────

    private fun file(jobId: String): File = try {
        File(directory, InboxId.checked(jobId, "jobId") + SUFFIX)
    } catch (e: InboxWireException) {
        throw InboxSendStoreException(InboxSendStoreReason.INVALID_JOB_ID, e)
    }

    /** Binds the account AND the job, so a record moved between either fails to
     *  open rather than describing the wrong delivery. */
    private fun label(jobId: String) = "$LABEL_PREFIX/${account.value}/$jobId"

    private suspend fun read(jobId: String): InboxSendJob? = withContext(io) {
        val file = file(jobId)
        if (!file.exists()) return@withContext null
        val sealed = try {
            if (file.length() > MAX_RECORD_BYTES) {
                throw InboxSendStoreException(InboxSendStoreReason.UNREADABLE)
            }
            file.readBytes()
        } catch (e: IOException) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
        }
        val plaintext = try {
            secrets.open(label(jobId), sealed)
        } catch (e: SecretBoxException) {
            throw InboxSendStoreException(InboxSendStoreReason.UNREADABLE, e)
        }
        try {
            decode(String(plaintext, Charsets.UTF_8), jobId)
        } finally {
            plaintext.fill(0)
        }
    }

    private suspend fun write(job: InboxSendJob): InboxSendJob = withContext(io) {
        validate(job)
        val plaintext = encode(job).toByteArray(Charsets.UTF_8)
        val sealed = try {
            secrets.seal(label(job.jobId), plaintext)
        } catch (e: SecretBoxException) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
        } finally {
            plaintext.fill(0)
        }
        if (sealed.size > MAX_RECORD_BYTES) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE)
        }
        try {
            files.createDirectories(directory)
            files.writeAtomically(file(job.jobId), sealed)
        } catch (e: IOException) {
            throw InboxSendStoreException(InboxSendStoreReason.STORAGE, e)
        }
        job
    }

    /**
     * What a job may say about itself, checked on the way in and the way out.
     *
     * The wrapped key is the sharp one: it is the request identity, so a record
     * carrying a malformed or wrong-length box would describe a create central
     * can only refuse — and would do so under an idempotency key that can never
     * be reused for a correct one.
     */
    private fun validate(job: InboxSendJob) {
        if (!InboxId.isValid(job.jobId)) unreadable()
        if (!InboxId.isValid(job.targetDeviceId)) unreadable()
        if (!InboxSendRequest.isValidIdempotencyKey(job.idempotencyKey)) unreadable()
        if (job.totalBytes < 0) unreadable()
        if (job.ciphertextBytes < 0) unreadable()
        // Bytes without an identity is the inconsistency that matters: a record
        // naming a payload it cannot check is one this code must not act on.
        //
        // The converse is NOT an inconsistency. Zero bytes WITH an identity is
        // exactly how an empty delivery is represented — the encoder emits no
        // frames for a file with no content, and the digest of nothing is a
        // well-defined value. Treating the pair as one biconditional rejected
        // that record on the way to disk, so a zero-only send could never be
        // staged; and zero bytes with NO identity is still just an unprepared
        // job, which is legal and remains so.
        if (job.ciphertextBytes > 0 && job.ciphertextSha256.isEmpty()) unreadable()
        if (job.ciphertextSha256.isNotEmpty() &&
            !job.ciphertextSha256.matches(Regex("^[0-9a-f]{64}$"))
        ) {
            unreadable()
        }
        // A session was opened for a specific payload; a record naming one
        // without the other cannot check what it is about to send.
        if (job.uploadId != null && !job.isPrepared) unreadable()
        job.storedFileId?.let { if (!InboxId.isValid(it)) unreadable() }
        job.uploadId?.let { if (!InboxId.isValid(it)) unreadable() }
        job.taskId?.let { if (!InboxId.isValid(it)) unreadable() }
        job.targetKeyId?.let { if (!InboxId.isValid(it)) unreadable() }
        if (job.targetKeyId != null && job.targetKeyGeneration <= 0) unreadable()
        if (job.targetKeyId == null && job.targetKeyGeneration != 0L) unreadable()
        job.wrappedKey?.let {
            if (it.length > InboxProtocol.MAX_WRAPPED_KEY_TEXT_LENGTH) unreadable()
            val raw = runCatching {
                com.relayium.protocol.inbox.InboxKeyMaterial
                    .decode(it, InboxProtocol.SEALED_BOX_BYTES)
            }
            if (raw.isFailure) unreadable()
        }
        // A task cannot exist without the request that created it.
        if (job.taskId != null && !job.isCreatable) unreadable()
        // An outstanding create is a claim that a specific request reached the
        // server. A record making that claim without the immutable request it
        // names cannot be replayed — and must never be treated as a fresh job,
        // because a fresh upload and a new sealed box under the same idempotency
        // key is precisely what central refuses as a conflict.
        if (job.unresolvedCreate && !job.isCreatable) unreadable()
        when (job.kind) {
            InboxManifestKind.TEXT -> if (job.files.isNotEmpty()) unreadable()
            InboxManifestKind.FILE -> {
                if (job.files.isEmpty()) unreadable()
                val names = HashSet<String>()
                for ((name, size) in job.files) {
                    if (size < 0) unreadable()
                    if (InboxDestinationPlan.checkedRelativePath(name) != name) unreadable()
                    if (!names.add(name.lowercase(java.util.Locale.ROOT))) unreadable()
                }
            }
        }
    }

    private fun encode(job: InboxSendJob): String = Json.stringify(
        Json.obj(
            "version" to Json.of(VERSION),
            "jobId" to Json.of(job.jobId),
            "targetDeviceId" to Json.of(job.targetDeviceId),
            "idempotencyKey" to Json.of(job.idempotencyKey),
            "kind" to Json.of(job.kind.wire),
            "files" to Json.arr(
                job.files.map {
                    Json.obj("name" to Json.of(it.first), "size" to Json.of(it.second))
                },
            ),
            "totalBytes" to Json.of(job.totalBytes),
            "ciphertextBytes" to Json.of(job.ciphertextBytes),
            "ciphertextSha256" to Json.of(job.ciphertextSha256),
            "uploadId" to Json.of(job.uploadId.orEmpty()),
            "finalizeAttempted" to Json.of(job.finalizeAttempted),
            "emptyPublishAttempted" to Json.of(job.emptyPublishAttempted),
            "storedFileId" to Json.of(job.storedFileId.orEmpty()),
            "targetKeyId" to Json.of(job.targetKeyId.orEmpty()),
            "targetKeyGeneration" to Json.of(job.targetKeyGeneration),
            "wrappedKey" to Json.of(job.wrappedKey.orEmpty()),
            "targetKeyResealed" to Json.of(job.targetKeyResealed),
            "unresolvedCreate" to Json.of(job.unresolvedCreate),
            "taskId" to Json.of(job.taskId.orEmpty()),
            "createdAt" to Json.of(job.createdAt),
            "updatedAt" to Json.of(job.updatedAt),
        ),
    )

    private fun decode(text: String, jobId: String): InboxSendJob {
        val root = Json.parseOrNull(text) as? Json.Obj ?: unreadable()
        if (whole(root, "version") != VERSION.toLong()) unreadable()
        if (str(root, "jobId") != jobId) unreadable()
        val kind = InboxManifestKind.fromWire(str(root, "kind")) ?: unreadable()
        val rows = (root["files"] as? Json.Arr)?.items ?: unreadable()
        val decoded = InboxSendJob(
            jobId = jobId,
            targetDeviceId = str(root, "targetDeviceId"),
            idempotencyKey = str(root, "idempotencyKey"),
            kind = kind,
            files = rows.map { row ->
                val entry = row as? Json.Obj ?: unreadable()
                str(entry, "name") to whole(entry, "size")
            },
            totalBytes = whole(root, "totalBytes"),
            ciphertextBytes = whole(root, "ciphertextBytes"),
            ciphertextSha256 = str(root, "ciphertextSha256"),
            uploadId = str(root, "uploadId").ifEmpty { null },
            finalizeAttempted = bool(root, "finalizeAttempted"),
            // ABSENT means false; a WRONG TYPE is still a refusal.
            //
            // The record version is unchanged, so every job written before this
            // flag existed is still a valid v1 record and must load. Reading it
            // strictly turned each one UNREADABLE on the first launch after an
            // upgrade — a staged delivery the user had already asked for,
            // destroyed by a field that was merely missing. False is the honest
            // default: code that never had the flag never took the single-shot
            // route, so nothing was ever attempted under it.
            emptyPublishAttempted = optionalBool(root, "emptyPublishAttempted"),
            storedFileId = str(root, "storedFileId").ifEmpty { null },
            targetKeyId = str(root, "targetKeyId").ifEmpty { null },
            targetKeyGeneration = whole(root, "targetKeyGeneration"),
            wrappedKey = str(root, "wrappedKey").ifEmpty { null },
            targetKeyResealed = bool(root, "targetKeyResealed"),
            unresolvedCreate = bool(root, "unresolvedCreate"),
            taskId = str(root, "taskId").ifEmpty { null },
            createdAt = whole(root, "createdAt"),
            updatedAt = whole(root, "updatedAt"),
        )
        validate(decoded)
        return decoded
    }

    private fun unreadable(): Nothing =
        throw InboxSendStoreException(InboxSendStoreReason.UNREADABLE)

    private fun str(source: Json.Obj, key: String): String =
        (source[key] as? Json.Str)?.value ?: unreadable()

    private fun bool(source: Json.Obj, key: String): Boolean =
        (source[key] as? Json.Bool)?.value ?: unreadable()

    /**
     * A boolean a record may legitimately not carry.
     *
     * Absent — including an explicit `null` — is the default; anything present
     * and not a boolean is still refused. The distinction matters: a field
     * added after some records were written is missing for an ordinary reason,
     * while a field holding a string is a record this build cannot vouch for.
     */
    private fun optionalBool(source: Json.Obj, key: String, fallback: Boolean = false): Boolean =
        when (val value = source[key]) {
            null, is Json.Null -> fallback
            is Json.Bool -> value.value
            else -> unreadable()
        }

    private fun whole(source: Json.Obj, key: String): Long {
        val value = (source[key] as? Json.Num)?.value ?: unreadable()
        if (!value.isFinite() || value != Math.floor(value) ||
            value < 0 || value > MAX_SAFE_INTEGER.toDouble()
        ) {
            unreadable()
        }
        return value.toLong()
    }

    companion object {
        const val LABEL_PREFIX = "relayium/inbox/send"

        private const val SUFFIX = ".json"
        private const val SPOOL_SUFFIX = ".spool"
        private const val KEY_SUFFIX = ".key"
        private const val MANIFEST_SUFFIX = ".manifest"

        /** Distinct labels, so one side record cannot be opened as another. */
        const val KEY_LABEL = "relayium/inbox/send-key"
        const val MANIFEST_LABEL = "relayium/inbox/send-manifest"
        private const val VERSION = 1
        private const val MAX_RECORD_BYTES = 4L * 1024 * 1024
        private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    }
}
