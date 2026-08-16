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
        // The floor's revision is the replay barrier a device with no cache
        // starts from, so it has to be a revision the product actually
        // published — `SupportedVersionSurfaceTests` holds it to the canonical
        // document, and here it is simply within the bound it will be compared
        // against.
        XCTAssertTrue((1...SupportedVersionPolicy.maxPolicyRevision).contains(floor.revision))
    }

    // MARK: - decoding

    private func document(schema: Any = 1,
                          revision: Any = 1,
                          minimum: Any = "1.2.4",
                          build: Any = 11,
                          recommended: Any = "1.2.5",
                          latest: Any = "1.2.7",
                          extraMac: [String: Any] = [:],
                          extraRoot: [String: Any] = [:]) -> Data {
        var mac: [String: Any] = [
            "policyRevision": revision,
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
        XCTAssertEqual(policy.revision, 1)
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
                       #"[Optional("revision"), Optional("minimumSupported"), "#
                       + #"Optional("recommended"), Optional("latest"), "#
                       + #"Optional("minimumSupportedBuild")]"#)
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
            // The revision is REQUIRED, and its absence is malformed rather
            // than a default. A revision that could be omitted is a revision an
            // attacker strips, and whatever value stood in for it would reset
            // the replay barrier on every client that read the stripped copy.
            ("no revision", try! JSONSerialization.data(withJSONObject: [
                "schema": 1,
                "macos": ["minimumSupportedVersion": "1.2.4", "minimumSupportedBuild": 11,
                          "recommendedVersion": "1.2.5", "latestVersion": "1.2.7"],
            ])),
            ("a string revision", document(revision: "1")),
            ("a boolean revision", document(revision: true)),
            ("a fractional revision", document(revision: 1.5)),
            // Beyond `Int`. `JSONSerialization` hands this back as a `Double`,
            // and the value-preserving bridge refuses it — which matters,
            // because a revision that got through as a rounded `Int` would be
            // remembered as one.
            ("a revision beyond Int", Data("""
                {"schema":1,"macos":{"policyRevision":1e40,\
                "minimumSupportedVersion":"1.2.4","minimumSupportedBuild":11,\
                "recommendedVersion":"1.2.5","latestVersion":"1.2.7"}}
                """.utf8)),
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

    /// **A revision outside the bound is refused before it can be remembered.**
    ///
    /// Zero and negatives are not revisions. The ceiling is the interesting one:
    /// the revision is the value a device REMEMBERS, so a single document
    /// carrying `Int.max` would, once accepted, sit above everything the product
    /// can ever publish — and that install would refuse every genuine policy for
    /// the rest of its life, the emergency one included. The bound is checked at
    /// decode, which is before anything is stored.
    func testRefusesARevisionOutsideTheBoundItWillRemember() {
        let ceiling = SupportedVersionPolicy.maxPolicyRevision
        for value in [0, -1, -2_000_000_000, ceiling + 1, Int.max] {
            XCTAssertThrowsError(try SupportedVersionPolicy.decode(document(revision: value)),
                                 "accepted revision \(value)") {
                XCTAssertEqual($0 as? SupportedVersionPolicyError, .invalidRevision(value))
            }
        }
        // And the boundary itself is readable, so the ceiling is a bound rather
        // than an off-by-one nobody would notice until a release hit it.
        XCTAssertEqual(try SupportedVersionPolicy.decode(document(revision: ceiling)).revision,
                       ceiling)
        XCTAssertEqual(try SupportedVersionPolicy.decode(document(revision: 1)).revision, 1)
    }

    func testRefusesADocumentLargerThanItWillRead() {
        let padding = String(repeating: "x", count: SupportedVersionPolicy.maxDocumentBytes)
        XCTAssertThrowsError(try SupportedVersionPolicy.decode(
            document(extraMac: ["note": padding]))) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError, .tooLarge)
        }
    }

    // MARK: - the replay barrier

    private func policyAt(revision: Int,
                        minimum: String = "1.2.4",
                        recommended: String = "1.2.5",
                        latest: String = "1.2.7",
                        build: Int = 11) -> SupportedVersionPolicy {
        SupportedVersionPolicy(revision: revision,
                               minimumSupported: AppVersion(minimum)!,
                               recommended: AppVersion(recommended)!,
                               latest: AppVersion(latest)!,
                               minimumSupportedBuild: build)
    }

    /// **The hole the floor alone cannot close.**
    ///
    /// The rollback gate above compares a served document to a CONSTANT, so it
    /// can only say "not weaker than what this binary shipped". A client that
    /// was later told 1.3.0 is required has moved past that constant, and a
    /// replayed copy of the original 1.2.4 policy — genuine, correctly served,
    /// comfortably above the floor — clears every rule in `decode`. This is the
    /// rule that refuses it: the device remembers the revision, and older is
    /// older whatever the document says.
    func testALowerRevisionIsRefusedHoweverValidTheDocumentIs() {
        let known = policyAt(revision: 7, minimum: "1.3.0", recommended: "1.3.0", build: 20)
        let replayed = policyAt(revision: 6)
        XCTAssertThrowsError(try SupportedVersionPolicy.admit(replayed, over: known)) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError,
                           .replayedRevision(served: 6, known: 7))
        }
    }

    /// One revision names one document. Different content under a revision this
    /// device already holds is an origin equivocating between clients — or an
    /// edit that changed a requirement and forgot to advance the number, which
    /// is the same thing seen from the inside. Refused in BOTH directions: a
    /// same-revision "refinement" that only tightens is still a second meaning.
    func testTheSameRevisionMustCarryTheSameDocument() {
        let known = policyAt(revision: 4)
        for different in [policyAt(revision: 4, minimum: "1.2.6", recommended: "1.2.6", build: 12),
                          policyAt(revision: 4, latest: "1.2.8"),
                          policyAt(revision: 4, build: 12)] {
            XCTAssertThrowsError(try SupportedVersionPolicy.admit(different, over: known),
                                 "accepted a second document under revision 4") {
                XCTAssertEqual($0 as? SupportedVersionPolicyError, .equivocatingRevision(4))
            }
        }
        // The identical document is admitted, which is what lets an unchanged
        // policy refresh a cache entry's timestamp rather than stranding it.
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(policyAt(revision: 4), over: known))
    }

    /// **The emergency rollback, and the reason the barrier is a revision rather
    /// than a requirement.** A minimum published in error is undone by publishing
    /// a HIGHER revision that relaxes it — no new binary, no waiting. The floor
    /// still holds underneath, so the relaxation cannot go below what the binary
    /// itself guarantees.
    func testAHigherRevisionMayDeliberatelyRelaxTheRequirement() throws {
        let strict = policyAt(revision: 9, minimum: "1.3.0", recommended: "1.3.0", build: 20)
        let relaxed = policyAt(revision: 10)
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(relaxed, over: strict))
        // And it is `decode` that keeps the relaxation above the floor: the same
        // higher revision cannot take the requirement below the embedded one.
        XCTAssertThrowsError(try SupportedVersionPolicy.decode(
            document(revision: 10, minimum: "1.2.3", build: 10, recommended: "1.2.3"))) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError, .weakerThanFloor)
        }
        // A higher revision may also tighten, which is the ordinary direction.
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(
            policyAt(revision: 11, minimum: "1.4.0", recommended: "1.4.0", build: 30),
            over: relaxed))
    }

    /// With no memory of its own, a device starts from the binary's. A document
    /// older than the revision this build was cut against is a replay on first
    /// launch too.
    func testADeviceWithNoCacheStartsFromTheEmbeddedFloorSRevision() {
        let floor = SupportedVersionPolicy.embeddedFloor
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(policyAt(revision: floor.revision),
                                                          over: nil))
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(policyAt(revision: floor.revision + 5),
                                                          over: nil))
        let stale = policyAt(revision: floor.revision, minimum: "1.2.4")
        XCTAssertThrowsError(try SupportedVersionPolicy.admit(
            stale, over: nil, floor: policyAt(revision: floor.revision + 1))) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError,
                           .replayedRevision(served: floor.revision, known: floor.revision + 1))
        }
    }

    /// **The split brain a revision NUMBER cannot close, and the reason the floor
    /// is compared as a whole policy.**
    ///
    /// A device with no cache has no document to compare a served one against —
    /// so a barrier that took only the floor's NUMBER would let a fresh install
    /// accept content the floor never said, under a revision the floor already
    /// spent. The install that cached the original revision 1 refuses exactly
    /// that document. Two installs, one revision, opposite enforcement, decided
    /// by nothing but which of them had run before. Refused in both directions,
    /// because a stricter document under a spent revision is as much a second
    /// meaning as a weaker one — and the stricter direction is the one an
    /// attacker who can serve a document would actually reach for, since
    /// `decode` refuses to go below the floor but is happy to go above it.
    func testAFreshInstallRefusesTheFloorSRevisionCarryingDifferentContent() {
        let floor = SupportedVersionPolicy.embeddedFloor
        for (label, different) in [
            ("stricter", policyAt(revision: floor.revision, minimum: "1.2.6",
                                  recommended: "1.2.6", build: 12)),
            ("a different published version", policyAt(revision: floor.revision, latest: "1.2.8")),
            ("a build that does not match the version",
             policyAt(revision: floor.revision, build: 12)),
        ] {
            XCTAssertThrowsError(
                try SupportedVersionPolicy.admit(different, over: nil, floor: floor),
                "a fresh install accepted \(label) under the floor's own revision") {
                XCTAssertEqual($0 as? SupportedVersionPolicyError,
                               .equivocatingRevision(floor.revision))
            }
            // And the device that HAS the floor's document cached refuses it
            // too, which is the point: both installs answer the same way.
            XCTAssertThrowsError(
                try SupportedVersionPolicy.admit(different, over: floor, floor: floor), label)
        }
        // The floor's own document, served back at its own revision, is the
        // ordinary first-launch case and is admitted.
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(
            policyAt(revision: floor.revision), over: nil, floor: floor))
        XCTAssertEqual(policyAt(revision: floor.revision), floor,
                       "the published document and the embedded floor must be one policy")
    }

    /// A cache above the floor is the authority, and the floor does not dilute
    /// it: the higher revision wins whole, so its content — not the floor's — is
    /// what the served document must match at that revision.
    func testACachedRevisionAboveTheFloorStaysAuthoritative() {
        let floor = policyAt(revision: 2)
        let known = policyAt(revision: 6, minimum: "1.3.0", recommended: "1.3.0", build: 20)
        XCTAssertThrowsError(
            try SupportedVersionPolicy.admit(policyAt(revision: 6), over: known, floor: floor)) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError, .equivocatingRevision(6))
        }
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(known, over: known, floor: floor))
        XCTAssertThrowsError(
            try SupportedVersionPolicy.admit(policyAt(revision: 5), over: known, floor: floor)) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError,
                           .replayedRevision(served: 5, known: 6))
        }
        // A cache BELOW the floor's revision is spent memory: the binary knows
        // something newer, so the floor decides both the barrier and the content.
        let stale = policyAt(revision: 1, minimum: "1.3.0", recommended: "1.3.0", build: 20)
        XCTAssertThrowsError(
            try SupportedVersionPolicy.admit(stale, over: stale, floor: floor)) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError,
                           .replayedRevision(served: 1, known: 2))
        }
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(floor, over: stale, floor: floor))
        XCTAssertThrowsError(
            try SupportedVersionPolicy.admit(policyAt(revision: 2, latest: "1.2.8"),
                                             over: stale, floor: floor)) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError, .equivocatingRevision(2))
        }
    }

    /// **A corrupt or legacy cache cannot establish a split brain, and cannot
    /// brick the policy either.**
    ///
    /// One revision already naming two documents — one cached, one compiled in —
    /// is a state the fixed admitting path never creates; it is reachable from a
    /// cache written by a build whose floor said something else, or from a
    /// tampered one. Neither side can be preferred, so that revision carries no
    /// content: nothing at it is admitted, in EITHER direction, so whichever
    /// document an attacker holds does not become this device's policy. A
    /// strictly higher revision still is admitted, so the product can publish
    /// its way out rather than the device being stranded on a bad cache forever.
    func testAContestedRevisionAdmitsNothingAtItAndStillTakesAHigherOne() {
        let floor = policyAt(revision: 4)
        let corrupt = policyAt(revision: 4, minimum: "1.3.0", recommended: "1.3.0", build: 20)
        for (label, served) in [("the cached side", corrupt), ("the floor's side", floor)] {
            XCTAssertThrowsError(
                try SupportedVersionPolicy.admit(served, over: corrupt, floor: floor),
                "a contested revision admitted \(label)") {
                XCTAssertEqual($0 as? SupportedVersionPolicyError, .equivocatingRevision(4))
            }
        }
        XCTAssertThrowsError(
            try SupportedVersionPolicy.admit(policyAt(revision: 3), over: corrupt, floor: floor)) {
            XCTAssertEqual($0 as? SupportedVersionPolicyError,
                           .replayedRevision(served: 3, known: 4))
        }
        XCTAssertNoThrow(try SupportedVersionPolicy.admit(policyAt(revision: 5),
                                                         over: corrupt, floor: floor),
                         "a corrupt cache stranded this device on its revision")
    }

    // MARK: - the three states

    private let policy = SupportedVersionPolicy(
        revision: 1,
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
