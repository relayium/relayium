import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct MenuBarView: View {
    @EnvironmentObject private var session: AccountSession
    @EnvironmentObject private var receive: NearbyReceiveModel
    @EnvironmentObject private var discovery: LanDiscoveryModel
    @EnvironmentObject private var inbox: InboxController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // Every state named: a `default:` here claimed "Not signed in" while a
        // token was in hand and the account was merely loading or unreachable,
        // which is the one moment the menu bar is the only surface the user has.
        switch session.state {
        case let .ready(user, usage):
            // The email and the plan name are the account's own data, never
            // translated — only the sentence around them is.
            Text(user.email)
            Text(L10n.t(.menubarPlanUsage,
                        [L10n.token(usage.plan.name),
                         UsagePresentation.display(usage.traffic).usedText]))
        case .restoring:
            Text(L10n.t(.menubarLoadingAccount))
        case .authenticating:
            Text(L10n.t(.menubarSigningIn))
        case .unavailable:
            Text(L10n.t(.menubarSignedInUnreachable))
        case let .emailUnverified(email):
            Text(L10n.t(.menubarEmailUnverified, [L10n.token(email)]))
        case .pendingDeletion:
            Text(L10n.t(.menubarPendingDeletion))
        case .loggedOut, .failed, .registering:
            // `.registering` belongs here, and the sentence stays true through
            // it: creating an account issues no session, so nobody is signed in
            // during it and nobody is signed in when it succeeds — the next
            // state is the check-email one, which has its own line above.
            Text(L10n.t(.menubarNotSignedIn))
        }
        Divider()
        // What background receive is actually doing. With the window closed this
        // is the only place it is visible, and "ready" has to be a claim the app
        // can back up — hence a state per case rather than one optimistic label.
        Text(NearbyStatusPresentation.text(for: receive.state))
        if receive.state == .paused {
            Button(L10n.t(.menubarResumeNearby)) { discovery.resume() }
        } else {
            Button(L10n.t(.menubarPauseNearby)) { discovery.pause() }
                .disabled(isReceiving)
        }
        Divider()
        // Device Inbox. The reason this belongs in the menu bar rather than only
        // in Settings: it runs with the window closed, so for most of its life
        // this is the ONLY surface that can say whether this Mac is currently
        // able to take a delivery — and "ready" has to be a claim the app can
        // back up. One line per state, from the same presentation the settings
        // pane renders, so the two cannot drift.
        Text(L10n.detail([L10n.t(.inboxTitle),
                          InboxStatusPresentation.text(for: inbox.state)]))
        // The smallest safe control set. Pause/resume changes nothing durable;
        // Reveal shows a delivery that has already completed; the third is the
        // way to the surface where every other decision is made. Notably ABSENT:
        // the folder chooser and the policy, both of which are consequential
        // consents that belong on a screen with their explanations, not one
        // click away in a menu that closes on the next click.
        if inbox.isPaused {
            Button(L10n.t(.inboxResume)) { inbox.resume() }
        } else if canPauseInbox {
            Button(L10n.t(.inboxPause)) { inbox.pause() }
        }
        if let latest = inbox.latestResult {
            // Named by the ACTION first and then by count, size and time — never
            // by a file name. A bare summary as a menu title says what happened
            // but not what clicking it does, and this menu is drawn over whatever
            // the user is presenting.
            Button(InboxReceiptPresentation.revealActionLabel(latest)) {
                inbox.reveal(latest)
            }
        }
        // Split by OS version rather than branching inside one action, because
        // the supported API is a SwiftUI environment action and an `@Environment`
        // property cannot be declared conditionally — see `OpenInboxSettingsButton`.
        if #available(macOS 14.0, *) {
            OpenInboxSettingsButton()
        } else {
            Button(L10n.t(.inboxOpenSettings)) { openInboxSettingsLegacy() }
        }
        Divider()
        // The window can be closed while the app keeps running, so this is the
        // only way back to it — including back to a session that arrived while
        // it was closed. Spec'd in "Menu-bar residency".
        Button(L10n.t(isReceiving ? .menubarOpenToSeeTransfer : .menubarOpen)) {
            MenuBarActivation.activateApp()
            openWindow(id: "main")
        }
        // The visible title is localized, while this shortcut stays stable in
        // every language and keeps window recovery keyboard-accessible.
        .keyboardShortcut("o", modifiers: [])
        Divider()
        // The R1-A acceptance signal, kept reachable: proves the Kit is linked and
        // both native cores initialized in the shipped bundle. `ok`/`FAILED` are
        // diagnostic tokens a bug report quotes verbatim, so only the sentence
        // around them is localized. nonlocalized: build diagnostic tokens.
        Text(L10n.t(.menubarCoreStatus, [
            L10n.token(sodiumReady() ? "ok" : "FAILED"),
            L10n.token(webrtcAvailable() ? "ok" : "FAILED"),
        ]))
        Divider()
        Button(L10n.t(.menubarQuit)) { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var isReceiving: Bool {
        if case .active = receive.state { return true }
        return false
    }

    /// Pausing is offered only where it means something: an inbox that is Off,
    /// has no folder, or is already stopped on a blocker has nothing to pause,
    /// and a control with no effect reads as a broken one.
    private var canPauseInbox: Bool {
        switch inbox.state {
        case .ready, .working, .asking, .offline, .saved, .loading:
            return true
        case .signedOut, .disabled, .folderMissing, .paused, .attention, .failed:
            return false
        }
    }

    /// Open ⌘, from the menu bar, on macOS 13 only.
    ///
    /// `showPreferencesWindow:` is an undocumented AppKit selector reached
    /// through the responder chain, and macOS 14 renamed it. It is kept ONLY
    /// because 13 is the deployment target and has no `openSettings`; every
    /// macOS this product is actually run on takes the supported path above.
    /// It is unverified — no macOS 13 machine is available here — which is
    /// precisely why it is confined to the version that has no alternative
    /// rather than left as the shared implementation.
    private func openInboxSettingsLegacy() {
        MenuBarActivation.activateApp()
        // nonlocalized: an AppKit selector, never displayed
        NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
    }
}

/// The menu bar's route to ⌘, on macOS 14 and later.
///
/// **Its own view because of one language rule with a product consequence.**
/// `openSettings` is macOS 14+, and an `@Environment` property cannot be
/// declared under `if #available` — so a view that must also compile for the
/// 13.0 deployment target cannot hold it. Extracting the button is what lets
/// the supported API be used at all without raising the deployment target.
///
/// **Why not the selector this replaced.** `MenuBarView` previously called
/// `NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)`.
/// That is an undocumented selector dispatched through the responder chain, and
/// on macOS 26.6 nothing in this app's chain answers it. Measured here: the
/// click produced NO window with the product window closed, and a throwaway
/// diagnostic during the same session showed it produced none with the window
/// OPEN and the app frontmost either — so this was never a window-state or
/// activation problem, and the item had not worked on that OS in any state.
/// `sendAction` reports that as a discarded `false` while the menu closes
/// looking like it acted, which is why it shipped: the item was present, and
/// presence was all the suite asserted.
///
/// `testTheMenuBarOpensSettingsWithEveryWindowClosed` is the committed
/// regression, and it pins the harder of the two cases — no product window means
/// no responder chain to borrow.
///
/// `openSettings` is the documented replacement Apple added in macOS 14 for
/// exactly this call, and it addresses the `Settings` scene directly instead of
/// hoping a responder implements a private method.
@available(macOS 14.0, *)
private struct OpenInboxSettingsButton: View {
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button(L10n.t(.inboxOpenSettings)) {
            MenuBarActivation.activateApp()
            openSettings()
        }
    }
}

/// Bringing the app forward, shared by the menu-bar actions.
///
/// A type rather than a method on `MenuBarView`, because the settings button
/// above is a separate view for the availability reason recorded on it and
/// needs the same behaviour.
private enum MenuBarActivation {
    /// Clicking a menu-bar item does not bring the app forward, so a window
    /// opened from one would otherwise appear behind whatever the user was
    /// using.
    ///
    /// `NSApp.activate()` is macOS 14+ and this app deploys to 13.0, so the
    /// older call is still needed — and it is deprecated in 14, which would
    /// warn. Putting it in a declaration that is itself marked deprecated is
    /// what silences that without silencing anything else.
    static func activateApp() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            activateAppLegacy()
        }
    }

    // nonlocalized: compiler diagnostic, never rendered
    @available(macOS, deprecated: 14.0, message: "Only reachable on macOS 13.")
    private static func activateAppLegacy() {
        NSApp.activate(ignoringOtherApps: true)
    }
}
