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
    /// Measures the whole pool concurrently, so the wall clock is the slowest
    /// single relay rather than their sum. Relays that do not answer within
    /// `timeout` are absent from the result, which makes them ineligible.
    public static func measureAll(_ pool: [RelayEntry],
                                  timeout: TimeInterval = 4) async -> [String: Int] {
        await withTaskGroup(of: (String, Int?).self) { group in
            for entry in pool {
                group.addTask { (entry.id, await measure(entry, timeout: timeout)) }
            }
            var out: [String: Int] = [:]
            for await (id, ms) in group where ms != nil { out[id] = ms }
            return out
        }
    }

    private static func measure(_ entry: RelayEntry, timeout: TimeInterval) async -> Int? {
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

/// Resumes once, on the first `typ relay` candidate.
private final class FirstRelayCandidate: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Bool, Never>?
    private var fired = false

    func wait(timeout: TimeInterval) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { [self] in
                await withCheckedContinuation { c in
                    lock.lock()
                    if fired { lock.unlock(); c.resume(returning: true); return }
                    cont = c
                    lock.unlock()
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard candidate.sdp.contains(" typ relay") else { return }
        lock.lock()
        let c = cont
        cont = nil
        fired = true
        lock.unlock()
        c?.resume(returning: true)
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
