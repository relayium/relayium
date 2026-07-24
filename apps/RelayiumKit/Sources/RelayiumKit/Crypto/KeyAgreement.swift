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

public struct SessionKeys {
    public let send: [UInt8]  // sharedTx
    public let recv: [UInt8]  // sharedRx
}

public func generateKeyPair() -> KeyPair {
    var pk = [UInt8](repeating: 0, count: Int(crypto_kx_PUBLICKEYBYTES))
    var sk = [UInt8](repeating: 0, count: Int(crypto_kx_SECRETKEYBYTES))
    crypto_kx_keypair(&pk, &sk)
    return KeyPair(publicKey: pk, secretKey: sk)
}

public func deriveSession(role: Role, self selfKeys: KeyPair, peerPublic: [UInt8]) -> SessionKeys {
    var rx = [UInt8](repeating: 0, count: Int(crypto_kx_SESSIONKEYBYTES))
    var tx = [UInt8](repeating: 0, count: Int(crypto_kx_SESSIONKEYBYTES))
    switch role {
    case .initiator:
        crypto_kx_client_session_keys(&rx, &tx, selfKeys.publicKey, selfKeys.secretKey, peerPublic)
    case .responder:
        crypto_kx_server_session_keys(&rx, &tx, selfKeys.publicKey, selfKeys.secretKey, peerPublic)
    }
    return SessionKeys(send: tx, recv: rx)
}
