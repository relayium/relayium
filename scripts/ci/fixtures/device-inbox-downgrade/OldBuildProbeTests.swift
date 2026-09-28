import CryptoKit
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Compiled ONLY into a copy of the frozen macOS 1.4.3 (40) Swift sources
/// (`e96dc9e6c`) by `scripts/ci/device-inbox-downgrade-probe.sh`. It does, with
/// that build's own code, what that build does to its pending uploads when it
/// is launched after a newer build: the launch sweep, the stored-link recovery
/// lookup and the Device Inbox listing — and then presses Retry on everything
/// it was shown. The protected `DeviceInboxSends` root must come out
/// byte-identical and must never have been read as a job.
final class OldBuildProbeTests: XCTestCase {
    func testTheFrozenBuildCannotSeeSweepOrResumeTheProtectedRoot() async throws {
        guard let dir = ProcessInfo.processInfo.environment["RELAYIUM_DOWNGRADE_PROBE_DIR"] else {
            throw XCTSkip("RELAYIUM_DOWNGRADE_PROBE_DIR not set")   // nonlocalized: probe-only
        }
        let base = URL(fileURLWithPath: dir)
        let shared = base.appendingPathComponent("PendingUploads")
        let protected = base.appendingPathComponent("DeviceInboxSends")
        let before = try treeDigest(protected)

        // The frozen build's launch: exactly its own entry points, its own root.
        let store = PendingUploadStore(root: shared)
        store.sweepIncomplete()
        let resumable = store.plan(for: "acct-1")
        let deliveries = store.deviceSendPlans(for: "acct-1")

        // And a user pressing Retry on every delivery it lists.
        final class Refusing: ResumableTransport, @unchecked Sendable {
            var requests = 0
            func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                            size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
                requests += 1; throw CloudError.network
            }
            func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int, total: Int, token: String,
                            onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
                requests += 1; throw CloudError.network
            }
            func uploadOffset(uploadId: String, token: String) async throws -> Int {
                requests += 1; throw CloudError.network
            }
            func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
                requests += 1; throw CloudError.network
            }
        }
        var retried: [String] = []
        for plan in deliveries {
            retried.append(plan.jobId)
            let coordinator = InboxSendCoordinator(store: store, keys: InMemoryStoredLinkKeyStore(),
                                                   uploader: CloudUploader(transport: Refusing()),
                                                   sender: NoSender())
            _ = try? await coordinator.deliver(plan, token: "bearer")
        }

        let after = try treeDigest(protected)
        let report: [String: Any] = [
            "frozenSource": "e96dc9e6c",
            "protectedDigestBefore": before, "protectedDigestAfter": after,
            "protectedUnchanged": before == after,
            "sharedResumablePlan": resumable?.jobId ?? NSNull(),
            "sharedResumablePurpose": resumable?.effectivePurpose.rawValue ?? NSNull(),
            "sharedDeliveriesListed": deliveries.map(\.jobId),
            "retriedByOldBuild": retried,
        ]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: base.appendingPathComponent("old-build-report.json"))
        XCTAssertEqual(before, after, "the frozen build changed the protected root")
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf:
            base.appendingPathComponent("fixture.json"))) as? [String: String]
        XCTAssertFalse(deliveries.map(\.jobId).contains(fixture?["protectedJob"] ?? "-"),
                       "the frozen build listed a protected delivery")
        XCTAssertNotEqual(resumable?.jobId, fixture?["protectedJob"])
    }
}

/// Answers nothing: the frozen build must not get far enough to need it.
final class NoSender: InboxSenderTransport, @unchecked Sendable {
    func devices() async throws -> [InboxDeviceRow] { throw InboxError.network }
    func renameDevice(deviceID: String, name: String) async throws { throw InboxError.network }
    func createTask(targetDeviceID: String, _ request: InboxSendRequest) async throws -> InboxTaskCreation {
        throw InboxError.network
    }
    func task(targetDeviceID: String, taskID: String) async throws -> InboxTask { throw InboxError.network }
    func tasks(targetDeviceID: String, limit: Int) async throws -> [InboxTask] { throw InboxError.network }
    func cancelTask(targetDeviceID: String, taskID: String) async throws { throw InboxError.network }
}

/// Every path and every byte under `root`, as one digest.
func treeDigest(_ root: URL) throws -> String {
    var hasher = SHA256()
    let fm = FileManager.default
    guard let e = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return "absent" }
    var files: [URL] = []
    for case let url as URL in e { files.append(url) }
    for url in files.sorted(by: { $0.path < $1.path }) {
        let rel = String(url.path.dropFirst(root.path.count))
        hasher.update(data: Data(rel.utf8))
        if (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            hasher.update(data: (try? Data(contentsOf: url)) ?? Data("<unreadable>".utf8))
        }
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
