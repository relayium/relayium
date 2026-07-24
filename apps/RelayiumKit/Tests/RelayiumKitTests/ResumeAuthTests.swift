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
    /// Pins deriveResumeAuth to the golden vector: resumeAuth.keyHex is computed
    /// from aliceK.sharedTx/sharedRx, i.e. session.aliceSend/session.aliceRecv.
    func testDeriveResumeAuthMatchesGoldenVector() throws {
        let v = try Vectors.load()
        XCTAssertEqual(
            deriveResumeAuth(sendKey: v.hex("session.aliceSend"), recvKey: v.hex("session.aliceRecv")),
            v.hex("resumeAuth.keyHex")
        )
    }
    /// A syntactically valid base64 payload (32 zero bytes) with the wrong MAC
    /// must not verify.
    func testVerifyResumeRejectsValidBase64WithWrongMac() throws {
        let v = try Vectors.load()
        let key = v.hex("resumeAuth.keyHex")
        let payload = v.str("resumeAuth.payload")
        XCTAssertFalse(verifyResume(key: key, payload: payload,
                                     mac: Data(repeating: 0, count: 32).base64EncodedString()))
    }
}
