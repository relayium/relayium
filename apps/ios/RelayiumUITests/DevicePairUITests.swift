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

    /// End the link and dismiss its result, which is two controls and not one.
    private func endLinkAndDismiss(file: StaticString = #filePath, line: UInt = #line) {
        let leave = app.buttons[DevicePair.endConnectionLabel]
        XCTAssertTrue(leave.waitForExistence(timeout: DevicePair.settleBudget),
                      "a live link offers no way out", file: file, line: line)
        scrollUntilHittable(leave, in: app, file: file, line: line)
        leave.tap()
        let done = app.buttons[DevicePair.doneLabel]
        XCTAssertTrue(done.waitForExistence(timeout: DevicePair.establishBudget), """
            ending the connection did not produce its terminal Done.
            \(app.debugDescription)
            """, file: file, line: line)
        scrollUntilHittable(done, in: app, file: file, line: line)
        done.tap()
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

        // The inbound link, drawn by the Nearby tab because this device is on
        // it. Nothing that could send is on screen until the digits are
        // answered — the model refuses it — so the verification card is what
        // arrives first.
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
        // Staged BEFORE connecting, which is the shape the copy under Connect
        // promises: the files travel with the connection and are released once
        // the digits are compared. The staging seam replaces the system document
        // browser and nothing else — the scope, the expansion, the limits, the
        // pending row, the arming and the wire are all production.
        launchForDevicePair(app, verifying: true, stagingFixture: true)

        guard openDevicePairDestination(DevicePair.nearbySurface, in: app)
        else { return }
        requireVerificationIsOn()
        emitDevicePair(.ready, value: run.tag, for: run)

        XCTAssertTrue(app.descendants(matching: .any)["pendingFile.0"]
            .waitForExistence(timeout: DevicePair.settleBudget),
                      "the preselected fixture never became a pending Nearby send")

        guard let row = awaitPeerRow(run, in: app) else { return }
        scrollUntilHittable(row, in: app)
        row.tap()

        awaitLabel(containing: DevicePair.stagedTravelsNote, in: app,
                   within: DevicePair.settleBudget,
                   describing: "the note that a staged batch travels with the connection")

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

        // The armed batch was released by the confirmation and nothing else,
        // and it reaches its terminal state only once the peer has accepted and
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

    // MARK: - the pairing-code (legacy lane) steps both code flows share

    /// **The one manual step this harness cannot take, written once.**
    ///
    /// Two checks reach this same conclusion — the staged-batch precondition
    /// below and `mintCode` itself — and they must say the whole action rather
    /// than half of it, because which of the two speaks first is an accident of
    /// the flow and the operator reading a skipped run gets only one of them.
    private static let createCodeNeedsAnAccount = """
        This device cannot create a pairing code: it holds no ready account. \
        Creating a code needs one; joining a code does not. Sign in ONCE by \
        hand on this device, with a verified address and any plan — the run \
        passes no --relayium-ui-testing, so the app uses the product's own \
        keychain and that session persists across runs. This harness holds no \
        credential and reads none.
        """

    /// Open the Direct tab in one of its two modes.
    ///
    /// The mode picker is above both cards, governs Create AND Join, and a code
    /// carries no type — which is exactly what the shipped hint says. So both
    /// ends must select the same mode, and neither may infer it.
    private func openPairingTab(mode: String) -> Bool {
        guard openDevicePairDestination(DevicePair.directSurface, in: app)
        else { return false }
        let segment = app.buttons[mode]
        guard segment.waitForExistence(timeout: DevicePair.settleBudget) else {
            XCTFail("""
                the Direct tab offers no "\(mode)" mode.
                \(app.debugDescription)
                """)
            return false
        }
        scrollUntilHittable(segment, in: app)
        segment.tap()
        return true
    }

    /// The staged batch a legacy code carries — **or the account gate that
    /// replaces the entire card it would have appeared in.**
    ///
    /// `DirectView.createFiles` renders `PendingFileList` INSIDE its
    /// `case .allowed = gate` branch, so a device with no ready account draws
    /// neither the pending row nor Create; it draws
    /// `DevicePair.createCodeGateTitle`. Asserting the row on its own therefore
    /// turned the one condition `mintCode` already knows how to skip for into a
    /// timeout naming a fixture that was never the problem — a signed-out phone
    /// reported as a staging failure, which is what the retained run shows.
    ///
    /// The two states are waited for TOGETHER, for the reason `mintCode` waits
    /// for both of its: `AccountSession.restore()` is a keychain read followed
    /// by a network refresh, so for the first seconds of a cold launch NEITHER
    /// exists, and a fixed pre-check that expired inside that window would
    /// answer with whichever half it happened to be looking at.
    ///
    /// **The staged row wins ties.** On a settled screen the two are mutually
    /// exclusive, but a restore resolving mid-check can leave a gate readable
    /// for one snapshot after the account became ready — and skipping a run two
    /// people's devices are already held for is by far the more expensive of
    /// the two mistakes. Nothing is lost by preferring to continue: `mintCode`
    /// re-reads the gate on the very next line and skips there, in these same
    /// words, if it is genuinely still up.
    private func requireStagedFixtureUnlessAccountGated(
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let pending = app.descendants(matching: .any)["pendingFile.0"]
        let gate = app.staticTexts[DevicePair.createCodeGateTitle]
        let deadline = Date().addingTimeInterval(DevicePair.establishBudget)
        while Date() < deadline, !pending.exists, !gate.exists {
            Thread.sleep(forTimeInterval: 1)
        }
        if pending.exists { return }
        if gate.exists { throw XCTSkip(Self.createCodeNeedsAnAccount) }
        XCTFail("""
            the preselected fixture never became a pending direct send, and this \
            device is not account-gated either: after \
            \(Int(DevicePair.establishBudget))s the Direct tab offered neither a \
            staged row nor "\(DevicePair.createCodeGateTitle)".
            \(app.debugDescription)
            """, file: file, line: line)
    }

    /// Mint a code through the shipped Create control, and publish the digits
    /// while this runner is still on the handoff screen holding them.
    ///
    /// A device with no account SKIPS with the manual step quoted. Creating a
    /// code costs an account and joining one does not, so a signed-out device
    /// renders the gate instead of Create — and timing out on a button nobody
    /// drew would report that as a transport failure.
    private func mintCode(_ run: DevicePairRun,
                          create: String,
                          heading: String) throws -> String? {
        // Wait for whichever of the two arrives, rather than pre-checking the
        // gate for a fixed few seconds. `AccountSession.restore()` is a keychain
        // read followed by a network refresh, so for the first seconds of a cold
        // launch this card shows a spinner and NEITHER control exists — and a
        // fixed pre-check that expired during it would go on to fail on a
        // missing Create button instead of skipping with the manual step.
        let gate = app.staticTexts[DevicePair.createCodeGateTitle]
        let button = app.buttons[create]
        let deadline = Date().addingTimeInterval(DevicePair.establishBudget)
        while Date() < deadline, !gate.exists, !button.exists {
            Thread.sleep(forTimeInterval: 1)
        }
        if gate.exists { throw XCTSkip(Self.createCodeNeedsAnAccount) }
        XCTAssertTrue(button.exists, """
            the Direct tab offers neither "\(create)" nor the account gate that replaces \
            it, after \(Int(DevicePair.establishBudget))s.
            \(app.debugDescription)
            """)
        scrollUntilHittable(button, in: app)
        button.tap()

        guard awaitLabel(containing: heading, in: app,
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

    /// Type the digits the other device minted into the shipped field and join.
    private func joinCode(_ run: DevicePairRun) throws {
        guard let code = run.pairingCode else {
            throw XCTSkip("this joining role was started with no pairing code")
        }
        let field = app.textFields[DevicePair.codeFieldLabel]
        XCTAssertTrue(field.waitForExistence(timeout: DevicePair.settleBudget), """
            the Direct tab offers no code field.
            \(app.debugDescription)
            """)
        scrollUntilHittable(field, in: app)
        field.tap()
        field.typeText(code)
        // Read back before Join. `PairingCodeInput` normalises what it is given,
        // and a field that dropped or reordered a digit under the keyboard would
        // otherwise present as "the other device never answered".
        XCTAssertEqual(field.value as? String, code,
                       "the code field did not take the digits the peer minted")
        let join = app.buttons[DevicePair.joinLabel]
        XCTAssertTrue(join.waitForExistence(timeout: DevicePair.settleBudget),
                      "the Direct tab offers no Join")
        scrollUntilHittable(join, in: app)
        join.tap()
    }

    // MARK: - Cross-network files, the minting half

    func testPairingCodeFilesAreSentToThePhysicalPeer() throws {
        let run = try requireDevicePairRun(role: "pair-file-generator")
        app = XCUIApplication()
        launchForDevicePair(app, verifying: true, stagingFixture: true)

        guard openPairingTab(mode: DevicePair.filesModeLabel) else { return }
        requireVerificationIsOn()

        // Staged before the code exists, because on this platform a legacy code
        // carries the batch that was chosen before it was minted. Create is
        // disabled with nothing staged, so this is a precondition of the tap
        // below and not decoration — but only on a device that can mint at all,
        // which is why the account gate is read HERE rather than one step later.
        try requireStagedFixtureUnlessAccountGated()

        guard try mintCode(run, create: DevicePair.createCodeLabel,
                           heading: DevicePair.giveCodeHeading) != nil else { return }

        // The legacy lane's own gate, whose words are NOT the workspace's.
        compareAndConfirm(run, title: DevicePair.legacyVerifyTitle,
                          confirm: DevicePair.legacyMatchesLabel)

        awaitLabel(containing: DevicePair.filesSentTitle, in: app,
                   within: DevicePair.transferBudget,
                   describing: "this device's own record of what it sent")

        let done = app.buttons[DevicePair.doneLabel]
        XCTAssertTrue(done.waitForExistence(timeout: DevicePair.settleBudget),
                      "the completed transfer offers no way out")
        scrollUntilHittable(done, in: app)
        done.tap()
    }

    // MARK: - Cross-network files, the joining half

    func testPairingCodeFilesFromThePhysicalPeerAreReceived() throws {
        let run = try requireDevicePairRun(role: "pair-file-joiner")
        app = XCUIApplication()
        // The receiving half, for the same reason the Nearby resident is: a
        // fixed destination that refuses a taken name makes the second run of
        // this phase fail on the first run's own file.
        launchForDevicePair(app, verifying: true,
                            freshReceivedFolder: !run.keepsReceivedFolder)

        guard openPairingTab(mode: DevicePair.filesModeLabel) else { return }
        requireVerificationIsOn()
        emitDevicePair(.ready, value: run.tag, for: run)

        try joinCode(run)

        compareAndConfirm(run, title: DevicePair.legacyVerifyTitle,
                          confirm: DevicePair.legacyMatchesLabel)

        awaitLabel(containing: DevicePair.filesReceivedTitle, in: app,
                   within: DevicePair.transferBudget,
                   describing: "this device's own record of what it received")
        // **The receiver naming the file, not merely reporting a success.**
        // `DirectFileSessionView.fileList` renders
        // `FileIdentityPresentation.name(for:)` for every entry of the manifest
        // this device actually took, so this is the received NAME and not the
        // sender's description of it. The BYTES are proved separately, by the
        // launcher, out of this device's container.
        awaitLabel(containing: DevicePair.fixtureName, in: app,
                   within: DevicePair.settleBudget,
                   describing: "the name of the file this device received")
        emitDevicePair(.received, value: run.tag, for: run)
        // Held HERE, before Done, because Done is a product action with its own
        // consequences for what is on this device's disk. Reading the container
        // only after it would let one outcome — the file is gone — stand for
        // both "it was never written" and "dismissing the receipt removed it".
        holdForContainerRead(run, in: app, showing: DevicePair.filesReceivedTitle)

        let done = app.buttons[DevicePair.doneLabel]
        XCTAssertTrue(done.waitForExistence(timeout: DevicePair.settleBudget),
                      "the completed receive offers no way out")
        scrollUntilHittable(done, in: app)
        done.tap()
    }

    // MARK: - Cross-network text, the minting half

    func testPairingCodeTextIsExchangedWithThePhysicalPeer() throws {
        let run = try requireDevicePairRun(role: "pair-text-generator")
        app = XCUIApplication()
        launchForDevicePair(app, verifying: true)

        guard openPairingTab(mode: DevicePair.textModeLabel) else { return }
        requireVerificationIsOn()

        guard try mintCode(run, create: DevicePair.textCreateCodeLabel,
                           heading: DevicePair.textGiveCodeHeading) != nil else { return }

        // The INITIATING side of the text lane renders its digits in the code
        // grid, exactly as the files lane does.
        compareAndConfirm(run, title: DevicePair.textVerifyTitle,
                          confirm: DevicePair.legacyMatchesLabel)

        awaitLabel(containing: DevicePair.textSessionHeading, in: app,
                   within: DevicePair.establishBudget,
                   describing: "the open text session")
        // The minting side speaks first and the joining side answers, for the
        // same reason the Nearby conversation is ordered: a lane that is still
        // opening holds one message, and two simultaneous first messages is a
        // race with nothing to prove.
        sendMessage(run.message, composer: DevicePair.textComposerLabel)
        awaitPeerMessage(run)

        let end = app.buttons[DevicePair.endSessionLabel]
        XCTAssertTrue(end.waitForExistence(timeout: DevicePair.settleBudget),
                      "the open text session offers no way out")
        scrollUntilHittable(end, in: app)
        end.tap()
    }

    // MARK: - Cross-network text, the joining half

    func testPairingCodeTextFromThePhysicalPeerIsExchanged() throws {
        let run = try requireDevicePairRun(role: "pair-text-joiner")
        app = XCUIApplication()
        launchForDevicePair(app, verifying: true)

        guard openPairingTab(mode: DevicePair.textModeLabel) else { return }
        requireVerificationIsOn()
        emitDevicePair(.ready, value: run.tag, for: run)

        try joinCode(run)

        // **The responder's gate is a different screen, and this is the one
        // place the two halves of the text lane genuinely diverge.** With
        // advanced verification on, `RealtimeTextSessionModel` puts the
        // RESPONDER in `.incomingRequest`, which renders the digits inside
        // `text.verifiedPhrase` — ordinary prose, not the code grid — and offers
        // Accept rather than "They match". Driving the initiator's vocabulary
        // here would time out on controls this state never draws.
        guard awaitLabel(containing: DevicePair.textIncomingHeading, in: app,
                         within: DevicePair.establishBudget,
                         describing: "the incoming text request") else { return }
        guard let digits = awaitDigitsInPhrase(
            prefixed: DevicePair.verifiedPhrasePrefix, in: app,
            within: DevicePair.verificationBudget,
            describing: "the code this device derived") else { return }
        emitDevicePair(.sas, value: digits, for: run)

        let accept = app.buttons[DevicePair.acceptLabel]
        XCTAssertTrue(accept.waitForExistence(timeout: DevicePair.settleBudget),
                      "the incoming request offers no Accept")
        scrollUntilHittable(accept, in: app)
        accept.tap()

        awaitLabel(containing: DevicePair.textSessionHeading, in: app,
                   within: DevicePair.establishBudget,
                   describing: "the open text session")
        awaitPeerMessage(run)
        sendMessage(run.message, composer: DevicePair.textComposerLabel)

        let end = app.buttons[DevicePair.endSessionLabel]
        XCTAssertTrue(end.waitForExistence(timeout: DevicePair.settleBudget),
                      "the open text session offers no way out")
        scrollUntilHittable(end, in: app)
        end.tap()
    }
}
