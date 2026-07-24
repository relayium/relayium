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
}
