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
/// no spaces, fixed key order files/name/size, no slash escaping. Verified against
/// the golden manifest ciphertext — if the bytes differ, encryption won't match.
///
/// This is a hand-written serializer, NOT `JSONEncoder`. `JSONEncoder` on Darwin
/// routes keyed-container output through `JSONSerialization`, whose key order is
/// NOT stable/insertion-ordered (it's effectively hash-ordered) — so encoding the
/// same `StoredManifest` twice in the same process can (and does) produce
/// `{"size":..,"name":..}` on one call and `{"name":..,"size":..}` on another.
/// That non-determinism breaks interop with the web/CLI golden manifest
/// ciphertext, so we build the JSON string manually instead.
func manifestJSON(_ m: StoredManifest) throws -> [UInt8] {
    var out = "{\"files\":["
    for (i, f) in m.files.enumerated() {
        if i > 0 { out += "," }
        out += "{\"name\":\""
        out += escapeJSONString(f.name)
        out += "\",\"size\":"
        out += String(f.size)
        out += "}"
    }
    out += "]}"
    return Array(out.utf8)
}

/// Escapes a string exactly like JavaScript's `JSON.stringify` does: escapes `"`,
/// `\`, the named control-character shorthands (`\b \t \n \f \r`), and all other
/// C0 control scalars as `\u00XX` (lowercase hex). Every other Unicode scalar —
/// including DEL (U+007F), C1 controls (U+0080–U+009F), bidi overrides like
/// U+202E, and all non-ASCII text — is emitted raw as UTF-8. `/` is never escaped.
private func escapeJSONString(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"":
            out.append("\\"); out.append("\"")
        case "\\":
            out.append("\\"); out.append("\\")
        case "\u{08}":
            out.append("\\"); out.append("b")
        case "\u{09}":
            out.append("\\"); out.append("t")
        case "\u{0A}":
            out.append("\\"); out.append("n")
        case "\u{0C}":
            out.append("\\"); out.append("f")
        case "\u{0D}":
            out.append("\\"); out.append("r")
        default:
            if scalar.value < 0x20 {
                let hex = String(scalar.value, radix: 16)
                out.append("\\"); out.append("u")
                for _ in 0..<(4 - hex.count) { out.append("0") }
                out.append(contentsOf: hex.unicodeScalars)
            } else {
                out.append(scalar)
            }
        }
    }
    return String(out)
}

public func encryptManifest(key: [UInt8], _ m: StoredManifest) throws -> [UInt8] {
    do { try validateManifestFiles(m.files) }
    catch { throw StoredWireError.invalidManifest }
    return seal(key: key, seq: 0, plaintext: try manifestJSON(m))
}

/// Decrypt and validate, keeping every name EXACTLY as the sender wrote it.
///
/// `decryptManifest` below strips control and bidi characters for display, which
/// is right for a name a person is about to read and wrong for a name that is
/// about to become a filesystem instruction: stripping turns `"a\u{0}b"` into a
/// name this device would then happily create, when the honest answer is to
/// REFUSE the manifest. A receiver that plans destinations therefore takes the
/// raw names and applies its own refusal rules to them.
public func decryptManifestRaw(key: [UInt8], _ ct: [UInt8]) throws -> StoredManifest {
    guard let pt = open(key: key, seq: 0, ciphertext: ct) else {
        throw StoredWireError.truncatedStream   // auth failure / corrupt manifest
    }
    let m = try JSONDecoder().decode(StoredManifest.self, from: Data(pt))
    do { try validateManifestFiles(m.files) }
    catch { throw StoredWireError.invalidManifest }
    return m
}

public func decryptManifest(key: [UInt8], _ ct: [UInt8]) throws -> StoredManifest {
    StoredManifest(files: sanitizeNames(try decryptManifestRaw(key: key, ct).files))
}
