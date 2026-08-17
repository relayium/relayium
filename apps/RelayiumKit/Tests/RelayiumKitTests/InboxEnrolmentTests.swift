import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Getting from "this Mac has credentials" to "this Mac holds the private half of
/// the key senders are wrapping to" — the part of Device Inbox where a mistake is
/// unrecoverable rather than merely annoying.
final class InboxEnrolmentTests: XCTestCase {

    private let account = try! InboxAccountID("accountenrol0001")
    private let epoch = Date(timeIntervalSince1970: 1_000_000)

    private func key(_ id: String, _ publicKey: String, generation: Int64 = 1,
                     superseded: Int64 = 0, revoked: Int64 = 0) -> InboxKey {
        InboxKey(id: id, algorithm: InboxProtocol.keyAlgorithm, publicKey: publicKey,
                 generation: generation, supersededAt: superseded, revokedAt: revoked)
    }

    private func enrolResult(key: InboxKey?, protocolVersion: Int = 2,
                             capability: String = InboxCapability.receiveV2,
                             algorithm: String = InboxProtocol.keyAlgorithm) -> InboxEnrolResult {
        InboxEnrolResult(inbox: InboxView(key: key), protocolVersion: protocolVersion,
                         receiveCapability: capability, keyAlgorithm: algorithm)
    }

    // MARK: - fail closed on negotiation

    /// A 409 from enrolment is "upgrade or stop", never "retry with a default".
    /// Each check names the exact field central chose that this build cannot
    /// honour, which is the difference between an actionable message and "no".
    func testAVersionCapabilityOrAlgorithmThisBuildCannotHonourStopsEnrolment() async throws {
        let cases: [(InboxEnrolResult, InboxProtocolField)] = [
            // Both directions. v1 is the one that will actually occur — an
            // older central still negotiating the historical protocol — and it
            // must stop enrolment rather than leave this build registered as a
            // receiver for manifests it can no longer read.
            (enrolResult(key: nil, protocolVersion: 1), .protocolVersion),
            (enrolResult(key: nil, protocolVersion: 3), .protocolVersion),
            (enrolResult(key: nil, capability: InboxCapability.receiveV1), .receiveCapability),
            (enrolResult(key: nil, capability: "inbox.receive.v3"), .receiveCapability),
            (enrolResult(key: nil, algorithm: "x25519-sealedbox-v2"), .keyAlgorithm),
        ]
        for (result, field) in cases {
            let transport = FakeInboxTransport()
            transport.enrolResult = .success(result)
            do {
                _ = try await InboxEnrolment.enrol(transport, platform: "darwin", appVersion: "1",
                                                   autoAccept: .auto, receiveDirReady: true)
                XCTFail("central's \(field.rawValue) was accepted")
            } catch {
                XCTAssertEqual(error as? InboxError, .unsupportedByServer(field: field))
            }
        }
    }

    func testEnrolAnnouncesThePolicyAndTheFreshlyProbedDirectory() async throws {
        let transport = FakeInboxTransport()
        transport.enrolResult = .success(enrolResult(key: nil))
        _ = try await InboxEnrolment.enrol(transport, platform: "darwin", appVersion: "1",
                                           autoAccept: .auto, receiveDirReady: false)
        XCTAssertEqual(transport.calls, [.enrol(autoAccept: .auto, receiveDirReady: false)])
    }

    // MARK: - the four key cases

    /// Case 1: central's active key is already in this account's history.
    func testAKeyAlreadyHeldNeedsNoRegistration() async throws {
        let transport = FakeInboxTransport()
        let keys = InMemoryInboxDeviceKeyStore()
        let pair = try InboxKeyMaterial.generateKeyPair()
        let encoded = InboxKeyMaterial.encode(pair.publicKey)
        _ = try await keys.append(pair, account: account, now: epoch)
        try await keys.bind(publicKey: encoded, keyID: "k1", generation: 1, account: account)

        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: transport, keys: keys, account: account,
            current: key("k1", encoded), now: epoch)

        XCTAssertEqual(resolved.id, "k1")
        XCTAssertTrue(transport.calls.isEmpty, "a held key must not be re-registered")
    }

    /// Case 2: the registration response was lost. The private key is already
    /// durable, so the device binds the id central gave it rather than minting a
    /// second key — which would abandon the first and strand tasks sealed to it.
    func testALostRegistrationResponseBindsRatherThanMintsASecondKey() async throws {
        let transport = FakeInboxTransport()
        let keys = InMemoryInboxDeviceKeyStore()
        let pair = try InboxKeyMaterial.generateKeyPair()
        let encoded = InboxKeyMaterial.encode(pair.publicKey)
        _ = try await keys.append(pair, account: account, now: epoch)   // durable, unpublished

        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: transport, keys: keys, account: account,
            current: key("k7", encoded), now: epoch)

        XCTAssertEqual(resolved.id, "k7")
        XCTAssertTrue(transport.calls.isEmpty)
        let history = try await keys.load(account: account)
        XCTAssertEqual(history.count, 1, "a second key was minted")
        XCTAssertEqual(history.first?.keyID, "k7")
    }

    /// Case 3, first registration: the key is DURABLE before it is published. The
    /// reverse order can publish a key whose private half never reached storage,
    /// making every task sealed to it permanently undecryptable.
    func testAFirstRegistrationPersistsBeforeItPublishes() async throws {
        let keys = InMemoryInboxDeviceKeyStore()
        var wasDurableWhenRegistered: Bool?
        let recorder = RegisterRecorder(keys: keys, account: account) { held in
            wasDurableWhenRegistered = held
        }

        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: recorder, keys: keys, account: account, current: nil, now: epoch)

        XCTAssertEqual(resolved.id, "k1")
        XCTAssertEqual(wasDurableWhenRegistered, true,
                       "the public key was published before its private half was durable")
        let history = try await keys.load(account: account)
        XCTAssertEqual(history.first?.keyID, "k1")
    }

    /// Case 3, republish: an UNPUBLISHED local record is preferred over a fresh
    /// key, because it may already be registered under an id whose response was
    /// lost.
    func testAnUnpublishedLocalKeyIsPublishedRatherThanReplaced() async throws {
        let transport = FakeInboxTransport()
        let keys = InMemoryInboxDeviceKeyStore()
        let pair = try InboxKeyMaterial.generateKeyPair()
        let encoded = InboxKeyMaterial.encode(pair.publicKey)
        _ = try await keys.append(pair, account: account, now: epoch)
        transport.registerKeyResults = [.success(key("k1", encoded))]

        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: transport, keys: keys, account: account, current: nil, now: epoch)

        XCTAssertEqual(resolved.id, "k1")
        XCTAssertEqual(transport.calls, [.registerKey(publicKey: encoded, previousKeyID: nil)])
        let history = try await keys.load(account: account)
        XCTAssertEqual(history.count, 1)
    }

    /// Case 4: central's active key has no local private half — a restored
    /// machine, a cleared keychain. The device compare-and-swaps onto a fresh key
    /// and is honest about the cost: tasks sealed to the old key stay sealed to it.
    func testAnUnusableCentralKeyIsRotatedAwayFromWithACompareAndSwap() async throws {
        let transport = FakeInboxTransport()
        let keys = InMemoryInboxDeviceKeyStore()
        transport.registerKeyResults = [.success(key("k2", "will-be-replaced", generation: 2))]

        // The registered public key must be the one submitted, so capture it.
        let recorder = RegisterEchoTransport(id: "k2", generation: 2)
        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: recorder, keys: keys, account: account,
            current: key("k1", "a-key-this-mac-does-not-hold"), now: epoch)

        XCTAssertEqual(resolved.id, "k2")
        XCTAssertEqual(recorder.previousKeyIDs, ["k1"], "the rotation did not name its predecessor")
        let history = try await keys.load(account: account)
        XCTAssertEqual(history.map(\.keyID), ["k2"])
        _ = transport
    }

    /// Central registering a DIFFERENT public key than the one submitted would mean
    /// the local private key does not belong to the published public key. Refused
    /// rather than stored.
    func testCentralNamingADifferentKeyIsRefused() async throws {
        let keys = InMemoryInboxDeviceKeyStore()
        let transport = FakeInboxTransport()
        transport.registerKeyResults = [.success(key("k1", "somebody-elses-key"))]
        do {
            _ = try await InboxEnrolment.ensureUsableKey(transport: transport, keys: keys,
                                                         account: account, current: nil, now: epoch)
            XCTFail("a mismatched registration was accepted")
        } catch {
            XCTAssertEqual(error as? InboxEnrolment.Failure, .registrationMismatch)
        }
    }

    /// A `stale_key_rotation` means central's history disagrees with ours, and the
    /// truth is on central's side. Read it rather than guessing — and bind, not
    /// mint, when the active key turns out to be one we hold.
    func testAStaleRotationReconcilesAgainstCentralsHistory() async throws {
        let keys = InMemoryInboxDeviceKeyStore()
        let pair = try InboxKeyMaterial.generateKeyPair()
        let encoded = InboxKeyMaterial.encode(pair.publicKey)
        _ = try await keys.append(pair, account: account, now: epoch)

        let transport = FakeInboxTransport()
        transport.registerKeyResults = [.failure(InboxError.api(status: 409,
                                                                code: "stale_key_rotation"))]
        transport.listKeysResult = .success([key("k9", encoded, generation: 3)])

        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: transport, keys: keys, account: account, current: nil, now: epoch)

        XCTAssertEqual(resolved.id, "k9")
        XCTAssertTrue(transport.calls.contains(.listKeys))
        let history = try await keys.load(account: account)
        XCTAssertEqual(history.count, 1, "reconciliation minted a second key")
        XCTAssertEqual(history.first?.keyID, "k9")
    }

    /// Reconciliation is bounded: one read, then at most one rotation. A central
    /// that reports no active key at all is unrecoverable rather than a loop that
    /// mints keys forever.
    func testNoActiveKeyAfterAConflictIsUnrecoverable() async throws {
        let keys = InMemoryInboxDeviceKeyStore()
        let pair = try InboxKeyMaterial.generateKeyPair()
        _ = try await keys.append(pair, account: account, now: epoch)
        let transport = FakeInboxTransport()
        transport.registerKeyResults = [.failure(InboxError.api(status: 409,
                                                                code: "device_key_reused"))]
        transport.listKeysResult = .success([key("k1", "gone", revoked: 5)])
        do {
            _ = try await InboxEnrolment.ensureUsableKey(transport: transport, keys: keys,
                                                         account: account, current: nil, now: epoch)
            XCTFail("an inbox with no active key was accepted")
        } catch {
            XCTAssertEqual(error as? InboxEnrolment.Failure, .keyUnrecoverable)
        }
    }

    /// A REVOKED current key is not usable. It must not short-circuit as "already
    /// held" — nothing can decrypt against it again, for new or queued tasks.
    func testARevokedCurrentKeyIsNotTreatedAsUsable() async throws {
        let keys = InMemoryInboxDeviceKeyStore()
        let pair = try InboxKeyMaterial.generateKeyPair()
        let encoded = InboxKeyMaterial.encode(pair.publicKey)
        _ = try await keys.append(pair, account: account, now: epoch)
        try await keys.bind(publicKey: encoded, keyID: "k1", generation: 1, account: account)

        let recorder = RegisterEchoTransport(id: "k2", generation: 2)
        let resolved = try await InboxEnrolment.ensureUsableKey(
            transport: recorder, keys: keys, account: account,
            current: key("k1", encoded, revoked: 9), now: epoch)

        XCTAssertEqual(resolved.id, "k2")
        XCTAssertEqual(recorder.previousKeyIDs, [nil],
                       "a revoked key is not an active predecessor to swap against")
    }
}

/// Echoes back whatever public key it was handed, so a rotation's own key
/// material is what gets bound rather than a fixture's.
private final class RegisterEchoTransport: FakeInboxTransport, @unchecked Sendable {
    let id: String
    let generation: Int64
    private(set) var previousKeyIDs: [String?] = []

    init(id: String, generation: Int64) {
        self.id = id
        self.generation = generation
        super.init()
    }

    override func registerKey(algorithm: String, publicKey: String,
                              previousKeyID: String?) async throws -> InboxKey {
        previousKeyIDs.append(previousKeyID)
        return InboxKey(id: id, algorithm: algorithm, publicKey: publicKey, generation: generation)
    }
}

/// Reports whether the private key was already durable at the moment the public
/// half was submitted. That ORDER is the invariant; a test that only checked the
/// end state would pass on either.
private final class RegisterRecorder: FakeInboxTransport, @unchecked Sendable {
    private let keys: InboxDeviceKeyStoring
    private let account: InboxAccountID
    private let report: (Bool) -> Void

    init(keys: InboxDeviceKeyStoring, account: InboxAccountID, report: @escaping (Bool) -> Void) {
        self.keys = keys
        self.account = account
        self.report = report
        super.init()
    }

    override func registerKey(algorithm: String, publicKey: String,
                              previousKeyID: String?) async throws -> InboxKey {
        let held = (try? await keys.record(forPublicKey: publicKey, account: account)) ?? nil
        report(held != nil)
        return InboxKey(id: "k1", algorithm: algorithm, publicKey: publicKey, generation: 1)
    }
}
