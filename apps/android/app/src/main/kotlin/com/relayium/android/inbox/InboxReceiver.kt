package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxKeyException
import com.relayium.protocol.inbox.InboxManifest
import com.relayium.protocol.inbox.InboxManifestException
import com.relayium.protocol.inbox.InboxManifestKind
import com.relayium.protocol.inbox.InboxManifestV3
import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import com.relayium.protocol.inbox.InboxTaskState
import com.relayium.protocol.stored.StoreDecryptor
import com.relayium.protocol.stored.StoredWireException
import java.io.File
import java.util.Base64
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/**
 * One delivery, end to end: claim material in, a published directory — or one
 * committed message — out.
 *
 * The pipeline is ordered so nothing observable is produced until everything has
 * been proven:
 *
 *     unseal -> decrypt+validate manifest -> CLASSIFY -> plan -> journal ->
 *       preflight space -> stream into STAGING, authenticating every frame ->
 *       verify the WHOLE stream -> report `verifying` -> publish -> report
 *       `saved`
 *
 * ## Classify first, container second
 *
 * The manifest's KIND is decided before anything asks whether this device has a
 * usable container, and that ordering is a requirement rather than a tidy-up. A
 * message is not written to the container — it is committed to the message store
 * — so a full or unwritable container has nothing to do with whether one can
 * land. Checking the container first would block a delivery that does not need
 * it and report `directory_unavailable` about a directory the delivery was never
 * going to touch.
 *
 * ## Resume
 *
 * A transport interruption resumes from `StoreDecryptor.consumedCipher`, which
 * only advances past frames that have already authenticated — so a resumed
 * request can neither re-feed a partial frame nor skip one. That is what makes
 * announcing `inbox.resume.v1` truthful.
 *
 * PROCESS DEATH is different and deliberately not resumed: the staged bytes are
 * discarded and the download restarts from zero. Restoring the decryptor's frame
 * counter across a crash would need durable cipher-stream state the protocol
 * module does not expose, and no plaintext partial is trusted after a crash. The
 * journal and the plan survive, so nothing is duplicated and no destination is
 * re-derived.
 */
class InboxReceiver(
    private val transport: InboxDeviceTransport,
    private val keys: InboxKeyStoring,
    private val journals: InboxJournalStore,
    private val messages: InboxMessageStore,
    private val container: InboxContainer,
    private val secrets: SecretBox,
    private val files: DurableFiles,
    private val account: InboxAccountId,
    private val nowSeconds: () -> Long,
    /** The receive directory for this pass, or null when it is unusable. Held by
     *  the caller for the whole delivery so it cannot change underneath one. */
    private val root: File?,
    /** How often a working delivery re-reports its state to renew the lease. A
     *  third of the lease, so two renewals may be lost before it is at risk. */
    private val renewIntervalSeconds: Long = InboxProtocol.DEFAULT_LEASE_SECONDS / 3L,
    /** Reconnects bounded for ONE delivery attempt; beyond this central's own
     *  backoff and attempt budget decide, and this must not out-retry it. */
    private val streamAttempts: Int = 5,
    /**
     * Free space for a preflight, or null when it is unknown.
     *
     * Injected rather than measured here, and the reason is that measuring it
     * properly needs a `Context`: `File.usableSpace` ignores cache the system
     * would clear on demand, so it under-reports and would park deliveries that
     * actually fit. The composing layer supplies a `StorageManager`-backed
     * answer; unknown never blocks, because refusing a delivery on a number this
     * layer does not have would be a guess.
     */
    private val freeBytes: () -> Long? = { null },
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {

    enum class Outcome {
        /** Published in this run. */
        COMMITTED,

        /** The journal already said so from an earlier run whose `saved` report
         *  did not land. Re-downloading would duplicate the delivery; the
         *  correct action is to re-assert what already happened. */
        ALREADY_COMMITTED,
    }

    /**
     * Run one task to completion. Returns only on a durable commit.
     *
     * Every error thrown is either an [InboxFailure] carrying the state and code
     * to report, or an [InboxAbandon] meaning report nothing — so the caller
     * never has to interpret a local error to decide what to tell central.
     */
    suspend fun deliver(delivery: InboxDelivery): Outcome {
        currentCoroutineContext().ensureActive()
        val task = delivery.task

        val existing = loadJournal(task.id)
        if (existing != null && existing.isCompleted) {
            validateIdentity(existing, task, null)
            return Outcome.ALREADY_COMMITTED
        }

        val contentKey = unsealContentKey(delivery)
        try {
            val manifest = openManifest(delivery, contentKey)
            val total = manifest.items.sumOf { it.size }
            // The classification, and it happens HERE — before the container is
            // consulted, before a destination is planned, before space is
            // measured on a volume this delivery may never write to.
            return when (manifest.items.first().kind) {
                InboxManifestKind.TEXT ->
                    deliverMessage(delivery, contentKey, total, existing)
                InboxManifestKind.FILE ->
                    deliverFiles(delivery, contentKey, manifest, total, existing)
            }
        } finally {
            contentKey.fill(0)
        }
    }

    // ── file deliveries ─────────────────────────────────────────────────────

    private suspend fun deliverFiles(
        delivery: InboxDelivery,
        contentKey: ByteArray,
        manifest: InboxManifestV3,
        total: Long,
        existing: InboxJournal?,
    ): Outcome {
        val task = delivery.task
        // The one place the container is required, and the only delivery that
        // can be blocked by it.
        val root = root ?: throw InboxFailure.attention(
            InboxDeviceErrorCode.DIRECTORY_UNAVAILABLE,
            InboxFailure.Reason.DIRECTORY_UNAVAILABLE,
        )
        val journal = planAndJournal(delivery, manifest, root, existing)

        // BEFORE free space and before any download: a previous attempt may have
        // renamed the directory into place and died before recording it. That
        // delivery is finished — but measuring space for a second copy, wiping
        // staging and re-fetching the ciphertext can each fail for a task that is
        // already on disk, and a recovery gated behind them would report
        // `disk_full` for files the user already has.
        val recovered = commitFailure {
            InboxCommit.recoverPublished(
                journal, container.staging(account, task.id), journals,
                secrets, files, account, nowSeconds, io,
            )
        }
        if (recovered != null) return Outcome.ALREADY_COMMITTED

        if (!hasRoom(total)) {
            throw InboxFailure.attention(
                InboxDeviceErrorCode.DISK_FULL, InboxFailure.Reason.NOT_ENOUGH_SPACE,
            )
        }

        val staging = container.staging(account, task.id)
        val digests: Map<String, String>
        val writer = try {
            InboxCommit.prepareStaging(staging, files, io)
            InboxStagingWriter(staging, journal.plan, files)
        } catch (e: java.io.IOException) {
            throw InboxFailure.attention(
                InboxDeviceErrorCode.DIRECTORY_UNAVAILABLE,
                InboxFailure.Reason.DIRECTORY_UNAVAILABLE,
            )
        }
        try {
            writer.use {
                stream(delivery, contentKey, it, total)
                digests = it.fileDigests.toMap()
            }
        } catch (e: Throwable) {
            // Nothing outside staging exists yet, so removing it leaves no
            // trace of a delivery that did not happen.
            InboxCommit.cleanStaging(staging, io)
            throw e
        }

        // The bytes are proven. Tell central we are verifying BEFORE anything
        // enters the container, so the sender's view never shows a gap between
        // "downloaded" and "landed".
        try {
            currentCoroutineContext().ensureActive()
            renew(delivery, InboxTaskState.VERIFYING)
            // Cancellation is allowed up to the last reversible boundary. The
            // publication itself is one atomic step, so there is no half-visible
            // state to stop in.
            currentCoroutineContext().ensureActive()
        } catch (e: Throwable) {
            InboxCommit.cleanStaging(staging, io)
            throw e
        }

        commitFailure {
            InboxCommit.publish(
                journal, staging, journals, secrets, files, account, digests, nowSeconds, io,
            )
        }
        return Outcome.COMMITTED
    }

    /**
     * Compute the plan and make it durable BEFORE any destination can exist.
     *
     * A resumed task keeps its ORIGINAL plan and published directory name:
     * recomputing either against a container that now holds this task's own
     * output would walk the suffix forward and deliver the same files twice.
     */
    private suspend fun planAndJournal(
        delivery: InboxDelivery,
        manifest: InboxManifestV3,
        root: File,
        existing: InboxJournal?,
    ): InboxJournal {
        val task = delivery.task
        if (existing != null && existing.plan.isNotEmpty()) {
            validateIdentity(existing, task, InboxManifestKind.FILE)
            if (existing.root != root.path) {
                throw InboxFailure.attention(
                    InboxDeviceErrorCode.DIRECTORY_UNAVAILABLE,
                    InboxFailure.Reason.RECEIVE_ROOT_CHANGED,
                )
            }
            return existing
        }
        val directory = InboxDestinationPlan.planTaskDirectory(root, manifest.items, task.id)
        val plan = try {
            InboxDestinationPlan.plan(directory, manifest.items)
        } catch (e: InboxPlanException) {
            throw when (e.reason) {
                InboxPlanException.Reason.DUPLICATE_DESTINATION ->
                    InboxFailure.terminal(
                        InboxDeviceErrorCode.NAME_CONFLICT,
                        InboxFailure.Reason.DUPLICATE_DESTINATION,
                    )
                else -> InboxFailure.terminal(
                    InboxDeviceErrorCode.UNSUPPORTED, InboxFailure.Reason.UNSAFE_NAME,
                )
            }
        }
        val journal = InboxJournal(
            taskId = task.id,
            storedFileId = task.storedFileId,
            targetKeyId = task.targetKeyId,
            senderDeviceId = task.sourceDeviceId,
            kind = InboxManifestKind.FILE,
            root = root.path,
            taskDirectory = directory.path,
            plan = plan,
            plannedAt = nowSeconds(),
        )
        return saveJournal(journal)
    }

    // ── message deliveries ──────────────────────────────────────────────────

    private suspend fun deliverMessage(
        delivery: InboxDelivery,
        contentKey: ByteArray,
        total: Long,
        existing: InboxJournal?,
    ): Outcome {
        val task = delivery.task
        val journal = if (existing != null) {
            validateIdentity(existing, task, InboxManifestKind.TEXT)
            existing
        } else {
            saveJournal(
                InboxJournal(
                    taskId = task.id,
                    storedFileId = task.storedFileId,
                    targetKeyId = task.targetKeyId,
                    senderDeviceId = task.sourceDeviceId,
                    kind = InboxManifestKind.TEXT,
                    // A message is journalled against the MESSAGE STORE, which
                    // does not move with the container, so a container problem
                    // cannot invalidate it.
                    root = messages.directory.path,
                    taskDirectory = "",
                    plan = emptyList(),
                    plannedAt = nowSeconds(),
                ),
            )
        }

        val buffer = InboxMessageBuffer(total.toInt())
        buffer.use { stream(delivery, contentKey, it, total) }

        // The bytes authenticated and are exactly as long as the manifest said.
        // That still does not make them a MESSAGE: a sender may be broken or
        // hostile, and a receiver that repaired invalid UTF-8 would show the
        // user something nobody wrote.
        val text = buffer.message()
        if (text == null || !InboxMessageStore.isAcceptable(text)) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.VERIFY_FAILED, InboxFailure.Reason.MESSAGE_MALFORMED,
            )
        }

        currentCoroutineContext().ensureActive()
        renew(delivery, InboxTaskState.VERIFYING)
        currentCoroutineContext().ensureActive()

        // Store first, journal second. A crash between them costs a re-download
        // that rewrites the SAME record at the SAME name — the store is keyed by
        // task id — so the window produces a duplicate of nothing. The reverse
        // order would let a journal claim a message that is not there.
        try {
            messages.commit(task.id, task.sourceDeviceId, text, nowSeconds())
        } catch (e: InboxMessageException) {
            throw InboxFailure.retryable(
                InboxDeviceErrorCode.INTERNAL, InboxFailure.Reason.UNEXPECTED,
            )
        }
        journals.recordMessageCommitted(journal.taskId, total, nowSeconds())
        return Outcome.COMMITTED
    }

    // ── the stream ──────────────────────────────────────────────────────────

    /**
     * Fetch the ciphertext, authenticate every frame, and land the plaintext in
     * the sink — resuming from the last COMPLETE frame boundary across transport
     * failures within this attempt.
     */
    private suspend fun stream(
        delivery: InboxDelivery,
        contentKey: ByteArray,
        sink: InboxPayloadSink,
        total: Long,
    ) {
        val decryptor = StoreDecryptor(contentKey)
        var lastRenew = nowSeconds()
        var attempt = 1
        while (true) {
            try {
                streamOnce(delivery, decryptor, sink) { lastRenew = it }.let { lastRenew = it }
                break
            } catch (e: InboxAbandon) {
                throw e
            } catch (e: InboxFailure) {
                throw e
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (attempt >= streamAttempts) {
                    throw InboxFailure.retryable(
                        InboxDeviceErrorCode.DOWNLOAD_FAILED,
                        InboxFailure.Reason.DOWNLOAD_FAILED,
                    )
                }
                // The buffered tail of an interrupted frame is dropped: a
                // reconnect restarts at the last authenticated boundary, so
                // keeping it would prepend bytes the resumed read already
                // contains and everything after would decode as rubbish.
                decryptor.resetBuffer()
                attempt += 1
            }
        }

        // `end` is the completeness proof: it rejects a dangling partial frame
        // and any total length other than what the manifest declared. Cutting a
        // stream on a frame BOUNDARY leaves every delivered frame perfectly
        // authentic, so the declared size is the only thing that distinguishes
        // "the file ended" from "someone stopped it early".
        try {
            decryptor.end(total)
        } catch (e: StoredWireException) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.VERIFY_FAILED, InboxFailure.Reason.CIPHERTEXT_INVALID,
            )
        }
        sink.finish()
        sink.verifyDelivered()
    }

    private suspend fun streamOnce(
        delivery: InboxDelivery,
        decryptor: StoreDecryptor,
        sink: InboxPayloadSink,
        onRenew: (Long) -> Unit,
    ): Long {
        currentCoroutineContext().ensureActive()
        val start = decryptor.consumedCipher
        var lastRenew = nowSeconds()
        try {
            transport.withBlob(delivery.task.id, delivery.claimToken, start) { stream ->
                // A resume the server answered with a full body is a FRESH
                // START, not a tail. Splicing it into the middle of an
                // authenticated stream would produce plausible rubbish.
                if (start > 0 && !stream.isPartial) {
                    throw InboxFailure.retryable(
                        InboxDeviceErrorCode.DOWNLOAD_FAILED,
                        InboxFailure.Reason.RANGE_IGNORED,
                    )
                }
                val buffer = ByteArray(READ_BUFFER)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val read = withContext(io) { stream.read(buffer) }
                    if (read < 0) break
                    val plaintexts = try {
                        decryptor.push(buffer.copyOf(read))
                    } catch (e: StoredWireException) {
                        throw InboxFailure.terminal(
                            InboxDeviceErrorCode.VERIFY_FAILED,
                            InboxFailure.Reason.CIPHERTEXT_INVALID,
                        )
                    }
                    for (plaintext in plaintexts) sink.write(plaintext)
                    if (nowSeconds() - lastRenew >= renewIntervalSeconds) {
                        // A refused renewal means the lease is gone. Finishing
                        // the download would be work this receiver is no longer
                        // authorised to assert, so it stops here rather than at
                        // the end.
                        renew(delivery, InboxTaskState.DOWNLOADING)
                        lastRenew = nowSeconds()
                        onRenew(lastRenew)
                    }
                }
            }
        } catch (e: InboxApiException) {
            // A rejection with a machine-readable code is central's judgement
            // and is not something a reconnect fixes.
            throw when (e.rejection) {
                InboxRejection.STALE_CLAIM -> InboxAbandon(InboxAbandon.Cause.STALE_CLAIM)
                InboxRejection.TASK_TERMINAL -> InboxAbandon(InboxAbandon.Cause.TASK_TERMINAL)
                InboxRejection.STORED_OBJECT_UNAVAILABLE ->
                    InboxAbandon(InboxAbandon.Cause.STORED_OBJECT_UNAVAILABLE)
                else -> e
            }
        }
        return lastRenew
    }

    /** Re-report the current state: an idempotent no-op that renews the lease.
     *  Any refusal means the lease is gone. */
    private suspend fun renew(delivery: InboxDelivery, state: InboxTaskState) {
        try {
            transport.report(
                delivery.task.id, delivery.claimToken, state,
                InboxDeviceErrorCode.NONE, committed = false,
            )
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Throwable) {
            throw InboxAbandon(InboxAbandon.Cause.LEASE_RENEWAL_REFUSED)
        }
    }

    // ── pipeline steps ──────────────────────────────────────────────────────

    /** Resolve the device private key the task names and open the sealed
     *  content key. */
    private suspend fun unsealContentKey(delivery: InboxDelivery): ByteArray {
        val keyPair = try {
            keys.keyPair(delivery.task.targetKeyId, account)
        } catch (e: InboxKeyStoreException) {
            throw InboxFailure.retryable(
                InboxDeviceErrorCode.INTERNAL, InboxFailure.Reason.UNEXPECTED,
            )
        } ?: throw InboxFailure.terminal(
            // Central sealed to a key this account does not hold here — a
            // re-login that minted a new device, a restored install, a key
            // history that was destroyed. Nothing can ever open it.
            InboxDeviceErrorCode.DECRYPT_FAILED, InboxFailure.Reason.NO_LOCAL_PRIVATE_KEY,
        )
        return try {
            InboxKeyMaterial.unsealContentKey(
                delivery.task.wrapAlgorithm, delivery.wrappedKey, keyPair,
            )
        } catch (e: InboxKeyException) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.DECRYPT_FAILED, InboxFailure.Reason.WRAPPED_KEY_UNREADABLE,
            )
        } finally {
            keyPair.destroy()
        }
    }

    /**
     * Decrypt and validate the encrypted manifest.
     *
     * The size cross-check is the one that matters: a manifest is
     * sender-controlled, and AEAD only proves who wrote it. Declared plaintext
     * can never exceed the ciphertext byte count central measured itself —
     * every frame adds a length prefix and a tag — so a manifest claiming
     * terabytes behind a small object is a lie central can be used to catch,
     * before any space is reserved for it.
     */
    private fun openManifest(delivery: InboxDelivery, contentKey: ByteArray): InboxManifestV3 {
        val sealed = try {
            Base64.getDecoder().decode(delivery.encManifest)
        } catch (e: IllegalArgumentException) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.VERIFY_FAILED, InboxFailure.Reason.MANIFEST_UNREADABLE,
            )
        }
        val manifest = try {
            InboxManifest.open(contentKey, sealed)
        } catch (e: InboxManifestException) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.VERIFY_FAILED, InboxFailure.Reason.MANIFEST_INVALID,
            )
        } catch (e: InboxKeyException) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.DECRYPT_FAILED, InboxFailure.Reason.MANIFEST_UNREADABLE,
            )
        }
        val total = manifest.items.sumOf { it.size }
        if (delivery.task.ciphertextBytes > 0 && total > delivery.task.ciphertextBytes) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.VERIFY_FAILED,
                InboxFailure.Reason.MANIFEST_EXCEEDS_CIPHERTEXT,
            )
        }
        return manifest
    }

    /**
     * A task id names the journal file, but it is not sufficient identity for
     * resumption.
     *
     * A stale or replaced journal is refused unless every immutable delivery
     * binding still matches this claim. The KIND is part of that identity: a
     * journal describing files cannot be resumed as a message or the other way
     * round, because they commit to different places, and continuing under the
     * wrong one is how a delivery lands twice or lands nowhere.
     */
    private fun validateIdentity(
        journal: InboxJournal,
        task: InboxTaskRow,
        kind: InboxManifestKind?,
    ) {
        val agrees = journal.taskId == task.id &&
            journal.storedFileId == task.storedFileId &&
            journal.targetKeyId == task.targetKeyId &&
            journal.senderDeviceId == task.sourceDeviceId &&
            (kind == null || journal.kind == kind)
        if (!agrees) {
            throw InboxFailure.terminal(
                InboxDeviceErrorCode.INTERNAL, InboxFailure.Reason.JOURNAL_UNREADABLE,
            )
        }
    }

    /**
     * Turn a publication refusal into the closed vocabulary central understands.
     *
     * Done here rather than left to propagate, because the layer above reports
     * from [InboxFailure] alone: an unmapped exception would escape the pass
     * entirely and central would learn nothing about why the delivery stopped.
     */
    private suspend fun <T> commitFailure(body: suspend () -> T): T = try {
        body()
    } catch (e: InboxCommitException) {
        throw when (e.reason) {
            InboxCommitException.Reason.NAME_CONFLICT -> InboxFailure.attention(
                InboxDeviceErrorCode.NAME_CONFLICT, InboxFailure.Reason.NAME_CONFLICT,
            )
            InboxCommitException.Reason.DISK_FULL -> InboxFailure.attention(
                InboxDeviceErrorCode.DISK_FULL, InboxFailure.Reason.NOT_ENOUGH_SPACE,
            )
            InboxCommitException.Reason.PERMISSION_DENIED -> InboxFailure.attention(
                InboxDeviceErrorCode.PERMISSION_DENIED,
                InboxFailure.Reason.DIRECTORY_UNAVAILABLE,
            )
            InboxCommitException.Reason.STORAGE -> InboxFailure.retryable(
                InboxDeviceErrorCode.INTERNAL, InboxFailure.Reason.UNEXPECTED,
            )
        }
    }

    private fun hasRoom(total: Long): Boolean {
        val free = freeBytes() ?: return true
        return free >= total + SPACE_HEADROOM
    }

    private suspend fun loadJournal(taskId: String): InboxJournal? = try {
        journals.load(taskId)
    } catch (e: InboxJournalException) {
        throw InboxFailure.terminal(
            InboxDeviceErrorCode.INTERNAL, InboxFailure.Reason.JOURNAL_UNREADABLE,
        )
    }

    private suspend fun saveJournal(journal: InboxJournal): InboxJournal = try {
        journals.save(journal, nowSeconds())
    } catch (e: InboxJournalException) {
        throw InboxFailure.retryable(
            InboxDeviceErrorCode.INTERNAL, InboxFailure.Reason.UNEXPECTED,
        )
    }

    private companion object {
        const val READ_BUFFER = 64 * 1024

        /** Slack over the declared plaintext, because staging and the published
         *  copy briefly coexist and the filesystem itself needs room. */
        const val SPACE_HEADROOM = 8L * 1024 * 1024
    }
}
