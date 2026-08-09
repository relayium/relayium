import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The durable state a device send adds ON TOP of the staged plan, and the
/// rules that make a crash at any point in the sequence recoverable.
///
/// A device send has three durable facts beyond an ordinary upload, and each of
/// them exists because of one specific way a user would otherwise lose or
/// duplicate a file:
///
///  - **the created task id.** Written the instant central definitively answers,
///    BEFORE any cleanup. A process that died in that window must come back
///    knowing the delivery already exists; without this it would retry the
///    create, and while the idempotency key would converge it, nothing would
///    stop a *cancel-and-restage* path from queueing the bytes twice;
///  - **the reseal marker.** A rotation may be answered by exactly one refresh
///    and reseal. Kept on disk rather than in a loop counter, so a force-quit
///    between the two attempts cannot silently hand the send a fresh budget and
///    turn "at most one" into "once per launch";
///  - **the target key identity.** Updated in place by that one reseal, so a
///    retry after a relaunch seals to the key the previous attempt chose rather
///    than re-deciding from scratch.
///
/// Everything here is additive and optional, and the plan version is
/// deliberately NOT bumped — bumping it would strand every interrupted upload on
/// every existing install.
final class PendingUploadDeviceSendStateTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p3a-send-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - helpers

    private func makeStore() -> PendingUploadStore {
        PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
    }

    private func selection(_ name: String = "a.txt") throws -> [SelectedFile] {
        let url = root.appendingPathComponent("origin-\(UUID().uuidString)-\(name)")
        try Data("hello".utf8).write(to: url)
        return [SelectedFile(url: url, relativePath: name)]
    }

    private func target(idempotencyKey: String = "8C1A0F3D-2B45-4C6E-9A17-0000000000AA")
        -> PendingUploadTarget {
        PendingUploadTarget(deviceId: "DEVICE0123456789", keyId: "KEY0123456789ab",
                            keyGeneration: 4, createIdempotencyKey: idempotencyKey)
    }

    private func wrapped(_ byte: UInt8 = 7) -> String {
        InboxKeyMaterial.encode([UInt8](repeating: byte, count: InboxProtocol.sealedBoxBytes))
    }

    /// A staged device delivery whose ciphertext is already on the server.
    private func uploaded(_ store: PendingUploadStore) throws -> PendingUploadPlan {
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: target())
        return try store.markFinalized(plan, storedId: "STORED0123456789")
    }

    private func share(_ store: PendingUploadStore) throws -> PendingUploadPlan {
        try store.prepare(files: try selection(), accountId: "acct-1",
                          burnAfterRead: false, ttl: 3600)
    }

    private func planJSON(_ store: PendingUploadStore, _ jobId: String) throws -> [String: Any] {
        let data = try Data(contentsOf: store.planURL(for: jobId))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func rewrite(_ store: PendingUploadStore, _ jobId: String,
                         _ transform: (inout [String: Any]) -> Void) throws {
        var object = try planJSON(store, jobId)
        transform(&object)
        try JSONSerialization.data(withJSONObject: object)
            .write(to: store.planURL(for: jobId), options: .atomic)
    }

    // MARK: - the created task id

    func testTheCreatedTaskIdIsPersistedAndSurvivesAReloadInANewStore() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        XCTAssertNil(plan.deviceTaskId)
        let updated = try store.setDeviceTask(id: "TASK0123456789ab", for: plan)
        XCTAssertEqual(updated.deviceTaskId, "TASK0123456789ab")
        let reloaded = try XCTUnwrap(makeStore().deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(reloaded.deviceTaskId, "TASK0123456789ab")
    }

    /// One plan, one delivery. Recording a second task id would mean this job's
    /// ciphertext is claimed by two rows, and nothing could then decide which
    /// one to cancel.
    func testASecondDifferentTaskIdIsRefusedRatherThanOverwritten() throws {
        let store = makeStore()
        let plan = try store.setDeviceTask(id: "TASK0123456789ab", for: try uploaded(store))
        XCTAssertThrowsError(try store.setDeviceTask(id: "OTHER123456789ab", for: plan))
        XCTAssertEqual(try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first).deviceTaskId,
                       "TASK0123456789ab")
    }

    /// Re-recording the SAME id is how a retried cleanup gets through. It has
    /// to be a no-op success, not a refusal.
    func testRecordingTheSameTaskIdAgainSucceeds() throws {
        let store = makeStore()
        let plan = try store.setDeviceTask(id: "TASK0123456789ab", for: try uploaded(store))
        XCTAssertEqual(try store.setDeviceTask(id: "TASK0123456789ab", for: plan).deviceTaskId,
                       "TASK0123456789ab")
    }

    func testATaskIdThatCouldNotBecomeAPathComponentIsRefused() throws {
        let store = makeStore()
        XCTAssertThrowsError(try store.setDeviceTask(id: "../../etc", for: try uploaded(store)))
    }

    func testAShareplanCanNeverRecordATaskId() throws {
        let store = makeStore()
        XCTAssertThrowsError(try store.setDeviceTask(id: "TASK0123456789ab",
                                                     for: try share(store))) { error in
            XCTAssertEqual(error as? PendingUploadError, .stagingMissing)
        }
    }

    // MARK: - the one reseal

    func testTheRandomizedWrappedKeyPersistsAndCannotBeReplaced() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        let updated = try store.setTargetWrappedKey(wrapped(), for: plan)
        XCTAssertEqual(updated.targetWrappedKey, wrapped())
        XCTAssertEqual(try XCTUnwrap(makeStore().deviceSendPlans(for: "acct-1").first)
            .targetWrappedKey, wrapped())
        XCTAssertEqual(try store.setTargetWrappedKey(wrapped(), for: updated), updated)
        XCTAssertThrowsError(try store.setTargetWrappedKey(wrapped(8), for: updated))
    }

    func testMalformedWrappedKeyIsNeverMadeDurable() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        XCTAssertThrowsError(try store.setTargetWrappedKey("not-a-sealed-box", for: plan))
        XCTAssertNil(try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
            .targetWrappedKey)
    }

    func testResealingRecordsTheNewKeyIdentityAndSpendsTheBudget() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        XCTAssertFalse(plan.targetKeyWasResealed)
        let updated = try store.resealTargetKey(id: "KEY9999999999ab", generation: 9,
                                                wrappedKey: wrapped(), for: plan)
        XCTAssertEqual(updated.targetKeyId, "KEY9999999999ab")
        XCTAssertEqual(updated.targetKeyGeneration, 9)
        XCTAssertTrue(updated.targetKeyWasResealed)
        XCTAssertEqual(updated.target?.keyId, "KEY9999999999ab")
        XCTAssertEqual(updated.targetWrappedKey, wrapped())
    }

    /// The property this whole marker exists for: the budget is durable, so a
    /// force-quit between two create attempts cannot refill it.
    func testASecondResealIsRefusedEvenAfterAReloadInANewStore() throws {
        let store = makeStore()
        _ = try store.resealTargetKey(id: "KEY9999999999ab", generation: 9,
                                      wrappedKey: wrapped(), for: try uploaded(store))
        let reloaded = try XCTUnwrap(makeStore().deviceSendPlans(for: "acct-1").first)
        XCTAssertTrue(reloaded.targetKeyWasResealed)
        XCTAssertThrowsError(try makeStore().resealTargetKey(id: "KEY7777777777ab",
                                                             generation: 11,
                                                             wrappedKey: wrapped(8), for: reloaded))
    }

    func testAResealNeverDisturbsTheIdempotencyKeyTheStoredObjectOrTheFiles() throws {
        let store = makeStore()
        let before = try uploaded(store)
        let after = try store.resealTargetKey(id: "KEY9999999999ab", generation: 9,
                                              wrappedKey: wrapped(), for: before)
        XCTAssertEqual(after.createIdempotencyKey, before.createIdempotencyKey)
        XCTAssertEqual(after.finalizedStoredId, before.finalizedStoredId)
        XCTAssertEqual(after.files, before.files)
        XCTAssertEqual(after.jobId, before.jobId)
        XCTAssertEqual(after.ttl, before.ttl)
    }

    func testAResealOntoAnUnusableKeyIdentityIsRefused() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        XCTAssertThrowsError(try store.resealTargetKey(id: "../etc", generation: 9,
                                                       wrappedKey: wrapped(), for: plan))
        XCTAssertThrowsError(try store.resealTargetKey(id: "KEY9999999999ab", generation: 0,
                                                       wrappedKey: wrapped(), for: plan))
        XCTAssertFalse(try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
            .targetKeyWasResealed,
                       "a refused reseal must not spend the budget")
    }

    func testAShareplanCanNeverBeResealed() throws {
        let store = makeStore()
        XCTAssertThrowsError(try store.resealTargetKey(id: "KEY9999999999ab", generation: 9,
                                                       wrappedKey: wrapped(),
                                                       for: try share(store)))
    }

    // MARK: - backward and forward compatibility of the encoding

    func testAShareplanEncodesNoneOfTheNewKeys() throws {
        let store = makeStore()
        let plan = try share(store)
        let object = try planJSON(store, plan.jobId)
        XCTAssertNil(object["deviceTaskId"])
        XCTAssertNil(object["targetKeyResealed"])
        XCTAssertNil(object["targetWrappedKey"])
    }

    func testAnOldDevicePlanWithNeitherNewKeyStillReadsAsAnUnstartedDelivery() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        try rewrite(store, plan.jobId) { object in
            object.removeValue(forKey: "deviceTaskId")
            object.removeValue(forKey: "targetKeyResealed")
        }
        let reloaded = try XCTUnwrap(makeStore().deviceSendPlans(for: "acct-1").first)
        XCTAssertNil(reloaded.deviceTaskId)
        XCTAssertFalse(reloaded.targetKeyWasResealed)
    }

    /// A share plan carrying delivery state is two builds disagreeing about
    /// what this job is. Refused whole, exactly as a share plan carrying a
    /// target already is.
    func testAShareplanCarryingDeliveryStateIsRefusedOnRead() throws {
        let store = makeStore()
        let plan = try share(store)
        try rewrite(store, plan.jobId) { $0["deviceTaskId"] = "TASK0123456789ab" }
        XCTAssertNil(store.plan(for: "acct-1"))
        XCTAssertNil(store.deviceSendPlans(for: "acct-1").first)
    }

    func testADevicePlanWithAnUnusableStoredTaskIdIsRefusedOnRead() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        try rewrite(store, plan.jobId) { $0["deviceTaskId"] = "../../etc" }
        XCTAssertNil(store.deviceSendPlans(for: "acct-1").first)
    }

    // MARK: - which plans each accessor offers

    /// The ordinary resume offer is about an upload that has NOT finished. A
    /// finalized device delivery must not appear there, or the user would be
    /// invited to re-upload bytes the server already has.
    func testAFinalizedDeviceDeliveryIsNotOfferedAsAResumableUpload() throws {
        let store = makeStore()
        _ = try uploaded(store)
        XCTAssertNil(store.plan(for: "acct-1"))
        XCTAssertNotNil(store.deviceSendPlans(for: "acct-1").first)
    }

    func testAStagedButNotYetUploadedDeliveryIsOfferedToTheOrchestrator() throws {
        let store = makeStore()
        _ = try store.prepare(files: try selection(), accountId: "acct-1",
                              burnAfterRead: false,
                              ttl: UploadPurpose.deviceTaskTTLSeconds, target: target())
        XCTAssertNotNil(store.deviceSendPlans(for: "acct-1").first)
    }

    func testAShareIsNeverOfferedToTheOrchestrator() throws {
        let store = makeStore()
        _ = try share(store)
        XCTAssertNil(store.deviceSendPlans(for: "acct-1").first)
    }

    func testARetiredDeliveryIsNotOfferedToTheOrchestrator() throws {
        let store = makeStore()
        _ = try store.markRetired(try uploaded(store))
        XCTAssertNil(store.deviceSendPlans(for: "acct-1").first)
    }

    func testAnotherAccountsDeliveryIsNeverOffered() throws {
        let store = makeStore()
        _ = try uploaded(store)
        XCTAssertNil(store.deviceSendPlans(for: "acct-2").first)
    }

    func testEveryOutstandingDeliveryIsOfferedRatherThanOnlyTheNewestOne() throws {
        let store = makeStore()
        let first = try uploaded(store)
        let second = try uploaded(store)

        let plans = store.deviceSendPlans(for: "acct-1")
        XCTAssertEqual(plans.count, 2)
        XCTAssertEqual(Set(plans.map(\.jobId)), [first.jobId, second.jobId])
    }

    // MARK: - the launch sweep

    /// The sweep deletes finalized jobs, because for a share there is nothing
    /// left to do. A device delivery is the opposite: finalized means the
    /// ciphertext is up and the TASK still has to be created, so sweeping it
    /// would destroy the idempotency key and strand invisible paid storage.
    func testTheLaunchSweepSparesAFinalizedDeliveryThatStillHasToCreateItsTask() throws {
        let store = makeStore()
        let plan = try uploaded(store)
        store.sweepIncomplete()
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.planURL(for: plan.jobId).path))
        XCTAssertNotNil(store.deviceSendPlans(for: "acct-1").first)
    }

    /// A delivery whose task already exists is still not finished: its staged
    /// bytes and its content key have to be released, and the id is the only
    /// record of which task owns them.
    func testTheLaunchSweepSparesADeliveryWhoseTaskExistsButWhoseCleanupDidNot() throws {
        let store = makeStore()
        let plan = try store.setDeviceTask(id: "TASK0123456789ab", for: try uploaded(store))
        store.sweepIncomplete()
        XCTAssertNotNil(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first).deviceTaskId,
                       "TASK0123456789ab")
        XCTAssertEqual(plan.jobId,
                       try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first).jobId)
    }

    func testTheLaunchSweepStillRemovesARetiredDelivery() throws {
        let store = makeStore()
        let plan = try store.markRetired(try uploaded(store))
        store.sweepIncomplete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
    }

    /// The share half of the same sweep, unchanged. This is the regression
    /// guard on relaxing the rule for deliveries.
    func testTheLaunchSweepStillRemovesAFinalizedShare() throws {
        let store = makeStore()
        let plan = try store.markFinalized(try share(store), storedId: "STORED0123456789")
        store.sweepIncomplete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
    }
}
