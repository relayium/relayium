import XCTest
import CryptoKit
import Combine
@testable import RelayiumKit
@testable import RelayiumAppKit

/// B30 pins the Mac path's exact ciphertext and financial identity across
/// independent store/model lifetimes. Real process/HTTP evidence is separate.
@MainActor
final class MacShareRecoveryTests: XCTestCase {
    private var root: URL!
    private let key = [UInt8](repeating: 0x45, count: 32)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-share-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }
    private func store() -> PendingUploadStore { PendingUploadStore(root: root, durableShares: true) }
    private func prepare(_ payload: [UInt8]) throws -> PendingUploadPlan {
        let s = store()
        let plan = try s.prepare(sources: [DataSource(name: "folder/a.bin", bytes: payload)],
                                 accountId: "A", burnAfterRead: false, ttl: 3600)
        return try s.sealShare(plan, key: key)
    }
    private func bytes(_ spool: CiphertextSpool) throws -> Data {
        var result = Data()
        while let chunk = try spool.next() { result += chunk }
        return result
    }

    func testSpoolSurvivesPlaintextDeletionAndResumesInsideFrames() throws {
        let payload = (0..<(STORE_CHUNK_SIZE + 72)).map { UInt8($0 % 251) }
        let plan = try prepare(payload)
        let reopened = store()
        XCTAssertFalse(FileManager.default.fileExists(atPath: reopened.jobURL(for: plan.jobId).appendingPathComponent("staged").path))
        let durable = try XCTUnwrap(reopened.plan(for: "A"))
        let record = try XCTUnwrap(durable.shareSpool)
        let expected = Data(encryptChunks(key: key, files: [payload]))
        XCTAssertEqual(record.size, expected.count)
        for offset in [0, 1, 3, 1234, STORE_CHUNK_SIZE + 9, expected.count] {
            let replay = try CiphertextSpool(at: reopened.spoolURL(for: durable), record: record, offset: offset)
            XCTAssertEqual(try bytes(replay), expected.dropFirst(offset))
        }
        XCTAssertNil(reopened.plan(for: "B"))
        XCTAssertThrowsError(try reopened.sealShare(plan, key: key)) // never seal twice
    }

    func testAllEmptyFilesHaveACompletedZeroByteSpool() throws {
        let plan = try prepare([])
        let record = try XCTUnwrap(plan.shareSpool)
        XCTAssertEqual(record.size, 0)
        XCTAssertEqual(record.sha256, Data(SHA256.hash(data: Data())))
        XCTAssertNotNil(store().plan(for: "A"))
        XCTAssertEqual(try bytes(CiphertextSpool(at: store().spoolURL(for: plan), record: record)), Data())
    }

    func testSameSizeSpoolMutationIsRefusedBeforeAnyNetworkAndKeptBySweep() async throws {
        let plan = try prepare([1, 2, 3])
        let url = store().spoolURL(for: plan)
        var corrupt = try Data(contentsOf: url); corrupt[corrupt.startIndex] ^= 1
        try corrupt.write(to: url)
        let transport = Transport()
        do {
            _ = try await upload(plan, transport: transport)
            XCTFail("corruption must fail")
        } catch { XCTAssertTrue(transport.events.isEmpty) }
        XCTAssertEqual(store().sweepIncomplete(), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testRecordedMissingUploadingSessionNeverCreatesAnother() async throws {
        let s = store()
        let plan = try s.setUploadSession(id: "session-1", chunkSize: 65536, for: prepare([1, 2]))
        let t = Transport(); t.missing = true
        do { _ = try await upload(plan, transport: t); XCTFail("must stop") }
        catch { XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(.notFound)) }
        XCTAssertEqual(t.events, ["offset"])
        XCTAssertNotNil(s.plan(for: "A"))
    }

    func testFinalizingMissingSessionRecoversSameObjectWithNoPatchOrInit() async throws {
        let s = store()
        let plan = try s.setUploadSession(id: "session-1", chunkSize: 65536, for: prepare([1, 2]))
        try s.markShareFinalizing(uploadId: "session-1", for: plan)
        let reopened = try XCTUnwrap(store().plan(for: "A"))
        let t = Transport(); t.missing = true; t.completed = true
        t.beforeFinalize = { XCTAssertEqual(self.store().plan(for: "A")?.sessionPhase, "finalizing") }
        let outcome = try await upload(reopened, transport: t)
        XCTAssertEqual(outcome.id, "object-1")
        XCTAssertEqual(outcome.keyB64url, encodeStoreKey(key))
        XCTAssertEqual(t.events, ["offset", "finalize"])
        XCTAssertEqual(t.objects, 0) // already existed, no second debit
    }

    func testOldServerConflictRetainsFinalizingJobWithoutReinit() async throws {
        let plan = try prepare([1])
        let t = Transport(); t.oldServer = true
        do { _ = try await upload(plan, transport: t); XCTFail("must retain doubt") }
        catch { XCTAssertEqual(error as? DeliveryUploadError, .unconfirmed(.unrecognizedConflict)) }
        XCTAssertEqual(t.events, ["init", "patch", "finalize"])
        XCTAssertEqual(store().plan(for: "A")?.sessionPhase, "finalizing")
        XCTAssertEqual(store().sweepIncomplete(), [])
    }

    func testFailedFinalizingWriteSendsNoFinalize() async throws {
        let plan = try prepare([1])
        let t = Transport()
        let s = store(); s.writeFailureInjection = { $0 == .finalizing }
        do { _ = try await upload(plan, transport: t, using: s); XCTFail("must stop") }
        catch { XCTAssertEqual(error as? DeliveryUploadError, .finalizeStateNotRecorded) }
        XCTAssertEqual(t.events, ["init", "patch"])
        XCTAssertEqual(store().plan(for: "A")?.sessionPhase, "uploading")
    }

    func testRetiredJobCannotBeFinalizedAndDiscardNeverCallsServer() async throws {
        let s = store()
        let plan = try s.setUploadSession(id: "session-1", chunkSize: 65536, for: prepare([1]))
        _ = try s.markRetired(plan)
        XCTAssertThrowsError(try s.markShareFinalizing(uploadId: "session-1", for: plan))
        XCTAssertNil(s.plan(for: "A"))
        XCTAssertEqual(s.sweepIncomplete(), [plan.jobId])
    }

    func testAChangedKeyOrHeaderCannotStartANetworkRequest() async throws {
        let plan = try prepare([9, 8, 7])
        let record = try XCTUnwrap(plan.shareSpool)
        XCTAssertTrue(record.authenticates(key: key))
        XCTAssertFalse(record.authenticates(key: [UInt8](repeating: 0, count: 32)))
        let corrupted = CiphertextSpoolRecord(header: record.header + Data([0]), size: record.size,
            sha256: record.sha256, authentication: record.authentication)
        let t = Transport()
        do {
            _ = try await CloudUploader(transport: t).resumeShareSpool(at: store().spoolURL(for: plan),
                record: corrupted, key: key, session: nil, burnAfterRead: false, ttl: 3600, token: "test",
                onUploadSession: { _, _ in XCTFail("must not open session") },
                onFinalizing: { _ in XCTFail("must not finalize") }, onProgress: { _, _ in })
            XCTFail("changed header must fail")
        } catch { XCTAssertTrue(t.events.isEmpty) }
    }

    private actor LockedKeys: StoredLinkKeyStore {
        func key(for id: String) async throws -> String? { throw KeychainError.status(-25308) }
        func save(id: String, keyB64url: String) async throws { throw KeychainError.status(-25308) }
        func remove(id: String) async throws { throw KeychainError.status(-25308) }
    }

    func testFailedFinalKeySaveKeepsPendingKeyUntilALaterLaunchSalvagesIt() async throws {
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let t = Transport()
        let pending = PendingUploadSupport(store: store(), keys: pendingKeys)
        let first = CloudUploadModel(uploader: CloudUploader(transport: t), keyStore: LockedKeys(),
            origin: "https://example.invalid", pending: pending)
        first.accountId = "A"
        let original = root.appendingPathComponent("source.bin")
        try Data([1]).write(to: original)
        first.pick([original]); first.start(token: "test"); await first.task?.value
        guard case .done(_, _, let warning) = first.state else { return XCTFail("server completed") }
        XCTAssertNotNil(warning)
        let salvage = try XCTUnwrap(store().finalizedSharesAwaitingSalvage().first)
        let savedPending = try await pendingKeys.key(for: salvage.jobId)
        XCTAssertNotNil(savedPending)
        let finalKeys = InMemoryStoredLinkKeyStore()
        let second = CloudUploadModel(uploader: CloudUploader(transport: t), keyStore: finalKeys,
            origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: pendingKeys))
        let events = t.events
        second.recoverPendingJob(for: "A"); await second.recoveryTask?.value
        XCTAssertEqual(events, t.events)
        let savedFinal = try await finalKeys.key(for: salvage.storedId)
        XCTAssertEqual(savedFinal, savedPending)
        let removedPending = try await pendingKeys.key(for: salvage.jobId)
        XCTAssertNil(removedPending)
        XCTAssertEqual(store().finalizedSharesAwaitingSalvage(), [])
    }

    func testDurableMacSupportWithoutAnAccountRefusesTheLegacyFallback() async throws {
        let t = Transport()
        let model = CloudUploadModel(uploader: CloudUploader(transport: t), keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: InMemoryStoredLinkKeyStore()))
        let source = root.appendingPathComponent("source.bin"); try Data([1]).write(to: source)
        model.pick([source]); model.start(token: "test"); await model.task?.value
        guard case .failed = model.state else { return XCTFail("missing identity must refuse") }
        XCTAssertTrue(t.events.isEmpty)
    }

    private func ready(_ id: String = "acct-1") -> SessionState {
        .ready(user: NativeUser(id: id, email: "\(id)@b.co", displayName: id,
                                hasPassword: true, emailVerified: true,
                                linkedMethods: ["password"], onlyOwnNodes: false,
                                planId: "pro", subscriptionStatus: "active",
                                subscriptionEnd: 0, hasBilling: true,
                                scheduledPlanId: "", scheduledCycle: "",
                                billingCycle: "monthly"),
               usage: UsageResponse(period: "202608", resetsAt: 0,
                                    traffic: Meter(used: 0, cap: 0),
                                    storage: Meter(used: 0, cap: 0),
                                    plan: PlanInfo(id: "pro", name: "Pro", storageBytes: 0,
                                                   trafficBytes: 0, retentionSecs: 86_400,
                                                   priceMonthly: 0, priceYearly: 0, isTop: false,
                                                   subscriptionStatus: "active", subscriptionEnd: 0,
                                                   billingCycle: "monthly", scheduledPlanId: "",
                                                   scheduledPlanName: "", scheduledCycle: "")))
    }

    func testMacAppLifetimeObserverOffersRecoveryThenSynchronouslyIsolatesAnAccountSwitch() async throws {
        let plan = try prepare([1, 2, 3])
        let keys = InMemoryStoredLinkKeyStore()
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let transport = Transport()
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: keys))
        let session = CurrentValueSubject<SessionState, Never>(ready("A"))
        model.observe(session)
        XCTAssertEqual(model.accountId, "A")
        await model.recoveryTask?.value
        guard case .interrupted = model.state else { return XCTFail("app init must offer persisted recovery") }
        XCTAssertTrue(transport.events.isEmpty)
        session.send(ready("B"))
        XCTAssertEqual(model.accountId, "B")
        XCTAssertTrue(model.sessionFiles.isEmpty, "no outgoing file identity may flash for the new account")
        await model.cleanupTask?.value
        await model.recoveryTask?.value
        XCTAssertEqual(model.state, .idle)
        XCTAssertNotNil(store().plan(for: "A"))
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertEqual(retained, encodeStoreKey(key))
        XCTAssertTrue(transport.events.isEmpty)
        session.send(ready("A"))
        await model.recoveryTask?.value
        guard case .interrupted = model.state else { return XCTFail("same-account re-entry must offer the retained job") }
        XCTAssertTrue(transport.events.isEmpty)
    }

    func testSelectionMadeBeforeLoginCannotHideAnOlderRecoverableJob() async throws {
        let plan = try prepare([1])
        let keys = InMemoryStoredLinkKeyStore(); try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let transport = Transport()
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: keys))
        let file = root.appendingPathComponent("new.bin"); try Data([7]).write(to: file)
        model.pick([file])
        model.observe(CurrentValueSubject<SessionState, Never>(ready("A")))
        model.start(token: "test"); await model.recoveryTask?.value
        guard case .interrupted = model.state else { return XCTFail("older job must be offered first") }
        XCTAssertTrue(transport.events.isEmpty)
    }

    func testMalformedFileSizeCannotTrapRecoveryOrDestroyAnUncertainRecord() throws {
        let plan = try prepare([1])
        let file = store().jobURL(for: plan.jobId).appendingPathComponent("plan.json")
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var files = try XCTUnwrap(document["files"] as? [[String: Any]])
        files[0]["size"] = Int.max
        document["files"] = files
        try JSONSerialization.data(withJSONObject: document).write(to: file)
        XCTAssertNil(store().plan(for: "A"))
        XCTAssertEqual(store().sweepIncomplete(), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    func testFailedSessionWriteSendsNoPatchOrFinalize() async throws {
        let plan = try prepare([1])
        let s = store(); s.writeFailureInjection = { $0 == .uploadSession }
        let t = Transport()
        do { _ = try await upload(plan, transport: t, using: s); XCTFail("must stop") }
        catch { XCTAssertEqual(t.events, ["init"]) }
        XCTAssertNil(store().plan(for: "A")?.uploadId)
    }

    private actor RecordingKeys: StoredLinkKeyStore {
        var saved: [String: String] = [:]
        var saves = 0
        func key(for id: String) async throws -> String? { saved[id] }
        func save(id: String, keyB64url: String) async throws { saved[id] = keyB64url; saves += 1 }
        func remove(id: String) async throws { saved.removeValue(forKey: id) }
        func snapshot() -> (Int, Int) { (saves, saved.count) }
    }

    func testDiskFullAfterSavingThePendingKeyLeavesNoJobOrOrphanKeyAndSendsNothing() async throws {
        let s = store(); s.writeFailureInjection = { $0 == .shareSpool }
        let keys = RecordingKeys(), transport = Transport()
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://example.invalid", pending: PendingUploadSupport(store: s, keys: keys))
        model.accountId = "A"
        let file = root.appendingPathComponent("source.bin"); try Data([1, 2]).write(to: file)
        model.pick([file]); model.start(token: "test"); await model.task?.value
        guard case .failed = model.state else { return XCTFail("disk full must stop before INIT") }
        XCTAssertTrue(transport.events.isEmpty)
        XCTAssertNil(s.plan(for: "A"))
        let keyState = await keys.snapshot()
        XCTAssertEqual(keyState.0, 1)
        XCTAssertEqual(keyState.1, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "original must survive preparation failure")
        let entries = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        XCTAssertEqual(entries.map(\.lastPathComponent), ["source.bin"], "partial staging must be removed")
    }

    func testEmptyUploadStillRecordsFinalizingAndCompletesWithoutAPatch() async throws {
        let plan = try prepare([]), t = Transport()
        t.beforeFinalize = { XCTAssertEqual(self.store().plan(for: "A")?.sessionPhase, "finalizing") }
        let result = try await upload(plan, transport: t)
        XCTAssertEqual(result.id, "object-1")
        XCTAssertEqual(t.events, ["init", "finalize"])
        XCTAssertEqual(t.objects, 1)
    }

    func testUnconfirmedDiscardWithoutConfirmationPreservesTheOnlyRecoveryKey() async throws {
        let s = store(), keys = InMemoryStoredLinkKeyStore()
        let plan = try s.setUploadSession(id: "session-1", chunkSize: 65536, for: prepare([1]))
        try s.markShareFinalizing(uploadId: "session-1", for: plan)
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let transport = Transport()
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport),
            keyStore: InMemoryStoredLinkKeyStore(), origin: "https://example.invalid",
            pending: PendingUploadSupport(store: s, keys: keys))
        model.recoverPendingJob(for: "A"); await model.recoveryTask?.value
        model.discardPendingJob(); await model.cleanupTask?.value
        XCTAssertNotNil(s.plan(for: "A"), "an unconfirmed deletion must retain recovery")
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertEqual(retained, encodeStoreKey(key), "an unconfirmed deletion must retain the only key")
        XCTAssertTrue(FileManager.default.fileExists(atPath: s.spoolURL(for: plan).path))
        XCTAssertTrue(transport.events.isEmpty, "asking for confirmation must never contact the server")
    }

    func testStaleDiscardAfterAccountDepartureCannotDeleteButFreshConfirmationCan() async throws {
        let s = store(), keys = InMemoryStoredLinkKeyStore(), transport = Transport()
        let plan = try prepare([1, 2])
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport),
            keyStore: InMemoryStoredLinkKeyStore(), origin: "https://example.invalid",
            pending: PendingUploadSupport(store: s, keys: keys))
        let session = CurrentValueSubject<SessionState, Never>(ready("A"))
        model.observe(session); await model.recoveryTask?.value
        let stale = try XCTUnwrap(model.makeDiscardConfirmation())
        XCTAssertNotNil(s.plan(for: "A"), "opening or cancelling confirmation changes nothing")
        session.send(.loggedOut)
        XCTAssertNil(model.makeDiscardConfirmation())
        session.send(ready("A")); await model.recoveryTask?.value
        model.discardPendingJob(confirming: stale); await model.cleanupTask?.value
        XCTAssertNotNil(s.plan(for: "A"))
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertEqual(retained, encodeStoreKey(key))
        let fresh = try XCTUnwrap(model.makeDiscardConfirmation())
        XCTAssertNotEqual(stale, fresh)
        model.discardPendingJob(confirming: fresh); await model.cleanupTask?.value
        XCTAssertNil(s.plan(for: "A"))
        let removed = try await keys.key(for: plan.jobId)
        XCTAssertNil(removed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: s.spoolURL(for: plan).path))
        XCTAssertTrue(transport.events.isEmpty, "confirmed local deletion must never delete a server object")
    }

    func testConfirmationFromAnotherModelCannotDeleteEvenTheSameSavedJob() async throws {
        let s = store(), keys = InMemoryStoredLinkKeyStore(), transport = Transport()
        let plan = try prepare([1])
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        func makeModel() -> CloudUploadModel {
            CloudUploadModel(uploader: CloudUploader(transport: transport),
                keyStore: InMemoryStoredLinkKeyStore(), origin: "https://example.invalid",
                pending: PendingUploadSupport(store: s, keys: keys))
        }
        let first = makeModel(), second = makeModel()
        first.recoverPendingJob(for: "A"); await first.recoveryTask?.value
        let firstToken = try XCTUnwrap(first.makeDiscardConfirmation())
        second.recoverPendingJob(for: "A"); await second.recoveryTask?.value
        XCTAssertNotEqual(firstToken, try XCTUnwrap(second.makeDiscardConfirmation()))
        second.discardPendingJob(confirming: firstToken); await second.cleanupTask?.value
        XCTAssertNotNil(s.plan(for: "A"))
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertEqual(retained, encodeStoreKey(key))
        XCTAssertTrue(transport.events.isEmpty)
    }

    func testResumingInvalidatesAnEarlierDiscardConfirmation() async throws {
        let s = store(), keys = InMemoryStoredLinkKeyStore(), transport = Transport()
        let plan = try s.setUploadSession(id: "session-1", chunkSize: 65536, for: prepare([1]))
        try s.markShareFinalizing(uploadId: "session-1", for: plan)
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        transport.missing = true; transport.oldServer = true
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport),
            keyStore: InMemoryStoredLinkKeyStore(), origin: "https://example.invalid",
            pending: PendingUploadSupport(store: s, keys: keys))
        model.recoverPendingJob(for: "A"); await model.recoveryTask?.value
        let stale = try XCTUnwrap(model.makeDiscardConfirmation())
        model.resume(token: "private-test")
        XCTAssertNil(model.makeDiscardConfirmation(), "running work cannot be confirmed for deletion")
        await model.task?.value
        guard case .interrupted = model.state else { return XCTFail("old server must retain the uncertain upload") }
        let events = transport.events
        model.discardPendingJob(confirming: stale); await model.cleanupTask?.value
        XCTAssertNotNil(s.plan(for: "A"))
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertEqual(retained, encodeStoreKey(key))
        XCTAssertNotEqual(stale, try XCTUnwrap(model.makeDiscardConfirmation()))
        XCTAssertEqual(transport.events, events)
        XCTAssertEqual(events, ["offset", "finalize"])
    }

    func testDiscardCannotDeleteTheOnlyKeyOfAShareThatFinalizedWhileKeySaveWasPending() async throws {
        let plan = try prepare([1])
        let keys = InMemoryStoredLinkKeyStore(); try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let s = store(), transport = Transport()
        let live = try s.setUploadSession(id: "session-1", chunkSize: 65536, for: plan)
        try s.markShareFinalizing(uploadId: "session-1", for: live)
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: LockedKeys(),
            origin: "https://example.invalid", pending: PendingUploadSupport(store: s, keys: keys))
        model.recoverPendingJob(for: "A"); await model.recoveryTask?.value
        _ = try s.markFinalized(live, storedId: "object-1")
        model.discardPendingJob(confirming: try XCTUnwrap(model.makeDiscardConfirmation()))
        await model.cleanupTask?.value
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertEqual(retained, encodeStoreKey(key))
        XCTAssertEqual(s.finalizedSharesAwaitingSalvage().count, 1)
        XCTAssertNotNil(model.cleanupWarning)
        model.purgePendingJob()
        XCTAssertEqual(model.state, .idle)
        XCTAssertTrue(model.sessionFiles.isEmpty)
        XCTAssertEqual(s.finalizedSharesAwaitingSalvage().count, 1)
        XCTAssertTrue(transport.events.isEmpty)
    }

    func testFailedDiscardPersistenceRetainsInputsButHidesThemFromTheNextAccount() async throws {
        let plan = try prepare([1])
        let keys = InMemoryStoredLinkKeyStore(); try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let s = store(); s.writeFailureInjection = { $0 == .retired }
        let transport = Transport()
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://example.invalid", pending: PendingUploadSupport(store: s, keys: keys))
        let session = CurrentValueSubject<SessionState, Never>(ready("A")); model.observe(session)
        await model.recoveryTask?.value
        model.discardPendingJob(confirming: try XCTUnwrap(model.makeDiscardConfirmation()))
        guard case .interrupted = model.state else { return XCTFail("failed Discard must retain the offer") }
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(retained)
        session.send(ready("B"))
        XCTAssertEqual(model.accountId, "B")
        XCTAssertTrue(model.sessionFiles.isEmpty)
        await model.recoveryTask?.value
        XCTAssertEqual(model.state, .idle)
        XCTAssertNotNil(s.plan(for: "A"))
        XCTAssertTrue(transport.events.isEmpty)
    }

    private func upload(_ plan: PendingUploadPlan, transport: Transport,
                        using supplied: PendingUploadStore? = nil) async throws -> UploadOutcome {
        let s = supplied ?? store()
        let provenance: DeliverySessionProvenance = plan.sessionPhase == "finalizing" ? .finalizing : .trustedUploading
        let session = plan.uploadId.map { DeliverySession(uploadId: $0, chunkSize: plan.uploadChunkSize!, provenance: provenance) }
        return try await CloudUploader(transport: transport).resumeShareSpool(
            at: s.spoolURL(for: plan), record: XCTUnwrap(plan.shareSpool), key: key,
            session: session, burnAfterRead: false, ttl: plan.ttl, token: "private-test",
            onUploadSession: { id, chunk in _ = try s.setUploadSession(id: id, chunkSize: chunk, for: plan) },
            onFinalizing: { try s.markShareFinalizing(uploadId: $0, for: plan) }, onProgress: { _, _ in })
    }

    private final class Transport: ResumableTransport, @unchecked Sendable {
        var events: [String] = []
        var body = Data()
        var missing = false
        var completed = false
        var oldServer = false
        var interruptAfterFinalize = false
        var objects = 0
        var beforeFinalize: (() -> Void)?
        var afterFinalizeCommit: (() async -> Void)?
        func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            events.append("init"); return ("session-1", 65536)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int {
            events.append("offset"); if missing { throw CloudError.notFound }; return body.count
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int,
                        token: String, onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            events.append("patch"); XCTAssertEqual(from, body.count)
            body += bytes; return .committed(received: to)
        }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            XCTFail("Mac must opt in to recovery"); throw CloudError.network
        }
        func finalizeUploadRecovering(uploadId: String, token: String) async throws -> FinalizeAnswer {
            events.append("finalize"); beforeFinalize?()
            if oldServer { return .unconfirmedConflict }
            let recovered = completed
            if !completed { objects += 1 }; completed = true; missing = true
            await afterFinalizeCommit?()
            if interruptAfterFinalize { interruptAfterFinalize = false; throw CancellationError() }
            return .completed(UploadResult(id: "object-1", expiresAt: 42), recovered: recovered)
        }
    }

    func testFreshModelRecoversLostFinalizeWithoutAutomaticNetworkOrDuplicateObject() async throws {
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let finalKeys = InMemoryStoredLinkKeyStore()
        let transport = Transport(); transport.interruptAfterFinalize = true
        func makeModel() -> CloudUploadModel {
            CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: finalKeys,
                origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: pendingKeys))
        }
        let original = root.appendingPathComponent("original.bin")
        try Data([1, 2, 3, 4]).write(to: original)
        let first = makeModel(); first.accountId = "A"
        first.pick([original]); first.start(token: "private-test")
        await first.task?.value
        guard case .interrupted = first.state else { return XCTFail("lost finalize must be retained") }
        let events = transport.events
        try FileManager.default.removeItem(at: original)
        let second = makeModel(); second.recoverPendingJob(for: "A")
        await second.recoveryTask?.value
        XCTAssertEqual(events, transport.events)
        guard case .interrupted = second.state else { return XCTFail("restart must offer recovery") }
        second.resume(token: "private-test"); await second.task?.value
        guard case .done(let link, _, _) = second.state else { return XCTFail("must recover link") }
        XCTAssertTrue(link.contains("object-1#k="))
        XCTAssertEqual(transport.objects, 1)
        XCTAssertEqual(transport.events.filter { $0 == "init" }.count, 1)
        XCTAssertEqual(transport.events.filter { $0 == "patch" }.count, 1)
        XCTAssertNil(store().plan(for: "A"))
        let savedKey = try await finalKeys.key(for: "object-1")
        XCTAssertNotNil(savedKey)
    }

    func testAccountDepartureAfterLostFinalizeKeepsTheOnlyKeyForExplicitSameAccountRecovery() async throws {
        let pendingKeys = InMemoryStoredLinkKeyStore(), finalKeys = InMemoryStoredLinkKeyStore()
        let transport = Transport(); transport.interruptAfterFinalize = true
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: finalKeys,
            origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: pendingKeys))
        let session = CurrentValueSubject<SessionState, Never>(ready("A"))
        model.observe(session); await model.recoveryTask?.value
        let original = root.appendingPathComponent("original.bin")
        try Data([1, 2, 3]).write(to: original)
        model.pick([original]); model.start(token: "private-test"); await model.task?.value
        guard case .interrupted = model.state else { return XCTFail("lost finalized reply must pause") }
        let plan = try XCTUnwrap(store().plan(for: "A"))
        XCTAssertEqual(plan.sessionPhase, "finalizing")
        XCTAssertEqual(transport.objects, 1)
        let pendingKey = try await pendingKeys.key(for: plan.jobId)
        XCTAssertNotNil(pendingKey)
        let unsaved = try await finalKeys.key(for: "object-1")
        XCTAssertNil(unsaved, "the pending key is the only copy")
        try FileManager.default.removeItem(at: original)
        let events = transport.events

        session.send(.loggedOut)
        XCTAssertNil(model.accountId)
        XCTAssertTrue(model.sessionFiles.isEmpty)
        await model.cleanupTask?.value
        XCTAssertNotNil(store().plan(for: "A"))
        let afterLogout = try await pendingKeys.key(for: plan.jobId)
        XCTAssertEqual(afterLogout, pendingKey)
        session.send(.unavailable(message: "account unavailable"))
        XCTAssertNil(model.accountId)
        XCTAssertNotNil(store().plan(for: "A"))
        session.send(ready("B"))
        XCTAssertEqual(model.accountId, "B")
        XCTAssertTrue(model.sessionFiles.isEmpty)
        await model.cleanupTask?.value; await model.recoveryTask?.value
        XCTAssertEqual(model.state, .idle)
        XCTAssertNotNil(store().plan(for: "A"), "account departure must not discard an uncertain paid object")
        let retained = try await pendingKeys.key(for: plan.jobId)
        XCTAssertEqual(retained, pendingKey, "do not delete the only key")
        XCTAssertEqual(transport.events, events)

        session.send(ready("A")); await model.recoveryTask?.value
        guard case .interrupted = model.state else { return XCTFail("same account must recover its saved job") }
        XCTAssertEqual(store().plan(for: "A")?.uploadId, plan.uploadId)
        XCTAssertEqual(transport.events, events, "account entry must not send")
        model.resume(token: "private-test"); await model.task?.value
        guard case .done = model.state else { return XCTFail("explicit resume must recover the existing link") }
        XCTAssertEqual(transport.objects, 1)
        XCTAssertEqual(transport.events.filter { $0 == "init" }.count, 1)
        XCTAssertEqual(transport.events.filter { $0 == "patch" }.count, 1)
        let saved = try await finalKeys.key(for: "object-1")
        XCTAssertEqual(saved, pendingKey)
    }

    func testAccountDepartureWhileFinalizeIsInFlightRetainsTheOriginalSessionAndKey() async throws {
        let keys = InMemoryStoredLinkKeyStore(), finalKeys = InMemoryStoredLinkKeyStore()
        let transport = Transport(); transport.interruptAfterFinalize = true
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport), keyStore: finalKeys,
            origin: "https://example.invalid", pending: PendingUploadSupport(store: store(), keys: keys))
        let session = CurrentValueSubject<SessionState, Never>(ready("A"))
        model.observe(session); await model.recoveryTask?.value
        transport.afterFinalizeCommit = { await MainActor.run { session.send(.loggedOut) } }
        let source = root.appendingPathComponent("inflight.bin")
        try Data([7, 8, 9]).write(to: source)
        model.pick([source]); model.start(token: "private-test")
        let attempt = model.task
        await attempt?.value
        XCTAssertNil(model.accountId)
        XCTAssertTrue(model.sessionFiles.isEmpty)
        XCTAssertEqual(model.state, .idle)
        let plan = try XCTUnwrap(store().plan(for: "A"))
        XCTAssertEqual(plan.sessionPhase, "finalizing")
        let retained = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(retained)
        XCTAssertEqual(transport.objects, 1)
        transport.afterFinalizeCommit = nil
        let events = transport.events
        session.send(ready("A")); await model.recoveryTask?.value
        guard case .interrupted = model.state else { return XCTFail("same account must recover the in-flight completion") }
        XCTAssertEqual(transport.events, events)
        model.resume(token: "private-test"); await model.task?.value
        guard case .done = model.state else { return XCTFail("resume must recover the original object") }
        XCTAssertEqual(transport.objects, 1)
        XCTAssertEqual(transport.events.filter { $0 == "init" }.count, 1)
        let saved = try await finalKeys.key(for: "object-1")
        XCTAssertEqual(saved, retained)
    }
}
