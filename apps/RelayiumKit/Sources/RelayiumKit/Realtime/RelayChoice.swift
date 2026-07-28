import Foundation

/// Picks the relay two peers should meet on, from the round-trip times each of
/// them measured.
///
/// Mirrors `pickRelay` in `web/src/lib/ice.ts` decision for decision. The Mac
/// and the browser are routinely each other's peer, and a disagreement here
/// does not degrade gracefully: each side allocates on a different relay and
/// the connection fails looking like a network problem.
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
