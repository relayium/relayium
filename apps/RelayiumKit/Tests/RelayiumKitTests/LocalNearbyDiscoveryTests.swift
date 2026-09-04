import XCTest
@testable import RelayiumKit
@testable import RelayiumLocalPeerKit

final class LocalNearbyDiscoveryTests: XCTestCase {
    private let id = "0123456789abcdef0123456789abcdef"
    private let caps = ["text/1", "link/1"]

    func testServiceScopeIsOneLocalTCPType() {
        XCTAssertEqual(LOCAL_PEER_SERVICE_TYPE, "_relayium._tcp")
        XCTAssertEqual(LOCAL_PEER_SERVICE_DOMAIN, "local.")
    }

    func testIdentityIsFreshLowercaseHex() {
        let first = LocalPeerAdvertisement.mintIdentity()
        let second = LocalPeerAdvertisement.mintIdentity()
        XCTAssertTrue(LocalPeerAdvertisement.isValidIdentity(first))
        XCTAssertTrue(LocalPeerAdvertisement.isValidIdentity(second))
        XCTAssertNotEqual(first, second)
    }

    func testExactAdvertisementRoundTrips() {
        let value = LocalPeerAdvertisement(identity: id, name: "iPad", capabilities: caps)
        XCTAssertEqual(value.serviceInstanceName, id)
        XCTAssertEqual(value.txtRecord["c"], "text/1,link/1")
        XCTAssertEqual(LocalPeerAdvertisement.parse(instanceName: id,
                                                     txtRecord: value.txtRecord), value)
    }

    /// What goes on the wire is what the roster hello and the SDP confirmation
    /// compose, read from one function. Two spellings of "what this build
    /// speaks" is how an advertisement promises a wire the routing predicate
    /// then refuses.
    func testAdvertisedCapabilitiesAreTheSameListTheHelloAnnounces() {
        XCTAssertEqual(
            capsField(LocalNearbyEnvironment.advertisedCapabilities),
            linkCapsHello(linkRoomActive: linkRoomActive(isCodelessRoom: true)))
    }

    func testMalformedOrExpandedAdvertisementsAreRejected() {
        let valid = ["i": id, "n": "iPhone", "c": "text/1"]
        func mutated(_ changes: [String: String?]) -> [String: String] {
            var copy = valid
            for (key, value) in changes { copy[key] = value }
            return copy
        }

        XCTAssertNotNil(LocalPeerAdvertisement.parse(instanceName: id, txtRecord: valid))
        // Instance name and advertised identity must be the same claim.
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: String(id.dropLast()),
                                                   txtRecord: valid))
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                   txtRecord: mutated(["i": id.uppercased()])))
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id, txtRecord: mutated(["n": ""])))
        XCTAssertNil(LocalPeerAdvertisement.parse(
            instanceName: id, txtRecord: mutated(["n": String(repeating: "x", count: 65)])))
        // An unknown key is an incompatible record, not a partly understood one.
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                   txtRecord: mutated(["account": "secret"])))
        // A record with no capability field at all is the OLD shape, and this
        // build must not admit it and then guess what it speaks.
        XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                   txtRecord: mutated(["c": nil])))
    }

    /// A capability list this build could not have meant is a record it does not
    /// understand. Admitting the advertisement with the survivable tokens would
    /// list a device as able to do something nobody established.
    func testMaliciousCapabilityFieldsRejectTheWholeAdvertisement() {
        for field in ["",                                        // no claim at all
                      ",",                                       // two empty claims
                      "text/1,",                                 // trailing empty claim
                      ",text/1",                                 // leading empty claim
                      "text/1,text/1",                           // one claim, twice
                      "text/1 ",                                 // whitespace a comparison cannot match
                      "link/1\u{0}",                             // embedded NUL
                      "li\u{202e}nk/1",                          // bidi override
                      String(repeating: "x", count: 25),         // over the per-token bound
                      (1...9).map { "c/\($0)" }.joined(separator: ",")] { // over the list bound
            XCTAssertNil(LocalPeerAdvertisement.parse(instanceName: id,
                                                       txtRecord: ["i": id, "n": "iPhone",
                                                                   "c": field]),
                         "the capability field \(field.debugDescription) was admitted")
        }

        // And the bounds admit what they are meant to admit.
        XCTAssertEqual(LocalPeerAdvertisement.parse(
            instanceName: id,
            txtRecord: ["i": id, "n": "iPhone", "c": "text/1,link/1"])?.capabilities,
                       ["text/1", "link/1"])
    }

    /// A peer that announces a wire this build does not speak is admitted and
    /// carried VERBATIM. Rewriting it to something recognisable is the forgery;
    /// `PeerCapabilityRegistry.supports` is where exactness is enforced.
    func testUnknownCapabilitiesSurviveParsingUnchanged() {
        XCTAssertEqual(LocalPeerAdvertisement.parse(
            instanceName: id,
            txtRecord: ["i": id, "n": "iPhone", "c": "link/2"])?.capabilities, ["link/2"])
    }
}
