import Foundation

/// The wire vocabulary of `relay-renew/1`: the signalling envelope two peers
/// use to migrate a live `link/1` onto a freshly issued TURN credential.
///
/// Everything here is pinned to `docs/protocol/relay-renew-v1.md` and, through
/// it, to the bytes in `apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json`.
/// That fixture is GENERATED from the deployed Web implementation
/// (`web/src/lib/relay-renew-wire.ts`) and is read-only here: a native port
/// asserts against those bytes rather than re-deriving them from a reading of
/// the prose. A disagreement is not a style difference — it is a tag one side
/// computes and the other cannot verify, on the one message path that decides
/// whether a link's deadline may move.
///
/// This file deliberately contains no policy, no timers and no I/O. Which epoch
/// may be acted on, when a round may be asked for and what proves a migration
/// all live in `RelayRenewController`; the probe frame lives in
/// `RelayRenewProbe`; the SDP and candidate binding lives in `RelayRenewSDP`.

// MARK: - identity

/// The capability string, matched EXACTLY, and announced ONLY by a build with
/// the whole path wired on this platform (spec §8).
///
/// It is an unsigned hint on the roster (`link:§1.6`). Only an authenticated
/// renewal message confers peer proof, so nothing in this feature may treat the
/// presence of this string as a security input.
public let RELAY_RENEW_CAPABILITY = "relay-renew/1"

// MARK: - bounds (spec §9)

/// Migration attempts one server round may be spent on. A fourth is refused and
/// the link keeps the deadline it has.
public let RENEW_MAX_EPOCHS_PER_ROUND = 3
/// HMACs one epoch will ever spend verifying inbound probe frames.
public let RENEW_MAX_PROBE_VERIFICATIONS = 8
/// The two halves `RENEW_MAX_PROBE_VERIFICATIONS` is reserved in (reconcile-2
/// R5): four for the peer's probes, four for the peer's acks to this side's own
/// nonce. Together they are the ONE per-epoch budget of eight — before and
/// after commit — never eight each.
public let RENEW_PROBE_VERIFICATION_RESERVE = RENEW_MAX_PROBE_VERIFICATIONS / 2
public let RENEW_ACK_VERIFICATION_RESERVE =
    RENEW_MAX_PROBE_VERIFICATIONS - RENEW_PROBE_VERIFICATION_RESERVE
/// HMACs one epoch spends on signalling envelopes, in two pools. Local, not
/// wire constants. A genuine epoch needs a `prepare`, a `ready`, one description
/// and an `abort` — the control pool — and at most a couple of generations'
/// worth of candidates. Anything past either pool is dropped unverified.
public let RENEW_MAX_CONTROL_VERIFICATIONS = 16
public let RENEW_MAX_CANDIDATE_VERIFICATIONS = RENEW_MAX_HELD_CANDIDATES * 2
/// Attempts that may fail BEFORE a grant, between commits (spec §7.2, §9):
/// `unavailable`, `rate`, a silent server, a timeout. A separate budget from
/// `RENEW_MAX_EPOCHS_PER_ROUND`, which counts only epochs that obtained a
/// configuration — so a three-minute database wobble cannot spend the link's
/// whole renewal allowance while most of the margin is unspent. The real bound
/// on both is the old deadline: nothing is ever retried past it.
public let RENEW_MAX_PREGRANT_ATTEMPTS = 6
/// Inbound candidates held per epoch, keyed by the ufrag they name.
public let RENEW_MAX_HELD_CANDIDATES = 64
/// Retransmits of ONE probe nonce.
public let RENEW_PROBE_MAX_SENDS = 5
/// Retransmit cadence for one probe nonce.
public let RENEW_PROBE_RETRY_MS: TimeInterval = 2.0
public let RENEW_PREPARE_TO_READY_MS: TimeInterval = 15.0
public let RENEW_READY_TO_ANSWER_MS: TimeInterval = 15.0
public let RENEW_ICE_PROBE_MS: TimeInterval = 30.0
/// The whole epoch, never re-armed.
public let RENEW_EPOCH_HARD_CAP_MS: TimeInterval = 60.0
/// Two `prepare` signals this far apart with no reply means the peer does not
/// implement renewal, for the remainder of that link.
public let RENEW_PREPARE_SILENCE_MS: TimeInterval = 10.0
/// How long a failed epoch waits before another is spent (spec §7.2).
///
/// Without it the trigger's own cadence burns all three of a round's epochs in
/// seconds: user data re-evaluates the margin on every progress notice, so a
/// transfer that is genuinely moving is also the fastest way to spend the whole
/// budget — before the renewal window has really begun.
public let RENEW_RETRY_BACKOFF_MS: TimeInterval = 60.0
/// How long a COMMITTED epoch goes on answering the peer's probes (spec §6.6).
///
/// Equal to `RENEW_ICE_PROBE_MS`, because the peer's own window cannot outlive
/// it: once the peer's ICE+probe phase has expired there is nobody left to
/// converge with.
public let RENEW_POST_COMMIT_ACK_MS: TimeInterval = RENEW_ICE_PROBE_MS
/// The tag length, checked BEFORE any base64 decode or HMAC. Shared with
/// `LINK_AUTH_TAG_LENGTH`: it is the same primitive over a different payload,
/// and a verifier that bounded one but not the other is a verifier a flood can
/// spend HMACs on.
public let RENEW_AUTH_LENGTH = LINK_AUTH_TAG_LENGTH

/// The largest value this wire admits. Every integer on it is an exact
/// `uint32`: the native ports carry a real `UInt32`, so anything JavaScript
/// would tolerate here is a divergence rather than a leniency.
private let RENEW_UINT32_MAX: Double = 4_294_967_295

// MARK: - uint32

/// A `JSONValue` read as an exact `uint32`, or nil.
///
/// Strict in all four directions a JSON number can be wrong: a non-number, a
/// negative, a fraction, and anything above 2^32-1. A coercion here would let
/// one side sign `1` and the other verify `1.0`'s neighbour, and would let a
/// hostile `epoch` of 2^53 be truncated into a value this side would act on.
public func renewUInt32(_ value: JSONValue?) -> UInt32? {
    guard case let .number(d)? = value else { return nil }
    guard d.isFinite, d >= 0, d <= RENEW_UINT32_MAX, d == d.rounded(.towardZero) else {
        return nil
    }
    return UInt32(d)
}

// MARK: - the five inner messages

/// `sdpType`, closed. `pranswer` is deliberately absent: this migration
/// exchanges exactly one offer and one answer.
public enum RelayRenewSDPType: String, Equatable, Sendable, CaseIterable {
    case offer
    case answer
}

/// Why an epoch was given up on. Closed, and diagnostic only — an abort voids
/// the epoch and PRESERVES the old deadline whatever it says.
public enum RelayRenewAbortReason: String, Equatable, Sendable, CaseIterable {
    case denied
    case unavailable
    case timeout
    case sdp
    case closed
}

/// One renewal message, with the EXACT field set its type carries.
///
/// An enum rather than a struct with optionals, because the key sets are exact
/// (spec §3.2) and "a `prepare` that happens to carry a round" must be
/// unrepresentable rather than merely rejected in one parser.
public enum RelayRenewMessage: Equatable, Sendable {
    case prepare(epoch: UInt32)
    case ready(epoch: UInt32, round: UInt32)
    case sdp(epoch: UInt32, round: UInt32, sdpType: RelayRenewSDPType, sdp: String)
    /// `sdpMid` and `sdpMLineIndex` are nullable but NOT omittable, and
    /// `usernameFragment` is non-empty. See `relayRenewPayload`.
    case ice(epoch: UInt32,
             round: UInt32,
             candidate: String,
             sdpMid: String?,
             sdpMLineIndex: UInt32?,
             usernameFragment: String)
    case abort(epoch: UInt32, reason: RelayRenewAbortReason)

    /// The epoch every message carries, which is what `RelayRenewController`
    /// filters on before it spends anything.
    public var epoch: UInt32 {
        switch self {
        case let .prepare(epoch): return epoch
        case let .ready(epoch, _): return epoch
        case let .sdp(epoch, _, _, _): return epoch
        case let .ice(epoch, _, _, _, _, _): return epoch
        case let .abort(epoch, _): return epoch
        }
    }

    /// The round, for the four messages that name one. A `prepare` and an
    /// `abort` do not: a prepare precedes the round being known, and an abort
    /// is terminal for the epoch whatever round it belonged to.
    public var round: UInt32? {
        switch self {
        case let .ready(_, round): return round
        case let .sdp(_, round, _, _): return round
        case let .ice(_, round, _, _, _, _): return round
        case .prepare, .abort: return nil
        }
    }
}

// MARK: - the signed payloads (spec §3.3)

/// The exact bytes a renewal tag covers.
///
/// Hand-serialised with a fixed key order, for the reason `authPayload`
/// records: `JSONEncoder` on Darwin routes keyed containers through
/// `JSONSerialization`, whose key order is not stable across calls, and a tag
/// is only meaningful over stable bytes.
///
/// `from`/`to` are the established peer ids as each side knows them and are
/// deliberately NOT carried in the envelope — they come from the signalling
/// context, so a relay that reflects a message back at its sender verifies the
/// reversed tuple and fails. The fixture pins that with its
/// "reversed direction is a different payload" vector.
///
/// The `kind` field is the domain separator. It makes every one of these
/// strings unreachable from `linkLeavePayload` and from `authPayload` — whose
/// output always begins with `sdpType` — so a signature over one can never be
/// mistaken for a signature over another.
public func relayRenewPayload(_ message: RelayRenewMessage, from: String, to: String) -> String {
    let head = { (kind: String, epoch: UInt32) -> String in
        "{\"kind\":\"\(kind)\",\"from\":\"\(escapeJSONStringValue(from))\""
            + ",\"to\":\"\(escapeJSONStringValue(to))\",\"epoch\":\(epoch)"
    }
    switch message {
    case let .prepare(epoch):
        return head("link-renew-prepare", epoch) + "}"
    case let .ready(epoch, round):
        return head("link-renew-ready", epoch) + ",\"round\":\(round)}"
    case let .sdp(epoch, round, sdpType, sdp):
        return head("link-renew-sdp", epoch)
            + ",\"round\":\(round),\"sdpType\":\"\(sdpType.rawValue)\""
            + ",\"sdp\":\"\(escapeJSONStringValue(sdp))\"}"
    case let .ice(epoch, round, candidate, sdpMid, sdpMLineIndex, usernameFragment):
        // Explicit `null` rather than an omitted key, and that is the whole
        // decision: an encoder that dropped an absent optional would render a
        // payload the signer's tag cannot cover, and the three ports would
        // disagree about exactly the messages that carry a relay candidate.
        let mid = sdpMid.map { "\"\(escapeJSONStringValue($0))\"" } ?? "null"
        let index = sdpMLineIndex.map { String($0) } ?? "null"
        return head("link-renew-ice", epoch)
            + ",\"round\":\(round)"
            + ",\"candidate\":\"\(escapeJSONStringValue(candidate))\""
            + ",\"sdpMid\":\(mid),\"sdpMLineIndex\":\(index)"
            + ",\"usernameFragment\":\"\(escapeJSONStringValue(usernameFragment))\"}"
    case let .abort(epoch, reason):
        return head("link-renew-abort", epoch) + ",\"reason\":\"\(reason.rawValue)\"}"
    }
}

// MARK: - the envelope (spec §3.1)

/// Every key the outer envelope is allowed to carry — exactly three.
private let RELAY_RENEW_ENVELOPE_KEYS: Set<String> = ["link", "renew", "auth"]

/// Build the outer `{link, renew, auth}` envelope for one message.
///
/// SDP and ICE are nested inside `renew` and NEVER appear at the top level.
/// `LinkSignalPolicy` filters inbound signals by GENERATION, not by kind, so a
/// renewal message on the `link` generation is also seen by any establishment
/// in flight for that peer: a top-level `sdp` would be applied by the ordinary
/// handler as a real, unauthenticated renegotiation against a live
/// PeerConnection, and a top-level `ice` would be added to it. Nesting is what
/// makes this frame inert everywhere except the renewal controller.
public func relayRenewSignal(_ message: RelayRenewMessage, auth: String) -> JSONValue {
    var inner: [String: JSONValue] = [:]
    switch message {
    case let .prepare(epoch):
        inner["type"] = .string("prepare")
        inner["epoch"] = .number(Double(epoch))
    case let .ready(epoch, round):
        inner["type"] = .string("ready")
        inner["epoch"] = .number(Double(epoch))
        inner["round"] = .number(Double(round))
    case let .sdp(epoch, round, sdpType, sdp):
        inner["type"] = .string("sdp")
        inner["epoch"] = .number(Double(epoch))
        inner["round"] = .number(Double(round))
        inner["sdpType"] = .string(sdpType.rawValue)
        inner["sdp"] = .string(sdp)
    case let .ice(epoch, round, candidate, sdpMid, sdpMLineIndex, usernameFragment):
        inner["type"] = .string("ice")
        inner["epoch"] = .number(Double(epoch))
        inner["round"] = .number(Double(round))
        inner["candidate"] = .string(candidate)
        // Present with an explicit null, never omitted — the same decision the
        // signed payload makes, for the same reason.
        inner["sdpMid"] = sdpMid.map { JSONValue.string($0) } ?? .null
        inner["sdpMLineIndex"] = sdpMLineIndex.map { JSONValue.number(Double($0)) } ?? .null
        inner["usernameFragment"] = .string(usernameFragment)
    case let .abort(epoch, reason):
        inner["type"] = .string("abort")
        inner["epoch"] = .number(Double(epoch))
        inner["reason"] = .string(reason.rawValue)
    }
    return .object(["link": .bool(true), "renew": .object(inner), "auth": .string(auth)])
}

/// A renewal envelope recognised by EXACT shape, with its tag, before anything
/// cryptographic runs.
public struct RelayRenewEnvelope: Equatable, Sendable {
    public let message: RelayRenewMessage
    /// The 44-character padded base64 tag, length-checked already.
    public let auth: String

    public init(message: RelayRenewMessage, auth: String) {
        self.message = message
        self.auth = auth
    }
}

/// Is this signal shaped like a renewal envelope at all?
///
/// Deliberately separate from `parsedRelayRenewEnvelope` and deliberately
/// cheap. A caller that routes signals needs to know "this is renewal's, keep
/// it away from the establishment handler" for a malformed envelope too — a
/// hostile `{link, renew, auth}` whose inner object is junk must not fall
/// through to a handler that would read its other keys.
public func isRelayRenewEnvelope(_ data: JSONValue) -> Bool {
    guard case let .object(fields) = data else { return false }
    guard case .bool(true)? = fields["link"] else { return false }
    guard fields["renew"] != nil else { return false }
    return fields.count == RELAY_RENEW_ENVELOPE_KEYS.count
        && Set(fields.keys) == RELAY_RENEW_ENVELOPE_KEYS
}

/// Parse one renewal envelope, strictly, before any HMAC.
///
/// Every check here is cheap and every one is a refusal (spec §10). The
/// allow-list on both the outer and the inner object is the point rather than a
/// formality: this message rides the `link` generation, so an establishment in
/// flight for the same peer sees it too, and a smuggled `sdp`, `ice`, `commit`,
/// `caps` or `leave` would be acted on by a handler that never heard of
/// renewal.
public func parsedRelayRenewEnvelope(_ data: JSONValue) -> RelayRenewEnvelope? {
    guard case let .object(fields) = data else { return nil }
    guard case .bool(true)? = fields["link"] else { return nil }
    guard fields.count == RELAY_RENEW_ENVELOPE_KEYS.count,
          Set(fields.keys) == RELAY_RENEW_ENVELOPE_KEYS else { return nil }
    // Length before decode, so a flood cannot buy a base64 pass or an HMAC.
    guard case let .string(auth)? = fields["auth"], auth.count == RENEW_AUTH_LENGTH else {
        return nil
    }
    guard case let .object(renew)? = fields["renew"] else { return nil }
    guard let message = parsedRelayRenewMessage(renew) else { return nil }
    return RelayRenewEnvelope(message: message, auth: auth)
}

/// The exact key set each inner type carries (spec §3.2). An extra or a missing
/// key is a reject, in both directions.
private let RELAY_RENEW_INNER_KEYS: [String: Set<String>] = [
    "prepare": ["type", "epoch"],
    "ready": ["type", "epoch", "round"],
    "sdp": ["type", "epoch", "round", "sdpType", "sdp"],
    "ice": ["type", "epoch", "round", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"],
    "abort": ["type", "epoch", "reason"],
]

func parsedRelayRenewMessage(_ renew: [String: JSONValue]) -> RelayRenewMessage? {
    guard case let .string(type)? = renew["type"] else { return nil }
    // The type table is closed, and the key set is checked against THIS type's
    // before a single field is read.
    guard let expected = RELAY_RENEW_INNER_KEYS[type] else { return nil }
    guard renew.count == expected.count, Set(renew.keys) == expected else { return nil }
    guard let epoch = renewUInt32(renew["epoch"]) else { return nil }

    switch type {
    case "prepare":
        return .prepare(epoch: epoch)
    case "ready":
        guard let round = renewUInt32(renew["round"]) else { return nil }
        return .ready(epoch: epoch, round: round)
    case "sdp":
        guard let round = renewUInt32(renew["round"]) else { return nil }
        guard case let .string(rawType)? = renew["sdpType"],
              let sdpType = RelayRenewSDPType(rawValue: rawType) else { return nil }
        // An empty description would still cost a `setRemoteDescription`, and
        // it can never be one this side should apply.
        guard case let .string(sdp)? = renew["sdp"], !sdp.isEmpty else { return nil }
        return .sdp(epoch: epoch, round: round, sdpType: sdpType, sdp: sdp)
    case "ice":
        guard let round = renewUInt32(renew["round"]) else { return nil }
        guard case let .string(candidate)? = renew["candidate"], !candidate.isEmpty else {
            return nil
        }
        // Nullable but NOT omittable: the key must be PRESENT. The exact-key
        // check above already refuses an omission, and reading `.null`
        // explicitly here is what keeps that true if the key set ever moves.
        let mid: String?
        switch renew["sdpMid"] {
        case let .string(value)?: mid = value
        case .null?: mid = nil
        default: return nil
        }
        let index: UInt32?
        switch renew["sdpMLineIndex"] {
        case .null?: index = nil
        default:
            guard let value = renewUInt32(renew["sdpMLineIndex"]) else { return nil }
            index = value
        }
        // A candidate whose generation cannot be named cannot be bound to an
        // epoch, and an unbindable candidate is dropped rather than guessed at.
        guard case let .string(ufrag)? = renew["usernameFragment"], !ufrag.isEmpty else {
            return nil
        }
        return .ice(epoch: epoch, round: round, candidate: candidate,
                    sdpMid: mid, sdpMLineIndex: index, usernameFragment: ufrag)
    case "abort":
        guard case let .string(rawReason)? = renew["reason"],
              let reason = RelayRenewAbortReason(rawValue: rawReason) else { return nil }
        return .abort(epoch: epoch, reason: reason)
    default:
        return nil
    }
}

// MARK: - the server exchange (spec §2)

/// The signalling envelope type a client sends to ask for a round.
public let RELAY_RENEW_REQUEST_TYPE = "ice-renew"
/// The signalling envelope type the server answers with.
public let RELAY_RENEW_GRANT_TYPE = "ice-grant"

/// `data` for one `ice-renew`, carrying EXACTLY two keys.
public func relayRenewRequestData(round: UInt32, rid: UInt32) -> JSONValue {
    .object(["round": .number(Double(round)), "rid": .number(Double(rid))])
}

/// What the server said about one round.
public enum RelayRenewGrantStatus: String, Equatable, Sendable, CaseIterable {
    /// Credentials issued for `round`. Apply them and continue the epoch.
    case granted
    /// Policy refused. TERMINAL for this round; keep the old deadline.
    case denied
    /// The server could not answer right now. Bounded retry allowed.
    case unavailable
    /// This client asked for the wrong round; `round` is the server's current
    /// one. Re-ask for that round to retrieve the cached result.
    case stale
}

/// One `ice-grant` reply, parsed strictly.
///
/// `reason` is an optional diagnostic enum. It is NEVER routed on and NEVER
/// shown to a user as prose — the field exists so a log can say why, not so a
/// client can act on a string a server chose.
/// Not `Sendable`, for the reason `RelayRenewEffect` records: it carries an
/// `ICEConfig`, which is not, and it is handled on one serial queue.
public struct RelayRenewGrant: Equatable {
    public let status: RelayRenewGrantStatus
    public let round: UInt32
    public let rid: UInt32
    /// Present only for `granted`, in EXACTLY the `/api/ice` shape — there is
    /// no second credential format and no second parser.
    public let config: ICEConfig?
    /// The `/api/ice` `quota`/`unverified` vocabulary, for `denied`.
    public let relayDenied: String?
    public let reason: String?

    public init(status: RelayRenewGrantStatus,
                round: UInt32,
                rid: UInt32,
                config: ICEConfig? = nil,
                relayDenied: String? = nil,
                reason: String? = nil) {
        self.status = status
        self.round = round
        self.rid = rid
        self.config = config
        self.relayDenied = relayDenied
        self.reason = reason
    }
}

/// Parse one `ice-grant` payload.
///
/// Deliberately NOT an exact-key check, unlike the link envelope: this reply
/// comes from the hub rather than from a peer over a broadcast surface, it is
/// not fed to any other handler, and the spec reserves room for later
/// diagnostic fields. What IS strict is everything a client acts on — the
/// status enum is closed, both integers are exact `uint32`, and a reply that
/// cannot be correlated is not a reply.
///
/// A `granted` whose configuration does not survive the SAME sanitiser a
/// hostile `/api/ice` body goes through is not a grant: it is refused here
/// rather than reaching `relayDeadline`, which would otherwise derive a
/// boundary from something the server never issued.
public func parsedRelayRenewGrant(_ data: JSONValue) -> RelayRenewGrant? {
    guard case let .object(fields) = data else { return nil }
    guard case let .string(rawStatus)? = fields["status"],
          let status = RelayRenewGrantStatus(rawValue: rawStatus) else { return nil }
    guard let round = renewUInt32(fields["round"]),
          let rid = renewUInt32(fields["rid"]) else { return nil }

    var config: ICEConfig?
    if status == .granted {
        guard let parsed = relayRenewICEConfig(fields) else { return nil }
        config = parsed
    }
    var relayDenied: String?
    if case let .string(value)? = fields["relayDenied"] { relayDenied = value }
    var reason: String?
    if case let .string(value)? = fields["reason"] { reason = value }
    return RelayRenewGrant(status: status, round: round, rid: rid,
                           config: config, relayDenied: relayDenied, reason: reason)
}

/// `iceServers` and the optional `relays` pool out of a grant, in exactly the
/// `/api/ice` shape.
///
/// Routed through `parseICEConfig` — the same bytes, the same decoder, the same
/// refusal of an empty `iceServers` — by re-encoding the two fields rather than
/// hand-rolling a second parser. A second parser is precisely the thing spec
/// §2.2 forbids: it is where the two formats would drift, and the drift would
/// be invisible until a credential shape changed.
private func relayRenewICEConfig(_ fields: [String: JSONValue]) -> ICEConfig? {
    var body: [String: JSONValue] = [:]
    guard let servers = fields["iceServers"] else { return nil }
    body["iceServers"] = servers
    if let relays = fields["relays"] { body["relays"] = relays }
    guard let encoded = try? JSONEncoder().encode(JSONValue.object(body)) else { return nil }
    return try? parseICEConfig(encoded)
}
