import RelayiumAppKit
import SwiftUI

/// **My Devices: the account's own machines, and the way into one of them.**
///
/// ## Why this had to exist
///
/// The Device Inbox shipped on macOS with only its receiving half. Every gate
/// was green — a resident receiver, a folder grant, a policy, a journal, real
/// deliveries landing on disk — and the capability was still, in practice,
/// one-directional: the only surface in the product that could *start* a device
/// delivery was the Web app's Send screen and the iOS Send tab. So a Mac could
/// receive from a browser and could not send to another Mac at all. Nothing in
/// the transport was missing. The sender was.
///
/// ## Why it is a list and no longer a form of controls
///
/// The first sender was three sibling sections dropped onto the Device Inbox
/// landing page: a file picker, a device list and a Send button, directly under
/// the folder grant and the receive policy. The screen therefore offered *Choose
/// Files or Folders…*, *Choose Folder* and *Choose where to send* within one
/// scroll, where the first belongs to sending, the second to receiving and the
/// third to neither on its own — and a user who pressed the picker first had
/// staged files with no idea where they were going. The owner's report was that
/// the send controls were dumped into the main page, and that is exactly what
/// they were.
///
/// So the landing page names the *devices* and nothing else about sending, and
/// every control that composes a delivery moved to `DeviceConversationPage`, the
/// screen belonging to the one device the user picked. This file renders the
/// list, the outstanding deliveries, and the single action that opens a device.
///
/// It is the same `InboxSendModel` iOS drives, against the same `inbox/1`
/// endpoints, with the same `InboxSendCoordinator` underneath. Nothing here
/// re-derives a decision that model owns: which devices may be offered, which
/// one is chosen, what a running send may claim and which recovery a stopped one
/// may offer are all its answers, because a `switch` in a view is a `switch` no
/// `swift test` can drive.
///
/// ## What it deliberately does not do
///
/// **It never chooses between a link and a device on the user's behalf.** Those
/// are different products — one publishes a stored object anybody holding the
/// link can open, the other seals to a single device and creates no link — and on
/// macOS the choice is made by *which destination you are on*: Send a link is its
/// own sidebar row and this is the Device Inbox. `SendRoute`'s own documentation
/// is the argument, and this composition is the strongest possible form of it.
///
/// **It reads the bearer at the moment of use and stores none.** A sign-out
/// landing between the list being drawn and Refresh being pressed produces an
/// honest unauthorized list rather than a request with an empty credential.
struct DeviceSendSection: View {
    @ObservedObject var deliveries: InboxSendModel
    /// Where a refusal whose remedy is the account goes.
    ///
    /// It takes NO half of the form, unlike the receive surface's version. This
    /// pane has exactly one account remedy — the credential it was about to
    /// spend is gone, so sign in again — and a surface that could name a half
    /// would be a surface that decides which form the user lands on. The host
    /// supplies the answer; `MacSurfaceGuardTests` keeps `AuthMode` out of every
    /// file but the form and the two that genuinely forward a request.
    let onAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    var body: some View {
        devicesSection
        deliveriesSection
    }

    // MARK: - the account's own devices

    private var devicesSection: some View {
        Section {
            // The list's own state, when the list itself is not the answer.
            // `unavailable` is deliberately not an empty list: "you have no
            // device that can receive" and "we could not ask" have different
            // remedies, and one of them tells somebody with a perfectly good Mac
            // to go and set one up.
            if let message = InboxSendPresentation.text(for: deliveries.directory) {
                switch deliveries.directory {
                case .loading:
                    ProgressView { Text(message) }
                        .controlSize(.small)
                        .accessibilityIdentifier("inbox-send-directory-loading")
                default:
                    InlineMessage(.warning, message)
                        .accessibilityIdentifier("inbox-send-directory-error")
                }
            }
            if deliveries.directory == .loaded && deliveries.candidates.isEmpty {
                Text(L10n.t(.sendDeviceNone))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("inbox-send-no-devices")
                Text(L10n.t(.sendDeviceNoneHelp))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(deliveries.candidates.filter(\.isSendable)) { candidate in
                deviceRow(candidate)
            }
            // Kept rather than filtered out, which is the whole point of a
            // truthful target list: a device whose owner turned receiving off is
            // the device the user is looking for, and dropping it turns a
            // two-second fix into "Relayium cannot see my other Mac".
            let blocked = deliveries.candidates.filter { !$0.isSendable }
            if !blocked.isEmpty {
                Text(L10n.t(.sendDeviceBlockedHeading))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("inbox-send-blocked")
                ForEach(blocked) { candidate in
                    blockedRow(candidate)
                }
            }
            // The refusal that survives leaving a device's screen — a staging or
            // credential failure the user has to be told about even though the
            // composer that produced it is gone.
            if let refusal = deliveries.refusal {
                InlineMessage(.failure, InboxSendPresentation.text(for: refusal))
                    .accessibilityIdentifier("inbox-send-refusal")
            }
            Button(L10n.t(.commonRefresh)) { refresh() }
                .buttonStyle(.bordered)
                .disabled(deliveries.directory == .loading)
                .accessibilityIdentifier("inbox-send-refresh")
        } header: {
            Text(L10n.t(.sendMyDevicesHeading))
                .accessibilityIdentifier("inbox-send")
        } footer: {
            // What opening a device leads to, and the consequence of the send it
            // leads to: sealed to one device, no link, nobody else can open it.
            Text(L10n.t(.sendMyDevicesExplain))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        // Read when the surface appears, and by the refresh control. Never on a
        // timer: this is the account's device list, not a presence feed.
        .task { refresh() }
    }

    /// One device: what it is, and the way into its own screen.
    ///
    /// The whole row opens the device AND a named button on the trailing edge
    /// does the same thing, which is not redundancy — the row is the Mac idiom
    /// and the button is what says out loud that this list is about sending
    /// rather than about managing credentials. Pressing either is one call to
    /// `selectTarget`, so there is no second path into the child state.
    private func deviceRow(_ candidate: InboxSendCandidate) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Metrics.inner) {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                Text(InboxSendPresentation.name(of: candidate))
                    .fixedSize(horizontal: false, vertical: true)
                Text(InboxSendPresentation.detail(for: candidate))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Metrics.inner)
            // On the LEAF. Every identifier in this file is on a leaf or on a
            // deliberately combined element, never on a container holding
            // controls — the propagation defect the receive pane has already
            // lost two controls to.
            Button(L10n.t(.sendContentAction)) { open(candidate) }
                .buttonStyle(.bordered)
                .accessibilityLabel(InboxSendPresentation.openLabel(for: candidate))
                .accessibilityIdentifier("inbox-send-open.\(candidate.id)")
        }
        .contentShape(Rectangle())
        .onTapGesture { open(candidate) }
    }

    private func blockedRow(_ candidate: InboxSendCandidate) -> some View {
        // Not a Button, and it opens nothing: a row whose screen could only
        // refuse every send is a dead end the user has to discover by pressing
        // it. The detail line names the one thing that would have to change.
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(InboxSendPresentation.name(of: candidate))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(InboxSendPresentation.detail(for: candidate))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// Enter the device's own screen.
    ///
    /// The model owns the whole of it. `selectTarget` refuses a row that cannot
    /// receive, so a blocked device can never become the selection, and
    /// `selectedCandidate` — which is what `DeviceInboxSurface` renders the child
    /// on — goes nil again the moment that device is revoked, switched off or
    /// left with the account. There is no second copy of "which device am I on"
    /// in this app.
    private func open(_ candidate: InboxSendCandidate) {
        deliveries.selectTarget(candidate.id)
    }

    // MARK: - what is already on its way

    /// Every delivery this account still has outstanding, newest first.
    ///
    /// Rendered whether or not a device is open, because a delivery survives the
    /// app being closed: hiding it would leave a transfer running with nothing
    /// on screen able to name or stop it. It stays on the LANDING page — it is
    /// about every device, not the one whose screen is open — and the device's
    /// own screen renders only its own send.
    @ViewBuilder
    private var deliveriesSection: some View {
        if !deliveries.items.isEmpty {
            Section {
                // Both halves of the truth, and the second is the one that
                // matters: this app has no background transfer, but once a
                // delivery is waiting the OTHER device is what fetches it.
                Text(L10n.t(.sendOutstandingExplain))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(deliveries.items) { item in
                    card(item)
                }
            } header: {
                Text(L10n.t(.sendOutstandingHeading))
                    .accessibilityIdentifier("inbox-send-outstanding")
            }
        }
    }

    private func card(_ item: InboxSendItem) -> some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(InboxSendPresentation.targetName(of: item))
                .font(.callout.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(InboxSendPresentation.summary(of: item))
                .font(.caption)
                .foregroundStyle(.secondary)
            // Safe manifest identities only — no staged URL, no container path.
            // A recovered card offers Send for files chosen in a session the
            // user may not remember, and "3 files" is not enough to decide that.
            PendingFileList(sessionFiles: item.files)
            // A bar only while bytes are actually moving, and never on its own:
            // the sentence beside it says the ciphertext is going up and that
            // nothing has reached the other device, because a bar that reaches
            // the end is the exact place a person concludes their file landed.
            if case let .uploading(sent, total) = item.activity {
                ProgressView(value: Double(sent), total: Double(max(total, 1)))
                    .accessibilityLabel(L10n.t(.sendOutstandingHeading))
                    .accessibilityValue(
                        L10n.percent(done: sent, total: total) ?? L10n.t(.commonStarting))
            }
            Text(InboxSendPresentation.status(for: item.activity))
                .font(.caption)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("inbox-delivery-status")
            // An action that did not do what it said, on the card it belongs to.
            // A cancel central refused means the delivery is still live, and the
            // one thing this must not do is quietly remove the card for it.
            if let error = deliveries.actionError, error.itemID == item.id {
                InlineMessage(.failure, InboxSendPresentation.text(for: error))
                    .accessibilityIdentifier("inbox-delivery-error")
            }
            HStack {
                ForEach(InboxSendActions.offered(for: item), id: \.self) { action in
                    DeliveryActionButton(action: action, item: item,
                                         deliveries: deliveries, onAccount: onAccount)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(InboxSendPresentation.accessibilityLabel(of: item))
    }

    // MARK: - actions

    private func refresh() {
        // An empty or unusable credential is reported as an unauthorized list
        // rather than as a network failure, which is what the model does with
        // the empty string. The remedy sentence then names the account.
        deliveries.refreshTargets(token: session.bearerToken ?? "")
    }
}
