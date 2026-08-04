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
