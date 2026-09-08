package com.relayium.android.nearby

/**
 * Owner-thread-confined decision state for one advertise/browse pair.
 *
 * Pure, so the one rule that is easy to get wrong — a late timer must never
 * overrule an edge that already happened — is directly testable instead of
 * being inferred from an emulator run. Port of
 * `LocalPeerTransportLifecycle.swift`.
 */
class LocalPeerTransportLifecycle {

    enum class Phase { IDLE, STARTING, RUNNING, FAILED, STOPPED }
    enum class StartDecision { ARM, IGNORE }
    enum class AnnouncementDecision { ANNOUNCE, IGNORE }
    enum class StopDecision { TEAR_DOWN, IGNORE }

    var phase: Phase = Phase.IDLE
        private set

    private var advertiseReady = false
    private var browseReady = false

    fun start(): StartDecision {
        if (phase != Phase.IDLE) return StartDecision.IGNORE
        phase = Phase.STARTING
        return StartDecision.ARM
    }

    fun advertiseBecameReady(): AnnouncementDecision {
        if (phase != Phase.STARTING) return AnnouncementDecision.IGNORE
        advertiseReady = true
        return announceWhenReady()
    }

    fun browseBecameReady(): AnnouncementDecision {
        if (phase != Phase.STARTING) return AnnouncementDecision.IGNORE
        browseReady = true
        return announceWhenReady()
    }

    fun fail(): AnnouncementDecision {
        if (phase == Phase.FAILED || phase == Phase.STOPPED) return AnnouncementDecision.IGNORE
        phase = Phase.FAILED
        return AnnouncementDecision.ANNOUNCE
    }

    /**
     * The arming window closed with neither half ready and nothing failed.
     *
     * `NsdManager` does not report "this link has no multicast" — and, on a
     * future target, will not report a refused local-network permission — as a
     * registration or discovery FAILURE. It simply never calls back, so without
     * a deadline the channel never opens and the user is shown a search that
     * cannot end. Failing is the honest answer AND the recoverable one: the
     * model's bounded backoff reopens, so a link that comes up a moment later
     * is picked up.
     *
     * Only from STARTING: a pair that became ready, failed or was stopped has
     * already had its say.
     */
    fun startDeadlineElapsed(): AnnouncementDecision {
        if (phase != Phase.STARTING) return AnnouncementDecision.IGNORE
        phase = Phase.FAILED
        return AnnouncementDecision.ANNOUNCE
    }

    fun stop(): StopDecision {
        if (phase == Phase.STOPPED) return StopDecision.IGNORE
        phase = Phase.STOPPED
        return StopDecision.TEAR_DOWN
    }

    /** Whether delegate events may still be delivered. A listener callback that
     *  fires after a stop is a callback about a room that is gone. */
    val isDeliveringEvents: Boolean
        get() = phase == Phase.STARTING || phase == Phase.RUNNING

    private fun announceWhenReady(): AnnouncementDecision {
        if (!advertiseReady || !browseReady) return AnnouncementDecision.IGNORE
        phase = Phase.RUNNING
        return AnnouncementDecision.ANNOUNCE
    }
}
