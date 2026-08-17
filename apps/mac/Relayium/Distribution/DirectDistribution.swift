import RelayiumAppKit
import Sparkle
import SwiftUI

/// **The direct-download build's half of the distribution seam.**
///
/// This file is a member of the `Relayium` target and of nothing else. Its twin,
/// `AppStoreDistribution.swift`, is a member of `RelayiumAppStore` and of
/// nothing else, and the two declare the SAME names. That is what lets
/// `RelayiumApp.swift`, `SettingsView.swift`, `AccountView.swift` and
/// `AppVersionGate.swift` — one copy of each, shared by both targets through the
/// same synchronized folder — compile into either product without a single `#if`
/// in them.
///
/// Why membership rather than a compilation condition: `import Sparkle` is the
/// thing that has to differ, and an `#if` around an import leaves the framework
/// in the target's link list either way. The App Store forbids Sparkle — it is a
/// second update mechanism and it needs a Mach-lookup sandbox exception — so the
/// absence has to be structural. `StoreKitLinkageTests` reads the project file
/// to keep it that way.
///
/// The four names, and what each build makes of them:
///
/// | | direct (here) | App Store |
/// | --- | --- | --- |
/// | `AppDistribution.channel` | `.directDownload` | `.macAppStore` |
/// | `AppDistribution.makeSubscriptionModel` | `nil` — billing is on the web | a StoreKit-backed model |
/// | `AppUpdates` | Sparkle's updater | an empty object |
/// | `AppUpdates.startUpdate()` | Sparkle's own check | opens the App Store |
/// | `AppUpdatesMenuItem` / `AppUpdatesSettingsTab` | the update UI | nothing |
enum AppDistribution {
    /// Developer ID, notarized, downloaded from relayium.com, updated by
    /// Sparkle. Billing stays on the web, exactly as it always has.
    static let channel: AppDistributionChannel = .directDownload

    /// **No in-app purchase in this build**, and `nil` is how that is said.
    ///
    /// It is not a disabled feature or an empty catalog: there is no model, so
    /// nothing observes the store, nothing reads the server's catalog, and the
    /// account screen keeps the web hand-off it has always had. The App Store
    /// build's copy of this function is the only place a purchase surface is
    /// ever assembled.
    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? {
        nil
    }
}

/// Sparkle's updater, owned for the life of the process.
///
/// A thin wrapper rather than the controller itself, because the App Store build
/// has to be able to declare a type of this name that owns nothing at all.
@MainActor
final class AppUpdates {
    let controller = SPUStandardUpdaterController(
        // The engineering candidate has no update channel. In particular it
        // must never read the production appcast embedded in the ordinary
        // direct-download Info.plist.
        startingUpdater: !AppEnvironment.isEngineeringCandidate,
        updaterDelegate: nil,
        userDriverDelegate: nil
    )

    var updater: SPUUpdater { controller.updater }

    /// **The one update action a policy-driven surface may perform.**
    ///
    /// It is Sparkle's ordinary check — the same one the menu item and the
    /// settings pane run — and that is the whole point: the version policy
    /// decides WHETHER the app asks for an update, never where the update comes
    /// from. Sparkle resolves the signed appcast this build was compiled with
    /// and verifies an EdDSA signature before anything is installed, so a
    /// tampered or replayed policy document cannot reach the install path at
    /// all. `SupportedVersionSurfaceTests` refuses any other call here.
    func startUpdate() {
        guard !AppEnvironment.isEngineeringCandidate else { return }
        updater.checkForUpdates()
        #if DEBUG
        // **Observation, and it is compiled out of every Release build.**
        //
        // It records that this function ran, AFTER the line above has started
        // Sparkle's check — so acceptance can assert that the blocked screen's
        // Update button reaches the shipped update path without waiting on an
        // appcast fetch, a signature verification or a download, none of which a
        // UI test may depend on. It publishes nothing unless the process is an
        // acceptance launch.
        //
        // Nothing production is inside this gate: the updater call is the first
        // statement in the function and is not conditional on anything. That is
        // the property `SupportedVersionSurfaceTests` reads the body for.
        UITestUpdateActionWitness.record()
        #endif
    }
}

/// Keeps the SwiftUI command enabled state in sync with Sparkle's updater.
///
/// `canCheckForUpdates` is KVO-backed rather than SwiftUI state, so reading it
/// directly from a button would leave the menu disabled state stale.
@MainActor
final class CheckForUpdatesViewModel: ObservableObject {
    @Published var canCheckForUpdates = false

    init(updater: SPUUpdater) {
        updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }
}

/// The app menu's "Check for Updates…" item.
struct AppUpdatesMenuItem: View {
    let updates: AppUpdates

    var body: some View {
        if !AppEnvironment.isEngineeringCandidate {
            CheckForUpdatesView(updater: updates.updater)
        }
    }
}

struct CheckForUpdatesView: View {
    @ObservedObject private var model: CheckForUpdatesViewModel
    private let updater: SPUUpdater

    init(updater: SPUUpdater) {
        self.updater = updater
        model = CheckForUpdatesViewModel(updater: updater)
    }

    var body: some View {
        Button(L10n.t(.appCheckForUpdates), action: updater.checkForUpdates)
            .disabled(!model.canCheckForUpdates)
    }
}

/// The Settings window's **Updates** tab.
///
/// It moved here from `SettingsView.swift` when that file became shared source:
/// the pane is Sparkle's, and Sparkle is this build's alone. The settings window
/// itself, and its General tab, are unchanged and still shared.
struct AppUpdatesSettingsTab: View {
    let updates: AppUpdates

    var body: some View {
        if !AppEnvironment.isEngineeringCandidate {
            UpdateSettingsView(updater: updates.updater)
                .tabItem { Label(L10n.t(.settingsUpdates), systemImage: "arrow.triangle.2.circlepath") }
        }
    }
}

/// Everything the old single menu item could not say.
struct UpdateSettingsView: View {
    let updater: SPUUpdater

    /// Mirrored into view state because `SPUUpdater` is not an
    /// `ObservableObject`: reading it directly renders once and then never
    /// again, so a toggle would appear to reset itself the next time the window
    /// was opened.
    @State private var automatic: Bool
    @State private var lastCheck: Date?

    init(updater: SPUUpdater) {
        self.updater = updater
        _automatic = State(initialValue: updater.automaticallyChecksForUpdates)
        _lastCheck = State(initialValue: updater.lastUpdateCheckDate)
    }

    var body: some View {
        Form {
            Section {
                Toggle(L10n.t(.settingsAutomaticUpdates), isOn: $automatic)
                    .onChange(of: automatic) { updater.automaticallyChecksForUpdates = $0 }
                Text(L10n.t(.settingsAutomaticUpdatesBody))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section {
                HStack {
                    // Said outright rather than shown as an empty field. "Never
                    // checked" is a real state on a fresh install, and a blank
                    // line reads as a bug.
                    Text(lastCheck.map { L10n.t(.settingsLastChecked, [formatted($0)]) }
                        ?? L10n.t(.settingsNeverChecked))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n.t(.settingsCheckNow)) {
                        updater.checkForUpdates()
                        // Read back rather than stamped locally: Sparkle owns
                        // when a check counted, and a check the user cancelled
                        // at the permission prompt did not.
                        lastCheck = updater.lastUpdateCheckDate
                    }
                }
            }
            // What the user is running. It belongs on this pane and not in the
            // About box alone, because "am I up to date" is the question this
            // whole tab answers, and it cannot be answered without it.
            Section {
                Text(L10n.t(.settingsVersion, [Self.marketingVersion, Self.buildNumber]))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .task {
            automatic = updater.automaticallyChecksForUpdates
            lastCheck = updater.lastUpdateCheckDate
        }
    }

    /// Read from the bundle rather than hard-coded, so a version bump cannot
    /// leave this pane claiming the previous release. The fallbacks are `—`
    /// rather than a guess: a bundle without these keys is broken, and inventing
    /// a number would hide that from whoever is reading a bug report.
    // nonlocalized: an em dash placeholder for a missing bundle value
    private static let missing = "—"
    private static var marketingVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? missing
    }
    private static var buildNumber: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? missing
    }

    /// The user's own locale and time zone, not the app's copy language: this is
    /// a timestamp on their Mac, and `DateFormatter`'s localized styles already
    /// order and punctuate it the way that Mac does.
    private func formatted(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
