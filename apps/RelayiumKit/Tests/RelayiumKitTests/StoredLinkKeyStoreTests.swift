import XCTest
import Security
@testable import RelayiumKit

/// The store that decides whether a stored link can ever be rebuilt on this Mac.
///
/// Everything here is about two failure modes. The first is silence: a key that
/// was not really saved turns into a file nobody can open, and the only moment
/// the user could have copied the link has passed. The second is the keychain
/// account name — it is derived from a server-supplied id, so an id that can
/// steer that name is an id that can address someone else's item.
final class StoredLinkKeyStoreTests: XCTestCase {

    // MARK: - the contract, exercised through the in-memory implementation

    func testRoundTrip() async throws {
        let s = InMemoryStoredLinkKeyStore()
        var loaded = try await s.key(for: "f1")
        XCTAssertNil(loaded)
        try await s.save(id: "f1", keyB64url: "KEY-1_abc")
        loaded = try await s.key(for: "f1")
        XCTAssertEqual(loaded, "KEY-1_abc")
        try await s.remove(id: "f1")
        loaded = try await s.key(for: "f1")
        XCTAssertNil(loaded)
    }

    func testSaveOverwrites() async throws {
        let s = InMemoryStoredLinkKeyStore()
        try await s.save(id: "f1", keyB64url: "one")
        try await s.save(id: "f1", keyB64url: "two")
        let loaded = try await s.key(for: "f1")
        XCTAssertEqual(loaded, "two")
    }

    func testKeysAreKeyedByIdentifier() async throws {
        let s = InMemoryStoredLinkKeyStore()
        try await s.save(id: "f1", keyB64url: "one")
        try await s.save(id: "f2", keyB64url: "two")
        var first = try await s.key(for: "f1")
        var second = try await s.key(for: "f2")
        XCTAssertEqual(first, "one")
        XCTAssertEqual(second, "two")
        try await s.remove(id: "f1")
        first = try await s.key(for: "f1")
        second = try await s.key(for: "f2")
        XCTAssertNil(first)
        XCTAssertEqual(second, "two", "removing one key must not remove another")
    }

    /// Removal follows a server delete, and a delete can race a burn-after-read
    /// or an expiry. "It was already gone" is the expected case, not an error.
    func testRemovingAnAbsentKeyIsNotAnError() async throws {
        let s = InMemoryStoredLinkKeyStore()
        try await s.remove(id: "never-saved")
    }

    // MARK: - validation

    /// The identifier becomes part of a keychain account name. Anything that
    /// could steer that name — a separator, a traversal, whitespace, an empty
    /// string — is refused rather than sanitised into something that still
    /// addresses an item.
    func testUnsafeIdentifiersAreRefused() async {
        let bad = ["", " ", "a b", "a:b", "a/b", "../other", "a\u{0}b", "ключ", "a\nb",
                   String(repeating: "a", count: 129)]
        for id in bad {
            let s = InMemoryStoredLinkKeyStore()
            await XCTAssertThrowsErrorAsync(try await s.save(id: id, keyB64url: "k")) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier, "id \(id.debugDescription)")
            }
            await XCTAssertThrowsErrorAsync(try await s.key(for: id)) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier, "id \(id.debugDescription)")
            }
            await XCTAssertThrowsErrorAsync(try await s.remove(id: id)) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier, "id \(id.debugDescription)")
            }
        }
    }

    func testRealServerIdentifiersAreAccepted() async throws {
        let s = InMemoryStoredLinkKeyStore()
        // `authx.NewID()` is 32 hex characters; the charset is deliberately
        // wider than that so a future id format does not break the app.
        try await s.save(id: "0f9a1b2c3d4e5f60718293a4b5c6d7e8", keyB64url: "k")
        try await s.save(id: "A-Za-z0-9_-", keyB64url: "k")
    }

    /// The key is base64url with no padding — exactly what `#k=` carries and
    /// what `parseDownloadFragment` accepts. Anything else could not have come
    /// from an upload, so storing it would only produce a link that fails later.
    func testUnsafeKeysAreRefused() async {
        let bad = ["", "abc=", "a b", "a/b", "a+b", "ключ", String(repeating: "k", count: 513)]
        for key in bad {
            let s = InMemoryStoredLinkKeyStore()
            await XCTAssertThrowsErrorAsync(try await s.save(id: "f1", keyB64url: key)) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "key \(key.debugDescription)")
            }
        }
    }

    // MARK: - bytes read back out of the keychain

    /// What `save` wrote is not the only thing a read can return. The item is a
    /// generic password in a shared access group, so another build, an older
    /// format, a restored keychain or a corrupt row can put arbitrary bytes
    /// under that account name — and the string that comes back is interpolated
    /// straight into a `#k=` fragment.
    ///
    /// These run against the decoding seam rather than the keychain because a
    /// bare SPM test host has no keychain-access-groups entitlement and cannot
    /// write an item at all, let alone a malformed one.
    func testStoredBytesThatAreNotAUsableKeyAreRejected() {
        // Lone continuation byte: not valid UTF-8 in any encoding sense.
        let invalidUTF8 = Data([0x41, 0xFF, 0x42])
        XCTAssertThrowsError(try StoredLinkKeyValidation.checkedKey(fromStored: invalidUTF8)) {
            XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "invalid UTF-8")
        }
        let bad = ["", "abc=", "a b", "a/b", "a+b", "ключ", "\u{0}",
                   String(repeating: "k", count: 513)]
        for text in bad {
            XCTAssertThrowsError(try StoredLinkKeyValidation.checkedKey(fromStored: Data(text.utf8))) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "stored \(text.debugDescription)")
            }
        }
    }

    /// The rejection is a THROW, never `nil` and never a malformed link. `nil`
    /// would tell the user this Mac does not have the key, closing a question
    /// that is still open, and a malformed link would fail at download time
    /// somewhere the reason is no longer visible.
    func testAnUnusableStoredKeyIsAnErrorRatherThanAMissingKey() {
        do {
            _ = try StoredLinkKeyValidation.checkedKey(fromStored: Data([0xFF]))
            XCTFail("unusable stored bytes were accepted")
        } catch let error as StoredLinkKeyError {
            XCTAssertEqual(error, .invalidKey)
        } catch {
            XCTFail("got \(error)")
        }
    }

    func testAWellFormedStoredKeyRoundTrips() throws {
        let key = "KEY-1_abc"
        XCTAssertEqual(try StoredLinkKeyValidation.checkedKey(fromStored: Data(key.utf8)), key)
    }

    /// The same rules again, but through the lookup path `key(for:)` actually
    /// runs — validating the bytes is worth nothing if the read does not do it.
    /// This is as close to the real call as an unentitled test host can get: it
    /// feeds `decodeLookup` exactly what `SecItemCopyMatching` hands back.
    func testTheKeychainLookupRejectsUnusableBytesRatherThanReturningThem() {
        let store = KeychainStoredLinkKeyStore.self
        XCTAssertThrowsError(try store.decodeLookup(status: errSecSuccess,
                                                    value: Data([0xFF]) as CFTypeRef)) {
            XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "invalid UTF-8 was returned as a key")
        }
        XCTAssertThrowsError(try store.decodeLookup(status: errSecSuccess,
                                                    value: Data() as CFTypeRef)) {
            XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "empty data was returned as a key")
        }
        XCTAssertThrowsError(try store.decodeLookup(status: errSecSuccess,
                                                    value: Data("a+b/c=".utf8) as CFTypeRef)) {
            XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "non-base64url was returned as a key")
        }
        XCTAssertThrowsError(try store.decodeLookup(
            status: errSecSuccess,
            value: Data(String(repeating: "k", count: 513).utf8) as CFTypeRef)) {
            XCTAssertEqual($0 as? StoredLinkKeyError, .invalidKey, "an over-long key was returned")
        }
    }

    /// Absent is `nil`; a keychain that would not answer is an error. Reporting
    /// the second as the first tells the user the key is not on this Mac when it
    /// may be one unlock away.
    func testTheKeychainLookupSeparatesAbsentFromRefused() throws {
        let store = KeychainStoredLinkKeyStore.self
        XCTAssertNil(try store.decodeLookup(status: errSecItemNotFound, value: nil))
        XCTAssertThrowsError(try store.decodeLookup(status: errSecInteractionNotAllowed, value: nil)) {
            XCTAssertEqual($0 as? KeychainError, .status(errSecInteractionNotAllowed))
        }
        // Success with a non-Data payload should not be read as "no key here".
        XCTAssertThrowsError(try store.decodeLookup(status: errSecSuccess, value: "not data" as CFTypeRef))
        XCTAssertEqual(try store.decodeLookup(status: errSecSuccess,
                                              value: Data("KEY123".utf8) as CFTypeRef), "KEY123")
    }

    // MARK: - the keychain implementation's query shape

    private func keychain(accessGroup: String? = nil) -> KeychainStoredLinkKeyStore {
        KeychainStoredLinkKeyStore(service: "com.relayium.test", accessGroup: accessGroup)
    }

    func testKeychainQueryUsesTheDataProtectionKeychain() throws {
        let q = try keychain().query(for: "f1")
        XCTAssertEqual(q[kSecUseDataProtectionKeychain as String] as? Bool, true)
        XCTAssertEqual(q[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(q[kSecAttrService as String] as? String, "com.relayium.test")
    }

    func testKeychainQueryCarriesTheAccessGroupWhenConfigured() throws {
        let q = try keychain(accessGroup: "TEAMID.com.example.shared").query(for: "f1")
        XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String, "TEAMID.com.example.shared")
    }

    func testKeychainQueryOmitsTheAccessGroupWhenNotConfigured() throws {
        XCTAssertNil(try keychain().query(for: "f1")[kSecAttrAccessGroup as String])
    }

    /// The account is namespaced, so a stored-file key can never collide with —
    /// or overwrite — the bearer token, which lives in the same service.
    func testKeychainAccountIsNamespacedAndDistinctPerFile() throws {
        let s = keychain()
        let a = try s.account(for: "f1")
        let b = try s.account(for: "f2")
        XCTAssertTrue(a.hasPrefix(KeychainStoredLinkKeyStore.accountPrefix))
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a, try s.account(for: "f1"), "the same id must address the same item")
    }

    func testKeychainRefusesToBuildAQueryForAnUnsafeIdentifier() {
        XCTAssertThrowsError(try keychain().query(for: "../bearer-token")) {
            XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier)
        }
    }

    /// `SecItemAdd`/`SecItemCopyMatching` block, and the first use can raise a
    /// system prompt. The async signature exists so that work never runs on the
    /// main actor; this asserts the hop actually happens rather than trusting it.
    @MainActor
    func testKeychainWorkRunsOffTheMainThread() async throws {
        XCTAssertTrue(Thread.isMainThread, "precondition: this test starts on the main thread")
        let ranOnMain = try await keychain().runOffMain { Thread.isMainThread }
        XCTAssertFalse(ranOnMain)
    }
}
