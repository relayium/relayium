import Foundation
import Sodium
import Clibsodium

/// Device key material for `x25519-sealedbox-v1`.
///
/// The wrapping primitive is libsodium's `crypto_box_seal`: X25519 +
/// XSalsa20-Poly1305 under an EPHEMERAL sender key, so no sender long-term key
/// has to exist — the queue's authorisation is the ACCOUNT, not a sender
/// identity (protocol doc §2). Central cannot open one: it never holds a device
/// private key, and there is no request field that could carry one.
///
/// This file is the only place in the native client that touches a private key
/// or an unsealed content key. It produces raw bytes and consumes raw bytes;
/// persistence is `InboxKeyStore`'s job. Neither a private key nor a content key
/// is ever formatted into an error, a log line or a request body — the errors
/// here carry no associated values at all.

/// One X25519 identity. `privateKey` is the raw 32-byte scalar; `publicKey` is
/// the raw 32-byte point, both in the spelling central validates.
///
/// Named `InboxDeviceKeyPair` rather than `KeyPair` because `RelayiumKit`
/// already has a `KeyPair` for the realtime key exchange, and the two are
/// different key types for different protocols. One name for two would be a
/// mistake waiting for a call site.
public struct InboxDeviceKeyPair: Equatable, Sendable {
    public let publicKey: [UInt8]
    public let privateKey: [UInt8]

    public init(publicKey: [UInt8], privateKey: [UInt8]) {
        self.publicKey = publicKey
        self.privateKey = privateKey
    }
}

public enum InboxKeyError: Error, Equatable, Sendable {
    /// The encoded value is not canonical unpadded base64url, or is the wrong
    /// length for what it names.
    case malformedKeyMaterial
    /// A syntactically valid public key that must never be used: a low-order
    /// Curve25519 point drives every X25519 exchange to the all-zero shared
    /// secret, so a content key "wrapped" to it is wrapped to a value the whole
    /// world can compute.
    case unusablePublicKey
    /// The sealed box did not open under this device's key.
    ///
    /// Deliberately opaque: distinguishing "wrong key" from "tampered box" would
    /// leak an oracle, and the caller's response is the same either way — the
    /// task cannot be decrypted here.
    case unseal
    /// A wrap algorithm token this build does not implement.
    case unsupportedAlgorithm
    /// The device's own key generation failed, or produced material central
    /// would refuse. Never silently retried: publishing an unusable public key
    /// would make every task sealed to it undecryptable by anybody.
    case generationFailed
    /// The sealing primitive failed, or produced a box this protocol version
    /// does not define.
    ///
    /// Separate from `generationFailed` because the remedy differs: that one
    /// says this device cannot mint an identity, this one says a SEND could not
    /// be wrapped. Carries nothing, for the same reason as every case above.
    case sealFailed
}

public enum InboxKeyMaterial {

    // MARK: - encoding

    /// The one spelling rule for raw key bytes on the wire: base64url without
    /// padding, matching central's `EncodePublicKey` and the `#k=` content-key
    /// encoding, so a client implements one rule everywhere.
    public static func encode(_ raw: [UInt8]) -> String {
        Data(raw).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The STRICT inverse.
    ///
    /// Strictness is not pedantry here: an encoded key is an IDENTITY in this
    /// protocol — "is this the key central named?" is a string comparison, and a
    /// key reused check is a string comparison — so one key must have exactly one
    /// spelling. Padding, whitespace, the standard `+`/`/` alphabet and
    /// non-canonical trailing bits are all refused, which is what makes those
    /// comparisons sound (WORKFLOW-LEARNINGS, 2026-08-08: encoded security
    /// identities need one canonical spelling).
    public static func decode(_ encoded: String, expecting length: Int) throws -> [UInt8] {
        let alphabet = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard !encoded.isEmpty, encoded.allSatisfy({ alphabet.contains($0) }) else {
            throw InboxKeyError.malformedKeyMaterial
        }
        // Unpadded base64 cannot have a remainder of 1: no number of 6-bit groups
        // produces a single trailing character.
        let remainder = encoded.count % 4
        guard remainder != 1 else { throw InboxKeyError.malformedKeyMaterial }
        var padded = encoded.replacingOccurrences(of: "-", with: "+")
                            .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        guard let data = Data(base64Encoded: padded) else {
            throw InboxKeyError.malformedKeyMaterial
        }
        // The trailing-bit check `Data(base64Encoded:)` does NOT make: "AB" and
        // "AC" both decode to one byte, so a decoder that stops at the byte count
        // accepts two spellings of the same key. Re-encoding is the only check
        // that catches it, and it catches every other non-canonical form too.
        guard encode([UInt8](data)) == encoded else {
            throw InboxKeyError.malformedKeyMaterial
        }
        guard length <= 0 || data.count == length else {
            throw InboxKeyError.malformedKeyMaterial
        }
        return [UInt8](data)
    }

    // MARK: - public-key validation

    /// The domain string central derives its low-order probe scalar from. Written
    /// here so the two sides cannot drift: a device that generated a key central
    /// would refuse must find that out HERE, before the key is persisted and long
    /// before a sender wraps to it.
    // nonlocalized: protocol domain-separation constant, byte-identical to central
    static let lowOrderProbeDomain = "relayium-device-inbox-loworder-probe-v1"

    /// Validate an announced public key exactly as central's `ValidatePublicKey`
    /// does, in the same order: unknown algorithm, non-canonical base64url, wrong
    /// length, then a low-order point.
    ///
    /// The last check is the one that matters for the zero-knowledge promise.
    /// Such a key parses, is the right length, and every "wrap" to it is
    /// recoverable by anybody.
    @discardableResult
    public static func validatePublicKey(algorithm: String, encoded: String) throws -> [UInt8] {
        guard algorithm == InboxProtocol.keyAlgorithm else {
            throw InboxKeyError.unsupportedAlgorithm
        }
        let raw = try decode(encoded, expecting: InboxProtocol.publicKeyBytes)
        guard !isLowOrder(raw) else { throw InboxKeyError.unusablePublicKey }
        return raw
    }

    /// True for a public key whose X25519 exchange yields the all-zero shared
    /// secret.
    ///
    /// A FIXED probe scalar, derived from the same domain string central uses, so
    /// validation is deterministic and independent of the random source — any
    /// clamped scalar gives the same answer, because a low-order point drives the
    /// exchange to zero regardless of what it is multiplied by.
    ///
    /// `crypto_scalarmult` returns non-zero for exactly this set, which is why
    /// the return code is the check rather than a comparison against a list of
    /// literal points that a future curve implementation could extend.
    static func isLowOrder(_ publicKey: [UInt8]) -> Bool {
        guard publicKey.count == InboxProtocol.publicKeyBytes else { return true }
        ensureInboxSodium()
        var probe = [UInt8](repeating: 0, count: 32)
        let domain = Array(lowOrderProbeDomain.utf8)
        // SHA-256 of the domain string, matching central's `sha256.Sum256`, so
        // both sides probe with the identical scalar.
        crypto_hash_sha256(&probe, domain, UInt64(domain.count))
        var shared = [UInt8](repeating: 0, count: 32)
        let rc = crypto_scalarmult(&shared, probe, publicKey)
        // Zeroed whatever the outcome: a shared secret has no business outliving
        // the one comparison it exists for.
        for i in shared.indices { shared[i] = 0 }
        return rc != 0
    }

    // MARK: - key generation

    /// Mint a fresh device key, then re-validate its own public half through
    /// `validatePublicKey`.
    ///
    /// That re-validation is not ceremony. A key central would reject — wrong
    /// length, non-canonical encoding, a low-order point — must fail HERE, before
    /// it is persisted and long before a sender could wrap a content key to
    /// something the whole world can open.
    public static func generateKeyPair() throws -> InboxDeviceKeyPair {
        ensureInboxSodium()
        guard let pair = sodium.box.keyPair(),
              pair.publicKey.count == InboxProtocol.publicKeyBytes,
              pair.secretKey.count == 32 else {
            throw InboxKeyError.generationFailed
        }
        let kp = InboxDeviceKeyPair(publicKey: pair.publicKey, privateKey: pair.secretKey)
        do {
            try validatePublicKey(algorithm: InboxProtocol.keyAlgorithm,
                                  encoded: encode(kp.publicKey))
        } catch {
            throw InboxKeyError.generationFailed
        }
        return kp
    }

    // MARK: - sealing

    /// Wrap a 32-byte AES-256-GCM content key to a TARGET device's announced
    /// public key, producing the `wrappedKey` a task create carries.
    ///
    /// The sender-side inverse of `unsealContentKey`, and deliberately written
    /// beside it: the two halves of one primitive drifting apart is how a
    /// delivery becomes undecryptable on a machine that reports no error.
    ///
    /// The target key goes through `validatePublicKey`, which is central's own
    /// order of checks — unknown algorithm, non-canonical base64url, wrong
    /// length, low-order point. The last one is the reason this cannot be a
    /// bare `crypto_box_seal`: a low-order target key parses, is the right
    /// length, and drives the X25519 exchange to the all-zero shared secret, so
    /// the "sealed" content key would be recoverable by anybody who saw the
    /// queue row. A sender that skipped this check would publish the user's file
    /// key to the world while every status in the UI stayed green.
    ///
    /// The content key is length-checked EXACTLY, before any crypto runs. What
    /// is wrapped is fixed by this protocol version, and a short key must fail
    /// here rather than produce a box the receiver refuses hours later with an
    /// error that reads as corruption.
    ///
    /// The RESULT is length-checked too, and returned as canonical base64url —
    /// the same spelling rule the receiver decodes with, so one key has one
    /// spelling on both sides of the queue.
    ///
    /// Nothing here logs, persists or formats the content key: it arrives as
    /// bytes, leaves as a sealed box, and the errors carry no associated values.
    public static func sealContentKey(algorithm: String, targetPublicKey: String,
                                      contentKey: [UInt8]) throws -> String {
        let recipient = try validatePublicKey(algorithm: algorithm, encoded: targetPublicKey)
        guard contentKey.count == 32 else { throw InboxKeyError.malformedKeyMaterial }
        ensureInboxSodium()
        guard let sealed = sodium.box.seal(message: contentKey, recipientPublicKey: recipient),
              sealed.count == InboxProtocol.sealedBoxBytes else {
            throw InboxKeyError.sealFailed
        }
        return encode(sealed)
    }

    // MARK: - unsealing

    /// Open an `x25519-sealedbox-v1` wrapped key and return the 32-byte
    /// AES-256-GCM content key.
    ///
    /// The sealed box is length-checked FIRST, exactly rather than as a bound:
    /// what is wrapped is fixed by this protocol version, so any other length is
    /// a peer sealing something else — and a change to what is sealed has to be a
    /// new algorithm token, not a silently longer blob.
    ///
    /// The RESULT is length-checked too. Everything downstream (the manifest,
    /// every frame) is keyed by it, and a short key must fail here rather than at
    /// an AEAD call whose error would read as "corrupt data".
    public static func unsealContentKey(algorithm: String, wrappedKey: String,
                                        keyPair: InboxDeviceKeyPair) throws -> [UInt8] {
        guard algorithm == InboxProtocol.keyAlgorithm else {
            throw InboxKeyError.unsupportedAlgorithm
        }
        let sealed = try decode(wrappedKey, expecting: InboxProtocol.sealedBoxBytes)
        guard keyPair.publicKey.count == InboxProtocol.publicKeyBytes,
              keyPair.privateKey.count == 32 else {
            throw InboxKeyError.malformedKeyMaterial
        }
        ensureInboxSodium()
        guard let content = sodium.box.open(anonymousCipherText: sealed,
                                            recipientPublicKey: keyPair.publicKey,
                                            recipientSecretKey: keyPair.privateKey) else {
            throw InboxKeyError.unseal
        }
        guard content.count == 32 else { throw InboxKeyError.unseal }
        return content
    }

    /// Overwrite key material in place.
    ///
    /// Best effort by construction — Swift arrays may have been copied by ARC —
    /// but it bounds how long the one secret in this process that can decrypt the
    /// user's file stays in a heap that may be swapped or written to a core file.
    public static func zero(_ bytes: inout [UInt8]) {
        for i in bytes.indices { bytes[i] = 0 }
    }
}

/// libsodium readiness for the direct `Clibsodium` calls above.
///
/// `sodium` is the shared handle whose construction performs `sodium_init`; this
/// mirrors `ensureSodiumInit` in `Sodium+Ready.swift`, which is `internal` to
/// that file's own module scope.
@inline(__always) func ensureInboxSodium() {
    precondition(sodiumReady(), "libsodium is not initialised")   // nonlocalized: precondition
}
