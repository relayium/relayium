import Foundation

/// The `inbox/1` protocol vocabulary, as this device must speak it.
///
/// This file is the Swift half of `docs/protocol/relayium-device-inbox-v1.md`
/// and of `server/internal/inbox/` — the same closed sets, the same bounds, the
/// same spelling rules. It is deliberately data and pure functions only: no
/// networking, no storage, no filesystem, so the vocabulary can be asserted
/// without any of them.
///
/// **Everything here fails closed.** Every closed set is an enum with a
/// `RawRepresentable` initialiser that returns `nil` for a value it does not
/// know, and every decoder below turns that `nil` into a thrown error rather
/// than into a default. That is the point: a state, an error code, a policy or a
/// presence value this build does not understand describes a server behaviour
/// this build cannot honour, and guessing at it is how a receiver ends up
/// telling a sender that a delivery is fine when it does not know what the
/// delivery is doing.
public enum InboxProtocol {
    /// Protocol versions this build speaks. A fixed list rather than a range:
    /// adding one has to be a deliberate edit that forces a look at whether the
    /// behaviour behind it is implemented here.
    ///
    /// v1 is absent, not lower-preference. The owner waived old-protocol
    /// compatibility on 2026-08-17, so there is no dual stack and no downgrade:
    /// a central that speaks only v1 is one this build refuses to enrol with.
    public static let versions: [Int] = [3]

    /// The version a SENDER declares on `POST …/inbox/tasks` — the protocol the
    /// manifest sealed inside that task's ciphertext was written to. Separate
    /// from `versions` because it is a different claim: `versions` is what this
    /// build can READ, this is what it just WROTE.
    public static let taskProtocolVersion = 3

    /// The capabilities EVERY build of this library may honestly announce.
    ///
    /// `inbox.receive.v3` is required by central. `inbox.autoaccept.v1` is what
    /// makes the `auto` policy storable at all, and `inbox.resume.v1` says this
    /// device resumes an interrupted ciphertext download from a complete frame
    /// boundary — which `InboxReceiver` does, through `StoreDecryptor`'s
    /// consumed-ciphertext accounting.
    ///
    /// **`inbox.text.v1` is deliberately absent, and its absence here is the
    /// point.** The token is a claim about a SURFACE — "this receiver presents a
    /// text delivery as text" — and a library that renders nothing cannot make
    /// it. Every build that links this module would inherit it if it lived in
    /// this list: the iOS app, which has no Device Inbox message UI at all, and
    /// the headless acceptance receiver, which has no UI of any kind. Both would
    /// then tell a sender that offering a text send to them is honest.
    ///
    /// A build that CAN make the claim announces it explicitly through
    /// `announcedCapabilities(presentingText:)`, at the one site that knows
    /// which screens it ships. See that function.
    public static let capabilities: [String] = [
        InboxCapability.receiveV3, InboxCapability.autoAcceptV1, InboxCapability.resumeV1,
    ]

    /// What THIS build announces, given whether its own product surface renders
    /// a received message as a message.
    ///
    /// `presentingText` is answered by the app target, never by this module and
    /// never by an `#if os(…)`. A platform is not a surface: the same macOS
    /// condition covers the shipped app, whose Device Inbox now renders a
    /// received-messages section with a Copy action, and the headless receiver
    /// host, which renders nothing — so a compile-time platform test would put
    /// the claim on a build that cannot keep it.
    ///
    /// What backs a `true` answer, and what would have to survive before any
    /// other caller may pass one: a message is committed whole to
    /// `InboxMessageStore` — a per-account, 0700/0600 store in Application
    /// Support, never the user's receive folder and never a `.txt` file — and
    /// the caller's own surface reads it back and shows the text.
    ///
    /// The CLI receiver announces the base set for the same reason under the
    /// other half of the rule: it has no message store, so for that build the
    /// absence is the truthful answer.
    public static func announcedCapabilities(presentingText: Bool) -> [String] {
        presentingText ? capabilities + [InboxCapability.textV1] : capabilities
    }

    /// The one wrap algorithm this protocol version defines.
    public static let keyAlgorithm = "x25519-sealedbox-v1"

    /// Raw length of an X25519 public key.
    public static let publicKeyBytes = 32

    /// The EXACT raw length of a wrapped key: a `crypto_box_seal` of the 32-byte
    /// content key is a 32-byte ephemeral public key + 32 bytes of ciphertext +
    /// a 16-byte Poly1305 tag. Checked exactly rather than as an upper bound —
    /// what is wrapped is fixed by this protocol version, so any other length is
    /// a peer sealing something else.
    public static let sealedBoxBytes = 32 + 32 + 16

    /// Header carrying the one-time claim token on ciphertext reads and progress
    /// reports. A header rather than a query parameter so it cannot reach a proxy
    /// log or a browser history.
    public static let claimTokenHeader = "X-Relayium-Inbox-Claim"

    /// Central's lease TTL, used only as the fallback when a claim response does
    /// not name one. The value a claim returns always wins: a server that
    /// shortens its lease must be followed, not contradicted.
    public static let defaultLeaseSeconds = 300

    /// Central's advertised heartbeat cadence, used the same way.
    public static let defaultHeartbeatSeconds = 30

    /// One claim leases ONE task, because deliveries are worked sequentially and
    /// their sizes are unbounded until TTL. Claiming a second before the first
    /// finishes could let the second task's lease expire without ever starting
    /// it (WORKFLOW-LEARNINGS, 2026-08-09).
    public static let claimBatch = 1
}

/// Capability tokens the Device Inbox protocol defines.
public enum InboxCapability {
    /// Historical. Named so the refusal can be asserted by name; never
    /// announced by this build and never negotiable against a v2 central.
    public static let receiveV1 = "inbox.receive.v1"
    /// Required of every receiving device: claim, unwrap, decode a v2 manifest,
    /// verify, commit atomically.
    public static let receiveV3 = "inbox.receive.v3"
    /// "This receiver presents a text delivery as text." Announced only by a
    /// build that actually does, because a sender uses it to decide whether
    /// offering a text send to this device would be honest.
    public static let textV1 = "inbox.text.v1"
    public static let autoAcceptV1 = "inbox.autoaccept.v1"
    public static let resumeV1 = "inbox.resume.v1"
}

/// The automatic-receive policy a device announces (PRD §8).
///
/// `off` is the default and the schema default, so no row can come into
/// existence already permitted to write to a user's disk.
public enum InboxAutoAccept: String, Codable, Equatable, Sendable, CaseIterable {
    case off
    case ask
    case auto
}

/// Presence, as central derives it. There are exactly two values and neither is
/// "unknown": a device central has not heard from is offline, which is the
/// truthful thing to tell a sender.
public enum InboxPresence: String, Codable, Equatable, Sendable, CaseIterable {
    case online
    case offline
}

/// The closed server-visible task state set (PRD §10 items 3-12).
///
/// `encrypting` and `uploading` are deliberately absent: they are sender-local,
/// central cannot observe either, and a receiver that could name one could
/// assert something about a machine it is not.
public enum InboxTaskState: String, Codable, Equatable, Sendable, CaseIterable {
    case queued
    case notified
    case downloading
    case verifying
    case saved
    case attentionRequired = "attention_required"
    case expired
    case revoked
    case failedRetryable = "failed_retryable"
    case failedTerminal = "failed_terminal"

    /// States that can never transition again.
    public var isTerminal: Bool {
        switch self {
        case .saved, .expired, .revoked, .failedTerminal: return true
        case .queued, .notified, .downloading, .verifying, .attentionRequired, .failedRetryable:
            return false
        }
    }

    /// What a target device may assert about a task it holds a lease on.
    ///
    /// Narrower than the transition table on purpose: `expired` and `revoked`
    /// are central's judgements about time and authorization, and
    /// `queued`/`notified` are central's scheduling — a device that could report
    /// `queued` could reset its own backoff.
    public var isDeviceReportable: Bool {
        switch self {
        case .downloading, .verifying, .saved, .attentionRequired,
             .failedRetryable, .failedTerminal:
            return true
        case .queued, .notified, .expired, .revoked:
            return false
        }
    }
}

/// The closed set of error codes a DEVICE may submit (protocol §16).
///
/// There is no free-text member, which is the whole design: a file name or a
/// path cannot reach central even when this device is explaining exactly why
/// saving failed.
public enum InboxDeviceErrorCode: String, Codable, Equatable, Sendable, CaseIterable {
    case none = ""
    case downloadFailed = "download_failed"
    case decryptFailed = "decrypt_failed"
    case verifyFailed = "verify_failed"
    case diskFull = "disk_full"
    case permissionDenied = "permission_denied"
    case directoryUnavailable = "directory_unavailable"
    case nameConflict = "name_conflict"
    case userDeclined = "user_declined"
    case unsupported
    /// Back-ticked because `internal` is a Swift keyword; the wire token is the
    /// protocol's own `internal`, unchanged.
    case `internal`
}

/// The error codes CENTRAL writes and a device may never submit.
///
/// Kept as a named set rather than as absent strings so a report path can refuse
/// one explicitly instead of letting it fall through as "unknown": a device that
/// could submit `lease_expired` could forge central's own account of events.
public enum InboxCentralErrorCode: String, Equatable, Sendable, CaseIterable {
    case leaseExpired = "lease_expired"
    case attemptsExhausted = "attempts_exhausted"
    case keyRevoked = "key_revoked"
    case storedObjectUnavailable = "stored_object_unavailable"
}

/// Every error token this build understands on a task row, from either author.
///
/// A task READ back from central may legitimately carry a central-authored code,
/// so the read model needs a union while the report path stays restricted to
/// `InboxDeviceErrorCode`. Splitting the two is what keeps "what may I say" and
/// "what may I be told" from collapsing into one permissive set.
public enum InboxTaskErrorCode: Equatable, Sendable {
    case device(InboxDeviceErrorCode)
    case central(InboxCentralErrorCode)

    public init?(rawValue: String) {
        if let d = InboxDeviceErrorCode(rawValue: rawValue) { self = .device(d); return }
        if let c = InboxCentralErrorCode(rawValue: rawValue) { self = .central(c); return }
        return nil
    }

    public var rawValue: String {
        switch self {
        case .device(let d): return d.rawValue
        case .central(let c): return c.rawValue
        }
    }

    /// True when nothing has gone wrong yet.
    public var isNone: Bool { self == .device(.none) }
}

/// The machine-readable `error` tokens central returns on a rejection.
///
/// Only the ones a receiving device must BRANCH on are named. Anything else is
/// carried as its raw string in `InboxError.api` and reported by status, so an
/// unrecognised token can never be mistaken for one of these.
public enum InboxRejection: String, Equatable, Sendable, CaseIterable {
    case unsupportedProtocolVersion = "unsupported_protocol_version"
    case unsupportedCapability = "unsupported_capability"
    case unsupportedAutoAcceptCapability = "unsupported_auto_accept_capability"
    case unsupportedKeyAlgorithm = "unsupported_key_algorithm"
    case deviceInboxNotRegistered = "device_inbox_not_registered"
    case deviceInboxRevoked = "device_inbox_revoked"
    case staleKeyRotation = "stale_key_rotation"
    case deviceKeyReused = "device_key_reused"
    case unusablePublicKey = "unusable_public_key"
    case malformedPublicKey = "malformed_public_key"
    case staleClaim = "stale_claim"
    case taskTerminal = "task_terminal"
    case invalidTransition = "invalid_transition"
    case storedObjectUnavailable = "stored_object_unavailable"
    case autoReceiveDisabled = "auto_receive_disabled"
    case deviceCannotReceive = "device_cannot_receive"
    // The four a SENDER's create can be refused with. Named rather than left as
    // raw strings because a sender must branch on them and the branches are not
    // interchangeable: one is recoverable by resealing, one means somebody
    // else's task owns these bytes, and the remaining two are dead ends.
    /// The target rotated its key between the read and the create. Recoverable
    /// exactly once, by re-reading the device and resealing the same content key.
    case staleTargetKey = "stale_target_key"
    /// This idempotency key already names a task describing a DIFFERENT send.
    /// Never a convergence — central refuses rather than silently returning the
    /// first task, so a caller cannot mistake one delivery for another.
    case idempotencyKeyConflict = "idempotency_key_conflict"
    /// The stored object is already bound to some other task. The bytes are not
    /// this send's to release.
    case storedObjectAlreadyBound = "stored_object_already_bound"
    /// The target already has as many pending tasks as central will hold.
    case inboxQueueFull = "inbox_queue_full"
}
