import Foundation
import XCTest

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
