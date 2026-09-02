import Foundation
@preconcurrency import RelayiumKit

/// The iOS receive folder: **fixed, inside the app's own container, and granted
/// by the container rather than by a panel.**
///
/// ## Why the macOS pair does not work here
///
/// `InboxReceiveFolder` was written for a Mac, where the destination is a folder
/// the user picked in `NSOpenPanel` and the app's authority over it is a
/// security-scoped bookmark. Both halves of that are absent on iOS:
///
///  * `URL.bookmarkData(options: .withSecurityScope)` does not exist, so
///    `SystemInboxFolderBookmarking` already falls back to a plain bookmark —
///    and a plain bookmark's URL answers `startAccessingSecurityScopedResource()`
///    with **false**, which `InboxReceiveFolder.open` reads as
///    `.unavailable(.accessDenied)`. The receiver would report a permission
///    failure on a directory it owns outright;
///  * there is no default-destination picker to offer in the first place. The
///    app receives into `Documents/Received` and publishes it to the Files app
///    (`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`), which is
///    exactly the decision `ReceiveDestination` already records for stored links.
///
/// So the two seams `InboxReceiveFolder` was built with are filled with the iOS
/// answers instead of the folder logic being branched. `InboxReceiveFolder`
/// itself — the write probe, the policy refusal without a folder, the state
/// vocabulary the surface renders — is unchanged and shared.
///
/// ## What is deliberately NOT relaxed
///
/// The **policy** is still an explicit, account-scoped, default-off consent that
/// the user gives here. Having a folder by construction removes the folder
/// consent, not the receiving one: a fixed destination is not permission for the
/// account's other devices to write into it unattended, and collapsing the two
/// would be the single-flag mistake `InboxReceiveFolder.setReceivePolicy`
/// documents at length.
///
/// The write probe is still run. `Documents/Received` is the app's own
/// directory, and it can still be full, or occupied by something that is not a
/// directory, and `receiveDirReady` is reported to central and decides whether a
/// sender is told their file will land.
public enum InboxContainerFolder {

    /// Resolve `Documents/Received`, creating it if it is not there.
    ///
    /// Delegates to `ReceiveDestination` rather than assembling a second path:
    /// the Device Inbox and a stored link write into the SAME folder, and two
    /// constructions of one directory is how they would end up one rename apart.
    /// It throws for the one condition that is a refusal rather than a repair —
    /// something that is not a directory occupying the name — because whatever is
    /// there belongs to the user.
    public static func directory(_ fileManager: FileManager = .default) throws -> URL {
        try ReceiveDestination.directory(fileManager)
    }
}

/// The bookmarking seam for a directory this process owns.
///
/// Every method answers from the container rather than from stored bytes:
///
///  * `bookmark(for:)` returns a fixed marker. There is nothing to encode — the
///    location is not the user's choice and cannot move — and a real bookmark
///    would be a container path baked into `UserDefaults`, which is wrong on the
///    next install because the OS assigns that path;
///  * `resolve(_:)` **ignores the bytes** and asks the container again, which is
///    what makes the marker safe: a stale, forged or truncated value cannot
///    redirect a delivery anywhere, because nothing in it is read;
///  * `startAccess` is `true` and `stopAccess` is a no-op, because an app needs
///    no scope for its own `Documents`. That is not a stub: reporting `false`
///    would be a permission failure this platform cannot have, and reporting an
///    open scope that was never opened would leave `InboxFolderAccess` calling
///    `stopAccessingSecurityScopedResource` on an unscoped URL.
///
/// `isStale` is always false. Nothing about this grant can go out of date; what
/// can go wrong is the directory, and that is `probeWritable`'s answer, not this
/// one's.
public struct ContainerInboxFolderBookmarking: InboxFolderBookmarking {
    /// Asked on every resolve rather than captured once, so a folder the user
    /// deleted in the Files app between two passes is re-created on the next one
    /// instead of leaving the receiver pointed at a path that is gone.
    private let resolveDirectory: @Sendable () throws -> URL

    public init(directory: @escaping @Sendable () throws -> URL
                    = { try InboxContainerFolder.directory() }) {
        resolveDirectory = directory
    }

    /// The stored marker. Never parsed — see `resolve(_:)`.
    // nonlocalized: an opaque storage marker, never displayed
    public static let marker = Data("relayium.inbox.container.v1".utf8)

    public func bookmark(for url: URL) throws -> Data { Self.marker }

    public func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        (try resolveDirectory(), false)
    }

    public func startAccess(to url: URL) -> Bool { true }

    public func stopAccess(to url: URL) {}
}

/// A folder store that **always has a folder** and keeps the user's policy.
///
/// Wraps a real store — `UserDefaultsInboxFolderStore` in the app — and overrides
/// exactly one of its four answers. The policy and the durable stop-announcement
/// bit are the wrapped store's, unchanged and still account-scoped, because both
/// are decisions and outbox state that must survive a launch.
///
/// ## Why `setBookmarkData` refuses rather than obeys
///
/// `InboxReceiveFolder.forget(account:)` clears the bookmark and the policy
/// together, and `InboxController.removeFolder()` is what calls it. The iOS
/// surface renders no such control — there is no second folder to move to — but
/// "the UI does not offer it" is not the same as "it cannot happen", and the
/// consequence if it did would be an inbox permanently stuck in `folderMissing`
/// with no control that could repair it. So the grant is a property of the
/// platform here, not a stored value a call can remove.
///
/// The policy half of `forget` still goes through: an account signing out of a
/// device whose receiving was on has still turned receiving off, which is the
/// half of that method that is meaningful when the folder cannot be given up.
public final class ContainerInboxFolderStore: InboxFolderStoring, @unchecked Sendable {
    private let base: InboxFolderStoring

    public init(base: InboxFolderStoring) {
        self.base = base
    }

    /// Never nil, for every account. `hasFolder` is therefore always true and
    /// the `folderMissing` repair state is unreachable on this platform — which
    /// is the truth, not a suppression: the folder is the app's own container.
    public func bookmarkData(account: InboxAccountID) -> Data? {
        ContainerInboxFolderBookmarking.marker
    }

    /// Deliberately ignored. See the type comment.
    public func setBookmarkData(_ data: Data?, account: InboxAccountID) {}

    public func receivePolicy(account: InboxAccountID) -> InboxAutoAccept {
        base.receivePolicy(account: account)
    }

    public func setReceivePolicy(_ policy: InboxAutoAccept, account: InboxAccountID) {
        base.setReceivePolicy(policy, account: account)
    }

    public func stopAnnouncementPending(account: InboxAccountID) -> Bool {
        base.stopAnnouncementPending(account: account)
    }

    public func setStopAnnouncementPending(_ pending: Bool, account: InboxAccountID) {
        base.setStopAnnouncementPending(pending, account: account)
    }
}
