import Foundation

/// How many ICE candidates one side of one establishment may hold while it
/// waits for the description they belong to.
///
/// The window this bounds is short — the completion of one
/// `setLocalDescription`, or of one `setRemoteDescription` — but "short" is not
/// a bound. A real ICE exchange for a single data m-line is single-digit to low
/// double-digit: one host candidate per usable address (Ethernet, Wi-Fi, a VPN
/// `utun`, and IPv6 temporary as well as permanent addresses all count
/// separately), plus one server-reflexive and one relay candidate per configured
/// server. Sixty-four is several times the worst realistic case on a
/// multi-homed machine and still a fixed ceiling, which is the property that
/// matters: the remote side of this gate holds bytes a peer chose, and the
/// local side must not grow without limit either just because it is our own
/// gathering that has gone wrong.
///
/// Overflow is never silent truncation. Dropping the earliest candidates would
/// drop exactly the host candidates a LAN link depends on, and dropping the
/// latest would hide a gathering fault; the caller fails the link closed
/// instead — see `LinkTransportError.pendingCandidateOverflow`.
public let LINK_PENDING_CANDIDATE_MAX = 64

/// Which side of the wire a held candidate came from. Carried by the overflow
/// error so a failure is diagnosable: local overflow means our own gathering
/// outran our own signalling, remote overflow means the peer flooded the window
/// between accepting its description and applying it.
public enum LinkCandidateDirection: Equatable, Sendable {
    case local
    case remote
}

/// What the gate decided about one candidate.
public enum LinkCandidateAdmission: Equatable, Sendable {
    /// The description this candidate belongs to has already been dealt with.
    /// Use it now.
    case send
    /// Held. It will come back out of `open()`, in arrival order.
    case hold
    /// The bound was exceeded. Terminal: the caller must fail the link.
    case overflow
}

/// Holds ICE candidates until the SDP they belong to has actually been dealt
/// with, then releases them in arrival order.
///
/// ## Why this is not optional on either side
///
/// **Locally**, gathering starts *inside* `setLocalDescription`, and
/// `didGenerate` is not ordered against that call's completion block — the block
/// that sends the offer or answer. A candidate that overtakes it reaches a peer
/// that has no remote description yet, and every implementation drops such a
/// candidate. On a LAN the ones generated first are the host candidates, which
/// are precisely the ones that would have made the link direct, so "it costs a
/// path, not the connection" understates it: it can cost the whole early
/// gathering round and leave a LAN pair waiting on a relay that may not exist.
///
/// **Remotely**, `LinkSignalPolicy.plan` serializes the *decisions* but
/// `setRemoteDescription` is asynchronous, so the next queued signal can reach
/// `RTCPeerConnection.add` before the description it needs has been applied.
/// That failure is silent by construction — `add`'s error is the only report,
/// and it says nothing a caller can distinguish from a malformed candidate.
///
/// ## Ordering
///
/// FIFO, and the same FIFO in both directions. Candidates are ranked by the ICE
/// agent in the order the gatherer produced them, and reordering them across
/// the gate would present a peer with a priority order neither side computed.
///
/// A pure value type with no clock, no queue and no WebRTC: the owner
/// serializes, exactly as it does for `LinkEstablishment`.
public struct LinkCandidateGate<Candidate> {
    private let limit: Int
    private var pending: [Candidate] = []
    private var opened = false

    public init(limit: Int = LINK_PENDING_CANDIDATE_MAX) {
        self.limit = limit
    }

    /// True once the description these candidates belong to has been dealt
    /// with. From then on the gate holds nothing.
    public var isOpen: Bool { opened }
    public var pendingCount: Int { pending.count }

    /// Offer one candidate to the gate.
    public mutating func admit(_ candidate: Candidate) -> LinkCandidateAdmission {
        if opened { return .send }
        guard pending.count < limit else { return .overflow }
        pending.append(candidate)
        return .hold
    }

    /// Open the gate and hand back everything held, in arrival order.
    ///
    /// Idempotent, and deliberately: an establishment applies exactly one
    /// initial description per direction, but a caller that reached this twice
    /// must flush a backlog once rather than replay it. A second call returns
    /// nothing.
    public mutating func open() -> [Candidate] {
        opened = true
        let held = pending
        pending = []
        return held
    }

    /// Drop the backlog without releasing it. For teardown: candidates held for
    /// a transport that is going away belong to a connection nobody will use.
    public mutating func discard() {
        pending = []
    }
}
