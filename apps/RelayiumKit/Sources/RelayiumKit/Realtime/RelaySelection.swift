import Foundation

/// Turns an `/api/ice` response plus an agreed relay id into the exact server
/// list and transport policy a connection must be built with.
///
/// Mirrors `chooseRtcConfig` in `web/src/lib/ice.ts` decision for decision, for
/// the same reason `RelayChoice` mirrors `pickRelay`: the Mac and the browser
/// are routinely each other's peer, and a client that resolves the same config
/// differently converges on a different relay — or, in the case this was
/// extracted to fix, on no relay at all.
///
/// ## The defect it exists to close
///
/// Every caller used to write `chosen?.iceServers ?? config.iceServers`, which
/// silently assumes the top-level list is a usable fallback. It is not, for two
/// deployments that both ship today:
///
///  - an account with "only my nodes" set is issued its relays in `relays` and
///    **no** top-level TURN, so the fallback was STUN-only — a cross-network
///    peer got host/srflx candidates that cannot cross CGNAT, and the failure
///    looked like a network problem rather than a configuration one;
///  - a pool deployment whose top-level entry is one arbitrary legacy relay
///    threw away the whole measured pool the moment a choice was unavailable.
///
/// So a missing choice folds the pool in instead of discarding it. Measurement
/// is an optimisation; having a relay at all is not.
public enum RelaySelection {

    /// How many pool relays the no-selection fallback folds in.
    ///
    /// Each entry costs one TURN allocation during ICE — bytes are only relayed
    /// on the pair that is actually nominated — so this bounds what a hostile or
    /// broken `/api/ice` response can make a client do. It must stay ABOVE a
    /// real pool or the cap would drop the one relay that works: production
    /// advertises five today, so eight is headroom rather than a ceiling that
    /// bites. Same number, and same reasoning, as `MAX_FALLBACK_RELAYS` in
    /// `web/src/lib/ice.ts`.
    public static let maxFallbackRelays = 8

    /// How long a room waits for a PEER's relay map before building on the
    /// fallback instead.
    ///
    /// Counted from the moment a peer exists, not from the moment the room
    /// starts measuring. The distinction is the whole of it on the `link/1`
    /// path: a code room measures at join and then routinely sits alone for
    /// minutes while the other person types the code, so a deadline armed at
    /// join has long expired by the time that peer announces — and the gate is
    /// then open, with no peer map behind it, for exactly the first legal frame
    /// it existed to hold. `LinkWorkspaceModel` arms it per peer and cancels it
    /// on departure; a later peer gets a full fresh one.
    ///
    /// On the legacy `RealtimeConnectionFactory` path the two readings coincide:
    /// that path is only entered with a peer already in hand.
    ///
    /// Five seconds is what `RealtimeConnectionFactory.relayChoiceDeadline`
    /// already used, kept here so the unified path and the legacy path cannot
    /// drift apart. Same value, and same reasoning, as `RELAY_GATE_MS` in
    /// `web/src/lib/relay-selection.ts`.
    public static let choiceDeadline: TimeInterval = 5

    /// What one connection is actually built with.
    public struct Resolved: Equatable {
        public let servers: [ICEServerConfig]
        /// `.relay` rather than `.all`. True whenever the resolved list contains
        /// TURN: on a cross-network path the direct candidates are going to fail
        /// anyway and waiting out their checks costs about twenty seconds before
        /// ICE reaches the relay it would have used. A STUN-only list — every
        /// same-network room, and a code the server issued no credential for —
        /// stays `.all` so host candidates still work.
        public let relayOnly: Bool

        public init(servers: [ICEServerConfig], relayOnly: Bool) {
            self.servers = servers
            self.relayOnly = relayOnly
        }
    }

    /// Whether any of these servers can actually relay.
    public static func hasTURN(_ servers: [ICEServerConfig]) -> Bool {
        servers.contains { server in
            server.urls.contains { url in
                let scheme = url.lowercased()
                return scheme.hasPrefix("turn:") || scheme.hasPrefix("turns:")
            }
        }
    }

    /// The servers and policy for `config`, given the relay the two peers agreed
    /// on — or nil when they have not agreed on one.
    ///
    /// A `chosen` id that is not in THIS config's pool resolves as if nothing had
    /// been chosen. That is not defensive tidiness: the id is peer-influenced
    /// input and the pool is per pairing code, so an id carried across a room
    /// switch must never select a credential from the room it was measured in.
    public static func resolve(_ config: ICEConfig, chosen: String?) -> Resolved {
        if let chosen, let picked = config.relays.first(where: { $0.id == chosen }) {
            return Resolved(servers: picked.iceServers, relayOnly: true)
        }
        var merged = config.iceServers
        for relay in config.relays.prefix(maxFallbackRelays) {
            merged.append(contentsOf: relay.iceServers)
        }
        return Resolved(servers: merged, relayOnly: hasTURN(merged))
    }
}
