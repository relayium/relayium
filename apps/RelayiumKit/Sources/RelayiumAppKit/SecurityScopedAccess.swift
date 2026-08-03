import Foundation

/// Owning the security-scoped access `fileImporter` hands back.
///
/// `fileImporter` returns security-scoped URLs. Apple's contract is that every
/// successful `startAccessingSecurityScopedResource()` must be balanced by a
/// `stopAccessingSecurityScopedResource()`, that the final stop revokes access
/// immediately, and that leaked scopes exhaust a finite per-process resource.
/// That contract cannot live in a SwiftUI view: SwiftUI decides when a view is
/// rebuilt, and a view cannot be unit-tested. It lives here, with one
/// operation — `replace` — because an API that could start scopes without
/// taking ownership of them would have a leak path in its own shape.

/// The two URL APIs, behind a seam so a test can count them.
public protocol SecurityScopedResourceAccessing: Sendable {
    func startAccess(to url: URL) -> Bool
    func stopAccess(to url: URL)
}

/// The real thing, and the only place in the product that calls the two URL
/// APIs. Both are no-ops on macOS for URLs that carry no sandbox extension,
/// which is why the same type compiles and behaves on both platforms.
public struct SystemSecurityScopedResource: SecurityScopedResourceAccessing {
    public init() {}

    public func startAccess(to url: URL) -> Bool {
        url.startAccessingSecurityScopedResource()
    }

    public func stopAccess(to url: URL) {
        url.stopAccessingSecurityScopedResource()
    }
}

/// Holds at most one batch of started scopes, and stops exactly what it started.
///
/// A plain `final class` with an `NSLock`, never `@MainActor`: `deinit` is
/// precisely the release path that must not be skippable, and a `deinit` cannot
/// touch main-actor-isolated state.
public final class SecurityScopedAccess: @unchecked Sendable {
    private let resource: SecurityScopedResourceAccessing
    private let lock = NSLock()
    /// The de-duplicated batch handed to the caller, refused starts included.
    private var held: [URL] = []
    /// The subset whose start returned true — the only ones that owe a stop.
    private var started: [URL] = []

    public init(resource: SecurityScopedResourceAccessing = SystemSecurityScopedResource()) {
        self.resource = resource
    }

    /// De-duplicates by standardized path, starts access for each distinct URL,
    /// releases whatever batch was held before, and returns the de-duplicated
    /// list — including the ones whose start returned false.
    ///
    /// One operation rather than `begin` + `adopt`: an API that could start
    /// scopes and then not take ownership of them has a leak path in its own
    /// shape.
    ///
    /// De-duplication happens BEFORE any start, matching `expandSelection`'s own
    /// root de-duplication. Two URL objects for one path would otherwise take
    /// two sandbox extensions and need two stops.
    ///
    /// The new batch is started before the old one is released, so a path that
    /// appears in both never drops to zero extensions in between — which would
    /// revoke access the caller is about to rely on.
    @discardableResult
    public func replace(with urls: [URL]) -> [URL] {
        var seen = Set<String>()
        var distinct: [URL] = []
        for url in urls where seen.insert(url.standardizedFileURL.path).inserted {
            distinct.append(url)
        }

        var newlyStarted: [URL] = []
        for url in distinct where resource.startAccess(to: url) {
            // Only successful starts are remembered. A `false` return consumed
            // no extension, and stopping it anyway is unbalanced in the other
            // direction. A start that genuinely failed will fail again,
            // visibly, when `expandSelection` reads it, with copy naming it.
            newlyStarted.append(url)
        }

        lock.lock()
        let previous = started
        started = newlyStarted
        held = distinct
        lock.unlock()

        for url in previous { resource.stopAccess(to: url) }
        return distinct
    }

    public func clear() { release() }

    /// The de-duplicated batch currently held, for tests.
    public var heldURLs: [URL] {
        lock.lock(); defer { lock.unlock() }
        return held
    }

    /// Only the URLs whose start succeeded, for tests.
    public var startedURLs: [URL] {
        lock.lock(); defer { lock.unlock() }
        return started
    }

    /// The one release path, shared by `clear()` and `deinit` so neither can
    /// drift from the other. Idempotent: the second call finds nothing started.
    private func release() {
        lock.lock()
        let previous = started
        started = []
        held = []
        lock.unlock()
        for url in previous { resource.stopAccess(to: url) }
    }

    deinit { release() }
}
