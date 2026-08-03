import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The signed-in account: the plan and its meters, read-only, plus the one
/// write this surface owns — ending the account.
///
/// Read-only for everything else is the product decision, not a shortcut:
/// changing a plan is a billing write and lives on the web. The device list and
/// the stored-file list are R3-D and are absent rather than shown as empty
/// sections promising a later version.
///
/// Rendered by `AccountTab` for `.ready` and only for `.ready`, which is why the
/// deletion section lives here rather than in the tab: the tab is a router over
/// session states, and this is the one state that has an account to delete.
struct AccountSummaryView: View {
    let user: NativeUser
    let usage: UsageResponse

    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL

    /// Whether the account-deletion confirmation is up. Nothing has been asked
    /// of the server until the user confirms, so it is this screen's own state.
    @State private var confirmingAccountDeletion = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName.isEmpty ? user.email : user.displayName)
                    .font(.title3.weight(.semibold))
                Text(user.email).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(usage.plan.name).font(.headline)
                    // Both the "should this show at all" predicate and the
                    // wording live in UsagePresentation, where they are tested.
                    // A raw Stripe status must never reach this capsule.
                    if let badge = UsagePresentation.subscriptionBadge(
                        for: usage.plan.subscriptionStatus) {
                        Text(badge)
                            .font(.caption)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Button(L10n.t(.accountManagePlan)) { openURL(AppEnvironment.plansWebURL) }
            }

            meter(L10n.t(.accountTraffic), UsagePresentation.display(usage.traffic))
            meter(L10n.t(.accountStorage), UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            if session.isStale {
                Label(L10n.t(.accountStaleFigures), systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(L10n.t(.commonRefresh)) { Task { await session.refresh() } }
            // An unstructured Task, NOT a `.task` modifier: a successful
            // sign-out removes this view, which would cancel a `.task` part-way
            // through `client.logout` and leave the credential on this device
            // AND valid on the server.
            Button(L10n.t(.commonSignOut), role: .destructive) {
                Task { await session.logOut() }
            }

            deleteAccountSection
        }
        // The system's own confirmation, so it is dismissible and readable the
        // way the platform's users expect. The destructive role is on the
        // button that sends the request; Cancel is the default.
        .confirmationDialog(
            L10n.t(.accountDeleteAccountConfirmTitle),
            isPresented: $confirmingAccountDeletion,
            titleVisibility: .visible
        ) {
            // Labelled for what pressing it does — it sends an email and
            // deletes nothing, which is exactly what the message says.
            Button(L10n.t(.accountDeleteAccountConfirmAction), role: .destructive) {
                confirmingAccountDeletion = false
                // Unstructured on purpose: the session owns the scoping, and
                // this view stays on screen either way.
                Task { await session.requestAccountDeletion() }
            }
            Button(L10n.t(.commonCancel), role: .cancel) { confirmingAccountDeletion = false }
        } message: {
            Text(L10n.t(.accountDeleteAccountConfirmBody, [L10n.token(user.email)]))
        }
    }

    /// Ending the account, in two steps that are deliberately separate: this
    /// button opens a confirmation, the confirmation asks the server for an
    /// email, and only the link in that email destroys anything.
    ///
    /// Findable rather than hidden — a deletion nobody can locate becomes a
    /// support request — and safe because of the double opt-in, not because of
    /// obscurity. Nothing here signs the user out: the credential stays valid
    /// until the server revokes it on confirmation, which is what leaves a way
    /// back to somebody who changes their mind in between.
    @ViewBuilder
    private var deleteAccountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n.t(.accountDeleteAccountHeading)).font(.headline)
            // The address is the user's own: isolated, never translated.
            Text(L10n.t(.accountDeleteAccountBody, [L10n.token(user.email)]))
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            switch session.deletionRequestState {
            case .requested:
                // Not "sent": the endpoint answers the same way whether it
                // mailed anything or throttled the request, and nothing has
                // been deleted either way. A symbol as well as the words, so
                // the notice does not depend on where it sits on screen.
                Label(L10n.t(.accountDeleteAccountRequested, [L10n.token(user.email)]),
                      systemImage: "envelope")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            case let .failed(message):
                // Colour is never the only carrier: the symbol says "problem"
                // to a reader who cannot distinguish the red.
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            case .idle, .requesting:
                EmptyView()
            }

            // One slot, so the layout does not jump and a second press cannot
            // start a second request — the button is not on screen while one is
            // in flight. Labelled rather than a bare spinner, which VoiceOver
            // reads nothing from.
            if isRequestingAccountDeletion {
                ProgressView { Text(L10n.t(.accountDeleteAccountRequesting)) }
            } else {
                // Retrying is this same button: a failure left the account
                // exactly as it was, so there is one action, not two.
                Button(L10n.t(.accountDeleteAccount), role: .destructive) {
                    confirmingAccountDeletion = true
                }
            }
        }
    }

    private var isRequestingAccountDeletion: Bool {
        if case .requesting = session.deletionRequestState { return true }
        return false
    }

    /// Label above value rather than beside it: at the largest Dynamic Type
    /// sizes a row truncates one of the two, and the figure is the point.
    @ViewBuilder
    private func meter(_ title: String, _ display: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline)
            Text(L10n.t(.accountMeterOf, [display.usedText, display.capText]))
                .font(.subheadline).foregroundStyle(.secondary)
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = display.fraction {
                ProgressView(value: fraction)
            }
        }
        // One element, so VoiceOver reads "Traffic, 1 MB of 5 GB" instead of a
        // bare percentage with no idea what it measures.
        .accessibilityElement(children: .combine)
    }
}
