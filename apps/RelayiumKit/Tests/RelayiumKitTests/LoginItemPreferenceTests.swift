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
        /// registration that itself succeeded.
        var stateAfterEnable: LoginItemState = .on
        private(set) var enables = 0
        private(set) var disables = 0

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
    }

    private struct Refused: Error {}

    func testItReportsWhateverTheSystemSaysAtConstruction() {
        for state in [LoginItemState.off, .on, .needsApproval, .unavailable] {
            XCTAssertEqual(LoginItemPreference(service: FakeService(state: state)).state, state)
        }
    }

    func testTurningItOnRegisters() {
        let service = FakeService(state: .off)
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        XCTAssertEqual(service.enables, 1)
        XCTAssertEqual(preference.state, .on)
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
        XCTAssertEqual(preference.state, .needsApproval)
        XCTAssertFalse(preference.lastChangeRefused,
                       "needing approval is not a failure; nothing was refused")
    }

    func testARefusedEnableIsRecordedAndDoesNotClaimSuccess() {
        let service = FakeService(state: .off)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.set(true)
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
        XCTAssertEqual(preference.state, .needsApproval)
    }

    func testARetryClearsTheEarlierRefusal() {
        let service = FakeService(state: .off)
        service.enableError = Refused()
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        XCTAssertTrue(preference.lastChangeRefused)
        service.enableError = nil
        preference.set(true)
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
        service.enableError = nil
        preference.refresh()
        XCTAssertFalse(preference.lastChangeRefused)
    }

    /// A control that cannot work must not be operated. Attempting it would
    /// produce a refusal the user can do nothing about, on a Mac where the app
    /// is running from somewhere macOS will not manage.
    func testAnUnavailableServiceIsNeverAsked() {
        let service = FakeService(state: .unavailable)
        let preference = LoginItemPreference(service: service)
        preference.set(true)
        preference.set(false)
        XCTAssertEqual(service.enables, 0)
        XCTAssertEqual(service.disables, 0)
        XCTAssertEqual(preference.state, .unavailable)
        XCTAssertFalse(preference.lastChangeRefused)
    }
}
