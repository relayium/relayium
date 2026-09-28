import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// A Device Inbox delivery whose finalize answer is lost, driven through the
/// real `InboxSendCoordinator` over a real protected `PendingUploadStore`.
///
/// The property under test is financial: one delivery is one upload session,
/// one object and one create — whatever answers are lost, whatever local write
/// fails, whenever the attempt is cancelled or the job is discarded. Every
/// write-failure injection below fails ONE durable write and leaves deletion
/// working, so "the job was retained" cannot pass merely because nothing could
/// have removed it.
final class InboxFinalizeRecoveryTests: XCTestCase {
    private var root: URL!
    private var store: PendingUploadStore!
    private var keys: InMemoryStoredLinkKeyStore!
    private var sender: FakeInboxSenderTransport!
    private var transport: StubTransport!
    private var devicePublicKey = ""

    private let deviceID = "DEVICE0123456789"
    private let keyID = "KEY0123456789abcd"
    private let taskID = "TASK0123456789ab"
    private let storedID = "STORED0123456789"

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("finalize-recovery-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = PendingUploadStore(root: root.appendingPathComponent("PendingUploads")).protectedDeviceStore()
        keys = InMemoryStoredLinkKeyStore()
        sender = FakeInboxSenderTransport()
        transport = StubTransport()
        transport.finalizeResult = UploadResult(id: storedID, expiresAt: 4242)
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        sender.deviceRows = [row()]
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func row() -> InboxDeviceRow {
        let key = InboxKey(id: keyID, algorithm: InboxProtocol.keyAlgorithm,
                           publicKey: devicePublicKey, generation: 4, createdAt: 10)
        return InboxDeviceRow(id: deviceID, name: "Studio", kind: "mac", isCurrent: false,
                              inbox: InboxView(presence: .online, lastHeartbeatAt: 10,
                                               presenceExpiresAt: 100, heartbeatIntervalSeconds: 30,
                                               protocolVersion: 3,
                                               capabilities: InboxProtocol.announcedCapabilities(presentingText: true),
                                               receiveCapability: InboxCapability.receiveV3,
                                               autoAccept: .auto, receiveDirReady: true, revoked: false,
                                               canReceive: true, registeredAt: 10, key: key))
    }

    private func task(storedFileID: String) -> InboxTask {
        InboxTask(id: taskID, targetDeviceID: deviceID, idempotencyKey: "k", storedFileID: storedFileID,
                  state: .queued, ciphertextBytes: 64, targetKeyID: keyID, targetKeyGeneration: 4,
                  expiresAt: 86_500)
    }

    private final class Sleeps: @unchecked Sendable {
        var onSleep: (() throws -> Void)?
        var count = 0
    }
    private var sleeps = Sleeps()

    private func coordinator() -> InboxSendCoordinator {
        var policy = FinalizeRecoveryPolicy()
        let sleeps = self.sleeps
        policy.sleep = { _ in sleeps.count += 1; try sleeps.onSleep?() }
        return InboxSendCoordinator(store: store, keys: keys, uploader: CloudUploader(transport: transport),
                                    sender: sender, finalizePolicy: policy)
    }

    private func staged(bytes: [UInt8] = Array("hello device inbox".utf8)) async throws -> PendingUploadPlan {
        let plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: bytes)], accountId: "acct-1",
                                     burnAfterRead: false, ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: PendingUploadTarget(deviceId: deviceID, keyId: keyID, keyGeneration: 4))
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        return plan
    }

    private func onDisk(_ plan: PendingUploadPlan) -> PendingUploadPlan? {
        store.ownedDevicePlan(jobId: plan.jobId)
    }

    private func deliver(_ plan: PendingUploadPlan) async -> Result<InboxSendResult, Error> {
        let current = onDisk(plan) ?? plan
        do { return .success(try await coordinator().deliver(current, token: "bearer")) }
        catch { return .failure(error) }
    }

    private func failure(_ r: Result<InboxSendResult, Error>) -> InboxSendFailure? {
        if case .failure(let e) = r { return e as? InboxSendFailure }
        return nil
    }

    private func assertRetained(_ plan: PendingUploadPlan, file: StaticString = #filePath,
                                line: UInt = #line) async throws {
        let current = try XCTUnwrap(onDisk(plan), "the job was deleted", file: file, line: line)
        XCTAssertFalse(current.retired, file: file, line: line)
        XCTAssertNoThrow(try store.sources(for: current), "the staged bytes are gone", file: file, line: line)
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(key, "the content key is gone", file: file, line: line)
    }

    // MARK: - lost answers

    /// The headline: every answer of one attempt lost, then Retry. One session,
    /// one object, one create, and it binds the recovered object.
    func testALostFinalizeAnswerIsRecoveredOnRetryWithoutASecondUpload() async throws {
        let plan = try await staged()
        transport.recoveringAnswers = Array(repeating: .failure(CloudError.network), count: 3)

        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadOutcomeUnknown) }
        try await assertRetained(plan)
        XCTAssertEqual(onDisk(plan)?.deviceSessionState, .finalizing("up1"))
        XCTAssertEqual(sender.creates.count, 0)

        transport.statusNotFound = true                       // central completed it: status 404
        transport.recoveringAnswers = [.success(.completed(UploadResult(id: storedID, expiresAt: 9),
                                                           recovered: true))]
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(storedFileID: storedID), created: true))]
        guard case .success(let result) = await deliver(plan) else { return XCTFail("retry failed") }

        XCTAssertEqual(result.task.id, taskID)
        XCTAssertEqual(transport.initCount, 1, "the retry opened a second upload session")
        XCTAssertEqual(transport.patches.count, 1, "the retry re-sent bytes")
        XCTAssertEqual(sender.creates.count, 1)
        guard case .create(_, _, let bound, _, _, _)? = sender.creates.first else { return XCTFail() }
        XCTAssertEqual(bound, storedID)
    }

    func testAPreRecoveryServersTextConflictStaysUnknownAndNeverReuploads() async throws {
        let plan = try await staged()
        transport.recoveringAnswers = Array(repeating: .failure(CloudError.network), count: 3)
        _ = await deliver(plan)
        for _ in 0..<3 {
            transport.statusNotFound = true
            transport.recoveringAnswers = [.success(.unconfirmedConflict)]
            do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadOutcomeUnknown) }
        }
        transport.recoveringAnswers = [.failure(CloudError.notFound)]     // record purged later
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadOutcomeUnknown) }
        XCTAssertEqual(transport.initCount, 1)
        XCTAssertEqual(sender.creates.count, 0)
        try await assertRetained(plan)
    }

    // MARK: - terminal answers

    func testEachClosedOutcomeIsRecordedOnceAndThenSendsNothingAtAll() async throws {
        for (outcome, shown) in [(FinalizeOutcome.failed, InboxUploadUnavailable.notCompleted),
                                 (.expired, .expired), (.removed, .removed)] {
            transport = StubTransport()
            let plan = try await staged()
            transport.recoveringAnswers = [.success(.notCompleted(outcome))]
            do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadUnavailable(shown)) }
            let recorded = try XCTUnwrap(onDisk(plan))
            XCTAssertEqual(recorded.terminalOutcome, PendingDeviceTerminal(outcome).rawValue)
            XCTAssertEqual(recorded.uploadId, "up1", "the terminal record dropped its session")
            let before = (transport.initCount, transport.patches.count, transport.recoveringFinalizes.count)
            do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadUnavailable(shown)) }
            XCTAssertEqual(transport.initCount, before.0)
            XCTAssertEqual(transport.patches.count, before.1)
            XCTAssertEqual(transport.recoveringFinalizes.count, before.2, "a terminal job sent a request")
            try await assertRetained(plan)
        }
    }

    // MARK: - local persistence failures

    func testAPhaseWriteFailureSendsNoFinalizeAndKeepsEverything() async throws {
        let plan = try await staged()
        store.writeFailureInjection = { $0 == .finalizing }
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .recoveryStateWriteFailed) }
        XCTAssertEqual(transport.recoveringFinalizes, [], "a finalize left without its phase")
        try await assertRetained(plan)

        store.writeFailureInjection = nil
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(storedFileID: storedID), created: true))]
        guard case .success = await deliver(plan) else { return XCTFail("the retry did not finish") }
        XCTAssertEqual(transport.initCount, 1)
        XCTAssertEqual(transport.recoveringFinalizes.count, 1)
    }

    /// The old failure path: central answered 200, the local record of the
    /// object could not be written, and the retry used to upload everything
    /// again. Now it is not `uploadFailed`, the phase survives, and the retry
    /// recovers the same object.
    func testAnObjectRecordWriteFailureAfter200IsRecoveredNotReuploaded() async throws {
        let plan = try await staged()
        store.writeFailureInjection = { $0 == .finalized }
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .recoveryStateWriteFailed) }
        try await assertRetained(plan)
        XCTAssertEqual(onDisk(plan)?.deviceSessionState, .finalizing("up1"))

        store.writeFailureInjection = nil
        transport.statusNotFound = true
        transport.recoveringAnswers = [.success(.completed(UploadResult(id: storedID, expiresAt: 9),
                                                           recovered: true))]
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(storedFileID: storedID), created: true))]
        guard case .success = await deliver(plan) else { return XCTFail("the retry did not finish") }
        XCTAssertEqual(transport.initCount, 1)
        XCTAssertEqual(transport.patches.count, 1)
        XCTAssertEqual(sender.creates.count, 1)
    }

    func testATerminalRecordWriteFailureKeepsThePhaseAndTheNextAttemptRecordsIt() async throws {
        let plan = try await staged()
        store.writeFailureInjection = { $0 == .terminal }
        transport.recoveringAnswers = [.success(.notCompleted(.expired))]
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .recoveryStateWriteFailed) }
        try await assertRetained(plan)
        XCTAssertEqual(onDisk(plan)?.deviceSessionState, .finalizing("up1"))

        store.writeFailureInjection = nil
        transport.statusNotFound = true
        transport.recoveringAnswers = [.success(.notCompleted(.expired))]
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadUnavailable(.expired)) }
        XCTAssertEqual(transport.initCount, 1)
    }

    // MARK: - discard, cancellation, records this build cannot explain

    /// Discarded while the retry loop sleeps: no later request, and the job
    /// directory is not resurrected by a late phase write.
    func testADiscardDuringABackoffStopsEveryLaterFinalizeAndResurrectsNothing() async throws {
        let plan = try await staged()
        transport.recoveringAnswers = Array(repeating: .failure(CloudError.network), count: 3)
        let store = self.store!
        sleeps.onSleep = {
            guard let current = store.ownedDevicePlan(jobId: plan.jobId) else { return }
            let retired = try store.markRetired(current)
            store.purge(retired)
        }
        let result = await deliver(plan)
        XCTAssertEqual(failure(result), .recoveryStateWriteFailed)
        XCTAssertEqual(transport.recoveringFinalizes.count, 1, "a finalize left for a discarded job")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path),
                       "the discarded job was written back to disk")
    }

    func testACancellationAfterThePhaseKeepsItAndTheRetryRecoversTheSameObject() async throws {
        let plan = try await staged()
        transport.recoveringAnswers = [.failure(CloudError.network)]
        sleeps.onSleep = { throw CancellationError() }
        let first = await deliver(plan)
        guard case .failure(let error) = first, error is CancellationError else {
            return XCTFail("expected cancellation, got \(first)")
        }
        XCTAssertEqual(onDisk(plan)?.deviceSessionState, .finalizing("up1"))
        try await assertRetained(plan)

        sleeps.onSleep = nil
        transport.statusNotFound = true
        transport.recoveringAnswers = [.success(.completed(UploadResult(id: storedID, expiresAt: 9),
                                                           recovered: true))]
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(storedFileID: storedID), created: true))]
        guard case .success = await deliver(plan) else { return XCTFail("retry failed") }
        XCTAssertEqual(transport.initCount, 1)
        XCTAssertEqual(sender.creates.count, 1)
    }

    /// Correction 2: every phase/session combination this build cannot explain
    /// fails closed — no request of any kind — including a phase with no
    /// session, where "no uploadId" must not read as "never started".
    func testRecordsThisBuildCannotExplainSendNothingAndAreRetained() async throws {
        let cases: [(String, (inout [String: Any]) -> Void, InboxSendFailure)] = [
            ("phase with no session", { $0["sessionPhase"] = "finalizing"; $0["phaseUploadId"] = "UPLOADX000000001" },
             .uploadOutcomeUnknown),
            ("unknown phase", { $0["uploadId"] = "UPLOADX000000001"; $0["uploadChunkSize"] = 65536
                                $0["sessionPhase"] = "sealing"; $0["phaseUploadId"] = "UPLOADX000000001" },
             .uploadOutcomeUnknown),
            ("phase names another session", { $0["uploadId"] = "UPLOADX000000001"; $0["uploadChunkSize"] = 65536
                                              $0["sessionPhase"] = "uploading"; $0["phaseUploadId"] = "UPLOADY000000001" },
             .uploadOutcomeUnknown),
            ("unknown terminal", { $0["terminalOutcome"] = "archived" }, .uploadUnavailable(.unrecognized)),
        ]
        for (label, edit, expected) in cases {
            transport = StubTransport()
            let plan = try await staged()
            let url = store.planURL(for: plan.jobId)
            var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            edit(&json)
            try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)

            do { let r = await deliver(plan); XCTAssertEqual(failure(r), expected, label) }
            XCTAssertEqual(transport.initCount, 0, label)
            XCTAssertEqual(transport.patches.count, 0, label)
            XCTAssertEqual(transport.recoveringFinalizes, [], label)
            XCTAssertFalse(sender.calls.contains(.devices), "\(label): even the device list was read")
            try await assertRetained(plan)
            store.sweepIncomplete()
            XCTAssertNotNil(onDisk(plan), "\(label): swept")
        }
    }

    private func rewritePlan(_ plan: PendingUploadPlan, _ edit: (inout [String: Any]) -> Void) throws {
        let url = store.planURL(for: plan.jobId)
        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        edit(&json)
        try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)
    }

    /// R1 blocker 1: a terminal disposition this build does not recognise,
    /// beside a RECORDED OBJECT (and, separately, a recorded task), stops with
    /// no request of any kind — no device read, no create, no task read, no
    /// release — and says a delivery may still arrive.
    func testAnUnrecognisedTerminalBesideARecordedObjectOrTaskSendsNothingAndReleasesNothing() async throws {
        for withTask in [false, true] {
            sender = FakeInboxSenderTransport()
            sender.deviceRows = [row()]
            sender.createOutcomes = [.success(InboxTaskCreation(task: task(storedFileID: storedID), created: true))]
            sender.taskResults = [.success(task(storedFileID: storedID))]
            transport = StubTransport()
            var plan = try await staged()
            plan = try store.fixtureFinalized(plan, storedId: storedID)
            if withTask { plan = try store.setDeviceTask(id: taskID, for: plan) }
            try rewritePlan(plan) { $0["terminalOutcome"] = "archived-by-a-newer-build" }

            let r = await deliver(plan)
            XCTAssertEqual(failure(r), .uploadUnavailable(.unrecognizedMayArrive), "task=\(withTask)")
            XCTAssertEqual(sender.calls, [], "task=\(withTask): a request left for an unrecognised terminal job")
            XCTAssertEqual(sender.creates.count, 0)
            XCTAssertEqual(transport.initCount + transport.patches.count + transport.recoveringFinalizes.count, 0)
            try await assertRetained(plan)
            XCTAssertEqual(onDisk(plan)?.finalizedStoredId, storedID)
        }
    }

    /// The known pre-v2 disposition keeps its read-only convergence even with
    /// its terminal record present — and never creates.
    func testALegacyFinalizedPlanWithItsOwnTerminalRecordStillConvergesReadOnly() async throws {
        var plan = try await staged()
        plan = try store.fixtureFinalized(plan, storedId: storedID)
        try rewritePlan(plan) {
            $0.removeValue(forKey: "inboxProtocolVersion")
            $0["terminalOutcome"] = "olderVersion"
        }
        sender.listedTasks = []
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadUnavailable(.olderVersionDeliveryUnknown)) }
        XCTAssertTrue(sender.calls.contains(.tasks(device: deviceID, limit: InboxSendCoordinator.convergenceLookupLimit)),
                      "the read-only lookup did not run")
        XCTAssertEqual(sender.creates.count, 0)
        sender.listedTasks = [InboxTask(id: taskID, targetDeviceID: deviceID,
                                        idempotencyKey: try XCTUnwrap(plan.createIdempotencyKey),
                                        storedFileID: storedID, state: .queued, ciphertextBytes: 64,
                                        targetKeyID: keyID, targetKeyGeneration: 4, expiresAt: 86_500)]
        guard case .success(let result) = await deliver(plan) else { return XCTFail("no convergence") }
        XCTAssertFalse(result.created)
        XCTAssertEqual(sender.creates.count, 0)
    }

    /// A v2 plan never carries `olderVersion`; if one does (another build),
    /// it is terminal — the legacy exception needs a pre-v2 plan.
    func testAnOlderVersionRecordOnACurrentFinalizedPlanIsTerminal() async throws {
        var plan = try await staged()
        plan = try store.fixtureFinalized(plan, storedId: storedID)
        try rewritePlan(plan) { $0["terminalOutcome"] = "olderVersion" }
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .uploadUnavailable(.olderVersionDeliveryUnknown)) }
        XCTAssertEqual(sender.calls, [])
        try await assertRetained(plan)
    }

    /// R1 blocker 2, unit half: an UNPROVEN session (an earlier build's) that
    /// is open with part of its bytes is continued; an earlier finalize claims
    /// it under the continuation. The attempt fails, the session is still
    /// unproven — never promoted to trusted — and the retry's 404 recovers
    /// instead of opening a session.
    func testAnInterruptedUnprovenContinuationIsNeverPromotedAndNeverReinitialised() async throws {
        var plan = try await staged(bytes: [UInt8](repeating: 0x5A, count: 200_000))
        plan = try store.setUploadSession(id: "OLDSESSION000001", chunkSize: 64 * 1024, for: plan)
        try rewritePlan(plan) { $0.removeValue(forKey: "sessionPhase"); $0.removeValue(forKey: "phaseUploadId") }
        XCTAssertEqual(onDisk(plan)?.deviceSessionState, .unproven("OLDSESSION000001"))
        transport.committed = [UInt8](repeating: 0, count: 64 * 1024)   // status 200, part of the bytes
        transport.patchAlwaysNotFound = true                            // claimed under the continuation

        let first = await deliver(plan)
        XCTAssertEqual(failure(first), .uploadFailed)
        XCTAssertEqual(onDisk(plan)?.deviceSessionState, .unproven("OLDSESSION000001"),
                       "an unproven session was promoted by a status 200 or a continuation")
        XCTAssertEqual(transport.initCount, 0)
        XCTAssertEqual(transport.recoveringFinalizes, [])

        transport.patchAlwaysNotFound = false
        transport.statusNotFound = true
        transport.recoveringAnswers = [.success(.completed(UploadResult(id: storedID, expiresAt: 9),
                                                           recovered: true))]
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(storedFileID: storedID), created: true))]
        guard case .success = await deliver(plan) else { return XCTFail("the retry did not recover") }
        XCTAssertEqual(transport.initCount, 0, "an unproven session was re-initialised after its 404")
        XCTAssertEqual(transport.recoveringFinalizes, ["OLDSESSION000001"])
    }

    /// A bearer from another account cannot see this delivery's target, so the
    /// attempt stops before any upload request on either account.
    func testAForeignAccountsTokenStopsBeforeAnyUploadRequest() async throws {
        let plan = try await staged()
        sender.deviceRows = []                         // what another account's device list shows
        do { let r = await deliver(plan); XCTAssertEqual(failure(r), .targetMissing) }
        XCTAssertEqual(transport.initCount, 0)
        XCTAssertEqual(transport.recoveringFinalizes, [])
        try await assertRetained(plan)
    }

    /// A share store cannot drive a delivery, and nor can a conflicting job.
    func testOnlyTheProtectedStoreMayDriveADelivery() async throws {
        let plan = try await staged()
        let shared = InboxSendCoordinator(store: PendingUploadStore(root: root.appendingPathComponent("PendingUploads")),
                                          keys: keys, uploader: CloudUploader(transport: transport), sender: sender)
        do {
            _ = try await shared.deliver(plan, token: "bearer")
            XCTFail("the shared store drove a delivery")
        } catch {
            XCTAssertEqual(error as? InboxSendFailure, .notADelivery)
        }
        XCTAssertEqual(transport.initCount, 0)
    }
}
