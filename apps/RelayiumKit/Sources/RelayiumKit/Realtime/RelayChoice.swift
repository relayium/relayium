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
}
