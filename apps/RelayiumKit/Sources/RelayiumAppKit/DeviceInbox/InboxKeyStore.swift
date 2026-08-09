import Foundation
import Security
@preconcurrency import RelayiumKit

/// The device's X25519 private-key history, bound to ONE account.
///
/// WHY A HISTORY AND NOT A KEY. Central binds a task to the key it was sealed to
/// at creation (protocol doc §11.4), so a rotation does not invalidate work
/// already queued: the superseded key is still the only thing that can open those
/// tasks. Keeping only "the current key" would silently strand every task queued
/// before the last rotation. Records are retained by CENTRAL's key id, so a claim
/// naming `TargetKeyID` resolves to the right private key with no guessing.
///
/// WHY THE RECORD IS WRITTEN BEFORE THE KEY IS PUBLISHED. `append` returns only
/// once the private key is durable. If registration then fails, or its response
/// is lost, the worst case is an unpublished local key — recoverable. The reverse
/// order's worst case is a published public key whose private half never reached
/// storage, which makes every task sealed to it permanently undecryptable, by
/// anybody, forever.
///
/// WHY IT IS ACCOUNT-BOUND, at the level of the TYPE rather than of a convention.
/// Two accounts can be signed in to on one Mac in sequence, and an async
/// operation started under one can land under the next. Every operation here
/// names its account, so a sign-out, an account switch, or a late task cannot
/// read one account's keys under another's session — and a `destroy` for one
/// account cannot reach the other's history at all.

/// A checked account identifier.
///
/// A separate type, not a `String`, because this value is concatenated into a
/// `kSecAttrAccount`. A raw string could name a DIFFERENT keychain item —
/// including the bearer token, which shares the service — so the check happens
/// once, at construction, and everything downstream takes the checked type.
public struct InboxAccountID: Equatable, Hashable, Sendable {
    public let value: String

    public init(_ raw: String) throws {
        guard let checked = try? StoredObjectID.checked(raw) else {
            throw InboxError.invalidIdentifier
        }
        value = checked
    }
}

/// One generation of device key material.
///
/// `privateKey` is a local secret. It is written only into the data-protection
/// keychain, and it is never logged, printed, or sent anywhere — there is no
/// request shape in `InboxClient` that could carry it.
public struct InboxKeyRecord: Codable, Equatable, Sendable {
    /// Central's id for this key. EMPTY between `append` and the registration
    /// response — the window `bind` reconciles.
    public var keyID: String
    public var generation: Int64
    public var algorithm: String
    public var publicKey: String
    public var privateKey: String
    public var createdAt: Int64

    public init(keyID: String = "", generation: Int64 = 0,
                algorithm: String = InboxProtocol.keyAlgorithm,
                publicKey: String, privateKey: String, createdAt: Int64) {
        self.keyID = keyID
        self.generation = generation
        self.algorithm = algorithm
        self.publicKey = publicKey
        self.privateKey = privateKey
        self.createdAt = createdAt
    }

    /// Whether central has acknowledged this key.
    public var isPublished: Bool { !keyID.isEmpty }

    func keyPair() throws -> InboxDeviceKeyPair {
        InboxDeviceKeyPair(
            publicKey: try InboxKeyMaterial.decode(publicKey, expecting: InboxProtocol.publicKeyBytes),
            privateKey: try InboxKeyMaterial.decode(privateKey, expecting: 32))
    }
}

public enum InboxKeyStoreError: Error, Equatable, Sendable {
    /// The stored history is a version this build does not understand. Refused
    /// rather than parsed optimistically: guessing at a future format could mean
    /// writing a file a newer build treats as authoritative while it is missing
    /// keys.
    case unreadableHistory
    /// A public key already present in this account's history was appended
    /// again. Re-registering an existing key is a downgrade, not a rotation, and
    /// central refuses it too (`device_key_reused`).
    case keyAlreadyPresent
    /// A server key id would end up bound to two different local keys, which
    /// would make "which private key opens this task" ambiguous.
    case keyIDAlreadyBound
    /// `bind` named a public key this account does not hold.
    case noSuchLocalKey
    /// The keychain refused the operation.
    case keychain(OSStatus)
}

/// The operations the enrolment and receive paths need from a key history.
public protocol InboxDeviceKeyStoring: Sendable {
    /// Oldest first.
    func load(account: InboxAccountID) async throws -> [InboxKeyRecord]
    /// Durably record a newly generated key BEFORE it is published.
    @discardableResult
    func append(_ keyPair: InboxDeviceKeyPair, account: InboxAccountID,
                now: Date) async throws -> InboxKeyRecord
    /// Record the id and generation central assigned to an already-durable key.
    func bind(publicKey: String, keyID: String, generation: Int64,
              account: InboxAccountID) async throws
    /// Resolve the private key a task names, or nil when this account does not
    /// hold it.
    func keyPair(forKeyID keyID: String, account: InboxAccountID) async throws -> InboxDeviceKeyPair?
    func record(forPublicKey publicKey: String, account: InboxAccountID) async throws -> InboxKeyRecord?
    func latest(account: InboxAccountID) async throws -> InboxKeyRecord?
    /// Destroy ONE account's history.
    func destroy(account: InboxAccountID) async throws
}

/// Shared history rules, so a test written against the in-memory store proves
/// the contract the keychain store also enforces.
enum InboxKeyHistory {
    static let version = 1

    /// Bounds the retained history. Rotations are rare — a fresh key is minted
    /// only on enable, or when central's current key is not locally usable — and
    /// a task cannot outlive the ciphertext it references, which is bounded by
    /// the account's plan retention in days. Sixty-four generations is therefore
    /// far beyond any decryptable window while keeping the item bounded. Matches
    /// the CLI receiver's own bound so the two implementations cannot disagree
    /// about when a key stops being retained.
    static let maxRecords = 64

    struct File: Codable {
        var version: Int
        var keys: [InboxKeyRecord]   // newest last
    }

    static func decode(_ data: Data) throws -> [InboxKeyRecord] {
        guard let file = try? JSONDecoder().decode(File.self, from: data),
              file.version == version else {
            throw InboxKeyStoreError.unreadableHistory
        }
        return file.keys
    }

    static func encode(_ keys: [InboxKeyRecord]) throws -> Data {
        var trimmed = keys
        if trimmed.count > maxRecords { trimmed = Array(trimmed.suffix(maxRecords)) }
        guard let data = try? JSONEncoder().encode(File(version: version, keys: trimmed)) else {
            throw InboxKeyStoreError.unreadableHistory
        }
        return data
    }

    /// The append rule: a key already in this history is refused.
    static func appending(_ keyPair: InboxDeviceKeyPair, to keys: [InboxKeyRecord],
                          now: Date) throws -> (records: [InboxKeyRecord], added: InboxKeyRecord) {
        let publicKey = InboxKeyMaterial.encode(keyPair.publicKey)
        guard !keys.contains(where: { $0.publicKey == publicKey }) else {
            throw InboxKeyStoreError.keyAlreadyPresent
        }
        let record = InboxKeyRecord(publicKey: publicKey,
                                    privateKey: InboxKeyMaterial.encode(keyPair.privateKey),
                                    createdAt: Int64(now.timeIntervalSince1970))
        return (keys + [record], record)
    }

    /// The bind rule. Idempotent, so a retried registration that converges on the
    /// same key (central returns the existing row unchanged) does not fork the
    /// history — but two records claiming ONE server key id is refused, because
    /// that would make `keyPair(forKeyID:)` ambiguous and could hand the wrong
    /// private key to an unseal.
    static func binding(publicKey: String, keyID: String, generation: Int64,
                        in keys: [InboxKeyRecord]) throws -> [InboxKeyRecord] {
        var out = keys
        var found = false
        for i in out.indices {
            if out[i].publicKey == publicKey {
                out[i].keyID = keyID
                out[i].generation = generation
                found = true
                continue
            }
            if out[i].keyID == keyID { throw InboxKeyStoreError.keyIDAlreadyBound }
        }
        guard found else { throw InboxKeyStoreError.noSuchLocalKey }
        return out
    }
}

/// Test and preview double. Validates exactly as the keychain implementation
/// does — a store that accepted more than the real one would let tests pass on
/// input the app refuses — and isolates accounts the same way.
public final class InMemoryInboxDeviceKeyStore: InboxDeviceKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var histories: [String: [InboxKeyRecord]] = [:]

    public init() {}

    public func load(account: InboxAccountID) async throws -> [InboxKeyRecord] {
        sync { histories[account.value] ?? [] }
    }

    @discardableResult
    public func append(_ keyPair: InboxDeviceKeyPair, account: InboxAccountID,
                       now: Date) async throws -> InboxKeyRecord {
        try sync {
            let result = try InboxKeyHistory.appending(keyPair, to: histories[account.value] ?? [],
                                                       now: now)
            histories[account.value] = trimmed(result.records)
            return result.added
        }
    }

    public func bind(publicKey: String, keyID: String, generation: Int64,
                     account: InboxAccountID) async throws {
        try sync {
            histories[account.value] = try InboxKeyHistory.binding(
                publicKey: publicKey, keyID: keyID, generation: generation,
                in: histories[account.value] ?? [])
        }
    }

    public func keyPair(forKeyID keyID: String, account: InboxAccountID) async throws -> InboxDeviceKeyPair? {
        try sync {
            guard let record = (histories[account.value] ?? [])
                .first(where: { !$0.keyID.isEmpty && $0.keyID == keyID }) else { return nil }
            return try record.keyPair()
        }
    }

    public func record(forPublicKey publicKey: String, account: InboxAccountID) async throws -> InboxKeyRecord? {
        sync { (histories[account.value] ?? []).first { $0.publicKey == publicKey } }
    }

    public func latest(account: InboxAccountID) async throws -> InboxKeyRecord? {
        sync { (histories[account.value] ?? []).last }
    }

    public func destroy(account: InboxAccountID) async throws {
        sync { histories.removeValue(forKey: account.value) }
    }

    /// Non-`async` on purpose: taking an `NSLock` directly inside an `async`
    /// function is an error under the Swift 6 language mode, and a suspension
    /// while holding it would be a real hazard rather than a diagnostic.
    @discardableResult
    private func sync<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    private func trimmed(_ keys: [InboxKeyRecord]) -> [InboxKeyRecord] {
        keys.count > InboxKeyHistory.maxRecords
            ? Array(keys.suffix(InboxKeyHistory.maxRecords)) : keys
    }
}

/// The real store: ONE generic-password item per account in the data-protection
/// keychain, holding that account's whole key history.
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is the required
/// accessibility and it is two separate claims. *After first unlock* is what lets
/// a login-item receiver work before anybody opens the app — the device key must
/// be readable while the Mac is running but locked. *This device only* is what
/// keeps the private key out of an iCloud Keychain sync and out of an encrypted
/// backup restored onto another machine: a device identity that could be restored
/// elsewhere would let two machines claim to be one device.
///
/// `kSecUseDataProtectionKeychain` is load-bearing, exactly as in
/// `KeychainTokenStore`: without it the legacy file-based keychain treats
/// `kSecAttrAccessible` as ADVISORY, and the protection asked for above is not
/// enforced at all.
public final class KeychainInboxDeviceKeyStore: InboxDeviceKeyStoring, @unchecked Sendable {
    /// Namespaces the account so a key history can never collide with the bearer
    /// token or a stored-link key, all of which share this service. Combined with
    /// the id charset (no `:`), no account id can compose a name outside this
    /// space.
    public static let accountPrefix = "device-inbox-keys:"

    private let service: String
    private let accessGroup: String?
    /// Serial, and it wraps the WHOLE read-modify-write rather than each Security
    /// call. Two concurrent appends that interleaved a load with a save would
    /// lose one key — and a lost private key is a permanently undecryptable task,
    /// not a retryable failure.
    private let queue = DispatchQueue(label: "com.relayium.device-inbox-keys")

    public init(service: String, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    /// Internal rather than private so the composed name can be asserted by tests
    /// that have no entitlement to exercise the real keychain.
    func keychainAccountName(for account: InboxAccountID) -> String {
        Self.accountPrefix + account.value
    }

    func query(for account: InboxAccountID) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keychainAccountName(for: account),
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func load(account: InboxAccountID) async throws -> [InboxKeyRecord] {
        let base = query(for: account)
        return try await runOffMain { try Self.read(base) }
    }

    @discardableResult
    public func append(_ keyPair: InboxDeviceKeyPair, account: InboxAccountID,
                       now: Date) async throws -> InboxKeyRecord {
        let base = query(for: account)
        return try await runOffMain {
            let existing = try Self.read(base)
            let result = try InboxKeyHistory.appending(keyPair, to: existing, now: now)
            try Self.write(base, records: result.records)
            return result.added
        }
    }

    public func bind(publicKey: String, keyID: String, generation: Int64,
                     account: InboxAccountID) async throws {
        let base = query(for: account)
        try await runOffMain {
            let existing = try Self.read(base)
            let updated = try InboxKeyHistory.binding(publicKey: publicKey, keyID: keyID,
                                                      generation: generation, in: existing)
            try Self.write(base, records: updated)
        }
    }

    public func keyPair(forKeyID keyID: String, account: InboxAccountID) async throws -> InboxDeviceKeyPair? {
        guard let record = try await load(account: account)
            .first(where: { !$0.keyID.isEmpty && $0.keyID == keyID }) else { return nil }
        return try record.keyPair()
    }

    public func record(forPublicKey publicKey: String, account: InboxAccountID) async throws -> InboxKeyRecord? {
        try await load(account: account).first { $0.publicKey == publicKey }
    }

    public func latest(account: InboxAccountID) async throws -> InboxKeyRecord? {
        try await load(account: account).last
    }

    /// Destroy ONE account's history.
    ///
    /// The query names exactly one item, so this cannot reach another account's
    /// keys — which matters because the only caller is an explicit disable, and
    /// disable may run while another account's delivery is in flight.
    ///
    /// Only ever called AFTER central has confirmed the enrolment (and with it
    /// the published keys and every unfinished task) is cleared. The other order
    /// destroys the only thing that can decrypt tasks still queued server-side,
    /// turning a reversible "turn it off" into permanent data loss for files
    /// already in flight.
    public func destroy(account: InboxAccountID) async throws {
        let base = query(for: account)
        try await runOffMain {
            let status = SecItemDelete(base as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw InboxKeyStoreError.keychain(status)
            }
        }
    }

    // MARK: - the keychain half, split out so its decisions are testable

    /// Everything `load` decides once `SecItemCopyMatching` has answered.
    ///
    /// Split out because none of it is reachable under `swift test`: a bare SPM
    /// host has no keychain-access-groups entitlement, so no item can be written
    /// and no lookup provoked.
    ///
    /// An absent item is an EMPTY history, not an error: that is a device that
    /// has never enrolled. Anything else that goes wrong throws — a keychain that
    /// refused to answer is `keychain(status)`, and bytes that are not a readable
    /// history are `unreadableHistory`. Collapsing either into "no keys" would
    /// make the enrolment path mint a SECOND key and abandon the first, which is
    /// exactly the failure `reconcile` exists to avoid.
    static func decodeLookup(status: OSStatus, value: CFTypeRef?) throws -> [InboxKeyRecord] {
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = value as? Data else {
            throw InboxKeyStoreError.keychain(status)
        }
        return try InboxKeyHistory.decode(data)
    }

    private static func read(_ base: [String: Any]) throws -> [InboxKeyRecord] {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        return try decodeLookup(status: status, value: out)
    }

    private static func write(_ base: [String: Any], records: [InboxKeyRecord]) throws {
        let data = try InboxKeyHistory.encode(records)
        SecItemDelete(base as CFDictionary)          // idempotent overwrite
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw InboxKeyStoreError.keychain(status) }
    }

    /// Every Security call goes through here. They block, and the first use can
    /// raise a system authorization prompt, so none of them may run on the main
    /// actor — the `async` signatures on the protocol exist for this.
    func runOffMain<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try body() }) }
        }
    }
}
