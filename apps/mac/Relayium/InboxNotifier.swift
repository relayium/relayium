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
/// A received MESSAGE is the sharpest case of that rule, and it is the one the
/// type settles rather than this file: `savedMessage` has no associated value at
/// all, so there is nothing here to render even by mistake. The banner says that
/// something arrived and where to read it; the text itself is in
/// `InboxMessageStore`, behind the app the user opens themselves.
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

    /// Where the measured authorization goes.
    ///
    /// Set once, by the scene, to the controller's `updateNotificationPermission`.
    /// A callback rather than a reference to the controller so this type keeps
    /// knowing nothing about the inbox beyond the two `Inbox…` values it is
    /// handed — and so the package half stays drivable by `swift test`.
    ///
    /// `@Sendable` because `UNUserNotificationCenter` answers on its own queue;
    /// the hop back to the main actor is made below rather than assumed here.
    var onPermission: (@Sendable (InboxNotificationPermission) -> Void)?
    /// Replaced rather than stacked: one problem is one banner, and re-announcing
    /// a DIFFERENT problem should supersede the previous line instead of leaving
    /// two contradictory ones in Notification Centre.
    // nonlocalized: a notification request identifier, never displayed
    private static let attentionIdentifier = "relayium-inbox-attention"

    /// Ask macOS what the authorization is now, and report it.
    ///
    /// Asks WITHOUT prompting. `getNotificationSettings` is a read; the prompt is
    /// still raised only at the moment there is something to announce, which is
    /// the rule `post` records below. A refresh that prompted would put a system
    /// dialog in front of anyone who merely opened the settings pane, which is
    /// the behaviour the deferred prompt was introduced to avoid.
    func refreshPermission() {
        guard let onPermission else { return }
        center.getNotificationSettings { settings in
            onPermission(InboxNotificationPermission(
                authorizationStatus: settings.authorizationStatus))
        }
    }

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
        case .savedMessage:
            // Per delivery too, and for a reason files do not have: two messages
            // are two things somebody wrote, and a shared identifier would have
            // the second REPLACE the first in Notification Centre — the one
            // notice that a message is waiting, silently overwritten.
            //
            // A distinct prefix rather than reusing the one above so the two
            // kinds stay legible where they are read back as text; it carries a
            // kind, never a delivery.
            identifier = "relayium-inbox-message-\(UUID().uuidString)"  // nonlocalized: an id
        case .attention, .failed:
            identifier = Self.attentionIdentifier
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: identifier, content: content,
                                            trigger: nil)
        let onPermission = self.onPermission
        center.getNotificationSettings { [center] settings in
            // ONE mapping, feeding both the decision below and the Settings
            // surface. That is the point of routing this through
            // `InboxNotificationPermission` rather than switching over the raw
            // status twice: the pane's claim that no banner will be shown and the
            // fact that no banner is shown are now the same branch, so they
            // cannot drift apart as either side is edited.
            let permission = InboxNotificationPermission(
                authorizationStatus: settings.authorizationStatus)
            onPermission?(permission)
            switch permission {
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
                    // The answer to the prompt is itself a measurement, and the
                    // most important one there is: a user who says No here is
                    // exactly the user the Settings pane must stop being silent
                    // to, and nothing else would ask again until the pane is next
                    // opened.
                    onPermission?(granted ? .allowed : .denied)
                    guard granted else { return }
                    center.add(request)
                }
            case .allowed:
                center.add(request)
            case .denied:
                // Dropped, deliberately and knowingly — and no longer silently:
                // the report above has already told the Device Inbox pane, which
                // is what turns this into a state a person can see and act on.
                return
            case .unmeasured:
                // Not producible by the mapping above, which is total over
                // `UNAuthorizationStatus`. Handled rather than defaulted so that
                // adding a case to the permission forces a decision here instead
                // of falling into whichever arm happened to be last.
                return
            }
        }
    }
}
