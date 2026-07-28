import Foundation
import WebRTC
import RelayiumKit

extension RealtimeConnection: RealtimePeerConnection {}

/// Builds a live `RealtimeConnection` for a pairing code.
///
/// This is the async half `RealtimeSessionModel` cannot do itself: connect to
/// signaling, wait for the other device to appear on the code, and only then
/// construct a connection — there is no peer id before that.
public enum RealtimeConnectionFactory {
    public enum FactoryError: Error, Equatable {
        /// Nobody joined the code before the wait ran out.
        case noPeerAppeared
    }

    /// `wss://…` for the same origin the rest of the app talks to.
    public static func signalingBase(_ base: URL) -> URL {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        comps.scheme = (comps.scheme == "http") ? "ws" : "wss"
        return comps.url ?? base
    }

    public static func make(code: String,
                            role: Role,
                            iceServers: [ICEServerConfig],
                            baseURL: URL,
                            deviceName: String,
                            peerTimeout: TimeInterval = 120) async throws -> RealtimePeerConnection {
        let signaling = SignalingClient.connect(wsBase: signalingBase(baseURL),
                                                code: code, name: deviceName)
        let peerId = try await firstPeer(on: signaling, timeout: peerTimeout)
        return RealtimeConnection(signaling: signaling, peerId: peerId, role: role,
                                  iceServers: iceServers.map(rtcServer))
    }

    /// Resumes on the first peer the room reports, and only once — a second
    /// `onPeers` callback must not resume a continuation that already fired.
    /// Internal rather than private so the roster logic can be tested without
    /// a live hub — it is the part with a decision in it.
    static func firstPeer(on signaling: SignalingClient,
                          timeout: TimeInterval) async throws -> String {
        let box = ResumeOnce()
        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { cont in
                    signaling.onPeers = { peers in
                        // The hub sends the WHOLE room roster to every member,
                        // ourselves included (signal/hub.go broadcastRoster), so
                        // the first entry is as likely to be us as the peer. A
                        // sender that dialled its own id got a bare WebRTC
                        // NSError and the "something went wrong" fallback,
                        // immediately, on the very first Create a code.
                        //
                        // Before `welcome` there is no way to tell which entry
                        // is us, so an early roster is skipped rather than
                        // guessed at: another one arrives when a peer joins,
                        // which is the only roster we actually want.
                        guard let mine = signaling.selfId,
                              let other = peers.first(where: { $0.id != mine }) else { return }
                        box.resume { cont.resume(returning: other.id) }
                    }
                    signaling.onClose = {
                        box.resume { cont.resume(throwing: FactoryError.noPeerAppeared) }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw FactoryError.noPeerAppeared
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw FactoryError.noPeerAppeared }
            return first
        }
    }
}

/// A continuation may only be resumed once, and both the peer callback and the
/// close callback can fire. Resuming twice is a crash, not a warning.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func resume(_ body: () -> Void) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { body() }
    }
}

private func rtcServer(_ c: ICEServerConfig) -> RTCIceServer {
    if let user = c.username, let cred = c.credential {
        return RTCIceServer(urlStrings: c.urls, username: user, credential: cred)
    }
    return RTCIceServer(urlStrings: c.urls)
}
