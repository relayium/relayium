import Foundation
import RelayiumKit

/// The one place an attacker-controlled manifest path becomes a real path on
/// this Mac.
///
/// Both transports arrive here: the realtime manifest carries `FileMeta.path`
/// (the web's convention, `web/src/lib/drag.ts`), the stored manifest carries
/// hierarchy inside `ManifestFile.name` (the Go CLI's convention,
/// `internal/cloud/transfer.go` `walkUploadPaths`). Rather than teach the writer
/// two shapes, both are reduced to the same list of segments here — the same
/// move the web makes with `safeSegments(path || name)` in `filesink.ts`.
///
/// The policy is REFUSAL, not repair. The Go receive path already refuses
/// (`safeJoin` returns an error for anything that escapes), and a repaired path
/// delivers a file under a name the user never saw on the confirmation card.
/// Nothing that legitimately produces these manifests can emit a traversal
/// segment: the web derives paths from `entry.fullPath`, the CLI from
/// `filepath.Rel`, and this app from `expandSelection` — none can contain `..`.

public enum ManifestPathError: Error, Equatable {
    /// Absolute, traversing, empty, or otherwise not a relative path.
    case unsafePath(String)
    /// Two entries resolve to the same destination, case- and
    /// Unicode-normalization-insensitively.
    case duplicatePath(String)
    /// One entry is a file where another entry needs a directory.
    case pathCollision(String)
}

/// Reduce a manifest path to safe path segments, or refuse.
///
/// Refuses: absolute paths (`/etc/passwd`), any `..` or `.` segment, empty
/// segments (`a//b`, a trailing `/`), and a path that has no segments at all.
///
/// Does NOT treat `\` as a separator. On Darwin it is an ordinary filename
/// character, and a POSIX file genuinely named `a\b.txt` must not be silently
/// split into a directory. Because it is not a separator here, it also cannot
/// traverse: `..\..\x` is one perfectly inert filename. (The web's ZIP sink does
/// fold `\` into `/`; that divergence can only ever affect a file whose real
/// name contains a backslash, and it is a display difference, not an escape.)
///
/// Control and bidi characters are stripped per segment, on the same rule the
/// confirmation card uses — a name that reads one way in the UI and another on
/// disk is the whole point of a bidi override.
public func safePathSegments(_ path: String) throws -> [String] {
    guard !path.hasPrefix("/") else { throw ManifestPathError.unsafePath(path) }
    let raw = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !raw.isEmpty else { throw ManifestPathError.unsafePath(path) }
    var out: [String] = []
    for segment in raw {
        guard !segment.isEmpty, segment != ".", segment != ".." else {
            throw ManifestPathError.unsafePath(path)
        }
        let clean = safeDisplayName(segment)
        // A segment made ENTIRELY of stripped characters would collapse to
        // nothing — or, worse, a stripped ".\u{202E}." could land back on a dot
        // segment. Re-check after cleaning rather than before.
        guard !clean.isEmpty, clean != ".", clean != ".." else {
            throw ManifestPathError.unsafePath(path)
        }
        out.append(clean)
    }
    return out
}

/// One incoming entry, resolved to the segments it will be written under.
struct ResolvedEntry {
    let segments: [String]
    let size: Int
    var directorySegments: ArraySlice<String> { segments.dropLast() }
}

/// Resolve every entry and refuse the whole batch if any pair cannot coexist.
///
/// All-or-nothing on purpose, and before the first byte: discovering a collision
/// halfway through means earlier files are already on disk under names the user
/// was shown, and the transfer is neither complete nor cleanly absent.
///
/// The collisions this rejects:
/// * the same destination twice, compared after Unicode canonical composition
///   and case-folding, because HFS+/APFS default volumes are case-insensitive
///   and `A.txt` and `a.txt` are one file there;
/// * a file whose path is also a directory prefix of another file (`a` and
///   `a/b`), which no ordering can satisfy.
func resolveEntries(_ files: [WritableFile]) throws -> [ResolvedEntry] {
    var resolved: [ResolvedEntry] = []
    var fileKeys = Set<String>()
    var directoryKeys = Set<String>()

    func key(_ segments: ArraySlice<String>) -> String {
        segments.map { $0.precomposedStringWithCanonicalMapping.lowercased() }.joined(separator: "/")
    }

    for file in files {
        // `path` when the sender gave one (realtime), otherwise the name, which
        // is where the stored manifest keeps its hierarchy. Same rule as the
        // web's `safeSegments(path || name)`.
        let segments = try safePathSegments(file.path ?? file.name)
        let entry = ResolvedEntry(segments: segments, size: file.size)
        let leafKey = key(segments[...])
        guard fileKeys.insert(leafKey).inserted else {
            throw ManifestPathError.duplicatePath(segments.joined(separator: "/"))
        }
        if directoryKeys.contains(leafKey) {
            throw ManifestPathError.pathCollision(segments.joined(separator: "/"))
        }
        for depth in 1..<max(1, segments.count) {
            let dirKey = key(segments.prefix(depth))
            if fileKeys.contains(dirKey) {
                throw ManifestPathError.pathCollision(segments.joined(separator: "/"))
            }
            directoryKeys.insert(dirKey)
        }
        resolved.append(entry)
    }
    return resolved
}

/// Whether any entry describes a folder at all.
public func hasNestedPaths(_ files: [WritableFile]) -> Bool {
    files.contains { ($0.path ?? $0.name).contains("/") }
}

/// Lift a shared top-level folder out of the entries and into the destination
/// directory's own name.
///
/// Returns nil unless EVERY entry nests under one and the same root — a batch
/// with two roots, or with a loose file beside a folder, has no single name a
/// container could take, and keeps its full paths inside a `relayium-<id>` box
/// instead.
///
/// The lift is what stops the received tree from gaining a level: a container
/// named `photos` holding entries still called `photos/a.jpg` would land at
/// `photos/photos/a.jpg`. It also answers the one-file-folder case with no
/// special case at all — a batch of exactly `photos/a.jpg` has the root
/// `photos`, so the folder survives even though it holds a single file.
///
/// The remainder is written into `path` for both transports, because the writer
/// resolves `path ?? name`; the stored manifest's `name` (which is where its own
/// hierarchy lives) is left untouched so nothing else that reads it changes
/// meaning.
public func stripCommonRoot(_ files: [WritableFile]) -> (root: String, files: [WritableFile])? {
    guard let first = files.first,
          let firstSegments = try? safePathSegments(first.path ?? first.name),
          firstSegments.count > 1 else { return nil }
    let root = firstSegments[0]
    var out: [WritableFile] = []
    for file in files {
        guard let segments = try? safePathSegments(file.path ?? file.name),
              segments.count > 1, segments[0] == root else { return nil }
        out.append(WritableFile(name: file.name, size: file.size,
                                path: segments.dropFirst().joined(separator: "/")))
    }
    return (root, out)
}
