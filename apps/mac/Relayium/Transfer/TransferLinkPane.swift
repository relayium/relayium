import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// A transfer destination once it holds a real `link/1`: **one** connection,
/// verified once, carrying an always-visible composer and as many file or folder
/// batches as the user wants.
///
/// ## What this replaces
///
/// `TransferSessionPane` renders the shipped legacy wire, which carries a file
/// transfer *or* an ephemeral conversation and says so in one sentence
/// (`workspace.messagesOnlyNote` / `workspace.filesOnlyNote`). Those notes were
/// the bounded honesty of the surface-convergence batch. They are still correct
/// for a legacy peer and they are still rendered for one; what changes here is
/// that a peer which announced exact `link/1` no longer gets them, because on
/// that connection they are no longer true.
///
/// The two panes never appear together. The owning destination asks
/// `LinkWorkspaceModel.hasSession` through `TransferSurfacePresentation.pane`,
/// and a link session and a legacy session cannot both exist —
/// `LinkWorkspaceModel.shouldAcceptLink` and the legacy
/// `NearbyReceiveModel.shouldAcceptSession` both resolve through the same
/// `TransferPresence` owner.
///
/// ## The order on screen, and why
///
/// 1. **Who, and the verification.** A link that has not been verified renders
///    the digits and nothing else that could send: the gate is the model's
///    (`acceptsWork`), and this is the gate made visible rather than a second
///    copy of it.
/// 2. **The composer, always.** It is the first thing under the peer, it is
///    present from the instant the link opens, and it needs nothing staged.
///    Pressing Send is what opens the conversation, so it is enabled before the
///    peer has consented — the waiting note below it says what is happening.
/// 3. **Send file and Send folder, directly beneath it.** Two verbs rather than
///    one picker, because "a folder" is a different intent from "some files" and
///    the old combined picker made the user discover that a folder was allowed.
/// 4. **The transfers**, in the order they became known, inbound and outbound in
///    one list because the lane numbers them in one space.
/// 5. **The exit**, which is the only thing that ends the link.
struct TransferLinkPane: View {
    @ObservedObject var link: LinkWorkspaceModel

    @State private var draft = ""
    @State private var actionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let message = link.actionError ?? actionError {
                InlineMessage(.failure, message)
                    .accessibilityIdentifier("link-action-error")
            }
            switch link.connection {
            case .idle, .watching:
                // Neither is a session. `watching` in particular is a joined
                // code with no peer yet, and `hasSession` is false for it, so
                // this pane is not on screen: the pairing surface still is, with
                // the code, its QR and its expiry. Named rather than defaulted,
                // so a new case has to be decided here.
                EmptyView()
            case .requesting:
                ProgressView(L10n.t(.linkRequesting)).controlSize(.small)
            case .establishing:
                ProgressView(L10n.t(.linkConnecting)).controlSize(.small)
            case .open:
                liveSurface
            case let .ended(reason):
                ended(reason)
            }
            exit
        }
        .frame(maxWidth: 720, alignment: .leading)
        // A draft the lane never took comes back to the field rather than
        // vanishing. `task(id:)` rather than `onChange`, because the hand-back
        // can happen while this pane is being rebuilt by the state change that
        // caused it.
        .task(id: link.returnedDraft) { restoreReturnedDraft() }
    }

    /// Put a handed-back draft in front of the user again, without overwriting
    /// something they have since typed.
    private func restoreReturnedDraft() {
        guard let returned = link.takeReturnedDraft() else { return }
        guard trimmedDraft.isEmpty else { return }
        draft = returned
    }

    // MARK: - who

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(L10n.t(.linkOpenWith, [L10n.token(link.peerLabel ?? "")]))
                .font(.headline)
                .accessibilityIdentifier("link-session-peer")
            Text(L10n.t(.nearbySessionPeerDisclaimer))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if link.connection.isOpen && !link.isVerificationPending {
                // The claim the whole batch exists to make, and the one sentence
                // that replaces the two one-lane notes.
                Text(L10n.t(.linkOneConnectionNote))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("link-one-connection-note")
            }
            if link.relayExpiringSoon {
                // Said once, while the link still works, so "finish up" is
                // advice the user can act on rather than an explanation after
                // the fact.
                InlineMessage(.warning, L10n.t(.linkRelayExpiringSoon))
                    .accessibilityIdentifier("link-relay-expiring")
            }
            if link.signalingLost {
                // Both halves, in one sentence: this connection is fine, and it
                // cannot be recovered if it stops being fine.
                InlineMessage(.warning, L10n.t(.linkSignalingLost))
                    .accessibilityIdentifier("link-signaling-lost")
            }
        }
    }

    // MARK: - the live link

    @ViewBuilder
    private var liveSurface: some View {
        if let sas = link.sasToCompare {
            verification(sas)
        } else {
            composer
            fileActions
            conversationRequest
            transcript
            transfers
        }
    }

    /// The ONE verification boundary, and it says so.
    ///
    /// Nothing that can send is on screen beside it — not the composer, not the
    /// two file verbs, not an inbound Accept. That is not decoration: the model
    /// refuses all of them while this is pending, and rendering a control whose
    /// press would be swallowed is exactly the shape this pane must not have.
    private func verification(_ sas: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n.t(.linkVerifyTitle)).font(.subheadline.weight(.semibold))
            SecurityCodeText(code: sas, style: .verification)
            Text(L10n.t(.linkVerifyBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !link.armedFiles.isEmpty {
                Text(L10n.t(.linkVerifyHoldingFiles))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("link-holding-files")
            }
            HStack {
                Button(L10n.t(.linkVerifyMatches)) { link.confirmSAS() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("link-verify-matches")
                Button(L10n.t(.linkVerifyDiffers), role: .destructive) { link.rejectSAS() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("link-verify-differs")
            }
        }
    }

    /// Always present on a verified link. Enabled before the conversation
    /// exists, because pressing Send is what creates one.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(L10n.t(.linkComposerPlaceholder), text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("link-composer")
                Button(L10n.t(.linkSend)) { sendDraft() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!link.canCompose || trimmedDraft.isEmpty)
                    .accessibilityIdentifier("link-send-message")
            }
            if link.isWaitingForConversation {
                Text(L10n.t(.linkWaitingForPeer))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("link-waiting-for-peer")
            }
        }
    }

    /// The two file verbs, beneath the composer rather than behind a mode.
    private var fileActions: some View {
        HStack(spacing: 8) {
            Button(L10n.t(.linkSendFile)) { pick(directories: false) }
                .buttonStyle(.bordered)
                .disabled(!link.acceptsWork)
                .accessibilityIdentifier("link-send-file")
            Button(L10n.t(.linkSendFolder)) { pick(directories: true) }
                .buttonStyle(.bordered)
                .disabled(!link.acceptsWork)
                .accessibilityIdentifier("link-send-folder")
        }
    }

    @ViewBuilder
    private var conversationRequest: some View {
        if link.hasIncomingConversationRequest {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n.t(.linkConversationRequest)).font(.subheadline)
                HStack {
                    Button(L10n.t(.linkAcceptMessages)) { link.acceptConversation() }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("link-accept-messages")
                    Button(L10n.t(.linkDeclineMessages)) { link.rejectConversation() }
                        .buttonStyle(.bordered)
                }
            }
        }
    }

    @ViewBuilder
    private var transcript: some View {
        if let text = link.textModel, !text.textMessages.isEmpty {
            LinkTranscriptView(model: text)
        }
    }

    @ViewBuilder
    private var transfers: some View {
        if let files = link.fileModel, !files.batches.isEmpty || !link.armedFiles.isEmpty {
            LinkTransferListView(model: files, link: link)
        }
    }

    // MARK: - terminal

    @ViewBuilder
    private func ended(_ reason: LinkWorkspaceEnding) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            InlineMessage(reason == .closed ? .info : .failure, LinkEndingCopy.text(for: reason))
                .accessibilityIdentifier("link-ended")
            // The transcript and the transfer list outlive the link on purpose:
            // a committed batch's paths and a failed one's manifest are what the
            // user still needs, exactly as the legacy terminal states keep theirs.
            transcript
            transfers
        }
    }

    // MARK: - the exit

    private var exit: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(leaveTitle) { leave() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("link-leave-session")
            Text(L10n.t(.linkHistoryIsLocal))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var leaveTitle: String {
        if case .ended = link.connection { return L10n.t(.commonDone) }
        return L10n.t(.workspaceLeaveSession)
    }

    // MARK: - actions

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func sendDraft() {
        let body = trimmedDraft
        guard !body.isEmpty else { return }
        actionError = nil
        link.send(message: body)
        // Cleared once the model has taken responsibility for it. The model
        // holds an unsent draft itself until the conversation opens and hands it
        // back as `actionError` if the peer refuses, so nothing is silently lost.
        draft = ""
    }

    /// One picker, one batch, sent on the SAME link — no code, no new digits.
    ///
    /// A private `SelectionStore` rather than the destination's shared one: this
    /// batch is
    /// not staging, it is a send the user has already committed to, and writing
    /// it into the shared store would replace a selection they may still want
    /// for a different device.
    private func pick(directories: Bool) {
        guard let urls = chooseForLinkSend(directories: directories), !urls.isEmpty else { return }
        let store = SelectionStore()
        store.replace(with: urls)
        guard let expanded = store.selection else {
            actionError = store.error ?? L10n.t(.nearbyAddFilesFirst)
            return
        }
        do {
            let staged = try stageRealtimeFiles(expanded.files)
            actionError = nil
            link.send(files: staged.metas, sources: staged.sources)
        } catch {
            actionError = ErrorCopy.message(for: error)
        }
    }

    private func leave() {
        if case .ended = link.connection {
            link.dismiss()
        } else {
            link.leave()
        }
    }
}

/// The picker for a batch that is being SENT rather than staged.
///
/// Two entry points rather than one combined panel, because the two verbs above
/// state two different intents and a panel that quietly allowed both would make
/// "Send folder" a lie about what was chosen.
@MainActor
func chooseForLinkSend(directories: Bool) -> [URL]? {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseFiles = !directories
    panel.canChooseDirectories = directories
    panel.prompt = L10n.t(.pickerPrompt)
    guard panel.runModal() == .OK else { return nil }
    return panel.urls
}

/// One terminal reason, in words.
///
/// A free function rather than a computed property on the enum: the enum lives
/// in `RelayiumAppKit`, which deliberately does not render anything, and a
/// message baked in there would be one no view could override.
enum LinkEndingCopy {
    static func text(for reason: LinkWorkspaceEnding) -> String {
        switch reason {
        case .refused: return L10n.t(.linkEndedRefused)
        case .timedOut: return L10n.t(.linkEndedTimedOut)
        case .unavailable: return L10n.t(.linkEndedUnavailable)
        case .failed: return L10n.t(.linkEndedFailed)
        case .closed: return L10n.t(.linkEndedClosed)
        case .verificationRejected: return L10n.t(.linkEndedVerificationRejected)
        case .roomLost: return L10n.t(.linkEndedRoomLost)
        case .relayExpired: return L10n.t(.linkEndedRelayExpired)
        case .roomUnavailable: return L10n.t(.linkEndedRoomUnavailable)
        }
    }
}

/// The conversation, oldest first.
struct LinkTranscriptView: View {
    @ObservedObject var model: LinkSessionPresentationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.textMessages) { message in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: message.direction == .outgoing
                          ? "arrow.up.right" : "arrow.down.left")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    // Verbatim, and never parsed: the body is peer-supplied text
                    // and `Text(verbatim:)` is what stops it being read as
                    // markup.
                    Text(verbatim: message.body)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link-transcript")
    }
}

/// Every batch this link knows about, in the order it became known.
struct LinkTransferListView: View {
    @ObservedObject var model: LinkFilePresentationModel
    @ObservedObject var link: LinkWorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.linkTransfersHeading)).font(.subheadline.weight(.semibold))
            if !link.armedFiles.isEmpty {
                // A batch the lane has not seen. Named as its own state rather
                // than drawn as queued: queued means the lane took it.
                Text(L10n.t(.linkBatchArmed))
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("link-batch-armed")
            }
            ForEach(model.batches) { batch in
                row(batch)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link-transfers")
    }

    @ViewBuilder
    private func row(_ batch: LinkFileBatch) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: batch.direction == .outbound
                      ? "arrow.up.doc" : "arrow.down.doc")
                    .foregroundStyle(.secondary)
                Text(summary(batch)).font(.callout)
                Spacer()
                Text(stateText(batch.state)).font(.caption).foregroundStyle(.secondary)
            }
            if let fraction = batch.fractionCompleted, !batch.isTerminal {
                ProgressView(value: fraction).controlSize(.small)
            }
            if batch.state == .offered {
                HStack {
                    Button(L10n.t(.linkAcceptFiles)) { link.acceptInboundBatch() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!link.acceptsWork)
                        .accessibilityIdentifier("link-accept-files")
                    Button(L10n.t(.linkDeclineFiles)) { link.rejectInboundBatch() }
                        .buttonStyle(.bordered)
                }
            }
            if case .queued = batch.state, batch.direction == .outbound {
                Button(L10n.t(.commonCancel)) { link.cancelQueuedBatch(batch.id) }
                    .buttonStyle(.bordered)
            }
            if case .transferring = batch.state, batch.direction == .outbound {
                Button(L10n.t(.commonCancel)) { link.cancelOutboundBatch() }
                    .buttonStyle(.bordered)
            }
            if let files = batch.receivedFiles, !files.isEmpty {
                // Built by the same function the legacy receive uses, so a
                // foldered link batch reveals and drags as ONE item exactly as a
                // foldered legacy one does.
                ReceivedResultView(payload: receivedPayload(files: files,
                                                            container: batch.receivedContainer))
            }
        }
    }

    /// The manifest, described rather than listed: a folder batch can hold
    /// thousands of entries and a transfer list is not a file browser.
    private func summary(_ batch: LinkFileBatch) -> String {
        let count = L10n.plural(.selectionFiles, batch.files.count)
        guard batch.totalBytes > 0 else { return count }
        return L10n.detail([count, L10n.bytes(Int64(batch.totalBytes))])
    }

    private func stateText(_ state: LinkFileBatchState) -> String {
        switch state {
        case .offered: return L10n.t(.linkBatchOffered)
        case .queued: return L10n.t(.linkBatchQueued)
        case .transferring: return L10n.t(.linkBatchTransferring)
        case .finished: return L10n.t(.linkBatchFinished)
        case .received: return L10n.t(.linkBatchReceived)
        case .failed: return L10n.t(.linkBatchFailed)
        }
    }
}
