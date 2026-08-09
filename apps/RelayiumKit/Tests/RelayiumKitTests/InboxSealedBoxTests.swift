import XCTest
import Sodium
import Clibsodium
@testable import RelayiumKit

/// A FROZEN `x25519-sealedbox-v1` vector, and why it is built the way it is.
///
/// The thing that must be true is not "our unseal is self-consistent" — it is
/// "a content key sealed by the browser or by the Go CLI opens HERE". A round
/// trip through `sodium.box.seal(message:recipientPublicKey:)` would prove
/// neither: it would test one libsodium function against its own inverse and stay
/// green if libsodium and the other implementations ever disagreed.
///
/// So the vector below is constructed from the `crypto_box_seal` SPECIFICATION,
/// by a different code path from the one under test:
///
///     epk, esk := an ephemeral key pair          (FIXED here, so this is deterministic)
///     nonce    := blake2b-24(epk || recipient_pk)
///     box      := crypto_box_easy(content_key, nonce, recipient_pk, esk)
///     sealed   := epk || box
///
/// That construction uses `crypto_generichash` and the GENERIC `crypto_box_easy`;
/// the implementation under test uses `crypto_box_seal_open`, which derives its
/// own nonce internally.
///
/// The literals themselves are the ones the Go receiver's own vector test
/// freezes (`server/internal/inboxclient/keys_test.go`). That is the point: they
/// are an INDEPENDENT expected value, produced by another implementation, not
/// something this file emitted on the day it was written
/// (WORKFLOW-LEARNINGS, 2026-08-08).
private enum SealedBoxVector {
    static let recipientPrivate = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
    static let recipientPublic = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw"
    static let contentKey = "oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr8"
    static let sealed = "ST6C_HRGSlkmiBdiPSBTxeuOLMSpiLT-4XnsawENUx1q8tdz56xOSU0-O_VGIK_yNzZs"
        + "ZoI6QA1K1SYWtACQgTQCLPNtFFjWMnchw1aDECg"
}

final class InboxSealedBoxTests: XCTestCase {

    private func decode(_ encoded: String, _ length: Int) throws -> [UInt8] {
        try InboxKeyMaterial.decode(encoded, expecting: length)
    }

    private func vectorKeyPair() throws -> InboxDeviceKeyPair {
        InboxDeviceKeyPair(publicKey: try decode(SealedBoxVector.recipientPublic, 32),
                           privateKey: try decode(SealedBoxVector.recipientPrivate, 32))
    }

    // MARK: - the frozen vector

    /// Rebuild the sealed box from the specification and assert it is
    /// byte-identical to the frozen literal. This is what binds the literal to a
    /// real construction rather than to whatever the implementation emitted.
    func testTheSpecificationRebuildsTheFrozenVectorByteForByte() throws {
        var recipientSecret = [UInt8](repeating: 0, count: 32)
        var ephemeralSecret = [UInt8](repeating: 0, count: 32)
        for i in 0..<32 {
            recipientSecret[i] = UInt8(i + 1)
            ephemeralSecret[i] = UInt8(0x80 ^ i)
        }
        var recipientPublic = [UInt8](repeating: 0, count: 32)
        var ephemeralPublic = [UInt8](repeating: 0, count: 32)
        XCTAssertEqual(crypto_scalarmult_base(&recipientPublic, recipientSecret), 0)
        XCTAssertEqual(crypto_scalarmult_base(&ephemeralPublic, ephemeralSecret), 0)
        XCTAssertEqual(InboxKeyMaterial.encode(recipientPublic), SealedBoxVector.recipientPublic)

        let nonce = try XCTUnwrap(sodium.genericHash.hash(message: ephemeralPublic + recipientPublic,
                                                          outputLength: 24))
        let content = try decode(SealedBoxVector.contentKey, 32)
        let box = try XCTUnwrap(sodium.box.seal(message: content,
                                                recipientPublicKey: recipientPublic,
                                                senderSecretKey: ephemeralSecret,
                                                nonce: nonce))
        XCTAssertEqual(InboxKeyMaterial.encode(ephemeralPublic + box), SealedBoxVector.sealed)
        XCTAssertEqual(ephemeralPublic.count + box.count, InboxProtocol.sealedBoxBytes)
    }

    /// The interoperability assertion: the product opens a sealed box it did not
    /// create, built to the libsodium specification and frozen by another
    /// implementation.
    func testTheProductOpensTheFrozenVector() throws {
        let opened = try InboxKeyMaterial.unsealContentKey(algorithm: InboxProtocol.keyAlgorithm,
                                                           wrappedKey: SealedBoxVector.sealed,
                                                           keyPair: vectorKeyPair())
        XCTAssertEqual(opened, try decode(SealedBoxVector.contentKey, 32))
    }

    // MARK: - refusals

    /// A sealed box that opened under ANY key would mean the wrapping proves
    /// nothing.
    func testAWrongPrivateKeyIsRefusedOpaquely() throws {
        let wrong = try InboxKeyMaterial.generateKeyPair()
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: SealedBoxVector.sealed,
            keyPair: wrong)) {
            // Opaque on purpose: distinguishing "wrong key" from "tampered box"
            // would leak an oracle, and the caller's response is the same either way.
            XCTAssertEqual($0 as? InboxKeyError, .unseal)
        }
    }

    /// The subtler case. `crypto_box_seal` derives its nonce from the recipient
    /// PUBLIC key, so a mismatched pair must fail too — otherwise a caller could
    /// be tricked into unsealing against a public key it did not publish.
    func testAMismatchedPublicPrivatePairIsRefused() throws {
        let other = try InboxKeyMaterial.generateKeyPair()
        let mixed = InboxDeviceKeyPair(publicKey: other.publicKey,
                                       privateKey: try decode(SealedBoxVector.recipientPrivate, 32))
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm, wrappedKey: SealedBoxVector.sealed,
            keyPair: mixed))
    }

    /// Poly1305 is what makes "central could not have swapped the content key"
    /// true. If this ever passed, central could substitute a key it chose and read
    /// the file.
    func testTamperingAtAnyOffsetIsRefused() throws {
        let raw = try decode(SealedBoxVector.sealed, InboxProtocol.sealedBoxBytes)
        // The ephemeral public key, the tag and the ciphertext, one byte each.
        for index in [0, 31, 40, raw.count - 1] {
            var tampered = raw
            tampered[index] ^= 0x01
            XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
                algorithm: InboxProtocol.keyAlgorithm,
                wrappedKey: InboxKeyMaterial.encode(tampered),
                keyPair: vectorKeyPair()), "byte \(index) still opened")
        }
    }

    /// Length is checked EXACTLY, before any crypto runs: what is wrapped is fixed
    /// by this protocol version, so any other length is a peer sealing something
    /// else.
    func testATruncatedOrOverLongBoxIsRefused() throws {
        let raw = try decode(SealedBoxVector.sealed, InboxProtocol.sealedBoxBytes)
        for bad in [Array(raw.dropLast()), raw + [0]] {
            XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
                algorithm: InboxProtocol.keyAlgorithm,
                wrappedKey: InboxKeyMaterial.encode(bad), keyPair: vectorKeyPair())) {
                XCTAssertEqual($0 as? InboxKeyError, .malformedKeyMaterial)
            }
        }
    }

    func testAnUnknownWrapAlgorithmIsRefused() throws {
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: "x25519-sealedbox-v2", wrappedKey: SealedBoxVector.sealed,
            keyPair: vectorKeyPair())) {
            XCTAssertEqual($0 as? InboxKeyError, .unsupportedAlgorithm)
        }
    }

    // MARK: - one canonical spelling

    /// An encoded key is an IDENTITY in this protocol: "is this the key central
    /// named?" is a string comparison. Multiple spellings of one key would weaken
    /// every such comparison, so the decoder refuses all but one.
    func testOnlyOneSpellingOfAKeyIsAccepted() throws {
        let raw = try decode(SealedBoxVector.contentKey, 32)
        let canonical = InboxKeyMaterial.encode(raw)
        XCTAssertEqual(canonical, SealedBoxVector.contentKey)

        // Padded base64url decodes to identical bytes but is a second spelling.
        XCTAssertThrowsError(try decode(canonical + "=", 32))
        // Standard base64 uses `+` and `/`.
        let standard = Data(raw).base64EncodedString()
        if standard.contains("+") || standard.contains("/") {
            XCTAssertThrowsError(try decode(standard.replacingOccurrences(of: "=", with: ""), 32))
        }
        // Whitespace and an empty string.
        XCTAssertThrowsError(try decode(" " + canonical, 32))
        XCTAssertThrowsError(try decode("", 32))
    }

    /// The trailing-bit case `Data(base64Encoded:)` does NOT catch on its own:
    /// two spellings that decode to the same bytes. A permissive decoder accepts
    /// both; this one accepts only the canonical one.
    func testANonCanonicalTrailingBitSpellingIsRefused() throws {
        // One byte, encoded two ways. "AQ" is canonical for 0x01; "AR" decodes to
        // the same byte with a different final sextet.
        XCTAssertEqual(try InboxKeyMaterial.decode("AQ", expecting: 1), [0x01])
        XCTAssertThrowsError(try InboxKeyMaterial.decode("AR", expecting: 1))
    }

    // MARK: - public-key validation

    /// A low-order point parses, is the right length, and every "wrap" to it is
    /// recoverable by anybody. Rejecting at REGISTRATION means no sender ever
    /// wraps a content key to one.
    ///
    /// The expected verdicts are not this file's opinion: each was read off
    /// central's own `inbox.ValidatePublicKey` (Go, `crypto/ecdh`) and is asserted
    /// here against libsodium's `crypto_scalarmult`. The two must refuse EXACTLY
    /// the same set — a key one side accepts and the other refuses is either an
    /// unusable device (Swift stricter) or a wrappable-to-nobody key central would
    /// publish (Swift laxer). The two ACCEPTED rows are as load-bearing as the
    /// refusals: without them a validator that refused everything would pass.
    func testTheRefusedPublicKeySetMatchesCentralsExactly() throws {
        func hex(_ s: String) -> [UInt8] {
            stride(from: 0, to: s.count, by: 2).map { i in
                let start = s.index(s.startIndex, offsetBy: i)
                return UInt8(s[start...s.index(after: start)], radix: 16)!
            }
        }
        let cases: [(name: String, hex: String, refused: Bool)] = [
            ("zero", "0000000000000000000000000000000000000000000000000000000000000000", true),
            ("one", "0100000000000000000000000000000000000000000000000000000000000000", true),
            ("order8a", "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", true),
            ("order8b", "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157", true),
            ("p-1", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", true),
            ("p", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", true),
            ("p+1", "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", true),
            // Not low-order, and central accepts both. They keep this assertion
            // from being satisfied by a validator that simply says no.
            ("basepoint", "0900000000000000000000000000000000000000000000000000000000000000", false),
            ("allOnes", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", false),
        ]
        for testCase in cases {
            let encoded = InboxKeyMaterial.encode(hex(testCase.hex))
            if testCase.refused {
                XCTAssertThrowsError(try InboxKeyMaterial.validatePublicKey(
                    algorithm: InboxProtocol.keyAlgorithm, encoded: encoded),
                    "\(testCase.name) was accepted") {
                    XCTAssertEqual($0 as? InboxKeyError, .unusablePublicKey, testCase.name)
                }
            } else {
                XCTAssertNoThrow(try InboxKeyMaterial.validatePublicKey(
                    algorithm: InboxProtocol.keyAlgorithm, encoded: encoded),
                    "\(testCase.name) was refused")
            }
        }
    }

    func testAGeneratedKeyIsOneCentralWouldAccept() throws {
        for _ in 0..<8 {
            let pair = try InboxKeyMaterial.generateKeyPair()
            XCTAssertEqual(pair.publicKey.count, 32)
            XCTAssertEqual(pair.privateKey.count, 32)
            XCTAssertNoThrow(try InboxKeyMaterial.validatePublicKey(
                algorithm: InboxProtocol.keyAlgorithm,
                encoded: InboxKeyMaterial.encode(pair.publicKey)))
        }
    }

    /// A freshly generated device key is usable by the sender side as it actually
    /// exists: the sender calls `crypto_box_seal` with the PUBLISHED public key,
    /// and this device must open it.
    func testAFreshDeviceKeyOpensABoxSealedToItsPublishedPublicKey() throws {
        let pair = try InboxKeyMaterial.generateKeyPair()
        let published = InboxKeyMaterial.encode(pair.publicKey)
        let publicBytes = try InboxKeyMaterial.validatePublicKey(
            algorithm: InboxProtocol.keyAlgorithm, encoded: published)
        let content = generateStoreKey()
        let sealed = try XCTUnwrap(sodium.box.seal(message: content,
                                                   recipientPublicKey: publicBytes))
        let opened = try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            wrappedKey: InboxKeyMaterial.encode(sealed), keyPair: pair)
        XCTAssertEqual(opened, content)
    }

    func testAWrongLengthPublicKeyIsMalformedRatherThanUnusable() {
        XCTAssertThrowsError(try InboxKeyMaterial.validatePublicKey(
            algorithm: InboxProtocol.keyAlgorithm,
            encoded: InboxKeyMaterial.encode([UInt8](repeating: 7, count: 31)))) {
            XCTAssertEqual($0 as? InboxKeyError, .malformedKeyMaterial)
        }
    }

    /// A content key that is not 32 bytes fails HERE rather than at an AEAD call
    /// whose error would read as "corrupt data".
    func testAnUnsealedKeyOfTheWrongLengthIsRefused() throws {
        let pair = try InboxKeyMaterial.generateKeyPair()
        // A sealed box of a 16-byte payload is 64 bytes, so it is refused by the
        // exact length check before the AEAD runs at all — which is the point.
        let short = try XCTUnwrap(sodium.box.seal(message: [UInt8](repeating: 3, count: 16),
                                                   recipientPublicKey: pair.publicKey))
        XCTAssertEqual(short.count, 64)
        XCTAssertThrowsError(try InboxKeyMaterial.unsealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            wrappedKey: InboxKeyMaterial.encode(short), keyPair: pair)) {
            XCTAssertEqual($0 as? InboxKeyError, .malformedKeyMaterial)
        }
    }

    func testZeroingOverwritesKeyMaterial() {
        var key: [UInt8] = [1, 2, 3, 4]
        InboxKeyMaterial.zero(&key)
        XCTAssertEqual(key, [0, 0, 0, 0])
    }
}
