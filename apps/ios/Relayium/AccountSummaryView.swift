import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The signed-in account, read-only.
///
/// Read-only is the product decision, not a shortcut: changing a plan is a
/// billing write and lives on the web. The device list and the stored-file list
/// are R3-D and are absent rather than shown as empty sections promising a
/// later version.
struct AccountSummaryView: View {
    let user: NativeUser
    let usage: UsageResponse

    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL

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
        }
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
