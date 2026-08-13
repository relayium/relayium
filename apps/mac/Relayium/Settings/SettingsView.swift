import RelayiumAppKit
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
///    neither report when it last looked nor be turned off. **It is the direct
///    download's tab alone.** This file is shared source, compiled into both
///    macOS products, and the pane itself lives behind the distribution seam
///    (`AppUpdatesSettingsTab`): the App Store build is updated by the App
///    Store, so its copy of that view contributes no tab and this window is the
///    General tab by itself.
///
/// **The Device Inbox tab is gone, and the Device Inbox is not.** It had a tab
/// here because Settings was once the only full surface it had; it is a
/// first-class main-window destination and a menu-bar route now, and keeping a
/// third entry meant one capability with two complete screens, one of which the
/// user reached by a different verb. Nothing about the resident receiver, its
/// folder, its policy or its menu-bar line changed — only where the surface is
/// reached from.
///
/// What is deliberately absent: language (it follows the system, by design), and
/// where received files are written (that is a transport-path change, not a
/// preference this window can honestly present yet).
struct SettingsView: View {
    let updates: AppUpdates

    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label(L10n.t(.settingsGeneral), systemImage: "gearshape") }
            AppUpdatesSettingsTab(updates: updates)
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
                // The whole residency control — switch, status, and the remedy
                // for every state that has no switch — lives in one component,
                // because the Device Inbox destination offers the same control
                // and the two used to be written separately. See
                // `LoginItemSetting`.
                LoginItemSetting()
            }
            // **Not a toggle, because this app cannot set it.** Installing
            // Relayium registers the Share extension, and macOS then keeps every
            // new third-party sharing extension switched off until the user
            // allows it in System Settings — verified with `pluginkit -m -p
            // com.apple.share-services`, where the entry appears without the
            // leading `+` that marks an enabled one.
            //
            // There is no public API to read that state, so this says so
            // unconditionally rather than pretending to detect it. Saying
            // nothing was the alternative, and it is the worse one: the feature
            // is simply absent from the Share menu, with nothing anywhere
            // explaining why, which reads as broken rather than as off.
            Section {
                Text(L10n.t(.settingsShareExtension))
                caption(L10n.t(.settingsShareExtensionBody))
                Button(L10n.t(.settingsOpenExtensionSettings)) {
                    // nonlocalized: a System Settings pane identifier, not user copy
                    guard let url = URL(string: "x-apple.systempreferences:com.apple.ExtensionsPreferences")
                    else { return }
                    NSWorkspace.shared.open(url)
                }
                .buttonStyle(.link)
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

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
