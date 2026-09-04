import Foundation

/// Queue-confined decision state for a listener/browser pair.
struct LocalPeerTransportLifecycle {
    enum Phase: Equatable { case idle, starting, running, failed, stopped }
    enum StartDecision: Equatable { case arm, ignore }
    enum AnnouncementDecision: Equatable { case announce, ignore }
    enum StopDecision: Equatable { case tearDown, ignore }

    private(set) var phase: Phase = .idle
    private var listenerReady = false
    private var browserReady = false

    mutating func start() -> StartDecision {
        guard phase == .idle else { return .ignore }
        phase = .starting
        return .arm
    }

    mutating func listenerBecameReady() -> AnnouncementDecision {
        guard phase == .starting else { return .ignore }
        listenerReady = true
        return announceWhenReady()
    }

    mutating func browserBecameReady() -> AnnouncementDecision {
        guard phase == .starting else { return .ignore }
        browserReady = true
        return announceWhenReady()
    }

    mutating func fail() -> AnnouncementDecision {
        guard phase != .failed, phase != .stopped else { return .ignore }
        phase = .failed
        return .announce
    }

    /// The arming window closed with neither half ready and nothing failed.
    ///
    /// `NWListener` and `NWBrowser` do not report a refused Local Network
    /// permission — or a link that is simply not up — as `.failed`. They sit in
    /// `.waiting`, which is neither of the two edges this type announces, so
    /// without a deadline the channel never opens, `LanDiscoveryModel` never
    /// leaves `connecting`, and the user is shown a search that cannot end.
    /// Failing is the honest answer AND the recoverable one: the model's bounded
    /// backoff reopens, so a permission granted a moment later is picked up.
    ///
    /// Only from `starting`. A pair that became ready, failed, or was stopped
    /// has already had its say, and a late timer must not overrule it.
    mutating func startDeadlineElapsed() -> AnnouncementDecision {
        guard phase == .starting else { return .ignore }
        phase = .failed
        return .announce
    }

    mutating func stop() -> StopDecision {
        guard phase != .stopped else { return .ignore }
        phase = .stopped
        return .tearDown
    }

    var isDeliveringEvents: Bool { phase == .starting || phase == .running }

    private mutating func announceWhenReady() -> AnnouncementDecision {
        guard listenerReady, browserReady else { return .ignore }
        phase = .running
        return .announce
    }
}
