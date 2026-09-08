package com.relayium.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.relayium.android.InteropDriver.arg
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.sha256
import com.relayium.android.InteropDriver.state
import com.relayium.android.account.AccountState
import com.relayium.android.account.CreateLinkModel
import com.relayium.protocol.TextLaneSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The ANDROID half of the Android ↔ **Apple** legacy interoperability
 * acceptance.
 *
 * Driven by `scripts/android-apple-legacy-acceptance.sh`, which owns the
 * throwaway Go server, the Apple-side peer built from UNCHANGED shipped
 * `RelayiumKit`/`RelayiumPeerKit`, and every comparison. This half drives the
 * REAL app: `MainActivity`, the `TransferViewModel` it created, its
 * `TransferController`, real OkHttp signalling, real native WebRTC and the
 * real SAF stack.
 *
 * ## What this covers that the Web lane cannot
 *
 * `InteropAcceptanceTest` pairs with a browser, and the browser speaks
 * `link/1`. The Apple clients do NOT in a pairing-code room —
 * `LINK_PAIRING_ROOM_SUPPORT` is false on iOS — so every cross-network session
 * between this app and an iPhone runs on the SHIPPED older wire instead: one
 * `data` channel, one generation per connection, a three-byte control set and
 * no abort barrier. None of that is exercised anywhere else.
 *
 * ## Both roles, because the role is the user's intent
 *
 * On this wire the offerer is whoever CREATED the code, not whoever has the
 * smaller hub id. A run that only ever joined would leave half the product —
 * every session an Android user starts — completely untested, so the minter
 * rounds sign in through the product's own API and mint through
 * `TransferViewModel.createCrossNetworkLink`, exactly as the button does.
 *
 * ## One direction per file connection, deliberately
 *
 * `RealtimeConnection.send` is one-shot per connection (`alreadySending`
 * exists because a second `RealtimeSender` would restart the nonce counter
 * under the same key), so a file round carries ONE direction and the shell
 * runs the other on a fresh connection. Nothing here may be read as a claim
 * that a legacy connection is reusable the way a link is.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class LegacyInteropAcceptanceTest {

    private enum class Mode { FILE, TEXT }
    private enum class Intent { MINTER, JOINER }

    /** What the shell compares. Written from a `finally`, so a FAILED round
     *  still reports what it got — and the shell judges the instrumentation's
     *  own exit separately, never this file's existence. */
    private val report = LinkedHashMap<String, Any?>()

    @Test
    fun legacyRound() {
        val mode = when (requireArg("mode")) {
            "file" -> Mode.FILE
            "text" -> Mode.TEXT
            else -> error("mode must be file or text")
        }
        val intent = when (requireArg("intent")) {
            "minter" -> Intent.MINTER
            "joiner" -> Intent.JOINER
            else -> error("intent must be minter or joiner")
        }
        val direction = arg("direction") ?: "receive"
        val adversarial = arg("adversarial")

        ActivityScenario.launch(MainActivity::class.java).use {
            val vm = InteropDriver.viewModel()
            try {
                // BEFORE anything joins. `Backend.readDebugOverride` reads a
                // non-public class reflectively and fails CLOSED to production;
                // a round that joined first could drive a disposable code
                // against the real service.
                val origin = requireArg("origin")
                report["backendOrigin"] = vm.backendOrigin
                assertEquals("the app under test must be on the throwaway server", origin, vm.backendOrigin)

                // Published BEFORE anything joins, because the Apple half finds
                // this app on the roster by exact name and cannot start
                // looking until it knows one. Read off the live instance
                // rather than re-derived: the first run of this lane matched on
                // an invented constant, never found a peer, and reported it as
                // the app never being offered a connection.
                report["deviceName"] = vm.signalingDeviceName
                InteropDriver.report(requireArg("report"), report)

                when (intent) {
                    Intent.MINTER -> mintAndOffer(vm)
                    Intent.JOINER -> vm.join(requireArg("code"))
                }

                awaitTrue("connected", 180_000) {
                    state(vm).phase == TransferController.Phase.CONNECTED ||
                        state(vm).phase == TransferController.Phase.ENDED
                }
                val connected = state(vm)
                report["phase"] = connected.phase.name
                report["errorKey"] = connected.errorKey
                assertEquals(
                    "the round must reach a connection, not a truthful failure",
                    TransferController.Phase.CONNECTED, connected.phase,
                )
                report["sas"] = connected.sas
                report["wire"] = connected.wire?.name
                report["canSendFiles"] = connected.canSendFiles
                report["canSendMessages"] = connected.canSendMessages
                assertEquals(
                    "the negotiated wire must be the one the shell set up",
                    if (mode == Mode.FILE) "LEGACY_FILES" else "LEGACY_TEXT",
                    connected.wire?.name,
                )

                when {
                    adversarial != null -> runAdversarial(vm, adversarial)
                    mode == Mode.TEXT -> runText(vm, intent)
                    direction == "send" -> runSend(vm)
                    else -> runReceive(vm)
                }
                // Written LAST and only on the success path: the shell treats
                // the report's existence as nothing at all, and this flag as
                // the round's own claim to have finished.
                report["complete"] = true
            } finally {
                report["finalPhase"] = state(vm).phase.name
                report["finalError"] = state(vm).errorKey
                InteropDriver.report(requireArg("report"), report)
            }
        }
    }

    // ── minting, through the product's own path ─────────────────────────────

    /**
     * Sign in and mint, then publish the code EARLY.
     *
     * The shell cannot start the Apple peer until it knows the code, and the
     * code does not exist until the app has minted one — so the report is
     * written once here and again at the end. A round that died between the
     * two still leaves the shell a code it can clean up behind.
     */
    private fun mintAndOffer(vm: TransferViewModel) {
        vm.account.signIn(requireArg("account_email"), requireArg("account_password"))
        awaitTrue("signed in", 120_000) { vm.account.state.value is AccountState.Ready }
        vm.createCrossNetworkLink()
        awaitTrue("a code was minted", 120_000) {
            vm.createLink.state.value is CreateLinkModel.State.Showing
        }
        val showing = vm.createLink.state.value as CreateLinkModel.State.Showing
        report["mintedCode"] = showing.code
        InteropDriver.report(requireArg("report"), report)
    }

    // ── files ───────────────────────────────────────────────────────────────

    /** Receive the Apple peer's batch and report a digest per file. */
    private fun runReceive(vm: TransferViewModel) {
        awaitTrue("an offer arrived", 180_000) { state(vm).awaitingFolder }
        // The whole META, not just the name. A batch that carries a folder
        // declares a PATH, the receiver rebuilds the tree under it, and a
        // readback keyed on the name alone looks for `a.bin` at the top level
        // of a destination that correctly wrote `tree-…/day1/a.bin`. That is
        // not a save failure; it is asking the wrong question.
        val offered = state(vm).incoming
        report["offered"] = offered.map {
            mapOf("name" to it.name, "path" to it.path, "size" to it.size)
        }
        vm.acceptIncoming(state(vm).promptId, InteropDriver.treeUri(), state(vm).linkId)
        awaitTrue("the batch saved and verified", 300_000) { state(vm).savedBatchCount == 1 }
        // Read back through the PROVIDER, not out of the lane's own accounting:
        // a receiver that reported the right sizes and wrote the wrong bytes
        // passes every check that does not hash what actually landed. The
        // document id IS the path relative to the granted tree, which is what
        // makes a nested entry addressable at all.
        report["tree"] = InteropDriver.listTree()
        report["received"] = offered.map { meta ->
            val docId = meta.path ?: meta.name
            val bytes = InteropDriver.readSaved(docId)
                ?: error("nothing was saved at $docId; the destination holds ${InteropDriver.listTree()}")
            mapOf(
                "name" to meta.name, "path" to meta.path,
                "size" to bytes.size, "sha256" to sha256(bytes),
            )
        }
    }

    /**
     * Send a batch to the Apple peer.
     *
     * The payload sizes are the boundaries only two implementations can
     * disagree about: one body larger than the 192 KiB logical chunk, one file
     * of ZERO bytes (no CHUNK at all — it completes on its DONE), and a third
     * so the global file sequence advances across entries in one batch.
     */
    private fun runSend(vm: TransferViewModel) {
        val specs = listOf(
            "bulk.bin" to 199_000,
            "empty.bin" to 0,
            "small.bin" to 1_024,
        )
        val staged = specs.map { (name, size) ->
            val bytes = deterministic(name, size)
            val uri = InteropDriver.stageOutgoing(name, bytes)
            Triple(name, bytes, uri)
        }
        report["sent"] = staged.map { (name, bytes, _) ->
            mapOf("name" to name, "size" to bytes.size, "sha256" to sha256(bytes))
        }
        vm.sendPicked(staged.map { it.third }, state(vm).linkId)
        // The peer's verified COMPLETE, which is the ONLY thing "sent" may
        // mean: a cancel and a failure also empty the outgoing list.
        awaitTrue("the peer completed the batch", 300_000) { state(vm).sentBatchCount == 1 }
    }

    /**
     * Bytes derived from the name, so a receiver that split the stream one byte
     * off produces the right names and sizes with different digests — which is
     * exactly what a names-and-sizes check cannot see.
     */
    private fun deterministic(name: String, size: Int): ByteArray {
        var state = name.hashCode().toLong() * 0x9E3779B97F4A7C15uL.toLong() + 0x1234
        return ByteArray(size) {
            state = state * 6364136223846793005L + 1442695040888963407L
            ((state ushr 33) and 0xff).toByte()
        }
    }

    // ── messages ────────────────────────────────────────────────────────────

    /**
     * One conversation, both directions.
     *
     * The two roles reach it differently and both are driven here: a JOINER is
     * the responder, so the conversation arrives already asked and this side
     * answers; a MINTER is the initiator, so it waits for the peer's `0xfe`.
     * There is no `0xfa` on this wire — the offer was the request — so a
     * responder must never be shown a "start a conversation" control.
     */
    private fun runText(vm: TransferViewModel, intent: Intent) {
        when (intent) {
            Intent.JOINER -> {
                awaitTrue("the conversation arrived with the connection", 120_000) {
                    state(vm).textState == TextLaneSession.State.INCOMING_REQUEST
                }
                assertFalse("there is nothing to reopen on this wire", state(vm).textCanRequest)
                vm.acceptText()
            }
            Intent.MINTER -> {
                // REQUESTED **or** already OPEN. The peer's `0xfe` can land
                // between the connection becoming CONNECTED and this poll
                // reading the state, and a fast, entirely valid peer must not
                // be turned into a flaky failure. What is asserted is that the
                // conversation exists without this side asking for one — there
                // is no `0xfa` on this wire, and the offer was the request.
                val initial = state(vm).textState
                assertTrue(
                    "an initiator's conversation is already asked for, not idle: $initial",
                    initial == TextLaneSession.State.REQUESTED ||
                        initial == TextLaneSession.State.OPEN,
                )
                assertFalse("and there is nothing to reopen", state(vm).textCanRequest)
            }
        }
        awaitTrue("the conversation opened", 120_000) { InteropDriver.textOpen(vm) }

        // Deliberately not ASCII-only and deliberately whitespace-significant:
        // the body rides an AEAD-sealed frame, so anything that trims,
        // normalises or re-encodes surfaces here rather than as a size
        // difference.
        val outgoing = requireArg("message_out_hex").decodeHex()
        vm.updateDraft(outgoing, state(vm).linkId)
        vm.sendDraft(state(vm).linkId)
        awaitTrue("this side's message entered the channel", 60_000) {
            state(vm).messages.any { !it.fromPeer && it.body == outgoing }
        }
        val expected = requireArg("message_in_hex").decodeHex()
        awaitTrue("the peer's message arrived", 180_000) {
            state(vm).messages.any { it.fromPeer }
        }
        val fromPeer = state(vm).messages.first { it.fromPeer }.body
        report["messageIn"] = sha256(fromPeer.toByteArray(Charsets.UTF_8))
        report["messageOut"] = sha256(outgoing.toByteArray(Charsets.UTF_8))
        assertEquals("the peer's message must arrive byte for byte", expected, fromPeer)
    }

    private fun String.decodeHex(): String =
        String(chunked(2).map { it.toInt(16).toByte() }.toByteArray(), Charsets.UTF_8)

    // ── the adversarial paths ───────────────────────────────────────────────

    /**
     * The three behaviours that differ from `link/1` and that a user can reach.
     *
     * `decline` is the CONFORMING in-band exchange: the peer is told at the
     * prompt, nothing is in flight, and the connection must stay usable.
     * `cancel` is not — the shipped sender re-reads `rejected` only before it
     * streams, so a mid-transfer cancel that left the socket open would leave
     * the user watching a cancelled transfer keep arriving. `refuse-text` is
     * the message wire's equivalent.
     */
    private fun runAdversarial(vm: TransferViewModel, kind: String) {
        when (kind) {
            "decline" -> {
                awaitTrue("an offer arrived", 180_000) { state(vm).awaitingFolder }
                vm.rejectIncoming()
                // The connection SURVIVES a decline. Held open long enough for
                // the peer to observe its own rejection and report it.
                Thread.sleep(3_000)
                report["phaseAfterDecline"] = state(vm).phase.name
                assertEquals(
                    "a decline is a complete in-band exchange, not a fault",
                    TransferController.Phase.CONNECTED, state(vm).phase,
                )
            }
            "cancel" -> {
                awaitTrue("an offer arrived", 180_000) { state(vm).awaitingFolder }
                vm.acceptIncoming(state(vm).promptId, InteropDriver.treeUri(), state(vm).linkId)
                awaitTrue("bytes are actually moving", 180_000) {
                    (state(vm).receiveProgress?.done ?: 0) > 0
                }
                // The three facts that distinguish a USER'S cancel from a peer
                // that failed underneath one. The far side sees a teardown
                // either way and cannot tell them apart; only this record can,
                // and the comparison reads all of it: bytes really were moving,
                // this side really issued the cancel, and the session ended
                // with NO error — a premature remote failure would have set
                // `error_connection_lost` here and could not pass as a cancel.
                report["progressBeforeCancel"] = state(vm).receiveProgress?.done ?: 0
                vm.cancelReceive()
                report["cancelIssued"] = true
                awaitTrue("the connection ended with the cancel", 60_000) {
                    state(vm).phase == TransferController.Phase.ENDED
                }
                report["savedAfterCancel"] = state(vm).savedBatchCount
                assertEquals("nothing may be reported saved", 0, state(vm).savedBatchCount)
                report["treeAfterCancel"] = InteropDriver.listTree()
            }
            "refuse-text" -> {
                awaitTrue("the conversation arrived", 120_000) {
                    state(vm).textState == TextLaneSession.State.INCOMING_REQUEST
                }
                vm.rejectText()
                // The refusal ANCHORED on this side. The far peer may or may
                // not receive the `0xff` — the lane queues it and then closes
                // and disposes the connection in the same turn — so its record
                // cannot be the proof that a refusal happened. This can be.
                report["textRejected"] = true
                awaitTrue("declining ends a connection that carried only this", 60_000) {
                    state(vm).phase == TransferController.Phase.ENDED
                }
                assertTrue(state(vm).messages.isEmpty())
            }
            else -> error("unknown adversarial path: $kind")
        }
    }
}
