import Foundation
import Security

public protocol TokenStore {
    func save(_ token: String) throws
    func load() throws -> String?
    func clear() throws
}

public final class InMemoryTokenStore: TokenStore {
    private var token: String?
    public init() {}
    public func save(_ token: String) throws { self.token = token }
    public func load() throws -> String? { token }
    public func clear() throws { token = nil }
}

public enum KeychainError: Error, Equatable { case status(OSStatus) }

/// Bearer token persistence in the data-protection keychain as a generic-password
/// item.
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String
    private let accessGroup: String?

    /// `accessGroup` is nil-able because plenty of hosts have no entitlement to
    /// name one: the SPM test host, and the iOS app, which ships no
    /// `keychain-access-groups` entitlement and deliberately keeps its bearer in
    /// its own default group. The macOS app passes the shared team group. Both
    /// values come from `AppEnvironment.keychainConfiguration`.
    public init(service: String, account: String, accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    /// `kSecUseDataProtectionKeychain` is the load-bearing key: the legacy
    /// file-based login keychain treats `kSecAttrAccessible` as advisory, so
    /// without this the accessibility asked for in `save` is not enforced.
    /// Internal rather than private so the shape can be asserted by tests that
    /// have no entitlement to exercise the real keychain.
    ///
    /// `kSecAttrSynchronizable: false` is written out rather than left to the
    /// default, and it is load-bearing for every item this type stores. An
    /// item that synced through iCloud Keychain would appear on the user's
    /// other devices — which is wrong for all three callers and for a different
    /// reason each time: the bearer is one device's session, the installation
    /// identity exists precisely to distinguish this machine from a clone of it,
    /// and the Apple purchase capability's entire claim is "the same app
    /// instance on the same device", which a synced copy makes false while
    /// handing a second Mac authority to re-arm a purchase sheet.
    ///
    /// It also constrains reads: omitting the key matches only
    /// non-synchronizable items anyway, so stating it keeps the add and the
    /// query describing the same item rather than relying on two defaults
    /// agreeing.
    var baseQuery: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        return q
    }

    /// How every item this type writes is protected.
    ///
    /// Named rather than inlined because two separate guarantees rest on it and
    /// neither is visible at the call site: the item is available to a headless
    /// relaunch after the first unlock, and — the `ThisDeviceOnly` half — Apple
    /// documents it as NOT migrating to a new device when restoring from a
    /// backup. The installation identity depends on that second property, so it
    /// is asserted by a test rather than left as a literal one edit could move.
    static let accessibility = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    public func save(_ token: String) throws {
        let data = Data(token.utf8)
        SecItemDelete(baseQuery as CFDictionary)      // idempotent overwrite
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = Self.accessibility
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    public func load() throws -> String? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw KeychainError.status(status) }
        return String(data: data, encoding: .utf8)
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }
}
