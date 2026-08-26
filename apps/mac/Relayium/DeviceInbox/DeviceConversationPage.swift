import RelayiumAppKit
import SwiftUI

/// **One device's whole page: what this Mac sent it, what it sent this Mac, and
/// the composer for the next thing — in that one place.**
///
/// ## Why the send screen and the conversation are the same page
///
/// They were two. Opening a device from My Devices gave a composer with no
/// history; opening the same device from Conversations gave a history whose
/// *Send Content* button replaced the page it was on — the conversation
/// disappeared at the exact moment the user asked to add to it. Two screens
/// about one device is also two places for the "which device am I on" question
/// to be answered differently, and the second answer is the one that sends
/// something to the wrong machine.
///
/// So there is one page per device and no jump between them. The history is
/// under the composer; nothing here navigates anywhere except back to the list.
///
/// ## What binds this page to exactly one device
///
/// `peerID`, which its host passes and never changes while this page is up, and
/// `InboxSendModel.selectedCandidate`, which is the model's own answer to which
/// device may be SENT to. The composer renders only while those two agree —
/// `target` below is nil the moment they do not — so the three ways a selection
/// goes stale (revoked, receiving switched off, removed from the account) all
/// take the composer away rather than leaving one pointed at a device that would
/// refuse it. A legacy or removed peer therefore reads perfectly and offers
/// nothing that cannot work, which is the honest version of a disabled composer.
///
/// Every send this page starts reads `selectedTargetID` back out of the model at
/// the moment of use. There is no device id held here to disagree with it.
///
/// ## One send is one kind
///
/// `InboxSendContentKind` is a closed set and exactly one of its controls is on
/// screen at a time. A mixed manifest is refused by the codec, so a composer
/// offering a message with an attachment could only ever produce a delivery no
/// receiver accepts — and this is the form of that rule a person can see.
///
/// ## Deletion here is history deletion
///
/// Nothing on this page recalls, cancels or unsends anything, and both
/// confirmations say so in the action label itself. What Delete removes is this
/// Mac's row and the protected body behind it. The other device keeps its copy,
/// a received file already written into the user's receive folder stays exactly
/// where it is, and a delivery still in flight goes on running — the
/// confirmation offers the real stop control separately, and only when there
/// genuinely is one.
struct DeviceConversationPage: View {
    /// The device this page is about. A conversation may exist for a peer that
    /// can no longer be sent to — a removed device, or the read-only bucket that
    /// predates authenticated attribution — so this is an id rather than a
    /// candidate.
    let peerID: String
    /// The name the host resolved, with its own "removed device" and "earlier
    /// Relayium" decorations already applied. Resolved once by the list so the
    /// two surfaces cannot name the same device differently.
    let peerName: String
    @ObservedObject var deliveries: InboxSendModel
    /// Where a refusal whose remedy is the account goes.
    let onAccount: () -> Void
    /// Back to the list. The host owns which page is up.
    let onBack: () -> Void

    @EnvironmentObject private var inbox: InboxController
    @EnvironmentObject private var session: AccountSession

    /// What is going, when what is going is files. Owned by this view exactly as
    /// `UploadPane` owns the stored-send one — the model owns what is being
    /// *delivered*, and a batch nobody has pressed Send on is not that yet.
    ///
    /// It goes with the page, which is the honest lifetime: a selection staged
    /// for one device is not a selection for the next one. A send already handed
    /// to the model is unaffected — `InboxSendModel.send` copies the bytes into
    /// this app's own storage under a durable plan.
    @StateObject private var selection = SelectionStore()

    /// The message being written. Exactly what the user typed: never trimmed,
    /// never normalized, never re-encoded. `sendText` is given this string and
    /// the receiver commits the same bytes.
    @State private var draft = ""

    /// Which row last had its Copy pressed. Compared, never rendered, and keyed
    /// by the row's local id rather than its position: the list is newest first
    /// and something arriving while the page is open would otherwise move the
    /// confirmation onto somebody else's row.
    @State private var copiedEntryID: String?

    /// The row a destructive confirmation is currently about, and the snapshot a
    /// whole-conversation confirmation was raised against.
    ///
    /// The conversation snapshot is captured when the button is pressed rather
    /// than read again when it is confirmed, which is the entire race semantic:
    /// a delivery committed while the dialog is up was never on screen, has no
    /// tombstone written for it, and stays as a new unread row.
    @State private var deletingEntry: InboxTimelineEntry?
    @State private var deletingConversation: Set<String>?

    /// A Finder drag is over the file controls. Held only so the drop target can
    /// be asked about; this surface draws no highlight of its own, because a
    /// form row that grew a border under the cursor would read as a control
    /// changing rather than as a target accepting.
    @State private var isDropTargeted = false
    /// A drag refused whole — see `FileDropAdmission`. Separate from
    /// `selection.error`, which is the expansion's refusal of a batch that WAS
    /// staged: the two have different remedies and naming one as the other would
    /// send the user to look for a file that never arrived.
    @State private var dropRefusal: String?

    /// **Which device the staged batch above belongs to.**
    ///
    /// `peerID` is a `let`, but view identity is the host's to break rather than
    /// this page's to rely on: a host that renders this page inside an
    /// `if let peer = …` with no explicit `id` reuses this view across a device
    /// swap — new `peerID`, same `@StateObject selection`. A batch picked or
    /// dropped for device A would then be listed under device B's name with Send
    /// beneath it, and the model's own `selectedCandidate` has moved to B, so
    /// nothing else refuses it. The page reports the device it is serving and
    /// discards on a substitution. See `StagedSelectionLifetime`.
    ///
    /// **`DeviceInboxSurface` now DOES break identity — `.id(peer.id)` — and
    /// this stays anyway.** Not redundancy: the two answer different questions.
    /// Identity at the host covers every piece of state on this page, including
    /// the ones nobody has written yet, and is the mechanism this file relies on
    /// for `draft`, `copiedEntryID` and the two delete confirmations. This
    /// covers the case identity cannot: a host that forgets. Both are checked by
    /// name in `InboxSurfaceGuardTests`, so neither can be dropped quietly, and
    /// under a host that keys correctly this simply never fires.
    @State private var stagedFor = StagedSelectionLifetime()

    /// The device this page may send to — nil unless the model's own selection
    /// agrees with the page's peer.
    private var target: InboxSendCandidate? {
        guard let candidate = deliveries.selectedCandidate,
              candidate.id == peerID else { return nil }
        return candidate
    }

    private var conversation: InboxConversation? {
        inbox.conversations.first { $0.peerDeviceID == peerID }
    }

    var body: some View {
        headerSection
            // Re-read when this page opens, so a device revoked or switched off
            // while the user was elsewhere is discovered here. The model clears
            // the selection on that answer, which takes the composer away before
            // anything is composed for a device that would refuse it.
            .task { deliveries.refreshTargets(token: session.bearerToken ?? "") }
            // The first device this page renders for is not a substitution:
            // seeded here so the NEXT one is compared against something.
            .onAppear { _ = stagedFor.serving(FileDropContext(peerID)) }
            // **A batch belongs to the device it was staged for.** The parameter
            // rather than `peerID`, because the closure that runs may be the one
            // captured by the body that is being replaced — and reading the old
            // device here would compare a device to itself and discard nothing.
            .onChange(of: peerID) { device in
                guard stagedFor.serving(FileDropContext(device)) else { return }
                discardStagedDevice()
            }
        activeSection
        composeSection
        timelineSection
    }

    // MARK: - which device, and the way back

    private var headerSection: some View {
        Section {
            // The way out, first in reading order and first in the tab order —
            // a page that can only be left by pressing the thing that sends is
            // not a page somebody explores.
            Button {
                onBack()
            } label: {
                Label(L10n.t(.sendBackToDevices), systemImage: "chevron.left")
            }
            .buttonStyle(.bordered)
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("inbox-send-back")
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(peerName)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-send-device-name")
                if let target {
                    Text(InboxSendPresentation.detail(for: target))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("inbox-send-device-detail")
                }
            }
            // **Why the last attempt was refused, under the device it names and
            // above both composers.** Most of these — staging failed, the
            // credential went away, the target changed under the send, something
            // is already being prepared — belong to neither kind, and rendering
            // one under each Send button would be the same failure said twice.
            // The two reasons a Send is disabled BEFORE it is pressed are said
            // beside that button instead: the byte counter and the capability.
            if let refusal = deliveries.refusal {
                InlineMessage(.failure, InboxSendPresentation.text(for: refusal))
                    .accessibilityIdentifier("inbox-send-refusal")
            }
            if inbox.conversationStoreIssue {
                InlineMessage(.failure, L10n.t(.inboxConversationStoreIssue))
                    .accessibilityIdentifier("inbox-conversation-store-issue")
            }
        } footer: {
            // The consequence, before anything is encrypted: sealed to one
            // device, no link, nobody else can open it.
            caption(L10n.t(.sendDeviceExplain))
        }
    }

    // MARK: - what is happening to this device right now

    /// The send aimed at THIS device, if there is one, and the control that
    /// stops it.
    ///
    /// Keyed on `peerID` rather than on the candidate, so a delivery to a device
    /// that has just stopped being sendable is still described and can still be
    /// stopped — losing the composer must not lose the running transfer with it.
    @ViewBuilder
    private var activeSection: some View {
        if let item = InboxSendActions.current(in: deliveries.items, for: peerID) {
            Section {
                if case let .uploading(sent, total) = item.activity {
                    ProgressView(value: Double(sent), total: Double(max(total, 1)))
                        .accessibilityLabel(L10n.t(.sendActiveHeading))
                        .accessibilityValue(
                            L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
                }
                Text(InboxSendPresentation.status(for: item.activity))
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-delivery-status")
                PendingFileList(sessionFiles: item.files)
                // An action that did not do what it said. A cancel central
                // refused means the delivery is still live, and the one thing
                // this must not do is quietly stop describing it.
                if let error = deliveries.actionError, error.itemID == item.id {
                    InlineMessage(.failure, InboxSendPresentation.text(for: error))
                        .accessibilityIdentifier("inbox-delivery-error")
                }
                // **Prominent, and it is the one control on this page that is.**
                // A send that is preparing or uploading is the state a person
                // most urgently wants out of, and a Cancel drawn as one bordered
                // button among four is a Cancel they hunt for while their files
                // are moving. Which action that IS — stop this device's attempt,
                // or ask central to drop the delivery — is
                // `InboxSendActions.cancel`, derived from what is actually
                // offered rather than decided again here.
                let cancel = InboxSendActions.cancel(for: item)
                if let cancel {
                    DeliveryActionButton(action: cancel, item: item,
                                         deliveries: deliveries, isProminent: true,
                                         onAccount: onAccount)
                }
                // Everything else this send may offer, at ordinary weight and
                // never a second copy of the cancel above.
                HStack {
                    ForEach(InboxSendActions.offered(for: item)
                        .filter { $0 != cancel }, id: \.self) { action in
                        DeliveryActionButton(action: action, item: item,
                                             deliveries: deliveries, onAccount: onAccount)
                    }
                }
            } header: {
                Text(L10n.t(.sendActiveHeading))
                    .accessibilityIdentifier("inbox-send-active")
            } footer: {
                caption(L10n.t(.sendOutstandingExplain))
            }
        }
    }

    // MARK: - composing, on this same page

    /// The composer, or an honest sentence in its place.
    ///
    /// **No mode picker.** Each group states its own kind and carries its own
    /// Send, which is the same repair `TransferSessionView` made when its
    /// segmented *files or text?* control was removed: a control whose only
    /// effect is to hide the other half makes a user who wanted to say something
    /// choose a transport first. Both groups are always here, so nothing is
    /// staged behind a tab the user cannot see, and which one LEADS is
    /// `InboxSendComposer.order` — the working one, on a device that cannot
    /// present a message.
    @ViewBuilder
    private var composeSection: some View {
        if let target {
            ForEach(InboxSendComposer.order(canReceiveText: target.canReceiveText),
                    id: \.self) { kind in
                switch kind {
                case .message: messageSection(target)
                case .files:   filesSection
                }
            }
        } else {
            // A disabled composer would be a control the user can neither use
            // nor understand. This is the sentence instead.
            Section {
                Text(L10n.t(.inboxComposeUnavailable))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-compose-unavailable")
            } header: {
                Text(L10n.t(.inboxComposeHeading))
                    .accessibilityIdentifier("inbox-compose-group")
            }
        }
    }

    // MARK: - a message

    /// The composer, and the two things it must say before the button is pressed.
    ///
    /// **The size, always.** 64 KiB of UTF-8 is not a bound a person can
    /// estimate from what is on screen — an emoji is four bytes and a Chinese
    /// character is three — so the counter is beside the field at all times
    /// rather than appearing as a refusal after the message is written.
    ///
    /// **The capability, when it is missing.** A device that does not announce
    /// `inbox.text.v1` has not promised a surface that presents a message as a
    /// message, so Send Message is disabled AND the reason is on screen: a
    /// disabled button with nothing beside it is indistinguishable from a broken
    /// one, and a composer simply removed would teach the reader that this build
    /// cannot send messages at all. The file group is untouched by it, because a
    /// receiver without the token is a perfectly good file target — the CLI and
    /// the headless receiver among them.
    ///
    /// **The receive folder is deliberately not consulted.** A message is never
    /// written there — a v2 receiver classifies the sealed kind first — so a
    /// missing or unwritable folder is a truthful caveat about FILES and has
    /// nothing to say about whether a message can land.
    private func messageSection(_ target: InboxSendCandidate) -> some View {
        Section {
            messageControls(target)
        } header: {
            Text(InboxSendPresentation.label(for: .message))
                .accessibilityIdentifier("inbox-send-message-group")
        }
    }

    @ViewBuilder
    private func messageControls(_ target: InboxSendCandidate) -> some View {
        let draftSize = InboxTextDraft(draft)
        ZStack(alignment: .topLeading) {
            TextEditor(text: $draft)
                .font(.body)
                // The editor draws its own opaque background, which inside a
                // form row reads as a second surface rather than as a field.
                .scrollContentBackground(.hidden)
                .frame(minHeight: Metrics.composerMinHeight,
                       maxHeight: Metrics.composerMaxHeight)
                .padding(Metrics.hairline)
                .accessibilityLabel(L10n.t(.sendMessageLabel))
                .accessibilityIdentifier("inbox-send-composer")
            if draft.isEmpty {
                // A placeholder, and only that: the editor above already carries
                // the accessible name, so this is decoration to VoiceOver and
                // must not be read as a second label. Positioned against the
                // editor's own text container — `Metrics.textEditorInset` is
                // what keeps this line from sitting a few points left of the
                // caret it stands in for.
                Text(L10n.t(.sendMessagePlaceholder))
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.leading, Metrics.hairline + Metrics.textEditorInset)
                    .padding(.top, Metrics.hairline)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity)
        .background(Palette.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.corner))
        .overlay(RoundedRectangle(cornerRadius: Metrics.corner)
            .strokeBorder(Palette.cardBorder, lineWidth: 1))
        Text(InboxSendPresentation.size(of: draftSize))
            .font(.caption)
            .monospacedDigit()
            // The one state the counter has to be impossible to miss in: past
            // the bound, where the button is disabled and this line is the whole
            // explanation of why.
            .foregroundStyle(draftSize.isTooLong ? InlineMessage.Kind.failure.tint
                                                 : Color.secondary)
            .accessibilityIdentifier("inbox-send-message-size")
        if let refusal = InboxSendPresentation.textRefusal(for: target) {
            InlineMessage(.warning, refusal)
                .accessibilityIdentifier("inbox-send-text-unsupported")
        }
        Button(L10n.t(.sendMessageAction)) { sendMessage() }
            .buttonStyle(.borderedProminent)
            // NOT `.defaultAction`: that is plain Return, and plain Return
            // belongs to the editor above. ⌘Return is what the app's other
            // composers already use.
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!draftSize.isSendable || !target.canReceiveText)
            .accessibilityIdentifier("inbox-send-message")
    }

    // MARK: - files, or a folder

    /// **Two ways in and one batch, because they are two questions and one
    /// delivery.**
    ///
    /// `NSOpenPanel` has to be told whether a file is a legal choice, so a
    /// control offering both is a control that cannot mean *a folder*. Both
    /// APPEND through `SelectionStore.add`, exactly as every other way a file
    /// arrives in this app does, so choosing files and then reaching for a
    /// folder adds to the batch instead of silently discarding it — and **Clear**
    /// is the one control that discards, which is where a destructive action
    /// belongs.
    ///
    /// A chosen folder keeps its hierarchy: `expandSelection` gives every file
    /// inside it a `relativePath`, and that path is what the sealed manifest
    /// carries to the other device.
    ///
    /// **A third way in, and it is the same batch: a Finder drag.** No dashed
    /// box — this page is a grouped `Form`, and a drop rectangle inside a form
    /// row reads as a control the row does not have. The two buttons and the
    /// hint beneath them ARE the target, so the affordance is a sentence rather
    /// than a shape, and `FileDropReceiver` puts what is dropped through
    /// `SelectionStore.add` exactly as both pickers do.
    ///
    /// **It cannot send and it cannot choose a device.** Send is the button at
    /// the bottom of this group, unchanged, and the device is `target` — which
    /// this page only has because the model's own selection still names the peer
    /// it was opened for. A drag onto a page whose device was revoked, switched
    /// off or removed lands on `inbox-compose-unavailable` instead, because the
    /// composer is gone by then; a revocation that arrives DURING the drag is
    /// caught by the same `isBusy` re-read on the far side of the item load.
    @ViewBuilder
    private var fileControls: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            HStack {
                Button(L10n.t(.commonChooseFilesOrFolders)) {
                    chooseFilesOrFolders(into: selection)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("inbox-send-choose-files")
                Button(L10n.t(.sendChooseFolders)) { chooseFolders(into: selection) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-send-choose-folder")
                if !selection.isEmpty {
                    Button(L10n.t(.commonClear)) { selection.clear(); dropRefusal = nil }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("inbox-send-clear")
                }
            }
            // Both halves: a drag stages, and Send is still pressed by hand.
            Text(L10n.t(.dropSendHint))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inbox-send-drop-hint")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        // **The device, named rather than assumed.** `target == nil` answers
        // whether this page may send at all; it does not answer WHICH device the
        // page is about, and the two are different questions the moment SwiftUI
        // reuses this view. `peerID` is a `let`, but view identity is the host's
        // to apply rather than this page's to assume: `DeviceInboxSurface` does
        // key this page with `.id(peer.id)`, so under that host a device swap is
        // a new view and this comparison never fires — and it is passed anyway,
        // because the dependency being removed is on the host continuing to do
        // that. A second host, or a refactor that drops the key, would otherwise
        // reuse this view and with it the `@StateObject selection` a drag is
        // resolving into. One comparison buys the same rule the link pane obeys,
        // held independently of how this page happens to be navigated.
        .acceptsFileDrop(into: selection,
                         isBusy: { target == nil },
                         context: { FileDropContext(peerID) },
                         isTargeted: $isDropTargeted,
                         onRefusal: { dropRefusal = $0 })
        // **No `accessibilityElement` wrapper.** This block holds the two picker
        // buttons and Clear, and grouping a container that holds controls is the
        // propagation defect this surface has already lost two controls to. The
        // hint is its own `Text` on a leaf, which is where every identifier in
        // this file lives.
        if let dropRefusal {
            InlineMessage(.failure, dropRefusal)
                .accessibilityIdentifier("inbox-send-drop-error")
        }
        if let message = selection.error {
            InlineMessage(.failure, message)
                .accessibilityIdentifier("inbox-send-selection-error")
        }
        // The safe manifest identity every other send surface in this app
        // renders — names and sizes, never a container path.
        PendingFileList(files: selection.files)
        Button(L10n.t(.commonSend)) { sendFiles() }
            .buttonStyle(.borderedProminent)
            .disabled(selection.files.isEmpty)
            .accessibilityIdentifier("inbox-send-start")
    }

    private var filesSection: some View {
        Section {
            fileControls
        } header: {
            Text(InboxSendPresentation.label(for: .files))
                .accessibilityIdentifier("inbox-send-files-group")
        }
    }

    // MARK: - the history, both directions

    /// One deterministic list, newest first, with direction written on every row.
    ///
    /// The order is the store's — an immutable local event time with the local id
    /// as tie-break — and this view does not re-sort it. That is what makes a
    /// status poll about an outgoing delivery unable to move a row somebody is
    /// reading.
    private var timelineSection: some View {
        Section {
            if let conversation, !conversation.entries.isEmpty {
                ForEach(conversation.entries) { entry in
                    entryRow(entry)
                }
            } else {
                Text(L10n.t(.inboxTimelineEmpty))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("inbox-timeline-empty")
            }
        } header: {
            HStack {
                Text(L10n.t(.inboxTimelineHeading))
                    .accessibilityIdentifier("inbox-timeline")
                Spacer()
                if let conversation, !conversation.receivedFileURLs.isEmpty {
                    Button(L10n.t(.inboxRevealFolder)) { inbox.reveal(conversation) }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("inbox-conversation-reveal")
                }
                if let conversation, !conversation.entries.isEmpty {
                    // Named for THIS MAC in the control itself, not only in the
                    // explanation behind it. The snapshot is taken here, at the
                    // moment the user asked — see `deletingConversation`.
                    Button(L10n.t(.inboxConversationDelete)) {
                        deletingConversation = conversation.entryIDs
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-conversation-delete")
                }
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
            // **No second Stop button here, deliberately.** The control that
            // actually ends a transfer is `DeliveryActionButton`, which is the
            // only place in macOS that activates one — it decides which of the
            // two cancels applies, which needs a credential, and which has to
            // warn that the delivery may still arrive. A copy of it inside this
            // dialog would be that decision written twice, and the copy is the
            // one that would forget the warning. It is already on this page,
            // drawn as the prominent control of the section above, and the body
            // below points at it.
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
                // Exactly the ids that were on screen when the button was
                // pressed. A delivery committed since then was never observed,
                // gets no tombstone, and stays as a new unread row.
                inbox.deleteConversation(peerDeviceID: peerID, observedEntryIDs: observed)
                deliveries.refreshOutstanding()
                deletingConversation = nil
            }
            .accessibilityIdentifier("inbox-conversation-delete-confirm")
            Button(L10n.t(.commonCancel), role: .cancel) { deletingConversation = nil }
        } message: { _ in
            Text(InboxTimelinePresentation.conversationDeleteBody(peerName: peerName))
        }
        .onAppear { inbox.markConversationRead(peerID) }
    }

    /// One row: direction in words, the content, what is known about it, when,
    /// and the command menu.
    @ViewBuilder
    private func entryRow(_ entry: InboxTimelineEntry) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                // **Direction as a sentence, with the symbol as decoration.**
                // Alignment and tint are how a chat app says this and neither
                // survives VoiceOver or a monochrome screen, so the words carry
                // it and the glyph is hidden.
                HStack(spacing: 4) {
                    Image(systemName: InboxTimelinePresentation.directionSymbol(of: entry))
                        .accessibilityHidden(true)
                    Text(InboxTimelinePresentation.direction(of: entry, peerName: peerName))
                        .font(.caption.weight(.semibold))
                        .accessibilityIdentifier("inbox-entry-direction")
                }
                entryBody(entry)
                if let state = InboxTimelinePresentation.state(of: entry) {
                    HStack(spacing: 4) {
                        if let symbol = InboxTimelinePresentation.stateSymbol(of: entry) {
                            Image(systemName: symbol).accessibilityHidden(true)
                        }
                        Text(state)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("inbox-entry-state")
                    }
                }
                Text(InboxTimelinePresentation.at(entry))
                    .font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(InboxTimelinePresentation.accessibilityLabel(
                of: entry, peerName: peerName))
            Spacer()
            // **A visible command, not only a context menu.** A right-click is
            // not discoverable and is not reachable from the keyboard; the
            // context menu below duplicates this one for the people who expect
            // it there.
            Menu {
                deleteButton(entry)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel(InboxTimelinePresentation.menuLabel(of: entry,
                                                                    peerName: peerName))
            .accessibilityIdentifier("inbox-entry-menu")
        }
        .contextMenu { deleteButton(entry) }
    }

    /// Never deletes on its own. It raises the confirmation, which is the one
    /// place any of this can actually happen.
    private func deleteButton(_ entry: InboxTimelineEntry) -> some View {
        Button(L10n.t(.inboxEntryDelete), role: .destructive) {
            deletingEntry = entry
        }
        .accessibilityIdentifier("inbox-entry-delete")
    }

    @ViewBuilder
    private func entryBody(_ entry: InboxTimelineEntry) -> some View {
        if entry.kind == .message, let message = messageBody(entry) {
            Text(message.text).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Button(L10n.t(copiedEntryID == entry.id ? .commonCopied : .commonCopy)) {
                copyReceivedMessage(message.text)
                copiedEntryID = entry.id
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(InboxMessagePresentation.copyActionLabel(
                copied: copiedEntryID == entry.id))
        } else if entry.kind == .files {
            Text(InboxTimelinePresentation.fileNames(of: entry))
                .textSelection(.enabled)
        } else if entry.direction == .sent {
            // A body this Mac no longer holds — the process died between the
            // durable plan and the body being written, and the staged copy went
            // with the plan. Said out loud rather than drawn as an empty row.
            InlineMessage(.warning, L10n.t(.inboxSentMessageMissing))
                .accessibilityIdentifier("inbox-sent-message-missing")
        } else {
            InlineMessage(.failure, L10n.t(.inboxConversationMessageMissing))
                .accessibilityIdentifier("inbox-conversation-message-missing")
        }
    }

    /// The protected body behind one row, read from the store its direction owns.
    /// The two namespaces are separate directories on purpose: task ids and job
    /// ids are minted by different systems and nothing makes them disjoint.
    private func messageBody(_ entry: InboxTimelineEntry) -> InboxMessage? {
        entry.direction == .received ? inbox.message(for: entry) : inbox.sentMessage(for: entry)
    }

    /// The live delivery behind an outgoing row, if this session is running one.
    /// Used to tell the confirmation that deleting will not stop it, and to
    /// offer the control that would.
    private func runningItem(for entry: InboxTimelineEntry) -> InboxSendItem? {
        guard let jobID = entry.jobID else { return nil }
        return deliveries.items.first { $0.id == jobID }
    }

    // MARK: - actions

    /// Everything on this page that belonged to the device it has just been
    /// reused away from: the batch nobody sent, and the refusal describing a drag
    /// onto it. Both name a device that is no longer on screen, and the batch in
    /// particular is one Send would seal to the new one.
    ///
    /// A send already handed to `InboxSendModel` is untouched and must be: it
    /// copied the bytes into this app's own storage under a durable plan and is
    /// addressed to the device it was started for.
    private func discardStagedDevice() {
        selection.clear()
        dropRefusal = nil
    }

    /// The one place this page spends the bearer on a file send.
    private func sendFiles() {
        guard let token = liveToken() else { return }
        // No shared draft travels with a macOS device send: the picker is this
        // view's own `SelectionStore`, so there is nothing another process
        // staged and nothing this delivery could be authorized to retire.
        deliveries.send(files: selection.files, sourceDraftId: nil, token: token)
        // Cleared only once the model has taken the batch without refusing it.
        // A staging refusal leaves the files staged, so the user can read what
        // went wrong and press Send again rather than re-picking a folder. The
        // drag refusal goes with the batch: it was about items that are no
        // longer what this group is showing.
        if deliveries.refusal == nil { selection.clear(); dropRefusal = nil }
    }

    /// The one place this page spends the bearer on a message.
    ///
    /// The body goes to `sendText` and nowhere else — not to a published
    /// property, not to a card, not to a log. What leaves this view with it is
    /// the model, which hands it to the protected sent-message store and to the
    /// seal, and nothing else.
    private func sendMessage() {
        guard let token = liveToken() else { return }
        deliveries.sendText(draft, token: token)
        // Emptied only when the model accepted it. Every pre-flight refusal —
        // empty, too long, no capability, already sending, no credential — is
        // set synchronously by `sendText` before it returns, so a message that
        // was refused is still in the composer for the user to fix rather than
        // gone with an error where it used to be.
        if deliveries.refusal == nil { draft = "" }
    }

    /// The live credential, or a route to the one screen that explains why there
    /// is not one. Rendering an allowed surface and activating a button on it
    /// are different turns, and sign-out can land between them.
    private func liveToken() -> String? {
        guard let token = session.bearerToken, !token.isEmpty,
              case .allowed = AccountGate.from(session.state, bearer: token) else {
            onAccount()
            return nil
        }
        return token
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
