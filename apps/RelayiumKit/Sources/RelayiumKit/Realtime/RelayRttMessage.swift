import Foundation

/// The relay-RTT map as it travels on the signalling `signal` envelope.
///
/// The shape is fixed by `web/src/App.svelte`'s `broadcastRelayRtt`:
/// `{"relayRtt": {"<relay id>": <milliseconds>}}`. The Mac and the browser are
/// routinely each other's peer, so this is a wire format, not an internal
/// detail.
public enum RelayRttMessage {
    /// The largest round trip anyone may claim, in milliseconds.
    ///
    /// The probe's own timeout is 4 s, so nothing this client measures can come
    /// close; 60 s is well clear of any honest peer, including a browser on a
    /// far worse link. The bound is not about plausibility though — it is what
    /// keeps `Int(_: Double)` from trapping (see `decode`) and what makes
    /// `RelayChoice.pick`'s `m + t` provably unable to overflow.
    public static let maxRttMs = 60_000

    public static func encode(_ rtt: [String: Int]) -> JSONValue {
        .object(["relayRtt": .object(rtt.mapValues { .number(Double($0)) })])
    }

    /// Nil for anything that is not a relay-RTT map.
    ///
    /// Nil rather than an empty map on purpose: the signal channel also carries
    /// SDP, ICE candidates and renames, and an empty map would read as "the
    /// peer measured nothing" and overwrite a good one.
    public static func decode(_ data: JSONValue) -> [String: Int]? {
        guard case let .object(root) = data,
              case let .object(map)? = root["relayRtt"] else { return nil }
        var out: [String: Int] = [:]
        for (id, v) in map {
            // A peer on a newer build may add entries we do not understand.
            // Take the numbers and ignore the rest rather than discarding a map
            // that is mostly usable.
            //
            // The range check is not tidiness. `JSONValue.number` is an
            // unconstrained `Double` straight off the signalling socket, which
            // is untrusted by design — that is why the SAS handshake exists —
            // and `Int(_: Double)` TRAPS rather than saturates outside `Int`'s
            // range. `{"relayRtt":{"a":1e30}}` from a hostile or broken peer
            // would abort the process. NaN and infinity trap the same way.
            guard case let .number(ms) = v,
                  ms.isFinite, ms >= 0, ms <= Double(maxRttMs) else { continue }
            out[id] = Int(ms)
        }
        return out
    }
}
