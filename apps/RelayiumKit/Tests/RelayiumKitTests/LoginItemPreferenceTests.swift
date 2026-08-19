import XCTest
@testable import RelayiumAppKit

@MainActor
final class LoginItemPreferenceTests: XCTestCase {

    /// A stand-in for `SMAppService`, so these run without registering the test
    /// runner as a login item on whoever's Mac executes the suite.
    private final class FakeService: LoginItemService {
        var state: LoginItemState
        var enableError: Error?
        var disableError: Error?
        /// What the system reports AFTER a successful enable. Separate from
        /// `state` so a test can model macOS answering `needsApproval` to a
        /// registration that itself succeeded — or, the case this round is
        /// about, answering nothing at all.
        var stateAfterEnable: LoginItemState = .on
        private(set) var enables = 0
        private(set) var disables = 0
        private(set) var settingsOpened = 0

        init(state: LoginItemState) { self.state = state }

        func currentState() -> LoginItemState { state }

        func enable() throws {
            enables += 1
            if let enableError { throw enableError }
            state = stateAfterEnable
        }

        func disable() throws {
            disables += 1
            if let disableError { throw disableError }
            state = .off
        }

        func openSystemSettings() { settingsOpened += 1 }
    }

    private struct Refused: Error {}

    private let everyState: [LoginItemState] =
        [.off, .on, .needsApproval, .unconfirmed, .unmanagedLocation]

    func testItReportsWhateverTheSystemSaysAtConstruction() {
        for state in everyState {
            XCTAssertEqual(LoginItemPreference(service: FakeService(state: state)).state, state)
        }
    }

    /// **Nothing registers on its own.** Not on construction, and not on the
    /// refresh every surface performs when it appears — otherwise merely LOOKING
    /// at the settings window would change the user's machine.
    func testConstructionAndRefreshOnlyEverRead() {
        for state in everyState {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            preference.refresh()
            preference.refresh()
            XCTAssertEqual(service.enables, 0, "\(state) registered without being asked")
            XCTAssertEqual(service.disables, 0, "\(state) unregistered without being asked")
            XCTAssertNil(preference.consentRequest,
                         "\(state) put a confirmation on screen nobody asked for")
        }
    }

    /// **Moving the switch asks. Confirming registers.** The rejection this
    /// gate exists for is that the first of these two used to be the whole of it.
    func testTurningItOnAsksFirstAndOnlyRegistersOnConfirmation() {
        let service = FakeService(state: .off)
        let preference = LoginItemPreference(service: service)

        preference.set(true)
        XCTAssertEqual(service.enables, 0, "the switch registered on its own")
        XCTAssertEqual(preference.state, .off, "the switch claimed a residency it lacks")
        XCTAssertEqual(preference.consentRequest, .turnOn)

        preference.confirmConsent()
        XCTAssertEqual(service.enables, 1)
        XCTAssertEqual(preference.state, .on)
        XCTAssertNil(preference.consentRequest)
        XCTAssertFalse(preference.lastChangeRefused)
    }

    func testTurningItOffUnregisters() {
        let service = FakeService(state: .on)
        let preference = LoginItemPreference(service: service)
        preference.set(false)
        XCTAssertEqual(service.disables, 1)
        XCTAssertEqual(preference.state, .off)
    }

    /// The case a `Bool` cannot hold. Registration succeeded, macOS is holding
    /// it for approval, and the app must not claim it opens at login.
    func testASuccessfulEnableThatNeedsApprovalIsNotReportedAsOn() {
        let service = FakeService(state: .off)
        service.stateAfterEnable = .needsApproval
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.confirmConsent()
        XCTAssertEqual(preference.state, .needsApproval)
        XCTAssertFalse(preference.lastChangeRefused,
                       "needing approval is not a failure; nothing was refused")
    }

    func testARefusedEnableIsRecordedAndDoesNotClaimSuccess() {
        let service = FakeService(state: .off)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.confirmConsent()
        XCTAssertTrue(preference.lastChangeRefused)
        XCTAssertEqual(preference.state, .off, "a refused enable must not show as on")
    }

    func testARefusedDisableIsRecorded() {
        let service = FakeService(state: .on)
        service.disableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.set(false)
        XCTAssertTrue(preference.lastChangeRefused)
        XCTAssertEqual(preference.state, .on)
    }

    /// The state is re-read on the failure path too: a refused attempt can still
    /// have moved the registration, and reporting the pre-attempt value is how a
    /// settings screen starts disagreeing with the Mac.
    func testTheStateIsReReadEvenWhenTheChangeWasRefused() {
        let service = FakeService(state: .off)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        service.state = .needsApproval
        preference.set(true)
        preference.confirmConsent()
        XCTAssertEqual(preference.state, .needsApproval)
    }

    func testARetryClearsTheEarlierRefusal() {
        let service = FakeService(state: .off)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.confirmConsent()
        XCTAssertTrue(preference.lastChangeRefused)
        service.enableError = nil
        preference.set(true)
        preference.confirmConsent()
        XCTAssertFalse(preference.lastChangeRefused)
        XCTAssertEqual(preference.state, .on)
    }

    /// The user can turn this off in System Settings while the app runs, and
    /// nothing tells the app. Remembering what it last wrote would leave the
    /// switch disagreeing with the Mac until the next launch.
    func testRefreshPicksUpAChangeMadeOutsideTheApp() {
        let service = FakeService(state: .on)
        let preference = LoginItemPreference(service: service)
        service.state = .off
        XCTAssertEqual(preference.state, .on, "nothing observes the system on its own")
        preference.refresh()
        XCTAssertEqual(preference.state, .off)
    }

    func testRefreshClearsAStaleRefusal() {
        let service = FakeService(state: .off)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.confirmConsent()
        service.enableError = nil
        preference.refresh()
        XCTAssertFalse(preference.lastChangeRefused)
    }

    // MARK: - the two `notFound` situations

    /// Only the three states with a real switch offer one. The other two render
    /// an explanation and their own remedy instead — a greyed toggle showing
    /// "off" reads as a setting somebody turned off, which is worse than dead.
    func testOnlyTheStatesWithAWorkingSwitchOfferOne() {
        for state in [LoginItemState.on, .off, .needsApproval] {
            XCTAssertTrue(LoginItemPreference(service: FakeService(state: state)).offersToggle,
                          "\(state) has a working switch")
        }
        for state in [LoginItemState.unconfirmed, .unmanagedLocation] {
            XCTAssertFalse(LoginItemPreference(service: FakeService(state: state)).offersToggle,
                           "\(state) must not render a switch that cannot move")
        }
    }

    /// A control that cannot work must not be operated. Attempting it would
    /// produce a refusal the user can do nothing about — and from
    /// `unmanagedLocation` it would fail every single time.
    func testNeitherNotFoundStateCanBeToggled() {
        for state in [LoginItemState.unconfirmed, .unmanagedLocation] {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            preference.set(true)
            preference.set(false)
            XCTAssertEqual(service.enables, 0)
            XCTAssertEqual(service.disables, 0)
            XCTAssertNil(preference.consentRequest,
                         "\(state) asked to confirm a change it cannot make")
            XCTAssertEqual(preference.state, state)
            XCTAssertFalse(preference.lastChangeRefused)
        }
    }

    /// The remedy for a bundle macOS holds no record of: ask once, because the
    /// user pressed a button that says so.
    func testAnExplicitRegistrationAttemptRegistersAndRereads() {
        let service = FakeService(state: .unconfirmed)
        service.stateAfterEnable = .on
        let preference = LoginItemPreference(service: service)
        preference.attemptRegistration()
        XCTAssertEqual(service.enables, 0, "the remedy button registered on a single press")
        XCTAssertEqual(preference.consentRequest, .registration)
        preference.confirmConsent()
        XCTAssertEqual(service.enables, 1)
        XCTAssertEqual(preference.state, .on)
        XCTAssertFalse(preference.lastRegistrationUnconfirmed)
        XCTAssertFalse(preference.lastChangeRefused)
    }

    /// A registration that lands on "held for approval" is an ordinary success,
    /// and must not be reported as the unconfirmed outcome.
    func testAnAttemptThatNeedsApprovalIsNotTheUnconfirmedOutcome() {
        let service = FakeService(state: .unconfirmed)
        service.stateAfterEnable = .needsApproval
        let preference = LoginItemPreference(service: service)
        preference.attemptRegistration()
        preference.confirmConsent()
        XCTAssertEqual(preference.state, .needsApproval)
        XCTAssertFalse(preference.lastRegistrationUnconfirmed)
    }

    /// **The outcome with no obvious next step.** The call succeeded and the
    /// system still reports nothing.
    ///
    /// Two claims here, and the second is the load-bearing one: it is reported
    /// as its own state rather than as a refusal, and the app does NOT respond
    /// by unregistering. The registration may exist and merely be unindexed, and
    /// tearing it down would destroy a working setup to tidy up a status line.
    func testARegistrationThatStaysUnconfirmedIsReportedAndNothingIsUndone() {
        let service = FakeService(state: .unconfirmed)
        service.stateAfterEnable = .unconfirmed
        let preference = LoginItemPreference(service: service)
        preference.attemptRegistration()
        preference.confirmConsent()
        XCTAssertEqual(service.enables, 1)
        XCTAssertEqual(preference.state, .unconfirmed)
        XCTAssertTrue(preference.lastRegistrationUnconfirmed)
        XCTAssertFalse(preference.lastChangeRefused,
                       "nothing threw, so this is not the refusal sentence")
        XCTAssertEqual(service.disables, 0,
                       "a possibly live registration must never be silently removed")
    }

    func testARefusedRegistrationAttemptIsARefusalRatherThanAnUnconfirmedOne() {
        let service = FakeService(state: .unconfirmed)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.attemptRegistration()
        preference.confirmConsent()
        XCTAssertTrue(preference.lastChangeRefused)
        XCTAssertFalse(preference.lastRegistrationUnconfirmed)
        XCTAssertEqual(service.disables, 0)
    }

    /// From every other state it is inert. `unmanagedLocation` above all: a
    /// registration from a translocated bundle fails every time, so the surface
    /// does not offer the button and this refuses it even if something did.
    func testRegistrationIsOnlyEverAttemptedFromTheStateThatCanBeFixedByIt() {
        for state in [LoginItemState.on, .off, .needsApproval, .unmanagedLocation] {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            preference.attemptRegistration()
            preference.confirmConsent()
            XCTAssertEqual(service.enables, 0, "\(state) attempted a registration")
            XCTAssertEqual(preference.state, state)
            XCTAssertNil(preference.consentRequest)
        }
    }

    func testARefreshClearsAStaleUnconfirmedRegistration() {
        let service = FakeService(state: .unconfirmed)
        service.stateAfterEnable = .unconfirmed
        let preference = LoginItemPreference(service: service)
        preference.attemptRegistration()
        preference.confirmConsent()
        XCTAssertTrue(preference.lastRegistrationUnconfirmed)
        service.state = .on
        preference.refresh()
        XCTAssertFalse(preference.lastRegistrationUnconfirmed)
        XCTAssertEqual(preference.state, .on)
    }

    func testOpeningSystemSettingsGoesThroughTheService() {
        let service = FakeService(state: .needsApproval)
        let preference = LoginItemPreference(service: service)
        preference.openSystemSettings()
        XCTAssertEqual(service.settingsOpened, 1)
    }

    // MARK: - consent, and the rejection it answers

    /// **Guideline 2.4.5(iii): nothing but a confirmed press may register.**
    ///
    /// Exhaustive rather than illustrative. Every public entry point this type
    /// has EXCEPT `confirmConsent()` is called, from every state, in the order a
    /// surface can reach them — which is the whole set of things a launch, an
    /// account flow, a settings window appearing, or a toggle being moved can
    /// cause. None of them may reach `enable()`.
    ///
    /// It is written as "everything except one" on purpose: a future edit that
    /// adds a second registration path fails here without anyone remembering to
    /// extend a list of named cases.
    func testConfirmingIsTheOnlyThingInThisTypeThatCanRegister() {
        for state in everyState {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            preference.refresh()
            preference.set(true)
            preference.set(false)
            preference.attemptRegistration()
            preference.cancelConsent()
            preference.openSystemSettings()
            preference.refresh()
            XCTAssertEqual(service.enables, 0,
                           "\(state) registered without a confirmed press")
        }
    }

    /// Launch and every surface appearance, which is where App Review's
    /// "automatically" would have to live if it were true of this build.
    ///
    /// Constructing the preference is what the app does at launch; `refresh()`
    /// is the whole of what ⌘, and the Device Inbox destination do when they
    /// appear, and it is the only thing an account screen could reach. Repeated
    /// because a surface can appear many times in one run.
    func testLaunchAndEverySurfaceAppearanceRegisterNothing() {
        for state in everyState {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            for _ in 0..<5 { preference.refresh() }
            XCTAssertEqual(service.enables, 0, "\(state) registered on appearance")
            XCTAssertEqual(service.disables, 0, "\(state) unregistered on appearance")
            XCTAssertNil(preference.consentRequest)
            XCTAssertEqual(preference.state, state)
        }
    }

    /// Cancelling either request leaves the machine exactly as it was.
    func testCancellingAConfirmationRegistersNothing() {
        // The switch's request.
        let toggle = FakeService(state: .off)
        let fromToggle = LoginItemPreference(service: toggle)
        fromToggle.set(true)
        XCTAssertEqual(fromToggle.consentRequest, .turnOn)
        fromToggle.cancelConsent()
        XCTAssertNil(fromToggle.consentRequest)
        XCTAssertEqual(toggle.enables, 0, "the switch registered after a cancel")
        XCTAssertEqual(fromToggle.state, .off, "the switch moved after a cancel")
        // A cancel is not a deferred yes: confirming after it finds nothing.
        fromToggle.confirmConsent()
        XCTAssertEqual(toggle.enables, 0, "a cancelled request was still honoured")

        // The remedy button's request — the one App Review pressed.
        let remedy = FakeService(state: .unconfirmed)
        let fromRemedy = LoginItemPreference(service: remedy)
        fromRemedy.attemptRegistration()
        XCTAssertEqual(fromRemedy.consentRequest, .registration)
        fromRemedy.cancelConsent()
        XCTAssertNil(fromRemedy.consentRequest)
        XCTAssertEqual(remedy.enables, 0, "the remedy registered after a cancel")
        XCTAssertEqual(fromRemedy.state, .unconfirmed)
        fromRemedy.confirmConsent()
        XCTAssertEqual(remedy.enables, 0, "a cancelled request was still honoured")
    }

    /// Dismissal — Escape, clicking away — reaches `cancelConsent()` through the
    /// presentation binding, and a `refresh` behind the dialog drops it too.
    /// Both leave it unregistered, which is the only direction either may take.
    func testDismissalAndARefreshBehindTheDialogBothLeaveItUnregistered() {
        let service = FakeService(state: .off)
        let preference = LoginItemPreference(service: service)

        preference.set(true)
        preference.refresh()
        XCTAssertNil(preference.consentRequest, "a re-read carried a stale request")
        preference.confirmConsent()
        XCTAssertEqual(service.enables, 0, "a request the refresh dropped still registered")
        XCTAssertEqual(preference.state, .off)
    }

    /// One confirmation, one registration. A double-click, or the Touch Bar
    /// mirror of the same button, must not ask the system twice.
    func testConfirmingTwiceRegistersOnce() {
        let service = FakeService(state: .off)
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.confirmConsent()
        preference.confirmConsent()
        preference.confirmConsent()
        XCTAssertEqual(service.enables, 1)
        XCTAssertEqual(preference.state, .on)
    }

    func testConfirmingWithNothingPendingDoesNothing() {
        for state in everyState {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            preference.confirmConsent()
            XCTAssertEqual(service.enables, 0, "\(state) registered with nothing pending")
            XCTAssertEqual(preference.state, state)
        }
    }

    /// **Turning it off keeps its single press**, and raises no confirmation.
    /// Consent is for taking residency, not for giving it up; a dialog in front
    /// of the off switch would make this harder to leave than to enter.
    func testTurningItOffIsDirectAndAsksNothing() {
        for state in [LoginItemState.on, .needsApproval] {
            let service = FakeService(state: state)
            let preference = LoginItemPreference(service: service)
            preference.set(false)
            XCTAssertNil(preference.consentRequest, "\(state) asked before turning off")
            XCTAssertEqual(service.disables, 1, "\(state) did not unregister")
            XCTAssertEqual(service.enables, 0)
            XCTAssertEqual(preference.state, .off)
        }
    }

    /// Asking twice replaces the pending request rather than queueing a second
    /// registration behind it.
    func testRaisingTheRequestAgainStillRegistersOnlyOnce() {
        let service = FakeService(state: .off)
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.set(true)
        XCTAssertEqual(preference.consentRequest, .turnOn)
        preference.confirmConsent()
        XCTAssertEqual(service.enables, 1)
    }

    // MARK: - where the bundle is

    private let applications = ["/Applications", "/Users/someone/Applications"]

    func testABundleInEitherApplicationsFolderIsManaged() {
        for path in ["/Applications/Relayium.app",
                     "/Applications/Utilities/Relayium.app",
                     "/Users/someone/Applications/Relayium.app"] {
            XCTAssertEqual(LoginItemLocationPolicy.classify(bundlePath: path,
                                                            applicationsPaths: applications),
                           .managedApplications, path)
        }
    }

    /// The situations where no registration attempt will ever work: a
    /// translocated copy still attached to its quarantined download, a mounted
    /// disk image, a build directory, the Downloads folder.
    func testATranslocatedOrOtherwiseUnmanagedBundleIsRecognised() {
        for path in [
            "/private/var/folders/ab/xyz/T/AppTranslocation/1234-5678/d/Relayium.app",
            "/Volumes/Relayium/Relayium.app",
            "/Users/someone/Downloads/Relayium.app",
            "/Users/someone/Library/Developer/Xcode/DerivedData/x/Build/Products/Debug/Relayium.app",
        ] {
            XCTAssertEqual(LoginItemLocationPolicy.classify(bundlePath: path,
                                                            applicationsPaths: applications),
                           .elsewhere, path)
        }
    }

    /// Containment by path component, not by string prefix. A build directory
    /// called `/Applications Backup` is exactly the sort of thing that exists,
    /// and treating it as managed would offer a registration that cannot work.
    func testAPathThatMerelyStartsWithTheSameLettersIsNotContained() {
        XCTAssertEqual(
            LoginItemLocationPolicy.classify(bundlePath: "/Applications Backup/Relayium.app",
                                             applicationsPaths: applications),
            .elsewhere)
        XCTAssertFalse(LoginItemLocationPolicy.contains(directory: "/Applications",
                                                        path: "/ApplicationsOld/Relayium.app"))
        XCTAssertTrue(LoginItemLocationPolicy.contains(directory: "/Applications/",
                                                       path: "/Applications/Relayium.app"),
                      "a directory given with a trailing separator behaves the same")
    }

    /// A system that reports no applications directories at all classifies
    /// everything as unmanaged rather than as managed — the refusal direction,
    /// which offers relocation advice instead of a button that cannot work.
    func testAnEmptyApplicationsListRefusesRatherThanAdmits() {
        XCTAssertEqual(LoginItemLocationPolicy.classify(bundlePath: "/Applications/Relayium.app",
                                                        applicationsPaths: []),
                       .elsewhere)
        XCTAssertFalse(LoginItemLocationPolicy.contains(directory: "", path: "/anything"))
    }
}
