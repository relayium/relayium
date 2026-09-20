package com.relayium.android.transport

import com.relayium.protocol.Crypto
import com.relayium.protocol.Json
import com.relayium.protocol.RelayRenewPolicy
import com.relayium.protocol.RelayRenewProbe
import com.relayium.protocol.RelayRenewSdp
import com.relayium.protocol.RelayRenewWire
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The renewal epoch machine, driven as a REAL PAIR.
 *
 * Two engines, two sets of genuinely derived session keys, real signed
 * envelopes and real 59-byte control frames passed between them. Nothing here
 * fakes an HMAC, a tag, a canonical payload or a commit: the only fakes are the
 * clock, the WebRTC surface and the socket, and none of them fabricates a
 * success an assertion depends on.
 *
 * That shape matters for this feature specifically. A single-sided test can be
 * made to pass by an engine that commits on its own ack, on an applied
 * configuration or on a server reply — each of which is a real way to hand a
 * user a link that has already stopped working. Requiring both ends to reach
 * their own commit, against each other, is what makes that impossible to fake.
 */
class RelayRenewEngineTest {

    // ── harness ─────────────────────────────────────────────────────────────

    /** A virtual clock. Tasks fire in due order when time is advanced. */
    private class FakeClock {
        var now = 1_790_000_000_000L
            private set

        private class Task(val at: Long, val seq: Long, val run: () -> Unit) {
            var cancelled = false
        }

        private val tasks = ArrayList<Task>()
        private var seq = 0L

        val timers = RelayRenewEngine.Timers { delayMs, task ->
            val entry = Task(now + delayMs, seq++, task)
            tasks.add(entry)
            RelayRenewEngine.Timer { entry.cancelled = true }
        }

        /** Advance, firing everything due, including what firing schedules. */
        fun advance(ms: Long) {
            val target = now + ms
            while (true) {
                val next = tasks.filter { !it.cancelled && it.at <= target }
                    .minWithOrNull(compareBy({ it.at }, { it.seq })) ?: break
                tasks.remove(next)
                now = maxOf(now, next.at)
                next.run.invoke()
            }
            now = target
        }

        val pendingCount: Int get() = tasks.count { !it.cancelled }
    }

    /** The WebRTC surface, as a recorder. Every ICE generation is explicit. */
    private class FakeTransport(private val isOfferer: Boolean) : RenewTransport {

        val applied = ArrayList<List<IceConfig.Server>>()
        val sentControl = ArrayList<ByteArray>()
        val addedCandidates = ArrayList<RenewTransport.Candidate>()
        var candidateSink: ((RenewTransport.Candidate) -> Unit)? = null
        var selectedSink: ((RenewTransport.SelectedPair) -> Unit)? = null
        var unsignedLocked = false
        var configurationFails = false
        var restartFails = false
        var remoteApplyFails = false
        var controlFails = false
        var generation = 0

        /** The description applied at epoch 0; the pin every later one meets. */
        var pin: RelayRenewSdp.Pin? = RelayRenewSdp.pin(BASELINE_SDP)
            private set

        /**
         * Whether this connection's session carries a SECOND m-line.
         *
         * Set through [useSecondMid] so the pin and the descriptions this fake
         * produces can never disagree about how many m-lines the session has —
         * a baseline pinned at two mids against offers carrying one would fail
         * the pin and never reach the observation this is meant to exercise.
         */
        private var secondMid = false

        /** Give this connection a two-m-line session, pin and all. */
        fun useSecondMid() {
            secondMid = true
            pin = RelayRenewSdp.pin(withSecondMid(BASELINE_SDP))
        }

        private fun localSdp(ufrag: String): String =
            sdpWithUfrag(ufrag).let { if (secondMid) withSecondMid(it) else it }

        private val localUfrags = ArrayList<String>()
        val lastLocalUfrag: String get() = localUfrags.lastOrNull().orEmpty()

        override fun applyConfiguration(servers: List<IceConfig.Server>): Boolean {
            if (configurationFails) return false
            applied.add(servers)
            return true
        }

        override fun createRenewOffer(onResult: (RenewTransport.LocalSdp?) -> Unit) {
            if (restartFails) { onResult(null); return }
            generation++
            val ufrag = "gen$generation${if (isOfferer) "O" else "A"}"
            localUfrags.add(ufrag)
            onResult(RenewTransport.LocalSdp(localSdp(ufrag), ufrag))
        }

        override fun createRenewAnswer(onResult: (RenewTransport.LocalSdp?) -> Unit) =
            createRenewOffer(onResult)

        override fun applyRemoteSdp(sdpType: String, sdp: String, onResult: (Boolean) -> Unit) {
            onResult(!remoteApplyFails)
        }

        override fun addCandidate(candidate: RenewTransport.Candidate): Boolean {
            addedCandidates.add(candidate)
            return true
        }

        override fun onCandidate(cb: ((RenewTransport.Candidate) -> Unit)?) { candidateSink = cb }
        override fun onSelectedPair(cb: ((RenewTransport.SelectedPair) -> Unit)?) { selectedSink = cb }
        override fun baselinePin(): RelayRenewSdp.Pin? = pin

        override fun sendControlFrame(frame: ByteArray): Boolean {
            if (controlFails) return false
            sentControl.add(frame)
            return true
        }

        override fun lockUnsignedSdp() { unsignedLocked = true }
    }

    /** One side: an engine, its fakes, and what it was told. */
    private class Side(
        val id: String,
        val peer: String,
        val keys: Crypto.SessionKeys,
        val initiator: Boolean,
        val clock: FakeClock,
    ) {
        val transport = FakeTransport(initiator)
        /** Undelivered, drained by the harness. */
        val sentSignals = ArrayList<Json>()
        /** EVERY signal this side ever produced, kept for assertions. */
        val allSignals = ArrayList<Json>()
        /** Undelivered round requests, drained by [answerRounds]. */
        val roundRequests = ArrayList<Pair<Long, Long>>()
        /** How many rounds this side ever asked the server for. */
        var roundsAsked = 0
        val states = ArrayList<RelayRenewEngine.State>()
        /** The boundary of the last commit that MOVED one. */
        var publishedDeadline: RelayRenewPolicy.Deadline? = null
        var deadlinePublishes = 0
        /** Every commit, whether or not it moved the boundary. */
        var lastCommit: RelayRenewEngine.Commit? = null
        var commits = 0
        /** The configurations actually applied to the connection, in order. */
        val installedConfigs = ArrayList<List<IceConfig.Server>>()
        var active = true
        var supportsRenew = true
        var hasServer = true
        var grantFor: ((Long, Long) -> Json?)? = null
        var nextNonce = 0
        var nextRid = 0

        lateinit var engine: RelayRenewEngine

        fun start() {
            engine = RelayRenewEngine(
                object : RelayRenewEngine.Deps {
                    override fun now(): Long = clock.now
                    override fun timers(): RelayRenewEngine.Timers = clock.timers
                    override fun selfId(): String = id
                    override fun peerId(): String = peer
                    override fun isInitiator(): Boolean = initiator
                    override fun keys(): Crypto.SessionKeys = keys
                    override fun transport(): RenewTransport = transport
                    override fun peerSupportsRenew(): Boolean = supportsRenew
                    override fun userActive(): Boolean = active
                    override fun sendRenew(data: Json) {
                        sentSignals.add(data)
                        allSignals.add(data)
                    }
                    override fun requestRound(round: Long, rid: Long): Boolean {
                        if (!hasServer) return false
                        roundsAsked++
                        roundRequests.add(round to rid)
                        return true
                    }
                    override fun randomBytes(count: Int): ByteArray =
                        ByteArray(count) { (nextNonce + it).toByte() }.also { nextNonce += 32 }
                    override fun randomUint32(): Long = (++nextRid).toLong()
                    override fun onConfigurationInstalled(servers: List<IceConfig.Server>) {
                        installedConfigs.add(servers)
                    }
                    override fun onRenewState(
                        state: RelayRenewEngine.State,
                        commit: RelayRenewEngine.Commit?,
                    ) {
                        states.add(state)
                        if (commit == null) return
                        commits++
                        lastCommit = commit
                        if (commit.boundaryMoved) {
                            publishedDeadline = commit.deadline
                            deadlinePublishes++
                        }
                    }
                },
            )
        }

        /** The expiry the default grant states, in unix seconds. */
        var lastGrantedExpirySeconds = 0L
            private set

        /**
         * Answer whatever round request is outstanding.
         *
         * The default grant is always a FRESH two hours from the current
         * virtual instant, which is what a real server issues: a fixed absolute
         * expiry would be refused on the second round for moving the boundary
         * earlier, which is correct behaviour and a broken fixture.
         */
        fun answerRounds() {
            while (roundRequests.isNotEmpty()) {
                val (round, rid) = roundRequests.removeAt(0)
                val grant = grantFor?.invoke(round, rid) ?: run {
                    lastGrantedExpirySeconds = (clock.now + 2 * HOUR) / 1000
                    grantedJson(round, rid, lastGrantedExpirySeconds)
                }
                engine.onGrant(grant)
            }
        }
    }

    // ── a wired pair ────────────────────────────────────────────────────────

    private val clock = FakeClock()

    private val pairA: Crypto.KeyPair = Crypto.generateKeyPair()
    private val pairB: Crypto.KeyPair = Crypto.generateKeyPair()

    // `peer-a` sorts below `peer-b`, so A is the link's established initiator
    // and is the only side that may offer.
    private val a = Side(
        "peer-a", "peer-b",
        Crypto.deriveSession(Crypto.Role.INITIATOR, pairA, pairB.publicKey),
        initiator = true, clock = clock,
    )
    private val b = Side(
        "peer-b", "peer-a",
        Crypto.deriveSession(Crypto.Role.RESPONDER, pairB, pairA.publicKey),
        initiator = false, clock = clock,
    )

    init {
        a.start()
        b.start()
    }

    /** Move only the SIGNALS one side has queued. */
    private fun deliverSignals(from: Side, to: Side) {
        val pending = ArrayList(from.sentSignals).also { from.sentSignals.clear() }
        for (signal in pending) to.engine.onSignal(signal)
    }

    /**
     * Move the CONTROL FRAMES one side has queued, optionally dropping a type.
     *
     * Dropping acks in one direction is how the asymmetric commit is built:
     * it is the ordinary consequence of one lost frame, not an injected fault.
     */
    private fun deliverFrames(from: Side, to: Side, dropType: Int? = null) {
        val pending = ArrayList(from.transport.sentControl)
            .also { from.transport.sentControl.clear() }
        for (frame in pending) {
            if (dropType != null && RelayRenewProbe.decode(frame)?.type == dropType) continue
            to.engine.onControlFrame(frame)
        }
    }

    /** Deliver everything each side has queued for the other, until quiet. */
    private fun flush(limit: Int = 200) {
        repeat(limit) {
            val toB = ArrayList(a.sentSignals).also { a.sentSignals.clear() }
            val toA = ArrayList(b.sentSignals).also { b.sentSignals.clear() }
            val framesToB = ArrayList(a.transport.sentControl).also { a.transport.sentControl.clear() }
            val framesToA = ArrayList(b.transport.sentControl).also { b.transport.sentControl.clear() }
            if (toB.isEmpty() && toA.isEmpty() && framesToB.isEmpty() && framesToA.isEmpty() &&
                a.roundRequests.isEmpty() && b.roundRequests.isEmpty()
            ) {
                return
            }
            for (signal in toB) b.engine.onSignal(signal)
            for (signal in toA) a.engine.onSignal(signal)
            for (frame in framesToB) b.engine.onControlFrame(frame)
            for (frame in framesToA) a.engine.onControlFrame(frame)
            a.answerRounds()
            b.answerRounds()
        }
        throw AssertionError("the two engines never went quiet")
    }

    /**
     * Both ICE agents report the pair each side's newest generation produced.
     *
     * Delivered the way the controller delivers it — the subscription is the
     * owner's, because the FIRST observation is what classifies the path and
     * decides whether the link is bounded at all, which is a question that
     * exists with or without a renewal in flight.
     */
    private fun observeBoth() {
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        b.engine.onSelectedPair(relayPair(b.transport.lastLocalUfrag))
    }

    private var marginOpensAt = 0L

    private fun bind(lifetimeMs: Long = HOUR) {
        val bound = boundFor(lifetimeMs)
        marginOpensAt = bound.renewAt
        a.engine.bindDeadline(bound)
        b.engine.bindDeadline(bound)
    }

    /**
     * Advance to the instant the renewal margin opens, and NOT one tick past
     * it.
     *
     * A single long jump would fire the epoch's own fifteen- and sixty-second
     * bounds inside the same advance, before the harness had delivered a
     * single frame — which is a test that times out rather than a link that
     * does. The bounds are asserted deliberately, elsewhere.
     */
    private fun openMargin(at: Long = marginOpensAt) {
        clock.advance(maxOf(0L, at - clock.now) + 1)
    }

    /**
     * Advance in small steps and STOP as soon as something happens.
     *
     * One long jump past a retry backoff runs the whole epoch it starts — the
     * ten-second prepare retry and the fifteen-second phase bound fire inside
     * the same advance, before the harness has answered a single request — so
     * the epoch dies of a timeout the test never meant to exercise. Stepping
     * lets the run stop at the moment the epoch begins, which is what a real
     * server answering in milliseconds would see.
     */
    private fun advanceUntil(maxMs: Long, step: Long = 1_000L, ready: () -> Boolean) {
        var spent = 0L
        while (spent < maxMs) {
            if (ready()) return
            clock.advance(step)
            spent += step
        }
    }

    /** Run one complete mutual renewal and return the two committed bounds. */
    private fun renewOnce(): Pair<RelayRenewPolicy.Deadline?, RelayRenewPolicy.Deadline?> {
        openMargin()
        flush()
        observeBoth()
        flush()
        return a.publishedDeadline to b.publishedDeadline
    }

    // ── the happy path, both roles ──────────────────────────────────────────

    @Test
    fun `both peers commit, and only after each observed its own new path`() {
        bind()
        openMargin()
        flush()

        // Everything short of §6.5 has happened: the configuration is applied,
        // the descriptions are exchanged. Neither side has committed.
        assertEquals(1, a.transport.applied.size)
        assertEquals(1, b.transport.applied.size)
        assertNull("an applied configuration is not a migration", a.publishedDeadline)
        assertNull("an exchanged description is not a migration", b.publishedDeadline)
        assertEquals(RelayRenewEngine.State.RENEWING, a.engine.currentState())

        observeBoth()
        flush()

        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertTrue(a.publishedDeadline!!.deadlineAt > clock.now)
        assertTrue(b.publishedDeadline!!.deadlineAt > clock.now)
        // The boundary came from the configuration RECEIVED, not from an
        // extension of the one the link had.
        assertEquals(a.lastGrantedExpirySeconds * 1000L, a.publishedDeadline!!.expiresAt)
        assertEquals(b.lastGrantedExpirySeconds * 1000L, b.publishedDeadline!!.expiresAt)
    }

    @Test
    fun `only the established initiator offers`() {
        bind()
        openMargin()
        flush()
        // B is the responder. Every SDP it produced is an answer, and A's is an
        // offer: two offers on one PeerConnection is glare neither side can
        // resolve.
        assertEquals(listOf("offer"), sdpTypesFrom(a))
        assertEquals(listOf("answer"), sdpTypesFrom(b))
    }

    @Test
    fun `two peers preparing at the same epoch coalesce into one attempt`() {
        bind()
        // Both margins open on the same tick, so both sides prepare at epoch 1
        // before either has heard the other. That must be ONE migration, not a
        // pair of competing ones.
        openMargin()
        assertTrue(a.sentSignals.isNotEmpty())
        assertTrue(b.sentSignals.isNotEmpty())
        flush()
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertEquals(1, a.transport.applied.size)
        assertEquals(1, b.transport.applied.size)
        assertEquals(1, a.roundRequestsSeen())
        assertEquals(1, b.roundRequestsSeen())
    }

    @Test
    fun `the responder may trigger, and the initiator still offers`() {
        // Only B's margin opens: A's grant is five minutes longer, which is
        // the shape two independent `/api/ice` round trips actually produce.
        // The epoch B opens is adopted by A, and A — the link's established
        // initiator — is still the only side that offers.
        val shorter = boundFor(HOUR)
        a.engine.bindDeadline(boundFor(HOUR + 5 * 60_000L))
        b.engine.bindDeadline(shorter)
        openMargin(shorter.renewAt)
        assertTrue("A is not due yet", a.sentSignals.isEmpty())
        assertTrue("B is", b.sentSignals.isNotEmpty())
        flush()
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertEquals(listOf("offer"), sdpTypesFrom(a))
        assertEquals(listOf("answer"), sdpTypesFrom(b))
    }

    @Test
    fun `an idle side refuses an adopted epoch aloud rather than by silence`() {
        bind()
        a.active = false
        a.engine.onSignal(signedPrepare(b, epoch = 1))
        assertEquals("no round is asked for while this side is idle", 0, a.roundRequestsSeen())
        // Answered, so the peer learns this build DOES implement renewal and
        // marks the round retryable rather than the link unsupported.
        val reply = RelayRenewWire.parseEnvelope(a.sentSignals.single())!!.message
        assertTrue(reply is RelayRenewWire.Message.Abort)
        assertEquals(
            RelayRenewWire.AbortReason.UNAVAILABLE,
            (reply as RelayRenewWire.Message.Abort).reason,
        )
    }

    @Test
    fun `two initial expiries that differ still renew from either side`() {
        // The two peers' grants legitimately differ — different `/api/ice`
        // round trips, different clocks. A is bounded an hour out, B ninety
        // minutes, so A's margin opens first and A is the one that triggers.
        val shorter = boundFor(HOUR)
        a.engine.bindDeadline(shorter)
        b.engine.bindDeadline(boundFor(90 * 60_000L))
        openMargin(shorter.renewAt)
        flush()
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
    }

    @Test
    fun `a second renewal runs on a later round and a later epoch`() {
        bind()
        renewOnce()
        val firstBound = a.publishedDeadline!!
        assertEquals(1, a.deadlinePublishes)

        // The committed boundary is an hour out again; its own margin opens
        // fifty minutes later.
        clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
        openMargin(a.publishedDeadline!!.renewAt)
        flush()
        observeBoth()
        flush()

        assertEquals(2, a.deadlinePublishes)
        assertTrue(a.publishedDeadline!!.deadlineAt > firstBound.deadlineAt)
        // Round 2, and a fresh epoch: nothing reused.
        assertTrue(a.transport.applied.size == 2)
    }

    // ── nothing short of a commit moves a boundary ──────────────────────────

    @Test
    fun `a new path that never becomes the selected one never extends anything`() {
        bind()
        openMargin()
        flush()
        // The ICE agent keeps reporting the OLD generation, which is exactly
        // the post-restart shape a scanning implementation misreads.
        a.engine.onSelectedPair(relayPair("oldGeneration"))
        b.engine.onSelectedPair(relayPair("oldGeneration"))
        flush()
        assertNull(a.publishedDeadline)
        assertNull(b.publishedDeadline)

        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        assertNull("the epoch timed out and the old boundary stands", a.publishedDeadline)
        assertEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
    }

    @Test
    fun `observation cannot begin before both descriptions are applied`() {
        bind()
        openMargin()
        // Let A produce and send its offer, but deliver NOTHING back: A has its
        // own new generation and no answer at all.
        a.answerRounds()
        val offerEpoch = ArrayList(a.sentSignals)
        assertTrue(offerEpoch.isNotEmpty())
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        // A pair formed here can have its far end entirely on the previous
        // generation. Observation must not hold, so no probe goes out.
        assertTrue(a.transport.sentControl.isEmpty())
    }

    @Test
    fun `a dropped ack leaves the sender on its old boundary`() {
        bind()
        openMargin()
        flush()
        observeBoth()
        // Deliver A's probe to B and B's ack back, but drop everything B sent
        // A afterwards by clearing it.
        val aProbes = ArrayList(a.transport.sentControl).also { a.transport.sentControl.clear() }
        for (frame in aProbes) b.engine.onControlFrame(frame)
        b.transport.sentControl.clear()
        assertNull("no ack reached A, so A did not commit", a.publishedDeadline)
        assertNull("B needs its own ack too", b.publishedDeadline)
    }

    @Test
    fun `a committed epoch still answers a retransmitted probe`() {
        bind()
        openMargin()
        flush()
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())

        // B's ack to A arrived; A's ack to B was lost, so B retransmits. If A
        // tore its epoch down on its own commit, this would be dropped and B
        // would time out holding an expiring boundary while A believed the
        // migration was shared.
        val retransmit = probeFrom(b, a, epoch = 1, round = 1, nonce = ByteArray(16) { 7 })
        a.transport.sentControl.clear()
        a.engine.onControlFrame(retransmit)
        assertEquals(1, a.transport.sentControl.size)
        val ack = RelayRenewProbe.decode(a.transport.sentControl.first())!!
        assertEquals(RelayRenewProbe.TYPE_ACK, ack.type)
        assertTrue(RelayRenewProbe.verify(b.keys, ack, "peer-a", "peer-b"))

        // And an EXACT duplicate is answered from cache without spending an
        // HMAC — while the same nonce under a DIFFERENT tag is not.
        a.transport.sentControl.clear()
        a.engine.onControlFrame(retransmit)
        assertEquals(1, a.transport.sentControl.size)
        val forged = retransmit.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
        a.transport.sentControl.clear()
        a.engine.onControlFrame(forged)
        assertTrue("a reused nonce with a forged tag earns nothing", a.transport.sentControl.isEmpty())
    }

    @Test
    fun `the committed window closes and stops answering`() {
        bind()
        renewOnce()
        clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
        a.transport.sentControl.clear()
        a.engine.onControlFrame(probeFrom(b, a, 1, 1, ByteArray(16) { 9 }))
        assertTrue(a.transport.sentControl.isEmpty())
    }

    // ── refusals ────────────────────────────────────────────────────────────

    @Test
    fun `a denied round is terminal and mints nothing`() {
        bind()
        a.grantFor = { round, rid -> deniedJson(round, rid) }
        openMargin()
        a.answerRounds()
        assertEquals(RelayRenewEngine.State.DENIED, a.engine.currentState())
        assertNull(a.publishedDeadline)
        assertTrue(a.transport.applied.isEmpty())

        // And asking again inside this round cannot help, so nothing does.
        val before = a.roundRequests.size
        clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + 5 * RelayRenewPolicy.TICK_MS)
        assertEquals(before, a.roundRequests.size)
    }

    @Test
    fun `a grant that bounds nothing is refused rather than treated as forever`() {
        bind()
        a.grantFor = { round, rid -> grantedJson(round, rid, expirySeconds = null) }

        openMargin()
        a.answerRounds()
        assertEquals(RelayRenewEngine.State.DENIED, a.engine.currentState())
        assertNull(a.publishedDeadline)
    }

    @Test
    fun `a grant that would move the boundary earlier is refused`() {
        bind()
        // Half an hour out, against a boundary an hour out: migrating onto it
        // would retire a live allocation for a shorter-lived one.
        a.grantFor = { round, rid ->
            // Five minutes from NOW, against a boundary that is still nine
            // minutes out: migrating onto it would retire a live allocation
            // for a shorter-lived one.
            grantedJson(round, rid, expirySeconds = (clock.now + 5 * 60_000L) / 1000)
        }
        openMargin()
        a.answerRounds()
        assertEquals(RelayRenewEngine.State.DENIED, a.engine.currentState())
        assertNull(a.publishedDeadline)
    }

    @Test
    fun `an unanswered server means the link keeps the boundary it has`() {
        bind()
        a.hasServer = false
        openMargin()
        assertEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
        assertNull(a.publishedDeadline)

        // An older server that simply ignores `ice-renew` is silence, which is
        // the same answer after the bounded wait.
        a.hasServer = true
        a.grantFor = { _, _ -> null }
        clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS)
        a.roundRequests.clear()
        clock.advance(RelayRenewWire.ROUND_TIMEOUT_MS + 1)
        assertNull(a.publishedDeadline)
    }

    @Test
    fun `a replayed prepare for a spent epoch starts nothing`() {
        bind()
        openMargin()
        flush()
        observeBoth()
        flush()
        assertEquals(1, a.roundRequestsSeen())

        // A correctly signed `prepare` for epoch 1 stays valid forever. Acting
        // on it would open a second attempt at a number already spent — and
        // each attempt asks the server for a round.
        a.engine.onSignal(signedPrepare(b, epoch = 1))
        a.engine.onSignal(signedPrepare(b, epoch = 1))
        assertEquals(1, a.roundRequestsSeen())
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
    }

    @Test
    fun `a fourth epoch on one round is refused`() {
        bind()
        // The ICE restart never happens, so every epoch reaches the offer and
        // fails there — the failure furthest into the exchange, which is the
        // one that proves the budget is per ROUND and not per phase.
        a.transport.restartFails = true
        openMargin()
        repeat(8) {
            flush()
            clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
        }
        // Counted in MIGRATIONS — configurations actually accepted onto the
        // connection — not in requests. A request the server answers with a
        // round this link has already spent three epochs on is refused before
        // it reaches the `PeerConnection`, so it is not a migration at all.
        assertEquals(
            "three migration epochs per credential round, and no more",
            RelayRenewWire.MAX_EPOCHS_PER_ROUND,
            a.transport.applied.size,
        )
        assertNull(a.publishedDeadline)
    }

    @Test
    fun `an unsigned or malformed envelope is dropped in silence`() {
        bind()
        val before = a.sentSignals.size
        // A valid message body with a tag that is not this link's.
        val forged = RelayRenewWire.envelopeJson(
            RelayRenewWire.Message.Prepare(9),
            "A".repeat(RelayRenewWire.AUTH_LENGTH),
        )
        a.engine.onSignal(forged)
        // The shapes the fixture rejects, once more through the engine.
        a.engine.onSignal(Json.obj("link" to Json.of(true)))
        a.engine.onSignal(Json.of("nonsense") as Json)
        assertEquals(before, a.sentSignals.size)
        assertFalse("a forged signal must not lock the transport", a.transport.unsignedLocked)
    }

    @Test
    fun `a verified renewal signal locks unsigned SDP for the rest of the link`() {
        bind()
        assertFalse(a.transport.unsignedLocked)
        a.engine.onSignal(signedPrepare(b, epoch = 4))
        assertTrue(a.transport.unsignedLocked)
    }

    @Test
    fun `a peer that never answers a prepare is reported unsupported, not renewed`() {
        bind()
        // B is silent: its signals are never delivered.
        openMargin()
        a.answerRounds()
        a.sentSignals.clear()
        clock.advance(RelayRenewWire.PREPARE_TO_READY_MS + 1)
        assertEquals(RelayRenewEngine.State.UNSUPPORTED, a.engine.currentState())
        assertNull(a.publishedDeadline)
        // And it never tries again on this link.
        val before = a.roundRequestsSeen()
        clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + 5 * RelayRenewPolicy.TICK_MS)
        assertEquals(before, a.roundRequestsSeen())
    }

    @Test
    fun `a peer that did not announce the capability is never asked`() {
        bind()
        a.supportsRenew = false
        openMargin()
        assertEquals(0, a.roundRequestsSeen())
        assertEquals(RelayRenewEngine.State.IDLE, a.engine.currentState())
    }

    // ── the consent gate ────────────────────────────────────────────────────

    @Test
    fun `an idle link inside its margin asks for nothing`() {
        bind()
        a.active = false
        clock.advance(55 * 60_000L)
        assertEquals(0, a.roundRequestsSeen())
        assertEquals(RelayRenewEngine.State.IDLE, a.engine.currentState())
    }

    @Test
    fun `user data after the margin has already opened still triggers a renewal`() {
        bind()
        a.active = false
        // The margin is open and nothing happens, because nobody is using the
        // link.
        openMargin()
        assertEquals(0, a.roundRequestsSeen())
        // Five minutes later — still inside the margin, still before the
        // boundary — a real message moves. The margin is a window, not a
        // moment.
        clock.advance(5 * 60_000L)
        a.active = true
        a.engine.noteUserData()
        assertEquals(1, a.roundRequestsSeen())
    }

    @Test
    fun `nothing is asked past the boundary the link already has`() {
        bind()
        a.active = false
        clock.advance(HOUR)
        a.active = true
        a.engine.noteUserData()
        assertEquals("no blind retry past the old deadline", 0, a.roundRequestsSeen())
    }

    @Test
    fun `a link nothing bounds makes no backend call at all`() {
        // The Nearby and LAN answer: no boundary is ever bound, so no tick, no
        // round request, no epoch. Ever.
        a.engine.bindDeadline(null)
        clock.advance(24 * 60 * 60_000L)
        assertEquals(0, a.roundRequestsSeen())
        assertEquals(0, a.sentSignals.size)
        assertEquals(RelayRenewEngine.State.IDLE, a.engine.currentState())
    }

    @Test
    fun `an already-dead credential is never renewed`() {
        a.engine.bindDeadline(boundFor(-HOUR))
        clock.advance(RelayRenewPolicy.TICK_MS * 10)
        assertEquals(0, a.roundRequestsSeen())
    }

    // ── candidate binding ───────────────────────────────────────────────────

    @Test
    fun `a local candidate from another generation is dropped rather than sent`() {
        bind()
        openMargin()
        flush()
        val before = a.sentSignals.size
        a.transport.candidateSink!!(
            RenewTransport.Candidate(candidateWithUfrag("someOtherGeneration"), "0", 0),
        )
        assertEquals("a candidate this epoch cannot claim is not signed", before, a.sentSignals.size)

        a.transport.candidateSink!!(
            RenewTransport.Candidate(candidateWithUfrag(a.transport.lastLocalUfrag), "0", 0),
        )
        assertEquals(before + 1, a.sentSignals.size)
        val message = RelayRenewWire.parseEnvelope(a.sentSignals.last())!!.message
        assertTrue(message is RelayRenewWire.Message.Ice)
        assertEquals(a.transport.lastLocalUfrag, (message as RelayRenewWire.Message.Ice).usernameFragment)
    }

    @Test
    fun `an inbound candidate whose two ufrag sources disagree is dropped`() {
        bind()
        openMargin()
        flush()
        val before = a.transport.addedCandidates.size
        a.engine.onSignal(
            signedIce(
                b, epoch = 1, round = 1,
                candidate = candidateWithUfrag(a.transport.lastLocalUfrag),
                usernameFragment = "aDifferentClaim",
            ),
        )
        assertEquals(before, a.transport.addedCandidates.size)
    }

    @Test
    fun `held inbound candidates are bounded`() {
        bind()
        openMargin()
        // Only answer the round, so no remote description is applied yet and
        // everything inbound is held.
        a.answerRounds()
        repeat(RelayRenewWire.MAX_HELD_CANDIDATES + 20) { i ->
            a.engine.onSignal(
                signedIce(
                    b, epoch = 1, round = 1,
                    candidate = candidateWithUfrag("remoteGen$i"),
                    usernameFragment = "remoteGen$i",
                ),
            )
        }
        // Nothing reached the stack — they are held — and the bound held.
        assertTrue(a.transport.addedCandidates.isEmpty())
    }

    // ── disposal ────────────────────────────────────────────────────────────

    @Test
    fun `close disposes everything and nothing can resurrect an epoch`() {
        bind()
        openMargin()
        flush()
        a.engine.close()
        a.sentSignals.clear()
        a.transport.sentControl.clear()
        val requestsBefore = a.roundRequestsSeen()

        a.engine.onSignal(signedPrepare(b, epoch = 9))
        a.engine.onControlFrame(probeFrom(b, a, 1, 1, ByteArray(16) { 3 }))
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        a.engine.noteUserData()
        clock.advance(2 * HOUR)

        assertTrue(a.sentSignals.isEmpty())
        assertTrue(a.transport.sentControl.isEmpty())
        assertEquals(requestsBefore, a.roundRequestsSeen())
        assertNull(a.transport.candidateSink)
    }

    @Test
    fun `an epoch is bounded even when every phase makes some progress`() {
        bind()
        a.transport.remoteApplyFails = true
        openMargin()
        flush()
        assertEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
        assertNull(a.publishedDeadline)
        // Every timer this epoch armed is gone.
        clock.advance(2 * HOUR)
        assertNotEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
    }

    // ── the early observation (D1 / R6) ─────────────────────────────────────

    /**
     * The selected pair can settle BEFORE the epoch's answer is applied.
     *
     * An implementation that tested the pair only at arrival would throw that
     * event away and then wait for an ICE agent that has already decided — so
     * the epoch times out against a path that in fact migrated, and the link
     * dies on a credential it could have replaced. The event is retained and
     * re-evaluated once both descriptions are in.
     */
    @Test
    fun `a selected pair reported before the answer is applied still proves the path`() {
        bind()
        openMargin()
        // Both sides prepare and ready; A, the initiator, then creates and
        // applies its ICE-restart offer. At this point A has its OWN new
        // generation and no answer at all.
        a.answerRounds()
        b.answerRounds()
        deliverSignals(a, b)
        deliverSignals(b, a)
        b.answerRounds()
        deliverSignals(b, a)
        assertTrue("A applied its renewal offer", a.transport.lastLocalUfrag.isNotEmpty())
        assertTrue("and holds no answer yet", a.transport.sentControl.isEmpty())

        // The ICE agent settles on the new generation NOW.
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        assertTrue(
            "one description is not proof of a migrated path",
            a.transport.sentControl.isEmpty(),
        )

        // The answer arrives. The RETAINED observation is what completes the
        // proof — an implementation that discarded the event above would sit
        // here waiting for an agent that has already decided.
        deliverSignals(a, b)
        deliverSignals(b, a)
        assertTrue(
            "the cached event was re-evaluated once both descriptions were applied",
            a.transport.sentControl.isNotEmpty(),
        )

        b.engine.onSelectedPair(relayPair(b.transport.lastLocalUfrag))
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
    }

    @Test
    fun `a pair cached from an earlier generation proves nothing`() {
        bind()
        // An observation from before any renewal: the epoch-0 generation.
        a.engine.onSelectedPair(relayPair("baseline"))
        openMargin()
        flush()
        // Both descriptions are applied and a cached pair exists — and it is
        // still refused, because it names the generation being migrated AWAY
        // from. That refusal is what makes retaining it safe.
        assertTrue(a.transport.sentControl.isEmpty())
        assertNull(a.publishedDeadline)
        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        assertNull("the old boundary stands", a.publishedDeadline)
    }

    @Test
    fun `a remote candidate naming another generation is refused`() {
        bind()
        openMargin()
        flush()
        // The local half matches this epoch; the remote half still names the
        // previous one, so the far end has not migrated and the pair is not
        // proof of a new path.
        a.engine.onSelectedPair(
            RenewTransport.SelectedPair(
                local = candidateWithUfrag(a.transport.lastLocalUfrag),
                remote = candidateWithUfrag("theirOldGeneration"),
            ),
        )
        assertTrue(a.transport.sentControl.isEmpty())
        assertNull(a.publishedDeadline)
    }

    @Test
    fun `a remote candidate that states no generation is accepted rather than guessed`() {
        bind()
        openMargin()
        flush()
        // Not every stack emits the ufrag extension. Refusing here would make
        // renewal impossible against such a peer; inventing a generation for it
        // would be a path fact nobody established. The protocol's dual-endpoint
        // proof still has to complete either way.
        a.engine.onSelectedPair(
            RenewTransport.SelectedPair(
                local = candidateWithUfrag(a.transport.lastLocalUfrag),
                remote = "candidate:2 1 udp 100 203.0.113.10 54322 typ relay generation 0",
            ),
        )
        assertTrue("a probe went out, so observation held", a.transport.sentControl.isNotEmpty())
    }

    @Test
    fun `generation attributed prflx to relay commits on both peers`() {
        bind()
        openMargin()
        flush()
        val local = candidateWithUfrag(a.transport.lastLocalUfrag).replace("typ relay", "typ prflx")
        a.engine.onSelectedPair(RenewTransport.SelectedPair(local, candidateWithUfrag(b.transport.lastLocalUfrag)))
        b.engine.onSelectedPair(RenewTransport.SelectedPair(candidateWithUfrag(b.transport.lastLocalUfrag), local))
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertNotNull(a.publishedDeadline)
        assertNotNull(b.publishedDeadline)
    }

    @Test
    fun `generation attributed prflx still needs the peers fresh acknowledgement`() {
        bind()
        openMargin()
        flush()
        a.engine.onSelectedPair(RenewTransport.SelectedPair(
            candidateWithUfrag(a.transport.lastLocalUfrag).replace("typ relay", "typ prflx"),
            candidateWithUfrag(b.transport.lastLocalUfrag),
        ))
        assertTrue("observation starts a real probe", a.transport.sentControl.isNotEmpty())
        // The peer has not selected its new generation and cannot acknowledge.
        flush()
        assertNull(a.publishedDeadline)
        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        assertNull(a.publishedDeadline)
    }

    @Test
    fun `unattributed or stale prflx and a stale remote never prove migration`() {
        bind()
        openMargin()
        flush()
        val current = candidateWithUfrag(a.transport.lastLocalUfrag).replace("typ relay", "typ prflx")
        val remote = candidateWithUfrag(b.transport.lastLocalUfrag)
        for (pair in listOf(
            RenewTransport.SelectedPair(candidateWithUfrag("old").replace("typ relay", "typ prflx"), remote),
            RenewTransport.SelectedPair(current.replace("ufrag " + a.transport.lastLocalUfrag, ""), remote),
            RenewTransport.SelectedPair(current, candidateWithUfrag("old")),
        )) {
            a.engine.onSelectedPair(pair)
            assertTrue(a.transport.sentControl.isEmpty())
            assertNull(a.publishedDeadline)
        }
    }

    @Test
    fun `selected reflexive address is signed once so the peers new relay can check it`() {
        bind()
        openMargin()
        flush()
        val local = candidateWithUfrag(a.transport.lastLocalUfrag).replace("typ relay", "typ prflx")
        val halfMigrated = RenewTransport.SelectedPair(local, candidateWithUfrag("oldRemote"))
        repeat(3) { a.engine.onSelectedPair(halfMigrated) }
        flush()
        assertEquals(listOf(local), b.transport.addedCandidates.map { it.candidate })
        assertTrue("an old remote generation cannot start the proof", a.transport.sentControl.isEmpty())
        assertNull(a.publishedDeadline)
        assertNull(b.publishedDeadline)
        a.engine.onSelectedPair(RenewTransport.SelectedPair(local, candidateWithUfrag(b.transport.lastLocalUfrag)))
        b.engine.onSelectedPair(RenewTransport.SelectedPair(candidateWithUfrag(b.transport.lastLocalUfrag), local))
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertEquals("a repeated selection is not signalled twice", 1, b.transport.addedCandidates.size)
    }

    @Test
    fun `selected reflexive discovery is bounded and never relabels an old candidate`() {
        bind()
        openMargin()
        flush()
        a.engine.onSelectedPair(RenewTransport.SelectedPair(
            candidateWithUfrag("old").replace("typ relay", "typ prflx"), candidateWithUfrag("oldRemote"),
        ))
        flush()
        assertTrue(b.transport.addedCandidates.isEmpty())
        val local = candidateWithUfrag(a.transport.lastLocalUfrag).replace("typ relay", "typ prflx")
        repeat(RelayRenewWire.MAX_HELD_CANDIDATES + 2) { n ->
            a.engine.onSelectedPair(RenewTransport.SelectedPair(
                local.replace("candidate:", "candidate:x$n"), candidateWithUfrag("oldRemote"),
            ))
            flush()
        }
        assertEquals(RelayRenewWire.MAX_HELD_CANDIDATES, b.transport.addedCandidates.size)
        assertNull(a.publishedDeadline)
        assertNull(b.publishedDeadline)
    }

    /**
     * A session with TWO m-lines publishes no discovered address at all.
     *
     * The publication binds a discovered address to a single mid at m-line
     * index 0. That binding is only meaningful when the session HAS one
     * m-line: with two, index 0 and the chosen mid can disagree, and the peer
     * would add the candidate against the wrong m-line. The guard is
     * `mids.singleOrNull()`, and this pins its behaviour rather than its
     * spelling — a change to `firstOrNull()` publishes a mismatched pair and
     * turns this red.
     *
     * The discovery aid disappearing must not make the proof lie in either
     * direction, so both halves are asserted: an old remote still proves
     * nothing, and a genuinely migrated pair still commits.
     */
    @Test
    fun `a two m-line session publishes no discovered address and still proves truthfully`() {
        bind()
        a.transport.useSecondMid()
        b.transport.useSecondMid()
        openMargin()
        flush()
        // The epoch really did negotiate — otherwise "nothing was published"
        // would be true for the uninteresting reason.
        assertTrue("the epoch obtained a configuration", a.transport.applied.isNotEmpty())
        assertTrue(a.transport.lastLocalUfrag.isNotEmpty())
        // The precondition this test exists for, stated rather than assumed: a
        // one-mid session here would make every assertion below pass for the
        // uninteresting reason. Its single-mid twin — `selected reflexive
        // address is signed once so the peers new relay can check it` — shows
        // the SAME pair shape does publish when there is exactly one mid, so
        // the two together bracket the guard.
        assertEquals(listOf("0", "1"), a.transport.baselinePin()!!.mids)

        val local = candidateWithUfrag(a.transport.lastLocalUfrag).replace("typ relay", "typ prflx")
        repeat(3) {
            a.engine.onSelectedPair(RenewTransport.SelectedPair(local, candidateWithUfrag("oldRemote")))
        }
        flush()
        assertTrue(
            "a discovered address cannot be bound to one m-line when the session has two",
            b.transport.addedCandidates.isEmpty(),
        )
        assertTrue("an old remote generation cannot start the proof", a.transport.sentControl.isEmpty())
        assertNull(a.publishedDeadline)
        assertNull(b.publishedDeadline)

        // The guard suppresses the DISCOVERY AID only. A pair whose both halves
        // name this epoch still proves the path and still commits.
        a.engine.onSelectedPair(
            RenewTransport.SelectedPair(local, candidateWithUfrag(b.transport.lastLocalUfrag)),
        )
        b.engine.onSelectedPair(
            RenewTransport.SelectedPair(candidateWithUfrag(b.transport.lastLocalUfrag), local),
        )
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertTrue(
            "the proof needs no publication, so none appears even now",
            b.transport.addedCandidates.isEmpty(),
        )
    }

    /**
     * Only a PEER-REFLEXIVE selected candidate is republished.
     *
     * Every other type was gathered by the agent and has already travelled as
     * an ordinary trickled candidate, so signalling it again would spend the
     * peer's per-epoch verification budget to tell it something it was told.
     * Peer-reflexive is the one type the agent never gathered and therefore the
     * one the peer cannot otherwise learn.
     */
    @Test
    fun `a selected local candidate that is not peer-reflexive is never republished`() {
        bind()
        openMargin()
        flush()
        assertTrue(a.transport.lastLocalUfrag.isNotEmpty())
        for (type in listOf("relay", "srflx", "host")) {
            val local = candidateWithUfrag(a.transport.lastLocalUfrag)
                .replace("typ relay", "typ $type")
            repeat(2) {
                a.engine.onSelectedPair(
                    RenewTransport.SelectedPair(local, candidateWithUfrag("oldRemote")),
                )
            }
            flush()
            assertTrue(
                "a $type candidate was already trickled by the ordinary path",
                b.transport.addedCandidates.isEmpty(),
            )
        }
        // …while the peer-reflexive one, identical in every other respect, IS
        // published. Without this contrast the loop above would also pass on an
        // engine that published nothing at all.
        val reflexive = candidateWithUfrag(a.transport.lastLocalUfrag)
            .replace("typ relay", "typ prflx")
        a.engine.onSelectedPair(
            RenewTransport.SelectedPair(reflexive, candidateWithUfrag("oldRemote")),
        )
        flush()
        assertEquals(listOf(reflexive), b.transport.addedCandidates.map { it.candidate })
        assertNull("none of this is a migration", a.publishedDeadline)
        assertNull(b.publishedDeadline)
    }

    // ── a peer ready that arrives before this side's own grant (W8) ─────────

    /**
     * The server answers one peer a second sooner than the other.
     *
     * That peer readies immediately, so its `ready` lands here BEFORE this side
     * has any configuration at all. A client that dropped it would then wait
     * for a message already sent while the peer waited for the offer that
     * message was supposed to unblock — both idle until the epoch times out, on
     * every attempt, for no reason but the order two replies happened to
     * arrive in.
     *
     * Driven for BOTH roles, because the two do different things with it: the
     * initiator has to offer once it has its own config, and the responder has
     * to wait for that offer without having discarded the ready that justifies
     * it.
     */
    private fun delayedGrantReachesMigration(slow: Side, fast: Side) {
        bind()
        openMargin()
        // The fast side gets its grant and readies; the slow side has asked and
        // heard nothing.
        fast.answerRounds()
        deliverSignals(fast, slow)
        assertTrue("the slow side has no configuration yet", slow.transport.applied.isEmpty())
        deliverSignals(slow, fast)

        // …and only now does the slow side's own grant arrive.
        slow.answerRounds()
        flush()
        assertTrue(
            "the retained ready let the epoch negotiate once the config landed",
            slow.transport.applied.isNotEmpty(),
        )
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertTrue(a.lastCommit!!.boundaryMoved)
        assertTrue(b.lastCommit!!.boundaryMoved)
    }

    @Test
    fun `a ready before the initiator's own grant still reaches a migration`() {
        delayedGrantReachesMigration(slow = a, fast = b)
        // The initiator still offers, and is the only side that does.
        assertEquals(listOf("offer"), sdpTypesFrom(a))
        assertEquals(listOf("answer"), sdpTypesFrom(b))
    }

    @Test
    fun `a ready before the responder's own grant still reaches a migration`() {
        delayedGrantReachesMigration(slow = b, fast = a)
        assertEquals(listOf("offer"), sdpTypesFrom(a))
        assertEquals(listOf("answer"), sdpTypesFrom(b))
    }

    /**
     * An ordinary early ready must not be swallowed by the repair path.
     *
     * On the FIRST renewal nothing is installed, so there is nothing to adopt
     * and the only correct behaviour is to retain the message — the case the
     * repair must not quietly take over.
     */
    @Test
    fun `an early ready on the first renewal is retained, not adopted`() {
        bind()
        openMargin()
        b.answerRounds()
        deliverSignals(b, a)
        assertTrue(
            "nothing was installed, so nothing could be adopted",
            a.transport.applied.isEmpty(),
        )
        assertNotEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
        a.answerRounds()
        flush()
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertTrue("a first renewal really does move the boundary", a.lastCommit!!.boundaryMoved)
    }

    /**
     * Adopting a configuration this side applied but was never BOUNDED by is an
     * advance, not a repair.
     *
     * An epoch that applied round R's configuration and then failed leaves the
     * connection running on R while the deadline still comes from R−1. Treating
     * a later adoption of R as "same round" would commit the migration and then
     * let the link die on the deadline it had just replaced.
     */
    @Test
    fun `adopting a config ahead of the committed round moves the boundary`() {
        bind()
        // A's ICE restart will not happen, so its epoch reaches the offer and
        // dies there — AFTER it has applied round 1's configuration. The
        // connection is left running on round 1 while A's deadline still comes
        // from the original grant.
        a.transport.restartFails = true
        openMargin()
        flush()
        assertEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
        assertTrue("round 1's configuration was applied", a.transport.applied.isNotEmpty())
        assertNull("but A was never BOUNDED by it", a.publishedDeadline)

        // A later epoch, with the restart working again, readies on round 1 —
        // exactly what A already holds.
        a.transport.restartFails = false
        a.sentSignals.clear()
        a.roundRequests.clear()
        val appliedBefore = a.transport.applied.size
        a.engine.onSignal(signedPrepare(b, epoch = 30))
        a.engine.onSignal(signed(b, RelayRenewWire.Message.Ready(30, 1)))

        assertEquals(
            "A adopted the configuration it already held, with no new issuance",
            appliedBefore + 1,
            a.transport.applied.size,
        )
        // The epoch had already asked for the next round when the peer's
        // prepare adopted it — adoption cannot un-send that — so what matters
        // is that it was FENCED: a late reply changes nothing.
        val abandoned = ArrayList(a.roundRequests).also { a.roundRequests.clear() }
        val appliedAfterAdoption = a.transport.applied.size
        for ((round, rid) in abandoned) {
            a.engine.onGrant(grantedJson(round, rid, (clock.now + 6 * HOUR) / 1000))
            a.engine.onGrant(deniedJson(round, rid))
        }
        assertEquals(
            "a late reply for the abandoned round installed nothing",
            appliedAfterAdoption,
            a.transport.applied.size,
        )

        // Complete it. This is an ADVANCE, not a repair: A had never been
        // bounded by round 1, so committing on it must move the boundary —
        // otherwise the link commits a migration and then dies on the deadline
        // it just replaced.
        //
        // A offered on adoption; the peer's answer is what puts BOTH
        // descriptions in place, which observation may not begin without.
        a.engine.onSignal(
            signed(
                b,
                RelayRenewWire.Message.Sdp(30, 1, "answer", sdpWithUfrag("peerGen30")),
            ),
        )
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        val probe = a.transport.sentControl.mapNotNull { RelayRenewProbe.decode(it) }
            .first { it.isProbe }
        a.engine.onControlFrame(
            RelayRenewProbe.sign(
                b.keys, RelayRenewProbe.TYPE_ACK, "peer-b", "peer-a",
                probe.epoch, probe.round, probe.nonce,
            )!!,
        )
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertTrue(
            "a credential this side was never bounded by is an advance",
            a.lastCommit!!.boundaryMoved,
        )
        assertNotNull(a.publishedDeadline)
    }

    // ── the same-round repair (R4) ──────────────────────────────────────────

    /**
     * Drive the asymmetry the repair exists for.
     *
     * B commits round 1; A does not. B's next request is for round 2, which the
     * server will not issue to one peer alone, while A re-fetches the cached
     * round 1 and readies on it. Without the repair the two sit on different
     * rounds until the epoch times out — every time — and the link dies on a
     * credential both ends already hold.
     */
    private fun leaveOnlyBCommitted(): Long {
        bind()
        openMargin()
        flush()
        observeBoth()
        // Both sides probe. Everything is delivered EXCEPT B's acks to A — one
        // lost frame, which is all the asymmetry takes. B then holds A's ack
        // for its own nonce and commits; A never sees an ack for its own and
        // times out with the boundary it had.
        repeat(4) {
            deliverFrames(a, b)
            deliverFrames(b, a, dropType = RelayRenewProbe.TYPE_ACK)
        }
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        assertNull("A never saw an ack for its own nonce", a.publishedDeadline)
        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        a.sentSignals.clear()
        b.sentSignals.clear()
        a.transport.sentControl.clear()
        b.transport.sentControl.clear()
        return b.lastCommit!!.deadline!!.deadlineAt
    }

    /**
     * Drive the repair itself.
     *
     * Only A's margin is open — A still holds the ORIGINAL boundary, because it
     * never committed — so A is the side that retries. B adopts A's epoch, asks
     * the server for the round after the one IT holds, and gets nothing: the
     * server will not issue a round to one peer alone. A meanwhile is served
     * the cached round 1. B then sees a signed `ready` for exactly the round it
     * already has installed.
     *
     * Returns B's still-outstanding request, so a test can replay it late.
     */
    private fun runRepair(): List<Pair<Long, Long>> {
        // Past the post-commit ack window, so nothing is carried by it, then
        // out to A's retry backoff — stopping the moment A asks, so its own
        // phase bounds do not run the epoch to death first.
        clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
        advanceUntil(3 * RelayRenewPolicy.RETRY_BACKOFF_MS) { a.roundRequests.isNotEmpty() }
        a.answerRounds()
        val fromA = ArrayList(a.sentSignals).also { a.sentSignals.clear() }
        assertTrue("A re-prepared and readied on the cached round", fromA.size >= 2)
        for (signal in fromA) b.engine.onSignal(signal)
        return ArrayList(b.roundRequests).also { b.roundRequests.clear() }
    }

    @Test
    fun `the committed side repairs onto the round it already installed`() {
        val bDeadlineBefore = leaveOnlyBCommitted()
        val installsBefore = b.installedConfigs.size
        val abandoned = runRepair()

        assertTrue("B did ask for the next round, alone", abandoned.isNotEmpty())
        assertTrue("and nothing new was asked for after adopting", b.roundRequests.isEmpty())
        assertEquals(
            "B re-applied the configuration it already held; no new issuance",
            installsBefore + 1,
            b.installedConfigs.size,
        )

        flush()
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        b.engine.onSelectedPair(relayPair(b.transport.lastLocalUfrag))
        flush()

        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        // A migrated onto a round it had not held: its boundary moves.
        assertTrue(a.lastCommit!!.boundaryMoved)
        // B re-established the path on the credential it already had. The
        // migration is real; the boundary is not touched.
        assertFalse(
            "a repair must not re-arm a boundary on no new authority",
            b.lastCommit!!.boundaryMoved,
        )
        assertEquals(bDeadlineBefore, b.publishedDeadline!!.deadlineAt)
    }

    @Test
    fun `a late reply for the abandoned round cannot overwrite or abort a repair`() {
        leaveOnlyBCommitted()
        val abandoned = runRepair()
        assertTrue("B really was awaiting another round", abandoned.isNotEmpty())
        val stateAfterRepair = b.engine.currentState()
        val installs = b.installedConfigs.size

        // The server answers the abandoned request late — a denial and then a
        // grant. Neither may overwrite the adopted round, and neither may
        // abort the epoch running on it.
        for ((round, rid) in abandoned) {
            b.engine.onGrant(deniedJson(round, rid))
            b.engine.onGrant(grantedJson(round, rid, (clock.now + 4 * HOUR) / 1000))
        }
        assertEquals("the late replies were fenced out", stateAfterRepair, b.engine.currentState())
        assertNotEquals(RelayRenewEngine.State.DENIED, b.engine.currentState())
        assertEquals("and installed nothing", installs, b.installedConfigs.size)
    }

    @Test
    fun `a repair does not refill the round's migration budget`() {
        leaveOnlyBCommitted()
        runRepair()
        flush()
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        b.engine.onSelectedPair(relayPair(b.transport.lastLocalUfrag))
        flush()
        assertFalse(b.lastCommit!!.boundaryMoved)

        // The migration budget belongs to the CREDENTIAL. Committing the
        // repair did not refill it, so what remains is what round 1 has left —
        // and a pair that keeps repairing cannot draw an unbounded supply of
        // epochs from one issuance.
        repeat(8) {
            clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
            clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
            b.engine.onSignal(signed(a, RelayRenewWire.Message.Prepare(20L + it)))
            b.engine.onSignal(signed(a, RelayRenewWire.Message.Ready(20L + it, 1)))
        }
        // Round 1's whole allowance, counted across EVERYTHING charged to it:
        // the initial migration that committed, and the repairs after it.
        // Committing one of them refunded nothing.
        assertEquals(
            "three migration epochs on round 1, and no more however often it is asked",
            RelayRenewWire.MAX_EPOCHS_PER_ROUND,
            b.installedConfigs.size,
        )
    }

    @Test
    fun `a ready for a round below the installed one is not a repair`() {
        bind()
        openMargin()
        flush()
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        b.engine.onSelectedPair(relayPair(b.transport.lastLocalUfrag))
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, b.engine.currentState())
        clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
        clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
        flush()
        val installs = b.installedConfigs.size
        // Round 0 is the original grant, below whatever is installed. A signed
        // `ready` for it must not resurrect a credential this link has left.
        b.engine.onSignal(signed(a, RelayRenewWire.Message.Ready(99, 0)))
        assertEquals(installs, b.installedConfigs.size)
    }

    /**
     * `unavailable` must not end an epoch a repair could still rescue.
     *
     * This is exactly when the repair matters: the server has nothing new to
     * give, and the peer already holds the round this side is missing. Aborting
     * on the refusal throws away the one path that works, every time, and the
     * link dies on a credential both ends could have shared.
     */
    @Test
    fun `an unavailable reply leaves the epoch open for a repair`() {
        leaveOnlyBCommitted()
        clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
        // B holds round 1. Its own request for round 2 is refused.
        b.grantFor = { round, rid -> unavailableJson(round, rid) }
        advanceUntil(3 * RelayRenewPolicy.RETRY_BACKOFF_MS) { a.roundRequests.isNotEmpty() }
        a.answerRounds()
        val fromA = ArrayList(a.sentSignals).also { a.sentSignals.clear() }
        // Deliver A's prepare, let B ask and be refused, then deliver A's ready.
        b.engine.onSignal(fromA.first())
        b.answerRounds()
        assertNotEquals(
            "the refusal did not end the epoch",
            RelayRenewEngine.State.FAILED,
            b.engine.currentState(),
        )
        val installs = b.installedConfigs.size
        for (signal in fromA.drop(1)) b.engine.onSignal(signal)
        assertEquals(
            "and the peer's ready repaired it on the round already in hand",
            installs + 1,
            b.installedConfigs.size,
        )
    }

    @Test
    fun `a lapsed installed credential is not something to repair onto`() {
        // Nothing has ever been installed, so there is nothing to fall back to
        // and `unavailable` is an ordinary bounded failure.
        bind()
        a.grantFor = { round, rid -> unavailableJson(round, rid) }
        openMargin()
        a.answerRounds()
        assertEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
        assertNull(a.publishedDeadline)
    }

    /**
     * A peer walking the epoch space cannot draw an unbounded run of server
     * requests out of this client.
     *
     * Each higher `prepare` adopts a new epoch, and adopting asks the server
     * for a round. Replacing the previous attempt also frees its correlation
     * slot — so without charging the replacement, the in-flight bound would
     * reset every time and the only real limit would be how fast frames
     * arrive.
     */
    @Test
    fun `a peer walking epochs upward cannot spend unbounded round requests`() {
        bind()
        openMargin()
        a.roundRequests.clear()
        val before = a.roundRequestsSeen()
        for (epoch in 50L until 90L) {
            a.engine.onSignal(signedPrepare(b, epoch))
        }
        val spent = a.roundRequestsSeen() - before
        assertTrue(
            "bounded by the pre-grant budget, not by frame arrival rate; spent $spent",
            spent <= RelayRenewEngine.MAX_PREGRANT_ATTEMPTS,
        )
    }

    // ── the credential-round migration budget (D5) ──────────────────────────

    /**
     * One credential round funds three migration epochs in TOTAL, whatever
     * mixture of outcomes they have.
     *
     * The refund this replaces was not a rounding error: committing a round
     * looked like the moment to start the next round's budget, so it wiped
     * every epoch charged to the credential just committed — the successful one
     * and each prior failure — and handed that same credential three more. A
     * pair could then migrate on one issuance indefinitely.
     */
    @Test
    fun `a failure, a success and a repair on one round sum to the round's budget`() {
        bind()
        // 1. A failed migration on round 1: the configuration is accepted and
        //    applied, then the offer does not happen.
        a.transport.restartFails = true
        openMargin()
        flush()
        assertEquals("charged once", 1, a.transport.applied.size)
        assertNull(a.publishedDeadline)

        // 2. A successful migration on the SAME round 1 — the server replays
        //    its cached configuration.
        a.transport.restartFails = false
        a.grantFor = { round, rid -> grantedJson(round, rid, (clock.now + 2 * HOUR) / 1000) }
        advanceUntil(3 * RelayRenewPolicy.RETRY_BACKOFF_MS) { a.roundRequests.isNotEmpty() }
        a.answerRounds()
        flush()
        a.engine.onSelectedPair(relayPair(a.transport.lastLocalUfrag))
        answerAndAck(a, epoch = 2, round = 1)
        assertEquals("charged twice", 2, a.transport.applied.size)

        // 3. One repair on round 1 is the third and last thing it funds.
        clock.advance(RelayRenewWire.POST_COMMIT_ACK_MS + 1)
        a.engine.onSignal(signedPrepare(b, epoch = 40))
        a.engine.onSignal(signed(b, RelayRenewWire.Message.Ready(40, 1)))
        assertEquals("charged three times", 3, a.transport.applied.size)

        // …and a fourth is refused BEFORE it touches the connection.
        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        a.engine.onSignal(signedPrepare(b, epoch = 41))
        a.engine.onSignal(signed(b, RelayRenewWire.Message.Ready(41, 1)))
        assertEquals(
            "a fourth migration on one credential is refused",
            RelayRenewWire.MAX_EPOCHS_PER_ROUND,
            a.transport.applied.size,
        )
    }

    /**
     * A round's exhausted budget must not block the NEXT round.
     *
     * Round 2 is a credential the server has never issued a migration for. The
     * single running counter that made the refund possible also made this
     * impossible: round 1's spending simply stopped the link renewing again at
     * all, on a round with an untouched allowance.
     */
    @Test
    fun `a spent round does not block the next one`() {
        bind()
        a.transport.restartFails = true
        openMargin()
        // Spend round 1 completely on failures.
        repeat(6) {
            flush()
            clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
        }
        assertEquals(RelayRenewWire.MAX_EPOCHS_PER_ROUND, a.transport.applied.size)

        // The server now holds round 2. A `stale` reply is what redirects this
        // side to it, which is also why the begin-time gate cannot key on the
        // round this side guessed it would be given.
        a.transport.restartFails = false
        a.grantFor = { round, rid ->
            if (round == 1L) staleJson(2, rid) else grantedJson(round, rid, (clock.now + 3 * HOUR) / 1000)
        }
        advanceUntil(6 * RelayRenewPolicy.RETRY_BACKOFF_MS) { a.roundRequests.isNotEmpty() }
        a.answerRounds()
        assertEquals(
            "round 2 has its own untouched allowance",
            RelayRenewWire.MAX_EPOCHS_PER_ROUND + 1,
            a.transport.applied.size,
        )
    }

    /**
     * An authenticated peer abort does not hand the other side a free restart.
     *
     * Root's product recording is exactly this shape: one peer aborting while
     * the other immediately opened the next epoch, seven epochs in eighty
     * seconds on one credential. The abort is a failure like any other and
     * carries the same backoff.
     */
    @Test
    fun `an authenticated peer abort applies the same backoff`() {
        bind()
        openMargin()
        flush()
        val requestsBefore = a.roundRequestsSeen()
        a.engine.onSignal(
            signed(b, RelayRenewWire.Message.Abort(1, RelayRenewWire.AbortReason.TIMEOUT)),
        )
        assertNotEquals(RelayRenewEngine.State.RENEWING, a.engine.currentState())
        // Nothing restarts inside the backoff, however often the trigger ticks.
        clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS - RelayRenewPolicy.TICK_MS)
        assertEquals(
            "a peer abort is not a free restart",
            requestsBefore,
            a.roundRequestsSeen(),
        )
        // …and it does recover afterwards.
        advanceUntil(3 * RelayRenewPolicy.RETRY_BACKOFF_MS) {
            a.roundRequestsSeen() > requestsBefore
        }
        assertTrue(a.roundRequestsSeen() > requestsBefore)
    }

    @Test
    fun `a superseding prepare cannot refund an already charged migration`() {
        bind()
        openMargin()
        flush()
        assertEquals("round 1 was charged once", 1, a.transport.applied.size)
        // Higher signed prepares, each superseding the last. None of them may
        // give round 1 back the epoch it already spent.
        for (epoch in 60L until 68L) {
            a.engine.onSignal(signedPrepare(b, epoch))
            a.engine.onSignal(signed(b, RelayRenewWire.Message.Ready(epoch, 1)))
        }
        assertEquals(
            "round 1 still funds three migrations in total, no more",
            RelayRenewWire.MAX_EPOCHS_PER_ROUND,
            a.transport.applied.size,
        )
    }

    @Test
    fun `an epoch is charged once, whatever ends it`() {
        bind()
        openMargin()
        flush()
        val charged = a.transport.applied.size
        // A local timeout, a peer abort and a close all land on the same
        // epoch's disposal path; none of them may charge it a second time.
        a.engine.onSignal(
            signed(b, RelayRenewWire.Message.Abort(1, RelayRenewWire.AbortReason.TIMEOUT)),
        )
        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        assertEquals(charged, a.transport.applied.size)
        // The old boundary and the identity are untouched by any of it.
        assertNull(a.publishedDeadline)
    }

    // ── a local budget is not a policy (F1) ─────────────────────────────────

    /** The last abort this side put on the wire, if any. */
    private fun lastAbort(side: Side): RelayRenewWire.Message.Abort? =
        side.allSignals.mapNotNull { RelayRenewWire.parseEnvelope(it)?.message }
            .filterIsInstance<RelayRenewWire.Message.Abort>()
            .lastOrNull()

    /** Spend round 1's whole migration budget on failed epochs. */
    private fun exhaustRoundOne() {
        a.transport.restartFails = true
        openMargin()
        repeat(6) {
            flush()
            clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
        }
        assertEquals(RelayRenewWire.MAX_EPOCHS_PER_ROUND, a.transport.applied.size)
    }

    /**
     * A fourth migration refused by THIS side's budget is `unavailable`, never
     * `denied`.
     *
     * On this wire `denied` means terminal for the round, and a peer that
     * receives one latches exactly that. Local exhaustion is neither a policy
     * refusal nor a statement about the credential — the peer may still be
     * entitled to the very round this side has run out of epochs for.
     */
    @Test
    fun `a locally exhausted budget is reported as unavailable`() {
        bind()
        exhaustRoundOne()
        val before = lastAbort(a)
        // One more epoch, served the same cached round 1, refused on budget.
        advanceUntil(3 * RelayRenewPolicy.RETRY_BACKOFF_MS) { a.roundRequests.isNotEmpty() }
        a.answerRounds()
        val abort = lastAbort(a)
        assertNotNull("the refusal was signed out to the peer", abort)
        assertNotEquals("a new abort, not the one before it", before, abort)
        abort!!
        assertEquals(
            "a local resource bound must not be signed out as a policy denial",
            RelayRenewWire.AbortReason.UNAVAILABLE,
            abort.reason,
        )
        assertEquals(RelayRenewEngine.State.FAILED, a.engine.currentState())
        assertNull("and the old boundary still stands", a.publishedDeadline)
    }

    /** The same rule on the adoption path: a repair this side cannot fund is
     *  still not a policy refusal. */
    @Test
    fun `a repair refused on budget is reported as unavailable`() {
        bind()
        exhaustRoundOne()
        clock.advance(RelayRenewWire.EPOCH_HARD_CAP_MS + 1)
        val applied = a.transport.applied.size
        a.engine.onSignal(signedPrepare(b, epoch = 70))
        a.engine.onSignal(signed(b, RelayRenewWire.Message.Ready(70, 1)))
        assertEquals("nothing was adopted", applied, a.transport.applied.size)
        val abort = lastAbort(a)
        assertNotNull("the refusal was signed out", abort)
        assertEquals(RelayRenewWire.AbortReason.UNAVAILABLE, abort!!.reason)
        // Not pinned to FAILED: by this point the hand-driven setup has also
        // let an epoch expire into silence, which legitimately concludes the
        // peer does not implement renewal. What matters here — and what the
        // granted-path test pins exactly — is that a local budget refusal is
        // never reported as a policy denial.
        assertNotEquals(RelayRenewEngine.State.DENIED, a.engine.currentState())
    }

    /**
     * A GENUINE server policy refusal is still a denial, on the wire and in
     * the state.
     *
     * The fix above must not blur the two: this is the case `denied` exists
     * for, and a client that downgraded it to `unavailable` would retry a round
     * the server has already refused.
     */
    @Test
    fun `a server denial is still signed out as a denial`() {
        bind()
        a.grantFor = { round, rid -> deniedJson(round, rid) }
        openMargin()
        a.answerRounds()
        val abort = lastAbort(a)
        assertNotNull("the denial was signed out", abort)
        assertEquals(RelayRenewWire.AbortReason.DENIED, abort!!.reason)
        assertEquals(RelayRenewEngine.State.DENIED, a.engine.currentState())
    }

    /**
     * The harm the reason code actually does: a peer must not stop renewing
     * because the OTHER side ran out of epochs.
     *
     * Driven through the real inbound path on a second engine, both halves
     * side by side — an `unavailable` leaves the round retryable, a `denied`
     * ends it. Without the contrast the first half proves only that something
     * happened to be true.
     */
    @Test
    fun `an unavailable abort leaves the round retryable, a denied one ends it`() {
        bind()
        openMargin()
        flush()
        b.roundRequests.clear()
        val askedBefore = b.roundRequestsSeen()

        // This side's local exhaustion, as the peer sees it.
        b.engine.onSignal(
            signed(a, RelayRenewWire.Message.Abort(1, RelayRenewWire.AbortReason.UNAVAILABLE)),
        )
        advanceUntil(4 * RelayRenewPolicy.RETRY_BACKOFF_MS) {
            b.roundRequestsSeen() > askedBefore
        }
        assertTrue(
            "the peer must still be able to renew after the other side ran out of epochs",
            b.roundRequestsSeen() > askedBefore,
        )

        // …and a real policy refusal, which genuinely is terminal. Its epoch
        // is read off the prepare B actually sent for its retry, so the abort
        // lands on the attempt in flight rather than a guessed number.
        val afterRetry = b.roundRequestsSeen()
        val liveEpoch = b.allSignals.mapNotNull { RelayRenewWire.parseEnvelope(it)?.message }
            .filterIsInstance<RelayRenewWire.Message.Prepare>()
            .last().epoch
        b.engine.onSignal(
            signed(a, RelayRenewWire.Message.Abort(liveEpoch, RelayRenewWire.AbortReason.DENIED)),
        )
        clock.advance(6 * RelayRenewPolicy.RETRY_BACKOFF_MS)
        assertEquals(
            "a denial is terminal for the round",
            afterRetry,
            b.roundRequestsSeen(),
        )
    }

    // ── the verification budgets (R5) ───────────────────────────────────────

    @Test
    fun `forged probes cannot spend the reservation kept for this side's ack`() {
        bind()
        openMargin()
        flush()
        observeBoth()
        // A flood of probes with real shapes and junk tags, far past the whole
        // epoch budget. Each costs at most one verification from the PROBE
        // reservation, and none of them may touch the ack reservation.
        val junkTag = ByteArray(RelayRenewProbe.TAG_BYTES) { 0x5a }
        repeat(40) { i ->
            a.engine.onControlFrame(
                RelayRenewProbe.encode(
                    RelayRenewProbe.TYPE_PROBE, 1, 1, ByteArray(16) { (i + 1).toByte() }, junkTag,
                ),
            )
        }
        // The genuine ack now arrives, and must still be verifiable.
        flush()
        assertEquals(
            "the ack reservation survived the flood",
            RelayRenewEngine.State.RENEWED,
            a.engine.currentState(),
        )
    }

    /**
     * After this side commits, a peer nonce it has NEVER verified is
     * legitimate: this side's commit only needed the peer to confirm ITS nonce,
     * and the peer's own probe may have been dropped while a verification was
     * busy. It must be answered — from the same epoch's remaining reservation,
     * not from a second budget.
     */
    @Test
    fun `a first-seen peer nonce after own commit is verified and acked`() {
        bind()
        openMargin()
        flush()
        observeBoth()
        flush()
        assertEquals(RelayRenewEngine.State.RENEWED, a.engine.currentState())
        a.transport.sentControl.clear()

        val fresh = probeFrom(b, a, epoch = 1, round = 1, nonce = ByteArray(16) { 0x33 })
        a.engine.onControlFrame(fresh)
        val ack = RelayRenewProbe.decode(a.transport.sentControl.single())!!
        assertEquals(RelayRenewProbe.TYPE_ACK, ack.type)
        assertTrue(RelayRenewProbe.verify(b.keys, ack, "peer-a", "peer-b"))
    }

    @Test
    fun `the post-commit window does not refill the epoch's verification budget`() {
        bind()
        openMargin()
        flush()
        observeBoth()
        flush()
        a.transport.sentControl.clear()
        // Spend the probe reservation on frames that never verify, then offer a
        // genuine first-seen nonce. With a second budget it would be answered;
        // with one carried-over budget it cannot be, and refusing is the safe
        // direction.
        val junkTag = ByteArray(RelayRenewProbe.TAG_BYTES) { 0x11 }
        repeat(RelayRenewEngine.MAX_PROBE_RESERVATION + 2) { i ->
            a.engine.onControlFrame(
                RelayRenewProbe.encode(
                    RelayRenewProbe.TYPE_PROBE, 1, 1, ByteArray(16) { (0x70 + i).toByte() }, junkTag,
                ),
            )
        }
        a.transport.sentControl.clear()
        a.engine.onControlFrame(probeFrom(b, a, 1, 1, ByteArray(16) { 0x44 }))
        assertTrue(
            "eight is the epoch total, before and after commit alike",
            a.transport.sentControl.isEmpty(),
        )
    }

    // ── the pre-grant budget (D2) ───────────────────────────────────────────

    @Test
    fun `transient refusals before any issuance do not spend the migration budget`() {
        bind()
        // Three server refusals in a row. Under one shared budget these would
        // permanently give up the renewal with most of the margin unspent, on
        // a run of database jitter that issued nothing and migrated nothing.
        var refusals = 0
        a.grantFor = { round, rid ->
            refusals++
            if (refusals <= 3) unavailableJson(round, rid) else null
        }
        openMargin()
        repeat(3) {
            a.answerRounds()
            clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
        }
        assertTrue("it kept trying", a.roundRequestsSeen() > 3)
        // …and a grant that finally arrives still has its full migration
        // budget: the epoch after the refusals reaches a real migration.
        a.grantFor = null
        a.answerRounds()
        assertEquals(RelayRenewEngine.State.RENEWING, a.engine.currentState())
        assertEquals(1, a.transport.applied.size)
    }

    @Test
    fun `pre-grant retries are themselves bounded`() {
        bind()
        a.grantFor = { round, rid -> unavailableJson(round, rid) }
        openMargin()
        repeat(20) {
            a.answerRounds()
            clock.advance(RelayRenewPolicy.RETRY_BACKOFF_MS + RelayRenewPolicy.TICK_MS + 1)
        }
        assertTrue(
            "bounded, not an unbounded retry loop",
            a.roundRequestsSeen() <= RelayRenewEngine.MAX_PREGRANT_ATTEMPTS,
        )
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    // ── helpers ─────────────────────────────────────────────────────────────

    private fun Side.roundRequestsSeen(): Int = roundsAsked

    /** Every SDP this side put on the wire, in order. */
    private fun sdpTypesFrom(side: Side): List<String> = side.allSignals
        .mapNotNull { RelayRenewWire.parseEnvelope(it)?.message as? RelayRenewWire.Message.Sdp }
        .map { it.sdpType }

    private fun boundFor(lifetimeMs: Long) = RelayRenewPolicy.deadline(
        listOf(turnCredential((clock.now + lifetimeMs) / 1000)),
        clock.now,
    )!!

    private fun signedPrepare(from: Side, epoch: Long): Json =
        signed(from, RelayRenewWire.Message.Prepare(epoch))

    private fun signedIce(
        from: Side,
        epoch: Long,
        round: Long,
        candidate: String,
        usernameFragment: String,
    ): Json = signed(
        from,
        RelayRenewWire.Message.Ice(epoch, round, candidate, "0", 0, usernameFragment),
    )

    private fun signed(from: Side, message: RelayRenewWire.Message): Json {
        val payload = RelayRenewWire.payload(from.id, from.peer, message)
        return RelayRenewWire.envelopeJson(message, Crypto.signAuth(from.keys, payload))
    }

    /** Feed the peer's answer and the ack that commits this side's epoch. */
    private fun answerAndAck(side: Side, epoch: Long, round: Long) {
        val peer = if (side === a) b else a
        side.engine.onSignal(
            signed(
                peer,
                RelayRenewWire.Message.Sdp(epoch, round, "answer", sdpWithUfrag("peer$epoch")),
            ),
        )
        side.engine.onSelectedPair(relayPair(side.transport.lastLocalUfrag))
        val probe = side.transport.sentControl.mapNotNull { RelayRenewProbe.decode(it) }
            .last { it.isProbe }
        side.engine.onControlFrame(
            RelayRenewProbe.sign(
                peer.keys, RelayRenewProbe.TYPE_ACK, peer.id, side.id,
                probe.epoch, probe.round, probe.nonce,
            )!!,
        )
    }

    private fun probeFrom(
        from: Side,
        to: Side,
        epoch: Long,
        round: Long,
        nonce: ByteArray,
    ): ByteArray = RelayRenewProbe.sign(
        from.keys, RelayRenewProbe.TYPE_PROBE, from.id, to.id, epoch, round, nonce,
    )!!

    private companion object {
        const val HOUR = 60 * 60_000L

        val BASELINE_SDP = """
            v=0
            a=group:BUNDLE 0
            m=application 9 UDP/DTLS/SCTP webrtc-datachannel
            a=ice-ufrag:baseline
            a=fingerprint:sha-256 AB:CD:EF:01
            a=setup:actpass
            a=mid:0
        """.trimIndent().replace("\n", "\r\n") + "\r\n"

        fun sdpWithUfrag(ufrag: String): String =
            BASELINE_SDP.replace("a=ice-ufrag:baseline", "a=ice-ufrag:$ufrag")

        /**
         * The same description with a SECOND m-line and mid.
         *
         * Today's product is a bundled data-only session with exactly one mid,
         * so this shape is not something the app builds. It exists to pin what
         * happens if it ever did: the publication in [RelayRenewEngine] binds a
         * discovered address to ONE mid at m-line index 0, and that binding is
         * only meaningful when the session has exactly one m-line.
         */
        fun withSecondMid(sdp: String): String =
            sdp + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\n"

        fun candidateWithUfrag(ufrag: String): String =
            "candidate:1 1 udp 100 203.0.113.9 54321 typ relay generation 0 ufrag $ufrag"

        fun relayPair(localUfrag: String) = RenewTransport.SelectedPair(
            local = candidateWithUfrag(localUfrag),
            remote = "candidate:2 1 udp 100 203.0.113.10 54322 typ relay generation 0",
        )

        fun turnCredential(expirySeconds: Long) = RelayRenewPolicy.Credential(
            listOf("turn:relay.example:3478"),
            "$expirySeconds:token",
        )

        fun grantedJson(round: Long, rid: Long, expirySeconds: Long?): Json {
            val servers = if (expirySeconds == null) {
                Json.arr(emptyList())
            } else {
                Json.arr(
                    listOf(
                        Json.obj(
                            "urls" to Json.arr(listOf(Json.of("turn:relay.example:3478"))),
                            "username" to Json.of("$expirySeconds:abc"),
                            "credential" to Json.of("zzz"),
                        ),
                    ),
                )
            }
            return Json.obj(
                "status" to Json.of("granted"),
                "round" to Json.of(round),
                "rid" to Json.of(rid),
                "iceServers" to servers,
            )
        }

        fun staleJson(current: Long, rid: Long): Json = Json.obj(
            "status" to Json.of("stale"),
            "round" to Json.of(current),
            "rid" to Json.of(rid),
        )

        fun unavailableJson(round: Long, rid: Long): Json = Json.obj(
            "status" to Json.of("unavailable"),
            "round" to Json.of(round),
            "rid" to Json.of(rid),
            "reason" to Json.of("rate"),
        )

        fun deniedJson(round: Long, rid: Long): Json = Json.obj(
            "status" to Json.of("denied"),
            "round" to Json.of(round),
            "rid" to Json.of(rid),
            "relayDenied" to Json.of("quota"),
        )
    }
}
