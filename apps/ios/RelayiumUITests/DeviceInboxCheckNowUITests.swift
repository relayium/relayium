import XCTest

/// **Check now on iOS, driven through the real receiver.**
///
/// The launches below replace only the transport (`UITestInbox`): the shared
/// `InboxController`, its serial loop and coalescing, enrolment, key store,
/// decryption, container commit and journal are the product's. The automatic
/// schedule is stretched to an hour and every pass after launch is held for a
/// moment, so each state asserted here is the answer to a press made here — not
/// the loop's own timer — and Checking… is on screen long enough to observe.
///
/// The macOS counterpart is `DeviceInboxUITests.testCheckNowShowsCheckingThen…`;
/// this adds what a phone makes easy to get wrong: a double tap, and a check
/// under Ask that must not answer anything on the user's behalf.
final class DeviceInboxCheckNowUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    private func launch(_ fixture: String) {
        app.launchArguments = [
            "--relayium-ui-testing", "--relayium-ui-testing-signed-in", fixture,
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        _ = waitForShell(app)
        open(Shell.deviceInbox, in: app)
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)[identifier].firstMatch
    }

    private func wait(_ element: XCUIElement, _ format: String, _ args: String...,
                      timeout: TimeInterval, _ message: String) {
        let predicate = NSPredicate(format: format, argumentArray: args)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: timeout), .completed, message)
    }

    private func labelContains(_ element: XCUIElement, _ text: String,
                               timeout: TimeInterval, _ message: String) {
        wait(element, "label CONTAINS[c] %@", text, timeout: timeout, message)
    }

    /// Checking…, an empty answer that claims nothing, then a found delivery
    /// whose arrival is the status line's — with a second tap during the first
    /// check coalesced rather than starting a pass of its own.
    func testCheckNowShowsCheckingThenNothingNewThenDefersToTheReceipt() {
        launch("--relayium-ui-testing-inbox-check")

        let status = element("inbox-status")
        XCTAssertTrue(status.waitForExistence(timeout: 20), "the inbox has no status head")
        labelContains(status, "Ready to receive", timeout: 30,
                      "the fixture inbox never became ready")

        let check = element("inbox-check-now")
        XCTAssertTrue(check.waitForExistence(timeout: 10), "a ready inbox offers no Check now")
        XCTAssertTrue(check.isEnabled)
        XCTAssertFalse(element("inbox-check-result").exists,
                       "an answer was shown before anything was checked")

        check.tap()
        // One predicate, so the disabled state and its words are read from the
        // same snapshot of the same pass.
        wait(check, "isEnabled == false AND label CONTAINS[c] %@", "Checking", timeout: 5,
             "a running check stays pressable or does not say Checking")
        // The second tap lands on a disabled control, and even if it reached the
        // controller it would coalesce. Either way the fixture's second pending
        // read must still be the empty one: a parallel or queued extra pass would
        // advance it to the delivery and turn this answer into "Check complete".
        check.tap()

        let answer = element("inbox-check-result")
        XCTAssertTrue(answer.waitForExistence(timeout: 15), "the check was never answered")
        labelContains(answer, "Nothing new", timeout: 2,
                      "a double tap started a second pass, or the empty check claimed more")
        labelContains(status, "Ready to receive", timeout: 2,
                      "an empty check changed what the inbox says it is")

        wait(check, "isEnabled == true", timeout: 5, "the answered check never re-enabled")
        labelContains(check, "Check now", timeout: 2, "the answered control still says Checking")

        check.tap()
        labelContains(status, "saved", timeout: 45,
                      "the second check did not deliver through the real receiver")
        labelContains(answer, "Check complete", timeout: 10,
                      "the check that found the delivery was not answered as complete")
    }

    /// Under Ask, Check now looks again and answers nothing: the held deliveries
    /// keep their own Receive and Decline after the check completes.
    func testCheckNowUnderAskKeepsHeldDeliveriesForTheUser() {
        launch("--relayium-ui-testing-inbox-ask")

        let held = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "inbox-ask."))
        XCTAssertTrue(held.firstMatch.waitForExistence(timeout: 40),
                      "the Ask fixture's held deliveries were never shown")
        let before = held.count

        let check = element("inbox-check-now")
        XCTAssertTrue(check.waitForExistence(timeout: 10),
                      "an inbox holding deliveries for an answer offers no Check now")
        check.tap()
        wait(check, "isEnabled == false AND label CONTAINS[c] %@", "Checking", timeout: 5,
             "a running check stays pressable or does not say Checking")

        let answer = element("inbox-check-result")
        XCTAssertTrue(answer.waitForExistence(timeout: 15), "the check was never answered")
        XCTAssertEqual(held.count, before,
                       "Check now accepted or declined a held delivery on the user's behalf")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@",
                                                            "files saved")).firstMatch.exists,
                       "a check under Ask presented a delivery nobody accepted")
    }
}
