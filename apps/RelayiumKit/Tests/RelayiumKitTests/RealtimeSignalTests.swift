import XCTest
@testable import RelayiumKit

final class RealtimeSignalTests: XCTestCase {
    func testSDPWithCommitRoundTrips() {
        let j = sdpSignal(kind: "offer", sdp: "v=0...", commit: "Q29t")
        XCTAssertEqual(parseSDP(j)?.type, "offer")
        XCTAssertEqual(parseSDP(j)?.sdp, "v=0...")
        XCTAssertEqual(peerCommit(from: j), "Q29t")   // commit rides the SDP signal
    }
    func testICERoundTrips() {
        let j = iceSignal("candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0)
        let c = parseICE(j)
        XCTAssertEqual(c?.candidate, "candidate:1 1 udp ...")
        XCTAssertEqual(c?.sdpMid, "0"); XCTAssertEqual(c?.sdpMLineIndex, 0)
    }
    func testBusy() { XCTAssertTrue(parseBusy(busySignal())); XCTAssertFalse(parseBusy(sdpSignal(kind:"offer",sdp:"x",commit:nil))) }
}

// ── signalling generations ───────────────────────────────────────────────────
extension RealtimeSignalTests {
    func testGenerationDefaultsToFileAndTagsRoundTrip() {
        XCTAssertEqual(signalGeneration(.object([:])), .file)
        XCTAssertEqual(signalGeneration(.null), .file)
        XCTAssertEqual(signalGeneration(taggedSignal(.object(["ice": .object([:])]), generation: .file)), .file)
        XCTAssertEqual(signalGeneration(taggedSignal(.object(["ice": .object([:])]), generation: .resume)), .resume)
        XCTAssertEqual(signalGeneration(taggedSignal(.object(["ice": .object([:])]), generation: .text)), .text)
    }

    /// The web has a fourth generation (`link`, its combined file+text peer
    /// link). Reading it as untagged — which three cases did — means answering a
    /// link offer as a file transfer and then waiting for a manifest that is
    /// never coming.
    func testTheWebsLinkGenerationIsRecognisedRatherThanReadAsAFileSignal() {
        XCTAssertEqual(signalGeneration(.object(["link": .bool(true)])), .link)
        XCTAssertEqual(
            signalGeneration(.object(["link": .bool(true), "text": .bool(true)])),
            .link,
            "same precedence as web/src/lib/webrtc-core.ts")
        XCTAssertEqual(
            signalGeneration(.object(["resume": .bool(true), "link": .bool(true)])),
            .resume)
        XCTAssertEqual(
            signalGeneration(taggedSignal(.object(["ice": .object([:])]), generation: .link)),
            .link)
    }

    func testResumeWinsOverTextOnAmbiguousUntrustedSignal() {
        XCTAssertEqual(
            signalGeneration(.object(["resume": .bool(true), "text": .bool(true)])),
            .resume
        )
        XCTAssertEqual(signalGeneration(.object(["resume": .bool(false), "text": .bool(true)])), .text)
        XCTAssertEqual(signalGeneration(.object(["text": .string("true")])), .file)
    }

    func testTextSDPCarriesCommitCapabilityAndGenerationTogether() {
        let signal = sdpSignal(
            kind: "offer",
            sdp: "v=0",
            commit: "Yw==",
            generation: .text,
            caps: ["text/1"]
        )
        XCTAssertEqual(signalGeneration(signal), .text)
        XCTAssertEqual(peerCaps(from: signal), ["text/1"])
        XCTAssertEqual(peerCommit(from: signal), "Yw==")
        XCTAssertEqual(parseSDP(signal)?.type, "offer")
        XCTAssertEqual(parseSDP(signal)?.sdp, "v=0")
    }

    func testLegacyFileSDPShapeIsUnchangedWhenNoCapsRequested() {
        XCTAssertEqual(
            sdpSignal(kind: "offer", sdp: "v=0", commit: "Yw=="),
            .object([
                "sdp": .object(["type": .string("offer"), "sdp": .string("v=0")]),
                "commit": .string("Yw=="),
            ])
        )
    }

    func testBusyAndRevealCanCarryTextGeneration() {
        let busy = taggedSignal(busySignal(), generation: .text)
        XCTAssertTrue(parseBusy(busy))
        XCTAssertEqual(signalGeneration(busy), .text)

        let reveal = taggedSignal(.object(["reveal": .string("opaque")]), generation: .text)
        XCTAssertEqual(signalGeneration(reveal), .text)
        guard case let .object(fields) = reveal else { return XCTFail("not an object") }
        XCTAssertEqual(fields["reveal"], .string("opaque"))
    }

    func testAddingNoCapsPreservesInputAndMalformedCapsNeverGrantSupport() {
        let original = taggedSignal(busySignal(), generation: .text)
        XCTAssertEqual(addingCaps([], to: original), original)
        XCTAssertEqual(peerCaps(from: .object(["caps": .array([.string("text/01"), .number(1)])])), ["text/01"])
        XCTAssertFalse(peerCaps(from: .object(["caps": .array([.string("text/01")])])).contains("text/1"))
    }
}

// ── capability piggyback ─────────────────────────────────────────────────────
extension RealtimeSignalTests {
    func testCapsFieldRoundTrips() {
        XCTAssertEqual(peerCaps(from: capsField(["text/1"])), ["text/1"])
        XCTAssertEqual(peerCaps(from: capsField(["future/9", "text/1"])), ["future/9", "text/1"])
    }

    // Absent is not an error: every already-deployed peer sends no caps at all.
    func testAbsentCapsIsEmptyNotAFailure() {
        XCTAssertEqual(peerCaps(from: sdpSignal(kind: "offer", sdp: "v=0", commit: "Yw==")), [])
        XCTAssertEqual(peerCaps(from: busySignal()), [])
        XCTAssertEqual(peerCaps(from: .object([:])), [])
        XCTAssertEqual(peerCaps(from: .null), [])
    }

    // Peer-authored input: a malformed caps field must not throw and must not
    // grant anything.
    func testMalformedCapsIsIgnored() {
        XCTAssertEqual(peerCaps(from: .object(["caps": .string("text/1")])), [])
        XCTAssertEqual(peerCaps(from: .object(["caps": .number(1)])), [])
        XCTAssertEqual(peerCaps(from: .object(["caps": .array([.number(1), .null])])), [])
        // Non-string entries are dropped, the string ones survive.
        XCTAssertEqual(peerCaps(from: .object(["caps": .array([.number(1), .string("text/1")])])), ["text/1"])
    }

    // caps rides ALONGSIDE the commit, the way sdpExtra merges it, so adding it
    // cannot disturb the commit-reveal fields.
    func testCapsDoesNotDisturbTheSdpOrCommit() {
        guard case var .object(o) = sdpSignal(kind: "offer", sdp: "v=0\r\n", commit: "Yw==") else {
            return XCTFail("sdpSignal did not produce an object")
        }
        if case let .object(c) = capsField(["text/1"]) { o.merge(c) { a, _ in a } }
        let merged = JSONValue.object(o)
        XCTAssertEqual(peerCommit(from: merged), "Yw==")
        XCTAssertEqual(parseSDP(merged)?.sdp, "v=0\r\n")
        XCTAssertEqual(peerCaps(from: merged), ["text/1"])
    }
}

// ── which inbound signals open a new responder session ───────────────────────
//
// This is the classifier a persistent listener runs on every frame the room
// delivers, so every case below is a way an always-on receiver goes wrong.
extension RealtimeSignalTests {
    private func offer(generation: RealtimeGeneration, caps: [String] = []) -> JSONValue {
        sdpSignal(kind: "offer", sdp: "v=0", commit: "Yw==", generation: generation, caps: caps)
    }

    func testAnUntaggedOfferIsAFileOffer() {
        XCTAssertEqual(inboundOfferGeneration(offer(generation: .file)), .file)
        // Legacy peers send no commit and no caps at all.
        XCTAssertEqual(
            inboundOfferGeneration(.object(["sdp": .object(["type": .string("offer"),
                                                            "sdp": .string("v=0")])])),
            .file)
    }

    /// Only an OFFER starts a session. An answer, a candidate or a reveal
    /// belongs to a connection that already exists; treating one as a new
    /// session spends a connection on nothing and loses the frame.
    func testOnlyARealOfferOpensASession() {
        XCTAssertNil(inboundOfferGeneration(sdpSignal(kind: "answer", sdp: "v=0", commit: nil)))
        XCTAssertNil(inboundOfferGeneration(iceSignal("candidate:1 1 udp", sdpMid: "0", sdpMLineIndex: 0)))
        XCTAssertNil(inboundOfferGeneration(.object(["reveal": .string("opaque")])))
        XCTAssertNil(inboundOfferGeneration(busySignal()))
        XCTAssertNil(inboundOfferGeneration(capsField(["text/1"])))
        XCTAssertNil(inboundOfferGeneration(.object([:])))
        XCTAssertNil(inboundOfferGeneration(.null))
        // A malformed sdp object is not an offer either.
        XCTAssertNil(inboundOfferGeneration(.object(["sdp": .string("offer")])))
    }

    /// A resume offer re-attaches to a paused transfer this client does not
    /// implement, and `link` is the web's own generation. Answering either
    /// strands the initiator on a wire this side is not speaking.
    func testResumeAndLinkOffersAreNotNewSessions() {
        XCTAssertNil(inboundOfferGeneration(offer(generation: .resume)))
        XCTAssertNil(inboundOfferGeneration(offer(generation: .link)))
        XCTAssertNil(inboundOfferGeneration(offer(generation: .link, caps: ["text/1"])),
                     "a link offer is not rescued by carrying the text capability")
    }

    /// A text offer must carry exact `text/1` — the same requirement the
    /// connection enforces on the wire. Fail closed: silence, not busy, because
    /// "try again later" is not what is wrong with a peer we cannot decode.
    func testATextOfferNeedsTheExactCapability() {
        XCTAssertEqual(inboundOfferGeneration(offer(generation: .text, caps: ["text/1"])), .text)
        XCTAssertNil(inboundOfferGeneration(offer(generation: .text)))
        XCTAssertNil(inboundOfferGeneration(offer(generation: .text, caps: ["text/2"])))
        XCTAssertNil(inboundOfferGeneration(offer(generation: .text, caps: ["Text/1"])),
                     "the capability is exact, not case-folded")
        XCTAssertNil(inboundOfferGeneration(offer(generation: .text, caps: ["text/1x"])))
    }
}
