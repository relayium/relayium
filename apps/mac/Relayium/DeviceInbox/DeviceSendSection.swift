import RelayiumAppKit
import SwiftUI

/// **The other direction of the Device Inbox: sending from this Mac to one of
/// this account's own devices.**
///
/// ## Why this had to exist
///
/// The Device Inbox shipped on macOS with only its receiving half. Every gate
/// was green — a resident receiver, a folder grant, a policy, a journal, real
/// deliveries landing on disk — and the capability was still, in practice,
/// one-directional: the only surface in the product that could *start* a device
/// delivery was the Web app's Send screen and the iOS Send tab. So a Mac could
/// receive from a browser and could not send to another Mac at all, which is the
/// exact shape the owner reported. Nothing in the transport was missing. The
/// sender was.
///
/// It is the same `InboxSendModel` iOS drives, against the same `inbox/1`
/// endpoints, with the same `InboxSendCoordinator` underneath and the same
/// nine-language copy through `InboxSendPresentation`. Nothing here re-derives a
/// decision that model owns: which devices may be offered, when a selection
/// becomes a durable delivery, what a running send may claim and which recovery
/// a stopped one may offer are all its answers, because a `switch` in a view is
/// a `switch` no `swift test` can drive.
///
/// ## What it deliberately does not do
///
/// **It never sends without a chosen device.** A delivery is sealed to one
/// device's current public key and produces no link, so there is nobody it could
/// fall back to — and a "send to whatever is online" default would be a delivery
/// the user did not address. `InboxSendModel.selectTarget` also refuses to select
/// a row that cannot receive, so the Send button is never a control whose only
/// outcome is a refusal.
///
/// **It never chooses between a link and a device on the user's behalf.** Those
/// are different products — one publishes a stored object anybody holding the
/// link can open, the other seals to a single device and creates no link — and on
/// macOS the choice is made by *which destination you are on*: Send a link is its
/// own sidebar row and this is the Device Inbox. `SendRoute`'s own documentation
/// is the argument, and this composition is the strongest possible form of it.
///
/// **It reads the bearer at the moment of use and stores none.** A sign-out
/// landing between the button being enabled and the button being pressed
/// produces an honest route to the Account destination rather than a request
/// with an empty credential — the same rule `UploadPane.send()` follows.
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

    /// What is going. Owned by this view, exactly as `UploadPane` owns the
    /// stored-send one — the model owns what is being *delivered*, and a batch
    /// nobody has pressed Send on is not that yet.
    @StateObject private var selection = SelectionStore()

    /// The one send whose discard is waiting on a confirmation, if any.
    ///
    /// Held as the ITEM rather than as a flag, because the warning is only
    /// carried by some of them — a send whose create outcome is unknown — and a
    /// dialog raised for the wrong card would be a destructive confirmation
    /// about a different delivery.
    @State private var confirmingDiscard: InboxSendItem?

    var body: some View {
        chooseSection
        targetSection
        deliveriesSection
    }

    // MARK: - what is going

    private var chooseSection: some View {
        Section {
            // The same picker verb Send a link uses, so choosing files means one
            // thing across the app. No drop zone: this pane lives inside a
            // grouped `Form`, and a drop target inside a form row reads as a
            // control the row does not have.
            HStack {
                Button(L10n.t(.commonChooseFilesOrFolders)) {
                    chooseFilesOrFolders(into: selection)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("inbox-send-choose")
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
        } header: {
            Text(L10n.t(.sendDeviceHeading))
                .accessibilityIdentifier("inbox-send")
        } footer: {
            // The consequence, before anything is encrypted: sealed to one
            // device, no link, nobody else can open it.
            Text(L10n.t(.sendDeviceExplain))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - where it is going

    private var targetSection: some View {
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
                targetRow(candidate)
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
            Button(L10n.t(.commonRefresh)) { refresh() }
                .buttonStyle(.bordered)
                .disabled(deliveries.directory == .loading)
                .accessibilityIdentifier("inbox-send-refresh")
            // Above the control it explains, in reading order. A disabled Send
            // with no sentence beside it is indistinguishable from a bug.
            if let refusal = deliveries.refusal {
                InlineMessage(.failure, InboxSendPresentation.text(for: refusal))
                    .accessibilityIdentifier("inbox-send-refusal")
            }
            Button(L10n.t(.commonSend)) { send() }
                .buttonStyle(.borderedProminent)
                .disabled(!canSend)
                .accessibilityIdentifier("inbox-send-start")
        } header: {
            Text(L10n.t(.sendDeviceChooseTarget))
                .accessibilityIdentifier("inbox-send-target")
        }
        // Read when the surface appears, and by the refresh control. Never on a
        // timer: this is the account's device list, not a presence feed.
        .task { refresh() }
    }

    private func targetRow(_ candidate: InboxSendCandidate) -> some View {
        let chosen = deliveries.selectedTargetID == candidate.id
        return Button {
            // Pressing the chosen row again clears it. A selection with no way
            // back would leave the user unable to change their mind before Send.
            deliveries.selectTarget(chosen ? nil : candidate.id)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.inner) {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(chosen ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    Text(InboxSendPresentation.name(of: candidate))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(InboxSendPresentation.detail(for: candidate))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // One spoken row rather than a name, a detail and an unlabelled image.
        // The trait is what tells a VoiceOver user which one is chosen — the
        // symbol says nothing at all to them.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        // On the ROW, which is a single combined element here. Every identifier
        // in this file is on a leaf or on a deliberately combined element, never
        // on a container holding controls — the propagation defect the receive
        // pane has already lost two controls to.
        .accessibilityIdentifier("inbox-send-target.\(candidate.id)")
    }

    private func blockedRow(_ candidate: InboxSendCandidate) -> some View {
        // Not a Button: a row the Send button would then refuse is a dead end
        // the user has to discover by pressing it.
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

    private var canSend: Bool {
        !selection.files.isEmpty && deliveries.selectedTargetID != nil
    }

    // MARK: - what is already on its way

    /// Every delivery this account still has outstanding, newest first.
    ///
    /// Rendered whether or not anything is selected, because a delivery survives
    /// the app being closed: hiding it would leave a transfer running with
    /// nothing on screen able to name or stop it.
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
            .confirmationDialog(
                L10n.t(.uploadDiscard),
                isPresented: Binding(get: { confirmingDiscard != nil },
                                     set: { if !$0 { confirmingDiscard = nil } }),
                titleVisibility: .visible) {
                    Button(L10n.t(.uploadDiscard), role: .destructive) {
                        guard let item = confirmingDiscard else { return }
                        confirmingDiscard = nil
                        perform(.discard, on: item)
                    }
                    Button(L10n.t(.commonCancel), role: .cancel) { confirmingDiscard = nil }
                } message: {
                    // The honest warning: nothing local matters here, but a
                    // delivery may already exist and the user is about to stop
                    // being able to watch it.
                    Text(confirmingDiscard.flatMap {
                        InboxSendPresentation.warning(for: .discard, on: $0)
                    } ?? L10n.t(.sendDiscardMayArrive))
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
                    actionButton(action, on: item)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(InboxSendPresentation.accessibilityLabel(of: item))
    }

    /// One recovery control.
    ///
    /// The spoken name carries the device and the contents as well as the verb,
    /// because three outstanding deliveries offer three identical "Discard"
    /// buttons, one of which deletes this device's only copy of a file.
    @ViewBuilder
    private func actionButton(_ action: InboxSendAction, on item: InboxSendItem) -> some View {
        switch action {
        case .discard, .cancelDelivery:
            // Destructive and marked as such. Discard deletes this device's only
            // copy of the staged files; Cancel delivery asks central to drop a
            // delivery that may be about to land.
            Button(role: .destructive) { activate(action, on: item) } label: {
                Text(InboxSendPresentation.label(for: action))
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
            .accessibilityIdentifier("inbox-delivery-\(action.rawValue)")
        case .send, .retry, .stopAttempt, .dismiss:
            Button { activate(action, on: item) } label: {
                Text(InboxSendPresentation.label(for: action))
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
            .accessibilityIdentifier("inbox-delivery-\(action.rawValue)")
        }
    }

    // MARK: - actions

    private func refresh() {
        // An empty or unusable credential is reported as an unauthorized list
        // rather than as a network failure, which is what the model does with
        // the empty string. The remedy sentence then names the account.
        deliveries.refreshTargets(token: session.bearerToken ?? "")
    }

    /// The one place this surface spends the bearer, and it reads it at the
    /// moment of use.
    private func send() {
        guard let token = liveToken() else { return }
        // No shared draft travels with a macOS device send: the picker is this
        // view's own `SelectionStore`, so there is nothing another process
        // staged and nothing this delivery could be authorized to retire.
        deliveries.send(files: selection.files, sourceDraftId: nil, token: token)
    }

    private func activate(_ action: InboxSendAction, on item: InboxSendItem) {
        // Which combination needs the warning is `InboxSendActions`' decision,
        // where a test can read it, rather than a condition repeated here.
        guard !InboxSendActions.warnsDeliveryMayStillArrive(action, for: item) else {
            confirmingDiscard = item
            return
        }
        perform(action, on: item)
    }

    private func perform(_ action: InboxSendAction, on item: InboxSendItem) {
        switch action {
        case .stopAttempt, .dismiss:
            // Neither touches the server, and neither removes anything durable.
            // Routing them through a credential check would send somebody to the
            // Account screen to stop their own upload.
            deliveries.act(action, on: item.id, token: "")
        case .send, .retry, .cancelDelivery, .discard:
            guard let token = liveToken() else { return }
            deliveries.act(action, on: item.id, token: token)
        }
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
}
