import Foundation

/// Whether this BUILD implements `link/1` at all.
///
/// A plain constant, deliberately — the web's `LINK_BUILD_SUPPORT` records why:
/// what a build can implement is a property of its source, so it is written in
/// the source rather than in an environment variable somebody has to remember
/// to set. It is not a switch. There is no setter, no launch argument and no
/// stored setting, so a deep link, a relay or a user cannot reach it.
///
/// Scope is decided one level down, by the room.
public let LINK_BUILD_SUPPORT = false

/// Whether the room this client is currently in may use `link/1`.
///
/// Only the code-less LAN room. A pairing-code/cross-network room keeps the
/// existing one-mode-at-a-time file and text paths, because a relayed link's
/// TURN allocation lifetime, quota accounting and mobile-background cost need
/// their own production acceptance before one long-lived link replaces two
/// short ones there.
///
/// This is the ONE place the build flag and the room rule are combined, so a
/// caller cannot accidentally consult one without the other.
public func linkRoomActive(isCodelessRoom: Bool) -> Bool {
    LINK_BUILD_SUPPORT && isCodelessRoom
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
