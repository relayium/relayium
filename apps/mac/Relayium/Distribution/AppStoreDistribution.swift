import RelayiumAppKit
import RelayiumKit
import RelayiumStoreKit
import SwiftUI

/// **The Mac App Store build's half of the distribution seam.**
///
/// A member of the `RelayiumAppStore` target and of nothing else. It declares
/// the same four names as `DirectDistribution.swift` — which is a member of
/// `Relayium` and of nothing else — so the shared scene, settings window and
/// account screen compile into either product unchanged.
///
/// **This file is the only place `RelayiumStoreKit` is imported by an app, and
/// the only place a purchase model is assembled.** Both facts are structural:
/// the direct target does not compile this file, so it cannot link the adapter
/// and cannot construct a model however its source is edited.
///
/// What is deliberately absent, and why each absence is load-bearing:
///
///   - **No `import Sparkle`.** The App Store is this build's update mechanism.
///     A second one is grounds for rejection, and Sparkle additionally needs a
///     `temporary-exception.mach-lookup` sandbox entitlement that App Store
///     review does not grant. The MAS entitlements file has no such exception,
///     and `StoreKitLinkageTests` checks both halves.
///   - **No product identifiers.** They come from the server's catalog, over an
///     authenticated request, keyed by this bundle's own identity. A binary that
///     carried them could be shipped pointing at a product no row maps — a
///     failure that lands after the customer has been charged.
enum AppDistribution {
    /// Distributed by Apple, updated by the App Store, billed by StoreKit.
    static let channel: AppDistributionChannel = .macAppStore

    /// The one purchase model in the process, built for the app's lifetime.
    ///
    /// **App-scoped, not screen-scoped, and that is the whole reason this
    /// returns an object the scene keeps.** The model drains the store's update
    /// stream, which is how a renewal, a refund, an Ask-to-Buy approval and — the
    /// case that matters — a purchase interrupted by a crash reach the account.
    /// Every one of those can arrive while no window is open; this app's window
    /// is closable without ending the process, so a model owned by the account
    /// screen would be absent for exactly the intervals it exists to cover.
    ///
    /// Neither closure is state this model may hold. The bearer is read at the
    /// moment of use, because a token captured when a purchase sheet opened can
    /// be revoked before the user finishes with it; the refresh is the session's
    /// own, so what the app renders after a purchase is the SERVER's answer and
    /// never this model's.
    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? {
        // The bundle identity is read from the running bundle rather than
        // written down here, so it cannot drift from what the signed binary
        // actually is — which is also the identity Apple puts in the signed
        // transaction the server verifies. A bundle that cannot name itself is
        // broken beyond anything this surface should paper over, so it gets no
        // model rather than one that asks the server about "".
        guard let bundleID = Bundle.main.bundleIdentifier, !bundleID.isEmpty else { return nil }
        return AppleSubscriptionModel(
            store: StoreKitSubscriptionStore(),
            billing: AppEnvironment.makeAppleBillingService(),
            bundleID: bundleID,
            bearer: bearer,
            refreshAccount: refreshAccount)
    }
}

/// The App Store build has no updater of its own: the App Store updates it.
///
/// An empty type rather than a missing one, because the shared scene owns a
/// value of this name and hands it to the settings window. Nothing is started,
/// nothing is observed, and no update-related code runs in this product.
@MainActor
final class AppUpdates {}

/// No "Check for Updates…" item in the app menu.
///
/// `EmptyView` inside `CommandGroup` contributes no menu item at all, which is
/// the correct App Store behaviour: an item that opened a Sparkle window would
/// be a second update mechanism, and one that did nothing would be worse.
struct AppUpdatesMenuItem: View {
    let updates: AppUpdates

    var body: some View { EmptyView() }
}

/// No **Updates** tab in the settings window.
///
/// `EmptyView` inside `TabView` contributes no tab, so the window is the General
/// tab alone. What the direct build's pane offers — an automatic-check toggle, a
/// last-checked timestamp, a check-now button — are all the App Store's to
/// decide in this product, and restating them here would be three controls that
/// describe nothing this app does.
struct AppUpdatesSettingsTab: View {
    let updates: AppUpdates

    var body: some View { EmptyView() }
}
