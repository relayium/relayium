import RelayiumAppKit
import SwiftUI

/// **"Open Relayium at login" — the whole control, in one place, for both
/// surfaces that offer it.**
///
/// Residency is not a nicety for this app: it can receive only while it is
/// running, so whether it starts itself after a restart decides whether this Mac
/// is reachable at all. That is why the control appears both in ⌘, ▸ General and
/// on the Device Inbox destination, which is the screen where somebody first
/// discovers they need it.
///
/// Two hosts, one implementation, for the reason `DeviceInboxSurface` gives for
/// itself: two views rendering "the same" control is how the two surfaces start
/// telling the user different things. The Device Inbox copy of this used to be a
/// bare `Toggle` with `.disabled(state == .unavailable)` and no explanation
/// whatever — the same dead switch the settings pane had already learned to
/// explain, kept alive by being written twice.
///
/// ## No dead disabled toggle, in either state that cannot be toggled
///
/// A greyed switch with nothing beside it is the dead end this app's design
/// rules forbid, and greying it while showing "off" is worse than dead: it reads
/// as a setting that is simply turned off. So the two states with no working
/// switch do not render one. They render what is true — Relayium is not
/// registered — as a non-interactive status line, and then the action that
/// actually resolves that particular state:
///
///  - **`unconfirmed`** (the app is in Applications and macOS has no record):
///    *Try registration*. It is offered as an explicit press rather than done on
///    the app's behalf, because registering an app as a login item is a change to
///    the user's machine that outlives the app.
///  - **`unmanagedLocation`** (translocated, a disk image, a build directory):
///    no registration button at all, because it would fail every time. The
///    remedy is to move the app and reopen it, and that is what it says.
///
/// A registration attempt that succeeds as a call and still leaves the system
/// reporting nothing gets its own sentence and its own next steps. What it does
/// NOT do is unregister to tidy up: the registration may be live and merely
/// unindexed, and destroying a working setup to make a status line consistent is
/// the wrong trade.
///
/// ## Turning it on asks first; turning it off does not
///
/// **App Review rejected this app under Guideline 2.4.5(iii)** — it "added
/// itself to auto-launch at start up" when the reviewer pressed what they read
/// as a *Registration* button in the General pane. Both ways in registered on a
/// single press: moving the switch, and the `unconfirmed` remedy below, whose
/// label said *Try registration* and named neither Login Items nor logging in.
///
/// So both now raise a `consentRequest` and this view asks, in a system
/// confirmation, in words — that confirming adds Relayium to Login Items, that
/// macOS will then open it every time the user logs in, and that it can be
/// turned off again here or in System Settings. Cancelling, Escape and
/// dismissal all leave it unregistered, because `LoginItemPreference` registers
/// only from `confirmConsent()`.
///
/// The off direction keeps its single press. A confirmation there would make
/// residency harder to leave than to take, which is the wrong asymmetry for the
/// setting this is.
struct LoginItemSetting: View {
    @EnvironmentObject private var loginItem: LoginItemPreference

    var body: some View {
        // Bound to the SYSTEM's answer, not to what was last requested.
        // Enabling can legitimately land on `needsApproval`, and a switch that
        // snapped to on would assert something macOS has not agreed to.
        if loginItem.offersToggle {
            Toggle(L10n.t(.settingsOpenAtLogin), isOn: Binding(
                get: { loginItem.state == .on },
                set: { loginItem.set($0) }
            ))
            .accessibilityIdentifier("login-item-toggle")
        } else {
            // The state indicator that replaces the switch. Non-interactive by
            // construction rather than a disabled control: there is nothing here
            // to press, and a control that looks pressable and is not is the
            // thing being avoided.
            StatusBadge(symbol: "power", tint: .secondary,
                        label: L10n.t(.settingsLoginNotRegistered))
                .accessibilityIdentifier("login-item-status")
        }
        caption(L10n.t(.settingsOpenAtLoginBody))
            // **Anchored to this one always-rendered row on purpose.**
            //
            // Not to a `Group` around the whole control: SwiftUI applies a
            // modifier written on a `Group` to each of its children, so that
            // spelling builds one confirmation per row and the user dismisses
            // the same question three times. And not to the toggle or to a
            // remedy, because both come and go with the state — the request can
            // outlive the row that raised it, and a presenter that disappeared
            // takes the question with it while `consentRequest` stays set.
            //
            // The caption is the row every state renders, so it is the one that
            // can always present this. A dialog is a window-level presentation
            // regardless of what it hangs off, so nothing about the layout
            // depends on the choice.
            .confirmationDialog(
                L10n.t(.settingsLoginConsentTitle),
                isPresented: Binding(
                    get: { loginItem.consentRequest != nil },
                    // Every way out that is not the confirm button — Cancel,
                    // Escape, clicking away — lands here, and all of them leave
                    // the app unregistered.
                    //
                    // This does NOT swallow the confirm: SwiftUI runs a
                    // dialog's button action before it sets `isPresented` back
                    // to false, so `confirmConsent()` has already taken the
                    // request by the time this fires and finds nothing to put
                    // down. The app's three other confirmations depend on that
                    // same order more sharply than this one does —
                    // `AccountView`'s delete reads `fileToDelete` INSIDE its
                    // action, and would delete nothing if dismissal ran first.
                    set: { if !$0 { loginItem.cancelConsent() } }
                ),
                titleVisibility: .visible
            ) {
                Button(L10n.t(.settingsLoginConsentConfirm)) { loginItem.confirmConsent() }
                    .accessibilityIdentifier("login-item-consent-confirm")
                Button(L10n.t(.commonCancel), role: .cancel) { loginItem.cancelConsent() }
                    .accessibilityIdentifier("login-item-consent-cancel")
            } message: {
                Text(L10n.t(.settingsLoginConsentBody))
            }
        remedies
    }

    /// Every state that is not a plain on/off says what it is and what resolves
    /// it. None of them leaves the user guessing.
    @ViewBuilder
    private var remedies: some View {
        switch loginItem.state {
        case .needsApproval:
            InlineMessage(.warning, L10n.t(.settingsLoginNeedsApproval))
                .accessibilityIdentifier("login-item-needs-approval")
            openLoginItemsButton

        case .unconfirmed:
            InlineMessage(.warning, L10n.t(.settingsLoginUnconfirmed))
                .accessibilityIdentifier("login-item-unconfirmed")
            Button(L10n.t(.settingsLoginTryRegistration)) { loginItem.attemptRegistration() }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("login-item-register")
            // The outcome with no obvious next step, said outright. It is not a
            // failure — nothing threw — and it is not success, so it borrows
            // neither sentence.
            if loginItem.lastRegistrationUnconfirmed {
                InlineMessage(.warning, L10n.t(.settingsLoginStillUnconfirmed))
                    .accessibilityIdentifier("login-item-still-unconfirmed")
            }
            openLoginItemsButton

        case .unmanagedLocation:
            // Deliberately no registration button: from here it would fail every
            // time it was pressed. Relocation is the only thing that works.
            InlineMessage(.warning, L10n.t(.settingsLoginUnmanagedLocation))
                .accessibilityIdentifier("login-item-unmanaged")

        case .on, .off:
            if loginItem.lastChangeRefused {
                InlineMessage(.failure, L10n.t(.settingsLoginRefused))
                    .accessibilityIdentifier("login-item-refused")
                openLoginItemsButton
            }
        }
    }

    /// Through the service, which asks `ServiceManagement` for its own pane
    /// rather than opening a System Settings URL that a macOS release can rename.
    private var openLoginItemsButton: some View {
        Button(L10n.t(.settingsOpenLoginItems)) { loginItem.openSystemSettings() }
            .buttonStyle(.link)
            .accessibilityIdentifier("login-item-open-settings")
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
