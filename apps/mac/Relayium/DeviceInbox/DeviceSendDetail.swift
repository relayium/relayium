import RelayiumAppKit
import SwiftUI

/// **One device's own send screen — the child of My Devices, and the only place
/// in macOS where a delivery is composed.**
///
/// ## Why the content controls are here and nowhere else
///
/// They used to be siblings of the receive controls on the Device Inbox landing
/// page: a file picker, a device list and a Send button rendered under the folder
/// grant and the receive policy, in one grouped form. That screen offered *Choose
/// Files or Folders…* a short scroll above *Choose Folder* — one about what is
/// being sent, the other about where deliveries are received — and a user who
/// pressed the picker first had staged files with no device chosen and no
/// statement anywhere that one was required. The owner reported it as send
/// controls dumped into the main page.
///
/// The hierarchy is the repair, and it is expressed twice: the landing page
/// carries the devices and no content control at all, and this screen carries the
/// content controls and is impossible to reach without having named a device. The
/// device's name is in this screen's own header, so the question "where is this
/// going" is answered above every control that could send something.
///
/// ## What binds this screen to exactly one device
///
/// `InboxSendModel.selectedCandidate`, and nothing else. `DeviceInboxSurface`
/// renders this view only while that is non-nil, and the model drops it whenever
/// the device stops being a legal destination: `adopt(_ rows:)` clears a
/// selection whose device went away, was revoked or had receiving switched off,
/// and `isolateFromPreviousAccount` clears it when the account changes. So the
/// three ways this binding can go stale all return the user to the list rather
/// than leaving a composer pointed at whichever row moved into that place — and
/// this screen re-reads the device list when it opens, so a device revoked while
/// the user was elsewhere is discovered before anything is typed rather than
/// after it is uploaded.
///
/// Every send this screen starts reads `selectedTargetID` back out of the model
/// at the moment of use. There is no device id held here to disagree with it.
///
/// ## One send is one kind
///
/// `InboxSendContentKind` is a closed set and exactly one of its controls is on
/// screen at a time. A mixed manifest is refused by the codec, so a composer
/// offering a message with an attachment could only ever produce a delivery no
/// receiver accepts — and this is the form of that rule a person can see.
struct DeviceSendDetail: View {
    /// The device this screen is about, as the model currently describes it.
    ///
    /// Passed in rather than read here, so this view cannot be rendered without
    /// one and cannot hold a stale copy: its host reads `selectedCandidate` on
    /// every redraw, and a device that stopped being sendable stops being passed.
    let target: InboxSendCandidate
    @ObservedObject var deliveries: InboxSendModel
    /// Where a refusal whose remedy is the account goes.
    let onAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    /// What is going, when what is going is files. Owned by this view exactly as
    /// `UploadPane` owns the stored-send one — the model owns what is being
    /// *delivered*, and a batch nobody has pressed Send on is not that yet.
    ///
    /// It goes with the screen, which is the honest lifetime: a selection staged
    /// for one device is not a selection for the next one, and carrying it back
    /// to the list would be a batch with no target on a page with no picker. A
    /// send already handed to the model is unaffected — `InboxSendModel.send`
    /// copies the bytes into this app's own storage under a durable plan.
    @StateObject private var selection = SelectionStore()

    /// The message being written. Exactly what the user typed: never trimmed,
    /// never normalized, never re-encoded. `sendText` is given this string and
    /// the receiver commits the same bytes.
    @State private var draft = ""

    var body: some View {
        headerSection
            // Re-read when this screen opens, so a device revoked or switched
            // off while the user was elsewhere is discovered here. The model
            // clears the selection on that answer, which returns this screen to
            // the list before anything is composed for a device that would
            // refuse it.
            .task { deliveries.refreshTargets(token: session.bearerToken ?? "") }
        activeSection
        // **No mode picker.** Each group states its own kind and carries its own
        // Send, which is the same repair `TransferSessionView` made when its
        // segmented *files or text?* control was removed: a control whose only
        // effect is to hide the other half makes a user who wanted to say
        // something choose a transport first. Both groups are always here, so
        // nothing is staged behind a tab the user cannot see, and which one
        // LEADS is `InboxSendComposer.order` — the working one, on a device that
        // cannot present a message.
        ForEach(InboxSendComposer.order(canReceiveText: target.canReceiveText),
                id: \.self) { kind in
            switch kind {
            case .message: messageSection
            case .files:   filesSection
            }
        }
    }

    // MARK: - which device, and the way back

    /// The device's name, above every control that could send something to it.
    private var headerSection: some View {
        Section {
            // The way out, first in reading order and first in the tab order —
            // a screen that can only be left by pressing the thing that sends is
            // not a screen somebody explores.
            Button {
                // The model's own selection IS the navigation state, so leaving
                // is one call and there is no second flag able to disagree with
                // it about which screen is up.
                deliveries.selectTarget(nil)
            } label: {
                Label(L10n.t(.sendBackToDevices), systemImage: "chevron.left")
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("inbox-send-back")
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(InboxSendPresentation.name(of: target))
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-send-device-name")
                Text(InboxSendPresentation.detail(for: target))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-send-device-detail")
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
    /// Only this device's: the landing page lists every outstanding delivery,
    /// and repeating them here would put another machine's Discard button on a
    /// screen headed with this one's name.
    @ViewBuilder
    private var activeSection: some View {
        if let item = InboxSendActions.current(in: deliveries.items,
                                               for: target.id) {
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
                // **Prominent, and it is the one control on this screen that
                // is.** A send that is preparing or uploading is the state a
                // person most urgently wants out of, and a Cancel drawn as one
                // bordered button among four is a Cancel they hunt for while
                // their files are moving. Which action that IS — stop this
                // device's attempt, or ask central to drop the delivery — is
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
    private var messageSection: some View {
        Section {
            messageControls
        } header: {
            Text(InboxSendPresentation.label(for: .message))
                .accessibilityIdentifier("inbox-send-message-group")
        }
    }

    @ViewBuilder
    private var messageControls: some View {
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
    /// No drop zone: this screen is a grouped `Form`, and a drop target inside a
    /// form row reads as a control the row does not have.
    @ViewBuilder
    private var fileControls: some View {
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
                Button(L10n.t(.commonClear)) { selection.clear() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-send-clear")
            }
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

    // MARK: - actions

    /// The one place this screen spends the bearer on a file send.
    private func sendFiles() {
        guard let token = liveToken() else { return }
        // No shared draft travels with a macOS device send: the picker is this
        // view's own `SelectionStore`, so there is nothing another process
        // staged and nothing this delivery could be authorized to retire.
        deliveries.send(files: selection.files, sourceDraftId: nil, token: token)
        // Cleared only once the model has taken the batch without refusing it.
        // A staging refusal leaves the files staged, so the user can read what
        // went wrong and press Send again rather than re-picking a folder.
        if deliveries.refusal == nil { selection.clear() }
    }

    /// The one place this screen spends the bearer on a message.
    ///
    /// The body goes to `sendText` and nowhere else — not to a published
    /// property, not to a card, not to a log. What the model keeps of it is its
    /// length.
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
