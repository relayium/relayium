import Foundation

/// How a key-bearing link (a stored-file URL whose `#k=` fragment IS the
/// decryption key) is written to the clipboard.
///
/// The fragment never reaches the server, so the clipboard is the one place the
/// app itself hands the plaintext capability to something else. The write stays
/// an explicit, user-pressed Copy; this policy only narrows where the copy can
/// travel and how long it lingers:
///
/// - **iOS:** local-only (not offered to Universal Clipboard / Handoff on the
///   user's other devices) and expiring after `expiryInterval`.
/// - **macOS:** the nspasteboard.org transient and concealed marker types, which
///   clipboard-history tools that honour them use to skip or hide the entry —
///   the same markers the LAN address copy already writes.
///
/// It names no UIKit or AppKit type: this module renders nothing, and each app
/// applies the policy with its own platform call beside the view.
public enum CapabilityLinkClipboard {
    /// How long an iOS copy stays on the pasteboard. Long enough to switch to
    /// another app and paste; short enough that a forgotten key does not sit
    /// there for the rest of the day.
    public static let expiryInterval: TimeInterval = 10 * 60

    /// iOS: never offered to the user's other devices.
    public static let localOnly = true

    /// When an iOS copy made at `now` expires.
    public static func expiration(from now: Date) -> Date {
        now.addingTimeInterval(expiryInterval)
    }

    /// The UTI the link itself is written under — the platform's plain-text
    /// string type on both systems.
    public static let textType = "public.utf8-plain-text"

    // nonlocalized: nspasteboard.org marker types
    public static let transientMarkerType = "org.nspasteboard.TransientType"
    // nonlocalized: nspasteboard.org marker types
    public static let concealedMarkerType = "org.nspasteboard.ConcealedType"

    /// Every (type, value) pair one macOS copy writes, in order: the link, then
    /// the two empty marker types.
    public static func macEntries(for link: String) -> [(type: String, value: String)] {
        [(textType, link), (transientMarkerType, ""), (concealedMarkerType, "")]
    }
}
