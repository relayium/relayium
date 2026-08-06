import Foundation

/// Whether this app opens at login, as the system actually reports it.
///
/// **Not a `Bool`.** `SMAppService` has a state a boolean cannot express: a
/// registration can succeed and still not run, because macOS files the app under
/// Login Items where the user must approve it. Modelling that as "on" would make
/// the app claim a residency it does not have — and residency is the whole
/// reason this setting exists, so the lie would be exactly where it hurts. It is
/// also not an error: nothing failed, and the remedy is one the user performs
/// elsewhere.
public enum LoginItemState: Equatable, Sendable {
    /// Not registered. The app will not start itself.
    case off
    /// Registered and approved — this Mac is reachable after a restart without
    /// anybody opening the app.
    case on
    /// Registered, but macOS is holding it until the user approves it in
    /// System Settings ▸ General ▸ Login Items.
    case needsApproval
    /// The service cannot answer — an unregistered bundle, or a copy running
    /// from a location macOS will not manage. Offering a switch here would be a
    /// control that silently does nothing.
    case unavailable
}

/// The system side of the login item, behind a protocol so the preference's
/// decisions are reachable from `swift test` without registering this test
/// runner as a real login item on whoever's Mac runs the suite.
public protocol LoginItemService {
    func currentState() -> LoginItemState
    func enable() throws
    func disable() throws
}

/// "Open Relayium at login", and the one place that decides what the app claims
/// about it.
///
/// It re-reads the system rather than remembering what it last wrote, because
/// the user can turn this off in System Settings without the app running. A
/// cached boolean would then show a switch that disagrees with the Mac — and
/// keep disagreeing until the next relaunch.
@MainActor
public final class LoginItemPreference: ObservableObject {
    @Published public private(set) var state: LoginItemState

    /// True when the LAST change this object attempted was refused by the
    /// system. Cleared by any subsequent attempt or refresh, so it describes the
    /// current situation rather than accumulating a history.
    ///
    /// A flag rather than the thrown error's text: `SMAppService` reports an
    /// `NSError` from a private domain whose message is not written for a user,
    /// and the useful thing to say is not what failed but where to go — which is
    /// copy, and belongs in the view's catalog rather than in this type.
    @Published public private(set) var lastChangeRefused = false

    private let service: LoginItemService

    public init(service: LoginItemService) {
        self.service = service
        self.state = service.currentState()
    }

    /// Ask the system again. Called when the settings surface appears, because
    /// the state can change while the app is running and nothing notifies it.
    public func refresh() {
        lastChangeRefused = false
        state = service.currentState()
    }

    /// Turn it on or off, then re-read.
    ///
    /// The state written is always the system's answer, never the requested
    /// value: enabling can legitimately produce `needsApproval` rather than
    /// `on`, and a switch that snapped to "on" would be the app asserting
    /// something macOS has not agreed to yet.
    public func set(_ wanted: Bool) {
        guard state != .unavailable else { return }
        lastChangeRefused = false
        do {
            if wanted { try service.enable() } else { try service.disable() }
        } catch {
            lastChangeRefused = true
        }
        // Re-read on BOTH paths. A refused enable can still have changed the
        // registration, and reporting the pre-attempt state after a partial one
        // is how a settings screen starts lying.
        state = service.currentState()
    }
}
