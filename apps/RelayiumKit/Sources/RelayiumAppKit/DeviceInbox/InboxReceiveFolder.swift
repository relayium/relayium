import Foundation
import Darwin
@preconcurrency import RelayiumKit

/// The user's chosen receive directory, and the durable authorization to write
/// into it.
///
/// A sandboxed macOS app loses access to a user-chosen folder the moment it
/// quits. Apple's documented mechanism for keeping it is a SECURITY-SCOPED
/// BOOKMARK: created with `.withSecurityScope`, resolved with
/// `.withSecurityScope`, and used only between a matched
/// `startAccessingSecurityScopedResource()` /
/// `stopAccessingSecurityScopedResource()` pair.
/// <https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox>
///
/// Three properties this type exists to hold, none of which survives being left
/// to a call site:
///
///  1. **Every successful start is balanced.** The scopes are a finite
///     per-process resource, and the final stop is what revokes access. A handle
///     owns exactly one started scope and releases it on `deinit`, so "the
///     handle went away" and "the scope was released" are the same event.
///  2. **A stale bookmark is refreshed only after a VERIFIED WRITABLE
///     resolution.** `bookmarkDataIsStale` means the system re-resolved the
///     bookmark by other means and wants fresh data. Rewriting the stored
///     bookmark from a resolution that has not been proven writable would
///     overwrite the last known-good grant with one that may point at a folder
///     this app can no longer use — and there is no way back from that.
///  3. **The four outcomes are distinguished, never collapsed.** "You have not
///     chosen a folder", "the grant could not be refreshed", "the folder is gone
///     or the grant was revoked" and "it works" are four different things for a
///     person to do, and reporting any of them as another is how a receiver ends
///     up telling a sender it can receive when it cannot.

/// Why a resolved folder is not usable.
public enum InboxFolderProblem: Equatable, Sendable {
    /// The bookmark resolved but the system refused to open its security scope.
    case accessDenied
    /// The bookmark could not be resolved at all: the folder was deleted, the
    /// volume is not mounted, or the grant was revoked.
    case unresolvable
    /// It resolved but is not a directory this process can create and remove a
    /// file in right now — a read-only remount, a full disk, an ACL, an
    /// immutable flag, or a revoked TCC grant.
    case notWritable
    /// It resolved and was writable, but was flagged stale and the refreshed
    /// bookmark could not be produced. The old bookmark is KEPT; this reports
    /// that the next launch may lose the grant.
    case staleRefreshFailed
}

/// What this device can honestly say about its receive directory.
public enum InboxFolderState: Equatable, Sendable {
    /// No folder has ever been chosen. Distinct from every failure: nothing is
    /// wrong, the user simply has not done it yet.
    case absent
    /// Resolved, security scope open, and proven writable by a real
    /// create-and-remove probe.
    case usable(URL)
    /// A folder was chosen, and right now it cannot be used.
    case unavailable(InboxFolderProblem)

    /// Whether a delivery may be claimed at all.
    ///
    /// The single gate the receive loop consults. No usable directory means no
    /// claim: taking a lease this device cannot honour would leave the sender
    /// watching a task that is not progressing.
    public var canReceive: Bool {
        if case .usable = self { return true }
        return false
    }

    public var url: URL? {
        if case .usable(let url) = self { return url }
        return nil
    }
}

/// The two `URL` bookmark APIs, behind a seam so a test can drive stale,
/// unresolvable and access-denied outcomes that a real bookmark cannot be made
/// to produce on demand.
public protocol InboxFolderBookmarking: Sendable {
    /// Read/write security-scoped bookmark data for a folder the user chose.
    func bookmark(for url: URL) throws -> Data
    /// Resolve bookmark data, reporting whether the system wants it refreshed.
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool)
    /// Open the security scope. False means the system refused.
    func startAccess(to url: URL) -> Bool
    /// Close a scope that was successfully opened.
    func stopAccess(to url: URL)
}

/// The real thing, and the only place in the product that calls the four APIs.
public struct SystemInboxFolderBookmarking: InboxFolderBookmarking {
    public init() {}

    /// `.withSecurityScope` on BOTH sides is what makes the bookmark a durable
    /// authorization rather than a path. A read/write scope is requested — the
    /// default — because a receiver creates files; `.securityScopeAllowOnlyReadAccess`
    /// would produce a bookmark that resolves and then fails at the first write.
    ///
    /// macOS-only by construction: `withSecurityScope` does not exist on iOS, and
    /// neither does the sandbox model that needs it. The `#if` keeps the type
    /// compiling for the shared package rather than pretending the behaviour is
    /// portable — an iOS receiver has a fixed container directory (PRD §11.2) and
    /// no user-chosen folder at all.
    public func bookmark(for url: URL) throws -> Data {
        #if os(macOS)
        return try url.bookmarkData(options: [.withSecurityScope],
                                    includingResourceValuesForKeys: nil, relativeTo: nil)
        #else
        return try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        #endif
    }

    public func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        var stale = false
        #if os(macOS)
        let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope],
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        #else
        let url = try URL(resolvingBookmarkData: data, options: [],
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        #endif
        return (url, stale)
    }

    public func startAccess(to url: URL) -> Bool { url.startAccessingSecurityScopedResource() }
    public func stopAccess(to url: URL) { url.stopAccessingSecurityScopedResource() }
}

/// An open security scope on the receive directory, released exactly once.
///
/// A `final class` with a lock rather than a struct or an actor: `deinit` is the
/// release path that must not be skippable, and a `deinit` cannot touch
/// actor-isolated state. The same reasoning, and the same shape, as
/// `SecurityScopedAccess`.
public final class InboxFolderAccess: @unchecked Sendable {
    public let url: URL
    private let bookmarking: InboxFolderBookmarking
    private let lock = NSLock()
    private var open: Bool

    init(url: URL, bookmarking: InboxFolderBookmarking, started: Bool) {
        self.url = url
        self.bookmarking = bookmarking
        self.open = started
    }

    /// Idempotent: the second call finds nothing open. Called by `deinit` and by
    /// any caller finishing early, so neither can drift from the other.
    public func release() {
        lock.lock()
        let wasOpen = open
        open = false
        lock.unlock()
        if wasOpen { bookmarking.stopAccess(to: url) }
    }

    /// Whether a scope is still held, for tests.
    public var isOpen: Bool {
        lock.lock(); defer { lock.unlock() }
        return open
    }

    deinit { release() }
}

/// Where the bookmark and the automatic-receive flag are persisted.
///
/// A seam rather than `UserDefaults` directly, so the account-scoping rule can be
/// asserted without touching the running user's defaults.
public protocol InboxFolderStoring: AnyObject, Sendable {
    func bookmarkData(account: InboxAccountID) -> Data?
    func setBookmarkData(_ data: Data?, account: InboxAccountID)
    func automaticReceive(account: InboxAccountID) -> Bool
    func setAutomaticReceive(_ enabled: Bool, account: InboxAccountID)
}

/// The real store: `UserDefaults`, keyed PER ACCOUNT.
///
/// Account-scoped for the same reason the key history is: two accounts can be
/// used on one Mac, and a folder grant plus an automatic-receive opt-in that
/// carried across a sign-in would let one account's decision authorise writes on
/// behalf of another. Sign-out leaves both in place for the account that made
/// them, which is what a returning user expects; `forget` is the explicit
/// removal.
public final class UserDefaultsInboxFolderStore: InboxFolderStoring, @unchecked Sendable {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    static func bookmarkKey(_ account: InboxAccountID) -> String {
        "com.relayium.deviceInbox.folderBookmark." + account.value
    }
    static func automaticKey(_ account: InboxAccountID) -> String {
        "com.relayium.deviceInbox.automaticReceive." + account.value
    }

    public func bookmarkData(account: InboxAccountID) -> Data? {
        defaults.data(forKey: Self.bookmarkKey(account))
    }

    public func setBookmarkData(_ data: Data?, account: InboxAccountID) {
        let key = Self.bookmarkKey(account)
        if let data { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    /// Absent reads as FALSE, which is the product invariant rather than a
    /// convenience: automatic receive is default-off (PRD §8), so a missing key,
    /// a fresh install and a cleared domain all mean "not enabled". There is no
    /// spelling of this store's state that turns it on by omission.
    public func automaticReceive(account: InboxAccountID) -> Bool {
        defaults.bool(forKey: Self.automaticKey(account))
    }

    public func setAutomaticReceive(_ enabled: Bool, account: InboxAccountID) {
        defaults.set(enabled, forKey: Self.automaticKey(account))
    }
}

/// In-memory double with the same account scoping.
public final class InMemoryInboxFolderStore: InboxFolderStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var bookmarks: [String: Data] = [:]
    private var automatic: [String: Bool] = [:]

    public init() {}

    public func bookmarkData(account: InboxAccountID) -> Data? {
        lock.lock(); defer { lock.unlock() }
        return bookmarks[account.value]
    }

    public func setBookmarkData(_ data: Data?, account: InboxAccountID) {
        lock.lock(); defer { lock.unlock() }
        if let data { bookmarks[account.value] = data } else { bookmarks[account.value] = nil }
    }

    public func automaticReceive(account: InboxAccountID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return automatic[account.value] ?? false
    }

    public func setAutomaticReceive(_ enabled: Bool, account: InboxAccountID) {
        lock.lock(); defer { lock.unlock() }
        automatic[account.value] = enabled
    }
}

/// Resolving, probing and refreshing the receive-folder grant.
public struct InboxReceiveFolder: Sendable {
    private let store: InboxFolderStoring
    private let bookmarking: InboxFolderBookmarking

    public init(store: InboxFolderStoring,
                bookmarking: InboxFolderBookmarking = SystemInboxFolderBookmarking()) {
        self.store = store
        self.bookmarking = bookmarking
    }

    /// Whether automatic receive is enabled for this account. Default-off.
    public func isAutomaticReceiveEnabled(account: InboxAccountID) -> Bool {
        store.automaticReceive(account: account)
    }

    /// Enabling automatic receive is a SEPARATE decision from choosing a folder,
    /// and is refused without one.
    ///
    /// The two could have been one flag. They must not be: a folder grant is an
    /// authorization the user gave the app, and automatic receive is a decision to
    /// let other machines use it unattended (PRD §8). Choosing a folder to receive
    /// into manually is not consent to unattended writes, and a single flag would
    /// make it one.
    public func setAutomaticReceive(_ enabled: Bool, account: InboxAccountID) throws {
        if enabled, store.bookmarkData(account: account) == nil {
            throw InboxFolderError.noFolderChosen
        }
        store.setAutomaticReceive(enabled, account: account)
    }

    /// Record a folder the user just chose, after proving this process can
    /// actually write into it.
    ///
    /// The probe happens BEFORE the bookmark is stored, so a folder that cannot
    /// be written is never persisted as a grant. It does NOT turn automatic
    /// receive on: that stays default-off and needs its own explicit call.
    @discardableResult
    public func chooseFolder(_ url: URL, account: InboxAccountID) throws -> URL {
        let started = bookmarking.startAccess(to: url)
        defer { if started { bookmarking.stopAccess(to: url) } }
        guard InboxReceiveFolder.probeWritable(url) else {
            throw InboxFolderError.notWritable
        }
        let data: Data
        do { data = try bookmarking.bookmark(for: url) }
        catch { throw InboxFolderError.bookmarkFailed }
        store.setBookmarkData(data, account: account)
        return url
    }

    /// Forget this account's folder grant AND its automatic-receive opt-in.
    ///
    /// Both, together: leaving the flag on with no folder would be a stored "yes"
    /// waiting to be paired with whatever folder is chosen next.
    public func forget(account: InboxAccountID) {
        store.setBookmarkData(nil, account: account)
        store.setAutomaticReceive(false, account: account)
    }

    /// The read a receive loop makes before every claim, and the only place a
    /// stale bookmark is refreshed.
    ///
    /// Returns the state AND, when usable, an access handle whose lifetime is the
    /// caller's permission to write. Dropping the handle releases the scope.
    public func open(account: InboxAccountID) -> (state: InboxFolderState, access: InboxFolderAccess?) {
        guard let data = store.bookmarkData(account: account) else { return (.absent, nil) }

        let resolved: (url: URL, isStale: Bool)
        do { resolved = try bookmarking.resolve(data) }
        catch { return (.unavailable(.unresolvable), nil) }

        guard bookmarking.startAccess(to: resolved.url) else {
            return (.unavailable(.accessDenied), nil)
        }
        let access = InboxFolderAccess(url: resolved.url, bookmarking: bookmarking, started: true)

        guard InboxReceiveFolder.probeWritable(resolved.url) else {
            access.release()
            return (.unavailable(.notWritable), nil)
        }

        // Only NOW, with a resolution proven writable under an open scope, may the
        // stored bookmark be replaced. A refresh taken before the probe would
        // overwrite the last known-good grant with an unproven one.
        if resolved.isStale {
            guard let refreshed = try? bookmarking.bookmark(for: resolved.url) else {
                // The old bookmark is deliberately KEPT: it is still the best
                // authorization this app has, and it may resolve again next launch.
                // The state is truthful about the risk rather than silently
                // reporting success.
                access.release()
                return (.unavailable(.staleRefreshFailed), nil)
            }
            store.setBookmarkData(refreshed, account: account)
        }

        return (.usable(resolved.url), access)
    }

    /// Whether `url` can receive right now: it is a real directory (not a symlink
    /// to one, not a device node) and this process can create and remove a file
    /// in it.
    ///
    /// Deliberately a real create-and-remove rather than a permission-bit
    /// inspection. Mode bits lie: a read-only remount, a full disk, an ACL, an
    /// immutable flag and a revoked macOS TCC grant all leave them looking fine.
    /// `receiveDirReady` is reported to central on every heartbeat and decides
    /// whether a sender is told their file will land, so it has to be the truth
    /// rather than an inference.
    ///
    /// The probe name is FIXED, not random, so a crashed probe leaves at most one
    /// recognisable file — and it is a name `InboxDestinationPlan` refuses, so a
    /// manifest cannot get a delivery deleted by the next probe.
    public static func probeWritable(_ url: URL) -> Bool {
        var st = stat()
        guard lstat(url.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR else { return false }
        let dirFD = retryOnEINTR { Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        guard dirFD >= 0 else { return false }
        defer { close(dirFD) }
        var fd = probeName.withCString { name in
            retryOnEINTR {
                openat(dirFD, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            }
        }
        if fd < 0, errno == EEXIST {
            // A previous probe died before cleanup. Remove it and try once more
            // rather than declaring the directory unusable forever.
            removeAt(parent: dirFD, name: probeName, isDirectory: false)
            fd = probeName.withCString { name in
                retryOnEINTR {
                    openat(dirFD, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
                }
            }
        }
        guard fd >= 0 else { return false }
        close(fd)
        return removeAt(parent: dirFD, name: probeName, isDirectory: false)
    }

    /// The writability probe's fixed name. Refused as a destination by
    /// `InboxDestinationPlan`, because a delivery landing on this name would be
    /// deleted by the next probe, which removes a stale file it assumes it left
    /// behind (WORKFLOW-LEARNINGS, 2026-08-09).
    public static let probeName = ".relayium-inbox-probe"
}

public enum InboxFolderError: Error, Equatable, Sendable {
    /// Automatic receive was requested with no folder chosen. No directory means
    /// no receive claim, so enabling would be a stored "yes" that nothing can act
    /// on.
    case noFolderChosen
    /// The chosen folder failed its write probe, so it is not stored as a grant.
    case notWritable
    /// The system would not produce security-scoped bookmark data for it.
    case bookmarkFailed
}
