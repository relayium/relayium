import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// The Workspace once it has a peer — or is minting the code that will get one.
///
/// One surface, one exit, and one honest statement of what this connection can
/// carry.
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
/// other kind needs a connection of its own. That sentence is the bounded
/// limitation this batch deliberately did not hide, and it is what the `link/1`
/// integration batch deletes when one link really does carry both lanes.
///
/// ## What it inherited unchanged
///
/// Every terminal boundary the two panes it replaces owned: minting is
/// cancellable in both lanes, a shown code keeps its manifest and its expiry
/// note, a failed batch keeps the file identities that failed, and leaving a
/// conversation with local content asks first.
struct WorkspaceSessionPane: View {
    @ObservedObject var fileModel: RealtimeSessionModel
    @ObservedObject var textModel: RealtimeTextSessionModel
    @ObservedObject var selection: SelectionStore

    @EnvironmentObject private var presence: TransferPresence

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
            switch mode {
            case .files: fileLane
            case .text:  textLane
            }
            laneNote
            exit
        }
        .frame(maxWidth: 720, alignment: .leading)
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
                    .accessibilityIdentifier("workspace-session-peer")
                Text(L10n.t(.nearbySessionPeerDisclaimer))
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            // A pairing-code session has no roster label to snapshot, so it says
            // how the peer was reached rather than inventing a name for them.
            Text(L10n.t(.workspaceSessionWithCode))
                .font(.headline)
                .accessibilityIdentifier("workspace-session-peer")
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
                            mode: .files,
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
                        mode: .text,
                        cancel: { textModel.reset() })
        case .failed, .ended, .refused, .unsupported,
             .joining, .connecting, .verifying, .waitingAccept,
             .incomingRequest, .open:
            RealtimeTextSessionView(model: textModel)
        }
    }

    private func codeHandoff(title: String,
                             code: String,
                             expiresAt: Int64,
                             mode: TransferMode,
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
            if let joinURL = productionPairingJoinURL(code: code, mode: mode) {
                PairingCodeHandoffView(url: joinURL, cancel: cancel)
            }
        }
    }

    // MARK: - what this connection carries

    /// One sentence, always present while a session is, naming the lane this
    /// connection does NOT have. It is the bounded honesty of this batch: the
    /// surface is unified, the wire underneath still is not.
    private var laneNote: some View {
        Text(L10n.t(mode == .text ? .workspaceMessagesOnlyNote : .workspaceFilesOnlyNote))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 720, alignment: .leading)
            .accessibilityIdentifier("workspace-lane-note")
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
                    .accessibilityIdentifier("workspace-leave-session")
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

    /// Release whichever of the two workspace routes actually holds the session.
    ///
    /// Never `releaseAll()`: only the owner may let go, and asking for the owner
    /// by name is what keeps a stale view from blanking a surface that is
    /// presenting somebody else's live session.
    private func releaseOwner() {
        guard let owner = presence.owner,
              AppDestination.macWorkspaceRoutes.contains(owner) else { return }
        presence.release(owner)
    }
}
