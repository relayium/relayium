import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// R3-G at the model boundary: what the user is offered, and what is left on
/// disk afterwards.
///
/// The rules these pin are the ones a user can be harmed by if they drift:
/// nothing resumes without being asked, a failure keeps the job rather than
/// discarding the bytes, a finished upload leaves nothing recoverable behind,
/// and one account's pending job is never visible to another.
@MainActor
final class CloudUploadModelPendingTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3g-model-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - doubles

    /// Succeeds, and records whether a plan already existed when the server
    /// session was opened.
    private final class OKTransport: ResumableTransport, @unchecked Sendable {
        var onInit: (() -> Void)?
        private(set) var inits = 0
        private(set) var patches = 0
        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            inits += 1
            onInit?()
            return ("upload-1", 1 << 20)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            patches += 1
            return .committed(received: to)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            UploadResult(id: "stored-1", expiresAt: 99)
        }
    }

    /// The network dies part-way and never comes back. This is the case the
    /// whole slice exists for: the job must survive it.
    private final class DroppingTransport: ResumableTransport, @unchecked Sendable {
        private(set) var touched = false
        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            ("upload-1", 1 << 20)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            touched = true
            throw CloudError.network
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { throw CloudError.network }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            throw CloudError.network
        }
    }

    /// A transport that must never be called — the auto-resume tripwire.
    private final class ForbiddenTransport: ResumableTransport, @unchecked Sendable {
        private(set) var calls = 0
        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            calls += 1
            return ("no", 1 << 20)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            calls += 1
            return .committed(received: to)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { calls += 1; return 0 }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            calls += 1
            return UploadResult(id: "no", expiresAt: 0)
        }
    }

    private actor FinalizeGate {
        private var continuation: CheckedContinuation<UploadResult, Never>?
        private(set) var entered = false

        func wait() async -> UploadResult {
            entered = true
            return await withCheckedContinuation { continuation = $0 }
        }

        func release() {
            continuation?.resume(returning: UploadResult(id: "stored-1", expiresAt: 99))
            continuation = nil
        }
    }

    private final class FinalizeGatedTransport: ResumableTransport, @unchecked Sendable {
        let gate = FinalizeGate()
        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            ("upload-1", 1 << 20)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            .committed(received: to)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            await gate.wait()
        }
    }

    /// A pending-key store whose delete always fails — the cleanup-failure path.
    private final class UndeletableKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        private var keys: [String: String] = [:]
        func save(id: String, keyB64url: String) async throws { keys[id] = keyB64url }
        func key(for id: String) async throws -> String? { keys[id] }
        func remove(id: String) async throws { throw KeychainError.status(-25308) }
    }

    // MARK: - helpers

    private func makeStore() -> PendingUploadStore {
        PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
    }

    private func selection(_ bytes: [UInt8] = Array("payload".utf8)) throws -> [SelectedFile] {
        let url = root.appendingPathComponent("origin-\(UUID().uuidString).bin")
        try Data(bytes).write(to: url)
        return [SelectedFile(url: url, relativePath: "a.bin")]
    }

    private func makeModel(transport: ResumableTransport,
                           store: PendingUploadStore,
                           pendingKeys: StoredLinkKeyStore,
                           finalKeys: StoredLinkKeyStore) -> CloudUploadModel {
        let model = CloudUploadModel(uploader: CloudUploader(transport: transport),
                                     keyStore: finalKeys,
                                     origin: "https://relayium.com",
                                     pending: PendingUploadSupport(store: store, keys: pendingKeys))
        model.accountId = "acct-1"
        return model
    }

    // MARK: - staging precedes the server

    /// The bytes are ours before a session exists. If the order were reversed a
    /// crash between init and staging would leave a server session with nothing
    /// on this device able to feed it.
    func testTheJobIsStagedBeforeAnyServerSessionOpens() async throws {
        let store = makeStore()
        let transport = OKTransport()
        var planAtInit: PendingUploadPlan?
        transport.onInit = { planAtInit = store.plan(for: "acct-1") }

        let model = makeModel(transport: transport, store: store,
                              pendingKeys: InMemoryStoredLinkKeyStore(),
                              finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value

        XCTAssertNotNil(planAtInit, "the server session opened before the bytes were staged")
    }

    // MARK: - retention across failure

    /// A transient failure keeps the job. The user gets a choice, not a lost
    /// selection — and the staged bytes and pending key are still there to make
    /// that choice mean something.
    func testATransientFailureKeepsTheJobResumable() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let model = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value

        guard case let .interrupted(files, _, message) = model.state else {
            return XCTFail("expected an interrupted job, got \(model.state)")
        }
        XCTAssertEqual(files, 1)
        XCTAssertNotNil(message, "the reason the upload stopped is part of the offer")

        let plan = try XCTUnwrap(store.plan(for: "acct-1"))
        XCTAssertEqual(plan.uploadId, "upload-1")
        XCTAssertEqual(plan.uploadChunkSize, 1 << 20,
                       "the init response's session parameters must survive the process")
        let survivingKey = try await pendingKeys.key(for: plan.jobId)
        XCTAssertNotNil(survivingKey, "the content key must survive with the job")
    }

    /// A new model in a new process finds the job and offers it — and touches
    /// the network not at all. Silent auto-resume would spend a user's data on
    /// an upload they may have abandoned deliberately.
    func testANewModelOffersTheJobAndNeverAutoResumes() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let first = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        first.pick(FileSelection(files: try selection(), emptyDirectories: []))
        first.start(token: "t")
        await first.task?.value

        let forbidden = ForbiddenTransport()
        let reopened = makeModel(transport: forbidden, store: makeStore(),
                                 pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        reopened.recoverPendingJob(for: "acct-1")
        await reopened.recoveryTask?.value

        guard case .interrupted = reopened.state else {
            return XCTFail("a recovered job must be offered, got \(reopened.state)")
        }
        XCTAssertEqual(forbidden.calls, 0, "recovery contacted the server without being asked")
    }

    /// A crash can occur after the atomic plan write and before Keychain save.
    /// The bytes are then undecipherable; presenting Resume would be a promise
    /// the app cannot keep, so recovery removes the orphan instead.
    func testAPlanWithoutItsPendingKeyIsNeverOffered() async throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 3600)
        let forbidden = ForbiddenTransport()
        let reopened = makeModel(transport: forbidden, store: makeStore(),
                                 pendingKeys: InMemoryStoredLinkKeyStore(),
                                 finalKeys: InMemoryStoredLinkKeyStore())

        reopened.recoverPendingJob(for: "acct-1")
        await reopened.recoveryTask?.value

        if case .interrupted = reopened.state {
            XCTFail("a job with no content key was offered for resume")
        }
        XCTAssertNil(store.plan(for: "acct-1"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
        XCTAssertEqual(forbidden.calls, 0)
    }

    func testAPlanWithACorruptedPendingKeyIsNeverOffered() async throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 3600)
        let keys = InMemoryStoredLinkKeyStore()
        try await keys.save(id: plan.jobId, keyB64url: "not-a-32-byte-key")
        let forbidden = ForbiddenTransport()
        let reopened = makeModel(transport: forbidden, store: makeStore(),
                                 pendingKeys: keys, finalKeys: InMemoryStoredLinkKeyStore())

        reopened.recoverPendingJob(for: "acct-1")
        await reopened.recoveryTask?.value

        if case .interrupted = reopened.state {
            XCTFail("a job with an unusable content key was offered for resume")
        }
        XCTAssertNil(store.plan(for: "acct-1"))
        let remainingKey = try await keys.key(for: plan.jobId)
        XCTAssertNil(remainingKey)
        XCTAssertEqual(forbidden.calls, 0)
    }

    func testAKeyCorruptedAfterRecoveryCannotLeaveAFalseResumeOffer() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 3600)
        try await pendingKeys.save(id: plan.jobId,
                                   keyB64url: encodeStoreKey(Array(repeating: 4, count: 32)))
        let model = makeModel(transport: ForbiddenTransport(), store: store,
                              pendingKeys: pendingKeys,
                              finalKeys: InMemoryStoredLinkKeyStore())
        model.recoverPendingJob(for: "acct-1")
        await model.recoveryTask?.value
        guard case .interrupted = model.state else {
            return XCTFail("the valid job was not offered")
        }

        try await pendingKeys.save(id: plan.jobId, keyB64url: "not-a-content-key")
        model.resume(token: "t")
        await model.task?.value

        guard case .failed = model.state else {
            return XCTFail("a corrupted key remained resumable")
        }
        XCTAssertNil(store.plan(for: "acct-1"))
        let remainingKey = try await pendingKeys.key(for: plan.jobId)
        XCTAssertNil(remainingKey)
    }

    func testPreparingIsBusyAndCanBeCancelledWithoutLeavingAJob() async throws {
        let store = makeStore()
        let model = makeModel(transport: OKTransport(), store: store,
                              pendingKeys: InMemoryStoredLinkKeyStore(),
                              finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))

        model.start(token: "t")
        guard case .preparing = model.state else {
            return XCTFail("start did not enter the preparation state synchronously")
        }
        XCTAssertTrue(model.isBusy)
        let running = model.task
        model.cancel()
        await running?.value

        XCTAssertFalse(model.isBusy)
        XCTAssertNil(store.plan(for: "acct-1"))
    }

    func testARecoveryRefreshNeverReplacesAnExistingSelection() async throws {
        let store = makeStore()
        let keys = InMemoryStoredLinkKeyStore()
        let pendingPlan = try store.prepare(files: try selection([9, 9]), accountId: "acct-1",
                                            burnAfterRead: false, ttl: 3600)
        try await keys.save(id: pendingPlan.jobId,
                            keyB64url: encodeStoreKey(Array(repeating: 4, count: 32)))
        let model = makeModel(transport: ForbiddenTransport(), store: store,
                              pendingKeys: keys, finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection([1, 2, 3]), emptyDirectories: []))

        model.recoverPendingJob(for: "acct-1")

        guard case .picked = model.state else {
            return XCTFail("an account refresh replaced the user's current selection")
        }
        XCTAssertNil(model.recoveryTask)
        XCTAssertEqual(store.plan(for: "acct-1")?.jobId, pendingPlan.jobId)
    }

    // MARK: - the explicit choices

    func testResumeFinishesTheJobAndClearsEverythingItLeftBehind() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let finalKeys = InMemoryStoredLinkKeyStore()

        let first = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: finalKeys)
        first.pick(FileSelection(files: try selection(), emptyDirectories: []))
        first.start(token: "t")
        await first.task?.value
        let jobId = try XCTUnwrap(store.plan(for: "acct-1")).jobId
        let stagedKey = try await pendingKeys.key(for: jobId)

        let reopened = makeModel(transport: OKTransport(), store: makeStore(),
                                 pendingKeys: pendingKeys, finalKeys: finalKeys)
        reopened.recoverPendingJob(for: "acct-1")
        await reopened.recoveryTask?.value
        reopened.resume(token: "t")
        await reopened.task?.value

        guard case let .done(link, _, keyWarning) = reopened.state else {
            return XCTFail("expected a finished upload, got \(reopened.state)")
        }
        XCTAssertNil(keyWarning)
        // The key that opens the object is the one the job was staged with.
        let promoted = try await finalKeys.key(for: "stored-1")
        XCTAssertEqual(promoted, stagedKey)
        XCTAssertTrue(link.contains("stored-1"))
        // Nothing recoverable is left: no plan, no staged bytes, no pending key.
        XCTAssertNil(store.plan(for: "acct-1"))
        XCTAssertNil(makeStore().plan(for: "acct-1"))
        let leftoverKey = try await pendingKeys.key(for: jobId)
        XCTAssertNil(leftoverKey)
        XCTAssertNil(reopened.cleanupWarning)
    }

    func testDiscardRemovesTheJobAndItsKey() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let model = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value
        let jobId = try XCTUnwrap(store.plan(for: "acct-1")).jobId

        model.discardPendingJob()
        await model.cleanupTask?.value

        XCTAssertNil(store.plan(for: "acct-1"))
        let discardedKey = try await pendingKeys.key(for: jobId)
        XCTAssertNil(discardedKey)
        if case .interrupted = model.state { XCTFail("discard left the job on screen") }
    }

    // MARK: - completion is not repeatable

    /// The dangerous case: the server has the object, and cleanup fails. The
    /// upload must NOT come back as a resumable job on the next launch — that
    /// would upload the same bytes again and bill the user twice for one file.
    /// The failure is said out loud instead.
    func testAFinalizedJobIsNeverOfferedAgainEvenIfCleanupFails() async throws {
        let store = makeStore()
        let pendingKeys = UndeletableKeyStore()
        let model = makeModel(transport: OKTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value

        guard case .done = model.state else {
            return XCTFail("the upload itself succeeded, got \(model.state)")
        }
        XCTAssertNotNil(model.cleanupWarning, "a cleanup failure must be stated, not swallowed")

        let reopened = makeModel(transport: ForbiddenTransport(), store: makeStore(),
                                 pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        reopened.recoverPendingJob(for: "acct-1")
        await reopened.recoveryTask?.value
        if case .interrupted = reopened.state {
            XCTFail("a finalized upload was offered for resume — it would be uploaded twice")
        }
    }

    /// Cancel normally wins at the check immediately before finalize. If the
    /// request was already in flight, however, a successful server response is
    /// a completed object, not an interrupted upload. Keep the link visible as
    /// long as this same job still owns the screen.
    func testCancelRacingAnInFlightFinalizeShowsTheCompletedLink() async throws {
        let store = makeStore()
        let transport = FinalizeGatedTransport()
        let model = makeModel(transport: transport, store: store,
                              pendingKeys: InMemoryStoredLinkKeyStore(),
                              finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        let running = model.task
        while !(await transport.gate.entered) { await Task.yield() }

        model.cancel()
        guard case .interrupted = model.state else {
            return XCTFail("cancel did not pause the staged job")
        }
        await transport.gate.release()
        await running?.value

        guard case let .done(link, _, _) = model.state else {
            return XCTFail("a server-completed upload was left as interrupted: \(model.state)")
        }
        XCTAssertTrue(link.contains("stored-1"))
        XCTAssertNil(store.plan(for: "acct-1"))
    }

    // MARK: - account isolation

    func testOnlyTheMatchingReadyAccountRecoversTheJob() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let model = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value

        let other = makeModel(transport: ForbiddenTransport(), store: makeStore(),
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        other.accountId = "acct-2"
        other.recoverPendingJob(for: "acct-2")
        await other.recoveryTask?.value
        if case .interrupted = other.state { XCTFail("another account was shown this job") }

        // Signed out entirely: no account, nothing offered.
        let signedOut = makeModel(transport: ForbiddenTransport(), store: makeStore(),
                                  pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        signedOut.accountId = nil
        signedOut.recoverPendingJob(for: nil)
        await signedOut.recoveryTask?.value
        if case .interrupted = signedOut.state { XCTFail("a signed-out app was shown a pending job") }
    }

    /// Sign-out and account switch hide the job SYNCHRONOUSLY — before any
    /// await — and then remove it. A job that stayed on screen for one runloop
    /// turn after the account left is a job the next account can see.
    func testAnAccountChangeHidesTheJobSynchronouslyAndPurgesIt() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let model = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: pendingKeys, finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value
        let jobId = try XCTUnwrap(store.plan(for: "acct-1")).jobId
        guard case .interrupted = model.state else { return XCTFail("expected an interrupted job") }

        model.purgePendingJob()

        if case .interrupted = model.state { XCTFail("the job survived the account leaving") }
        await model.cleanupTask?.value
        XCTAssertNil(store.plan(for: "acct-1"))
        let purgedKey = try await pendingKeys.key(for: jobId)
        XCTAssertNil(purgedKey)
    }

    func testAnAccountLeavingBeforeRecoveryAdoptsThePlanStillPurgesIt() async throws {
        let store = makeStore()
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 3600)
        try await pendingKeys.save(id: plan.jobId,
                                   keyB64url: encodeStoreKey(Array(repeating: 4, count: 32)))
        let model = makeModel(transport: ForbiddenTransport(), store: store,
                              pendingKeys: pendingKeys,
                              finalKeys: InMemoryStoredLinkKeyStore())

        // `job` is deliberately still nil: this is the account-switch window
        // before a recovery scan has adopted the on-disk plan.
        model.purgePendingJob()
        await model.cleanupTask?.value

        XCTAssertNil(store.plan(for: "acct-1"))
        let remainingKey = try await pendingKeys.key(for: plan.jobId)
        XCTAssertNil(remainingKey)
        XCTAssertNil(model.accountId)
        if case .interrupted = model.state {
            XCTFail("an undisplayed outgoing-account job became visible")
        }
    }

    /// A late callback from a superseded attempt must not repaint a screen the
    /// user has moved past — the same generation rule the rest of this model
    /// already lives by, now covering the recovery states.
    func testAStaleRecoveryCallbackRepaintsNothing() async throws {
        let store = makeStore()
        let model = makeModel(transport: DroppingTransport(), store: store,
                              pendingKeys: InMemoryStoredLinkKeyStore(),
                              finalKeys: InMemoryStoredLinkKeyStore())
        model.pick(FileSelection(files: try selection(), emptyDirectories: []))
        model.start(token: "t")
        await model.task?.value
        guard case .interrupted = model.state else { return XCTFail("expected an interrupted job") }

        let stale = model.currentGeneration
        model.discardPendingJob()          // bumps the generation
        model.report(sent: 5, total: 10, g: stale)

        if case .uploading = model.state { XCTFail("a superseded attempt repainted the screen") }
    }
}
