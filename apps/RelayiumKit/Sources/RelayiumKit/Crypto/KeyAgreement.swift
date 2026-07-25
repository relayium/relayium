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

public enum Role { case initiator, responder }

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
