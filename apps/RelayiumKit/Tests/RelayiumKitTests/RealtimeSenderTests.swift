import XCTest
@testable import RelayiumKit

final class RealtimeSenderTests: XCTestCase {
    func testBatchFrameMatchesVector() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let files = v.realtimeManifestFiles()   // [FileMeta] from manifest.files
        let s = RealtimeSender(sessionKey: v.hex("sessionKeyHex"))
        XCTAssertEqual(try s.batchFrame(files), v.hex("batchFrameHex"))
    }
    func testFullFrameStreamMatchesVector() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let files = v.realtimeManifestFiles()
        let datas = v.realtimeFileDatas()        // [[UInt8]]
        let s = RealtimeSender(sessionKey: v.hex("sessionKeyHex"))
        var out = try s.batchFrame(files)
        for f in try s.dataFrames(zip(files, datas).map { ($0, $1) }) { out += f }
        XCTAssertEqual(out, v.hex("frameStreamHex"))
    }
    func testChainHashMatchesVector() throws {
        let v = try Vectors.load("realtime-wire-vectors")
        let datas = v.realtimeFileDatas()
        for (i, d) in datas.enumerated() {
            XCTAssertEqual(chainHash([UInt8](repeating: 0, count: 32), d).hexString, v.strArray("doneHashes")[i])
        }
    }
}
