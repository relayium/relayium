import XCTest
@testable import RelayiumKit

/// The exact bytes an authenticated `link/1` transport replacement puts on the
/// signalling socket, and the exact bytes it will accept back.
///
/// Everything here is pinned to the deployed web `connectResumeLink` path
/// (`web/src/lib/webrtc.ts` → `establish` in `web/src/lib/webrtc-core.ts`): the
/// `resume` generation tag, `send()`'s tag-then-sign order, and `authPayload`'s
/// explicit six-field rendering. A disagreement with any of it is a native
/// client whose rebuild a browser silently drops.
final class LinkResumeSignalTests: XCTestCase {

    private let key = [UInt8](repeating: 7, count: 32)
    private let otherKey = [UInt8](repeating: 9, count: 32)

    private func fields(_ signal: JSONValue) -> [String: JSONValue] {
        guard case let .object(o) = signal else { return [:] }
        return o
    }

    private func string(_ signal: JSONValue, _ key: String) -> String? {
        guard case let .string(s)? = fields(signal)[key] else { return nil }
        return s
    }

    // MARK: - outbound shape

    /// Exactly `{sdp, resume, auth}`. A replacement runs no commit/reveal, so a
    /// `commit` here would be a commitment to a key nobody will reveal, and a
    /// `caps` array would be a capability announcement on a connection whose
    /// capability was settled by the authentication this rebuild inherits.
    func testAResumeOfferCarriesOnlyTheSDPTheGenerationTagAndItsAuth() {
        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: key)
        XCTAssertEqual(Set(fields(signal).keys), ["sdp", "resume", "auth"])
        XCTAssertEqual(signalGeneration(signal), .resume)
        XCTAssertEqual(parseSDP(signal)?.type, "offer")
        XCTAssertEqual(parseSDP(signal)?.sdp, "v=0")
        XCTAssertNil(peerCommit(from: signal), "a replacement commits to nothing")
        XCTAssertNil(peerReveal(from: signal), "and discloses nothing")
        XCTAssertEqual(peerCaps(from: signal), [], "and announces no capability")
    }

    func testAResumeAnswerHasTheSameShape() {
        let signal = resumeSDPSignal(kind: "answer", sdp: "v=0", key: key)
        XCTAssertEqual(Set(fields(signal).keys), ["sdp", "resume", "auth"])
        XCTAssertEqual(parseSDP(signal)?.type, "answer")
    }

    func testAResumeCandidateCarriesOnlyTheCandidateTheGenerationTagAndItsAuth() {
        let signal = resumeICESignal("candidate:1 1 udp 1 10.0.0.1 5 typ host",
                                     sdpMid: "0",
                                     sdpMLineIndex: 0,
                                     key: key)
        XCTAssertEqual(Set(fields(signal).keys), ["ice", "resume", "auth"])
        XCTAssertEqual(signalGeneration(signal), .resume)
        XCTAssertEqual(parseICE(signal)?.candidate, "candidate:1 1 udp 1 10.0.0.1 5 typ host")
        XCTAssertEqual(parseICE(signal)?.sdpMid, "0")
        XCTAssertEqual(parseICE(signal)?.sdpMLineIndex, 0)
    }

    /// The tag is a base64 SHA-256 HMAC, whatever it covers.
    func testEveryTagIsAFixedLengthBase64HMAC() {
        for signal in [resumeSDPSignal(kind: "offer", sdp: "v=0", key: key),
                       resumeICESignal("c", sdpMid: nil, sdpMLineIndex: nil, key: key)] {
            let auth = string(signal, "auth")
            XCTAssertEqual(auth?.count, LINK_AUTH_TAG_LENGTH)
            XCTAssertNotNil(auth.flatMap { Data(base64Encoded: $0) })
        }
    }

    // MARK: - the bytes the tag covers

    /// The signal is FULLY TAGGED before `authPayload` is computed, exactly as
    /// `webrtc-core.ts`'s `send()` builds `out` and only then signs it.
    ///
    /// `authPayload` lists its six fields explicitly and therefore ignores the
    /// generation tag today, which is precisely why this has to be asserted
    /// against the delivered signal rather than reasoned about: the property
    /// that matters is that what the verifier recomputes over the bytes it
    /// receives is what the signer signed.
    func testTheTagCoversTheCompleteTaggedSignalAsDelivered() {
        for signal in [resumeSDPSignal(kind: "offer", sdp: "v=0\r\n", key: key),
                       resumeSDPSignal(kind: "answer", sdp: "v=0\r\n", key: key),
                       resumeICESignal("candidate:1", sdpMid: "0", sdpMLineIndex: 0, key: key)] {
            XCTAssertTrue(verifyResume(key: key, payload: authPayload(signal),
                                       mac: string(signal, "auth")),
                          "the delivered bytes must verify under the link's own key")
        }
    }

    /// Byte-pinned to `JSON.stringify` in `webrtc-core.ts`'s `authPayload`:
    /// six keys, in this order, `null` for everything the signal does not carry.
    func testTheSignedPayloadIsByteIdenticalToTheWebRendering() {
        let offer = resumeSDPSignal(kind: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n", key: key)
        XCTAssertEqual(
            authPayload(offer),
            "{\"sdpType\":\"offer\",\"sdp\":\"v=0\\r\\no=- 1 2 IN IP4 0.0.0.0\\r\\n\"," +
            "\"candidate\":null,\"sdpMid\":null,\"sdpMLineIndex\":null,\"usernameFragment\":null}")

        let ice = resumeICESignal("candidate:1 1 udp 1 10.0.0.1 5 typ host",
                                  sdpMid: "0", sdpMLineIndex: 0, key: key)
        XCTAssertEqual(
            authPayload(ice),
            "{\"sdpType\":null,\"sdp\":null," +
            "\"candidate\":\"candidate:1 1 udp 1 10.0.0.1 5 typ host\"," +
            "\"sdpMid\":\"0\",\"sdpMLineIndex\":0,\"usernameFragment\":null}")
    }

    /// The same key derivation and the same HMAC the golden vectors pin, reached
    /// through the signal builders rather than through `signResume` directly —
    /// so a builder that quietly signed something else would be caught by the
    /// vector the web is also held to.
    func testTheBuildersSignWithTheSameHMACTheGoldenVectorPins() throws {
        let v = try Vectors.load()
        let derived = deriveResumeAuth(sendKey: v.hex("session.aliceSend"),
                                       recvKey: v.hex("session.aliceRecv"))
        XCTAssertEqual(derived, v.hex("resumeAuth.keyHex"))

        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: derived)
        XCTAssertEqual(string(signal, "auth"),
                       signResume(key: v.hex("resumeAuth.keyHex"), payload: authPayload(signal)))
    }

    /// Two peers derive one key from mirrored session secrets, so each side's
    /// outbound tag verifies on the other side.
    func testEitherPeersTagVerifiesUnderTheOtherPeersDerivedKey() {
        let tx = [UInt8](repeating: 3, count: 32)
        let rx = [UInt8](repeating: 4, count: 32)
        let mine = deriveResumeAuth(sendKey: tx, recvKey: rx)
        let theirs = deriveResumeAuth(sendKey: rx, recvKey: tx)

        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: mine)
        XCTAssertTrue(resumeSignalIsAuthentic(signal, key: theirs))
    }

    // MARK: - what the verifier refuses

    func testAnUntaggedSignalIsNotAuthentic() {
        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: key)
        var stripped = fields(signal)
        stripped["auth"] = nil
        XCTAssertFalse(resumeSignalIsAuthentic(.object(stripped), key: key))
    }

    func testAMalformedTagIsNotAuthentic() {
        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: key)
        for bad in ["", "not base64 @@", String(repeating: "a", count: LINK_AUTH_TAG_LENGTH - 1),
                    String(repeating: "a", count: LINK_AUTH_TAG_LENGTH + 1)] {
            var tampered = fields(signal)
            tampered["auth"] = .string(bad)
            XCTAssertFalse(resumeSignalIsAuthentic(.object(tampered), key: key),
                           "\"\(bad)\" is not a tag")
        }
        var wrongType = fields(signal)
        wrongType["auth"] = .bool(true)
        XCTAssertFalse(resumeSignalIsAuthentic(.object(wrongType), key: key))
        XCTAssertFalse(resumeSignalIsAuthentic(.string("not an object"), key: key))
    }

    /// A different link's key. This is the one that matters: a signalling relay
    /// sees every SDP in the clear and can replay one from any other session,
    /// and only the tag separates that from the genuine peer.
    func testAForeignSessionsTagIsNotAuthentic() {
        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: otherKey)
        XCTAssertFalse(resumeSignalIsAuthentic(signal, key: key))
    }

    /// A tag is over the bytes, so rewriting any covered field invalidates it.
    func testRewritingACoveredFieldInvalidatesTheTag() {
        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: key)
        XCTAssertTrue(resumeSignalIsAuthentic(signal, key: key))

        var swappedSDP = fields(signal)
        swappedSDP["sdp"] = .object(["type": .string("offer"), "sdp": .string("v=1")])
        XCTAssertFalse(resumeSignalIsAuthentic(.object(swappedSDP), key: key),
                       "a relay must not be able to substitute its own description")

        var swappedKind = fields(signal)
        swappedKind["sdp"] = .object(["type": .string("answer"), "sdp": .string("v=0")])
        XCTAssertFalse(resumeSignalIsAuthentic(.object(swappedKind), key: key))

        var smuggledICE = fields(signal)
        smuggledICE["ice"] = .object(["candidate": .string("candidate:1"),
                                      "sdpMid": .null,
                                      "sdpMLineIndex": .null])
        XCTAssertFalse(resumeSignalIsAuthentic(.object(smuggledICE), key: key),
                       "a candidate added to a signed offer is covered and must break the tag")
    }

    /// `caps` is deliberately outside `authPayload` on both ends, so a hint
    /// added in flight cannot alter an authentication. It also must not be able
    /// to invalidate one, which is what makes it a hint rather than a security
    /// input.
    func testACapabilityHintIsOutsideTheTagOnBothEnds() {
        let signal = resumeSDPSignal(kind: "offer", sdp: "v=0", key: key)
        var hinted = fields(signal)
        hinted["caps"] = .array([.string(LINK_CAPABILITY)])
        XCTAssertTrue(resumeSignalIsAuthentic(.object(hinted), key: key))
    }
}
