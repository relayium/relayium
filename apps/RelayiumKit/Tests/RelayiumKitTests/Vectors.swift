import Foundation
import XCTest
@testable import RelayiumKit

struct Vectors {
    let json: [String: Any]
    static func load(_ name: String = "crypto-vectors") throws -> Vectors {
        let url = Bundle.module.url(forResource: name, withExtension: "json")!
        let data = try Data(contentsOf: url)
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return Vectors(json: obj)
    }
    /// Dot-path lookup returning decoded hex bytes.
    func hex(_ path: String) -> [UInt8] { hexString(path).hexBytes }
    func str(_ path: String) -> String {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return node as! String
    }
    func int(_ path: String) -> Int {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return node as! Int
    }
    /// Dot-path lookup returning a JSON array of strings.
    func strArray(_ path: String) -> [String] {
        var node: Any = json
        for k in path.split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        return (node as! [Any]).map { $0 as! String }
    }
    /// Reads `manifest.json.files` into `[ManifestFile]`.
    func manifestFiles() -> [ManifestFile] {
        var node: Any = json
        for k in "manifest.json.files".split(separator: ".") { node = (node as! [String: Any])[String(k)]! }
        let arr = node as! [[String: Any]]
        return arr.map { ManifestFile(name: $0["name"] as! String, size: $0["size"] as! Int) }
    }
    /// Reads `files[].dataHex` into `[[UInt8]]`.
    func fileDatas() -> [[UInt8]] {
        let arr = json["files"] as! [[String: Any]]
        return arr.map { ($0["dataHex"] as! String).hexBytes }
    }
    private func hexString(_ path: String) -> String { str(path) }
}

extension String {
    var hexBytes: [UInt8] {
        var out = [UInt8](); var i = startIndex
        while i < endIndex {
            let j = index(i, offsetBy: 2)
            out.append(UInt8(self[i..<j], radix: 16)!); i = j
        }
        return out
    }
}
