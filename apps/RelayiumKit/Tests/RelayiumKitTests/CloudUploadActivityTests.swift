import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
import RelayiumShareKit

/// Collects activity snapshots from any thread.
final class ActivityLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(UploadActivity, UploadDiagnostics)] = []
    var all: [(UploadActivity, UploadDiagnostics)] { lock.lock(); defer { lock.unlock() }; return values }
    var activities: [UploadActivity] { all.map(\.0) }
    var final: UploadDiagnostics? { all.last?.1 }
    func record(_ a: UploadActivity, _ d: UploadDiagnostics) { lock.lock(); values.append((a, d)); lock.unlock() }
}

/// A clock a test moves by hand, so stage durations are exact.
final class ManualClock: @unchecked Sendable {
    private let lock = NSLock()
    private var nanos: UInt64 = 1_000_000_000
    var now: UInt64 { lock.lock(); defer { lock.unlock() }; return nanos }
    func advance(seconds: Double) { lock.lock(); nanos += UInt64(seconds * 1_000_000_000); lock.unlock() }
}

final class CloudUploadActivityTests: XCTestCase {
    private let key = [UInt8](repeating: 9, count: 32)

    private func uploader(_ server: ScriptedResumableServer, clock: ManualClock = ManualClock()) -> CloudUploader {
        let u = CloudUploader(transport: server)
        u.pacing.sleep = { _ in }
        u.pacing.now = { clock.now }
        return u
    }

    // MARK: - the uploader says what it is doing

    /// The ordinary path: open, send, wait for the server's answer, finalize,
    /// and one last snapshot carrying the outcome. Sequence numbers only grow.
    func testOrdinaryUploadWalksTheStagesInOrder() async throws {
        let server = ScriptedResumableServer()
        let log = ActivityLog()
        _ = try await uploader(server).upload(
            sources: [DataSource(name: "a", bytes: [UInt8](repeating: 1, count: 1000))],
            burnAfterRead: false, ttl: 3600, token: "tok",
            onActivity: { log.record($0, $1) }, onProgress: { _, _ in })
        XCTAssertEqual(log.activities.first, .openingSession)
        XCTAssertEqual(Array(log.activities.dropFirst().prefix(3)),
                       [.sending, .awaitingConfirmation, .finalizing])
        XCTAssertEqual(log.final?.outcome, .completed)
        let sequences = log.all.map(\.1.sequence)
        XCTAssertEqual(sequences, sequences.sorted())
        XCTAssertEqual(Set(sequences).count, sequences.count, "a sequence number repeated")
        XCTAssertEqual(log.final?.patchRequests, 1)
    }

    /// The trailing-closure spelling every existing caller uses still binds to
    /// `onProgress`, with no activity handler at all.
    func testExistingTrailingClosureCallersStillCompile() async throws {
        let server = ScriptedResumableServer()
        var last = 0
        _ = try await uploader(server).upload(
            sources: [DataSource(name: "a", bytes: [1, 2, 3])],
            burnAfterRead: false, ttl: 3600, token: "tok") { sent, _ in last = sent }
        XCTAssertEqual(last, server.stored.count)
    }

    /// A lost reply: the attempt says it is waiting for confirmation, checking
    /// the offset and recovering — and the diagnostics count exactly that.
    func testLostReplyIsVisibleAsWaitingThenCheckingThenRecovered() async throws {
        let server = ScriptedResumableServer()
        server.script = [.storeThenLoseReply]
        let log = ActivityLog()
        _ = try await uploader(server).resume(
            sources: [DataSource(name: "a", bytes: [UInt8](repeating: 3, count: 500))],
            key: key, uploadId: nil, uploadChunkSize: nil, purpose: .share,
            manifest: .storedWire, burnAfterRead: false, ttl: 3600, token: "tok",
            onUploadSession: { _, _ in }, onActivity: { log.record($0, $1) },
            onProgress: { _, _ in })
        let a = log.activities
        let waited = try XCTUnwrap(a.firstIndex(of: .awaitingConfirmation))
        let checked = try XCTUnwrap(a.firstIndex(of: .checkingOffset))
        let finalized = try XCTUnwrap(a.firstIndex(of: .finalizing))
        XCTAssertLessThan(waited, checked)
        XCTAssertLessThan(checked, finalized)
        let d = try XCTUnwrap(log.final)
        XCTAssertEqual(d.outcome, .completed)
        XCTAssertEqual(d.transportRetries, 1)
        XCTAssertEqual(d.lastTransportError, .network)
        XCTAssertEqual(d.offsetRecoveries, 1)
        XCTAssertEqual(d.patchRequests, 1, "the stored body was not sent again")
    }

    /// The bounded failure is classified as what it is, not as a generic
    /// network error, and its waits are visible as retrying.
    func testExhaustedNonAdvancingRunIsClassifiedInTheDiagnostics() async throws {
        let server = ScriptedResumableServer()
        server.script = Array(repeating: .acknowledgeNothing, count: 50)
        let log = ActivityLog()
        do {
            _ = try await uploader(server).upload(
                sources: [DataSource(name: "a", bytes: [UInt8](repeating: 1, count: 1000))],
                burnAfterRead: false, ttl: 3600, token: "tok",
                onActivity: { log.record($0, $1) }, onProgress: { _, _ in })
            XCTFail("expected a bounded failure")
        } catch {}
        let d = try XCTUnwrap(log.final)
        XCTAssertEqual(d.outcome, .failed(.nonAdvancingAcknowledgements))
        XCTAssertEqual(d.nonAdvancingAcknowledgements, 5)
        XCTAssertEqual(d.offsetQueries, 4)
        XCTAssertTrue(log.activities.contains(.waitingToRetry))
        XCTAssertEqual(server.finalizeCount, 0)
    }

    /// A five-minute wait for the server's answer is attributed to exactly that
    /// stage — the evidence the 56% report lacked.
    func testALongServerWaitIsAttributedToAwaitingConfirmation() async throws {
        let server = ScriptedResumableServer()
        let clock = ManualClock()
        server.duringPatch = { _ in clock.advance(seconds: 300) }
        let log = ActivityLog()
        _ = try await uploader(server, clock: clock).upload(
            sources: [DataSource(name: "a", bytes: [UInt8](repeating: 1, count: 1000))],
            burnAfterRead: false, ttl: 3600, token: "tok",
            onActivity: { log.record($0, $1) }, onProgress: { _, _ in })
        let d = try XCTUnwrap(log.final)
        XCTAssertEqual(d.longestStage, .awaitingConfirmation)
        XCTAssertEqual(d.longestStageSeconds, 300, accuracy: 0.001)
        XCTAssertEqual(d.stageSeconds[.awaitingConfirmation] ?? 0, 300, accuracy: 0.001)
        XCTAssertTrue(d.summary.contains("longest=awaitingConfirmation:300.000"), d.summary)
    }

    /// A cancellation is recorded as one, with no finalize.
    func testCancellationIsRecordedAsCancelled() async throws {
        let server = ScriptedResumableServer()
        let inFlight = expectation(description: "in flight")
        server.duringPatch = { _ in
            inFlight.fulfill()
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
        let log = ActivityLog()
        let u = uploader(server)
        let task = Task {
            try await u.upload(sources: [DataSource(name: "a", bytes: [1, 2, 3])],
                               burnAfterRead: false, ttl: 3600, token: "tok",
                               onActivity: { log.record($0, $1) }, onProgress: { _, _ in })
        }
        await fulfillment(of: [inFlight], timeout: 10)
        task.cancel()
        _ = try? await task.value
        XCTAssertEqual(log.final?.outcome, .failed(.cancelled))
        XCTAssertEqual(server.finalizeCount, 0)
    }

    // MARK: - diagnostics carry no identifiers

    /// Every snapshot, rendered every way it could reach a log, contains none
    /// of the values that identify a file, a session, an object or a person.
    func testDiagnosticsNeverContainIdentifiers() async throws {
        let server = ScriptedResumableServer()
        server.uploadId = "upSECRETSESSION42"
        server.finalizeResult = UploadResult(id: "objSECRETOBJECT77", expiresAt: 99)
        server.script = [.storeThenLoseReply, .acknowledgeNothing]
        let log = ActivityLog()
        let name = "Quarterly-SECRETFILENAME.zip"
        let out = try await uploader(server).upload(
            sources: [DataSource(name: name, bytes: [UInt8](repeating: 1, count: STORE_CHUNK_SIZE + 5))],
            burnAfterRead: false, ttl: 3600, token: "tokSECRETTOKEN",
            onActivity: { log.record($0, $1) }, onProgress: { _, _ in })
        let forbidden = ["SECRET", name, out.keyB64url, "tok", "\(server.stored.count)",
                         "\(STORE_CHUNK_SIZE + 5)", "https://", "/"]
        XCTAssertFalse(log.all.isEmpty)
        for (_, d) in log.all {
            for text in [d.summary, String(describing: d), String(reflecting: d)] {
                for f in forbidden where !f.isEmpty {
                    XCTAssertFalse(text.contains(f), "diagnostics leaked \(f): \(text)")
                }
            }
        }
    }

    // MARK: - the trace itself

    /// A delivery callback that arrives late — from a request that was already
    /// answered, or an earlier one — cannot relabel the current stage.
    func testLateBodySentCallbackIsIgnored() {
        let log = ActivityLog()
        let trace = UploadTrace(now: { 0 }, emit: { log.record($0, $1) })
        let first = trace.beginRequest()
        trace.enter(.checkingOffset)
        trace.bodySent(first)
        XCTAssertEqual(trace.snapshot.activity, .checkingOffset)
        let second = trace.beginRequest()
        trace.bodySent(first)
        XCTAssertEqual(trace.snapshot.activity, .sending, "a stale request's callback moved the stage")
        trace.bodySent(second)
        XCTAssertEqual(trace.snapshot.activity, .awaitingConfirmation)
    }

    func testNothingIsRecordedAfterTheAttemptEnds() async throws {
        let log = ActivityLog()
        let trace = UploadTrace(now: { 0 }, emit: { log.record($0, $1) })
        _ = try await trace.run { 1 }
        let count = log.all.count
        trace.enter(.sending)
        trace.count(\.patchRequests)
        XCTAssertEqual(log.all.count, count)
        XCTAssertEqual(trace.snapshot.patchRequests, 0)
        XCTAssertEqual(trace.snapshot.outcome, .completed)
    }

    // MARK: - presentation

    func testEveryActivityHasASentenceInBothLanguages() {
        XCTAssertNil(UploadPresentation.activityText(nil))
        for activity in UploadActivity.allCases {
            let en = UploadPresentation.activityText(activity, language: .en)
            let zh = UploadPresentation.activityText(activity, language: .zh)
            XCTAssertNotNil(en)
            XCTAssertNotNil(zh)
            XCTAssertNotEqual(en, zh, "\(activity) is untranslated")
            XCTAssertFalse(en?.hasPrefix("upload.") ?? true, "\(activity) fell back to its key")
            XCTAssertFalse(zh?.hasPrefix("upload.") ?? true, "\(activity) fell back to its key")
        }
        let sentences = UploadActivity.allCases.compactMap { UploadPresentation.activityText($0, language: .en) }
        XCTAssertEqual(Set(sentences).count, sentences.count, "two stages read the same")
    }

    /// The sentence for "sent, not yet confirmed" must say both halves.
    func testAwaitingConfirmationSaysSentAndNotYetConfirmed() throws {
        let en = try XCTUnwrap(UploadPresentation.activityText(.awaitingConfirmation, language: .en))
        XCTAssertTrue(en.contains("Sent"))
        XCTAssertTrue(en.contains("confirm"))
        let zh = try XCTUnwrap(UploadPresentation.activityText(.awaitingConfirmation, language: .zh))
        XCTAssertTrue(zh.contains("已发送"))
        XCTAssertTrue(zh.contains("确认"))
    }
}

// MARK: - the model

private final class ActivityModelTransport: ResumableTransport, @unchecked Sendable {
    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("u", 1 << 20)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        onBytesSent?(bytes.count)
        return .committed(received: to)
    }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "u", expiresAt: 1)
    }
}

@MainActor
final class CloudUploadModelActivityTests: XCTestCase {
    private func makeModel() -> CloudUploadModel {
        CloudUploadModel(uploader: CloudUploader(transport: ActivityModelTransport()),
                         keyStore: InMemoryStoredLinkKeyStore(),
                         origin: "https://relayium.com")
    }

    private func pickedModel() -> CloudUploadModel {
        let m = makeModel()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("activity-\(UUID().uuidString).bin")
        FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: 10))
        m.pick([url])
        return m
    }

    private func snapshot(_ activity: UploadActivity, sequence: Int,
                          outcome: UploadDiagnostics.Outcome = .inProgress) -> UploadDiagnostics {
        var d = UploadDiagnostics()
        d.activity = activity
        d.sequence = sequence
        d.outcome = outcome
        return d
    }

    /// Snapshots can hop to the main actor out of order; an older one never
    /// replaces a newer one.
    func testAStaleSnapshotIsIgnored() {
        let m = pickedModel()
        m.start(token: "tok")
        let g = m.currentGeneration
        m.reportActivity(.awaitingConfirmation, snapshot(.awaitingConfirmation, sequence: 5), g: g)
        m.reportActivity(.sending, snapshot(.sending, sequence: 3), g: g)
        XCTAssertEqual(m.uploadActivity, .awaitingConfirmation)
        XCTAssertEqual(m.lastUploadDiagnostics?.sequence, 5)
        m.cancel()
    }

    func testASupersededGenerationsSnapshotIsIgnored() {
        let m = pickedModel()
        let stale = m.currentGeneration
        m.cancel()
        m.reportActivity(.sending, snapshot(.sending, sequence: 1), g: stale)
        XCTAssertNil(m.uploadActivity)
        XCTAssertNil(m.lastUploadDiagnostics)
    }

    /// The final snapshot clears the activity; the diagnostics stay for a
    /// report.
    func testTheFinalSnapshotClearsTheActivity() {
        let m = pickedModel()
        m.start(token: "tok")
        let g = m.currentGeneration
        m.reportActivity(.finalizing, snapshot(.finalizing, sequence: 1), g: g)
        m.reportActivity(.finalizing, snapshot(.finalizing, sequence: 2, outcome: .completed), g: g)
        XCTAssertNil(m.uploadActivity)
        XCTAssertEqual(m.lastUploadDiagnostics?.outcome, .completed)
        m.cancel()
    }

    /// Lower progress of the same stream does not move the bar back.
    func testALateLowerProgressReportIsIgnored() {
        let m = pickedModel()
        m.start(token: "tok")
        let g = m.currentGeneration
        m.report(sent: 80, total: 100, g: g)
        m.report(sent: 40, total: 100, g: g)
        XCTAssertEqual(m.state, .uploading(sent: 80, total: 100))
        m.cancel()
    }

    /// A progress report that lost the race with the outcome cannot paint a
    /// bar over a finished link, and the activity is not shown there.
    func testProgressAfterTheOutcomeDoesNotResurrectTheBar() async {
        let m = pickedModel()
        let g = m.currentGeneration
        await m.applyOutcome(UploadOutcome(id: "x", expiresAt: 1, keyB64url: "K"))
        guard case .done = m.state else { return XCTFail("got \(m.state)") }
        m.report(sent: 10, total: 100, g: m.currentGeneration)
        m.reportActivity(.sending, snapshot(.sending, sequence: 1), g: m.currentGeneration)
        guard case .done = m.state else { return XCTFail("a late report repainted: \(m.state)") }
        XCTAssertNil(m.currentUploadActivity)
        _ = g
    }

    /// End to end through the real uploader: the model ends with the
    /// completed diagnostics and no activity left over.
    func testARealUploadLeavesCompletedDiagnosticsAndNoActivity() async throws {
        let m = pickedModel()
        m.start(token: "tok")
        for _ in 0..<500 {
            if case .done = m.state, m.lastUploadDiagnostics?.outcome == .completed { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        guard case .done = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(m.lastUploadDiagnostics?.outcome, .completed)
        XCTAssertNil(m.uploadActivity)
        XCTAssertNil(m.currentUploadActivity)
    }
}
