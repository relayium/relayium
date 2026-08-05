import Foundation

/// The wire vocabulary of `link/1`: one authenticated connection carrying an
/// ordered file lane and an ordered text lane to one peer.
///
/// Everything here is pinned to the deployed Web implementation
/// (`web/src/lib/peer-link.svelte.ts`, `webrtc.ts`, `webrtc-core.ts`,
/// `peer-caps.svelte.ts`). A disagreement with any of it is not a style
/// difference — it is a native client that either cannot connect to a browser
/// or, worse, connects and then desynchronises an AEAD sequence.
///
/// This file deliberately contains no policy and no I/O. Which peers may be
/// offered a link, which room allows one and what happens when two peers open
/// at once all live in `LinkAdmission`; the transport lives above both.

// MARK: - identity

/// The one capability a `link/1` peer announces, matched EXACTLY.
///
/// A later, wire-incompatible dialect will call itself something else, and
/// reading `link/2` as this protocol would produce a connection whose two ends
/// disagree about the bytes on it.
public let LINK_CAPABILITY = "link/1"

/// The file lane's SCTP label. Deliberately the same label the legacy web file
/// transfer has always used, so the two share one wire format.
public let LINK_FILE_CHANNEL = "relayium"
/// The text lane's SCTP label.
public let LINK_TEXT_CHANNEL = "relayium-text"

/// The exact lanes a link carries, in primary-first order.
///
/// One constant so the first connection and an authenticated transport rebuild
/// can never disagree about which SCTP streams make up a link. A link whose
/// text lane never opened is not a degraded link — it is a link that cannot
/// honour `link/1`.
public let LINK_CHANNEL_LABELS: [String] = [LINK_FILE_CHANNEL, LINK_TEXT_CHANNEL]

/// One maximum encrypted manifest plus lifecycle overhead, combined across both
/// lanes. Deliberately far smaller than the file flow-control window:
/// pre-attachment traffic has not reached a content-consent state yet.
public let LINK_CAPTURE_MAX_BYTES = 256 * 1024

/// SHA-256 HMAC is 32 bytes, which `signResume` encodes as padded base64.
/// Checking the length before any base64 decode or HMAC also bounds the cost of
/// each verification a hostile signal can ask for.
///
/// One constant for both authenticated link tags — the leave and the resume
/// signalling tag — because they are the same primitive over different payloads.
/// Two literals would be two places to change, and a verifier that bounded one
/// but not the other is a verifier a flood can spend HMACs on.
public let LINK_AUTH_TAG_LENGTH = 44

/// The leave tag's length, which is `LINK_AUTH_TAG_LENGTH`. Kept as its own name
/// because `parsedLinkLeaveAuth` checks it as part of an EXACT message shape,
/// and that shape is a separate decision from the tag primitive.
public let LINK_LEAVE_AUTH_LENGTH = LINK_AUTH_TAG_LENGTH

/// How many leave signals one authenticated link will ever spend an HMAC on.
///
/// A leave is terminal, so a genuine peer needs one. The budget exists purely
/// so a replayed or forged tag cannot buy unbounded verification work.
/// Exhausting it costs nothing real: the link simply falls back to its recovery
/// window, which is exactly the behaviour of a peer that never sent a leave.
public let LINK_LEAVE_MAX_ATTEMPTS = 8

// MARK: - deterministic role

/// Which side offers, computed identically by both peers from their room ids.
///
/// Without this rule two users pressing at the same moment produce two SDP
/// offers into one pair of lanes. The smaller id offers; the larger id asks and
/// waits. Ids are opaque hub-issued strings, so this is a plain byte ordering —
/// and it is total (an impossible self-collision resolves to responder rather
/// than trapping).
public func linkRole(selfId: String, peerId: String) -> Role {
    selfId < peerId ? .initiator : .responder
}

// MARK: - signals

/// An SDP offer/answer on the `link` generation, carrying this build's commit
/// and capability confirmation the way `webrtc.ts`'s `sdpExtra` does.
public func linkSDPSignal(kind: String, sdp: String, commit: String?, caps: [String]) -> JSONValue {
    sdpSignal(kind: kind, sdp: sdp, commit: commit, generation: .link, caps: caps)
}

/// The content-free ask a larger-id peer sends until the smaller-id peer
/// offers. Not authenticated and not a generation of its own: capability gating
/// keeps a forged one in the same denial-of-service class as a forged caps
/// hello.
public func linkRequestSignal() -> JSONValue {
    .object(["link": .bool(true), "linkRequest": .bool(true)])
}

/// "I cannot take a link right now." Tagged, so it reaches the link lifecycle
/// rather than a legacy file initiator.
public func linkBusySignal() -> JSONValue {
    taggedSignal(busySignal(), generation: .link)
}

/// "I am leaving this link on purpose", authenticated with the link's
/// `resumeAuth` over `linkLeavePayload`.
public func linkLeaveSignal(auth: String) -> JSONValue {
    .object(["link": .bool(true), "leave": .bool(true), "auth": .string(auth)])
}

/// A fresh link offer — an SDP offer on the `link` generation that is not a
/// rebuild. `resume` outranks `link` in `signalGeneration`, so a signal
/// carrying both is a rebuild and never an establishment.
public func isLinkOffer(_ data: JSONValue) -> Bool {
    guard signalGeneration(data) == .link else { return false }
    return parseSDP(data)?.type == "offer"
}

public func isLinkRequest(_ data: JSONValue) -> Bool {
    guard case let .object(fields) = data else { return false }
    guard case .bool(true)? = fields["link"], case .bool(true)? = fields["linkRequest"] else {
        return false
    }
    return fields["sdp"] == nil
}

public func isLinkBusy(_ data: JSONValue) -> Bool {
    guard signalGeneration(data) == .link else { return false }
    return parseBusy(data)
}

/// Every key a leave signal is allowed to carry.
private let LINK_LEAVE_KEYS: Set<String> = ["link", "leave", "auth"]

/// Recognise a leave by EXACT shape, and hand back its tag, before anything
/// cryptographic runs.
///
/// The allow-list is the point, not a formality. This message rides the `link`
/// generation, which means an establishment in flight for the same peer sees it
/// too — that filter is by generation, not by message kind. A smuggled `commit`
/// would be recorded by the handshake, a `caps` array would reach the
/// capability registry, a `busy` would fail a connecting link, and `sdp`/`ice`
/// would be handled outright. Requiring exactly `{link, leave, auth}` makes the
/// signal inert everywhere except here — and makes that property testable.
public func parsedLinkLeaveAuth(_ data: JSONValue) -> String? {
    guard case let .object(fields) = data else { return nil }
    guard case .bool(true)? = fields["link"], case .bool(true)? = fields["leave"] else { return nil }
    guard case let .string(auth)? = fields["auth"], auth.count == LINK_LEAVE_AUTH_LENGTH else {
        return nil
    }
    guard fields.count == LINK_LEAVE_KEYS.count, Set(fields.keys) == LINK_LEAVE_KEYS else {
        return nil
    }
    return auth
}

// MARK: - the exact bytes a tag covers

/// The exact bytes a link-leave tag covers.
///
/// Deliberately NOT `authPayload`. A leave carries no SDP and no ICE, so
/// `authPayload` would render one constant string for the whole life of a link
/// — a tag with no direction, replayable in either direction once observed. The
/// `kind` field additionally makes this string unreachable from `authPayload`,
/// whose output always begins with `sdpType`, so a signature over one can never
/// be mistaken for a signature over the other.
///
/// `from`/`to` are the room peer ids as each side knows them, so a relay that
/// reflects a leave back at its sender verifies the reversed tuple and fails.
/// Cross-link replay needs no nonce: the key is `resumeAuth`, which a later
/// link never shares.
public func linkLeavePayload(from: String, to: String) -> String {
    "{\"kind\":\"link-leave\",\"from\":\"\(escapeJSONStringValue(from))\",\"to\":\"\(escapeJSONStringValue(to))\"}"
}

/// The exact bytes a resume tag covers, byte-pinned to `webrtc-core.ts`.
///
/// The field list is EXPLICIT rather than "the whole signal": that is what
/// stops adding a signal field from silently changing what an existing tag
/// covers. `caps` in particular is deliberately outside it — it is a hint, and
/// a hint must not be able to alter an authentication.
///
/// Hand-rolled rather than `JSONEncoder` for the reason the manifest encoder
/// records: `JSONEncoder` on Darwin routes keyed containers through
/// `JSONSerialization`, whose key order is not stable across calls, and a tag
/// is only meaningful over stable bytes.
public func authPayload(_ data: JSONValue) -> String {
    let sdp = parseSDP(data)
    let ice = parseICE(data)
    var out = "{\"sdpType\":" + jsonStringOrNull(sdp?.type)
    out += ",\"sdp\":" + jsonStringOrNull(sdp?.sdp)
    out += ",\"candidate\":" + jsonStringOrNull(ice?.candidate)
    out += ",\"sdpMid\":" + jsonStringOrNull(ice?.sdpMid)
    out += ",\"sdpMLineIndex\":" + (ice?.sdpMLineIndex.map { String($0) } ?? "null")
    out += ",\"usernameFragment\":" + jsonStringOrNull(parseICEUsernameFragment(data))
    return out + "}"
}

/// `usernameFragment` rides an `RTCIceCandidateInit` and is covered by a resume
/// tag, so it has to be readable even though this client never emits one.
public func parseICEUsernameFragment(_ data: JSONValue) -> String? {
    guard case let .object(o) = data, case let .object(ice)? = o["ice"],
          case let .string(ufrag)? = ice["usernameFragment"] else { return nil }
    return ufrag
}

private func jsonStringOrNull(_ value: String?) -> String {
    guard let value else { return "null" }
    return "\"\(escapeJSONStringValue(value))\""
}

/// Escapes exactly like JavaScript's `JSON.stringify`, so a peer id or an SDP
/// containing a quote, a backslash or a control character produces the same
/// bytes on both ends of the tag.
func escapeJSONStringValue(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out.append("\\"); out.append("\"")
        case "\\": out.append("\\"); out.append("\\")
        case "\u{08}": out.append("\\"); out.append("b")
        case "\u{09}": out.append("\\"); out.append("t")
        case "\u{0A}": out.append("\\"); out.append("n")
        case "\u{0C}": out.append("\\"); out.append("f")
        case "\u{0D}": out.append("\\"); out.append("r")
        default:
            if scalar.value < 0x20 {
                let hex = String(scalar.value, radix: 16)
                out.append("\\"); out.append("u")
                for _ in 0..<(4 - hex.count) { out.append("0") }
                out.append(contentsOf: hex.unicodeScalars)
            } else {
                out.append(scalar)
            }
        }
    }
    return String(out)
}

// MARK: - text lane lifecycle bytes

/// The text lane's conversation lifecycle controls. ACCEPT/REJECT remain the
/// shared `transfer.ts` bytes — the DataChannel label is what scopes their
/// meaning to a conversation rather than a file batch.
public let LINK_TEXT_REQUEST: UInt8 = 0xfa
public let LINK_TEXT_END: UInt8 = 0xfb

public enum LinkTextControl: Equatable, Sendable {
    case request
    case accept
    case reject
    case end
}

/// A lifecycle control is EXACTLY one byte. A longer frame that merely starts
/// with one of these values is a protected frame or a malformed one, and must
/// not be read as consent.
public func linkTextLifecycleKind(_ frame: [UInt8]) -> LinkTextControl? {
    guard frame.count == 1 else { return nil }
    switch frame[0] {
    case LINK_TEXT_REQUEST: return .request
    case LINK_TEXT_END: return .end
    case RealtimeControl.accept.rawValue: return .accept
    case RealtimeControl.reject.rawValue: return .reject
    default: return nil
    }
}

/// Cheap discriminator for the text lane's demux, structurally disjoint from
/// every file-lane kind and from the one-byte controls. A header with no room
/// for an AEAD tag is not a frame.
public func isLinkTextFrame(_ frame: [UInt8]) -> Bool {
    frame.count >= 5 + 16 && frame[0] == RealtimeKind.text
}

// MARK: - file lane lifecycle bytes

/// "The file lane is occupied." Not a refusal: the peer requeues or retries.
/// Byte-pinned to `transfer.ts`'s `CTRL_BUSY`.
public let LINK_FILE_BUSY: UInt8 = 0xf9

/// Sender -> receiver ordered barrier retiring exactly one batch.
///
/// The legacy transport expressed this by closing the whole PeerConnection. A
/// long-lived link must end only the current batch, so the independent text lane
/// and every later file batch stay usable. Byte-pinned to `transfer.ts`'s
/// `CTRL_BATCH_ABORT`.
public let LINK_FILE_BATCH_ABORT: UInt8 = 0xf8

/// The file lane's lifecycle controls.
///
/// ACCEPT/REJECT are the same two bytes the text lane uses; the DataChannel
/// label is what scopes their meaning to a file batch rather than a
/// conversation. COMPLETE, BUSY and BATCH_ABORT are the file lane's alone.
public enum LinkFileControl: Equatable, Sendable {
    /// Receiver -> sender: this batch is consented to.
    case accept
    /// Receiver -> sender: this batch is refused, or an accepted one stopped.
    case reject
    /// Receiver -> sender: the whole batch arrived and verified.
    case complete
    /// Receiver -> sender: the lane is busy; requeue rather than fail.
    case busy
    /// Sender -> receiver: an ordered barrier retiring this batch.
    case batchAbort
}

/// A lifecycle control is EXACTLY one byte.
///
/// A longer frame that merely starts with one of these values is a protected
/// frame or a malformed one, and reading it as consent is how a peer would get
/// a batch accepted without a user ever answering. The length check is the
/// whole control, not a formality.
public func linkFileLifecycleKind(_ frame: [UInt8]) -> LinkFileControl? {
    guard frame.count == 1 else { return nil }
    switch frame[0] {
    case RealtimeControl.accept.rawValue: return .accept
    case RealtimeControl.reject.rawValue: return .reject
    case RealtimeControl.complete.rawValue: return .complete
    case LINK_FILE_BUSY: return .busy
    case LINK_FILE_BATCH_ABORT: return .batchAbort
    default: return nil
    }
}

/// What one frame arriving on the file channel is, exactly.
///
/// The classes PARTITION the space: every byte string lands in exactly one, so
/// no frame can be both counted as flow control and fed to the AEAD receiver,
/// and none can be silently dropped.
public enum LinkFileFrameClass: Equatable, Sendable {
    /// One of the five one-byte controls.
    case lifecycle(LinkFileControl)
    /// A well-formed flow-control ACK header. Its VALUE still has to pass
    /// `linkFileAckTotal`, which is a separate decision from its shape.
    case ack
    /// Kind 5, INCLUDING a payload that does not parse. That distinction is the
    /// one the lane needs: a malformed resume request is control it must fail
    /// closed on, never bytes to route into the protected stream.
    case resumeRequest
    /// Kind 4, the plaintext realignment announcement.
    case resumeStart
    /// Carries a nonce and must be fed to the link's `RealtimeReceiver` in wire
    /// order. Includes the two legacy kinds deliberately: the receiver is the
    /// single place that turns those into `legacyPeer`, and a demux that
    /// swallowed them here would downgrade a loud version mismatch into silence.
    case protected
    /// Nothing this lane can route. The owner fails closed rather than guessing:
    /// on an ordered channel an unroutable frame is either corruption or a peer
    /// speaking a protocol this build does not have, and skipping one that the
    /// peer counted would strand the receiver's sequence.
    case unroutable
}

/// Route one file-channel frame, by kind and by exact shape.
///
/// Deliberately total and allocation-free: it runs on every inbound message,
/// before consent, on bytes a peer chose.
public func linkFileFrameClass(_ frame: [UInt8]) -> LinkFileFrameClass {
    if let control = linkFileLifecycleKind(frame) { return .lifecycle(control) }
    // Below the header there is no kind to dispatch on at all.
    guard frame.count >= 5 else { return .unroutable }
    switch frame[0] {
    case RealtimeKind.ack:
        // 13 bytes is part of what an ACK IS — `parseAck` refuses anything else,
        // so a kind-6 frame of another length is not one and must not fall
        // through into the protected stream either.
        return frame.count == 13 ? .ack : .unroutable
    case RealtimeKind.resumeReq:
        return .resumeRequest
    case RealtimeKind.resumeStart:
        return .resumeStart
    case RealtimeKind.chunk, RealtimeKind.chunkPart,
         RealtimeKind.batchEnc, RealtimeKind.batchPart,
         RealtimeKind.doneEnc,
         RealtimeKind.batchLegacy, RealtimeKind.doneLegacy:
        return .protected
    default:
        return .unroutable
    }
}
