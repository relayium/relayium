import Foundation

/// How many times one peer is told what this build speaks.
///
/// The hello is an unacknowledged signalling frame, so it repeats — a single
/// send lost to a socket that was still opening would leave that peer
/// permanently invisible to link mode. It repeats a BOUNDED number of times
/// because the alternative is a client that keeps talking to a peer that may
/// never answer, forever, for the life of the room.
public let LINK_CAPS_ANNOUNCE_ATTEMPTS = 3

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
                send: @escaping (String, JSONValue) -> Void) {
        self.registry = registry
        self.linkRoomActive = linkRoomActive
        self.send = send
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
    public func rosterChanged(peerIds: [String]) {
        guard !stopped else { return }
        let present = Set(peerIds)
        registry.retain(peerIds)
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
        send(peerId, linkCapsHello(linkRoomActive: linkRoomActive()))
    }
}
