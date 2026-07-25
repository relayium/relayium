import Foundation

public enum HandshakeError: Error, Equatable { case mitm, noCommitRecorded, badBase64 }
public struct HandshakeResult: Equatable {
    public let keys: SessionKeys
    public let sas: String
}

public final class HandshakeState {
    private let role: Role
    private let keypair: KeyPair
    private let nonce: [UInt8]
    private var peerCommit: [UInt8]?
    public let selfCommitBase64: String

    public init(role: Role) {
        self.role = role
        self.keypair = generateKeyPair()
        self.nonce = randomNonce()
        self.selfCommitBase64 = Data(commitKey(pub: keypair.publicKey, nonce: nonce)).base64EncodedString()
    }

    public func recordPeerCommit(_ b64: String) throws {
        guard let d = Data(base64Encoded: b64) else { throw HandshakeError.badBase64 }
        peerCommit = [UInt8](d)
    }

    public func reveal() -> Reveal {
        Reveal(key: Data(keypair.publicKey).base64EncodedString(),
               nonce: Data(nonce).base64EncodedString())
    }

    public func verifyPeerReveal(_ r: Reveal) throws -> HandshakeResult {
        guard let commit = peerCommit else { throw HandshakeError.noCommitRecorded }
        guard let keyD = Data(base64Encoded: r.key), let nonceD = Data(base64Encoded: r.nonce) else {
            throw HandshakeError.badBase64
        }
        let peerPub = [UInt8](keyD)
        guard verifyCommit(commit: commit, pub: peerPub, nonce: [UInt8](nonceD)) else {
            throw HandshakeError.mitm
        }
        let keys = try deriveSession(role: role, self: keypair, peerPublic: peerPub)
        return HandshakeResult(keys: keys, sas: sas(keypair.publicKey, peerPub))
    }
}
