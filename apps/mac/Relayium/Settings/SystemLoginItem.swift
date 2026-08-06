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
/// The decisions are all in `LoginItemPreference`, which is why this file has
/// none.
struct SystemLoginItem: LoginItemService {
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
        // The bundle is somewhere macOS will not manage — most often a copy run
        // straight out of a build directory or an unsigned tree. Offering a
        // switch would be a control that silently does nothing.
        case .notFound:
            return .unavailable
        @unknown default:
            return .unavailable
        }
    }

    func enable() throws {
        try SMAppService.mainApp.register()
    }

    func disable() throws {
        try SMAppService.mainApp.unregister()
    }
}
