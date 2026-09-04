import Foundation
import XCTest

/// **The boundary between prose and graphics, made executable.**
///
/// The iOS app wrote roughly a hundred and twenty supporting sentences — every
/// explanation, caption, detail line, timestamp and byte count — in SwiftUI's
/// `.secondary`. In Light that role is `#3C3C43` at 60%, which composites to
/// `#8A8A8E` on white and `#85858B` on `Palette.cardBackground`, and measures
/// **3.44:1** and **3.29:1** against them. WCAG 1.4.3 asks 4.5:1 for text this
/// size and none of it is large enough for the 3:1 exemption, so the whole
/// second layer of the app's reading was below the line.
///
/// Two smaller failures came out of the same audit. The composer's over-limit
/// byte counter and the transcript's "not sent" label were `Color.orange` —
/// `#FF9500` in Light, **2.20:1** on white, the least readable text in the
/// product. Being redundant with a symbol is what makes the SYMBOL accessible;
/// it does nothing for the sentence beside it.
///
/// So there are now two named roles, `SupportingLabel` and `WarningLabel`, and
/// the system role keeps exactly the uses WCAG measures as graphics or not at
/// all: a decorative glyph, a disclosure chevron, a pending path marker, an
/// unselected checkbox, a control tint.
///
/// ## Why these are source guards
///
/// The UI audit in `AppShellUITests` walks six surfaces and can only judge what
/// it renders. It cannot see the hundred and thirteen sentences on the screens
/// it does not visit, it cannot see a role written correctly today and reverted
/// in a refactor, and it cannot see an asset that resolves in one bundle and not
/// the other — that one renders BLACK rather than failing, which no contrast
/// checker reports as a defect.
///
/// Each guard below is written so that the plausible regression fails: a new
/// naked `.secondary` on a sentence, a role quietly darkened past the value its
/// ratios were computed at, an Increase Contrast variant dropped so the
/// accessibility setting silently becomes a no-op, a Share catalog that drifts
/// from the app's.
final class IOSSupportingTextGuardTests: XCTestCase {

    // MARK: - the appearances, and what each one has to clear

    /// A colour role, as the asset catalog declares it.
    private struct Role {
        let name: String
        /// Light, Light+Increase Contrast, Dark, Dark+Increase Contrast.
        let light: RGB, lightHigh: RGB, dark: RGB, darkHigh: RGB
    }

    private struct RGB: Equatable, CustomStringConvertible {
        let r: Double, g: Double, b: Double
        init(_ r: Double, _ g: Double, _ b: Double) { (self.r, self.g, self.b) = (r, g, b) }
        init(hex: UInt32) {
            self.init(Double((hex >> 16) & 0xFF), Double((hex >> 8) & 0xFF), Double(hex & 0xFF))
        }
        var description: String {
            String(format: "#%02X%02X%02X", Int(r.rounded()), Int(g.rounded()), Int(b.rounded()))
        }
    }

    /// WCAG 2.x relative luminance, in sRGB.
    private func luminance(_ c: RGB) -> Double {
        func channel(_ v: Double) -> Double {
            let s = v / 255
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }

    private func ratio(_ a: RGB, _ b: RGB) -> Double {
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    /// Source-over compositing, which is what a translucent fill on a background
    /// actually is. Deliberately NOT rounded to 8 bits: the renderer composites
    /// in float and a screenshot quantizes afterwards, and doing it here in
    /// float is the more conservative of the two — every ratio below is between
    /// 0.02 and 0.05 LOWER than the quantized value a pixel measurement returns.
    private func over(_ fg: RGB, alpha: Double, _ bg: RGB) -> RGB {
        RGB(fg.r * alpha + bg.r * (1 - alpha),
            fg.g * alpha + bg.g * (1 - alpha),
            fg.b * alpha + bg.b * (1 - alpha))
    }

    /// **The three background classes this app actually draws supporting text
    /// on**, in each appearance. Nothing here is a guess: each one is a system
    /// colour this codebase names, or a composite of one over another.
    ///
    ///  * `systemBackground` — a screen with no card, and what the Share sheet
    ///    presents on.
    ///  * `secondarySystemBackground` — `Palette.cardBackground`, which is where
    ///    most of this app's prose sits, and the darker of the two in Light.
    ///  * the quaternary composite — `.quaternary.opacity(0.35)` inside a card,
    ///    the deepest fill in the app, under the transcript's direction labels
    ///    and the file lists' byte counts. SwiftUI's `.quaternary` is
    ///    `quaternaryLabel`: `#3C3C43` at 18% in Light, `#EBEBF5` at 16% in
    ///    Dark. Times the 0.35 the call sites apply, over the card.
    ///
    /// The Light quaternary composite is the binding constraint — it is DARKER
    /// than the card, so it is the surface a Light text colour has least room
    /// against, and it is the one an audit that only ever looked at white would
    /// have missed.
    private var lightBackgrounds: [(String, RGB)] {
        let white = RGB(hex: 0xFFFFFF)
        let card = RGB(hex: 0xF2F2F7)
        let quaternary = over(RGB(hex: 0x3C3C43), alpha: 0.18 * 0.35, card)
        return [("systemBackground", white),
                ("secondarySystemBackground", card),
                (".quaternary.opacity(0.35) over the card", quaternary)]
    }

    private var darkBackgrounds: [(String, RGB)] {
        let black = RGB(hex: 0x000000)
        let card = RGB(hex: 0x1C1C1E)
        let quaternary = over(RGB(hex: 0xEBEBF5), alpha: 0.16 * 0.35, card)
        return [("systemBackground", black),
                ("secondarySystemBackground", card),
                (".quaternary.opacity(0.35) over the card", quaternary)]
    }

    private static let minimum = 4.5

    /// **A surface class this role does NOT currently sit on, recorded because
    /// it was measured rather than assumed.**
    ///
    /// Sampling the rendered Light screens for long-run fills found two real
    /// surfaces darker than the quaternary composite above: `#E3E3E8` and
    /// `#DEDEE4`, the `.bordered` control fills. `#66666C` measures **4.46:1**
    /// and **4.26:1** on them — under the line.
    ///
    /// It is not a defect today, and the same pixel scan is what establishes
    /// that: no `#66666C` pixel in any captured screen has either colour within
    /// 45px of it. Those fills carry `Palette.actionLabel`, which is the role
    /// that owns a control's words; supporting prose is never drawn inside one.
    ///
    /// It is recorded here rather than left in a log because it is the shape of
    /// the next regression: a supporting sentence moved inside a bordered
    /// control would land at 4.26:1 and no guard in this file would see it —
    /// the arithmetic above would still pass, because the surface is not one of
    /// this role's. Closing it means darkening Light to about `#606066` and
    /// lightening Dark to about `#A5A5AD`, which clears every fill the app
    /// paints in either appearance. That is a palette change with its own
    /// evidence, deliberately not folded into this batch.

    // MARK: - every declared value clears the line

    /// **The guard the whole file exists for.**
    ///
    /// Not "the asset has the value I wrote down" — that is a tautology a
    /// careless edit updates along with the colour. This recomputes WCAG
    /// relative luminance for every appearance the catalog declares, against
    /// every background class the app draws that appearance on, and fails on the
    /// arithmetic. A darkened background, a lightened role or a new appearance
    /// with no measurement behind it all fail here.
    func testEveryDeclaredAppearanceClearsFourAndAHalfToOne() throws {
        for role in try roles() {
            for (label, value) in [("Light", role.light), ("Light + Increase Contrast", role.lightHigh)] {
                for (surface, background) in lightBackgrounds {
                    let measured = ratio(value, background)
                    XCTAssertGreaterThanOrEqual(
                        measured, Self.minimum,
                        "\(role.name) \(label) \(value) measures "
                        + String(format: "%.3f", measured)
                        + ":1 on \(surface) \(background). Supporting and warning prose is "
                        + "ordinary-sized text, so WCAG 1.4.3 asks 4.5:1 and there is no "
                        + "large-text exemption available to it.")
                }
            }
            for (label, value) in [("Dark", role.dark), ("Dark + Increase Contrast", role.darkHigh)] {
                for (surface, background) in darkBackgrounds {
                    let measured = ratio(value, background)
                    XCTAssertGreaterThanOrEqual(
                        measured, Self.minimum,
                        "\(role.name) \(label) \(value) measures "
                        + String(format: "%.3f", measured)
                        + ":1 on \(surface) \(background)")
                }
            }
        }
    }

    /// **Increase Contrast must actually increase contrast.**
    ///
    /// This is the guard against the failure mode that has no symptom. A named
    /// asset only tracks the accessibility setting if the catalog DECLARES the
    /// variant; one that does not still compiles, still renders, and silently
    /// makes the setting a no-op on every sentence in the app — which is a
    /// regression against the system role it replaced, because `Color.secondary`
    /// tracked it for free.
    ///
    /// So the variant has to exist and it has to be stronger, measured on the
    /// worst surface of its own appearance rather than asserted as a hex value.
    func testIncreaseContrastVariantsAreStrictlyStronger() throws {
        for role in try roles() {
            let lightWorst = try XCTUnwrap(lightBackgrounds.last?.1)
            let darkWorst = try XCTUnwrap(darkBackgrounds.last?.1)
            XCTAssertGreaterThan(
                ratio(role.lightHigh, lightWorst), ratio(role.light, lightWorst),
                "\(role.name)'s Light Increase Contrast value \(role.lightHigh) is not "
                + "stronger than its ordinary Light value \(role.light). A variant that "
                + "does not raise the ratio is worse than none: it looks answered.")
            XCTAssertGreaterThan(
                ratio(role.darkHigh, darkWorst), ratio(role.dark, darkWorst),
                "\(role.name)'s Dark Increase Contrast value \(role.darkHigh) is not "
                + "stronger than its ordinary Dark value \(role.dark)")
        }
    }

    /// The roles keep their hierarchy: supporting prose stays QUIETER than the
    /// primary label it sits under.
    ///
    /// The brief was to fix contrast without changing visual hierarchy, and the
    /// cheap way to pass a contrast gate is to stop having a second level at
    /// all. This says the second level still exists.
    func testSupportingProseStaysQuieterThanPrimaryLabel() throws {
        let role = try self.role("SupportingLabel")
        let lightPrimary = RGB(hex: 0x000000)   // `label`, Light
        let darkPrimary = RGB(hex: 0xFFFFFF)    // `label`, Dark
        let white = RGB(hex: 0xFFFFFF), black = RGB(hex: 0x000000)
        XCTAssertLessThan(ratio(role.light, white), ratio(lightPrimary, white),
                          "SupportingLabel is as loud as the primary label in Light; the "
                          + "contrast fix was supposed to keep the second reading level, "
                          + "not delete it")
        XCTAssertLessThan(ratio(role.dark, black), ratio(darkPrimary, black),
                          "SupportingLabel is as loud as the primary label in Dark")
    }

    /// The values that were actually measured, pinned.
    ///
    /// Every ratio recorded in `DesignTokens` and in this batch's evidence is a
    /// fact about these eight numbers. The arithmetic guards above would pass a
    /// different-but-still-legal palette; this one says that changing the
    /// palette is a deliberate act that has to come with fresh measurement.
    func testTheRoleValuesArePinnedToWhatWasMeasured() throws {
        let supporting = try role("SupportingLabel")
        XCTAssertEqual(supporting.light, RGB(hex: 0x66666C), "SupportingLabel Light")
        XCTAssertEqual(supporting.lightHigh, RGB(hex: 0x4A4A50), "SupportingLabel Light HC")
        XCTAssertEqual(supporting.dark, RGB(hex: 0x98989F), "SupportingLabel Dark")
        XCTAssertEqual(supporting.darkHigh, RGB(hex: 0xC6C6CE), "SupportingLabel Dark HC")
        let warning = try role("WarningLabel")
        XCTAssertEqual(warning.light, RGB(hex: 0x9A4C00), "WarningLabel Light")
        XCTAssertEqual(warning.lightHigh, RGB(hex: 0x7A3D00), "WarningLabel Light HC")
        // Dark orange was never the failure — it measures 7.19:1 on the deepest
        // dark surface — so the system's own pair is kept rather than moved for
        // the sake of symmetry.
        XCTAssertEqual(warning.dark, RGB(hex: 0xFF9F0A), "WarningLabel Dark")
        XCTAssertEqual(warning.darkHigh, RGB(hex: 0xFFB340), "WarningLabel Dark HC")
    }

    /// The roles this batch replaced, and the numbers that made them defects.
    ///
    /// Recomputed rather than quoted, so the premise of the whole change stays
    /// checkable: if any of these ever measured 4.5:1, the batch was wrong.
    func testTheReplacedSystemRolesReallyWereBelowTheLine() throws {
        let card = RGB(hex: 0xF2F2F7)
        let secondaryOnWhite = over(RGB(hex: 0x3C3C43), alpha: 0.6, RGB(hex: 0xFFFFFF))
        let secondaryOnCard = over(RGB(hex: 0x3C3C43), alpha: 0.6, card)
        XCTAssertLessThan(ratio(secondaryOnWhite, RGB(hex: 0xFFFFFF)), Self.minimum,
                          "Light `.secondary` on white now clears 4.5:1; if the platform "
                          + "changed the role, these two assets may no longer be needed")
        XCTAssertLessThan(ratio(secondaryOnCard, card), Self.minimum,
                          "Light `.secondary` on the card now clears 4.5:1")
        XCTAssertLessThan(ratio(RGB(hex: 0xFF9500), RGB(hex: 0xFFFFFF)), Self.minimum,
                          "Light `Color.orange` on white now clears 4.5:1")
    }

    // MARK: - the two catalogs agree

    /// **The failure that renders instead of erroring.**
    ///
    /// `Palette.supportingLabel` and `Palette.warningLabel` are declared in
    /// `Components/DesignTokens.swift`, and `project.pbxproj` compiles that file
    /// into `RelayiumShare` as well as the app. So both symbols EXIST in the
    /// extension, and `Color("…")` resolves against `Bundle.main` — which inside
    /// an app extension is the extension's own bundle. A role shipped in only
    /// the app's catalog therefore compiles everywhere and resolves in one
    /// place, and the other place draws it black.
    ///
    /// `WarningLabel` is the live case rather than a hypothetical one:
    /// `Components/InlineMessage.swift` is on that same shared-compile list and
    /// `ShareRootView` presents `InlineMessage(.warning, …)` twice, so the
    /// extension really does render that role at runtime.
    ///
    /// Byte-for-byte rather than value-for-value, because the appearances are
    /// half the content and a copy that kept the Light value while losing the
    /// Increase Contrast entry would pass any comparison of colours alone.
    func testBothRolesShipIdenticallyInBothBundles() throws {
        for name in ["SupportingLabel", "WarningLabel"] {
            let app = try RepoRoot.text(of: try RepoRoot.url(
                "apps/ios/Relayium/Assets.xcassets/\(name).colorset/Contents.json"))
            let share = try RepoRoot.text(of: try RepoRoot.url(
                "apps/ios/RelayiumShare/Assets.xcassets/\(name).colorset/Contents.json"))
            XCTAssertEqual(app, share,
                           "\(name).colorset differs between the app and the Share "
                           + "extension. Both targets compile the symbol that names it, so "
                           + "the copy that is missing or stale does not fail to build — it "
                           + "renders the wrong colour, or black, inside somebody else's app.")
        }
    }

    /// The Share extension actually uses the role, in both of its paragraphs.
    ///
    /// Shipping the asset and not reaching for it is the other half of the same
    /// bug, and it is equally invisible: the sheet keeps rendering, at 3.44:1.
    func testTheShareExtensionUsesTheSupportingRole() throws {
        let view = try Self.code(RepoRoot.text(of: try RepoRoot.url(
            "apps/ios/RelayiumShare/ShareRootView.swift")))
        XCTAssertFalse(view.contains(".foregroundStyle(.secondary)"),
                       "ShareRootView still writes a sentence in the system secondary role")
        XCTAssertEqual(view.components(separatedBy: "Palette.supportingLabel").count - 1, 2,
                       "ShareRootView should draw both of its supporting paragraphs — the "
                       + "item count and the state sentence — in the supporting role")
    }

    // MARK: - no naked system role survives on prose

    /// The classification vocabulary. Every one is a NON-TEXT use, which is why
    /// it is allowed to keep a role that measures 3.29:1 as text: WCAG 1.4.11
    /// asks 3:1 of a meaningful graphic and asks nothing at all of a decorative
    /// one, and every entry here is one or the other.
    private static let allowedSecondaryRoles: Set<String> = [
        "chevron",          // a disclosure indicator
        "symbol",           // a glyph whose meaning is also in words beside it
        "selection-state",  // state also carried by shape, not colour alone
    ]
    // There is deliberately no `control-tint` entry, and its absence is a
    // finding rather than an omission. `NearbyView`'s "How it works" disclosure
    // carried exactly that classification through a source audit — and the Light
    // system audit then rendered it and reported the sentence, because `.tint`
    // on a `DisclosureGroup` colours the LABEL as well as the chevron. A tint is
    // not reliably non-text, so it does not get a way to say that it is.

    /// **Every surviving `.secondary` is classified, by semantics, in place.**
    ///
    /// Written as a marker comment next to the use rather than as a list of file
    /// and line numbers in this file. A line-number list is wrong the first time
    /// anybody inserts a line above it, and it puts the reason in a different
    /// file from the code it excuses — so the next person to touch that view
    /// never reads it.
    ///
    /// The rule is total: a `.secondary` in iOS source either carries a
    /// `secondary-role:` marker naming one of the non-text classifications
    /// above, or it is prose that should be `Palette.supportingLabel`. There is
    /// no third answer, and a new sentence written the old way fails here.
    func testEverySurvivingSecondaryUseIsClassifiedAsNonText() throws {
        var classified: [String: String] = [:]
        for source in try iOSSources() {
            let lines = source.text.components(separatedBy: "\n")
            for (index, line) in lines.enumerated() {
                guard !Self.isComment(line), Self.mentionsSecondary(line) else { continue }
                let site = "\(source.name):\(index + 1)"
                guard let kind = Self.marker("secondary-role:", above: index, in: lines) else {
                    XCTFail("\(site) uses the system secondary role with no classification: "
                            + "`\(line.trimmingCharacters(in: .whitespaces))`. If it is prose, "
                            + "it must be `Palette.supportingLabel` — the system role measures "
                            + "3.29:1 on this app's cards. If it is a graphic or a control's "
                            + "chrome, say which with a `// secondary-role: <kind>` comment "
                            + "above it, from \(Self.allowedSecondaryRoles.sorted()).")
                    continue
                }
                XCTAssertTrue(Self.allowedSecondaryRoles.contains(kind),
                              "\(site) claims the unknown classification `\(kind)`. The "
                              + "vocabulary is deliberately closed and non-text: "
                              + "\(Self.allowedSecondaryRoles.sorted()).")
                classified[site] = kind
            }
        }
        // The count is asserted, not merely tallied. `>=` would let the set grow
        // one convenient reclassification at a time, which is how a semantic
        // exclusion list becomes a suppression list.
        XCTAssertEqual(classified.count, 6,
                       "the app had exactly six non-text secondary uses when this boundary "
                       + "was drawn — a decorative empty-state glyph, an info icon, a "
                       + "pending path marker, a disclosure chevron, a transfer symbol and "
                       + "an unselected checkbox. Adding a seventh is allowed, but it has "
                       + "to be looked at: found \(classified.sorted { $0.key < $1.key }).")
    }

    /// **No warning prose is left in the system orange.**
    ///
    /// Absolute rather than classified, because unlike `.secondary` there is no
    /// legitimate remaining use: the two prose sites needed the fix, and the
    /// three `exclamationmark.triangle.fill` symbols beside them took the role
    /// too. Not because a redundant glyph owes 4.5:1 — it does not — but because
    /// one of them shares an `HStack` with the counter it warns about, and two
    /// different oranges inside one warning is the state the dark-action batch
    /// recorded as worse than being uniformly wrong.
    func testNoSystemOrangeSurvivesInIOSSource() throws {
        for source in try iOSSources() {
            for (index, line) in Self.code(source.text).components(separatedBy: "\n").enumerated()
            where line.contains(".orange") {
                XCTFail("\(source.name) line \(index + 1) still uses the system orange: "
                        + "`\(line.trimmingCharacters(in: .whitespaces))`. It measures 2.20:1 "
                        + "on white; use `Palette.warningLabel`.")
            }
        }
    }

    /// Both roles are actually reached for, and at the scale the audit found.
    ///
    /// A guard that only bans the old spelling passes trivially on a file that
    /// deleted the text. This says the prose is still there and still styled.
    func testBothRolesAreAppliedAtTheScaleTheAuditFound() throws {
        var supporting = 0, warning = 0
        for source in try iOSSources() {
            let code = Self.code(source.text)
            supporting += code.components(separatedBy: "Palette.supportingLabel").count - 1
            warning += code.components(separatedBy: "Palette.warningLabel").count - 1
        }
        // 119 in the app and 2 in the Share extension. The declarations
        // themselves are not counted: `DesignTokens` spells the property name
        // without the `Palette.` prefix, which is what makes this a count of
        // USES rather than of mentions.
        XCTAssertEqual(supporting, 121,
                       "the supporting role should reach every one of the 120 sentences the "
                       + "audit counted across both targets, plus the disclosure tint that "
                       + "draws a 121st")
        // The over-limit byte counter, the not-sent label, and the three
        // `exclamationmark.triangle.fill` symbols that accompany them.
        XCTAssertEqual(warning, 5,
                       "the warning role should reach the byte counter, the not-sent label "
                       + "and the three symbols beside them")
    }

    /// The roles are declared once, where the vocabulary lives, and nowhere is
    /// their hex value written into Swift.
    ///
    /// `DesignTokens` says out loud that it contains "no hex value anywhere",
    /// and that sentence is what makes the asset catalog the single place the
    /// appearances are answered. A literal in source answers exactly one of the
    /// four.
    func testTheRolesHaveOneDeclarationAndNoLiteralInSource() throws {
        var declarations = 0
        for source in try iOSSources() {
            let code = Self.code(source.text)
            declarations += code.components(
                separatedBy: "static var supportingLabel: Color").count - 1
            declarations += code.components(
                separatedBy: "static var warningLabel: Color").count - 1
            for hex in ["0x66666C", "0x98989F", "0x9A4C00", "0xFF9F0A",
                        "66666C", "98989F", "9A4C00", "FF9F0A"] where code.contains(hex) {
                XCTFail("\(source.name) writes the role value `\(hex)` as a literal. The "
                        + "catalog is where the four appearances are answered; a literal "
                        + "answers one of them and silently drops Increase Contrast.")
            }
        }
        XCTAssertEqual(declarations, 2,
                       "each role should be declared exactly once, in "
                       + "`Components/DesignTokens.swift`, which both targets compile")
    }

    // MARK: - reading the source and the catalog

    private func iOSSources() throws -> [(name: String, text: String)] {
        var found: [(name: String, text: String)] = []
        for target in ["apps/ios/Relayium", "apps/ios/RelayiumShare"] {
            let root = try RepoRoot.directory(target)
            let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
            while let url = enumerator?.nextObject() as? URL {
                guard url.pathExtension == "swift" else { continue }
                let name = target.replacingOccurrences(of: "apps/ios/", with: "")
                    + "/" + url.path.replacingOccurrences(of: root.path + "/", with: "")
                found.append((name: name, text: try RepoRoot.text(of: url)))
            }
        }
        // A guard that scans nothing reports clean. This walk is by directory,
        // so a moved tree yields an empty list rather than an error.
        XCTAssertGreaterThan(found.count, 20,
                             "only \(found.count) iOS sources found; this guard would have "
                             + "scanned almost nothing and reported clean")
        return found
    }

    private static func isComment(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("//")
    }

    private static func code(_ text: String) -> String {
        text.components(separatedBy: "\n").filter { !isComment($0) }.joined(separator: "\n")
    }

    /// `.secondary` as a colour, not as any identifier that happens to contain
    /// the word — `secondarySystemBackground` is a BACKGROUND and has nothing to
    /// do with this boundary.
    private static func mentionsSecondary(_ line: String) -> Bool {
        for spelling in [".foregroundStyle(.secondary)", "AnyShapeStyle(.secondary)",
                         "Color.secondary", "return .secondary", ".tint(.secondary)"]
        where line.contains(spelling) { return true }
        return false
    }

    /// The nearest classification marker above a line, skipping the rest of the
    /// modifier chain and any prose between them.
    ///
    /// Deliberately tolerant about distance and deliberately strict about
    /// spelling: the point is that the reason lives beside the code, not that it
    /// occupies a particular line.
    private static func marker(_ prefix: String, above index: Int, in lines: [String]) -> String? {
        for candidate in stride(from: index - 1, through: max(0, index - 6), by: -1) {
            let trimmed = lines[candidate].trimmingCharacters(in: .whitespaces)
            guard let range = trimmed.range(of: prefix) else { continue }
            let rest = trimmed[range.upperBound...].trimmingCharacters(in: .whitespaces)
            return rest.components(separatedBy: CharacterSet(charactersIn: " —,.")).first
        }
        return nil
    }

    private struct Manifest: Decodable {
        struct Appearance: Decodable { let appearance: String; let value: String }
        struct Components: Decodable {
            let red: String, green: String, blue: String, alpha: String
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

    private func roles() throws -> [Role] {
        [try role("SupportingLabel"), try role("WarningLabel")]
    }

    private func role(_ name: String) throws -> Role {
        let path = "apps/ios/Relayium/Assets.xcassets/\(name).colorset"
        let url = try RepoRoot.url(path + "/Contents.json")
        let entries = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: url)).colors

        func rgb(_ entry: Manifest.Entry) throws -> RGB {
            XCTAssertEqual(entry.color.colorSpace, "srgb",
                           "\(path) must stay sRGB; every ratio here is computed in it")
            XCTAssertEqual(entry.color.components.alpha, "1.000",
                           "\(path) must stay opaque; a translucent role composites against "
                           + "whatever is behind it and has no single measurable ratio")
            let parts = try [entry.color.components.red, entry.color.components.green,
                             entry.color.components.blue].map { component -> Double in
                Double(try XCTUnwrap(UInt8(component.replacingOccurrences(of: "0x", with: ""),
                                           radix: 16),
                                     "\(path) carries a non-hex component `\(component)`"))
            }
            return RGB(parts[0], parts[1], parts[2])
        }

        func entry(dark: Bool, high: Bool) throws -> Manifest.Entry {
            try XCTUnwrap(entries.first { candidate in
                let appearances = candidate.appearances ?? []
                let isDark = appearances.contains {
                    $0.appearance == "luminosity" && $0.value == "dark"
                }
                let isHigh = appearances.contains {
                    $0.appearance == "contrast" && $0.value == "high"
                }
                return isDark == dark && isHigh == high
            }, "\(path) declares no entry for dark=\(dark) increaseContrast=\(high). All four "
             + "are required: a missing Increase Contrast variant makes that accessibility "
             + "setting a silent no-op on every sentence drawn in this role.")
        }

        XCTAssertEqual(entries.count, 4,
                       "\(path) should declare exactly four appearances — Light, Dark and an "
                       + "Increase Contrast variant of each — and got \(entries.count)")
        return Role(name: name,
                    light: try rgb(try entry(dark: false, high: false)),
                    lightHigh: try rgb(try entry(dark: false, high: true)),
                    dark: try rgb(try entry(dark: true, high: false)),
                    darkHigh: try rgb(try entry(dark: true, high: true)))
    }
}
