package com.relayium.android.nearby

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.relayium.android.DocumentsUiDriver
import com.relayium.android.InteropDriver.arg
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.readSaved
import com.relayium.android.InteropDriver.report
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.sha256
import com.relayium.android.InteropDriver.stageOutgoing
import com.relayium.android.InteropDriver.state
import com.relayium.android.InteropDriver.treeUri
import com.relayium.android.InteropDriver.viewModel
import com.relayium.android.MainActivity
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Android half of the REAL Nearby acceptance, on real devices.
 *
 * `scripts/android-nearby-acceptance.sh` owns the two emulators, the roles and
 * every comparison. This half drives the shipped app: `MainActivity`, the
 * `TransferViewModel` it created, its `TransferController`, the real
 * `NsdManager` advertiser and browser, real TCP signalling streams, real native
 * WebRTC and the real SAF stack.
 *
 * ## What only this can show
 *
 * The JVM suites drive the channel and the controller against scripted
 * transports. They are precise about ordering, admission and ownership, and
 * they cannot see whether `NsdManager` actually registers this service on a real
 * link, whether a peer resolves the TXT record this build writes, or whether
 * WebRTC completes on host candidates alone with no ICE servers at all. That is
 * this file. By default NOTHING is stubbed: the file and folder pickers are the
 * real system ones, driven through DocumentsUI, which is a separate Activity and
 * therefore stops this one every time it opens. That stop is under test as much
 * as the transfer is. `-e nearby.realPicker 0` replaces both with direct view-
 * model calls; it is an explicit opt-out, the report records which path ran, and
 * the oracle refuses a run that took the shortcut without being told to.
 *
 * ## The two preflights, both fail-closed
 *
 * 1. **No backend, at all.** The direct path's whole claim is that nothing about
 *    the transfer reaches a server. Asserting "the URL was empty" would prove
 *    nothing, so the run points the app at a loopback origin this test is
 *    LISTENING on and fails if a single connection arrives. A run where the
 *    shell forgot to set the override would silently prove nothing, so the
 *    resolved origin is read off the live ViewModel first and the round fails if
 *    it is not this test's server.
 * 2. **Discovery, not addressing.** The peer is reached only through a device
 *    this app DISCOVERED and the user then selected. There is no manual address
 *    anywhere in this file; a round that never listed the other device fails as
 *    a discovery failure rather than falling back to something that would pass.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class NearbyLanAcceptanceTest {

    /**
     * For the IN-APP taps only. `DocumentsUiDriver.byLabel` is a case-insensitive
     * SUBSTRING match — right for DocumentsUI, whose labels change case between
     * releases — and "Nearby" is a substring of "Nearby devices", so it cannot
     * tell this app's destination tab from the heading underneath it. Compose's
     * own matchers are exact, and `isSelectable()` is the semantics a
     * destination carries and a heading does not.
     */
    @get:Rule
    val compose = createEmptyComposeRule()

    /** The peer's terminal handshake: it sends this only once it has observed
     *  everything this round expects of the other side, and this side keeps the
     *  Activity — and therefore the live session — alive until it arrives. Only
     *  the peer knows when the peer has everything. */
    private val doneMessage = "relayium-nearby:done"

    /**
     * The barrier phases, in the order the round passes through them.
     *
     * TWO of them, and distinct, because there are two separate moments at which
     * one endpoint's ordinary next step destroys something the other is still
     * asserting against — and one barrier only moves the race to the phase after
     * it. `TRANSFER` guards the session (the message history is session state);
     * `ROOM` guards the ROSTER, because the peer legitimately vanishes from the
     * list the moment the other side stops Nearby, which is correct product
     * behaviour and must not be raced.
     */
    private enum class Phase(val ready: String, val release: String, val field: String) {
        /** Everything the transfer itself asserts. Held before any disconnect. */
        TRANSFER("nearby-ready.json", "nearby-release", "barrier"),

        /** The room outliving its own transfer. Held before any stopNearby. */
        ROOM("nearby-room-ready.json", "nearby-room-release", "barrierRoom"),
    }

    /** How long a half waits for its counterpart to finish asserting. Longer
     *  than any single wait in the round, because the other side may still be
     *  driving a real document picker. */
    private val BARRIER_MS = 180_000L

    /** The in-band "I am ready for your batch" so the two directions are
     *  SEQUENCED rather than sampled at one arbitrary interleaving. */
    private val readyMessage = "relayium-nearby:ready"

    /**
     * Every state this round passed through, in order, with elapsed times.
     *
     * A timeout says only that something did not happen. This says WHAT the
     * session was doing while it did not happen — whether it never left
     * CONNECTING, or reached it and fell back to the list with a terminal error
     * thirty seconds later, or never left the room state at all. That is the
     * difference between "the link came up timed out" and a diagnosis.
     *
     * Deliberately narrow: phase, room state, wire NAME, error KEY, and whether
     * a selection and a prompt exist. No SDP, no candidate, no key, no SAS, no
     * peer id beyond the short fragment the UI itself shows, no bearer. Bounded,
     * because a stuck round would otherwise sample forever.
     */
    private class Progression(private val vm: TransferViewModel) : AutoCloseable {
        private val started = System.currentTimeMillis()
        private val entries = java.util.Collections.synchronizedList(ArrayList<String>())
        @Volatile private var running = true

        private val thread = Thread({
            var last = ""
            try {
                while (running && entries.size < MAX_ENTRIES) {
                    val now = snapshot()
                    if (now != last) {
                        entries.add("+${System.currentTimeMillis() - started}ms $now")
                        last = now
                    }
                    Thread.sleep(50)
                }
            } catch (_: InterruptedException) {
                // The ordinary way this thread ends: `close` asks it to stop and
                // interrupts the sleep. Restore the flag and return — an
                // uncaught InterruptedException out of a thread's body reaches
                // the default handler, which on Android KILLS THE PROCESS. That
                // is not a theoretical risk: it crashed the app during the
                // `finally` of a round whose transfers had all SUCCEEDED, so a
                // fully passing run reported a failure from its own diagnostics.
                Thread.currentThread().interrupt()
            } catch (_: Throwable) {
                // A diagnostic must never be able to fail the thing it is
                // watching. Whatever this was, the entries collected so far are
                // still worth reporting.
            }
        }, "relayium-nearby-progression").apply { isDaemon = true; start() }

        private fun snapshot(): String {
            val s = state(vm)
            val selected = s.nearby.selectedId?.let { shortPeerId(it) } ?: "-"
            val incoming = s.nearby.incomingId?.let { shortPeerId(it) } ?: "-"
            return "phase=${s.phase} room=${s.nearby.room} wire=${s.wire?.name ?: "-"} " +
                "err=${s.errorKey ?: "-"} devices=${s.nearby.devices.size} " +
                "selected=$selected incoming=$incoming"
        }

        fun entries(): List<String> = synchronized(entries) { ArrayList(entries) }

        /** Stop sampling and WAIT for the thread to be gone, so the transcript
         *  handed to the report is complete and nothing is still writing to it. */
        override fun close() {
            running = false
            thread.interrupt()
            runCatching { thread.join(JOIN_MS) }
        }

        private companion object {
            const val MAX_ENTRIES = 200
            const val JOIN_MS = 2_000L
        }
    }

    /**
     * Wait for [done], and give up IMMEDIATELY on a terminal state.
     *
     * The plain wait cost a whole two-emulator round: the establishment failed
     * at its own thirty-second no-progress deadline, the session fell back to
     * the device list carrying the reason, and the test went on waiting for
     * CONNECTED for another ninety seconds before reporting a timeout that named
     * none of it. A terminal is an answer, and it is reported as the answer.
     */
    private fun awaitProgress(
        vm: TransferViewModel,
        what: String,
        timeoutMs: Long,
        done: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (done()) return
            val s = state(vm)
            val terminal = s.errorKey ?: when {
                s.phase == TransferController.Phase.ENDED -> "session_ended"
                !s.nearby.active -> "nearby_stopped"
                else -> null
            }
            if (terminal != null) {
                error("$what will not happen: the session reached a terminal state ($terminal)")
            }
            Thread.sleep(50)
        }
        error("timed out after ${timeoutMs}ms waiting for: $what")
    }

    @Test
    fun nearbyDirectDiscoveryAndTransfer() {
        val role = requireArg("nearby.role")             // "host" or "guest"
        // A GENERATOR, not the bytes. `am instrument` arguments are re-split by
        // the device shell and travel as one remote command line, so a 300 KiB
        // body as hex is 614 400 characters in a single argv entry — past the
        // limit, and the failure surfaces as an unrelated `am` usage error
        // rather than as "the payload was too big". The shell derives the digest
        // it compares against from the SAME rule, so nothing about the fixture
        // is asserted from one side only.
        val payloadSeed = requireArg("nearby.payloadSeed").toInt()
        val payloadBytes = requireArg("nearby.payloadBytes").toInt()
        val payloadName = requireArg("nearby.name")
        val message = requireArg("nearby.message")
        val peerMessage = requireArg("nearby.peerMessage")
        // Optional: two identical emulator images report the SAME
        // `Build.MODEL`, so a name is not an identifier here and the round
        // instead requires that exactly one other device is listed. Where the
        // peer IS distinguishable — a browser, a Mac — the shell names it, and
        // the round then also proves the right one was chosen out of several.
        val peerName = arg("nearby.peerName")
        val peerFile = requireArg("nearby.peerFile")
        val expectPeerSha = requireArg("nearby.peerSha")
        val hub = arg("nearby.hub") == "1"
        // Fixed, and chosen by the shell: the property that points this build at
        // it must be set before the app process starts, so the port cannot be
        // discovered at run time.
        val trapPort = arg("nearby.trapPort")?.toInt()
        // The origin this build must have resolved. Passed and COMPARED rather
        // than merely required non-empty: `Backend.readDebugOverride` reads a
        // non-public class reflectively and fails closed to production, so a run
        // whose property never took would drive the real service and still look
        // green.
        val expectOrigin = requireArg("nearby.expectOrigin")
        // The real DocumentsUI round trip covers this Activity and is what
        // proves an owned picker does not end the session. ON by default —
        // opting out is explicit, and the report says which happened, so the
        // oracle can refuse a run that quietly skipped it.
        val realPicker = arg("nearby.realPicker") != "0"

        val payload = generatePayload(payloadSeed, payloadBytes)
        val observed = HashMap<String, Any?>()
        var progression: Progression? = null
        val backendHits = AtomicInteger(0)
        // Only the DIRECT path may claim no backend; the hub path is introduced
        // by one on purpose and would fail this listener for the right reason.
        val trap = if (hub || trapPort == null) null else BackendTrap(trapPort, backendHits)

        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                val vm = viewModel()
                progression = Progression(vm)
                // A previous run's release would let this one skip its barrier.
                // `pm clear` removes it too; this is the fence that does not
                // depend on the launcher having done so.
                for (phase in Phase.entries) {
                    runCatching { File(filesDir(), phase.release).delete() }
                }

                // BOTH modes, and by equality. A hub round must be pointed at
                // the run's own throwaway server, never left to fall back.
                assertEquals(
                    "the run must point this build at the origin it says it did",
                    expectOrigin, vm.backendOrigin,
                )
                if (!hub) {
                    assertNotNull(
                        "a direct round must run against a trap origin, or it proves nothing " +
                            "about whether this path contacts a server",
                        trap,
                    )
                    assertEquals(expectOrigin, trap!!.origin)
                }
                observed["realPicker"] = realPicker

                // The real shell, from the destination bar onwards. Starting the
                // session through the view model while the shell sat on Transfer
                // would leave that surface showing the explicit-switch card —
                // which is correct product behaviour and has no file button on
                // it — so the picker later in this round would never be found.
                run {
                    val tab = string(R.string.tab_nearby)
                    val deadline = System.currentTimeMillis() + 30_000
                    var last: Throwable? = null
                    while (System.currentTimeMillis() < deadline) {
                        try {
                            compose.onNode(hasText(tab) and isSelectable()).performClick()
                            last = null
                            break
                        } catch (error: AssertionError) {
                            last = error
                            Thread.sleep(100)
                        }
                    }
                    if (last != null) throw AssertionError("the Nearby destination never appeared", last)
                }
                tapInApp(
                    string(if (hub) R.string.nearby_start_hub else R.string.nearby_start_direct),
                    "the Nearby start button",
                )
                awaitTrue("the room opened") {
                    state(vm).nearby.room == TransferController.NearbyRoom.JOINED
                }
                observed["selfNamed"] = vm.signalingDeviceName

                // DISCOVERY, by name, with no address anywhere in this file.
                awaitTrue("the other device was DISCOVERED and listed", 90_000) {
                    device(vm, peerName) != null
                }
                val peer = device(vm, peerName)!!
                if (peerName != null) {
                    observed["candidates"] = state(vm).nearby.devices.size
                    assertEquals(
                        "the named device is the one that was selected out of everything listed",
                        peerName, peer.name,
                    )
                }
                observed["peerId"] = peer.id
                observed["peerSupportsLink"] = peer.supportsLink
                observed["listed"] = state(vm).nearby.devices.size

                if (role == "guest") {
                    // The user's explicit choice, handed back with the room it
                    // was rendered against.
                    vm.connectToPeer(peer.id, state(vm).nearby.roomId)
                } else {
                    // The user's explicit consent, handed back with the prompt.
                    awaitTrue("the peer asked to connect", 90_000) {
                        state(vm).nearby.incomingId == peer.id
                    }
                    observed["promptedBy"] = peer.id
                    vm.admitPeer(peer.id, state(vm).nearby.incomingPromptId)
                }

                // Fails fast on a terminal rather than waiting out the bound:
                // an establishment that gave up at its own deadline is an
                // answer, not a slow success.
                awaitProgress(vm, "the link to come up", 120_000) {
                    state(vm).phase == TransferController.Phase.CONNECTED
                }
                val sas = state(vm).sas
                assertNotNull("a connected link has compared keys", sas)
                observed["sas"] = sas
                observed["wire"] = state(vm).wire?.name

                // ── messages, both directions ───────────────────────────────
                vm.requestText()
                awaitTrue("the conversation opened", 60_000) {
                    state(vm).textState == com.relayium.protocol.TextLaneSession.State.OPEN ||
                        state(vm).textState ==
                        com.relayium.protocol.TextLaneSession.State.INCOMING_REQUEST
                }
                if (state(vm).textState ==
                    com.relayium.protocol.TextLaneSession.State.INCOMING_REQUEST
                ) {
                    vm.acceptText()
                }
                awaitTrue("the conversation is open", 60_000) {
                    state(vm).textState == com.relayium.protocol.TextLaneSession.State.OPEN
                }
                send(vm, message)
                awaitTrue("the peer's message arrived", 60_000) {
                    state(vm).messages.any { it.fromPeer && it.body == peerMessage }
                }
                observed["peerMessage"] = peerMessage

                // ── files, sequenced so BOTH directions are really covered ───
                send(vm, readyMessage)
                awaitTrue("the peer is ready for a batch", 60_000) {
                    state(vm).messages.any { it.fromPeer && it.body == readyMessage }
                }

                // Staged ONCE, and its URI kept: the real-picker path needs the
                // document to exist in the disposable provider before DocumentsUI
                // opens, and the direct path needs the same URI. Staging twice
                // deleted and recreated identical bytes for no reason.
                val outgoing = stageOutgoing(payloadName, payload)
                val roomBeforePicker = state(vm).nearby.roomId
                val linkBeforePicker = state(vm).linkId
                var survivedPicker = true

                // ONE batch at a time, and the ROLE decides which comes first.
                //
                // The lane does support a batch in each direction at once — the
                // send and receive states are independent — so this is not a
                // protocol limitation. It is what makes the round mean what its
                // header says: an unsequenced pair samples one arbitrary
                // interleaving and reports it as though both directions had been
                // covered. With the real picker it is also the difference
                // between a deterministic run and one where an incoming prompt
                // repaints the screen while DocumentsUI is being driven.
                fun pickAndSend() {
                    if (realPicker) {
                        // The REAL system picker, which puts DocumentsUI in front
                        // and STOPS this Activity. That stop is under test as
                        // much as the transfer is: a session ended by its own
                        // picker can never complete a file flow.
                        tapInApp(string(R.string.files_pick), "the choose-files button")
                        DocumentsUiDriver.enterTestRootThenTap(payloadName)
                        awaitTrue("the pick came back", 120_000) { state(vm).outgoing.isNotEmpty() }
                    } else {
                        vm.sendPicked(listOf(outgoing), state(vm).linkId)
                    }
                    survivedPicker = survivedPicker &&
                        state(vm).nearby.roomId == roomBeforePicker &&
                        state(vm).linkId == linkBeforePicker
                    assertTrue(
                        "the session and its room must survive this app's OWN document picker; " +
                            "an ended-and-rejoined session is not continuity",
                        survivedPicker,
                    )
                }

                fun acceptFolder() {
                    awaitTrue("the peer offered a batch", 180_000) { state(vm).awaitingFolder }
                    if (realPicker) {
                        tapInApp(string(R.string.files_choose_folder), "the choose-folder button")
                        DocumentsUiDriver.enterTestRootFromDrawer()
                        DocumentsUiDriver.tap(
                            "Use this folder", "the tree confirm button", requireEnabled = true,
                        )
                        DocumentsUiDriver.confirmTreeGrant { !state(vm).awaitingFolder }
                    } else {
                        vm.acceptIncoming(state(vm).promptId, treeUri(), state(vm).linkId)
                    }
                    survivedPicker = survivedPicker && state(vm).linkId == linkBeforePicker
                    assertEquals(
                        "and it must survive the FOLDER picker too, which covers the receive side",
                        linkBeforePicker, state(vm).linkId,
                    )
                    awaitTrue("the incoming batch completed", 180_000) {
                        state(vm).savedBatchCount >= 1
                    }
                }

                if (role == "host") {
                    pickAndSend()
                    // The peer's verified COMPLETE, so the guest has genuinely
                    // saved everything before its own batch begins.
                    awaitTrue("the outgoing batch completed", 240_000) {
                        state(vm).sentBatchCount >= 1
                    }
                    acceptFolder()
                } else {
                    acceptFolder()
                    pickAndSend()
                    awaitTrue("the outgoing batch completed", 240_000) {
                        state(vm).sentBatchCount >= 1
                    }
                }
                observed["survivedPicker"] = survivedPicker

                val saved = readSaved(peerFile)
                observed["savedSha"] = saved?.let(::sha256)
                observed["savedBytes"] = saved?.size
                assertEquals(
                    "the bytes this device saved are the bytes the peer sent",
                    expectPeerSha, saved?.let(::sha256),
                )

                send(vm, doneMessage)
                awaitTrue("the peer has everything", 120_000) {
                    state(vm).messages.any { it.fromPeer && it.body == doneMessage }
                }

                // ── the direct path's claim, checked against a listener ──────
                if (trap != null) {
                    observed["backendConnections"] = backendHits.get()
                    assertEquals(
                        "the direct path opened a connection to the backend; it must never " +
                            "contact one, for signalling or for ICE",
                        0, backendHits.get(),
                    )
                }

                // Every assertion this half owns has now passed. Wait for the
                // other half to be able to say the same before ending anything.
                observed[Phase.TRANSFER.field] = "waiting"
                barrier(vm, role, Phase.TRANSFER)
                observed[Phase.TRANSFER.field] = "released"

                // ── finishing, and coming back to the list ───────────────────
                vm.disconnect()
                awaitTrue("back to the device list", 60_000) {
                    state(vm).phase == TransferController.Phase.WAITING_PEER
                }
                assertTrue(
                    "the room survived the transfer: the other device is still listed",
                    state(vm).nearby.devices.any { it.id == peer.id },
                )
                observed["listedAfterDisconnect"] = state(vm).nearby.devices.size

                // The SECOND barrier, and the reason it is separate: stopping
                // Nearby withdraws this device's advertisement, so the other
                // half's peer disappears from ITS list — correctly. One barrier
                // before the disconnect only moved that race one phase later,
                // which is exactly where a hub round failed: the host had
                // verified its own list and stopped while the guest was still
                // verifying its own.
                observed[Phase.ROOM.field] = "waiting"
                barrier(vm, role, Phase.ROOM)
                observed[Phase.ROOM.field] = "released"

                vm.stopNearby()
                awaitTrue("stopping ends the session and the room") {
                    !state(vm).nearby.active && state(vm).phase == TransferController.Phase.ENDED
                }
                observed["pass"] = true
            }
        } finally {
            trap?.close()
            progression?.let {
                it.close()
                observed["progression"] = it.entries()
            }
            report("nearby-report.json", observed)
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * The device this round is for, by the strictest rule the topology allows.
     *
     * With a name, the match must be UNIQUE — two devices answering to it means
     * the round cannot say which one it selected, and passing anyway would be
     * reporting a coin toss. Without one, exactly one other device must be
     * listed; anything else is a discovery result this round cannot interpret.
     */
    /**
     * Tap one of THIS app's own controls, waiting for it to exist.
     *
     * `onNode(...).performClick()` resolves the node once. It does wait for the
     * composition to go idle, but idleness is not the same as the state having
     * arrived: everything this round waits on is a `StateFlow` read from the
     * test thread, and the recomposition it triggers happens on the main thread
     * afterwards. A one-shot lookup therefore fails as "no node matched" for a
     * control that appears microseconds later — a harness failure that reads
     * exactly like a product one.
     *
     * Bounded, and it re-throws the real assertion at the deadline so the
     * failure still names the control that never appeared.
     */
    private fun tapInApp(text: String, what: String, timeoutMs: Long = 30_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                compose.onNode(hasText(text) and hasClickAction()).performClick()
                return
            } catch (error: AssertionError) {
                last = error
                Thread.sleep(100)
            }
        }
        throw AssertionError("$what ('$text') never became tappable", last)
    }

    private fun device(vm: TransferViewModel, name: String?): NearbyDevice? {
        val devices = state(vm).nearby.devices
        if (name == null) return devices.singleOrNull()
        val matches = devices.filter { it.name == name }
        return matches.singleOrNull()
    }

    private fun send(vm: TransferViewModel, body: String) {
        val link = state(vm).linkId
        vm.updateDraft(body, link)
        vm.sendDraft(link)
        // `awaitProgress`, not a plain wait: a send that will never be observed
        // because the session ended under it is an ANSWER, and saying so beats
        // spending the full bound and then reporting a timeout that names
        // neither the message nor the reason.
        awaitProgress(vm, "the message to enter the channel: $body", 60_000) {
            state(vm).messages.any { !it.fromPeer && it.body == body }
        }
    }

    /**
     * Neither endpoint tears down until BOTH have finished asserting.
     *
     * Without this the round has a real race and it is not a flake: the local
     * message history is session state, so it is cleared when the session ends.
     * One side finished, disconnected and stopped Nearby; the other was still
     * polling its OWN sent history for the last message — which had already
     * gone over the wire and been observed by the peer — and its history was
     * emptied by the drop before the poll sampled it. It failed for having
     * succeeded slightly later.
     *
     * The barrier is out of band on purpose. It is NOT the transfer's own wire,
     * which is the thing under test and cannot be its own completion oracle, and
     * it is not a fixed sleep, which proves nothing about what the other side
     * did. Each half writes `nearby-ready.json` into its own app files directory
     * only AFTER every assertion it owns has passed; the launcher — which is the
     * one process that can see both devices — waits for both and then writes
     * `nearby-release` back to each. Only then does either disconnect.
     *
     * The same shape as the terminal in-band handshake the existing Web interop
     * round uses, moved out of band because here BOTH endpoints are ours and
     * neither may end the session the other is still reading.
     */
    private fun barrier(vm: TransferViewModel, role: String, phase: Phase) {
        report(phase.ready, mapOf("role" to role, "phase" to phase.name, "ready" to true))
        // NOT `awaitProgress` for the ROOM phase: by then a disconnect has
        // already happened on this side and the session is deliberately over, so
        // "the session reached a terminal state" is the expected condition
        // rather than a failure. A plain bounded wait is the honest one here.
        val deadline = System.currentTimeMillis() + BARRIER_MS
        while (System.currentTimeMillis() < deadline) {
            if (File(filesDir(), phase.release).exists()) return
            if (phase == Phase.TRANSFER) {
                val s = state(vm)
                val terminal = s.errorKey ?: if (!s.nearby.active) "nearby_stopped" else null
                if (terminal != null) {
                    error("the ${phase.name} barrier cannot complete: this side reached $terminal")
                }
            }
            Thread.sleep(100)
        }
        error("timed out after ${BARRIER_MS}ms at the ${phase.name} barrier")
    }

    private fun filesDir(): File =
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            .targetContext.filesDir

    /**
     * The fixture, from a seed and a length.
     *
     * Deliberately NOT random: a failing round has to be reproducible from the
     * two numbers in its log. The shell computes the digest it compares against
     * from this same rule, so the fixture is never asserted from one side only.
     */
    private fun generatePayload(seed: Int, count: Int): ByteArray =
        ByteArray(count) { i -> ((i * 31 + seed) % 251).toByte() }

    private fun string(id: Int) =
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            .targetContext.getString(id)

    /**
     * A loopback listener standing in for the Relayium backend.
     *
     * It answers NOTHING — it only counts connections — because the assertion is
     * that none arrives. A round where the app reached for signalling or ICE
     * registers here whether or not the request would have succeeded, which is
     * the point: "it failed to reach the server" is not the same claim as "it
     * never tried".
     */
    private class BackendTrap(port: Int, private val hits: AtomicInteger) : AutoCloseable {
        private val server = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getLoopbackAddress(), port))
        }
        val origin = "http://127.0.0.1:${server.localPort}"

        private val thread = Thread({
            while (true) {
                val socket = try {
                    server.accept()
                } catch (_: IOException) {
                    return@Thread
                }
                hits.incrementAndGet()
                runCatching { socket.close() }
            }
        }, "relayium-backend-trap").apply { isDaemon = true; start() }

        override fun close() {
            runCatching { server.close() }
            runCatching { thread.join(1_000) }
        }
    }
}
