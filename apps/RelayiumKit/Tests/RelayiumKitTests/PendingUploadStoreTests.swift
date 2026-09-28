import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// R3-G, the persistence half: what has to survive the process that made it.
///
/// The upload path this joins already survives a transient reset, but only
/// while one `CloudUploader` instance stays alive — the id, the content key and
/// the selected bytes all die with the process. These tests pin the four facts
/// that make a durable, user-driven recovery honest rather than hopeful:
///
///  1. the metadata is atomic and versioned, and carries no credential;
///  2. a NEW store in a NEW process recovers the job from app-owned bytes,
///     with no original URL and no security scope;
///  3. one account's pending job is invisible to another;
///  4. purge and the incomplete-preparation sweep actually remove bytes.
///
/// Nothing here touches the network. Preparation is a filesystem operation, and
/// that is the whole point: the bytes must be ours before a server session
/// exists, or a resume is re-reading a file the user may have changed.
final class PendingUploadStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("r3g-pending-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - helpers

    /// A source file with known bytes, outside the store's root — standing in
    /// for a document-picker URL whose security scope ends with this launch.
    private func sourceFile(_ bytes: [UInt8], name: String) throws -> URL {
        let url = root.appendingPathComponent("origin-\(UUID().uuidString)-\(name)")
        try Data(bytes).write(to: url)
        return url
    }

    private func selection(_ files: [(bytes: [UInt8], path: String)]) throws -> [SelectedFile] {
        try files.map { file in
            SelectedFile(url: try sourceFile(file.bytes, name: (file.path as NSString).lastPathComponent),
                         relativePath: file.path)
        }
    }

    private func makeStore() -> PendingUploadStore {
        PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
    }

    private func readAll(_ source: inout PlaintextSource) throws -> [UInt8] {
        var out: [UInt8] = []
        while true {
            let chunk = try source.read(64 * 1024)
            if chunk.isEmpty { return out }
            out += chunk
        }
    }

    private struct DeclaredSource: PlaintextSource {
        let name: String
        let size: Int
        let bytes: [UInt8]
        let violatesReadBound: Bool
        private var offset = 0

        init(name: String = "a.bin", size: Int, bytes: [UInt8],
             violatesReadBound: Bool = false) {
            self.name = name
            self.size = size
            self.bytes = bytes
            self.violatesReadBound = violatesReadBound
        }

        mutating func read(_ max: Int) throws -> [UInt8] {
            guard offset < bytes.count else { return [] }
            let requested = violatesReadBound ? max + 1 : max
            let end = min(offset + requested, bytes.count)
            defer { offset = end }
            return Array(bytes[offset..<end])
        }
    }

    // MARK: - 1. atomic, versioned, credential-free metadata

    /// The plan is the only thing that can rebuild a job, so it is also the
    /// thing most tempting to put a bearer in. It carries neither the bearer
    /// nor the content key: the key is Keychain-only, and the bearer is read at
    /// the moment of use and never at rest.
    func testPlanIsVersionedAndCarriesNoBearerOrRawKey() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("hello".utf8), "a.txt")]),
                                     accountId: "acct-1",
                                     burnAfterRead: true,
                                     ttl: 3600)

        XCTAssertEqual(plan.version, PendingUploadPlan.currentVersion)
        XCTAssertEqual(plan.accountId, "acct-1")
        XCTAssertEqual(plan.ttl, 3600)
        XCTAssertTrue(plan.burnAfterRead)
        // The id is composed into a Keychain account name, so it obeys the one
        // identifier rule the rest of the app already enforces.
        XCTAssertEqual(try StoredObjectID.checked(plan.jobId), plan.jobId)

        let raw = try String(contentsOf: store.planURL(for: plan.jobId), encoding: .utf8).lowercased()
        for forbidden in ["bearer", "token", "authorization", "\"key\"", "keyb64"] {
            XCTAssertFalse(raw.contains(forbidden), "the plan serialized \(forbidden)")
        }
    }

    /// A half-written plan must never be readable as a whole one. The write is
    /// a temp file plus a rename, so a reader sees the old bytes or the new
    /// ones and never a truncated JSON document.
    func testPlanIsWrittenAtomically() throws {
        let store = makeStore()
        var plan = try store.prepare(files: try selection([(Array("one".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        XCTAssertNil(plan.uploadId)

        plan = try store.setUploadSession(id: "upload-123", chunkSize: 123_456, for: plan)
        XCTAssertEqual(plan.uploadId, "upload-123")
        XCTAssertEqual(plan.uploadChunkSize, 123_456)
        XCTAssertEqual(store.plan(for: "acct-1")?.uploadId, "upload-123")
        XCTAssertEqual(store.plan(for: "acct-1")?.uploadChunkSize, 123_456)
        // No leftover temp file beside it: the rename consumed it.
        let jobFiles = try FileManager.default.contentsOfDirectory(
            atPath: store.jobURL(for: plan.jobId).path)
        XCTAssertFalse(jobFiles.contains { $0.hasSuffix(".tmp") }, "temp file survived: \(jobFiles)")
    }

    /// The content key is Keychain-only, under its OWN namespace — a pending
    /// job id must not be able to name a stored-object key, or vice versa.
    func testPendingContentKeyUsesItsOwnKeychainNamespace() throws {
        let pending = KeychainStoredLinkKeyStore(
            service: "com.relayium.app",
            accountPrefix: KeychainStoredLinkKeyStore.pendingUploadPrefix)
        let stored = KeychainStoredLinkKeyStore(service: "com.relayium.app")

        let id = "abc123"
        XCTAssertNotEqual(try pending.account(for: id), try stored.account(for: id))
        XCTAssertTrue(try pending.account(for: id).hasPrefix("pending-upload-key:"))
    }

    /// Staged bytes are the user's files. They are the app's own copy, kept
    /// only until the upload finishes — restoring them onto another device from
    /// a backup would be a copy nobody asked for.
    func testTheJobDirectoryIsExcludedFromBackup() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)

        let values = try store.jobURL(for: plan.jobId)
            .resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        let staged = store.jobURL(for: plan.jobId).appendingPathComponent("staged/0")
        let permissions = try XCTUnwrap(
            FileManager.default.attributesOfItem(atPath: staged.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue & 0o777, 0o400)
    }

    /// Preparation copies from the ALREADY-PINNED source, never from a path it
    /// looks up again: the descriptor is what makes the bytes the ones the user
    /// consented to, and a second lookup is the one that can lie. Expressed as
    /// an API fact — the copier takes `PlaintextSource`, so a source with no
    /// URL at all stages perfectly well.
    func testPreparationCopiesFromPinnedSourcesRatherThanReopeningPaths() throws {
        let payload = (0..<3000).map { UInt8($0 % 97) }
        let store = makeStore()

        let plan = try store.prepare(sources: [DataSource(name: "nested/a.bin", bytes: payload)],
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)

        XCTAssertEqual(plan.files.map(\.name), ["nested/a.bin"])
        XCTAssertEqual(plan.files.map(\.size), [payload.count])
        var sources = try store.sources(for: plan)
        XCTAssertEqual(try readAll(&sources[0]), payload)
    }

    /// Bounded, not file-sized. Staging a large selection must not hold it in
    /// memory — the same rule the uploader itself lives by.
    func testPreparationHoldsOneChunkNotTheWholeFile() throws {
        let big = (0..<(STORE_CHUNK_SIZE * 3 + 517)).map { UInt8($0 % 251) }
        let store = makeStore()

        _ = try store.prepare(sources: [DataSource(name: "big.bin", bytes: big)],
                              accountId: "acct-1", burnAfterRead: false, ttl: 3600)

        XCTAssertLessThanOrEqual(store.lastCopyBufferPeak, STORE_CHUNK_SIZE,
                                 "staging buffered \(store.lastCopyBufferPeak) bytes")
        XCTAssertGreaterThan(store.lastCopyBufferPeak, 0)
    }

    /// The declared size is the encrypted manifest contract. Staging must not
    /// silently rewrite it to whatever a changing or broken source happened to
    /// return, because an earlier attempt may already have used that contract.
    func testPreparationRejectsSourcesShorterOrLongerThanDeclared() throws {
        let store = makeStore()
        XCTAssertThrowsError(try store.prepare(
            sources: [DeclaredSource(size: 4, bytes: [1, 2, 3])],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600))
        XCTAssertThrowsError(try store.prepare(
            sources: [DeclaredSource(size: 2, bytes: [1, 2, 3])],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600))
        XCTAssertNil(store.plan(for: "acct-1"))
    }

    func testPreparationRejectsASourceThatReturnsMoreThanRequested() throws {
        let store = makeStore()
        let bytes = [UInt8](repeating: 7, count: STORE_CHUNK_SIZE + 1)
        XCTAssertThrowsError(try store.prepare(
            sources: [DeclaredSource(size: bytes.count, bytes: bytes,
                                     violatesReadBound: true)],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600))
        XCTAssertNil(store.plan(for: "acct-1"))
    }

    // MARK: - 2. recovery in a new process, with no URL and no scope

    /// The load-bearing test of the whole slice. A second `PendingUploadStore`
    /// — standing in for the next launch — rebuilds the job's byte sources from
    /// the app's own copy, after the original file is gone. No original URL, no
    /// security scope, no provider.
    func testANewStoreRecoversTheJobAfterTheOriginalIsGone() throws {
        let payloadA = (0..<5000).map { UInt8($0 % 251) }
        let payloadB = Array("second file".utf8)
        let files = try selection([(payloadA, "trip/day1/a.bin"), (payloadB, "b.txt")])

        let prepared = try makeStore().prepare(files: files, accountId: "acct-1",
                                               burnAfterRead: false, ttl: 86400)
        // The original is deleted: this is the force-quit case, where the
        // security scope is gone and the picker's URL means nothing.
        for file in files { try FileManager.default.removeItem(at: file.url) }

        let reopened = makeStore()
        let recovered = try XCTUnwrap(reopened.plan(for: "acct-1"))
        XCTAssertEqual(recovered.jobId, prepared.jobId)
        // Relative names and sizes are what the manifest is rebuilt from, so
        // they have to survive verbatim — hierarchy included.
        XCTAssertEqual(recovered.files.map(\.name), ["trip/day1/a.bin", "b.txt"])
        XCTAssertEqual(recovered.files.map(\.size), [payloadA.count, payloadB.count])

        var sources = try reopened.sources(for: recovered)
        XCTAssertEqual(sources.count, 2)
        XCTAssertEqual(sources.map(\.name), ["trip/day1/a.bin", "b.txt"])
        XCTAssertEqual(try readAll(&sources[0]), payloadA)
        XCTAssertEqual(try readAll(&sources[1]), payloadB)
    }

    /// The staged copy is the app's own, so nothing that happens to the
    /// original afterwards can change the bytes that get encrypted. Without
    /// this, a resume re-encrypts different plaintext under a nonce the first
    /// attempt already used.
    func testStagedBytesAreImmutableAgainstTheOriginalChanging() throws {
        let original = Array("original contents".utf8)
        let files = try selection([(original, "a.txt")])
        let store = makeStore()
        let plan = try store.prepare(files: files, accountId: "acct-1",
                                     burnAfterRead: false, ttl: 3600)

        try Data(Array("REPLACED — different length entirely".utf8)).write(to: files[0].url)

        var sources = try store.sources(for: plan)
        XCTAssertEqual(try readAll(&sources[0]), original)
        XCTAssertEqual(sources[0].size, original.count)
    }

    // MARK: - 3. account ownership

    /// A pending job belongs to the account that made it. Another account —
    /// signed in on the same device, on the same store — must not see it, be
    /// offered it, or be able to resume it.
    func testOnlyTheOwningAccountSeesThePendingJob() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)

        XCTAssertEqual(store.plan(for: "acct-1")?.jobId, plan.jobId)
        XCTAssertNil(store.plan(for: "acct-2"))
        XCTAssertNil(makeStore().plan(for: "acct-2"))
    }

    // MARK: - 4. cleanup

    /// Discard and success both mean the same thing on disk: the staged bytes
    /// and the plan are gone, and the job is no longer recoverable.
    func testPurgeRemovesTheStagedBytesAndThePlan() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array(repeating: 7, count: 4096), "a.bin")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        let job = store.jobURL(for: plan.jobId)
        XCTAssertTrue(FileManager.default.fileExists(atPath: job.path))

        store.purge(plan)

        XCTAssertFalse(FileManager.default.fileExists(atPath: job.path))
        XCTAssertNil(store.plan(for: "acct-1"))
        XCTAssertNil(makeStore().plan(for: "acct-1"))
    }

    func testDiscardTombstoneIsNeverRecoverableAndLaunchSweepFinishesIt() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        let retired = try store.markRetired(plan)

        XCTAssertTrue(retired.retired)
        XCTAssertNil(store.plan(for: "acct-1"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))

        makeStore().sweepIncomplete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
    }

    func testAStaleSessionCallbackCannotResurrectADiscardedPlan() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        _ = try store.markRetired(plan)

        XCTAssertThrowsError(try store.setUploadSession(id: "late-session", chunkSize: 65_536,
                                                        for: plan))
        XCTAssertNil(store.plan(for: "acct-1"))
    }

    /// Preparation writes the plan LAST, so a job directory without one is a
    /// preparation that died part-way — a copy of the user's bytes with nothing
    /// to make it recoverable. It is invisible to recovery and swept at launch.
    func testIncompletePreparationIsInvisibleAndSwept() throws {
        let store = makeStore()
        let complete = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                         accountId: "acct-1", burnAfterRead: false, ttl: 3600)

        let orphan = store.jobURL(for: "orphaned-job")
        try FileManager.default.createDirectory(at: orphan.appendingPathComponent("staged"),
                                                withIntermediateDirectories: true)
        try Data(repeating: 1, count: 32).write(to: orphan.appendingPathComponent("staged/0"))

        XCTAssertEqual(store.plan(for: "acct-1")?.jobId, complete.jobId, "an orphan must not shadow a real job")

        store.sweepIncomplete()

        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.jobURL(for: complete.jobId).path))
        XCTAssertEqual(store.plan(for: "acct-1")?.jobId, complete.jobId)
    }

    /// Metadata is local but still untrusted input after a crash or restore.
    /// A staged name that is not its exact numeric index is refused before it
    /// can become a path or make the same file appear twice in the manifest.
    func testCorruptedPlanCannotEscapeOrAliasTheStagedDirectory() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        let url = store.planURL(for: plan.jobId)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url))
            as? [String: Any])
        var files = try XCTUnwrap(json["files"] as? [[String: Any]])
        files[0]["staged"] = "../outside"
        json["files"] = files
        try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)

        XCTAssertNil(store.plan(for: "acct-1"))
        store.sweepIncomplete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.jobURL(for: plan.jobId).path))
    }

    func testSourcesRejectAnUnvalidatedDecodedPlanBeforeResolvingItsPath() throws {
        let store = makeStore()
        let plan = PendingUploadPlan(
            version: PendingUploadPlan.currentVersion,
            jobId: "../outside", accountId: "acct-1",
            files: [PendingUploadFile(name: "a", size: 1, staged: "0")],
            burnAfterRead: false, ttl: 3600, createdAt: 1,
            uploadId: nil, uploadChunkSize: nil, retired: false,
            finalizedStoredId: nil)

        XCTAssertThrowsError(try store.sources(for: plan)) { error in
            XCTAssertEqual(error as? PendingUploadError, .stagingMissing)
        }
    }

    func testCorruptedSessionWithoutItsChunkSizeIsNotRecoverable() throws {
        let store = makeStore()
        let plan = try store.prepare(files: try selection([(Array("x".utf8), "a.txt")]),
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        let url = store.planURL(for: plan.jobId)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url))
            as? [String: Any])
        json["uploadId"] = "upload-1"
        json.removeValue(forKey: "uploadChunkSize")
        try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)

        XCTAssertNil(store.plan(for: "acct-1"))
    }
}

// MARK: - shared-root sweep: which removed ids release their content key

/// The shared root's launch sweep deletes exactly what every released build
/// deletes. What it RETURNS is new: the ids whose content key nothing can use
/// again — a readable, valid retired plan (d1) or a readable, valid,
/// non-retired plan whose staged bytes are gone (c) — and only once its own
/// removal succeeded and the protected sibling does not hold the same id.
/// Everything else it removes (unreadable, plan-less, newer-version,
/// mismatched id, finalized share) is never listed. An entry whose directory
/// name the protected sibling root also holds is a conflict (R2): it is neither
/// removed nor listed, whatever it contains (C1–C5).
extension PendingUploadStoreTests {
    private var sharedRoot: URL { root.appendingPathComponent("PendingUploads") }
    private var protectedRoot: URL { PendingUploadStore.protectedDeviceRoot(besides: sharedRoot) }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    private func stagedShare(in store: PendingUploadStore) throws -> PendingUploadPlan {
        try store.prepare(files: try selection([(Array("share".utf8), "a.txt")]),
                          accountId: "acct-1", burnAfterRead: false, ttl: 3600)
    }

    /// Rewrite one field of an on-disk plan, bypassing the store's validation.
    private func rewritePlan(_ url: URL, _ edit: (inout [String: Any]) -> Void) throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url))
            as? [String: Any])
        edit(&json)
        try JSONSerialization.data(withJSONObject: json).write(to: url, options: .atomic)
    }

    // T1
    func testSharedSweepListsARetiredShareItRemovedOnce() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        _ = try store.markRetired(plan)

        XCTAssertEqual(makeStore().sweepIncomplete(), [plan.jobId])
        XCTAssertFalse(exists(store.jobURL(for: plan.jobId)))
        XCTAssertEqual(makeStore().sweepIncomplete(), [], "a directory already gone is not listed twice")
    }

    // T2
    func testSharedSweepListsAShareWhoseStagedBytesAreGone() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        try FileManager.default.removeItem(at: store.jobURL(for: plan.jobId)
            .appendingPathComponent("staged/0"))
        XCTAssertNil(store.plan(for: "acct-1"), "the fixture must be unrecoverable")

        XCTAssertEqual(makeStore().sweepIncomplete(), [plan.jobId])
        XCTAssertFalse(exists(store.jobURL(for: plan.jobId)))
    }

    // T3
    func testSharedSweepListsARetiredLegacyDelivery() throws {
        // A delivery can only be staged in the protected root; a build up to
        // 1.4.3 left it in the shared root, so move it there.
        let protected = makeStore().protectedDeviceStore()
        let delivery = try protected.prepare(
            files: try selection([(Array("deliver".utf8), "d.txt")]), accountId: "acct-1",
            burnAfterRead: false, ttl: UploadPurpose.deviceTaskTTLSeconds,
            target: PendingUploadTarget(deviceId: "DEVICE0123456789", keyId: "KEY0123456789abcd",
                                        keyGeneration: 4))
        _ = try protected.markRetired(delivery)
        try FileManager.default.createDirectory(at: sharedRoot, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: protected.jobURL(for: delivery.jobId),
                                         to: sharedRoot.appendingPathComponent(delivery.jobId))
        XCTAssertFalse(exists(protectedRoot.appendingPathComponent(delivery.jobId)))

        XCTAssertEqual(makeStore().sweepIncomplete(), [delivery.jobId])
        XCTAssertFalse(exists(sharedRoot.appendingPathComponent(delivery.jobId)))
    }

    // T4 (d2): the sweep no longer deletes a finalized share; it is retained
    // and named for salvage, with the stored-object id its link key belongs to.
    func testSharedSweepRetainsAFinalizedShareAndNamesItForSalvage() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        _ = try store.markFinalized(plan, storedId: "STOREDSHARE00001")

        XCTAssertEqual(makeStore().sweepIncomplete(), [],
                       "a finalized share's pending key may be the only copy of its link key")
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)),
                      "the sweep deleted a finalized share before its link key was salvaged")
        XCTAssertEqual(makeStore().finalizedSharesAwaitingSalvage(),
                       [FinalizedShareEntry(jobId: plan.jobId, storedId: "STOREDSHARE00001")])
    }

    // F1: only a readable, valid, non-retired, finalized SHARE is named.
    func testSalvageListingNamesOnlyFinalizedShares() throws {
        let store = makeStore()
        _ = try stagedShare(in: store)                                  // live
        _ = try store.markRetired(try stagedShare(in: store))           // retired
        let finalized = try stagedShare(in: store)
        _ = try store.markFinalized(finalized, storedId: "STOREDSHARE00001")
        let unreadable = sharedRoot.appendingPathComponent("SHAREDUNREAD0001")
        try FileManager.default.createDirectory(at: unreadable, withIntermediateDirectories: true)
        try Data("{not a plan".utf8).write(to: unreadable.appendingPathComponent("plan.json"))

        XCTAssertEqual(makeStore().finalizedSharesAwaitingSalvage(),
                       [FinalizedShareEntry(jobId: finalized.jobId, storedId: "STOREDSHARE00001")])
        XCTAssertEqual(makeStore().protectedDeviceStore().finalizedSharesAwaitingSalvage(), [],
                       "the protected store names nothing for salvage")
    }

    // F2: the purge revalidates, honours R2, and is idempotent.
    func testPurgeFinalizedShareRevalidatesAndHonoursR2() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        _ = try store.markFinalized(plan, storedId: "STOREDSHARE00001")
        let entry = FinalizedShareEntry(jobId: plan.jobId, storedId: "STOREDSHARE00001")

        XCTAssertFalse(store.purgeFinalizedShare(FinalizedShareEntry(jobId: plan.jobId,
                                                                     storedId: "STOREDSHARE00002")),
                       "a stale entry naming a different stored id removed the job")
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)))

        let live = try stagedShare(in: store)
        XCTAssertFalse(store.purgeFinalizedShare(FinalizedShareEntry(jobId: live.jobId,
                                                                     storedId: "STOREDSHARE00001")),
                       "a live share was removed as though it were finalized")
        XCTAssertTrue(exists(store.jobURL(for: live.jobId)))

        try twinInProtectedRoot(store.jobURL(for: plan.jobId))
        XCTAssertEqual(makeStore().finalizedSharesAwaitingSalvage(), [], "a conflict was named for salvage (R2)")
        XCTAssertFalse(store.purgeFinalizedShare(entry), "the shared copy of a conflict was purged (R2)")
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)))

        try FileManager.default.removeItem(at: protectedRoot.appendingPathComponent(plan.jobId))
        XCTAssertTrue(store.purgeFinalizedShare(entry))
        XCTAssertFalse(exists(store.jobURL(for: plan.jobId)))
        XCTAssertTrue(store.purgeFinalizedShare(entry), "an already-gone directory is a success")
    }

    // T5
    func testSharedSweepRemovesUnprovableEntriesButNeverListsThem() throws {
        let store = makeStore()

        // Unreadable plan and plan-less directory, both with valid ids.
        let unreadable = sharedRoot.appendingPathComponent("SHAREDUNREAD0001")
        try FileManager.default.createDirectory(at: unreadable, withIntermediateDirectories: true)
        try Data("{not a plan".utf8).write(to: unreadable.appendingPathComponent("plan.json"))
        let planless = sharedRoot.appendingPathComponent("SHAREDPLANLESS01")
        try FileManager.default.createDirectory(at: planless, withIntermediateDirectories: true)

        // A retired tombstone — the exact shape that IS listed — declaring a
        // version this build does not know.
        let newer = try stagedShare(in: store)
        _ = try store.markRetired(newer)
        try rewritePlan(store.planURL(for: newer.jobId)) {
            $0["version"] = PendingUploadPlan.currentVersion + 1
        }

        // A retired tombstone whose directory name differs from its jobId.
        let moved = try stagedShare(in: store)
        _ = try store.markRetired(moved)
        let mismatched = sharedRoot.appendingPathComponent("SHAREDMISMATCH01")
        try FileManager.default.moveItem(at: store.jobURL(for: moved.jobId), to: mismatched)

        XCTAssertEqual(makeStore().sweepIncomplete(), [], "an unprovable entry was listed for key removal")
        for url in [unreadable, planless, store.jobURL(for: newer.jobId), mismatched] {
            XCTAssertFalse(exists(url), "\(url.lastPathComponent) was not swept as before")
        }
    }

    // T6
    func testSharedSweepDoesNotListAFailedRemovalButListsTheRetry() throws {
        let fm = RemovalFailingFileManager()
        let store = PendingUploadStore(root: sharedRoot, fileManager: fm)
        let plan = try stagedShare(in: store)
        _ = try store.markRetired(plan)
        fm.failNextRemoval(of: store.jobURL(for: plan.jobId))

        XCTAssertEqual(store.sweepIncomplete(), [])
        XCTAssertEqual(fm.failures, 1)
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)))
        XCTAssertEqual(store.sweepIncomplete(), [plan.jobId])
        XCTAssertFalse(exists(store.jobURL(for: plan.jobId)))
    }

    // T7
    func testSharedSweepDoesNotListAnIdTheProtectedRootStillHolds() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        _ = try store.markRetired(plan)
        try FileManager.default.createDirectory(at: protectedRoot, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: store.jobURL(for: plan.jobId),
                                         to: protectedRoot.appendingPathComponent(plan.jobId))

        XCTAssertEqual(makeStore().sweepIncomplete(), [],
                       "the key is filed by job id; the protected copy still needs it")
        XCTAssertTrue(exists(protectedRoot.appendingPathComponent(plan.jobId)),
                      "the shared sweep touched the protected root")
        // C1: R2 — a conflict's shared copy is not deleted either.
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)),
                      "the shared sweep deleted one copy of a conflict (R2)")
        XCTAssertEqual(makeStore().protectedDeviceStore().ownershipConflicts(), [plan.jobId],
                       "the retained pair must still be reported as a conflict")
    }

    /// The entries whose shared copy the sweep would delete, one of each
    /// failing guard. Returns every entry's shared directory and the ids a
    /// sweep lists when NO protected twin exists.
    private func sweepableSharedEntries(
        in store: PendingUploadStore
    ) throws -> (dirs: [URL], listedWithoutTwin: [String]) {
        let unreadable = sharedRoot.appendingPathComponent("SHAREDUNREAD0001")
        try FileManager.default.createDirectory(at: unreadable, withIntermediateDirectories: true)
        try Data("{not a plan".utf8).write(to: unreadable.appendingPathComponent("plan.json"))
        let planless = sharedRoot.appendingPathComponent("SHAREDPLANLESS01")
        try FileManager.default.createDirectory(at: planless, withIntermediateDirectories: true)

        let newer = try stagedShare(in: store)
        _ = try store.markRetired(newer)
        try rewritePlan(store.planURL(for: newer.jobId)) {
            $0["version"] = PendingUploadPlan.currentVersion + 1
        }

        let moved = try stagedShare(in: store)
        _ = try store.markRetired(moved)
        let mismatched = sharedRoot.appendingPathComponent("SHAREDMISMATCH01")
        try FileManager.default.moveItem(at: store.jobURL(for: moved.jobId), to: mismatched)

        let stagingGone = try stagedShare(in: store)
        try FileManager.default.removeItem(at: store.jobURL(for: stagingGone.jobId)
            .appendingPathComponent("staged/0"))

        let retired = try stagedShare(in: store)
        _ = try store.markRetired(retired)

        let finalized = try stagedShare(in: store)
        _ = try store.markFinalized(finalized, storedId: "STOREDSHARE00001")

        let dirs = [unreadable, planless, store.jobURL(for: newer.jobId), mismatched,
                    store.jobURL(for: stagingGone.jobId), store.jobURL(for: retired.jobId),
                    store.jobURL(for: finalized.jobId)]
        return (dirs, [stagingGone.jobId, retired.jobId].sorted())
    }

    /// The one entry of `sweepableSharedEntries` the sweep itself no longer
    /// deletes: the finalized share (d2), retained for salvage.
    private func isFinalizedShare(_ dir: URL) -> Bool {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("plan.json")),
              let plan = try? JSONDecoder().decode(PendingUploadPlan.self, from: data) else { return false }
        return plan.finalizedStoredId != nil && !plan.retired
    }

    /// Give a shared entry a protected twin: the same directory name, as a copy.
    private func twinInProtectedRoot(_ shared: URL) throws {
        try FileManager.default.createDirectory(at: protectedRoot, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: shared,
                                         to: protectedRoot.appendingPathComponent(shared.lastPathComponent))
    }

    // C2 + C3 (C1 is the retired entry, also asserted in T7)
    func testSharedSweepKeepsEveryConflictingEntryWhateverItsPlanSays() throws {
        let store = makeStore()
        let (dirs, _) = try sweepableSharedEntries(in: store)
        for dir in dirs { try twinInProtectedRoot(dir) }

        XCTAssertEqual(makeStore().sweepIncomplete(), [], "a conflicting id was listed for key removal")
        for dir in dirs {
            XCTAssertTrue(exists(dir), "\(dir.lastPathComponent): the shared copy of a conflict was deleted (R2)")
            XCTAssertTrue(exists(protectedRoot.appendingPathComponent(dir.lastPathComponent)),
                          "\(dir.lastPathComponent): the shared sweep touched the protected root")
        }
        XCTAssertEqual(makeStore().protectedDeviceStore().ownershipConflicts(),
                       dirs.map(\.lastPathComponent).sorted(),
                       "every retained pair must still be reported as a conflict")
        XCTAssertNil(store.plan(for: "acct-1"), "a retained conflicting copy was offered")
        XCTAssertEqual(makeStore().finalizedSharesAwaitingSalvage(), [],
                       "a conflicting finalized share was named for salvage (R2)")
    }

    // C4 (control)
    func testSharedSweepDeletesTheSameEntriesAsBeforeWithoutAProtectedTwin() throws {
        let store = makeStore()
        let (dirs, listed) = try sweepableSharedEntries(in: store)

        XCTAssertEqual(makeStore().sweepIncomplete(), listed)
        for dir in dirs where !isFinalizedShare(dir) {
            XCTAssertFalse(exists(dir), "\(dir.lastPathComponent) was not swept as before")
        }
        let finalized = dirs.filter(isFinalizedShare)
        XCTAssertEqual(finalized.count, 1, "fixture: exactly one finalized share")
        for dir in finalized {
            XCTAssertTrue(exists(dir), "the sweep deleted a finalized share before salvage (d2)")
        }
        XCTAssertEqual(makeStore().finalizedSharesAwaitingSalvage().map(\.jobId),
                       finalized.map(\.lastPathComponent))
    }

    // C5
    func testSharedSweepDeletesADirectoryWhoseNameIsNotAnIdEvenWithATwinName() throws {
        // `bad.name` cannot be a StoredObjectID, so no protected job can carry
        // it and it can never conflict — even when a same-named directory
        // happens to exist in the protected root.
        let bad = sharedRoot.appendingPathComponent("bad.name")
        try FileManager.default.createDirectory(at: bad, withIntermediateDirectories: true)
        try twinInProtectedRoot(bad)

        XCTAssertEqual(makeStore().sweepIncomplete(), [])
        XCTAssertFalse(exists(bad), "an entry that cannot conflict was retained")
        XCTAssertTrue(exists(protectedRoot.appendingPathComponent("bad.name")),
                      "the shared sweep touched the protected root")
    }

    // T8
    func testSharedSweepNeitherRemovesNorListsALiveShare() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)

        XCTAssertEqual(makeStore().sweepIncomplete(), [])
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)))
        XCTAssertEqual(store.plan(for: "acct-1")?.jobId, plan.jobId)
    }
}

// MARK: - shared-store mutators honour a live conflict (R2)

/// A LIVE share whose id the protected root also holds is a conflict: the
/// shared store neither tombstones nor deletes it, and does not offer it for
/// resume (executing either copy is what R2 forbids, and every resume-surface
/// path that ends a job removes the id-filed content key). The protected
/// store's own refusals are unchanged.
extension PendingUploadStoreTests {
    private func protectedDelivery(in store: PendingUploadStore) throws -> PendingUploadPlan {
        try store.prepare(files: try selection([(Array("gift".utf8), "a.txt")]),
                          accountId: "acct-1", burnAfterRead: false,
                          ttl: UploadPurpose.deviceTaskTTLSeconds,
                          target: PendingUploadTarget(deviceId: "DEVICE0123456789", keyId: "KEY0123456789ab",
                                                      keyGeneration: 4,
                                                      createIdempotencyKey: "8C1A0F3D-2B45-4C6E-9A17-0000000000AA"))
    }

    // P1
    func testSharedPurgeRefusesALiveShareWithAProtectedTwin() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        let shared = store.jobURL(for: plan.jobId)
        try twinInProtectedRoot(shared)

        XCTAssertFalse(store.purge(jobId: plan.jobId), "a conflicting shared copy was purged (R2)")
        XCTAssertFalse(store.purge(plan))
        XCTAssertTrue(exists(shared))
        XCTAssertTrue(exists(protectedRoot.appendingPathComponent(plan.jobId)))
        XCTAssertEqual(makeStore().protectedDeviceStore().ownershipConflicts(), [plan.jobId],
                       "the live conflict must still be reported")
    }

    // P1 (control)
    func testSharedPurgeRemovesALiveShareWithoutAProtectedTwin() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)

        XCTAssertTrue(store.purge(jobId: plan.jobId))
        XCTAssertFalse(exists(store.jobURL(for: plan.jobId)))
    }

    // P2
    func testSharedMarkRetiredRefusesALiveShareWithAProtectedTwin() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        let planFile = store.jobURL(for: plan.jobId).appendingPathComponent("plan.json")
        let before = try Data(contentsOf: planFile)
        try twinInProtectedRoot(store.jobURL(for: plan.jobId))

        XCTAssertThrowsError(try store.markRetired(plan)) { error in
            XCTAssertEqual(error as? PendingUploadError, .stagingMissing)
        }
        XCTAssertEqual(try Data(contentsOf: planFile), before, "the conflicting plan was rewritten")
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)))
    }

    // P2 (control)
    func testSharedMarkRetiredTombstonesALiveShareWithoutAProtectedTwin() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)

        XCTAssertTrue(try store.markRetired(plan).retired)
        XCTAssertNil(makeStore().plan(for: "acct-1"))
    }

    // P3
    func testProtectedPurgeAndRetireOfAnOwnedDeliveryAreUnchanged() throws {
        let device = makeStore().protectedDeviceStore()
        let owned = try protectedDelivery(in: device)
        XCTAssertEqual(device.ownership(of: owned.jobId), .owned)
        XCTAssertTrue(try device.markRetired(owned).retired)
        XCTAssertTrue(device.purge(jobId: owned.jobId))
        XCTAssertFalse(exists(device.jobURL(for: owned.jobId)))

        // And a protected job with a shared twin is still refused from that side.
        let conflicted = try protectedDelivery(in: device)
        try FileManager.default.createDirectory(at: sharedRoot.appendingPathComponent(conflicted.jobId),
                                                withIntermediateDirectories: true)
        XCTAssertThrowsError(try device.markRetired(conflicted))
        XCTAssertFalse(device.purge(jobId: conflicted.jobId))
        XCTAssertTrue(exists(device.jobURL(for: conflicted.jobId)))
    }

    // P4
    func testALiveShareWithAProtectedTwinIsNotOfferedForResume() throws {
        let store = makeStore()
        let plan = try stagedShare(in: store)
        XCTAssertEqual(store.plan(for: "acct-1")?.jobId, plan.jobId, "precondition: offered before the twin")
        try twinInProtectedRoot(store.jobURL(for: plan.jobId))

        XCTAssertNil(makeStore().plan(for: "acct-1"), "a conflicting live share was offered for resume (R2)")
        XCTAssertEqual(makeStore().sweepIncomplete(), [])
        XCTAssertTrue(exists(store.jobURL(for: plan.jobId)), "the launch sweep deleted the hidden conflict")
    }
}
