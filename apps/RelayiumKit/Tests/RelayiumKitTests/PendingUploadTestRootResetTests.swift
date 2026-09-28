import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

#if DEBUG
/// The UI-test staging reset: discarding the acceptance root must take each
/// discarded job's content key with it, and ONLY those keys — the pending-key
/// namespace is shared with the installed app's real uploads.
final class PendingUploadTestRootResetTests: XCTestCase {
    private var base: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("pending-reset-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    private let key = encodeStoreKey([UInt8](repeating: 7, count: 32))

    private func makeJob(_ id: String, in root: URL) throws {
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: dir.appendingPathComponent("plan.json"))
    }

    func testDiscardingTheRootsRemovesExactlyTheirJobsKeys() async throws {
        let shared = base.appendingPathComponent("uitest-pending", isDirectory: true)
        let sibling = PendingUploadStore.protectedDeviceRoot(besides: shared)
        XCTAssertEqual(sibling.lastPathComponent, "uitest-pending.DeviceInboxSends")
        // A real job elsewhere — the installed app's own root — whose key lives
        // in the same namespace and must survive.
        let production = base.appendingPathComponent("PendingUploads", isDirectory: true)

        let shareJob = UUID().uuidString, secondShareJob = UUID().uuidString
        let deliveryJob = UUID().uuidString, realJob = UUID().uuidString
        let strayFile = UUID().uuidString, keyWithoutJob = UUID().uuidString
        try makeJob(shareJob, in: shared)
        try makeJob(secondShareJob, in: shared)
        try makeJob(deliveryJob, in: sibling)
        try makeJob(realJob, in: production)
        // A plain FILE named like a job is not a job directory.
        try Data().write(to: shared.appendingPathComponent(strayFile))

        let keys = InMemoryStoredLinkKeyStore()
        for id in [shareJob, secondShareJob, deliveryJob, realJob, strayFile, keyWithoutJob] {
            try await keys.save(id: id, keyB64url: key)
        }

        let discarded = PendingUploadTestRootReset.discardRoots(besides: shared)
        XCTAssertEqual(Set(discarded), [shareJob, secondShareJob, deliveryJob])
        XCTAssertFalse(FileManager.default.fileExists(atPath: shared.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: sibling.path),
                       "the protected sibling is part of the acceptance root")
        XCTAssertTrue(FileManager.default.fileExists(atPath: production.path))

        // Negative control: the directories are gone and every key is still
        // there. This is the defect — deleting the root alone orphans them.
        for id in [shareJob, secondShareJob, deliveryJob] {
            let stillStored = try await keys.key(for: id)
            XCTAssertNotNil(stillStored, "directory removal alone must not be what removes a key")
        }

        await PendingUploadTestRootReset.removeKeys(for: discarded, from: keys)

        for id in [shareJob, secondShareJob, deliveryJob] {
            let removed = try await keys.key(for: id)
            XCTAssertNil(removed, "the key of discarded job \(id) was left behind")
        }
        for id in [realJob, strayFile, keyWithoutJob] {
            let kept = try await keys.key(for: id)
            XCTAssertEqual(kept, key, "a key whose job was not discarded was removed")
        }
    }

    func testAMissingRootDiscardsNothingAndAnInvalidNameIsSkipped() async throws {
        let shared = base.appendingPathComponent("uitest-pending", isDirectory: true)
        XCTAssertEqual(PendingUploadTestRootReset.discardRoots(besides: shared), [])

        // A directory whose name cannot be a job id never had a key; removal
        // must skip it and still remove the valid one after it.
        try FileManager.default.createDirectory(
            at: shared.appendingPathComponent("not a job", isDirectory: true),
            withIntermediateDirectories: true)
        let valid = UUID().uuidString
        try makeJob(valid, in: shared)
        let keys = InMemoryStoredLinkKeyStore()
        try await keys.save(id: valid, keyB64url: key)

        let discarded = PendingUploadTestRootReset.discardRoots(besides: shared)
        XCTAssertEqual(Set(discarded), ["not a job", valid])
        await PendingUploadTestRootReset.removeKeys(for: discarded, from: keys)
        let removed = try await keys.key(for: valid)
        XCTAssertNil(removed)
    }
}
#endif
