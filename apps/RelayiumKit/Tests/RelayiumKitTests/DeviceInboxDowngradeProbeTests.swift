import CryptoKit
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The CURRENT build's half of `scripts/ci/device-inbox-downgrade-probe.sh`.
///
/// `produce` writes, with this build's own code, the layout a user has after
/// running it: a delivery whose finalize may have been sent (protected root),
/// a terminal one, an entry a newer build might have written, a share and a
/// delivery an earlier build left in the shared root. The script then runs the
/// FROZEN 1.4.3 code over it (`OldBuildProbeTests`), and `consume` checks, with
/// this build again, that nothing it needs was lost and that upgrading back
/// adopts what the earlier build owns.
///
/// Skipped unless the script sets `RELAYIUM_DOWNGRADE_PROBE_DIR` and
/// `RELAYIUM_DOWNGRADE_PROBE_PHASE`; the permanent guards are the unit tests.
final class DeviceInboxDowngradeProbeTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func target() -> PendingUploadTarget {
        PendingUploadTarget(deviceId: "DEVICE0123456789", keyId: "KEY0123456789abcd", keyGeneration: 4)
    }

    func testDowngradeProbePhase() async throws {
        guard let dir = env["RELAYIUM_DOWNGRADE_PROBE_DIR"], let phase = env["RELAYIUM_DOWNGRADE_PROBE_PHASE"] else {
            throw XCTSkip("run by scripts/ci/device-inbox-downgrade-probe.sh")   // nonlocalized: probe-only
        }
        let base = URL(fileURLWithPath: dir)
        let shared = PendingUploadStore(root: base.appendingPathComponent("PendingUploads"))
        let device = shared.protectedDeviceStore()
        XCTAssertEqual(device.jobURL(for: "J").deletingLastPathComponent().lastPathComponent, "DeviceInboxSends")
        let fixtureURL = base.appendingPathComponent("fixture.json")
        let bytes = Array("downgrade probe".utf8)

        if phase == "produce" {
            var marked = try device.prepare(sources: [DataSource(name: "a.txt", bytes: bytes)], accountId: "acct-1",
                                            burnAfterRead: false, ttl: UploadPurpose.deviceTaskTTLSeconds,
                                            target: target())
            marked = try device.setUploadSession(id: "SESSIONMARKED001", chunkSize: 65_536, for: marked)
            marked = try device.markFinalizing(uploadId: "SESSIONMARKED001", for: marked)
            var gone = try device.prepare(sources: [DataSource(name: "b.txt", bytes: bytes)], accountId: "acct-1",
                                          burnAfterRead: false, ttl: UploadPurpose.deviceTaskTTLSeconds,
                                          target: target())
            gone = try device.setUploadSession(id: "SESSIONEXPIRED01", chunkSize: 65_536, for: gone)
            gone = try device.markFinalizing(uploadId: "SESSIONEXPIRED01", for: gone)
            try device.recordTerminal(.expired, uploadId: "SESSIONEXPIRED01", for: gone)
            // What a NEWER build might leave: unreadable here, retained anyway.
            let newer = base.appendingPathComponent("DeviceInboxSends/9A9A9A9A-0000-4000-8000-000000000001")
            try FileManager.default.createDirectory(at: newer, withIntermediateDirectories: true)
            try Data(#"{"version":99}"#.utf8).write(to: newer.appendingPathComponent("plan.json"))
            let share = try shared.prepare(sources: [DataSource(name: "s.txt", bytes: bytes)], accountId: "acct-1",
                                           burnAfterRead: false, ttl: 3600)
            // A delivery an earlier build owns: staged here then moved into the
            // shared root without the protected fields it never writes.
            let elsewhere = PendingUploadStore(root: base.appendingPathComponent("elsewhere")).protectedDeviceStore()
            let legacy = try elsewhere.prepare(sources: [DataSource(name: "c.txt", bytes: bytes)], accountId: "acct-1",
                                               burnAfterRead: false, ttl: UploadPurpose.deviceTaskTTLSeconds,
                                               target: target())
            let legacyDir = base.appendingPathComponent("PendingUploads").appendingPathComponent(legacy.jobId)
            try FileManager.default.moveItem(at: elsewhere.jobURL(for: legacy.jobId), to: legacyDir)
            // Harness control only (`RELAYIUM_DOWNGRADE_PROBE_CONTROL=shared-root`):
            // put the marked delivery where the frozen build DOES look, so its
            // own assertion must go red — proof the frozen stage can detect
            // exposure rather than passing because it inspected nothing.
            if env["RELAYIUM_DOWNGRADE_PROBE_CONTROL"] == "shared-root" {
                try FileManager.default.moveItem(
                    at: device.jobURL(for: marked.jobId),
                    to: base.appendingPathComponent("PendingUploads").appendingPathComponent(marked.jobId))
            }
            try JSONSerialization.data(withJSONObject: ["protectedJob": marked.jobId, "terminalJob": gone.jobId,
                                                        "shareJob": share.jobId, "legacyJob": legacy.jobId,
                                                        "digest": try digest(base.appendingPathComponent("DeviceInboxSends"))])
                .write(to: fixtureURL)
            return
        }

        let fixture = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: String])
        XCTAssertEqual(try digest(base.appendingPathComponent("DeviceInboxSends")), fixture["digest"],
                       "the protected root changed while the frozen build ran")
        let marked = try XCTUnwrap(device.ownedDevicePlan(jobId: fixture["protectedJob"]!))
        XCTAssertEqual(marked.deviceSessionState, .finalizing("SESSIONMARKED001"))
        let gone = try XCTUnwrap(device.ownedDevicePlan(jobId: fixture["terminalJob"]!))
        XCTAssertEqual(gone.deviceSessionState, .terminal(.expired))
        XCTAssertTrue(FileManager.default.fileExists(atPath:
            base.appendingPathComponent("DeviceInboxSends/9A9A9A9A-0000-4000-8000-000000000001/plan.json").path))
        let report = device.adoptLegacyDeliveries()
        XCTAssertEqual(report.moved, [fixture["legacyJob"]!])
        XCTAssertEqual(shared.plan(for: "acct-1")?.jobId, fixture["shareJob"])
        XCTAssertEqual(Set(device.deviceSendPlans(for: "acct-1").map(\.jobId)),
                       Set([fixture["protectedJob"]!, fixture["terminalJob"]!, fixture["legacyJob"]!]))
    }

    private func digest(_ root: URL) throws -> String {
        var hasher = SHA256()
        guard let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else {
            return "absent"
        }
        var files: [URL] = []
        for case let url as URL in e { files.append(url) }
        for url in files.sorted(by: { $0.path < $1.path }) {
            hasher.update(data: Data(String(url.path.dropFirst(root.path.count)).utf8))
            if (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                hasher.update(data: (try? Data(contentsOf: url)) ?? Data("<unreadable>".utf8))
            }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
