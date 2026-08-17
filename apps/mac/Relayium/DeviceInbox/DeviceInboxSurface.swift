import AppKit
import RelayiumAppKit
import RelayiumKit
import SwiftUI

/// The whole product surface for receiving files sent to this Mac from the
/// owner's own account — **one implementation, rendered in two places.**
///
/// ## Why it is one view and not two
///
/// It began as the ⌘, tab and was, for a while, the only full entry the feature
/// had: a user who did not already know to look in Settings could not find it at
/// all. The repair is a first-class sidebar destination, and the obvious way to
/// build one — a second view that renders the same controls — is the way the two
/// surfaces start telling the user different things. So the destination and the
/// settings tab are two hosts of this file: same sections, same copy, same
/// accessibility identifiers, same refusals. `InboxSurfaceGuardTests` checks
/// that neither host grows a control of its own.
///
/// ## Why the two consents are separate, on screen as well as in storage
///
/// Choosing a folder is an authorization the user gives this app. Turning
/// receiving on is a decision to let their other devices write into it without
/// them present. They are two different consents, so they are two different
/// controls, and choosing a folder leaves the policy exactly where it was. A
/// single "Receive files into…" control would silently make the first act imply
/// the second, which is the one thing PRD §8 says it must not do.
///
/// ## Why every state renders
///
/// `InboxRuntimeState` is a closed enum and this view switches over all of it
/// with no `default:`. The failure that matters is not an ugly screen — it is a
/// screen that says "Ready to receive" while the folder grant is revoked, which
/// tells the user their Mac will take a file it will in fact refuse. Each state
/// therefore renders its own sentence, and the ones that a person can act on
/// render the action beside it.
///
/// ## Accessibility identifiers live on leaves
///
/// Every identifier below is on a `Text`, a `Button` or a `Picker` option, never
/// on the `Section`, `HStack` or `VStack` containing them. SwiftUI propagates a
/// container's identifier downward, and this pane has already lost two controls
/// that way — the Reveal button inside a named result row, and all four answer
/// buttons inside a named Ask section. Both looked correct on screen.
struct DeviceInboxSurface: View {
    /// Where "Sign in" and "Create an account" go.
    ///
    /// Passed in rather than reached for, because the two hosts answer it
    /// differently and neither answer belongs here: the destination is already in
    /// the window that owns the Account destination and simply selects it, while
    /// the settings scene has to bring that window up first. What both must NOT
    /// do is open a website, which is what this feature's signed-out state used
    /// to offer instead of an action.
    let onAccount: (AuthMode) -> Void

    @EnvironmentObject private var inbox: InboxController
    /// The SEND half of the same capability.
    ///
    /// This surface shipped with only the receive half, and the consequence was
    /// not cosmetic: the only thing in the product that could start a device
    /// delivery was the Web app and the iOS Send tab, so a Mac could receive
    /// from a browser and could not send to another Mac at all. It is rendered
    /// here rather than under Send a link because the two are different products
    /// — a link anybody holding it can open, versus files sealed to one device
    /// with no link at all — and on macOS that choice is made by which
    /// destination you are on. See `DeviceSendSection`.
    @EnvironmentObject private var deliveries: InboxSendModel
    @EnvironmentObject private var loginItem: LoginItemPreference
    /// Read for exactly one thing: whether there is an account to sign in to, and
    /// what is standing in the way if there is not. The controller's own
    /// `isSignedIn` cannot answer that — it only knows whether it adopted one —
    /// so a signed-out pane built on it alone could say nothing more useful than
    /// "sign in", including to somebody whose address is merely unverified.
    @EnvironmentObject private var session: AccountSession
    /// Which row last had its Copy pressed, so that button can say "Copied".
    ///
    /// Keyed by the delivery's id rather than by its position, because the list
    /// is newest first and a message arriving while the pane is open would move
    /// the confirmation onto somebody else's row. It is never rendered — it is
    /// compared, and the row's visible text is the message and its time.
    @State private var copiedMessageID: String?
    @State private var selectedConversationID: String?

    private var entry: DeviceInboxEntry {
        DeviceInboxEntry.entry(
            gate: AccountGate.from(session.state, bearer: session.bearerToken),
            isSignedIn: inbox.isSignedIn)
    }

    var body: some View {
        Form {
            // No `default:`. A new entry case is a compile error here rather than
            // a Device Inbox that renders whichever branch happened to be last.
            switch entry {
            case .surface:
                // **The one place this surface has a child, and it is a child of
                // the whole page rather than of a section inside it.**
                //
                // A device's send screen replaces the receive controls instead
                // of appearing under them, because the failure being repaired is
                // exactly that they were siblings: a file picker and a Send
                // button rendered a short scroll below the receive folder's own
                // *Choose Folder*, with nothing on screen saying which of the
                // two directions either belonged to. Stacking the composer under
                // them would reproduce that with more controls, not fewer.
                //
                // `selectedCandidate` is the whole of the navigation state, and
                // it belongs to `InboxSendModel`. That is what makes the exits
                // safe rather than remembered: a device revoked, switched off,
                // removed from the account, or left behind by a sign-out clears
                // the model's selection, and this branch returns to the list on
                // the same redraw. A `@State` flag here could stay true over a
                // device that no longer exists.
                if let target = deliveries.selectedCandidate {
                    DeviceSendDetail(target: target, deliveries: deliveries,
                                     onAccount: { onAccount(.signIn) })
                } else if let id = selectedConversationID,
                          let conversation = inbox.conversations.first(where: { $0.id == id }) {
                    conversationDetail(conversation)
                } else {
                    statusSection(offersControls: true)
                    notificationSection
                    askSection
                    folderSection
                    policySection
                    conversationsSection
                    // The devices, in the one branch where the account is usable
                    // for sending. Deliberately NOT in `.statusOnly`: that branch
                    // exists because the receiver refused this account's
                    // identifier, and the send half stages a durable plan under
                    // the same identifier — so it would offer a send whose only
                    // outcome is a staging failure.
                    DeviceSendSection(deliveries: deliveries,
                                      onAccount: { onAccount(.signIn) })
                    residencySection
                }
            case .statusOnly:
                statusSection(offersControls: false)
            case let .account(gate):
                accountSection(gate)
            }
            // OUTSIDE the switch and after it, so help is the last section in
            // every one of the three branches rather than a section the
            // signed-out reader — the one most likely to need it — never sees.
            // It is a `Section`, not a card: this surface is a grouped `Form`,
            // and nothing here adds a second scroll view around it.
            HelpFormSection(surface: .deviceInbox)
        }
        .formStyle(.grouped)
        // Re-measured when the surface appears rather than on every redraw: the
        // probe creates and removes a real file in the user's folder, and the
        // grant can be revoked while the app runs with nothing notifying it.
        .task {
            inbox.refreshFolder()
            inbox.refreshNotificationPermission()
            loginItem.refresh()
        }
        // The other half of "it updates when authorization changes", and the half
        // that matters: the user presses the button below, switches Relayium's
        // notifications back on in System Settings, and comes back to this window.
        // macOS publishes nothing when that switch moves — there is no
        // authorization-changed notification to subscribe to — so becoming active
        // again is the event, and re-asking is the only mechanism there is. The
        // `.task` above fires once per appearance and would leave a stale warning
        // on a surface that stayed open the whole time.
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didBecomeActiveNotification)) { _ in
            inbox.refreshNotificationPermission()
        }
        .onChange(of: inbox.activeAccountID) { _ in
            selectedConversationID = nil
            copiedMessageID = nil
        }
    }

    // MARK: - conversations

    private var conversationsSection: some View {
        Section {
            if inbox.conversationStoreIssue {
                InlineMessage(.failure, L10n.t(.inboxConversationStoreIssue))
                    .accessibilityIdentifier("inbox-conversation-store-issue")
            }
            ForEach(inbox.conversations) { conversation in
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            if conversation.unreadCount > 0 {
                                Circle().fill(.red).frame(width: 8, height: 8)
                                    .accessibilityHidden(true)
                            }
                            Text(conversationName(conversation))
                                .fontWeight(conversation.unreadCount > 0 ? .semibold : .regular)
                        }
                        Text(conversationSummary(conversation))
                            .font(.caption).foregroundStyle(.secondary)
                        if conversation.unreadCount > 0 {
                            Text(L10n.t(.inboxConversationUnread,
                                        [L10n.number(conversation.unreadCount)]))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button(L10n.t(.inboxOpenDeviceInbox)) {
                        selectedConversationID = conversation.id
                        inbox.markConversationRead(conversation.id)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel(L10n.detail([
                        L10n.t(.inboxOpenDeviceInbox), conversationName(conversation)]))
                    .accessibilityIdentifier("inbox-conversation-open")
                }
            }
        } header: {
            Text(L10n.t(.inboxConversationsHeading))
                .accessibilityIdentifier("inbox-conversations")
        }
    }

    private func conversationName(_ conversation: InboxConversation) -> String {
        if conversation.senderDeviceID == InboxConversationStore.legacySenderID {
            return L10n.t(.inboxConversationLegacy)
        }
        let name = inbox.displayName(for: conversation)
        return inbox.isRemoved(conversation.senderDeviceID)
            ? L10n.detail([name, L10n.t(.inboxConversationRemoved)]) : name
    }

    private func conversationSummary(_ conversation: InboxConversation) -> String {
        var parts: [String] = []
        let unread = conversation.deliveries.filter { $0.readAt == nil }
        let unreadMessages = unread.filter { $0.kind == .message }.count
        let unreadFiles = unread.reduce(0) { $0 + $1.files.count }
        if unreadMessages > 0 {
            parts.append(L10n.detail([
                L10n.number(unreadMessages), L10n.t(.inboxSavedMessage)]))
        }
        if unreadFiles > 0 {
            parts.append(L10n.plural(.inboxSavedFiles, unreadFiles))
        }
        parts.append(L10n.date(conversation.lastActivity, dateStyle: .medium,
                               timeStyle: .short))
        return L10n.detail(parts)
    }

    private func conversationDetail(_ conversation: InboxConversation) -> some View {
        Group {
            Section {
                Button(L10n.t(.sendBackToDevices)) { selectedConversationID = nil }
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("inbox-conversation-back")
                if let candidate = deliveries.candidates.first(where: {
                    $0.id == conversation.senderDeviceID && $0.isSendable
                }) {
                    Button(L10n.t(.inboxSendContent)) {
                        deliveries.selectTarget(candidate.id)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("inbox-conversation-send")
                }
            } header: {
                Text(conversationName(conversation))
            }
            Section {
                ForEach(conversation.deliveries) { delivery in
                    VStack(alignment: .leading, spacing: 5) {
                        if delivery.kind == .message, let message = inbox.message(for: delivery) {
                            Text(message.text).textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            Button(L10n.t(copiedMessageID == message.id
                                          ? .commonCopied : .commonCopy)) {
                                copyReceivedMessage(message.text)
                                copiedMessageID = message.id
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel(InboxMessagePresentation.copyActionLabel(
                                copied: copiedMessageID == message.id))
                        } else if delivery.kind == .files {
                            Text(delivery.files.map(\.displayName).joined(separator: " · "))
                                .textSelection(.enabled)
                        } else {
                            InlineMessage(.failure, L10n.t(.inboxConversationMessageMissing))
                                .accessibilityIdentifier("inbox-conversation-message-missing")
                        }
                        Text(L10n.date(delivery.receivedAt, dateStyle: .medium,
                                       timeStyle: .short))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: {
                HStack {
                    Text(L10n.t(.inboxResultsHeading))
                    Spacer()
                    if conversation.fileCount > 0 {
                        Button(L10n.t(.inboxRevealFolder)) { inbox.reveal(conversation) }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("inbox-conversation-reveal")
                    }
                }
            }
        }
        .onAppear { inbox.markConversationRead(conversation.id) }
    }

    // MARK: - no usable account

    /// Signed out, unverified, frozen, or still restoring — and every one of them
    /// with something the user can press.
    ///
    /// `CapabilityGateView` is reused rather than reimplemented for the reason it
    /// exists: it answers all five reasons an account is unavailable with the one
    /// action that resolves each, and this pane previously answered all five with
    /// the same two sentences and no action at all. A user whose address is
    /// merely unverified was told to sign in, which they had already done.
    private func accountSection(_ gate: AccountGate) -> some View {
        Section {
            // Signed out, this gate is the entire surface — the status, folder,
            // policy and results sections are not rendered at all — so Sign in
            // is the page's primary exit and is drawn as one.
            CapabilityGateView(gate: gate,
                               title: L10n.t(.inboxSignedOut),
                               body: L10n.t(.inboxSignedOutBody),
                               isWholeSurface: true,
                               onAccount: onAccount)
        } header: {
            // **Account, not Device Inbox.** The window title and the sidebar row
            // both already say Device Inbox, and this section is not the feature
            // — it is the one thing standing between the reader and it. Naming
            // the requirement is what a section header is for.
            //
            // The identifier is on the header LEAF, never on the `Section`. This
            // branch contains two buttons, and a container identifier renames
            // every control inside it — the propagation defect this pane has
            // already lost a control to twice.
            Text(L10n.t(.navAccount))
                .accessibilityIdentifier("inbox-signed-out")
        } footer: {
            // What the feature actually does, said to somebody who has not
            // committed to it yet. A destination that is visible signed out and
            // explains nothing is a row that reads as an advertisement.
            caption(L10n.t(.inboxExplain))
        }
    }

    // MARK: - status

    /// The status line, and — only where they can work — the controls beside it.
    ///
    /// `offersControls` is false in exactly one place, and it is not cosmetic.
    /// `retryNow`, `resume` and `pause` all return immediately when the controller
    /// holds no generation, so an account the receiver could not adopt would
    /// otherwise render Try again and Pause as buttons that do nothing when
    /// pressed. This app has already shipped one recovery button whose action was
    /// a `break`; the answer is not to render it.
    private func statusSection(offersControls: Bool) -> some View {
        Section {
            StatusBadge(symbol: symbol, tint: tint,
                        label: InboxStatusPresentation.text(for: inbox.state))
                .accessibilityIdentifier("inbox-status")
            // **A route, not a progress bar, and it says so by claiming
            // nothing.** Every stop's `progress` is nil: the Device Inbox has no
            // per-delivery position to be part-way through, and the live state —
            // ready, working, paused, offline — is the badge directly above, in
            // words. What the rail adds is the shape of the path those words
            // describe, and it stops there.
            //
            // It used to hang the receive folder off its last stop, which put
            // "No folder chosen" — or the whole path — on screen twice, a short
            // scroll above the folder section that owns the fact and carries the
            // buttons that change it. One authoritative place per fact, and for
            // the folder that place is `folderSection`, not this.
            PathRail(stops: PathRailPresentation.deviceInbox())
            // `.answer` is deliberately absent: its controls are the Receive and
            // Decline buttons in the section below, and a button here would carry
            // the recovery's name while doing nothing when pressed.
            if offersControls,
               let recovery = InboxStatusPresentation.recovery(for: inbox.state),
               recovery != .answer {
                Button(InboxStatusPresentation.label(for: recovery)) { perform(recovery) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-recovery")
            }
            // Every refused action EXCEPT the notification one. That single
            // exception is rendered beside the button that produced it in the
            // section below, because a refusal that appears three sections away
            // from the control the user just pressed reads as an unrelated fault.
            if let error = inbox.settingsError, error != .notificationSettingsUnavailable {
                InlineMessage(.failure, InboxSettingsErrorCopy.message(error))
                    .accessibilityIdentifier("inbox-error")
            }
            // Pause is offered only where it means something. A paused inbox
            // already renders Resume as its recovery action above, and pausing
            // an inbox that is Off or has no folder would be a control with no
            // effect on anything.
            if offersControls, canPause {
                Button(L10n.t(.inboxPause)) { inbox.pause() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-pause")
            }
            if !offersControls {
                // The one route that is genuinely open here. An account the
                // receiver refused is fixed on the Account destination — by
                // signing in again, or by leaving and returning — and saying so
                // beats a status sentence with nothing under it.
                Button(L10n.t(.gateOpenAccount)) { onAccount(.signIn) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-open-account")
            }
        } header: {
            // The section, not the surface. `inboxTitle` here printed *Device
            // Inbox* directly under a window title and a highlighted sidebar row
            // that had both just said it, and named the whole feature rather than
            // the part of it this section is — the answer to "can this Mac take a
            // delivery right now".
            Text(L10n.t(.inboxStatusHeading))
        } footer: {
            caption(L10n.t(.inboxExplain))
        }
    }

    /// Pausing is meaningful exactly while the loop would otherwise be doing or
    /// waiting for work.
    private var canPause: Bool {
        switch inbox.state {
        case .ready, .working, .asking, .offline, .saved, .savedMessage, .loading:
            return true
        case .signedOut, .disabled, .folderMissing, .paused, .attention, .failed:
            return false
        }
    }

    /// Colour is never the only carrier — `StatusBadge` renders the symbol too,
    /// which is what keeps these states distinguishable with colour filters on.
    private var symbol: String {
        switch inbox.state {
        case .signedOut:      return "person.crop.circle.badge.questionmark"
        case .loading:        return "hourglass"
        case .disabled:       return "tray"
        case .folderMissing:  return "folder.badge.questionmark"
        case .ready:          return "tray.and.arrow.down"
        case .asking:         return "questionmark.circle"
        case .paused:         return "pause.circle"
        case .working:        return "arrow.down.circle"
        case .attention:      return "exclamationmark.triangle"
        case .offline:        return "wifi.slash"
        case .saved, .savedMessage: return "checkmark.circle"
        case .failed:         return "xmark.octagon"
        }
    }

    /// Taken from `InlineMessage.Kind` rather than named here, because exactly
    /// one file in this app may name the failure colour — the one that always
    /// draws a symbol beside it. `StatusBadge` does the same, so no state in this
    /// pane is carried by colour alone.
    private var tint: Color {
        switch inbox.state {
        case .ready, .saved, .savedMessage:        return .green
        case .working:                             return .accentColor
        case .attention, .failed:                  return InlineMessage.Kind.failure.tint
        case .asking, .offline, .folderMissing:    return InlineMessage.Kind.warning.tint
        case .signedOut, .loading, .disabled, .paused: return .secondary
        }
    }

    private func perform(_ recovery: InboxRecovery) {
        switch recovery {
        case .chooseFolder: chooseFolder()
        case .retry:        inbox.retryNow()
        case .resume:       inbox.resume()
        case .answer:       break   // never reached; see the guard on the caller
        }
    }

    // MARK: - banners

    /// Denied notification authorization, said truthfully.
    ///
    /// ## Why this is a section of its own and not a runtime state
    ///
    /// It renders beneath the status line rather than inside it because it is a
    /// different KIND of fact. `InboxRuntimeState` answers "can this Mac take a
    /// delivery"; the answer here is yes, unchanged — the folder still resolves,
    /// the policy still stands, the receiver still claims, decrypts and commits.
    /// What is off is the announcement. Folding this into `.attention` would put
    /// "needs attention" on the status line of an inbox that is working, which is
    /// the same untruth as `ready` over a revoked grant, aimed the other way.
    ///
    /// ## Why the second sentence is not optional
    ///
    /// The observed defect was silence: a denied Mac dropped the banner and said
    /// nothing anywhere. The obvious repair — a warning — creates the opposite
    /// failure, because a user reading "notifications are off" in the Device Inbox
    /// pane reasonably concludes the Device Inbox is not working and stops relying
    /// on it. So the explanation states that receiving and saving are unaffected,
    /// and it is asserted at runtime rather than left to whoever edits the copy.
    ///
    /// ## Why it only appears while signed in
    ///
    /// It is rendered from inside the `.surface` branch. Nothing can be delivered
    /// to a signed-out Mac, so there is no banner to miss and no reason to put a
    /// system-permission warning in front of someone who has not yet chosen to use
    /// the feature at all.
    @ViewBuilder
    private var notificationSection: some View {
        if let notice = InboxNotificationPermissionPresentation
            .notice(for: inbox.notificationPermission) {
            Section {
                InlineMessage(.warning, notice.title)
                    .accessibilityIdentifier("inbox-banners-blocked")
                caption(notice.explanation)
                // Not a `.link`: this is the recovery for a stated problem, and
                // it matches the bordered recovery button the status section
                // renders for every other actionable state in this pane.
                Button(notice.actionLabel) { inbox.openNotificationSettings() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-open-notification-settings")
                // The button's own refusal, beside the button. Reached when the
                // platform will not open its settings at all, which is the one
                // way this recovery can fail — and failing silently here would
                // reproduce the defect this section was added to remove.
                if inbox.settingsError == .notificationSettingsUnavailable {
                    InlineMessage(.failure, InboxSettingsErrorCopy
                        .message(.notificationSettingsUnavailable))
                        .accessibilityIdentifier("inbox-notification-settings-error")
                }
            }
        }
    }

    // MARK: - the held questions

    @ViewBuilder
    private var askSection: some View {
        if !inbox.asking.isEmpty {
            Section {
                // One row per held delivery, each answered on its own. A single
                // "Accept all" would answer for deliveries the user has not seen
                // arrive, which is the same mistake as auto-accepting.
                ForEach(Array(inbox.asking.enumerated()), id: \.element.id) { index, item in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            // The encrypted manifest is deliberately unavailable
                            // before acceptance. Number + ciphertext size still
                            // makes multiple pending choices visibly distinct.
                            Text(verbatim: "\(index + 1). \(L10n.plural(.inboxWaitingDeliveries, 1))")
                            Text(askDetails(item))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(L10n.t(.inboxAskAccept)) {
                            inbox.respond(toAsk: item.id, accept: true)
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("inbox-ask-accept-\(index)")
                        Button(L10n.t(.inboxAskDecline), role: .destructive) {
                            inbox.respond(toAsk: item.id, accept: false)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("inbox-ask-decline-\(index)")
                    }
                }
            } header: {
                Text(L10n.t(.inboxAskHeading))
                    .accessibilityIdentifier("inbox-ask")
            } footer: {
                caption(L10n.t(.inboxAskExplain))
            }
        }
    }

    private func askDetails(_ item: InboxAskItem) -> String {
        var details = [L10n.bytes(item.ciphertextBytes)]
        if item.expiresAt > 0 {
            let date = L10n.date(Date(timeIntervalSince1970: TimeInterval(item.expiresAt)),
                                 dateStyle: .medium, timeStyle: .short)
            details.append(L10n.t(.commonExpires, [date]))
        }
        return L10n.detail(details)
    }

    // MARK: - the folder grant

    private var folderSection: some View {
        Section {
            HStack {
                Text(InboxFolderPresentation.description(inbox.folder))
                    .accessibilityIdentifier("inbox-folder")
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(L10n.t(inbox.folder.isChosen ? .inboxChangeFolder : .inboxChooseFolder)) {
                    chooseFolder()
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("inbox-choose-folder")
            }
            if inbox.folder.isChosen {
                // Destructive, and it says so: removing the grant also switches
                // receiving off, because a stored "yes" with nowhere to write is
                // a decision waiting to be applied to whatever folder is chosen
                // next.
                Button(L10n.t(.inboxRemoveFolder), role: .destructive) { inbox.removeFolder() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-remove-folder")
            }
        } header: {
            Text(L10n.t(.inboxFolderHeading))
        } footer: {
            caption(L10n.t(.inboxFolderExplain))
        }
    }

    /// The system folder picker.
    ///
    /// `canChooseFiles = false` because a grant on a file is not a place to
    /// receive into, and `canCreateDirectories` because "somewhere new, just for
    /// this" is the most common honest answer to where deliveries should land.
    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.message = L10n.t(.inboxPickerMessage)
        panel.prompt = L10n.t(.inboxPickerPrompt)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        inbox.chooseFolder(url)
    }

    // MARK: - the policy

    private var policySection: some View {
        Section {
            // Bound through the controller rather than to stored state directly:
            // the setter REFUSES `ask` and `auto` without a folder, and a picker
            // bound to the raw value would show an answer the store never took.
            Picker(L10n.t(.inboxPolicyHeading), selection: Binding(
                get: { inbox.policy },
                set: { inbox.setPolicy($0) }
            )) {
                ForEach(InboxAutoAccept.allCases, id: \.self) { policy in
                    // On the LEAVES, the rule this file has now learned three
                    // ways. The result row and the Ask section learned it as
                    // propagation: an identifier on a container SwiftUI merges
                    // into one element renames the controls inside it. A `Picker`
                    // fails the opposite way and is worth naming separately,
                    // because the symptom looks like success. It builds a real
                    // AXRadioGroup with real children, and the identifier lands on
                    // the GROUP and stops there — measured on macOS 26.6,
                    // `inbox-policy` matched exactly one element while all three
                    // radio buttons carried an empty identifier.
                    //
                    // So the container read as correct in every check anyone
                    // wrote, and no choice inside it could be named at all: the
                    // only handle on one was its displayed English copy. The one
                    // assertion the suite could make was "the group exists",
                    // which is equally true of a picker nobody can operate.
                    //
                    // These three identifiers are what let a person or a tool say
                    // WHICH choice, and the distance between two of them is the
                    // distance between holding a delivery and writing it to disk
                    // unattended.
                    Text(InboxPolicyPresentation.label(for: policy))
                        .tag(policy)
                        .accessibilityIdentifier("inbox-policy-\(policy.rawValue)")
                }
            }
            .pickerStyle(.inline)
            // The label is kept and hidden, not removed. The enclosing section
            // header says *Receiving* two lines above, so an inline picker
            // repeating its own title printed the same word twice with nothing
            // between them; a picker built with no label at all would read as
            // "radio group" and nothing else to VoiceOver, which is the opposite
            // mistake. `labelsHidden()` drops the glyphs and keeps the name.
            .labelsHidden()
        } header: {
            // The section's own marker moved here when it came off the picker
            // above, matching the Ask section: a header `Text` is a leaf, so it
            // names the section without reaching into the controls inside it.
            Text(L10n.t(.inboxPolicyHeading))
                .accessibilityIdentifier("inbox-policy")
        } footer: {
            caption(L10n.t(.inboxPolicyExplain))
        }
    }

    // MARK: - what actually arrived

    /// **What arrived, named — and one way to go and look at it.**
    ///
    /// ## Why the rows changed
    ///
    /// Each row rendered a count: "1 file saved · 12 KB · 9 Aug 2026 at 14:05".
    /// Three deliveries therefore produced three rows a reader could not tell
    /// apart, and the only way to learn what any of them was was to leave the
    /// app. The reasoning behind the count was a real one — a file name is the
    /// user's own content — but it is the rule for a NOTIFICATION, which macOS
    /// draws on a locked screen unasked. This is a list somebody opened on their
    /// own Mac to find out what they received. `InboxReceiptPresentation` now
    /// names the files here and still names nothing in the banner.
    ///
    /// ## Why there is one Finder button and not one per row
    ///
    /// Every row also carried its own *Show in Finder*, so the section was a
    /// column of identical controls next to a column of identical text. They all
    /// open the same place — deliveries land in the one folder the user granted —
    /// so the action belongs to the section, and it is rendered in the header
    /// where a section-wide action is looked for. `InboxSurfaceGuardTests` counts
    /// it, because "one" is the requirement rather than "at least one".
    private var resultsSection: some View {
        Section {
            if inbox.results.isEmpty {
                Text(L10n.t(.inboxResultsEmpty))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("inbox-results-empty")
            } else {
                ForEach(inbox.results) { receipt in
                    // A leaf, and the whole row. There is no control inside it
                    // any more, so there is nothing left for an identifier on a
                    // container to rename — the propagation defect this pane has
                    // lost two controls to is gone by construction here rather
                    // than avoided by arrangement.
                    Text(InboxReceiptPresentation.summary(receipt))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("inbox-result")
                }
            }
        } header: {
            HStack {
                Text(L10n.t(.inboxResultsHeading))
                Spacer()
                // Rendered only where it can work. Without a folder grant there
                // is nowhere to open, and `revealReceiveFolder` correctly does
                // nothing — which is the button whose action is a `break` that
                // this app has already shipped once and does not render again.
                if inbox.folder.isChosen {
                    Button(L10n.t(.inboxRevealFolder)) { inbox.revealReceiveFolder() }
                        .buttonStyle(.bordered)
                        .accessibilityLabel(
                            InboxReceiptPresentation.revealFolderLabel(inbox.folder))
                        .accessibilityIdentifier("inbox-reveal-folder")
                }
            }
        }
    }

    // MARK: - what arrived that was not a file

    /// **Received messages, shown as messages — the surface `inbox.text.v1` is
    /// a claim about.**
    ///
    /// ## Why this section had to exist before the capability could be announced
    ///
    /// The token means "this receiver presents a text delivery AS text", and a
    /// sender reads it to decide whether offering a text send to this Mac would
    /// be honest. Until this section existed, everything below it was true — a
    /// message was decoded, committed whole to a protected per-account store and
    /// never written into the receive folder — and the user still had no way to
    /// read one. The status line said *Message received*; the Recently received
    /// row said *Message received*; the banner said *Message received*; and the
    /// message itself was on the disk with nothing to open it. That is the
    /// state the announcement was rejected for, and this is the repair.
    ///
    /// ## What a row shows, and what it deliberately does not
    ///
    /// The time it arrived, the message in full, and Copy. No sender, no length,
    /// no truncation and no preview — the body is `InboxMessage.text` rendered
    /// unchanged, because a person opening this pane is here to read it. That is
    /// the opposite rule from `InboxNotifier`, which macOS draws on a locked
    /// screen unasked and which is therefore not allowed to name anything; both
    /// rules hold at once because they describe different rooms.
    ///
    /// ## Why Copy, and why it is the exact bytes
    ///
    /// A message that arrives on a Mac is almost always on its way somewhere
    /// else — a terminal, a form, a door code typed into a keypad. Selection
    /// alone would leave a body of several thousand characters to be dragged
    /// through. `copyReceivedMessage` writes `message.text` and nothing else:
    /// not a summary, not a trimmed copy, not the row's rendering of it.
    ///
    /// ## Why it is rendered only when it has something to say
    ///
    /// Like `askSection` above, and unlike `resultsSection`, which has an empty
    /// state because a Mac that has received no files still wants to know where
    /// they would land. A Mac that has never been sent a message has nothing to
    /// explain, and an empty section here would advertise a feature to somebody
    /// who cannot act on it.
    @ViewBuilder
    private var messagesSection: some View {
        if !inbox.messages.isEmpty {
            Section {
                // Newest first, from the store's own order — see
                // `InboxMessageStore.all()`, which breaks a same-second tie so
                // this list cannot reshuffle under the reader between two
                // redraws.
                ForEach(Array(InboxMessagePresentation.shown(inbox.messages).enumerated()),
                        id: \.element.id) { index, message in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(InboxMessagePresentation.receivedAt(message))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("inbox-message-received-\(index)")
                            Spacer()
                            // On the LEAF, and named per row: this is the one
                            // section in the pane with a column of identical
                            // controls, which is the arrangement the propagation
                            // defect at the top of this file bites hardest.
                            Button(L10n.t(copiedMessageID == message.id
                                          ? .commonCopied : .commonCopy)) {
                                copyReceivedMessage(message.text)
                                copiedMessageID = message.id
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel(InboxMessagePresentation.copyActionLabel(
                                copied: copiedMessageID == message.id))
                            .accessibilityIdentifier("inbox-message-copy-\(index)")
                        }
                        // The message, whole. `fixedSize` because a Form row
                        // otherwise truncates it to one line, which would put
                        // this pane back where it started: a message on the disk
                        // the user cannot read.
                        Text(message.text)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("inbox-message-\(index)")
                    }
                }
                // Counted, never dropped. Nothing here deletes a message, so a
                // section that stopped at its bound in silence would be the one
                // thing that could make one look deleted.
                if let more = InboxMessagePresentation.more(inbox.messages) {
                    caption(more)
                        .accessibilityIdentifier("inbox-messages-more")
                }
            } header: {
                Text(InboxMessagePresentation.heading())
                    .accessibilityIdentifier("inbox-messages")
            } footer: {
                caption(InboxMessagePresentation.explanation())
            }
        }
    }

    // MARK: - residency

    /// The same complete residency control the settings pane offers, and the
    /// same component rather than a second rendering of it.
    ///
    /// This used to be a bare `Toggle` greyed out on one state with nothing
    /// beside it — the dead switch the settings pane had already learned to
    /// explain, kept alive by being written twice. Whatever `LoginItemSetting`
    /// shows for a state, both surfaces now show.
    private var residencySection: some View {
        Section {
            LoginItemSetting()
            // Said outright, because the checkbox invites exactly the wrong
            // inference: it decides whether Relayium is RUNNING after a login,
            // which is a different claim from whether the inbox is ready now.
            // The status line above is the one that answers that.
            caption(L10n.t(.inboxLoginNote))
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One clipboard write, of exactly what was received.
///
/// A free function beside the view for the reason the transfer pane's is one: it
/// is two AppKit calls, and a shared helper in `RelayiumAppKit` would put
/// `NSPasteboard` in a module that renders nothing.
///
/// It takes the STRING and not the message, which is the same refusal the
/// notification-settings seam makes by taking nothing at all: there is no
/// parameter here through which a task id, a receipt or a path could reach the
/// pasteboard, and the one call site passes `message.text` and nothing else.
@MainActor
private func copyReceivedMessage(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
