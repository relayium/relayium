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
/// (`server/account/turn.go`), and once it lapses this link's AUTHORITY to be
/// relayed has lapsed with it: no new allocation can be made, no refresh is
/// owed to it, and a path that drops cannot be re-established.
///
/// **What the expiry does NOT do is end an existing allocation, and nothing
/// here may assume it does.** An earlier version of this comment said the
/// allocation "goes with it". That is not something a client may rely on: an
/// allocation that already exists may outlive the credential it was made
/// under, and may go on carrying — and metering — bytes after this boundary.
/// How long is not bounded by anything the client can see. So the expiry is
/// not an instant cap on relayed usage and it revokes nothing automatically.
///
/// The deadline is therefore a bound on what the CLIENT does, not a claim about
/// the relay: derived up front from the config the room was handed, it closes
/// the link with a truthful "start again" at the point its grant ends rather
/// than letting it run on an allocation nobody is entitled to any more — one
/// that would die silently, at a time nobody can predict, mid-transfer. It
/// changes nothing on the wire and grants nothing, and it is not a quota or
/// revocation mechanism. Being wrong in the safe direction — ending slightly
/// early — is the entire design goal.
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

// MARK: - the renewal margin

/// How far ahead of the terminal deadline a link that is being used tries to
/// renew (spec §7.2).
///
/// Ten minutes on a normal one-hour credential: long enough to absorb a denied
/// round, a retry under a fresh epoch and an ICE restart that has to gather
/// again, and short enough that a link does not spend a sixth of its life
/// renewing.
public let RELAY_RENEW_MARGIN: TimeInterval = 10 * 60

/// When a relayed link should first attempt renewal, or nil when it should not
/// attempt one at all.
///
/// ## The margin is a fraction of the grant's LIFETIME, not of its remainder
///
/// `armedAt` is the instant the boundary was installed, and it is required
/// rather than defaulted because measuring from "now" is the defect this
/// signature exists to prevent. With `margin = min(10 min, remaining / 3)`
/// recomputed against a shrinking remainder, the trigger condition
/// `remaining <= margin` is `remaining <= remaining / 3`, which is false for
/// every positive remaining — so the attempt never fires until the deadline has
/// already passed. Root reproduced exactly that against the shipped Web
/// controller: zero requests at 50 and 55 minutes of a 60-minute grant, and the
/// first only at the deadline itself.
///
/// The rule, for a grant armed at `T` with a boundary at `T + L`:
///
/// ```
/// margin  = min(10 min, floor(L / 3))
/// attempt = (T + L) - margin
/// ```
///
/// so a one-hour grant is renewed from 50 minutes in, and a 60-second
/// accelerated test credential from 40 seconds in. Scaling by a THIRD rather
/// than by a fixed ten minutes is what keeps an acceptance run's short-lived
/// credential renewable at all, and flooring keeps the instant on a whole
/// second.
///
/// ## Why it can never busy-loop
///
/// It is consulted ONCE per armed boundary, and the attempt it starts is
/// bounded three ways: `RENEW_MAX_EPOCHS_PER_ROUND`, `RENEW_RETRY_BACKOFF_MS`
/// between failures, and a denied round being terminal. The only thing that
/// produces a new instant is a COMMIT, which by definition armed a later
/// boundary from a credential that was actually issued.
///
/// Nil when the boundary is already at or behind `armedAt` — a link with
/// nothing left to renew ends truthfully instead.
public func relayRenewAttemptAt(_ deadline: RelayDeadline, armedAt: Date) -> Date? {
    let lifetime = deadline.deadlineAt.timeIntervalSince(armedAt)
    guard lifetime > 0 else { return nil }
    let margin = min(RELAY_RENEW_MARGIN, (lifetime / 3).rounded(.down))
    return deadline.deadlineAt.addingTimeInterval(-margin)
}

/// Whether a freshly granted configuration actually moves the boundary FORWARD.
///
/// A grant that would move it earlier, or leave it where it is, is refused: it
/// would retire a live allocation in favour of a shorter-lived one, which is
/// strictly worse than doing nothing. Committing to it would also be the one
/// case where renewal SHORTENS a link — the opposite of what the user is told.
public func relayRenewAdvancesDeadline(_ fresh: RelayDeadline,
                                       beyond current: RelayDeadline?) -> Bool {
    guard let current else { return true }
    return fresh.deadlineAt > current.deadlineAt
}
