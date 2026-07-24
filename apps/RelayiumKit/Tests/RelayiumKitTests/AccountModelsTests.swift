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
    func testDecodeLoginSuccess() throws {
        let ok = try fixture("login-success", LoginSuccessBody.self)  // see AccountModels
        XCTAssertEqual(ok.token, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(ok.user.email, "a@b.co")
        XCTAssertEqual(ok.user.displayName, "Ada")
    }
}
