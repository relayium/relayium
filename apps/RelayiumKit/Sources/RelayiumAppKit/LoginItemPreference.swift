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

/// Which press asked to register, held until the user confirms it.
///
/// Two different presses can ask, and after confirmation they have different
/// outcomes to report — the toggle's enable is an ordinary on/off, and the
/// `unconfirmed` remedy has a third outcome (`lastRegistrationUnconfirmed`) that
/// the toggle does not. Remembering WHICH asked is what lets one confirmation
/// resume the right one, rather than collapsing them into a single "enable" that
/// then has to guess.
public enum LoginItemConsentRequest: Equatable, Sendable {
    /// The on/off switch was moved to on.
    case turnOn
    /// The `unconfirmed` state's remedy button was pressed.
    case registration
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
/// given.
///
/// ## And nothing registers on a single press either
///
/// **App Review rejected this app under Guideline 2.4.5(iii)** for setting
/// itself to auto-launch "without user consent", having pressed the button this
/// type used to call `attemptRegistration()` — labelled *Try registration*, in
/// the General settings pane, which a reviewer read as an ACCOUNT registration.
/// It registered a login item immediately, and so did moving the switch. Both
/// were a press away from changing the user's machine with nothing on screen
/// naming what would change.
///
/// So a press no longer registers. It records a `consentRequest`, the surface
/// asks in words what confirming does, and `confirmConsent()` is the **only**
/// method in this type that reaches the service's registration — one call site,
/// so a future edit cannot add a second path to it without moving that call.
/// `MacSurfaceGuardTests` COUNTS that call site, which is why this sentence
/// describes it rather than spelling it out.
///
/// `cancelConsent()`, dismissal and `refresh()` all leave the system untouched.
///
/// Turning it OFF stays direct. Consent is required for taking residency on
/// somebody's Mac, not for giving it up, and a confirmation in front of the
/// off switch would make the setting harder to leave than to enter.
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

    /// The registration a press has ASKED for and the user has not yet agreed
    /// to. Non-nil is what puts the confirmation on screen.
    ///
    /// Nothing about it has touched the system: while this is set, the app is
    /// exactly as registered as it was before the press.
    @Published public private(set) var consentRequest: LoginItemConsentRequest?

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
        // A pending request is dropped rather than carried across a re-read: it
        // was raised against the state this call is replacing. Dropping it can
        // only ever leave the app UNregistered, which is the safe direction for
        // the one thing this type must never do by itself.
        consentRequest = nil
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

    /// Move the switch.
    ///
    /// **Only one of the two directions acts.** Off unregisters immediately and
    /// re-reads, as it always did. On does NOT register: it raises the consent
    /// request, and the switch stays reading whatever macOS still says — which
    /// is off — until the user confirms. That spring-back is the honest
    /// rendering, because at that moment nothing has been registered.
    public func set(_ wanted: Bool) {
        guard offersToggle else { return }
        lastRegistrationUnconfirmed = false
        lastChangeRefused = false
        guard !wanted else {
            consentRequest = .turnOn
            return
        }
        consentRequest = nil
        do {
            try service.disable()
        } catch {
            lastChangeRefused = true
        }
        // Re-read on BOTH paths. A refused disable can still have changed the
        // registration, and reporting the pre-attempt state after a partial one
        // is how a settings screen starts lying.
        state = service.currentState()
    }

    /// The remedy for `unconfirmed`, as a REQUEST rather than the act.
    ///
    /// This is the button App Review pressed. It kept its name because the name
    /// is what the surface's guard asserts on, and because from the user's side
    /// it is still the same offer — what changed is that pressing it now asks
    /// before it registers anything.
    public func attemptRegistration() {
        guard state == .unconfirmed else { return }
        lastChangeRefused = false
        lastRegistrationUnconfirmed = false
        consentRequest = .registration
    }

    /// The user said yes, and this is the one method in this type that registers.
    ///
    /// The request's own guard is re-checked HERE rather than trusted from when
    /// it was raised: a `refresh` between the press and the confirmation can
    /// have moved the state, and confirming a registration for a situation that
    /// no longer exists is the same unasked-for change by a slower route.
    ///
    /// The request is cleared BEFORE the work, so a second confirmation — a
    /// double-click, a Touch Bar mirror of the same button — finds nothing to do
    /// rather than registering twice.
    ///
    /// Outcomes are reported exactly as they were before consent existed. A
    /// throw is `lastChangeRefused`. A success landing on `on` or `needsApproval`
    /// is the ordinary result the state carries. A registration success that
    /// leaves the system still reporting nothing is `lastRegistrationUnconfirmed`
    /// — neither of the first two, and it deliberately does NOT unregister to
    /// tidy itself up. See `lastRegistrationUnconfirmed`.
    public func confirmConsent() {
        guard let request = consentRequest else { return }
        consentRequest = nil
        lastChangeRefused = false
        lastRegistrationUnconfirmed = false

        switch request {
        case .turnOn:
            guard offersToggle else { return }
        case .registration:
            guard state == .unconfirmed else { return }
        }

        do {
            try service.enable()
        } catch {
            lastChangeRefused = true
            state = service.currentState()
            return
        }
        state = service.currentState()
        if request == .registration, state == .unconfirmed {
            lastRegistrationUnconfirmed = true
        }
    }

    /// The user said no, or dismissed the confirmation. Nothing was registered
    /// to undo, so this only puts the request down.
    public func cancelConsent() {
        consentRequest = nil
    }

    /// Hand the user to the place they can see and change this themselves.
    public func openSystemSettings() { service.openSystemSettings() }
}
