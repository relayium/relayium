import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// A transfer destination once it has a peer — or is minting the code that will
/// get one.
///
/// One pane, one exit, and one honest statement of what this connection can
/// carry. Rendered by **whichever** transfer destination owns the session, and
/// only by that one: LAN Transfer and Cross-network Transfer share every model
/// underneath, so a pane keyed on model state rather than on ownership would
/// draw one session on two screens, each copy with its own exit.
///
/// ## Why this does not render a composer beside a file transfer
///
/// The temptation, having unified the screen, is to unify the controls too: a
/// message box on top and file actions underneath, live at all times. On the
/// shipped wire that would be a lie. A file transfer and an ephemeral text
/// session are separate signalling generations with separate connections
/// (`docs/protocol/relayium-text-v1.md`), each side ignores the other's, and a
/// peer handed the wrong one waits for a manifest that never arrives. Rendering
/// a composer that cannot send, or a Send button that would tear the
/// conversation down without saying so, is worse than rendering neither.
///
/// So this pane draws the lane the session actually has, and states in one
/// sentence — `workspace.messagesOnlyNote` / `workspace.filesOnlyNote` — that the
/// other kind needs a connection of its own.
///
/// ## What it gained when the screens became connect-first
///
/// A **file send**, inside the session. Nothing is staged before a connection
/// exists any more, so a legacy file lane now opens empty by construction, and a
/// pane that only rendered somebody else's batch would have left the user
/// holding a verified connection with no way to use it. `fileSend` is that
/// missing half and it needs no new wire — `RealtimeSessionModel.sendNow` emits
/// the manifest the peer's `onManifest` is already waiting for. It is still ONE
/// batch, because that is the legacy lane's own limit; many batches on one
/// connection is what `link/1` and `TransferLinkPane` are for.
///
/// **That sentence did not go away when `link/1` shipped; it stopped being
/// universal.** A peer that announced exact `link/1` in the same-network room is
/// rendered by `TransferLinkPane`, where one connection really does carry both
/// lanes and the note is replaced by `link.oneConnectionNote`. Everything this
/// pane still draws — every older Web build, every native client on the shipped
/// wire, the CLI, and a pairing-code peer that did not announce exact `link/1`
/// — genuinely has the limitation, so it keeps saying so.
///
/// ## What it inherited unchanged
///
/// Every terminal boundary the two panes it replaces owned: minting is
/// cancellable in both lanes, a shown code keeps its manifest and its expiry
/// note, a failed batch keeps the file identities that failed, and leaving a
/// conversation with local content asks first.
struct TransferSessionPane: View {
    /// The route of the destination drawing this pane — `.nearby` for LAN
    /// Transfer, `.pairingCode` for Cross-network Transfer.
    ///
    /// Passed in rather than derived from `presence.owner`, because it is what
    /// the release below must be checked AGAINST. Reading the owner and then
    /// releasing it would let this pane give up a session belonging to the other
    /// destination — the exact stale-view bug `TransferPresence.release` refuses
    /// per destination in order to prevent.
    let route: AppDestination
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel

    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var link: LinkWorkspaceModel

    @State private var confirmingLocalTextLeave = false
    @State private var sendError: String?

    private var mode: TransferMode { presence.mode }
    private var modelBusy: Bool { fileModel.isBusy || textModel.isBusy }
    /// A claim alone is not yet a session the user can leave. Once a model has
    /// published any non-idle state, its retained terminal state owns the exit.
    private var hasRetainedSession: Bool {
        fileModel.state != .idle || textModel.state != .idle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            sessionPeer
            if waitingOnJoinedCode {
                waitingForPairingPeer
            } else {
                switch mode {
                case .files: fileLane
                case .text:  textLane
                }
            }
            if peerCapabilityIsKnown { laneNote }
            exit
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
        // A session that ends by any route — Cancel, Done, a failure the user
        // dismissed — returns the surface to the connect phase rather than
        // stranding it on an empty session view.
        .onChange(of: fileModel.state) { state in
            guard mode == .files, state == .idle else { return }
            // A refusal is about the connection that refused. Dropping it with
            // that connection is what stops "nothing was sent" being read
            // beside the send buttons of the next one.
            sendError = nil
            releaseOwner()
        }
        .onChange(of: textModel.state) { state in
            if mode == .text, state == .idle { releaseOwner() }
        }
        .confirmationDialog(
            L10n.t(.textDiscardLocalContentConfirmTitle),
            isPresented: $confirmingLocalTextLeave,
            titleVisibility: .visible
        ) {
            Button(L10n.t(.workspaceLeaveSession), role: .destructive) { leaveSession() }
            Button(L10n.t(.commonCancel), role: .cancel) {
                confirmingLocalTextLeave = false
            }
        } message: {
            Text(L10n.t(.textDiscardLocalContentConfirmBody))
        }
    }

    // MARK: - who

    @ViewBuilder
    private var sessionPeer: some View {
        if let label = presence.sessionPeerLabel {
            VStack(alignment: .leading, spacing: 3) {
                Text(L10n.t(.nearbySessionWith, [L10n.token(label)]))
                    .font(.headline)
                    .accessibilityIdentifier("transfer-session-peer")
                Text(L10n.t(.nearbySessionPeerDisclaimer))
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            // A pairing-code session has no roster label to snapshot, so it says
            // how the peer was reached rather than inventing a name for them.
            Text(L10n.t(.workspaceSessionWithCode))
                .font(.headline)
                .accessibilityIdentifier("transfer-session-peer")
        }
    }

    // MARK: - the file lane

    @ViewBuilder
    private var fileLane: some View {
        switch fileModel.state {
        case .idle:
            // The synchronous claim landed and the async start has not published
            // yet. Nothing to draw, and nothing to claim about it.
            EmptyView()
        case .minting:
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(L10n.t(.directCreatingCode)).controlSize(.small)
                PendingFileList(sessionFiles: fileModel.sessionFiles)
                Button(L10n.t(.commonCancel)) { fileModel.cancel() }
                    .buttonStyle(.bordered)
            }
        case let .showingCode(code, expiresAt):
            VStack(alignment: .leading, spacing: 8) {
                // The picker is gone, but this is the moment the sender is
                // actually handing the code to somebody. Keep the staged
                // manifest visible so they can still verify every name and size
                // before the peer joins.
                PendingFileList(sessionFiles: fileModel.sessionFiles)
                codeHandoff(title: L10n.t(.directGiveCode),
                            code: code,
                            expiresAt: expiresAt,
                            cancel: { fileModel.cancel() })
            }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                // Above the manifest: a long file list pushes the reason below
                // the fold.
                InlineMessage(.failure, message)
                RealtimeFileSessionView(model: fileModel,
                                        onDone: finishCompletedFileTransfer)
            }
        case .joining, .connecting, .verifying, .transferring, .completed:
            // **Either a transfer is happening, or one can be started — never
            // both, and never neither.**
            //
            // `canSendNow` is exactly "cleared and nothing in flight", so the
            // two arms are mutually exclusive by construction rather than by
            // this view's arrangement. The `else` is what makes that worth
            // writing: `RealtimeFileSessionView` renders `.transferring` as a
            // progress bar with a "Starting…" value label, and a connect-first
            // session with nothing chosen yet sits in `.transferring(0, 0)` —
            // the state the wire uses for "cleared, waiting to see whose
            // manifest arrives first". Drawn unconditionally it announces a
            // transfer that has not been asked for, beside the buttons that
            // would ask for one.
            VStack(alignment: .leading, spacing: 8) {
                if fileModel.canSendNow {
                    fileSend
                } else {
                    RealtimeFileSessionView(model: fileModel, onDone: finishCompletedFileTransfer)
                }
                // **Outside the either/or, on purpose.** The refusal this can
                // carry is precisely the one whose cause flipped the branch
                // above: the picker was open while the peer started a transfer,
                // so by the time `send` has an answer the send controls are gone
                // and a message rendered inside them would never be seen. It
                // stays for the rest of the session because the fact does —
                // `canSendNow` does not come back on this connection.
                if let sendError {
                    InlineMessage(.failure, sendError)
                        .accessibilityIdentifier("transfer-session-send-error")
                }
            }
        }
    }

    /// **What a file lane opened before anything was chosen is actually for.**
    ///
    /// This pane used to render a batch and nothing else, because a legacy file
    /// session could only ever have been started by a side that staged first.
    /// The transfer screens do not stage first any more, so without this a
    /// connect-first user reaching a legacy file peer would hold an open,
    /// verified, encrypted connection with no way to put anything on it — a dead
    /// end created by the connect-first change rather than by the wire.
    ///
    /// `RealtimeSessionModel.canSendNow` is the gate and it is the model's, not
    /// a second copy of it: it is false while the handshake is unfinished, while
    /// the SAS is unconfirmed, and while anything is already moving in either
    /// direction. So this appears exactly when a press would really send, and
    /// the two verbs are the same two `TransferLinkPane` offers — a folder is a
    /// different intent from some files, and one combined picker made that
    /// something the user had to discover.
    ///
    /// One batch per session, which is the legacy lane's own limit rather than
    /// this view's: `canSendNow` goes false the moment the manifest is on the
    /// wire and never returns for this connection. `TransferLinkPane` is where
    /// many batches on one connection live.
    ///
    /// The sentence above the verbs is not decoration. This state is also what a
    /// receiver sits in while the other device is still choosing, so the screen
    /// has to say both halves — nothing is moving yet, and either side may be the
    /// one that starts it.
    /// Rendered only from the `canSendNow` arm of `fileLane`, and it does NOT
    /// re-ask: two reads of one answer is two answers as soon as one of them is
    /// edited, and the pair this belongs to is an either/or.
    private var fileSend: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n.t(.workspaceSessionReadyToSend))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("transfer-session-ready")
            HStack(spacing: 8) {
                Button(L10n.t(.linkSendFile)) { send(directories: false) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("transfer-session-send-file")
                Button(L10n.t(.linkSendFolder)) { send(directories: true) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("transfer-session-send-folder")
            }
        }
    }

    // MARK: - the text lane

    @ViewBuilder
    private var textLane: some View {
        switch textModel.state {
        case .idle:
            EmptyView()
        case .minting:
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(L10n.t(.textCreatingCode)).controlSize(.small)
                Button(L10n.t(.commonCancel)) { textModel.reset() }
                    .buttonStyle(.bordered)
            }
        case let .showingCode(code, expiresAt):
            codeHandoff(title: L10n.t(.textGiveCode),
                        code: code,
                        expiresAt: expiresAt,
                        cancel: { textModel.reset() })
        case .failed, .ended, .refused, .unsupported,
             .joining, .connecting, .verifying, .waitingAccept,
             .incomingRequest, .open:
            RealtimeTextSessionView(model: textModel)
        }
    }

    /// **The code, and a link that is the same code and nothing more.**
    ///
    /// The link used to carry `?mode=file` or `?mode=text` beside the code, so a
    /// recipient opening it landed in the lane the sender had chosen. There is no
    /// such choice to preserve any more — one Create action mints one code — and
    /// a hint that named a lane the sender never picked would be the removed
    /// question smuggled back into a URL. The web's own join link is `#c=<code>`
    /// and this is now byte-identical to it.
    ///
    /// `parseAppDeepLink` still READS a mode, because links already passed on
    /// have to keep working.
    private func codeHandoff(title: String,
                             code: String,
                             expiresAt: Int64,
                             cancel: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.subheadline.weight(.semibold))
            SecurityCodeText(code: code, style: .pairing)
            Text(L10n.t(.commonExpires, [
                L10n.date(Date(timeIntervalSince1970: TimeInterval(expiresAt)),
                          dateStyle: .none, timeStyle: .short),
            ]))
                .font(.caption).foregroundStyle(.secondary)
            Text(L10n.t(.pairingCodeExpiryNote))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing-code-expiry-note")
            if let joinURL = transferPairingJoinURL(code: code) {
                PairingCodeHandoffView(url: joinURL, cancel: cancel)
            }
        }
    }

    // MARK: - what this connection carries

    /// Joining watches the unified room before either legacy model starts. Give
    /// that real network wait a visible status and an escape rather than a pane
    /// containing only its heading.
    private var waitingOnJoinedCode: Bool {
        guard case .watching = link.connection else { return false }
        switch mode {
        case .files: return fileModel.state == .idle
        case .text: return textModel.state == .idle
        }
    }

    private var waitingForPairingPeer: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView(L10n.t(.directWaitingForDevice))
                .controlSize(.small)
                .accessibilityIdentifier("transfer-waiting-pairing-peer")
            Button(L10n.t(.commonCancel)) { cancelPairingWatch() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("transfer-cancel-pairing-watch")
        }
    }

    private func cancelPairingWatch() {
        link.leave()
        link.dismiss()
        releaseOwner()
    }

    /// Minting and showing a code happen before there is a peer to classify.
    /// Once the legacy model advances beyond those states, the pairing-room
    /// negotiation has selected this one-lane path; a `link/1` peer is rendered
    /// by `TransferLinkPane` instead.
    private var peerCapabilityIsKnown: Bool {
        switch mode {
        case .files:
            switch fileModel.state {
            case .joining, .connecting, .verifying, .transferring, .completed:
                return true
            case .idle, .minting, .showingCode, .failed:
                return false
            }
        case .text:
            switch textModel.state {
            case .joining, .connecting, .verifying, .waitingAccept,
                 .incomingRequest, .open, .ended, .refused, .unsupported:
                return true
            case .idle, .minting, .showingCode, .failed:
                return false
            }
        }
    }

    /// One sentence, present once a legacy peer is known, naming the lane this
    /// connection does NOT have. It is the bounded honesty of this batch: the
    /// surface is unified, the legacy wire underneath still is not.
    private var laneNote: some View {
        Text(L10n.t(mode == .text ? .workspaceMessagesOnlyNote : .workspaceFilesOnlyNote))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
            .accessibilityIdentifier("transfer-lane-note")
    }

    // MARK: - the exit

    @ViewBuilder
    private var exit: some View {
        if hasRetainedSession && !modelBusy {
            VStack(alignment: .leading, spacing: 4) {
                Button(L10n.t(.workspaceLeaveSession)) { leaveOrConfirm() }
                    // This is not navigation: it tears down the connection,
                    // removes a partial receive, clears text history and drops
                    // the staged selection. Publish that task boundary as a
                    // Button to both sighted and VoiceOver users.
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("transfer-leave-session")
                if mode == .text {
                    // Says so rather than surprising: leaving is the one action
                    // here that discards the local history the terminal view is
                    // still showing.
                    Text(L10n.t(.nearbyLeavingClearsHistory))
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - actions

    /// Pick a batch and put it on THIS connection.
    ///
    /// A local `SelectionStore` for expansion and validation only, exactly as
    /// `TransferLinkPane.pick` uses one: it is not staging, it never outlives
    /// this call, and there is no app-scoped store left for it to write into.
    ///
    /// **The gap this has to survive is the picker itself.** `chooseForLinkSend`
    /// is a modal system panel and the session runs underneath it: the peer can
    /// begin its own transfer, or the connection can end, while the user is
    /// still choosing. The controls that opened it are gone by the time it
    /// returns, so `sendNow`'s answer is the only thing that knows the batch
    /// went nowhere — which is why it is a value here and not a `Void` call. The
    /// batch is not held over: this is a refusal to report, not a queue.
    private func send(directories: Bool) {
        guard let urls = chooseForLinkSend(directories: directories), !urls.isEmpty else { return }
        let store = SelectionStore()
        store.replace(with: urls)
        guard let expanded = store.selection else {
            sendError = store.error ?? L10n.t(.nearbyAddFilesFirst)
            return
        }
        do {
            let staged = try stageRealtimeFiles(expanded.files)
            switch fileModel.sendNow(sources: staged.sources, metas: staged.metas) {
            case .sent:
                sendError = nil
            case .refused(.transferInFlight):
                sendError = L10n.t(.workspaceSendRefusedBusy)
            case .refused(.sessionNotReady):
                sendError = L10n.t(.workspaceSendRefusedUnavailable)
            case .refused(.invalidFileList):
                // The model already named this one in `state`, and the failed
                // lane draws it above the manifest. Saying it twice, in two
                // places, would be two chances to disagree.
                sendError = nil
            }
        } catch {
            sendError = ErrorCopy.message(for: error)
        }
    }

    /// Success closes the task. Nothing app-scoped is left to clear: the batch a
    /// send used was expanded inside `send(directories:)` and belongs to the
    /// connection that carried it.
    private func finishCompletedFileTransfer() {
        fileModel.cancel()
    }

    /// Cancel still discards any partial receive before the surface releases
    /// ownership. A failed file task keeps its own manifest — that is
    /// `RealtimeSessionModel`'s `pendingSend`, retained through the terminal
    /// state — so leaving does not have to preserve anything here.
    private func leaveSession() {
        switch mode {
        case .files: fileModel.cancel()
        case .text:  textModel.reset()
        }
        releaseOwner()
    }

    private func leaveOrConfirm() {
        if mode == .text, textModel.hasLocalContent {
            confirmingLocalTextLeave = true
        } else {
            leaveSession()
        }
    }

    /// Release **this destination's own route**, and only that.
    ///
    /// Never `releaseAll()`, and never `presence.owner`: only the owner may let
    /// go, and naming this pane's own route is what keeps a stale view — one
    /// rebuilt on the other transfer destination while a session is running here
    /// — from blanking a surface that is presenting somebody else's live
    /// session. `TransferPresence.release` refuses a non-owner, so passing the
    /// route rather than the owner turns that refusal into the check.
    private func releaseOwner() {
        presence.release(route)
    }
}
