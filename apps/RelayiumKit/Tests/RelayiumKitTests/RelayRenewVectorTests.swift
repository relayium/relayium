import XCTest
@testable import RelayiumKit

/// The native port of `relay-renew/1` asserted against the FROZEN shared
/// fixture, byte for byte.
///
/// `apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json` is generated from
/// the deployed Web implementation and is read-only to this port. Nothing here
/// re-derives an expected value from a reading of the spec: every assertion
/// compares against bytes another implementation produced, because the whole
/// purpose of the fixture is to catch the case where two readings of the same
/// prose disagree.
///
/// Every vector in the file is driven, and the counts are asserted, so a later
/// fixture that GAINS a case cannot pass by being silently skipped.
final class RelayRenewVectorTests: XCTestCase {
    private var vectors: JSONValue!
    private var key: [UInt8]!
    private var from: String!
    private var to: String!

    override func setUpWithError() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "relay-renew-vectors",
                                                  withExtension: "json"))
        vectors = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        key = try XCTUnwrap(hexBytes(string(vectors, "resumeAuthKeyHex")))
        from = string(child(vectors, "peers"), "from")
        to = string(child(vectors, "peers"), "to")
    }

    // MARK: - constants

    func testEveryBoundMatchesTheFixture() {
        let c = child(vectors, "constants")
        XCTAssertEqual(string(vectors, "capability"), RELAY_RENEW_CAPABILITY)
        XCTAssertEqual(number(c, "probeKind"), Double(RELAY_RENEW_PROBE_KIND))
        XCTAssertEqual(number(c, "probeVersion"), Double(RELAY_RENEW_PROBE_VERSION))
        XCTAssertEqual(number(c, "probeTypeProbe"), Double(RelayRenewProbeType.probe.rawValue))
        XCTAssertEqual(number(c, "probeTypeAck"), Double(RelayRenewProbeType.ack.rawValue))
        XCTAssertEqual(number(c, "probeFrameBytes"), Double(RENEW_PROBE_FRAME_BYTES))
        XCTAssertEqual(number(c, "nonceBytes"), Double(RENEW_PROBE_NONCE_BYTES))
        XCTAssertEqual(number(c, "tagBytes"), Double(RENEW_PROBE_TAG_BYTES))
        XCTAssertEqual(number(c, "authLength"), Double(RENEW_AUTH_LENGTH))
        XCTAssertEqual(number(c, "maxEpochsPerRound"), Double(RENEW_MAX_EPOCHS_PER_ROUND))
        XCTAssertEqual(number(c, "maxProbeVerifications"), Double(RENEW_MAX_PROBE_VERIFICATIONS))
        XCTAssertEqual(number(c, "maxHeldCandidates"), Double(RENEW_MAX_HELD_CANDIDATES))
        XCTAssertEqual(number(c, "probeRetryMs"), RENEW_PROBE_RETRY_MS * 1000)
        XCTAssertEqual(number(c, "probeMaxSends"), Double(RENEW_PROBE_MAX_SENDS))
        XCTAssertEqual(number(c, "prepareToReadyMs"), RENEW_PREPARE_TO_READY_MS * 1000)
        XCTAssertEqual(number(c, "readyToAnswerMs"), RENEW_READY_TO_ANSWER_MS * 1000)
        XCTAssertEqual(number(c, "iceProbeMs"), RENEW_ICE_PROBE_MS * 1000)
        XCTAssertEqual(number(c, "epochHardCapMs"), RENEW_EPOCH_HARD_CAP_MS * 1000)
        XCTAssertEqual(number(c, "prepareSilenceMs"), RENEW_PREPARE_SILENCE_MS * 1000)
    }

    /// `0x0d` is outside every kind already in use. If a later change registers
    /// it for something else, the probe frame stops being safely ignorable by a
    /// peer that never heard of renewal — and this is the assertion that says so
    /// rather than a comment that claims it.
    func testTheProbeKindIsDisjointFromEveryOtherByteOnEitherLane() {
        let taken: Set<UInt8> = [
            RealtimeKind.chunk, RealtimeKind.doneLegacy, RealtimeKind.batchLegacy,
            RealtimeKind.resumeStart, RealtimeKind.resumeReq, RealtimeKind.ack,
            RealtimeKind.batchEnc, RealtimeKind.doneEnc, RealtimeKind.text,
            RealtimeKind.chunkPart, RealtimeKind.batchPart,
            RealtimeControl.accept.rawValue, RealtimeControl.reject.rawValue,
            RealtimeControl.complete.rawValue,
            LINK_TEXT_REQUEST, LINK_TEXT_END, LINK_FILE_BUSY, LINK_FILE_BATCH_ABORT,
        ]
        XCTAssertFalse(taken.contains(RELAY_RENEW_PROBE_KIND))
    }

    // MARK: - the sixteen signed payloads

    func testEverySignedPayloadAndTagMatchesTheFixtureByteForByte() throws {
        let payloads = child(vectors, "payloads")
        var checked = 0
        for group in ["prepare", "ready", "sdp", "ice", "abort"] {
            for vector in array(payloads, group) {
                let label = "\(group)/\(string(vector, "case"))"
                let message = try XCTUnwrap(message(group: group, vector: vector), label)
                let f = string(vector, "from")
                let t = string(vector, "to")
                let payload = relayRenewPayload(message, from: f, to: t)
                XCTAssertEqual(payload, string(vector, "payload"), label)
                // The UTF-8 bytes, not just the Swift string: a `String` can
                // compare equal across normalisations an HMAC cannot.
                XCTAssertEqual(Data(payload.utf8).map { String(format: "%02x", $0) }.joined(),
                               string(vector, "payloadUtf8Hex"), label)
                XCTAssertEqual(signResume(key: key, payload: payload),
                               string(vector, "tag"), label)
                checked += 1
            }
        }
        // 5 prepare + 2 ready + 2 sdp + 2 ice + 5 abort.
        XCTAssertEqual(checked, 16)
    }

    /// The escaping rule the fixture exists to pin: U+0001 escapes, but U+007F,
    /// U+2028, U+2029 and astral characters are emitted RAW as UTF-8.
    func testTheGnarlyPeerIdEscapesExactlyLikeJSONStringify() throws {
        let vector = try XCTUnwrap(array(child(vectors, "payloads"), "prepare")
            .first { string($0, "case") == "every escaping rule in a peer id" })
        XCTAssertEqual(string(vector, "from"), string(child(vectors, "peers"), "gnarly"))
        let payload = relayRenewPayload(.prepare(epoch: 7),
                                        from: string(vector, "from"),
                                        to: string(vector, "to"))
        XCTAssertEqual(payload, string(vector, "payload"))
        let hex = Data(payload.utf8).map { String(format: "%02x", $0) }.joined()
        XCTAssertTrue(hex.contains("5c7530303031"), "U+0001 must escape to \\u0001")
        XCTAssertTrue(hex.contains("7fe280a8e280a9f09f9a80"),
                      "U+007F, U+2028, U+2029 and the astral scalar must be raw UTF-8")
    }

    /// A relay that reflects a message back at its sender verifies the reversed
    /// tuple and fails. The fixture carries both directions for exactly this.
    func testTheReversedDirectionIsADifferentTag() throws {
        let group = array(child(vectors, "payloads"), "prepare")
        let forward = try XCTUnwrap(group.first { string($0, "case") == "first epoch" })
        let reversed = try XCTUnwrap(group.first {
            string($0, "case") == "reversed direction is a different payload"
        })
        XCTAssertNotEqual(string(forward, "tag"), string(reversed, "tag"))
        XCTAssertFalse(verifyResume(key: key,
                                    payload: relayRenewPayload(.prepare(epoch: 1),
                                                               from: to, to: from),
                                    mac: string(forward, "tag")))
    }

    // MARK: - probe frames

    func testEveryProbeFrameMatchesTheFixtureByteForByte() throws {
        let frames = arrayAt(vectors, "probeFrames")
        XCTAssertEqual(frames.count, 3)
        for vector in frames {
            let label = string(vector, "case")
            let type = try XCTUnwrap(RelayRenewProbeType(rawValue: UInt8(number(vector, "type"))),
                                     label)
            let epoch = UInt32(number(vector, "epoch"))
            let round = UInt32(number(vector, "round"))
            let nonce = try XCTUnwrap(hexBytes(string(vector, "nonceHex")), label)
            XCTAssertEqual(Data(nonce).base64EncodedString(), string(vector, "nonceBase64"), label)

            let payload = relayRenewProbePayload(type: type, from: from, to: to,
                                                 epoch: epoch, round: round, nonce: nonce)
            XCTAssertEqual(payload, string(vector, "payload"), label)
            XCTAssertEqual(Data(payload.utf8).map { String(format: "%02x", $0) }.joined(),
                           string(vector, "payloadUtf8Hex"), label)
            let tag = try XCTUnwrap(Data(base64Encoded: signResume(key: key, payload: payload)),
                                    label)
            XCTAssertEqual(tag.map { String(format: "%02x", $0) }.joined(),
                           string(vector, "tagHex"), label)

            let frame = try XCTUnwrap(relayRenewProbeFrame(type: type, epoch: epoch, round: round,
                                                           nonce: nonce, tag: Array(tag)), label)
            XCTAssertEqual(frame.count, RENEW_PROBE_FRAME_BYTES, label)
            XCTAssertEqual(frame.map { String(format: "%02x", $0) }.joined(),
                           string(vector, "frameHex"), label)

            // And it round-trips: a port that can encode but not decode its own
            // bytes would fail only against the peer.
            let parsed = try XCTUnwrap(parsedRelayRenewProbeFrame(frame), label)
            XCTAssertEqual(parsed.type, type, label)
            XCTAssertEqual(parsed.epoch, epoch, label)
            XCTAssertEqual(parsed.round, round, label)
            XCTAssertEqual(parsed.nonce, nonce, label)
            XCTAssertEqual(parsed.tag, Array(tag), label)
            XCTAssertEqual(parsed.nonceBase64, string(vector, "nonceBase64"), label)
        }
    }

    /// A probe and its ack are different strings over the same nonce, so an
    /// observed probe cannot be reflected back as its own acknowledgement.
    func testAProbeCannotBeReflectedAsItsOwnAck() throws {
        let frames = arrayAt(vectors, "probeFrames")
        let probe = try XCTUnwrap(frames.first { string($0, "case") == "probe, epoch 1 round 1" })
        let ack = try XCTUnwrap(frames.first { string($0, "case") == "ack for the same nonce" })
        XCTAssertEqual(string(probe, "nonceHex"), string(ack, "nonceHex"))
        XCTAssertNotEqual(string(probe, "tagHex"), string(ack, "tagHex"))
    }

    // MARK: - envelopes

    func testEveryAcceptedEnvelopeParses() throws {
        let accept = array(child(vectors, "envelopes"), "accept")
        XCTAssertEqual(accept.count, 2)
        for vector in accept {
            let label = string(vector, "case")
            let json = try XCTUnwrap(vector.child("json"), label)
            XCTAssertTrue(isRelayRenewEnvelope(json), label)
            let parsed = try XCTUnwrap(parsedRelayRenewEnvelope(json), label)
            XCTAssertEqual(parsed.auth.count, RENEW_AUTH_LENGTH, label)
            // Re-encoding the parsed message reproduces the fixture's envelope,
            // so the parse lost nothing an encoder would have to guess back.
            XCTAssertEqual(relayRenewSignal(parsed.message, auth: parsed.auth), json, label)
        }
    }

    func testEveryRejectedEnvelopeIsRefused() throws {
        let reject = array(child(vectors, "envelopes"), "reject")
        XCTAssertEqual(reject.count, 20)
        for vector in reject {
            let label = "\(string(vector, "case")): \(string(vector, "why"))"
            let json = try XCTUnwrap(vector.child("json"), label)
            XCTAssertNil(parsedRelayRenewEnvelope(json), label)
        }
    }

    /// The hoisting cases are the ones that matter most, and rejecting them in
    /// the renewal parser is only half the requirement: the ORDINARY link
    /// handlers must also see nothing in them, because they filter by
    /// generation rather than by kind.
    func testHoistedSDPAndICEAreInertToTheOrdinaryLinkHandlers() throws {
        let reject = array(child(vectors, "envelopes"), "reject")
        for name in ["sdp hoisted to the top level", "ice hoisted to the top level"] {
            let vector = try XCTUnwrap(reject.first { string($0, "case") == name }, name)
            let json = try XCTUnwrap(vector.child("json"), name)
            XCTAssertNil(parsedRelayRenewEnvelope(json), name)
            // It is still recognised as renewal's shape, which is what keeps it
            // away from the establishment handler entirely.
            XCTAssertFalse(isRelayRenewEnvelope(json), name)
            // And a correctly-built envelope carries no top-level SDP or ICE at
            // all, which is the property the hoisting cases exist to protect.
            XCTAssertNil(parseSDP(relayRenewSignal(.prepare(epoch: 1), auth: String(repeating: "A", count: 44))))
            XCTAssertNil(parseICE(relayRenewSignal(.prepare(epoch: 1), auth: String(repeating: "A", count: 44))))
        }
    }

    /// A leave signal must stay inert here, and a renewal envelope must stay
    /// inert in the leave parser. Both directions, because both parsers see
    /// every signal on the `link` generation.
    func testTheLeaveAndRenewalVocabulariesAreMutuallyInert() throws {
        let reject = array(child(vectors, "envelopes"), "reject")
        let leave = try XCTUnwrap(reject.first { string($0, "case") == "a leave signal" })
        let json = try XCTUnwrap(leave.child("json"))
        XCTAssertNil(parsedRelayRenewEnvelope(json))
        let renewal = relayRenewSignal(.prepare(epoch: 1), auth: String(repeating: "A", count: 44))
        XCTAssertNil(parsedLinkLeaveAuth(renewal))
        XCTAssertFalse(isLinkOffer(renewal))
        XCTAssertFalse(isLinkRequest(renewal))
        XCTAssertFalse(isLinkBusy(renewal))
    }

    // MARK: - the server exchange

    func testTheRequestEnvelopeCarriesExactlyRoundAndRid() throws {
        let request = child(child(vectors, "server"), "request")
        let envelope = try XCTUnwrap(request.child("envelope"))
        XCTAssertEqual(string(envelope, "type"), RELAY_RENEW_REQUEST_TYPE)
        let data = try XCTUnwrap(envelope.child("data"))
        XCTAssertEqual(relayRenewRequestData(round: UInt32(number(data, "round")),
                                             rid: UInt32(number(data, "rid"))), data)
    }

    func testEveryAcceptedGrantParses() throws {
        let grants = child(child(vectors, "server"), "grants")
        let accept = array(grants, "accept")
        XCTAssertEqual(accept.count, 5)
        for vector in accept {
            let label = string(vector, "case")
            let json = try XCTUnwrap(vector.child("json"), label)
            let grant = try XCTUnwrap(parsedRelayRenewGrant(json), label)
            XCTAssertEqual(grant.status.rawValue, string(json, "status"), label)
            XCTAssertEqual(Double(grant.round), number(json, "round"), label)
            XCTAssertEqual(Double(grant.rid), number(json, "rid"), label)
            if grant.status == .granted {
                // Exactly the `/api/ice` shape, through the same sanitiser.
                let config = try XCTUnwrap(grant.config, label)
                XCTAssertFalse(config.iceServers.isEmpty, label)
                XCTAssertEqual(config.relays.count, 1, label)
                // And a deadline derives from what was actually received.
                XCTAssertNotNil(relayDeadline(for: config, now: Date(timeIntervalSince1970: 0)),
                                label)
            } else {
                XCTAssertNil(grant.config, label)
            }
        }
    }

    func testEveryRejectedGrantIsRefused() throws {
        let reject = array(child(child(vectors, "server"), "grants"), "reject")
        XCTAssertEqual(reject.count, 5)
        for vector in reject {
            let label = "\(string(vector, "case")): \(string(vector, "why"))"
            let json = try XCTUnwrap(vector.child("json"), label)
            XCTAssertNil(parsedRelayRenewGrant(json), label)
        }
    }

    /// A `granted` whose configuration would not survive the `/api/ice`
    /// sanitiser is not a grant. Otherwise a hostile or broken reply would
    /// reach `relayDeadline` and derive a boundary from something the server
    /// never issued.
    func testAGrantWithNoUsableConfigurationIsNotAGrant() {
        let base: [String: JSONValue] = ["status": .string("granted"),
                                         "round": .number(1), "rid": .number(7)]
        XCTAssertNil(parsedRelayRenewGrant(.object(base)))
        var empty = base
        empty["iceServers"] = .array([])
        XCTAssertNil(parsedRelayRenewGrant(.object(empty)))
        var wrong = base
        wrong["iceServers"] = .string("turn:relay.example")
        XCTAssertNil(parsedRelayRenewGrant(.object(wrong)))
    }

    // MARK: - SDP pinning

    func testEverySDPPinVectorAgreesWithTheFixture() throws {
        let vectors = arrayAt(self.vectors, "sdpPin")
        XCTAssertEqual(vectors.count, 6)
        let baselineVector = try XCTUnwrap(vectors.first { string($0, "case") == "baseline" })
        let baseline = relayRenewPin(sdp: string(baselineVector, "sdp"))
        let declared = try XCTUnwrap(baselineVector.child("pin"))
        XCTAssertEqual(baseline.fingerprints, strings(declared, "fingerprints"))
        XCTAssertEqual(baseline.mids, strings(declared, "mids"))
        XCTAssertEqual(baseline.setup, string(declared, "setup"))
        XCTAssertEqual(relayRenewICEUfrag(sdp: string(baselineVector, "sdp")),
                       string(baselineVector, "ufrag"))

        var compared = 0
        for vector in vectors where vector.child("matchesBaselineAsOffer") != nil {
            let label = string(vector, "case")
            let pin = relayRenewPin(sdp: string(vector, "sdp"))
            XCTAssertEqual(baseline.admits(pin, as: .offer),
                           bool(vector, "matchesBaselineAsOffer"), "\(label) as offer")
            XCTAssertEqual(baseline.admits(pin, as: .answer),
                           bool(vector, "matchesBaselineAsAnswer"), "\(label) as answer")
            XCTAssertEqual(relayRenewICEUfrag(sdp: string(vector, "sdp")),
                           string(vector, "ufrag"), label)
            compared += 1
        }
        XCTAssertEqual(compared, 5)
    }

    /// Fingerprint order and hex case are normalised away; the SET is what is
    /// compared. Reconstructed here rather than taken from the fixture, because
    /// what is being checked is that the normalisation is order-insensitive at
    /// all.
    func testFingerprintPinningIsOrderAndCaseInsensitiveButNotValueInsensitive() {
        let a = relayRenewPin(sdp: "m=application 9 x\r\na=mid:0\r\n"
            + "a=fingerprint:sha-256 AA:BB\r\na=fingerprint:sha-256 CC:DD\r\na=setup:active\r\n")
        let b = relayRenewPin(sdp: "m=application 9 x\r\na=mid:0\r\n"
            + "a=fingerprint:SHA-256 cc:dd\r\na=fingerprint:SHA-256 aa:bb\r\na=setup:active\r\n")
        XCTAssertTrue(a.admits(b, as: .answer))
        let c = relayRenewPin(sdp: "m=application 9 x\r\na=mid:0\r\n"
            + "a=fingerprint:sha-256 AA:BB\r\na=setup:active\r\n")
        XCTAssertFalse(a.admits(c, as: .answer), "a dropped fingerprint is a different peer")
    }

    // MARK: - ufrag binding

    func testEveryCandidateUfragVectorAgreesWithTheFixture() {
        let vectors = arrayAt(self.vectors, "candidateUfrag")
        XCTAssertEqual(vectors.count, 3)
        for vector in vectors {
            XCTAssertEqual(relayRenewCandidateUfrag(candidate: string(vector, "candidate")),
                           string(vector, "ufrag"), string(vector, "case"))
        }
    }

    func testEveryInboundCandidateUfragVectorAgreesWithTheFixture() {
        let vectors = arrayAt(self.vectors, "inboundCandidateUfrag")
        XCTAssertEqual(vectors.count, 5)
        for vector in vectors {
            XCTAssertEqual(
                relayRenewInboundCandidateUfrag(candidate: string(vector, "candidate"),
                                                usernameFragment: string(vector,
                                                                         "usernameFragment")),
                string(vector, "ufrag"), string(vector, "case"))
        }
    }

    // MARK: - fixture navigation

    private func message(group: String, vector: JSONValue) -> RelayRenewMessage? {
        let epoch = UInt32(number(vector, "epoch"))
        switch group {
        case "prepare":
            return .prepare(epoch: epoch)
        case "ready":
            return .ready(epoch: epoch, round: UInt32(number(vector, "round")))
        case "sdp":
            guard let type = RelayRenewSDPType(rawValue: string(vector, "sdpType")) else {
                return nil
            }
            return .sdp(epoch: epoch, round: UInt32(number(vector, "round")),
                        sdpType: type, sdp: string(vector, "sdp"))
        case "ice":
            var mid: String?
            if case let .string(value)? = vector.child("sdpMid") { mid = value }
            var index: UInt32?
            if case let .number(value)? = vector.child("sdpMLineIndex") { index = UInt32(value) }
            return .ice(epoch: epoch, round: UInt32(number(vector, "round")),
                        candidate: string(vector, "candidate"), sdpMid: mid,
                        sdpMLineIndex: index,
                        usernameFragment: string(vector, "usernameFragment"))
        case "abort":
            guard let reason = RelayRenewAbortReason(rawValue: string(vector, "reason")) else {
                return nil
            }
            return .abort(epoch: epoch, reason: reason)
        default:
            return nil
        }
    }

    private func child(_ value: JSONValue, _ key: String) -> JSONValue {
        value.child(key) ?? .null
    }

    private func array(_ value: JSONValue, _ key: String) -> [JSONValue] {
        arrayAt(value, key)
    }

    private func arrayAt(_ value: JSONValue, _ key: String) -> [JSONValue] {
        guard case let .array(items)? = value.child(key) else { return [] }
        return items
    }

    private func string(_ value: JSONValue, _ key: String) -> String {
        guard case let .string(s)? = value.child(key) else { return "" }
        return s
    }

    private func number(_ value: JSONValue, _ key: String) -> Double {
        guard case let .number(n)? = value.child(key) else { return .nan }
        return n
    }

    private func strings(_ value: JSONValue, _ key: String) -> [String] {
        arrayAt(value, key).map(\.asString)
    }

    private func bool(_ value: JSONValue, _ key: String) -> Bool {
        guard case let .bool(b)? = value.child(key) else { return false }
        return b
    }

    private func hexBytes(_ hex: String) -> [UInt8]? {
        var out: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            guard let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) else {
                return nil
            }
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }
}

private extension JSONValue {
    func child(_ key: String) -> JSONValue? {
        guard case let .object(fields) = self else { return nil }
        return fields[key]
    }

    var asString: String {
        guard case let .string(s) = self else { return "" }
        return s
    }
}
