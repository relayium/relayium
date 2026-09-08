package com.relayium.android.inbox

import com.relayium.android.cloud.CloudClient
import com.relayium.android.cloud.CloudException
import com.relayium.android.cloud.CloudFailure
import com.relayium.android.cloud.StoredUploadPurpose
import com.relayium.protocol.stored.uploadHeader
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Puts one job's framed ciphertext on the server as a `device_task` object.
 *
 * Composes the app's existing stored-object transport rather than reimplementing
 * it — the resumable session, the offset discipline and the failure
 * classification are already there and already exercised. The only thing this
 * adds is the PURPOSE and the crash ordering around it.
 *
 * ## Why the purpose matters
 *
 * A `device_task` object is not a share. It has no capability link, no row in
 * the account's file list, and its public endpoints answer 404 even for its
 * owner: the only reader is the target device, through the task it is bound to.
 * The queue also refuses a limited object, so burn-after-read and a download cap
 * are refused before a socket is opened rather than silently rewritten.
 *
 * ## The crash gaps, and what each one must not do
 *
 * Each step records its intent BEFORE performing it, because the failure that
 * matters is not the request failing — it is the ANSWER being lost:
 *
 *  * **init.** The session id is durable before a single byte is appended.
 *    Without that, a death here leaves an orphaned session and the next attempt
 *    opens a second one, paying twice for storage the user cannot see.
 *  * **PATCH.** Resumed from the SERVER's authoritative offset, never from a
 *    local idea of what was sent. A 200 may acknowledge less than was offered,
 *    and a 409 carries the real offset; both are acted on as the number the
 *    server gave.
 *  * **finalize.** The ATTEMPT is durable before the call. A finalize whose
 *    answer is lost may have published the object, so a job carrying that flag
 *    must never open a new session or re-upload — it would create a second
 *    invisible object. It may only ask again.
 */
class CloudInboxUploader(
    private val client: CloudClient,
    private val token: suspend () -> String?,
    private val ttlSeconds: Int,
    private val nowSeconds: () -> Long,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : InboxCiphertextUploader {

    override suspend fun upload(job: InboxSendJob, store: InboxSendStore): InboxSendJob {
        job.storedFileId?.let { return job }

        // BEFORE the token and before the spool.
        //
        // A single-shot publish whose answer was lost leaves a job whose
        // outcome is unknowable, and nothing discovered afterwards can make it
        // knowable again. A missing bearer or a spool that no longer verifies
        // are ordinary definite refusals for a job that has not been sent — but
        // for this one they would REPLACE an uncertain outcome with a confident
        // wrong one, and a definite failure is what invites a retry that could
        // duplicate a hidden object.
        if (job.emptyPublishAttempted && job.storedFileId == null) {
            throw InboxUploadException(ambiguous = true)
        }

        val bearer = token() ?: throw InboxUploadException(ambiguous = false)

        // A finalize was already attempted and its answer never arrived. The
        // object may exist. Asking again is the ONLY safe move: a new session
        // would create a second one.
        if (job.finalizeAttempted) {
            return finalize(job, store, bearer)
        }

        val manifest = store.encManifest(job.jobId)
            ?: throw InboxUploadException(ambiguous = false)
        val spool = store.spool(job.jobId)
        // The spool must be EXACTLY what preparation wrote — length and content.
        // Absence and emptiness are the obvious cases; the one that actually
        // needs a digest is a spool truncated at a frame boundary, which is a
        // well-formed prefix that would upload and finalize cleanly as a smaller
        // object the recipient could never reconcile with its manifest.
        //
        // The identity is bound at preparation, so this compares against
        // something that was never derived from the file being checked.
        val matches = try {
            store.spoolMatches(job)
        } catch (e: CancellationException) {
            throw e
        } catch (e: InboxSendStoreException) {
            throw InboxUploadException(ambiguous = false, e)
        }
        if (!matches) throw InboxUploadException(ambiguous = false)
        val total = job.ciphertextBytes

        // An EMPTY payload cannot go through the resumable route at all.
        //
        // There the object's bytes are the frame stream alone — the sealed
        // manifest travels at `init` and the blob is materialised by the first
        // append — so a delivery with no frames issues no append, the blob is
        // never created, and finalize publishes a task pointing at nothing. A
        // real run produced exactly that: `received=0, done=1`, no object row,
        // and the receiver reporting `stored_object_unavailable`.
        //
        // The single-shot route carries `uint32BE(len) || encManifest` in the
        // request itself, so the object exists even with no frames. Reached
        // ONLY at zero; every other payload takes the path it always took.
        if (total == 0L) return publishEmpty(job, store, bearer, manifest)

        var current = job
        if (current.uploadId == null) {
            val session = try {
                client.initUpload(
                    header = uploadHeader(manifest),
                    burnAfterRead = false,
                    ttlSeconds = ttlSeconds,
                    payloadTotal = total,
                    token = bearer,
                    // Never a share. See the type comment.
                    purpose = StoredUploadPurpose.DEVICE_TASK,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudException) {
                // No task can exist — no create has happened — so the JOB is
                // releasable. What is NOT claimed here is that nothing exists on
                // the server: an init whose answer was lost may have opened a
                // session this process never recorded, and that orphan is
                // reclaimed by its own TTL rather than by anything this code
                // does. Recording the id before appending narrows the window; it
                // does not eliminate it.
                throw InboxUploadException(ambiguous = false, e)
            }
            // Durable BEFORE a byte is appended: a death here must resume this
            // session rather than open a second one.
            current = try {
                store.save(current.copy(uploadId = session.uploadId), nowSeconds())
            } catch (e: InboxSendStoreException) {
                // The session exists on the server and this process cannot
                // remember it. That storage is real and unreachable, so the
                // outcome is reported as uncertain rather than retried blindly.
                throw InboxUploadException(ambiguous = true, e)
            }
        }

        val uploadId = requireNotNull(current.uploadId)
        append(uploadId, spool, total, bearer)

        // The ATTEMPT is durable before the call, so a lost answer cannot be
        // mistaken for "never finalized".
        current = try {
            store.save(current.copy(finalizeAttempted = true), nowSeconds())
        } catch (e: InboxSendStoreException) {
            throw InboxUploadException(ambiguous = false, e)
        }
        return finalize(current, store, bearer)
    }

    /**
     * Append from the SERVER's offset until the whole spool is acknowledged.
     *
     * Never from a local idea of what was sent: a 200 may acknowledge less than
     * was offered — the server caps how much one append commits — and a 409
     * carries the authoritative offset. Both are acted on as the number the
     * server gave.
     */
    private suspend fun append(uploadId: String, spool: File, total: Long, bearer: String) {
        var offset = checkedOffset(
            try {
                client.uploadOffset(uploadId, bearer)
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudException) {
                // A session that is gone may have been finalized by an attempt
                // whose answer was lost, so this is not proof that nothing
                // exists.
                throw InboxUploadException(
                    ambiguous = e.failure.kind == CloudFailure.Kind.UPLOAD_SESSION_GONE, e,
                )
            },
            total,
        )
        val buffer = ByteArray(APPEND_CHUNK)
        // Bounds a server that never converges. A 409 reports an authoritative
        // offset and is a legitimate answer, so a single non-advancing reply is
        // not an error — but a run of them, or two offsets that OSCILLATE, will
        // never finish.
        //
        // A consecutive-stall counter is not enough on its own: 0 -> 8 -> 0 -> 8
        // resets it on every other step and loops forever. So the TOTAL number
        // of appends is bounded too, generously against the honest case — one
        // append per chunk plus slack for legitimate short acknowledgements.
        var stalls = 0
        var appends = 0
        val maxAppends = total / APPEND_CHUNK * 2 + MIN_APPEND_BUDGET
        while (offset < total) {
            if (++appends > maxAppends) {
                throw InboxUploadException(ambiguous = false)
            }
            val read = try {
                withContext(io) {
                    RandomAccessFile(spool, "r").use { file ->
                        file.seek(offset)
                        file.read(buffer, 0, minOf(buffer.size.toLong(), total - offset).toInt())
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: java.io.IOException) {
                // A local read failure is not a network outcome. Typed here, so
                // the caller is not left catching a raw IOException it does not
                // classify — nothing was published by this attempt.
                throw InboxUploadException(ambiguous = false, e)
            }
            if (read <= 0) {
                // The spool is shorter than the session was told. Refusing is the
                // only honest answer: finalizing would publish a truncated
                // object the recipient could never verify.
                throw InboxUploadException(ambiguous = false)
            }
            val acknowledged = try {
                client.patchChunk(uploadId, buffer, read, offset, total, bearer) {}
            } catch (e: CancellationException) {
                throw e
            } catch (e: CloudException) {
                throw InboxUploadException(
                    ambiguous = e.failure.kind == CloudFailure.Kind.UPLOAD_SESSION_GONE, e,
                )
            }
            val received = checkedOffset(acknowledged.received, total)
            // A SUCCESS cannot acknowledge more than was actually offered. A
            // server claiming otherwise is describing bytes this client never
            // sent, and continuing from that number would finalize an object
            // with a hole in it.
            if (!acknowledged.conflict && received > offset + read) {
                throw InboxUploadException(ambiguous = false)
            }
            if (received <= offset) {
                stalls += 1
                if (stalls >= MAX_STALLED_APPENDS) {
                    throw InboxUploadException(ambiguous = false)
                }
            } else {
                stalls = 0
            }
            offset = received
        }
    }

    /**
     * An offset the server reported, checked against the payload it belongs to.
     *
     * The stored transport parses the number but has no idea what this job's
     * spool contains, so the bound belongs here. A negative offset would seek
     * backwards out of the file; one past the end would let the loop finish
     * early and finalize an object that was never fully sent.
     */
    private fun checkedOffset(received: Long, total: Long): Long {
        if (received < 0 || received > total) throw InboxUploadException(ambiguous = false)
        return received
    }

    /**
     * Publish the object, or report honestly that it may already be published.
     *
     * `ALREADY_FINALIZED` carries no object id, so it cannot prove this upload
     * published — and it cannot license a fresh session either. That uncertainty
     * is kept rather than resolved by guessing.
     */
    /**
     * Publish an empty payload as one object, at most once, ever.
     *
     * ## The marker is written before the request, and never cleared
     *
     * A single POST either created an object or did not, and a lost answer —
     * a cancelled call, a dead socket, a body this build cannot parse — cannot
     * tell which. There is no session to re-ask and no offset to resume from,
     * which is precisely what the resumable route has and this does not.
     *
     * So the attempt is recorded durably first. If it does not come back with
     * an id, the job stays UNCERTAIN and no later attempt may POST again: a
     * second request is indistinguishable from the first to the server, and
     * would publish a duplicate object this device cannot name, still billed
     * and still held until its TTL. An ordinary user retry is a re-ask, not a
     * re-publish — the same rule a lost finalize already follows.
     *
     * If the marker cannot be written, nothing is sent at all. Recording the
     * intention is what makes the attempt bounded, so an attempt that could not
     * be recorded must not happen.
     */
    private suspend fun publishEmpty(
        job: InboxSendJob,
        store: InboxSendStore,
        bearer: String,
        manifest: ByteArray,
    ): InboxSendJob {
        // The already-attempted case is refused at the top of `upload`, before
        // anything that could fail definitely. Reaching here means this is the
        // first attempt.
        val marked = try {
            store.save(job.copy(emptyPublishAttempted = true), nowSeconds())
        } catch (e: InboxSendStoreException) {
            // Nothing has been sent, so this is definite and the job is
            // untouched — the one branch here that is safe to retry.
            throw InboxUploadException(ambiguous = false, e)
        }
        val result = try {
            client.uploadEmptyTaskObject(uploadHeader(manifest), ttlSeconds, bearer)
        } catch (e: CancellationException) {
            // Cancelled with the request possibly in flight. The marker stands.
            throw e
        } catch (e: CloudException) {
            // Every outcome here is uncertain by construction: a refusal this
            // build recognises still cannot prove the object was not created,
            // because the answer that says so is the one that went missing.
            throw InboxUploadException(ambiguous = true, e)
        }
        return try {
            store.save(marked.copy(storedFileId = result.id), nowSeconds())
        } catch (e: InboxSendStoreException) {
            // The object EXISTS and this process cannot record which one.
            throw InboxUploadException(ambiguous = true, e)
        }
    }

    private suspend fun finalize(
        job: InboxSendJob,
        store: InboxSendStore,
        bearer: String,
    ): InboxSendJob {
        val uploadId = job.uploadId ?: throw InboxUploadException(ambiguous = false)
        val result = try {
            client.finalizeUpload(uploadId, bearer)
        } catch (e: CancellationException) {
            throw e
        } catch (e: CloudException) {
            throw when (e.failure.kind) {
                // Both mean an object may exist that this process cannot name.
                CloudFailure.Kind.ALREADY_FINALIZED,
                CloudFailure.Kind.UPLOAD_SESSION_GONE,
                -> InboxUploadException(ambiguous = true, e)
                else -> InboxUploadException(ambiguous = true, e)
            }
        }
        return try {
            store.save(job.copy(storedFileId = result.id), nowSeconds())
        } catch (e: InboxSendStoreException) {
            // The object EXISTS and this process cannot record which one. Never
            // definitive: a later attempt must not open a second session.
            throw InboxUploadException(ambiguous = true, e)
        }
    }

    private companion object {
        /** One append's worth. The server caps what a single PATCH commits, and
         *  the loop follows the offset it returns rather than this size. */
        const val APPEND_CHUNK = 1 shl 20

        /** How many CONSECUTIVE non-advancing answers to tolerate. A conflict is
         *  legitimate; an unbroken run of them is not progress. */
        const val MAX_STALLED_APPENDS = 5

        /** Slack on top of one append per chunk, so an honest server that
         *  commits less than was offered still finishes. */
        const val MIN_APPEND_BUDGET = 16L
    }
}
