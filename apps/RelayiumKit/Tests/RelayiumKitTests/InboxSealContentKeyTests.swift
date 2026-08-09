import XCTest
import Sodium
import Clibsodium
@testable import RelayiumKit

/// The SENDER half of `x25519-sealedbox-v1`: `InboxKeyMaterial.sealContentKey`.
///
/// `InboxSealedBoxTests` proves the opening half against a frozen vector another
/// implementation produced. This file proves the sealing half, and the two
/// non-negotiable properties it has to have are not "it round-trips":
///
///  1. the box it emits is one the RECEIVER's own code opens, back to the exact
///     content key it was handed, at exactly the protocol length;
///  2. it refuses every target key central would refuse — before any crypto
///     runs — because a low-order or non-canonical target key is how a sender
///     silently publishes the user's file key while every status stays green.
///
/// The cross-LANGUAGE proof of (1) — the box opened by the real Go
/// implementation in another process — is `InboxSealedBoxInteropTests`. In-
/// process, the opening side is `unsealContentKey`, which is itself pinned to a
/// vector this file did not write.
final class InboxSealContentKeyTests: XCTestCase {

    private func decode(_ encoded: String, _ length: Int) throws -> [UInt8] {
        try InboxKeyMaterial.decode(encoded, expecting: length)
    }

    // MARK: - the sealing contract

    /// A box this sender produces opens on the receiver, to the byte.
    func testASealedContentKeyOpensOnTheReceiverToTheSameBytes() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        let content = generateStoreKey()

        let wrapped = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(device.publicKey),
            contentKey: content)

        let opened = try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: wrapped, keyPair: device)
        XCTAssertEqual(opened, content)
    }

    /// The wire form is canonical unpadded base64url of EXACTLY the protocol
    /// length. Central applies the same two checks and rejects anything else, so
    /// a drift here would fail every create after the ciphertext was uploaded.
    func testTheEncodedBoxIsCanonicalBase64urlOfTheExactProtocolLength() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        let wrapped = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(device.publicKey),
            contentKey: generateStoreKey())

        XCTAssertFalse(wrapped.contains("="))
        XCTAssertFalse(wrapped.contains("+"))
        XCTAssertFalse(wrapped.contains("/"))
        let raw = try decode(wrapped, InboxProtocol.sealedBoxBytes)
        XCTAssertEqual(raw.count, InboxProtocol.sealedBoxBytes)
        // Canonical by re-encoding, the same rule `decode` enforces: one key,
        // one spelling, on both sides of the queue.
        XCTAssertEqual(InboxKeyMaterial.encode(raw), wrapped)
    }

    /// Two seals of the SAME key to the SAME device differ, because
    /// `crypto_box_seal` mints a fresh ephemeral key each time.
    ///
    /// Asserted so a future "optimisation" that cached or derived the ephemeral
    /// key fails here: a repeated ephemeral key across two boxes reuses the
    /// XSalsa20 stream and leaks the XOR of the two content keys.
    func testEachSealUsesAFreshEphemeralKey() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        let content = generateStoreKey()
        let first = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(device.publicKey), contentKey: content)
        let second = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(device.publicKey), contentKey: content)
        XCTAssertNotEqual(first, second)
        // Both still open to the same key: different boxes, one secret.
        for box in [first, second] {
            XCTAssertEqual(try InboxKeyMaterial.unsealContentKey(
                algorithm: InboxProtocol.keyAlgorithm, wrappedKey: box, keyPair: device), content)
        }
    }

    /// Sealed to THAT device and no other.
    func testABoxSealedToOneDeviceDoesNotOpenOnAnother() throws {
        let target = try InboxKeyMaterial.generateKeyPair()
        let other = try InboxKeyMaterial.generateKeyPair()
        let wrapped = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(target.publicKey),
            contentKey: generateStoreKey())

        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: wrapped, keyPair: other)) {
            XCTAssertEqual($0 as? InboxKeyError, .unseal)
        }
    }

    /// Poly1305 covers every byte of what this sender emits.
    func testTamperingWithAFreshlySealedBoxIsRefused() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        let wrapped = try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(device.publicKey),
            contentKey: generateStoreKey())
        let raw = try decode(wrapped, InboxProtocol.sealedBoxBytes)

        // The ephemeral key, the ciphertext and the tag.
        for index in [0, 31, 40, raw.count - 1] {
            var tampered = raw
            tampered[index] ^= 0x01
            XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
                algorithm: InboxProtocol.keyAlgorithm,
                wrappedKey: InboxKeyMaterial.encode(tampered), keyPair: device),
                "a box tampered at byte \(index) still opened")
        }
    }

    // MARK: - target-key refusals

    /// THE security assertion of this file.
    ///
    /// A low-order point parses, is 32 bytes, and drives the X25519 exchange to
    /// the all-zero shared secret — so a "sealed" content key would be
    /// recoverable by anybody who saw the queue row. Representative members
    /// beyond the obvious zero are refused; production detects the set through
    /// `crypto_scalarmult`, not through this test's literal list.
    func testEveryLowOrderTargetKeyIsRefusedBeforeAnythingIsSealed() throws {
        let lowOrder: [[UInt8]] = [
            [UInt8](repeating: 0, count: 32),
            {
                var p = [UInt8](repeating: 0, count: 32); p[0] = 1; return p
            }(),
            // The order-8 point from the canonical Curve25519 small-subgroup
            // list, which is neither 0 nor 1 and so cannot be caught by a
            // hand-written "is it trivial" check.
            [0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3,
             0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32,
             0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00],
            // p-1: a different congruent representative of the same refusal.
            [0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
             0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
             0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
        ]
        for key in lowOrder {
            XCTAssertThrowsError(try InboxKeyMaterial.sealContentKey(
                algorithm: InboxProtocol.keyAlgorithm,
                targetPublicKey: InboxKeyMaterial.encode(key),
                contentKey: generateStoreKey()),
                "a low-order target key was sealed to") {
                XCTAssertEqual($0 as? InboxKeyError, .unusablePublicKey)
            }
        }
    }

    /// Non-canonical spellings of a real key are refused, so "the key central
    /// named" stays a string comparison a sender can trust.
    func testANonCanonicalTargetKeyIsRefused() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        let canonical = InboxKeyMaterial.encode(device.publicKey)
        let variants = [
            canonical + "=",                                                  // padded
            canonical.replacingOccurrences(of: "-", with: "+"),               // wrong alphabet
            canonical.replacingOccurrences(of: "_", with: "/"),
            " " + canonical,                                                  // whitespace
            canonical + "A",                                                  // wrong length
            String(canonical.dropLast()),
            "",
        ]
        for variant in variants where variant != canonical {
            XCTAssertThrowsError(try InboxKeyMaterial.sealContentKey(
                algorithm: InboxProtocol.keyAlgorithm, targetPublicKey: variant,
                contentKey: generateStoreKey()),
                "the non-canonical target key \(variant.debugDescription) was accepted")
        }
    }

    /// An algorithm token this build does not implement never reaches the
    /// primitive: it is not this build's job to guess what a future wrap means.
    func testAnUnknownWrapAlgorithmIsRefused() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        for algorithm in ["x25519-sealedbox-v2", "X25519-SEALEDBOX-V1", "", "rsa-oaep"] {
            XCTAssertThrowsError(try InboxKeyMaterial.sealContentKey(
                algorithm: algorithm,
                targetPublicKey: InboxKeyMaterial.encode(device.publicKey),
                contentKey: generateStoreKey())) {
                XCTAssertEqual($0 as? InboxKeyError, .unsupportedAlgorithm)
            }
        }
    }

    /// EXACTLY 32 bytes, checked before any crypto runs. Sealing a shorter or
    /// longer payload would produce a box the receiver refuses hours later with
    /// an error that reads as corruption.
    func testAContentKeyOfTheWrongLengthIsRefused() throws {
        let device = try InboxKeyMaterial.generateKeyPair()
        let target = InboxKeyMaterial.encode(device.publicKey)
        for count in [0, 1, 16, 31, 33, 64] {
            XCTAssertThrowsError(try InboxKeyMaterial.sealContentKey(
                algorithm: InboxProtocol.keyAlgorithm, targetPublicKey: target,
                contentKey: [UInt8](repeating: 7, count: count)),
                "a \(count)-byte content key was sealed") {
                XCTAssertEqual($0 as? InboxKeyError, .malformedKeyMaterial)
            }
        }
    }

    /// The order of the two checks matters: an unusable target key must be
    /// refused even when the content key is also wrong, so a caller fixing the
    /// second one does not then discover the first.
    func testTheTargetKeyIsValidatedBeforeTheContentKeyLength() throws {
        var lowOrder = [UInt8](repeating: 0, count: 32)
        lowOrder[0] = 1
        XCTAssertThrowsError(try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(lowOrder),
            contentKey: [UInt8](repeating: 7, count: 16))) {
            XCTAssertEqual($0 as? InboxKeyError, .unusablePublicKey)
        }
    }
}
