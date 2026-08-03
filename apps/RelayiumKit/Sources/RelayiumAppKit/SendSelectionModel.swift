import Combine
import Foundation
import RelayiumKit

/// Holds at most one task and cancels it on replace, on demand, or on release.
///
/// A plain non-isolated class for the same reason `SecurityScopedAccess` and
/// `PhotoStagingArea` are: its `deinit` has to be able to run the cancellation,
/// and a `@MainActor` type's `deinit` cannot safely reach isolated state.
final class CancellableTaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func replace(with new: Task<Void, Never>?) {
        lock.lock()
        let previous = task
        task = new
        lock.unlock()
        previous?.cancel()
    }

    func cancel() { replace(with: nil) }

    deinit { cancel() }
}

/// Everything the send flow owns that is not a view.
///
/// The macOS `UploadPane` keeps its `SelectionStore` as a `@StateObject` and
/// bridges it with `.onChange(of: selection.revision)`. That is defensible on
/// macOS, where nothing is security scoped. Here the bridge *is* the scope
/// lifecycle and the account isolation, so it belongs where `swift test` can
/// reach it — and, more importantly, where it is not at the mercy of when
/// SwiftUI decides to mount or tear down a tab.
///
/// Two lifetimes matter and neither is a view's:
///
///  - **Resources.** A started security scope, a copied photo and a staged batch
///    all outlive any redraw and must be released exactly once. `access` and
///    `photos` are plain locked classes whose `deinit` is the last-resort
///    release.
///  - **The account.** Nothing this model produces — a selection, a staged file,
///    a link, a plan cap or an upload in flight — may survive the account that
///    produced it, and that has to hold with no send screen on screen at all.
///    So the session drives it, through `observe(_:)`, installed once at app
///    construction.
@MainActor
public final class SendSelectionModel: ObservableObject {

    // MARK: - the whole render surface

    /// A nested `ObservableObject` never reaches the parent's subscribers —
    /// `ObservableObject` conformance does not propagate through a stored
    /// property — so what the view renders is forwarded here as this model's own
    /// published state. Relying on `CloudUploadModel` publishing at the same
    /// moment would be a coincidence, and it breaks in exactly the case that
    /// matters: a preparation failure never touches the upload model at all.
    @Published public private(set) var summary: String?
    /// A preparation failure: the importer handed back an error, or
    /// `expandSelection` refused the roots. Deliberately NOT an upload failure —
    /// nothing was ever picked, so `.failed` there would offer a "Try again"
    /// that retries nothing.
    @Published public private(set) var selectionError: String?
    @Published public private(set) var isImportingPhotos: Bool = false
    @Published public private(set) var importError: String?

    // MARK: - collaborators

    private let upload: CloudUploadModel
    private let access: SecurityScopedAccess
    private let photos: PhotoStagingArea
    private let store: SelectionStore
    private let fetchConfig: @Sendable () async throws -> ServerConfig
    /// Production sending is account-owned. The opt-out exists only so the
    /// package can exercise resource ownership independently of a session; the
    /// app-scoped factory keeps the default and installs `observe(_:)` before a
    /// view exists.
    private let enforcesReadyAccount: Bool

    // MARK: - internal isolation state, rendered by nothing

    /// The ready account this model's state belongs to, or nil. Not
    /// `@Published`: nothing renders an account id, and nothing should redraw
    /// because one changed.
    private var accountUserId: String?
    /// Bumped per account event, so a config response for a superseded event
    /// applies nothing.
    private var accountGeneration = 0
    /// Bumped per import intent, so a superseded import discards its own batch
    /// and candidates when it resumes and repaints nothing.
    private var photoGeneration = 0

    private var sessionObservation: AnyCancellable?
    private let configTask = CancellableTaskBox()

    /// The one startup sweep, kept so an import can wait for it.
    ///
    /// It runs off the main actor because it is disk work — deleting a previous
    /// launch's leftovers can mean deleting a multi-gigabyte video, and blocking
    /// app construction on that would stall the first frame. Being off the main
    /// actor makes it *concurrent with* the first import rather than before it,
    /// which is the one way this sweep could still race a live candidate: it
    /// empties the whole inbox, and a candidate that `PhotoInbox.take` had just
    /// created would go with it. So `importPhotos` awaits this before it loads
    /// anything, which restores "the sweep happens before any import can exist"
    /// as an ordering rather than a hope about scheduling.
    private let startupSweep: Task<Void, Never>

    public init(upload: CloudUploadModel,
                access: SecurityScopedAccess = SecurityScopedAccess(),
                photos: PhotoStagingArea = PhotoStagingArea(),
                inbox: URL? = nil,
                fetchConfig: @escaping @Sendable () async throws -> ServerConfig,
                store: SelectionStore? = nil,
                enforcesReadyAccount: Bool = true) {
        self.upload = upload
        self.access = access
        self.photos = photos
        // Constructed in the body rather than as a default argument:
        // `SelectionStore` is `@MainActor`, and a default argument expression is
        // evaluated in a nonisolated context even when the initializer it
        // belongs to is isolated. Making the parameter optional keeps the
        // isolation honest instead of weakening `SelectionStore`'s.
        self.store = store ?? SelectionStore()
        self.fetchConfig = fetchConfig
        self.enforcesReadyAccount = enforcesReadyAccount

        // The ONE sweep, at app-scoped construction, before any import can
        // exist. It is for leftovers from a launch that crashed and nothing
        // else: a runtime sweep would race a provider callback still completing
        // after cancellation and delete a directory about to be filled. The
        // live launch directory is excluded by construction, so a live batch —
        // which is always inside it — can never be caught by this.
        let launchRoot = photos.launchRoot
        self.startupSweep = Task.detached(priority: .utility) {
            PhotoStagingArea.sweepOtherLaunches(under: launchRoot.deletingLastPathComponent(),
                                                keeping: launchRoot)
            PhotoInbox.sweepLeftovers(inbox)
        }
    }

    // MARK: - files

    /// The picker result, and the only caller of `SecurityScopedAccess.replace`.
    ///
    /// The ordering below is the correctness, not a style: the scope starts
    /// before anything enumerates, `lastPicked` is dropped before the new roots
    /// are expanded, and everything runs synchronously so an in-flight import
    /// cannot interleave.
    public func chooseFiles(_ result: Result<[URL], Error>) {
        // A picker callback can arrive after sign-out. The session-driven clear
        // happened synchronously, so accepting that late callback would put a
        // hidden selection back into a logged-out model. Production refuses it;
        // package resource-lifecycle tests can construct a session-independent
        // model explicitly.
        guard !enforcesReadyAccount || accountUserId != nil else { return }
        // An in-flight import does NOT block a file choice: the user asking for
        // files is a newer intent, and the answer is to supersede, not ignore.
        guard !upload.isBusy else { return }
        selectionError = nil
        switch result {
        case let .failure(error):
            // A picker failure is a PREPARATION failure: nothing was picked, so
            // it belongs in `selectionError`, not in the upload model.
            supersedeImports()
            selectionError = ErrorCopy.message(for: error)
        case let .success(urls):
            guard !urls.isEmpty else { clear(); return }
            supersedeImports()
            photos.clear()                          // a file pick replaces a photo batch
            let roots = access.replace(with: urls)  // ── the scope starts HERE
            // The previous list's access is gone, so nothing may return to it.
            // Without this, a refused new selection would leave `reset()` able
            // to hand the user back files this app can no longer open.
            upload.clearSelection()
            store.replace(with: roots)              // expansion runs inside the scope
            if let expanded = store.selection {
                upload.pick(expanded)               // an oversized file fails HERE
                if case .picked = upload.state { publishRenderState(); return }
            } else if let message = store.error {
                selectionError = message            // preparation, not upload
            }
            access.clear()
            store.clear()
        }
        publishRenderState()
    }

    // MARK: - photos

    /// Loads one picked item by index.
    ///
    /// It returns a candidate the STATIC `FileRepresentation` already copied out
    /// of the provider and whose inbox directory that candidate owns. It takes
    /// only an index, because `loadTransferable(type:)` cannot carry per-import
    /// context — which is exactly why the batch is applied here and not there.
    public typealias PhotoCandidateLoading = (_ index: Int) async throws -> PhotoCandidate

    /// Import the items the Photos picker returned, in the user's selection
    /// order.
    ///
    /// Everything that replaces the current selection happens **before the first
    /// `await`**. That is what makes "one failed item leaves nothing selected"
    /// literally true rather than approximately true — including of the file
    /// selection that existed before the import started.
    ///
    /// A second import is deliberately not refused: it bumps the generation, so
    /// the older one discards when it resumes, and the flag stays up because the
    /// newer import owns it.
    public func importPhotos(count: Int, load: @escaping PhotoCandidateLoading) async {
        // The Task wrapping a PhotosPicker callback may not start until after
        // sign-out. Do not recreate hidden, account-owned staging after the
        // synchronous isolation pass already cleared it.
        guard !enforcesReadyAccount || accountUserId != nil else { return }
        guard !upload.isBusy else { return }
        // A defensive path the view never takes: `PhotoPickerChange.decide`
        // turns an empty binding change into `.ignore`, because that change is
        // the view's own reset and clearing there would drop a selection the
        // user never asked to drop.
        guard count > 0 else { supersedeImports(); clear(); return }

        photoGeneration += 1
        let g = photoGeneration
        isImportingPhotos = true                    // THIS import now owns the flag
        importError = nil
        selectionError = nil
        access.clear()
        photos.clear()
        store.clear()
        upload.clearSelection()
        publishRenderState()

        defer {
            // Lowered only by the generation that owns it: a newer import must
            // keep the spinner up rather than have an older one take it down.
            // A superseded import also publishes NOTHING: the newer intent
            // already published its own state, and assigning its summary again
            // would still emit `objectWillChange` despite changing no value.
            if g == photoGeneration {
                isImportingPhotos = false
                publishRenderState()
            }
        }

        // The first await, and it is deliberately this one: the startup sweep
        // empties the whole inbox, so no candidate may be created until it has
        // finished. Everything above ran synchronously, so the selection was
        // already replaced before this point and a supersession that lands
        // during the wait is caught by the generation checks below.
        await startupSweep.value
        // Nothing has been created yet, so a supersession that landed during
        // the sweep costs a batch that is never made rather than one that is
        // made and immediately discarded.
        guard g == photoGeneration, !upload.isBusy else { return }

        let batch: PhotoStagingBatch
        do { batch = try photos.makeBatch() }
        catch {
            if g == photoGeneration { importError = L10n.t(.errorPhotoImportFailed) }
            return
        }

        var staged: [URL] = []
        for index in 0..<count {
            let candidate: PhotoCandidate
            do { candidate = try await load(index) }
            catch {
                photos.discard(batch)
                // A superseded import reports nothing: the failure belongs to a
                // selection the user has already replaced.
                if g == photoGeneration { importError = L10n.t(.errorPhotoImportFailed) }
                return
            }
            guard g == photoGeneration, !upload.isBusy else {
                candidate.discard()                 // it owns its bytes; free them now
                photos.discard(batch)
                return
            }
            do { staged.append(try photos.adopt(candidate, into: batch)) }
            catch {
                candidate.discard()                 // the failed move left it owning
                photos.discard(batch)
                if g == photoGeneration { importError = L10n.t(.errorPhotoImportFailed) }
                return
            }
        }

        guard g == photoGeneration, !upload.isBusy else { photos.discard(batch); return }
        photos.adoptBatch(batch)
        store.replace(with: staged)
        if let expanded = store.selection {
            upload.pick(expanded)
            if case .picked = upload.state { return }
            // The upload model REFUSED this selection — an oversized item. That
            // stays an upload failure, exactly as on the file path, and the
            // resource it refused goes with it: leaving the batch adopted and
            // the store populated would leave a summary line describing bytes
            // nothing can now send, next to a Send button that no longer exists.
            // `lastPicked` was already dropped before the first await, so there
            // is nothing to return to either way.
        } else if let message = store.error {
            // A PREPARATION failure: nothing was ever picked, so it belongs in
            // `selectionError` and not in the upload model.
            selectionError = message
        }
        photos.clear()
        store.clear()
    }

    /// Forget the selection entirely — what "Clear" means on this platform.
    ///
    /// Beyond `CloudUploadModel.clearSelection()` it releases the security
    /// scopes, deletes the staged photo batch and supersedes any import in
    /// flight. Refused mid-upload for the same reason a new selection is: the
    /// bytes on the wire are the ones the current list describes.
    public func clear() {
        guard !upload.isBusy else { return }
        supersedeImports()
        access.clear()
        photos.clear()
        store.clear()
        upload.clearSelection()
        selectionError = nil
        publishRenderState()
    }

    /// A newer intent wins. Bump the generation so every in-flight import
    /// discards its own batch and candidate when it resumes, and take the
    /// visible flag down — the caller is not an import, so nothing newer owns
    /// it.
    private func supersedeImports() {
        photoGeneration += 1
        isImportingPhotos = false
        importError = nil
    }

    private func publishRenderState() {
        summary = store.summaryText(language: nil)
    }

    // MARK: - the account, app-scoped and session-driven

    /// Installed once, at app construction, for this model's whole life.
    ///
    /// `AccountSession` is `@MainActor`, so `$state` only ever fires there. This
    /// `sink` closure is non-`@Sendable` and is formed inside a `@MainActor`
    /// method, so it INHERITS main-actor isolation and runs SYNCHRONOUSLY with
    /// the state write. That is deliberate, and it is deliberately NOT the
    /// `Task { @MainActor in … }` hop `NearbyReceiveModel` uses: that model
    /// defers because it re-reads its sources and `@Published` fires in
    /// `willSet`, whereas this consumes the EMITTED value and never re-reads
    /// `session.state`. A hop here would leave a window in which an
    /// account-owned transfer runs under an account that is already gone —
    /// `testASignOutCancelsAndClearsSynchronouslyWithNoViewInExistence` fails if
    /// anyone adds one, and adding `.receive(on:)` would do the same.
    ///
    /// It takes a publisher rather than the session so a test can drive
    /// transitions through a `CurrentValueSubject` with no network, no keychain
    /// and no view — which is what makes "isolation happens with no `SendView`
    /// in existence" a real assertion rather than a claim.
    public func observe<P: Publisher>(_ states: P)
        where P.Output == SessionState, P.Failure == Never {
        sessionObservation = states
            .map(SendAccountContext.context(for:))
            // A usage refresh that changes nothing the send screen cares about
            // must not re-fetch the size hint.
            .removeDuplicates()
            .sink { [weak self] context in self?.accountContextChanged(context) }
    }

    private func accountContextChanged(_ context: SendAccountContext) {
        // Any change of the ready user's id is an account switch, and so is
        // leaving `.ready` at all.
        if context.userId != accountUserId { isolateFromPreviousAccount() }
        accountGeneration += 1
        let g = accountGeneration
        accountUserId = context.userId
        configTask.cancel()                     // an older fetch applies to nobody
        guard context.userId != nil else { upload.apply(.unknown); return }
        // Retention is known NOW; the size hint is not. The pair is applied
        // twice on purpose: the screen is usable immediately and gets sharper
        // if the advisory fetch lands.
        upload.apply(UploadCaps(retentionSecs: context.retentionSecs, maxFileSize: 0))

        // Snapshotted BEFORE the task is created, and read from the local rather
        // than through `self`. `await self?.fetchConfig()` would keep a strong
        // reference to this model alive for the whole suspension — an
        // authenticated screen's model outliving the screen because a request
        // was slow — and the release test proves this shape does not.
        let fetch = fetchConfig
        // Replaced rather than awaited, so a slow /api/config can never delay a
        // later account event.
        configTask.replace(with: Task { [weak self] in
            guard let config = try? await fetch() else { return }
            // No `Task.isCancelled` check in front of the guards below. It would
            // be strictly redundant — every account event bumps the generation
            // before it cancels, so a cancelled task's `g` can never match the
            // current one — and it would make the guards this design rests on
            // unreachable by any test, because cancellation would always answer
            // first. A fetch that ignores cancellation and lands anyway is the
            // case that has to be refused, and it is refused HERE.
            self?.applyFetchedConfig(config, generation: g, context: context)
        })
    }

    private func applyFetchedConfig(_ config: ServerConfig,
                                    generation g: Int,
                                    context: SendAccountContext) {
        // The generation catches a re-entry into the same account; the id
        // catches everything else — a sign-out, or a switch and back.
        guard g == accountGeneration, accountUserId == context.userId else { return }
        upload.apply(UploadCaps(retentionSecs: context.retentionSecs,
                                maxFileSize: config.maxFileSize))
    }

    /// Cancel FIRST: the upload is authorized by a bearer belonging to the
    /// account being left. If the sign-out revoked it the remaining chunks fail
    /// anyway, but on a screen the user has already left; if it has not been
    /// revoked, letting it run means an account-owned transfer continuing
    /// invisibly and then account A's link sitting on account B's screen.
    /// Neither is acceptable.
    ///
    /// The abandoned chunked-upload session is reclaimed by the server after
    /// `pendingUploadTTL` (`server/account/uploads_resumable.go`). There is no
    /// client `DELETE`, and this does not invent one.
    private func isolateFromPreviousAccount() {
        upload.cancel()
        supersedeImports()
        configTask.cancel()
        access.clear()
        photos.clear()
        store.clear()
        upload.clearSelection()                 // drops lastPicked and any `.done` link
        upload.apply(.unknown)
        selectionError = nil
        publishRenderState()
    }
}
