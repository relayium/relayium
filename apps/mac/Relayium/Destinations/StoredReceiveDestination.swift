import SwiftUI
import RelayiumAppKit

/// Open a link somebody sent you.
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
        DestinationScaffold(title: L10n.t(.navStoredReceive),
                            subtitle: L10n.t(.navStoredReceiveSubtitle)) {
            SectionCard(title: L10n.t(.downloadHeading)) {
                DownloadPane(model: model)
            }
            InlineMessage(.info, L10n.t(.downloadNoAccountNeeded))
        }
    }
}
