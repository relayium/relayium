import XCTest
@testable import RelayiumLocalPeerKit

final class LocalNearbyModuleBoundaryTests: XCTestCase {
    func testIOSDeclaresAndLinksExactlyTheLocalPeerProduct() throws {
        let plistData = try RepoRoot.data("apps/ios/Relayium/Info.plist")
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: plistData, format: nil)
                as? [String: Any])
        XCTAssertEqual(plist["NSBonjourServices"] as? [String], [LOCAL_PEER_SERVICE_TYPE])

        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")
        XCTAssertTrue(project.contains("productName = RelayiumLocalPeerKit;"))
        XCTAssertTrue(project.contains("RelayiumLocalPeerKit in Frameworks"))
        XCTAssertTrue(try RepoRoot.text("apps/ios/Relayium/RelayiumApp.swift")
            .contains("import RelayiumLocalPeerKit"))
    }

    func testMacAndShareExtensionDoNotImportOrDeclareLocalDiscovery() throws {
        for root in ["apps/mac", "apps/ios/RelayiumShare"] {
            for file in try RepoRoot.swiftFiles(under: root) {
                XCTAssertFalse(try RepoRoot.text(of: file).contains("RelayiumLocalPeerKit"),
                               "\(file.path) imports the iOS-only local peer product")
            }
        }
        let extensionData = try RepoRoot.data("apps/ios/RelayiumShare/Info.plist")
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: extensionData, format: nil)
                as? [String: Any])
        XCTAssertNil(plist["NSBonjourServices"])
    }

    /// The invariant the whole batch is bounded by: only the iOS Nearby
    /// DISCOVERY channel moved. macOS still joins the hub's code-less room, and
    /// a diff that quietly pointed it at Bonjour would change a shipped
    /// platform's rendezvous without anything failing.
    func testMacOSStillBuildsItsRosterFromTheServerRendezvous() throws {
        let app = try RepoRoot.text("apps/mac/Relayium/RelayiumApp.swift")
        XCTAssertTrue(app.contains("AppEnvironment.makeLanDiscoveryModel("),
                      "macOS no longer joins the hub's code-less room")
        XCTAssertFalse(app.contains("LocalNearbyEnvironment"))
    }

    /// The narrow scope, asserted against the module that actually holds the
    /// machinery rather than only against the app target that imports it.
    /// Everything here turns "one product service on this link" into "the
    /// network this device is on", which is the claim the purpose string and
    /// the App Review answers both refuse to make.
    func testTheLocalPeerModuleInspectsNoNetworkBeyondItsOwnService() throws {
        let root = try RepoRoot.directory("apps/RelayiumKit/Sources/RelayiumLocalPeerKit")
        for file in try RepoRoot.swiftFiles(under: "apps/RelayiumKit/Sources/RelayiumLocalPeerKit") {
            let text = try RepoRoot.text(of: file)
            for symbol in ["CNCopyCurrentNetworkInfo", "NEHotspotNetwork", "NEHotspotHelper",
                           "CWWiFiClient", "getifaddrs", "SCNetworkReachability",
                           "NWEthernetChannel", "includePeerToPeer = true",
                           "requiredInterfaceType", "multicast"] {
                XCTAssertFalse(text.contains(symbol),
                               "\(file.lastPathComponent) reaches for \(symbol)")
            }
        }
        // One service type, spelled once, in the one place that owns it.
        let occurrences = try FileManager.default.contentsOfDirectory(at: root,
                                                                       includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
            .map { try String(contentsOf: $0).components(separatedBy: "\"_relayium._tcp\"").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(occurrences, 1,
                       "the Bonjour service type is spelled somewhere other than its constant")
    }

    /// The iOS built-App harness drives the LINK, and the macOS one still
    /// drives the hub's code-less room.
    ///
    /// A source-text guard because what has to stay opposite is a wiring choice
    /// made by two shell scripts, which nothing else in this suite observes: iOS
    /// discovery moved to `_relayium._tcp`, macOS discovery did not.
    func testTheIOSBuiltAppHarnessDrivesTheLinkAndTheMacOneStillDrivesTheRoom() throws {
        let ios = try RepoRoot.text("scripts/ios-ui-session-acceptance.sh")
        XCTAssertTrue(ios.contains("start_peer local-link-peer local-link-peer"),
                      "the iOS built-App harness no longer starts a local link peer")
        XCTAssertFalse(ios.contains("start_peer nearby-receiver"),
                       "the iOS built-App harness is back on the hub's code-less "
                       + "room, which no shipped iOS build browses")

        let mac = try RepoRoot.text("scripts/macos-ui-session-acceptance.sh")
        XCTAssertTrue(mac.contains("start_peer nearby-receiver nearby-receiver"),
                      "the macOS built-App harness left the hub's code-less room, "
                      + "which is still where macOS discovery joins")
        XCTAssertFalse(mac.contains("local-link-peer"),
                       "the macOS harness adopted the iOS-only local link")
    }

    /// The acceptance peer advertises the product's own capabilities over the
    /// product's own transport and channel.
    ///
    /// `LocalNearbyEnvironment.makeDiscoveryModel` names its peer
    /// `AppEnvironment.deviceName()`, which is one constant string per machine
    /// and unusable for a roster assertion on a shared build agent — so the
    /// harness composes the discovery model itself, and that one copy is the
    /// drift risk pinned here. The channel must also still be armed through
    /// `PreparedNearbyConnection.activate`, the ordering that stops a
    /// synchronously ready local transport from announcing a roster into
    /// callbacks `LanDiscoveryModel` has not installed yet.
    func testTheAcceptancePeerAdvertisesWhatTheProductAdvertises() throws {
        let peer = try RepoRoot.text("apps/RelayiumKit/Sources/LocalTransferPeer/main.swift")
        XCTAssertTrue(peer.contains("capabilities: LocalNearbyEnvironment.advertisedCapabilities"),
                      "the acceptance peer announces a hand-written capability list")
        XCTAssertTrue(peer.contains("LocalPeerSignalingChannel(")
                      && peer.contains("advertisement: advertisement"),
                      "the acceptance peer no longer builds the shipped local channel "
                      + "from its own advertisement")
        XCTAssertTrue(peer.contains("transport: NetworkLocalPeerTransport("),
                      "the acceptance peer no longer uses the shipped Bonjour transport")
        XCTAssertTrue(peer.contains("activate: { channel.begin() }"),
                      "the acceptance peer arms its transport before LanDiscoveryModel "
                      + "has installed its callbacks")
        // A string literal here would be a second spelling of the constant,
        // which is the rule `testTheLocalPeerModuleInspectsNoNetworkBeyondItsOwnService`
        // applies one module in.
        XCTAssertFalse(peer.contains("\"_relayium._tcp\""),
                       "the acceptance peer spells the service type itself instead of "
                       + "reaching the link through the shipped transport")

        // And the module reaches this executable only.
        let manifest = try RepoRoot.text("apps/RelayiumKit/Package.swift")
        let harness = try XCTUnwrap(
            manifest.components(separatedBy: ".executableTarget(")
                .first { $0.contains("name: \"LocalTransferPeer\"") },
            "the LocalTransferPeer harness target is gone")
        XCTAssertTrue(harness.contains("\"RelayiumLocalPeerKit\""),
                      "the harness can no longer reach the local link")
        for other in ["RealtimeE2E", "NearbyReceiveE2E"] {
            let target = try XCTUnwrap(
                manifest.components(separatedBy: ".executableTarget(")
                    .first { $0.contains("name: \"\(other)\"") })
            XCTAssertFalse(target.contains("RelayiumLocalPeerKit"),
                           "\(other) gained the local link module")
        }
    }

    /// The same-host seam is absent from Release, inert without its full gate,
    /// and never widens peer-to-peer policy.
    ///
    /// The behavioural half — what each answer resolves in a Debug build — is in
    /// `LocalNearbyDiscoveryTests`. This is what no Debug test can observe: that
    /// the permissive branch is compiled out of a Release build entirely, and
    /// that the launch argument reaching it is guarded by the acceptance gate.
    func testTheSameHostSeamIsDebugOnlyGatedAndNeverWidensPeerToPeer() throws {
        let transport = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumLocalPeerKit/NetworkLocalPeerTransport.swift")
        let policy = try XCTUnwrap(
            transport.components(separatedBy: "static func parameters(").dropFirst().first?
                .components(separatedBy: "\n    }").first,
            "the interface policy is gone")
        XCTAssertTrue(policy.contains("#if DEBUG") && policy.contains("#else"),
                      "the permissive answer is no longer compiled out of Release")
        // The Release arm, which is everything after `#else`, states the
        // prohibition unconditionally and names the seam nowhere.
        let release = try XCTUnwrap(policy.components(separatedBy: "#else").last)
        XCTAssertTrue(release.contains("prohibitedInterfaceTypes = [.loopback]"),
                      "the Release arm no longer prohibits loopback outright")
        XCTAssertFalse(release.contains("sameHostAcceptanceAllowsLoopback"),
                       "the Release arm consults the acceptance seam")
        // One assignment, on its own line, that the seam is not named on.
        let peerToPeer = policy.split(separator: "\n").filter { $0.contains("includePeerToPeer") }
        XCTAssertEqual(peerToPeer.count, 1, "peer-to-peer is decided in more than one place")
        XCTAssertTrue(peerToPeer.first?.contains("= false") == true,
                      "peer-to-peer is no longer unconditionally off")
        XCTAssertFalse(peerToPeer.first?.contains("sameHostAcceptanceAllowsLoopback") == true,
                       "the seam reaches peer-to-peer policy")

        // The gate: the argument alone decides nothing. `allowsResidency` is
        // itself `isActive && AppEnvironment.isLoopbackTransferOrigin`, so this
        // is the full three-condition rule.
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        XCTAssertTrue(mode.contains("static let allowsSameHostLoopback = allowsResidency"),
                      "the same-host seam is no longer gated by the acceptance harness "
                      + "and its loopback origin")
        XCTAssertTrue(mode.contains("static let allowsResidency = isActive "
                                    + "&& AppEnvironment.isLoopbackTransferOrigin"),
                      "the residency gate the same-host seam is built on has changed")
        XCTAssertTrue(mode.contains("static let allowsSameHostLoopback = false"),
                      "the Release branch of UITestMode no longer folds the seam away")

        // And only the app's own Debug composition passes it on. No other
        // shipped source names it at all.
        let app = try RepoRoot.text("apps/ios/Relayium/RelayiumApp.swift")
        // The discovery graph is composed ONCE — `IOSSurfaceGuardTests` owns
        // that invariant — and only the transport FACTORY is compile
        // conditional. The one `#if DEBUG … #else … #endif` that builds it is
        // sliced whole, so each arm is read from its own side of it.
        let composition = try XCTUnwrap(
            app.components(separatedBy: "#if DEBUG")
                .first { $0.contains("let localTransport") }?
                .components(separatedBy: "#endif").first,
            "the app no longer chooses its transport behind a Debug seam")
        let arms = composition.components(separatedBy: "#else")
        XCTAssertEqual(arms.count, 2, "the transport factory has no single Release arm")
        let debugArm = try XCTUnwrap(arms.first)
        let releaseArm = try XCTUnwrap(arms.last)
        XCTAssertTrue(debugArm.contains("UITestMode.allowsSameHostLoopback"),
                      "the app's Debug factory no longer reads the gate")
        XCTAssertTrue(releaseArm.contains("NetworkLocalPeerTransport()"),
                      "the Release factory is no longer the default construction")
        XCTAssertFalse(releaseArm.contains("sameHostAcceptanceAllowsLoopback"),
                       "the Release factory names the seam")

        let seam = "sameHostAcceptanceAllowsLoopback"
        for root in ["apps/mac", "apps/RelayiumKit/Sources/RelayiumAppKit",
                     "apps/RelayiumKit/Sources/RelayiumKit",
                     "apps/RelayiumKit/Sources/RelayiumShareKit",
                     "apps/RelayiumKit/Sources/RelayiumStoreKit"] {
            for file in try RepoRoot.swiftFiles(under: root) {
                XCTAssertFalse(try RepoRoot.text(of: file).contains(seam),
                               "\(file.path) opts a shipped composition out of the "
                               + "loopback prohibition")
            }
        }
        // `LocalNearbyEnvironment` is the composition seam itself and must keep
        // taking the default by saying nothing about it at all.
        let environment = try RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumLocalPeerKit/LocalNearbyEnvironment.swift")
        XCTAssertTrue(environment.contains("NetworkLocalPeerTransport()"),
                      "the iOS composition seam no longer defaults to a default transport")
        XCTAssertFalse(environment.contains(seam),
                       "the iOS composition seam opts out of the loopback prohibition")
    }

    func testNetworkFrameworkIsConfinedToTheConcreteTransport() throws {
        let root = try RepoRoot.directory("apps/RelayiumKit/Sources/RelayiumLocalPeerKit")
        let importers = try FileManager.default.contentsOfDirectory(at: root,
                                                                     includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
            .filter { try String(contentsOf: $0).contains("import Network") }
            .map(\.lastPathComponent)
        XCTAssertEqual(importers, ["NetworkLocalPeerTransport.swift"])
    }
}
