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

    /// The last step of `make`: turn a settled relay choice into a live
    /// connection. Injected, because everything *above* it — the ordering, the
    /// fallback, the buffer-and-replay — is the part that has repeatedly been
    /// wrong, and none of it could be tested while the step itself needed
    /// WebRTC and two real peers.
    ///
    /// Deliberately takes `[ICEServerConfig]` and a `relayOnly` flag rather
    /// than WebRTC's own types, so a test can assert on what was decided
    /// without linking a peer connection.
    typealias ConnectionBuilder = (_ signaling: SignalingClient,
                                   _ peerId: String,
                                   _ role: Role,
                                   _ iceServers: [ICEServerConfig],
                                   _ relayOnly: Bool) -> RealtimePeerConnection

    /// The real one. The only place WebRTC's types enter this file's flow.
    static let liveConnection: ConnectionBuilder = { signaling, peerId, role, servers, relayOnly in
        RealtimeConnection(signaling: signaling, peerId: peerId, role: role,
                           iceServers: servers.map(rtcServer),
                           iceTransportPolicy: relayOnly ? .relay : .all)
    }

    /// Unchanged for callers: `AppEnvironment` still calls exactly this.
    /// Everything injectable is bound here, to the real thing.
    public static func make(code: String,
                            role: Role,
                            config: ICEConfig,
                            baseURL: URL,
                            deviceName: String,
                            peerTimeout: TimeInterval = 120) async throws -> RealtimePeerConnection {
        try await make(role: role,
                       config: config,
                       signaling: SignalingClient.connect(wsBase: signalingBase(baseURL),
                                                          code: code, name: deviceName),
                       peerTimeout: peerTimeout,
                       choiceDeadline: relayChoiceDeadline,
                       measure: { pool, publish in
                           await RelayProbe.measureAll(pool, publish: publish)
                       },
                       build: liveConnection)
    }

    /// The orchestration, with the three things a test cannot supply for real
    /// — the socket, the probes, the peer connection — handed in.
    ///
    /// Internal rather than public: the seam exists for this package's tests,
    /// not as API. `make` above is the whole public surface and its signature
    /// has not moved.
    static func make(role: Role,
                     config: ICEConfig,
                     signaling: SignalingClient,
                     peerTimeout: TimeInterval,
                     choiceDeadline: TimeInterval,
                     measure: @escaping RelayNegotiator.Measure,
                     build: ConnectionBuilder) async throws -> RealtimePeerConnection {
        // Start measuring immediately: the sender is about to spend real time
        // waiting for a peer, and that window is free.
        let negotiator = RelayNegotiator(signaling: signaling, pool: config.relays,
                                         measure: measure)
        // RelayNegotiator.handleSignal silently drops anything RelayRttMessage
        // can't decode — i.e. every real WebRTC signal. This handler is the
        // only thing installed until RealtimeConnection exists below, and the
        // window is the whole span from here to there: the firstPeer wait plus
        // the relay-choice wait, so up to peerTimeout (120 s) + 800 ms, not
        // the 800 ms alone. Both halves are real. A peer can join the room and
        // send its offer before its own roster callback has resolved ours, and
        // a peer whose relay wait resolves instantly — the web client never
        // blocks on the choice, and neither does a native peer with an empty
        // pool — sends with no delay at all. So everything is buffered here,
        // in arrival order, and replayed into the real handler once it exists;
        // nothing is decided or discarded at this layer.
        let pending = PendingSignals()
        signaling.onSignal = { from, data in
            negotiator.handleSignal(from: from, data: data)
            pending.append((from, data))
        }
        negotiator.start()

        let peerId = try await firstPeer(on: signaling, timeout: peerTimeout)
        negotiator.peerJoined(peerId)

        let chosen = await negotiator.waitForChoice(deadline: choiceDeadline)
        // Relay-only only when a relay was actually chosen. Falling back to the
        // advertised set means possibly no relay at all (a LAN room), and
        // forcing .relay there would leave ICE with nothing to gather.
        //
        // Constructed last on purpose: this call takes over signaling.onSignal,
        // which the negotiator needed until now. Hoisting it above the wait
        // would disable the whole feature with no error and no test failure —
        // which is why `build` is a seam, and why
        // RealtimeConnectionFactoryTests pins this ordering by asserting on
        // which servers arrive here.
        let connection = build(signaling, peerId, role,
                               chosen?.iceServers ?? config.iceServers,
                               chosen != nil)
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
    ///
    /// Deliberately NOT a `withThrowingTaskGroup` racing a
    /// continuation-waiting child against a `Task.sleep` child: when the
    /// timeout child throws, the group cancels the other child and then still
    /// awaits it at scope exit — and cancellation cannot resume a raw
    /// `withCheckedThrowingContinuation`. So on exactly the path the timeout
    /// exists for, `peerTimeout` never surfaced as `noPeerAppeared` and the
    /// call hung until `signaling.onClose` happened to fire. One continuation
    /// shared by the roster callback, the close callback and a plain timeout
    /// `Task`, guarded so only the first of the three resumes it — the same
    /// shape as `RelayNegotiator.waitForChoice` and `RelayProbe`'s
    /// `FirstRelayCandidate`, which carry this fix for the same reason.
    static func firstPeer(on signaling: SignalingClient,
                          timeout: TimeInterval) async throws -> String {
        let box = ResumeOnce()
        return try await withCheckedThrowingContinuation { cont in
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
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                box.resume { cont.resume(throwing: FactoryError.noPeerAppeared) }
            }
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
///
/// Internal rather than private so the cap can be tested directly — it is the
/// one thing in here with a decision in it.
final class PendingSignals: @unchecked Sendable {
    /// Anyone holding the pairing code can push signals at us for the whole
    /// buffering window, which runs to peerTimeout + the relay wait — around
    /// two minutes. An unbounded queue there is a way to spend our memory from
    /// the other end of a WebSocket, on the same untrusted-peer footing as the
    /// relay-RTT numbers in `RelayRttMessage.decode`.
    ///
    /// 256 is far above anything a real session produces. An offer or answer
    /// is one signal and ICE candidates are a handful; a WebRTC peer that
    /// needed hundreds queued *before* its connection object even exists is
    /// not a peer this build is going to talk to.
    static let capacity = 256

    private let lock = NSLock()
    private var items: [(String, JSONValue)] = []

    /// Drops on overflow rather than evicting: the signals worth having are
    /// the earliest ones — the offer, then the first candidates — and a flood
    /// arriving behind them is exactly what must not push them out.
    func append(_ item: (String, JSONValue)) {
        lock.lock()
        if items.count < Self.capacity { items.append(item) }
        lock.unlock()
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
