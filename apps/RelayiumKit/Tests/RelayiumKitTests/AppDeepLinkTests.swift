import XCTest
@testable import RelayiumAppKit

@MainActor
final class AppDeepLinkTests: XCTestCase {
    func testParsesAValidatedDownloadLink() {
        let url = URL(string: "https://relayium.com/d/abc123#k=KEYPART")!
        XCTAssertEqual(parseAppDeepLink(url), .download(url))
    }

    func testParsesRealtimeWithOrWithoutACode() {
        XCTAssertEqual(
            parseAppDeepLink(URL(string: "https://relayium.com/cross-network#c=ACD234")!),
            .realtime(code: "ACD234")
        )
        XCTAssertEqual(
            parseAppDeepLink(URL(string: "https://relayium.com/cross-network")!),
            .realtime(code: nil)
        )
    }

    func testNormalizesPairingInputWithoutAdmittingAmbiguousCharacters() {
        XCTAssertEqual(normalizedPairingCode("a ci0-d2e3f4"), "ACD2E3")
        XCTAssertTrue(isCompletePairingCode("acd234"))
        XCTAssertFalse(isCompletePairingCode("ACDI34"))
        XCTAssertFalse(isCompletePairingCode("ACD23"))
    }

    func testRejectsUntrustedOrMalformedHandoffs() {
        let rejected = [
            "http://relayium.com/d/a#k=K",
            "https://evil.example/d/a#k=K",
            "https://relayium.com@evil.example/d/a#k=K",
            "https://relayium.com:8443/d/a#k=K",
            "https://relayium.com/d/a",
            "https://relayium.com/cross-network#c=ACDI34",
            "https://relayium.com/cross-network#c=ACD234&next=evil",
            "https://relayium.com/not-a-route",
        ]
        for value in rejected {
            XCTAssertNil(parseAppDeepLink(URL(string: value)!), value)
        }
    }

    func testRouterKeepsValidLinksUntilTheUIConsumesThem() {
        let router = AppDeepLinkRouter()
        let url = URL(string: "https://relayium.com/cross-network#c=ACD234")!
        XCTAssertTrue(router.open(url))
        XCTAssertEqual(router.pending, .realtime(code: "ACD234"))
        router.consume()
        XCTAssertNil(router.pending)
    }

    func testRouterDoesNotReplacePendingWorkWithAnInvalidURL() {
        let router = AppDeepLinkRouter()
        XCTAssertTrue(router.open(URL(string: "https://relayium.com/cross-network")!))
        XCTAssertFalse(router.open(URL(string: "https://example.com/cross-network")!))
        XCTAssertEqual(router.pending, .realtime(code: nil))
    }
}
