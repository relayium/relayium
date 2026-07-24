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

/// Bearer token persistence in the login keychain as a generic-password item.
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String
    public init(service: String, account: String) { self.service = service; self.account = account }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
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
