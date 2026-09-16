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
        // One size for every tab, set here rather than per tab, so the window
        // never jumps when the user switches between General and Updates. The
        // height is a bound, not a fit: each tab is a `ReferencePage`, which
        // scrolls inside it, so the longest language, a larger text size or a
        // login-item remedy reaches its last action by scrolling instead of
        // growing the window past a small screen or clipping its bottom.
        .frame(width: 520, height: 460)
        // The reference action colour for the switches and any picker, rather
        // than the catalog's older accent.
        .tint(Palette.action)
    }
}

/// Residency and the verification default.
struct GeneralSettingsView: View {
    @EnvironmentObject private var loginItem: LoginItemPreference
    @EnvironmentObject private var verification: VerificationPreference

    var body: some View {
        ReferencePage {
            SectionCard(title: L10n.t(.settingsStartupHeading)) {
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
            SectionCard(title: L10n.t(.settingsShareMenuHeading)) {
                Text(L10n.t(.settingsShareExtension))
                    .font(.body)
                    .foregroundStyle(Palette.text)
                caption(L10n.t(.settingsShareExtensionBody))
                Button(L10n.t(.settingsOpenExtensionSettings)) {
                    // nonlocalized: a System Settings pane identifier, not user copy
                    guard let url = URL(string: "x-apple.systempreferences:com.apple.ExtensionsPreferences")
                    else { return }
                    NSWorkspace.shared.open(url)
                }
                .buttonStyle(.link)
            }
            SectionCard(title: L10n.t(.verifySecurityHeading)) {
                HStack(spacing: 10) {
                    Text(L10n.t(.verifyToggle))
                        .font(.body)
                        .foregroundStyle(Palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityHidden(true)
                    Spacer(minLength: Metrics.tight)
                    Toggle(L10n.t(.verifyToggle), isOn: $verification.requiresSASConfirmation)
                        .toggleStyle(.switch)
                        .labelsHidden()
                }
                caption(L10n.t(.verifyExplainWhat))
                caption(L10n.t(.verifyExplainEncryption))
            }
        }
        // The user can change this in System Settings while the app runs and
        // nothing notifies it, so the window re-asks every time it appears
        // rather than trusting what it last wrote.
        .task { loginItem.refresh() }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Palette.textTertiary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
