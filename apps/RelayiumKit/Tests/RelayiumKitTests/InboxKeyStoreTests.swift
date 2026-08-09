import XCTest
import Security
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The private-key history: what it retains, what it refuses, and — the property
/// this whole file exists for — that one account can neither read nor destroy
/// another's keys.
///
/// The keychain itself is unreachable under `swift test`: a bare SPM host has no
/// `keychain-access-groups` entitlement, so no item can be written and no lookup
/// provoked. The behaviour is therefore split — the rules are exercised through
/// the in-memory store, which validates identically, and the keychain type's own
/// DECISIONS (the composed account name, the query attributes, the lookup
/// mapping) are asserted directly.
final class InboxKeyStoreTests: XCTestCase {

    private let alice = try! InboxAccountID("accountalice0001")
    private let bob = try! InboxAccountID("accountbob00000002")
    private let epoch = Date(timeIntervalSince1970: 1_000_000)

    private func pair() throws -> InboxDeviceKeyPair { try InboxKeyMaterial.generateKeyPair() }

    // MARK: - account identity

    /// The account id is concatenated into a `kSecAttrAccount`. A raw string could
    /// name a DIFFERENT item — including the bearer token, which shares the
    /// service — so the check happens once, at construction, and everything
    /// downstream takes the checked type.
    func testAnAccountIDThatCouldSteerAKeychainNameIsRefused() {
        for bad in ["", "has space", "colon:inside", "../escape", String(repeating: "a", count: 200)] {
            XCTAssertThrowsError(try InboxAccountID(bad), bad) {
                XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
            }
        }
        XCTAssertNoThrow(try InboxAccountID("0123456789abcdef0123456789abcdef"))
    }

    // MARK: - history rules

    func testAppendRetainsEveryGenerationAndReturnsThemOldestFirst() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let first = try pair()
        let second = try pair()
        _ = try await store.append(first, account: alice, now: epoch)
        _ = try await store.append(second, account: alice, now: epoch.addingTimeInterval(60))

        let history = try await store.load(account: alice)
        XCTAssertEqual(history.map(\.publicKey), [InboxKeyMaterial.encode(first.publicKey),
                                                  InboxKeyMaterial.encode(second.publicKey)])
        let latest = try await store.latest(account: alice)
        XCTAssertEqual(latest?.publicKey, InboxKeyMaterial.encode(second.publicKey))
    }

    /// A rotation MUST NOT drop the superseded private key: central binds a task
    /// to the key it was sealed to, so dropping the old one strands every task
    /// queued before the rotation.
    func testASupersededKeyStillResolvesAfterARotation() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let old = try pair()
        let new = try pair()
        _ = try await store.append(old, account: alice, now: epoch)
        try await store.bind(publicKey: InboxKeyMaterial.encode(old.publicKey),
                             keyID: "k1", generation: 1, account: alice)
        _ = try await store.append(new, account: alice, now: epoch)
        try await store.bind(publicKey: InboxKeyMaterial.encode(new.publicKey),
                             keyID: "k2", generation: 2, account: alice)

        let resolved = try await store.keyPair(forKeyID: "k1", account: alice)
        XCTAssertEqual(resolved?.privateKey, old.privateKey)
    }

    /// A record with no server id yet is the window between "durable locally" and
    /// "central answered". It must not be resolvable by key id, or a task naming
    /// an empty id would match it.
    func testAnUnpublishedRecordIsNotResolvableByKeyID() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let key = try pair()
        let record = try await store.append(key, account: alice, now: epoch)
        XCTAssertFalse(record.isPublished)
        let byEmptyID = try await store.keyPair(forKeyID: "", account: alice)
        XCTAssertNil(byEmptyID)
    }

    func testReAppendingAKeyAlreadyInTheHistoryIsRefused() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let key = try pair()
        _ = try await store.append(key, account: alice, now: epoch)
        do {
            _ = try await store.append(key, account: alice, now: epoch)
            XCTFail("a key already in the history was appended again")
        } catch {
            XCTAssertEqual(error as? InboxKeyStoreError, .keyAlreadyPresent)
        }
    }

    /// Two records claiming one server key id would make "which private key opens
    /// this task" ambiguous, and could hand the wrong key to an unseal.
    func testOneServerKeyIDCannotBeBoundToTwoLocalKeys() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let first = try pair()
        let second = try pair()
        _ = try await store.append(first, account: alice, now: epoch)
        _ = try await store.append(second, account: alice, now: epoch)
        try await store.bind(publicKey: InboxKeyMaterial.encode(first.publicKey),
                             keyID: "k1", generation: 1, account: alice)
        do {
            try await store.bind(publicKey: InboxKeyMaterial.encode(second.publicKey),
                                 keyID: "k1", generation: 2, account: alice)
            XCTFail("one key id was bound twice")
        } catch {
            XCTAssertEqual(error as? InboxKeyStoreError, .keyIDAlreadyBound)
        }
    }

    /// Idempotent: a retried registration that converges on the same key (central
    /// returns the existing row unchanged) must not fork the history.
    func testRebindingTheSameKeyToTheSameIDIsANoOp() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let key = try pair()
        _ = try await store.append(key, account: alice, now: epoch)
        let publicKey = InboxKeyMaterial.encode(key.publicKey)
        try await store.bind(publicKey: publicKey, keyID: "k1", generation: 1, account: alice)
        try await store.bind(publicKey: publicKey, keyID: "k1", generation: 1, account: alice)
        let history = try await store.load(account: alice)
        XCTAssertEqual(history.count, 1)
    }

    func testBindingAKeyThisAccountDoesNotHoldIsRefused() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        do {
            try await store.bind(publicKey: "not-ours", keyID: "k1", generation: 1, account: alice)
            XCTFail("a key nobody holds was bound")
        } catch {
            XCTAssertEqual(error as? InboxKeyStoreError, .noSuchLocalKey)
        }
    }

    // MARK: - account isolation

    /// The property the whole type is shaped around: a sign-out, an account
    /// switch, or a late task cannot read one account's keys under another's
    /// session.
    func testOneAccountsKeysAreInvisibleToAnother() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let key = try pair()
        _ = try await store.append(key, account: alice, now: epoch)
        try await store.bind(publicKey: InboxKeyMaterial.encode(key.publicKey),
                             keyID: "k1", generation: 1, account: alice)

        let bobHistory = try await store.load(account: bob)
        let bobByID = try await store.keyPair(forKeyID: "k1", account: bob)
        let bobLatest = try await store.latest(account: bob)
        let bobByPublic = try await store.record(
            forPublicKey: InboxKeyMaterial.encode(key.publicKey), account: bob)
        XCTAssertTrue(bobHistory.isEmpty)
        XCTAssertNil(bobByID)
        XCTAssertNil(bobLatest)
        XCTAssertNil(bobByPublic)
    }

    /// Destroy is the only path that removes keys, and it is scoped. Its only
    /// caller is an explicit disable, which may run while ANOTHER account's
    /// delivery is in flight.
    func testDestroyingOneAccountLeavesTheOtherIntact() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let aliceKey = try pair()
        let bobKey = try pair()
        _ = try await store.append(aliceKey, account: alice, now: epoch)
        _ = try await store.append(bobKey, account: bob, now: epoch)

        try await store.destroy(account: alice)

        let aliceHistory = try await store.load(account: alice)
        let bobHistory = try await store.load(account: bob)
        XCTAssertTrue(aliceHistory.isEmpty)
        XCTAssertEqual(bobHistory.map(\.publicKey), [InboxKeyMaterial.encode(bobKey.publicKey)])
    }

    /// The same public key can legitimately exist under two accounts — nothing
    /// stops a user signing two accounts into one Mac — and neither append may see
    /// the other's history when it checks for reuse.
    func testTheSameKeyMayBeAppendedUnderTwoAccounts() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let key = try pair()
        _ = try await store.append(key, account: alice, now: epoch)
        let underBob = try await store.append(key, account: bob, now: epoch)
        XCTAssertEqual(underBob.publicKey, InboxKeyMaterial.encode(key.publicKey))
    }

    /// Late async work carries its own account. A task started under Alice and
    /// finishing after a switch to Bob resolves ALICE's key, because the account
    /// travelled with the work rather than being read from whatever is current.
    func testLateWorkResolvesTheAccountItStartedUnder() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        let aliceKey = try pair()
        _ = try await store.append(aliceKey, account: alice, now: epoch)
        try await store.bind(publicKey: InboxKeyMaterial.encode(aliceKey.publicKey),
                             keyID: "k1", generation: 1, account: alice)

        let carried = alice                       // captured when the work started
        _ = try await store.append(try pair(), account: bob, now: epoch)   // the switch

        let resolved = try await store.keyPair(forKeyID: "k1", account: carried)
        XCTAssertEqual(resolved?.privateKey, aliceKey.privateKey)
    }

    // MARK: - the retained bound

    func testTheHistoryIsBoundedToTheNewestGenerations() async throws {
        let store = InMemoryInboxDeviceKeyStore()
        var oldest: String?
        for i in 0..<(InboxKeyHistory.maxRecords + 3) {
            let key = try pair()
            if i == 0 { oldest = InboxKeyMaterial.encode(key.publicKey) }
            _ = try await store.append(key, account: alice, now: epoch)
        }
        let history = try await store.load(account: alice)
        XCTAssertEqual(history.count, InboxKeyHistory.maxRecords)
        XCTAssertFalse(history.contains { $0.publicKey == oldest })
    }

    // MARK: - the on-disk format

    func testAHistoryFromAnotherVersionIsRefusedRatherThanParsed() throws {
        let json = #"{"version":99,"keys":[]}"#
        XCTAssertThrowsError(try InboxKeyHistory.decode(Data(json.utf8))) {
            XCTAssertEqual($0 as? InboxKeyStoreError, .unreadableHistory)
        }
        XCTAssertThrowsError(try InboxKeyHistory.decode(Data("not json".utf8)))
    }

    func testARecordRoundTripsThroughItsEncodedForm() throws {
        let key = try pair()
        let record = InboxKeyRecord(keyID: "k1", generation: 1,
                                    publicKey: InboxKeyMaterial.encode(key.publicKey),
                                    privateKey: InboxKeyMaterial.encode(key.privateKey),
                                    createdAt: 1)
        let decoded = try InboxKeyHistory.decode(try InboxKeyHistory.encode([record]))
        XCTAssertEqual(decoded, [record])
        XCTAssertEqual(try decoded[0].keyPair().privateKey, key.privateKey)
    }

    // MARK: - the keychain type's own decisions

    /// The account name is namespaced so a key history can never collide with the
    /// bearer token or a stored-link key, all of which share this service.
    func testTheKeychainAccountNameIsNamespacedPerAccount() {
        let store = KeychainInboxDeviceKeyStore(service: "com.relayium.mac", accessGroup: nil)
        XCTAssertEqual(store.keychainAccountName(for: alice),
                       "device-inbox-keys:" + alice.value)
        XCTAssertNotEqual(store.keychainAccountName(for: alice),
                          store.keychainAccountName(for: bob))
        XCTAssertFalse(store.keychainAccountName(for: alice)
            .hasPrefix(KeychainStoredLinkKeyStore.accountPrefix))
    }

    /// `kSecUseDataProtectionKeychain` is load-bearing: without it the legacy
    /// file-based keychain treats `kSecAttrAccessible` as ADVISORY, and the
    /// protection the private key is stored under is not enforced at all.
    func testTheQueryUsesTheDataProtectionKeychainAndTheGivenGroup() {
        let store = KeychainInboxDeviceKeyStore(service: "com.relayium.mac",
                                                accessGroup: "TEAM.com.relayium.shared")
        let query = store.query(for: alice)
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "com.relayium.mac")
        XCTAssertEqual(query[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, "TEAM.com.relayium.shared")
    }

    /// A host with no `keychain-access-groups` entitlement must not NAME a group:
    /// doing so fails with `errSecMissingEntitlement` on a signed build and claims
    /// a cross-app share that does not exist.
    func testNoAccessGroupIsNamedWhenNoneWasGiven() {
        let store = KeychainInboxDeviceKeyStore(service: "com.relayium.mac", accessGroup: nil)
        XCTAssertNil(store.query(for: alice)[kSecAttrAccessGroup as String])
    }

    /// An absent item is an EMPTY history, not an error — that is a device that
    /// has never enrolled. A refusal to answer, and bytes that are not a readable
    /// history, are errors: collapsing either into "no keys" would make the
    /// enrolment path mint a SECOND key and abandon the first.
    func testTheLookupDistinguishesAbsentFromUnreadableFromRefused() throws {
        XCTAssertEqual(try KeychainInboxDeviceKeyStore.decodeLookup(status: errSecItemNotFound,
                                                                    value: nil), [])
        XCTAssertThrowsError(try KeychainInboxDeviceKeyStore.decodeLookup(
            status: errSecInteractionNotAllowed, value: nil)) {
            XCTAssertEqual($0 as? InboxKeyStoreError, .keychain(errSecInteractionNotAllowed))
        }
        XCTAssertThrowsError(try KeychainInboxDeviceKeyStore.decodeLookup(
            status: errSecSuccess, value: Data("garbage".utf8) as CFTypeRef)) {
            XCTAssertEqual($0 as? InboxKeyStoreError, .unreadableHistory)
        }
        let good = try InboxKeyHistory.encode([])
        XCTAssertEqual(try KeychainInboxDeviceKeyStore.decodeLookup(status: errSecSuccess,
                                                                    value: good as CFTypeRef), [])
    }
}
