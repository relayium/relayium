import Foundation

/// The relay-RTT map as it travels on the signalling `signal` envelope.
///
/// The shape is fixed by `web/src/App.svelte`'s `broadcastRelayRtt`:
/// `{"relayRtt": {"<relay id>": <milliseconds>}}`. The Mac and the browser are
/// routinely each other's peer, so this is a wire format, not an internal
/// detail.
public enum RelayRttMessage {
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
            if case let .number(ms) = v { out[id] = Int(ms) }
        }
        return out
    }
}
