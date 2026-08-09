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
        Button(L10n.t(.inboxOpenSettings)) { openInboxSettings() }
        Divider()
        // The window can be closed while the app keeps running, so this is the
        // only way back to it — including back to a session that arrived while
        // it was closed. Spec'd in "Menu-bar residency".
        Button(L10n.t(isReceiving ? .menubarOpenToSeeTransfer : .menubarOpen)) {
            activateApp()
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

    /// Open ⌘, from the menu bar.
    ///
    /// `showSettingsWindow:` on macOS 14+, `showPreferencesWindow:` below it.
    /// The app deploys to 13.0, so the older selector is still needed — and it
    /// no longer exists on 14, which is why this is a version check rather than
    /// one call with a fallback.
    private func openInboxSettings() {
        activateApp()
        if #available(macOS 14.0, *) {
            // nonlocalized: an AppKit selector, never displayed
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        } else {
            // nonlocalized: an AppKit selector, never displayed
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }

    /// Clicking a menu-bar item does not bring the app forward, so the reopened
    /// window would otherwise appear behind whatever the user was using.
    ///
    /// `NSApp.activate()` is macOS 14+ and this app deploys to 13.0, so the older
    /// call is still needed — and it is deprecated in 14, which would warn. Putting
    /// it in a declaration that is itself marked deprecated is what silences that
    /// without silencing anything else.
    private func activateApp() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            activateAppLegacy()
        }
    }

    // nonlocalized: compiler diagnostic, never rendered
    @available(macOS, deprecated: 14.0, message: "Only reachable on macOS 13.")
    private func activateAppLegacy() {
        NSApp.activate(ignoringOtherApps: true)
    }
}
