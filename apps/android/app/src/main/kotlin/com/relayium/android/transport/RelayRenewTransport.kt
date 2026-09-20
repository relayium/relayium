package com.relayium.android.transport

import com.relayium.protocol.RelayRenewSdp

/**
 * The narrow surface a relay renewal drives on a LIVE `link/1` transport.
 *
 * `org.webrtc` types are deliberately absent from every signature. That is what
 * lets [com.relayium.android.RelayRenewEngine] — the whole epoch state machine,
 * every bound and every refusal — run under plain JVM tests against a recording
 * fake, rather than only on a device. The one thing that CANNOT be tested that
 * way is whether libwebrtc actually honours a same-`PeerConnection` ICE restart
 * and reports the selected pair; that is [LinkTransport]'s side of this seam and
 * it has its own instrumented acceptance.
 *
 * Every method runs on the transport's executor thread, and every callback fires
 * on it.
 */
interface RenewTransport {

    /** One ICE candidate, as pure data. */
    data class Candidate(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int?)

    /** A local description that was actually applied, and the ICE generation it
     *  named. */
    data class LocalSdp(val sdp: String, val ufrag: String)

    /** The pair the ICE agent actually selected, as the platform reported it. */
    data class SelectedPair(val local: String, val remote: String)

    /**
     * Apply a renewed configuration to the SAME `PeerConnection`.
     *
     * Applying a configuration is NOT a migration and must never be treated as
     * one: `false` here is a failure, and `true` is only permission to try.
     */
    fun applyConfiguration(servers: List<IceConfig.Server>): Boolean

    /**
     * Create, apply and hand back an ICE-restart OFFER.
     *
     * Null means the restart did not happen — the stack refused, or the applied
     * description named the SAME ICE generation as the one before it, which
     * would make every later ufrag comparison vacuous. Null never fails the
     * link: a refused renewal keeps the deadline it already has.
     */
    fun createRenewOffer(onResult: (LocalSdp?) -> Unit)

    /** Create, apply and hand back the ANSWER to a renewal offer already
     *  applied by [applyRemoteSdp]. Null as in [createRenewOffer]. */
    fun createRenewAnswer(onResult: (LocalSdp?) -> Unit)

    /** `setRemoteDescription`. The caller has already pinned it. */
    fun applyRemoteSdp(sdpType: String, sdp: String, onResult: (Boolean) -> Unit)

    /** Add one remote candidate the caller has already bound to an epoch. */
    fun addCandidate(candidate: Candidate): Boolean

    /**
     * Local candidates for a renewal epoch. One subscriber; replacing it
     * replaces the previous, and null detaches.
     *
     * While a subscriber is attached the transport does NOT emit its ordinary
     * unsigned `link`-generation candidate signals. Two things would otherwise
     * go wrong at once: the new generation's candidates would reach the peer
     * unauthenticated, and a peer that has already locked unsigned SDP would
     * discard them — so the migration would be starved of exactly the
     * candidates it exists to gather.
     */
    fun onCandidate(cb: ((Candidate) -> Unit)?)

    /**
     * The pair the ICE agent actually selected. One subscriber; null detaches.
     *
     * ALWAYS-ON, not epoch-scoped: the first observation is what classifies the
     * path and therefore what decides whether this link is bounded by a
     * credential at all. A link that never reports one is never bounded and
     * never renews, which is the safe direction on a platform where the
     * callback's availability is a runtime fact rather than a compile-time one.
     *
     * **Attaching REPLAYS the last real observation, if there was one.** ICE
     * selects a pair when it has one, which is routinely before DTLS finishes,
     * before either lane opens and before the handshake this subscription waits
     * on. An implementation that only forwarded live events would drop exactly
     * the first selection — the one that decides whether the link is bounded —
     * and stay unbounded until a later pair change a stable connection has no
     * reason to produce.
     */
    fun onSelectedPair(cb: ((SelectedPair) -> Unit)?)

    /**
     * The pin taken from the remote description actually applied at epoch 0.
     *
     * Null before any remote description has been applied. The REMOTE one,
     * deliberately: the pin is what a remote description at epoch >= 1 is
     * checked against, and it is the peer's DTLS identity that must not change.
     */
    fun baselinePin(): RelayRenewSdp.Pin?

    /** Put one 59-byte control frame on the text lane, ahead of the text
     *  session and outside its send queue. */
    fun sendControlFrame(frame: ByteArray): Boolean

    /**
     * Refuse unsigned `link`-generation SDP and ICE for the remainder of this
     * `PeerConnection`.
     *
     * Called once this link has verified ANY renewal signal from its peer. The
     * decision is monotonic and authenticated, and deliberately does not rest
     * on the unsigned capability hint.
     */
    fun lockUnsignedSdp()
}
