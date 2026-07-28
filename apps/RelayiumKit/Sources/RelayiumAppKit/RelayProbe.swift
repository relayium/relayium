import Foundation
import WebRTC
import RelayiumKit

/// Times the TURN Allocate round trip to each relay in the pool.
///
/// ⚠️ NOT UNIT-TESTED, deliberately. Every decision this feature makes lives in
/// `RelayChoice` and `RelayNegotiator`, which are pure and covered; what is
/// left here is a stopwatch and no branches, and nothing short of a live
/// allocation would exercise it. Keep it that way — logic that arrives in this
/// file becomes logic nothing can test.
///
/// Mirrors `measureRelay` in `web/src/lib/ice.ts`: a relay-only peer connection
/// with just this relay's servers, timed from `setLocalDescription` to the
/// first `typ relay` candidate. The absolute number carries fixed overhead, but
/// it is the same overhead for every relay, so comparison is valid.
public enum RelayProbe {
    /// Measures the whole pool concurrently, handing each result to `publish`
    /// the moment it lands. Relays that do not answer within `timeout` are
    /// never published, which makes them ineligible.
    ///
    /// Streaming rather than returning a map is the whole point. Draining the
    /// group first meant the caller saw nothing until the SLOWEST relay
    /// finished — so a single silent relay pinned the map at the full 4 s
    /// timeout, while `relayChoiceDeadline` upstream is 800 ms. One
    /// unreachable relay in a pool of six therefore cost every transfer its
    /// entire relay-choice budget and produced nothing for it. Publishing per
    /// probe means a slow relay costs only its own absence.
    ///
    /// `publish` is called from several child tasks at once, so it must be
    /// safe to call concurrently.
    public static func measureAll(_ pool: [RelayEntry],
                                  timeout: TimeInterval = 4,
                                  publish: @escaping @Sendable (String, Int) -> Void) async {
        await withTaskGroup(of: Void.self) { group in
            for entry in pool {
                group.addTask {
                    if let ms = await measure(entry, timeout: timeout) { publish(entry.id, ms) }
                }
            }
        }
    }

    private static func measure(_ entry: RelayEntry, timeout: TimeInterval) async -> Int? {
        ensureRTCSSL()
        let factory = RTCPeerConnectionFactory()
        let config = RTCConfiguration()
        config.iceServers = entry.iceServers.map(rtcServer)
        config.sdpSemantics = .unifiedPlan
        // Relay-only so nothing but the TURN path is being timed.
        config.iceTransportPolicy = .relay

        let delegate = FirstRelayCandidate()
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints,
                                              delegate: delegate) else { return nil }
        defer { pc.close() }

        // A data channel gives the offer an m-line, without which ICE gathers
        // nothing at all and every relay would look unreachable.
        _ = pc.dataChannel(forLabel: "probe", configuration: RTCDataChannelConfiguration())

        let start = Date()
        guard let offer = try? await pc.offer(for: constraints) else { return nil }
        try? await pc.setLocalDescription(offer)
        guard await delegate.wait(timeout: timeout) else { return nil }
        return Int(Date().timeIntervalSince(start) * 1000)
    }
}

/// Resumes once, on the first `typ relay` candidate — or on timeout, whichever
/// comes first.
///
/// Deliberately NOT a `withTaskGroup` racing a continuation-waiting child
/// against a `Task.sleep` child: cancelling the loser after `group.next()`
/// does not resume a raw `withCheckedContinuation`, and `withTaskGroup`
/// implicitly awaits every child at scope exit regardless of cancellation —
/// so on exactly the path this class exists for ("relay never answers"), that
/// shape hangs forever. (Verified with a standalone repro — see the report.)
/// Mirrors `RelayNegotiator.waitForChoice`, which carries the same fix for the
/// same reason: one continuation shared between the candidate callback and a
/// plain timeout `Task`, guarded so only the first of the two resumes it.
private final class FirstRelayCandidate: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Bool, Never>?
    /// Set the first time either side (candidate or timeout) decides the
    /// outcome, so a late arrival on the other side is a no-op instead of a
    /// second `resume`.
    private var result: Bool?

    func wait(timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            lock.lock()
            if let result {
                lock.unlock()
                c.resume(returning: result)
                return
            }
            cont = c
            lock.unlock()
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self.settle(false)
            }
        }
    }

    private func settle(_ value: Bool) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value
        let c = cont
        cont = nil
        lock.unlock()
        c?.resume(returning: value)
    }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard candidate.sdp.contains(" typ relay") else { return }
        settle(true)
    }

    // Unused delegate requirements.
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceConnectionState) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceGatheringState) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
