import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **iOS and macOS are two platforms of ONE universal-purchase App Store
/// record, and the identifiers that must match now match while the ones that
/// must not still differ.**
///
/// Apple requires every platform in a universal-purchase record to carry the
/// same Bundle ID. Apple ID `6801142976` already held both platforms, and its
/// iOS TestFlight build reported main bundle `com.relayium.mac`, so the iOS
/// source was migrated onto the macOS bundle identifier rather than the other
/// way round. That single change is what puts an iOS binary in front of the six
/// already-Approved `com.relayium.mac.{plus,pro,max}.{monthly,yearly}`
/// subscription products in group `22307427`.
///
/// The change is cheap to make and expensive to get subtly wrong, because the
/// four kinds of identifier involved look alike and moved differently:
///
///  1. **The main bundle id MOVED and must now be identical across platforms.**
///     A drift here does not fail a build. It produces an archive that uploads
///     to a record holding a different catalogue, and a purchase that resolves
///     to no product.
///  2. **The two Share Extensions must stay DIFFERENT.** The target record's
///     iOS TestFlight build metadata reports extension application identifier
///     `7PVYUG4YQS.com.relayium.mac.ShareIOS`, so that is what the iOS project
///     must carry; `com.relayium.mac.Share` — the macOS one — is the plausible
///     wrong answer.
///  3. **The two UI-test bundles must stay DIFFERENT.** They are non-shipping,
///     which is exactly why a collision would be noticed late.
///  4. **The App Group and the iOS keychain service did NOT move, on purpose.**
///     Neither is derived from a bundle id: a group is a separately registered
///     container the portal already authorizes, and a keychain service is a
///     lookup key within whatever access group the app already has. Keeping
///     both is continuity with the `com.relayium.mac` iOS/TestFlight lineage
///     and with the existing code. "Rename them to match" is the
///     natural-looking follow-up edit, and it would strand that lineage's
///     staged drafts and orphan its stored bearer and stored-link keys. Neither
///     carries anything over from the retired `com.relayium.app` app — see
///     `testTheIOSKeychainServiceDidNotFollowTheBundleIdentifier`.
///
/// ### What this test cannot prove, and does not claim
///
/// Every input here is a file in this repository. Nothing in this target can
/// see App Store Connect, the developer portal, a provisioning profile, a
/// signed binary or the production server, so this test proves only that the
/// repository is internally consistent about the migrated identity. It does
/// NOT establish, and must never be cited as establishing:
///
///  - that Apple ID `6801142976` holds the six products in group `22307427`, or
///    that they are Approved — that is a recorded read-back in the metadata
///    packet, not a live query, and it is owed a fresh read-only inspection
///    before use;
///  - that the named provisioning profiles exist in the account, or that the
///    App IDs carry Sign in with Apple, App Groups or Associated Domains in the
///    iOS profile a build is actually signed with;
///  - that Relayium's `apple_products` rows map the six identifiers, which is
///    what an accepted purchase actually depends on;
///  - that Sign in with Apple works end to end on a real signed device. A
///    separate read-only production check on 2026-09-03 found the server's
///    audience allowlist already admitting `com.relayium.mac`, so no production
///    change is owed — but an admitted audience is not a completed sign-in, and
///    the live flow has still never been run.
///
/// Those are external gates with their own evidence. This file is the guard
/// that keeps the repository from disagreeing with itself while they are open.
final class UniversalPurchaseIdentityTests: XCTestCase {

    // MARK: - the identity, stated once

    /// The one Bundle ID both platforms of the universal-purchase record carry.
    private let sharedBundleID = "com.relayium.mac"
    /// The public App Store id of that record. Not a credential.
    private let appleID = "6801142976"
    /// The separate, iOS-only record this repository targeted until 2026-09-03.
    /// Read-only, and named here so a regression toward it is legible.
    private let supersededAppleID = "6791918822"
    private let supersededBundleID = "com.relayium.app"

    private let iosShareBundleID = "com.relayium.mac.ShareIOS"
    private let macShareBundleID = "com.relayium.mac.Share"
    private let iosUITestBundleID = "com.relayium.ios.UITests"
    private let macUITestBundleID = "com.relayium.mac.UITests"

    private let appGroup = "group.com.relayium.app"
    private let iosKeychainService = "com.relayium.app"

    /// The existing Approved subscription group. Reused, never recreated.
    private let subscriptionGroupID = "22307427"

    /// The six live products, in the packet's own order.
    private let productIDs = [
        "com.relayium.mac.plus.monthly",
        "com.relayium.mac.plus.yearly",
        "com.relayium.mac.pro.monthly",
        "com.relayium.mac.pro.yearly",
        "com.relayium.mac.max.monthly",
        "com.relayium.mac.max.yearly",
    ]

    // MARK: - reading the two projects

    /// Every distinct `PRODUCT_BUNDLE_IDENTIFIER` in a `.pbxproj`, with the
    /// number of configurations that set it.
    ///
    /// Counted rather than collected into a `Set` because "set in both Debug and
    /// Release" is half the assertion: a bundle id that appears once is a
    /// configuration that silently lost it, and Xcode would then fall back to
    /// whatever the project level says.
    private func bundleIdentifiers(in relativePath: String) throws -> [String: Int] {
        let project = try RepoRoot.text(relativePath)
        var counts: [String: Int] = [:]
        for line in project.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("PRODUCT_BUNDLE_IDENTIFIER = ") else { continue }
            let value = trimmed
                .replacingOccurrences(of: "PRODUCT_BUNDLE_IDENTIFIER = ", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: ";\" "))
            counts[value, default: 0] += 1
        }
        // An empty read is the silent-pass shape every guard in this target
        // guards against: it would satisfy each "must not contain" below.
        XCTAssertFalse(counts.isEmpty, "no bundle identifier was read out of \(relativePath)")
        return counts
    }

    private func iosProject() throws -> [String: Int] {
        try bundleIdentifiers(in: "apps/ios/Relayium.xcodeproj/project.pbxproj")
    }

    private func macProject() throws -> [String: Int] {
        try bundleIdentifiers(in: "apps/mac/Relayium.xcodeproj/project.pbxproj")
    }

    // MARK: - 1. the main bundle id is shared, exactly

    /// **Both projects' app targets carry the identical Bundle ID**, and each
    /// sets it in both configurations.
    ///
    /// Asserted as equality against one literal rather than "iOS equals macOS",
    /// so that renaming BOTH — which would keep an `==` comparison green while
    /// walking the record away from its catalogue — fails here.
    func testBothPlatformsShipTheSameMainBundleIdentifier() throws {
        let ios = try iosProject()
        let mac = try macProject()

        XCTAssertNotNil(ios[sharedBundleID],
                        "the iOS app target no longer carries \(sharedBundleID); an archive "
                        + "built from it would upload to a record that does not hold this "
                        + "app's subscription catalogue")
        XCTAssertNotNil(mac[sharedBundleID],
                        "the macOS app target no longer carries \(sharedBundleID)")
        XCTAssertEqual(ios[sharedBundleID], 2,
                       "the iOS app's bundle id must be set in both configurations")
        // macOS builds the same app for two channels, so its app bundle id
        // appears in more than one target's Debug and Release.
        XCTAssertGreaterThanOrEqual(mac[sharedBundleID] ?? 0, 2,
                                    "the macOS app's bundle id must be set per configuration")
    }

    /// **The retired iOS identity is gone from the iOS project as a bundle
    /// identifier**, in every form the migration had to move.
    ///
    /// The App Group keeps the `com.relayium.app` name and is deliberately NOT
    /// covered by this: it is a group identifier, never a
    /// `PRODUCT_BUNDLE_IDENTIFIER`, so reading only that setting separates the
    /// two without needing an exception list.
    func testTheRetiredIOSBundleIdentifiersAreGoneFromTheProject() throws {
        let ios = try iosProject()
        for retired in [supersededBundleID,
                        "\(supersededBundleID).share",
                        "\(supersededBundleID).UITests"] {
            XCTAssertNil(ios[retired],
                         "\(retired) is still set as a bundle identifier in the iOS project; "
                         + "the universal-purchase migration retired it")
        }
    }

    // MARK: - 2 and 3. what must stay distinct

    /// **The two Share Extensions are different App IDs**, and the iOS one is
    /// not the macOS one.
    ///
    /// This is a portal-proven fact rather than a preference: the target
    /// record's iOS TestFlight build metadata reports extension application
    /// identifier `7PVYUG4YQS.com.relayium.mac.ShareIOS`, and the project must
    /// match what the record already carries. It is also the single most
    /// plausible mistake in this migration: `com.relayium.mac.Share` already
    /// exists, reads correctly, and is the macOS extension's.
    func testTheTwoShareExtensionsKeepDistinctIdentifiers() throws {
        let ios = try iosProject()
        let mac = try macProject()

        XCTAssertNotEqual(iosShareBundleID, macShareBundleID,
                          "the two extensions' identifiers were made equal in this file")
        XCTAssertEqual(ios[iosShareBundleID], 2,
                       "the iOS appex must carry \(iosShareBundleID) in both configurations")
        XCTAssertNil(ios[macShareBundleID],
                     "the iOS project sets the MACOS extension's identifier "
                     + "\(macShareBundleID); the record's iOS extension is "
                     + "\(iosShareBundleID)")
        XCTAssertNotNil(mac[macShareBundleID],
                        "the macOS appex no longer carries \(macShareBundleID)")
        XCTAssertNil(mac[iosShareBundleID],
                     "the macOS project sets the iOS extension's identifier")
    }

    /// **The two UI-test bundles are different**, and neither is the app's.
    ///
    /// A UI-test runner is not shipped and not sold, which is why a collision
    /// here would surface as an unexplained install failure on a machine that
    /// had run the other platform's suite rather than as anything legible.
    func testTheTwoUITestBundlesKeepDistinctIdentifiers() throws {
        let ios = try iosProject()
        let mac = try macProject()

        XCTAssertNotEqual(iosUITestBundleID, macUITestBundleID,
                          "the two UI-test identifiers were made equal in this file")
        XCTAssertEqual(ios[iosUITestBundleID], 2,
                       "the iOS UI-test target must carry \(iosUITestBundleID) in both "
                       + "configurations")
        XCTAssertNil(ios[macUITestBundleID],
                     "the iOS project sets the macOS UI-test identifier")
        XCTAssertNotNil(mac[macUITestBundleID],
                        "the macOS UI-test target no longer carries \(macUITestBundleID)")
        XCTAssertNil(mac[iosUITestBundleID],
                     "the macOS project sets the iOS UI-test identifier")

        // A non-shipping bundle must never be the shipping one.
        for testBundle in [iosUITestBundleID, macUITestBundleID] {
            XCTAssertNotEqual(testBundle, sharedBundleID,
                              "\(testBundle) is the app's own identifier")
        }
    }

    // MARK: - 4. what deliberately did not move

    /// **The App Group kept its name**, in the constant and in the entitlement
    /// the signed build is provisioned against.
    ///
    /// An App Group identifier is registered on its own and is not derived from
    /// a bundle id. This one is what the portal already authorizes for both the
    /// app and `com.relayium.mac.ShareIOS` — the record's own Build Metadata
    /// reported it — and renaming it to match the new bundle id would strand
    /// every draft an installed build has already staged into the old container.
    func testTheAppGroupDidNotFollowTheBundleIdentifier() throws {
        XCTAssertEqual(AppGroup.iOSIdentifier, appGroup,
                       "the iOS App Group identifier moved with the bundle id")
        XCTAssertNotEqual(AppGroup.iOSIdentifier, AppGroup.macOSIdentifier,
                          "the two platforms' App Groups became the same string; the macOS "
                          + "profiles do not authorize the iOS one")

        for entitlement in ["apps/ios/Relayium/Relayium.entitlements",
                            "apps/ios/RelayiumShare/RelayiumShare.entitlements"] {
            let text = try RepoRoot.text(entitlement)
            XCTAssertTrue(text.contains("<string>\(appGroup)</string>"),
                          "\(entitlement) no longer claims \(appGroup); the share extension "
                          + "and the app would resolve different containers")
        }
    }

    /// **The iOS keychain service kept its name**, and is still not the macOS
    /// one.
    ///
    /// A keychain service is a lookup key, not a signed capability. Keeping
    /// `com.relayium.app` is continuity with the `com.relayium.mac`
    /// iOS/TestFlight lineage — the installs that already wrote their items
    /// under the shared bundle id — and with the code and tests that name it.
    /// Moving it onto `com.relayium.mac` would compile, ship, and orphan those
    /// installs' bearer tokens and stored-link keys, and the stored-link keys
    /// exist nowhere else, so that is unrecoverable data loss rather than a
    /// re-login.
    ///
    /// What the label does NOT do is reach the retired identity. Moving the
    /// main bundle from `com.relayium.app` to `com.relayium.mac` moved this
    /// app's implicit default keychain access group with it, so a separately
    /// installed `com.relayium.app` development app's items are neither
    /// migrated nor exposed here — a matching service label does not cross
    /// access groups. That is why `accessGroup` is asserted nil below rather
    /// than set to the retired prefix.
    func testTheIOSKeychainServiceDidNotFollowTheBundleIdentifier() throws {
        XCTAssertEqual(AppEnvironment.iosKeychainService, iosKeychainService,
                       "the iOS keychain service moved with the bundle id; every bearer and "
                       + "stored-link key the com.relayium.mac lineage wrote would be orphaned")
        XCTAssertNotEqual(AppEnvironment.iosKeychainService, sharedBundleID,
                          "the iOS keychain service became the shared bundle id")

        let configuration = AppEnvironment.keychainConfiguration(for: .iOS)
        XCTAssertEqual(configuration.service, iosKeychainService)
        XCTAssertNil(configuration.accessGroup,
                     "the iOS keychain gained an access group; it shares with nothing, and one "
                     + "naming the retired bundle id would reach into a separately installed app")
    }

    // MARK: - 5. the candidate script and the metadata packet agree

    /// The `readonly NAME='value'` constants of the candidate script.
    private func candidateConstants() throws -> [String: String] {
        let script = try RepoRoot.text("scripts/ios-app-store-candidate.sh")
        var constants: [String: String] = [:]
        for line in script.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("readonly ") else { continue }
            let assignment = String(trimmed.dropFirst("readonly ".count))
            guard let equals = assignment.firstIndex(of: "=") else { continue }
            let name = String(assignment[assignment.startIndex..<equals])
            let value = assignment[assignment.index(after: equals)...]
                .trimmingCharacters(in: CharacterSet(charactersIn: "'\" "))
            constants[name] = value
        }
        XCTAssertFalse(constants.isEmpty, "no constants were read out of the candidate script")
        return constants
    }

    /// **The archive script is pinned to the universal-purchase identity.**
    ///
    /// This script is the last repository-controlled step before an artifact
    /// exists, so the identity it signs and the record it names are pinned here
    /// as well as in the project. The script cannot see App Store Connect and
    /// neither can this test; what is asserted is that the two agree.
    func testTheCandidateScriptPinsTheUniversalPurchaseIdentity() throws {
        let constants = try candidateConstants()

        XCTAssertEqual(constants["TARGET_APPLE_ID"], appleID,
                       "the candidate script no longer names Apple ID \(appleID)")
        XCTAssertNotEqual(constants["TARGET_APPLE_ID"], supersededAppleID,
                          "the candidate script points at the superseded record")
        XCTAssertEqual(constants["APP_BUNDLE_ID"], sharedBundleID)
        XCTAssertEqual(constants["SHARE_BUNDLE_ID"], iosShareBundleID)
        XCTAssertEqual(constants["APP_GROUP"], appGroup,
                       "the candidate script's App Group drifted from the entitlement")
        XCTAssertEqual(constants["EXPECTED_TEAM"], "7PVYUG4YQS")

        // The profiles are named, not created. Asserting the names keeps the
        // project and the script from naming different ones; whether they exist
        // in the account is an external fact this cannot reach.
        XCTAssertEqual(constants["APP_PROFILE"], "Relayium iOS Universal App Store")
        XCTAssertEqual(constants["SHARE_PROFILE"], "Relayium iOS Share Extension App Store")

        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")
        for profile in [constants["APP_PROFILE"], constants["SHARE_PROFILE"]] {
            let profile = try XCTUnwrap(profile)
            XCTAssertTrue(project.contains("PROVISIONING_PROFILE_SPECIFIER = \"\(profile)\";"),
                          "the project does not name the profile \(profile) the script pins")
        }
    }

    /// **The candidate script's build-number floor is the number the target
    /// record was read back at, and it is applied as a floor.**
    ///
    /// The migration moved the candidate onto a record with build-number
    /// HISTORY — a Validated `0.1.0 (4)` — where the superseded one had none.
    /// So `--readback-highest-build 0`, which used to be an honest first
    /// reading, is now the shape of an operator describing the wrong record.
    /// Two things are asserted, because either alone passes while the gate is
    /// broken: that the floor is the observed number, and that the comparison
    /// is a strict `less than` against it rather than a `!=` or a ceiling.
    func testTheCandidateScriptRefusesAnAttestationBelowTheObservedFloor() throws {
        let constants = try candidateConstants()
        XCTAssertEqual(constants["OBSERVED_HIGHEST_BUILD_FLOOR"], "4",
                       "the observed build-number floor drifted from the 0.1.0 (4) read-back")

        let script = try RepoRoot.text("scripts/ios-app-store-candidate.sh")
        XCTAssertTrue(
            script.contains(
                "if decimal_less_than \"$readback_highest_build\" \"$OBSERVED_HIGHEST_BUILD_FLOOR\"; then"),
            "the attestation is no longer refused below the floor, or the comparison changed "
            + "shape; a floor applied as anything but `strictly below is refused` either "
            + "rejects the observed value itself or accepts a lower one")
        XCTAssertTrue(script.contains("decimal_less_than() {"),
                      "the decimal comparison the floor depends on is gone; shell arithmetic "
                      + "would wrap silently at 2^64")
    }

    /// The metadata packet, parsed.
    private func packet() throws -> [String: Any] {
        let data = try RepoRoot.data("docs/app-store-metadata-ios.json")
        let object = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(object as? [String: Any], "the metadata packet is not an object")
    }

    /// **The metadata packet names the universal-purchase record, its existing
    /// subscription group and the six live products, exactly.**
    ///
    /// Exact and ordered rather than "contains": a seventh identifier, or one of
    /// the six missing, is the shape of a catalogue that has been half-migrated,
    /// and a `contains` check would pass over both.
    func testTheMetadataPacketNamesTheUniversalRecordAndItsSixProducts() throws {
        let packet = try packet()

        let record = try XCTUnwrap(packet["record"] as? [String: Any])
        XCTAssertEqual(record["appleId"] as? String, appleID)
        XCTAssertEqual(record["bundleId"] as? String, sharedBundleID)
        XCTAssertEqual(record["shareExtensionBundleId"] as? String, iosShareBundleID)

        let subscriptions = try XCTUnwrap(packet["subscriptions"] as? [String: Any])

        // The group is the half a "create it" mistake reaches first: a second
        // group is as permanent as a second product and splits one app's
        // catalogue across two.
        let group = try XCTUnwrap(subscriptions["group"] as? [String: Any])
        XCTAssertEqual(group["groupId"] as? String, subscriptionGroupID,
                       "the packet no longer names the existing Approved subscription group")
        XCTAssertEqual(group["observedState"] as? String, "Approved")

        let products = try XCTUnwrap(subscriptions["products"] as? [[String: Any]])
        XCTAssertEqual(products.compactMap { $0["productId"] as? String }, productIDs,
                       "the packet's product identifiers are not exactly the six live ones")
        XCTAssertEqual(products.compactMap { $0["observedState"] as? String },
                       Array(repeating: "Approved", count: productIDs.count),
                       "a product's live Approved state was downgraded in the packet")

        // The packet must not have quietly become a proposal again: these
        // products exist and are Approved, and creating anything is the error.
        XCTAssertEqual(subscriptions["noNewProductsMayBeCreated"] as? Bool, true,
                       "the packet no longer forbids creating products")
        XCTAssertNil(subscriptions["productIdentifiersAreProposedDrafts"],
                     "the packet describes the live identifiers as proposed drafts")
    }

    /// **No `com.relayium.app` product namespace is proposed anywhere.**
    ///
    /// An App Store product identifier is permanent: it cannot be deleted or
    /// renamed. Creating a second namespace would fork the catalogue the
    /// released macOS app already sells through, permanently, and every
    /// downstream entitlement decision would then depend on which namespace a
    /// transaction arrived from.
    ///
    /// Checked as concrete identifiers rather than by banning the substring,
    /// because the packet legitimately names `com.relayium.app` three ways: the
    /// superseded record's bundle id, the App Group that kept its name, and the
    /// prose explaining why this namespace must never be created. Banning the
    /// substring would force those explanations out of the file, which is the
    /// opposite of what keeps the mistake from being made again.
    func testNoRelayiumAppProductNamespaceIsProposed() throws {
        let text = try RepoRoot.text("docs/app-store-metadata-ios.json")
        for plan in ["plus", "pro", "max"] {
            for cycle in ["monthly", "yearly"] {
                let forbidden = "\(supersededBundleID).\(plan).\(cycle)"
                XCTAssertFalse(text.contains(forbidden),
                               "the packet names \(forbidden); an identifier under the retired "
                               + "namespace would permanently fork the catalogue the released "
                               + "macOS app sells through")
            }
        }

        // Structurally, too: no product entry may sit under the retired bundle.
        let subscriptions = try XCTUnwrap(try packet()["subscriptions"] as? [String: Any])
        let products = try XCTUnwrap(subscriptions["products"] as? [[String: Any]])
        for product in products {
            let identifier = try XCTUnwrap(product["productId"] as? String)
            XCTAssertTrue(identifier.hasPrefix("\(sharedBundleID)."),
                          "\(identifier) is not under the universal record's bundle")
            XCTAssertFalse(identifier.hasPrefix("\(supersededBundleID)."),
                           "\(identifier) is under the retired namespace")
        }
    }

    /// **The superseded record is still recorded, and still not the target.**
    ///
    /// Deleting the entry would be the tidy-looking edit that makes the trap
    /// invisible again: `6791918822` is a real, separate, iOS-only App Store
    /// record that this repository itself named as the target until
    /// 2026-09-03, so it reads as correct in every older commit and plan. It is
    /// kept here precisely so a future reader meets it as a refusal rather than
    /// as a plausible destination.
    func testTheSupersededRecordIsNamedAsReadOnlyRatherThanDeleted() throws {
        let observation = try XCTUnwrap(
            try packet()["appStoreConnectObservation"] as? [String: Any])
        let records = try XCTUnwrap(observation["records"] as? [[String: Any]])

        let targets = records.filter { $0["targetForIosRelease"] as? Bool == true }
        XCTAssertEqual(targets.count, 1, "exactly one record may be the iOS target")
        XCTAssertEqual(targets.first?["appleId"] as? String, appleID)

        let superseded = records.filter { $0["appleId"] as? String == supersededAppleID }
        XCTAssertEqual(superseded.count, 1,
                       "the superseded record \(supersededAppleID) is no longer recorded; it "
                       + "still exists at Apple and would read as a plausible target")
        XCTAssertEqual(superseded.first?["targetForIosRelease"] as? Bool, false)
        XCTAssertEqual(superseded.first?["bundleId"] as? String, supersededBundleID)
    }

    /// **The packet still says the iOS platform is not submission-ready**, its
    /// open blocking gates are exactly build selection and screenshots, and iOS
    /// is still unreleased.
    ///
    /// The migration turned most of this record's gates green at once — the
    /// catalogue, App Privacy, pricing and availability were all already
    /// configured for the released macOS app — and that is precisely the moment
    /// a packet drifts into claiming readiness it has not got. What is asserted
    /// is the shape of the remaining work, not that anything is finished.
    ///
    /// The `released: false` half is asserted here rather than left to the
    /// validator because it is the claim a reader is most likely to get wrong
    /// from the record alone: this record IS publicly released, on macOS. The
    /// delivery state is scoped to the iOS platform, and iOS is not public.
    func testThePacketReportsExactlyTwoOpenBlockingGatesAndNoReadiness() throws {
        let observation = try XCTUnwrap(
            try packet()["appStoreConnectObservation"] as? [String: Any])
        XCTAssertEqual(observation["fullySubmissionReady"] as? Bool, false,
                       "the packet claims the iOS platform is fully submission-ready")

        let fields = try XCTUnwrap(observation["observedFields"] as? [[String: Any]])
        let open = fields
            .filter { ($0["blocksSubmission"] as? Bool == true)
                && ($0["present"] as? Bool == false) }
            .compactMap { $0["id"] as? String }
        XCTAssertEqual(open, ["version-build-selection", "screenshots"],
                       "the open blocking gates changed; if that is real, the prose in "
                       + "apps/README.md and docs/ios-app-store-submission.md states the same "
                       + "two and must change with it")

        let delivery = try XCTUnwrap(observation["deliveryState"] as? [String: Any])
        XCTAssertEqual(delivery["platform"] as? String, "iOS",
                       "the delivery state stopped being scoped to iOS; unqualified, its "
                       + "negatives would be a claim about a record whose macOS platform is "
                       + "publicly released")
        for claim in ["archived", "uploaded", "submittedForReview", "released"] {
            XCTAssertEqual(delivery[claim] as? Bool, false,
                           "the packet claims the iOS platform has been \(claim)")
        }

        // Manual release was READ BACK as selected, not merely intended. The
        // distinction is the whole reason this is asserted: an intent is
        // something a later author may quietly revise, and an observation is
        // something they must go and re-read.
        XCTAssertEqual(delivery["releaseType"] as? String, "manual",
                       "the iOS version would release itself the moment review passes")
        XCTAssertEqual(delivery["releaseTypeObservedOnTheRecord"] as? Bool, true,
                       "manual release was demoted from an observation to an intention")
    }

    /// **No credential, contact value or demo login is in the packet.**
    ///
    /// The App Review contact and demo fields are owner-entered in App Store
    /// Connect. The packet is allowed to NAME them — that list is how a future
    /// author learns they are owner-entered — but must carry no value for any
    /// of them, and no address, phone number or secret anywhere else.
    func testThePacketCarriesNoCredentialOrContactValue() throws {
        let text = try RepoRoot.text("docs/app-store-metadata-ios.json")

        // An email address. The packet's own URLs contain no `@`, so any
        // local-part@domain shape in it is a contact value.
        let email = try NSRegularExpression(
            pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        XCTAssertEqual(email.numberOfMatches(in: text, range: range), 0,
                       "the packet contains an email address")

        let appReview = try XCTUnwrap(try packet()["appReview"] as? [String: Any])
        let ownerEntered = try XCTUnwrap(appReview["ownerEnteredFields"] as? [[String: Any]])
        XCTAssertFalse(ownerEntered.isEmpty)
        for field in ownerEntered {
            let name = try XCTUnwrap(field["field"] as? String)
            // The entry may say WHERE the value is entered, and nothing else.
            XCTAssertEqual(Set(field.keys), ["field", "enteredIn"],
                           "the owner-entered field \(name) carries more than its name and "
                           + "location; a value may never be recorded here")
            XCTAssertEqual(field["enteredIn"] as? String, "App Store Connect only")
        }
    }
}
