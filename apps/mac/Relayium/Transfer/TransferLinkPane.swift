import AppKit
import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// A transfer destination once it holds a real `link/1`: **one** connection,
/// verified once, carrying an always-visible composer and as many file or folder
/// batches as the user wants.
///
/// ## What this replaced
///
/// A second pane rendered the shipped legacy wire, which carried a file transfer
/// *or* an ephemeral conversation and said so in one sentence
/// (`workspace.messagesOnlyNote` / `workspace.filesOnlyNote`). Those notes were
/// the bounded honesty of the surface-convergence batch: true for a legacy peer,
/// and untrue on this connection, which is why a peer that announced exact
/// `link/1` never got them.
///
/// **That pane is deleted and there is no second one.** macOS composes one
/// transport, so this is the only session surface the platform has; the owning
/// destination asks `LinkWorkspaceModel.hasSession` through `TransferModule.pane`
/// and gets `.link` or `.connect`. A peer that does not announce exact `link/1`
/// reaches no session pane at all — `LanConnectPane` states it as unsupported,
/// and a pairing room refuses it (`legacyFallback: .terminateUnsupported`).
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

    /// The composer's text lives on the LINK, not here.
    ///
    /// macOS keeps running with its window closed, so this pane is torn down and
    /// rebuilt while the link survives — a view-local draft vanished on every
    /// close/reopen with the connection still up, and the quit guard could not
    /// see it either. See `LinkWorkspaceModel.draft`.
    private var draft: String {
        get { link.draft }
        nonmutating set { link.draft = newValue }
    }
    /// Raised by the exit when leaving would destroy local text.
    ///
    /// **Two things can be lost, and both are unrecoverable.** The transcript is
    /// local-only — `link.historyIsLocal` says so on the exit — and is gone with
    /// the link. The draft is view-local and nothing else holds it: `sendDraft`
    /// hands text to the model only once Send is pressed, so anything still in
    /// the composer dies with this view.
    ///
    /// An earlier version of this confirmed the draft ALONE, which silently
    /// destroyed a transcript whenever the composer happened to be empty — the
    /// ordinary case after somebody has sent a message. That was a real
    /// weakening of what the deleted legacy pane protected.
    @State private var confirmingLocalTextDiscard = false
    @State private var actionError: String?

    /// **What a Finder drag has staged, and has not sent.**
    ///
    /// Owned by the pane rather than by the model, and deliberately separate
    /// from the batch `pick` builds: `pick` goes through a modal `NSOpenPanel`,
    /// which IS a moment of confirmation, so it may put its batch straight on
    /// the link. A drag has no such moment — the user let go over a window, and
    /// what they let go of is not shown to them anywhere first. So a drop stages
    /// here, the manifest is rendered, and **Send** below it is what commits.
    ///
    /// That is the same rule the picker/drop split has followed everywhere else
    /// in this app since `chooseFilesOrFolders` stopped replacing the selection.
    /// It is also what keeps drag-and-drop from being a second answer to "which
    /// peer": this store cannot exist before `link` holds a verified session,
    /// because the pane that owns it is not on screen until then.
    @StateObject private var dropped = SelectionStore()
    @State private var isDropTargeted = false
    @State private var dropRefusal: String?

    /// **Which attempt the staged batch above belongs to.**
    ///
    /// `dropped` is a `@StateObject` on a pane that survives its link ending and
    /// is reused for the next attempt, so a batch staged on attempt N is still
    /// sitting there — listed, with Send beneath it — when N+1 opens with a
    /// different peer. `admitFileDrop` cannot help: it closes the window inside
    /// one drag, and this batch landed cleanly, before the substitution. Only a
    /// lifetime that outlasts the drag can, so the pane reports the attempt it is
    /// serving and discards on a substitution. See `StagedSelectionLifetime`.
    @State private var stagedFor = StagedSelectionLifetime()

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
        // The first attempt this pane ever renders for is not a substitution:
        // seeded here so the NEXT one is compared against something.
        .onAppear { _ = stagedFor.serving(FileDropContext("attempt \(link.attemptGeneration)")) }
        // **The attempt, not the connection.** A link that ENDS is still the same
        // link — the digits are gone but the peer the batch was staged for is
        // the peer it would be sent to when the user reconnects, so ending
        // discards nothing. What discards is `beginAttempt`, which is the sole
        // writer of `attemptGeneration` and is on every path into a new attempt,
        // solicited or not: past it, the pane is showing somebody else.
        .onChange(of: link.attemptGeneration) { generation in
            guard stagedFor.serving(FileDropContext("attempt \(generation)")) else { return }
            discardStagedAttempt()
        }
    }

    /// Everything on this pane that belonged to the attempt that has just been
    /// replaced: the batch nobody sent, the refusal describing a drag onto it,
    /// and the error its last action left. All three name a peer who is no longer
    /// here, and the batch in particular is one Send would put on the new one.
    ///
    /// `link.actionError` is not touched: the model owns it and `beginAttempt`
    /// clears it on the same path that bumped the generation.
    private func discardStagedAttempt() {
        dropped.clear()
        dropRefusal = nil
        actionError = nil
    }

    /// Put a handed-back draft in front of the user again, without overwriting
    /// something they have since typed — and without consuming it if it cannot
    /// land. The order lives on the model now; see
    /// `LinkWorkspaceModel.restoreReturnedDraft`.
    private func restoreReturnedDraft() {
        link.restoreReturnedDraft()
    }

    /// **Retry the restore whenever the composer becomes free.**
    ///
    /// The first attempt runs when the link hands a message back, and it refuses
    /// if the user has since typed something else — correctly, because
    /// overwriting live text is the worse loss. But nothing tried again: the
    /// `task(id:)` that made the first attempt does not re-fire when the draft
    /// later clears or sends, so the handed-back message sat in the model
    /// invisible and unreachable for the rest of the session.
    ///
    /// Keyed on emptiness rather than on the text, so ordinary typing does not
    /// re-ask on every keystroke.
    private var composerIsFree: Bool {
        link.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
            droppedBatch
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
    ///  - **⌘Return sends.** The one composer this platform has, and the
    ///    binding a text field in a chat is expected to answer to.
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
                TextEditor(text: $link.draft)
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
                    // `canSendMessage`, not `canCompose`. The latter answers
                    // "is this link open and verified" and stays true while a
                    // first message is waiting for the peer to accept — so the
                    // button stayed live for a press the model would refuse.
                    .disabled(!link.canSendMessage || trimmedDraft.isEmpty)
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

    /// The two file verbs, beneath the composer rather than behind a mode — and
    /// **the Finder drag that reaches the same connection without them.**
    ///
    /// The drop target is this block and only this block, named by the hint
    /// under the buttons. Not the whole pane: the composer's `TextEditor` and the
    /// transfer list's own drag items are inside it, and a container drop would
    /// be a target the user cannot see the edges of sitting on top of two
    /// controls that already answer a drag.
    ///
    /// It refuses on exactly what the buttons disable on — `link.acceptsWork`,
    /// which is the link being open AND the security digits answered. There is
    /// no second copy of that gate here, and a drag while the SAS is pending is
    /// declined rather than staged: `liveSurface` does not even render this
    /// block then.
    private var fileActions: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
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
            // States both halves: a drag stages, and Send is still pressed by
            // hand. A hint that said only "drag files here" would be a promise
            // that letting go transmits them.
            Text(L10n.t(.dropSendHint))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("link-drop-hint")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // VERTICAL only. Padding the sides too would inset the two buttons from
        // the composer above them, so gaining a drop target would have moved
        // controls that have nothing to do with dragging.
        .padding(.vertical, Metrics.tight)
        .contentShape(Rectangle())
        // Drawn only while a drag is actually over it, so the resting pane keeps
        // two buttons and a sentence rather than gaining a box.
        .overlay(
            RoundedRectangle(cornerRadius: Metrics.corner)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6]))
                .foregroundStyle(isDropTargeted && link.acceptsWork
                                 ? Color.accentColor : Color.clear)
        )
        // **The attempt, not just the state.** `acceptsWork` alone would let a
        // drag that began on a link which ended mid-load stage onto whatever
        // link is open in its place: this pane is rendered for `.ended` too, so
        // it and its `@StateObject dropped` outlive the attempt they were drawn
        // for, and the next attempt is open, unverified-free and not busy. The
        // generation is the peer identity the busy read cannot express.
        .acceptsFileDrop(into: dropped,
                         isBusy: { !link.acceptsWork },
                         context: { FileDropContext("attempt \(link.attemptGeneration)") },
                         isTargeted: $isDropTargeted,
                         onRefusal: { dropRefusal = $0 })
        // **No `accessibilityElement` wrapper around this block.** It holds two
        // Buttons, and grouping a container that holds controls is the exact
        // propagation defect the receive pane has already lost two controls to.
        // The hint is its own `Text` with its own identifier, so VoiceOver reads
        // it in place — an element that swallowed the buttons to carry a hint
        // would have traded the controls for the sentence describing them.
    }

    /// **What was dragged in, before anybody pressed Send.**
    ///
    /// Present only once something has been staged or refused, so the pane a
    /// user who never drags anything sees is unchanged. The manifest is the same
    /// `PendingFileList` every other send surface renders — names and sizes,
    /// never a container path — because this is the one moment at which the user
    /// can still read what a drag actually picked up and take it back.
    ///
    /// **Clear is the cancellation**, and it is the only destructive control
    /// here: the drop and the picker both append through `SelectionStore.add`,
    /// so a second drag adds to this batch rather than replacing it, and nothing
    /// but Clear can discard what is listed.
    @ViewBuilder
    private var droppedBatch: some View {
        if let dropRefusal {
            InlineMessage(.failure, dropRefusal)
                .accessibilityIdentifier("link-drop-refusal")
        }
        if let message = dropped.error {
            // The expansion's own refusal — a symlink, an unreadable item, too
            // many files — in the words `ErrorCopy` already gives every other
            // selection surface. The roots stay staged so the user can see what
            // they dropped and drop the rest again without starting over.
            InlineMessage(.failure, message)
                .accessibilityIdentifier("link-drop-selection-error")
        }
        if !dropped.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.tight) {
                if let summary = dropped.summary {
                    Text(summary)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("link-drop-summary")
                }
                PendingFileList(files: dropped.files)
                HStack(spacing: 8) {
                    Button(L10n.t(.commonSend)) { sendDropped() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!link.acceptsWork)
                        .accessibilityIdentifier("link-drop-send")
                    // A task mutation, never navigation: it discards the batch
                    // the user dragged in.
                    Button(L10n.t(.commonClear)) { clearDropped() }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("link-drop-clear")
                }
            }
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
            Button(leaveTitle) { leaveOrConfirmLocalTextDiscard() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("link-leave-session")
            Text(L10n.t(.linkHistoryIsLocal))
                .font(.caption2).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        // **Asked only when there is something to lose**, so an ordinary hangup
        // is still one press.
        //
        // Both copies are shipped and fully localized, and which one is used is
        // decided by what is actually at risk: `text.discardLocalContent.*` names
        // "any local message history and unsent draft", so it is truthful
        // whenever a transcript exists — with or without a draft — while
        // `text.discardDraft.*` is the narrower, more accurate sentence for a
        // session where only the composer holds anything. Reusing them is why
        // this repair needs no new key.
        // Retried whenever the composer becomes free — including immediately
        // after an accepted send, which clears the draft. See `composerIsFree`.
        .task(id: composerIsFree) { if composerIsFree { link.restoreReturnedDraft() } }
        .confirmationDialog(L10n.t(hasTranscript ? .textDiscardLocalContentConfirmTitle
                                                      : .textDiscardDraftConfirmTitle),
                            isPresented: $confirmingLocalTextDiscard,
                            titleVisibility: .visible) {
            // **The confirmed path discards**, which is what the sentence above
            // promises. `leave()` alone keeps the transcript on the ended page,
            // so the warning would be untrue and the Done underneath it would
            // meet the same predicate and ask a second time.
            Button(leaveTitle, role: .destructive) { leaveDiscardingLocalText() }
                .accessibilityIdentifier("link-discard-local-text-confirm")
            Button(L10n.t(.commonCancel), role: .cancel) {
                confirmingLocalTextDiscard = false
            }
        } message: {
            Text(L10n.t(hasTranscript ? .textDiscardLocalContentConfirmBody
                                           : .textDiscardDraftConfirmBody))
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

    /// **Transactional: the composer is cleared only if the model took the
    /// message.**
    ///
    /// It used to clear unconditionally, so every refusal erased the words it
    /// was refusing — a ⌘Return while a first message was still waiting for the
    /// peer was declined by the model AND wiped here, in the same turn, leaving
    /// an error about text the user could no longer see.
    ///
    /// The acceptance is the model's answer, not an inference from having called
    /// it: `send(message:)` returns whether it took the message.
    private func sendDraft() {
        let body = trimmedDraft
        guard !body.isEmpty else { return }
        actionError = nil
        guard link.send(message: body) else { return }
        // Reached only on acceptance. The model holds the message until the
        // conversation opens and hands it back through `returnedDraft` if the
        // peer refuses, so clearing here loses nothing.
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
        deliver(expanded.files)
    }

    /// **Commit the dragged batch, on the same connection and through the same
    /// checks the picker's batch goes through.**
    ///
    /// The gap this has to survive is the one between the render that drew Send
    /// and the click that arrived: the link can end, or the peer can raise a new
    /// verification, while the batch sits staged. `link.acceptsWork` is re-read
    /// here rather than trusted from `disabled`, and `link.send` refuses again
    /// underneath — a disabled button is a rendering, not a gate.
    ///
    /// The batch is cleared only once `stageRealtimeFiles` and `link.send` have
    /// taken it. A refusal leaves it staged with the reason above it, so the
    /// user fixes and presses Send rather than dragging the folder in again.
    private func sendDropped() {
        guard link.acceptsWork else { return }
        // Read at the moment of use. `dropped.files` is the expansion the store
        // already computed; nothing re-walks the disk here, so the manifest sent
        // is the manifest that was on screen.
        let files = dropped.files
        guard !files.isEmpty else { return }
        guard deliver(files) else { return }
        clearDropped()
    }

    private func clearDropped() {
        dropped.clear()
        dropRefusal = nil
    }

    /// Stage a batch and put it on THIS link. True when the link took it.
    ///
    /// One implementation for the picker and for the drag, so the `MAX_FILES`
    /// bound, the per-path byte limit, the symlink refusal, the held file
    /// descriptors and the error wording cannot come to differ between the two
    /// ways a file arrives.
    @discardableResult
    private func deliver(_ files: [SelectedFile]) -> Bool {
        do {
            let staged = try stageRealtimeFiles(files)
            actionError = nil
            link.send(files: staged.metas, sources: staged.sources)
            // **The model's own answer, not this pane's optimism.** `send` either
            // enqueues the batch or ARMS it behind a pending verification, and
            // both clear `actionError` — so a batch it took is one this returns
            // true for even though nothing has left the machine yet. What it
            // does NOT clear is an `enqueueFiles` throw, and that is the case a
            // staged batch must survive rather than be discarded as sent.
            return link.actionError == nil
        } catch {
            actionError = ErrorCopy.message(for: error)
            return false
        }
    }

    /// **Whether this session holds a conversation that leaving would destroy.**
    ///
    /// Any message at all, sent or received: the transcript is local-only and
    /// unrecoverable, so a received message is exactly as lost as a sent one.
    /// The same predicate `TransferModule.hasLocalText` gives the quit guard,
    /// asked here of this pane's own link — so ⌘Q and Leave cannot disagree
    /// about whether there is anything to warn about.
    /// The ONE predicate, asked of the model. `TransferModule.hasLocalText` —
    /// the quit guard's answer — reads the same property, so ⌘Q and Leave cannot
    /// disagree about whether there is anything to warn about.
    private var hasLocalText: Bool { link.holdsLocalText }

    /// Which sentence the confirmation uses. The local-content copy names
    /// history AND draft, so it is truthful whenever a transcript exists; the
    /// draft copy is the narrower, more accurate one when only the composer
    /// holds something.
    private var hasTranscript: Bool { !(link.textModel?.textMessages.isEmpty ?? true) }

    /// **Ask before discarding text the user has written or received, and only
    /// then.**
    ///
    /// Whitespace-only is not content — `trimmedDraft` is the same answer
    /// `sendDraft` refuses to send — so a stray newline does not turn a hangup
    /// into a dialog. An empty session with no conversation still leaves in one
    /// press, which is the ordinary case and must stay cheap.
    ///
    /// The phase is deliberately NOT consulted. A link that has already ended
    /// can no longer send the draft and can no longer add to the transcript,
    /// which makes the loss more certain rather than less.
    private func leaveOrConfirmLocalTextDiscard() {
        if hasLocalText {
            confirmingLocalTextDiscard = true
        } else {
            leave()
        }
    }

    /// The confirmed destructive exit: end the link and discard the local text,
    /// exactly once. A link that has already ended is dismissed the same way, so
    /// a terminal page holding a transcript still honours its own confirmation.
    /// One model operation for both phases. The ended branch used to clear the
    /// draft here and dismiss, which missed `returnedDraft` entirely — a handed
    /// back message survived the confirmation that promised to discard it.
    private func leaveDiscardingLocalText() {
        link.leaveDiscardingLocalText()
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
    /// The id, never the body: a second copy of ephemeral plaintext would be
    /// readable in any memory capture, for no purpose the user asked for.
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
            // **Queued is neutral; transferring is destructive.** Nothing has
            // left the queue yet, so cancelling one is withdrawing an intent —
            // the same weight as not having pressed Send. Cancelling a batch
            // that is MOVING throws away partial progress on both ends and
            // cannot be resumed, which is the cost the legacy lane's own
            // mid-transfer Cancel was required to state and which survived the
            // transport it was written for.
            if case .queued = batch.state, batch.direction == .outbound {
                Button(L10n.t(.commonCancel)) { link.cancelQueuedBatch(batch.id) }
                    .buttonStyle(.bordered)
            }
            if case .transferring = batch.state, batch.direction == .outbound {
                Button(L10n.t(.commonCancel), role: .destructive) { link.cancelOutboundBatch() }
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
