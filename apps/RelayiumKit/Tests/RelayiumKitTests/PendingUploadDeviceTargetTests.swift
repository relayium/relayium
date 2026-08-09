import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The durable half of a device send: what `plan.json` has to carry, what it
/// must NOT change for an ordinary share, and what has to survive every
/// mutation between staging and finalization.
///
/// The properties under test are the ones a P3A send is built on, and each of
/// them corresponds to a concrete way a user loses or duplicates a file:
///
///  - a plan written by the PREVIOUS build still decodes and still resumes, as
///    an ordinary share with no device metadata. The version is deliberately
///    not bumped, so getting this wrong strands every interrupted upload on
///    every existing install;
///  - a share plan this build writes is byte-identical to what the previous one
///    wrote, so the compatibility above is symmetric;
///  - device metadata is coherent as a SET or the plan is refused. Half a
///    target is worse than none: it resumes, and it resumes wrongly;
///  - the creation-idempotency key is minted ONCE and is stable across an
///    upload-session replacement, a finalization, and a reload in a new store.
///    A key that changed on retry would deliver the same bytes twice.
final class PendingUploadDeviceTargetTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p3a-pending-\(UUID().uuidString)")
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

    private func target(
        deviceId: String = "DEVICE0123456789",
        keyId: String = "KEY0123456789ab",
        keyGeneration: Int64 = 4,
        idempotencyKey: String = "8C1A0F3D-2B45-4C6E-9A17-0000000000AA"
    ) -> PendingUploadTarget {
        PendingUploadTarget(deviceId: deviceId, keyId: keyId, keyGeneration: keyGeneration,
                            createIdempotencyKey: idempotencyKey)
    }

    private func planJSON(_ store: PendingUploadStore, _ jobId: String) throws -> [String: Any] {
        let data = try Data(contentsOf: store.planURL(for: jobId))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// Rewrite a job's `plan.json` from an arbitrary object, so a plan this
    /// build would never WRITE can still be presented to it for READING. That
    /// is the only way to test an old plan and a corrupted one.
    private func rewrite(_ store: PendingUploadStore, _ jobId: String,
                         _ transform: (inout [String: Any]) -> Void) throws {
        var object = try planJSON(store, jobId)
        transform(&object)
        try JSONSerialization.data(withJSONObject: object)
            .write(to: store.planURL(for: jobId), options: .atomic)
    }

    // MARK: - backward compatibility

    /// A plan written by the PREVIOUS build — no purpose, no target, no
    /// idempotency key — decodes, resumes, and reads as an ordinary share.
    func testAnOldPlanDecodesAsAShareWithNoDeviceMetadata() throws {
        let store = makeStore()
        let prepared = try store.prepare(files: try selection(), accountId: "acct-1",
                                         burnAfterRead: false, ttl: 3600)
        // Strip every key this batch added, which is exactly what a plan from
        // the previous build looks like on disk.
        try rewrite(store, prepared.jobId) { object in
            for key in ["purpose", "targetDeviceId", "targetKeyId",
                        "targetKeyGeneration", "createIdempotencyKey"] {
                object.removeValue(forKey: key)
            }
        }

        let recovered = try XCTUnwrap(makeStore().plan(for: "acct-1"))
        XCTAssertEqual(recovered.jobId, prepared.jobId)
        XCTAssertEqual(recovered.version, PendingUploadPlan.currentVersion)
        XCTAssertNil(recovered.purpose)
        XCTAssertEqual(recovered.effectivePurpose, .share)
        XCTAssertNil(recovered.target)
        XCTAssertNil(recovered.createIdempotencyKey)
        // Still resumable: the staged bytes are still describable.
        XCTAssertNoThrow(try makeStore().sources(for: recovered))
    }

    /// The symmetric half: a share plan THIS build writes carries none of the
    /// new keys, so it is byte-identical to what the previous build produced
    /// and an older build could still read it.
    func testASharePlanEncodesNoneOfTheNewKeys() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: true, ttl: 3600)
        let object = try planJSON(store, plan.jobId)
        for key in ["purpose", "targetDeviceId", "targetKeyId",
                    "targetKeyGeneration", "createIdempotencyKey"] {
            XCTAssertNil(object[key], "a share plan serialized \(key)")
        }
        XCTAssertEqual(plan.effectivePurpose, .share)
        // And the mutations do not introduce them either.
        let session = try store.setUploadSession(id: "UPLOAD0123", chunkSize: 8 << 20, for: plan)
        for key in ["purpose", "targetDeviceId", "createIdempotencyKey"] {
            XCTAssertNil(try planJSON(store, session.jobId)[key],
                         "\(key) appeared after a session update")
        }
    }

    /// The version is NOT bumped by this batch. Stated as its own assertion
    /// because bumping it is the single change that would silently make every
    /// in-flight upload on every install unresumable.
    func testThePlanVersionIsUnchanged() {
        XCTAssertEqual(PendingUploadPlan.currentVersion, 1)
    }

    // MARK: - a device plan

    func testADevicePlanCarriesTheWholeTargetAndItsIdempotencyKey() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 86_400,
                                     target: target())

        XCTAssertEqual(plan.effectivePurpose, .deviceTask)
        XCTAssertEqual(plan.target, target())
        XCTAssertEqual(plan.targetKeyGeneration, 4)
        XCTAssertEqual(plan.createIdempotencyKey, "8C1A0F3D-2B45-4C6E-9A17-0000000000AA")

        let object = try planJSON(store, plan.jobId)
        XCTAssertEqual(object["purpose"] as? String, "device_task")
        XCTAssertEqual(object["targetDeviceId"] as? String, "DEVICE0123456789")
        XCTAssertEqual(object["targetKeyId"] as? String, "KEY0123456789ab")
        XCTAssertEqual((object["targetKeyGeneration"] as? NSNumber)?.int64Value, 4)
        XCTAssertEqual(object["createIdempotencyKey"] as? String,
                       "8C1A0F3D-2B45-4C6E-9A17-0000000000AA")

        // The content key is still Keychain-only. A plan that carried it would
        // put the decryption key on disk beside nothing it protects.
        let raw = try String(contentsOf: store.planURL(for: plan.jobId), encoding: .utf8)
            .lowercased()
        for forbidden in ["bearer", "token", "authorization", "contentkey", "wrappedkey"] {
            XCTAssertFalse(raw.contains(forbidden), "the plan serialized \(forbidden)")
        }
    }

    /// Minted before any network work: the key exists on disk the moment the
    /// plan does, which is what makes the very first create retryable.
    func testAnUnsuppliedIdempotencyKeyIsMintedAtPreparation() throws {
        let store = makeStore()
        let plan = try store.prepare(
            files: try selection(), accountId: "acct-1", burnAfterRead: false, ttl: 86_400,
            target: PendingUploadTarget(deviceId: "DEVICE0123456789",
                                        keyId: "KEY0123456789ab", keyGeneration: 1))
        let key = try XCTUnwrap(plan.createIdempotencyKey)
        XCTAssertTrue(InboxIdempotencyKey.isValid(key))
        XCTAssertEqual(try planJSON(store, plan.jobId)["createIdempotencyKey"] as? String, key)
    }

    /// A device delivery may not be burn-after-read: the queue refuses a limited
    /// object, so such a plan could stage the user's bytes and then fail every
    /// upload attempt it ever made.
    func testADeviceSendRefusesBurnAfterRead() throws {
        XCTAssertThrowsError(try makeStore().prepare(
            files: try selection(), accountId: "acct-1", burnAfterRead: true,
            ttl: 86_400, target: target())) {
            XCTAssertEqual($0 as? PendingUploadError, .unusableSelection)
        }
    }

    func testADeviceSendRequiresTheP3ATwentyFourHourTTL() throws {
        for ttl in [1, 3_600, 86_399, 86_401, 7 * 86_400] {
            XCTAssertThrowsError(try makeStore().prepare(
                files: try selection(), accountId: "acct-1", burnAfterRead: false,
                ttl: ttl, target: target())) {
                XCTAssertEqual($0 as? PendingUploadError, .unusableSelection)
            }
        }
        XCTAssertNoThrow(try makeStore().prepare(
            files: try selection(), accountId: "acct-1", burnAfterRead: false,
            ttl: UploadPurpose.deviceTaskTTLSeconds, target: target()))
    }

    func testAnUnusableTargetIsRefusedBeforeAnyBytesAreStaged() throws {
        let bad: [PendingUploadTarget] = [
            target(deviceId: "../other"),
            target(deviceId: ""),
            target(keyId: "a/b"),
            target(keyGeneration: 0),
            target(keyGeneration: -1),
            target(idempotencyKey: ""),
            target(idempotencyKey: "has space"),
            target(idempotencyKey: String(repeating: "a", count: 129)),
        ]
        for candidate in bad {
            let store = makeStore()
            XCTAssertThrowsError(try store.prepare(files: try selection(), accountId: "acct-1",
                                                   burnAfterRead: false, ttl: 86_400,
                                                   target: candidate),
                                 "\(candidate) was staged") {
                XCTAssertEqual($0 as? PendingUploadError, .unusableSelection)
            }
            XCTAssertNil(store.plan(for: "acct-1"), "a refused target left a recoverable job")
        }
    }

    // MARK: - incoherent metadata on read

    /// Half a target is refused WHOLE. Ignoring the missing half would resume a
    /// delivery that cannot name its target, or mint a second idempotency key
    /// and deliver the same bytes twice.
    func testAPartiallyPopulatedTargetMakesThePlanUnrecoverable() throws {
        let removable = ["targetDeviceId", "targetKeyId", "targetKeyGeneration",
                         "createIdempotencyKey"]
        for missing in removable {
            let store = makeStore()
            let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                         burnAfterRead: false, ttl: 86_400, target: target())
            try rewrite(store, plan.jobId) { $0.removeValue(forKey: missing) }
            XCTAssertNil(makeStore().plan(for: "acct-1"),
                         "a plan missing \(missing) was offered for recovery")
        }
    }

    /// A device plan whose individual values would not survive the identifier,
    /// generation or idempotency rules is refused on READ too, not only at
    /// preparation — a plan can be edited, corrupted or written by another build.
    func testAMalformedTargetValueMakesThePlanUnrecoverable() throws {
        let corruptions: [(String, Any)] = [
            ("targetDeviceId", "../other"),
            ("targetDeviceId", ""),
            ("targetKeyId", "a/b"),
            ("targetKeyGeneration", 0),
            ("targetKeyGeneration", -3),
            ("createIdempotencyKey", ""),
            ("createIdempotencyKey", "has space"),
            ("createIdempotencyKey", String(repeating: "z", count: 129)),
        ]
        for (field, value) in corruptions {
            let store = makeStore()
            let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                         burnAfterRead: false, ttl: 86_400, target: target())
            try rewrite(store, plan.jobId) { $0[field] = value }
            XCTAssertNil(makeStore().plan(for: "acct-1"),
                         "\(field)=\(value) was offered for recovery")
        }
    }

    /// A SHARE plan carrying target metadata is a plan two builds disagree
    /// about. Ignoring the extra fields would resume it as a public object while
    /// something else still believed it was a delivery.
    func testASharePlanCarryingTargetMetadataIsRefused() throws {
        for field in ["targetDeviceId", "targetKeyId", "createIdempotencyKey"] {
            let store = makeStore()
            let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                         burnAfterRead: false, ttl: 3600)
            try rewrite(store, plan.jobId) { $0[field] = "DEVICE0123456789" }
            XCTAssertNil(makeStore().plan(for: "acct-1"),
                         "a share plan carrying \(field) was offered for recovery")
        }
    }

    /// A device plan whose stored `burnAfterRead` is true could not be uploaded
    /// at all, so it is not offered as recoverable.
    func testADevicePlanThatSaysBurnAfterReadIsRefused() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 86_400, target: target())
        try rewrite(store, plan.jobId) { $0["burnAfterRead"] = true }
        XCTAssertNil(makeStore().plan(for: "acct-1"))
    }

    func testADevicePlanWithAChangedTTLIsRefusedOnRecovery() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds,
                                     target: target())
        try rewrite(store, plan.jobId) { $0["ttl"] = 3_600 }
        XCTAssertNil(makeStore().plan(for: "acct-1"))
    }

    /// A purpose this build does not know is a DECODE failure, not a default.
    /// Resuming an unrecognised purpose as a share is the specific mistake that
    /// would publish a device delivery.
    func testAnUnknownPurposeIsRefusedRatherThanTreatedAsAShare() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 86_400, target: target())
        try rewrite(store, plan.jobId) { $0["purpose"] = "team_broadcast_v2" }
        XCTAssertNil(makeStore().plan(for: "acct-1"))
    }

    /// An unrecoverable plan is also swept, so it does not sit on the user's
    /// disk holding staged copies of their files forever.
    func testAnIncoherentDevicePlanIsSwept() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 86_400, target: target())
        try rewrite(store, plan.jobId) { $0.removeValue(forKey: "createIdempotencyKey") }
        makeStore().sweepIncomplete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
    }

    // MARK: - stability across mutations

    /// THE idempotency assertion. The key minted at staging is the key still on
    /// disk after the server session is recorded, after that session is REPLACED
    /// by a reaped-session retry, after finalization, and after a reload in a
    /// brand-new store — which is what a relaunch is.
    func testTheIdempotencyKeyAndTargetSurviveEveryMutationAndAReload() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection(), accountId: "acct-1",
                                     burnAfterRead: false, ttl: 86_400, target: target())
        let minted = try XCTUnwrap(plan.createIdempotencyKey)

        func check(_ candidate: PendingUploadPlan?, _ stage: String) throws {
            let value = try XCTUnwrap(candidate, "no plan after \(stage)")
            XCTAssertEqual(value.createIdempotencyKey, minted, "the key changed at \(stage)")
            XCTAssertEqual(value.target, target(), "the target changed at \(stage)")
            XCTAssertEqual(value.effectivePurpose, .deviceTask, "the purpose changed at \(stage)")
        }

        let first = try store.setUploadSession(id: "UPLOAD0000000001", chunkSize: 8 << 20,
                                               for: plan)
        try check(first, "the first upload session")
        // A reaped session replaced by a fresh one: the object changes, the
        // delivery does not.
        let replaced = try store.setUploadSession(id: "UPLOAD0000000002", chunkSize: 4 << 20,
                                                  for: first)
        XCTAssertEqual(replaced.uploadId, "UPLOAD0000000002")
        try check(replaced, "a replaced upload session")
        // A new store over the same root is what a relaunch sees.
        try check(makeStore().plan(for: "acct-1"), "a relaunch")

        let finalized = try store.markFinalized(replaced, storedId: "STORED0123456789")
        try check(finalized, "finalization")
        try check(makeStore().currentPlanForTesting(jobId: plan.jobId), "a relaunch after finalize")

        // Retirement is a tombstone on a DIFFERENT job, because the one above is
        // already finalized and retiring it is refused.
        let discarded = try store.prepare(files: try selection(), accountId: "acct-2",
                                          burnAfterRead: false, ttl: 86_400, target: target())
        let retired = try store.markRetired(discarded)
        XCTAssertTrue(retired.retired)
        XCTAssertEqual(retired.createIdempotencyKey, discarded.createIdempotencyKey)
        XCTAssertEqual(retired.target, target())
    }

    /// One account's device job stays invisible to another, exactly as a share
    /// job does. The target metadata does not create a second way in.
    func testADeviceJobIsScopedToItsAccount() throws {
        let store = makeStore()
        _ = try store.prepare(files: try selection(), accountId: "acct-1",
                              burnAfterRead: false, ttl: 86_400, target: target())
        XCTAssertNotNil(store.plan(for: "acct-1"))
        XCTAssertNil(store.plan(for: "acct-2"))
    }
}

extension PendingUploadStore {
    /// A finalized plan is deliberately not offered by `plan(for:)`, so reading
    /// one back after finalization needs a direct read. Test-only, and it goes
    /// through the same decode and the same validation the production read does.
    func currentPlanForTesting(jobId: String) -> PendingUploadPlan? {
        guard let data = try? Data(contentsOf: planURL(for: jobId)) else { return nil }
        return try? JSONDecoder().decode(PendingUploadPlan.self, from: data)
    }
}
