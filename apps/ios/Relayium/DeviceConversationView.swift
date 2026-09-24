import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **One device's whole page: what it sent this device, what this device sent
/// it, the delivery in flight, and the composer for the next thing.**
///
/// It is the iOS counterpart of `DeviceConversationPage`, and the reasons it is
/// ONE page rather than two are that file's: a separate "send to this device"
/// screen and a separate history screen are two places for the question *which
/// device am I on* to be answered differently, and the second answer is the one
/// that sends something to the wrong machine.
///
/// ## What binds this page to exactly one device
///
/// `peerID`, which the list passes and which never changes while the page is up,
/// and `InboxSendModel.selectedCandidate`, which is the model's own answer to
/// which device may be SENT to. The composer renders only while those two agree
/// — `target` is nil the moment they do not — so the three ways a selection goes
/// stale (revoked, receiving switched off, removed from the account) each take
/// the composer away rather than leaving one pointed at a device that would
/// refuse it. A removed or legacy peer therefore reads perfectly and offers
/// nothing that cannot work.
///
/// The staged batch is aimed the same way: `InboxComposerModel.batch(for:)`
/// re-asks which device the files were chosen for at the moment Send is pressed,
/// so a page reused for another peer cannot seal them to it.
///
/// ## Deleting history is local, and says so
///
/// `deleteTimelineEntry` and `deleteConversation` write a tombstone and clear the
/// protected body and the staged copy behind it. Neither is a remote recall —
/// nothing is unsent, and a delivery in flight keeps running, keeps reporting and
/// keeps its staged bytes. `InboxTimelinePresentation.entryDeleteBody` says that
/// in the confirmation, and it says it differently when the row is a delivery
/// this session is still working.
struct DeviceConversationView: View {
    let peerID: String
    @ObservedObject var inbox: InboxController
    @ObservedObject var deliveries: InboxSendModel
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession
    /// The staged batch and its security scope. App-scoped, not `@State`: a
    /// scope has to be released exactly once and an account leaving has to clear
    /// the batch with no page on screen. See `InboxComposerModel`.
    @EnvironmentObject private var composer: InboxComposerModel

    /// The text being written. `@State` deliberately, and it is the one thing on
    /// this page that is: it is the user's own draft for this sitting, it is
    /// never persisted, and it must not survive the page being left — a message
    /// half-written to one device reappearing on another's page is exactly the
    /// mis-aiming this file exists to prevent.
    @State private var draft = ""
    @State private var isChoosingFiles = false
    @State private var copiedEntryID: String?
    /// The one entry whose delete is waiting on a confirmation.
    ///
    /// Held as the ENTRY rather than a flag: the warning differs by row — a
    /// delivery still running gets a different sentence — and a dialog raised
    /// for the wrong one would be a destructive confirmation about something
    /// else.
    @State private var deletingEntry: InboxTimelineEntry?
    /// The ids that were on screen when Delete conversation was pressed.
    ///
    /// A SNAPSHOT, not a live read. A delivery committed between the button and
    /// the confirmation was never observed by the user, gets no tombstone, and
    /// stays as a new unread row rather than being erased by a decision taken
    /// before it existed.
    @State private var deletingConversation: Set<String>?
    /// A21: Open / Share / Save to Files for what this device RECEIVED here.
    ///
    /// Page-scoped and holding no file of its own: each action re-locates the
    /// files inside the receive folder the Device Inbox controller resolved,
    /// and re-checks the account and the row when that lookup lands — see
    /// `InboxReceivedFileAccessModel`. It never reads the bearer.
    @StateObject private var receivedFiles = InboxReceivedFileAccessModel()
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        DestinationPage {
            headerSection
            activeSection
            composeSection
            timelineSection
        }
        .navigationTitle(peerName)
        .navigationBarTitleDisplayMode(.inline)
        // Aim the composer at THIS device, discarding anything staged for
        // another. Idempotent for the same peer, so a redraw keeps the batch.
        .onAppear { composer.stage(for: peerID) }
        // Read on arrival: the page can be opened from a conversation whose
        // device the directory has not been asked about yet, and the composer
        // renders from `selectedCandidate` rather than from the conversation.
        .task { deliveries.refreshTargets(token: session.bearerToken ?? "") }
        // A message whose staging failed after `sendText` accepted it comes back
        // to this field rather than vanishing — the field was cleared on
        // acceptance. Two triggers, the rule `NearbyLinkWorkspaceView` follows:
        // the hand-back itself, and the field becoming free again, because the
        // model refuses to overwrite text the user has started typing.
        .task(id: deliveries.returnedMessageToken) { restoreReturnedMessage() }
        .task(id: draftIsBlank) { if draftIsBlank { restoreReturnedMessage() } }
        // A21: what each received row can still hand over, re-checked when the
        // rows or the account change and whenever the app comes back — the
        // Files app may have deleted or moved something in between.
        .task(id: receivedRowsKey) { refreshReceivedFiles() }
        // A notification rather than the scene phase: the phase has ONE
        // app-scoped reader by rule (`IOSSurfaceGuardTests`), and this only
        // re-reads the disk — it drives no lifecycle.
        .onReceive(NotificationCenter.default.publisher(
            for: UIApplication.willEnterForegroundNotification)) { _ in
            refreshReceivedFiles()
        }
        // A presented Open / Share / Save to Files is withdrawn the moment its
        // account or its row stops being current.
        .onChange(of: inbox.activeAccountID) { account in
            receivedFiles.invalidate(scope: receivedScope, accountID: account)
        }
        .onChange(of: inbox.conversations) { _ in
            receivedFiles.invalidate(scope: receivedScope, accountID: inbox.activeAccountID)
        }
        .onChange(of: inbox.deletedTimelineIDs) { _ in
            receivedFiles.invalidate(scope: receivedScope, accountID: inbox.activeAccountID)
        }
    }

    // MARK: - received files (A21)

    /// The live answer to "is this row still this account's received files?",
    /// read from the controller at the moment it is asked.
    private var receivedScope: @MainActor (String) -> InboxReceivedFileScope? {
        let inbox = self.inbox
        let peerID = self.peerID
        return { entryID in inbox.receivedFileScope(peerDeviceID: peerID, entryID: entryID) }
    }

    /// Which received rows are on this page, and for which account.
    private var receivedRowsKey: [String] {
        let rows = conversation?.entries
            .filter { $0.direction == .received && $0.kind == .files }
            .map(\.id) ?? []
        return [inbox.activeAccountID ?? ""] + rows
    }

    private func refreshReceivedFiles() {
        receivedFiles.refresh(entryIDs: Array(receivedRowsKey.dropFirst()),
                              receiveFolder: inbox.folder.url, scope: receivedScope)
    }

    private func beginReceived(_ action: InboxReceivedFileAction, _ entry: InboxTimelineEntry) {
        receivedFiles.begin(action, entryID: entry.id, receiveFolder: inbox.folder.url,
                            scope: receivedScope)
    }

    /// The Files app route to the receive folder, spelled the one way every
    /// other iOS sentence spells it.
    private var receiveFolderRoute: String { IOSInboxCopy.receiveFolderRoute() }

    /// The three hand-offs, and the honest state when there is nothing to hand.
    ///
    /// A row whose files have all gone says so and offers nothing: a button that
    /// opens an empty preview is the "saved" claim outliving the file. A row
    /// with some gone says that, and the actions use the rest. A delivery that
    /// arrived inside a folder says what Share and Save to Files hand over.
    @ViewBuilder
    private func receivedFileActions(_ entry: InboxTimelineEntry) -> some View {
        let known = receivedFiles.files[entry.id]
        let available = known?.filter { $0.url != nil }.count
        if let known, available == 0 {
            let refused = known.contains { $0.availability == .refused }
            InlineMessage(.warning, refused
                          ? L10n.t(.inboxReceivedUnavailable, [receiveFolderRoute])
                          : L10n.t(.inboxReceivedAllMissing))
                .accessibilityIdentifier("inbox-received-missing")
        } else {
            if let known, let available, available < known.count {
                InlineMessage(.info, L10n.t(.inboxReceivedSomeMissing))
                    .accessibilityIdentifier("inbox-received-some-missing")
            }
            if known?.contains(where: { $0.relativePath?.contains("/") == true }) == true {
                Text(L10n.t(.inboxReceivedFolderNote, [receiveFolderRoute]))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
            receivedActionButtons(entry)
                // The iPad popover's anchor, and the presenter that withdraws a
                // sheet whose account or row has gone. Handed this row's request
                // only.
                .background(ReceivedFileSheetAnchor(
                    request: receivedFiles.request?.entryID == entry.id
                        ? receivedFiles.request : nil,
                    onFinish: { receivedFiles.finish($0) }))
            if receivedFiles.unavailableEntryID == entry.id {
                InlineMessage(.warning, L10n.t(.inboxReceivedUnavailable, [receiveFolderRoute]))
                    .accessibilityIdentifier("inbox-received-unavailable")
            }
        }
    }

    /// Side by side, and stacked once the reader's text size would break the
    /// words mid-label — the rule the pairing link's Copy/Share follows.
    @ViewBuilder
    private func receivedActionButtons(_ entry: InboxTimelineEntry) -> some View {
        let names = InboxTimelinePresentation.fileNames(of: entry)
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Metrics.tight))
            : AnyLayout(HStackLayout(spacing: Metrics.tight))
        layout {
            Group {
                Button { beginReceived(.open, entry) } label: {
                    Label(L10n.t(.inboxReceivedOpen), systemImage: "eye") // nonlocalized: SF Symbol name
                }
                .accessibilityLabel(L10n.t(.inboxReceivedOpenLabel, [L10n.token(names)]))
                .accessibilityIdentifier("inbox-received-open")
                Button { beginReceived(.share, entry) } label: {
                    Label(L10n.t(.inboxReceivedShare), systemImage: "square.and.arrow.up") // nonlocalized: SF Symbol name
                }
                .accessibilityLabel(L10n.t(.inboxReceivedShareLabel, [L10n.token(names)]))
                .accessibilityIdentifier("inbox-received-share")
                Button { beginReceived(.export, entry) } label: {
                    Label(L10n.t(.inboxReceivedSave), systemImage: "folder") // nonlocalized: SF Symbol name
                }
                .accessibilityLabel(L10n.t(.inboxReceivedSaveLabel, [L10n.token(names)]))
                .accessibilityIdentifier("inbox-received-save")
            }
            .borderedAction()
        }
    }

    private var draftIsBlank: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Put a returned message back, for THIS device only. The model answers nil
    /// for another device's words or a field that is not empty, and keeps them.
    private func restoreReturnedMessage() {
        if let text = deliveries.takeReturnedMessage(for: peerID, composerText: draft) {
            draft = text
        }
    }

    /// The device this page may send to, or nil.
    ///
    /// Both halves are required. `selectedCandidate` is the model's own
    /// sendability answer, re-derived on every read; the `peerID` comparison is
    /// what stops a focus change that has already landed from rendering a
    /// composer for the previous device during the frame before this page goes
    /// away.
    private var target: InboxSendCandidate? {
        guard let candidate = deliveries.selectedCandidate,
              candidate.id == peerID else { return nil }
        return candidate
    }

    private var conversation: InboxConversation? {
        inbox.conversations.first { $0.peerDeviceID == peerID }
    }

    /// What to call this device, resolved the same way the list resolved it.
    ///
    /// The conversation's name wins where there is one, because that is what the
    /// row the user tapped said; a device with no history falls back to the
    /// directory. A peer with neither is a page reached for an id nothing knows
    /// any more — it still renders, with the id's own conversation name rules
    /// applied to an empty name, rather than a blank title.
    private var peerName: String {
        if let conversation {
            return InboxTimelinePresentation.conversationName(
                conversation,
                resolvedName: inbox.displayName(for: conversation),
                isRemoved: inbox.isRemoved(peerID))
        }
        if let candidate = deliveries.candidates.first(where: { $0.id == peerID }) {
            return InboxSendPresentation.name(of: candidate)
        }
        return L10n.t(.inboxConversationRemoved)
    }

    // MARK: - header

    /// Drawn as the page's status head without a title — the navigation bar is
    /// the device's name — and with the radar quiet once the device has left
    /// the account, so a removed peer's page does not look like a live route.
    /// The refusals stay inside it, beside the sentence they qualify.
    private var headerSection: some View {
        StatusHero(symbol: "laptopcomputer", // nonlocalized: SF Symbol name
                   detail: L10n.t(.sendDeviceExplain),
                   isActive: !inbox.isRemoved(peerID)) {
            if let refusal = deliveries.refusal {
                InlineMessage(.warning, InboxSendPresentation.text(for: refusal))
                    .accessibilityIdentifier("inbox-send-refusal")
            }
            if let error = composer.selectionError {
                InlineMessage(.warning, error)
                    .accessibilityIdentifier("inbox-compose-selection-error")
            }
            if inbox.conversationStoreIssue {
                InlineMessage(.warning, L10n.t(.inboxConversationStoreIssue))
            }
        }
    }

    // MARK: - the delivery in flight

    /// Keyed on `peerID` rather than on the candidate, so a delivery to a device
    /// that has just stopped being sendable is still described and can still be
    /// stopped. Losing the composer must not lose the running transfer with it.
    @ViewBuilder
    private var activeSection: some View {
        if let item = InboxSendActions.current(in: deliveries.items, for: peerID) {
            SectionCard(L10n.t(.sendActiveHeading)) {
                if case let .uploading(sent, total) = item.activity {
                    ProgressView(value: Double(sent), total: Double(max(total, 1)))
                        .accessibilityLabel(L10n.t(.sendActiveHeading))
                        .accessibilityValue(
                            L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
                }
                // The sentence beside the bar, always — a bar that reaches the
                // end is the exact place a person concludes their file landed,
                // and what has actually happened is that ciphertext went up.
                Text(InboxSendPresentation.status(for: item.activity))
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-delivery-status")
                PendingFileList(sessionFiles: item.files)
                // An action that did not do what it said. A cancel central
                // refused means the delivery is still live, and the one thing
                // this must not do is quietly stop describing it.
                if let error = deliveries.actionError, error.itemID == item.id {
                    InlineMessage(.warning, InboxSendPresentation.text(for: error))
                        .accessibilityIdentifier("inbox-delivery-error")
                }
                Text(L10n.t(.sendOutstandingExplain))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                // Which actions exist, and which of them is the cancel, are
                // `InboxSendActions`' answers — the same ones the delivery list
                // renders. `DeliveryActions` is shared with it so a send has one
                // set of controls wherever it is drawn.
                DeliveryActions(item: item, deliveries: deliveries,
                                onOpenAccount: onOpenAccount)
            }
        }
    }

    // MARK: - composing

    /// **No mode picker.** Both groups are always present, each states its own
    /// kind and carries its own Send, and which one LEADS is
    /// `InboxSendComposer.order` — the working one first, so a device that
    /// cannot present a message does not open on a dead end. Neither is ever
    /// dropped: hiding the message composer on a CLI target would teach a user
    /// that this build cannot send messages at all.
    @ViewBuilder
    private var composeSection: some View {
        if let target {
            SectionCard(L10n.t(.inboxComposeHeading)) {
                ForEach(InboxSendComposer.order(canReceiveText: target.canReceiveText),
                        id: \.self) { kind in
                    switch kind {
                    case .message: messageControls(target)
                    case .files:   fileControls
                    }
                }
            }
        } else {
            // An honest sentence rather than a disabled composer: a control that
            // cannot work is worse than one that is absent with a reason beside
            // it.
            SectionCard(L10n.t(.inboxComposeHeading)) {
                Text(L10n.t(.inboxComposeUnavailable))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-compose-unavailable")
            }
        }
    }

    /// **Measured in UTF-8 bytes, the way the manifest and the receiver
    /// measure it.** `InboxTextDraft` is the macOS composer's own type: a count
    /// of characters would call a screenful of emoji a quarter of the limit. The
    /// bound is `InboxManifest.maxTextBytes` — the Inbox's, never the realtime
    /// lane's — and it is enforced BEFORE the press: past it Send is disabled
    /// and the line under the field says by how much, while every character
    /// stays in the field. Nothing here truncates.
    @ViewBuilder
    private func messageControls(_ target: InboxSendCandidate) -> some View {
        let draftSize = InboxTextDraft(draft)
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(InboxSendPresentation.label(for: .message))
                .font(.headline)
            TextField(L10n.t(.sendMessagePlaceholder), text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(3...8)
                .accessibilityLabel(L10n.t(.sendMessageLabel))
                .accessibilityIdentifier("inbox-message-field")
            Text(InboxSendPresentation.size(of: draftSize))
                .font(.footnote)
                .monospacedDigit()
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inbox-message-size")
            if draftSize.isTooLong {
                // The whole explanation of the disabled Send, so it cannot be a
                // grey footnote.
                InlineMessage(.warning, InboxSendPresentation.limit(of: draftSize))
                    .accessibilityIdentifier("inbox-message-over-limit")
            } else {
                Text(InboxSendPresentation.limit(of: draftSize))
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-message-remaining")
            }
            // The refusal above the control it explains, in reading order. A
            // device that does not announce `inbox.text.v1` gets the sentence
            // and no Send, rather than a Send the model would refuse.
            if let refusal = InboxSendPresentation.textRefusal(for: target) {
                InlineMessage(.warning, refusal)
                    .accessibilityIdentifier("inbox-message-refusal")
            } else {
                Button(action: sendMessage) {
                    Text(L10n.t(.sendMessageAction)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                // `isSendable` is the exact precondition `sendText` applies, so
                // the button is never live for a press the model would refuse;
                // whitespace alone stays unsendable as before.
                .disabled(!draftSize.isSendable
                          || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityHidden(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("inbox-send-message")
            }
        }
    }

    @ViewBuilder
    private var fileControls: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(InboxSendPresentation.label(for: .files))
                .font(.headline)
            // Exactly one prominent control at a time, the rule the Send screen
            // records: with nothing staged, choosing IS the task; once files are
            // staged the emphasis moves to Send below. Two branches rather than
            // a ternary because the two styles are different types.
            if composer.files.isEmpty {
                Button { isChoosingFiles = true } label: {
                    Text(L10n.t(.commonChooseFilesOrFolders)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("inbox-choose-files")
            } else {
                Button { isChoosingFiles = true } label: {
                    Text(L10n.t(.commonChooseFilesOrFolders)).frame(maxWidth: .infinity)
                }
                .borderedAction()
                .controlSize(.large)
                .accessibilityIdentifier("inbox-choose-files")
            }

            if !composer.files.isEmpty {
                // Safe manifest identities only — no security-scoped URL and no
                // container path. "3 files" is not enough to decide whether to
                // seal them to a particular device.
                PendingFileList(files: composer.files)
                Button(L10n.t(.commonClear)) { composer.clearFiles() }
                    .borderedAction()
                    .controlSize(.large)
                    .accessibilityIdentifier("inbox-clear-files")
                Button(action: sendFiles) {
                    Text(L10n.t(.commonSend)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("inbox-send-files")
            }
        }
        // `[.item, .folder]`, so a folder is choosable and its contents are
        // expanded inside the security scope the composer starts before anything
        // enumerates them.
        .fileImporter(isPresented: $isChoosingFiles,
                      allowedContentTypes: [.item, .folder],
                      allowsMultipleSelection: true) { result in
            composer.chooseFiles(result)
        }
    }

    // MARK: - the history, both directions

    /// One deterministic list, newest first, with direction written on every row.
    ///
    /// The order is the store's — an immutable local event time with the local id
    /// as tie-break — and this view does not re-sort it, which is what makes a
    /// status poll about an outgoing delivery unable to move a row somebody is
    /// reading.
    private var timelineSection: some View {
        SectionCard(L10n.t(.inboxTimelineHeading)) {
            if let conversation, !conversation.entries.isEmpty {
                Button(L10n.t(.inboxConversationDelete), role: .destructive) {
                    // The snapshot is taken HERE, at the moment the user asked.
                    deletingConversation = conversation.entryIDs
                }
                .borderedAction(.destructive)
                .controlSize(.large)
                .accessibilityIdentifier("inbox-conversation-delete")
                ForEach(conversation.entries) { entry in
                    entryRow(entry)
                }
            } else {
                Text(L10n.t(.inboxTimelineEmpty))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-timeline-empty")
            }
        }
        .confirmationDialog(InboxTimelinePresentation.entryDeleteTitle(),
                            isPresented: Binding(get: { deletingEntry != nil },
                                                 set: { if !$0 { deletingEntry = nil } }),
                            presenting: deletingEntry) { entry in
            Button(L10n.t(.inboxDeleteConfirmAction), role: .destructive) {
                inbox.deleteTimelineEntry(entry.id, peerDeviceID: peerID)
                // Re-publish the send model's cards against the new tombstone.
                // Its filter is not reactive to the controller, so without this
                // a deleted send's card would sit in the section above until the
                // next state change — and a stopped one has none coming. This
                // reads disk and touches no network: no cancel, no discard, no
                // staged byte, nothing central hears about.
                deliveries.refreshOutstanding()
                deletingEntry = nil
            }
            .accessibilityIdentifier("inbox-entry-delete-confirm")
            Button(L10n.t(.commonCancel), role: .cancel) { deletingEntry = nil }
        } message: { entry in
            Text(InboxTimelinePresentation.entryDeleteBody(
                peerName: peerName, isRunning: runningItem(for: entry) != nil))
        }
        .confirmationDialog(InboxTimelinePresentation.conversationDeleteTitle(
                                count: deletingConversation?.count ?? 0),
                            isPresented: Binding(get: { deletingConversation != nil },
                                                 set: { if !$0 { deletingConversation = nil } }),
                            presenting: deletingConversation) { observed in
            Button(L10n.t(.inboxDeleteConfirmAction), role: .destructive) {
                inbox.deleteConversation(peerDeviceID: peerID, observedEntryIDs: observed)
                deliveries.refreshOutstanding()
                deletingConversation = nil
            }
            .accessibilityIdentifier("inbox-conversation-delete-confirm")
            Button(L10n.t(.commonCancel), role: .cancel) { deletingConversation = nil }
        } message: { _ in
            Text(InboxTimelinePresentation.conversationDeleteBody(peerName: peerName))
        }
        // Marking read is what clears the unread badge in the list behind this
        // page, so it happens on arrival rather than on scroll.
        .onAppear { inbox.markConversationRead(peerID) }
    }

    /// One row: direction in words, the content, what is known about it, when,
    /// and the delete.
    private func entryRow(_ entry: InboxTimelineEntry) -> some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            // **Direction as a sentence, with the symbol as decoration.**
            // Alignment and tint are how a chat app says this, and neither
            // survives VoiceOver, a monochrome screen or a colour filter — so
            // the words carry it and the glyph is hidden.
            HStack(spacing: Metrics.hairline) {
                Image(systemName: InboxTimelinePresentation.directionSymbol(of: entry))
                    .accessibilityHidden(true)
                Text(InboxTimelinePresentation.direction(of: entry, peerName: peerName))
                    .font(.caption.weight(.semibold))
                    .accessibilityIdentifier("inbox-entry-direction")
            }
            entryBody(entry)
            if let state = InboxTimelinePresentation.state(of: entry) {
                HStack(spacing: Metrics.hairline) {
                    if let symbol = InboxTimelinePresentation.stateSymbol(of: entry) {
                        Image(systemName: symbol).accessibilityHidden(true)
                    }
                    Text(state)
                        .font(.caption)
                        .foregroundStyle(Palette.supportingLabel)
                        .accessibilityIdentifier("inbox-entry-state")
                }
            }
            Text(InboxTimelinePresentation.at(entry))
                .font(.caption)
                .foregroundStyle(Palette.supportingLabel)
            // A visible control, not a swipe: a swipe action is undiscoverable
            // and unreachable to somebody navigating with VoiceOver. It never
            // deletes on its own — it raises the confirmation, which is the one
            // place any of this happens.
            Button(L10n.t(.inboxEntryDelete), role: .destructive) {
                deletingEntry = entry
            }
            .borderedAction(.destructive)
            .accessibilityLabel(InboxTimelinePresentation.menuLabel(of: entry,
                                                                    peerName: peerName))
            .accessibilityIdentifier("inbox-entry-delete")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(InboxTimelinePresentation.accessibilityLabel(
            of: entry, peerName: peerName))
        .accessibilityIdentifier("inbox-entry.\(entry.id)")
    }

    @ViewBuilder
    private func entryBody(_ entry: InboxTimelineEntry) -> some View {
        if entry.kind == .message, let message = messageBody(entry) {
            Text(message.text)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(copiedEntryID == entry.id ? .commonCopied : .commonCopy)) {
                UIPasteboard.general.string = message.text
                copiedEntryID = entry.id
            }
            .borderedAction()
            .accessibilityLabel(InboxMessagePresentation.copyActionLabel(
                copied: copiedEntryID == entry.id))
            .accessibilityIdentifier("inbox-entry-copy")
        } else if entry.kind == .files {
            Text(InboxTimelinePresentation.fileNames(of: entry))
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            // Only what this device RECEIVED: an outgoing row carries no path,
            // and the sender's own copy is not this page's to hand out.
            if entry.direction == .received {
                receivedFileActions(entry)
            }
        } else if entry.direction == .sent {
            // A body this device no longer holds — the process died between the
            // durable plan and the body being written, and the staged copy went
            // with the plan. Said out loud rather than drawn as an empty row.
            InlineMessage(.warning, L10n.t(.inboxSentMessageMissing))
                .accessibilityIdentifier("inbox-sent-message-missing")
        } else {
            InlineMessage(.warning, L10n.t(.inboxConversationMessageMissing))
                .accessibilityIdentifier("inbox-conversation-message-missing")
        }
    }

    /// The protected body behind one row, read from the store its direction
    /// owns. The two namespaces are separate directories on purpose: task ids
    /// and job ids are minted by different systems and nothing makes them
    /// disjoint.
    private func messageBody(_ entry: InboxTimelineEntry) -> InboxMessage? {
        entry.direction == .received ? inbox.message(for: entry) : inbox.sentMessage(for: entry)
    }

    /// The live delivery behind an outgoing row, if this session is running one.
    /// Used to tell the confirmation that deleting will not stop it.
    private func runningItem(for entry: InboxTimelineEntry) -> InboxSendItem? {
        guard let jobID = entry.jobID else { return nil }
        return deliveries.items.first { $0.id == jobID }
    }

    // MARK: - actions

    /// The one place this page reads the bearer, and it reads it at the moment
    /// of use — so a sign-out landing between a button being enabled and that
    /// button being tapped produces an honest route to the account rather than a
    /// request with an empty credential.
    private func liveToken() -> String? {
        guard let token = session.bearerToken, !token.isEmpty,
              case .allowed = AccountGate.from(session.state, bearer: token) else {
            return nil
        }
        return token
    }

    private func sendMessage() {
        guard let token = liveToken() else { return onOpenAccount() }
        deliveries.sendText(draft, token: token)
        // Cleared only if the model accepted it. A refusal keeps what the user
        // wrote, beside the sentence explaining why it did not go.
        if deliveries.refusal == nil { draft = "" }
    }

    private func sendFiles() {
        // Re-asked at the moment of use, so a page reused for another device
        // cannot seal this batch to it.
        guard let files = composer.batch(for: peerID) else { return }
        guard let token = liveToken() else { return onOpenAccount() }
        // `sourceDraftId: nil`, and it is a refusal rather than an omission: a
        // draft id is the authority to RETIRE a shared draft — to delete another
        // app's only copy of what it handed Relayium — and a batch chosen here
        // came from this app's own picker, so no send from this page can have
        // come from one.
        deliveries.send(files: files, sourceDraftId: nil, token: token)
        if deliveries.refusal == nil { composer.clearFiles() }
    }
}
