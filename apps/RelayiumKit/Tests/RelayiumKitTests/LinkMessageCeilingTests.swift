import XCTest
import WebRTC
@testable import RelayiumKit

/// The negotiated per-message ceiling: the pure parser, and the two real
/// transports that publish it.
///
/// Split from `LinkNegotiatedFrameCeilingTests` on purpose. Everything here
/// names API the patch introduces, so it cannot be compiled against the
/// baseline at all; the behavioural negative controls live in that file, which
/// is written entirely in terms of the API that already existed.
final class LinkMessageCeilingTests: XCTestCase {

    private let peer = "peer-b"
    private let peerCommit = "Y29tbWl0"      // base64, shape only

    // MARK: - SDP fixtures

    /// A real offer from a throwaway PeerConnection, carrying both lanes.
    ///
    /// Real rather than hand-written, and that is not ceremony: a hand-written
    /// LF-only fixture hid a parser that could not read ANY genuine
    /// description, because SDP is CRLF on the wire and CRLF is one Swift
    /// `Character`. This offer is also what `setRemoteDescription` will accept
    /// below — a fabricated one is simply rejected.
    private func realOfferSDP() throws -> String {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let pc = try XCTUnwrap(RTCPeerConnectionFactory().peerConnection(
            with: RTCConfiguration(), constraints: constraints, delegate: nil))
        defer { pc.close() }
        let config = RTCDataChannelConfiguration()
        config.isOrdered = true
        for label in LINK_CHANNEL_LABELS {
            XCTAssertNotNil(pc.dataChannel(forLabel: label, configuration: config))
        }
        var sdp: String?
        let made = expectation(description: "a real offer")
        pc.offer(for: constraints) { description, _ in
            sdp = description?.sdp
            made.fulfill()
        }
        wait(for: [made], timeout: 10)
        return try XCTUnwrap(sdp)
    }

    /// Replace the offer's own `a=max-message-size` value, or — with `nil` —
    /// remove the attribute entirely, which is what a peer that advertises
    /// nothing produces.
    private func rewritingCeiling(_ sdp: String, to value: String?) throws -> String {
        let lines = sdp.split(omittingEmptySubsequences: false, whereSeparator: { $0.isNewline })
        XCTAssertTrue(lines.contains { $0.hasPrefix("a=max-message-size:") },
                      "the fixture must actually carry the attribute being rewritten")
        let rewritten = lines.compactMap { line -> String? in
            guard line.hasPrefix("a=max-message-size:") else { return String(line) }
            return value.map { "a=max-message-size:\($0)" }
        }
        return rewritten.joined(separator: "\r\n")
    }

    // MARK: - the parser

    /// A genuine libwebrtc offer. 262 144 is what this WebRTC build advertises;
    /// the assertion that matters is that a REAL description parses at all.
    func testARealOfferParsesToTheValueItAdvertises() throws {
        let sdp = try realOfferSDP()
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp), 262_144)
    }

    /// RFC 8841 §6: a peer that advertises nothing can receive 64 KiB.
    func testAnAbsentAttributeIsTheRFCDefault() throws {
        let sdp = try rewritingCeiling(try realOfferSDP(), to: nil)
        XCTAssertFalse(sdp.contains("max-message-size"))
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
        XCTAssertEqual(LINK_CONSERVATIVE_MAX_MESSAGE_BYTES, 65_536)
    }

    /// RFC 8841 §6: zero means "any size", and reading it as unknown would be
    /// exactly the wrong guess in the only direction that costs anything.
    func testZeroMeansNoCeilingRatherThanNoAnswer() throws {
        let sdp = try rewritingCeiling(try realOfferSDP(), to: "0")
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp), .infinity)
        // And local policy is what bounds it.
        XCTAssertEqual(linkFrameCeiling(localPolicy: DEFAULT_MAX_FRAME_BYTES,
                                        negotiated: .infinity),
                       DEFAULT_MAX_FRAME_BYTES)
    }

    func testAnExplicitSmallerCeilingIsHonoured() throws {
        let sdp = try rewritingCeiling(try realOfferSDP(), to: "8117")
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp), 8_117)
    }

    /// Every unreadable value answers the conservative floor. Guessing HIGH is
    /// the dangerous direction — it produces frames the peer's channel refuses,
    /// after this side has already spent the nonce that sealed them.
    func testEveryUnreadableValueAnswersTheConservativeFloor() throws {
        let offer = try realOfferSDP()
        for bogus in ["", " ", "abc", "-1", "+64", "1.5", "65_536", "64k", "0x10000",
                      "18446744073709551616", "99999999999999999999", "12 34",
                      "\u{FF11}\u{FF12}"] {
            let sdp = try rewritingCeiling(offer, to: bogus)
            XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp),
                           LINK_CONSERVATIVE_MAX_MESSAGE_BYTES,
                           "\"\(bogus)\" must not be believed")
        }
    }

    /// Surrounding whitespace is not a malformed value; SDP tolerates it and so
    /// does every other stack.
    func testSurroundingWhitespaceIsTolerated() throws {
        let sdp = try rewritingCeiling(try realOfferSDP(), to: "  8117  ")
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp), 8_117)
    }

    /// The attribute is MEDIA level, for the SCTP association. A session-level
    /// copy, an audio section's copy and a non-SCTP application section all say
    /// nothing about what a DataChannel can carry.
    func testOnlyTheSCTPApplicationSectionCounts() {
        let sessionLevel = """
        v=0\r
        a=max-message-size:8117\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        a=sctp-port:5000\r
        """
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sessionLevel),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)

        let audio = """
        v=0\r
        m=audio 9 UDP/TLS/RTP/SAVPF 111\r
        a=max-message-size:8117\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        a=max-message-size:262144\r
        """
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: audio), 262_144)

        let notSCTP = """
        v=0\r
        m=application 9 UDP/TLS/RTP/SAVPF 111\r
        a=max-message-size:8117\r
        """
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: notSCTP),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)

        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: ""),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
    }

    /// Two of them in one section is undefined, and the answer must be the
    /// SMALLEST of the RFC default and every value present.
    ///
    /// The rule this replaces — "ambiguous, answer the default" — was wrong in
    /// the one direction that costs anything: against `8117` followed by
    /// anything it could not read, it answered 65 536 and RAISED the ceiling
    /// above a bound the peer had explicitly stated.
    ///
    /// A headless Chrome probe of `RTCSctpTransport.maxMessageSize` last-wins:
    /// `0` then `8117` answers 8117, and `8117` then `0` answers 262 144. The
    /// rule below is exactly 8117 in the first case and safely under the engine
    /// in the second, and it also bounds a stack that first-wins or defaults.
    func testDuplicateAttributesTakeTheSmallestOfTheDefaultAndEveryValue() {
        func section(_ values: [String]) -> String {
            (["v=0", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel"]
             + values.map { "a=max-message-size:\($0)" }).joined(separator: "\r\n")
        }
        // Order must not matter, in either direction.
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["0", "8117"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["8117", "0"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["8117", "65536"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["65536", "8117"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["262144", "8117"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["8117", "262144"])), 8_117)
        // A malformed sibling must not erase an explicit small bound. This is
        // the exact case the previous rule got wrong.
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["8117", "nonsense"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["nonsense", "8117"])), 8_117)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["-1", "8117"])), 8_117)
        // Nothing small present: the default still bounds the pair, because two
        // of them is a shape no conforming description produces.
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["262144", "262144"])),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["0", "0"])),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: section(["nonsense", "nonsense"])),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)

        // Two SCTP sections still take the smallest.
        let twoSections = """
        v=0\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        a=max-message-size:262144\r
        m=application 9 DTLS/SCTP 5000\r
        a=max-message-size:8117\r
        """
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: twoSections), 8_117)
    }

    /// Both line endings. CRLF is one Swift `Character`, so a parser that split
    /// on the LF character would read a whole real description as ONE line, see
    /// no `m=`, and answer the floor for every genuine peer — which is what a
    /// hand-written LF-only fixture would have hidden.
    func testBothLineEndingsAreRead() {
        let lf = "v=0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=max-message-size:8117\n"
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: lf), 8_117)

        let crlf = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=max-message-size:8117\r\n"
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: crlf), 8_117)
    }

    /// The attribute name is matched EXACTLY, because a real engine does.
    ///
    /// A headless Chrome probe of `RTCSctpTransport.maxMessageSize` answers
    /// 262 144 for `a=max-message-size:262144` and 65 536 for
    /// `a=MAX-MESSAGE-SIZE:262144`: it does not recognise the variant. A parser
    /// that case-folded would read 262 144 off an association really capped at
    /// 65 536 and hand the lanes a ceiling ABOVE what the peer can receive —
    /// and local policy would not clamp it, because `DEFAULT_MAX_FRAME_BYTES`
    /// is 192 KiB + 21.
    func testAnUnrecognisedAttributeSpellingIsIgnoredRatherThanBelieved() {
        let upper = """
        v=0\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        a=MAX-MESSAGE-SIZE:262144\r
        """
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: upper),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES,
                       "the engine ignores this spelling and defaults; so must this")
        XCTAssertLessThan(linkFrameCeiling(localPolicy: DEFAULT_MAX_FRAME_BYTES,
                                           negotiated: linkNegotiatedMaxMessageBytes(remoteSDP: upper)),
                          DEFAULT_MAX_FRAME_BYTES,
                          "local policy alone cannot save a ceiling read too high")

        for variant in ["Max-Message-Size", "MAX-MESSAGE-SIZE", "max-message-Size",
                        " max-message-size", "max_message_size"] {
            let sdp = """
            v=0\r
            m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
            a=\(variant):262144\r
            """
            XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp),
                           LINK_CONSERVATIVE_MAX_MESSAGE_BYTES, "a=\(variant)")
        }

        // And an unrecognised spelling must never RAISE a section that also
        // carries the real one.
        let mixed = """
        v=0\r
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
        a=MAX-MESSAGE-SIZE:262144\r
        a=max-message-size:8117\r
        """
        XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: mixed), 8_117)
    }

    /// Which SECTION counts is read leniently, and that asymmetry against the
    /// attribute name is deliberate.
    ///
    /// Strictness about the name stops this parser raising a ceiling. Strictness
    /// about the section would do the opposite: a section wrongly skipped takes
    /// its small advertisement with it and leaves the RFC default — ABOVE the
    /// bound the peer stated — in force. Leniency here only adds a candidate,
    /// and candidates are combined with `min`.
    func testAnUnfamiliarProtocolSpellingStillHonoursASmallBound() {
        for proto in ["UDP/DTLS/SCTP", "udp/dtls/sctp", "DTLS/SCTP", "TCP/DTLS/SCTP"] {
            let sdp = """
            v=0\r
            m=application 9 \(proto) webrtc-datachannel\r
            a=max-message-size:8117\r
            """
            XCTAssertEqual(linkNegotiatedMaxMessageBytes(remoteSDP: sdp), 8_117, proto)
        }
    }

    /// Parity with the engine root measured, stated as a relation rather than
    /// as prose.
    ///
    /// A headless Chrome probe of `RTCSctpTransport.maxMessageSize` recorded
    /// four cases (`artifacts/cross-network-review-20260919/sdp-engine-evidence.json`).
    /// This parser must never answer ABOVE the engine for the same description,
    /// because an answer above it is a frame the channel refuses after the nonce
    /// is spent; answering below only costs fragmentation.
    func testTheParserNeverAnswersAboveTheEngineItWasMeasuredAgainst() {
        func section(_ lines: [String]) -> String {
            (["v=0", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel"] + lines)
                .joined(separator: "\r\n")
        }
        // (description, what real Chrome negotiated)
        let measured: [(String, Double)] = [
            (section(["a=max-message-size:262144"]), 262_144),
            (section(["a=MAX-MESSAGE-SIZE:262144"]), 65_536),
            (section(["a=max-message-size:8117", "a=max-message-size:0"]), 262_144),
            (section(["a=max-message-size:0", "a=max-message-size:8117"]), 8_117),
        ]
        for (sdp, engine) in measured {
            let ours = linkNegotiatedMaxMessageBytes(remoteSDP: sdp)
            XCTAssertLessThanOrEqual(ours, engine,
                                     "answered \(ours) where the engine negotiated \(engine)")
        }
    }

    // MARK: - what cannot be fragmented

    /// Nothing the lanes emit that CANNOT be fragmented may be larger than the
    /// smallest ceiling this side will ever accept for a transfer.
    ///
    /// `LinkFileSession.pump` fails the lane closed below the smallest usable
    /// piece, so the chunk and manifest producers can never be asked for a frame
    /// they cannot cut. The other outbound frames have no such escape: a control
    /// is one byte, and `RESUME_REQ` and the generation-realignment marker are
    /// single unfragmentable JSON frames. If one of those could exceed an
    /// accepted ceiling, the lane would fail on a write instead of on a bound.
    ///
    /// Built from the production builders at their worst representable inputs
    /// rather than measured once and written down.
    func testEveryUnfragmentableFrameFitsTheSmallestAcceptedCeiling() throws {
        // Derived from `piecePlainBytes` itself, so a change to `MIN_PIECE_BYTES`
        // or `CHUNK_OVERHEAD` moves this test rather than silently invalidating it.
        var smallestAccepted = 0.0
        for candidate in 1...(MIN_PIECE_BYTES + 2 * CHUNK_OVERHEAD) where smallestAccepted == 0 {
            if (try? piecePlainBytes(maxFrameBytes: Double(candidate))) != nil {
                smallestAccepted = Double(candidate)
            }
        }
        XCTAssertGreaterThan(smallestAccepted, 0, "no ceiling at all is accepted for a transfer")
        XCTAssertThrowsError(try piecePlainBytes(maxFrameBytes: smallestAccepted - 1),
                             "and one byte less is refused, before any nonce")

        // The worst `RESUME_REQ` a conforming manifest can name.
        let widest = resumeReqFrame(index: MAX_FILES, offset: MANIFEST_MAX_SAFE_INTEGER)
        XCTAssertLessThan(Double(widest.count), smallestAccepted,
                          "a resume request is \(widest.count) B")

        // The worst realignment / resume marker: a sender whose sequence is at
        // its own ceiling.
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 3, count: 32))
        let marker = try sender.resumeStartFrame(ResumePoint(index: MAX_FILES,
                                                             offset: MANIFEST_MAX_SAFE_INTEGER))
        XCTAssertLessThan(Double(marker.count), smallestAccepted,
                          "a resume marker is \(marker.count) B")

        // Controls, on both lanes.
        XCTAssertLessThan(1.0, smallestAccepted)

        // And the conversation is still usable at that ceiling rather than
        // silently refusing every message.
        let limit = linkTextPlainLimit(maxFrameBytes: smallestAccepted)
        XCTAssertNotNil(limit)
        XCTAssertGreaterThan(limit ?? 0, 0,
                             "the smallest ceiling a transfer accepts still carries text")
    }

    // MARK: - local policy

    /// The smaller of the two always wins, and a NaN local policy still
    /// propagates — an injected NaN has always meant "the senders must refuse
    /// this", and it has to keep meaning it.
    func testTheEffectiveCeilingIsTheSmallerOfPolicyAndNegotiation() {
        XCTAssertEqual(linkFrameCeiling(localPolicy: DEFAULT_MAX_FRAME_BYTES, negotiated: 65_536),
                       65_536)
        XCTAssertEqual(linkFrameCeiling(localPolicy: 65_536, negotiated: 262_144), 65_536)
        XCTAssertEqual(linkFrameCeiling(localPolicy: DEFAULT_MAX_FRAME_BYTES, negotiated: .infinity),
                       DEFAULT_MAX_FRAME_BYTES)
        XCTAssertEqual(linkFrameCeiling(localPolicy: DEFAULT_MAX_FRAME_BYTES, negotiated: .nan),
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES,
                       "a transport that never answered is not an unlimited one")
        XCTAssertTrue(linkFrameCeiling(localPolicy: .nan, negotiated: 65_536).isNaN,
                      "an injected NaN policy still reaches the senders as a refusal")
        XCTAssertThrowsError(try piecePlainBytes(
            maxFrameBytes: linkFrameCeiling(localPolicy: .nan, negotiated: 65_536)))
    }

    // MARK: - the real initial transport

    private func initialHarness(role: Role = .responder)
    -> (FakeWebSocketChannel, WebRTCLinkTransport) {
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let transport = WebRTCLinkTransport(signaling: signaling, peerId: peer,
                                            role: role, iceServers: [])
        return (channel, transport)
    }

    /// Blocks until this side answered, which is the only observable proof from
    /// outside that the remote description was APPLIED.
    private func waitForAnswer(_ channel: FakeWebSocketChannel) {
        let answered = expectation(description: "the responder answered")
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(8)
            while Date() < deadline {
                if channel.sent.contains(where: { $0.contains("answer") }) {
                    answered.fulfill()
                    return
                }
                usleep(20_000)
            }
        }
        wait(for: [answered], timeout: 10)
    }

    /// Before anything is negotiated the answer is the RFC floor, not a local
    /// default: an un-negotiated connection is worth exactly what a peer that
    /// advertised nothing is worth.
    func testAnUnnegotiatedTransportReportsTheConservativeFloor() {
        let (_, transport) = initialHarness()
        defer { transport.close() }
        XCTAssertEqual(transport.negotiatedMaxMessageBytes,
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
    }

    /// The real driver, the real `setRemoteDescription`, the real offer: the
    /// value the peer advertised is what the transport reports afterwards.
    func testTheInitialTransportPublishesWhatTheAppliedDescriptionAdvertised() throws {
        for (advertised, expected) in [("8117", 8_117.0),
                                       ("262144", 262_144.0),
                                       ("0", Double.infinity)] {
            let (channel, transport) = initialHarness()
            defer { transport.close() }
            let sdp = try rewritingCeiling(try realOfferSDP(), to: advertised)

            transport.receive(from: peer,
                              signal: linkSDPSignal(kind: "offer", sdp: sdp,
                                                    commit: peerCommit,
                                                    caps: [LINK_CAPABILITY]))
            waitForAnswer(channel)
            XCTAssertEqual(transport.negotiatedMaxMessageBytes, expected,
                           "advertised \(advertised)")
        }
    }

    /// A peer that advertises nothing leaves the RFC default in force — which
    /// is the case this whole feature exists for, because it is lower than the
    /// chunk size this wire format is defined in.
    func testAPeerThatAdvertisesNothingLeavesTheRFCDefaultInForce() throws {
        let (channel, transport) = initialHarness()
        defer { transport.close() }
        let sdp = try rewritingCeiling(try realOfferSDP(), to: nil)

        transport.receive(from: peer,
                          signal: linkSDPSignal(kind: "offer", sdp: sdp,
                                                commit: peerCommit,
                                                caps: [LINK_CAPABILITY]))
        waitForAnswer(channel)
        XCTAssertEqual(transport.negotiatedMaxMessageBytes, 65_536)
        XCTAssertLessThan(transport.negotiatedMaxMessageBytes, DEFAULT_MAX_FRAME_BYTES,
                          "a frame sized by local policy alone would not fit this peer")
    }

    /// Reading the ceiling must not enter the transport's serial queue: a lane
    /// asks for it from inside its own initializer and from an attach that is
    /// about to take a driver lock.
    ///
    /// Bounded rather than a plain call, so a regression that made this a
    /// `queue.sync` fails the test instead of wedging the whole suite: the read
    /// happens on another thread while this one holds the queue busy.
    func testTheCeilingIsReadableWhileTheTransportQueueIsBusy() throws {
        let (_, transport) = initialHarness()
        defer { transport.close() }

        let occupied = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        // `onError` runs ON the transport's own queue, so the queue is held for
        // as long as this callback takes.
        transport.onError = { _ in
            occupied.signal()
            _ = release.wait(timeout: .now() + 5)
        }
        DispatchQueue.global().async { transport.receive(from: self.peer, signal: linkBusySignal()) }
        XCTAssertEqual(occupied.wait(timeout: .now() + 5), .success,
                       "the queue never became busy, so this test proved nothing")

        let read = expectation(description: "the ceiling was readable")
        DispatchQueue.global().async {
            XCTAssertEqual(transport.negotiatedMaxMessageBytes,
                           LINK_CONSERVATIVE_MAX_MESSAGE_BYTES)
            read.fulfill()
        }
        let outcome = XCTWaiter.wait(for: [read], timeout: 2)
        release.signal()
        XCTAssertEqual(outcome, .completed,
                       "reading the negotiated ceiling entered the transport queue")
    }

    // MARK: - the real replacement transport

    /// A rebuild negotiates its OWN association, and its own answer is what the
    /// lanes re-read at attach. Driven through the same authenticated path
    /// production uses: only a signal whose tag verifies is ever applied.
    func testTheReplacementTransportPublishesItsOwnNegotiation() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let existing = LinkIdentity(peerId: peer, role: .responder, sas: "482913",
                                    codecs: codecs, authenticationGeneration: 4)
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let transport = WebRTCLinkReplacementTransport(signaling: signaling,
                                                       identity: existing,
                                                       iceServers: [])
        defer { transport.close() }

        XCTAssertEqual(transport.negotiatedMaxMessageBytes,
                       LINK_CONSERVATIVE_MAX_MESSAGE_BYTES,
                       "nothing is negotiated before a description is applied")

        let sdp = try rewritingCeiling(try realOfferSDP(), to: "8117")
        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer", sdp: sdp,
                                                  key: codecs.resumeAuthKey))
        waitForAnswer(channel)
        XCTAssertEqual(transport.negotiatedMaxMessageBytes, 8_117)
    }

    /// A description this transport refuses to apply changes nothing. A
    /// signalling relay cannot lower a link's ceiling by offering its own
    /// rebuild — the tag is what stops the description being applied at all,
    /// and the ceiling is only ever taken from one that was.
    func testAnUnauthenticatedRebuildCannotLowerTheCeiling() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let foreign = LinkCodecs(sendKey: [UInt8](repeating: 8, count: 32),
                                 recvKey: [UInt8](repeating: 9, count: 32))
        let existing = LinkIdentity(peerId: peer, role: .responder, sas: "482913",
                                    codecs: codecs, authenticationGeneration: 4)
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "self")
        channel.fireOpen()
        let transport = WebRTCLinkReplacementTransport(signaling: signaling,
                                                       identity: existing,
                                                       iceServers: [])
        defer { transport.close() }

        let tiny = try rewritingCeiling(try realOfferSDP(), to: "1")
        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer", sdp: tiny,
                                                  key: foreign.resumeAuthKey))
        // Then the genuine peer, so this is a test about the TAG rather than
        // about a transport that never applies anything.
        let genuine = try rewritingCeiling(try realOfferSDP(), to: "262144")
        transport.receive(from: peer,
                          signal: resumeSDPSignal(kind: "offer", sdp: genuine,
                                                  key: codecs.resumeAuthKey))
        waitForAnswer(channel)
        XCTAssertEqual(transport.negotiatedMaxMessageBytes, 262_144)
    }
}
