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
    @EnvironmentObject private var loginItem: LoginItemPreference
    /// Read for exactly one thing: whether there is an account to sign in to, and
    /// what is standing in the way if there is not. The controller's own
    /// `isSignedIn` cannot answer that — it only knows whether it adopted one —
    /// so a signed-out pane built on it alone could say nothing more useful than
    /// "sign in", including to somebody whose address is merely unverified.
    @EnvironmentObject private var session: AccountSession

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
                statusSection(offersControls: true)
                notificationSection
                askSection
                folderSection
                policySection
                resultsSection
                residencySection
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
            CapabilityGateView(gate: gate,
                               title: L10n.t(.inboxSignedOut),
                               body: L10n.t(.inboxSignedOutBody),
                               onAccount: onAccount)
        } header: {
            // The identifier is on the header LEAF, never on the `Section`. This
            // branch now contains two buttons, and a container identifier renames
            // every control inside it — the propagation defect this pane has
            // already lost a control to twice.
            Text(L10n.t(.inboxTitle))
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
            // describe, and the one fact the route is useless without: which
            // folder on this Mac, or that none is chosen yet.
            PathRail(stops: PathRailPresentation.deviceInbox(folder: inbox.folder))
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
            Text(L10n.t(.inboxTitle))
        } footer: {
            caption(L10n.t(.inboxExplain))
        }
    }

    /// Pausing is meaningful exactly while the loop would otherwise be doing or
    /// waiting for work.
    private var canPause: Bool {
        switch inbox.state {
        case .ready, .working, .asking, .offline, .saved, .loading:
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
        case .saved:          return "checkmark.circle"
        case .failed:         return "xmark.octagon"
        }
    }

    /// Taken from `InlineMessage.Kind` rather than named here, because exactly
    /// one file in this app may name the failure colour — the one that always
    /// draws a symbol beside it. `StatusBadge` does the same, so no state in this
    /// pane is carried by colour alone.
    private var tint: Color {
        switch inbox.state {
        case .ready, .saved:                       return .green
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

    private var resultsSection: some View {
        Section {
            if inbox.results.isEmpty {
                Text(L10n.t(.inboxResultsEmpty))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("inbox-results-empty")
            } else {
                ForEach(inbox.results) { receipt in
                    HStack {
                        // The identifiers go on the two LEAVES, never on the row
                        // that contains them: an identifier on the `HStack`
                        // propagates down and renames the button inside it, which
                        // is how the first version of this list left the Reveal
                        // control unreachable to the acceptance suite while
                        // looking correct on screen.
                        Text(InboxReceiptPresentation.summary(receipt))
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("inbox-result")
                        Spacer()
                        // Explicit, per row, and the only path in the product
                        // that puts a received path in front of the OS. The
                        // controller refuses anything not in this list.
                        Button(L10n.t(.inboxReveal)) { inbox.reveal(receipt) }
                            .buttonStyle(.bordered)
                            .accessibilityLabel(
                                InboxReceiptPresentation.revealActionLabel(receipt))
                            .accessibilityIdentifier("inbox-reveal")
                    }
                }
            }
        } header: {
            Text(L10n.t(.inboxResultsHeading))
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
