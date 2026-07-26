import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct AccountView: View {
    let user: NativeUser
    let usage: UsageResponse

    @EnvironmentObject private var session: AccountSession

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName.isEmpty ? user.email : user.displayName).font(.title2.weight(.semibold))
                Text(user.email).foregroundStyle(.secondary)
            }

            HStack {
                Text(usage.plan.name).font(.headline)
                if usage.plan.subscriptionStatus != "active" && !usage.plan.subscriptionStatus.isEmpty {
                    Text(usage.plan.subscriptionStatus)
                        .font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
                // macOS ships as a direct download, so billing is compliant on the web.
                // The app shows the tier read-only and hands off.
                Button("Manage plan") { NSWorkspace.shared.open(AppEnvironment.productionBaseURL) }
            }

            meter("Traffic", UsagePresentation.display(usage.traffic))
            meter("Storage", UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            if session.isStale {
                Label("Showing the last known figures — couldn't reach the server.", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Spacer()

            HStack {
                Button("Refresh") { Task { await session.refresh() } }
                Spacer()
                Button("Sign out") { session.logOut() }
            }
        }
    }

    @ViewBuilder
    private func meter(_ title: String, _ d: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text("\(d.usedText) of \(d.capText)").font(.subheadline).foregroundStyle(.secondary)
            }
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = d.fraction {
                ProgressView(value: fraction)
            }
        }
    }
}
