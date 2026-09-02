import XCTest

/// **The two-physical-device Device Inbox roles for the 0.3.0 shell: one real
/// account, one real server, one run-unique delivery, asserted at both ends.**
///
/// A future launcher (`scripts/ios-device-inbox-acceptance.sh`, not yet written)
/// starts exactly one of the two tests below on each device and reads the
/// bounded `RELAYIUM-DEVICE-INBOX` lines back out of each runner's `xcodebuild`
/// log. Nothing else in this target drives a real delivery: the offline inbox
/// suites seed history through stores and say so; these roles move bytes.
///
/// ## The launch is the shipped one
///
/// Neither role passes `--relayium-ui-testing`, `--relayium-transfer-origin`,
/// `--relayium-ui-testing-fresh-received-folder`, or any credential. So the
/// keychain, the session, the enrolment, the device key, the receive loop, the
/// receive folder and the send pipeline are all the installed product's own.
/// Two consequences are deliberate and load-bearing:
///
///  - **the session is a person's.** Each device must already hold a session
///    signed in BY HAND to the shared acceptance account. A device that holds
///    none produces a named `XCTSkip` with the manual step in it, never a
///    driven sign-in form, an injected token or an environment credential;
///  - **the receiver's folder is never cleared.** A single flat file whose
///    name is already taken is REFUSED as `destinationOccupied` —
///    `ReceiveDestination`/`InboxCommit` never overwrite, merge into, or
///    rename a flat file — so a `Relayium product brief.txt` left by an
///    earlier run makes THIS run's delivery fail its commit honestly rather
///    than land under another name. Deleting the previous file (Files app →
///    Relayium → Received) between runs is an operator precondition, exactly
///    like Automation Mode — not something this harness may do to keep itself
///    green. The selected mini → iPad 7 direction was verified (read-only) to
///    hold no receiver `Received` directory yet, so its first run starts clean.
///
/// The one Debug-only argument the SENDER adds is
/// `--relayium-ui-testing-pending-fixture`, which stages the 1,536-byte
/// `Relayium product brief.txt` into the sending app's own Documents and does
/// nothing else. The system Files picker, the security scope, the expansion,
/// the composer, the upload and the tracking poll are all production code.
///
/// ## What makes stale history unable to satisfy a run
///
/// Every content assertion is scoped to a timeline row (`inbox-entry.<id>`)
/// whose identifier was NOT on screen when this run started: each role
/// snapshots the open conversation's entry identifiers before the delivery
/// begins and accepts only rows minted after it. The message is additionally
/// run-unique (the launcher composes it from the run tag), and the file row
/// must render the exact staged name — so a previous run's identical outgoing
/// row, or a previously received copy of the same brief, is excluded by
/// identifier before it is ever compared by content.
///
/// ## Which row may be tapped
///
/// The peer is named by `RELAYIUM_DEVICE_INBOX_PEER_ID` and matched as the
/// COMPLETE identifier `inbox-conversation.<id>` — never a suffix, because ids
/// may contain dots and `bar.foo` ends like `foo`. Without that variable a role
/// proceeds only when the list offers exactly one row; two rows are a refusal
/// naming both, not a guess.
final class DeviceInboxAcceptanceUITests: XCTestCase {

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    // MARK: - the receiving role

    /// Adopt the manually signed-in account, turn the shipped receiving consent
    /// to automatic, publish readiness, and hold the peer's conversation open
    /// until one run-unique message and the exact staged brief both commit.
    func testPhysicalReceiverCommitsOneRunUniqueMessageAndTheStagedBrief() throws {
        let run = try requireRun(role: Role.receiver)
        let app = XCUIApplication()
        launch(app, arguments: [])

        try requireSignedInDeviceInbox(in: app)
        emit(.ready, value: "1", for: run)

        setReceivePolicyAutomatic(in: app)
        awaitStatus(Copy.readyAutomatic, in: app, within: Budget.establish,
                    describing: "the receiver's own readiness line")

        guard let peer = openPeerConversation(run, in: app) else { return }
        // Snapshotted BEFORE readiness is published: the launcher starts the
        // sender only after RECEIVING, so no entry of this run's delivery can
        // predate the snapshot that excludes stale ones.
        let seen = timelineEntryIdentifiers(in: app)
        emit(.peer, value: peer, for: run)
        emit(.receiving, value: "auto", for: run)

        guard awaitTimelineEntry(containing: run.message,
                                 directionPrefix: Copy.receivedPrefix,
                                 state: nil, excluding: seen,
                                 within: run.deliveryBudget, in: app,
                                 describing: "this run's message from the sender")
        else { return }
        emit(.message, value: run.message, for: run)

        guard awaitTimelineEntry(containing: Fixture.name,
                                 directionPrefix: Copy.receivedPrefix,
                                 state: nil, excluding: seen,
                                 within: run.deliveryBudget, in: app,
                                 describing: """
                                     this run's committed "\(Fixture.name)" row. If an \
                                     earlier run left a file of that name in Received, \
                                     this delivery was refused as a name conflict on \
                                     commit; delete the old file in the Files app \
                                     (Relayium → Received) and rerun
                                     """)
        else { return }
        // The comparison against the staged name happens above; the channel
        // admits no spaces, so the event's value is the run tag and the event
        // itself means "the exact name matched on this end".
        emit(.name, value: run.tag, for: run)
        emit(.file, value: "committed", for: run)

        // Stay foreground on the committed state for the fixed holding window
        // while the launcher takes its read-only container digest — the one
        // receiver claim no UI line can carry.
        emit(.holding, value: "1", for: run)
        holdCommittedState(run, in: app)
        emit(.done, value: "1", for: run)
    }

    // MARK: - the sending role

    /// Adopt the manually signed-in account, open the named peer's page, send
    /// one run-unique message, then choose the Debug-staged brief through the
    /// real Files picker and send it — asserting both outgoing rows reach
    /// "Saved on the other device", which only the peer's commit can produce.
    func testPhysicalSenderDeliversOneRunUniqueMessageAndTheStagedBrief() throws {
        let run = try requireRun(role: Role.sender)
        let app = XCUIApplication()
        launch(app, arguments: [UITestArgument.pendingFixture])

        try requireSignedInDeviceInbox(in: app)
        emit(.ready, value: "1", for: run)

        guard let target = openPeerConversation(run, in: app) else { return }
        let composer = app.descendants(matching: .any)[A11y.messageField].firstMatch
        guard composer.waitForExistence(timeout: Budget.settle) else {
            return XCTFail("""
                the peer's page offers no message composer, so this device cannot \
                send to it. \(app.debugDescription)
                """)
        }
        emit(.target, value: target, for: run)
        let seen = timelineEntryIdentifiers(in: app)

        // The message first: it needs no picker, so a failure here is about the
        // send path itself rather than about document-browser automation.
        scrollUntilHittable(composer, in: app)
        composer.tap()
        composer.typeText(run.message)
        let sendMessage = app.buttons[A11y.sendMessage].firstMatch
        XCTAssertTrue(sendMessage.waitForExistence(timeout: Budget.settle),
                      "typing a message did not enable the shipped Send")
        scrollUntilHittable(sendMessage, in: app)
        sendMessage.tap()
        guard awaitTimelineEntry(containing: run.message,
                                 directionPrefix: Copy.sentPrefix,
                                 state: Copy.savedOnTarget, excluding: seen,
                                 within: run.deliveryBudget, in: app,
                                 describing: "this run's outgoing message reaching "
                                     + "\"\(Copy.savedOnTarget)\"")
        else { return }
        emit(.message, value: run.message, for: run)

        // Then the staged brief, through the real system document browser.
        let choose = app.buttons[A11y.chooseFiles].firstMatch
        XCTAssertTrue(choose.waitForExistence(timeout: Budget.settle),
                      "the peer's page offers no file selection")
        scrollUntilHittable(choose, in: app)
        choose.tap()
        selectStagedBrief(in: app)

        let staged = app.descendants(matching: .any)[A11y.firstPendingFile].firstMatch
        XCTAssertTrue(staged.waitForExistence(timeout: Budget.settle),
                      "the picked brief did not appear as a pending file")
        XCTAssertTrue(staged.label.contains(Fixture.name),
                      "the pending row renders \"\(staged.label)\", not the staged brief")
        let sendFiles = app.buttons[A11y.sendFiles].firstMatch
        XCTAssertTrue(sendFiles.waitForExistence(timeout: Budget.settle),
                      "a staged batch produced no Send control")
        scrollUntilHittable(sendFiles, in: app)
        sendFiles.tap()

        guard awaitTimelineEntry(containing: Fixture.name,
                                 directionPrefix: Copy.sentPrefix,
                                 state: Copy.savedOnTarget, excluding: seen,
                                 within: run.deliveryBudget, in: app,
                                 describing: "this run's outgoing \"\(Fixture.name)\" "
                                     + "reaching \"\(Copy.savedOnTarget)\"")
        else { return }
        emit(.name, value: run.tag, for: run)
        emit(.file, value: "saved", for: run)
        emit(.done, value: "1", for: run)
    }

    // MARK: - the run this process was launched for

    private struct Run {
        let tag: String
        let role: String
        /// The exact run-unique text the sender sends and the receiver awaits.
        /// One value, two spendings, disambiguated by role.
        let message: String
        /// The peer's device-directory id, or nil for the single-row rule.
        let peerID: String?
        /// Bounds waiting for the OTHER runner or an operator-shaped condition.
        let peerBudget: TimeInterval
        /// Bounds the delivery itself: a real upload, queue, download, commit
        /// and the sender's ~5s tracking poll observing the peer's save.
        let deliveryBudget: TimeInterval
        /// The receiver's fixed foreground holding window after commit, during
        /// which the launcher takes its read-only container digest. Strictly
        /// bounded: `RELAYIUM_DEVICE_INBOX_HOLD_SECONDS`, default 90, clamped
        /// to 30...300. Nothing shortens it and nothing signals into it.
        let holdWindow: TimeInterval
    }

    /// A run description that is present and self-contradictory. Distinct from
    /// the skip a MISSING description produces: absence means the fast offline
    /// smoke is running this target whole; contradiction means the launcher and
    /// this suite disagree, which must fail rather than retire the role green.
    private struct RunError: Error, CustomStringConvertible {
        let description: String
    }

    private enum Role {
        static let sender = "sender"
        static let receiver = "receiver"
    }

    private func requireRun(role expected: String) throws -> Run {
        let environment = ProcessInfo.processInfo.environment
        func value(_ name: String) -> String? {
            let raw = environment["RELAYIUM_DEVICE_INBOX_\(name)"]
            return (raw?.isEmpty == false) ? raw : nil
        }
        guard let tag = value("TAG"), let role = value("ROLE"),
              let message = value("MESSAGE") else {
            throw XCTSkip("""
                No two-device Device Inbox run. These roles need a second physical \
                device driving the other half of the same delivery; start them \
                through the Device Inbox acceptance launcher.
                """)
        }
        // Refused, never repaired: a value outside the bounded set means this
        // process and its launcher disagree about the grammar, and any line
        // published from it would carry something other than what was described.
        guard Channel.isEmittable(tag), Channel.isEmittable(role),
              Channel.isEmittable(message) else {
            throw RunError(description: """
                the run tag, role or message is outside the bounded character set \
                this channel admits (ASCII letters, digits, ".", "_", "-"; 1–64 \
                characters), so this runner could not publish what it observes.
                """)
        }
        if let peer = value("PEER_ID"), !Channel.isEmittable(peer) {
            throw RunError(description: """
                RELAYIUM_DEVICE_INBOX_PEER_ID is outside the bounded character set \
                this channel admits, so the row it names could never be echoed back.
                """)
        }
        guard role == Role.sender || role == Role.receiver else {
            throw RunError(description: """
                RELAYIUM_DEVICE_INBOX_ROLE is "\(role)", which is neither \
                "\(Role.sender)" nor "\(Role.receiver)".
                """)
        }
        guard role == expected else {
            throw XCTSkip("this runner was launched as \(role), not \(expected)")
        }
        func budget(_ name: String, fallback: TimeInterval) -> TimeInterval {
            let raw = value(name).flatMap(TimeInterval.init) ?? fallback
            return min(max(raw, 30), 1_800)
        }
        return Run(tag: tag, role: role, message: message,
                   peerID: value("PEER_ID"),
                   peerBudget: budget("PEER_BUDGET_SECONDS", fallback: 300),
                   deliveryBudget: budget("DELIVERY_BUDGET_SECONDS", fallback: 300),
                   holdWindow: min(max(value("HOLD_SECONDS")
                       .flatMap(TimeInterval.init) ?? 90, 30), 300))
    }

    // MARK: - the launch

    /// The shipped configuration plus, for the sender, the one Debug-only
    /// staging argument. The locale is pinned because every assertion below
    /// names a rendered English string; a device left in another language would
    /// fail on copy rather than on behaviour.
    private func launch(_ app: XCUIApplication, arguments: [String]) {
        app.launchArguments =
            ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + arguments
        app.launch()
    }

    // MARK: - the manually established session

    /// On the Device Inbox destination with a usable account, or a skip that
    /// quotes the by-hand step. Uses the shared shell helper, so an iPhone tab
    /// bar, a visible iPad sidebar and an iPadOS-18 collapsed sidebar all
    /// resolve the same way.
    private func requireSignedInDeviceInbox(in app: XCUIApplication) throws {
        open(Shell.deviceInbox, in: app)
        let policy = app.descendants(matching: .any)[A11y.policy].firstMatch
        let account = app.buttons[A11y.openAccount].firstMatch
        let deadline = Date().addingTimeInterval(Budget.establish)
        while Date() < deadline {
            if policy.exists { return }
            if account.exists {
                throw XCTSkip("""
                    This device holds no usable signed-in session, and this harness \
                    will not inject one. SIGN IN BY HAND: open Relayium on this \
                    device, go to Account, sign in to the shared acceptance account \
                    (resolving any verify/frozen state the Account screen shows), \
                    return to Device Inbox, confirm the Receiving control is drawn, \
                    then rerun. No credential may be passed to this runner or the app.
                    """)
            }
            _ = policy.waitForExistence(timeout: 1)
        }
        XCTFail("""
            Device Inbox rendered neither its receiving consent nor an account \
            route within \(Int(Budget.establish))s. \(app.debugDescription)
            """)
    }

    // MARK: - the one consent, driven through the shipped control

    /// `.pickerStyle(.inline)` outside a `List` resolves to a wheel on iOS, so
    /// the automatic answer is chosen by adjusting the wheel and proved by
    /// reading the wheel's own value back — the setter, not the layout.
    private func setReceivePolicyAutomatic(in app: XCUIApplication) {
        let policy = app.descendants(matching: .any)[A11y.policy].firstMatch
        scrollUntilHittable(policy, in: app)
        let wheel = policy.pickerWheels.firstMatch
        XCTAssertTrue(wheel.waitForExistence(timeout: Budget.settle),
                      "the receiving consent cannot be operated")
        wheel.adjust(toPickerWheelValue: Copy.policyAutomatic)
        XCTAssertEqual(wheel.value as? String, Copy.policyAutomatic,
                       "the receiving consent did not take \"\(Copy.policyAutomatic)\"")
    }

    /// Wait for the status line to render exactly `expected`. The status is the
    /// controller's own runtime answer, so this is what proves the policy
    /// reached central and the receive loop is live — not the wheel position.
    private func awaitStatus(_ expected: String, in app: XCUIApplication,
                             within budget: TimeInterval, describing what: String) {
        let status = app.staticTexts[A11y.status].firstMatch
        let deadline = Date().addingTimeInterval(budget)
        while Date() < deadline {
            if status.exists, status.label == expected { return }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("""
            \(what) never rendered "\(expected)" within \(Int(budget))s; the status \
            reads "\(status.exists ? status.label : "<absent>")". \
            \(app.debugDescription)
            """)
    }

    // MARK: - which row may be opened

    /// The one conversation row this run may tap, opened, with its directory id
    /// returned — or nil after a named failure. Polls because the account's
    /// device directory fills asynchronously and the peer may still be
    /// enrolling; refuses because a wrong row sends a real delivery to a real
    /// device nobody named.
    private func openPeerConversation(_ run: Run, in app: XCUIApplication) -> String? {
        let rows = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", A11y.rowPrefix))
        let refresh = app.buttons[A11y.refreshDevices].firstMatch
        let deadline = Date().addingTimeInterval(run.peerBudget)
        var lastSeen: [String] = []
        while Date() < deadline {
            let candidates = rows.allElementsBoundByIndex
            lastSeen = candidates.map(\.identifier)
            if let wanted = run.peerID {
                // The COMPLETE identifier, never a suffix: ids may contain dots,
                // so `…bar.foo` must not satisfy a run that named `foo`.
                let exact = A11y.rowPrefix + wanted
                if let row = candidates.first(where: { $0.identifier == exact }) {
                    return openConversationRow(row, id: wanted, in: app)
                }
            } else if candidates.count == 1,
                      let id = rowID(of: candidates[0].identifier) {
                return openConversationRow(candidates[0], id: id, in: app)
            } else if candidates.count > 1 {
                XCTFail("""
                    the Device Inbox lists \(candidates.count) devices \
                    [\(describeRows(candidates).joined(separator: "; "))] and no \
                    RELAYIUM_DEVICE_INBOX_PEER_ID names one. This run will not \
                    choose between real devices.
                    """)
                return nil
            }
            if refresh.exists, refresh.isEnabled, refresh.isHittable { refresh.tap() }
            Thread.sleep(forTimeInterval: 2)
        }
        XCTFail("""
            no row for \(run.peerID.map { "device \"\($0)\"" } ?? "exactly one device") \
            appeared within \(Int(run.peerBudget))s; the list offered \
            [\(lastSeen.joined(separator: ", "))]. \(app.debugDescription)
            """)
        return nil
    }

    /// Tap one row and prove the conversation page itself rendered, through the
    /// compose section both sendable and unsendable peers draw.
    private func openConversationRow(_ row: XCUIElement, id: String,
                                     in app: XCUIApplication) -> String? {
        scrollUntilHittable(row, in: app)
        row.tap()
        let composer = app.descendants(matching: .any)[A11y.messageField].firstMatch
        let unavailable = app.descendants(matching: .any)[A11y.composeUnavailable].firstMatch
        let deadline = Date().addingTimeInterval(Budget.settle)
        while Date() < deadline {
            if composer.exists || unavailable.exists { return id }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("""
            the row for "\(id)" was tapped but its conversation page did not \
            render. \(app.debugDescription)
            """)
        return nil
    }

    /// One description per listed row, pairing the exact accessibility
    /// identifier with the spoken accessibility label that names the device a
    /// human recognises, plus the peer id that identifier encodes — the exact
    /// value RELAYIUM_DEVICE_INBOX_PEER_ID would need. Read only while the
    /// refusal above is already certain, so naming the intended device is a
    /// lookup rather than another physical acceptance run. This reports; it
    /// never selects.
    private func describeRows(_ candidates: [XCUIElement]) -> [String] {
        candidates.map { row in
            let label = row.label
            let peer = rowID(of: row.identifier)
            return """
                identifier="\(row.identifier)" \
                label="\(label.isEmpty ? "<empty>" : label)" \
                peerID=\(peer.map { "\"\($0)\"" } ?? "<none>")
                """
        }
    }

    private func rowID(of identifier: String) -> String? {
        guard identifier.hasPrefix(A11y.rowPrefix) else { return nil }
        let id = String(identifier.dropFirst(A11y.rowPrefix.count))
        return id.isEmpty ? nil : id
    }

    // MARK: - row-scoped timeline evidence

    /// Every `inbox-entry.<id>` currently in the hierarchy. The conversation's
    /// timeline is a plain `VStack`, so entries exist whether or not they are
    /// scrolled on screen.
    private func timelineEntryIdentifiers(in app: XCUIApplication) -> Set<String> {
        Set(app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", A11y.entryPrefix))
            .allElementsBoundByIndex.map(\.identifier))
    }

    /// One timeline row that (1) was minted after `excluding` was snapshotted,
    /// (2) contains exactly `text`, (3) states its direction with `prefix`, and
    /// (4) — when required — renders exactly `state`. All four in one row: a
    /// stale row of the same content fails (1), a row of the other direction
    /// fails (3), and an outgoing row that has not been committed by the peer
    /// fails (4). Re-queried every pass rather than held, so a SwiftUI redraw
    /// cannot leave this asserting against a stale element.
    @discardableResult
    private func awaitTimelineEntry(containing text: String,
                                    directionPrefix prefix: String,
                                    state: String?,
                                    excluding seen: Set<String>,
                                    within budget: TimeInterval,
                                    in app: XCUIApplication,
                                    describing what: String) -> Bool {
        let entries = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", A11y.entryPrefix))
        let deadline = Date().addingTimeInterval(budget)
        while Date() < deadline {
            for entry in entries.allElementsBoundByIndex
            where !seen.contains(entry.identifier) {
                guard entry.staticTexts.matching(
                    NSPredicate(format: "label == %@", text)).firstMatch.exists
                else { continue }
                let direction = entry.staticTexts[A11y.entryDirection].firstMatch
                guard direction.exists, direction.label.hasPrefix(prefix) else { continue }
                if let state {
                    let rendered = entry.staticTexts[A11y.entryState].firstMatch
                    guard rendered.exists, rendered.label == state else { continue }
                }
                return true
            }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTFail("""
            \(what) never appeared within \(Int(budget))s. \(app.debugDescription)
            """)
        return false
    }

    // MARK: - the real Files picker

    /// Land the system document browser on Browse, in whichever of its two real
    /// shapes iOS presented: compact widths draw the `DOC.browsingModeTabBar`
    /// chooser, while full-width iPadOS 18 opens directly on the
    /// `DOCSidebarView` Browse column and never draws that tab bar. Nothing
    /// downstream weakens — the brief still has to be found, tapped and
    /// confirmed through the real Open.
    private func selectStagedBrief(in app: XCUIApplication) {
        let browsingTabs = app.tabBars["DOC.browsingModeTabBar"]
        let sidebar = app.navigationBars[
            "com_apple_DocumentManager_Service.DOCSidebarView"]
        let opened = Date().addingTimeInterval(Budget.picker)
        var browsing = false
        repeat {
            if sidebar.exists { browsing = true; break }
            if browsingTabs.waitForExistence(timeout: 1) {
                browsingTabs.buttons["Browse"].tap()
                browsing = true
                break
            }
        } while Date() < opened
        guard browsing else {
            return XCTFail("""
                choosing files did not present the system document browser. \
                \(app.debugDescription)
                """)
        }

        // The browser reopens wherever a previous import left it: inside the
        // app folder, at its parent, or at the Locations root — which names the
        // device it is on. All are valid states of the same real picker, so
        // walk in from whichever is offered rather than encode one.
        if !tapBrowserItem(labelledLike: Fixture.stem, timeout: 2, in: app) {
            let appFolder = app.descendants(matching: .any)["Relayium"].firstMatch
            if appFolder.waitForExistence(timeout: 2) {
                appFolder.tap()
            } else {
                let device = app.descendants(matching: .any).matching(
                    NSPredicate(format: "label == %@ OR label == %@",
                                "On My iPhone", "On My iPad")).firstMatch
                guard device.waitForExistence(timeout: Budget.picker) else {
                    return XCTFail("""
                        the system document browser offers no on-device location. \
                        \(app.debugDescription)
                        """)
                }
                device.tap()
                let folder = app.descendants(matching: .any)["Relayium"].firstMatch
                guard folder.waitForExistence(timeout: Budget.picker) else {
                    return XCTFail("""
                        the on-device location does not list the Relayium folder. \
                        \(app.debugDescription)
                        """)
                }
                folder.tap()
            }
            guard tapBrowserItem(labelledLike: Fixture.stem, timeout: Budget.settle,
                                 in: app) else {
                return XCTFail("""
                    the staged "\(Fixture.stem)" is not in the browser — the \
                    sender launch may not have staged it. \(app.debugDescription)
                    """)
            }
        }

        let open = app.buttons["Open"]
        XCTAssertTrue(open.waitForExistence(timeout: Budget.settle),
                      "the system browser offered no confirmation action")
        open.tap()
    }

    /// Files hides a known extension, so the brief is matched by the stem it is
    /// guaranteed to render rather than a display name the OS may shorten.
    private func tapBrowserItem(labelledLike stem: String, timeout: TimeInterval,
                                in app: XCUIApplication) -> Bool {
        let item = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH %@", stem)).firstMatch
        guard item.waitForExistence(timeout: timeout) else { return false }
        item.tap()
        return true
    }

    // MARK: - staying foreground while the launcher digests this device's container

    /// The launcher's read-only digest of the receiving device's app container
    /// is only evidence while the receiving app is still foreground on its
    /// committed state — a post-exit container read cannot distinguish bytes
    /// never written from bytes the exit removed. So after publishing HOLDING
    /// the receiver simply stays present for its fixed, strictly bounded
    /// window. Nothing shortens it and nothing signals into it: no launcher,
    /// present or future, writes into this test runner's container or any
    /// device container. The window elapses, the foreground claim is asserted,
    /// and DONE is the role's last line before the runner exits naturally.
    private func holdCommittedState(_ run: Run, in app: XCUIApplication) {
        let deadline = Date().addingTimeInterval(run.holdWindow)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertEqual(app.state, .runningForeground, """
            the receiving app left the foreground during its fixed \
            \(Int(run.holdWindow))s holding window, so a digest the launcher \
            took in that window is not evidence about the state this device \
            reached.
            """)
        print("""
            \(Channel.marker) note: \(run.role) held its committed state \
            foreground for its fixed \(Int(run.holdWindow))s window.
            """)
        fflush(stdout)
    }

    // MARK: - publishing one fact to the launcher

    private func emit(_ event: Channel.Event, value: String, for run: Run,
                      file: StaticString = #filePath, line: UInt = #line) {
        guard Channel.isEmittable(value) else {
            return XCTFail("""
                refusing to publish \(event.rawValue) = "\(value)": it is outside \
                the bounded set this channel admits.
                """, file: file, line: line)
        }
        print("\(Channel.marker) \(run.tag) \(run.role) \(event.rawValue) \(value)")
        fflush(stdout)
    }

    // MARK: - the shared vocabulary

    /// The bounded line grammar a later parser will read back out of this
    /// runner's log: `RELAYIUM-DEVICE-INBOX <tag> <role> <EVENT> <value>`, all
    /// five fields from the same character set `isEmittable` admits. Its own
    /// marker, because the pair harness publishes through the same shape and
    /// both vocabularies contain READY.
    private enum Channel {
        // nonlocalized: a machine-read marker, never displayed
        static let marker = "RELAYIUM-DEVICE-INBOX"

        enum Event: String {
            /// On the Device Inbox destination with a usable account.
            case ready = "READY"
            /// The shipped consent is automatic AND the status line reports the
            /// runtime ready state — the start barrier for the sender.
            case receiving = "RECEIVING"
            /// The conversation the receiver opened, by the peer's directory id.
            case peer = "PEER"
            /// The row the sender selected, by its directory id.
            case target = "TARGET"
            /// The run-unique message reached its terminal state on this end.
            case message = "MESSAGE"
            /// This end rendered the exact staged file name. The value is the
            /// run tag: the channel admits no spaces, so the comparison is made
            /// in-process and the event means it matched.
            case name = "NAME"
            /// The file batch reached its terminal state on this end.
            case file = "FILE"
            /// The receiver is staying foreground for its fixed holding
            /// window while the launcher takes a read-only container digest.
            case holding = "HOLDING"
            /// This role's assertions are complete.
            case done = "DONE"
        }

        static func isEmittable(_ value: String) -> Bool {
            guard (1...64).contains(value.count) else { return false }
            return value.allSatisfy {
                $0.isASCII && ($0.isLetter || $0.isNumber
                               || $0 == "." || $0 == "_" || $0 == "-")
            }
        }
    }

    /// The staged brief, repeated from `UITestMode.pendingFixtureName` because a
    /// UI-test target links no product module — and deliberately a CONSTANT
    /// rather than an environment value, so the name both ends assert is the
    /// name the sender's launch actually stages.
    private enum Fixture {
        static let bundleID = "com.relayium.app"
        // nonlocalized: the Debug-staged acceptance fixture
        static let name = "Relayium product brief.txt"
        static let stem = "Relayium product brief"
    }

    private enum UITestArgument {
        /// `UITestMode.pendingFixtureArgument`; `#if DEBUG`, absent from Release.
        static let pendingFixture = "--relayium-ui-testing-pending-fixture"
    }

    /// Stable identifiers the product stamps, shared with the offline suites.
    private enum A11y {
        static let policy = "inbox-policy"
        static let status = "inbox-status"
        static let openAccount = "inbox-open-account"
        static let refreshDevices = "inbox-devices-refresh"
        static let rowPrefix = "inbox-conversation."
        static let entryPrefix = "inbox-entry."
        static let entryDirection = "inbox-entry-direction"
        static let entryState = "inbox-entry-state"
        static let messageField = "inbox-message-field"
        static let sendMessage = "inbox-send-message"
        static let chooseFiles = "inbox-choose-files"
        static let sendFiles = "inbox-send-files"
        static let composeUnavailable = "inbox-compose-unavailable"
        static let firstPendingFile = "pendingFile.0"
    }

    /// Rendered English copy, under the pinned launch locale. Each string is
    /// read back off a shipped control before anything relies on it, so a copy
    /// change fails here visibly rather than weakening an assertion.
    private enum Copy {
        /// `inbox.policyAuto` — the wheel value that is the user's consent.
        static let policyAutomatic = "Receive automatically from my account"
        /// `inbox.statusReadyAuto` — the runtime state, not the wheel position.
        static let readyAutomatic = "Ready to receive"
        /// `inbox.timelineReceivedFrom` / `inbox.timelineSentTo`, up to their
        /// peer-name placeholder.
        static let receivedPrefix = "From "
        static let sentPrefix = "To "
        /// `inbox.sentStateSaved` — the one outgoing state only the peer's
        /// commit, observed through the sender's tracking poll, can produce.
        static let savedOnTarget = "Saved on the other device"
    }

    /// Budgets for steps that involve no other device; the run description
    /// bounds everything that does.
    private enum Budget {
        /// The shell, the session restore, or the consent reaching central.
        static let establish: TimeInterval = 120
        /// One local rendering step settling.
        static let settle: TimeInterval = 30
        /// The system document browser presenting one of its shapes.
        static let picker: TimeInterval = 20
    }
}
