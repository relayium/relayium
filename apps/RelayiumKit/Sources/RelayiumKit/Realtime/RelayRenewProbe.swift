import Foundation

/// The data-path proof frame of `relay-renew/1`: a fixed 59-byte control frame
/// on the EXISTING text DataChannel that consumes no AEAD sequence and changes
/// no file or text semantics.
///
/// ## Why a dedicated frame and not the text codec
///
/// Routing this handshake through ordinary kind-9 content would be a hard
/// failure on all three clients whenever the conversation is not open — Web
/// `mixed-text-session.onData`'s `markFailed`, Android `TextLaneSession`'s
/// `CONTENT_BEFORE_ACTIVATION`, and here `LinkTextSession.admitFrame`'s
/// `failClosed` partition — and it would spend the strictly increasing text
/// `seq`. `0x0d` is outside every kind already in use (file lane 1-8, text 9,
/// fragmentation 10-11, pre-upload 12, and the `0xf8`-`0xff` lifecycle bytes),
/// and `link:§7.3` already requires a text-lane frame whose first byte is not
/// `0x09` to be SILENTLY IGNORED. That is what makes this frame safe to send to
/// a peer that has never heard of renewal.
///
/// ## Why HMAC is enough, and what it does not prove
///
/// The frame carries no secret — an epoch, a round, a random nonce. The
/// adversary that matters is a signalling-side DTLS man-in-the-middle, and it
/// cannot produce `resumeAuth`. Replay and reflection are closed by `from`/`to`,
/// `epoch`, `round`, the per-attempt random nonce, and the domain-separating
/// `kind` that makes a probe and its ack different strings.
///
/// **The tag authenticates key possession and freshness. It does NOT
/// authenticate the path.** The path evidence is the conjunction in
/// `RelayRenewController`: this side observed its selected local candidate
/// belongs to this epoch's ufrag generation, the peer only acks after its own
/// observation held, and the ack arrives after this side's observation held.
/// Nothing here may be described as proving a route.

/// The newly registered first byte. Structurally disjoint from every other kind
/// on either lane, which is what lets the demux claim it without inspecting
/// anything a peer could make ambiguous.
public let RELAY_RENEW_PROBE_KIND: UInt8 = 0x0d
public let RELAY_RENEW_PROBE_VERSION: UInt8 = 1
/// `[kind][ver][type][epoch u32BE][round u32BE][nonce 16][tag 32]`.
public let RENEW_PROBE_FRAME_BYTES = 59
public let RENEW_PROBE_NONCE_BYTES = 16
public let RENEW_PROBE_TAG_BYTES = 32

public enum RelayRenewProbeType: UInt8, Equatable, Sendable, CaseIterable {
    case probe = 1
    case ack = 2

    /// The domain separator in the signed payload. A probe and its ack are
    /// different strings, so an observed probe cannot be reflected back as its
    /// own acknowledgement.
    var payloadKind: String {
        switch self {
        case .probe: return "link-renew-probe"
        case .ack: return "link-renew-ack"
        }
    }
}

/// One parsed control frame. Structural only: nothing here has been verified,
/// and the tag is carried raw so the caller can decide — under its own budget,
/// and only after the cheap checks — whether to spend an HMAC on it.
public struct RelayRenewProbeFrame: Equatable, Sendable {
    public let type: RelayRenewProbeType
    public let epoch: UInt32
    public let round: UInt32
    public let nonce: [UInt8]
    public let tag: [UInt8]

    public init(type: RelayRenewProbeType,
                epoch: UInt32,
                round: UInt32,
                nonce: [UInt8],
                tag: [UInt8]) {
        self.type = type
        self.epoch = epoch
        self.round = round
        self.nonce = nonce
        self.tag = tag
    }

    /// The nonce as the signed payload spells it: standard RFC 4648 base64 with
    /// padding.
    public var nonceBase64: String { Data(nonce).base64EncodedString() }
}

/// The exact bytes a probe or ack tag covers.
///
/// Hand-serialised with a fixed key order for the reason `relayRenewPayload`
/// records. `from`/`to` are the established peer ids and are deliberately not
/// in the frame — a relay reflecting a frame at its sender verifies the
/// reversed tuple and fails.
public func relayRenewProbePayload(type: RelayRenewProbeType,
                                   from: String,
                                   to: String,
                                   epoch: UInt32,
                                   round: UInt32,
                                   nonce: [UInt8]) -> String {
    "{\"kind\":\"\(type.payloadKind)\",\"from\":\"\(escapeJSONStringValue(from))\""
        + ",\"to\":\"\(escapeJSONStringValue(to))\",\"epoch\":\(epoch),\"round\":\(round)"
        + ",\"nonce\":\"\(Data(nonce).base64EncodedString())\"}"
}

/// Serialise one control frame. `tag` must already be the raw 32-byte HMAC.
public func relayRenewProbeFrame(type: RelayRenewProbeType,
                                 epoch: UInt32,
                                 round: UInt32,
                                 nonce: [UInt8],
                                 tag: [UInt8]) -> [UInt8]? {
    guard nonce.count == RENEW_PROBE_NONCE_BYTES, tag.count == RENEW_PROBE_TAG_BYTES else {
        return nil
    }
    var out: [UInt8] = []
    out.reserveCapacity(RENEW_PROBE_FRAME_BYTES)
    out.append(RELAY_RENEW_PROBE_KIND)
    out.append(RELAY_RENEW_PROBE_VERSION)
    out.append(type.rawValue)
    out.append(contentsOf: bigEndianBytes(epoch))
    out.append(contentsOf: bigEndianBytes(round))
    out.append(contentsOf: nonce)
    out.append(contentsOf: tag)
    return out
}

private func bigEndianBytes(_ value: UInt32) -> [UInt8] {
    [UInt8(truncatingIfNeeded: value >> 24),
     UInt8(truncatingIfNeeded: value >> 16),
     UInt8(truncatingIfNeeded: value >> 8),
     UInt8(truncatingIfNeeded: value)]
}

/// Whether one text-lane frame belongs to renewal AT ALL.
///
/// Deliberately the kind byte alone, and deliberately separate from the parse.
/// This is the demux's question, and its answer must not depend on anything a
/// peer can make ambiguous: a frame whose first byte is `0x0d` is not a text
/// frame (`isLinkTextFrame` requires `0x09`), is not a lifecycle control, and
/// is not routable to anything else, so claiming it here is what keeps a
/// malformed renewal frame away from the text session's rate budget and
/// activity clock as well. Whether it is WELL-FORMED is
/// `parsedRelayRenewProbeFrame`'s question, and a malformed one is dropped in
/// silence rather than handed on.
public func isRelayRenewProbeFrame(_ frame: [UInt8]) -> Bool {
    frame.first == RELAY_RENEW_PROBE_KIND
}

/// Parse one control frame, structurally, before any HMAC.
///
/// The verification order spec §6.4 fixes starts here: length, kind byte,
/// version, type. Epoch/round matching, the per-epoch budget and the HMAC are
/// all the controller's, in that order, and every one of them is cheaper than
/// the one after it.
public func parsedRelayRenewProbeFrame(_ frame: [UInt8]) -> RelayRenewProbeFrame? {
    guard frame.count == RENEW_PROBE_FRAME_BYTES else { return nil }
    guard frame[0] == RELAY_RENEW_PROBE_KIND else { return nil }
    guard frame[1] == RELAY_RENEW_PROBE_VERSION else { return nil }
    guard let type = RelayRenewProbeType(rawValue: frame[2]) else { return nil }
    let epoch = UInt32(frame[3]) << 24 | UInt32(frame[4]) << 16
        | UInt32(frame[5]) << 8 | UInt32(frame[6])
    let round = UInt32(frame[7]) << 24 | UInt32(frame[8]) << 16
        | UInt32(frame[9]) << 8 | UInt32(frame[10])
    return RelayRenewProbeFrame(type: type,
                                epoch: epoch,
                                round: round,
                                nonce: Array(frame[11..<27]),
                                tag: Array(frame[27..<59]))
}

// MARK: - the front demux

/// What the text lane's front demux decided about one inbound frame.
public enum RelayRenewDemuxDisposition: Equatable, Sendable {
    /// Not renewal's. Hand it on to the text session unchanged.
    case pass
    /// Claimed and consumed. It must NOT also reach the text session — not its
    /// activity clock, not its rate budget, and under no circumstances its AEAD
    /// receiver.
    case consume
}

/// The single-slot front demux installed at the lanes' atomic attach point.
///
/// ## Why a true front demux and not an observer
///
/// An additive observer cannot STOP a frame from also reaching the session, and
/// stopping it is the entire requirement: a renewal frame that reached the text
/// session would (on the ports that keep one there) reset a ten-minute idle
/// timer this feature is explicitly forbidden from touching, and would spend an
/// inbound rate token a burst could then fail the lane on.
///
/// ## Lifetime is the TRANSPORT's, not the conversation's
///
/// It is installed where `LinkLaneOwner` builds the file driver's `onTextFrame`
/// route, which is the same atomic point the two lanes are attached at, so
/// frames replayed from `link:§2.2` pre-attachment capture — including across a
/// `link:§8` rebuild — go through exactly this routing. With no handler
/// installed a claimed frame is DROPPED and never replayed: a control frame
/// nobody is listening for is not a message, and holding it would be a buffer a
/// peer controls.
///
/// Thread-safe: WebRTC delivers on its own threads, and the handler is
/// installed and cleared from the controller's lifetime.
public final class RelayRenewProbeDemux: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((RelayRenewProbeFrame) -> Void)?

    public init() {}

    /// Install or clear the renewal handler. Idempotent and last-writer-wins:
    /// one controller owns one transport's renewal at a time, and a controller
    /// closing after its successor installed must not be able to erase the
    /// successor — so callers clear through `remove(_:)`, not through `nil`.
    public func install(_ handler: @escaping (RelayRenewProbeFrame) -> Void) {
        lock.lock(); defer { lock.unlock() }
        self.handler = handler
    }

    /// Drop the handler. A frame claimed after this is consumed and discarded,
    /// which is the documented no-listener behaviour — never forwarded to the
    /// text session as a second chance.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        handler = nil
    }

    /// Route one text-lane frame. Called on WebRTC's delivery thread, ahead of
    /// `LinkTextDriver.admitTextFrame`.
    public func route(_ frame: [UInt8]) -> RelayRenewDemuxDisposition {
        guard isRelayRenewProbeFrame(frame) else { return .pass }
        // Claimed on the kind byte. Everything below may fail; none of it may
        // turn this back into a frame the text session sees.
        lock.lock()
        let handler = self.handler
        lock.unlock()
        guard let handler, let parsed = parsedRelayRenewProbeFrame(frame) else { return .consume }
        handler(parsed)
        return .consume
    }
}
