import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The v2 cutover for deliveries that were already staged when it happened.
///
/// A `PendingUploadPlan` written before Device Inbox v2 can name a live upload
/// session whose frame 0 is the shared Stored-Wire manifest. Nothing in that
/// plan says so — `deliveryKind` is absent for a legacy delivery exactly as it
/// is for a current file one — so without a marker of its own this build would
/// resume that session and stream v2 payload frames in behind a v1 header. The
/// result is an object whose own receiver refuses it as `verify_failed` after
/// downloading all of it.
///
/// Three properties are asserted here, and the third is the one that makes the
/// first two safe to have:
///
///  1. **A legacy delivery restarts.** New session, new content key, byte zero,
///     canonical v2 manifest — and the staged copy of the user's file is never
///     touched, because it may be the last one Relayium holds.
///  2. **A current delivery resumes.** The restart must not become a tax every
///     interrupted upload pays.
///  3. **Nothing duplicates.** The creation-idempotency key survives the
///     restart, so a legacy plan whose create may already have landed converges
///     or is refused; it never queues the user's file a second time. A plan that
///     already names a task is not restarted at all.
final class InboxLegacyDeliveryRestartTests: XCTestCase {
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
    /// The session a pre-v2 build recorded, and the object it finalized. Both
    /// describe ciphertext this build must not add to.
    private let legacyUploadID = "LEGACYUPLOAD0123"
    private let legacyStoredID = "LEGACYSTORED0123"
    /// The content key that sealed the legacy frame 0. Re-sealing the v2
    /// document under it would reuse AEAD sequence 0 for different plaintext.
    private let legacyContentKey = [UInt8](repeating: 0x11, count: 32)

    private let message = Array("hello device inbox".utf8)
    private var devicePublicKey = ""

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("v2-restart-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        keys = InMemoryStoredLinkKeyStore()
        sender = FakeInboxSenderTransport()
        objects = FakeStoredObjectService()
        transport = StubTransport()
        transport.finalizeResult = UploadResult(id: "STORED0123456789", expiresAt: 4242)
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        sender.deviceRows = [row()]
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - fixtures

    private func row() -> InboxDeviceRow {
        let key = InboxKey(id: keyID, algorithm: InboxProtocol.keyAlgorithm,
                           publicKey: devicePublicKey, generation: 4, createdAt: 10)
        return InboxDeviceRow(id: deviceID, name: "Studio", kind: "mac", isCurrent: false,
                              inbox: InboxView(presence: .online, lastHeartbeatAt: 10,
                                               presenceExpiresAt: 100,
                                               heartbeatIntervalSeconds: 30, protocolVersion: 3,
                                               capabilities: InboxProtocol
                                                   .announcedCapabilities(presentingText: true),
                                               receiveCapability: InboxCapability.receiveV3,
                                               autoAccept: .auto, receiveDirReady: true,
                                               revoked: false, canReceive: true,
                                               registeredAt: 10, key: key))
    }

    private func task(storedFileID: String = "STORED0123456789") -> InboxTask {
        InboxTask(id: taskID, targetDeviceID: deviceID, idempotencyKey: idempotencyKey,
                  storedFileID: storedFileID, state: .queued, ciphertextBytes: 64,
                  targetKeyID: keyID, targetKeyGeneration: 4, expiresAt: 86_500)
    }

    private func coordinator() -> InboxSendCoordinator {
        InboxSendCoordinator(store: store, keys: keys, uploader: CloudUploader(transport: transport),
                             sender: sender, objects: objects)
    }

    private func target() -> PendingUploadTarget {
        PendingUploadTarget(deviceId: deviceID, keyId: keyID, keyGeneration: 4,
                            createIdempotencyKey: idempotencyKey)
    }

    /// A staged file delivery with its content key filed, as this build writes
    /// one: `inboxProtocolVersion` present.
    private func staged() async throws -> PendingUploadPlan {
        let plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: message)],
                                     accountId: "acct-1", burnAfterRead: false,
                                     ttl: UploadPurpose.deviceTaskTTLSeconds, target: target())
        try await keys.save(id: plan.jobId, keyB64url: encodeStoreKey(legacyContentKey))
        return plan
    }

    /// The same job as a PRE-v2 build left it: the marker removed from
    /// `plan.json`, which is the only difference between the two on disk.
    ///
    /// Rewritten as JSON rather than re-encoded, because a plan this build would
    /// never write is exactly what has to be presented to it for reading.
    private func makeLegacy(_ plan: PendingUploadPlan) throws -> PendingUploadPlan {
        try rewrite(plan.jobId) { $0.removeValue(forKey: "inboxProtocolVersion") }
        let reloaded = try XCTUnwrap(store.deviceSendPlans(for: "acct-1")
            .first { $0.jobId == plan.jobId }, "a legacy plan must still be readable")
        XCTAssertFalse(reloaded.speaksInboxV2, "the fixture is not a legacy plan")
        return reloaded
    }

    private func planJSON(_ jobId: String) throws -> [String: Any] {
        let data = try Data(contentsOf: store.planURL(for: jobId))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func rewrite(_ jobId: String, _ transform: (inout [String: Any]) -> Void) throws {
        var object = try planJSON(jobId)
        transform(&object)
        try JSONSerialization.data(withJSONObject: object)
            .write(to: store.planURL(for: jobId), options: .atomic)
    }

    private func reloaded(_ plan: PendingUploadPlan) throws -> PendingUploadPlan {
        try XCTUnwrap(PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
            .deviceSendPlans(for: "acct-1").first { $0.jobId == plan.jobId },
                      "the job is no longer on disk")
    }

    private func contentKey(of plan: PendingUploadPlan) async throws -> [UInt8] {
        let filed = try await keys.key(for: plan.jobId)
        let stored = try XCTUnwrap(filed, "no content key is filed")
        return try XCTUnwrap(try? decodeStoreKey(stored))
    }

    /// The staged plaintext, read off disk. The whole point of a restart is that
    /// this is still here and still the user's file.
    private func stagedBytes(_ plan: PendingUploadPlan) throws -> [UInt8] {
        let url = store.jobURL(for: plan.jobId)
            .appendingPathComponent("staged", isDirectory: true)
            .appendingPathComponent(try XCTUnwrap(plan.files.first).staged)
        return [UInt8](try Data(contentsOf: url))
    }

    /// The manifest document the delivery actually sealed at frame 0, opened
    /// with the key the job holds NOW.
    private func sealedManifest(key: [UInt8]) throws -> InboxManifestV2 {
        let header = try XCTUnwrap(transport.headers.last, "no upload session was opened")
        XCTAssertGreaterThan(header.count, 4)
        let n = Int(header[0]) << 24 | Int(header[1]) << 16 | Int(header[2]) << 8 | Int(header[3])
        XCTAssertEqual(header.count, 4 + n, "the length prefix does not describe the frame")
        return try InboxManifest.open(key: key, sealed: Array(header[4...]))
    }

    /// Every payload frame's plaintext in send order, from a stream that started
    /// at byte zero.
    private func payloadPlaintext(key: [UInt8]) throws -> [UInt8] {
        var out: [UInt8] = []
        var seq: UInt64 = 1
        var offset = 0
        let stream = transport.committed
        while offset + 4 <= stream.count {
            let n = Int(stream[offset]) << 24 | Int(stream[offset + 1]) << 16
                | Int(stream[offset + 2]) << 8 | Int(stream[offset + 3])
            offset += 4
            guard offset + n <= stream.count else { XCTFail("truncated frame"); break }
            out += try XCTUnwrap(open(key: key, seq: seq,
                                      ciphertext: Array(stream[offset..<(offset + n)])),
                                 "frame \(seq) did not authenticate")
            offset += n
            seq += 1
        }
        XCTAssertEqual(offset, stream.count, "trailing bytes after the last frame")
        return out
    }

    /// Every create attempt answered by a lost connection, so the job survives
    /// the attempt and can be inspected. `converge` then finds no task.
    private func ambiguousCreate() {
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.listedTasks = []
    }

    /// Deliver, expecting the ambiguous ending: nothing is released, so the plan
    /// and the content key are still there to assert against.
    private func deliverExpectingUnknownOutcome(_ plan: PendingUploadPlan,
                                                file: StaticString = #filePath,
                                                line: UInt = #line) async {
        await XCTAssertThrowsErrorAsync(try await coordinator().deliver(plan, token: "bearer"), {
            XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome, file: file, line: line)
        }, file: file, line: line)
    }

    // MARK: - a legacy delivery restarts

    /// The blocking case: a half-uploaded pre-v2 delivery must open a NEW
    /// session and stream from byte zero, never continue the one whose header is
    /// the shared manifest.
    func testALegacyPartialDeliveryRestartsInsteadOfResumingItsV1Session() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        let legacy = try makeLegacy(plan)
        // A server that already holds 24 bytes of that session, behind a v1
        // frame 0. Resuming it is the bug this whole file exists for.
        let server = LegacySessionTransport(legacyUploadID: legacyUploadID, committed: 24)
        ambiguousCreate()

        await XCTAssertThrowsErrorAsync(try await InboxSendCoordinator(
            store: store, keys: keys, uploader: CloudUploader(transport: server),
            sender: sender, objects: objects).deliver(legacy, token: "bearer"), {
                XCTAssertEqual($0 as? InboxSendFailure, .unknownOutcome)
            })

        XCTAssertEqual(server.initCount, 1, """
            a legacy delivery must open a fresh session: continuing the recorded \
            one would put v2 payload frames behind a v1 frame 0
            """)
        XCTAssertEqual(server.patches.filter { $0.uploadId == legacyUploadID }, [], """
            not one byte may be added to the session whose header is the shared \
            Stored-Wire manifest
            """)
        XCTAssertEqual(server.patches.first?.from, 0,
                       "the restarted ciphertext must start at byte zero")
        XCTAssertEqual(server.legacyCommitted, 24, "the v1 session was written to")
        let after = try reloaded(legacy)
        XCTAssertTrue(after.speaksInboxV2, "the restart must be durable")
        XCTAssertEqual(after.uploadId, LegacySessionTransport.freshUploadID,
                       "the plan must name the session it actually fed")
        XCTAssertNotEqual(after.uploadId, legacyUploadID)
    }

    /// The restart is a REWRITE of the ciphertext state and of nothing else. The
    /// staged bytes are the user's, and after a failed attempt they are still
    /// exactly what was staged.
    func testTheRestartKeepsTheStagedBytesTheTargetAndTheIdempotencyKey() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        let legacy = try makeLegacy(plan)
        ambiguousCreate()

        await deliverExpectingUnknownOutcome(legacy)

        let after = try reloaded(legacy)
        XCTAssertEqual(try stagedBytes(after), message, """
            the staged copy may be the last one Relayium holds; a protocol \
            cutover must never spend it
            """)
        XCTAssertEqual(after.files, plan.files)
        XCTAssertEqual(after.createIdempotencyKey, idempotencyKey, """
            a fresh key here would queue the user's file as a SECOND delivery \
            if the legacy plan's create had already landed
            """)
        XCTAssertEqual(after.target, plan.target)
        XCTAssertEqual(after.ttl, UploadPurpose.deviceTaskTTLSeconds)
        XCTAssertEqual(after.effectiveDeliveryKind, .file)
        XCTAssertEqual(objects.deleted, [], "an ambiguous outcome must release nothing")
    }

    /// The content key is rotated by the restart, and it has to be: frame 0 is
    /// sealed at AEAD sequence 0, and the v2 document is not the v1 one. Sealing
    /// both under one key is nonce reuse, which hands anyone holding the old
    /// ciphertext both plaintexts and the authentication key.
    func testTheRestartSealsUnderAKeyThatHasNeverSealedAnything() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        let legacy = try makeLegacy(plan)
        ambiguousCreate()

        await deliverExpectingUnknownOutcome(legacy)

        let rotated = try await contentKey(of: legacy)
        XCTAssertNotEqual(rotated, legacyContentKey, """
            re-sealing frame 0 under the key that sealed the v1 header would \
            reuse sequence 0 for different plaintext
            """)
        XCTAssertEqual(rotated.count, 32)
        // And the document that left is the v2 one, opened with that key.
        let manifest = try sealedManifest(key: rotated)
        XCTAssertEqual(manifest.kind, .file)
        XCTAssertEqual(manifest.items.map(\.name), ["a.txt"])
    }

    /// A legacy delivery that never opened a session is restarted too — it only
    /// gains the marker — and the object it produces is a canonical v2 one.
    func testALegacyDeliveryProducesACanonicalV2Object() async throws {
        let legacy = try makeLegacy(try await staged())
        ambiguousCreate()

        await deliverExpectingUnknownOutcome(legacy)

        let key = try await contentKey(of: legacy)
        let manifest = try sealedManifest(key: key)
        XCTAssertEqual(manifest.kind, .file)
        XCTAssertEqual(manifest.items.map(\.name), ["a.txt"])
        XCTAssertEqual(manifest.items.map(\.size), [message.count])
        XCTAssertEqual(try payloadPlaintext(key: key), message,
                       "the payload frames must be the staged bytes, from zero")
        XCTAssertEqual(transport.purposes, [.deviceTask])
    }

    // MARK: - a current delivery is untouched

    /// The restart must not become a tax every interrupted upload pays: a plan
    /// this build wrote resumes its recorded session, keeps its key, and opens
    /// no new one.
    func testACurrentV2PlanResumesItsRecordedSession() async throws {
        let plan = try await staged()
        let session = try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024,
                                                 for: plan)
        XCTAssertTrue(session.speaksInboxV2)
        transport.committed = [UInt8](repeating: 0xEE, count: 24)
        ambiguousCreate()

        await deliverExpectingUnknownOutcome(session)

        XCTAssertEqual(transport.initCount, 0, "a v2 plan's session was replaced")
        XCTAssertEqual(transport.patches.first?.from, 24,
                       "a v2 plan must continue from the server's committed offset")
        let key = try await contentKey(of: plan)
        XCTAssertEqual(key, legacyContentKey,
                       "rotating a key that has sealed only v2 frames would restart for nothing")
        XCTAssertEqual(try reloaded(plan).uploadId, legacyUploadID)
    }

    /// A share plan has no Device Inbox protocol at all, and this batch must not
    /// have given it one: its frame 0 is the shared Stored-Wire manifest, and
    /// its encoding stays byte-identical to what earlier builds wrote.
    func testASharePlanIsUnchangedAndIsNeverRestarted() throws {
        let plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: message)],
                                     accountId: "acct-1", burnAfterRead: true, ttl: 3600)
        let session = try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024,
                                                 for: plan)

        XCTAssertNil(try planJSON(plan.jobId)["inboxProtocolVersion"],
                     "a share plan serialized a device-delivery marker")
        XCTAssertNil(session.inboxProtocolVersion)
        XCTAssertFalse(session.speaksInboxV2)
        XCTAssertEqual(store.plan(for: "acct-1")?.uploadId, legacyUploadID,
                       "a share's session must survive untouched")
        // And the transition refuses it outright rather than migrating it.
        XCTAssertThrowsError(try store.restartForInboxV2(session)) { error in
            XCTAssertEqual(error as? PendingUploadError, .stagingMissing)
        }
        XCTAssertEqual(store.plan(for: "acct-1")?.uploadId, legacyUploadID)
    }

    /// A share plan carrying the marker is two builds disagreeing about what the
    /// job is, and is refused whole rather than read with the field ignored.
    func testAShareCarryingTheMarkerIsRefused() throws {
        let plan = try store.prepare(sources: [DataSource(name: "a.txt", bytes: message)],
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        try rewrite(plan.jobId) { $0["inboxProtocolVersion"] = InboxProtocol.taskProtocolVersion }

        XCTAssertNil(store.plan(for: "acct-1"))
    }

    /// An inbox protocol this build cannot produce is refused for the same
    /// reason an unknown `purpose` is: it describes frame-0 framing this build
    /// would have to guess at.
    func testAnUnknownInboxProtocolIsRefused() async throws {
        let plan = try await staged()
        try rewrite(plan.jobId) { $0["inboxProtocolVersion"] = 4 }

        XCTAssertEqual(store.deviceSendPlans(for: "acct-1"), [])
    }

    // MARK: - nothing duplicates

    /// The restarted delivery creates ONE task, under the key the legacy plan
    /// minted, naming the object the restart produced.
    func testTheRestartedDeliveryCreatesOneTaskUnderTheOriginalKey() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        // The pre-v2 build got as far as a finished v1 object.
        try store.markFinalized(plan, storedId: legacyStoredID)
        let legacy = try makeLegacy(plan)
        sender.createOutcomes = [.success(InboxTaskCreation(task: task(), created: true))]

        let result = try await coordinator().deliver(legacy, token: "bearer")

        XCTAssertTrue(result.created)
        XCTAssertEqual(sender.creates.count, 1)
        XCTAssertEqual(sender.createdIdempotencyKeys, [idempotencyKey], """
            the key survives the restart, so a create the legacy plan may have \
            already landed converges instead of queueing a second delivery
            """)
        XCTAssertEqual(sender.creates, [.create(device: deviceID, idempotencyKey: idempotencyKey,
                                                storedFile: "STORED0123456789",
                                                wrappedKey: sender.createdWrappedKeys[0],
                                                keyID: keyID, keyGeneration: 4)], """
            the task must bind the object the v2 restart produced, never the v1 \
            one whose key no longer exists
            """)
        XCTAssertEqual(objects.deleted, [], """
            the abandoned v1 object is left to central's collector, which \
            reclaims an unbound device_task object; deleting it here would need \
            an id this plan no longer carries
            """)
    }

    /// A legacy plan that already names a task is in its tidy-up, not its
    /// upload. It must not be restarted, must not upload, and must not create.
    func testALegacyPlanThatAlreadyNamesATaskIsNeverRestarted() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        try store.markFinalized(plan, storedId: legacyStoredID)
        let recorded = try store.setDeviceTask(id: taskID, for: plan)
        XCTAssertEqual(recorded.deviceTaskId, taskID)
        let legacy = try makeLegacy(recorded)
        sender.taskResults = [.success(task(storedFileID: legacyStoredID))]

        let result = try await coordinator().deliver(legacy, token: "bearer")

        XCTAssertFalse(result.created, "an existing task must be read, never re-created")
        XCTAssertEqual(sender.creates, [], "a second create would be a second delivery")
        XCTAssertEqual(transport.initCount, 0, "bytes the account already paid for were re-sent")
        XCTAssertEqual(objects.deleted, [], """
            the object belongs to the task now; deleting it would strand a \
            delivery central has already promised
            """)
    }

    /// The store's own refusal, stated directly: a plan naming a task cannot be
    /// restarted even by a caller that asks for it.
    func testTheStoreRefusesToRestartAPlanThatNamesATask() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        try store.markFinalized(plan, storedId: legacyStoredID)
        let recorded = try store.setDeviceTask(id: taskID, for: plan)
        let legacy = try makeLegacy(recorded)

        XCTAssertThrowsError(try store.restartForInboxV2(legacy)) { error in
            XCTAssertEqual(error as? PendingUploadError, .unusableSelection)
        }
        let after = try reloaded(legacy)
        XCTAssertEqual(after.deviceTaskId, taskID)
        XCTAssertEqual(after.finalizedStoredId, legacyStoredID)
        XCTAssertEqual(after.uploadId, legacyUploadID)
        XCTAssertFalse(after.speaksInboxV2)
    }

    // MARK: - the durable transition itself

    /// Exactly which fields the restart drops, and which it keeps, asserted
    /// against what a NEW store reads back.
    func testTheRestartDropsOnlyTheCiphertextState() async throws {
        let plan = try await staged()
        try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024, for: plan)
        let wrapped = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, targetPublicKey: devicePublicKey,
            contentKey: legacyContentKey)
        try store.setTargetWrappedKey(wrapped, for: plan)
        try store.markFinalized(plan, storedId: legacyStoredID)
        let legacy = try makeLegacy(plan)

        let restarted = try store.restartForInboxV2(legacy)

        XCTAssertNil(restarted.uploadId)
        XCTAssertNil(restarted.uploadChunkSize)
        XCTAssertNil(restarted.finalizedStoredId)
        XCTAssertNil(restarted.targetWrappedKey, """
            the sealed box wraps the content key this job is about to stop \
            using; keeping it would create a task the target could not open
            """)
        XCTAssertTrue(restarted.speaksInboxV2)
        XCTAssertEqual(restarted.jobId, plan.jobId)
        XCTAssertEqual(restarted.createIdempotencyKey, idempotencyKey)
        XCTAssertEqual(restarted.files, plan.files)
        XCTAssertEqual(try stagedBytes(restarted), message)
        // Durable, not just returned.
        let onDisk = try reloaded(plan)
        XCTAssertEqual(onDisk, restarted)
    }

    /// Idempotent: a second caller must not wipe the session the first one's
    /// restart has since opened.
    func testRestartingAPlanThatAlreadySpeaksV2ChangesNothing() async throws {
        let plan = try await staged()
        let session = try store.setUploadSession(id: legacyUploadID, chunkSize: 64 * 1024,
                                                 for: plan)

        let again = try store.restartForInboxV2(session)

        XCTAssertEqual(again, session)
        XCTAssertEqual(again.uploadId, legacyUploadID)
        XCTAssertEqual(again.uploadChunkSize, 64 * 1024)
    }
}

/// A server that is already holding part of a pre-v2 upload session.
///
/// `StubTransport` counts one global committed stream, which cannot express the
/// thing under test: an OLD session with bytes in it and a NEW session that must
/// start empty. Here each session has its own offset, and every PATCH records
/// which one it was aimed at — so "the v1 session was not written to" is an
/// assertion rather than an inference.
final class LegacySessionTransport: ResumableTransport, @unchecked Sendable {
    static let freshUploadID = "FRESHUPLOAD01234"

    let legacyUploadID: String
    private(set) var legacyCommitted: Int
    private(set) var initCount = 0
    private(set) var headers: [[UInt8]] = []
    private(set) var purposes: [UploadPurpose] = []
    private(set) var patches: [Patch] = []
    private var fresh = 0
    var finalizeResult = UploadResult(id: "STORED0123456789", expiresAt: 4242)

    struct Patch: Equatable {
        let uploadId: String
        let from: Int
        let count: Int
    }

    init(legacyUploadID: String, committed: Int) {
        self.legacyUploadID = legacyUploadID
        self.legacyCommitted = committed
    }

    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        initCount += 1
        headers.append(header)
        purposes.append(purpose)
        fresh = 0
        return (Self.freshUploadID, 64 * 1024)
    }

    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int,
                    token: String, onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        patches.append(Patch(uploadId: uploadId, from: from, count: bytes.count))
        if uploadId == legacyUploadID {
            legacyCommitted += bytes.count
            return .committed(received: legacyCommitted)
        }
        fresh += bytes.count
        return .committed(received: fresh)
    }

    func uploadOffset(uploadId: String, token: String) async throws -> Int {
        uploadId == legacyUploadID ? legacyCommitted : fresh
    }

    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        finalizeResult
    }
}
