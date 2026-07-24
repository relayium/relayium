import XCTest
@testable import RelayiumKit

final class ResumeAuthTests: XCTestCase {
    func testDeriveAndSignMatchVectors() throws {
        let v = try Vectors.load()
        // resumeAuth.keyHex is the derived HMAC key; verify signResume reproduces the mac.
        let key = v.hex("resumeAuth.keyHex")
        let payload = v.str("resumeAuth.payload")
        XCTAssertEqual(signResume(key: key, payload: payload), v.str("resumeAuth.mac"))
        XCTAssertTrue(verifyResume(key: key, payload: payload, mac: v.str("resumeAuth.mac")))
        XCTAssertFalse(verifyResume(key: key, payload: payload, mac: nil))
        XCTAssertFalse(verifyResume(key: key, payload: payload, mac: "not-base64!!"))
    }
    func testDeriveResumeAuthIsSymmetric() throws {
        let v = try Vectors.load()
        let tx = v.hex("session.aliceSend"), rx = v.hex("session.aliceRecv")
        // both key orderings must yield the same derived key (sorted internally)
        XCTAssertEqual(deriveResumeAuth(sendKey: tx, recvKey: rx),
                       deriveResumeAuth(sendKey: rx, recvKey: tx))
    }
}
