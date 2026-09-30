import Foundation
import RelayiumAppKit
import UIKit

/// The one clipboard write for a key-bearing (`#k=`) link.
///
/// Called only from the action of a Copy button the user pressed. The policy —
/// local-only, expiring — is `CapabilityLinkClipboard`'s; this is just the
/// UIKit call that applies it, and nothing here reads the pasteboard.
@MainActor
func copyCapabilityLink(_ link: String) {
    UIPasteboard.general.setItems(
        [[CapabilityLinkClipboard.textType: link]],
        options: [
            .localOnly: CapabilityLinkClipboard.localOnly,
            .expirationDate: CapabilityLinkClipboard.expiration(from: Date()),
        ])
}
