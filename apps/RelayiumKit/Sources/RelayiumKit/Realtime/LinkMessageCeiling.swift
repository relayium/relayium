import Foundation

/// The per-message ceiling one `link/1` transport negotiated, read out of the
/// peer's SDP.
///
/// ## Why this file exists at all
///
/// SCTP negotiates a maximum message size, and a `send()` above it does not
/// truncate — the channel errors or closes and the transfer dies with it. The
/// number is **not** a constant of the local stack: per RFC 8841 §6 it is what
/// the REMOTE advertised in its `m=application` section, so a peer on an old
/// WebView drags the ceiling down for the Mac that is sending to it.
///
/// The web reads that number straight off `RTCPeerConnection.sctp.maxMessageSize`
/// (`web/src/lib/wire-limit.ts`). The Objective-C WebRTC SDK this package links
/// exposes no SCTP transport and no `maxMessageSize` at all — there is no
/// `sctp` property and no header naming one — so on Apple the only place the
/// negotiated value exists is the remote description itself. Hence a parser,
/// and hence a PURE one: it takes a string and returns a number, so every rule
/// below is reachable from a unit test without a PeerConnection, an offer
/// exchange or a peer.
///
/// ## The answers, and why each is the safe one
///
/// Every unreadable case answers `LINK_CONSERVATIVE_MAX_MESSAGE_BYTES` rather
/// than a local default. Guessing HIGH is the dangerous direction: it produces
/// frames the peer's channel refuses, and a refused frame on either lane has
/// already spent a nonce. Guessing low only costs fragmentation.
///
/// Pinned against `web/src/lib/wire-limit.ts`, which makes the same three
/// choices — honour an explicit "no limit", floor everything unreadable, and
/// never treat `0`-as-unknown.

/// The RFC 8841 §6 default: what a peer that advertises nothing can receive.
/// Also the answer for every SDP this parser cannot read.
///
/// The same 65 536 as the web's `CONSERVATIVE_MAX_MESSAGE_BYTES`, and for the
/// same reason: it is the one value the RFC lets both ends assume.
public let LINK_CONSERVATIVE_MAX_MESSAGE_BYTES: Double = 65_536

/// The registered attribute name, matched EXACTLY.
///
/// Case-sensitive, and that is a correctness requirement rather than pedantry.
/// RFC 8866 §5 makes SDP field values case-significant unless a field is
/// specifically exempted, and a real engine behaves accordingly: a headless
/// Chrome probe of `RTCSctpTransport.maxMessageSize` answers 262 144 for
/// `a=max-message-size:262144` and **65 536 for `a=MAX-MESSAGE-SIZE:262144`** —
/// it does not recognise the variant and falls back to the RFC default.
///
/// A parser that case-folded here would read 262 144 off a description whose
/// association is really capped at 65 536, and would then hand the lanes a
/// ceiling ABOVE what the peer can receive. Local policy does not save that:
/// `DEFAULT_MAX_FRAME_BYTES` is 192 KiB + 21, far above 65 536, so the clamp
/// would not bite and the first chunk would be refused by the peer's channel
/// after this side had already spent the nonce that sealed it.
///
/// A spelling this parser does not recognise therefore contributes NOTHING, and
/// a section carrying only such a spelling falls back to the RFC default —
/// which is exactly what the engine does with it.
private let LINK_MAX_MESSAGE_ATTRIBUTE = "max-message-size"

/// Longest digit string that is certainly inside `UInt64`. Anything longer is
/// refused rather than parsed: an overflow that wrapped would be a peer-chosen
/// number turning into a small ceiling — or a huge one — by accident.
private let LINK_MAX_MESSAGE_DIGITS = 19

/// The ceiling the peer advertised, in bytes, or the conservative floor.
///
/// - Returns: a positive number, or `.infinity` when the peer explicitly said it
///   can receive a message of any size (`a=max-message-size:0`, which RFC 8841
///   §6 defines as exactly that). `.infinity` is an ANSWER, not an absence —
///   `linkFrameCeiling` is what bounds it by what this side is willing to send.
///   Never `NaN`, never zero, never negative.
public func linkNegotiatedMaxMessageBytes(remoteSDP sdp: String) -> Double {
    var ceilings: [Double] = []
    var inSCTPApplication = false
    /// Every occurrence of the attribute in the section being read, in order.
    /// A malformed one is already the conservative floor by the time it lands
    /// here, so one list covers both ambiguity rules below.
    var section: [Double] = []

    func closeSection() {
        guard inSCTPApplication else { return }
        switch section.count {
        case 0:
            // RFC 8841 §6: a section that advertises nothing means 64 KiB.
            ceilings.append(LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
        case 1:
            ceilings.append(section[0])
        default:
            // MORE THAN ONE, which the RFC does not define. The previous rule
            // here — "ambiguous, answer the default" — is wrong in the one
            // direction that costs anything: against `8117` followed by a
            // malformed value it answered 65 536 and RAISED the ceiling above a
            // bound the peer had explicitly stated.
            //
            // A real engine last-wins: the same headless Chrome probe answers
            // 8117 for `0` then `8117`, and 262 144 for `8117` then `0`. So the
            // smallest of the default and every value present is never above
            // what such an engine settled on in the first case and is safely
            // below it in the second — and a stack that first-wins or defaults
            // instead is covered by the same bound.
            ceilings.append(([LINK_CONSERVATIVE_MAX_MESSAGE_BYTES] + section).min() ?? LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
        }
    }

    // `isNewline`, NOT `split(separator: "\n")`. SDP is CRLF on the wire and
    // CRLF is ONE Swift `Character` — an extended grapheme cluster — so
    // splitting on the LF character does not split a real description at all:
    // it returns the whole thing as a single line, no `m=` is ever seen, and
    // every genuine peer silently reads as the conservative floor. A real
    // libwebrtc offer caught exactly that; a hand-written LF-only fixture would
    // not have.
    for line in sdp.split(omittingEmptySubsequences: true, whereSeparator: { $0.isNewline }) {
        if line.hasPrefix("m=") {
            closeSection()
            // `m=<media> <port> <proto> <fmt>`. Both halves are required: the
            // attribute is only meaningful for the SCTP association, and a
            // `max-message-size` on an audio or video section says nothing about
            // what a DataChannel can carry.
            let fields = line.dropFirst(2).split(separator: " ", omittingEmptySubsequences: true)
            // The media name is compared exactly; the PROTO is not, and the
            // asymmetry is deliberate rather than an oversight of the rule
            // above. Strictness about the attribute NAME is what stops this
            // parser raising a ceiling. Strictness about which section counts
            // would do the opposite: a section wrongly skipped takes its small
            // advertisement with it and leaves the RFC default in force, which
            // is ABOVE the bound the peer stated. Leniency here can only add a
            // candidate, and candidates are combined with `min` below, so an
            // unfamiliar spelling costs fragmentation and never a refused frame.
            let proto = fields.count > 2 ? fields[2].uppercased() : ""
            inSCTPApplication = fields.first == "application"
                && proto.split(separator: "/").contains("SCTP")
            section = []
            continue
        }

        guard inSCTPApplication, line.hasPrefix("a=") else { continue }
        let attribute = line.dropFirst(2)
        guard let colon = attribute.firstIndex(of: ":"),
              attribute[..<colon] == LINK_MAX_MESSAGE_ATTRIBUTE else { continue }
        section.append(parseMaxMessageSize(attribute[attribute.index(after: colon)...]))
    }
    closeSection()

    // No SCTP application section: this description negotiated no DataChannel
    // this parser can speak for.
    guard let smallest = ceilings.min() else { return LINK_CONSERVATIVE_MAX_MESSAGE_BYTES }
    // More than one is not something the link's own offer can produce. Taking
    // the smallest rather than the first means an SDP shape this parser did not
    // anticipate costs fragmentation, never a refused frame.
    return smallest
}

/// One attribute value. Every refusal is the conservative floor.
private func parseMaxMessageSize(_ raw: Substring) -> Double {
    let value = raw.trimmingCharacters(in: .whitespaces)
    guard !value.isEmpty, value.count <= LINK_MAX_MESSAGE_DIGITS,
          value.allSatisfy({ $0.isASCII && $0.isNumber }),
          let parsed = UInt64(value) else {
        // Empty, signed, fractional, non-numeric, or longer than `UInt64` can
        // certainly hold.
        return LINK_CONSERVATIVE_MAX_MESSAGE_BYTES
    }
    // RFC 8841 §6: zero means the endpoint will handle a message of any size.
    // It is the one value that must NOT be read as "unknown" — and the one the
    // web's `negotiatedMaxMessageBytes` calls out for the same reason, from the
    // other direction.
    guard parsed != 0 else { return .infinity }
    return Double(parsed)
}

/// What this side will actually put on the wire: the smaller of what the peer
/// said it can receive and what local policy allows.
///
/// Local policy is the driver's own `maxFrameBytes` — `DEFAULT_MAX_FRAME_BYTES`
/// in production, an injected number in a test. It is a CAP, never a floor: a
/// peer advertising less always wins, and a peer advertising more (or none at
/// all) never raises what this side sends above the chunk size its own wire
/// format is defined in.
public func linkFrameCeiling(localPolicy: Double, negotiated: Double) -> Double {
    // A NaN negotiated value cannot come out of the parser above; it can come
    // out of a transport that has not answered. Either way it is not a limit.
    let peer = negotiated.isNaN ? LINK_CONSERVATIVE_MAX_MESSAGE_BYTES : negotiated
    // `Swift.min(x, y)` returns `x` when `y` is NaN, so a NaN LOCAL policy
    // propagates and the senders refuse it — which is what an injected NaN has
    // always meant and must keep meaning.
    return Swift.min(localPolicy, peer)
}
