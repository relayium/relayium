import Foundation

// Unicode Bidi_Control code points (from filename.ts): U+061C, U+200E, U+200F,
// U+202A–U+202E, U+2066–U+2069.
private let bidiControl: Set<Unicode.Scalar> = {
    var s = Set<Unicode.Scalar>([0x061C, 0x200E, 0x200F].compactMap(Unicode.Scalar.init))
    for cp in (0x202A...0x202E) { if let u = Unicode.Scalar(cp) { s.insert(u) } }
    for cp in (0x2066...0x2069) { if let u = Unicode.Scalar(cp) { s.insert(u) } }
    return s
}()

/// Remove all Unicode Bidi_Control characters.
public func stripBidi(_ s: String) -> String {
    String(String.UnicodeScalarView(s.unicodeScalars.filter { !bidiControl.contains($0) }))
}

/// Sanitize a name before it enters the UI: strip bidi controls, then C0/C1
/// controls (U+0000–U+001F, U+007F–U+009F). Mirrors filename.ts safeDisplayName.
public func safeDisplayName(_ s: String) -> String {
    let stripped = stripBidi(s)
    return String(String.UnicodeScalarView(stripped.unicodeScalars.filter { u in
        let v = u.value
        return !(v <= 0x1F || (v >= 0x7F && v <= 0x9F))
    }))
}

/// Sanitize each file's display name. (No `path` field in StoredManifest today;
/// add per-segment path sanitize here if StoredManifest gains a path field.)
public func sanitizeNames(_ files: [ManifestFile]) -> [ManifestFile] {
    files.map { ManifestFile(name: safeDisplayName($0.name), size: $0.size) }
}
