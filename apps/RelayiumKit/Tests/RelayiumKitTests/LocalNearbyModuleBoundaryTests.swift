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
