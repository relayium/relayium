import Foundation

public struct ManifestFile: Codable, Equatable {
    public var name: String
    public var size: Int
    public init(name: String, size: Int) { self.name = name; self.size = size }
}

public struct StoredManifest: Codable, Equatable {
    public var files: [ManifestFile]
    public init(files: [ManifestFile]) { self.files = files }
}

/// Compact JSON matching JS `JSON.stringify({files:[{name,size},…]})` byte-for-byte:
/// no spaces, key order files/name/size, no slash escaping. Verified against the
/// golden manifest ciphertext — if the bytes differ, encryption won't match.
private func manifestJSON(_ m: StoredManifest) throws -> [UInt8] {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]   // NOT .sortedKeys — see note
    // Codable emits keys in declaration order (name, then size), matching JS
    // insertion order. Top-level has only `files`. No spaces by default.
    return [UInt8](try enc.encode(m))
}

public func encryptManifest(key: [UInt8], _ m: StoredManifest) throws -> [UInt8] {
    seal(key: key, seq: 0, plaintext: try manifestJSON(m))
}

public func decryptManifest(key: [UInt8], _ ct: [UInt8]) throws -> StoredManifest {
    guard let pt = open(key: key, seq: 0, ciphertext: ct) else {
        throw StoredWireError.truncatedStream   // auth failure / corrupt manifest
    }
    let m = try JSONDecoder().decode(StoredManifest.self, from: Data(pt))
    return StoredManifest(files: sanitizeNames(m.files))
}
