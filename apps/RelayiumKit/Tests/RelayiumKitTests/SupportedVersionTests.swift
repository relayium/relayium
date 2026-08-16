import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **The decision that can stop the product running, tested as a value.**
///
/// Everything about the version policy that is consequential is in this file's
/// reach: how two versions compare, what a served document is allowed to say,
/// and which of the three states a given build lands in. None of it needs a
/// window, a network or a bundle — which is the point, because the surface it
/// drives is one a user only ever sees when their app has already stopped
/// working, and it is not a surface anybody can iterate on in front of a user.
final class SupportedVersionTests: XCTestCase {

    // MARK: - ordering

    /// The comparison a string compare gets wrong, and the reason this type
    /// exists at all. `"1.2.10" < "1.2.9"` is true as text.
    func testTenIsAboveNine() {
        XCTAssertTrue(AppVersion("1.2.9")! < AppVersion("1.2.10")!)
        XCTAssertFalse(AppVersion("1.2.10")! < AppVersion("1.2.9")!)
    }

    func testShorterVersionsArePaddedWithZeros() {
        XCTAssertEqual(AppVersion("1.2")!, AppVersion("1.2.0")!)
        XCTAssertEqual(AppVersion("1.2")!.hashValue, AppVersion("1.2.0.0")!.hashValue)
        XCTAssertTrue(AppVersion("1.2")! < AppVersion("1.2.1")!)
        XCTAssertTrue(AppVersion("1")! < AppVersion("1.0.1")!)
    }

    func testOrderingIsComponentWiseAndNotDecimal() {
        // 1.10 is above 1.9 — a decimal reading makes it below.
        XCTAssertTrue(AppVersion("1.9")! < AppVersion("1.10")!)
        XCTAssertTrue(AppVersion("2.0")! > AppVersion("1.999")!)
    }

    /// A version this type cannot read is `nil`, never a best guess. Every
    /// caller treats an unreadable version as "do not act", and a lenient parse
    /// would turn one of these into a number and compare it against a policy
    /// that meant something else.
    func testRefusesEverythingThatIsNotADottedNumber() {
        for text in ["", " ", "v1.2.4", "1.2.4-beta", "1.2.4+13", "1..4", "1.", ".1",
                     "1.2.4.5.6", "1.2.4a", "-1.2", "1.2.04", "١.٢.٤",
                     "1.2.4\n", "1234567890.0"] {
            XCTAssertNil(AppVersion(text), "accepted \(text)")
        }
    }

    func testAcceptsTheShapesTheProductActuallyShips() {
        for text in ["1", "1.0", "1.2.4", "1.2.4.1", "0.9.0", "10.20.30"] {
            XCTAssertNotNil(AppVersion(text), "refused \(text)")
        }
        // The text is preserved, so a rendered sentence reads as the product
        // wrote the version rather than as this type re-spells it.
        XCTAssertEqual(AppVersion("1.2.4")!.description, "1.2.4")
    }

    // MARK: - the embedded floor

    /// **The floor may never block the build that ships it.** This is what "fail
    /// open" means concretely: with no network and no cache, the policy in force
    /// is this one, and it has to leave the app usable.
    func testTheEmbeddedFloorIsTheOwnerSDecisionAndCannotBlockThisBuild() {
        let floor = SupportedVersionPolicy.embeddedFloor
        XCTAssertEqual(floor.minimumSupported, AppVersion("1.2.4")!)
        XCTAssertEqual(floor.recommended, AppVersion("1.2.5")!)
        XCTAssertEqual(floor.minimumSupportedBuild, 11)
        XCTAssertTrue(floor.minimumSupported <= floor.recommended)
        XCTAssertTrue(floor.recommended <= floor.latest)
    }

    // MARK: - decoding

    private func document(schema: Any = 1,
                          minimum: Any = "1.2.4",
                          build: Any = 11,
                          recommended: Any = "1.2.5",
                          latest: Any = "1.2.7",
                          extraMac: [String: Any] = [:],
                          extraRoot: [String: Any] = [:]) -> Data {
        var mac: [String: Any] = [
            "minimumSupportedVersion": minimum,
            "minimumSupportedBuild": build,
            "recommendedVersion": recommended,
            "latestVersion": latest,
        ]
        mac.merge(extraMac) { _, new in new }
        var root: [String: Any] = ["schema": schema, "macos": mac]
        root.merge(extraRoot) { _, new in new }
        return try! JSONSerialization.data(withJSONObject: root)
    }

    func testReadsTheShippedDocument() throws {
        let policy = try SupportedVersionPolicy.decode(document())
        XCTAssertEqual(policy.minimumSupported, AppVersion("1.2.4")!)
        XCTAssertEqual(policy.recommended, AppVersion("1.2.5")!)
        XCTAssertEqual(policy.latest, AppVersion("1.2.7")!)
        XCTAssertEqual(policy.minimumSupportedBuild, 11)
    }

    /// Future-safe: a field this build does not know about is ignored rather
    /// than fatal, so the schema can grow without stranding shipped clients.
    func testIgnoresFieldsItDoesNotKnow() throws {
        let policy = try SupportedVersionPolicy.decode(document(
            extraMac: ["windowsMinimum": "3.0", "note": "raised after the wire change"],
            extraRoot: ["ios": ["minimumSupportedVersion": "2.0"], "generatedAt": 123]))
        XCTAssertEqual(policy.minimumSupported, AppVersion("1.2.4")!)
    }

    /// **And an unknown field is not a way in.** A document naming an update
    /// address is read exactly like one that does not: the address is never
    /// looked at, because the decoded type has nowhere to put it.
    func testAnUpdateURLInTheDocumentReachesNothing() throws {
        let hostile = document(extraMac: [
            "updateURL": "https://evil.example/Relayium.dmg",
            "feedURL": "https://evil.example/appcast.xml",
        ])
        let policy = try SupportedVersionPolicy.decode(hostile)
        XCTAssertEqual(policy, try SupportedVersionPolicy.decode(document()))
        // The property list of the decoded value, spelled out. A future field
        // that carried an address would have to be added here first, which is
        // the point at which somebody has to argue for it.
        XCTAssertEqual(String(describing: Mirror(reflecting: policy).children.map(\.label)),
                       #"[Optional("minimumSupported"), Optional("recommended"), "#
                       + #"Optional("latest"), Optional("minimumSupportedBuild")]"#)
    }

    func testRefusesMalformedDocuments() {
        for (label, data) in [
            ("not JSON", Data("not json".utf8)),
            ("a JSON array", Data("[]".utf8)),
            ("no schema", try! JSONSerialization.data(withJSONObject: ["macos": [:]])),
            ("no macos section", try! JSONSerialization.data(withJSONObject: ["schema": 1])),
            ("a string build", document(build: "11")),
            ("a boolean build", document(build: true)),
            ("a numeric version", document(minimum: 1.2)),
            ("a missing field", try! JSONSerialization.data(withJSONObject: [
                "schema": 1, "macos": ["minimumSupportedVersion": "1.2.4"],
            ])),
        ] {
            XCTAssertThrowsError(try SupportedVersionPolicy.decode(data), label) { error in
                XCTAssertEqual(error as? SupportedVersionPolicyError, .malformed, label)
            }
        }
    }

    func testRefusesASchemaItDoesNotUnderstand() {
        // Both directions. A LOWER schema is refused too: a document from a
        // vocabulary this build predates is not one it can read safely either.
        for announced in [0, 2, 99] {
            XCTAssertThrowsError(try SupportedVersionPolicy.decode(document(schema: announced))) {
                XCTAssertEqual($0 as? SupportedVersionPolicyError, .unsupportedSchema(announced))
            }
        }
    }

    func testRefusesAVersionItCannotOrder() {
        XCTAssertThrowsError(try SupportedVersionPolicy.decode(document(minimum: "1.2.4-rc1"))) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError, .unreadableVersion("1.2.4-rc1"))
        }
    }

    func testRefusesADocumentThatContradictsItself() {
        // A minimum above the recommendation, a recommendation above the latest
        // release, and a build number that is not one.
        for mutation in [document(minimum: "1.3.0"),
                         document(recommended: "1.9.0"),
                         document(build: 0),
                         document(build: -5)] {
            XCTAssertThrowsError(try SupportedVersionPolicy.decode(mutation)) {
                XCTAssertEqual($0 as? SupportedVersionPolicyError, .inconsistent)
            }
        }
    }

    /// **The rollback gate.** A served document may make the requirement
    /// stricter and never weaker, so a replayed copy of last year's policy — or
    /// an origin somebody has taken over — cannot unblock a client this build
    /// already knows must stop.
    func testRefusesADocumentWeakerThanTheEmbeddedFloor() {
        for weakened in [document(minimum: "1.2.3"),
                         document(recommended: "1.2.4"),
                         document(build: 10)] {
            XCTAssertThrowsError(try SupportedVersionPolicy.decode(weakened)) {
                XCTAssertEqual($0 as? SupportedVersionPolicyError, .weakerThanFloor)
            }
        }
    }

    func testAcceptsADocumentStricterThanTheEmbeddedFloor() throws {
        let policy = try SupportedVersionPolicy.decode(
            document(minimum: "1.2.6", build: 12, recommended: "1.2.7"))
        XCTAssertEqual(policy.minimumSupported, AppVersion("1.2.6")!)
        XCTAssertEqual(policy.minimumSupportedBuild, 12)
    }

    /// `latest` is deliberately outside the rollback gate: it names what is
    /// published rather than what is required, and a release that is pulled
    /// legitimately lowers it.
    func testAPulledReleaseMayLowerTheLatestVersion() throws {
        let policy = try SupportedVersionPolicy.decode(
            document(recommended: "1.2.5", latest: "1.2.5"))
        XCTAssertEqual(policy.latest, AppVersion("1.2.5")!)
    }

    func testRefusesADocumentLargerThanItWillRead() {
        let padding = String(repeating: "x", count: SupportedVersionPolicy.maxDocumentBytes)
        XCTAssertThrowsError(try SupportedVersionPolicy.decode(
            document(extraMac: ["note": padding]))) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError, .tooLarge)
        }
    }

    // MARK: - the three states

    private let policy = SupportedVersionPolicy(
        minimumSupported: AppVersion("1.2.4")!,
        recommended: AppVersion("1.2.5")!,
        latest: AppVersion("1.2.7")!,
        minimumSupportedBuild: 11)

    func testTheStateOfEveryVersionAroundTheTwoThresholds() {
        func state(_ text: String) -> SupportedVersionState {
            SupportedVersionState.evaluate(current: AppVersion(text)!, policy: policy)
        }
        XCTAssertEqual(state("1.0.0"), .updateRequired(policy: policy))
        XCTAssertEqual(state("1.2.3"), .updateRequired(policy: policy))
        // The boundary is inclusive: the minimum itself is supported.
        XCTAssertEqual(state("1.2.4"), .updateRecommended(policy: policy))
        XCTAssertEqual(state("1.2.5"), .supported)
        XCTAssertEqual(state("1.2.7"), .supported)
        // The candidate this policy ships with, and the whole product claim it
        // has to satisfy: 1.2.7 and the 1.2.8 candidate both stay usable.
        XCTAssertEqual(state("1.2.8"), .supported)
        XCTAssertFalse(state("1.2.8").isBlocking)
        XCTAssertTrue(state("1.2.3").isBlocking)
    }

    /// A bundle that cannot say what version it is exists, and blocking it would
    /// turn a packaging fault into an app that cannot be used at all — for the
    /// one input no update can repair.
    func testABundleWithNoReadableVersionIsNeverBlocked() {
        XCTAssertEqual(SupportedVersionState.evaluate(current: nil, policy: policy), .supported)
    }

    // MARK: - copy

    /// Both maintained languages, asserted for the sentences a person only ever
    /// reads on a Mac whose Relayium has stopped working.
    func testTheBlockingSentenceNamesAllThreeVersionsInBothMaintainedLanguages() {
        for language in [AppLanguage.en, .zh] {
            let body = UpdateRequirementPresentation.requiredBody(
                current: AppVersion("1.2.3"), policy: policy, language: language)
            for version in ["1.2.3", "1.2.4", "1.2.7"] {
                XCTAssertTrue(body.contains(version),
                              "\(language.rawValue) blocking copy omits \(version)")
            }
            XCTAssertFalse(body.contains("update.requiredBody"),
                           "\(language.rawValue) rendered the raw key")
        }
        // Actually translated, not English twice. The catalogs fall back to
        // English, so a missing zh-Hans entry renders as English and passes
        // every assertion above.
        XCTAssertNotEqual(L10n.t(.updateRequiredTitle, language: .en),
                          L10n.t(.updateRequiredTitle, language: .zh))
        XCTAssertNotEqual(L10n.t(.updateActionQuit, language: .en),
                          L10n.t(.updateActionQuit, language: .zh))
    }

    func testTheRecommendationSaysNothingAboutARequirement() {
        for language in [AppLanguage.en, .zh] {
            let body = UpdateRequirementPresentation.recommendedBody(
                current: AppVersion("1.2.4"), policy: policy, language: language)
            XCTAssertTrue(body.contains("1.2.4") && body.contains("1.2.7"))
            // The minimum is not in this sentence. A recommendation that names a
            // requirement reads as a block, which is the one thing it is not.
            XCTAssertFalse(body.contains(L10n.t(.updateRequiredTitle, language: language)))
        }
    }

    /// The action label follows the MECHANISM. A direct build installs the
    /// update itself; the App Store build cannot install anything and can only
    /// take the user to the App Store.
    func testTheUpdateActionNamesWhatTheBuildCanActuallyDo() {
        XCTAssertEqual(
            UpdateRequirementPresentation.updateActionLabel(channel: .directDownload,
                                                            language: .en),
            L10n.t(.updateActionUpdate, language: .en))
        for store in [AppDistributionChannel.macAppStore, .iosAppStore] {
            XCTAssertEqual(
                UpdateRequirementPresentation.updateActionLabel(channel: store, language: .en),
                L10n.t(.updateActionOpenAppStore, language: .en))
        }
        XCTAssertNotEqual(L10n.t(.updateActionUpdate, language: .en),
                          L10n.t(.updateActionOpenAppStore, language: .en))
    }

    func testAVersionlessBundleRendersAPlaceholderRatherThanAGap() {
        let body = UpdateRequirementPresentation.recommendedBody(
            current: nil, policy: policy, language: .en)
        XCTAssertTrue(body.contains("—"))
        XCTAssertTrue(body.contains("1.2.7"))
    }
}
