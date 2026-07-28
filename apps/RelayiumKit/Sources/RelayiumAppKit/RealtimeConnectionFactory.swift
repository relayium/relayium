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

    /// How long a connection waits for the two peers' relay measurements to
    /// meet before giving up and using the advertised servers.
    ///
    /// 800 ms is a guess. Nobody has measured this fleet's round trips from a
    /// real client, and this constant is the first thing to revisit once
    /// someone has — see the design doc's note.
    public static let relayChoiceDeadline: TimeInterval = 0.8

    public static func make(code: String,
                            role: Role,
                            config: ICEConfig,
                            baseURL: URL,
                            deviceName: String,
                            peerTimeout: TimeInterval = 120) async throws -> RealtimePeerConnection {
        let signaling = SignalingClient.connect(wsBase: signalingBase(baseURL),
                                                code: code, name: deviceName)
        // Start measuring immediately: the sender is about to spend real time
        // waiting for a peer, and that window is free.
        let negotiator = RelayNegotiator(signaling: signaling, pool: config.relays,
                                         measure: { await RelayProbe.measureAll($0) })
        // RelayNegotiator.handleSignal silently drops anything RelayRttMessage
        // can't decode — i.e. every real WebRTC signal. This handler is the
        // only thing installed until RealtimeConnection exists below, and that
        // window is up to relayChoiceDeadline long, not the microseconds it
        // used to be. A peer whose own wait resolves instantly — the web
        // client never blocks on the choice, and any native peer with an empty
        // pool doesn't either — can have its offer or ICE candidates land
        // during that window. So everything is buffered here, in arrival
        // order, and replayed into the real handler once it exists; nothing
        // is decided or discarded at this layer.
        let pending = PendingSignals()
        signaling.onSignal = { from, data in
            negotiator.handleSignal(from: from, data: data)
            pending.append((from, data))
        }
        negotiator.start()

        let peerId = try await firstPeer(on: signaling, timeout: peerTimeout)
        negotiator.peerJoined(peerId)

        let chosen = await negotiator.waitForChoice(deadline: relayChoiceDeadline)
        let servers = (chosen?.iceServers ?? config.iceServers).map(rtcServer)
        // Relay-only only when a relay was actually chosen. Falling back to the
        // advertised set means possibly no relay at all (a LAN room), and
        // forcing .relay there would leave ICE with nothing to gather.
        let policy: RTCIceTransportPolicy = chosen != nil ? .relay : .all
        // Constructed last on purpose: this call takes over signaling.onSignal,
        // which the negotiator needed until now.
        let connection = RealtimeConnection(signaling: signaling, peerId: peerId, role: role,
                                            iceServers: servers, iceTransportPolicy: policy)
        // `signaling.onSignal` is now RealtimeConnection's own handler (wired
        // at the end of its init) — it filters on peerId and hops to its own
        // queue, so replaying a stray relay-RTT message here is a harmless
        // no-op. Nothing needs to be filtered before replaying: everything
        // buffered above goes through, in the order it originally arrived.
        for (from, data) in pending.drain() {
            signaling.onSignal?(from, data)
        }
        return connection
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

/// Queues signals that arrived while the negotiator's handler was the only
/// one installed on `signaling.onSignal`, so `make` can replay them into the
/// real connection once it exists instead of letting them vanish. Locked
/// because `append` runs on whatever queue the WebSocket delivers on, while
/// `drain` runs on the caller's — the same two-thread shape as `ResumeOnce`
/// above.
private final class PendingSignals: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(String, JSONValue)] = []
    func append(_ item: (String, JSONValue)) {
        lock.lock(); items.append(item); lock.unlock()
    }
    func drain() -> [(String, JSONValue)] {
        lock.lock(); defer { lock.unlock() }
        let out = items
        items = []
        return out
    }
}

/// Not `private`: `RelayProbe.measure` needs this exact mapping too, and a
/// second copy of the same three-line branch would just be a second place for
/// the two to drift apart.
func rtcServer(_ c: ICEServerConfig) -> RTCIceServer {
    if let user = c.username, let cred = c.credential {
        return RTCIceServer(urlStrings: c.urls, username: user, credential: cred)
    }
    return RTCIceServer(urlStrings: c.urls)
}
