import XCTest
@testable import RelayiumKit

final class UploadBodyTests: XCTestCase {
    func testUploadBodyMatchesStoredWireVectors() throws {
        let v = try Vectors.load("store-wire-vectors")
        let manifest = StoredManifest(files: v.manifestFiles())    // helper from R1-B (name,size)
        let files = v.fileDatas()                                  // [[UInt8]] from files[].dataHex
        let body = try encodeUploadBody(key: v.hex("keyHex"), manifest: manifest, files: files)

        let encManifest = v.hex("manifest.ctHex")
        let stream = v.hex("streamHex")
        var expected = [UInt8]()
        let n = UInt32(encManifest.count)
        expected += [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]
        expected += encManifest
        expected += stream
        XCTAssertEqual(body, expected)
    }
}
