import Foundation

/// The items one share invocation carried, and the one rule that matters about
/// them.
///
/// `NSItemProvider.loadFileRepresentation` hands back a **temporary** URL and
/// deletes it the moment its completion handler returns. Everything that reads
/// those bytes therefore has to happen inside the handler, before it returns —
/// which is why `load(_:stage:)` takes a closure and promises to run it there
/// rather than returning a URL somebody else will open later. A URL returned
/// from here would be a path to a file that no longer exists, and the failure
/// would look like "the share extension staged an empty file".
///
/// **`stage` is `@escaping`, and that is a statement of fact rather than a
/// convenience.** The production loader hands this closure to a provider's
/// completion handler, and a real `NSItemProvider` RETAINS that handler —
/// past the call, and on iPadOS 18 past the load itself. An earlier version of
/// this file wrapped the callback in `withoutActuallyEscaping(stage)` on the
/// argument that `load` blocks until the handler has run, so the closure could
/// not outlive the call. The provider's retention makes that untrue, and the
/// Swift runtime checks it: on a real device the escape check trapped
/// (`EXC_BREAKPOINT`) as the scope exited, killing the extension *after* the
/// copy and *before* `publish()` — which is exactly the shape of "the share
/// sheet said nothing and the app sees no draft".
///
/// A protocol so `SharedDraftPreparation` can be driven under `swift test` with
/// no provider, no share sheet and no host: the interesting failures — a
/// callback that errors, an item that vanishes, a cancellation landing between
/// two items — are exactly the ones a real provider will not reproduce on
/// demand.
public protocol SharedDraftItemLoading: Sendable {
    var itemCount: Int { get }

    /// Deliver item `index` to `stage`, and return only after `stage` has
    /// finished with it. Throws whatever `stage` throws, or the provider's own
    /// failure.
    ///
    /// `stage` runs at most once, whatever the provider does.
    func load(_ index: Int, stage: @escaping (URL, String) throws -> Void) throws
}

/// The two calls `ItemProviderLoader` makes on an `NSItemProvider`, and the
/// seam that makes the provider's *retention* testable.
///
/// The failure this exists for is not "the provider errored" — that is easy to
/// stage — but "the provider keeps the completion handler alive, and calls it
/// again later". A plain `NSItemProvider` built inside `swift test` does not
/// reproduce that on demand, so the property that has to hold afterwards —
/// a retained handler holding no draft writer, no source URL, no staging
/// closure and no suggested filename — could not be asserted against it.
protocol ItemRepresentationProviding {
    var suggestedName: String? { get }
    func hasItemConformingToTypeIdentifier(_ typeIdentifier: String) -> Bool
    /// Deliberately *not* spelled `loadFileRepresentation(forTypeIdentifier:completionHandler:)`:
    /// same-signature shadowing of the `NSItemProvider` method would make the
    /// forwarding call below ambiguous with itself.
    func loadFileRepresentation(ofType typeIdentifier: String,
                                completion: @escaping (URL?, Error?) -> Void)
}

extension NSItemProvider: ItemRepresentationProviding {
    func loadFileRepresentation(ofType typeIdentifier: String,
                                completion: @escaping (URL?, Error?) -> Void) {
        // The returned `Progress` is dropped on purpose: nothing here cancels a
        // load in flight. `SharedDraftWriter.cancel` stops the copy between
        // chunks instead, which is the half that actually owns the user's bytes.
        _ = loadFileRepresentation(forTypeIdentifier: typeIdentifier,
                                   completionHandler: completion)
    }
}

/// The rendezvous between a provider's completion handler and the thread waiting
/// inside `load`.
///
/// One shot in the strict sense. The FIRST terminal callback claims the staging
/// payload, runs it, records the outcome and wakes the waiter; every later
/// callback — a provider that calls its handler twice, or once more long after
/// the load returned — finds nothing to claim and returns without staging
/// anything and without signalling again.
///
/// **The claim is also the release.** The payload — the staging closure, and
/// through it the `SharedDraftWriter` and every byte it owns, plus the name the
/// item would be staged under, which is normally the user's own filename — is
/// dropped at that terminal transition rather than when the handler is finally
/// released, because the provider decides when that is and may decide "never".
/// What a retained handler holds afterwards is this object and empty slots.
///
/// `lock` is held only to swap those slots — never across the copy, which runs
/// for as long as the user's file takes. The happens-before the waiter needs is
/// the semaphore's: `signal()` is the last thing the staging thread does, and
/// `wait()` the first thing the reader does.
final class ItemHandoff: @unchecked Sendable {
    private let lock = NSLock()
    private let finished = DispatchSemaphore(value: 0)
    /// Cleared by the first terminal callback. Nil means "already claimed".
    private var stage: ((URL, String) throws -> Void)?
    /// Cleared in the same atomic claim as `stage`, and for the same reason:
    /// this is normally the user's own filename, and a handler the provider
    /// keeps forever would otherwise keep that too.
    private var suggestedName: String
    /// Cleared by the waiter that consumes it, for the same reason as `stage`.
    private var outcome: Result<Void, Error>?

    init(suggestedName: String, stage: @escaping (URL, String) throws -> Void) {
        self.suggestedName = suggestedName
        self.stage = stage
    }

    /// Whether the staging closure is still here.
    ///
    /// Internal, and read by one test. "The provider's retained handler holds
    /// nothing that matters" is a property of THIS object, and asserting it
    /// through an object's deallocation instead would be asserting Swift's
    /// lifetime rules — which in a debug build keep a caught error alive to the
    /// end of the enclosing function, whatever this class does.
    var holdsStagingPayload: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stage != nil
    }

    /// Whether a suggested name is still parked here — deliberately *whether*
    /// and not *which*: a diagnostic that answered with the name would put the
    /// user's filename somewhere new, which is the thing being avoided.
    var holdsSuggestedName: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !suggestedName.isEmpty
    }

    var holdsOutcome: Bool {
        lock.lock()
        defer { lock.unlock() }
        return outcome != nil
    }

    /// Runs on whatever thread the provider calls back on, inside its handler.
    ///
    /// The copy happens HERE, synchronously: the representation at `url` is
    /// deleted the instant the handler returns.
    func deliver(_ url: URL?, _ error: Error?) {
        lock.lock()
        guard let stage else { return lock.unlock() }
        // Claimed, both halves at once. A concurrent or later callback now
        // finds nil and does nothing — and it finds it without waiting behind
        // the copy below, because the lock is released first.
        let suggestedName = self.suggestedName
        self.stage = nil
        self.suggestedName = ""
        lock.unlock()

        let result: Result<Void, Error>
        if let url {
            do {
                try stage(url, suggestedName.isEmpty ? url.lastPathComponent : suggestedName)
                result = .success(())
            } catch {
                result = .failure(error)
            }
        } else {
            result = .failure(error ?? SharedDraftError.nothingUsable)
        }

        lock.lock()
        outcome = result
        lock.unlock()
        finished.signal()
    }

    /// Block until the first terminal callback has finished staging, then throw
    /// or return what it decided.
    func wait() throws {
        finished.wait()
        lock.lock()
        let result = outcome
        outcome = nil
        lock.unlock()
        // Nil is unreachable: `signal()` is only ever reached after `outcome`
        // has been stored. It is spelled as a refusal rather than a `!` because
        // the alternative to a wrong answer here is publishing a draft whose
        // bytes were never copied.
        try (result ?? .failure(SharedDraftError.nothingUsable)).get()
    }
}

/// The production loader: the `NSItemProvider`s the share sheet handed over.
///
/// Folder first, then item. A folder shared out of the Files app registers
/// `public.folder`, and asking for `public.item` first would let the system
/// satisfy the request with some other representation of it. Requesting the
/// narrower type when the provider advertises it is what keeps a shared folder a
/// folder.
public struct ItemProviderLoader: SharedDraftItemLoading, @unchecked Sendable {
    /// `public.folder` and `public.item`, spelled rather than imported.
    ///
    /// `UniformTypeIdentifiers` would be a framework this module does not
    /// otherwise need, and these two identifiers are frozen system constants.
    private static let folderType = "public.folder" // nonlocalized: a uniform type identifier
    private static let itemType = "public.item"     // nonlocalized: a uniform type identifier

    private let providers: [ItemRepresentationProviding]

    public init(providers: [NSItemProvider]) {
        self.providers = providers
    }

    /// The seam's initializer. Same loader, a provider a test can make retain
    /// and re-invoke its handler.
    init(items: [ItemRepresentationProviding]) {
        self.providers = items
    }

    public var itemCount: Int { providers.count }

    public func load(_ index: Int, stage: @escaping (URL, String) throws -> Void) throws {
        guard providers.indices.contains(index) else { throw SharedDraftError.nothingUsable }
        let provider = providers[index]
        let type = provider.hasItemConformingToTypeIdentifier(Self.folderType)
            ? Self.folderType : Self.itemType
        guard provider.hasItemConformingToTypeIdentifier(type) else {
            throw SharedDraftError.nothingUsable
        }

        // The handler the provider retains captures this one object and nothing
        // else — no writer, no URL, and once the result is in, no staging
        // closure and no filename either.
        let handoff = ItemHandoff(suggestedName: provider.suggestedName ?? "", stage: stage)
        provider.loadFileRepresentation(ofType: type) { url, error in
            handoff.deliver(url, error)
        }
        // Never on the main thread: `SharedDraftPreparation` runs the whole
        // staging pass off the main actor for exactly this wait.
        try handoff.wait()
    }
}
