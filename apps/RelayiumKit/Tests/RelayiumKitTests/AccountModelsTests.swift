import XCTest
@testable import RelayiumKit

final class AccountModelsTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, _ type: T.Type) throws -> T {
        let url = Bundle.module.url(forResource: name, withExtension: "json")!
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
    func testDecodeMe() throws {
        let me = try fixture("me", MeResponse.self)
        XCTAssertEqual(me.user.email, "a@b.co")
        XCTAssertEqual(me.user.planId, "pro")
        XCTAssertEqual(me.user.billingCycle, "monthly")
        XCTAssertTrue(me.user.hasBilling)
    }
    func testDecodeUsageUnlimitedStorage() throws {
        let u = try fixture("me-usage", UsageResponse.self)
        XCTAssertEqual(u.period, "202607")
        XCTAssertEqual(u.traffic.cap, 5_368_709_120)
        XCTAssertEqual(u.storage.cap, 0)          // 0 = unlimited
        XCTAssertTrue(u.storage.isUnlimited)
        XCTAssertFalse(u.traffic.isUnlimited)
        XCTAssertEqual(u.plan.name, "Pro")
        XCTAssertFalse(u.plan.isTop)
    }
    /// The shipped fixtures deliberately carry NO `entitlementProvider`: they
    /// are what a server that predates the field sends. Decoding them must
    /// still succeed and must report "no provider" rather than inventing one —
    /// an app that refused these payloads would lock users out for the window
    /// between an app release and the deployment that follows it.
    func testOlderPayloadsWithoutEntitlementProviderStillDecode() throws {
        let me = try fixture("me", MeResponse.self)
        XCTAssertNil(me.user.entitlementProvider)
        let usage = try fixture("me-usage", UsageResponse.self)
        XCTAssertNil(usage.plan.entitlementProvider)
    }

    func testEntitlementProviderDecodesWhenPresent() throws {
        let json = Data("""
        { "user": { "id":"u_1","email":"a@b.co","displayName":"Ada","hasPassword":true,
          "emailVerified":true,"linkedMethods":["password"],"onlyOwnNodes":false,
          "planId":"pro","subscriptionStatus":"active","subscriptionEnd":1790000000,
          "hasBilling":false,"scheduledPlanId":"","scheduledCycle":"","billingCycle":"monthly",
          "entitlementProvider":"apple" } }
        """.utf8)
        let me = try JSONDecoder().decode(MeResponse.self, from: json)
        XCTAssertEqual(me.user.entitlementProvider, "apple")
        // An App Store subscriber is subscribed WITHOUT a Stripe customer: the
        // two fields are independent and neither may be derived from the other.
        XCTAssertFalse(me.user.hasBilling)
        XCTAssertEqual(me.user.planId, "pro")
    }

    func testDecodeLoginSuccess() throws {
        let ok = try fixture("login-success", LoginSuccessBody.self)  // see AccountModels
        XCTAssertEqual(ok.token, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(ok.user.email, "a@b.co")
        XCTAssertEqual(ok.user.displayName, "Ada")
    }
}
