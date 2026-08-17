import RelayiumAppKit
import RelayiumKit
import SwiftUI

/// How the account screen reaches the app's one purchase model.
///
/// An environment VALUE rather than an `@EnvironmentObject`, because the honest
/// type is optional: the direct-download build has no purchase model at all, and
/// `@EnvironmentObject` has no way to say that except by crashing the first view
/// that asks for one. The card below takes the object as an `@ObservedObject`
/// parameter, so the optionality lives at the injection point and the
/// observation lives where the state actually is.
private struct AppleSubscriptionModelKey: EnvironmentKey {
    static let defaultValue: AppleSubscriptionModel? = nil
}

extension EnvironmentValues {
    var appleSubscription: AppleSubscriptionModel? {
        get { self[AppleSubscriptionModelKey.self] }
        set { self[AppleSubscriptionModelKey.self] = newValue }
    }
}

/// The App Store build's purchase surface: what is on sale, what buying it is
/// doing right now, and the two controls that are not a purchase — restore, and
/// Apple's own subscription management.
///
/// **It renders the server's answer and never its own.** The tiers, their names
/// and their order come from Relayium's catalog; the prices come from the store;
/// what the account currently HOLDS comes from `/api/me` and is passed in. This
/// view derives no entitlement from a completed purchase — the model asks the
/// session to reload, and the card above this one re-renders from that.
///
/// Every sentence it shows is chosen by `AppleSubscriptionPresentation`, where
/// the choice is tested. Nothing here writes copy, and nothing here decides
/// whether a refusal is recoverable.
struct AppleSubscriptionCard: View {
    @ObservedObject var model: AppleSubscriptionModel
    /// The account this card belongs to. Reloading is keyed on it, so signing in
    /// as somebody else re-reads the catalog rather than leaving the previous
    /// account's eligibility answer on screen.
    let accountID: String
    /// The plan the SERVER says this account holds, for the "current plan"
    /// badge. Never anything derived here.
    let currentPlanID: String
    /// The billing period the SERVER says this account is on (`"monthly"` /
    /// `"yearly"`, or `""` when it could not be resolved).
    ///
    /// Carried beside the plan id because the badge needs BOTH: a monthly
    /// subscriber looking at the yearly row of their own tier is looking at a
    /// different product and a real purchase, and marking it "current" would
    /// tell them they already have it.
    let currentCycle: String
    /// `/api/me`'s `entitlementProvider`, which decides whether Apple's
    /// management control belongs on screen.
    let entitlementProvider: String
    var appleRenewal: AppleRenewalInfo? = nil

    var body: some View {
        SectionCard(title: L10n.t(.subscriptionHeading)) {
            Text(L10n.t(.subscriptionBody))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let renewalNotice { InlineMessage(.info, renewalNotice) }

            // Why this account may not buy, when it may not. Above the offers
            // rather than below them: it is the reason the buttons beneath are
            // disabled, and a reason placed after its consequence is read second.
            if let blocked = AppleSubscriptionPresentation.eligibilityNotice(model.eligibility) {
                InlineMessage(.info, blocked)
                    // nonlocalized: an accessibility identifier
                    .accessibilityIdentifier("subscription-blocked")
            }

            if !model.offers.isEmpty {
                ForEach(rows) { row in
                    offerRow(row)
                }
            } else if isUnavailable {
                // A configured deployment with nothing mapped for this build, or
                // a store that knows none of what there is. Stated as a fact
                // rather than as a failure — nothing went wrong.
                //
                // Gated on the MODEL's own `.unavailable`, never on "no offers
                // yet". Before the first load there are none either, and the
                // second reading would flash "there is nothing to subscribe to"
                // at every user for the frame before the catalog is asked for —
                // a false statement about the product, on the screen whose whole
                // job is to sell it.
                Text(L10n.t(.subscriptionNone))
                    .font(.caption).foregroundStyle(.secondary)
                    // nonlocalized: an accessibility identifier
                    .accessibilityIdentifier("subscription-none")
            }

            if let notice = AppleSubscriptionPresentation.notice(for: model.state) {
                switch notice {
                case .progress(let text):
                    ProgressView { Text(text) }
                        .controlSize(.small)
                        // nonlocalized: an accessibility identifier
                        .accessibilityIdentifier("subscription-progress")
                case .info(let text):
                    InlineMessage(.info, text)
                        // nonlocalized: an accessibility identifier
                        .accessibilityIdentifier("subscription-notice")
                case .success(let text):
                    // `.info` rather than a green mark: what the user should
                    // read is the plan row above, which the session refresh has
                    // already updated. This line says the purchase landed.
                    InlineMessage(.info, text)
                        // nonlocalized: an accessibility identifier
                        .accessibilityIdentifier("subscription-notice")
                case .failure(let text):
                    InlineMessage(.failure, text)
                        // nonlocalized: an accessibility identifier
                        .accessibilityIdentifier("subscription-failure")
                }
            }

            HStack {
                // Always available, including while a purchase is blocked and
                // while nothing is on sale: it submits what this Apple ID
                // already owns, and the moment it is most needed is the one
                // where something else has gone wrong.
                Button(L10n.t(.subscriptionRestore)) {
                    Task { await model.restore() }
                }
                .disabled(isBusy)
                // nonlocalized: an accessibility identifier
                .accessibilityIdentifier("subscription-restore")

                // Only when there IS an App Store subscription. It opens
                // Apple's own subscription list, which is the only place one can
                // be changed or cancelled — and which would not have Relayium in
                // it for anybody else.
                if AppleSubscriptionPresentation.showsAppleManagement(
                    entitlementProvider: entitlementProvider) {
                    Button(L10n.t(.subscriptionManage)) {
                        NSWorkspace.shared.open(AppEnvironment.appleSubscriptionsURL)
                    }
                    .buttonStyle(.link)
                    // nonlocalized: an accessibility identifier
                    .accessibilityIdentifier("subscription-manage")
                }
                Spacer()
            }

            if AppleSubscriptionPresentation.showsAppleManagement(
                entitlementProvider: entitlementProvider) {
                Text(L10n.t(.subscriptionManagedByApple))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            legalLinks
        }
        // Keyed on the account, so signing in as somebody else re-reads the
        // catalog. The read is per-account — its eligibility half is — so
        // carrying the previous answer over would be the wrong answer, not a
        // stale one.
        .task(id: accountID) { await model.loadOffers() }
    }

    /// **The privacy policy and the terms, on the screen that sells the
    /// subscription.** Not a footer somewhere else in the app, and not a
    /// Settings pane: App Store review requires both to be reachable from the
    /// purchase surface itself, and a submission without them is refused before
    /// anyone looks at the product.
    ///
    /// Unconditional, deliberately. Everything else on this card is gated on a
    /// state — what is on sale, what the server allows, whether Apple bills this
    /// account — and a legal link that disappeared when the catalog failed to
    /// load would be missing at exactly the moment a reviewer or a user went
    /// looking for it.
    ///
    /// `Link` rather than a `Button` that opens a URL, unlike the "manage"
    /// control above: these are ordinary external web pages, and `Link` is what
    /// makes them read and behave as web links — right-click to copy the
    /// address, and the system's own handling of the destination. The manage
    /// control stays a button because its address is not a page at all; macOS
    /// routes it into the App Store app.
    @ViewBuilder
    private var legalLinks: some View {
        HStack(spacing: 12) {
            Link(L10n.t(.subscriptionPrivacy), destination: AppEnvironment.privacyWebURL)
                // nonlocalized: an accessibility identifier
                .accessibilityIdentifier("subscription-privacy")
            Link(L10n.t(.subscriptionTerms), destination: AppEnvironment.termsWebURL)
                // nonlocalized: an accessibility identifier
                .accessibilityIdentifier("subscription-terms")
            Spacer()
        }
        .font(.caption)
    }

    private var rows: [AppleSubscriptionOfferRow] {
        AppleSubscriptionPresentation.offerRows(model.offers, currentPlanID: currentPlanID,
                                                currentCycle: currentCycle, entitlementProvider: entitlementProvider)
    }

    private var renewalNotice: String? {
        AppleSubscriptionPresentation.renewalNotice(appleRenewal, rows: rows)
    }

    @ViewBuilder
    private func offerRow(_ row: AppleSubscriptionOfferRow) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.title).font(.subheadline.weight(.semibold))
                    // The billing period, beside the name rather than only
                    // inside the price sentence: with two rows per tier, this
                    // is the field the reader is choosing between.
                    if !row.cycleLabel.isEmpty {
                        Text(row.cycleLabel)
                            .font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                            // nonlocalized: an accessibility identifier
                            .accessibilityIdentifier("subscription-cycle-\(row.productID)")
                    }
                    if row.isCurrentPlan {
                        Text(L10n.t(.subscriptionCurrent))
                            .font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                            // nonlocalized: an accessibility identifier
                            .accessibilityIdentifier("subscription-current-\(row.productID)")
                    }
                }
                // The store's own price, in this language's per-period sentence.
                // Nothing here reformats the number or the currency.
                Text(row.price).font(.caption).foregroundStyle(.secondary)
                let effect = AppleSubscriptionPresentation.effectText(row.changeEffect)
                if !effect.isEmpty { Text(effect).font(.caption).foregroundStyle(.secondary) }
                // What the tier actually grants, from the server's own plan row.
                // Absent only against a deployment that does not send it.
                if let entitlements = row.entitlements {
                    Text(entitlements).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        // nonlocalized: an accessibility identifier
                        .accessibilityIdentifier("subscription-entitlements-\(row.productID)")
                }
            }
            Spacer(minLength: 8)
            // No button at all on the row the account already holds — buying the
            // exact product it is already paying for is a second charge, and a
            // disabled control would still read as "you may buy this". The
            // decision is the presentation layer's (`offersSubscribe`), not this
            // view's.
            if row.offersSubscribe {
                Button(L10n.t(.subscriptionSubscribe)) {
                    Task { await model.purchase(productID: row.productID) }
                }
                // Disabled by the SERVER's answer as well as by the app being
                // busy. The model refuses again at the point of sale — this is
                // the visible half of the same rule, not a substitute for it.
                .disabled(isBusy || model.eligibility?.allowed != true)
                // The visible label is one word on every row, which is right to
                // look at and useless to hear when there are four of them. Same
                // rule the device and stored-file rows follow.
                .accessibilityLabel(
                    "\(L10n.t(.subscriptionSubscribe)) \(row.title) \(row.cycleLabel), \(row.price)")
                // nonlocalized: an accessibility identifier
                .accessibilityIdentifier("subscription-buy-\(row.productID)")
            }
        }
    }

    /// The model's own "there is nothing on sale" answer — reached only after a
    /// catalog has actually been read.
    private var isUnavailable: Bool {
        if case .unavailable = model.state { return true }
        return false
    }

    /// Whether anything is in flight that a second press must not race.
    ///
    /// `submitting` is in here for the sharpest reason: Apple has charged and
    /// Relayium has not yet recorded it, and a second purchase started in that
    /// window is a second charge.
    private var isBusy: Bool {
        switch model.state {
        case .loadingOffers, .purchasing, .submitting, .restoring: return true
        // `.purchasesPaused` is deliberately NOT busy: the restore button above
        // has to stay pressable while new sales are stopped, because the person
        // reaching for it has already paid.
        case .unavailable, .purchasesPaused, .idle, .deferred, .nothingToRestore,
             .completed, .failed:
            return false
        }
    }
}
