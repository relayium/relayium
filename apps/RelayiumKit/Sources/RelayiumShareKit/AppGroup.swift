import Foundation

/// The one App Group this product uses, and the only way to reach it.
///
/// **Fail-closed, with no fallback.** `containerURL` throws rather than
/// returning a temporary directory, an Application Support path or the
/// extension's own container. The reason is not tidiness: the extension's job is
/// to leave the user's files somewhere the app will find them, and a "draft"
/// written into a container the app cannot read is a silent copy of the user's
/// files that nothing will ever show them, send, or delete. A visible failure
/// with an actionable sentence is the correct outcome of a missing entitlement.
///
/// `containerURLForSecurityApplicationGroupIdentifier` returns `nil` when the
/// calling process does not carry `com.apple.security.application-groups` for
/// this identifier — which is exactly the un-provisioned development build, and
/// exactly the case that must not silently half-work.
public enum AppGroup {
    /// The production identifier, spelled once.
    ///
    /// It must match the entitlement in BOTH `apps/ios/Relayium/Relayium
    /// .entitlements` and `apps/ios/RelayiumShare/RelayiumShare.entitlements`,
    /// and the App Group registered on the Apple Developer portal.
    /// `SharedDraftStoreTests` asserts the literal, because a typo here is a
    /// share sheet that appears to work and hands the app nothing.
    public static let identifier = "group.com.relayium.app" // nonlocalized: an App Group identifier

    /// The group container, or a refusal.
    public static func containerURL(_ fileManager: FileManager = .default) throws -> URL {
        guard let url = fileManager
            .containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
            throw SharedDraftError.unavailableContainer
        }
        return url
    }

    /// `<group container>/SharedDrafts` — where published drafts live.
    ///
    /// Resolving does not create it. `SharedDraftStore` creates what it needs at
    /// the moment it writes and reports that failure to the user; a reader over
    /// a directory that does not exist correctly lists nothing.
    public static func sharedDraftRoot(_ fileManager: FileManager = .default) throws -> URL {
        try containerURL(fileManager)
            .appendingPathComponent("SharedDrafts", isDirectory: true) // nonlocalized: a directory name
    }
}
