package com.relayium.android.transport

import com.relayium.protocol.Json
import com.relayium.protocol.PairCode
import com.relayium.protocol.Signal
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
    fun create(
        selfId: String,
        peerId: String,
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

fun interface SignalingFactory {
    fun create(code: PairCode, events: SignalingClient.Events): SignalingHandle
}
