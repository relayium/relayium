import XCTest
@testable import RelayiumKit

/// Which inbound signals an authenticated `link/1` transport REPLACEMENT will
/// act on.
///
/// This object is the whole of the security boundary this batch adds. A
/// replacement runs no commit/reveal — it inherits an authentication the user
/// already compared as a SAS — so possession of that link's `resumeAuth` key is
/// the only thing standing between it and a signalling relay offering its own
/// replacement transport. Every rule below is a way that relay wins if the rule
/// is missing, and none of them needs an `RTCPeerConnection` to decide.
final class LinkResumePolicyTests: XCTestCase {

    private let peer = "peer-b"
    private let key = [UInt8](repeating: 7, count: 32)
    private let foreignKey = [UInt8](repeating: 9, count: 32)

    private func policy(role: Role = .responder,
                        key: [UInt8]? = nil) -> LinkResumePolicy {
        LinkResumePolicy(peerId: peer, role: role, resumeAuthKey: key ?? self.key)
    }

    private func offer(_ sdp: String = "v=0", key: [UInt8]? = nil) -> JSONValue {
        resumeSDPSignal(kind: "offer", sdp: sdp, key: key ?? self.key)
    }

    private func answer(_ sdp: String = "v=0", key: [UInt8]? = nil) -> JSONValue {
        resumeSDPSignal(kind: "answer", sdp: sdp, key: key ?? self.key)
    }

    private func ice(_ candidate: String = "candidate:1", key: [UInt8]? = nil) -> JSONValue {
        resumeICESignal(candidate, sdpMid: "0", sdpMLineIndex: 0, key: key ?? self.key)
    }

    private func rewriting(_ signal: JSONValue,
                          _ mutate: (inout [String: JSONValue]) -> Void) -> JSONValue {
        guard case var .object(fields) = signal else { return signal }
        mutate(&fields)
        return .object(fields)
    }

    // MARK: - the genuine peer

    func testTheGenuinePeersOfferIsAppliedByTheOriginalResponder() {
        XCTAssertEqual(policy(role: .responder).plan(from: peer, signal: offer("v=0-rebuilt")),
                       [.applyRemoteOffer("v=0-rebuilt")])
    }

    func testTheGenuinePeersAnswerIsAppliedByTheOriginalInitiator() {
        XCTAssertEqual(policy(role: .initiator).plan(from: peer, signal: answer("v=0-rebuilt")),
                       [.applyRemoteAnswer("v=0-rebuilt")])
    }

    func testAGenuineCandidateIsAdded() {
        XCTAssertEqual(policy().plan(from: peer, signal: ice("candidate:9")),
                       [.addRemoteCandidate(candidate: "candidate:9", sdpMid: "0", sdpMLineIndex: 0)])
    }

    // MARK: - the deterministic role survives the rebuild

    /// Both sides keep the offerer/responder split their first connection
    /// produced. Answering an offer in the wrong role would turn one link into
    /// two offerers racing SDP into one pair of lanes.
    func testAnOfferAtTheOriginalInitiatorIsInert() {
        XCTAssertEqual(policy(role: .initiator).plan(from: peer, signal: offer()), [])
    }

    func testAnAnswerAtTheOriginalResponderIsInert() {
        XCTAssertEqual(policy(role: .responder).plan(from: peer, signal: answer()), [])
    }

    // MARK: - who and which generation

    func testASignalFromAnybodyElseIsInert() {
        XCTAssertEqual(policy().plan(from: "somebody-else", signal: offer()), [])
    }

    /// A room is a broadcast surface, and this transport shares it with an
    /// establishment on the `link` generation and with the legacy file/text
    /// connections. Only `resume` is a rebuild.
    func testEveryOtherGenerationIsInert() {
        let sdp = "v=0"
        let cases: [JSONValue] = [
            linkSDPSignal(kind: "offer", sdp: sdp, commit: "Y29tbWl0", caps: [LINK_CAPABILITY]),
            sdpSignal(kind: "offer", sdp: sdp, commit: nil, generation: .file),
            sdpSignal(kind: "offer", sdp: sdp, commit: nil, generation: .text),
            linkRequestSignal(),
            linkBusySignal(),
            linkLeaveSignal(auth: String(repeating: "a", count: LINK_LEAVE_AUTH_LENGTH)),
            taggedSignal(capsField([LINK_CAPABILITY]), generation: .link),
        ]
        let p = policy()
        for signal in cases {
            XCTAssertEqual(p.plan(from: peer, signal: signal), [],
                           "\(signal) is not a rebuild")
        }
    }

    // MARK: - the tag

    func testAnUntaggedResumeOfferIsInert() {
        let untagged = rewriting(offer()) { $0["auth"] = nil }
        XCTAssertEqual(policy().plan(from: peer, signal: untagged), [])
    }

    func testAMalformedTagIsInert() {
        let p = policy()
        for bad in ["", "not base64 @@", String(repeating: "a", count: LINK_AUTH_TAG_LENGTH)] {
            let tampered = rewriting(offer()) { $0["auth"] = .string(bad) }
            XCTAssertEqual(p.plan(from: peer, signal: tampered), [], "\"\(bad)\" is not a tag")
        }
        let wrongType = rewriting(offer()) { $0["auth"] = .number(1) }
        XCTAssertEqual(p.plan(from: peer, signal: wrongType), [])
    }

    /// The signalling relay's own replacement transport, offered under a key it
    /// does not hold. Everything about it is well-formed except the one thing
    /// that proves who sent it.
    func testAForeignSessionsSignedOfferIsInert() {
        XCTAssertEqual(policy().plan(from: peer, signal: offer(key: foreignKey)), [])
        XCTAssertEqual(policy().plan(from: peer, signal: ice(key: foreignKey)), [])
        XCTAssertEqual(policy(role: .initiator).plan(from: peer, signal: answer(key: foreignKey)), [])
    }

    /// A genuine offer with its SDP swapped in flight. The tag covers the bytes,
    /// so this is exactly a relay substituting its own description.
    func testAGenuineOfferWithASwappedDescriptionIsInert() {
        let swapped = rewriting(offer()) {
            $0["sdp"] = .object(["type": .string("offer"), "sdp": .string("v=0-relay")])
        }
        XCTAssertEqual(policy().plan(from: peer, signal: swapped), [])
    }

    // MARK: - the once-only slots

    func testASecondGenuineOfferIsInert() {
        let p = policy()
        XCTAssertEqual(p.plan(from: peer, signal: offer("first")), [.applyRemoteOffer("first")])
        XCTAssertEqual(p.plan(from: peer, signal: offer("second")), [],
                       "one remote offer is applied, ever")
    }

    func testASecondGenuineAnswerIsInert() {
        let p = policy(role: .initiator)
        XCTAssertEqual(p.plan(from: peer, signal: answer("first")), [.applyRemoteAnswer("first")])
        XCTAssertEqual(p.plan(from: peer, signal: answer("second")), [])
    }

    /// The slot belongs to the peer that can prove it holds the link's keys.
    /// Letting an unverifiable offer consume it would let a relay spend the one
    /// rebuild this transport has, without ever being able to complete it — the
    /// genuine peer's real offer would then arrive to a transport that has
    /// nothing left to answer with.
    func testAnInvalidSignalNeverConsumesTheOnceOnlySlot() {
        let p = policy()
        let junk: [JSONValue] = [
            offer(key: foreignKey),
            rewriting(offer()) { $0["auth"] = nil },
            rewriting(offer()) { $0["auth"] = .string("not base64 @@") },
            rewriting(offer()) {
                $0["sdp"] = .object(["type": .string("offer"), "sdp": .string("v=0-relay")])
            },
        ]
        for signal in junk {
            XCTAssertEqual(p.plan(from: peer, signal: signal), [])
        }
        // …and the genuine peer still arrives.
        XCTAssertEqual(p.plan(from: peer, signal: offer("v=0-genuine")),
                       [.applyRemoteOffer("v=0-genuine")])
    }

    func testAForeignPeersSignedOfferNeverConsumesTheSlot() {
        let p = policy()
        XCTAssertEqual(p.plan(from: "somebody-else", signal: offer()), [])
        XCTAssertEqual(p.plan(from: peer, signal: offer("v=0-genuine")),
                       [.applyRemoteOffer("v=0-genuine")])
    }

    // MARK: - nothing cryptographic rides this generation

    /// A replacement inherits its identity. There is no handshake to feed, so a
    /// `commit` or a `reveal` smuggled onto an authenticated resume signal must
    /// reach nothing — a second reveal would re-derive keys and hand the link a
    /// second `LinkCodecs` counting from zero under keys already in use.
    func testACommitOrRevealOnTheResumeGenerationReachesNothing() {
        let p = policy()
        let smuggled = rewriting(offer()) {
            $0["commit"] = .string("Y29tbWl0")
            $0["reveal"] = .object(["key": .string("a2V5"), "nonce": .string("bm9uY2U=")])
            $0["caps"] = .array([.string(LINK_CAPABILITY)])
        }
        // `commit`, `reveal` and `caps` are all outside `authPayload`, so the tag
        // is still valid — which is exactly why the plan, not the tag, has to be
        // the thing that refuses them.
        XCTAssertTrue(resumeSignalIsAuthentic(smuggled, key: key))
        XCTAssertEqual(p.plan(from: peer, signal: smuggled), [.applyRemoteOffer("v=0")])
    }

    /// A replacement never fails on a signal. Everything it will not act on is
    /// dropped in silence so the genuine peer can still arrive inside the
    /// deadline; an inert attempt is ended by that deadline, not by a stranger.
    func testNoInboundSignalCanTerminateAReplacement() {
        let p = policy()
        let hostile: [JSONValue] = [
            linkBusySignal(),
            taggedSignal(busySignal(), generation: .resume),
            resumeSDPSignal(kind: "offer", sdp: "v=0", key: foreignKey),
            rewriting(offer()) { $0["auth"] = nil },
            .object([:]),
            .null,
        ]
        for signal in hostile {
            XCTAssertFalse(p.plan(from: peer, signal: signal).contains { action in
                if case .fail = action { return true }
                return false
            }, "\(signal) must not end a rebuild")
        }
    }

    /// An authenticated `busy` cannot exist on this generation either: nothing
    /// in the deployed web sends one, and honouring an unauthenticated one would
    /// hand a signalling relay a one-message kill switch for a rebuild it cannot
    /// otherwise touch.
    func testABusyOnTheResumeGenerationIsInertEvenWhenSigned() {
        let signed = signedResumeSignal(busySignal(), key: key)
        XCTAssertTrue(resumeSignalIsAuthentic(signed, key: key))
        XCTAssertEqual(policy().plan(from: peer, signal: signed), [])
    }

    // MARK: - shapes that are not a rebuild

    func testASignalWithNeitherDescriptionNorCandidateIsInert() {
        XCTAssertEqual(policy().plan(from: peer, signal: signedResumeSignal(.object([:]), key: key)),
                       [])
    }

    func testAnSDPThatIsNeitherOfferNorAnswerIsInert() {
        for kind in ["pranswer", "rollback", ""] {
            let signal = resumeSDPSignal(kind: kind, sdp: "v=0", key: key)
            XCTAssertEqual(policy().plan(from: peer, signal: signal), [],
                           "\(kind) is not a rebuild description")
        }
    }

    /// One decision per signal, matching `LinkSignalPolicy`: a description is
    /// handled whole, and nothing produced by either side ever carries both.
    func testADescriptionIsHandledWholeAndNeverAlongsideACandidate() {
        var combined = ["sdp": JSONValue.object(["type": .string("offer"), "sdp": .string("v=0")]),
                        "ice": JSONValue.object(["candidate": .string("candidate:1"),
                                                 "sdpMid": .null,
                                                 "sdpMLineIndex": .null])]
        combined["resume"] = .bool(true)
        let signal = signedResumeSignal(.object(combined), key: key)
        XCTAssertEqual(policy().plan(from: peer, signal: signal), [.applyRemoteOffer("v=0")])
    }
}
