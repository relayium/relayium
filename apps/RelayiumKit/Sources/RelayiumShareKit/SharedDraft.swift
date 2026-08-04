import Foundation

/// The hand-off between the iOS share extension and the Relayium app.
///
/// One invocation of the share sheet produces one **draft**: a directory in the
/// App Group container holding immutable plaintext copies of what the user
/// shared, plus a small versioned plan describing them. The extension writes it;
/// the app reads it, adopts it into an account-bound upload, and retires it.
///
/// **What a draft may contain, and what it may not.** It carries the manifest
/// names the receiver will rebuild hierarchy from, their sizes, and an opaque
/// numeric index per staged file. It carries no source URL, no absolute path, no
/// account id, no bearer and no content key. That is not tidiness: the App Group
/// container is readable by every process in the group, and a draft sitting there
/// for days must not be a record of where on the device the user keeps things —
/// let alone a key to anything.
///
/// **The extension is not an uploader.** It has no network, no credential and no
/// key. Encryption, the account's limits, the upload and the link all stay in the
/// app, which is why the plan describes bytes and nothing else.

// MARK: - bounds

/// The file-count bound, and the same one the wire formats enforce.
///
/// Deliberately a local constant rather than an import: this module may not
/// depend on `RelayiumKit`, because the share extension must not link the
/// transport stack to copy a file. `SharedDraftBoundsTests` asserts these three
/// against `RelayiumKit`'s own `MAX_FILES`, `MANIFEST_MAX_NAME_BYTES` and
/// `STORE_CHUNK_SIZE`, so the duplication is checked rather than hoped about.
public let SHARED_DRAFT_MAX_FILES = 1000

/// The per-path byte limit a manifest name may occupy.
public let SHARED_DRAFT_MAX_NAME_BYTES = 1024

/// The copy buffer. Bounded on purpose: a shared 4 GB video must not become
/// 4 GB of dirty memory in an app extension, which the system kills for far
/// less. `SharedDraftWriter.copyBufferPeak` records what was actually held, so
/// the bound is measured rather than asserted.
public let SHARED_DRAFT_COPY_CHUNK = 192 * 1024

// MARK: - identity

/// The opaque identifier of one draft.
///
/// An uppercase `UUID` string and nothing else — checked on the way in and on
/// the way out, because this value becomes a directory name in a container two
/// processes write to, and later becomes `PendingUploadPlan.sourceDraftId`.
/// A permissive id is how a plan written by anything at all reaches a path.
public enum SharedDraftID {
    /// 8-4-4-4-12 uppercase hex. Nothing else, including a lowercase spelling of
    /// the same UUID: one accepted form means the directory name, the plan field
    /// and the pending plan's reference can be compared with `==`.
    public static func isValid(_ raw: String) -> Bool {
        let groups = [8, 4, 4, 4, 12]
        let parts = raw.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == groups.count else { return false }
        for (part, length) in zip(parts, groups) {
            guard part.count == length else { return false }
            for character in part {
                guard character.isASCII,
                      character.isNumber || ("A"..."F").contains(character) else { return false }
            }
        }
        return true
    }

    public static func checked(_ raw: String) throws -> String {
        guard isValid(raw) else { throw SharedDraftError.storageFailed }
        return raw
    }

    /// A fresh id. `UUID().uuidString` is already uppercase hex with dashes.
    public static func make() -> String { UUID().uuidString }
}

// MARK: - the plan

/// One staged file inside a draft.
///
/// `name` is the manifest name — the forward-slash relative path the receiving
/// side rebuilds hierarchy from, and the same convention `SelectedFile
/// .relativePath` uses. `staged` is the file's name inside the draft's own
/// `staged/` directory and is deliberately NOT derived from `name`: a manifest
/// name legitimately contains separators, and composing one into a path is how a
/// draft escapes the directory it was supposed to stay in. It is the index, and
/// nothing else.
public struct SharedDraftFile: Codable, Equatable, Sendable {
    public let name: String
    public let size: Int
    public let staged: String

    public init(name: String, size: Int, staged: String) {
        self.name = name
        self.size = size
        self.staged = staged
    }
}

/// Everything the app needs to find and describe one shared draft.
///
/// `version` is checked on read rather than assumed, for the reason
/// `PendingUploadPlan`'s is: a plan written by a future build is refused, not
/// guessed at. A mis-parsed draft would upload bytes the user never chose.
public struct SharedDraftPlan: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public let version: Int
    public let id: String
    /// Seconds since the epoch, and the FIFO key. Present so several share
    /// invocations keep the order the user made them in — not so anything can
    /// expire: a complete draft is retained until it is used or discarded.
    public let createdAt: Int64
    public let files: [SharedDraftFile]

    public init(version: Int, id: String, createdAt: Int64, files: [SharedDraftFile]) {
        self.version = version
        self.id = id
        self.createdAt = createdAt
        self.files = files
    }

    public var totalBytes: Int { files.reduce(0) { $0 + $1.size } }
}

// MARK: - failure

public enum SharedDraftError: Error, Equatable {
    /// The App Group container could not be resolved. Fail-closed: there is no
    /// fallback location, because a "draft" the app cannot see is a copy of the
    /// user's files left somewhere nothing will ever clean up.
    case unavailableContainer
    /// The share carried nothing this app can send.
    case nothingUsable
    /// Two shared items would occupy the same manifest path.
    case duplicatePath(String)
    /// The container refused a write, a rename or an attribute change.
    case storageFailed
    /// The user backed out, or the host tore the extension down.
    case cancelled
}

// MARK: - copy

/// The one place a `SharedDraftError` becomes words.
///
/// Separate from `ErrorCopy`, which lives in `RelayiumAppKit` and reaches
/// `RelayiumKit`'s error types. The extension renders these and links neither.
public enum SharedDraftCopy {
    public static func message(for error: Error, language: AppLanguage? = nil) -> String {
        switch error {
        case SharedDraftError.unavailableContainer:
            return L10n.t(.errorShareUnavailable, language: language)
        case SharedDraftError.nothingUsable:
            return L10n.t(.errorShareNothingUsable, language: language)
        case let SharedDraftError.duplicatePath(name):
            return L10n.t(.errorShareDuplicatePath,
                          [L10n.token(name, language: language)], language: language)
        case SharedDraftError.cancelled:
            return L10n.t(.errorShareStorageFailed, language: language)
        case let SharedDraftWalkError.tooManyFiles(limit):
            return L10n.t(.errorSelectionTooManyFiles,
                          [L10n.number(limit, language: language)], language: language)
        case let SharedDraftWalkError.unreadable(name):
            return L10n.t(.errorSelectionUnreadable,
                          [L10n.token(name, language: language)], language: language)
        case let SharedDraftWalkError.symbolicLink(name):
            return L10n.t(.errorSelectionSymbolicLink,
                          [L10n.token(name, language: language)], language: language)
        case let SharedDraftWalkError.pathTooLong(name):
            return L10n.t(.errorSelectionPathTooLong,
                          [L10n.token(name, language: language)], language: language)
        default:
            // Everything a filesystem or a provider can raise, including
            // `SharedDraftError.storageFailed`. Deliberately not the underlying
            // description: an `NSError` domain and code is not a sentence, and
            // a path inside one would put the user's directory names on screen.
            return L10n.t(.errorShareStorageFailed, language: language)
        }
    }
}

/// The refusals that come from walking what was shared.
///
/// Separate from `SharedDraftError` because these name an item the user can act
/// on, and because they are deliberately the same four refusals
/// `FileSelectionError` makes for a picked selection — the same rules, applied
/// before anything is copied rather than after.
public enum SharedDraftWalkError: Error, Equatable {
    case tooManyFiles(Int)
    case unreadable(String)
    /// Neither followed (which would copy files from outside what was shared)
    /// nor skipped (which would send an incomplete tree without saying so).
    case symbolicLink(String)
    case pathTooLong(String)
}
