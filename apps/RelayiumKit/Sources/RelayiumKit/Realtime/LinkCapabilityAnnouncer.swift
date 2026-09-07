import Foundation

/// How many times one peer is told what this build speaks.
///
/// The hello is an unacknowledged signalling frame, so it repeats — a single
/// send lost to a socket that was still opening would leave that peer
/// permanently invisible to link mode. It repeats a BOUNDED number of times
/// because the alternative is a client that keeps talking to a peer that may
/// never answer, forever, for the life of the room.
public let LINK_CAPS_ANNOUNCE_ATTEMPTS = 3

/// **The hello of a client whose only transport is `link/1`.**
///
/// `link/1` when link mode is on, and an EMPTY list when it is not — which is
/// still a hello, and still says "nothing here for you" rather than saying
/// nothing. `text/1` never appears, because a composition that uses this has no
/// legacy lane to honour: announcing one would invite a peer onto a transport
/// the app cannot open, and a capability is the one input a peer is entitled to
/// act on.
///
/// Deliberately beside `linkCapsHello` rather than replacing it. Both are real
/// answers for real compositions — the paused iOS implementation and the
/// headless acceptance hosts still ship the legacy lane and must go on
/// announcing it — and which one a client sends is a fact about that client,
/// chosen where it is composed. See `LinkCapabilityAnnouncer.init(hello:)`.
///
/// The per-connection SDP confirmation is unchanged and is already exact
/// `link/1`; this is the ROSTER-level announcement, which is the one that was
/// over-promising.
public func linkOnlyCapsHello(linkRoomActive: Bool) -> JSONValue {
    capsField(linkRoomActive ? [LINK_CAPABILITY] : [])
}

/// How long between one peer's announcements.
///
/// One constant for BOTH rooms, and that is the point of hoisting it here. The
/// same-network room drove its retries from `LanDiscoveryModel`'s own private
/// copy while a pairing room drove none at all, so `LINK_CAPS_ANNOUNCE_ATTEMPTS`
/// silently meant three attempts on one room and one on the other. A retry
/// cadence that differs by room is a capability that is discovered on one and
/// missed on the other, which is exactly the downgrade the retries exist to
/// prevent.
///
/// The value is bounded by the window the listener waits: three attempts at
/// 1.5s land at 1.5, 3.0 and 4.5 seconds, all inside
/// `LinkWorkspaceModel.pairingCapabilityWait` and inside
/// `RealtimeConnectionFactory`'s equal five-second `text/1` wait. Raising either
/// the count or the interval past that window would make the last attempt
/// arrive after the peer has already decided this side is legacy.
public let LINK_CAPS_RETRY_INTERVAL: TimeInterval = 1.5

/// Tells each peer in the room what this build can speak, at the roster level.
///
/// ## Why the roster and not the SDP
///
/// A capability that arrives with a connection's offer comes too late to
/// prevent what it exists to prevent: an older peer treats ANY inbound offer as
/// a file transfer, waits for a manifest that will never come, and fails it as
/// a stall. The roster hello lands before anybody dials.
///
/// ## One-way, by construction
///
/// Announcing is driven ONLY by the roster gaining a peer this client has not
/// greeted, and by the bounded retry tick. Hearing from a peer never produces
/// an announcement — `didHearFrom` only RETIRES retries. That is what keeps two
/// devices from answering each other's hellos forever; the property is
/// structural rather than a rule somebody has to remember.
///
/// ## Scope
///
/// Nothing is announced where link mode cannot run. The legacy per-connection
/// SDP capability confirmation continues to serve `text/1` exactly as it does
/// today, so this adds no frame to a pairing-code room — and, while
/// `LINK_BUILD_SUPPORT` is false, no frame anywhere.
@MainActor
public final class LinkCapabilityAnnouncer {
    private let registry: PeerCapabilityRegistry
    private let linkRoomActive: () -> Bool
    private let send: (String, JSONValue) -> Void
    /// **What this client announces, as a function of whether link mode is on.**
    ///
    /// Injectable, and defaulted to `linkCapsHello` — which is what every
    /// existing caller gets and is byte-identical to what was hard-coded here.
    ///
    /// It exists because a client's hello is a PROMISE, and a composition can
    /// stop being able to keep part of it. macOS deletes its legacy file and
    /// text transports: it refuses every legacy session, so announcing `text/1`
    /// would invite a peer onto a lane the app cannot open — the one input that
    /// peer is entitled to act on, and acting on it produces a connection that
    /// can only stall. iOS still implements that lane and still announces it.
    ///
    /// A parameter rather than a platform `#if` on purpose: the two macOS room
    /// types are the things that changed, not the platform, and a global switch
    /// would silently re-answer for the headless acceptance hosts and every
    /// future consumer that links this module.
    private let hello: (Bool) -> JSONValue

    /// Peers still owed announcements, and how many each is owed. A peer leaves
    /// this map by being greeted enough times, by answering, or by leaving the
    /// room.
    private var pending: [String: Int] = [:]
    /// Everyone greeted in THIS room epoch, so an unchanged roster is not
    /// mistaken for a new peer.
    private var greeted: Set<String> = []
    private var stopped = false

    public init(registry: PeerCapabilityRegistry,
                linkRoomActive: @escaping () -> Bool,
                send: @escaping (String, JSONValue) -> Void,
                hello: @escaping (Bool) -> JSONValue = linkCapsHello(linkRoomActive:)) {
        self.registry = registry
        self.linkRoomActive = linkRoomActive
        self.send = send
        self.hello = hello
    }

    /// A new socket: new peer ids, and a roster nobody has been greeted in. A
    /// peer id only means something inside the room that issued it, so the
    /// previous room's announcements must not answer for ids in this one.
    public func roomChanged() {
        pending.removeAll()
        greeted.removeAll()
        stopped = false
        registry.reset()
    }

    /// The roster changed. Greets peers this client has not greeted yet, and
    /// forgets the ones that left.
    ///
    /// `deliveredAt` is the stamp `PeerCapabilityRegistry.rosterDelivered()`
    /// returned for THIS roster frame, for a caller that can supply one. With
    /// it, the registry prune becomes one atomic mutation that keeps this
    /// membership and, separately, any announcement delivered after this frame
    /// was — see `retain(_:preservingAnnouncementsAfter:)` for why that
    /// distinction is the difference between a working unified link and a
    /// permanently misrouted establishment frame.
    ///
    /// Preservation is deliberately invisible to everything below the retain.
    /// A preserved peer is not in `peerIds`, so it is never greeted, never
    /// entered in `pending` or `greeted`, and never treated as present: the
    /// roster frame remains the sole authority for all of that. Only the
    /// registry — a hint about what a peer speaks, read through `supports`
    /// wherever routing asks — is spared, and only until a roster frame that
    /// was actually delivered later answers for it.
    ///
    /// `nil` keeps the previous behaviour exactly, for a caller that has no
    /// delivery stamp to give.
    ///
    /// The registry lock is released inside `retain` and is never held across
    /// `announce`: greeting sends an outbound frame, and a lock held across a
    /// send is a lock held across whatever the transport does with it.
    public func rosterChanged(peerIds: [String], deliveredAt rosterPosition: Int? = nil) {
        guard !stopped else { return }
        let present = Set(peerIds)
        if let rosterPosition {
            registry.retain(peerIds, preservingAnnouncementsAfter: rosterPosition)
        } else {
            registry.retain(peerIds)
        }
        pending = pending.filter { present.contains($0.key) }
        greeted.formIntersection(present)
        guard linkRoomActive() else { return }
        for peerId in peerIds where !greeted.contains(peerId) {
            greeted.insert(peerId)
            pending[peerId] = LINK_CAPS_ANNOUNCE_ATTEMPTS
            announce(to: peerId)
        }
    }

    /// One bounded retry round, driven by the owner's timer.
    public func retryTick() {
        guard !stopped, linkRoomActive() else { return }
        for peerId in pending.keys.sorted() { announce(to: peerId) }
    }

    /// This peer has told us what it speaks. It does not need telling again.
    ///
    /// Deliberately the ONLY thing an inbound hello does here. Answering one
    /// would make two devices talk past each other indefinitely.
    public func didHearFrom(peerId: String) {
        pending[peerId] = nil
    }

    public func stop() {
        stopped = true
        pending.removeAll()
        greeted.removeAll()
    }

    private func announce(to peerId: String) {
        guard let remaining = pending[peerId], remaining > 0 else {
            pending[peerId] = nil
            return
        }
        pending[peerId] = remaining > 1 ? remaining - 1 : nil
        send(peerId, hello(linkRoomActive()))
    }
}
