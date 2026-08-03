import Foundation
import Security

/// Persistence for the E2E keys of stored uploads made from THIS installation.
///
/// A stored link is `origin/d/<id>#k=<key>`. The server holds the ciphertext and
/// the id; the key exists only in that fragment, which is never sent to it. So
/// "show me my files and let me copy their links again" is only answerable for
/// files whose key this machine kept. Everything else — a file uploaded from
/// another device, or before this store existed — is listed honestly as
/// *ciphertext this account owns whose key is not on this Mac*, because that is
/// what it is. Nothing here ever asks the server for a key, and nothing here
/// ever sends one to it.
///
/// It lives next to `TokenStore` rather than under `Cloud/` because it is the
/// same machinery answering the same question: what may this installation keep
/// in the data-protection keychain, and under what name.
public protocol StoredLinkKeyStore {
    func save(id: String, keyB64url: String) async throws
    func key(for id: String) async throws -> String?
    func remove(id: String) async throws
}

public enum StoredLinkKeyError: Error, Equatable {
    /// The stored-object id is empty, over-long, or contains something that
    /// could steer the keychain account name it is composed into.
    case invalidIdentifier
    /// The key is not the unpadded base64url a `#k=` fragment carries.
    case invalidKey
}

/// Validation shared by every implementation, so a test written against the
/// in-memory store proves the contract the keychain one also enforces.
///
/// The identifier is the load-bearing one: it arrives from the server and gets
/// concatenated into `kSecAttrAccount` here and into a URL path in
/// `AccountClient.authedDelete`. Both need it to stay ONE inert token. Refusing
/// separators, traversal, whitespace and non-ASCII means a hostile or merely
/// surprising id can neither name a *different* keychain item — including the
/// bearer token, which shares the service — nor steer a DELETE at a different
/// endpoint. Sanitising instead of refusing would map two distinct ids onto one
/// account, which silently loses a key.
///
/// Every id either caller can be handed is `authx.NewID()`: 32 hex characters.
enum StoredLinkKeyValidation {
    /// Wide enough for any plausible future id format, narrow enough that every
    /// member is inert in a keychain attribute. `authx.NewID()` is 32 hex chars.
    static let idCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    static let maxIDLength = 128
    /// Unpadded base64url — the exact alphabet `parseDownloadFragment` accepts,
    /// so a key that would not survive a round trip through a link is refused at
    /// the point it is stored rather than at the point someone tries to use it.
    static let keyCharacters = idCharacters
    static let maxKeyLength = 512

    static func checkedID(_ id: String) throws -> String {
        guard !id.isEmpty, id.count <= maxIDLength,
              id.allSatisfy({ idCharacters.contains($0) }) else {
            throw StoredLinkKeyError.invalidIdentifier
        }
        return id
    }

    static func checkedKey(_ key: String) throws -> String {
        guard !key.isEmpty, key.count <= maxKeyLength,
              key.allSatisfy({ keyCharacters.contains($0) }) else {
            throw StoredLinkKeyError.invalidKey
        }
        return key
    }

    /// The one place stored bytes become a key again.
    ///
    /// Validating on the way OUT as well as on the way in is not belt and
    /// braces: what `save` wrote is not the only thing a read can return. The
    /// item is a generic password in a shared access group, so another build,
    /// an older format, a restored keychain or a corrupted row can put arbitrary
    /// bytes under this account name — and the string that comes back is
    /// interpolated straight into a `#k=` fragment. Bytes that are not valid
    /// UTF-8, or a string outside the base64url alphabet a link can carry, are
    /// `invalidKey` — a stated failure the Account tab renders as "couldn't read
    /// the key" — rather than `nil`, which would claim the key is not on this
    /// Mac, or a malformed link that fails at download time with no explanation.
    ///
    /// A separate function so it is exercised deterministically: the keychain
    /// itself cannot be written to under `swift test` (no entitlement), and the
    /// interesting inputs are ones a working keychain would never produce.
    static func checkedKey(fromStored data: Data) throws -> String {
        guard let text = String(data: data, encoding: .utf8) else {
            throw StoredLinkKeyError.invalidKey
        }
        return try checkedKey(text)
    }
}

/// Test and preview double. Validates exactly as the keychain implementation
/// does — a store that accepted more than the real one would let tests pass on
/// input the app refuses.
public final class InMemoryStoredLinkKeyStore: StoredLinkKeyStore {
    private var keys: [String: String] = [:]
    public init() {}

    public func save(id: String, keyB64url: String) async throws {
        let id = try StoredLinkKeyValidation.checkedID(id)
        keys[id] = try StoredLinkKeyValidation.checkedKey(keyB64url)
    }

    public func key(for id: String) async throws -> String? {
        keys[try StoredLinkKeyValidation.checkedID(id)]
    }

    public func remove(id: String) async throws {
        keys.removeValue(forKey: try StoredLinkKeyValidation.checkedID(id))
    }
}

/// The real store: one generic-password item per stored object in the
/// data-protection keychain, shared with the rest of the app through the access
/// group, exactly like `KeychainTokenStore`.
public final class KeychainStoredLinkKeyStore: StoredLinkKeyStore {
    /// Namespaces the account so a stored-object key can never collide with the
    /// bearer token, which lives under the same service. Combined with the id
    /// charset (no `:`), no id can compose an account name outside this space.
    public static let accountPrefix = "stored-link-key:"

    private let service: String
    private let accessGroup: String?
    /// Serial: the Security calls are thread-safe, but a save is a delete
    /// followed by an add, and two overlapping saves for the same id could
    /// otherwise interleave into a lost item.
    private let queue = DispatchQueue(label: "com.relayium.stored-link-keys")

    /// `accessGroup` is nil-able for the same reason as `KeychainTokenStore`'s:
    /// the SPM test host has no entitlement to name one. The app always passes
    /// `AppEnvironment.keychainAccessGroup`.
    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// Internal rather than private so the composed name can be asserted by
    /// tests that cannot exercise the real keychain.
    func account(for id: String) throws -> String {
        Self.accountPrefix + (try StoredLinkKeyValidation.checkedID(id))
    }

    /// `kSecUseDataProtectionKeychain` is load-bearing, as in `KeychainTokenStore`:
    /// without it the legacy file-based keychain treats `kSecAttrAccessible` as
    /// advisory and the protection asked for in `save` is not enforced.
    func query(for id: String) throws -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: try account(for: id),
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        return q
    }

    /// Every Security call goes through here. They block, and the first use can
    /// raise a system authorization prompt, so none of them may run on the main
    /// actor — the `async` signatures on the protocol exist for this.
    ///
    /// Internal so a test can assert the hop actually happens.
    func runOffMain<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try body() })
            }
        }
    }

    public func save(id: String, keyB64url: String) async throws {
        let base = try query(for: id)
        let data = Data(try StoredLinkKeyValidation.checkedKey(keyB64url).utf8)
        try await runOffMain {
            SecItemDelete(base as CFDictionary)          // idempotent overwrite
            var add = base
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(add as CFDictionary, nil)
            guard status == errSecSuccess else { throw KeychainError.status(status) }
        }
    }

    /// Everything `key(for:)` decides once `SecItemCopyMatching` has answered.
    ///
    /// Split out because it is the whole behaviour and none of it is reachable
    /// under `swift test`: a bare SPM host has no keychain-access-groups
    /// entitlement, so no item can be written and no lookup can be provoked. The
    /// two lines left behind — build the query, make the call — hold no
    /// decisions; this holds all of them, and is tested directly.
    ///
    /// `nil` means exactly one thing: no item is stored for this id. Anything
    /// else that goes wrong throws — a keychain that refused to answer is
    /// `KeychainError`, and bytes that are not a usable key are `invalidKey`.
    /// Collapsing either into `nil` would tell the user their key is not on this
    /// Mac when it may be one unlock, or one diagnosis, away.
    static func decodeLookup(status: OSStatus, value: CFTypeRef?) throws -> String? {
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else {
            throw KeychainError.status(status)
        }
        return try StoredLinkKeyValidation.checkedKey(fromStored: data)
    }

    public func key(for id: String) async throws -> String? {
        var q = try query(for: id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        let readOnly = q
        return try await runOffMain {
            var out: CFTypeRef?
            let status = SecItemCopyMatching(readOnly as CFDictionary, &out)
            return try Self.decodeLookup(status: status, value: out)
        }
    }

    public func remove(id: String) async throws {
        let base = try query(for: id)
        try await runOffMain {
            let status = SecItemDelete(base as CFDictionary)
            // Already absent is the expected case when a delete follows a burn
            // or an expiry, not a failure.
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw KeychainError.status(status)
            }
        }
    }
}
