import XCTest

/// Package tests cannot instantiate the macOS App. Guard its two production
/// side-effect seams alongside SharedDraftInboxTests' real no-store behavior.
final class MacUITestIsolationTests: XCTestCase {
    private func code(_ path: String) throws -> String {
        try RepoRoot.text(path).components(separatedBy: "\n")
            .map { String($0.components(separatedBy: "//")[0]) }
            .joined().filter { !$0.isWhitespace }
    }

    func testUITestLaunchDoesNotOpenTheProductionSharedDraftStore() throws {
        let app = try code("apps/mac/Relayium/RelayiumApp.swift")
        XCTAssertTrue(app.contains(
            "privateletsharedDrafts=SharedDraftInbox(store:UITestMode.isActive?nil:AppEnvironment.makeSharedDraftStore())"))
    }

    func testUITestLaunchDoesNotStartSparkleOrPersistItsConsent() throws {
        let distribution = try code("apps/mac/Relayium/Distribution/DirectDistribution.swift")
        XCTAssertTrue(distribution.contains(
            "startingUpdater:!AppEnvironment.isEngineeringCandidate&&!UITestMode.isActive,"))
    }

    func testReleaseNeverEntersTheUITestIsolationBranch() throws {
        let mode = try RepoRoot.text("apps/mac/Relayium/UITestMode.swift")
        let release = try XCTUnwrap(mode.components(separatedBy: "#else").last)
        let code = release.components(separatedBy: "\n")
            .map { String($0.components(separatedBy: "//")[0]) }
            .joined().filter { !$0.isWhitespace }
        XCTAssertTrue(code.contains("staticletisActive=false"))
    }

    // MARK: - why DeviceInboxUITests may decline Sparkle's consent without waiting

    /// `UITestMode` exists only in DEBUG, so the guard above holds only if the
    /// UI tests really run Debug: the shared scheme's TestAction, and a CI
    /// command that names no other configuration, plan or prebuilt run.
    func testTheMacUITestsRunTheDebugIsolationBuild() throws {
        let scheme = try RepoRoot.text("apps/mac/Relayium.xcodeproj/xcshareddata/xcschemes/Relayium.xcscheme")
        let parts = scheme.components(separatedBy: "<TestAction")
        XCTAssertEqual(parts.count, 2, "Relayium.xcscheme must declare exactly one TestAction")
        let header = try XCTUnwrap(parts.last?.components(separatedBy: ">").first)
        XCTAssertTrue(header.contains("buildConfiguration = \"Debug\""),
                      "the Relayium scheme's TestAction must build Debug")

        let workflow = try RepoRoot.text(".github/workflows/macos.yml")
        let steps = workflow.components(separatedBy: "\n      - name: Run macOS product-flow UI smoke (")
        XCTAssertEqual(steps.count, 2, "macos.yml must have exactly one macOS UI smoke step")
        // This step's own lines only: the next step, or a comment above it, ends it.
        let step = try XCTUnwrap(steps.last?.components(separatedBy: "\n      - ").first?
            .components(separatedBy: "\n      #").first)
        let command = step.components(separatedBy: "\\\n").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }.joined(separator: " ")
        XCTAssertEqual(step.components(separatedBy: "xcodebuild").count, 2,
                       "the UI smoke step must run exactly one xcodebuild")
        XCTAssertTrue(command.contains("xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium "),
                      "the UI smoke must test the shared Relayium scheme")
        XCTAssertTrue(command.hasSuffix("\"${only[@]}\" test"), "the UI smoke must end with `test`")
        for override in ["-configuration", "CONFIGURATION", "-testPlan", "-xctestrun",
                         "test-without-building", "Release"] {
            XCTAssertFalse(step.contains(override),
                           "the UI smoke step must not override the scheme with \(override)")
        }
        let job = try XCTUnwrap(workflow.components(separatedBy: "\n  ui-smoke:\n").last?
            .components(separatedBy: "\n      - name: Run macOS product-flow UI smoke (").first)
        XCTAssertTrue(job.contains("tests: RelayiumUITests/DeviceInboxUITests,"),
                      "the device-inbox shard must run DeviceInboxUITests through this command")
    }

    /// A Debug TestAction is only Debug-for-`UITestMode` if the scheme's app
    /// target's Debug configuration compiles with `DEBUG`: the Relayium target
    /// (A5) -> its list (A6) -> its Debug (A7), which inherits the project's
    /// Debug (A9 -> AA) where `DEBUG` is defined. Pinned on those objects only.
    func testTheTestedAppTargetsDebugConfigurationDefinesDEBUG() throws {
        let scheme = try RepoRoot.text("apps/mac/Relayium.xcodeproj/xcshareddata/xcschemes/Relayium.xcscheme")
        XCTAssertTrue(scheme.contains("BlueprintIdentifier = \"A100000000000000000000A5\"\n"
            + "               BuildableName = \"Relayium.app\"\n               BlueprintName = \"Relayium\""),
                      "the Relayium scheme must build the Relayium app target A5")
        let project = try RepoRoot.text("apps/mac/Relayium.xcodeproj/project.pbxproj")
        let target = try pbxObject("A100000000000000000000A5", in: project)
        XCTAssertTrue(target.contains("isa = PBXNativeTarget;"))
        XCTAssertTrue(target.contains("buildConfigurationList = A100000000000000000000A6 "))
        XCTAssertTrue(target.contains("name = Relayium;"))
        XCTAssertTrue(try pbxObject("A100000000000000000000A6", in: project).contains(
            "buildConfigurations = (\n\t\t\t\tA100000000000000000000A7 /* Debug */,\n"
            + "\t\t\t\tA100000000000000000000A8 /* Release */,\n\t\t\t);"))
        let root = try pbxObject("A100000000000000000000A1", in: project)
        XCTAssertTrue(root.contains("isa = PBXProject;"))
        XCTAssertTrue(root.contains("buildConfigurationList = A100000000000000000000A9 "))
        XCTAssertTrue(try pbxObject("A100000000000000000000A9", in: project).contains(
            "buildConfigurations = (\n\t\t\t\tA100000000000000000000AA /* Debug */,\n"
            + "\t\t\t\tA100000000000000000000AB /* Release */,\n\t\t\t);"))

        let projectDebug = try pbxObject("A100000000000000000000AA", in: project)
        XCTAssertTrue(projectDebug.contains("name = Debug;"))
        XCTAssertTrue(projectDebug.contains("\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;\n"),
                      "the project's Debug configuration must define DEBUG for Swift")
        let targetDebug = try pbxObject("A100000000000000000000A7", in: project)
        XCTAssertTrue(targetDebug.contains("name = Debug;"))
        for configuration in [projectDebug, targetDebug] {
            XCTAssertFalse(configuration.contains("baseConfigurationReference"),
                           "an xcconfig on the Debug chain could drop DEBUG unseen")
        }
        // The target may override the conditions only if DEBUG survives.
        for line in targetDebug.components(separatedBy: "\n")
        where line.contains("SWIFT_ACTIVE_COMPILATION_CONDITIONS") {
            let value = line.components(separatedBy: "=").dropFirst().joined(separator: "=")
            let tokens = value.components(separatedBy: CharacterSet(charactersIn: " \t;\","))
            XCTAssertTrue(tokens.contains("DEBUG") || tokens.contains("$(inherited)"),
                          "the Relayium target's Debug overrides SWIFT_ACTIVE_COMPILATION_CONDITIONS without DEBUG")
        }
    }

    /// The flag and `isActive` live in `enum UITestMode`'s own `#if DEBUG`
    /// branch, with `isActive = false` in its `#else`.
    func testTheIsolationFlagIsInsideUITestModesDEBUGBranch() throws {
        let mode = try RepoRoot.text("apps/mac/Relayium/UITestMode.swift")
        let opener = "\nenum UITestMode {\n    #if DEBUG\n"
        XCTAssertEqual(mode.components(separatedBy: opener).count, 2,
                       "UITestMode must open with exactly `#if DEBUG`")
        let body = try XCTUnwrap(mode.components(separatedBy: opener).last)
        let debug = try XCTUnwrap(body.components(separatedBy: "\n    #else\n").first)
        let rest = try XCTUnwrap(body.components(separatedBy: "\n    #else\n").dropFirst().first)
        let release = try XCTUnwrap(rest.components(separatedBy: "\n    #endif\n").first)
        for branch in [debug, release] {
            XCTAssertFalse(branch.components(separatedBy: "\n").contains {
                let t = $0.trimmingCharacters(in: .whitespaces)
                return t.hasPrefix("#if") || t.hasPrefix("#else") || t.hasPrefix("#elseif") || t.hasPrefix("#endif")
            }, "UITestMode's DEBUG/else branches must not nest another conditional")
        }
        XCTAssertTrue(code(text: debug).contains("staticletargument=\"--relayium-ui-testing\""))
        XCTAssertTrue(code(text: debug).contains("staticletisActive=ProcessInfo.processInfo.arguments.contains(argument)"))
        XCTAssertTrue(code(text: release).contains("staticletisActive=false"))
    }

    /// One object of `project.pbxproj`, by its exact id: from its header line
    /// to the closing brace at the same depth.
    private func pbxObject(_ id: String, in project: String) throws -> String {
        let parts = project.components(separatedBy: "\n\t\t\(id) /* ")
        XCTAssertEqual(parts.count, 2, "project.pbxproj must define \(id) exactly once")
        return try XCTUnwrap(parts.last?.components(separatedBy: "\n\t\t};\n").first)
    }

    /// Every DeviceInboxUITests launch carries the flag `UITestMode` reads.
    func testTheOfflineUILaunchCarriesTheIsolationFlag() throws {
        let mode = try RepoRoot.text("apps/mac/Relayium/UITestMode.swift")
        let debug = try code(text: XCTUnwrap(mode.components(separatedBy: "#else").first))
        XCTAssertTrue(debug.contains("staticletargument=\"--relayium-ui-testing\""))
        XCTAssertTrue(debug.contains("staticletisActive=ProcessInfo.processInfo.arguments.contains(argument)"))

        let tests = try code("apps/mac/RelayiumUITests/DeviceInboxUITests.swift")
        XCTAssertTrue(tests.contains("privatevarofflineLaunchArguments:[String]{[\"--relayium-ui-testing\","),
                      "the isolation flag must be the first offline launch argument")
        XCTAssertEqual(tests.components(separatedBy: "app.launch()").count, 2,
                       "every launch must go through the one helper that passes the flag")
        XCTAssertTrue(tests.contains("app.launchArguments=offlineLaunchArguments+extraArgumentsapp.launch()"))
    }

    /// The guarded controller is the app's only way to start Sparkle.
    func testNothingStartsSparkleOutsideTheGuardedController() throws {
        var controllers: [String] = []
        for file in try RepoRoot.swiftFiles(under: "apps/mac/Relayium") {
            let source = try code(text: RepoRoot.text(of: file))
            if source.contains("SPUStandardUpdaterController(") { controllers.append(file.lastPathComponent) }
            for bypass in ["startUpdater(", "SPUUpdater(hostBundle", "updater.start(", "startingUpdater:true"] {
                XCTAssertFalse(source.contains(bypass), "\(file.lastPathComponent) starts Sparkle via \(bypass)")
            }
        }
        XCTAssertEqual(controllers, ["DirectDistribution.swift"])
        let distribution = try code("apps/mac/Relayium/Distribution/DirectDistribution.swift")
        XCTAssertEqual(distribution.components(separatedBy: "SPUStandardUpdaterController(").count, 2)
        XCTAssertEqual(distribution.components(separatedBy: "startingUpdater:").count, 2)
    }

    /// The consent check is immediate, and the window recovery that follows it
    /// keeps its menu-bar fallback and its 5 s and 20 s waits.
    func testDeviceInboxLaunchDeclinesConsentImmediatelyAndKeepsWindowRecovery() throws {
        let tests = try code("apps/mac/RelayiumUITests/DeviceInboxUITests.swift")
        let start = "privatefunclaunch(_extraArguments:[String]){"
        let helper = try XCTUnwrap(tests.components(separatedBy: start).dropFirst().first?
            .components(separatedBy: "privatefuncsidebarDeviceInbox(").first)
        XCTAssertEqual(start + helper,
            "privatefunclaunch(_extraArguments:[String]){"
            + "app.launchArguments=offlineLaunchArguments+extraArgumentsapp.launch()"
            + "letsparkleDecline=app.buttons[\"Don’tCheck\"]"
            + "ifsparkleDecline.exists{sparkleDecline.click()}"
            + "if!app.windows.allElementsBoundByIndex.contains(where:{"
            + "$0.frame.width>=800&&$0.frame.height>=500}){"
            + "letstatusItem=app.statusItems.firstMatch"
            + "XCTAssertTrue(statusItem.waitForExistence(timeout:5),"
            + "\"theresidentapphasnomenu-barrecoverysurface\")"
            + "statusItem.click()app.typeKey(\"o\",modifierFlags:[])}"
            + "XCTAssertTrue(mainWindow.waitForExistence(timeout:20),\"theproductwindowdidnotopen\")}")
        XCTAssertFalse(tests.contains("sparkleDecline.waitForExistence"))
    }

    private func code(text: String) -> String {
        text.components(separatedBy: "\n")
            .map { String($0.components(separatedBy: "//")[0]) }
            .joined().filter { !$0.isWhitespace }
    }
}
