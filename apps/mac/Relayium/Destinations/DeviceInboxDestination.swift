import SwiftUI
import RelayiumAppKit

/// Files sent to this Mac from the owner's own account — a first-class sidebar
/// destination, beside LAN Transfer, Cross-network Transfer, Send a link and
/// Account.
///
/// **Why this exists at all.** Every technical gate this capability had was
/// green: a resident receiver, a signed runtime suite, a menu-bar status line and
/// a complete ⌘, pane. It was still, in practice, missing — the only way to the
/// full surface was a settings window the user had to already know to open, and
/// the menu-bar item that promised a route sent them there rather than into the
/// product. PRD §12 states the requirement in the same terms: a first-class macOS
/// sidebar entry, not a card buried in Settings. The ⌘, pane has since gone
/// entirely: this is the surface, and the menu bar is the way back to it.
///
/// **The row stays visible signed out**, which is the other half of the same
/// point. A destination that appears only once you have an account cannot be what
/// tells you the feature is there; the sidebar names it always, and this screen
/// explains what it does and offers the two actions that make it usable — sign in
/// and create an account, both in the app.
///
/// It renders `DeviceInboxSurface` and decides nothing about it. The one thing it
/// owns is where the account actions go, and from inside the main window that is
/// a single navigation write: the Account destination is one row away.
struct DeviceInboxDestination: View {
    @EnvironmentObject private var navigation: AppNavigationModel

    var body: some View {
        // `contentMaxWidth: nil` and `scrolls: false` for one reason each. The
        // surface is a grouped `Form` — structured controls rather than prose, so
        // it takes the detail column like the roster and the account list do — and
        // a `Form` scrolls itself, so wrapping it in the scaffold's `ScrollView`
        // would nest two scroll views around one list of sections.
        DestinationScaffold(title: L10n.t(.inboxTitle),
                            symbol: MacSurface.deviceInbox.symbol,
                            purpose: L10n.t(.navDeviceInboxSubtitle),
                            contentMaxWidth: nil,
                            scrolls: false) {
            DeviceInboxSurface { intent in
                navigation.selectAccount(intent: intent)
            }
        }
    }
}
