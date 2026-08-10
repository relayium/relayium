import XCTest
@testable import RelayiumKit

/// The reusable text-conversation owner above `LinkTextLane` and the link's one
/// pair of text codecs.
///
/// The lane owns WHEN a conversation may carry plaintext; this owns the bytes.
/// Everything below therefore states the same invariant from a different angle:
/// a conversation boundary is not a codec boundary, so the link's single
/// `RealtimeTextSender`/`RealtimeTextReceiver` — and their AEAD sequences —
/// continue across every reopen, every drain and every replacement transport.
///
/// Two sessions really talk to each other here: one side's send key is the
/// other's receive key, so a frame produced by one is authenticated by the
/// other. Nothing is stubbed, and nothing is asynchronous.
///
/// Pinned against `web/src/lib/mixed-text-session.svelte.ts`.
final class LinkTextSessionTests: XCTestCase {

    private let request = LINK_TEXT_REQUEST
    private let end = LINK_TEXT_END
    private let accept = RealtimeControl.accept.rawValue
    private let reject = RealtimeControl.reject.rawValue

    /// A negotiated frame size a real DataChannel reports. 64 KiB of plaintext
    /// does NOT fit it once sealed, which is the whole point of the limit.
    private let maxFrame: Double = 65_536

    // MARK: - a linked pair

    private func pair() -> (a: LinkTextSession, b: LinkTextSession) {
        let one = [UInt8](repeating: 0x11, count: 32)
        let two = [UInt8](repeating: 0x22, count: 32)
        let a = LinkTextSession(identity: LinkIdentity(
            peerId: "peer-b", role: .initiator, sas: "123456",
            codecs: LinkCodecs(sendKey: one, recvKey: two)))
        let b = LinkTextSession(identity: LinkIdentity(
            peerId: "peer-a", role: .responder, sas: "123456",
            codecs: LinkCodecs(sendKey: two, recvKey: one)))
        return (a, b)
    }

    /// The one-byte lifecycle controls this side was told to send, in order.
    private func controls(_ effects: [LinkTextSessionEffect]) -> [UInt8] {
        effects.compactMap { if case let .sendControl(byte) = $0 { return byte } else { return nil } }
    }

    /// The sealed frames this side was told to send, in order. Deliberately a
    /// different accessor from `controls`: a test that could not tell the two
    /// apart would be as blind as the driver this owner refuses to make.
    private func protectedFrames(_ effects: [LinkTextSessionEffect]) -> [[UInt8]] {
        effects.compactMap { if case let .sendProtected(frame) = $0 { return frame } else { return nil } }
    }

    /// Everything that reaches the channel, in the order the effects came back.
    private func wire(_ effects: [LinkTextSessionEffect]) -> [[UInt8]] {
        effects.compactMap { effect -> [UInt8]? in
            switch effect {
            case let .sendControl(byte): return [byte]
            case let .sendProtected(frame): return frame
            default: return nil
            }
        }
    }

    /// Put everything one side produced onto the wire and hand it to the other,
    /// returning everything the far side did about it.
    @discardableResult
    private func deliver(_ effects: [LinkTextSessionEffect],
                         to peer: LinkTextSession) -> [LinkTextSessionEffect] {
        wire(effects).flatMap { peer.admitFrame($0) }
    }

    /// The one number that proves a reopened conversation did not restart a
    /// nonce: the sequence the sender sealed this frame under.
    private func sequence(of frame: [UInt8]) -> UInt32 {
        (UInt32(frame[1]) << 24) | (UInt32(frame[2]) << 16)
            | (UInt32(frame[3]) << 8) | UInt32(frame[4])
    }

    /// Open a conversation the ordinary way: A asks, B consents.
    private func openConversation(_ a: LinkTextSession, _ b: LinkTextSession) {
        deliver(deliver(a.localOpen(), to: b) + b.localAccept(), to: a)
    }

    // ── the whole conversation, twice, on one pair of codecs ────────────────

    func testAConversationOpensSendsEndsAndReopensOnOneSequence() throws {
        let (a, b) = pair()
        let sender = a.identity.codecs.textSender
        let receiver = b.identity.codecs.textReceiver

        XCTAssertEqual(a.localOpen(), [.sendControl(request), .armConsentTimeout])
        XCTAssertEqual(b.admitFrame([request]), [.armConsentTimeout])
        XCTAssertEqual(b.status, .incomingRequest)
        XCTAssertEqual(b.localAccept(), [.cancelConsentTimeout, .sendControl(accept)])
        XCTAssertEqual(a.admitFrame([accept]), [.cancelConsentTimeout])
        XCTAssertEqual(a.status, .open)
        XCTAssertEqual(b.status, .open)

        let first = protectedFrames(try a.send("hello", maxFrameBytes: maxFrame))
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(sequence(of: first[0]), 0)
        XCTAssertEqual(b.admitFrame(first[0]), [.received("hello")])

        // The reverse direction is a different key and a different counter.
        let back = protectedFrames(try b.send("你好 👋", maxFrameBytes: maxFrame))
        XCTAssertEqual(sequence(of: back[0]), 0)
        XCTAssertEqual(a.admitFrame(back[0]), [.received("你好 👋")])

        // End, symmetrically, and let the barrier close on both sides.
        let ended = a.localEnd()
        XCTAssertEqual(ended, [.sendControl(end), .armEndAckTimeout])
        XCTAssertEqual(deliver(deliver(ended, to: b), to: a), [.cancelEndAckTimeout])
        XCTAssertEqual(a.status, .ended)
        XCTAssertEqual(b.status, .ended)

        // Reopen. Same objects, and the sequence carries on from where the first
        // conversation left it.
        openConversation(a, b)
        XCTAssertEqual(a.status, .open)
        XCTAssertEqual(a.conversationCount, 2)
        let third = protectedFrames(try a.send("again", maxFrameBytes: maxFrame))
        XCTAssertEqual(sequence(of: third[0]), 1, "a reopen must never reset a nonce")
        XCTAssertEqual(b.admitFrame(third[0]), [.received("again")])

        XCTAssertTrue(a.identity.codecs.textSender === sender)
        XCTAssertTrue(b.identity.codecs.textReceiver === receiver)
    }

    // ── the drain a local END opens ─────────────────────────────────────────

    /// The peer cannot know about a local END until it arrives. Frames it sent
    /// first are authenticated — their sequence must be consumed — and shown to
    /// nobody.
    func testADrainAuthenticatesWithoutEmittingPlaintext() throws {
        let (a, b) = pair()
        openConversation(a, b)

        _ = a.localEnd()                                   // B has not seen it yet
        let crossing = protectedFrames(try b.send("in flight", maxFrameBytes: maxFrame))
        XCTAssertEqual(a.admitFrame(crossing[0]), [],
                       "drained frames are authenticated and never rendered")

        // B's END closes the drain, and the next conversation proves A's receive
        // sequence really did advance through the discarded frame.
        deliver(deliver([.sendControl(end)], to: b), to: a)
        openConversation(a, b)
        let next = protectedFrames(try b.send("after", maxFrameBytes: maxFrame))
        XCTAssertEqual(sequence(of: next[0]), 1)
        XCTAssertEqual(a.admitFrame(next[0]), [.received("after")],
                       "a drained frame that had not been fed would leave this out of order")
        XCTAssertFalse(a.codecsPoisoned)
    }

    // ── effect and timer order ──────────────────────────────────────────────

    /// A driver holds real timers, so the ORDER matters: a prompt that replaces
    /// an outstanding one must never leave the driver holding two, and a
    /// callback that is firing must never be told to cancel itself.
    func testTimerEffectsKeepTheirOrderAndAreNeverApproximate() throws {
        let (a, b) = pair()

        // Both users ask at once. The larger-id peer converts its own intent
        // into the one incoming prompt — cancellation first, arming second.
        _ = a.localOpen()
        _ = b.localOpen()
        XCTAssertEqual(b.admitFrame([request]), [.cancelConsentTimeout, .armConsentTimeout])
        XCTAssertEqual(a.admitFrame([request]), [.sendControl(reject)])

        // A consent window that expires ends the attempt; the timer that is
        // firing is not cancelled by its own callback.
        let (c, _) = pair()
        _ = c.localOpen()
        XCTAssertEqual(c.consentTimedOut(), [.sendControl(end), .armEndAckTimeout])
        XCTAssertEqual(c.endAckTimedOut(), [.poisonCodecs, .closeLane])
        XCTAssertEqual(c.status, .failed)

        // Consent refused locally: cancel, then answer.
        let (d, e) = pair()
        deliver(d.localOpen(), to: e)
        XCTAssertEqual(e.localReject(), [.cancelConsentTimeout, .sendControl(reject)])
        XCTAssertEqual(d.admitFrame([reject]), [.cancelConsentTimeout])
        XCTAssertEqual(d.status, .refused)
    }

    // ── a control and a sealed frame are different effects ──────────────────

    /// The driver must never look at bytes to know which of the two things it
    /// is sending, because the two failures are not the same failure.
    ///
    /// A control that never leaves the buffer costs this transport GENERATION:
    /// no AEAD sequence moved, and a replacement channel can send it again. A
    /// protected frame that never leaves has already spent a nonce the peer will
    /// never see, and no replacement transport can repair that — it poisons the
    /// link's text codecs. A single `sendFrame([UInt8])` erased exactly that
    /// distinction and left the driver to re-demux bytes this owner had just
    /// produced, which is both avoidable and, in one direction, impossible to do
    /// safely: today's controls are one byte, but nothing about the type says a
    /// sealed frame could not be.
    func testAControlAndAProtectedFrameAreStructurallyDifferentEffects() throws {
        // Identical bytes, different effects — the assertion a single
        // `sendFrame` case could not even express.
        XCTAssertNotEqual(LinkTextSessionEffect.sendControl(end),
                          LinkTextSessionEffect.sendProtected([end]))

        let (a, b) = pair()
        let opened = a.localOpen()
        XCTAssertEqual(controls(opened), [request])
        XCTAssertTrue(protectedFrames(opened).isEmpty, "a lifecycle byte is never a protected frame")

        deliver(opened, to: b)
        deliver(b.localAccept(), to: a)
        let sent = try a.send("hello", maxFrameBytes: maxFrame)
        XCTAssertTrue(controls(sent).isEmpty, "a sealed frame is never a lifecycle control")
        XCTAssertEqual(protectedFrames(sent).count, 1)

        // The split does not cost the ordering a driver depends on.
        let ended = a.localEnd()
        XCTAssertEqual(ended, [.sendControl(end), .armEndAckTimeout])
    }

    // ── the negotiated limit, matching the deployed web helper ──────────────

    /// `web/src/lib/text-wire.ts`'s `textPlainLimit`, number for number.
    ///
    /// Positive infinity is the one non-finite value that is an ANSWER rather
    /// than the absence of one: a connection reporting no ceiling is not a
    /// connection that reported nothing. The web computes
    /// `Math.min(Infinity, TEXT_MAX_BYTES)` and gets the product cap, so
    /// refusing it here would refuse every message on a link the deployed web
    /// carries happily. NaN is the opposite case and stays a refusal: there,
    /// every comparison against it is false, which is how an oversized message
    /// would reach `send()` and burn a nonce.
    func testThePositiveInfiniteLimitIsTheProductCapAndTheRestAreRefusals() throws {
        XCTAssertEqual(linkTextPlainLimit(maxFrameBytes: .infinity), TEXT_MAX_BYTES)
        XCTAssertEqual(linkTextPlainLimit(maxFrameBytes: 65_536),
                       65_536 - LINK_TEXT_FRAME_OVERHEAD)
        XCTAssertEqual(linkTextPlainLimit(maxFrameBytes: 65_536.9),
                       65_536 - LINK_TEXT_FRAME_OVERHEAD, "floored, exactly as the web floors it")
        XCTAssertEqual(linkTextPlainLimit(maxFrameBytes: 26), 5)
        XCTAssertEqual(linkTextPlainLimit(maxFrameBytes: 21), 0, "real, and uselessly small")
        for refused: Double in [.nan, -.infinity, -1, 0] {
            XCTAssertNil(linkTextPlainLimit(maxFrameBytes: refused), "maxFrameBytes \(refused)")
        }

        // End to end: a link that negotiated no ceiling really does send, and
        // the product cap is still the cap.
        let (a, b) = pair()
        openConversation(a, b)
        let sent = protectedFrames(try a.send("no ceiling", maxFrameBytes: .infinity))
        XCTAssertEqual(b.admitFrame(sent[0]), [.received("no ceiling")])
        XCTAssertThrowsError(try a.send(String(repeating: "x", count: TEXT_MAX_BYTES + 1),
                                        maxFrameBytes: .infinity)) {
            XCTAssertEqual($0 as? LinkTextSessionError,
                           .tooLong(bytes: TEXT_MAX_BYTES + 1, limit: TEXT_MAX_BYTES))
        }
    }

    // ── the outbound gate, all of it before a nonce ─────────────────────────

    func testAMessageIsRefusedBeforeAnyNonceIsConsumed() throws {
        let (a, b) = pair()

        XCTAssertThrowsError(try a.send("closed", maxFrameBytes: maxFrame)) {
            XCTAssertEqual($0 as? LinkTextSessionError, .notOpen)
        }
        openConversation(a, b)

        XCTAssertThrowsError(try a.send("", maxFrameBytes: maxFrame)) {
            XCTAssertEqual($0 as? LinkTextSessionError, .emptyBody)
        }
        // 21 bytes of header and tag are part of what a message costs, so a
        // 26-byte frame carries 5 bytes and a 25-byte frame carries 4.
        XCTAssertThrowsError(try a.send("hello", maxFrameBytes: 25)) {
            XCTAssertEqual($0 as? LinkTextSessionError, .tooLong(bytes: 5, limit: 4))
        }
        XCTAssertThrowsError(try a.send("hello", maxFrameBytes: 21)) {
            XCTAssertEqual($0 as? LinkTextSessionError, .tooLong(bytes: 5, limit: 0))
        }
        XCTAssertThrowsError(try a.send("hello", maxFrameBytes: 1)) {
            XCTAssertEqual($0 as? LinkTextSessionError, .tooLong(bytes: 5, limit: 0))
        }
        // A connection that never produced a usable number is not an unlimited
        // one. JavaScript's comparisons make every NaN test false, which is
        // exactly how an oversized message would reach `send()` and burn a nonce.
        // Positive infinity is NOT in this list: see the limit test below.
        for bogus: Double in [.nan, -.infinity, -1, 0] {
            XCTAssertThrowsError(try a.send("hello", maxFrameBytes: bogus)) {
                XCTAssertEqual($0 as? LinkTextSessionError, .unknownFrameLimit,
                               "maxFrameBytes \(bogus)")
            }
        }
        // The product cap still applies on a connection large enough not to bind.
        let oversize = String(repeating: "x", count: TEXT_MAX_BYTES + 1)
        XCTAssertThrowsError(try a.send(oversize, maxFrameBytes: 1_048_576)) {
            XCTAssertEqual($0 as? LinkTextSessionError,
                           .tooLong(bytes: TEXT_MAX_BYTES + 1, limit: TEXT_MAX_BYTES))
        }

        // Not one of those refusals moved the sender.
        let first = protectedFrames(try a.send("hello", maxFrameBytes: maxFrame))
        XCTAssertEqual(sequence(of: first[0]), 0, "a refused message must cost no nonce")
        XCTAssertEqual(b.admitFrame(first[0]), [.received("hello")])
        XCTAssertFalse(a.codecsPoisoned)
    }

    /// Once the frame exists its nonce is spent. A transport that then refuses
    /// the bytes leaves the peer's sequence unknowable, and only this lane ends.
    func testAProducedFrameThatCannotBeSentPoisonsOnlyText() throws {
        let (a, b) = pair()
        openConversation(a, b)
        _ = try a.send("hello", maxFrameBytes: maxFrame)

        XCTAssertEqual(a.protectedSendFailed(), [.poisonCodecs, .closeLane])
        XCTAssertEqual(a.status, .failed)
        XCTAssertTrue(a.codecsPoisoned)
        XCTAssertEqual(a.protectedSendFailed(), [], "terminal exactly once")
        XCTAssertThrowsError(try a.send("more", maxFrameBytes: maxFrame)) {
            XCTAssertEqual($0 as? LinkTextSessionError, .laneFailed)
        }
        XCTAssertEqual(a.localOpen(), [])
        XCTAssertFalse(b.codecsPoisoned, "the peer's own lane is not this side's to end")
    }

    /// A sender refusal is not one kind of event, and only one kind is about
    /// the message.
    ///
    /// A size refusal happens before anything is sealed: no nonce moved, the
    /// lane is untouched, and the next smaller message goes out normally. Every
    /// other refusal is a property of the SENDER, and the link owns exactly one
    /// of those for its whole life — a sender that cannot produce this frame can
    /// never produce another. Throwing a per-message error for that would leave
    /// the session `.open`, showing a composer that can only fail and leaving a
    /// peer waiting on a conversation this side can no longer continue. So it
    /// goes through the lane's single terminal path instead.
    ///
    /// **Testing limitation, stated precisely.** Neither terminal case is
    /// reachable through the public identity-only constructor, and this test
    /// proves why rather than assuming it: `invalidKey` needs a text key that is
    /// not 32 bytes, and `LinkCodecs` derives both text keys itself from the
    /// session keys; `sequenceExhausted` needs 2^32 sealed frames from a sender
    /// whose counter is private with no seeded initializer. Reaching either
    /// would mean adding codec injection or counter mutation — a second way to
    /// stand up a sender under a live key, which is the exact thing this design
    /// exists to make impossible. The classification is therefore tested
    /// directly and exhaustively, and `send` applies it in one unbranched place.
    func testATerminalSealRefusalIsClassifiedApartFromASizeRefusal() {
        XCTAssertFalse(linkTextSealIsTerminal(.messageTooLarge(bytes: 99, limit: 9)))
        XCTAssertTrue(linkTextSealIsTerminal(.sequenceExhausted))
        XCTAssertTrue(linkTextSealIsTerminal(.invalidKey))
        // Receive-side outcomes a sender cannot produce. An unexplained seal
        // refusal must never be GUESSED to be the retryable kind.
        let impossible: [RealtimeTextError] = [.malformedFrame, .wrongKind,
                                               .outOfOrder(expected: 0, actual: 1),
                                               .authenticationFailed, .invalidUTF8(bytes: 2)]
        for error in impossible {
            XCTAssertTrue(linkTextSealIsTerminal(error), "\(error)")
        }

        // Why the two terminal cases are unreachable rather than merely untried.
        let (a, _) = pair()
        XCTAssertEqual(a.identity.codecs.textSendKey.count, 32,
                       "the identity derives its own text keys, so invalidKey has no way in")
        XCTAssertEqual(linkTextPlainLimit(maxFrameBytes: .infinity), TEXT_MAX_BYTES,
                       "no admitted message can be larger than the sender's own refusal")
    }

    // ── transport gaps ──────────────────────────────────────────────────────

    /// `send()` only enqueues. Bytes still buffered when the transport dies mean
    /// the sender nonce may have advanced without the peer ever seeing the frame.
    func testAGapWithABufferedProtectedSendFailsTheLane() throws {
        let (a, b) = pair()
        openConversation(a, b)
        _ = try a.send("buffered", maxFrameBytes: maxFrame)

        let outcome = a.transportGap(bufferedBytes: 512)
        XCTAssertEqual(outcome.effects, [.poisonCodecs, .closeLane])
        XCTAssertFalse(outcome.needsRecovery, "a lane that is over does not hold the link open")
        XCTAssertTrue(a.codecsPoisoned)
        XCTAssertFalse(b.codecsPoisoned)
    }

    func testAGapAfterAFlushedSendKeepsTheConversationRecoverable() throws {
        let (a, b) = pair()
        openConversation(a, b)
        _ = try a.send("flushed", maxFrameBytes: maxFrame)
        a.didFlushSendBuffer()

        let outcome = a.transportGap(bufferedBytes: 0)
        XCTAssertTrue(outcome.needsRecovery, "a live conversation is worth a replacement")
        XCTAssertEqual(outcome.effects, [], "the prompt was already resolved by ACCEPT")
        XCTAssertEqual(a.status, .ended, "an interrupted conversation ends visibly")
        XCTAssertFalse(a.codecsPoisoned)
    }

    // ── inbound bytes a peer chose ──────────────────────────────────────────

    func testAMalformedKindNineFramePoisonsOnlyText() {
        let (a, b) = pair()
        openConversation(a, b)
        // Kind 9 with no room for an AEAD tag. It is not a control, and it is
        // not routable: on an ordered channel that is a text-lane failure.
        XCTAssertEqual(a.admitFrame([RealtimeKind.text, 0, 0, 0, 0]),
                       [.poisonCodecs, .closeLane])
        XCTAssertTrue(a.codecsPoisoned)
        XCTAssertFalse(b.codecsPoisoned)
    }

    func testAForgedFrameFailsAuthenticationAndPoisonsOnlyText() throws {
        let (a, b) = pair()
        openConversation(a, b)
        var frame = protectedFrames(try b.send("real", maxFrameBytes: maxFrame))[0]
        frame[8] ^= 0x01
        XCTAssertEqual(a.admitFrame(frame), [.poisonCodecs, .closeLane])
        XCTAssertTrue(a.codecsPoisoned)
    }

    func testInvalidUTF8PoisonsOnlyText() {
        let (a, b) = pair()
        openConversation(a, b)
        // Authenticates perfectly and is not a string. "Opaque valid Unicode" is
        // a contract the receiver enforces, never one it hopes for.
        let sealed = seal(key: b.identity.codecs.textSendKey, seq: 0, plaintext: [0xff, 0xfe])
        let frame = realtimeFrame(kind: RealtimeKind.text, seq: 0, payload: sealed)
        XCTAssertEqual(a.admitFrame(frame), [.poisonCodecs, .closeLane])
    }

    func testAnOutOfOrderFramePoisonsOnlyText() throws {
        let (a, b) = pair()
        openConversation(a, b)
        _ = try b.send("first", maxFrameBytes: maxFrame)
        let second = protectedFrames(try b.send("second", maxFrameBytes: maxFrame))[0]
        XCTAssertEqual(sequence(of: second), 1)
        XCTAssertEqual(a.admitFrame(second), [.poisonCodecs, .closeLane],
                       "a gap the ordered channel cannot have produced is terminal")
    }

    /// The web ignores anything that is neither a one-byte control nor a kind-9
    /// frame. It consumes no sequence, so the next real frame must still land.
    func testAnUnknownFrameIsIgnoredWithoutMovingTheSequence() throws {
        let (a, b) = pair()
        openConversation(a, b)
        for junk in [[UInt8](), [0x07, 1, 2, 3], [0x00], [RealtimeKind.chunk, 9, 9, 9, 9, 9]] {
            XCTAssertEqual(a.admitFrame(junk), [], "\(junk)")
        }
        XCTAssertFalse(a.codecsPoisoned)
        let real = protectedFrames(try b.send("still fine", maxFrameBytes: maxFrame))[0]
        XCTAssertEqual(a.admitFrame(real), [.received("still fine")])
    }

    // ── replacement transports ──────────────────────────────────────────────

    func testAReplacementTransportKeepsTheCodecObjectsAndTheirSequences() throws {
        let (a, b) = pair()
        openConversation(a, b)
        let sender = a.identity.codecs.textSender
        let receiver = a.identity.codecs.textReceiver
        _ = try a.send("before", maxFrameBytes: maxFrame)

        a.didFlushSendBuffer()
        XCTAssertTrue(a.transportGap(bufferedBytes: 0).needsRecovery)
        XCTAssertEqual(a.didAttachReplacementTransport(), [])
        XCTAssertEqual(a.status, .ended)

        XCTAssertTrue(a.identity.codecs.textSender === sender, "a replacement never replaces codecs")
        XCTAssertTrue(a.identity.codecs.textReceiver === receiver)

        // B never saw the gap, so its conversation is still open and it answers a
        // reopen with REJECT. It has to end on its own terms first — and then the
        // sequence continues from exactly where the old channel left it.
        XCTAssertEqual(controls(deliver(a.localOpen(), to: b)), [reject])
        XCTAssertEqual(a.admitFrame([reject]), [.cancelConsentTimeout])
        XCTAssertEqual(a.status, .refused)
        deliver(b.localEnd(), to: a)
        openConversation(a, b)
        XCTAssertEqual(a.status, .open)
        let after = protectedFrames(try a.send("after", maxFrameBytes: maxFrame))[0]
        XCTAssertEqual(sequence(of: after), 1)
    }

    // ── the lanes really are independent ────────────────────────────────────

    func testTheFileLaneIsUntouchedByATerminalTextLane() throws {
        let one = [UInt8](repeating: 0x33, count: 32)
        let two = [UInt8](repeating: 0x44, count: 32)
        let codecs = LinkCodecs(sendKey: one, recvKey: two)
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "246810", codecs: codecs)
        let text = LinkTextSession(identity: identity)
        let files = LinkFileSession(codecs: codecs)

        XCTAssertEqual(text.admitFrame([RealtimeKind.text, 0, 0, 0, 0]),
                       [.poisonCodecs, .closeLane])
        XCTAssertTrue(text.codecsPoisoned)

        XCTAssertFalse(files.laneFailed, "text poisons text")
        let batch = try files.enqueue(files: [FileMeta(name: "a.bin", size: 8)])
        XCTAssertFalse(files.pump().isEmpty)
        XCTAssertEqual(files.outboundBatch, batch)
        XCTAssertTrue(codecs.fileSender === identity.codecs.fileSender)
    }

    // ── nothing here is reachable from production ───────────────────────────

    func testTheLinkFeatureFlagsRemainFalse() {
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }
}
