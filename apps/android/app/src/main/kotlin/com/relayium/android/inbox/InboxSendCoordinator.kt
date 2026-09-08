package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxKeyMaterial
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxRejection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Drives one staged delivery to exactly one task central holds.
 *
 * The sequence, and why it is this order:
 *
 *  1. check the target is still a legal one, BEFORE a byte moves. A device whose
 *     owner turned receiving off refuses the create, so discovering that after
 *     an encrypted upload would cost the user the whole transfer;
 *  2. upload the ciphertext as `purpose=device_task` — no link, no file-list
 *     row, 404 on the public endpoints even for its owner;
 *  3. re-read the device and seal the content key to its CURRENT public key.
 *     Sealing LAST is deliberate: it is the cheap step, so a rotation during a
 *     long upload is answered by re-wrapping 80 bytes rather than sending the
 *     file again;
 *  4. persist the exact request — idempotency key, object, target key and
 *     generation, and the sealed box — BEFORE the first create leaves this
 *     process;
 *  5. create, which binds the object to the task inside one transaction.
 *
 * ## The line everything here is organised around
 *
 * A DEFINITIVE non-success means central's transaction rolled back and no task
 * can own this ciphertext. The object is invisible — no link, no list row, no
 * control — so leaving it behind is storage the account pays for and cannot see.
 * It may be released.
 *
 * An AMBIGUOUS outcome — the request never arrived, or its answer was lost —
 * means a delivery MAY be live. Nothing is released, because the mistake in that
 * direction destroys a real transfer of the user's file.
 *
 * A sealed box is randomized, so "retry with an equivalent request" is not a
 * retry: central answers a different box under the same idempotency key with
 * `idempotency_key_conflict`. Only the byte-identical request converges.
 */
class InboxSendCoordinator(
    private val sender: InboxSenderTransport,
    private val store: InboxSendStore,
    private val uploader: InboxCiphertextUploader,
    private val nowSeconds: () -> Long,
) {

    /** What a send attempt established. */
    sealed interface Result {
        /** Central holds exactly one task for this delivery. */
        data class Delivered(val task: InboxTaskRow, val created: Boolean) : Result

        /**
         * The attempt stopped without a task, and whether the delivery may still
         * exist decides what may be cleaned up.
         */
        data class Stopped(val reason: Reason, val ambiguous: Boolean) : Result

        enum class Reason {
            /** The target cannot be sent to at all right now. */
            TARGET_INELIGIBLE,

            /** The target's key rotated faster than this send could follow. */
            STALE_TARGET_KEY,

            /** This idempotency key already names a DIFFERENT delivery. Never a
             *  convergence: central refuses rather than returning the first
             *  task, so a caller cannot mistake one delivery for another. */
            IDEMPOTENCY_CONFLICT,

            /** The object is already bound to some other task. */
            OBJECT_ALREADY_BOUND,

            /** The target has as many pending tasks as central will hold. */
            QUEUE_FULL,

            /** The upload or the create could not be completed. */
            TRANSPORT,

            /** Local durable state could not be written. Nothing was sent. */
            STORAGE,
            ;

            /**
             * Whether this outcome ends the job, as opposed to pausing it.
             *
             * Only a terminal outcome may release the spool, and the spool may
             * be the last copy Relayium holds of what the user asked to send. A
             * network that could not be reached, or a local write that failed,
             * says nothing about the delivery and will very likely work next
             * time — deleting the user's staged bytes over one of those would be
             * losing their file to a transient error.
             */
            val isTerminal: Boolean
                get() = this == TARGET_INELIGIBLE || this == STALE_TARGET_KEY ||
                    this == QUEUE_FULL
        }
    }

    /**
     * How many times a create may be repeated after an AMBIGUOUS answer within
     * one attempt.
     *
     * Small on purpose. Repeating a request whose answer was lost is a cheap
     * guess; the real convergence is central's own idempotency, and beyond that
     * a later attempt re-sends the identical request rather than this one
     * hammering.
     */
    private val ambiguousCreateAttempts = 3

    /**
     * Take one durable job as far as it can go.
     *
     * Addressed BY ID and reloaded from the store, never driven from a record a
     * caller happens to hold: a stale UI copy could otherwise carry no task id
     * and no outstanding-create flag, and the send would create a second task
     * for a delivery that already has one.
     *
     * Safe to call again: every step is either already recorded or reproduces
     * the identical request.
     */
    suspend fun deliver(jobId: String): Result = InboxSendOperations.withJob(store, jobId) {
        currentCoroutineContext().ensureActive()
        val job = try {
            store.load(jobId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: InboxSendStoreException) {
            // The durable record is the authority. Without it nothing may be
            // decided, and in particular nothing may be released.
            return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous = true)
        } ?: return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous = false)

        // A job that already names a task is a previous attempt that succeeded
        // and died during its own tidy-up. Creating again here is the one thing
        // that must never happen, so this branch reads the delivery instead.
        job.taskId?.let { taskId ->
            return@withJob try {
                Result.Delivered(sender.task(job.targetDeviceId, taskId), created = false)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Not knowing is not the same as it being gone.
                Result.Stopped(Result.Reason.TRANSPORT, ambiguous = true)
            }
        }

        var current = job
        // MONOTONIC. Once any attempt — in this call or an earlier process —
        // has left a create outstanding, every later outcome in this job's life
        // is ambiguous, because that earlier request may have created the task.
        // A per-attempt reading would classify "IOException, then queue_full" as
        // definitive and delete a live delivery's object.
        var ambiguous = job.unresolvedCreate

        // An exact retry of a create whose answer was lost goes STRAIGHT to the
        // wire. The preflight and the reseal are both skipped deliberately: a
        // target that has since turned receiving off, or rotated its key, would
        // fail those checks — while central's idempotency would happily converge
        // the original request onto the task it already holds. Re-checking
        // eligibility here would abandon a delivery that is already queued.
        if (!(current.unresolvedCreate && current.isCreatable)) {
            // 1. The fail-fast guard, on a first attempt only. Its job is to not
            //    spend the user's bandwidth on a target that will refuse.
            when (target(current.targetDeviceId)) {
                is TargetState.Ineligible ->
                    return@withJob Result.Stopped(Result.Reason.TARGET_INELIGIBLE, ambiguous)
                is TargetState.Unknown ->
                    return@withJob Result.Stopped(Result.Reason.TRANSPORT, ambiguous)
                is TargetState.Eligible -> Unit
            }

            // 2. Upload, unless a previous attempt already published the object.
            if (current.storedFileId == null) {
                current = try {
                    uploader.upload(current, store)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: InboxUploadException) {
                    // An ambiguous finalize may have published the object, so
                    // the job is kept exactly as it is: opening a new session
                    // would create a second object the account pays for and
                    // cannot see.
                    return@withJob Result.Stopped(
                        Result.Reason.TRANSPORT, ambiguous || e.ambiguous,
                    )
                }
            }

            // 3. Re-read AFTER the upload: this is the key the seal must use,
            //    and an upload can take long enough for the one it started with
            //    to be stale.
            val sealTarget = when (val state = target(current.targetDeviceId)) {
                is TargetState.Eligible -> state.target
                is TargetState.Ineligible ->
                    return@withJob Result.Stopped(Result.Reason.TARGET_INELIGIBLE, ambiguous)
                is TargetState.Unknown ->
                    return@withJob Result.Stopped(Result.Reason.TRANSPORT, ambiguous)
            }
            current = try {
                ensureSealed(current, sealTarget)
            } catch (e: InboxSendStoreException) {
                // No create may leave this process until the randomized request
                // identity is durable: an in-memory box would be re-sealed
                // differently by the next process and refused as a conflict.
                return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous)
            }
        }

        if (!current.isCreatable) {
            return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous)
        }

        var ambiguousAttempts = 0
        while (ambiguousAttempts < ambiguousCreateAttempts) {
            currentCoroutineContext().ensureActive()
            val request = try {
                InboxSendRequest(
                    idempotencyKey = current.idempotencyKey,
                    storedFileId = requireNotNull(current.storedFileId),
                    wrappedKey = requireNotNull(current.wrappedKey),
                    targetKeyId = requireNotNull(current.targetKeyId),
                    targetKeyGeneration = current.targetKeyGeneration,
                )
            } catch (e: Throwable) {
                // Locally malformed, so THIS request was never sent — but an
                // earlier one may have been.
                return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous)
            }

            // The uncertainty is durable BEFORE the request leaves. A process
            // that dies mid-create must come back knowing a task may exist.
            current = try {
                if (current.unresolvedCreate) current
                else store.save(current.copy(unresolvedCreate = true), nowSeconds())
            } catch (e: InboxSendStoreException) {
                return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous)
            }

            val creation = try {
                sender.createTask(current.targetDeviceId, request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: InboxApiException) {
                when (e.rejection) {
                    InboxRejection.STALE_TARGET_KEY -> {
                        // A reseal is permitted only when this refusal is the
                        // ONLY unresolved create. With an earlier one
                        // outstanding, a task may already exist under this
                        // idempotency key, and a different box would collide
                        // with it rather than converge.
                        if (current.targetKeyResealed || ambiguous) {
                            return@withJob Result.Stopped(Result.Reason.STALE_TARGET_KEY, ambiguous)
                        }
                        // This refusal PROVES the create rolled back, so the
                        // uncertainty it recorded is resolved.
                        val fresh = when (val state = target(current.targetDeviceId)) {
                            is TargetState.Eligible -> state.target
                            is TargetState.Ineligible ->
                                return@withJob Result.Stopped(
                                    Result.Reason.TARGET_INELIGIBLE, ambiguous,
                                )
                            is TargetState.Unknown ->
                                return@withJob Result.Stopped(Result.Reason.TRANSPORT, ambiguous)
                        }
                        current = try {
                            reseal(current.copy(unresolvedCreate = false), fresh)
                        } catch (e2: InboxSendStoreException) {
                            return@withJob Result.Stopped(Result.Reason.STORAGE, ambiguous)
                        }
                        continue
                    }
                    // NOT definitive despite being a 4xx: a task exists under
                    // this idempotency key, and it may be this job's own from an
                    // attempt whose answer was lost.
                    InboxRejection.IDEMPOTENCY_KEY_CONFLICT ->
                        return@withJob Result.Stopped(
                            Result.Reason.IDEMPOTENCY_CONFLICT, ambiguous = true,
                        )
                    // Likewise: some task owns this object, possibly ours.
                    InboxRejection.STORED_OBJECT_ALREADY_BOUND ->
                        return@withJob Result.Stopped(Result.Reason.OBJECT_ALREADY_BOUND, ambiguous)
                    // Central refuses these BEFORE storing anything, so THIS
                    // request created nothing. Still only definitive when no
                    // earlier attempt is outstanding.
                    InboxRejection.INBOX_QUEUE_FULL ->
                        return@withJob preStorage(current, Result.Reason.QUEUE_FULL, ambiguous)
                    InboxRejection.AUTO_RECEIVE_DISABLED,
                    InboxRejection.DEVICE_CANNOT_RECEIVE,
                    InboxRejection.DEVICE_INBOX_REVOKED,
                    ->
                        return@withJob preStorage(current, Result.Reason.TARGET_INELIGIBLE, ambiguous)
                    // A code this build cannot classify is not evidence that
                    // nothing happened.
                    else -> {
                        ambiguous = true
                        return@withJob Result.Stopped(Result.Reason.TRANSPORT, ambiguous = true)
                    }
                }
            } catch (e: Throwable) {
                // AMBIGUOUS: the request may or may not have arrived, and an
                // identity mismatch in the answer is equally unproven. Repeat
                // the IDENTICAL request; central converges it if it landed.
                ambiguous = true
                ambiguousAttempts += 1
                continue
            }

            // Recorded before anything is cleaned up, so a death here leaves a
            // job that reads the task rather than creating a second one.
            return@withJob try {
                store.save(
                    current.copy(taskId = creation.task.id, unresolvedCreate = false),
                    nowSeconds(),
                )
                Result.Delivered(creation.task, creation.created)
            } catch (e: InboxSendStoreException) {
                // The task EXISTS. Losing the record of it is a local problem,
                // not a reason to tell the user their file was not sent.
                Result.Delivered(creation.task, creation.created)
            }
        }

        // Every repeat was ambiguous. A delivery may be live under this
        // idempotency key, so nothing is released and the next attempt sends the
        // identical request again.
        return@withJob Result.Stopped(Result.Reason.TRANSPORT, ambiguous = true)
    }

    /**
     * A refusal central makes BEFORE storing anything.
     *
     * It proves THIS request created nothing, so the uncertainty this attempt
     * recorded is cleared — otherwise the job would carry an outstanding create
     * forever and could never be released. It cannot resolve an EARLIER
     * outstanding request, which is why [ambiguous] still decides the verdict.
     */
    private suspend fun preStorage(
        job: InboxSendJob,
        reason: Result.Reason,
        ambiguous: Boolean,
    ): Result.Stopped {
        if (!ambiguous && job.unresolvedCreate) {
            try {
                store.save(job.copy(unresolvedCreate = false), nowSeconds())
            } catch (e: CancellationException) {
                throw e
            } catch (e: InboxSendStoreException) {
                // The flag stays set, so release will refuse. Safe direction.
                return Result.Stopped(reason, ambiguous = true)
            }
        }
        return Result.Stopped(reason, ambiguous)
    }

    /**
     * Release a job whose outcome was DEFINITIVE.
     *
     * Reloads the durable record and re-checks it INDEPENDENTLY rather than
     * trusting the caller's flag: this deletes the spool, which may be the last
     * copy Relayium holds of what the user asked to send. A job that has since
     * acquired a task id, or that still records an outstanding create, is kept
     * whatever the result says.
     */
    suspend fun release(jobId: String, result: Result.Stopped) {
        // Ambiguity is about whether a delivery exists; terminality is about
        // whether this job is over. BOTH are required, because a transient
        // network failure proves nothing was created and still must not cost
        // the user their staged bytes.
        if (result.ambiguous || !result.reason.isTerminal) return
        InboxSendOperations.withJob(store, jobId) {
            val job = try {
                store.load(jobId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: InboxSendStoreException) {
                // Unable to read the authority. Keeping costs storage; deleting
                // could destroy a live delivery.
                return@withJob
            } ?: return@withJob
            if (job.taskId != null || job.unresolvedCreate) return@withJob
            store.release(jobId)
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Whether a device may be sealed to — with "could not find out" kept apart
     * from "no".
     *
     * Collapsing the two is a task-loss path: an unreachable device list would
     * read as a confirmed refusal, and a confirmed refusal is what licenses
     * deleting the job and its spool.
     */
    private sealed interface TargetState {
        data class Eligible(val target: InboxSendTarget) : TargetState
        /** A successful read said this device cannot be sent to. */
        data object Ineligible : TargetState
        /** The read itself failed. Nothing is known. */
        data object Unknown : TargetState
    }

    private suspend fun target(deviceId: String): TargetState {
        val rows = try {
            sender.devices()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return TargetState.Unknown
        }
        val row = rows.firstOrNull { it.id == deviceId } ?: return TargetState.Ineligible
        return InboxTargetEligibility.target(row)
            ?.let { TargetState.Eligible(it) } ?: TargetState.Ineligible
    }

    /**
     * Seal the content key to the target, or reuse the box already recorded.
     *
     * Reusing the persisted value is what makes a retry in another process the
     * SAME request to central rather than an idempotency conflict under the same
     * key.
     */
    private suspend fun ensureSealed(job: InboxSendJob, target: InboxSendTarget): InboxSendJob {
        // Sealed ONCE. A box that is already durable is the request identity,
        // and replacing it because the target's key looks different would send a
        // second, contradictory description of one delivery under the same
        // idempotency key — which central refuses as a conflict rather than
        // converging. The only route to a different box is the explicit reseal
        // below, and it is gated on proof that nothing was created.
        if (job.wrappedKey != null) return job
        return store.save(sealed(job, target), nowSeconds())
    }

    private suspend fun reseal(job: InboxSendJob, target: InboxSendTarget): InboxSendJob =
        store.save(sealed(job, target).copy(targetKeyResealed = true), nowSeconds())

    private suspend fun sealed(job: InboxSendJob, target: InboxSendTarget): InboxSendJob {
        // From the store, which is where durable state lives. Without the key
        // the staged ciphertext cannot be described to the recipient at all.
        val contentKey = store.contentKey(job.jobId)
            ?: throw InboxSendStoreException(InboxSendStoreReason.UNREADABLE)
        return try {
            job.copy(
                wrappedKey = InboxKeyMaterial.sealContentKey(
                    InboxProtocol.KEY_ALGORITHM, target.publicKey, contentKey,
                ),
                targetKeyId = target.keyId,
                targetKeyGeneration = target.keyGeneration,
            )
        } finally {
            contentKey.fill(0)
        }
    }
}

/**
 * Serialises whole operations on one job.
 *
 * Every step of a send reloads the durable record and then SUSPENDS — on a
 * network call, on a durable write — before acting on what it read. Without this
 * the window is real and the loss is concrete: a release can observe no
 * outstanding create, a concurrent deliver can then record one and start a
 * create, and the release deletes the job and its spool underneath a delivery
 * that may already exist. Two concurrent delivers can likewise upload and seal
 * different state under one id.
 *
 * Keyed by the STORE's identity as well as the job id, so two coordinator
 * instances over the same durable state serialize against each other — a lock
 * private to one coordinator would order only half the writers.
 *
 * Deliberately NOT the store's own mutex: that one guards a single read or
 * write, is not reentrant, and is taken by the very methods these operations
 * call.
 */
internal object InboxSendOperations {

    private val locks = HashMap<String, Mutex>()

    suspend fun <T> withJob(store: InboxSendStore, jobId: String, body: suspend () -> T): T =
        lockFor("${store.identity}|$jobId").withLock { body() }

    private fun lockFor(key: String): Mutex =
        synchronized(locks) { locks.getOrPut(key) { Mutex() } }
}

/**
 * Puts one job's framed ciphertext on the server as a `device_task` object.
 *
 * A seam, because the interesting behaviour above it is what happens when a
 * finalize's answer is lost — and because the concrete uploader composes the
 * app's existing stored-object transport rather than reimplementing it.
 */
interface InboxCiphertextUploader {

    /**
     * Upload this job's spool and return it with [InboxSendJob.storedFileId]
     * set.
     *
     * Must persist the session and the finalize ATTEMPT before making them, so a
     * job whose finalize answer was lost never opens a second session.
     *
     * Reads what it needs — the spool, the sealed manifest — from the STORE.
     * Durable state has one owner, and an uploader that also held it could
     * disagree with the record a retry in another process would read.
     */
    suspend fun upload(job: InboxSendJob, store: InboxSendStore): InboxSendJob
}

/** An upload that did not complete. [ambiguous] is the whole point: it decides
 *  whether the object may be released. */
class InboxUploadException(val ambiguous: Boolean, cause: Throwable? = null) :
    RuntimeException("relayium inbox upload: ambiguous=$ambiguous", cause)
