import Foundation
import XCTest

/// **The semantic boundary between an accent FILL and an accent LABEL, made
/// executable.**
///
/// The iOS app has one brand violet used two ways, and only one of them is
/// allowed to be a foreground. Measured on real Dark screenshots at 3× on a
/// 402×874pt iPhone, before this batch:
///
///  * `#7C3AED` as a fill, with white on it — **5.6–5.7:1**, correct;
///  * `#7C3AED` as a `.bordered` button's label on its `#39393D` fill —
///    **2.02:1**;
///  * `#7C3AED` as a plain text action on the `#1C1C1E` card — **2.99:1**;
///  * `#7C3AED` as the nearby roster's selected glyph on `Palette.actionSurface`
///    — **2.70:1**;
///  * `#7C3AED` as a reached `PathRail` stop's fill on the card — **2.99:1**.
///
/// So the accent asset is untouched and a second role, `ActionLabel`, carries
/// every foreground use. After the change the same measurements are 4.91:1,
/// 7.36:1, 6.66:1 and 7.38:1 — the last two computed from the three colours this
/// batch measured on screen rather than sampled end to end, because a
/// progressed rail and a populated roster need a live peer.
///
/// ## Why these are source guards
///
/// Every one of them is an ABSENCE or a PAIRING, and neither has a runtime to
/// observe. There is no test that can watch the 65th `.bordered` button be
/// written without a role, or watch a destructive control quietly acquire the
/// ordinary label colour — both compile, both run, and both look right in a
/// diff. The UI audit in `AppShellUITests` catches what is on screen on the six
/// surfaces it walks; this catches what is in the source everywhere else.
///
/// The guards are deliberately not "does the token exist". Each one is written
/// so that the plausible regression — the one a person would actually make —
/// fails: a new naked `.bordered`, a role that stopped matching its button, a
/// silently darkened colourset, a Share extension whose copy of the role drifts
/// from the app's, a contrast check quietly subtracted again.
final class IOSActionColorGuardTests: XCTestCase {

    private var appRoot: URL { get throws { try RepoRoot.directory("apps/ios/Relayium") } }
    private var shareRoot: URL { get throws { try RepoRoot.directory("apps/ios/RelayiumShare") } }

    /// The one file allowed to spell the underlying SwiftUI style.
    private static let styleFile = "Components/ActionButton.swift"

    private func appSources() throws -> [(name: String, text: String)] {
        try swiftSources(under: try appRoot)
    }

    private func swiftSources(under root: URL) throws -> [(name: String, text: String)] {
        let enumerator = FileManager.default.enumerator(at: root,
                                                        includingPropertiesForKeys: nil)
        var found: [(name: String, text: String)] = []
        while let url = enumerator?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let name = url.path.replacingOccurrences(of: root.path + "/", with: "")
            found.append((name: name, text: try RepoRoot.text(of: url)))
        }
        // A guard that scans nothing reports clean, which is the failure mode
        // `RepoRoot` exists for. Say so here too: this walk is by directory
        // rather than by named file, so a moved tree yields an empty list.
        XCTAssertFalse(found.isEmpty, "no Swift source under \(root.path); this guard would "
                       + "have scanned nothing and reported clean")
        return found
    }

    // MARK: - the style has exactly one spelling

    /// **The guard the whole file exists for.** `.buttonStyle(.bordered)` may be
    /// written in exactly one place; every control reaches it through
    /// `borderedAction(_:)` and therefore states its role.
    ///
    /// Before this batch there were 64 naked `.bordered` call sites and a stale
    /// comment in the UI suite claiming 48 — nobody had recounted, and the two
    /// the first audit happened to visit were treated as three controls rather
    /// than as one palette decision. A 65th written the old way would inherit
    /// the failing colour and nothing would say so.
    func testTheBorderedStyleIsSpelledInExactlyOnePlace() throws {
        for source in try appSources() where source.name != Self.styleFile {
            XCTAssertFalse(source.text.contains(".buttonStyle(.bordered)"),
                           "\(source.name) spells `.buttonStyle(.bordered)` directly. "
                           + "Use `.borderedAction()` or `.borderedAction(.destructive)` "
                           + "so the control states its role and gets the label colour "
                           + "that role requires — see \(Self.styleFile).")
        }
        let style = try XCTUnwrap(try appSources().first { $0.name == Self.styleFile }?.text)
        XCTAssertTrue(style.contains(".buttonStyle(.bordered)"),
                      "\(Self.styleFile) no longer applies the style it owns")
    }

    /// Every one of the 64 sites, and the split between them.
    ///
    /// The numbers are asserted rather than merely counted so that a control
    /// deleted, added or reclassified has to be looked at. `>=` would let the
    /// destructive set shrink to zero silently, which is the exact regression
    /// this file is about.
    func testEveryBorderedActionSiteIsAccountedFor() throws {
        var ordinary = 0, destructive = 0, conditional = 0
        for source in try appSources() where source.name != Self.styleFile {
            for line in source.text.components(separatedBy: "\n") {
                // Prose only. Two comments in `DirectView` name the modifier to
                // say why a control is outlined rather than prominent, and a
                // count that included them would be two controls the app does
                // not have.
                guard !Self.isComment(line), line.contains(".borderedAction(") else { continue }
                if line.contains(".borderedAction()") { ordinary += 1 }
                else if line.contains(".borderedAction(.destructive)") { destructive += 1 }
                else { conditional += 1 }
            }
        }
        XCTAssertEqual(ordinary, 43, "ordinary bordered actions")
        XCTAssertEqual(destructive, 20, "destructive bordered actions")
        XCTAssertEqual(conditional, 1,
                       "exactly one control has a conditional role: "
                       + "NearbyLinkWorkspaceView's exit, destructive while the "
                       + "session is live and ordinary once it has ended")
        XCTAssertEqual(ordinary + destructive + conditional, 64,
                       "the app had 64 bordered controls when this boundary was drawn; "
                       + "a new one is fine, but it has to be counted here and its role "
                       + "has to be a decision rather than a default")
    }

    /// **The role on the style must match the role on the button.**
    ///
    /// This is the finding a diff hides best. `.borderedAction()` under a
    /// `Button(role: .destructive)` overrides the system's destructive red with
    /// the ordinary label colour — a Delete that no longer reads as one — and
    /// `.borderedAction(.destructive)` under an ordinary button leaves the
    /// failing accent in place, which is the original defect back again.
    ///
    /// The pairing is read by walking UP from the style to the nearest `Button`,
    /// `Link`, `ShareLink` or `Group` that opens the chain.
    ///
    /// It has already earned itself once. The 64 sites were first classified by
    /// a script that only looked for `Button`, so a `ShareLink` *Share* in
    /// `NearbyLinkWorkspaceView` inherited the role of a `Cancel` twenty-five
    /// lines above it and was written as destructive — a Share that would have
    /// shipped drawn in the system's delete red. This guard is what found it.
    func testEveryBorderedActionRoleMatchesItsButtonRole() throws {
        var checked = 0
        for source in try appSources() where source.name != Self.styleFile {
            let lines = source.text.components(separatedBy: "\n")
            for (index, line) in lines.enumerated()
            where !Self.isComment(line) && line.contains(".borderedAction(") {
                guard let opener = Self.openerAbove(index, in: lines) else {
                    return XCTFail("\(source.name):\(index + 1) applies `.borderedAction` "
                                   + "to nothing this guard can find the role of")
                }
                let declaresDestructive = opener.contains("role: .destructive")
                let conditionalRole = opener.contains("role: ") && opener.contains("?")
                checked += 1
                if conditionalRole {
                    XCTAssertTrue(line.contains(".ordinary") && line.contains(".destructive"),
                                  "\(source.name):\(index + 1) opens a button whose role is "
                                  + "conditional but applies one fixed style role")
                    continue
                }
                XCTAssertEqual(line.contains(".borderedAction(.destructive)"), declaresDestructive,
                               "\(source.name):\(index + 1) disagrees with the button above "
                               + "it: `\(opener.trimmingCharacters(in: .whitespaces))`. A "
                               + "destructive control keeps the system red and must pass "
                               + "`.destructive`; an ordinary one must not, or it keeps the "
                               + "2.02:1 accent.")
            }
        }
        XCTAssertEqual(checked, 64, "every bordered control must have been paired")
    }

    /// A line that is prose rather than code.
    private static func isComment(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("//")
    }

    /// A source with its prose removed.
    ///
    /// Every guard in this file that looks for a spelling has to read code only.
    /// The comments here name the very symbols the guards ban — that is what the
    /// comments are FOR — and a guard that read them would fail on its own
    /// explanation, which is exactly what the first run of these three did.
    private static func code(_ text: String) -> String {
        text.components(separatedBy: "\n").filter { !isComment($0) }.joined(separator: "\n")
    }

    /// The nearest chain opener above a modifier line.
    private static func openerAbove(_ index: Int, in lines: [String]) -> String? {
        for candidate in stride(from: index, through: max(0, index - 40), by: -1) {
            let line = lines[candidate]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !isComment(line) else { continue }
            if trimmed.hasPrefix("Button") || trimmed.hasPrefix("return Button")
                || trimmed.hasPrefix("Link") || trimmed.hasPrefix("ShareLink")
                || trimmed.hasPrefix("Group") {
                return line
            }
        }
        return nil
    }

    // MARK: - the fill role never becomes a foreground

    /// `Palette.action` is the FILL. A foreground drawn in it is the defect this
    /// batch measured at 2.70:1 and 2.99:1, so the two must not be reachable
    /// through the same modifier.
    ///
    /// `actionSurface` is explicitly still allowed as a background — it is the
    /// accent at 14% behind a symbol, and the symbol on top of it is what had to
    /// change.
    func testTheAccentFillIsNeverDrawnAsAForeground() throws {
        for source in try appSources() {
            let lines = source.text.components(separatedBy: "\n")
            for (index, line) in lines.enumerated() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.hasPrefix("///"), !trimmed.hasPrefix("//") else { continue }
                guard line.contains("Palette.action"),
                      !line.contains("Palette.actionLabel"),
                      !line.contains("Palette.actionSurface") else { continue }
                for foreground in ["foregroundStyle", "foregroundColor", "strokeBorder(",
                                   "stroke(", "tint("] where line.contains(foreground) {
                    XCTFail("\(source.name):\(index + 1) draws `Palette.action` as a "
                            + "foreground through `\(foreground)`. That is the fill role; a "
                            + "label or a meaningful symbol uses `Palette.actionLabel`, "
                            + "which is the whole point of the split.")
                }
            }
        }
    }

    /// The two graphics whose accent use was measured under 3:1 now carry the
    /// label role, and carry it in the specific places that were measured.
    ///
    /// Named individually rather than left to the rule above, because the rule
    /// says "not the fill role" and this says "and it is the label role, here" —
    /// a `Color.secondary` fallback would satisfy the first and lose the meaning.
    func testTheMeasuredSmallGraphicsUseTheLabelRole() throws {
        let rail = try XCTUnwrap(try appSources().first { $0.name == "Components/PathRail.swift" }?.text)
        XCTAssertFalse(rail.contains("Palette.action,"), "the rail's ring still uses the fill role")
        XCTAssertTrue(rail.contains("Circle().fill(Palette.actionLabel)"),
                      "a reached stop's fill measured 2.99:1 on the card as the accent")
        XCTAssertTrue(rail.contains("? Palette.hairline : Palette.actionLabel"),
                      "the current stop's ring measured 2.70:1 as the accent")
        XCTAssertTrue(rail.contains("stop.progress == .current ? Palette.actionLabel"),
                      "the current stop's symbol measured 2.70:1 as the accent")
        XCTAssertTrue(rail.contains("travelled ? Palette.actionLabel : Palette.hairline"),
                      "the travelled connector still uses the fill role")

        let nearby = try XCTUnwrap(try appSources().first { $0.name == "NearbyView.swift" }?.text)
        XCTAssertTrue(nearby.contains("selected ? Palette.actionLabel : Color.secondary"),
                      "the roster's selected glyph measured 2.70:1 as the accent and is the "
                      + "first carrier of which device was chosen")
    }

    // MARK: - the two coloursets

    /// **The accent asset is unchanged, and this batch's whole approach depends
    /// on it staying that way.**
    ///
    /// Darkening it would fix the labels and break every fill: white on the
    /// current dark accent measures 5.6–5.7:1, and the tab bar, the switches,
    /// the selection and every `.borderedProminent` shape are drawn from it by
    /// the system for free.
    func testTheAccentColorsetIsUnchanged() throws {
        try assertColourset("apps/ios/Relayium/Assets.xcassets/AccentColor.colorset",
                            light: (0x6D, 0x28, 0xD9), dark: (0x7C, 0x3A, 0xED))
    }

    /// The label role, pinned to the exact values every ratio in this file was
    /// measured at.
    ///
    /// It is also the guard that stands behind the one contrast finding
    /// `AppShellUITests` classifies by name: that exemption records
    /// `Resume receiving` at 4.91:1, and 4.91:1 is a fact about THESE two
    /// values. Darken either and the audit exemption would keep passing over a
    /// control that no longer clears 4.5:1 — so the number is defended here,
    /// where it is defined, rather than there, where it is used.
    func testTheActionLabelColorsetCarriesTheMeasuredValues() throws {
        try assertColourset("apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset",
                            light: (0x6D, 0x28, 0xD9), dark: (0xB4, 0x9C, 0xFB))
    }

    /// Light is byte-identical to the accent, and that is a claim the code makes
    /// out loud: "Light mode is unchanged, by design and by arithmetic".
    ///
    /// If a future edit gives the label role its own Light value, that sentence
    /// becomes false and every Light measurement recorded in this batch becomes
    /// stale. This is the assertion that says so.
    func testTheLabelRoleIsTheAccentInLight() throws {
        let accent = try colourset("apps/ios/Relayium/Assets.xcassets/AccentColor.colorset")
        let label = try colourset("apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset")
        XCTAssertEqual(accent.light, label.light,
                       "the label role diverged from the accent in Light. Every Light ratio "
                       + "this batch recorded assumed they were the same value; re-measure "
                       + "before changing this.")
        XCTAssertNotEqual(accent.dark, label.dark,
                          "the label role collapsed back onto the accent in Dark, which is "
                          + "the 2.02:1 defect")
    }

    /// **No third appearance, and that is a decision rather than an oversight.**
    ///
    /// A high-contrast variant was considered and deliberately not written: the
    /// ordinary Dark value already clears 4.5:1 on the fills these controls
    /// draw, and Increase Contrast separates those fills further rather than
    /// less. Adding a value this batch could not measure would have been prose.
    ///
    /// This asserts the absence so that a future high-contrast entry is a
    /// deliberate, measured act — the test names what evidence it needs.
    func testNeitherColoursetClaimsAnUnmeasuredHighContrastVariant() throws {
        for path in ["apps/ios/Relayium/Assets.xcassets/AccentColor.colorset",
                     "apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset"] {
            let entries = try manifest(path).colors
            XCTAssertEqual(entries.count, 2, "\(path) should carry exactly universal + dark")
            for entry in entries {
                for appearance in entry.appearances ?? [] {
                    XCTAssertEqual(appearance.appearance, "luminosity",
                                   "\(path) gained a `\(appearance.appearance)` appearance. "
                                   + "If that is a high-contrast variant, it needs a measured "
                                   + "ratio behind it under Increase Contrast, which this "
                                   + "batch did not have; add the measurement with the value.")
                }
            }
        }
    }

    // MARK: - the Share extension boundary

    /// **The Share extension ships its own copy of the role, and uses it.**
    ///
    /// `project.pbxproj` adds `Components/DesignTokens.swift`,
    /// `InlineMessage.swift` and `SectionCard.swift` from the app's group to
    /// `RelayiumShare`'s sources. `ActionButton.swift` is not on that list, so
    /// `Palette.actionLabel` is invisible over there — which is why the
    /// extension names the asset directly and carries the colourset in its own
    /// catalog rather than borrowing the app's.
    ///
    /// Two things have to hold together, and neither is visible in a diff of the
    /// other: the extension's colourset must carry the same values the app's
    /// does, and its one ordinary bordered control must actually reach for it.
    /// Ship one without the other and the Cancel is either the wrong violet or
    /// back at the `#7C3AED` 2:1 it started from.
    func testTheShareExtensionShipsAndUsesTheLabelRole() throws {
        let app = try colourset("apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset")
        let share = try colourset("apps/ios/RelayiumShare/Assets.xcassets/ActionLabel.colorset")
        XCTAssertEqual(share.light, app.light,
                       "the extension's ActionLabel diverged from the app's in Light; one "
                       + "brand is one value, and a share sheet that renders a different "
                       + "violet is a share sheet that looks like somebody else's app")
        XCTAssertEqual(share.dark, app.dark,
                       "the extension's ActionLabel diverged from the app's in Dark, where "
                       + "the whole defect was")

        let view = Self.code(try RepoRoot.text("apps/ios/RelayiumShare/ShareRootView.swift"))
        let cancel = try XCTUnwrap(
            view.components(separatedBy: "private var cancelButton: some View {").last,
            "ShareRootView no longer has the cancelButton this guard measures")
        let body = try XCTUnwrap(cancel.components(separatedBy: "\n    }").first)
        XCTAssertTrue(body.contains(".buttonStyle(.bordered)"),
                      "the extension's Cancel is no longer the ordinary bordered control "
                      + "this guard was written for; re-derive the finding rather than "
                      + "deleting the guard")
        XCTAssertTrue(body.contains("""
        .foregroundStyle(Color("ActionLabel"))
        """.trimmingCharacters(in: .whitespacesAndNewlines)),
                      "the extension's Cancel lost the label role and is back to drawing "
                      + "its label in the accent, which measured about 2:1 in Dark")
        XCTAssertFalse(body.contains(".tint("),
                       "`.tint` on iOS 26 derives the bordered fill from the same value, so "
                       + "it lightens the pill with the label and barely moves the ratio — "
                       + "`.foregroundStyle` is the mechanism the app uses and measured")

        // Nothing else in the extension may name the role without the file that
        // explains it: this is the one control the evidence covers.
        for source in try swiftSources(under: try shareRoot) {
            let uses = Self.code(source.text)
                .components(separatedBy: "Color(\"ActionLabel\")").count - 1
            XCTAssertLessThanOrEqual(uses, 1,
                                     "\(source.name) names ActionLabel more than once; each "
                                     + "use needs its own measured background rather than "
                                     + "inheriting this one's")
        }
    }

    /// The extension must not reach for the app-only spelling, which does not
    /// compile there and would not be caught by a colour test.
    func testTheShareExtensionDoesNotUseTheAppOnlySpellings() throws {
        for source in try swiftSources(under: try shareRoot) {
            for symbol in ["Palette.actionLabel", "borderedAction(", "textAction("]
                where Self.code(source.text).contains(symbol) {
                XCTFail("\(source.name) uses `\(symbol)`, which is declared in "
                        + "Components/ActionButton.swift — a file this target does not "
                        + "compile. Name the asset directly, as `cancelButton` does.")
            }
        }
    }

    /// The membership-exception list itself, so the file that owns the colour
    /// cannot be added to the extension's target without the colour.
    func testActionButtonIsNotCompiledIntoTheShareTargetWithoutItsAsset() throws {
        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")
        let shareCatalog = try RepoRoot.url().appendingPathComponent(
            "apps/ios/RelayiumShare/Assets.xcassets/ActionLabel.colorset/Contents.json")
        // The exception set is what pulls app-group files into the extension.
        XCTAssertTrue(project.contains("Components/DesignTokens.swift,"),
                      "the membership-exception set this guard reads is gone; re-derive it "
                      + "rather than deleting the guard")
        if project.contains("Components/ActionButton.swift,") {
            XCTAssertTrue(FileManager.default.fileExists(atPath: shareCatalog.path),
                          "Components/ActionButton.swift is now compiled into RelayiumShare, "
                          + "but that target ships no ActionLabel colourset for it to "
                          + "resolve")
        }
    }

    // MARK: - the audit that proves it on screen

    /// **The contrast check is audited, not subtracted.**
    ///
    /// It was `.all.subtracting(.contrast)` for as long as the suite existed,
    /// and three real Dark failures sat behind that subtraction. Restoring the
    /// subtraction is the cheapest way to make this batch's gate green again
    /// while giving back everything it bought, so it fails here.
    func testTheAccessibilityAuditStillRunsTheContrastCheck() throws {
        let suite = try RepoRoot.text("apps/ios/RelayiumUITests/AppShellUITests.swift")
        // Code only: the doc comment above `classification(of:dark:)` quotes the
        // old expression to record what it replaced.
        let code = Self.code(suite)
        XCTAssertFalse(code.contains("subtracting(.contrast)"),
                       "the contrast check has been subtracted from the accessibility audit "
                       + "again. Every finding it reports is either classified with a "
                       + "measured ratio or a defect; there is no third option that involves "
                       + "turning it off.")
        XCTAssertEqual(code.components(separatedBy: "performAccessibilityAudit(for: .all)").count - 1, 1,
                       "the audit should run every type the platform offers, from one place")
        XCTAssertTrue(suite.contains("func testEveryPrimaryTaskPassesTheSystemAccessibilityAudit()"),
                      "the Light audit is gone")
        XCTAssertTrue(suite.contains(
            "func testEveryPrimaryTaskPassesTheSystemAccessibilityAuditInDarkAppearance()"),
                      "the Dark audit is gone, and Dark is where this app's contrast "
                      + "defects were")
    }

    /// **The Dark audit's appearance actually takes.**
    ///
    /// `XCUIDevice.shared.appearance = .dark` returns without error on Xcode
    /// 26.6 / iOS 26 and changes nothing, which turned the first Dark run into a
    /// second Light run reporting Light findings under a Dark heading. The
    /// launch argument replaced it — and the two spellings live in two targets
    /// that cannot see each other, so a rename in one is a silent Light run in
    /// the other. This compares them.
    func testTheDarkAppearanceArgumentIsSpelledTheSameInBothTargets() throws {
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        let suite = try RepoRoot.text("apps/ios/RelayiumUITests/AppShellUITests.swift")
        let argument = "--relayium-ui-testing-dark-appearance"
        XCTAssertTrue(mode.contains("darkAppearanceArgument = \"\(argument)\""),
                      "the app no longer answers \(argument)")
        XCTAssertTrue(suite.contains("darkAppearanceArgument = \"\(argument)\""),
                      "the UI suite no longer sends \(argument), so its Dark audit would "
                      + "quietly run in Light")
        XCTAssertTrue(suite.contains("assertAppearanceTookEffect()"),
                      "the Dark audit no longer proves from a screenshot that it ran in "
                      + "Dark, which is the only thing that caught this the first time")
    }

    /// The seam is Debug-only and folds to `nil` in a shipped build, like every
    /// other argument in that file.
    func testTheForcedAppearanceSeamIsAbsentFromRelease() throws {
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        let debugHalf = mode.components(separatedBy: "#else").first ?? ""
        let releaseHalf = mode.components(separatedBy: "#else").dropFirst().joined()
        XCTAssertTrue(debugHalf.contains("darkAppearanceArgument"),
                      "the argument must be declared inside the Debug half")
        XCTAssertFalse(releaseHalf.contains("darkAppearanceArgument"),
                       "a shipped build must not carry the argument at all")
        XCTAssertTrue(releaseHalf.contains("static let forcedColorScheme: ColorScheme? = nil"),
                      "Release must fold the forced appearance to a constant nil, so no "
                      + "argument can change a shipped launch's appearance")
        let app = try RepoRoot.text("apps/ios/Relayium/RelayiumApp.swift")
        XCTAssertEqual(app.components(
            separatedBy: ".preferredColorScheme(UITestMode.forcedColorScheme)").count - 1, 1,
                       "the scene should apply the forced appearance from exactly one place")
    }

    // MARK: - reading a colourset

    private struct Manifest: Decodable {
        struct Appearance: Decodable { let appearance: String; let value: String }
        struct Components: Decodable {
            let red: String
            let green: String
            let blue: String
            let alpha: String
        }
        struct Colour: Decodable {
            let colorSpace: String?
            let components: Components
            enum CodingKeys: String, CodingKey { case colorSpace = "color-space", components }
        }
        struct Entry: Decodable {
            let idiom: String
            let appearances: [Appearance]?
            let color: Colour
        }
        let colors: [Entry]
    }

    private func manifest(_ relativePath: String) throws -> Manifest {
        let url = try RepoRoot.url(relativePath + "/Contents.json")
        return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: url))
    }

    private func colourset(_ path: String) throws -> (light: [UInt8], dark: [UInt8]) {
        let entries = try manifest(path).colors
        func bytes(_ entry: Manifest.Entry) throws -> [UInt8] {
            XCTAssertEqual(entry.color.colorSpace, "srgb",
                           "\(path) must stay sRGB; every ratio here was computed in it")
            XCTAssertEqual(entry.color.components.alpha, "1.000",
                           "\(path) must stay opaque; a translucent role composites against "
                           + "whatever is behind it and has no single measurable ratio")
            return try [entry.color.components.red, entry.color.components.green,
                        entry.color.components.blue].map {
                try XCTUnwrap(UInt8($0.replacingOccurrences(of: "0x", with: ""), radix: 16),
                              "\(path) carries a non-hex component `\($0)`")
            }
        }
        let light = try XCTUnwrap(entries.first { ($0.appearances ?? []).isEmpty },
                                  "\(path) has no universal entry")
        let dark = try XCTUnwrap(entries.first {
            ($0.appearances ?? []).contains { $0.appearance == "luminosity" && $0.value == "dark" }
        }, "\(path) has no dark entry")
        return (try bytes(light), try bytes(dark))
    }

    private func assertColourset(_ path: String,
                                 light: (UInt8, UInt8, UInt8),
                                 dark: (UInt8, UInt8, UInt8)) throws {
        let values = try colourset(path)
        XCTAssertEqual(values.light, [light.0, light.1, light.2],
                       "\(path) Light changed; every Light ratio recorded in this batch was "
                       + "measured at the old value")
        XCTAssertEqual(values.dark, [dark.0, dark.1, dark.2],
                       "\(path) Dark changed; every Dark ratio recorded in this batch — "
                       + "including the 4.91:1 that `AppShellUITests` classifies by name — "
                       + "was measured at the old value")
    }
}
