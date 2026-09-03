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

    /// **The accent's two ordinary values are unchanged, and this batch's whole
    /// approach depends on them staying that way.**
    ///
    /// Darkening either would fix the labels and break every fill: white on the
    /// current dark accent measures 5.6–5.7:1, and the tab bar, the switches,
    /// the selection and every `.borderedProminent` shape are drawn from it by
    /// the system for free.
    ///
    /// The asset has since gained a third entry — a Dark + Increase Contrast
    /// variant, measured and guarded in
    /// `testTheAccentColoursetDeclaresTheMeasuredDarkHighContrastVariant`. This
    /// test is deliberately blind to it: its whole job is that the two values
    /// every ratio in this file was measured at did not move while that variant
    /// was added.
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
        let path = "apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset"
        XCTAssertEqual(try entry(path, dark: false), [0x6D, 0x28, 0xD9],
                       "ActionLabel Light changed; every Light ratio recorded in this batch "
                       + "was measured at the old value")
        XCTAssertEqual(try entry(path, dark: false, increaseContrast: true), [0x5A, 0x21, 0xB4],
                       "ActionLabel Light + Increase Contrast changed; it exists because "
                       + "Increase Contrast DARKENS the bordered fill under it, from "
                       + "#DEDEE4 to #CFCFD5, and the ordinary Light value only cleared "
                       + "4.58:1 there")
        XCTAssertEqual(try entry(path, dark: true), [0xB4, 0x9C, 0xFB],
                       "ActionLabel Dark changed; every Dark ratio recorded in this batch — "
                       + "including the 4.91:1 that `AppShellUITests` classifies by name — "
                       + "was measured at the old value")
        XCTAssertEqual(try entry(path, dark: true, increaseContrast: true), [0xCB, 0xBA, 0xFC],
                       "ActionLabel Dark + Increase Contrast changed; it exists because "
                       + "Increase Contrast LIGHTENS the bordered fill under it, from "
                       + "#39393D to #46464A, which dropped the ordinary Dark value to "
                       + "4.07:1 — a real failure the Dark audit reproduced")
    }

    // MARK: - what Increase Contrast actually does to this role

    /// **The surfaces this role is drawn on, sampled off real screens.**
    ///
    /// Every number in this file is a ratio against one of these, and none of
    /// them is a system constant quoted from documentation: each is the modal
    /// pixel value of a full-screen capture of this app's Nearby tab, in each of
    /// the four appearances, taken on iPhone 17 / iOS 26.5.
    ///
    /// The four rows are the finding. Increase Contrast does not touch a named
    /// asset colour — `ActionLabel` renders identically with it on and off — but
    /// it moves every fill the system draws UNDER that colour, and it moves them
    /// in opposite directions in the two appearances:
    ///
    ///  * Light: the card goes `#F2F2F7` → `#EBEBF0` and the bordered fills go
    ///    `#E3E3E8`/`#DEDEE4` → `#D4D4DA`/`#CFCFD5`. Darker under dark text, so
    ///    the ratio FALLS: `#6D28D9` went from 5.30:1 to 4.58:1.
    ///  * Dark: the card goes `#1C1C1E` → `#242426` and the bordered fills go
    ///    `#313136`/`#39393D` → `#3E3E43`/`#46464A`. Lighter under light text,
    ///    so the ratio falls there too, and further: `#B49CFB` went from 4.98:1
    ///    to **4.07:1**, under the line.
    ///
    /// So "the ordinary value already clears it, and Increase Contrast only
    /// separates them further" — the reason the previous batch recorded for
    /// declaring no variant — was wrong in both appearances, and wrong by enough
    /// to fail in one. It is the direction of the FILL that decides this, not
    /// the direction of the setting.
    private static let surfaces: [String: [(String, UInt32)]] = [
        "Light": [("systemBackground", 0xFFFFFF), ("card", 0xF2F2F7),
                  ("bordered fill", 0xE3E3E8), ("deepest bordered fill", 0xDEDEE4)],
        "Light + Increase Contrast":
                 [("systemBackground", 0xFFFFFF), ("card", 0xEBEBF0),
                  ("bordered fill", 0xD4D4DA), ("deepest bordered fill", 0xCFCFD5)],
        "Dark": [("systemBackground", 0x000000), ("card", 0x1C1C1E),
                 ("bordered fill", 0x313136), ("lightest bordered fill", 0x39393D)],
        "Dark + Increase Contrast":
                [("systemBackground", 0x000000), ("card", 0x242426),
                 ("bordered fill", 0x3E3E43), ("lightest bordered fill", 0x46464A)],
    ]

    /// WCAG 2.x relative luminance, in sRGB.
    private func luminance(_ rgb: [UInt8]) -> Double {
        func channel(_ v: UInt8) -> Double {
            let s = Double(v) / 255
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
    }

    private func ratio(_ a: [UInt8], _ b: UInt32) -> Double {
        let other: [UInt8] = [UInt8((b >> 16) & 0xFF), UInt8((b >> 8) & 0xFF), UInt8(b & 0xFF)]
        let (x, y) = (luminance(a), luminance(other))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    private static func hex(_ rgb: [UInt8]) -> String {
        String(format: "#%02X%02X%02X", Int(rgb[0]), Int(rgb[1]), Int(rgb[2]))
    }

    /// The four declared appearances, addressed the way the catalog stores them.
    private func actionLabelAppearances() throws -> [(String, [UInt8])] {
        let path = "apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset"
        return [("Light", try entry(path, dark: false)),
                ("Light + Increase Contrast",
                 try entry(path, dark: false, increaseContrast: true)),
                ("Dark", try entry(path, dark: true)),
                ("Dark + Increase Contrast",
                 try entry(path, dark: true, increaseContrast: true))]
    }

    /// **All four appearances, against all four of their own surfaces,
    /// arithmetically.**
    ///
    /// Not "the asset has the value I wrote down" — the pin above already says
    /// that, and a careless edit updates a pin along with the colour. This
    /// recomputes relative luminance from the bytes actually in the catalog and
    /// fails on the number. A lightened role, a darkened surface, or a fifth
    /// appearance added with no measurement behind it all fail here.
    ///
    /// 4.5:1 rather than 3:1 because this role draws an action's WORDS. It also
    /// draws `PathRail`'s small meaningful graphics, which owe only 3:1 under
    /// WCAG 1.4.11 — so holding the whole role to the text line is the strictly
    /// stronger claim and covers both uses at once.
    func testEveryActionLabelAppearanceClearsTheLineOnItsOwnSurfaces() throws {
        for (appearance, value) in try actionLabelAppearances() {
            let surfaces = try XCTUnwrap(Self.surfaces[appearance],
                                         "no measured surfaces for \(appearance)")
            for (surface, background) in surfaces {
                let measured = ratio(value, background)
                XCTAssertGreaterThanOrEqual(
                    measured, 4.5,
                    "ActionLabel \(appearance) \(Self.hex(value)) measures "
                    + String(format: "%.3f", measured)
                    + ":1 on the \(surface) "
                    + String(format: "#%06X", background)
                    + ". An action's label is ordinary-sized text, so WCAG 1.4.3 asks "
                    + "4.5:1 and there is no large-text exemption available to it.")
            }
        }
    }

    /// **Increase Contrast must actually increase contrast.**
    ///
    /// Measured on the worst surface of each appearance rather than asserted as
    /// a hex value, so a variant that exists but does not help fails here. This
    /// is the guard against the failure mode with no symptom: a declared variant
    /// that leaves the setting a no-op still compiles, still renders, and looks
    /// answered.
    func testIncreaseContrastVariantsAreStrictlyStrongerThanTheOrdinaryValues() throws {
        let appearances = Dictionary(uniqueKeysWithValues: try actionLabelAppearances())
        for (ordinary, high) in [("Light", "Light + Increase Contrast"),
                                 ("Dark", "Dark + Increase Contrast")] {
            let worst = try XCTUnwrap(Self.surfaces[high]?.last?.1)
            let ordinaryValue = try XCTUnwrap(appearances[ordinary])
            let highValue = try XCTUnwrap(appearances[high])
            XCTAssertGreaterThan(
                ratio(highValue, worst), ratio(ordinaryValue, worst),
                "ActionLabel's \(high) value \(Self.hex(highValue)) is not stronger than "
                + "its ordinary \(ordinary) value \(Self.hex(ordinaryValue)) on the surface "
                + "that appearance actually paints. A variant that does not raise the ratio "
                + "is worse than none: it looks answered.")
        }
    }

    /// The premise of the two new variants, recomputed rather than quoted.
    ///
    /// If either ordinary value ever clears 4.5:1 on its own Increase Contrast
    /// surface, these variants stopped being necessary and this file should say
    /// so out loud instead of carrying two colours nobody re-derived.
    func testTheOrdinaryValuesReallyDoFallOnTheIncreaseContrastSurfaces() throws {
        let appearances = Dictionary(uniqueKeysWithValues: try actionLabelAppearances())
        let dark = try XCTUnwrap(appearances["Dark"])
        let darkWorst = try XCTUnwrap(Self.surfaces["Dark + Increase Contrast"]?.last?.1)
        XCTAssertLessThan(ratio(dark, darkWorst), 4.5,
                          "the ordinary Dark value now clears 4.5:1 on the Increase Contrast "
                          + "bordered fill; the Dark variant may no longer be needed")
        let light = try XCTUnwrap(appearances["Light"])
        let lightWorst = try XCTUnwrap(Self.surfaces["Light + Increase Contrast"]?.last?.1)
        XCTAssertLessThan(ratio(light, lightWorst), 5.0,
                          "the ordinary Light value now has real margin on the Increase "
                          + "Contrast bordered fill; the Light variant may no longer be needed")
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

    /// **All four appearances are declared, and none of them is a duplicate.**
    ///
    /// This replaces an assertion that the OPPOSITE was true. The previous batch
    /// wrote `testNeitherColoursetClaimsAnUnmeasuredHighContrastVariant` and
    /// recorded a reason: the ordinary Dark value already cleared the fills, and
    /// Increase Contrast separated them further. The first half was true only
    /// with the setting off, and the second half was backwards — Increase
    /// Contrast LIGHTENS a dark fill, and the Dark audit run with the setting on
    /// failed. So the absence is now the regression and the presence is the
    /// guard, which is why this test was inverted rather than deleted.
    ///
    /// A colourset that declares only some of the four still compiles and still
    /// renders; it just silently makes the accessibility setting a no-op for
    /// every control drawn in the role. Only the count and the shape are checked
    /// here — the values themselves are pinned and re-derived above.
    func testTheActionLabelColoursetDeclaresEveryAppearance() throws {
        for path in ["apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset",
                     "apps/ios/RelayiumShare/Assets.xcassets/ActionLabel.colorset"] {
            let entries = try manifest(path).colors
            XCTAssertEqual(entries.count, 4,
                           "\(path) should declare exactly four appearances — Light, Dark and "
                           + "an Increase Contrast variant of each — and got \(entries.count)")
            for entry in entries {
                for appearance in entry.appearances ?? [] {
                    XCTAssertTrue(["luminosity", "contrast"].contains(appearance.appearance),
                                  "\(path) gained a `\(appearance.appearance)` appearance, "
                                  + "which needs a measured ratio behind it on the surfaces "
                                  + "that appearance actually renders on; add the measurement "
                                  + "with the value.")
                }
            }
            var seen = Set<[Bool]>()
            for dark in [false, true] {
                for high in [false, true] {
                    _ = try entry(path, dark: dark, increaseContrast: high)
                    seen.insert([dark, high])
                }
            }
            XCTAssertEqual(seen.count, 4, "\(path) is missing an appearance combination")
        }
    }

    /// **The accent now declares three, and the third one is the fix.**
    ///
    /// This test used to assert the opposite — that `AccentColor` carried only
    /// its two luminosities — and it recorded why it would have to be inverted
    /// one day. That day is this batch, so it is inverted rather than deleted,
    /// and the measurement it recorded is kept verbatim because it is the
    /// evidence the new value answers.
    ///
    /// `.borderedProminent` does not render the accent literally when Increase
    /// Contrast is on and the colourset declares no high-contrast entry: it
    /// derives a fill, in opposite directions in the two appearances — measured
    /// `#7C3AED` → `#B488FF` in Dark and `#6D28D9` → `#461A8B` in Light, off
    /// full-screen captures on iPhone 17 / iOS 26.5. The system's own white
    /// label on the Dark one measures **2.66:1**, down from 5.70:1 with the
    /// setting off; Light IMPROVES, to 11.79:1. That asymmetry is why the Dark +
    /// Increase Contrast audit reported `Choose Files or Folders…`, `Go to
    /// Account` and `Sign in`, and the Light one reported nothing — and it is
    /// why only Dark gains a variant. A Light variant would be a colour added to
    /// answer a ratio that already measures 11.79:1.
    ///
    /// **Declaring the entry takes the derivation back, and that is measured
    /// rather than assumed.** A capture of this app under Dark + Increase
    /// Contrast with the entry declared renders the prominent fill as the
    /// declared bytes exactly — 139,029 pixels of them under a pure `#FFFFFF`
    /// label, no derived value anywhere on screen. That is the fact the whole
    /// approach rests on: if the style had derived from the declared value too,
    /// every arithmetic test in this file would still pass while the button on
    /// screen stayed at 2.66:1.
    ///
    /// **The value is the system's own Light rule, applied to the Dark value.**
    /// `#7C3AED` × 0.642 — the exact factor iOS uses to derive `#461A8B` from
    /// `#6D28D9` in Light + Increase Contrast — is `#502598`, which carries the
    /// white label at **10.20:1**. The bar it has to clear is 7:1 rather than
    /// 4.5:1, and both of those numbers were bracketed by running the audit
    /// rather than read anywhere;
    /// `testTheDarkHighContrastAccentClearsTheRaisedIncreaseContrastBar` carries
    /// the four rendered points that fix it, including the two candidates that
    /// cleared 4.5:1 and were rejected anyway.
    ///
    /// The cost is recorded rather than hidden: at 2.06:1 against black the
    /// button stands off the screen behind it less than the ordinary Dark accent
    /// does. That is the same trade iOS itself makes in Light, where its derived
    /// `#461A8B` is a very dark button on white — under this setting the words
    /// win. Ordinary Light and Dark are untouched, which
    /// `testTheAccentColorsetIsUnchanged` asserts separately.
    func testTheAccentColoursetDeclaresTheMeasuredDarkHighContrastVariant() throws {
        for path in ["apps/ios/Relayium/Assets.xcassets/AccentColor.colorset",
                     "apps/ios/RelayiumShare/Assets.xcassets/AccentColor.colorset"] {
            let entries = try manifest(path).colors
            XCTAssertEqual(entries.count, 3,
                           "\(path) should carry exactly universal + dark + dark/high "
                           + "contrast, and got \(entries.count). Light needs no variant: "
                           + "the derivation the setting applies there raises the white "
                           + "label to 11.79:1 on its own.")
            XCTAssertEqual(try entry(path, dark: true, increaseContrast: true),
                           [0x50, 0x25, 0x98],
                           "\(path) Dark + Increase Contrast changed. It exists because the "
                           + "prominent fill derived from the ordinary Dark accent measured "
                           + "#B488FF with the setting on, and the system's white label on "
                           + "that measured 2.66:1 — a failure the Dark audit reproduced on "
                           + "three buttons. Re-measure both of its ratios before moving it: "
                           + "the band it sits in is 0.03 of relative luminance wide.")
            // The variant must not have arrived by moving the two values every
            // other ratio in this batch was measured at.
            XCTAssertEqual(try entry(path, dark: false), [0x6D, 0x28, 0xD9],
                           "\(path) Light moved while the Increase Contrast variant was "
                           + "added")
            XCTAssertEqual(try entry(path, dark: true), [0x7C, 0x3A, 0xED],
                           "\(path) Dark moved while the Increase Contrast variant was "
                           + "added")
        }
    }

    /// **The bar the audit actually enforces here is 7:1, and it was found by
    /// measurement rather than read anywhere.**
    ///
    /// The checker reports `Contrast failed for SwiftUI.AccessibilityNode` and
    /// no arithmetic, so the threshold had to be bracketed by running it. Four
    /// rendered points did it, all on this app's own prominent buttons:
    ///
    /// | fill | white label | Increase Contrast | audit |
    /// | --- | --- | --- | --- |
    /// | `#7C3AED` ordinary Dark | 5.70:1 | off | accepted |
    /// | `#B488FF` derived | 2.66:1 | on | rejected |
    /// | `#8946FD` | 4.82:1 | on | rejected |
    /// | `#6F24F0` | 6.59:1 | on | rejected |
    ///
    /// 5.70:1 passes with the setting off and 6.59:1 fails with it on, so the
    /// line moves when the user asks for more contrast, and it moves to
    /// somewhere above 6.59 — WCAG's AAA 7:1, which is the only published
    /// number in that gap. `#502598` clears it at **10.20:1**.
    ///
    /// The two rejected candidates are kept in the table because each killed a
    /// theory that looked right: `#6F24F0` was chosen to maximise the label and
    /// `#8946FD` to satisfy a 3:1 shape line as well, and the audit rejected
    /// both. Whatever the checker weighs, it is not the fill against the card:
    /// `#8946FD` measured 3.22:1 there, better than the ordinary Dark accent's
    /// 2.72:1, which the audit accepts with the setting off.
    func testTheDarkHighContrastAccentClearsTheRaisedIncreaseContrastBar() throws {
        let value = try entry("apps/ios/Relayium/Assets.xcassets/AccentColor.colorset",
                              dark: true, increaseContrast: true)
        let onWhite = ratio(value, 0xFFFFFF)
        XCTAssertGreaterThanOrEqual(
            onWhite, 7.0,
            "the Dark + Increase Contrast accent \(Self.hex(value)) leaves the system's "
            + "white prominent label at " + String(format: "%.3f", onWhite)
            + ":1. 4.5:1 is not enough here: the audit accepted 5.70:1 with the setting "
            + "off and rejected 6.59:1 with it on, so this role owes the AAA 7:1 line "
            + "whenever the user has asked for increased contrast.")
    }

    /// **Increase Contrast must actually increase contrast, and for this fill
    /// the ratio that has to rise is the label's.**
    ///
    /// Which direction that means was not obvious and is not symmetric with
    /// `ActionLabel`. The answer came from watching what iOS does to this same
    /// asset in the appearance where its own derivation is CORRECT: in Light +
    /// Increase Contrast it darkens `#6D28D9` to `#461A8B`, a factor of 0.642,
    /// taking the white label from 5.30:1 to 11.79:1. It maximises the label.
    ///
    /// In Dark it does the opposite — lightens `#7C3AED` to `#B488FF` and drops
    /// the label to 2.66:1 — which is the defect. So the declared Dark variant
    /// is the Light rule applied to the Dark value: `#7C3AED` times that same
    /// 0.642 is `#502598`, hue held at 261.7° against the accent's 262.1°. Not a
    /// colour picked to clear a threshold, but the system's own answer to this
    /// question, taken from the half of it the system gets right.
    func testTheDarkHighContrastAccentCarriesWhiteBetterThanTheOrdinaryDark() throws {
        let path = "apps/ios/Relayium/Assets.xcassets/AccentColor.colorset"
        let ordinary = try entry(path, dark: true)
        let high = try entry(path, dark: true, increaseContrast: true)
        XCTAssertGreaterThan(
            ratio(high, 0xFFFFFF), ratio(ordinary, 0xFFFFFF),
            "the Dark + Increase Contrast accent \(Self.hex(high)) does not carry the "
            + "system's white label better than the ordinary Dark accent "
            + "\(Self.hex(ordinary)) does. A variant that does not raise the ratio the "
            + "setting exists to raise is worse than none: it looks answered.")
    }

    /// One brand is one value, in the extension too — and the extension draws
    /// its own `.borderedProminent` Send from the same asset, so a Share sheet
    /// that kept the two-entry catalog would keep the 2.66:1 label the app just
    /// fixed. Byte-for-byte, for the reason the `ActionLabel` twin records: a
    /// value comparison cannot see a dropped appearance.
    func testTheShareExtensionAccentIsByteIdenticalToTheApp() throws {
        let app = try RepoRoot.text(
            "apps/ios/Relayium/Assets.xcassets/AccentColor.colorset/Contents.json")
        let share = try RepoRoot.text(
            "apps/ios/RelayiumShare/Assets.xcassets/AccentColor.colorset/Contents.json")
        XCTAssertEqual(app, share,
                       "AccentColor.colorset differs between the app and the Share "
                       + "extension. The extension resolves its own copy, so a variant "
                       + "declared only in the app leaves the share sheet on the derived "
                       + "#B488FF fill and its white label at 2.66:1.")
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
        // Byte-for-byte rather than value-for-value, and that distinction is the
        // whole reason this assertion changed shape. Comparing Light and Dark
        // alone passed a Share copy that had silently lost either Increase
        // Contrast entry — the appearances are half the content of this file
        // now, and the half a colour comparison cannot see.
        let app = try RepoRoot.text(
            "apps/ios/Relayium/Assets.xcassets/ActionLabel.colorset/Contents.json")
        let share = try RepoRoot.text(
            "apps/ios/RelayiumShare/Assets.xcassets/ActionLabel.colorset/Contents.json")
        XCTAssertEqual(app, share,
                       "ActionLabel.colorset differs between the app and the Share "
                       + "extension. One brand is one value, and a share sheet that renders "
                       + "a different violet — or drops an Increase Contrast variant the app "
                       + "keeps — is a share sheet that looks like somebody else's app, "
                       + "inside somebody else's app.")

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

    /// Reads ONE appearance out of a colourset, addressed by both axes.
    ///
    /// Deliberately matches on `luminosity` AND `contrast` together rather than
    /// asking "does this entry mention dark". The looser spelling this replaces
    /// was correct only while no colourset declared an Increase Contrast
    /// variant: the moment `ActionLabel` gained one, `first { mentions dark }`
    /// could return the Dark+Increase-Contrast entry and every "Dark is
    /// unchanged" assertion in this file would have been checking the wrong
    /// four bytes — and passing.
    private func entry(_ path: String,
                       dark: Bool,
                       increaseContrast: Bool = false) throws -> [UInt8] {
        let entries = try manifest(path).colors
        let match = try XCTUnwrap(entries.first { candidate in
            let appearances = candidate.appearances ?? []
            let isDark = appearances.contains {
                $0.appearance == "luminosity" && $0.value == "dark"
            }
            let isHigh = appearances.contains {
                $0.appearance == "contrast" && $0.value == "high"
            }
            return isDark == dark && isHigh == increaseContrast
        }, "\(path) declares no entry for dark=\(dark) increaseContrast=\(increaseContrast)")
        XCTAssertEqual(match.color.colorSpace, "srgb",
                       "\(path) must stay sRGB; every ratio here was computed in it")
        XCTAssertEqual(match.color.components.alpha, "1.000",
                       "\(path) must stay opaque; a translucent role composites against "
                       + "whatever is behind it and has no single measurable ratio")
        return try [match.color.components.red, match.color.components.green,
                    match.color.components.blue].map {
            try XCTUnwrap(UInt8($0.replacingOccurrences(of: "0x", with: ""), radix: 16),
                          "\(path) carries a non-hex component `\($0)`")
        }
    }

    private func colourset(_ path: String) throws -> (light: [UInt8], dark: [UInt8]) {
        (try entry(path, dark: false), try entry(path, dark: true))
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
