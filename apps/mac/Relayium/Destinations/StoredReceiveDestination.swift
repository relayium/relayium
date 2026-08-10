import SwiftUI
import RelayiumAppKit

/// Open a link somebody sent you.
///
/// **The one destination with no sidebar row.** Opening a stored link is
/// something the OS hands this app — a `relayium.com/d/…#k=…` link the user
/// followed somewhere else — rather than somewhere a person sets out for, and a
/// row whose answer to "what do I do here?" was "paste a link you already have"
/// earned its place in the sidebar less than the four that remain.
///
/// Removing the row removed the way to WANDER here, not the way to arrive:
/// `AppDeepLink` still resolves a supported link to `.storedReceive`, the shell
/// still has an arm that draws this, and `MacSurface.browseable` is where the
/// difference between "renderable" and "offered" is stated once.
///
/// **Nothing here consults the account, by name or by reference** — no account
/// object, no bearer, no gate — and `MacSurfaceGuardTests` checks that as a
/// source property rather than as an intention, because this is the capability
/// the old sign-in-first shell hid most completely: a link that works in any
/// browser, in an app that would not show it to you until you had an account.
///
/// `AnonymousCapabilityTests` proves the other half at the transport, where it
/// actually matters: resolving the link and downloading the bytes send no
/// `Authorization` header, no userinfo and no token, in any request.
struct StoredReceiveDestination: View {
    @EnvironmentObject private var model: CloudDownloadModel

    var body: some View {
        DestinationScaffold(title: L10n.t(.navStoredReceive)) {
            SectionCard(title: L10n.t(.downloadHeading)) {
                DownloadPane(model: model)
            }
            InlineMessage(.info, L10n.t(.downloadNoAccountNeeded))
        }
    }
}
