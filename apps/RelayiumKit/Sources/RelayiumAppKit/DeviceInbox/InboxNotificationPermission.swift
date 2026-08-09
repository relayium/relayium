import Foundation
#if canImport(UserNotifications)
@preconcurrency import UserNotifications
#endif

/// Whether macOS will let the Device Inbox put a banner on screen.
///
/// ## Why this is not part of `InboxRuntimeState`
///
/// `InboxRuntimeState.attention` means the inbox cannot do its job: a revoked
/// folder grant, a delivery central is holding. Notification authorization is
/// none of those. A denied Mac still enrols, still claims, still decrypts and
/// still commits — the ONLY thing it loses is the banner that announces it. So
/// this is a separate axis, and merging it into the runtime state would make the
/// status line say "needs attention" about an inbox that is working perfectly,
/// which is the same class of untruth as `ready` over a broken grant, pointed the
/// other way.
///
/// It is also not account-scoped. The folder grant, the policy and the key
/// history all belong to an account; this belongs to the app and the Mac, and
/// signing out does not change it. `InboxController.reset()` therefore leaves it
/// alone deliberately.
///
/// ## Why there is no `other` case
///
/// The same reason the runtime state has none. Every arm below is a decision the
/// notifier ALSO acts on — ask, post, or drop — so a fall-through arm would be a
/// permission whose UI and whose behaviour could disagree. The mapping from
/// `UNAuthorizationStatus` is total by construction: an unrecognised status
/// becomes `denied`, which is exactly what the app then does with it.
public enum InboxNotificationPermission: String, Equatable, Sendable, CaseIterable {
    /// Nothing has asked macOS yet. The starting value, and the reason this is
    /// not simply a `Bool`: "we do not know" must not render as "banners work",
    /// and it must not render as a problem either.
    case unmeasured
    /// Measured, and macOS has not yet been asked. Nothing is wrong: the prompt
    /// is deliberately deferred to the moment there is something to announce.
    case notDetermined
    /// Banners will be delivered.
    case allowed
    /// Banners will NOT be delivered. The user said no at some point, a profile
    /// says no, or this build cannot name the status it got back — and in every
    /// one of those the observable product behaviour is identical, which is what
    /// makes them one case rather than three.
    case denied

    /// Whether a person needs to be told about this, and offered something to do.
    ///
    /// Only `denied`. `unmeasured` has no claim to make yet, `notDetermined`
    /// resolves itself the first time there is a delivery to announce, and
    /// `allowed` is not a problem.
    public var needsAttention: Bool { self == .denied }

    #if canImport(UserNotifications)
    /// The one place `UNAuthorizationStatus` is interpreted.
    ///
    /// `provisional` counts as allowed because a provisional banner IS delivered
    /// — quietly, to Notification Centre — so telling the user their notifications
    /// are off would be false.
    ///
    /// The `default` arm is `denied` rather than `allowed`, and that is the
    /// truthful direction rather than merely the cautious one: `InboxNotifier`
    /// switches over this same value and posts nothing for `denied`, so a status
    /// this build cannot name produces a Mac that shows no banner AND a surface
    /// that says no banner will be shown. The alternative — assume it is fine —
    /// is precisely the silent discard this state exists to end.
    public init(authorizationStatus status: UNAuthorizationStatus) {
        switch status {
        case .notDetermined:            self = .notDetermined
        case .authorized, .provisional: self = .allowed
        default:                        self = .denied
        }
    }
    #endif
}

/// Where the denied-banner recovery has to land: THIS app's row in the System
/// Settings Notifications pane.
///
/// ## Why the pane identifier alone is not the route
///
/// `x-apple.systempreferences:com.apple.Notifications-Settings.extension` opens
/// the Notifications pane and stops there — whichever app row that pane was last
/// left on stays selected. Observed on macOS 26.6: with System Settings sitting
/// on Google Chrome's notification row, the bare URL re-opened it still on Google
/// Chrome. The button says it opens Relayium's notification settings, so the bare
/// pane is a control whose name and whose effect disagree, which is the same
/// class of untruth as the silent discard this whole surface exists to end.
///
/// The pane takes `?id=<bundle identifier>` and selects that app's row; verified
/// on 26.6 for Relayium, and for Mail, Messages and Chrome with their own ids.
///
/// ## Why the identifier is read from the running bundle
///
/// A constant here would be a second, unchecked copy of the app's identity, and
/// the failure it allows is silent in the worst way: a build whose identifier
/// changed would keep opening the PREVIOUS app's row while claiming to open its
/// own. Asking the running bundle what it is cannot drift from what it is.
public enum InboxNotificationSettingsRoute {

    /// The System Settings extension that draws the Notifications pane.
    ///
    /// Private, with `url(forBundleIdentifier:)` as the whole surface: a pane
    /// identifier a caller could read is a pane identifier a caller could open
    /// on its own, which is precisely the bare-pane route being removed here.
    // nonlocalized: a System Settings pane identifier, not user copy
    private static let pane = "com.apple.Notifications-Settings.extension"

    // nonlocalized: the System Settings URL scheme, not user copy
    private static let scheme = "x-apple.systempreferences"

    /// The URL that selects `bundleIdentifier`'s row, or `nil` when this build
    /// cannot name itself.
    ///
    /// `nil` rather than a bare-pane fallback, deliberately. The caller turns
    /// `nil` into the published "System Settings could not be opened" message,
    /// which sends the person to Notifications ▸ Relayium themselves and leaves
    /// them on the right row. Opening the pane on some other app's row while
    /// reporting success is the defect being corrected, and a fallback would
    /// reintroduce it for exactly the case where we know least.
    ///
    /// The identifier is CHECKED rather than escaped. Escaping would make any
    /// string routable; refusing everything that is not bundle-identifier shaped
    /// means no path, file name, task id or second query parameter can reach
    /// `NSWorkspace` through here. The seam takes no argument today, and this is
    /// what keeps that closed if a later call site ever passes one.
    public static func url(forBundleIdentifier bundleIdentifier: String?) -> URL? {
        guard let identifier = bundleIdentifier,
              isBundleIdentifier(identifier) else { return nil }
        return URL(string: "\(scheme):\(pane)?id=\(identifier)")
    }

    /// What macOS allows in a `CFBundleIdentifier`: ASCII letters, digits,
    /// hyphens and periods, in non-empty period-separated components.
    ///
    /// Everything that makes a URL mean something other than one app row — a
    /// slash, a space, `?`, `&`, `#`, `%`, a control character, anything
    /// non-ASCII — is outside that set, so the check is also the injection
    /// guard.
    private static func isBundleIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 255 else { return false }
        let components = value.split(separator: ".", omittingEmptySubsequences: false)
        return components.allSatisfy { component in
            !component.isEmpty && component.allSatisfy { character in
                character.isASCII
                    && (character.isLetter || character.isNumber || character == "-")
            }
        }
    }
}
