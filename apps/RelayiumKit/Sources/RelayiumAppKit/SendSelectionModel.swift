import Combine
import Foundation
import RelayiumKit
import RelayiumShareKit

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

    /// The files named by `summary`, derived from the upload state that owns the
    /// selection rather than mirrored in another published property.
    public var selectedFiles: [SelectedFile] { upload.selectedFiles }

    /// Drafts the iOS share extension has staged and nobody has used yet,
    /// oldest first.
    ///
    /// Published even when signed out, and that is a decision rather than an
    /// oversight: the extension can be used from any app at any time, including
    /// on a device where nobody has signed in, and it tells the user their files
    /// are waiting in Relayium. A Send tab that showed nothing until they signed
    /// in would have made that sentence false.
    @Published public private(set) var sharedDrafts: [SharedDraftSummary] = []
    /// The draft currently occupying the selection, if any.
    ///
    /// Held so it can be handed BACK. An adopted draft has been read out of the
    /// inbox but not yet copied into an account-bound job, so anything that
    /// replaces the selection — Clear, a picker, a photo import, signing out,
    /// switching account — must return it rather than lose it. It is never
    /// silently reassigned to whoever signs in next: it goes back to the inbox
    /// and waits to be chosen again.
    @Published public private(set) var adoptedDraft: SharedDraftSummary?
    /// Why the newest attempt to use a draft was refused, or nil.
    ///
    /// It names the DRAFT as well as the reason, and it has to: the Send tab
    /// renders one card per waiting draft, and a bare reason would be repeated
    /// inside every one of them — so pressing Use on the third draft would put
    /// "sign in first" under all five, as though each had been refused.
    @Published public private(set) var sharedDraftRefusal: SharedDraftRefusalNotice?

    // MARK: - collaborators

    private let upload: CloudUploadModel
    private let access: SecurityScopedAccess
    private let photos: PhotoStagingArea
    private let store: SelectionStore
    /// The App Group inbox, or nil where there is no share extension — macOS,
    /// and any iOS build whose App Group cannot be resolved. Nil means the
    /// shared-draft surface never appears, which is the truthful rendering of
    /// "nothing can arrive here".
    private let drafts: SharedDraftStore?
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
    /// Bumped per inbox read, so an older listing can never publish over a newer
    /// one. Not `@Published`: nothing renders it and nothing should redraw
    /// because a read was superseded.
    private var draftGeneration = 0

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
                drafts: SharedDraftStore? = nil,
                fetchConfig: @escaping @Sendable () async throws -> ServerConfig,
                store: SelectionStore? = nil,
                enforcesReadyAccount: Bool = true) {
        self.upload = upload
        self.access = access
        self.photos = photos
        self.drafts = drafts
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
        let draftStore = drafts
        self.startupSweep = Task.detached(priority: .utility) {
            PhotoStagingArea.sweepOtherLaunches(under: launchRoot.deletingLastPathComponent(),
                                                keeping: launchRoot)
            PhotoInbox.sweepLeftovers(inbox)
            // Complete drafts are NEVER touched here — this removes only a
            // published directory with no plan, and staging an extension the
            // system killed outright left behind. See
            // `SharedDraftStore.sweepIncomplete`.
            draftStore?.sweepIncomplete()
            // And finishes any retirement whose `removeItem` failed in an
            // earlier process. Those drafts are already hidden — the marker is
            // written before the bytes are removed — so this is reclaiming
            // space, not changing what the user is offered.
            draftStore?.retryRetirements()
        }

        // The other half of retirement, and it is installed here rather than
        // observed from a view because the moment it fires is nowhere near a
        // button: a draft is consumed while the upload is running. Weak, so the
        // upload model holding this closure never keeps the send model alive.
        upload.onSourceDraftConsumed = { [weak self] id in
            self?.sharedDraftWasConsumed(id)
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
            returnAdoptedDraft()                    // …and so does a file pick
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
        returnAdoptedDraft()                        // before the first await, like everything here
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

    // MARK: - drafts the share extension left behind

    /// The scene changed phase. The one supported hand-off from the share
    /// extension, and the reason it lives here rather than in a view.
    ///
    /// A Share Extension cannot open its containing app — Apple documents
    /// `NSExtensionContext.open` as the Today and iMessage extension points'
    /// and no others — so the extension publishes its draft, says so, and stops.
    /// What brings it onto this screen is the user opening or returning to
    /// Relayium, which is exactly `.active`. The scene root reports the phase and
    /// nothing else; whether a phase means "re-read the inbox" is decided HERE,
    /// where `swift test` can drive it.
    ///
    /// `.inactive` deliberately does nothing. It is what the system reports while
    /// a document picker or the app switcher is up, and re-reading there would
    /// be a disk scan on the way into the picker, every time.
    public func phaseChanged(to phase: AppLifecyclePhase) {
        guard phase == .active else { return }
        refreshSharedDrafts()
    }

    /// Re-read the App Group inbox.
    ///
    /// Called when the scene becomes active, when the Send surface appears, on
    /// every account event, and after anything that adopts, returns or discards
    /// a draft. It is a pure read: it never adopts, never uploads and never
    /// deletes a complete draft.
    ///
    /// Off the main actor because it stats every staged file of every waiting
    /// draft, and a thousand-file draft would otherwise stall a frame. The
    /// publish is guarded by the account generation, so a listing that lands
    /// after a sign-out repaints nothing.
    public func refreshSharedDrafts() {
        guard let drafts else { return }
        let g = accountGeneration
        draftGeneration += 1
        let d = draftGeneration
        Task { [weak self] in
            let waiting = await Task.detached(priority: .utility) {
                drafts.drafts().map(SharedDraftSummary.init)
            }.value
            // Both generations. The account one catches a sign-out landing
            // during the read; `draftGeneration` catches the ordinary case that
            // happens several times per interaction — Discard refreshes twice
            // (once for the selection it cleared, once after the removal), and
            // two disk reads in flight can finish in either order. Without this
            // the earlier listing could publish last and put a draft the user
            // just deleted back on screen until something else refreshed.
            guard let self, g == self.accountGeneration, d == self.draftGeneration else { return }
            // The adopted one is out of the inbox as far as this surface is
            // concerned: it is already describing the selection, and listing it
            // again would offer the same files twice.
            self.sharedDrafts = waiting.filter { $0.id != self.adoptedDraft?.id }
        }
    }

    /// Use a waiting draft as the current selection. Always the user's own tap.
    ///
    /// Nothing about this is automatic. A draft is never adopted on arrival, on
    /// launch, on sign-in or when the scene becomes active — all of which would
    /// be this app deciding which of several waiting things the user meant, and
    /// the wrong answer overwrites a selection they made by hand.
    public func useSharedDraft(_ id: String) {
        sharedDraftRefusal = nil
        guard let drafts else { return }
        if let refusal = SharedDraftGate.refusal(hasReadyAccount: accountUserId != nil,
                                                 upload: upload.state) {
            // Attached to the draft whose button was pressed. A refusal that
            // named only the reason would be rendered under every card.
            sharedDraftRefusal = SharedDraftRefusalNotice(draftId: id, reason: refusal)
            return
        }
        // Read through the store, so what is adopted is a plan that still
        // validates and staging that still matches it. A draft removed by
        // another process, or damaged, simply disappears from the list.
        guard let plan = drafts.draft(id: id),
              let staged = try? drafts.stagedFiles(for: plan) else {
            selectionError = L10n.t(.errorShareStorageFailed)
            refreshSharedDrafts()
            return
        }
        supersedeImports()
        // Whatever was selected before goes, INCLUDING another draft — which
        // returns to the inbox rather than being lost.
        returnAdoptedDraft()
        access.clear()
        photos.clear()
        store.clear()
        upload.clearSelection()
        selectionError = nil

        // The staged copies, under their manifest names. Hierarchy rides in the
        // name exactly as it does for a picked folder, so the receiving side
        // rebuilds the same tree.
        let files = zip(staged, plan.files).map { stagedFile, plannedFile in
            SelectedFile(url: stagedFile.url, relativePath: stagedFile.name,
                         byteCount: Int64(plannedFile.size))
        }
        upload.sourceDraftId = plan.id
        upload.pick(FileSelection(files: files, emptyDirectories: []))
        guard case .picked = upload.state else {
            // Refused — an item is over this plan's per-file limit. The draft is
            // untouched and goes back to the inbox, because the user may be able
            // to send it after an upgrade, and it is still their only copy of
            // whatever they shared.
            upload.sourceDraftId = nil
            refreshSharedDrafts()
            publishRenderState()
            return
        }
        adoptedDraft = SharedDraftSummary(plan)
        sharedDrafts.removeAll { $0.id == plan.id }
        publishRenderState()
    }

    /// Delete a waiting draft. Destructive, explicit, and the only thing in this
    /// app that removes a complete draft the user has not sent.
    public func discardSharedDraft(_ id: String) {
        guard let drafts, !upload.isBusy else { return }
        sharedDraftRefusal = nil
        if adoptedDraft?.id == id {
            // Its bytes are about to go, so the selection describing them must
            // go first — otherwise Send would be offered for files that are no
            // longer there.
            clear()
        }
        drafts.discard(id: id)
        refreshSharedDrafts()
    }

    /// Hand an adopted draft back to the inbox.
    ///
    /// Adoption never removed it from disk, so "returning" it is exactly this:
    /// stop describing it, stop claiming it as an upload's source, and list it
    /// again. That is what makes leaving an account safe — the draft belongs to
    /// the device, not to whoever happened to be signed in when it arrived, and
    /// it is never silently handed to the next account.
    private func returnAdoptedDraft() {
        guard adoptedDraft != nil else { return }
        adoptedDraft = nil
        upload.sourceDraftId = nil
        refreshSharedDrafts()
    }

    /// The opposite of `returnAdoptedDraft`: the draft is GONE.
    ///
    /// A durable, account-bound job has taken ownership of those files and the
    /// staged copies have been retired, so there is nothing to hand back and
    /// nothing left on disk to describe. Forgetting it here — at the retirement,
    /// not at the next button — is what makes both of the screens the user
    /// reaches afterwards honest: Send another and Discard both return to
    /// `choosing`, and a summary line surviving into either of them would be
    /// describing bytes this process deleted.
    ///
    /// `CloudUploadModel` has already dropped `lastPicked` and `sourceDraftId`
    /// for the same reason, so this is only the render surface.
    private func sharedDraftWasConsumed(_ id: String) {
        // Relaunched recovery retires the source of a job THIS process never
        // adopted — there is no selection to forget, and clearing one would drop
        // whatever the user has since chosen by hand. Only the waiting list can
        // have changed.
        guard adoptedDraft?.id == id else { return refreshSharedDrafts() }
        adoptedDraft = nil
        refreshSharedDrafts()
        publishRenderState()
    }

    /// A durable DEVICE delivery has taken ownership of the current selection.
    ///
    /// The device path's equivalent of `CloudUploadModel.consumeSourceDraft`,
    /// and it exists separately for one structural reason: that method's
    /// authority to delete comes from the pending job the upload model itself
    /// committed, and a device delivery is committed by `InboxSendModel`, which
    /// holds no draft store and no selection. So the send model is told, and it
    /// is told the ACCOUNT as well as the draft.
    ///
    /// **The account check is the whole safety argument.** Retiring a draft
    /// deletes the only copy of files another app handed the user that is not
    /// still inside that app. It is safe only because a durable, account-bound
    /// job now holds those bytes — so a report that arrives after the account
    /// has left is a report about a job this screen no longer has, and it
    /// retires nothing. `InboxSendModel` guards on its own generation before
    /// calling, and this guards again anyway, for the same reason the upload
    /// model's own guard is doubled: the cost of getting it wrong is the user's
    /// files.
    ///
    /// The selection goes with it. It described staged copies that have been
    /// superseded by the durable job — and, for an adopted draft, copies this
    /// call has just deleted — so leaving it on screen would offer Send for
    /// bytes that are gone or a second delivery of bytes already on their way.
    public func deviceSendCommitted(accountId: String, sourceDraftId: String?) {
        guard let accountUserId, accountUserId == accountId else { return }
        if let sourceDraftId, let drafts {
            // Idempotent, and it records the retirement durably before deleting
            // anything — so a failed removal is a copy taking up space, not a
            // draft that comes back around as a second send of the same files.
            if !drafts.retire(id: sourceDraftId) {
                selectionError = L10n.t(.uploadCleanupFailed)
            }
            if adoptedDraft?.id == sourceDraftId { adoptedDraft = nil }
        }
        // Not `clear()`: that hands an adopted draft BACK to the inbox, which is
        // the opposite of what has just happened to it. Everything else it does
        // — superseding an import in flight, releasing the security scopes,
        // deleting the staged photo batch — applies exactly.
        supersedeImports()
        access.clear()
        photos.clear()
        store.clear()
        upload.sourceDraftId = nil
        upload.clearSelection()
        refreshSharedDrafts()
        publishRenderState()
    }

    // MARK: - what the send screen's own buttons mean

    /// "Send another" after a finished upload, and "Try again" after a failed
    /// one. Both are the same transition — back to a state the user can start
    /// from — and what that state IS depends on whether anything is left to
    /// start from, which is `CloudUploadModel`'s to answer.
    ///
    /// It is a method here rather than `upload.reset()` in the view because the
    /// screen is two models' published state and only one of them is being
    /// reset. After a sent shared draft that means an empty screen; after a
    /// failure before the job became durable it means the same draft still
    /// selected, which is what makes Try again retry something.
    public func resetUpload() {
        upload.reset()
        publishRenderState()
    }

    /// "Discard", for the staged job an interrupted upload left behind.
    ///
    /// Destructive, and for a job copied out of a shared draft it is the second
    /// destruction rather than the first: the draft was retired the moment this
    /// job became durable, so discarding it leaves nothing at all — which is
    /// exactly the screen the user must be returned to.
    public func discardPendingUpload() {
        upload.discardPendingJob()
        publishRenderState()
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
        returnAdoptedDraft()
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
        // A draft's files are not in `SelectionStore` — they were never picked
        // or expanded, they were read out of the App Group already flat and
        // already named. So the line describing them is built here, from the
        // same plural the picker path uses, rather than left blank because the
        // store happens to be empty.
        if let adoptedDraft {
            summary = L10n.detail([
                L10n.plural(.selectionFiles, adoptedDraft.fileCount),
                L10n.bytes(Int64(adoptedDraft.totalBytes)),
            ])
            return
        }
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
        let accountChanged = context.userId != accountUserId
        if accountChanged { isolateFromPreviousAccount() }
        accountGeneration += 1
        let g = accountGeneration
        accountUserId = context.userId
        configTask.cancel()                     // an older fetch applies to nobody
        // Every account event, including a sign-out. The inbox belongs to the
        // device rather than to an account, so what is waiting stays visible —
        // and the refusal beside it changes from "use these" to "sign in", which
        // is the truthful thing to say to somebody whose files are sitting here.
        refreshSharedDrafts()
        guard let userId = context.userId else { upload.apply(.unknown); return }
        // A staged job belongs to an account, so the account is what unlocks
        // it. This both tells the upload model who is signed in and offers any
        // job that account left behind — an OFFER: nothing is resumed until the
        // user asks, and `recoverPendingJob` touches no network.
        if accountChanged {
            upload.recoverPendingJob(for: userId)
        } else {
            // Retention/usage refresh for the same account: update limits below,
            // but do not replace a live selection or a finished link with a
            // second recovery scan.
            upload.accountId = userId
        }
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
        // Synchronously, before any await: the staged bytes, the plan and the
        // pending key belong to the account that is leaving. A job still on
        // screen for one runloop turn is a job the next account can see, and
        // one still on disk is one they could resume.
        upload.purgePendingJob()
        supersedeImports()
        // SYNCHRONOUSLY, and this is the half that matters: an adopted draft was
        // never copied into an account-bound job, so it must not follow the user
        // into the next account. It goes back to the inbox — not deleted, not
        // reassigned — and the next person to sign in has to choose it for
        // themselves. `purgePendingJob` above is the opposite case and is
        // correct: bytes already committed to an account leave WITH it.
        sharedDraftRefusal = nil
        returnAdoptedDraft()
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
