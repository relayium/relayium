package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxAutoAccept
import com.relayium.protocol.inbox.InboxManifestKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.coroutineContext

/**
 * The Inbox surface's state, and the authority that decides whether a result may
 * still be published.
 *
 * ## Why every await needs a fence
 *
 * Nearly everything here suspends: a device list, a pass, a repair, a send. An
 * account can be switched, or the user can sign out, while any of them is in
 * flight — and the answer that arrives afterwards belongs to a session that has
 * ended. Publishing it would show one account's devices under another's, or
 * report a delivery to a person who is no longer signed in.
 *
 * So an [Authority] is captured before each operation and re-checked AFTER every
 * suspension, including after durable writes and before any external side effect
 * or UI publish. A stale operation may finish its own cleanup; it may not speak.
 *
 * ## Why refusing to publish is not enough
 *
 * A superseded body that is merely refused at [publish] is still RUNNING: it can
 * be inside a durable write, a report to central, or an upload carrying the
 * previous account's bearer. So [adopt] additionally cancels the work it owns and
 * JOINS it before the new authority exists, and [ensureCurrent] gives a body an
 * explicit fence to place after each await and before each external side effect.
 */
class InboxModel(
    private val scope: CoroutineScope,
    private val nowSeconds: () -> Long,
) {

    /**
     * Who a running operation belongs to.
     *
     * The generation is what makes this a fence rather than a comparison: an
     * account that is signed out and back in is a NEW authority, so results from
     * the first session cannot be mistaken for the second's just because the
     * account id matches.
     */
    data class Authority(val account: InboxAccountId, val generation: Int)

    /** What the surface renders. Every field is derived from state this model
     *  owns, so a stale operation cannot leave half of it behind. */
    data class State(
        val authority: Authority? = null,
        val policy: InboxAutoAccept = InboxAutoAccept.OFF,
        val directory: InboxDirectoryState? = null,
        val keyHealth: InboxKeyHealth? = null,
        val devices: List<InboxSendTarget> = emptyList(),
        val blockedDevices: List<Pair<InboxDeviceRow, InboxTargetBlock>> = emptyList(),
        /**
         * The subset of [devices] that announced they can present a MESSAGE.
         *
         * Offering "send text" to a device that would write a file named like
         * one is the dishonest half of this feature, so the control is hidden
         * rather than allowed to produce a `.txt` facsimile.
         */
        val textCapableDevices: Set<String> = emptySet(),
        val conversations: List<InboxConversation> = emptyList(),
        /** Tasks central is holding for a person on THIS device to answer. */
        val awaitingAnswer: List<InboxTaskRow> = emptyList(),
        val loading: Boolean = false,
        val failure: Failure? = null,
        /**
         * A first refresh has completed under this authority.
         *
         * Kept apart from `loading` because the two render differently: before
         * the first answer there is nothing to show and the screen is a
         * placeholder; afterwards a refresh must not blank a list the user is
         * reading.
         */
        val ready: Boolean = false,
        /** What this device is ACTUALLY doing about deliveries, as opposed to
         *  what its policy permits. See [InboxReceiving]. */
        val receiving: InboxReceiving = InboxReceiving.OFF,
        /** Outgoing jobs that are staged or in flight. Terminal ones live in
         *  [conversations] instead. */
        val sends: List<InboxSendStatus> = emptyList(),
        /** This device's name as central knows it, once the current row is
         *  resolved. Null until then; never guessed from the first row. */
        val deviceName: String? = null,
        /** A key repair is running. It is destructive enough to confirm, and
         *  slow enough to need its own progress. */
        val repairing: Boolean = false,
        /** Tasks whose accept/decline is in flight, so a control cannot be
         *  double-answered. */
        val answering: Set<String> = emptySet(),
    ) {
        /** Closed, so a surface renders a named condition rather than a string
         *  that came from somewhere it cannot vouch for. */
        enum class Failure {
            NETWORK,
            SIGNED_OUT,
            STORAGE,
            LEDGER_FULL,
            KEY_REPAIR_UNAVAILABLE,

            /**
             * Central selected a protocol version, receive capability or key
             * algorithm this build cannot honour.
             *
             * Its own case because its only remedy is a newer app. Rendering it
             * as a storage or network problem would send the user to fix
             * something that is not broken.
             */
            UNSUPPORTED_BUILD,

            /** A response this build refuses to trust — a shape, an identity or
             *  a bound it cannot accept. Distinct from a network failure: a
             *  retry against the same server produces the same answer. */
            PROTOCOL,
        }
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** Serialises the model's own transitions, so two operations cannot
     *  interleave a read-modify-write of the published state. */
    private val lock = Mutex()

    /**
     * Serialises WHOLE adoptions.
     *
     * [lock] alone is not enough: an adoption suspends in the middle, to join
     * the work it is ending, and two adoptions interleaving there would each
     * finish under the other's authority — the first would return the second's
     * session, and its caller would pair that authority with the first
     * account's bearer.
     */
    private val adoption = Mutex()

    private var generation = 0

    /** Volatile because [launchOwned] reads it without suspending, and a body
     *  fences on it between awaits. */
    @Volatile
    private var current: Authority? = null

    /** Work started under an authority, so it can be ended when that authority
     *  is. Guarded by its own monitor rather than by [lock]: registration must
     *  not suspend, and a body waiting for [lock] must not block a cancel. */
    private val owned = ArrayList<Pair<Authority, Job>>()

    /**
     * Adopt an account, ending every operation that belonged to the previous
     * one.
     *
     * The generation advances even when the SAME account is adopted again: a
     * sign-out and sign-in is a new session, and a result from the old one must
     * not land in it.
     *
     * The order matters. The generation advances FIRST, under the lock, so a
     * body that is between awaits can no longer publish or pass [ensureCurrent];
     * the cancel-and-join then happens OUTSIDE the lock, because a body
     * suspended in [publish] would otherwise be waiting for a lock this call
     * holds while this call waits for that body.
     */
    suspend fun adopt(account: InboxAccountId?): Authority? = adoption.withLock {
        // 1. Invalidate FIRST. Nothing is current while the old work is being
        //    ended, so a body between awaits can neither publish nor pass
        //    `ensureCurrent`, and a `launchOwned` racing this cannot register.
        val ending = lock.withLock {
            generation += 1
            current = null
            // Cleared wholesale rather than filtered: one account's devices,
            // conversations and pending questions must not survive into
            // another's view because a later refresh happened to overwrite only
            // some of them.
            _state.value = State()
            superseded()
        }

        // 2. Cancel EVERY superseded job before joining any of them, and join
        //    outside the lock — a body suspended in `publish` is waiting for a
        //    lock this call would otherwise hold while it waits for that body.
        //    Cancel-then-join in two passes because a cancellation delivered
        //    only when the previous join returns leaves later jobs running
        //    under an authority that is already gone. A body that adopts from
        //    inside its own owned job cannot join itself.
        val self = coroutineContext[Job]
        for (job in ending) {
            if (job !== self) job.cancel()
        }
        for (job in ending) {
            if (job !== self) job.join()
        }

        // 3. Only now does the new authority exist. Returned as the LOCAL value:
        //    a concurrent adoption cannot make this call answer with a session
        //    its caller never asked for.
        val authority = account?.let { Authority(it, generation) }
        lock.withLock {
            // Nothing else writes `current` while this adoption holds the gate;
            // the check is here so a future caller that breaks that invariant
            // fails loudly rather than silently installing a second session.
            check(current == null) { "an adoption was overtaken" }
            current = authority
            _state.value = State(authority = authority)
        }
        authority
    }

    /** The authority a new operation belongs to, or null when signed out. */
    fun authority(): Authority? = current

    /** Whether [authority] is still the live one. Checked after every await. */
    fun isCurrent(authority: Authority): Boolean = current == authority

    /**
     * Stop here unless [authority] is still live.
     *
     * The explicit fence a body places after an await and before an external
     * side effect — a durable write, a report to central, an upload. Throwing
     * cancellation rather than returning a flag is deliberate: an ignored return
     * value is how a stale body goes on to use a bearer that has been replaced.
     */
    fun ensureCurrent(authority: Authority) {
        if (current != authority) throw InboxSupersededException()
    }

    /**
     * Run [body] and publish its result only if this authority is still live.
     *
     * The job is registered, so [adopt] can end it rather than merely refusing
     * its answer. A body that starts after its authority has already been
     * superseded does not run at all.
     */
    fun launchOwned(authority: Authority, body: suspend () -> Unit): Job {
        // LAZY, so registration happens BEFORE the first instruction runs.
        // Started eagerly, a body on an immediate dispatcher — or on another
        // thread — could complete its first side effect before an adoption that
        // is draining the registry could ever see it.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            ensureCurrent(authority)
            try {
                body()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                publish(authority) { it.copy(loading = false, failure = classify(e)) }
            }
        }
        // The currency check and the registration are ONE atomic step against
        // the same monitor an adoption drains under: either this job is in the
        // registry and will be cancelled, or the authority is already gone and
        // it never starts.
        val admitted = synchronized(owned) {
            if (current != authority) {
                false
            } else {
                owned.add(authority to job)
                true
            }
        }
        if (!admitted) {
            job.cancel()
            return job
        }
        job.invokeOnCompletion {
            synchronized(owned) { owned.removeAll { (_, registered) -> registered === job } }
        }
        job.start()
        return job
    }

    /**
     * The jobs of superseded authorities.
     *
     * Deliberately NOT removed here. Ownership is released when a job actually
     * COMPLETES — see the registration in [launchOwned] — because an adoption
     * can itself be cancelled while it is joining, and a host that cancels a
     * `LaunchedEffect` does exactly that. A registry emptied at the start of an
     * adoption would then hold nothing for the NEXT adoption to wait on, and
     * that adoption would publish a new authority while the old work was still
     * inside its uncancellable cleanup.
     */
    private fun superseded(): List<Job> = synchronized(owned) {
        owned.filter { (authority, _) -> authority != current }.map { it.second }
    }

    /**
     * Apply [change] to the published state, or drop it.
     *
     * Every write to the surface goes through here, so "a stale operation cannot
     * speak" is a property of the one function rather than of whoever remembered
     * to check.
     */
    suspend fun publish(authority: Authority, change: (State) -> State): Boolean =
        lock.withLock {
            if (current != authority) return@withLock false
            val next = change(_state.value)
            // The authority is never rewritten by a change: an operation may
            // update what it learned, not who it belongs to.
            _state.value = next.copy(authority = authority)
            true
        }

    /** Classify a failure into the closed set a surface can render. */
    fun classify(e: Throwable): State.Failure = when {
        e is InboxConversationException &&
            e.reason == InboxConversationReason.FULL -> State.Failure.LEDGER_FULL
        e is InboxConversationException -> State.Failure.STORAGE
        e is InboxKeyStoreException -> State.Failure.STORAGE
        e is InboxJournalException -> State.Failure.STORAGE
        e is InboxSendStoreException -> State.Failure.STORAGE
        e is InboxMessageException -> State.Failure.STORAGE
        e is InboxApiException && e.status == 401 -> State.Failure.SIGNED_OUT
        // "Upgrade or stop", and a document this build refuses to trust. Neither
        // is a storage problem and neither is fixed by retrying.
        e is InboxEnrolmentException -> State.Failure.UNSUPPORTED_BUILD
        e is InboxWireException -> State.Failure.PROTOCOL
        e is InboxApiException -> State.Failure.PROTOCOL
        e is InboxTransportException -> State.Failure.NETWORK
        else -> State.Failure.STORAGE
    }

    /**
     * Sort a device list into what may be sent to and what may not, keeping the
     * REASON for each refusal.
     *
     * Blocked devices are shown rather than hidden: each block has a different
     * remedy — clear a revocation over there, turn receiving on over there,
     * update that build — and a picker that silently omitted them would leave a
     * user wondering where their device went.
     */
    fun partition(rows: List<InboxDeviceRow>): Pair<List<InboxSendTarget>, List<Pair<InboxDeviceRow, InboxTargetBlock>>> {
        val sendable = ArrayList<InboxSendTarget>()
        val blocked = ArrayList<Pair<InboxDeviceRow, InboxTargetBlock>>()
        for (row in rows) {
            if (row.isCurrent) continue
            val availability = InboxTargetEligibility.availability(row)
            val target = InboxTargetEligibility.target(row)
            if (target != null) sendable.add(target)
            else availability.block?.let { blocked.add(row to it) }
        }
        return sendable to blocked
    }
}

/** A body was superseded by an account switch or a sign-out. Cancellation rather
 *  than a failure: nobody is waiting for its answer any more. */
class InboxSupersededException : CancellationException("relayium inbox: superseded")

/**
 * What this device is doing about deliveries RIGHT NOW.
 *
 * Distinct from the policy on purpose. A device whose owner chose `auto` still
 * receives nothing while the app is not running, and a surface that showed the
 * policy as if it were the behaviour would be promising background delivery this
 * app does not provide.
 */
enum class InboxReceiving {
    /** The policy is off. No heartbeat, no poll, no claim. */
    OFF,

    /** Receiving is permitted, but this app is not running the loop — it is not
     *  in the foreground, or it has been stopped. */
    STOPPED,

    /** The loop is running and central has nothing to deliver. */
    LISTENING,

    /** A delivery is being worked right now. */
    RECEIVING,

    /** The loop is running but this device cannot write to its received
     *  container, so nothing is being claimed. The reason is in
     *  [InboxModel.State.directory]. */
    UNAVAILABLE,
}

/**
 * An outgoing job as the surface sees it.
 *
 * Built from the durable job rather than from an in-memory intention, so a
 * relaunch shows the same set. There is no byte progress here, and that is
 * deliberate: the uploader reports none, and a percentage this layer invented
 * would be a number about the user's transfer that nothing measured.
 */
data class InboxSendStatus(
    val jobId: String,
    val targetDeviceId: String,
    val kind: InboxManifestKind,
    /** Relative names as staged. Plaintext-derived and LOCAL. */
    val names: List<String>,
    val totalBytes: Long,
    val phase: Phase,
    /** Why the last attempt stopped, when it did. Live state, not history. */
    val stop: InboxSendCoordinator.Result.Reason? = null,
    /**
     * The last attempt may or may not have created a delivery.
     *
     * Surfaced, because it changes what the user is told: "it did not send" is a
     * claim this app cannot make about an ambiguous outcome, and a retry of the
     * same job is safe precisely because central converges it.
     */
    val ambiguous: Boolean = false,
    /**
     * The UPLOAD's outcome is unknown, and repeating it would not resolve it.
     *
     * A separate flag rather than a shade of [ambiguous], because the two lead
     * to opposite advice. An unresolved create is converged by central: the
     * same request answers with the same delivery, so the honest thing to tell
     * the user is to try again. An unresolved single-shot object publish has no
     * such identity — a repeat is a NEW request that can leave a second object
     * behind and still not say what became of the first — so there is nothing
     * safe to offer, and offering it anyway is how a surface turns "we do not
     * know" into an action that cannot ever produce an answer.
     */
    val uploadUnknown: Boolean = false,
    val taskId: String? = null,
) {
    /** No names, no bytes: this reaches failure text. */
    override fun toString(): String =
        "InboxSendStatus(job=$jobId, $kind/$phase, files=${names.size})"

    enum class Phase {
        /** Prepared and durable; nothing has been sent. */
        STAGED,

        /** An attempt is running now. */
        SENDING,

        /** Central holds exactly one task for it. */
        DELIVERED,

        /** The attempt stopped. See [stop] and [ambiguous]. */
        STOPPED,
    }
}
