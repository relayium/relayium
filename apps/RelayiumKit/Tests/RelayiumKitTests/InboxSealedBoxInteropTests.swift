import XCTest
@testable import RelayiumKit

/// Cross-implementation proof, BY EXECUTION, that a sealed box the Go sender
/// produces is one this native receiver can open.
///
/// This suite is the driver. It runs the real Go implementation with the real
/// native implementation on both sides of it:
///
///  1. Swift mints a device keypair with `InboxKeyMaterial.generateKeyPair` — the
///     receiver's own function — and a random 32-byte content key, and writes the
///     PUBLIC half and the expected content key before Go has computed anything.
///     The expected value is therefore never derived from the code under test.
///  2. Go (`TestSwiftSealedBoxSeal`) validates that public key through central's
///     own `inbox.ValidatePublicKey` and seals the content key with
///     `nacl/box.SealAnonymous`.
///  3. Swift opens it with the private half alone — which never left this
///     process — and asserts it is byte-for-byte the key from step 1, then that a
///     different device, a mismatched pair, a tampered byte, a wrong length and a
///     non-canonical spelling all fail.
///
/// The last case is the one that makes the whole gate trustworthy: a device key
/// Go must refuse has to make the Go phase EXIT NON-ZERO. Without it, a silently
/// broken harness would look exactly like a passing interoperability test
/// (WORKFLOW-LEARNINGS, 2026-08-08: an assertion that cannot fail is worse than
/// none).
///
/// `RELAYIUM_SWIFT_INTEROP` makes the decision explicit rather than accidental:
/// `1` = run and never skip (the dedicated gate), `0` = do not run. Unset falls
/// back to "run if a Go toolchain is here", which is what a developer wants
/// locally. A skip is impossible in the environment that is supposed to be
/// proving something.
final class InboxSealedBoxInteropTests: XCTestCase {

    private static let forced = ProcessInfo.processInfo.environment["RELAYIUM_SWIFT_INTEROP"] == "1"
    private static let disabled = ProcessInfo.processInfo.environment["RELAYIUM_SWIFT_INTEROP"] == "0"

    private var serverDirectory: URL {
        get throws { try RepoRoot.directory("server") }
    }

    private func shouldRun() throws -> Bool {
        if Self.disabled { return false }
        if Self.forced { return true }
        return goExecutable() != nil
    }

    /// `go` is not on the PATH a test host inherits from Xcode, so the usual
    /// install locations are tried explicitly. Returning nil is what makes the
    /// local run skip rather than fail; the forced mode above is what makes the
    /// gate refuse to skip where it matters.
    private func goExecutable() -> URL? {
        let candidates = ["/opt/homebrew/bin/go", "/usr/local/go/bin/go", "/usr/local/bin/go",
                          "/opt/homebrew/opt/go/bin/go"]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        if let env = ProcessInfo.processInfo.environment["PATH"] {
            for directory in env.split(separator: ":") {
                let path = String(directory) + "/go"
                if FileManager.default.isExecutableFile(atPath: path) {
                    return URL(fileURLWithPath: path)
                }
            }
        }
        return nil
    }

    @discardableResult
    private func runGoSeal(in directory: URL) throws -> (status: Int32, output: String) {
        try runGo("TestSwiftSealedBoxSeal", in: directory)
    }

    /// Run ONE named Go test against a shared temporary directory.
    ///
    /// Named rather than a package-wide run so each phase's exit status means
    /// exactly one thing — which is what the negative controls read.
    @discardableResult
    private func runGo(_ test: String, in directory: URL) throws -> (status: Int32, output: String) {
        guard let go = goExecutable() else {
            throw XCTSkip("no Go toolchain")   // nonlocalized: skip reason, never rendered
        }
        let process = Process()
        process.executableURL = go
        process.arguments = ["test", "-tags", "swiftinterop", "-count=1",
                             "-run", "^\(test)$", "./internal/inboxclient/"]
        process.currentDirectoryURL = try serverDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["RELAYIUM_INTEROP_DIR"] = directory.path
        // A test host's HOME may not be writable, and the module cache has to go
        // somewhere; keeping it beside the run makes the process hermetic.
        environment["GOCACHE"] = directory.appendingPathComponent("gocache").path
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    private func writeDeviceKey(_ directory: URL, publicKey: String, contentKey: String) throws {
        let payload: [String: String] = [
            "algorithm": InboxProtocol.keyAlgorithm,
            "publicKey": publicKey,
            "contentKey": contentKey,
            "mintedBy": "relayium-swift",
        ]
        try JSONSerialization.data(withJSONObject: payload)
            .write(to: directory.appendingPathComponent("device-key.json"))
    }

    func testTheGoSenderSealsAKeyThisReceiverOpensAndEveryNearMissFails() throws {
        try XCTSkipUnless(try shouldRun(), "Go interop not enabled")   // nonlocalized: skip reason

        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-swift-interop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let device = try InboxKeyMaterial.generateKeyPair()
        let expected = generateStoreKey()
        try writeDeviceKey(directory,
                           publicKey: InboxKeyMaterial.encode(device.publicKey),
                           contentKey: InboxKeyMaterial.encode(expected))

        let sealPhase = try runGoSeal(in: directory)
        XCTAssertEqual(sealPhase.status, 0, "the Go seal phase failed:\n\(sealPhase.output)")

        let boxData = try Data(contentsOf: directory.appendingPathComponent("go-box.json"))
        let box = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: boxData) as? [String: String])
        XCTAssertEqual(box["sealedBy"], "relayium-go",
                       "go-box.json was not produced by the Go implementation")
        XCTAssertEqual(box["algorithm"], InboxProtocol.keyAlgorithm)
        let wrapped = try XCTUnwrap(box["wrappedKey"])

        // The assertion the whole gate exists for.
        let opened = try InboxKeyMaterial.unsealContentKey(algorithm: InboxProtocol.keyAlgorithm,
                                                           wrappedKey: wrapped, keyPair: device)
        XCTAssertEqual(opened, expected,
                       "the unsealed content key is not the one Go was asked to wrap")

        let raw = try InboxKeyMaterial.decode(wrapped, expecting: InboxProtocol.sealedBoxBytes)

        // A different device cannot open it.
        let other = try InboxKeyMaterial.generateKeyPair()
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: wrapped, keyPair: other))

        // The private half alone decides: the real public half with somebody
        // else's private half must fail even though the public key matches the
        // recipient Go sealed to.
        let mixed = InboxDeviceKeyPair(publicKey: device.publicKey, privateKey: other.privateKey)
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: wrapped, keyPair: mixed))

        // Tampering, at the ephemeral key, the tag and the ciphertext.
        for index in [0, 31, 40, raw.count - 1] {
            var tampered = raw
            tampered[index] ^= 0x01
            XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
                algorithm: InboxProtocol.keyAlgorithm,
                wrappedKey: InboxKeyMaterial.encode(tampered), keyPair: device),
                "a box tampered at byte \(index) still opened")
        }

        // A truncated or over-long box, refused before any crypto runs.
        for bad in [Array(raw.dropLast()), raw + [0]] {
            XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
                algorithm: InboxProtocol.keyAlgorithm,
                wrappedKey: InboxKeyMaterial.encode(bad), keyPair: device))
        }

        // A non-canonical spelling of the same bytes.
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: wrapped + "=", keyPair: device))

        // Another algorithm token.
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: "x25519-sealedbox-v2", wrappedKey: wrapped, keyPair: device))
    }

    /// The control that makes the gate trustworthy: the Go phase must EXIT
    /// NON-ZERO on a device key central would refuse.
    ///
    /// Without this, a harness that silently failed to run Go at all — a wrong
    /// path, a build error swallowed, a stale `go-box.json` from a previous run —
    /// would be indistinguishable from a passing interoperability test.
    func testTheGoPhaseFailsOnAKeyCentralWouldRefuse() throws {
        try XCTSkipUnless(try shouldRun(), "Go interop not enabled")   // nonlocalized: skip reason

        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-swift-interop-bad-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        // A low-order point: syntactically valid, the right length, and every
        // wrap to it is recoverable by anybody.
        var lowOrder = [UInt8](repeating: 0, count: 32)
        lowOrder[0] = 1
        try writeDeviceKey(directory, publicKey: InboxKeyMaterial.encode(lowOrder),
                           contentKey: InboxKeyMaterial.encode(generateStoreKey()))

        let phase = try runGoSeal(in: directory)
        XCTAssertNotEqual(phase.status, 0,
                          "the Go phase accepted a key central refuses:\n\(phase.output)")
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("go-box.json").path),
            "a refused key still produced a sealed box")
    }

    // MARK: - the sender direction: Swift seals, Go opens

    /// A per-run directory, removed when the test ends.
    private func interopDirectory(_ label: String) throws -> URL {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-swift-send-\(label)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    /// Phase 1: Go mints the recipient key and the expected content key.
    private func mintGoRecipient(in directory: URL) throws -> (publicKey: String,
                                                               contentKey: String) {
        let phase = try runGo("TestSwiftSealedBoxMintRecipient", in: directory)
        XCTAssertEqual(phase.status, 0, "the Go mint phase failed:\n\(phase.output)")
        let data = try Data(contentsOf: directory.appendingPathComponent("go-recipient.json"))
        let file = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(file["mintedBy"], "relayium-go",
                       "go-recipient.json was not produced by the Go implementation")
        XCTAssertEqual(file["algorithm"], InboxProtocol.keyAlgorithm)
        return (try XCTUnwrap(file["publicKey"]), try XCTUnwrap(file["contentKey"]))
    }

    /// Phase 2: hand Go a box for it to open.
    private func writeSwiftBox(_ directory: URL, wrappedKey: String) throws {
        let payload: [String: String] = [
            "algorithm": InboxProtocol.keyAlgorithm,
            "wrappedKey": wrappedKey,
            "sealedBy": "relayium-swift",
        ]
        try JSONSerialization.data(withJSONObject: payload)
            .write(to: directory.appendingPathComponent("swift-box.json"))
    }

    /// The assertion the native SENDER exists for: a box produced by the real
    /// `InboxKeyMaterial.sealContentKey` is opened by the real Go
    /// implementation, in another process, back to the exact content key GO
    /// chose before Swift computed anything.
    func testTheSwiftSenderSealsAKeyTheGoReceiverOpens() throws {
        try XCTSkipUnless(try shouldRun(), "Go interop not enabled")   // nonlocalized: skip reason

        let directory = try interopDirectory("open")
        let recipient = try mintGoRecipient(in: directory)

        let wrapped = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: recipient.publicKey,
            contentKey: try InboxKeyMaterial.decode(recipient.contentKey, expecting: 32))
        // Canonical, exact length, before Go is asked anything — so a failure in
        // the open phase is about the CRYPTO rather than about the spelling.
        XCTAssertEqual(try InboxKeyMaterial.decode(wrapped,
                                                   expecting: InboxProtocol.sealedBoxBytes).count,
                       InboxProtocol.sealedBoxBytes)
        try writeSwiftBox(directory, wrappedKey: wrapped)

        let openPhase = try runGo("TestSwiftSealedBoxOpen", in: directory)
        XCTAssertEqual(openPhase.status, 0,
                       "the Go receiver could not open the native sender's box:\n\(openPhase.output)")
    }

    /// The control that makes the direction above trustworthy: the Go OPEN
    /// phase must EXIT NON-ZERO when the box is tampered with, and when it was
    /// sealed to a different target.
    ///
    /// Without it, a harness that silently failed to run Go — a wrong path, a
    /// build error swallowed, a stale `swift-box.json` — would be
    /// indistinguishable from a passing interoperability test
    /// (WORKFLOW-LEARNINGS, 2026-08-08).
    func testTheGoOpenPhaseFailsOnATamperedBoxAndOnTheWrongTarget() throws {
        try XCTSkipUnless(try shouldRun(), "Go interop not enabled")   // nonlocalized: skip reason

        // 1. A single flipped bit in a box that is otherwise exactly right.
        let tamperDirectory = try interopDirectory("tamper")
        let tamperRecipient = try mintGoRecipient(in: tamperDirectory)
        let good = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: tamperRecipient.publicKey,
            contentKey: try InboxKeyMaterial.decode(tamperRecipient.contentKey, expecting: 32))
        var raw = try InboxKeyMaterial.decode(good, expecting: InboxProtocol.sealedBoxBytes)
        raw[raw.count - 1] ^= 0x01
        try writeSwiftBox(tamperDirectory, wrappedKey: InboxKeyMaterial.encode(raw))
        let tampered = try runGo("TestSwiftSealedBoxOpen", in: tamperDirectory)
        XCTAssertNotEqual(tampered.status, 0,
                          "the Go phase opened a tampered box:\n\(tampered.output)")

        // 2. A perfectly valid box, sealed to somebody else.
        let wrongDirectory = try interopDirectory("wrong-target")
        let wrongRecipient = try mintGoRecipient(in: wrongDirectory)
        let other = try InboxKeyMaterial.generateKeyPair()
        let misdirected = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(other.publicKey),
            contentKey: try InboxKeyMaterial.decode(wrongRecipient.contentKey, expecting: 32))
        try writeSwiftBox(wrongDirectory, wrappedKey: misdirected)
        let wrongTarget = try runGo("TestSwiftSealedBoxOpen", in: wrongDirectory)
        XCTAssertNotEqual(wrongTarget.status, 0,
                          "the Go phase opened a box sealed to another device:\n\(wrongTarget.output)")
    }
}
