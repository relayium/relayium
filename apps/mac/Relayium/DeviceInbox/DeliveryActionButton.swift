import RelayiumAppKit
import SwiftUI

/// **One recovery control for one delivery — and the only place in macOS that
/// activates one.**
///
/// It exists because the Device Inbox now renders a send's actions in two
/// places: the outstanding list on the landing page, which is about every device,
/// and the open device's own screen, which is about the send to that one. Those
/// are different layouts of the same decisions, and the decisions are the part
/// that must not be written twice:
///
///  * **which credential an action needs.** `stopAttempt` and `dismiss` touch
///    nothing on the server and nothing durable, so routing them through a
///    credential check would send somebody to the Account screen to stop their
///    own upload. The other four spend the bearer, read at the moment of use —
///    a sign-out can land between a button being drawn and being pressed.
///  * **which one needs a warning first.** Exactly one combination does, and
///    `InboxSendActions.warnsDeliveryMayStillArrive` is where a test can read it
///    rather than a condition repeated at each call site.
///  * **which ones are destructive.** Discard deletes this device's only copy of
///    the staged files; Cancel delivery asks central to drop a delivery that may
///    be about to land. Both are marked, in both hosts.
///
/// The spoken name carries the device and the contents as well as the verb,
/// because a screen with three outstanding deliveries offers a VoiceOver user
/// three identical *Discard* buttons, one of which deletes their only local copy
/// of a file.
struct DeliveryActionButton: View {
    let action: InboxSendAction
    let item: InboxSendItem
    @ObservedObject var deliveries: InboxSendModel
    /// Drawn as the screen's primary control rather than as one of a row.
    ///
    /// Used by the open device's screen for the single action that STOPS what is
    /// happening now: a running send whose Cancel is one bordered button among
    /// four is a Cancel somebody cannot find while they are watching their files
    /// go to the wrong machine.
    var isProminent = false
    /// Where a refusal whose remedy is the account goes.
    let onAccount: () -> Void

    @EnvironmentObject private var session: AccountSession

    /// Whether this button's own destructive confirmation is up.
    ///
    /// Owned by the button rather than by either host, so the dialog can never
    /// be raised for a different card than the one that was pressed.
    @State private var isConfirming = false

    private var isDestructive: Bool {
        action == .discard || action == .cancelDelivery
    }

    var body: some View {
        Button(role: isDestructive ? ButtonRole.destructive : nil) {
            activate()
        } label: {
            Text(InboxSendPresentation.label(for: action))
        }
        .modifier(DeliveryButtonWeight(isProminent: isProminent))
        .accessibilityLabel(InboxSendPresentation.actionLabel(for: action, on: item))
        .accessibilityIdentifier("inbox-delivery-\(action.rawValue)")
        .confirmationDialog(L10n.t(.uploadDiscard),
                            isPresented: $isConfirming,
                            titleVisibility: .visible) {
            Button(L10n.t(.uploadDiscard), role: .destructive) {
                isConfirming = false
                perform()
            }
            Button(L10n.t(.commonCancel), role: .cancel) { isConfirming = false }
        } message: {
            // The honest warning: nothing local matters here, but a delivery may
            // already exist and the user is about to stop being able to watch it.
            Text(InboxSendPresentation.warning(for: action, on: item)
                 ?? L10n.t(.sendDiscardMayArrive))
        }
    }

    private func activate() {
        // Which combination needs the warning is `InboxSendActions`' decision,
        // where a test can read it, rather than a condition repeated here.
        guard !InboxSendActions.warnsDeliveryMayStillArrive(action, for: item) else {
            isConfirming = true
            return
        }
        perform()
    }

    private func perform() {
        switch action {
        case .stopAttempt, .dismiss:
            // Neither touches the server, and neither removes anything durable.
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

/// The weight of one delivery control, as a modifier rather than as a branch.
///
/// `.buttonStyle` takes a concrete type, so a `?:` between two styles does not
/// compile, and the obvious alternative — an `if`/`else` around the whole button
/// — would duplicate its action, its role, its spoken name and its confirmation
/// dialog in two arms differing by a single modifier. A `@ViewBuilder` body on a
/// `ViewModifier` is where SwiftUI allows that branch to be one line.
private struct DeliveryButtonWeight: ViewModifier {
    let isProminent: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if isProminent {
            content.buttonStyle(.borderedProminent)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}
