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
    case rateLimited           // 429 with Retry-After — transient, worth retrying
    /// 429, this file needs more than the account's remaining daily allowance.
    /// Resets tomorrow; a plan with a bigger allowance also clears it.
    case dailyQuota
    /// 429, the account is out of monthly traffic. Resets next month; only an
    /// upgrade clears it sooner.
    case monthlyTraffic
    /// 429 on a stored download. The cases above describe an uploader's own
    /// request rate and allowances, while a recipient can encounter either the
    /// download-start limit for their IP or the sender account's monthly
    /// traffic limit.
    ///
    /// One case for both because the client cannot tell them apart: they are the
    /// same status on the same request, and the only discriminator is server
    /// prose, which is a wire contract that drifts. `monthlyTraffic`'s wording
    /// would assert the second cause and offer an upgrade that would not help,
    /// since it is not this user's quota; `server(status: 429)` reads as a
    /// generic server failure and does not explain either actionable cause.
    case downloadLimited
    case notFound              // 404
    case server(status: Int)   // other non-2xx
    case network               // transport failure
    case decoding              // unparseable body
}

/// The shareable link; the key lives ONLY in the fragment. `/d/<id>` is the
/// recipient route the server AASA also hands off to the native app (Universal Links).
///
/// `id` is interpolated verbatim — this function neither checks nor escapes it,
/// because both would be the wrong place: the id has to be refused before a key
/// is filed under it, not repaired on the way into a string. Every caller
/// therefore passes one that `StoredObjectID.checked` has already accepted:
/// `CloudUploadModel.finish` checks it directly, and `AccountManagementModel`
/// reaches this only through a key lookup that applied the same rule.
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
