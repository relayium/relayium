package com.relayium.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.relayium.android.InteropDriver.arg
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.sha256
import com.relayium.android.InteropDriver.state
import com.relayium.protocol.TextLaneSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The ANDROID half of the Android ↔ Web interoperability acceptance.
 *
 * Driven by `scripts/android-interop-acceptance.sh`, which owns the throwaway
 * Go server, the built Web bundle, the browser peer and every comparison. This
 * half drives the REAL app: `MainActivity`, the `TransferViewModel` it
 * created, its `TransferController`, real OkHttp signalling, real native
 * WebRTC and the real SAF stack through a disposable documents provider.
 *
 * ## Why this is evidence and not another fixture
 *
 * The JVM suites in `app/src/test` drive the controller against a fake
 * transport. They are precise about state machines and they cannot see a
 * DISAGREEMENT between two implementations — a frame this app encodes one way
 * and the shipped Web bundle decodes another. Nothing here is stubbed except
 * the folder PICKER's UI: the grant it would hand back is the tree URI a
 * same-uid provider already serves, and the bytes still cross a real
 * `ContentResolver`/`DocumentsContract` IPC boundary.
 *
 * ## The preflight that must come before any join
 *
 * `Backend.readDebugOverride` reads a non-public class reflectively and FAILS
 * CLOSED to production. If that read ever stops working, an acceptance that
 * joined first would drive a disposable code against the REAL service. So the
 * first assertion in every round is that the live ViewModel resolved the
 * throwaway origin this run started — read off the instance, not re-derived.
 *
 * ## What a cancel round has to show
 *
 * Not "a flag went false". A cancelled RECEIVE must leave nothing of its own
 * in the destination — checked against the provider's real contents before and
 * after, with an unrelated SENTINEL file that must survive, because a rollback
 * that deleted the folder's other contents would otherwise look identical to a
 * clean one. A cancelled SEND must be observed as retired by the controller
 * AND as never completed by the peer. In both cases a FRESH transfer in the
 * same direction, on the same link, must then succeed — that is the retry the
 * product promises, and it is what proves the lane is usable rather than
 * merely quiet.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class InteropAcceptanceTest {

    /** The in-band request for the peer's next batch. Sent as an ordinary text
     *  message once this side is ready for one, so a second inbound batch is
     *  ordered AFTER a state this endpoint really reached. */
    private val sendAgain = "relayium-e2e:send-again"

    /** The browser's TERMINAL handshake: it sends this ordinary text message
     *  only after it has observed every byte and every message this round
     *  expects of Android, and this side keeps the real Activity/ViewModel —
     *  and therefore the live WebRTC session — alive until it arrives. Without
     *  it, "everything I meant to send entered the channel" is the strongest
     *  local claim available, and acting on it once closed this Activity while
     *  the peer was still receiving the second batch: the native report said
     *  complete and the browser's ledger was missing a file. Only the peer
     *  knows when the peer has everything; this message is the peer saying so. */
    private val doneMessage = "relayium-e2e:done"

    /** The send-cancel gate's two signals (see the browser half). The browser
     *  announces it is HOLDING the cancelled file's first write; this side waits
     *  for that, cancels, then asks the browser to release. */
    private val gateObserved = "relayium-e2e:gate-held"
    private val cancelRequested = "relayium-e2e:cancel-now"

    /** An unrelated file already in the destination when a receive is
     *  cancelled. A rollback that deleted the tree would pass a
     *  "nothing of mine is left" check; it cannot pass this one. */
    private val sentinelName = "sentinel-do-not-touch.txt"
    private val sentinelBytes = "unrelated content the app never owned".toByteArray()

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { i ->
            ((Character.digit(hex[i * 2], 16) shl 4) or Character.digit(hex[i * 2 + 1], 16)).toByte()
        }

    /** The same deterministic rule the shell and the browser half use. */
    private fun payload(size: Int, seed: Int) =
        ByteArray(size) { i -> ((i * 31 + seed) and 0xff).toByte() }

    @Test
    fun round() {
        val expectedOrigin = requireArg("relayium.origin")
        val code = requireArg("relayium.code")
        val out = requireArg("relayium.out")
        // HEX, not text: `adb shell am instrument` concatenates its arguments
        // into one device-shell command line, so a value containing a tab, a
        // newline or a non-ASCII character is re-split before `am` ever sees
        // it — and fails as an unrelated `am` usage error. The payload is
        // deliberately whitespace-significant and non-ASCII, so it has to
        // survive the channel that carries it.
        val message = String(hexToBytes(requireArg("relayium.messageHex")), Charsets.UTF_8)
        val postCancelMessage =
            String(hexToBytes(requireArg("relayium.postCancelHex")), Charsets.UTF_8)
        val sendName = requireArg("relayium.sendName")
        val sendSize = requireArg("relayium.sendSize").toInt()
        val sendSeed = requireArg("relayium.sendSeed").toInt()
        val textRole = arg("relayium.textRole") ?: "accept"
        val cancelMode = arg("relayium.cancel") ?: "none"

        val observations = LinkedHashMap<String, Any?>()
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            val vm = InteropDriver.viewModel()

            // ── preflight, BEFORE anything is joined ────────────────────────
            assertEquals(
                "the app under test must be pointed at this run's throwaway server; " +
                    "a reflective override that failed closed would otherwise send a " +
                    "disposable acceptance code to production",
                expectedOrigin,
                vm.backendOrigin,
            )
            observations["origin"] = vm.backendOrigin

            // The sentinel exists before the destination is ever handed over.
            InteropDriver.stageOutgoing(sentinelName, sentinelBytes)
            observations["treeBefore"] = InteropDriver.listTree()

            // ── join ────────────────────────────────────────────────────────
            vm.join(code)
            awaitTrue("the link reached CONNECTED") {
                state(vm).phase == TransferController.Phase.CONNECTED
            }
            val link = state(vm).linkId
            val sas = state(vm).sas
            assertTrue("a connected link must have a verification code", !sas.isNullOrEmpty())
            observations["sas"] = sas
            observations["linkId"] = link

            // ── text, both directions ───────────────────────────────────────
            if (textRole == "request") {
                awaitTrue("the text lane can be requested") { state(vm).textCanRequest }
                vm.requestText()
            } else {
                awaitTrue("the peer asked for the text lane") {
                    state(vm).textState == TextLaneSession.State.INCOMING_REQUEST
                }
                vm.acceptText()
            }
            awaitTrue("the text lane opened") { InteropDriver.textOpen(vm) }

            // The peer's message must arrive before this side answers, so a
            // green round is a real round trip rather than one side's echo.
            awaitTrue("the peer's message arrived") { state(vm).messages.any { it.fromPeer } }
            observations["receivedMessage"] = state(vm).messages.first { it.fromPeer }.body

            send(vm, link, message)
            observations["sentMessage"] = message

            // ── inbound batch 1 ─────────────────────────────────────────────
            val firstOffer = acceptOffer(vm, link, afterPrompt = 0)
            observations["offered"] = firstOffer

            val cancelledReceive = cancelMode == "receive"
            if (cancelledReceive) {
                // Cancel is available from ACCEPTANCE onward, not only once
                // bytes have arrived — the R15a rule, exercised for real.
                vm.cancelReceive()
                awaitTrue("the cancelled receive left no batch in flight") {
                    state(vm).incoming.isEmpty()
                }
                // Settle: the rollback runs on the storage executor, so an
                // immediate read could observe a directory mid-cleanup and
                // call a race a pass.
                awaitTrue("no receive is in progress") { state(vm).receiveProgress == null }
                Thread.sleep(1_500)

                val after = InteropDriver.listTree()
                observations["treeAfterCancel"] = after
                val leaked = firstOffer.filter { it in after }
                assertTrue(
                    "a cancelled receive must leave none of its own files behind; found $leaked",
                    leaked.isEmpty(),
                )
                assertTrue(
                    "the rollback must not touch content it does not own: $sentinelName is gone",
                    sentinelName in after,
                )
                assertEquals(
                    "the unrelated file's bytes were modified by the rollback",
                    sha256(sentinelBytes),
                    sha256(InteropDriver.readSaved(sentinelName) ?: ByteArray(0)),
                )
                observations["cleanupIncompleteAfterCancel"] = state(vm).cleanupIncomplete
            } else {
                awaitSaved(vm, savedBefore = 0, what = "the first inbound batch")
            }

            // ── a FRESH inbound batch on the SAME link ──────────────────────
            //
            // After a cancel this is the receive RETRY the product promises;
            // in an ordinary round it is a second batch under a later global
            // file sequence. Both are things one batch alone cannot show.
            val savedBeforeSecond = state(vm).savedBatchCount
            val promptBeforeSecond = state(vm).promptId
            send(vm, link, sendAgain)
            val secondOffer = acceptOffer(vm, link, afterPrompt = promptBeforeSecond)
            awaitSaved(vm, savedBefore = savedBeforeSecond, what = "the second inbound batch")
            observations["offeredSecond"] = secondOffer

            val savedNames = (if (cancelledReceive) emptyList() else firstOffer) + secondOffer
            observations["saved"] = savedNames.map { name ->
                val bytes = InteropDriver.readSaved(name)
                    ?: error("the app reported a saved batch but $name is not in the tree")
                mapOf("name" to name, "size" to bytes.size, "sha256" to sha256(bytes))
            }

            // ── outbound ────────────────────────────────────────────────────
            val body = payload(sendSize, sendSeed)
            val sentRecords = ArrayList<Map<String, Any?>>()

            if (cancelMode == "send") {
                // A DETERMINISTICALLY ACTIVE cancel, not a timed one. The
                // payload is larger than one FLOW_WINDOW (see the shell), and
                // the browser HOLDS its first durable write, so the sender
                // stalls inside the window with the batch nowhere near
                // complete. This side cancels only once the browser CONFIRMS
                // that hold in band — an observed edge, not a race a fast
                // 199 KiB file already lost (which is exactly how run 7 failed).
                vm.sendPicked(listOf(InteropDriver.stageOutgoing(sendName, body)), link)
                awaitTrue("the outgoing batch started") { state(vm).outgoing.isNotEmpty() }
                awaitTrue("bytes are actually moving before the cancel", 60_000) {
                    (state(vm).sendProgress?.done ?: 0L) > 0L
                }
                awaitTrue("the peer confirmed it is HOLDING the transfer", 120_000) {
                    state(vm).messages.any { it.fromPeer && it.body == gateObserved }
                }
                vm.cancelSend()
                // The REAL retirement edge, not `!sentBatch` — which was
                // already false before the cancel and would prove nothing.
                awaitTrue("the cancelled batch was retired and the lane is ready") {
                    val s = state(vm)
                    s.outgoing.isEmpty() && s.sendProgress == null && !s.sentBatch
                }
                observations["sendCancelled"] = true
                observations["cancelledSendName"] = sendName
                observations["cancelledFullSize"] = body.size

                // Release the browser's held write so the real ordered
                // BATCH_ABORT — queued behind it — can run and retire the batch
                // at the peer. Only then can the peer observe the cancel.
                send(vm, link, cancelRequested)

                // The retry: a fresh, normal-sized transfer on the SAME link,
                // which must complete. The cancelled name must NEVER complete
                // there (the oracle allows only a strictly-smaller partial).
                val retryName = "retry-$sendName"
                val retryBody = payload(2048, sendSeed + 5)
                sendBatch(vm, link, "the fresh retry after the cancel") {
                    vm.sendPicked(listOf(InteropDriver.stageOutgoing(retryName, retryBody)), link)
                }
                sentRecords.add(record(retryName, retryBody))
            } else {
                observations["sendCancelled"] = false
                // A MULTI-ENTRY batch — a >192KiB body, a ZERO-byte file (no
                // CHUNK at all; it completes on DONE alone) and a small one —
                // so the global file sequence advances across ENTRIES in THIS
                // direction too. The browser saves a multi-file batch through
                // its directory path, which the ledger now observes per file,
                // so the multi-entry SEND is proved by real per-file bytes.
                val zeroName = "zero-$sendName"
                val smallName = "small-$sendName"
                val smallBody = payload(3072, sendSeed + 2)
                sendBatch(vm, link, "the multi-entry outbound batch") {
                    vm.sendPicked(
                        listOf(
                            InteropDriver.stageOutgoing(sendName, body),
                            InteropDriver.stageOutgoing(zeroName, ByteArray(0)),
                            InteropDriver.stageOutgoing(smallName, smallBody),
                        ),
                        link,
                    )
                }
                sentRecords.add(record(sendName, body))
                sentRecords.add(record(zeroName, ByteArray(0)))
                sentRecords.add(record(smallName, smallBody))

                // A SECOND batch on the same link, so the sequence advances
                // across BATCHES as well as across entries.
                val againName = "again-$sendName"
                val againBody = payload(2048, sendSeed + 1)
                sendBatch(vm, link, "the repeated outbound batch") {
                    vm.sendPicked(listOf(InteropDriver.stageOutgoing(againName, againBody)), link)
                }
                sentRecords.add(record(againName, againBody))
            }
            observations["sent"] = sentRecords

            // Text still works after everything above — the lanes are
            // independent, and a cancel must not poison the conversation. The
            // browser half asserts it SAW this exact text, so the claim is not
            // limited to this app's own message list.
            send(vm, link, postCancelMessage)
            observations["postCancelMessage"] = postCancelMessage

            // ── the terminal handshake ──────────────────────────────────────
            //
            // Everything above proves what THIS side did; none of it proves the
            // peer has finished receiving it. Local enqueue confirmations and
            // verified-COMPLETE counters are statements about frames entering
            // the channel and batch barriers landing — not about the browser's
            // save ledger holding every byte or its thread showing the last
            // message. So the Activity stays alive until the browser says, in
            // band and only after checking its own expectations, that it has
            // everything. Closing on anything weaker cut off the second batch
            // once. The browser then observes THIS side's departure, so the
            // teardown itself is sequenced, not raced.
            awaitTrue("the browser confirmed it observed everything ($doneMessage)", 180_000) {
                state(vm).messages.any { it.fromPeer && it.body == doneMessage }
            }
            observations["peerConfirmedDone"] = true

            observations["treeAfter"] = InteropDriver.listTree()
            observations["errorKey"] = state(vm).errorKey
            observations["cleanupIncomplete"] = state(vm).cleanupIncomplete
            observations["sentinelIntact"] =
                InteropDriver.readSaved(sentinelName)?.let { sha256(it) } == sha256(sentinelBytes)
            // LAST, and only on the success path. The report is written from a
            // `finally`, so a FAILED round still produces a file — and a shell
            // that treated the file's existence as a pass would read a failure
            // as a green round. This flag is the difference, and the shell
            // requires it in addition to the instrumentation's own status.
            observations["complete"] = true
        } catch (t: Throwable) {
            failure = t
            throw t
        } finally {
            // A FAILED round's report otherwise carries only the fields added
            // before the throw — run 5's timeout reported no errorKey, no
            // phase, no counters, and the product error (if any) was invisible
            // behind "waited 180s". This terminal snapshot is best-effort and
            // must never displace the primary failure.
            runCatching {
                val s = state(InteropDriver.viewModel())
                observations["finalPhase"] = s.phase.name
                observations["finalErrorKey"] = s.errorKey
                observations["finalTextState"] = s.textState.name
                observations["finalAwaitingFolder"] = s.awaitingFolder
                observations["finalPromptId"] = s.promptId
                observations["finalSavedBatchCount"] = s.savedBatchCount
                observations["finalSentBatchCount"] = s.sentBatchCount
                observations["finalIncoming"] = s.incoming.map { it.name }
                observations["finalOutgoing"] = s.outgoing.map { it.name }
                observations["finalFileLaneDown"] = s.fileLaneDown
                observations["finalCleanupIncomplete"] = s.cleanupIncomplete
            }
            // The report must not be able to REPLACE the round's failure: a
            // throw here (a full disk, a permissions regression) would mask
            // the assertion that actually explains the round. It rides along
            // as suppressed instead. On a passing round it still fails the
            // test — an acceptance whose evidence never got written is not a
            // pass — and the scenario is closed in its own guard so a report
            // problem cannot leak the Activity either.
            try {
                InteropDriver.report(out, observations)
            } catch (r: Throwable) {
                failure?.addSuppressed(r) ?: run { scenario.close(); throw r }
            }
            scenario.close()
        }
    }

    /** The round's primary failure, if any — kept so a secondary throw from
     *  the reporting path can be attached to it rather than replacing it. */
    private var failure: Throwable? = null

    /** Start one outbound batch and wait for ITS verified COMPLETE — the
     *  monotonic per-link counter, captured BEFORE the send is even requested.
     *  `sentBatch` cannot carry this wait: it is still true from the previous
     *  batch while `sendPicked`'s metadata IO and the controller's admission
     *  are still in flight, so a wait on it returns before the new batch has
     *  begun — which is how a round once closed the app mid-transfer and
     *  reported success. A tiny batch may complete between two polls; the
     *  counter's +1 edge is durable where "outgoing became briefly non-empty"
     *  is not. */
    private fun sendBatch(vm: TransferViewModel, link: Int, what: String, start: () -> Unit) {
        val before = state(vm).sentBatchCount
        start()
        awaitTrue("the peer confirmed $what (completed batch ${before + 1})", 180_000) {
            state(vm).sentBatchCount == before + 1 && state(vm).outgoing.isEmpty()
        }
    }

    /** The inbound twin: wait for the batch AFTER [savedBefore] to be saved
     *  and verified, by the same durable counter edge. */
    private fun awaitSaved(vm: TransferViewModel, savedBefore: Int, what: String) {
        awaitTrue("$what was saved and verified (completed batch ${savedBefore + 1})", 180_000) {
            state(vm).savedBatchCount == savedBefore + 1 && state(vm).incoming.isEmpty()
        }
    }

    private fun record(name: String, body: ByteArray): Map<String, Any?> =
        mapOf("name" to name, "size" to body.size, "sha256" to sha256(body))

    /** Send one message and require the controller to CONFIRM it entered the
     *  channel — a fire-and-forget send would let a refused enqueue read as a
     *  delivered one. */
    private fun send(vm: TransferViewModel, link: Int, body: String) {
        vm.updateDraft(body, link)
        vm.sendDraft(link)
        awaitTrue("the message entered the channel: $body") {
            state(vm).messages.any { !it.fromPeer && it.body == body }
        }
        awaitTrue("the draft cleared only after that confirmed delivery") {
            vm.draftTextFor(link).isEmpty()
        }
    }

    /** Wait for the peer's NEXT offer — a prompt id ABOVE [afterPrompt], the
     *  same durable-edge rule the batch counters follow — hand it the
     *  disposable tree, and return the names it offered. A raw wait on
     *  `awaitingFolder` once consumed a STALE prompt a cancel had left
     *  standing (R22): old id, empty list, and the real offer then arrived to
     *  nobody. */
    private fun acceptOffer(vm: TransferViewModel, link: Int, afterPrompt: Int): List<String> {
        awaitTrue("the peer offered files (a prompt after #$afterPrompt)", 180_000) {
            state(vm).awaitingFolder && state(vm).promptId > afterPrompt
        }
        val offered = state(vm).incoming.map { it.name }
        vm.acceptIncoming(state(vm).promptId, InteropDriver.treeUri(), link)
        return offered
    }
}
