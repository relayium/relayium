import Foundation
import RelayiumKit

/// What the iOS Direct tab's file half owns, and it is all lifetime.
///
/// `fileImporter` hands back **security-scoped** URLs. Apple's contract is that
/// every successful `startAccessingSecurityScopedResource()` is balanced by
/// exactly one stop, that the final stop revokes access immediately, and that
/// leaked scopes exhaust a finite per-process resource. That contract cannot
/// live in the view: a `TabView` mounts its tabs lazily and tears an off-screen
/// one down, so a scope started in an `onChange` and stopped in an
/// `onDisappear` has its balance decided by SwiftUI's scheduler — and looking at
/// Account and coming back is enough to move it.
///
/// So this is app-scoped, `SecurityScopedAccess` does the counting (including
/// the `deinit` that is the last-resort release), and the view is left with a
/// summary line, an optional message, and two buttons.
///
/// **Why the scope outlives staging.** `stageRealtimeFiles` opens every chosen
/// file and keeps the descriptor for the life of the batch — that pin is what
/// stops the bytes on the wire being swapped between consent and transmission
/// (see `FileURLSource`). The opens therefore have to happen while the sandbox
/// extension is live. Once they have, the descriptors alone would be enough; the
/// scope is nevertheless held until the selection is cleared, because "held for
/// as long as the user can still see these files listed" is a rule somebody can
/// check, and "released the instant the last descriptor was taken" is a race
/// nobody can.
///
/// It deliberately does **not** hold the staged sources. `RealtimeSessionModel`
/// takes ownership of them in `stageSend`, and a second owner would be a second
/// answer to when the descriptors close — including after the model has
/// deliberately dropped them, which is what `teardown` exists to do.
@MainActor
public final class DirectSendSelection: ObservableObject {

    /// One line describing what is staged, or nil. The whole render surface,
    /// beside `errorMessage`.
    @Published public private(set) var summary: String?
    /// A PREPARATION failure — the picker refused, or the roots could not be
    /// expanded. Deliberately not a session state: nothing was connected, so a
    /// `.failed` session would offer a retry that retries nothing.
    @Published public private(set) var errorMessage: String?

    private let access: SecurityScopedAccess
    private let store: SelectionStore
    private let stage: ([SelectedFile]) throws -> (sources: [PlaintextSource], metas: [FileMeta])

    public init(access: SecurityScopedAccess = SecurityScopedAccess(),
                store: SelectionStore? = nil,
                stage: @escaping ([SelectedFile]) throws
                    -> (sources: [PlaintextSource], metas: [FileMeta]) = { try stageRealtimeFiles($0) }) {
        self.access = access
        // Constructed in the body rather than as a default argument, for the
        // reason `SendSelectionModel` records: `SelectionStore` is `@MainActor`
        // and a default argument expression is evaluated in a nonisolated
        // context even inside an isolated initializer.
        self.store = store ?? SelectionStore()
        self.stage = stage
    }

    public var isEmpty: Bool { store.isEmpty }

    /// The picker result, and the only caller of `SecurityScopedAccess.replace`.
    ///
    /// The order is the correctness: the scope starts before anything
    /// enumerates, and the expansion runs inside it. A refused expansion
    /// releases what it took rather than leaving the app holding extensions for
    /// a selection it is not going to offer.
    public func chooseFiles(_ result: Result<[URL], Error>) {
        errorMessage = nil
        switch result {
        case let .failure(error):
            // The message, and NOTHING else. A picker that failed chose nothing,
            // so it has no claim on a selection the user made earlier — throwing
            // away a staged folder because a later picker errored would cost
            // them the whole choice and tell them only that something went
            // wrong. Same rule `SendSelectionModel.chooseFiles` follows.
            errorMessage = ErrorCopy.message(for: error)
        case let .success(urls):
            guard !urls.isEmpty else { clear(); return }
            let roots = access.replace(with: urls)   // ── the scope starts HERE
            store.replace(with: roots)               // expansion runs inside it
            if store.selection != nil {
                publish()
                return
            }
            errorMessage = store.error ?? L10n.t(.directChooseFilesFirst)
            access.clear()
            store.clear()
        }
        publish()
    }

    /// Forget the selection and release every extension it took.
    ///
    /// Idempotent, because `SecurityScopedAccess.replace`/`clear` track what
    /// they actually started: a second call finds nothing started and stops
    /// nothing. That matters because the view calls this from Clear, from a
    /// session's Done, and from a failure path, and none of them knows about the
    /// others.
    public func clear() {
        access.clear()
        store.clear()
        errorMessage = nil
        publish()
    }

    /// Open every chosen file, inside the live scope, into the descriptor-pinned
    /// sources a realtime batch sends. `nil` means nothing was sent and a
    /// message is on screen.
    ///
    /// Every bound `stageRealtimeFiles` enforces — at most `MAX_FILES`, a
    /// manifest that fits one BATCH frame, every file readable — is answered
    /// here, BEFORE a code is minted or a connection is opened. A selection that
    /// cannot be sent should cost the button, not the session.
    public func stageForSend() -> (sources: [PlaintextSource], metas: [FileMeta])? {
        guard let expanded = store.selection, !expanded.files.isEmpty else {
            errorMessage = store.error ?? L10n.t(.directChooseFilesFirst)
            return nil
        }
        do {
            let staged = try stage(expanded.files)
            errorMessage = nil
            return staged
        } catch {
            errorMessage = ErrorCopy.message(for: error)
            return nil
        }
    }

    private func publish() {
        summary = store.summaryText(language: nil)
    }
}
