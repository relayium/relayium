package com.relayium.android.nearby

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasAnySibling
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.DocumentsUiDriver
import com.relayium.android.InteropDriver.arg
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.listTree
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
import com.relayium.protocol.TextLaneSession
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Android half of **Android ↔ the real Web, in the code-less room**.
 *
 * `scripts/android-nearby-web-acceptance.sh` owns the throwaway Go server, the
 * built Web bundle, the three browser devices and every comparison. This half
 * drives the shipped app: `MainActivity`, the `TransferViewModel` it created,
 * its `TransferController`, the real WebSocket rendezvous, real native WebRTC
 * and the real SAF stack, including the REAL system document picker.
 *
 * ## What only this can show
 *
 * `NearbyLanAcceptanceTest` puts two copies of THIS implementation on one link,
 * and two copies of one bug agree perfectly. `NearbyAppleCounterpartTest` puts
 * this build in front of the Apple modules over Bonjour, in one direction. This
 * round is the first time the code-less ROOM — a WebSocket rendezvous keyed by
 * the address the server observes, not NSD — carries a session between this
 * build and the shipped browser bundle, in BOTH directions, with the phone
 * choosing one browser device out of three.
 *
 * ## The selection claim, and why it is driven through the UI
 *
 * The claim is "the device the user picked, out of several" — so:
 *
 *  * three browser devices are in the room, and this half fails if fewer than
 *    three candidates are listed;
 *  * `nearbyDevices` SORTS by name, so the launcher names the target so that it
 *    sorts LAST; the browser half also joins it LAST. Neither a first-in-roster
 *    fallback nor a first-rendered one can reach the target by accident, and
 *    both the model order and the ON-SCREEN order are recorded so the oracle
 *    checks that rather than trusting this comment;
 *  * the selection is a real tap on the Connect button that is a SIBLING of the
 *    target's own displayed name — not `viewModel.connectToPeer`, which would
 *    bypass exactly the row-to-peer binding a wrong selection lives in.
 *
 * `-e web.wrongSelection 1` taps the FIRST row instead. It is the negative
 * control for all of the above: with it, the round MUST fail.
 *
 * ## What a green run does NOT claim
 *
 * Emulator and developer hardware, not a physical phone. One room shape (the
 * hub), not the direct path — that lane is `NearbyLanAcceptanceTest`. And the
 * browser's Save-as and folder-relative-path seams are stubbed on the Web side;
 * see `web/e2e/android-nearby-hub.mjs` for exactly what they do and do not do.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class NearbyWebCounterpartTest {

    /**
     * For the IN-APP taps only. `DocumentsUiDriver.byLabel` is a case-insensitive
     * SUBSTRING match — right for DocumentsUI, whose labels change case between
     * releases — and would not tell this app's "Nearby" destination from the
     * heading underneath it. Compose's own matchers are exact.
     */
    @get:Rule
    val compose = createEmptyComposeRule()

    /**
     * The barrier phases. TWO, and distinct, for the two separate moments at
     * which one endpoint's ordinary next step destroys something the other is
     * still asserting against: `TRANSFER` guards the SESSION (the message
     * history is session state, and the browser's save ledger is read after its
     * own assertions), `ROOM` guards the ROSTER (three browser devices leaving
     * the room would correctly empty this device's list while it checks that the
     * room survived its own transfer).
     */
    private enum class Phase(val ready: String, val release: String, val field: String) {
        TRANSFER("nearby-web-ready.json", "nearby-web-release", "barrier"),
        ROOM("nearby-web-room-ready.json", "nearby-web-room-release", "barrierRoom"),
    }

    private val barrierMs = 300_000L

    @Test
    fun exchangesWithThreeBrowserDevicesInTheCodelessRoom() {
        // ── the round's inputs ──────────────────────────────────────────────
        //
        // HEX for everything that is a NAME or a MESSAGE. `adb shell` re-joins
        // argv into ONE remote command line, so host-side quoting does not
        // survive it: an extra containing a space splits, and a non-ASCII one
        // is re-encoded by whatever the device shell believes its locale is.
        // Both surface as an unrelated `am` usage error or as a fragment landing
        // on the runner, never as anything about the value. The fixtures are NOT
        // stripped of their spaces or their non-ASCII characters, because that is
        // precisely what this round is here to move.
        val expectOrigin = requireArg("web.expectOrigin")
        val targetName = decodeHex(requireArg("web.targetNameHex"))
        val decoyNames = decodeHex(requireArg("web.decoyNamesHex")).split("\n").filter { it.isNotEmpty() }
        val message = decodeHex(requireArg("web.messageHex"))
        val peerMessage = decodeHex(requireArg("web.peerMessageHex"))
        val readyMessage = decodeHex(requireArg("web.readyMessageHex"))
        // What the BROWSER will send, as `relative/path<TAB>size<TAB>sha256`
        // lines. A plan file cannot cross to the device, and this stays far
        // below any argv limit because it names files rather than carrying them.
        val expectFiles = parseExpected(decodeHex(requireArg("web.expectFilesHex")))
        // What THIS side sends: two batches, one per real picker round trip. A
        // GENERATOR, never the bytes — a 300 KiB body as hex is 614 400
        // characters in a single argv entry, which is past the limit and fails
        // as an `am` usage error rather than as anything about size.
        val outgoing = listOf(
            Outgoing(requireArg("web.outLargeName"), requireArg("web.outLargeSeed").toInt(),
                     requireArg("web.outLargeBytes").toInt()),
            Outgoing(requireArg("web.outZeroName"), requireArg("web.outZeroSeed").toInt(),
                     requireArg("web.outZeroBytes").toInt()),
        )
        val realPicker = arg("web.realPicker") != "0"
        /** The NEGATIVE CONTROL. Taps the first listed row instead of the named
         *  target; every selection assertion in this round must then fail. */
        val wrongSelection = arg("web.wrongSelection") == "1"

        val observed = HashMap<String, Any?>()
        observed["realPicker"] = realPicker
        observed["wrongSelection"] = wrongSelection
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                val vm = viewModel()
                // A previous run's release would let this one skip its barrier.
                // `pm clear` removes it too; this is the fence that does not
                // depend on the launcher having done so.
                for (phase in Phase.entries) runCatching { File(filesDir(), phase.release).delete() }
                runCatching { File(filesDir(), IDENTITY).delete() }

                // BY EQUALITY. `Backend.readDebugOverride` fails closed to
                // PRODUCTION, so a run whose property never took would drive the
                // real service and still look green.
                assertEquals(
                    "the run must point this build at the origin it says it did",
                    expectOrigin, vm.backendOrigin,
                )
                observed["backendOrigin"] = vm.backendOrigin

                // The real shell, from the destination bar onwards. Starting the
                // room through the view model while the shell sat on another
                // destination would leave that surface showing the explicit-switch
                // card, and the pickers this round drives would never be found.
                tapDestination(string(R.string.tab_nearby))
                tapInApp(string(R.string.nearby_start_hub), "the code-less room start button")
                awaitTrue("the code-less room opened", 120_000) {
                    state(vm).nearby.room == TransferController.NearbyRoom.JOINED
                }

                // The name this device is ANNOUNCING, published as early as it
                // exists. The browser half is started from this file and matches
                // it with `===`: a defaulted or guessed name would let a browser
                // "see the phone" in a room the phone had never joined.
                val selfName = vm.signalingDeviceName
                assertTrue("this build announced no device name, so no browser can select it",
                           selfName.isNotEmpty())
                observed["selfName"] = selfName
                report(IDENTITY, mapOf("name" to selfName, "roomJoined" to true))

                // ── three candidates, and the target is not the first ────────
                val expectedNames = decoyNames + targetName
                awaitTrue("all three browser devices were listed by name", 240_000) {
                    val devices = state(vm).nearby.devices
                    expectedNames.all { name -> devices.count { it.name == name } == 1 }
                }
                val devices = state(vm).nearby.devices
                assertTrue(
                    "this round needs at least three candidates: one or two cannot show that " +
                        "the RIGHT device was chosen (listed ${devices.size})",
                    devices.size >= 3,
                )
                observed["candidates"] = devices.size
                // The order the MODEL offers, which is the order the list is
                // rendered in (`NearbyScreen` iterates `nearby.devices`).
                val modelOrder = devices.map { it.name }
                observed["candidateOrder"] = modelOrder
                // And the order the screen actually PUTS them in, read from the
                // semantics tree's own geometry. Recorded separately because
                // "the model is sorted" and "the user sees them in that order"
                // are different claims, and only the second one is what a person
                // choosing the first row would have chosen.
                val displayedOrder = displayedOrder(expectedNames)
                observed["displayedOrder"] = displayedOrder

                val target = devices.single { it.name == targetName }
                observed["targetId"] = target.id
                observed["targetName"] = targetName
                observed["decoyIds"] = decoyNames.map { name -> devices.single { it.name == name }.id }
                assertTrue(
                    "the target must announce link/1, or this round would be testing the legacy " +
                        "wire while claiming to test link/1",
                    target.supportsLink,
                )

                // ── the selection, through the row's OWN control ─────────────
                //
                // The Connect buttons all carry the same label, so the row is
                // identified by the one thing that differs: the device name
                // rendered beside it. `hasAnySibling` is what binds the tap to
                // THAT row, and a build whose rows were wired to the wrong peer
                // would fail here rather than pass a `connectToPeer` call that
                // never went through the binding at all.
                val chosenRow = if (wrongSelection) displayedOrder.first() else targetName
                observed["tappedRow"] = chosenRow
                tapConnectFor(chosenRow)

                awaitProgress(vm, "the link to the chosen browser device", 180_000) {
                    state(vm).phase == TransferController.Phase.CONNECTED
                }
                // The id the app SELECTED, read from its own state and compared
                // to the id of the row that was tapped. This is what a wrong
                // binding fails, and it is why the negative control exists.
                val selectedId = state(vm).nearby.selectedId
                observed["selectedId"] = selectedId
                observed["selectedName"] =
                    state(vm).nearby.devices.firstOrNull { it.id == selectedId }?.name
                        ?: devices.firstOrNull { it.id == selectedId }?.name
                assertEquals(
                    "the app connected to a device other than the row that was tapped",
                    devices.single { it.name == chosenRow }.id, selectedId,
                )
                assertEquals(
                    "the round must end up on the NAMED target, not on whatever was first",
                    target.id, selectedId,
                )

                val sas = state(vm).sas
                assertNotNull("a connected link has compared keys", sas)
                observed["sas"] = sas
                observed["wire"] = state(vm).wire?.name
                assertEquals(
                    "the browser must be reached on link/1",
                    TransferController.Wire.LINK.name, state(vm).wire?.name,
                )

                // ── text, both ways, through the real composer ───────────────
                //
                // NOT an unconditional `requestText()`. The shipped Web opens the
                // text lane BY ITSELF, once per authenticated mixed link
                // (`App.svelte`'s `textOpener` / `createUnifiedTextOpener`,
                // App.svelte:236-266) — so by the time this line runs the phone
                // is very often already holding an INCOMING_REQUEST. `requestText`
                // does not answer one, so the previous version asked for a lane
                // that was already being offered and then waited for an OPEN that
                // nothing was going to produce. The browser sat in
                // `waitingAccept` (its composer rendered, its Send disabled by
                // `canSend`) and the round died as `error_connection_lost`.
                //
                // That is the shipped design and it is not being changed here.
                // This half simply answers what it is actually offered.
                openConversation(vm, 180_000, observed)
                sendThroughComposer(vm, message, observed, "message")
                observed["messageSent"] = message
                // The PEER's message, compared by equality on the receiving
                // side. A body that arrived trimmed, normalised or re-encoded
                // shows up here and nowhere else.
                awaitProgress(vm, "the browser's message to arrive", 180_000) {
                    state(vm).messages.any { it.fromPeer && it.body == peerMessage }
                }
                observed["peerMessageReceived"] = true

                // ── the browser's batch, accepted through the real picker ────
                //
                // Sequenced with an in-band ready: an unsequenced pair samples
                // one arbitrary interleaving and reports it as though both
                // directions had been covered, and with a real DocumentsUI on
                // this end it is also the difference between a deterministic run
                // and one where a consent card repaints the screen while the
                // picker is being driven.
                sendThroughComposer(vm, readyMessage, observed, "ready")

                val roomBeforePicker = state(vm).nearby.roomId
                val linkBeforePicker = state(vm).linkId
                var survivedPicker = true

                awaitProgress(vm, "the browser to offer its batch", 300_000) {
                    state(vm).awaitingFolder
                }
                if (realPicker) {
                    tapInApp(string(R.string.files_choose_folder), "the choose-folder button")
                    DocumentsUiDriver.enterTestRootFromDrawer()
                    DocumentsUiDriver.tap(
                        "Use this folder", "the tree confirm button", requireEnabled = true,
                    )
                    DocumentsUiDriver.confirmTreeGrant { !state(vm).awaitingFolder }
                } else {
                    vm.acceptIncoming(
                        state(vm).promptId, com.relayium.android.InteropDriver.treeUri(),
                        state(vm).linkId,
                    )
                }
                survivedPicker = survivedPicker && state(vm).linkId == linkBeforePicker
                assertEquals(
                    "the session must survive this app's OWN folder picker; an ended-and-" +
                        "rejoined session is not continuity",
                    linkBeforePicker, state(vm).linkId,
                )
                awaitProgress(vm, "the incoming batch to complete", 300_000) {
                    state(vm).savedBatchCount >= 1
                }
                observed["savedBatchCount"] = state(vm).savedBatchCount

                // Per FILE, by its exact relative path, size and digest — never
                // a search for a digest somewhere in the tree. A path and a
                // digest that were satisfied by two DIFFERENT files would be no
                // evidence at all, and a nested path is the whole point of one
                // of these entries.
                val savedFiles = ArrayList<Map<String, Any?>>(expectFiles.size)
                for (want in expectFiles) {
                    val bytes = readSaved(want.path)
                    assertNotNull(
                        "the browser's file ${want.path} is not in this device's tree; the " +
                            "batch did not land where the sender described it " +
                            "(root holds ${listTree()})",
                        bytes,
                    )
                    savedFiles.add(
                        mapOf("path" to want.path, "size" to bytes!!.size, "sha256" to sha256(bytes)),
                    )
                }
                observed["savedFiles"] = savedFiles
                observed["treeRoot"] = listTree()
                for ((index, want) in expectFiles.withIndex()) {
                    val got = savedFiles[index]
                    assertEquals("wrong size for ${want.path}", want.size, got["size"])
                    assertEquals("wrong bytes for ${want.path}", want.sha256, got["sha256"])
                }

                // ── this side's batches, through the real picker ─────────────
                for ((index, out) in outgoing.withIndex()) {
                    val staged = stageOutgoing(out.name, generatePayload(out.seed, out.bytes))
                    // The selection BEFORE this pick, so the wait below is a
                    // CHANGE rather than "the list is non-empty". After the
                    // first batch it is not empty, so `isNotEmpty()` would be
                    // satisfied the instant it was asked and the SECOND pick
                    // would never actually be waited for — the round would go on
                    // to assert against a batch DocumentsUI had not returned yet.
                    val pickedBefore = state(vm).outgoing
                    if (realPicker) {
                        // The REAL system picker, which puts DocumentsUI in
                        // front and STOPS this Activity. That stop is under test
                        // as much as the transfer is: a session ended by its own
                        // picker can never complete a file flow.
                        tapInApp(string(R.string.files_pick), "the choose-files button")
                        DocumentsUiDriver.enterTestRootThenTap(out.name)
                        awaitProgress(vm, "the pick for ${out.name} to come back", 180_000) {
                            state(vm).outgoing.isNotEmpty() && state(vm).outgoing != pickedBefore
                        }
                    } else {
                        vm.sendPicked(listOf(staged), state(vm).linkId)
                    }
                    survivedPicker = survivedPicker &&
                        state(vm).nearby.roomId == roomBeforePicker &&
                        state(vm).linkId == linkBeforePicker
                    assertTrue(
                        "the session and its room must survive this app's OWN document picker",
                        survivedPicker,
                    )
                    // The PEER's verified COMPLETE, not "we finished sending":
                    // only the browser saying it has everything makes the
                    // receipt the oracle compares meaningful.
                    awaitProgress(vm, "the browser to confirm batch $index", 300_000) {
                        state(vm).sentBatchCount >= index + 1
                    }
                }
                observed["sentBatchCount"] = state(vm).sentBatchCount
                observed["survivedPicker"] = survivedPicker

                // ── barrier 1 ────────────────────────────────────────────────
                observed[Phase.TRANSFER.field] = "waiting"
                barrier(vm, Phase.TRANSFER)
                observed[Phase.TRANSFER.field] = "released"

                // ── finishing, and coming back to a LIVE list ────────────────
                vm.disconnect()
                awaitTrue("back to the device list", 120_000) {
                    state(vm).phase == TransferController.Phase.WAITING_PEER
                }
                val after = state(vm).nearby.devices
                assertTrue(
                    "the room did not survive the transfer: the target is no longer listed",
                    after.any { it.id == target.id },
                )
                observed["listedAfterDisconnect"] = after.size
                observed["namesAfterDisconnect"] = after.map { it.name }

                // ── barrier 2 ────────────────────────────────────────────────
                observed[Phase.ROOM.field] = "waiting"
                barrier(vm, Phase.ROOM)
                observed[Phase.ROOM.field] = "released"

                vm.stopNearby()
                awaitTrue("stopping ends the session and the room", 60_000) {
                    !state(vm).nearby.active && state(vm).phase == TransferController.Phase.ENDED
                }
                observed["pass"] = true
            }
        } finally {
            report(REPORT, observed)
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private class Outgoing(val name: String, val seed: Int, val bytes: Int)

    private class Expected(val path: String, val size: Int, val sha256: String)

    /** `relative/path<TAB>size<TAB>sha256` per line. Fails closed on a line it
     *  cannot read: a silently skipped expectation is an assertion that does not
     *  happen, which looks exactly like one that passed. */
    private fun parseExpected(spec: String): List<Expected> {
        val out = ArrayList<Expected>()
        for (line in spec.split("\n")) {
            if (line.isEmpty()) continue
            val parts = line.split("\t")
            check(parts.size == 3) { "unreadable expected-file line (${parts.size} fields)" }
            val size = parts[1].toIntOrNull() ?: error("unreadable expected-file size")
            check(parts[2].length == 64) { "an expected-file digest is not a SHA-256" }
            out.add(Expected(parts[0], size, parts[2]))
        }
        check(out.isNotEmpty()) { "the round declared no expected files" }
        return out
    }

    /**
     * The destination bar's own tab, which is `isSelectable()` rather than
     * merely clickable — a heading with the same word is neither.
     */
    private fun tapDestination(text: String, timeoutMs: Long = 30_000) {
        val matcher = hasText(text) and isSelectable()
        awaitNode(matcher, "the destination '$text'", timeoutMs)
        reachAndClick(compose.onNode(matcher), "the destination '$text'")
    }

    /**
     * Tap one of THIS app's own controls, waiting for it to exist.
     *
     * A one-shot `onNode(...).performClick()` resolves the node once. It waits
     * for the composition to go idle, but idleness is not the state having
     * arrived: everything this round waits on is a `StateFlow` read from the
     * test thread, and the recomposition it triggers happens on the main thread
     * afterwards. A one-shot lookup therefore fails as "no node matched" for a
     * control that appears microseconds later — a harness failure that reads
     * exactly like a product one.
     */
    private fun tapInApp(text: String, what: String, timeoutMs: Long = 60_000) {
        awaitNode(hasText(text) and hasClickAction(), "$what ('$text')", timeoutMs)
        reachAndClick(compose.onNode(hasText(text) and hasClickAction()), "$what ('$text')")
    }

    /** Wait for a node to EXIST. Separate from clicking it on purpose: the retry
     *  belongs to appearance, and the click must happen exactly once. */
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
     * A bare `performClick()` is what every tap in this file used to do, and it
     * is not what a person does. Compose will happily click a node that exists
     * in the semantics tree but is scrolled off screen, so a control below the
     * fold reports a successful click and nothing happens — which is
     * indistinguishable from the product ignoring the press. The Nearby session
     * screen is a scrolling column and the composer is tall (four rows, the
     * attachment row, a byte count and a hint), so Send sits below the fold
     * exactly when a draft has been typed.
     *
     * `performScrollTo` first, then `assertIsDisplayed` and `assertIsEnabled` —
     * so "the user could not reach this control" and "the control did nothing"
     * are different failures with different messages. Every other real UI
     * acceptance in this repository already does this
     * (`AccountAcceptanceTest.signInThroughTheForm`, `CloudAcceptanceTest`).
     *
     * ONE click. Never a blind retry: a second Send would be a second message,
     * and an assertion that passes only because it pressed twice is not evidence
     * about the press.
     */
    private fun reachAndClick(node: SemanticsNodeInteraction, what: String) {
        // A control with no scrollable ancestor cannot be scrolled to, and that
        // is not a failure — it is already wherever it is.
        runCatching { node.performScrollTo() }
        try {
            node.assertIsDisplayed()
        } catch (error: AssertionError) {
            throw AssertionError(
                "$what exists but is NOT DISPLAYED even after scrolling to it. If this is " +
                    "reproducible it is a product finding — a control the user cannot reach — " +
                    "not a harness detail. ${geometryOf(node)}",
                error,
            )
        }
        try {
            node.assertIsEnabled()
        } catch (error: AssertionError) {
            throw AssertionError("$what is displayed but DISABLED, so this round cannot press it", error)
        }
        node.performClick()
    }

    /** Where a control actually is, and how big its window is. Geometry only —
     *  no text, no draft, no message body. */
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

    /**
     * The Connect button belonging to ONE named row.
     *
     * Every row's button carries the same label, so the row is identified by the
     * device name rendered beside it — `DeviceRow` puts the label `Text` and the
     * `Button` in one `Column`, so they are siblings. This is the binding a
     * `viewModel.connectToPeer` call skips entirely.
     */
    private fun tapConnectFor(deviceName: String, timeoutMs: Long = 60_000) {
        val connect = string(R.string.nearby_connect)
        val matcher = hasText(connect) and hasClickAction() and hasAnySibling(hasText(deviceName))
        awaitNode(matcher, "a Connect button beside the row named '$deviceName'", timeoutMs)
        // Through the SAME scroll-prove-click path as everything else, and it
        // matters most here: the list is sorted by name and this round names the
        // target so that it sorts LAST, so the row this whole lane exists to
        // press is the one most likely to be below the fold.
        reachAndClick(compose.onNode(matcher), "the Connect button for '$deviceName'")
    }

    /**
     * The order the three candidates are actually ON SCREEN in, top to bottom.
     *
     * From the semantics tree's own geometry rather than from the model, because
     * "the model is sorted" and "the user sees them in that order" are different
     * claims — and it is the second one that says what a person tapping the first
     * row would have tapped. Exactly one node per name, or the round cannot say
     * which row it measured.
     */
    private fun displayedOrder(names: List<String>, timeoutMs: Long = 60_000): List<String> {
        // BOUNDED RETRY, not a single read. Everything this round waits on is a
        // `StateFlow` sampled from the test thread, and the recomposition it
        // triggers happens on the main thread afterwards — so a name that is
        // about to be on screen reads as "on screen 0 times" for a moment, which
        // is a harness failure that looks exactly like a product one.
        val deadline = System.currentTimeMillis() + timeoutMs
        var last = ""
        while (System.currentTimeMillis() < deadline) {
            val tops = ArrayList<Pair<String, Float>>(names.size)
            var ready = true
            for (name in names) {
                val nodes = compose.onAllNodes(hasText(name)).fetchSemanticsNodes()
                if (nodes.size != 1) {
                    // More than one is NOT a timing problem and never becomes
                    // one: the round could not say which row it measured, so it
                    // stops rather than picking one.
                    if (nodes.size > 1) {
                        error("the name '$name' is on screen ${nodes.size} times; the " +
                            "displayed order cannot be read unambiguously")
                    }
                    last = "the row named '$name' is not on screen"
                    ready = false
                    break
                }
                tops.add(name to nodes[0].boundsInRoot.top)
            }
            if (ready) return tops.sortedBy { it.second }.map { it.first }
            Thread.sleep(100)
        }
        error("the three candidate rows never all rendered together ($last)")
    }

    /**
     * Reach an OPEN conversation from whatever state this link is actually in.
     *
     * Three states have to be handled, and a round that assumes one of them
     * deadlocks on the others:
     *
     *  * `INCOMING_REQUEST` — the ordinary case here, because the shipped Web
     *    opens the lane once per authenticated link on its own. Answered through
     *    the REAL Accept button, which is the prompt a person answers;
     *  * `IDLE` — nothing has been offered, so this side asks, ONCE;
     *  * `REQUESTED` — this side already asked and is waiting; and a genuine
     *    collision (both sides requesting at once) resolves into one of the
     *    other states by the lane's own rules, so it is waited out rather than
     *    forced.
     *
     * Every iteration is a NON-BLOCKING tick, deliberately: a long inner wait
     * here is what turned v1 into a timeout that named nothing.
     */
    private fun openConversation(
        vm: TransferViewModel,
        timeoutMs: Long,
        observed: MutableMap<String, Any?>,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        var requestedLocally = false
        // PROMPTS are counted as EDGES into INCOMING_REQUEST; accepted prompts
        // are the distinct prompts on which a click actually landed. Raw clicks
        // are reported too but are never the measure: the lane can still be
        // showing the card on the tick after a successful press, so a second
        // click on the SAME prompt would otherwise read as a second person
        // answering a second question.
        var incomingPrompts = 0
        var acceptedPrompts = 0
        var acceptClicks = 0
        var insidePrompt = false
        var thisPromptAccepted = false
        var lastSeen = ""

        // Written on EVERY exit, including the failures. Which endpoint answers
        // a consent prompt is decided by the shipped design — the Web opens the
        // lane by itself — so the oracle cannot assume a party. It reads this.
        fun record(reachedOpen: Boolean) {
            observed["textNegotiation"] = mapOf(
                "requestedLocally" to requestedLocally,
                "sawIncomingRequest" to (incomingPrompts > 0),
                "incomingPrompts" to incomingPrompts,
                "acceptedPrompts" to acceptedPrompts,
                "acceptClicks" to acceptClicks,
                "openedAfterAccept" to (reachedOpen && acceptedPrompts > 0),
                "finalTextState" to lastSeen,
            )
        }

        while (System.currentTimeMillis() < deadline) {
            val current = state(vm)
            lastSeen = current.textState.name
            when (current.textState) {
                TextLaneSession.State.OPEN -> {
                    record(reachedOpen = true)
                    return
                }
                TextLaneSession.State.INCOMING_REQUEST -> {
                    if (!insidePrompt) {
                        insidePrompt = true
                        thisPromptAccepted = false
                        incomingPrompts++
                    }
                    if (tryTapInApp(string(R.string.text_accept))) {
                        acceptClicks++
                        if (!thisPromptAccepted) {
                            thisPromptAccepted = true
                            acceptedPrompts++
                        }
                    }
                }
                TextLaneSession.State.IDLE -> {
                    insidePrompt = false
                    if (!requestedLocally) {
                        vm.requestText()
                        requestedLocally = true
                    }
                }
                // REQUESTED: this side has asked and the answer is the peer's to
                // give. ENDED/FAILED are terminal and are caught below.
                else -> insidePrompt = false
            }
            val terminal = current.errorKey ?: when {
                current.textState == TextLaneSession.State.FAILED -> "text_lane_failed"
                current.phase == TransferController.Phase.ENDED -> "session_ended"
                !current.nearby.active -> "nearby_stopped"
                else -> null
            }
            if (terminal != null) {
                record(reachedOpen = false)
                error(
                    "the conversation will not open: the session reached a terminal state " +
                        "($terminal) with the text lane in $lastSeen after " +
                        "${if (requestedLocally) "one request" else "no request"}, " +
                        "$incomingPrompts prompt(s) and $acceptClicks accept click(s)",
                )
            }
            Thread.sleep(100)
        }
        record(reachedOpen = false)
        error(
            "timed out after ${timeoutMs}ms opening the conversation; the text lane was last " +
                "in $lastSeen after ${if (requestedLocally) "one request" else "no request"}, " +
                "$incomingPrompts prompt(s) and $acceptClicks accept click(s)",
        )
    }

    /**
     * One attempt to press a control, with NO waiting.
     *
     * Through the same scroll-prove-click path, so an off-screen control is a
     * "not yet" rather than a click that silently lands nowhere. The caller's
     * loop is what retries, and `reachAndClick` performs its click LAST — so a
     * throw from any step means no click happened and a retry cannot become a
     * second press.
     */
    private fun tryTapInApp(text: String): Boolean {
        val matcher = hasText(text) and hasClickAction()
        if (runCatching { compose.onNode(matcher).assertExists() }.isFailure) return false
        return runCatching { reachAndClick(compose.onNode(matcher), "'$text'") }.isSuccess
    }

    /**
     * Send one body through the REAL composer: type into the field the user
     * types into, then press the button the user presses.
     *
     * `performTextReplacement`, not `performTextInput`: input APPENDS at the
     * cursor, so a second message would be concatenated onto the first and the
     * body that went out would not be the body this round names. The draft is
     * read back before Send, because a field that silently kept its old value
     * would send the wrong text and the failure would surface at the far end as
     * "the message never arrived".
     */
    private fun sendThroughComposer(
        vm: TransferViewModel,
        body: String,
        observed: MutableMap<String, Any?>,
        label: String,
    ) {
        // The field: scrolled to like every other real UI acceptance in this
        // repository does, then REPLACED rather than appended — input appends at
        // the cursor, so a second message would be concatenated onto the first
        // and the body that went out would not be the body this round names.
        awaitNode(hasSetTextAction(), "the composer")
        val fields = compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes()
        check(fields.size == 1) {
            "the session screen offers ${fields.size} editable fields; this round cannot say " +
                "which one is the composer"
        }
        val field = compose.onNode(hasSetTextAction())
        runCatching { field.performScrollTo() }
        field.performTextReplacement(body)

        // The draft is read back before Send. A field that silently kept its old
        // value would send the wrong text, and the failure would surface at the
        // far end as "the message never arrived".
        awaitTrue("the composer to hold exactly the body this round sends", 30_000) {
            vm.draft.value.text == body
        }

        val send = string(R.string.text_send)
        awaitNode(hasText(send) and hasClickAction(), "the Send button")
        val sendNode = compose.onNode(hasText(send) and hasClickAction())
        // Captured BEFORE the click, so a failure can say whether Send was even
        // reachable at the moment it was pressed.
        val beforeClick = diagnose(vm, body, sendNode, "before-click")
        reachAndClick(sendNode, "the Send button")

        try {
            awaitProgress(vm, "the message to enter the channel", 60_000) {
                state(vm).messages.any { !it.fromPeer && it.body == body }
            }
        } catch (failure: Throwable) {
            // ONE click was performed, on a control proved displayed and
            // enabled. If the frame still never entered this side's own channel,
            // that is a candidate PRODUCT finding rather than a harness detail,
            // and this is the evidence for deciding which.
            val after = diagnose(vm, body, sendNode, "after-click")
            observed["sendDiagnostics.$label"] = listOf(beforeClick, after)
            throw AssertionError(
                "Send was displayed and enabled, exactly one click was performed, and the " +
                    "message never entered this side's own channel within 60s. " +
                    "before=[$beforeClick] after=[$after]",
                failure,
            )
        }
    }

    /**
     * Everything needed to tell a harness failure from a product one, and
     * NOTHING that is content.
     *
     * The draft and the message bodies are user text: their LENGTH and whether
     * they match the fixture are recorded, never a character of them. Same for
     * the link identity, which is carried as a short prefix.
     */
    private fun diagnose(
        vm: TransferViewModel,
        body: String,
        sendNode: SemanticsNodeInteraction,
        at: String,
    ): Map<String, Any?> {
        val current = state(vm)
        val draft = vm.draft.value
        val displayed = runCatching { sendNode.assertIsDisplayed(); true }.getOrDefault(false)
        val enabled = runCatching { sendNode.assertIsEnabled(); true }.getOrDefault(false)
        return mapOf(
            "at" to at,
            "phase" to current.phase.name,
            "textState" to current.textState.name,
            "wire" to (current.wire?.name ?: "-"),
            "errorKey" to (current.errorKey ?: "-"),
            "linkId" to current.linkId.toString().take(8),
            "draftLinkId" to draft.linkId.toString().take(8),
            "draftChars" to draft.text.length,
            "draftBytes" to draft.text.toByteArray(Charsets.UTF_8).size,
            "draftMatchesFixture" to (draft.text == body),
            "expectedChars" to body.length,
            "messages" to current.messages.size,
            "outbound" to current.messages.count { !it.fromPeer },
            "inbound" to current.messages.count { it.fromPeer },
            "sendDisplayed" to displayed,
            "sendEnabled" to enabled,
            "sendGeometry" to geometryOf(sendNode),
        )
    }

    /**
     * Wait for [done], and give up IMMEDIATELY on a terminal state.
     *
     * A plain wait costs a whole round: an establishment that failed at its own
     * no-progress deadline falls back to the device list carrying its reason,
     * and a test that keeps waiting for CONNECTED reports a timeout naming none
     * of it. A terminal is an answer, and it is reported as the answer.
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

    /**
     * Neither endpoint tears down until BOTH have finished asserting.
     *
     * Out of band on purpose. It is NOT the transfer's own wire, which is the
     * thing under test and cannot be its own completion oracle, and it is not a
     * fixed sleep, which proves nothing about what the other side did. This half
     * writes its marker into its own files directory only AFTER every assertion
     * it owns has passed; the launcher — the one process that can see both
     * halves — waits for both and writes the release back.
     */
    private fun barrier(vm: TransferViewModel, phase: Phase) {
        report(phase.ready, mapOf("phase" to phase.name, "ready" to true))
        val deadline = System.currentTimeMillis() + barrierMs
        while (System.currentTimeMillis() < deadline) {
            if (File(filesDir(), phase.release).exists()) return
            if (phase == Phase.TRANSFER) {
                // NOT for the ROOM phase: by then this side has already
                // disconnected on purpose, so "the session ended" is the
                // expected condition rather than a failure.
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

    /** Values that cannot survive `adb shell`'s re-joining of argv. */
    private fun decodeHex(hex: String): String {
        check(hex.length % 2 == 0) { "a hex-encoded argument has an odd length" }
        return String(
            ByteArray(hex.length / 2) { i ->
                val hi = Character.digit(hex[i * 2], 16)
                val lo = Character.digit(hex[i * 2 + 1], 16)
                check(hi >= 0 && lo >= 0) { "a hex-encoded argument is not hexadecimal" }
                ((hi shl 4) or lo).toByte()
            },
            Charsets.UTF_8,
        )
    }

    /** The same rule the launcher's digest and the browser's generator use, so
     *  the fixture is never asserted from one side only. */
    private fun generatePayload(seed: Int, count: Int): ByteArray =
        ByteArray(count) { i -> ((i * 31 + seed) % 251).toByte() }

    private fun string(id: Int) =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(id)

    private fun filesDir(): File =
        InstrumentationRegistry.getInstrumentation().targetContext.filesDir

    private companion object {
        /** Published as soon as the room is joined, because the browser half
         *  cannot be started until this device's announced name is known. */
        const val IDENTITY = "nearby-web-identity.json"
        const val REPORT = "nearby-web-report.json"
    }
}
