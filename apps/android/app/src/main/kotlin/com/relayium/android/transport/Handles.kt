package com.relayium.android.transport

import com.relayium.android.nearby.ConnectionSource
import com.relayium.protocol.Json
import com.relayium.protocol.Signal
import com.relayium.protocol.legacy.WireProfile
import java.util.concurrent.ScheduledExecutorService

/**
 * The controller's two effect seams.
 *
 * Narrow on purpose: exactly the calls [com.relayium.android.TransferController]
 * makes, so its ownership, generation-fencing and failure behaviour run under
 * JVM tests against fakes that record real interactions — not against the
 * controller's own untested mirror.
 */
interface TransportHandle {
    fun start()
    fun onSignal(raw: Json)
    /** False means the frame did NOT enter the channel. The caller must treat
     *  that as the lane-stranding event it is — the nonce is already spent. */
    fun sendFile(frame: ByteArray): Boolean
    fun sendText(frame: ByteArray): Boolean
    fun fileBufferedAmount(): Long
    fun textBufferedAmount(): Long
    fun leaveAndClose(leave: Signal?)
    fun close(reason: String)
}

fun interface TransportFactory {
    /** [profile] carries the role AND the wire. Nothing below this seam
     *  recomputes either: see [com.relayium.protocol.legacy.WireProfile]. */
    fun create(
        profile: WireProfile,
        servers: List<IceConfig.Server>,
        executor: ScheduledExecutorService,
        send: (Signal) -> Unit,
        events: LinkTransport.Events,
    ): TransportHandle
}

interface SignalingHandle {
    fun connect()
    fun sendSignal(to: String, data: Json)
    fun close()
}

/**
 * A signalling transport whose streams are PER PEER, so one peer's stream can be
 * retired without ending the room.
 *
 * The hub's WebSocket is one socket for every peer and cannot offer this: there,
 * retiring a connection means leaving the room. A local Bonjour/TCP rendezvous
 * has a stream per peer, and closing exactly the one that carried a finished
 * establishment is what makes "a frame from the previous connection cannot reach
 * the next one" structural instead of a timing hope.
 *
 * Optional on purpose. The owner asks with `as? PeerScopedSignaling`, and a
 * handle that cannot do it is not a handle that does it badly.
 */
interface PeerScopedSignaling {
    /** Close the stream bound to [peerId]. NOT a departure: the peer is still
     *  advertising and must stay in the list the user is looking at. */
    fun retirePeer(peerId: String)
}

fun interface SignalingFactory {
    /** [source] is WHY this client is in a room — a pairing code, the code-less
     *  hub room, or the local link — and it decides which rendezvous is opened.
     *  Handed in rather than re-derived so no layer below can disagree with the
     *  owner about which of the three it is on. */
    fun create(source: ConnectionSource, events: SignalingClient.Events): SignalingHandle
}
