import Foundation
import Sodium
import Clibsodium

public struct KeyPair {
    public let publicKey: [UInt8]
    public let secretKey: [UInt8]
    public init(publicKey: [UInt8], secretKey: [UInt8]) {
        self.publicKey = publicKey; self.secretKey = secretKey
    }
}

/// Which side of a key agreement — and, above it, of a connection — this is.
///
/// `Sendable` because it is exactly what it looks like: two cases, no associated
/// values, no reference storage, nothing to mutate. It is decided once per
/// connection and then read from the socket's delivery queue, the main actor and
/// the WebRTC callback threads at the same time, so the conformance states a
/// property the type already had rather than granting it a new one. Without it,
/// every `Sendable` decision enum that carries a role (`LinkAdmissionDecision`,
/// `LinkIntent`) is a Swift 6 error.
public enum Role: Sendable { case initiator, responder }

public struct SessionKeys: Equatable {
    public let send: [UInt8]  // sharedTx
    public let recv: [UInt8]  // sharedRx
}

public enum CryptoError: Error, Equatable {
    case keyAgreementFailed
}

public func generateKeyPair() -> KeyPair {
    ensureSodiumInit()
    var pk = [UInt8](repeating: 0, count: Int(crypto_kx_PUBLICKEYBYTES))
    var sk = [UInt8](repeating: 0, count: Int(crypto_kx_SECRETKEYBYTES))
    _ = crypto_kx_keypair(&pk, &sk)
    return KeyPair(publicKey: pk, secretKey: sk)
}

public func deriveSession(role: Role, self selfKeys: KeyPair, peerPublic: [UInt8]) throws -> SessionKeys {
    ensureSodiumInit()
    // Belt-and-suspenders: crypto_kx_{client,server}_session_keys read a FIXED
    // crypto_kx_PUBLICKEYBYTES from peerPublic's buffer regardless of its actual
    // Swift array length. A short/malformed peerPublic here would be an
    // out-of-bounds native read. Callers (e.g. HandshakeState) should already
    // reject bad lengths before reaching this point, but this is the real
    // boundary to the unsafe C call, so it's guarded here too for every caller
    // (including the future Realtime module).
    guard peerPublic.count == Int(crypto_kx_PUBLICKEYBYTES) else { throw CryptoError.keyAgreementFailed }
    var rx = [UInt8](repeating: 0, count: Int(crypto_kx_SESSIONKEYBYTES))
    var tx = [UInt8](repeating: 0, count: Int(crypto_kx_SESSIONKEYBYTES))
    let rc: Int32
    switch role {
    case .initiator:
        rc = crypto_kx_client_session_keys(&rx, &tx, selfKeys.publicKey, selfKeys.secretKey, peerPublic)
    case .responder:
        rc = crypto_kx_server_session_keys(&rx, &tx, selfKeys.publicKey, selfKeys.secretKey, peerPublic)
    }
    guard rc == 0 else { throw CryptoError.keyAgreementFailed }
    return SessionKeys(send: tx, recv: rx)
}
