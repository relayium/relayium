import AppKit
import RelayiumAppKit
@preconcurrency import UserNotifications

/// Device Inbox banners.
///
/// The content is decided in `InboxNotificationPresentation` and the "is this
/// news?" question is decided by `InboxNotificationLedger`; both live in the
/// package where `swift test` can drive them. What is left here is the part that
/// needs the app bundle: the authorization prompt and the platform call.
///
/// ## What can be in one of these, and what cannot
///
/// `InboxNotification` carries a count and a closed code, and that is the whole
/// vocabulary — there is no field on it through which a file name, a destination
/// path, an account email, a device id, a task id, a bearer or key material could
/// travel. That is deliberate and it is the reason the type is shaped that way: a
/// macOS notification preview is drawn on the LOCK SCREEN, so anyone who walks
/// past the Mac reads it. "3 files saved" is the most a passer-by may learn about
/// what somebody sent to this machine.
///
/// ## Why it does not go quiet while the app is frontmost
///
/// `TransferNotifier` suppresses a banner when the user is looking at the window,
/// because there the transfer they started is on screen in front of them. This
/// one is the opposite case by design: a delivery arrives unprompted, the window
/// is usually closed, and the settings pane that would have shown it may never be
/// opened. A redundant banner while Settings happens to be open is a much smaller
/// cost than a silent one while it is not.
@MainActor
final class InboxNotifier: InboxNotifying {
    private let center = UNUserNotificationCenter.current()
    /// Replaced rather than stacked: one problem is one banner, and re-announcing
    /// a DIFFERENT problem should supersede the previous line instead of leaving
    /// two contradictory ones in Notification Centre.
    // nonlocalized: a notification request identifier, never displayed
    private static let attentionIdentifier = "relayium-inbox-attention"

    nonisolated func deliver(_ notification: InboxNotification) {
        // Hopped rather than called directly: the controller publishes from the
        // main actor, but the protocol is `Sendable` so that the package's own
        // tests can drive it from anywhere.
        Task { @MainActor [weak self] in self?.post(notification) }
    }

    private func post(_ notification: InboxNotification) {
        let title = InboxNotificationPresentation.title(notification)
        let body = InboxNotificationPresentation.body(notification)
        let identifier: String
        switch notification {
        case .saved:
            // A distinct identifier per delivery: two batches landing minutes
            // apart are two events, and the ledger has already refused the
            // duplicates that are not.
            identifier = "relayium-inbox-saved-\(UUID().uuidString)"  // nonlocalized: an id
        case .attention, .failed:
            identifier = Self.attentionIdentifier
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content,
                                            trigger: nil)
        center.getNotificationSettings { [center] settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                // Asked at the moment there is something to say, and the message
                // is then delivered rather than dropped.
                //
                // A separate `prepare()` at launch was the first shape of this and
                // it was wrong twice over: nothing called it, so a fresh install
                // would silently never see a banner at all; and it put the system
                // prompt in front of a user who had not yet done anything the
                // notification relates to.
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    guard granted else { return }
                    center.add(request)
                }
            case .authorized, .provisional:
                center.add(request)
            default:
                return
            }
        }
    }
}
