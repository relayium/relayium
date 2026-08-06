import RelayiumAppKit
import Sparkle
import SwiftUI

/// ⌘, — the settings this app actually has, rather than a window built to have
/// one.
///
/// Two tabs, and each holds only settings that change what the app DOES:
///
///  - **General** owns residency and the verification default. Residency is the
///    one that needed a home: this app is reachable because it stays running,
///    and until now nothing in it could say "start yourself after a restart".
///  - **Updates** replaces a lone "Check for Updates…" menu item that could
///    neither report when it last looked nor be turned off.
///
/// What is deliberately absent: language (it follows the system, by design), and
/// where received files are written (that is a transport-path change, not a
/// preference this window can honestly present yet).
struct SettingsView: View {
    let updater: SPUUpdater

    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label(L10n.t(.settingsGeneral), systemImage: "gearshape") }
            UpdateSettingsView(updater: updater)
                .tabItem { Label(L10n.t(.settingsUpdates), systemImage: "arrow.triangle.2.circlepath") }
        }
        // A settings window sizes to its largest tab and then keeps that size,
        // so the width is set once here rather than per tab — otherwise the
        // window jumps when the user switches tabs. Height is left to the
        // content: these panes wrap explanatory text, and a fixed height would
        // clip it in the languages whose sentences are longest.
        .frame(width: 520)
    }
}

/// Residency and the verification default.
struct GeneralSettingsView: View {
    @EnvironmentObject private var loginItem: LoginItemPreference
    @EnvironmentObject private var verification: VerificationPreference

    var body: some View {
        Form {
            Section {
                // Bound to the SYSTEM's answer, not to what was last requested.
                // Enabling can legitimately land on `needsApproval`, and a
                // switch that snapped to on would assert something macOS has not
                // agreed to.
                Toggle(L10n.t(.settingsOpenAtLogin), isOn: Binding(
                    get: { loginItem.state == .on },
                    set: { loginItem.set($0) }
                ))
                .disabled(loginItem.state == .unavailable)
                caption(L10n.t(.settingsOpenAtLoginBody))
                loginItemStatus
            }
            Section {
                Toggle(L10n.t(.verifyToggle), isOn: $verification.requiresSASConfirmation)
                caption(L10n.t(.verifyExplainWhat))
                caption(L10n.t(.verifyExplainEncryption))
            }
        }
        .formStyle(.grouped)
        // The user can change this in System Settings while the app runs and
        // nothing notifies it, so the window re-asks every time it appears
        // rather than trusting what it last wrote.
        .task { loginItem.refresh() }
    }

    /// The three states a switch cannot show, each with the action that resolves
    /// it. None of them greys the control out and leaves the user guessing.
    @ViewBuilder
    private var loginItemStatus: some View {
        switch loginItem.state {
        case .needsApproval:
            InlineMessage(.warning, L10n.t(.settingsLoginNeedsApproval))
            openLoginItemsButton
        case .unavailable:
            InlineMessage(.warning, L10n.t(.settingsLoginUnavailable))
        case .on, .off:
            if loginItem.lastChangeRefused {
                InlineMessage(.failure, L10n.t(.settingsLoginRefused))
                openLoginItemsButton
            }
        }
    }

    private var openLoginItemsButton: some View {
        Button(L10n.t(.settingsOpenLoginItems)) {
            // The documented deep link for the Login Items pane. If a future
            // macOS renames it, System Settings opens at its root rather than
            // failing — still the right app, one click further away.
            // nonlocalized: a System Settings pane identifier, not user copy
            guard let url = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
            else { return }
            NSWorkspace.shared.open(url)
        }
        .buttonStyle(.link)
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
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
