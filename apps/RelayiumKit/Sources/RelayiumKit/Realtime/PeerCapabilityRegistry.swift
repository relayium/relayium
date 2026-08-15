import Foundation

/// Whether this BUILD implements `link/1` at all.
///
/// A plain constant, deliberately — the web's `LINK_BUILD_SUPPORT` records why:
/// what a build can implement is a property of its source, so it is written in
/// the source rather than in an environment variable somebody has to remember
/// to set. It is not a switch. There is no setter, no launch argument and no
/// stored setting, so a deep link, a relay or a user cannot reach it.
///
/// **It answers what the PROCESS can compose, and both APPLE apps now can.**
///
/// It used to be `true` on macOS and `false` on iOS, and the reason was exact:
/// `RelayiumKit` is linked by both apps and `LanDiscoveryModel` — which owns the
/// roster-level announcement — ships on both, so a cross-platform `true` while
/// iOS composed nothing would have made an iPhone announce `link/1` in every
/// same-network room and then fail the establishment it had itself invited. An
/// announcement is a promise about what this process can answer.
///
/// iOS now composes `LinkWorkspaceModel` and renders a connected unified
/// workspace, so the promise is one it can keep, and the constant is true on
/// macOS AND iOS. It is still compiled per platform, and the `#else` is not a
/// formality: this module is not limited to the two app binaries, and any other
/// build of it — a Linux or tool build, a future non-Apple target — composes no
/// link surface at all. An unconditional `true` would make such a process
/// announce `link/1` and then fail the establishment it invited, which is the
/// exact failure the original split existed to prevent, so the directive stays
/// and only its condition widened.
///
/// What did NOT become cross-platform is the ROOM rule below: iOS answers
/// `link/1` in the code-less room only, because it composes no pairing-code link
/// surface at all. That distinction lives in `linkRoomActive`, in one function,
/// rather than being spread back into this constant.
#if os(macOS) || os(iOS)
public let LINK_BUILD_SUPPORT = true
#else
public let LINK_BUILD_SUPPORT = false
#endif

/// Whether this build composes a `link/1` in a PAIRING-CODE room.
///
/// macOS does: `LinkWorkspaceModel.watchPairingCode` opens one socket per code,
/// shared by the link attempt and by the legacy fallback built on it, and
/// `RelayDeadline` bounds the relayed credential it is issued.
///
/// iOS does not, and this is the constant that says so rather than a comment.
/// The iOS app is handed a `LinkWorkspaceModel` with **no** `connectPairingSocket`
/// (`AppEnvironment.makeLinkWorkspaceModel`'s iOS overload takes no room handle
/// and passes none), so there is nothing on that platform that could join a code
/// room as a link. Announcing `link/1` there would be the same broken promise
/// the platform split above existed to prevent — one room narrower.
///
/// Its own constant, and not an inline `#if` inside `linkRoomActive`, for the
/// reason `LINK_BUILD_SUPPORT` is one: it is a property of the source, it is
/// asserted directly by `PeerCapabilityRegistryTests`, and turning it on means
/// editing it alongside the surface that would make it true.
#if os(macOS)
public let LINK_PAIRING_ROOM_SUPPORT = true
#else
public let LINK_PAIRING_ROOM_SUPPORT = false
#endif

/// Whether the room this client is currently in may use `link/1`.
///
/// **Every room, on a build that implements the protocol.** It used to be the
/// code-less same-network room alone, because a pairing code had no room object
/// above `RealtimeConnectionFactory` — the socket was opened inside the call
/// that built a legacy connection, so a link there would have needed a second
/// one and the legacy fallback a third.
///
/// `LinkPairingRoom` removed that: a code now has exactly one socket, owned
/// above the connection, shared by the link attempt AND by the legacy connection
/// the fallback builds on it. With one socket the remaining pairing-code
/// concerns are the ones the Web answered first and this client now answers the
/// same way:
///
///  - **A relayed link's credential lifetime is bounded and visible.** The TURN
///    REST username `/api/ice` issues states its own expiry, and `RelayDeadline`
///    derives a clock-skew-safe deadline from it. The link warns before the
///    boundary and is closed truthfully at it, rather than silently ceasing to
///    move bytes when the allocation lapses.
///  - **Exactness did not move.** A peer that does not announce this precise
///    version is legacy in every room and is never probed with a two-channel
///    offer it would misread.
///
/// The parameter is kept rather than deleted, and it is not vestigial: it is
/// where a future room kind states its own answer, and keeping the composition
/// in ONE function is what stops the announcement and the routing rule from
/// consulting different halves.
///
/// **And on iOS the parameter is now load-bearing.** That build composes a link
/// for the code-less room and nothing for a pairing code — see
/// `LINK_PAIRING_ROOM_SUPPORT` — so a pairing room there answers false. Because
/// this one function feeds the roster hello, the SDP confirmation and the
/// routing predicate alike, an iOS pairing room cannot announce a capability its
/// routing would then refuse, and cannot route one it never announced.
///
/// See DECISION-LOG "Promote the unified Web workspace to pairing rooms with a
/// bounded relay lifecycle" (2026-08-10) for the Web's equivalent step.
public func linkRoomActive(isCodelessRoom: Bool) -> Bool {
    guard LINK_BUILD_SUPPORT else { return false }
    return isCodelessRoom || LINK_PAIRING_ROOM_SUPPORT
}

/// What this build announces, at the roster level and — through the same
/// expression — in its SDP confirmation.
///
/// One function for both, so the two announcements cannot disagree, and so
/// neither can disagree with the routing predicate below, which reads the same
/// room rule.
public func advertisedLinkCapabilities(linkRoomActive: Bool) -> [String] {
    linkRoomActive ? [TEXT_CAPABILITY, LINK_CAPABILITY] : [TEXT_CAPABILITY]
}

/// The roster-level hello this build sends to each peer on joining a room and
/// on roster change. A fresh array each call: a caller must not be able to
/// mutate what we advertise to the next peer.
public func linkCapsHello(linkRoomActive: Bool) -> JSONValue {
    capsField(advertisedLinkCapabilities(linkRoomActive: linkRoomActive))
}

/// Which peers in the room have said what they can speak.
///
/// ## What this is
///
/// A HINT. The signalling relay sees every frame: it can strip an announcement
/// (the feature is denied) or forge one (we invite a peer that cannot answer —
/// also a denial). Neither can ever put plaintext on the wire, because the
/// session keys are DERIVED through commit/reveal, not negotiated here; there
/// is no "downgrade to unencrypted" path for a capability claim to reach.
///
/// ## Why the announcement is at the roster level
///
/// A capability that arrives with a connection's SDP comes too late to prevent
/// the thing it exists to prevent. An older peer treats any inbound offer as a
/// file transfer and waits for a manifest that will never come, then fails it
/// as a stall. The roster hello lands before anybody dials.
///
/// ## Scope and expiry
///
/// An announcement belongs to one peer id in one room epoch, and both of those
/// end. A peer that leaves is discarded; a room change discards everything. A
/// later EMPTY snapshot revokes, because a peer that reloaded into a
/// pairing-code room announces exactly that.
///
/// Thread-safe: announcements arrive on the socket's delivery queue while the
/// UI and the link admission read them from the main actor.
public final class PeerCapabilityRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var announced: [String: Set<String>] = [:]
    private let linkRoomActive: () -> Bool

    /// `linkRoomActive` is the COMPOSED predicate — build support and room scope
    /// together, as `linkRoomActive(isCodelessRoom:)` builds it. It is read at
    /// call time, never cached: joining or leaving a pairing-code room must take
    /// effect on the next routing decision, not the next launch.
    public init(linkRoomActive: @escaping () -> Bool) {
        self.linkRoomActive = linkRoomActive
    }

    /// Record a peer's announcement. Returns true when this frame WAS a caps
    /// hello, so a caller can tell it apart from the other piggybacks that share
    /// this envelope.
    ///
    /// Peer-authored input on an untrusted channel: anything malformed is
    /// ignored rather than thrown, because throwing here would land in the
    /// signalling dispatch loop. A non-array `caps` is not a hello at all — that
    /// is a frame we do not understand, not a peer with no capabilities — so it
    /// must leave an earlier announcement standing.
    @discardableResult
    public func record(peerId: String, signal: JSONValue) -> Bool {
        guard case let .object(fields) = signal else { return false }
        guard case let .array(items)? = fields["caps"] else { return false }
        let caps = items.compactMap { item -> String? in
            if case let .string(s) = item { return s }
            return nil
        }
        lock.lock()
        announced[peerId] = Set(caps)
        lock.unlock()
        return true
    }

    /// Exact match, deliberately: `link/2` is a different wire and must never be
    /// read as this one.
    ///
    /// Room scope is enforced HERE rather than only at the announcement, and
    /// that placement is the whole security value. Refusing to *say* `link/1` in
    /// a pairing-code room is worth nothing on its own — a relay can inject a
    /// roster claim. This is the predicate every routing decision reads, so a
    /// forged claim cannot activate link mode where the room does not allow it.
    public func supports(_ peerId: String, _ capability: String) -> Bool {
        if capability == LINK_CAPABILITY, !linkRoomActive() { return false }
        lock.lock(); defer { lock.unlock() }
        return announced[peerId]?.contains(capability) == true
    }

    /// Drop announcements for peers no longer in the roster. A reconnecting peer
    /// is issued a fresh id by the hub, so nothing stale can be inherited by the
    /// new connection — but a departed peer's entry would otherwise leak for the
    /// life of the process.
    public func retain(_ peerIds: [String]) {
        let keep = Set(peerIds)
        lock.lock()
        announced = announced.filter { keep.contains($0.key) }
        lock.unlock()
    }

    /// A room epoch ended. Peer ids only mean something inside the room that
    /// issued them.
    public func reset() {
        lock.lock()
        announced = [:]
        lock.unlock()
    }
}
