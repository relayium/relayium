import RelayiumAppKit
import RelayiumStoreKit
import SwiftUI

private struct AppleSubscriptionModelKey: EnvironmentKey {
    static let defaultValue: AppleSubscriptionModel? = nil
}

extension EnvironmentValues {
    var appleSubscription: AppleSubscriptionModel? {
        get { self[AppleSubscriptionModelKey.self] }
        set { self[AppleSubscriptionModelKey.self] = newValue }
    }
}

/// Builds the iOS app's single StoreKit-backed model. Product identifiers stay
/// on Relayium's authenticated server catalog and the running bundle supplies
/// the identity Apple signs into each transaction.
enum IOSAppleSubscriptions {
    static let channel: AppDistributionChannel = .iosAppStore

    @MainActor
    static func makeModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? {
        guard let bundleID = Bundle.main.bundleIdentifier, !bundleID.isEmpty else { return nil }
        return AppleSubscriptionModel(
            store: StoreKitSubscriptionStore(),
            billing: AppEnvironment.makeAppleBillingService(),
            bundleID: bundleID,
            bearer: bearer,
            refreshAccount: refreshAccount)
    }
}

/// The App Store purchase surface. Relayium's server decides which tiers may be
/// sold and which plan the account holds; StoreKit supplies localized prices.
struct AppleSubscriptionCard: View {
    @ObservedObject var model: AppleSubscriptionModel
    let accountID: String
    let currentPlanID: String
    let entitlementProvider: String

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.t(.subscriptionHeading)).font(.headline)
            Text(L10n.t(.subscriptionBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let blocked = AppleSubscriptionPresentation.eligibilityNotice(model.eligibility) {
                Label(blocked, systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("subscription-blocked")
            }

            if !model.offers.isEmpty {
                ForEach(rows) { offerRow($0) }
            } else if isUnavailable {
                Text(L10n.t(.subscriptionNone))
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("subscription-none")
            }

            if let notice = AppleSubscriptionPresentation.notice(for: model.state) {
                switch notice {
                case .progress(let text):
                    ProgressView { Text(text) }
                        .accessibilityIdentifier("subscription-progress")
                case .info(let text), .success(let text):
                    Label(text, systemImage: "info.circle")
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("subscription-notice")
                case .failure(let text):
                    Label(text, systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("subscription-failure")
                }
            }

            Button(L10n.t(.subscriptionRestore)) { Task { await model.restore() } }
                .buttonStyle(.bordered)
                .disabled(isBusy)
                .accessibilityIdentifier("subscription-restore")

            if AppleSubscriptionPresentation.showsAppleManagement(
                entitlementProvider: entitlementProvider) {
                Button(L10n.t(.subscriptionManage)) {
                    openURL(AppEnvironment.appleSubscriptionsURL)
                }
                .accessibilityIdentifier("subscription-manage")
                Text(L10n.t(.subscriptionManagedByApple))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 16) {
                Link(L10n.t(.subscriptionPrivacy), destination: AppEnvironment.privacyWebURL)
                    .accessibilityIdentifier("subscription-privacy")
                Link(L10n.t(.subscriptionTerms), destination: AppEnvironment.termsWebURL)
                    .accessibilityIdentifier("subscription-terms")
            }
            .font(.caption)
        }
        .task(id: accountID) { await model.loadOffers() }
    }

    private var rows: [AppleSubscriptionOfferRow] {
        AppleSubscriptionPresentation.offerRows(model.offers, currentPlanID: currentPlanID)
    }

    private func offerRow(_ row: AppleSubscriptionOfferRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(row.title).font(.subheadline.weight(.semibold))
                if row.isCurrentPlan {
                    Text(L10n.t(.subscriptionCurrent))
                        .font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
            }
            Text(row.price).font(.caption).foregroundStyle(.secondary)
            Button(L10n.t(.subscriptionSubscribe)) {
                Task { await model.purchase(productID: row.productID) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy || model.eligibility?.allowed != true)
            .accessibilityLabel("\(L10n.t(.subscriptionSubscribe)) \(row.title), \(row.price)")
            .accessibilityIdentifier("subscription-buy-\(row.productID)")
        }
        .padding(.vertical, 4)
    }

    private var isUnavailable: Bool {
        if case .unavailable = model.state { return true }
        return false
    }

    private var isBusy: Bool {
        switch model.state {
        case .loadingOffers, .purchasing, .submitting, .restoring: return true
        case .unavailable, .idle, .deferred, .nothingToRestore, .completed, .failed: return false
        }
    }
}
