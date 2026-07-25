import XCTest
@testable import RelayiumKit

final class KeyAgreementTests: XCTestCase {
    func testDeriveSessionMatchesVectors() throws {
        let v = try Vectors.load()
        let alice = KeyPair(publicKey: v.hex("alice.pub"), secretKey: v.hex("alice.sec"))
        let bobPub = v.hex("bob.pub")
        let keys = try deriveSession(role: .initiator, self: alice, peerPublic: bobPub)
        XCTAssertEqual(keys.send, v.hex("session.aliceSend"))
        XCTAssertEqual(keys.recv, v.hex("session.aliceRecv"))
    }

    func testDeriveSessionRejectsShortPeerKey() throws {
        let alice = generateKeyPair()
        XCTAssertThrowsError(
            try deriveSession(role: .initiator, self: alice, peerPublic: [1,2,3,4])
        ) { error in
            XCTAssertEqual(error as? CryptoError, CryptoError.keyAgreementFailed)
        }
    }

    func testDeriveSessionThrowsOnInvalidPeerKey() throws {
        let v = try Vectors.load()
        let alice = KeyPair(publicKey: v.hex("alice.pub"), secretKey: v.hex("alice.sec"))
        let allZeroPeerPublic = [UInt8](repeating: 0, count: 32)
        XCTAssertThrowsError(
            try deriveSession(role: .initiator, self: alice, peerPublic: allZeroPeerPublic)
        ) { error in
            XCTAssertEqual(error as? CryptoError, CryptoError.keyAgreementFailed)
        }
    }
}
