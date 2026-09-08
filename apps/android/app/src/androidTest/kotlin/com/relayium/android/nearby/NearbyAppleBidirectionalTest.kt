package com.relayium.android.nearby

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.DocumentsUiDriver
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.readSaved
import com.relayium.android.InteropDriver.report
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.sha256
import com.relayium.android.InteropDriver.stageOutgoing
import com.relayium.android.InteropDriver.state
import com.relayium.android.InteropDriver.viewModel
import com.relayium.android.MainActivity
import com.relayium.android.R
import com.relayium.android.TransferController
import com.relayium.android.TransferViewModel
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Android half of **Android ↔ Apple, BOTH directions, on one real Bonjour
 * link.**
 *
 * `scripts/android-nearby-apple-bidirectional-acceptance.sh` owns the Mac side:
 * it builds a fixture caller that composes the UNCHANGED shipped
 * `LocalPeerAdvertisement`, `LocalPeerSignalingChannel`,
 * `NetworkLocalPeerTransport`, `LanDiscoveryModel` and `LinkWorkspaceModel`,
 * waits for that peer to report `resident` — which the shipped lifecycle sets
 * only once the Bonjour listener AND the browser are both ready — and compares
 * every receipt afterwards.
 *
 * ## What only this can show
 *
 * [NearbyAppleCounterpartTest] proves ONE direction, because the counterpart it
 * drives (`LocalTransferPeer --role local-link-peer`) finishes on an inbound
 * batch and refuses `/drive`. So until this file existed, nothing had ever seen
 * the shipped Apple modules ORIGINATE a local-link transfer: not the manifest
 * they announce, not the chunk stream they produce, not the text frame they
 * seal, and not this app's receive path reading any of it. That is the half of
 * the product an iPhone user spends most of their time in.
 *
 * It also covers, for the first time on this path, an inbound link Android did
 * not ask for: with `-e apple.dialSide apple` the Mac presses Connect and this
 * side answers the prompt.
 *
 * ## Everything here is the real thing
 *
 *  * the real debug APK, through its own `MainActivity`, the `TransferViewModel`
 *    that Activity created, real `NsdManager`, real TCP signalling, real native
 *    WebRTC and the real SAF stack;
 *  * the real system pickers on BOTH sides of the transfer — DocumentsUI for
 *    the outgoing files and the real tree grant for the incoming batch. Each is
 *    a separate Activity, so each STOPS this one, and that stop is under test as
 *    much as the transfer is;
 *  * no address is passed to this half at any point. The Mac must be FOUND, by
 *    the name and the identity it advertises.
 *
 * ## What it deliberately does NOT claim
 *
 * A Mac running the shipped modules is not an iPhone. This proves the protocol
 * against the Apple IMPLEMENTATION, never against Apple hardware, and it must
 * never be described as a physical-device result.
 *
 * One asymmetry is a property of the product rather than of this harness and is
 * asserted as such: Android's Nearby send surface is
 * `ActivityResultContracts.OpenMultipleDocuments` — files, never a folder — so
 * only the Apple side can originate a batch with a nested `path`. This side
 * sends its three files as three batches on ONE link, which is a path a
 * single-batch round never takes.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class NearbyAppleBidirectionalTest {

    /**
     * For the IN-APP taps only. `DocumentsUiDriver.byLabel` is a case-insensitive
     * SUBSTRING match — right for DocumentsUI, whose labels change case between
     * releases — and "Nearby" is a substring of "Nearby devices", so it cannot
     * tell this app's destination tab from the heading underneath it.
     */
    @get:Rule
    val compose = createEmptyComposeRule()

    /**
     * The barrier phases, in the order the round passes through them.
     *
     * TWO of them, and distinct, because there are two separate moments at which
     * one endpoint's ordinary next step destroys something the other is still
     * asserting against — and one barrier only moves the race to the phase after
     * it. `TRANSFER` guards the SESSION (the message history is session state,
     * and the Mac's receipts are read off a live link); `ROOM` guards the
     * ROSTER, because each side legitimately vanishes from the other's list the
     * moment it stops advertising, which is correct product behaviour and must
     * not be raced.
     *
     * Out of band on purpose. It is NOT the transfer's own wire, which is the
     * thing under test and cannot be its own completion oracle, and it is not a
     * fixed sleep, which proves nothing about what the other side did.
     */
    private enum class Phase(val ready: String, val release: String, val field: String) {
        /** Everything the transfer itself asserts. Held before any disconnect. */
        TRANSFER("apple-bidi-ready.json", "apple-bidi-release", "barrier"),

        /** The room outliving its own transfer. Held before any stopNearby. */
        ROOM("apple-bidi-room-ready.json", "apple-bidi-room-release", "barrierRoom"),
    }

    /** How long a half waits for its counterpart to finish asserting. Longer
     *  than any single wait in the round, because the other side may still be
     *  reading receipts off a link this side is holding open for it. */
    private val barrierMs = 180_000L

    /** Written once this side has joined, discovered the Mac and verified its
     *  identity — which is the precondition the LAUNCHER needs before it tells
     *  the Mac to dial. Sequencing this explicitly is what stops a Connect that
     *  raced this side's own discovery from being read as a product failure. */
    private val discoveredMarker = "apple-bidi-discovered.json"

    @Test
    fun exchangesFilesAndTextWithTheAppleLocalLinkPeer() {
        // The name the Mac fixture is ACTUALLY advertising under, read from its
        // own control API by the launcher, plus the identity it minted. Both are
        // compared, and the identity is why: two emulator images report the same
        // `Build.MODEL`, names are not identifiers on this link, and a round
        // that matched some other device would otherwise pass having proved
        // nothing about the peer it names.
        //
        // The NAME travels as HEX because a real advertised name contains
        // spaces and `adb shell` re-joins argv into ONE remote command line,
        // where host-side quoting does not survive. The identity is 32 hex
        // characters and travels as itself.
        val peerName = decodeHex(requireArg("apple.peerNameHex"))
        val peerIdentity = requireArg("apple.peerIdentity")
        val dialSide = requireArg("apple.dialSide")
        val expectOrigin = requireArg("apple.expectOrigin")
        // Whitespace-significant and non-ASCII on both sides: the bodies ride
        // AEAD-sealed text frames, so anything that trims, normalises or
        // re-encodes surfaces here and nowhere else.
        val message = decodeHex(requireArg("apple.messageHex"))
        val peerMessage = decodeHex(requireArg("apple.peerMessageHex"))
        // A GENERATOR plus a manifest, never the bytes: 307 200 bytes as hex is
        // 614 400 characters in one argv entry, past the device shell's limit,
        // and the failure surfaces as an unrelated `am` usage error rather than
        // as "the payload was too big". The launcher derives the digests it
        // compares from the SAME rule, so nothing about the fixture is asserted
        // from one side only.
        val outgoing = parsePlan(decodeHex(requireArg("apple.outgoingPlanHex")))
        assertTrue("the round must send at least one file", outgoing.isNotEmpty())

        val observed = HashMap<String, Any?>()
        var progression: Progression? = null
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                val vm = viewModel()
                progression = Progression(vm)

                // A previous run's release would let this one skip its barrier.
                // `pm clear` removes them too; this is the fence that does not
                // depend on the launcher having done so.
                for (phase in Phase.entries) {
                    runCatching { File(filesDir(), phase.release).delete() }
                }
                runCatching { File(filesDir(), discoveredMarker).delete() }

                // By EQUALITY, not merely non-empty: `Backend.readDebugOverride`
                // reads a non-public class reflectively and fails CLOSED to
                // production, so a run whose property never took would drive the
                // real service and still look green.
                assertEquals(
                    "the run must point this build at its own throwaway origin",
                    expectOrigin, vm.backendOrigin,
                )
                observed["dialSide"] = dialSide

                // The real shell, from the destination bar onwards. Starting the
                // session through the view model while the shell sat on Transfer
                // would leave that surface showing the explicit-switch card —
                // correct product behaviour, and it has no file button on it —
                // so the picker later in this round would never be found.
                tapInApp(string(R.string.tab_nearby), "the Nearby destination", selectable = true)
                tapInApp(string(R.string.nearby_start_direct), "the local-link start button")
                awaitTrue("the local link came up") {
                    state(vm).nearby.room == TransferController.NearbyRoom.JOINED
                }
                observed["selfNamed"] = vm.signalingDeviceName

                // ── DISCOVERY, not addressing ───────────────────────────────
                awaitTrue("the Apple peer was DISCOVERED by name", 120_000) {
                    state(vm).nearby.devices.count { it.name == peerName } == 1
                }
                val peer = state(vm).nearby.devices.first { it.name == peerName }
                observed["peerId"] = peer.id
                observed["peerName"] = peer.name
                observed["candidates"] = state(vm).nearby.devices.size
                observed["listed"] = state(vm).nearby.devices.size
                assertEquals(
                    "the discovered device must be the exact advertisement the Mac minted; a " +
                        "name is not an identity on this link",
                    peerIdentity, peer.id,
                )
                assertTrue(
                    "the Apple peer must announce link/1, or this round would be testing the " +
                        "legacy wire while claiming to test link/1",
                    peer.supportsLink,
                )

                // The launcher waits for this before it tells the Mac to dial.
                report(discoveredMarker, mapOf("peerId" to peer.id, "ready" to true))

                // ── the connection is ASKED for and ANSWERED ────────────────
                if (dialSide == "android") {
                    // The user's explicit choice, handed back with the room it
                    // was rendered against.
                    vm.connectToPeer(peer.id, state(vm).nearby.roomId)
                } else {
                    // The user's explicit consent, handed back with the prompt.
                    // The prompt's peer id is compared to the one discovery
                    // listed: a consent granted to a device other than the one
                    // this round names would otherwise pass.
                    awaitProgress(vm, "the Apple peer to ask to connect", 120_000) {
                        state(vm).nearby.incomingId == peer.id
                    }
                    observed["promptedBy"] = state(vm).nearby.incomingId
                    vm.admitPeer(peer.id, state(vm).nearby.incomingPromptId)
                }

                awaitProgress(vm, "the link to the Apple peer to come up", 120_000) {
                    state(vm).phase == TransferController.Phase.CONNECTED
                }
                val sas = state(vm).sas
                assertNotNull("a connected link has compared keys", sas)
                observed["sas"] = sas
                observed["wire"] = state(vm).wire?.name
                assertEquals(
                    "the Apple counterpart must be reached on link/1",
                    TransferController.Wire.LINK.name, state(vm).wire?.name,
                )
                val linkAtStart = state(vm).linkId
                val roomAtStart = state(vm).nearby.roomId

                // ── text, both ways ─────────────────────────────────────────
                //
                // The MAC opens the conversation, so this side only ever
                // answers. Both sides requesting would be a race this round has
                // no reason to run, and the launcher sequences the Mac's send
                // after the link is open.
                awaitProgress(vm, "the Apple peer to open the conversation", 120_000) {
                    state(vm).textState == com.relayium.protocol.TextLaneSession.State.OPEN ||
                        state(vm).textState ==
                        com.relayium.protocol.TextLaneSession.State.INCOMING_REQUEST
                }
                if (state(vm).textState ==
                    com.relayium.protocol.TextLaneSession.State.INCOMING_REQUEST
                ) {
                    vm.acceptText()
                }
                awaitProgress(vm, "the conversation to be open", 60_000) {
                    state(vm).textState == com.relayium.protocol.TextLaneSession.State.OPEN
                }
                // Judged HERE, on the receiving side, and by equality against
                // the whole body: a message that arrived with different
                // whitespace is a different message, and that is exactly the
                // class of defect a sealed text frame can have.
                awaitProgress(vm, "the Apple peer's message to arrive", 120_000) {
                    state(vm).messages.any { it.fromPeer && it.body == peerMessage }
                }
                observed["peerMessageArrived"] = true
                send(vm, message)
                // Recorded, but NOT the acceptance for this direction: this is
                // only that the frame entered our own channel. The launcher
                // compares it against the Mac's OWN received messages.
                observed["messageSent"] = true

                // ── Apple → Android: the batch this side RECEIVES ────────────
                //
                // First, because the Mac's offer is what puts this side into
                // `awaitingFolder`, and because the manifest has to be read off
                // the prompt: `incoming` is CLEARED on completion, so a receipt
                // derived after the fact would have nothing to key on.
                awaitProgress(vm, "the Apple peer to offer its batch", 240_000) {
                    state(vm).awaitingFolder
                }
                val inboundManifest = state(vm).incoming.map { it.name to it.path }
                observed["inboundManifest"] = inboundManifest.map { (name, path) ->
                    mapOf("name" to name, "path" to path)
                }
                assertTrue(
                    "the Apple peer offered an empty manifest",
                    inboundManifest.isNotEmpty(),
                )

                // The REAL tree grant, which covers the receive side of an owned
                // picker: DocumentsUI is a separate Activity and stops this one.
                tapInApp(string(R.string.files_choose_folder), "the choose-folder button")
                DocumentsUiDriver.enterTestRootFromDrawer()
                DocumentsUiDriver.tap(
                    "Use this folder", "the tree confirm button", requireEnabled = true,
                )
                DocumentsUiDriver.confirmTreeGrant { !state(vm).awaitingFolder }
                assertEquals(
                    "the session must survive the FOLDER picker; an ended-and-rejoined session " +
                        "is not continuity",
                    linkAtStart, state(vm).linkId,
                )
                awaitProgress(vm, "the incoming batch to complete", 300_000) {
                    state(vm).savedBatchCount >= 1
                }
                observed["savedBatchCount"] = state(vm).savedBatchCount

                // The RECEIPT: read back through the provider, per manifest
                // entry, keyed by the document id the app's own writer would
                // have created. A name, a size and a digest — the only three
                // terms that can tell a real transfer from a plausible one.
                observed["received"] = inboundManifest.map { (name, path) ->
                    val documentId = path ?: name
                    val bytes = readSaved(documentId)
                    assertNotNull(
                        "the app reported a completed batch but nothing is readable at " +
                            "'$documentId'",
                        bytes,
                    )
                    mapOf(
                        "name" to name,
                        "path" to path,
                        "size" to bytes!!.size,
                        "sha256" to sha256(bytes),
                    )
                }

                // ── Android → Apple: one batch per file, real picker each time ─
                var sentSoFar = state(vm).sentBatchCount
                var survivedPicker = true
                val batches = ArrayList<Map<String, Any?>>()
                for (entry in outgoing) {
                    val sentBefore = state(vm).sentBatchCount
                    val target = sentBefore + 1
                    stageOutgoing(entry.name, generatePayload(entry.seed, entry.size))
                    tapInApp(string(R.string.files_pick), "the choose-files button")
                    DocumentsUiDriver.enterTestRootThenTap(entry.name)

                    // **Either the pick is still pending, OR it has already been
                    // confirmed.** `outgoing` is EPHEMERAL: the controller clears
                    // it on `SendComplete`, and a zero-byte file can be picked,
                    // sent and acknowledged inside one 50 ms sample — which is
                    // exactly what happened on the third batch of a round whose
                    // send counter had ALREADY reached 2. Waiting only for the
                    // transient made a delivered batch look like a pick that
                    // never came back.
                    //
                    // This weakens nothing: the counter below is the receipt,
                    // and it is unchanged. All this does is stop the round
                    // failing on a state it was never guaranteed to observe.
                    var outgoingObserved = false
                    awaitProgress(vm, "the pick of ${entry.name} to register", 120_000) {
                        val now = state(vm)
                        if (now.outgoing.isNotEmpty()) outgoingObserved = true
                        outgoingObserved || now.sentBatchCount >= target
                    }
                    // A refused pick is an ANSWER, and its KIND is the whole
                    // diagnosis. Reported as the enum only: a filename is the
                    // fixture's, but a picker error is not a place to widen what
                    // this report carries.
                    vm.pickError.value?.let { error ->
                        throw AssertionError(
                            "the picker refused ${entry.name}: kind=${error.kind}, " +
                                "linkId=${error.linkId} (expected ${state(vm).linkId})",
                        )
                    }
                    survivedPicker = survivedPicker &&
                        state(vm).nearby.roomId == roomAtStart &&
                        state(vm).linkId == linkAtStart
                    assertTrue(
                        "the session and its room must survive this app's OWN document picker",
                        survivedPicker,
                    )
                    // The peer's own verified COMPLETE, and the ONLY thing that
                    // may satisfy this direction. Not "we finished sending":
                    // cancel and failure also empty `outgoing` and
                    // `sendProgress`, so their absence proves nothing.
                    awaitProgress(vm, "the Apple peer to confirm the batch for ${entry.name}",
                                  300_000) {
                        state(vm).sentBatchCount >= target
                    }
                    sentSoFar = target
                    batches.add(
                        mapOf(
                            "name" to entry.name,
                            "sentBefore" to sentBefore,
                            "sentAfter" to state(vm).sentBatchCount,
                            // False is not a failure — see the wait above. It is
                            // recorded so a round that never saw one can be told
                            // from a round where the state machine changed.
                            "outgoingObserved" to outgoingObserved,
                        ),
                    )
                }
                observed["batches"] = batches
                observed["sentBatchCount"] = state(vm).sentBatchCount
                observed["survivedPicker"] = survivedPicker
                observed["pickError"] = vm.pickError.value?.kind?.name
                assertEquals(
                    "the Apple peer must have confirmed one batch per file this round sent",
                    outgoing.size, state(vm).sentBatchCount,
                )

                // Every assertion this half owns has now passed. Wait for the
                // other half to be able to say the same before ending anything.
                observed[Phase.TRANSFER.field] = "waiting"
                barrier(vm, Phase.TRANSFER)
                observed[Phase.TRANSFER.field] = "released"

                // ── finishing, and coming back to the list ───────────────────
                vm.disconnect()
                awaitTrue("back to the device list", 60_000) {
                    state(vm).phase == TransferController.Phase.WAITING_PEER
                }
                // **Waited for, not sampled once.** The claim is that the ROOM
                // outlived its own transfer, and the observable for that is the
                // peer being listable — not the roster happening to hold it at
                // one instant. Discovery on this link legitimately flaps: a
                // measured round saw this device's own list go 1→0→1→0→1→0 over
                // two minutes while the Mac advertised continuously, so a single
                // sample can land in a gap and fail for something that is not a
                // link defect.
                //
                // Bounded, and it waits for the REAL roster. Nothing here
                // fabricates a peer or relaxes what counts as one: the id must
                // be the device this round linked to.
                awaitTrue("the room survived its own transfer: the Apple peer is listed", 60_000) {
                    state(vm).nearby.devices.any { it.id == peer.id }
                }
                observed["listedAfterDisconnect"] = state(vm).nearby.devices.size

                // The SECOND barrier, and the reason it is separate: stopping
                // Nearby withdraws this device's advertisement, so the Mac's
                // roster loses it — correctly. One barrier before the disconnect
                // only moves that race one phase later.
                observed[Phase.ROOM.field] = "waiting"
                barrier(vm, Phase.ROOM)
                observed[Phase.ROOM.field] = "released"

                vm.stopNearby()
                awaitTrue("stopping ends the session and the room") {
                    !state(vm).nearby.active && state(vm).phase == TransferController.Phase.ENDED
                }
                observed["pass"] = true
            }
        } finally {
            progression?.let {
                it.close()
                observed["progression"] = it.entries()
            }
            report("apple-bidi-report.json", observed)
        }
    }

    // ── the plan ────────────────────────────────────────────────────────────

    private data class Outgoing(val name: String, val seed: Int, val size: Int)

    /**
     * The outgoing manifest, from the launcher's own document.
     *
     * A hand-rolled reader rather than a JSON dependency, and deliberately
     * STRICT: it takes exactly the four fields it needs and fails on anything
     * else, so a launcher that changed the shape gets an error naming the plan
     * rather than a round that silently sent one file. The shape is
     * `{"files":[{"name":"…","seed":N,"size":N}, …]}`, written by the launcher
     * and delivered as hex for the reason [decodeHex] records.
     */
    private fun parsePlan(document: String): List<Outgoing> {
        val out = ArrayList<Outgoing>()
        val entries = Regex("\\{[^{}]*\\}").findAll(document)
        for (match in entries) {
            val body = match.value
            val name = Regex("\"name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
                .find(body)?.groupValues?.get(1)
                ?: error("a plan entry has no name: the launcher's document is not the expected shape")
            val seed = Regex("\"seed\"\\s*:\\s*(-?\\d+)").find(body)?.groupValues?.get(1)?.toInt()
                ?: error("the plan entry for '$name' has no seed")
            val size = Regex("\"size\"\\s*:\\s*(\\d+)").find(body)?.groupValues?.get(1)?.toInt()
                ?: error("the plan entry for '$name' has no size")
            out.add(Outgoing(unescape(name), seed, size))
        }
        if (out.isEmpty()) error("the outgoing plan declared no files")
        return out
    }

    /** The JSON escapes the launcher's own encoder can emit. Anything else is a
     *  document this reader does not understand, and it says so rather than
     *  passing a mangled filename to the picker. */
    private fun unescape(raw: String): String {
        val out = StringBuilder(raw.length)
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            if (c != '\\') {
                out.append(c)
                i += 1
                continue
            }
            i += 1
            require(i < raw.length) { "the plan ends in a trailing escape" }
            when (val escape = raw[i]) {
                '"', '\\', '/' -> out.append(escape)
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'u' -> {
                    require(i + 4 < raw.length) { "the plan has a truncated \\u escape" }
                    out.append(Char(raw.substring(i + 1, i + 5).toInt(16)))
                    i += 4
                }
                else -> error("the plan carries an escape this reader does not accept: \\$escape")
            }
            i += 1
        }
        return out.toString()
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * Every state this round passed through, in order, with elapsed times.
     *
     * A timeout says only that something did not happen. This says WHAT the
     * session was doing while it did not happen. Deliberately narrow: phase,
     * room state, wire NAME, error KEY, device count, and whether a selection
     * and a prompt exist. No SDP, no candidate, no key, no SAS, no message body,
     * no file content, no peer id beyond the short fragment the UI itself shows.
     * Bounded, because a stuck round would otherwise sample forever.
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
                // Android's default handler, which KILLS THE PROCESS. That is
                // not theoretical: it crashed the app during the `finally` of a
                // round whose transfers had all SUCCEEDED.
                Thread.currentThread().interrupt()
            } catch (_: Throwable) {
                // A diagnostic must never be able to fail the thing it is
                // watching.
            }
        }, "relayium-apple-bidi-progression").apply { isDaemon = true; start() }

        private fun snapshot(): String {
            val s = state(vm)
            val selected = s.nearby.selectedId?.take(8) ?: "-"
            val incoming = s.nearby.incomingId?.take(8) ?: "-"
            return "phase=${s.phase} room=${s.nearby.room} wire=${s.wire?.name ?: "-"} " +
                "err=${s.errorKey ?: "-"} devices=${s.nearby.devices.size} " +
                "text=${s.textState} awaitingFolder=${s.awaitingFolder} " +
                "saved=${s.savedBatchCount} sent=${s.sentBatchCount} " +
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
            const val MAX_ENTRIES = 300
            const val JOIN_MS = 2_000L
        }
    }

    /**
     * Wait for [done], and give up IMMEDIATELY on a terminal state.
     *
     * A plain wait once cost a whole round: the establishment failed at its own
     * thirty-second no-progress deadline, the session fell back to the device
     * list carrying the reason, and the test went on waiting for CONNECTED for
     * another ninety seconds before reporting a timeout that named none of it. A
     * terminal is an answer, and it is reported as the answer.
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

    private fun send(vm: TransferViewModel, body: String) {
        val link = state(vm).linkId
        vm.updateDraft(body, link)
        vm.sendDraft(link)
        awaitProgress(vm, "the message to enter the channel", 60_000) {
            state(vm).messages.any { !it.fromPeer && it.body == body }
        }
    }

    /**
     * Neither endpoint tears down until BOTH have finished asserting.
     *
     * Without this the round has a real race and it is not a flake: the local
     * message history is session state, so it is cleared when the session ends,
     * and the Mac's receipts are read off a LIVE link. Each half signals only
     * after every assertion it owns has passed; the launcher — the one process
     * that can see both endpoints — waits for both and then releases each.
     */
    private fun barrier(vm: TransferViewModel, phase: Phase) {
        report(phase.ready, mapOf("phase" to phase.name, "ready" to true))
        // NOT `awaitProgress` for the ROOM phase: by then a disconnect has
        // already happened on this side and the session is deliberately over,
        // so "the session reached a terminal state" is the expected condition
        // rather than a failure. A plain bounded wait is the honest one here.
        val deadline = System.currentTimeMillis() + barrierMs
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
        error("timed out after ${barrierMs}ms at the ${phase.name} barrier")
    }

    /**
     * Tap one of THIS app's own controls: wait for it to EXIST, then reach it
     * and press it once.
     *
     * The two halves are separate on purpose. `onNode(...).performClick()`
     * resolves the node once, and although it waits for the composition to go
     * idle, idleness is not the state having arrived: everything this round
     * waits on is a `StateFlow` read from the test thread, and the recomposition
     * it triggers happens on the main thread afterwards. So APPEARANCE is
     * retried. The PRESS is not — see [reachAndClick].
     */
    private fun tapInApp(
        text: String,
        what: String,
        selectable: Boolean = false,
        timeoutMs: Long = 60_000,
    ) {
        val matcher =
            if (selectable) hasText(text) and isSelectable()
            else hasText(text) and hasClickAction()
        awaitNode(matcher, "$what ('$text')", timeoutMs)
        reachAndClick(compose.onNode(matcher), "$what ('$text')")
    }

    /** Wait for a node to EXIST, and nothing more. Separate from clicking it
     *  because the retry belongs to appearance and the click must happen
     *  exactly once. */
    private fun awaitNode(matcher: SemanticsMatcher, what: String, timeoutMs: Long = 60_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                compose.onNode(matcher).assertExists()
                return
            } catch (error: AssertionError) {
                last = error
                Thread.sleep(100)
            }
        }
        throw AssertionError("$what never appeared", last)
    }

    /**
     * Scroll a control into view, prove it is REACHABLE, then click it ONCE.
     *
     * A bare `performClick()` is not what a person does. Compose will happily
     * click a node that exists in the semantics tree but is scrolled off
     * screen, so a control below the fold reports a successful click and
     * nothing happens — indistinguishable from the product ignoring the press.
     * This round is exposed to exactly that: it sends three batches on one
     * link, and the session column grows a transfer row per batch, so the
     * choose-files button moves down the screen as the round proceeds.
     *
     * `performScrollTo` first, then `assertIsDisplayed` and `assertIsEnabled`,
     * so "the user could not reach this control" and "the control did nothing"
     * are different failures with different messages. The same shape every
     * other real UI acceptance here uses.
     *
     * ONE click, never a blind retry: a second press is a second action, and an
     * assertion that passes only because it pressed twice is not evidence about
     * the press.
     */
    private fun reachAndClick(node: SemanticsNodeInteraction, what: String) {
        // A control with no scrollable ancestor cannot be scrolled to, and that
        // is not a failure — it is already wherever it is.
        runCatching { node.performScrollTo() }
        try {
            node.assertIsDisplayed()
        } catch (error: AssertionError) {
            throw AssertionError(
                "$what exists but is NOT DISPLAYED even after scrolling to it. If this " +
                    "reproduces it is a product finding — a control the user cannot reach — " +
                    "rather than a harness detail. ${geometryOf(node)}",
                error,
            )
        }
        try {
            node.assertIsEnabled()
        } catch (error: AssertionError) {
            throw AssertionError(
                "$what is displayed but DISABLED, so this round cannot press it. " +
                    "${geometryOf(node)}",
                error,
            )
        }
        node.performClick()
    }

    /** Where a control actually is, and how big its window is. GEOMETRY ONLY —
     *  no label text, no draft, no message body, no file content. */
    private fun geometryOf(node: SemanticsNodeInteraction): String =
        runCatching {
            val semantics = node.fetchSemanticsNode()
            val bounds = semantics.boundsInRoot
            val root = semantics.root?.semanticsOwner?.rootSemanticsNode?.boundsInRoot
            "bounds=[${bounds.left.toInt()},${bounds.top.toInt()}," +
                "${bounds.right.toInt()},${bounds.bottom.toInt()}] " +
                "root=[${root?.left?.toInt()},${root?.top?.toInt()}," +
                "${root?.right?.toInt()},${root?.bottom?.toInt()}] " +
                "belowFold=${root != null && bounds.bottom > root.bottom}"
        }.getOrElse { "geometry unavailable (${it.javaClass.simpleName})" }

    /** Values that cannot survive `adb shell`'s re-joining of argv: `adb shell`
     *  concatenates argv into ONE remote command line, so an extra containing a
     *  space, a tab or a non-ASCII byte splits there and `am` reports an
     *  unrelated usage error — or worse, a fragment lands on the runner. */
    private fun decodeHex(hex: String): String {
        require(hex.length % 2 == 0) { "a hex extra has an odd length" }
        return String(
            ByteArray(hex.length / 2) { i ->
                val high = Character.digit(hex[i * 2], 16)
                val low = Character.digit(hex[i * 2 + 1], 16)
                require(high >= 0 && low >= 0) { "a hex extra is not hexadecimal" }
                ((high shl 4) or low).toByte()
            },
            Charsets.UTF_8,
        )
    }

    /**
     * The fixture, from a seed and a length.
     *
     * Deliberately NOT random: a failing round has to be reproducible from the
     * two numbers in its log. The launcher computes the digest it compares
     * against from this same rule, so the fixture is never asserted from one
     * side only.
     */
    private fun generatePayload(seed: Int, count: Int): ByteArray =
        ByteArray(count) { i -> ((i * 31 + seed) % 251).toByte() }

    private fun string(id: Int) =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(id)

    private fun filesDir(): File =
        InstrumentationRegistry.getInstrumentation().targetContext.filesDir
}
