import XCTest

/// **One half of a two-physical-device acceptance run, per test.**
///
/// Each test here drives ONE device. The launcher
/// (`scripts/ios-device-pair-acceptance.sh`) starts the other half on the other
/// device, sequences the two through published facts rather than sleeps, and is
/// the only thing that ever sees both sides — which is why the SAS comparison
/// lives there and not here: neither test process can read the other's.
///
/// Every test skips when the launcher's description is absent, because this file
/// lives in the same `RelayiumUITests` target the fast offline smoke runs whole.
/// A skip is visible in the result bundle; a test deleted from a scheme is not.
///
/// ## The two flows, as current `main` actually composes them
///
///  * **Nearby** is the code-less room, and on this branch BOTH iOS ends
///    announce exact `link/1` (`LINK_BUILD_SUPPORT` is true on iOS). So a
///    selected roster row offers ONE verb — Connect — and produces the unified
///    workspace: one connection, verified once, carrying a conversation and file
///    batches in both directions.
///  * **A pairing code is NOT that**, and the difference is the single most
///    important reconciliation in this file. `LINK_PAIRING_ROOM_SUPPORT` is
///    `false` off macOS, so `linkRoomActive(isCodelessRoom: false)` answers false
///    on iOS: a code here establishes the LEGACY lane and its own session view,
///    stage-before-connect, one direction of files per session, with its own
///    verification gate whose words are different from the workspace's. A
///    harness that drove the workspace's vocabulary against a pairing code would
///    time out on controls this platform never draws.
final class DevicePairUITests: XCTestCase {

    private var app: XCUIApplication!

    /// Stop at the first failure. Almost every assertion below is a bounded
    /// wait, so continuing past one produces not more information but one
    /// timeout after another against a screen that is already wrong — and each
    /// of those is minutes of two people's hardware.
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    // MARK: - shared steps

    /// Read the verification preference back off the SHIPPED toggle.
    ///
    /// Not a courtesy check. The launch pins `com.relayium.verifyPeers` through
    /// `NSArgumentDomain`; if the product ever stopped reading that key the pin
    /// would be inert, the device would resolve the shipped default (off), and
    /// every SAS assertion in this file would silently become unreachable while
    /// the run still passed. This is what makes that impossible.
    private func requireVerificationIsOn(file: StaticString = #filePath,
                                         line: UInt = #line) {
        let toggle = app.switches[DevicePair.verifyToggleLabel]
        XCTAssertTrue(toggle.waitForExistence(timeout: 30),
                      "this screen offers no verification setting", file: file, line: line)
        scrollUntilHittable(toggle, in: app, file: file, line: line)
        XCTAssertEqual(toggle.value as? String, "1", """
            this launch asked for advanced verification and the app resolved it \
            OFF, so the short-authentication boundary this run exists to compare \
            would never appear.
            """, file: file, line: line)
    }

    /// The one gate both flows share: read the digits this device derived,
    /// publish them, and confirm.
    ///
    /// **Publish BEFORE confirming.** The launcher requires the two published
    /// values equal, and a value published after the gate was answered could not
    /// have decided anything. Emitting first is what makes the comparison a
    /// precondition of the transfer rather than a description of it.
    @discardableResult
    private func compareAndConfirm(_ run: DevicePairRun,
                                   title: String,
                                   confirm: String,
                                   file: StaticString = #filePath,
                                   line: UInt = #line) -> String? {
        guard awaitLabel(containing: title, in: app,
                         within: DevicePair.establishBudget,
                         describing: "the verification boundary",
                         file: file, line: line) else { return nil }
        guard let digits = awaitSpokenDigits(
            in: app, within: DevicePair.verificationBudget,
            describing: "the code this device derived", file: file, line: line)
        else { return nil }
        emitDevicePair(.sas, value: digits, for: run, file: file, line: line)
        let button = app.buttons[confirm]
        XCTAssertTrue(button.waitForExistence(timeout: DevicePair.settleBudget),
                      "the verification card offers no \"\(confirm)\"",
                      file: file, line: line)
        scrollUntilHittable(button, in: app, file: file, line: line)
        button.tap()
        return digits
    }

    /// Type one run-unique message into a composer and send it.
    ///
    /// NOT `app.buttons["Send"]`: the tab bar carries a Send TAB with the same
    /// label and it matches first. It sits at the bottom of the screen, so with
    /// the keyboard raised it is never hittable and no amount of scrolling makes
    /// it so. Every composer in this app is inside its tab's own `ScrollView`,
    /// which the tab bar is not, so the scroll view is the discriminator rather
    /// than a label or a position.
    private func sendMessage(_ body: String,
                             composer label: String,
                             file: StaticString = #filePath,
                             line: UInt = #line) {
        let composer = app.textFields[label]
        XCTAssertTrue(composer.waitForExistence(timeout: DevicePair.establishBudget),
                      "this session offers no composer", file: file, line: line)
        scrollUntilHittable(composer, in: app, file: file, line: line)
        composer.tap()
        composer.typeText(body)
        let send = app.scrollViews.buttons[DevicePair.sendLabel].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: DevicePair.settleBudget),
                      "the composer offers no way to send", file: file, line: line)
        scrollUntilHittable(send, in: app, file: file, line: line)
        send.tap()
    }

    /// The peer's exact text, on this device's transcript.
    ///
    /// The string is unique to the run, the flow and the direction, so this is
    /// an assertion about WHO is on the other end and not merely that something
    /// arrived. A device talking to an unrelated Relayium on the same public
    /// address fails here.
    private func awaitPeerMessage(_ run: DevicePairRun,
                                  file: StaticString = #filePath,
                                  line: UInt = #line) {
        guard let expected = run.peerMessage else {
            XCTFail("this role was given no peer message to assert",
                    file: file, line: line)
            return
        }
        awaitLabel(containing: expected, in: app, within: DevicePair.transferBudget,
                   describing: "the message the other device sent",
                   file: file, line: line)
    }

    /// A batch row inside the workspace's own transfers container, in one
    /// terminal state.
    ///
    /// Scoped to `link.a11yTransfers` deliberately. "Done" is both the terminal
    /// state of an outbound batch and the label of the workspace's exit button
    /// once the link has ended, and an unscoped query would let the second
    /// answer a question about the first.
    private func awaitBatchState(_ state: String,
                                 file: StaticString = #filePath,
                                 line: UInt = #line) {
        let transfers = app.otherElements[DevicePair.transfersLabel]
        XCTAssertTrue(transfers.waitForExistence(timeout: DevicePair.transferBudget), """
            the workspace never listed a transfer.
            \(app.debugDescription)
            """, file: file, line: line)
        let row = transfers.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS %@", state)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: DevicePair.transferBudget), """
            no transfer on this connection reached "\(state)" within \
            \(Int(DevicePair.transferBudget))s.
            \(app.debugDescription)
            """, file: file, line: line)
    }

    /// End the link and dismiss its result, which is two controls and not one
    /// — unless the peer ended the link first, in which case it is one.
    ///
    /// The workspace draws a SINGLE exit button whose title flips from
    /// `End connection` to `Done` the moment the connection is `.ended`, and
    /// either device ending it ends it for BOTH. That is not a corner case in
    /// this harness, it is the resident's normal window: the container-read
    /// hold sits between its last assertion and this call, and the connector is
    /// free to finish and end the link inside it. This device then arrives here
    /// with a workspace that has already ended and a button that says `Done` —
    /// and an unconditional wait for `End connection` would spend the settle
    /// budget on a control the product will never draw again, then fail a run in
    /// which nothing went wrong and blame the exit for the peer's timing.
    ///
    /// So the exit is RESOLVED — and resolved REPEATEDLY, because the answer
    /// has a shelf life of one screen read. Deciding ONCE that the link is
    /// still live and then acting on that decision is the same bug one step
    /// later: the decision is followed by scrolling, scrolling takes seconds,
    /// and the peer is entitled to end the link inside them. The title then
    /// correctly becomes `Done`, `End connection` is gone, and a helper that
    /// asserts reachability fails a device that is showing exactly the right
    /// screen — a red the product earned by behaving correctly. A valid title
    /// replacement is never an error here.
    ///
    /// What runs instead is a small bounded state machine over one deadline.
    /// Every pass re-reads which title the single button is carrying and takes
    /// at most ONE action: press `End connection` if it is genuinely hittable,
    /// spend ONE scroll gesture toward it if it is not, or — if that title is
    /// simply gone — accept the `Done` that has replaced it. Nothing survives a
    /// pass except how much of the scrolling repertoire is left, so there is no
    /// window in which a stale reading outlives the screen it was taken from.
    /// The live verb is asked about first on every pass, which is what keeps a
    /// still-connected workspace out of the peer-ended branch.
    ///
    /// The claim is unweakened. The deadline is the same ceiling the
    /// unconditional wait had and expiring it still fails, with a message that
    /// distinguishes "never drawn" from "drawn but never reachable". And
    /// whichever exit the workspace offered, `Done` must then exist, become
    /// genuinely hittable, and be pressed exactly once — the terminal claim
    /// this helper has always made, and the reason it sits outside the branch.
    private func endLinkAndDismiss(file: StaticString = #filePath, line: UInt = #line) {
        let leave = app.buttons[DevicePair.endConnectionLabel]
        let done = app.buttons[DevicePair.doneLabel]

        let deadline = Date().addingTimeInterval(DevicePair.settleBudget)
        var pressedLeave = false
        var peerEnded = false
        var sawLeave = false
        var gesturesSpent = 0

        while !pressedLeave && !peerEnded && Date() < deadline {
            // Nothing is remembered about the title across a pass. Each of
            // these reads is taken now, acted on once, and thrown away.
            if leave.exists {
                sawLeave = true
                if leave.isHittable {
                    // The one irreducible instant: the tap follows the reach
                    // check with nothing between them. XCUITest offers no
                    // atomic read-and-press, and a window one statement wide is
                    // not the seconds-long window scrolling used to open.
                    leave.tap()
                    confirmLocalTextDiscardIfAsked()
                    pressedLeave = true
                } else if gesturesSpent < Self.exitReachGestures {
                    // One gesture, then back to the top of the loop to re-read
                    // the title. A control that disappears during this is the
                    // product being correct, and the next pass says so.
                    scrollOnce(step: gesturesSpent)
                    gesturesSpent += 1
                } else {
                    Thread.sleep(forTimeInterval: 0.5)
                }
            } else if done.exists {
                peerEnded = true
            } else {
                Thread.sleep(forTimeInterval: 0.5)
            }
        }

        if !pressedLeave && !peerEnded {
            let unresolved = sawLeave
                ? "\"\(DevicePair.endConnectionLabel)\" was drawn but never became reachable"
                : "neither \"\(DevicePair.endConnectionLabel)\" nor the "
                    + "\"\(DevicePair.doneLabel)\" a peer-ended link is replaced by was ever drawn"
            XCTFail("""
                a live link offers no way out: within \(Int(DevicePair.settleBudget))s this \
                workspace never presented an exit this device could press — \(unresolved).
                \(app.debugDescription)
                """, file: file, line: line)
            // Explicit rather than implied by `continueAfterFailure = false`, so
            // this cannot become a second full-budget timeout if that flips.
            return
        }

        if peerEnded {
            // Said out loud so a reader of the retained log knows this run took
            // the peer-ended exit and did not merely fail to see one control.
            print("""
                \(DevicePairChannel.marker) note: the peer had already ended the link, so \
                this device dismissed a workspace that was offering "\(DevicePair.doneLabel)" \
                rather than ending a connection that was already over.
                """)
        }

        XCTAssertTrue(done.waitForExistence(timeout: DevicePair.establishBudget), """
            ending the connection did not produce its terminal Done.
            \(app.debugDescription)
            """, file: file, line: line)
        scrollUntilHittable(done, in: app, file: file, line: line)
        done.tap()
        // Only a PEER-ended link still holds its transcript here: this device's
        // own confirmed exit above already cleared it.
        confirmLocalTextDiscardIfAsked()
    }

    /// **Take the confirmation a workspace exit raises when it would destroy
    /// text.**
    ///
    /// Since iOS 0.4.0 the unified workspace asks before Leave or Done discards a
    /// transcript or a draft — the conversation is stored nowhere else. A run
    /// that exchanged no text raises nothing, and this returns without pressing
    /// anything.
    ///
    /// **Answered by identifier, because the label is ambiguous by design.** The
    /// dialog's destructive button carries the SAME title as the control that
    /// raised it, so a label query returns both it and the workspace control
    /// underneath. This used to take the last index on the belief that the
    /// topmost element sorts last; it does not. The same selector in
    /// `LocalSessionUITests` picked the obscured `link-leave-session` beneath
    /// the sheet on 2026-09-18 and failed "not hittable" while the dialog was
    /// genuinely up. `link-discard-local-text-confirm` is the shipped
    /// identifier on the dialog's own button, while the workspace control
    /// underneath carries `link-leave-session` — so the identifier picks the
    /// sheet rather than the thing it covers.
    ///
    /// **`.firstMatch`, because the identifier is not unique — it is NESTED.**
    /// The `a6f50064` run showed UIKit giving the sheet's action a wrapper
    /// element and an inner one, BOTH carrying this identifier and this label;
    /// existence was satisfied and only the tap failed on "Find single matching
    /// element". Both matches are the same button, so taking the outer wrapper
    /// is a choice between two views of one control rather than between two
    /// controls — and it still holds if the pair collapses to one element on a
    /// future OS. See `LocalSessionUITests.confirmLocalTextDiscard`, which
    /// carries the captured hierarchy.
    ///
    /// The title read above still decides WHETHER anything is pressed, which is
    /// what keeps this "if asked".
    private func confirmLocalTextDiscardIfAsked() {
        let asked = app.staticTexts.matching(NSPredicate(
            format: "label == %@ OR label == %@",
            "Discard local text?", "Discard the unsent message?")).firstMatch
        guard asked.waitForExistence(timeout: 5) else { return }
        let confirm = app.buttons
            .matching(identifier: "link-discard-local-text-confirm").firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), """
            the discard confirmation is up but carries no destructive button of \
            its own.
            \(app.debugDescription)
            """)
        confirm.tap()
    }

    /// The size of the scrolling repertoire below, which is `scrollUntilHittable`'s.
    private static let exitReachGestures = 18

    /// `scrollUntilHittable`'s scrolling, taken ONE gesture at a time.
    ///
    /// Same repertoire in the same order — swipes up first, then short drags
    /// forward, then short drags back — and the same total, so a control this
    /// reaches is a control that helper would have reached. The only difference
    /// is that the caller gets the screen back between gestures, which is what
    /// lets it notice a legitimate title replacement instead of asserting that
    /// the control it was chasing "never became reachable".
    private func scrollOnce(step: Int) {
        switch step {
        case ..<6: app.swipeUp()
        case ..<10: dragScreen(by: 0.22)
        default: dragScreen(by: -0.22)
        }
    }

    private func dragScreen(by fraction: CGFloat) {
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let target = app.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5 - fraction))
        middle.press(forDuration: 0.05, thenDragTo: target)
    }

    /// **The end barrier: stay in the room until the peer has left it.**
    ///
    /// The connecting runner's last assertion is that Done returned it to a
    /// working roster — which the roster can only satisfy while this device is
    /// still in the room. A resident that finished first would take itself out
    /// and fail the other side's claim about a product that did nothing wrong.
    ///
    /// The release condition is a PRODUCT-OBSERVABLE fact rather than a sleep:
    /// the peer's row leaves this device's roster when the peer's app
    /// terminates, which is what the other runner finishing does. The budget is
    /// a ceiling on that observation and not a wait, and expiring it is reported
    /// rather than failed — every claim this role owns has already been made,
    /// and turning "the roster took longer than expected to notice a departure"
    /// into a red run would attribute the other side's timing to this one.
    private func holdRoomUntilPeerLeaves(_ run: DevicePairRun) {
        emitDevicePair(.holding, value: run.tag, for: run)
        let deadline = Date().addingTimeInterval(run.peerBudget)
        while Date() < deadline {
            let (contained, named) = rosterCandidates(run, in: app)
            if contained.isEmpty && named.isEmpty { return }
            Thread.sleep(forTimeInterval: 2)
        }
        // Deliberately not a failure. Said out loud so a reader of the retained
        // log knows this run ended on a ceiling rather than on an observation.
        print("""
            \(DevicePairChannel.marker) note: \(run.role) held the room for its \
            full \(Int(run.peerBudget))s ceiling; the peer's row had not left \
            this device's roster.
            """)
    }

    // MARK: - Nearby, the resident half
    //
    // Started FIRST by the launcher, and alone. It publishes READY once its app
    // is in the room, and only then is the connecting device started — see
    // `ios_await_event`. Two `xcodebuild` UI-test sessions started in the same
    // breath contend for Automation Mode on their devices, which costs a run and
    // blames the wrong device.

    func testNearbyAcceptsThePhysicalPeerAndTransfersBothWays() throws {
        let run = try requireDevicePairRun(role: "nearby-resident")
        app = XCUIApplication()
        // The receiving half of this phase, so it takes the empty `Received`
        // folder a fresh install has. iOS has no folder picker for a download:
        // the destination is fixed and the product REFUSES a name already taken,
        // so without this the SECOND run of this phase would fail on a file the
        // FIRST run legitimately kept — and the launcher could not identify the
        // bytes it pulls back by name.
        launchForDevicePair(app, verifying: true,
                            freshReceivedFolder: !run.keepsReceivedFolder)

        guard openDevicePairDestination(DevicePair.nearbySurface, in: app)
        else { return }
        requireVerificationIsOn()

        // The listener really did start. A physical launch passes no
        // `--relayium-ui-testing`, so it takes `RelayiumApp`'s ordinary
        // residency arm; asserting the absence of the paused and off states is
        // what would catch that composition silently reverting and leaving this
        // run to prove that nothing arrives.
        XCTAssertFalse(app.staticTexts[DevicePair.pausedStatus].exists,
                       "this device paused its Nearby listener, so it is not in the room")
        XCTAssertFalse(app.staticTexts[DevicePair.offStatus].exists,
                       "this device's Nearby listener never started, so it is not in the room")

        // IN the room, not merely on its way there. The launcher starts the
        // connecting device only after this line, so publishing on anything
        // weaker would hand the connector an empty roster to fail against.
        guard awaitLabel(containing: DevicePair.readyStatus, in: app,
                         within: run.peerBudget,
                         describing: "this device joining the Nearby room") else { return }
        emitDevicePair(.ready, value: run.tag, for: run)

        // **The unrequested connection asks first (A23).** Nothing connects,
        // claims the tab or navigates until this device's user accepts, so the
        // prompt at the top of the Nearby tab is what arrives first — and its
        // Accept is the one tap that lets the link in.
        let acceptConnection = app.buttons["nearby-incoming-accept"]
        XCTAssertTrue(acceptConnection.waitForExistence(timeout: DevicePair.transferBudget), """
            the connecting device's ask never reached this device as a prompt.
            \(app.debugDescription)
            """)
        scrollUntilHittable(acceptConnection, in: app)
        acceptConnection.tap()

        // The inbound link, drawn by the Nearby tab because this device is on
        // it. Nothing that could send is on screen until the digits are
        // answered — the model refuses it — so the verification card is what
        // arrives next.
        compareAndConfirm(run, title: DevicePair.verifyTitle,
                          confirm: DevicePair.verifyMatchesLabel)

        // Both directions of the conversation, over the one connection — and
        // SERIALIZED, first this way then the other.
        //
        // `LinkWorkspaceModel.send` opens the conversation on the first message
        // and holds exactly one message while the peer answers that request.
        // Two devices pressing Send in the same second is therefore a race with
        // nothing to gain: this side sends and the connector waits for it, then
        // the connector sends and this side waits. Neither wait is a clock.
        sendMessage(run.message, composer: DevicePair.composerLabel)
        awaitPeerMessage(run)

        // The inbound batch, which crosses the same verification boundary the
        // conversation did: accepting a manifest releases a write to this user's
        // disk, so the button is refused until `acceptsWork`.
        let accept = app.buttons[DevicePair.acceptFilesLabel]
        XCTAssertTrue(accept.waitForExistence(timeout: DevicePair.transferBudget), """
            the peer's staged batch never reached this device as an offer.
            \(app.debugDescription)
            """)
        scrollUntilHittable(accept, in: app)
        accept.tap()

        awaitBatchState(DevicePair.batchSavedLabel)
        // The app's own claim that it committed. The launcher then reads the
        // bytes out of this device's container and hashes them, because a
        // rendered "Saved" describes a batch and cannot describe its contents.
        emitDevicePair(.received, value: run.tag, for: run)
        // ...and it reads them while this app is STILL HERE, holding what it
        // just committed, before anything below dismisses the link. The same
        // check is taken again after this runner exits; the two together are
        // what separate a receiver that never wrote from one whose files did not
        // survive being dismissed.
        holdForContainerRead(run, in: app, showing: DevicePair.batchSavedLabel)

        endLinkAndDismiss()
        holdRoomUntilPeerLeaves(run)
    }

    // MARK: - Nearby, the connecting half

    func testNearbyConnectsToThePhysicalPeerAndTransfersBothWays() throws {
        let run = try requireDevicePairRun(role: "nearby-connector")
        app = XCUIApplication()
        // **Connect first (A25).** Nothing is staged before the link exists.
        // The link-fixture seam hands the OPEN workspace the fixture once it
        // accepts work — after the digits are answered — through the importer
        // callback the system document browser would have called; the
        // selection, the scope, the limits, the wire and the peer's writer are
        // all production.
        launchForDevicePair(app, verifying: true, stagingFixture: true)

        guard openDevicePairDestination(DevicePair.nearbySurface, in: app)
        else { return }
        requireVerificationIsOn()
        emitDevicePair(.ready, value: run.tag, for: run)

        guard let row = awaitPeerRow(run, in: app) else { return }
        scrollUntilHittable(row, in: app)
        row.tap()

        // A `link/1` peer offers exactly one verb, and its presence is the
        // assertion that the capability announcement crossed the room and was
        // believed: a legacy peer would render Send and "Start a message
        // session" instead.
        let connect = app.buttons[DevicePair.connectLabel]
        XCTAssertTrue(connect.waitForExistence(timeout: DevicePair.settleBudget),
                      "the selected roster row offered no unified Connect for a link/1 peer")
        scrollUntilHittable(connect, in: app)
        connect.tap()

        compareAndConfirm(run, title: DevicePair.verifyTitle,
                          confirm: DevicePair.verifyMatchesLabel)

        // The resident opens the conversation; this side answers it. See its
        // own comment for why the two directions are ordered rather than raced.
        awaitPeerMessage(run)
        sendMessage(run.message, composer: DevicePair.composerLabel)

        // The batch was handed to the link only once it accepted work, and it
        // reaches its terminal state only once the peer has accepted and
        // written it — which is what orders this runner behind the resident
        // without either of them waiting on a clock.
        awaitBatchState(DevicePair.batchFinishedLabel)

        endLinkAndDismiss()

        // Back to the roster, with nothing of the finished session left on it.
        // The resident is deliberately still in the room — see
        // `holdRoomUntilPeerLeaves` — so this can require the roster to name it
        // again rather than merely to have lost its workspace.
        XCTAssertNotNil(awaitPeerRow(run, in: app),
                        "Done did not return this device to a working roster")
        XCTAssertFalse(app.otherElements[DevicePair.conversationLabel].exists,
                       "Done left the finished conversation on the roster screen")
        XCTAssertFalse(app.otherElements[DevicePair.transfersLabel].exists,
                       "Done left the finished transfer list on the roster screen")
    }

    // MARK: - the Cross-network steps both code roles share
    //
    // Cross-network is connect-first as of iOS 0.4.0: a code is created or
    // entered with nothing chosen beforehand, the room is watched as a `link/1`
    // client, and the connected peer is drawn by the SAME unified workspace the
    // Nearby roles above drive. So everything after the code is the workspace
    // vocabulary — `compareAndConfirm` with the link's own gate, `sendMessage`,
    // `awaitPeerMessage`, `endLinkAndDismiss` — and the legacy lane's words
    // ("Check this matches", "Private text session", "End session") no longer
    // appear on this screen at all.
    //
    // **Re-authored against source, not yet run.** These roles need two physical
    // devices. They were rewritten with the surface on 2026-09-17 and have not
    // been driven since; the first physical run is their acceptance.

    /// **The one manual step this harness cannot take, written once.**
    private static let createCodeNeedsAnAccount = """
        This device cannot create a pairing code: it holds no ready account. \
        Creating a code needs one; joining a code does not. Sign in ONCE by \
        hand on this device, with a verified address and any plan — the run \
        passes no --relayium-ui-testing, so the app uses the product's own \
        keychain and that session persists across runs. This harness holds no \
        credential and reads none.
        """

    /// **Why the two FILE roles skip.** A connect-first surface chooses its
    /// batch inside the workspace, through the system document browser, and
    /// this harness has no way to drive that browser on a physical device. The
    /// legacy lane staged its batch BEFORE the code existed, which is what the
    /// old pre-connect direct-selection seam stood in for; there is no
    /// pre-connect selection left for it to fill. The unified workspace's file
    /// lane is still proved on hardware by the two Nearby roles, which drive the
    /// same view over the same `link/1` through the in-workspace
    /// `--relayium-ui-testing-link-fixture` seam (A25). These Cross-network roles
    /// do not pass it yet, so a file crossing a RELAYED pairing room from an
    /// iPhone is still not proved on hardware; that remains its own requirement.
    private static let filePhaseNeedsAWorkspaceStagingSeam = """
        The Cross-network file phase is not driveable yet: since iOS 0.4.0 the \
        batch is chosen inside the connected workspace through the system \
        document browser, which this harness cannot operate. Run the \
        pair-text phase for the pairing room and the Nearby phase for the \
        workspace's file lane. This is a recorded gap, not a pass.
        """

    private func openPairingTab() -> Bool {
        openDevicePairDestination(DevicePair.directSurface, in: app)
    }

    /// Mint a code through the shipped Create control, and publish the digits
    /// while this runner is still on the handoff screen holding them.
    ///
    /// A device with no account SKIPS with the manual step quoted. Creating a
    /// code costs an account and joining one does not, so a signed-out device
    /// renders the gate instead of Create — and timing out on a button nobody
    /// drew would report that as a transport failure.
    private func mintCode(_ run: DevicePairRun) throws -> String? {
        // Wait for whichever of the two arrives, rather than pre-checking the
        // gate for a fixed few seconds. `AccountSession.restore()` is a keychain
        // read followed by a network refresh, so for the first seconds of a cold
        // launch this card shows a spinner and NEITHER control exists.
        let gate = app.staticTexts[DevicePair.createCodeGateTitle]
        let button = app.buttons[DevicePair.createCodeLabel]
        let deadline = Date().addingTimeInterval(DevicePair.establishBudget)
        while Date() < deadline, !gate.exists, !button.exists {
            Thread.sleep(forTimeInterval: 1)
        }
        if gate.exists { throw XCTSkip(Self.createCodeNeedsAnAccount) }
        XCTAssertTrue(button.exists, """
            Cross-network offers neither "\(DevicePair.createCodeLabel)" nor the account \
            gate that replaces it, after \(Int(DevicePair.establishBudget))s.
            \(app.debugDescription)
            """)
        scrollUntilHittable(button, in: app)
        button.tap()

        guard awaitLabel(containing: DevicePair.giveCodeHeading, in: app,
                         within: DevicePair.establishBudget,
                         describing: "the pairing-code handoff") else { return nil }
        guard let digits = awaitSpokenDigits(
            in: app, within: DevicePair.settleBudget,
            describing: "the pairing code this device minted") else { return nil }
        emitDevicePair(.pairingCode, value: digits, for: run)
        // AFTER the code is on screen and published, never before: the launcher
        // reads the code out of this runner's log and only then starts the
        // joining device, so READY here would open that gate on a screen that
        // has nothing to join yet.
        emitDevicePair(.ready, value: run.tag, for: run)
        return digits
    }

    /// Type the digits the other device minted into the shipped field and
    /// connect.
    private func joinCode(_ run: DevicePairRun) throws {
        guard let code = run.pairingCode else {
            throw XCTSkip("this joining role was started with no pairing code")
        }
        let field = app.textFields[DevicePair.codeFieldLabel]
        XCTAssertTrue(field.waitForExistence(timeout: DevicePair.settleBudget), """
            Cross-network offers no code field.
            \(app.debugDescription)
            """)
        scrollUntilHittable(field, in: app)
        field.tap()
        field.typeText(code)
        // Read back before connecting. `PairingCodeInput` normalises what it is
        // given, and a field that dropped or reordered a digit under the
        // keyboard would otherwise present as "the other device never answered".
        XCTAssertEqual(field.value as? String, code,
                       "the code field did not take the digits the peer minted")
        let join = app.buttons[DevicePair.joinCodeLabel]
        XCTAssertTrue(join.waitForExistence(timeout: DevicePair.settleBudget),
                      "Cross-network offers no way to connect with a typed code")
        scrollUntilHittable(join, in: app)
        join.tap()
    }

    // MARK: - Cross-network files: recorded as not driveable

    func testPairingCodeFilesAreSentToThePhysicalPeer() throws {
        _ = try requireDevicePairRun(role: "pair-file-generator")
        throw XCTSkip(Self.filePhaseNeedsAWorkspaceStagingSeam)
    }

    func testPairingCodeFilesFromThePhysicalPeerAreReceived() throws {
        _ = try requireDevicePairRun(role: "pair-file-joiner")
        throw XCTSkip(Self.filePhaseNeedsAWorkspaceStagingSeam)
    }

    // MARK: - Cross-network conversation, the minting half

    func testPairingCodeTextIsExchangedWithThePhysicalPeer() throws {
        let run = try requireDevicePairRun(role: "pair-text-generator")
        app = XCUIApplication()
        launchForDevicePair(app, verifying: true)

        guard openPairingTab() else { return }
        requireVerificationIsOn()

        guard try mintCode(run) != nil else { return }

        // The WORKSPACE's gate — one verification per link — because a code now
        // opens the same unified link the Nearby roles drive. Reaching it at all
        // is the assertion that this device announced `link/1` in the pairing
        // room and the peer believed it, which is exactly what iOS 0.3.2 did not
        // do.
        compareAndConfirm(run, title: DevicePair.verifyTitle,
                          confirm: DevicePair.verifyMatchesLabel)

        // The minting side speaks first and the joining side answers, for the
        // reason the Nearby conversation is ordered: the link holds one message
        // while the conversation opens, and two simultaneous first messages is a
        // race with nothing to prove.
        sendMessage(run.message, composer: DevicePair.composerLabel)
        awaitPeerMessage(run)

        endLinkAndDismiss()
        // Back to the connect phase, with the spent code retired rather than
        // redrawn under the controls.
        XCTAssertTrue(app.buttons[DevicePair.createCodeLabel]
            .waitForExistence(timeout: DevicePair.settleBudget),
                      "Done did not return Cross-network to its connect controls")
        XCTAssertFalse(app.staticTexts[DevicePair.giveCodeHeading].exists,
                       "the spent pairing code reappeared after the link ended")
    }

    // MARK: - Cross-network conversation, the joining half

    func testPairingCodeTextFromThePhysicalPeerIsExchanged() throws {
        let run = try requireDevicePairRun(role: "pair-text-joiner")
        app = XCUIApplication()
        launchForDevicePair(app, verifying: true)

        guard openPairingTab() else { return }
        requireVerificationIsOn()
        emitDevicePair(.ready, value: run.tag, for: run)

        try joinCode(run)

        // Both halves meet the same gate with the same words now. The legacy
        // text lane gave its responder a different screen — digits in prose and
        // an Accept — and none of that is drawn on this surface any more.
        compareAndConfirm(run, title: DevicePair.verifyTitle,
                          confirm: DevicePair.verifyMatchesLabel)

        awaitPeerMessage(run)
        sendMessage(run.message, composer: DevicePair.composerLabel)

        endLinkAndDismiss()
    }
}
