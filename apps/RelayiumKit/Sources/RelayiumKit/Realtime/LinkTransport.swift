import Foundation

/// The exact lane set a `link/1` transport must present before anything is
/// published on it.
///
/// A link is not "at least the file lane". Both exact labels, once each, or the
/// connection cannot honour the protocol — so this refuses rather than degrades.
public struct LinkChannelSet: Equatable, Sendable {
    public enum Admission: Equatable, Sendable {
        case accepted
        /// A second channel on a label we already hold. Not a lane: a second
        /// SCTP stream nobody asked for, which would give the peer two producers
        /// on one receiver sequence.
        case duplicate
        /// Anything outside the exact pair — including the legacy `data` label,
        /// which must never be adopted as a link lane.
        case unexpected
    }

    private var admitted: Set<String> = []

    public init() {}

    public var isComplete: Bool { admitted.count == LINK_CHANNEL_LABELS.count }

    public func holds(_ label: String) -> Bool { admitted.contains(label) }

    /// Arrival order is irrelevant; completeness is not.
    public mutating func admit(label: String) -> Admission {
        guard LINK_CHANNEL_LABELS.contains(label) else { return .unexpected }
        guard admitted.insert(label).inserted else { return .duplicate }
        return .accepted
    }
}

/// Bounded pre-attachment capture for ONE transport generation of a link.
///
/// ## Why this exists
///
/// An SCTP stream can deliver data before its sibling has finished DCEP, and a
/// DataChannel drops what has no handler. So between "the channel was
/// collected" and "the lane owns it" there is a window in which a peer that
/// speaks first would simply be lost. On a REPLACEMENT transport those frames
/// belong to codecs that already exist and whose sequences must stay
/// continuous, which turns a lost frame from a missed message into a lane that
/// can never be used again.
///
/// ## Why the bound is combined and why overflow is loud
///
/// The bound covers both lanes together, because what is being limited is how
/// much a peer can make this side hold before it has consented to anything.
/// Overflow is never silent truncation: a dropped ADMITTED frame is exactly
/// what the receiver codecs cannot tolerate, so the caller must fail closed.
/// Frames already held are kept and later ones refused — the earliest ones are
/// the ones that matter, and a flood behind them must not push them out.
///
/// Thread-safe: WebRTC delivers on its own threads while the owner drains.
public final class LinkFrameCapture: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var file: [[UInt8]] = []
    private var text: [[UInt8]] = []
    private var bytes = 0
    private var _overflowed = false
    private var drained = false

    public init(limit: Int = LINK_CAPTURE_MAX_BYTES) {
        self.limit = limit
    }

    public var overflowed: Bool {
        lock.lock(); defer { lock.unlock() }
        return _overflowed
    }

    public func capture(label: String, frame: [UInt8]) {
        // A label outside the exact pair is not a lane — `LinkChannelSet` has
        // already refused it — and nothing here would ever replay it. Deciding
        // that BEFORE the bound is consulted is what stops a peer opening a
        // channel nobody asked for and spending the whole pre-attachment budget,
        // or tripping the overflow that makes the caller fail the link closed,
        // with frames this capture could not deliver to anything.
        guard LINK_CHANNEL_LABELS.contains(label) else { return }
        lock.lock(); defer { lock.unlock() }
        // After the drain, frames belong to the attached lane. Continuing to
        // capture would feed the live array back into itself on replay.
        guard !drained, !_overflowed else { return }
        // Written as a subtraction rather than `bytes + frame.count <= limit`
        // because this is peer-controlled arithmetic: the addition can overflow
        // for a frame length near `Int.max` and wrap into a value that passes
        // the bound. The subtraction cannot, because the guard itself is what
        // keeps `bytes` inside `0...limit`.
        guard frame.count <= limit - bytes else {
            _overflowed = true
            return
        }
        bytes += frame.count
        if label == LINK_FILE_CHANNEL { file.append(frame) } else { text.append(frame) }
    }

    /// Freeze and hand over both lanes' frames, exactly once. Each lane keeps
    /// its own FIFO order; there is deliberately no cross-lane ordering
    /// contract, because each SCTP stream is ordered independently.
    public func take() -> (file: [[UInt8]], text: [[UInt8]]) {
        lock.lock(); defer { lock.unlock() }
        drained = true
        let taken = (file: file, text: text)
        file = []
        text = []
        return taken
    }
}

/// The four nonce-bearing codecs of ONE authenticated link, plus the two
/// domain-separated text keys they run under.
///
/// A reference type on purpose, and the reason is the central invariant of this
/// whole feature: a link owns one `(content key, direction)` sequence for its
/// lifetime. A new file batch, a reopened conversation and an authenticated
/// transport rebuild must all continue those sequences, so there has to be one
/// object identity a test can point at and say "still the same one".
public final class LinkCodecs {
    public let fileSender: RealtimeSender
    public let fileReceiver: RealtimeReceiver
    public let textSender: RealtimeTextSender
    public let textReceiver: RealtimeTextReceiver
    /// The message stream's own AEAD keys. Domain-separated from the file keys
    /// so the two lanes can never collide on a nonce, and derived per direction
    /// — never sorted — so the two directions never collapse onto one counter.
    public let textSendKey: [UInt8]
    public let textRecvKey: [UInt8]
    /// The symmetric HMAC key that authenticates this link's signalling when it
    /// rebuilds its transport under an authentication that already exists.
    ///
    /// It lives here, and only here, for two reasons. It is derived from the
    /// session keys, and this initializer is the one place those keys are
    /// consumed — deriving it anywhere else would mean handing the raw file
    /// session keys to a second call site. And it is the ONE thing standing
    /// between a rebuilt transport and a signalling relay offering its own, so
    /// it must be impossible to point a replacement at a key that does not
    /// belong to the codecs it is reusing: hanging it off the object whose
    /// identity a replacement is already required to preserve makes that
    /// structural rather than a convention.
    ///
    /// Unlike the two text keys this is deliberately SORTED (see
    /// `deriveResumeAuth`): it is shared between the peers, so both ends must
    /// derive the same value from their mirrored secrets. It is a signalling
    /// key, never an AEAD key, and it is domain-separated from both.
    public let resumeAuthKey: [UInt8]

    public init(sendKey: [UInt8], recvKey: [UInt8]) {
        self.fileSender = RealtimeSender(sessionKey: sendKey)
        self.fileReceiver = RealtimeReceiver(sessionKey: recvKey)
        self.textSender = RealtimeTextSender()
        self.textReceiver = RealtimeTextReceiver()
        self.textSendKey = deriveTextKey(sessionKey: sendKey)
        self.textRecvKey = deriveTextKey(sessionKey: recvKey)
        self.resumeAuthKey = deriveResumeAuth(sendKey: sendKey, recvKey: recvKey)
    }
}

/// What survives a transport rebuild: the authenticated identity of a link.
///
/// `authenticationGeneration` is the identity of the AUTHENTICATION, not of any
/// object. A rebuild publishes a new transport carrying the same keys, SAS and
/// codecs — that is the same authentication step and must not invalidate work
/// started before it, or announce the SAS to the user a second time.
/// Establishment and teardown DO advance it, so a stale async result can never
/// be accepted by a later link, even one to the same peer whose six displayed
/// digits happen to collide.
public struct LinkIdentity {
    public let peerId: String
    public let role: Role
    public let sas: String
    public let codecs: LinkCodecs
    public let authenticationGeneration: Int

    public init(peerId: String,
                role: Role,
                sas: String,
                codecs: LinkCodecs,
                authenticationGeneration: Int = 0) {
        self.peerId = peerId
        self.role = role
        self.sas = sas
        self.codecs = codecs
        self.authenticationGeneration = authenticationGeneration
    }

    /// The same link on a new transport. Everything that identifies the
    /// authentication is carried over unchanged — deliberately including the
    /// role, so both sides keep the offerer/responder split their first
    /// connection produced and a rebuild cannot turn two peers into two
    /// offerers.
    public func replacingTransport() -> LinkIdentity {
        LinkIdentity(peerId: peerId,
                     role: role,
                     sas: sas,
                     codecs: codecs,
                     authenticationGeneration: authenticationGeneration)
    }
}
