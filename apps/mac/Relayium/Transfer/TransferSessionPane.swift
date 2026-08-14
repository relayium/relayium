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
    @ObservedObject var selection: SelectionStore

    @EnvironmentObject private var presence: TransferPresence
    @EnvironmentObject private var link: LinkWorkspaceModel

    @State private var confirmingLocalTextLeave = false

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
            if mode == .files, state == .idle { releaseOwner() }
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
            RealtimeFileSessionView(model: fileModel, onDone: finishCompletedFileTransfer)
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
            if let joinURL = productionPairingJoinURL(code: code) {
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

    /// Success closes the task without leaving its already-sent batch armed for
    /// another device. Receiving preserves an independent outbound selection;
    /// failures never reach this action and therefore remain ready to retry.
    private func finishCompletedFileTransfer() {
        if fileModel.received == nil { selection.clear() }
        fileModel.cancel()
    }

    /// A failed file task returns to the connect phase with its batch ready to
    /// retry. Completed work and text exits start fresh; cancel still discards
    /// any partial receive before the surface releases ownership.
    private func leaveSession() {
        let preservesFailedFiles: Bool
        if mode == .files, case .failed = fileModel.state {
            preservesFailedFiles = true
        } else {
            preservesFailedFiles = false
        }
        switch mode {
        case .files: fileModel.cancel()
        case .text:  textModel.reset()
        }
        if !preservesFailedFiles { selection.clear() }
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
