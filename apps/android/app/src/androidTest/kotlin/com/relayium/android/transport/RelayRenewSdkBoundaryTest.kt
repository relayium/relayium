package com.relayium.android.transport

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.relayium.protocol.RelayRenewSdp
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * The three facts about the real WebRTC SDK that the whole renewal path rests
 * on, asserted against `io.github.webrtc-sdk:android` itself.
 *
 * Everything else in this feature runs on the JVM against fakes, deliberately.
 * These three cannot: they are statements about what libwebrtc actually does on
 * a device, and a fake that answered them would be the fake asserting itself.
 *
 *  1. `onSelectedCandidatePairChanged` FIRES, and carries both candidates.
 *     Without it no link is ever classified, bounded or renewed — the feature
 *     degrades to exactly today's behaviour, truthfully but silently.
 *  2. A local candidate string carries its own ` ufrag <x>` extension.
 *     `org.webrtc.IceCandidate` exposes no `usernameFragment` property, so that
 *     parse is the only source of a candidate's ICE generation on this
 *     platform. Without it observation can never hold.
 *  3. `restartIce()` followed by `createOffer` produces a description naming a
 *     NEW `a=ice-ufrag`. If it did not, every later ufrag comparison would be
 *     vacuous and a migration would be "proved" by the pair already selected.
 *
 * ## Running this
 *
 * It needs a device or emulator — `connectedDebugAndroidTest`. It is written to
 * run on loopback host candidates with no TURN server and no network, so it
 * asserts the SDK's behaviour and nothing about relays. A failure here is not a
 * bug in the renewal code; it is the SDK not providing what the design assumed,
 * and it changes which of the two degradations Android ships with.
 */
@RunWith(AndroidJUnit4::class)
class RelayRenewSdkBoundaryTest {

    private lateinit var factory: PeerConnectionFactory
    private val connections = ArrayList<PeerConnection>()

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
    }

    @After
    fun tearDown() {
        for (connection in connections) runCatching { connection.dispose() }
        runCatching { factory.dispose() }
    }

    private class Observer(
        val onCandidate: (IceCandidate) -> Unit,
        val onSelected: (CandidatePairChangeEvent) -> Unit,
    ) : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) = onCandidate(candidate)
        override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent) =
            onSelected(event)
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
        override fun onAddStream(stream: MediaStream?) = Unit
        override fun onRemoveStream(stream: MediaStream?) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
    }

    private fun connection(
        onCandidate: (IceCandidate) -> Unit,
        onSelected: (CandidatePairChangeEvent) -> Unit = {},
    ): PeerConnection {
        val config = PeerConnection.RTCConfiguration(emptyList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        val connection = factory.createPeerConnection(config, Observer(onCandidate, onSelected))!!
        connections.add(connection)
        return connection
    }

    private fun observer(done: CountDownLatch, sink: AtomicReference<SessionDescription>? = null) =
        object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                sink?.set(description)
                done.countDown()
            }
            override fun onSetSuccess() = done.countDown()
            override fun onCreateFailure(error: String?) = done.countDown()
            override fun onSetFailure(error: String?) = done.countDown()
        }

    private fun await(latch: CountDownLatch, what: String, seconds: Long = 15) {
        assertTrue("timed out waiting for $what", latch.await(seconds, TimeUnit.SECONDS))
    }

    /** Facts 1 and 2, on a real loopback pair. */
    @Test
    fun theSdkReportsTheSelectedPairAndNamesItsGeneration() {
        val selected = AtomicReference<CandidatePairChangeEvent>()
        val selectedLatch = CountDownLatch(1)
        val localCandidates = java.util.Collections.synchronizedList(ArrayList<IceCandidate>())

        lateinit var answerer: PeerConnection
        val offerer = connection(
            onCandidate = { candidate ->
                localCandidates.add(candidate)
                answerer.addIceCandidate(candidate)
            },
            onSelected = { event ->
                if (selected.compareAndSet(null, event)) selectedLatch.countDown()
            },
        )
        answerer = connection(onCandidate = { offerer.addIceCandidate(it) })

        offerer.createDataChannel("relayium", DataChannel.Init().apply { ordered = true })

        val offer = AtomicReference<SessionDescription>()
        var latch = CountDownLatch(1)
        offerer.createOffer(observer(latch, offer), MediaConstraints())
        await(latch, "the offer")

        latch = CountDownLatch(2)
        offerer.setLocalDescription(observer(latch), offer.get())
        answerer.setRemoteDescription(observer(latch), offer.get())
        await(latch, "the offer to be applied")

        val answer = AtomicReference<SessionDescription>()
        latch = CountDownLatch(1)
        answerer.createAnswer(observer(latch, answer), MediaConstraints())
        await(latch, "the answer")

        latch = CountDownLatch(2)
        answerer.setLocalDescription(observer(latch), answer.get())
        offerer.setRemoteDescription(observer(latch), answer.get())
        await(latch, "the answer to be applied")

        // FACT 1. Without this callback no Android link is ever classified,
        // bounded or renewed.
        await(selectedLatch, "onSelectedCandidatePairChanged", seconds = 30)
        val event = selected.get()
        assertNotNull("the event carries the local candidate", event.local)
        assertNotNull("and the remote one", event.remote)

        // FACT 2. `IceCandidate` has no `usernameFragment`, so the string's own
        // extension is the only source of a candidate's generation here.
        val localUfrag = RelayRenewSdp.iceUfrag(offer.get().description)
        assertTrue("the offer states an ice-ufrag", localUfrag.isNotEmpty())
        val gathered = ArrayList(localCandidates)
        assertTrue("some local candidates were gathered", gathered.isNotEmpty())
        assertTrue(
            "a gathered candidate names its own generation: " +
                gathered.joinToString("; ") { it.sdp },
            gathered.any { RelayRenewSdp.candidateUfrag(it.sdp) == localUfrag },
        )
        assertTrue(
            "and the selected local candidate can be attributed to it: ${event.local.sdp}",
            RelayRenewSdp.localCandidateBelongsTo(event.local.sdp, localUfrag),
        )
    }

    /** Fact 3: an ICE restart really does produce a new generation. */
    @Test
    fun restartIceProducesANewGeneration() {
        val connection = connection(onCandidate = {})
        connection.createDataChannel("relayium", DataChannel.Init().apply { ordered = true })

        val first = AtomicReference<SessionDescription>()
        var latch = CountDownLatch(1)
        connection.createOffer(observer(latch, first), MediaConstraints())
        await(latch, "the first offer")
        latch = CountDownLatch(1)
        connection.setLocalDescription(observer(latch), first.get())
        await(latch, "the first offer to be applied")

        connection.restartIce()
        val second = AtomicReference<SessionDescription>()
        latch = CountDownLatch(1)
        connection.createOffer(observer(latch, second), MediaConstraints())
        await(latch, "the restart offer")

        val before = RelayRenewSdp.iceUfrag(first.get().description)
        val after = RelayRenewSdp.iceUfrag(second.get().description)
        assertTrue(before.isNotEmpty() && after.isNotEmpty())
        assertNotEquals(
            "a restart that reuses the generation would make every later " +
                "ufrag comparison vacuous",
            before,
            after,
        )

        // …and the pin is unchanged across it: same fingerprint, same mids, so
        // the peer's own check passes on a legitimate restart.
        val baseline = RelayRenewSdp.pin(first.get().description)
        assertTrue(
            "the restart keeps the DTLS identity and m-line shape",
            RelayRenewSdp.pinMatches(baseline, RelayRenewSdp.pin(second.get().description), false),
        )
    }
}
