import XCTest
@testable import RelayiumKit

/// The reusable file-session owner above `LinkFileLane`: one outbound batch plus
/// a bounded queue, one inbound batch, and the exact orderings that make a
/// long-lived lane safe.
///
/// Pure and synchronous by design, exactly like the lane below it. Every external
/// action is an effect, and every asynchronous result comes back carrying the
/// identifiers of the work it belongs to — batch, attempt, direction — so the
/// orderings and the stale callbacks a real driver could get wrong are all
/// expressible here. Pinned against `web/src/lib/mixed-file-session.svelte.ts`.
final class LinkFileSessionTests: XCTestCase {

    private let C = CHUNK_SIZE

    /// A session and the peer that talks to it: the peer seals with this session's
    /// RECEIVE key, so its frames really do decrypt here.
    ///
    /// The ack interval is 1 so every durable checkpoint produces an observable
    /// ACK; the pacing itself is `AckPacer`'s and is tested there.
    private func pair() -> (session: LinkFileSession, codecs: LinkCodecs, peer: RealtimeSender) {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x11, count: 32),
                                recvKey: [UInt8](repeating: 0x22, count: 32))
        return (LinkFileSession(codecs: codecs, ackInterval: 1),
                codecs,
                RealtimeSender(sessionKey: [UInt8](repeating: 0x22, count: 32)))
    }

    private func meta(_ name: String, _ size: Int) -> FileMeta { FileMeta(name: name, size: size) }

    private func sentFrames(_ effects: [LinkFileSessionEffect]) -> [[UInt8]] {
        effects.compactMap { if case let .sendFrame(f) = $0 { return f } else { return nil } }
    }

    private func controls(_ effects: [LinkFileSessionEffect]) -> [UInt8] {
        sentFrames(effects).filter { $0.count == 1 }.map { $0[0] }
    }

    private func firstPersist(_ effects: [LinkFileSessionEffect]) -> LinkFileCheckpoint? {
        for effect in effects {
            if case let .persistChunk(_, _, checkpoint) = effect { return checkpoint }
        }
        return nil
    }

    private func hasFinalize(_ effects: [LinkFileSessionEffect], _ batch: Int) -> Bool {
        effects.contains(.finalizeDestination(batch: batch))
    }

    /// Consent, open the destination, and hand back everything that reached the
    /// wire — the ordinary way an inbound batch is admitted.
    @discardableResult
    private func consent(_ session: LinkFileSession) throws -> [LinkFileSessionEffect] {
        let id = try XCTUnwrap(session.inboundBatch)
        return session.acceptInbound() + session.didCreateDestination(batch: id)
    }

    /// Admit one frame and report every write it asks for straight back, the way a
    /// serialized receive FIFO does. Returns everything both steps produced.
    @discardableResult
    private func admitAndPersist(_ session: LinkFileSession,
                                 _ frame: [UInt8]) -> [LinkFileSessionEffect] {
        var out = session.admitFrame(frame)
        for effect in out {
            switch effect {
            case let .persistChunk(batch, _, checkpoint):
                out += session.didPersist(batch: batch, checkpoint: checkpoint)
            case let .openFile(batch, _, checkpoint):
                out += session.didPersist(batch: batch, checkpoint: checkpoint)
            case let .finalizeDestination(batch):
                out += session.didFinalizeDestination(batch: batch)
            default:
                continue
            }
        }
        return out
    }

    // ── the queue and its identifiers ───────────────────────────────────────

    func testEnqueueBoundsTheQueueAndRefusesAnUncountableManifest() throws {
        let (session, _, _) = pair()
        XCTAssertThrowsError(try session.enqueue(files: [])) {
            XCTAssertEqual($0 as? LinkFileSessionError, .invalidManifest)
        }
        XCTAssertThrowsError(try session.enqueue(files: [meta("neg", -1)])) {
            XCTAssertEqual($0 as? LinkFileSessionError, .invalidManifest)
        }
        for i in 0..<LINK_FILE_MAX_QUEUED_BATCHES {
            XCTAssertNoThrow(try session.enqueue(files: [meta("q\(i)", 8)]))
        }
        XCTAssertThrowsError(try session.enqueue(files: [meta("over", 8)])) {
            XCTAssertEqual($0 as? LinkFileSessionError, .queueFull,
                           "a peer that never answers must not let a local queue grow for ever")
        }
        XCTAssertEqual(session.queuedBatchIds.count, LINK_FILE_MAX_QUEUED_BATCHES)
    }

    func testEachBatchGetsItsOwnIdAndCancellingOneLeavesTheRest() throws {
        let (session, _, _) = pair()
        let a = try session.enqueue(files: [meta("a", 8)])
        let b = try session.enqueue(files: [meta("b", 8)])
        let c = try session.enqueue(files: [meta("c", 8)])
        XCTAssertEqual(session.queuedBatchIds, [a, b, c])
        XCTAssertEqual(Set([a, b, c]).count, 3, "every batch is distinguishable from every other")
        _ = session.cancelQueued(b)
        XCTAssertEqual(session.queuedBatchIds, [a, c])
    }

    /// Identifiers are what every staleness check in this type rests on, so a
    /// reused one would make all of them silently wrong. Exhaustion is refused
    /// rather than wrapped — and refused rather than trapped, which is what an
    /// unchecked `+= 1` on `Int.max` would do.
    func testIdentifiersAreNeverReusedAndExhaustionIsRefusedNotTrapped() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 1, count: 32),
                                recvKey: [UInt8](repeating: 2, count: 32))
        let session = LinkFileSession(codecs: codecs, firstIdentifier: Int.max)
        XCTAssertThrowsError(try session.enqueue(files: [meta("a", 8)])) {
            XCTAssertEqual($0 as? LinkFileSessionError, .identifiersExhausted)
        }

        // And in the ordinary case they only ever move forward.
        let fresh = LinkFileSession(codecs: LinkCodecs(sendKey: [UInt8](repeating: 3, count: 32),
                                                       recvKey: [UInt8](repeating: 4, count: 32)))
        let first = try fresh.enqueue(files: [meta("a", 8)])
        _ = fresh.pump()
        let attempt = try XCTUnwrap(fresh.outboundAttempt)
        XCTAssertGreaterThan(attempt, first, "the attempt comes from the same counter")
        let second = try fresh.enqueue(files: [meta("b", 8)])
        XCTAssertGreaterThan(second, attempt)
    }

    // ── outbound launch reserves the lane before the manifest ───────────────

    /// The reservation is what makes the manifest legal. Producing it first would
    /// put a nonce-bearing frame on the wire for a batch the lane has never
    /// admitted, and the lane would refuse to count it.
    func testLaunchReservesTheLaneBeforeAnyManifestFrameIsProduced() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", C)])
        let seqBefore = codecs.fileSender.nextSequence

        let effects = session.pump()
        XCTAssertEqual(session.outboundBatch, id)
        XCTAssertEqual(session.outboundPhase, .waitingAccept)
        XCTAssertEqual(session.queuedBatchIds, [], "the head left the queue")

        let frames = sentFrames(effects)
        XCTAssertEqual(frames.first?.first, RealtimeKind.batchEnc,
                       "the link sender's own sealed manifest is the first thing out")
        XCTAssertGreaterThan(codecs.fileSender.nextSequence, seqBefore,
                             "sealed by the ONE link-lifetime sender")
        XCTAssertTrue(effects.contains(.armConsentTimeout(batch: id, direction: .outbound)))
        XCTAssertEqual(session.lane.producedFrontier, ResumePoint(index: 0, offset: 0))
        XCTAssertEqual(session.lane.attemptBytes, 0)
    }

    func testASecondPumpDoesNotLaunchASecondBatchOverTheFirst() throws {
        let (session, _, _) = pair()
        let a = try session.enqueue(files: [meta("a", 8)])
        let b = try session.enqueue(files: [meta("b", 8)])
        _ = session.pump()
        XCTAssertEqual(session.outboundBatch, a)
        XCTAssertEqual(session.pump(), [], "one active outbound batch, ever")
        XCTAssertEqual(session.queuedBatchIds, [b])
    }

    // ── the exact lifecycle bytes ───────────────────────────────────────────

    func testAcceptStartsTheProducerAndCancelsTheConsentWait() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)

        let effects = session.admitFrame([RealtimeControl.accept.rawValue])
        XCTAssertEqual(session.outboundPhase, .sending)
        XCTAssertTrue(effects.contains(.cancelConsentTimeout(batch: id, direction: .outbound)))
        XCTAssertTrue(effects.contains(.startProducer(batch: id, attempt: attempt, resume: nil)))
    }

    func testRejectBeforeConsentRetiresTheBatchAndReleasesTheLane() throws {
        let (session, _, _) = pair()
        let a = try session.enqueue(files: [meta("a", 8)])
        let b = try session.enqueue(files: [meta("b", 8)])
        _ = session.pump()

        let effects = session.admitFrame([RealtimeControl.reject.rawValue])
        XCTAssertTrue(effects.contains(.cancelConsentTimeout(batch: a, direction: .outbound)))
        XCTAssertEqual(controls(effects), [], "nothing was in flight, so no barrier is owed")
        XCTAssertNil(session.outboundPhase, "a refusal is not a lane failure")
        XCTAssertFalse(session.laneFailed)
        XCTAssertFalse(session.pump().isEmpty)
        XCTAssertEqual(session.outboundBatch, b, "the next batch takes the lane")
    }

    /// BUSY is not a refusal: the peer's lane is occupied, and the batch goes back
    /// to the FRONT of the queue because it is older than everything behind it.
    func testBusyRequeuesTheBatchRatherThanFailingIt() throws {
        let (session, _, _) = pair()
        let a = try session.enqueue(files: [meta("a", 8)])
        let b = try session.enqueue(files: [meta("b", 8)])
        _ = session.pump()

        let effects = session.admitFrame([LINK_FILE_BUSY])
        XCTAssertTrue(effects.contains(.cancelConsentTimeout(batch: a, direction: .outbound)))
        XCTAssertNil(session.outboundBatch)
        XCTAssertEqual(session.queuedBatchIds, [a, b], "requeued ahead of the ones behind it")
        XCTAssertFalse(session.laneFailed)
    }

    func testCompleteRetiresOnlyTheBatchAndTheLaneCarriesOn() throws {
        let (session, codecs, _) = pair()
        let body = [UInt8](repeating: 7, count: 50)
        let id = try session.enqueue(files: [meta("a.bin", body.count)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(body))
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextDoneFrame(
                                hash: chainHash([UInt8](repeating: 0, count: 32), body)))
        let finished = session.producerFinished(batch: id, attempt: attempt)
        XCTAssertEqual(session.outboundPhase, .finishing)
        XCTAssertTrue(finished.contains(.armCompleteTimeout(batch: id)))

        let generationBefore = session.generation
        let effects = session.admitFrame([RealtimeControl.complete.rawValue])
        XCTAssertTrue(effects.contains(.cancelCompleteTimeout(batch: id)))
        XCTAssertNil(session.outboundBatch, "the batch retired")
        XCTAssertFalse(session.laneFailed, "and only the batch")
        XCTAssertEqual(session.generation, generationBefore, "a completed batch is not a gap")
        _ = try session.enqueue(files: [meta("next", 4)])
        XCTAssertFalse(session.pump().isEmpty, "the lane carries the next batch")
    }

    /// COMPLETE means "the whole batch arrived and verified". It is meaningless in
    /// any phase but the one waiting for it, and honouring it elsewhere retires a
    /// batch the peer cannot have received.
    func testCompleteIsOnlyLegalWhileFinishing() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", C)])
        _ = session.pump()
        XCTAssertEqual(session.outboundPhase, .waitingAccept)
        _ = session.admitFrame([RealtimeControl.complete.rawValue])
        XCTAssertEqual(session.outboundBatch, id, "a COMPLETE before ACCEPT retires nothing")

        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(
                                [UInt8](repeating: 1, count: 64)))
        XCTAssertEqual(session.outboundPhase, .sending)
        _ = session.admitFrame([RealtimeControl.complete.rawValue])
        XCTAssertEqual(session.outboundBatch, id, "nor one while frames are still going out")
        XCTAssertFalse(session.laneFailed, "a stray plaintext control is not fatal")
    }

    /// The one race the phase rule alone cannot answer: the receiver verifies the
    /// final DONE and answers while this side's producer loop is still unwinding.
    /// The answer is real — only a peer that received everything can produce it —
    /// so it is remembered and acted on the moment the producer ends.
    func testACompleteThatCrossesTheProducersLastFramesStillRetiresTheBatch() throws {
        let (session, codecs, _) = pair()
        let body = [UInt8](repeating: 2, count: 40)
        let id = try session.enqueue(files: [meta("a.bin", body.count)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(body))
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextDoneFrame(
                                hash: chainHash([UInt8](repeating: 0, count: 32), body)))

        // The answer overtakes this side's own producer bookkeeping.
        XCTAssertEqual(session.admitFrame([RealtimeControl.complete.rawValue]), [])
        XCTAssertEqual(session.outboundBatch, id, "not while a frame could still be sealed")

        let finished = session.producerFinished(batch: id, attempt: attempt)
        XCTAssertNil(session.outboundBatch, "and retired the moment the producer ends")
        XCTAssertFalse(finished.contains(.armCompleteTimeout(batch: id)),
                       "no wait is armed for an answer already held")
    }

    /// One deadline, shared by both sides. When this side's wait expires the
    /// sender puts its ordered BATCH_ABORT on the wire and owns the retirement.
    func testAnOutboundConsentTimeoutSendsTheOrderedAbortBarrier() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a", 8)])
        _ = session.pump()
        let effects = session.outboundConsentTimedOut(batch: id)
        XCTAssertEqual(controls(effects), [LINK_FILE_BATCH_ABORT])
        XCTAssertTrue(effects.contains(.cancelConsentTimeout(batch: id, direction: .outbound)))
        XCTAssertNil(session.outboundBatch)
        XCTAssertFalse(session.laneFailed)
    }

    /// A timer belongs to the batch it was armed for. One that fires after its
    /// batch retired is a wake-up nobody is waiting for, and letting it terminate
    /// whatever batch happens to be live now is a stale callback ending real work.
    func testAStaleOutboundConsentTimerDoesNotAbortALaterBatch() throws {
        let (session, _, _) = pair()
        let a = try session.enqueue(files: [meta("a", 8)])
        let b = try session.enqueue(files: [meta("b", 8)])
        _ = session.pump()
        _ = session.admitFrame([RealtimeControl.reject.rawValue])   // A retires
        _ = session.pump()
        XCTAssertEqual(session.outboundBatch, b)

        let stale = session.outboundConsentTimedOut(batch: a)
        XCTAssertEqual(stale, [], "a dead batch's timer answers for nothing")
        XCTAssertEqual(session.outboundBatch, b, "and must not retire the batch that replaced it")
    }

    // ── stopping a live producer is an ordered barrier ──────────────────────

    /// Cancelling a live producer is a barrier, not an instant. The producer may
    /// already have sealed a frame across the cancellation; that frame's nonce is
    /// spent, so it has to reach the wire BEFORE the abort that retires the batch.
    func testCancellingASendingBatchWaitsForProducerQuiescence() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])

        let cancelled = session.cancelOutbound()
        XCTAssertEqual(controls(cancelled), [],
                       "nothing may follow the last produced frame until the producer stops")
        XCTAssertTrue(cancelled.contains(.stopProducer(batch: id, attempt: attempt)))
        XCTAssertEqual(session.outboundPhase, .stopping, "the batch is stopping, not gone")

        // The frame the producer had already sealed when the stop arrived.
        let crossed = try codecs.fileSender.nextChunkFrame([UInt8](repeating: 4, count: 128))
        let emitted = session.produced(batch: id, attempt: attempt, frame: crossed)
        XCTAssertEqual(sentFrames(emitted), [crossed], "its nonce is spent; it must go out")
        XCTAssertFalse(session.laneFailed)

        let quiescent = session.producerStopped(batch: id, attempt: attempt)
        XCTAssertEqual(controls(quiescent), [LINK_FILE_BATCH_ABORT],
                       "and only now may the ordered barrier follow it")
        XCTAssertNil(session.outboundBatch)
    }

    /// After quiescence there is no attempt left to admit against, and a frame
    /// that arrives anyway has spent a nonce nothing can account for.
    func testAFrameAfterQuiescenceFailsTheLaneClosed() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.cancelOutbound()
        _ = session.producerStopped(batch: id, attempt: attempt)

        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame([1, 2, 3]))
        XCTAssertTrue(session.laneFailed)
    }

    /// A remote refusal mid-transfer is a STOP, and the sender owns the ordered
    /// retirement barrier for it. Retiring silently strands the peer in a drain
    /// that nothing ever ends.
    func testARemoteRejectWhileSendingEmitsTheOrderedAbortAfterQuiescence() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(
                                [UInt8](repeating: 1, count: C)))

        let stopped = session.admitFrame([RealtimeControl.reject.rawValue])
        XCTAssertTrue(stopped.contains(.stopProducer(batch: id, attempt: attempt)))
        XCTAssertEqual(controls(stopped), [], "the barrier waits for the producer")
        XCTAssertEqual(session.outboundPhase, .stopping)

        let quiescent = session.producerStopped(batch: id, attempt: attempt)
        XCTAssertEqual(controls(quiescent), [LINK_FILE_BATCH_ABORT],
                       "the sender retires its own batch on the wire")
        XCTAssertNil(session.outboundBatch)

        // And the lane is immediately reusable for the next batch.
        _ = try session.enqueue(files: [meta("next", 16)])
        XCTAssertFalse(session.pump().isEmpty)
        XCTAssertFalse(session.laneFailed)
    }

    /// A refusal that arrives once every frame is out has no producer to wait for.
    func testARemoteRejectWhileFinishingBarriersImmediately() throws {
        let (session, codecs, _) = pair()
        let body = [UInt8](repeating: 6, count: 40)
        let id = try session.enqueue(files: [meta("a.bin", body.count)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(body))
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextDoneFrame(
                                hash: chainHash([UInt8](repeating: 0, count: 32), body)))
        _ = session.producerFinished(batch: id, attempt: attempt)
        XCTAssertEqual(session.outboundPhase, .finishing)

        let stopped = session.admitFrame([RealtimeControl.reject.rawValue])
        XCTAssertEqual(controls(stopped), [LINK_FILE_BATCH_ABORT])
        XCTAssertNil(session.outboundBatch)
    }

    /// Cancelling before ACCEPT has no producer either: the barrier is immediate.
    func testCancellingBeforeConsentBarriersImmediately() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", C)])
        _ = session.pump()
        let effects = session.cancelOutbound()
        XCTAssertEqual(controls(effects), [LINK_FILE_BATCH_ABORT])
        XCTAssertTrue(effects.contains(.cancelConsentTimeout(batch: id, direction: .outbound)))
        XCTAssertNil(session.outboundBatch)
    }

    // ── producer attempts ───────────────────────────────────────────────────

    /// A replacement starts a NEW producer for the same batch. A frame from the
    /// old one has already spent a nonce in the single shared sender, so it can be
    /// neither treated as the resumed producer's nor quietly dropped: either way
    /// the peer's receive sequence and this side's disagree with nothing able to
    /// repair it.
    func testAFrameFromASupersededProducerFailsTheLaneClosed() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let first = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: first,
                             frame: try codecs.fileSender.nextChunkFrame(
                                [UInt8](repeating: 1, count: C)))

        _ = session.transportGap()
        _ = session.didAttachReplacementTransport()
        let resumed = session.admitFrame(resumeReqFrame(index: 0, offset: C))
        let second = try XCTUnwrap(session.outboundAttempt)
        XCTAssertNotEqual(first, second, "a resumed batch is a new attempt")
        XCTAssertTrue(resumed.contains(.startProducer(batch: id, attempt: second,
                                                      resume: ResumePoint(index: 0, offset: C))))

        // The producer that died with the old transport yields one last frame.
        let orphan = try codecs.fileSender.nextChunkFrame([UInt8](repeating: 2, count: 64))
        let late = session.produced(batch: id, attempt: first, frame: orphan)
        XCTAssertEqual(sentFrames(late), [], "it is not the resumed producer's frame")
        XCTAssertTrue(session.laneFailed,
                      "and its nonce is spent, so dropping it is not available either")
        XCTAssertEqual(late.suffix(2), [.poisonCodecs, .closeLane])
    }

    /// Credit is the lane's and the producer is the driver's, so the window
    /// closing has to be expressible as an instruction: stop pulling frames.
    func testTheProducerPausesWhenTheWindowClosesAndResumesOnCredit() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 0x55, count: 32),
                                recvKey: [UInt8](repeating: 0x66, count: 32))
        let session = LinkFileSession(codecs: codecs, window: 100, ackInterval: 1)
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])

        let first = try codecs.fileSender.nextChunkFrame([UInt8](repeating: 1, count: C))
        let paused = session.produced(batch: id, attempt: attempt, frame: first)
        XCTAssertEqual(sentFrames(paused), [first], "the frame still goes out; it is already sealed")
        XCTAssertTrue(paused.contains(.pauseProducer(batch: id, attempt: attempt)))

        let second = try codecs.fileSender.nextChunkFrame([UInt8](repeating: 2, count: 32))
        XCTAssertFalse(session.produced(batch: id, attempt: attempt, frame: second)
                        .contains(.pauseProducer(batch: id, attempt: attempt)),
                       "a closed window is not re-announced on every frame")

        XCTAssertEqual(session.admitFrame(ackFrame(Double(C))),
                       [.resumeProducer(batch: id, attempt: attempt)])
        XCTAssertEqual(session.admitFrame(ackFrame(Double(C))), [],
                       "and a repeated ACK grants no second resume")
    }

    // ── inbound: ACCEPT opens receive before the first chunk can race it ─────

    func testAnInboundManifestPromptsAndArmsTheConsentWindow() throws {
        let (session, _, peer) = pair()
        var effects: [LinkFileSessionEffect] = []
        for frame in try peer.batchFrames([meta("in.bin", C)]) { effects += session.admitFrame(frame) }

        let id = try XCTUnwrap(session.inboundBatch)
        XCTAssertEqual(session.inboundPhase, .prompt)
        XCTAssertTrue(effects.contains(.armConsentTimeout(batch: id, direction: .inbound)))
        XCTAssertFalse(session.laneFailed)
    }

    /// The ordering the whole inbound side turns on: the destination exists and the
    /// phase is `receiving` BEFORE ACCEPT reaches the wire. A sender that answers
    /// the instant it sees ACCEPT must not be able to land a chunk on a session
    /// that has nowhere to put it.
    func testTheDestinationOpensBeforeAcceptReachesTheWire() throws {
        let (session, _, peer) = pair()
        let files = [meta("in.bin", C)]
        for frame in try peer.batchFrames(files) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)

        let picking = session.acceptInbound()
        XCTAssertEqual(session.inboundPhase, .picking)
        XCTAssertTrue(picking.contains(.createDestination(batch: id, files: files)))
        XCTAssertEqual(sentFrames(picking), [], "nothing is answered until there is somewhere to write")

        let opened = session.didCreateDestination(batch: id)
        XCTAssertEqual(session.inboundPhase, .receiving, "receive is open FIRST")
        XCTAssertEqual(controls(opened), [RealtimeControl.accept.rawValue], "and only then ACCEPT")
        XCTAssertTrue(opened.contains(.cancelConsentTimeout(batch: id, direction: .inbound)))
        XCTAssertTrue(opened.contains(.armReceiveStall(batch: id)),
                      "a receive with no progress must not hang for ever")
    }

    func testADestinationThatFailsToOpenRejectsWithoutFailingTheLane() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        _ = session.acceptInbound()

        let effects = session.destinationFailed(batch: id)
        XCTAssertEqual(controls(effects), [RealtimeControl.reject.rawValue])
        XCTAssertFalse(session.laneFailed)
    }

    /// Content before consent must never be decrypted, so a chunk that arrives
    /// while the prompt is still up fails this lane closed WITHOUT being fed.
    func testProtectedContentBeforeConsentFailsTheLaneWithoutDecrypting() throws {
        let (session, codecs, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        XCTAssertEqual(session.inboundPhase, .prompt)

        let chainBefore = codecs.fileReceiver.snapshotChain()
        let effects = session.admitFrame(try peer.nextChunkFrame([UInt8](repeating: 3, count: 32)))
        XCTAssertTrue(session.laneFailed)
        XCTAssertEqual(effects.suffix(2), [.poisonCodecs, .closeLane])
        XCTAssertEqual(codecs.fileReceiver.snapshotChain(), chainBefore,
                       "the receiver never saw it: nothing was hashed")
    }

    /// The two consent windows can be open at once — this side waiting for the
    /// peer's answer, the peer waiting for this user's. An inbound timeout retires
    /// the PROMPT, leaves the outbound batch alone, and puts no stale untagged
    /// answer on the wire.
    func testAnInboundConsentTimeoutRetiresOnlyThePromptAndAnswersNothing() throws {
        let (session, _, peer) = pair()
        let out = try session.enqueue(files: [meta("mine", 8)])
        _ = session.pump()
        for frame in try peer.batchFrames([meta("theirs", C)]) { _ = session.admitFrame(frame) }
        let inbound = try XCTUnwrap(session.inboundBatch)

        let expired = session.inboundConsentTimedOut(batch: inbound)
        XCTAssertEqual(controls(expired), [],
                       "an untagged ACCEPT or REJECT now could answer the sender's NEXT batch")
        XCTAssertTrue(expired.contains(.cancelConsentTimeout(batch: inbound, direction: .inbound)))
        XCTAssertNil(session.inboundBatch, "the prompt is gone")
        XCTAssertEqual(session.outboundBatch, out, "and the outbound batch is untouched")
        XCTAssertEqual(session.outboundPhase, .waitingAccept)
    }

    /// A picker that was still open when the window closed loses its destination
    /// too, and still answers nothing.
    func testAnInboundConsentTimeoutWhilePickingAbortsTheDestination() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        _ = session.acceptInbound()

        let expired = session.inboundConsentTimedOut(batch: id)
        XCTAssertTrue(expired.contains(.abortDestination(batch: id)))
        XCTAssertEqual(controls(expired), [])
        XCTAssertNil(session.inboundBatch)
    }

    // ── refusal, drain and its bounds ───────────────────────────────────────

    /// Before ACCEPT the sender has emitted only the manifest, so REJECT is itself
    /// the complete ordered barrier. The batch must be retired with it — the link
    /// receiver refuses a second manifest while one is live, so a batch left
    /// standing here would fail the peer's very NEXT batch.
    func testARefusalBeforeConsentIsItselfTheBarrierAndFreesTheLane() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", 4 * C)]) { _ = session.admitFrame(frame) }

        let refused = session.rejectInbound()
        XCTAssertEqual(controls(refused), [RealtimeControl.reject.rawValue])
        XCTAssertNil(session.inboundBatch, "nothing is in flight, so nothing has to drain")

        var next: [LinkFileSessionEffect] = []
        for frame in try peer.batchFrames([meta("second.bin", 8)]) { next += session.admitFrame(frame) }
        XCTAssertEqual(session.inboundPhase, .prompt)
        XCTAssertFalse(session.laneFailed)
    }

    /// A stop AFTER consent is the other shape: content is already in flight, and
    /// every frame of it still has to be authenticated or the receive sequence is
    /// stranded. It drains — written nowhere, bounded by what is LEFT of the
    /// manifest, and under a timeout.
    func testAStoppedTransferDrainsTheRemainingDeclaredBytesAndWritesNothing() throws {
        let (session, _, peer) = pair()
        let body = [UInt8](repeating: 9, count: C)
        // Four files, so the receiver's own per-file check cannot be what bounds
        // the drain: only the manifest's remainder can.
        let files = (0..<4).map { meta("f\($0).bin", C) }
        for frame in try peer.batchFrames(files) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)

        // One whole file arrives and is made durable before the stop.
        _ = admitAndPersist(session, try peer.nextChunkFrame(body))
        _ = admitAndPersist(session, try peer.nextDoneFrame(
            hash: chainHash([UInt8](repeating: 0, count: 32), body)))

        let stopped = session.rejectInbound()
        XCTAssertEqual(controls(stopped), [RealtimeControl.reject.rawValue])
        XCTAssertTrue(stopped.contains(.abortDestination(batch: id)))
        XCTAssertTrue(stopped.contains(.armDrainTimeout(batch: id)))
        XCTAssertTrue(stopped.contains(.cancelReceiveStall(batch: id)))
        XCTAssertEqual(session.inboundPhase, .draining)

        // The three remaining declared files may still drain; nothing is written.
        for _ in 0..<3 {
            let effects = session.admitFrame(try peer.nextChunkFrame(body))
            XCTAssertNil(firstPersist(effects), "a refused batch writes nothing")
            _ = session.admitFrame(try peer.nextDoneFrame(
                hash: chainHash([UInt8](repeating: 0, count: 32), body)))
        }
        XCTAssertFalse(session.laneFailed, "exactly the manifest's remainder was drainable")
    }

    /// A peer that keeps streaming after the drain window is not draining any more.
    /// Only the FILE lane ends.
    func testADrainTimeoutFailsOnlyTheFileLane() throws {
        let (session, _, peer) = pair()
        let text = LinkTextLane(role: .initiator, now: { 0 })
        _ = text.localOpen()
        _ = text.inboundControl(.accept)

        for frame in try peer.batchFrames([meta("in.bin", 4 * C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        _ = session.rejectInbound()
        XCTAssertEqual(session.inboundPhase, .draining)

        let expired = session.drainTimedOut(batch: id)
        XCTAssertEqual(expired.suffix(2), [.poisonCodecs, .closeLane])
        XCTAssertTrue(session.laneFailed)
        XCTAssertEqual(text.status, .open, "the conversation is untouched")
        XCTAssertFalse(text.codecsPoisoned)
    }

    /// A consented receive that stops making progress is a stall: refuse it and
    /// drain what is already in flight.
    func testAReceiveStallRejectsAndBeginsABoundedDrain() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", 4 * C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)

        let stalled = session.receiveStalled(batch: id)
        XCTAssertEqual(controls(stalled), [RealtimeControl.reject.rawValue])
        XCTAssertTrue(stalled.contains(.abortDestination(batch: id)))
        XCTAssertTrue(stalled.contains(.armDrainTimeout(batch: id)))
        XCTAssertEqual(session.inboundPhase, .draining)
        XCTAssertFalse(session.laneFailed)

        XCTAssertEqual(session.receiveStalled(batch: id), [], "and it fires only once")
    }

    // ── persistence gates the checkpoint and the ACK ─────────────────────────

    func testAnAuthenticatedChunkIsPersistedBeforeTheCheckpointOrAckMoves() throws {
        let (session, _, peer) = pair()
        let body = [UInt8](repeating: 5, count: C)
        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)

        let effects = session.admitFrame(try peer.nextChunkFrame(body))
        guard case let .persistChunk(batch, bytes, point)? = effects.first(where: {
            if case .persistChunk = $0 { return true } else { return false }
        }) else { return XCTFail("an authenticated chunk must reach the owner to be written") }
        XCTAssertEqual(batch, id)
        XCTAssertEqual(bytes, body, "the plaintext the owner writes is the chunk that arrived")
        XCTAssertEqual(point.offset, C)
        XCTAssertEqual(session.lane.durableCheckpoint.offset, 0, "authenticated is not durable")
        XCTAssertEqual(sentFrames(effects), [], "and nothing is acknowledged yet")

        let committed = session.didPersist(batch: id, checkpoint: point)
        XCTAssertEqual(session.lane.durableCheckpoint, point)
        XCTAssertEqual(sentFrames(committed).first?.first, RealtimeKind.ack,
                       "the durable total is what gets acknowledged")
    }

    /// Two batches over one manifest produce BYTE-IDENTICAL checkpoints, so a
    /// checkpoint alone cannot say which batch a completed write belongs to.
    func testAStalePersistDoesNotCommitAnIdenticalCheckpointForALaterBatch() throws {
        let (session, _, peer) = pair()
        let body = [UInt8](repeating: 3, count: C)
        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { _ = session.admitFrame(frame) }
        let stale = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        let first = session.admitFrame(try peer.nextChunkFrame(body))
        let stalePoint = try XCTUnwrap(firstPersist(first))

        // A is retired by the ordered barrier while its write is still in flight.
        _ = session.admitFrame([LINK_FILE_BATCH_ABORT])
        // B arrives over the same manifest and admits the same first chunk.
        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { _ = session.admitFrame(frame) }
        let live = try XCTUnwrap(session.inboundBatch)
        XCTAssertNotEqual(stale, live)
        try consent(session)
        let livePoint = try XCTUnwrap(firstPersist(session.admitFrame(try peer.nextChunkFrame(body))))
        XCTAssertEqual(stalePoint, livePoint, "identical bytes give identical checkpoints")

        // A's write lands now. It says nothing about B.
        XCTAssertEqual(session.didPersist(batch: stale, checkpoint: stalePoint), [])
        XCTAssertEqual(session.lane.durableCheckpoint.offset, 0,
                       "a write for a retired batch must not advance the batch that replaced it")
        // B's own write still commits.
        XCTAssertFalse(session.didPersist(batch: live, checkpoint: livePoint).isEmpty)
        XCTAssertEqual(session.lane.durableCheckpoint, livePoint)
    }

    // ── stale asynchronous results ──────────────────────────────────────────

    func testADestinationThatOpensForARetiredBatchIsAbortedNotAdopted() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("first", C)]) { _ = session.admitFrame(frame) }
        let stale = try XCTUnwrap(session.inboundBatch)
        _ = session.acceptInbound()
        _ = session.admitFrame([LINK_FILE_BATCH_ABORT])
        XCTAssertNil(session.inboundBatch)

        for frame in try peer.batchFrames([meta("second", C)]) { _ = session.admitFrame(frame) }
        let live = try XCTUnwrap(session.inboundBatch)
        XCTAssertNotEqual(stale, live)

        let effects = session.didCreateDestination(batch: stale)
        XCTAssertEqual(effects, [.abortDestination(batch: stale)])
        XCTAssertEqual(session.inboundPhase, .prompt, "the live batch is untouched")
        XCTAssertEqual(sentFrames(effects), [], "and no ACCEPT was answered for it")
    }

    // ── BATCH_ABORT is an ordered retirement barrier ─────────────────────────

    func testTheAbortBarrierRetiresTheInboundBatchAndItsDestination() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)

        let effects = session.admitFrame([LINK_FILE_BATCH_ABORT])
        XCTAssertTrue(effects.contains(.abortDestination(batch: id)))
        XCTAssertNil(session.inboundBatch)
        XCTAssertFalse(session.laneFailed, "retirement is not failure")

        var next: [LinkFileSessionEffect] = []
        for frame in try peer.batchFrames([meta("next.bin", 8)]) { next += session.admitFrame(frame) }
        XCTAssertEqual(session.inboundPhase, .prompt)
        XCTAssertFalse(session.laneFailed)
    }

    /// The barrier that closes a replay window must not undo a destination the
    /// user already has.
    func testALateAbortDoesNotAbortAnAlreadyFinalisedDestination() throws {
        let (session, _, peer) = pair()
        let body = WireVectors.content(40, seed: 72)
        let file = meta("only.bin", body.count)
        for frame in try peer.batchFrames([file]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        for frame in try peer.dataFrames([(file, body)]) { _ = admitAndPersist(session, frame) }
        XCTAssertEqual(session.inboundPhase, .complete)
        XCTAssertTrue(session.lane.destinationFinalized)

        let retired = session.admitFrame([LINK_FILE_BATCH_ABORT])
        XCTAssertFalse(retired.contains(.abortDestination(batch: id)),
                       "the file is written and finalised; the barrier only closes the replay")
        XCTAssertNil(session.inboundBatch)
    }

    // ── generations ─────────────────────────────────────────────────────────

    func testAGapSuspendsLaunchAndReportsWorkWorthRecovering() throws {
        let (session, _, _) = pair()
        _ = try session.enqueue(files: [meta("a", 8)])
        _ = session.pump()

        let outcome = session.transportGap()
        XCTAssertTrue(outcome.needsRecovery)
        XCTAssertEqual(session.generation, 1)
        XCTAssertEqual(session.pump(), [], "nothing launches into a gap")
        XCTAssertFalse(session.laneFailed, "a gap never poisons a file codec")
    }

    func testAQueuedBatchAloneIsWorthRecovering() throws {
        let (session, _, _) = pair()
        _ = try session.enqueue(files: [meta("queued", 8)])
        XCTAssertNil(session.outboundBatch, "never launched")
        XCTAssertTrue(session.transportGap().needsRecovery)
    }

    /// A manifest still waiting for a user's answer is worth recovering — the queue
    /// behind it is work a replacement would carry. The PROMPT itself does not
    /// survive: a prompt has no durable byte contract to resume from.
    func testAnUnansweredInboundPromptIsWorthRecoveringButDoesNotSurvive() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        XCTAssertEqual(session.inboundPhase, .prompt)

        XCTAssertTrue(session.transportGap().needsRecovery, "sampled before anything is retired")
        XCTAssertNil(session.inboundBatch, "a prompt has nothing a replacement could resume")

        _ = session.didAttachReplacementTransport()
        _ = session.admitFrame(try peer.resumeStartFrame(ResumePoint(index: 0, offset: 0)))
        XCTAssertFalse(session.laneFailed, "the idle direction realigned at the origin")
        for frame in try peer.batchFrames([meta("after.bin", 8)]) { _ = session.admitFrame(frame) }
        XCTAssertEqual(session.inboundPhase, .prompt)
        XCTAssertFalse(session.laneFailed)
    }

    /// A completion wait belongs to the transport it was armed on. Left running
    /// across a gap it would retire a batch that is mid-resume.
    func testAGapCancelsTheCompletionWaitOfAResumingBatch() throws {
        let (session, codecs, _) = pair()
        let body = [UInt8](repeating: 3, count: 40)
        let id = try session.enqueue(files: [meta("a.bin", body.count)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(body))
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextDoneFrame(
                                hash: chainHash([UInt8](repeating: 0, count: 32), body)))
        _ = session.producerFinished(batch: id, attempt: attempt)
        XCTAssertEqual(session.outboundPhase, .finishing)

        let outcome = session.transportGap()
        XCTAssertTrue(outcome.effects.contains(.cancelCompleteTimeout(batch: id)))
        XCTAssertEqual(session.outboundPhase, .resuming, "the batch itself survives the gap")
        XCTAssertEqual(session.completeTimedOut(batch: id), [],
                       "and a wait that fired anyway retires nothing")
        XCTAssertEqual(session.outboundBatch, id)
    }

    func testAnIdleSessionAsksForNoRecovery() {
        let (session, _, _) = pair()
        XCTAssertFalse(session.transportGap().needsRecovery)
    }

    /// Before ACCEPT there is no checkpoint contract, so parking the batch in
    /// `resuming` would wait for a request the peer can never send.
    func testAnUnconsentedOutboundBatchDoesNotSurviveAGap() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        XCTAssertEqual(session.outboundPhase, .waitingAccept)

        let outcome = session.transportGap()
        XCTAssertTrue(outcome.needsRecovery)
        XCTAssertFalse(outcome.effects.contains(.stopProducer(batch: id, attempt: attempt)),
                       "waiting for consent, no producer was ever started")
        XCTAssertTrue(outcome.effects.contains(.cancelConsentTimeout(batch: id, direction: .outbound)))
        XCTAssertNil(session.outboundBatch, "nothing to resume, so nothing is parked")
        XCTAssertFalse(session.laneFailed)

        _ = session.didAttachReplacementTransport()
        _ = try session.enqueue(files: [meta("b.bin", 32)])
        let frames = sentFrames(session.pump())
        XCTAssertEqual(frames.first?.first, RealtimeKind.resumeStart)
        XCTAssertEqual(frames.dropFirst().first?.first, RealtimeKind.batchEnc)
    }

    func testAnIdleReplacedGenerationRealignsAtTheOriginBeforeItsNextManifest() throws {
        let (session, _, _) = pair()
        _ = session.transportGap()
        _ = try session.enqueue(files: [meta("after.bin", 64)])
        XCTAssertEqual(session.pump(), [], "no launch before the replacement attaches")

        _ = session.didAttachReplacementTransport()
        let frames = sentFrames(session.pump())
        XCTAssertEqual(frames.first?.first, RealtimeKind.resumeStart,
                       "the origin realignment comes first")
        XCTAssertEqual(frames.first.flatMap(parseResumeStart)?.point, ResumePoint(index: 0, offset: 0))
        XCTAssertEqual(frames.dropFirst().first?.first, RealtimeKind.batchEnc,
                       "and the manifest follows it")
    }

    func testAnActiveReceiveWaitsForOutstandingPersistenceBeforeItsResumeRequest() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        let admitted = session.admitFrame(try peer.nextChunkFrame([UInt8](repeating: 6, count: C)))
        let point = try XCTUnwrap(firstPersist(admitted))

        _ = session.transportGap()
        let attached = session.didAttachReplacementTransport()
        XCTAssertTrue(sentFrames(attached).allSatisfy { $0.first != RealtimeKind.resumeReq },
                      "the durable prefix is not known until the write reports back")

        let settled = session.didPersist(batch: id, checkpoint: point)
        let request = try XCTUnwrap(sentFrames(settled).first { $0.first == RealtimeKind.resumeReq })
        XCTAssertEqual(parseResumeReq(request), ResumePoint(index: 0, offset: C),
                       "and then it names exactly what reached the disk")
    }

    func testAnActiveReceiveWithASettledFifoAsksImmediatelyOnAttach() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", 2 * C)]) { _ = session.admitFrame(frame) }
        try consent(session)
        _ = admitAndPersist(session, try peer.nextChunkFrame([UInt8](repeating: 6, count: C)))

        _ = session.transportGap()
        let attached = session.didAttachReplacementTransport()
        let request = try XCTUnwrap(sentFrames(attached).first { $0.first == RealtimeKind.resumeReq })
        XCTAssertEqual(parseResumeReq(request), ResumePoint(index: 0, offset: C))
    }

    func testAnActiveOutboundAnswersOnlyAValidResumeRequest() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(
                                [UInt8](repeating: 2, count: C)))
        _ = session.transportGap()
        _ = session.didAttachReplacementTransport()

        let forged = session.admitFrame(resumeReqFrame(index: 0, offset: 3 * C))
        XCTAssertEqual(sentFrames(forged), [], "nothing is announced for a point never produced")
        XCTAssertFalse(session.laneFailed, "and a forged plaintext frame does not end the lane")

        let valid = session.admitFrame(resumeReqFrame(index: 0, offset: C))
        let marker = try XCTUnwrap(sentFrames(valid).first { $0.first == RealtimeKind.resumeStart })
        XCTAssertEqual(parseResumeStart(marker)?.point, ResumePoint(index: 0, offset: C))
        let resumed = try XCTUnwrap(session.outboundAttempt)
        XCTAssertTrue(valid.contains(.startProducer(batch: id, attempt: resumed,
                                                    resume: ResumePoint(index: 0, offset: C))))
    }

    // ── the replayed final DONE ─────────────────────────────────────────────

    /// The replay exists because the COMPLETE was lost, not because the destination
    /// was not finalised. Finalising is one-shot; the ANSWER is not.
    func testAReplayedFinalDoneAnswersAgainWithoutASecondFinalisation() throws {
        let (session, _, peer) = pair()
        let body = WireVectors.content(40, seed: 73)
        let file = meta("only.bin", body.count)
        for frame in try peer.batchFrames([file]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        for frame in try peer.dataFrames([(file, body)]) { _ = admitAndPersist(session, frame) }
        XCTAssertTrue(session.lane.destinationFinalized)

        _ = session.transportGap()
        let attached = session.didAttachReplacementTransport()
        let end = ResumePoint(index: 0, offset: body.count)
        XCTAssertEqual(sentFrames(attached).first.flatMap(parseResumeReq), end,
                       "the exact end is the point a replayed DONE resumes from")

        _ = session.admitFrame(try peer.resumeStartFrame(end))
        let replay = try peer.dataFrames([(file, body)], resume: end)
        XCTAssertEqual(replay.count, 1, "no chunks: only the DONE is owed")
        let answered = session.admitFrame(replay[0])

        XCTAssertEqual(controls(answered), [RealtimeControl.complete.rawValue],
                       "the answer the sender replayed the DONE to get")
        XCTAssertFalse(hasFinalize(answered, id),
                       "the destination is already finalised; finalising again duplicates it")
    }

    /// A replay that crosses an outstanding FIRST finalisation must not ask for a
    /// second one either — the pending finalisation will answer for both.
    func testAReplayCrossingAnOutstandingFinalisationDoesNotDuplicateIt() throws {
        let (session, _, peer) = pair()
        let body = WireVectors.content(40, seed: 74)
        let file = meta("only.bin", body.count)
        for frame in try peer.batchFrames([file]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)

        var sawFinalize = 0
        for frame in try peer.dataFrames([(file, body)]) {
            let effects = session.admitFrame(frame)
            if let point = firstPersist(effects) { _ = session.didPersist(batch: id, checkpoint: point) }
            if hasFinalize(effects, id) { sawFinalize += 1 }
        }
        XCTAssertEqual(sawFinalize, 1)
        XCTAssertFalse(session.lane.destinationFinalized, "the driver has not reported back yet")

        // The gap and the replay arrive while that finalisation is still in flight.
        _ = session.transportGap()
        _ = session.didAttachReplacementTransport()
        let end = ResumePoint(index: 0, offset: body.count)
        _ = session.admitFrame(try peer.resumeStartFrame(end))
        let replayed = session.admitFrame(try peer.dataFrames([(file, body)], resume: end)[0])
        XCTAssertFalse(hasFinalize(replayed, id), "one finalisation is already outstanding")
        XCTAssertEqual(controls(replayed), [], "it will answer when it reports back")

        XCTAssertEqual(controls(session.didFinalizeDestination(batch: id)),
                       [RealtimeControl.complete.rawValue])
        XCTAssertTrue(session.lane.destinationFinalized)
    }

    // ── the text lane is untouched ──────────────────────────────────────────

    func testAFileSessionFailureLeavesASimultaneousTextConversationOpen() throws {
        let (session, _, peer) = pair()
        let text = LinkTextLane(role: .initiator, now: { 0 })
        _ = text.localOpen()
        _ = text.inboundControl(.accept)
        XCTAssertEqual(text.status, .open)

        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        _ = session.admitFrame(try peer.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        XCTAssertTrue(session.laneFailed, "content before consent failed the FILE lane")

        XCTAssertEqual(text.status, .open, "the conversation is untouched")
        XCTAssertTrue(text.maySendProtected)
        XCTAssertFalse(text.codecsPoisoned)
    }

    /// Work a user queued does not simply vanish when the lane dies.
    func testATerminalLaneNamesTheBatchesThatWillNeverGoOut() throws {
        let (session, _, peer) = pair()
        let a = try session.enqueue(files: [meta("a", 8)])
        let b = try session.enqueue(files: [meta("b", 8)])
        _ = session.pump()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }

        let failed = session.admitFrame(try peer.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        XCTAssertTrue(session.laneFailed)
        XCTAssertTrue(failed.contains(.batchesFailed([a, b])),
                      "a driver must be able to retire exactly the work it showed the user")
        XCTAssertEqual(session.failedBatchIds, [a, b])
        XCTAssertEqual(session.queuedBatchIds, [])
    }

    // ── one codec object, for the whole life of the link ────────────────────

    func testTheSessionNeverReplacesTheLinksCodecs() throws {
        let (session, codecs, peer) = pair()
        let sender = codecs.fileSender
        let receiver = codecs.fileReceiver
        _ = try session.enqueue(files: [meta("a", 8)])
        _ = session.pump()
        _ = session.admitFrame([RealtimeControl.reject.rawValue])
        _ = session.transportGap()
        _ = session.didAttachReplacementTransport()
        for frame in try peer.batchFrames([meta("in", 8)]) { _ = session.admitFrame(frame) }
        _ = session.admitFrame([LINK_FILE_BATCH_ABORT])

        XCTAssertTrue(codecs.fileSender === sender, "one send sequence for the link's whole life")
        XCTAssertTrue(codecs.fileReceiver === receiver)
    }

    // ── the recovery seam ───────────────────────────────────────────────────

    func testTheRecoveryPolicySeamSuspendsAndThenAnswers() throws {
        let (session, codecs, _) = pair()
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "123456", codecs: codecs)
        var delivered: [LinkFileSessionEffect] = []
        session.onEffects = { delivered += $0 }
        let id = try session.enqueue(files: [meta("a", 8)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])   // a producer is now running

        let hook: (LinkIdentity) throws -> Bool = session.onTransportLost
        XCTAssertTrue(try hook(identity), "work in flight is worth a replacement")
        XCTAssertEqual(session.generation, 1, "and asking suspended the lane, exactly once")
        XCTAssertTrue(delivered.contains(.stopProducer(batch: id, attempt: attempt)),
                      "the effects a Bool-returning hook cannot carry still reach the driver")
        XCTAssertTrue(try hook(identity), "a second report of one gap answers the same")
        XCTAssertEqual(session.generation, 1)
    }

    func testTheRecoveryPolicySeamDeclinesWhenNothingIsInFlight() {
        let (session, codecs, _) = pair()
        let identity = LinkIdentity(peerId: "peer", role: .responder, sas: "654321", codecs: codecs)
        XCTAssertFalse(session.onTransportLost(identity))
    }

    func testAFailedLaneDeclinesRecovery() throws {
        let (session, codecs, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", C)]) { _ = session.admitFrame(frame) }
        _ = session.admitFrame(try peer.nextChunkFrame([UInt8](repeating: 1, count: 32)))
        XCTAssertTrue(session.laneFailed)
        let identity = LinkIdentity(peerId: "peer", role: .initiator, sas: "111111", codecs: codecs)
        XCTAssertFalse(session.onTransportLost(identity))
    }

    // ── multi-file resume beyond the first file ─────────────────────────────

    /// The case a single-file resume cannot cover: the durable point is a LATER
    /// file's interior, the checkpoint that got there is the next file's zero, and
    /// the replacement's producer must start from exactly the requested point.
    func testAMultiFileBatchResumesInsideTheSecondFile() throws {
        let (session, _, peer) = pair()
        let first = WireVectors.content(C, seed: 91)
        let second = WireVectors.content(2 * C, seed: 92)
        let files = [meta("one.bin", first.count), meta("two.bin", second.count)]
        for frame in try peer.batchFrames(files) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)

        var written: [[UInt8]] = [[], []]
        func absorb(_ effects: [LinkFileSessionEffect]) -> [LinkFileSessionEffect] {
            var out = effects
            for effect in effects {
                switch effect {
                case let .persistChunk(batch, bytes, checkpoint):
                    written[checkpoint.index] += bytes
                    out += session.didPersist(batch: batch, checkpoint: checkpoint)
                case let .openFile(batch, index, checkpoint):
                    XCTAssertEqual(index, 1, "the next file's zero is a durable checkpoint")
                    XCTAssertEqual(checkpoint, LinkFileCheckpoint(index: 1, offset: 0,
                                                                  chain: [UInt8](repeating: 0, count: 32)))
                    out += session.didPersist(batch: batch, checkpoint: checkpoint)
                case let .finalizeDestination(batch):
                    out += session.didFinalizeDestination(batch: batch)
                default:
                    continue
                }
            }
            return out
        }

        // File one, its DONE, and the first chunk of file two.
        let frames = try peer.dataFrames([(files[0], first), (files[1], second)])
        for frame in frames.prefix(3) { _ = absorb(session.admitFrame(frame)) }
        XCTAssertEqual(session.lane.durableCheckpoint.index, 1)
        XCTAssertEqual(session.lane.durableCheckpoint.offset, C)

        // The transport dies mid-file-two and is replaced.
        _ = session.transportGap()
        let attached = session.didAttachReplacementTransport()
        let point = ResumePoint(index: 1, offset: C)
        XCTAssertEqual(sentFrames(attached).first.flatMap(parseResumeReq), point,
                       "the request names the interior of the second file")

        _ = session.admitFrame(try peer.resumeStartFrame(point))
        XCTAssertEqual(session.inboundPhase, .receiving)

        var completed = 0
        for frame in try peer.dataFrames([(files[0], first), (files[1], second)], resume: point) {
            let effects = absorb(session.admitFrame(frame))
            if controls(effects).contains(RealtimeControl.complete.rawValue) { completed += 1 }
        }

        XCTAssertEqual(written, [first, second], "byte-exact across the replacement")
        XCTAssertEqual(completed, 1, "one COMPLETE, once the destination was finalised")
        XCTAssertTrue(session.lane.destinationFinalized)
        XCTAssertFalse(session.lane.didFinalizeDestination(), "and finalised exactly once")
        XCTAssertFalse(session.laneFailed)
        _ = id
    }

    // ── a real streaming round trip through the owner seams ─────────────────

    /// Two sessions wired to each other's codecs carry a real multi-file batch end
    /// to end: manifest, consent, streamed chunks from a real
    /// `RealtimeFrameProducer`, durable checkpoints, per-file DONEs, COMPLETE.
    func testARealStreamingRoundTripThroughBothSessions() throws {
        let aKey = [UInt8](repeating: 0x33, count: 32)
        let bKey = [UInt8](repeating: 0x44, count: 32)
        let a = LinkCodecs(sendKey: aKey, recvKey: bKey)
        let b = LinkCodecs(sendKey: bKey, recvKey: aKey)
        let up = LinkFileSession(codecs: a, ackInterval: 1)
        let down = LinkFileSession(codecs: b, ackInterval: 1)

        let first = WireVectors.content(2 * C + 7, seed: 61)
        let second = WireVectors.content(40, seed: 62)
        let files = [meta("one.bin", first.count), meta("two.bin", second.count)]
        let sources: [PlaintextSource] = [DataSource(name: "one.bin", bytes: first),
                                          DataSource(name: "two.bin", bytes: second)]

        enum Side { case up, down }
        var written: [[UInt8]] = [[]]
        var finalized = 0
        var producer: RealtimeFrameProducer?

        /// Perform one side's effects the way a driver must: depth first, so a
        /// write is reported back before the next protected frame is admitted.
        /// That IS the receive FIFO this owner requires.
        func run(_ effects: [LinkFileSessionEffect], on side: Side) throws {
            let me = side == .up ? up : down
            let peer = side == .up ? down : up
            let peerSide: Side = side == .up ? .down : .up
            for effect in effects {
                switch effect {
                case let .sendFrame(frame):
                    try run(peer.admitFrame(frame), on: peerSide)
                case .armConsentTimeout(_, .inbound):
                    // The user consents the moment the prompt appears.
                    try run(down.acceptInbound(), on: .down)
                case let .createDestination(batch, list):
                    XCTAssertEqual(list, files, "the destination is opened for the manifest as sent")
                    try run(me.didCreateDestination(batch: batch), on: side)
                case let .startProducer(batch, attempt, resume):
                    let stream = RealtimeFrameProducer(sender: a.fileSender,
                                                       sources: sources, resume: resume)
                    producer = stream
                    while let frame = try stream.next() {
                        let out = me.produced(batch: batch, attempt: attempt, frame: frame)
                        XCTAssertFalse(out.contains(.pauseProducer(batch: batch, attempt: attempt)),
                                       "this batch fits inside one flow-control window")
                        try run(out, on: side)
                    }
                    try run(me.producerFinished(batch: batch, attempt: attempt), on: side)
                case let .openFile(batch, index, checkpoint):
                    XCTAssertEqual(index, written.count, "files open in manifest order")
                    written.append([])
                    try run(me.didPersist(batch: batch, checkpoint: checkpoint), on: side)
                case let .persistChunk(batch, bytes, checkpoint):
                    written[checkpoint.index] += bytes
                    try run(me.didPersist(batch: batch, checkpoint: checkpoint), on: side)
                case let .finalizeDestination(batch):
                    finalized += 1
                    try run(me.didFinalizeDestination(batch: batch), on: side)
                case let .abortDestination(batch):
                    XCTFail("nothing in a clean round trip aborts a destination (\(batch))")
                default:
                    continue   // timers and credit signalling belong to a real driver
                }
            }
        }

        let batch = try up.enqueue(files: files)
        try run(up.pump(), on: .up)

        XCTAssertEqual(batch, 1, "the first identifier of this session")
        XCTAssertFalse(up.laneFailed)
        XCTAssertFalse(down.laneFailed)
        XCTAssertEqual(written, [first, second], "byte-exact through a real producer and receiver")
        XCTAssertEqual(finalized, 1, "the destination is finalised exactly once")
        XCTAssertNil(up.outboundBatch, "the sender's batch retired on COMPLETE")
        XCTAssertEqual(down.inboundPhase, .complete,
                       "and the receiver holds its finished batch for a replayed final DONE")
        XCTAssertEqual(up.generation, 0, "no gap happened")
        XCTAssertGreaterThan(producer?.peakHeldBytes ?? 0, 0, "the stream really ran")
        XCTAssertLessThanOrEqual(producer?.peakHeldBytes ?? .max, 2 * C + CHUNK_OVERHEAD,
                                 "and it stayed a stream: one held chunk plus one sealed frame, "
                                 + "never the whole transfer")
    }

    // ── external operations fail, and the session has to hear about it ──────

    /// A real producer reads real sources: they change, they are unreadable, they
    /// go away. The failure callback certifies quiescence by itself — a producer
    /// that threw is not going to seal anything else — so the ordered barrier may
    /// follow it immediately.
    func testAProducerFailureRetiresTheBatchWithTheOrderedBarrier() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])

        let failed = session.producerFailed(batch: id, attempt: attempt)
        XCTAssertEqual(controls(failed), [LINK_FILE_BATCH_ABORT],
                       "the peer is told this batch is over, in order")
        XCTAssertNil(session.outboundBatch)
        XCTAssertFalse(session.laneFailed, "a source that broke says nothing about the codecs")
    }

    /// And the lane goes on: the next batch takes it normally.
    func testAProducerFailureLeavesTheLaneReusableForTheNextBatch() throws {
        let (session, _, _) = pair()
        let first = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.producerFailed(batch: first, attempt: attempt)

        let second = try session.enqueue(files: [meta("b.bin", 64)])
        let launched = session.pump()
        XCTAssertEqual(session.outboundBatch, second)
        XCTAssertEqual(sentFrames(launched).first?.first, RealtimeKind.batchEnc)
        XCTAssertFalse(session.laneFailed)
    }

    /// A failure report for an attempt that is already gone changes nothing.
    func testAStaleProducerFailureIsInert() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.producerFailed(batch: id, attempt: attempt)

        XCTAssertEqual(session.producerFailed(batch: id, attempt: attempt), [])
        XCTAssertFalse(session.laneFailed, "it consumed no nonce, so it is not a protocol event")
    }

    /// A write that fails half-way through a consented receive is a save failure,
    /// not a protocol one: refuse the batch, abort the destination, and drain the
    /// frames already in flight until the sender's barrier retires it.
    func testAMidWriteDestinationFailureRejectsAndBeginsBoundedDrain() throws {
        let (session, _, peer) = pair()
        for frame in try peer.batchFrames([meta("in.bin", 4 * C)]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        _ = admitAndPersist(session, try peer.nextChunkFrame([UInt8](repeating: 1, count: C)))

        let failed = session.destinationFailed(batch: id)
        XCTAssertEqual(controls(failed), [RealtimeControl.reject.rawValue])
        XCTAssertTrue(failed.contains(.abortDestination(batch: id)))
        XCTAssertTrue(failed.contains(.armDrainTimeout(batch: id)))
        XCTAssertEqual(session.inboundPhase, .draining)
        XCTAssertFalse(session.laneFailed)

        // In-flight content still drains, and the sender's barrier retires it.
        _ = session.admitFrame(try peer.nextChunkFrame([UInt8](repeating: 1, count: C)))
        XCTAssertFalse(session.laneFailed)
        _ = session.admitFrame([LINK_FILE_BATCH_ABORT])
        XCTAssertNil(session.inboundBatch)
    }

    /// The last operation of all can fail too. A destination that verified but
    /// could not be committed is not a delivered file.
    func testAFinalisationFailureRejectsAndWaitsForTheBarrier() throws {
        let (session, _, peer) = pair()
        let body = WireVectors.content(40, seed: 75)
        let file = meta("only.bin", body.count)
        for frame in try peer.batchFrames([file]) { _ = session.admitFrame(frame) }
        let id = try XCTUnwrap(session.inboundBatch)
        try consent(session)
        var askedToFinalize = false
        for frame in try peer.dataFrames([(file, body)]) {
            let effects = session.admitFrame(frame)
            if let point = firstPersist(effects) { _ = session.didPersist(batch: id, checkpoint: point) }
            if hasFinalize(effects, id) { askedToFinalize = true }
        }
        XCTAssertTrue(askedToFinalize)

        let failed = session.destinationFailed(batch: id)
        XCTAssertEqual(controls(failed), [RealtimeControl.reject.rawValue],
                       "the sender must not be told the batch arrived")
        XCTAssertTrue(failed.contains(.abortDestination(batch: id)))
        XCTAssertEqual(session.inboundPhase, .draining)
        XCTAssertFalse(session.lane.destinationFinalized)
        XCTAssertFalse(session.laneFailed)
    }

    // ── an early COMPLETE is only real once everything was produced ─────────

    /// The crossing race is real, but it can only be real once the whole batch has
    /// actually gone out. A COMPLETE after a mere prefix is premature or forged,
    /// and treating it as deferred success would report a truncated transfer as
    /// delivered.
    func testAPrematureCompleteIsIgnoredAndARealOneIsStillAwaited() throws {
        let (session, codecs, _) = pair()
        let half = [UInt8](repeating: 1, count: C)
        let id = try session.enqueue(files: [meta("a.bin", 2 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(half))

        // Only half the file has been produced.
        XCTAssertEqual(session.admitFrame([RealtimeControl.complete.rawValue]), [])
        XCTAssertEqual(session.outboundBatch, id)

        // The rest goes out normally.
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(half))
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextDoneFrame(
                                hash: chainHash(chainHash([UInt8](repeating: 0, count: 32), half), half)))
        let finished = session.producerFinished(batch: id, attempt: attempt)
        XCTAssertEqual(session.outboundPhase, .finishing,
                       "the premature answer bought the batch nothing")
        XCTAssertTrue(finished.contains(.armCompleteTimeout(batch: id)),
                      "a real COMPLETE is still owed and still waited for")

        let real = session.admitFrame([RealtimeControl.complete.rawValue])
        XCTAssertTrue(real.contains(.cancelCompleteTimeout(batch: id)))
        XCTAssertNil(session.outboundBatch)
    }

    // ── identifier exhaustion is terminal, never a wedge ────────────────────

    /// The last usable id goes to the batch, leaving none for its attempt. A
    /// session that cannot name a producer cannot correlate anything it hands out,
    /// so it ends deterministically rather than silently refusing to pump for ever.
    func testAttemptIdentifierExhaustionRetiresTheSessionRatherThanWedgingIt() throws {
        let codecs = LinkCodecs(sendKey: [UInt8](repeating: 7, count: 32),
                                recvKey: [UInt8](repeating: 8, count: 32))
        let session = LinkFileSession(codecs: codecs, firstIdentifier: Int.max - 1)
        let id = try session.enqueue(files: [meta("a.bin", 64)])

        let effects = session.pump()
        XCTAssertTrue(effects.contains(.batchesFailed([id])),
                      "the work the user queued is named, not silently stranded")
        XCTAssertEqual(effects.suffix(2), [.poisonCodecs, .closeLane])
        XCTAssertTrue(session.laneFailed)
        XCTAssertEqual(session.failedBatchIds, [id])
        XCTAssertEqual(session.queuedBatchIds, [], "and nothing is left to pump for ever")
        XCTAssertEqual(session.pump(), [])
    }

    // ── the recoverable gap race ────────────────────────────────────────────

    /// The expected cancellation race: the transport died, the batch is parked to
    /// resume, and the producer hands back one frame it had already sealed. Its
    /// nonce may simply be dropped — the marker this generation still owes will
    /// read the shared sender's newer `nextSequence` and carry the peer across it.
    /// Poisoning here would let an ordinary race destroy the recovery.
    func testAFrameFromTheCurrentAttemptDuringAGapIsDroppedNotFatal() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(
                                [UInt8](repeating: 1, count: C)))
        let frontier = session.lane.producedFrontier

        _ = session.transportGap()
        XCTAssertEqual(session.outboundPhase, .resuming)
        let crossed = session.produced(batch: id, attempt: attempt,
                                       frame: try codecs.fileSender.nextChunkFrame(
                                        [UInt8](repeating: 2, count: 64)))
        XCTAssertEqual(crossed, [], "nothing goes out on a transport that is gone")
        XCTAssertFalse(session.laneFailed, "and an expected race must not destroy recovery")
        XCTAssertEqual(session.lane.producedFrontier, frontier,
                       "the dropped frame never claimed to have been produced")
        XCTAssertEqual(session.outboundBatch, id, "the batch is still there to resume")
    }

    /// The same frame arriving after the replacement attached but before this side
    /// has built its marker is the same case: the debt is still unpaid, so the
    /// announcement has not fixed a sequence yet.
    func testAFrameFromTheCurrentAttemptAfterAttachButBeforeTheMarkerIsDropped() throws {
        let (session, codecs, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", 4 * C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        _ = session.admitFrame([RealtimeControl.accept.rawValue])
        _ = session.produced(batch: id, attempt: attempt,
                             frame: try codecs.fileSender.nextChunkFrame(
                                [UInt8](repeating: 1, count: C)))
        _ = session.transportGap()
        _ = session.didAttachReplacementTransport()
        XCTAssertTrue(session.lane.outboundOwesResumeMarker, "no marker has been built yet")

        let crossed = session.produced(batch: id, attempt: attempt,
                                       frame: try codecs.fileSender.nextChunkFrame(
                                        [UInt8](repeating: 3, count: 64)))
        XCTAssertEqual(crossed, [])
        XCTAssertFalse(session.laneFailed)

        // And the recovery it preserved still works: the marker announces the
        // sender's CURRENT sequence, which is past everything that was dropped.
        let resumed = session.admitFrame(resumeReqFrame(index: 0, offset: C))
        let marker = try XCTUnwrap(sentFrames(resumed).first { $0.first == RealtimeKind.resumeStart })
        XCTAssertEqual(parseResumeStart(marker)?.seq, codecs.fileSender.nextSequence,
                       "the announcement carries the peer over every burned nonce")
    }

    // ── effects tell the truth about what exists ────────────────────────────

    /// `stopProducer` instructs a driver to stop something. A batch that never
    /// started one — or whose producer has already been released — must not be
    /// told to stop it again.
    func testCleanupOnlyStopsAProducerThatCouldStillBeRunning() throws {
        let (session, _, _) = pair()
        let id = try session.enqueue(files: [meta("a.bin", C)])
        _ = session.pump()
        let attempt = try XCTUnwrap(session.outboundAttempt)
        XCTAssertEqual(session.outboundPhase, .waitingAccept)

        let gap = session.transportGap()
        XCTAssertFalse(gap.effects.contains(.stopProducer(batch: id, attempt: attempt)),
                       "waiting for consent, no producer was ever started")

        // A batch already parked to resume has had its producer released once.
        let (other, _, _) = pair()
        let live = try other.enqueue(files: [meta("b.bin", 4 * C)])
        _ = other.pump()
        let liveAttempt = try XCTUnwrap(other.outboundAttempt)
        _ = other.admitFrame([RealtimeControl.accept.rawValue])
        let first = other.transportGap()
        XCTAssertTrue(first.effects.contains(.stopProducer(batch: live, attempt: liveAttempt)),
                      "a sending batch really does have one to stop")
        _ = other.didAttachReplacementTransport()
        let second = other.transportGap()   // a second gap before it ever resumed
        XCTAssertFalse(second.effects.contains(.stopProducer(batch: live, attempt: liveAttempt)),
                       "its producer was already released by the gap that parked it")
        XCTAssertEqual(other.outboundPhase, .resuming)
    }

    func testBothNativeSupportConstantsStayFalse() {
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)
    }
}
