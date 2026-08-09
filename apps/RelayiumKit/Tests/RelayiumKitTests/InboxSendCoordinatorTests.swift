import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The durable device send, end to end below the UI: a staged plan becomes
/// ciphertext central holds and exactly ONE task that owns it.
///
/// The interesting cases here are all failures, and they divide along one line
/// that the whole design turns on:
///
///  * **definitive** — central answered, and the answer says no task exists.
///    The create's transaction rolled back, nothing can own the ciphertext, and
///    holding it would be invisible storage the account pays for and cannot see.
///    Release it.
///  * **ambiguous** — the request never arrived, or its answer was lost. A
///    delivery MAY be live. Releasing here would destroy a real transfer, so
///    everything is kept: the staged bytes, the content key, the plan, and above
///    all the idempotency key that is the only thing able to converge the retry.
///
/// Getting that line wrong in either direction is a user-visible disaster —
/// duplicated deliveries on one side, destroyed ones on the other — so most of
/// what follows is an assertion about which side a given failure lands on.
final class InboxSendCoordinatorTests: XCTestCase {
    private var root: URL!
    private var store: PendingUploadStore!
    private var keys: InMemoryStoredLinkKeyStore!
    private var sender: FakeInboxSenderTransport!
    private var objects: FakeStoredObjectService!
    private var transport: StubTransport!

    private let deviceID = "DEVICE0123456789"
    private let keyID = "KEY0123456789abcd"
    private let taskID = "TASK0123456789ab"
    private let idempotencyKey = "8C1A0F3D-2B45-4C6E-9A17-0000000000AA"

    private var devicePublicKey = ""
    private var rotatedKeyID = "KEY9999999999abcd"
    private var rotatedPublicKey = ""

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p3a-coord-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        keys = InMemoryStoredLinkKeyStore()
        sender = FakeInboxSenderTransport()
        objects = FakeStoredObjectService()
        transport = StubTransport()
        transport.finalizeResult = UploadResult(id: "STORED0123456789", expiresAt: 4242)
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        rotatedPublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        sender.deviceRows = [row()]
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - fixtures

    private func row(keyID: String? = nil, publicKey: String? = nil, generation: Int64 = 4,
                     autoAccept: InboxAutoAccept = .auto, revoked: Bool = false,
                     canReceive: Bool = true) -> InboxDeviceRow {
        let key = InboxKey(id: keyID ?? self.keyID, algorithm: InboxProtocol.keyAlgorithm,
                           publicKey: publicKey ?? devicePublicKey, generation: generation,
                           createdAt: 10)
        return InboxDeviceRow(id: deviceID, name: "Studio", kind: "mac", isCurrent: false,
                              inbox: InboxView(presence: .online, lastHeartbeatAt: 10,
                                               presenceExpiresAt: 100,
                                               heartbeatIntervalSeconds: 30, protocolVersion: 1,
                                               capabilities: [InboxCapability.receiveV1],
                                               receiveCapability: InboxCapability.receiveV1,
                                               autoAccept: autoAccept, receiveDirReady: true,
                                               revoked: revoked, canReceive: canReceive,
                                               registeredAt: 10, key: key))
    }

    private func task(id: String? = nil, state: InboxTaskState = .queued,
                      keyID: String? = nil, generation: Int64 = 4,
                      idempotencyKey: String? = nil,
                      storedFileID: String = "STORED0123456789") -> InboxTask {
        InboxTask(id: id ?? taskID, targetDeviceID: deviceID,
                  idempotencyKey: idempotencyKey ?? self.idempotencyKey,
                  storedFileID: storedFileID, state: state, ciphertextBytes: 64,
                  targetKeyID: keyID ?? self.keyID, targetKeyGeneration: generation,
                  expiresAt: 86_500)
    }

    private func coordinator() -> InboxSendCoordinator {
        InboxSendCoordinator(store: store, keys: keys, uploader: CloudUploader(transport: transport),
                             sender: sender, objects: objects)
    }

    private func selection() throws -> [SelectedFile] {
        let url = root.appendingPathComponent("origin-\(UUID().uuidString).txt")
        try Data("hello device inbox".utf8).write(to: url)
        return [SelectedFile(url: url, relativePath: "a.txt")]
    }

    /// A staged delivery with its content key filed, exactly as the picker path
    /// leaves one. Not yet uploaded.
    @discardableResult
    private func staged(keyID: String? = nil, generation: Int64 = 4) async throws
        -> PendingUploadPlan {
        let target = PendingUploadTarget(deviceId: deviceID, keyId: keyID ?? self.keyID,
                                         keyGeneration: generation,
                                         createIdempotencyKey: idempotencyKey)
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds, target: target)
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        return plan
    }

    private func created(_ task: InboxTask, new: Bool = true)
        -> Result<InboxTaskCreation, Error> {
        .success(InboxTaskCreation(task: task, created: new))
    }

    private func refusal(_ token: InboxRejection, status: Int = 409)
        -> Result<InboxTaskCreation, Error> {
        .failure(InboxError.api(status: status, code: token.rawValue))
    }

    private func assertJobIsGone(_ plan: PendingUploadPlan,
                                 file: StaticString = #filePath, line: UInt = #line) async throws {
        XCTAssertNil(store.deviceSendPlans(for: "acct-1").first, file: file, line: line)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path),
                       "the staged plaintext copies must not outlive a finished send",
                       file: file, line: line)
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNil(key, "the content key must not outlive a finished send",
                     file: file, line: line)
    }

    private func assertJobIsIntact(_ plan: PendingUploadPlan,
                                   file: StaticString = #filePath, line: UInt = #line) async throws {
        let held = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first,
                                 file: file, line: line)
        XCTAssertEqual(held.jobId, plan.jobId, file: file, line: line)
        XCTAssertEqual(held.createIdempotencyKey, idempotencyKey,
                       "the key that converges the retry must survive",
                       file: file, line: line)
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(key, "the content key must survive an ambiguous outcome",
                        file: file, line: line)
        XCTAssertEqual(objects.deleted, [], "an ambiguous outcome must release nothing",
                       file: file, line: line)
    }

    // MARK: - the delivery

    func testAStagedDeliveryUploadsAsADeviceTaskSealsAndCreatesExactlyOneTask() async throws {
        let plan = try await staged()
        sender.createOutcomes = [created(task())]

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(result.task.id, taskID)
        XCTAssertTrue(result.created)
        XCTAssertFalse(result.resealed)
        XCTAssertEqual(sender.creates.count, 1)
        XCTAssertEqual(transport.purposes, [.deviceTask], """
            the object's authorization model is decided by this field; a share \
            here would publish the user's delivery as a public link
            """)
    }

    func testTheCreateCarriesThePlansOwnIdempotencyKeyObjectAndTargetKeyIdentity() async throws {
        let plan = try await staged()
        sender.createOutcomes = [created(task())]
        _ = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(sender.createdIdempotencyKeys, [idempotencyKey])
        XCTAssertEqual(sender.createdKeyIdentities, ["\(keyID)/4"])
        guard case .create(let device, _, let storedFile, let wrapped, _, _)
                = try XCTUnwrap(sender.creates.first) else { return XCTFail("no create") }
        XCTAssertEqual(device, deviceID)
        XCTAssertEqual(storedFile, "STORED0123456789")
        // A real sealed box, not a placeholder: the same length and spelling the
        // receiver's `unsealContentKey` decodes.
        XCTAssertEqual(try InboxKeyMaterial.decode(wrapped,
                                                   expecting: InboxProtocol.sealedBoxBytes).count,
                       InboxProtocol.sealedBoxBytes)
    }

    /// The content key is sealed to the device, and is not left anywhere the
    /// delivery's own metadata could be read with it.
    func testTheContentKeySealsToTheTargetAndTheTargetCanOpenIt() async throws {
        let pair = try InboxKeyMaterial.generateKeyPair()
        devicePublicKey = InboxKeyMaterial.encode(pair.publicKey)
        sender.deviceRows = [row()]
        let plan = try await staged()
        let storedKey = try await keys.key(for: plan.jobId)
        let contentKey = try decodeStoreKey(try XCTUnwrap(storedKey))
        sender.createOutcomes = [created(task())]

        _ = try await coordinator().deliver(plan, token: "bearer")

        let wrapped = try XCTUnwrap(sender.createdWrappedKeys.first)
        let opened = try InboxKeyMaterial.unsealContentKey(algorithm: InboxProtocol.keyAlgorithm,
                                                           wrappedKey: wrapped, keyPair: pair)
        XCTAssertEqual(opened, contentKey, """
            the delivery is only openable if the bytes sealed are the exact \
            content key the ciphertext was encrypted under
            """)
    }

    func testASuccessfulDeliveryReleasesTheStagedBytesThePlanAndTheContentKey() async throws {
        let plan = try await staged()
        sender.createOutcomes = [created(task())]
        _ = try await coordinator().deliver(plan, token: "bearer")
        try await assertJobIsGone(plan)
        XCTAssertEqual(objects.deleted, [], "a delivered object belongs to its task now")
    }

    /// The crash window. If the task id were written after cleanup, a process
    /// that died in between would come back to a plan that looks unsent and
    /// would try to send it again.
    func testTheTaskIdIsPersistedBeforeAnythingIsReleased() async throws {
        // The content key is the FIRST thing the release touches. A key store
        // that reads the plan at that instant therefore observes the earliest
        // moment of the tidy-up, and the task id has to be on disk already.
        let observing = ObservingKeyStore(inner: keys, onRemove: { [store] in
            store?.deviceSendPlans(for: "acct-1").first?.deviceTaskId
        })
        keys = InMemoryStoredLinkKeyStore()
        let plan = try await staged()
        observing.inner = keys
        sender.createOutcomes = [created(task())]
        let coordinator = InboxSendCoordinator(store: store, keys: observing,
                                               uploader: CloudUploader(transport: transport),
                                               sender: sender, objects: objects)

        _ = try await coordinator.deliver(plan, token: "bearer")

        XCTAssertEqual(observing.observed, taskID, """
            written before the tidy-up, so a process that dies mid-cleanup comes \
            back knowing the delivery exists instead of sending it again
            """)
    }

    private final class ObservingKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        var inner: InMemoryStoredLinkKeyStore
        private let onRemove: () -> String?
        private(set) var observed: String?

        init(inner: InMemoryStoredLinkKeyStore, onRemove: @escaping () -> String?) {
            self.inner = inner
            self.onRemove = onRemove
        }

        func save(id: String, keyB64url: String) async throws {
            try await inner.save(id: id, keyB64url: keyB64url)
        }

        func key(for id: String) async throws -> String? { try await inner.key(for: id) }

        func remove(id: String) async throws {
            if observed == nil { observed = onRemove() }
            try await inner.remove(id: id)
        }
    }

    private final class ReadFailingKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        let inner: InMemoryStoredLinkKeyStore

        init(inner: InMemoryStoredLinkKeyStore) { self.inner = inner }

        func save(id: String, keyB64url: String) async throws {
            try await inner.save(id: id, keyB64url: keyB64url)
        }

        func key(for id: String) async throws -> String? { throw InboxError.network }

        func remove(id: String) async throws { try await inner.remove(id: id) }
    }

    func testATemporaryContentKeyReadFailureKeepsTheWholeJobForRetry() async throws {
        let plan = try await staged()
        let coordinator = InboxSendCoordinator(
            store: store, keys: ReadFailingKeyStore(inner: keys),
            uploader: CloudUploader(transport: transport), sender: sender, objects: objects)

        await XCTAssertThrowsErrorAsync(try await coordinator.deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .recoveryStateReadFailed)
        }

        XCTAssertEqual(sender.calls, [], "a local protected-storage error touches no network")
        try await assertJobIsIntact(plan)
    }

    /// Central has already returned a real task, but the atomic local plan write
    /// fails. Cleanup here would erase the only durable inputs that can converge
    /// a retry, and catching this as another create error would make the local
    /// failure look like a network ambiguity.
    func testATaskIdWriteFailureKeepsAllRecoveryStateAndDoesNotCreateAgain() async throws {
        let plan = try await staged()
        let jobURL = store.jobURL(for: plan.jobId)
        sender.createOutcomes = [created(task())]
        sender.beforeCreate = { _ in
            try? FileManager.default.setAttributes([.posixPermissions: 0o500],
                                                   ofItemAtPath: jobURL.path)
        }

        var caught: Error?
        do {
            _ = try await coordinator().deliver(plan, token: "bearer")
        } catch {
            caught = error
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700],
                                              ofItemAtPath: jobURL.path)

        XCTAssertEqual(caught as? InboxSendFailure, .recoveryStateWriteFailed)
        XCTAssertEqual(sender.creates.count, 1,
                       "a local state-write failure must not enter the create retry loop")
        XCTAssertNil(store.deviceSendPlans(for: "acct-1").first?.deviceTaskId)
        XCTAssertEqual(objects.deleted, [], "the live task owns the object")
        try await assertJobIsIntact(plan)
    }

    func testTheRandomizedWrappedKeyIsPersistedBeforeCreateAndReusedAcrossProcesses() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.tasksError = InboxError.network

        await XCTAssertThrowsErrorAsync(try await coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        let firstAttempt = try XCTUnwrap(sender.createdWrappedKeys.first)
        XCTAssertEqual(Set(sender.createdWrappedKeys), [firstAttempt])
        let reloaded = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(reloaded.targetWrappedKey, firstAttempt)

        // A new coordinator/process must replay byte-for-byte. Sealed-box
        // encryption is randomized, so recomputing here would conflict with
        // the task central may already have created.
        sender.createOutcomes = [created(task(), new: false)]
        sender.tasksError = nil
        let result = try await coordinator().deliver(reloaded, token: "bearer")

        XCTAssertFalse(result.created)
        XCTAssertEqual(sender.createdWrappedKeys.last, firstAttempt)
        XCTAssertEqual(Set(sender.createdWrappedKeys), [firstAttempt])
    }

    func testAWrappedKeyWriteFailureStopsBeforeCreateAndKeepsTheJob() async throws {
        let plan = try await staged()
        let uploaded = try store.markFinalized(plan, storedId: "STORED0123456789")
        let jobURL = store.jobURL(for: plan.jobId)
        try FileManager.default.setAttributes([.posixPermissions: 0o500],
                                              ofItemAtPath: jobURL.path)
        var caught: Error?
        do {
            _ = try await coordinator().deliver(uploaded, token: "bearer")
        } catch {
            caught = error
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700],
                                              ofItemAtPath: jobURL.path)

        XCTAssertEqual(caught as? InboxSendFailure, .recoveryStateWriteFailed)
        XCTAssertEqual(sender.creates.count, 0)
        XCTAssertEqual(objects.deleted, [])
        try await assertJobIsIntact(uploaded)
    }

    // MARK: - ambiguity

    func testAnOldPlanIdempotencyConflictConvergesWithoutDeletingTheBoundObject() async throws {
        let plan = try await staged()
        // Plans written by the previous build have no durable sealed box. If an
        // earlier create landed, this build's newly randomized box conflicts
        // even though the idempotency key correctly identifies the live task.
        XCTAssertNil(plan.targetWrappedKey)
        sender.createOutcomes = [refusal(.idempotencyKeyConflict)]
        sender.listedTasks = [task()]

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertFalse(result.created)
        XCTAssertEqual(result.task.id, taskID)
        XCTAssertEqual(objects.deleted, [], "the existing task owns this ciphertext")
        try await assertJobIsGone(plan)
    }

    func testIdempotencyConflictWithoutAVisibleTaskRemainsUnknownAndKeepsEverything() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.idempotencyKeyConflict)]
        sender.listedTasks = [task(id: "SOMEONEELSES123",
                                   idempotencyKey: "a-different-send")]

        await XCTAssertThrowsErrorAsync(try await coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        XCTAssertEqual(sender.creates.count, 1, "a conflict is evidence, not a retry prompt")
        XCTAssertEqual(objects.deleted, [])
        try await assertJobIsIntact(plan)
    }

    func testIdempotencyConflictNeverConvergesOntoAnotherObjectsTask() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.idempotencyKeyConflict)]
        sender.listedTasks = [task(storedFileID: "ANOTHEROBJECT123")]

        await XCTAssertThrowsErrorAsync(try await coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        XCTAssertEqual(objects.deleted, [])
        try await assertJobIsIntact(plan)
    }

    func testALostCreateAnswerConvergesOnTheSameTaskWithoutASecondDelivery() async throws {
        let plan = try await staged()
        // The first attempt reaches central and its answer is lost; the retry
        // is answered 200 with the task the first one actually made.
        sender.createOutcomes = [.failure(InboxError.network),
                                 created(task(), new: false)]

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(result.task.id, taskID)
        XCTAssertFalse(result.created, """
            a converged retry is not a new delivery, and reporting it as one \
            would tell the user a second copy is on its way
            """)
        XCTAssertEqual(sender.createdIdempotencyKeys, [idempotencyKey, idempotencyKey])
    }

    /// The adversarial case the whole durable design exists for: EVERY create
    /// attempt must carry the key that was minted once, on disk, before any
    /// network work. A fresh key on any attempt queues the same bytes twice.
    func testNoRetryEverMintsASecondIdempotencyKey() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.listedTasks = []

        await XCTAssertThrowsErrorAsync(try await coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }

        XCTAssertGreaterThan(sender.createdIdempotencyKeys.count, 1)
        XCTAssertEqual(Set(sender.createdIdempotencyKeys), [idempotencyKey])
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1").first?.createIdempotencyKey,
                       idempotencyKey)
        try await assertJobIsIntact(plan)
    }

    func testWhenEveryAttemptIsAmbiguousTheTaskIsLookedUpByItsIdempotencyKey() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.listedTasks = [task()]

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertEqual(result.task.id, taskID)
        XCTAssertFalse(result.created)
        XCTAssertEqual(objects.deleted, [], "the delivery is real; nothing may be released")
    }

    /// The most dangerous branch in the file. Nobody knows whether a delivery
    /// exists, so nothing may be destroyed on a guess.
    func testAnUnknownOutcomeRetainsTheCiphertextThePlanTheKeyAndTheIdempotencyKey() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.tasksError = InboxError.network

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        try await assertJobIsIntact(plan)
    }

    /// A bounded recent-task page is useful for a positive convergence match,
    /// but absence is not proof: the task can be outside the page or its timed-
    /// out create can still be committing. Nothing may be released on that
    /// observation.
    func testAbsenceFromTheRecentTaskPageRemainsUnknownAndKeepsTheJob() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.network)]
        // Somebody else's task on the same device. It must not be mistaken for
        // this send's, which is the entire job of the idempotency key.
        sender.listedTasks = [task(id: "SOMEONEELSES123", state: .queued,
                                   idempotencyKey: "a-different-send")]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        XCTAssertEqual(objects.deleted, [])
        try await assertJobIsIntact(plan)
    }

    /// A 5xx is not an answer. The write may have landed.
    func testAServerErrorIsTreatedAsAmbiguousRatherThanAsARefusal() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.api(status: 503, code: ""))]
        sender.tasksError = InboxError.network

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        try await assertJobIsIntact(plan)
    }

    /// A relaunch that finds a task id already on disk must never create again.
    func testARelaunchAfterTheTaskWasRecordedFinishesInsteadOfCreatingAgain() async throws {
        let plan = try await staged()
        let finalized = try store.markFinalized(plan, storedId: "STORED0123456789")
        let recorded = try store.setDeviceTask(id: taskID, for: finalized)
        sender.taskResults = [.success(task(state: .saved))]

        let result = try await coordinator().deliver(recorded, token: "bearer")

        XCTAssertEqual(result.task.state, .saved)
        XCTAssertFalse(result.created)
        XCTAssertEqual(sender.creates.count, 0, """
            the delivery already exists; a create here would be a second one \
            only the idempotency key stands between the user and
            """)
        try await assertJobIsGone(recorded)
    }

    func testARecordedTaskThatCannotBeReadLeavesTheJobIntact() async throws {
        let plan = try await staged()
        let recorded = try store.setDeviceTask(
            id: taskID, for: try store.markFinalized(plan, storedId: "STORED0123456789"))
        sender.taskResults = [.failure(InboxError.network)]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(recorded, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
        }
        try await assertJobIsIntact(recorded)
    }

    // MARK: - the one reseal

    /// The device rotated between the moment the target was chosen and the
    /// moment the send ran. One refresh, one reseal, and nothing else moves.
    func testARotationFoundBeforeTheCreateResealsOnceToTheCurrentKey() async throws {
        let plan = try await staged()
        sender.deviceRows = [row(keyID: rotatedKeyID, publicKey: rotatedPublicKey,
                                 generation: 9)]
        sender.createOutcomes = [created(task(keyID: rotatedKeyID, generation: 9))]

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertTrue(result.resealed)
        XCTAssertEqual(sender.createdKeyIdentities, ["\(rotatedKeyID)/9"])
        XCTAssertEqual(sender.createdIdempotencyKeys, [idempotencyKey])
    }

    /// Central refusing the create is the same event arriving a moment later,
    /// and it must be answered the same way — with the SAME object and the SAME
    /// idempotency key, and without re-uploading a byte.
    func testAStaleTargetKeyRefusalIsAnsweredByOneRefreshResealAndRetry() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.staleTargetKey),
                                 created(task(keyID: rotatedKeyID, generation: 9))]
        // The rotation becomes visible only after the first create was refused,
        // which is exactly the race this branch exists for.
        sender.beforeCreate = { [self] attempt in
            if attempt == 0 {
                sender.deviceRows = [row(keyID: rotatedKeyID, publicKey: rotatedPublicKey,
                                          generation: 9)]
            }
        }

        let result = try await coordinator().deliver(plan, token: "bearer")

        XCTAssertTrue(result.resealed)
        XCTAssertEqual(sender.createdKeyIdentities, ["\(keyID)/4", "\(rotatedKeyID)/9"])
        XCTAssertEqual(sender.createdIdempotencyKeys, [idempotencyKey, idempotencyKey])
        XCTAssertEqual(sender.creates.count, 2)
        XCTAssertEqual(transport.initCount, 1, """
            the reseal happens after the upload precisely so a rotation costs one \
            cheap wrap, never a second copy of the user's file on the wire
            """)
    }

    func testTheResealChangesTheWrappedKeyButNeitherTheObjectNorTheCiphertext() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.staleTargetKey),
                                 created(task(keyID: rotatedKeyID, generation: 9))]
        sender.beforeCreate = { [self] attempt in
            if attempt == 0 {
                sender.deviceRows = [row(keyID: rotatedKeyID, publicKey: rotatedPublicKey,
                                          generation: 9)]
            }
        }
        _ = try await coordinator().deliver(plan, token: "bearer")

        let wrapped = sender.createdWrappedKeys
        XCTAssertEqual(wrapped.count, 2)
        XCTAssertNotEqual(wrapped[0], wrapped[1], "the second create wraps to the new key")
        let objectIDs = sender.creates.compactMap { call -> String? in
            if case .create(_, _, let storedFile, _, _, _) = call { return storedFile }
            return nil
        }
        XCTAssertEqual(objectIDs, ["STORED0123456789", "STORED0123456789"],
                       "the same ciphertext, bound by whichever create succeeds")
        XCTAssertEqual(transport.initCount, 1)
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1").first?.jobId, nil,
                       "the delivery succeeded, so the job is released")
    }

    /// The budget is one. A device rotating again immediately is a device this
    /// send cannot catch, and chasing it forever would re-wrap in a loop.
    func testASecondRotationAfterTheBudgetIsSpentFailsRatherThanResealingAgain() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.staleTargetKey), refusal(.staleTargetKey)]
        sender.beforeCreate = { [self] attempt in
            if attempt == 0 {
                sender.deviceRows = [row(keyID: rotatedKeyID, publicKey: rotatedPublicKey,
                                          generation: 9)]
            }
        }

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .staleTargetKey)
        }
        XCTAssertEqual(sender.creates.count, 2, "no third attempt")
        XCTAssertEqual(objects.deleted, ["STORED0123456789"],
                       "a refused create rolled back, so no task can own this object")
    }

    /// Durability of the budget: a plan that already resealed in a previous
    /// process gets no second one.
    func testAPlanThatAlreadyResealedInAPreviousProcessGetsNoSecondReseal() async throws {
        let plan = try await staged()
        let resealedBox = InboxKeyMaterial.encode(
            [UInt8](repeating: 7, count: InboxProtocol.sealedBoxBytes))
        let already = try store.resealTargetKey(id: rotatedKeyID, generation: 9,
                                                wrappedKey: resealedBox, for: plan)
        sender.deviceRows = [row(keyID: "KEY7777777777abcd", publicKey: rotatedPublicKey,
                                 generation: 11)]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(already, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .staleTargetKey)
        }
        XCTAssertEqual(sender.creates.count, 0, "a key it cannot seal to is not worth a create")
    }

    /// The budget being spent is a DEFINITIVE dead end, so the ciphertext it
    /// left behind has to go back. Without this the job would be purged and its
    /// object would sit in the account's storage, unreachable and unnamed, until
    /// the server's collector noticed.
    func testASpentBudgetOnAnUploadedDeliveryStillReleasesTheObject() async throws {
        let plan = try await staged()
        let uploaded = try store.markFinalized(plan, storedId: "STORED0123456789")
        let resealedBox = InboxKeyMaterial.encode(
            [UInt8](repeating: 7, count: InboxProtocol.sealedBoxBytes))
        let already = try store.resealTargetKey(id: rotatedKeyID, generation: 9,
                                                wrappedKey: resealedBox, for: uploaded)
        sender.deviceRows = [row(keyID: "KEY7777777777abcd", publicKey: rotatedPublicKey,
                                 generation: 11)]

        await XCTAssertThrowsErrorAsync(
            try await self.coordinator().deliver(already, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .staleTargetKey)
        }
        XCTAssertEqual(objects.deleted, ["STORED0123456789"])
        try await assertJobIsGone(already)
    }

    // MARK: - a credential that expired mid-send

    /// A signed-out session is the one definitive refusal that must not destroy
    /// anything. The create provably did not happen, but the remedy is local and
    /// self-healing — sign in and retry with the same key — and the release call
    /// would be made with the very bearer that was just rejected, so it would
    /// fail and leave the object orphaned anyway.
    func testAnExpiredCredentialKeepsTheJobIntactForARetryAfterSigningIn() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.api(status: 401, code: ""))]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .notAuthorized)
        }
        XCTAssertEqual(sender.creates.count, 1, "a credential problem is not retried on the wire")
        try await assertJobIsIntact(plan)
    }

    func testAnExpiredCredentialOnTheDeviceListAlsoKeepsTheJob() async throws {
        let plan = try await staged()
        sender.devicesError = InboxError.api(status: 403, code: "")

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .notAuthorized)
        }
        try await assertJobIsIntact(plan)
    }

    /// A rotation this send cannot follow — the device has no usable current
    /// key at all — must fail honestly rather than retry against nothing.
    func testADeviceWithNoUsableCurrentKeyFailsRatherThanResealingToNothing() async throws {
        let plan = try await staged()
        sender.deviceRows = [row(publicKey: InboxKeyMaterial.encode([UInt8](repeating: 0,
                                                                           count: 32)))]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .targetUnavailable(.unsupportedKey))
        }
    }

    // MARK: - target eligibility at the moment of sending

    func testADeviceThatLeftTheAccountIsADefinitiveFailure() async throws {
        let plan = try await staged()
        sender.deviceRows = []

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .targetMissing)
        }
        XCTAssertEqual(objects.deleted, [], "nothing was uploaded, so there is nothing to release")
        try await assertJobIsGone(plan)
    }

    func testADeviceThatTurnedReceivingOffIsRefusedByNameBeforeAnythingIsUploaded() async throws {
        let plan = try await staged()
        sender.deviceRows = [row(autoAccept: .off)]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .targetUnavailable(.receiveOff))
        }
        XCTAssertEqual(transport.initCount, 0, """
            eligibility is checked before the upload so a refusal costs the user \
            nothing rather than an entire encrypted transfer
            """)
    }

    func testARevokedDeviceIsRefusedAsRevokedRatherThanAsAKeyProblem() async throws {
        let plan = try await staged()
        sender.deviceRows = [row(revoked: true, canReceive: false)]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .targetUnavailable(.revoked))
        }
    }

    // MARK: - definitive refusals

    func testADefinitiveRefusalReleasesTheObjectAndTheJob() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.autoReceiveDisabled)]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .refused(.autoReceiveDisabled))
        }
        XCTAssertEqual(sender.creates.count, 1, "a definitive no is not retried")
        XCTAssertEqual(objects.deleted, ["STORED0123456789"])
        try await assertJobIsGone(plan)
    }

    /// The one definitive refusal that must NOT release: central says some
    /// other task already owns this object. Deleting it would destroy a
    /// delivery this send cannot see and did not create.
    func testAnObjectAlreadyBoundToAnotherTaskIsNeverDeleted() async throws {
        let plan = try await staged()
        sender.createOutcomes = [refusal(.storedObjectAlreadyBound)]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .refused(.storedObjectAlreadyBound))
        }
        XCTAssertEqual(objects.deleted, [], """
            the object is bound to a task we do not own; releasing it would \
            destroy somebody else's live delivery to tidy up ours
            """)
    }

    func testAnUnrecognisedDefinitiveRejectionIsReportedByStatusRatherThanGuessed() async throws {
        let plan = try await staged()
        sender.createOutcomes = [.failure(InboxError.api(status: 402, code: "quota_exhausted"))]

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .rejected(status: 402))
        }
        XCTAssertEqual(objects.deleted, ["STORED0123456789"])
    }

    // MARK: - guards

    func testAnOrdinarySharePlanIsRefusedOutright() async throws {
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 3600)
        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .notADelivery)
        }
        XCTAssertEqual(sender.calls, [], "a share must not even read the device list")
    }

    /// The bytes are up and nothing on this device can seal them. Continuing
    /// would create a task no target could ever open.
    func testALostContentKeyFailsAndReleasesRatherThanSealingSomethingElse() async throws {
        let plan = try await staged()
        try await keys.remove(id: plan.jobId)

        await XCTAssertThrowsErrorAsync(try await self.coordinator().deliver(plan, token: "bearer")) {
            XCTAssertEqual($0 as? InboxSendFailure, .contentKeyMissing)
        }
        XCTAssertEqual(sender.creates.count, 0)
        try await assertJobIsGone(plan)
    }

    // MARK: - polling and cancelling

    func testPollingReadsTheTaskOnTheDeviceThatOwnsIt() async throws {
        let plan = try await staged()
        sender.createOutcomes = [created(task())]
        let result = try await coordinator().deliver(plan, token: "bearer")
        sender.taskResults = [.success(task(state: .downloading))]

        let polled = try await coordinator().state(of: result)

        XCTAssertEqual(polled.state, .downloading)
        XCTAssertEqual(sender.calls.last, .task(device: deviceID, task: taskID))
    }

    func testCancellingDeletesTheTaskCentralHolds() async throws {
        let plan = try await staged()
        sender.createOutcomes = [created(task())]
        let result = try await coordinator().deliver(plan, token: "bearer")

        try await coordinator().cancel(result)

        XCTAssertEqual(sender.calls.last, .cancel(device: deviceID, task: taskID))
    }

    /// Central refuses to delete a task a device is actively downloading, and
    /// that refusal has to reach the caller rather than be reported as done.
    func testACancelCentralRefusesIsNotReportedAsCancelled() async throws {
        let plan = try await staged()
        sender.createOutcomes = [created(task())]
        let result = try await coordinator().deliver(plan, token: "bearer")
        sender.cancelError = InboxError.api(status: 409, code: InboxRejection.taskTerminal.rawValue)

        await XCTAssertThrowsErrorAsync(try await self.coordinator().cancel(result)) { _ in }
    }

    /// Abandoning a delivery that has no task yet: nothing exists on central to
    /// cancel, so this is purely the local release plus the object's quota.
    func testDiscardingADeliveryBeforeItsTaskExistsReleasesEverything() async throws {
        let plan = try await staged()
        let finalized = try store.markFinalized(plan, storedId: "STORED0123456789")

        try await coordinator().discard(finalized, token: "bearer")

        XCTAssertEqual(objects.deleted, ["STORED0123456789"])
        XCTAssertEqual(sender.calls, [], "there is no task to cancel")
        try await assertJobIsGone(plan)
    }

    /// A discard on a job whose bytes never reached the server touches the
    /// network not at all.
    func testDiscardingABeforeUploadDeliveryTouchesNothingRemote() async throws {
        let plan = try await staged()
        try await coordinator().discard(plan, token: "bearer")
        XCTAssertEqual(objects.deleted, [])
        try await assertJobIsGone(plan)
    }
}
