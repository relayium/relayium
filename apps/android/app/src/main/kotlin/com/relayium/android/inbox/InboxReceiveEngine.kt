package com.relayium.android.inbox

import com.relayium.android.cloud.DurableFiles
import com.relayium.android.cloud.SecretBox
import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxDeviceErrorCode
import com.relayium.protocol.inbox.InboxProtocol
import com.relayium.protocol.inbox.InboxTaskErrorCode
import com.relayium.protocol.inbox.InboxTaskState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/**
 * One pass of the receive loop: say what this device can do, ask whether there
 * is work, take at most ONE task, and report exactly what happened to it.
 *
 * A single BOUNDED pass rather than a resident loop. Scheduling — foreground
 * lifecycle, retry cadence, what the UI shows — is a separate concern; what
 * belongs here is the part where a wrong decision loses a user's file, and that
 * part has to be drivable to completion by a test with no timers in it.
 *
 * What keeps it honest:
 *
 *  * presence is asserted only while this device can actually receive, and an
 *    unusable container is REPORTED rather than papered over;
 *  * nothing is claimed that will not be worked: one task per pass, worked to a
 *    terminal report before another can be taken;
 *  * `saved` is reported only from a completed local publication, and a task
 *    whose journal already says completed is re-reported rather than
 *    re-delivered.
 */
class InboxReceiveEngine(
    private val transport: InboxDeviceTransport,
    private val keys: InboxKeyStoring,
    private val journals: InboxJournalStore,
    private val messages: InboxMessageStore,
    private val container: InboxContainer,
    private val secrets: SecretBox,
    private val files: DurableFiles,
    private val account: InboxAccountId,
    private val policy: () -> InboxAutoAccept,
    private val nowSeconds: () -> Long,
    private val platform: String,
    private val appVersion: String,
    /** Whether THIS build's surface renders a received message as a message.
     *  Answered by the composing layer, never inferred from the platform. */
    private val presentsText: Boolean,
    /** Free space for the preflight and the disk-full requeue, or null when
     *  unknown. Supplied by the composing layer; see [InboxReceiver]. */
    private val freeBytes: () -> Long? = { null },
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /** Every task central currently holds, as read at the top of a pass. The
     *  scheduling shell needs it to render an `ask` question; the engine itself
     *  acts only on the narrow subset [requeueRecovered] describes. */
    private val onPending: (List<InboxTaskRow>) -> Unit = {},
    /** A durable publication, and the only event from which a "saved" claim may
     *  be built. */
    private val onDelivered: suspend (InboxJournal) -> Unit = {},
) {

    /** What one pass established. */
    sealed interface PassResult {
        /** A delivery was worked to a terminal report in this pass. */
        data object Worked : PassResult

        /** Central had nothing for this device. */
        data object Idle : PassResult

        /** This device cannot receive right now, so nothing was claimed. */
        data class NotReceiving(val state: InboxDirectoryState) : PassResult
    }

    /**
     * Enrol and make this account's device key usable. Run once before passes.
     *
     * Returns the key health, which may require an explicit repair — this
     * deliberately does not rotate on its own; see [InboxEnrolment].
     */
    suspend fun prepare(): InboxKeyHealth {
        val state = container.probe(account)
        val result = InboxEnrolment.enrol(
            transport, platform, appVersion,
            InboxCapabilities.announced(presentsText),
            policy(), state.canReceive,
        )
        return InboxEnrolment.ensureUsableKey(
            transport, keys, account, result.inbox.key, nowSeconds(),
        )
    }

    /**
     * Tell central this device is no longer taking deliveries.
     *
     * NOT optional politeness. Central keeps the last policy a device
     * announced, so a device whose owner switched receiving off would go on
     * being offered as a target: the sender's UI would accept the send, the task
     * would queue, and it would sit there until it expired. Announcing `off`
     * makes central refuse the send outright, which is the truthful answer.
     */
    suspend fun announceStopped() {
        val state = container.probe(account)
        InboxEnrolment.enrol(
            transport, platform, appVersion,
            InboxCapabilities.announced(presentsText),
            policy(), state.canReceive,
        )
        // Presence is a claim about NOW, and this device is about to stop
        // polling. A sender watching an "online" device that is not listening is
        // exactly the misleading state this avoids.
        transport.goOffline()
    }

    /** Answer a task central is holding under the `ask` policy. The ONLY way a
     *  held task is resolved — nothing in this engine answers for the user. */
    suspend fun respond(taskId: String, accept: Boolean) {
        transport.accept(taskId, accept)
    }

    /** One pass. */
    suspend fun pass(): PassResult {
        currentCoroutineContext().ensureActive()
        val state = container.probe(account)

        // The default-off policy is enforced HERE, at the boundary, and not
        // only by central refusing to queue. Central's record of this device's
        // policy can be stale — an enrolment that has not been sent yet, a
        // switch flipped a moment ago — and a device that claimed on the
        // strength of that would write to the user's storage on a permission
        // they had already withdrawn. No heartbeat, no poll, no claim.
        if (policy() == InboxAutoAccept.OFF) return PassResult.NotReceiving(state)

        // Presence is a claim about NOW, and it carries the container verdict
        // this pass just measured — a real create-and-remove, not an inspection
        // of permission bits.
        transport.heartbeat(state.canReceive)

        val pending = transport.pending(InboxProtocol.CLAIM_BATCH)
        onPending(pending)
        if (pending.isEmpty()) {
            // Housekeeping must not end the loop: a journal that cannot be
            // pruned is inert, and stopping here would stop receiving.
            try {
                journals.prune(nowSeconds())
            } catch (e: CancellationException) {
                throw e
            } catch (e: InboxJournalException) {
                // retained; the next pass tries again
            }
            return if (state.canReceive) PassResult.Idle else PassResult.NotReceiving(state)
        }

        // A container verdict is NOT the claim gate, and that is the point of a
        // v3 receiver: a message is committed to the protected message store and
        // never to the container, so an unusable container must not stop one
        // from landing. The pass goes on to claim; the receiver decodes the
        // manifest, decides the kind, and only a FILE delivery reports
        // `directory_unavailable`.
        requeueRecovered(pending, state)

        val claimed = transport.claim(InboxProtocol.CLAIM_BATCH)
        val delivery = claimed.deliveries.firstOrNull()
            // Pending said there was work but the claim leased none: another
            // worker took it, or it expired between the two calls. Not an error.
            ?: return if (state.canReceive) PassResult.Idle else PassResult.NotReceiving(state)

        val receiver = InboxReceiver(
            transport = transport, keys = keys, journals = journals, messages = messages,
            container = container, secrets = secrets, files = files, account = account,
            nowSeconds = nowSeconds, root = state.directoryOrNull,
            renewIntervalSeconds = maxOf(1L, claimed.leaseSeconds / 3L),
            freeBytes = freeBytes, io = io,
        )

        try {
            receiver.deliver(delivery)
            try {
                journals.load(delivery.task.id)?.let { onDelivered(it) }
            } catch (e: InboxJournalException) {
                // The delivery is published; only the notification is lost.
            }
            reportSaved(delivery)
        } catch (e: CancellationException) {
            // A policy change, sign-out or account switch owns this
            // cancellation. Reporting it as a device failure would mutate
            // central under a generation the user already ended.
            throw e
        } catch (e: InboxAbandon) {
            // Central already took the task away. Silence is the only safe
            // answer: a report would mutate a task another worker now holds.
        } catch (e: InboxFailure) {
            report(delivery, e.state, e.code)
        } catch (e: Throwable) {
            // Durable-storage and journal failures reach here as themselves.
            // Central is told something truthful and the pass ends normally:
            // letting one escape would kill the receive loop silently, and
            // saying nothing would leave the task leased until its lease
            // expired.
            report(delivery, InboxTaskState.FAILED_RETRYABLE, storageCode(e))
        }
        return PassResult.Worked
    }

    /**
     * Assert the commit, then record that central acknowledged it.
     *
     * The journal is what makes this idempotent across a lost response: it
     * already says completed, so a re-claimed task skips straight back to here
     * rather than downloading and publishing a second time.
     */
    private suspend fun reportSaved(delivery: InboxDelivery) {
        // `saved` is reachable only from `verifying`, so assert that first.
        // Reporting the state a task is already in is an idempotent no-op, which
        // is what makes this safe on a retry.
        for (state in listOf(InboxTaskState.VERIFYING, InboxTaskState.SAVED)) {
            val task = try {
                transport.report(
                    delivery.task.id, delivery.claimToken, state,
                    InboxDeviceErrorCode.NONE, committed = state == InboxTaskState.SAVED,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Includes `task_terminal`, which is NOT proof that central
                // stored `saved`: it is equally what expiry, revocation and a
                // terminal failure answer. Acknowledgement is withheld rather
                // than assumed — the local journal keeps the delivery as history
                // either way, so nothing the user received is lost by being
                // careful here.
                return
            }
            if (state == InboxTaskState.SAVED) {
                // Only central's own `saved`, for THIS task, closes the report.
                if (task.id == delivery.task.id && task.state == InboxTaskState.SAVED) {
                    markSavedReported(delivery.task.id)
                }
                return
            }
        }
    }

    /** Record central's acknowledgement, without letting a storage failure end
     *  the pass: the delivery itself is already published. */
    private suspend fun markSavedReported(taskId: String) {
        try {
            journals.markSavedReported(taskId, nowSeconds())
        } catch (e: CancellationException) {
            throw e
        } catch (e: InboxJournalException) {
            // The acknowledgement is bookkeeping; the files are real. A later
            // pass re-reports rather than re-delivering.
        }
    }

    /**
     * The closed code that best describes a local storage failure.
     *
     * Deliberately narrow: an unrecognised failure is `internal` rather than a
     * guess, because a wrong code sends the user to fix something that is not
     * broken.
     */
    private fun storageCode(e: Throwable): InboxDeviceErrorCode = when {
        e is InboxCommitException && e.reason == InboxCommitException.Reason.NAME_CONFLICT ->
            InboxDeviceErrorCode.NAME_CONFLICT
        e is InboxCommitException && e.reason == InboxCommitException.Reason.DISK_FULL ->
            InboxDeviceErrorCode.DISK_FULL
        e is InboxCommitException && e.reason == InboxCommitException.Reason.PERMISSION_DENIED ->
            InboxDeviceErrorCode.PERMISSION_DENIED
        else -> InboxDeviceErrorCode.INTERNAL
    }

    private suspend fun report(
        delivery: InboxDelivery,
        state: InboxTaskState,
        code: InboxDeviceErrorCode,
    ) {
        try {
            transport.report(delivery.task.id, delivery.claimToken, state, code, false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            // Nothing further to say: central's own lease expiry will requeue.
        }
    }

    /**
     * Re-queue the `attention_required` tasks this device parked for a local
     * blocker that has now cleared.
     *
     * Deliberately narrow. Disk space is decided per task, because a readiness
     * probe can succeed while a particular delivery still does not fit. And a
     * task held under the `ask` policy carries NO error code at all —
     * auto-accepting one would be this machine answering a question that was
     * asked of its owner, which is the single thing the ask policy exists to
     * prevent.
     */
    private suspend fun requeueRecovered(tasks: List<InboxTaskRow>, state: InboxDirectoryState) {
        if (policy() != InboxAutoAccept.AUTO) return
        val free = freeBytes()
        for (task in tasks) {
            if (task.state != InboxTaskState.ATTENTION_REQUIRED) continue
            val code = task.errorCode
            val clear = when {
                code == InboxTaskErrorCode.Device(InboxDeviceErrorCode.DISK_FULL) ->
                    free == null || free >= task.ciphertextBytes
                code == InboxTaskErrorCode.Device(InboxDeviceErrorCode.PERMISSION_DENIED) ||
                    code == InboxTaskErrorCode.Device(InboxDeviceErrorCode.DIRECTORY_UNAVAILABLE) ->
                    state.canReceive
                // No error code at all under `auto` is a task central parked
                // because this device last reported an unusable container. Its
                // KIND is sealed, so the only way to find out whether it even
                // needs one is to claim it: a message then commits, and a file
                // delivery is re-parked with a truthful code.
                code.isNone -> true
                else -> false
            }
            if (!clear) continue
            try {
                transport.accept(task.id, true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Best effort: the next pass tries again.
            }
        }
    }
}
