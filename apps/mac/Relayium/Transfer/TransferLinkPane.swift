import AppKit
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
/// 4. **The transfers**, newest first, inbound and outbound in one list because
///    the lane numbers them in one space. The transcript above it reads the same
///    way, for the same reason: both only grow, and the entry the user is
///    waiting on must not be the one furthest down.
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
        .frame(maxWidth: Metrics.readingMeasure, alignment: .leading)
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

    /// **A place to write, not a place to fit one line.**
    ///
    /// It was a single-line `TextField` growing to four lines, with Return bound
    /// to Send. Two things were wrong with that and only one of them is size. A
    /// composer on a two-way link is where somebody pastes a command, an address
    /// or a paragraph, and a field that shows one line of it while Return fires
    /// the send makes a multi-line message something you discover you cannot
    /// write by losing one.
    ///
    /// So the keys mean what they mean everywhere else a message is written:
    ///
    ///  - **Return inserts a newline.** `TextEditor` does that natively, and the
    ///    `.defaultAction` shortcut is gone from Send — it was what took Return
    ///    away.
    ///  - **⌘Return sends**, which is the same binding the legacy text session
    ///    already uses, so the two composers in this app do not disagree.
    ///  - **The hint is on screen**, not learned. A shortcut nobody is told about
    ///    is a shortcut for the person who wrote it.
    ///
    /// The height is bounded at both ends: tall enough to write in, capped so a
    /// long draft scrolls inside the editor instead of pushing the transcript,
    /// the transfers and the exit off a 560pt window.
    ///
    /// Enabled before the conversation exists, because pressing Send is what
    /// creates one.
    private var composer: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $draft)
                    .font(.body)
                    // The editor draws its own opaque background, which on the
                    // window background reads as a second surface rather than
                    // as a field.
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: Metrics.composerMinHeight,
                           maxHeight: Metrics.composerMaxHeight)
                    .padding(Metrics.hairline)
                    .accessibilityLabel(L10n.t(.linkComposerLabel))
                    .accessibilityIdentifier("link-composer")
                if draft.isEmpty {
                    // A placeholder, and only that: the editor above already
                    // carries the accessible name, so this is decoration to
                    // VoiceOver and must not be read as a second label.
                    //
                    // Positioned against the editor's own text container rather
                    // than against its frame — `Metrics.textEditorInset` is what
                    // keeps this line from sitting a few points left of the
                    // caret it is standing in for.
                    Text(L10n.t(.linkComposerPlaceholder))
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, Metrics.hairline + Metrics.textEditorInset)
                        .padding(.top, Metrics.hairline)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            // Before the background, so the field's surface is the width of the
            // row rather than of whatever the editor asked for.
            .frame(maxWidth: .infinity)
            .background(Palette.cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: Metrics.corner))
            .overlay(
                RoundedRectangle(cornerRadius: Metrics.corner)
                    .strokeBorder(Palette.cardBorder, lineWidth: 1)
            )

            HStack(spacing: Metrics.tight) {
                Button(L10n.t(.linkSend)) { sendDraft() }
                    .buttonStyle(.borderedProminent)
                    // NOT `.defaultAction`: that is plain Return, and plain
                    // Return belongs to the editor above.
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!link.canCompose || trimmedDraft.isEmpty)
                    .accessibilityIdentifier("link-send-message")
                Text(L10n.t(.composerShortcutHint))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("link-composer-shortcut")
                Spacer(minLength: 0)
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

    /// **Mounted whenever the conversation EXISTS, never gated on what is in
    /// it.**
    ///
    /// This pane observes `LinkWorkspaceModel`. It does not observe
    /// `LinkSessionPresentationModel`, and a nested `ObservableObject` changing
    /// does not invalidate the view that merely holds a reference to it. So a
    /// condition here that read `text.textMessages` was evaluated once, when
    /// something about the LINK last changed, and never again: on a stable link
    /// the peer's messages landed in a model whose only observer —
    /// `LinkTranscriptView` — had never been put on screen, and the transcript
    /// stayed blank until an unrelated link change (a relay warning, a lost
    /// socket, the link failing) happened to rebuild this body. Then every
    /// message appeared at once, which is how the fault was found.
    ///
    /// The repair is the mount, not the condition: the child is the thing that
    /// observes, so the child decides what an empty list looks like. Here that
    /// is an empty `ForEach`, which draws nothing.
    @ViewBuilder
    private var transcript: some View {
        if let text = link.textModel {
            LinkTranscriptView(model: text)
        }
    }

    /// The same rule, for the same reason — see `transcript`.
    ///
    /// `armedFiles` belongs to the observed `link` rather than to the nested
    /// model, so it was never the broken half; it moves down with the batches
    /// anyway, because the two halves of one suppression decision must not live
    /// on opposite sides of an observation boundary.
    @ViewBuilder
    private var transfers: some View {
        if let files = link.fileModel {
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

/// The conversation, **newest first**, with an explicit Copy on every row.
///
/// Two decisions, and the same reason under both: this list only grows.
///
///  - **Newest first.** The message somebody is waiting for was arriving at the
///    bottom of a list that pushes the composer, the transfers and the exit down
///    every time another one lands. The model's array stays chronological — see
///    `LinkSessionPresentationModel.textMessagesNewestFirst`.
///  - **A Copy action, not just selectable text.** Selection is a drag through
///    wrapped monospaced text with no keyboard equivalent that is discoverable
///    here; the legacy text row has had an explicit Copy with a "Copied"
///    acknowledgement for exactly that reason, and the two surfaces must not
///    disagree about how a message is taken out of an ephemeral session. The
///    verbatim, selectable body stays exactly as it was.
struct LinkTranscriptView: View {
    @ObservedObject var model: LinkSessionPresentationModel
    /// Presentation state only, and an id rather than a body: acknowledging the
    /// copy must not put a second copy of ephemeral plaintext in view state.
    /// Same rule, same shape, as `RealtimeTextSessionView.copiedMessageID`.
    @State private var copiedMessageID: Int?

    /// An empty conversation is an empty `ForEach`, and the container stays
    /// mounted around it on purpose.
    ///
    /// It draws nothing either way, so there is no empty state to suppress — and
    /// keeping it means `onChange` below is live for the whole time this view is
    /// on screen. Suppressing the container instead would take the
    /// acknowledgement's own cleanup off screen with it, which is how a "Copied"
    /// belonging to a retired row survives into a conversation that reuses its
    /// id.
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.textMessagesNewestFirst) { message in
                row(message)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // A conversation can be cleared and reopened on the same link, and the
        // ids are the model's. An acknowledgement whose row is gone is an
        // acknowledgement about nothing.
        .onChange(of: model.textMessages) { messages in
            guard let copiedMessageID,
                  !messages.contains(where: { $0.id == copiedMessageID }) else { return }
            self.copiedMessageID = nil
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("link-transcript")
    }

    private func row(_ message: LinkTextMessage) -> some View {
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
            Button {
                copyLinkMessage(message.body)
                copiedMessageID = message.id
            } label: {
                Label(L10n.t(copiedMessageID == message.id ? .commonCopied : .commonCopy),
                      systemImage: copiedMessageID == message.id ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.link)
            // The visible control is compact and its label changes to "Copied",
            // so the accessible name is what keeps the sent/received context.
            .accessibilityLabel(TextMessagePresentation.copyActionLabel(
                outgoing: message.direction == .outgoing,
                copied: copiedMessageID == message.id))
        }
    }
}

/// One clipboard write, shared by the unified transcript's rows.
///
/// A free function beside the view for the reason the legacy pane keeps its own
/// private one: it is two AppKit calls, and a shared helper in `RelayiumAppKit`
/// would put `NSPasteboard` in a module that renders nothing.
@MainActor
private func copyLinkMessage(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}

/// Every batch this link knows about, **newest first**.
///
/// The same rule as the transcript above and for the same reason: this list only
/// grows, so the batch the user just started belongs at the top rather than
/// under every batch they have finished with. The model's array stays in the
/// order the batches became known — see
/// `LinkFilePresentationModel.batchesNewestFirst`.
struct LinkTransferListView: View {
    @ObservedObject var model: LinkFilePresentationModel
    @ObservedObject var link: LinkWorkspaceModel

    /// **The empty state is suppressed HERE, not by the parent.**
    ///
    /// Unlike the transcript this list has a visible heading, so "no batches"
    /// genuinely has to draw nothing rather than draw an empty container. That
    /// decision belongs to this view because this view is the one that observes
    /// `model`: the same test asked from `TransferLinkPane` is answered once and
    /// then never re-asked, and the first batch of a stable link goes unrendered.
    /// See `TransferLinkPane.transcript` for the whole shape of that fault.
    ///
    /// Both halves are the same condition the parent used to hold, with the same
    /// meaning: a batch the lane knows about, or one the user armed and the
    /// verification has not released yet.
    @ViewBuilder
    var body: some View {
        if !model.batches.isEmpty || !link.armedFiles.isEmpty {
            list
        }
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.linkTransfersHeading)).font(.subheadline.weight(.semibold))
            if !link.armedFiles.isEmpty {
                // A batch the lane has not seen. Named as its own state rather
                // than drawn as queued: queued means the lane took it.
                Text(L10n.t(.linkBatchArmed))
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("link-batch-armed")
            }
            ForEach(model.batchesNewestFirst) { batch in
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
