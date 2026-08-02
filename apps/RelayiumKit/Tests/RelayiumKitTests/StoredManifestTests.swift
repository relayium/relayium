import XCTest
@testable import RelayiumKit

final class StoredManifestTests: XCTestCase {
    func testEncryptManifestMatchesVector() throws {
        let v = try Vectors.load("store-wire-vectors")
        let files = v.manifestFiles()   // helper below reads manifest.json.files
        let ct = try encryptManifest(key: v.hex("keyHex"), StoredManifest(files: files))
        XCTAssertEqual(ct, v.hex("manifest.ctHex"))
    }
    func testDecryptSanitizesNames() throws {
        let v = try Vectors.load("store-wire-vectors")
        let m = try decryptManifest(key: v.hex("keyHex"), v.hex("manifest.ctHex"))
        XCTAssertEqual(m.files.map(\.name), v.strArray("manifest.sanitizedNames"))
        XCTAssertEqual(m.files.map(\.size), v.manifestFiles().map(\.size))
    }
    func testManifestPlaintextExactBytes() throws {
        let v = try Vectors.load("store-wire-vectors")
        let files = v.manifestFiles()
        let expected = "{\"files\":[{\"name\":\"hello.txt\",\"size\":11},{\"name\":\"a\u{202E}b.txt\",\"size\":3}]}"
        let bytes = try manifestJSON(StoredManifest(files: files))
        XCTAssertEqual(bytes, Array(expected.utf8))
    }
    func testManifestEscapesQuotesAndBackslashes() throws {
        let bytes = try manifestJSON(StoredManifest(files: [ManifestFile(name: "a\"b\\c", size: 0)]))
        let expected = "{\"files\":[{\"name\":\"a\\\"b\\\\c\",\"size\":0}]}"
        XCTAssertEqual(bytes, Array(expected.utf8))
    }
    /// Folder hierarchy rides inside `name`, and a forward slash must NOT be
    /// escaped — Go's `encoding/json` does not escape it and neither does JS's
    /// `JSON.stringify`, so a nested manifest serialises identically in all
    /// three. The identical literal is asserted in
    /// `server/internal/cloud/transfer_folder_interop_test.go`'s
    /// `TestNestedManifestJSONBytes`; if either side drifts, both tests fail.
    func testNestedManifestJSONMatchesTheGoAndWebBytes() throws {
        let bytes = try manifestJSON(StoredManifest(files: [
            ManifestFile(name: "trip/day1/a.txt", size: 3),
            ManifestFile(name: "loose.txt", size: 0),
        ]))
        let expected = #"{"files":[{"name":"trip/day1/a.txt","size":3},{"name":"loose.txt","size":0}]}"#
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), expected)
    }

    /// A nested manifest survives the real encrypt/decrypt round trip, and its
    /// slashes come back intact — the display sanitizer must not treat them as
    /// characters to strip.
    func testNestedManifestRoundTripsThroughEncryption() throws {
        let key = [UInt8](repeating: 7, count: 32)
        let m = StoredManifest(files: [ManifestFile(name: "trip/day1/a.txt", size: 3)])
        let back = try decryptManifest(key: key, try encryptManifest(key: key, m))
        XCTAssertEqual(back.files.map(\.name), ["trip/day1/a.txt"])
    }

    func testDecryptManifestThrowsOnTamper() throws {
        let v = try Vectors.load("store-wire-vectors")
        var ct = v.hex("manifest.ctHex")
        ct[ct.count - 1] ^= 0x01              // flip a tag byte
        XCTAssertThrowsError(try decryptManifest(key: v.hex("keyHex"), ct))
    }

    func testManifestValidationRejectsRemoteCrashInputs() throws {
        XCTAssertThrowsError(try validateManifestFiles([]))
        XCTAssertThrowsError(try validateManifestFiles([ManifestFile(name: "a", size: -1)]))
        XCTAssertThrowsError(try validateManifestFiles([
            ManifestFile(name: "a", size: MANIFEST_MAX_SAFE_INTEGER),
            ManifestFile(name: "b", size: 1),
        ]))
        XCTAssertEqual(try validateManifestFiles([ManifestFile(name: "a", size: 2)]), 2)
    }
}
