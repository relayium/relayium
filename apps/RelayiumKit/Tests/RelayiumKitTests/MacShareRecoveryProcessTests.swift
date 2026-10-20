import XCTest
import CryptoKit
@testable import RelayiumKit
@testable import RelayiumAppKit

/// Explicit private fixture entry point. The controller SIGKILLs this test
/// process at an observed server-side durable commit, then launches a new one.
@MainActor
final class MacShareRecoveryProcessTests: XCTestCase {
    private actor FixtureKeys: StoredLinkKeyStore {
        let root: URL
        init(_ root: URL) { self.root = root }
        func key(for id: String) async throws -> String? {
            let checked = try StoredObjectID.checked(id)
            let file = root.appendingPathComponent(checked)
            guard FileManager.default.fileExists(atPath: file.path) else { return nil }
            return String(data: try Data(contentsOf: file), encoding: .utf8)
        }
        func save(id: String, keyB64url: String) async throws {
            let checked = try StoredObjectID.checked(id)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let file = root.appendingPathComponent(checked)
            try Data(keyB64url.utf8).write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        }
        func remove(id: String) async throws {
            let file = root.appendingPathComponent(try StoredObjectID.checked(id))
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        }
    }

    func testPrivateProcessWorker() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["MAC_SHARE_PROCESS_ROOT"], let phase = env["MAC_SHARE_PROCESS_PHASE"] else {
            throw XCTSkip("explicit private process fixture only")
        }
        let root = URL(fileURLWithPath: path)
        let origin = try String(contentsOf: root.appendingPathComponent("endpoint"), encoding: .utf8)
        let url = try XCTUnwrap(URL(string: origin))
        guard url.scheme == "http", url.host == "127.0.0.1" else { return XCTFail("loopback only") }
        let pending = AppEnvironment.makePendingUploadSupport(drafts: nil,
            root: root.appendingPathComponent("pending"), keys: FixtureKeys(root.appendingPathComponent("keys")), durableShares: true)
        let finalKeys = FixtureKeys(root.appendingPathComponent("final-keys"))
        let model = AppEnvironment.makeUploadModel(baseURL: url, keyStore: finalKeys, pending: pending)
        if phase == "first" {
            model.accountId = "fixture-account"
            model.pick([root.appendingPathComponent("source.bin")])
            model.start(token: "private-fixture-cookie-bound")
        } else {
            model.recoverPendingJob(for: "fixture-account")
            await model.recoveryTask?.value
            guard case .interrupted = model.state else { return XCTFail("fresh process did not offer recovery") }
            // Prove a launch only offered recovery, then explicitly choose Resume.
            try Data("offered".utf8).write(to: root.appendingPathComponent("offered"))
            model.resume(token: "private-fixture-cookie-bound")
        }
        await model.task?.value
        guard case let .done(link, _, warning) = model.state else { return XCTFail("worker did not complete: \(model.state)") }
        XCTAssertNil(warning)
        let parts = link.components(separatedBy: "#k=")
        XCTAssertEqual(parts.count, 2)
        let id = try XCTUnwrap(URL(string: parts[0])?.lastPathComponent)
        let key = try decodeStoreKey(parts[1])
        let (cipher, response) = try await URLSession.shared.data(from: url.appendingPathComponent("api/files/\(id)/blob"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let decryptor = StoreDecryptor(key: key)
        var hash = SHA256()
        for chunk in try decryptor.push([UInt8](cipher)) { hash.update(data: chunk) }
        let expected = try String(contentsOf: root.appendingPathComponent("expected-sha256"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(actual, expected)
        try decryptor.end(expectedBytes: 20 * 1024 * 1024 + 205)
        let saved = try await finalKeys.key(for: id)
        XCTAssertEqual(saved, parts[1])
        XCTAssertNil(pending.store.plan(for: "fixture-account"))
        let entries = try FileManager.default.contentsOfDirectory(at: pending.store.jobURL(for: "fixture").deletingLastPathComponent(), includingPropertiesForKeys: nil)
        XCTAssertTrue(entries.isEmpty)
        let report: [String: Any] = ["object": id, "sha256": actual, "bytes": decryptor.decryptedBytes,
            "spoolClean": entries.isEmpty, "linkKeySaved": true]
        try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]).write(to: root.appendingPathComponent("native-result.json"))
    }
}
