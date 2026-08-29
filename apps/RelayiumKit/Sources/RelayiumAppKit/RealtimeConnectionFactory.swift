import Foundation
import os
import WebRTC
import RelayiumKit

extension RealtimeConnection: RealtimePeerConnection {}

/// Builds a live `RealtimeConnection` for a pairing code.
///
/// This is the async half `RealtimeSessionModel` cannot do itself: connect to
/// signaling, wait for the other device to appear on the code, and only then
/// construct a connection — there is no peer id before that.
/// The socket for the pairing code this process is currently in, and nothing
/// else.
///
/// The same idiom as `InboundRoom`, for the same reason: a peer id only means
/// something inside the room that issued it, so a builder must be handed THE
/// socket the peer was seen on rather than "whichever one is current". It is a
/// separate holder because the two rooms have separate lifetimes — a code room
/// exists for one code, the inbound room for one unsolicited attempt.
///
/// It holds the socket STRONGLY, and that is what makes the legacy fallback
/// safe: `LinkWorkspaceModel` stops routing the room and hands it over, and the
/// connection built on it needs the socket to outlive the model's own attempt.
/// The app releases it when the owning transfer surface returns to its connect
/// phase.
@MainActor
public final class LinkRoomHandle {
    public internal(set) var signaling: SignalingClient?

    /// **What the handed-over room already heard each peer announce.**
    ///
    /// Handed over WITH the socket, because it is the same fact about the same
    /// room and losing it silently broke the very case the fallback exists for.
    /// `LinkWorkspaceModel.fallBackToLegacy` retires its room, which resets its
    /// registry, and `connectInRoom` then builds a fresh, empty
    /// `PeerCapabilities` and waits five seconds for a `text/1` that has already
    /// been said. Nothing re-says it: a roster hello is sent on a roster EDGE
    /// and this room's roster has not changed, and neither client answers a
    /// hello with a hello — that rule is what keeps two devices from greeting
    /// each other forever. So a peer that correctly announced `text/1` and
    /// nothing else — an older client, or a Web tab in a build without `link/1`
    /// — reached `unsupportedPeer` *because* this side had understood it.
    ///
    /// Scoped exactly like the socket beside it: written when a room is handed
    /// over, cleared when the handle is released, and keyed by a peer id that
    /// means nothing outside the room that issued it.
    public internal(set) var peerAnnouncedCaps: [String: [String]] = [:]

    public init() {}

    /// Close and forget the room, if there is one. Idempotent.
    public func release() {
        signaling?.close()
        signaling = nil
        peerAnnouncedCaps = [:]
    }
}

public enum RealtimeConnectionFactory {
    public enum FactoryError: Error, Equatable {
        /// Nobody joined the code before the wait ran out.
        case noPeerAppeared
        /// The peer did not advertise exact capability text/1. A text offer is
        /// never sent speculatively because an old peer reads it as a file offer.
        case unsupportedPeer
    }

    public enum Mode: Equatable {
        case file
        case text

        var generation: RealtimeGeneration {
            switch self {
            case .file: return .file
            case .text: return .text
            }
        }

        var localCapabilities: [String] {
            switch self {
            case .file: return []
            case .text: return [TEXT_CAPABILITY]
            }
        }
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
    /// Five seconds covers the observed macOS↔browser cycle — about 4.1–4.3
    /// seconds when part of the six-relay pool times out — without falling back
    /// to a random, potentially unreachable legacy TURN.
    ///
    /// That figure was measured when the browser published its map only once its
    /// WHOLE measurement had completed, which is no longer true: `measureRelays`
    /// now reports each relay as it answers, so a peer's fast relays arrive well
    /// inside this budget and only a straggler is still outstanding at the end
    /// of it. The number is therefore headroom rather than a fitted value, and
    /// the per-session log line below is what would justify changing it.
    ///
    /// Shared with the unified `link/1` room, which waits on the same evidence
    /// for the same reason — see `RelaySelection.choiceDeadline`.
    public static let relayChoiceDeadline: TimeInterval = RelaySelection.choiceDeadline

    /// The relay choice is the only thing this package logs, and it is here
    /// because the design's acceptance list asks for it by name: "the chosen
    /// relay id, and both RTT maps, are logged once per session so the relay
    /// deadline can stay grounded in measured values".
    ///
    /// It is also the only way anyone finds out the feature is not working.
    /// Every failure path falls back silently and on purpose, so a pool that
    /// never converges is indistinguishable from one that always does — which
    /// is exactly how a measurement that only completed at the slowest relay's
    /// 4 s timeout survived a review, a plan and an acceptance pass.
    ///
    /// Read it with:
    ///     log stream --predicate 'subsystem == "com.relayium"' --info
    ///
    /// Subsystem is the product rather than a bundle id because this target is
    /// shared with the iOS app. Everything interpolated is `.public`: relay
    /// ids are fleet infrastructure and RTTs are network timings, neither of
    /// them user data. The pairing code and the peer id are deliberately not
    /// here.
    private static let log = Logger(subsystem: "com.relayium", category: "relay")

    /// Sorted, because Swift's dictionary order is unspecified and a log line
    /// that reorders itself between sessions cannot be diffed or grepped.
    private static func describe(_ rtt: [String: Int]) -> String {
        rtt.isEmpty ? "-" : rtt.sorted { $0.key < $1.key }
                               .map { "\($0.key)=\($0.value)" }
                               .joined(separator: ",")
    }

    /// Cross-network code rooms must not spend the ICE timeout trying direct
    /// candidates before using the TURN credentials they were issued. This is
    /// the native equivalent of the web client's `hasTurnServer` check.
    ///
    /// Forwarded to `RelaySelection` rather than re-implemented: the unified
    /// `link/1` path resolves the same question about the same config, and two
    /// copies of "does this relay" are two things that can disagree about
    /// whether a room may spend an ICE timeout on direct candidates.
    private static func hasTURN(_ servers: [ICEServerConfig]) -> Bool {
        RelaySelection.hasTURN(servers)
    }

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
                                   _ relayOnly: Bool,
                                   _ generation: RealtimeGeneration,
                                   _ localCapabilities: [String]) -> RealtimePeerConnection

    /// The real one. The only place WebRTC's types enter this file's flow.
    static let liveConnection: ConnectionBuilder = {
        signaling, peerId, role, servers, relayOnly, generation, localCapabilities in
        RealtimeConnection(signaling: signaling, peerId: peerId, role: role,
                           iceServers: servers.map(rtcServer),
                           iceTransportPolicy: relayOnly ? .relay : .all,
                           generation: generation,
                           localCapabilities: localCapabilities)
    }

    /// Unchanged for callers: `AppEnvironment` still calls exactly this.
    /// Everything injectable is bound here, to the real thing.
    public static func make(code: String,
                            role: Role,
                            config: ICEConfig,
                            baseURL: URL,
                            deviceName: String,
                            mode: Mode = .file,
                            peerTimeout: TimeInterval = 120) async throws -> RealtimePeerConnection {
        try await make(role: role,
                       config: config,
                       signaling: SignalingClient.connect(wsBase: signalingBase(baseURL),
                                                          code: code, name: deviceName),
                       peerTimeout: peerTimeout,
                       choiceDeadline: relayChoiceDeadline,
                       measure: { pool, sink in
                           await RelayProbe.measureAll(pool, sink: sink)
                       },
                       mode: mode,
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
                     mode: Mode = .file,
                     build: ConnectionBuilder) async throws -> RealtimePeerConnection {
        // Start measuring immediately: the sender is about to spend real time
        // waiting for a peer, and that window is free.
        let negotiator = RelayNegotiator(signaling: signaling, pool: config.relays,
                                         measure: measure)
        // RelayNegotiator.handleSignal silently drops anything RelayRttMessage
        // can't decode — i.e. every real WebRTC signal. This handler is the
        // only thing installed until RealtimeConnection exists below, and the
        // window is the whole span from here to there: the firstPeer wait plus
        // the relay-choice wait, so up to peerTimeout (120 s) + 5 s, not
        // the 5 s alone. Both halves are real. A peer can join the room and
        // send its offer before its own roster callback has resolved ours, and
        // a peer whose relay wait resolves instantly — the web client never
        // blocks on the choice, and neither does a native peer with an empty
        // pool — sends with no delay at all. So everything is buffered here,
        // in arrival order, and replayed into the real handler once it exists;
        // nothing is decided or discarded at this layer.
        let pending = PendingSignals()
        let capabilities = PeerCapabilities()
        // Tokenised like every other claim on this slot, so the ordering below
        // is enforced rather than merely intended: `build` supersedes this
        // handler, and nothing here can clear the connection's.
        let temporarySlot = signaling.installSignalHandler { from, data in
            negotiator.handleSignal(from: from, data: data)
            capabilities.record(peerId: from, signal: data)
            pending.append((from, data))
        }
        // Every exit that is not "a connection took over" has to undo the two
        // things installing that handler did, and neither undoes itself:
        //
        // * The closure retains `negotiator`, which retains `signaling`, which
        //   holds the closure — a cycle. Nothing below drops it on a throw, so
        //   `SignalingClient.deinit` (and with it `channel.close()`) never ran:
        //   the WebSocket for a `make` that timed out waiting for a peer stayed
        //   open for the life of the process, once per failed attempt.
        // * This entry point OWNS its socket — it built it with
        //   `SignalingClient.connect` — so on failure it is this function's job
        //   to close it. `connectNearby` deliberately does the opposite, because
        //   there the socket belongs to the discovery model.
        //
        // Ownership-safe: `removeSignalHandler` is a no-op once `build` has
        // superseded this claim, so a late failure can never unhook a live
        // connection's handler.
        var connectionTookOver = false
        defer {
            if !connectionTookOver {
                signaling.removeSignalHandler(temporarySlot)
                signaling.close()
            }
        }
        negotiator.start()

        let peerId = try await firstPeer(
            on: signaling,
            timeout: peerTimeout,
            onPeer: { peerId in
                guard !mode.localCapabilities.isEmpty else { return }
                signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
            }
        )
        if mode == .text {
            // The roster callback and the far side's capability subscription
            // can cross during room join. Repeat a small, bounded number of
            // one-way hellos; never reply to an inbound hello, so this cannot
            // form a ping-pong loop. A final hello after observing support
            // confirms our side to a peer whose first subscription was late.
            let capabilityRetry = Task {
                for delay: UInt64 in [250_000_000, 1_000_000_000] {
                    try? await Task.sleep(nanoseconds: delay)
                    guard !Task.isCancelled else { return }
                    signaling.sendSignal(
                        to: peerId,
                        data: capsField(mode.localCapabilities)
                    )
                }
            }
            let supported = await waitForCapability(
                "text/1",
                peerId: peerId,
                in: capabilities,
                timeout: min(peerTimeout, 5)
            )
            capabilityRetry.cancel()
            // The `defer` above closes the socket, so this path no longer does
            // it itself — a second `close()` would fire `onClose` twice.
            guard supported else { throw FactoryError.unsupportedPeer }
            signaling.sendSignal(
                to: peerId,
                data: capsField(mode.localCapabilities)
            )
        }
        negotiator.peerJoined(peerId)

        let waitBegan = Date()
        let chosen = await negotiator.waitForChoice(deadline: choiceDeadline)
        // `waited` is the number relayChoiceDeadline is waiting on: how long
        // convergence actually took on a real pair of clients. But `waited`
        // conflates two different waits, and they call for opposite fixes:
        // time spent waiting for the PEER to arrive says nothing about
        // relayChoiceDeadline, while time spent waiting on OUR OWN probes says
        // everything. `measured` is the second of those on its own — the span
        // from `negotiator.start()` to our own measurement finishing — so the
        // two together say which one this session's `waited` was actually
        // measuring.
        //
        // `measured` is "unfinished" rather than a number when our own
        // measurement had not completed before the wait ended: logging 5s
        // (or whatever the deadline was) as if it were our probe time would
        // read as "measurement takes about this long", when the true story is
        // "a straggler relay was still outstanding and the deadline cut it
        // off" — the one case relayChoiceDeadline should be raised for, not
        // the one to average in with the rest.
        //
        // `chosen=none` with a full `mine` and an empty `theirs` is an older or
        // browser peer; `none` with both full is a pool with nothing in
        // common; `none` with `mine` short is measurement losing the race,
        // which is what to look for first.
        let maps = negotiator.maps()
        let measuredMs = negotiator.measuredMs()
        log.notice("""
                   relay choice chosen=\(chosen?.id ?? "none", privacy: .public) \
                   waited=\(Int(Date().timeIntervalSince(waitBegan) * 1000), privacy: .public)ms \
                   measured=\(measuredMs.map { "\($0)ms" } ?? "unfinished", privacy: .public) \
                   deadline=\(Int(choiceDeadline * 1000), privacy: .public)ms \
                   pool=\(config.relays.count, privacy: .public) \
                   mine=[\(describe(maps.mine), privacy: .public)] \
                   theirs=[\(describe(maps.theirs), privacy: .public)]
                   """)
        // A chosen pool entry is always TURN. The advertised fallback can be
        // either TURN (a cross-network code room) or STUN-only (LAN), so match
        // the web client: force relay-only whenever the actual server set
        // contains TURN, but leave STUN-only fallback on `.all`.
        //
        // Constructed last on purpose: this call takes over signaling.onSignal,
        // which the negotiator needed until now. Hoisting it above the wait
        // would disable the whole feature with no error and no test failure —
        // which is why `build` is a seam, and why
        // RealtimeConnectionFactoryTests pins this ordering by asserting on
        // which servers arrive here.
        //
        // `RelaySelection.resolve` rather than `chosen?.iceServers ??
        // config.iceServers`: without a choice the pool is FOLDED IN rather than
        // discarded. An account with "only my nodes" set is issued no top-level
        // TURN at all, so the old fallback handed a cross-network peer a
        // STUN-only list and the failure read as a network problem.
        let resolved = RelaySelection.resolve(config, chosen: chosen?.id)
        let connection = build(signaling, peerId, role,
                               resolved.servers,
                               resolved.relayOnly,
                               mode.generation,
                               mode.localCapabilities)
        // `signaling.onSignal` is now RealtimeConnection's own handler (wired
        // at the end of its init) — it filters on peerId and hops to its own
        // queue, so replaying a stray relay-RTT message here is a harmless
        // no-op. Nothing needs to be filtered before replaying: everything
        // buffered above goes through, in the order it originally arrived.
        connectionTookOver = true
        for (from, data) in pending.drain() {
            signaling.onSignal?(from, data)
        }
        return connection
    }

    // MARK: - same-network (no pairing code)

    /// Builds a connection to a device the user picked out of the code-less
    /// room's roster.
    ///
    /// Differs from `make` in the three ways that matter, and each of them is
    /// the reason this is a separate entry point rather than a flag:
    ///
    /// * There is no `firstPeer` wait. The code-less room is keyed by the
    ///   server-observed public IP and can hold more than two members, so
    ///   "whoever is not me" is not an answer — the peer id comes from an
    ///   explicit choice the user made against a roster they saw.
    /// * The socket belongs to the discovery model and outlives this call, so
    ///   nothing here closes it. `make` owns its socket and does.
    /// * The room has no pairing code, so there are no TURN credentials to
    ///   have and no relay pool to choose from. `nearbyICEServers` keeps only
    ///   STUN, so even a server that answered a code-less `/api/ice` with
    ///   relay credentials could not spend anybody's relay quota from here.
    public static func connectNearby(signaling: SignalingClient,
                                     peerId: String,
                                     role: Role,
                                     config: ICEConfig,
                                     mode: Mode = .file,
                                     capabilityTimeout: TimeInterval = 5)
        async throws -> RealtimePeerConnection {
        try await connectNearby(signaling: signaling,
                                peerId: peerId,
                                role: role,
                                config: config,
                                mode: mode,
                                capabilityTimeout: capabilityTimeout,
                                build: liveConnection)
    }

    /// The same seam `make` has, for the same reason: everything above the
    /// peer connection is testable, the peer connection itself is not.
    static func connectNearby(signaling: SignalingClient,
                              peerId: String,
                              role: Role,
                              config: ICEConfig,
                              mode: Mode,
                              capabilityTimeout: TimeInterval,
                              build: ConnectionBuilder) async throws -> RealtimePeerConnection {
        // Defensive: the discovery model only ever hands over an id it just
        // listed, but an empty id would reach WebRTC as a dial to nobody and
        // surface as a bare NSError.
        guard !peerId.isEmpty else { throw FactoryError.noPeerAppeared }

        // Same buffer-and-replay as `make`: the chosen peer can answer our
        // capability hello — or send its own SDP — before the connection
        // object below exists, and a dropped offer stalls the session with no
        // error at all.
        let pending = PendingSignals()
        let capabilities = PeerCapabilities()
        // Tokenised: this socket is the discovery model's shared roster feed, so
        // the failure path below must give back only *this* claim. A bare
        // `onSignal = nil` there would also delete the handler of a connection
        // that had since been built on the same socket.
        let temporarySlot = signaling.installSignalHandler { from, data in
            capabilities.record(peerId: from, signal: data)
            pending.append((from, data))
        }
        // Same shape as `make`, minus the close: this socket is the discovery
        // model's roster feed and the user is expected to pick another device on
        // it, so a failed attempt must leave the room joined. Only the claim on
        // the slot is given back, and only if it is still ours.
        var connectionTookOver = false
        defer {
            if !connectionTookOver { signaling.removeSignalHandler(temporarySlot) }
        }

        if mode == .text {
            signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
            // Bounded one-way retries, never a reply to an inbound hello, so
            // this cannot become a ping-pong. Same shape as `make`.
            let capabilityRetry = Task {
                for delay: UInt64 in [250_000_000, 1_000_000_000] {
                    try? await Task.sleep(nanoseconds: delay)
                    guard !Task.isCancelled else { return }
                    signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
                }
            }
            let supported = await waitForCapability("text/1",
                                                    peerId: peerId,
                                                    in: capabilities,
                                                    timeout: capabilityTimeout)
            capabilityRetry.cancel()
            // Unhooked by the `defer` above, and deliberately NOT closed.
            guard supported else { throw FactoryError.unsupportedPeer }
            signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
        }

        let connection = build(signaling, peerId, role,
                               nearbyICEServers(config.iceServers),
                               false,        // never relay-only: STUN-only, host candidates are the point
                               mode.generation,
                               mode.localCapabilities)
        connectionTookOver = true
        for (from, data) in pending.drain() {
            signaling.onSignal?(from, data)
        }
        return connection
    }

    // MARK: - a room somebody else already owns

    /// Build a LEGACY connection on a socket this process already holds for a
    /// pairing code.
    ///
    /// ## Why this exists
    ///
    /// `make` above opens its own socket, waits for a peer and builds a
    /// connection, all in one call. That is the right shape when nothing else is
    /// in the room — and the wrong one the moment `link/1` is in play, because
    /// then something already IS: `LinkPairingRoom` owns the code's socket so a
    /// link can live on it, and it has to be able to hand that socket to the
    /// legacy path when the peer turns out not to speak `link/1`.
    ///
    /// The alternative — closing the link's socket and letting `make` open a
    /// second one — breaks the peer, and not subtly. A legacy creator resolves
    /// `firstPeer` on the id we joined with and offers to it; leaving and
    /// rejoining earns a NEW id, so that offer goes to nobody and the peer waits
    /// out its own timeout with no error to show. One socket, handed over, is
    /// what makes the fallback invisible to the other side.
    ///
    /// ## What differs from `connectNearby`
    ///
    /// Exactly two things, and both are about the room rather than the shape:
    ///
    ///  - **The ICE configuration is used as issued.** `nearbyICEServers` exists
    ///    to strip TURN from a code-less room, where there is no code to bill
    ///    relayed bytes to. A pairing code IS that authorisation, so its
    ///    credentials travel.
    ///  - **Relay-only when a relay was issued**, which is the same rule `make`
    ///    applies: a cross-network room must not spend the ICE timeout trying
    ///    direct candidates it will not get.
    ///
    /// Everything else is `connectNearby`'s, deliberately: the buffer-and-replay
    /// across the construction window, the tokenised slot claim that gives back
    /// only this attempt's handler, the bounded one-way capability retries in
    /// text mode, and the refusal to close a socket this call does not own.
    /// - Parameter knownPeerCaps: what the room this call inherits already heard
    ///   this peer announce. See `LinkRoomHandle.peerAnnouncedCaps`: without it
    ///   a legacy fallback re-asks a question that has been answered and that
    ///   nothing will answer twice.
    public static func connectInRoom(signaling: SignalingClient,
                                     peerId: String,
                                     role: Role,
                                     config: ICEConfig,
                                     mode: Mode = .file,
                                     capabilityTimeout: TimeInterval = 5,
                                     knownPeerCaps: [String] = [])
        async throws -> RealtimePeerConnection {
        try await connectInRoom(signaling: signaling, peerId: peerId, role: role,
                                config: config, mode: mode,
                                capabilityTimeout: capabilityTimeout,
                                knownPeerCaps: knownPeerCaps,
                                build: liveConnection)
    }

    /// The same seam the other entry points have, for the same reason.
    static func connectInRoom(signaling: SignalingClient,
                              peerId: String,
                              role: Role,
                              config: ICEConfig,
                              mode: Mode,
                              capabilityTimeout: TimeInterval,
                              knownPeerCaps: [String] = [],
                              build: ConnectionBuilder) async throws -> RealtimePeerConnection {
        guard !peerId.isEmpty else { throw FactoryError.noPeerAppeared }

        let pending = PendingSignals()
        let capabilities = PeerCapabilities()
        // Seeded BEFORE the handler is installed, so the wait below can be
        // satisfied by evidence this process already has rather than only by a
        // frame that may never be sent again. It is recorded through the same
        // `record` every live hello takes, so a seed cannot mean anything a
        // hello could not have meant — and a later real hello still replaces it,
        // because an announcement is a snapshot rather than an additive grant.
        if !knownPeerCaps.isEmpty {
            capabilities.record(peerId: peerId, signal: capsField(knownPeerCaps))
        }
        let temporarySlot = signaling.installSignalHandler { from, data in
            capabilities.record(peerId: from, signal: data)
            pending.append((from, data))
        }
        // The socket belongs to the room, not to this call: a failed attempt
        // must leave it joined, exactly as `connectNearby` leaves the discovery
        // model's. Only this attempt's claim on the slot is given back.
        var connectionTookOver = false
        defer {
            if !connectionTookOver { signaling.removeSignalHandler(temporarySlot) }
        }

        if mode == .text {
            signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
            let capabilityRetry = Task {
                for delay: UInt64 in [250_000_000, 1_000_000_000] {
                    try? await Task.sleep(nanoseconds: delay)
                    guard !Task.isCancelled else { return }
                    signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
                }
            }
            let supported = await waitForCapability(TEXT_CAPABILITY,
                                                    peerId: peerId,
                                                    in: capabilities,
                                                    timeout: capabilityTimeout)
            capabilityRetry.cancel()
            guard supported else { throw FactoryError.unsupportedPeer }
            signaling.sendSignal(to: peerId, data: capsField(mode.localCapabilities))
        }

        // Same fold-in as `make`, and it matters more here: this is the path a
        // `link/1` room hands over to when the peer turns out to be legacy, and
        // it runs no measurement at all. Without the pool, a pool-only account
        // reaches a legacy cross-network session with nothing that can relay.
        let resolved = RelaySelection.resolve(config, chosen: nil)
        let connection = build(signaling, peerId, role,
                               resolved.servers,
                               resolved.relayOnly,
                               mode.generation,
                               mode.localCapabilities)
        connectionTookOver = true
        for (from, data) in pending.drain() {
            signaling.onSignal?(from, data)
        }
        return connection
    }

    // MARK: - same-network (inbound, unsolicited)

    /// Builds the responder for an offer this Mac did not ask for.
    ///
    /// Deliberately the *smallest* of the three entry points, and synchronous:
    /// everything `connectNearby` spends time on has already happened by the
    /// time an offer lands.
    ///
    /// * There is no peer to wait for — the offer names it (`from`).
    /// * There is no capability handshake — a text offer carries `text/1`
    ///   alongside its SDP or it is not a text offer at all
    ///   (`inboundOfferGeneration`), and this side's answer carries ours.
    /// * There is no buffering here. The caller — the persistent router that
    ///   classified the offer — has been buffering since before this call, and
    ///   replays into `signaling.onSignal` once this returns. A second buffer
    ///   installed here would capture the same live frames the router is already
    ///   capturing and deliver every one of them twice.
    ///
    /// What it keeps from `connectNearby` is what the security boundary is made
    /// of: the roster socket is reused rather than reconnected, no code is
    /// minted or joined, and `nearbyICEServers` drops every TURN URL and
    /// credential so an inbound session cannot spend relay quota either.
    public static func acceptNearby(signaling: SignalingClient,
                                    peerId: String,
                                    config: ICEConfig,
                                    mode: Mode = .file) throws -> RealtimePeerConnection {
        try acceptNearby(signaling: signaling, peerId: peerId, config: config,
                         mode: mode, build: liveConnection)
    }

    /// The same seam the other two entry points have, for the same reason.
    static func acceptNearby(signaling: SignalingClient,
                             peerId: String,
                             config: ICEConfig,
                             mode: Mode,
                             build: ConnectionBuilder) throws -> RealtimePeerConnection {
        // An offer whose `from` is empty is not a peer; it would reach WebRTC as
        // a dial to nobody and surface as a bare NSError.
        guard !peerId.isEmpty else { throw FactoryError.noPeerAppeared }
        return build(signaling, peerId, .responder,
                     nearbyICEServers(config.iceServers),
                     false,        // never relay-only: STUN-only, host candidates are the point
                     mode.generation,
                     mode.localCapabilities)
    }

    /// STUN only, credentials dropped.
    ///
    /// A code-less `/api/ice` is STUN-only by construction today
    /// (`server/account/turn.go` gates every relay branch on a valid code), so
    /// on the happy path this changes nothing. It exists so that the
    /// same-network path cannot start consuming relay bandwidth because a
    /// server-side change made that response fatter — the guarantee is a
    /// property of the client, not a promise about the server.
    static func nearbyICEServers(_ servers: [ICEServerConfig]) -> [ICEServerConfig] {
        servers.compactMap { server in
            let stun = server.urls.filter {
                let url = $0.lowercased()
                return url.hasPrefix("stun:") || url.hasPrefix("stuns:")
            }
            guard !stun.isEmpty else { return nil }
            // Credentials only ever authenticate to TURN; carrying them past
            // here would be the one way a nearby connection could use a relay.
            return ICEServerConfig(urls: stun)
        }
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
                          timeout: TimeInterval,
                          onPeer: @escaping (String) -> Void = { _ in }) async throws -> String {
        let box = ResumeOnce()
        // The wait borrows two of the client's callback slots; when it ends they
        // go back. Not tidiness — a leak. Both closures are stored ON
        // `signaling`, and they capture whatever the caller handed in:
        // `make`'s `onPeer` captures `signaling` strongly to send its capability
        // hello. Leaving them installed is therefore a cycle that survives every
        // exit from `make`, so the client is never deallocated, its `deinit`
        // never runs, and the WebSocket it owns stays open for the life of the
        // process — once per call, on success as well as on failure.
        //
        // Weak-capturing inside these closures cannot fix that: the strong
        // reference is in the caller's closure, not this one.
        defer {
            signaling.onPeers = nil
            signaling.onClose = nil
        }
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
                box.resume {
                    onPeer(other.id)
                    cont.resume(returning: other.id)
                }
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

    /// Waits for an exact roster-level capability without blocking the
    /// signalling callback queue. The bounded polling interval is deliberately
    /// tiny compared with WebRTC setup and exists only around a lock-protected
    /// in-memory hint; it sends no traffic.
    static func waitForCapability(_ capability: String,
                                  peerId: String,
                                  in capabilities: PeerCapabilities,
                                  timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(max(0, timeout))
        while Date() < deadline {
            if capabilities.supports(capability, peerId: peerId) { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return capabilities.supports(capability, peerId: peerId)
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

/// Exact capability hints observed during the factory's pending-signal window.
/// Hints are never authentication input; they only prevent sending an
/// unsupported wire kind to an older peer.
final class PeerCapabilities: @unchecked Sendable {
    private let lock = NSLock()
    private var byPeer: [String: Set<String>] = [:]

    func record(peerId: String, signal: JSONValue) {
        guard case let .object(fields) = signal,
              case let .array(items)? = fields["caps"] else { return }
        let caps = items.compactMap { item -> String? in
            if case let .string(value) = item { return value }
            return nil
        }
        lock.lock()
        // A capability hello is a snapshot, not an additive grant. In
        // particular, an empty later hello must revoke an earlier text/1
        // announcement just as the web capability roster does.
        byPeer[peerId] = Set(caps)
        lock.unlock()
    }

    func supports(_ capability: String, peerId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return byPeer[peerId]?.contains(capability) == true
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
