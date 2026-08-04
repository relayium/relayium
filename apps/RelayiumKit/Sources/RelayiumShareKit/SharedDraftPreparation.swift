import Foundation

/// What the share extension can ask of the process hosting it.
///
/// Two calls, and both belong to `NSExtensionContext`, which is why they are
/// behind a protocol: the model below is the whole of the extension's behaviour
/// and it has to be drivable under `swift test`, where there is no host, no
/// share sheet and no `extensionContext` at all.
///
/// **There is deliberately no "open the containing app" call here.** Apple
/// documents `NSExtensionContext.open(_:completionHandler:)` as supported by the
/// Today and iMessage extension points on iOS; a Share Extension is neither, and
/// the App Extension Programming Guide is explicit that a widget is the one
/// extension type that may open its containing app. The call compiles from a
/// Share Extension and is not a supported hand-off, so this extension does not
/// make it. What it does instead is finish the copy, say so, and let the user
/// open Relayium — which is the mechanism Apple actually supports, and which is
/// why `SendSelectionModel.refreshSharedDrafts` runs on scene activation.
@MainActor
public protocol SharedDraftHost: AnyObject {
    /// `completeRequest(returningItems:completionHandler:)`. The extension
    /// returns nothing to the host app it was invoked from: what it produced is
    /// a draft in the App Group, not an item for the sharing app to receive.
    func finish()
    /// `cancelRequest(withError:)`. The user asked for nothing to happen.
    func cancelled()
}

/// Everything the share extension does, with no view and no UIKit.
///
/// The extension's entire job is: copy what was shared into the App Group, tell
/// the user it was copied and that nothing has been uploaded, and stop. It has
/// no network, no bearer, no Keychain access and no content key, and it
/// generates none of those — which is what makes the process boundary a security
/// property rather than a layering preference.
///
/// **Nothing happens until the user asks.** Construction reads how many items
/// there are and stops. Copying starts on `start()`, because a share sheet that
/// begins duplicating a 4 GB video the instant it opens is a share sheet that
/// costs the user a gigabyte for a swipe they meant to undo.
@MainActor
public final class SharedDraftPreparation: ObservableObject {
    public enum Stage: Equatable {
        /// Waiting for the user. Nothing has been copied.
        case ready
        /// Copying. `staged` counts files finished so far; the total is unknown
        /// until a shared folder has been walked, which is why the label this
        /// drives states progress rather than a percentage it cannot compute.
        case copying(staged: Int)
        /// The draft is published, complete and durable, and NOTHING has been
        /// uploaded. The terminal success state: the sheet says where the files
        /// are and what to do next, and one Done completes the host request.
        case published
        /// Nothing was published, and nothing was left behind.
        case failed(String)
    }

    @Published public private(set) var stage: Stage = .ready
    /// How many ITEMS the share sheet handed over — providers, not files.
    ///
    /// The distinction matters on this screen: one shared folder is one item and
    /// may be a thousand files, so rendering this as a file count would be a
    /// number the extension has not measured and cannot yet know. The copying
    /// label counts staged FILES, which is measured, and it climbs past this
    /// number for a folder rather than contradicting it.
    ///
    /// It is also deliberately the only thing about the share this screen
    /// states: the extension does not list the user's file names back at them,
    /// and it never puts one in a log or on the pasteboard.
    public let itemCount: Int

    private let store: SharedDraftStore
    private let loader: SharedDraftItemLoading
    private weak var host: SharedDraftHost?
    private var writer: SharedDraftWriter?
    private var work: Task<Void, Never>?
    /// The user asked for nothing to happen.
    ///
    /// Separate from `work` and from the writer's own flag, and it has to be:
    /// the writer is created INSIDE the staging pass and only becomes reachable
    /// from here one main-actor hop later, so a Cancel landing in that window
    /// would find `writer == nil` and reach nothing at all. Cancelling `work`
    /// does not help either — the staging pass is a `Task.detached`, which is
    /// not a child and does not inherit cancellation, and its copy loop runs
    /// inside a provider callback where `Task.isCancelled` is false regardless.
    ///
    /// So this is the flag that survives that window: `hold` applies it to the
    /// writer the moment the writer exists, and `finished` refuses to act on a
    /// result the user has already cancelled. It is also what makes cancelling
    /// idempotent — one host cancellation, whether the button is pressed once,
    /// twice, or once followed by the sheet being swiped away.
    private var cancelled = false

    public init(store: SharedDraftStore, loader: SharedDraftItemLoading, host: SharedDraftHost?) {
        self.store = store
        self.loader = loader
        self.host = host
        self.itemCount = loader.itemCount
    }

    /// Bytes are being copied right now, and this object owns them.
    ///
    /// False once cancelled, which is what makes the host's teardown path
    /// idempotent: the sheet being dismissed after Cancel must not cancel the
    /// request a second time. Also false at `.published`, where the draft is
    /// durable and the only thing left is the user pressing Done.
    public var isStaging: Bool {
        guard !cancelled, case .copying = stage else { return false }
        return true
    }

    /// Copy and publish. The user pressed Continue.
    public func start() {
        guard case .ready = stage, !cancelled else { return }
        guard itemCount > 0 else {
            stage = .failed(SharedDraftCopy.message(for: SharedDraftError.nothingUsable))
            return
        }
        stage = .copying(staged: 0)
        let store = self.store
        let loader = self.loader
        work = Task { [weak self] in
            // Off the main actor for the whole staging pass. The provider
            // callbacks are waited on with a semaphore — that is the only way to
            // copy the bytes before the representation is deleted — and doing it
            // on the main actor would block the extension's own UI while it
            // copied gigabytes.
            let outcome = await Task.detached(priority: .userInitiated) { () -> Result<SharedDraftPlan, Error> in
                do {
                    let writer = try store.beginDraft()
                    await self?.hold(writer)
                    do {
                        for index in 0..<loader.itemCount {
                            try loader.load(index) { url, suggested in
                                try writer.adopt(url, suggestedName: suggested)
                            }
                            let staged = writer.stagedCount
                            await self?.report(staged: staged)
                        }
                        return .success(try writer.publish())
                    } catch {
                        // A preparation that died part-way is bytes with nothing
                        // to describe them. Remove them HERE, on the context
                        // that owns the copy — this is also the only place a
                        // cancellation's bytes are abandoned, because the main
                        // actor must never wait on a copy to release them.
                        writer.abandon()
                        return .failure(error)
                    }
                } catch {
                    return .failure(error)
                }
            }.value
            // No `await`: this Task inherits `start()`'s main-actor isolation,
            // and only the detached staging pass above leaves it.
            self?.finished(outcome)
        }
    }

    /// The user backed out. Nothing is published and nothing is left behind.
    ///
    /// **It returns immediately, whatever is being copied.** It signals, and it
    /// does not wait: `SharedDraftWriter.cancel` takes a lock of its own and
    /// touches no file, and the abandonment of whatever has been copied so far
    /// happens on the staging pass once it observes the flag. Deleting the
    /// staging directory from here would mean the main actor removing bytes an
    /// in-flight copy still owns — and doing it under the writer's lock, which a
    /// copy holds from its first byte to its last, would freeze the button until
    /// a 4 GB video had finished copying.
    ///
    /// Idempotent: the host is cancelled exactly once, however many times the
    /// user presses Cancel and however the sheet is then torn down.
    public func cancel() {
        guard !cancelled else { return }
        // FIRST, and synchronously: this is the only signal that reaches a
        // staging pass whose writer has not been handed back yet.
        cancelled = true
        work?.cancel()
        // The writer's own flag, not the task: the copy loop runs inside a
        // provider callback with no task context, so `Task.cancel()` alone would
        // not reach it.
        writer?.cancel()
        writer = nil
        host?.cancelled()
    }

    /// The user read the success state and pressed Done. The draft stays; the
    /// host request completes.
    public func done() {
        guard case .published = stage else { return }
        host?.finish()
    }

    // MARK: - main-actor transitions

    /// The staging pass hands its writer over before copying anything.
    ///
    /// This runs on the main actor, and it is the ONLY place the writer becomes
    /// reachable — so the ordering against `cancel()` is total. Either Cancel
    /// arrived first and is applied here, before a byte is copied, or it arrives
    /// later and reaches the writer directly.
    ///
    /// Note what it does NOT do in the cancelled case: abandon. The staging pass
    /// is one line away from its first `adopt`, that `adopt` will throw at the
    /// flag set here, and the pass's own `catch` removes the directory on its
    /// own context. The main actor never touches the filesystem for a draft.
    private func hold(_ writer: SharedDraftWriter) {
        guard !cancelled else { return writer.cancel() }
        self.writer = writer
    }

    private func report(staged: Int) {
        guard !cancelled, case .copying = stage else { return }
        stage = .copying(staged: staged)
    }

    private func finished(_ outcome: Result<SharedDraftPlan, Error>) {
        writer = nil
        // The last line of defence for the same window `hold` covers: if a
        // preparation was already past its final `checkCancelled` when Cancel
        // landed, it can still have published. The user asked for nothing to
        // happen, so the draft goes rather than sitting in the inbox as work
        // they explicitly refused — and the stage is not touched, so a cancelled
        // sheet never repaints as success on its way out.
        guard !cancelled else {
            if case let .success(plan) = outcome { store.retire(id: plan.id) }
            return
        }
        switch outcome {
        case .failure(let error):
            stage = .failed(SharedDraftCopy.message(for: error))
        case .success:
            // Complete and durable from here on, whatever happens to this
            // process. The host request is NOT completed yet: the sheet stays up
            // saying where the files are and that nothing was uploaded, and Done
            // is the user acknowledging it.
            stage = .published
        }
    }
}
