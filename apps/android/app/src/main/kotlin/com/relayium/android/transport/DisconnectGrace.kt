package com.relayium.android.transport

import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * How long a connected link may be `DISCONNECTED` before it is called lost.
 *
 * `DISCONNECTED` is WebRTC saying connectivity checks have stopped being
 * answered — not that the connection is gone. On a phone that is an ordinary
 * event: a Wi-Fi to cellular handover, a NAT rebinding, two seconds in a lift.
 * libwebrtc very often returns to `CONNECTED` by itself, and a peer that is the
 * initiator (the website, the Mac) answers it with an ICE restart this side
 * already knows how to accept. Ending the link on the FIRST `DISCONNECTED`, as
 * this transport did, threw both recoveries away: everything queued was lost
 * and the user needed a new code, for an interruption they might not even have
 * noticed.
 *
 * `FAILED` and `CLOSED` are not softened — they are WebRTC's own terminal
 * answers and still end the link at once. This only declines to pre-empt them.
 *
 * Bounded: a link that has not recovered inside [graceMs] ends exactly as it did
 * before, as `connection-lost`. Not a resume layer — relayium-link-v1 §8.4
 * still defers that; nothing is rebuilt here, the same connection is simply
 * given the chance to come back.
 *
 * All calls and the expiry run on [executor], the transport's own thread.
 */
internal class DisconnectGrace(
    private val executor: ScheduledExecutorService,
    private val graceMs: Long,
    private val onInterrupted: (Boolean) -> Unit,
    private val onExpired: () -> Unit,
) {
    private var timer: ScheduledFuture<*>? = null

    val pending: Boolean get() = timer != null

    /** The connection stopped answering. A repeat while already waiting does not
     *  extend the wait: the bound is from the FIRST loss. */
    fun disconnected() {
        if (timer != null) return
        onInterrupted(true)
        timer = executor.schedule(
            {
                if (timer == null) return@schedule
                timer = null
                onExpired()
            },
            graceMs, TimeUnit.MILLISECONDS,
        )
    }

    /** Connectivity is back on the same connection. */
    fun recovered() {
        val waiting = timer ?: return
        waiting.cancel(false)
        timer = null
        onInterrupted(false)
    }

    /** The link is ending for some other reason; say nothing more. */
    fun cancel() {
        timer?.cancel(false)
        timer = null
    }

    companion object {
        /** Long enough for a handover and one ICE restart round trip, short
         *  enough that a dead link is not dressed up as a slow one. */
        const val DEFAULT_GRACE_MS = 12_000L
    }
}
