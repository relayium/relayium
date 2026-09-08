package com.relayium.android.inbox

import com.relayium.protocol.inbox.InboxAutoAccept
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The transitions, driven adversarially.
 *
 * Every case here holds an operation INSIDE a suspension and changes the world
 * under it, because that is where account switching, sign-out and lifecycle
 * actually go wrong: not in the steady state, but between an await and the side
 * effect that follows it. Nothing is timing-dependent — each barrier is an
 * explicit gate the test opens.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InboxLifecycleTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val a = InboxAccountId("0000111122223333444455556666aaaa")
    private val b = InboxAccountId("9999888877776666555544443333bbbb")

    private fun now() = 1_700_000_500L

    // ── the model's adoption ────────────────────────────────────────────────

    /**
     * An adoption blocked joining old work cannot answer with another
     * adoption's session.
     *
     * The runtime pairs the returned authority with the bearer IT passed. A call
     * that returned the other adoption's authority would produce a session
     * carrying one account's identity and another's credential.
     */
    @Test
    fun `concurrent adoptions each return their own authority`() = runTest {
        val model = InboxModel(this, ::now)
        val first = requireNotNull(model.adopt(a))
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val old = model.launchOwned(first) {
            try {
                awaitCancellation()
            } finally {
                withContext(NonCancellable) {
                    entered.complete(Unit)
                    release.await()
                }
            }
        }
        runCurrent()

        val adoptingA = async { model.adopt(a) }
        runCurrent()
        assertTrue("the old body is inside its cleanup", entered.isCompleted)
        val adoptingB = async { model.adopt(b) }
        runCurrent()

        release.complete(Unit)
        runCurrent()
        old.join()

        assertEquals(a, adoptingA.await()?.account)
        assertEquals(b, adoptingB.await()?.account)
    }

    /** A new authority is not externally visible until the old work has ended. */
    @Test
    fun `no authority is published while old work is still finishing`() = runTest {
        val model = InboxModel(this, ::now)
        val first = requireNotNull(model.adopt(a))
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val old = model.launchOwned(first) {
            try {
                awaitCancellation()
            } finally {
                withContext(NonCancellable) {
                    entered.complete(Unit)
                    release.await()
                }
            }
        }
        runCurrent()

        val adopting = async { model.adopt(b) }
        runCurrent()
        assertTrue(entered.isCompleted)
        assertNull("nothing is current while the old session is ending", model.authority())

        release.complete(Unit)
        runCurrent()
        old.join()
        assertNotNull(adopting.await())
    }

    /**
     * A cancelled adoption does not lose ownership of work that is still
     * running.
     *
     * A host cancelling a `LaunchedEffect` cancels an adoption mid-join. If the
     * registry had been emptied at the start of that adoption, the NEXT one
     * would find nothing to wait for and would publish a new authority while the
     * old body was still inside its uncancellable cleanup — using the previous
     * account's bearer.
     */
    @Test
    fun `a cancelled adoption still leaves the next one waiting for old work`() = runTest {
        val model = InboxModel(this, ::now)
        val first = requireNotNull(model.adopt(a))
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val old = model.launchOwned(first) {
            try {
                awaitCancellation()
            } finally {
                withContext(NonCancellable) {
                    entered.complete(Unit)
                    release.await()
                }
            }
        }
        runCurrent()

        val abandoned = launch { model.adopt(b) }
        runCurrent()
        assertTrue(entered.isCompleted)
        abandoned.cancel()
        runCurrent()

        val next = async { model.adopt(a) }
        runCurrent()
        assertFalse(
            "the next adoption must not complete while the old body runs",
            next.isCompleted,
        )

        release.complete(Unit)
        runCurrent()
        old.join()
        abandoned.join()
        assertEquals(a, next.await()?.account)
    }

    /** Work whose authority was superseded before it started never runs. */
    @Test
    fun `work launched under a dead authority never runs`() = runTest {
        val model = InboxModel(this, ::now)
        val first = requireNotNull(model.adopt(a))
        model.adopt(b)

        val ran = AtomicInteger(0)
        val job = model.launchOwned(first) { ran.incrementAndGet() }
        advanceUntilIdle()

        assertEquals(0, ran.get())
        assertTrue(job.isCancelled)
    }

    // ── the runtime's lifecycle ─────────────────────────────────────────────

    private class Pause {
        val entered = AtomicInteger(0)

        @Volatile
        var gate = CompletableDeferred<Unit>()

        suspend fun await(millis: Long) {
            entered.incrementAndGet()
            gate.await()
        }
    }

    private class World(
        val services: TestInboxServices,
        val runtime: InboxRuntime,
        val model: InboxModel,
        val pause: Pause,
    )

    /**
     * Drain until the receive loop parks in its heartbeat pause again.
     *
     * `advanceUntilIdle` answers "nothing is scheduled right now", which a loop
     * resuming through several suspension points can satisfy while it is still
     * mid-pass — so a single call is not a barrier for "the loop got all the way
     * round". The park is the loop's own end of pass, and waiting for it ties
     * this to observable progress instead of a drain count that happened to be
     * enough. The bound turns a loop that never gets there into a failure with a
     * reason rather than a hang.
     */
    private fun TestScope.drainUntilParked(pause: Pause, target: Int) {
        repeat(200) {
            if (pause.entered.get() >= target) return
            advanceUntilIdle()
            runCurrent()
        }
        throw AssertionError("the receive loop never reached pause #$target")
    }

    private fun TestScope.world(): World {
        val services = TestInboxServices(folder.newFolder(), a, nowSeconds = ::now)
        val pause = Pause()
        val model = InboxModel(backgroundScope, ::now)
        val runtime = InboxRuntime(
            model = model,
            factory = { _, _ -> services.bundle() },
            nowSeconds = ::now,
            appVersion = "0.1.1",
            pause = pause::await,
        )
        services.server.devices = listOf(services.self(), services.peer())
        return World(services, runtime, model, pause)
    }

    /**
     * Rapid stop/start flips converge on exactly ONE claim loop.
     *
     * Two loops would each hold a claim, which is the one thing the receive
     * design forbids: a task leased twice is a delivery written twice.
     */
    @Test
    fun `rapid stop and start leave exactly one loop`() = runTest {
        val w = world()
        w.services.holdKey()
        w.runtime.adopt(a, "bearer-a")
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()
        val afterFirst = w.services.server.device.count("heartbeat")

        // Queued together on purpose: the gate must resolve them in order
        // rather than layering two loops.
        var last: kotlinx.coroutines.Job? = null
        repeat(4) {
            w.runtime.stop()
            last = w.runtime.start()
        }
        last?.join()
        advanceUntilIdle()

        // Each genuine start runs at most one pass before parking, and no pass
        // ever overlaps another: the count moves by whole passes.
        val heartbeats = w.services.server.device.count("heartbeat")
        assertTrue("expected bounded passes, saw $heartbeats", heartbeats <= afterFirst + 4)
        assertEquals(InboxReceiving.LISTENING, w.model.state.value.receiving)
    }

    /**
     * A stop that lost the race does not announce `offline` after a newer start.
     *
     * Central would then believe a listening device is gone, and every send to
     * it would be refused.
     */
    @Test
    fun `a superseded stop does not announce offline`() = runTest {
        val w = world()
        w.services.holdKey()
        w.runtime.adopt(a, "bearer-a")
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        // NOT joined: the stop and the start are queued together, which is the
        // race a delta-based lifecycle loses.
        w.runtime.stop()
        w.runtime.start()?.join()
        advanceUntilIdle()

        assertEquals(
            "the last intent is live, so nothing may announce offline",
            0,
            w.services.server.device.count("goOffline"),
        )
        assertEquals(InboxReceiving.LISTENING, w.model.state.value.receiving)
    }

    /** A stop that IS the last word announces offline exactly once. */
    @Test
    fun `stopping for real announces offline once`() = runTest {
        val w = world()
        w.services.holdKey()
        w.runtime.adopt(a, "bearer-a")
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        w.runtime.stop()?.join()
        advanceUntilIdle()
        w.runtime.stop()?.join()
        advanceUntilIdle()

        assertEquals(1, w.services.server.device.count("goOffline"))
        assertEquals(InboxReceiving.STOPPED, w.model.state.value.receiving)
    }

    /**
     * An account switch while the loop is running ends it before the new
     * account's session exists, and nothing of the old one publishes.
     */
    @Test
    fun `an account switch ends the loop before the new session starts`() = runTest {
        val w = world()
        w.services.holdKey()
        w.runtime.adopt(a, "bearer-a")
        w.runtime.start()?.join()
        advanceUntilIdle()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()
        val before = w.services.server.device.count("heartbeat")

        w.runtime.adopt(b, "bearer-b")
        advanceUntilIdle()

        assertEquals(b, w.model.state.value.authority?.account)
        assertEquals(InboxReceiving.OFF, w.model.state.value.receiving)
        assertEquals(
            "the old loop must not take another pass under the new account",
            before,
            w.services.server.device.count("heartbeat"),
        )
    }

    // ── the stored policy ───────────────────────────────────────────────────

    /**
     * A cold start with receiving already switched on starts receiving.
     *
     * The session begins at OFF because that is the safe placeholder, not an
     * answer: the stored policy is only known once the services have opened. A
     * reconcile that decided against the placeholder would leave a device whose
     * owner left `auto` on sitting idle until they toggled something.
     */
    @Test
    fun `a cold start with a stored auto policy starts receiving`() = runTest {
        val services = TestInboxServices(folder.newFolder(), a, nowSeconds = ::now)
        services.server.devices = listOf(services.self(), services.peer())
        services.holdKey()
        services.policy(InboxAutoAccept.AUTO)

        val pause = Pause()
        val model = InboxModel(backgroundScope, ::now)
        // The services open SLOWLY, which is the case the ordering has to
        // survive: the reconcile must wait for the authoritative policy.
        val opening = CompletableDeferred<Unit>()
        val runtime = InboxRuntime(
            model = model,
            factory = { _, _ ->
                opening.await()
                services.bundle()
            },
            nowSeconds = ::now,
            appVersion = "0.1.1",
            pause = pause::await,
        )

        runtime.adopt(a, "bearer-a")
        val started = runtime.start()
        runCurrent()
        assertEquals("nothing may be claimed before the policy is known", 0, services.server.device.count("heartbeat"))

        opening.complete(Unit)
        started?.join()
        advanceUntilIdle()

        assertEquals(InboxAutoAccept.AUTO, model.state.value.policy)
        assertEquals(InboxReceiving.LISTENING, model.state.value.receiving)
    }

    /** A choice made while the stored policy is still loading is the newer fact,
     *  and wins. */
    @Test
    fun `a policy chosen during a slow load is not overwritten by the stored one`() = runTest {
        val services = TestInboxServices(folder.newFolder(), a, nowSeconds = ::now)
        services.server.devices = listOf(services.self(), services.peer())
        services.holdKey()
        services.policy(InboxAutoAccept.AUTO)

        val pause = Pause()
        val model = InboxModel(backgroundScope, ::now)
        val opening = CompletableDeferred<Unit>()
        val runtime = InboxRuntime(
            model = model,
            factory = { _, _ -> opening.await(); services.bundle() },
            nowSeconds = ::now,
            appVersion = "0.1.1",
            pause = pause::await,
        )

        runtime.adopt(a, "bearer-a")
        runtime.start()
        runCurrent()
        val chosen = runtime.setPolicy(InboxAutoAccept.OFF)
        runCurrent()
        opening.complete(Unit)
        chosen?.join()
        advanceUntilIdle()

        assertEquals(InboxAutoAccept.OFF, model.state.value.policy)
        assertEquals(InboxAutoAccept.OFF, services.policies.read())
        assertEquals(InboxReceiving.OFF, model.state.value.receiving)
    }

    // ── one attempt per job ─────────────────────────────────────────────────

    /**
     * A job has ONE attempt, and cancelling stops the one that is running.
     *
     * A second attempt queued behind the first would also take over the handle
     * `cancelSend` uses — so a stop would cancel the waiting retry while the
     * original went on uploading the user's bytes.
     */
    @Test
    fun `a second attempt is refused and cancelling stops the first`() = runTest {
        val w = world()
        w.runtime.adopt(a, "bearer-a")
        w.runtime.refresh()?.join()
        advanceUntilIdle()
        val target = w.model.state.value.devices.single()

        // The first attempt blocks inside the upload.
        w.services.uploader.gate = CompletableDeferred()
        val first = w.runtime.sendText(target, "held open")
        // runCurrent, not advanceUntilIdle: the attempt is meant to STOP inside
        // the upload, and a blocked background coroutine is exactly what
        // advanceUntilIdle cannot drive to that point.
        runCurrent()
        val jobId = w.model.state.value.sends.single().jobId
        assertEquals(1, w.services.uploader.uploads.size)

        // A double tap. It must not start a second upload.
        w.runtime.send(jobId)?.join()
        runCurrent()
        assertEquals("one attempt per job", 1, w.services.uploader.uploads.size)

        w.runtime.cancelSend(jobId)
        runCurrent()
        first?.join()

        assertEquals("nothing may be created for a cancelled attempt", 0, w.services.server.count("createTask"))
        // The durable job survives: a cancelled attempt is a paused delivery,
        // not a discarded one.
        assertEquals(1, w.services.sendStore.all().size)
    }

    /**
     * Cancelling an attempt takes SENDING off the screen.
     *
     * The phase is published on the way into an attempt and, before this, only
     * on the way out of a successful one — so a cancellation left a progress bar
     * running for an upload that had stopped. The row offers its retry only when
     * the phase is not SENDING, which made the user's own cancel the thing that
     * took away the way back, and nothing else corrects it: the sends list is
     * rebuilt by `refresh`, which a cancel does not trigger.
     *
     * The cancel happens INSIDE the upload, with the fake parked, so this is the
     * real mid-attempt case and not a stop that raced a delivery that had
     * already happened — `createTask` proves which one it was.
     */
    @Test
    fun `cancelling inside an upload clears Sending without inventing an outcome`() = runTest {
        val w = world()
        w.runtime.adopt(a, "bearer-a")
        w.runtime.refresh()?.join()
        advanceUntilIdle()

        w.services.uploader.gate = CompletableDeferred()
        val attempt = w.runtime.sendText(w.model.state.value.devices.single(), "cancel this")
        runCurrent()
        assertEquals(1, w.services.uploader.uploads.size)
        val jobId = w.services.uploader.uploads.single()
        assertEquals(InboxSendStatus.Phase.SENDING, w.model.state.value.sends.single().phase)

        w.runtime.cancelSend(jobId)
        attempt?.join()
        runCurrent()

        val state = w.model.state.value.sends.single()
        assertNotEquals(
            "cancel must not leave Sending on screen",
            InboxSendStatus.Phase.SENDING,
            state.phase,
        )
        assertNotEquals(InboxSendStatus.Phase.DELIVERED, state.phase)
        assertEquals(0, w.services.server.count("createTask"))
        assertNotNull(w.services.sendStore.load(jobId))

        // No reason is invented for it. A user's own stop is not a transport
        // failure, and a phase carrying one would put an error they never hit
        // on their screen. Which non-SENDING phase it is left open on purpose:
        // a paused delivery does not logically have to render as STAGED.
        assertNull(state.stop)
        // Ambiguity is whatever the DURABLE record says, not something inferred
        // from central having created nothing — an object publish can already be
        // unknown before any task exists.
        val job = requireNotNull(w.services.sendStore.load(jobId))
        assertEquals(
            job.unresolvedCreate || (job.emptyPublishAttempted && job.storedFileId == null),
            state.ambiguous,
        )
        // The local attempt was cancelled; central was not asked to change.
        assertEquals(0, w.services.server.count("cancelTask"))
    }

    // ── policy transitions ──────────────────────────────────────────────────

    /**
     * Changing between two RECEIVING policies re-enrols, and nothing claims
     * under the new setting until central has acknowledged it.
     *
     * The policy only reaches central through an enrolment, and the loop enrols
     * once. So `auto` → `ask` used to change the screen and the durable record
     * and nothing else: central kept `auto`, kept offering this device tasks,
     * and the receiver — which refuses only on `off` — kept saving them without
     * asking. The switch looked like it worked.
     *
     * The enrolment is held open here, which is the part a call count cannot
     * see. While it is in flight the surface must not claim to be listening and
     * the loop must not claim a task, because both would be acting on a policy
     * central has not agreed to yet.
     */
    @Test
    fun `changing the policy re-enrols before anything claims under it`() = runTest {
        val w = world()
        w.services.holdKey()
        // Central has something to hand over on every pass, so "did not claim"
        // is a real observation rather than the loop having nothing to do. The
        // claim itself leases nothing, which keeps this about the transition.
        w.services.server.device.pending = listOf(InboxTaskRow.read(InboxFixtures.task()))
        w.runtime.adopt(a, "bearer-a")
        w.runtime.start()?.join()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()

        val device = w.services.server.device
        assertEquals(InboxReceiving.LISTENING, w.model.state.value.receiving)
        assertEquals(InboxAutoAccept.AUTO, device.enrolRequests.last().autoAccept)
        val enrolsBefore = device.count("enrol")
        val claimsBefore = device.count("claim")

        // Hold the re-enrolment open, so the window this test is about is a
        // state the test controls rather than a moment it has to catch.
        val ack = CompletableDeferred<Unit>()
        device.enrolGate = ack
        // EVERY published pairing, not just the one left at the end. The drain
        // suspends, so a transition that announced the new policy first and
        // corrected the receiving state afterwards would be visible here — and
        // it is a false claim for exactly as long as the old worker takes to
        // unwind, which is not a duration this app controls.
        val seen = mutableListOf<Pair<InboxAutoAccept, InboxReceiving>>()
        backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) {
            w.model.state.collect { seen += it.policy to it.receiving }
        }

        val change = w.runtime.setPolicy(InboxAutoAccept.ASK)
        change?.join()
        // The old worker was parked in the heartbeat pause. Releasing it AFTER
        // the change proves the fix is not merely "the pause had not elapsed
        // yet": a worker still enrolled as `auto` must not be there to wake up
        // and claim one more time under the policy the user just left. The gate
        // is replaced first, so whatever wakes parks again instead of spinning.
        val parked = w.pause.gate
        w.pause.gate = CompletableDeferred()
        parked.complete(Unit)
        advanceUntilIdle()

        assertEquals(InboxAutoAccept.ASK, w.model.state.value.policy)
        assertEquals("the change must announce itself", enrolsBefore + 1, device.count("enrol"))
        assertEquals(InboxAutoAccept.ASK, device.enrolRequests.last().autoAccept)
        assertNotEquals(
            "nothing is listening while central still holds the old policy",
            InboxReceiving.LISTENING,
            w.model.state.value.receiving,
        )
        assertEquals(
            "no claim may be made under a policy central has not acknowledged",
            claimsBefore,
            device.count("claim"),
        )
        assertFalse(
            "the surface must never pair the new policy with LISTENING before it is live",
            seen.any { (p, r) -> p == InboxAutoAccept.ASK && r == InboxReceiving.LISTENING },
        )

        val parkedAgain = w.pause.entered.get() + 1
        ack.complete(Unit)
        drainUntilParked(w.pause, parkedAgain)

        assertEquals(InboxReceiving.LISTENING, w.model.state.value.receiving)
        assertTrue("the loop resumed under the new policy", device.count("claim") > claimsBefore)
        assertEquals(InboxAutoAccept.ASK, device.enrolRequests.last().autoAccept)
    }

    // ── repair ──────────────────────────────────────────────────────────────

    /**
     * A finished repair restarts the loop through the SAME gate as everything
     * else.
     *
     * Starting one directly could put a loop in flight while a stop that had
     * already released the handle was still joining the previous one — two
     * loops, each holding a claim. Here the surface is no longer live, so the
     * repair must not start anything at all.
     */
    @Test
    fun `a repair does not start a loop the lifecycle has stopped`() = runTest {
        val w = world()
        w.services.server.device.enrolResult = InboxEnrolResult(
            inbox = InboxEnrolmentView.read(InboxFixtures.enrolment()),
            protocolVersion = com.relayium.protocol.inbox.InboxProtocol.MAX_PROTOCOL_VERSION,
            receiveCapability = com.relayium.protocol.inbox.InboxCapability.REQUIRED_RECEIVE,
            keyAlgorithm = com.relayium.protocol.inbox.InboxProtocol.KEY_ALGORITHM,
        )
        // Central's history holds that same active key, so the repair's
        // compare-and-swap has a real predecessor to name.
        w.services.server.device.keys.add(
            InboxKeyRow(
                InboxFixtures.KEY_ID,
                com.relayium.protocol.inbox.InboxProtocol.KEY_ALGORITHM,
                InboxFixtures.publicKey,
                1, 1_700_000_000, 0, 0,
            ),
        )
        w.runtime.adopt(a, "bearer-a")
        w.runtime.start()?.join()
        w.runtime.setPolicy(InboxAutoAccept.AUTO)?.join()
        advanceUntilIdle()
        assertTrue(w.model.state.value.keyHealth is InboxKeyHealth.NeedsRepair)

        w.runtime.stop()?.join()
        w.runtime.repairKey()?.join()
        advanceUntilIdle()

        assertTrue(w.model.state.value.keyHealth is InboxKeyHealth.Healthy)
        assertEquals(
            "a repair may not restart a loop the lifecycle stopped",
            InboxReceiving.STOPPED,
            w.model.state.value.receiving,
        )
        assertEquals(0, w.services.server.device.count("claim"))
    }
}
