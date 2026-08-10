import Foundation
import RelayiumAppKit
import ServiceManagement

/// The real `SMAppService` behind `LoginItemPreference`.
///
/// It is the whole of this app's contact with the login-item machinery, and it
/// deliberately holds no state: every answer is asked of the system when it is
/// asked of this object, because the user can change this in System Settings
/// while the app is running and nothing tells the app when they do.
///
/// It lives in the app target rather than the package because `SMAppService`
/// acts on `Bundle.main` — in a test runner that is the runner, so a package
/// test touching it would register whoever's Mac ran the suite as a login item.
/// The decisions are all in `LoginItemPreference` and
/// `LoginItemLocationPolicy`, which is why this file has none: it reports what
/// the system says, and it reports where the bundle is. It never chooses what
/// either of those means.
///
/// ## `notFound` is two situations, and it used to be reported as one
///
/// The shipped behaviour mapped `.notFound` to a single dead end: a greyed
/// switch and the sentence "macOS will not manage this copy of Relayium. Move
/// it to your Applications folder." That is one of the two things `notFound`
/// means, and for a user whose app IS in `/Applications` it was simply false —
/// they were told to perform a move they had already performed, with no other
/// action on the screen, and the feature was unreachable.
///
/// The other case is real: an app translocated out of a quarantined download,
/// running from a mounted disk image, or sitting in a build directory genuinely
/// cannot be managed, and no registration attempt will change that. So the two
/// are separated here, at the only place that can see the bundle, and each gets
/// its own remedy on the surfaces above.
struct SystemLoginItem: LoginItemService {

    /// Where the running bundle is. Injected so the classification can be driven
    /// in a test; a shipped instance is built with the defaults and reads
    /// `Bundle.main`.
    private let bundlePath: String
    private let applicationsPaths: [String]

    init(bundlePath: String = Bundle.main.bundleURL.standardizedFileURL.path,
         applicationsPaths: [String] = SystemLoginItem.systemApplicationsPaths()) {
        self.bundlePath = bundlePath
        self.applicationsPaths = applicationsPaths
    }

    /// `/Applications` and `~/Applications`, asked of the system rather than
    /// written down — a hard-coded `/Applications` would be wrong on a Mac whose
    /// user installs into their home folder, which is one of the two supported
    /// places and the one a non-admin user is pushed towards.
    static func systemApplicationsPaths() -> [String] {
        let manager = FileManager.default
        return (manager.urls(for: .applicationDirectory, in: .localDomainMask)
                + manager.urls(for: .applicationDirectory, in: .userDomainMask)
                + manager.urls(for: .applicationDirectory, in: .systemDomainMask))
            .map { $0.standardizedFileURL.path }
    }

    func currentState() -> LoginItemState {
        switch SMAppService.mainApp.status {
        case .enabled:
            return .on
        case .notRegistered:
            return .off
        // Registered, and macOS is holding it until the user approves it. The
        // reason `LoginItemState` is not a `Bool`: reporting this as "on" would
        // have the app claim a residency it does not yet have.
        case .requiresApproval:
            return .needsApproval
        // The system holds no record. Whether that is worth trying to fix
        // depends entirely on where this bundle is — see the file comment.
        case .notFound:
            switch LoginItemLocationPolicy.classify(bundlePath: bundlePath,
                                                    applicationsPaths: applicationsPaths) {
            case .managedApplications: return .unconfirmed
            case .elsewhere:           return .unmanagedLocation
            }
        @unknown default:
            // A status this build has never heard of is not something to guess
            // about, and it is not the location problem either. Reported as the
            // state whose remedy is "look at System Settings yourself", which is
            // true whatever the new case turns out to mean.
            return .unconfirmed
        }
    }

    func enable() throws {
        try SMAppService.mainApp.register()
    }

    func disable() throws {
        try SMAppService.mainApp.unregister()
    }

    /// The system's own way in, rather than the `x-apple.systempreferences:`
    /// URL this used to open.
    ///
    /// That URL was a pane identifier that a macOS release is free to rename,
    /// and when it does the app silently opens System Settings at its root — or
    /// at whatever the identifier now names. This API is the supported request
    /// for the Login Items pane specifically, on the same framework that owns
    /// the registration, and it needs no string to be right.
    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
