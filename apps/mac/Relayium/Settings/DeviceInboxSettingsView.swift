import RelayiumAppKit
import SwiftUI

/// ⌘, ▸ Device Inbox — the same surface the main window's Device Inbox
/// destination renders, reachable from the settings window a Mac user reaches
/// for out of habit.
///
/// **It is no longer the only full entry, and that is the point of this file
/// being four lines.** It was, and the consequence was measured: a capability
/// with a resident receiver, a menu-bar line and a complete settings pane was in
/// practice absent, because nothing in the product named it anywhere a user
/// looks first. `DeviceInboxDestination` is now the first-class entry;
/// `DeviceInboxSurface` is the one implementation both of them render, so the two
/// cannot drift into telling the user different things.
///
/// The only thing this host decides is where its account actions go, and it is
/// the half the destination does not have: the Account destination lives in the
/// main window, which may not be open at all. So this brings it up first, and
/// selects the half of the form the button promised — never a website.
struct DeviceInboxSettingsView: View {
    @EnvironmentObject private var navigation: AppNavigationModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        DeviceInboxSurface { intent in
            // Selected BEFORE the window is asked for, so it opens already on the
            // half the user pressed rather than rendering the previous
            // destination first and moving under them.
            navigation.selectAccount(intent: intent)
            openWindow(id: "main")
        }
    }
}
