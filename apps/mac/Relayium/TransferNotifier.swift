import AppKit
import RelayiumAppKit
@preconcurrency import UserNotifications

/// Completion notifications deliberately contain no filenames, links, pairing
/// codes, or keys: notification previews are visible on a locked screen.
@MainActor
final class TransferNotifier {
    private let center = UNUserNotificationCenter.current()

    func prepare() {
        center.getNotificationSettings { [center] settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    func completed(_ body: String, title: String? = nil) {
        let title = title ?? L10n.t(.notifyTitleComplete)
        guard !NSApp.isActive else { return }
        center.getNotificationSettings { [center] settings in
            guard settings.authorizationStatus == .authorized ||
                    settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(
                identifier: "relayium-transfer-\(UUID().uuidString)",
                content: content,
                trigger: nil
            )
            center.add(request)
        }
    }
}
