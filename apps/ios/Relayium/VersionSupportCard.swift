import SwiftUI
import RelayiumAppKit

/// This build's version, how it was installed, and — only when this channel
/// can actually deliver one — a newer version and the way to get it (A19).
///
/// Shown on the Account tab in every account state, signed in or not: the
/// policy is fetched anonymously and needs no account, so a person with no
/// account at all still learns that their build is out of date.
///
/// It never blocks anything. `.updateRequired` is a persistent warning with an
/// action; whether a below-minimum iOS build should stop working is the
/// owner's decision (C02), and `IOSVersionSupportState` has no state that
/// could do it.
struct VersionSupportCard: View {
    @ObservedObject var model: IOSVersionSupportModel
    @Environment(\.openURL) private var openURL
    @State private var testFlightFailed = false

    var body: some View {
        SectionCard(L10n.t(.versionTitle)) {
            VStack(alignment: .leading, spacing: Metrics.hairline) {
                // The version text is the bundle's own: isolated, not translated.
                Text(L10n.t(.versionCurrent, [L10n.token(model.currentVersion?.description ?? "–"),
                                              L10n.token(model.currentBuild ?? "–")]))
                    .font(.body.weight(.semibold))
                Text(L10n.t(channelKey))
                    .font(.footnote)
                    .foregroundStyle(Palette.supportingLabel)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("account.version")

            switch model.state {
            case .current:
                Text(L10n.t(.versionStateCurrent))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
            case .unknown:
                Text(L10n.t(.versionStateUnknown))
                    .font(.callout)
                    .foregroundStyle(Palette.supportingLabel)
                    .fixedSize(horizontal: false, vertical: true)
            case let .updateAvailable(target):
                InlineMessage(.info, L10n.t(.versionStateAvailable, [L10n.token(target.description)]))
                updateButton
            case let .updateRecommended(target):
                InlineMessage(.info, L10n.t(.versionStateRecommended, [L10n.token(target.description)]))
                updateButton
            case let .updateRequired(target):
                InlineMessage(.warning, L10n.t(.versionStateRequired, [L10n.token(target.description)]))
                updateButton
            }

            if testFlightFailed {
                InlineMessage(.warning, L10n.t(.versionTestFlightUnavailable))
            }
        }
        // Each visit re-reads the policy; a failure leaves the card as it was.
        .task { await model.refresh() }
    }

    private var channelKey: L10nKey {
        switch model.channel {
        case .appStore: return .versionChannelAppStore
        case .testFlight: return .versionChannelTestFlight
        case .development: return .versionChannelDevelopment
        }
    }

    /// The one destination this channel updates from. Compiled in, never read
    /// from the policy; the model offers a target only on these two channels.
    @ViewBuilder private var updateButton: some View {
        switch model.channel {
        case .appStore:
            Button { openURL(AppEnvironment.iosAppStoreURL) } label: {
                Text(L10n.t(.versionUpdateAppStore)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("account.versionUpdate")
        case .testFlight:
            Button {
                testFlightFailed = false
                openURL(AppEnvironment.iosTestFlightURL) { accepted in
                    testFlightFailed = !accepted
                }
            } label: {
                Text(L10n.t(.versionUpdateTestFlight)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("account.versionUpdate")
        case .development:
            EmptyView()
        }
    }
}

extension IOSDistributionChannel {
    /// This running build's channel, from facts read locally and silently.
    static var current: IOSDistributionChannel {
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        // nonlocalized: a bundle resource name, never displayed
        let profile = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil
        return classify(receiptFileName: Bundle.main.appStoreReceiptURL?.lastPathComponent,
                        hasEmbeddedProvisioningProfile: profile,
                        isSimulator: simulator)
    }
}
