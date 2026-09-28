import XCTest
@testable import RelayiumKit

/// `CloudUploader.resumeRecoverable`: the Device Inbox's upload, where a lost
/// finalize answer must never become a second object.
///
/// Every case drives the real uploader against a scripted transport and asserts
/// on what LEFT: how many sessions were opened, which bytes were PATCHed, how
/// many finalize requests were sent and — for the durable phase — whether the
/// caller's record was written before each one.
final class CloudUploaderRecoverableTests: XCTestCase {

    /// A transport that scripts every answer and records every request, in one
    /// ordered log shared with the caller's durable-phase callbacks.
    final class ScriptedTransport: ResumableTransport, @unchecked Sendable {
        enum Event: Equatable {
            case status(String), initSession, patch(String, from: Int, count: Int)
            case finalize(String), phase(String), session(String)
        }
        var log: [Event] = []
        var chunkSize = 64 * 1024
        var nextId = 0
        var sessions: [String: Int] = [:]          // id → committed bytes; absent = 404
        var headers: [[UInt8]] = []
        var patchBodies: [String: [UInt8]] = [:]
        var answers: [Result<FinalizeAnswer, Error>] = []
        var defaultAnswer: Result<FinalizeAnswer, Error> =
            .success(.completed(UploadResult(id: "STORED0123456789", expiresAt: 4242), recovered: false))
        /// Called after a PATCH is recorded, before its answer: lets a test
        /// interleave another actor (a delayed earlier finalize) at that point.
        var onPatch: ((String) -> Void)?

        func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            log.append(.initSession)
            headers.append(header)
            nextId += 1
            let id = String(format: "SESSION%09d", nextId)
            sessions[id] = 0
            return (id, chunkSize)
        }

        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int,
                        token: String, onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            log.append(.patch(uploadId, from: from, count: bytes.count))
            onPatch?(uploadId)
            guard let committed = sessions[uploadId] else { throw CloudError.notFound }
            guard from == committed else { return .serverAhead(received: committed) }
            patchBodies[uploadId, default: []] += [UInt8](bytes)
            sessions[uploadId] = committed + bytes.count
            return .committed(received: committed + bytes.count)
        }

        func uploadOffset(uploadId: String, token: String) async throws -> Int {
            log.append(.status(uploadId))
            guard let committed = sessions[uploadId] else { throw CloudError.notFound }
            return committed
        }

        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            XCTFail("a delivery must never use the share path's plain finalize")
            throw CloudError.server(status: 0)
        }

        func finalizeUploadRecovering(uploadId: String, token: String) async throws -> FinalizeAnswer {
            log.append(.finalize(uploadId))
            let next = answers.isEmpty ? defaultAnswer : answers.removeFirst()
            if case .success(.completed) = next { sessions[uploadId] = nil }   // done → status 404
            return try next.get()
        }

        var inits: Int { log.filter { $0 == .initSession }.count }
        var finalizes: Int { log.filter { if case .finalize = $0 { return true }; return false }.count }
        var patches: Int { log.filter { if case .patch = $0 { return true }; return false }.count }
    }

    private let key = [UInt8](repeating: 0x42, count: 32)
    private let manifest = UploadManifest.sealed(Array("{\"v\":2}".utf8))
    private var transport: ScriptedTransport!
    private var waits: [TimeInterval] = []

    override func setUp() {
        transport = ScriptedTransport()
        waits = []
    }

    private func sources(_ size: Int = 200_000) -> [PlaintextSource] {
        [DataSource(name: "a.bin", bytes: (0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31) })]
    }

    private var total: Int { cipherSizeFor([200_000]) }

    private func policy() -> FinalizeRecoveryPolicy {
        var p = FinalizeRecoveryPolicy()
        let box = WaitBox()
        p.sleep = { box.record($0) }
        waitBox = box
        return p
    }
    private var waitBox: WaitBox?
    final class WaitBox: @unchecked Sendable {
        private let lock = NSLock()
        private(set) var waits: [TimeInterval] = []
        func record(_ t: TimeInterval) { lock.withLock { waits.append(t) } }
    }

    /// Run one attempt. `phaseFails(n)` makes the n-th phase write throw.
    private func run(session: DeliverySession?, sources src: [PlaintextSource]? = nil,
                     policy p: FinalizeRecoveryPolicy? = nil,
                     phaseFails: @escaping (Int) -> Bool = { _ in false }) async throws -> RecoveredUpload {
        let uploader = CloudUploader(transport: transport)
        var phaseWrites = 0
        return try await uploader.resumeRecoverable(
            sources: src ?? sources(), key: key, session: session, purpose: .deviceTask,
            manifest: manifest, ttl: 86_400, token: "bearer", policy: p ?? policy(),
            onUploadSession: { [transport] id, _ in transport!.log.append(.session(id)) },
            onFinalizing: { [transport] id in
                phaseWrites += 1
                if phaseFails(phaseWrites) { throw CocoaError(.fileWriteNoPermission) }
                transport!.log.append(.phase(id))
            },
            onProgress: { _, _ in })
    }

    private func thrown(_ body: () async throws -> RecoveredUpload) async -> Error? {
        do { _ = try await body(); return nil } catch { return error }
    }

    // MARK: - the wire contract

    func testTheRecoveryAnswerParserAcceptsOnlyTheClosedSet() {
        let ok = Data(#"{"id":"STORED0123456789","expiresAt":9,"recovered":true}"#.utf8)
        XCTAssertEqual(finalizeAnswer(status: 200, body: ok, retryAfter: nil),
                       .completed(UploadResult(id: "STORED0123456789", expiresAt: 9), recovered: true))
        XCTAssertEqual(finalizeAnswer(status: 200, body: Data(#"{"id":"S","expiresAt":9}"#.utf8), retryAfter: nil),
                       .completed(UploadResult(id: "S", expiresAt: 9), recovered: false))
        for o in ["failed", "expired", "removed"] {
            let body = Data("{\"error\":\"already_finalized\",\"outcome\":\"\(o)\"}".utf8)
            XCTAssertEqual(finalizeAnswer(status: 409, body: body, retryAfter: nil),
                           .notCompleted(FinalizeOutcome(rawValue: o)!))
        }
        let running = Data(#"{"error":"already_finalized","outcome":"running"}"#.utf8)
        XCTAssertEqual(finalizeAnswer(status: 409, body: running, retryAfter: "5"), .running(retryAfter: 5))
        XCTAssertEqual(finalizeAnswer(status: 409, body: running, retryAfter: "soon"), .running(retryAfter: nil))
        // A server without recovery, and an outcome this build does not know,
        // say nothing about the object.
        XCTAssertEqual(finalizeAnswer(status: 409, body: Data("already finalized\n".utf8), retryAfter: nil),
                       .unconfirmedConflict)
        XCTAssertEqual(finalizeAnswer(status: 409, body: Data(#"{"error":"already_finalized","outcome":"archived"}"#.utf8),
                                      retryAfter: nil), .unconfirmedConflict)
        XCTAssertNil(finalizeAnswer(status: 200, body: Data("nope".utf8), retryAfter: nil))
    }

    func testTheHTTPTransportSendsTheOptInAsJSONAndMapsA404() async throws {
        StubURLProtocol.reset()
        let transport = HTTPResumableTransport(baseURL: URL(string: "https://relayium.test")!,
                                               session: StubURLProtocol.session())
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"id":"STORED0123456789","expiresAt":7,"recovered":true}"#.utf8))
        let answer = try await transport.finalizeUploadRecovering(uploadId: "UPLOAD0000000001", token: "t")
        XCTAssertEqual(answer, .completed(UploadResult(id: "STORED0123456789", expiresAt: 7), recovered: true))
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/uploads/UPLOAD0000000001/finalize")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(StubURLProtocol.bodyJSON(request)?["recoverFinalized"] as? Bool, true)

        StubURLProtocol.stub = .init(status: 404, body: Data("not found\n".utf8))
        do {
            _ = try await transport.finalizeUploadRecovering(uploadId: "UPLOAD0000000001", token: "t")
            XCTFail("a 404 must surface as notFound")
        } catch {
            XCTAssertEqual(error as? CloudError, .notFound)
        }
        StubURLProtocol.stub = nil
    }

    /// A conformer that never implemented the requirement fails closed.
    func testATransportWithoutTheRequirementNeverInventsAnObject() async {
        struct Bare: ResumableTransport {
            func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                            size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) { ("U", 1) }
            func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int, token: String,
                            onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome { .committed(received: to) }
            func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
            func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
                UploadResult(id: "X", expiresAt: 1)
            }
        }
        do {
            _ = try await Bare().finalizeUploadRecovering(uploadId: "U", token: "t")
            XCTFail("the default must throw")
        } catch {
            XCTAssertEqual(error as? CloudError, .server(status: 0))
        }
    }

    // MARK: - a first upload

    func testAFirstUploadRecordsTheSessionAndThePhaseBeforeTheOneFinalize() async throws {
        let result = try await run(session: nil)
        XCTAssertEqual(result.id, "STORED0123456789")
        XCTAssertEqual(result.uploadId, "SESSION000000001")
        XCTAssertFalse(result.recovered)
        XCTAssertEqual(transport.inits, 1)
        XCTAssertEqual(transport.finalizes, 1)
        let session = try XCTUnwrap(transport.log.firstIndex(of: .session("SESSION000000001")))
        let firstPatch = try XCTUnwrap(transport.log.firstIndex { if case .patch = $0 { return true }; return false })
        let phase = try XCTUnwrap(transport.log.firstIndex(of: .phase("SESSION000000001")))
        let post = try XCTUnwrap(transport.log.firstIndex(of: .finalize("SESSION000000001")))
        XCTAssertLessThan(session, firstPatch, "the session must be durable before any byte")
        XCTAssertLessThan(phase, post, "the finalizing phase must be durable before the request")
    }

    func testAPhaseWriteFailureSendsNoFinalize() async throws {
        let error = await thrown { try await self.run(session: nil, phaseFails: { _ in true }) }
        XCTAssertEqual(error as? DeliveryUploadError, .finalizeStateNotRecorded)
        XCTAssertEqual(transport.finalizes, 0, "a finalize left without its durable phase")
    }

    func testAShareOrAStoredWireManifestIsRefusedBeforeAnyRequest() async throws {
        let uploader = CloudUploader(transport: transport)
        for (purpose, manifest) in [(UploadPurpose.share, UploadManifest.storedWire),
                                    (.deviceTask, .storedWire), (.share, manifest)] {
            do {
                _ = try await uploader.resumeRecoverable(
                    sources: sources(), key: key, session: nil, purpose: purpose, manifest: manifest,
                    ttl: 86_400, token: "t", onUploadSession: { _, _ in }, onFinalizing: { _ in },
                    onProgress: { _, _ in })
                XCTFail("\(purpose) with \(manifest) was accepted")
            } catch {
                XCTAssertEqual(error as? StoredWireError, .invalidManifest)
            }
        }
        XCTAssertEqual(transport.log, [])
    }

    // MARK: - a recorded session

    /// The ONE re-init: a session this sender opened, reaped before any
    /// finalize. Same key, same manifest ⇒ byte-identical ciphertext.
    func testATrustedSessionReapedBeforeAnyFinalizeReinitsWithIdenticalBytes() async throws {
        _ = try await run(session: nil)                          // reference stream
        let reference = transport.patchBodies["SESSION000000001"]
        let referenceHeader = transport.headers[0]
        transport = ScriptedTransport()
        transport.nextId = 7
        let result = try await run(session: DeliverySession(uploadId: "GONE000000000001", chunkSize: 64 * 1024,
                                                            provenance: .trustedUploading))
        XCTAssertEqual(transport.inits, 1)
        XCTAssertEqual(result.uploadId, "SESSION000000008")
        XCTAssertEqual(transport.headers, [referenceHeader], "frame 0 differs: a nonce sealed new plaintext")
        XCTAssertEqual(transport.patchBodies["SESSION000000008"], reference,
                       "the replacement ciphertext differs from the first")
    }

    func testATrustedOpenSessionContinuesFromTheServersOffset() async throws {
        transport.sessions["SESSION000000009"] = 64 * 1024
        _ = try await run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                   provenance: .trustedUploading))
        XCTAssertEqual(transport.inits, 0)
        guard case .patch(_, let from, _) = transport.log[1] else { return XCTFail("no PATCH") }
        XCTAssertEqual(from, 64 * 1024)
    }

    /// A marked session never PATCHes, even when status says it is open: every
    /// byte was acknowledged before the mark, and an earlier finalize may still
    /// be in flight.
    func testAFinalizingSessionNeverPatchesAndOnlyRetriesTheFinalize() async throws {
        transport.sessions["SESSION000000009"] = total
        let result = try await run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                            provenance: .finalizing))
        XCTAssertEqual(result.uploadId, "SESSION000000009")
        XCTAssertEqual(transport.patches, 0)
        XCTAssertEqual(transport.inits, 0)
        XCTAssertEqual(transport.log, [.status("SESSION000000009"), .phase("SESSION000000009"),
                                       .finalize("SESSION000000009")])
    }

    func testAFinalizingSessionWhoseBytesDisagreeStopsWithoutARequest() async throws {
        transport.sessions["SESSION000000009"] = 10
        let error = await thrown {
            try await self.run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                        provenance: .finalizing))
        }
        XCTAssertEqual(error as? DeliveryUploadError, .inconsistentSession)
        XCTAssertEqual(transport.patches + transport.finalizes + transport.inits, 0)
    }

    /// Lost answer, record still there: the probe recovers the SAME object.
    func testAFinalizingSessionThatIsGoneIsRecoveredNotReuploaded() async throws {
        transport.answers = [.success(.completed(UploadResult(id: "STORED0123456789", expiresAt: 9),
                                                 recovered: true))]
        let result = try await run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                            provenance: .finalizing))
        XCTAssertTrue(result.recovered)
        XCTAssertEqual(transport.inits, 0)
        XCTAssertEqual(transport.patches, 0)
    }

    /// Every doubt after a possibly-sent finalize ends unconfirmed, never in a
    /// second session — for each provenance that is not trusted-uploading.
    func testNoUncertainAnswerEverReinitializes() async throws {
        let cases: [(Result<FinalizeAnswer, Error>, DeliveryUnconfirmedReason)] = [
            (.failure(CloudError.notFound), .notFound),
            (.success(.unconfirmedConflict), .unrecognizedConflict),
            (.failure(CloudError.unauthorized), .refusedAfterSend),
            (.failure(CloudError.dailyQuota), .refusedAfterSend),
            (.failure(CloudError.server(status: 403)), .refusedAfterSend),
        ]
        for provenance in [DeliverySessionProvenance.finalizing, .unproven] {
            for (answer, reason) in cases {
                transport = ScriptedTransport()
                transport.answers = [answer]
                let error = await thrown {
                    try await self.run(session: DeliverySession(uploadId: "SESSION000000009",
                                                                chunkSize: 64 * 1024, provenance: provenance))
                }
                XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(reason), "\(provenance) \(answer)")
                XCTAssertEqual(transport.inits, 0, "\(provenance) \(answer) re-initialized")
                XCTAssertEqual(transport.patches, 0)
            }
        }
    }

    func testClosedOutcomesAreTerminalAndNeverReinit() async throws {
        for outcome in [FinalizeOutcome.failed, .expired, .removed] {
            transport = ScriptedTransport()
            transport.answers = [.success(.notCompleted(outcome))]
            let error = await thrown {
                try await self.run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                            provenance: .unproven))
            }
            XCTAssertEqual(error as? DeliveryUploadError, .notCompleted(outcome))
            XCTAssertEqual(transport.inits, 0)
        }
    }

    /// Unproven + 404: the phase is written BEFORE the probe, because an
    /// opted-in finalize of an open session is a real finalize.
    func testAnUnprovenGoneSessionIsMarkedBeforeItsProbeAndNeverReinit() async throws {
        transport.answers = [.failure(CloudError.notFound)]
        let error = await thrown {
            try await self.run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                        provenance: .unproven))
        }
        XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(.notFound))
        XCTAssertEqual(transport.log, [.status("SESSION000000009"), .phase("SESSION000000009"),
                                       .finalize("SESSION000000009")])
    }

    /// Correction 1: an unproven open session may continue its bytes, but an
    /// EARLIER build's finalize may still be in flight. Here it lands between
    /// our status read and our PATCH (claiming the incomplete session). The
    /// attempt fails; the next one probes and gets `failed` — never a re-init.
    func testADelayedEarlierFinalizeInterleavedWithAnUnprovenContinuationNeverReinits() async throws {
        transport.sessions["SESSION000000009"] = 64 * 1024
        transport.onPatch = { [transport] id in transport!.sessions[id] = nil }   // the old finalize claims it
        let session = DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024, provenance: .unproven)
        let first = await thrown { try await self.run(session: session) }
        XCTAssertNotNil(first)
        XCTAssertEqual(transport.inits, 0)
        XCTAssertEqual(transport.finalizes, 0, "a finalize followed a failed continuation")

        transport.onPatch = nil
        transport.answers = [.success(.notCompleted(.failed))]
        let second = await thrown { try await self.run(session: session) }
        XCTAssertEqual(second as? DeliveryUploadError, .notCompleted(.failed))
        XCTAssertEqual(transport.inits, 0, "an unproven session was re-initialized")
    }

    /// The same race, where the earlier finalize was of a COMPLETE session and
    /// won: our finalize reads its record back. One object.
    func testADelayedEarlierFinalizeOfACompleteUnprovenSessionIsRecovered() async throws {
        transport.sessions["SESSION000000009"] = total
        transport.answers = [.success(.completed(UploadResult(id: "STORED0123456789", expiresAt: 9),
                                                 recovered: true))]
        let result = try await run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                            provenance: .unproven))
        XCTAssertTrue(result.recovered)
        XCTAssertEqual(transport.patches, 0)
        XCTAssertEqual(transport.inits, 0)
    }

    // MARK: - bounds, cancellation and per-request compare-and-set

    func testAmbiguousAnswersAreBoundedAndBackoffIsCapped() async throws {
        transport.answers = Array(repeating: .failure(CloudError.network), count: 10)
        let p = policy()
        let error = await thrown { try await self.run(session: nil, policy: p) }
        XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(.ambiguous))
        XCTAssertEqual(transport.finalizes, p.ambiguousAttempts)
        XCTAssertTrue(waitBox!.waits.allSatisfy { $0 <= p.backoffMax })
    }

    /// Bounded by a count and by the SUM of the waits it chose — no clock is
    /// read, so moving the clock cannot stretch it.
    func testRunningIsBoundedByCountAndByTheSumOfItsOwnWaits() async throws {
        transport.answers = Array(repeating: .success(.running(retryAfter: 3600)), count: 100)
        let p = policy()
        let error = await thrown { try await self.run(session: nil, policy: p) }
        XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(.stillRunning))
        let waits = waitBox!.waits
        XCTAssertTrue(waits.allSatisfy { $0 <= p.runningPollMax }, "Retry-After was not clamped: \(waits)")
        XCTAssertLessThanOrEqual(waits.reduce(0, +), p.runningBudget)
        XCTAssertLessThanOrEqual(transport.finalizes, p.runningPolls)
        XCTAssertEqual(transport.inits, 1)

        transport = ScriptedTransport()
        transport.answers = Array(repeating: .success(.running(retryAfter: 1)), count: 100)
        let q = policy()
        _ = await thrown { try await self.run(session: nil, policy: q) }
        XCTAssertEqual(transport.finalizes, q.runningPolls, "the poll count is not a bound")
    }

    /// The durable phase is re-asserted before EVERY request: a job discarded
    /// while the loop slept is never finalized by it.
    func testAPhaseRefusedBeforeARetryStopsEveryLaterRequest() async throws {
        transport.answers = [.failure(CloudError.network), .failure(CloudError.network)]
        let error = await thrown { try await self.run(session: nil, phaseFails: { $0 >= 2 }) }
        XCTAssertEqual(error as? DeliveryUploadError, .finalizeStateNotRecorded)
        XCTAssertEqual(transport.finalizes, 1, "a request left after the job stopped owning its phase")
    }

    func testCancellationDuringABackoffSendsNothingMore() async throws {
        transport.answers = Array(repeating: .failure(CloudError.network), count: 5)
        var p = FinalizeRecoveryPolicy()
        p.sleep = { _ in throw CancellationError() }
        let error = await thrown { try await self.run(session: nil, policy: p) }
        XCTAssertTrue(error is CancellationError, "\(String(describing: error))")
        XCTAssertEqual(transport.finalizes, 1)
    }

    func testACancelledTaskSendsNoRequestAtAll() async throws {
        let transport = self.transport!
        let task = Task { () -> Error? in
            withUnsafeCurrentTask { $0?.cancel() }
            return await self.thrown {
                try await self.run(session: DeliverySession(uploadId: "SESSION000000009", chunkSize: 64 * 1024,
                                                            provenance: .finalizing))
            }
        }
        let error = await task.value
        XCTAssertTrue(error is CancellationError)
        XCTAssertEqual(transport.log, [])
    }

    func testAnUnusableIdInA200IsNeverRecordedAndEndsUnconfirmed() async throws {
        transport.answers = Array(repeating: .success(.completed(UploadResult(id: "../me", expiresAt: 9),
                                                                 recovered: false)), count: 5)
        let error = await thrown { try await self.run(session: nil) }
        XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(.ambiguous))
        XCTAssertEqual(transport.inits, 1)
    }

    func testAZeroByteDeliveryIsMarkedAndFinalizedWithoutAPatch() async throws {
        let result = try await run(session: nil, sources: [DataSource(name: "empty", bytes: [])])
        XCTAssertEqual(result.id, "STORED0123456789")
        XCTAssertEqual(transport.patches, 0)
        XCTAssertEqual(transport.log.filter { if case .phase = $0 { return true }; return false }.count, 1)
    }
}
