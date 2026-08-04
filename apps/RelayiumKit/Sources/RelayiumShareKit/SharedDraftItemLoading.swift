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
    func load(_ index: Int, stage: (URL, String) throws -> Void) throws
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

    private let providers: [NSItemProvider]

    public init(providers: [NSItemProvider]) {
        self.providers = providers
    }

    public var itemCount: Int { providers.count }

    public func load(_ index: Int, stage: (URL, String) throws -> Void) throws {
        guard providers.indices.contains(index) else { throw SharedDraftError.nothingUsable }
        let provider = providers[index]
        let type = provider.hasItemConformingToTypeIdentifier(Self.folderType)
            ? Self.folderType : Self.itemType
        guard provider.hasItemConformingToTypeIdentifier(type) else {
            throw SharedDraftError.nothingUsable
        }

        // `stage` is only ever called before `load` returns, and `load` blocks
        // on the semaphore until the handler has finished — so the escaping
        // closure the handler captures never outlives this call. `withoutActuallyEscaping`
        // is what states that to the compiler instead of forcing every caller to
        // hand over an `@escaping` closure it would then have to reason about.
        try withoutActuallyEscaping(stage) { stage in
            var outcome: Result<Void, Error> = .failure(SharedDraftError.nothingUsable)
            let finished = DispatchSemaphore(value: 0)
            let suggested = provider.suggestedName ?? ""
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                // The copy happens HERE, synchronously, inside the callback.
                // The representation at `url` is deleted the instant this
                // closure returns.
                defer { finished.signal() }
                guard let url else {
                    outcome = .failure(error ?? SharedDraftError.nothingUsable)
                    return
                }
                do {
                    try stage(url, suggested.isEmpty ? url.lastPathComponent : suggested)
                    outcome = .success(())
                } catch {
                    outcome = .failure(error)
                }
            }
            // Never on the main thread: `SharedDraftPreparation` runs the whole
            // staging pass off the main actor for exactly this wait.
            finished.wait()
            try outcome.get()
        }
    }
}
