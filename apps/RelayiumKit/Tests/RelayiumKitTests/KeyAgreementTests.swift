import XCTest
@testable import RelayiumKit

final class KeyAgreementTests: XCTestCase {
    func testDeriveSessionMatchesVectors() throws {
        let v = try Vectors.load()
        let alice = KeyPair(publicKey: v.hex("alice.pub"), secretKey: v.hex("alice.sec"))
        let bobPub = v.hex("bob.pub")
        let keys = deriveSession(role: .initiator, self: alice, peerPublic: bobPub)
        XCTAssertEqual(keys.send, v.hex("session.aliceSend"))
        XCTAssertEqual(keys.recv, v.hex("session.aliceRecv"))
    }
}
