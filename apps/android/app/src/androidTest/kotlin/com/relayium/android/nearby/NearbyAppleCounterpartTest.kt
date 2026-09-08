package com.relayium.android.nearby

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.android.DocumentsUiDriver
import com.relayium.android.InteropDriver.arg
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.report
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.stageOutgoing
import com.relayium.android.InteropDriver.state
import com.relayium.android.InteropDriver.viewModel
import com.relayium.android.MainActivity
import com.relayium.android.R
import com.relayium.android.TransferController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Android half of **Android → Apple over real Bonjour**.
 *
 * `scripts/android-nearby-apple-acceptance.sh` owns the Mac side: it starts the
 * UNCHANGED shipped `LocalTransferPeer` in its `local-link-peer` role, waits for
 * that peer to report `resident` — which its own lifecycle sets only once the
 * Bonjour listener AND the browser are both ready — reads the name it is
 * advertising under, and compares the receipts it produces.
 *
 * ## What only this can show
 *
 * `NearbyLanAcceptanceTest` puts two copies of THIS implementation on one link.
 * Two copies of one bug agree perfectly. This round is the first time the
 * discovery record this build writes is parsed by the shipped Apple parser, the
 * first time its framing is read by the Apple reader, and the first time its
 * `link/1` handshake is answered by the Apple link surface. A disagreement
 * between two independently written clients is the class of defect nothing else
 * in this repository can see.
 *
 * ## What it deliberately does NOT claim
 *
 * One direction. `local-link-peer` finishes on an INBOUND batch and its `/drive`
 * endpoint refuses that role, so the Apple half receives and does not send;
 * Apple → Android is a separate round with its own harness. And a Mac running
 * shipped modules is NOT a physical iPhone: this proves the protocol against the
 * Apple implementation, not against Apple hardware.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class NearbyAppleCounterpartTest {

    @get:Rule
    val compose = createEmptyComposeRule()

    @Test
    fun sendsToTheAppleLocalLinkPeerOverBonjour() {
        // The name the Mac peer is ACTUALLY advertising under, read from its own
        // control API by the launcher. Passed rather than assumed, so a round
        // that matched some other device on the link fails instead of passing.
        //
        // HEX, because a real advertised name contains spaces — this one is
        // "Relayium Apple Counterpart" — and `adb shell` re-joins argv into ONE
        // remote command line, where host-side quoting does not survive. An
        // extra with a space splits, and `am` then reports an unrelated usage
        // error or lands a fragment on the runner. Same convention as
        // `android-interop-acceptance.sh`; the fixture is NOT stripped of its
        // spaces, because real names have them.
        val peerName = decodeHex(requireArg("apple.peerNameHex"))
        val payloadName = requireArg("apple.name")
        val payloadSeed = requireArg("apple.payloadSeed").toInt()
        val payloadBytes = requireArg("apple.payloadBytes").toInt()
        val expectOrigin = requireArg("apple.expectOrigin")
        val message = arg("apple.messageHex")?.let(::decodeHex)

        val observed = HashMap<String, Any?>()
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                val vm = viewModel()
                assertEquals(
                    "the run must point this build at its own throwaway origin",
                    expectOrigin, vm.backendOrigin,
                )

                tapInApp(string(R.string.tab_nearby), "the Nearby destination", selectable = true)
                tapInApp(string(R.string.nearby_start_direct), "the local-link start button")
                awaitTrue("the local link came up") {
                    state(vm).nearby.room == TransferController.NearbyRoom.JOINED
                }

                // DISCOVERY. No address is passed to this half at any point: the
                // Mac must be found through Bonjour, by the name it advertises,
                // and it must be the only device answering to that name or the
                // round cannot say which one it chose.
                awaitTrue("the Apple peer was DISCOVERED by name", 120_000) {
                    state(vm).nearby.devices.count { it.name == peerName } == 1
                }
                val peer = state(vm).nearby.devices.first { it.name == peerName }
                observed["peerId"] = peer.id
                observed["candidates"] = state(vm).nearby.devices.size
                assertTrue(
                    "the Apple peer must announce link/1, or this round would be " +
                        "testing the legacy wire while claiming to test link/1",
                    peer.supportsLink,
                )

                vm.connectToPeer(peer.id, state(vm).nearby.roomId)
                awaitTrue("the link to the Apple peer came up", 120_000) {
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

                // A message first, where the peer accepts one: it is the cheapest
                // proof the lanes are both live before a batch is committed to.
                message?.let { body ->
                    vm.requestText()
                    awaitTrue("the conversation opened", 60_000) {
                        state(vm).textState == com.relayium.protocol.TextLaneSession.State.OPEN
                    }
                    val link = state(vm).linkId
                    vm.updateDraft(body, link)
                    vm.sendDraft(link)
                    awaitTrue("the message entered the channel", 60_000) {
                        state(vm).messages.any { !it.fromPeer && it.body == body }
                    }
                    // Recorded, but NOT the acceptance: this is only that the
                    // frame entered our own channel. The launcher compares it
                    // against the Apple peer's OWN received messages, which is
                    // the half that shows it arrived and decoded.
                    observed["messageSent"] = true
                }

                // The REAL picker, so the send path is the product's own.
                stageOutgoing(payloadName, generatePayload(payloadSeed, payloadBytes))
                tapInApp(string(R.string.files_pick), "the choose-files button")
                DocumentsUiDriver.enterTestRootThenTap(payloadName)
                awaitTrue("the pick came back", 120_000) { state(vm).outgoing.isNotEmpty() }

                // The peer's own verified COMPLETE. Not "we finished sending":
                // the Apple side saying it has everything is the only thing that
                // makes the receipt the launcher compares meaningful.
                awaitTrue("the Apple peer confirmed the batch", 240_000) {
                    state(vm).sentBatchCount >= 1
                }
                observed["sentBatchCount"] = state(vm).sentBatchCount

                // The launcher reads the Apple receipts AFTER this marker and
                // before releasing us, so neither side tears down while the
                // other is still reading. Same contract as the two-Android round.
                report("apple-ready.json", mapOf("ready" to true))
                awaitTrue("the launcher compared the Apple receipts", 180_000) {
                    java.io.File(filesDir(), "apple-release").exists()
                }

                vm.disconnect()
                awaitTrue("back to the device list", 60_000) {
                    state(vm).phase == TransferController.Phase.WAITING_PEER
                }
                vm.stopNearby()
                awaitTrue("stopped") { !state(vm).nearby.active }
                observed["pass"] = true
            }
        } finally {
            report("apple-report.json", observed)
        }
    }

    private fun tapInApp(text: String, what: String, selectable: Boolean = false) {
        val deadline = System.currentTimeMillis() + 30_000
        var last: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                val matcher = if (selectable) hasText(text) and isSelectable() else hasText(text) and hasClickAction()
                compose.onNode(matcher).performClick()
                return
            } catch (error: AssertionError) {
                last = error
                Thread.sleep(100)
            }
        }
        throw AssertionError("$what ('$text') never became tappable", last)
    }

    /** Values that cannot survive `adb shell`'s re-joining of argv. See
     *  [peerName]. */
    private fun decodeHex(hex: String): String =
        String(
            ByteArray(hex.length / 2) { i ->
                ((Character.digit(hex[i * 2], 16) shl 4) or Character.digit(hex[i * 2 + 1], 16))
                    .toByte()
            },
            Charsets.UTF_8,
        )

    /** The same rule the launcher's digest uses, so the fixture is never
     *  asserted from one side only. */
    private fun generatePayload(seed: Int, count: Int): ByteArray =
        ByteArray(count) { i -> ((i * 31 + seed) % 251).toByte() }

    private fun string(id: Int) =
        InstrumentationRegistry.getInstrumentation().targetContext.getString(id)

    private fun filesDir() =
        InstrumentationRegistry.getInstrumentation().targetContext.filesDir
}
