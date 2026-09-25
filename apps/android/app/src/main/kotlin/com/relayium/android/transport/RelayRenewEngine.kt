package com.relayium.android.transport

import com.relayium.protocol.Crypto
import com.relayium.protocol.Json
import com.relayium.protocol.RelayRenewPolicy
import com.relayium.protocol.RelayRenewProbe
import com.relayium.protocol.RelayRenewSdp
import com.relayium.protocol.RelayRenewWire

/**
 * The `relay-renew/1` epoch machine for one link.
 *
 * Owns the round exchange, the signed link messages, the ICE restart, the
 * candidate binding, the data-path probe and the commit rule — and nothing
 * else. It holds no `org.webrtc` type, no socket and no clock: everything it
 * touches arrives through [Deps], so the whole state machine, every bound and
 * every refusal runs under plain JVM tests against recording fakes.
 *
 * ## Ownership, and why there is no verification queue
 *
 * Every method runs on the controller's single session executor. There is no
 * lock and no atomic here, and there must not be: [close] is the fence, and a
 * callback that lands after it finds `closed` and returns before any effect.
 *
 * That also settles a hazard the wire has to name for ports where it is real.
 * An implementation whose HMAC is asynchronous can be mid-verification when the
 * next frame arrives, and dropping that frame loses exactly the ack that would
 * have committed a migration — so it needs a single-slot holder to drain
 * afterwards. Here `Crypto.verifyAuth` is synchronous and this thread is
 * serial: verification is never "busy" from the point of view of the next
 * frame, because the next frame cannot be delivered until this one is done.
 * The bounds that remain real are the BUDGETS, and those are enforced
 * explicitly below.
 *
 * ## What it will not do
 *
 * It never extends a deadline it already has. It receives a configuration,
 * derives a boundary from THAT configuration, and publishes it only after the
 * migration is proved — local observation of the selected candidate's
 * generation, plus a fresh ack for this side's own nonce arriving after that
 * observation held. Every other outcome, including every failure, leaves the
 * old boundary exactly as it was.
 */
class RelayRenewEngine(private val deps: Deps) {

    /** A scheduled task that can be cancelled. */
    fun interface Timer {
        fun cancel()
    }

    /** The one scheduling primitive. Injected so a test owns its own clock. */
    fun interface Timers {
        fun schedule(delayMs: Long, task: () -> Unit): Timer
    }

    /** What the UI may say. Never "renewed" before a section 6.5 commit. */
    enum class State {
        /** Nothing in flight; the link's existing boundary stands. */
        IDLE,

        /** An epoch is in flight. */
        RENEWING,

        /** A migration committed and the boundary moved. */
        RENEWED,

        /** The server refused this round; the old boundary stands. */
        DENIED,

        /** The peer does not implement renewal. */
        UNSUPPORTED,

        /** An epoch ended without committing; the old boundary stands. */
        FAILED,
    }

    interface Deps {
        fun now(): Long
        fun timers(): Timers
        fun selfId(): String
        fun peerId(): String

        /** The link's established initiator sends the offer, so a migration
         *  cannot turn two peers into two offerers. */
        fun isInitiator(): Boolean

        fun keys(): Crypto.SessionKeys?
        fun transport(): RenewTransport?

        /** Whether the peer ANNOUNCED `relay-renew/1`. An unsigned hint: it
         *  gates whether an epoch is worth spending and confers no authority. */
        fun peerSupportsRenew(): Boolean

        /** Whether real user data has moved recently. The consent gate. */
        fun userActive(): Boolean

        /** Put one signed renewal envelope on the room socket, addressed to the
         *  established peer. */
        fun sendRenew(data: Json)

        /**
         * Ask the room's server for one round.
         *
         * False means this rendezvous has NO server to ask — the local,
         * backend-free one. That is a structural answer, not a policy one: a
         * LAN or direct session makes no backend call, and cannot, because the
         * handle it holds has no such method.
         */
        fun requestRound(round: Long, rid: Long): Boolean

        fun randomBytes(count: Int): ByteArray
        fun randomUint32(): Long

        /**
         * A renewed configuration was APPLIED to the live `PeerConnection`.
         *
         * Reported at apply time, not at commit: from that moment the
         * connection is running on those servers whatever the migration goes on
         * to do, and the owner's later path classification and boundary
         * derivation must read THEM rather than the configuration the room was
         * originally issued. Retained by the owner for the life of the link,
         * outliving the short post-commit window.
         */
        fun onConfigurationInstalled(servers: List<IceConfig.Server>)

        /**
         * The renewal state changed.
         *
         * [commit] is non-null only for an actual section 6.5 commit, and it
         * says what that commit did to the boundary — which is NOT the same
         * question as whether a migration succeeded.
         */
        fun onRenewState(state: State, commit: Commit?)
    }

    /**
     * What a commit did to the link's credential boundary.
     *
     * Three outcomes, and they are genuinely different:
     *
     *  - a migration onto a NEW round's credential moves the boundary to the
     *    one that credential states ([boundaryMoved] true, [deadline] set);
     *  - a migration onto a DIRECT path releases the boundary entirely, exactly
     *    as the existing rule does for a link that was direct from the start
     *    ([boundaryMoved] true, [deadline] null);
     *  - a SAME-ROUND repair re-establishes the path on the credential this
     *    side had already installed. The migration is real and the UI may say
     *    so, but nothing about the boundary changed and re-arming it would
     *    silently extend a credential on no new authority at all
     *    ([boundaryMoved] false).
     */
    data class Commit(
        val deadline: RelayRenewPolicy.Deadline?,
        val boundaryMoved: Boolean,
    )

    // ── link-level counters, which outlive every attempt ────────────────────

    /**
     * The highest epoch this link has ever begun or adopted.
     *
     * Strictly monotonic and NEVER reused. A `prepare` at or below it is
     * refused even when nothing is in flight, which is the difference between
     * "no attempt is running" and "this epoch is available again": without it,
     * a replayed `prepare` for a completed or aborted epoch would begin a fresh
     * attempt under signed messages the peer has already spent, which is
     * exactly what a fresh epoch per retry exists to prevent.
     */
    private var highestSpentEpoch = 0L

    /** The server round this link is currently bounded by. 0 is the original
     *  grant; the first renewal asks for 1. */
    private var round = 0L

    /**
     * Migration epochs spent, KEYED BY THE CREDENTIAL ROUND they were spent on.
     *
     * The three-per-round budget belongs to an actual issued credential, so it
     * has to be accounted per round rather than as one running total. A single
     * counter gets both directions wrong at once:
     *
     *  - committing a round looked like a good moment to start the next
     *    round's budget, which REFUNDED every attempt made under the credential
     *    just committed — the successful one and each prior failure alike. A
     *    link could then spend three more epochs on a round it had already
     *    finished with, which is the unbounded series of extensions the budget
     *    exists to prevent.
     *  - and the same counter, unreset, let round 1's spending block a
     *    perfectly legitimate round 2 — a round the server had never issued a
     *    single migration for.
     *
     * An epoch is charged EXACTLY ONCE, at the moment a configuration is
     * accepted or adopted, and is never refunded: not when it aborts, not when
     * a higher prepare supersedes it, and not when it commits. Epochs that died
     * before any configuration was issued are a different thing and live on
     * [pregrantAttempts].
     */
    private val migrationEpochs = LinkedHashMap<Long, Int>()

    /**
     * Epochs that ended before any configuration was issued.
     *
     * Separately bounded, and naturally bounded twice over besides: every retry
     * waits [RelayRenewPolicy.RETRY_BACKOFF_MS], and none may start past the
     * boundary the link already has.
     */
    private var pregrantAttempts = 0

    private var roundDenied = false
    private var peerUnsupported = false
    private var retryNotBefore = 0L
    private var closed = false

    /**
     * The round whose configuration is ACTUALLY applied to this
     * `PeerConnection`, and that configuration.
     *
     * Written when `setConfiguration` succeeds, not when a migration commits:
     * the connection is running on those servers either way, and a later repair
     * has to be able to say "I already hold exactly this round's credential".
     * Kept for the life of the link, deliberately outliving the post-commit ack
     * window — that window bounds who may still be answered, not what is
     * installed.
     */
    private var installedRound: Long? = null
    private var installedServers: List<IceConfig.Server> = emptyList()

    /**
     * HMACs this link will spend verifying a `prepare` while NOTHING is in
     * flight.
     *
     * Outside an attempt a `prepare` is the only message that can be acted on,
     * and its epoch gate admits any value above [highestSpentEpoch] — so
     * without a budget, an unlimited walk up the epoch space would buy one
     * verification per frame. A conforming peer spends at most six per round
     * (three epochs, one retry each); refilled when a round advances.
     */
    private var idleSignalBudget = IDLE_SIGNAL_BUDGET

    private var attempt: Attempt? = null
    private var committed: Committed? = null

    /** The boundary this link is currently bounded by, or null when nothing
     *  relays. Handed in by the owner, never invented here. */
    private var deadline: RelayRenewPolicy.Deadline? = null

    private var tickTimer: Timer? = null
    private var state = State.IDLE

    /** rid -> the round it asked about. Bounded; see [MAX_INFLIGHT_ROUNDS]. */
    private val pendingRounds = LinkedHashMap<Long, Long>()

    /**
     * The last selected pair the platform ACTUALLY reported.
     *
     * A single slot, always the latest real event, and never a guess derived
     * from whatever SDP happens to be current. It exists because the two facts
     * an observation needs — the pair, and both of the epoch's descriptions
     * being applied — arrive in either order: an ICE restart can settle on its
     * new pair before the answer has been processed, and an implementation that
     * only tested the pair at arrival would discard the very observation it was
     * waiting for.
     *
     * Retaining it is safe precisely BECAUSE the test is the candidate's own
     * ufrag: a pair cached from an earlier generation fails that test and
     * proves nothing, which is asserted rather than argued.
     */
    private var lastSelectedPair: RenewTransport.SelectedPair? = null

    // ── the owner's inputs ──────────────────────────────────────────────────

    /**
     * The link's credential boundary, or null when nothing bounds it.
     *
     * Called when the owner classifies the selected path as relayed, and again
     * with null if it ever classifies as direct. A null boundary is a complete
     * stop: no tick, no round request, no epoch — which is what "Nearby and LAN
     * make no backend call" means structurally rather than as a rule somebody
     * has to remember.
     */
    fun bindDeadline(bound: RelayRenewPolicy.Deadline?) {
        if (closed) return
        deadline = bound
        armTick()
    }

    /** Real user data moved. Re-evaluate, because the margin is a window and
     *  not a moment: a conversation that resumes at minute 55 of a one-hour
     *  grant must still be able to renew. */
    fun noteUserData() {
        if (closed) return
        tick()
    }

    /**
     * One selected-pair observation from the platform.
     *
     * RETAINED first, evaluated second. The evaluation can legitimately fail
     * today and succeed a moment later — an ICE restart may settle on its new
     * pair before the answer has been applied — so throwing the event away on
     * a failed test would discard the observation the epoch is waiting for and
     * leave it to time out against a path that had already migrated.
     */
    fun onSelectedPair(pair: RenewTransport.SelectedPair) {
        if (closed) return
        lastSelectedPair = pair
        attempt?.let { evaluateObservation(it) }
    }

    /**
     * Does the pair this side last actually saw prove THIS epoch's path?
     *
     * Called on a new event and again once both of the epoch's descriptions are
     * applied, because either can be the thing that was missing.
     */
    private fun evaluateObservation(a: Attempt) {
        if (a.observed) return
        val pair = lastSelectedPair ?: return
        // BOTH of this epoch's descriptions must be applied before observation
        // may begin. An offerer that has restarted ICE but holds no answer yet
        // can form a pair whose far end is still entirely on the previous
        // generation — which would satisfy the local clause against a
        // half-migrated transport.
        if (!a.remoteApplied || a.remoteUfrag.isEmpty() || a.localUfrag.isEmpty()) return
        // The SELECTED LOCAL candidate must demonstrably belong to this epoch's
        // ufrag generation. Not "the port changed", not an open DataChannel,
        // not a `connected` state. A pair cached from an earlier generation
        // fails HERE, which is what makes retaining it safe.
        if (!RelayRenewSdp.localCandidateBelongsTo(pair.local, a.localUfrag)) return
        // The SDK can discover a local peer-reflexive address while checking
        // against the old remote allocation. Publish that actual address so the
        // peer can also check it from its new allocation, which RFC 8445
        // permits in section 7.2.5, subsection 3.1.
        // Discovery alone does not satisfy the remote-generation proof below.
        if (RelayRenewSdp.candidateType(pair.local) == "prflx") {
            val mid = deps.transport()?.baselinePin()?.mids?.singleOrNull()
            if (mid != null && a.signaledReflexiveCandidates.size < RelayRenewWire.MAX_HELD_CANDIDATES &&
                a.signaledReflexiveCandidates.add(pair.local)
            ) {
                onLocalCandidate(a, RenewTransport.Candidate(pair.local, mid, 0))
            }
        }
        // Where the platform states the REMOTE candidate too — and this one
        // does, because `CandidatePairChangeEvent` carries both — require it to
        // name this epoch's remote generation as well. A candidate that states
        // no ufrag at all is accepted rather than guessed at: not every stack
        // emits the extension, and inventing a path fact is worse than resting
        // on the dual-endpoint proof the protocol already requires.
        val remoteUfrag = RelayRenewSdp.candidateUfrag(pair.remote)
        if (remoteUfrag.isNotEmpty() && remoteUfrag != a.remoteUfrag) return
        a.observed = true
        a.path = RelayRenewSdp.classifyPath(pair.local, pair.remote)
        // Only now may a probe start, and only now may a retained peer probe be
        // acked.
        startProbing(a)
        a.pendingProbe?.let { probe ->
            a.pendingProbe = null
            sendAck(a, probe)
        }
    }

    /** One inbound renewal envelope, already routed here by shape. */
    fun onSignal(raw: Json) {
        if (closed) return
        val envelope = RelayRenewWire.parseEnvelope(raw) ?: return
        val message = envelope.message
        val keys = deps.keys() ?: return
        if (!epochActionable(message)) return
        if (!spendVerification(message)) return
        val payload = RelayRenewWire.payload(deps.peerId(), deps.selfId(), message)
        // A signal that does not verify is dropped IN SILENCE. Answering would
        // tell a signalling relay which peer holds a live link.
        if (!Crypto.verifyAuth(keys, payload, envelope.auth)) return
        // Verified, authenticated, from the peer: from here on this
        // PeerConnection refuses unsigned `link`-generation SDP and ICE. The
        // decision is monotonic and does not rest on the capability hint.
        deps.transport()?.lockUnsignedSdp()
        // This epoch has heard from its peer. A `prepare` that ADOPTS a higher
        // epoch counts for the attempt it creates, not for the one it replaces:
        // see [begin].
        attempt?.let { it.peerSignals++ }
        when (message) {
            is RelayRenewWire.Message.Prepare -> onPrepare(message)
            is RelayRenewWire.Message.Ready -> onReady(message)
            is RelayRenewWire.Message.Sdp -> onRemoteSdp(message)
            is RelayRenewWire.Message.Ice -> onRemoteCandidate(message)
            is RelayRenewWire.Message.Abort -> onAbort(message)
        }
    }

    /** One inbound `ice-grant` payload. */
    fun onGrant(raw: Json) {
        if (closed) return
        val grant = RelayRenewWire.parseGrant(raw) ?: return
        // Unparseable, or for a request this link never made: dropped in
        // silence, because it cannot be correlated and so answers nothing.
        val asked = pendingRounds.remove(grant.rid) ?: return
        // A grant must answer the round it was asked about. `stale` is the one
        // exception: reporting a DIFFERENT round is its entire purpose.
        if (grant.status != RelayRenewWire.GrantStatus.STALE && grant.round != asked) return
        val a = attempt ?: return
        if (a.round != null) return
        a.cancel(TIMER_ROUND)
        when (grant.status) {
            RelayRenewWire.GrantStatus.GRANTED -> onGranted(a, grant)
            RelayRenewWire.GrantStatus.DENIED -> {
                // Terminal for this round: asking again cannot help inside it.
                roundDenied = true
                abort(a, RelayRenewWire.AbortReason.DENIED, State.DENIED)
            }
            RelayRenewWire.GrantStatus.UNAVAILABLE -> {
                // NOT terminal, and deliberately so. The peer may already hold
                // the round this side is missing, and its signed `ready(E, R)`
                // can still repair this very epoch — which needs no issuance at
                // all. Ending here would throw away the one path that works
                // precisely when the server has nothing new to give.
                //
                // The epoch stays alive with NO configuration, bounded by the
                // timers it already has; if no repair arrives they end it and
                // the old boundary stands.
                if (!canRepair()) {
                    abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
                }
            }
            RelayRenewWire.GrantStatus.STALE -> {
                if (a.resyncs >= MAX_ROUND_RESYNCS) {
                    abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
                    return
                }
                a.resyncs++
                // Re-ask for the round the server actually holds, to retrieve
                // its cached result. No reissuance and no rate charge.
                if (!requestRound(a, grant.round)) {
                    abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
                }
            }
        }
    }

    /**
     * One inbound text-lane frame whose first byte is [RelayRenewProbe.KIND].
     *
     * The caller has already CONSUMED it — this is a front demux, not an
     * observer — so everything below may drop a frame freely. Nothing here
     * reaches the text session's activity clock, its inbound rate budget or its
     * AEAD receiver, and a probe is never user activity.
     */
    fun onControlFrame(frame: ByteArray) {
        if (closed) return
        val decoded = RelayRenewProbe.decode(frame) ?: return
        val keys = deps.keys() ?: return
        val a = attempt
        if (a != null && decoded.epoch == a.epoch && decoded.round == a.round) {
            onAttemptFrame(a, decoded, keys)
            return
        }
        val c = committed
        if (c != null && decoded.epoch == c.epoch && decoded.round == c.round) {
            onCommittedFrame(c, decoded, keys)
        }
    }

    /**
     * The link is going away.
     *
     * Every timer, request, subscriber and retained nonce is disposed here. No
     * listener, timer or late callback can resurrect an epoch afterwards: they
     * all find `closed` and return.
     */
    fun close() {
        if (closed) return
        closed = true
        tickTimer?.cancel()
        tickTimer = null
        attempt?.let { disposeAttempt(it) }
        attempt = null
        committed?.timer?.cancel()
        committed = null
        pendingRounds.clear()
        deps.transport()?.onCandidate(null)
    }

    /** The state the UI may show, for a caller that needs to read it back. */
    fun currentState(): State = state

    // ── the trigger ─────────────────────────────────────────────────────────

    /**
     * Whether an attempt is due right now.
     *
     * Every clause is a refusal to spend an epoch, and each is here because
     * spending one anyway would be wrong rather than merely wasteful.
     */
    private fun due(now: Long): Boolean {
        if (closed || attempt != null) return false
        if (peerUnsupported || roundDenied) return false
        if (deps.transport() == null) return false
        if (deps.keys() == null) return false
        // The peer never said it speaks this. An epoch would be a prepare into
        // silence.
        if (!deps.peerSupportsRenew()) return false
        if (!budgetRemains()) return false
        val bound = deadline ?: return false
        // A credential that was already dead when it was armed cannot be
        // extended, and asking would spend a round on a link that must end.
        if (bound.expired) return false
        if (now < retryNotBefore) return false
        // The margin was fixed at ARMING time, against the grant's whole
        // lifetime. Recomputing it from the time remaining would make this
        // comparison answer "not yet" for every positive remaining, right up to
        // the deadline, and the renewal would never fire.
        if (now < bound.renewAt) return false
        // No blind retry past the boundary the link already has.
        if (now >= bound.deadlineAt) return false
        // LAST, because it is the one that can change between ticks and the one
        // a reader most needs to see is not bypassed by any branch above.
        return deps.userActive()
    }

    private fun armTick() {
        tickTimer?.cancel()
        tickTimer = null
        if (closed) return
        val bound = deadline ?: return
        val now = deps.now()
        if (now >= bound.deadlineAt) return
        // One wake at the margin, then a slow poll through it. Outside the
        // margin this costs exactly one scheduled task for the whole grant.
        val delay = if (now < bound.renewAt) bound.renewAt - now else RelayRenewPolicy.TICK_MS
        tickTimer = deps.timers().schedule(maxOf(delay, MIN_TICK_MS)) {
            tickTimer = null
            tick()
            armTick()
        }
    }

    private fun tick() {
        val now = deps.now()
        if (!due(now)) return
        begin(highestSpentEpoch + 1, adopted = false)
    }

    // ── epochs ──────────────────────────────────────────────────────────────

    /**
     * Whether this message's epoch is one this side can act on (section 4).
     *
     * With an attempt in flight: its own epoch, or a `prepare` at a HIGHER one,
     * which is adopted. Both ends then converge on the larger.
     *
     * Otherwise only a `prepare`, and only STRICTLY above every epoch this link
     * has already spent — including one a refused prepare spent while an
     * attempt was in flight.
     */
    private fun epochActionable(message: RelayRenewWire.Message): Boolean {
        val isPrepare = message is RelayRenewWire.Message.Prepare
        val a = attempt
        if (a != null && message.epoch == a.epoch) return true
        if (!isPrepare) return false
        return message.epoch > highestSpentEpoch
    }

    /** The per-epoch (or, outside one, per-link) verification budget. */
    private fun spendVerification(message: RelayRenewWire.Message): Boolean {
        val a = attempt
        if (a == null || message.epoch > a.epoch) {
            if (idleSignalBudget <= 0) return false
            idleSignalBudget--
            return true
        }
        if (a.signalVerifications >= MAX_SIGNAL_VERIFICATIONS) return false
        a.signalVerifications++
        return true
    }

    private fun onPrepare(message: RelayRenewWire.Message.Prepare) {
        // Verified and actionable: the peer has spent this epoch whether or not
        // it is refused below. Recorded first, so the same signed prepare
        // replayed after the refusing condition clears is stale (G34-N13).
        highestSpentEpoch = maxOf(highestSpentEpoch, message.epoch)
        val existing = attempt
        // Two peers preparing simultaneously at the SAME epoch coalesce into
        // one attempt; there is nothing further to do and nothing to echo.
        if (existing != null && existing.epoch == message.epoch) return
        // This side's OWN consent gate applies to an epoch it adopts, not only
        // to one it starts: adopting means asking the server, and section 7.1
        // is about what this client may ask for, not about what a peer claims.
        //
        // Refused ALOUD, with a signed abort, rather than by silence. Two
        // prepares into silence is how a peer concludes this build does not
        // implement renewal AT ALL, for the remainder of the link — and a
        // couple of seconds' difference between two independent activity
        // clocks must not cost that. `unavailable` keeps the round retryable.
        if (!deps.userActive()) {
            sendAbort(message.epoch, RelayRenewWire.AbortReason.UNAVAILABLE)
            return
        }
        if (existing != null) {
            // A higher epoch wins. The old attempt is voided locally and its
            // boundary is preserved, exactly as every other failure preserves
            // it; no abort is sent, because the peer has already moved on.
            //
            // It is still CHARGED. Replacing an epoch that never obtained a
            // configuration costs exactly what letting it time out would have,
            // and without that a peer walking the epoch space upward would
            // free the correlation slot each time and draw an unbounded run of
            // round requests out of this client — each replacement discarding
            // the request before anything could bound it.
            if (existing.round == null) pregrantAttempts++
            disposeAttempt(existing)
            attempt = null
        }
        if (!canBeginEpoch()) {
            sendAbort(message.epoch, RelayRenewWire.AbortReason.UNAVAILABLE)
            return
        }
        begin(message.epoch, adopted = true)
    }

    private fun canBeginEpoch(): Boolean {
        if (closed || peerUnsupported || roundDenied) return false
        if (deps.transport() == null || deps.keys() == null) return false
        if (!budgetRemains()) return false
        val bound = deadline ?: return false
        if (bound.expired) return false
        return deps.now() < bound.deadlineAt
    }

    /** Migration epochs already spent on [round]. */
    private fun spentOn(round: Long): Int = migrationEpochs[round] ?: 0

    /**
     * Whether [round] may still be migrated onto.
     *
     * Asked at the moment a configuration is offered, BEFORE it is applied to
     * the `PeerConnection` and before any SDP is created — a fourth cached
     * round 1 must be refused while refusing it is still free.
     */
    private fun roundBudgetRemains(round: Long): Boolean =
        spentOn(round) < RelayRenewWire.MAX_EPOCHS_PER_ROUND

    /** Charge one migration epoch to [round]. Never refunded. */
    private fun chargeMigration(round: Long) {
        migrationEpochs[round] = spentOn(round) + 1
        // Bounded, because the map is keyed by a uint32 a peer influences.
        // Rounds only move forward — `round` advances on commit, a request asks
        // for `round + 1`, and a repair targets the installed round, which is
        // never below it — so the lowest key is the one that can no longer be
        // reached, and dropping it cannot refund anything still spendable.
        while (migrationEpochs.size > MAX_TRACKED_ROUNDS) {
            val oldest = migrationEpochs.keys.minOrNull() ?: break
            migrationEpochs.remove(oldest)
        }
    }

    /**
     * Whether anything is left to START another epoch with.
     *
     * Only the PRE-GRANT budget, deliberately. The per-round migration budget
     * is enforced where the round is actually known — at acceptance — because
     * an epoch that begins may still be served a different round than the one
     * it asked for: a `stale` reply redirects it to whatever the server
     * currently holds, and refusing to start on the strength of the round this
     * side GUESSED it would get would block that recovery entirely.
     *
     * A run of `unavailable` replies, rate refusals or timed-out requests
     * issued nothing and migrated nothing; counting those against the migration
     * budget meant three seconds of database jitter permanently gave up a
     * renewal with most of the margin still unspent.
     */
    private fun budgetRemains(): Boolean = pregrantAttempts < MAX_PREGRANT_ATTEMPTS

    private fun begin(epoch: Long, adopted: Boolean) {
        val a = Attempt(epoch)
        attempt = a
        highestSpentEpoch = maxOf(highestSpentEpoch, epoch)
        // An adopted epoch has already heard from its peer, which is exactly
        // what the unsupported test below asks about.
        if (adopted) a.peerSignals = 1
        publish(State.RENEWING)

        // The whole epoch, never re-armed whatever progress it makes.
        a.arm(TIMER_EPOCH, RelayRenewWire.EPOCH_HARD_CAP_MS) {
            abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.FAILED)
        }
        // Both sides may prepare. Adopting the peer's epoch is answered with
        // this side's own prepare at the SAME epoch, which the peer then
        // coalesces — one echo each, never a ping-pong.
        sendPrepare(a)
        a.arm(TIMER_PREPARE, RelayRenewWire.PREPARE_TO_READY_MS) {
            if (a.peerSignals == 0 && a.preparesSent >= 2) {
                // Two prepares about ten seconds apart with no reply AT ALL.
                // Terminal for the LINK, not for the session: the boundary it
                // has keeps running and the UI must not claim a renewal
                // happened.
                peerUnsupported = true
                abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.UNSUPPORTED)
            } else {
                abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.FAILED)
            }
        }
        if (!adopted) {
            a.arm(TIMER_PREPARE_RETRY, RelayRenewWire.PREPARE_SILENCE_MS) {
                if (a.peerSignals == 0) sendPrepare(a)
            }
        }
        // Both original peers must ask before the server issues a round.
        if (!requestRound(a, round + 1)) {
            abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
        }
    }

    private fun requestRound(a: Attempt, target: Long): Boolean {
        if (!RelayRenewWire.isUint32(target)) return false
        if (pendingRounds.size >= MAX_INFLIGHT_ROUNDS) return false
        val rid = deps.randomUint32()
        // A repeated rid would make two requests indistinguishable.
        if (pendingRounds.containsKey(rid)) return false
        if (!deps.requestRound(target, rid)) return false
        pendingRounds[rid] = target
        // Recorded on the attempt so disposing it cannot leave a correlation
        // entry behind for a reply nobody is waiting for.
        a.rids.add(rid)
        a.arm(TIMER_ROUND, RelayRenewWire.ROUND_TIMEOUT_MS) {
            pendingRounds.remove(rid)
            // Silence is what an older server that ignores `ice-renew`
            // produces, and it is treated exactly as `unavailable`: not
            // terminal while a same-round repair is still possible, and
            // otherwise a bounded failure that keeps the boundary it has.
            if (!canRepair()) {
                abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
            }
        }
        return true
    }

    private fun onGranted(a: Attempt, grant: RelayRenewWire.IceGrant) {
        val transport = deps.transport() ?: run {
            abort(a, RelayRenewWire.AbortReason.CLOSED, State.FAILED)
            return
        }
        val config = IceConfig.parse(grant.config)
        val bound = RelayRenewPolicy.deadline(credentials(config.servers), deps.now())
        // A grant that bounds NOTHING is refused rather than treated as
        // "forever". Terminal for the round: asking again returns the same
        // cached result.
        //
        // So is one that would move the boundary EARLIER, or not at all:
        // migrating onto it would retire a live allocation in favour of a
        // shorter-lived one, which is strictly worse than doing nothing.
        //
        // `denied` here is truthful, unlike a local budget refusal: the server
        // replays one cached configuration per round, so a configuration that
        // cannot be migrated onto cannot be migrated onto by EITHER peer. The
        // round really is terminal, which is what `denied` means on this wire,
        // and the peer latching it is correct rather than collateral.
        val current = deadline
        if (bound == null || bound.expired ||
            (current != null && bound.deadlineAt <= current.deadlineAt)
        ) {
            roundDenied = true
            abort(a, RelayRenewWire.AbortReason.DENIED, State.DENIED)
            return
        }
        // A FOURTH migration epoch on this credential, refused while refusing
        // it is still free: before the configuration reaches the
        // `PeerConnection`, before any description is created, and without
        // disturbing what is already installed. The server replays a cached
        // round indefinitely, so without this the only limit on migrations per
        // issuance would be how long the margin lasts.
        //
        // `unavailable`, NOT `denied`. On this wire `denied` means terminal for
        // the round, and a peer that receives one latches exactly that. But
        // this is THIS side's resource bound, not a policy refusal and not a
        // statement about the credential: the peer may still have budget on
        // this very round and may legitimately migrate onto it — a repair it
        // initiates is the ordinary way that happens. Reporting a local
        // exhaustion as policy would end the round for both of us on the
        // strength of one side's accounting.
        if (!roundBudgetRemains(grant.round)) {
            abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
            return
        }
        // Applying a configuration is not a migration. `false` is a failure;
        // `true` is only permission to try.
        if (!transport.applyConfiguration(config.servers)) {
            abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
            return
        }
        // The connection is now RUNNING on these servers, whatever this
        // migration goes on to do. Recorded before anything else can fail, and
        // handed to the owner, because a later path classification and a later
        // repair both have to read what is actually installed rather than the
        // configuration the room was originally issued.
        installedRound = grant.round
        installedServers = config.servers
        deps.onConfigurationInstalled(config.servers)
        beginMigration(a, grant.round, bound)
    }

    /**
     * The epoch has a configuration and may now migrate.
     *
     * Shared by a freshly granted round and by a same-round repair, because
     * from here the two are the same thing: a signed `ready`, an ICE restart on
     * the same `PeerConnection`, and a path that has to prove itself. Only the
     * budget and the boundary differ, and both of those are decided by the
     * caller.
     */
    private fun beginMigration(a: Attempt, round: Long, bound: RelayRenewPolicy.Deadline?) {
        val transport = deps.transport() ?: run {
            abort(a, RelayRenewWire.AbortReason.CLOSED, State.FAILED)
            return
        }
        a.round = round
        a.newDeadline = bound
        // A migration epoch on THIS credential round, charged once, here —
        // the single point both the granted path and the adoption path pass
        // through. Pre-grant failures never reach it, and nothing refunds it.
        chargeMigration(round)
        pregrantAttempts = 0
        // This epoch owns the local candidate stream from here: its candidates
        // are signed and bound to a generation, and the transport must not also
        // emit them unsigned.
        transport.onCandidate { candidate -> onLocalCandidate(a, candidate) }
        sendReady(a, round)
        a.arm(TIMER_READY, RelayRenewWire.READY_TO_ANSWER_MS) {
            abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.FAILED)
        }
        maybeOffer(a)
    }

    private fun onReady(message: RelayRenewWire.Message.Ready) {
        val a = attempt ?: return
        if (a.peerReadyRound != null) return
        // ── the same-round repair ──────────────────────────────────────────
        //
        // The asymmetry this exists for: one peer COMMITTED round R and the
        // other did not. The committed side's next request is for R+1 and it
        // will wait alone for a round the server will not issue, while the
        // uncommitted side fetches R from the server's cache and readies on it.
        // Without a repair the two sit on different rounds until the epoch
        // times out, every time, and the link dies on a credential both ends
        // already hold.
        //
        // So: a VALID SIGNED ready for exactly the round this side has already
        // installed, while this side is still awaiting a different one, adopts
        // that installed configuration. It needs no new issuance, because the
        // credential is already on this `PeerConnection`.
        //
        // Whether adopting it MOVES the boundary is a separate question, and
        // conflating the two is a real way to strand a link. "Same round" means
        // the round the CURRENT DEADLINE was derived from — `installedRound ==
        // round`. A configuration that was applied by an epoch which then
        // failed leaves `installedRound` AHEAD of the committed `round`, and
        // adopting that one is a genuine advance onto a credential this side
        // has never been bounded by: refusing to move the boundary there would
        // commit the migration and then let the link die on the older deadline
        // it had just replaced.
        if (a.round == null && installedRound != null && message.round == installedRound &&
            installedServers.isNotEmpty()
        ) {
            adoptInstalledRound(a, message.round)
            return
        }
        // Not adoptable — but RETAINED, never dropped. A peer whose own grant
        // arrived first readies before this side has any configuration at all,
        // and a client that discarded that message would wait for a `ready`
        // already sent while the peer waited for an offer that needed it: both
        // sides idle until the epoch times out, on every attempt, whenever the
        // server answers one peer a second sooner than the other.
        a.peerReadyRound = message.round
        maybeOffer(a)
    }

    /**
     * Whether a same-round repair could still rescue the epoch in flight.
     *
     * Only if this side actually holds a configuration for a round, and that
     * configuration's credential is still live. A lapsed one is not something
     * to migrate onto: it would install a boundary already in the past.
     */
    private fun canRepair(): Boolean {
        if (installedRound == null || installedServers.isEmpty()) return false
        val bound = RelayRenewPolicy.deadline(credentials(installedServers), deps.now())
        return bound != null && !bound.expired
    }

    /**
     * Repair onto the configuration this side already has installed.
     *
     * Three things must be true and are checked by the caller: the round is
     * EXACTLY the installed one (never lower, never an unsolicited higher one),
     * a configuration for it is actually installed, and this side has not yet
     * obtained a configuration in this epoch.
     *
     * What this deliberately does NOT do is move the boundary. The credential
     * is the one already in force; a repair re-establishes the path on it, and
     * re-arming a deadline here would extend a credential on no new authority
     * at all. [Commit.boundaryMoved] carries that distinction to the owner.
     */
    private fun adoptInstalledRound(a: Attempt, adopted: Long) {
        // FENCE the outstanding request first. A late `ice-grant` for R+1 —
        // granted or denied — must not overwrite the round this epoch has just
        // adopted, and must not abort it either; dropping the correlation
        // entries and the timer is what makes both impossible rather than
        // unlikely.
        for (rid in a.rids) pendingRounds.remove(rid)
        a.rids.clear()
        a.cancel(TIMER_ROUND)
        // A credential that has lapsed is not something to migrate onto: it
        // would install a boundary already in the past.
        if (!canRepair()) {
            abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
            return
        }
        // A repair is a migration epoch like any other, and it is charged to
        // the same credential. The fourth one on a round is refused here, for
        // the reason the granted path refuses it: a pair that keeps repairing
        // would otherwise draw an unbounded series of migrations out of one
        // issuance.
        //
        // Reported as `unavailable` for the reason the granted path reports it
        // that way: a local budget is not a policy, and the peer asking for
        // this repair may still be entitled to the round.
        if (!roundBudgetRemains(adopted)) {
            abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
            return
        }
        // A repair BUYS NO TIME only when the credential is the one the
        // CURRENT BOUNDARY already came from — the committed `round`, not
        // merely the one that happens to be installed. See [onReady].
        val advancesBoundary = adopted > round
        a.sameRoundRepair = !advancesBoundary
        a.peerReadyRound = adopted
        // Re-applied rather than assumed: it is the same configuration on the
        // same connection, so this is idempotent, and a surface that refuses it
        // is a surface this epoch cannot migrate on.
        val transport = deps.transport()
        if (transport == null || !transport.applyConfiguration(installedServers)) {
            abort(a, RelayRenewWire.AbortReason.UNAVAILABLE, State.FAILED)
            return
        }
        // Reported like any other apply. The configuration is unchanged, but
        // the OWNER's record of what the live connection runs on must track
        // every application rather than only the ones that changed something.
        deps.onConfigurationInstalled(installedServers)
        beginMigration(
            a,
            adopted,
            // Null for a true same-round repair: a commit on it does not move
            // the boundary. For an adoption that is genuinely ahead of the
            // committed round, the boundary that configuration states.
            bound = if (advancesBoundary) {
                RelayRenewPolicy.deadline(credentials(installedServers), deps.now())
            } else {
                null
            },
        )
    }

    /**
     * The offer, once BOTH sides have applied a fresh configuration for the
     * SAME round.
     *
     * Only the link's established initiator offers. Waiting for both readys is
     * what stops an offer reaching a peer that is still bounded by the previous
     * credential, which would migrate onto a relay one side cannot allocate.
     */
    private fun maybeOffer(a: Attempt) {
        if (a.offerSent) return
        val ourRound = a.round ?: return
        val theirRound = a.peerReadyRound ?: return
        if (ourRound != theirRound) {
            abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
            return
        }
        a.cancel(TIMER_PREPARE)
        a.cancel(TIMER_PREPARE_RETRY)
        if (!deps.isInitiator()) {
            // The responder waits for the offer, under the same bound.
            a.arm(TIMER_READY, RelayRenewWire.READY_TO_ANSWER_MS) {
                abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.FAILED)
            }
            return
        }
        a.offerSent = true
        val transport = deps.transport() ?: return
        transport.createRenewOffer { local ->
            if (closed || attempt !== a) return@createRenewOffer
            if (local == null) {
                abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
                return@createRenewOffer
            }
            a.localUfrag = local.ufrag
            send(a, RelayRenewWire.Message.Sdp(a.epoch, ourRound, "offer", local.sdp))
            a.cancel(TIMER_READY)
            a.arm(TIMER_READY, RelayRenewWire.READY_TO_ANSWER_MS) {
                abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.FAILED)
            }
        }
    }

    private fun onRemoteSdp(message: RelayRenewWire.Message.Sdp) {
        val a = attempt ?: return
        if (message.round != a.round) return
        if (a.remoteApplied) return
        val isAnswer = message.sdpType == "answer"
        // An initiator never answers an offer and a responder never applies an
        // answer: one deterministic role, so a migration cannot become glare.
        if (isAnswer != deps.isInitiator()) return
        val transport = deps.transport() ?: return
        val baseline = transport.baselinePin() ?: run {
            abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
            return
        }
        // Pin BEFORE `setRemoteDescription`: the fingerprint set, the m-line
        // count and the mid sequence must be equal, and an answer's chosen
        // `setup` role must be unchanged. A description that fails this never
        // reaches the stack.
        if (!RelayRenewSdp.pinMatches(baseline, RelayRenewSdp.pin(message.sdp), isAnswer)) {
            abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
            return
        }
        val remoteUfrag = RelayRenewSdp.iceUfrag(message.sdp)
        if (remoteUfrag.isEmpty()) {
            abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
            return
        }
        a.remoteApplied = true
        transport.applyRemoteSdp(message.sdpType, message.sdp) { ok ->
            if (closed || attempt !== a) return@applyRemoteSdp
            if (!ok) {
                abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
                return@applyRemoteSdp
            }
            a.remoteUfrag = remoteUfrag
            releaseHeld(a)
            if (isAnswer) {
                enterIcePhase(a)
            } else {
                transport.createRenewAnswer { local ->
                    if (closed || attempt !== a) return@createRenewAnswer
                    if (local == null) {
                        abort(a, RelayRenewWire.AbortReason.SDP, State.FAILED)
                        return@createRenewAnswer
                    }
                    a.localUfrag = local.ufrag
                    send(
                        a,
                        RelayRenewWire.Message.Sdp(a.epoch, a.round!!, "answer", local.sdp),
                    )
                    enterIcePhase(a)
                }
            }
        }
    }

    private fun enterIcePhase(a: Attempt) {
        a.cancel(TIMER_READY)
        a.arm(TIMER_ICE, RelayRenewWire.ICE_PROBE_MS) {
            abort(a, RelayRenewWire.AbortReason.TIMEOUT, State.FAILED)
        }
        // BOTH descriptions are in. If the ICE agent already told us which pair
        // it chose, that answer counts now — it was simply unusable when it
        // arrived.
        evaluateObservation(a)
    }

    // ── candidates ──────────────────────────────────────────────────────────

    private fun onLocalCandidate(a: Attempt, candidate: RenewTransport.Candidate) {
        if (closed || attempt !== a) return
        val round = a.round ?: return
        // A candidate belongs to whichever generation the candidate ITSELF
        // names. One whose ufrag cannot be parsed, or that names another
        // generation, is DROPPED rather than sent under a guessed epoch.
        val ufrag = RelayRenewSdp.candidateUfrag(candidate.candidate)
        if (ufrag.isEmpty() || ufrag != a.localUfrag) return
        send(
            a,
            RelayRenewWire.Message.Ice(
                epoch = a.epoch,
                round = round,
                candidate = candidate.candidate,
                sdpMid = candidate.sdpMid,
                sdpMLineIndex = candidate.sdpMLineIndex?.toLong(),
                usernameFragment = ufrag,
            ),
        )
    }

    private fun onRemoteCandidate(message: RelayRenewWire.Message.Ice) {
        val a = attempt ?: return
        if (message.round != a.round) return
        val ufrag = RelayRenewSdp.inboundCandidateUfrag(
            message.candidate,
            message.usernameFragment,
        )
        // Contradictory sources, or none at all: unattributable, so dropped.
        if (ufrag.isEmpty()) return
        val candidate = RenewTransport.Candidate(
            message.candidate,
            message.sdpMid,
            message.sdpMLineIndex?.toInt(),
        )
        if (!a.remoteApplied || a.remoteUfrag.isEmpty()) {
            // Held, keyed BY UFRAG, so a candidate gathered for a generation
            // this epoch never applies is discarded with that generation rather
            // than added to the live one.
            if (a.heldCount >= RelayRenewWire.MAX_HELD_CANDIDATES) return
            a.heldCount++
            a.held.getOrPut(ufrag) { ArrayList() }.add(candidate)
            return
        }
        if (ufrag != a.remoteUfrag) return
        deps.transport()?.addCandidate(candidate)
    }

    /**
     * One local candidate gathered after this epoch committed.
     *
     * Bound by exactly the same rule an in-flight epoch's candidates are: the
     * candidate must NAME the committed generation. One that does not belongs
     * to some other generation and is dropped rather than signed under a number
     * it does not carry.
     */
    private fun onCommittedCandidate(c: Committed, candidate: RenewTransport.Candidate) {
        if (closed || committed !== c) return
        val ufrag = RelayRenewSdp.candidateUfrag(candidate.candidate)
        if (ufrag.isEmpty() || ufrag != c.localUfrag) return
        val keys = deps.keys() ?: return
        val message = RelayRenewWire.Message.Ice(
            epoch = c.epoch,
            round = c.round,
            candidate = candidate.candidate,
            sdpMid = candidate.sdpMid,
            sdpMLineIndex = candidate.sdpMLineIndex?.toLong(),
            usernameFragment = ufrag,
        )
        val payload = RelayRenewWire.payload(deps.selfId(), deps.peerId(), message)
        deps.sendRenew(RelayRenewWire.envelopeJson(message, Crypto.signAuth(keys, payload)))
    }

    private fun releaseHeld(a: Attempt) {
        val held = a.held.remove(a.remoteUfrag).orEmpty()
        a.held.clear()
        a.heldCount = 0
        val transport = deps.transport() ?: return
        for (candidate in held) transport.addCandidate(candidate)
    }

    // ── the data-path proof ─────────────────────────────────────────────────

    private fun startProbing(a: Attempt) {
        if (a.ownNonce != null) return
        val nonce = deps.randomBytes(RelayRenewProbe.NONCE_BYTES)
        if (nonce.size != RelayRenewProbe.NONCE_BYTES) return
        a.ownNonce = nonce
        sendProbe(a)
    }

    private fun sendProbe(a: Attempt) {
        val round = a.round ?: return
        val nonce = a.ownNonce ?: return
        if (a.sends >= RelayRenewWire.PROBE_MAX_SENDS) return
        a.sends++
        sendControl(a, RelayRenewProbe.TYPE_PROBE, round, nonce)
        a.arm(TIMER_PROBE, RelayRenewWire.PROBE_RETRY_MS) { sendProbe(a) }
    }

    private fun sendAck(a: Attempt, probe: RelayRenewProbe.Frame) {
        val round = a.round ?: return
        val frame = sendControl(a, RelayRenewProbe.TYPE_ACK, round, probe.nonce) ?: return
        // Retained so a retransmitted probe — including one that arrives after
        // this side has already committed — gets the SAME ack, idempotently and
        // without spending another HMAC.
        if (a.ackedNonces.size < MAX_ACKED_NONCES) a.ackedNonces[probeKey(probe)] = frame
    }

    /** A verified probe's identity: its nonce AND the tag that verified. */
    private fun probeKey(frame: RelayRenewProbe.Frame): String =
        RelayRenewProbe.nonceKey(frame.nonce) + ":" + RelayRenewProbe.nonceKey(frame.tag)

    private fun sendControl(a: Attempt, type: Int, round: Long, nonce: ByteArray): ByteArray? {
        val keys = deps.keys() ?: return null
        val transport = deps.transport() ?: return null
        val frame = RelayRenewProbe.sign(
            keys, type, deps.selfId(), deps.peerId(), a.epoch, round, nonce,
        ) ?: return null
        // Straight onto the lane, never through the text send queue.
        if (!transport.sendControlFrame(frame)) return null
        return frame
    }

    private fun onAttemptFrame(
        a: Attempt,
        decoded: RelayRenewProbe.Frame,
        keys: Crypto.SessionKeys,
    ) {
        if (a.round == null) return
        if (decoded.isProbe) {
            // An exact duplicate of an already-verified frame reuses the
            // cached result: same ack, no HMAC.
            // "Already verified" is identified by nonce AND TAG together.
            // Matching on the nonce alone would let a frame that merely reuses
            // a seen nonce with a forged tag collect a free ack without ever
            // holding the key.
            a.ackedNonces[probeKey(decoded)]?.let { cached ->
                deps.transport()?.sendControlFrame(cached)
                return
            }
            if (a.probeVerifications >= MAX_PROBE_RESERVATION) return
            a.probeVerifications++
            if (!RelayRenewProbe.verify(keys, decoded, deps.peerId(), deps.selfId())) return
            // A verified probe arriving BEFORE local observation holds is
            // retained in a single slot, latest nonce wins, and acked once
            // observation holds.
            if (a.observed) sendAck(a, decoded) else a.pendingProbe = decoded
            return
        }
        // An ack matches this side's own CURRENT nonce, or it is not ours.
        // Checked before the budget, so a flood of foreign nonces cannot spend
        // one verification each.
        val ownNonce = a.ownNonce ?: return
        if (!RelayRenewProbe.nonceEquals(ownNonce, decoded.nonce)) return
        if (a.committedAck) return
        if (a.ackVerifications >= MAX_ACK_RESERVATION) return
        a.ackVerifications++
        if (!RelayRenewProbe.verify(keys, decoded, deps.peerId(), deps.selfId())) return
        a.committedAck = true
        // The ack can only match a nonce this side minted AFTER observation
        // held, because the probe carrying it is not sent before then. The
        // check is restated because the rule is the feature.
        if (!a.observed) return
        commit(a)
    }

    /**
     * A probe for an epoch this side has already committed.
     *
     * The peer's own commit needs OUR ack, and its retransmit may land after
     * ours did — its ack to us arrived, ours to it did not. Dropping it here
     * because "the attempt is over" is how one side succeeds while the other
     * fails and then ends a link that was actually migrated. So the committed
     * epoch keeps answering, under the same bounded budget, for the length of
     * one ICE-and-probe phase and no longer.
     */
    private fun onCommittedFrame(
        c: Committed,
        decoded: RelayRenewProbe.Frame,
        keys: Crypto.SessionKeys,
    ) {
        if (!decoded.isProbe) return
        val transport = deps.transport() ?: return
        val key = probeKey(decoded)
        c.ackedNonces[key]?.let { cached ->
            transport.sendControlFrame(cached)
            return
        }
        // The SAME epoch budget, carried over rather than refilled. A peer
        // probe this side has never seen before is legitimate after its own
        // commit — the peer's ack reached us while ours did not — so the
        // reservation has to still be spendable here, and it has to be the same
        // eight rather than a second set.
        if (c.probeVerifications >= MAX_PROBE_RESERVATION) return
        c.probeVerifications++
        if (!RelayRenewProbe.verify(keys, decoded, deps.peerId(), deps.selfId())) return
        val frame = RelayRenewProbe.sign(
            keys, RelayRenewProbe.TYPE_ACK, deps.selfId(), deps.peerId(),
            c.epoch, c.round, decoded.nonce,
        ) ?: return
        if (!transport.sendControlFrame(frame)) return
        if (c.ackedNonces.size < MAX_ACKED_NONCES) c.ackedNonces[key] = frame
    }

    // ── commit ──────────────────────────────────────────────────────────────

    /**
     * Local observation PLUS a matching fresh ack for this side's own nonce,
     * arriving after observation held.
     *
     * Nothing else commits. Not a WebSocket reply, not `setConfiguration`, not
     * an open DataChannel, not a `connected` state, not an old selected
     * candidate.
     */
    private fun commit(a: Attempt) {
        val newRound = a.round ?: return
        // A same-round repair carries no new boundary, and that is the whole
        // difference between the two kinds of commit.
        val bound = a.newDeadline
        if (!a.sameRoundRepair && bound == null) return
        round = newRound
        roundDenied = false
        idleSignalBudget = IDLE_SIGNAL_BUDGET
        retryNotBefore = 0
        pregrantAttempts = 0
        // Nothing about the migration budget changes here, and that is the
        // point. The credential just committed keeps every epoch it was
        // charged — committing one is not a reason to hand the same credential
        // three more — while the NEXT round has its own untouched budget,
        // because the accounting is keyed by round rather than reset by
        // progress.

        val record = Committed(
            epoch = a.epoch,
            round = newRound,
            localUfrag = a.localUfrag,
            ackedNonces = LinkedHashMap(a.ackedNonces),
            ackVerifications = a.ackVerifications,
            probeVerifications = a.probeVerifications,
        )
        committed?.timer?.cancel()
        committed = record
        record.timer = deps.timers().schedule(RelayRenewWire.POST_COMMIT_ACK_MS) {
            record.timer = null
            if (committed !== record) return@schedule
            committed = null
            // The window is over: nothing is left that could answer a probe or
            // sign a candidate for this epoch, so the stream is handed back.
            deps.transport()?.onCandidate(null)
        }

        // Re-run the existing path classification, and say exactly what this
        // commit did to the boundary:
        //
        //  - a DIRECT path releases it entirely, as the existing rule does for
        //    a link that was direct from the start. That is a change, and the
        //    owner must act on it.
        //  - a relayed path on a NEW round moves it to what that credential
        //    states.
        //  - a relayed path on a REPAIRED round leaves it exactly where it was.
        //    The credential did not change, and re-arming here would extend one
        //    on no new authority.
        val outcome = when {
            a.path != RelayRenewSdp.Path.RELAY -> Commit(deadline = null, boundaryMoved = true)
            a.sameRoundRepair -> Commit(deadline = deadline, boundaryMoved = false)
            else -> Commit(deadline = bound, boundaryMoved = true)
        }
        disposeAttempt(a)
        attempt = null
        // The committed epoch keeps the candidate stream for its window. After
        // a migration every later local candidate still belongs to THAT
        // generation, and it must keep travelling signed: handing the stream
        // back now would either leak it unsigned or — because the peer has
        // locked unsigned SDP — drop it entirely.
        deps.transport()?.onCandidate { candidate -> onCommittedCandidate(record, candidate) }
        if (outcome.boundaryMoved) deadline = outcome.deadline
        publish(State.RENEWED, outcome)
        armTick()
    }

    // ── failure ─────────────────────────────────────────────────────────────

    /**
     * Void the epoch and PRESERVE the old boundary.
     *
     * Every failure path lands here, and every one of them leaves the deadline
     * the link already has exactly as it was.
     */
    private fun abort(a: Attempt, reason: RelayRenewWire.AbortReason, next: State) {
        if (attempt !== a) return
        // An epoch that never obtained a configuration spends the pre-grant
        // budget, not a migration. See [budgetRemains].
        if (a.round == null) pregrantAttempts++
        send(a, RelayRenewWire.Message.Abort(a.epoch, reason))
        disposeAttempt(a)
        attempt = null
        retryNotBefore = deps.now() + RelayRenewPolicy.RETRY_BACKOFF_MS
        publish(next)
    }

    private fun onAbort(message: RelayRenewWire.Message.Abort) {
        val a = attempt ?: return
        if (message.epoch != a.epoch) return
        if (message.reason == RelayRenewWire.AbortReason.DENIED) roundDenied = true
        if (a.round == null) pregrantAttempts++
        disposeAttempt(a)
        attempt = null
        retryNotBefore = deps.now() + RelayRenewPolicy.RETRY_BACKOFF_MS
        publish(if (roundDenied) State.DENIED else State.FAILED)
    }

    private fun disposeAttempt(a: Attempt) {
        a.cancelAll()
        a.held.clear()
        a.heldCount = 0
        a.pendingProbe = null
        for (rid in a.rids) pendingRounds.remove(rid)
        deps.transport()?.onCandidate(null)
    }

    // ── plumbing ────────────────────────────────────────────────────────────

    private fun sendPrepare(a: Attempt) {
        a.preparesSent++
        send(a, RelayRenewWire.Message.Prepare(a.epoch))
    }

    private fun sendReady(a: Attempt, round: Long) {
        send(a, RelayRenewWire.Message.Ready(a.epoch, round))
    }

    /** An abort for an epoch this side is refusing WITHOUT adopting it. */
    private fun sendAbort(epoch: Long, reason: RelayRenewWire.AbortReason) {
        val keys = deps.keys() ?: return
        val message = RelayRenewWire.Message.Abort(epoch, reason)
        val payload = RelayRenewWire.payload(deps.selfId(), deps.peerId(), message)
        deps.sendRenew(RelayRenewWire.envelopeJson(message, Crypto.signAuth(keys, payload)))
    }

    private fun send(a: Attempt, message: RelayRenewWire.Message) {
        val keys = deps.keys() ?: return
        val payload = RelayRenewWire.payload(deps.selfId(), deps.peerId(), message)
        val auth = Crypto.signAuth(keys, payload)
        deps.sendRenew(RelayRenewWire.envelopeJson(message, auth))
    }

    private fun publish(next: State, commit: Commit? = null) {
        state = next
        deps.onRenewState(next, commit)
    }

    private fun credentials(servers: List<IceConfig.Server>): List<RelayRenewPolicy.Credential> =
        servers.map { RelayRenewPolicy.Credential(it.urls, it.username) }

    // ── state ───────────────────────────────────────────────────────────────

    private inner class Attempt(val epoch: Long) {
        var round: Long? = null
        var peerReadyRound: Long? = null
        var newDeadline: RelayRenewPolicy.Deadline? = null
        var offerSent = false
        var remoteApplied = false
        var localUfrag = ""
        var remoteUfrag = ""
        var observed = false
        var path: RelayRenewSdp.Path? = null
        var ownNonce: ByteArray? = null
        var sends = 0
        /**
         * HMACs spent on inbound ACKS and on inbound PROBES, separately.
         *
         * Partitioned rather than pooled, and that is the point: with one
         * shared counter a flood of forged probes spends every verification the
         * epoch has, and the ONE ack that would have committed a real migration
         * then arrives with no budget left to check it. Four each, eight in
         * total, which is the bound the wire states.
         */
        var ackVerifications = 0
        var probeVerifications = 0
        var sameRoundRepair = false
        var signalVerifications = 0
        var peerSignals = 0
        var preparesSent = 0
        var resyncs = 0
        var committedAck = false
        var pendingProbe: RelayRenewProbe.Frame? = null
        var heldCount = 0
        val held = LinkedHashMap<String, MutableList<RenewTransport.Candidate>>()
        val signaledReflexiveCandidates = LinkedHashSet<String>()
        val ackedNonces = LinkedHashMap<String, ByteArray>()
        val rids = ArrayList<Long>()

        private val timers = HashMap<String, Timer>()

        fun arm(key: String, delayMs: Long, task: () -> Unit) {
            timers.remove(key)?.cancel()
            timers[key] = deps.timers().schedule(delayMs) {
                timers.remove(key)
                if (!closed && attempt === this) task()
            }
        }

        fun cancel(key: String) {
            timers.remove(key)?.cancel()
        }

        fun cancelAll() {
            for (timer in timers.values) timer.cancel()
            timers.clear()
        }
    }

    /**
     * A committed epoch, kept alive for [RelayRenewWire.POST_COMMIT_ACK_MS].
     *
     * It can answer a probe from cache, verify a bounded number of nonces it
     * has not seen, and keep signing its own trickle candidates. It CANNOT
     * start a negotiation, move a deadline again, or be promoted back into an
     * attempt — there is no path in this file that does any of those from here,
     * and that is the point of it being a separate type.
     */
    private class Committed(
        val epoch: Long,
        val round: Long,
        val localUfrag: String,
        val ackedNonces: LinkedHashMap<String, ByteArray>,
        /** CARRIED OVER, never refilled: the eight are one epoch's total,
         *  before and after commit alike. */
        var ackVerifications: Int,
        var probeVerifications: Int,
    ) {
        var timer: Timer? = null
    }

    /**
     * Bounds a test needs to name, and a reader needs to find.
     *
     * Public because the owning suite asserts against them rather than
     * retyping the numbers — a bound repeated in a test is a bound that can
     * drift from the one the code enforces.
     */
    companion object {
        const val TIMER_EPOCH = "epoch"
        const val TIMER_PREPARE = "prepare"
        const val TIMER_PREPARE_RETRY = "prepare-retry"
        const val TIMER_ROUND = "round"
        const val TIMER_READY = "ready"
        const val TIMER_ICE = "ice"
        const val TIMER_PROBE = "probe"

        /**
         * Round requests in flight at once.
         *
         * One epoch asks once and only one epoch runs at a time, so two is
         * already slack: it covers the window where an aborted epoch's request
         * has not yet timed out while its successor asks.
         */
        const val MAX_INFLIGHT_ROUNDS = 2

        /** Resynchronisations to a `stale` reply, per attempt. */
        const val MAX_ROUND_RESYNCS = 1

        /**
         * Signal HMACs per epoch.
         *
         * A conforming epoch spends a prepare, a ready, one SDP, one abort and
         * up to [RelayRenewWire.MAX_HELD_CANDIDATES] candidates. Eight of slack
         * above that ceiling, and a hard stop rather than a growing queue.
         */
        const val MAX_SIGNAL_VERIFICATIONS = RelayRenewWire.MAX_HELD_CANDIDATES + 8

        /** See [idleSignalBudget]. */
        const val IDLE_SIGNAL_BUDGET = 8

        /** Acks retained for idempotent replay, per epoch. */
        const val MAX_ACKED_NONCES = RelayRenewWire.MAX_PROBE_VERIFICATIONS

        /**
         * The partition of [RelayRenewWire.MAX_PROBE_VERIFICATIONS].
         *
         * Four for inbound acks and four for inbound probes, eight in total,
         * spanning the whole epoch INCLUDING the post-commit window. A
         * conforming peer sends one nonce and retransmits it at most five
         * times, all of which are exact duplicates answered from cache without
         * a verification, so four new ones on each side is slack rather than a
         * constraint.
         */
        const val MAX_ACK_RESERVATION = RelayRenewWire.MAX_PROBE_VERIFICATIONS / 2
        const val MAX_PROBE_RESERVATION = RelayRenewWire.MAX_PROBE_VERIFICATIONS / 2

        /**
         * Epochs that may die before any configuration is issued.
         *
         * Bounded twice over besides: each waits
         * [RelayRenewPolicy.RETRY_BACKOFF_MS], and none may start past the
         * boundary the link already has — so on a normal one-hour grant the
         * ten-minute margin is the real limit and this is the backstop for a
         * short or accelerated one.
         */
        const val MAX_PREGRANT_ATTEMPTS = 6

        /**
         * Credential rounds whose migration spending is remembered.
         *
         * Bounded because the key is a uint32 a peer can influence through the
         * rounds it readies on. Rounds only move forward, so the lowest key is
         * the one that can no longer be reached and evicting it refunds
         * nothing that is still spendable.
         */
        const val MAX_TRACKED_ROUNDS = 8

        /** A scheduled delay of zero is a busy loop; the margin is not. */
        const val MIN_TICK_MS = 250L
    }
}
