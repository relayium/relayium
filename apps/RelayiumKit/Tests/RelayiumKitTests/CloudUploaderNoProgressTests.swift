import XCTest
@testable import RelayiumKit

/// A resumable-upload server with the real one's offset rules
/// (`uploads_resumable.go` handleUploadChunk: a start behind the committed
/// offset is acknowledged at that offset, a start ahead is 409 with it), plus
/// scripted misbehaviour for the paths under test.
///
/// Every PATCH past `patchLimit` trips a guard that is NOT a `CloudError`, so a
/// loop that never ends — the defect these tests exist for — fails fast with a
/// named assertion instead of replaying gigabytes or hanging the suite.
final class ScriptedResumableServer: ResumableTransport, @unchecked Sendable {
    enum Answer {
        /// What the real server does.
        case normal
        /// 200 naming the request's own start; nothing stored.
        case acknowledgeNothing
        /// 409 naming the request's own start; nothing stored.
        case conflictNothing
        /// Stores the body, then the reply is lost.
        case storeThenLoseReply
        /// Stores the body, but answers 200 at the request's start (a stale
        /// answer to a request that did land).
        case storeButAnswerStale
        /// Stores this many bytes of the body and says so.
        case partial(Int)
        /// Stores this many bytes of the body and answers 409 at the new
        /// offset — a legitimate "server ahead of where you started".
        case partialConflict(Int)
        /// Stores nothing and answers exactly this.
        case raw(PatchOutcome)
        case fail(CloudError)
    }

    struct GuardTripped: Error {}

    var chunkSize = 64 * 1024
    var patchLimit = 80
    var script: [Answer] = []
    /// Answers for offset reads, consumed in order; then the stored count.
    var offsetAnswers: [Result<Int, Error>] = []
    /// When set, offset reads answer this many bytes past the end of the last
    /// PATCH — an offset just beyond anything the client holds.
    var offsetPastLastPatch: Int?
    var reportsBytesSent = true
    /// Runs inside every PATCH after its bytes are reported sent, with the
    /// 1-based PATCH number. Lets a test block or cancel mid-request.
    var duringPatch: ((Int) async throws -> Void)?
    var uploadId = "up1"
    var finalizeResult = UploadResult(id: "fid", expiresAt: 4242)

    private(set) var stored: [UInt8] = []
    private(set) var patches: [(from: Int, count: Int)] = []
    private(set) var offsetReads = 0
    private(set) var finalizeCount = 0
    private(set) var guardTripped = false

    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        (uploadId, chunkSize)
    }

    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        guard patches.count < patchLimit else {
            guardTripped = true
            throw GuardTripped()
        }
        patches.append((from, bytes.count))
        if reportsBytesSent { onBytesSent?(bytes.count) }
        try await duringPatch?(patches.count)
        let answer = script.isEmpty ? .normal : script.removeFirst()
        switch answer {
        case .normal:
            return append(bytes, from: from)
        case .acknowledgeNothing:
            return .committed(received: from)
        case .conflictNothing:
            return .serverAhead(received: from)
        case .storeThenLoseReply:
            _ = append(bytes, from: from)
            throw CloudError.network
        case .storeButAnswerStale:
            _ = append(bytes, from: from)
            return .committed(received: from)
        case .partial(let n):
            if from == stored.count { stored += [UInt8](bytes.prefix(n)) }
            return .committed(received: stored.count)
        case .partialConflict(let n):
            if from == stored.count { stored += [UInt8](bytes.prefix(n)) }
            return .serverAhead(received: stored.count)
        case .raw(let outcome):
            return outcome
        case .fail(let e):
            throw e
        }
    }

    private func append(_ bytes: Data, from: Int) -> PatchOutcome {
        if from < stored.count { return .committed(received: stored.count) }
        if from > stored.count { return .serverAhead(received: stored.count) }
        stored += [UInt8](bytes)
        return .committed(received: stored.count)
    }

    func uploadOffset(uploadId: String, token: String) async throws -> Int {
        offsetReads += 1
        if let past = offsetPastLastPatch, let last = patches.last { return last.from + last.count + past }
        if !offsetAnswers.isEmpty { return try offsetAnswers.removeFirst().get() }
        return stored.count
    }

    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        finalizeCount += 1
        return finalizeResult
    }

    /// Bytes handed over in total, across every PATCH.
    var bytesSent: Int { patches.reduce(0) { $0 + $1.count } }
}

/// Records the waits the uploader asked for, and never waits.
final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Double] = []
    var waits: [Double] { lock.lock(); defer { lock.unlock() }; return values }
    func record(_ s: Double) { lock.lock(); values.append(s); lock.unlock() }
}

/// Collects progress reports from any thread.
final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int] = []
    var sent: [Int] { lock.lock(); defer { lock.unlock() }; return values }
    func record(_ n: Int) { lock.lock(); values.append(n); lock.unlock() }

    /// The first report that went below an earlier one, if any.
    var firstRegression: (before: Int, after: Int)? {
        let v = sent
        var high = Int.min
        for n in v {
            if n < high { return (high, n) }
            high = max(high, n)
        }
        return nil
    }
}

final class CloudUploaderNoProgressTests: XCTestCase {
    private let key = [UInt8](repeating: 7, count: 32)

    private func sources(_ size: Int = STORE_CHUNK_SIZE * 3 + 11) -> [PlaintextSource] {
        [DataSource(name: "f", bytes: (0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31) })]
    }

    private func uploader(_ server: ScriptedResumableServer, sleeps: SleepRecorder = SleepRecorder()) -> CloudUploader {
        let u = CloudUploader(transport: server)
        u.pacing.sleep = { sleeps.record($0) }
        return u
    }

    /// A fresh session through `resume`, so the key — and therefore the
    /// ciphertext — is the test's own and comparable byte for byte.
    @discardableResult
    private func send(_ u: CloudUploader, progress: ProgressLog = ProgressLog(),
                      size: Int = STORE_CHUNK_SIZE * 3 + 11) async throws -> UploadOutcome {
        try await u.resume(sources: sources(size), key: key, uploadId: nil, uploadChunkSize: nil,
                           purpose: .share, manifest: .storedWire, burnAfterRead: false,
                           ttl: 3600, token: "tok", onUploadSession: { _, _ in },
                           onProgress: { sent, _ in progress.record(sent) })
    }

    /// What a server that never misbehaves ends up holding.
    private func referenceCiphertext(size: Int = STORE_CHUNK_SIZE * 3 + 11) async throws -> [UInt8] {
        let server = ScriptedResumableServer()
        try await send(uploader(server), size: size)
        return server.stored
    }

    private func assertNoGuard(_ server: ScriptedResumableServer,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(server.guardTripped,
                       "the PATCH loop ran past \(server.patchLimit) requests — unbounded",
                       file: file, line: line)
    }

    // MARK: - non-advancing acknowledgements are bounded

    /// Five 200s in a row that each name the offset the request started at:
    /// a bounded error, no finalize, no unbounded resend, and nothing waited
    /// beyond the documented schedule.
    func testFiveNonAdvancingAcknowledgementsEndInABoundedErrorWithoutFinalize() async throws {
        let server = ScriptedResumableServer()
        server.script = Array(repeating: .acknowledgeNothing, count: 200)
        let sleeps = SleepRecorder()
        let progress = ProgressLog()
        do {
            try await send(uploader(server, sleeps: sleeps), progress: progress)
            XCTFail("an upload whose every answer acknowledged nothing reported success")
        } catch let e as CloudError {
            XCTAssertEqual(e, .network)
        } catch {
            XCTFail("expected a bounded CloudError.network, got \(error)")
        }
        assertNoGuard(server)
        XCTAssertEqual(server.patches.count, 5, "exactly the bounded number of empty answers")
        XCTAssertTrue(server.patches.allSatisfy { $0.from == 0 })
        XCTAssertEqual(server.finalizeCount, 0, "incomplete ciphertext must never be finalized")
        XCTAssertEqual(server.offsetReads, 4, "one offset read before each resend")
        XCTAssertEqual(sleeps.waits, [0.5, 1.0, 1.5, 2.0])
        XCTAssertNil(progress.firstRegression, "progress went backwards: \(progress.sent)")
    }

    /// The same bound for 409 at the request's own start, mid-upload: what the
    /// server already committed stays committed and the bar never falls below
    /// it.
    func testNonAdvancingConflictIsBoundedAndKeepsEarlierCommits() async throws {
        let server = ScriptedResumableServer()
        server.script = [.normal] + Array(repeating: .conflictNothing, count: 200)
        let progress = ProgressLog()
        do {
            try await send(uploader(server), progress: progress)
            XCTFail("expected a bounded failure")
        } catch let e as CloudError {
            XCTAssertEqual(e, .network)
        } catch {
            XCTFail("expected a bounded CloudError.network, got \(error)")
        }
        assertNoGuard(server)
        let firstChunk = server.patches[0].count
        XCTAssertEqual(server.stored.count, firstChunk, "the first chunk's commit was kept")
        XCTAssertEqual(server.patches.count, 1 + 5)
        XCTAssertTrue(server.patches.dropFirst().allSatisfy { $0.from == firstChunk },
                      "every resend starts where the server stopped")
        XCTAssertEqual(server.finalizeCount, 0)
        XCTAssertNil(progress.firstRegression, "progress went backwards: \(progress.sent)")
        XCTAssertGreaterThanOrEqual(progress.sent.last ?? 0, firstChunk)
    }

    /// One empty answer at offset zero is an ordinary race, not a failure: the
    /// upload carries on and completes with the exact ciphertext.
    func testASingleNonAdvancingAnswerAtZeroStillCompletes() async throws {
        let reference = try await referenceCiphertext()
        let server = ScriptedResumableServer()
        server.script = [.acknowledgeNothing]
        let out = try await send(uploader(server))
        assertNoGuard(server)
        XCTAssertEqual(out.id, "fid")
        XCTAssertEqual(server.stored, reference)
        XCTAssertEqual(server.finalizeCount, 1)
    }

    /// The bound counts CONSECUTIVE empty answers. Real progress in between —
    /// here a genuine partial commit — resets it, and the upload completes
    /// byte-identical with every partial commit honoured.
    func testRealProgressResetsTheBound() async throws {
        let reference = try await referenceCiphertext()
        let server = ScriptedResumableServer()
        server.script = Array(repeating: .acknowledgeNothing, count: 4)
            + [.partial(1000)]
            + Array(repeating: .conflictNothing, count: 4)
            + [.partial(5)]
            + Array(repeating: .acknowledgeNothing, count: 4)
        try await send(uploader(server))
        assertNoGuard(server)
        XCTAssertEqual(server.stored, reference)
        XCTAssertEqual(server.finalizeCount, 1)
    }

    // MARK: - lost acknowledgements recover without sending the body twice

    /// The reply to a PATCH that landed is lost: the offset read finds the
    /// bytes stored, so they are not sent again.
    func testLostReplyIsRecoveredFromTheOffsetWithoutResendingTheBody() async throws {
        let reference = try await referenceCiphertext()
        let server = ScriptedResumableServer()
        server.script = [.normal, .storeThenLoseReply]
        try await send(uploader(server))
        assertNoGuard(server)
        XCTAssertEqual(server.stored, reference)
        XCTAssertEqual(server.bytesSent, reference.count, "no byte was sent twice")
        XCTAssertEqual(server.finalizeCount, 1)
    }

    /// A stale answer to a PATCH that did land: the stall path's offset read
    /// sees the stored bytes and moves on instead of resending the chunk.
    func testStaleAcknowledgementIsRecoveredWithoutResendingTheBody() async throws {
        let reference = try await referenceCiphertext()
        let server = ScriptedResumableServer()
        server.script = [.storeButAnswerStale]
        try await send(uploader(server))
        assertNoGuard(server)
        XCTAssertEqual(server.stored, reference)
        XCTAssertEqual(server.bytesSent, reference.count,
                       "the stored chunk was sent again after a stale answer")
        XCTAssertEqual(server.finalizeCount, 1)
    }

    // MARK: - offsets that cannot be placed stay refused

    func testAcknowledgementPastTheHeldBytesIsRefused() async throws {
        let server = ScriptedResumableServer()
        server.script = [.raw(.committed(received: 10_000_000))]
        await assertMisaligned(server)
    }

    func testConflictBehindTheHeldBytesIsRefused() async throws {
        let server = ScriptedResumableServer()
        // After the first chunk commits, the server claims an offset before it.
        server.script = [.normal, .raw(.serverAhead(received: 3))]
        await assertMisaligned(server)
    }

    /// Refused at the read itself: not one more PATCH leaves after an offset
    /// that cannot be placed — before the held bytes, just past them, or far
    /// past the stream.
    func testOffsetReadOutsideTheHeldBytesAfterAnEmptyAnswerIsRefused() async throws {
        for bad in [-1, 10_000_000] {
            let server = ScriptedResumableServer()
            server.script = [.acknowledgeNothing]
            server.offsetAnswers = [.success(bad)]
            await assertMisaligned(server)
            XCTAssertEqual(server.patches.count, 1, "a PATCH followed the unplaceable offset \(bad)")
        }
        let server = ScriptedResumableServer()
        server.script = [.acknowledgeNothing]
        server.offsetPastLastPatch = 10
        await assertMisaligned(server)
        XCTAssertEqual(server.patches.count, 1, "a PATCH followed an offset past the held bytes")
    }

    /// A legitimate 409 ahead of the request start (inside the held bytes) is
    /// still followed, and the upload completes.
    func testServerAheadInsideTheHeldBytesIsFollowed() async throws {
        let reference = try await referenceCiphertext()
        let server = ScriptedResumableServer()
        // Part of the first PATCH lands and the server answers 409 naming
        // that point: the client replays the tail from there.
        server.script = [.partialConflict(4096)]
        try await send(uploader(server))
        assertNoGuard(server)
        XCTAssertEqual(server.stored, reference)
        XCTAssertEqual(server.finalizeCount, 1)
    }

    private func assertMisaligned(_ server: ScriptedResumableServer,
                                  file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await send(uploader(server))
            XCTFail("a misplaced offset was accepted", file: file, line: line)
        } catch let e as CloudError {
            XCTAssertEqual(e, .server(status: 0), file: file, line: line)
        } catch {
            XCTFail("expected CloudError.server(status: 0), got \(error)", file: file, line: line)
        }
        assertNoGuard(server, file: file, line: line)
        XCTAssertEqual(server.finalizeCount, 0, file: file, line: line)
    }

    // MARK: - cancellation

    /// Cancelled while waiting to resend after an empty answer: it ends at once
    /// as a cancellation, sends nothing more and finalizes nothing.
    func testCancelledDuringTheBackoffEndsPromptly() async throws {
        let server = ScriptedResumableServer()
        server.script = Array(repeating: .acknowledgeNothing, count: 200)
        let u = CloudUploader(transport: server)
        let waiting = expectation(description: "backoff began")
        let flag = SleepRecorder()
        u.pacing.sleep = { seconds in
            flag.record(seconds)
            waiting.fulfill()
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
        let task = Task { try await self.send(u) }
        await fulfillment(of: [waiting], timeout: 10)
        let patchesAtCancel = server.patches.count
        let started = Date()
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled upload reported success")
        } catch is CancellationError {
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "cancellation waited out the backoff")
        XCTAssertEqual(server.patches.count, patchesAtCancel, "a PATCH left after cancellation")
        XCTAssertEqual(server.finalizeCount, 0)
        XCTAssertEqual(flag.waits.count, 1)
    }

    /// Cancelled while a PATCH is in flight: same rule.
    func testCancelledDuringARequestEndsWithoutFinalize() async throws {
        let server = ScriptedResumableServer()
        let inFlight = expectation(description: "patch in flight")
        server.duringPatch = { n in
            guard n == 2 else { return }
            inFlight.fulfill()
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
        let u = uploader(server)
        let task = Task { try await self.send(u) }
        await fulfillment(of: [inFlight], timeout: 10)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled upload reported success")
        } catch is CancellationError {
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
        XCTAssertEqual(server.patches.count, 2)
        XCTAssertEqual(server.finalizeCount, 0)
    }

    // MARK: - the bar never goes backwards

    /// Every byte of a chunk was reported leaving, then the server committed
    /// only part of it. The bar holds; the replay continues from the commit.
    func testPartialCommitAfterTheWholeChunkWasSentDoesNotMoveTheBarBack() async throws {
        let reference = try await referenceCiphertext()
        let server = ScriptedResumableServer()
        server.script = [.normal, .partial(100)]
        let progress = ProgressLog()
        try await send(uploader(server), progress: progress)
        assertNoGuard(server)
        XCTAssertNil(progress.firstRegression, "progress went backwards: \(progress.sent)")
        XCTAssertEqual(progress.sent.last, reference.count)
        XCTAssertEqual(server.stored, reference)
    }
}
