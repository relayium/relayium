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
}
