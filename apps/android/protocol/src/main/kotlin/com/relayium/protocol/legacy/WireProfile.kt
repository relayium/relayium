package com.relayium.protocol.legacy

import com.relayium.protocol.LinkProtocol
import com.relayium.protocol.Signal

/**
 * Which wire ONE established connection speaks: its role, its channel labels,
 * and the exact shape of the four signals a WebRTC establishment emits.
 *
 * ## Why a profile rather than a second transport
 *
 * `link/1` and the two legacy generations differ in their VOCABULARY, not in
 * their establishment. Both hold candidates until the remote description lands,
 * both capture pre-ready frames in arrival order, both bound inbound admission
 * before allocating, both drive the same commit-reveal handshake, and both have
 * to dispose native objects off the observer's stack. Forking the transport
 * would duplicate every one of those and give the copy its own bugs.
 *
 * So the transport asks THIS for the four things that actually differ, and
 * [Link] is byte-for-byte what the transport did before this type existed.
 *
 * It lives beside the legacy vocabulary because the legacy variant is the only
 * reason a profile exists at all.
 */
sealed interface WireProfile {

    /** Who offers. NOT a derived value: see [Legacy]. */
    val role: LinkProtocol.Role

    /** The label carrying file-lane frames, or null when this wire has no file
     *  lane. A null lane's sends are refused rather than silently misrouted. */
    val fileChannel: String?

    /** The label carrying message frames, or null. */
    val textChannel: String?

    /** Every label this wire has, in the order an INITIATOR must create them.
     *  A tuple, not a set: `link/1` refuses a reversed or short pair. */
    val channels: List<String>

    fun offer(sdp: String, commit: String): Signal
    fun answer(sdp: String, commit: String): Signal
    fun candidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?): Signal
    fun reveal(key: String, nonce: String): Signal

    /**
     * Whether an inbound SDP of this type may be applied at all.
     *
     * See [Legacy] for why this is not always true.
     */
    fun acceptsSdp(type: String): Boolean

    /**
     * The ONE signalling generation this connection answers.
     *
     * `RealtimeConnection` filters every inbound frame by exactly this before
     * its handler runs, and so must this side. The generations share one room
     * and one socket, so without the filter a frame tagged for a DIFFERENT
     * connection reaches this one's handshake: a `link`-tagged `busy` closes a
     * live legacy connection, a `link`-tagged `commit` is recorded as a
     * replacement and fails it, and a `link`-tagged reveal is verified against
     * a commitment it has nothing to do with. None of those is reachable from a
     * conforming peer, and all of them are reachable from the relay.
     */
    val generation: Signal.Generation

    /** Whether this signal belongs to THIS connection at all. */
    fun accepts(signal: Signal): Boolean = signal.generation == generation

    /**
     * `link/1`: two ordered lanes on one connection, role computed from the
     * room ids by both peers identically.
     *
     * Nothing about this case is new. The role still comes from
     * [LinkProtocol.linkRole], the labels are still the [LinkProtocol]
     * CHANNEL_LABELS tuple, the signals still carry `link:true` and the full
     * advertised capability list, and both SDP types are still accepted —
     * `link/1` has always relied on the sorted-id role alone to prevent glare.
     */
    data class Link(override val role: LinkProtocol.Role) : WireProfile {
        override val fileChannel: String get() = LinkProtocol.FILE_CHANNEL
        override val textChannel: String get() = LinkProtocol.TEXT_CHANNEL
        override val channels: List<String> get() = LinkProtocol.CHANNEL_LABELS
        override fun offer(sdp: String, commit: String) =
            Signal.offer(sdp, commit, LinkProtocol.ADVERTISED_CAPS)
        override fun answer(sdp: String, commit: String) =
            Signal.answer(sdp, commit, LinkProtocol.ADVERTISED_CAPS)
        override fun candidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) =
            Signal.candidate(candidate, sdpMid, sdpMLineIndex)
        override fun reveal(key: String, nonce: String) = Signal.reveal(key, nonce)
        override fun acceptsSdp(type: String) = true
        override val generation: Signal.Generation get() = Signal.Generation.LINK
    }

    /**
     * A shipped pre-`link/1` connection: ONE `data` channel carrying one
     * generation.
     *
     * ## The role is the user's intent, not the room ids
     *
     * `RealtimeSessionModel.join` takes it from the verb the user pressed —
     * creating a code offers, joining one answers — and the peer id ordering
     * has no part in it. Computing a sorted role here would make two clients
     * that both minted, or both joined, silently disagree about who offers.
     *
     * ## Why the SDP type is filtered
     *
     * There is no sorted-id tiebreak on this wire, so glare is prevented ONLY
     * by the two intents being different. An initiator that answered an inbound
     * offer would be renegotiating against itself, and a responder that applied
     * an answer it never asked for would be adopting a description for an offer
     * it never made. Neither can happen with a conforming peer, and both are
     * cheap to refuse rather than to discover as a stall.
     */
    data class Legacy(
        override val role: LinkProtocol.Role,
        val lane: LegacyProtocol.Lane,
    ) : WireProfile {
        override val fileChannel: String?
            get() = if (lane == LegacyProtocol.Lane.FILES) LegacyProtocol.CHANNEL else null
        override val textChannel: String?
            get() = if (lane == LegacyProtocol.Lane.TEXT) LegacyProtocol.CHANNEL else null
        override val channels: List<String> get() = listOf(LegacyProtocol.CHANNEL)
        override fun offer(sdp: String, commit: String) = LegacyProtocol.offer(sdp, commit, lane)
        override fun answer(sdp: String, commit: String) = LegacyProtocol.answer(sdp, commit, lane)
        override fun candidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) =
            LegacyProtocol.candidate(candidate, sdpMid, sdpMLineIndex, lane)
        override fun reveal(key: String, nonce: String) = LegacyProtocol.reveal(key, nonce, lane)
        override fun acceptsSdp(type: String) =
            if (role == LinkProtocol.Role.INITIATOR) type == "answer" else type == "offer"
        override val generation: Signal.Generation
            get() = if (lane == LegacyProtocol.Lane.TEXT) {
                Signal.Generation.TEXT
            } else {
                Signal.Generation.FILE
            }
    }
}
