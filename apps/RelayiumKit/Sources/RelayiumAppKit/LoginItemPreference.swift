import Foundation

/// Whether this app opens at login, as the system actually reports it.
///
/// **Not a `Bool`.** `SMAppService` has states a boolean cannot express, and
/// each of them is a different thing to say to the user:
///
///  - a registration can succeed and still not run, because macOS files the app
///    under Login Items where the user must approve it;
///  - and the system can report `notFound` — no registration record at all —
///    for a bundle that is perfectly well placed AND for one macOS will never
///    manage. Those two need opposite remedies, and collapsing them was the
///    defect this type now exists in its present shape to fix.
///
/// Modelling any of it as "on" would make the app claim a residency it does not
/// have, and residency is the whole reason this setting exists.
public enum LoginItemState: Equatable, Sendable {
    /// Not registered. The app will not start itself.
    case off
    /// Registered and approved — this Mac is reachable after a restart without
    /// anybody opening the app.
    case on
    /// Registered, but macOS is holding it until the user approves it in
    /// System Settings ▸ General ▸ Login Items.
    case needsApproval
    /// **The system has no registration record, and the app is somewhere macOS
    /// does manage** (`/Applications` or `~/Applications`).
    ///
    /// `SMAppService.mainApp.status` answers `notFound` here, which reads as a
    /// failure and is not one: nothing has been registered yet, or the record
    /// was dropped, and asking for a registration is a thing that can work. The
    /// remedy is therefore an explicit attempt, offered as an action rather than
    /// performed on the app's own initiative.
    case unconfirmed
    /// **The system has no registration record, and the app is running from
    /// somewhere macOS will not manage** — a translocated read-only copy still
    /// attached to its quarantined download, a mounted disk image, a build
    /// directory.
    ///
    /// No amount of asking fixes this, so the remedy is relocation: move the app
    /// into Applications and open it from there. Offering a registration button
    /// would be a control that fails every time it is pressed.
    case unmanagedLocation
}

/// Where the running bundle is, as far as login-item management is concerned.
public enum LoginItemBundleLocation: Equatable, Sendable {
    /// Inside a directory macOS treats as an applications folder.
    case managedApplications
    /// Anywhere else.
    case elsewhere
}

/// The `notFound` split, as a pure function.
///
/// It is here rather than in the `SMAppService` adapter for the reason that
/// adapter states about itself: it holds no decisions, so that the decision is
/// reachable from `swift test` without a bundle, without a registration and
/// without touching whoever's Mac runs the suite.
public enum LoginItemLocationPolicy {

    public static func classify(bundlePath: String,
                                applicationsPaths: [String]) -> LoginItemBundleLocation {
        for directory in applicationsPaths where contains(directory: directory, path: bundlePath) {
            return .managedApplications
        }
        return .elsewhere
    }

    /// Containment by path COMPONENT, never by string prefix.
    ///
    /// `/Applications Backup/Relayium.app` has `/Applications` as a string
    /// prefix and is not in it, and a build directory named that way is exactly
    /// the sort of thing a developer has. The trailing separator is what makes
    /// the comparison mean what it says.
    static func contains(directory: String, path: String) -> Bool {
        guard !directory.isEmpty else { return false }
        let normalized = directory.hasSuffix("/") ? directory : directory + "/"
        return path.hasPrefix(normalized)
    }
}

/// The system side of the login item, behind a protocol so the preference's
/// decisions are reachable from `swift test` without registering this test
/// runner as a real login item on whoever's Mac runs the suite.
public protocol LoginItemService {
    func currentState() -> LoginItemState
    func enable() throws
    func disable() throws
    /// Open System Settings at Login Items.
    ///
    /// Part of the service rather than the view because it is the same platform
    /// API surface — and because the two hosts that offer it must not each grow
    /// their own idea of how to get there.
    func openSystemSettings()
}

/// "Open Relayium at login", and the one place that decides what the app claims
/// about it.
///
/// It re-reads the system rather than remembering what it last wrote, because
/// the user can turn this off in System Settings without the app running. A
/// cached boolean would then show a switch that disagrees with the Mac — and
/// keep disagreeing until the next relaunch.
///
/// ## Nothing here registers on its own
///
/// Not in `init`, not in `refresh`, not on launch, not as a side effect of
/// rendering. Registering an app as a login item is a decision about the user's
/// machine that outlives the app, and an app that quietly makes it for them —
/// even to "repair" a `notFound` — has helped itself to something it was not
/// given. Every registration in this type happens inside a method the user's own
/// press calls, and `attemptRegistration()` exists so that press can be named
/// for what it does.
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

    /// True when an explicit registration attempt SUCCEEDED as a call and the
    /// system still reports no record.
    ///
    /// This is the outcome with no obvious next step, so it gets a state of its
    /// own instead of being folded into "refused": nothing threw, so calling it
    /// a failure would be wrong, and the app must not respond by unregistering
    /// — a registration that macOS has not indexed yet is still possibly live,
    /// and tearing it down would destroy a working setup to tidy up a status
    /// line. What the surface does instead is say what is true and what to try.
    @Published public private(set) var lastRegistrationUnconfirmed = false

    private let service: LoginItemService

    public init(service: LoginItemService) {
        self.service = service
        self.state = service.currentState()
    }

    /// Ask the system again. Called when a surface that shows this appears,
    /// because the state can change while the app is running and nothing
    /// notifies it.
    ///
    /// Reads only. A `refresh` that registered would make merely LOOKING at the
    /// settings window change the machine.
    public func refresh() {
        lastChangeRefused = false
        lastRegistrationUnconfirmed = false
        state = service.currentState()
    }

    /// Whether the on/off control is a control at all.
    ///
    /// False for both `notFound` states, and that is what keeps a dead disabled
    /// switch off the screen: those states render an explanation and their own
    /// remedy instead of a toggle nobody can move.
    public var offersToggle: Bool {
        switch state {
        case .on, .off, .needsApproval:      return true
        case .unconfirmed, .unmanagedLocation: return false
        }
    }

    /// Turn it on or off, then re-read.
    ///
    /// The state written is always the system's answer, never the requested
    /// value: enabling can legitimately produce `needsApproval` rather than
    /// `on`, and a switch that snapped to "on" would be the app asserting
    /// something macOS has not agreed to yet.
    public func set(_ wanted: Bool) {
        guard offersToggle else { return }
        lastRegistrationUnconfirmed = false
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

    /// The remedy for `unconfirmed`: ask the system to register this app, once,
    /// because the user pressed a button that says so.
    ///
    /// Three outcomes, all of them reported rather than smoothed over. The call
    /// throws — `lastChangeRefused`, with the same wording every refusal gets.
    /// The call succeeds and the system now says `on` or `needsApproval` — the
    /// ordinary result, and the state carries it. The call succeeds and the
    /// system still says nothing is registered — `lastRegistrationUnconfirmed`,
    /// which is neither of the first two and must not be described as either.
    ///
    /// It deliberately does NOT unregister on that third outcome. See
    /// `lastRegistrationUnconfirmed`.
    public func attemptRegistration() {
        guard state == .unconfirmed else { return }
        lastChangeRefused = false
        lastRegistrationUnconfirmed = false
        do {
            try service.enable()
        } catch {
            lastChangeRefused = true
            state = service.currentState()
            return
        }
        state = service.currentState()
        if state == .unconfirmed { lastRegistrationUnconfirmed = true }
    }

    /// Hand the user to the place they can see and change this themselves.
    public func openSystemSettings() { service.openSystemSettings() }
}
