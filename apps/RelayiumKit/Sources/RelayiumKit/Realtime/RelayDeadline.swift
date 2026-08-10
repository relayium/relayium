import Foundation

/// The bounded lifetime of a RELAYED `link/1`, derived from the credential the
/// server actually issued.
///
/// A link is long-lived by design: one authenticated connection carries both
/// lanes for as long as the two people are working. On the same network that
/// costs nothing — `RealtimeConnectionFactory.nearbyICEServers` drops every TURN
/// URL and credential, so a code-less link cannot allocate a relay at all.
/// Through a pairing code it does not: the ephemeral credential `/api/ice`
/// issues is a TURN REST username of the form `<unix-expiry>:<token>`
/// (`server/account/turn.go`), and when it lapses the allocation behind the link
/// goes with it. Nothing tells the client that happened — a relayed link simply
/// stops moving bytes.
///
/// So the deadline is derived up front, from the config the room was handed, and
/// the link is closed with a truthful "start again" BEFORE the credential dies
/// rather than after. It is a CLIENT-side bound on the client's own behaviour:
/// it changes nothing on the wire and grants nothing. Being wrong in the safe
/// direction — ending slightly early — is the entire design goal.
///
/// Ported from `web/src/lib/relay-deadline.ts`, and deliberately field-for-field:
/// the two clients bound the same credential the same way, so a Web↔macOS link
/// ends at the same moment on both screens rather than one side reporting a
/// failure the other cannot explain.

/// How much local-clock error the margin absorbs.
///
/// `expiry` is stamped by the server's clock; every timer here runs on this
/// device's. If it is AHEAD, the remaining lifetime is underestimated and the
/// link ends early — safe. If it is BEHIND, the lifetime is overestimated, which
/// is the direction that would present dead credentials as live, so the margin
/// is subtracted to cover it. A minute covers ordinary NTP drift; nothing
/// client-side can cover a clock that is hours out, and pretending otherwise
/// would just move the lie.
public let TURN_CLOCK_SKEW: TimeInterval = 60

/// How long before the boundary a live link must say so. Long enough to finish a
/// sentence and re-pair deliberately, short enough that it is not a permanent
/// banner on an hour-long credential.
public let RELAY_DEADLINE_WARN: TimeInterval = 5 * 60

/// When a relayed link must warn, and when it must be terminal.
public struct RelayDeadline: Equatable, Sendable {
    /// The earliest server-stated expiry. Reported so a caller — and a test —
    /// can see what the margin was applied to.
    public let expiresAt: Date
    /// The instant the relayed link must be terminal.
    public let deadlineAt: Date
    /// The instant the live link must warn. Never after the deadline.
    public let warnAt: Date

    public init(expiresAt: Date, deadlineAt: Date, warnAt: Date) {
        self.expiresAt = expiresAt
        self.deadlineAt = deadlineAt
        self.warnAt = warnAt
    }
}

/// The unix-second expiry a TURN REST username states, or nil.
///
/// Strict on purpose. A lenient parse would read an expiry out of a credential
/// that never carried one — and an expiry read out of noise is a deadline
/// imposed on a link for no reason. Only all-ASCII digits before the first colon
/// count, and only a positive value.
public func turnRestExpirySeconds(_ username: String?) -> Int? {
    guard let username, let colon = username.firstIndex(of: ":"), colon != username.startIndex
    else { return nil }
    let head = username[username.startIndex..<colon]
    guard !head.isEmpty, head.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    guard let seconds = Int(head), seconds > 0 else { return nil }
    return seconds
}

/// The earliest expiry stated by any TURN credential in a list, in unix seconds.
///
/// EARLIEST, not first or longest: the pool hands out one credential per relay
/// and ICE decides which one carries the link, so the only honest bound is the
/// one that dies first. A credential on an entry with no `turn:`/`turns:` URL is
/// ignored — a STUN entry has no allocation to lose, and reading one would let a
/// hostile `/api/ice` body impose a deadline on a link that never relays.
///
/// Malformed entries are skipped rather than failing the whole list: dropping a
/// valid sibling because of a broken neighbour would remove the bound entirely,
/// which is the one outcome worth avoiding. Nil when nothing states an expiry,
/// which is the same-network answer and the answer for a STUN-only code room.
public func earliestTurnExpiry(_ servers: [ICEServerConfig]) -> Int? {
    var earliest: Int?
    for server in servers {
        let relays = server.urls.contains { url in
            let lower = url.lowercased()
            return lower.hasPrefix("turn:") || lower.hasPrefix("turns:")
        }
        guard relays, let seconds = turnRestExpirySeconds(server.username) else { continue }
        if earliest == nil || seconds < earliest! { earliest = seconds }
    }
    return earliest
}

/// The deadline for one ICE configuration, or nil when nothing relays.
///
/// Derived ONCE, against the clock that was current when the config was fetched,
/// and then held as absolute instants. Re-deriving it later against a clock that
/// has since been stepped would silently move the boundary under a live link,
/// which is exactly the failure this exists to prevent.
///
/// Both instants are clamped to `now`: a caller arms timers off them, and a
/// negative delay fires immediately in a way that is indistinguishable from
/// "there was no deadline". An already-expired credential is a real state — a
/// badly-set clock, or a config held far too long — and the truthful response is
/// an immediate terminal one, not an unbounded link.
public func relayDeadline(for config: ICEConfig, now: Date) -> RelayDeadline? {
    var candidates: [Int] = []
    if let top = earliestTurnExpiry(config.iceServers) { candidates.append(top) }
    for relay in config.relays {
        if let pooled = earliestTurnExpiry(relay.iceServers) { candidates.append(pooled) }
    }
    guard let earliest = candidates.min() else { return nil }
    let expiresAt = Date(timeIntervalSince1970: TimeInterval(earliest))
    let deadlineAt = max(now, expiresAt.addingTimeInterval(-TURN_CLOCK_SKEW))
    let warnAt = max(now, deadlineAt.addingTimeInterval(-RELAY_DEADLINE_WARN))
    return RelayDeadline(expiresAt: expiresAt, deadlineAt: deadlineAt, warnAt: warnAt)
}
