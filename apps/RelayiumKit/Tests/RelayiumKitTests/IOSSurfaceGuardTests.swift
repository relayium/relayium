import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// What the iOS app is NOT allowed to contain.
///
/// Three failure modes, all of which look fine in a diff:
///
///  1. **A credential in a log.** One `print` in a view that renders a token is
///     a line nobody re-reads and no behavioral test can see.
///  2. **A dead control for a deferred feature.** An empty device list, a
///     greyed Send tab, a button for something unwired: each is a promise the
///     app cannot keep, and each reads as progress in review. "Sign in with
///     Apple" was the example here through three slices; it left the list by
///     being BUILT, which is why the Apple assertions below are positive ones
///     about the system control rather than a ban on naming it.
///  3. **Copy that names the wrong platform.** R3-B recorded nineteen such
///     catalog strings. Re-deriving the set for R3-C found **twenty-two**: the
///     R3-B count enumerated the keys saying *Mac* plus the one saying *macOS*,
///     and there were three more of the latter — `error.storedKey.keychain.save`,
///     `.read` and `.remove`. Recording the miscount is part of fixing it.
///     R3-C reaches five of the twenty-two and corrects those five in place, in
///     all nine catalogs, to device-neutral wording that stays true on macOS.
///     R3-D reaches eight more — the device list, the stored-file list and the
///     link rebuild — and corrects those the same way. R3-E reaches a ninth,
///     `verify.explainEncryption`, because this is the slice that renders the
///     advanced-verification setting. **Seven** remain, six blocked behind the
///     nearby/notification feature this app does not have and one rendered by
///     nothing on either platform, so rendering any of them has to be a decision
///     rather than an oversight.
///  4. **A feature quietly unwired.** Launch restore is not decoration: without
///     it a signed-in user meets the sign-in form every launch.
///
/// Much of it scans source text rather than behavior on purpose: these are
/// absences, and an absence has no runtime to observe.
///
/// R3-D adds the other direction, and it is the larger half of this file now.
/// The account-management surface is the first iOS screen whose defects are all
/// *presence* defects — a management model built twice, a stale credential
/// carried into a revoke, a sign-out that clears rows after the network call
/// instead of before, a `#k=` link offered for a key this device does not hold.
/// None of those is visible in a screenshot and none is reachable from a package
/// test, because SwiftUI owns the view. So the decisions live in
/// `AccountManagementModel` and `AccountPresentation`, where
/// `AccountManagementModelTests` and `AccountManagementPresentationTests` drive
/// them for real, and what is asserted HERE is only the wiring that connects the
/// two — which is exactly the part a re-layout drops silently.
final class IOSSurfaceGuardTests: XCTestCase {

    /// `apps/`, discovered rather than counted, and checked for existing.
    private var appsRoot: URL {
        get throws { try RepoRoot.apps() }
    }

    private var iosRoot: URL { get throws { try RepoRoot.directory("apps/ios/Relayium") } }

    /// The view-model layer, which is where a credential actually passes
    /// through: `AccountSession` holds the bearer, and `ErrorCopy` formats
    /// failures around it.
    private var appKitRoot: URL {
        get throws { try RepoRoot.directory("apps/RelayiumKit/Sources/RelayiumAppKit") }
    }

    func testIOSRuntimeSmokeIsWiredWithoutPublishingNearbyPresence() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" }?.text)
        let mode = try XCTUnwrap(try sources().first { $0.name == "UITestMode.swift" }?.text)
        XCTAssertTrue(mode.contains("--relayium-ui-testing"))
        XCTAssertTrue(mode.contains("#if DEBUG"))
        XCTAssertEqual(app.components(
            separatedBy: "if !UITestMode.isActive").count - 1, 1,
            "a UI simulator can still enter the public Nearby room")
        XCTAssertTrue(app.contains("residency.pause()"),
                      "the offline UI test state contradicts its own receiving controls")

        // The acceptance fixture writes into the container the app publishes to
        // Files. Presence in the Debug half is not the invariant — ABSENCE from
        // the Release half is, because that is the binary a user installs.
        let halves = mode.components(separatedBy: "#else")
        XCTAssertEqual(halves.count, 2, "UITestMode lost its Debug/Release split")
        let debugHalf = try XCTUnwrap(halves.first)
        let releaseHalf = try XCTUnwrap(halves.last)
        XCTAssertTrue(debugHalf.contains("--relayium-ui-testing-pending-fixture"),
                      "the pending-file fixture argument is not in the Debug half")
        XCTAssertTrue(debugHalf.contains("--relayium-ui-testing-valid-download-link"),
                      "the deterministic stored-link fixture is not in the Debug half")
        XCTAssertTrue(debugHalf.contains("--relayium-ui-testing-fresh-received-folder"),
                      "the empty-receive-folder argument is not in the Debug half")
        XCTAssertFalse(releaseHalf.contains("--relayium-ui-testing"),
                       "a shipped build can be steered by a launch argument")
        XCTAssertFalse(releaseHalf.contains("Data(repeating:"),
                       "a shipped build writes the acceptance fixture into its container")
        // The strongest of these, and the newest risk class in this file: one of
        // the acceptance seams DELETES. Writing a fixture into the container is
        // recoverable; removing the folder a person's received files live in is
        // not, so the Release half must not contain the call at all — not a
        // guarded call, not a call behind a flag folded to false.
        XCTAssertFalse(releaseHalf.contains("removeItem"),
                       "a shipped build can delete what a user has received")
        XCTAssertFalse(releaseHalf.contains("documentDirectory"),
                       "a shipped build reaches the directory the fixture path uses")
        XCTAssertTrue(app.contains("UITestMode.stagePendingFixture()"),
                      "nothing stages the fixture the document-picker path needs")
        XCTAssertTrue(app.contains("UITestMode.prefillValidDownloadLink(in: downloads)"),
                      "the encrypted-link acceptance fixture never reaches the receive model")
        XCTAssertTrue(app.contains("UITestMode.resetReceivedFolder()"),
                      "nothing empties the receive folder, so the completion path "
                      + "passes once per simulator and then fails on its own leftovers")

        let ui = try RepoRoot.text("apps/ios/RelayiumUITests/AppShellUITests.swift")
        for task in ["Receive", "Send", "Direct", "Nearby", "Account"] {
            XCTAssertTrue(ui.contains("(tab: \"\(task)\""),
                          "the runtime smoke omits \(task)")
        }

        let scheme = try RepoRoot.text(
            "apps/ios/Relayium.xcodeproj/xcshareddata/xcschemes/Relayium.xcscheme")
        XCTAssertTrue(scheme.contains("RelayiumUITests.xctest"))

        // Hosted CI must actually RUN the shell asserted above, not just compile
        // it. That step moved: `ios-build` left `macos.yml` for a dedicated
        // `ios.yml`, so this once read the macOS workflow and would now pass on
        // a file that no longer builds iOS at all. Read the new owner, and read
        // it inside the smoke step rather than anywhere in the file — `macos.yml`
        // drives a target *also* called `RelayiumUITests`, so the bare argument
        // is not by itself evidence that the iOS shell ran.
        let iosWorkflow = try RepoRoot.text(".github/workflows/ios.yml")
        let smokeStep = try XCTUnwrap(iosWorkflow.components(
            separatedBy: "- name: Run iOS primary-task UI smoke")
            .dropFirst().first?.components(separatedBy: "\n      - name: ").first,
            "ios.yml has no step that drives the iOS shell")
        XCTAssertTrue(smokeStep.contains("-project apps/ios/Relayium.xcodeproj"),
                      "the runtime smoke no longer drives the iOS project")
        XCTAssertTrue(smokeStep.contains("-only-testing:RelayiumUITests test"),
                      "CI compiles iOS but never runs its shell")
        // And the move must have been a MOVE. If `macos.yml` reaches into the
        // iOS project again, the split is cosmetic: two workflows drive the same
        // simulator and every macOS-only change pays for an iOS runner.
        let macWorkflow = try RepoRoot.text(".github/workflows/macos.yml")
        XCTAssertFalse(macWorkflow.contains("apps/ios/"),
                       "macos.yml drives the iOS project again, so the iOS shell "
                       + "smoke is hosted twice instead of moved")
    }

    /// The preselection seam: it must exist, it must stay event-driven, it must
    /// stay out of Release, and the one test that relies on it must keep the
    /// precondition that makes its result mean anything.
    ///
    /// Every assertion here is about a way this repair silently stops being a
    /// repair. Deleting the seam turns the failed-upload test into a test that
    /// taps Send with nothing staged and then reports a missing *Resume upload*
    /// — a red naming the wrong thing. Replacing the two publishers with a
    /// sleep or a retry turns a determinism fix into a longer flake. Letting the
    /// injection reach the Release half puts a selection in front of a person
    /// who never made one. And dropping the `pendingFile.0` wait removes the
    /// only thing that distinguishes "the upload failed" from "there was
    /// nothing to upload".
    func testThePreselectionSeamIsDeterministicAndAbsentFromRelease() throws {
        let mode = try XCTUnwrap(try sources().first { $0.name == "UITestMode.swift" }?.text)
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" }?.text)
        let halves = mode.components(separatedBy: "#else")
        XCTAssertEqual(halves.count, 2, "UITestMode lost its Debug/Release split")
        let debugHalf = try XCTUnwrap(halves.first)
        let releaseHalf = try XCTUnwrap(halves.last)

        // 1. The seam exists, and injects through the callback the real picker
        //    uses. A different entry point would be a different code path.
        XCTAssertTrue(debugHalf.contains("--relayium-ui-testing-preselect-fixture"),
                      "the preselected-fixture argument is not in the Debug half")
        XCTAssertTrue(debugHalf.contains("send.chooseFiles(.success([url]))"),
                      "the preselection no longer injects through the same "
                      + "SendSelectionModel callback SendView's fileImporter calls")

        // 2. It waits on the two refusals `chooseFiles` actually carries — a
        //    ready account and an idle upload model — by observing them.
        let seam = try XCTUnwrap(debugHalf.components(
            separatedBy: "final class UITestPreselection").dropFirst().first?
            .components(separatedBy: "enum UITestMode").first,
            "UITestPreselection is gone, so nothing stages a selection without "
            + "the system document browser")
        XCTAssertTrue(seam.contains("Publishers.CombineLatest(session.$state, upload.$state)"),
                      "the preselection stopped waiting on the account and upload "
                      + "state it needs both of")
        XCTAssertTrue(seam.contains("case .ready = session.state"),
                      "the preselection no longer requires a ready account, so it "
                      + "can be dropped by chooseFiles' account refusal")
        XCTAssertTrue(seam.contains("case .idle = upload.state"),
                      "the preselection no longer requires an idle upload model, so "
                      + "it can be dropped by chooseFiles' busy refusal")
        XCTAssertTrue(seam.contains("FileManager.default.fileExists(atPath: url.path)"),
                      "the preselection can inject a URL whose bytes nobody wrote")
        // 3. Event-driven, and provably not the thing it replaced. A timer, a
        //    sleep or a delayed re-attempt would make this a slower race.
        for banned in ["Task.sleep", "asyncAfter", "Timer", "usleep", "sleep("] {
            XCTAssertFalse(seam.contains(banned),
                           "the preselection waits by \(banned) instead of by the "
                           + "state changes the models publish")
        }
        // 4. One shot, cancelled explicitly rather than left subscribed.
        XCTAssertTrue(seam.contains("func cancel()"),
                      "the preselection has no explicit cancellation")
        XCTAssertTrue(seam.contains("observation?.cancel()"),
                      "the preselection never cancels its own subscription")

        // 5. Absent from Release — not folded to false, ABSENT. The Release half
        //    must contain the inert entry point and no injection at all.
        XCTAssertTrue(releaseHalf.contains("static func preselectPendingFixture"),
                      "the Release half lost the inert preselection entry point, so "
                      + "a shipped build no longer compiles the call site")
        XCTAssertFalse(releaseHalf.contains("chooseFiles("),
                       "a shipped build can inject a file selection nobody made")
        XCTAssertFalse(releaseHalf.contains("UITestPreselection"),
                       "a shipped build can construct the acceptance preselection")

        // 6. Wired once, at the app-scoped construction point, and AFTER the
        //    session observation it depends on being installed first.
        XCTAssertEqual(app.components(separatedBy:
            "UITestMode.preselectPendingFixture(into: sending, upload: uploads, "
            + "session: account)").count - 1, 1,
            "the preselection is not wired exactly once at app construction")
        let observe = try XCTUnwrap(app.range(of: "sending.observe(account.$state)"))
        let preselect = try XCTUnwrap(app.range(of: "UITestMode.preselectPendingFixture("))
        XCTAssertTrue(observe.upperBound <= preselect.lowerBound,
                      "the preselection subscribes to the session before the send "
                      + "model does, so it can act on an account the model has not "
                      + "been told about")

        // 7. The test it repairs keeps the precondition, and stops paying for
        //    the picker presentation it was losing.
        let ui = try RepoRoot.text("apps/ios/RelayiumUITests/AppShellUITests.swift")
        let repaired = try XCTUnwrap(ui.components(
            separatedBy: "func testAFailedUploadKeepsTheWorkAndOffersToCarryOn()")
            .dropFirst().first?.components(separatedBy: "\n    /// ").first,
            "the repaired upload-failure test is gone")
        XCTAssertTrue(repaired.contains("--relayium-ui-testing-preselect-fixture"),
                      "the upload-failure test no longer uses the deterministic seam")
        XCTAssertTrue(repaired.contains("\"pendingFile.0\""),
                      "the upload-failure test taps Send without first proving a "
                      + "file was staged, so a lost selection reports itself as a "
                      + "missing Resume upload")
        XCTAssertTrue(repaired.contains("the preselected fixture never became a pending send"),
                      "the staged-file precondition lost the message that names it")
        XCTAssertFalse(repaired.contains("DOC.browsingModeTabBar"),
                       "the upload-failure test opens the system document browser "
                       + "again, which is the presentation race this replaced")
        for assertion in ["Resume upload", "Discard saved copy", "#k="] {
            XCTAssertTrue(repaired.contains(assertion),
                          "the upload-failure test dropped its \(assertion) assertion")
        }

        // 8. And the picker is still covered FOR REAL. These two are about the
        //    system browser, the security scope and the expansion; the seam must
        //    never spread into them. The shared selector may accommodate every
        //    directory Files validly remembers, but must still finish through
        //    the browser fixture helper rather than injecting a selection.
        let selector = try XCTUnwrap(ui.components(
            separatedBy: "private func selectStagedFixture(named stem: String)")
            .dropFirst().first?.components(separatedBy: "\n    /// ").first,
            "the deterministic browser-state selector is gone")
        XCTAssertTrue(selector.contains("tapStagedFixture(named:"),
                      "the browser-state selector no longer chooses the real fixture")
        XCTAssertTrue(selector.contains("tapInBrowser(\"On My iPhone\")"),
                      "the browser-state selector cannot enter device storage")
        for picker in ["func testPendingSendNamesTheFileAndItsSizeBeforeTransfer()",
                       "func testASignedInStoredSendNamesTheFileItWouldUpload()"] {
            let body = try XCTUnwrap(ui.components(separatedBy: picker)
                .dropFirst().first?.components(separatedBy: "\n    /// ").first,
                "the dedicated real-picker test \(picker) is gone")
            XCTAssertTrue(body.contains("DOC.browsingModeTabBar"),
                          "\(picker) stopped driving the real system document browser")
            XCTAssertTrue(body.contains("selectStagedFixture(named:"),
                          "\(picker) no longer selects the fixture through the browser")
            XCTAssertFalse(body.contains("--relayium-ui-testing-preselect-fixture"),
                           "\(picker) was switched to the injection seam, so nothing "
                           + "exercises the picker any more")
        }

        // 9. The built-App transfer gate uses the deterministic seam too. Its
        //    subject is the transfer after selection; picker presentation stays
        //    owned by the two tests above.
        let local = try RepoRoot.text("apps/ios/RelayiumUITests/LocalSessionUITests.swift")
        let nearbyTransfer = try XCTUnwrap(local.components(
            separatedBy: "func testNearbyLinkTransfersThenDoneReturnsToACleanRoster()")
            .dropFirst().first?.components(separatedBy: "\n    // MARK:").first,
            "the built-App Nearby transfer acceptance is gone")
        XCTAssertTrue(nearbyTransfer.contains(
            "--relayium-ui-testing-preselect-direct-fixture"),
                      "the Nearby transfer gate again depends on Files presenting")
        XCTAssertTrue(nearbyTransfer.contains("\"pendingFile.0\""),
                      "the Nearby transfer gate no longer proves a file was staged")
        XCTAssertFalse(nearbyTransfer.contains("DOC.browsingModeTabBar"),
                       "the Nearby transfer gate duplicates the real-picker tests")

        XCTAssertTrue(debugHalf.contains(
            "static func preselectPendingFixture(into selection: DirectSendSelection)"),
                      "the direct preselection seam no longer targets Nearby's model")
        XCTAssertTrue(app.contains("UITestMode.preselectPendingFixture(into: selecting)"),
                      "the app no longer installs the direct preselection seam")
        XCTAssertTrue(debugHalf.contains("guard preselectsDirectPendingFixture else"),
                      "the direct seam can run without its dedicated launch argument")
        XCTAssertFalse(releaseHalf.contains("selection.chooseFiles(.success([url]))"),
                       "the shipped iOS build can inject a direct file selection")
    }

    /// The refused-link seam, and the coverage it must not quietly replace.
    ///
    /// `testEditingARefusedLinkClearsTheRefusalWithIt` established its
    /// precondition by typing the refused string, and hosted run
    /// 33020899047 read the real field back as `not ink`. The value is setup
    /// there, not subject, so it now arrives through a Debug-only fixture — and
    /// every way that repair silently stops being one is an assertion here.
    ///
    /// Deleting the seam returns the test to the dropped-keystroke race.
    /// Letting it reach Release puts a link in front of a person who pasted
    /// nothing. Pointing it at a model Receive does not render makes the
    /// precondition pass while the screen stays empty. Spending more than one
    /// synthetic keystroke re-buys the nondeterminism the seam removed, and
    /// spending it on a control key spends nothing at all: run 33032681386
    /// typed DEL into the prefilled field and the value never moved, so the
    /// edit under test has to stay an ordinary visible insertion.
    /// Removing the real Open or the two derived-state waits turns a product
    /// assertion into a fixture assertion. And switching the malformed-link or
    /// keyboard-Go tests onto the seam would leave the product with NO runtime
    /// evidence that a link can be typed and submitted at all.
    func testTheRefusedLinkSeamIsDebugOnlyAndKeepsRealTypingCoverage() throws {
        let mode = try XCTUnwrap(try sources().first { $0.name == "UITestMode.swift" }?.text)
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" }?.text)
        let halves = mode.components(separatedBy: "#else")
        XCTAssertEqual(halves.count, 2, "UITestMode lost its Debug/Release split")
        let debugHalf = try XCTUnwrap(halves.first)
        let releaseHalf = try XCTUnwrap(halves.last)

        // 1. Debug-only presence, and it injects the string the product must
        //    REFUSE rather than pre-setting a failed state the product never
        //    produced. The refusal has to stay the product's own.
        XCTAssertTrue(debugHalf.contains("--relayium-ui-testing-invalid-download-link"),
                      "the deterministic refused-link fixture is not in the Debug half")
        let seam = try XCTUnwrap(debugHalf.components(
            separatedBy: "static func prefillInvalidDownloadLink(in model: CloudDownloadModel) {")
            .dropFirst().first?.components(separatedBy: "\n    }").first,
            "the refused-link seam is gone, so the correction test is back to "
            + "typing its own precondition")
        XCTAssertTrue(seam.contains("model.linkText = invalidDownloadLinkText"),
                      "the refused-link seam no longer sets the same published "
                      + "property a paste sets, so the refusal it produces is not "
                      + "the one a user would meet")
        XCTAssertTrue(seam.contains("guard ProcessInfo.processInfo.arguments.contains("
                                    + "invalidDownloadLinkArgument)"),
                      "the refused-link seam can run without its launch argument, so "
                      + "every other Debug launch starts Receive pre-filled")
        // It must not FORGE the refusal. The state under test has to be the one
        // the product's own parse produced from the injected string.
        for forged in ["state = ", "DownloadState", "downloadBadLink", "resolve"] {
            XCTAssertFalse(seam.contains(forged),
                           "the refused-link seam drives \(forged) instead of letting "
                           + "the test's real Open produce the refusal")
        }

        // 2. Absent from Release — the inert entry point only, so the call site
        //    still compiles and a shipped launch injects nothing.
        XCTAssertTrue(releaseHalf.contains(
            "static func prefillInvalidDownloadLink(in model: CloudDownloadModel) {}"),
                      "the Release half lost the inert refused-link entry point, so a "
                      + "shipped build no longer compiles the call site")
        XCTAssertFalse(releaseHalf.contains("invalidDownloadLinkText"),
                       "a shipped build carries the acceptance link value")
        XCTAssertFalse(releaseHalf.contains("model.linkText ="),
                       "a shipped build can start a receive already holding a link "
                       + "nobody pasted")

        // 3. Wired once, into the REAL model — the same instance the app hands
        //    to the Receive screen, not a second one built for the fixture.
        XCTAssertEqual(app.components(separatedBy:
            "UITestMode.prefillInvalidDownloadLink(in: downloads)").count - 1, 1,
            "the refused-link seam is not wired exactly once at app construction")
        XCTAssertTrue(app.contains("_download = StateObject(wrappedValue: downloads)"),
                      "the prefilled download model is no longer the one the app "
                      + "renders, so the fixture reaches a model nobody sees")

        // 4. Used by exactly the one test it was built for, in one launch, and
        //    never combined with the valid-link fixture that would overwrite it.
        let ui = try RepoRoot.text("apps/ios/RelayiumUITests/AppShellUITests.swift")
        let local = try RepoRoot.text("apps/ios/RelayiumUITests/LocalSessionUITests.swift")
        XCTAssertEqual(ui.components(
            separatedBy: "--relayium-ui-testing-invalid-download-link").count - 1, 1,
            "the refused-link seam spread beyond the single test that needs it")
        XCTAssertFalse(local.contains("--relayium-ui-testing-invalid-download-link"),
                       "the built-App suite adopted the refused-link seam too")
        let repaired = try XCTUnwrap(ui.components(
            separatedBy: "func testEditingARefusedLinkClearsTheRefusalWithIt()")
            .dropFirst().first?.components(separatedBy: "\n    /// ").first,
            "the repaired refusal-correction test is gone")
        XCTAssertTrue(repaired.contains("--relayium-ui-testing-invalid-download-link"),
                      "the correction test no longer uses the deterministic seam")
        XCTAssertFalse(repaired.contains("--relayium-ui-testing-valid-download-link"),
                       "the correction launch selects two competing link fixtures, so "
                       + "which one reaches the field depends on call order")

        // 5. Setup is deterministic; the ONE keystroke is real; and what it
        //    proves is product state, reached through the product's own Open.
        XCTAssertTrue(repaired.contains(
            "the deterministic refused-link fixture did not reach the real field"),
                      "the correction test no longer proves the fixture reached the "
                      + "real field, so a silently dropped injection would read as a "
                      + "passed correction")
        XCTAssertEqual(repaired.components(separatedBy: ".typeText(").count - 1, 1,
                       "the correction test spends more than the one synthetic "
                       + "keystroke that is its subject")
        // And that one keystroke is an ORDINARY VISIBLE INSERTION. Hosted run
        // 33032681386 proved the fixture reaches the real field and the real
        // Open produces the real refusal, then tapped the field, logged
        // `Type DEL`, and watched the value stay `not a link` for the full
        // ten-second wait: a delete has nothing to consume on a field nobody
        // typed into, so it delivered no edit and the test read a working
        // product as broken. An insertion depends on no prior text and no caret
        // position, which is the whole reason it is pinned here by value.
        let typed = try XCTUnwrap(repaired.components(separatedBy: "link.typeText(")
            .dropFirst().first?.components(separatedBy: ")").first,
            "the correction test performs no real keyboard edit at all, so nothing "
            + "in the suite proves that editing a refused link clears the refusal")
        XCTAssertEqual(typed, "\"x\"",
                       "the correction test's one edit is no longer an ordinary visible "
                       + "character. A control key — DEL above all — is consumed "
                       + "silently by a programmatically prefilled field, which is the "
                       + "exact failure this pin exists to prevent recurring.")
        // The correction itself must stay a keystroke. A second launch is the
        // only way to hand this screen another injected value, so one launch
        // means the fixture owns setup and the keyboard owns the subject.
        XCTAssertEqual(repaired.components(separatedBy: "app.launch()").count - 1, 1,
                       "the correction test relaunches more than once, so the "
                       + "correction can be driven by another injected fixture instead "
                       + "of the real keyboard edit it exists to prove")
        // The change is awaited on the REAL field, and as an INEQUALITY. The tap
        // decides where the caret lands, so requiring one exact corrected string
        // would make a delivered edit fail for landing in the wrong place; and
        // dropping the value comparison would let an undelivered edit pass.
        XCTAssertTrue(repaired.contains("value != %@"),
                      "the correction test no longer waits on the real field's value "
                      + "changing, so an edit that was never delivered would read as a "
                      + "passed correction")
        XCTAssertFalse(repaired.contains("value == %@"),
                       "the correction test demands one exact corrected string, so a "
                       + "delivered edit fails wherever the tap happened to put the "
                       + "caret")
        XCTAssertTrue(repaired.contains("open.tap()"),
                      "the correction test no longer produces its refusal with the "
                      + "product's own Open action")
        for derived in ["the refused link did not accept the correction",
                        "the refusal outlived the input it described",
                        "did not restore the idle receive state"] {
            XCTAssertTrue(repaired.contains(derived),
                          "the correction test dropped its \(derived) assertion")
        }

        // 6. And real typing/submission stays owned by the two tests that name
        //    that contract. This is the coverage the seam must route AROUND.
        for typing in ["func testMalformedReceiveLinkExplainsHowToRecover()",
                       "func testTheKeyboardGoKeyResolvesTheLink()"] {
            let body = try XCTUnwrap(ui.components(separatedBy: typing).dropFirst().first?
                .components(separatedBy: "\n    /// ").first,
                "the real-typing test \(typing) is gone")
            XCTAssertTrue(body.contains("link.typeText(\"not a link\")"),
                          "\(typing) stopped entering its link with the real keyboard")
            XCTAssertFalse(body.contains("--relayium-ui-testing-invalid-download-link"),
                           "\(typing) was switched to the injection seam, so nothing "
                           + "types a link into the product any more")
        }
        let go = try XCTUnwrap(ui.components(
            separatedBy: "func testTheKeyboardGoKeyResolvesTheLink()").dropFirst().first?
            .components(separatedBy: "\n    /// ").first)
        XCTAssertTrue(go.contains("app.keyboards.buttons[\"go\"]"),
                      "the keyboard-Go test no longer presses the real Go key")
    }

    /// Nearby, pairing-code and stored sending are three destinations for the
    /// same promise: before Send, the user can inspect every file and its size.
    func testEverySendSurfaceShowsThePendingFileNamesAndSizes() throws {
        let all = try sources()
        let component = try XCTUnwrap(all.first { $0.name == "PendingFileList.swift" }?.text)
        for required in ["FileIdentityPresentation.name(for: file)",
                         "L10n.bytes(Int64(file.size))",
                         "ScrollView", ".frame(maxHeight: 220)"] {
            XCTAssertTrue(component.contains(required), "pending-file list lost \(required)")
        }
        for view in ["NearbyView.swift", "DirectView.swift", "SendView.swift"] {
            let text = try XCTUnwrap(all.first { $0.name == view }?.text)
            XCTAssertTrue(text.contains("PendingFileList(files: selection.selectedFiles)"),
                          "\(view) regressed to a count-only selection")
        }
        let storedSend = try XCTUnwrap(all.first { $0.name == "SendView.swift" }?.text)
        XCTAssertGreaterThanOrEqual(storedSend.components(separatedBy:
            "PendingFileList(sessionFiles: upload.sessionFiles)").count - 1, 4,
            "stored upload lost file identities in a running or terminal state")
    }

    /// The status line has always come from `receive.state`, but the explanation
    /// and the Pause/Resume control came from `residency.isPaused` — a different
    /// question. `.off` while the user has paused nothing is reachable: any
    /// destination failure returns before discovery starts, and `resume` on a
    /// non-resident model lands there too. In that state the card claimed to be
    /// listening, named where incoming files land, and offered to pause a
    /// listener that is already off. One source, as on macOS.
    func testNearbyOffStateOffersOneTruthfulRecovery() throws {
        let all = try sources()
        let nearby = try XCTUnwrap(all.first { $0.name == "NearbyView.swift" }?.text)
        XCTAssertTrue(nearby.contains("switch receive.state"),
                      "the receiving control is not derived from the rendered state")
        XCTAssertTrue(nearby.contains("case .connecting, .ready, .reconnecting, .active:"),
                      "the states that can actually be paused are not stated together")
        XCTAssertTrue(nearby.contains("receive.state == .paused || receive.state == .off"),
                      "the explanation still answers a different question than the status")
        XCTAssertFalse(nearby.contains("L10n.t(residency.isPaused ? .nearbyPausedBody"),
                       "the explanation is still derived from the pause flag")

        let ui = try RepoRoot.text("apps/ios/RelayiumUITests/AppShellUITests.swift")
        XCTAssertTrue(ui.contains("testStoppedNearbyReceivingAsksForActionWithoutPretendingToWork"),
                      "no runtime path drives the off state")
        XCTAssertTrue(ui.contains("app.buttons[\"Pause receiving\"].exists"))
        XCTAssertTrue(ui.contains("app.buttons[\"Resume receiving\"].exists"))
    }

    /// A pending row answers "what am I about to send?" for someone who cannot
    /// see it, and it is what runtime acceptance binds to. Leaving both to
    /// `.accessibilityElement(children: .combine)` makes the spoken identity a
    /// property of how SwiftUI merges descendant text nodes on the OS version
    /// that happens to be running, and leaves nothing stable to address. macOS
    /// states both explicitly; iOS must not drift from that.
    func testEveryPendingFileRowStatesItsOwnAccessibleIdentity() throws {
        let component = try XCTUnwrap(
            try sources().first { $0.name == "PendingFileList.swift" }?.text)
        XCTAssertTrue(component.contains(".accessibilityLabel(\"\\(name), \\(size)\")"),
                      "a pending row leaves its spoken identity to descendant merging")
        XCTAssertTrue(component.contains(".accessibilityIdentifier(\"pendingFile.\\(index)\")"),
                      "a pending row exposes no stable identity to bind acceptance to")
        XCTAssertTrue(component.contains("ForEach(Array(files.enumerated()), id: \\.offset)"),
                      "the row index the identity is built from is gone")
    }

    /// Waiting share drafts are send choices too. Several can have the same
    /// count and total, so each card must expose its safe manifest identities
    /// before Use or destructive Discard.
    func testWaitingSharedDraftCardsShowNamesAndSizesWithoutContainerURLs() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        guard let card = view.text.range(of: "private func sharedDraftCard"),
              let draftsEnd = view.text.range(of: "private var availability",
                                              range: card.lowerBound..<view.text.endIndex) else {
            return XCTFail("SendView lost its waiting shared-draft card")
        }
        let body = view.text[card.lowerBound..<draftsEnd.lowerBound]
        XCTAssertTrue(body.contains("PendingFileList(sessionFiles: draft.files)"))
        XCTAssertFalse(body.contains("draft.url"))
    }

    func testEveryIOSFileListUsesTheSharedSafeLocalizedIdentity() throws {
        let all = try sources()
        for name in ["PendingFileList.swift", "DirectFileSessionView.swift",
                     "ReceiveView.swift"] {
            let text = try XCTUnwrap(all.first { $0.name == name }?.text)
            XCTAssertTrue(text.contains("FileIdentityPresentation.name(for:"),
                          "\(name) does not use the shared file identity")
            XCTAssertFalse(text.contains("safeDisplayName("),
                           "\(name) can render an empty sanitized name")
            XCTAssertFalse(text.contains("\"download\""),
                           "\(name) leaks an English fallback into other languages")
        }
    }

    func testStoredReceivePreviewDoesNotTruncateFileIdentity() throws {
        let source = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" }?.text)
        let preview = try XCTUnwrap(source.components(
            separatedBy: "private func ready(").dropFirst().first?
            .components(separatedBy: "private func done").first)
        XCTAssertTrue(preview.contains("FileIdentityPresentation.name(for: file)"))
        XCTAssertTrue(preview.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(preview.contains(".lineLimit(1)"),
                       "the pre-save file identity is visually truncated")
    }

    /// The file picker disappears after Create. Minting and the code/QR/link
    /// handoff still have to identify the payload until the peer joins or the
    /// sender cancels.
    func testFilePairingKeepsTheStagedFileNamesAndSizesVisibleUntilDone() throws {
        let all = try sources()
        let direct = try XCTUnwrap(all.first { $0.name == "DirectView.swift" }?.text)
        let fileMinting = try XCTUnwrap(direct.components(
            separatedBy: "case .minting:").dropFirst().first?
            .components(separatedBy: "case let .showingCode").first)
        XCTAssertTrue(fileMinting.contains(
            "PendingFileList(sessionFiles: file.sessionFiles)"),
            "code creation hides the files it is waiting to send")

        // The handoff renders the manifest itself, inside the card that names
        // the code — it is what that code will send, not a separate section
        // above the heading. So the assertion follows it there: the files half
        // reaches the handoff, and the handoff draws the manifest for that half
        // and only that half. A text session's content does not exist yet.
        let fileShowing = try XCTUnwrap(direct.components(
            separatedBy: "case let .showingCode(code, expiresAt):").dropFirst().first?
            .components(separatedBy: "case .joining, .connecting").first)
        XCTAssertTrue(fileShowing.contains("mode: .files"),
                      "the file half no longer reaches the shared handoff card")
        let handoff = try XCTUnwrap(direct.components(
            separatedBy: "private func showing(code:").dropFirst().first?
            .components(separatedBy: "private func interruption").first)
        XCTAssertTrue(handoff.contains(
            "if mode == .files { PendingFileList(sessionFiles: file.sessionFiles) }"),
            "the code handoff hides the files it is waiting to send")

        let fileFailure = try XCTUnwrap(direct.components(
            separatedBy: "case let .failed(message):").dropFirst().first?
            .components(separatedBy: "case .minting:").first)
        XCTAssertTrue(fileFailure.contains(
            "PendingFileList(sessionFiles: file.sessionFiles)"),
            "a failed pairing task hides which files failed")

        let session = try XCTUnwrap(all.first { $0.name == "DirectFileSessionView.swift" }?.text)
        let connecting = try XCTUnwrap(session.components(
            separatedBy: "case .joining, .connecting:").dropFirst().first?
            .components(separatedBy: "case let .verifying").first)
        let verifying = try XCTUnwrap(session.components(
            separatedBy: "private func verifying(").dropFirst().first?
            .components(separatedBy: "private func transferring").first)
        for phase in [connecting, verifying] {
            XCTAssertTrue(phase.contains("fileList"),
                          "a connection phase hides the staged file identity")
        }
    }

    func testNearbyFileFailureKeepsTheManifestIdentityUntilBack() throws {
        let session = try XCTUnwrap(try sources().first {
            $0.name == "DirectFileSessionView.swift"
        }?.text)
        let failed = try XCTUnwrap(session.components(
            separatedBy: "case .failed:").dropFirst().first?
            .components(separatedBy: "case .joining").first)
        XCTAssertTrue(failed.contains("fileList"),
                      "Nearby failure hides which files failed")

        let nearby = try XCTUnwrap(try sources().first { $0.name == "NearbyView.swift" }?.text)
        let live = try XCTUnwrap(nearby.components(
            separatedBy: "private var session:").dropFirst().first?
            .components(separatedBy: "// MARK: - shared pieces").first)
        XCTAssertLessThan(try XCTUnwrap(live.range(of: "failureLine(message)")).lowerBound,
                          try XCTUnwrap(live.range(of: "DirectFileSessionView")).lowerBound,
                          "a long file list pushes the failure reason below the fold")
    }

    func testFileCompletionClearsOnlyTheBatchThatWasActuallySent() throws {
        let all = try sources()
        let session = try XCTUnwrap(all.first { $0.name == "DirectFileSessionView.swift" }?.text)
        XCTAssertTrue(session.contains("let onDone: () -> Void"))
        XCTAssertTrue(session.contains("Button(L10n.t(.commonDone), action: onDone)"))

        let direct = try XCTUnwrap(all.first { $0.name == "DirectView.swift" }?.text)
        XCTAssertTrue(direct.contains(
            "DirectFileSessionView(model: file, onDone: finishCompletedFileTransfer)"))
        XCTAssertTrue(direct.contains("if file.received == nil { selection.clear() }"))

        let nearby = try XCTUnwrap(all.first { $0.name == "NearbyView.swift" }?.text)
        XCTAssertTrue(nearby.contains(
            "DirectFileSessionView(model: file, onDone: finishCompletedFileTransfer)"))
        XCTAssertTrue(nearby.contains("if file.received == nil { selection.clear() }"))
        XCTAssertTrue(nearby.contains("if modes.mode == .files, case .failed = file.state"),
                      "a failed outbound batch should return to the roster ready to retry")
        XCTAssertTrue(nearby.contains("if !preservesFailedFiles { selection.clear() }"))
    }

    /// Creating a code removes the start controls while a network request owns
    /// the screen. Both file and text modes must still offer an explicit exit.
    func testPairingMintingCanBeCancelledInBothModes() throws {
        let all = try sources()
        let direct = try XCTUnwrap(all.first { $0.name == "DirectView.swift" }?.text)
        XCTAssertEqual(direct.components(separatedBy:
            "Button(L10n.t(.commonCancel)) { file.cancel() }").count - 1, 1)
        XCTAssertEqual(direct.components(separatedBy:
            "Button(L10n.t(.commonCancel)) { text.reset() }").count - 1, 1)

        let mintingBlocks = direct.components(separatedBy: "case .minting:").dropFirst()
        XCTAssertEqual(mintingBlocks.count, 2)
        for block in mintingBlocks {
            let body = block.components(separatedBy: "case let .showingCode").first ?? ""
            XCTAssertTrue(body.contains(".buttonStyle(.bordered)"))
            XCTAssertTrue(body.contains(".controlSize(.large)"))
        }
    }

    /// A pre-connection Cancel has no transcript to preserve and should not
    /// manufacture a terminal screen that requires a second Done tap.
    func testTextConnectingCancelReturnsDirectlyToThePairingEntry() throws {
        let all = try sources()
        let source = try XCTUnwrap(all.first { $0.name == "DirectTextSessionView.swift" }?.text)
        let connecting = try XCTUnwrap(source.components(
            separatedBy: "case .joining, .connecting:").dropFirst().first?
            .components(separatedBy: "case let .verifying").first)
        XCTAssertTrue(connecting.contains("Button(L10n.t(.commonCancel)) { model.reset() }"))
        XCTAssertFalse(connecting.contains("model.end()"))
    }

    /// Once the entry controls disappear, Cancel or End session is the user's
    /// only way to regain control. It must still look like a task action rather
    /// than an incidental text link, across every active direct-session phase.
    func testActiveDirectSessionsKeepTheirLifecycleActionsDiscoverable() throws {
        let all = try sources()
        let files = try XCTUnwrap(all.first { $0.name == "DirectFileSessionView.swift" }?.text)
        let fileConnecting = try XCTUnwrap(files.components(
            separatedBy: "case .joining, .connecting:").dropFirst().first?
            .components(separatedBy: "case let .verifying").first)
        let fileTransfer = try XCTUnwrap(files.components(
            separatedBy: "private func transferring").dropFirst().first?
            .components(separatedBy: "private var completed").first)
        for phase in [fileConnecting, fileTransfer] {
            XCTAssertTrue(phase.contains(".buttonStyle(.bordered)"))
            XCTAssertTrue(phase.contains(".controlSize(.large)"))
        }
        XCTAssertTrue(fileTransfer.contains("role: .destructive"),
                      "cancelling an active write does not communicate its consequence")

        let text = try XCTUnwrap(all.first { $0.name == "DirectTextSessionView.swift" }?.text)
        let textConnecting = try XCTUnwrap(text.components(
            separatedBy: "case .joining, .connecting:").dropFirst().first?
            .components(separatedBy: "case let .verifying").first)
        let waiting = try XCTUnwrap(text.components(
            separatedBy: "private func waiting(").dropFirst().first?
            .components(separatedBy: "private func incomingRequest").first)
        let open = try XCTUnwrap(text.components(
            separatedBy: "private func session(").dropFirst().first?
            .components(separatedBy: "private var composer").first)
        for phase in [textConnecting, waiting, open] {
            XCTAssertTrue(phase.contains(".buttonStyle(.bordered)"))
            XCTAssertTrue(phase.contains(".controlSize(.large)"))
        }
        for phase in [waiting, open] {
            XCTAssertTrue(phase.contains("role: .destructive"))
        }
    }

    func testTextCodeWaitingCancelReturnsDirectlyToThePairingEntry() throws {
        let all = try sources()
        let source = try XCTUnwrap(all.first { $0.name == "DirectView.swift" }?.text)
        let showing = try XCTUnwrap(source.components(
            separatedBy: "case let .showingCode(code, expiresAt):").dropFirst().dropFirst().first?
            .components(separatedBy: "case .joining, .connecting").first)
        XCTAssertTrue(showing.contains("text.reset()"))
        XCTAssertFalse(showing.contains("text.end()"))
    }

    func testGeneratedCodeCancelIsPresentedAsALargeTaskButton() throws {
        let all = try sources()
        let source = try XCTUnwrap(all.first { $0.name == "DirectView.swift" }?.text)
        let showing = try XCTUnwrap(source.components(
            separatedBy: "private func showing(code:").dropFirst().first?
            .components(separatedBy: "private func interruption").first)
        let cancel = try XCTUnwrap(showing.components(
            separatedBy: "Button(L10n.t(.commonCancel), action: cancel)").dropFirst().first?
            .components(separatedBy: "}").first)
        XCTAssertTrue(cancel.contains(".buttonStyle(.bordered)"))
        XCTAssertTrue(cancel.contains(".controlSize(.large)"))
    }

    func testPairingExpiryIsNamedAsCodeExpiryNotTransferExpiry() throws {
        let source = try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" }?.text)
        let handoff = try XCTUnwrap(source.components(
            separatedBy: "private func showing(code:").dropFirst().first?
            .components(separatedBy: "private func interruption").first)
        XCTAssertTrue(handoff.contains("L10n.t(.pairingCodeExpiryNote)"))
        XCTAssertTrue(handoff.contains(
            ".accessibilityIdentifier(\"pairing-code-expiry-note\")"))
    }

    func testPairingHandoffPreservesTheModeThatCreatedTheCode() throws {
        let source = try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" }?.text)
        XCTAssertTrue(source.contains("showing(code: code, expiresAt: expiresAt, mode: .files,"))
        XCTAssertTrue(source.contains("showing(code: code, expiresAt: expiresAt, mode: .text,"))
        XCTAssertTrue(source.contains("transferPairingJoinURL(code: code, mode: mode)"))
    }

    func testPairingHandoffShowsTheWholeCurrentLink() throws {
        let source = try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" }?.text)
        let link = try XCTUnwrap(source.components(
            separatedBy: "private struct PairingJoinLinkView:").dropFirst().first?
            .components(separatedBy: "/// R3-E:").first)
        XCTAssertTrue(link.contains("Text(url.absoluteString)"))
        XCTAssertTrue(link.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertFalse(link.contains(".lineLimit(1)"),
                       "the capability link is still visually truncated")
        XCTAssertTrue(link.contains(".onChange(of: url) { _ in copied = false }"),
                      "copy feedback can survive onto a replacement link")
    }

    func testStalePairingCreateRoutesToTheAccountRemedy() throws {
        let source = try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" }?.text)
        for boundary in ["private func createAndSend()", "private func createTextSession()"] {
            let action = try XCTUnwrap(source.components(separatedBy: boundary).dropFirst().first?
                .components(separatedBy: "private func").first)
            let staleGate = try XCTUnwrap(action.components(
                separatedBy: "guard case let .allowed(access) = gate else {").dropFirst().first?
                .components(separatedBy: "return").first)
            XCTAssertTrue(staleGate.contains("onOpenAccount()"),
                          "\(boundary) silently swallowed a stale Create activation")
        }
    }

    /// Cold upload recovery locks selection adoption while it reads durable
    /// state. That wait needs the same explicit exit as every other busy phase.
    func testStoredUploadRecoveryCheckCanBeCancelled() throws {
        let all = try sources()
        let source = try XCTUnwrap(all.first { $0.name == "SendView.swift" }?.text)
        let checking = try XCTUnwrap(source.components(
            separatedBy: "case .checkingRecovery:").dropFirst().first?
            .components(separatedBy: "case .preparing:").first)
        XCTAssertTrue(checking.contains("ProgressView { Text(L10n.t(.uploadCheckingRecovery)) }"))
        XCTAssertTrue(checking.contains("Button(L10n.t(.commonCancel)) { upload.cancel() }"))
        XCTAssertTrue(checking.contains(".buttonStyle(.bordered)"))
        XCTAssertTrue(checking.contains(".controlSize(.large)"))
    }

    func testStoredTransferLifecycleActionsStayDiscoverable() throws {
        let all = try sources()
        let send = try XCTUnwrap(all.first { $0.name == "SendView.swift" }?.text)
        let preparing = try XCTUnwrap(send.components(
            separatedBy: "case .preparing:").dropFirst().first?
            .components(separatedBy: "case let .uploading").first)
        let restarting = try XCTUnwrap(send.components(
            separatedBy: "private var restarting:").dropFirst().first?
            .components(separatedBy: "private func resume").first)
        let uploading = try XCTUnwrap(send.components(
            separatedBy: "private func uploading(").dropFirst().first?
            .components(separatedBy: "private func linkReady").first)
        let completed = try XCTUnwrap(send.components(
            separatedBy: "private func linkReady(").dropFirst().first?
            .components(separatedBy: "private func failure").first)
        for phase in [preparing, restarting, uploading] {
            XCTAssertTrue(phase.contains(".buttonStyle(.bordered)"))
            XCTAssertTrue(phase.contains(".controlSize(.large)"))
        }
        let sendAnother = try XCTUnwrap(completed.components(
            separatedBy: "Button(L10n.t(.uploadSendAnother))").dropFirst().first)
        XCTAssertTrue(sendAnother.contains(".buttonStyle(.bordered)"))
        XCTAssertTrue(sendAnother.contains(".controlSize(.large)"))
        XCTAssertTrue(completed.contains("Text(link)"))
        XCTAssertTrue(completed.contains(".fixedSize(horizontal: false, vertical: true)"))
        XCTAssertTrue(completed.contains("UIPasteboard.general.string = link"),
                      "the generated capability has no explicit Copy action")
        XCTAssertTrue(completed.contains("copiedGeneratedLink ? .commonCopied : .commonCopy"),
                      "Copy provides no acknowledgement for the generated link")
        XCTAssertTrue(completed.contains("ShareLink(item: link)"),
                      "Copy replaced rather than supplemented system Share")
        XCTAssertFalse(completed.contains(".lineLimit(1)"),
                       "the stored capability result is visually truncated")

        let receive = try XCTUnwrap(all.first { $0.name == "ReceiveView.swift" }?.text)
        let cancel = try XCTUnwrap(receive.components(
            separatedBy: "private var cancelButton:").dropFirst().first?
            .components(separatedBy: "// MARK: - actions").first)
        XCTAssertTrue(cancel.contains(".buttonStyle(.bordered)"))
        XCTAssertTrue(cancel.contains(".controlSize(.large)"))
    }

    /// Each source's CODE, with whole-line comments dropped.
    ///
    /// Load-bearing, not tidiness: these files explain what they deliberately do
    /// NOT do, so `ReceiveView` says the app never reads `UIPasteboard` and
    /// `RelayiumApp` names the entitlements it has not claimed. Scanning raw text
    /// would fail this guard on the very comments that document the absence it
    /// is checking for.
    ///
    /// Whole-line only — a trailing `//` is not stripped, so a deferred symbol
    /// named in a trailing comment still fails. That is the wanted direction:
    /// this guard may miss nothing, and may only be too strict in a case that is
    /// trivially fixed by moving the comment to its own line.
    private func sources() throws -> [(name: String, text: String)] {
        try sources(under: try iosRoot, atLeast: 12)
    }

    /// The app's own `Info.plist`, read as a plist rather than as text, so what
    /// is asserted is what the app actually declares.
    private func infoPlist() throws -> [String: Any] {
        let data = try Data(contentsOf: try iosRoot.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
    }

    private func sources(under root: URL, atLeast minimum: Int) throws
        -> [(name: String, text: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        // A rename that moved the sources out from under this guard is exactly
        // when it stops protecting anything.
        XCTAssertGreaterThanOrEqual(names.count, minimum,
                                    "found \(names.count) sources at \(root.path)")
        return try names.map { name in
            let raw = try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
            let code = raw
                .components(separatedBy: "\n")
                .filter { line in
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                        && !trimmed.hasPrefix("/*")
                }
                .joined(separator: "\n")
            return (name, code)
        }
    }

    /// One file's code, with its comment lines removed.
    ///
    /// The same stripping `sources(under:atLeast:)` does, for the guards that
    /// address a named file rather than sweeping a tree. It exists because the
    /// alternative bit twice in this very batch: a guard that reads raw text
    /// fails on the doc comment EXPLAINING the rule, which trains the next
    /// writer either to delete the explanation or to weaken the assertion.
    /// `WORKFLOW-LEARNINGS` records the same requirement for the macOS suite.
    private func code(at url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .components(separatedBy: "\n")
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                    && !trimmed.hasPrefix("/*")
            }
            .joined(separator: "\n")
    }

    /// Both roots, because the credential passes through both: the app renders
    /// the session, and `AccountSession`/`ErrorCopy` hold and format it.
    func testNothingInTheAppOrViewModelLayerLogs() throws {
        let scanned = try sources(under: try iosRoot, atLeast: 12)
            + sources(under: try appKitRoot, atLeast: 40)
        for (name, text) in scanned {
            for call in ["print(", "NSLog(", "os_log(", "debugPrint(", "dump("] {
                XCTAssertFalse(text.contains(call),
                               "\(name) contains \(call) — a credential must never reach a log")
            }
        }
    }

    /// **iOS composes a `link/1` for the code-less room, and NOTHING for a
    /// pairing code.**
    ///
    /// This test used to ban every link symbol outright, because iOS composed
    /// none of the protocol at all. That is no longer the boundary: the Nearby
    /// tab now owns a `LinkWorkspaceModel` and renders a unified workspace on
    /// it, so `LinkWorkspaceModel` has left this list — exactly as
    /// `CloudUploadModel` and the two realtime models left `testNoDeferredFeature
    /// IsReferenced` in the slices that shipped them.
    ///
    /// What replaces the ban is not nothing, and it is the harder claim: the
    /// pairing-code half of that model must still be unreachable from this
    /// platform. Every symbol below is part of composing or routing a link
    /// ROOM — the factory, the router, the session, the attempt, the runtime,
    /// and above all `LinkRoomHandle`/`watchPairingCode`, which are how a code
    /// room is opened. iOS reaches its link through
    /// `AppEnvironment.makeLinkWorkspaceModel`'s iOS overload, whose signature
    /// takes no room handle at all, so none of these can appear here without
    /// somebody having deliberately routed around that factory.
    ///
    /// `LINK_PAIRING_ROOM_SUPPORT` is the other half, at the wire, and
    /// `PeerCapabilityRegistryTests` pins it against the constant's own source.
    func testTheiOSTargetNamesNothingThatComposesALinkRoom() throws {
        for (name, text) in try sources(under: try iosRoot, atLeast: 12) {
            for symbol in ["LinkSessionFactory", "LinkRoomRouter",
                           "LinkRoomSession", "LinkSessionAttempt", "LinkSessionRuntime",
                           "LinkPairingRoom", "LinkRoomHandle", "watchPairingCode"] {
                XCTAssertFalse(text.contains(symbol),
                               "\(name) names \(symbol): iOS must compose no link ROOM")
            }
        }
    }

    /// The composition is no longer compiled out, and the file says why rather
    /// than merely no longer saying the old thing.
    ///
    /// This is the exact failure `WORKFLOW-LEARNINGS` records for 2026-08-10:
    /// when a dormant stack becomes reachable, the source comments and test
    /// names claiming it is unreachable survive the transition and give a
    /// stronger conclusion than the executable evidence. So the assertion is
    /// inverted rather than deleted — a re-added `#if os(macOS)` around either
    /// file would now fail here, which is what stops the iOS half being switched
    /// off by a merge that looks like a revert.
    func testTheLinkCompositionIsBuiltOnBothPlatforms() throws {
        let workspace = try code(at: try appKitRoot.appendingPathComponent("LinkWorkspaceModel.swift"))
        XCTAssertFalse(workspace.contains("#if os(macOS)"),
                       "LinkWorkspaceModel is iOS's workspace too and must not be compiled out")

        // The link-aware liveness overload MUST be shared: a link uses neither
        // legacy model, so an iOS link observed by the two-model overload would
        // have its surface released the instant it started.
        let presence = try code(at: try appKitRoot.appendingPathComponent("TransferPresence.swift"))
        XCTAssertFalse(presence.contains("#if os(macOS)"),
                       "the link-aware liveness overload must exist in the iOS build")

        // `AppEnvironment` keeps a platform split, and it is the RIGHT one: the
        // macOS factory takes a pairing-room handle and the iOS one does not.
        let environment = try code(at: try appKitRoot.appendingPathComponent("AppEnvironment.swift"))
        XCTAssertTrue(environment.contains("#if os(macOS)"),
                      "the pairing-room link factory must not exist in an iOS build")
        XCTAssertTrue(environment.contains("connectPairingSocket:"),
                      "the macOS factory must still open the code room it owns")
    }

    /// **The iOS app composes the link exactly once, and hands it to everything
    /// that must know about it.**
    ///
    /// Four wirings, and each has a silent failure mode that no test elsewhere
    /// would catch, because each produces a build that runs:
    ///
    ///  - **the factory** — a second `LinkWorkspaceModel` would be a second
    ///    room observer, and this device would answer one offer twice;
    ///  - **`observeSessions(fileModel:textModel:link:)`** — the two-model
    ///    overload compiles here, and a link observed by it is released the
    ///    instant it starts, because both legacy models read `.idle` for a
    ///    link's whole life;
    ///  - **`shouldAcceptLink`** — without it an unsolicited link is admitted
    ///    with no main-actor arbitration, so a link and a legacy session can own
    ///    the surface at once;
    ///  - **`ForegroundSessionCoordinator(... link:)`** — without it the app
    ///    backgrounds, the room is left, and the user returns to a workspace
    ///    that looks open on a connection that died with the foreground.
    func testTheiOSAppComposesTheLinkOnceAndWiresIt() throws {
        let app = try code(at: try iosRoot.appendingPathComponent("RelayiumApp.swift"))
        XCTAssertEqual(app.components(separatedBy: "AppEnvironment.makeLinkWorkspaceModel").count - 1, 1,
                       "the link must be composed exactly once")
        XCTAssertTrue(app.contains("observeSessions(fileModel: files, textModel: texts, link: unified)"),
                      "the link must be the third liveness source, or its surface is released at once")
        XCTAssertTrue(app.contains("unified.shouldAcceptLink"),
                      "an unsolicited link must be arbitrated on the main actor")
        XCTAssertTrue(app.contains("ForegroundSessionCoordinator(file: files, text: texts, link: unified)"),
                      "the foreground coordinator must own ending the link")
    }

    /// **The link's receive directory is the residency-owned one, read rather
    /// than resolved again.**
    ///
    /// `NearbyResidencyCoordinator` resolves `Documents/Received`, installs it
    /// on `RealtimeSessionModel.saveDirectory`, and refuses to join the room at
    /// all when it cannot — which is what makes "this device is reachable" and
    /// "this device can write" one answer rather than two.
    ///
    /// A link that called `ReceiveDestination` again would compile and would
    /// return the same URL almost always. It would be wrong in exactly the case
    /// the residency check exists for — something in the user's own Files app
    /// occupying the name — where it would write a peer's files into a
    /// destination the receiving card is simultaneously telling the user is
    /// broken. So the app must read the model's property, and must not name the
    /// resolver.
    func testTheLinkReceivesIntoTheResidencyOwnedDirectory() throws {
        let app = try code(at: try iosRoot.appendingPathComponent("RelayiumApp.swift"))
        XCTAssertTrue(app.contains("receiveDirectory: { files.saveDirectory }"),
                      "the link must read the directory residency installed")
        // Not `ReceiveDestination` anywhere in the app file: residency is the
        // one caller, and it lives in RelayiumAppKit.
        XCTAssertFalse(app.contains("ReceiveDestination"),
                       "the app re-resolved the receive destination instead of reading it")
    }

    /// **The Direct tab is not part of this feature, and cannot become part of
    /// it by accident.**
    ///
    /// `link/1` on iOS is the code-less room and nothing else, and the wire says
    /// so through `LINK_PAIRING_ROOM_SUPPORT`. This is the surface half of the
    /// same boundary: the pairing-code screen is handed no link at all, so there
    /// is no object there to connect, to render, or to observe. Without it the
    /// model could be added to that view and would compile, announce nothing,
    /// and quietly give the Direct tab a second session owner that
    /// `TransferPresence` arbitrates but no test describes.
    ///
    /// Pinned as the ROUTING too — `RootView` hands the link to exactly one tab
    /// — because a second `link:` argument is how the first version of this
    /// mistake would actually be written.
    func testThePairingCodeSurfaceIsHandedNoLink() throws {
        for name in ["DirectView.swift", "DirectTextSessionView.swift",
                     "DirectFileSessionView.swift"] {
            let url = try iosRoot.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let view = try code(at: url)
            for symbol in ["LinkWorkspaceModel", "NearbyLinkWorkspaceView",
                           "NearbyConnectPresentation"] {
                XCTAssertFalse(view.contains(symbol),
                               "\(name) names \(symbol): the Direct tab composes no link/1")
            }
        }
        let root = try code(at: try iosRoot.appendingPathComponent("RootView.swift"))
        XCTAssertEqual(root.components(separatedBy: "link: link,").count - 1, 1,
                       "the link is handed to more than one tab")
    }

    /// **One Connect for a link peer, and no Files/Text picker.**
    ///
    /// The picker is meaningless on a connection that carries both at once, and
    /// the decision is a pure function so `swift test` can drive it —
    /// `NearbyConnectPresentationTests` does. What THIS checks is that the view
    /// actually asks it, rather than reimplementing the rule inline where the
    /// two could drift.
    func testTheNearbyTabAsksOneRuleAboutTheModePicker() throws {
        let view = try code(at: try iosRoot.appendingPathComponent("NearbyView.swift"))
        XCTAssertTrue(view.contains("NearbyConnectPresentation.showsModePicker"),
                      "the picker's visibility must come from the shared rule")
        XCTAssertTrue(view.contains("NearbyConnectPresentation.sendChoice"),
                      "the two action sets must be chosen by the shared rule")
        XCTAssertTrue(view.contains("TransferSurfacePresentation.pane"),
                      "which pane is drawn must come from the rule both platforms follow")
    }

    /// **iOS did not copy the macOS workspace.**
    ///
    /// `NSOpenPanel` is unavailable on iOS so a copy would not compile, but the
    /// rest of `TransferLinkPane` would: a `TextEditor` bounded for a 560pt
    /// window, ⌘Return, and two separate file verbs because a panel has to be
    /// told which it opens. Every one of those is the wrong answer on a phone,
    /// and each would compile silently.
    func testTheiOSWorkspaceUsesPlatformControlsRatherThanTheMacOnes() throws {
        let view = try code(at: try iosRoot.appendingPathComponent("NearbyLinkWorkspaceView.swift"))
        for macOnly in ["NSOpenPanel", "TextEditor", "keyboardShortcut",
                        "chooseForLinkSend", "Metrics.readingMeasure"] {
            XCTAssertFalse(view.contains(macOnly),
                           "the iOS workspace carries \(macOnly), which is a macOS answer")
        }
        XCTAssertTrue(view.contains("fileImporter"),
                      "iOS chooses files through the document browser")
        XCTAssertTrue(view.contains("axis: .vertical"),
                      "the composer must be the same growing field the Direct tab uses")
        // And it renders the SHARED words rather than a second switch over the
        // same exhaustive enums.
        XCTAssertTrue(view.contains("LinkEndingCopy.text(for:"),
                      "the ending sentence must be the shared one")
        XCTAssertTrue(view.contains("LinkBatchCopy.text(for:"),
                      "the batch state words must be the shared ones")
    }

    func testNoDeferredFeatureIsReferenced() throws {
        // A later slice owns this. A reference means either a dead control or a
        // capability claimed before it works.
        //
        // `CloudUploadModel` LEFT this list in R3-C, deliberately: this is the
        // slice that ships it. `SignInWithAppleButton` and
        // `AuthenticationServices` left it in THIS slice, for the same reason —
        // the app now presents the real system control. What replaces the ban
        // is not nothing: `testTheAppleButtonIsTheSystemControlWiredToTheSession`
        // and `testOnlyTheFormImportsAuthenticationServices` below say what the
        // Apple surface must be, which is the harder claim. Everything else stays.
        //
        // `AccountManagementModel` LEFT this list in R3-D, for the same reason
        // `CloudUploadModel` left it in R3-C: this is the slice that renders it.
        // What replaces the ban is not nothing — the positive wiring invariants
        // further down say the model is app-scoped, built from the ONE key
        // store, injected once, and reachable only from the ready account
        // surface, which is the harder claim.
        //
        // `RealtimeSessionModel` and `RealtimeTextSessionModel` LEFT this list in
        // R3-E, for the same reason `CloudUploadModel` left it in R3-C: this is
        // the slice that renders them. What replaces the ban is the whole R3-E
        // section below — app-scoped construction through the code-only
        // factories, a gated create beside an ungated join, a resolved receive
        // destination, and a foreground-only lifecycle. Those are harder claims
        // than an absence.
        //
        // `UIPasteboard` also left it, and it is the one that needed the most
        // care: R3-E has per-message Copy, which is a pasteboard WRITE the user
        // asked for. The ban is replaced by
        // `testThePasteboardIsWrittenOnlyInsideAnExplicitCopyActionAndNeverRead`,
        // which allows exactly that one write and still forbids every read.
        //
        // **The nearby half LEFT this list in R3-F, and the reason it was on it
        // was wrong.** It was banned as needing "a local-network entitlement",
        // which `LanDiscoveryModel` does not: it is not Bonjour, does not scan,
        // and joins the hub's code-less room, which the server keys by the
        // public IP it observes. What it needs is ordinary internet access. So
        // `LanDiscoveryModel`, `NearbyReceiveModel`, `InboundRoom`, the two
        // factories and `connectNearby` are now what this slice ships, and what
        // replaces the ban is the whole R3-F section below — one room socket,
        // a destination installed before residency, an explicit peer choice and
        // a single presenting surface. `NSLocalNetworkUsageDescription`,
        // Bonjour and the multicast entitlement stay banned by
        // `testTheNearbyTabAddsNoNetworkCapability`, which is the accurate
        // claim rather than the inherited one.
        //
        // `acceptNearby` and `NearbyError` stay: answering an offer is
        // `NearbyReceiveModel`'s, on the socket the offer arrived on, and an
        // iOS view reaching for either would be a second admission path beside
        // the arbitrated one.
        //
        // **`onOpenURL` LEFT this list with the Universal Link slice**, for the
        // same reason `CloudUploadModel` left it in R3-C: this is the slice that
        // ships it. It was banned because nothing could deliver a URL — no
        // Associated Domains, no registered scheme — so the handler would have
        // read like universal-link support that did not exist. Both halves now
        // do: `Relayium.entitlements` claims `applinks:relayium.com` and the
        // site's association file names this app's ID for `/d/*` and
        // `/cross-network`. What replaces the ban is not nothing — it is
        // `testTheUniversalLinkHandOffIsWiredOnceAndDecidesNothingInTheViewLayer`
        // and `testTheLinkPathNeitherJoinsNorDownloads` below, plus
        // `AppDeepLinkCoordinatorTests` driving the policy against real models,
        // which are harder claims than an absence. A custom URL scheme stays
        // banned by `testTheLinkHandOffAcceptsOnlyVerifiedUniversalLinks`,
        // because a scheme is unauthenticated and a link handoff is a trust
        // boundary.
        //
        // **The StoreKit names LEFT this list when iOS subscriptions became
        // reachable.** The app now owns the shared purchase model and links the
        // isolated adapter, so retaining the old absence check would reject the
        // feature this slice deliberately ships.
        //
        // What replaces it is narrower in what it names and STRONGER in what it
        // covers. This list only ever read the iOS app's own sources, so it
        // could never have seen the edit that actually matters — `RelayiumKit`
        // or `RelayiumAppKit`, which both apps link, acquiring the dependency
        // and dragging StoreKit into every binary regardless of what any view
        // said. `StoreKitLinkageTests` reads the whole tree and both Xcode
        // projects instead. The positive iOS ownership and observation wiring
        // is asserted immediately below this test.
        let deferred = [
            "BrowserLoginModel",
            "acceptNearby", "NearbyError",
            "UNUserNotificationCenter",
            "NSWorkspace",
        ]
        // This is the wrong way to do THIS slice's work. Each of these compiles,
        // reads plausibly, and breaks a documented invariant:
        //
        //  - `URLSessionConfiguration.background` would claim a resume this app
        //    does not have and the copy explicitly denies;
        //  - `DataRepresentation` / `Data.self` would load a picked video into
        //    memory instead of copying a file;
        //  - `startAccessingSecurityScopedResource` in a view would put the
        //    start/stop balance somewhere no test can count it, and somewhere
        //    SwiftUI decides the lifetime;
        //  - `SelectionStore` would have the view read the nested store rather
        //    than the model's forwarded state — which does not publish through a
        //    stored property, so the view would silently stop redrawing;
        //  - `TaskLocal` would be the ambient import context the two-step photo
        //    flow exists to avoid.
        let wrongApproach = [
            "URLSessionConfiguration.background", "DataRepresentation", "Data.self",
            "startAccessingSecurityScopedResource", "SelectionStore", "TaskLocal",
        ]
        for (name, text) in try sources() {
            for symbol in deferred + wrongApproach {
                XCTAssertFalse(text.contains(symbol), "\(name) references \(symbol)")
            }
        }
    }

    func testTheIOSSubscriptionModelIsAppScopedAndObservedOnce() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" }?.text)
        let account = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" }?.text)
        let all = try sources().map(\.text).joined(separator: "\n")

        XCTAssertEqual(app.components(separatedBy: "private let appleSubscription:").count - 1, 1)
        XCTAssertEqual(app.components(separatedBy: ".environment(\\.appleSubscription,").count - 1, 1)
        XCTAssertEqual(all.components(separatedBy: "startObservingUpdates()").count - 1, 1,
                       "StoreKit update observation must have one scene-root owner")
        XCTAssertTrue(account.contains("AppleSubscriptionCard("))
        XCTAssertTrue(account.contains("IOSAppleSubscriptions.channel.offersInAppPurchase"),
                      "the iOS purchase surface bypasses its distribution policy")
        XCTAssertTrue(account.contains("IOSAppleSubscriptions.channel.showsWebPlanHandoff"),
                      "the iOS web hand-off bypasses its distribution policy")
    }

    /// The eight keys whose wording still names a platform, each grouped with
    /// the slice that will first render it.
    ///
    /// Five left this list in R3-C because this slice renders them, so they were
    /// corrected in place in all nine catalogs instead: `upload.keyKept`,
    /// `error.storedKey.badId.save`, `error.storedKey.badKey.save`,
    /// `error.plaintext.tooManyOpenFiles`, and `error.storedKey.keychain.save`
    /// — the last of which was never on this list at all, which is the miscount
    /// recorded in this file's header.
    ///
    /// `error.storedLinkKey.invalidKey` moved from R3-C to R3-D on reachability
    /// grounds rather than by inheritance from the roadmap:
    /// `ErrorCopy.storedLinkKeyMessage` routes `.invalidKey` to
    /// `errorStoredKeyBadKeySave` on `.save` and to this key only on `.read`,
    /// and sending never reads a stored key.
    ///
    /// Guarded by NAME, so it cannot see the ones `ErrorCopy` reaches
    /// indirectly — which is why `error.manifest.duplicatePath`, the one an iOS
    /// receive can already hit, was corrected in the catalogs instead of listed
    /// here, and why the five above had to be corrected the same way.
    ///
    /// A sixth left this list in the account-deletion slice, by the same route:
    /// `account.bearerInvalid` is what `AccountSession` renders when a deletion
    /// request comes back 401, and `AccountSession` runs on both platforms — so
    /// listing it here would have banned a sentence the shared layer now
    /// produces anyway. It was corrected in place in all nine catalogs instead
    /// ("this Mac" → the language's own device noun), and
    /// `LocalizedCopyTests.testTheRevokedCredentialSentenceNamesNoPlatform`
    /// carries the claim from here on — which is the stronger guard, since it
    /// reads the copy rather than the call sites.
    ///
    /// **R3-D takes eight more off this list by the same route.** The device
    /// list, the stored-file list and the link rebuild are what this slice
    /// renders, so `account.thisMac`, `account.revokeThisMac`,
    /// `account.keyNotOnThisMac`, `account.keyLookupFailed`,
    /// `account.keyCleanupWarning`, `error.storedLinkKey.invalidKey`,
    /// `error.storedKey.keychain.read` and `error.storedKey.keychain.remove`
    /// were corrected in place in all nine catalogs to wording that is true on
    /// both platforms. `LocalizedCopyTests`'
    /// `testNothingTheAccountManagementSurfaceRendersNamesAPlatform` and
    /// `testEverySentenceAboutThisDeviceStillNamesADevice` carry that claim from
    /// here on, and they carry the half a ban cannot: that each sentence still
    /// names the device it is about instead of merely dropping the noun.
    ///
    /// The two remaining keys are notifications, which this slice deliberately
    /// does not add — a foreground inbound session navigates in app instead.
    /// The shared sign-in-keychain error is reachable indirectly through
    /// `AccountSession`, so it is guarded by rendered copy in
    /// `LocalizedCopyTests` rather than falsely listed as unreachable here.
    func testNoPlatformNamingCopyKeyIsRenderedOnIOS() throws {
        // **R3-E takes a ninth off by the same route.** This slice renders the
        // advanced-verification setting, so `verify.explainEncryption` — which
        // said keys are generated *on this Mac* — was corrected in place in all
        // nine catalogs to the device noun each language uses. It is the one
        // sentence on that setting that states what the preference does NOT
        // change, so weakening it was not an option; only the platform noun
        // moved. `LocalizedCopyTests.testTheVerificationExplanationNamesNoPlatformAndKeepsItsEncryptionClaims`
        // carries the claim from here on, and it carries the half a ban cannot:
        // that the four encryption facts are all still in the sentence.
        // **R3-F takes four more off by the same route.** This slice renders the
        // nearby surface, so `nearby.explain`, `nearby.pausedBody`,
        // `nearby.acceptanceNote` and `error.nearby.noAnswer` — all of which
        // said *this Mac* — were corrected in place in all nine catalogs to the
        // device noun each language uses.
        // `LocalizedCopyTests.testNothingTheNearbySurfaceRendersNamesAPlatform`
        // and `testTheCorrectedNearbySentencesStillNameADevice` carry the claim
        // from here on, together with the half a ban cannot make: that each
        // sentence still names the device it is about.
        //
        let platformNaming: [L10nKey] = [
            .notifyIncomingFiles, .notifyIncomingText,
        ]
        XCTAssertEqual(platformNaming.count, 2)
        for (name, text) in try sources() {
            for key in platformNaming {
                XCTAssertFalse(text.contains(".\(key)"),
                               "\(name) renders \(key.rawValue), whose wording names a platform")
            }
        }
    }

    /// Launch restore is wired, and wired in ONE place — the shell — so a
    /// second `.task` cannot start a competing cold start from inside a tab.
    ///
    /// This says nothing about how often SwiftUI runs that task, which is not
    /// something a source scan or an `Info.plist` can decide. `AccountSession`
    /// is App-scoped and `restore()` is re-entrant; `AccountSessionTests` owns
    /// proving that, and this owns proving the feature exists at all.
    func testLaunchRestoreIsWiredExactlyOnceInTheShell() throws {
        let all = try sources()
        let callSites = all
            .map { $0.text.components(separatedBy: "session.restore()").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(callSites, 1, "launch restore must have exactly one call site")
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("session.restore()"),
                      "the one call site belongs in the shell, not in a tab")
    }

    /// The receive flow must not acquire an account dependency: it is the one
    /// thing this app could already do, and it works signed out.
    ///
    /// `AccountManagementModel` joins the ban in R3-D. It is injected into the
    /// environment at the app scope, which puts it structurally within reach of
    /// every tab — and an `@EnvironmentObject` the receive tab merely DECLARED
    /// would crash it outright in any build where the object was not installed.
    /// Anonymous receive stays independent of the account by not naming it.
    func testTheReceiveFlowIsIndependentOfTheSession() throws {
        let all = try sources()
        let receive = try XCTUnwrap(all.first { $0.name == "ReceiveView.swift" })
        for symbol in ["AccountSession", "bearerToken", "AccountManagementModel",
                       "AccountScope"] {
            XCTAssertFalse(receive.text.contains(symbol),
                           "ReceiveView must not depend on \(symbol)")
        }
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertFalse(root.text.contains("session.state"),
                       "the shell must not switch on session state — that would gate the receive tab")
    }

    func testIdleReceiveExplainsTheLinkPrivacyAndAnonymousEntryPoint() throws {
        let receive = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" })
        let idleStart = try XCTUnwrap(receive.text.range(of: "case .idle:"))
        let resolvingStart = try XCTUnwrap(receive.text.range(of: "case .resolving:"))
        let idle = receive.text[idleStart.lowerBound..<resolvingStart.lowerBound]
        XCTAssertTrue(idle.contains("L10n.t(.downloadIdleHint)"),
                      "an empty field does not explain what a Relayium link protects")
        XCTAssertTrue(idle.contains("L10n.t(.downloadNoAccountNeeded)"),
                      "the anonymous receive capability is invisible on its own tab")
        XCTAssertFalse(idle.contains("EmptyView()"),
                       "the first-run receive state must not be a blank remainder")
    }

    /// A finished stored receive remains one inspectable/shareable task until
    /// Done. The old link field must not invite a replacement over that result,
    /// and Done must go through the shared model boundary rather than mutating
    /// view state into a platform-specific lifecycle.
    func testStoredReceiveCompletionRequiresDoneBeforeAnotherLink() throws {
        let receive = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" })
        XCTAssertTrue(receive.text.contains("if !model.isComplete"),
                      "the old link field remains live over a completed result")
        let doneStart = try XCTUnwrap(receive.text.range(of: "private func done"))
        let failureStart = try XCTUnwrap(receive.text.range(of: "private func failure"))
        let done = receive.text[doneStart.lowerBound..<failureStart.lowerBound]
        XCTAssertTrue(done.contains("L10n.t(.commonDone)"))
        XCTAssertTrue(done.contains("model.dismissResult()"))
        XCTAssertTrue(done.contains("ShareLink(items: payload.dragURLs)"))
    }

    /// The one deliberate pasteboard write must acknowledge completion on its
    /// own row and release that feedback with the history. Store only the id;
    /// duplicating the body in SwiftUI state would outlive the model's clear.
    func testTextCopyAcknowledgesTheExactMessageWithoutRetainingPlaintext() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "DirectTextSessionView.swift" })
        XCTAssertTrue(view.text.contains("@State private var copiedMessageID: Int?"))
        XCTAssertTrue(view.text.contains("copiedMessageID = message.id"))
        XCTAssertTrue(view.text.contains(
            "copiedMessageID == message.id ? .commonCopied : .commonCopy"))
        XCTAssertTrue(view.text.contains(
            "!history.contains(where: { $0.id == copiedMessageID })"))
        XCTAssertFalse(view.text.contains("@State private var copiedMessage:"),
                       "the view retains a second copy of ephemeral plaintext")
    }

    func testEndingAnOpenTextSessionCannotSilentlyDiscardADraft() throws {
        let source = try XCTUnwrap(try sources().first {
            $0.name == "DirectTextSessionView.swift"
        }?.text)
        XCTAssertTrue(source.contains("@State private var confirmingDraftDiscard = false"))
        XCTAssertTrue(source.contains("if model.draft.isEmpty"))
        XCTAssertEqual(source.components(separatedBy:
            "Button(L10n.t(.commonEndSession), role: .destructive) { endOrConfirmDraftDiscard() }")
            .count - 1, 2,
            "both waiting and open must use the protected action")
        XCTAssertEqual(source.components(separatedBy: "model.discardDraftAndEnd()").count - 1, 1,
                       "only the confirmed destructive action may discard the draft")
        XCTAssertTrue(source.contains(
            ".confirmationDialog(\n            L10n.t(.textDiscardDraftConfirmTitle)"),
            "the confirmation must decorate the whole session view, not an inactive state branch")
        XCTAssertTrue(source.contains("L10n.t(.textDiscardDraftConfirmTitle)"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardDraftConfirmBody)"))
        XCTAssertTrue(source.contains("terminalMessage\n                retainedDraft"))
        XCTAssertTrue(source.contains("Text(model.draft)"))
        XCTAssertTrue(source.contains(".textSelection(.enabled)"))
        XCTAssertTrue(source.contains("@State private var copiedDraft = false"))
        XCTAssertTrue(source.contains("copyText(model.draft)"))
        XCTAssertTrue(source.contains("copiedDraft ? .commonCopied : .commonCopy"))
    }

    func testClearingTheOnlyLocalTextHistoryRequiresDestructiveConfirmation() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "DirectTextSessionView.swift" })
        XCTAssertEqual(view.text.components(separatedBy: "confirmingHistoryClear = true").count - 1, 2)
        XCTAssertEqual(view.text.components(separatedBy: "model.clearHistory()").count - 1, 1,
                       "history may only be erased by the confirmation action")
        XCTAssertTrue(view.text.contains(
            "Button(L10n.t(.textClearHistory), role: .destructive) { model.clearHistory() }"))
        XCTAssertTrue(view.text.contains("L10n.t(.textClearHistoryConfirmTitle)"))
        XCTAssertTrue(view.text.contains("L10n.t(.textClearHistoryConfirmBody)"))
    }

    func testRealtimeFileDetailsSurviveTransferAndCompletion() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "DirectFileSessionView.swift" })
        XCTAssertGreaterThanOrEqual(view.text.components(separatedBy: "fileList").count - 1, 3,
                                    "the manifest must render while active and after completion")
        XCTAssertTrue(view.text.contains("model.sessionFiles"))
        XCTAssertTrue(view.text.contains("L10n.bytes(Int64(file.size))"),
                      "file identity without size does not meet the send confirmation standard")
        XCTAssertTrue(view.text.contains(
            "FileTransferCompletionPresentation.title(received: model.received != nil)"),
            "completion does not tell the user whether files were sent or received")
    }

    /// A failure a second tap would fix must offer that tap.
    ///
    /// This view rendered a sentence and nothing else for every failure,
    /// including a dropped connection — leaving the user to re-derive that
    /// re-opening the link is what repeats the work, and no affordance at all
    /// once the transfer itself had started. The decision is the shared model's
    /// (`CloudDownloadRecoveryTests`), so what belongs here is the same
    /// conditional the macOS pane renders, from the same API, and nothing that
    /// reads a message or a status to second-guess it.
    func testTheReceiveViewOffersRetryOnlyWhereTheModelSaysItHelps() throws {
        let receive = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" })
        XCTAssertTrue(receive.text.contains("model.canRetry"),
                      "the retry affordance must be conditional on the model's recovery")
        XCTAssertTrue(receive.text.contains("model.retry()"),
                      "the retry must go through the model's guarded entry point")
        XCTAssertTrue(receive.text.contains(".commonTryAgain"),
                      "both platforms render the same shared label")
    }

    /// One call site is what keeps the typed email and password alive across
    /// .loggedOut → .authenticating → .failed.
    func testTheSignInFormHasExactlyOneCallSite() throws {
        let uses = try sources()
            .filter { $0.name != "SignInView.swift" }
            .map { $0.text.components(separatedBy: "SignInView(").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(uses, 1,
                       "a second call site would give the form a second structural identity")
    }

    // MARK: - registration happens in the app

    /// The form creates the account itself.
    ///
    /// It used to open relayium.com, and the whole point of this slice is that
    /// it no longer does: `AppEnvironment.accountWebURL` is the "just send them
    /// to the website" hand-off, and no iOS surface may reach for it now that
    /// signing in, creating an account and asking for another verification email
    /// all happen here.
    ///
    /// Two hand-offs survive and are deliberately NOT banned: `plansWebURL`
    /// (billing, which stays on the web) and `reactivateWebURL` (a frozen
    /// account cannot sign in, so the token in that link is the only way back).
    func testNoIOSSurfaceOpensTheWebsiteForAccountWork() throws {
        for (name, text) in try sources() {
            XCTAssertFalse(text.contains("accountWebURL"),
                           "\(name) sends the user to the website for account work")
            XCTAssertFalse(text.contains("productionBaseURL"),
                           "\(name) opens relayium.com directly")
        }
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("session.register(email:"),
                      "the form must create the account through the session, in the app")
        XCTAssertTrue(form.text.contains("mode == .register ? .emailAddress : .username"),
                      "registration should expose an email field while sign-in stays a credential username")
        for webbish in ["openURL", "UIApplication.shared.open", "SFSafariViewController"] {
            XCTAssertFalse(form.text.contains(webbish),
                           "the sign-in/create form must not open anything: \(webbish)")
        }
    }

    /// The mode lives in the form and nowhere else.
    ///
    /// A second holder — a tab, the shell, a router — would be a second source
    /// of truth for which half is showing, and the one SwiftUI would win with is
    /// whichever rebuilt last. That is the same failure the single call site
    /// above exists to prevent, one level up.
    func testOnlyTheFormOwnsWhichHalfIsShowing() throws {
        for (name, text) in try sources() where name != "SignInView.swift" {
            XCTAssertFalse(text.contains("AuthMode"), "\(name) must not decide the form's mode")
        }
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("@State private var mode: AuthMode"),
                      "the mode is the form's own state")
    }

    /// The check-email screen can act and can leave.
    ///
    /// It is the state a fresh registration lands in, and before this slice its
    /// only action was a link to relayium.com. Both controls are one `Button`
    /// each — exactly the kind of wiring a later re-layout drops silently.
    func testTheCheckEmailScreenCanResendAndGoBack() throws {
        let tab = try XCTUnwrap(try sources().first { $0.name == "AccountTab.swift" })
        XCTAssertTrue(tab.text.contains("session.resendVerification(email: email)"),
                      "the check-email screen must be able to ask for another email")
        XCTAssertTrue(tab.text.contains("L10n.t(.contentBackToSignIn)"),
                      "and must offer the way back, which is a sign-out")
        XCTAssertTrue(tab.text.contains("if isResending {"),
                      "the resend button must be replaced while a request is in flight, "
                      + "so a second press cannot start a second request")
    }

    /// The signed-in account can end itself, in the app, in two steps.
    ///
    /// Same claim as `MacSurfaceGuardTests`'s, on the surface `AccountTab`
    /// renders for `.ready` — and each clause is a way it could look finished
    /// and not be: a button wired straight to the session would be a one-tap
    /// account deletion, an `openURL` would be the browser hand-off this slice
    /// exists to replace, and a sign-out on success would assert a deletion the
    /// server has not performed and take away the credential the user needs if
    /// they change their mind before opening the link.
    func testTheAccountSurfaceCanEndTheAccountNativelyAndOnlyAfterConfirming() throws {
        let all = try sources()
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains(
            "Button(L10n.t(.accountDeleteAccount), role: .destructive)"),
            "the delete control must carry the destructive role")
        XCTAssertTrue(summary.text.contains("confirmingAccountDeletion = true"),
                      "and must open a confirmation rather than act")
        XCTAssertTrue(summary.text.contains("confirmationDialog("),
                      "the confirmation must be the system's, not a hand-drawn sheet")
        XCTAssertTrue(summary.text.contains(
            "Button(L10n.t(.accountDeleteAccountConfirmAction), role: .destructive)"),
            "the confirmation's action is the destructive one")
        XCTAssertTrue(summary.text.contains("session.requestAccountDeletion()"),
                      "the request must go through the session")

        // Exactly one call site across the whole app: a second would be one
        // that skipped the confirmation.
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "session.requestAccountDeletion()").count - 1 }
                          .reduce(0, +), 1)

        guard let confirmAction = summary.text.range(of: ".accountDeleteAccountConfirmAction"),
              let requests = summary.text.range(of: "session.requestAccountDeletion()") else {
            return XCTFail("AccountSummaryView no longer has the two-step delete")
        }
        XCTAssertTrue(confirmAction.upperBound < requests.lowerBound,
                      "the request must sit inside the confirmation's destructive button")

        // No hand-off to the website, and no sign-out on the way.
        XCTAssertFalse(summary.text.contains("openURL(AppEnvironment.accountWebURL"),
                       "account deletion must not leave the app")
        // Zero, now that both sign-out paths belong to the coordinator. A
        // deletion request that ended the session would assert a deletion the
        // server has not performed and take away the credential the user needs
        // if they change their mind before opening the emailed link.
        XCTAssertEqual(summary.text.components(separatedBy: "session.logOut()").count - 1, 0,
                       "requesting a deletion must not sign the user out")
    }

    // MARK: - native Sign in with Apple

    /// The Apple control is the SYSTEM one, and its result goes to the session.
    ///
    /// Each clause is a way the feature could look finished and not be: a
    /// custom-drawn button (a guideline violation and an impersonation), a
    /// request without the nonce (nothing binds the token to this attempt), a
    /// request without the scopes (a first authorization that cannot create an
    /// account), and a completion that never reaches `logInWithApple` (a button
    /// that dismisses a sheet and does nothing).
    func testTheAppleButtonIsTheSystemControlWiredToTheSession() throws {
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("SignInWithAppleButton("),
                      "the Apple control must be the system button, not a lookalike")
        XCTAssertTrue(form.text.contains("mode == .register ? .signUp : .signIn"),
                      "the system button's label must follow the form's mode")
        XCTAssertTrue(form.text.contains("request.nonce = attempt.nonce"),
                      "the request must carry this attempt's nonce")
        XCTAssertTrue(form.text.contains("request.state = attempt.state"),
                      "the request must carry an opaque attempt identity")
        XCTAssertTrue(form.text.contains("request.requestedScopes = [.fullName, .email]"),
                      "a first authorization needs the name and email Apple only sends once")
        XCTAssertTrue(form.text.contains("session.logInWithApple(idToken:"),
                      "the credential must be exchanged through the session")
        // The nonce belongs to ONE attempt: consumed on completion, and a
        // completion with nothing pending is refused rather than sent with a
        // freshly minted nonce the token could never match.
        XCTAssertTrue(form.text.contains("guard let attempt = appleAttempt else { return }"),
                      "a stale or superseded completion must be refused")
        XCTAssertTrue(form.text.contains("attempt.matches(returnedState: credential.state)"),
                      "a completion must belong to the attempt whose nonce is still held")
        XCTAssertTrue(form.text.contains("appleAttempt = nil"),
                      "the attempt must be consumed, so one authorization cannot land twice")
        // Cancelling asks for nothing to happen — including no error sentence.
        XCTAssertTrue(form.text.contains("== .canceled { return }"),
                      "a user cancellation must be silent")
    }

    /// `AuthenticationServices` belongs to the form and nowhere else.
    ///
    /// A second importer would be a second place an Apple authorization can
    /// start, and the nonce that binds one attempt is `SignInView`'s own state:
    /// an authorization begun anywhere else could not be checked against it.
    func testOnlyTheFormImportsAuthenticationServices() throws {
        for (name, text) in try sources() where name != "SignInView.swift" {
            for symbol in ["AuthenticationServices", "SignInWithAppleButton",
                           "ASAuthorizationAppleID", "ASAuthorizationController"] {
                XCTAssertFalse(text.contains(symbol), "\(name) starts its own Apple authorization: \(symbol)")
            }
        }
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" })
        XCTAssertTrue(form.text.contains("import AuthenticationServices"))
    }

    /// Two entitlements, and each is one this app earned.
    ///
    /// Empty used to be the claim, then exactly `applesignin` — because the app
    /// presents an `ASAuthorizationAppleIDRequest`. `associated-domains` is the
    /// second and lands by the same rule: the app now ROUTES the two link shapes
    /// relayium.com serves, rather than claiming a capability with nothing
    /// behind it. Everything else is still absent, because every other
    /// capability belongs to a feature that does not exist yet. The nil keychain
    /// access group is the same decision from the other side: the bearer lives
    /// in this app's own default group.
    ///
    /// The domain list is asserted exactly. `applinks:` is what `onOpenURL`
    /// needs; `webcredentials:` would be a password-AutoFill association this
    /// app has no field for, and `activitycontinuation:` would be Handoff, which
    /// it does not do. A wildcard (`*.relayium.com`) would widen the trust
    /// boundary to every subdomain, including ones the service may later point
    /// somewhere else.
    func testTheEntitlementsFileClaimsOnlyAppleSignInAndAppLinks() throws {
        let data = try Data(contentsOf: try iosRoot.appendingPathComponent("Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertEqual(plist.keys.sorted(),
                       ["com.apple.developer.applesignin",
                        "com.apple.developer.associated-domains",
                        "com.apple.security.application-groups"],
                       "iOS claims a capability it does not use: \(plist.keys.sorted())")
        XCTAssertEqual(plist["com.apple.developer.applesignin"] as? [String], ["Default"])
        XCTAssertEqual(plist["com.apple.developer.associated-domains"] as? [String],
                       ["applinks:relayium.com"],
                       "the app claims a domain or a service beyond link routing")
        // The share extension's group, and the exact identifier the shared
        // package resolves. A mismatch here is the failure that looks like
        // everything working: the sheet stages a draft into one container and
        // the app lists an empty one.
        // `iOSIdentifier`, not `identifier`. The package resolves `identifier`
        // from the platform it is COMPILED for, and this suite compiles for
        // macOS — so comparing an iOS entitlement against it would assert the
        // wrong platform's group and pass only while the two strings happened to
        // be equal, which they no longer are.
        XCTAssertEqual(plist["com.apple.security.application-groups"] as? [String],
                       [AppGroup.iOSIdentifier])
        XCTAssertEqual(AppGroup.iOSIdentifier, "group.com.relayium.app")
        XCTAssertNil(plist["keychain-access-groups"],
                     "the bearer lives in this app's own default keychain group")
    }

    // MARK: - the share extension is a second TARGET, and a second process

    private var shareRoot: URL {
        get throws { try RepoRoot.directory("apps/ios/RelayiumShare") }
    }

    private func shareSources() throws -> [(name: String, text: String)] {
        try sources(under: try shareRoot, atLeast: 2)
    }

    /// The app files the extension's Sources phase also compiles.
    ///
    /// Phase C gave the share sheet the same card, message and spacing roles the
    /// five tabs use, and there are exactly two ways to do that: copy them into
    /// this target, or compile the one definition twice. Copying is what the
    /// component layer exists to stop — the Mac's audit found two hand-rolled
    /// fills that were equal only by coincidence — so the project adds these
    /// three files to the appex's own Sources phase instead.
    ///
    /// Three, and no more. `PathRail` and `EmptyStateView` are deliberately
    /// absent: the rail's stops come from `PathRailPresentation`, which lives in
    /// `RelayiumAppKit` and would drag the transport stack in behind it, and
    /// this sheet has no empty list.
    private let sharedComponentSources = ["Components/DesignTokens.swift",
                                          "Components/InlineMessage.swift",
                                          "Components/SectionCard.swift"]

    /// Everything the `.appex` COMPILES: its own directory plus those three.
    ///
    /// The absence guards below read this rather than `shareSources()`, because
    /// a symbol reaching the extension through a shared file is in the extension
    /// exactly as much as one written here — and it is the easier of the two to
    /// add without noticing, since the file it would be added to is an app file.
    private func extensionCompiledSources() throws -> [(name: String, text: String)] {
        let shared = try sources().filter { sharedComponentSources.contains($0.name) }
        XCTAssertEqual(shared.map(\.name), sharedComponentSources,
                       "a shared component the extension compiles is not where it was")
        return try shareSources() + shared
    }

    /// The extension's entitlements are exactly one, and it is the App Group.
    ///
    /// Each absence below is one this extension's whole safety argument rests
    /// on. A keychain group would put the user's bearer one API call away from a
    /// process whose entire claim is that it cannot reach it. Associated domains
    /// would let this target be launched for a link it has no screen for. Apple
    /// Sign-In would be a sign-in flow inside somebody else's share sheet.
    func testTheExtensionClaimsOnlyTheAppGroup() throws {
        let data = try Data(contentsOf: try shareRoot.appendingPathComponent("RelayiumShare.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertEqual(plist.keys.sorted(), ["com.apple.security.application-groups"],
                       "the extension claims a capability it does not use: \(plist.keys.sorted())")
        XCTAssertEqual(plist["com.apple.security.application-groups"] as? [String],
                       [AppGroup.iOSIdentifier],
                       "the extension must share exactly the app's one group")
        for absent in ["keychain-access-groups",
                       "com.apple.developer.applesignin",
                       "com.apple.developer.associated-domains",
                       "com.apple.developer.networking.wifi-info"] {
            XCTAssertNil(plist[absent], "the extension claims \(absent)")
        }
    }

    /// The extension cannot upload, cannot authenticate and cannot encrypt.
    ///
    /// A source scan, because these are ABSENCES and an absence has no runtime
    /// to observe. Each symbol is one line away from being true: the extension
    /// links `RelayiumShareKit`, so none of these types is even in scope — which
    /// is the structural half — and this is the half that notices somebody
    /// widening the link.
    func testTheExtensionContainsNoNetworkAccountOrKeyCode() throws {
        let forbidden = [
            // Network, in every spelling that reaches one.
            "URLSession", "URLRequest", "NWConnection", "Network", "WebSocket",
            "CloudClient", "AccountClient", "CloudUploader", "SignalingClient",
            // Credentials.
            "AccountSession", "bearerToken", "TokenStore", "Keychain", "SecItem",
            // Keys and ciphertext. The extension stages PLAINTEXT and stops;
            // generating a key here would mean a second place the content key
            // can exist, in a process the app cannot reason about.
            "generateStoreKey", "encodeStoreKey", "ChunkEncryptor", "Sodium", "sodium",
            // The app's own upload machinery.
            "PendingUpload", "CloudUploadModel", "SendSelectionModel",
            // A share extension has no business in the transport stack at all.
            "RelayiumKit", "RelayiumAppKit", "WebRTC",
        ]
        for (name, text) in try extensionCompiledSources() {
            for symbol in forbidden {
                XCTAssertFalse(text.contains(symbol),
                               "\(name) reaches for \(symbol) — the extension stages files and nothing else")
            }
            for logging in ["print(", "NSLog(", "os_log(", "debugPrint(", "dump("] {
                XCTAssertFalse(text.contains(logging),
                               "\(name) contains \(logging) — a file name must never reach a log")
            }
            // The share sheet is the most public surface this product has.
            XCTAssertFalse(text.contains("UIPasteboard"),
                           "\(name) touches the pasteboard")
        }
    }

    /// The extension decides nothing. Everything that could go wrong — what is
    /// copied, what is refused, when the draft is published and what the user is
    /// told afterwards — belongs to `SharedDraftPreparation`, where a test can
    /// drive it.
    func testTheExtensionDelegatesEveryDecisionToTheSharedModel() throws {
        let all = try shareSources()
        let controller = try XCTUnwrap(all.first { $0.name == "ShareViewController.swift" })

        XCTAssertTrue(controller.text.contains("SharedDraftPreparation("),
                      "the extension must build the shared model rather than its own flow")
        XCTAssertTrue(controller.text.contains("ItemProviderLoader(providers: providers)"),
                      "and hand it the providers rather than reading them itself")
        XCTAssertTrue(controller.text.contains("try? SharedDraftStore.shared()"),
                      "the store must come from the fail-closed App Group resolver")

        guard let finish = controller.text.range(of: "func finish()"),
              let cancelled = controller.text.range(of: "func cancelled()") else {
            return XCTFail("ShareViewController no longer adapts NSExtensionContext")
        }
        XCTAssertTrue(finish.upperBound < cancelled.lowerBound)
        XCTAssertEqual(controller.text.components(separatedBy: "completeRequest").count - 1, 1,
                       "exactly one place completes the host request")
    }

    /// **The appex compiles the app's three visual roles, and only those three.**
    ///
    /// Read out of `project.pbxproj` because target membership is not observable
    /// from any source file: `ShareRootView` naming `SectionCard` compiles only
    /// while this membership exists, and the failure mode if somebody removes it
    /// is a build error — but the failure mode if somebody WIDENS it is a share
    /// extension that quietly compiles half the app, which nothing else here
    /// would notice.
    ///
    /// Both folders are synchronized groups, so there is no per-file reference
    /// to read: the app's group carries one build-phase membership exception
    /// naming the extension's Sources phase, and its list is the whole of what
    /// crosses the target boundary.
    func testTheExtensionCompilesExactlyThreeSharedComponentsFromTheApp() throws {
        let project = try String(
            contentsOf: try appsRoot.appendingPathComponent("ios/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)

        let marker = "PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet section"
        guard let begin = project.range(of: "/* Begin \(marker) */"),
              let end = project.range(of: "/* End \(marker) */") else {
            return XCTFail("the shared components no longer reach the extension's Sources phase")
        }
        let block = String(project[begin.upperBound..<end.lowerBound])
        XCTAssertEqual(
            block.components(separatedBy: "isa = PBXFileSystemSynchronizedGroupBuildPhaseMembershipExceptionSet").count - 1,
            1, "a second cross-target membership was added without being reasoned about")

        // Exactly the three, and nothing else with a `.swift` suffix.
        let listed = block.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasSuffix(".swift,") }
            .map { String($0.dropLast()) }
            .sorted()
        XCTAssertEqual(listed, sharedComponentSources.sorted(),
                       "the appex compiles a different set of app files: \(listed)")

        // And they land in the EXTENSION's Sources phase rather than any other
        // phase or target. `Components/PathRail.swift` added to the app's own
        // phase would be a no-op; added here it would not compile at all,
        // because its stops come from a module this target must never link.
        let phase = try XCTUnwrap(block.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.hasPrefix("buildPhase = ") }?
            .dropFirst("buildPhase = ".count)
            .prefix { $0 != " " && $0 != ";" }
            .description)
        XCTAssertTrue(project.contains("\(phase) /* Sources */"),
                      "the shared components are added to something that is not a Sources phase")
        guard let target = project.range(of: "B100000000000000000000D2 /* RelayiumShare */ = {"),
              let close = project.range(of: "productType = \"com.apple.product-type.app-extension\";",
                                        range: target.upperBound..<project.endIndex) else {
            return XCTFail("the extension target block could not be read")
        }
        XCTAssertTrue(project[target.upperBound..<close.lowerBound].contains(phase),
                      "the shared components are compiled into a target that is not the extension")
    }

    /// **The share sheet is drawn out of the app's own roles, and states the
    /// same things it always did.**
    ///
    /// This was the last first-party iOS surface still drawing its own chrome —
    /// a `Divider`, a hand-rolled orange triangle, literal 20-point gaps and a
    /// bare text Cancel under a prominent button — while the five tabs had moved
    /// to `SectionCard`, `InlineMessage` and `Metrics`. What is asserted is both
    /// halves: that the roles are used, and that the rules they came with hold
    /// here too — a card only where there is something to group, one prominent
    /// action per state, and no file name anywhere.
    func testTheShareSheetUsesTheAppsCardMessageAndSpacingRoles() throws {
        let root = try XCTUnwrap(
            try shareSources().first { $0.name == "ShareRootView.swift" }?.text)

        /// One state's rendering, between two code landmarks.
        func arm(_ from: String, _ to: String) throws -> String {
            let after = try XCTUnwrap(root.range(of: from), "\(from) is gone")
            let before = try XCTUnwrap(root.range(of: to, range: after.upperBound..<root.endIndex),
                                       "\(to) is gone")
            return String(root[after.upperBound..<before.lowerBound])
        }

        // The chrome this surface used to draw for itself.
        XCTAssertFalse(root.contains("Divider()"),
                       "the sheet still separates itself with a rule rather than a card edge")
        XCTAssertFalse(root.contains("Image(systemName: \"exclamationmark.triangle.fill\")"),
                       "the sheet kept its own copy of the failure line")
        XCTAssertFalse(root.contains("spacing: 20"), "the sheet still spaces itself with a literal")
        XCTAssertFalse(root.contains("padding(20)"), "the sheet still pads itself with a literal")
        XCTAssertFalse(root.contains("spacing: 16"), "the sheet still spaces itself with a literal")
        XCTAssertTrue(root.contains("spacing: Metrics.section"))
        XCTAssertTrue(root.contains("padding(Metrics.section)"))

        // The count, and the combined element that speaks it with the heading.
        // It is the only thing this sheet says about the share, so it survives
        // every re-layout or it is not the same product.
        XCTAssertTrue(root.contains("L10n.plural(.shareItemCount, model.itemCount)"),
                      "the sheet no longer says how much it is about to copy")
        XCTAssertTrue(root.contains(".accessibilityElement(children: .combine)"),
                      "the heading and its count are read as two unrelated labels again")

        // Ready and Saved group content; the wait and the two failures do not.
        // A card around a progress label is a box around a sentence — the rule
        // `ReceiveView` follows for exactly the same two shapes.
        let ready = try arm("private var ready: some View {", "private func copying(")
        let copying = try arm("private func copying(", "private var saved: some View {")
        let saved = try arm("private var saved: some View {", "private func failure(")
        let failure = try arm("private func failure(", "private var cancelButton:")
        let unavailable = String(root[try XCTUnwrap(
            root.range(of: "struct ShareUnavailableView"),
            "the unavailable surface is gone").upperBound...])

        for (state, text) in [("ready", ready), ("saved", saved)] {
            XCTAssertTrue(text.contains("SectionCard {"),
                          "the \(state) state lays itself out as a flat column")
        }
        for (state, text) in [("copying", copying), ("failed", failure),
                              ("unavailable", unavailable)] {
            XCTAssertFalse(text.contains("SectionCard"), "\(state) grew chrome around a sentence")
        }

        // One prominent action per state, and it is the way forward. Cancel is
        // bordered beside it rather than a bare label, which is also what gives
        // it the 44-point target every other control in the app has.
        for (state, text) in [("ready", ready), ("copying", copying), ("saved", saved),
                              ("failed", failure), ("unavailable", unavailable)] {
            let prominent = text.components(separatedBy: "buttonStyle(.borderedProminent)").count - 1
            XCTAssertEqual(prominent, state == "copying" ? 0 : 1,
                           "\(state) offers \(prominent) primary actions")
        }
        XCTAssertTrue(root.contains(".buttonStyle(.bordered)"),
                      "Cancel is a bare label under a prominent button again")
        // On the LABEL. Outside the style it widens the slot and leaves the
        // filled shape hugging its word in the middle of it, which is how this
        // first rendered: a full-width primary above a small floating Cancel.
        let cancel = try arm("private var cancelButton: some View {", "private func paragraph(")
        XCTAssertTrue(cancel.contains("Text(L10n.t(.commonCancel)).frame(maxWidth: .infinity)"),
                      "Cancel does not fill the width the primary action above it does")
        for state in [ready, copying] {
            XCTAssertTrue(state.contains("cancelButton"), "a state lost its way out")
        }

        // The two shared message roles, and what each is for here: the privacy
        // promise is a standing fact the reader needs, and a failure is a
        // failure. Both draw a symbol, so neither depends on its colour.
        XCTAssertTrue(ready.contains("InlineMessage(.info, L10n.t(.shareStaysHere))"))
        XCTAssertTrue(saved.contains("InlineMessage(.info, L10n.t(.shareStaysHere))"))
        XCTAssertTrue(failure.contains("InlineMessage(.warning, text)"))
        XCTAssertTrue(unavailable.contains("InlineMessage(.warning, message)"))
        XCTAssertTrue(saved.contains("Image(systemName: \"checkmark.circle.fill\")"),
                      "the terminal success state no longer reads as success")
        XCTAssertTrue(saved.contains(".accessibilityAddTraits(.isHeader)"),
                      "the result is not announced as the group's heading")

        // Every sentence this file sets wraps. At Accessibility 5 on the
        // smallest iPhone each of them is several lines, and the part a
        // truncation removes is the end — which is where "nothing has been
        // uploaded" is. The heading and the count are included: they are the
        // two the old layout let truncate, because they were short in English.
        let wrapping = "fixedSize(horizontal: false, vertical: true)"
        let header = try arm("private var header: some View {", "private var content:")
        XCTAssertEqual(header.components(separatedBy: wrapping).count - 1, 2,
                       "the heading or its count can still be truncated")
        for (state, text) in [("copying", copying), ("saved", saved),
                              ("unavailable", unavailable)] {
            XCTAssertTrue(text.contains(wrapping), "\(state) can truncate its own sentence")
        }
        XCTAssertTrue(try arm("private func paragraph(", "}").contains(wrapping),
                      "the shared paragraph can be truncated")

        // **No file name, in any state.** The count is measured; a name is the
        // user's, and this sheet is presented inside another app's process.
        for naming in ["FileIdentityPresentation", "PendingFileList", "suggestedName",
                       "lastPathComponent", "displayName", "fileName", "draft.files"] {
            XCTAssertFalse(root.contains(naming),
                           "the share sheet reaches for \(naming) — it renders a count and nothing else")
        }
    }

    /// **A Share Extension may not open its containing app, and this target must
    /// not find a way around that.**
    ///
    /// Apple documents `NSExtensionContext.open(_:completionHandler:)` as
    /// supported by the Today and iMessage extension points on iOS; the App
    /// Extension Programming Guide says a widget is the one extension type that
    /// may open its containing app. The call compiles from a Share Extension and
    /// is not a supported hand-off — so it is an absence here, and so is every
    /// way of half-doing the same thing: a custom URL scheme, a walk up the
    /// responder chain to reach `UIApplication`, a pasteboard signal, a
    /// notification, or a network call to something that would.
    ///
    /// An absence has no runtime to observe, which is why this is a source scan
    /// across the whole target rather than one assertion about one file.
    func testNothingInTheExtensionTriesToOpenTheContainingApp() throws {
        for (name, text) in try extensionCompiledSources() {
            for unsupported in [".open(", "openURL", "UIApplication", "canOpenURL",
                                "openHostApp", "handoffURL", "responder",
                                "URL(string:", "URLComponents", "https://",
                                "CFBundleURLTypes", "relayium://",
                                "UNUserNotification", "UNNotificationRequest"] {
                XCTAssertFalse(text.contains(unsupported),
                               "\(name) reaches for \(unsupported) to open the app")
            }
        }
        // And the model behind it offers no such call at all: `SharedDraftHost`
        // is `finish()` and `cancelled()`, which are the two an extension of this
        // point actually has.
        let model = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumShareKit/SharedDraftPreparation.swift")
        XCTAssertTrue(model.contains("func finish()"))
        XCTAssertTrue(model.contains("func cancelled()"))
        XCTAssertFalse(model.contains("func openHostApp"))
        XCTAssertFalse(model.contains("case opening"))
        XCTAssertFalse(model.contains("case openFailed"))
    }

    /// The activation rule is bounded and names only what this extension stages.
    ///
    /// `TRUEPREDICATE` is the Xcode template's default and would offer Relayium
    /// in every share sheet on the device — for a selected sentence, a URL, a
    /// web page, a contact — none of which it can stage. An entry that appears
    /// everywhere and fails on most of them is worse than one that appears where
    /// it works.
    func testTheExtensionActivatesOnlyForFilesImagesAndMovies() throws {
        let data = try Data(contentsOf: try shareRoot.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        let extensionInfo = try XCTUnwrap(plist["NSExtension"] as? [String: Any])
        XCTAssertEqual(extensionInfo["NSExtensionPointIdentifier"] as? String,
                       "com.apple.share-services")
        XCTAssertEqual(extensionInfo["NSExtensionPrincipalClass"] as? String,
                       "$(PRODUCT_MODULE_NAME).ShareViewController")
        XCTAssertNil(extensionInfo["NSExtensionMainStoryboard"],
                     "a storyboard would put this surface where no test or localization guard reaches")

        let attributes = try XCTUnwrap(extensionInfo["NSExtensionAttributes"] as? [String: Any])
        let rule = attributes["NSExtensionActivationRule"]
        XCTAssertFalse(rule is String, "the rule is a predicate string: \(String(describing: rule))")
        let counts = try XCTUnwrap(rule as? [String: Any])
        XCTAssertEqual(counts.keys.sorted(), [
            "NSExtensionActivationSupportsAttachmentsWithMaxCount",
            "NSExtensionActivationSupportsFileWithMaxCount",
            "NSExtensionActivationSupportsImageWithMaxCount",
            "NSExtensionActivationSupportsMovieWithMaxCount",
        ], "the rule accepts something this extension cannot stage: \(counts.keys.sorted())")
        for (key, value) in counts {
            XCTAssertEqual(value as? Int, SHARED_DRAFT_MAX_FILES,
                           "\(key) must be the manifest bound the product enforces")
        }
        // The AGGREGATE, and it is not redundant with the three above. Apple
        // documents `SupportsAttachmentsWithMaxCount` as the maximum TOTAL
        // number of attachments; the per-type maxima are each satisfiable on
        // their own, so without it a mixed share of 1000 files, 1000 images and
        // 1000 movies satisfies all three and hands this extension 3000 items —
        // three times the bound `SharedDraftWriter` then refuses, after the user
        // has already chosen them.
        XCTAssertEqual(counts["NSExtensionActivationSupportsAttachmentsWithMaxCount"] as? Int,
                       SHARED_DRAFT_MAX_FILES,
                       "no aggregate bound: three per-type maxima can be satisfied at once")
        // **A KNOWN, PENDING iOS/shared-package mismatch — pinned, not fixed.**
        //
        // The extension has its own bundle, so it needs its own localization
        // list. This one still names nine, while the shared package now ships
        // exactly `en` and `zh-Hans`: the Mac two-language contraction moved the
        // other seven catalogs to `apps/RelayiumKit/LocalizationArchive/` and could not
        // touch `apps/ios/**`, which is read-only while iOS product development
        // is paused. That build is unshipped, so nothing reaches a user from it.
        //
        // Asserted as a LITERAL rather than against `AppLanguage`. Deriving it
        // would fail here for a reason that is not this extension's fault and
        // would block Mac truth; deleting it would leave nothing to notice when
        // iOS resumes. When it does, replace this literal with
        // `AppLanguage.allCases.map(\.lproj).sorted()` — the assertion the Mac
        // appex already gets in `MacSurfaceGuardTests`.
        XCTAssertEqual((plist["CFBundleLocalizations"] as? [String])?.sorted(),
                       ["ar", "de", "en", "es", "fr", "ja", "ko", "pt", "zh-Hans"],
                       "apps/ios/RelayiumShare/Info.plist changed. If iOS resumed and this "
                       + "was contracted deliberately, switch this to AppLanguage; if not, "
                       + "an iOS file was edited under a Mac-only lease.")
        XCTAssertGreaterThan((plist["CFBundleLocalizations"] as? [String])?.count ?? 0,
                             AppLanguage.allCases.count,
                             "iOS no longer over-declares; see the note above")
    }

    /// The extension declares a non-empty `CFBundleDisplayName`, and it is the
    /// BRAND rather than the build target's name.
    ///
    /// This key is enforced by `installd`, not by any build step. An appex
    /// without it is refused at INSTALL time with `MIInstallerErrorDomain` 53,
    /// which fails the containing app's install too — so the whole product is
    /// uninstallable while archiving, exporting, building and running in the
    /// simulator all stay green. That is why the guard is here: removing the key
    /// again would be a one-line diff that no other check in this repository
    /// notices, and the next thing to notice would be a real device.
    ///
    /// `CFBundleName` does not substitute for it — that is `$(PRODUCT_NAME)`,
    /// i.e. "RelayiumShare", and the install-time check is for this key
    /// specifically. The exact value is asserted because this string IS the
    /// share-sheet row the user taps: what belongs there is the app the files
    /// are going to, not the target that builds the extension.
    func testTheExtensionDeclaresTheBrandAsItsShareSheetDisplayName() throws {
        let data = try Data(contentsOf: try shareRoot.appendingPathComponent("Info.plist"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])

        let displayName = try XCTUnwrap(
            plist["CFBundleDisplayName"] as? String,
            "the appex declares no CFBundleDisplayName string — installd refuses it "
                + "with MIInstallerErrorDomain 53 and the containing app cannot install")
        XCTAssertFalse(displayName.isEmpty,
                       "an empty CFBundleDisplayName fails the same install-time check as a missing one")
        XCTAssertEqual(displayName, "Relayium",
                       "the share sheet must name the app the files are going to, "
                           + "not the build target: \(displayName)")
    }

    /// The project embeds exactly one `.appex`, at the right bundle id, on the
    /// same deployment target as the app.
    ///
    /// Read out of `project.pbxproj` because none of it is observable from a
    /// package test and all of it is a way the feature ships broken: an
    /// extension that is built but not embedded never appears in a share sheet,
    /// and a bundle id that is not a suffix of the app's is rejected at install.
    func testTheProjectEmbedsExactlyOneShareExtension() throws {
        let project = try String(
            contentsOf: try appsRoot.appendingPathComponent("ios/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)

        XCTAssertEqual(project.components(separatedBy: "com.apple.product-type.app-extension").count - 1, 1,
                       "a second app extension would be a second process nobody has reasoned about")
        XCTAssertEqual(project.components(separatedBy: "PRODUCT_BUNDLE_IDENTIFIER = com.relayium.app.share;").count - 1, 2,
                       "the extension's bundle id must be set in both configurations")
        XCTAssertTrue(project.contains("dstSubfolderSpec = 13;"),
                      "the appex must be embedded into PlugIns, or it never loads")
        XCTAssertTrue(project.contains("RelayiumShare.appex in Embed Foundation Extensions"))
        // The extension links the dependency-free product, not the one carrying
        // the transport stack. This is the structural half of
        // `testTheExtensionContainsNoNetworkAccountOrKeyCode`.
        XCTAssertTrue(project.contains("productName = RelayiumShareKit;"))
        XCTAssertEqual(project.components(separatedBy: "productName = RelayiumKit;").count - 1, 1,
                       "only the app target may link the transport stack")
        // Six: the project's own Debug/Release pair, the app target's, and the
        // extension's. An `.appex` built against a newer minimum than its host
        // fails to load on exactly the devices the host still supports.
        XCTAssertEqual(project.components(separatedBy: "IPHONEOS_DEPLOYMENT_TARGET = 16.0;").count - 1, 6,
                       "project, app and extension, Debug and Release, all on iOS 16")
        XCTAssertFalse(project.contains("IPHONEOS_DEPLOYMENT_TARGET = 17"),
                       "the extension must not raise the minimum above the app's")
        XCTAssertTrue(project.contains("CODE_SIGN_ENTITLEMENTS = RelayiumShare/RelayiumShare.entitlements;"))
        XCTAssertTrue(project.contains("SKIP_INSTALL = YES;"),
                      "an appex must not be installed as a product of its own")
    }

    /// The app and its extension carry the SAME marketing and build version.
    ///
    /// An App Store requirement rather than a preference: App Store Connect
    /// rejects a submission whose embedded extension declares a
    /// `CFBundleShortVersionString` or `CFBundleVersion` different from its
    /// containing app's, and the failure arrives at upload time — after
    /// archiving, signing and notarizing — with a message about a bundle nobody
    /// was thinking about.
    ///
    /// They happen to agree today because both were set to the same literals by
    /// hand, which is exactly the arrangement that drifts the first time one
    /// target's version is bumped. Both plists take their values from build
    /// settings, so the settings are what this reads.
    func testTheExtensionShipsTheSameVersionAsTheAppItIsEmbeddedIn() throws {
        let project = try String(
            contentsOf: try appsRoot.appendingPathComponent("ios/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)

        /// Every distinct value a build setting is given anywhere in the project.
        func values(of setting: String) -> Set<String> {
            var found = Set<String>()
            for line in project.split(separator: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("\(setting) = "), trimmed.hasSuffix(";") else { continue }
                found.insert(String(trimmed.dropFirst(setting.count + 3).dropLast()))
            }
            return found
        }

        // Both targets, both configurations — four assignments of each, and
        // exactly one value between them.
        XCTAssertEqual(values(of: "MARKETING_VERSION").count, 1,
                       "app and extension disagree about the marketing version: "
                           + "\(values(of: "MARKETING_VERSION").sorted())")
        XCTAssertEqual(values(of: "CURRENT_PROJECT_VERSION").count, 1,
                       "app and extension disagree about the build number: "
                           + "\(values(of: "CURRENT_PROJECT_VERSION").sorted())")
        XCTAssertEqual(project.components(separatedBy: "MARKETING_VERSION = ").count - 1, 4,
                       "app and extension, Debug and Release, all four set")
        XCTAssertEqual(project.components(separatedBy: "CURRENT_PROJECT_VERSION = ").count - 1, 4)

        // And neither plist hard-codes one, which would make the settings above
        // decorative.
        for plistPath in ["ios/Relayium/Info.plist", "ios/RelayiumShare/Info.plist"] {
            let text = try String(contentsOf: try appsRoot.appendingPathComponent(plistPath),
                                  encoding: .utf8)
            XCTAssertTrue(text.contains("$(MARKETING_VERSION)"), "\(plistPath) pins its own version")
            XCTAssertTrue(text.contains("$(CURRENT_PROJECT_VERSION)"),
                          "\(plistPath) pins its own build number")
        }
    }

    // MARK: - Universal Link hand-off

    /// The hand-off is wired once, at the scene root, and consumed once, in the
    /// shell — and the view layer decides nothing about the link.
    ///
    /// Each clause is a way this could look finished and not be. `onOpenURL` on
    /// a tab is absent for the case that matters, because a cold launch from a
    /// link runs before any tab exists and a warm one lands on whichever tab
    /// happens to be mounted. A second `onOpenURL` would be a second entry point
    /// with its own idea of what a link may overwrite. And a handler that read
    /// `isBusy` here would be the shared policy re-derived in SwiftUI, where no
    /// test can reach it — `AppDeepLinkCoordinatorTests` owns that decision
    /// against real models.
    func testTheUniversalLinkHandOffIsWiredOnceAndDecidesNothingInTheViewLayer() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })

        XCTAssertEqual(all.map { $0.text.components(separatedBy: ".onOpenURL").count - 1 }
                          .reduce(0, +), 1,
                       "a second onOpenURL would be a second entry point for a link")
        XCTAssertTrue(app.text.contains(".onOpenURL { deepLinks.open($0) }"),
                      "the OS hand-off belongs at the scene root, and hands over unparsed")
        XCTAssertFalse(root.text.contains("onOpenURL"),
                       "a tab-scoped handler is absent for a cold launch from a link")

        // Both objects are the App's, so a retained link outlives the tab that
        // was on screen when it arrived.
        for scoped in ["@StateObject private var deepLinks = AppDeepLinkRouter()",
                       "@StateObject private var deepLinkRouting: AppDeepLinkCoordinator"] {
            XCTAssertTrue(app.text.contains(scoped), "RelayiumApp lost \(scoped)")
        }
        XCTAssertEqual(app.text.components(separatedBy: "AppDeepLinkCoordinator(").count - 1, 1,
                       "a second coordinator would be a second answer to what a link may touch")
        XCTAssertTrue(app.text.contains("navigation: routing, download: downloads,"),
                      "the coordinator must be built from the app-scoped models, not its own")
        XCTAssertTrue(app.text.contains("realtime: files, realtimeText: texts, presence: presenting,"),
                      "the coordinator must observe the app-scoped session owner")
        XCTAssertTrue(app.text.contains("selectRealtimeMode: { mode in"))
        XCTAssertTrue(app.text.contains("modes.select(mode, file: files.state, text: texts.state)"),
                      "a typed pairing link must select the app-scoped Direct mode")

        // One subscription, in the shell, and it does exactly two things.
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "deepLinks.$pending").count - 1 }
                          .reduce(0, +), 1,
                       "a second subscription would apply every link twice")
        XCTAssertTrue(root.text.contains(".onReceive(deepLinks.$pending.compactMap { $0 }) { link in"))
        XCTAssertTrue(root.text.contains("deepLinkRouting.deliver(link)"),
                      "the shell must hand the link to the shared coordinator")
        // Deferred by one turn (the `@Published` willSet ordering) AND by
        // expected link, so a second link landing inside that gap is not thrown
        // away by the first one's consume.
        XCTAssertTrue(root.text.contains("Task { @MainActor in deepLinks.consume(link) }"),
                      "the consume must be deferred and must name the link it acted on")
        XCTAssertFalse(root.text.contains("deepLinks.consume()"),
                       "an unqualified consume can discard a newer link")
    }

    /// A link fills a field and selects a tab. It never joins and never saves.
    ///
    /// The shell is where that would go wrong, because it holds every model the
    /// link touches: one `direct.join()` beside the `deliver` call would turn a
    /// tapped link into an automatic connection to a stranger's code, and one
    /// `download.download(into:)` would write a stranger's files to disk without
    /// the user ever seeing the manifest. Neither is visible in a screenshot.
    func testTheLinkPathNeitherJoinsNorDownloads() throws {
        let all = try sources()
        for name in ["RelayiumApp.swift", "RootView.swift"] {
            let file = try XCTUnwrap(all.first { $0.name == name })
            for reaching in ["updateJoinCode", "linkText", "resolve()",
                             ".join(", ".download(into:", "isBusy"] {
                XCTAssertFalse(file.text.contains(reaching),
                               "\(name) applies a link itself: \(reaching)")
            }
        }
    }

    /// A verified Universal Link is the only way in.
    ///
    /// `CFBundleURLTypes` would register a custom scheme, and a custom scheme is
    /// unauthenticated — any app on the device can claim `relayium://` and hand
    /// this one a URL the OS never checked against relayium.com. `parseAppDeepLink`
    /// would refuse it on the scheme alone, so this is defence in depth rather
    /// than the only guard; it is asserted here because declaring the key is a
    /// one-line change that reads like a convenience.
    ///
    /// `NSUserActivityTypes` is the Handoff/Spotlight declaration and belongs to
    /// a feature this app does not have. A Universal Link needs neither.
    func testTheLinkHandOffAcceptsOnlyVerifiedUniversalLinks() throws {
        let plist = try infoPlist()
        XCTAssertNil(plist["CFBundleURLTypes"],
                     "a custom URL scheme is an unauthenticated way into the app")
        XCTAssertNil(plist["NSUserActivityTypes"])
        XCTAssertNil(plist["UIBackgroundModes"],
                     "link routing must not have brought a background mode with it")
        for (name, text) in try sources() {
            XCTAssertFalse(text.contains("NSUserActivity"), "\(name) reaches for Handoff")
            XCTAssertFalse(text.contains("relayium://"), "\(name) names a custom scheme")
        }
    }

    /// The site's side of the association names this app, for exactly the two
    /// paths it can act on — and still names the Mac app.
    ///
    /// Read here rather than only in the web test because the two halves fail
    /// separately and silently: an entitlement with no matching `appIDs` entry
    /// is an app that never receives a link, and an `appIDs` entry with no
    /// entitlement is a site claiming an app that will not open. Neither shows
    /// up on the simulator, where the association is not fetched at all.
    func testTheSiteAssociationNamesThisAppForTheTwoRoutablePaths() throws {
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try RepoRoot.data(
                "web/public/.well-known/apple-app-site-association"))
                as? [String: Any])
        let applinks = try XCTUnwrap(json["applinks"] as? [String: Any])
        let details = try XCTUnwrap(applinks["details"] as? [[String: Any]])
        let appIDs = details.flatMap { ($0["appIDs"] as? [String]) ?? [] }
        XCTAssertEqual(appIDs, ["7PVYUG4YQS.com.relayium.mac", "7PVYUG4YQS.com.relayium.app"],
                       "the association no longer names both native app IDs")

        let paths = details.flatMap { detail in
            ((detail["components"] as? [[String: Any]]) ?? []).compactMap { $0["/"] as? String }
        }
        // Unchanged by the share extension, and that is the point: a Share
        // Extension may not open its containing app, so there is no link for it
        // to emit and no path for this file to claim on its behalf. The
        // extension publishes a draft into the App Group and the app re-reads
        // that inbox when its scene becomes active.
        XCTAssertEqual(paths, ["/d/*", "/cross-network"],
                       "the site claims a path parseAppDeepLink cannot route")
        XCTAssertFalse(paths.contains("/share"),
                       "a path was claimed for a hand-off iOS cannot perform")

        // `webcredentials` shares the file and is a different permission: the
        // site allowing password AutoFill for an app. This app claims no
        // `webcredentials:` entitlement and its sign-in form does not use
        // AutoFill, so being added there would be a credential-adjacent
        // association ahead of anything asking for it — and the natural mistake
        // is to add the ID to both lists because they sit four lines apart.
        let credentials = try XCTUnwrap(
            (json["webcredentials"] as? [String: Any])?["apps"] as? [String])
        XCTAssertEqual(credentials, ["7PVYUG4YQS.com.relayium.mac"],
                       "the site associates this app for AutoFill, which it does not use")
    }

    /// The bearer is read at the moment of use, only by the surfaces that spend
    /// it and by the app-scoped billing seam that supplies a fresh token to the
    /// shared subscription model.
    ///
    /// It is not `@Published` on purpose — a credential has no business in the
    /// view-update surface — so the send button's ENABLEMENT comes from
    /// `session.state` and its ACTION re-reads the token. The upload model does
    /// capture it for the life of one authenticated upload task; that is what an
    /// authenticated upload IS, and it is not this guard's business. What this
    /// guard forbids is a holder anywhere ELSE in the view layer.
    ///
    /// R3-D adds the second reader, and it is a different shape from the first:
    /// `AccountSummaryView` recomputes an `AccountScope` on every render rather
    /// than storing one, so a result can be checked against the account and
    /// credential on screen when it ARRIVES. Storing it is the defect that shape
    /// exists to prevent, so the read is asserted to be a computed property.
    func testTheBearerIsReadOnlyWhereItIsSpent() throws {
        let all = try sources()
        let readers = all.filter { $0.text.contains("bearerToken") }.map(\.name).sorted()
        // `DirectView` joins the list in R3-E, and it is the only one of the
        // three that reads the credential WITHOUT spending it: it builds an
        // `AccountGate`, whose `.allowed` arm carries the token to the one
        // action that needs one — minting a code, which is billed to whoever
        // created it. Joining a code is beside it in the same view and reaches
        // the transport with no credential at all.
        //
        // P3A adds `DeviceSendView`, and it is the same shape as `DirectView`'s:
        // every read is inside an action, none is stored, and each pairs the
        // token with an `AccountGate` so a sign-out landing between a control
        // being enabled and that control being tapped routes to the Account tab
        // rather than issuing a request with a dead credential. The positive
        // claims about that shape are asserted immediately below, because "is in
        // the list" is the weaker half.
        XCTAssertEqual(readers, ["AccountSummaryView.swift", "DeviceSendView.swift",
                                 "DirectView.swift", "RelayiumApp.swift", "SendView.swift"],
                       "an unaccounted-for view-layer holder of the credential")
        let devices = try XCTUnwrap(all.first { $0.name == "DeviceSendView.swift" })
        XCTAssertFalse(devices.text.contains("@State private var token"),
                       "a stored credential would outlive the account that issued it")
        XCTAssertEqual(devices.text.components(
            separatedBy: "case .allowed = AccountGate.from(session.state, bearer: token)").count - 1, 2,
            "a device send or a recovery action can be activated on a dead credential")
        // The list read is the one deliberate exception, and it is not a gap: an
        // empty or rejected bearer has to reach the model, because the model is
        // what turns it into the unauthorized DIRECTORY state whose remedy names
        // the account. Routing it to the Account tab instead would leave the
        // picker silently empty.
        XCTAssertTrue(devices.text.contains(
            "deliveries.refreshTargets(token: session.bearerToken ?? \"\")"),
            "a rejected credential must surface as an unauthorized device list")
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("bearer: { account.bearerToken }"),
                      "billing captured a token value instead of reading it at submission time")
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("private var scope: AccountScope {"),
                      "the scope must be recomputed per render, not stored")
        XCTAssertTrue(summary.text.contains(
            "AccountScope(accountId: user.id, token: session.bearerToken ?? \"\")"),
            "the scope must pair THIS render's account with the live credential")
        // Two reads, and the second is the reason this is not "exactly one":
        // `refresh()` has to ask the session what it holds AFTER the refresh
        // moved it, because a refresh can rotate the credential or end the
        // session entirely. Re-reading the computed `scope` there would hand
        // `AccountRefreshDecision` the value it is supposed to check.
        XCTAssertEqual(summary.text.components(separatedBy: "session.bearerToken").count - 1, 2,
                       "the credential is read to build the scope and to re-check it after a refresh")
        XCTAssertTrue(summary.text.contains("bearer: session.bearerToken"),
                      "the refresh decision must see the LIVE credential, not the rendered scope")
        XCTAssertFalse(summary.text.contains("@State private var scope"),
                       "a stored scope would outlive the credential it names")
    }

    // MARK: - P3A: sending to one of the account's own devices

    /// The two halves of the Send tab are ONE object each, built before any view
    /// exists and sharing the one staging root.
    ///
    /// Every clause here is a defect that compiles and reads plausibly:
    ///
    ///  - a second `PendingUploadSupport` would be a second staging root and a
    ///    second keychain namespace over one directory. It would work until one
    ///    of them was pointed elsewhere, and the symptom would be device
    ///    deliveries the recovery path cannot see;
    ///  - a `.task`-installed session observation would be absent for exactly
    ///    the case it exists for, because a `TabView` may tear an off-screen tab
    ///    down — leaving an account-owned delivery running, and described on
    ///    screen, under an account that has gone;
    ///  - a missing commit seam would leave the Share Extension's copy of the
    ///    user's files on disk forever, offered as a second send of bytes
    ///    already on their way.
    func testTheDeviceSendHalfIsAppScopedAndSharesTheOneStagingRoot() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" }?.text)
        XCTAssertEqual(app.components(separatedBy: "AppEnvironment.makePendingUploadSupport(")
                        .count - 1, 1,
                       "the two halves of the Send tab must stage into one root")
        XCTAssertEqual(app.components(separatedBy: "AppEnvironment.makeInboxSendModel(").count - 1, 1)
        XCTAssertTrue(app.contains("pending: pending"),
                      "the delivery model must be built from the shared staging support")
        XCTAssertTrue(app.contains("delivering.observe(account.$state)"),
                      "an account leaving must reach the delivery model with no view mounted")
        XCTAssertTrue(app.contains("delivering.onSelectionCommitted = "),
                      "nothing would retire a shared draft a durable delivery took over")
        XCTAssertTrue(app.contains(
            "sending?.deviceSendCommitted(accountId: accountId, sourceDraftId: draftId)"),
            "the retirement must carry the ACCOUNT, or it cannot refuse a stale report")
        XCTAssertTrue(app.contains("@StateObject private var deliveries: InboxSendModel"))
        XCTAssertTrue(app.contains("@StateObject private var sendRoutes: SendRouteSelection"))
    }

    /// The route is a choice the user makes before anything is encrypted, and
    /// its consequence is stated where the choice is made.
    ///
    /// A link publishes the content key in a URL fragment and a delivery seals
    /// it to one device. Those are different answers to "who can read this", so
    /// neither may be entered by default from the other's failure and the
    /// difference may not be something the user discovers afterwards.
    func testTheSendRouteIsChosenExplicitlyAndExplainsItsConsequence() throws {
        let all = try sources()
        let chooser = try XCTUnwrap(all.first { $0.name == "DeviceSendView.swift" }?.text)
        XCTAssertTrue(chooser.contains("InboxSendPresentation.explanation(for: routes.route)"),
                      "the two kinds of send are offered without saying how they differ")
        XCTAssertTrue(chooser.contains("routes.select($0)"))
        XCTAssertFalse(chooser.contains("@State private var route"),
                       "a view-local route would reset to the other kind of send on a rebuild")

        let send = try XCTUnwrap(all.first { $0.name == "SendView.swift" }?.text)
        XCTAssertTrue(send.contains("SendRouteChooser(routes: routes)"))
        XCTAssertTrue(send.contains("if routes.route == .device, isChoosingFilesToSend {"),
                      "a live or finished link upload must not be hidden behind the chooser")
        XCTAssertTrue(send.contains("DeviceDeliveryList(deliveries: deliveries,"),
                      "outstanding deliveries must be rendered under BOTH routes")
    }

    /// An upload is not a delivery, and no view may decide otherwise.
    ///
    /// Every sentence on this surface comes from `InboxSendPresentation`, where
    /// `InboxSendModelTests` can drive it. A `switch` in a view is a `switch` no
    /// `swift test` can reach, and the one mistake this screen must not make is
    /// rendering a finished upload as an arrival.
    func testTheDeliverySurfaceRendersNoStateItDecidedForItself() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "DeviceSendView.swift" }?.text)
        XCTAssertTrue(view.contains("InboxSendPresentation.status(for: item.activity)"))
        XCTAssertTrue(view.contains("InboxSendActions.offered(for: item)"),
                      "the offered recovery must be derived, not tabulated in a view")
        XCTAssertTrue(view.contains("InboxSendActions.warnsDeliveryMayStillArrive(action, for: item)"),
                      "the warning a discard carries must not be re-decided here")
        for invented in ["Saved on", "isSavedOnTarget ?", "case .saved:"] {
            XCTAssertFalse(view.contains(invented),
                           "the view reaches for an arrival it is not allowed to decide")
        }
        // A bar only while bytes move, and never as the whole story.
        XCTAssertTrue(view.contains("if case let .uploading(sent, total) = item.activity"))
        XCTAssertTrue(view.contains("PendingFileList(sessionFiles: item.files)"),
                      "a recovered delivery offers Send without naming what it holds")
    }

    /// Blocked devices are shown and are not tappable.
    ///
    /// Dropping them is what turns a two-second fix into "Relayium cannot see my
    /// Mac"; making them tappable is a dead end the user finds by pressing it.
    func testTheTargetPickerShowsBlockedDevicesWithoutOfferingThem() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "DeviceSendView.swift" }?.text)
        XCTAssertTrue(view.contains("ForEach(blocked) { candidate in"))
        XCTAssertTrue(view.contains("L10n.t(.sendDeviceBlockedHeading)"))
        let blocked = try XCTUnwrap(view.components(separatedBy: "private func blockedRow(")
            .dropFirst().first?.components(separatedBy: "private func failureLine").first)
        XCTAssertFalse(blocked.contains("Button"),
                       "a blocked device must not be selectable")
        XCTAssertTrue(blocked.contains("InboxSendPresentation.detail(for: candidate)"),
                      "a blocked device must say which remedy it needs")
        // The three list states that are not a list, each with its own remedy.
        for state in ["L10n.t(.sendDeviceNone)", "L10n.t(.sendDeviceNoneHelp)",
                      "InboxSendPresentation.text(for: deliveries.directory)"] {
            XCTAssertTrue(view.contains(state), "the target list cannot render \(state)")
        }
    }

    // MARK: - R3-D: device and stored-file management

    /// One key store, shared by the upload that WRITES a `#k=` key and the
    /// management model that READS it back.
    ///
    /// Two stores would still address the same keychain items, so this would not
    /// fail at runtime — it would drift the moment either construction gained an
    /// argument the other did not, and the symptom would be an upload whose link
    /// the Account tab cannot rebuild. The key exists nowhere else: not on the
    /// server, not in the manifest, only in the link and in this store.
    func testOneStoredLinkKeyStoreIsSharedByUploadAndManagement() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })
        // Count the PRODUCT store, not the expression: an acceptance launch
        // substitutes an in-memory store for it, which is still one store — the
        // invariant is that both models receive the same `keys` value, not that
        // the line mentions the factory once.
        XCTAssertEqual(app.text.components(
            separatedBy: "AppEnvironment.makeStoredLinkKeyStore()").count - 1, 1,
            "a second key store would be a second source of truth for the keys")
        XCTAssertEqual(app.text.components(
            separatedBy: "UITestMode.makeStoredLinkKeyStore()").count - 1, 1,
            "the acceptance substitution happens more than once")
        XCTAssertTrue(app.text.contains("AppEnvironment.makeUploadModel(\n            keyStore: keys"),
                      "the upload model must take the shared store")
        XCTAssertTrue(app.text.contains("AppEnvironment.makeAccountManagementModel(\n            keyStore: keys"),
                      "and the management model must take the SAME one")
    }

    /// R3-G's pending key is a DIFFERENT store, and that is the point.
    ///
    /// The content key of an unfinished upload is named by a locally minted job
    /// id; a stored-link key is named by a server-minted object id. Sharing one
    /// namespace would let a pending key be read as the key to an object that
    /// does not exist yet, or a finished upload be "resumed" from a key that
    /// belongs to a delivered file. The app builds it through the factory that
    /// carries the separate prefix, never by reusing `keys`.
    func testThePendingUploadKeyIsAStoreOfItsOwn() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })
        // The factory, not an inline assembly. Its argument list is allowed to
        // grow — acceptance passes a staging root of its own — so this asserts
        // the call and the draft store it must carry, not the exact layout.
        XCTAssertTrue(app.text.contains("AppEnvironment.makePendingUploadSupport("),
                      "durable recovery must be wired through the factory, not assembled inline")
        XCTAssertTrue(app.text.contains("drafts: drafts"),
                      "durable recovery no longer carries the shared draft store")
        // ONE shared-draft store, reaching both the model that adopts a draft
        // and the model that retires it once a job carrying it is durable. Two
        // would address the same directory and so would not fail — until one of
        // them was pointed somewhere else.
        XCTAssertEqual(app.text.components(separatedBy: "makeSharedDraftStore()").count - 1, 1,
                       "a second draft store would be a second answer to what is waiting")
        XCTAssertTrue(app.text.contains("makeSendSelectionModel(upload: uploads, drafts: drafts)"),
                      "the send model must take the SAME store the upload model retires through")
    }

    /// **The share extension's hand-off is the scene becoming active, and it is
    /// wired at the scene root.**
    ///
    /// A Share Extension may not open its containing app, so nothing pushes a
    /// staged draft onto the Send tab. What brings it there is the user opening
    /// or returning to Relayium — and that has to be observed where the scene
    /// is, not on a tab SwiftUI may have torn down while the user was in another
    /// app doing the sharing.
    ///
    /// Both halves: `onChange` for a return from the background, and `.task` for
    /// a cold launch, because `onChange` fires on a CHANGE and the scene is
    /// already `.active` when it first appears. And the view reports the PHASE
    /// only — whether `.active` means "re-read the inbox" is
    /// `SendSelectionModel`'s decision, which
    /// `SharedDraftAdoptionTests.testTheInboxIsReReadWheneverTheSceneBecomesActive`
    /// drives.
    func testTheSharedDraftInboxIsRefreshedFromTheSceneLifecycle() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })

        XCTAssertTrue(app.text.contains("send.phaseChanged(to: lifecycle(phase))"),
                      "a return to the app must re-read what the share extension staged")
        XCTAssertTrue(app.text.contains("send.phaseChanged(to: .active)"),
                      "a cold launch must too, because onChange fires on a CHANGE")
        // The decision is not re-derived here. A `.active` comparison in the
        // scene root would be a second copy of a policy the model already owns,
        // and the two would drift.
        XCTAssertFalse(app.text.contains("refreshSharedDrafts"),
                       "the scene root reaches past the lifecycle entry point")
        XCTAssertFalse(app.text.contains("== .active"),
                       "the scene root decides what a phase means")
        // And no link routing was added for it: the coordinator takes the same
        // four models it always did.
        XCTAssertFalse(app.text.contains("send: sending"),
                       "a deep link was wired for a hand-off that does not exist")
        XCTAssertFalse(app.text.contains("PendingUploadSupport(store:"),
                       "the app must not hand-build the pair and pick its own keychain namespace")
        XCTAssertEqual(KeychainStoredLinkKeyStore.pendingUploadPrefix, "pending-upload-key:")
        XCTAssertNotEqual(KeychainStoredLinkKeyStore.pendingUploadPrefix,
                          KeychainStoredLinkKeyStore.accountPrefix)
    }

    /// The foreground-only claim survives R3-G, and gains its second half.
    ///
    /// What changed is not that iOS keeps uploading — it does not — but that the
    /// bytes are staged on the device, so reopening the app can carry on. The
    /// copy has to say both, and the symbols that would make the first half a
    /// lie stay banned by `testTheSendTabAddsNoBackgroundCapability`.
    func testTheKeepOpenCopyStatesBothTheLimitAndTheRecovery() throws {
        let keepOpen = L10n.t(.uploadKeepOpen, language: .en)
        XCTAssertTrue(keepOpen.lowercased().contains("background"),
                      "the foreground-only limit must still be stated")
        XCTAssertTrue(keepOpen.lowercased().contains("reopen"),
                      "and so must the recovery that now exists")
        XCTAssertFalse(keepOpen.contains("can't be resumed"),
                       "the stale 'no resume' claim is now false")
    }

    // MARK: - what the root README may claim about this app

    /// One row of the concise root README delivery-status table.
    private func deliveryStatusEntry(_ platform: String) throws -> String {
        let readme = try RepoRoot.text("README.md")
        let row = try XCTUnwrap(readme.split(separator: "\n").first {
            $0.hasPrefix("| **\(platform)** |")
        }, "the README no longer has a `\(platform)` delivery-status row")
        return row.lowercased()
    }

    /// The iOS bullet once listed *resume* among the things this build has no
    /// version of, when what it has no version of is background execution. A
    /// reader who believes "no resume" discards a staged upload the app would
    /// have finished for them, so both halves must be stated and neither may
    /// stand in for the other.
    func testTheReadmeIOSEntrySeparatesNoBackgroundFromReopenAndResume() throws {
        let ios = try deliveryStatusEntry("iOS")

        XCTAssertTrue(ios.contains("internal development and testflight"))
        XCTAssertTrue(ios.contains("not publicly available on the app store"))
        XCTAssertTrue(ios.contains("foreground"))
        XCTAssertTrue(ios.contains("background transfer"))
        XCTAssertTrue(ios.contains("push notifications"))
    }

    /// The Next bullet is the roadmap, so what it lists as remaining has to be
    /// what actually remains: background execution — not resume — plus the
    /// surfaces this build has none of and the verifications neither platform
    /// has had.
    ///
    /// **Universal-link routing left the "does not exist" half and did not leave
    /// the roadmap.** The app now routes links and the tests below cover the
    /// policy, but the association is fetched and verified by the OS at install
    /// time, so nothing a simulator or a package test does is evidence that a
    /// tapped link opens the app. Moving it out of the roadmap entirely would
    /// claim a verification that has not happened; leaving it beside "no
    /// notifications" would claim the routing does not exist. It has to be named
    /// as unverified rather than as absent, so both halves are asserted.
    func testTheReadmeNextEntryScopesTheRemainingIOSWork() throws {
        let readme = try RepoRoot.text("README.md")
        XCTAssertTrue(readme.contains("[`docs/`](docs/)"),
                      "the concise README no longer points detailed future work to docs")
        XCTAssertFalse(readme.contains("- **Next:"),
                       "the root README grew a second long-form roadmap")
    }

    /// The iOS bullet describes what a link DOES, and bounds it.
    ///
    /// "Universal links supported" would be true and useless: the two ways this
    /// feature could be dangerous are joining a stranger's session and writing a
    /// stranger's files, and a reader has no way to know it does neither unless
    /// the entry says so. The third clause is the one a reviewer would drop —
    /// that a link arriving mid-transfer waits instead of replacing it.
    func testTheReadmeIOSEntryStatesWhatALinkDoesAndDoesNot() throws {
        let ios = try deliveryStatusEntry("iOS")

        XCTAssertFalse(ios.contains("]("), "the unpublished iOS row contains a download link")
        XCTAssertTrue(ios.contains("not publicly available"), "the unpublished state is only implied")
    }

    /// The management model is app-scoped and injected once.
    ///
    /// View-scoped would be the natural-looking mistake and the wrong one: a
    /// SwiftUI `TabView` mounts its tabs lazily and can tear an off-screen one
    /// down, so a revoke in flight — the operation that can end this app's own
    /// session — would be cancelled by the user switching tabs, and
    /// `needsSignOut` would be raised on an object that no longer exists.
    func testTheManagementModelIsAppScopedAndInjectedOnce() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("@StateObject private var management: AccountManagementModel"),
                      "the model belongs to the App, not to a view")
        XCTAssertTrue(app.text.contains(".environmentObject(management)"),
                      "and has to reach the view tree")
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "makeAccountManagementModel").count - 1 }
                          .reduce(0, +), 1,
                       "a second construction would be a second model, with its own rows")
        XCTAssertEqual(all.map { $0.text.components(separatedBy: ".environmentObject(management)").count - 1 }
                          .reduce(0, +), 1)
    }

    /// Management is rendered by the ready account surface and by nothing else.
    ///
    /// The tab is a router over session states; the summary is the one state
    /// that HAS an account whose devices and files exist. A second holder would
    /// be a screen able to render a revoke button outside `.ready` — with a
    /// scope built from a user that is no longer signed in.
    func testOnlyTheReadyAccountSurfaceRendersManagement() throws {
        let all = try sources()
        let holders = all.filter { $0.text.contains("AccountManagementModel") }
            .map(\.name).sorted()
        XCTAssertEqual(holders, ["AccountSummaryView.swift", "RelayiumApp.swift"])
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains(
            "@EnvironmentObject private var management: AccountManagementModel"))
        let tab = try XCTUnwrap(all.first { $0.name == "AccountTab.swift" })
        XCTAssertFalse(tab.text.contains("management"),
                       "the router must not reach into the account's rows")
        XCTAssertTrue(tab.text.contains("AccountSummaryView(user: user, usage: usage,"),
                      "and the summary must stay the `.ready` arm")
        XCTAssertTrue(tab.text.contains("onOpenStoredLink: onOpenStoredLink"),
                      "Account drops the in-app stored-link handoff")
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains(
            "AccountTab(onOpenStoredLink: { deepLinkRouting.deliverStoredLink($0) })"),
                      "Account bypasses the shared deep-link admission policy")
    }

    /// Every call into the model carries the scope, and the load is KEYED on it.
    ///
    /// `.task(id:)` is what makes signing in as somebody else reload instead of
    /// leaving the previous account's devices — each with a revoke button — under
    /// the new account's name. A bare `.task` would run once per view identity
    /// and never again.
    func testEveryManagementCallCarriesTheScopeAndTheLoadIsKeyedOnIt() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        for wired in [".task(id: scope) { await management.load(scope) }",
                      "management.revoke(device, scope: scope)",
                      "management.delete(file, scope: scope)",
                      "management.clear(scope:"] {
            XCTAssertTrue(summary.text.contains(wired), "AccountSummaryView lost \(wired)")
        }
        // No call may reach the model without one. A scope-less overload does
        // not exist, so this catches the shape rather than the symbol: a bare
        // `management.load()` would not compile, but `management.load(stale)`
        // built from something other than the render-time scope would.
        XCTAssertFalse(summary.text.contains("management.load(AccountScope("),
                       "a call must not mint its own scope beside the render-time one")
    }

    /// Refresh goes through the shared decision, and acts on BOTH of its answers.
    ///
    /// The naive version — refresh the session, then reload with the scope the
    /// view recomputes — is wrong in two ways that only appear once refreshing
    /// can change the session: an expired bearer pairs the old account id with an
    /// empty token, and a second sign-in pairs it with a stranger's credential.
    /// Which outcome it is belongs in `AccountRefreshDecision`, where
    /// `AccountManagementModelTests` drives it; this asserts the view carries it
    /// out rather than re-deriving it.
    func testRefreshDefersToTheSharedDecisionAndHandlesBothOutcomes() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("AccountRefreshDecision.next(previous: previous,"),
                      "the decision must not be re-derived in the view")
        XCTAssertTrue(summary.text.contains("case .reload(let current): await management.load(current)"),
                      "a still-ready same account reloads under its CURRENT bearer")
        XCTAssertTrue(summary.text.contains("case .clear(let stale):    management.clear(scope: stale)"),
                      "anything else lets the rows go rather than fetching more of them")
        guard let refresh = summary.text.range(of: "await session.refresh()"),
              let decide = summary.text.range(of: "AccountRefreshDecision.next(previous:") else {
            return XCTFail("AccountSummaryView no longer refreshes through the decision")
        }
        XCTAssertTrue(refresh.upperBound < decide.lowerBound,
                      "the decision must read the session AFTER the refresh moved it")
    }

    /// The explicit Sign out button goes through the same coordinator the
    /// self-revoke does.
    ///
    /// Not tidiness: it is what makes "one revocation at a time" enforceable.
    /// With the view calling `session.logOut()` itself, a Sign out tapped while a
    /// self-revoke's sign-out was already running would be a second revocation of
    /// a credential that is already gone, and its failure would be reported over
    /// the first one's success. It still carries the scope, because a press
    /// naming an account the model has moved on from must not wipe the current
    /// one's rows.
    ///
    /// The claim that the rows go BEFORE the network call moved with the code:
    /// `AccountSignOutCoordinatorTests` drives it against a held-open logout,
    /// which is a stronger check than the source ordering this used to read.
    func testTheExplicitSignOutGoesThroughTheOneCoordinator() throws {
        let all = try sources()
        let summary = try XCTUnwrap(all.first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains(
            "@EnvironmentObject private var signOut: AccountSignOutCoordinator"))
        XCTAssertTrue(summary.text.contains("signOut.signOut(scope: scope)"),
                      "the button must hand the SCOPED sign-out to the coordinator")
        XCTAssertEqual(summary.text.components(separatedBy: "signOut.signOut(").count - 1, 1,
                       "a second call site would be one that skipped the serialization")
        // Nowhere in the app may reach the session's sign-out directly except
        // the two account-router screens that hold no rows and have no scope to
        // give: `.unavailable` and check-email, both of which are signed-OUT
        // states by the time they are on screen.
        let direct = all.filter { $0.text.contains("session.logOut()") }.map(\.name).sorted()
        XCTAssertEqual(direct, ["AccountTab.swift"],
                       "a signed-in surface signs out around the coordinator")
    }

    /// A Refresh already in flight must not put the rows and reconstructed links
    /// back after a sign-out cleared them.
    ///
    /// `AccountSession.logOut()` deliberately keeps `.ready` on screen until its
    /// network revocation finishes. A superseded Refresh therefore returns to a
    /// still-ready old account and `AccountRefreshDecision` would legitimately
    /// choose `.reload` — recreating every `#k=` link for the length of the
    /// sign-out timeout, which is exactly the interval the pre-call clear exists
    /// to avoid.
    ///
    /// The gate reads the COORDINATOR, not this view's `@State`. That is the
    /// review's finding applied to the gate as well as to the observer: the
    /// account view can be torn down and rebuilt mid-sign-out — a tab switch away
    /// and back — and a fresh `@State` would come back `false` and reopen the
    /// gate while the revocation was still running.
    func testLeavingTheAccountPreventsAnOlderRefreshFromRehydratingItsRows() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertFalse(summary.text.contains("@State private var isLeavingAccount"),
                       "a view-scoped leave flag does not survive the view it lives on")
        guard let refreshStart = summary.text.range(of: "private func refresh() {") else {
            return XCTFail("AccountSummaryView no longer has one refresh seam")
        }
        let refresh = summary.text[refreshStart.lowerBound...]
        guard let sessionRefresh = refresh.range(of: "await session.refresh()"),
              let leaveGuard = refresh.range(of: "guard !signOut.isSigningOut else {") else {
            return XCTFail("refresh no longer refuses to reload an account being left")
        }
        XCTAssertTrue(sessionRefresh.upperBound < leaveGuard.lowerBound,
                      "the leave signal must be checked when the suspended refresh returns")
        XCTAssertTrue(refresh[leaveGuard.lowerBound...].contains("management.clear(scope: previous)"),
                      "a late refresh must leave the old scope deactivated")
    }

    /// **No view owns the self-revoke hand-off.**
    ///
    /// This is the defect the R3-D review found, and it is a lifecycle one, so
    /// nothing about it is visible in the account screen's own behaviour. The
    /// hand-off used to be a `.task(id: management.needsSignOut)` on this view.
    /// A user who taps Revoke on the current device and immediately switches
    /// tabs takes that view down before the response lands: the app-scoped model
    /// still records the signal truthfully, but nothing consumes it, so the
    /// other tabs go on offering to spend a bearer the server has already
    /// revoked until the user happens to return to the Account tab.
    ///
    /// The account screen may still START a revoke. It may not be what NOTICES
    /// one succeeded — so it names none of the machinery, and a re-layout cannot
    /// reintroduce a view-scoped observer without failing here.
    func testNoViewOwnsTheSelfRevokeHandOff() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        for viewScoped in ["needsSignOut", "acknowledgeSignOut", "consumeSelfRevoke",
                           "session.logOut()"] {
            XCTAssertFalse(summary.text.contains(viewScoped),
                           "the account view owns \(viewScoped) again — a tab switch would "
                           + "strand a revoked credential")
        }
        // Two `.task`s used to live here. Only the scope-keyed load may now.
        XCTAssertEqual(summary.text.components(separatedBy: ".task(").count - 1, 1,
                       "the only task on this view is the scope-keyed load")
    }

    /// The observer is app-scoped and subscribes BEFORE any view exists.
    ///
    /// Stronger than "an always-mounted root": it does not depend on a view
    /// hierarchy at all, which is the same reason `SendSelectionModel.observe`
    /// is called from `init` rather than from a `.task`. `AccountSession` is
    /// never handed to the coordinator directly — it takes a closure, so
    /// `AccountSignOutCoordinatorTests` can hold a logout open and look at the
    /// app while the call is in flight.
    func testTheSelfRevokeObserverIsAppScopedAndStartedBeforeAnyView() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("@StateObject private var signOut: AccountSignOutCoordinator"),
                      "the observer belongs to the App, not to a view")
        // The locals are named apart from the properties, the way this file
        // already names `account`, `uploads` and `sending`: a `@StateObject`'s
        // property cannot be read inside `init`, so the wiring necessarily runs
        // against locals.
        XCTAssertTrue(app.text.contains(".observe(managing.$needsSignOut)"),
                      "it has to be subscribed to the signal")
        XCTAssertTrue(app.text.contains(".environmentObject(signOut)"))
        // Subscribed inside `init`, so no view's lifetime gates it.
        guard let initRange = app.text.range(of: "init() {"),
              let body = app.text.range(of: "var body: some Scene"),
              let observe = app.text.range(of: ".observe(managing.$needsSignOut)") else {
            return XCTFail("RelayiumApp no longer has the shape this checks")
        }
        XCTAssertTrue(initRange.upperBound < observe.lowerBound
                      && observe.upperBound < body.lowerBound,
                      "the subscription must be made in init, before any view is built")
        // Constructed exactly once, and known to exactly the three files that
        // need it: the app that owns it, the shell that blocks on it, and the
        // account screen that hands it an explicit sign-out.
        XCTAssertEqual(app.text.components(separatedBy: "AccountSignOutCoordinator(").count - 1, 1,
                       "a second coordinator would be a second logout path")
        XCTAssertEqual(all.filter { $0.text.contains("AccountSignOutCoordinator") }
                          .map(\.name).sorted(),
                       ["AccountSummaryView.swift", "RelayiumApp.swift", "RootView.swift"])
        for (name, text) in all where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("$needsSignOut"),
                           "\(name) starts a second observer")
        }
    }

    /// While the network logout is finishing, every tab is blocked and says so.
    ///
    /// The bearer is already dead server-side by then, so an action started in
    /// another tab would fail against the server and report it as the user's
    /// problem. Blocked AND labelled: a frozen tab bar with no explanation reads
    /// as the app having hung, and a bare spinner reads as nothing at all to
    /// VoiceOver.
    ///
    /// It is a transient operation, not an account gate. The shell still never
    /// reads `session.state` and never sees the account's rows, so anonymous
    /// receive stays structurally independent of whether anyone is signed in.
    func testEveryTabIsBlockedAndLabelledWhileTheLogoutFinishes() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("@EnvironmentObject private var signOut: AccountSignOutCoordinator"))
        XCTAssertTrue(root.text.contains(".disabled(signOut.isSigningOut)"),
                      "a tab must not act with a credential the server has revoked")
        XCTAssertTrue(root.text.contains("ProgressView { Text(L10n.t(.accountSigningOut)) }"),
                      "the block has to say what it is waiting for")
        // The shell learns exactly one thing, and it is not who is signed in.
        for accountish in ["session.state", "AccountManagementModel", "management",
                           "bearerToken", "AccountScope"] {
            XCTAssertFalse(root.text.contains(accountish),
                           "the shell reads \(accountish) — that would gate the receive tab")
        }
    }

    /// Both row actions are destructive and both ask first, through the system's
    /// own dialog — which is what makes them dismissible, readable at every
    /// Dynamic Type size and announced the way the platform's users expect.
    ///
    /// The revoke message is not fixed text: revoking the credential in your hand
    /// signs this app out, and revoking another one does not. The decision lives
    /// in `AccountPresentation.revokeConsequence`, where a test drives it.
    func testBothRowActionsConfirmBeforeActingAndSayWhatTheyCost() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertEqual(summary.text.components(separatedBy: "confirmationDialog(").count - 1, 3,
                       "revoke, delete-file and delete-account are three confirmations")
        guard let revokeDialog = summary.text.range(of: ".confirmationDialog(\n            L10n.t(.accountRevokeTitle"),
              let fileDialog = summary.text.range(of: ".confirmationDialog(\n            L10n.t(.accountDeleteFileTitle)"),
              let accountDialog = summary.text.range(of: ".confirmationDialog(\n            L10n.t(.accountDeleteAccountConfirmTitle)") else {
            return XCTFail("one of the three destructive confirmations is no longer attached")
        }
        XCTAssertTrue(summary.text[revokeDialog.lowerBound..<fileDialog.lowerBound]
            .contains("Button(L10n.t(.commonRevoke), role: .destructive)"),
                      "the confirmed revoke action must carry the destructive role")
        XCTAssertTrue(summary.text[fileDialog.lowerBound..<accountDialog.lowerBound]
            .contains("Button(L10n.t(.commonDelete), role: .destructive)"),
                      "the confirmed stored-file delete must carry the destructive role")
        XCTAssertTrue(summary.text.contains(
            "AccountPresentation.revokeConsequence(current: deviceToRevoke?.current == true)"),
            "the consequence must come from the tested seam, not from an inline ternary")
        // The list buttons must OPEN a dialog rather than act. A direct call
        // would be a one-tap revoke of the credential the user is holding.
        XCTAssertEqual(summary.text.components(separatedBy: "management.revoke(").count - 1, 1)
        XCTAssertEqual(summary.text.components(separatedBy: "management.delete(").count - 1, 1)
        for opener in ["deviceToRevoke = device", "fileToDelete = row.file"] {
            XCTAssertTrue(summary.text.contains(opener), "the row button must open \(opener)")
        }
    }

    /// A rebuilt link has the same explicit Copy and Share hand-off as a newly
    /// generated one, and the three key states are decided in the tested seam.
    ///
    /// A `#k=` fragment IS the plaintext, so it may be written only by the
    /// explicit row-scoped Copy action and is never retained in feedback state.
    func testTheRebuiltLinkHasExplicitCredentialMinimizingHandoff() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("AccountPresentation.link(for: row.link)"),
                      "which of the three states a row is in belongs in the tested seam")
        XCTAssertTrue(summary.text.contains("ShareLink(item: link)"),
                      "the link must leave through the platform's hand-off")
        XCTAssertEqual(summary.text.components(separatedBy: "ShareLink(").count - 1, 1,
                       "one share affordance, in the one arm that has a link")
        XCTAssertTrue(summary.text.contains("UIPasteboard.general.string = link"))
        XCTAssertTrue(summary.text.contains("copiedStoredFileID = row.id"))
        XCTAssertTrue(summary.text.contains("AccountPresentation.copyActionLabel("))
        XCTAssertTrue(summary.text.contains("AccountPresentation.retainedCopiedFileID("))
        // Both unavailable states are rendered, and rendered differently: one is
        // permanent from this device, the other may be one unlock away.
        for arm in ["case .unavailable(let explanation):", "case .lookupFailed(let explanation):"] {
            XCTAssertTrue(summary.text.contains(arm), "the row no longer distinguishes \(arm)")
        }
    }

    /// Failure and warning states carry a symbol and readable text, never colour
    /// alone, and every progress indicator is labelled.
    ///
    /// A bare `ProgressView()` says nothing to VoiceOver and nothing to anybody
    /// on a screen with two lists loading at once. Red on its own says nothing
    /// under a colour filter, in Increase Contrast, or to a reader who cannot
    /// distinguish it.
    func testEveryManagementStateIsReadableWithoutColourOrSight() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertFalse(summary.text.contains("ProgressView()\n"),
                       "an unlabelled spinner reads as nothing")
        for labelled in ["ProgressView { Text(L10n.t(.accountLoadingDevices)) }",
                         "ProgressView { Text(L10n.t(.accountLoadingFiles)) }"] {
            XCTAssertTrue(summary.text.contains(labelled), "missing \(labelled)")
        }
        for state in [".accountNoDevices", ".accountNoFiles"] {
            XCTAssertTrue(summary.text.contains(state), "the empty state \(state) is not rendered")
        }
        // **Phase C moved this claim up rather than dropping it.** It used to
        // read: red is named exactly once, and the one expression that names it
        // draws a symbol too. The file now names no colour at all — every
        // failure, caveat and key-state notice goes through `InlineMessage`,
        // whose own guard (`testTheIOSAppHasOneTokenAndComponentLayerRatherThanFortyLiterals`
        // and the component itself) is what carries "a symbol beside every
        // kind". So the assertion here is the stronger one: this screen states
        // nothing in colour of its own, and its one failure helper is the
        // shared role rather than a fourth private copy of it.
        XCTAssertFalse(summary.text.contains("foregroundStyle(.red)"),
                       "a failure on this screen is stated in colour")
        XCTAssertFalse(summary.text.contains("foregroundStyle(.orange)"),
                       "a caveat on this screen is stated in colour")
        let helper = try XCTUnwrap(
            summary.text.range(of: "private func failureLine(_ text: String) -> some View {"))
        XCTAssertTrue(summary.text[helper.upperBound...]
            .hasPrefix("\n        InlineMessage(.warning, text)"),
                      "the one failure helper no longer delegates to the shared role")
        // Both key-state arms of a stored row are inline messages too, and they
        // are DIFFERENT kinds: a key that was never here is a fact, and a
        // keychain that could not be read may be one unlock away.
        XCTAssertTrue(summary.text.contains("InlineMessage(.info, explanation)"))
        XCTAssertTrue(summary.text.contains("InlineMessage(.warning, explanation)"))
        // The row actions are named for the row they belong to, which is the
        // only thing telling repeated action groups apart without sight.
        for label in ["AccountPresentation.revokeActionLabel(for: device)",
                      "AccountPresentation.openActionLabel(fileId: row.file.id)",
                      "AccountPresentation.shareActionLabel(fileId: row.file.id)",
                      "AccountPresentation.deleteActionLabel(fileId: row.file.id)"] {
            XCTAssertTrue(summary.text.contains(label), "missing accessibility label: \(label)")
        }
    }

    /// The cleanup warning is dismissible, and it is not a row error.
    ///
    /// It is raised after a delete the server CONFIRMED, so calling it a failure
    /// would send the user to retry an operation that already succeeded — and the
    /// row it would attach to is gone. What is left is a statement about what is
    /// still on this device, with nothing to retry and a way to put it away.
    func testTheCleanupWarningIsANonBlockingDismissibleNotice() throws {
        let summary = try XCTUnwrap(try sources().first { $0.name == "AccountSummaryView.swift" })
        XCTAssertTrue(summary.text.contains("management.keyCleanupWarning"))
        XCTAssertTrue(summary.text.contains("management.dismissKeyCleanupWarning()"),
                      "a warning with no way to dismiss it is a permanent one")
        XCTAssertTrue(summary.text.contains("management.loadError"),
                      "a whole-list failure is distinct from a per-row one")
        XCTAssertTrue(summary.text.contains("management.error(forRow: device.id)"))
        XCTAssertTrue(summary.text.contains("management.error(forRow: row.id)"))
        // Only the row in flight is disabled: a slow revoke on one device must
        // not freeze the rest of the list.
        XCTAssertTrue(summary.text.contains("management.isBusy(row: device.id)"))
        XCTAssertTrue(summary.text.contains("management.isBusy(row: row.id)"))
        XCTAssertFalse(summary.text.contains(".disabled(management.isLoading)"),
                       "loading must not disable rows that are not being changed")
    }

    /// Account-owned work is app-scoped. SwiftUI mounts a `TabView`'s tabs
    /// lazily and can tear down an off-screen one, so a view that owned the
    /// account context would silently stop isolating the moment the user was
    /// looking elsewhere — and an authenticated upload would keep running under
    /// an account that is gone.
    func testTheAccountContextIsNotDrivenByAView() throws {
        let all = try sources()
        let view = try XCTUnwrap(all.first { $0.name == "SendView.swift" })
        for symbol in ["SendAccountContext", "applyAccountContext", "accountContextChanged"] {
            XCTAssertFalse(view.text.contains(symbol),
                           "SendView must not drive the account: \(symbol)")
        }
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains(".observe("),
                      "the session observation belongs to the app scope")
    }

    /// A sign-out that lands between the button being enabled and the button
    /// being tapped.
    ///
    /// The enablement comes from `session.state`, which is a redraw behind; the
    /// action re-reads the token. So the refusal has to be in the ACTION, and
    /// `start(token:)` must be reachable only through it — otherwise the app
    /// starts an authenticated upload with an empty bearer and reports whatever
    /// the server says about it.
    ///
    /// A source guard because there is no view to drive: what it pins is that
    /// the read, the refusal and the start are one statement in one place.
    func testTheSendActionRefusesRatherThanStartingWithAnEmptyBearer() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        XCTAssertTrue(view.text.contains(
            "guard let token = session.bearerToken, !token.isEmpty else {"),
            "the bearer must be checked at the moment it is read")
        XCTAssertTrue(view.text.contains("upload.fail(L10n.t(.errorCloudUnauthorized))"),
                      "a missing bearer is an honest refusal, not an empty request")
        XCTAssertEqual(view.text.components(separatedBy: "upload.start(token:").count - 1, 1,
                       "a second start would be one that skipped the guard")
    }

    /// Resume is another authenticated start, but with more at stake: changing
    /// the model to uploading also hides the durable-job decision. It must keep
    /// that job interrupted and route to Account when live access disappeared.
    func testResumeRechecksFullAccountAccessBeforeChangingTheUploadState() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        guard let resume = view.text.range(of: "private func resume()"),
              let start = view.text.range(of: "upload.resume(token: token)",
                                          range: resume.lowerBound..<view.text.endIndex) else {
            return XCTFail("SendView lost its explicit resume action")
        }
        let action = view.text[resume.lowerBound..<start.upperBound]
        XCTAssertTrue(action.contains("guard let token = session.bearerToken, !token.isEmpty,"))
        XCTAssertTrue(action.contains(
            "case .allowed = AccountGate.from(session.state, bearer: token) else"))
        XCTAssertTrue(action.contains("onOpenAccount()"))
        XCTAssertLessThan(action.range(of: "AccountGate.from")!.lowerBound,
                          action.range(of: "upload.resume")!.lowerBound)
        XCTAssertEqual(view.text.components(separatedBy: "upload.resume(token:").count - 1, 1,
                       "a second resume would bypass the live account check")
    }

    /// The Photos binding is reusable, and that is a behaviour with no runtime a
    /// package test can observe: `PhotosPicker` keeps whatever was chosen, so
    /// choosing the SAME two photos again is no change and therefore no import —
    /// the app appears to ignore the user.
    ///
    /// The fix is three ordered statements: capture, reset, import FROM THE
    /// CAPTURE. Importing from the binding after resetting it would import
    /// nothing at all, which is why the order is guarded and not just the parts.
    func testThePhotosBindingIsCapturedResetAndImportedFromTheCapture() throws {
        let view = try XCTUnwrap(try sources().first { $0.name == "SendView.swift" })
        let capture = try XCTUnwrap(view.text.range(of: "let captured = items"))
        let reset = try XCTUnwrap(view.text.range(of: "picked = []"))
        let importFromCapture = try XCTUnwrap(view.text.range(of: "captured[index]"))
        XCTAssertTrue(capture.lowerBound < reset.lowerBound,
                      "the reset must not beat the capture, or nothing is imported")
        XCTAssertTrue(reset.lowerBound < importFromCapture.lowerBound,
                      "the binding must be reset before the import, or the same items never re-fire")
        // The decision itself lives in `PhotoPickerChange`, where it is tested:
        // an empty change is OUR OWN reset and must not become
        // `importPhotos(count: 0)`, which would clear a selection the user never
        // asked to clear.
        XCTAssertTrue(view.text.contains("PhotoPickerChange.decide(itemCount:"),
                      "the empty-change decision belongs in the tested seam")
    }

    /// `PhotosPicker` returns only what the user chose, out of process. That is
    /// exactly why it needs no library permission — declaring one would ask for
    /// access this app never takes. Same rule as the empty entitlements file.
    ///
    /// `UIBackgroundModes` is the other half: foreground-only is what the copy
    /// says, and a background mode here would make that copy a lie.
    func testTheInfoPlistClaimsNoPhotoLibraryAccessAndNoBackgroundMode() throws {
        let plist = try infoPlist()
        XCTAssertNil(plist["NSPhotoLibraryUsageDescription"])
        XCTAssertNil(plist["NSPhotoLibraryAddUsageDescription"])
        XCTAssertNil(plist["UIBackgroundModes"])
        // The same known, pending mismatch as the appex above: the iOS app still
        // declares nine while the shared package ships two. Kept as a literal so
        // it fails when iOS resumes and its plist is corrected, rather than
        // failing now for a Mac change it does not own. See
        // `testTheExtensionActivatesOnlyForFilesImagesAndMovies`.
        XCTAssertEqual(plist["CFBundleLocalizations"] as? [String],
                       ["en", "zh-Hans", "ja", "ko", "de", "fr", "ar", "es", "pt"],
                       "apps/ios/Relayium/Info.plist changed under a Mac-only lease, or "
                       + "iOS resumed and this should now derive from AppLanguage")
    }

    // MARK: - R3-E: the Direct tab

    private func direct() throws -> (name: String, text: String) {
        try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" })
    }

    /// Four tabs, and the shell still learns nothing about the account.
    ///
    /// Direct is the second tab with a half that needs one, and it is the first
    /// where the two halves sit side by side on one screen. So the temptation is
    /// sharper than it was in R3-C: a `session.state` switch up here would be
    /// the natural way to draw "create" and "join" differently, and it would
    /// take the anonymous receive tab with it.
    func testTheShellGainedTheDirectTabAndStillReadsNoSessionState() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("L10n.t(.tabDirect)"))
        XCTAssertTrue(root.text.contains(".tag(AppDestination.pairingCode)"))
        for accountish in ["session.state", "AccountGate", "bearerToken"] {
            XCTAssertFalse(root.text.contains(accountish),
                           "the shell reads \(accountish) — that would gate the receive tab")
        }
    }

    /// Both realtime models are app-scoped, built once, and — since R3-F — from
    /// the NEARBY factories, against one discovery model and one inbound room.
    ///
    /// Two claims, and the second is the one a diff hides. App-scoped, because a
    /// `TabView` tears an off-screen tab down and a live DataChannel must not go
    /// with it — the user checking their plan mid-transfer is exactly that.
    /// Nearby-wired, because the two direct surfaces drive the SAME two models
    /// and both same-network paths reach through the one room socket the
    /// discovery model owns; a second graph would be a second room membership
    /// and a device listed twice.
    func testTheRealtimeModelsAreAppScopedAndBuiltFromTheNearbyFactories() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        for scoped in ["@StateObject private var direct: RealtimeSessionModel",
                       "@StateObject private var directText: RealtimeTextSessionModel",
                       "@StateObject private var verification: VerificationPreference",
                       "@StateObject private var directSelection: DirectSendSelection",
                       "@StateObject private var directModes: DirectModeSelection",
                       "@StateObject private var foreground: ForegroundSessionCoordinator",
                       "@StateObject private var discovery: LanDiscoveryModel",
                       "@StateObject private var nearbyReceive: NearbyReceiveModel",
                       "@StateObject private var residency: NearbyResidencyCoordinator",
                       "@StateObject private var presence: TransferPresence",
                       "@StateObject private var navigation: AppNavigationModel"] {
            XCTAssertTrue(app.text.contains(scoped), "missing app-scoped owner: \(scoped)")
        }
        XCTAssertTrue(app.text.contains(
            "AppEnvironment.makeRealtimeModel(verification: verifying, nearby: nearby, inboundRoom: room)"),
                      "the file model must be wired to the one room socket")
        XCTAssertTrue(app.text.contains(
            "AppEnvironment.makeRealtimeTextModel(verification: verifying, nearby: nearby, inboundRoom: room)"),
                      "the text model must be wired to the one room socket")
        // `makeRealtimeTextModel(` is counted separately below: an acceptance
        // launch substitutes a deterministic model for the product one, which is
        // still ONE model — the invariant is a single owner, not a single
        // mention of the factory name.
        XCTAssertEqual(all.map {
            $0.text.components(separatedBy: "AppEnvironment.makeRealtimeTextModel(").count - 1
        }.reduce(0, +), 1, "a second product text model owner")
        XCTAssertEqual(all.map {
            $0.text.components(separatedBy: "UITestMode.makeRealtimeTextModel(").count - 1
        }.reduce(0, +), 1, "the acceptance substitution happens more than once")
        for once in ["makeRealtimeModel(", "VerificationPreference(",
                     "DirectModeSelection(",
                     "ForegroundSessionCoordinator(",
                     "makeLanDiscoveryModel(", "InboundRoom(", "makeNearbyReceiveModel(",
                     "makeLinkWorkspaceModel(",
                     "NearbyResidencyCoordinator(", "TransferPresence(", "AppNavigationModel("] {
            XCTAssertEqual(all.map { $0.text.components(separatedBy: once).count - 1 }.reduce(0, +), 1,
                           "\(once) is constructed more than once — a second owner")
        }
        // **`DirectSendSelection` is the one deliberate exception, and it is
        // exactly two.**
        //
        // Everything above is a single owner because a second one would be a
        // second answer to one question. This is not that: the two hold
        // DIFFERENT selections. `directSelection` is what the user staged before
        // connecting and is theirs until it is sent or cleared; `linkSelection`
        // is a send made INSIDE an open workspace, already committed and already
        // addressed to a peer on screen. One store for both would let a
        // post-connect send silently replace a batch the user still wanted for a
        // different device — the same reason the macOS link pane uses a private
        // `SelectionStore` rather than its destination's shared one.
        //
        // Pinned at exactly two rather than removed from the list, because a
        // THIRD would be an owner nobody decided on, and the security scopes
        // `SecurityScopedAccess` balances are per instance.
        XCTAssertEqual(all.map {
            $0.text.components(separatedBy: "DirectSendSelection(").count - 1
        }.reduce(0, +), 2,
                       "the pre-connect and in-workspace selections are two owners, and only two")
        // ONE preference object, shared by both models and by the control that
        // flips it. Two would be a toggle that moves a setting neither session
        // reads.
        XCTAssertTrue(app.text.contains(".environmentObject(verification)"))
    }

    /// Creating a code is gated; joining one is not, and is not merely enabled —
    /// it is rendered outside the gate entirely.
    ///
    /// This is the asymmetry the whole destination exists to express, and it is
    /// a server-side fact rather than a UI preference: minting reserves relay
    /// capacity billed to the account that created it, and joining reserves
    /// nothing and presents no credential. A gate around both halves would take
    /// away a capability that works signed out.
    func testCreatingACodeIsGatedAndJoiningIsRenderedOutsideTheGate() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("AccountGate.from(session.state, bearer: session.bearerToken)"),
                      "the gate must be built from the shared, tested mapping")
        XCTAssertTrue(view.text.contains("case let .allowed(access)"),
                      "only the allowed arm may carry a token")
        // The credential is read ONCE, to build the gate, and the only thing
        // that ever sees it afterwards is the gate's `.allowed` payload on its
        // way to the two mints. A second `session.bearerToken` would be a read
        // that skipped the mapping — which is how an empty-string bearer used to
        // reach the transport.
        XCTAssertEqual(view.text.components(separatedBy: "session.bearerToken").count - 1, 1,
                       "the credential must be read once, to build the gate")
        for action in ["createAndSend()", "createTextSession()"] {
            XCTAssertTrue(view.text.contains(action),
                          "the button must call \(action) without capturing a credential")
        }
        XCTAssertEqual(
            view.text.components(separatedBy:
                "guard case let .allowed(access) = gate else {").count - 1,
            2,
            "both create actions must re-read the live gate at the instant of use")
        for handoff in ["mintAndSendFiles(token: access.token)",
                        "mintAndJoinText(token: access.token)"] {
            XCTAssertTrue(view.text.contains(handoff),
                          "both mints must spend the token from that live gate read")
        }
        guard let joinCard = view.text.range(of: "private func joinCard("),
              let fileJoin = view.text.range(of: "private func joinToReceiveFiles()"),
              let fileCreate = view.text.range(of: "private func createAndSend()"),
              let textJoin = view.text.range(of: "private func joinTextSession()"),
              let textCreate = view.text.range(of: "private func createTextSession()") else {
            return XCTFail("DirectView no longer has a join half of its own")
        }
        // Isolate the shared join card and both receive actions. The two create
        // actions follow them in the same source file and MUST read the live
        // gate, so scanning to EOF would mistake the intended asymmetry for a
        // join dependency.
        let join = String(view.text[joinCard.lowerBound..<fileJoin.lowerBound])
            + String(view.text[fileJoin.lowerBound..<fileCreate.lowerBound])
            + String(view.text[textJoin.lowerBound..<textCreate.lowerBound])
        for gated in ["AccountGate", "access.token", "session.state"] {
            XCTAssertFalse(join.contains(gated),
                           "the join half reads \(gated) — joining needs no account")
        }
        XCTAssertTrue(view.text.contains("L10n.t(.directJoinNoAccountNeeded)"),
                      "and it has to say so, rather than leaving it to be discovered")
    }

    func testPairingModePickerExplainsThatTheReceiverMustMatchTheSender() throws {
        let view = try direct()
        let picker = try XCTUnwrap(view.text.components(
            separatedBy: "private var modePicker:").dropFirst().first?
            .components(separatedBy: "// MARK: - files").first)
        XCTAssertTrue(picker.contains("Text(L10n.t(.directModeMatchHint))"))
        XCTAssertTrue(picker.contains(".accessibilityHint(L10n.t(.directModeMatchHint))"))
        XCTAssertTrue(picker.contains(".accessibilityIdentifier(\"pairing-mode-match-hint\")"))
    }

    /// AccountGate exists to keep unlike failures unlike. Direct must not turn
    /// them all back into the same “open account” card.
    func testTheDirectCreateGateRendersEveryAccountStateTruthfully() throws {
        let view = try direct()
        let start = try XCTUnwrap(view.text.range(of: "private var capabilityGate:"))
        let end = try XCTUnwrap(view.text.range(of: "private var openAccountButton:"))
        let gate = view.text[start.lowerBound..<end.lowerBound]
        for state in ["case .allowed:", "case .loading:", "case .signInRequired:",
                      "case let .unavailable(message):", "case let .verifyEmail(email):",
                      "case let .pendingDeletion(purgeAfter, _):"] {
            XCTAssertTrue(gate.contains(state), "Direct flattens AccountGate's \(state)")
        }
        for truth in [".accountRestoring", ".gateCreateCodeTitle", ".gateCreateCodeBody",
                      "failureLine(message)", "await session.refresh()",
                      ".contentCheckEmailTitle", ".contentCheckEmailBody",
                      ".contentPendingDeletionTitle", ".contentPendingDeletionBody"] {
            XCTAssertTrue(gate.contains(truth), "Direct does not render \(truth)")
        }
        XCTAssertTrue(view.text.contains("if showsAnonymousNote"),
                      "the anonymous-join explanation is duplicated for gated users")
        XCTAssertTrue(view.text.contains("case .signInRequired: return false"),
                      "the ordinary sign-in card repeats the anonymous-join explanation")
        XCTAssertTrue(view.text.contains(
            "case .allowed, .loading, .unavailable, .verifyEmail, .pendingDeletion: return true"),
            "an unrelated account problem hides that joining still needs no account")
    }

    /// The join field is a six-digit numeric one-time code, normalized in the
    /// binding setter before every state write.
    ///
    /// Each clause is a real failure: the default keyboard makes a user hunt for
    /// the number row, no `oneTimeCode` content type means iOS never offers the
    /// code from a message, and normalizing anywhere but on every change is what
    /// used to eat a leading `1` — `normalizedPairingCode` keeps digits and
    /// caps at six, so a code beginning with 1 is only typeable if the filter
    /// runs on the raw text rather than on a parsed number.
    func testTheJoinFieldIsANumericOneTimeCodeNormalisedOnEveryChange() throws {
        let view = try direct()
        // ONE field, shared by both modes. Two would be two places for the
        // keyboard type, the content type and the normalization to drift, and
        // the drift is silent: a field that works and one that eats a leading
        // digit look identical in a screenshot.
        for wired in ["field.keyboardType = .numberPad",
                      "field.textContentType = .oneTimeCode"] {
            XCTAssertEqual(view.text.components(separatedBy: wired).count - 1, 1,
                           "the one UIKit join field must carry \(wired), exactly once")
        }
        // But each MODEL normalizes its own text, so both are wired to it.
        XCTAssertEqual(view.text.components(separatedBy: "updateJoinCode(").count - 1, 2,
                       "both models must normalize on every change")
        XCTAssertTrue(view.text.contains("let normalizedCode = Binding("))
        XCTAssertTrue(view.text.contains("set: { normalize($0) }"))
        XCTAssertTrue(view.text.contains("PairingCodeInput(text: normalizedCode"))
        XCTAssertTrue(view.text.contains("shouldChangeCharactersIn range: NSRange"))
        XCTAssertTrue(view.text.contains("field.text = normalized"))
        XCTAssertTrue(view.text.contains("parent.text = normalized"))
        XCTAssertTrue(view.text.contains("return false"),
                      "UIKit must not apply the raw edit again after normalization")
        XCTAssertFalse(view.text.contains(".onChange(of: code.wrappedValue)"),
                       "a second state write can race fast typing or AutoFill")
        XCTAssertFalse(view.text.contains("Int("),
                       "a code is a string; an Int round trip would destroy 004291")
    }

    /// The code the user reads off this screen is monospaced, selectable, and
    /// spoken one digit at a time.
    ///
    /// A six-digit code read as a NUMBER is "four hundred eighty-three thousand
    /// nine hundred twenty", which nobody can type into the other device — which
    /// is the entire task this screen exists for.
    func testTheDisplayedCodeIsMonospacedAndSpokenAsDigits() throws {
        let code = try XCTUnwrap(try sources().first { $0.name == "PairingCodeText.swift" })
        XCTAssertTrue(code.text.contains("design: .monospaced"),
                      "a proportional font makes a transcribed code ambiguous")
        XCTAssertTrue(code.text.contains(".accessibilityLabel(spokenCode)"))
        XCTAssertTrue(code.text.contains("joined(separator: \" \")"),
                      "the digits must be separated so VoiceOver reads them one at a time")
        XCTAssertTrue(code.text.contains("L10n.token(code)"),
                      "the code must be bidi-isolated so Arabic does not reverse it")
    }

    /// The Files/Text choice goes through the locked selection, never a raw
    /// binding.
    ///
    /// `$modes.mode` would be a `Picker` writing straight into the model, and a
    /// `.disabled` modifier is a courtesy rather than the mechanism — SwiftUI
    /// still owns the binding behind a disabled control. The refusal has to be
    /// in `DirectModeSelection.select`, where `DirectModeSelectionTests` drives
    /// it against every state of both models.
    func testTheModeChoiceGoesThroughTheLockedSelectionAndNotARawBinding() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("modes.select("),
                      "the mode must change through the guarded entry point")
        XCTAssertTrue(view.text.contains("sessionClaimed: presence.owner != nil"),
                      "the lock must cover claim-before-model-start as well as model states")
        XCTAssertFalse(view.text.contains("$modes.mode"),
                       "a raw binding lets a rebuild move the mode under a running session")
    }

    /// A terminal session is still owned until Done, so it cannot also expose
    /// the controls that replace it with a new one.
    ///
    /// `DirectModeSelection` already locks the Files/Text picker for these
    /// states. That is not enough by itself: if Create or Join remains in the
    /// terminal switch arm, the user can replace the model while its result,
    /// partial receive or memory-only transcript is still on screen. Pin the
    /// view wiring at the state boundary where that regression occurs.
    func testTerminalDirectSessionsExposeOnlyDoneBeforeAnotherSessionCanStart() throws {
        let view = try direct()

        let filesStart = try XCTUnwrap(view.text.range(of: "private var filesMode:"))
        let filesEnd = try XCTUnwrap(view.text.range(of: "private var createFiles:"))
        let files = view.text[filesStart.lowerBound..<filesEnd.lowerBound]
        let fileIdleStart = try XCTUnwrap(files.range(of: "case .idle:"))
        let fileFailedStart = try XCTUnwrap(files.range(of: "case let .failed(message):"))
        let fileMintingStart = try XCTUnwrap(files.range(of: "case .minting:"))
        let fileIdle = files[fileIdleStart.lowerBound..<fileFailedStart.lowerBound]
        let fileFailed = files[fileFailedStart.lowerBound..<fileMintingStart.lowerBound]
        XCTAssertTrue(fileIdle.contains("createFiles"))
        XCTAssertTrue(fileIdle.contains("joinCard("))
        XCTAssertTrue(fileFailed.contains("L10n.t(.commonDone)"))
        XCTAssertTrue(fileFailed.contains(".buttonStyle(.bordered)"))
        XCTAssertTrue(fileFailed.contains(".controlSize(.large)"))
        XCTAssertFalse(fileFailed.contains("createFiles"),
                       "a failed file session can be replaced before cleanup")
        XCTAssertFalse(fileFailed.contains("joinCard("),
                       "a failed file session can join before cleanup")

        let textStart = try XCTUnwrap(view.text.range(of: "private var textMode:"))
        let textEnd = try XCTUnwrap(view.text.range(of: "private var createText:"))
        let text = view.text[textStart.lowerBound..<textEnd.lowerBound]
        let textIdleStart = try XCTUnwrap(text.range(of: "case .idle:"))
        let textTerminalStart = try XCTUnwrap(
            text.range(of: "case .failed, .ended, .refused, .unsupported:"))
        let textMintingStart = try XCTUnwrap(text.range(of: "case .minting:"))
        let textIdle = text[textIdleStart.lowerBound..<textTerminalStart.lowerBound]
        let textTerminal = text[textTerminalStart.lowerBound..<textMintingStart.lowerBound]
        XCTAssertTrue(textIdle.contains("createText"))
        XCTAssertTrue(textIdle.contains("joinCard("))
        XCTAssertTrue(textTerminal.contains("DirectTextSessionView(model: text)"))
        XCTAssertTrue(textTerminal.contains("L10n.t(.commonDone)"))
        XCTAssertTrue(textTerminal.contains(".buttonStyle(.bordered)"))
        XCTAssertTrue(textTerminal.contains(".controlSize(.large)"))
        XCTAssertFalse(textTerminal.contains("createText"),
                       "a terminal transcript can be replaced before Done")
        XCTAssertFalse(textTerminal.contains("joinCard("),
                       "a terminal transcript can join another session before Done")
    }

    /// The receive folder is resolved BEFORE a connection is opened, and a
    /// failure to resolve it connects nothing.
    ///
    /// The order is the whole point. `RealtimeSessionModel.saveDirectory`
    /// defaults to Downloads — which on iOS is a directory in nobody's
    /// container — so a join that ran before the destination was set would
    /// connect, handshake, accept a manifest and only then discover it has
    /// nowhere to write, with the peer already sending. And the fallback is the
    /// other half: quietly writing to `temporaryDirectory` would put the user's
    /// files somewhere iOS deletes without warning and the Files app never
    /// shows.
    func testTheReceiveDestinationIsResolvedBeforeJoiningAndNeverFallsBack() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains("try ReceiveDestination.directory()"),
                      "the destination must come from the shared, container-aware seam")
        XCTAssertTrue(view.text.contains("ReceiveDestinationCopy.message(for: error, in: .appFolder)"),
                      "a failure must render the iOS Files-app recovery, not the picker advice")
        // The RESPONDER join specifically, named exactly: the initiator join
        // elsewhere in this file sends rather than receives and has no
        // destination to resolve, so matching "any join" would pass on the
        // wrong one.
        guard let resolve = view.text.range(of: "try ReceiveDestination.directory()"),
              let install = view.text.range(of: "file.saveDirectory = destination"),
              let joinCall = view.text.range(of: "await file.join(code: code)") else {
            return XCTFail("DirectView no longer resolves a destination before joining")
        }
        XCTAssertTrue(resolve.upperBound < install.lowerBound,
                      "the resolved destination was never installed on the model")
        XCTAssertTrue(install.upperBound < joinCall.lowerBound,
                      "the join must sit after the destination is set, not beside it")
        for fallback in ["temporaryDirectory", "downloadsDirectory", ".cachesDirectory"] {
            for (name, text) in try sources() {
                XCTAssertFalse(text.contains(fallback),
                               "\(name) writes received files to \(fallback)")
            }
        }
    }

    /// File preparation is not a session. If it fails, the explanation for an
    /// earlier background interruption must remain until the user dismisses it
    /// or a real new attempt starts.
    func testDirectFileCreatePreparesAndRechecksTheAccountBeforeStartingASession() throws {
        let view = try direct()
        let start = try XCTUnwrap(view.text.range(of: "private func createAndSend()"))
        let end = try XCTUnwrap(view.text.range(of: "private func joinTextSession()"))
        let action = view.text[start.lowerBound..<end.lowerBound]
        let prepare = try XCTUnwrap(action.range(of: "selection.stageForSend()"))
        let account = try XCTUnwrap(action.range(of:
            "guard case let .allowed(access) = gate else {"))
        let session = try XCTUnwrap(action.range(of: "foreground.sessionStarting()"))
        let stage = try XCTUnwrap(action.range(of: "file.stageSend("))
        XCTAssertTrue(prepare.lowerBound < account.lowerBound)
        XCTAssertTrue(account.lowerBound < session.lowerBound)
        XCTAssertTrue(session.lowerBound < stage.lowerBound,
                      "the interruption notice must clear only once a real session starts")
    }

    /// The share affordance is built from `model.received`, which is non-nil
    /// only in `.completed` — which the model reaches only after
    /// `ManifestWriter.finish()` returned. Nothing here can offer a file that is
    /// still being written, and a folder receive shares its CONTAINER so the
    /// hierarchy survives *Save to Files*.
    func testTheReceivedResultIsShareableOnlyAfterTheWriterFinished() throws {
        let session = try XCTUnwrap(
            try sources().first { $0.name == "DirectFileSessionView.swift" })
        XCTAssertTrue(session.text.contains("if let payload = model.received"),
                      "the result must come from the model's post-finish payload")
        XCTAssertTrue(session.text.contains("ShareLink(items: payload.dragURLs)"),
                      "a foldered receive must share its container as one item")
        XCTAssertFalse(session.text.contains("ShareLink(items: urls)"),
                       "sharing the flat file list would flatten the folder at the destination")
    }

    /// **The pasteboard is written only by buttons the user pressed, and is
    /// never read.**
    ///
    /// This replaces the blanket ban `UIPasteboard` carried through four slices.
    /// A text session has to offer Copy — a message the user cannot get out of
    /// the app is a message they have to retype — and the honest shape of that
    /// is one write inside one action. Reading is a different thing entirely: an
    /// app that inspects the clipboard is doing what this product promises not
    /// to, and iOS raises its own paste notification for it besides.
    func testThePasteboardIsWrittenOnlyInsideAnExplicitCopyActionAndNeverRead() throws {
        let all = try sources()
        let holders = all.filter { $0.text.contains("UIPasteboard") }.map(\.name).sorted()
        XCTAssertEqual(holders, ["AccountSummaryView.swift", "DirectTextSessionView.swift",
                                 "DirectView.swift", "SendView.swift"],
                       "the pasteboard is reachable from somewhere other than Copy")
        let expectedWrites = [
            "AccountSummaryView.swift": "UIPasteboard.general.string = link",
            "DirectTextSessionView.swift": "UIPasteboard.general.string = text",
            "DirectView.swift": "UIPasteboard.general.string = url.absoluteString",
            "SendView.swift": "UIPasteboard.general.string = link",
        ]
        for (name, write) in expectedWrites {
            let view = try XCTUnwrap(all.first { $0.name == name })
            XCTAssertEqual(view.text.components(separatedBy: "UIPasteboard").count - 1, 1,
                           "\(name) must have one pasteboard mention to review")
            XCTAssertTrue(view.text.contains(write),
                          "\(name) must only write the value its Copy button belongs to")
        }
        // Every read API, by name. `.string =` above is an assignment; these are
        // the forms that take something OUT.
        for view in all {
            for reader in ["UIPasteboard.general.string)", "UIPasteboard.general.hasStrings",
                           "UIPasteboard.general.items", "UIPasteboard.general.strings",
                           "UIPasteboard.general.url", "UIPasteboard.general.changeCount",
                           "detectPatterns", "value(forPasteboardType"] {
                XCTAssertFalse(view.text.contains(reader),
                               "\(view.name) inspects the clipboard: \(reader)")
            }
        }
        let view = try XCTUnwrap(all.first { $0.name == "DirectTextSessionView.swift" })
        XCTAssertTrue(view.text.contains("Button {"),
                      "the write must belong to an explicit button action")
        XCTAssertTrue(view.text.contains(
            "copiedMessageID == message.id ? .commonCopied : .commonCopy"),
            "the per-message button must remain Copy and acknowledge its write")
        XCTAssertTrue(view.text.contains("ShareLink(item: message.body)"),
                      "ephemeral text has no explicit system handoff")
        XCTAssertTrue(view.text.contains("TextMessagePresentation.copyActionLabel("),
                      "Copied feedback loses its sent/received row context")
        XCTAssertTrue(view.text.contains("TextMessagePresentation.shareActionLabel("),
                      "Share is indistinguishable across sent and received rows")
        XCTAssertTrue(view.text.contains("L10n.t(.textClipboardNotice)"),
                      "and the screen must say what a copy costs")
    }

    /// **`.inactive` is not `.background`,** and this is where that gets got
    /// wrong.
    ///
    /// SwiftUI reports `.inactive` while a document picker, a share sheet or the
    /// app switcher is up — which is to say, at the exact moment the user is
    /// choosing the files they are about to send. A mapping that folded it into
    /// `.background` would cancel the session on the way into the picker, every
    /// time, and would read as the picker being broken. The decision itself is
    /// `ForegroundSessionCoordinator`'s, where a test drives it; this pins the
    /// one line that feeds it.
    func testTheScenePhaseObserverDistinguishesInactiveFromBackground() throws {
        let all = try sources()
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("@Environment(\\.scenePhase) private var scenePhase"))
        XCTAssertTrue(app.text.contains("case .background: return .background"))
        XCTAssertTrue(app.text.contains("case .inactive: return .inactive"),
                      "a picker or a share sheet must not end the session")
        // Through the residency coordinator, which owns the ORDER: leaving the
        // room has to happen before R3-E's session cleanup, and an order split
        // across two `onChange` calls in a scene body is an order no test can
        // reach. `NearbyResidencyCoordinatorTests` drives it.
        XCTAssertTrue(app.text.contains("residency.phaseChanged(to: lifecycle(phase))"))
        XCTAssertFalse(app.text.contains("foreground.phaseChanged("),
                       "a second lifecycle path would let the room outlive the session cleanup")
        // Exactly one observer, at the app scope: a second in a view would fire
        // only while that view was mounted, which is precisely when it is not.
        // Three occurrences, all in `RelayiumApp`: twice on the `@Environment`
        // declaration (the key path and the property name) and once in the
        // `onChange` that reads it. A fourth would be a second reader.
        XCTAssertEqual(all.map { $0.text.components(separatedBy: "scenePhase").count - 1 }
                          .reduce(0, +), 3,
                       "the scene phase is declared and read in exactly one place")
        for (name, text) in all where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("phaseChanged("),
                           "\(name) is a second lifecycle observer")
        }
    }

    /// The advanced-verification setting is on screen, and it is the shared
    /// preference object rather than a local toggle.
    ///
    /// Default OFF is `VerificationPreference`'s own decision and
    /// `VerificationPreference`'s tests prove it. What this pins is that the
    /// setting is REACHABLE — a security control that only exists on macOS is a
    /// control iOS users cannot turn on — and that flipping it moves the object
    /// both models read, rather than a `@State` nothing consults.
    func testTheVerificationSettingIsVisibleAndIsTheSharedPreference() throws {
        let view = try direct()
        XCTAssertTrue(view.text.contains(
            "set: { if !isLocked { verification.requiresSASConfirmation = $0 } }"),
                      "the shared preference must refuse changes after session claim")
        XCTAssertFalse(view.text.contains("isOn: $verification.requiresSASConfirmation"),
                       "a raw binding can change verification during claim-before-handshake")
        for explanation in [".verifyExplainWhat", ".verifyExplainEncryption"] {
            XCTAssertTrue(view.text.contains(explanation),
                          "the setting must say what it does and does not change: \(explanation)")
        }
        XCTAssertFalse(view.text.contains("@State private var requiresSAS"),
                       "a view-local copy would be a setting no session reads")
    }

    /// Direct says what it is for, and hands the large-file case to the tab that
    /// can actually carry it.
    ///
    /// A peer-to-peer transfer that needs both apps open is genuinely worse than
    /// the stored one for a large file, and a user who discovers that ninety
    /// seconds in has been misled by omission. The route out is a tab selection,
    /// which is why it arrives as a closure — the same shape `SendView` already
    /// uses for the account, and the reason `RootView` can stay ignorant.
    func testDirectPositionsItselfAndRoutesLargeFilesToTheStoredSendTab() throws {
        let view = try direct()
        for copy in [".navPairingCodeSubtitle", ".directLargeFilesTitle",
                     ".directLargeFilesBody", ".directOpenSend", ".directKeepBothOpen"] {
            XCTAssertTrue(view.text.contains(copy), "the positioning copy \(copy) is not rendered")
        }
        XCTAssertTrue(view.text.contains("onOpenSend"),
                      "the large-file route must be a tab selection handed down")
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("onOpenSend: { navigation.select(.storedSend) }"),
                      "and the shell must be the thing that performs it")
    }

    /// Progress is labelled and failure is never colour alone — the same two
    /// rules R3-D's account surface holds, on the two new session screens.
    func testTheDirectSessionScreensAreReadableWithoutColourOrSight() throws {
        let all = try sources()
        for name in ["DirectView.swift", "DirectFileSessionView.swift",
                     "DirectTextSessionView.swift"] {
            let view = try XCTUnwrap(all.first { $0.name == name })
            XCTAssertFalse(view.text.contains("ProgressView()\n"),
                           "\(name) has an unlabelled spinner, which reads as nothing")
            XCTAssertFalse(view.text.contains("foregroundStyle(.red)"),
                           "\(name) states a failure in colour")
        }
        let session = try XCTUnwrap(all.first { $0.name == "DirectFileSessionView.swift" })
        XCTAssertTrue(session.text.contains("L10n.percent(done: done, total: total)"),
                      "a progress bar with no figure beside it says nothing to VoiceOver")
    }

    /// No AppKit, anywhere. It compiles on macOS and not on iOS, so a copied
    /// `NSPasteboard` line from the Mac panes is a build failure rather than a
    /// silent one — but the guard is here because the Mac views this slice is
    /// modelled on are full of them, and the copy is the obvious way to write it.
    func testNoIOSSurfaceReachesForAppKit() throws {
        for (name, text) in try sources() {
            for appKitism in ["import AppKit", "NSPasteboard", "NSOpenPanel", "NSAlert",
                              "NSApplication", "NSWindow"] {
                XCTAssertFalse(text.contains(appKitism), "\(name) reaches for \(appKitism)")
            }
        }
    }

    // MARK: - R3-F: the Nearby tab

    private func nearby() throws -> (name: String, text: String) {
        try XCTUnwrap(try sources().first { $0.name == "NearbyView.swift" })
    }

    /// Five tabs, and the shell still learns nothing about the account.
    ///
    /// Nearby is the second anonymous tab and the first that an *incoming*
    /// session can select on its own, so the selection had to move from a
    /// `@State` in this view to an app-scoped model: a `@State` is reset when
    /// SwiftUI rebuilds the tree, and the moment that matters is a session
    /// arriving while the user is somewhere else.
    func testTheShellGainedTheNearbyTabAndRoutesFromAnAppScopedSelection() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        for tag in [".tag(AppDestination.storedReceive)", ".tag(AppDestination.storedSend)",
                    ".tag(AppDestination.pairingCode)", ".tag(AppDestination.nearby)",
                    ".tag(AppDestination.account)"] {
            XCTAssertTrue(root.text.contains(tag), "the tab set is missing \(tag)")
        }
        XCTAssertTrue(root.text.contains("TabView(selection: $navigation.selection)"),
                      "the selection must survive an incoming session rebuilding the tree")
        XCTAssertFalse(root.text.contains("@State private var selection"),
                       "a view-local selection cannot be routed to from outside the view")
        for accountish in ["session.state", "AccountGate", "bearerToken"] {
            XCTAssertFalse(root.text.contains(accountish),
                           "the shell reads \(accountish) — that would gate the anonymous tabs")
        }
    }

    /// **iOS never selects the macOS-only Device Inbox destination.**
    ///
    /// `AppDestination` is deliberately one vocabulary for both shells, so the
    /// two cannot drift into routing from two enums. The cost of sharing it is
    /// this: macOS gained a sixth case for a resident receiver iOS does not have,
    /// and a `TabView` handed a selection with no matching `.tag` renders an
    /// empty tab — no error, no fallback, just a screen with nothing on it.
    ///
    /// The tab set above is checked to name five destinations; this is the other
    /// half, and it is the half that catches the accident. A `navigation.select`
    /// or an `AppRouting` answer that reached iOS with `.deviceInbox` in it would
    /// leave the app on a blank tab the user cannot leave except by tapping
    /// another one, and nothing in the tab list would look wrong.
    func testNoIOSSurfaceCanSelectTheMacOnlyDeviceInboxDestination() throws {
        for (name, text) in try sources() {
            XCTAssertFalse(text.contains("deviceInbox"),
                           "\(name) names the macOS-only Device Inbox destination; the iOS "
                           + "tab bar has no tag for it and would render an empty tab")
        }
        // And the shared routing rule keeps iOS out of it by construction: the
        // only destinations it can produce are ones the tab bar has tags for.
        for kind in NearbyReceiveKind.allCases {
            XCTAssertNotEqual(AppRouting.destination(forIncoming: kind), .deviceInbox)
        }
        for destination in AppDestination.allCases {
            XCTAssertNotEqual(AppRouting.destination(forOpenedFiles: destination), .deviceInbox,
                              "an opened file routes to a destination iOS cannot render")
        }
    }

    /// **Nearby is anonymous in both directions, and it is enforced by not
    /// naming the account rather than by remembering not to gate it.**
    ///
    /// The code-less room mints nothing and `/api/ice` answers it STUN-only, so
    /// both directions genuinely reach the transport with no credential. An
    /// `@EnvironmentObject` this view merely DECLARED would also crash it in
    /// any build where the object was absent, which is the sharper reason the
    /// ban is on the name.
    func testTheNearbyTabNamesNoAccountAtAll() throws {
        let view = try nearby()
        for accountish in ["AccountSession", "AccountGate", "bearerToken", "session.state",
                           "mintCode", "onOpenAccount"] {
            XCTAssertFalse(view.text.contains(accountish),
                           "NearbyView reaches for \(accountish) — this tab needs no account")
        }
        XCTAssertTrue(view.text.contains("L10n.t(.nearbyNoAccountNeeded)"),
                      "and it must say so, rather than leaving it to be discovered")
    }

    /// The three sentences the roster cannot be shown without.
    ///
    /// A list of device names is read as "the devices on my Wi-Fi" unless it is
    /// told otherwise, and here it is not true: the room is grouped by the
    /// public address the server observes, which a carrier or VPN gateway can
    /// share with strangers, and the names are peer-supplied labels.
    func testTheRosterStatesWhatItIsAndWhatTheNamesAreNot() throws {
        let view = try nearby()
        for copy in [".nearbySafetySummary", ".nearbyExplain", ".nearbyNamesDisclaimer",
                     ".nearbyEmptyRoster"] {
            XCTAssertTrue(view.text.contains(copy), "the roster does not render \(copy)")
        }
    }

    /// **The mechanism paragraph is one tap away; the warning is not.**
    ///
    /// Rendered open at the top, that paragraph was the whole first screen —
    /// and at the largest accessibility content sizes, several of them, with no
    /// control reachable until the user had scrolled past it. So the sentence
    /// that changes a decision stays in the layout and the explanation moves
    /// into a disclosure that starts closed.
    ///
    /// The order is asserted, not just the presence: a summary placed *below*
    /// the disclosure would pass a containment check while leaving the screen
    /// exactly as it was.
    func testTheMechanismParagraphIsBehindALabelledDisclosureAndTheWarningIsNot() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains("@State private var showsMechanism = false"),
                      "the disclosure must start closed, every time the tab is built")
        XCTAssertTrue(view.text.contains("DisclosureGroup(isExpanded: $showsMechanism)"),
                      "the explanation is not behind a disclosure this view controls")
        XCTAssertTrue(view.text.contains("L10n.t(.nearbyHowItWorks)"),
                      "an unlabelled chevron is an explanation nobody opens")

        let summary = try XCTUnwrap(view.text.range(of: "L10n.t(.nearbySafetySummary)"))
        let group = try XCTUnwrap(view.text.range(of: "DisclosureGroup(isExpanded:"))
        let paragraph = try XCTUnwrap(view.text.range(of: "L10n.t(.nearbyExplain)"))
        XCTAssertTrue(summary.lowerBound < group.lowerBound,
                      "the always-visible warning is drawn after the disclosure")
        XCTAssertTrue(group.lowerBound < paragraph.lowerBound,
                      "the paragraph is still drawn outside the disclosure")
        XCTAssertEqual(view.text.components(separatedBy: "L10n.t(.nearbyExplain)").count - 1, 1,
                       "a second copy of the paragraph would put it back on the first screen")

        // Not a preference: a remembered "open" restores exactly the layout
        // this refinement removes, on the content size where it hurts most.
        for persisted in ["@AppStorage", "UserDefaults"] {
            XCTAssertFalse(view.text.contains(persisted),
                           "NearbyView persists disclosure state through \(persisted)")
        }
    }

    /// **Nothing preselects a device, ever.**
    ///
    /// Not even when the room holds exactly one other entry — that is precisely
    /// the case where a stranger behind the same carrier gateway is the only
    /// candidate. Selection is the user's single explicit act, and the model's
    /// `select`/`clearSelection` are the only ways it moves.
    func testNoDeviceIsEverSelectedOnTheUsersBehalf() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains("discovery.select(device.id)"))
        XCTAssertTrue(view.text.contains("discovery.clearSelection()"))
        // Exactly one call site, and it is the row's own tap handler. A second
        // — in an `onAppear`, a `task(id:)`, or beside a roster update — is how
        // "the only device in the room" becomes the selected one.
        XCTAssertEqual(view.text.components(separatedBy: "discovery.select(").count - 1, 1,
                       "NearbyView selects a device from somewhere other than the row")
        for autoSelect in ["devices.first", "devices.count == 1", "onAppear"] {
            XCTAssertFalse(view.text.contains(autoSelect),
                           "NearbyView picks a device for the user: \(autoSelect)")
        }
    }

    /// The chosen device is re-read at the instant Send is pressed.
    ///
    /// The roster is live. A device that left between the row being drawn and
    /// the button being pressed must not be dialled by an id captured at render
    /// time — the id may by then belong to a different device entirely, and the
    /// room is not an identity.
    func testSendingReReadsTheSelectedDeviceInsteadOfCapturingIt() throws {
        let view = try nearby()
        for action in ["private func sendFiles()", "private func startText()"] {
            guard let start = view.text.range(of: action) else {
                return XCTFail("NearbyView no longer has \(action)")
            }
            let body = view.text[start.lowerBound...].prefix(1200)
            XCTAssertTrue(body.contains("guard let device = discovery.selectedDevice"),
                          "\(action) does not re-read the selection at the moment of use")
            XCTAssertTrue(body.contains("L10n.t(.nearbyDeviceGone)"),
                          "\(action) must say why nothing was sent")
        }
    }

    /// Both direct surfaces drive the SAME app-scoped objects.
    ///
    /// Rendered side by side they would show one session twice, each copy with
    /// its own Cancel; staged twice they would take two sets of security scopes
    /// for one selection; asked the mode twice they would be two answers to one
    /// question. So the shell hands the same five objects to both tabs and
    /// neither one owns any of them.
    func testBothDirectTabsShareTheOneSetOfOwners() throws {
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        for shared in ["file: direct", "text: directText", "selection: directSelection",
                       "modes: directModes"] {
            XCTAssertEqual(root.text.components(separatedBy: shared).count - 1, 2,
                           "\(shared) is not handed to both direct tabs")
        }
        for view in ["NearbyView.swift", "DirectView.swift"] {
            let source = try XCTUnwrap(try sources().first { $0.name == view })
            for owning in ["@StateObject private var file", "@StateObject private var text",
                           "@StateObject private var selection", "@StateObject private var modes",
                           "DirectSendSelection()", "DirectModeSelection()"] {
                XCTAssertFalse(source.text.contains(owning),
                               "\(view) owns \(owning) instead of being handed it")
            }
        }
    }

    /// Exactly one tab draws the session, and the other one says where it is.
    ///
    /// Not a nicety: a second copy of a live session comes with a second Cancel
    /// for one transfer, and a second Done over one retained transcript. The
    /// arbitration is `TransferPresence`; what this pins is that BOTH tabs
    /// consult it and that the loser offers navigation rather than a dead end.
    func testExactlyOneDirectTabRendersTheSessionAndTheOtherPointsAtIt() throws {
        // The exact condition, not merely a mention of `presence`. A branch that
        // names the object and then decides from `isBusy` anyway reads as
        // arbitrated and is not: `isBusy` is true for BOTH tabs at once, because
        // it is a property of the shared models rather than of who owns them.
        for (name, mine) in [("NearbyView.swift", "nearby"),
                             ("DirectView.swift", "pairingCode")] {
            let view = try XCTUnwrap(try sources().first { $0.name == name })
            XCTAssertTrue(view.text.contains("if let owner = presence.owner, owner != .\(mine) {"),
                          "\(name) does not stand aside for the other tab's session")
            XCTAssertTrue(view.text.contains("busyElsewhere(owner)"),
                          "\(name) stands aside without saying so")
            for copy in [".presenceBusyTitle", ".presenceBusyBody", ".presenceShowIt"] {
                XCTAssertTrue(view.text.contains(copy),
                              "\(name) leaves the user on a dead end: \(copy)")
            }
        }
        // Nearby is the one that also has a roster to fall back to, so its own
        // session must be drawn on OWNERSHIP rather than on activity — the
        // difference is a claimed-but-not-yet-connected session, which is
        // exactly the window an inbound offer lives in.
        //
        // It used to check for `presence.rendersSession(.nearby)` inline. That
        // moved to `TransferSurfacePresentation.pane`, which is the SAME rule —
        // it returns `.connect` for any route that is not the owner, whatever
        // the link holds — now shared with macOS instead of written twice. What
        // this pins is that the tab asks it and switches on all three answers,
        // so a later edit cannot quietly reintroduce an activity-based branch.
        let nearbyView = try nearby()
        XCTAssertTrue(nearbyView.text.contains("TransferSurfacePresentation.pane(route: .nearby,"),
                      "the nearby session is drawn from something other than ownership")
        for arm in ["case .link:", "case .legacySession:", "case .connect:"] {
            XCTAssertTrue(nearbyView.text.contains(arm),
                          "the nearby tab does not decide \(arm) — a pane would render nothing")
        }
        XCTAssertFalse(nearbyView.text.contains("default:"),
                       "a defaulted pane arm would silently absorb a fourth surface")
    }

    /// **Ownership is released only at idle**, from one place.
    ///
    /// `.completed` still owns the received files and the share sheet built on
    /// them; `.ended`, `.failed`, `.refused` and `.unsupported` still own a
    /// transcript that exists in no other copy. Releasing when the bytes stop
    /// would blank the surface the user is still reading. `.idle` is the only
    /// state that means there is nothing left to present — and the reconciliation
    /// lives in the shell, which is mounted whichever tab is on screen, rather
    /// than in the tab that happens to have claimed it.
    func testOwnershipIsReleasedOnlyWhenBothModelsAreIdle() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })
        let root = try XCTUnwrap(try sources().first { $0.name == "RootView.swift" })
        // The LINK-aware overload, and it must be that one. A link uses neither
        // legacy model, so both of them read `.idle` for its whole life — the
        // two-model overload would release the surface the instant a link
        // started, and the tab would return to the roster with a live connection
        // running behind it. Same single subscription, three liveness sources.
        XCTAssertTrue(app.text.contains(
            "presenting.observeSessions(fileModel: files, textModel: texts, link: unified)"),
                      "session cleanup must survive tab/root teardown, and must include the link")
        XCTAssertFalse(root.text.contains("presence.releaseAll()"),
                       "an initial idle render can erase a claim before model start")
        for name in ["NearbyView.swift", "DirectView.swift", "RootView.swift"] {
            let view = try XCTUnwrap(try sources().first { $0.name == name })
            XCTAssertFalse(view.text.contains("presence.releaseAll()"),
                           "\(name) releases a session it may not own")
        }
    }

    /// Residency is started from the coordinator that owns the ordering, and
    /// from exactly one place.
    ///
    /// The order — resolve the receive folder, install it on the model, THEN
    /// join the room — is what stops this device advertising itself as
    /// reachable with nowhere to write. A view that called `startResident()`
    /// itself would be a second entry point with none of that.
    func testResidencyIsOnlyEverStartedThroughTheCoordinator() throws {
        let all = try sources()
        for (name, text) in all {
            for bypass in ["startResident()", "discovery.start()", "discovery.stop()"] {
                XCTAssertFalse(text.contains(bypass),
                               "\(name) bypasses the residency coordinator: \(bypass)")
            }
        }
        // The two remaining direct resolves are both answers to a link or a
        // code the user acted on, not residency: R3-A's stored receive and
        // R3-E's pairing-code responder join. Neither advertises this device,
        // so neither has an order to get wrong. Anything else resolving it is
        // a second residency path with none of the ordering above.
        XCTAssertEqual(all.filter { $0.text.contains("ReceiveDestination.directory()") }
                          .map(\.name).sorted(),
                       ["DirectView.swift", "ReceiveView.swift"],
                       "the receive folder is resolved somewhere that does not own the order")
        let view = try nearby()
        for through in ["residency.pause()", "residency.resume()", "residency.refresh()",
                        "residency.retry()", "residency.destinationError"] {
            XCTAssertTrue(view.text.contains(through), "the nearby tab cannot reach \(through)")
        }
    }

    /// An inbound session settles its surface, its mode and its tab in ONE
    /// synchronous call, before the responder is built.
    ///
    /// Three separate writes in a SwiftUI closure could be reordered by a later
    /// edit, and any interleaving that puts a write after the `await` inside
    /// `NearbyReceiveModel.accept` loses the race it exists to win.
    /// `AppRoutingTests` drives the function itself.
    func testAnIncomingSessionClaimsItsSurfaceThroughTheOneRoutingCall() throws {
        let app = try XCTUnwrap(try sources().first { $0.name == "RelayiumApp.swift" })
        XCTAssertTrue(app.text.contains("receive.shouldAcceptSession = "),
                      "nothing arbitrates and brings an unsolicited session forward")
        XCTAssertTrue(app.text.contains("AppRouting.claimIncoming(kind,"),
                      "the claim must be the one shared call, not three writes in a closure")
        for (name, text) in try sources() where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("shouldAcceptSession"),
                           "\(name) is a second inbound admission handler")
        }
    }

    func testNearbySessionKeepsItsPeerVisibleAfterTheRosterDisappears() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains("presence.sessionPeerLabel"))
        XCTAssertTrue(view.text.contains("L10n.t(.nearbySessionWith"))
        XCTAssertTrue(view.text.contains("L10n.t(.nearbySessionPeerDisclaimer)"),
                      "a peer-supplied label must not be presented as verified identity")
    }

    func testNearbyExitAppearsOnlyAfterAClaimHasBecomeARealSessionAndThenEnded() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains("private var hasRetainedSession: Bool"))
        XCTAssertTrue(view.text.contains("if hasRetainedSession && !busy"),
                      "Back to devices is either exposed before async start or absent after terminal state")
    }

    func testNearbyLocalTextCannotBeDiscardedByAnUnconfirmedExit() throws {
        let source = try nearby().text
        XCTAssertTrue(source.contains("@State private var confirmingLocalTextLeave = false"))
        XCTAssertTrue(source.contains("if modes.mode == .text, text.hasLocalContent"))
        XCTAssertTrue(source.contains(
            "Button(L10n.t(.nearbyBackToDevices), role: .destructive) { leaveSession() }"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmTitle)"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmBody)"))
    }

    func testPairingDoneCannotDiscardAnyLocalTextWithoutConfirmation() throws {
        let source = try direct().text
        XCTAssertTrue(source.contains("@State private var confirmingLocalTextDone = false"))
        XCTAssertTrue(source.contains("guard text.hasLocalContent else"))
        XCTAssertTrue(source.contains(
            "Button(L10n.t(.commonDone), role: .destructive) { text.reset() }"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmTitle)"))
        XCTAssertTrue(source.contains("L10n.t(.textDiscardLocalContentConfirmBody)"))
    }

    /// **This slice adds no network capability, and the reason matters.**
    ///
    /// `LanDiscoveryModel` is not Bonjour and does not scan: it joins the hub's
    /// code-less room over the same HTTPS/WebSocket origin the rest of the app
    /// uses, and the server groups that room by the public IP it observes. So
    /// none of Apple's local-network machinery is involved, and declaring any
    /// of it would be a permission prompt for something the app does not do —
    /// which is worse than a missing capability, because the user is asked to
    /// grant access that then explains nothing.
    func testTheNearbyTabAddsNoNetworkCapability() throws {
        let plist = try infoPlist()
        XCTAssertNil(plist["NSLocalNetworkUsageDescription"],
                     "the app asks for local-network access it does not use")
        XCTAssertNil(plist["NSBonjourServices"])
        XCTAssertNil(plist["UIBackgroundModes"])
        XCTAssertNil(plist["NSUserActivityTypes"])
        // Read as a plist, not as text: the file's comment enumerates the
        // capabilities it deliberately does NOT claim, so a text scan would
        // fail on the very documentation of the absence it is checking for.
        let data = try Data(contentsOf: try iosRoot.appendingPathComponent("Relayium.entitlements"))
        let entitlements = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        // `com.apple.developer.associated-domains` left this list with the
        // Universal Link slice and `com.apple.security.application-groups` with
        // the share extension, and in both cases for the same reason: the key is
        // now claimed with the feature that uses it, and
        // `testTheEntitlementsFileClaimsOnlyAppleSignInAndAppLinks` asserts the
        // exact value rather than merely allowing the key. Neither is a NETWORK
        // capability, which is what this test is about — an App Group is a
        // shared directory, and the extension that writes into it makes no
        // request at all.
        for banned in ["com.apple.developer.networking.multicast",
                       "com.apple.developer.networking.wifi-info",
                       "keychain-access-groups",
                       "aps-environment"] {
            XCTAssertNil(entitlements[banned], "the entitlements file claims \(banned)")
        }
        for (name, text) in try sources() {
            for symbol in ["NWBrowser", "NWListener", "NetService", "Bonjour",
                           "_relayium._tcp", "MultipeerConnectivity"] {
                XCTAssertFalse(text.contains(symbol), "\(name) reaches for \(symbol)")
            }
        }
    }

    /// The receive location is stated, and it is the one iOS actually has.
    ///
    /// The shared listening paragraph no longer names a folder, because macOS
    /// writes to Downloads and iOS writes into its own container. Rendering the
    /// Mac's sentence here would send the user to a folder no iOS app has.
    func testTheNearbyTabNamesTheiOSReceiveLocationAndNotDownloads() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains("L10n.t(.nearbySavedToAppFolder)"),
                      "the tab never says where an unsolicited file lands")
        XCTAssertFalse(view.text.contains(".nearbySavedToDownloads"),
                       "the iOS tab promises a Downloads folder it does not have")
        XCTAssertTrue(view.text.contains(".nearbyListeningBody"),
                      "the tab never says what receiving actually allows")
        XCTAssertTrue(view.text.contains(".nearbyPausedBody"),
                      "and it must say what pausing changes")
    }

    /// The optional SAS control is the shared preference here too, and there is
    /// no second Accept step beside it: with verification off the existing
    /// handshake still runs and the session proceeds, which is
    /// `VerificationPreference`'s decision and not this view's to re-ask.
    func testTheNearbyTabOffersTheSharedVerificationSettingAndNoSecondAccept() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains(
            "set: { if !isLocked { verification.requiresSASConfirmation = $0 } }"),
                      "the shared preference must refuse changes after session claim")
        XCTAssertFalse(view.text.contains("isOn: $verification.requiresSASConfirmation"),
                       "a raw binding can change verification during claim-before-handshake")
        XCTAssertFalse(view.text.contains("@State private var requiresSAS"),
                       "a view-local copy would be a setting no session reads")
        XCTAssertTrue(view.text.contains("L10n.t(.nearbyAcceptanceNote)"),
                      "the screen must say what happens on the other end")
    }

    /// A same-surface double activation lands before either asynchronous model
    /// necessarily publishes busy. New work must use the strict boundary, not
    /// the idempotent claim reserved for reconstructing an existing session.
    func testEveryIOSRealtimeStartRequiresANewSessionClaim() throws {
        let all = try sources()
        let direct = try XCTUnwrap(all.first { $0.name == "DirectView.swift" }?.text)
        let nearby = try XCTUnwrap(all.first { $0.name == "NearbyView.swift" }?.text)
        XCTAssertEqual(direct.components(separatedBy:
            "guard presence.beginSession(.pairingCode) else { return }").count - 1, 4)
        XCTAssertEqual(nearby.components(separatedBy:
            "guard presence.beginSession(.nearby, peerLabel: device.label) else { return }").count - 1, 2)
    }

    func testIOSPairingJoinSnapshotsAValidatedCodeBeforeClaimAndTask() throws {
        let direct = try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" }?.text)
        for model in ["file", "text"] {
            XCTAssertTrue(direct.contains("let code = \(model).joinCode"))
            XCTAssertTrue(direct.contains("guard \(model).canJoin else { return }"))
            XCTAssertTrue(direct.contains("Task { await \(model).join(code: code) }"))
            XCTAssertFalse(direct.contains("Task { await \(model).join(code: \(model).joinCode) }"),
                           "iOS reads mutable input after taking ownership")
        }
    }

    func testIOSAccountSubmitSnapshotsTheWholeFormBeforeStartingAsyncWork() throws {
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" }?.text)
        XCTAssertTrue(form.contains("let submitted = draft"))
        for field in ["submitted.email", "submitted.password", "submitted.displayName"] {
            XCTAssertTrue(form.contains(field), "account submission lost \(field)")
        }
        XCTAssertTrue(form.contains("SignInPresentation.problem(in: submitted)"))
        XCTAssertFalse(form.contains("session.logIn(email: draft.email"))
        XCTAssertFalse(form.contains("session.register(email: draft.email"))
    }

    func testIOSPairingCreateSettlesIntentBeforeStartingAsyncMint() throws {
        let direct = try XCTUnwrap(try sources().first { $0.name == "DirectView.swift" }?.text)
        XCTAssertTrue(direct.contains("Button { createAndSend() } label:"))
        XCTAssertTrue(direct.contains("Button { createTextSession() } label:"))
        guard let selection = direct.range(of: "guard let staged = selection.stageForSend()"),
              let fileClaim = direct.range(of:
                "guard presence.beginSession(.pairingCode) else { return }",
                range: selection.lowerBound..<direct.endIndex),
              let fileTask = direct.range(of:
                "Task { await mintAndSendFiles(token: access.token) }") else {
            return XCTFail("iOS file code creation lost its synchronous intent boundary")
        }
        XCTAssertTrue(selection.lowerBound < fileClaim.lowerBound && fileClaim.lowerBound < fileTask.lowerBound)
        guard let textStart = direct.range(of: "private func createTextSession()"),
              let textClaim = direct.range(of:
                "guard presence.beginSession(.pairingCode) else { return }",
                range: textStart.lowerBound..<direct.endIndex),
              let textTask = direct.range(of:
                "Task { await mintAndJoinText(token: access.token) }") else {
            return XCTFail("iOS text code creation lost its synchronous intent boundary")
        }
        XCTAssertTrue(textClaim.lowerBound < textTask.lowerBound)
    }

    /// The Nearby tab scrolls, like every other screen in this app.
    ///
    /// It is the longest one: an explanation, a status card, a roster of
    /// unknown length, a staging section and a session. At the largest
    /// accessibility content sizes anything not in a `ScrollView` puts its own
    /// action off the bottom of the screen with no way to reach it.
    func testTheNearbyTabScrollsAndStatesEveryResidencyState() throws {
        let view = try nearby()
        XCTAssertTrue(view.text.contains("ScrollView"),
                      "the longest screen in the app cannot be scrolled")
        XCTAssertTrue(view.text.contains("NearbyStatusPresentation.text(for: receive.state)"),
                      "the residency state must come from the shared, translated mapping")
        XCTAssertFalse(view.text.contains("ProgressView()\n"),
                       "an unlabelled spinner reads as nothing")
        XCTAssertFalse(view.text.contains("foregroundStyle(.red)"),
                       "a failure stated in colour alone")
    }
    /// The iOS half of the same rule: an acceptance launch may not resolve the
    /// keychain item the installed product wrote.
    func testUITestLaunchesUseAnIsolatedKeychainIdentity() throws {
        let all = try sources()
        let mode = try XCTUnwrap(all.first { $0.name == "UITestMode.swift" }?.text)
        let app = try XCTUnwrap(all.first { $0.name == "RelayiumApp.swift" }?.text)
        XCTAssertTrue(mode.contains("isolatedKeychainConfiguration"),
                      "the UI-test launch has no keychain identity of its own")
        XCTAssertTrue(mode.contains("try? store.clear()"),
                      "an isolated launch inherits the previous path's account")
        XCTAssertTrue(app.contains("tokenStore: UITestMode.makeTokenStore()"),
                      "the app does not hand the isolated store to its session")
        let halves = mode.components(separatedBy: "#else")
        XCTAssertEqual(halves.count, 2)
        XCTAssertFalse(try XCTUnwrap(halves.last).contains("isolatedKeychainConfiguration"),
                       "a shipped build can be pointed at a test keychain identity")
    }

    /// The signed-in acceptance account is answered in process, and none of it
    /// may exist in a shipped binary.
    ///
    /// Its bodies are JSON literals validated by decoding through the very
    /// models the app decodes into, so a field added to `NativeUser` drops the
    /// entry, refuses the endpoint and fails the path loudly — which is exactly
    /// how the two fields missing from the first version were found.
    func testTheSignedInAcceptanceAccountIsDebugOnlyAndSelfValidating() throws {
        let mode = try XCTUnwrap(
            try sources().first { $0.name == "UITestMode.swift" }?.text)
        XCTAssertTrue(mode.contains("final class UITestAccountTransport: URLProtocol"),
                      "the signed-in acceptance transport is gone")
        let transport = try XCTUnwrap(mode.range(of: "final class UITestAccountTransport"))
        let preamble = String(mode[..<transport.lowerBound])
        XCTAssertGreaterThan(preamble.components(separatedBy: "#if DEBUG").count - 1,
                             preamble.components(separatedBy: "#endif").count - 1,
                             "the acceptance transport is not inside a Debug block")
        XCTAssertTrue(mode.contains("guard (try? JSONDecoder().decode(type, from: data)) != nil"),
                      "the fixture bodies are no longer validated against the real models")
        XCTAssertTrue(mode.contains("didFailWithError: URLError(.unsupportedURL)"),
                      "an unmodelled endpoint is answered instead of refused")
        // The bearer is a literal no server would accept, and the address is not
        // a real one. Neither may drift into something that could reach production.
        XCTAssertTrue(mode.contains("\"uitest-bearer\""))
        XCTAssertTrue(mode.contains("\"person@example.com\""))
    }

    /// The pairing-code handoff the owner's 2026-08-07 review found missing, and
    /// the runtime path that now proves it on the platform that produced the
    /// complaint.
    func testTheGeneratedTextCodeKeepsItsVisibleHandoff() throws {
        let view = try XCTUnwrap(
            try sources().first { $0.name == "DirectView.swift" }?.text)
        // `OpenSection`, not a hand-rolled semibold footnote: the label is the
        // same word and the same rendered static text the runtime path below
        // looks for, now announced to VoiceOver as the group's heading.
        for required in ["OpenSection(L10n.t(.pairingJoinLink))", "Text(url.absoluteString)",
                         "UIPasteboard.general.string = url.absoluteString",
                         "ShareLink(item: url)"] {
            XCTAssertTrue(view.contains(required),
                          "the generated pairing code lost \(required)")
        }
        let ui = try String(
            contentsOf: try appsRoot.appendingPathComponent(
                "ios/RelayiumUITests/AppShellUITests.swift"), encoding: .utf8)
        XCTAssertTrue(ui.contains("testCreatingATextCodeStaysOnDirectAndShowsEveryHandoff"),
                      "no runtime path drives the iOS pairing-code handoff")
    }

    // MARK: - Phase C: the shared visual layer

    /// The five files every refreshed surface is built out of.
    ///
    /// Asserted by NAME rather than by what they contain, because the failure
    /// this catches is the next screen quietly not using them: a component layer
    /// with one call site is a literal with extra steps.
    func testTheIOSAppHasOneTokenAndComponentLayerRatherThanFortyLiterals() throws {
        let all = try sources()
        for component in ["Components/DesignTokens.swift", "Components/SectionCard.swift",
                          "Components/InlineMessage.swift", "Components/EmptyStateView.swift",
                          "Components/PathRail.swift"] {
            XCTAssertTrue(all.contains { $0.name == component },
                          "the shared layer lost \(component)")
        }
        let tokens = try XCTUnwrap(all.first { $0.name == "Components/DesignTokens.swift" }?.text)
        // No hex anywhere. UIKit's semantic colours answer light, dark and
        // Increase Contrast; a literal written here would answer none of them,
        // and the ONE brand colour is an asset reached through `accentColor`.
        XCTAssertFalse(tokens.contains("Color(red:"), "the token layer names a raw colour")
        XCTAssertFalse(tokens.contains("#"), "the token layer names a hex colour")
        XCTAssertTrue(tokens.contains("static var action: Color { .accentColor }"),
                      "the brand colour is not the asset")

        // Every ad-hoc container fill is gone from the refreshed surfaces, and
        // each now spends the tokens instead of literals. `ReceiveView`,
        // `AccountSummaryView` and `SignInView` join the list in the Receive/
        // Account batch — a component layer whose call sites stop at four
        // screens is four screens' worth of literals with extra steps.
        for name in ["NearbyView.swift", "SendView.swift", "DeviceSendView.swift",
                     "DirectView.swift", "ReceiveView.swift", "AccountSummaryView.swift",
                     "SignInView.swift"] {
            let view = try XCTUnwrap(all.first { $0.name == name }?.text)
            XCTAssertFalse(view.contains(".quaternary.opacity("),
                           "\(name) still hand-rolls a container fill")
            XCTAssertFalse(view.contains("Color.secondary.opacity("),
                           "\(name) still hand-rolls a container fill or a rule")
            XCTAssertTrue(view.contains("Metrics."), "\(name) does not use the token layer")
            XCTAssertFalse(view.contains("spacing: 1"),
                           "\(name) still spaces itself with a literal")
        }

        // One failure presentation, every call site. The helpers keep their
        // names — the panes' own ordering guards address them — and delegate.
        // `AccountTab` has no helper of its own and states its failures
        // directly, so it is in this half of the check and not the one above.
        for name in ["NearbyView.swift", "SendView.swift", "DeviceSendView.swift",
                     "DirectView.swift", "ReceiveView.swift", "AccountSummaryView.swift",
                     "SignInView.swift", "AccountTab.swift"] {
            let view = try XCTUnwrap(all.first { $0.name == name }?.text)
            XCTAssertTrue(view.contains("InlineMessage(.warning,"),
                          "\(name) states a failure without the shared role")
            XCTAssertFalse(view.contains("Image(systemName: \"exclamationmark.triangle.fill\")"),
                           "\(name) kept its own copy of the failure line")
            XCTAssertFalse(view.contains("foregroundStyle(.red)"),
                           "\(name) states a failure in colour")
        }

        // And every one of the five destinations plus the two account-state
        // views is built out of the shared container. Asserted by call site
        // rather than by absence, because the failure this catches is the next
        // screen quietly laying itself out as a flat column again.
        for name in ["NearbyView.swift", "SendView.swift", "DeviceSendView.swift",
                     "DirectView.swift", "ReceiveView.swift", "AccountSummaryView.swift",
                     "SignInView.swift", "AccountTab.swift"] {
            let view = try XCTUnwrap(all.first { $0.name == name }?.text)
            XCTAssertTrue(view.contains("SectionCard"),
                          "\(name) draws its content without the shared container")
        }
    }

    /// **The branded accent is an asset, it matches the Mac exactly, and the
    /// project actually resolves it.**
    ///
    /// All three halves are needed. A colorset nothing names is dead weight; a
    /// build setting with no asset silently falls back to system blue; and two
    /// hand-copied violets that drift are worse than one blue, because the two
    /// apps then look like two products.
    func testTheAccentColourIsOneBrandedAssetSharedWithTheMac() throws {
        func colorset(_ target: String) throws -> [[String: Any]] {
            let json = try JSONSerialization.jsonObject(with: try RepoRoot.data(
                "apps/\(target)/Assets.xcassets/AccentColor.colorset/Contents.json"))
            return try XCTUnwrap((json as? [String: Any])?["colors"] as? [[String: Any]])
        }
        // The channel values themselves, which is the only part of a colorset
        // that is a colour. Compared through `String`, not through the parsed
        // `[String: Any]`: `Any` is not `Equatable`, so an assertion written
        // over the raw dictionaries does not compile at all.
        func components(_ colors: [[String: Any]]) -> [[String: String]] {
            colors.compactMap {
                ($0["color"] as? [String: Any])?["components"] as? [String: String]
            }
        }
        /// Which appearance each entry answers for, alongside its channels — so
        /// a catalog that kept both violets and swapped or dropped the dark
        /// appearance is not equal to one that did not.
        func appearances(_ colors: [[String: Any]]) -> [String] {
            colors.map { entry in
                let marks = (entry["appearances"] as? [[String: Any]] ?? [])
                    .compactMap { "\($0["appearance"] ?? "?")=\($0["value"] ?? "?")" }
                    .sorted()
                return (marks.isEmpty ? ["universal"] : marks).joined(separator: ",")
            }
        }
        let ios = try colorset("ios/Relayium")
        let mac = try colorset("mac/Relayium")
        // The share extension too. It is a separate binary with its own asset
        // catalog, so before this it drew system blue inside somebody else's app
        // while the app it belongs to drew violet — which is the one place a
        // user sees Relayium next to another product's chrome.
        let share = try colorset("ios/RelayiumShare")
        XCTAssertEqual(components(share), components(ios),
                       "the share sheet is a different brand from the app")
        XCTAssertEqual(appearances(share), appearances(ios),
                       "the share sheet answers light and dark differently from the app")
        XCTAssertEqual(appearances(ios), appearances(mac),
                       "the two apps answer light and dark differently")
        XCTAssertEqual(appearances(ios), ["universal", "luminosity=dark"],
                       "the accent asset is not one base colour plus a dark override")
        XCTAssertEqual(components(ios).count, 2,
                       "the accent asset has no separate dark appearance")
        XCTAssertEqual(components(ios), components(mac),
                       "the two apps' brand violets have drifted apart")
        // The values themselves, so a coordinated edit to both still has to be
        // a decision: #6D28D9, and #7C3AED in dark.
        XCTAssertEqual(components(ios).first, ["alpha": "1.000", "red": "0x6D",
                                               "green": "0x28", "blue": "0xD9"])
        XCTAssertEqual(components(ios).last, ["alpha": "1.000", "red": "0x7C",
                                              "green": "0x3A", "blue": "0xED"])

        let project = try String(
            contentsOf: try appsRoot.appendingPathComponent("ios/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)
        XCTAssertEqual(project.components(
            separatedBy: "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;").count - 1,
            4, "both targets, Debug and Release, must resolve the branded accent")
    }

    /// **The nearby tab leads with the task, and the receiver keeps every word.**
    ///
    /// It was one flat column: a caution, a receiving status with its own
    /// button, a mode picker, a chooser and a roster, each twenty points below
    /// the last and none of them the point of the screen. The order asserted
    /// here is the repair — caution, then the send task, then receiving — and it
    /// is asserted as an order rather than as presence, because a card added
    /// below the receiver would pass a containment check while leaving the
    /// screen exactly as it was.
    func testTheNearbyTabLeadsWithItsOwnTaskWithoutDemotingTheReceiver() throws {
        let view = try nearby()
        let section = try XCTUnwrap(view.text.components(
            separatedBy: "private var discoverySection:").dropFirst().first?
            .components(separatedBy: "private var sendTask:").first)
        let caution = try XCTUnwrap(section.range(of: "safetySummary"))
        let task = try XCTUnwrap(section.range(of: "sendTask"))
        let receiving = try XCTUnwrap(section.range(of: "receiving"))
        XCTAssertTrue(caution.lowerBound < task.lowerBound,
                      "the task is drawn above the caution that changes the decision")
        XCTAssertTrue(task.lowerBound < receiving.lowerBound,
                      "the passive receiver still outranks the tab's own task")

        // The task's two acts are named, and both live in the one card.
        let card = try XCTUnwrap(view.text.components(
            separatedBy: "private var sendTask:").dropFirst().first?
            .components(separatedBy: "private var safetySummary:").first)
        XCTAssertTrue(card.contains("SectionCard(L10n.t(.nearbySendTaskTitle))"))
        XCTAssertTrue(card.contains("OpenSection(L10n.t(.nearbyWhatToSend))"))
        XCTAssertTrue(card.contains("OpenSection(L10n.t(.nearbyWhoToSend))"))
        for act in ["modePicker", "filesToSend", "roster"] {
            XCTAssertTrue(card.contains(act), "the send card does not hold \(act)")
        }

        // The receiving card's TITLE is the status, which is the hierarchy
        // change: one question, answered where the eye and VoiceOver both land
        // first. It must still come from the shared mapping.
        XCTAssertTrue(view.text.contains(
            "SectionCard(NearbyStatusPresentation.text(for: receive.state))"),
            "the receiving card no longer leads with the state it is reporting")
        XCTAssertFalse(view.text.contains("Divider()"),
                       "the tab went back to separating groups with rules")
    }

    /// Exactly one prominent control while nothing is staged, on both surfaces.
    ///
    /// Before this the idle Send tab was two identical grey capsules and the
    /// nearby tab was three, so neither screen had a first move. The emphasis
    /// moves to Send the moment there is something to send — two prominent
    /// buttons in one card is the same as none.
    func testTheChooserCarriesTheEmphasisOnlyUntilThereIsSomethingToSend() throws {
        let all = try sources()
        for (name, emptiness) in [("NearbyView.swift", "if selection.isEmpty {"),
                                  ("DirectView.swift", "if selection.isEmpty {"),
                                  ("SendView.swift", "if selection.selectedFiles.isEmpty {")] {
            let view = try XCTUnwrap(all.first { $0.name == name }?.text)
            let choose = try XCTUnwrap(view.components(separatedBy: emptiness)
                .dropFirst().first?.components(separatedBy: "} else {").first)
            XCTAssertTrue(choose.contains("L10n.t(.commonChooseFilesOrFolders)"),
                          "\(name)'s empty branch does not offer the chooser")
            XCTAssertTrue(choose.contains(".buttonStyle(.borderedProminent)"),
                          "\(name) leaves an empty task with no first move")
            let staged = try XCTUnwrap(view.components(separatedBy: emptiness)
                .dropFirst().first?.components(separatedBy: "} else {").dropFirst().first)
            XCTAssertTrue(staged.contains(".buttonStyle(.bordered)"),
                          "\(name) keeps two prominent controls once something is staged")
        }
    }

    /// **The Direct tab's two tasks are two cards, and the route belongs to
    /// neither of them.**
    ///
    /// It was one flat column: a paragraph, a picker, a headline, four controls,
    /// a second headline, three more controls, a footnote block and a toggle,
    /// each twenty points below the last. So the screen's two actual tasks —
    /// create a code, join one — ranked exactly as high as the sentence about
    /// large files underneath them, and neither of them had a boundary.
    ///
    /// Asserted as containment rather than as order, because unlike Nearby the
    /// order here was never wrong; what was missing was the chrome that says
    /// where one task stops. The one thing that IS an order is the route: it
    /// belongs to both halves, so it may not be drawn inside either card.
    func testTheDirectTabDrawsItsTwoTasksAsTwoCardsAroundOneSharedRoute() throws {
        let view = try direct()
        for card in ["SectionCard(L10n.t(.directSendHeading))",
                     "SectionCard(L10n.t(.textStartHeading))",
                     "SectionCard(L10n.t(.directReceiveHeading))",
                     "SectionCard(L10n.t(.directLargeFilesTitle))",
                     "SectionCard(L10n.t(.presenceBusyTitle))"] {
            XCTAssertTrue(view.text.contains(card), "the Direct tab lost \(card)")
        }
        // The generated code is a card whose TITLE is the instruction, so
        // VoiceOver says "Give this code to the other device" once on entering
        // the group and then reads the digits — rather than reading a heading,
        // the digits, a link, two footnotes and a spinner as seven peers.
        let handoff = try XCTUnwrap(view.text.components(
            separatedBy: "private func showing(code:").dropFirst().first?
            .components(separatedBy: "private func interruption").first)
        XCTAssertTrue(handoff.contains("SectionCard(heading)"),
                      "the code handoff is a flat column again")
        XCTAssertFalse(handoff.contains("Text(heading)"),
                       "the handoff heading is a label inside the group it names")

        // The route is stated once, above both cards, and outside both.
        let positioning = try XCTUnwrap(view.text.components(
            separatedBy: "private var positioning:").dropFirst().first?
            .components(separatedBy: "private var modePicker:").first)
        XCTAssertTrue(positioning.contains("L10n.t(.navPairingCodeSubtitle)"))
        XCTAssertTrue(positioning.contains("PathRail("))
        XCTAssertFalse(positioning.contains("SectionCard"),
                       "the shared route was claimed by one of the two halves")
        for half in ["private var createFiles:", "private var createText:",
                     "private func joinCard("] {
            let card = try XCTUnwrap(view.text.components(separatedBy: half)
                .dropFirst().first?.components(separatedBy: "\n    }\n").first)
            XCTAssertFalse(card.contains("PathRail("),
                           "\(half) draws the route as if it owned it")
        }

        // The advanced-verification control is the same untitled card the Nearby
        // tab gives the same control, rather than a fifth wall of loose grey.
        let setting = try XCTUnwrap(view.text.components(
            separatedBy: "private var verificationSetting:").dropFirst().first?
            .components(separatedBy: "private func failureLine").first)
        XCTAssertTrue(setting.contains("SectionCard {"))
        for stated in ["L10n.t(.verifyToggle)", "L10n.t(.verifyExplainWhat)",
                       "L10n.t(.verifyExplainEncryption)"] {
            XCTAssertTrue(setting.contains(stated), "the toggle lost \(stated)")
        }
    }

    /// **The two handoff controls turn, for the same reason the rail turns.**
    ///
    /// Found on a real iPhone SE build at Accessibility 3, not in a preview:
    /// half of a 375pt content width is about 150 points, and Copy and Share
    /// beside their symbols are wider than that, so the two controls the whole
    /// pairing handoff depends on rendered as "Co / py" and "Sh / are". Above
    /// the accessibility sizes they stack — the same two controls, in the same
    /// order, declared once each so the two axes cannot drift apart.
    func testTheJoinLinkControlsStackRatherThanBreakTheirOwnLabels() throws {
        let view = try direct()
        let link = try XCTUnwrap(view.text.components(
            separatedBy: "private struct PairingJoinLinkView:").dropFirst().first?
            .components(separatedBy: "private struct PairingCodeInput:").first)
        XCTAssertTrue(link.contains("@Environment(\\.dynamicTypeSize)"),
                      "the handoff controls cannot see the reader's own setting")
        XCTAssertTrue(link.contains("if typeSize.isAccessibilitySize {"))
        XCTAssertTrue(link.contains("VStack(spacing: Metrics.tight) { copyButton; shareButton }"))
        XCTAssertTrue(link.contains("HStack(spacing: Metrics.tight) { copyButton; shareButton }"))
        for once in ["private var copyButton", "private var shareButton"] {
            XCTAssertEqual(link.components(separatedBy: once).count - 1, 1,
                           "\(once) is declared twice, so the two axes can drift")
        }
        // Full width inside whichever axis holds them, and a large control, so
        // each is over the 44pt floor on both axes rather than only across.
        XCTAssertEqual(link.components(separatedBy: ".frame(maxWidth: .infinity)").count - 1, 2)
        XCTAssertTrue(link.contains(".controlSize(.large)"))
    }

    /// **What a direct transfer is, is advice — so it goes when the advice is
    /// spent.**
    ///
    /// The positioning paragraph and the route rail answer "should I use this?",
    /// and the large-file route has always been drawn only while that question
    /// is still open, for exactly that reason. Above a code that is minting,
    /// waiting for a peer or already carrying one, they are preamble stacked on
    /// top of the thing the user is watching — on the smallest supported iPhone,
    /// enough of it to push the code itself off the first screen.
    func testTheDirectPositioningIsDrawnOnlyWhileTheDecisionIsStillOpen() throws {
        let view = try direct()
        // Anchored on the presence branch rather than on `var body`, which the
        // file has two of — the join-link subview declares one too, and
        // splitting on it would isolate that view instead of this one.
        let body = try XCTUnwrap(view.text.components(
            separatedBy: "if let owner = presence.owner, owner != .pairingCode {")
            .dropFirst().first?.components(separatedBy: ".navigationTitle").first)
        XCTAssertTrue(body.contains("if !isLocked { positioning }"),
                      "the screen explains itself over a transfer in progress")
        XCTAssertTrue(body.contains("if !isLocked { largeFileRoute }"),
                      "the large-file route lost its own gate")
        // And the gate is the shared derivation, not a second answer to the same
        // question: `isLocked` reads BOTH models and the presence claim, so a
        // session claimed before either model publishes is covered too.
        XCTAssertTrue(view.text.contains("DirectModeSelection.isLocked(file: file.state,"),
                      "the lock is computed somewhere other than the tested seam")
    }

    /// **The rail may state a route and may not animate one.**
    ///
    /// Reduced Motion is not the reason it has no animation — the reason is that
    /// a rail whose meaning lives in a moving dash means nothing on a still
    /// screen, in a screenshot, or to anyone who has asked the system to stop
    /// moving things. So there is no animation to reduce, and the guard is an
    /// absence.
    func testTheIOSPathRailIsFactualStillAndAdaptsToTheReadersOwnTextSize() throws {
        let rail = try XCTUnwrap(
            try sources().first { $0.name == "Components/PathRail.swift" }?.text)
        for motion in [".animation(", "withAnimation", "repeatForever", "TimelineView",
                       "accessibilityReduceMotion"] {
            XCTAssertFalse(rail.contains(motion),
                           "the rail moves, so it means nothing when motion is off: \(motion)")
        }
        // Order is the direction. An arrow would point the wrong way in Arabic.
        for arrow in ["arrow.right", "arrow.forward", "chevron.right"] {
            XCTAssertFalse(rail.contains(arrow), "the rail draws a direction glyph")
        }
        XCTAssertTrue(rail.contains("@Environment(\\.dynamicTypeSize)"),
                      "the rail cannot turn, so it is three two-word columns at AX sizes")
        XCTAssertTrue(rail.contains("typeSize >= .xxLarge"))
        XCTAssertTrue(rail.contains("PathRailPresentation.routeLabel()"),
                      "the rail's stops read as loose fragments to VoiceOver")
        XCTAssertTrue(rail.contains(".accessibilityIdentifier(\"path-rail\")"))
        // The stops themselves are the package's decision, not this view's.
        XCTAssertFalse(rail.contains("L10n.t(.path"),
                       "the view composes a rail label of its own")

        // And each surface draws the rail its own state can actually support.
        let nearby = try nearby().text
        XCTAssertTrue(nearby.contains("PathRail(stops: PathRailPresentation.iosNearby())"))
        let send = try XCTUnwrap(
            try sources().first { $0.name == "SendView.swift" }?.text)
        XCTAssertTrue(send.contains(
            "PathRail(stops: PathRailPresentation.iosStoredSend(upload.state))"),
            "the one rail with real progress is not reading the model that has it")
        XCTAssertTrue(send.contains("PathRail(stops: PathRailPresentation.iosDeviceSend())"))
        // Direct's rail is the pairing-code one, which IS the nearby one — the
        // same two devices and the same encrypted middle, because it is the same
        // route. What it may never be is `crossNetwork`, the Mac rail for this
        // very product surface, which opens with "This Mac".
        let direct = try direct().text
        XCTAssertTrue(direct.contains("PathRail(stops: PathRailPresentation.iosPairingCode())"),
                      "the Direct tab states no route at all")
        for view in [nearby, send, direct] {
            for macRail in ["PathRailPresentation.storedSend(", "PathRailPresentation.lan(",
                            "PathRailPresentation.crossNetwork("] {
                XCTAssertFalse(view.contains(macRail),
                               "an iOS surface draws the Mac's rail, which says This Mac")
            }
        }
    }

    /// **Every SF Symbol this app draws exists on the oldest iOS it ships to.**
    ///
    /// A symbol added after the deployment target renders as nothing at all —
    /// no crash, no warning, no log — so the rail keeps its labels and loses its
    /// badges, and the empty state loses its landmark. It cannot be caught on a
    /// simulator, because the only simulator runtime installed is current; it
    /// cannot be caught by `NSImage(systemSymbolName:)`, because that answers
    /// for the Mac the test is running on. This batch shipped two of them —
    /// `macbook.and.iphone` and `laptopcomputer.slash`, both iOS 16.1 against a
    /// 16.0 floor — before this guard existed.
    ///
    /// The availability data is Apple's own, read from CoreGlyphs on the test
    /// host rather than copied into a table here that would go stale. If a
    /// future macOS moves or reshapes that file the test SKIPS rather than
    /// fails: a guard that cannot read its evidence must not claim a verdict.
    func testEverySymbolTheIOSAppDrawsExistsOnItsOldestSupportedIOS() throws {
        let plist = URL(fileURLWithPath:
            "/System/Library/CoreServices/CoreGlyphs.bundle/Contents/Resources/"
            + "name_availability.plist")
        guard let data = try? Data(contentsOf: plist),
              let root = try? PropertyListSerialization.propertyList(
                from: data, options: [], format: nil) as? [String: Any],
              let firstYear = root["symbols"] as? [String: String],
              let releases = root["year_to_release"] as? [String: [String: String]]
        else {
            throw XCTSkip("CoreGlyphs availability data is not readable on this host")
        }

        // The floor the project actually declares, not a number repeated here.
        let project = try String(
            contentsOf: try appsRoot.appendingPathComponent("ios/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)
        let targets = project.components(separatedBy: "IPHONEOS_DEPLOYMENT_TARGET = ")
            .dropFirst()
            .compactMap { $0.components(separatedBy: ";").first }
        XCTAssertFalse(targets.isEmpty, "the project declares no iOS deployment target")
        let floor = try XCTUnwrap(targets.map(ordered).min())
        XCTAssertEqual(Set(targets).count, 1,
                       "the targets disagree about the oldest iOS: \(Set(targets))")
        let floorName = try XCTUnwrap(targets.min { ordered($0) < ordered($1) })

        // Both places a symbol name can be written: the views and components
        // themselves, and the rail stops the package hands them. Comments are
        // already stripped by `sources()`, so a name discussed in prose is not
        // mistaken for a name drawn.
        //
        // Two sweeps, because one is precise and one is complete. The named
        // parameters are certainly symbols; but `InlineMessage` returns its two
        // out of a `switch` with no parameter label anywhere near them, and a
        // guard that silently skips a whole component is not a guard. So every
        // remaining string literal is also looked up, and kept only when Apple's
        // own table recognises it — ordinary copy and identifiers are not in
        // that table and drop out on their own.
        var used = Set<String>()
        let named = try NSRegularExpression(
            pattern: "(?:systemName|systemImage|symbol):\\s*\"([^\"]+)\"")
        let anyLiteral = try NSRegularExpression(pattern: "\"([^\"\\\\]+)\"")
        for file in try sources() {
            let text = file.text
            let whole = NSRange(text.startIndex..., in: text)
            for match in named.matches(in: text, range: whole) {
                if let range = Range(match.range(at: 1), in: text) {
                    used.insert(String(text[range]))
                }
            }
            for match in anyLiteral.matches(in: text, range: whole) {
                if let range = Range(match.range(at: 1), in: text),
                   firstYear[String(text[range])] != nil {
                    used.insert(String(text[range]))
                }
            }
        }
        XCTAssertGreaterThan(used.count, 10, "the symbol scan found almost nothing")
        // Every rail drawn on iOS, plus the checkmark `PathRail` substitutes for
        // a reached stop's own symbol.
        let done = UploadState.done(link: "x", expiresAt: 0, keyWarning: nil)
        for stop in PathRailPresentation.iosStoredSend(.idle)
            + PathRailPresentation.iosStoredSend(done)
            + PathRailPresentation.iosDeviceSend()
            + PathRailPresentation.iosNearby()
            + PathRailPresentation.iosPairingCode() {
            used.insert(stop.symbol)
        }
        used.insert("checkmark")

        for symbol in used.sorted() {
            guard let year = firstYear[symbol], let shipped = releases[year]?["iOS"] else {
                XCTFail("\(symbol) is not an SF Symbol Apple ships at all")
                continue
            }
            XCTAssertLessThanOrEqual(
                ordered(shipped), floor,
                "\(symbol) first shipped in iOS \(shipped) and draws nothing on iOS "
                + "\(floorName), which this app still supports")
        }
    }

    /// `16.10` sorts above `16.4`, which a string comparison would get backwards.
    private func ordered(_ version: String) -> Int {
        let parts = version.split(separator: ".").compactMap { Int($0) }
        return (parts.first ?? 0) * 1_000 + (parts.count > 1 ? parts[1] : 0)
    }

    /// The two empty states that are not merely absent content.
    func testBothEmptyDeviceListsAreDesignedStatesWithTheirRemedy() throws {
        let all = try sources()
        let nearby = try XCTUnwrap(all.first { $0.name == "NearbyView.swift" }?.text)
        XCTAssertTrue(nearby.contains("EmptyStateView(symbol: \"dot.radiowaves.left.and.right\","))
        XCTAssertTrue(nearby.contains("message: L10n.t(.nearbyEmptyRoster)"))
        let devices = try XCTUnwrap(all.first { $0.name == "DeviceSendView.swift" }?.text)
        XCTAssertTrue(devices.contains("message: L10n.t(.sendDeviceNone)"))
        XCTAssertTrue(devices.contains("detail: L10n.t(.sendDeviceNoneHelp)"),
                      "the empty device list dropped its remedy")
        // No action of its own on either: the thing to press next — Look again,
        // Refresh — is already on the screen, and a second button here would
        // look like the primary one.
        let empty = try XCTUnwrap(all.first { $0.name == "Components/EmptyStateView.swift" }?.text)
        XCTAssertFalse(empty.contains("Button"), "the empty state grew a competing action")
    }

    // MARK: - Phase C: Receive and Account

    /// **Receive is a card per step, and the pre-save card is titled with what
    /// the link holds.**
    ///
    /// It was a field, a button and then whichever state the model was in, all
    /// twelve points apart: the manifest a person is consenting to had exactly
    /// the visual weight of the sentence explaining what a Relayium link is.
    /// The title is the summary rather than a fixed word, for the same reason
    /// the nearby receiving card's title is its status — it is the question the
    /// state answers, and VoiceOver reads it once on entering the group.
    ///
    /// The input card carries NO title on purpose: the only honest one is
    /// "Receive files", which the navigation bar above it already says.
    func testTheReceiveTaskIsCardedAndTitledWithWhatTheLinkHolds() throws {
        let receive = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" }?.text)
        let input = try XCTUnwrap(receive.components(separatedBy: "private var linkField:")
            .dropFirst().first?.components(separatedBy: "private var stateSection:").first)
        XCTAssertTrue(input.contains("SectionCard {"),
                      "the link input is a loose field and button again")
        XCTAssertFalse(input.contains("SectionCard(L10n.t(.downloadHeading))"),
                       "the input card repeats the navigation title")

        let ready = try XCTUnwrap(receive.components(separatedBy: "private func ready(")
            .dropFirst().first?.components(separatedBy: "private func done").first)
        XCTAssertTrue(ready.contains("SectionCard(DownloadPresentation.manifestSummary("),
                      "the consent card no longer leads with what the link holds")
        // And the burn notice is still ABOVE the action that spends the link,
        // in the shared warning role rather than this screen's own flame.
        XCTAssertTrue(ready.contains("InlineMessage(.warning, L10n.t(.downloadBurnNotice))"),
                      "the burn notice lost the shared warning role")
        guard let burn = ready.range(of: "L10n.t(.downloadBurnNotice)"),
              let action = ready.range(of: "L10n.t(.downloadReceive)") else {
            return XCTFail("the pre-save card lost its notice or its action")
        }
        XCTAssertTrue(burn.upperBound < action.lowerBound,
                      "the burn notice explains afterwards what was already spent")

        let done = try XCTUnwrap(receive.components(separatedBy: "private func done(")
            .dropFirst().first?.components(separatedBy: "private func failure").first)
        XCTAssertTrue(done.contains("SectionCard {"),
                      "the saved result is a flat column again")

        // The two states that are only a wait stay uncarded: a box drawn around
        // a progress bar is a box drawn around a sentence.
        for wait in ["case .resolving:", "case .downloading(let received, let total):"] {
            let arm = try XCTUnwrap(receive.components(separatedBy: wait)
                .dropFirst().first?.components(separatedBy: "case ").first)
            XCTAssertFalse(arm.contains("SectionCard"), "\(wait) grew chrome around a wait")
        }
    }

    /// The first screen in the app is a designed state, not a blank remainder.
    ///
    /// `testIdleReceiveExplainsTheLinkPrivacyAndAnonymousEntryPoint` already
    /// requires both sentences to be in the idle arm. This adds the shape: they
    /// are the shared empty-state role — landmark, fact, detail — which is what
    /// the Mac's idle download pane has drawn since its own refresh.
    func testIdleReceiveIsTheSharedEmptyStateRatherThanTwoLooseLabels() throws {
        let receive = try XCTUnwrap(try sources().first { $0.name == "ReceiveView.swift" }?.text)
        let idle = try XCTUnwrap(receive.components(separatedBy: "case .idle:")
            .dropFirst().first?.components(separatedBy: "case .resolving:").first)
        // nonlocalized: SF Symbol name, checked for availability elsewhere
        XCTAssertTrue(idle.contains("EmptyStateView(symbol: \"link\","))
        XCTAssertTrue(idle.contains("message: L10n.t(.downloadIdleHint)"))
        XCTAssertTrue(idle.contains("detail: L10n.t(.downloadNoAccountNeeded)"),
                      "the anonymous-receive fact is no longer the empty state's detail")
    }

    /// **The account screen is five cards in the order its questions are asked,
    /// and the one that ends the account is last and alone.**
    ///
    /// Asserted as an order rather than as presence: a card added below
    /// deletion would pass a containment check while leaving the screen exactly
    /// as it was — a forty-control column where Refresh and "Delete account"
    /// ranked the same.
    func testTheAccountSurfaceIsCardedWithItsDestructiveActLastAndAlone() throws {
        let summary = try XCTUnwrap(
            try sources().first { $0.name == "AccountSummaryView.swift" }?.text)
        let body = try XCTUnwrap(summary.components(separatedBy: "var body: some View {")
            .dropFirst().first?.components(separatedBy: ".task(id: scope)").first)
        var previous = body.startIndex
        for section in ["profileSection", "devicesSection", "filesSection",
                        "sessionActions", "deleteAccountSection"] {
            guard let found = body.range(of: section, range: previous..<body.endIndex) else {
                return XCTFail("the account column lost \(section), or reordered it")
            }
            previous = found.upperBound
        }
        // Identity, devices, stored files and deletion are titled with the fact
        // each card is about; the two untitled ones would only repeat a heading
        // that is already inside them or the navigation bar.
        XCTAssertTrue(summary.contains("SectionCard(profileTitle)"),
                      "the identity card is not titled with whose account this is")
        for titled in ["SectionCard(L10n.t(.accountDevicesHeading))",
                       "SectionCard(L10n.t(.accountFilesHeading))",
                       "SectionCard(L10n.t(.accountDeleteAccountHeading))"] {
            XCTAssertTrue(summary.contains(titled), "the account surface lost \(titled)")
        }
        // The purchase surface draws its own heading, so its card carries none —
        // and it is its OWN card rather than a tail on the identity one, which
        // is what stops two product rows, three notices and two legal links
        // burying the meters.
        let profile = try XCTUnwrap(summary.components(separatedBy: "private var profileSection:")
            .dropFirst().first?.components(separatedBy: "private var devicesSection:").first)
        guard let meters = profile.range(of: "meter(L10n.t(.accountStorage)"),
              let purchase = profile.range(of: "AppleSubscriptionCard(") else {
            return XCTFail("the identity card lost its meters or the purchase surface")
        }
        XCTAssertTrue(meters.upperBound < purchase.lowerBound,
                      "the purchase surface is drawn above what the current plan allows")
        XCTAssertTrue(profile.contains("IOSAppleSubscriptions.channel.offersInAppPurchase"),
                      "the purchase surface bypasses its distribution policy")

        // The delete control is the only one in its card, which is what a
        // boundary rather than distance buys.
        let deletion = try XCTUnwrap(summary.components(
            separatedBy: "private var deleteAccountSection:").dropFirst().first?
            .components(separatedBy: "private var isRequestingAccountDeletion").first)
        XCTAssertEqual(deletion.components(separatedBy: "Button(").count - 1, 1,
                       "another control shares the card with account deletion")
        XCTAssertTrue(deletion.contains(".controlSize(.large)"),
                      "the destructive control is under this app's own hit-target floor")
    }

    /// Both of the account's lists are designed empty states now, like the two
    /// device lists before them. No action of their own: Refresh is already on
    /// the screen, in the card below.
    func testBothAccountListsAreDesignedEmptyStates() throws {
        let summary = try XCTUnwrap(
            try sources().first { $0.name == "AccountSummaryView.swift" }?.text)
        // nonlocalized: SF Symbol names, checked for availability elsewhere
        XCTAssertTrue(summary.contains("EmptyStateView(symbol: \"iphone\","))
        XCTAssertTrue(summary.contains("message: L10n.t(.accountNoDevices)"))
        XCTAssertTrue(summary.contains("EmptyStateView(symbol: \"externaldrive\","))
        XCTAssertTrue(summary.contains("message: L10n.t(.accountNoFiles)"))
    }

    /// **A stored row's two handoff controls turn, for the same reason the
    /// pairing handoff's do.**
    ///
    /// Half of a 375pt content width is about 150 points, and at the
    /// accessibility content sizes "Copy link" beside its symbol is wider than
    /// that — the failure a real SE build produced on the Direct tab, on the
    /// controls a `#k=` handoff depends on. Declared once each, so the two axes
    /// cannot drift apart.
    func testTheStoredFileHandoffControlsStackRatherThanBreakTheirOwnLabels() throws {
        let summary = try XCTUnwrap(
            try sources().first { $0.name == "AccountSummaryView.swift" }?.text)
        XCTAssertTrue(summary.contains("@Environment(\\.dynamicTypeSize)"),
                      "the handoff controls cannot see the reader's own setting")
        XCTAssertTrue(summary.contains("if typeSize.isAccessibilitySize {"))
        for once in ["private func copyButton(link: String, row: StoredFileRow)",
                     "private func shareButton(link: String, row: StoredFileRow)"] {
            XCTAssertEqual(summary.components(separatedBy: once).count - 1, 1,
                           "\(once) is declared twice, so the two axes can drift")
        }
        // Full width inside whichever axis holds them, and large, so each is
        // over the 44pt floor on both axes rather than only across. Open and
        // Delete are the row's other two, and they clear it the same way.
        XCTAssertEqual(summary.components(separatedBy: ".frame(maxWidth: .infinity)").count - 1, 5,
                       "a row control is natural-width inside a turning stack")
        let row = try XCTUnwrap(summary.components(separatedBy: "private func fileRow(")
            .dropFirst().first?.components(separatedBy: "private func copyButton(").first)
        XCTAssertEqual(row.components(separatedBy: ".controlSize(.large)").count - 1, 3,
                       "a stored row's Open, handoff pair or Delete is under the hit floor")
    }

    /// The sign-in form is in the app's own container rather than in two
    /// opacities of its own.
    ///
    /// It is the first screen a person meets, and it was the one surface still
    /// drawing a `Color.secondary.opacity(0.07)` fill at radius 20 under a
    /// `0.14` stroke — numbers nothing else used, answering neither Increase
    /// Contrast nor dark mode the way the system fill does.
    func testTheSignInFormUsesTheSharedContainerAndTheSharedRefusalRole() throws {
        let form = try XCTUnwrap(try sources().first { $0.name == "SignInView.swift" }?.text)
        XCTAssertTrue(form.contains("SectionCard {"),
                      "the form draws its own container again")
        XCTAssertFalse(form.contains("RoundedRectangle(cornerRadius: 20)"),
                       "the form kept its own corner and stroke")
        XCTAssertTrue(form.contains("InlineMessage(.warning, errorMessage)"),
                      "the refusal is stated in colour rather than in the shared role")
        // The refusal stays ABOVE the control it explains, in reading order.
        guard let refusal = form.range(of: "InlineMessage(.warning, errorMessage)"),
              let submit = form.range(of: "Button(action: submit)") else {
            return XCTFail("the form lost its refusal or its submit control")
        }
        XCTAssertTrue(refusal.upperBound < submit.lowerBound,
                      "the refusal is a decoration after the button rather than before it")
        // The Apple control keeps Apple's own minimum height, which is this
        // app's floor as well — through the token, not a repeated literal.
        XCTAssertTrue(form.contains(".frame(minHeight: Metrics.hitTarget)"))
    }

    /// Every state the account ROUTER draws is one card with one message role.
    ///
    /// Each of these is the whole screen when it is on screen, and each was a
    /// bare column on an otherwise empty page — which reads as something that
    /// failed to load rather than as the answer.
    func testEveryAccountRouterStateIsACardWithTheSharedMessageRoles() throws {
        let tab = try XCTUnwrap(try sources().first { $0.name == "AccountTab.swift" }?.text)
        for card in ["SectionCard(L10n.t(.contentCheckEmailTitle))",
                     "SectionCard(L10n.t(.contentAccountLoadFailed))",
                     "SectionCard(title)"] {
            XCTAssertTrue(tab.contains(card), "the account router lost \(card)")
        }
        // A request that succeeded and a request that failed land in the SAME
        // slot, so they must not be dressed the same way.
        XCTAssertTrue(tab.contains("InlineMessage(.info, L10n.t(.contentResendVerificationSent))"))
        XCTAssertTrue(tab.contains("InlineMessage(.warning, message)"))
        // The restore spinner is deliberately uncarded, and still labelled.
        XCTAssertTrue(tab.contains("ProgressView { Text(L10n.t(.accountRestoring)) }"))
        XCTAssertFalse(tab.contains("ProgressView()\n"),
                       "an unlabelled spinner reads as nothing")
    }

}
