import Foundation

/// What a Stored Object is being created FOR, as the upload declares it.
///
/// The Swift half of `server/account/taskobject.go`'s `StoredPurpose*`
/// constants, and closed for the same reason they are: purpose decides the
/// object's authorization model, not merely a label on it. A `share` is
/// publicly readable by whoever holds its capability link; a `device_task` is
/// readable ONLY by the target device holding a current claim, is excluded from
/// the account's file list, and cannot be reached through
/// `/api/files/{id}/meta|blob` at all.
///
/// A `String` here instead of an enum would let a typo produce an object the
/// server refuses to publish and the client believes it shared, so this is the
/// one spelling in the native client and it round-trips through the same raw
/// tokens the server parses.
///
/// It is `Codable` because it is persisted in a pending upload plan, where an
/// unknown raw value must fail the decode rather than resolve to a default —
/// guessing at a purpose written by a future build is how a delivery would be
/// resumed as a public share.
public enum UploadPurpose: String, Codable, Equatable, Sendable, CaseIterable {
    case share
    case deviceTask = "device_task"

    /// The P3A queue/object lifetime. Keeping one native constant prevents the
    /// initial upload and a recovered plan from quietly choosing different
    /// retention for the same delivery.
    public static let deviceTaskTTLSeconds = 86_400

    /// Whether burn-after-read / a download cap may be requested.
    ///
    /// Only `share` may. A task-purpose object must be unlimited until its TTL:
    /// the queue refuses a limited object outright, because an unrelated reader
    /// spending its final slot would strand a delivery central had already
    /// promised. `resolveUploadRetention` REFUSES the combination rather than
    /// rewriting it, so a client that sent it would get a 400 after staging
    /// every byte.
    public var allowsBurnAfterRead: Bool {
        switch self {
        case .share: return true
        case .deviceTask: return false
        }
    }
}
