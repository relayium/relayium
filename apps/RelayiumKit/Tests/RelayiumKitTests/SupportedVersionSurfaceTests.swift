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

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in url.deletingLastPathComponent() }
    }

    private func text(_ path: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent(path), encoding: .utf8)
    }

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
        XCTAssertTrue(app.contains("guard !UITestMode.isActive else { return }\n"
                                   + "                    await versionSupport.refresh()"),
                      "an acceptance launch fetches the production policy")
        XCTAssertTrue(app.contains("store: UITestMode.isActive\n"
                                   + "                ? InMemorySupportedVersionPolicyStore()\n"
                                   + "                : UserDefaultsSupportedVersionPolicyStore()"),
                      "an acceptance launch writes a policy into the product's defaults")
    }

    // MARK: - the version graph

    private func policyDocument() throws -> [String: Any] {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent("web/native-client-policy.json"))
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

        // And the served document decodes through the shipped decoder, floor and
        // all — the file this repository publishes is one this binary accepts.
        let published = try Data(contentsOf: repoRoot.appendingPathComponent(
            "web/public/apps/macos/client-policy.json"))
        let decoded = try SupportedVersionPolicy.decode(published)
        XCTAssertEqual(decoded.minimumSupported, minimum)
        XCTAssertEqual(decoded.minimumSupportedBuild, minimumBuild)
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
