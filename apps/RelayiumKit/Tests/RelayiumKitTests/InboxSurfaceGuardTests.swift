import XCTest
@testable import RelayiumAppKit

/// What the Device Inbox surfaces are NOT allowed to contain.
///
/// Modelled on `MacSurfaceGuardTests` and for the same reason: these are
/// ABSENCES, and an absence has no runtime to observe. Four of them decide
/// whether the round's central claims are true at all.
///
///  1. **The receiver is app-scoped.** The product claim is that a Mac with its
///     window closed still receives. A controller owned by a view or by the
///     Settings scene stops the moment that scene goes away — which is precisely
///     the case the capability exists for.
///  2. **The session observer subscribes before any scene.** A sign-out or an
///     account switch must cancel the loop even while no window exists, and a
///     view-scoped observer is absent for exactly that interval.
///  3. **No surface renders a received file name or path.** The menu bar is drawn
///     over whatever the user is presenting; a notification preview is drawn on
///     the lock screen.
///  4. **No renderer may fall through to ready.** `InboxRuntimeState` is closed
///     and every renderer switches over all of it, because the fall-through state
///     would be a promise to a stranger that their file will land here.
final class InboxSurfaceGuardTests: XCTestCase {

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var macRoot: URL { appsRoot.appendingPathComponent("mac/Relayium") }
    private var packageRoot: URL {
        appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit")
    }

    /// A source with whole-line comments dropped — the same loader the other
    /// guards use, and for the same reason: these files explain what they
    /// deliberately do NOT do, so scanning raw text would fail on the very
    /// comments documenting the absence being checked.
    private func code(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
            .components(separatedBy: "\n")
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                    && !trimmed.hasPrefix("/*")
            }
            .joined(separator: "\n")
    }

    private func macSource(_ name: String) throws -> String {
        try code(macRoot.appendingPathComponent(name))
    }

    private func packageSource(_ name: String) throws -> String {
        try code(packageRoot.appendingPathComponent(name))
    }

    private func macSources() throws -> [(name: String, text: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: macRoot.path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertGreaterThanOrEqual(names.count, 30,
                                    "found \(names.count) sources at \(macRoot.path)")
        return try names.map { ($0, try code(macRoot.appendingPathComponent($0))) }
    }

    private func occurrences(of needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    // MARK: - the receiver outlives every window

    func testTheReceiverIsAppScopedAndItsSessionObserverStartsBeforeAnyScene() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("@StateObject private var inbox: InboxController"),
                      "the receiver belongs to the App, not to a window or a view")
        XCTAssertTrue(app.contains("private let inboxSession: InboxSessionBridge"),
                      "nothing retains the session observer, so it would be deallocated")
        guard let initRange = app.range(of: "init() {"),
              let body = app.range(of: "var body: some Scene"),
              let observe = app.range(of: "bridge.observe(account.$state") else {
            return XCTFail("RelayiumApp no longer has the shape this checks")
        }
        XCTAssertTrue(initRange.upperBound < observe.lowerBound
                      && observe.upperBound < body.lowerBound,
                      "the session subscription must be made in init, before any scene is built")
        XCTAssertEqual(occurrences(of: "InboxSessionBridge(", in: app), 1,
                       "a second bridge would be a second, competing session mapping")
        XCTAssertEqual(occurrences(of: "InboxController(runtime:", in: app), 0,
                       "the scene assembles the controller itself instead of using the factory")
        // Both surfaces render the SAME object. Two controllers would be two
        // schedulers claiming against one account. Two rather than three since
        // the settings tab left: the main window, which holds the Device Inbox
        // destination, and the menu bar, which is the only surface visible while
        // the window is closed.
        XCTAssertEqual(occurrences(of: ".environmentObject(inbox)", in: app), 2,
                       "the main window and the menu bar must share one controller")
        // The same for the login-item preference. It reaches the main window for
        // the Device Inbox destination's residency control and the settings
        // scene for the Open at Login switch. Two preferences would be two
        // answers to a question `SMAppService` has only one of.
        XCTAssertEqual(occurrences(of: ".environmentObject(loginItem)", in: app), 2,
                       "the two login-item hosts must share one preference")
    }

    func testNoViewBuildsASecondControllerOrASecondObserver() throws {
        for (name, text) in try macSources() where name != "RelayiumApp.swift" {
            XCTAssertFalse(text.contains("InboxSessionBridge("),
                           "\(name) starts a second session observer")
            XCTAssertFalse(text.contains("AppEnvironment.makeInboxController("),
                           "\(name) builds a second receiver")
            // The send half is app-scoped for the same reasons and gets the same
            // rule: a second sender would be a second durable-plan owner over one
            // staging root, and a second session observation would leave one of
            // them describing an account that has left.
            XCTAssertFalse(text.contains("AppEnvironment.makeInboxSendModel("),
                           "\(name) builds a second Device Inbox sender")
        }
    }

    /// **The Device Inbox sends as well as receives, and the sender is the same
    /// one iOS drives.**
    ///
    /// macOS shipped this capability with only its receiving half. Every gate was
    /// green about a feature that was, in practice, one-directional: nothing in
    /// the macOS product could START a device delivery, so a Mac could receive
    /// from a browser and could not send to another Mac at all. These assertions
    /// are what stop that asymmetry returning by omission — a receiver with no
    /// sender looks complete from every angle except the user's.
    func testTheDeviceInboxCanSendFromThisMacAndNotOnlyReceiveIntoIt() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("AppEnvironment.makeInboxSendModel("),
                      "macOS composes no Device Inbox sender, so it can only receive")
        // App-scoped and observing the session before any view exists: a
        // delivery outlives the screen that started it, and an account leaving
        // has to cancel work no view is watching.
        XCTAssertTrue(app.contains("@StateObject private var inboxSend: InboxSendModel"),
                      "the sender is view-scoped, so a delivery dies with its screen")
        XCTAssertTrue(app.contains("delivering.observe(account.$state)"),
                      "a sign-out cannot cancel an account-owned delivery")
        // **No draft store.** That store is the authority to delete another
        // process's only copy of a file, and a macOS device send is chosen with
        // this app's own picker — so no delivery here can have come from one.
        XCTAssertTrue(app.contains("drafts: nil, root: UITestMode.pendingUploadRoot()"),
                      "the macOS sender can retire a shared draft it never received")
        XCTAssertFalse(try macSource("DeviceInbox/DeviceSendDetail.swift")
            .contains("sourceDraftId: selection"),
                       "a macOS device send claims a draft it did not come from")
        XCTAssertTrue(try macSource("DeviceInbox/DeviceSendDetail.swift")
            .contains("sourceDraftId: nil"),
                      "a macOS device send must report the draft it came from: none")
        // Rendered by the Device Inbox surface, in the one branch where the
        // account is usable — `.statusOnly` exists because the identifier was
        // refused, and staging a plan under it would fail.
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertEqual(occurrences(of: "DeviceSendSection(", in: surface), 1,
                       "the device list is rendered zero or twice")
        XCTAssertEqual(occurrences(of: "DeviceSendDetail(", in: surface), 1,
                       "the device's own send screen is rendered zero or twice")
        let surfaceBranch = try XCTUnwrap(
            surface.components(separatedBy: "case .surface:").dropFirst().first)
        let branch = try XCTUnwrap(surfaceBranch.components(separatedBy: "case .statusOnly:").first)
        XCTAssertTrue(branch.contains("DeviceSendSection("),
                      "the send half is rendered outside the usable-account branch")
        XCTAssertTrue(branch.contains("DeviceSendDetail("),
                      "the composer is rendered outside the usable-account branch")
        // Every decision belongs to the model, so `swift test` can drive it.
        // A view that re-derived any of these is a view no test reaches.
        let list = try macSource("DeviceInbox/DeviceSendSection.swift")
        let detail = try macSource("DeviceInbox/DeviceSendDetail.swift")
        let action = try macSource("DeviceInbox/DeliveryActionButton.swift")
        for owned in ["deliveries.candidates", "deliveries.selectTarget(",
                      "deliveries.refreshTargets(", "InboxSendActions.offered(for: item)"] {
            XCTAssertTrue(list.contains(owned),
                          "the device list re-derives what InboxSendModel owns: \(owned)")
        }
        for owned in ["deliveries.send(", "deliveries.sendText(",
                      "InboxSendComposer.order(", "InboxSendActions.cancel(for: item)",
                      "InboxSendActions.offered(for: item)",
                      "InboxSendActions.current(in: deliveries.items,"] {
            XCTAssertTrue(detail.contains(owned),
                          "the send screen re-derives what InboxSendModel owns: \(owned)")
        }
        for owned in ["deliveries.act(", "InboxSendActions.warnsDeliveryMayStillArrive("] {
            XCTAssertTrue(action.contains(owned),
                          "the delivery control re-derives what InboxSendModel owns: \(owned)")
        }
        // The credential is read at the moment of use and stored nowhere. One
        // read per function that spends it, and no send surface holds one.
        XCTAssertEqual(occurrences(of: "session.bearerToken", in: list), 1,
                       "the device list names the credential outside its one refresh site")
        XCTAssertEqual(occurrences(of: "session.bearerToken", in: detail), 2,
                       "the send screen names the credential outside its refresh and "
                       + "its one spend site")
        XCTAssertEqual(occurrences(of: "session.bearerToken", in: action), 1,
                       "the delivery control names the credential outside its one spend site")
        for source in [list, detail, action] {
            XCTAssertFalse(source.contains("@State private var token"),
                           "a Device Inbox send surface stores a credential")
            // And they obey the receive surface's own bans: no received
            // identity, no launching, no unpacking.
            for banned in ["receipt.urls", "url.path", "lastPathComponent", "receipt.taskID",
                           "NSWorkspace.shared.open(", "Process(",
                           "activateFileViewerSelecting"] {
                XCTAssertFalse(source.contains(banned),
                               "a Device Inbox send surface can reach \(banned)")
            }
        }
    }

    // MARK: - one device at a time

    /// **The content controls belong to one device's screen, and the landing
    /// page has none of them.**
    ///
    /// The owner's report was that the send controls were dumped into the main
    /// page, and they were: a file picker, a device list and a Send button
    /// rendered as siblings of the folder grant and the receive policy, so the
    /// screen offered *Choose Files or Folders…* a short scroll above *Choose
    /// Folder* with nothing saying that the first was about sending and the
    /// second about receiving. A user could stage files with no device chosen
    /// and no statement anywhere that one was required.
    ///
    /// These assertions are the shape of the repair, and each is an ABSENCE that
    /// no runtime observes: a picker back on the landing page, a composer that
    /// reads a device id it kept for itself, or a send screen that cannot be
    /// left would all look correct in a screenshot.
    func testEverySendControlBelongsToTheChosenDevicesOwnScreen() throws {
        let list = try macSource("DeviceInbox/DeviceSendSection.swift")
        let detail = try macSource("DeviceInbox/DeviceSendDetail.swift")

        // Nothing that composes a delivery is on the page that lists devices.
        for control in ["TextEditor(", "chooseFilesOrFolders(", "chooseFolders(",
                        "SelectionStore()", "deliveries.send(", "deliveries.sendText(",
                        "\"inbox-send-start\"", "\"inbox-send-message\""] {
            XCTAssertFalse(list.contains(control),
                           "the device list renders \(control), which belongs to one device")
        }
        // A row opens a device rather than sending to it. The verb matters: a
        // row whose button said Send would promise that pressing it sends
        // something, and nothing has been chosen yet at that point.
        XCTAssertTrue(list.contains("L10n.t(.sendContentAction)"),
                      "the device row does not offer the Send Content action")
        XCTAssertTrue(list.contains("deliveries.selectTarget(candidate.id)"),
                      "the device row opens something other than the model's selection")

        // The three actions the owner asked for, each stating its own kind, and
        // no fourth path to a delivery. Both file pickers exist and they are
        // configured differently — a control offering both cannot mean *a
        // folder*, which is the whole reason there are two.
        for control in ["case .message: messageSection", "case .files:   filesSection",
                        "chooseFilesOrFolders(into: selection)", "chooseFolders(into: selection)",
                        "deliveries.sendText(draft, token: token)",
                        "\"inbox-send-choose-files\"", "\"inbox-send-choose-folder\"",
                        "\"inbox-send-message\"", "\"inbox-send-start\""] {
            XCTAssertTrue(detail.contains(control),
                          "the send screen is missing \(control)")
        }
        // **No mode picker anywhere in it.** `MacSurfaceGuardTests` bans the
        // segmented one app-wide; this says the same thing about this screen in
        // the terms of its own defect — a control whose only effect is to hide
        // the other half of what you came here to do.
        XCTAssertFalse(detail.contains("pickerStyle("),
                       "the send screen asks which kind before letting the user act")
        let folderPicker = try macSource("FileDropZone.swift")
        XCTAssertTrue(folderPicker.contains("panel.canChooseFiles = false"),
                      "the folder picker would accept a file and call it a folder")
        XCTAssertTrue(folderPicker.contains("func chooseFolders(into store: SelectionStore)"),
                      "there is no folder-only picker for the send screen to call")
        // The message is sent EXACTLY as typed. A trim, a normalization or a
        // re-encode here would send bytes the user did not write and a length
        // the counter beside the field did not report.
        for mangling in ["draft.trimmingCharacters", "draft.replacingOccurrences",
                         "draft.precomposedString"] {
            XCTAssertFalse(detail.contains(mangling),
                           "the composer alters the message before sending it")
        }
        // Bounded in BYTES, through the shared type, so one emoji cannot pass a
        // check the seal then refuses.
        XCTAssertTrue(detail.contains("InboxTextDraft(draft)"),
                      "the composer measures the message some other way than the protocol does")
        XCTAssertFalse(detail.contains("draft.count"),
                       "the composer bounds the message in characters rather than bytes")
        // Text is gated on the capability and NOTHING else. The receive folder
        // in particular: a message is never written there.
        XCTAssertTrue(detail.contains("!draftSize.isSendable || !target.canReceiveText"),
                      "the message button is enabled or disabled on some other condition")
        XCTAssertTrue(detail.contains("InboxSendPresentation.textRefusal(for: target)"),
                      "a device that cannot present text is refused without saying why")
        for folderState in ["inbox.folder", "folderMissing", "receiveDirReady"] {
            XCTAssertFalse(detail.contains(folderState),
                           "the send screen consults the RECEIVE folder (\(folderState))")
        }
        // File and folder sending stay available on a device with no text
        // capability. The file Send is gated on the ONE thing that could make it
        // meaningless — an empty batch — and never on the message's capability,
        // its bounds or the receiver's folder.
        XCTAssertTrue(detail.contains(".disabled(selection.files.isEmpty)"),
                      "the file Send is gated on something other than having files")

        // The way out exists, it is the model's own selection, and there is no
        // second copy of "which device am I on" anywhere in this app.
        XCTAssertTrue(detail.contains("deliveries.selectTarget(nil)"),
                      "the send screen cannot be left")
        XCTAssertTrue(detail.contains("\"inbox-send-back\""),
                      "the way back carries no accessibility identifier")
        for state in try macSources() {
            XCTAssertFalse(state.text.contains("@State private var selectedDevice"),
                           "\(state.name) keeps its own copy of the chosen device")
            XCTAssertFalse(state.text.contains("@State private var openDevice"),
                           "\(state.name) keeps its own copy of the chosen device")
        }
        // A cancel is offered while a send is running, it is the model's answer
        // to which one, and it is drawn as the screen's primary control.
        XCTAssertTrue(detail.contains("isProminent: true"),
                      "the cancel on a running send is one bordered button among four")
        XCTAssertTrue(detail.contains(".filter { $0 != cancel }"),
                      "the cancel is offered twice on the same send")
    }

    // MARK: - one surface, two entries

    /// **One host renders the shared surface, and it is the destination.**
    ///
    /// The Device Inbox was, for a whole delivery, reachable only through ⌘, —
    /// every gate green about a capability that was in practice absent, because
    /// nothing in the main window named it. The repair was a first-class
    /// destination beside the settings tab, with `DeviceInboxSurface` shared so
    /// the two could not drift.
    ///
    /// The settings tab has now gone, and the drift risk goes with it: one
    /// capability with two complete screens reached by two different verbs is
    /// what the owner asked to be rid of. What must NOT change is the surface —
    /// the destination stays thin, deciding only where its account actions go,
    /// and every consequential control stays in the one file it renders.
    func testTheDeviceInboxDestinationIsTheOneHostOfTheSharedSurface() throws {
        let host = "Destinations/DeviceInboxDestination.swift"
        let source = try macSource(host)
        XCTAssertTrue(source.contains("DeviceInboxSurface"),
                      "\(host) does not render the shared Device Inbox surface")
        // Every consequential control, by name. A host that grew one of these is
        // a host that has started reimplementing the surface.
        for control in ["NSOpenPanel", "inbox.setPolicy", "inbox.chooseFolder",
                        "inbox.removeFolder", "inbox.reveal", "inbox.pause",
                        "inbox.respond", "InboxStatusPresentation",
                        "inbox.openNotificationSettings"] {
            XCTAssertFalse(source.contains(control),
                           "\(host) renders \(control) itself instead of sharing it")
        }
        // And exactly one host. A second would be a second place to keep in step
        // — which is how this capability ended up with a settings screen nobody
        // could find and a destination nobody had built.
        let hosts = try macSources().filter { $0.text.contains("DeviceInboxSurface {") }
            .map(\.name).sorted()
        XCTAssertEqual(hosts, ["Destinations/DeviceInboxDestination.swift"],
                       "the shared Device Inbox surface has grown another host")
    }

    /// Signed out, the surface offers ACTIONS rather than two sentences.
    ///
    /// The requirement it enforces is the one the row's visibility exists for: a
    /// destination that is listed before you have an account has to be able to
    /// get you one, in the app. The reuse of `CapabilityGateView` is the load-
    /// bearing half — it answers all five reasons an account is unavailable with
    /// the one action that resolves each, where a hand-rolled pair of buttons
    /// would tell a user whose address is merely unverified to sign in again.
    func testTheSignedOutSurfaceCarriesExecutableAccountActions() throws {
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(surface.contains("CapabilityGateView(gate: gate,"),
                      "the signed-out Device Inbox states a problem and offers no way out")
        XCTAssertTrue(surface.contains("onAccount: onAccount"),
                      "the gate's actions are not wired to the host's account route")
        XCTAssertTrue(surface.contains("let onAccount: (AuthMode) -> Void"),
                      "the surface decides where the account actions go, so the two hosts "
                      + "cannot answer that differently for the same button")
        XCTAssertFalse(surface.contains("NSWorkspace"),
                       "the signed-out Device Inbox opens a website for account work")
        // The host routes to the native form, on the half the button promised.
        // A `select(.account)` alone lands "Create an account" on a sign-in form.
        //
        // It needs no `openWindow`: this host only exists inside the main
        // window, so the Account destination it selects is one row away. The
        // settings tab that DID need to open a window is gone.
        let destination = try macSource("Destinations/DeviceInboxDestination.swift")
        XCTAssertTrue(destination.contains("navigation.selectAccount(intent: intent)"),
                      "the destination's account actions do not carry the requested half")
        XCTAssertFalse(destination.contains("openWindow(id: \"main\")"),
                       "a destination inside the main window asks for it to be opened")
    }

    /// **A dead control is not offered.**
    ///
    /// `retryNow`, `resume` and `pause` all return immediately when the
    /// controller holds no generation, which is a state a `ready` session can
    /// genuinely be in — an account id this build refuses fails closed with the
    /// session beside it perfectly healthy. This app has already shipped one
    /// recovery button whose action was a `break`; the answer is to render it
    /// only where it can work.
    func testTheStatusOnlyBranchOffersNoControlTheControllerWouldRefuse() throws {
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(surface.contains("private func statusSection(offersControls: Bool)"),
                      "the status section can no longer withhold its controls")
        XCTAssertTrue(surface.contains("statusSection(offersControls: false)"),
                      "the branch with no generation renders the full control set")
        for guarded in ["if offersControls,\n               let recovery",
                        "if offersControls, canPause"] {
            XCTAssertTrue(surface.contains(guarded),
                          "a control that needs a generation is rendered unguarded")
        }
        XCTAssertTrue(surface.contains(".accessibilityIdentifier(\"inbox-open-account\")"),
                      "an account the receiver refused is a dead end with no route out")
    }

    // MARK: - the two consents stay separate

    /// Choosing a folder must not enable receiving, and the policy control must
    /// go through the setter that refuses a non-`off` answer without a folder.
    func testTheFolderAndThePolicyAreTwoControlsThroughTwoSetters() throws {
        let pane = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(pane.contains("inbox.chooseFolder(url)"))
        XCTAssertTrue(pane.contains("set: { inbox.setPolicy($0) }"),
                      "the picker bypasses the setter that refuses a policy without a folder")
        XCTAssertFalse(pane.contains("setAutomaticReceive"),
                       "the pane writes the receive consent behind the controller's back")
        XCTAssertFalse(pane.contains("setReceivePolicy"),
                       "the pane writes the policy straight to the store")
        // Choosing a folder in the same action as enabling would be the single
        // control PRD §8 forbids.
        guard let choose = pane.range(of: "private func chooseFolder() {") else {
            return XCTFail("the pane no longer owns one folder-picking action")
        }
        let action = pane[choose.upperBound...].components(separatedBy: "\n    }").first ?? ""
        XCTAssertFalse(action.contains("setPolicy"),
                       "picking a folder also turns receiving on")
    }

    // MARK: - nothing falls through to ready

    /// Every renderer of the state switches over the closed enum with no
    /// `default:`. A `default:` here would render some future state as whatever
    /// arm it landed in — and the arm that matters is `ready`.
    func testNoStateRendererCanFallThrough() throws {
        for name in ["DeviceInbox/DeviceInboxSurface.swift", "MenuBarView.swift"] {
            let source = try macSource(name)
            for marker in ["switch inbox.state {"] where source.contains(marker) {
                let switches = source.components(separatedBy: marker).dropFirst()
                for block in switches {
                    let body = String(block.prefix(1_200))
                    XCTAssertFalse(body.contains("default:"),
                                   "\(name) renders the inbox state with a fall-through")
                }
            }
        }
        let copy = try packageSource("Localization/InboxCopy.swift")
        XCTAssertTrue(copy.contains("switch state {"))
        guard let statusSwitch = copy.range(of: "switch state {") else {
            return XCTFail("the status presentation no longer switches over the state")
        }
        let body = String(copy[statusSwitch.lowerBound...].prefix(2_000))
        XCTAssertFalse(body.contains("default:"),
                       "the shared status copy has a fall-through arm")
    }

    /// Both surfaces render the SAME presentation. Two switch statements over one
    /// state enum is two places for a case to go missing, and the menu bar is the
    /// one that is visible when nothing else is.
    func testTheMenuBarAndSettingsRenderOneSharedPresentation() throws {
        for name in ["DeviceInbox/DeviceInboxSurface.swift", "MenuBarView.swift"] {
            XCTAssertTrue(try macSource(name).contains("InboxStatusPresentation.text(for: inbox.state)"),
                          "\(name) writes its own status copy")
        }
    }

    // MARK: - the menu bar's route into the product

    /// **The menu-bar item opens the Device Inbox, not the settings window.**
    ///
    /// Two defects retired at once, and the second is why this is a guard rather
    /// than a preference. The item used to promise Settings because Settings was
    /// the only full surface the feature had; and the way it got there was an
    /// undocumented selector dispatched through the responder chain, which on
    /// macOS 26.6 nothing in this app answers — with every window closed it
    /// produced no window at all while the menu closed looking like it had acted.
    ///
    /// `openWindow(id:)` addresses the unique `Window` scene directly, needs no
    /// responder chain and is available on the 13.0 deployment target, so the
    /// availability split and the private selector are both gone. The selection
    /// must be written BEFORE the window is asked for, or the window renders
    /// wherever the user last was and then moves under them.
    func testTheMenuBarOpensTheDeviceInboxDestinationRatherThanSettings() throws {
        let menu = try macSource("MenuBarView.swift")
        XCTAssertTrue(menu.contains("Button(L10n.t(.inboxOpenDeviceInbox))"),
                      "the menu bar's Device Inbox item is gone or renamed")
        XCTAssertTrue(menu.contains("navigation.select(.deviceInbox)"),
                      "the menu-bar item opens a window without choosing the destination")
        guard let select = menu.range(of: "navigation.select(.deviceInbox)"),
              let open = menu.range(of: "openWindow(id: \"main\")") else {
            return XCTFail("the menu bar no longer has the shape this checks")
        }
        XCTAssertTrue(select.upperBound < open.lowerBound,
                      "the window is opened before the destination is selected")
        // The two ways this used to reach ⌘,. Both are now dead ends for this
        // item — the private one never worked on a current macOS, and the
        // supported one raised the deployment floor for no product gain.
        for retired in ["showPreferencesWindow", "showSettingsWindow",
                        "openSettings", "OpenInboxSettingsButton"] {
            XCTAssertFalse(menu.contains(retired),
                           "the menu bar still routes the Device Inbox through \(retired)")
        }
        // Nothing anywhere reaches for the private selector again.
        for (name, text) in try macSources() {
            XCTAssertFalse(text.contains("showPreferencesWindow")
                           || text.contains("showSettingsWindow"),
                           "\(name) dispatches an undocumented settings selector")
        }
        // And ⌘, no longer carries the surface at all. The destination replaced
        // it rather than joining it: two complete screens for one capability,
        // reached by two different verbs, is what the owner asked to be rid of.
        // What the menu bar still owes is the route INTO the destination, which
        // is asserted above.
        XCTAssertFalse(try macSource("Settings/SettingsView.swift")
            .contains("DeviceInboxSettingsView()"),
                      "the settings tab is back beside the destination")
    }

    // MARK: - what is never rendered

    /// No Device Inbox surface may render a received file name, a destination
    /// path, or an identifier. `InboxReceipt` carries the URLs because Reveal
    /// cannot work without them; nothing may draw them.
    func testNoInboxSurfaceRendersANameAPathOrAnIdentifier() throws {
        let surfaces = ["DeviceInbox/DeviceInboxSurface.swift", "MenuBarView.swift",
                        "InboxNotifier.swift",
                        // The host too. It is thin today, and this is the ban a
                        // host would be most tempted to break first — a "you
                        // received X" heading above the shared form.
                        "Destinations/DeviceInboxDestination.swift"]
        for name in surfaces {
            let source = try macSource(name)
            var banned = ["receipt.urls", "url.path", "lastPathComponent", "receipt.taskID",
                          "asking.first", "bearerToken"]
            // The shared surface is the one file that may NAME the credential,
            // and only in the one expression every account-backed surface in this
            // app uses to ask "may this run" — `AccountGate.from` takes the token
            // because "ready with no bearer" is a real state it has to tell apart.
            // It is not stored, not published and not rendered, and the exemption
            // is bounded to a single occurrence below so a second mention of it in
            // this file fails here.
            if name == "DeviceInbox/DeviceInboxSurface.swift" {
                banned.removeAll { $0 == "bearerToken" }
                XCTAssertEqual(occurrences(of: "bearerToken", in: source), 1,
                               "the shared Device Inbox surface names the credential more "
                               + "than once; the exemption covers the gate expression only")
                XCTAssertTrue(source.contains(
                    "AccountGate.from(session.state, bearer: session.bearerToken)"),
                              "the credential is named outside the gate expression")
                XCTAssertFalse(source.contains("Text(session"),
                               "the surface renders a value straight off the session")
            }
            for banned in banned {
                XCTAssertFalse(source.contains(banned), "\(name) can render \(banned)")
            }
        }
    }

    /// Reveal is one call site, it is fed by the controller, and the controller
    /// is what refuses anything that is not a known completed receipt.
    func testFinderRevealHasExactlyOneCallSiteAndItGoesThroughTheController() throws {
        let all = try macSources()
        // Two, and each is the ONE site for its own capability:
        // `ReceivedResultView` reveals a stored-link download the user opened
        // themselves, and `RelayiumApp` holds the Device Inbox seam. A third
        // would be a path reaching the Finder from a surface that never checked
        // where it came from.
        let sites = all.filter { $0.text.contains("activateFileViewerSelecting") }.map(\.name)
        XCTAssertEqual(sites, ["ReceivedResultView.swift", "RelayiumApp.swift"],
                       "a received path reaches the Finder from somewhere other than the two seams")
        XCTAssertTrue(try macSource("MenuBarView.swift").contains("inbox.reveal(latest)"))
        let controller = try packageSource("DeviceInbox/InboxController.swift")
        XCTAssertTrue(controller.contains("guard let known = results.first(where:"),
                      "Reveal no longer checks the path against this generation's own results")

        // **The Recently received list has ONE Finder action and it is the
        // section's, not a row's.**
        //
        // Every row used to carry an identical *Show in Finder* that opened the
        // same folder, beside rows that named nothing — a column of identical
        // controls answering a question the rows should have answered
        // themselves. The rows name their files now and hold no control at all.
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertFalse(surface.contains("inbox.reveal(receipt)"),
                       "the results list grew a per-row Finder button again")
        XCTAssertFalse(surface.contains("\"inbox-reveal\""),
                       "a per-row Finder control is back in the results list")
        XCTAssertEqual(occurrences(of: "inbox.revealReceiveFolder()", in: surface), 1,
                       "the Recently received section has zero or several Finder actions")
        XCTAssertEqual(occurrences(of: "\"inbox-reveal-folder\"", in: surface), 1,
                       "the section-level Finder action is unnamed or named twice")
        // It reveals the FOLDER, through the same audited seam, and the folder
        // is the user's own grant rather than anything derived from a delivery —
        // which is why it needs no results-list membership check and must not
        // grow one that would reach a received path.
        XCTAssertTrue(controller.contains("public func revealReceiveFolder()")
                      && controller.contains("guard let url = folder.url else { return }")
                      && controller.contains("runtime.reveal([url])"),
                      "the section Finder action does not go through the controller's seam")
    }

    /// **A receipt row names what actually arrived.**
    ///
    /// It rendered a count — three deliveries produced three rows reading
    /// "1 file saved", which is a list carrying no information about itself and
    /// left Finder as the only way to learn what had been received. The count
    /// rule is the NOTIFICATION's, where macOS draws the text on a locked screen
    /// unasked, and that one is unchanged and separately asserted below.
    func testAReceiptRowNamesItsFilesAndTheNotificationStillDoesNot() throws {
        let copy = try packageSource("Localization/InboxCopy.swift")
        XCTAssertTrue(copy.contains("let all = receipt.urls.map(\\.lastPathComponent)"),
                      "the receipt summary stopped naming the files that arrived")
        // The overflow is COUNTED rather than dropped: a row that silently
        // truncated would under-report what landed on the disk.
        XCTAssertTrue(copy.contains("L10n.t(.inboxMoreFiles,"),
                      "a long delivery's unnamed files are dropped rather than counted")
        // And the banner is still a count with no name anywhere near it. This is
        // the assertion that stops the two drifting into one another.
        let notifier = try macSource("InboxNotifier.swift")
        for banned in ["lastPathComponent", "receipt.urls", "InboxReceiptPresentation.summary"] {
            XCTAssertFalse(notifier.contains(banned),
                           "the Device Inbox notification can name a received file via \(banned)")
        }
    }

    /// **The message banner is a kind, never a message.**
    ///
    /// `savedMessage` reached the notifier with no payload to render, which is
    /// the property that makes this safe — but "no payload" only holds while the
    /// notifier stays unable to fetch one. It has the receipt's own vocabulary
    /// banned above; a message is held somewhere else entirely, in
    /// `InboxMessageStore`, and reaching it would take nothing more than an
    /// `@EnvironmentObject` and one property access.
    ///
    /// So: the case is named explicitly, the switch cannot fall through into it,
    /// and the file names no route to the store at all. All three are ABSENCES
    /// with no runtime to observe — a banner that had grown a preview would look
    /// entirely correct in every screenshot except a locked one.
    func testTheMessageBannerNamesItsCaseAndCanReachNoMessageText() throws {
        let notifier = try macSource("InboxNotifier.swift")
        XCTAssertTrue(notifier.contains("case .savedMessage:"),
                      "the notifier folds a message into another case's arm, so the two "
                      + "cannot be told apart or given separate notification identities")
        // A `default:` would silently absorb whatever case is added next — and
        // the case most likely to be added next is one that carries content.
        guard let start = notifier.range(of: "switch notification {") else {
            return XCTFail("the notifier no longer switches over the notification")
        }
        let block = String(notifier[start.lowerBound...].prefix(1_200))
        XCTAssertFalse(block.contains("default:"),
                       "the notifier switches over the notification with a fall-through")
        // Every name that leads to a stored message, the store that holds them,
        // and the presentation layer that renders one. None of them belongs in a
        // file whose output macOS draws on a locked screen.
        for banned in ["InboxMessageStore", "InboxMessage", "InboxMessagePresentation",
                       "message.text", "inbox.messages", ".messages"] {
            XCTAssertFalse(notifier.contains(banned),
                           "the Device Inbox notification can reach a received message "
                           + "via \(banned)")
        }
    }

    /// **The banner copy has no substitution site, so there is nothing to fill.**
    ///
    /// The runtime half is in `InboxNotificationTests`, which checks the shipped
    /// catalog entries for a `%@`. This is the other side of the same claim and
    /// the one a catalog check cannot make: even with a template that has no
    /// slot, `"\(something)"` in a renderer would put a value on the banner
    /// without any catalog changing. `InboxNotificationPresentation` returns
    /// lookups and delegations only, and this is what keeps it that way.
    func testTheNotificationCopyInterpolatesNothingIntoABanner() throws {
        let copy = try packageSource("Localization/InboxCopy.swift")
        guard let start = copy.range(of: "public enum InboxNotificationPresentation {") else {
            return XCTFail("the notification presentation is gone or renamed")
        }
        let presentation = String(copy[start.upperBound...])
        // Both halves handle the message, by name, in a closed switch.
        XCTAssertEqual(occurrences(of: "case .savedMessage:", in: presentation), 2,
                       "the title and the body do not each name the message case")
        XCTAssertFalse(presentation.contains("default:"),
                       "the banner copy has a fall-through arm")
        // The one construct through which a runtime value could reach a returned
        // string. Its absence is the whole assertion.
        XCTAssertFalse(presentation.contains("\\("),
                       "the banner copy interpolates a value into a notification string")
        // And it reaches for no message and builds no summary of one.
        // `InboxMessagePresentation` is the renderer for the pane somebody opened
        // their own Mac to read; `prefix`/`truncat` are how a preview gets built
        // out of a body that a future refactor handed in. The file's plural
        // renderer is deliberately NOT banned here — the `saved` arm's file count
        // is the one number this type may say.
        for banned in ["InboxMessagePresentation", "InboxMessage", "prefix(", "truncat"] {
            XCTAssertFalse(presentation.contains(banned),
                           "the banner copy can build a message preview via \(banned)")
        }
        // The message body is its OWN string rather than the title reused, and it
        // is the argument-free key. A body that fell back to `inboxSavedMessage`
        // would restore the sentence-twice banner this replaced.
        XCTAssertTrue(presentation.contains("L10n.t(.inboxNotifyBodyMessage, language: language)"),
                      "the message banner's body is not the dedicated route sentence")
    }

    // MARK: - the message surface, and the claim that rests on it

    /// **A received message is rendered as a message, with an action that puts
    /// exactly it on the clipboard.**
    ///
    /// This is the surface `inbox.text.v1` is a claim about, and the reason it
    /// is a guard rather than a preference is what the pane looked like without
    /// it. A message was decoded, committed whole to a protected store and
    /// deliberately kept out of the receive folder — every model-layer test
    /// green — and the user had no way to read one. The status line said
    /// *Message received*, the Recently received row said *Message received*,
    /// the banner said *Message received*, and the message sat on the disk with
    /// nothing in the product that would open it.
    ///
    /// So the assertions are about the three things a reader needs and a
    /// refactor could quietly drop: the body is rendered, the time is rendered,
    /// and Copy writes the body itself rather than a summary of it.
    func testTheDeviceInboxRendersReceivedMessagesWithAWorkingCopyAction() throws {
        let surface = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(surface.contains("private var messagesSection: some View"),
                      "the Device Inbox has no received-messages section")
        // In the usable-account branch, beside the file receipts. Outside it,
        // this section would render for an account the receiver refused — one
        // that cannot have received anything.
        let afterSurface = try XCTUnwrap(
            surface.components(separatedBy: "case .surface:").dropFirst().first)
        let branch = try XCTUnwrap(afterSurface.components(separatedBy: "case .statusOnly:").first)
        XCTAssertTrue(branch.contains("messagesSection"),
                      "the messages section is rendered outside the usable-account branch")

        // The body, whole and unformatted. `Text(message.text)` and not a
        // presentation helper: a helper is where a preview or a truncation would
        // be added, and this row is the one place the message may appear.
        XCTAssertTrue(surface.contains("Text(message.text)"),
                      "the message rows no longer render the message")
        XCTAssertTrue(surface.contains("InboxMessagePresentation.receivedAt(message)"),
                      "a message row no longer says when it arrived")
        XCTAssertTrue(surface.contains("InboxMessagePresentation.shown(inbox.messages)"),
                      "the section no longer draws the controller's message list")

        // Copy: an explicit control, named for assistive technology, writing the
        // EXACT characters that were received.
        XCTAssertTrue(surface.contains("copyReceivedMessage(message.text)"),
                      "the Copy action does not copy the message itself")
        XCTAssertTrue(surface.contains("NSPasteboard.general.clearContents()")
                      && surface.contains("NSPasteboard.general.setString(text, forType: .string)"),
                      "the Copy action does not reach the pasteboard")
        XCTAssertTrue(surface.contains(
            ".accessibilityLabel(InboxMessagePresentation.copyActionLabel("),
                      "a column of identical Copy buttons with no accessible names")
        XCTAssertTrue(surface.contains("\"inbox-message-copy-\\(index)\""),
                      "the per-row Copy control is unnamed")
        XCTAssertTrue(surface.contains("\"inbox-message-\\(index)\""),
                      "the message row itself is unnamed")

        // Nothing is silently withheld. The section draws a bounded number of
        // rows, and says how many more this Mac is holding — a bound that
        // stopped in silence would make a message look deleted, which is the
        // one impression this feature must never give.
        XCTAssertTrue(surface.contains("InboxMessagePresentation.more(inbox.messages)"),
                      "the display bound drops messages without counting them")

        // The delivery id is COMPARED, to keep the Copied confirmation on the
        // row it belongs to. It is never drawn — the surface-wide ban on
        // rendering an identifier holds here too.
        XCTAssertFalse(surface.contains("Text(message.id"),
                       "a message row renders the delivery identifier")
        XCTAssertFalse(surface.contains("Text(verbatim: message.id"),
                       "a message row renders the delivery identifier")
    }

    /// **`inbox.text.v1` is announced by the target that ships the screen, and
    /// by nothing else.**
    ///
    /// The token means "this receiver presents a text delivery AS text", which
    /// makes it a claim about a surface. It lived for one commit in
    /// `InboxProtocol.capabilities`, where every build that links the library
    /// inherited it: the iOS app, which has no Device Inbox message UI at all,
    /// and `AppInboxReceiverHost`, which is headless. Both were telling central
    /// they presented messages.
    ///
    /// So the announcement is an argument, passed at exactly one site, and this
    /// is what stops a second one appearing in a build with no such screen.
    func testOnlyTheBuildThatRendersMessagesAnnouncesTheTextCapability() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains(
            "capabilities: InboxProtocol.announcedCapabilities(presentingText: true)"),
                      "the macOS app renders a messages section and does not announce it")

        // One claimant in this target, and it is the app scene that composes the
        // receiver — not a view, not a fixture.
        let claimants = try macSources().filter { $0.text.contains("presentingText: true") }
            .map(\.name).sorted()
        XCTAssertEqual(claimants, ["RelayiumApp.swift"],
                       "a second macOS site announces a text surface")

        // The library announces nothing extra on anyone's behalf.
        for name in ["DeviceInbox/InboxController.swift", "DeviceInbox/InboxEnrolment.swift",
                     "DeviceInbox/InboxReceiveEngine.swift", "AppEnvironment.swift"] {
            XCTAssertFalse(try packageSource(name).contains("presentingText: true"),
                           "\(name) claims a text surface for every build that links it")
        }

        // The headless acceptance receiver runs the real controller against a
        // real server with no UI of any kind. It is the sharpest case for why a
        // platform test would be wrong here: it is macOS, and it presents
        // nothing.
        let hosts = try code(appsRoot.appendingPathComponent(
            "RelayiumKit/Sources/RelayiumPeerKit/AppInboxHosts.swift"))
        XCTAssertFalse(hosts.contains("presentingText: true"),
                       "the headless receiver host claims a message surface it does not have")

        // And iOS, which is the build the shared claim was actually false for.
        let iosRoot = appsRoot.appendingPathComponent("ios")
        let iosNames = try FileManager.default.subpathsOfDirectory(atPath: iosRoot.path)
            .filter { $0.hasSuffix(".swift") }
        XCTAssertGreaterThanOrEqual(iosNames.count, 10,
                                    "found \(iosNames.count) iOS sources at \(iosRoot.path)")
        for name in iosNames {
            let source = try code(iosRoot.appendingPathComponent(name))
            XCTAssertFalse(source.contains("presentingText: true"),
                           "iOS/\(name) announces a Device Inbox text surface it does not ship")
            // Naming the token at all needs a look. iOS ships no Device Inbox
            // message surface, so the only honest uses here would be a refusal
            // — and a refusal on this platform is currently expressed by simply
            // not announcing it.
            XCTAssertFalse(source.contains("InboxCapability.textV1"),
                           "iOS/\(name) names the text capability token; iOS has no "
                           + "Device Inbox message surface, so this needs review")
        }
    }

    /// Nothing in the Device Inbox deletes a received message on a schedule.
    ///
    /// The store had a one-year cutoff and a `prune(now:)` that the receive loop
    /// called on every idle pass. A journal entry may expire — it is bookkeeping
    /// about a delivery — but a message IS the delivery, held in no other copy
    /// on this Mac, and a timer nobody chose deleting it is data loss dressed as
    /// housekeeping. Both are gone; this is what stops one coming back as a
    /// convenience beside the journal's.
    ///
    /// The runtime half is `InboxReceiveEngineTests`, which drives the pass that
    /// used to prune and finds a ten-year-old message still there.
    func testNoReceivedMessageIsDeletedOnASchedule() throws {
        let store = try packageSource("DeviceInbox/InboxMessageStore.swift")
        XCTAssertFalse(store.contains("func prune("),
                       "the message store grew a time-based deletion again")
        XCTAssertFalse(store.contains("static let retention"),
                       "the message store grew a retention cutoff again")
        // The explicit, one-id deletion stays. It is the shape that cannot
        // become a policy: there is nothing to hand a cutoff or a predicate to.
        XCTAssertTrue(store.contains("public func remove(_ id: String) throws"),
                      "the only user-driven deletion is gone")

        let engine = try packageSource("DeviceInbox/InboxReceiveEngine.swift")
        XCTAssertFalse(engine.contains("messages.prune"),
                       "the receive loop prunes the user's messages again")
        // The journal's own pruning is unchanged, and its presence here is what
        // makes the absence above a decision rather than an oversight.
        XCTAssertTrue(engine.contains("journals.prune(now: now())"),
                      "the journal's pruning was removed with the message store's")
    }

    /// Every Device Inbox engine this target builds is given a message store.
    ///
    /// A missing `messages:` is a compile error, and this target's compiler is
    /// `xcodebuild` — which the package's own `swift test` never runs. That gap
    /// has already shipped one app target that could not build, so the argument
    /// is checked as text here, where the fast suite can see it.
    func testEveryMacEngineIsBuiltWithAMessageStore() throws {
        var built = 0
        for (name, text) in try macSources() {
            for construction in text.components(separatedBy: "InboxReceiveEngine(").dropFirst() {
                built += 1
                let arguments = String(construction.prefix(400))
                XCTAssertTrue(arguments.contains("messages:"),
                              "\(name) builds a receive engine with no message store, "
                              + "which does not compile")
            }
        }
        XCTAssertGreaterThan(built, 0, "no macOS source builds a receive engine any more")
    }

    /// PRD §9: receiving ends at a quarantined file on disk. It never hands that
    /// file to an application, a process launcher or an archive extractor.
    func testTheInboxNeverOpensExecutesOrExtractsReceivedContent() throws {
        let inboxRoot = packageRoot.appendingPathComponent("DeviceInbox")
        let names = try FileManager.default.subpathsOfDirectory(atPath: inboxRoot.path)
            .filter { $0.hasSuffix(".swift") }
        let sources = try names.map { try code(inboxRoot.appendingPathComponent($0)) }
            + [macSource("DeviceInbox/DeviceInboxSurface.swift"),
               macSource("InboxNotifier.swift")]
        for source in sources {
            for banned in ["NSWorkspace.shared.open(", "Process(", "/usr/bin/open",
                           "Archive(", "unzip", "extractItem("] {
                XCTAssertFalse(source.contains(banned),
                               "Device Inbox can launch or unpack received content via \(banned)")
            }
        }
    }

    // MARK: - the notification-settings route

    /// **The seam that opens System Settings can never be handed a path.**
    ///
    /// The ban above stops the Device Inbox surfaces from launching anything at
    /// all, and this is what keeps the one deliberate exception from becoming a
    /// hole in it. The seam is declared to take NO argument, so there is no
    /// parameter through which a received file name, a destination path or a task
    /// id could travel to `NSWorkspace` — the property holds by the type, not by
    /// the care of whoever writes the next call site.
    func testTheNotificationSettingsSeamTakesNothingAndOpensOnlyALiteral() throws {
        let controller = try packageSource("DeviceInbox/InboxController.swift")
        XCTAssertTrue(controller.contains("public var openNotificationSettings: @Sendable () -> Bool"),
                      "the System Settings seam no longer refuses to take an argument")

        // The one implementation, in the scene that already owns the other
        // platform seam. The URL is built in the same expression as the call,
        // from the route type and this bundle's own identifier — never from a
        // value that reached the scene from anywhere else.
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("InboxNotificationSettingsRoute"),
                      "the notification-settings route lost its deep link")
        XCTAssertTrue(app.contains(".url(forBundleIdentifier: Bundle.main.bundleIdentifier)"),
                      "the notification-settings route no longer names THIS app; a "
                        + "constant or a missing id opens whichever row System "
                        + "Settings was last left on")
        let openers = try macSources().filter {
            $0.text.contains("InboxNotificationSettingsRoute")
        }.map(\.name)
        XCTAssertEqual(openers, ["RelayiumApp.swift"],
                       "the notification settings pane is opened from more than one place")
        // And the URL itself exists in exactly one place, which is the place the
        // execution tests can drive. A second copy in the app would be a route
        // nothing proves selects an app row.
        for (name, text) in try macSources() {
            XCTAssertFalse(text.contains("Notifications-Settings.extension"),
                           "\(name) builds the notification settings URL a second time")
        }
    }

    /// **The pane identifier alone is not the route, and this is what would have
    /// caught the shipped defect.**
    ///
    /// The first version of this recovery opened
    /// `x-apple.systempreferences:com.apple.Notifications-Settings.extension`,
    /// and on macOS 26.6 that re-opened System Settings on whichever app row it
    /// was last left on — Google Chrome's, in the observed case — while the
    /// button claimed to have opened Relayium's. The guard then in place checked
    /// only that the pane identifier was present, so it passed the wrong target.
    ///
    /// The binding is checked end to end instead: the identifier this app is
    /// actually built with must produce a URL that selects that app's row. An
    /// identifier the route refuses — one carrying a character macOS allows in a
    /// product name but not in an identifier, say — would leave every denied Mac
    /// with a recovery that reports failure, and no unit test over a fixture id
    /// would notice.
    func testTheShippedBundleIdentifierProducesARowSelectingRoute() throws {
        let project = try String(
            contentsOf: appsRoot.appendingPathComponent("mac/Relayium.xcodeproj/project.pbxproj"),
            encoding: .utf8)
        let configured = Set(project.components(separatedBy: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("PRODUCT_BUNDLE_IDENTIFIER = ") else { return nil }
            // Xcode writes the value bare or quoted depending on its content;
            // both forms name the same identifier.
            return trimmed.dropFirst("PRODUCT_BUNDLE_IDENTIFIER = ".count)
                .trimmingCharacters(in: CharacterSet(charactersIn: ";\""))
        })
        XCTAssertFalse(configured.isEmpty, "no bundle identifier is configured at all")
        // Every target's identifier must be routable — the app is the one that
        // matters, and its extensions share its prefix, so a change that broke
        // the shape would break all of them together.
        for identifier in configured {
            guard let url = InboxNotificationSettingsRoute
                .url(forBundleIdentifier: identifier) else {
                return XCTFail("the shipped identifier \(identifier) cannot be routed")
            }
            XCTAssertTrue(url.absoluteString.hasSuffix("?id=\(identifier)"),
                          "the route for \(identifier) does not select its row")
        }
        // The app itself, named explicitly: the extensions extend it, and the
        // notification row this recovery opens is the app's.
        XCTAssertTrue(configured.contains("com.relayium.mac"),
                      "the macOS app's bundle identifier changed; the notification "
                        + "recovery's verified route must be re-verified against macOS")
    }

    /// A blocked banner is NOT an inbox runtime state.
    ///
    /// The tempting shortcut is to reuse `.attention`, and it would put "needs
    /// attention" on the status line of a Mac that is receiving, decrypting and
    /// committing perfectly — the mirror image of the `ready`-over-a-broken-grant
    /// untruth the closed state enum exists to prevent. The two axes stay apart,
    /// and the state enum stays free of any notion of notifications.
    func testNotificationAuthorizationIsNotFoldedIntoTheRuntimeState() throws {
        let state = try packageSource("DeviceInbox/InboxRuntimeState.swift")
        for banned in ["notification", "Notification", "banner", "Banner"] {
            XCTAssertFalse(state.contains(banned),
                           "InboxRuntimeState learned about \(banned)")
        }
        // And the pane renders it from its own closed presentation rather than
        // from a second switch over the runtime state.
        let pane = try macSource("DeviceInbox/DeviceInboxSurface.swift")
        XCTAssertTrue(pane.contains("InboxNotificationPermissionPresentation"),
                      "the pane no longer renders the banner permission from the copy layer")
        XCTAssertTrue(pane.contains("inbox.refreshNotificationPermission()"),
                      "the pane never re-measures notification authorization")
        XCTAssertTrue(pane.contains("NSApplication.didBecomeActiveNotification"),
                      "the pane cannot notice authorization changed while it stayed open")
    }

    /// One mapping decides both what the pane says and whether a banner is
    /// posted, so the claim and the behaviour cannot drift apart.
    func testTheNotifierAndThePaneShareOneAuthorizationMapping() throws {
        let notifier = try macSource("InboxNotifier.swift")
        XCTAssertTrue(notifier.contains("InboxNotificationPermission("),
                      "the notifier interprets the platform status on its own again")
        XCTAssertFalse(notifier.contains("settings.authorizationStatus {"),
                       "the notifier switches over the raw status a second time")
        XCTAssertTrue(notifier.contains("onPermission"),
                      "the notifier measures authorization and tells nobody")
    }

    // MARK: - the credential

    /// Nothing in the Device Inbox package sources persists or publishes a
    /// bearer. The controller holds one privately for the life of a generation
    /// and drops it; nothing else may keep a copy.
    func testTheBearerIsNeverPublishedOrPersisted() throws {
        let names = try FileManager.default.subpathsOfDirectory(
            atPath: packageRoot.appendingPathComponent("DeviceInbox").path)
            .filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertGreaterThanOrEqual(names.count, 12,
                                    "found \(names.count) Device Inbox sources")
        for name in names {
            let source = try code(packageRoot.appendingPathComponent("DeviceInbox")
                .appendingPathComponent(name))
            XCTAssertFalse(source.contains("@Published public private(set) var identity"),
                           "\(name) publishes the credential")
            XCTAssertFalse(source.contains("UserDefaults") && source.contains("bearer"),
                           "\(name) writes a bearer to defaults")
        }
        let controller = try packageSource("DeviceInbox/InboxController.swift")
        XCTAssertTrue(controller.contains("private var identity: InboxAccountIdentity?"),
                      "the credential is no longer private to the controller")
        XCTAssertFalse(controller.contains("@Published public private(set) var identity"))
    }

    // MARK: - the acceptance suite

    /// The runtime suite exists and covers the five modes the acceptance contract
    /// names, plus the residency path. A UI suite that lost a mode is a mode with
    /// no runtime evidence at all.
    func testTheRuntimeSuiteCoversEveryRequiredMode() throws {
        let ui = try String(contentsOf: macRoot.deletingLastPathComponent()
            .appendingPathComponent("RelayiumUITests/DeviceInboxUITests.swift"), encoding: .utf8)
        for name in ["testSignedOutSetupExplainsWhatDeviceInboxNeeds",
                     "testAReadyAutomaticInboxNamesItsFolderAndItsPolicy",
                     "testAFolderAttentionStateAsksForTheFolderRatherThanARetry",
                     "testMultipleAskDeliveriesAreVisiblyDistinct",
                     "testAWorkingInboxSaysSoWithoutNamingTheDelivery",
                     // Renamed with the surface it drives: the rows name their
                     // files now and the Finder action belongs to the section.
                     "testACompletedDeliveryNamesItsFilesAndOffersOneFinderAction",
                     // The owner's report, as a runtime property: the complete
                     // Help section is readable with every section above it
                     // present, which is where the scaffold clipped it.
                     "testTheFullHelpSectionIsReadableUnderTheLongestContent",
                     "testClosingTheWindowLeavesTheInboxRunningAndReopeningMakesNoSecondWindow",
                     "testTheMenuBarOffersNoFolderGrantAndNoPolicyChange",
                     "testBlockedBannersSayReceivingStillWorksAndOfferSystemSettings",
                     "testTheSystemSettingsActionSaysSoWhenThePlatformRefusesIt",
                     "testAllowingNotificationsRemovesTheWarningWithoutARelaunch",
                     // The first-class entry, and the three things about it that
                     // only exist at runtime: the sidebar row opens the
                     // destination, the destination carries the WHOLE surface
                     // rather than a link to Settings, and the signed-out screen's
                     // two account actions actually go somewhere.
                     "testTheSidebarRowOpensTheDeviceInboxDestination",
                     "testTheDestinationCarriesTheCompleteSignedInSurface",
                     "testTheSignedOutDestinationExplainsItselfAndCanReachTheForm",
                     "testTheSignedOutDestinationCanReachTheCreateAccountForm",
                     "testTheMenuBarOpensTheDeviceInboxWithEveryWindowClosed",
                     // The third branch, driven rather than inferred from the two
                     // beside it. It is the one state where the session and the
                     // receiver disagree permanently, and both obvious renderings
                     // of it are defects.
                     "testAnAccountTheReceiverCannotUseSaysSoAndOffersARouteOut"] {
            XCTAssertTrue(ui.contains(name), "the runtime suite lost \(name)")
        }
        for argument in ["--relayium-ui-testing-inbox-ready",
                         "--relayium-ui-testing-inbox-attention",
                         "--relayium-ui-testing-inbox-ask",
                         "--relayium-ui-testing-inbox-working",
                         "--relayium-ui-testing-inbox-result",
                         "--relayium-ui-testing-inbox-notifications-denied",
                         "--relayium-ui-testing-inbox-notifications-recover",
                         "--relayium-ui-testing-unusable-account"] {
            XCTAssertTrue(ui.contains(argument), "no launch drives \(argument)")
        }
        // The fixture behind the last one substitutes the account id and nothing
        // else, so the identifier check it exercises is the product's own.
        let mode = try macSource("UITestMode.swift")
        XCTAssertTrue(mode.contains("hasUnusableAccount ? \"acct/uitest\" : \"acct_uitest\""),
                      "the refused-account fixture no longer supplies an id this build rejects")
    }

    /// The acceptance fixture exists only in DEBUG. What it substitutes is the
    /// thing that decides what gets written to a user's disk, so a shipped binary
    /// must not contain the flags at all.
    func testTheAcceptanceFixtureIsAbsentFromRelease() throws {
        let raw = try String(contentsOf: macRoot.appendingPathComponent("UITestInbox.swift"),
                             encoding: .utf8)
        XCTAssertTrue(raw.hasPrefix("#if DEBUG"),
                      "the inbox acceptance fixture is not compiled out of Release")
        XCTAssertTrue(raw.hasSuffix("#endif\n"))
        let mode = try macSource("UITestMode.swift")
        XCTAssertTrue(mode.contains("static func makeInboxController() -> InboxController? { nil }"),
                      "a Release launch can be pointed at a substituted receiver")
        // Every store the fixture touches is isolated: the keychain history, the
        // folder grant, the journal directory and the receive folder itself.
        // Isolating one store is not isolating the app.
        let fixture = try macSource("UITestInbox.swift")
        for isolated in ["InMemoryInboxFolderStore()", "InMemoryInboxDeviceKeyStore()",
                         "uitest-inbox-receive", "uitest-inbox-journal"] {
            XCTAssertTrue(fixture.contains(isolated),
                          "the acceptance fixture shares \(isolated) with the installed product")
        }
        XCTAssertTrue(fixture.contains("receiveCapability: InboxCapability.receiveV3"),
                      "the acceptance server no longer negotiates the required v2 receiver")
        XCTAssertTrue(fixture.contains("InboxManifest.files("))
        XCTAssertTrue(fixture.contains("InboxManifest.encode(manifest)"))
        XCTAssertTrue(fixture.contains("seal(key: contentKey, seq: 0"))
        XCTAssertFalse(fixture.contains("encryptManifest(key: contentKey"),
                       "the v2 fixture still seals a retired StoredManifest frame")
        XCTAssertFalse(fixture.contains("receiveCapability: InboxCapability.receiveV1"),
                       "the v2 acceptance client is being forced onto the retired v1 protocol")
        XCTAssertFalse(fixture.contains("temporaryDirectory"),
                       "a delivery or its journal may not land somewhere the system can purge")
        XCTAssertFalse(fixture.contains("cachesDirectory"))

        let pane = try macSource("Transfer/TransferSessionPane.swift")
        let body = try XCTUnwrap(pane.range(of: "sessionPeer"))
        let exit = try XCTUnwrap(pane.range(of: "            exit", range: body.upperBound..<pane.endIndex))
        let lane = try XCTUnwrap(pane.range(of: "            if waitingOnJoinedCode",
                                            range: body.upperBound..<pane.endIndex))
        XCTAssertLessThan(exit.lowerBound, lane.lowerBound,
                          "long terminal content hides the session owner's only exit")
    }
}
