import Foundation
import CryptoKit

private let RESUME_AUTH_DOMAIN = Array("relayium-resume-auth-v1\0".utf8)

private func resumeSortLess(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    for i in 0..<Swift.min(a.count, b.count) { if a[i] != b[i] { return a[i] < b[i] } }
    return a.count <= b.count
}

/// 32-byte HMAC key = BLAKE2b(domain || sorted(tx,rx)). Sorting makes both peers
/// derive the same key from their mirrored session secrets.
public func deriveResumeAuth(sendKey tx: [UInt8], recvKey rx: [UInt8]) -> [UInt8] {
    let (a, b) = resumeSortLess(tx, rx) ? (tx, rx) : (rx, tx)
    return genericHash(RESUME_AUTH_DOMAIN + a + b, outputLength: 32)
}

public func signResume(key: [UInt8], payload: String) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: Array(payload.utf8), using: SymmetricKey(data: key))
    return Data(mac).base64EncodedString()
}

public func verifyResume(key: [UInt8], payload: String, mac: String?) -> Bool {
    guard let mac, let sig = Data(base64Encoded: mac) else { return false }
    return HMAC<SHA256>.isValidAuthenticationCode(
        sig,
        authenticating: Array(payload.utf8),
        using: SymmetricKey(data: key)
    )
}
