import XCTest
@testable import RelayiumKit

final class SasTests: XCTestCase {
    func testSasMatchesVectorAndIsOrderIndependent() throws {
        let v = try Vectors.load()
        let a = v.hex("alice.pub"), b = v.hex("bob.pub")
        XCTAssertEqual(sas(a, b), v.str("sas"))
        XCTAssertEqual(sas(b, a), v.str("sas")) // order independent
    }
    func testCommitMatchesVectorAndVerifies() throws {
        let v = try Vectors.load()
        let pub = v.hex("alice.pub"), nonce = v.hex("commit.nonce")
        let c = commitKey(pub: pub, nonce: nonce)
        XCTAssertEqual(c, v.hex("commit.value"))
        XCTAssertTrue(verifyCommit(commit: c, pub: pub, nonce: nonce))
        XCTAssertFalse(verifyCommit(commit: Array(c.dropLast()), pub: pub, nonce: nonce))
    }
}
