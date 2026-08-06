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
    /// iOS's group, matching the entitlement in both `apps/ios/Relayium
    /// /Relayium.entitlements` and `apps/ios/RelayiumShare
    /// /RelayiumShare.entitlements`.
    // nonlocalized: an App Group identifier
    public static let iOSIdentifier = "group.com.relayium.app"

    /// macOS's group, and **not the same string**, for two independent reasons
    /// rather than a naming preference:
    ///
    ///  1. The macOS provisioning profiles authorize `group.com.relayium.shared`
    ///     and the team-prefixed wildcard `7PVYUG4YQS.*`. They do **not**
    ///     authorize `group.com.relayium.app`, so reusing iOS's string produces a
    ///     container lookup that returns nil on every Mac.
    ///  2. Apple documents the macOS form of an App Group identifier as
    ///     `<team identifier>.<group name>`, unlike iOS's bare `group.…`. The
    ///     value below satisfies both the documented form and the wildcard.
    ///
    /// The team identifier is written out because an entitlement's
    /// `$(TeamIdentifierPrefix)` substitution exists in the plist and not in
    /// Swift; `MacSurfaceGuardTests` pins this literal against the entitlement
    /// files so the two cannot drift apart in one direction only.
    // nonlocalized: an App Group identifier
    public static let macOSIdentifier = "7PVYUG4YQS.com.relayium.shared"

    /// The identifier this build actually uses.
    ///
    /// Resolved at compile time from the platform rather than passed in: the
    /// value is a property of the bundle's entitlement, and a caller that could
    /// choose it would be a caller that could choose wrongly. A typo here is a
    /// share sheet that appears to work and hands the app nothing, which is why
    /// both literals above are asserted by name in the test suite.
    #if os(macOS)
    public static let identifier = macOSIdentifier
    #else
    public static let identifier = iOSIdentifier
    #endif

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
