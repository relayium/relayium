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
    var baseQuery: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        return q
    }

    public func save(_ token: String) throws {
        let data = Data(token.utf8)
        SecItemDelete(baseQuery as CFDictionary)      // idempotent overwrite
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
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
