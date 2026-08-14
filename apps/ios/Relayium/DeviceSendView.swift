import SwiftUI
import RelayiumAppKit

/// The Send tab's other destination: one of the account's own Macs or command
/// line receivers, instead of a link anybody can open.
///
/// Three views, and they are separate because they answer three questions the
/// user asks at different moments — which KIND of send, which DEVICE, and what
/// happened to the ones already on their way. The third outlives both of the
/// others: a delivery survives the app being closed, so its list is rendered
/// under either route rather than only under the one that started it.
///
/// **Nothing here decides anything.** Which devices may be offered, when a
/// selection becomes a durable delivery, what a running send is allowed to
/// claim and which recovery a stopped one may offer are all `InboxSendModel`'s,
/// and every sentence comes from `InboxSendPresentation`. That is not tidiness:
/// the one mistake this surface must not make is rendering a finished upload as
/// an arrival, and a `switch` in a view is a `switch` no `swift test` can drive.
///
/// The bearer is read at the moment of use and stored in no `@State`, exactly as
/// `SendView.send()` reads it — so a sign-out landing between a button being
/// enabled and that button being tapped produces an honest route to the Account
/// tab rather than a request with an empty credential.

/// A link anyone can open, or a delivery to one of this account's own devices.
struct SendRouteChooser: View {
    @ObservedObject var routes: SendRouteSelection

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            Text(L10n.t(.sendChooseHow)).font(.headline)
            Picker(L10n.t(.sendChooseHow),
                   selection: Binding(get: { routes.route },
                                      set: { routes.select($0) })) {
                ForEach(SendRoute.allCases, id: \.self) { route in
                    Text(InboxSendPresentation.label(for: route)).tag(route)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("send-route")
            // The consequence, under the control that chooses it and BEFORE
            // anything is encrypted. The two differ in who can read the files,
            // and that is not a difference a user should discover afterwards.
            Text(InboxSendPresentation.explanation(for: routes.route))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("send-route-explanation")
        }
    }
}

/// Which device the current selection is going to, and the Send that commits it.
struct DeviceTargetPicker: View {
    @ObservedObject var deliveries: InboxSendModel
    @ObservedObject var selection: SendSelectionModel
    /// Selects the Account tab, for the two refusals whose remedy is there.
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            HStack(alignment: .firstTextBaseline) {
                Text(L10n.t(.sendDeviceChooseTarget)).font(.headline)
                Spacer(minLength: 0)
                Button(L10n.t(.commonRefresh), action: refresh)
                    .disabled(deliveries.directory == .loading)
                    .accessibilityIdentifier("send-target-refresh")
            }

            // The list's own state, when the list itself is not the answer.
            // `unavailable` is deliberately not an empty list: "you have no
            // device that can receive" and "we could not ask" have different
            // remedies, and one of them tells a user with a perfectly good Mac
            // to go and set one up.
            if let message = InboxSendPresentation.text(for: deliveries.directory) {
                switch deliveries.directory {
                case .loading:
                    ProgressView { Text(message) }
                default:
                    failureLine(message)
                }
            }

            if deliveries.directory == .loaded && deliveries.candidates.isEmpty {
                // The shared empty-state role, so an account with no receiver
                // set up meets the same designed state as a nearby roster with
                // nobody in it — a landmark, the fact, and the remedy — rather
                // than two loose paragraphs where a list should be.
                // nonlocalized: SF Symbol name. The computer that WOULD
                // receive, not a slashed one — the same choice the empty nearby
                // roster makes, and `laptopcomputer.slash` is an iOS 16.1 symbol
                // that would silently draw nothing on this app's 16.0 floor.
                EmptyStateView(symbol: "laptopcomputer.and.arrow.down",
                               message: L10n.t(.sendDeviceNone),
                               detail: L10n.t(.sendDeviceNoneHelp))
            }

            ForEach(sendable) { candidate in
                targetRow(candidate)
            }

            // Kept rather than filtered out, which is the whole point of a
            // truthful target list: a device whose owner turned receiving off is
            // the device the user is looking for, and dropping it turns a
            // two-second fix into "Relayium cannot see my Mac".
            if !blocked.isEmpty {
                Text(L10n.t(.sendDeviceBlockedHeading))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                ForEach(blocked) { candidate in
                    blockedRow(candidate)
                }
            }

            // Above the control it explains, in reading order. A disabled Send
            // with no sentence beside it is indistinguishable from a bug.
            if let refusal = deliveries.refusal {
                failureLine(InboxSendPresentation.text(for: refusal))
            }

            Button(action: send) {
                Text(L10n.t(.commonSend)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!canSend)
            // Hidden from the accessibility tree rather than merely dimmed: a
            // dimmed control is still something VoiceOver offers to activate.
            .accessibilityHidden(!canSend)
            .accessibilityIdentifier("send-to-device")
        }
        // Read when the surface appears, and by the refresh control. Never on a
        // timer: this is the account's device list, not a presence feed.
        .task { refresh() }
        .accessibilityElement(children: .contain)
    }

    private var sendable: [InboxSendCandidate] { deliveries.candidates.filter(\.isSendable) }
    private var blocked: [InboxSendCandidate] { deliveries.candidates.filter { !$0.isSendable } }

    private var canSend: Bool {
        !selection.selectedFiles.isEmpty && deliveries.selectedTargetID != nil
    }

    private func targetRow(_ candidate: InboxSendCandidate) -> some View {
        let chosen = deliveries.selectedTargetID == candidate.id
        return Button {
            // Tapping the chosen row again clears it. A selection with no way
            // back would leave the user unable to stop before Send.
            deliveries.selectTarget(chosen ? nil : candidate.id)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: Metrics.inner) {
                VStack(alignment: .leading, spacing: Metrics.hairline) {
                    Text(InboxSendPresentation.name(of: candidate))
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(InboxSendPresentation.detail(for: candidate))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if chosen {
                    Image(systemName: "checkmark").foregroundStyle(Palette.action)
                }
            }
            // The same floor and the same selected treatment the nearby roster
            // uses: a row is a target before it is a label, and the tint behind
            // it is the second carrier of "this is the one you chose" for anyone
            // a checkmark's colour does not reach.
            .frame(minHeight: Metrics.hitTarget)
            .padding(.horizontal, Metrics.tight)
            .background(chosen ? Palette.actionSurface : Color.clear,
                        in: RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // One spoken row rather than a name, a detail and an unlabelled image.
        // The trait is what tells a VoiceOver user which one is chosen — the
        // checkmark says nothing at all to them.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("send-target.\(candidate.id)")
    }

    private func blockedRow(_ candidate: InboxSendCandidate) -> some View {
        VStack(alignment: .leading, spacing: Metrics.hairline) {
            Text(InboxSendPresentation.name(of: candidate))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(InboxSendPresentation.detail(for: candidate))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        // Not a Button: a row the Send button would then refuse is a dead end
        // the user has to discover by pressing it.
        .accessibilityElement(children: .combine)
    }

    private func failureLine(_ text: String) -> some View {
        InlineMessage(.warning, text)
    }

    // MARK: - actions

    private func refresh() {
        // An empty or unusable credential is reported as an unauthorized list
        // rather than as a network failure, which is what the model does with
        // the empty string. The remedy sentence then names the account.
        deliveries.refreshTargets(token: session.bearerToken ?? "")
    }

    /// The one place this surface reads the bearer, and it reads it at the
    /// moment of use.
    private func send() {
        guard let token = session.bearerToken, !token.isEmpty,
              case .allowed = AccountGate.from(session.state, bearer: token) else {
            onOpenAccount()
            return
        }
        // The adopted draft travels with the selection, so the durable job
        // records where those bytes came from — and the draft is retired only
        // once that job exists, never before.
        deliveries.send(files: selection.selectedFiles,
                        sourceDraftId: selection.adoptedDraft?.id,
                        token: token)
    }
}

/// Every delivery this account still has outstanding, newest first.
///
/// Rendered under BOTH routes. A delivery survives the app being closed and the
/// user switching to the link flow, so hiding it there would leave a transfer
/// running with nothing on screen able to name or stop it.
struct DeviceDeliveryList: View {
    @ObservedObject var deliveries: InboxSendModel
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    /// The one send whose discard is waiting on a confirmation, if any.
    ///
    /// Held as the ITEM rather than as a flag, because the warning is only
    /// carried by some of them — a send whose create outcome is unknown — and a
    /// dialog that appeared for the wrong card would be a destructive
    /// confirmation about a different delivery.
    @State private var confirmingDiscard: InboxSendItem?

    var body: some View {
        if !deliveries.items.isEmpty {
            // The shared card role. Contained rather than combined, which the
            // card already does: each delivery has its own actions, and
            // combining would leave VoiceOver reading three of them as one
            // label with six buttons after it.
            SectionCard(L10n.t(.sendOutstandingHeading)) {
                // Both halves of the truth, and the second is the one that
                // matters: this app has no background transfer, but once a
                // delivery is waiting the OTHER device is what fetches it.
                Text(L10n.t(.sendOutstandingExplain))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(deliveries.items) { item in
                    card(item)
                }
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
                .font(.footnote)
                .foregroundStyle(.secondary)
            // Safe manifest identities only — no staged URL, no container path.
            // A recovered card offers Send for files chosen in a session the
            // user may not remember, and "3 files" is not enough to decide that;
            // every other send surface in this app answers the same question the
            // same way before its button.
            PendingFileList(sessionFiles: item.files)
            // A bar only while bytes are actually moving, and never on its own:
            // the sentence beside it says the ciphertext is going up and that
            // nothing has reached the other device, because a bar that reaches
            // the end is the exact place a person concludes their file landed.
            if case let .uploading(sent, total) = item.activity {
                ProgressView(value: Double(sent), total: Double(max(total, 1)))
            }
            Text(InboxSendPresentation.status(for: item.activity))
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("delivery-status.\(item.id)")

            // An action that did not do what it said, on the card it belongs to.
            // A cancel central refused means the delivery is still live, and the
            // one thing this must not do is quietly remove the card for it.
            if let error = deliveries.actionError, error.itemID == item.id {
                failureLine(InboxSendPresentation.text(for: error))
            }

            ForEach(InboxSendActions.offered(for: item), id: \.self) { action in
                actionButton(action, on: item)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(InboxSendPresentation.accessibilityLabel(of: item))
        .accessibilityIdentifier("delivery.\(item.id)")
    }

    /// One recovery control.
    ///
    /// The spoken name carries the device and the contents as well as the verb,
    /// because three outstanding deliveries offer three identical "Discard"
    /// buttons, one of which deletes this device's only copy of a file.
    @ViewBuilder
    private func actionButton(_ action: InboxSendAction, on item: InboxSendItem) -> some View {
        switch action {
        case .send, .retry:
            Button { activate(action, on: item) } label: {
                Text(InboxSendPresentation.label(for: action)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        case .discard, .cancelDelivery:
            // Destructive and marked as such. Discard deletes this device's only
            // copy of the staged files; Cancel delivery asks central to drop a
            // delivery that may be about to land.
            Button(role: .destructive) { activate(action, on: item) } label: {
                Text(InboxSendPresentation.label(for: action)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        case .stopAttempt, .dismiss:
            Button { activate(action, on: item) } label: {
                Text(InboxSendPresentation.label(for: action)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        }
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
            // Routing them through a credential check would send a user to the
            // Account tab to stop their own upload.
            deliveries.act(action, on: item.id, token: "")
        case .send, .retry, .cancelDelivery, .discard:
            guard let token = session.bearerToken, !token.isEmpty,
                  case .allowed = AccountGate.from(session.state, bearer: token) else {
                onOpenAccount()
                return
            }
            deliveries.act(action, on: item.id, token: token)
        }
    }

    private func failureLine(_ text: String) -> some View {
        InlineMessage(.warning, text)
    }
}
