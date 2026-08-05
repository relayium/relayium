import XCTest
@testable import RelayiumKit

/// The reusable `link/1` file lane's generation, checkpoint and flow state.
///
/// Pure and synchronous by design: none of this is reachable through a live
/// `RTCDataChannel` in a test, and all of it is where the bugs are. Pinned
/// against `web/src/lib/mixed-file-session.svelte.ts`.
final class LinkFileLaneTests: XCTestCase {

    private let C = CHUNK_SIZE
    private let zeroChain = [UInt8](repeating: 0, count: 32)
    private func chain(_ byte: UInt8) -> [UInt8] { [UInt8](repeating: byte, count: 32) }

    private func chunkFrame(_ plaintext: Int) -> [UInt8] {
        realtimeFrame(kind: RealtimeKind.chunk, seq: 0,
                      payload: [UInt8](repeating: 0, count: plaintext + 16))
    }
    private func partFrame(_ plaintext: Int) -> [UInt8] {
        realtimeFrame(kind: RealtimeKind.chunkPart, seq: 0,
                      payload: [UInt8](repeating: 0, count: plaintext + 16))
    }
    private var doneFrame: [UInt8] {
        realtimeFrame(kind: RealtimeKind.doneEnc, seq: 0, payload: [UInt8](repeating: 0, count: 64))
    }
    private var manifestFrame: [UInt8] {
        realtimeFrame(kind: RealtimeKind.batchEnc, seq: 0, payload: [UInt8](repeating: 0, count: 64))
    }

    // ── the initial generation is aligned ───────────────────────────────────

    func testAFreshLaneOwesAndRequiresNothing() throws {
        let lane = LinkFileLane()
        XCTAssertEqual(lane.generation, 0)
        XCTAssertFalse(lane.outboundOwesResumeMarker)
        XCTAssertFalse(lane.inboundRequiresResumeMarker)
        XCTAssertFalse(lane.codecsPoisoned)
        XCTAssertTrue(lane.maySendProtected)

        try lane.beginOutboundBatch(sizes: [C])
        XCTAssertNoThrow(try lane.didProduceFrame(manifestFrame))
        XCTAssertNoThrow(try lane.didProduceFrame(chunkFrame(C)))
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: C))

        try lane.beginInboundBatch(sizes: [C])
        XCTAssertEqual(lane.admitInboundFrame(chunkFrame(C)), .feedProtected)
    }

    /// An announcement on a lane that never lost its transport is a free
    /// sequence jump at a moment the peer chooses. Refused, and terminal.
    func testAResumeMarkerOnALiveAlignedLaneIsAProtocolFailure() throws {
        let lane = LinkFileLane()
        let (sender, receiver) = try aligned()
        XCTAssertThrowsError(try lane.acceptResumeStart(ResumePoint(index: 0, offset: 0),
                                                        seq: sender.nextSequence, receiver: receiver)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unexpectedResumeMarker)
        }
        XCTAssertTrue(lane.codecsPoisoned)
        XCTAssertEqual(lane.terminalEffects, [.poisonCodecs, .closeLane])
    }

    // ── the gap and its single realignment ──────────────────────────────────

    func testAGapOwesExactlyOneMarkerInEachDirectionAndPoisonsNothing() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        try lane.didProduceFrame(chunkFrame(C))

        let outcome = lane.transportGap()
        XCTAssertTrue(outcome.needsRecovery, "a consented batch is worth holding the link for")
        XCTAssertEqual(outcome.effects, [], "a gap alone never poisons a file codec")
        XCTAssertFalse(lane.codecsPoisoned)
        XCTAssertEqual(lane.generation, 1)
        XCTAssertTrue(lane.outboundOwesResumeMarker)
        XCTAssertTrue(lane.inboundRequiresResumeMarker)
    }

    /// A channel `onclose` and the PeerConnection's own terminal callback are ONE
    /// gap however many times they report it — and however long the replacement
    /// takes. Repeating them must not multiply the debt into a second marker the
    /// peer will reject.
    func testRepeatedGapsStillOweExactlyOneMarker() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        let first = lane.transportGap()
        for _ in 0..<5 { XCTAssertFalse(lane.transportGap().effects.contains(.poisonCodecs)) }
        XCTAssertTrue(first.needsRecovery)
        XCTAssertEqual(lane.generation, 1, "one transport era, however many callbacks reported it")

        lane.didAttachReplacementTransport()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 9, count: 32))
        _ = try lane.outboundBatchResume(to: ResumePoint(index: 0, offset: 0), sender: sender)
        XCTAssertFalse(lane.outboundOwesResumeMarker)
        // A second era owes its own single marker.
        _ = lane.transportGap()
        XCTAssertEqual(lane.generation, 2)
        XCTAssertTrue(lane.outboundOwesResumeMarker)
    }

    func testAnIdleLaneStillOwesItsRealignmentButDoesNotAskForRecovery() {
        let lane = LinkFileLane()
        let outcome = lane.transportGap()
        XCTAssertFalse(outcome.needsRecovery, "nothing in flight is nothing to hold the link for")
        XCTAssertTrue(lane.outboundOwesResumeMarker)
        XCTAssertTrue(lane.inboundRequiresResumeMarker)
    }

    /// Recovery holds the whole link — and the initiator's ICE/TURN allocations —
    /// open for work a replacement could restore. A terminal lane has none: its
    /// codecs are unusable, so no replacement can carry its batch however long
    /// the link waits for one.
    func testATerminalLaneNeverAsksForRecovery() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertEqual(lane.admitInboundFrame([RealtimeKind.text, 0, 0, 0, 0]),
                       .failClosed(.unroutableFrame))

        let outcome = lane.transportGap()
        XCTAssertFalse(outcome.needsRecovery, "there is nothing a replacement could restore")
        XCTAssertEqual(outcome.effects, [], "the gap itself still poisons nothing")
        XCTAssertEqual(lane.generation, 0, "a terminal lane starts no new era")
        XCTAssertFalse(lane.outboundOwesResumeMarker, "and owes no marker it could never send")
        XCTAssertFalse(lane.inboundRequiresResumeMarker)
        XCTAssertEqual(lane.terminalEffects, [.poisonCodecs, .closeLane])
    }

    /// The other order, which is the one a real link hits: the gap came first and
    /// DID ask for recovery, then the lane failed while the replacement was still
    /// being negotiated. Every later report of that same gap must answer with what
    /// is true now, or the link holds an allocation open for a lane that is gone.
    func testAGapThatLaterFailsStopsClaimingRecovery() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertTrue(lane.transportGap().needsRecovery)
        XCTAssertEqual(lane.generation, 1)

        XCTAssertEqual(lane.admitInboundFrame([RealtimeKind.text, 0, 0, 0, 0]),
                       .failClosed(.unroutableFrame))
        let again = lane.transportGap()
        XCTAssertFalse(again.needsRecovery, "the lane it would have restored is gone")
        XCTAssertEqual(lane.generation, 1, "and no era was started for it")
    }

    // ── the outbound barrier ────────────────────────────────────────────────

    func testProtectedOutputDuringTheGapIsTheGapAndNotAFailure() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        _ = lane.transportGap()
        XCTAssertThrowsError(try lane.didProduceFrame(chunkFrame(C))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertFalse(lane.codecsPoisoned, "the next generation's marker repairs a burned nonce")
        XCTAssertFalse(lane.maySendProtected)
    }

    /// The marker is what makes the announced seq the one the next protected
    /// frame carries. Emitting a frame before it leaves the peer realigning to a
    /// number that is already stale, and no later frame can repair that.
    func testProtectedOutputBeforeTheMarkerIsTerminal() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertThrowsError(try lane.didProduceFrame(chunkFrame(C))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .protectedBeforeRealignment)
        }
        XCTAssertTrue(lane.codecsPoisoned)
    }

    func testTheOutboundMarkerUsesTheLinkLifetimeSendersOwnSequence() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x51, count: 32))
        _ = try sender.batchFrame([FileMeta(name: "a", size: 8)])
        let before = sender.nextSequence
        XCTAssertGreaterThan(before, 0)

        try lane.beginOutboundBatch(sizes: [2 * C])
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        let point = ResumePoint(index: 0, offset: C)
        let frame = try lane.outboundBatchResume(to: point, sender: sender)
        XCTAssertEqual(frame, try sender.resumeStartFrame(point),
                       "the announcement must name the sequence the real sender will use next")
        XCTAssertEqual(sender.nextSequence, before, "a plaintext announcement burns no nonce")
        XCTAssertFalse(lane.outboundOwesResumeMarker)
        XCTAssertNoThrow(try lane.didProduceFrame(chunkFrame(C)))
    }

    func testASecondOutboundMarkerInOneGenerationIsTerminal() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x52, count: 32))
        try lane.beginOutboundBatch(sizes: [C])
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = try lane.outboundBatchResume(to: ResumePoint(index: 0, offset: 0), sender: sender)
        XCTAssertThrowsError(try lane.outboundBatchResume(to: ResumePoint(index: 0, offset: 0), sender: sender)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unexpectedResumeMarker)
        }
        XCTAssertTrue(lane.codecsPoisoned)
    }

    /// An idle direction realigns at the batch-free origin, which is the only
    /// point that means anything with no batch to validate against.
    func testTheIdleOutboundMarkerIsTheOriginAndRefusesAnythingElse() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x53, count: 32))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertThrowsError(try lane.outboundBatchResume(to: ResumePoint(index: 0, offset: 0), sender: sender)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .noActiveBatch)
        }
        let frame = try lane.outboundOriginRealignment(sender: sender)
        XCTAssertEqual(frame, try sender.resumeStartFrame(ResumePoint(index: 0, offset: 0)))
        XCTAssertFalse(lane.outboundOwesResumeMarker)
    }

    // ── nothing moves before the replacement attaches ───────────────────────

    /// The gap records the debt; only a replacement transport can pay it. In
    /// between there is no channel for an announcement to leave on, so a marker
    /// built here names a sequence the peer never receives — and the debt it
    /// cleared is never owed again, which is exactly the state a protected frame
    /// then walks straight through.
    func testAnOutboundResumeBeforeTheReplacementAttachesIsTheGap() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x57, count: 32))
        try lane.beginOutboundBatch(sizes: [3 * C])
        try lane.didProduceFrame(chunkFrame(C))
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()

        let point = ResumePoint(index: 0, offset: C)
        XCTAssertThrowsError(try lane.outboundBatchResume(to: point, sender: sender)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertFalse(lane.codecsPoisoned, "a call inside the gap proves nothing about the codecs")
        XCTAssertTrue(lane.outboundOwesResumeMarker, "the era's debt is still unpaid")
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: 2 * C),
                       "no cursor rebased to a point nothing was announced for")
        XCTAssertEqual(lane.attemptBytes, 2 * C, "and the window did not reopen")

        lane.didAttachReplacementTransport()
        XCTAssertNoThrow(try lane.outboundBatchResume(to: point, sender: sender))
        XCTAssertFalse(lane.outboundOwesResumeMarker)
        XCTAssertEqual(lane.attemptFrontier, point)
    }

    func testAnIdleOriginRealignmentBeforeTheReplacementAttachesIsTheGap() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x58, count: 32))
        _ = lane.transportGap()
        XCTAssertThrowsError(try lane.outboundOriginRealignment(sender: sender)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertTrue(lane.outboundOwesResumeMarker)
        XCTAssertFalse(lane.codecsPoisoned)

        lane.didAttachReplacementTransport()
        XCTAssertNoThrow(try lane.outboundOriginRealignment(sender: sender))
        XCTAssertFalse(lane.outboundOwesResumeMarker)
    }

    /// A frame can only arrive over a transport, so an announcement reaching this
    /// side before the owner has reported the replacement is an ordering fault in
    /// the owner — and accepting it would spend the era's one acceptance on a
    /// frame from the transport that died.
    func testAcceptingAMarkerBeforeTheReplacementAttachesIsTheGap() throws {
        let lane = LinkFileLane()
        let (sender, receiver) = try aligned()
        try lane.beginInboundBatch(sizes: [2 * C])
        let point = try lane.didAdmitChunk(byteCount: C, chain: chain(0x3d))
        _ = lane.didPersist(point)
        _ = lane.transportGap()

        XCTAssertThrowsError(try lane.acceptResumeStart(point.point, seq: sender.nextSequence,
                                                        receiver: receiver)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertFalse(lane.codecsPoisoned)
        XCTAssertTrue(lane.inboundRequiresResumeMarker, "the era still requires its one marker")

        lane.didAttachReplacementTransport()
        _ = try lane.resumeRequestFrame()
        XCTAssertNoThrow(try lane.acceptResumeStart(point.point, seq: sender.nextSequence,
                                                    receiver: receiver))
        XCTAssertFalse(lane.inboundRequiresResumeMarker)
    }

    // ── an idle generation admits no new batch until it realigns ────────────

    /// A gap suspends the lane, and the web peer's own launch gate says what that
    /// means for new work: `pump()` refuses to start a batch while `suspended`,
    /// and re-checks it after `ensureLink` resolves, because "a batch must never
    /// launch into that". Admitting one here would put the lane in a state whose
    /// only exit is an API documented for something else.
    func testAnIdleGenerationAdmitsNoOutboundBatchBeforeAttach() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x5a, count: 32))
        _ = lane.transportGap()

        XCTAssertThrowsError(try lane.beginOutboundBatch(sizes: [C])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertFalse(lane.codecsPoisoned, "refusing new work proves nothing about the codecs")
        XCTAssertTrue(lane.outboundOwesResumeMarker)
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: 0))
        XCTAssertEqual(lane.attemptBytes, 0)

        // The proof that nothing was admitted: the origin realignment is still
        // reachable, and it is the call that refuses an active batch.
        lane.didAttachReplacementTransport()
        XCTAssertNoThrow(try lane.outboundOriginRealignment(sender: sender))
    }

    /// The debt outlives the attach. Until it is paid, the manifest that a new
    /// batch's first frame carries cannot legally go out — so the batch may not be
    /// admitted either, or the lane holds work whose first act is already illegal.
    func testAnAttachedGenerationAdmitsNoOutboundBatchUntilItsOriginMarkerIsPaid() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x5b, count: 32))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        XCTAssertThrowsError(try lane.beginOutboundBatch(sizes: [C])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .realignmentPending)
        }
        XCTAssertFalse(lane.codecsPoisoned, "the caller may simply pay the debt and retry")
        XCTAssertTrue(lane.outboundOwesResumeMarker, "which the refusal left it able to do")

        // Not stuck: the origin realignment is still the available move, which it
        // would not be had the refused call mutated `outSizes`.
        let frame = try lane.outboundOriginRealignment(sender: sender)
        XCTAssertEqual(frame, try sender.resumeStartFrame(ResumePoint(index: 0, offset: 0)))
        XCTAssertNoThrow(try lane.beginOutboundBatch(sizes: [C]))
        XCTAssertFalse(lane.outboundOwesResumeMarker,
                       "an admitted outbound batch now implies the era's debt is paid")
    }

    /// The exact valid order, end to end against a real sender/receiver pair whose
    /// sequence is already well past zero: gap -> attach -> origin realignment ->
    /// begin batch -> first protected frame. The manifest must decrypt on the far
    /// side, which is the whole reason the realignment comes first.
    func testTheIdleGenerationsValidOrderRealignsThenAdmitsThenProduces() throws {
        let key = [UInt8](repeating: 0x63, count: 32)
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        // A first generation ran and finished, so neither counter is at zero.
        let first = WireVectors.content(64, seed: 44)
        let firstMeta = FileMeta(name: "first.bin", size: first.count)
        for frame in try sender.batchFrames([firstMeta]) { _ = try receiver.feed(frame) }
        for frame in try sender.dataFrames([(firstMeta, first)]) { _ = try receiver.feed(frame) }
        receiver.abortBatch()

        let lane = LinkFileLane()
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        // The gap burned nonces the peer never saw; the marker carries it forward.
        _ = try sender.nextChunkFrame([1, 2, 3])
        let marker = try lane.outboundOriginRealignment(sender: sender)
        guard let announced = parseResumeStart(marker) else { return XCTFail("marker shape") }
        XCTAssertEqual(announced.point, ResumePoint(index: 0, offset: 0))
        try receiver.resumeAtOrigin(seq: announced.seq)

        let body = WireVectors.content(2 * C, seed: 45)
        let meta = FileMeta(name: "next.bin", size: body.count)
        try lane.beginOutboundBatch(sizes: [body.count])
        var events: [RealtimeEvent] = []
        for frame in try sender.batchFrames([meta]) {
            try lane.didProduceFrame(frame)
            events.append(try receiver.feed(frame))
        }
        XCTAssertEqual(events.last, .batch([meta]), "the manifest decrypts after the realignment")

        var got: [UInt8] = []
        for frame in try sender.dataFrames([(meta, body)]) {
            try lane.didProduceFrame(frame)
            if case let .chunk(plain) = try receiver.feed(frame) { got += plain }
        }
        XCTAssertEqual(got, body)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: body.count))
        XCTAssertFalse(lane.codecsPoisoned)
    }

    /// The web's own recovery path for a batch whose `RESUME_REQ` never arrives:
    /// end only that batch, leave the realignment unspent, and "the next batch
    /// gets to announce the origin and carry on". Retiring is what makes the
    /// origin the meaningful point again.
    func testARetiredBatchRealignsAtTheOriginBeforeTheNextOneIsAdmitted() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x5c, count: 32))
        try lane.beginOutboundBatch(sizes: [2 * C])
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        // The peer's request never came. Only this batch ends.
        lane.retireOutboundBatch()
        XCTAssertTrue(lane.outboundOwesResumeMarker, "a retired batch pays no debt")
        XCTAssertThrowsError(try lane.beginOutboundBatch(sizes: [C])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .realignmentPending)
        }

        _ = try lane.outboundOriginRealignment(sender: sender)
        try lane.beginOutboundBatch(sizes: [C])
        XCTAssertNoThrow(try lane.didProduceFrame(chunkFrame(C)))
        XCTAssertFalse(lane.codecsPoisoned)

        // One realignment per ERA, not per batch. The next batch in this same
        // generation is admitted with no further announcement — which is exactly
        // what `runOutbound`'s `if (resyncOut)` gate means on the web, and a
        // second marker here is one the peer is required to reject.
        lane.retireOutboundBatch()
        XCTAssertFalse(lane.outboundOwesResumeMarker)
        XCTAssertNoThrow(try lane.beginOutboundBatch(sizes: [50]))
        XCTAssertNoThrow(try lane.didProduceFrame(chunkFrame(50)))
    }

    /// The guard is about NEW work only. A batch admitted before the gap is
    /// exactly what a resume exists for, and it still resumes through the request
    /// the peer really sends.
    func testABatchAdmittedBeforeTheGapIsUnaffectedByTheAdmissionGuard() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x5d, count: 32))
        try lane.beginOutboundBatch(sizes: [2 * C])
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        let point = ResumePoint(index: 0, offset: C)
        XCTAssertNoThrow(try lane.outboundBatchResume(to: point, sender: sender))
        XCTAssertNoThrow(try lane.didProduceFrame(chunkFrame(C)))
    }

    // ── the inbound side keeps its barrier where it already is ──────────────

    /// Deliberately NO matching guard on `beginInboundBatch`. A manifest is a
    /// PROTECTED frame, so the only way one reaches an owner is through this
    /// lane's own demux — which refuses protected input terminally while the
    /// era's marker is unpaid. The barrier is the routing gate, and a second one
    /// at the admission call would guard a state that cannot be reached.
    func testAnInboundManifestCannotEvenBeRoutedBeforeTheMarkerIsAccepted() throws {
        let lane = LinkFileLane()
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertTrue(lane.inboundRequiresResumeMarker)
        XCTAssertEqual(lane.admitInboundFrame(manifestFrame),
                       .failClosed(.protectedBeforeRealignment))
        XCTAssertTrue(lane.codecsPoisoned)
    }

    /// And the ordering that DOES reach `beginInboundBatch` across a gap must keep
    /// working: a manifest the OLD generation authenticated, whose consent and
    /// bookkeeping complete after the transport died. Refusing it would drop the
    /// very batch recovery exists to restore — the same reason `didPersist`
    /// commits a write that crossed a replacement.
    func testAManifestAuthenticatedBeforeTheGapIsStillAdmittedAfterIt() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])   // the outbound side is busy elsewhere
        _ = lane.transportGap()

        XCTAssertNoThrow(try lane.beginInboundBatch(sizes: [2 * C]))
        XCTAssertFalse(lane.codecsPoisoned)
        lane.didAttachReplacementTransport()
        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: 0),
                       "and it can then ask the peer to resume it from the origin")
    }

    // ── the receiver's half of the handshake ────────────────────────────────

    /// The request is one half of a handshake, not a getter: it names this side's
    /// durable prefix to a peer that is about to resume from it.
    func testTheResumeRequestIsRefusedUntilTheReplacementAttaches() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [2 * C])
        _ = lane.transportGap()
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertFalse(lane.codecsPoisoned)

        lane.didAttachReplacementTransport()
        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: 0))
    }

    func testALaneThatNeverLostItsTransportHasNoRequestToMake() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unexpectedResumeRequest)
        }
        XCTAssertFalse(lane.codecsPoisoned, "a local misuse is not a wire event")
    }

    /// Exactly one per era. A second request would let the peer answer twice, and
    /// the second answer is a marker its own lane must then reject as a duplicate.
    func testTheResumeRequestIsOneShotPerGeneration() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [2 * C])
        let point = try lane.didAdmitChunk(byteCount: C, chain: chain(0x6a))
        _ = lane.didPersist(point)
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: C))
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unexpectedResumeRequest)
        }
        XCTAssertFalse(lane.codecsPoisoned)
        XCTAssertTrue(lane.inboundRequiresResumeMarker, "a refused duplicate changed nothing")
    }

    /// An idle direction has nothing to resume, so it asks for nothing and waits
    /// for the peer's lazy origin announcement before that peer's next batch.
    func testAnIdleDirectionSendsNoRequestAndStillTakesTheOriginMarker() throws {
        let (sender, receiver) = try aligned()
        receiver.abortBatch()
        let lane = LinkFileLane()
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .noActiveBatch)
        }
        XCTAssertNoThrow(try lane.acceptResumeStart(ResumePoint(index: 0, offset: 0),
                                                    seq: sender.nextSequence, receiver: receiver))
        XCTAssertFalse(lane.inboundRequiresResumeMarker)
    }

    /// The request names the durable prefix, so a write the owner has not
    /// reported back on means it would name a point the receive FIFO is about to
    /// move underneath it.
    func testTheResumeRequestWaitsForTheAdmittedWriteToSettle() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [2 * C])
        let point = try lane.didAdmitChunk(byteCount: C, chain: chain(0x6b))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .persistAlreadyPending)
        }
        XCTAssertFalse(lane.codecsPoisoned)
        _ = lane.didPersist(point)
        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: C),
                       "the settled write is exactly what the request now names")
    }

    /// The handshake is REQUEST then ANNOUNCEMENT. A marker for an active inbound
    /// batch that arrives before this era's request was built cannot be an answer
    /// to it — it is a stale era's frame or a forged one, and accepting it spends
    /// the era's one acceptance on it, leaving the real answer to be rejected.
    func testAMarkerAheadOfThisGenerationsRequestIsTerminal() throws {
        let lane = LinkFileLane()
        let (sender, receiver) = try aligned()
        try lane.beginInboundBatch(sizes: [2 * C])
        let point = try lane.didAdmitChunk(byteCount: C, chain: chain(0x6c))
        _ = lane.didPersist(point)
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        XCTAssertThrowsError(try lane.acceptResumeStart(point.point, seq: sender.nextSequence,
                                                        receiver: receiver)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .resumeMarkerBeforeRequest)
        }
        XCTAssertTrue(lane.codecsPoisoned)
        XCTAssertEqual(lane.terminalEffects, [.poisonCodecs, .closeLane])
    }

    func testAPoisonedLaneBuildsNoResumeRequest() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = lane.admitInboundFrame([RealtimeKind.text, 0, 0, 0, 0])
        XCTAssertTrue(lane.codecsPoisoned)

        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .laneFailed)
        }
    }

    /// A replacement whose own transport dies before the handshake finishes. The
    /// request built for the era that died is spent with it; the NEXT era owes and
    /// permits exactly one fresh request, naming the prefix that is durable by then.
    func testASecondGapPermitsExactlyOneFreshRequest() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [3 * C])
        let durable = try lane.didAdmitChunk(byteCount: C, chain: chain(0x71))
        _ = lane.didPersist(durable)

        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: C))
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unexpectedResumeRequest)
        }

        // The replacement dies before the peer's announcement ever arrives.
        XCTAssertTrue(lane.transportGap().needsRecovery)
        XCTAssertEqual(lane.generation, 2)
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap,
                           "still nothing to send it on")
        }

        lane.didAttachReplacementTransport()
        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: C),
                       "the new era asks again, from the same durable prefix")
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unexpectedResumeRequest,
                           "and exactly once in this era too")
        }
    }

    // ── the produced frontier ───────────────────────────────────────────────

    func testTheFrontierFollowsTheFixedGridAndExactFileEnds() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [2 * C, 50])
        try lane.didProduceFrame(manifestFrame)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 0),
                       "a manifest is not file progress")
        try lane.didProduceFrame(chunkFrame(C))
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: C))
        try lane.didProduceFrame(chunkFrame(C))
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 2 * C))
        try lane.didProduceFrame(doneFrame)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 1, offset: 0),
                       "a finished file that is not the last one moves to the next file's zero")
        try lane.didProduceFrame(chunkFrame(50))
        try lane.didProduceFrame(doneFrame)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 1, offset: 50),
                       "the last file's DONE lands on its exact end, not past the manifest")
    }

    func testFragmentedChunksCountTheirPlaintextExactlyOnce() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        try lane.didProduceFrame(partFrame(C / 2))
        try lane.didProduceFrame(chunkFrame(C / 2))
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: C),
                       "however the transport fragmented it, one logical chunk went out")
    }

    /// Two different frontiers, and confusing them is how a resumed attempt goes
    /// wrong. The ATTEMPT frontier is where this attempt has got to and rewinds
    /// with it; the PRODUCED frontier is the high-water mark of everything ever
    /// handed to an authenticated transport and must never rewind, or a peer
    /// could walk the sender forward past bytes it never sent by asking twice.
    func testTheAttemptFrontierRewindsOnAResumeAndTheProducedFrontierDoesNot() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x56, count: 32))
        try lane.beginOutboundBatch(sizes: [3 * C, 40])
        for _ in 0..<3 { try lane.didProduceFrame(chunkFrame(C)) }
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: 3 * C))
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 3 * C))
        XCTAssertEqual(lane.attemptBytes, 3 * C)

        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = try lane.outboundBatchResume(to: ResumePoint(index: 0, offset: C), sender: sender)
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: C))
        XCTAssertEqual(lane.attemptBytes, C, "the new attempt's cursor starts at the checkpoint")
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 3 * C),
                       "the high-water mark is what bounds the NEXT request")

        try lane.didProduceFrame(chunkFrame(C))
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: 2 * C))
        XCTAssertEqual(lane.attemptBytes, 2 * C)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 3 * C))
    }

    func testTheAttemptCursorCountsAcrossFileBoundaries() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C, 40])
        try lane.didProduceFrame(chunkFrame(C))
        try lane.didProduceFrame(doneFrame)
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 1, offset: 0))
        try lane.didProduceFrame(chunkFrame(40))
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 1, offset: 40))
        XCTAssertEqual(lane.attemptBytes, C + 40, "cumulative over the whole batch, not per file")
    }

    // ── the manifest bounds what may be produced ────────────────────────────

    /// This is called AFTER the frame entered the authenticated channel, so a
    /// frame that overran the file has already spent a nonce the peer counts.
    /// There is no unwinding it: the lane fails closed, and the state it refuses
    /// is left exactly where the last accepted frame put it.
    func testAChunkPastTheDeclaredFileSizeIsTerminalAndMovesNothing() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        try lane.didProduceFrame(chunkFrame(C))
        XCTAssertThrowsError(try lane.didProduceFrame(chunkFrame(1))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch)
        }
        XCTAssertTrue(lane.codecsPoisoned)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: C),
                       "the high-water mark is what bounds the next request; it may not overrun")
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: C))
        XCTAssertEqual(lane.attemptBytes, C, "and the refused frame bought no window credit")
    }

    func testAChunkAfterTheFinalDoneIsTerminal() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [50])
        try lane.didProduceFrame(chunkFrame(50))
        try lane.didProduceFrame(doneFrame)
        XCTAssertThrowsError(try lane.didProduceFrame(chunkFrame(1))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch)
        }
        XCTAssertTrue(lane.codecsPoisoned)
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 50),
                       "no file is live past the manifest, so nothing could advance")
        XCTAssertEqual(lane.attemptBytes, 50)
    }

    func testADoneBeforeTheDeclaredBytesWereProducedIsTerminal() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [2 * C, 40])
        try lane.didProduceFrame(chunkFrame(C))
        XCTAssertThrowsError(try lane.didProduceFrame(doneFrame)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch)
        }
        XCTAssertTrue(lane.codecsPoisoned)
        XCTAssertEqual(lane.attemptFrontier, ResumePoint(index: 0, offset: C),
                       "the file did not close, so the cursor did not move to the next one")
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: C))
    }

    func testADoneAfterTheLastFileIsTerminal() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [10])
        try lane.didProduceFrame(chunkFrame(10))
        try lane.didProduceFrame(doneFrame)
        XCTAssertThrowsError(try lane.didProduceFrame(doneFrame)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch)
        }
        XCTAssertTrue(lane.codecsPoisoned, "a frame past the manifest already spent a nonce")
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 10))
    }

    /// The producing half of the replayed final DONE: the batch closed out, the
    /// COMPLETE was lost with the transport, and the peer's request names the last
    /// file's exact end. Rebasing there must leave the length rule satisfied
    /// IMMEDIATELY, or the one frame the replay exists to deliver is refused by
    /// its own sender.
    func testAResumeToAFilesExactEndCanReplayThatFilesDone() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x59, count: 32))
        try lane.beginOutboundBatch(sizes: [50])
        try lane.didProduceFrame(chunkFrame(50))
        try lane.didProduceFrame(doneFrame)

        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        let end = ResumePoint(index: 0, offset: 50)
        XCTAssertTrue(lane.validResumeRequest(end))
        _ = try lane.outboundBatchResume(to: end, sender: sender)

        XCTAssertNoThrow(try lane.didProduceFrame(doneFrame), "the replay is the whole point")
        XCTAssertEqual(lane.producedFrontier, end, "and it lands where it already was")
        XCTAssertFalse(lane.codecsPoisoned)
    }

    /// A chunk frame with no plaintext under its AEAD tag is not a short chunk —
    /// no conforming producer emits one. Counting it would claim a chunk went out
    /// while the cursor stood still, and the peer's ACK would never agree.
    func testAChunkFrameCarryingNoPlaintextIsTerminal() throws {
        for frame in [[RealtimeKind.chunk, 0, 0, 0, 0],
                      realtimeFrame(kind: RealtimeKind.chunkPart, seq: 0,
                                    payload: [UInt8](repeating: 0, count: 16))] {
            let lane = LinkFileLane()
            try lane.beginOutboundBatch(sizes: [C])
            XCTAssertThrowsError(try lane.didProduceFrame(frame)) {
                XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch, "\(frame.count) bytes")
            }
            XCTAssertTrue(lane.codecsPoisoned)
            XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 0))
            XCTAssertEqual(lane.attemptBytes, 0)
        }
    }

    func testResumeRequestValidationIsRangeAlignmentAndFrontierTogether() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [2 * C, 50])
        try lane.didProduceFrame(chunkFrame(C))   // produced {0, C}

        XCTAssertTrue(lane.validResumeRequest(ResumePoint(index: 0, offset: 0)))
        XCTAssertTrue(lane.validResumeRequest(ResumePoint(index: 0, offset: C)))
        // Past the frontier: only a forged or corrupted request can name it, and
        // honouring it would make the sender skip source bytes it never sent.
        XCTAssertFalse(lane.validResumeRequest(ResumePoint(index: 0, offset: 2 * C)))
        XCTAssertFalse(lane.validResumeRequest(ResumePoint(index: 1, offset: 0)))
        // Off the fixed grid: the chain hash is not defined there.
        XCTAssertFalse(lane.validResumeRequest(ResumePoint(index: 0, offset: 4096)))
        // Outside the manifest entirely.
        XCTAssertFalse(lane.validResumeRequest(ResumePoint(index: 2, offset: 0)))
        XCTAssertFalse(lane.validResumeRequest(ResumePoint(index: -1, offset: 0)))
        XCTAssertFalse(lane.validResumeRequest(ResumePoint(index: 0, offset: -1)))
    }

    func testAnExactFileEndIsAValidRequestOnceThatFileIsProduced() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [50, C])
        try lane.didProduceFrame(chunkFrame(50))
        try lane.didProduceFrame(doneFrame)
        XCTAssertTrue(lane.validResumeRequest(ResumePoint(index: 0, offset: 50)),
                      "the exact end of a file is on the chain's boundary set")
        XCTAssertTrue(lane.validResumeRequest(ResumePoint(index: 1, offset: 0)))
    }

    func testAResumeToAnUnvalidatedPointIsRefusedBeforeAnyMarkerIsBuilt() throws {
        let lane = LinkFileLane()
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x54, count: 32))
        try lane.beginOutboundBatch(sizes: [2 * C])
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertThrowsError(try lane.outboundBatchResume(to: ResumePoint(index: 0, offset: 2 * C),
                                                          sender: sender)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .resumePointRejected)
        }
        XCTAssertTrue(lane.outboundOwesResumeMarker, "the debt is unspent: nothing was announced")
        XCTAssertFalse(lane.codecsPoisoned, "a forged request is not proof the codecs are unusable")
    }

    // ── the durable checkpoint ──────────────────────────────────────────────

    func testTheCheckpointAdvancesOnlyThroughAnExplicitPersist() throws {
        let lane = LinkFileLane(ackInterval: 1)
        try lane.beginInboundBatch(sizes: [2 * C])
        XCTAssertEqual(lane.durableCheckpoint, LinkFileCheckpoint(index: 0, offset: 0, chain: zeroChain))

        let pending = try lane.didAdmitChunk(byteCount: C, chain: chain(0xaa))
        XCTAssertEqual(pending, LinkFileCheckpoint(index: 0, offset: C, chain: chain(0xaa)))
        XCTAssertEqual(lane.durableCheckpoint, LinkFileCheckpoint(index: 0, offset: 0, chain: zeroChain),
                       "authenticated is not durable")

        XCTAssertEqual(lane.didPersist(pending), .committed(ack: C))
        XCTAssertEqual(lane.durableCheckpoint, pending)
    }

    func testASecondAdmitBeforeItsPersistIsRefused() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [2 * C])
        _ = try lane.didAdmitChunk(byteCount: C, chain: chain(1))
        XCTAssertThrowsError(try lane.didAdmitChunk(byteCount: C, chain: chain(2))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .persistAlreadyPending)
        }
    }

    func testAdmittingPastTheDeclaredSizeIsRefused() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertThrowsError(try lane.didAdmitChunk(byteCount: C + 1, chain: chain(1))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch)
        }
    }

    func testAChainThatIsNotASha256StateIsRefused() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertThrowsError(try lane.didAdmitChunk(byteCount: C, chain: [1, 2, 3])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .invalidChain)
        }
    }

    /// A write already authenticated by the OLD generation is durable and was
    /// admitted in the old FIFO chain, so it commits — that is what makes the
    /// replacement's request name the exact durable prefix rather than a
    /// speculative one. Everything after it is stale.
    func testTheOneAdmittedChunkCommitsAcrossAGapAndLaterStaleWorkDoesNot() throws {
        let lane = LinkFileLane(ackInterval: 1)
        try lane.beginInboundBatch(sizes: [2 * C])
        let pending = try lane.didAdmitChunk(byteCount: C, chain: chain(0xbb))
        _ = lane.transportGap()

        XCTAssertEqual(lane.didPersist(pending), .committed(ack: C),
                       "the write crossed the replacement and is still durable")
        XCTAssertEqual(lane.durableCheckpoint, pending)

        XCTAssertEqual(lane.didPersist(pending), .rejectedStale, "it committed once")
        XCTAssertEqual(lane.didPersist(LinkFileCheckpoint(index: 0, offset: 2 * C, chain: chain(0xcc))),
                       .rejectedStale, "no admission ever named this point")
        XCTAssertEqual(lane.durableCheckpoint, pending)
    }

    func testAPersistThatDoesNotMatchTheAdmissionCommitsNothing() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [2 * C])
        let pending = try lane.didAdmitChunk(byteCount: C, chain: chain(0xdd))
        XCTAssertEqual(lane.didPersist(LinkFileCheckpoint(index: 0, offset: C, chain: chain(0xee))),
                       .rejectedStale, "a different chain is a different checkpoint")
        XCTAssertEqual(lane.durableCheckpoint.offset, 0)
        XCTAssertEqual(lane.didPersist(pending), .committed(ack: nil))
    }

    // ── file boundaries ─────────────────────────────────────────────────────

    func testAMultiFileBatchCheckpointsAtEachFilesZeroOffset() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C, 50])
        let first = try lane.didAdmitChunk(byteCount: C, chain: chain(1))
        _ = lane.didPersist(first)
        XCTAssertEqual(try lane.didAdmitDone(),
                       .nextFile(LinkFileCheckpoint(index: 1, offset: 0, chain: zeroChain)))
        XCTAssertEqual(lane.didPersist(LinkFileCheckpoint(index: 1, offset: 0, chain: zeroChain)),
                       .committed(ack: nil))
        XCTAssertEqual(lane.durableCheckpoint, LinkFileCheckpoint(index: 1, offset: 0, chain: zeroChain))

        let second = try lane.didAdmitChunk(byteCount: 50, chain: chain(2))
        _ = lane.didPersist(second)
        XCTAssertEqual(try lane.didAdmitDone(), .batchComplete)
        XCTAssertEqual(lane.durableCheckpoint, second,
                       "the last DONE leaves the checkpoint on the exact end, ready for a replay")
        XCTAssertTrue(lane.inboundBatchComplete)
    }

    func testAnEmptyFileNeedsNoChunkAndKeepsTheBoundaryValid() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [10, 0, 20])
        let a = try lane.didAdmitChunk(byteCount: 10, chain: chain(1))
        _ = lane.didPersist(a)
        XCTAssertEqual(try lane.didAdmitDone(),
                       .nextFile(LinkFileCheckpoint(index: 1, offset: 0, chain: zeroChain)))
        _ = lane.didPersist(LinkFileCheckpoint(index: 1, offset: 0, chain: zeroChain))
        XCTAssertEqual(try lane.didAdmitDone(),
                       .nextFile(LinkFileCheckpoint(index: 2, offset: 0, chain: zeroChain)),
                       "a zero-byte file closes out on its DONE alone")
        _ = lane.didPersist(LinkFileCheckpoint(index: 2, offset: 0, chain: zeroChain))
        let c = try lane.didAdmitChunk(byteCount: 20, chain: chain(3))
        _ = lane.didPersist(c)
        XCTAssertEqual(try lane.didAdmitDone(), .batchComplete)
    }

    func testABatchOfOneEmptyFileCompletesAtTheOrigin() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [0])
        XCTAssertEqual(try lane.didAdmitDone(), .batchComplete)
        XCTAssertEqual(lane.durableCheckpoint, LinkFileCheckpoint(index: 0, offset: 0, chain: zeroChain))
        XCTAssertTrue(resumePointInRange(lane.durableCheckpoint.point, [0]))
        XCTAssertTrue(resumePointAligned(lane.durableCheckpoint.point, [0]))
    }

    func testADoneBeforeAFilesDeclaredBytesArrivedIsRefused() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertThrowsError(try lane.didAdmitDone()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .lengthMismatch)
        }
    }

    // ── the replayed final DONE ─────────────────────────────────────────────

    /// The batch verified, the destination was finalised, and the COMPLETE was
    /// lost with the transport. The lane must let the owner answer the sender's
    /// replay from the exact end WITHOUT finalising a second time.
    func testAFinalisedBatchCanReplayItsDoneWithoutFinalisingTwice() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [50])
        let end = try lane.didAdmitChunk(byteCount: 50, chain: chain(0x7f))
        _ = lane.didPersist(end)
        XCTAssertEqual(try lane.didAdmitDone(), .batchComplete)
        XCTAssertTrue(lane.didFinalizeDestination(), "the first finalisation is the real one")
        XCTAssertFalse(lane.didFinalizeDestination(), "and it is one-shot")

        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertEqual(lane.durableCheckpoint, end)
        XCTAssertEqual(try lane.resumeRequestFrame(), resumeReqFrame(index: 0, offset: 50))
        XCTAssertTrue(lane.inboundBatchComplete,
                      "the owner must know this resume replays a DONE, not the file")
        XCTAssertFalse(lane.didFinalizeDestination(), "a replay must not finalise again")
    }

    // ── the inbound barrier ─────────────────────────────────────────────────

    func testProtectedInputBeforeTheMarkerIsTerminal() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [C])
        _ = lane.transportGap()
        XCTAssertEqual(lane.admitInboundFrame(chunkFrame(C)),
                       .failClosed(.protectedBeforeRealignment))
        XCTAssertTrue(lane.codecsPoisoned)
    }

    /// Controls, ACKs and the resume REQUEST are plaintext and consume no nonce,
    /// so they are exactly what must keep flowing during a realignment — the
    /// request is the frame the realignment is waiting for.
    func testPlaintextControlStillRoutesDuringARealignment() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()
        XCTAssertEqual(lane.admitInboundFrame([LINK_FILE_BATCH_ABORT]), .control(.batchAbort))
        XCTAssertEqual(lane.admitInboundFrame(ackFrame(64)), .ack(total: 64))
        XCTAssertEqual(lane.admitInboundFrame(resumeReqFrame(index: 0, offset: C)),
                       .resumeRequest(ResumePoint(index: 0, offset: C)))
        XCTAssertFalse(lane.codecsPoisoned)
    }

    func testAMalformedResumeRequestFailsTheLaneClosed() {
        let lane = LinkFileLane()
        let malformed = realtimeFrame(kind: RealtimeKind.resumeReq, seq: 0, payload: Array("nope".utf8))
        XCTAssertEqual(lane.admitInboundFrame(malformed), .failClosed(.malformedControl))
        XCTAssertTrue(lane.codecsPoisoned)
    }

    func testAnUnroutableFrameFailsTheLaneClosedRatherThanBeingSkipped() {
        let lane = LinkFileLane()
        XCTAssertEqual(lane.admitInboundFrame([RealtimeKind.text, 0, 0, 0, 0]),
                       .failClosed(.unroutableFrame))
        XCTAssertTrue(lane.codecsPoisoned)
    }

    /// A forged ACK value is ignored, never fatal: one plaintext frame a relay
    /// can inject must not be able to end a working lane.
    func testAnUnusableAckValueIsIgnoredRatherThanFatal() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        XCTAssertEqual(lane.admitInboundFrame(ackFrame(.nan)), .ack(total: nil))
        XCTAssertEqual(lane.admitInboundFrame(ackFrame(-1)), .ack(total: nil))
        XCTAssertFalse(lane.codecsPoisoned)
    }

    func testAPoisonedLaneRoutesNothingFurther() throws {
        let lane = LinkFileLane()
        _ = lane.admitInboundFrame([RealtimeKind.text, 0, 0, 0, 0])
        XCTAssertEqual(lane.admitInboundFrame([RealtimeControl.accept.rawValue]),
                       .failClosed(.laneFailed))
        XCTAssertFalse(lane.maySendProtected)
        XCTAssertThrowsError(try lane.beginOutboundBatch(sizes: [1])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .laneFailed)
        }
    }

    // ── accepting the peer's marker ─────────────────────────────────────────

    func testAcceptingTheMarkerRequiresAnExactMatchWithTheDurablePoint() throws {
        let lane = LinkFileLane()
        let (sender, receiver) = try aligned()
        try lane.beginInboundBatch(sizes: [2 * C])
        let point = try lane.didAdmitChunk(byteCount: C, chain: chain(0x3c))
        _ = lane.didPersist(point)
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = try lane.resumeRequestFrame()

        for wrong in [ResumePoint(index: 0, offset: 0),
                      ResumePoint(index: 0, offset: 2 * C),
                      ResumePoint(index: 1, offset: 0)] {
            let fresh = LinkFileLane()
            try fresh.beginInboundBatch(sizes: [2 * C])
            let p = try fresh.didAdmitChunk(byteCount: C, chain: chain(0x3c))
            _ = fresh.didPersist(p)
            _ = fresh.transportGap()
            fresh.didAttachReplacementTransport()
            _ = try fresh.resumeRequestFrame()
            XCTAssertThrowsError(try fresh.acceptResumeStart(wrong, seq: sender.nextSequence,
                                                             receiver: receiver)) {
                XCTAssertEqual($0 as? LinkFileLaneError, .resumeMarkerMismatch)
            }
            XCTAssertTrue(fresh.codecsPoisoned)
        }

        XCTAssertNoThrow(try lane.acceptResumeStart(ResumePoint(index: 0, offset: C),
                                                    seq: receiverAlignedSequence(sender),
                                                    receiver: receiver))
        XCTAssertFalse(lane.inboundRequiresResumeMarker)
    }

    func testABackwardsMarkerIsRefusedByTheRealReceiverAndIsTerminal() throws {
        let lane = LinkFileLane()
        let (sender, receiver) = try aligned()
        try lane.beginInboundBatch(sizes: [2 * C])
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = try lane.resumeRequestFrame()
        let live = sender.nextSequence
        XCTAssertGreaterThan(live, 1)
        XCTAssertThrowsError(try lane.acceptResumeStart(ResumePoint(index: 0, offset: 0),
                                                        seq: live - 1, receiver: receiver)) {
            XCTAssertEqual($0 as? RealtimeError, .outOfOrder)
        }
        XCTAssertTrue(lane.codecsPoisoned)
    }

    func testAnIdleDirectionAcceptsOnlyTheOriginMarker() throws {
        let (sender, receiver) = try aligned()
        receiver.abortBatch()
        let lane = LinkFileLane()
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertThrowsError(try lane.acceptResumeStart(ResumePoint(index: 0, offset: 1),
                                                        seq: sender.nextSequence, receiver: receiver)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .resumeMarkerMismatch)
        }

        let fresh = LinkFileLane()
        _ = fresh.transportGap()
        fresh.didAttachReplacementTransport()
        XCTAssertNoThrow(try fresh.acceptResumeStart(ResumePoint(index: 0, offset: 0),
                                                     seq: sender.nextSequence, receiver: receiver))
        XCTAssertFalse(fresh.inboundRequiresResumeMarker)
    }

    /// The announcement is plaintext and a signalling relay can inject one. Its
    /// `seq` becomes the receive nonce counter's new starting point, so a
    /// malformed value is not "an odd frame" — it is a number that would make
    /// every later comparison false and stall the direction for good.
    func testAMalformedResumeMarkerFailsTheLaneClosed() {
        for bad in [#"{"index":0,"offset":0}"#,          // no seq
                    #"{"index":0,"seq":1}"#,             // no offset
                    #"{"index":-1,"offset":0,"seq":1}"#,
                    #"{"index":0,"offset":0.5,"seq":1}"#,
                    #"{"index":0,"offset":0,"seq":-1}"#,
                    #"{"index":0,"offset":0,"seq":4294967296}"#,   // past UInt32
                    #"{"index":true,"offset":0,"seq":1}"#,
                    "not json", ""] {
            let lane = LinkFileLane()
            _ = lane.transportGap()
            lane.didAttachReplacementTransport()
            let frame = realtimeFrame(kind: RealtimeKind.resumeStart, seq: 0, payload: Array(bad.utf8))
            XCTAssertEqual(lane.admitInboundFrame(frame), .failClosed(.malformedControl), bad)
            XCTAssertTrue(lane.codecsPoisoned, bad)
        }
    }

    /// The request names the durable prefix, so it is only sent once the admitted
    /// FIFO has settled. A marker arriving with a write still outstanding means
    /// the announced point cannot be proven to match what is on disk.
    func testAMarkerWhileAWriteIsStillOutstandingIsTerminal() throws {
        let lane = LinkFileLane()
        let (sender, receiver) = try aligned()
        try lane.beginInboundBatch(sizes: [2 * C])
        _ = try lane.didAdmitChunk(byteCount: C, chain: chain(0x5a))
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        XCTAssertThrowsError(try lane.acceptResumeStart(ResumePoint(index: 0, offset: 0),
                                                        seq: sender.nextSequence, receiver: receiver)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .persistAlreadyPending)
        }
        XCTAssertTrue(lane.codecsPoisoned)
    }

    // ── batch retirement keeps the lane reusable ────────────────────────────

    /// The lane outlives its batches — that is the whole reason it exists. An
    /// ordered BATCH_ABORT or a finished batch retires only that batch, and never
    /// the generation state the codecs depend on.
    func testRetiringABatchKeepsTheGenerationStateIntact() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        try lane.didProduceFrame(chunkFrame(C))
        _ = lane.transportGap()
        lane.retireOutboundBatch()
        XCTAssertEqual(lane.producedFrontier, ResumePoint(index: 0, offset: 0))
        XCTAssertTrue(lane.outboundOwesResumeMarker, "a retired batch does not pay the generation's debt")
        XCTAssertEqual(lane.generation, 1)

        try lane.beginInboundBatch(sizes: [50])
        let point = try lane.didAdmitChunk(byteCount: 50, chain: chain(3))
        _ = lane.didPersist(point)
        lane.retireInboundBatch()
        XCTAssertEqual(lane.durableCheckpoint, LinkFileCheckpoint(index: 0, offset: 0, chain: zeroChain))
        XCTAssertFalse(lane.inboundBatchComplete)
        XCTAssertNoThrow(try lane.beginInboundBatch(sizes: [C]))
    }

    func testASecondConcurrentBatchInOneDirectionIsRefused() throws {
        let lane = LinkFileLane()
        try lane.beginOutboundBatch(sizes: [C])
        XCTAssertThrowsError(try lane.beginOutboundBatch(sizes: [C])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .batchAlreadyActive)
        }
        try lane.beginInboundBatch(sizes: [C])
        XCTAssertThrowsError(try lane.beginInboundBatch(sizes: [C])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .batchAlreadyActive)
        }
    }

    func testAManifestThatCannotBeCountedIsRefused() throws {
        let lane = LinkFileLane()
        for bad in [[Int](), [-1], [Int.max, Int.max], [9_007_199_254_740_992]] {
            XCTAssertThrowsError(try lane.beginOutboundBatch(sizes: bad)) {
                XCTAssertEqual($0 as? LinkFileLaneError, .invalidManifest, "\(bad)")
            }
        }
        XCTAssertFalse(lane.codecsPoisoned, "a refused manifest is not a codec failure")
    }

    // ── flow control rebase ─────────────────────────────────────────────────

    func testResumeRebasesBothCursorsToTheDurableBatchOffset() throws {
        let lane = LinkFileLane(window: 100, ackInterval: 100)
        let sender = RealtimeSender(sessionKey: [UInt8](repeating: 0x55, count: 32))
        try lane.beginOutboundBatch(sizes: [C, C])
        try lane.didProduceFrame(chunkFrame(C))
        try lane.didProduceFrame(doneFrame)
        XCTAssertFalse(lane.maySendProtected, "one chunk is far past a 100-byte window")

        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = try lane.outboundBatchResume(to: ResumePoint(index: 1, offset: 0), sender: sender)
        XCTAssertTrue(lane.maySendProtected, "a replacement attempt opens one whole window")

        // The ACK is cumulative and batch-local, so the pre-rebase totals a
        // delayed frame would replay buy nothing.
        XCTAssertEqual(lane.admitInboundFrame(ackFrame(Double(C - 1))), .ack(total: C - 1))
        try lane.didProduceFrame(chunkFrame(101))
        XCTAssertFalse(lane.maySendProtected, "a stale ACK below the base granted no credit")
        XCTAssertEqual(lane.admitInboundFrame(ackFrame(Double(C + 101))), .ack(total: C + 101))
        XCTAssertTrue(lane.maySendProtected)
    }

    /// Without the rebase the receiver's first resumed ACK is measured from a
    /// mark the sender no longer shares, so it fires an interval early — against
    /// a window that has just been reset to the checkpoint.
    func testTheReceiversAckIntervalRestartsAtTheCheckpoint() throws {
        let lane = LinkFileLane(ackInterval: 2 * C)
        let (sender, receiver) = try aligned()
        try lane.beginInboundBatch(sizes: [3 * C])
        let point = try lane.didAdmitChunk(byteCount: C, chain: chain(0x21))
        XCTAssertEqual(lane.didPersist(point), .committed(ack: nil), "one chunk is half an interval")

        _ = lane.transportGap()
        lane.didAttachReplacementTransport()
        _ = try lane.resumeRequestFrame()
        try lane.acceptResumeStart(point.point, seq: receiverAlignedSequence(sender), receiver: receiver)

        let second = try lane.didAdmitChunk(byteCount: C, chain: chain(0x22))
        XCTAssertEqual(lane.didPersist(second), .committed(ack: nil),
                       "measured from the checkpoint, this is the FIRST chunk of the interval")
        let third = try lane.didAdmitChunk(byteCount: C, chain: chain(0x23))
        XCTAssertEqual(lane.didPersist(third), .committed(ack: 3 * C))
    }

    /// Every durable checkpoint is a fixed-grid boundary or an exact file end,
    /// because that is the boundary set the chain hash is defined on — and the
    /// set the sender will validate the resulting RESUME_REQ against.
    func testACheckpointOffTheFixedGridIsRefused() throws {
        let lane = LinkFileLane()
        try lane.beginInboundBatch(sizes: [3 * C])
        XCTAssertThrowsError(try lane.didAdmitChunk(byteCount: 4096, chain: chain(1))) {
            XCTAssertEqual($0 as? LinkFileLaneError, .unalignedCheckpoint)
        }
        // The exact end of a file is on that boundary set even when it is not a
        // multiple of CHUNK_SIZE.
        let short = LinkFileLane()
        try short.beginInboundBatch(sizes: [50])
        XCTAssertNoThrow(try short.didAdmitChunk(byteCount: 50, chain: chain(1)))
    }

    // ── independence ────────────────────────────────────────────────────────

    /// A file-lane failure is a FILE-lane failure. The text conversation, its
    /// codecs and the link's own recovery decision are all untouched.
    func testAFileLaneFailureLeavesTheTextLaneAlone() throws {
        let text = LinkTextLane(role: .initiator, now: { 0 })
        _ = text.localOpen()
        _ = text.inboundControl(.accept)
        XCTAssertEqual(text.status, .open)

        let file = LinkFileLane()
        _ = file.admitInboundFrame([RealtimeKind.text, 0, 0, 0, 0])
        XCTAssertTrue(file.codecsPoisoned)

        XCTAssertEqual(text.status, .open, "the text conversation survives a file protocol failure")
        XCTAssertFalse(text.codecsPoisoned)
        XCTAssertTrue(text.maySendProtected)
    }

    func testBothNativeSupportConstantsStayFalse() {
        XCTAssertFalse(LINK_BUILD_SUPPORT, "no peer may be told this build speaks link/1")
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }

    // ── nonce continuity end to end ─────────────────────────────────────────

    /// The whole point of the barrier: a batch interrupted mid-flight and resumed
    /// on a replacement transport never reuses a nonce, and the receiver
    /// reassembles the exact bytes.
    ///
    /// The sequence is deliberately NOT dense across the gap. Frames the old
    /// generation sealed but never delivered burned their nonces permanently —
    /// reclaiming one is exactly how a nonce gets used twice — so the marker's
    /// job is to carry the peer FORWARD over that hole, not to close it.
    func testAResumedBatchKeepsOneForwardOnlyNonceSequence() throws {
        let key = [UInt8](repeating: 0x61, count: 32)
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let lane = LinkFileLane(ackInterval: 1)

        let body = WireVectors.content(3 * C, seed: 41)
        let meta = FileMeta(name: "big.bin", size: body.count)
        var seqs: [UInt32] = []
        var got: [UInt8] = []

        try lane.beginOutboundBatch(sizes: [body.count])
        try lane.beginInboundBatch(sizes: [body.count])
        for frame in try sender.batchFrames([meta]) {
            try lane.didProduceFrame(frame)
            seqs.append(seqOf(frame))
            _ = try receiver.feed(frame)
        }

        // Two logical chunks land and are made durable; the third is lost.
        let frames = try sender.dataFrames([(meta, body)])
        for frame in frames.prefix(2) {
            try lane.didProduceFrame(frame)
            seqs.append(seqOf(frame))
            XCTAssertEqual(lane.admitInboundFrame(frame), .feedProtected)
            guard case let .chunk(plain) = try receiver.feed(frame) else { return XCTFail("chunk") }
            got += plain
            let point = try lane.didAdmitChunk(byteCount: plain.count, chain: receiver.snapshotChain())
            XCTAssertEqual(lane.didPersist(point), .committed(ack: got.count))
        }

        // The gap. Both directions owe exactly one realignment.
        _ = lane.transportGap()
        lane.didAttachReplacementTransport()

        let request = try lane.resumeRequestFrame()
        XCTAssertEqual(parseResumeReq(request), ResumePoint(index: 0, offset: 2 * C))
        guard case let .resumeRequest(point) = lane.admitInboundFrame(request) else {
            return XCTFail("the request must route as one")
        }
        XCTAssertTrue(lane.validResumeRequest(point))
        // Two frames were sealed and lost with the transport. Their nonces are
        // spent, and the announcement is what carries the peer over them.
        let burned = sender.nextSequence
        XCTAssertGreaterThan(burned, seqs.last! + 1)
        let marker = try lane.outboundBatchResume(to: point, sender: sender)
        guard case let .resumeMarker(announced, seq) = lane.admitInboundFrame(marker) else {
            return XCTFail("the marker must route as one")
        }
        XCTAssertEqual(seq, burned, "the announced seq is the one the next frame will carry")
        try lane.acceptResumeStart(announced, seq: seq, receiver: receiver)

        for frame in try sender.dataFrames([(meta, body)], resume: point) {
            try lane.didProduceFrame(frame)
            seqs.append(seqOf(frame))
            XCTAssertEqual(lane.admitInboundFrame(frame), .feedProtected)
            switch try receiver.feed(frame) {
            case let .chunk(plain):
                got += plain
                let p = try lane.didAdmitChunk(byteCount: plain.count, chain: receiver.snapshotChain())
                _ = lane.didPersist(p)
            case let .done(ok):
                XCTAssertTrue(ok, "the chain must line up across the resume")
                XCTAssertEqual(try lane.didAdmitDone(), .batchComplete)
            default: XCTFail("unexpected event")
            }
        }

        XCTAssertEqual(got, body, "byte-exact across a replaced transport")
        XCTAssertEqual(seqs, seqs.sorted(), "the nonce sequence only ever moves forward")
        XCTAssertEqual(Set(seqs).count, seqs.count, "no nonce is reused under the session key")
        XCTAssertFalse(lane.codecsPoisoned)
        XCTAssertTrue(lane.inboundBatchComplete)
    }

    /// The same handshake, adversarially ordered: every step of it is attempted
    /// while the lane is still in the gap. None of them may move a cursor, pay a
    /// debt or spend an acceptance — and none of them is a failure, because the
    /// replacement that has not arrived yet is exactly what repairs a gap.
    ///
    /// Only once the replacement is attached does REQUEST -> ANNOUNCEMENT -> data
    /// run, on the same codecs, with one forward-only nonce sequence.
    func testTheResumeHandshakeCannotHappenBeforeTheReplacementAttaches() throws {
        let key = [UInt8](repeating: 0x62, count: 32)
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let lane = LinkFileLane(ackInterval: 1)

        let body = WireVectors.content(2 * C, seed: 43)
        let meta = FileMeta(name: "adversarial.bin", size: body.count)
        var got: [UInt8] = []

        try lane.beginOutboundBatch(sizes: [body.count])
        try lane.beginInboundBatch(sizes: [body.count])
        for frame in try sender.batchFrames([meta]) {
            try lane.didProduceFrame(frame)
            _ = try receiver.feed(frame)
        }
        let frames = try sender.dataFrames([(meta, body)])
        try lane.didProduceFrame(frames[0])
        XCTAssertEqual(lane.admitInboundFrame(frames[0]), .feedProtected)
        guard case let .chunk(plain) = try receiver.feed(frames[0]) else { return XCTFail("chunk") }
        got += plain
        let durable = try lane.didAdmitChunk(byteCount: plain.count, chain: receiver.snapshotChain())
        XCTAssertEqual(lane.didPersist(durable), .committed(ack: got.count))

        // The transport dies. Every part of the handshake is refused, and every
        // refusal is the gap rather than a failure.
        XCTAssertTrue(lane.transportGap().needsRecovery)
        XCTAssertThrowsError(try lane.resumeRequestFrame()) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertThrowsError(try lane.outboundBatchResume(to: durable.point, sender: sender)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertThrowsError(try lane.acceptResumeStart(durable.point, seq: sender.nextSequence,
                                                        receiver: receiver)) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertThrowsError(try lane.didProduceFrame(frames[1])) {
            XCTAssertEqual($0 as? LinkFileLaneError, .transportGap)
        }
        XCTAssertFalse(lane.codecsPoisoned, "none of it is proof the codecs are unusable")
        XCTAssertTrue(lane.outboundOwesResumeMarker, "both debts survive every refusal")
        XCTAssertTrue(lane.inboundRequiresResumeMarker)
        XCTAssertEqual(lane.generation, 1, "one era, however many calls it refused")
        XCTAssertEqual(lane.attemptFrontier, durable.point, "and no cursor moved")
        XCTAssertEqual(lane.attemptBytes, C)

        // The replacement attaches. Now, and only now, the handshake runs.
        lane.didAttachReplacementTransport()
        let request = try lane.resumeRequestFrame()
        guard case let .resumeRequest(point) = lane.admitInboundFrame(request) else {
            return XCTFail("the request must route as one")
        }
        XCTAssertEqual(point, durable.point)
        XCTAssertTrue(lane.validResumeRequest(point))
        let marker = try lane.outboundBatchResume(to: point, sender: sender)
        guard case let .resumeMarker(announced, seq) = lane.admitInboundFrame(marker) else {
            return XCTFail("the marker must route as one")
        }
        try lane.acceptResumeStart(announced, seq: seq, receiver: receiver)

        var seqs: [UInt32] = []
        for frame in try sender.dataFrames([(meta, body)], resume: point) {
            try lane.didProduceFrame(frame)
            seqs.append(seqOf(frame))
            XCTAssertEqual(lane.admitInboundFrame(frame), .feedProtected)
            switch try receiver.feed(frame) {
            case let .chunk(plain):
                got += plain
                let p = try lane.didAdmitChunk(byteCount: plain.count, chain: receiver.snapshotChain())
                _ = lane.didPersist(p)
            case let .done(ok):
                XCTAssertTrue(ok, "the chain must line up across the resume")
                XCTAssertEqual(try lane.didAdmitDone(), .batchComplete)
            default: XCTFail("unexpected event")
            }
        }
        XCTAssertEqual(got, body, "byte-exact once the handshake ran in its real order")
        XCTAssertGreaterThanOrEqual(seqs.first ?? 0, seq, "nothing reclaimed a burned nonce")
        XCTAssertEqual(seqs, seqs.sorted())
        XCTAssertEqual(Set(seqs).count, seqs.count)
        XCTAssertFalse(lane.codecsPoisoned)
        XCTAssertTrue(lane.inboundBatchComplete)
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /// A real sender/receiver pair that has already carried one whole batch, so
    /// both counters agree at a value well past zero — which is what makes a
    /// BACKWARDS announcement expressible at all.
    private func aligned() throws -> (RealtimeSender, RealtimeReceiver) {
        let key = [UInt8](repeating: 0x71, count: 32)
        let sender = RealtimeSender(sessionKey: key)
        let receiver = RealtimeReceiver(sessionKey: key)
        let body = WireVectors.content(2 * C, seed: 42)
        let meta = FileMeta(name: "a.bin", size: body.count)
        for frame in try sender.batchFrames([meta]) { _ = try receiver.feed(frame) }
        for frame in try sender.dataFrames([(meta, body)]) { _ = try receiver.feed(frame) }
        return (sender, receiver)
    }

    /// The sequence a conforming sender would announce next. Named rather than
    /// inlined so the assertions read as the protocol rule they are.
    private func receiverAlignedSequence(_ sender: RealtimeSender) -> UInt32 { sender.nextSequence }
}
