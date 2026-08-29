import Foundation

/// Picks the relay two peers should meet on, from the round-trip times each of
/// them measured.
///
/// Mirrors `pickRelay` in `web/src/lib/ice.ts` decision for decision. The Mac
/// and the browser are routinely each other's peer, so the two implementations
/// have to agree.
///
/// ## What a disagreement actually costs
///
/// It does NOT break the connection. Two peers relaying through different TURN
/// servers still connect: both gather a relay candidate, TURN permissions are
/// IP-scoped and installed by CreatePermission for every remote candidate,
/// there is no NAT between two public TURN servers, and this fleet's coturn
/// config denies only bogon and private ranges, so the pool's own public IPs
/// are permitted. Per-client nearest-relay assignment is how every commercial
/// TURN provider operates.
///
/// What it costs is a second hop, and — the part that matters — roughly 2x
/// metered relay bandwidth, because every byte crosses two of our coturn
/// instances and counts against both the per-node cap and the code owner's
/// quota. So converging still matters; it is a bandwidth-and-latency argument,
/// not a correctness one, and a build that falls back is degraded rather than
/// broken.
///
/// An earlier version of this comment claimed a mismatch "fails looking like a
/// network problem". It does not. No real cross-peer transfer has been run
/// either way, so this is reasoning from the protocol and the fleet's config,
/// not from a measurement.
public enum RelayChoice {
    /// The id minimising the *worse* of the two peers' RTTs, then their sum,
    /// then the id itself.
    ///
    /// Only relays BOTH peers measured are eligible: a relay one side could not
    /// reach is not a candidate however fast it is for the other.
    ///
    /// Pure and symmetric — `pick(a, b) == pick(b, a)`. That is what lets both
    /// peers arrive at the same answer by exchanging data rather than
    /// proposals. The final id comparison is not a cosmetic tie-break: without
    /// it, two peers whose maps tie could return different ids depending on
    /// dictionary iteration order, which is unspecified in Swift.
    public static func pick(mine: [String: Int], theirs: [String: Int]) -> String? {
        var best: String?
        var bestMax = Int.max
        var bestSum = Int.max
        for (id, m) in mine {
            guard let t = theirs[id] else { continue }
            let mx = max(m, t)
            let sum = m + t
            let better = mx < bestMax
                || (mx == bestMax && sum < bestSum)
                || (mx == bestMax && sum == bestSum && (best == nil || id < best!))
            if better {
                best = id
                bestMax = mx
                bestSum = sum
            }
        }
        return best
    }

    /// Whether `selectedID` already beats every relay of ours that is still
    /// being probed — so waiting for the rest of our own measurement cannot
    /// change the answer.
    ///
    /// Mirrors `relayChoiceDominates` in `web/src/lib/ice.ts` decision for
    /// decision; the shared table both sides are checked against lives in
    /// `DOMINANCE_TABLE` there and in `testMatchesTheBrowsersDominanceTable`
    /// here. The two clients pair with each other, so a relay one of them
    /// retires early and the other does not is the same divergence `pick`
    /// exists to prevent.
    ///
    /// ## The two ways a pending relay is retired
    ///
    /// `pick` orders candidates by the WORSE of the two peers' legs, so a
    /// pending relay can only win if its own worst leg lands at or below the
    /// current pick's.
    ///
    /// - **By the peer's leg alone**, with no clock: if `theirs[id]` already
    ///   exceeds the pick's worst leg, so does `max(ours, theirs)` for that
    ///   relay, whatever our probe eventually reports.
    /// - **By elapsed measurement time**, when the caller can supply a
    ///   monotonic reading anchored at or after the instant every still-pending
    ///   probe began timing.
    ///
    /// Strictly greater in both cases, never "or equal": at equality the
    /// pending relay ties on the worst leg and `pick` falls through to the sum
    /// and then to the id, either of which can still hand it the room.
    ///
    /// - Parameter elapsedMs: Milliseconds since an anchor at or after the
    ///   start of every probe missing from `mine`, already converted to
    ///   milliseconds the same way the probe converts its own — or `nil` when no
    ///   such anchor exists, in which case only the peer-leg test may retire a
    ///   pending relay. `RelayNegotiator` supplies one from the instant its
    ///   `Measure` reports every probe started, and `nil` before that — an
    ///   anchor taken any EARLIER than a probe's start would over-estimate the
    ///   one quantity this uses as a lower bound and retire relays that can
    ///   still win, so `nil` is the honest answer rather than a degenerate
    ///   one.
    public static func dominates(selectedID: String?,
                                 mine: [String: Int],
                                 theirs: [String: Int],
                                 poolIDs: [String],
                                 elapsedMs: Int?) -> Bool {
        // Not a common relay, so not something `pick` could have returned and
        // not something a pending probe has to beat.
        guard let id = selectedID, let myLeg = mine[id], let peerLeg = theirs[id] else { return false }
        let worstLeg = max(myLeg, peerLeg)
        let clockRetires = (elapsedMs ?? Int.min) > worstLeg

        for pid in poolIDs {
            if mine[pid] != nil { continue }             // answered — `pick` weighed it
            if let known = theirs[pid], known > worstLeg { continue }
            if clockRetires { continue }
            return false
        }
        return true
    }

    /// The elapsed measurement time at which `dominates` is certain to retire
    /// every unfinished probe, for a pick whose worse leg is `worstLegMs`.
    ///
    /// What a caller would use to schedule the wake-up rather than poll for it.
    /// Mirrors `relayDominanceElapsedMs` in `web/src/lib/ice.ts`: one whole
    /// millisecond past the leg, because the rule is a strict inequality.
    public static func dominanceElapsedMs(worstLegMs: Int) -> Int {
        worstLegMs + 1
    }
}
