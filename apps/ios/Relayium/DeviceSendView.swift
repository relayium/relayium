import SwiftUI
import RelayiumAppKit

/// Every delivery to one of this account's own devices that is still
/// outstanding, and the controls one of them may offer.
///
/// ## What this file lost in 0.3.0, and why
///
/// It used to hold three views. `SendRouteChooser` was a segmented *As a link /
/// To a device* control at the top of the Send tab, and `DeviceTargetPicker` was
/// the device list and Send button that appeared under it. Both are gone: a
/// stored link and a device delivery are different products — they differ in who
/// can read the files, where the content key goes, and what a success means —
/// and which one you get is now decided by **which destination you are on**,
/// exactly as it already was on macOS. `SendRoute`'s own documentation is that
/// argument, and this composition is the strongest form of it: Send is stored
/// links only, and a device send starts from that device's conversation in
/// Device Inbox, where its history is.
///
/// The device list did not disappear with the picker; it moved to
/// `DeviceInboxView`, merged with the conversations, so one device is one row
/// leading to one page rather than a target in one tab and a history in another.
///
/// ## What stayed, and why it is here rather than in the Device Inbox
///
/// The outstanding list. A delivery survives the app being closed, so the screen
/// it was started from is not where it lives — and this list is rendered in the
/// Device Inbox destination, which is where every device send now begins.
///
/// **Nothing here decides anything.** Which recovery a stopped send may offer,
/// what a running one is allowed to claim, and which action needs a warning are
/// all `InboxSendActions`' and `InboxSendPresentation`'s, and every sentence
/// comes from the latter. That is not tidiness: the one mistake this surface
/// must not make is rendering a finished upload as an arrival, and a `switch` in
/// a view is a `switch` no `swift test` can drive.
///
/// The bearer is read at the moment of use and stored in no `@State`, so a
/// sign-out landing between a button being enabled and that button being tapped
/// produces an honest route to the Account destination rather than a request
/// with an empty credential.

/// Every delivery this account still has outstanding, newest first.
struct DeviceDeliveryList: View {
    @ObservedObject var deliveries: InboxSendModel
    let onOpenAccount: () -> Void

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
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(deliveries.items) { item in
                    card(item)
                }
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
                .foregroundStyle(Palette.supportingLabel)
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
                InlineMessage(.warning, InboxSendPresentation.text(for: error))
            }

            DeliveryActions(item: item, deliveries: deliveries,
                            onOpenAccount: onOpenAccount)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(InboxSendPresentation.accessibilityLabel(of: item))
        .accessibilityIdentifier("delivery.\(item.id)")
    }
}

/// The controls one outstanding delivery offers, wherever it is drawn.
///
/// **One implementation, two hosts.** The outstanding list above and the active
/// section on a device's conversation page both render the same send, and a
/// second copy of these buttons is how one of them would end up missing the
/// discard confirmation — which is the control that deletes this device's only
/// copy of a staged file. So the offer, the warning and the credential rule live
/// here once, and both hosts render this.
///
/// Which actions exist for a given item is `InboxSendActions.offered`; which of
/// them needs the "it may still arrive" warning is
/// `InboxSendActions.warnsDeliveryMayStillArrive`. Neither is re-decided here.
struct DeliveryActions: View {
    let item: InboxSendItem
    @ObservedObject var deliveries: InboxSendModel
    let onOpenAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    /// Whether this item's discard is waiting on a confirmation.
    ///
    /// Scoped to the one item this view renders, so a dialog can never be raised
    /// about a different delivery — which is what a list-level flag risked.
    @State private var isConfirmingDiscard = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.tight) {
            ForEach(InboxSendActions.offered(for: item), id: \.self) { action in
                actionButton(action)
            }
        }
        .confirmationDialog(L10n.t(.uploadDiscard),
                            isPresented: $isConfirmingDiscard,
                            titleVisibility: .visible) {
            Button(L10n.t(.uploadDiscard), role: .destructive) {
                isConfirmingDiscard = false
                perform(.discard)
            }
            Button(L10n.t(.commonCancel), role: .cancel) { isConfirmingDiscard = false }
        } message: {
            // The honest warning: nothing local matters here, but a delivery may
            // already exist and the user is about to stop being able to watch it.
            Text(InboxSendPresentation.warning(for: .discard, on: item)
                 ?? L10n.t(.sendDiscardMayArrive))
        }
    }

    /// One recovery control.
    ///
    /// The spoken name carries the device and the contents as well as the verb,
    /// because three outstanding deliveries offer three identical "Discard"
    /// buttons, one of which deletes this device's only copy of a file.
    @ViewBuilder
    private func actionButton(_ action: InboxSendAction) -> some View {
        switch action {
        case .send, .retry:
            Button { activate(action) } label: {
                Text(InboxSendPresentation.label(for: action)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        case .discard, .cancelDelivery:
            // Destructive and marked as such. Discard deletes this device's only
            // copy of the staged files; Cancel delivery asks central to drop a
            // delivery that may be about to land.
            Button(role: .destructive) { activate(action) } label: {
                Text(InboxSendPresentation.label(for: action)).frame(maxWidth: .infinity)
            }
            .borderedAction(.destructive)
            .controlSize(.large)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        case .stopAttempt, .dismiss:
            Button { activate(action) } label: {
                Text(InboxSendPresentation.label(for: action)).frame(maxWidth: .infinity)
            }
            .borderedAction()
            .controlSize(.large)
            .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        }
    }

    private func activate(_ action: InboxSendAction) {
        // Which combination needs the warning is `InboxSendActions`' decision,
        // where a test can read it, rather than a condition repeated here.
        guard !InboxSendActions.warnsDeliveryMayStillArrive(action, for: item) else {
            isConfirmingDiscard = true
            return
        }
        perform(action)
    }

    private func perform(_ action: InboxSendAction) {
        switch action {
        case .stopAttempt, .dismiss:
            // Neither touches the server, and neither removes anything durable.
            // Routing them through a credential check would send a user to the
            // Account destination to stop their own upload.
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
}
