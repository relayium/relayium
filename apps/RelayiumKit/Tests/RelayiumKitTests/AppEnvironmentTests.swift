import XCTest
@testable import RelayiumAppKit

final class AppEnvironmentTests: XCTestCase {
    func testProductionBaseURLIsTheServiceOrigin() {
        XCTAssertEqual(AppEnvironment.productionBaseURL.absoluteString, "https://relayium.com")
    }
    // Never empty: it becomes the device name in the user's device list on the web.
    func testDeviceNameIsNeverEmpty() {
        XCTAssertFalse(AppEnvironment.deviceName().isEmpty)
    }
    // The site root is the LAN transfer page, not an account page. Paths mirror
    // web/src/lib/router.svelte.ts (ME_PATH, PRICING_PATH).
    func testWebHandOffPathsAreTheAccountPagesNotTheHomepage() {
        XCTAssertEqual(AppEnvironment.accountWebURL.absoluteString, "https://relayium.com/me")
        XCTAssertEqual(AppEnvironment.plansWebURL.absoluteString, "https://relayium.com/pricing")
    }

    // The token *is* the button: a frozen account cannot sign in, so without it
    // the "Reactivate" hand-off lands on a page that cannot help. The fragment
    // shape is what web/src/lib/Account.svelte reads on mount.
    func testReactivateURLCarriesTheTokenInTheFragment() {
        let url = AppEnvironment.reactivateWebURL(token: "react_abc")
        XCTAssertEqual(url.absoluteString,
                       "https://relayium.com/me#account=pending_deletion&token=react_abc")
    }

    // Percent-encoded like the web's encodeURIComponent, so a token containing
    // `&` or `#` cannot forge another fragment parameter.
    func testReactivateURLPercentEncodesTheToken() {
        let url = AppEnvironment.reactivateWebURL(token: "a b&account=x#y")
        XCTAssertEqual(url.absoluteString,
                       "https://relayium.com/me#account=pending_deletion&token=a%20b%26account%3Dx%23y")
    }

    func testKeychainIdentityMatchesTheBundle() {
        XCTAssertEqual(AppEnvironment.keychainService, "com.relayium.mac")
        XCTAssertEqual(AppEnvironment.keychainAccount, "bearer-token")
    }

    func testKeychainAccessGroupIsTheSharedTeamGroup() {
        // Shared, not the default per-app group: R3's iOS app reads the same
        // credential, and changing this later would cost a data migration.
        XCTAssertEqual(AppEnvironment.keychainAccessGroup,
                       "7PVYUG4YQS.com.relayium.shared")
    }
}
