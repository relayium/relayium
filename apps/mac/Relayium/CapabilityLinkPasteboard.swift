import AppKit
import RelayiumAppKit

/// The one clipboard write for a key-bearing (`#k=`) link.
///
/// Called only from the action of a Copy button the user pressed. The link is
/// written as plain text followed by the transient and concealed marker types
/// `CapabilityLinkClipboard` names, so clipboard-history tools that honour them
/// do not keep the decryption key. Nothing here reads the pasteboard.
@MainActor
func copyCapabilityLink(_ link: String) {
    let board = NSPasteboard.general
    board.clearContents()
    for entry in CapabilityLinkClipboard.macEntries(for: link) {
        board.setString(entry.value, forType: NSPasteboard.PasteboardType(entry.type))
    }
}
