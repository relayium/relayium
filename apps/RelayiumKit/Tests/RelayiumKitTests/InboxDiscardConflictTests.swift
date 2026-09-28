import CryptoKit
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// R2: a job whose id exists in BOTH the shared and the protected root is a
/// conflict nobody acts on (IMPLEMENT binding 3). Discard and every release
/// must preserve both complete trees and the content key, send no cancel, and
/// refuse by type — including when the in-memory plan is stale, and when the
/// collision appears while a cancel or a create is suspended. An owned job
/// must still really be deleted, so retention here cannot be an artifact of a
/// store that fails to delete anything.
final class InboxDiscardConflictTests: XCTestCase {
    private var root: URL!
    private var shared: URL!
    private var store: PendingUploadStore!
    private var keys: InMemoryStoredLinkKeyStore!
    private var fake: FakeInboxSenderTransport!
    private var devicePublicKey = ""

    private let deviceID = "DEVICE0123456789"
    private let keyID = "KEY0123456789abcd"
    private let taskID = "TASK0123456789ab"
    private let storedID = "STORED0123456789"

    /// Delegates to the fake, and runs `onCancel` INSIDE the suspended cancel.
    final class HookedSender: InboxSenderTransport, @unchecked Sendable {
        let inner: FakeInboxSenderTransport
        var onCancel: (() throws -> Void)?
        init(_ inner: FakeInboxSenderTransport) { self.inner = inner }
        func devices() async throws -> [InboxDeviceRow] { try await inner.devices() }
        func renameDevice(deviceID: String, name: String) async throws {
            try await inner.renameDevice(deviceID: deviceID, name: name)
        }
        func createTask(targetDeviceID: String, _ request: InboxSendRequest) async throws -> InboxTaskCreation {
            try await inner.createTask(targetDeviceID: targetDeviceID, request)
        }
        func task(targetDeviceID: String, taskID: String) async throws -> InboxTask {
            try await inner.task(targetDeviceID: targetDeviceID, taskID: taskID)
        }
        func tasks(targetDeviceID: String, limit: Int) async throws -> [InboxTask] {
            try await inner.tasks(targetDeviceID: targetDeviceID, limit: limit)
        }
        func cancelTask(targetDeviceID: String, taskID: String) async throws {
            try onCancel?()
            try await inner.cancelTask(targetDeviceID: targetDeviceID, taskID: taskID)
        }
    }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("discard-conflict-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        shared = root.appendingPathComponent("PendingUploads")
        store = PendingUploadStore(root: shared).protectedDeviceStore()
        keys = InMemoryStoredLinkKeyStore()
        fake = FakeInboxSenderTransport()
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        let key = InboxKey(id: keyID, algorithm: InboxProtocol.keyAlgorithm, publicKey: devicePublicKey,
                           generation: 4, createdAt: 10)
        fake.deviceRows = [InboxDeviceRow(
            id: deviceID, name: "Studio", kind: "mac", isCurrent: false,
            inbox: InboxView(presence: .online, lastHeartbeatAt: 10, presenceExpiresAt: 100,
                             heartbeatIntervalSeconds: 30, protocolVersion: 3,
                             capabilities: InboxProtocol.announcedCapabilities(presentingText: true),
                             receiveCapability: InboxCapability.receiveV3, autoAccept: .auto,
                             receiveDirReady: true, revoked: false, canReceive: true, registeredAt: 10, key: key))]
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    private func coordinator(_ sender: InboxSenderTransport) -> InboxSendCoordinator {
        InboxSendCoordinator(store: store, keys: keys, uploader: CloudUploader(transport: StubTransport()),
                             sender: sender)
    }

    /// A delivery with an object and a task: the shape whose discard cancels.
    private func deliveryWithTask() async throws -> PendingUploadPlan {
        var plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: Array("conflict".utf8))],
                                     accountId: "acct-1", burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: PendingUploadTarget(deviceId: deviceID, keyId: keyID, keyGeneration: 4))
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        plan = try store.fixtureFinalized(plan, storedId: storedID)
        return try store.setDeviceTask(id: taskID, for: plan)
    }

    /// A second, complete copy of the job in the shared root (the collision).
    private func collide(_ jobId: String) throws {
        try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: store.jobURL(for: jobId), to: shared.appendingPathComponent(jobId))
    }

    private func digest(_ dir: URL) -> String {
        var hasher = SHA256()
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return "absent" }
        var files: [URL] = []
        for case let url as URL in e { files.append(url) }
        if files.isEmpty && !FileManager.default.fileExists(atPath: dir.path) { return "absent" }
        for url in files.sorted(by: { $0.path < $1.path }) {
            hasher.update(data: Data(String(url.path.dropFirst(dir.path.count)).utf8))
            if let data = FileManager.default.contents(atPath: url.path) { hasher.update(data: data) }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func refusal(_ body: () async throws -> Void) async -> InboxSendFailure? {
        do { try await body(); return nil } catch { return error as? InboxSendFailure ?? .rejected(status: -1) }
    }

    // MARK: - conflicts

    func testDiscardOfAStalePlanAfterACollisionSendsNothingAndPreservesBothCopiesAndTheKey() async throws {
        let stale = try await deliveryWithTask()            // held in memory, e.g. by a card
        try collide(stale.jobId)
        let protectedBefore = digest(store.jobURL(for: stale.jobId))
        let sharedBefore = digest(shared.appendingPathComponent(stale.jobId))

        let failure = await refusal { try await self.coordinator(self.fake).discard(stale) }

        XCTAssertEqual(failure, .ownershipConflict)
        XCTAssertEqual(fake.calls, [], "a cancel (or any request) left for a conflicting job")
        XCTAssertEqual(digest(store.jobURL(for: stale.jobId)), protectedBefore, "the protected copy changed")
        XCTAssertEqual(digest(shared.appendingPathComponent(stale.jobId)), sharedBefore, "the shared copy changed")
        let key = try await keys.key(for: stale.jobId)
        XCTAssertNotNil(key, "the content key both copies need was removed")
        XCTAssertFalse(store.purge(stale), "the protected purge deleted a conflicting job")
        XCTAssertEqual(digest(store.jobURL(for: stale.jobId)), protectedBefore)
    }

    /// The collision appears while the cancel is suspended: the cancel was
    /// legitimately sent (the job was owned), but the release that follows
    /// must stop before the key, the tombstone or the bytes.
    func testACollisionAppearingDuringASuspendedCancelStopsTheReleaseUntouched() async throws {
        let plan = try await deliveryWithTask()
        let hooked = HookedSender(fake)
        var protectedAtCollision = ""
        hooked.onCancel = { [unowned self] in
            try self.collide(plan.jobId)
            protectedAtCollision = self.digest(self.store.jobURL(for: plan.jobId))
        }
        let failure = await refusal { try await self.coordinator(hooked).discard(plan) }

        XCTAssertEqual(failure, .ownershipConflict)
        XCTAssertEqual(fake.calls, [.cancel(device: deviceID, task: taskID)])
        XCTAssertEqual(digest(store.jobURL(for: plan.jobId)), protectedAtCollision,
                       "the protected copy was retired or deleted after the collision")
        XCTAssertFalse(try XCTUnwrap(store.currentPlanForTesting(jobId: plan.jobId)).retired)
        XCTAssertTrue(FileManager.default.fileExists(atPath: shared.appendingPathComponent(plan.jobId).path))
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(key)
    }

    /// The same, arising during a create whose refusal would otherwise release
    /// the job (`abandon`).
    func testACollisionAppearingDuringACreateThatIsRefusedStopsTheAbandon() async throws {
        var plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: Array("conflict".utf8))],
                                     accountId: "acct-1", burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: PendingUploadTarget(deviceId: deviceID, keyId: keyID, keyGeneration: 4))
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        plan = try store.fixtureFinalized(plan, storedId: storedID)
        fake.beforeCreate = { [unowned self] _ in try? self.collide(plan.jobId) }
        fake.createOutcomes = [.failure(InboxError.api(status: 409, code: InboxRejection.autoReceiveDisabled.rawValue))]

        let failure = await refusal { _ = try await self.coordinator(self.fake).deliver(plan, token: "bearer") }

        XCTAssertEqual(failure, .ownershipConflict)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.planURL(for: plan.jobId).path))
        XCTAssertFalse(try XCTUnwrap(store.currentPlanForTesting(jobId: plan.jobId)).retired)
        XCTAssertTrue(FileManager.default.fileExists(atPath: shared.appendingPathComponent(plan.jobId).path))
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(key)
    }

    /// Only the shared root holds the id (not yet adopted); a stale plan's
    /// discard must not remove the key that copy needs.
    func testADiscardOfAJobOnlyTheSharedRootHoldsKeepsTheKeyAndTheCopy() async throws {
        let plan = try await deliveryWithTask()
        try collide(plan.jobId)
        try FileManager.default.removeItem(at: store.jobURL(for: plan.jobId))
        let sharedBefore = digest(shared.appendingPathComponent(plan.jobId))

        let failure = await refusal { try await self.coordinator(self.fake).discard(plan) }

        XCTAssertEqual(failure, .ownershipConflict)
        XCTAssertEqual(fake.calls, [])
        XCTAssertEqual(digest(shared.appendingPathComponent(plan.jobId)), sharedBefore)
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNotNil(key)
    }

    // MARK: - controls: ordinary ownership still deletes

    /// Positive control: an owned discard cancels and REALLY removes the job
    /// and its key, so the retention above is the guard, not a store that
    /// cannot delete.
    func testAnOwnedDiscardCancelsAndReallyDeletesTheJobAndItsKey() async throws {
        let plan = try await deliveryWithTask()
        try await coordinator(fake).discard(plan)
        XCTAssertEqual(fake.calls, [.cancel(device: deviceID, task: taskID)])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNil(key)
    }

    /// Idempotent: a job already gone from both roots discards cleanly (a
    /// retried cleanup), and a leftover key is removed.
    func testDiscardOfAJobAlreadyGoneFromBothRootsIsIdempotent() async throws {
        let plan = try await deliveryWithTask()
        try FileManager.default.removeItem(at: store.jobURL(for: plan.jobId))
        try await coordinator(fake).discard(plan)
        let key = try await keys.key(for: plan.jobId)
        XCTAssertNil(key)
    }

    // MARK: - Fable finding 2

    /// A pre-v2 delivery whose read-only convergence recorded the task, then
    /// died before its tidy-up (`olderVersion` + object + task on disk): the
    /// recorded-task branch finishes it — no create, no upload.
    func testALegacyOlderVersionPlanWithARecordedTaskFinishesItsRecordedDelivery() async throws {
        let plan = try await deliveryWithTask()
        let url = store.planURL(for: plan.jobId)
        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        json.removeValue(forKey: "inboxProtocolVersion")
        json["terminalOutcome"] = "olderVersion"
        try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)
        fake.taskResults = [.success(InboxTask(id: taskID, targetDeviceID: deviceID, idempotencyKey: "k",
                                               storedFileID: storedID, state: .queued, ciphertextBytes: 64,
                                               targetKeyID: keyID, targetKeyGeneration: 4, expiresAt: 86_500))]
        let current = try XCTUnwrap(store.ownedDevicePlan(jobId: plan.jobId))
        let result = try await coordinator(fake).deliver(current, token: "bearer")
        XCTAssertFalse(result.created)
        XCTAssertEqual(fake.creates, [])
        XCTAssertEqual(fake.calls, [.task(device: deviceID, task: taskID)])
    }

    /// No other terminal can gain a task: `setDeviceTask` refuses.
    func testATerminalJobOtherThanOlderVersionNeverGainsATask() async throws {
        var plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: Array("x".utf8))],
                                     accountId: "acct-1", burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: PendingUploadTarget(deviceId: deviceID, keyId: keyID, keyGeneration: 4))
        plan = try store.setUploadSession(id: "SESSIONTERM00001", chunkSize: 65_536, for: plan)
        plan = try store.markFinalizing(uploadId: "SESSIONTERM00001", for: plan)
        plan = try store.recordTerminal(.expired, uploadId: "SESSIONTERM00001", for: plan)
        XCTAssertThrowsError(try store.setDeviceTask(id: taskID, for: plan)) {
            XCTAssertEqual($0 as? PendingUploadError, .unusableSelection)
        }
    }
}
