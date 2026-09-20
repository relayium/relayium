package com.relayium.android

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import com.relayium.android.InteropDriver.arg
import com.relayium.android.InteropDriver.awaitTrue
import com.relayium.android.InteropDriver.requireArg
import com.relayium.android.InteropDriver.state
import com.relayium.android.transport.RelayRenewEngine
import java.util.concurrent.atomic.AtomicBoolean
import org.webrtc.Logging
import org.webrtc.PeerConnectionFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The ANDROID half of the Android ↔ Web ACTIVE-TRANSFER RENEWAL acceptance.
 *
 * Root owns the throwaway server, its accelerated credential TTL, the browser
 * peer, the emulator and every comparison. This half drives the real app —
 * `MainActivity`, the `TransferViewModel` it created, its `TransferController`,
 * real OkHttp signalling, real native WebRTC and the real SAF stack — and
 * records what it observed.
 *
 * ## Why this is a separate test rather than a flag on the existing one
 *
 * `InteropAcceptanceTest` proves interoperability: two implementations agreeing
 * about frames, batches, cancels and a conversation. Its shape is wrong for
 * this question in one specific way — it sends a MULTI-ENTRY batch under a
 * fixed 180 s completion bound, which a deliberately slow multi-megabyte file
 * cannot meet. Widening that bound would loosen the oracle for every ordinary
 * round; this one carries its own twelve-minute bound and asserts nothing about
 * multi-entry behaviour.
 *
 * ## What it is actually asking
 *
 * Renewal is only real if a transfer that OUTLIVES its credential keeps going
 * on the SAME link. So: one large file, sent slowly enough that the accelerated
 * grant expires under it more than once, and then three things together —
 *
 *  - the credential boundary STRICTLY ADVANCED at least twice, which cannot
 *    happen without two committed migrations;
 *  - `linkId` and the SAS never changed, so nothing re-paired and no key
 *    agreement was redone;
 *  - the transfer completed, and the peer said so in band.
 *
 * Any one of those alone is satisfiable by a bug. A boundary that advances
 * while the link is re-established is a re-pair; a link that survives while the
 * boundary never moves means the credential outlived its own expiry at the
 * relay, which is the very thing renewal exists to stop relying on; and a
 * completed transfer proves nothing about either.
 *
 * ## What is NOT faked here
 *
 * The transport, the crypto, the clock, the renewal state machine and the
 * advertised capability set are all the shipped ones. There is no injected
 * renewal, no patched deadline and no shortened protocol bound: the only thing
 * this file does is watch and record. The selected-pair path must reach the
 * engine through the real SDK callback for any of it to happen at all — which
 * is exactly the fact a host test cannot establish, and the reason this exists.
 *
 * ## Running it
 *
 * ```
 * adb shell am instrument -w \
 *   -e class com.relayium.android.RelayRenewInteropAcceptanceTest \
 *   -e relayium.origin  <throwaway origin>          \
 *   -e relayium.code    <pairing code>              \
 *   -e relayium.out     <report file name>          \
 *   -e relayium.sendName <file name>                \
 *   -e relayium.sendSize <bytes, default 25165841>  \
 *   -e relayium.sendSeed <int>                      \
 *   [-e relayium.doneMarker <text>]                 \
 *   [-e relayium.minAdvances <int, default 2>]      \
 *   [-e relayium.nativeLog 1]   opt-in libwebrtc logging to logcat \
 *   com.relayium.android.debug.test/androidx.test.runner.AndroidJUnitRunner
 * ```
 *
 * The runner's own timeout must exceed the twelve-minute transfer bound.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class RelayRenewInteropAcceptanceTest {

    /**
     * The peer's TERMINAL receipt marker: an ordinary text message the browser
     * sends only after it has every byte AND has verified the file's digest.
     *
     * The local `sentBatchCount` edge says the batch's frames entered the
     * channel and its barrier landed. It does not say the peer's ledger holds
     * the file, and on a transfer this long the difference is minutes.
     */
    private val defaultDoneMarker = "relayium-renew-e2e:done"

    /** 24 MiB + 17 — deliberately not a round number, so an off-by-a-chunk
     *  truncation cannot hide behind an exact multiple of anything. */
    private val defaultSendSize = 24 * 1024 * 1024 + 17

    /** The deterministic payload rule, byte for byte the one the shell and the
     *  browser half use. */
    private fun byteAt(index: Int, seed: Int): Byte = ((index * 31 + seed) and 0xff).toByte()

    /** One sampled observation of the live session. */
    private data class Sample(
        val atMs: Long,
        val relayExpiresAt: Long?,
        val renewState: String,
        val sendDone: Long,
        val sendTotal: Long,
        val phase: String,
        val errorKey: String?,
        val linkId: Int,
        val sas: String?,
    )

    @Test
    fun renewalOutlivesTheCredential() {
        val expectedOrigin = requireArg("relayium.origin")
        val code = requireArg("relayium.code")
        val out = requireArg("relayium.out")
        val sendName = requireArg("relayium.sendName")
        val sendSize = arg("relayium.sendSize")?.toInt() ?: defaultSendSize
        val sendSeed = requireArg("relayium.sendSeed").toInt()
        val doneMarker = arg("relayium.doneMarker") ?: defaultDoneMarker
        val minAdvances = arg("relayium.minAdvances")?.toInt() ?: 2

        val observations = LinkedHashMap<String, Any?>()
        observations["sendName"] = sendName
        observations["sendSize"] = sendSize
        observations["sendSeed"] = sendSeed
        observations["doneMarker"] = doneMarker
        observations["minAdvances"] = minAdvances

        // ── opt-in native WebRTC logging ───────────────────────────────────
        //
        // OFF unless asked for, and it changes NOTHING about the product path:
        // no alternate transport, no alternate factory, no configuration
        // override. It turns on libwebrtc's own logging, which is the only way
        // to see an ICE or DTLS level cause for a connection that ends before
        // it is ready — the shipped `errorKey` collapses about fourteen
        // distinct transport close reasons into one string, so a failed
        // establishment cannot be told apart from a peer that simply vanished.
        //
        // Instrumentation runs IN the app's own process, so this reaches the
        // factory the app really uses. `initialize` is the same call
        // `LinkTransport` makes and is idempotent; it is made here only so the
        // native library is loaded before logging is enabled, which is a
        // no-op if the app has already started a transport.
        if (arg("relayium.nativeLog") != null) {
            runCatching {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions
                        .builder(androidx.test.platform.app.InstrumentationRegistry
                            .getInstrumentation().targetContext)
                        .createInitializationOptions(),
                )
                Logging.enableLogToDebugOutput(Logging.Severity.LS_INFO)
            }.onFailure { observations["nativeLogError"] = it.toString() }
            observations["nativeLog"] = true
        }

        val samples = java.util.Collections.synchronizedList(ArrayList<Sample>())
        // Every phase/error transition, with the instant it was seen. A report
        // that says only "ENDED, error_connection_lost" cannot distinguish a
        // local failure from ninety seconds of waiting for a peer that had
        // already gone; the timeline can.
        val transitions = java.util.Collections.synchronizedList(ArrayList<Map<String, Any?>>())
        val startedAtMs = System.currentTimeMillis()
        val sampling = AtomicBoolean(true)
        var sampler: Thread? = null

        val scenario = ActivityScenario.launch(MainActivity::class.java)
        try {
            val vm = InteropDriver.viewModel()
            // Watch from BEFORE the join, so a link that never connects still
            // produces a timeline rather than a single terminal snapshot.
            sampler = Thread {
                var last = ""
                while (sampling.get()) {
                    runCatching {
                        val s = state(vm)
                        val key = "${s.phase}|${s.errorKey}|${s.textState}|" +
                            "${s.linkId}|${s.renewState}|${s.linkInterrupted}"
                        if (key != last) {
                            last = key
                            transitions.add(
                                mapOf(
                                    "atMs" to System.currentTimeMillis() - startedAtMs,
                                    "phase" to s.phase.name,
                                    "errorKey" to s.errorKey,
                                    "textState" to s.textState.name,
                                    "linkId" to s.linkId,
                                    "renewState" to s.renewState.name,
                                    "linkInterrupted" to s.linkInterrupted,
                                    "sas" to (s.sas != null),
                                ),
                            )
                        }
                        samples.add(
                            Sample(
                                atMs = System.currentTimeMillis(),
                                relayExpiresAt = s.relayExpiresAt,
                                renewState = s.renewState.name,
                                sendDone = s.sendProgress?.done ?: -1L,
                                sendTotal = s.sendProgress?.total ?: -1L,
                                phase = s.phase.name,
                                errorKey = s.errorKey,
                                linkId = s.linkId,
                                sas = s.sas,
                            ),
                        )
                    }
                    Thread.sleep(250)
                }
            }.also { it.isDaemon = true; it.start() }

            // ── preflight, BEFORE anything is joined ────────────────────────
            //
            // `Backend.readDebugOverride` reads a non-public class reflectively
            // and FAILS CLOSED to production. A round that joined first would,
            // if that read ever broke, drive a disposable acceptance code
            // against the real service — so the origin is checked off the live
            // instance before the code is used for anything.
            assertEquals(
                "the app under test must be pointed at this run's throwaway server",
                expectedOrigin,
                vm.backendOrigin,
            )
            observations["origin"] = vm.backendOrigin

            // Staged through the real provider, streamed, and digested as it is
            // written — so the recorded hash is of what the provider holds.
            val (uri, sha) = InteropDriver.stageOutgoingLarge(sendName, sendSize) {
                byteAt(it, sendSeed)
            }
            observations["sendSha256"] = sha

            // ── join ────────────────────────────────────────────────────────
            vm.join(code)
            awaitTrue("the link reached CONNECTED", 120_000) {
                state(vm).phase == TransferController.Phase.CONNECTED
            }
            val link = state(vm).linkId
            val sas = state(vm).sas
            val establishedAt = System.currentTimeMillis()
            assertTrue("a connected link must have a verification code", !sas.isNullOrEmpty())
            observations["linkId"] = link
            observations["sas"] = sas

            // ── text, the same rules as the ordinary interop round ──────────
            //
            // On `link/1` an incoming request is admitted without a prompt, so
            // the lane simply opens.
            awaitTrue("the text lane opened", 120_000) { InteropDriver.textOpen(vm) }
            // The peer's start message must arrive BEFORE this side sends
            // anything, so the file leaves only once a real round trip has
            // happened and the browser is actually listening.
            awaitTrue("the peer's start message arrived", 120_000) {
                state(vm).messages.any { it.fromPeer }
            }
            observations["peerStartMessage"] = state(vm).messages.first { it.fromPeer }.body

            // ── the long outbound file ──────────────────────────────────────
            val startedAt = System.currentTimeMillis()
            val sentBefore = state(vm).sentBatchCount
            vm.sendPicked(listOf(uri), link)
            awaitTrue("the outgoing batch started", 120_000) {
                state(vm).outgoing.isNotEmpty() || state(vm).sentBatchCount > sentBefore
            }

            // Twelve minutes, because the point of this round is a transfer
            // slow enough for the credential under it to expire more than once.
            awaitTrue(
                "the batch completed (sentBatchCount ${sentBefore + 1}) and the lane is clear",
                TRANSFER_BOUND_MS,
            ) {
                state(vm).sentBatchCount == sentBefore + 1 && state(vm).outgoing.isEmpty()
            }
            observations["transferMs"] = System.currentTimeMillis() - startedAt

            // Local completion says the frames entered the channel. Only the
            // peer knows the peer has everything and that the digest matched.
            awaitTrue("the peer confirmed receipt ($doneMarker)", TRANSFER_BOUND_MS) {
                state(vm).messages.any { it.fromPeer && it.body == doneMarker }
            }
            observations["peerConfirmedDone"] = true

            sampling.set(false)
            sampler.join(5_000)

            // ── what the boundary did ───────────────────────────────────────
            // Pre-join samples remain diagnostic evidence. Continuity begins
            // at the established session and retains EVERY subsequent sample,
            // including a later zero id, a replacement link or a terminal phase.
            val allSamples = ArrayList(samples)
            val snapshot = allSamples.filter { it.atMs >= establishedAt }
            assertTrue("the established session was sampled", snapshot.isNotEmpty())
            observations["establishedAt"] = establishedAt
            observations["preJoinLinkIds"] = allSamples.filter { it.atMs < establishedAt }
                .map { it.linkId }.distinct()
            val bounds = ArrayList<Long>()
            for (sample in snapshot) {
                val value = sample.relayExpiresAt ?: continue
                if (bounds.isEmpty() || bounds.last() != value) bounds.add(value)
            }
            val advances = bounds.zipWithNext().count { (previous, next) -> next > previous }
            observations["relayBounds"] = bounds
            observations["relayBoundAdvances"] = advances
            observations["renewStates"] = snapshot.map { it.renewState }.distinct()
            observations["transitions"] = ArrayList(transitions)
            observations["sendProgress"] = progressTrack(snapshot)
            observations["linkIdsSeen"] = snapshot.map { it.linkId }.distinct()
            observations["sasSeen"] = snapshot.mapNotNull { it.sas }.distinct()
            observations["phasesSeen"] = snapshot.map { it.phase }.distinct()
            observations["errorKeysSeen"] = snapshot.mapNotNull { it.errorKey }.distinct()

            // A relayed link that never bounded itself would report no bounds
            // at all — which is exactly the shape of the dropped initial
            // selected-pair event, and is NOT a pass.
            assertTrue(
                "the link was never bounded by a credential at all; either the path " +
                    "was not relayed or the selected pair never reached the engine",
                bounds.isNotEmpty(),
            )
            assertTrue(
                "the credential boundary must strictly advance at least $minAdvances times " +
                    "for this to be a renewal rather than one long grant; saw $advances " +
                    "across $bounds",
                advances >= minAdvances,
            )
            // …on the SAME link. A boundary that advances while the link is
            // rebuilt is a re-pair, which is the thing renewal must not be.
            assertEquals(
                "the link id changed, so this was not one continuous session",
                listOf(link),
                snapshot.map { it.linkId }.distinct(),
            )
            assertEquals(
                "the verification code changed, so keys were re-agreed",
                listOf(sas),
                snapshot.mapNotNull { it.sas }.distinct(),
            )
            assertTrue(
                "the session entered a terminal phase during the transfer",
                snapshot.none { it.phase == TransferController.Phase.ENDED.name },
            )
            assertNull("the session reported an error", state(vm).errorKey)
            assertEquals(
                "renewal must never be claimed without a committed migration",
                RelayRenewEngine.State.RENEWED.name,
                snapshot.last { it.renewState != RelayRenewEngine.State.IDLE.name }.renewState,
            )

            // LAST, and only on the success path. The report is written from a
            // `finally`, so a FAILED round still produces a file — and a reader
            // that treated the file's existence as a pass would read a failure
            // as a green round.
            observations["complete"] = true
        } catch (t: Throwable) {
            failure = t
            throw t
        } finally {
            sampling.set(false)
            runCatching { sampler?.join(5_000) }
            // A failed round's report otherwise carries only the fields added
            // before the throw, and the product state that explains it would be
            // invisible behind "waited twelve minutes".
            runCatching {
                val s = state(InteropDriver.viewModel())
                observations["finalPhase"] = s.phase.name
                observations["finalErrorKey"] = s.errorKey
                observations["finalRenewState"] = s.renewState.name
                observations["finalRelayExpiresAt"] = s.relayExpiresAt
                observations["finalRelayWarning"] = s.relayExpiryWarning
                observations["finalTextState"] = s.textState.name
                observations["finalSentBatchCount"] = s.sentBatchCount
                observations["finalOutgoing"] = s.outgoing.map { it.name }
                observations["finalSendProgress"] = s.sendProgress?.done
                observations["finalLinkInterrupted"] = s.linkInterrupted
                observations["finalMessagesFromPeer"] =
                    s.messages.filter { it.fromPeer }.map { it.body }
                observations["transitions"] = ArrayList(transitions)
                if (!observations.containsKey("relayBounds")) {
                    val partial = ArrayList<Long>()
                    for (sample in ArrayList(samples)) {
                        val value = sample.relayExpiresAt ?: continue
                        if (partial.isEmpty() || partial.last() != value) partial.add(value)
                    }
                    observations["relayBounds"] = partial
                    observations["sendProgress"] = progressTrack(ArrayList(samples))
                }
            }
            try {
                InteropDriver.report(out, observations)
            } catch (r: Throwable) {
                failure?.addSuppressed(r) ?: run { scenario.close(); throw r }
            }
            scenario.close()
        }
    }

    /** The round's primary failure, kept so a secondary throw from the
     *  reporting path is attached to it rather than replacing it. */
    private var failure: Throwable? = null

    /**
     * Real send progress, thinned to the points where it actually moved.
     *
     * Every 250 ms sample of a twelve-minute transfer is roughly three thousand
     * entries of mostly the same number; what a reader needs is that bytes kept
     * moving ACROSS the renewals, so this records each change with the instant
     * it was observed.
     */
    private fun progressTrack(samples: List<Sample>): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        var last = Long.MIN_VALUE
        for (sample in samples) {
            if (sample.sendDone == last) continue
            last = sample.sendDone
            out.add(
                mapOf(
                    "atMs" to sample.atMs,
                    "done" to sample.sendDone,
                    "total" to sample.sendTotal,
                    "relayExpiresAt" to sample.relayExpiresAt,
                    "renewState" to sample.renewState,
                ),
            )
        }
        return out
    }

    private companion object {
        /** Twelve minutes. Root's browser half holds each chunk for about four
         *  seconds, which is what makes a transfer of this size span two
         *  accelerated credential lifetimes. */
        const val TRANSFER_BOUND_MS = 12 * 60_000L
    }
}
