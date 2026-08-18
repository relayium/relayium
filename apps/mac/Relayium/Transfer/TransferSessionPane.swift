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
    /// The module this pane is drawing — its models, its `link/1` and its
    /// ownership, and no access at all to the other module's.
    ///
    /// **That is what makes this pane's exit scoped.** Every Cancel, Done and
    /// Leave below reaches `module.files` / `module.text` / `module.link`, so
    /// the one thing this screen can end is the connection this screen is
    /// showing. When both destinations drew one shared set of models, "Cancel"
    /// on either of them ended whichever session existed.
    @ObservedObject var module: TransferModule

    /// Mint a REPLACEMENT for a code whose deadline has passed, or nil where
    /// there is no minting to offer.
    ///
    /// Supplied by `CrossNetworkTransferDestination` and by nothing else, which
    /// is the honest shape rather than a defaulted closure: minting reserves
    /// relay capacity billed to an account, so the decision belongs to the
    /// surface that holds the account gate. LAN Transfer draws this pane too and
    /// passes nothing, because there is no such thing as a same-network code to
    /// regenerate.
    var regenerate: (() -> Void)?

    private var fileModel: RealtimeSessionModel { module.files }
    private var textModel: RealtimeTextSessionModel { module.text }
    private var presence: TransferPresence { module.presence }
    private var link: LinkWorkspaceModel { module.link }

    /// The route of the destination drawing this pane — `.nearby` for LAN
    /// Transfer, `.pairingCode` for Cross-network Transfer.
    ///
    /// Taken from the module rather than derived from `presence.owner`, because
    /// it is what every claim here must be checked AGAINST. Reading the owner
    /// and then acting on it would let a stale view move a session that is not
    /// the one it is drawing — the exact bug `TransferPresence` refuses per
    /// destination in order to prevent. The RELEASE side of that rule lives on
    /// the module now, with the idle test it also has to pass.
    private var route: AppDestination { module.route }

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
            // A retained terminal session's only way out stays above the
            // potentially long error/result content. On the minimum window an
            // exit below that content exists in the lazy scroll tree but is not
            // visible, leaving the session owner with no apparent release.
            exit
            if waitingOnJoinedCode {
                waitingForPairingPeer
            } else {
                switch mode {
                case .files: fileLane
                case .text:  textLane
                }
            }
            if peerCapabilityIsKnown { laneNote }
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
            releaseSurfaceIfIdle()
        }
        .onChange(of: textModel.state) { state in
            if mode == .text, state == .idle { releaseSurfaceIfIdle() }
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
                Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
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
                            cancel: { module.cancelPairingCode() })
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
                Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
                    .buttonStyle(.bordered)
            }
        case let .showingCode(code, expiresAt):
            codeHandoff(title: L10n.t(.textGiveCode),
                        code: code,
                        expiresAt: expiresAt,
                        cancel: { module.cancelPairingCode() })
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
    ///
    /// ## The deadline is a countdown, and at zero the code stops being offered
    ///
    /// It used to be one static line — "Expires 14:05" — which is true and is not
    /// the fact a person needs while they are reading six digits down a phone.
    /// There was nothing on screen to distinguish a code that still worked from
    /// one the server had already begun refusing, and the failure is silent on
    /// both ends: this Mac goes on drawing the digits, the other device is told
    /// the code is invalid, and the visible symptom is somebody retyping a
    /// correct code twice.
    ///
    /// `TimelineView(.periodic)` rather than a `Timer` and a `@State`: the view
    /// is a function of the current second, so there is no stored clock to fall
    /// out of step with the deadline, nothing to invalidate when this pane is
    /// torn down, and — the part that matters — the expiry branch is chosen by
    /// the same `PairingCodeExpiry` answer that hides the handoff, so the
    /// countdown and the controls cannot disagree about whether the code is
    /// alive. `PairingCodeExpiryTests` pins that answer on both sides of the
    /// second it changes.
    ///
    /// Everything below the digits is inside the timeline, and the digits are
    /// deliberately outside it: an expired code stays legible, because the person
    /// looking at it is trying to work out whether the number they just read out
    /// was the right one.
    private func codeHandoff(title: String,
                             code: String,
                             expiresAt: Int64,
                             cancel: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.subheadline.weight(.semibold))
            SecurityCodeText(code: code, style: .pairing)
            TimelineView(.periodic(from: .now, by: 1)) { tick in
                let deadline = PairingCodeExpiry.presentation(expiresAt: expiresAt,
                                                              now: tick.date)
                VStack(alignment: .leading, spacing: 12) {
                    if let countdown = deadline.countdown {
                        Text(L10n.t(.pairingCodeExpiresIn, [countdown]))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            // The digits do not reflow as they tick, which is
                            // the one thing a proportional face gets wrong here.
                            .monospacedDigit()
                            // LAST, so the identifier lands on the text element
                            // itself. Placed before `.monospacedDigit()` it went
                            // onto the wrapper that modifier introduces, and the
                            // suite matched an element with an empty label —
                            // present, named, and carrying nothing to read.
                            .accessibilityIdentifier("pairing-code-countdown")
                    }
                    Text(L10n.t(.pairingCodeExpiryNote))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pairing-code-expiry-note")
                    if deadline.isUsable {
                        if let joinURL = transferPairingJoinURL(code: code) {
                            PairingCodeHandoffView(url: joinURL, cancel: cancel)
                        }
                    } else {
                        expiredCode(cancel: cancel)
                    }
                }
            }
        }
    }

    /// **What an expired code offers instead of a link nobody can open.**
    ///
    /// The join URL, the QR and the "waiting for the other device" progress all
    /// go, because every one of them is an invitation to use a code the server
    /// refuses — the QR especially, since scanning it produces an error on a
    /// phone with no explanation anywhere near this screen.
    ///
    /// What replaces them is one press that mints a fresh code, not a route back
    /// to the screen that mints. Sending the user to the connect pane to press
    /// Create would be two steps to recover from a deadline the product chose.
    @ViewBuilder
    private func expiredCode(cancel: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            InlineMessage(.warning, L10n.t(.pairingCodeExpired))
                .accessibilityIdentifier("pairing-code-expired")
            HStack(spacing: 8) {
                // Offered only where it can work. Joining is account-free but
                // MINTING is not — the code's owner is billed for the relay
                // capacity it reserves — so a build with no way to mint renders
                // Cancel alone rather than a button whose only outcome is a
                // trip to the account screen.
                if let regenerate {
                    Button(L10n.t(.pairingNewCode)) { regenerate() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("pairing-code-regenerate")
                }
                Button(L10n.t(.commonCancel), action: cancel)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("pairing-code-expired-cancel")
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
            Button(L10n.t(.commonCancel)) { module.cancelPairingCode() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("transfer-cancel-pairing-watch")
        }
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
    ///
    /// **And, on a pairing code, the route the sentence describes.** The note
    /// tells a file-lane user that a message needs a session of its own and that
    /// leaving this one is how to start it. Once the transfer screens became
    /// connect-first that instruction could not be followed on this platform:
    /// the code was consumed by the file lane, macOS has no other code-minting
    /// call site, and re-pairing reproduced the same file lane every time. So
    /// the action lives HERE, attached to the sentence that promises it, where a
    /// copy change and a surface change cannot drift apart.
    ///
    /// It appears only where the promise can actually be kept — a legacy
    /// fallback that still holds its rendezvous, which is
    /// `LinkWorkspaceModel.handedOverPairing`. A same-network legacy session has
    /// no code to re-enter and is offered nothing rather than a button that
    /// would fail.
    @ViewBuilder
    private var laneNote: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n.t(mode == .text ? .workspaceMessagesOnlyNote : .workspaceFilesOnlyNote))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("transfer-lane-note")
            if mode == .files, let handed = link.handedOverPairing {
                Button(L10n.t(.workspaceStartMessageSession)) {
                    startMessageSession(handed)
                }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("transfer-start-message-session")
                Text(L10n.t(.workspaceStartMessageSessionHint))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
    }

    /// Re-enter the SAME rendezvous as a message session.
    ///
    /// **The order is the correctness, and there are two constraints pulling
    /// against each other.**
    ///
    /// *The surface must never read idle.* `TransferPresence` gives it up the
    /// moment every model does, and `observeSurfaceIdle` turns that release into
    /// closing the handed-over room and clearing this very offer. So the claim is
    /// moved to the message lane FIRST — one owner throughout, never unowned —
    /// and only then is the file lane cleared behind it.
    ///
    /// *The old room must be closed BEFORE the new one is joined.* The first
    /// version of this joined while the handed-over socket was still open, which
    /// put two sockets from this process into one code room. That is not
    /// untidiness: a pairing room holds two peers, so the third socket is either
    /// refused as full or leaves the real peer looking at a roster with two of
    /// us in it, and each extra `/ws?code=` also spends this address's
    /// `wsJoinPerIPPerMinute` budget. `releaseHandedOverPairingRoom` is a no-op
    /// unless the workspace has genuinely let the room go, which after a legacy
    /// fallback it has — and the code was read out of `handed` before it ran, so
    /// clearing the offer takes nothing this call still needs.
    ///
    /// The ROLE is the fallback's own: creating a code offers and joining one
    /// answers, and both ends answering is a session neither dials. It is read
    /// from the model rather than re-derived here, because this surface no
    /// longer knows which verb opened the room.
    private func startMessageSession(_ handed: LinkWorkspaceModel.HandedOverPairing) {
        // Idempotent for the owner, and this route IS the owner: it is drawing
        // the session. It moves the lane the pane renders without ever passing
        // through unowned.
        guard presence.claim(route, mode: .text) else { return }
        sendError = nil
        // The file session and the room it was built on, in that order: the
        // connection first, then the socket underneath it.
        fileModel.cancel()
        link.releaseHandedOverPairingRoom()
        Task {
            await textModel.join(code: handed.code, role: handed.role)
            // The user may have left while the join was in flight. Reclaiming
            // from here would take back a surface they have already given up.
            guard presence.owner == route else { return }
            // Refused before a session existed — an expired or already spent
            // code. There is nothing to put back: the file lane is over, and the
            // truthful place to be is the connect phase, where Create and
            // Connect are on screen. A message lane holding nothing would say
            // this worked.
            if textModel.state == .idle { releaseSurfaceIfIdle() }
        }
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
    ///
    /// Still exactly the lane this pane is drawing, and `startMessageSession` is
    /// why that is worth restating: it moves the pane between the two lanes, and
    /// it clears the one it is leaving SYNCHRONOUSLY, before the join it starts
    /// can be awaited. So there is no interval in which a lane runs that `mode`
    /// does not name, and no second lane for a Leave to strand.
    private func leaveSession() {
        switch mode {
        case .files: fileModel.cancel()
        case .text:  textModel.reset()
        }
        releaseSurfaceIfIdle()
    }

    private func leaveOrConfirm() {
        if mode == .text, textModel.hasLocalContent {
            confirmingLocalTextLeave = true
        } else {
            leaveSession()
        }
    }

    /// Release this destination's own surface — **and only when the whole
    /// MODULE is idle**, not merely the lane this pane happens to be drawing.
    ///
    /// The rule and the reason both live on `TransferModule.retainsWork`, which
    /// is also what the app-scoped liveness observer subscribes to. What used to
    /// be here was a view-local partial check: it released on the lane's own
    /// `.idle` edge, which says nothing about the other lanes. The `link/1`
    /// handoff retires the legacy model rendering a creator's code precisely
    /// BECAUSE a link has already taken over, so that edge would give the
    /// surface up under a live link — `pane` drawing the connect screen for a
    /// module holding a session, `transfer.busyElsewhere` over the top of it,
    /// and no exit anywhere for the link underneath. Whether the removed pane's
    /// `onChange` is delivered at all in that same update pass is SwiftUI's
    /// business and not a contract, which is exactly why the guard belongs on
    /// the module rather than in the timing.
    ///
    /// Still this module's own route and never `releaseAll()`: only the owner
    /// may let go, so a stale view rebuilt on the other destination cannot blank
    /// a surface presenting somebody else's live session.
    private func releaseSurfaceIfIdle() {
        module.releaseSurfaceIfIdle()
    }
}
