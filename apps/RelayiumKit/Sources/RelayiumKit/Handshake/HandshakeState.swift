import Foundation

public enum HandshakeError: Error, Equatable { case mitm, noCommitRecorded, badBase64, invalidKey }
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

    // Duplicate-reveal suppression and commit-immutability are intentionally NOT
    // enforced here — this is a pure state machine; the WebRTC driver above it
    // owns message-ordering/replay policy.
    public func verifyPeerReveal(_ r: Reveal) throws -> HandshakeResult {
        guard let commit = peerCommit else { throw HandshakeError.noCommitRecorded }
        guard let keyD = Data(base64Encoded: r.key), let nonceD = Data(base64Encoded: r.nonce) else {
            throw HandshakeError.badBase64
        }
        let peerPub = [UInt8](keyD)
        let peerNonce = [UInt8](nonceD)
        // verifyCommit only proves BLAKE2b(peerPub||nonce)==commit; it does not
        // constrain peerPub.count. Without this guard a malicious peer can commit
        // to a short key and reveal it, passing verifyCommit, then deriveSession's
        // libsodium call reads a fixed 32 bytes from peerPub — an out-of-bounds
        // native read on a short buffer. Reject before verifyCommit/deriveSession.
        guard peerPub.count == 32, peerNonce.count == 32 else { throw HandshakeError.invalidKey }
        guard verifyCommit(commit: commit, pub: peerPub, nonce: peerNonce) else {
            throw HandshakeError.mitm
        }
        let keys = try deriveSession(role: role, self: keypair, peerPublic: peerPub)
        return HandshakeResult(keys: keys, sas: sas(keypair.publicKey, peerPub))
    }
}
