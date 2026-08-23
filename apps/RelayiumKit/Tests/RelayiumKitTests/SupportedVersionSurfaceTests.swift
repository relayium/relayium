import XCTest
@testable import RelayiumAppKit

/// **The absences and the wiring the version policy depends on.**
///
/// Two kinds of claim live here, and neither has a runtime this package can
/// observe:
///
///  1. **Seam guards.** That the direct build's update action is Sparkle's own
///     check and the App Store build's is a compiled-in App Store address; that
///     no policy document can reach either; that the blocking surface replaces
///     the product rather than covering it, at the scene root and not inside the
///     shell. Each of these is a property of WHICH source says what, so it is
///     read from the source.
///  2. **The version graph.** That the Xcode project, the published policy
///     document, the Sparkle feed and the floor compiled into this binary all
///     describe one release history. Four files, two vocabularies — marketing
///     version and `CFBundleVersion` — and no single build step that would
///     notice them disagreeing.
final class SupportedVersionSurfaceTests: XCTestCase {

    private func text(_ path: String) throws -> String { try RepoRoot.text(path) }

    private func macSource(_ name: String) throws -> String {
        try text("apps/mac/Relayium/\(name)")
    }

    /// The file with its comments removed.
    ///
    /// Needed because these files EXPLAIN the absences they maintain: the App
    /// Store seam's own documentation says why it has no `import Sparkle`, and
    /// the decoder's says why it carries no URL. Searching the raw text finds
    /// the sentence and reports the thing it describes. Stripping is naive —
    /// it cuts at the first `//`, string literals included — which is safe for
    /// the absence checks below and never used for a presence one.
    private func code(_ source: String) -> String {
        source.components(separatedBy: "\n")
            .map { line -> String in
                guard let comment = line.range(of: "//") else { return line }
                return String(line[..<comment.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// The file as a RELEASE build compiles it: every `#if DEBUG` arm removed,
    /// every `#else` arm of one kept.
    ///
    /// This is what makes "absent from Release" an assertion rather than a
    /// sentence in a comment. The acceptance seams below — a launch argument
    /// that tells the policy which version to evaluate, and an object that
    /// records that the update action ran — are exactly the two things that must
    /// not exist in a shipped binary: one decides whether the app runs at all,
    /// and the other is reachable from the surface a blocked build shows. A
    /// `#if DEBUG` around them is only worth what a test holds it to.
    ///
    /// An `#if` on anything OTHER than `DEBUG` keeps both arms, because this
    /// function's job is to over-approximate what Release contains: a seam
    /// hidden behind a condition this does not model should be reported, not
    /// quietly excused.
    private func releaseCode(_ source: String) -> String {
        var stack: [(isDebugGate: Bool, inElse: Bool)] = []
        var kept: [String] = []
        for line in source.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == "#if" || trimmed.hasPrefix("#if ") {
                stack.append((isDebugGate: trimmed == "#if DEBUG", inElse: false))
                continue
            }
            // `#elseif` is treated as an else: it opens an arm this does not
            // model, and keeping it is the over-approximating direction.
            if trimmed == "#else" || trimmed.hasPrefix("#elseif") {
                if !stack.isEmpty { stack[stack.count - 1].inElse = true }
                continue
            }
            if trimmed == "#endif" {
                if !stack.isEmpty { stack.removeLast() }
                continue
            }
            guard !stack.contains(where: { $0.isDebugGate && !$0.inElse }) else { continue }
            kept.append(line)
        }
        XCTAssertTrue(stack.isEmpty, "unbalanced #if in the scanned source")
        return kept.joined(separator: "\n")
    }

    /// One declaration's body, so a claim about `startUpdate` is not satisfied
    /// by a line somewhere else in the file.
    private func declaration(of signature: String, in source: String) throws -> String {
        let start = try XCTUnwrap(source.range(of: signature), "no \(signature)")
        var depth = 0
        var body = ""
        for character in source[start.lowerBound...] {
            body.append(character)
            if character == "{" { depth += 1 }
            if character == "}" {
                depth -= 1
                if depth == 0 { return body }
            }
        }
        XCTFail("unterminated \(signature)")
        return body
    }

    // MARK: - the update action

    /// **The direct build's Update button is Sparkle's ordinary check.**
    ///
    /// Which means the appcast it resolves is the one compiled into this build
    /// and the EdDSA signature is verified before anything installs. A policy
    /// document — malformed, replayed or hostile — decides whether the app ASKS
    /// for an update and can reach nothing else.
    func testTheDirectUpdateActionIsSparkleAndNothingElse() throws {
        let direct = try macSource("Distribution/DirectDistribution.swift")
        let action = try declaration(of: "func startUpdate()", in: direct)
        XCTAssertTrue(action.contains("updater.checkForUpdates()"),
                      "the direct update action no longer runs Sparkle's own check")
        for reaching in ["URL(", "NSWorkspace", "openURL", "feedURL", "setFeedURL", "policy"] {
            XCTAssertFalse(action.contains(reaching),
                           "the direct update action reaches \(reaching)")
        }
    }

    /// The App Store build has no updater, so its action is the one honest thing
    /// left: the App Store's own page, at an address compiled in here.
    func testTheAppStoreUpdateActionIsAFixedCompiledInAddress() throws {
        let store = try macSource("Distribution/AppStoreDistribution.swift")
        XCTAssertTrue(store.contains(
            #"static let updatesPage = URL(string: "macappstore://showUpdatesPage")!"#),
            "the App Store update address is not the fixed literal")
        let action = try declaration(of: "func startUpdate()", in: store)
        XCTAssertTrue(action.contains("NSWorkspace.shared.open(Self.updatesPage)"))
        // The structural absence this build's App Store review depends on, and
        // the reason the seam exists at all.
        XCTAssertFalse(code(store).contains("import Sparkle"),
                       "the App Store build imports Sparkle")
        XCTAssertFalse(code(store).contains("SPUUpdater"))
    }

    /// **Nothing in the policy path can name an address.** The decoder has no
    /// `URL` in it at all, so there is nowhere for one to be read into; the one
    /// address in the feature is the fetch endpoint, built from the app's own
    /// production origin.
    func testThePolicyItselfCarriesNoAddress() throws {
        let decoder = code(
            try text("apps/RelayiumKit/Sources/RelayiumAppKit/SupportedVersion.swift"))
        XCTAssertFalse(decoder.contains("URL"), "the policy decoder has a URL in it")
        XCTAssertFalse(decoder.contains("http"), "the policy decoder names an address")

        let model = try text("apps/RelayiumKit/Sources/RelayiumAppKit/SupportedVersionModel.swift")
        XCTAssertFalse(code(model).contains("https:"),
                       "the model writes an address inline instead of deriving one")
        XCTAssertTrue(model.contains("AppEnvironment.productionBaseURL"),
                      "the policy endpoint is not derived from the app's own origin")
    }

    // MARK: - the blocking surface

    /// The gate is a REPLACEMENT, not an overlay: below the minimum the shell is
    /// not in the tree, so none of the app-scoped tasks attached to it run. A
    /// build the product refuses to answer for does not go on opening a room
    /// socket behind an update button.
    func testTheBlockedBuildDoesNotBuildTheProductSurfaceAtAll() throws {
        let gate = try macSource("Shell/AppVersionGate.swift")
        XCTAssertTrue(gate.contains("if support.isBlocked, let policy = support.state.policy {"),
                      "the gate no longer branches on the blocking state")
        XCTAssertTrue(gate.contains("UnsupportedVersionView("))
        XCTAssertTrue(gate.contains("} else {\n            content()"),
                      "the product surface is not the else arm of the block")
        // Not a cover-up. `.disabled` or an opaque overlay would leave every
        // task on the shell running while the user reads an update button.
        XCTAssertFalse(gate.contains(".disabled(support.isBlocked)"))
        XCTAssertFalse(gate.contains(".overlay { if support.isBlocked"))
    }

    /// The blocking screen offers exactly two ways out, and no third.
    ///
    /// A skip, a countdown or a "continue anyway" would make the minimum a
    /// suggestion — and the state exists precisely for the cases where it is not
    /// one. Quit is offered because closing the window does NOT end this app:
    /// the menu-bar extra keeps the process alive.
    func testTheBlockingScreenOffersUpdateAndQuitAndNoWayPast() throws {
        let gate = try macSource("Shell/AppVersionGate.swift")
        let screen = try declaration(of: "struct UnsupportedVersionView: View", in: gate)
        XCTAssertTrue(screen.contains("action: update"))
        XCTAssertTrue(screen.contains("Button(L10n.t(.updateActionQuit), action: quit)"))
        XCTAssertFalse(screen.contains("updateActionDismiss"),
                       "the blocking screen offers a way past the block")
        XCTAssertFalse(screen.contains("dismiss"))
        // The label follows the mechanism through the tested seam rather than
        // being re-decided in the view.
        XCTAssertTrue(screen.contains(
            "UpdateRequirementPresentation\n                    "
            + ".updateActionLabel(channel: AppDistribution.channel)"))

        // **The surface identifier is the heading's, not the container's.**
        //
        // An `accessibilityIdentifier` on the enclosing stack propagates to
        // every descendant and overwrites theirs, which is how a built-App run
        // found the blocked screen and then no `version-blocked-update` and no
        // `version-blocked-quit` on it — the two ways out this state exists to
        // offer, unreachable to the suite that must click one. Asserted by
        // indentation because that is exactly what distinguishes the two: a
        // modifier at the body's own level applies to the whole stack.
        XCTAssertTrue(screen.contains(
            "Text(L10n.t(.updateRequiredTitle))\n"
            + "                .font(.title2)\n"
            + "                .multilineTextAlignment(.center)\n"
            + "                .fixedSize(horizontal: false, vertical: true)\n"
            + "                .accessibilityIdentifier(\"version-blocked\")"),
            "the blocked surface identifier is no longer the heading's own")
        XCTAssertFalse(screen.contains(
            "\n        .accessibilityIdentifier(\"version-blocked\")"),
            "the blocked surface identifier is back on the container, where it "
            + "overwrites the update and quit identifiers")
    }

    /// The recommendation is the opposite shape: nothing is replaced, nothing is
    /// disabled, and it can be dismissed.
    func testTheRecommendationIsDismissibleAndBlocksNothing() throws {
        let gate = try macSource("Shell/AppVersionGate.swift")
        XCTAssertTrue(gate.contains("if support.showsRecommendation"))
        XCTAssertTrue(gate.contains(".safeAreaInset(edge: .top, spacing: 0)"),
                      "the recommendation covers the surface it is recommending an update for")
        let banner = try declaration(of: "struct UpdateRecommendationBanner: View", in: gate)
        XCTAssertTrue(banner.contains("Button(L10n.t(.updateActionDismiss), action: dismiss)"))
        XCTAssertFalse(banner.contains(".disabled("))
    }

    /// **The gate is at the scene root, and the shell does not know it exists.**
    ///
    /// The shell's contract is that its split view renders unconditionally —
    /// every capability that works signed out depends on it, and
    /// `MacSurfaceGuardTests` holds it to that. Whether this binary may run at
    /// all is a different question, asked before there is a product surface to
    /// gate, and it is asked in exactly one place.
    func testTheGateIsWiredOnceAtTheSceneRootAndNotInTheShell() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertEqual(app.components(separatedBy: ".appVersionGate(versionSupport,").count - 1, 1,
                       "the version gate is applied more or less than once")
        XCTAssertTrue(app.contains("update: updates.startUpdate,"),
                      "the scene decides the update action itself instead of using the seam")
        XCTAssertTrue(app.contains("@StateObject private var versionSupport: SupportedVersionModel"),
                      "the policy model is not app-scoped")

        let shell = try macSource("Shell/AppShellView.swift")
        for symbol in ["SupportedVersionModel", "isBlocked", "AppVersionGate", "updateRequired"] {
            XCTAssertFalse(shell.contains(symbol),
                           "the shell decides whether this build may run: \(symbol)")
        }
    }

    /// The menu bar is a live control surface — it can resume nearby receiving
    /// and the Device Inbox. A blocked build that kept it would be one the
    /// product refuses to run and a user could put back into service from a menu.
    func testTheMenuBarIsGatedTooAndOffersTheSameTwoActions() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(
            app.contains("if versionSupport.isBlocked {\n                    MenuBarVersionBlock("),
            "the menu bar still renders the product's controls while blocked")
        let gate = try macSource("Shell/AppVersionGate.swift")
        let menu = try declaration(of: "struct MenuBarVersionBlock: View", in: gate)
        XCTAssertTrue(menu.contains("action: update"))
        XCTAssertTrue(menu.contains("NSApplication.shared.terminate(nil)"))
        for control in ["discovery.resume", "inbox.resume", "openWindow"] {
            XCTAssertFalse(menu.contains(control), "the blocked menu still offers \(control)")
        }
    }

    /// Acceptance runs against the embedded floor and reaches production for
    /// nothing — the same rule residency and notification registration follow,
    /// and for the same reason.
    func testAnAcceptanceLaunchNeitherFetchesNorWritesAPolicy() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("guard !UITestMode.isActive,\n"
                                   + "                          !AppEnvironment.isEngineeringCandidate else { return }\n"
                                   + "                    await versionSupport.refresh()"),
                      "an acceptance launch fetches the production policy")
        XCTAssertTrue(app.contains("store: UITestMode.isActive\n"
                                   + "                ? InMemorySupportedVersionPolicyStore()\n"
                                   + "                : UserDefaultsSupportedVersionPolicyStore(defaults: AppEnvironment.persistentDefaults)"),
                      "an acceptance launch writes a policy into the product's defaults")
    }

    // MARK: - the acceptance seams, and their absence from Release

    /// **The version an acceptance launch may name, and the Release build that
    /// cannot be told anything.**
    ///
    /// The blocking state is the one state a built-App run cannot otherwise
    /// reach: `testTheProjectPolicyFeedAndFloorDescribeOneReleaseHistory` above
    /// refuses a candidate that ships below its own published minimum, so every
    /// app this suite can build and sign is a supported one. The seam supplies
    /// the only missing input — the number the policy compares — and it must
    /// exist nowhere a user's copy could reach.
    func testTheAcceptanceVersionOverrideIsCompiledOutOfEveryReleaseBuild() throws {
        let mode = try macSource("UITestMode.swift")
        XCTAssertTrue(mode.contains(
            #"static let appVersionArgument = "--relayium-ui-testing-app-version""#),
            "the acceptance version override no longer has a launch argument")
        // Gated on the acceptance flag as well as on the compilation condition,
        // like every other seam in that file: a Debug build a developer runs
        // from Xcode passes no such argument and must read its own bundle.
        XCTAssertTrue(mode.contains(
            "guard isActive,\n"
            + "              let flag = arguments.firstIndex(of: appVersionArgument),"),
            "a Debug launch that is not an acceptance run can name its own version")

        let release = code(releaseCode(mode))
        XCTAssertFalse(release.contains("appVersionArgument"),
                       "a Release build carries the version-override launch argument")
        XCTAssertFalse(release.contains("relayium-ui-testing-app-version"))
        XCTAssertTrue(release.contains("static var appVersionOverride: AppVersion? { nil }"),
                      "the Release answer for the version override is not a nil constant")
    }

    /// **The update-action witness observes and decides nothing.**
    ///
    /// A UI test cannot assert on what Sparkle's check produces — an appcast
    /// fetch, a signature verification, possibly a download — without depending
    /// on the public network and on which release the machine already has. So
    /// the runtime claim is narrowed to the one thing under test: the blocked
    /// screen's button reaches the shipped update action. That the action IS
    /// Sparkle stays a source claim, made by
    /// `testTheDirectUpdateActionIsSparkleAndNothingElse` and reinforced here —
    /// the updater call is the first statement of the function and is inside no
    /// compilation gate, so the observation cannot be what runs.
    func testTheUpdateActionWitnessIsCompiledOutAndDecidesNothing() throws {
        let mode = try macSource("UITestMode.swift")
        XCTAssertTrue(mode.contains("final class UITestUpdateActionWitness: ObservableObject"))
        XCTAssertTrue(mode.contains("guard UITestMode.isActive else { return }"),
                      "the update-action witness publishes outside an acceptance launch")
        XCTAssertFalse(code(releaseCode(mode)).contains("UITestUpdateActionWitness"),
                       "a Release build carries the update-action witness")

        let direct = try macSource("Distribution/DirectDistribution.swift")
        let action = try declaration(of: "func startUpdate()", in: direct)
        XCTAssertTrue(action.contains("{\n        guard !AppEnvironment.isEngineeringCandidate else { return }\n"
                                      + "        updater.checkForUpdates()\n        #if DEBUG"),
                      "the engineering build can reach Sparkle, or the production check "
                      + "is no longer the first action after that fixed-identity guard")
        let releaseAction = code(releaseCode(action))
        XCTAssertTrue(releaseAction.contains("guard !AppEnvironment.isEngineeringCandidate else { return }\n"
                                             + "        updater.checkForUpdates()"),
                      "the engineering no-update guard no longer directly protects Sparkle")
        XCTAssertTrue(releaseAction.contains("updater.checkForUpdates()"),
                      "the production update call is inside the acceptance gate")
        XCTAssertFalse(releaseAction.contains("UITestUpdateActionWitness"))

        let gate = try macSource("Shell/AppVersionGate.swift")
        let releaseGate = code(releaseCode(gate))
        XCTAssertFalse(releaseGate.contains("UITestUpdateActionWitness"),
                       "the shipped blocking screen observes the acceptance witness")
        XCTAssertFalse(releaseGate.contains("version-blocked-update-reached"),
                       "the shipped blocking screen carries the acceptance marker")
        // …and the two identifiers a shipped build does carry are untouched.
        XCTAssertTrue(releaseGate.contains(#".accessibilityIdentifier("version-blocked-update")"#))
        XCTAssertTrue(releaseGate.contains(#".accessibilityIdentifier("version-blocked")"#))
    }

    /// The scene reads the bundle unless acceptance names another version, and
    /// exactly one place reads it at all.
    func testTheSceneEvaluatesTheBundleVersionUnlessAcceptanceNamesAnother() throws {
        let app = try macSource("RelayiumApp.swift")
        XCTAssertTrue(app.contains("currentVersion: UITestMode.appVersionOverride\n"
                                   + "                ?? SupportedVersionModel.bundleVersion(),"),
                      "the scene no longer falls back to the bundle's own version")
        XCTAssertEqual(app.components(separatedBy: "UITestMode.appVersionOverride").count - 1, 1,
                       "the version override is read more or less than once")
        // The surface is handed a version; it never asks for one. A view that
        // could read the override would be a second place to keep honest.
        let gate = try macSource("Shell/AppVersionGate.swift")
        XCTAssertFalse(gate.contains("appVersionOverride"))
        XCTAssertFalse(gate.contains("bundleVersion"))
    }

    /// **The built-App evidence exists, and still measures what it claims to.**
    ///
    /// Everything above this line is source. The two runtime cases live in the
    /// UI suite, which this package cannot run — so what it can do is hold the
    /// suite to still containing them, and hold the versions those launches use
    /// against the floor this binary compiles. A published minimum that rose
    /// past `1.2.5`, or fell below `1.2.3`, would leave both launches passing
    /// while testing the same state twice.
    func testTheAcceptanceSuiteDrivesBothSidesOfTheVersionGate() throws {
        let ui = try text("apps/mac/RelayiumUITests/AppShellUITests.swift")
        for name in ["func testABuildBelowTheMinimumIsBlockedAndOffersOnlyTheUpdateAction()",
                     "func testASupportedBuildRendersTheOrdinaryShell()"] {
            XCTAssertTrue(ui.contains(name), "the acceptance suite lost \(name)")
        }
        XCTAssertTrue(ui.contains(#"+ ["--relayium-ui-testing-app-version", version]"#),
                      "the acceptance suite no longer names the version to evaluate")
        XCTAssertTrue(ui.contains(#"launchEvaluating(version: "1.2.3")"#),
                      "the blocked acceptance launch no longer names a version")
        XCTAssertTrue(ui.contains(#"launchEvaluating(version: "1.2.5")"#),
                      "the supported acceptance launch no longer names a version")
        // The shipped path too: no override at all, which is the only launch
        // that would notice a floor raised past the version this candidate is.
        XCTAssertTrue(ui.contains("app.launchArguments = offlineLaunchArguments\n"
                                  + "        app.launch()\n"
                                  + "        ensureProductWindowIsOpen()\n"
                                  + "        assertTheOrdinaryShellIsRunning()"),
                      "the acceptance suite no longer launches without an override")
        for identifier in ["version-blocked", "version-blocked-update",
                           "version-blocked-update-reached"] {
            XCTAssertTrue(ui.contains("\"\(identifier)\""),
                          "the acceptance suite no longer asserts \(identifier)")
        }

        let floor = SupportedVersionPolicy.embeddedFloor
        let blocked = try XCTUnwrap(AppVersion("1.2.3"))
        XCTAssertTrue(blocked < floor.minimumSupported,
                      "the suite's blocked launch is no longer below the embedded floor")
        let supported = try XCTUnwrap(AppVersion("1.2.5"))
        XCTAssertTrue(supported >= floor.recommended,
                      "the suite's supported launch is no longer a supported version")
    }

    // MARK: - the version graph

    private func policyDocument() throws -> [String: Any] {
        let data = try RepoRoot.data("web/native-client-policy.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The setting values in the project file, as `BundleVersionTests` reads them.
    private func setting(_ key: String) throws -> Set<String> {
        let project = try text("apps/mac/Relayium.xcodeproj/project.pbxproj")
        return Set(project.components(separatedBy: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("\(key) = ") else { return nil }
            return trimmed.dropFirst("\(key) = ".count)
                .trimmingCharacters(in: CharacterSet(charactersIn: ";\" "))
        })
    }

    /// **One release history, told in four places.**
    func testTheProjectPolicyFeedAndFloorDescribeOneReleaseHistory() throws {
        let document = try policyDocument()
        let mac = try XCTUnwrap(document["macos"] as? [String: Any])
        let minimum = try XCTUnwrap(AppVersion(try XCTUnwrap(mac["minimumSupportedVersion"] as? String)))
        let recommended = try XCTUnwrap(AppVersion(try XCTUnwrap(mac["recommendedVersion"] as? String)))
        let latest = try XCTUnwrap(AppVersion(try XCTUnwrap(mac["latestVersion"] as? String)))
        let minimumBuild = try XCTUnwrap(mac["minimumSupportedBuild"] as? Int)
        let revision = try XCTUnwrap(mac["policyRevision"] as? Int)

        // The candidate this round prepares.
        let marketing = try XCTUnwrap(setting("MARKETING_VERSION").first)
        XCTAssertEqual(try setting("MARKETING_VERSION").count, 1)
        let build = try XCTUnwrap(Int(try XCTUnwrap(setting("CURRENT_PROJECT_VERSION").first)))
        let current = try XCTUnwrap(AppVersion(marketing))

        // This build is one the policy allows to run. A candidate that shipped
        // below its own minimum would block on first launch, and the only way
        // out of it would be an update to itself.
        XCTAssertTrue(current >= minimum, "\(marketing) is below the published minimum")
        XCTAssertTrue(minimum <= recommended)
        XCTAssertTrue(recommended <= latest)
        XCTAssertTrue(latest <= current, "the candidate is older than the published release")
        XCTAssertTrue(minimumBuild <= build)

        // The embedded floor is the same decision compiled in, and it may never
        // exceed the published one — a binary stricter than the policy would
        // block on a requirement nobody published.
        let floor = SupportedVersionPolicy.embeddedFloor
        XCTAssertTrue(floor.minimumSupported <= minimum)
        XCTAssertTrue(floor.recommended <= recommended)
        XCTAssertTrue(floor.minimumSupportedBuild <= minimumBuild)
        XCTAssertTrue(floor.minimumSupported <= current,
                      "the floor compiled into this build would block it with no network")

        // **The replay barrier, held to the document it starts from.** The
        // floor's revision is what a device with no cache refuses below, so a
        // binary claiming a revision the product has not published would reject
        // the published policy as a replay — and, having rejected it, would
        // never hear another one. Below-or-equal in the same direction as every
        // requirement comparison above.
        XCTAssertTrue((1...SupportedVersionPolicy.maxPolicyRevision).contains(revision),
                      "the published policyRevision is outside the range clients read")
        XCTAssertTrue(floor.revision <= revision,
                      "this binary would refuse the published policy as a replay")

        // And the served document decodes through the shipped decoder, floor and
        // all — the file this repository publishes is one this binary accepts.
        let published = try RepoRoot.data("web/public/apps/macos/client-policy.json")
        let decoded = try SupportedVersionPolicy.decode(published)
        XCTAssertEqual(decoded.minimumSupported, minimum)
        XCTAssertEqual(decoded.minimumSupportedBuild, minimumBuild)
        XCTAssertEqual(decoded.revision, revision)
        // A fresh install accepts it: `decode` alone is not the whole gate.
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(decoded, over: nil))
    }

    /// **One ceiling, written in two languages.**
    ///
    /// The client refuses a revision above `maxPolicyRevision` and the release
    /// path refuses to publish one. If the two numbers drifted apart, the release
    /// path would stage a policy every client silently declines — and a declined
    /// policy is not a failure anybody sees, it is a fleet quietly falling back
    /// to the embedded floor.
    func testTheReleasePathAndTheClientBoundTheRevisionAtTheSameNumber() throws {
        let script = try text("web/scripts/stage-macos-release.mjs")
        XCTAssertTrue(
            script.contains("MAX_POLICY_REVISION = \(SupportedVersionPolicy.maxPolicyRevision);"),
            "the staging script's revision ceiling is not the client's")
    }

    /// **The two vocabularies, held to each other.**
    ///
    /// Sparkle compares `CFBundleVersion`, so the feed's threshold is a build
    /// number; the client compares the marketing version. The releases below the
    /// minimum predate every line of the client policy and will never run it —
    /// the critical update in the feed is the only lever that reaches them.
    func testTheFeedMarksTheSameReleaseCriticalThatThePolicyRequires() throws {
        let mac = try XCTUnwrap(try policyDocument()["macos"] as? [String: Any])
        let minimumBuild = try XCTUnwrap(mac["minimumSupportedBuild"] as? Int)
        let feed = try text("web/public/apps/macos/appcast.xml")

        let threshold = try XCTUnwrap(
            feed.range(of: #"<sparkle:criticalUpdate[^>]*?sparkle:version="([0-9]+)""#,
                       options: .regularExpression),
            "the published feed carries no critical-update threshold")
        XCTAssertTrue(feed[threshold].contains("\"\(minimumBuild)\""),
                      "the feed's critical threshold is not the policy's minimum build")
        XCTAssertEqual(feed.components(separatedBy: "<sparkle:criticalUpdate").count - 1, 1)

        // The threshold is a BUILD, not a marketing version. A feed carrying
        // `sparkle:version="1.2.4"` would compare a dotted string against
        // `CFBundleVersion` and quietly mark nothing critical.
        XCTAssertFalse(feed[threshold].contains("."))
    }
}
