import SwiftUI
import RelayiumAppKit
import RelayiumKit

/// **This device as a destination: what the account's other devices have sent
/// here, and the way to send them something back.**
///
/// ## What is new, and what it replaced
///
/// iOS composed the SEND half of the Device Inbox and none of the receive half.
/// Delivering to one of the account's own devices was a segmented control inside
/// the Send tab — *As a link* / *To a device* — and there was no receiver at all:
/// no `InboxController`, no conversation, no timeline, and no way for another
/// device to reach this one. This destination is the other half, and the
/// segmented control is gone with it. The two kinds of send are different
/// products, and which one you get is now decided by **which destination you are
/// on**, exactly as it already is on macOS (`DeviceSendSection`'s own comment is
/// the argument).
///
/// ## Foreground-only, said on the screen rather than only in the code
///
/// This app declares no background mode, no push and no notification, and this
/// slice adds none. The receiver runs while Relayium is open; the process is
/// suspended when the user leaves, and `InboxController.foreground(_:)` stops the
/// loop rather than letting a cancelled pass look like a live one. That is a
/// real limitation — a file sent to a locked phone arrives when the phone's owner
/// next opens the app — so `inbox.iosForegroundOnly` is rendered unconditionally,
/// next to the status, and not as an error state somebody has to reach.
///
/// ## Two consents, and only one of them is asked here
///
/// macOS asks for a folder and then, separately, for permission to write into it
/// unattended. There is no folder question on iOS: deliveries land in
/// `Documents/Received`, which is the app's own container and the same directory
/// a stored-link download writes into. The RECEIVING consent is unchanged and
/// still explicit, still account-scoped and still default-off — a fixed
/// destination removes the folder question, never the permission one.
///
/// ## Nothing here decides anything
///
/// Which entry to draw is `DeviceInboxEntry`'s; every status sentence is
/// `IOSInboxCopy`'s; the conversation rows are `InboxTimelinePresentation`'s; and
/// which device is open is `InboxSendModel.focusedPeerID`, which is also what
/// `isolateFromPreviousAccount` clears on an account switch — so this view's
/// navigation path empties itself when the account leaves rather than needing to
/// remember to. All of those are drivable by `swift test`; a `switch` in a view
/// is a `switch` no test can reach.
struct DeviceInboxView: View {
    @ObservedObject var inbox: InboxController
    @ObservedObject var deliveries: InboxSendModel
    /// Selects the Account destination. A closure rather than a session read, so
    /// the shell above stays ignorant of the account.
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    var body: some View {
        NavigationStack(path: conversationPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.section) {
                    content
                }
                .padding()
                // Leading, not centred: at the largest Dynamic Type sizes a
                // centred ragged column is unreadable.
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.inboxTitle))
            .navigationDestination(for: String.self) { peerID in
                DeviceConversationView(peerID: peerID, inbox: inbox,
                                       deliveries: deliveries,
                                       onOpenAccount: onOpenAccount)
            }
        }
        // The account's device list, read when this destination appears and by
        // the refresh control inside it. Never on a timer: this is a directory,
        // not a presence feed.
        .task { refreshTargets() }
    }

    /// **The navigation path IS `InboxSendModel.focusedPeerID`.**
    ///
    /// One authority, not a `@State` mirror of one. That matters for a case a
    /// mirror gets wrong: `isolateFromPreviousAccount` drops the focus when the
    /// account changes, so an account switch while a conversation is open pops
    /// straight back to the list — rather than leaving the previous account's
    /// device page on screen with a composer aimed at it. `focusPeer` is also
    /// what `selectedCandidate` is derived from, so the page that opens and the
    /// device that may be sent to can never be two different answers.
    private var conversationPath: Binding<[String]> {
        Binding(get: { deliveries.focusedPeerID.map { [$0] } ?? [] },
                // `last`, so a system back gesture and a programmatic pop both
                // reduce to the same single write.
                set: { deliveries.focusPeer($0.last) })
    }

    /// Which of the three surfaces this destination is, decided once in
    /// `DeviceInboxEntry` and rendered here.
    ///
    /// The `switch` has no `default` and the entry type has no fall-through
    /// case: `statusOnly` exists precisely so that an account the receiver could
    /// not adopt renders the truthful status and the route to the account,
    /// rather than a policy control whose setter would return immediately.
    @ViewBuilder
    private var content: some View {
        switch DeviceInboxEntry.entry(gate: gate, isSignedIn: inbox.isSignedIn) {
        case .surface:
            statusSection
            policySection
            askSection
            DeviceDeliveryList(deliveries: deliveries, onOpenAccount: onOpenAccount)
            conversationsSection
        case .statusOnly:
            statusSection
            openAccountCard(title: L10n.t(.inboxSignedOut),
                            message: L10n.t(.inboxIOSSignedOutBody))
        case .account(let gate):
            accountSection(gate)
        }
    }

    private var gate: AccountGate {
        AccountGate.from(session.state, bearer: session.bearerToken)
    }

    // MARK: - status, and the one limitation that defines this platform

    private var statusSection: some View {
        SectionCard {
            // The route, stated as a shape rather than as a claim about any one
            // delivery — and ending at THIS device, not at a Mac.
            PathRail(stops: PathRailPresentation.iosDeviceInbox())

            Text(IOSInboxCopy.status(for: inbox.state))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inbox-status")

            // Present only where there is something to do. `IOSInboxCopy`
            // guarantees this can never be Choose Folder — the control this
            // platform cannot draw — which is the whole reason it overrides the
            // shared rule rather than reusing it.
            if let recovery = IOSInboxCopy.recovery(for: inbox.state) {
                Button(IOSInboxCopy.label(for: recovery)) { perform(recovery) }
                    .borderedAction()
                    .controlSize(.large)
                    .accessibilityIdentifier("inbox-recovery")
            }

            // **The sentence that makes this screen honest on a phone**, and it
            // is rendered in every state rather than only when something has
            // gone wrong: "Ready to receive" is true and still incomplete, and
            // the missing half is what a user needs before they walk away from
            // the device expecting a file to arrive.
            InlineMessage(.info, L10n.t(.inboxIOSForegroundOnly))
                .accessibilityIdentifier("inbox-foreground-only")

            Text(L10n.t(.inboxIOSExplain))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)

            // Where the bytes go, named as the Files-app route the user can
            // actually walk — the same route a stored-link receive names, built
            // from the same two constants.
            Text(IOSInboxCopy.folderExplanation())
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inbox-folder")

            if inbox.conversationStoreIssue {
                InlineMessage(.warning, L10n.t(.inboxConversationStoreIssue))
            }
        }
    }

    // MARK: - the one consent

    /// Off, ask, or automatic — the user's own answer, stored per account and
    /// default-off.
    ///
    /// **No Pause control, and its absence is a decision.** macOS offers one
    /// because a Mac receives with its window closed, so "stop for now without
    /// changing my answer" is a state distinct from both Off and quitting. On a
    /// foreground-only receiver, pausing and leaving the app are the same act,
    /// and Off — durable, announced to central, one tap away in this very
    /// control — is the answer that survives. A Pause here would be a third
    /// spelling of a thing that already has two.
    private var policySection: some View {
        SectionCard(L10n.t(.inboxPolicyHeading)) {
            Picker(L10n.t(.inboxPolicyHeading),
                   selection: Binding(get: { inbox.policy },
                                      set: { inbox.setPolicy($0) })) {
                ForEach(InboxAutoAccept.allCases, id: \.self) { policy in
                    Text(InboxPolicyPresentation.label(for: policy)).tag(policy)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityIdentifier("inbox-policy")

            Text(L10n.t(.inboxIOSPolicyExplain))
                .font(.footnote)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)

            // A refusal of the action the user just took, beside the control
            // that produced it. Cleared by the next one.
            if let error = inbox.settingsError {
                InlineMessage(.warning, InboxSettingsErrorCopy.message(error))
            }
        }
    }

    // MARK: - deliveries central is holding for an answer

    /// Under `ask`, nothing is downloaded and nothing is written until the user
    /// says yes — so these rows carry no name, no preview and no sender: the
    /// manifest is not decrypted until a task is claimed, and claiming is what
    /// is being asked about.
    @ViewBuilder
    private var askSection: some View {
        if !inbox.asking.isEmpty {
            SectionCard(L10n.t(.inboxAskHeading)) {
                Text(L10n.t(.inboxAskExplain))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(inbox.asking) { item in
                    askRow(item)
                }
            }
        }
    }

    private func askRow(_ item: InboxAskItem) -> some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            // The two facts an unclaimed task may reveal — how big the
            // ciphertext is and when it expires — so two waiting questions do
            // not render as identical rows.
            Text(L10n.detail([
                L10n.bytes(item.ciphertextBytes),
                L10n.t(.commonExpires, [
                    L10n.date(Date(timeIntervalSince1970: TimeInterval(item.expiresAt)),
                              dateStyle: .medium, timeStyle: .short),
                ]),
            ]))
            .font(.footnote)
            .foregroundStyle(Palette.supportingLabel)
            .fixedSize(horizontal: false, vertical: true)

            Button(L10n.t(.inboxAskAccept)) { inbox.respond(toAsk: item.id, accept: true) }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            Button(L10n.t(.inboxAskDecline), role: .destructive) {
                inbox.respond(toAsk: item.id, accept: false)
            }
            .borderedAction(.destructive)
            .controlSize(.large)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox-ask.\(item.id)")
    }

    // MARK: - the devices, and what has passed between them

    /// **One list, and every row opens a page.**
    ///
    /// It is deliberately not two lists side by side. A device the account owns
    /// and a conversation with that device are the same thing at two ages, and
    /// splitting them would put the same MacBook in two places — once because it
    /// can receive, once because it has sent something — with different actions
    /// under each. So the rows are merged by device id: the conversation supplies
    /// the history, the directory supplies the ones that have none yet, and every
    /// row leads to the same page.
    ///
    /// Devices that cannot currently be sent to are kept rather than filtered
    /// out, for the reason the target list already keeps them: a device whose
    /// owner turned receiving off is the device the user is looking for, and
    /// dropping it turns a two-second fix into "Relayium cannot see my Mac".
    /// Whether the page it opens may SEND is `selectedCandidate`'s answer, taken
    /// there and not here.
    private var conversationsSection: some View {
        SectionCard(L10n.t(.inboxConversationsHeading)) {
            HStack(alignment: .firstTextBaseline) {
                Text(L10n.t(.sendDeviceExplain))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(L10n.t(.commonRefresh), action: refreshTargets)
                    .textAction()
                    .disabled(deliveries.directory == .loading)
                    .accessibilityIdentifier("inbox-devices-refresh")
            }

            // The directory's own state, when the list itself is not the answer.
            // `unavailable` is deliberately not an empty list: "you have no
            // other device" and "we could not ask" have different remedies.
            if let message = InboxSendPresentation.text(for: deliveries.directory) {
                switch deliveries.directory {
                case .loading:
                    ProgressView { Text(message) }
                default:
                    InlineMessage(.warning, message)
                }
            }

            if rows.isEmpty {
                // nonlocalized: SF Symbol name. The pair of devices that WOULD
                // exchange something — an iOS 14 symbol, safely below this
                // app's 16.0 floor.
                // Two parts, because the list is empty for two different reasons
                // at once and they have different remedies: nothing has arrived
                // (the message), and there may be no device on the account that
                // could send or receive yet (the detail, which names how to set
                // one up). One sentence would have answered only whichever the
                // reader was not asking about.
                EmptyStateView(symbol: "laptopcomputer.and.iphone",
                               message: L10n.t(.inboxIOSConversationsEmpty),
                               detail: L10n.t(.sendDeviceNoneHelp))
            }

            ForEach(rows, id: \.peerID) { row in
                deviceRow(row)
            }
        }
    }

    /// One row: a device id, the name to draw it under, and the history it has.
    ///
    /// A local type rather than a tuple with four members, so the merge below
    /// reads as what it is and the row builder cannot take its fields in the
    /// wrong order.
    private struct DeviceRow {
        let peerID: String
        let name: String
        let conversation: InboxConversation?
        let candidate: InboxSendCandidate?
    }

    /// Conversations first, newest activity first, then the devices with no
    /// history yet.
    ///
    /// That order is the product: the list answers "what has arrived" before it
    /// answers "where could I send", and a device that just delivered something
    /// is the one the user is most likely to be looking for. `conversations` is
    /// already ordered by the store; the remainder keeps the directory's order,
    /// which is central's.
    private var rows: [DeviceRow] {
        var seen: Set<String> = []
        var merged: [DeviceRow] = []
        for conversation in inbox.conversations {
            seen.insert(conversation.peerDeviceID)
            merged.append(DeviceRow(
                peerID: conversation.peerDeviceID,
                name: InboxTimelinePresentation.conversationName(
                    conversation,
                    resolvedName: inbox.displayName(for: conversation),
                    isRemoved: inbox.isRemoved(conversation.peerDeviceID)),
                conversation: conversation,
                candidate: deliveries.candidates.first { $0.id == conversation.peerDeviceID }))
        }
        for candidate in deliveries.candidates where !seen.contains(candidate.id) {
            merged.append(DeviceRow(peerID: candidate.id,
                                    name: InboxSendPresentation.name(of: candidate),
                                    conversation: nil,
                                    candidate: candidate))
        }
        return merged
    }

    private func deviceRow(_ row: DeviceRow) -> some View {
        let unread = row.conversation?.unreadCount ?? 0
        return Button {
            deliveries.focusPeer(row.peerID)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.inner) {
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    Text(row.name)
                        .font(.callout)
                        // Weight, not colour: an unread row has to read as one
                        // in monochrome and with colour filters on.
                        .fontWeight(unread > 0 ? .semibold : .regular)
                        .fixedSize(horizontal: false, vertical: true)
                    // What the row is about, and never both at once: a
                    // conversation says what is unread and when it last moved, a
                    // device with no history says whether it can be sent to.
                    if let conversation = row.conversation {
                        Text(InboxTimelinePresentation.conversationSummary(conversation))
                            .font(.footnote)
                            .foregroundStyle(Palette.supportingLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let candidate = row.candidate {
                        Text(InboxSendPresentation.detail(for: candidate))
                            .font(.footnote)
                            .foregroundStyle(Palette.supportingLabel)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if unread > 0 {
                        Text(L10n.t(.inboxConversationUnread, [L10n.number(unread)]))
                            .font(.footnote)
                            .foregroundStyle(Palette.supportingLabel)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward") // nonlocalized: SF Symbol name
                    .font(.footnote)
                    // secondary-role: chevron — a disclosure indicator, not prose. Non-text.
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: Metrics.hitTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // One spoken row naming the device it opens, rather than five identical
        // "Open" buttons. The unread count is inside the combined children, so
        // VoiceOver reads it as part of the row it belongs to.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L10n.t(.inboxIOSOpenConversation, [L10n.token(row.name)]))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("inbox-conversation.\(row.peerID)")
    }

    // MARK: - no usable account

    /// Signed out, unverified, frozen or still restoring — each with the one
    /// action that resolves it, and none of them a second sign-in form.
    ///
    /// `.allowed` is unreachable: `DeviceInboxEntry.entry` maps it to
    /// `statusOnly`, precisely so a gate is never handed a state it has nothing
    /// to say about. It is listed rather than defaulted so that stays a compile
    /// error if the entry rule ever changes.
    @ViewBuilder
    private func accountSection(_ gate: AccountGate) -> some View {
        switch gate {
        case .allowed:
            // Rendered as the surface's own status instead of nothing at all:
            // an arm that drew empty would be a blank destination if the entry
            // rule above ever let one through.
            statusSection
        case .loading:
            // Not the sign-in gate. Restoring is a keychain read that usually
            // succeeds, and asking for a password during it is a lie the user
            // acts on — by typing credentials they did not need to.
            SectionCard { ProgressView { Text(L10n.t(.accountRestoring)) } }
        case .signInRequired:
            openAccountCard(title: L10n.t(.inboxSignedOut),
                            message: L10n.t(.inboxIOSSignedOutBody),
                            actionTitle: L10n.t(.gateSignIn))
        case .unavailable(let message):
            // A different fact from "you need an account": this user IS signed
            // in, and telling them to sign in would be a false sentence with a
            // useless remedy.
            openAccountCard(title: L10n.t(.contentAccountLoadFailed), message: message)
        case .verifyEmail(let email):
            // The address is the user's own: isolated, never translated.
            openAccountCard(title: L10n.t(.contentCheckEmailTitle),
                            message: L10n.t(.contentCheckEmailBody, [L10n.token(email)]))
        case .pendingDeletion(let purgeAfter, _):
            // To the Account destination, which owns reactivation — not to a
            // second copy of that button with its own busy state to keep in step.
            openAccountCard(title: L10n.t(.contentPendingDeletionTitle),
                            message: L10n.t(.contentPendingDeletionBody, [
                                L10n.date(Date(timeIntervalSince1970: TimeInterval(purgeAfter)),
                                          dateStyle: .medium, timeStyle: .none),
                            ]))
        }
    }

    /// The shared shape of every account refusal: what is true, and the one way
    /// out of it.
    ///
    /// In a card, and its heading is the card's — this is the whole destination
    /// for a signed-out user, and a bare heading with a paragraph on an
    /// otherwise empty page reads as something that failed to load.
    private func openAccountCard(title: String, message: String,
                                 actionTitle: String? = nil) -> some View {
        SectionCard(title) {
            Text(message)
                .font(.callout)
                .foregroundStyle(Palette.supportingLabel)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onOpenAccount) {
                Text(actionTitle ?? L10n.t(.gateOpenAccount)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("inbox-open-account")
        }
    }

    // MARK: - actions

    /// The one place this destination reads the bearer, and it reads it at the
    /// moment of use.
    ///
    /// An empty or unusable credential is reported by the model as an
    /// unauthorized directory rather than as a network failure, and the sentence
    /// that produces names the account. Nothing here is held in `@State`.
    private func refreshTargets() {
        deliveries.refreshTargets(token: session.bearerToken ?? "")
    }

    /// What a recovery control does.
    ///
    /// `chooseFolder` is listed and does nothing, because it is unreachable:
    /// `IOSInboxCopy.recovery` maps it to `.retry` before this is ever called.
    /// It is listed rather than defaulted so a change there is a decision here
    /// rather than a button that silently stops working.
    private func perform(_ recovery: InboxRecovery) {
        switch recovery {
        case .retry:        inbox.retryNow()
        case .resume:       inbox.resume()
        case .answer:       break   // the questions are already on this screen
        case .chooseFolder: break   // unreachable — see IOSInboxCopy.recovery
        }
    }
}
