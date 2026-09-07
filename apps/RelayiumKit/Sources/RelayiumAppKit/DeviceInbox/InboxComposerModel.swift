import Combine
import Foundation
@preconcurrency import RelayiumKit
import RelayiumShareKit

/// The files a Device Inbox conversation has staged for its next send, and the
/// security scope that makes them readable.
///
/// ## Why this is not `SendSelectionModel`
///
/// That model is the STORED-LINK send: it holds a `CloudUploadModel`, the plan's
/// retention cap, the App Group draft inbox and the photo staging area, and its
/// selection is the thing a link upload is built from. Reusing it here would put
/// one staged batch behind two products — so choosing files to send to a device
/// would clear the batch somebody was about to publish as a link, and a
/// sign-out's isolation of one would silently reach the other. The two are
/// different sends with different security properties, which is the whole reason
/// the segmented control was removed; sharing their selection would rebuild the
/// coupling in the layer underneath it.
///
/// ## Why it is not a `@State` in the conversation view either
///
/// Two lifetimes outlive a redraw, and both are the reason `SendSelectionModel`
/// is app-scoped:
///
///  - **the security scope.** `fileImporter` hands back URLs this app may read
///    only while a scope is open, and that scope has to be released exactly once.
///    `SecurityScopedAccess` is a plain locked class whose `deinit` is the
///    last-resort release; a `@State` holding URLs would leak the scope every
///    time SwiftUI rebuilt the view;
///  - **the account.** A batch chosen under one account must not be sealable to a
///    device belonging to the next one. `observe(_:)` is installed once at app
///    construction, before any view exists, so a sign-out clears the staged batch
///    with no conversation on screen at all.
///
/// ## What it deliberately does not do
///
/// It never sends. `InboxSendModel.send(files:sourceDraftId:token:)` owns the
/// durable plan, the staging copy, the seal and the credential; this only
/// answers *which files*, and hands them over at the moment the user presses
/// Send. It also never retires a shared draft: a device send started from a
/// conversation is chosen with this app's own picker, so no batch here can have
/// come from another app, and `sourceDraftId` is always nil at that call site.
@MainActor
public final class InboxComposerModel: ObservableObject {
    /// The expanded batch, or empty. `@Published` so the composer's Send enables
    /// and disables from the one answer rather than from a count kept beside it.
    @Published public private(set) var files: [SelectedFile] = []
    /// Why a choice was refused, or nil. Cleared by the next choice.
    @Published public private(set) var selectionError: String?
    /// The device the staged batch was chosen for.
    ///
    /// Published and compared, not merely remembered: a batch chosen for one
    /// device must never be sealed to another, and the conversation page can be
    /// reused for a different peer without being torn down — `focusPeer` writes
    /// one value and SwiftUI is free to keep the same view. `stage(for:)` is
    /// what re-aims it, and it discards rather than re-addressing.
    @Published public private(set) var peerID: String?

    private let access: SecurityScopedAccess
    private let store: SelectionStore
    /// The ready account this batch belongs to, or nil. Not `@Published`:
    /// nothing renders an account id and nothing should redraw because one
    /// changed.
    private var accountUserId: String?
    private var sessionObservation: AnyCancellable?
    /// Production staging is account-owned. The opt-out exists only so the
    /// package can exercise the scope lifecycle without a session.
    private let enforcesReadyAccount: Bool

    /// `store` is optional and built HERE when it is nil, rather than being a
    /// defaulted argument.
    ///
    /// Two reasons, and the second is the one that matters. `SelectionStore` is
    /// `@MainActor`, so `= SelectionStore()` as a default argument is a
    /// main-actor call in a nonisolated default expression and does not compile.
    /// And the app must not name the type at all: `IOSSurfaceGuardTests` refuses
    /// `SelectionStore` anywhere under `apps/ios`, because a surface reading the
    /// nested store instead of the model's forwarded state reads a value that
    /// does not publish through a stored property and silently stops redrawing.
    /// Building it in here keeps that ban intact rather than carving an
    /// exception into it for the composition root.
    public init(access: SecurityScopedAccess = SecurityScopedAccess(),
                store: SelectionStore? = nil,
                enforcesReadyAccount: Bool = true) {
        self.access = access
        self.store = store ?? SelectionStore()
        self.enforcesReadyAccount = enforcesReadyAccount
    }

    /// Follow the account. Installed once, at app construction, for the reason
    /// `InboxSendModel.observe` is: a `TabView` may tear an off-screen
    /// destination down, so a sign-out that only reached a mounted view would
    /// leave a batch staged under an account that has gone.
    public func observe<P: Publisher>(_ states: P) where P.Output == SessionState,
                                                         P.Failure == Never {
        sessionObservation = states.sink { [weak self] state in
            self?.adopt(state)
        }
    }

    private func adopt(_ state: SessionState) {
        guard case .ready(let user, _) = state, !user.id.isEmpty else {
            accountUserId = nil
            clear()
            return
        }
        // A DIFFERENT account is an isolation event; the same one republished
        // for an unrelated reason — a usage refresh, a plan change — is not, and
        // clearing on it would drop a batch the user was in the middle of
        // choosing every time their plan was re-read.
        if accountUserId != user.id {
            accountUserId = user.id
            clear()
        }
    }

    /// Point the composer at a device, discarding anything staged for another.
    ///
    /// Idempotent for the same peer, so a redraw does not throw away a batch.
    /// For a different one it CLEARS rather than re-addresses: the user chose
    /// those files while looking at another device's page, and silently
    /// re-aiming them is the one mistake a device send must not make.
    public func stage(for peerID: String) {
        guard self.peerID != peerID else { return }
        clear()
        self.peerID = peerID
    }

    /// Adopt a picker result. The security scope starts here and expansion runs
    /// inside it, exactly as the stored-send flow does it.
    public func chooseFiles(_ result: Result<[URL], Error>) {
        // A picker callback can arrive after sign-out: the session-driven clear
        // ran synchronously, so accepting it would put a hidden batch back into
        // a signed-out model.
        guard !enforcesReadyAccount || accountUserId != nil else { return }
        selectionError = nil
        switch result {
        case .failure(let error):
            clearFiles()
            selectionError = ErrorCopy.message(for: error)
        case .success(let urls):
            guard !urls.isEmpty else { return clearFiles() }
            // The previous batch's scope is released HERE, before the new one is
            // expanded, so nothing can return to files this app can no longer
            // open.
            let roots = access.replace(with: urls)
            store.replace(with: roots)
            if let expanded = store.selection, !expanded.files.isEmpty {
                files = expanded.files
                return
            }
            selectionError = store.error
            access.clear()
            store.clear()
            files = []
        }
    }

    /// Drop the batch and release its scope, keeping the device this composer is
    /// aimed at.
    public func clearFiles() {
        access.clear()
        store.clear()
        files = []
    }

    /// Drop everything, including which device this composer is for.
    public func clear() {
        clearFiles()
        selectionError = nil
        peerID = nil
    }

    /// The batch to hand `InboxSendModel.send`, or nil.
    ///
    /// **The peer is re-asked at the moment of use** rather than trusted from
    /// when the files were chosen. A composer whose page has been reused for a
    /// different device answers nil here, so the send cannot be aimed by a
    /// stale association — the same reasoning
    /// `InboxSendModel.selectedCandidate` applies to sendability.
    public func batch(for peerID: String) -> [SelectedFile]? {
        guard self.peerID == peerID, !files.isEmpty else { return nil }
        return files
    }
}
