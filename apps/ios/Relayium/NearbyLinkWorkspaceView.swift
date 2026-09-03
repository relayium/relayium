import SwiftUI
import UniformTypeIdentifiers
import RelayiumAppKit
import RelayiumKit

/// **The Nearby tab once it holds a real `link/1`**: one connection, verified
/// once, carrying a conversation and as many file or folder batches as the user
/// wants — in either direction, at the same time.
///
/// ## What it replaces on this platform
///
/// iOS Nearby shipped with the legacy wire's shape: pick Files or Text, stage a
/// batch, connect, and get a session that can do exactly the one thing you chose
/// before you had a peer. For a peer that announced exact `link/1` none of that
/// is true any more, so none of it is on screen: no lane, no picker, no mode,
/// and no reason to disconnect between two sends.
///
/// ## Why it is written rather than ported
///
/// macOS has `TransferLinkPane` and this view is deliberately not a copy of it.
/// That pane answers macOS's questions — a `TextEditor` bounded to fit a 560pt
/// window, ⌘Return to send while Return inserts a newline, two `NSOpenPanel`
/// verbs because a panel has to be told whether it is opening files or folders,
/// `.bordered` buttons side by side in an `HStack`. Every one of those is the
/// wrong answer here:
///
///  - **One file verb, not two.** iOS's document browser offers folders inside
///    the same sheet, so `[.item, .folder]` on a single `fileImporter` is one
///    tap where macOS needs the user to have chosen the right verb first.
///  - **A `TextField(axis: .vertical)` growing 2…6 lines**, matching
///    `DirectTextSessionView`'s composer exactly, because a person who has used
///    one message surface in this app should not meet a second one.
///  - **Full-width `.controlSize(.large)` buttons stacked**, not a row: at the
///    largest Dynamic Type sizes an `HStack` of two buttons truncates both, and
///    44pt is a floor a finger has.
///  - **One `ScrollView`, the tab's own.** Everything here is `LazyVStack`
///    inside it; a nested scroller on a phone is a region the user cannot
///    reliably scroll past.
///
/// What the two DO share is the model: `LinkWorkspaceModel` makes every
/// decision. The words come from `LinkEndingCopy`/`LinkBatchCopy` in that same
/// module rather than from a switch written here, so a tenth ending or a seventh
/// batch state has one place on this platform to be answered. `TransferLinkPane`
/// still carries its own copy of those switches; converging it is a macOS edit
/// and is recorded as the follow-up rather than taken in an iOS batch.
///
/// ## The order on screen, and why
///
/// 1. **Who, and the verification.** While the digits are unanswered nothing
///    that could send is drawn — not the composer, not the file verb, not an
///    inbound Accept. The model refuses all of them (`acceptsWork`), and a
///    control whose press would be swallowed is the shape this app forbids.
/// 2. **The conversation, then the composer.** Reading order: the messages are
///    what you came back to, and the field is under them where the keyboard
///    will be.
/// 3. **The files**, inbound and outbound in one list, because the lane numbers
///    them in one space.
/// 4. **The exit**, which is the only thing on screen that ends the link.
struct NearbyLinkWorkspaceView: View {
    @ObservedObject var link: LinkWorkspaceModel
    /// The picker for sends made INSIDE the workspace, and a second selection
    /// owner on purpose — see `RelayiumApp`. It is app-scoped, so the security
    /// scopes it starts are balanced by `SecurityScopedAccess` rather than by
    /// this view's lifetime, which `TabView` decides.
    @ObservedObject var selection: DirectSendSelection

    @State private var draft = ""
    @State private var isChoosingFiles = false
    @State private var actionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.section) {
            header
            if let message = link.actionError ?? actionError {
                failureLine(message)
            }
            switch link.connection {
            case .idle, .watching:
                // Neither is a session, and `hasSession` is false for both, so
                // this view is not on screen for either. Named rather than
                // defaulted: a new case has to state its answer here.
                //
                // `watching` is additionally unreachable on this platform —
                // iOS composes no pairing-code link at all.
                EmptyView()
            case .requesting:
                ProgressView { Text(L10n.t(.linkRequesting)) }
            case .establishing:
                ProgressView { Text(L10n.t(.linkConnecting)) }
            case .open:
                liveSurface
            case let .ended(reason):
                ended(reason)
            }
            exit
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // `[.item, .folder]`, one sheet: a folder is choosable here and its
        // contents are expanded inside the security scope `DirectSendSelection`
        // starts before anything enumerates them.
        .fileImporter(isPresented: $isChoosingFiles,
                      allowedContentTypes: [.item, .folder],
                      allowsMultipleSelection: true) { result in
            sendChosen(result)
        }
        // A draft the lane never took comes back to the field rather than
        // vanishing. `task(id:)` rather than `onChange`, because the hand-back
        // can happen while this view is being rebuilt by the very state change
        // that caused it.
        .task(id: link.returnedDraft) { restoreReturnedDraft() }
    }

    // MARK: - who

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(L10n.t(.linkOpenWith, [L10n.token(link.peerLabel ?? "")]))
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            // The same disclaimer the legacy session header carries: a peer's
            // name is peer-supplied and is never identity.
            Text(L10n.t(.nearbySessionPeerDisclaimer))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if link.connection.isOpen && !link.isVerificationPending {
                Text(L10n.t(.linkOneConnectionNote))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if link.relayExpiringSoon {
                // Unreachable today: a code-less link is built from STUN-only
                // servers, so it allocates no relay and has no credential
                // lifetime. Rendered anyway rather than asserted away — the
                // model owns the fact, and a surface that silently dropped it
                // would be the one place a future relayed iOS link went quiet.
                InlineMessage(.warning, L10n.t(.linkRelayExpiringSoon))
            }
            if link.signalingLost {
                // Both halves in one sentence: this connection is fine, and it
                // cannot be recovered if it stops being fine. The iOS wording,
                // because the shipped one names a Mac.
                InlineMessage(.warning, LinkEndingCopy.signalingLost)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - the live link

    @ViewBuilder
    private var liveSurface: some View {
        if let sas = link.sasToCompare {
            verification(sas)
        } else {
            conversation
            fileSend
            transfers
        }
    }

    /// The ONE verification boundary for the whole link, and it says so.
    ///
    /// Every later message and every later batch crosses it without asking
    /// again — which is the claim the copy makes and the model actually keeps.
    private func verification(_ sas: String) -> some View {
        SectionCard(L10n.t(.linkVerifyTitle)) {
            PairingCodeText(code: sas, style: .verification)
            Text(L10n.t(.linkVerifyBody))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !link.armedFiles.isEmpty {
                // The batch the user staged before Connect. Named while it is
                // being held, because "staged and not sent" is the one thing
                // they cannot see from the screen otherwise.
                Text(L10n.t(.linkVerifyHoldingFiles))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(L10n.t(.linkVerifyMatches)) { link.confirmSAS() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
            Button(L10n.t(.linkVerifyDiffers), role: .destructive) { link.rejectSAS() }
                .borderedAction(.destructive)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
        }
    }

    /// The transcript and the composer in one card, in that order.
    ///
    /// The composer is enabled before the peer has consented to a conversation,
    /// because pressing Send is what OPENS one — a field disabled until consent
    /// would be a field nobody could ever use. The waiting note under it says
    /// what is happening in the meantime.
    private var conversation: some View {
        SectionCard(L10n.t(.linkConversationHeading)) {
            if let text = link.textModel, !text.textMessages.isEmpty {
                transcript(text)
            } else {
                Text(L10n.t(.linkConversationEmpty))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            composer
            if link.isWaitingForConversation {
                Text(L10n.t(.linkWaitingForPeer))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(L10n.t(.linkHistoryIsLocal))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A `LazyVStack` inside the tab's own `ScrollView`, never a second
    /// scroller: two scroll regions on a phone is something the user cannot
    /// reliably get past, and at the largest content sizes an inner one with a
    /// fixed height shows about a line and a half.
    private func transcript(_ text: LinkSessionPresentationModel) -> some View {
        LazyVStack(alignment: .leading, spacing: Metrics.tight) {
            ForEach(text.textMessages) { message in
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    Text(L10n.t(message.direction == .outgoing ? .textSent : .textReceived))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    // Verbatim, and never parsed: the body is peer-supplied
                    // text, and `Text(verbatim:)` is what stops it being read
                    // as markup.
                    Text(verbatim: message.body)
                        .font(.body.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Metrics.tight)
                .background(.quaternary.opacity(0.35),
                            in: RoundedRectangle(cornerRadius: Metrics.corner,
                                                 style: .continuous))
                // One element per message, so VoiceOver reads "Sent, <body>"
                // rather than stopping on the direction label alone.
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L10n.t(.linkA11yConversation))
    }

    /// The same composer shape as `DirectTextSessionView`, deliberately.
    ///
    /// A person who has written a message on the Direct tab should meet the
    /// same field here: `TextField(axis: .vertical)` growing 2…6 lines, Send
    /// beside it. No keyboard shortcut — macOS binds ⌘Return because it has a
    /// hardware Return key competing with the editor, and iOS does not have
    /// that problem.
    private var composer: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            TextField(L10n.t(.linkComposerPlaceholder), text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...6)
                .accessibilityLabel(L10n.t(.linkComposerLabel))
            Button { sendDraft() } label: {
                Text(L10n.t(.linkSend)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!link.canCompose || trimmedDraft.isEmpty)
        }
    }

    /// One verb, one sheet, one batch — sent on the SAME link. No new
    /// connection, no new digits.
    private var fileSend: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Button { isChoosingFiles = true } label: {
                Text(L10n.t(.linkSendFilesOrFolders)).frame(maxWidth: .infinity)
            }
            .borderedAction()
            .controlSize(.large)
            .disabled(!link.acceptsWork)
            // Where an accepted inbound batch lands. iOS has no folder picker
            // for a download, so the destination is fixed and is named rather
            // than discovered by finding a file.
            Text(L10n.t(.linkSavedToAppFolder))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - the transfers

    @ViewBuilder
    private var transfers: some View {
        if let files = link.fileModel, !files.batches.isEmpty || !link.armedFiles.isEmpty {
            SectionCard(L10n.t(.linkTransfersHeading)) {
                if !link.armedFiles.isEmpty {
                    // A batch the lane has not seen. Its own state rather than
                    // drawn as queued: queued means the lane took it.
                    Text(L10n.t(.linkBatchArmed))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                LazyVStack(alignment: .leading, spacing: Metrics.inner) {
                    ForEach(files.batches) { batch in
                        batchRow(batch)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L10n.t(.linkA11yTransfers))
            }
        }
    }

    @ViewBuilder
    private func batchRow(_ batch: LinkFileBatch) -> some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.tight) {
                Image(systemName: batch.direction == .outbound
                      ? "arrow.up.doc" : "arrow.down.doc")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                Text(LinkBatchCopy.summary(files: batch.files.count,
                                           totalBytes: batch.totalBytes))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(LinkBatchCopy.text(for: batch.state))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            // One element: VoiceOver reads "3 files, 2 MB, Sending" rather than
            // stopping on an unlabelled image and then on each fragment.
            .accessibilityElement(children: .combine)

            if let fraction = batch.fractionCompleted, !batch.isTerminal {
                ProgressView(value: fraction)
            }
            if batch.state == .offered {
                // Accepting a manifest releases a write to this user's disk, so
                // it stays behind the verification boundary — `acceptsWork` —
                // exactly as an outbound batch does.
                Button(L10n.t(.linkAcceptFiles)) { link.acceptInboundBatch() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity)
                    .disabled(!link.acceptsWork)
                Button(L10n.t(.linkDeclineFiles), role: .destructive) {
                    link.rejectInboundBatch()
                }
                    .borderedAction(.destructive)
                    .controlSize(.large)
                    .frame(maxWidth: .infinity)
            }
            if case .queued = batch.state, batch.direction == .outbound {
                Button(L10n.t(.commonCancel), role: .destructive) {
                    link.cancelQueuedBatch(batch.id)
                }
                    .borderedAction(.destructive)
                    .controlSize(.large)
            }
            if case .transferring = batch.state, batch.direction == .outbound {
                Button(L10n.t(.commonCancel), role: .destructive) {
                    link.cancelOutboundBatch()
                }
                    .borderedAction(.destructive)
                    .controlSize(.large)
            }
            received(batch)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A committed inbound batch, and the one thing iOS can offer over it.
    ///
    /// `dragURLs`, not the file list: a folder batch offers its CONTAINER as one
    /// item, so *Save to Files* copies the tree in one piece instead of
    /// flattening it. Built by the same function the legacy receive uses, so a
    /// foldered link batch shares behaves exactly as a foldered legacy one does.
    @ViewBuilder
    private func received(_ batch: LinkFileBatch) -> some View {
        if let files = batch.receivedFiles, !files.isEmpty {
            let payload = receivedPayload(files: files, container: batch.receivedContainer)
            if !payload.dragURLs.isEmpty {
                ShareLink(items: payload.dragURLs) {
                    Text(L10n.t(.commonShare)).frame(maxWidth: .infinity)
                }
                .borderedAction()
                .controlSize(.large)
            }
        }
    }

    // MARK: - terminal

    /// The transcript and the transfer list outlive the link on purpose: a
    /// committed batch's saved files and the conversation the user was reading
    /// are what they still need, exactly as the legacy terminal states keep
    /// theirs. `dismiss()` — the Done below — is what clears them.
    @ViewBuilder
    private func ended(_ reason: LinkWorkspaceEnding) -> some View {
        VStack(alignment: .leading, spacing: Metrics.section) {
            InlineMessage(LinkEndingCopy.isFailure(reason) ? .warning : .info,
                          LinkEndingCopy.text(for: reason))
            if let text = link.textModel, !text.textMessages.isEmpty {
                SectionCard(L10n.t(.linkConversationHeading)) { transcript(text) }
            }
            transfers
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - the exit

    private var exit: some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Button(exitTitle, role: isEnded ? nil : .destructive) { leave() }
                .borderedAction(isEnded ? .ordinary : .destructive)
                .controlSize(.large)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var isEnded: Bool {
        if case .ended = link.connection { return true }
        return false
    }

    private var exitTitle: String {
        isEnded ? L10n.t(.commonDone) : L10n.t(.linkLeaveConnection)
    }

    // MARK: - actions

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Put a handed-back draft in front of the user again, without overwriting
    /// something they have since typed.
    private func restoreReturnedDraft() {
        guard let returned = link.takeReturnedDraft() else { return }
        guard trimmedDraft.isEmpty else { return }
        draft = returned
    }

    private func sendDraft() {
        let body = trimmedDraft
        guard !body.isEmpty else { return }
        actionError = nil
        link.send(message: body)
        // Cleared once the model has taken responsibility for it. The model
        // holds an unsent draft itself until the conversation opens and hands it
        // back through `returnedDraft` if the peer refuses, so nothing is
        // silently lost.
        draft = ""
    }

    /// The picker's result, staged and enqueued on the open link.
    ///
    /// Cleared immediately afterwards, and that is the difference between this
    /// selection and the pre-connect one: a send made inside the workspace is
    /// already committed and already addressed, so holding it would leave a
    /// summary line describing files that have gone — and would keep the
    /// security scopes it took for a batch the model now owns the descriptors of.
    private func sendChosen(_ result: Result<[URL], Error>) {
        selection.chooseFiles(result)
        guard !selection.isEmpty else {
            // A cancelled picker chose nothing and is not an error; a refused
            // one already put its own message on `errorMessage`.
            actionError = selection.errorMessage
            return
        }
        guard let staged = selection.stageForSend() else {
            actionError = selection.errorMessage ?? L10n.t(.nearbyAddFilesFirst)
            selection.clear()
            return
        }
        actionError = nil
        link.send(files: staged.metas, sources: staged.sources)
        selection.clear()
    }

    private func leave() {
        if isEnded { link.dismiss() } else { link.leave() }
    }

    private func failureLine(_ message: String) -> some View {
        InlineMessage(.warning, message)
    }
}
