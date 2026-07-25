import XCTest
@testable import RelayiumKit

final class HandshakeStateTests: XCTestCase {
    func testTwoPartyDerivesMirroredKeysAndMatchingSAS() throws {
        let a = HandshakeState(role: .initiator)
        let b = HandshakeState(role: .responder)
        // exchange commits
        try a.recordPeerCommit(b.selfCommitBase64)
        try b.recordPeerCommit(a.selfCommitBase64)
        // exchange + verify reveals
        let ra = try b.verifyPeerReveal(a.reveal())   // b verifies a's reveal
        let rb = try a.verifyPeerReveal(b.reveal())   // a verifies b's reveal
        // same 6-digit SAS on both sides
        XCTAssertEqual(ra.sas, rb.sas)
        XCTAssertEqual(ra.sas.count, 6)
        // mirrored session keys: a.send == b.recv and a.recv == b.send
        XCTAssertEqual(rb.keys.send, ra.keys.recv)
        XCTAssertEqual(rb.keys.recv, ra.keys.send)
    }
    func testMitmRevealRejected() throws {
        let a = HandshakeState(role: .initiator)
        let b = HandshakeState(role: .responder)
        try b.recordPeerCommit(a.selfCommitBase64)
        // a "reveals" a DIFFERENT key than it committed to (a middleman swapped it)
        var forged = a.reveal()
        let evil = HandshakeState(role: .initiator)     // some other keypair
        forged = Reveal(key: evil.reveal().key, nonce: forged.nonce)
        XCTAssertThrowsError(try b.verifyPeerReveal(forged)) { XCTAssertEqual($0 as? HandshakeError, .mitm) }
    }
    func testRevealWithoutRecordedCommitThrows() {
        let a = HandshakeState(role: .initiator)
        let b = HandshakeState(role: .responder)
        XCTAssertThrowsError(try b.verifyPeerReveal(a.reveal())) { XCTAssertEqual($0 as? HandshakeError, .noCommitRecorded) }
    }
    func testShortPeerKeyRejectedBeforeDerive() throws {
        let b = HandshakeState(role: .responder)
        let shortKey: [UInt8] = [1,2,3,4]            // 4 bytes, not 32
        let nonce = randomNonce()
        let commit = commitKey(pub: shortKey, nonce: nonce)   // b commits-records this
        try b.recordPeerCommit(Data(commit).base64EncodedString())
        let reveal = Reveal(key: Data(shortKey).base64EncodedString(), nonce: Data(nonce).base64EncodedString())
        XCTAssertThrowsError(try b.verifyPeerReveal(reveal)) { XCTAssertEqual($0 as? HandshakeError, .invalidKey) }
    }
    func testCommitAndSASMatchCryptoVectors() throws {
        // Reuse R1-A crypto-vectors: commitKey(alicePub, commit.nonce) == commit.value; sas(alice,bob)==sas.
        let v = try Vectors.load()   // crypto-vectors
        XCTAssertEqual(Data(commitKey(pub: v.hex("alice.pub"), nonce: v.hex("commit.nonce"))).base64EncodedString(),
                       Data(v.hex("commit.value")).base64EncodedString())
        XCTAssertEqual(sas(v.hex("alice.pub"), v.hex("bob.pub")), v.str("sas"))
    }
}
