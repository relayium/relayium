import XCTest
@testable import RelayiumKit

/// The wire vocabulary of `link/1`, pinned against the deployed Web
/// implementation (`web/src/lib/peer-link.svelte.ts`, `webrtc.ts`,
/// `webrtc-core.ts`, `peer-caps.svelte.ts`).
///
/// Every assertion here is an interop claim, not a style preference: a native
/// peer that disagrees with any of them either fails to connect to a browser or
/// — worse — connects and then desynchronises a nonce sequence. They are exact
/// on purpose. `"link/2"` must never be read as this protocol, and the two lane
/// labels are the identity of the connection rather than decoration.
final class LinkProtocolTests: XCTestCase {

    // MARK: - capability and lane identity

    func testCapabilityStringIsExact() {
        XCTAssertEqual(LINK_CAPABILITY, "link/1")
    }

    func testLaneLabelsMatchWebPrimaryFirst() {
        XCTAssertEqual(LINK_FILE_CHANNEL, "relayium")
        XCTAssertEqual(LINK_TEXT_CHANNEL, "relayium-text")
        XCTAssertEqual(LINK_CHANNEL_LABELS, ["relayium", "relayium-text"])
    }

    // MARK: - deterministic role

    func testLexicographicallySmallerPeerIsInitiator() {
        XCTAssertEqual(linkRole(selfId: "aaa", peerId: "bbb"), .initiator)
        XCTAssertEqual(linkRole(selfId: "bbb", peerId: "aaa"), .responder)
    }

    /// Ids are opaque hub-issued strings; comparison is over their bytes, so a
    /// longer id that shares a prefix is still the larger one.
    func testRoleUsesPlainOrderingIncludingPrefixes() {
        XCTAssertEqual(linkRole(selfId: "abc", peerId: "abcd"), .initiator)
        XCTAssertEqual(linkRole(selfId: "abcd", peerId: "abc"), .responder)
    }

    /// A peer id equal to our own cannot happen in a real room (the hub issues
    /// one id per socket), but the function must stay total rather than trap.
    func testEqualIdsResolveToResponder() {
        XCTAssertEqual(linkRole(selfId: "same", peerId: "same"), .responder)
    }

    // MARK: - generation tagging

    func testLinkSignalsCarryTheLinkGeneration() {
        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: "Yw==", caps: [TEXT_CAPABILITY, LINK_CAPABILITY])
        XCTAssertEqual(signalGeneration(offer), .link)
        XCTAssertEqual(parseSDP(offer)?.type, "offer")
        XCTAssertEqual(peerCaps(from: offer), [TEXT_CAPABILITY, LINK_CAPABILITY])
    }

    func testLinkRequestIsRecognisedAndCarriesNoSDP() {
        let request = linkRequestSignal()
        XCTAssertTrue(isLinkRequest(request))
        XCTAssertNil(parseSDP(request))
        XCTAssertEqual(signalGeneration(request), .link)
        // A request must never be mistaken for an offer that opens a session.
        XCTAssertNil(inboundOfferGeneration(request))
    }

    func testLinkBusyIsRecognisedOnlyOnTheLinkGeneration() {
        XCTAssertTrue(isLinkBusy(linkBusySignal()))
        // A legacy untagged busy belongs to the file generation and must not
        // fail a link request.
        XCTAssertFalse(isLinkBusy(busySignal()))
    }

    func testLinkOfferRequiresAnOfferAndRejectsResume() {
        let offer = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil, caps: [])
        XCTAssertTrue(isLinkOffer(offer))
        let answer = linkSDPSignal(kind: "answer", sdp: "v=0", commit: nil, caps: [])
        XCTAssertFalse(isLinkOffer(answer))
        // `resume` outranks `link` in signalGeneration, exactly as on the web.
        guard case var .object(fields) = offer else { return XCTFail("offer shape") }
        fields["resume"] = .bool(true)
        XCTAssertFalse(isLinkOffer(.object(fields)))
        XCTAssertEqual(signalGeneration(.object(fields)), .resume)
    }

    // MARK: - leave, by exact shape

    func testLeaveSignalRoundTripsAndIsExactlyThreeFields() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        let signal = linkLeaveSignal(auth: auth)
        XCTAssertEqual(parsedLinkLeaveAuth(signal), auth)
        guard case let .object(fields) = signal else { return XCTFail("leave shape") }
        XCTAssertEqual(Set(fields.keys), ["link", "leave", "auth"])
    }

    /// The allow-list is the point. A leave rides the `link` generation, so any
    /// extra field would also be visible to the establishment handlers that
    /// share it — a smuggled `sdp`, `commit` or `caps` must make the whole
    /// message inert rather than half-interpreted.
    func testLeaveWithAnyExtraFieldIsRejected() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        for smuggled in ["sdp", "commit", "caps", "ice", "busy", "linkRequest"] {
            guard case var .object(fields) = linkLeaveSignal(auth: auth) else { return XCTFail("shape") }
            fields[smuggled] = .bool(true)
            XCTAssertNil(parsedLinkLeaveAuth(.object(fields)),
                         "a leave carrying \(smuggled) must not be honoured")
        }
    }

    func testLeaveRejectsWrongLengthAuthBeforeAnyHMAC() {
        for length in [0, 43, 45, 128] {
            let signal = linkLeaveSignal(auth: String(repeating: "A", count: length))
            XCTAssertNil(parsedLinkLeaveAuth(signal),
                         "auth of \(length) chars must be refused on shape alone")
        }
    }

    func testLeaveRequiresBothFlags() {
        let auth = String(repeating: "A", count: LINK_LEAVE_AUTH_LENGTH)
        XCTAssertNil(parsedLinkLeaveAuth(.object(["link": .bool(true), "auth": .string(auth)])))
        XCTAssertNil(parsedLinkLeaveAuth(.object(["leave": .bool(true), "auth": .string(auth)])))
    }

    // MARK: - the exact bytes a tag covers

    /// Byte-pinned to `webrtc-core.ts`'s `linkLeavePayload`. Key order and the
    /// `kind` discriminator are both load-bearing: the discriminator is what
    /// makes this string unreachable from `authPayload`, whose output always
    /// begins with `sdpType`.
    func testLeavePayloadMatchesWebByteForByte() {
        XCTAssertEqual(linkLeavePayload(from: "peer-a", to: "peer-b"),
                       #"{"kind":"link-leave","from":"peer-a","to":"peer-b"}"#)
    }

    /// A relay that reflects a leave back at its sender must verify the
    /// reversed tuple and fail.
    func testLeavePayloadIsDirectional() {
        XCTAssertNotEqual(linkLeavePayload(from: "a", to: "b"),
                          linkLeavePayload(from: "b", to: "a"))
    }

    func testLeavePayloadCannotCollideWithResumeAuthPayload() {
        let leave = linkLeavePayload(from: "a", to: "b")
        let resume = authPayload(linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil, caps: []))
        XCTAssertNotEqual(leave, resume)
        XCTAssertTrue(resume.hasPrefix(#"{"sdpType""#))
    }

    /// Byte-pinned to `webrtc-core.ts`'s `authPayload`: the field list is
    /// explicit so that adding a signal field cannot silently change what a
    /// resume tag covers. `caps` in particular is deliberately outside it.
    func testAuthPayloadCoversExactlyTheSixTransportFields() {
        let signal = linkSDPSignal(kind: "offer", sdp: "v=0\r\n", commit: "Yw==", caps: ["link/1"])
        XCTAssertEqual(
            authPayload(signal),
            #"{"sdpType":"offer","sdp":"v=0\r\n","candidate":null,"sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}"#
        )
    }

    func testAuthPayloadCoversICEFields() {
        let ice = taggedSignal(
            iceSignal("candidate:1 1 udp 1 10.0.0.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0),
            generation: .resume
        )
        XCTAssertEqual(
            authPayload(ice),
            #"{"sdpType":null,"sdp":null,"candidate":"candidate:1 1 udp 1 10.0.0.1 1 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":null}"#
        )
    }

    // MARK: - escaping, byte-for-byte against JSON.stringify

    /// The web signs `JSON.stringify(...)`; this client hand-rolls the same
    /// bytes, because `JSONEncoder` on Darwin routes keyed containers through
    /// `JSONSerialization`, whose key order is not stable across calls. That
    /// trade buys stable key order and owes an exact escaper in return — and an
    /// SDP is peer-authored text that really does carry quotes, backslashes and
    /// control characters.
    ///
    /// Every expectation below was produced by running the deployed
    /// `authPayload` body under Node and pasting the result, not by reading this
    /// implementation back to itself.
    ///
    /// The specific rules being pinned: `"` and `\` escape; `\b \t \n \f \r`
    /// take their short forms; every other scalar under U+0020 becomes
    /// lower-case `\u00xx`; and U+007F (DEL) is NOT escaped, which is the one
    /// place a "escape the control characters" instinct diverges from
    /// `JSON.stringify`.
    func testAuthPayloadEscapesExactlyLikeJSONStringify() {
        let sdp = "v=0\r\na=x:\"q\"\\p\u{0B}\u{1F}\u{00}\u{08}\u{09}\u{0C}\u{7F}end"
        XCTAssertEqual(
            authPayload(linkSDPSignal(kind: "offer", sdp: sdp, commit: nil, caps: [])),
            #"{"sdpType":"offer","sdp":"v=0\r\na=x:\"q\"\\p\u000b\u001f\u0000\b\t\f\#u{7F}end","candidate":null,"sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}"#
        )
    }

    /// `JSON.stringify` emits a paired surrogate as the character itself, not as
    /// two `\uXXXX` escapes. A native client that escaped it instead would sign
    /// different bytes from the browser it is talking to, and every resume tag
    /// across that link would fail to verify.
    func testAuthPayloadEmitsNonBMPScalarsLiterally() {
        XCTAssertEqual(
            authPayload(linkSDPSignal(kind: "offer", sdp: "v=0 😀é", commit: nil, caps: [])),
            #"{"sdpType":"offer","sdp":"v=0 😀é","candidate":null,"sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}"#
        )
    }

    /// `usernameFragment` rides an `RTCIceCandidateInit` and is covered by the
    /// tag even though this client never emits one, so it has to be read and
    /// escaped on the verifying side or a browser-minted tag will not verify.
    func testAuthPayloadCoversAndEscapesTheICEUsernameFragment() {
        let signal = JSONValue.object(["ice": .object([
            "candidate": .string("candidate:1 1 udp 1 10.0.0.1 1 typ host \u{01}\"\\"),
            "sdpMid": .string("0\"\\"),
            "sdpMLineIndex": .number(0),
            "usernameFragment": .string("uf\u{1B}\"\\😀"),
        ])])
        XCTAssertEqual(parseICEUsernameFragment(signal), "uf\u{1B}\"\\😀")
        XCTAssertEqual(
            authPayload(signal),
            #"{"sdpType":null,"sdp":null,"candidate":"candidate:1 1 udp 1 10.0.0.1 1 typ host \u0001\"\\","sdpMid":"0\"\\","sdpMLineIndex":0,"usernameFragment":"uf\u001b\"\\😀"}"#
        )
    }

    /// A `usernameFragment` that is absent or not a string is `null`, never an
    /// empty string: the two are different bytes, and one of them is what the
    /// browser actually signs.
    func testAbsentUsernameFragmentIsNullNotEmpty() {
        let ice = iceSignal("candidate:1", sdpMid: "0", sdpMLineIndex: 0)
        XCTAssertNil(parseICEUsernameFragment(ice))
        XCTAssertTrue(authPayload(ice).hasSuffix(#""usernameFragment":null}"#))
        guard case var .object(fields) = ice, case var .object(inner)? = fields["ice"] else {
            return XCTFail("ice shape")
        }
        inner["usernameFragment"] = .number(7)
        fields["ice"] = .object(inner)
        XCTAssertTrue(authPayload(.object(fields)).hasSuffix(#""usernameFragment":null}"#))
    }

    /// The leave payload runs through the same escaper, and its inputs are room
    /// peer ids — the field an attacker-controlled relay has the most say over.
    /// A payload that could not represent a hostile id unambiguously would let
    /// two different id pairs produce one signable string.
    func testLeavePayloadEscapesHostilePeerIds() {
        XCTAssertEqual(
            linkLeavePayload(from: "a\"\\\u{07}😀", to: "b\nc"),
            #"{"kind":"link-leave","from":"a\"\\\u0007😀","to":"b\nc"}"#
        )
        // Ambiguity check, stated directly: escaping is what keeps the tuple
        // recoverable from the bytes.
        XCTAssertNotEqual(linkLeavePayload(from: "a\",\"to\":\"b", to: "c"),
                          linkLeavePayload(from: "a", to: "b"))
    }

    /// The tag is over the payload; a rewritten SDP must not verify under a tag
    /// minted for the original.
    func testResumeTagBindsTheSignalItCovers() {
        let key = [UInt8](repeating: 7, count: 32)
        let original = linkSDPSignal(kind: "offer", sdp: "v=0", commit: nil, caps: [])
        let tag = signResume(key: key, payload: authPayload(original))
        XCTAssertTrue(verifyResume(key: key, payload: authPayload(original), mac: tag))
        let tampered = linkSDPSignal(kind: "offer", sdp: "v=0 EVIL", commit: nil, caps: [])
        XCTAssertFalse(verifyResume(key: key, payload: authPayload(tampered), mac: tag))
    }

    // MARK: - text lane lifecycle bytes

    func testTextLifecycleControlBytesMatchWeb() {
        XCTAssertEqual(LINK_TEXT_REQUEST, 0xfa)
        XCTAssertEqual(LINK_TEXT_END, 0xfb)
        // ACCEPT/REJECT stay the shared transfer.ts bytes; the label scopes them.
        XCTAssertEqual(RealtimeControl.accept.rawValue, 0xfe)
        XCTAssertEqual(RealtimeControl.reject.rawValue, 0xff)
    }

    func testTextLifecycleKindParsesOnlySingleByteFrames() {
        XCTAssertEqual(linkTextLifecycleKind([0xfa]), .request)
        XCTAssertEqual(linkTextLifecycleKind([0xfb]), .end)
        XCTAssertEqual(linkTextLifecycleKind([0xfe]), .accept)
        XCTAssertEqual(linkTextLifecycleKind([0xff]), .reject)
        XCTAssertNil(linkTextLifecycleKind([0xfa, 0x00]))
        XCTAssertNil(linkTextLifecycleKind([]))
        XCTAssertNil(linkTextLifecycleKind([0x09]))
        // COMPLETE belongs to the file lane and must not be read here.
        XCTAssertNil(linkTextLifecycleKind([0xfd]))
    }

    /// The demux discriminator. A kind-9 frame is structurally disjoint from
    /// every file-lane kind and from the one-byte controls.
    func testTextFrameDiscriminatorRequiresKindAndMinimumLength() {
        var frame: [UInt8] = [RealtimeKind.text, 0, 0, 0, 0]
        XCTAssertFalse(isLinkTextFrame(frame), "a header with no tag is not a frame")
        frame.append(contentsOf: [UInt8](repeating: 0, count: 16))
        XCTAssertTrue(isLinkTextFrame(frame))
        frame[0] = RealtimeKind.chunk
        XCTAssertFalse(isLinkTextFrame(frame))
    }
}
