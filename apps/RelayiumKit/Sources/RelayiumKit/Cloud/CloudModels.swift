import Foundation

public struct UploadResult: Codable, Equatable {
    public let id: String
    public let expiresAt: Int64
}

public struct StoredFileMeta: Codable, Equatable {
    public let encManifest: String       // base64 STANDARD
    public let size: Int64
    public let burnAfterRead: Bool
    public let expiresAt: Int64
}

public enum CloudError: Error, Equatable {
    case unauthorized          // 401
    case quota                 // 413
    case rateLimited           // 429
    case notFound              // 404
    case server(status: Int)   // other non-2xx
    case network               // transport failure
    case decoding              // unparseable body
}

/// The shareable link; the key lives ONLY in the fragment. `/d/<id>` is the
/// recipient route the server AASA also hands off to the native app (Universal Links).
public func buildDownloadLink(origin: String, id: String, keyB64url: String) -> String {
    "\(origin)/d/\(id)#k=\(keyB64url)"
}

/// Extract the base64url key from a `#k=…` (or `k=…`) fragment; nil if malformed.
public func parseDownloadFragment(_ hash: String) -> String? {
    let s = hash.hasPrefix("#") ? String(hash.dropFirst()) : hash
    guard s.hasPrefix("k=") else { return nil }
    let key = String(s.dropFirst(2))
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    guard !key.isEmpty, key.allSatisfy({ allowed.contains($0) }) else { return nil }
    return key
}
