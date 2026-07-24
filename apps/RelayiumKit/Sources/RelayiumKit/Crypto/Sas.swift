import Foundation
import Clibsodium

public let COMMIT_BYTES = 32
public let NONCE_BYTES = 32

/// Unkeyed BLAKE2b = libsodium crypto_generichash.
public func genericHash(_ input: [UInt8], outputLength: Int) -> [UInt8] {
    ensureSodiumInit()
    var out = [UInt8](repeating: 0, count: outputLength)
    _ = crypto_generichash(&out, outputLength, input, UInt64(input.count), nil, 0)
    return out
}

private func bytewiseLE(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    for i in 0..<Swift.min(a.count, b.count) { if a[i] != b[i] { return a[i] < b[i] } }
    return a.count <= b.count
}

public func sas(_ selfPub: [UInt8], _ peerPub: [UInt8]) -> String {
    ensureSodiumInit()
    let (a, b) = bytewiseLE(selfPub, peerPub) ? (selfPub, peerPub) : (peerPub, selfPub)
    let digest = genericHash(a + b, outputLength: 8)
    let hi = UInt32(digest[0]) << 24 | UInt32(digest[1]) << 16 | UInt32(digest[2]) << 8 | UInt32(digest[3])
    let lo = UInt32(digest[4]) << 24 | UInt32(digest[5]) << 16 | UInt32(digest[6]) << 8 | UInt32(digest[7])
    let num = hi ^ lo
    return String(format: "%06u", num % 1_000_000)
}

public func randomNonce() -> [UInt8] {
    ensureSodiumInit()
    var n = [UInt8](repeating: 0, count: NONCE_BYTES)
    randombytes_buf(&n, NONCE_BYTES)
    return n
}

public func commitKey(pub: [UInt8], nonce: [UInt8]) -> [UInt8] {
    ensureSodiumInit()
    return genericHash(pub + nonce, outputLength: COMMIT_BYTES)
}

public func verifyCommit(commit: [UInt8], pub: [UInt8], nonce: [UInt8]) -> Bool {
    let expected = commitKey(pub: pub, nonce: nonce)
    guard commit.count == expected.count else { return false }
    return sodium_memcmp(commit, expected, expected.count) == 0
}
